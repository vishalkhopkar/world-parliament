// Rule: a party that has no candidate in a seat gets no votes there. In a contested seat only that seat's candidates share the votes:
// the committed voters of the others go back to the pool, their reputation there does not count, and the random fraction is scaled by
// the number of candidates in the seat. A lone candidate gets 100 %. A seat with no candidates is vacant: no winner, no shares, no
// random draws. Without a contestants argument everybody contests every seat (the games with 2 players, and every older test).
import { describe, expect, it } from 'vitest';
import {
  analystReport, buildGlobalReports, buildKernels, buildTimeline, computeEffects, createRng, expectedSeatShares, newsTrueProjection, pollSeats,
} from '../src';
import { candidatesOf, expectedShareArray } from '../src/engine/votes';
import type { Committed, Effects, GlobalReportsInput, SeatContestants } from '../src';
import { NO_COMMITTED, PURE_CFG, T0, TEST_CFG, act, testMap } from './helpers';

const map = testMap();
const cfg = TEST_CFG; // influence 0-40 %, randomness 0-5 % per party
const kernels = buildKernels(map, cfg);
const tl = buildTimeline(cfg, 1, T0);
const idx = (id: number) => kernels.index.get(id) as number;

const effectsOf = (spec: Record<string, number[]>): Effects => new Map(Object.entries(spec).map(([p, a]) => [p, Float64Array.from(a)]));
const committedOf = (spec: Record<string, number[]>): Committed => new Map(Object.entries(spec).map(([p, a]) => [p, Float64Array.from(a)]));
const at1 = (v: number) => [v, 0, 0, 0, 0, 0, 0, 0]; // a value in seat 1 only
const who = (spec: Record<number, string[]>): SeatContestants => new Map(Object.entries(spec).map(([s, ps]) => [Number(s), new Set(ps)]));
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
/** Rng that replays fixed draws, then throws (so a wrong draw count fails loudly). */
function stub(...draws: number[]): () => number {
  let k = 0;
  return () => { if (k >= draws.length) throw new Error(`rng exhausted after ${draws.length} draws`); return draws[k++]; };
}

describe('candidatesOf', () => {
  it('without contestants every player stands in the seat', () => {
    expect(candidatesOf(['a', 'b'], undefined, 1)).toEqual(['a', 'b']);
  });
  it('keeps only the players standing in the seat, in players order', () => {
    expect(candidatesOf(['a', 'b', 'c'], who({ 1: ['c', 'a'] }), 1)).toEqual(['a', 'c']);
  });
  it('a seat missing from the contestants has no candidates', () => {
    expect(candidatesOf(['a', 'b'], who({ 1: ['a'] }), 2)).toEqual([]);
  });
});

