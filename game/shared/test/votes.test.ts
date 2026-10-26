import { describe, expect, it } from 'vitest';
import {
  buildKernels, buildTimeline, computeEffects, createRng, expectedSeatShares, pollSeats, removePlayerFromResults, seatShares, tallySeats,
} from '../src';
import { expectedShareArray } from '../src/engine/votes';
import type { Committed, Effects } from '../src';
import type { SeatResult } from '../src';
import { NO_COMMITTED, PURE_CFG, T0, TEST_CFG, act, testMap } from './helpers';

const map = testMap();
const cfg = TEST_CFG;
const kernels = buildKernels(map, cfg);
const tl = buildTimeline(cfg, 1, T0);
const idx = (id: number) => kernels.index.get(id) as number;

function effectsOf(spec: Record<string, number[]>): Effects {
  // spec[player] = effect per seat id 1..8
  const e: Effects = new Map();
  for (const [p, arr] of Object.entries(spec)) e.set(p, Float64Array.from(arr));
  return e;
}

/** Rng that replays fixed draws, then throws (so a wrong draw order or count fails loudly). */
function stub(...draws: number[]): () => number {
  let k = 0;
  return () => { if (k >= draws.length) throw new Error(`rng exhausted after ${draws.length} draws`); return draws[k++]; };
}
const committedOf = (spec: Record<string, number[]>): Committed => new Map(Object.entries(spec).map(([p, a]) => [p, Float64Array.from(a)]));
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const at1 = (v: number) => [v, 0, 0, 0, 0, 0, 0, 0]; // a value in seat 1 only

