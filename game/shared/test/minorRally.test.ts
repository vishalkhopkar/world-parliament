// Rule: a minor rally is a local rally with half the peak and a tighter cut-off, no global part, hidden like a roadshow. It has its own
// kernel, its own explicit branch in computeEffects and its own first-mover bonus; an action of any type the engine does not know is ignored
// (it used to fall into the roadshow branch).
import { describe, expect, it } from 'vitest';
import { buildKernels, buildTimeline, computeEffects, reputationView, timeMultiplier } from '../src';
import type { Action, MapConfig } from '../src';
import { T0, TEST_CFG, act, testMap } from './helpers';

const map = testMap();
const cfg: MapConfig = TEST_CFG; // minorRally: local 0.5, spread 1.0, 300 km; rally local 1.0 + global 0.01; roadshow 1.5 (150 km)
const kernels = buildKernels(map, cfg);
const idx = (id: number) => kernels.index.get(id) as number;
const tl = buildTimeline(cfg, 1, T0);
const tl3 = buildTimeline(cfg, 3, T0);
const eff = (actions: Action[], c: MapConfig = cfg, opts = {}, t = tl, phases = 1) =>
  computeEffects(actions, buildKernels(map, c), c, t, map, phases, opts);
const at = (e: ReturnType<typeof eff>, p: string, seat: number) => (e.get(p) as Float64Array)[idx(seat)];
const mult = (ts: number) => timeMultiplier(cfg, tl, ts);
const km = (a: number, b: number) => kernels.distanceKm[idx(a) * kernels.n + idx(b)];

describe('the minor rally kernel', () => {
  it('has the peak on its own seat and local x exp(-spread x (km / unit)^2) elsewhere, exactly 0 beyond the cut-off', () => {
    const n = kernels.n;
    expect(kernels.minorRally).toHaveLength(n * n);
    expect(kernels.minorRally[idx(1) * n + idx(1)]).toBeCloseTo(0.5, 6);
    const d3 = km(1, 3); // ~111 km
    expect(kernels.minorRally[idx(1) * n + idx(3)]).toBeCloseTo(0.5 * Math.exp(-1.0 * (d3 / 100) ** 2), 5);
    expect(km(1, 4)).toBeGreaterThan(300); // ~334 km: beyond the cut-off
    expect(kernels.minorRally[idx(1) * n + idx(4)]).toBe(0);
    expect(kernels.minorRally[idx(1) * n + idx(8)]).toBe(0);
  });

  it('is symmetric and reaches less far than the major rally', () => {
    const n = kernels.n;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        expect(kernels.minorRally[i * n + j]).toBe(kernels.minorRally[j * n + i]);
        if (kernels.minorRally[i * n + j] > 0) expect(kernels.rally[i * n + j]).toBeGreaterThan(0);
      }
    }
  });

  it('follows the config: another peak, spread and cut-off give another kernel', () => {
    const wide: MapConfig = { ...cfg, effects: { ...cfg.effects, minorRally: { local: 2, decay: { spread: 0.1, maxKm: 800 } } } };
    const k = buildKernels(map, wide);
    expect(k.minorRally[idx(1) * k.n + idx(1)]).toBeCloseTo(2, 6);
    expect(k.minorRally[idx(1) * k.n + idx(4)]).toBeCloseTo(2 * Math.exp(-0.1 * (km(1, 4) / 100) ** 2), 5);
    expect(k.minorRally[idx(1) * k.n + idx(5)]).toBeCloseTo(2 * Math.exp(-0.1 * (km(1, 5) / 100) ** 2), 5); // ~667 km, inside 800
    expect(k.minorRally[idx(1) * k.n + idx(6)]).toBe(0);
  });

  it('leaves the rally and roadshow kernels as they were', () => {
    expect(kernels.rally[idx(1) * kernels.n + idx(1)]).toBeCloseTo(1.0, 6);
    expect(kernels.roadshow[idx(1) * kernels.n + idx(1)]).toBeCloseTo(1.5, 6);
    expect(kernels.roadshow[idx(1) * kernels.n + idx(4)]).toBe(0); // 334 km: beyond the roadshow cut-off
  });
});