describe('pollSeats with contestants', () => {
  const P3 = ['A', 'B', 'C'];

  it('everybody contesting every seat gives exactly the result and the rng draws of a call without contestants', () => {
    const e = effectsOf({ A: [1, 2, 0, 0, 0, 0, 0, 0], B: [3, 0, 1, 0, 0, 0, 0, 0], C: at1(0) });
    const c = committedOf({ A: at1(0.2), C: [0, 0.1, 0, 0, 0, 0, 0, 0] });
    const all = who({ 1: P3, 2: P3, 3: P3, 4: P3 });
    const seats = [1, 2, 3, 4];
    const plain = pollSeats(e, c, P3, kernels, cfg, seats, 0, createRng('same'));
    const rng = createRng('same');
    const withAll = pollSeats(e, c, P3, kernels, cfg, seats, 0, rng, all);
    expect(withAll).toEqual(plain);
    expect(rng()).toBe((() => { const r = createRng('same'); pollSeats(e, c, P3, kernels, cfg, seats, 0, r); return r(); })()); // same number of draws
  });

  it('only the candidates of a seat share its votes: shares of the others are left out and the seat sums to 1', () => {
    const e = effectsOf({ A: at1(1), B: at1(3), C: at1(50) });
    const res = pollSeats(e, NO_COMMITTED, P3, kernels, cfg, [1], 0, createRng('x'), who({ 1: ['A', 'B'] }))[0];
    expect(Object.keys(res.shares).sort()).toEqual(['A', 'B']);
    expect(sum(res.shares)).toBeCloseTo(1, 9);
    expect(res.winner).toBe('B');
  });

  it('the reputation of a party that is not a candidate in the seat does not count', () => {
    const e = effectsOf({ A: at1(1), B: at1(3), C: at1(1000) });
    const res = pollSeats(e, NO_COMMITTED, P3, kernels, PURE_CFG, [1], 0, createRng('x'), who({ 1: ['A', 'B'] }))[0];
    expect(res.shares.A).toBeCloseTo(0.25, 12);
    expect(res.shares.B).toBeCloseTo(0.75, 12);
  });

  it('the committed voters of a party that is not a candidate return to the pool and are split among the candidates by reputation', () => {
    const e = effectsOf({ A: at1(1), B: at1(3) });
    const c = committedOf({ C: at1(0.4) });
    const without = pollSeats(e, c, P3, kernels, PURE_CFG, [1], 0, createRng('x'), who({ 1: ['A', 'B'] }))[0];
    expect(without.shares.A).toBeCloseTo(0.25, 12); // not 0.6 x 0.25: C's 40 % went back to the pool
    expect(without.shares.B).toBeCloseTo(0.75, 12);
    const withC = pollSeats(e, c, P3, kernels, PURE_CFG, [1], 0, createRng('x'), who({ 1: P3 }))[0];
    expect(withC.shares.C).toBeCloseTo(0.4, 12); // when C does contest, its committed voters are its own
    expect(withC.shares.A).toBeCloseTo(0.6 * 0.25, 12);
  });

  it('a committed party that does contest keeps its committed voters and the others share the rest', () => {
    const e = effectsOf({ A: at1(1), B: at1(3) });
    const c = committedOf({ A: at1(0.2), C: at1(0.5) });
    const res = pollSeats(e, c, P3, kernels, PURE_CFG, [1], 0, createRng('x'), who({ 1: ['A', 'B'] }))[0];
    expect(res.shares.A).toBeCloseTo(0.2 + 0.8 * 0.25, 12);
    expect(res.shares.B).toBeCloseTo(0.8 * 0.75, 12);
  });

  it('the random fraction is scaled by the number of candidates of the seat, not of the game (R = rand x randomMax x 2)', () => {
    // seat 1: A, B contest, C does not. Draws: R = 0.5 -> 0.5 x 5 % x 2 = 5 %, weights 0.5 / 0.5 (no committed, so no influence draws).
    // Pool = 95 % split 1:3 -> A = 5 % x 0.5 + 95 % x 0.25 = 26.25 %.
    const e = effectsOf({ A: at1(1), B: at1(3), C: at1(1) });
    const res = pollSeats(e, NO_COMMITTED, P3, kernels, cfg, [1], 0, stub(0.5, 0.5, 0.5), who({ 1: ['A', 'B'] }))[0];
    expect(res.shares.A).toBeCloseTo(0.2625, 12);
    expect(res.shares.B).toBeCloseTo(0.7375, 12);
  });

  it('draws influence only for committed candidates, then R, then a weight per candidate (the usual order on the smaller party list)', () => {
    // A has committed 20 % -> I_A = 0.5 x 40 % = 20 % -> extra 4 %. R = 0 -> no random. Weights are drawn but unused; reputation exists.
    const e = effectsOf({ A: at1(1), B: at1(1), C: at1(9) });
    const c = committedOf({ A: at1(0.2), C: at1(0.3) });
    const res = pollSeats(e, c, P3, kernels, cfg, [1], 0, stub(0.5, 0, 0.3, 0.7), who({ 1: ['A', 'B'] }))[0];
    // S0 = 0.8; extra_A = 0.04; pool = 0.76 split 1:1
    expect(res.shares.A).toBeCloseTo(0.2 + 0.04 + 0.38, 12);
    expect(res.shares.B).toBeCloseTo(0.38, 12);
  });

  it('a lone candidate wins with 100 % whatever the others have, and uses no random draw', () => {
    const e = effectsOf({ A: at1(1), B: at1(100) });
    const c = committedOf({ B: at1(0.9), A: at1(0.1) });
    const res = pollSeats(e, c, ['A', 'B'], kernels, cfg, [1], 2, stub(), who({ 1: ['A'] }))[0];
    expect(res).toEqual({ seat: 1, phase: 2, winner: 'A', shares: { A: 1 } });
  });

  it('a lone candidate without any reputation or voters still wins with 100 %', () => {
    const res = pollSeats(new Map(), NO_COMMITTED, P3, kernels, cfg, [5], 0, stub(), who({ 5: ['C'] }))[0];
    expect(res).toEqual({ seat: 5, phase: 0, winner: 'C', shares: { C: 1 } });
  });

  it('a seat with no candidates (missing from the map, or empty) is vacant: winner null, empty shares, no draws', () => {
    const e = effectsOf({ A: at1(1), B: at1(1) });
    const res = pollSeats(e, NO_COMMITTED, ['A', 'B'], kernels, cfg, [1, 2, 3], 1, stub(), who({ 2: [] }));
    expect(res).toEqual([
      { seat: 1, phase: 1, winner: null, shares: {} },
      { seat: 2, phase: 1, winner: null, shares: {} },
      { seat: 3, phase: 1, winner: null, shares: {} },
    ]);
  });

  it('candidates that are not among the players of the vote do not count: a seat with only such candidates is vacant', () => {
    const res = pollSeats(effectsOf({ A: at1(1) }), NO_COMMITTED, ['A'], kernels, cfg, [1], 0, stub(), who({ 1: ['Z'] }))[0];
    expect(res.winner).toBeNull();
    expect(res.shares).toEqual({});
  });

  it('vacant seats among contested ones do not disturb the draws of the others (they consume none)', () => {
    const e = effectsOf({ A: at1(1), B: at1(2) });
    const alone = pollSeats(e, NO_COMMITTED, ['A', 'B'], kernels, cfg, [1], 0, createRng('r'), who({ 1: ['A', 'B'] }));
    const mixed = pollSeats(e, NO_COMMITTED, ['A', 'B'], kernels, cfg, [3, 1, 4], 0, createRng('r'), who({ 1: ['A', 'B'] }));
    expect(mixed[1]).toEqual(alone[0]);
    expect(mixed[0].winner).toBeNull();
    expect(mixed[2].winner).toBeNull();
  });

  it('an unknown seat is still null, with or without contestants', () => {
    const res = pollSeats(new Map(), NO_COMMITTED, P3, kernels, cfg, [99], 0, stub(), who({ 99: P3 }))[0];
    expect(res).toEqual({ seat: 99, phase: 0, winner: null, shares: {} });
  });

  it('a tie between two candidates is broken at random among them only', () => {
    const e = effectsOf({ A: at1(1), B: at1(1), C: at1(1) });
    const winners = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const w = pollSeats(e, NO_COMMITTED, P3, kernels, PURE_CFG, [1], 0, createRng(`t${i}`), who({ 1: ['A', 'B'] }))[0].winner;
      winners.add(w as string);
    }
    expect([...winners].sort()).toEqual(['A', 'B']);
  });
});

