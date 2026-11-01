// Which seats get an individual "+N" smoke after the player's own rally/minor rally/roadshow, the one "Every other seat +G"
// label, and the red "-cost" / green "+cost" smoke of fielding and withdrawing candidates.
import { buildKernels } from '@hp/shared';
import type { ActionType, GameMapPackage, Kernels, MapConfig, SeatId } from '@hp/shared';

export interface RepGain { key: number; type: ActionType; seat: SeatId; seats: Record<SeatId, number> }
/** seats = green "+N" reputation; spends = red "-N" money; refunds = green "+N" money; globalText = one label at a random visible spot. */
export interface SmokeGains { key: number; seats: Record<SeatId, number>; spends?: Record<SeatId, number>; refunds?: Record<SeatId, number>; globalText?: string }
/** Candidates just fielded (spent) and withdrawn (refunded) by this player, from a fieldAck. */
export interface FieldFx { key: number; spent: readonly SeatId[]; refunded: readonly SeatId[] }

const kernelCache = new WeakMap<GameMapPackage, { cfg: MapConfig; k: Kernels }>();
/** Kernels memoised per map package (building them costs ~25 ms). */
export function kernelsFor(pkg: GameMapPackage, cfg: MapConfig): Kernels {
  const hit = kernelCache.get(pkg);
  if (hit && hit.cfg === cfg) return hit.k;
  const k = buildKernels(pkg, cfg);
  kernelCache.set(pkg, { cfg, k });
  return k;
}

/**
 * Roadshow and minor rally (no global part): every seat with a gain. Rally: seats inside the Gaussian (kernel > 0) get their own smoke; the rest
 * (only the global +G) are folded into one "Every other seat +G" label. Without a map package: gain > G is individual.
 */
export function selectSmoke(gain: RepGain, pkg: GameMapPackage | null, cfg: MapConfig): SmokeGains {
  const positive = Object.entries(gain.seats).map(([s, v]) => [Number(s), v] as const).filter(([, v]) => v > 0);
  if (gain.type !== 'rally') return { key: gain.key, seats: Object.fromEntries(positive) };
  const G = Math.round(cfg.effects.rally.global * cfg.display.reputationScale);
  const seats: Record<SeatId, number> = {};
  let k: Kernels | null = null;
  if (pkg) { try { k = kernelsFor(pkg, cfg); } catch { k = null; } }
  const row = k?.index.get(gain.seat);
  for (const [s, v] of positive) {
    const col = k?.index.get(s);
    const inside = k && row !== undefined && col !== undefined ? k.rally[row * k.n + col] > 0 : v > G;
    if (inside) seats[s] = v;
  }
  return { key: gain.key, seats, ...(G > 0 ? { globalText: `Every other seat +${G}` } : {}) };
}

/** The smoke of a fieldAck: a red "-cost" on each seat fielded, a green "+cost" on each seat withdrawn. */
export function selectFieldSmoke(fx: FieldFx, cost: number): SmokeGains {
  const each = (seats: readonly SeatId[]) => Object.fromEntries(seats.map(s => [s, cost]));
  return { key: fx.key, seats: {}, spends: each(fx.spent), refunds: each(fx.refunded) };
}
