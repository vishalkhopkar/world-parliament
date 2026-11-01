import { afterEach, describe, expect, it } from 'vitest';
import { AVATARS, WORLD_CONFIG, fullyFieldedBudget, majorityOf } from '@hp/shared';
import type { CoalitionOffer, GlobalReports, ServerMessage } from '@hp/shared';
import { MockTransport } from '../mock';
import { ApiException } from '../transport';

let t: MockTransport;
afterEach(() => t?.disconnect());

async function lobbyOf(t: MockTransport, mapId = 'world-500') {
  const r = await t.createGame({ nickname: 'Vishal', mapId, phases: 2 });
  return { r, lobby: await t.getLobby(r.gameId, r.token) };
}

describe('mock transport peekSeat', () => {
  it('refuses before counting has started and replies with an error, not shares', async () => {
    t = new MockTransport();
    const { r } = await lobbyOf(t);
    const got: { type: string; error?: string }[] = [];
    t.connect(r.gameId, r.token, m => got.push(m as never));
    t.send({ action: 'peekSeat', seat: 1 });
    await new Promise(res => setTimeout(res, 100)); // the mock delivers messages after ~20 ms
    expect(got.filter(m => m.type === 'seatShares')).toHaveLength(0);
    expect(got.find(m => m.type === 'error')?.error).toBe('WRONG_PHASE');
  });
});