describe('pollSeats', () => {
  const P3 = ['A', 'B', 'C'];
  it('shares sum to 1, FPTP winner is the highest share', () => {
    const e = computeEffects(
      [act('A', 'roadshow', 1, T0), act('B', 'rally', 1, T0), act('C', 'rally', 4, T0)], kernels, cfg, tl, map, 1,
    );
    const res = pollSeats(e, NO_COMMITTED, P3, kernels, cfg, [1, 2, 3, 4], 0, createRng('x'));
    expect(res).toHaveLength(4);
    for (const r of res) {
      expect(r.phase).toBe(0);
      expect(sum(r.shares)).toBeCloseTo(1, 9);
      const max = Math.max(...Object.values(r.shares));
      expect(r.shares[r.winner as string]).toBe(max);
    }
    expect(res[0].winner).toBe('A'); // 1.5 vs 1.01 vs ~0.01
    expect(res[3].winner).toBe('C');
  });

  it("designer's worked example: 5 parties, committed A 20% / D 10%, reputations 1:5:7:3:11", () => {
    // Draws (seat 1): I_A = 0.05*40% = 2%, I_D = 0.025*40% = 1%, R = 0.16*(5% x 5 parties) = 4%, weights .1 .1 .2 .3 .3, no tie draw.
    // S0 = 70 points. extra_A = 20*2% = 0.4, extra_D = 10*1% = 0.1, random = 4% of 70 = 2.8 -> .28 .28 .56 .84 .84.
    // pool = 70 - 0.4 - 0.1 - 2.8 = 66.7, split 1:5:7:3:11 (sum 27) -> 2.4704 12.3519 17.2926 7.4111 27.1741.
    // A = 20+0.4+0.28+2.4704 = 23.1504, B = 12.6319, C = 17.8526, D = 10+0.1+0.84+7.4111 = 18.3511, E = 0.84+27.1741 = 28.0141 (sum 100).
    const players = ['A', 'B', 'C', 'D', 'E'];
    const e = effectsOf({ A: at1(1), B: at1(5), C: at1(7), D: at1(3), E: at1(11) });
    const c = committedOf({ A: at1(0.2), D: at1(0.1) });
    const res = pollSeats(e, c, players, kernels, cfg, [1], 0, stub(0.05, 0.025, 0.16, 0.1, 0.1, 0.2, 0.3, 0.3))[0];
    const want = { A: 23.15037, B: 12.631852, C: 17.852593, D: 18.351111, E: 28.014074 };
    for (const [p, v] of Object.entries(want)) expect(res.shares[p] * 100).toBeCloseTo(v, 4);
    expect(sum(res.shares)).toBeCloseTo(1, 12);
    expect(res.winner).toBe('E');
  });

  it('no reputation anywhere: the pool is split by fresh random weights (draw order I, R, w, v)', () => {
    const c = committedOf({ A: at1(0.5) });
    // draws: I_A = 0, R = 0, w = .3 .3 .3 (irrelevant, r = 0), v = 0 .75 .25
    const r = pollSeats(new Map(), c, P3, kernels, cfg, [1], 0, stub(0, 0, 0.3, 0.3, 0.3, 0, 0.75, 0.25))[0];
    expect(r.shares.A).toBeCloseTo(0.5, 12);
    expect(r.shares.B).toBeCloseTo(0.5 * 0.75, 12);
    expect(r.shares.C).toBeCloseTo(0.5 * 0.25, 12);
    expect(r.winner).toBe('A'); // .5 vs .375 vs .125
  });

  it('a committed party without any reputation still gets at least its committed share', () => {
    const e = effectsOf({ B: at1(9) });
    const c = committedOf({ A: at1(0.3) });
    for (let s = 0; s < 100; s++) {
      const r = pollSeats(e, c, ['A', 'B'], kernels, cfg, [1], 0, createRng('c' + s))[0];
      expect(r.shares.A).toBeGreaterThanOrEqual(0.3 - 1e-12);
      expect(sum(r.shares)).toBeCloseTo(1, 12);
    }
  });

  it('a seat nobody has reputation in still has a winner and shares summing to 1', () => {
    for (let s = 0; s < 50; s++) {
      const r = pollSeats(new Map(), NO_COMMITTED, P3, kernels, cfg, [1, 5], 0, createRng('n' + s));
      for (const x of r) { expect(P3).toContain(x.winner); expect(sum(x.shares)).toBeCloseTo(1, 12); }
    }
  });

  it('influence and random voters are bounded: A (c=20%, no reputation) stays within 20%..28% + (5% x 2 parties) of the rest', () => {
    const e = effectsOf({ B: at1(1) });
    const c = committedOf({ A: at1(0.2) });
    for (let s = 0; s < 300; s++) {
      const a = pollSeats(e, c, ['A', 'B'], kernels, cfg, [1], 0, createRng('b' + s))[0].shares.A;
      expect(a).toBeGreaterThanOrEqual(0.2 - 1e-12);
      expect(a).toBeLessThanOrEqual(0.2 * 1.4 + 0.1 * 0.8 + 1e-9);
    }
  });

  it('overflow: when the extras do not fit in the uncommitted voters the pool is 0, never negative, shares still sum to 1', () => {
    // committed 45% + 45% (S0 = 10%), max influence draws (I ~ 40% -> extras 18+18 points > 10): extras are scaled to fit
    const c = committedOf({ A: at1(0.45), B: at1(0.45) });
    const e = effectsOf({ C: at1(5) });
    const r = pollSeats(e, c, P3, kernels, cfg, [1], 0, stub(0.999999, 0.999999, 0, 0.2, 0.2, 0.2, 0))[0]; // R = 0 -> r = 0; last draw breaks the A/B tie
    expect(sum(r.shares)).toBeCloseTo(1, 12);
    expect(r.shares.C).toBeCloseTo(0, 12); // the whole 10% went to the committed parties' extras
    expect(r.shares.A).toBeCloseTo(0.5, 9);
    expect(r.shares.B).toBeCloseTo(0.5, 9);
    // committed above 100% (should not happen): scaled down, still a valid result
    const over = committedOf({ A: at1(0.8), B: at1(0.8) });
    const r2 = pollSeats(new Map(), over, P3, kernels, cfg, [1], 0, createRng('o'))[0];
    expect(sum(r2.shares)).toBeCloseTo(1, 12);
    for (const v of Object.values(r2.shares)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('with no influence, no random voters and no committed voters the shares equal seatShares (the old ratio rule)', () => {
    const e = effectsOf({ A: [3, 1, 0, 0, 0, 0, 0, 0], B: [1, 3, 0, 0, 0, 0, 0, 0] });
    const res = pollSeats(e, NO_COMMITTED, ['A', 'B'], kernels, PURE_CFG, [1, 2], 0, createRng('p'));
    for (const r of res) for (const p of ['A', 'B']) expect(r.shares[p]).toBeCloseTo(seatShares(e, kernels, r.seat)[p], 12);
    expect(res[0].shares.A).toBeCloseTo(0.75, 12);
  });

  it('wins even by a tiny margin (no random voters)', () => {
    const e = effectsOf({ A: at1(1.0001), B: at1(1.0) });
    const res = pollSeats(e, NO_COMMITTED, ['A', 'B'], kernels, PURE_CFG, [1], 0, createRng('s'));
    expect(res[0].winner).toBe('A');
  });

  it('players outside `players` are ignored (effects and committed keys)', () => {
    const e = effectsOf({ A: at1(1), Z: at1(100) });
    const c = committedOf({ Z: at1(0.6) });
    const r = pollSeats(e, c, ['A', 'B'], kernels, PURE_CFG, [1], 0, createRng('i'))[0];
    expect(Object.keys(r.shares).sort()).toEqual(['A', 'B']);
    expect(r.shares.A).toBeCloseTo(1, 12);
  });

  it('is deterministic for the same seed and differs between seeds', () => {
    const e = effectsOf({ A: [1, 1, 1, 0, 0, 0, 0, 0], B: [1, 1, 1, 0, 0, 0, 0, 0] });
    const run = (seed: string) => pollSeats(e, NO_COMMITTED, ['A', 'B'], kernels, cfg, [1, 2, 3], 0, createRng(seed));
    expect(run('same')).toEqual(run('same'));
    expect(run('same')).not.toEqual(run('different'));
  });

  it('exact tie (no random voters) is broken at random but deterministically per seed, and both can win', () => {
    const e = effectsOf({ A: at1(1), B: at1(1) });
    const poll = (seed: string) => pollSeats(e, NO_COMMITTED, ['A', 'B'], kernels, PURE_CFG, [1], 0, createRng(seed))[0].winner;
    expect(poll('tie-1')).toBe(poll('tie-1'));
    const winners = new Set<string>();
    for (let i = 0; i < 40; i++) winners.add(poll(`t${i}`) as string);
    expect(winners).toEqual(new Set(['A', 'B']));
  });

  it('three-way tie picks only among leaders', () => {
    const e = effectsOf({ A: at1(1), B: at1(1), C: at1(0.5) });
    for (let i = 0; i < 30; i++) {
      const w = pollSeats(e, NO_COMMITTED, P3, kernels, PURE_CFG, [1], 0, createRng(`u${i}`))[0].winner;
      expect(['A', 'B']).toContain(w);
    }
  });

  it('unknown seat or no players -> winner null, empty shares; every other seat has a winner', () => {
    const e = effectsOf({ A: [0, 1, 0, 0, 0, 0, 0, 0] });
    const res = pollSeats(e, NO_COMMITTED, ['A'], kernels, cfg, [1, 2, 99], 2, createRng('n'));
    expect(res[0].winner).toBe('A'); // nobody has reputation in seat 1: still a winner (the only party)
    expect(res[1].winner).toBe('A');
    expect(res[1].shares.A).toBeCloseTo(1, 9);
    expect(res[2]).toEqual({ seat: 99, phase: 2, winner: null, shares: {} });
    expect(pollSeats(e, NO_COMMITTED, [], kernels, cfg, [1], 3, createRng('n'))[0]).toEqual({ seat: 1, phase: 3, winner: null, shares: {} });
  });
});

describe('expectedSeatShares', () => {
  it('is the worked example with every draw at its mean', () => {
    // I = 20% (mean of 0..40), R = 2.5% x 5 parties = 12.5% of S0, equal random weights, pool by reputation 1:5:7:3:11.
    const players = ['A', 'B', 'C', 'D', 'E'];
    const e = effectsOf({ A: at1(1), B: at1(5), C: at1(7), D: at1(3), E: at1(11) });
    const c = committedOf({ A: at1(0.2), D: at1(0.1) });
    const sh = expectedSeatShares(e, c, players, kernels, cfg, 1);
    // S0 = .7: extras .2*.2=.04, .1*.2=.02; r = .125*.7 = .0875 (.0175 each); pool = .7-.06-.0875 = .5525
    const pool = 0.5525;
    const rep: Record<string, number> = { A: 1, B: 5, C: 7, D: 3, E: 11 };
    const com: Record<string, number> = { A: 0.2, D: 0.1 };
    const ext: Record<string, number> = { A: 0.04, D: 0.02 };
    for (const p of players) expect(sh[p]).toBeCloseTo((com[p] ?? 0) + (ext[p] ?? 0) + 0.0175 + (pool * rep[p]) / 27, 12);
    expect(sum(sh)).toBeCloseTo(1, 12);
  });
  it('no reputation: the pool is split equally; unknown seat / no players -> {}', () => {
    const sh = expectedSeatShares(new Map(), NO_COMMITTED, ['A', 'B'], kernels, cfg, 3);
    expect(sh.A).toBeCloseTo(0.5, 12);
    expect(sh.B).toBeCloseTo(0.5, 12);
    expect(expectedSeatShares(new Map(), NO_COMMITTED, ['A'], kernels, cfg, 99)).toEqual({});
    expect(expectedSeatShares(new Map(), NO_COMMITTED, [], kernels, cfg, 1)).toEqual({});
  });
  it('pure config equals the reputation split', () => {
    const e = effectsOf({ A: at1(3), B: at1(1) });
    expect(expectedSeatShares(e, NO_COMMITTED, ['A', 'B'], kernels, PURE_CFG, 1).A).toBeCloseTo(0.75, 12);
  });
  it('matches the mean of many polls', () => {
    const e = effectsOf({ A: at1(3), B: at1(1) });
    const c = committedOf({ B: at1(0.3) });
    const rng = createRng('mean');
    let a = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) a += pollSeats(e, c, ['A', 'B'], kernels, cfg, [1], 0, rng)[0].shares.A;
    expect(a / N).toBeCloseTo(expectedSeatShares(e, c, ['A', 'B'], kernels, cfg, 1).A, 2);
  });
  it('expectedShareArray: the same shares in players order by seat index; [] out of range / no players', () => {
    const e = effectsOf({ A: at1(3), B: at1(1) });
    const c = committedOf({ B: at1(0.3) });
    const i = kernels.index.get(1) as number;
    const sh = expectedSeatShares(e, c, ['B', 'A'], kernels, cfg, 1);
    expect(expectedShareArray(e, c, ['B', 'A'], kernels, cfg, i)).toEqual([sh.B, sh.A]);
    expect(expectedShareArray(e, c, ['A'], kernels, cfg, kernels.n)).toEqual([]);
    expect(expectedShareArray(e, c, [], kernels, cfg, i)).toEqual([]);
  });
});

describe('removePlayerFromResults', () => {
  const results: SeatResult[] = [
    { seat: 1, phase: 0, winner: 'A', shares: { A: 0.5, B: 0.3, C: 0.2 } },
    { seat: 2, phase: 0, winner: 'B', shares: { A: 0.2, B: 0.5, C: 0.3 } },
    { seat: 3, phase: 0, winner: 'A', shares: { A: 1 } },
    { seat: 4, phase: 0, winner: null, shares: {} },
  ];
  it('renormalises, runner-up wins where eliminated player led', () => {
    const out = removePlayerFromResults(results, 'A');
    expect(out[0].winner).toBe('B');
    expect(out[0].shares).not.toHaveProperty('A');
    expect(out[0].shares.B).toBeCloseTo(0.6, 9);
    expect(out[0].shares.C).toBeCloseTo(0.4, 9);
    expect(out[1].winner).toBe('B');
    expect(out[1].shares.B).toBeCloseTo(0.5 / 0.8, 9);
    expect(out[2].winner).toBeNull();
    expect(out[2].shares).toEqual({});
    expect(out[3]).toEqual(results[3]);
    expect(tallySeats(out)).toEqual({ B: 2 });
  });
  it('does not mutate input and handles player absent from a seat', () => {
    const copy = JSON.parse(JSON.stringify(results));
    removePlayerFromResults(results, 'B');
    expect(results).toEqual(copy);
    const out = removePlayerFromResults(results, 'Z');
    expect(out).toEqual(results);
    for (const r of removePlayerFromResults(results, 'C')) {
      if (r.winner) expect(Object.values(r.shares).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    }
  });
});

describe('tallySeats', () => {
  it('counts winners and ignores null', () => {
    expect(
      tallySeats([
        { seat: 1, phase: 0, winner: 'A', shares: {} },
        { seat: 2, phase: 0, winner: 'A', shares: {} },
        { seat: 3, phase: 0, winner: 'B', shares: {} },
        { seat: 4, phase: 0, winner: null, shares: {} },
      ]),
    ).toEqual({ A: 2, B: 1 });
    expect(tallySeats([])).toEqual({});
  });
  it('idx helper sanity', () => {
    expect(idx(8)).toBe(7);
  });
});
