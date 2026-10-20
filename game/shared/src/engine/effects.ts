import type { MapConfig, DecayParams } from '../mapConfig';
import type { Action, GameMapPackage, GameTimeline, PlayerId, SeatId } from '../types';
import type { EffectOptions, Effects, Kernels } from './types';

const R_EARTH_KM = 6371;
const DEG = Math.PI / 180;

/** Great-circle distance (haversine, R = 6371 km). */
export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Spill-over multiplier: 0.5^(d/half) up to maxKm, 0 beyond (before the cap). */
export function decay(d: number, p: DecayParams): number {
  if (d > p.maxKm) return 0;
  return Math.pow(0.5, d / p.halfDistanceKm);
}

export function buildKernels(map: GameMapPackage, cfg: MapConfig): Kernels {
  const seats = [...map.seats].sort((a, b) => a.id - b.id);
  const n = seats.length;
  const seatIds = seats.map((s) => s.id);
  const index = new Map<SeatId, number>();
  seatIds.forEach((id, i) => index.set(id, i));
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  seats.forEach((s, i) => {
    lon[i] = s.hq ? s.hq.lon : s.lon;
    lat[i] = s.hq ? s.hq.lat : s.lat;
  });
  const rally = new Float32Array(n * n);
  const roadshow = new Float32Array(n * n);
  const distanceKm = new Float32Array(n * n);
  const { rally: rc, roadshow: sc } = cfg.effects;
  for (let i = 0; i < n; i++) {
    rally[i * n + i] = rc.local;
    roadshow[i * n + i] = sc.local;
    for (let j = i + 1; j < n; j++) {
      const d = haversineKm(lon[i], lat[i], lon[j], lat[j]);
      distanceKm[i * n + j] = d;
      distanceKm[j * n + i] = d;
      const r = Math.min(rc.local * decay(d, rc.decay), rc.decay.capRatio * rc.local);
      const s = Math.min(sc.local * decay(d, sc.decay), sc.decay.capRatio * sc.local);
      rally[i * n + j] = r;
      rally[j * n + i] = r;
      roadshow[i * n + j] = s;
      roadshow[j * n + i] = s;
    }
  }
  return { seatIds, index, n, rally, roadshow, distanceKm };
}

/** Multiplier for an action taken at ts (linear cfg.timeMultiplier.start -> end over the campaign, clamped outside). */
export function timeMultiplier(cfg: MapConfig, timeline: GameTimeline, ts: number): number {
  const { start, end } = cfg.timeMultiplier;
  const span = timeline.campaignEnd - timeline.campaignStart;
  if (span <= 0) return end;
  const t = Math.min(1, Math.max(0, (ts - timeline.campaignStart) / span));
  return start + (end - start) * t;
}

/**
 * Sum the effect of every action on every seat, per player. The first party to act in a seat also gets the
 * cfg.effects.firstMover bonus there (once, flat).
 * A seat is frozen for an action when its phase close time <= action ts (the action does not touch it);
 * the action's contributions to still-open seats are kept.
 */
export function computeEffects(
  actions: Action[], kernels: Kernels, cfg: MapConfig, timeline: GameTimeline,
  map: GameMapPackage, phases: number, opts?: EffectOptions,
): Effects {
  const n = kernels.n;
  const effects: Effects = new Map();
  const groups = map.phaseGroups[String(phases)];
  if (!groups) throw new Error(`map ${map.mapId} has no phase grouping for ${phases} phases`);
  const closeOfSeat = new Float64Array(n).fill(Infinity);
  for (let p = 0; p < groups.length; p++) {
    const close = timeline.phaseCloses[p] ?? Infinity;
    for (const id of groups[p]) {
      const i = kernels.index.get(id);
      if (i !== undefined) closeOfSeat[i] = close;
    }
  }
  const c = cfg.effects.rally.global;
  const upTo = opts?.upTo ?? Infinity;
  const exclude = opts?.exclude;
  const { rally, roadshow } = kernels;
  const { start: m0, end: m1 } = cfg.timeMultiplier;
  const span = timeline.campaignEnd - timeline.campaignStart;
  const t0 = timeline.campaignStart;

  // First mover's advantage: per seat, the earliest counted action (either type) while the seat is still open.
  // Ties on ts go to the earlier entry in `actions`.
  const fm = cfg.effects.firstMover;
  let firstOf: Int32Array | undefined;
  if (fm.rally !== 0 || fm.roadshow !== 0) {
    firstOf = new Int32Array(n).fill(-1);
    const firstTs = new Float64Array(n).fill(Infinity);
    for (let k = 0; k < actions.length; k++) {
      const a = actions[k];
      if (a.ts > upTo || (exclude !== undefined && exclude.has(a.playerId))) continue;
      const r = kernels.index.get(a.seat);
      if (r === undefined || !(closeOfSeat[r] > a.ts)) continue;
      if (a.ts < firstTs[r]) { firstTs[r] = a.ts; firstOf[r] = k; }
    }
  }

  let lastPlayer: PlayerId | undefined;
  let vec: Float64Array | undefined;
  for (let k = 0; k < actions.length; k++) {
    const a = actions[k];
    const ts = a.ts;
    if (ts > upTo) continue;
    if (exclude !== undefined && exclude.has(a.playerId)) continue;
    const row = kernels.index.get(a.seat);
    if (row === undefined) continue;
    if (a.playerId !== lastPlayer || vec === undefined) {
      vec = effects.get(a.playerId);
      if (!vec) {
        vec = new Float64Array(n);
        effects.set(a.playerId, vec);
      }
      lastPlayer = a.playerId;
    }
    let t = span <= 0 ? 1 : (ts - t0) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const mult = m0 + (m1 - m0) * t;
    const base = row * n;
    if (a.type === 'rally') {
      for (let j = 0; j < n; j++) {
        if (closeOfSeat[j] > ts) vec[j] += (rally[base + j] + c) * mult;
      }
    } else {
      for (let j = 0; j < n; j++) {
        if (closeOfSeat[j] > ts) vec[j] += roadshow[base + j] * mult;
      }
    }
    if (firstOf !== undefined && firstOf[row] === k) vec[row] += a.type === 'rally' ? fm.rally : fm.roadshow;
  }
  return effects;
}

/** Raw vote shares in one seat (effect / total effect), no randomness. Empty if total is 0. */
export function seatShares(effects: Effects, kernels: Kernels, seat: SeatId): Record<PlayerId, number> {
  const i = kernels.index.get(seat);
  if (i === undefined) return {};
  let total = 0;
  for (const v of effects.values()) total += v[i];
  const out: Record<PlayerId, number> = {};
  if (!(total > 0)) return out;
  for (const [p, v] of effects) out[p] = v[i] / total;
  return out;
}
