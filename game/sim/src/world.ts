import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKernels } from '@hp/shared';
import type { GameMapPackage, Kernels, MapConfig } from '@hp/shared';

export function loadMap(): GameMapPackage {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.resolve(here, '../../../maps/world-500/site/data/game.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as GameMapPackage;
}

/** Sparse row of a kernel: seats j with weight > 0. */
export interface SparseRow { idx: Int32Array; w: Float32Array }

/** Everything the sim precomputes for one (map, config) pair. */
export interface World {
  map: GameMapPackage;
  cfg: MapConfig;
  kernels: Kernels;
  n: number;
  lon: Float64Array;
  lat: Float64Array;
  /** phase index of each seat index, per phase count k */
  phaseOf: Map<number, Int16Array>;
  /** seat indices per phase, per k */
  phaseSeats: Map<number, number[][]>;
  /** sparse rally spill rows (incl. diagonal = local), excluding the global c */
  rallyRows: SparseRow[];
  roadRows: SparseRow[];
  /** sum of off-diagonal rally weights = how much a rally here spills (density measure) */
  density: Float64Array;
  /** seat indices sorted by distance, nearest first (lazily built) */
  nearest: (i: number, m: number) => number[];
}

function sparse(k: Float32Array, n: number): SparseRow[] {
  const rows: SparseRow[] = [];
  for (let i = 0; i < n; i++) {
    const idx: number[] = [];
    const w: number[] = [];
    for (let j = 0; j < n; j++) {
      const v = k[i * n + j];
      if (v > 0) { idx.push(j); w.push(v); }
    }
    rows.push({ idx: Int32Array.from(idx), w: Float32Array.from(w) });
  }
  return rows;
}

export function buildWorld(map: GameMapPackage, cfg: MapConfig): World {
  const kernels = buildKernels(map, cfg);
  const n = kernels.n;
  const seats = [...map.seats].sort((a, b) => a.id - b.id);
  const lon = Float64Array.from(seats.map((s) => s.lon));
  const lat = Float64Array.from(seats.map((s) => s.lat));
  const phaseOf = new Map<number, Int16Array>();
  const phaseSeats = new Map<number, number[][]>();
  for (const key of Object.keys(map.phaseGroups)) {
    const k = Number(key);
    const po = new Int16Array(n).fill(-1);
    const ps: number[][] = [];
    map.phaseGroups[key].forEach((g, p) => {
      const arr: number[] = [];
      for (const id of g) {
        const i = kernels.index.get(id) as number;
        po[i] = p;
        arr.push(i);
      }
      ps.push(arr);
    });
    phaseOf.set(k, po);
    phaseSeats.set(k, ps);
  }
  const rallyRows = sparse(kernels.rally, n);
  const roadRows = sparse(kernels.roadshow, n);
  const density = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const r = rallyRows[i];
    for (let q = 0; q < r.idx.length; q++) if (r.idx[q] !== i) s += r.w[q];
    density[i] = s;
  }
  const nearest = (i: number, m: number): number[] => {
    const order: number[] = [];
    for (let j = 0; j < n; j++) if (j !== i) order.push(j);
    order.sort((a, b) => kernels.distanceKm[i * n + a] - kernels.distanceKm[i * n + b]);
    return order.slice(0, m);
  };
  return { map, cfg, kernels, n, lon, lat, phaseOf, phaseSeats, rallyRows, roadRows, density, nearest };
}
