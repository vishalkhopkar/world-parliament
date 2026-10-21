// Engine edge cases and invariants not covered by the focused suites: majority for every N, rng, schedule errors,
// kernel boundaries, effect determinism, polling properties, analyst corner cases, points properties.
import { describe, expect, it } from 'vitest';
import {
  AVATARS, DEFAULT_MAP_ID, MAP_CONFIGS, MAP_MANIFESTS, PARTY_COLOURS, PARTY_SYMBOLS, WORLD_CONFIG,
  analystPrice, analystReport, buildKernels, buildTimeline, computeEffects, countingMsFor, postCountingMsFor, configForMap, createRng, finalResult, governmentFromOffer,
  haversineKm, majorityGovernment, majorityOf, phaseOfSeat, pollSeats, removePlayerFromResults, seatShares, tallySeats, timeMultiplier,
  validateGovernment,
} from '../src';
import type { Action, CoalitionOffer, Effects, Government, SeatResult } from '../src';
import { decay } from '../src/engine/effects';
import { gaussian } from '../src/engine/rng';
import { T0, TEST_CFG, act, testMap } from './helpers';

const cfg = TEST_CFG;
const map = testMap();
const kernels = buildKernels(map, cfg);
const idx = (id: number) => kernels.index.get(id) as number;

// ================================================================== majority
describe('majorityOf', () => {
  it('= floor(N/2)+1 for N = 1..2000 (odd and even)', () => {
    for (let n = 1; n <= 2000; n++) expect(majorityOf(n)).toBe(Math.floor(n / 2) + 1);
  });
  it('is strictly more than half, minimal, and two disjoint groups can never both reach it', () => {
    for (let n = 1; n <= 600; n++) {
      const m = majorityOf(n);
      expect(m * 2).toBeGreaterThan(n);          // strictly more than half
      expect((m - 1) * 2).toBeLessThanOrEqual(n); // one fewer is not a majority
      expect(m + m).toBeGreaterThan(n);          // two majorities cannot be disjoint
      expect(m).toBeLessThanOrEqual(n);
    }
  });
  it('known values', () => {
    for (const [n, m] of [[1, 1], [2, 2], [3, 2], [4, 3], [5, 3], [6, 4], [7, 4], [8, 5], [499, 250], [500, 251], [501, 251]]) expect(majorityOf(n)).toBe(m);
  });
});

