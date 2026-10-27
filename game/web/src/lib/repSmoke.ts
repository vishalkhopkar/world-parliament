// Which seats get an individual "+N" smoke after the player's own rally/roadshow, and the one "Every other seat +G" label.
import { buildKernels } from '@hp/shared';
import type { GameMapPackage, Kernels, MapConfig, SeatId } from '@hp/shared';

export interface RepGain { key: number; type: 'rally' | 'roadshow'; seat: SeatId; seats: Record<SeatId, number> }
export interface SmokeGains { key: number; seats: Record<SeatId, number>; globalText?: string }

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
 * Roadshow: every seat with a gain. Rally: seats inside the Gaussian (kernel > 0) get their own smoke; the rest
 * (only the global +G) are folded into one "Every other seat +G" label. Without a map package: gain > G is individual.
 */
export function selectSmoke(gain: RepGain, pkg: GameMapPackage | null, cfg: MapConfig): SmokeGains {
  const positive = Object.entries(gain.seats).map(([s, v]) => [Number(s), v] as const).filter(([, v]) => v > 0);
  if (gain.type === 'roadshow') return { key: gain.key, seats: Object.fromEntries(positive) };
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
