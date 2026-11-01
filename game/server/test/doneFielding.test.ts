// "Done fielding" in the pre-campaign (games with 3+ players). A player with at least one candidate can say they have finished
// fielding; Done is public and live (a fieldingDone message to everybody with "doneCount of needed") and can be taken back until
// everybody is done. Fielding or withdrawing clears it. `needed` = the connected active players: a disconnected player does not
// block, and reconnecting blocks again. When every needed player is done the campaign starts at once: the pre-campaign ends now,
// the lead-in stays, and every later time of the timeline moves earlier by the time saved, so the campaign keeps its full length.
// The lifecycle is restarted on the new timeline (Scheduler.restartLifecycle); openCampaign stays idempotent, so the old timer firing
// later does nothing. If not everyone presses Done the countdown ends the phase as before. A 2-player game has no pre-campaign.
import { analystPrice } from '@hp/shared';
import type { ClientMessage, GameTimeline, ServerMessage } from '@hp/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameService } from '../src/core/gameService';
import { TimerScheduler } from '../src/local/timerScheduler';
import { Ctx, T0, driveTo } from './helpers';

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

const field = (seats: number[]): ClientMessage => ({ action: 'field', seats });
const withdraw = (seats: number[]): ClientMessage => ({ action: 'withdraw', seats });
const done = (d?: boolean): ClientMessage => (d === undefined ? { action: 'doneFielding' } : { action: 'doneFielding', done: d });
const dones = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'fieldingDone') as Of<'fieldingDone'>[];
const statuses = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'status') as Of<'status'>[];
const record = async (c: Ctx, i: number) => (await c.repo.getPlayer(c.gameId, c.p[i].playerId))!;
const helloMsgs = async (c: Ctx, i: number) => c.svc.helloMessages(await record(c, i));
/** Every time of a timeline, in a fixed order. */
const times = (t: GameTimeline) => [t.preCampaignEnd as number, t.campaignStart, ...t.phaseCloses, t.campaignEnd, t.countingEnd, t.postCountingEnd];

/** A pre-campaign where every player has a candidate on seat 1 (and the clock is a little into the phase). */
async function fieldedAll(n = 3, phases = 3): Promise<Ctx> {
  const c = await new Ctx().inPreCampaign(n, phases);
  for (let i = 0; i < n; i++) await c.send(i, field([1]));
  c.clock.advance(3000);
  c.notifier.clear();
  return c;
}