describe('expectedShareArray / expectedSeatShares with contestants', () => {
  const P3 = ['A', 'B', 'C'];
  const e = effectsOf({ A: at1(1), B: at1(3), C: at1(50) });
  const c = committedOf({ C: at1(0.4) });

  it('without contestants nothing changes; with everybody contesting the array is identical', () => {
    const plain = expectedShareArray(e, c, P3, kernels, cfg, idx(1));
    expect(expectedShareArray(e, c, P3, kernels, cfg, idx(1), who({ 1: P3 }))).toEqual(plain);
    expect(expectedSeatShares(e, c, P3, kernels, cfg, 1, who({ 1: P3 }))).toEqual(expectedSeatShares(e, c, P3, kernels, cfg, 1));
  });

  it('gives a non-candidate 0 in players order, and the candidates the shares of the vote among themselves', () => {
    const sh = expectedShareArray(e, c, P3, kernels, cfg, idx(1), who({ 1: ['A', 'B'] }));
    expect(sh).toHaveLength(3);
    expect(sh[2]).toBe(0);
    expect(sh[0] + sh[1]).toBeCloseTo(1, 12);
    // the same as a game with only A and B (C's committed voters are in the pool, C's reputation is ignored)
    const two = expectedShareArray(e, NO_COMMITTED, ['A', 'B'], kernels, cfg, idx(1));
    expect(sh[0]).toBeCloseTo(two[0], 12);
    expect(sh[1]).toBeCloseTo(two[1], 12);
  });

  it('uses the number of candidates for the random fraction (the mean of R = randomMax x 2 / 2)', () => {
    // no committed, no influence: R = 2.5 % x 2 = 5 % of the votes, equal weights; pool 95 % split 1:3
    const sh = expectedShareArray(e, NO_COMMITTED, P3, kernels, cfg, idx(1), who({ 1: ['A', 'B'] }));
    expect(sh[0]).toBeCloseTo(0.05 * 0.5 + 0.95 * 0.25, 12);
  });

  it('a lone candidate has 1, a vacant seat all zeros, an unknown seat []', () => {
    expect(expectedShareArray(e, c, P3, kernels, cfg, idx(1), who({ 1: ['B'] }))).toEqual([0, 1, 0]);
    expect(expectedShareArray(e, c, P3, kernels, cfg, idx(1), who({}))).toEqual([0, 0, 0]);
    expect(expectedShareArray(e, c, P3, kernels, cfg, 99, who({ 1: P3 }))).toEqual([]);
  });

  it('expectedSeatShares has keys for the candidates only; nothing for a vacant seat', () => {
    expect(Object.keys(expectedSeatShares(e, c, P3, kernels, cfg, 1, who({ 1: ['A', 'B'] }))).sort()).toEqual(['A', 'B']);
    expect(expectedSeatShares(e, c, P3, kernels, cfg, 1, who({ 2: P3 }))).toEqual({});
  });

  it('matches the mean of many polls of the same contested seat', () => {
    const rng = createRng('mean-contested');
    const cont = who({ 1: ['A', 'B'] });
    let a = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) a += pollSeats(e, c, P3, kernels, cfg, [1], 0, rng, cont)[0].shares.A;
    expect(a / N).toBeCloseTo(expectedSeatShares(e, c, P3, kernels, cfg, 1, cont).A, 2);
  });
});