describe('mock transport avatars / AI / map', () => {
  it('bots have avatars and one bot is an AI agent', async () => {
    t = new MockTransport();
    const { lobby } = await lobbyOf(t);
    const bots = lobby.players.filter(p => p.nickname !== 'Vishal');
    expect(bots.length).toBeGreaterThanOrEqual(2);
    expect(bots.filter(b => b.kind === 'agent')).toHaveLength(1);
    const active = bots.filter(b => b.status === 'active');
    expect(active.every(b => !!b.party?.avatar)).toBe(true);
  });

  it('uses the mapId of the request for the game', async () => {
    t = new MockTransport();
    const { lobby } = await lobbyOf(t, 'world-500');
    expect(lobby.mapId).toBe('world-500');
  });

  it('rejects an unknown map', async () => {
    t = new MockTransport();
    await expect(t.createGame({ nickname: 'V', mapId: 'atlantis', phases: 2 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an unknown avatar with BAD_REQUEST and a taken avatar with AVATAR_TAKEN', async () => {
    t = new MockTransport();
    const { r, lobby } = await lobbyOf(t);
    const takenAvatar = lobby.players.find(p => p.party?.avatar)!.party!.avatar!;
    const base = { name: 'My Party', colour: '#C0182F', symbol: 'torch' };
    await expect(t.setParty(r.gameId, r.token, { party: { ...base, avatar: 'nobody' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const err = await t.setParty(r.gameId, r.token, { party: { ...base, avatar: takenAvatar } }).catch(e => e);
    expect(err).toBeInstanceOf(ApiException);
    expect(err.code).toBe('AVATAR_TAKEN');
    await expect(t.setParty(r.gameId, r.token, { party: { ...base, avatar: 'putin' } })).resolves.toBeUndefined();
    const after = await t.getLobby(r.gameId, r.token);
    expect(after.players.find(p => p.playerId === r.playerId)?.party?.avatar).toBe('putin');
  });

  it('start requires every active player to have an avatar', async () => {
    t = new MockTransport();
    const { r } = await lobbyOf(t);
    await t.setParty(r.gameId, r.token, { party: { name: 'No Avatar', colour: '#C0182F', symbol: 'torch' } });
    await expect(t.start(r.gameId, r.token)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// ---- coalition rules (poking the private game state to reach counting without waiting for the timers)
type Poke = { g: { status: string; tally: unknown; offers: Array<Record<string, unknown>>; government: unknown; result: unknown; players: Map<string, { pub: { status: string }; bot: boolean }>; me: string; timeline: { postCountingEnd: number } | null } };
async function inGame() {
  t = new MockTransport();
  const { r } = await lobbyOf(t);
  const got: Array<Record<string, unknown>> = [];
  t.connect(r.gameId, r.token, m => got.push(m as never));
  const g = (t as unknown as Poke).g;
  const act = [...g.players.values()].filter(p => p.pub.status === 'active');
  const ids = [...g.players.entries()].filter(([, p]) => p.pub.status === 'active').map(([id]) => id);
  const wins = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 300 : 100]));
  g.tally = { wins, leads: Object.fromEntries(ids.map(id => [id, 0])), declared: 500, total: 500 };
  return { g, got, ids, act };
}
const settle = () => new Promise(res => setTimeout(res, 60));

describe('mock transport coalition rules', () => {
  it('rejects an offer that includes every party', async () => {
    const { g, got, ids } = await inGame();
    g.status = 'counting';
    t.send({ action: 'proposeGovernment', portfolios: {}, partners: ids.filter(i => i !== g.me) } as never);
    await settle();
    const e = got.find(m => m.type === 'error');
    expect(e?.error).toBe('INVALID_GOVERNMENT');
    expect(String(e?.message)).toMatch(/stay out/);
  });

  it('an accepted offer waits during counting; the government is confirmed at the end of counting and the game finishes', async () => {
    const { g, got, ids } = await inGame();
    g.status = 'counting';
    g.timeline = { ...g.timeline!, postCountingEnd: Date.now() + 1e6 };
    const partner = ids.find(i => i !== g.me)!;
    // make me + partner a majority of won seats
    (g.tally as { wins: Record<string, number> }).wins = Object.fromEntries(ids.map(i => [i, i === g.me ? 220 : i === partner ? 200 : 20]));
    t.send({ action: 'proposeGovernment', portfolios: {}, partners: [partner] } as never);
    await settle();
    const offer = g.offers[0];
    expect(offer.status).toBe('open');
    t.send({ action: 'respondOffer', offerId: offer.offerId, accept: true } as never); // not a partner: no effect
    offer.accepted = [partner];
    (t as unknown as { checkFormed(g: unknown, o: unknown): void }).checkFormed(g, offer);
    expect(offer.status).toBe('accepted');
    expect(g.government).toBeNull();
    expect(g.status).toBe('counting');
    (t as unknown as { endCounting(g: unknown): void }).endCounting(g);
    expect(offer.status).toBe('formed');
    expect(g.status).toBe('finished');
    expect((g.result as { outcome: string }).outcome).toBe('coalition');
    void got;
  });

  it('sets declinedBy on decline and supersededBy when a newer offer replaces an open one', async () => {
    const { g, ids } = await inGame();
    g.status = 'counting';
    const others = ids.filter(i => i !== g.me);
    t.send({ action: 'proposeGovernment', portfolios: {}, partners: [others[0]] } as never);
    t.send({ action: 'proposeGovernment', portfolios: {}, partners: [others[0]] } as never);
    await settle();
    expect(g.offers).toHaveLength(2);
    expect(g.offers[0].status).toBe('superseded');
    expect(g.offers[0].supersededBy).toBe(g.offers[1].offerId);
    // a decline by me on an incoming offer
    const inc = { offerId: 'x', proposer: others[0], portfolios: { PM: [others[0]] }, partners: [g.me], accepted: [], status: 'open', createdAt: 1 };
    g.offers.push(inc);
    t.send({ action: 'respondOffer', offerId: 'x', accept: false } as never);
    expect(inc.status).toBe('declined');
    expect((inc as Record<string, unknown>).declinedBy).toBe(g.me);
  });

  it('chat is refused in the campaign when Chat.Campaigning is OFF', async () => {
    const { g, got } = await inGame();
    type Cfg = { cfg: { chat: { campaigning: string } } };
    g.status = 'campaign';
    (g as unknown as Cfg).cfg = { ...(g as never as { cfg: object }).cfg, chat: { campaigning: 'OFF' } } as never;
    t.send({ action: 'chat', to: [], text: 'hi' } as never);
    await settle();
    expect(got.find(m => m.type === 'error')?.error).toBe('WRONG_PHASE');
    got.length = 0;
    (g as unknown as Cfg).cfg.chat.campaigning = 'GROUP';
    t.send({ action: 'chat', to: [], text: 'hi' } as never);
    await settle();
    expect(got.find(m => m.type === 'chat')).toBeTruthy();
  });

  it('GROUP: one group message to everybody, with the tags found in the text', async () => {
    const { g, got, ids } = await inGame();
    g.status = 'campaign';
    const other = ids.find(i => i !== g.me)!;
    const name = (g as unknown as { players: Map<string, { pub: { party?: { name: string } } }> }).players.get(other)!.pub.party!.name;
    t.send({ action: 'chat', text: `hi @${name}` } as never);
    await settle();
    const m = got.find(x => x.type === 'chat') as unknown as Extract<ServerMessage, { type: 'chat' }>;
    expect(m.message).toMatchObject({ channel: 'group', mentions: [other] });
    expect(m.message.to.sort()).toEqual(ids.filter(i => i !== g.me).sort());
  });

  it('INDV (counting): one private one-to-one copy per recipient; a recipient is required', async () => {
    const { g, got, ids } = await inGame();
    g.status = 'counting';
    const others = ids.filter(i => i !== g.me);
    t.send({ action: 'chat', to: [others[0], others[1]], text: 'deal?' } as never);
    await settle();
    const sent = got.filter(x => x.type === 'chat').map(x => (x as unknown as Extract<ServerMessage, { type: 'chat' }>).message).filter(m => m.from === g.me);
    expect(sent.map(m => [m.to, m.channel])).toEqual([[[others[0]], 'direct'], [[others[1]], 'direct']]);
    got.length = 0;
    t.send({ action: 'chat', text: 'nobody' } as never);
    await settle();
    expect(got.find(m => m.type === 'error')?.error).toBe('BAD_REQUEST');
  });

  it('offers keep a log: my acceptance / decline, my withdrawal', async () => {
    const { g, ids } = await inGame();
    g.status = 'counting';
    const others = ids.filter(i => i !== g.me);
    const inc = { offerId: 'y', proposer: others[0], portfolios: { PM: [others[0]] }, partners: [g.me, others[1]], accepted: [], status: 'open', createdAt: 1 } as CoalitionOffer;
    g.offers.push(inc as never);
    t.send({ action: 'respondOffer', offerId: 'y', accept: true } as never);
    expect(inc.log?.[0]).toMatchObject({ type: 'accepted', by: g.me });
    const mine = { offerId: 'z', proposer: g.me, portfolios: { PM: [g.me] }, partners: [others[0]], accepted: [], status: 'open', createdAt: 2 } as CoalitionOffer;
    g.offers.push(mine as never);
    t.send({ action: 'withdrawOffer', offerId: 'z' } as never);
    expect(mine.status).toBe('withdrawn');
    expect(mine.log).toEqual([expect.objectContaining({ type: 'withdrawn', by: g.me })]);
  });
});

// ---- campaign: rally cooldown (same rule as the real server) and the Gaussian reputation
describe('mock transport rally cooldown', () => {
  async function inCampaign() {
    const x = await inGame();
    const g = x.g as unknown as { status: string; timeline: unknown; fielding: Map<number, { playerId: string }[]>; seatPhase: Map<number, number>; seatIds: number[]; players: Map<string, { budget: number }>; me: string; cfg: { cooldowns: { rallyMs: number } }; nextBotRally: number };
    const now = Date.now() + 2000;
    g.status = 'campaign';
    g.timeline = { campaignStart: now - 1000, phaseCloses: [now + 1e7, now + 2e7], campaignEnd: now + 2e7, countingEnd: now + 3e7, postCountingEnd: now + 4e7 };
    g.seatIds = [1, 2, 3];
    for (const s of g.seatIds) g.seatPhase.set(s, 0);
    for (const s of g.seatIds) g.fielding.set(s, [...g.players.keys()].map(playerId => ({ playerId })));
    g.players.get(g.me)!.budget = 50_000;
    g.nextBotRally = Infinity; // keep the bots quiet
    x.got.length = 0;
    return { ...x, g };
  }
  const errs = (got: Array<Record<string, unknown>>) => got.filter(m => m.type === 'error').map(m => m.error);

  it('refuses a second rally inside the cooldown with RATE_LIMITED (and does not charge it); roadshows are not limited', async () => {
    const { g, got } = await inCampaign();
    const before = g.players.get(g.me)!.budget;
    t.send({ action: 'campaign', type: 'rally', seat: 1, clientRef: 'a' } as never);
    t.send({ action: 'campaign', type: 'rally', seat: 2, clientRef: 'b' } as never);
    t.send({ action: 'campaign', type: 'roadshow', seat: 2, clientRef: 'c' } as never);
    await settle();
    expect(errs(got)).toEqual(['RATE_LIMITED']);
    expect(got.filter(m => m.type === 'actionAck')).toHaveLength(2);
    const cfgCosts = (g as unknown as { cfg: { costs: { rally: number; roadshow: number } } }).cfg.costs;
    expect(g.players.get(g.me)!.budget).toBe(before - cfgCosts.rally - cfgCosts.roadshow);
    const priv = got.filter(m => m.type === 'private').pop() as { private: { nextRallyAt?: number; myActions: { type: string; ts: number }[] } };
    const lastRally = priv.private.myActions.filter(a => a.type === 'rally').pop()!;
    expect(priv.private.nextRallyAt).toBe(lastRally.ts + g.cfg.cooldowns.rallyMs);
  });

  it('allows a rally again once the cooldown has passed', async () => {
    const { g, got } = await inCampaign();
    t.send({ action: 'campaign', type: 'rally', seat: 1, clientRef: 'a' } as never);
    await settle();
    const acts = (g as unknown as { actions: { ts: number }[] }).actions;
    acts[0].ts -= g.cfg.cooldowns.rallyMs + 1;
    t.send({ action: 'campaign', type: 'rally', seat: 2, clientRef: 'b' } as never);
    await settle();
    expect(errs(got)).toEqual([]);
  });
});

describe('mock transport globalReports (free news-agency projections)', () => {
  async function startedGame() {
    t = new MockTransport();
    const { r, lobby } = await lobbyOf(t);
    const used = new Set(lobby.players.map(p => p.party?.avatar));
    const avatar = AVATARS.find(a => !used.has(a.id))!.id;
    await t.setParty(r.gameId, r.token, { party: { name: 'Mine', colour: '#123456', symbol: 'torch', avatar } });
    const got: { type: string; error?: string; reports?: GlobalReports }[] = [];
    t.connect(r.gameId, r.token, m => got.push(m as never));
    return { r, got };
  }
  const wait = (ms = 100) => new Promise(res => setTimeout(res, ms));
  /** 3 players start in the pre-campaign: open the campaign at once. */
  const toCampaign = () => {
    const x = t as unknown as { openCampaign(g: unknown): void; g: { seatIds: number[]; fielding: Map<number, { playerId: string }[]>; players: Map<string, { pub: { status: string } }> } };
    const ids = [...x.g.players].filter(([, p]) => p.pub.status === 'active').map(([id]) => id);
    for (const seat of x.g.seatIds) x.g.fielding.set(seat, ids.map(playerId => ({ playerId }))); // everybody stands everywhere
    x.openCampaign(x.g);
  };

  it('refuses in the lobby', async () => {
    const { got } = await startedGame();
    t.send({ action: 'globalReports' });
    await wait();
    expect(got.filter(m => m.type === 'globalReports')).toHaveLength(0);
    expect(got.find(m => m.type === 'error')?.error).toBe('WRONG_PHASE');
  });

  it('answers during the campaign with one series per configured agency, free of charge', async () => {
    const { r, got } = await startedGame();
    await t.start(r.gameId, r.token);
    t.send({ action: 'globalReports' });
    await wait();
    expect(got.filter(m => m.type === 'globalReports')).toHaveLength(0); // not in the pre-campaign
    expect(got.find(m => m.type === 'error')?.error).toBe('WRONG_PHASE');
    toCampaign();
    t.send({ action: 'globalReports' });
    await wait();
    const rep = got.find(m => m.type === 'globalReports')?.reports;
    expect(rep).toBeTruthy();
    expect(rep!.agencies.map(a => a.name)).toEqual(WORLD_CONFIG.news.agencies.map(a => a.name));
    const parties = Object.keys(rep!.agencies[0].ranges);
    expect(parties.length).toBeGreaterThanOrEqual(3);
    for (const a of rep!.agencies) {
      const first = a.points[0].seats;
      const sum = Object.values(first).reduce((x, y) => x + y, 0);
      expect(Object.values(first).every(v => Math.abs(v - sum / parties.length) < 1e-9)).toBe(true);
    }
    expect(got.filter(m => m.type === 'report')).toHaveLength(0); // not a paid analyst report: no budget change is sent
  });

  it('builds the offline stand-in map and kernels once per game and reuses them', async () => {
    const { r, got } = await startedGame();
    await t.start(r.gameId, r.token);
    toCampaign();
    const game = () => (t as unknown as { g: { pkg: unknown; kernels: unknown; standIn?: { pkg: unknown; kernels: unknown } } }).g;
    game().pkg = null; // offline: no map package -> grid stand-in
    game().kernels = null;
    t.send({ action: 'globalReports' });
    await wait();
    const first = game().standIn;
    expect(first).toBeTruthy();
    t.send({ action: 'globalReports' });
    await wait();
    expect(game().standIn).toBe(first);
    expect(got.filter(m => m.type === 'globalReports')).toHaveLength(2);
  });
});

// ---- the pre-campaign (3 or more players)
// Rule: with 3+ players the game opens with a pre-campaign in which every party fields candidates (each costs the configured
// price, withdrawing refunds it); at the deadline a party with no candidate is eliminated, seats nobody contests are vacant and
// the majority is fixed from the contested seats. With 2 players there is no pre-campaign and every seat is fielded and charged.
type Pre = {
  g: {
    status: string; me: string; budgetOf?: never; seatIds: number[]; fielding: Map<number, { playerId: string; name?: string }[]>;
    timeline: { preCampaignEnd?: number; campaignStart: number } | null; preStart: number;
    players: Map<string, { budget: number; bot: boolean; pub: { status: string; playerId: string } }>;
    tally: { total: number; wins: Record<string, number> } | null; schedule: { decl: { seat: number } }[]; result: { outcome: string } | null;
    fixed?: { contested: number; majority: number };
  };
  openCampaign(g: unknown): void; beginCounting(g: unknown): void; tick(): void;
};
const priv = () => t as unknown as Pre;
type Got = Array<Record<string, unknown>>;
const kinds = (got: Got, type: string) => got.filter(m => m.type === type) as Array<Record<string, unknown>>;

async function preGame(prep?: () => void) {
  t = new MockTransport();
  const { r } = await lobbyOf(t);
  const lobby = await t.getLobby(r.gameId, r.token);
  const used = new Set(lobby.players.map(p => p.party?.avatar));
  const avatar = AVATARS.find(a => !used.has(a.id))!.id;
  await t.setParty(r.gameId, r.token, { party: { name: 'Mine', colour: '#123456', symbol: 'torch', avatar } });
  prep?.();
  const got: Got = [];
  t.connect(r.gameId, r.token, m => got.push(m as never));
  await t.start(r.gameId, r.token);
  await new Promise(res => setTimeout(res, 60));
  const g = priv().g;
  const bots = [...g.players.values()].filter(p => p.bot && p.pub.status === 'active').map(p => p.pub.playerId);
  return { r, got, g, bots, me: g.me };
}
const send = (m: Record<string, unknown>) => t.send(m as never);
const ping = (ms = 60) => new Promise(res => setTimeout(res, ms));
const cfg = WORLD_CONFIG;

describe('mock transport pre-campaign', () => {
  it('3 players start in the pre-campaign with the whole budget, a real timer and no candidates yet', async () => {
    const { got, g, me } = await preGame();
    expect(g.status).toBe('preCampaign');
    expect(g.players.get(me)!.budget).toBe(cfg.budget);
    const tl = g.timeline!;
    expect(tl.preCampaignEnd! - Date.now()).toBeGreaterThan(0);
    expect(tl.preCampaignEnd! - Date.now()).toBeLessThan(10 * 60 * 1000);
    expect(tl.campaignStart).toBeGreaterThanOrEqual(tl.preCampaignEnd!);
    expect(kinds(got, 'status').at(-1)).toMatchObject({ status: 'preCampaign' });
    const hello = kinds(got, 'hello')[0] as unknown as { snapshot: { fielding: object; contestedSeats: number; majority: number } };
    expect(Object.keys(hello.snapshot.fielding)).toHaveLength(0);
    expect(hello.snapshot.contestedSeats).toBe(0);
  });

  it('field charges the configured price, answers with names, and tells everybody; a repeated clientRef is a duplicate', async () => {
    const { got, g, me } = await preGame();
    got.length = 0;
    send({ action: 'field', seats: [3, 4, 5], clientRef: 'a' });
    send({ action: 'field', seats: [3, 4, 5], clientRef: 'a' });
    send({ action: 'field', seats: [5, 6], clientRef: 'b' });
    await ping();
    const acks = kinds(got, 'fieldAck') as unknown as Array<{ budget: number; added: { seat: number; name?: string }[]; duplicate?: boolean }>;
    expect(acks[0].added.map(x => x.seat)).toEqual([3, 4, 5]);
    expect(acks[0].added.every(x => !!x.name)).toBe(true);
    expect(acks[0].budget).toBe(cfg.budget - 3 * cfg.costs.candidate);
    expect(acks[1].duplicate).toBe(true);
    expect(acks[2].added.map(x => x.seat)).toEqual([6]);
    expect(g.players.get(me)!.budget).toBe(cfg.budget - 4 * cfg.costs.candidate);
    const ups = kinds(got, 'fieldingUpdate') as unknown as Array<{ playerId: string; contestedSeats: number; majority: number }>;
    expect(ups).toHaveLength(2);
    expect(ups[1]).toMatchObject({ playerId: me, contestedSeats: 4, majority: majorityOf(4) });
  });

  it('withdraw refunds the price per seat, and field refuses a batch the budget cannot pay for', async () => {
    const { got, g, me } = await preGame();
    send({ action: 'field', seats: [3, 4] });
    await ping();
    got.length = 0;
    send({ action: 'withdraw', seats: [4, 9], clientRef: 'w' });
    await ping();
    expect(kinds(got, 'fieldAck')[0]).toMatchObject({ removed: [4], added: [], budget: cfg.budget - cfg.costs.candidate });
    g.players.get(me)!.budget = cfg.costs.candidate;
    send({ action: 'field', seats: [10, 11], clientRef: 'poor' });
    send({ action: 'field', seats: [99999], clientRef: 'bad' });
    await ping();
    expect(kinds(got, 'error').map(e => [e.clientRef, e.error])).toEqual([['poor', 'INSUFFICIENT_FUNDS'], ['bad', 'BAD_REQUEST']]);
    expect(g.players.get(me)!.budget).toBe(cfg.costs.candidate);
  });

  it('the bots field over the pre-campaign, paying for their candidates, so the counts move', async () => {
    const { got, g, bots } = await preGame();
    got.length = 0;
    g.preStart -= 10 * 60 * 1000; // pretend most of the phase has passed
    priv().tick();
    await ping();
    const ups = (kinds(got, 'fieldingUpdate') as unknown as Array<{ playerId: string; added: unknown[] }>);
    expect(new Set(ups.map(u => u.playerId))).toEqual(new Set(bots));
    for (const b of bots) {
      const held = [...g.fielding.values()].filter(l => l.some(c => c.playerId === b)).length;
      expect(held).toBeGreaterThan(0);
      expect(g.players.get(b)!.budget).toBe(cfg.budget - held * cfg.costs.candidate);
    }
  });

  it('actions, reports and peeks are refused until the campaign starts', async () => {
    const { got } = await preGame();
    got.length = 0;
    send({ action: 'campaign', type: 'rally', seat: 3, clientRef: 'r' });
    send({ action: 'campaign', type: 'minorRally', seat: 3, clientRef: 'm' });
    send({ action: 'buyReport', scope: 'global' });
    send({ action: 'peekSeat', seat: 3 });
    await ping();
    expect(kinds(got, 'error').map(e => e.error)).toEqual(['WRONG_PHASE', 'WRONG_PHASE', 'WRONG_PHASE', 'WRONG_PHASE']);
  });

  it('one-to-one chat is open (and a recipient is required)', async () => {
    const { got, g, bots } = await preGame();
    got.length = 0;
    send({ action: 'chat', text: 'shall we split the seats?', to: [bots[0]] });
    await ping(3500);
    const chat = (kinds(got, 'chat') as unknown as Array<{ message: { from: string; to: string[]; channel: string } }>).map(m => m.message);
    expect(chat[0]).toMatchObject({ from: g.me, to: [bots[0]], channel: 'direct' });
    expect(chat.some(m => m.from === bots[0])).toBe(true);
    send({ action: 'chat', text: 'anyone?' });
    await ping();
    expect(kinds(got, 'error').at(-1)?.error).toBe('BAD_REQUEST');
  });

  it('the deadline opens the campaign: majority and contested seats are fixed, and fielding is closed', async () => {
    const { r, got, g, bots } = await preGame();
    send({ action: 'field', seats: [1, 2, 3, 4, 5, 6] });
    g.fielding.set(7, [{ playerId: bots[0] }]);
    g.fielding.set(8, [{ playerId: bots[1] }]);
    await ping();
    got.length = 0;
    priv().openCampaign(g);
    await ping();
    expect(g.status).toBe('campaign');
    expect(g.fixed).toEqual({ contested: 8, majority: majorityOf(8) });
    expect(kinds(got, 'status').at(-1)).toMatchObject({ status: 'campaign' });
    got.length = 0;
    t.connect(r.gameId, r.token, m => got.push(m as never)); // a client joining now sees the fixed numbers
    await ping();
    expect(kinds(got, 'hello')[0]).toMatchObject({ snapshot: { status: 'campaign', contestedSeats: 8, majority: majorityOf(8) } });
    got.length = 0;
    send({ action: 'field', seats: [20], clientRef: 'late' });
    send({ action: 'withdraw', seats: [1], clientRef: 'late2' });
    await ping();
    expect(kinds(got, 'error').map(e => e.error)).toEqual(['WRONG_PHASE', 'WRONG_PHASE']);
    // later fielding changes (a player who is out) do not move the majority
    expect(g.fixed!.majority).toBe(majorityOf(8));
  });

  it('a party with no candidate at the deadline is eliminated, stays connected and can no longer act', async () => {
    const { got, g, bots, me } = await preGame();
    g.fielding.set(1, [{ playerId: bots[0] }, { playerId: bots[1] }]);
    g.fielding.set(2, [{ playerId: bots[0] }]);
    got.length = 0;
    priv().openCampaign(g);
    await ping();
    expect(g.players.get(me)!.pub.status).toBe('eliminated');
    const players = (kinds(got, 'players').at(-1) as unknown as { players: { playerId: string; status: string }[] }).players;
    expect(players.find(p => p.playerId === me)?.status).toBe('eliminated');
    expect(g.status).toBe('campaign'); // two parties remain
    got.length = 0;
    send({ action: 'campaign', type: 'roadshow', seat: 1, clientRef: 'x' });
    send({ action: 'chat', text: 'still here', to: [bots[0]] });
    await ping();
    expect(kinds(got, 'error').find(e => e.clientRef === 'x')?.error).toBe('FORBIDDEN');
    expect(kinds(got, 'chat').some(m => (m.message as { from: string }).from === me)).toBe(true);
  });

  it('with fewer than two parties left the game ends with no government', async () => {
    const { got, g, me } = await preGame();
    send({ action: 'field', seats: [1, 2] });
    await ping();
    got.length = 0;
    priv().openCampaign(g); // the two bots fielded nothing: only I remain
    await ping();
    expect(g.status).toBe('finished');
    expect(g.result!.outcome).toBe('noGovernment');
    expect(kinds(got, 'result')).toHaveLength(1);
    void me;
  });

  it('a minor rally costs the configured price, has no cooldown, and is neither news nor a cooldown for major rallies', async () => {
    const { got, g, me } = await preGame();
    send({ action: 'field', seats: [1, 2, 3] });
    g.fielding.set(9, [{ playerId: [...g.players.keys()].find(k => k !== me)! }]);
    await ping();
    priv().openCampaign(g);
    (t as unknown as { g: { nextBotRally: number } }).g.nextBotRally = Infinity;
    const before = g.players.get(me)!.budget;
    got.length = 0;
    send({ action: 'campaign', type: 'minorRally', seat: 1, clientRef: 'a' });
    send({ action: 'campaign', type: 'minorRally', seat: 2, clientRef: 'b' });
    send({ action: 'campaign', type: 'rally', seat: 3, clientRef: 'c' });
    send({ action: 'campaign', type: 'minorRally', seat: 9, clientRef: 'd' });
    await ping();
    expect(kinds(got, 'actionAck')).toHaveLength(3);
    expect(g.players.get(me)!.budget).toBe(before - 2 * cfg.costs.minorRally - cfg.costs.rally);
    expect(kinds(got, 'error').map(e => [e.clientRef, e.error])).toEqual([['d', 'NOT_FIELDED']]); // seat 9 is not mine
    expect(kinds(got, 'news')).toHaveLength(1); // the major rally only
  });

  it('counting skips vacant seats: the tally total and the schedule cover contested seats only', async () => {
    const { g, bots } = await preGame();
    send({ action: 'field', seats: [1, 2, 3] });
    g.fielding.set(4, [{ playerId: bots[0] }]);
    await ping();
    priv().openCampaign(g);
    priv().beginCounting(g);
    expect(g.tally!.total).toBe(4);
    expect(new Set(g.schedule.map(e => e.decl.seat))).toEqual(new Set([1, 2, 3, 4]));
  });

  it('2 players skip the pre-campaign: every seat is fielded and charged, and the campaign starts on the fully fielded budget', async () => {
    const { r, got, g, me } = await preGame(() => {
      const gg = (t as unknown as { g: Pre['g'] }).g;
      for (const p of gg.players.values()) if (p.bot && p.pub.status === 'active' && p.pub.playerId !== [...gg.players.keys()][1]) p.pub.status = 'rejected';
    });
    got.length = 0;
    t.connect(r.gameId, r.token, m => got.push(m as never));
    await ping();
    expect(g.status).toBe('campaign');
    expect(g.timeline!.preCampaignEnd).toBeUndefined();
    expect(g.fielding.size).toBe(g.seatIds.length);
    for (const list of g.fielding.values()) expect(list).toHaveLength(2);
    expect(g.players.get(me)!.budget).toBe(cfg.budget - g.seatIds.length * cfg.costs.candidate);
    expect(g.players.get(me)!.budget).toBe(fullyFieldedBudget({ ...cfg, seatCount: g.seatIds.length }));
    const hello = kinds(got, 'hello')[0] as unknown as { snapshot: { contestedSeats: number; majority: number }; private: { budget: number } };
    expect(hello.snapshot.contestedSeats).toBe(g.seatIds.length);
    expect(hello.snapshot.majority).toBe(majorityOf(g.seatIds.length));
    expect(hello.private.budget).toBe(g.players.get(me)!.budget);
  });
});

// ---- Done fielding (3 or more players)
// Rule: like the real server, "Done fielding" is refused while you have no candidate (BAD_REQUEST) and outside the pre-campaign
// (WRONG_PHASE), is public (fieldingDone with doneCount of needed, and in the snapshot), can be taken back, and is cleared by
// fielding or withdrawing. The bots press it a few seconds apart once they have finished fielding. When every active player is
// done the campaign opens at once on the same path as the deadline, with the whole timeline moved earlier by the time saved.
describe('mock transport Done fielding', () => {
  type Done = {
    g: Pre['g'] & { fieldingDone: Set<string>; nextBotDone: number; botPlans: Map<string, number[]>; nextBotRally: number;
      timeline: { preCampaignEnd?: number; campaignStart: number; phaseCloses: number[]; campaignEnd: number; countingEnd: number; postCountingEnd: number } };
  };
  const dg = () => (t as unknown as Done).g;
  const doneMsgs = (got: Got) => kinds(got, 'fieldingDone') as unknown as Array<{ playerId: string; done: boolean; doneCount: number; needed: number }>;
  /** Lets the bots field everything they plan (the phase is far enough along) and press Done, as fast as the spacing allows. */
  async function botsFinish(g: Done['g'], bots: string[]) {
    g.preStart -= 10 * 60 * 1000;
    for (let i = 0; i < 12 && !bots.every(b => g.fieldingDone.has(b)); i++) { g.nextBotDone = 0; priv().tick(); }
    await ping();
  }

  it('is refused with BAD_REQUEST while you have no candidate and nothing is broadcast', async () => {
    const { got } = await preGame();
    got.length = 0;
    send({ action: 'doneFielding', clientRef: 'd0' });
    await ping();
    expect(kinds(got, 'error').map(e => [e.clientRef, e.error])).toEqual([['d0', 'BAD_REQUEST']]);
    expect(doneMsgs(got)).toHaveLength(0);
  });

  it('is refused with WRONG_PHASE once the campaign has opened', async () => {
    const { got, g } = await preGame();
    send({ action: 'field', seats: [1] });
    await ping();
    priv().openCampaign(g);
    got.length = 0;
    send({ action: 'doneFielding', clientRef: 'late' });
    await ping();
    expect(kinds(got, 'error').map(e => [e.clientRef, e.error])).toEqual([['late', 'WRONG_PHASE']]);
  });

  it('pressing it tells everybody (1 of the active players) and the snapshot of a client joining lists you', async () => {
    const { r, got, me } = await preGame();
    send({ action: 'field', seats: [1, 2] });
    send({ action: 'doneFielding' });
    await ping();
    const active = [...dg().players.values()].filter(p => p.pub.status === 'active').length;
    expect(doneMsgs(got)).toEqual([{ type: 'fieldingDone', playerId: me, done: true, doneCount: 1, needed: active }]);
    got.length = 0;
    t.connect(r.gameId, r.token, m => got.push(m as never));
    await ping();
    expect(kinds(got, 'hello')[0]).toMatchObject({ snapshot: { fieldingDone: [me] } });
  });

  it('done:false takes it back, and pressing it twice says it once', async () => {
    const { got } = await preGame();
    send({ action: 'field', seats: [1] });
    send({ action: 'doneFielding' }); send({ action: 'doneFielding' }); send({ action: 'doneFielding', done: false });
    await ping();
    expect(doneMsgs(got).map(d => [d.done, d.doneCount])).toEqual([[true, 1], [false, 0]]);
  });

  it('fielding or withdrawing after Done clears it and tells everybody', async () => {
    const { got, me } = await preGame();
    send({ action: 'field', seats: [1, 2] });
    send({ action: 'doneFielding' });
    await ping();
    got.length = 0;
    send({ action: 'field', seats: [3] });
    await ping();
    expect(doneMsgs(got)).toEqual([expect.objectContaining({ playerId: me, done: false, doneCount: 0 })]);
    send({ action: 'doneFielding' });
    await ping();
    got.length = 0;
    send({ action: 'withdraw', seats: [3] });
    await ping();
    expect(doneMsgs(got).map(d => [d.playerId, d.done])).toEqual([[me, false]]);
    expect(dg().fieldingDone.has(me)).toBe(false);
  });

  it('the bots press it only after they have finished fielding, a few seconds apart', async () => {
    const { got, g, bots } = await preGame();
    got.length = 0;
    dg().nextBotDone = 0;
    priv().tick(); // the start of the phase: the bots have not finished
    await ping();
    expect(doneMsgs(got)).toHaveLength(0);
    g.preStart -= 10 * 60 * 1000;
    dg().nextBotDone = Infinity;
    priv().tick(); // now they field everything they plan
    await ping();
    expect(doneMsgs(got)).toHaveLength(0);
    dg().nextBotDone = 0;
    const before = Date.now();
    priv().tick();
    priv().tick(); // the second one is not due yet
    await ping();
    expect(doneMsgs(got)).toHaveLength(1);
    expect(bots).toContain(doneMsgs(got)[0].playerId);
    expect(dg().nextBotDone - before).toBeGreaterThanOrEqual(1500); // the next bot waits a few seconds
    for (const b of bots) expect([...g.fielding.values()].filter(l => l.some(c => c.playerId === b)).length).toBeGreaterThan(0);
  });

  it('a bot that is only part-way through its plan does not press it', async () => {
    const { got, g, bots } = await preGame();
    g.preStart -= 21_000; // about half of the fielding window has passed: the bots hold some candidates, not all
    got.length = 0;
    for (let i = 0; i < 4; i++) { dg().nextBotDone = 0; priv().tick(); }
    await ping();
    for (const b of bots) {
      const held = [...g.fielding.values()].filter(l => l.some(c => c.playerId === b)).length;
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThan(dg().botPlans.get(b)!.length);
    }
    expect(doneMsgs(got)).toHaveLength(0);
  });

  it('everybody done opens the campaign at once, with the whole timeline moved earlier by the time saved', async () => {
    const { got, g, bots } = await preGame();
    send({ action: 'field', seats: [1, 2, 3] });
    await ping();
    await botsFinish(dg(), bots);
    expect(g.status).toBe('preCampaign'); // I have not pressed Done
    const old = { ...dg().timeline, phaseCloses: [...dg().timeline.phaseCloses] };
    got.length = 0;
    send({ action: 'doneFielding' });
    await ping();
    expect(g.status).toBe('campaign');
    const nu = dg().timeline;
    expect(nu.preCampaignEnd!).toBeLessThanOrEqual(Date.now() + 2100); // the mock clock runs ahead of the browser's
    expect(nu.campaignStart - nu.preCampaignEnd!).toBe(old.campaignStart - old.preCampaignEnd!); // the lead-in stays
    const saved = old.campaignStart - nu.campaignStart;
    expect(saved).toBeGreaterThan(0);
    expect(nu.campaignEnd - nu.campaignStart).toBe(old.campaignEnd - old.campaignStart); // a campaign of full length
    expect(nu.phaseCloses).toEqual(old.phaseCloses.map(c => c - saved));
    expect(nu.countingEnd).toBe(old.countingEnd - saved);
    expect(nu.postCountingEnd).toBe(old.postCountingEnd - saved);
    expect(kinds(got, 'status').at(-1)).toMatchObject({ status: 'campaign', timeline: nu });
    expect(g.fixed).toBeTruthy();
    expect(dg().fieldingDone.size).toBe(0); // cleared when the campaign opens
    got.length = 0;
    send({ action: 'doneFielding', clientRef: 'again' });
    await ping();
    expect(kinds(got, 'error').map(e => e.error)).toEqual(['WRONG_PHASE']);
  });

  it('the last bot to press it can be the one that opens the campaign', async () => {
    const { g, bots } = await preGame();
    send({ action: 'field', seats: [1, 2] });
    send({ action: 'doneFielding' });
    await ping();
    expect(g.status).toBe('preCampaign');
    await botsFinish(dg(), bots);
    expect(g.status).toBe('campaign');
  });

  it('while any active player is not done the campaign does not open', async () => {
    const { g, bots } = await preGame();
    send({ action: 'field', seats: [1, 2] });
    send({ action: 'doneFielding' });
    await ping();
    g.preStart -= 10 * 60 * 1000;
    priv().tick();
    for (const b of bots.slice(0, -1)) dg().fieldingDone.add(b); // all but one bot
    dg().nextBotDone = Infinity; // the last one never gets to press it
    for (let i = 0; i < 5; i++) priv().tick();
    expect(g.status).toBe('preCampaign');
  });

  it('the deadline still ends the phase when somebody never pressed it', async () => {
    const { g } = await preGame();
    send({ action: 'field', seats: [1, 2] });
    send({ action: 'doneFielding' });
    await ping();
    dg().timeline.preCampaignEnd = Date.now() - 1;
    priv().tick();
    expect(g.status).toBe('campaign');
  });
});