// ================================================================== rng
describe('createRng / gaussian', () => {
  it('is reproducible, string-seeded, and different seeds differ (including near-identical and empty seeds)', () => {
    const seq = (s: string) => { const r = createRng(s); return Array.from({ length: 8 }, () => r()); };
    expect(seq('a')).toEqual(seq('a'));
    expect(seq('a')).not.toEqual(seq('b'));
    expect(seq('game1:poll:0')).not.toEqual(seq('game1:poll:1'));
    expect(seq('')).not.toEqual(seq(' '));
    expect(seq('é')).toEqual(seq('é'));
  });
  it('stays strictly inside [0,1) over 100k draws', () => {
    const r = createRng('range');
    for (let i = 0; i < 100_000; i++) { const x = r(); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });
  it('independent generators do not share state', () => {
    const a = createRng('s');
    const b = createRng('s');
    a(); a(); a();
    expect(createRng('s')()).toBe(b());
  });
  it('gaussian: finite, mean ~0, std ~1, symmetric tails', () => {
    const r = createRng('g');
    const xs = Array.from({ length: 40_000 }, () => gaussian(r));
    expect(xs.every(Number.isFinite)).toBe(true);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(sd).toBeGreaterThan(0.97);
    expect(sd).toBeLessThan(1.03);
    expect(Math.abs(xs.filter((x) => x > 2).length - xs.filter((x) => x < -2).length)).toBeLessThan(300);
  });
  it('gaussian survives an rng that returns exactly 0 (log of 0 is avoided)', () => {
    expect(Number.isFinite(gaussian(() => 0))).toBe(true);
  });
});

// ================================================================== schedule
describe('buildTimeline / phaseOfSeat', () => {
  it.each([[0], [-1], [1.5], [Number.NaN], [Infinity]])('rejects %s phases', (k) => {
    expect(() => buildTimeline(cfg, k, T0)).toThrow(/invalid phase count/);
  });
  it.each([1, 2, 3, 4, 5, 7, 10])('%i phases: strictly increasing closes, last = campaignEnd, durations add up', (k) => {
    const t = buildTimeline(cfg, k, T0);
    expect(t.phaseCloses).toHaveLength(k);
    for (let i = 1; i < k; i++) expect(t.phaseCloses[i]).toBeGreaterThan(t.phaseCloses[i - 1]);
    expect(t.phaseCloses[k - 1]).toBe(t.campaignEnd);
    expect(t.campaignEnd).toBe(T0 + cfg.durations.campaignMs);
    expect(t.countingEnd).toBe(t.campaignEnd + cfg.durations.countingMs);
    expect(t.postCountingEnd).toBe(t.countingEnd + cfg.durations.postCountingMs);
    expect(t.campaignStart).toBe(T0);
    for (const c of t.phaseCloses) expect(Number.isInteger(c)).toBe(true);
  });
  it('the counting length can be overridden (2-player games count for 1 minute, others for 3)', () => {
    expect(cfg.durations.countingMsTwoPlayers).toBe(60_000);
    expect(cfg.durations.countingMs).toBe(180_000);
    expect(countingMsFor(cfg, 2)).toBe(cfg.durations.countingMsTwoPlayers);
    for (const n of [3, 4, 10]) expect(countingMsFor(cfg, n)).toBe(cfg.durations.countingMs);
    const t2 = buildTimeline(cfg, 3, T0, countingMsFor(cfg, 2));
    expect(t2.countingEnd - t2.campaignEnd).toBe(60_000);
    expect(t2.postCountingEnd - t2.countingEnd).toBe(cfg.durations.postCountingMs);
    const t3 = buildTimeline(cfg, 3, T0, countingMsFor(cfg, 3));
    expect(t3.countingEnd - t3.campaignEnd).toBe(180_000);
    expect(buildTimeline(cfg, 3, T0).countingEnd).toBe(t3.countingEnd); // default = countingMs
    expect(t2.phaseCloses).toEqual(t3.phaseCloses);
  });
  it('2-player games have no post-counting wait (nothing to negotiate); 3+ keep postCountingMs', () => {
    expect(postCountingMsFor(cfg, 2)).toBe(0);
    for (const n of [3, 4, 10]) expect(postCountingMsFor(cfg, n)).toBe(cfg.durations.postCountingMs);
    const t2 = buildTimeline(cfg, 3, T0, countingMsFor(cfg, 2), postCountingMsFor(cfg, 2));
    expect(t2.postCountingEnd).toBe(t2.countingEnd);
    const t3 = buildTimeline(cfg, 3, T0, countingMsFor(cfg, 3), postCountingMsFor(cfg, 3));
    expect(t3.postCountingEnd - t3.countingEnd).toBe(120_000);
  });
  it('phases are equal length to within rounding', () => {
    const t = buildTimeline(cfg, 7, T0);
    const gaps = t.phaseCloses.map((c, i) => c - (i ? t.phaseCloses[i - 1] : T0));
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });
  it('works with any start time (also 0 and large epochs)', () => {
    for (const s of [0, 1, 1_750_000_000_000]) expect(buildTimeline(cfg, 3, s).phaseCloses[2]).toBe(s + cfg.durations.campaignMs);
  });
  it('phaseOfSeat: every seat of every grouping, and errors for unknown seats / groupings', () => {
    for (const k of [1, 2, 3]) {
      map.phaseGroups[String(k)].forEach((g, p) => g.forEach((id) => expect(phaseOfSeat(map, k, id)).toBe(p)));
    }
    expect(() => phaseOfSeat(map, 3, 999)).toThrow(/not in any polling phase/);
    expect(() => phaseOfSeat(map, 4, 1)).toThrow(/no phase grouping for 4/);
    expect(() => phaseOfSeat(map, 0, 1)).toThrow();
  });
});

describe('timeMultiplier', () => {
  const tl = buildTimeline(cfg, 1, T0);
  it('start at campaignStart, end at campaignEnd, midpoint in between, clamped outside', () => {
    expect(timeMultiplier(cfg, tl, T0)).toBe(cfg.timeMultiplier.start);
    expect(timeMultiplier(cfg, tl, tl.campaignEnd)).toBe(cfg.timeMultiplier.end);
    expect(timeMultiplier(cfg, tl, T0 + cfg.durations.campaignMs / 2)).toBeCloseTo((cfg.timeMultiplier.start + cfg.timeMultiplier.end) / 2, 12);
    expect(timeMultiplier(cfg, tl, -1e12)).toBe(cfg.timeMultiplier.start);
    expect(timeMultiplier(cfg, tl, 1e15)).toBe(cfg.timeMultiplier.end);
  });
  it('is monotone non-decreasing when end >= start', () => {
    let prev = 0;
    for (let f = 0; f <= 1; f += 0.01) { const m = timeMultiplier(cfg, tl, T0 + f * cfg.durations.campaignMs); expect(m).toBeGreaterThanOrEqual(prev); prev = m; }
  });
  it('a zero-length campaign uses the end multiplier instead of dividing by zero', () => {
    const t = { ...tl, campaignEnd: tl.campaignStart };
    expect(timeMultiplier(cfg, t, T0)).toBe(cfg.timeMultiplier.end);
  });
});

// ================================================================== kernels
describe('haversine / decay / kernels', () => {
  it('distance is zero for the same point, symmetric, never above half the circumference, antipodes ~20015 km', () => {
    expect(haversineKm(10, 20, 10, 20)).toBe(0);
    expect(haversineKm(10, 20, 80, -30)).toBeCloseTo(haversineKm(80, -30, 10, 20), 9);
    expect(haversineKm(0, 0, 180, 0)).toBeCloseTo(Math.PI * 6371, 3);
    expect(haversineKm(0, 90, 0, -90)).toBeCloseTo(Math.PI * 6371, 3);
    expect(haversineKm(-179.9, 0, 179.9, 0)).toBeLessThan(25); // across the date line
  });
  it('decay: 1 at 0 km, 0.5 at half distance, exactly 0 beyond maxKm, non-zero at maxKm', () => {
    const p = { halfDistanceKm: 100, maxKm: 500, capRatio: 0.5 };
    expect(decay(0, p)).toBe(1);
    expect(decay(100, p)).toBeCloseTo(0.5, 12);
    expect(decay(200, p)).toBeCloseTo(0.25, 12);
    expect(decay(500, p)).toBeGreaterThan(0);
    expect(decay(500.0001, p)).toBe(0);
    expect(decay(1e6, p)).toBe(0);
  });
  it('kernel matrices are symmetric, non-negative, finite, with local on the diagonal and rally >= roadshow-free spill ordering by distance', () => {
    const n = kernels.n;
    for (let i = 0; i < n; i++) {
      expect(kernels.rally[i * n + i]).toBe(cfg.effects.rally.local);
      expect(kernels.roadshow[i * n + i]).toBe(cfg.effects.roadshow.local);
      for (let j = 0; j < n; j++) {
        expect(kernels.rally[i * n + j]).toBeCloseTo(kernels.rally[j * n + i], 6);
        expect(kernels.roadshow[i * n + j]).toBeCloseTo(kernels.roadshow[j * n + i], 6);
        expect(kernels.rally[i * n + j]).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(kernels.distanceKm[i * n + j])).toBe(true);
        if (i !== j) {
          expect(kernels.rally[i * n + j]).toBeLessThanOrEqual(cfg.effects.rally.decay.capRatio * cfg.effects.rally.local + 1e-6);
          expect(kernels.roadshow[i * n + j]).toBeLessThanOrEqual(cfg.effects.roadshow.decay.capRatio * cfg.effects.roadshow.local + 1e-6);
        }
      }
    }
  });
  it('spill-over never increases with distance (per row)', () => {
    const n = kernels.n;
    for (let i = 0; i < n; i++) {
      const row = Array.from({ length: n }, (_, j) => j).filter((j) => j !== i).sort((a, b) => kernels.distanceKm[i * n + a] - kernels.distanceKm[i * n + b]);
      for (let k = 1; k < row.length; k++) {
        expect(kernels.rally[i * n + row[k]]).toBeLessThanOrEqual(kernels.rally[i * n + row[k - 1]] + 1e-6);
        expect(kernels.roadshow[i * n + row[k]]).toBeLessThanOrEqual(kernels.roadshow[i * n + row[k - 1]] + 1e-6);
      }
    }
  });
  it('seats are indexed by sorted id even when the package lists them in another order', () => {
    const shuffled = { ...map, seats: [...map.seats].reverse() };
    const k = buildKernels(shuffled, cfg);
    expect(k.seatIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(k.rally)).toEqual(Array.from(kernels.rally));
  });
  it('works for one-seat maps and for non-contiguous seat ids', () => {
    const one = buildKernels({ ...map, seats: [map.seats[0]], seatCount: 1 }, cfg);
    expect(one.n).toBe(1);
    expect(one.rally[0]).toBe(cfg.effects.rally.local);
    const sparse = buildKernels({ ...map, seats: map.seats.map((s, i) => ({ ...s, id: (i + 1) * 100 })) }, cfg);
    expect(sparse.seatIds).toEqual([100, 200, 300, 400, 500, 600, 700, 800]);
    expect(sparse.index.get(300)).toBe(2);
  });
  it('a seat headquarters overrides the centroid for distances', () => {
    const hq = { ...map, seats: map.seats.map((s) => (s.id === 8 ? { ...s, hq: { name: 'HQ', lon: 0.05, lat: 0 } } : s)) };
    const k = buildKernels(hq, cfg);
    expect(k.distanceKm[k.index.get(8)! * k.n + k.index.get(1)!]).toBeLessThan(10);
  });
});

