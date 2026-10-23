import { describe, expect, it } from 'vitest';
import type { Action, CoalitionOffer, FinalResult, Government, SeatResult } from '@hp/shared';
import type { GameRecord, PlayerRecord, Repo, StoredChat, StoredReport } from '../src/core/types';
import { MemoryRepo } from '../src/local/memoryRepo';
import { DynamoRepo, TTL_SECONDS } from '../src/aws/dynamoRepo';
import { FakeDdb } from './fakes/fakeDdb';

const NOW = 1_800_000_000_000;

interface Harness { repo: Repo; ddb?: FakeDdb }
const impls: [string, () => Harness][] = [
  ['MemoryRepo', () => ({ repo: new MemoryRepo() })],
  ['DynamoRepo(fake)', () => {
    const ddb = new FakeDdb();
    return { repo: new DynamoRepo(ddb as never, ddb.tableName, () => NOW), ddb };
  }],
];

const game = (id = 'g1', over: Partial<GameRecord> = {}): GameRecord => ({
  gameId: id, joinCode: `CODE-${id}`, mapId: 'test', phases: 3, status: 'lobby', admissionOpen: true, adminId: 'p0',
  createdAt: NOW, timeline: null, closedPhases: 0, revealedStep: 0, ...over,
});
const player = (id: string, over: Partial<PlayerRecord> = {}, gameId = 'g1'): PlayerRecord => ({
  gameId, playerId: id, nickname: `Nick ${id}`, tokenHash: `hash-${id}`, isAdmin: id === 'p0', status: 'active',
  budget: 1000, joinedAt: NOW, ...over,
});
const action = (id: string, playerId: string, ts: number, seat = 1): Action => ({ id, playerId, type: 'rally', seat, ts });
const report = (playerId: string, ts: number): StoredReport => ({
  playerId, ts, report: { scope: 'seat', seat: 3, asOf: ts - 10, purchasedAt: ts, price: 100, entries: [{ playerId, rank: 1, estimate: 0.4, margin: 0.05 }] },
});
const campaign = (repo: Repo, closed = 0) => repo.updateGame('g1', { status: 'campaign', closedPhases: closed });

async function seeded(h: Harness, n = 2, over: Partial<PlayerRecord> = {}) {
  await h.repo.createGame(game(), player('p0', over));
  for (let i = 1; i < n; i++) await h.repo.putPlayer(player(`p${i}`, over));
  return h;
}