describe('pressing Done fielding', () => {
  it('Done is stored on the player and announced to everybody with how many of the connected active players are done', async () => {
    const c = await fieldedAll();
    await c.send(0, done());
    expect(c.lastError(0)).toBeUndefined();
    expect((await record(c, 0)).doneFielding).toBe(true);
    for (const i of [0, 1, 2]) {
      expect(dones(c, i)).toEqual([{ type: 'fieldingDone', playerId: c.p[0].playerId, done: true, doneCount: 1, needed: 3 }]);
    }
    expect((await c.game()).status).toBe('preCampaign');
  });

  it('done defaults to true, done:false takes it back and is announced too, and pressing Done twice changes nothing', async () => {
    const c = await fieldedAll();
    await c.send(1, done(true));
    await c.send(1, done(true));
    expect(dones(c, 2).map((m) => [m.done, m.doneCount])).toEqual([[true, 1], [true, 1]]);
    await c.send(1, done(false));
    expect((await record(c, 1)).doneFielding).toBeUndefined();
    expect(dones(c, 2).at(-1)).toEqual({ type: 'fieldingDone', playerId: c.p[1].playerId, done: false, doneCount: 0, needed: 3 });
  });

  it('Done is refused with BAD_REQUEST while the player has no candidate (also after withdrawing the last one); taking back is always allowed', async () => {
    const c = await new Ctx().inPreCampaign(3);
    c.notifier.clear();
    await c.send(0, done());
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
    expect((await record(c, 0)).doneFielding).toBeUndefined();
    await c.send(0, field([2]));
    await c.send(0, withdraw([2]));
    await c.send(0, done());
    expect(c.notifier.to(c.p[0].playerId, 'error').length).toBe(2);
    expect(dones(c, 1)).toEqual([]);
    await c.send(0, done(false));
    expect(c.notifier.to(c.p[0].playerId, 'error').length).toBe(2);
    expect(dones(c, 1).at(-1)).toMatchObject({ done: false, doneCount: 0 });
  });

  it('a done value that is not true or false answers BAD_REQUEST', async () => {
    const c = await fieldedAll();
    await c.send(0, { action: 'doneFielding', done: 'yes' } as unknown as ClientMessage);
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
    expect((await record(c, 0)).doneFielding).toBeUndefined();
  });

  it.each(['lobby', 'campaign', 'counting', 'finished'] as const)('Done answers WRONG_PHASE in the %s', async (status) => {
    const c = new Ctx();
    if (status === 'lobby') {
      await c.lobby(3);
      for (const p of c.p) await c.svc.connect(c.gameId, p.token, p.conn);
    } else {
      await c.started(3);
      await driveTo(c, status);
    }
    c.notifier.clear();
    await c.send(0, done());
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
    await c.send(0, done(false));
    expect(c.notifier.to(c.p[0].playerId, 'error').filter((m) => (m as Of<'error'>).error === 'WRONG_PHASE').length).toBe(2);
    expect(c.notifier.to(c.p[1].playerId, 'fieldingDone')).toEqual([]);
  });

  it('server time decides: from the deadline on Done answers WRONG_PHASE even before the campaign has been opened', async () => {
    const c = await fieldedAll();
    c.clock.set(c.timeline.preCampaignEnd as number);
    await c.send(0, done());
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
  });

  it('an eliminated player and a player who is not active get FORBIDDEN', async () => {
    const c = await fieldedAll(4);
    await c.repo.updatePlayer(c.gameId, c.p[0].playerId, { status: 'disconnected' });
    await expect(c.svc.doneFielding(await record(c, 0), true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await c.svc.eliminate(c.gameId, c.p[2].playerId, { keepConnection: true });
    await c.send(2, done());
    expect(c.lastError(2)?.error).toBe('FORBIDDEN');
  });

  it('fielding or withdrawing after Done clears it and tells everybody; a batch that changes nothing keeps it', async () => {
    const c = await fieldedAll();
    await c.send(0, done());
    await c.send(0, field([1]));
    expect((await record(c, 0)).doneFielding).toBe(true);
    await c.send(0, field([2]));
    expect((await record(c, 0)).doneFielding).toBeUndefined();
    expect(dones(c, 1).at(-1)).toEqual({ type: 'fieldingDone', playerId: c.p[0].playerId, done: false, doneCount: 0, needed: 3 });
    await c.send(0, done());
    c.notifier.clear();
    await c.send(0, withdraw([2]));
    expect((await record(c, 0)).doneFielding).toBeUndefined();
    expect(c.notifier.to(c.p[2].playerId).map((m) => m.type)).toEqual(['fieldingUpdate', 'fieldingDone']);
    expect(dones(c, 2)[0]).toMatchObject({ done: false, doneCount: 0 });
  });

  it('fielding after Done changes nothing for the other players: only the changer loses Done', async () => {
    const c = await fieldedAll(4);
    await c.send(0, done());
    await c.send(1, done());
    await c.send(1, field([3]));
    expect((await record(c, 0)).doneFielding).toBe(true);
    expect(dones(c, 3).at(-1)).toMatchObject({ playerId: c.p[1].playerId, done: false, doneCount: 1, needed: 4 });
  });

  it('a partial Done does not start the campaign', async () => {
    const c = await fieldedAll(4);
    for (const i of [0, 1, 2]) await c.send(i, done());
    expect(dones(c, 3).at(-1)).toMatchObject({ doneCount: 3, needed: 4 });
    expect((await c.game()).status).toBe('preCampaign');
    expect(c.scheduler.restarts).toEqual([]);
    expect(statuses(c, 0)).toEqual([]);
  });
});

describe('everybody done: the campaign starts at once', () => {
  it('the last Done opens the campaign at once; every later time moves earlier by the time saved, keeping the lead-in and a campaign of full length', async () => {
    const c = await fieldedAll();
    const old = (await c.game()).timeline as GameTimeline;
    const now = c.clock.now();
    for (const i of [0, 1, 2]) await c.send(i, done());
    const g = await c.game();
    expect(g.status).toBe('campaign');
    const tl = g.timeline as GameTimeline;
    const saved = (old.preCampaignEnd as number) - now;
    expect(saved).toBeGreaterThan(0);
    expect(tl.preCampaignEnd).toBe(now);
    expect(tl.campaignStart).toBe(now + (old.campaignStart - (old.preCampaignEnd as number)));
    expect(times(tl)).toEqual(times(old).map((t) => t - saved));
    expect(tl.campaignEnd - tl.campaignStart).toBe(c.cfg.durations.campaignMs);
    // the lifecycle was restarted on exactly that timeline, and everybody learnt it from the campaign's status message
    expect(c.scheduler.restarts).toEqual([{ gameId: c.gameId, timeline: tl }]);
    for (const i of [0, 1, 2]) {
      expect(statuses(c, i).map((m) => m.status)).toEqual(['campaign']);
      expect(statuses(c, i)[0].timeline).toEqual(tl);
      expect(dones(c, i).at(-1)).toMatchObject({ playerId: c.p[2].playerId, done: true, doneCount: 3, needed: 3 });
    }
    // the order every client sees: the last Done, then the campaign opening
    expect(c.notifier.to(c.p[1].playerId).map((m) => m.type).slice(-4)).toEqual(['fieldingDone', 'status', 'fieldingUpdate', 'private']);
    // Done is cleared at campaign open
    for (const i of [0, 1, 2]) expect((await record(c, i)).doneFielding).toBeUndefined();
    expect(g).toMatchObject({ contestedSeats: 1, majority: 1, campaignOpened: true });
  });

  it('after an early start fielding, withdrawing and Done are closed', async () => {
    const c = await fieldedAll();
    for (const i of [0, 1, 2]) await c.send(i, done());
    c.notifier.clear();
    await c.send(0, field([2]));
    await c.send(0, withdraw([1]));
    await c.send(0, done(false));
    expect(c.notifier.to(c.p[0].playerId, 'error').map((m) => (m as Of<'error'>).error)).toEqual(['WRONG_PHASE', 'WRONG_PHASE', 'WRONG_PHASE']);
  });

  it('the campaign then runs on the new timeline: actions from its campaign start, analyst prices, polling and counting all follow the shifted times', async () => {
    const c = await fieldedAll(3, 2);
    const old = (await c.game()).timeline as GameTimeline;
    for (const i of [0, 1, 2]) await c.send(i, done());
    const tl = c.timeline;
    expect(tl.campaignStart).toBeLessThan(old.campaignStart);
    // before the new campaign start nothing can be done yet; from it on the campaign is open
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1 });
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
    c.clock.set(tl.campaignStart);
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1 });
    await c.send(1, { action: 'buyReport', scope: 'global' });
    expect(c.notifier.to(c.p[0].playerId, 'actionAck').length).toBe(1);
    const rep = c.notifier.to(c.p[1].playerId, 'report')[0] as Of<'report'>;
    expect(rep.report.price).toBe(analystPrice(c.cfg, 'global', tl, tl.campaignStart));
    expect(rep.report.price).toBe(c.cfg.analyst.globalReport.start);
    // the first polling phase closes at the new time, and a seat of it is closed for campaigning from then on
    c.clock.set(tl.phaseCloses[0]);
    await c.svc.phaseClose(c.gameId, 0);
    expect((await c.game()).closedPhases).toBe(1);
    expect(tl.phaseCloses[0]).toBeLessThan(old.phaseCloses[0]);
    // counting starts at the new campaign end and lasts as long as before
    const r = await c.runCampaignToCountingEnd();
    expect(r.done).toBe(true);
    const plan = (await c.repo.getCountPlan(c.gameId))!;
    expect(plan.startMs).toBe(tl.campaignEnd);
    expect(tl.countingEnd - tl.campaignEnd).toBe(old.countingEnd - old.campaignEnd);
    expect(c.clock.now()).toBeLessThan(old.countingEnd);
  });

  it('the news agencies sample the new campaign: the first point is at the new campaign start', async () => {
    const c = await fieldedAll();
    for (const i of [0, 1, 2]) await c.send(i, done());
    const tl = c.timeline;
    c.clock.set(tl.campaignStart + 1);
    await c.send(0, { action: 'globalReports' });
    expect(c.lastError(0)).toBeUndefined();
    const g = c.notifier.to(c.p[0].playerId, 'globalReports')[0] as Of<'globalReports'>;
    expect(g.reports.asOf).toBe(tl.campaignStart);
  });

  it('the old deadline timer firing afterwards does nothing (openCampaign is idempotent)', async () => {
    const c = await fieldedAll();
    const old = (await c.game()).timeline as GameTimeline;
    for (const i of [0, 1, 2]) await c.send(i, done());
    const after = await c.game();
    c.notifier.clear();
    c.clock.set(old.preCampaignEnd as number);
    await c.svc.openCampaign(c.gameId);
    expect(c.notifier.log).toEqual([]);
    expect(await c.game()).toEqual(after);
  });

  it('the old timer winning the race: once the deadline has opened the campaign the last Done is refused and nothing restarts', async () => {
    const c = await fieldedAll();
    for (const i of [0, 1]) await c.send(i, done());
    c.clock.set(c.timeline.preCampaignEnd as number);
    await c.svc.openCampaign(c.gameId);
    await c.send(2, done());
    expect(c.lastError(2)?.error).toBe('WRONG_PHASE');
    expect(c.scheduler.restarts).toEqual([]);
  });

  it('the deadline opening the campaign while the last Done is in flight: the campaign opens, and every client ends up with the timeline the game runs on', async () => {
    const c = await fieldedAll();
    for (const i of [0, 1]) await c.send(i, done());
    await Promise.all([c.svc.openCampaign(c.gameId), c.send(2, done())]);
    const g = await c.game();
    expect(g).toMatchObject({ status: 'campaign', campaignOpened: true });
    expect(c.scheduler.restarts.length).toBeLessThanOrEqual(1);
    if (c.scheduler.restarts.length) expect(g.timeline).toEqual(c.scheduler.restarts[0].timeline);
    for (const i of [0, 1, 2]) expect(statuses(c, i).filter((m) => m.status === 'campaign').at(-1)?.timeline).toEqual(g.timeline);
  });

  it('two players pressing the last Done at the same time start the campaign once', async () => {
    const c = await fieldedAll();
    await c.send(0, done());
    await Promise.all([c.send(1, done()), c.send(2, done())]);
    expect((await c.game()).status).toBe('campaign');
    expect(c.scheduler.restarts.length).toBe(1);
    for (const i of [0, 1, 2]) expect(statuses(c, i).length).toBe(1);
  });

  it('the restarted lifecycle opens the campaign; until it does the timeline is already shifted and fielding is closed', async () => {
    const c = await fieldedAll();
    c.scheduler.openOnRestart = false;
    for (const i of [0, 1, 2]) await c.send(i, done());
    const g = await c.game();
    expect(g.status).toBe('preCampaign');
    expect(g.timeline?.preCampaignEnd).toBe(c.clock.now());
    await c.send(0, field([2]));
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
    await c.svc.openCampaign(c.gameId);
    expect((await c.game()).status).toBe('campaign');
  });

  it('a lifecycle restart that fails puts the old timeline back: the pre-campaign goes on to its deadline', async () => {
    const c = await fieldedAll();
    const old = (await c.game()).timeline;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(c.scheduler, 'restartLifecycle').mockRejectedValueOnce(new Error('sfn down'));
    for (const i of [0, 1, 2]) await c.send(i, done());
    spy.mockRestore();
    expect(c.lastError(2)).toBeUndefined();
    const g = await c.game();
    expect(g.status).toBe('preCampaign');
    expect(g.timeline).toEqual(old);
  });

  it('the countdown still ends the phase when not everyone is done, on the original timeline, and clears every Done', async () => {
    const c = await fieldedAll();
    const old = (await c.game()).timeline;
    await c.send(0, done());
    c.clock.set(c.timeline.preCampaignEnd as number);
    await c.svc.openCampaign(c.gameId);
    const g = await c.game();
    expect(g.status).toBe('campaign');
    expect(g.timeline).toEqual(old);
    expect(c.scheduler.restarts).toEqual([]);
    expect((await record(c, 0)).doneFielding).toBeUndefined();
    expect((await helloMsgs(c, 1)).map((m) => m.type)).toEqual(['hello']);
    expect(((await helloMsgs(c, 1))[0] as Of<'hello'>).snapshot.fieldingDone).toEqual([]);
  });
});