describe('computeEffects with a minor rally', () => {
  it('adds the minor rally kernel row times the time multiplier, with no global part anywhere', () => {
    const e = eff([act('A', 'minorRally', 1, T0)]);
    const m = mult(T0);
    expect(at(e, 'A', 1)).toBeCloseTo(0.5 * m, 6);
    expect(at(e, 'A', 3)).toBeCloseTo(kernels.minorRally[idx(1) * kernels.n + idx(3)] * m, 6);
    for (const far of [4, 5, 6, 8]) expect(at(e, 'A', far)).toBe(0); // no spill-over and no global constant
  });

  it('is not a rally: no global 0.01 floor, no rally spill-over, and it is not a roadshow either', () => {
    const minor = eff([act('A', 'minorRally', 1, T0)]);
    const rally = eff([act('A', 'rally', 1, T0)]);
    const road = eff([act('A', 'roadshow', 1, T0)]);
    expect(at(rally, 'A', 8)).toBeGreaterThan(0);
    expect(at(minor, 'A', 8)).toBe(0);
    expect(at(minor, 'A', 1)).not.toBeCloseTo(at(road, 'A', 1), 3);
    expect(at(minor, 'A', 1)).not.toBeCloseTo(at(rally, 'A', 1), 3);
    expect(at(minor, 'A', 3)).toBeGreaterThan(0); // spill-over a roadshow (150 km, spread 2.8) hardly has
  });

  it('the effects of several actions add up per type, and the time multiplier is that of each action', () => {
    const e = eff([act('A', 'minorRally', 1, T0), act('A', 'minorRally', 1, T0 + 300_000), act('A', 'roadshow', 1, T0 + 100_000)]);
    expect(at(e, 'A', 1)).toBeCloseTo(0.5 * mult(T0) + 0.5 * mult(T0 + 300_000) + 1.5 * mult(T0 + 100_000), 6);
  });

  it('does not touch seats whose phase has closed, and keeps the contribution to the open ones', () => {
    // 3 phases: seats 1-3 close at T0+200000, 4-6 at T0+400000. A minor rally on seat 3 at T0+210000 reaches seat 1,2,3 only (closed) -> nothing.
    const late = T0 + 210_000;
    const e = eff([act('A', 'minorRally', 3, late)], cfg, {}, tl3, 3);
    expect(e.get('A') === undefined || [1, 2, 3].every((s) => at(e, 'A', s) === 0)).toBe(true);
    // a minor rally on seat 3 reaches seat 4 (222 km, still open at that time): the open seat gets its share
    const e2 = eff([act('A', 'minorRally', 3, T0 + 10)], cfg, {}, tl3, 3);
    expect(at(e2, 'A', 4)).toBeGreaterThan(0);
  });

  it('ignores a minor rally after upTo and one by an excluded player', () => {
    expect(eff([act('A', 'minorRally', 1, T0 + 1000)], cfg, { upTo: T0 + 500 }).get('A')).toBeUndefined();
    expect(eff([act('A', 'minorRally', 1, T0)], cfg, { exclude: new Set(['A']) }).get('A')).toBeUndefined();
  });

  it('shows the player the own reputation in the minor rally seat as round(effect x scale)', () => {
    const e = eff([act('A', 'minorRally', 1, T0)]);
    const v = reputationView(e.get('A'), kernels, cfg);
    expect(v[1]).toBe(Math.round(0.5 * mult(T0) * 10));
  });

  it('an action of an unknown type earns nothing (it is no longer treated as a roadshow) and claims no first mover bonus', () => {
    const fm: MapConfig = { ...cfg, effects: { ...cfg.effects, firstMover: { rally: 1, roadshow: 1, minorRally: 1 } } };
    const bogus = { id: 'x', playerId: 'A', type: 'speech', seat: 1, ts: T0 } as unknown as Action;
    const e = eff([bogus, act('B', 'roadshow', 1, T0 + 10)], fm);
    expect(e.get('A') === undefined || at(e, 'A', 1) === 0).toBe(true);
    expect(at(e, 'B', 1)).toBeCloseTo(1.5 * mult(T0 + 10) + 1, 6); // B is still the first mover
  });
});

