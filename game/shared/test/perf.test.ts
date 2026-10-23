import { describe, expect, it } from 'vitest';
import {
  WORLD_CONFIG, buildKernels, buildTimeline, computeEffects, createRng, pollSeats, seatShares, tallySeats,
} from '../src';
import type { Action, GameMapPackage, GameMapSeat } from '../src';

describe('performance smoke (500 seats, 5000 actions)', () => {
  const rng = createRng('perf');
  const seats: GameMapSeat[] = [];
  for (let i = 1; i <= 500; i++) {
    const lon = rng() * 360 - 180;
    const lat = rng() * 140 - 70;
    seats.push({ id: i, lon, lat, x: lon, y: lat, neighbours: [] });
  }
  const ids = seats.map((s) => s.id);
  const map: GameMapPackage = {
    mapId: 'perf', version: 1, seatCount: 500, seats,
    phaseGroups: { '3': [ids.slice(0, 170), ids.slice(170, 340), ids.slice(340)] },
    topo: { coarse: 'x' },
  };
  const cfg = WORLD_CONFIG;
  const T0 = 0;
  const tl = buildTimeline(cfg, 3, T0);

  it('buildKernels < 1s', () => {
    const t = performance.now();
    const k = buildKernels(map, cfg);
    const dt = performance.now() - t;
    expect(k.n).toBe(500);
    expect(k.rally.length).toBe(250_000);
    expect(dt).toBeLessThan(2000);
    console.log(`buildKernels: ${dt.toFixed(0)} ms`);
  });

  it('computeEffects(5000 actions) + polling < 2s total', () => {
    const k = buildKernels(map, cfg);
    const actions: Action[] = [];
    const players = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    for (let i = 0; i < 5000; i++) {
      actions.push({
        id: `a${i}`, playerId: players[Math.floor(rng() * players.length)],
        type: rng() < 0.4 ? 'rally' : 'roadshow', seat: 1 + Math.floor(rng() * 500), ts: Math.floor(rng() * 600_000),
      });
    }
    actions.sort((a, b) => a.ts - b.ts);
    const t = performance.now();
    const e = computeEffects(actions, k, cfg, tl, map, 3);
    const dt = performance.now() - t;
    console.log(`computeEffects: ${dt.toFixed(0)} ms`);
    expect(dt).toBeLessThan(2000);
    const res = pollSeats(e, new Map(), players, k, cfg, ids, 0, createRng('poll'));
    const tally = tallySeats(res);
    expect(Object.values(tally).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(500);
    expect(Math.abs(Object.values(seatShares(e, k, 7)).reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-9);
  });
});
