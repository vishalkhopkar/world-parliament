import { describe, expect, it } from 'vitest';
import { buildKernels, buildTimeline, computeEffects, reputationView } from '../src';
import type { MapConfig } from '../src';
import { T0, TEST_CFG, act, testMap } from './helpers';

const map = testMap();
const kernels = buildKernels(map, TEST_CFG);
const tl1 = buildTimeline(TEST_CFG, 1, T0);
const tl3 = buildTimeline(TEST_CFG, 3, T0);
const view = (actions: ReturnType<typeof act>[], cfg: MapConfig = TEST_CFG, tl = tl1, phases = 1, who = 'A') => {
  const k = cfg === TEST_CFG ? kernels : buildKernels(map, cfg);
  return reputationView(computeEffects(actions, k, cfg, tl, map, phases).get(who), k, cfg);
};

describe('reputationView (own reputation shown to the player)', () => {
  it('is empty before the party has acted, or without an effect vector', () => {
    expect(view([])).toEqual({});
    expect(reputationView(undefined, kernels, TEST_CFG)).toEqual({});
  });

  it('one rally: 10 in its own seat, 0 (omitted) far away, only integers', () => {
    const v = view([act('A', 'rally', 1, T0)]);
    expect(v[1]).toBe(10);
    expect(v[6]).toBeUndefined();
    expect(v[8]).toBeUndefined();
    for (const x of Object.values(v)) expect(Number.isInteger(x)).toBe(true);
  });

  it('spill-over shows on a nearby seat (seat 3 is ~111 km away)', () => {
    const v = view([act('A', 'rally', 1, T0)]);
    expect(v[3]).toBeGreaterThan(0);
    expect(v[3]).toBeLessThan(v[1]);
  });

  it('five rallies make the global +0.01 each visible everywhere (1 on a far seat)', () => {
    const v = view(Array.from({ length: 5 }, (_, i) => act('A', 'rally', 1, T0 + i)));
    expect(v[8]).toBe(1);
  });

  it('a roadshow gives 15 locally with the test config (local 1.5)', () => {
    expect(view([act('A', 'roadshow', 1, T0)])[1]).toBe(15);
  });

  it('the first-mover bonus adds to the own seat', () => {
    const cfg: MapConfig = { ...TEST_CFG, effects: { ...TEST_CFG.effects, firstMover: { rally: 0.5, roadshow: 0 } } };
    expect(view([act('A', 'rally', 1, T0)], cfg)[1]).toBe(15);
    expect(view([act('B', 'rally', 1, T0), act('A', 'rally', 1, T0 + 1)], cfg)[1]).toBe(10);
  });

  it('rounds to the nearest integer', () => {
    const k = kernels;
    const e = new Float64Array(k.n);
    e[k.index.get(1) as number] = 0.449; e[k.index.get(2) as number] = 0.451;
    e[k.index.get(3) as number] = 0.04; e[k.index.get(4) as number] = 0.05;
    const v = reputationView(e, k, TEST_CFG);
    expect(v[1]).toBe(4);
    expect(v[2]).toBe(5);
    expect(v[3]).toBeUndefined();
    expect(v[4]).toBe(1); // 0.5 rounds up
  });

  it('uses the configured scale', () => {
    const cfg: MapConfig = { ...TEST_CFG, display: { reputationScale: 100 } };
    expect(view([act('A', 'roadshow', 1, T0)], cfg)[1]).toBe(150);
    const one: MapConfig = { ...TEST_CFG, display: { reputationScale: 1 } };
    expect(view([act('A', 'roadshow', 1, T0)], one)[1]).toBe(2); // 1.5 -> 2
  });

  it('a seat whose phase has closed keeps its value (frozen) and never decreases as actions are added', () => {
    // 3 phases: seat 1 is in phase 0, seat 8 in phase 2. Act before and after phase 0 closes.
    const early = act('A', 'rally', 1, T0);
    const late = act('A', 'rally', 8, tl3.phaseCloses[0] + 1);
    const before = view([early], TEST_CFG, tl3, 3);
    const after = view([early, late], TEST_CFG, tl3, 3);
    expect(after[1]).toBe(before[1]);
    for (const [seat, val] of Object.entries(before)) expect(after[Number(seat)]).toBeGreaterThanOrEqual(val);
    expect(after[8]).toBeGreaterThanOrEqual(10); // time multiplier lifts it a little
  });

  it("never includes another party's numbers", () => {
    const actions = [act('A', 'rally', 1, T0), act('B', 'roadshow', 6, T0 + 1)];
    expect(view(actions, TEST_CFG, tl1, 1, 'A')[6]).toBeUndefined();
    expect(view(actions, TEST_CFG, tl1, 1, 'B')[1]).toBeUndefined();
  });
});
