// Counting schedule. Over the whole counting phase the results are revealed in two stages:
//   1. LEADS: every seat shows a (noisy) lead from its leadStep on (all seats by allLeadsByFraction of the time). Early
//      leads are mostly guesses (they can be any party); the noise decays with time so late leads are nearly right.
//   2. WINS: from winStartFraction of the time seats are confirmed ('won') with the TRUE winner, safest seats first
//      (largest margin + jitter), spread evenly so the last seat is confirmed exactly at the last step.
// Everything here is a pure deterministic function of (plan, seat results, step): snapshot(), revealTo(), eliminate()
// and late joiners recompute the declared state repeatedly and must always agree.
import { WORLD_CONFIG, createRng, gaussian } from '@hp/shared';
import type { CountTally, MapConfig, PlayerId, Rng, SeatDeclaration, SeatId, SeatResult, SeatTally } from '@hp/shared';
import type { CountPlan } from './types';

type PlanConfig = Pick<MapConfig, 'durations' | 'counting'>;

/** Winning margin of a seat: top share minus runner-up share (the whole share if there is no runner-up). */
export function marginOf(r: SeatResult): number {
  const v = Object.values(r.shares).sort((a, b) => b - a);
  if (!v.length) return 0;
  return v[0] - (v[1] ?? 0);
}

