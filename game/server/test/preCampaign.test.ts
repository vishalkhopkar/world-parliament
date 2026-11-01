// The pre-campaign (games with 3+ players). Between the lobby and the campaign parties field candidates: each seat costs
// costs.candidate, a withdrawal refunds it, fielding is public and live, and the majority follows the contested seats until the
// deadline fixes it. At the deadline a party with no candidates is eliminated but stays connected; with fewer than 2 parties left the
// game ends with no government. In the campaign a party can only campaign where it has a candidate, and a seat with no candidate is
// vacant. A 2-player game has no pre-campaign: every seat is fielded and charged automatically.
import { fullyFieldedBudget, majorityOf } from '@hp/shared';
import type { ClientMessage, GameSnapshot, ServerMessage } from '@hp/shared';
import { describe, expect, it, vi } from 'vitest';
import { Ctx, driveTo, lineMap, pollAll, setResults } from './helpers';

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
const CANDIDATES = Array.from({ length: 8 }, (_, s) => Array.from({ length: 10 }, (_v, col) => `C${s + 1}-${col}`));

const field = (seats: number[], clientRef?: string): ClientMessage => ({ action: 'field', seats, ...(clientRef ? { clientRef } : {}) });
const withdraw = (seats: number[], clientRef?: string): ClientMessage => ({ action: 'withdraw', seats, ...(clientRef ? { clientRef } : {}) });
const acks = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'fieldAck') as Of<'fieldAck'>[];
const updates = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'fieldingUpdate') as Of<'fieldingUpdate'>[];
const lastUpdate = (c: Ctx, i: number) => updates(c, i).at(-1) as Of<'fieldingUpdate'>;
const statuses = (c: Ctx, i: number) => (c.notifier.to(c.p[i].playerId, 'status') as Of<'status'>[]).map((m) => m.status);
const record = async (c: Ctx, i: number) => (await c.repo.getPlayer(c.gameId, c.p[i].playerId))!;
const helloOf = async (c: Ctx, i: number) => (await c.svc.hello(await record(c, i))) as Of<'hello'>;
const snapshotOf = async (c: Ctx, i: number): Promise<GameSnapshot> => (await helloOf(c, i)).snapshot;
const allSeats = (c: Ctx) => c.map.seats.map((s) => s.id);
/** The deadline passes and the campaign opens; clock at campaignStart. */
async function open(c: Ctx): Promise<void> {
  c.clock.set(c.timeline.preCampaignEnd as number);
  await c.svc.openCampaign(c.gameId);
  c.clock.set(c.timeline.campaignStart);
}

