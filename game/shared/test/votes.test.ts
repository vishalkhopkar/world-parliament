import { describe, expect, it } from 'vitest';
import {
  buildKernels, buildTimeline, computeEffects, createRng, pollSeats, removePlayerFromResults, tallySeats,
} from '../src';
import type { Effects } from '../src';
import type { SeatResult } from '../src';
import { T0, TEST_CFG, act, testMap } from './helpers';

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

describe('pollSeats', () => {
  it('shares sum to 1, FPTP winner is the highest share', () => {
    const e = computeEffects(
      [act('A', 'roadshow', 1, T0), act('B', 'rally', 1, T0), act('C', 'rally', 4, T0)], kernels, cfg, tl, map, 1,
    );
    const res = pollSeats(e, kernels, cfg, [1, 2, 3, 4], 0, createRng('x'));
    expect(res).toHaveLength(4);
    for (const r of res) {
      expect(r.phase).toBe(0);
      expect(Object.values(r.shares).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      const max = Math.max(...Object.values(r.shares));
      expect(r.shares[r.winner as string]).toBe(max);
    }
    expect(res[0].winner).toBe('A'); // 1.5 vs 1.01 vs ~0.01
    expect(res[3].winner).toBe('C');
  });

  it('wins even by a tiny margin (no swing)', () => {
    const c0 = { ...cfg, randomSwing: 0 };
    const e = effectsOf({ A: [1.0001, 0, 0, 0, 0, 0, 0, 0], B: [1.0, 0, 0, 0, 0, 0, 0, 0] });
    const res = pollSeats(e, kernels, c0, [1], 0, createRng('s'));
    expect(res[0].winner).toBe('A');
  });

  it('swing is bounded: share changes by at most ~swing relative', () => {
    const e = effectsOf({ A: [3, 1, 0, 0, 0, 0, 0, 0], B: [1, 3, 0, 0, 0, 0, 0, 0] });
    const rng = createRng('bounded');
    for (let t = 0; t < 200; t++) {
      const res = pollSeats(e, kernels, cfg, [1, 2], 0, rng);
      const a = res[0].shares.A;
      // raw 0.75 * (1 +/- 0.02), renormalised against 0.25 * (1 +/- 0.02)
      expect(a).toBeGreaterThan(0.75 * 0.98 / (0.75 * 0.98 + 0.25 * 1.02) - 1e-9);
      expect(a).toBeLessThan(0.75 * 1.02 / (0.75 * 1.02 + 0.25 * 0.98) + 1e-9);
      expect(res[0].shares.A + res[0].shares.B).toBeCloseTo(1, 9);
      expect(res[0].winner).toBe('A'); // 3:1 never flips with 2% swing
    }
  });

  it('is deterministic for the same seed and differs between seeds', () => {
    const e = effectsOf({ A: [1, 1, 1, 0, 0, 0, 0, 0], B: [1, 1, 1, 0, 0, 0, 0, 0] });
    const r1 = pollSeats(e, kernels, cfg, [1, 2, 3], 0, createRng('same'));
    const r2 = pollSeats(e, kernels, cfg, [1, 2, 3], 0, createRng('same'));
    const r3 = pollSeats(e, kernels, cfg, [1, 2, 3], 0, createRng('different'));
    expect(r1).toEqual(r2);
    expect(r1).not.toEqual(r3);
  });

  it('exact tie (no swing) is broken at random but deterministically per seed, and both can win', () => {
    const c0 = { ...cfg, randomSwing: 0 };
    const e = effectsOf({ A: [1, 0, 0, 0, 0, 0, 0, 0], B: [1, 0, 0, 0, 0, 0, 0, 0] });
    const first = pollSeats(e, kernels, c0, [1], 0, createRng('tie-1'))[0].winner;
    expect(pollSeats(e, kernels, c0, [1], 0, createRng('tie-1'))[0].winner).toBe(first);
    const winners = new Set<string>();
    for (let i = 0; i < 40; i++) winners.add(pollSeats(e, kernels, c0, [1], 0, createRng(`t${i}`))[0].winner as string);
    expect(winners).toEqual(new Set(['A', 'B']));
  });

  it('three-way tie picks only among leaders', () => {
    const c0 = { ...cfg, randomSwing: 0 };
    const e = effectsOf({ A: [1, 0, 0, 0, 0, 0, 0, 0], B: [1, 0, 0, 0, 0, 0, 0, 0], C: [0.5, 0, 0, 0, 0, 0, 0, 0] });
    for (let i = 0; i < 30; i++) {
      const w = pollSeats(e, kernels, c0, [1], 0, createRng(`u${i}`))[0].winner;
      expect(['A', 'B']).toContain(w);
    }
  });

  it('seat with no effect -> winner null, empty shares', () => {
    const e = effectsOf({ A: [0, 1, 0, 0, 0, 0, 0, 0] });
    const res = pollSeats(e, kernels, cfg, [1, 2], 2, createRng('n'));
    expect(res[0]).toEqual({ seat: 1, phase: 2, winner: null, shares: {} });
    expect(res[1].winner).toBe('A');
    expect(res[1].shares.A).toBeCloseTo(1, 9);
    expect(pollSeats(new Map(), kernels, cfg, [1], 0, createRng('n'))[0].winner).toBeNull();
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
