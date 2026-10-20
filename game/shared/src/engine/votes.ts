import type { MapConfig } from '../mapConfig';
import type { PlayerId, SeatId, SeatResult, SeatTally } from '../types';
import type { Effects, Kernels, Rng } from './types';

const TIE_EPS = 1e-12;

/**
 * Final result for each seat in a polling phase: shares with a small random swing (cfg.randomSwing), renormalised;
 * FPTP winner; exact ties (within 1e-12) broken at random among the leaders using the rng.
 * RNG use is deterministic: one draw per player per seat (in effects insertion order), plus one per tie.
 */
export function pollSeats(
  effects: Effects, kernels: Kernels, cfg: MapConfig, seats: SeatId[], phase: number, rng: Rng,
): SeatResult[] {
  const players = [...effects.keys()];
  const vecs = players.map((p) => effects.get(p) as Float64Array);
  const swing = cfg.randomSwing;
  const results: SeatResult[] = [];
  for (const seat of seats) {
    const i = kernels.index.get(seat);
    let total = 0;
    if (i !== undefined) for (const v of vecs) total += v[i];
    if (i === undefined || !(total > 0)) {
      results.push({ seat, phase, winner: null, shares: {} });
      continue;
    }
    const raw: number[] = new Array(players.length);
    let sum = 0;
    for (let k = 0; k < players.length; k++) {
      const share = vecs[k][i] / total;
      const u = rng() * 2 - 1;
      raw[k] = share * (1 + swing * u);
      sum += raw[k];
    }
    const shares: Record<PlayerId, number> = {};
    let best = -1;
    for (let k = 0; k < players.length; k++) {
      raw[k] /= sum;
      shares[players[k]] = raw[k];
      if (raw[k] > best) best = raw[k];
    }
    const leaders: PlayerId[] = [];
    for (let k = 0; k < players.length; k++) if (raw[k] >= best - TIE_EPS) leaders.push(players[k]);
    const winner = leaders.length === 1 ? leaders[0] : leaders[Math.min(leaders.length - 1, Math.floor(rng() * leaders.length))];
    results.push({ seat, phase, winner, shares });
  }
  return results;
}

/** Remove an eliminated player from already-decided seats: re-normalise shares, runner-up wins where they led. */
export function removePlayerFromResults(results: SeatResult[], playerId: PlayerId): SeatResult[] {
  return results.map((r) => {
    if (!(playerId in r.shares)) return { ...r, shares: { ...r.shares } };
    const shares: Record<PlayerId, number> = {};
    let total = 0;
    for (const [p, v] of Object.entries(r.shares)) {
      if (p === playerId) continue;
      shares[p] = v;
      total += v;
    }
    if (!(total > 0)) return { seat: r.seat, phase: r.phase, winner: null, shares: {} };
    let best: PlayerId | null = null;
    let bestV = -1;
    for (const p of Object.keys(shares)) {
      shares[p] /= total;
      if (shares[p] > bestV) { bestV = shares[p]; best = p; }
    }
    const winner = r.winner === playerId ? best : r.winner;
    return { seat: r.seat, phase: r.phase, winner, shares };
  });
}

export function tallySeats(results: SeatResult[]): SeatTally {
  const tally: SeatTally = {};
  for (const r of results) if (r.winner !== null) tally[r.winner] = (tally[r.winner] ?? 0) + 1;
  return tally;
}