describe('starting a game', () => {
  it('with 3+ active players the game goes from the lobby to the pre-campaign on the full budget, and the campaign starts after preCampaignMs plus the lead-in', async () => {
    const c = new Ctx({ startDelayMs: 1000 });
    await c.lobby(3);
    const t0 = c.clock.now();
    const { timeline } = await c.svc.start(c.gameId, c.p[0].token);
    expect((await c.game()).status).toBe('preCampaign');
    expect(timeline.preCampaignEnd).toBe(t0 + c.cfg.durations.preCampaignMs);
    expect(timeline.campaignStart).toBe(t0 + c.cfg.durations.preCampaignMs + 1000);
    expect(c.scheduler.lifecycles[0].timeline).toEqual(timeline);
    for (const i of [0, 1, 2]) {
      expect(await c.budget(i)).toBe(c.cfg.budget);
      expect((await record(c, i)).fielded ?? []).toEqual([]);
      expect((await record(c, i)).candidateColumn).toBeTypeOf('number');
      expect(statuses(c, i)).toEqual(['preCampaign']);
    }
  });

  it('with 2 players there is no pre-campaign: the campaign starts at once, every seat is fielded and charged, and the budget is fullyFieldedBudget', async () => {
    const c = new Ctx({ startDelayMs: 1000, candidates: CANDIDATES });
    await c.lobby(2);
    const t0 = c.clock.now();
    const { timeline } = await c.svc.start(c.gameId, c.p[0].token);
    const g = await c.game();
    expect(g.status).toBe('campaign');
    expect(timeline.preCampaignEnd).toBeUndefined();
    expect(timeline.campaignStart).toBe(t0 + 1000);
    expect(g.contestedSeats).toBe(8);
    expect(g.majority).toBe(majorityOf(8));
    for (const i of [0, 1]) {
      expect(await c.budget(i)).toBe(fullyFieldedBudget(c.cfg));
      expect((await record(c, i)).fielded).toEqual(allSeats(c));
    }
    const snap = await snapshotOf(c, 1);
    expect(snap.contestedSeats).toBe(8);
    expect(snap.majority).toBe(5);
    expect(snap.fielding[1].map((x) => x.playerId).sort()).toEqual([c.p[0].playerId, c.p[1].playerId].sort());
    expect(snap.fielding[1][0].name).toMatch(/^C1-/);
  });

  it('in a 2-player game clients that said hello in the lobby learn the automatic fielding from one fieldingUpdate per party after the status', async () => {
    const c = new Ctx();
    await c.lobby(2);
    await c.svc.start(c.gameId, c.p[0].token);
    const kinds = c.notifier.to(c.p[1].playerId).map((m) => m.type).filter((t) => t === 'status' || t === 'fieldingUpdate');
    expect(kinds).toEqual(['status', 'fieldingUpdate', 'fieldingUpdate']);
    const u = updates(c, 1);
    expect(u.map((m) => m.playerId).sort()).toEqual([c.p[0].playerId, c.p[1].playerId].sort());
    expect(u[0].added.map((a) => a.seat)).toEqual(allSeats(c));
    expect(u[0].contestedSeats).toBe(8);
    expect(u[0].majority).toBe(5);
  });

  it('a failed lifecycle start puts a would-be pre-campaign game back in the lobby', async () => {
    const c = new Ctx();
    await c.lobby(3);
    vi.spyOn(c.scheduler, 'startLifecycle').mockRejectedValueOnce(new Error('sfn down'));
    await expect(c.svc.start(c.gameId, c.p[0].token)).rejects.toThrow('sfn down');
    const g = await c.game();
    expect(g.status).toBe('lobby');
    expect(g.timeline).toBeNull();
  });

  it('joining and lobby settings are closed during the pre-campaign', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await expect(c.svc.joinGame({ joinCode: c.joinCode, nickname: 'Late' })).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    await expect(c.svc.setSettings(c.gameId, c.p[0].token, { phases: 1 })).rejects.toMatchObject({ code: 'WRONG_PHASE' });
    await expect(c.svc.setParty(c.gameId, c.p[1].token, { party: { name: 'New name', colour: 'x', symbol: 'y' } })).rejects.toMatchObject({ code: 'WRONG_PHASE' });
  });
});

