import type { PlayerId, SeatId } from '../types';

/** Deterministic PRNG returning floats in [0,1). Same seed -> same sequence. */
export type Rng = () => number;

/** Precomputed per-map weights. Index i <-> map.seats[i].id (seats sorted by id). */
export interface Kernels {
  seatIds: SeatId[];
  index: Map<SeatId, number>;
  n: number;
  /** n*n row-major: rally[from*n + to] = local * decay(dist(from,to)) incl. cap; diagonal = local. Excludes the global c. */
  rally: Float32Array;
  /** n*n row-major: roadshow[from*n + to], diagonal = s. */
  roadshow: Float32Array;
  /** Great-circle km between seat centres (hq when present), n*n. */
  distanceKm: Float32Array;
}

/** Per-player effect vectors: effects.get(playerId)[seatIndex]. */
export type Effects = Map<PlayerId, Float64Array>;

export interface EffectOptions {
  /** Ignore actions with ts > upTo (used for polling a phase and for delayed analyst reports). */
  upTo?: number;
  /** Players whose actions are ignored (eliminated players). */
  exclude?: Set<PlayerId>;
}
