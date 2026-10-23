// Counting phase through the GameService: 2-player games count for 1 minute, the reveal spans the whole counting time,
// leads first, wins only from 75 %, the last seat is confirmed at the very last step, snapshots/elimination stay consistent.
import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG } from '@hp/shared';
import type { SeatDeclaration, ServerMessage } from '@hp/shared';
import { declaredState, fullTally } from '../src/core/counting';
import type { CountPlan } from '../src/core/types';
import { Ctx, TEST_CFG } from './helpers';

type Update = Extract<ServerMessage, { type: 'seatUpdate' }>;
const PROD_DURATIONS = { ...TEST_CFG, durations: { ...WORLD_CONFIG.durations, campaignMs: 60_000, postCountingMs: 10_000 } };

/** Everybody rallies in a few seats, so each seat has several parties with shares (needed for lead noise). */
async function contested(c: Ctx, n: number) {
  for (let s = 1; s <= 8; s++) for (let i = 0; i < n; i++) {
    if ((s + i) % 3 !== 2) await c.send(i, { action: 'campaign', type: 'rally', seat: s });
  }
  await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1 });
}

async function pollAndGetPlan(c: Ctx): Promise<CountPlan> {
  const game = await c.game();
  for (let p = 0; p < game.phases; p++) {
    c.clock.set(c.timeline.phaseCloses[p]);
    await c.svc.phaseClose(c.gameId, p);
  }
  return (await c.repo.getCountPlan(c.gameId))!;
}

describe('counting duration by player count', () => {
  it('2 players count for 1 minute (60 steps of 1 s), 3+ players for 3 minutes (180 steps)', async () => {
    const two = await new Ctx({ cfg: { ...PROD_DURATIONS, mapId: 'test', seatCount: 8 } }).started(2, 1);
    expect(two.timeline.countingEnd - two.timeline.campaignEnd).toBe(60_000);
    const p2 = await pollAndGetPlan(two);
    expect(p2.steps).toBe(60);
    expect(p2.intervalMs).toBe(1000);
    expect(p2.startMs).toBe(two.timeline.campaignEnd);
    expect(p2.startMs + p2.steps * p2.intervalMs).toBe(two.timeline.countingEnd);

    for (const n of [3, 4]) {
      const c = await new Ctx({ cfg: { ...PROD_DURATIONS, mapId: 'test', seatCount: 8 } }).started(n, 1);
      expect(c.timeline.countingEnd - c.timeline.campaignEnd).toBe(180_000);
      const p = await pollAndGetPlan(c);
      expect(p.steps).toBe(180);
      expect(p.startMs + p.steps * p.intervalMs).toBe(c.timeline.countingEnd);
    }
  });

  it('the plan length always equals the timeline (also with the short test durations)', async () => {
    for (const n of [2, 3]) {
      const c = await new Ctx().started(n, 2);
      const plan = await pollAndGetPlan(c);
      const expected = n === 2 ? TEST_CFG.durations.countingMsTwoPlayers : TEST_CFG.durations.countingMs;
      expect(c.timeline.countingEnd - c.timeline.campaignEnd).toBe(expected);
      expect(plan.steps * plan.intervalMs).toBe(expected);
    }
  });
});