describe('first mover advantage with the minor rally', () => {
  const fm: MapConfig = { ...cfg, effects: { ...cfg.effects, firstMover: { rally: 0.5, roadshow: 2, minorRally: 0.7 } } };

  it('the first minor rally in a seat gets the minor rally bonus on that seat only', () => {
    const e = eff([act('A', 'minorRally', 1, T0)], fm);
    expect(at(e, 'A', 1)).toBeCloseTo(0.5 * mult(T0) + 0.7, 6);
    const spill = kernels.minorRally[idx(1) * kernels.n + idx(3)];
    expect(at(e, 'A', 3)).toBeCloseTo(spill * mult(T0), 6); // a neighbour gets no bonus
  });

  it('the bonus depends on the action that was first: a minor rally after a roadshow earns none, a roadshow after a minor rally none', () => {
    const e = eff([act('A', 'roadshow', 1, T0), act('B', 'minorRally', 1, T0 + 1000)], fm);
    expect(at(e, 'A', 1)).toBeCloseTo(1.5 * mult(T0) + 2, 6);
    expect(at(e, 'B', 1)).toBeCloseTo(0.5 * mult(T0 + 1000), 6);
    const f = eff([act('A', 'minorRally', 1, T0), act('B', 'roadshow', 1, T0 + 1000)], fm);
    expect(at(f, 'A', 1)).toBeCloseTo(0.5 * mult(T0) + 0.7, 6);
    expect(at(f, 'B', 1)).toBeCloseTo(1.5 * mult(T0 + 1000), 6);
  });

  it('any rally or roadshow in a seat counts as the first action there, also a major rally before a minor one', () => {
    const e = eff([act('A', 'rally', 1, T0), act('A', 'minorRally', 1, T0 + 1000)], fm);
    expect(at(e, 'A', 1)).toBeCloseTo(1.01 * mult(T0) + 0.5 + 0.5 * mult(T0 + 1000), 6); // the rally bonus 0.5, not 0.7
  });

  it('the minor rally bonus alone switches the first mover on (rally and roadshow bonus 0)', () => {
    const only: MapConfig = { ...cfg, effects: { ...cfg.effects, firstMover: { rally: 0, roadshow: 0, minorRally: 0.7 } } };
    const e = eff([act('A', 'minorRally', 1, T0)], only);
    expect(at(e, 'A', 1)).toBeCloseTo(0.5 * mult(T0) + 0.7, 6);
  });

  it('is not multiplied by the time bonus, and bonus 0 changes nothing', () => {
    const late = T0 + 590_000;
    expect(at(eff([act('A', 'minorRally', 1, late)], fm), 'A', 1) - 0.5 * mult(late)).toBeCloseTo(0.7, 6);
    const off: MapConfig = { ...cfg, effects: { ...cfg.effects, firstMover: { rally: 0.5, roadshow: 2, minorRally: 0 } } };
    expect(at(eff([act('A', 'minorRally', 1, T0)], off), 'A', 1)).toBeCloseTo(0.5 * mult(T0), 6);
  });

  it('passes to the next party when the first mover is excluded (eliminated)', () => {
    const e = eff([act('A', 'minorRally', 1, T0), act('B', 'minorRally', 1, T0 + 1000)], fm, { exclude: new Set(['A']) });
    expect(at(e, 'B', 1)).toBeCloseTo(0.5 * mult(T0 + 1000) + 0.7, 6);
  });
});
