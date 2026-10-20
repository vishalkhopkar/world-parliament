// Pure unit tests of the counting schedule (core/counting.ts): plan, steps, declarations, events.
import { describe, expect, it } from 'vitest';
import { createRng } from '@hp/shared';
import type { SeatResult } from '@hp/shared';
import { declaredState, eventsAt, fullTally, leadStep, makePlan, stepAt, stepTime } from '../src/core/counting';

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const COUNTING_MS = [1, 50, 299, 300, 1000, 9000, 30_000, 180_000, 600_000, 3_600_000];
const SEAT_COUNTS = [1, 2, 3, 8, 50, 500];

function results(n: number, winnerOf: (seat: number) => string | null): SeatResult[] {
  return ids(n).map((seat) => {
    const w = winnerOf(seat);
    return { seat, phase: 0, winner: w, shares: w ? { [w]: 1 } : {} };
  });
}

describe('makePlan', () => {
  it.each(SEAT_COUNTS)('order is a permutation of the %i seats', (n) => {
    const plan = makePlan(ids(n), 1000, 30_000, createRng('p'));
    expect([...plan.order].sort((a, b) => a - b)).toEqual(ids(n));
  });

  it('is deterministic per seed and differs between seeds (for more than a few seats)', () => {
    const a = makePlan(ids(50), 0, 30_000, createRng('s1'));
    const b = makePlan(ids(50), 0, 30_000, createRng('s1'));
    const c = makePlan(ids(50), 0, 30_000, createRng('s2'));
    expect(a).toEqual(b);
    expect(a.order).not.toEqual(c.order);
  });

  it('does not mutate the input array', () => {
    const input = ids(20);
    makePlan(input, 0, 30_000, createRng('x'));
    expect(input).toEqual(ids(20));
  });

  it.each(COUNTING_MS)('countingMs=%i: interval within 50..5000 ms, steps >= 3, intervals fit the counting window', (ms) => {
    const plan = makePlan(ids(10), 5000, ms, createRng('x'));
    expect(plan.intervalMs).toBeGreaterThanOrEqual(50);
    expect(plan.intervalMs).toBeLessThanOrEqual(5000);
    expect(plan.steps).toBeGreaterThanOrEqual(3);
    expect(plan.startMs).toBe(5000);
    expect(plan.gap === 1 || plan.gap === 2).toBe(true);
    expect(plan.gap).toBe(plan.steps >= 4 ? 2 : 1);
    // counting never takes (much) longer than asked, except when the 50 ms / 3 step floors apply
    if (ms >= 3 * 50 * 2) expect(plan.steps * plan.intervalMs).toBeLessThanOrEqual(Math.max(ms, 3 * plan.intervalMs));
  });

  it('an empty seat list gives an empty order', () => {
    expect(makePlan([], 0, 1000, createRng('x')).order).toEqual([]);
  });
});

describe('leadStep', () => {
  it.each(SEAT_COUNTS.flatMap((n) => COUNTING_MS.map((ms) => [n, ms] as const)))(
    '%i seats, countingMs=%i: lead steps are non-decreasing in [1, steps-gap] and every seat is won by `steps`', (n, ms) => {
      const plan = makePlan(ids(n), 0, ms, createRng(`k${n}`));
      let prev = 0;
      for (let k = 0; k < n; k++) {
        const ls = leadStep(plan, k);
        expect(ls).toBeGreaterThanOrEqual(1);
        expect(ls).toBeGreaterThanOrEqual(prev);
        expect(ls + plan.gap).toBeLessThanOrEqual(plan.steps);
        prev = ls;
      }
      expect(leadStep(plan, n - 1)).toBe(plan.steps - plan.gap); // the last seat leads at the last possible step
    });
});

describe('stepAt / stepTime', () => {
  const plan = makePlan(ids(8), 10_000, 30_000, createRng('t'));
  it('is 0 before the start and clamps at `steps`', () => {
    expect(stepAt(plan, -1e9)).toBe(0);
    expect(stepAt(plan, 0)).toBe(0);
    expect(stepAt(plan, 10_000)).toBe(0);
    expect(stepAt(plan, 1e12)).toBe(plan.steps);
  });
  it('steps up exactly at each interval boundary', () => {
    for (let s = 1; s <= plan.steps; s++) {
      expect(stepAt(plan, stepTime(plan, s) - 1)).toBe(s - 1);
      expect(stepAt(plan, stepTime(plan, s))).toBe(s);
    }
  });
  it('stepTime(0) is the start and is linear', () => {
    expect(stepTime(plan, 0)).toBe(10_000);
    expect(stepTime(plan, 3) - stepTime(plan, 2)).toBe(plan.intervalMs);
  });
});