describe('who has to be done: the connected active players', () => {
  it('a disconnected player does not block: when the only player not done disconnects, the campaign starts at once', async () => {
    const c = await fieldedAll();
    await c.send(0, done());
    await c.send(1, done());
    expect((await c.game()).status).toBe('preCampaign');
    await c.svc.disconnect(c.p[2].conn);
    expect(dones(c, 0).at(-1)).toMatchObject({ playerId: c.p[2].playerId, done: false, doneCount: 2, needed: 2 });
    expect((await c.game()).status).toBe('campaign');
    expect(c.scheduler.restarts.length).toBe(1);
    // the disconnected player keeps their candidates and is still in the game (grace period)
    expect((await record(c, 2)).status).toBe('disconnected');
  });

  it('a disconnected player is not counted, and reconnecting blocks again (announced with the new count)', async () => {
    const c = await fieldedAll();
    await c.svc.disconnect(c.p[2].conn);
    expect(dones(c, 0).at(-1)).toMatchObject({ doneCount: 0, needed: 2 });
    await c.send(0, done());
    expect(dones(c, 1).at(-1)).toMatchObject({ doneCount: 1, needed: 2 });
    await c.svc.connect(c.gameId, c.p[2].token, 'again');
    expect(dones(c, 0).at(-1)).toMatchObject({ playerId: c.p[2].playerId, done: false, doneCount: 1, needed: 3 });
    await c.send(1, done());
    expect((await c.game()).status).toBe('preCampaign');
  });

  it('a player who is done stays done while disconnected and counts again on reconnecting', async () => {
    const c = await fieldedAll();
    await c.send(2, done());
    await c.svc.disconnect(c.p[2].conn);
    expect((await record(c, 2)).doneFielding).toBe(true);
    await c.svc.connect(c.gameId, c.p[2].token, 'again');
    expect(dones(c, 0).at(-1)).toMatchObject({ playerId: c.p[2].playerId, done: true, doneCount: 1, needed: 3 });
  });

  it('a connected player who has not fielded anything blocks the early start (nobody is eliminated by the others finishing first)', async () => {
    const c = await new Ctx().inPreCampaign(3);
    for (const i of [0, 1]) await c.send(i, field([1]));
    for (const i of [0, 1]) await c.send(i, done());
    expect((await c.game()).status).toBe('preCampaign');
    expect((await record(c, 2)).status).toBe('active');
  });

  it('a player eliminated in the pre-campaign no longer counts: if the rest are done the campaign starts', async () => {
    const c = await fieldedAll(4);
    for (const i of [0, 1, 2]) await c.send(i, done());
    await c.svc.eliminate(c.gameId, c.p[3].playerId);
    expect(dones(c, 0).at(-1)).toMatchObject({ doneCount: 3, needed: 3 });
    expect((await c.game()).status).toBe('campaign');
  });

  it('with nobody connected nothing starts early', async () => {
    const c = await fieldedAll();
    for (const i of [0, 1, 2]) await c.svc.disconnect(c.p[i].conn);
    expect(dones(c, 0).at(-1)).toMatchObject({ doneCount: 0, needed: 0 });
    expect((await c.game()).status).toBe('preCampaign');
  });
});

