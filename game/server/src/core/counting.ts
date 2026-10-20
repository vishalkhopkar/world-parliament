// Counting schedule: seats are declared in a random order spread over the counting phase.
// Each seat is first 'leading' (at step lead) and 'won' (at step lead + gap); all seats are won by step `steps`.
import type { CountTally, PlayerId, Rng, SeatDeclaration, SeatId, SeatResult, SeatTally } from '@hp/shared';
import type { CountPlan } from './types';

export function makePlan(seatIds: SeatId[], startMs: number, countingMs: number, rng: Rng): CountPlan {
  const order = [...seatIds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const intervalMs = Math.max(50, Math.min(5000, Math.floor(countingMs / 6)));
  const steps = Math.max(3, Math.floor(countingMs / intervalMs));
  const gap = steps >= 4 ? 2 : 1;
  return { order, steps, intervalMs, startMs, gap };
}

/** Step at which the seat at position k first appears as 'leading' (1-based). */
export function leadStep(plan: CountPlan, k: number): number {
  const n = plan.order.length;
  return Math.max(1, Math.ceil(((k + 1) * (plan.steps - plan.gap)) / n));
}

export function stepAt(plan: CountPlan, nowMs: number): number {
  return Math.max(0, Math.min(plan.steps, Math.floor((nowMs - plan.startMs) / plan.intervalMs)));
}

export function stepTime(plan: CountPlan, step: number): number {
  return plan.startMs + step * plan.intervalMs;
}

function decl(r: SeatResult, status: 'leading' | 'won'): SeatDeclaration | null {
  if (r.winner === null) return null;
  return status === 'won'
    ? { seat: r.seat, status, playerId: r.winner, shares: { ...r.shares } }
    : { seat: r.seat, status, playerId: r.winner };
}

/** Declarations visible after `step` steps have been revealed, and the tally. */
export function declaredState(
  plan: CountPlan, results: SeatResult[], step: number, totalSeats: number,
): { seats: Record<SeatId, SeatDeclaration>; tally: CountTally } {
  const byId = new Map(results.map((r) => [r.seat, r]));
  const seats: Record<SeatId, SeatDeclaration> = {};
  const leads: SeatTally = {};
  const wins: SeatTally = {};
  let declared = 0;
  plan.order.forEach((seat, k) => {
    const r = byId.get(seat);
    if (!r || r.winner === null) return;
    const ls = leadStep(plan, k);
    if (step >= ls + plan.gap) {
      seats[seat] = decl(r, 'won') as SeatDeclaration;
      wins[r.winner] = (wins[r.winner] ?? 0) + 1;
      declared++; // declared = seats already 'won'
    } else if (step >= ls) {
      seats[seat] = decl(r, 'leading') as SeatDeclaration;
      leads[r.winner] = (leads[r.winner] ?? 0) + 1;
    }
  });
  return { seats, tally: { leads, wins, declared, total: totalSeats } };
}

/** Declaration events that happen exactly at `step`. */
export function eventsAt(plan: CountPlan, results: SeatResult[], step: number): SeatDeclaration[] {
  const byId = new Map(results.map((r) => [r.seat, r]));
  const out: SeatDeclaration[] = [];
  plan.order.forEach((seat, k) => {
    const r = byId.get(seat);
    if (!r) return;
    const ls = leadStep(plan, k);
    if (ls === step) { const d = decl(r, 'leading'); if (d) out.push(d); }
    if (ls + plan.gap === step) { const d = decl(r, 'won'); if (d) out.push(d); }
  });
  return out;
}

export function fullTally(results: SeatResult[]): Record<PlayerId, number> {
  const t: Record<PlayerId, number> = {};
  for (const r of results) if (r.winner !== null) t[r.winner] = (t[r.winner] ?? 0) + 1;
  return t;
}
