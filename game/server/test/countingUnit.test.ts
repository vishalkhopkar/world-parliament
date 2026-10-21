// Pure unit tests of the counting schedule (core/counting.ts): plan, steps, noisy leads, wins, events.
import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG, createRng } from '@hp/shared';
import type { MapConfig, SeatResult } from '@hp/shared';
import { declaredState, eventsAt, fullTally, leadStepOf, makePlan, marginOf, stepAt, stepTime, winStepOf } from '../src/core/counting';

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const COUNTING_MS = [1, 50, 299, 300, 1000, 9000, 30_000, 60_000, 180_000, 600_000, 3_600_000];
const SEAT_COUNTS = [1, 2, 3, 8, 50, 500];
const cfg = WORLD_CONFIG;
const winStartOf = (steps: number) => Math.ceil(cfg.counting.winStartFraction * steps);
const leadsByOf = (steps: number) => Math.ceil(cfg.counting.allLeadsByFraction * steps);

/** One sure winner per seat (share 1) - for the simple structural tests. */
function results(n: number, winnerOf: (seat: number) => string | null): SeatResult[] {
  return ids(n).map((seat) => {
    const w = winnerOf(seat);
    return { seat, phase: 0, winner: w, shares: w ? { [w]: 1 } : {} };
  });
}

/** Realistic contested seats: `parties` parties with random shares (sum 1), winner = largest. Some seats have no winner. */
function contested(n: number, seed: string, parties = 4, nullEvery = 0): SeatResult[] {
  const rng = createRng(`res:${seed}`);
  return ids(n).map((seat) => {
    if (nullEvery && seat % nullEvery === 0) return { seat, phase: 0, winner: null, shares: {} };
    const raw = Array.from({ length: parties }, () => Math.pow(-Math.log(1 - rng()), 1.3));
    const sum = raw.reduce((a, b) => a + b, 0);
    const shares: Record<string, number> = {};
    raw.forEach((v, i) => { shares[`P${i}`] = v / sum; });
    const winner = Object.entries(shares).sort((a, b) => b[1] - a[1])[0][0];
    return { seat, phase: 0, winner, shares };
  });
}

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe('makePlan', () => {
  it.each(SEAT_COUNTS)('order is a permutation of the %i seats', (n) => {
    const plan = makePlan(ids(n), 1000, 30_000, createRng('p'));
    expect([...plan.order].sort((a, b) => a - b)).toEqual(ids(n));
  });

  it('is deterministic per seed and differs between seeds (for more than a few seats)', () => {
    const res = contested(50, 'a');
    const a = makePlan(ids(50), 0, 30_000, createRng('s1'), res, cfg, 'g');
    const b = makePlan(ids(50), 0, 30_000, createRng('s1'), res, cfg, 'g');
    const c = makePlan(ids(50), 0, 30_000, createRng('s2'), res, cfg, 'g');
    expect(a).toEqual(b);
    expect(a.order).not.toEqual(c.order);
    expect(a.winStep).not.toEqual(c.winStep);
  });

  it('does not mutate the input array', () => {
    const input = ids(20);
    makePlan(input, 0, 30_000, createRng('x'));
    expect(input).toEqual(ids(20));
  });

  it.each(COUNTING_MS)('countingMs=%i: interval within 50..countingStepMs, steps >= 3, intervals fit the counting window', (ms) => {
    const plan = makePlan(ids(10), 5000, ms, createRng('x'));
    expect(plan.intervalMs).toBeGreaterThanOrEqual(50);
    expect(plan.intervalMs).toBeLessThanOrEqual(cfg.durations.countingStepMs);
    expect(plan.steps).toBeGreaterThanOrEqual(3);
    expect(plan.startMs).toBe(5000);
    expect(plan.winStart).toBe(Math.max(2, winStartOf(plan.steps)));
    // counting never takes (much) longer than asked, except when the 50 ms / 3 step floors apply
    if (ms >= 3 * 50 * 2) expect(plan.steps * plan.intervalMs).toBeLessThanOrEqual(Math.max(ms, 3 * plan.intervalMs));
  });

  it('uses finer steps: 3 minutes = 180 steps, 1 minute = 60 steps (countingStepMs = 1 s)', () => {
    expect(cfg.durations.countingStepMs).toBe(1000);
    const p3 = makePlan(ids(500), 0, 180_000, createRng('x'));
    const p1 = makePlan(ids(500), 0, 60_000, createRng('x'));
    expect([p3.steps, p3.intervalMs]).toEqual([180, 1000]);
    expect([p1.steps, p1.intervalMs]).toEqual([60, 1000]);
    expect(p3.noise.epochSteps).toBe(9); // 5 % of 180
    expect(p1.noise.epochSteps).toBe(3); // 5 % of 60
  });

  it('an empty seat list gives an empty order', () => {
    expect(makePlan([], 0, 1000, createRng('x')).order).toEqual([]);
  });

  it('seats without a winner get no lead/win step; the others are spread to end exactly on `steps`', () => {
    const res = contested(30, 'n', 3, 5);
    const plan = makePlan(ids(30), 0, 60_000, createRng('n'), res, cfg, 'g');
    for (const r of res) {
      expect(r.seat in plan.winStep).toBe(r.winner !== null);
      expect(r.seat in plan.leadStep).toBe(r.winner !== null);
    }
    expect(Math.max(...Object.values(plan.winStep))).toBe(plan.steps);
    expect(Math.min(...Object.values(plan.winStep))).toBe(plan.winStart);
  });
});