describe('hello and the snapshot', () => {
  it('the snapshot lists the done players in the pre-campaign, and the hello is followed by a fieldingDone with the current counts', async () => {
    const c = await fieldedAll();
    await c.send(1, done());
    const msgs = await helloMsgs(c, 0);
    expect(msgs.map((m) => m.type)).toEqual(['hello', 'fieldingDone']);
    expect((msgs[0] as Of<'hello'>).snapshot.fieldingDone).toEqual([c.p[1].playerId]);
    expect(msgs[1]).toEqual({ type: 'fieldingDone', playerId: c.p[0].playerId, done: false, doneCount: 1, needed: 3 });
    const mine = await helloMsgs(c, 1);
    expect(mine[1]).toMatchObject({ playerId: c.p[1].playerId, done: true });
  });

  it('in the lobby, for a pending player and after the pre-campaign the list is empty and no fieldingDone follows the hello', async () => {
    const c = new Ctx();
    await c.lobby(3);
    expect(((await helloMsgs(c, 0))[0] as Of<'hello'>).snapshot.fieldingDone).toEqual([]);
    const j = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'Pending' });
    const pending = await c.svc.helloMessages((await c.repo.getPlayer(c.gameId, j.playerId))!);
    expect((pending[0] as Of<'hello'>).snapshot.fieldingDone).toEqual([]);
    const s = await new Ctx().started(3);
    expect((await helloMsgs(s, 0)).map((m) => m.type)).toEqual(['hello']);
    expect(((await helloMsgs(s, 0))[0] as Of<'hello'>).snapshot.fieldingDone).toEqual([]);
  });

  it('a 2-player game is untouched: no pre-campaign, Done answers WRONG_PHASE, the snapshot has no done players and nothing restarts', async () => {
    const c = await new Ctx().inPreCampaign(2);
    expect((await c.game()).status).toBe('campaign');
    await c.send(0, done());
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
    expect(((await helloMsgs(c, 0))[0] as Of<'hello'>).snapshot.fieldingDone).toEqual([]);
    expect(c.scheduler.restarts).toEqual([]);
  });
});

