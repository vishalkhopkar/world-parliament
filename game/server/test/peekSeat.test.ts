import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG, createRng } from '@hp/shared';
import type { SeatResult, ServerMessage } from '@hp/shared';
import { Ctx, TEST_CFG, TEST_MAP } from './helpers';
import { driveTo } from './helpers';
import { leadSharesAt, leaderAt, leadStepOf, makePlan, seatSharesAt, winStepOf } from '../src/core/counting';

type SeatShares = Extract<ServerMessage, { type: 'seatShares' }>;

const R = (seat: number, shares: Record<string, number>): SeatResult => {
  const winner = Object.entries(shares).sort((a, b) => b[1] - a[1])[0][0];
  return { seat, phase: 0, winner, shares };
};
const argmax = (s: Record<string, number>) => Object.entries(s).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
const planFor = (results: SeatResult[], seed = 'seed') => makePlan(results.map((r) => r.seat), 0, 100_000, createRng(seed), results, WORLD_CONFIG, seed);

describe('leadSharesAt / seatSharesAt (the numbers behind the seat pie chart)', () => {
  const results = Array.from({ length: 40 }, (_, i) => R(i + 1, { a: 0.5, b: 0.3, c: 0.15, d: 0.05 }));
  const plan = planFor(results);

  it('a confirmed seat shows exactly its true final shares, and they never change', () => {
    for (const r of results) {
      const ws = winStepOf(plan, r.seat);
      for (const step of [ws, ws + 1, plan.steps]) {
        expect(seatSharesAt(plan, r, step)).toEqual({ status: 'won', shares: r.shares });
      }
    }
  });

  it('nothing is available for a seat before its first lead (nothing to leak)', () => {
    for (const r of results) {
      expect(seatSharesAt(plan, r, leadStepOf(plan, r.seat) - 1)).toBeNull();
      expect(seatSharesAt(plan, r, 0)).toBeNull();
    }
    expect(seatSharesAt(plan, { seat: 1, phase: 0, winner: null, shares: {} }, plan.steps)).toBeNull();
  });

  it('a lead gets estimated shares for every party: each in 0..1, adding up to 1, rounded to 3 decimals', () => {
    for (const r of results) {
      for (let step = leadStepOf(plan, r.seat); step < winStepOf(plan, r.seat); step++) {
        const s = seatSharesAt(plan, r, step)!;
        expect(s.status).toBe('leading');
        expect(Object.keys(s.shares).sort()).toEqual(['a', 'b', 'c', 'd']);
        const vals = Object.values(s.shares);
        for (const v of vals) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); expect(Math.round(v * 1000)).toBeCloseTo(v * 1000, 6); }
        expect(vals.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 2);
      }
    }
  });

  it('the biggest slice of a lead is always the party the seat shows as leading (pie and map never disagree)', () => {
    for (const r of results) {
      for (let step = leadStepOf(plan, r.seat); step < winStepOf(plan, r.seat); step++) {
        const s = leadSharesAt(plan, r, step);
        expect(argmax(s), `seat ${r.seat} step ${step}`).toBe(leaderAt(plan, r, step));
      }
    }
  });

  it('the values swing from one step to the next while the count is noisy', () => {
    const r = results[0];
    const lo = leadStepOf(plan, r.seat);
    const seen = new Set<string>();
    for (let step = lo; step < Math.min(lo + 10, winStepOf(plan, r.seat) - 2); step++) seen.add(JSON.stringify(leadSharesAt(plan, r, step)));
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it('the swing dies down: one step before confirmation the estimate equals the true shares', () => {
    for (const r of results) {
      const s = leadSharesAt(plan, r, winStepOf(plan, r.seat) - 1);
      for (const p of Object.keys(r.shares)) expect(s[p]).toBeCloseTo(r.shares[p], 2);
    }
  });

  it('is a pure function of (plan, seat, step)', () => {
    const r = results[3];
    const step = leadStepOf(plan, r.seat) + 2;
    expect(leadSharesAt(plan, r, step)).toEqual(leadSharesAt(plan, r, step));
    expect(leadSharesAt(planFor(results, 'other'), r, step)).not.toEqual(leadSharesAt(plan, r, step));
  });

  it('copes with a seat where one party has everything', () => {
    const one = [R(1, { a: 1 }), R(2, { a: 1, b: 0 })];
    const p = planFor(one);
    for (const r of one) {
      for (let step = leadStepOf(p, r.seat); step < winStepOf(p, r.seat); step++) {
        const s = leadSharesAt(p, r, step);
        expect(s.a).toBeGreaterThan(0.99);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------- the service
const CSV: string[][] = Array.from({ length: TEST_MAP.seatCount }, (_, i) =>
  Array.from({ length: 10 }, (_, k) => `Cand S${i + 1} C${k}`));

/** 3 players, phases = 3, everyone has campaigned so every seat has a winner and different parties get shares; counting started at step 0. */
async function counting(withCsv = true, inLobby?: (c: Ctx) => Promise<void>): Promise<Ctx> {
  const c = new Ctx(withCsv ? { candidates: CSV } : {});
  if (inLobby) {
    await c.lobby(3, 3);
    await inLobby(c);
    await c.svc.start(c.gameId, c.players[0].token);
    for (const p of c.players) await c.svc.connect(c.gameId, p.token, p.conn);
    c.clock.set(c.timeline.campaignStart);
  } else await c.started(3, 3);
  for (let s = 1; s <= 8; s++) await c.send(0, { action: 'campaign', type: 'rally', seat: s });
  for (let s = 1; s <= 6; s++) await c.send(1, { action: 'campaign', type: 'rally', seat: s });
  for (let s = 1; s <= 3; s++) await c.send(2, { action: 'campaign', type: 'rally', seat: s });
  await driveTo(c, 'counting');
  await c.svc.countReveal(c.gameId);
  return c;
}
async function revealTo(c: Ctx, step: number) {
  c.clock.set(c.timeline.campaignEnd + step * TEST_CFG.durations.countingStepMs);
  await c.svc.countReveal(c.gameId);
}
function declared(c: Ctx, viewer = 0) {
  const last = new Map<number, 'leading' | 'won'>();
  for (const m of c.notifier.to(c.p[viewer].playerId, 'seatUpdate') as Extract<ServerMessage, { type: 'seatUpdate' }>[]) last.set(m.declaration.seat, m.declaration.status);
  return last;
}
const replies = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'seatShares') as SeatShares[];

describe('peekSeat (WebSocket action)', () => {
  it('replies privately with the seat\'s status, shares and candidate names of a LEADING seat', async () => {
    const c = await counting();
    await revealTo(c, 20);
    const leading = [...declared(c)].filter(([, s]) => s === 'leading').map(([seat]) => seat);
    expect(leading.length).toBeGreaterThan(0);
    c.notifier.clear();
    await c.send(1, { action: 'peekSeat', seat: leading[0] });
    expect(c.lastError(1)).toBeUndefined();
    const [m] = replies(c, 1);
    expect(m).toMatchObject({ type: 'seatShares', seat: leading[0], status: 'leading' });
    const ids = c.p.map((p) => p.playerId);
    expect(Object.keys(m.shares).every((k) => ids.includes(k))).toBe(true);
    expect(Object.values(m.shares).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    // one name per party, taken from that party's own candidates.csv column on this seat's row
    const players = await c.repo.listPlayers(c.gameId);
    for (const p of players) expect(m.candidates?.[p.playerId]).toBe(CSV[leading[0] - 1][p.candidateColumn as number]);
    expect(replies(c, 0)).toHaveLength(0);
    expect(replies(c, 2)).toHaveLength(0);
  });

  it('never reveals the candidate column itself', async () => {
    const c = await counting();
    await revealTo(c, 20);
    const seat = [...declared(c)][0][0];
    c.notifier.clear();
    await c.send(0, { action: 'peekSeat', seat });
    expect(JSON.stringify(replies(c, 0))).not.toContain('candidateColumn');
  });

  it('a confirmed seat returns its true final shares, identical every time', async () => {
    const c = await counting();
    await revealTo(c, 29);
    const won = [...declared(c)].filter(([, s]) => s === 'won').map(([seat]) => seat);
    expect(won.length).toBeGreaterThan(0);
    const stored = (await c.repo.listSeatResults(c.gameId)).find((r) => r.seat === won[0])!;
    c.notifier.clear();
    await c.send(0, { action: 'peekSeat', seat: won[0] });
    await revealTo(c, 29);
    await c.send(0, { action: 'peekSeat', seat: won[0] });
    const [a, b] = replies(c, 0);
    expect(a).toMatchObject({ status: 'won', shares: stored.shares });
    expect(b.shares).toEqual(a.shares);
  });

  it('the shares of a lead change as the count moves on (they swing), and settle on the true result when confirmed', async () => {
    const c = await counting();
    const snapshots: string[] = [];
    let seat = 0;
    for (let step = 12; step <= 30; step++) {
      await revealTo(c, step);
      const d = declared(c);
      if (!seat) { const lead = [...d].find(([, s]) => s === 'leading'); if (lead) seat = lead[0]; }
      if (!seat) continue;
      c.notifier.clear();
      await c.send(0, { action: 'peekSeat', seat });
      const m = replies(c, 0)[0];
      snapshots.push(JSON.stringify(m.shares));
      if (d.get(seat) === 'won') {
        const stored = (await c.repo.listSeatResults(c.gameId)).find((r) => r.seat === seat)!;
        expect(m.shares).toEqual(stored.shares);
      }
    }
    expect(new Set(snapshots).size).toBeGreaterThan(2);
  });

  it('refuses a seat that has no lead yet and sends nothing', async () => {
    const c = await counting();
    c.notifier.clear();
    await c.send(0, { action: 'peekSeat', seat: 1 });
    expect(c.lastError(0)?.error).toBe('NOT_FOUND');
    expect(replies(c, 0)).toHaveLength(0);
  });

  it('works on the Result screen (finished game) for every seat', async () => {
    const c = await counting();
    await driveTo(c, 'finished');
    c.notifier.clear();
    await c.send(2, { action: 'peekSeat', seat: 3 });
    expect(replies(c, 2)[0]).toMatchObject({ seat: 3, status: 'won' });
  });

  it('omits candidates when the map has no candidates.csv', async () => {
    const c = await counting(false);
    await revealTo(c, 29);
    const seat = [...declared(c)][0][0];
    c.notifier.clear();
    await c.send(0, { action: 'peekSeat', seat });
    expect(replies(c, 0)[0].candidates).toBeUndefined();
  });

  it.each([['a fractional seat', 1.5], ['a string seat', '1'], ['an unknown seat', 99], ['no seat', undefined]])('rejects %s', async (_l, seat) => {
    const c = await counting();
    await revealTo(c, 29);
    await c.send(0, { action: 'peekSeat', seat } as never);
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
  });

  it('is only for the counting phase onwards: WRONG_PHASE during the campaign', async () => {
    const c = await new Ctx({ candidates: CSV }).started(3, 3);
    await c.send(0, { action: 'peekSeat', seat: 1 });
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
  });

  it('is not available to someone who is not a player of the game (never admitted: rejected at the start)', async () => {
    let j!: Awaited<ReturnType<Ctx['svc']['joinGame']>>;
    const c = await counting(true, async (ctx) => { j = await ctx.svc.joinGame({ joinCode: ctx.joinCode, nickname: 'Outsider' }); }); // never admitted
    await revealTo(c, 29);
    const outsider = (await c.repo.listPlayers(c.gameId)).find((p) => p.playerId === j.playerId)!;
    await expect(c.svc.peekSeat(outsider, [...declared(c)][0][0])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(c.notifier.to(j.playerId, 'seatShares')).toHaveLength(0);
  });
});