describe('declaredState', () => {
  const plan = makePlan(ids(8), 0, 30_000, createRng('d'));
  const res = results(8, (s) => (s <= 5 ? 'A' : 'B'));

  it('nothing is declared at step 0', () => {
    const st = declaredState(plan, res, 0, 8);
    expect(st.seats).toEqual({});
    expect(st.tally).toEqual({ leads: {}, wins: {}, declared: 0, total: 8 });
  });

  it('is monotone: a seat goes leading -> won and never disappears; counts add up at every step', () => {
    let prevDeclared = 0;
    const seen = new Map<number, string>();
    for (let step = 0; step <= plan.steps; step++) {
      const st = declaredState(plan, res, step, 8);
      const leads = Object.values(st.tally.leads).reduce((a, b) => a + b, 0);
      const wins = Object.values(st.tally.wins).reduce((a, b) => a + b, 0);
      expect(st.tally.declared).toBe(wins);
      expect(Object.keys(st.seats).length).toBe(leads + wins);
      expect(st.tally.declared).toBeGreaterThanOrEqual(prevDeclared);
      prevDeclared = st.tally.declared;
      for (const d of Object.values(st.seats)) {
        const before = seen.get(d.seat);
        if (before === 'won') expect(d.status).toBe('won');
        seen.set(d.seat, d.status);
        // only 'won' seats carry shares
        expect('shares' in d).toBe(d.status === 'won');
      }
      expect(seen.size).toBeGreaterThanOrEqual(0);
    }
    const last = declaredState(plan, res, plan.steps, 8);
    expect(last.tally.wins).toEqual({ A: 5, B: 3 });
    expect(last.tally.leads).toEqual({});
    expect(last.tally.declared).toBe(8);
  });

  it('seats without a winner are never declared and the total stays the seat count', () => {
    const r = results(8, (s) => (s % 2 ? null : 'A'));
    const last = declaredState(plan, r, plan.steps, 8);
    expect(Object.keys(last.seats).map(Number).sort((a, b) => a - b)).toEqual([2, 4, 6, 8]);
    expect(last.tally.declared).toBe(4);
    expect(last.tally.total).toBe(8);
  });

  it('seats missing from the results are skipped', () => {
    const last = declaredState(plan, res.slice(0, 3), plan.steps, 8);
    expect(Object.keys(last.seats)).toHaveLength(3);
  });

  it('does not alias the shares object of the stored result', () => {
    const last = declaredState(plan, res, plan.steps, 8);
    const d = Object.values(last.seats)[0];
    d.shares!['A'] = 0.123;
    expect(res.find((r) => r.seat === d.seat)!.shares['A']).not.toBe(0.123);
  });
});

describe('eventsAt', () => {
  it('over all steps yields exactly one leading and one won event per decided seat, leading first', () => {
    const plan = makePlan(ids(20), 0, 30_000, createRng('e'));
    const res = results(20, (s) => (s % 4 === 0 ? null : s % 2 ? 'A' : 'B'));
    const log: { seat: number; status: string; step: number }[] = [];
    for (let step = 0; step <= plan.steps; step++) for (const e of eventsAt(plan, res, step)) log.push({ seat: e.seat, status: e.status, step });
    const decided = res.filter((r) => r.winner).map((r) => r.seat);
    expect(log.filter((e) => e.status === 'leading').map((e) => e.seat).sort((a, b) => a - b)).toEqual(decided);
    expect(log.filter((e) => e.status === 'won').map((e) => e.seat).sort((a, b) => a - b)).toEqual(decided);
    for (const seat of decided) {
      const lead = log.find((e) => e.seat === seat && e.status === 'leading')!;
      const won = log.find((e) => e.seat === seat && e.status === 'won')!;
      expect(won.step - lead.step).toBe(plan.gap);
    }
  });

  it('is consistent with declaredState: the events at a step explain the difference to the previous step', () => {
    const plan = makePlan(ids(12), 0, 9000, createRng('c'));
    const res = results(12, (s) => (s <= 6 ? 'A' : 'B'));
    for (let step = 1; step <= plan.steps; step++) {
      const before = declaredState(plan, res, step - 1, 12).seats;
      const after = declaredState(plan, res, step, 12).seats;
      const changed = Object.values(after).filter((d) => !before[d.seat] || before[d.seat].status !== d.status).map((d) => `${d.seat}:${d.status}`).sort();
      expect(eventsAt(plan, res, step).map((d) => `${d.seat}:${d.status}`).sort()).toEqual(changed);
    }
  });

  it('no events at step 0', () => {
    const plan = makePlan(ids(5), 0, 9000, createRng('z'));
    expect(eventsAt(plan, results(5, () => 'A'), 0)).toEqual([]);
  });
});

describe('fullTally', () => {
  it('counts winners and ignores null winners', () => {
    expect(fullTally(results(6, (s) => (s <= 2 ? 'A' : s <= 4 ? 'B' : null)))).toEqual({ A: 2, B: 2 });
    expect(fullTally([])).toEqual({});
  });
});
