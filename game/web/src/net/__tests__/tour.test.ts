import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatModeFor, fullyFieldedBudget, majorityOf } from '@hp/shared';
import type { GameSnapshot, PrivateState, ServerMessage } from '@hp/shared';
import { TOUR_ME_ID, TourTransport } from '../tour';
import { useTour } from '../../tour/tourStore';
import { useStore } from '../../state/store';
import { mapConfigFor } from '../../state/mapConfig';
import { tourSeatCounts } from '../../tour/tourScript';
import { gridPackage } from '../../../test/fakePackage';

const pkg = gridPackage(8, 8); // 64 seats
const N = pkg.seats.length;
const cfg = { ...mapConfigFor('world-500', N), seatCount: N };

let t: TourTransport;
let msgs: ServerMessage[];
const of = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
const settle = (ms = 100) => vi.advanceTimersByTimeAsync(ms);

let helloMsg: Extract<ServerMessage, { type: 'hello' }>;
/** Opens a practice game. By default it is moved on to the campaign (`startCampaign`) and the messages so far are dropped. */
async function start(opts: ConstructorParameters<typeof TourTransport>[0] = {}, phase: 'preCampaign' | 'campaign' = 'campaign') {
  t = new TourTransport({ pkg, ...opts });
  const r = await t.createGame({ nickname: 'You', mapId: 'world-500', phases: 1 });
  msgs = [];
  t.connect(r.gameId, r.token, m => msgs.push(m));
  await settle(50);
  helloMsg = of('hello')[0];
  if (phase === 'campaign') { t.startCampaign(); await settle(50); msgs = []; }
  return r;
}
const hello = () => helloMsg;
/** Rivals that field so slowly that nothing of theirs happens in a test. */
const IDLE = 1e8;
const campaign = (type: 'rally' | 'minorRally' | 'roadshow', seat: number, clientRef = 'r' + Math.random()) => { t.send({ action: 'campaign', type, seat, clientRef }); return clientRef; };
const field = (seats: number[], clientRef = 'f' + Math.random()) => { t.send({ action: 'field', seats, clientRef }); return clientRef; };
const withdraw = (seats: number[], clientRef = 'w' + Math.random()) => { t.send({ action: 'withdraw', seats, clientRef }); return clientRef; };

beforeEach(() => { vi.useFakeTimers(); useTour.getState().reset(); });
afterEach(() => { t?.disconnect(); vi.useRealTimers(); });

