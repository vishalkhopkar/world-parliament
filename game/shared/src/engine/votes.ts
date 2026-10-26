import type { MapConfig } from '../mapConfig';
import type { PlayerId, SeatId, SeatResult, SeatTally } from '../types';
import type { Committed, Effects, Kernels, Rng } from './types';

const TIE_EPS = 1e-12;

/** Normalise non-negative weights to sum 1 (all zero -> equal). */
function normalise(w: number[]): number[] {
  let s = 0;
  for (const x of w) s += x;
  return s > 0 ? w.map((x) => x / s) : w.map(() => 1 / w.length);
}

/**
 * One seat's vote shares (fractions summing to 1) from already-drawn quantities. All arrays are in `players` order.
 *  c = committed fractions (scaled down to sum <= 1), infl[k] = influence factor I_k (0 for uncommitted parties),
 *  R = random fraction of the uncommitted voters, w = random weights (normalised), v = weights for the reputation-less seat.
 * Layers: committed c_k; influence extra_k = c_k * I_k; randomness r = R * S0 split by w; the rest of S0 (the pool) split by
 * reputation (or by v when nobody has any). Overflow: S0 = 1 - sum c; if extras + r exceed S0 the EXTRAS are scaled down so the
 * pool is exactly 0 (r stays); the pool is never negative.
 */
function compose(c: number[], rep: number[], infl: number[], R: number, w: number[], v: number[]): number[] {
  const n = c.length;
  let sc = 0;
  for (const x of c) sc += x;
  if (sc > 1) { c = c.map((x) => x / sc); sc = 1; }
  const s0 = Math.max(0, 1 - sc);
  const r = Math.min(1, Math.max(0, R)) * s0;
  let ex = 0;
  const extra = c.map((x, k) => { const e = x * infl[k]; ex += e; return e; });
  const room = Math.max(0, s0 - r);
  const scale = ex > room ? (ex > 0 ? room / ex : 0) : 1;
  const pool = Math.max(0, room - ex * scale);
  let sr = 0;
  for (const x of rep) sr += x;
  const wn = normalise(w);
  const split = sr > 0 ? rep.map((x) => x / sr) : normalise(v);
  const out = new Array<number>(n);
  for (let k = 0; k < n; k++) out[k] = c[k] + extra[k] * scale + r * wn[k] + pool * split[k];
  return out;
}

function inputs(effects: Effects, committed: Committed, players: PlayerId[], i: number): { c: number[]; rep: number[] } {
  return {
    c: players.map((p) => committed.get(p)?.[i] ?? 0),
    rep: players.map((p) => effects.get(p)?.[i] ?? 0),
  };
}

/** Expected shares of one seat (all random draws replaced by their means), in `players` order; [] for an unknown seat / no players. */
export function expectedShareArray(
  effects: Effects, committed: Committed, players: PlayerId[], kernels: Kernels, cfg: MapConfig, seatIndex: number,
): number[] {
  if (!players.length || seatIndex < 0 || seatIndex >= kernels.n) return [];
  const { c, rep } = inputs(effects, committed, players, seatIndex);
  const equal = players.map(() => 1);
  return compose(c, rep, c.map(() => cfg.voting.influenceMaxPercent / 200), (cfg.voting.randomMaxPercent / 200) * players.length, equal, equal);
}

/**
 * Expected vote shares of a seat: the pollSeats model with every random draw at its mean (I = influenceMax/2, R = randomMax*parties/2,
 * equal random weights, equal split when nobody has reputation). Used by the analyst and the simulator.
 */
export function expectedSeatShares(
  effects: Effects, committed: Committed, players: PlayerId[], kernels: Kernels, cfg: MapConfig, seat: SeatId,
): Record<PlayerId, number> {
  const i = kernels.index.get(seat);
  const sh = i === undefined ? [] : expectedShareArray(effects, committed, players, kernels, cfg, i);
  const out: Record<PlayerId, number> = {};
  players.forEach((p, k) => { if (k < sh.length) out[p] = sh[k]; });
  return out;
}

/**
 * Final result for each seat in a polling phase. `players` = every party in the vote (also those without actions); keys of
 * effects / committed outside `players` are ignored. Per seat (fractions of the seat's voters):
 *  1 committed c_P (the band figure; scaled down if they ever sum above 1), S0 = 1 - sum c;
 *  2 influence: each committed party brings extra_P = c_P * I_P with I_P = rand * influenceMaxPercent/100;
 *  3 randomness: R = rand * randomMaxPercent/100 * (number of parties) of S0 votes at random, split by random weights w_P
 *    (the limit scales with the party count, so each party's average slice stays randomMaxPercent/2 of S0 whatever the number of parties);
 *  4 pool = S0 - extras - r (if that would be < 0 the extras are scaled down so it is 0);
 *  5 the pool is split by reputation (effects); with no reputation at all by fresh random weights;
 *  share_P = c_P + extra_P + random_P + pool_P. Winner = highest share, exact ties (1e-12) broken at random.
 * Unknown seat or no players -> winner null, shares {}; every other seat has a winner.
 * RNG draw order per seat (seats in the given order; none for an unknown seat): I_P for each player with c_P > 0 (players
 * order), R, w_P for every player, v_P for every player only if nobody has reputation, then one draw only on a tie.
 */
export function pollSeats(
  effects: Effects, committed: Committed, players: PlayerId[], kernels: Kernels, cfg: MapConfig, seats: SeatId[],
  phase: number, rng: Rng,
): SeatResult[] {
  const results: SeatResult[] = [];
  const infMax = cfg.voting.influenceMaxPercent / 100;
  const rndMax = cfg.voting.randomMaxPercent / 100;
  for (const seat of seats) {
    const i = kernels.index.get(seat);
    if (i === undefined || !players.length) {
      results.push({ seat, phase, winner: null, shares: {} });
      continue;
    }
    const { c, rep } = inputs(effects, committed, players, i);
    const infl = c.map((x) => (x > 0 ? rng() * infMax : 0));
    const R = rng() * rndMax * players.length;
    const w = players.map(() => rng());
    let sr = 0;
    for (const x of rep) sr += x;
    const v = sr > 0 ? w : players.map(() => rng());
    const raw = compose(c, rep, infl, R, w, v);
    const shares: Record<PlayerId, number> = {};
    let best = -1;
    for (let k = 0; k < players.length; k++) {
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
