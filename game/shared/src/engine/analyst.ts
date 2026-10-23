import type { MapConfig } from '../mapConfig';
import type {
  AnalystReport, GameTimeline, PlayerId, ReportEntry, ReportScope, SeatId, SeatResult,
} from '../types';
import { gaussian } from './rng';
import { expectedShareArray } from './votes';
import type { Committed, Effects, Kernels, Rng } from './types';

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
 * Noisy report built from `effects` (the caller computes them with upTo = purchase time - delayMs) and the parties'
 * committed voters. Shares are the EXPECTED shares of the vote model (expectedSeatShares: random draws at their means).
 * seat scope: expected share + gaussian noise (std = cfg.analyst.noise), clamped to [0,1]; margin = noise * marginFactor.
 * global scope: seats the player would win if the open seats were polled now (argmax of the expected shares; ties go to the
 * earlier player in `players`; every open seat counts when there are players) plus final winners of `decided` seats, noised by relative noise, rounded;
 * margin = max(1, round(estimate * noise * marginFactor)).
 */
export function analystReport(
  effects: Effects, committed: Committed, kernels: Kernels, cfg: MapConfig, scope: ReportScope, seat: SeatId | undefined,
  decided: SeatResult[], players: PlayerId[], asOf: number, purchasedAt: number, price: number, rng: Rng,
): AnalystReport {
  const { noise, marginFactor } = cfg.analyst;
  const estimate = new Map<PlayerId, number>();

  if (scope === 'seat') {
    if (seat === undefined) throw new Error('seat report requires a seat');
    const i = kernels.index.get(seat);
    if (i === undefined) throw new Error(`unknown seat ${seat}`);
    const shares = expectedShareArray(effects, committed, players, kernels, cfg, i);
    for (let k = 0; k < players.length; k++) {
      const share = shares[k] ?? 0;
      const p = players[k];
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
  for (let i = 0; i < kernels.n; i++) {
    if (decidedSeats.has(kernels.seatIds[i])) continue;
    const sh = expectedShareArray(effects, committed, players, kernels, cfg, i);
    let best = -1;
    let bestK = -1;
    for (let k = 0; k < sh.length; k++) if (sh[k] > best) { best = sh[k]; bestK = k; }
    if (bestK >= 0) counts.set(players[bestK], (counts.get(players[bestK]) as number) + 1);
  }
  for (const p of players) {
    const raw = counts.get(p) as number;
    estimate.set(p, Math.max(0, Math.round(raw * (1 + noise * gaussian(rng)))));
  }
  const entries = rankEntries(players, estimate, (v) => Math.max(1, Math.round(v * noise * marginFactor)));
  return { scope, asOf, purchasedAt, price, entries };
}