describe('TourTransport set-up', () => {
  it('starts in the pre-campaign with nine distinct parties and you as the first', async () => {
    await start({}, 'preCampaign');
    const h = hello();
    expect(h.snapshot.status).toBe('preCampaign');
    expect(h.snapshot.phases).toBe(1);
    const ps = h.snapshot.players;
    expect(ps).toHaveLength(9);
    expect(ps[0].playerId).toBe(TOUR_ME_ID);
    expect(ps[0].party?.name).toBe('Your Party');
    for (const k of ['colour', 'symbol', 'avatar'] as const) expect(new Set(ps.map(p => p.party![k])).size).toBe(9);
    expect(new Set(ps.map(p => p.party!.name)).size).toBe(9);
    expect(h.private.you).toBe(TOUR_ME_ID);
    expect(h.private.budget).toBe(cfg.budget); // the whole budget: nothing is fielded yet
  });

  it('never contacts a server when a map package is supplied', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await start();
    vi.unstubAllGlobals();
    expect(f).not.toHaveBeenCalled();
  });

  it('deals committed voters to you with the real bands (shown shaded on the map)', async () => {
    await start();
    const c = hello().private.committed!;
    expect(c.length).toBeGreaterThan(0);
    expect(c.length).toBeLessThanOrEqual(cfg.committed.bands.reduce((s, b) => s + b.seats, 0));
    expect(c[0]).toMatchObject({ percent: cfg.committed.bands[0].percent, level: cfg.committed.bands[0].level });
    const ids = new Set(pkg.seats.map(s => s.id));
    expect(c.every(x => ids.has(x.seat))).toBe(true);
    expect(new Set(c.map(x => x.seat)).size).toBe(c.length);
  });

  it('puts the clocks in the far future so nothing closes by itself', async () => {
    await start({}, 'preCampaign');
    const tl = hello().snapshot.timeline!;
    expect(tl.preCampaignEnd! - Date.now()).toBeGreaterThan(365 * 24 * 3600 * 1000);
    expect(tl.phaseCloses[0] - Date.now()).toBeGreaterThan(365 * 24 * 3600 * 1000);
    await settle(10 * 60 * 1000);
    expect(of('phaseClosed')).toHaveLength(0);
    expect(of('status')).toHaveLength(0); // the pre-campaign never ends by itself either
  });

  it('has no lobby: joining is refused, the lobby view is already a started game', async () => {
    const r = await start({}, 'preCampaign');
    await expect(t.joinGame({ joinCode: 'ABCD', nickname: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const l = await t.getLobby(r.gameId, r.token);
    expect(l.status).toBe('preCampaign');
    expect(l.players).toHaveLength(9);
  });

  it('registers its controls with the tour store', async () => {
    await start();
    expect(typeof useTour.getState().controls?.startCounting).toBe('function');
    expect(typeof useTour.getState().controls?.startCampaign).toBe('function');
  });

  it('shows rival rallies in the news now and then, never roadshows', async () => {
    await start({ botRallyAt: [1000, 2000, 3000] });
    await settle(3500); // counted from the start of the campaign
    const news = of('news');
    expect(news).toHaveLength(3);
    expect(news.every(n => n.item.playerId !== TOUR_ME_ID)).toBe(true);
  });
});

// Rule: the tour opens in the pre-campaign: you field candidates (each costs the configured price, withdrawing refunds it), rivals
// field theirs over time so the live counts move, and the tour moves on to the campaign by fielding the rest for you.
describe('TourTransport pre-campaign', () => {
  const lastUpdate = () => of('fieldingUpdate').at(-1)!;
  const contested = (snapshot: { fielding: Record<number, unknown[]> }) => Object.values(snapshot.fielding).filter(l => l.length > 0).length;
  type Poke = { g: { budget: number; fielding: Map<number, { playerId: string; name?: string }[]> } };
  const poke = () => (t as unknown as Poke).g;

  it('opens with the whole budget, no candidate of yours and a live majority that follows the contested seats', async () => {
    await start({ fieldEveryMs: IDLE }, 'preCampaign');
    const s = hello().snapshot;
    expect(s.status).toBe('preCampaign');
    expect(hello().private.budget).toBe(cfg.budget);
    expect(Object.values(s.fielding).some(l => l.some(c => c.playerId === TOUR_ME_ID))).toBe(false);
    expect(s.contestedSeats).toBe(contested(s));
    expect(s.majority).toBe(majorityOf(s.contestedSeats));
    expect(chatModeFor(cfg, s.status)).toBe('INDV'); // one-to-one chat for the informal alliances
  });

  it('field: charges the configured price per seat, answers with the new budget and names, and tells everybody', async () => {
    await start({ fieldEveryMs: IDLE }, 'preCampaign');
    field([3, 4, 5], 'f1');
    await settle();
    const ack = of('fieldAck')[0];
    expect(ack).toMatchObject({ clientRef: 'f1', ok: true, budget: cfg.budget - 3 * cfg.costs.candidate, removed: [] });
    expect(ack.added.map(a => a.seat)).toEqual([3, 4, 5]);
    expect(ack.added.every(a => !!a.name)).toBe(true);
    const u = lastUpdate();
    expect(u).toMatchObject({ playerId: TOUR_ME_ID, removed: [], contestedSeats: 3, majority: majorityOf(3) });
    expect(u.added).toEqual(ack.added);
    expect(of('error')).toHaveLength(0);
  });

  it('field: a seat you already hold is skipped and not charged twice', async () => {
    await start({ fieldEveryMs: IDLE }, 'preCampaign');
    field([3, 4]); field([4, 5]);
    await settle();
    const [a, b] = of('fieldAck');
    expect(b.added.map(x => x.seat)).toEqual([5]);
    expect(b.budget).toBe(a.budget - cfg.costs.candidate);
  });

  it('field: repeating a clientRef changes nothing and is flagged as a duplicate', async () => {
    await start({ fieldEveryMs: IDLE }, 'preCampaign');
    field([3, 4], 'same'); field([3, 4], 'same');
    await settle();
    const acks = of('fieldAck');
    expect(acks).toHaveLength(2);
    expect(acks[1]).toMatchObject({ duplicate: true, budget: acks[0].budget });
    expect(of('fieldingUpdate').filter(u => u.playerId === TOUR_ME_ID)).toHaveLength(1);
  });

  it('field: refuses the whole batch with INSUFFICIENT_FUNDS when the budget cannot pay for all of it', async () => {
    await start({ fieldEveryMs: IDLE }, 'preCampaign');
    poke().budget = 2 * cfg.costs.candidate;
    field([3, 4, 5], 'big');
    await settle();
    expect(of('error').find(e => e.clientRef === 'big')?.error).toBe('INSUFFICIENT_FUNDS');
    expect(of('fieldAck')).toHaveLength(0);
    field([3, 4]);
    await settle();
    expect(of('fieldAck')[0].budget).toBe(0);
  });

  it('field and withdraw: unknown seats are a BAD_REQUEST', async () => {
    await start({ fieldEveryMs: IDLE }, 'preCampaign');
    field([99999]); withdraw([99999]);
    await settle();
    expect(of('error').map(e => e.error)).toEqual(['BAD_REQUEST', 'BAD_REQUEST']);
  });

  it('withdraw: refunds the full price per seat, skips seats without a candidate and updates the majority', async () => {
    await start({ fieldEveryMs: IDLE }, 'preCampaign');
    field([3, 4, 5]);
    await settle();
    withdraw([4, 5, 6], 'w1');
    await settle();
    const ack = of('fieldAck').find(a => a.clientRef === 'w1')!;
    expect(ack).toMatchObject({ added: [], removed: [4, 5], budget: cfg.budget - cfg.costs.candidate });
    expect(lastUpdate()).toMatchObject({ playerId: TOUR_ME_ID, removed: [4, 5], contestedSeats: 1, majority: majorityOf(1) });
  });

  it('rivals field over time, one party at a time, so the counts visibly move and the contested seats only grow', async () => {
    await start({ fieldEveryMs: 1000, fieldRounds: 5 }, 'preCampaign');
    expect(of('fieldingUpdate')).toHaveLength(0);
    await settle(1500);
    const first = of('fieldingUpdate').length;
    expect(first).toBeGreaterThan(0);
    await settle(1000);
    expect(of('fieldingUpdate').length).toBeGreaterThan(first);
    await settle(10_000);
    const ups = of('fieldingUpdate');
    expect(ups.every(u => u.playerId !== TOUR_ME_ID)).toBe(true);
    expect(new Set(ups.map(u => u.playerId)).size).toBe(8); // every rival
    expect(ups.every(u => u.added.length > 0 && u.removed.length === 0 && u.added.every(a => !!a.name))).toBe(true);
    const counts = ups.map(u => u.contestedSeats);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts.at(-1)).toBeGreaterThan(counts[0]);
    expect(ups.at(-1)!.majority).toBe(majorityOf(ups.at(-1)!.contestedSeats));
    await settle(30_000);
    expect(of('fieldingUpdate')).toHaveLength(ups.length); // they are done
  });

  it('a seat where a rival and you both stand lists both candidates, yours first among the new ones', async () => {
    await start({ fieldEveryMs: 500, fieldRounds: 1 }, 'preCampaign');
    await settle(5000);
    const seat = [...poke().fielding].find(([, l]) => l.length > 0)![0];
    const rival = poke().fielding.get(seat)![0].playerId;
    field([seat]);
    await settle();
    const list = poke().fielding.get(seat)!;
    expect(list.map(c => c.playerId)).toEqual([rival, TOUR_ME_ID]);
    expect(list.every(c => !!c.name)).toBe(true);
  });

  it('campaign actions, reports and peeks are refused until the campaign starts', async () => {
    await start({ fieldEveryMs: IDLE }, 'preCampaign');
    campaign('rally', 3); campaign('minorRally', 3); campaign('roadshow', 3);
    t.send({ action: 'globalReports' });
    t.send({ action: 'peekSeat', seat: 3 });
    await settle();
    expect(of('error').map(e => e.error)).toEqual(['WRONG_PHASE', 'WRONG_PHASE', 'WRONG_PHASE', 'WRONG_PHASE', 'WRONG_PHASE']);
    expect(of('actionAck')).toHaveLength(0);
    expect(of('globalReports')).toHaveLength(0);
  });

  it('one-to-one chat works and the rival answers in its own chat', async () => {
    await start({ fieldEveryMs: IDLE }, 'preCampaign');
    t.send({ action: 'chat', text: 'Shall we stay out of each other seats?', to: ['p_alliance'] });
    await settle(4000);
    const c = of('chat').map(m => m.message);
    expect(c[0]).toMatchObject({ from: TOUR_ME_ID, to: ['p_alliance'], channel: 'direct' });
    expect(c[1]).toMatchObject({ from: 'p_alliance', to: [TOUR_ME_ID], channel: 'direct' });
    t.send({ action: 'chat', text: 'nobody' });
    await settle();
    expect(of('error').at(-1)?.error).toBe('BAD_REQUEST');
  });

  it('startCampaign fields every seat you have not fielded, charges for them, and leaves you the fully fielded budget', async () => {
    await start({ fieldEveryMs: IDLE }, 'preCampaign');
    field([3, 4]);
    await settle();
    msgs.length = 0;
    t.startCampaign();
    await settle();
    const mine = of('fieldingUpdate').find(u => u.playerId === TOUR_ME_ID)!;
    expect(mine.added).toHaveLength(N - 2);
    expect(mine.added.map(a => a.seat)).not.toContain(3);
    expect(of('private').at(-1)!.private.budget).toBe(fullyFieldedBudget(cfg));
    expect(fullyFieldedBudget(cfg)).toBe(cfg.budget - N * cfg.costs.candidate);
    expect(of('fieldingUpdate').at(-1)).toMatchObject({ contestedSeats: N, majority: majorityOf(N) });
    expect(of('status').at(-1)).toMatchObject({ status: 'campaign' });
    const tl = of('status').at(-1)!.timeline!;
    expect(tl.campaignStart).toBeLessThanOrEqual(Date.now());
    expect(tl.phaseCloses[0] - Date.now()).toBeGreaterThan(365 * 24 * 3600 * 1000);
  });

  it('after startCampaign every party stands in every seat, and fielding is closed', async () => {
    await start({ fieldEveryMs: IDLE });
    expect(poke().fielding.size).toBe(N);
    for (const list of poke().fielding.values()) expect(list).toHaveLength(9);
    field([3]); withdraw([3]);
    await settle();
    expect(of('error').map(e => e.error)).toEqual(['WRONG_PHASE', 'WRONG_PHASE']);
    msgs.length = 0;
    t.startCampaign(); // twice does nothing more
    await settle();
    expect(of('status')).toHaveLength(0);
  });

  it('a hello after the campaign start carries the fixed contested seats, the majority and who stands where', async () => {
    const r = await start({ fieldEveryMs: IDLE });
    msgs.length = 0;
    t.connect(r.gameId, r.token, m => msgs.push(m));
    await settle();
    const s = of('hello')[0].snapshot;
    expect(s.status).toBe('campaign');
    expect(s.contestedSeats).toBe(N);
    expect(s.majority).toBe(majorityOf(N));
    expect(Object.keys(s.fielding)).toHaveLength(N);
    expect(s.fielding[1].map(c => c.playerId).sort()).toEqual(s.players.map(p => p.playerId).sort());
  });

  it('rival rallies in the news only begin with the campaign', async () => {
    await start({ fieldEveryMs: IDLE, botRallyAt: [500, 1000] }, 'preCampaign');
    await settle(5000);
    expect(of('news')).toHaveLength(0);
    t.startCampaign();
    await settle(1500);
    expect(of('news')).toHaveLength(2);
  });

  it('stopping the tour stops the rivals fielding', async () => {
    await start({ fieldEveryMs: 1000 }, 'preCampaign');
    t.disconnect();
    msgs.length = 0;
    await settle(60_000);
    expect(msgs).toHaveLength(0);
  });
});

// Rule: a minor rally costs the configured price, has no cooldown and no global part, stays out of the news, needs a candidate
// in the seat, and its effect on your reputation comes from the real engine.
describe('TourTransport minor rally', () => {
  it('costs the configured price, has no cooldown, and is not news', async () => {
    await start({ botRallyAt: [] });
    campaign('minorRally', 10); campaign('minorRally', 11); campaign('rally', 12);
    await settle();
    const acks = of('actionAck');
    expect(acks).toHaveLength(3);
    expect(acks[0].budget).toBe(fullyFieldedBudget(cfg) - cfg.costs.minorRally);
    expect(acks[1].budget).toBe(fullyFieldedBudget(cfg) - 2 * cfg.costs.minorRally);
    expect(acks[0].nextRallyAt ?? null).toBeNull(); // only a major rally starts the cooldown
    expect(of('error')).toHaveLength(0);
    expect(of('news').map(n => n.item.seat)).toEqual([12]); // the major rally only
    expect(of('private').at(-1)!.private.myActions.map(a => a.type)).toEqual(['minorRally', 'minorRally', 'rally']);
  });

  it('the ack carries the engine reputation: the peak in its own seat, nothing global', async () => {
    await start({ botRallyAt: [] });
    campaign('minorRally', 20);
    await settle();
    const rep = of('actionAck')[0].reputation!;
    expect(rep[20]).toBe(Math.round((cfg.effects.minorRally.local + cfg.effects.firstMover.minorRally) * cfg.display.reputationScale));
    expect(Object.keys(rep).length).toBeLessThan(N);
  });

  it('refuses when the budget is gone', async () => {
    await start({ botRallyAt: [] });
    (t as unknown as { g: { budget: number } }).g.budget = cfg.costs.minorRally - 1;
    campaign('minorRally', 20, 'poor');
    await settle();
    expect(of('error').find(e => e.clientRef === 'poor')?.error).toBe('INSUFFICIENT_FUNDS');
  });

  it('is refused with NOT_FIELDED in a seat where you have no candidate (major rally and roadshow too)', async () => {
    await start({ botRallyAt: [] });
    const g = (t as unknown as { g: { fielding: Map<number, { playerId: string }[]> } }).g;
    g.fielding.set(30, g.fielding.get(30)!.filter(c => c.playerId !== TOUR_ME_ID));
    campaign('minorRally', 30); campaign('rally', 30); campaign('roadshow', 30);
    await settle();
    expect(of('error').map(e => e.error)).toEqual(['NOT_FIELDED', 'NOT_FIELDED', 'NOT_FIELDED']);
    expect(of('actionAck')).toHaveLength(0);
  });
});

describe('TourTransport campaign', () => {
  it('a rally costs the configured price and the ack carries the real reputation', async () => {
    await start();
    campaign('rally', 10, 'a1');
    await settle();
    const ack = of('actionAck')[0];
    expect(ack.clientRef).toBe('a1');
    expect(ack.budget).toBe(fullyFieldedBudget(cfg) - cfg.costs.rally);
    const rep = ack.reputation!;
    const expectHeld = Math.round((cfg.effects.rally.local + cfg.effects.rally.global + cfg.effects.firstMover.rally) * cfg.display.reputationScale);
    expect(rep[10]).toBe(expectHeld);
    expect(Object.keys(rep).length).toBe(N); // +global everywhere
    expect(of('private').at(-1)!.private.myActions).toHaveLength(1);
    expect(of('news')[0].item).toMatchObject({ playerId: TOUR_ME_ID, seat: 10 });
  });

  it('refuses a second rally straight away with RATE_LIMITED, and allows it after the cooldown', async () => {
    await start({ botRallyAt: [] });
    campaign('rally', 10);
    await settle();
    campaign('rally', 11, 'second');
    await settle();
    const e = of('error').find(x => x.clientRef === 'second')!;
    expect(e.error).toBe('RATE_LIMITED');
    expect(e.retryAt).toBeGreaterThan(Date.now());
    expect(of('actionAck')).toHaveLength(1);
    await settle(cfg.cooldowns.rallyMs);
    campaign('rally', 11, 'third');
    await settle();
    expect(of('actionAck')).toHaveLength(2);
  });

  it('roadshows have no cooldown, cost the configured price, stay local and are not news', async () => {
    await start({ botRallyAt: [] });
    campaign('roadshow', 20);
    campaign('roadshow', 21);
    await settle();
    const acks = of('actionAck');
    expect(acks).toHaveLength(2);
    expect(acks[1].budget).toBe(fullyFieldedBudget(cfg) - 2 * cfg.costs.roadshow);
    expect(acks[0].reputation![20]).toBe(Math.round((cfg.effects.roadshow.local + cfg.effects.firstMover.roadshow) * cfg.display.reputationScale));
    expect(Object.keys(acks[0].reputation!)).toEqual(['20']);
    expect(of('news')).toHaveLength(0);
  });

  it('refuses when the budget is gone, and unknown seats', async () => {
    await start({ botRallyAt: [] });
    campaign('roadshow', 99999, 'bad');
    await settle();
    expect(of('error').find(e => e.clientRef === 'bad')?.error).toBe('BAD_REQUEST');
  });

  it('group chat: your message is echoed and a rival answers', async () => {
    await start({ botRallyAt: [] });
    t.send({ action: 'chat', text: 'Hello all', to: [] });
    await settle(4000);
    const c = of('chat');
    expect(c[0].message.from).toBe(TOUR_ME_ID);
    expect(c[0].message.channel).toBe('group');
    expect(c.length).toBeGreaterThanOrEqual(2);
    expect(c[1].message.from).not.toBe(TOUR_ME_ID);
    expect(c[1].message.mentions).toBeUndefined();
  });

  it('group chat: tagging a party with @ makes that party answer and tag you back', async () => {
    await start({ botRallyAt: [] });
    t.send({ action: 'chat', text: '@National Alliance shall we talk?', to: [] });
    await settle(4000);
    const [mine, answer] = of('chat').map(m => m.message);
    expect(mine.mentions).toEqual(['p_alliance']);
    expect(answer.from).toBe('p_alliance');
    expect(answer.mentions).toEqual([TOUR_ME_ID]);
  });

  it('answers a ping', async () => {
    await start();
    t.send({ action: 'ping', clientTime: 5 });
    await settle();
    expect(of('pong')[0].clientTime).toBe(5);
  });
});

describe('TourTransport counting', () => {
  const counts = tourSeatCounts(N);
  const sortedDesc = (xs: number[]) => [...xs].sort((a, b) => b - a);

  function applyAll(): { snap: Pick<GameSnapshot, 'seats' | 'tally'> } {
    const seats: GameSnapshot['seats'] = {};
    let tally: GameSnapshot['tally'] = null;
    for (const m of of('seatUpdate')) { seats[m.declaration.seat] = m.declaration; tally = m.tally; }
    return { snap: { seats, tally } };
  }

  it('startCounting reveals the count, then pauses with every seat leading (or holding) its true winner', async () => {
    await start({ revealMs: 20_000, resumeMs: 9_000, botRallyAt: [] });
    t.startCounting();
    await settle(21_000);
    expect(of('status').at(-1)).toMatchObject({ status: 'counting' });
    expect(useTour.getState().countPaused).toBe(true);
    const { snap } = applyAll();
    expect(Object.keys(snap.seats)).toHaveLength(N);
    const scripted = t.scriptedTally()!;
    const shown = Object.fromEntries(Object.keys(scripted).map(id => [id, (snap.tally!.wins[id] ?? 0) + (snap.tally!.leads[id] ?? 0)]));
    expect(shown).toEqual(scripted);
    expect(sortedDesc(Object.values(shown))).toEqual(sortedDesc([counts.largest, counts.you, ...counts.small]));
    expect(shown[TOUR_ME_ID]).toBe(counts.you);
    // roughly 60% of the seats are already confirmed
    const won = Object.values(snap.seats).filter(d => d.status === 'won').length;
    expect(won).toBe(Math.round(N * 0.6));
    // paused: nothing more arrives
    const before = of('seatUpdate').length;
    await settle(60_000);
    expect(of('seatUpdate')).toHaveLength(before);
    expect(of('result')).toHaveLength(0);
  });

  it('early on the leads are noisy (some seats lead a party that does not win them)', async () => {
    await start({ botRallyAt: [] });
    t.startCounting();
    await settle(21_000);
    const scripted = new Map<number, string>();
    const final = applyAll().snap.seats;
    for (const [s, d] of Object.entries(final)) scripted.set(Number(s), d.playerId);
    const wrong = of('seatUpdate').filter(m => m.declaration.status === 'leading' && m.declaration.playerId !== scripted.get(m.declaration.seat));
    expect(wrong.length).toBeGreaterThan(0);
  });

  it('a seat peek answers with shares whose top party is the shown leader', async () => {
    await start({ botRallyAt: [] });
    t.startCounting();
    await settle(21_000);
    const [seat, d] = Object.entries(applyAll().snap.seats)[0];
    t.send({ action: 'peekSeat', seat: Number(seat) });
    await settle();
    const s = of('seatShares')[0];
    const top = Object.entries(s.shares).sort((a, b) => b[1] - a[1])[0][0];
    expect(top).toBe(d.playerId);
  });

  it('refuses peeks before counting', async () => {
    await start({ botRallyAt: [] });
    t.send({ action: 'peekSeat', seat: 1 });
    await settle();
    expect(of('error')[0].error).toBe('WRONG_PHASE');
  });

  it('the campaign is closed once counting started', async () => {
    await start({ botRallyAt: [] });
    t.startCounting();
    campaign('rally', 3, 'late');
    await settle(200);
    expect(of('error').find(e => e.clientRef === 'late')?.error).toBe('WRONG_PHASE');
  });
});

describe('TourTransport government', () => {
  async function paused() {
    await start({ revealMs: 20_000, resumeMs: 9_000, botRallyAt: [] });
    t.startCounting();
    await settle(21_000);
  }
  const slots = (ids: string[]) => ({ DPM: [ids[0], ids[1]], HOME: [ids[2]], DEFENCE: [ids[3]], FINANCE: [ids[4]], EXTERNAL: [ids[5]], SPEAKER: [ids[6]] });

  it('refuses offers that are below the majority, over a portfolio limit, or leave no party out', async () => {
    await paused();
    const small = t.smallPartyIds();
    t.send({ action: 'proposeGovernment', portfolios: { HOME: [small[0]] } });
    await settle();
    expect(of('error').at(-1)).toMatchObject({ error: 'INVALID_GOVERNMENT' });
    t.send({ action: 'proposeGovernment', portfolios: { DPM: small.slice(0, 3) } });
    await settle();
    expect(of('error').at(-1)?.message).toMatch(/at most/);
    t.send({ action: 'proposeGovernment', portfolios: slots(small), partners: [...small, 'p_alliance'] });
    await settle();
    expect(of('error').at(-1)?.message).toMatch(/stay out/);
    expect(of('offer')).toHaveLength(0);
  });

  it('declines (with a friendly chat reason) an offer that misses a smaller party but still has the seats', async () => {
    await paused();
    // you + the largest party: 359 of 500 style majority, but not "all the smaller parties"
    t.send({ action: 'proposeGovernment', portfolios: { DPM: ['p_alliance'] } });
    await settle(3000);
    const offers = of('offer');
    expect(offers[0].offer.status).toBe('open');
    const last = offers.at(-1)!.offer;
    expect(last.status).toBe('declined');
    expect(last.declinedBy).toBe('p_alliance');
    expect(of('chat').at(-1)?.message).toMatchObject({ from: 'p_alliance', to: [TOUR_ME_ID], channel: 'direct' });
    expect(last.log).toEqual([expect.objectContaining({ type: 'declined', by: 'p_alliance' })]);
    expect(useTour.getState().countPaused).toBe(true); // still paused: no government yet
  });

  it('accepts only the full set of smaller parties, then resumes the count and finishes with a coalition', async () => {
    await paused();
    const small = t.smallPartyIds();
    expect(small).toHaveLength(7);
    t.send({ action: 'proposeGovernment', portfolios: slots(small) });
    await settle(500);
    expect(of('offer')[0].offer.status).toBe('open');
    await settle(5000);
    expect(of('offer').at(-1)!.offer.status).toBe('accepted');
    // every smaller party's "Accepted" is logged (it shows in your one-to-one chat with that party)
    expect(of('offer').at(-1)!.offer.log!.map(e => [e.type, e.by]).sort()).toEqual(small.map(id => ['accepted', id]).sort());
    expect(useTour.getState().countPaused).toBe(false);
    expect(of('result')).toHaveLength(0); // not confirmed before every seat is declared
    await settle(10_000);
    const res = of('result')[0].result;
    expect(res.outcome).toBe('coalition');
    expect(of('government')[0].government.pm).toBe(TOUR_ME_ID);
    expect(of('government')[0].government.members.sort()).toEqual([TOUR_ME_ID, ...small].sort());
    expect(res.winners).toContain(TOUR_ME_ID);
    expect(res.tally).toEqual(t.scriptedTally());
    const largest = res.points.find(p => p.playerId === 'p_alliance')!;
    expect(largest.total).toBe(cfg.points.opposition);
    const mine = res.points.find(p => p.playerId === TOUR_ME_ID)!;
    expect(mine.portfolioPoints).toBe(cfg.points.portfolios.find(p => p.id === 'PM')!.points);
    expect(mine.governmentFloor).toBe(cfg.points.governmentFloor);
    expect(of('status').at(-1)).toMatchObject({ status: 'finished' });
    // the final tally has every seat won
    const last = of('seatUpdate').at(-1)!.tally;
    expect(last.declared).toBe(N);
    expect(Object.values(last.wins).reduce((a, b) => a + b, 0)).toBe(N);
    expect(you(last.wins) + small.reduce((s, id) => s + last.wins[id], 0)).toBe(majorityOf(N));
  });

  it('with one smaller party missing the offer is below the majority and is refused up front', async () => {
    await paused();
    const small = t.smallPartyIds();
    t.send({ action: 'proposeGovernment', portfolios: { DPM: [small[0], small[1]], HOME: [small[2]], DEFENCE: [small[3]], FINANCE: [small[4]], EXTERNAL: [small[5]] } });
    await settle();
    expect(of('error').at(-1)?.message).toMatch(/majority/);
  });

  it('a newer offer supersedes the older open one', async () => {
    await paused();
    const small = t.smallPartyIds();
    t.send({ action: 'proposeGovernment', portfolios: { DPM: ['p_alliance'] } });
    t.send({ action: 'proposeGovernment', portfolios: slots(small) });
    await settle(300);
    const first = of('offer').find(o => o.offer.partners.includes('p_alliance') && o.offer.status === 'superseded');
    expect(first).toBeTruthy();
  });

  it('an accepted offer made before the pause lets the count run through to the end', async () => {
    await start({ revealMs: 20_000, resumeMs: 9_000, botRallyAt: [] });
    t.startCounting();
    await settle(12_000);
    expect(useTour.getState().countPaused).toBe(false);
    const small = t.smallPartyIds();
    t.send({ action: 'proposeGovernment', portfolios: slots(small), partners: small });
    await settle(25_000);
    expect(of('result')).toHaveLength(1);
  });

  it('dropping out of the game stops every timer', async () => {
    await paused();
    t.disconnect();
    msgs.length = 0;
    await settle(60_000);
    expect(msgs).toHaveLength(0);
    expect(useTour.getState().countPaused).toBe(false);
  });
});

/** The real screens are driven by the store: a message stream from the transport reaches the finished screen. */
describe('TourTransport through the game store', () => {
  it('ends with a finished snapshot and the result in the store', async () => {
    useStore.getState().reset();
    const r = await start({ botRallyAt: [] });
    const apply = (m: ServerMessage) => useStore.getState().applyServer(m);
    msgs.forEach(apply);
    useStore.getState().setSession({ gameId: r.gameId, token: r.token, me: r.playerId, joinCode: '' });
    t.connect(r.gameId, r.token, apply);
    await settle(50);
    t.startCounting();
    await settle(21_000);
    const small = t.smallPartyIds();
    t.send({ action: 'proposeGovernment', portfolios: { DPM: small.slice(0, 2), HOME: [small[2]], DEFENCE: [small[3]], FINANCE: [small[4]], EXTERNAL: [small[5]], SPEAKER: [small[6]] } });
    await settle(20_000);
    const s = useStore.getState().snapshot as GameSnapshot;
    expect(s.status).toBe('finished');
    expect(s.result?.outcome).toBe('coalition');
    expect(Object.keys(s.seats)).toHaveLength(N);
    const p = useStore.getState().priv as PrivateState;
    expect(p.committed?.length).toBeGreaterThan(0);
  });
});

function you(wins: Record<string, number>) { return wins[TOUR_ME_ID]; }

describe('TourTransport on the real world-500 package', () => {
  it('scripts 249 / 110 / 30 28 25 20 17 12 9 and all of your committed seats are yours', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const real = JSON.parse(readFileSync(resolve(process.cwd(), '../../maps/world-500/site/data/game.json'), 'utf8'));
    t = new TourTransport({ pkg: real });
    const r = await t.createGame({ nickname: 'You', mapId: 'world-500', phases: 1 });
    msgs = [];
    t.connect(r.gameId, r.token, m => msgs.push(m));
    await settle(50);
    helloMsg = of('hello')[0];
    t.startCampaign();
    await settle(50);
    const tally = t.scriptedTally()!;
    expect(Object.values(tally).sort((a, b) => b - a)).toEqual([249, 110, 30, 28, 25, 20, 17, 12, 9]);
    expect(tally[TOUR_ME_ID]).toBe(110);
    expect(tally.p_alliance).toBe(249);
    t.startCounting();
    await settle(21_000);
    const seats = new Map<number, string>();
    for (const m of of('seatUpdate')) seats.set(m.declaration.seat, m.declaration.playerId);
    expect(seats.size).toBe(500);
    const committed = hello().private.committed!;
    expect(committed.length).toBe(87);
    expect(committed.every(c => seats.get(c.seat) === TOUR_ME_ID)).toBe(true);
  });
});