describe('analystReport with contestants', () => {
  const players = ['A', 'B', 'C'];
  const quiet = { ...cfg, analyst: { ...cfg.analyst, noise: 0 } };
  const actions = [act('A', 'roadshow', 1, T0 + 10_000), act('B', 'roadshow', 1, T0 + 20_000), act('C', 'roadshow', 1, T0 + 30_000)];
  const buy = T0 + 120_000;
  const run = (c: typeof cfg, scope: 'seat' | 'global', seat: number | undefined, contestants?: SeatContestants, decided = []) => {
    const eff = computeEffects(actions, kernels, c, tl, map, 1, { upTo: buy });
    return analystReport(eff, NO_COMMITTED, kernels, c, scope, seat, decided, players, buy, buy, 100, createRng('r'), contestants);
  };

  it('a seat report lists only the candidates of the seat, ranked, and their expected shares add up to 1', () => {
    const rep = run(quiet, 'seat', 1, who({ 1: ['B', 'C'] }));
    expect(rep.entries.map((x) => x.playerId).sort()).toEqual(['B', 'C']);
    expect(rep.entries.reduce((a, x) => a + x.estimate, 0)).toBeCloseTo(1, 9);
    expect(rep.entries[0].rank).toBe(1);
  });

  it('a seat report of a vacant seat has no entries', () => {
    expect(run(quiet, 'seat', 1, who({ 2: players })).entries).toEqual([]);
  });

  it('a seat report without contestants lists everybody, as before', () => {
    expect(run(quiet, 'seat', 1).entries).toHaveLength(3);
    expect(run(quiet, 'seat', 1, who({ 1: players })).entries).toEqual(run(quiet, 'seat', 1).entries);
  });

  it('a global report counts for each party only the seats it contests, and nothing for vacant seats', () => {
    // roadshows in seat 1 by A, B, C (C last, so highest). Seat 1 -> C. Seat 2 (1 km away, spill-over): A and B only -> B. Seat 3: A alone.
    // Seat 4 (334 km, no reputation): A and B tie, the earlier player A. Seat 5: C alone. Seats 6, 7, 8 are vacant (7 has spill-over: ignored).
    const cont = who({ 1: ['A', 'B', 'C'], 2: ['A', 'B'], 3: ['A'], 4: ['A', 'B'], 5: ['C'] });
    const est = Object.fromEntries(run(quiet, 'global', undefined, cont).entries.map((x) => [x.playerId, x.estimate]));
    expect(est).toEqual({ A: 2, B: 1, C: 2 });
  });

  it('a global report without contestants counts every seat, as before', () => {
    const est = Object.fromEntries(run(quiet, 'global', undefined).entries.map((x) => [x.playerId, x.estimate]));
    expect(est.A + est.B + est.C).toBe(8);
  });

  it('decided seats count their winner; a decided vacant seat counts for nobody', () => {
    const decided = [
      { seat: 1, phase: 0, winner: 'A', shares: { A: 1 } },
      { seat: 2, phase: 0, winner: null, shares: {} },
    ];
    const rep = run(quiet, 'global', undefined, who({ 1: ['A'], 2: [], 3: ['B'] }), decided as never);
    const est = Object.fromEntries(rep.entries.map((x) => [x.playerId, x.estimate]));
    expect(est).toEqual({ A: 1, B: 1, C: 0 });
  });
});

