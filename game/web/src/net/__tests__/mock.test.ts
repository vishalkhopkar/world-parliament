import { afterEach, describe, expect, it } from 'vitest';
import { AVATARS, WORLD_CONFIG } from '@hp/shared';
import type { GlobalReports } from '@hp/shared';
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

  it('chat is refused in the campaign unless messaging.opensAt is campaign', async () => {
    const { g, got } = await inGame();
    g.status = 'campaign';
    (g as unknown as { cfg: { messaging: { opensAt: string } } }).cfg = { ...(g as never as { cfg: object }).cfg, messaging: { mode: 'group', opensAt: 'counting' } } as never;
    t.send({ action: 'chat', to: [], text: 'hi' } as never);
    await settle();
    expect(got.find(m => m.type === 'error')?.error).toBe('WRONG_PHASE');
    got.length = 0;
    (g as unknown as { cfg: { messaging: { opensAt: string } } }).cfg.messaging.opensAt = 'campaign';
    t.send({ action: 'chat', to: [], text: 'hi' } as never);
    await settle();
    expect(got.find(m => m.type === 'chat')).toBeTruthy();
  });
});

// ---- campaign: rally cooldown (same rule as the real server) and the Gaussian reputation
describe('mock transport rally cooldown', () => {
  async function inCampaign() {
    const x = await inGame();
    const g = x.g as unknown as { status: string; timeline: unknown; seatPhase: Map<number, number>; seatIds: number[]; players: Map<string, { budget: number }>; me: string; cfg: { cooldowns: { rallyMs: number } }; nextBotRally: number };
    const now = Date.now() + 2000;
    g.status = 'campaign';
    g.timeline = { campaignStart: now - 1000, phaseCloses: [now + 1e7, now + 2e7], campaignEnd: now + 2e7, countingEnd: now + 3e7, postCountingEnd: now + 4e7 };
    g.seatIds = [1, 2, 3];
    for (const s of g.seatIds) g.seatPhase.set(s, 0);
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
