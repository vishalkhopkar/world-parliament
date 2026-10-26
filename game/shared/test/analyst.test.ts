import { describe, expect, it } from 'vitest';
import {
  analystPrice, analystReport, buildKernels, buildTimeline, computeEffects, createRng,
} from '../src';
import type { SeatResult } from '../src';
import type { Committed } from '../src';
import { NO_COMMITTED, PURE_CFG, T0, TEST_CFG, act, testMap } from './helpers';

const map = testMap();
const cfg = TEST_CFG;
const kernels = buildKernels(map, cfg);
const tl = buildTimeline(cfg, 1, T0);
const players = ['A', 'B', 'C'];

describe('analystPrice', () => {
  it('is linear, whole, clamped', () => {
    expect(analystPrice(cfg, 'seat', tl, T0)).toBe(cfg.analyst.seatReport.start);
    expect(analystPrice(cfg, 'seat', tl, tl.campaignEnd)).toBe(cfg.analyst.seatReport.end);
    expect(analystPrice(cfg, 'seat', tl, T0 + 300_000)).toBe(
      Math.round((cfg.analyst.seatReport.start + cfg.analyst.seatReport.end) / 2),
    );
    expect(analystPrice(cfg, 'global', tl, T0 + 300_000)).toBe(
      Math.round((cfg.analyst.globalReport.start + cfg.analyst.globalReport.end) / 2),
    );
    expect(analystPrice(cfg, 'global', tl, T0 - 100)).toBe(cfg.analyst.globalReport.start);
    expect(analystPrice(cfg, 'global', tl, tl.campaignEnd + 100_000)).toBe(cfg.analyst.globalReport.end);
    const odd = analystPrice({ ...cfg, analyst: { ...cfg.analyst, seatReport: { start: 1, end: 2 } } }, 'seat', tl, T0 + 100_000);
    expect(Number.isInteger(odd)).toBe(true);
  });
});