describe('the reveal over time', () => {
  it('leads only before 75 %, every seat led by 50 %, wins from 75 %, last seat confirmed exactly at the last step', async () => {
    const c = await new Ctx().started(3, 1);
    await contested(c, 3);
    const plan = await pollAndGetPlan(c);
    const results = await c.repo.listSeatResults(c.gameId);
    const decided = results.filter((r) => r.winner !== null);
    expect(decided.length).toBeGreaterThanOrEqual(6);
    const winStart = Math.ceil(0.75 * plan.steps);
    const leadsBy = Math.ceil(0.5 * plan.steps);

    const firstWonStep = new Map<number, number>();
    const firstLeadStep = new Map<number, number>();
    c.notifier.clear();
    let seen = 0;
    for (let step = 0; step <= plan.steps; step++) {
      c.clock.set(plan.startMs + step * plan.intervalMs);
      const r = await c.svc.countReveal(c.gameId);
      const ups = c.notifier.to(c.p[2].playerId, 'seatUpdate') as Update[];
      for (const u of ups.slice(seen)) {
        const m = u.declaration.seat;
        if (u.declaration.status === 'won') { expect(firstWonStep.has(m)).toBe(false); firstWonStep.set(m, step); } else {
          expect(firstWonStep.has(m)).toBe(false); // never a lead after the win
          if (!firstLeadStep.has(m)) firstLeadStep.set(m, step);
        }
      }
      seen = ups.length;
      if (step < winStart) expect(firstWonStep.size).toBe(0);
      if (step >= leadsBy) expect(firstLeadStep.size + firstWonStep.size).toBeGreaterThanOrEqual(decided.length);
      expect(r.done).toBe(step === plan.steps);
    }
    for (const r of decided) {
      expect(firstWonStep.get(r.seat)).toBeGreaterThanOrEqual(winStart);
      expect(firstLeadStep.get(r.seat)!).toBeLessThanOrEqual(leadsBy);
      expect(firstLeadStep.get(r.seat)!).toBeLessThan(firstWonStep.get(r.seat)!);
    }
    expect(Math.max(...firstWonStep.values())).toBe(plan.steps);
    expect(Math.min(...firstWonStep.values())).toBeGreaterThanOrEqual(winStart);
    // final confirmed winners are the true winners and the tally is the full tally
    const ups = c.notifier.to(c.p[2].playerId, 'seatUpdate') as Update[];
    for (const u of ups) if (u.declaration.status === 'won') expect(u.declaration.playerId).toBe(results.find((x) => x.seat === u.declaration.seat)!.winner);
    expect(ups[ups.length - 1].tally.wins).toEqual(fullTally(results));
    expect(ups[ups.length - 1].tally.declared).toBe(decided.length);
    expect((await c.game()).status).toBe('postCounting');
  });

  it('every seat has a winner (committed voters), so all are declared by the last step', async () => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 8 }); // only seat 8 has any effect
    const plan = await pollAndGetPlan(c);
    c.notifier.clear();
    c.clock.set(plan.startMs + (plan.steps - 1) * plan.intervalMs);
    await c.svc.countReveal(c.gameId);
    c.clock.set(plan.startMs + plan.steps * plan.intervalMs);
    await c.svc.countReveal(c.gameId);
    const ups = c.notifier.to(c.p[1].playerId, 'seatUpdate') as Update[];
    expect(new Set(ups.map((u) => u.declaration.seat))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(ups[ups.length - 1].declaration.status).toBe('won');
  });

  it('every snapshot (late joiner / reconnect) equals the deterministic state at the revealed step', async () => {
    const c = await new Ctx().started(3, 1);
    await contested(c, 3);
    const plan = await pollAndGetPlan(c);
    const results = await c.repo.listSeatResults(c.gameId);
    for (const step of [1, 5, Math.floor(plan.steps * 0.5), Math.ceil(plan.steps * 0.8), plan.steps - 1]) {
      c.clock.set(plan.startMs + step * plan.intervalMs);
      await c.svc.countReveal(c.gameId);
      const hello = (await c.svc.hello((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!)) as Extract<ServerMessage, { type: 'hello' }>;
      const expected = declaredState(plan, results, step, 8);
      expect(hello.snapshot.seats).toEqual(expected.seats);
      expect(hello.snapshot.tally).toEqual(expected.tally);
    }
  });

  it('a late call to countReveal catches up all steps in order: same final announcements as step by step', async () => {
    const stepwise = await new Ctx().started(3, 1);
    await contested(stepwise, 3);
    const ps = await pollAndGetPlan(stepwise);
    stepwise.notifier.clear();
    for (let s = 0; s <= ps.steps; s++) { stepwise.clock.set(ps.startMs + s * ps.intervalMs); await stepwise.svc.countReveal(stepwise.gameId); }
    const lump = await new Ctx().started(3, 1);
    await contested(lump, 3);
    const pl = await pollAndGetPlan(lump);
    lump.notifier.clear();
    lump.clock.set(pl.startMs + pl.steps * pl.intervalMs);
    await lump.svc.countReveal(lump.gameId);
    const wonOf = (c: Ctx) => (c.notifier.to(c.p[0].playerId, 'seatUpdate') as Update[]).filter((u) => u.declaration.status === 'won').map((u) => u.declaration.seat).sort();
    expect(wonOf(lump)).toEqual(wonOf(stepwise));
    expect((await lump.game()).status).toBe('postCounting');
  });
});

describe('eliminating a player mid-count', () => {
  it('leads and the end result follow the updated results; wins already confirmed stay consistent', async () => {
    const c = await new Ctx().started(4, 1);
    await contested(c, 4);
    const plan = await pollAndGetPlan(c);
    const mid = Math.floor(plan.steps * 0.6);
    c.clock.set(plan.startMs + mid * plan.intervalMs);
    await c.svc.countReveal(c.gameId);
    const victim = c.p[3].playerId;
    c.notifier.clear();
    await c.svc.eliminate(c.gameId, victim);
    const results = await c.repo.listSeatResults(c.gameId);
    expect(results.every((r) => r.winner !== victim && !(victim in r.shares))).toBe(true);

    // the snapshot a reconnecting player sees is exactly the deterministic state of the updated results
    const hello = (await c.svc.hello((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!)) as Extract<ServerMessage, { type: 'hello' }>;
    const expected = declaredState(plan, results, mid, 8);
    expect(hello.snapshot.seats).toEqual(expected.seats);
    for (const d of Object.values(hello.snapshot.seats) as SeatDeclaration[]) expect(d.playerId).not.toBe(victim);

    // continue to the end: no 'won' before 75 %, final = updated true result
    const winStart = Math.ceil(0.75 * plan.steps);
    let firstWon = Infinity;
    for (let step = mid + 1; step <= plan.steps; step++) {
      c.clock.set(plan.startMs + step * plan.intervalMs);
      await c.svc.countReveal(c.gameId);
      const ups = c.notifier.to(c.p[1].playerId, 'seatUpdate') as Update[];
      if (firstWon === Infinity && ups.some((u) => u.declaration.status === 'won')) firstWon = step;
    }
    expect(firstWon).toBeGreaterThanOrEqual(winStart);
    const ups = c.notifier.to(c.p[1].playerId, 'seatUpdate') as Update[];
    for (const u of ups) expect(u.declaration.playerId).not.toBe(victim);
    expect(ups[ups.length - 1].tally.wins).toEqual(fullTally(results));
    expect((await c.game()).status).toBe('postCounting');
  });
});
