import { describe, expect, it } from 'vitest';
import {
  buildKernels, buildTimeline, computeEffects, createRng, haversineKm, majorityOf, phaseOfSeat, seatShares,
  timeMultiplier,
} from '../src';
import { T0, TEST_CFG, act, testMap } from './helpers';

const map = testMap();
const cfg = TEST_CFG;
const kernels = buildKernels(map, cfg);
const idx = (id: number) => kernels.index.get(id) as number;
const at = (from: number, to: number) => kernels.rally[idx(from) * kernels.n + idx(to)];
const rs = (from: number, to: number) => kernels.roadshow[idx(from) * kernels.n + idx(to)];

describe('majority', () => {
  it('odd and even N', () => {
    expect(majorityOf(500)).toBe(251);
    expect(majorityOf(501)).toBe(251);
    expect(majorityOf(400)).toBe(201);
    expect(majorityOf(3)).toBe(2);
    expect(majorityOf(8)).toBe(5);
  });
});

describe('rng', () => {
  it('is deterministic and in [0,1)', () => {
    const a = createRng('seed');
    const b = createRng('seed');
    const c = createRng('other');
    const xs = Array.from({ length: 50 }, () => a());
    const ys = Array.from({ length: 50 }, () => b());
    expect(xs).toEqual(ys);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs.slice(0, 5));
  });
  it('is roughly uniform', () => {
    const r = createRng('uniform');
    let sum = 0;
    for (let i = 0; i < 10000; i++) sum += r();
    expect(sum / 10000).toBeGreaterThan(0.48);
    expect(sum / 10000).toBeLessThan(0.52);
  });
});

describe('haversine', () => {
  it('sanity checks', () => {
    expect(haversineKm(0, 0, 0, 0)).toBe(0);
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.19, 1);
    expect(haversineKm(0, 0, 0, 90)).toBeCloseTo(10007.5, 0);
    expect(haversineKm(0, 0, 180, 0)).toBeCloseTo(20015.1, 0);
    // London -> Paris ~ 344 km
    expect(haversineKm(-0.1276, 51.5072, 2.3522, 48.8566)).toBeGreaterThan(340);
    expect(haversineKm(-0.1276, 51.5072, 2.3522, 48.8566)).toBeLessThan(348);
  });
  it('kernel distances are symmetric and use hq when present', () => {
    expect(kernels.distanceKm[idx(1) * kernels.n + idx(3)]).toBeCloseTo(111.19, 0);
    expect(kernels.distanceKm[idx(3) * kernels.n + idx(1)]).toBeCloseTo(111.19, 0);
    const m2 = testMap();
    m2.seats[2] = { ...m2.seats[2], hq: { name: 'HQ', lon: 2, lat: 0 } };
    const k2 = buildKernels(m2, cfg);
    expect(k2.distanceKm[0 * k2.n + 2]).toBeCloseTo(222.39, 0);
  });
});

describe('kernels', () => {
  it('diagonal is exactly local', () => {
    expect(at(1, 1)).toBe(1);
    expect(rs(1, 1)).toBe(1.5);
  });
  it('decays by half every halfDistanceKm', () => {
    // seat 3 is 111.19 km from seat 1: 0.5^(1.1119) = 0.4626 ; below cap 0.5
    expect(at(1, 3)).toBeCloseTo(Math.pow(0.5, 111.19 / 100), 3);
    expect(at(1, 4)).toBeCloseTo(Math.pow(0.5, 333.58 / 100), 3);
    expect(at(1, 3)).toBeGreaterThan(at(1, 4));
  });
  it('is capped at capRatio x local for very close seats', () => {
    expect(at(1, 2)).toBeCloseTo(0.5, 6);
    expect(rs(1, 2)).toBeCloseTo(0.4 * 1.5, 6);
    expect(at(2, 1)).toBeCloseTo(0.5, 6);
  });
  it('is zero beyond maxKm and at maxKm boundary behaviour', () => {
    expect(at(1, 5)).toBe(0); // 667 km > 500
    expect(at(1, 6)).toBe(0);
    expect(rs(1, 4)).toBe(0); // 334 km > roadshow maxKm 150
    expect(rs(1, 3)).toBeCloseTo(1.5 * Math.pow(0.5, 111.19 / 30), 4); // 111 km <= 150
  });
  it('roadshow decays much faster than rally', () => {
    expect(rs(1, 7)).toBeLessThan(1.5);
    expect(rs(1, 7) / 1.5).toBeLessThan(at(1, 7));
  });
});