describe('fielding candidates', () => {
  it('field charges costs.candidate per seat, acks the sender with the seats and candidate names, and tells everybody with the live contested seats and majority', async () => {
    const c = await new Ctx({ candidates: CANDIDATES }).inPreCampaign(3);
    await c.send(0, field([1, 2, 3], 'r1'));
    expect(await c.budget(0)).toBe(c.cfg.budget - 3 * c.cfg.costs.candidate);
    const column = (await record(c, 0)).candidateColumn as number;
    const ack = acks(c, 0)[0];
    expect(ack).toMatchObject({ clientRef: 'r1', ok: true, budget: c.cfg.budget - 3 * c.cfg.costs.candidate, removed: [] });
    expect(ack.added).toEqual([1, 2, 3].map((s) => ({ seat: s, name: `C${s}-${column}` })));
    for (const i of [0, 1, 2]) {
      expect(updates(c, i)).toEqual([{ type: 'fieldingUpdate', playerId: c.p[0].playerId, added: ack.added, removed: [], contestedSeats: 3, majority: 2 }]);
    }
    expect(acks(c, 1)).toEqual([]);
  });

  it('contested seats count a seat once however many parties field it, and fall when its last candidate is withdrawn', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, field([1, 2]));
    await c.send(1, field([2, 3]));
    expect(lastUpdate(c, 2).contestedSeats).toBe(3);
    await c.send(1, withdraw([2]));
    expect(lastUpdate(c, 2).contestedSeats).toBe(3); // party 0 still contests seat 2
    await c.send(0, withdraw([2]));
    expect(lastUpdate(c, 2)).toMatchObject({ playerId: c.p[0].playerId, added: [], removed: [2], contestedSeats: 2, majority: 2 });
    expect((await snapshotOf(c, 2)).contestedSeats).toBe(2);
  });

  it('withdraw refunds costs.candidate per seat actually withdrawn; seats without a candidate are skipped', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, field([1, 2]));
    await c.send(0, withdraw([2, 3, 4]));
    expect(await c.budget(0)).toBe(c.cfg.budget - c.cfg.costs.candidate);
    expect((await record(c, 0)).fielded).toEqual([1]);
    expect(acks(c, 0)[1]).toMatchObject({ added: [], removed: [2], budget: c.cfg.budget - c.cfg.costs.candidate });
  });

  it('seats already fielded and repeated seats are skipped and not charged again', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, field([1, 2]));
    await c.send(0, field([2, 3, 3]));
    expect(await c.budget(0)).toBe(c.cfg.budget - 3 * c.cfg.costs.candidate);
    expect((await record(c, 0)).fielded).toEqual([1, 2, 3]);
    expect(acks(c, 0)[1].added.map((a) => a.seat)).toEqual([3]);
  });

  it('a batch that changes nothing is acked to the sender but not announced to anybody', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, field([1]));
    c.notifier.clear();
    await c.send(0, field([1]));
    await c.send(0, withdraw([2]));
    expect(acks(c, 0).length).toBe(2);
    expect(acks(c, 0)[0]).toMatchObject({ added: [], removed: [] });
    for (const i of [0, 1, 2]) expect(updates(c, i)).toEqual([]);
  });

  it('a batch the budget cannot pay for is refused whole with INSUFFICIENT_FUNDS, and only new seats have to be paid for', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.repo.updatePlayer(c.gameId, c.p[0].playerId, { budget: 2 * c.cfg.costs.candidate });
    await c.send(0, field([1, 2, 3], 'big'));
    expect(c.lastError(0)).toMatchObject({ error: 'INSUFFICIENT_FUNDS', clientRef: 'big' });
    expect(await c.budget(0)).toBe(2 * c.cfg.costs.candidate);
    expect((await record(c, 0)).fielded ?? []).toEqual([]);
    expect(updates(c, 1)).toEqual([]);
    await c.send(0, field([1, 2]));
    await c.send(0, field([1, 2], 'again'));
    expect(c.notifier.to(c.p[0].playerId, 'error').length).toBe(1);
    expect(await c.budget(0)).toBe(0);
  });

  it('a resent clientRef answers fieldAck with duplicate:true, the current budget and nothing changed, even after the deadline', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, field([1, 2], 'x-1'));
    await c.send(0, withdraw([1]));
    const before = await c.budget(0);
    c.notifier.clear();
    await c.send(0, field([1, 2], 'x-1'));
    expect(acks(c, 0)).toEqual([{ type: 'fieldAck', clientRef: 'x-1', duplicate: true, ok: true, budget: before, added: [], removed: [] }]);
    expect((await record(c, 0)).fielded).toEqual([2]);
    expect(updates(c, 1)).toEqual([]);
    await c.send(1, field([3]));
    await c.send(2, field([3]));
    await open(c);
    await c.send(0, field([1, 2], 'x-1'));
    expect(c.lastError(0)).toBeUndefined();
    expect(acks(c, 0).length).toBe(2);
  });

  it('concurrent copies of one clientRef charge once, and concurrent batches of one player all count', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await Promise.all([1, 2, 3].map(() => c.send(0, field([1, 2], 'same'))));
    expect(await c.budget(0)).toBe(c.cfg.budget - 2 * c.cfg.costs.candidate);
    await Promise.all([[3], [4], [5]].map((s) => c.send(0, field(s))));
    expect((await record(c, 0)).fielded?.slice().sort()).toEqual([1, 2, 3, 4, 5]);
    expect(await c.budget(0)).toBe(c.cfg.budget - 5 * c.cfg.costs.candidate);
  });

  it.each([
    ['not a list', 7], ['empty', []], ['a fraction', [1.5]], ['text', ['1']],
  ])('seats that are %s answer BAD_REQUEST', async (_label, seats) => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, { action: 'field', seats } as unknown as ClientMessage);
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
    await c.send(0, { action: 'withdraw', seats } as unknown as ClientMessage);
    expect(c.notifier.to(c.p[0].playerId, 'error').length).toBe(2);
    expect(await c.budget(0)).toBe(c.cfg.budget);
  });

  it('a batch naming an unknown seat is refused whole with BAD_REQUEST', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, field([1, 999]));
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
    expect(await c.budget(0)).toBe(c.cfg.budget);
  });

  it.each(['lobby', 'campaign', 'counting', 'finished'] as const)('field and withdraw answer WRONG_PHASE in the %s', async (status) => {
    const c = new Ctx();
    if (status === 'lobby') {
      await c.lobby(3);
      for (const p of c.p) await c.svc.connect(c.gameId, p.token, p.conn);
    } else {
      await c.started(3);
      await driveTo(c, status);
    }
    const before = await c.budget(0);
    await c.send(0, field([1]));
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
    await c.send(0, withdraw([1]));
    expect(c.notifier.to(c.p[0].playerId, 'error').length).toBe(2);
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
    expect(await c.budget(0)).toBe(before);
  });

  it('server time decides: from the deadline on fielding is refused even before the campaign has been opened', async () => {
    const c = await new Ctx().inPreCampaign(3);
    c.clock.set(c.timeline.preCampaignEnd as number);
    await c.send(0, field([1]));
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
  });

  it('a repo that stays too busy answers RATE_LIMITED with a time to retry, and changes nothing', async () => {
    const c = await new Ctx().inPreCampaign(3);
    vi.spyOn(c.repo, 'updateFielding').mockResolvedValueOnce({ result: 'conflict' });
    await c.send(0, field([1]));
    expect(c.lastError(0)?.error).toBe('RATE_LIMITED');
    expect(c.lastError(0)?.retryAt).toBeGreaterThan(c.clock.now());
    expect(await c.budget(0)).toBe(c.cfg.budget);
  });

  it('the status moving on between the check and the write answers WRONG_PHASE', async () => {
    const c = await new Ctx().inPreCampaign(3);
    vi.spyOn(c.repo, 'updateFielding').mockResolvedValueOnce({ result: 'wrong_phase' });
    await c.send(0, field([1]));
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
  });

  it('a disconnected or eliminated player cannot field', async () => {
    const c = await new Ctx().inPreCampaign(4);
    await c.repo.updatePlayer(c.gameId, c.p[0].playerId, { status: 'disconnected' });
    await expect(c.svc.withdraw(await record(c, 0), [1])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await c.svc.eliminate(c.gameId, c.p[2].playerId);
    await expect(c.svc.field(await record(c, 2), [1])).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('what else the pre-campaign allows', () => {
  it('campaign actions and reports answer WRONG_PHASE, and the news agencies refuse too', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, field([1]));
    for (const m of [
      { action: 'campaign', type: 'rally', seat: 1 },
      { action: 'campaign', type: 'minorRally', seat: 1 },
      { action: 'campaign', type: 'roadshow', seat: 1 },
      { action: 'buyReport', scope: 'seat', seat: 1 },
      { action: 'globalReports' },
    ] as ClientMessage[]) {
      c.notifier.clear();
      await c.send(0, m);
      expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
    }
    expect(await c.budget(0)).toBe(c.cfg.budget - c.cfg.costs.candidate);
  });

  it('the chat is one-to-one, also when the campaign chat is GROUP, and it is in the history of a reconnecting player', async () => {
    const c = new Ctx();
    c.cfg = { ...c.cfg, chat: { campaigning: 'GROUP' } };
    await c.inPreCampaign(3);
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'alliance?' });
    const m = (c.notifier.to(c.p[1].playerId, 'chat')[0] as Of<'chat'>).message;
    expect(m).toMatchObject({ channel: 'direct', to: [c.p[1].playerId], text: 'alliance?' });
    expect(c.notifier.to(c.p[2].playerId, 'chat')).toEqual([]);
    expect((await helloOf(c, 1)).chat?.map((x) => x.text)).toEqual(['alliance?']);
    expect((await helloOf(c, 2)).chat).toEqual([]);
    await c.send(0, { action: 'chat', to: [], text: 'to nobody' });
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
  });

  it('the chat stays one-to-one in the pre-campaign when the campaign chat is switched off', async () => {
    const c = new Ctx();
    c.cfg = { ...c.cfg, chat: { campaigning: 'OFF' } };
    await c.inPreCampaign(3);
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'hi' });
    expect(c.lastError(0)).toBeUndefined();
    expect(c.notifier.to(c.p[1].playerId, 'chat').length).toBe(1);
  });

  it('a player losing the connection gets the grace period; running out of it eliminates them and removes their candidates, moving the live majority', async () => {
    const c = await new Ctx().inPreCampaign(4);
    await c.send(0, field([1]));
    await c.send(1, field([1, 2]));
    await c.svc.disconnect(c.p[1].conn);
    expect((await record(c, 1)).status).toBe('disconnected');
    expect(c.scheduler.graces.size).toBe(1);
    c.clock.advance(c.cfg.durations.graceMs);
    await c.svc.graceCheck(c.gameId, c.p[1].playerId);
    expect((await record(c, 1)).status).toBe('eliminated');
    expect((await record(c, 1)).fielded).toBeUndefined();
    expect(lastUpdate(c, 0)).toMatchObject({ playerId: c.p[1].playerId, added: [], removed: [1, 2], contestedSeats: 1, majority: 1 });
    expect((await c.game()).status).toBe('preCampaign');
  });

  it('if eliminations in the pre-campaign leave fewer than 2 parties the game ends with no government, and the deadline then does nothing', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, field([1]));
    await c.svc.eliminate(c.gameId, c.p[1].playerId);
    await c.svc.eliminate(c.gameId, c.p[2].playerId);
    const g = await c.game();
    expect(g.status).toBe('finished');
    expect(g.contestedSeats).toBe(1);
    expect(await c.repo.getGovernment(c.gameId)).toBeNull();
    c.notifier.clear();
    await open(c);
    expect(c.notifier.log).toEqual([]);
    expect((await c.game()).status).toBe('finished');
  });

  it('polling does not run in the pre-campaign', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.svc.phaseClose(c.gameId, 0);
    expect(await c.repo.listSeatResults(c.gameId)).toEqual([]);
    expect((await c.game()).closedPhases).toBe(0);
    expect((await c.svc.countReveal(c.gameId)).done).toBe(true);
    expect((await c.game()).status).toBe('preCampaign');
  });

  it('a lifecycle failure in the pre-campaign finishes the game instead of leaving it stuck', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.svc.finalise(c.gameId, { error: true });
    expect((await c.game()).status).toBe('finished');
    expect(await c.repo.getResult(c.gameId)).not.toBeNull();
  });
});