describe('analystReport', () => {
  const actions = [
    act('A', 'roadshow', 1, T0 + 10_000), act('A', 'roadshow', 1, T0 + 20_000),
    act('B', 'roadshow', 1, T0 + 15_000),
    act('B', 'roadshow', 4, T0 + 100_000),
    act('C', 'rally', 8, T0 + 100_000),
  ];
  const buy = T0 + 120_000;
  const asOf = buy - cfg.analyst.delayMs;
  const effects = computeEffects(actions, kernels, cfg, tl, map, 1, { upTo: asOf });

  it('seat report: every player present, ranks 1..n, fields copied, shares in [0,1]', () => {
    const r = analystReport(effects, NO_COMMITTED, kernels, cfg, 'seat', 1, [], players, asOf, buy, 123, createRng('r'));
    expect(r.scope).toBe('seat');
    expect(r.seat).toBe(1);
    expect(r.asOf).toBe(asOf);
    expect(r.purchasedAt).toBe(buy);
    expect(r.price).toBe(123);
    expect(r.entries.map((e) => e.playerId).sort()).toEqual(players);
    expect(r.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    for (let i = 0; i < r.entries.length; i++) {
      const e = r.entries[i];
      expect(e.estimate).toBeGreaterThanOrEqual(0);
      expect(e.estimate).toBeLessThanOrEqual(1);
      expect(e.margin).toBeCloseTo(cfg.analyst.noise * cfg.analyst.marginFactor, 9);
      if (i > 0) expect(r.entries[i - 1].estimate).toBeGreaterThanOrEqual(e.estimate);
    }
  });

  it('seat report: noise-free config gives true shares; asOf honoured via upTo', () => {
    const quiet = { ...PURE_CFG, analyst: { ...cfg.analyst, noise: 0 } };
    const r = analystReport(effects, NO_COMMITTED, kernels, quiet, 'seat', 1, [], players, asOf, buy, 1, createRng('q'));
    const byP = Object.fromEntries(r.entries.map((e) => [e.playerId, e.estimate]));
    // As of T0+90000 only the three roadshows in seat 1 (+ no global from C yet, since C acts at T0+100000)
    const mA = 1.5 * (1 + 0.2 * (10_000 / 600_000)) + 1.5 * (1 + 0.2 * (20_000 / 600_000));
    const mB = 1.5 * (1 + 0.2 * (15_000 / 600_000));
    expect(byP.A).toBeCloseTo(mA / (mA + mB), 6);
    expect(byP.B).toBeCloseTo(mB / (mA + mB), 6);
    expect(byP.C).toBe(0);
    // Without upTo the later actions are visible
    const later = computeEffects(actions, kernels, cfg, tl, map, 1);
    const r2 = analystReport(later, NO_COMMITTED, kernels, quiet, 'seat', 1, [], players, buy, buy, 1, createRng('q'));
    expect(r2.entries.find((e) => e.playerId === 'C')!.estimate).toBeGreaterThan(0);
  });

  it('seat report requires a seat', () => {
    expect(() => analystReport(effects, NO_COMMITTED, kernels, cfg, 'seat', undefined, [], players, asOf, buy, 1, createRng('r'))).toThrow();
  });

  it('seat with no effects: the expected split is equal (1/3 each) plus noise', () => {
    const r = analystReport(new Map(), NO_COMMITTED, kernels, cfg, 'seat', 1, [], players, asOf, buy, 1, createRng('r'));
    expect(r.entries).toHaveLength(3);
    for (const e of r.entries) expect(Math.abs(e.estimate - 1 / 3)).toBeLessThan(6 * cfg.analyst.noise + 1e-9);
    const quiet = { ...cfg, analyst: { ...cfg.analyst, noise: 0 } };
    for (const e of analystReport(new Map(), NO_COMMITTED, kernels, quiet, 'seat', 1, [], players, asOf, buy, 1, createRng('r')).entries) {
      expect(e.estimate).toBeCloseTo(1 / 3, 12);
    }
  });

  it('seat report uses the EXPECTED shares: committed voters, mean influence and mean random voters', () => {
    const quiet = { ...cfg, analyst: { ...cfg.analyst, noise: 0 } };
    const c: Committed = new Map([['A', Float64Array.from([0.3, 0, 0, 0, 0, 0, 0, 0])]]);
    const e = computeEffects([act('B', 'roadshow', 1, T0)], kernels, cfg, tl, map, 1);
    const r = analystReport(e, c, kernels, quiet, 'seat', 1, [], players, 0, 1, 1, createRng('q'));
    const byP = Object.fromEntries(r.entries.map((x) => [x.playerId, x.estimate]));
    // S0 = .7, extra_A = .3*.2 = .06, r = (.025*3)*.7 = .0525 (/3 = .0175 each), pool = .5875 all to B (only B has reputation)
    expect(byP.A).toBeCloseTo(0.3 + 0.06 + 0.0525 / 3, 12);
    expect(byP.B).toBeCloseTo(0.0525 / 3 + 0.5875, 12);
    expect(byP.C).toBeCloseTo(0.0525 / 3, 12);
  });

  it('a committed party with no effect shows its committed share when influence and random voters are off', () => {
    const quiet = { ...PURE_CFG, analyst: { ...cfg.analyst, noise: 0 } };
    const c: Committed = new Map([['A', Float64Array.from([0.3, 0, 0, 0, 0, 0, 0, 0])]]);
    const r = analystReport(new Map([['B', Float64Array.from([1, 0, 0, 0, 0, 0, 0, 0])]]), c, kernels, quiet, 'seat', 1, [], players, 0, 1, 1, createRng('q'));
    const byP = Object.fromEntries(r.entries.map((x) => [x.playerId, x.estimate]));
    expect(byP.A).toBeCloseTo(0.3, 12);
    expect(byP.B).toBeCloseTo(0.7, 12);
    expect(byP.C).toBe(0);
  });

  it('global report: noise-free counts open seats by argmax plus decided winners', () => {
    const quiet = { ...PURE_CFG, analyst: { ...cfg.analyst, noise: 0 } };
    const decided: SeatResult[] = [
      { seat: 5, phase: 0, winner: 'C', shares: { C: 1 } },
      { seat: 6, phase: 0, winner: 'C', shares: { C: 1 } },
      { seat: 8, phase: 0, winner: 'B', shares: { B: 1 } },
    ];
    const r = analystReport(effects, NO_COMMITTED, kernels, quiet, 'global', undefined, decided, players, asOf, buy, 77, createRng('g'));
    expect(r.scope).toBe('global');
    expect(r.seat).toBeUndefined();
    expect(r.price).toBe(77);
    const byP = Object.fromEntries(r.entries.map((e) => [e.playerId, e.estimate]));
    // Open seats 1,2,3,4,7. A: leads 1 (A 2 roadshows vs B 1) -> 1, 2 (cap 0.4*1.5 each: A 2*0.6 vs B 0.6) -> A, 7 (A) -> A,
    // 3: 111km roadshow ~0.115 each, A 2x -> A. Seat 4: B roadshow at T0+100000 is after asOf -> not visible: nobody has
    // reputation there, the expected split is equal and the tie goes to the first player (A).
    expect(byP.A).toBe(5);
    expect(byP.B).toBe(1); // decided seat 8
    expect(byP.C).toBe(2);
    expect(r.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(r.entries[0].playerId).toBe('A');
    for (const e of r.entries) expect(e.margin).toBeGreaterThanOrEqual(1);
  });

  it('global report: a seat where a party is committed goes to it even without reputation anywhere', () => {
    const quiet = { ...cfg, analyst: { ...cfg.analyst, noise: 0 } };
    const c: Committed = new Map([['C', Float64Array.from([0, 0.2, 0, 0, 0, 0, 0, 0])]]);
    const r = analystReport(new Map(), c, kernels, quiet, 'global', undefined, [], players, 0, 1, 1, createRng('g'));
    const byP = Object.fromEntries(r.entries.map((x) => [x.playerId, x.estimate]));
    expect(byP).toEqual({ A: 7, B: 0, C: 1 }); // seat 2 -> C, the other 7 tie -> first player A
  });

  it('global report: noisy estimates are whole numbers >= 0; margin = max(1, round(est*noise*factor))', () => {
    const wide = { ...cfg, analyst: { ...cfg.analyst, noise: 0.2, marginFactor: 2 } };
    const e = computeEffects(actions, kernels, wide, tl, map, 1);
    const r = analystReport(e, NO_COMMITTED, kernels, wide, 'global', undefined, [], players, buy, buy, 1, createRng('z'));
    for (const en of r.entries) {
      expect(Number.isInteger(en.estimate)).toBe(true);
      expect(en.estimate).toBeGreaterThanOrEqual(0);
      expect(en.margin).toBe(Math.max(1, Math.round(en.estimate * 0.2 * 2)));
    }
    expect(r.entries.map((x) => x.rank)).toEqual([1, 2, 3]);
  });

  it('is deterministic per rng seed', () => {
    const a = analystReport(effects, NO_COMMITTED, kernels, cfg, 'global', undefined, [], players, asOf, buy, 1, createRng('d'));
    const b = analystReport(effects, NO_COMMITTED, kernels, cfg, 'global', undefined, [], players, asOf, buy, 1, createRng('d'));
    expect(a).toEqual(b);
  });
});