describe('timeline & time multiplier', () => {
  it('splits the campaign equally and rounds', () => {
    const t = buildTimeline({ ...cfg, durations: { ...cfg.durations, campaignMs: 100 } }, 3, 1000);
    expect(t.phaseCloses).toEqual([1033, 1067, 1100]);
    expect(t.campaignEnd).toBe(1100);
    const t3 = buildTimeline(cfg, 3, T0);
    expect(t3.phaseCloses).toEqual([T0 + 200_000, T0 + 400_000, T0 + 600_000]);
    expect(t3.countingEnd).toBe(t3.campaignEnd + cfg.durations.countingMs);
    expect(t3.postCountingEnd).toBe(t3.countingEnd + cfg.durations.postCountingMs);
    expect(buildTimeline(cfg, 1, T0).phaseCloses).toEqual([T0 + 600_000]);
  });
  it('phaseOfSeat', () => {
    expect(phaseOfSeat(map, 3, 1)).toBe(0);
    expect(phaseOfSeat(map, 3, 5)).toBe(1);
    expect(phaseOfSeat(map, 3, 8)).toBe(2);
    expect(phaseOfSeat(map, 1, 8)).toBe(0);
    expect(() => phaseOfSeat(map, 4, 1)).toThrow();
    expect(() => phaseOfSeat(map, 3, 99)).toThrow();
  });
  it('is linear and clamped', () => {
    const tl = buildTimeline(cfg, 1, T0);
    expect(timeMultiplier(cfg, tl, T0)).toBeCloseTo(1.0);
    expect(timeMultiplier(cfg, tl, T0 + 300_000)).toBeCloseTo(1.1);
    expect(timeMultiplier(cfg, tl, T0 + 600_000)).toBeCloseTo(1.2);
    expect(timeMultiplier(cfg, tl, T0 - 5000)).toBeCloseTo(1.0);
    expect(timeMultiplier(cfg, tl, T0 + 9_999_999)).toBeCloseTo(1.2);
  });
});