describe('opening the campaign at the deadline', () => {
  it('fixes contestedSeats and majority on the game record and flips the status, telling clients with status, a closing fieldingUpdate and a private state', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, field([1, 2, 3]));
    await c.send(1, field([3, 4, 5]));
    await c.send(2, field([5]));
    c.notifier.clear();
    c.clock.set(c.timeline.preCampaignEnd as number);
    await c.svc.openCampaign(c.gameId);
    const g = await c.game();
    expect(g.status).toBe('campaign');
    expect(g.contestedSeats).toBe(5);
    expect(g.majority).toBe(3);
    for (const i of [0, 1, 2]) {
      expect(c.notifier.to(c.p[i].playerId).map((m) => m.type)).toEqual(['status', 'fieldingUpdate', 'private']);
      expect(statuses(c, i)).toEqual(['campaign']);
      expect(updates(c, i)[0]).toMatchObject({ added: [], removed: [], contestedSeats: 5, majority: 3 });
    }
    expect(await snapshotOf(c, 0)).toMatchObject({ status: 'campaign', contestedSeats: 5, majority: 3 });
  });

  it('is idempotent: a second call changes nothing and tells nobody anything', async () => {
    const c = await new Ctx().inPreCampaign(3);
    for (const i of [0, 1, 2]) await c.send(i, field([1]));
    await open(c);
    c.notifier.clear();
    await c.svc.openCampaign(c.gameId);
    expect(c.notifier.log).toEqual([]);
    await expect(c.svc.openCampaign('no-such-game')).resolves.toBeUndefined();
  });

  it('a retry after a crash half way (status flipped, players not yet told) finishes the job', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, field([1, 2]));
    await c.send(1, field([2]));
    await c.repo.updateGame(c.gameId, { status: 'campaign' });
    await c.svc.openCampaign(c.gameId);
    expect((await c.game()).contestedSeats).toBe(2);
    expect((await record(c, 2)).status).toBe('eliminated');
    expect(statuses(c, 0).at(-1)).toBe('campaign');
  });

  it('does nothing for a 2-player game, which never had a pre-campaign', async () => {
    const c = await new Ctx().inPreCampaign(2);
    c.notifier.clear();
    await c.svc.openCampaign(c.gameId);
    expect(c.notifier.log).toEqual([]);
  });

  it('a party with no candidates is eliminated but stays connected: it sees itself eliminated and can no longer act', async () => {
    const c = await new Ctx().inPreCampaign(4);
    for (const i of [0, 1, 2]) await c.send(i, field([1, 2]));
    await open(c);
    const out = await record(c, 3);
    expect(out.status).toBe('eliminated');
    expect(out.connectionId).toBe(c.p[3].conn);
    const shown = (c.notifier.to(c.p[3].playerId, 'players').at(-1) as Of<'players'>).players.find((p) => p.playerId === out.playerId);
    expect(shown?.status).toBe('eliminated');
    expect(statuses(c, 3).at(-1)).toBe('campaign');
    await c.send(3, { action: 'campaign', type: 'roadshow', seat: 1 });
    expect(c.lastError(3)?.error).toBe('FORBIDDEN');
    expect((await helloOf(c, 3)).snapshot.status).toBe('campaign');
  });

  it('with the campaign chat on, a party eliminated at the deadline keeps writing and reading chat', async () => {
    const c = new Ctx();
    c.cfg = { ...c.cfg, chat: { campaigning: 'GROUP' } };
    await c.inPreCampaign(4);
    for (const i of [0, 1, 2]) await c.send(i, field([1]));
    await open(c);
    await c.send(3, { action: 'chat', text: 'I am out but listening' } as ClientMessage);
    expect(c.lastError(3)).toBeUndefined();
    expect((c.notifier.to(c.p[0].playerId, 'chat')[0] as Of<'chat'>).message.text).toBe('I am out but listening');
    await c.send(0, { action: 'chat', text: 'noted' } as ClientMessage);
    expect((c.notifier.to(c.p[3].playerId, 'chat').at(-1) as Of<'chat'>).message.text).toBe('noted');
  });

  it('a disconnected player with candidates stays in until the grace period runs out; one without candidates is eliminated at the deadline', async () => {
    const c = await new Ctx().inPreCampaign(4);
    await c.send(0, field([1]));
    await c.send(1, field([2]));
    await c.send(2, field([3]));
    await c.svc.disconnect(c.p[2].conn);
    await c.svc.disconnect(c.p[3].conn);
    await open(c);
    expect((await record(c, 2)).status).toBe('disconnected');
    expect((await record(c, 3)).status).toBe('eliminated');
    expect((await c.game()).contestedSeats).toBe(3);
  });

  it('with one party left the game ends with no government: a lone remaining party does not win automatically', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, field(allSeats(c)));
    await open(c);
    expect((await c.game()).status).toBe('finished');
    expect(await c.repo.getGovernment(c.gameId)).toBeNull();
    expect((await c.repo.getResult(c.gameId))?.government ?? null).toBeNull();
    expect(statuses(c, 0)).toEqual(['preCampaign', 'finished']); // never told 'campaign'
    expect(c.notifier.to(c.p[1].playerId, 'result').length).toBe(1);
    expect((await record(c, 1)).connectionId).toBe(c.p[1].conn);
  });

  it('with everyone eliminated (nobody fielded) the game ends with no government over 0 contested seats', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await open(c);
    const g = await c.game();
    expect(g.status).toBe('finished');
    expect(g.contestedSeats).toBe(0);
    for (const i of [0, 1, 2]) expect((await record(c, i)).status).toBe('eliminated');
    expect((await c.repo.getResult(c.gameId))?.government ?? null).toBeNull();
    expect((await snapshotOf(c, 0)).contestedSeats).toBe(0);
  });
});