describe('plan schedule (lead and win steps)', () => {
  it.each(SEAT_COUNTS.flatMap((n) => COUNTING_MS.map((ms) => [n, ms] as const)))(
    '%i seats, countingMs=%i: leads by 0.5*steps, wins in [ceil(0.75*steps), steps], last win on `steps`, lead before win', (n, ms) => {
      const res = contested(n, `k${n}`);
      const plan = makePlan(ids(n), 0, ms, createRng(`k${n}`), res, cfg, 'g');
      const wins = ids(n).map((s) => winStepOf(plan, s));
      for (const s of ids(n)) {
        const ls = leadStepOf(plan, s);
        const ws = winStepOf(plan, s);
        expect(ls).toBeGreaterThanOrEqual(1);
        expect(ls).toBeLessThanOrEqual(leadsByOf(plan.steps));
        expect(ws).toBeGreaterThanOrEqual(winStartOf(plan.steps));
        expect(ws).toBeLessThanOrEqual(plan.steps);
        expect(ls).toBeLessThan(ws);
      }
      expect(Math.max(...wins)).toBe(plan.steps);
    });

  it('wins are spread evenly over [winStart, steps] (about the same number of confirmations per step)', () => {
    const plan = makePlan(ids(500), 0, 180_000, createRng('even'), contested(500, 'even'), cfg, 'g');
    const perStep = new Map<number, number>();
    for (const ws of Object.values(plan.winStep)) perStep.set(ws, (perStep.get(ws) ?? 0) + 1);
    expect(perStep.size).toBe(plan.steps - plan.winStart + 1);
    for (const c of perStep.values()) expect(c).toBeGreaterThanOrEqual(5); // 500 over 46 steps ~ 11
    for (const c of perStep.values()) expect(c).toBeLessThanOrEqual(22);
  });

  it('with no jitter the safest seat (biggest margin) is confirmed first and the tightest last', () => {
    const noJitter: Pick<MapConfig, 'durations' | 'counting'> = { durations: cfg.durations, counting: { ...cfg.counting, winJitter: 0 } };
    const res = contested(80, 'm');
    const plan = makePlan(ids(80), 0, 60_000, createRng('m'), res, noJitter, 'g');
    const byMargin = [...res].sort((a, b) => marginOf(b) - marginOf(a));
    for (let i = 1; i < byMargin.length; i++) {
      expect(winStepOf(plan, byMargin[i].seat)).toBeGreaterThanOrEqual(winStepOf(plan, byMargin[i - 1].seat));
    }
    expect(winStepOf(plan, byMargin[0].seat)).toBe(plan.winStart);
    expect(winStepOf(plan, byMargin[byMargin.length - 1].seat)).toBe(plan.steps);
  });

  it('with the default jitter the order is still strongly (but not perfectly) margin-driven', () => {
    const res = contested(500, 'j');
    const plan = makePlan(ids(500), 0, 180_000, createRng('j'), res, cfg, 'g');
    const sorted = [...res].sort((a, b) => marginOf(b) - marginOf(a));
    const mean = (rs: SeatResult[]) => rs.reduce((a, r) => a + winStepOf(plan, r.seat), 0) / rs.length;
    expect(mean(sorted.slice(0, 125))).toBeLessThan(mean(sorted.slice(375)) - 10);
    const inOrder = sorted.every((r, i) => i === 0 || winStepOf(plan, r.seat) >= winStepOf(plan, sorted[i - 1].seat));
    expect(inOrder).toBe(false);
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
  const plan = makePlan(ids(8), 0, 30_000, createRng('d'), results(8, (s) => (s <= 5 ? 'A' : 'B')), cfg, 'g');
  const res = results(8, (s) => (s <= 5 ? 'A' : 'B'));

  it('nothing is declared at step 0', () => {
    const st = declaredState(plan, res, 0, 8);
    expect(st.seats).toEqual({});
    expect(st.tally).toEqual({ leads: {}, wins: {}, declared: 0, total: 8 });
  });

  it('counts add up at every step, only won seats carry shares, and the end state is the true result', () => {
    let prevDeclared = 0;
    for (let step = 0; step <= plan.steps; step++) {
      const st = declaredState(plan, res, step, 8);
      expect(st.tally.declared).toBe(sum(st.tally.wins));
      expect(Object.keys(st.seats).length).toBe(sum(st.tally.leads) + sum(st.tally.wins));
      expect(st.tally.declared).toBeGreaterThanOrEqual(prevDeclared);
      prevDeclared = st.tally.declared;
      for (const d of Object.values(st.seats)) expect('shares' in d).toBe(d.status === 'won');
    }
    const last = declaredState(plan, res, plan.steps, 8);
    expect(last.tally.wins).toEqual({ A: 5, B: 3 });
    expect(last.tally.leads).toEqual({});
    expect(last.tally.declared).toBe(8);
  });

  it('seats without a winner are never declared and the total stays the seat count', () => {
    const r = results(8, (s) => (s % 2 ? null : 'A'));
    const p = makePlan(ids(8), 0, 30_000, createRng('d'), r, cfg, 'g');
    const last = declaredState(p, r, p.steps, 8);
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

  it('a seat the plan does not know (e.g. polled late) still resolves: lead near the end, won at `steps`', () => {
    const p = makePlan(ids(4), 0, 30_000, createRng('u'), results(2, () => 'A'), cfg, 'g');
    const r = results(4, () => 'A');
    expect(declaredState(p, r, p.steps, 4).tally.wins).toEqual({ A: 4 });
    expect(declaredState(p, r, p.steps - 1, 4).seats[4]?.status).toBe('leading');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Property-style guarantees, over several seeds and counting durations (incl. 1 min, 3 min and tiny test durations)
// ---------------------------------------------------------------------------------------------------------------
const SEEDS = ['alpha', 'beta', 'gamma'];
const PROP_MS = [300, 1000, 9000, 30_000, 60_000, 180_000];

describe.each(PROP_MS)('count properties, countingMs=%i', (ms) => {
  const nSeats = ms >= 60_000 ? 200 : 60;
  it.each(SEEDS)('seed %s: no early wins, leads by 50 %, true result at the end, wins never revert, last seat on `steps`', (seed) => {
    const res = contested(nSeats, seed, 4, 11);
    const declarable = res.filter((r) => r.winner !== null);
    const plan = makePlan(ids(nSeats), 0, ms, createRng(`${seed}:count`), res, cfg, seed);
    const winStart = winStartOf(plan.steps);
    const leadsBy = leadsByOf(plan.steps);
    const wonAt = new Map<number, number>();
    let prevWins = 0;
    for (let step = 0; step <= plan.steps; step++) {
      const st = declaredState(plan, res, step, nSeats);
      // no confirmed win before 75 % of the time
      if (step < winStart) expect(st.tally.declared).toBe(0);
      // every declarable seat has a lead (or already a win) by 50 % of the time
      if (step >= leadsBy) expect(Object.keys(st.seats).length).toBe(declarable.length);
      expect(st.tally.declared).toBeGreaterThanOrEqual(prevWins); // wins monotone
      prevWins = st.tally.declared;
      for (const d of Object.values(st.seats)) {
        const r = res.find((x) => x.seat === d.seat)!;
        if (d.status === 'won') {
          expect(d.playerId).toBe(r.winner); // a confirmed result is the true result
          if (!wonAt.has(d.seat)) wonAt.set(d.seat, step);
        } else {
          expect(wonAt.has(d.seat)).toBe(false); // never back from won to leading
        }
      }
      // a seat once won keeps exactly the same declaration
      for (const seat of wonAt.keys()) expect(st.seats[seat].status).toBe('won');
    }
    const last = declaredState(plan, res, plan.steps, nSeats);
    expect(Object.keys(last.seats)).toHaveLength(declarable.length);
    expect(Object.values(last.seats).every((d) => d.status === 'won')).toBe(true);
    expect(last.tally.wins).toEqual(fullTally(res));
    expect(last.tally.leads).toEqual({});
    expect(last.tally.declared).toBe(declarable.length);
    // the last seat is confirmed exactly at the final step, and not before
    const before = declaredState(plan, res, plan.steps - 1, nSeats);
    expect(before.tally.declared).toBeLessThan(declarable.length);
    expect(Math.max(...wonAt.values())).toBe(plan.steps);
  });

  it.each(SEEDS)('seed %s: eventsAt(step) is exactly the (status, party) difference to step-1, so lead changes are broadcast', (seed) => {
    const res = contested(nSeats, seed, 4, 11);
    const plan = makePlan(ids(nSeats), 0, ms, createRng(`${seed}:count`), res, cfg, seed);
    let leadChanges = 0;
    for (let step = 1; step <= plan.steps; step++) {
      const before = declaredState(plan, res, step - 1, nSeats).seats;
      const after = declaredState(plan, res, step, nSeats).seats;
      const changed = Object.values(after)
        .filter((d) => !before[d.seat] || before[d.seat].status !== d.status || before[d.seat].playerId !== d.playerId)
        .map((d) => `${d.seat}:${d.status}:${d.playerId}`).sort();
      const ev = eventsAt(plan, res, step);
      expect(ev.map((d) => `${d.seat}:${d.status}:${d.playerId}`).sort()).toEqual(changed);
      leadChanges += ev.filter((d) => d.status === 'leading' && before[d.seat]?.status === 'leading').length;
      for (const d of ev) expect('shares' in d).toBe(d.status === 'won');
    }
    expect(eventsAt(plan, res, 0)).toEqual([]);
    if (ms >= 9000) expect(leadChanges).toBeGreaterThan(0); // leads do change their mind (and that is announced)
  });

  it('is deterministic: the same inputs give the same plan and the same state at every step', () => {
    const res = contested(nSeats, 'det', 4, 11);
    const a = makePlan(ids(nSeats), 7, ms, createRng('det'), res, cfg, 'g1');
    const b = makePlan(ids(nSeats), 7, ms, createRng('det'), res, cfg, 'g1');
    expect(a).toEqual(b);
    for (let step = 0; step <= a.steps; step += Math.max(1, Math.floor(a.steps / 12))) {
      expect(declaredState(a, res, step, nSeats)).toEqual(declaredState(b, res, step, nSeats));
      expect(declaredState(a, res, step, nSeats)).toEqual(declaredState(a, res, step, nSeats));
    }
  });
});

describe('lead quality over time (noise decays)', () => {
  /** share of leading seats whose displayed lead is NOT the true winner, pooled over seeds, at `step`. */
  function wrongShare(ms: number, step: number): { wrong: number; total: number } {
    let wrong = 0, total = 0;
    for (const seed of ['q1', 'q2', 'q3', 'q4']) {
      const res = contested(300, seed, 4);
      const plan = makePlan(ids(300), 0, ms, createRng(`${seed}:count`), res, cfg, seed);
      const st = declaredState(plan, res, Math.min(step, plan.steps), 300).seats;
      for (const d of Object.values(st)) {
        if (d.status !== 'leading') continue;
        total++;
        if (d.playerId !== res.find((r) => r.seat === d.seat)!.winner) wrong++;
      }
    }
    return { wrong, total };
  }

  it.each([60_000, 180_000])('countingMs=%i: early leads often disagree with the true winner, late leads rarely do', (ms) => {
    const steps = ms / 1000;
    // seat 1 gets its first lead at ~step 1; use 25 % of the time for plenty of leads
    const early = wrongShare(ms, Math.round(0.25 * steps));
    const mid = wrongShare(ms, Math.round(0.5 * steps));
    const late = wrongShare(ms, Math.round(0.72 * steps));
    expect(early.total).toBeGreaterThan(200);
    expect(early.wrong / early.total).toBeGreaterThan(0.3); // 'noisy leads can swing anywhere' (~38 % measured)
    expect(mid.wrong / mid.total).toBeLessThan(early.wrong / early.total);
    expect(late.total).toBeGreaterThan(500);
    expect(late.wrong / late.total).toBeLessThan(0.12);
    expect(late.wrong / late.total).toBeLessThan(mid.wrong / mid.total);
  });

  it('a lead can change at most about once per noise epoch (it does not flicker every second)', () => {
    const res = contested(200, 'flick', 4);
    const plan = makePlan(ids(200), 0, 180_000, createRng('flick'), res, cfg, 'flick');
    const changes: number[] = [];
    let prev = declaredState(plan, res, 0, 200).seats;
    for (let step = 1; step <= plan.steps; step++) {
      const cur = declaredState(plan, res, step, 200).seats;
      let c = 0;
      for (const d of Object.values(cur)) {
        const p = prev[d.seat];
        if (p && p.status === 'leading' && d.status === 'leading' && p.playerId !== d.playerId) c++;
      }
      changes.push(c);
      prev = cur;
    }
    const epochs = plan.steps / plan.noise.epochSteps; // 20
    const total = changes.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    // far fewer lead flips per seat than steps (180): on average < one flip per two epochs per seat
    expect(total / 200).toBeLessThan(epochs / 2);
    // and most flips land exactly on an epoch boundary
    const onBoundary = changes.reduce((a, c, i) => a + ((i + 1) % plan.noise.epochSteps === 0 ? c : 0), 0);
    expect(onBoundary / total).toBeGreaterThan(0.6);
  });

  it('the noise is keyed per party: removing a party does not reshuffle the others (elimination stays consistent)', () => {
    const res = contested(120, 'elim', 4);
    const plan = makePlan(ids(120), 0, 60_000, createRng('elim'), res, cfg, 'elim');
    // drop party P3 from every seat and renormalise (what removePlayerFromResults does)
    const without = res.map((r) => {
      const { P3: _drop, ...rest } = r.shares;
      const s = sum(rest);
      const shares = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v / s]));
      const winner = Object.entries(shares).sort((a, b) => b[1] - a[1])[0][0];
      return { ...r, shares, winner };
    });
    const step = 20;
    const a = declaredState(plan, res, step, 120).seats;
    const b = declaredState(plan, without, step, 120).seats;
    let same = 0, other = 0;
    for (const seat of Object.keys(a)) {
      if (a[+seat].playerId === 'P3') continue; // that party's leads have to move
      other++;
      if (a[+seat].playerId === b[+seat].playerId) same++;
    }
    expect(same / other).toBeGreaterThan(0.9);
    // and the end state is still the true (new) result
    const end = declaredState(plan, without, plan.steps, 120);
    expect(end.tally.wins).toEqual(fullTally(without));
  });
});

describe('eventsAt basics', () => {
  it('no events at step 0 and every decided seat is announced as won exactly once', () => {
    const res = results(20, (s) => (s % 4 === 0 ? null : s % 2 ? 'A' : 'B'));
    const plan = makePlan(ids(20), 0, 30_000, createRng('e'), res, cfg, 'g');
    expect(eventsAt(plan, res, 0)).toEqual([]);
    const log: { seat: number; status: string; step: number }[] = [];
    for (let step = 0; step <= plan.steps; step++) for (const e of eventsAt(plan, res, step)) log.push({ seat: e.seat, status: e.status, step });
    const decided = res.filter((r) => r.winner).map((r) => r.seat);
    expect(log.filter((e) => e.status === 'won').map((e) => e.seat).sort((a, b) => a - b)).toEqual(decided);
    for (const seat of decided) {
      const lead = log.find((e) => e.seat === seat && e.status === 'leading')!;
      const won = log.find((e) => e.seat === seat && e.status === 'won')!;
      expect(lead.step).toBeLessThan(won.step);
      expect(won.step).toBe(winStepOf(plan, seat));
    }
  });
});

describe('fullTally', () => {
  it('counts winners and ignores null winners', () => {
    expect(fullTally(results(6, (s) => (s <= 2 ? 'A' : s <= 4 ? 'B' : null)))).toEqual({ A: 2, B: 2 });
    expect(fullTally([])).toEqual({});
  });
});
