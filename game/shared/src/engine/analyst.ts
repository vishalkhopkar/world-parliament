import type { MapConfig } from '../mapConfig';
import type {
  AnalystReport, GameTimeline, PlayerId, ReportEntry, ReportScope, SeatId, SeatResult,
} from '../types';
import { gaussian } from './rng';
import type { Effects, Kernels, Rng } from './types';

/** Price of a report bought at ts (linear price curve over the campaign, whole number). */
export function analystPrice(cfg: MapConfig, scope: ReportScope, timeline: GameTimeline, ts: number): number {
  const curve = scope === 'seat' ? cfg.analyst.seatReport : cfg.analyst.globalReport;
  const span = timeline.campaignEnd - timeline.campaignStart;
  const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (ts - timeline.campaignStart) / span));
  return Math.round(curve.start + (curve.end - curve.start) * t);
}

function rankEntries(players: PlayerId[], estimate: Map<PlayerId, number>, margin: (v: number) => number): ReportEntry[] {
  const order = players.map((p, idx) => ({ p, idx, v: estimate.get(p) as number }));
  order.sort((a, b) => b.v - a.v || a.idx - b.idx);
  return order.map((o, k) => ({ playerId: o.p, rank: k + 1, estimate: o.v, margin: margin(o.v) }));
}

/**
 * Noisy report built from `effects` (the caller computes them with upTo = purchase time - delayMs).
 * seat scope: share + gaussian noise (std = cfg.analyst.noise), clamped to [0,1]; margin = noise * marginFactor.
 * global scope: seats the player would win if the open seats were polled now (argmax, no swing; ties go to the
 * earlier player in `players`) plus final winners of `decided` seats, noised by relative noise, rounded;
 * margin = max(1, round(estimate * noise * marginFactor)).
 */
export function analystReport(
  effects: Effects, kernels: Kernels, cfg: MapConfig, scope: ReportScope, seat: SeatId | undefined,
  decided: SeatResult[], players: PlayerId[], asOf: number, purchasedAt: number, price: number, rng: Rng,
): AnalystReport {
  const { noise, marginFactor } = cfg.analyst;
  const estimate = new Map<PlayerId, number>();

  if (scope === 'seat') {
    if (seat === undefined) throw new Error('seat report requires a seat');
    const i = kernels.index.get(seat);
    if (i === undefined) throw new Error(`unknown seat ${seat}`);
    let total = 0;
    for (const v of effects.values()) total += v[i];
    for (const p of players) {
      const v = effects.get(p);
      const share = total > 0 && v ? v[i] / total : 0;
      const noisy = share + noise * gaussian(rng);
      estimate.set(p, Math.min(1, Math.max(0, noisy)));
    }
    const entries = rankEntries(players, estimate, () => noise * marginFactor);
    return { scope, seat, asOf, purchasedAt, price, entries };
  }

  const counts = new Map<PlayerId, number>(players.map((p) => [p, 0]));
  const decidedSeats = new Set<SeatId>();
  for (const r of decided) {
    decidedSeats.add(r.seat);
    if (r.winner !== null && counts.has(r.winner)) counts.set(r.winner, (counts.get(r.winner) as number) + 1);
  }
  const vecs = players.map((p) => effects.get(p));
  for (let i = 0; i < kernels.n; i++) {
    if (decidedSeats.has(kernels.seatIds[i])) continue;
    let best = 0;
    let bestK = -1;
    for (let k = 0; k < players.length; k++) {
      const v = vecs[k] ? (vecs[k] as Float64Array)[i] : 0;
      if (v > best) { best = v; bestK = k; }
    }
    if (bestK >= 0) counts.set(players[bestK], (counts.get(players[bestK]) as number) + 1);
  }
  for (const p of players) {
    const raw = counts.get(p) as number;
    estimate.set(p, Math.max(0, Math.round(raw * (1 + noise * gaussian(rng)))));
  }
  const entries = rankEntries(players, estimate, (v) => Math.max(1, Math.round(v * noise * marginFactor)));
  return { scope, asOf, purchasedAt, price, entries };
}