export function makePlan(
  seatIds: SeatId[], startMs: number, countingMs: number, rng: Rng,
  results?: SeatResult[], cfg: PlanConfig = WORLD_CONFIG, seed?: string,
): CountPlan {
  const order = [...seatIds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const intervalMs = Math.max(50, Math.min(cfg.durations.countingStepMs, Math.floor(countingMs / 6)));
  const steps = Math.max(3, Math.floor(countingMs / intervalMs));
  const c = cfg.counting;
  const winStart = Math.min(steps, Math.max(2, Math.ceil(c.winStartFraction * steps)));

  // Only seats that have a winner are ever declared. Without results (unit tests) every seat is.
  const byId = results ? new Map(results.map((r) => [r.seat, r])) : null;
  const declarable = order.filter((s) => !byId || (byId.get(s)?.winner ?? null) !== null);

  // winStep: safest seats (margin + jitter) first, spread evenly over [winStart, steps]; the last lands on `steps`.
  const keyed = declarable.map((seat, k) => ({
    seat, k, key: (byId ? marginOf(byId.get(seat) as SeatResult) : 0) + c.winJitter * rng(),
  }));
  keyed.sort((a, b) => b.key - a.key || a.k - b.k);
  const m = keyed.length;
  const winStep: Record<SeatId, number> = {};
  keyed.forEach(({ seat }, i) => {
    winStep[seat] = m <= 1 ? steps : winStart + Math.round((i * (steps - winStart)) / (m - 1));
  });

  // leadStep: random order, first leads spread so that every seat has one by allLeadsByFraction * steps.
  const leadStep: Record<SeatId, number> = {};
  declarable.forEach((seat, k) => {
    const ls = Math.max(1, Math.ceil(((k + 1) * c.allLeadsByFraction * steps) / m));
    leadStep[seat] = Math.min(ls, Math.max(1, winStep[seat] - 1));
  });

  return {
    order, steps, intervalMs, startMs,
    seed: seed ?? `plan:${Math.floor(rng() * 4294967296)}`,
    winStart, leadStep, winStep,
    noise: {
      start: c.leadNoiseStart, exponent: c.leadNoiseExponent,
      epochSteps: Math.max(1, Math.round(c.leadNoiseEpochFraction * steps)),
    },
  };
}

/** Step at which `seat` first shows a lead. Seats the plan does not know (no winner when planned) lead at the all-leads mark. */
export function leadStepOf(plan: CountPlan, seat: SeatId): number {
  return plan.leadStep[seat] ?? Math.max(1, plan.steps - 1);
}

/** Step at which `seat` is confirmed 'won'. */
export function winStepOf(plan: CountPlan, seat: SeatId): number {
  return plan.winStep[seat] ?? plan.steps;
}

export function stepAt(plan: CountPlan, nowMs: number): number {
  return Math.max(0, Math.min(plan.steps, Math.floor((nowMs - plan.startMs) / plan.intervalMs)));
}

export function stepTime(plan: CountPlan, step: number): number {
  return plan.startMs + step * plan.intervalMs;
}

/** Lead noise (sigma) of `seat` at `step`: high at the start, decaying, exactly 0 from one step before the seat is confirmed. */
export function leadSigma(plan: CountPlan, seat: SeatId, step: number): number {
  const ws = winStepOf(plan, seat);
  const ramp = Math.min(1, Math.max(0, (ws - 1 - step) / plan.noise.epochSteps));
  const decay = Math.pow(Math.max(0, 1 - step / plan.steps), plan.noise.exponent);
  return plan.noise.start * decay * ramp;
}

/** The party shown as leading in `r` at `step` (the true winner once the noise has died down). */
export function leaderAt(plan: CountPlan, r: SeatResult, step: number): PlayerId {
  const winner = r.winner as PlayerId;
  const sigma = leadSigma(plan, r.seat, step);
  if (sigma <= 0) return winner;
  const epoch = Math.floor(step / plan.noise.epochSteps);
  let best: PlayerId | null = null;
  let bestScore = -Infinity;
  for (const p of Object.keys(r.shares).sort()) {
    const share = r.shares[p];
    if (!(share > 0)) continue;
    const z = gaussian(createRng(`${plan.seed}:lead:${r.seat}:${epoch}:${p}`));
    const score = share * Math.exp(sigma * z);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best ?? winner;
}

/** The pie chart of a lead shows less extreme numbers than the raw lead noise (sigma up to 2): capped here... */
const DISPLAY_SIGMA_CAP = 0.6;
/** ...and swings from step to step by this fraction of the (capped) noise, on top of the per-epoch noise that picks the leader. */
const DISPLAY_SWING = 0.2;

/**
 * Estimated vote share of every party in `r` while it is only LEADING at `step`: the true shares x exp(sigma x noise),
 * normalised and rounded to 3 decimals. Changes every step (the pie swings), settles on the true shares when the noise
 * dies down just before the seat is confirmed, and its biggest slice is always `leaderAt` (the map and the pie agree).
 */
export function leadSharesAt(plan: CountPlan, r: SeatResult, step: number): Record<PlayerId, number> {
  const sigma = Math.min(DISPLAY_SIGMA_CAP, leadSigma(plan, r.seat, step));
  const epoch = Math.floor(step / plan.noise.epochSteps);
  const parties = Object.keys(r.shares).sort();
  const raw: Record<PlayerId, number> = {};
  let total = 0;
  for (const p of parties) {
    const share = r.shares[p];
    if (!(share > 0)) { raw[p] = 0; continue; }
    const zEpoch = gaussian(createRng(`${plan.seed}:lead:${r.seat}:${epoch}:${p}`));
    const zStep = gaussian(createRng(`${plan.seed}:swing:${r.seat}:${step}:${p}`));
    raw[p] = share * Math.exp(sigma * (zEpoch + DISPLAY_SWING * zStep));
    total += raw[p];
  }
  // the leader must be the biggest slice (the lead noise picks it with the full sigma, the pie uses a gentler one)
  const leader = leaderAt(plan, r, step);
  if (leader in raw) {
    const top = Math.max(...parties.filter((p) => p !== leader).map((p) => raw[p]), 0);
    if (!(raw[leader] > top)) { total += top * 1.05 - raw[leader]; raw[leader] = top * 1.05; }
  }
  const out: Record<PlayerId, number> = {};
  for (const p of parties) out[p] = total > 0 ? Math.round((raw[p] / total) * 1000) / 1000 : 0;
  // ...also after rounding (two slices can round to the same value)
  if (leader in out) {
    const others = Math.max(0, ...parties.filter((p) => p !== leader).map((p) => out[p]));
    if (!(out[leader] > others)) out[leader] = Math.min(1, Math.round((others + 0.001) * 1000) / 1000);
  }
  return out;
}

/** What a client may see of `seat` at `step` when it clicks it: the status plus every party's share (null = no lead yet / no winner). */
export function seatSharesAt(plan: CountPlan, r: SeatResult, step: number): { status: 'leading' | 'won'; shares: Record<PlayerId, number> } | null {
  const d = seatStateAt(plan, r, step);
  if (!d) return null;
  return d.status === 'won' ? { status: 'won', shares: { ...r.shares } } : { status: 'leading', shares: leadSharesAt(plan, r, step) };
}

/** What `seat` shows after `step` steps (null = nothing yet, or the seat has no winner). */
export function seatStateAt(plan: CountPlan, r: SeatResult, step: number): SeatDeclaration | null {
  if (r.winner === null) return null;
  if (step >= winStepOf(plan, r.seat)) return { seat: r.seat, status: 'won', playerId: r.winner, shares: { ...r.shares } };
  if (step >= leadStepOf(plan, r.seat)) return { seat: r.seat, status: 'leading', playerId: leaderAt(plan, r, step) };
  return null;
}

/** Declarations visible after `step` steps have been revealed, and the tally. */
export function declaredState(
  plan: CountPlan, results: SeatResult[], step: number, totalSeats: number,
): { seats: Record<SeatId, SeatDeclaration>; tally: CountTally } {
  const seats: Record<SeatId, SeatDeclaration> = {};
  const leads: SeatTally = {};
  const wins: SeatTally = {};
  let declared = 0;
  for (const r of results) {
    const d = seatStateAt(plan, r, step);
    if (!d) continue;
    seats[r.seat] = d;
    if (d.status === 'won') { wins[d.playerId] = (wins[d.playerId] ?? 0) + 1; declared++; }
    else leads[d.playerId] = (leads[d.playerId] ?? 0) + 1;
  }
  return { seats, tally: { leads, wins, declared, total: totalSeats } };
}

/** Declarations in `cur` that differ from `prev` in (status, party): new seats, status changes and lead changes. */
export function diffDeclarations(prev: Record<SeatId, SeatDeclaration>, cur: Record<SeatId, SeatDeclaration>): SeatDeclaration[] {
  const out: SeatDeclaration[] = [];
  for (const d of Object.values(cur)) {
    const before = prev[d.seat];
    if (!before || before.status !== d.status || before.playerId !== d.playerId) out.push(d);
  }
  return out;
}

/** Declaration events at exactly `step`: every seat whose (status, party) differs from the previous step (lead changes included). */
export function eventsAt(plan: CountPlan, results: SeatResult[], step: number): SeatDeclaration[] {
  if (step < 1) return [];
  const total = results.length;
  return diffDeclarations(declaredState(plan, results, step - 1, total).seats, declaredState(plan, results, step, total).seats);
}

export function fullTally(results: SeatResult[]): Record<PlayerId, number> {
  const t: Record<PlayerId, number> = {};
  for (const r of results) if (r.winner !== null) t[r.winner] = (t[r.winner] ?? 0) + 1;
  return t;
}