describe('the campaign after a pre-campaign', () => {
  /** Party 0 on seats 1-5, party 1 on 3-5, party 2 on 5-6; seats 7 and 8 are vacant: 6 contested, majority 4. */
  async function fielded(): Promise<Ctx> {
    const c = await new Ctx({ candidates: CANDIDATES }).inPreCampaign(3);
    await c.send(0, field([1, 2, 3, 4, 5]));
    await c.send(1, field([3, 4, 5]));
    await c.send(2, field([5, 6]));
    await open(c);
    c.notifier.clear();
    return c;
  }

  it.each(['rally', 'minorRally', 'roadshow'] as const)('a %s in a seat where the party has no candidate is refused with NOT_FIELDED and costs nothing', async (type) => {
    const c = await fielded();
    const before = await c.budget(1);
    await c.send(1, { action: 'campaign', type, seat: 1, clientRef: 'nf' });
    expect(c.lastError(1)).toMatchObject({ error: 'NOT_FIELDED', clientRef: 'nf' });
    expect(await c.budget(1)).toBe(before);
    expect(await c.repo.listActions(c.gameId)).toEqual([]);
  });

  it('a minor rally costs costs.minorRally, has no cooldown, and only its owner hears of it: no news, live or in the snapshot', async () => {
    const c = await fielded();
    const before = await c.budget(0);
    await c.send(0, { action: 'campaign', type: 'minorRally', seat: 1 });
    await c.send(0, { action: 'campaign', type: 'minorRally', seat: 2 });
    expect(c.lastError(0)).toBeUndefined();
    expect(await c.budget(0)).toBe(before - 2 * c.cfg.costs.minorRally);
    expect((await record(c, 0)).lastRallyAt).toBeUndefined();
    expect(c.notifier.to(c.p[0].playerId, 'actionAck').length).toBe(2);
    expect(c.notifier.to(c.p[0].playerId, 'news')).toEqual([]);
    expect(c.notifier.to(c.p[1].playerId, 'news')).toEqual([]);
    expect(c.notifier.to(c.p[1].playerId, 'actionAck')).toEqual([]);
    expect((await snapshotOf(c, 1)).news).toEqual([]);
    expect((await helloOf(c, 0)).private.myActions.map((a) => a.type)).toEqual(['minorRally', 'minorRally']);
    expect((await helloOf(c, 1)).private.myActions).toEqual([]);
  });

  it('the cooldown is about major rallies only: minor rallies pass on either side of a major rally, a second major rally does not', async () => {
    const c = await fielded();
    await c.send(0, { action: 'campaign', type: 'minorRally', seat: 1 });
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    await c.send(0, { action: 'campaign', type: 'minorRally', seat: 2 });
    expect(c.lastError(0)).toBeUndefined();
    await c.send(0, { action: 'campaign', type: 'rally', seat: 2 });
    expect(c.lastError(0)?.error).toBe('RATE_LIMITED');
    expect(c.notifier.to(c.p[1].playerId, 'news').length).toBe(1);
  });

  it('only contestants get votes: a lone candidate wins with 100%, a vacant seat has no winner and is never declared', async () => {
    const c = await fielded();
    await pollAll(c);
    const byseat = new Map((await c.repo.listSeatResults(c.gameId)).map((r) => [r.seat, r]));
    expect(byseat.get(1)).toMatchObject({ winner: c.p[0].playerId, shares: { [c.p[0].playerId]: 1 } });
    expect(byseat.get(7)).toMatchObject({ winner: null, shares: {} });
    expect(byseat.get(8)).toMatchObject({ winner: null, shares: {} });
    expect(Object.keys(byseat.get(3)!.shares).sort()).toEqual([c.p[0].playerId, c.p[1].playerId].sort());
    expect(Object.keys(byseat.get(5)!.shares).length).toBe(3);
    const r = await c.runCampaignToCountingEnd();
    expect(r.done).toBe(true);
    const snap = await snapshotOf(c, 0);
    expect(snap.tally?.total).toBe(6);
    expect(snap.tally?.declared).toBe(6);
    expect(snap.seats[7]).toBeUndefined();
  });

  it('seat updates carry the contested seats as the tally total', async () => {
    const c = await fielded();
    await c.runCampaignToCountingEnd();
    const u = c.notifier.to(c.p[1].playerId, 'seatUpdate') as Of<'seatUpdate'>[];
    expect(u.length).toBeGreaterThan(0);
    for (const m of u) expect(m.tally.total).toBe(6);
  });

  it('the lowered majority decides the result: 4 of 6 contested seats ends the game although it is only half of the map', async () => {
    const c = await fielded();
    await pollAll(c);
    await setResults(c, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 6: 2, 7: null, 8: null });
    await c.runCampaignToCountingEnd();
    expect((await c.game()).status).toBe('finished');
    expect((await c.repo.getGovernment(c.gameId))?.portfolios.PM).toEqual([c.p[0].playerId]);
  });

  it('three of six contested seats is not a majority: the game goes to post-counting', async () => {
    const c = await fielded();
    await pollAll(c);
    await setResults(c, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 2, 7: null, 8: null });
    await c.runCampaignToCountingEnd();
    expect((await c.game()).status).toBe('postCounting');
  });

  it('a coalition reaching the lowered majority forms a government', async () => {
    const c = await fielded();
    await pollAll(c);
    await setResults(c, { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: null, 8: null });
    await c.runCampaignToCountingEnd();
    expect((await c.game()).status).toBe('postCounting');
    const [a, b] = [c.p[0].playerId, c.p[1].playerId];
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [a], HOME: [b] } });
    expect(c.lastError(0)).toBeUndefined();
    const offer = (await c.repo.listOffers(c.gameId))[0];
    await c.send(1, { action: 'respondOffer', offerId: offer.offerId, accept: true });
    expect((await c.game()).status).toBe('finished');
    expect((await c.repo.getGovernment(c.gameId))?.portfolios.PM).toEqual([a]);
  });

  it('a party eliminated in the campaign loses its candidates, its lone seats become vacant, and majority and contested seats stay fixed', async () => {
    const c = await fielded();
    await c.svc.eliminate(c.gameId, c.p[2].playerId);
    expect(await c.game()).toMatchObject({ contestedSeats: 6, majority: 4 });
    expect(lastUpdate(c, 0)).toMatchObject({ playerId: c.p[2].playerId, added: [], removed: [5, 6], contestedSeats: 6, majority: 4 });
    const snap = await snapshotOf(c, 0);
    expect(snap.fielding[6] ?? []).toEqual([]);
    expect(snap.fielding[5].map((x) => x.playerId).sort()).toEqual([c.p[0].playerId, c.p[1].playerId].sort());
    expect(snap.contestedSeats).toBe(6);
    expect(snap.majority).toBe(4);
    await pollAll(c);
    const byseat = new Map((await c.repo.listSeatResults(c.gameId)).map((r) => [r.seat, r]));
    expect(byseat.get(6)?.winner).toBeNull();
  });

  it('a seat report and the news agencies work with vacant seats and lone candidates', async () => {
    const c = await fielded();
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    c.clock.advance(2000);
    await c.send(1, { action: 'buyReport', scope: 'seat', seat: 8 });
    expect(c.lastError(1)).toBeUndefined();
    await c.send(1, { action: 'buyReport', scope: 'global' });
    expect(c.lastError(1)).toBeUndefined();
    await c.send(1, { action: 'globalReports' });
    expect(c.lastError(1)).toBeUndefined();
    expect(c.notifier.to(c.p[1].playerId, 'globalReports').length).toBe(1);
  });

  it('peekSeat names only the fielded parties of a seat, and a vacant seat has nothing to show', async () => {
    const c = await fielded();
    await c.runCampaignToCountingEnd();
    const columns = await Promise.all([0, 1].map(async (i) => (await record(c, i)).candidateColumn as number));
    await c.send(1, { action: 'peekSeat', seat: 3 });
    const m = c.notifier.to(c.p[1].playerId, 'seatShares').at(-1) as Of<'seatShares'>;
    expect(m.candidates).toEqual({ [c.p[0].playerId]: `C3-${columns[0]}`, [c.p[1].playerId]: `C3-${columns[1]}` });
    await c.send(1, { action: 'peekSeat', seat: 8 });
    expect(c.lastError(1)?.error).toBe('NOT_FOUND');
  });
});