describe.each(impls)('Repo contract: %s', (_name, make) => {
  it('creates a game with its admin, finds it by id and by join code', async () => {
    const { repo } = make();
    expect(await repo.getGame('g1')).toBeNull();
    expect(await repo.findGameByCode('CODE-g1')).toBeNull();
    await repo.createGame(game(), player('p0'));
    expect(await repo.getGame('g1')).toEqual(game());
    expect(await repo.findGameByCode('CODE-g1')).toEqual(game());
    expect(await repo.findGameByCode('NOPE')).toBeNull();
    expect(await repo.getPlayer('g1', 'p0')).toEqual(player('p0'));
    expect(await repo.getPlayer('g1', 'zzz')).toBeNull();
    // second game does not mix with the first
    await repo.createGame(game('g2'), player('q0', {}, 'g2'));
    expect((await repo.listPlayers('g1')).map((p) => p.playerId)).toEqual(['p0']);
    expect((await repo.findGameByCode('CODE-g2'))?.gameId).toBe('g2');
  });

  it('refuses to create the same game twice and keeps the original', async () => {
    const { repo } = make();
    await repo.createGame(game(), player('p0'));
    await expect(repo.createGame(game('g1', { mapId: 'other' }), player('p0'))).rejects.toThrow();
    expect((await repo.getGame('g1'))?.mapId).toBe('test');
  });

  it('updateGame: conditional equality, removal of attributes, null values', async () => {
    const { repo } = make();
    await repo.createGame(game('g1', { finalised: true }), player('p0'));
    expect(await repo.updateGame('g1', { status: 'campaign' }, { status: 'lobby' })).toBe(true);
    expect(await repo.updateGame('g1', { status: 'counting' }, { status: 'lobby' })).toBe(false);
    expect((await repo.getGame('g1'))?.status).toBe('campaign');
    expect(await repo.updateGame('g1', { finalised: undefined })).toBe(true);
    expect('finalised' in ((await repo.getGame('g1')) as object)).toBe(false);
    const tl = { campaignStart: 1, phaseCloses: [2, 3], campaignEnd: 3, countingEnd: 4, postCountingEnd: 5 };
    expect(await repo.updateGame('g1', { timeline: tl })).toBe(true);
    expect((await repo.getGame('g1'))?.timeline).toEqual(tl);
    expect(await repo.updateGame('g1', { timeline: null }, { timeline: tl })).toBe(true);
    expect((await repo.getGame('g1'))?.timeline).toBeNull();
    expect(await repo.updateGame('missing', { status: 'campaign' })).toBe(false);
    expect(await repo.updateGame('g1', { admissionOpen: false }, { admissionOpen: true, status: 'campaign' })).toBe(true);
    expect(await repo.updateGame('g1', { admissionOpen: true }, { admissionOpen: true, status: 'campaign' })).toBe(false);
  });

  it('conditions on a missing attribute (undefined) and round-trips committed + committedSeq', async () => {
    const { repo } = make();
    await repo.createGame(game(), player('p0'));
    expect(await repo.updateGame('g1', { committedSeq: 1 }, { status: 'lobby', committedSeq: undefined })).toBe(true);
    expect(await repo.updateGame('g1', { committedSeq: 2 }, { status: 'lobby', committedSeq: undefined })).toBe(false);
    expect(await repo.updateGame('g1', { committedSeq: 2 }, { status: 'lobby', committedSeq: 1 })).toBe(true);
    expect((await repo.getGame('g1'))?.committedSeq).toBe(2);
    const committed = { core: 3, seats: Array.from({ length: 87 }, (_, i) => ({ seat: i + 1, band: (i % 6) + 1 })) };
    expect(await repo.updatePlayer('g1', 'p0', { committed }, { committed: undefined })).toBe(true);
    expect(await repo.updatePlayer('g1', 'p0', { committed: { core: 1, seats: [] } }, { committed: undefined })).toBe(false);
    expect((await repo.getPlayer('g1', 'p0'))?.committed).toEqual(committed);
    expect((await repo.listPlayers('g1'))[0].committed).toEqual(committed);
  });

  it('markPhaseClosed only moves forward', async () => {
    const { repo } = make();
    await repo.createGame(game(), player('p0'));
    await repo.markPhaseClosed('g1', 2);
    expect((await repo.getGame('g1'))?.closedPhases).toBe(2);
    await repo.markPhaseClosed('g1', 1);
    await repo.markPhaseClosed('g1', 2);
    expect((await repo.getGame('g1'))?.closedPhases).toBe(2);
    await repo.markPhaseClosed('g1', 3);
    expect((await repo.getGame('g1'))?.closedPhases).toBe(3);
  });

  it('players: put, update (with and without condition), statuses, optional fields, list', async () => {
    const h = await seeded(make(), 3);
    const repo = h.repo;
    expect((await repo.listPlayers('g1')).map((p) => p.playerId).sort()).toEqual(['p0', 'p1', 'p2']);
    await repo.putPlayer(player('p1', { status: 'pending', budget: 0 }));
    expect((await repo.getPlayer('g1', 'p1'))?.status).toBe('pending');
    expect(await repo.updatePlayer('g1', 'p1', { status: 'active', budget: 500 }, { status: 'pending' })).toBe(true);
    expect(await repo.updatePlayer('g1', 'p1', { status: 'rejected' }, { status: 'pending' })).toBe(false);
    expect((await repo.getPlayer('g1', 'p1'))).toMatchObject({ status: 'active', budget: 500 });
    const party = { name: 'Greens', colour: '#00AA00', symbol: 'tree' };
    expect(await repo.updatePlayer('g1', 'p1', { party, connectionId: 'c1' })).toBe(true);
    expect((await repo.getPlayer('g1', 'p1'))).toMatchObject({ party, connectionId: 'c1' });
    expect(await repo.updatePlayer('g1', 'p1', { connectionId: undefined, disconnectedAt: NOW, graceSchedule: 'gs' })).toBe(true);
    const p = await repo.getPlayer('g1', 'p1');
    expect('connectionId' in (p as object)).toBe(false);
    expect(p).toMatchObject({ disconnectedAt: NOW, graceSchedule: 'gs', party });
    expect(await repo.updatePlayer('g1', 'nobody', { budget: 1 })).toBe(false);
    expect(await repo.getPlayer('g1', 'nobody')).toBeNull(); // an update must never create a player
  });

  it('putPlayer with undefined optional fields stores nothing for them', async () => {
    const { repo } = make();
    await repo.createGame(game(), player('p0'));
    await repo.putPlayer(player('p1', { connectionId: undefined, party: undefined }));
    const p = await repo.getPlayer('g1', 'p1');
    expect(p).toEqual(player('p1'));
  });

  it('connections: put, get, delete (idempotent)', async () => {
    const { repo } = make();
    expect(await repo.getConnection('c1')).toBeNull();
    await repo.putConnection({ connectionId: 'c1', gameId: 'g1', playerId: 'p1' });
    await repo.putConnection({ connectionId: 'c2', gameId: 'g1', playerId: 'p2', helloSent: true });
    expect(await repo.getConnection('c1')).toEqual({ connectionId: 'c1', gameId: 'g1', playerId: 'p1' });
    await repo.putConnection({ connectionId: 'c1', gameId: 'g1', playerId: 'p1', helloSent: true });
    expect((await repo.getConnection('c1'))?.helloSent).toBe(true);
    await repo.deleteConnection('c1');
    await repo.deleteConnection('c1');
    expect(await repo.getConnection('c1')).toBeNull();
    expect((await repo.getConnection('c2'))?.helloSent).toBe(true);
  });

  it('addAction: deducts budget, stores the action, lists in ts order', async () => {
    const h = await seeded(make());
    await campaign(h.repo);
    expect(await h.repo.addAction('g1', 'p0', 300, action('a2', 'p0', NOW + 20), 0)).toBe('ok');
    expect(await h.repo.addAction('g1', 'p1', 300, action('a1', 'p1', NOW + 10), 0)).toBe('ok');
    expect(await h.repo.addAction('g1', 'p0', 300, action('a3', 'p0', NOW + 30, 7), 0)).toBe('ok');
    expect((await h.repo.getPlayer('g1', 'p0'))?.budget).toBe(400);
    expect((await h.repo.getPlayer('g1', 'p1'))?.budget).toBe(700);
    const list = await h.repo.listActions('g1');
    expect(list.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
    expect(list[2]).toEqual(action('a3', 'p0', NOW + 30, 7));
    expect(await h.repo.listActions('other')).toEqual([]);
  });

  it('addAction: exact budget is allowed, insufficient funds leave no trace', async () => {
    const h = await seeded(make());
    await campaign(h.repo);
    expect(await h.repo.addAction('g1', 'p0', 1000, action('a1', 'p0', NOW + 1), 0)).toBe('ok');
    expect((await h.repo.getPlayer('g1', 'p0'))?.budget).toBe(0);
    expect(await h.repo.addAction('g1', 'p0', 1, action('a2', 'p0', NOW + 2), 0)).toBe('insufficient');
    expect(await h.repo.addAction('g1', 'p1', 1001, action('a3', 'p1', NOW + 3), 0)).toBe('insufficient');
    expect((await h.repo.getPlayer('g1', 'p1'))?.budget).toBe(1000);
    expect((await h.repo.listActions('g1')).map((a) => a.id)).toEqual(['a1']);
  });

  it('addAction: non-active players and unknown players are "insufficient"', async () => {
    const h = await seeded(make());
    await h.repo.putPlayer(player('p2', { status: 'eliminated' }));
    await h.repo.putPlayer(player('p3', { status: 'disconnected' }));
    await campaign(h.repo);
    expect(await h.repo.addAction('g1', 'p2', 1, action('a1', 'p2', NOW + 1), 0)).toBe('insufficient');
    expect(await h.repo.addAction('g1', 'p3', 1, action('a2', 'p3', NOW + 2), 0)).toBe('insufficient');
    expect(await h.repo.addAction('g1', 'ghost', 1, action('a3', 'ghost', NOW + 3), 0)).toBe('insufficient');
    expect(await h.repo.listActions('g1')).toEqual([]);
  });

  it('addAction: conflicts when the game is not in campaign or closedPhases differs', async () => {
    const h = await seeded(make());
    // lobby
    expect(await h.repo.addAction('g1', 'p0', 10, action('a1', 'p0', NOW + 1), 0)).toBe('conflict');
    await campaign(h.repo, 1);
    expect(await h.repo.addAction('g1', 'p0', 10, action('a2', 'p0', NOW + 2), 0)).toBe('conflict');
    expect(await h.repo.addAction('g1', 'p0', 10, action('a3', 'p0', NOW + 3), 1)).toBe('ok');
    await h.repo.markPhaseClosed('g1', 2);
    expect(await h.repo.addAction('g1', 'p0', 10, action('a4', 'p0', NOW + 4), 1)).toBe('conflict');
    await h.repo.updateGame('g1', { status: 'counting' });
    expect(await h.repo.addAction('g1', 'p0', 10, action('a5', 'p0', NOW + 5), 2)).toBe('conflict');
    expect((await h.repo.getPlayer('g1', 'p0'))?.budget).toBe(990);
    expect((await h.repo.listActions('g1')).map((a) => a.id)).toEqual(['a3']);
  });

  it('addAction: concurrent double-spend of the last funds -> exactly one succeeds', async () => {
    const h = await seeded(make(), 1, { budget: 1000 });
    await campaign(h.repo);
    const attempts = Array.from({ length: 6 }, (_, i) => h.repo.addAction('g1', 'p0', 600, action(`a${i}`, 'p0', NOW + i), 0));
    const res = await Promise.all(attempts);
    expect(res.filter((r) => r === 'ok')).toHaveLength(1);
    expect(res.filter((r) => r === 'insufficient')).toHaveLength(5);
    expect((await h.repo.getPlayer('g1', 'p0'))?.budget).toBe(400);
    expect(await h.repo.listActions('g1')).toHaveLength(1);
  });

  it('addAction: many concurrent spends never overdraw and match the stored actions', async () => {
    const h = await seeded(make(), 1, { budget: 1000 });
    await campaign(h.repo);
    const res = await Promise.all(Array.from({ length: 30 }, (_, i) => h.repo.addAction('g1', 'p0', 70, action(`a${i}`, 'p0', NOW + i), 0)));
    const ok = res.filter((r) => r === 'ok').length;
    expect(ok).toBe(14); // floor(1000 / 70)
    expect((await h.repo.getPlayer('g1', 'p0'))?.budget).toBe(1000 - 14 * 70);
    expect(await h.repo.listActions('g1')).toHaveLength(14);
  });

  it('addAction racing markPhaseClosed: an action is either accepted for the old phase count or conflicts, never lost', async () => {
    const h = await seeded(make(), 1);
    await campaign(h.repo);
    const [r] = await Promise.all([
      h.repo.addAction('g1', 'p0', 100, action('a1', 'p0', NOW + 1), 0),
      h.repo.markPhaseClosed('g1', 1),
    ]);
    const stored = await h.repo.listActions('g1');
    const budget = (await h.repo.getPlayer('g1', 'p0'))?.budget;
    if (r === 'ok') { expect(stored).toHaveLength(1); expect(budget).toBe(900); } else { expect(r).toBe('conflict'); expect(stored).toHaveLength(0); expect(budget).toBe(1000); }
  });

  it('addAction: re-using an action id for the same ts/player does not double-charge silently', async () => {
    const h = await seeded(make());
    await campaign(h.repo);
    expect(await h.repo.addAction('g1', 'p0', 100, action('a1', 'p0', NOW + 1), 0)).toBe('ok');
    const budgetAfterFirst = (await h.repo.getPlayer('g1', 'p0'))?.budget;
    // duplicate key: Dynamo rejects the transaction (attribute_not_exists); MemoryRepo has no such key => skip equivalence,
    // but the budget must never drop without a stored action.
    await h.repo.addAction('g1', 'p0', 100, action('a1', 'p0', NOW + 1), 0).catch(() => undefined);
    const stored = await h.repo.listActions('g1');
    const budget = (await h.repo.getPlayer('g1', 'p0'))?.budget as number;
    expect(budget).toBe(budgetAfterFirst! - (stored.length - 1) * 100);
  });

  it('reports: deduct budget, filtered per player, ordered by ts, same guards as actions', async () => {
    const h = await seeded(make());
    await campaign(h.repo);
    expect(await h.repo.addReport('g1', 'p0', 400, report('p0', NOW + 5), 0)).toBe('ok');
    expect(await h.repo.addReport('g1', 'p0', 400, report('p0', NOW + 9), 0)).toBe('ok');
    expect(await h.repo.addReport('g1', 'p0', 400, report('p0', NOW + 12), 0)).toBe('insufficient');
    expect(await h.repo.addReport('g1', 'p1', 100, report('p1', NOW + 7), 0)).toBe('ok');
    expect(await h.repo.addReport('g1', 'p1', 100, report('p1', NOW + 8), 3)).toBe('conflict');
    expect((await h.repo.listReports('g1', 'p0')).map((r) => r.ts)).toEqual([NOW + 5, NOW + 9]);
    expect((await h.repo.listReports('g1', 'p1')).map((r) => r.ts)).toEqual([NOW + 7]);
    expect(await h.repo.listReports('g1', 'nobody')).toEqual([]);
    expect((await h.repo.listReports('g1', 'p1'))[0]).toEqual(report('p1', NOW + 7));
    expect((await h.repo.getPlayer('g1', 'p0'))?.budget).toBe(200);
    expect((await h.repo.getPlayer('g1', 'p1'))?.budget).toBe(900);
    // reports do not leak into actions
    expect(await h.repo.listActions('g1')).toEqual([]);
  });

  it('seat results: stored, replaced on re-put, listed by seat number', async () => {
    const { repo } = make();
    await repo.createGame(game(), player('p0'));
    const r = (seat: number, winner: string | null = 'p0'): SeatResult => ({ seat, phase: 0, winner, shares: winner ? { p0: 0.6, p1: 0.4 } : {} });
    await repo.putSeatResults('g1', [r(10), r(2), r(1, null), r(500)]);
    expect((await repo.listSeatResults('g1')).map((x) => x.seat)).toEqual([1, 2, 10, 500]);
    await repo.putSeatResults('g1', [{ ...r(2), winner: 'p1' }]);
    const list = await repo.listSeatResults('g1');
    expect(list.find((x) => x.seat === 2)?.winner).toBe('p1');
    expect(list.find((x) => x.seat === 1)).toEqual(r(1, null));
    expect(list).toHaveLength(4);
  });

  it('seat results: 500 seats in one write (batching) come back complete', async () => {
    const { repo } = make();
    await repo.createGame(game(), player('p0'));
    const all = Array.from({ length: 500 }, (_, i): SeatResult => ({ seat: i + 1, phase: i % 3, winner: 'p0', shares: { p0: 1 } }));
    await repo.putSeatResults('g1', all);
    const list = await repo.listSeatResults('g1');
    expect(list).toHaveLength(500);
    expect(list.map((x) => x.seat)).toEqual(all.map((x) => x.seat));
  });

  it('count plan: put, replace, get', async () => {
    const { repo } = make();
    await repo.createGame(game(), player('p0'));
    expect(await repo.getCountPlan('g1')).toBeNull();
    const plan = {
      order: [3, 1, 2], steps: 3, intervalMs: 1000, startMs: NOW, seed: 'g1', winStart: 3,
      leadStep: { 1: 1, 2: 2, 3: 1 }, winStep: { 1: 3, 2: 3, 3: 3 }, noise: { start: 2, exponent: 2, epochSteps: 1 },
    };
    await repo.putCountPlan('g1', plan);
    expect(await repo.getCountPlan('g1')).toEqual(plan);
    await repo.putCountPlan('g1', { ...plan, winStart: 2 });
    expect((await repo.getCountPlan('g1'))?.winStart).toBe(2);
  });

  it('chat: stored and listed in time order, per game', async () => {
    const { repo } = make();
    await repo.createGame(game(), player('p0'));
    await repo.createGame(game('g2'), player('q0', {}, 'g2'));
    const m = (id: string, ts: number, text = id): StoredChat => ({ id, from: 'p0', to: ['p1'], text, ts });
    await repo.addChat('g1', m('c1', NOW + 1));
    await repo.addChat('g1', m('c2', NOW + 2));
    await repo.addChat('g1', m('c3', NOW + 3, 'ünïcode ✓'));
    await repo.addChat('g2', m('x1', NOW + 1));
    expect((await repo.listChat('g1')).map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect((await repo.listChat('g1'))[2]).toEqual(m('c3', NOW + 3, 'ünïcode ✓'));
    expect((await repo.listChat('g2')).map((c) => c.id)).toEqual(['x1']);
  });

  it('offers: put, overwrite (status change), get, list ordered by createdAt', async () => {
    const { repo } = make();
    await repo.createGame(game(), player('p0'));
    const o = (offerId: string, createdAt: number): CoalitionOffer => ({
      offerId, proposer: 'p0', portfolios: { PM: ['p0'], DPM: ['p1', 'p2'] }, partners: ['p1', 'p2'], accepted: [], status: 'open', createdAt,
    });
    await repo.putOffer('g1', o('zz', NOW + 1));
    await repo.putOffer('g1', o('aa', NOW + 3));
    await repo.putOffer('g1', o('mm', NOW + 2));
    expect((await repo.listOffers('g1')).map((x) => x.offerId)).toEqual(['zz', 'mm', 'aa']);
    await repo.putOffer('g1', { ...o('mm', NOW + 2), accepted: ['p1'], status: 'accepted' });
    expect(await repo.getOffer('g1', 'mm')).toMatchObject({ accepted: ['p1'], status: 'accepted', portfolios: { PM: ['p0'], DPM: ['p1', 'p2'] } });
    expect(await repo.getOffer('g1', 'none')).toBeNull();
    expect(await repo.listOffers('g1')).toHaveLength(3);
  });

  it('government: first writer wins, also under concurrency', async () => {
    const { repo } = make();
    await repo.createGame(game(), player('p0'));
    const g = (pm: string): Government => ({ pm, members: [pm], portfolios: { PM: [pm] }, formedAt: NOW, viaNegotiation: false });
    expect(await repo.getGovernment('g1')).toBeNull();
    expect(await repo.putGovernmentIfAbsent('g1', g('p0'))).toBe(true);
    expect(await repo.putGovernmentIfAbsent('g1', g('p1'))).toBe(false);
    expect((await repo.getGovernment('g1'))?.pm).toBe('p0');

    await repo.createGame(game('g2'), player('q0', {}, 'g2'));
    const res = await Promise.all(['a', 'b', 'c', 'd'].map((pm) => repo.putGovernmentIfAbsent('g2', g(pm))));
    expect(res.filter(Boolean)).toHaveLength(1);
    const winner = res.findIndex(Boolean);
    expect((await repo.getGovernment('g2'))?.pm).toBe(['a', 'b', 'c', 'd'][winner]);
  });

  it('final result: first writer wins, round-trips, null government', async () => {
    const { repo } = make();
    await repo.createGame(game(), player('p0'));
    const r = (winner: string): FinalResult => ({
      outcome: 'noGovernment', tally: { p0: 3, p1: 2 }, government: null, points: [{ playerId: 'p0', portfolioPoints: 0, seatPoints: 3, governmentFloor: 0, total: 3 }], winners: [winner],
    });
    expect(await repo.getResult('g1')).toBeNull();
    expect(await repo.putResultIfAbsent('g1', r('p0'))).toBe(true);
    expect(await repo.putResultIfAbsent('g1', r('p1'))).toBe(false);
    expect(await repo.getResult('g1')).toEqual(r('p0'));
  });

  it('government/offers/result of one game never leak into another', async () => {
    const { repo } = make();
    await repo.createGame(game(), player('p0'));
    await repo.createGame(game('g2'), player('q0', {}, 'g2'));
    await repo.putGovernmentIfAbsent('g1', { pm: 'p0', members: ['p0'], portfolios: {}, formedAt: 1, viaNegotiation: true });
    expect(await repo.getGovernment('g2')).toBeNull();
    expect(await repo.getResult('g2')).toBeNull();
    expect(await repo.listOffers('g2')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// DynamoDB-specific behaviour that has no MemoryRepo analogue
describe('DynamoRepo specifics (against FakeDdb)', () => {
  const mk = (opts: ConstructorParameters<typeof FakeDdb>[0] = {}) => {
    const ddb = new FakeDdb(opts);
    return { ddb, repo: new DynamoRepo(ddb as never, ddb.tableName, () => NOW) };
  };

  it('every written item carries a numeric ttl = now + 7 days, and metadata keys never leak to callers', async () => {
    const { ddb, repo } = mk();
    await repo.createGame(game(), player('p0'));
    await repo.putPlayer(player('p1'));
    await repo.updatePlayer('g1', 'p1', { budget: 5 });
    await repo.updateGame('g1', { status: 'campaign' });
    await repo.putConnection({ connectionId: 'c1', gameId: 'g1', playerId: 'p1' });
    await repo.addAction('g1', 'p0', 10, action('a1', 'p0', NOW + 1), 0);
    await repo.addReport('g1', 'p0', 10, report('p0', NOW + 2), 0);
    await repo.putSeatResults('g1', [{ seat: 1, phase: 0, winner: null, shares: {} }]);
    await repo.putCountPlan('g1', {
      order: [1], steps: 1, intervalMs: 1, startMs: 1, seed: 'g1', winStart: 1, leadStep: { 1: 1 }, winStep: { 1: 1 }, noise: { start: 0, exponent: 1, epochSteps: 1 },
    });
    await repo.addChat('g1', { id: 'c', from: 'p0', to: [], text: 't', ts: NOW });
    await repo.putOffer('g1', { offerId: 'o', proposer: 'p0', portfolios: {}, partners: [], accepted: [], status: 'open', createdAt: 1 });
    await repo.putGovernmentIfAbsent('g1', { pm: 'p0', members: ['p0'], portfolios: {}, formedAt: 1, viaNegotiation: false });
    await repo.putResultIfAbsent('g1', { outcome: 'draw', tally: {}, government: null, points: [], winners: [] });
    await repo.markPhaseClosed('g1', 1); // game was at closedPhases 0 and status campaign
    const items = ddb.all();
    expect(items.length).toBe(12);
    for (const it of items) expect(it.ttl, `${it.PK}/${it.SK}`).toBe(Math.floor(NOW / 1000) + TTL_SECONDS);
    // GSI keys only on META
    expect(items.filter((i) => i.GSI1PK).map((i) => i.SK)).toEqual(['META']);
    // reads strip PK/SK/GSI/ttl
    for (const r of [await repo.getGame('g1'), await repo.getPlayer('g1', 'p0'), await repo.getConnection('c1'), await repo.findGameByCode('CODE-g1')]) {
      for (const k of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'ttl']) expect(r).not.toHaveProperty(k);
    }
    for (const list of [await repo.listActions('g1'), await repo.listPlayers('g1'), await repo.listChat('g1')]) {
      for (const e of list) for (const k of ['PK', 'SK', 'ttl']) expect(e).not.toHaveProperty(k);
    }
  });

  it('chat/actions come back sorted by timestamp even when written out of order (MemoryRepo returns insertion order for chat)', async () => {
    const { repo } = mk();
    await repo.createGame(game(), player('p0'));
    for (const [id, ts] of [['c2', 2], ['c1', 1], ['c10', 10]] as const) await repo.addChat('g1', { id, from: 'p0', to: [], text: id, ts: NOW + ts });
    expect((await repo.listChat('g1')).map((c) => c.id)).toEqual(['c1', 'c2', 'c10']);
  });

  it('ttl is refreshed on update', async () => {
    let t = NOW;
    const ddb = new FakeDdb();
    const repo = new DynamoRepo(ddb as never, ddb.tableName, () => t);
    await repo.createGame(game(), player('p0'));
    t += 3_600_000;
    await repo.updateGame('g1', { status: 'campaign' });
    expect(ddb.get('GAME#g1', 'META')?.ttl).toBe(Math.floor(t / 1000) + TTL_SECONDS);
    expect(ddb.get('GAME#g1', 'PLAYER#p0')?.ttl).toBe(Math.floor(NOW / 1000) + TTL_SECONDS);
  });

  it('single-table layout: keys and ordering are as documented', async () => {
    const { ddb, repo } = mk();
    await repo.createGame(game(), player('p0'));
    await repo.updateGame('g1', { status: 'campaign' });
    await repo.addAction('g1', 'p0', 1, action('a1', 'p0', 42), 0);
    await repo.addReport('g1', 'p0', 1, report('p0', 43), 0);
    await repo.putSeatResults('g1', [{ seat: 7, phase: 0, winner: null, shares: {} }]);
    await repo.putConnection({ connectionId: 'cx', gameId: 'g1', playerId: 'p0' });
    const keys = ddb.all().map((i) => `${i.PK}|${i.SK}`).sort();
    expect(keys).toEqual([
      'CONN#cx|META',
      'GAME#g1|ACT#000000000000042#p0#a1',
      'GAME#g1|META',
      'GAME#g1|PLAYER#p0',
      expect.stringMatching(/^GAME#g1\|REP#p0#000000000000043#\d{6}[0-9a-f]{4}$/),
      'GAME#g1|SEAT#0007',
    ]);
    expect(ddb.get('GAME#g1', 'META')).toMatchObject({ GSI1PK: 'CODE#CODE-g1', GSI1SK: 'META' });
  });

  it('queries paginate transparently (tiny page size) and stay inside their partition/prefix', async () => {
    const { ddb, repo } = mk({ pageBytes: 400 });
    await repo.createGame(game(), player('p0'));
    await repo.createGame(game('g2'), player('q0', {}, 'g2'));
    for (let i = 0; i < 40; i++) await repo.addChat('g1', { id: `c${i}`, from: 'p0', to: [], text: 'x'.repeat(50), ts: NOW + i });
    await repo.addChat('g2', { id: 'other', from: 'q0', to: [], text: 'y', ts: NOW });
    const before = ddb.count('QueryCommand');
    const chat = await repo.listChat('g1');
    expect(chat).toHaveLength(40);
    expect(chat.map((c) => c.id)).toEqual(Array.from({ length: 40 }, (_, i) => `c${i}`));
    expect(ddb.count('QueryCommand') - before).toBeGreaterThan(5);
    expect((await repo.listPlayers('g1')).map((p) => p.playerId)).toEqual(['p0']);
  });

  it('500 seat results are fetched across several Query pages', async () => {
    const { ddb, repo } = mk({ pageBytes: 8 * 1024 });
    await repo.createGame(game(), player('p0'));
    await repo.putSeatResults('g1', Array.from({ length: 500 }, (_, i): SeatResult => ({ seat: i + 1, phase: 0, winner: 'p0', shares: { p0: 0.5, p1: 0.5 } })));
    const before = ddb.count('QueryCommand');
    expect(await repo.listSeatResults('g1')).toHaveLength(500);
    expect(ddb.count('QueryCommand') - before).toBeGreaterThan(1);
  });

  it('two reports bought by the same player in the same millisecond both persist (regression: sort-key collision)', async () => {
    const { repo } = mk();
    await repo.createGame(game(), player('p0'));
    await repo.updateGame('g1', { status: 'campaign' });
    expect(await repo.addReport('g1', 'p0', 10, report('p0', NOW), 0)).toBe('ok');
    expect(await repo.addReport('g1', 'p0', 10, { ...report('p0', NOW), report: { ...report('p0', NOW).report, scope: 'global' } }, 0)).toBe('ok');
    expect((await repo.listReports('g1', 'p0')).map((r) => r.report.scope)).toEqual(['seat', 'global']); // insertion order kept
    expect((await repo.getPlayer('g1', 'p0'))?.budget).toBe(980);
  });

  it('transaction cancellation reasons map to the right SpendResult', async () => {
    const { ddb, repo } = mk();
    await repo.createGame(game(), player('p0', { budget: 50 }));
    await repo.updateGame('g1', { status: 'campaign' });
    // reason[0] failed
    expect(await repo.addAction('g1', 'p0', 60, action('a', 'p0', NOW), 0)).toBe('insufficient');
    // reason[2] failed
    expect(await repo.addAction('g1', 'p0', 10, action('a', 'p0', NOW), 9)).toBe('conflict');
    // both failed -> insufficient takes priority (matches MemoryRepo ordering)
    expect(await repo.addAction('g1', 'p0', 60, action('a', 'p0', NOW), 9)).toBe('insufficient');
    expect(ddb.all().filter((i) => String(i.SK).startsWith('ACT#'))).toHaveLength(0);
  });

  it('unexpected transaction failures (duplicate action key) are rethrown, and nothing is charged', async () => {
    const { repo } = mk();
    await repo.createGame(game(), player('p0'));
    await repo.updateGame('g1', { status: 'campaign' });
    expect(await repo.addAction('g1', 'p0', 10, action('a', 'p0', NOW), 0)).toBe('ok');
    await expect(repo.addAction('g1', 'p0', 10, action('a', 'p0', NOW), 0)).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect((await repo.getPlayer('g1', 'p0'))?.budget).toBe(990);
  });

  it('non-conditional errors from DynamoDB are not swallowed', async () => {
    const ddb = new FakeDdb({ beforeSend: () => { throw Object.assign(new Error('slow down'), { name: 'ProvisionedThroughputExceededException' }); } });
    const repo = new DynamoRepo(ddb as never, ddb.tableName, () => NOW);
    await expect(repo.putGovernmentIfAbsent('g1', { pm: 'p', members: [], portfolios: {}, formedAt: 1, viaNegotiation: false })).rejects.toThrow('slow down');
    await expect(repo.updateGame('g1', { status: 'campaign' })).rejects.toThrow('slow down');
    await expect(repo.markPhaseClosed('g1', 1)).rejects.toThrow('slow down');
  });

  it('table name is passed to every command (wrong table -> ResourceNotFound)', async () => {
    const ddb = new FakeDdb({ tableName: 'right' });
    const repo = new DynamoRepo(ddb as never, 'wrong', () => NOW);
    await expect(repo.getGame('g1')).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
  });

  it('works with a client that does NOT strip undefined only if repo never sends undefined (strict marshalling)', async () => {
    const ddb = new FakeDdb({ removeUndefinedValues: false });
    const repo = new DynamoRepo(ddb as never, ddb.tableName, () => NOW);
    await repo.createGame(game(), player('p0'));
    // put with explicit undefined fields would throw in the real client without removeUndefinedValues (the factory sets it)
    await expect(repo.putPlayer(player('p1', { connectionId: undefined }))).rejects.toThrow(/removeUndefinedValues/);
  });
});