describe('news agencies with contestants', () => {
  const players = ['A', 'B', 'C'];
  const cont = who({ 1: ['B', 'C'], 2: ['B', 'C'], 3: ['B', 'C'], 4: ['B', 'C'], 5: ['C'], 6: ['C'] }); // seats 7 and 8 are vacant
  const input = (over: Partial<GlobalReportsInput> = {}): GlobalReportsInput => ({
    gameId: 'g1', secret: 'sec-1', cfg, map, kernels, timeline: tl, phases: 1,
    actions: [act('B', 'rally', 1, T0 + 40_000), act('C', 'roadshow', 5, T0 + 60_000)],
    players, committed: NO_COMMITTED, decided: [], now: tl.campaignEnd, ...over,
  });

  it('the true projection adds up to the contested seats and gives a non-candidate nothing', () => {
    const t = newsTrueProjection(input(), T0 + 300_000, cont);
    expect(t.A).toBe(0);
    expect(t.A + t.B + t.C).toBeCloseTo(6, 9);
    expect(t.C).toBeGreaterThan(2); // C is the only candidate in seats 5 and 6
  });

  it('without contestants the projection adds up to all seats, as before', () => {
    const t = newsTrueProjection(input(), T0 + 300_000);
    expect(t.A + t.B + t.C).toBeCloseTo(8, 9);
  });

  it('every agency starts at each seat split evenly among its candidates, which adds up to the contested seats', () => {
    const r = buildGlobalReports(input(), cont);
    for (const ag of r.agencies) {
      const first = ag.points[0].seats;
      expect(first.A).toBe(0);
      expect(first.B).toBeCloseTo(2, 9);
      expect(first.C).toBeCloseTo(4, 9);
    }
  });

  it('later points add up to the contested seats, and the ranges stay within them', () => {
    const r = buildGlobalReports(input(), cont);
    for (const ag of r.agencies) {
      for (const p of ag.points.slice(1)) expect(p.seats.A + p.seats.B + p.seats.C).toBeCloseTo(6, 6);
      for (const [lo, hi] of Object.values(ag.ranges)) { expect(lo).toBeGreaterThanOrEqual(0); expect(hi).toBeLessThanOrEqual(6); }
      expect(ag.ranges.A).toEqual([0, 0]);
    }
  });

  it('with no contestants given the report is the one of every party in every seat (start = seats / parties)', () => {
    const r = buildGlobalReports(input());
    expect(r.agencies[0].points[0].seats).toEqual({ A: 8 / 3, B: 8 / 3, C: 8 / 3 });
  });
});