// ================================================================== effects
describe('computeEffects invariants', () => {
  const tl = buildTimeline(cfg, 1, T0);
  const sample: Action[] = [
    act('A', 'rally', 1, T0 + 1000), act('B', 'roadshow', 3, T0 + 2000), act('A', 'roadshow', 3, T0 + 3000), act('C', 'rally', 5, T0 + 4000), act('B', 'rally', 8, T0 + 5000),
  ];
  const sum = (e: Effects, p: string) => Array.from(e.get(p) ?? []).reduce((a, b) => a + b, 0);

  it('order of actions does not matter', () => {
    const a = computeEffects(sample, kernels, cfg, tl, map, 1);
    const b = computeEffects([...sample].reverse(), kernels, cfg, tl, map, 1);
    for (const p of ['A', 'B', 'C']) for (let i = 0; i < kernels.n; i++) expect((b.get(p) as Float64Array)[i]).toBeCloseTo((a.get(p) as Float64Array)[i], 12);
  });
  it('all effects are >= 0 and finite; every rally touches every seat (global c), a roadshow only nearby seats', () => {
    const e = computeEffects(sample, kernels, cfg, tl, map, 1);
    for (const v of e.values()) for (const x of v) { expect(x).toBeGreaterThanOrEqual(0); expect(Number.isFinite(x)).toBe(true); }
    const onlyRally = computeEffects([act('A', 'rally', 1, T0)], kernels, cfg, tl, map, 1).get('A') as Float64Array;
    expect(Array.from(onlyRally).every((x) => x >= cfg.effects.rally.global)).toBe(true);
    const onlyRoad = computeEffects([act('A', 'roadshow', 1, T0)], kernels, cfg, tl, map, 1).get('A') as Float64Array;
    expect(onlyRoad[idx(8)]).toBe(0);
    expect(onlyRoad[idx(1)]).toBeGreaterThan(0);
  });
  it('more actions never reduce anybody\'s effect anywhere (monotone), and doubling an action doubles its contribution', () => {
    const one = computeEffects([act('A', 'roadshow', 3, T0)], kernels, cfg, tl, map, 1).get('A') as Float64Array;
    const two = computeEffects([act('A', 'roadshow', 3, T0), act('A', 'roadshow', 3, T0)], kernels, cfg, tl, map, 1).get('A') as Float64Array;
    for (let i = 0; i < kernels.n; i++) expect(two[i]).toBeCloseTo(2 * one[i], 12);
    const base = computeEffects(sample, kernels, cfg, tl, map, 1);
    const more = computeEffects([...sample, act('A', 'rally', 2, T0 + 6000)], kernels, cfg, tl, map, 1);
    for (const p of ['A', 'B', 'C']) for (let i = 0; i < kernels.n; i++) expect((more.get(p) as Float64Array)[i]).toBeGreaterThanOrEqual((base.get(p) as Float64Array)[i] - 1e-12);
  });
  it('upTo is inclusive; exclude removes a player entirely (no vector at all)', () => {
    const e = computeEffects(sample, kernels, cfg, tl, map, 1, { upTo: T0 + 2000 });
    expect(sum(e, 'B')).toBeGreaterThan(0);
    expect(e.has('C')).toBe(false);
    const ex = computeEffects(sample, kernels, cfg, tl, map, 1, { exclude: new Set(['A', 'B']) });
    expect([...ex.keys()]).toEqual(['C']);
  });
  it('an empty action list gives no effects and no shares', () => {
    const e = computeEffects([], kernels, cfg, tl, map, 1);
    expect(e.size).toBe(0);
    expect(seatShares(e, kernels, 1)).toEqual({});
  });
  it('throws a clear error for a phase count the map has no grouping for', () => {
    expect(() => computeEffects(sample, kernels, cfg, tl, map, 4)).toThrow(/no phase grouping for 4/);
  });
  it('seats missing from the groupings are never frozen', () => {
    const partial = { ...map, phaseGroups: { '1': [[1, 2, 3]] } };
    const e = computeEffects([act('A', 'rally', 1, T0 + 10 * 60_000)], kernels, cfg, tl, partial, 1).get('A') as Float64Array;
    expect(e[idx(1)]).toBe(0);       // frozen: its phase closed before the action
    expect(e[idx(8)]).toBeGreaterThan(0); // not in any group -> still open
  });
  it('actions timestamped before the campaign start use the start multiplier', () => {
    const early = computeEffects([act('A', 'roadshow', 1, T0 - 99999)], kernels, cfg, tl, map, 1).get('A') as Float64Array;
    expect(early[idx(1)]).toBeCloseTo(cfg.effects.roadshow.local * cfg.timeMultiplier.start, 12);
  });
  it('vote shares of a seat sum to 1 whenever somebody has effect there', () => {
    const e = computeEffects(sample, kernels, cfg, tl, map, 1);
    for (const id of map.seats.map((s) => s.id)) {
      const sh = seatShares(e, kernels, id);
      expect(Object.values(sh).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
    expect(seatShares(e, kernels, 12345)).toEqual({});
  });
});

// ================================================================== polling
describe('pollSeats properties', () => {
  const tl = buildTimeline(cfg, 1, T0);
  const eff = (n: number) => {
    const acts: Action[] = [];
    for (let p = 0; p < n; p++) for (let s = 1; s <= 8; s++) if ((s + p) % 2 === 0) acts.push(act(`P${p}`, p % 2 ? 'rally' : 'roadshow', s, T0 + 1000 * (s + p)));
    return computeEffects(acts, kernels, cfg, tl, map, 1);
  };
  it.each([2, 3, 5, 10])('%i players: every polled seat has a winner among the players with the maximal share, shares sum to 1 and are in [0,1]', (n) => {
    const e = eff(n);
    const res = pollSeats(e, kernels, cfg, [1, 2, 3, 4, 5, 6, 7, 8], 0, createRng('p' + n));
    for (const r of res) {
      if (r.winner === null) { expect(r.shares).toEqual({}); continue; }
      const vals = Object.values(r.shares);
      expect(vals.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      for (const v of vals) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
      expect(r.shares[r.winner]).toBeCloseTo(Math.max(...vals), 10);
    }
  });
  it('zero swing gives exactly the raw shares', () => {
    const e = eff(3);
    const res = pollSeats(e, kernels, { ...cfg, randomSwing: 0 }, [1, 2, 3], 0, createRng('z'));
    for (const r of res) for (const [p, v] of Object.entries(r.shares)) expect(v).toBeCloseTo(seatShares(e, kernels, r.seat)[p], 12);
  });
  it('unknown seats come back as winner null; the phase number is copied; polling does not mutate the effects', () => {
    const e = eff(2);
    const copy = new Map([...e].map(([k, v]) => [k, Float64Array.from(v)]));
    const res = pollSeats(e, kernels, cfg, [1, 999], 4, createRng('u'));
    expect(res[1]).toEqual({ seat: 999, phase: 4, winner: null, shares: {} });
    expect(res[0].phase).toBe(4);
    for (const [k, v] of e) expect(Array.from(v)).toEqual(Array.from(copy.get(k) as Float64Array));
  });
  it('polling nothing or polling with no effects is fine', () => {
    expect(pollSeats(eff(2), kernels, cfg, [], 0, createRng('e'))).toEqual([]);
    const res = pollSeats(new Map(), kernels, cfg, [1, 2], 0, createRng('e'));
    expect(res.every((r) => r.winner === null)).toBe(true);
  });
  it('a clear leader always wins whatever the seed (swing is small)', () => {
    const e: Effects = new Map([['A', Float64Array.from([10, 10, 10, 10, 10, 10, 10, 10])], ['B', Float64Array.from([1, 1, 1, 1, 1, 1, 1, 1])]]);
    for (let s = 0; s < 200; s++) for (const r of pollSeats(e, kernels, cfg, [1, 2, 3], 0, createRng('seed' + s))) expect(r.winner).toBe('A');
  });
  it('a dead heat is decided at random but only among the leaders, over many seeds both win', () => {
    const e: Effects = new Map([['A', Float64Array.from(Array(8).fill(1))], ['B', Float64Array.from(Array(8).fill(1))], ['C', Float64Array.from(Array(8).fill(0.1))]]);
    const wins = { A: 0, B: 0, C: 0 } as Record<string, number>;
    for (let s = 0; s < 400; s++) wins[pollSeats(e, kernels, { ...cfg, randomSwing: 0 }, [1], 0, createRng('t' + s))[0].winner as string]++;
    expect(wins.C).toBe(0);
    expect(wins.A).toBeGreaterThan(120);
    expect(wins.B).toBeGreaterThan(120);
  });
});

describe('removePlayerFromResults / tallySeats', () => {
  const res: SeatResult[] = [
    { seat: 1, phase: 0, winner: 'A', shares: { A: 0.6, B: 0.3, C: 0.1 } },
    { seat: 2, phase: 0, winner: 'B', shares: { A: 0.2, B: 0.5, C: 0.3 } },
    { seat: 3, phase: 0, winner: 'A', shares: { A: 1 } },
    { seat: 4, phase: 0, winner: null, shares: {} },
  ];
  it('removing the winner hands the seat to the runner-up with renormalised shares; removing a non-winner keeps the winner', () => {
    const out = removePlayerFromResults(res, 'A');
    expect(out[0].winner).toBe('B');
    expect(out[0].shares.B).toBeCloseTo(0.75, 12);
    expect(out[0].shares.C).toBeCloseTo(0.25, 12);
    expect(out[1].winner).toBe('B');
    expect(out[1].shares.A).toBeUndefined();
    expect(Object.values(out[1].shares).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(out[2]).toEqual({ seat: 3, phase: 0, winner: null, shares: {} });   // nobody else was in the seat
    expect(out[3]).toEqual(res[3]);
  });
  it('removing players one after the other equals removing them together; the last one standing takes everything', () => {
    const a = removePlayerFromResults(removePlayerFromResults(res, 'A'), 'B');
    expect(a[0]).toMatchObject({ winner: 'C', shares: { C: 1 } });
    expect(a[1]).toMatchObject({ winner: 'C', shares: { C: 1 } });
    const b = removePlayerFromResults(removePlayerFromResults(res, 'B'), 'A');
    expect(a).toEqual(b);
  });
  it('removing an unknown player changes nothing; the input is never mutated', () => {
    const before = JSON.stringify(res);
    expect(removePlayerFromResults(res, 'Z')).toEqual(res);
    removePlayerFromResults(res, 'A');
    expect(JSON.stringify(res)).toBe(before);
  });
  it('tally counts only real winners; empty input gives an empty tally', () => {
    expect(tallySeats(res)).toEqual({ A: 2, B: 1 });
    expect(tallySeats([])).toEqual({});
    expect(tallySeats(removePlayerFromResults(res, 'A'))).toEqual({ B: 2 });
  });
});

// ================================================================== analyst
describe('analyst corner cases', () => {
  const tl = buildTimeline(cfg, 1, T0);
  const players = ['A', 'B', 'C'];
  const noiseless = { ...cfg, analyst: { ...cfg.analyst, noise: 0 } };
  it('price: whole numbers everywhere, never decreasing over the campaign, flat when start = end, zero-length campaign uses the end price', () => {
    for (const scope of ['seat', 'global'] as const) {
      let prev = 0;
      for (let f = 0; f <= 1.0001; f += 0.037) {
        const p = analystPrice(cfg, scope, tl, T0 + f * cfg.durations.campaignMs);
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(prev);
        prev = p;
      }
    }
    const flat = { ...cfg, analyst: { ...cfg.analyst, seatReport: { start: 500, end: 500 } } };
    expect(analystPrice(flat, 'seat', tl, T0 + 12345)).toBe(500);
    expect(analystPrice(cfg, 'seat', { ...tl, campaignEnd: tl.campaignStart }, T0)).toBe(cfg.analyst.seatReport.end);
  });
  it('seat report errors: missing seat, unknown seat', () => {
    const e: Effects = new Map();
    expect(() => analystReport(e, kernels, cfg, 'seat', undefined, [], players, 0, 1, 1, createRng('x'))).toThrow(/requires a seat/);
    expect(() => analystReport(e, kernels, cfg, 'seat', 999, [], players, 0, 1, 1, createRng('x'))).toThrow(/unknown seat/);
  });
  it('noise-free seat report: ranks follow the true shares; tied players are ranked by their order in `players`', () => {
    const e: Effects = new Map([['A', Float64Array.from(Array(8).fill(2))], ['B', Float64Array.from(Array(8).fill(2))], ['C', Float64Array.from(Array(8).fill(1))]]);
    const r = analystReport(e, kernels, noiseless, 'seat', 1, [], players, 0, 1, 7, createRng('x'));
    expect(r.entries.map((x) => x.playerId)).toEqual(['A', 'B', 'C']);
    expect(r.entries.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(r.entries[0].estimate).toBeCloseTo(0.4, 12);
    expect(r.entries[2].estimate).toBeCloseTo(0.2, 12);
    const flipped = analystReport(e, kernels, noiseless, 'seat', 1, [], ['B', 'A', 'C'], 0, 1, 7, createRng('x'));
    expect(flipped.entries.map((x) => x.playerId)).toEqual(['B', 'A', 'C']);
  });
  it('report estimates are clamped to [0,1] even with enormous noise; margin equals noise * factor', () => {
    const e: Effects = new Map([['A', Float64Array.from(Array(8).fill(1))]]);
    const wild = { ...cfg, analyst: { ...cfg.analyst, noise: 5, marginFactor: 2 } };
    for (let s = 0; s < 50; s++) {
      const r = analystReport(e, kernels, wild, 'seat', 1, [], ['A', 'B'], 0, 1, 1, createRng('w' + s));
      for (const x of r.entries) { expect(x.estimate).toBeGreaterThanOrEqual(0); expect(x.estimate).toBeLessThanOrEqual(1); expect(x.margin).toBe(10); }
    }
  });
  it('global report: decided seats count for their winners exactly, players outside `players` are ignored, estimates are whole and >= 0', () => {
    const decided: SeatResult[] = [{ seat: 1, phase: 0, winner: 'A', shares: { A: 1 } }, { seat: 2, phase: 0, winner: 'Z', shares: { Z: 1 } }, { seat: 3, phase: 0, winner: null, shares: {} }];
    const e: Effects = new Map();
    const r = analystReport(e, kernels, noiseless, 'global', undefined, decided, players, 0, 1, 1, createRng('g'));
    const byP = Object.fromEntries(r.entries.map((x) => [x.playerId, x.estimate]));
    expect(byP).toEqual({ A: 1, B: 0, C: 0 });
    for (const x of r.entries) { expect(Number.isInteger(x.estimate)).toBe(true); expect(x.margin).toBeGreaterThanOrEqual(1); }
  });
  it('global report with open seats: the player with the highest effect in a seat gets it, nobody gets seats without any effect', () => {
    const v = (arr: number[]) => Float64Array.from(arr);
    const e: Effects = new Map([['A', v([5, 0, 0, 0, 0, 0, 0, 0])], ['B', v([1, 0, 3, 0, 0, 0, 0, 0])]]);
    const r = analystReport(e, kernels, noiseless, 'global', undefined, [], players, 0, 1, 1, createRng('g'));
    const byP = Object.fromEntries(r.entries.map((x) => [x.playerId, x.estimate]));
    expect(byP).toEqual({ A: 1, B: 1, C: 0 });
  });
  it('the report copies asOf / purchasedAt / price and is a pure function of its inputs and rng', () => {
    const e: Effects = new Map([['A', Float64Array.from(Array(8).fill(1))]]);
    const a = analystReport(e, kernels, cfg, 'seat', 2, [], players, 111, 222, 333, createRng('same'));
    const b = analystReport(e, kernels, cfg, 'seat', 2, [], players, 111, 222, 333, createRng('same'));
    expect(a).toEqual(b);
    expect(a).toMatchObject({ scope: 'seat', seat: 2, asOf: 111, purchasedAt: 222, price: 333 });
  });
});

// ================================================================== points & government properties
describe('finalResult properties', () => {
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  function randomTally(rng: () => number, n: number, players: string[]) {
    const t: Record<string, number> = {};
    let left = n;
    for (const p of players) { const k = Math.floor(rng() * (left + 1) * 0.7); t[p] = k; left -= k; }
    return t;
  }
  it('1500 random games: whole-number points, opposition 0, eliminated 0, winners non-eliminated, government members >= floor and portfolio sums right', () => {
    const rng = createRng('points');
    for (let g = 0; g < 1500; g++) {
      const n = 1 + Math.floor(rng() * 600);
      const players = ids.slice(0, 2 + Math.floor(rng() * 5));
      const tally = randomTally(rng, n, players);
      const eliminated = new Set(players.filter(() => rng() < 0.2).slice(0, players.length - 1));
      const kind = rng();
      let gov: Government | null = null;
      const alive = players.filter((p) => !eliminated.has(p));
      if (kind < 0.35 && alive.length) gov = majorityGovernment(alive[Math.floor(rng() * alive.length)], cfg, 1);
      else if (kind < 0.7 && alive.length >= 2) {
        const offer: CoalitionOffer = { offerId: 'o', proposer: alive[0], partners: [alive[1]], accepted: [alive[1]], status: 'accepted', createdAt: 1, portfolios: { PM: [alive[0]], DPM: [alive[1]] } };
        gov = governmentFromOffer(offer, 1);
      }
      const r = finalResult(tally, gov, players, eliminated, cfg, n);
      expect(r.points).toHaveLength(players.length);
      for (const b of r.points) {
        expect(Number.isInteger(b.total)).toBe(true);
        expect(b.total).toBeGreaterThanOrEqual(0);
        const member = (gov?.members.includes(b.playerId) ?? false) || r.outcome === 'draw';
        if (eliminated.has(b.playerId)) { expect(b).toMatchObject({ total: 0, portfolioPoints: 0, seatPoints: 0, governmentFloor: 0 }); continue; }
        if (member) {
          expect(b.governmentFloor).toBe(cfg.points.governmentFloor);
          expect(b.seatPoints).toBe(Math.round((cfg.points.seatMultiplier * (tally[b.playerId] ?? 0)) / n));
          expect(b.total).toBe(b.portfolioPoints + b.seatPoints + b.governmentFloor);
        } else {
          expect(b.total).toBe(cfg.points.opposition);
          expect(b.portfolioPoints + b.seatPoints + b.governmentFloor).toBe(0);
        }
      }
      for (const w of r.winners) expect(eliminated.has(w)).toBe(false);
      if (r.outcome === 'noGovernment') { expect(r.winners).toEqual([]); expect(r.points.every((p) => p.total === 0)).toBe(true); }
      if (r.outcome === 'majority') { expect(r.winners).toEqual([gov!.pm]); expect((tally[gov!.pm] ?? 0)).toBeGreaterThanOrEqual(majorityOf(n)); }
      if (r.outcome === 'draw') { expect(r.winners).toHaveLength(2); expect(gov).toBeNull(); }
    }
  });

  it('a non-negotiated government whose PM is eliminated or short of a majority is scored as a coalition', () => {
    const g = majorityGovernment('A', cfg, 1);
    expect(finalResult({ A: 10, B: 400 }, g, ['A', 'B'], new Set(), cfg, 500).outcome).toBe('coalition');
    expect(finalResult({ A: 300, B: 100 }, g, ['A', 'B'], new Set(['A']), cfg, 500).outcome).toBe('coalition');
    expect(finalResult({ A: 251, B: 100 }, g, ['A', 'B'], new Set(), cfg, 500).outcome).toBe('majority');
    expect(finalResult({ A: 250, B: 100 }, g, ['A', 'B'], new Set(), cfg, 500).outcome).toBe('coalition');
  });
  it('majority threshold uses the real seat count: N=7 needs 4, N=8 needs 5', () => {
    const g = majorityGovernment('A', cfg, 1);
    expect(finalResult({ A: 4 }, g, ['A', 'B'], new Set(), cfg, 7).outcome).toBe('majority');
    expect(finalResult({ A: 3 }, g, ['A', 'B'], new Set(), cfg, 7).outcome).toBe('coalition');
    expect(finalResult({ A: 5 }, g, ['A', 'B'], new Set(), cfg, 8).outcome).toBe('majority');
    expect(finalResult({ A: 4 }, g, ['A', 'B'], new Set(), cfg, 8).outcome).toBe('coalition');
  });
  it('no government: draw needs exactly two non-eliminated players with equal seats', () => {
    expect(finalResult({ A: 4, B: 4 }, null, ['A', 'B'], new Set(), cfg, 8).outcome).toBe('draw');
    expect(finalResult({ A: 0, B: 0 }, null, ['A', 'B'], new Set(), cfg, 8).outcome).toBe('draw');
    expect(finalResult({}, null, ['A', 'B'], new Set(), cfg, 8).outcome).toBe('draw');
    expect(finalResult({ A: 5, B: 3 }, null, ['A', 'B'], new Set(), cfg, 8).outcome).toBe('noGovernment');
    expect(finalResult({ A: 4, B: 4 }, null, ['A', 'B', 'C'], new Set(), cfg, 8).outcome).toBe('noGovernment');
    expect(finalResult({ A: 4, B: 4 }, null, ['A', 'B', 'C'], new Set(['C']), cfg, 8).outcome).toBe('draw');
    expect(finalResult({ A: 4, B: 4 }, null, ['A', 'B', 'C'], new Set(['B', 'C']), cfg, 8).outcome).toBe('noGovernment');
  });
  it('a draw gives both players the same points: seat points + government floor, no portfolio points', () => {
    const r = finalResult({ A: 250, B: 250 }, null, ['A', 'B'], new Set(), cfg, 500);
    expect(r.points[0]).toEqual(r.points[1].playerId === 'B' ? { ...r.points[1], playerId: 'A' } : r.points[0]);
    expect(r.points[0].portfolioPoints).toBe(0);
    expect(r.points[0].total).toBe(Math.round((cfg.points.seatMultiplier * 250) / 500) + cfg.points.governmentFloor);
  });
  it('coalition ties in points share the win; the PM can lose to a richer partner', () => {
    const offer: CoalitionOffer = { offerId: 'o', proposer: 'A', partners: ['B'], accepted: ['B'], status: 'accepted', createdAt: 1, portfolios: { PM: ['A'], DPM: ['B'], HOME: ['B'], FINANCE: ['B'] } };
    const gov = governmentFromOffer(offer, 1);
    const r = finalResult({ A: 100, B: 200 }, gov, ['A', 'B', 'C'], new Set(), cfg, 500);
    expect(r.outcome).toBe('coalition');
    expect(r.winners).toEqual(['B']); // 50+20+20 + 80 + 10 beats PM 100 + 40 + 10
    expect(r.points.find((p) => p.playerId === 'C')!.total).toBe(0);
  });
  it('unknown portfolio ids in a government give no points and no membership (validateGovernment rejects them before a government exists)', () => {
    const gov: Government = { pm: 'A', members: ['A'], portfolios: { PM: ['A'], MINISTER_OF_FUN: ['B'] }, formedAt: 1, viaNegotiation: true };
    const r = finalResult({ A: 100, B: 100 }, gov, ['A', 'B'], new Set(), cfg, 200);
    expect(r.points.find((p) => p.playerId === 'B')!.portfolioPoints).toBe(0);
    expect(r.points.find((p) => p.playerId === 'B')!.total).toBe(cfg.points.opposition);
    expect(validateGovernment({ PM: ['A'], MINISTER_OF_FUN: ['B'] }, { A: 100, B: 100 }, cfg, 200)).toMatch(/Unknown portfolio/);
  });
  it('a player who is not in the tally has 0 seats; extra tally entries for non-players do not matter', () => {
    const g = majorityGovernment('A', cfg, 1);
    const r = finalResult({ A: 8, Z: 100 }, g, ['A', 'B'], new Set(), cfg, 8);
    expect(r.points.find((p) => p.playerId === 'B')!.total).toBe(0);
  });
  it('seat points rounding: x.5 rounds up and stays an integer for awkward seat counts', () => {
    const g = majorityGovernment('A', cfg, 1);
    for (const n of [3, 7, 11, 13, 499, 501]) {
      const r = finalResult({ A: majorityOf(n) }, g, ['A', 'B'], new Set(), cfg, n);
      expect(Number.isInteger(r.points[0].seatPoints)).toBe(true);
      expect(r.points[0].seatPoints).toBe(Math.round((cfg.points.seatMultiplier * majorityOf(n)) / n));
    }
  });
});

describe('validateGovernment table', () => {
  const t = { A: 3, B: 2, C: 1, D: 1 };
  const rows: [string, Record<string, string[]>, string | null][] = [
    ['PM alone short (3 of 7 needs 4)', { PM: ['A'] }, 'needs 4'],
    ['PM + B reaches 5 of 7', { PM: ['A'], HOME: ['B'] }, null],
    ['exactly the majority: A+C = 4', { PM: ['A'], HOME: ['C'] }, null],
    ['B+C+D = 4 with C as PM', { PM: ['C'], DPM: ['B', 'D'] }, null],
    ['empty portfolios', {}, 'Prime Minister'],
    ['PM with empty list', { PM: [] }, 'Prime Minister'],
    ['two PMs', { PM: ['A', 'B'] }, 'only one'],
    ['3 DPM', { PM: ['A'], DPM: ['B', 'C', 'D'] }, 'at most 2'],
    ['2 FINANCE', { PM: ['A'], FINANCE: ['B', 'C'] }, 'Finance'],
    ['unknown portfolio', { PM: ['A'], X: ['B'] }, 'Unknown portfolio: X'],
    ['holder without seats counts zero', { PM: ['A'], HOME: ['Nobody'] }, 'needs 4'],
  ];
  it.each(rows)('%s', (_label, pf, expected) => {
    const r = validateGovernment(pf, t, cfg, 7);
    if (expected === null) expect(r).toBeNull(); else expect(r).toContain(expected);
  });
  it('a one-seat map: the single seat holder alone is a majority', () => {
    expect(validateGovernment({ PM: ['A'] }, { A: 1 }, cfg, 1)).toBeNull();
    expect(validateGovernment({ PM: ['A'] }, { A: 0 }, cfg, 1)).toMatch(/needs 1/);
  });
});

describe('majorityGovernment / governmentFromOffer', () => {
  it('majorityGovernment fills every portfolio up to its max with the same player; members = [player]', () => {
    const g = majorityGovernment('A', cfg, 5);
    expect(g.members).toEqual(['A']);
    expect(g.viaNegotiation).toBe(false);
    for (const d of cfg.points.portfolios) expect(g.portfolios[d.id]).toEqual(Array(d.max).fill('A'));
  });
  it('majorityGovernment points: every portfolio counts (DPM twice)', () => {
    const g = majorityGovernment('A', cfg, 5);
    const r = finalResult({ A: 300 }, g, ['A', 'B'], new Set(), cfg, 500);
    const total = cfg.points.portfolios.reduce((s, d) => s + d.points * d.max, 0);
    expect(r.points[0].portfolioPoints).toBe(total);
  });
  it('governmentFromOffer: partners without a portfolio are members; no duplicates; the offer is not mutated', () => {
    const offer: CoalitionOffer = { offerId: 'o', proposer: 'A', partners: ['B', 'C', 'B'], accepted: [], status: 'accepted', createdAt: 1, portfolios: { PM: ['A'], HOME: ['B'] } };
    const copy = JSON.stringify(offer);
    const g = governmentFromOffer(offer, 9);
    expect(g.members).toEqual(['A', 'B', 'C']);
    expect(JSON.stringify(offer)).toBe(copy);
  });
});

// ================================================================== configuration invariants
describe('configuration invariants (designer rules)', () => {
  const c = WORLD_CONFIG;
  it('money amounts are whole numbers; costs are positive; the budget buys a sensible number of actions', () => {
    for (const v of [c.budget, c.costs.rally, c.costs.roadshow, c.analyst.seatReport.start, c.analyst.seatReport.end, c.analyst.globalReport.start, c.analyst.globalReport.end]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    expect(c.budget / c.costs.rally).toBeGreaterThanOrEqual(5);
    expect(c.budget / c.costs.roadshow).toBeGreaterThan(c.budget / c.costs.rally);
  });
  it('docx effect rules: roadshow local effect (s) is much larger than the rally global effect (c) and than the rally local effect (y); roadshows decay faster', () => {
    expect(c.effects.roadshow.local).toBeGreaterThan(c.effects.rally.local);
    expect(c.effects.roadshow.local).toBeGreaterThanOrEqual(10 * c.effects.rally.global);
    expect(c.effects.roadshow.decay.halfDistanceKm).toBeLessThan(c.effects.rally.decay.halfDistanceKm);
    expect(c.effects.roadshow.decay.maxKm).toBeLessThan(c.effects.rally.decay.maxKm);
    expect(c.effects.rally.global).toBeGreaterThan(0);
  });
  it('prices rise during the campaign, global reports are dearer than seat reports, the time multiplier only grows', () => {
    expect(c.analyst.seatReport.end).toBeGreaterThanOrEqual(c.analyst.seatReport.start);
    expect(c.analyst.globalReport.end).toBeGreaterThanOrEqual(c.analyst.globalReport.start);
    expect(c.analyst.globalReport.start).toBeGreaterThan(c.analyst.seatReport.end);
    expect(c.timeMultiplier.end).toBeGreaterThanOrEqual(c.timeMultiplier.start);
    expect(c.timeMultiplier.start).toBeGreaterThan(0);
    expect(c.analyst.noise).toBeGreaterThan(0);
    expect(c.analyst.delayMs).toBeGreaterThan(0);
  });
  it('phases and players ranges are sane, the default is inside the range, the map offers every phase count', () => {
    expect(c.phases.min).toBeGreaterThanOrEqual(1);
    expect(c.phases.default).toBeGreaterThanOrEqual(c.phases.min);
    expect(c.phases.default).toBeLessThanOrEqual(c.phases.max);
    expect(c.players.min).toBeGreaterThanOrEqual(2);
    expect(c.players.max).toBeGreaterThanOrEqual(c.players.min);
    // postCountingMsTwoPlayers may be 0: nothing to negotiate with 2 players, so the result follows counting immediately
    expect(c.durations.postCountingMsTwoPlayers).toBeGreaterThanOrEqual(0);
    for (const [k, d] of Object.entries(c.durations)) if (k !== 'postCountingMsTwoPlayers') expect(d).toBeGreaterThan(0);
  });
  it('portfolios: unique ids, exactly one PM with max 1, whole positive points, PM worth the most, DPM max 2', () => {
    const ids = c.points.portfolios.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const pm = c.points.portfolios.find((p) => p.id === 'PM')!;
    expect(pm.max).toBe(1);
    expect(c.points.portfolios.find((p) => p.id === 'DPM')!.max).toBe(2);
    for (const p of c.points.portfolios) { expect(Number.isInteger(p.points)).toBe(true); expect(p.points).toBeGreaterThan(0); expect(p.max).toBeGreaterThanOrEqual(1); expect(pm.points).toBeGreaterThanOrEqual(p.points); }
    expect(c.points.opposition).toBe(0);
    expect(Number.isInteger(c.points.governmentFloor)).toBe(true);
    expect(c.points.seatMultiplier).toBeGreaterThan(0);
  });
  it('the world config matches the map registry; configForMap / MAP_CONFIGS / DEFAULT_MAP_ID agree', () => {
    expect(DEFAULT_MAP_ID).toBe('world-500');
    expect(MAP_CONFIGS[DEFAULT_MAP_ID]).toBe(WORLD_CONFIG);
    expect(WORLD_CONFIG.mapId).toBe(DEFAULT_MAP_ID);
    expect(MAP_MANIFESTS.find((m) => m.id === DEFAULT_MAP_ID)!.seatCount).toBe(WORLD_CONFIG.seatCount);
    expect(configForMap('nowhere', 3)).toMatchObject({ mapId: 'nowhere', seatCount: 3 });
    for (const m of MAP_MANIFESTS) expect(configForMap(m.id, m.seatCount).seatCount).toBe(m.seatCount);
  });
});

describe('presets (colours, symbols, avatars)', () => {
  it('enough unique options for the largest game, so everybody can have a unique colour, symbol and avatar', () => {
    const max = WORLD_CONFIG.players.max;
    expect(new Set(PARTY_COLOURS.map((x) => x.hex.toLowerCase())).size).toBe(PARTY_COLOURS.length);
    expect(new Set(PARTY_COLOURS.map((x) => x.id)).size).toBe(PARTY_COLOURS.length);
    expect(new Set(PARTY_SYMBOLS.map((x) => x.id)).size).toBe(PARTY_SYMBOLS.length);
    expect(new Set(AVATARS.map((x) => x.id)).size).toBe(AVATARS.length);
    expect(PARTY_COLOURS.length).toBeGreaterThanOrEqual(max);
    expect(PARTY_SYMBOLS.length).toBeGreaterThanOrEqual(max);
    expect(AVATARS.length).toBeGreaterThanOrEqual(max);
  });
  it('colours are #RRGGBB, ids are lower-case words, every entry has a label', () => {
    for (const c of PARTY_COLOURS) { expect(c.hex).toMatch(/^#[0-9A-F]{6}$/); expect(c.id).toMatch(/^[a-z]+$/); expect(c.label).toBeTruthy(); }
    for (const s of PARTY_SYMBOLS) { expect(s.id).toMatch(/^[a-z]+$/); expect(s.icon).toMatch(/^[A-Z][A-Za-z]+$/); expect(s.label).toBeTruthy(); }
  });
  it('every avatar has full and thumb files on disk', async () => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const base = fileURLToPath(new URL('../../assets/avatars/', import.meta.url));
    for (const a of AVATARS) {
      expect(a.id).toMatch(/^[a-z0-9_-]+$/);
      expect(existsSync(base + a.full), a.full).toBe(true);
      expect(existsSync(base + a.thumb), a.thumb).toBe(true);
    }
  });
});