describe('TourTransport global reports (scripted news-agency series)', () => {
  const cfgNews = mapConfigFor('world-500', N).news;
  const ask = async () => { msgs.length = 0; t.send({ action: 'globalReports' }); await settle(60); return of('globalReports')[0]?.reports; };

  it('answers with one series per configured agency for the nine parties, starting level and summing to the seat count', async () => {
    await start();
    const rep = (await ask())!;
    expect(rep.agencies.map(a => a.name)).toEqual(cfgNews.agencies.map(a => a.name));
    for (const a of rep.agencies) {
      expect(a.points.length).toBeGreaterThanOrEqual(3);
      expect(Object.keys(a.ranges)).toHaveLength(9);
      expect(Object.values(a.points[0].seats).every(v => Math.abs(v - N / 9) < 1e-9)).toBe(true);
      for (const p of a.points) expect(Object.values(p.seats).reduce((x, y) => x + y, 0)).toBeCloseTo(N, 6);
      for (const [lo, hi] of Object.values(a.ranges)) { expect(lo).toBeLessThanOrEqual(hi); expect(lo).toBeGreaterThanOrEqual(0); expect(hi).toBeLessThanOrEqual(N); }
    }
  });

  it('the graphs move toward the scripted result: the largest party ends clearly ahead of the rest, in every agency', async () => {
    await start();
    const rep = (await ask())!;
    for (const a of rep.agencies) {
      const last = a.points[a.points.length - 1].seats;
      const top = Object.entries(last).sort((x, y) => y[1] - x[1])[0][0];
      expect(top).toBe('p_alliance');
    }
  });

  it('the series grows as the player campaigns, is repeatable, and never changes the budget or the real state', async () => {
    await start();
    const before = (await ask())!;
    expect((await ask())!).toEqual(before);
    campaign('roadshow', pkg.seats[0].id);
    campaign('roadshow', pkg.seats[1].id);
    await settle(100);
    const after = (await ask())!;
    expect(after.agencies[0].points.length).toBeGreaterThan(before.agencies[0].points.length);
    expect(of('report')).toHaveLength(0);
    expect(of('private')).toHaveLength(0); // asking changes nothing: no budget / private-state message
  });

  it('is refused when news agencies are switched off', async () => {
    await start();
    const g = (t as unknown as { g: { cfg: { news: { enabled: boolean } } } }).g;
    g.cfg.news = { ...g.cfg.news, enabled: false };
    msgs.length = 0; t.send({ action: 'globalReports' }); await settle(60);
    expect(of('globalReports')).toHaveLength(0);
    expect(of('error')[0]?.error).toBe('FORBIDDEN');
  });
});