describe('computeEffects', () => {
  const tl1 = buildTimeline(cfg, 1, T0);
  const tl3 = buildTimeline(cfg, 3, T0);

  it('rally: local + spill-over + global c in every seat', () => {
    const e = computeEffects([act('A', 'rally', 1, T0)], kernels, cfg, tl1, map, 1);
    const v = e.get('A') as Float64Array;
    expect(v[idx(1)]).toBeCloseTo(1.0 + 0.01, 6);
    expect(v[idx(3)]).toBeCloseTo(at(1, 3) + 0.01, 6);
    expect(v[idx(5)]).toBeCloseTo(0.01, 6); // beyond maxKm: only global
    expect(v[idx(8)]).toBeCloseTo(0.01, 6);
    for (let i = 0; i < kernels.n; i++) expect(v[i]).toBeGreaterThanOrEqual(0.01 - 1e-9);
  });

  it('roadshow: local + steep spill-over, no global effect', () => {
    const e = computeEffects([act('A', 'roadshow', 1, T0)], kernels, cfg, tl1, map, 1);
    const v = e.get('A') as Float64Array;
    expect(v[idx(1)]).toBeCloseTo(1.5, 6);
    expect(v[idx(2)]).toBeCloseTo(0.6, 6);
    expect(v[idx(4)]).toBe(0);
    expect(v[idx(8)]).toBe(0);
  });

  it('applies the time multiplier and is additive', () => {
    const e = computeEffects(
      [act('A', 'rally', 1, T0 + 599_999), act('A', 'rally', 1, T0 + 599_999), act('B', 'roadshow', 4, T0 + 300_000)],
      kernels, cfg, tl1, map, 1,
    );
    expect((e.get('A') as Float64Array)[idx(1)]).toBeCloseTo(2 * 1.01 * 1.2, 4);
    expect((e.get('B') as Float64Array)[idx(4)]).toBeCloseTo(1.5 * 1.1, 6);
  });

  it('freezes seats whose phase has closed (at or before the action ts)', () => {
    // 3 phases: phase 0 = seats 1,2,3 closes at T0+200000
    const late = T0 + 250_000;
    const e = computeEffects([act('A', 'rally', 4, late)], kernels, cfg, tl3, map, 3);
    const v = e.get('A') as Float64Array;
    expect(v[idx(1)]).toBe(0);
    expect(v[idx(2)]).toBe(0);
    expect(v[idx(3)]).toBe(0); // frozen even though it would receive spill-over
    expect(v[idx(4)]).toBeGreaterThan(1);
    expect(v[idx(5)]).toBeGreaterThan(0.01); // open seat (phase 1) still gets global
    expect(v[idx(8)]).toBeGreaterThan(0);
    // exactly at the close time -> frozen too
    const e2 = computeEffects([act('A', 'rally', 4, T0 + 200_000)], kernels, cfg, tl3, map, 3);
    expect((e2.get('A') as Float64Array)[idx(1)]).toBe(0);
    // just before -> counts
    const e3 = computeEffects([act('A', 'rally', 4, T0 + 199_999)], kernels, cfg, tl3, map, 3);
    expect((e3.get('A') as Float64Array)[idx(1)]).toBeGreaterThan(0);
  });

  it('an action AT a frozen seat still feeds open seats (robustness)', () => {
    const e = computeEffects([act('A', 'rally', 1, T0 + 250_000)], kernels, cfg, tl3, map, 3);
    const v = e.get('A') as Float64Array;
    expect(v[idx(1)]).toBe(0);
    expect(v[idx(4)]).toBeCloseTo((at(1, 4) + 0.01) * timeMultiplier(cfg, tl3, T0 + 250_000), 6);
  });

  it('upTo ignores later actions; exclude ignores players', () => {
    const actions = [act('A', 'rally', 1, T0 + 10), act('A', 'rally', 1, T0 + 100), act('B', 'rally', 2, T0 + 20)];
    const e = computeEffects(actions, kernels, cfg, tl1, map, 1, { upTo: T0 + 50 });
    expect((e.get('A') as Float64Array)[idx(1)]).toBeCloseTo(1.01 * timeMultiplier(cfg, tl1, T0 + 10), 6);
    const ex = computeEffects(actions, kernels, cfg, tl1, map, 1, { exclude: new Set(['A']) });
    expect(ex.has('A')).toBe(false);
    expect(ex.has('B')).toBe(true);
    const none = computeEffects(actions, kernels, cfg, tl1, map, 1, { upTo: T0 - 1 });
    expect(none.size).toBe(0);
  });

  it('ignores actions on unknown seats', () => {
    const e = computeEffects([act('A', 'rally', 999, T0)], kernels, cfg, tl1, map, 1);
    expect(e.size).toBe(0);
  });
});

describe('seatShares', () => {
  const tl1 = buildTimeline(cfg, 1, T0);
  it('sums to 1 and is proportional', () => {
    const e = computeEffects(
      [act('A', 'roadshow', 1, T0), act('B', 'roadshow', 1, T0), act('B', 'roadshow', 1, T0), act('C', 'rally', 8, T0)],
      kernels, cfg, tl1, map, 1,
    );
    const s = seatShares(e, kernels, 1);
    const sum = Object.values(s).reduce((x, y) => x + y, 0);
    expect(sum).toBeCloseTo(1, 9);
    expect(s.A).toBeCloseTo(1.5 / (1.5 + 3 + 0.01), 6);
    expect(s.B).toBeCloseTo(3 / (1.5 + 3 + 0.01), 6);
  });
  it('is empty when nobody has any effect', () => {
    const e = computeEffects([act('A', 'roadshow', 8, T0)], kernels, cfg, tl1, map, 1);
    expect(seatShares(e, kernels, 1)).toEqual({});
    expect(seatShares(new Map(), kernels, 1)).toEqual({});
    expect(seatShares(e, kernels, 12345)).toEqual({});
  });
});
