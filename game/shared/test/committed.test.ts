import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG, buildKernels, committedMatrix, committedTotals, committedView, createRng, dealCommitted } from '../src';
import type { CommittedSet, GameMapPackage, GameMapSeat } from '../src';
import { TEST_CFG, testMap } from './helpers';

const gameJson = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../maps/world-500/site/data/game.json');
const world = JSON.parse(fs.readFileSync(gameJson, 'utf8')) as GameMapPackage;
const cfg = WORLD_CONFIG;
const kernels = buildKernels(world, cfg);
const neigh = new Map(world.seats.map((s) => [s.id, s.neighbours]));
const bands = cfg.committed.bands;
const perBand = (set: CommittedSet) => bands.map((_, b) => set.seats.filter((s) => s.band === b + 1).length);

function dealAll(n: number, seed: string, c = cfg, k = kernels, map = world): CommittedSet[] {
  const rng = createRng(seed);
  const sets: CommittedSet[] = [];
  for (let i = 0; i < n; i++) sets.push(dealCommitted(map, k, c, sets, rng));
  return sets;
}
/** Is the seat list connected through map neighbours (using only these seats)? */
function connected(ids: number[]): boolean {
  const left = new Set(ids);
  const stack = [ids[0]];
  left.delete(ids[0]);
  while (stack.length) {
    for (const j of neigh.get(stack.pop() as number) ?? []) if (left.delete(j)) stack.push(j);
  }
  return left.size === 0;
}
function chainMap(n: number): GameMapPackage {
  const seats: GameMapSeat[] = [];
  for (let i = 1; i <= n; i++) seats.push({ id: i, lon: i, lat: 0, x: i, y: 0, neighbours: [i - 1, i + 1].filter((j) => j >= 1 && j <= n) });
  return { mapId: 'chain', version: 1, seatCount: n, seats, phaseGroups: { '1': [seats.map((s) => s.id)] }, topo: { coarse: 'x' } };
}

describe('world-500 map graph', () => {
  it('has 500 seats and every seat is reachable from seat 1', () => {
    expect(world.seats).toHaveLength(500);
    const seen = new Set([1]);
    const stack = [1];
    while (stack.length) for (const j of neigh.get(stack.pop() as number) ?? []) if (!seen.has(j)) { seen.add(j); stack.push(j); }
    expect(seen.size).toBe(500);
  });
  it('the configured bands add up to 87 seats and the cap fits at least two bands', () => {
    expect(bands.reduce((a, b) => a + b.seats, 0)).toBe(87);
    expect(cfg.committed.seatMaxPercent).toBeGreaterThanOrEqual(bands[0].percent + bands[1].percent);
  });
});

describe('dealCommitted on world-500', () => {
  it('one player: core first, band 1 = core + the 4 nearest BFS seats, connected, bands in the configured counts', () => {
    const [set] = dealAll(1, 'one');
    expect(set.seats[0]).toEqual({ seat: set.core, band: 1 });
    expect(perBand(set)).toEqual(bands.map((b) => b.seats));
    expect(new Set(set.seats.map((s) => s.seat)).size).toBe(87); // no seat twice
    // bands appear in order along the walk
    const order = set.seats.map((s) => s.band);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const band1 = set.seats.filter((s) => s.band === 1).map((s) => s.seat);
    expect(connected(band1)).toBe(true);
    const nb = neigh.get(set.core) as number[];
    const ci = kernels.index.get(set.core) as number;
    const d = (id: number) => kernels.distanceKm[ci * kernels.n + (kernels.index.get(id) as number)];
    // with >= 4 neighbours the 4 band-1 seats after the core are exactly the 4 nearest neighbours
    if (nb.length >= 4) {
      const nearest = [...nb].sort((a, b) => d(a) - d(b)).slice(0, 4);
      expect([...band1.slice(1)].sort((a, b) => a - b)).toEqual(nearest.sort((a, b) => a - b));
    }
    // inside the first BFS level the walk is by increasing distance
    const firstLevel = set.seats.slice(1).map((s) => s.seat).filter((id) => nb.includes(id));
    for (let i = 1; i < firstLevel.length; i++) expect(d(firstLevel[i])).toBeGreaterThanOrEqual(d(firstLevel[i - 1]));
  });

  it('two players get exactly 87 seats each and different cores', () => {
    const sets = dealAll(2, 'two');
    for (const s of sets) { expect(s.seats).toHaveLength(87); expect(perBand(s)).toEqual(bands.map((b) => b.seats)); }
    expect(sets[0].core).not.toBe(sets[1].core);
  });

  it('ten players dealt one after the other: distinct cores, <= 87 seats each, no seat above the cap, bands in order', () => {
    const sets = dealAll(10, 'ten');
    expect(new Set(sets.map((s) => s.core)).size).toBe(10);
    for (const s of sets) {
      expect(s.seats.length).toBeLessThanOrEqual(87);
      expect(s.seats.length).toBeGreaterThan(40);
      perBand(s).forEach((c, b) => expect(c).toBeLessThanOrEqual(bands[b].seats));
      const order = s.seats.map((x) => x.band);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(new Set(s.seats.map((x) => x.seat)).size).toBe(s.seats.length);
    }
    for (const v of committedTotals(sets, cfg).values()) expect(v).toBeLessThanOrEqual(cfg.committed.seatMaxPercent);
  });

  it('is deterministic for the same seed and differs between seeds', () => {
    expect(dealAll(4, 'same')).toEqual(dealAll(4, 'same'));
    expect(dealAll(4, 'same')).not.toEqual(dealAll(4, 'other'));
  });

  it('cores are spread: 200 single deals hit many different seats', () => {
    const rng = createRng('cores');
    const cores = new Set<number>();
    for (let i = 0; i < 200; i++) cores.add(dealCommitted(world, kernels, cfg, [], rng).core);
    expect(cores.size).toBeGreaterThan(120);
  });
});