describe('with the local timer scheduler', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('everybody done opens the campaign at once and the old timers never fire: phases close at the new times', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const c = new Ctx();
    const sched = new TimerScheduler({ now: () => Date.now() });
    c.svc = new GameService({ repo: c.repo, notifier: c.notifier, scheduler: sched, clock: { now: () => Date.now() }, maps: c.maps, startDelayMs: 1000 });
    sched.bind(c.svc);
    await c.lobby(3, 2);
    const { timeline: old } = await c.svc.start(c.gameId, c.p[0].token);
    for (const p of c.p) await c.svc.connect(c.gameId, p.token, p.conn);
    for (let i = 0; i < 3; i++) await c.send(i, field([1]));
    await vi.advanceTimersByTimeAsync(2000);
    const phaseClose = vi.spyOn(c.svc, 'phaseClose');
    for (let i = 0; i < 3; i++) await c.send(i, done());
    await vi.advanceTimersByTimeAsync(0);
    const g = await c.game();
    expect(g.status).toBe('campaign');
    const tl = g.timeline as GameTimeline;
    expect(tl.preCampaignEnd).toBe(T0 + 2000);
    // the first phase closes at its new time, not at the old one
    await vi.advanceTimersByTimeAsync(tl.phaseCloses[0] - Date.now() - 1);
    expect(phaseClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(phaseClose).toHaveBeenCalledTimes(1);
    expect((await c.game()).closedPhases).toBe(1);
    // the old loop is gone: by the old first close only the new loop has closed phase 0, once
    await vi.advanceTimersByTimeAsync(old.phaseCloses[0] - Date.now());
    expect(phaseClose.mock.calls.filter(([, p]) => p === 0).length).toBe(1);
    sched.stop();
  });
});
