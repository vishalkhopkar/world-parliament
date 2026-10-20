import { describe, expect, it } from 'vitest';
import { buildKernels, buildTimeline, computeEffects, timeMultiplier } from '../src';
import type { MapConfig } from '../src';
import { T0, TEST_CFG, act, testMap } from './helpers';

const map = testMap();
const cfg: MapConfig = { ...TEST_CFG, effects: { ...TEST_CFG.effects, firstMover: { rally: 0.5, roadshow: 2 } } };
const kernels = buildKernels(map, cfg);
const idx = (id: number) => kernels.index.get(id) as number;
const tl1 = buildTimeline(cfg, 1, T0);
const tl3 = buildTimeline(cfg, 3, T0);
type Eff = ReturnType<typeof computeEffects>;
const eff = (actions: ReturnType<typeof act>[], opts = {}, tl = tl1, phases = 1): Eff =>
  computeEffects(actions, kernels, cfg, tl, map, phases, opts);
const at = (e: Eff, p: string, seat: number) => (e.get(p) as Float64Array)[idx(seat)];
const mult = (ts: number) => timeMultiplier(cfg, tl1, ts);

describe('first mover advantage', () => {
  it('the first rally in a seat gets the rally bonus on that seat only, on top of the normal effect', () => {
    const e = eff([act('A', 'rally', 1, T0)]);
    expect(at(e, 'A', 1)).toBeCloseTo((1 + 0.01) * mult(T0) + 0.5, 6);
    // neighbour seat 3: spill-over + global only, no bonus
    const spill = kernels.rally[idx(1) * kernels.n + idx(3)];
    expect(at(e, 'A', 3)).toBeCloseTo((spill + 0.01) * mult(T0), 6);
    expect(at(e, 'A', 6)).toBeCloseTo(0.01 * mult(T0), 6);
  });

  it('the first roadshow in a seat gets the roadshow bonus', () => {
    const e = eff([act('A', 'roadshow', 1, T0)]);
    expect(at(e, 'A', 1)).toBeCloseTo(1.5 * mult(T0) + 2, 6);
  });

  it('only the very first party gets it: a later rival gets the plain effect', () => {
    const e = eff([act('A', 'roadshow', 1, T0), act('B', 'roadshow', 1, T0 + 1000), act('B', 'rally', 1, T0 + 2000)]);
    expect(at(e, 'A', 1)).toBeCloseTo(1.5 * mult(T0) + 2, 6);
    expect(at(e, 'B', 1)).toBeCloseTo(1.5 * mult(T0 + 1000) + 1.01 * mult(T0 + 2000), 6);
  });

  it('the first mover is the first party to do EITHER action, and gets the bonus once', () => {
    const e = eff([act('A', 'rally', 1, T0), act('A', 'roadshow', 1, T0 + 1000), act('A', 'rally', 1, T0 + 2000)]);
    const plain = 1.01 * mult(T0) + 1.5 * mult(T0 + 1000) + 1.01 * mult(T0 + 2000);
    expect(at(e, 'A', 1)).toBeCloseTo(plain + 0.5, 6); // the bonus of the FIRST action (a rally) only
  });

  it('each seat has its own first mover', () => {
    const e = eff([act('A', 'roadshow', 1, T0), act('B', 'roadshow', 3, T0 + 5)]);
    expect(at(e, 'B', 3)).toBeCloseTo(1.5 * mult(T0 + 5) + 2, 6);
    const spill = kernels.roadshow[idx(1) * kernels.n + idx(3)];
    expect(at(e, 'A', 3)).toBeCloseTo(spill * mult(T0), 6); // A is not first in seat 3: spill-over only
  });

  it('is decided by timestamp, not by the order of the actions array', () => {
    const e = eff([act('B', 'roadshow', 1, T0 + 500), act('A', 'roadshow', 1, T0 + 100)]);
    expect(at(e, 'A', 1)).toBeCloseTo(1.5 * mult(T0 + 100) + 2, 6);
    expect(at(e, 'B', 1)).toBeCloseTo(1.5 * mult(T0 + 500), 6);
  });

  it('is not multiplied by the time bonus', () => {
    const late = T0 + 590_000;
    const e = eff([act('A', 'roadshow', 1, late)]);
    expect(at(e, 'A', 1) - 1.5 * mult(late)).toBeCloseTo(2, 6);
  });

  it('ignores actions after upTo (a delayed analyst report sees the earlier first mover)', () => {
    const actions = [act('A', 'roadshow', 1, T0 + 10), act('B', 'roadshow', 1, T0 + 1000)];
    const e = eff(actions, { upTo: T0 + 500 });
    expect(at(e, 'A', 1)).toBeCloseTo(1.5 * mult(T0 + 10) + 2, 6);
    expect(e.get('B')).toBeUndefined();
    const later = eff([act('A', 'roadshow', 1, T0 + 1000), act('B', 'roadshow', 1, T0 + 2000)], { upTo: T0 + 1500 });
    expect(at(later, 'A', 1)).toBeCloseTo(1.5 * mult(T0 + 1000) + 2, 6);
  });

  it('passes to the next party when the first mover is excluded (eliminated)', () => {
    const actions = [act('A', 'roadshow', 1, T0), act('B', 'roadshow', 1, T0 + 1000)];
    const e = eff(actions, { exclude: new Set(['A']) });
    expect(at(e, 'B', 1)).toBeCloseTo(1.5 * mult(T0 + 1000) + 2, 6);
  });

  it('an action on a frozen seat earns nothing and does not claim first mover', () => {
    // 3 phases: seat 4 closes at T0+400000; an action at T0+410000 does not touch seat 4
    const late = T0 + 410_000;
    const e = eff([act('A', 'roadshow', 4, late)], {}, tl3, 3);
    expect(e.get('A') === undefined || at(e, 'A', 4) === 0).toBe(true);
  });

  it('a seat still open at the time of the action counts', () => {
    const e = eff([act('A', 'roadshow', 4, T0 + 100)], {}, tl3, 3);
    expect(at(e, 'A', 4)).toBeCloseTo(1.5 * timeMultiplier(cfg, tl3, T0 + 100) + 2, 6);
  });

  it('bonus 0 changes nothing', () => {
    const off: MapConfig = { ...cfg, effects: { ...cfg.effects, firstMover: { rally: 0, roadshow: 0 } } };
    const k = buildKernels(map, off);
    const actions = [act('A', 'rally', 1, T0), act('B', 'roadshow', 1, T0 + 10)];
    const e = computeEffects(actions, k, off, tl1, map, 1);
    expect((e.get('A') as Float64Array)[idx(1)]).toBeCloseTo(1.01 * mult(T0), 6);
    expect((e.get('B') as Float64Array)[idx(1)]).toBeCloseTo(1.5 * mult(T0 + 10), 6);
  });
});