describe('hello and the snapshot', () => {
  it('in the lobby they carry no fielding, 0 contested seats and the majority of that', async () => {
    const c = new Ctx();
    await c.lobby(3);
    expect(await snapshotOf(c, 0)).toMatchObject({ fielding: {}, contestedSeats: 0, majority: 1 });
  });

  it('a pending player gets the same empty fielding', async () => {
    const c = new Ctx();
    await c.lobby(2);
    const j = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'Pending' });
    const h = (await c.svc.hello((await c.repo.getPlayer(c.gameId, j.playerId))!)) as Of<'hello'>;
    expect(h.snapshot).toMatchObject({ fielding: {}, contestedSeats: 0, majority: 1 });
  });

  it('in the pre-campaign they are live and public and list each candidate with its name, and the candidate column stays secret', async () => {
    const c = await new Ctx({ candidates: CANDIDATES }).inPreCampaign(3);
    await c.send(0, field([1, 2]));
    await c.send(1, field([2]));
    const col = (await record(c, 0)).candidateColumn as number;
    const s = await snapshotOf(c, 2);
    expect(s).toMatchObject({ status: 'preCampaign', contestedSeats: 2, majority: 2 });
    expect(s.fielding[1]).toEqual([{ playerId: c.p[0].playerId, name: `C1-${col}` }]);
    expect(s.fielding[2].length).toBe(2);
    expect(s.fielding[3]).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('candidateColumn');
    expect(JSON.stringify(s)).not.toContain('fieldingSeq');
  });

  it('a map without candidates.csv lists candidates without a name', async () => {
    const c = await new Ctx().inPreCampaign(3);
    await c.send(0, field([1]));
    expect((await snapshotOf(c, 1)).fielding[1]).toEqual([{ playerId: c.p[0].playerId }]);
    expect(acks(c, 0)[0].added).toEqual([{ seat: 1 }]);
  });

  it('a hello too big for one WebSocket message leaves the fielding out and sends it right after as one fieldingUpdate per party', async () => {
    const seats = 300;
    const c = new Ctx({ map: lineMap(seats), candidates: Array.from({ length: seats }, () => Array.from({ length: 10 }, (_, k) => `A rather long candidate name ${k}`)) });
    await c.inPreCampaign(8);
    const all = allSeats(c);
    for (let i = 0; i < 8; i++) await c.send(i, field(all));
    const msgs = await c.svc.helloMessages(await record(c, 3));
    expect(msgs[0].type).toBe('hello');
    expect(JSON.stringify(msgs[0]).length).toBeLessThan(100_000);
    const h = msgs[0] as Of<'hello'>;
    expect(h.snapshot.fielding).toEqual({});
    expect(h.snapshot.contestedSeats).toBe(seats);
    const rest = msgs.slice(1) as Of<'fieldingUpdate'>[];
    expect(rest.map((m) => m.type)).toEqual(Array(8).fill('fieldingUpdate'));
    expect(rest.map((m) => m.playerId).sort()).toEqual(c.p.map((p) => p.playerId).sort());
    for (const m of rest) {
      expect(m.added.map((a) => a.seat)).toEqual(all);
      expect(m.contestedSeats).toBe(seats);
      expect(JSON.stringify(m).length).toBeLessThan(100_000);
    }
    // handleMessage sends all of them on the first message of a connection
    await c.svc.connect(c.gameId, c.p[3].token, 'fresh');
    c.notifier.clear();
    await c.svc.handleMessage('fresh', { action: 'ping', clientTime: 1 });
    expect(c.notifier.to(c.p[3].playerId).map((m) => m.type)).toEqual(['hello', ...Array(8).fill('fieldingUpdate'), 'pong']);
  });
});