describe('dealCommitted edge cases', () => {
  it('small maps: bands come out shorter, never an error', () => {
    const k = buildKernels(testMap(), TEST_CFG);
    const set = dealCommitted(testMap(), k, TEST_CFG, [], createRng('t')); // testMap has no neighbours: only the core
    expect(set.seats).toEqual([{ seat: set.core, band: 1 }]);
    const chain = chainMap(6);
    const kc = buildKernels(chain, cfg);
    const s2 = dealCommitted(chain, kc, cfg, [], createRng('c'));
    expect(s2.seats.map((x) => x.band)).toEqual([1, 1, 1, 1, 1, 2]); // 6 seats: band 1 takes 5, band 2 the last one
    expect(new Set(s2.seats.map((x) => x.seat)).size).toBe(6);
  });

  it('walks outward along a chain: distance from the core never decreases', () => {
    const chain = chainMap(30);
    const kc = buildKernels(chain, cfg);
    for (let t = 0; t < 20; t++) {
      const set = dealCommitted(chain, kc, cfg, [], createRng('w' + t));
      const ids = set.seats.map((s) => s.seat);
      expect(ids[0]).toBe(set.core);
      const dist = ids.map((id) => Math.abs(id - set.core));
      for (let i = 1; i < dist.length; i++) expect(dist[i]).toBeGreaterThanOrEqual(dist[i - 1]);
    }
  });

  it('throws when every seat is already the core of another party', () => {
    const chain = chainMap(3);
    const kc = buildKernels(chain, cfg);
    const sets = dealAll(3, 'full', cfg, kc, chain);
    expect(sets.map((s) => s.core).sort()).toEqual([1, 2, 3]);
    expect(() => dealCommitted(chain, kc, cfg, sets, createRng('x'))).toThrow();
  });

  it('seats whose total would pass the cap are skipped (the walk goes through them)', () => {
    const chain = chainMap(12);
    const kc = buildKernels(chain, cfg);
    const tight = { ...cfg, committed: { ...cfg.committed, seatMaxPercent: 40 } };
    const sets = dealAll(3, 'cap', tight, kc, chain);
    for (const v of committedTotals(sets, tight).values()) expect(v).toBeLessThanOrEqual(40);
    // a seat holding 30% from another party cannot take a 30% / 25% band: only bands <= 10% fit there
    const held = { core: 99, seats: [{ seat: 6, band: 1 }] };
    for (let t = 0; t < 30; t++) {
      const mine = dealCommitted(chain, kc, tight, [held], createRng('o' + t));
      const onHeld = mine.seats.find((s) => s.seat === 6);
      if (onHeld) expect(bands[onHeld.band - 1].percent).toBeLessThanOrEqual(10);
      expect(mine.seats.length).toBeGreaterThan(5); // the walk passed through seat 6 and went on
    }
  });

  it('a band with percent 0 is allowed', () => {
    const zero = { ...cfg, committed: { ...cfg.committed, bands: [{ percent: 0, seats: 3, level: 'LOW' as const }, ...bands] } };
    const chain = chainMap(10);
    const kc = buildKernels(chain, zero);
    const set = dealCommitted(chain, kc, zero, [], createRng('z'));
    expect(set.seats.slice(0, 3).every((s) => s.band === 1)).toBe(true);
    const row = committedMatrix([['p', set]], kc, zero).get('p') as Float64Array;
    expect(row[(kc.index.get(set.core) as number)]).toBe(0);
  });
});

describe('committedMatrix / committedView / committedTotals', () => {
  const set: CommittedSet = { core: 7, seats: [{ seat: 7, band: 1 }, { seat: 8, band: 2 }, { seat: 9, band: 6 }] };
  it('matrix holds fractions (percent / 100) per player and seat index', () => {
    const m = committedMatrix([['A', set], ['B', { core: 1, seats: [{ seat: 7, band: 3 }] }]], kernels, cfg);
    const a = m.get('A') as Float64Array;
    const i7 = kernels.index.get(7) as number;
    expect(a[i7]).toBeCloseTo(bands[0].percent / 100, 12);
    expect(a[kernels.index.get(8) as number]).toBeCloseTo(bands[1].percent / 100, 12);
    expect(a[kernels.index.get(9) as number]).toBeCloseTo(bands[5].percent / 100, 12);
    expect(a.reduce((x, y) => x + y, 0)).toBeCloseTo((bands[0].percent + bands[1].percent + bands[5].percent) / 100, 12);
    expect((m.get('B') as Float64Array)[i7]).toBeCloseTo(bands[2].percent / 100, 12);
    expect(a).toHaveLength(kernels.n);
  });
  it('view maps band -> percent and level, [] when nothing dealt', () => {
    expect(committedView(undefined, cfg)).toEqual([]);
    expect(committedView(set, cfg)).toEqual([
      { seat: 7, band: 1, percent: 30, level: 'HIGH' },
      { seat: 8, band: 2, percent: 25, level: 'HIGH' },
      { seat: 9, band: 6, percent: 5, level: 'LOW' },
    ]);
  });
  it('totals add the percents of all sets per seat', () => {
    const t = committedTotals([set, { core: 8, seats: [{ seat: 7, band: 3 }, { seat: 20, band: 1 }] }], cfg);
    expect(t.get(7)).toBe(30 + 20);
    expect(t.get(20)).toBe(30);
    expect(t.get(8)).toBe(25);
  });
});
