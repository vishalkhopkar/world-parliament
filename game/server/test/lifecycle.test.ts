// Lifecycle driven by the state machine / timers: phaseClose, countReveal, finalise — idempotency, ordering, outcomes.
import { describe, expect, it } from 'vitest';
import { majorityOf } from '@hp/shared';
import type { SeatDeclaration, ServerMessage } from '@hp/shared';
import { Ctx, driveTo, lineMap, pollAll, setResults, statusAfterCount } from './helpers';

const upd = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'seatUpdate') as Extract<ServerMessage, { type: 'seatUpdate' }>[];

describe('phaseClose', () => {
  it.each([[-1], [1.5], [3], [99], [Number.NaN], [Infinity]])('phase index %s is ignored (no polling, no broadcast, no status change)', async (idx) => {
    const c = await new Ctx().started(2, 3);
    c.notifier.clear();
    await c.svc.phaseClose(c.gameId, idx);
    expect(await c.repo.listSeatResults(c.gameId)).toEqual([]);
    expect((await c.game()).closedPhases).toBe(0);
    expect((await c.game()).status).toBe('campaign');
    expect(c.notifier.log).toEqual([]);
  });

  it('unknown game, lobby game and finished game are ignored', async () => {
    const c = await new Ctx().lobby(2);
    await c.svc.phaseClose('nope', 0);
    await c.svc.phaseClose(c.gameId, 0);
    expect(await c.repo.listSeatResults(c.gameId)).toEqual([]);
    const f = await new Ctx().started(2, 1);
    await driveTo(f, 'finished');
    const before = JSON.stringify(await f.repo.listSeatResults(f.gameId));
    f.notifier.clear();
    await f.svc.phaseClose(f.gameId, 0);
    expect(JSON.stringify(await f.repo.listSeatResults(f.gameId))).toBe(before);
    expect(f.notifier.log).toEqual([]);
  });

  it('is idempotent: a repeated call neither re-polls nor changes the stored results', async () => {
    const c = await new Ctx().started(3, 3);
    await c.send(1, { action: 'campaign', type: 'rally', seat: 1 });
    c.clock.set(c.timeline.phaseCloses[0]);
    await c.svc.phaseClose(c.gameId, 0);
    const first = JSON.stringify(await c.repo.listSeatResults(c.gameId));
    // an action that would change the result is impossible now, so alter the clock and call again
    c.clock.advance(5000);
    await c.svc.phaseClose(c.gameId, 0);
    await c.svc.phaseClose(c.gameId, 0);
    expect(JSON.stringify(await c.repo.listSeatResults(c.gameId))).toBe(first);
    expect((await c.game()).closedPhases).toBe(1);
  });

  it('concurrent phase closes produce one consistent set of results', async () => {
    const c = await new Ctx().started(3, 2);
    for (const s of [1, 5]) await c.send(1, { action: 'campaign', type: 'rally', seat: s });
    await c.send(2, { action: 'campaign', type: 'rally', seat: 2 });
    c.clock.set(c.timeline.phaseCloses[0]);
    await Promise.all([1, 2, 3, 4].map(() => c.svc.phaseClose(c.gameId, 0)));
    const res = await c.repo.listSeatResults(c.gameId);
    expect(res.map((r) => r.seat)).toEqual([1, 2, 3, 4]);
    expect((await c.game()).closedPhases).toBe(1);
  });

  it('closedPhases only moves forward, also when phases are closed out of order', async () => {
    const c = await new Ctx().started(2, 3);
    c.clock.set(c.timeline.phaseCloses[2]);
    await c.svc.phaseClose(c.gameId, 1);
    expect((await c.game()).closedPhases).toBe(2);
    await c.svc.phaseClose(c.gameId, 0);
    expect((await c.game()).closedPhases).toBe(2);
    expect((await c.repo.listSeatResults(c.gameId)).map((r) => r.phase).sort()).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('only the last phase starts counting, and starting twice does not reset the count', async () => {
    const c = await new Ctx().started(3, 2);
    c.clock.set(c.timeline.phaseCloses[0]);
    await c.svc.phaseClose(c.gameId, 0);
    expect((await c.game()).status).toBe('campaign');
    expect(await c.repo.getCountPlan(c.gameId)).toBeNull();
    c.clock.set(c.timeline.phaseCloses[1]);
    await c.svc.phaseClose(c.gameId, 1);
    expect((await c.game()).status).toBe('counting');
    const plan = await c.repo.getCountPlan(c.gameId);
    expect(plan!.order.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(plan!.startMs).toBe(c.timeline.campaignEnd);
    c.clock.set(plan!.startMs + plan!.intervalMs * 2);
    await c.svc.countReveal(c.gameId);
    const revealed = (await c.game()).revealedStep;
    expect(revealed).toBeGreaterThan(0);
    c.notifier.clear();
    await c.svc.phaseClose(c.gameId, 1);
    expect((await c.game()).revealedStep).toBe(revealed);
    expect((await c.game()).status).toBe('counting');
    expect(await c.repo.getCountPlan(c.gameId)).toEqual(plan);
    expect(c.notifier.to(c.p[0].playerId, 'status')).toHaveLength(0);
  });

  it('every player is told "counting" exactly once and phaseClosed carries that phase\'s seats', async () => {
    const c = await new Ctx().started(3, 3);
    await pollAll(c);
    for (let i = 0; i < 3; i++) {
      const closed = c.notifier.to(c.p[i].playerId, 'phaseClosed') as { phase: number; seats: number[] }[];
      expect(closed.map((m) => m.phase)).toEqual([0, 1, 2]);
      expect(closed.map((m) => m.seats)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8]]);
      expect((c.notifier.to(c.p[i].playerId, 'status') as { status: string }[]).filter((m) => m.status === 'counting')).toHaveLength(1);
    }
  });

  it('seats nobody campaigned in still get a winner (committed voters + randomness) and are declared', async () => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 8 }); // far from everything else
    await c.runCampaignToCountingEnd();
    const res = await c.repo.listSeatResults(c.gameId);
    // roadshow in seat 8 only reaches seat 8, yet no seat is left without a winner
    expect(res.filter((r) => r.winner === null)).toEqual([]);
    const declared = new Set(upd(c, 1).map((m) => m.declaration.seat));
    expect([...declared].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('players eliminated before a phase closes do not take seats (their actions are excluded)', async () => {
    const c = await new Ctx().started(3, 1);
    for (let i = 0; i < 4; i++) await c.send(1, { action: 'campaign', type: 'rally', seat: 3 });
    await c.send(2, { action: 'campaign', type: 'rally', seat: 3 });
    await c.svc.eliminate(c.gameId, c.p[1].playerId);
    await pollAll(c);
    const res = await c.repo.listSeatResults(c.gameId);
    expect(res.every((r) => r.winner === c.p[2].playerId)).toBe(true);
  });
});

describe('countReveal', () => {
  it.each(['lobby', 'abandoned', 'finished'] as const)('%s game: done immediately, nothing sent', async (kind) => {
    const c = kind === 'lobby' ? await new Ctx().lobby(2) : await new Ctx().started(2, 1);
    if (kind !== 'lobby') await driveTo(c, kind);
    c.notifier.clear();
    expect(await c.svc.countReveal(c.gameId)).toMatchObject({ done: true });
    expect(await c.svc.countReveal('nope')).toMatchObject({ done: true });
    expect(c.notifier.log).toEqual([]);
  });

  it('called during the campaign it polls what is due (late invocation) and starts counting', async () => {
    const c = await new Ctx().started(2, 2);
    c.clock.set(c.timeline.campaignEnd);
    const r = await c.svc.countReveal(c.gameId);
    expect((await c.game()).closedPhases).toBe(2);
    expect((await c.game()).status).toBe('counting');
    expect(r.done).toBe(false);
  });

  it('every decided seat gets "leading" message(s) then exactly one "won" message, tallies only grow, final tally matches the results', async () => {
    const c = await new Ctx().started(3, 2);
    for (let s = 1; s <= 8; s++) await c.send(s % 3, { action: 'campaign', type: 'rally', seat: s });
    await pollAll(c);
    c.notifier.clear();
    let r = await c.svc.countReveal(c.gameId);
    let guard = 0;
    while (!r.done && guard++ < 500) { c.clock.set(r.nextAtMs); r = await c.svc.countReveal(c.gameId); }
    expect(r.done).toBe(true);
    const results = await c.repo.listSeatResults(c.gameId);
    for (let i = 0; i < 3; i++) {
      const msgs = upd(c, i);
      const bySeat = new Map<number, SeatDeclaration[]>();
      for (const m of msgs) bySeat.set(m.declaration.seat, [...(bySeat.get(m.declaration.seat) ?? []), m.declaration]);
      for (const res of results) {
        const ds = bySeat.get(res.seat)!;
        // leads first (they may change), then exactly one 'won' with the true winner
        const st = ds.map((d) => d.status);
        expect(st[0]).toBe('leading');
        expect(st[st.length - 1]).toBe('won');
        expect(st.filter((x) => x === 'won')).toHaveLength(1);
        const won = ds[ds.length - 1];
        expect(won.playerId).toBe(res.winner);
        expect(won.shares).toBeDefined();
        for (const d of ds.slice(0, -1)) expect(d.shares).toBeUndefined(); // leading carries no shares
      }
      let declared = 0;
      for (const m of msgs) { expect(m.tally.declared).toBeGreaterThanOrEqual(declared); declared = m.tally.declared; expect(m.tally.total).toBe(8); }
      expect(declared).toBe(8);
    }
    expect((await c.game()).status).toBe(await statusAfterCount(c));
    expect((c.notifier.to(c.p[0].playerId, 'status') as { status: string }[]).filter((m) => m.status === 'postCounting')).toHaveLength(1);
  });

  it('two invocations for the same moment reveal each step once', async () => {
    const c = await new Ctx().started(2, 1);
    for (let s = 1; s <= 8; s++) await c.send(0, { action: 'campaign', type: 'rally', seat: s });
    await pollAll(c);
    const plan = (await c.repo.getCountPlan(c.gameId))!;
    c.clock.set(plan.startMs + plan.steps * plan.intervalMs);
    c.notifier.clear();
    await Promise.all([c.svc.countReveal(c.gameId), c.svc.countReveal(c.gameId), c.svc.countReveal(c.gameId)]);
    const u = upd(c, 1).map((m) => `${m.declaration.seat}:${m.declaration.status}:${m.declaration.playerId}`);
    u.forEach((k, i) => { if (i) expect(k).not.toBe(u[i - 1]); }); // never the same announcement twice in a row (not 3x)
    expect(u.filter((k) => k.split(':')[1] === 'won')).toHaveLength(8);
    expect(new Set(upd(c, 1).map((m) => m.declaration.seat)).size).toBe(8);
  });

  it('nextAtMs is the start of the next step and the game moves to postCounting only after the last step', async () => {
    const c = await new Ctx().started(2, 1);
    await pollAll(c);
    const plan = (await c.repo.getCountPlan(c.gameId))!;
    const r0 = await c.svc.countReveal(c.gameId);
    expect(r0.done).toBe(false);
    expect(r0.nextAtMs).toBe(plan.startMs + plan.intervalMs);
    c.clock.set(plan.startMs + (plan.steps - 1) * plan.intervalMs);
    expect((await c.svc.countReveal(c.gameId)).done).toBe(false);
    expect((await c.game()).status).toBe('counting');
    c.clock.set(plan.startMs + plan.steps * plan.intervalMs);
    expect((await c.svc.countReveal(c.gameId)).done).toBe(true);
    expect((await c.game()).status).toBe(await statusAfterCount(c));
  });

  it('a hello in the middle of counting only contains what has been declared so far', async () => {
    const c = await new Ctx().started(2, 1);
    for (let s = 1; s <= 8; s++) await c.send(0, { action: 'campaign', type: 'rally', seat: s });
    await pollAll(c);
    const plan = (await c.repo.getCountPlan(c.gameId))!;
    c.clock.set(plan.startMs + Math.floor(plan.steps / 2) * plan.intervalMs);
    await c.svc.countReveal(c.gameId);
    const hello = (await c.svc.hello((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!)) as Extract<ServerMessage, { type: 'hello' }>;
    const n = Object.keys(hello.snapshot.seats).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(8 + 1);
    expect(hello.snapshot.tally!.declared).toBeLessThan(8);
    expect(hello.snapshot.result).toBeNull();
  });
});

describe('finalise', () => {
  it('lobby game and unknown game: no-op', async () => {
    const c = await new Ctx().lobby(2);
    await c.svc.finalise(c.gameId);
    await c.svc.finalise('nope');
    expect((await c.game()).status).toBe('lobby');
    expect(await c.repo.getResult(c.gameId)).toBeNull();
  });

  it('finalising during the campaign polls everything, reveals everything and finishes', async () => {
    const c = await new Ctx().started(3, 3);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    await c.svc.finalise(c.gameId);
    expect((await c.game()).status).toBe('finished');
    expect((await c.repo.listSeatResults(c.gameId)).length).toBe(8);
    expect((await c.game()).finalised).toBe(true);
  });

  it('concurrent finalise calls produce exactly one result broadcast and one stored result', async () => {
    const c = await new Ctx().started(3, 1);
    for (let s = 1; s <= 8; s++) await c.send(0, { action: 'campaign', type: 'rally', seat: s });
    await pollAll(c);
    c.notifier.clear();
    await Promise.all(Array.from({ length: 6 }, () => c.svc.finalise(c.gameId)));
    for (let i = 0; i < 3; i++) {
      expect(c.notifier.to(c.p[i].playerId, 'result')).toHaveLength(1);
      expect((c.notifier.to(c.p[i].playerId, 'status') as { status: string }[]).filter((m) => m.status === 'finished')).toHaveLength(1);
    }
    expect(c.notifier.to(c.p[0].playerId, 'government')).toHaveLength(1);
  });

  it('a result in the hello of a reconnecting player is identical to the broadcast result', async () => {
    const c = await new Ctx().started(3, 1);
    for (let s = 1; s <= 8; s++) await c.send(1, { action: 'campaign', type: 'rally', seat: s });
    await driveTo(c, 'finished');
    const sent = (c.notifier.to(c.p[2].playerId, 'result') as Extract<ServerMessage, { type: 'result' }>[])[0].result;
    await c.svc.connect(c.gameId, c.p[2].token, 'again');
    await c.svc.handleMessage('again', { action: 'ping', clientTime: 1 });
    const hello = c.notifier.to(c.p[2].playerId, 'hello').pop() as Extract<ServerMessage, { type: 'hello' }>;
    expect(hello.snapshot.result).toEqual(sent);
    expect(hello.snapshot.status).toBe('finished');
    expect(Object.keys(hello.snapshot.seats)).toHaveLength(8);
  });

  it('error=true on an already finalised game changes nothing; error=true on a game whose finishing throws abandons it', async () => {
    const c = await new Ctx().started(2, 1);
    await driveTo(c, 'finished');
    const before = JSON.stringify(await c.repo.getResult(c.gameId));
    await c.svc.finalise(c.gameId, { error: true });
    expect(JSON.stringify(await c.repo.getResult(c.gameId))).toBe(before);

    const d = await new Ctx().started(2, 1);
    d.repo.listSeatResults = async () => { throw new Error('boom'); };
    const spy = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(d.svc.finalise(d.gameId)).rejects.toThrow('boom');   // without error flag the failure propagates (state machine retries)
      await d.svc.finalise(d.gameId, { error: true });                  // with it the game is abandoned and everyone is told
    } finally { spy.mockRestore(); }
    expect((await d.game()).status).toBe('abandoned');
    expect(d.notifier.to(d.p[0].playerId, 'status').pop()).toMatchObject({ status: 'abandoned' });
  });

  it('after the game is finished every lifecycle entry point is harmless', async () => {
    const c = await new Ctx().started(3, 2);
    await driveTo(c, 'finished');
    const snap = JSON.stringify([await c.repo.listSeatResults(c.gameId), await c.repo.getResult(c.gameId), await c.game()]);
    c.notifier.clear();
    await c.svc.phaseClose(c.gameId, 0);
    await c.svc.phaseClose(c.gameId, 1);
    await c.svc.countReveal(c.gameId);
    await c.svc.finalise(c.gameId);
    await c.svc.graceCheck(c.gameId, c.p[1].playerId);
    expect(JSON.stringify([await c.repo.listSeatResults(c.gameId), await c.repo.getResult(c.gameId), await c.game()])).toBe(snap);
    expect(c.notifier.log).toEqual([]);
  });
});

describe('who wins: majority = floor(N/2)+1 for odd and even seat counts', () => {
  // N seats, `a` wins exactly `need` or `need-1`: with the former A is the outright winner, with the latter nobody is
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    const need = Math.floor(n / 2) + 1;
    it(`N=${n}: ${need} seats is a majority, ${need - 1} is not (3 players)`, async () => {
      expect(majorityOf(n)).toBe(need);
      for (const wins of [need, need - 1]) {
        const c = await new Ctx({ map: lineMap(n) }).started(3, 1);
        await driveTo(c, 'counting');
        // A wins `wins` seats; the rest go to B, but never enough for B to reach a majority itself (or C)
        const winners: Record<number, number | null> = {};
        for (let s = 1; s <= n; s++) winners[s] = s <= wins ? 0 : 1 + (s % 2);
        await setResults(c, winners);
        await c.svc.finalise(c.gameId);
        const result = (await c.repo.getResult(c.gameId))!;
        const tally = result.tally;
        const aSeats = tally[c.p[0].playerId] ?? 0;
        expect(aSeats).toBe(wins);
        const best = Math.max(...Object.values(tally));
        if (best >= need) {
          expect(result.outcome).toBe('majority');
          expect(result.winners).toHaveLength(1);
          expect(tally[result.winners[0]]).toBeGreaterThanOrEqual(need);
        } else {
          expect(result.outcome).toBe('noGovernment');
          expect(result.winners).toEqual([]);
        }
        if (wins === need) expect(result.winners).toEqual([c.p[0].playerId]);
      }
    });
  }

  it('a majority winner who is eliminated cannot form the government; the remaining seats are re-assigned', async () => {
    const c = await new Ctx().started(3, 1);
    for (let s = 1; s <= 8; s++) await c.send(1, { action: 'campaign', type: 'rally', seat: s });
    await c.send(2, { action: 'campaign', type: 'rally', seat: 1 });
    await driveTo(c, 'counting');
    await c.svc.eliminate(c.gameId, c.p[1].playerId);
    await c.svc.finalise(c.gameId);
    const result = (await c.repo.getResult(c.gameId))!;
    expect(result.points.find((p) => p.playerId === c.p[1].playerId)!.total).toBe(0);
    expect(result.winners).not.toContain(c.p[1].playerId);
    expect(result.tally[c.p[1].playerId]).toBeUndefined();
  });

  it('exactly 4 of 8 for each of two players (2 players) is a draw, 5-3 a majority', async () => {
    for (const [aWins, outcome] of [[4, 'draw'], [5, 'majority'], [3, 'majority']] as const) {
      const c = await new Ctx().started(2, 1);
      await driveTo(c, 'counting');
      const winners: Record<number, number | null> = {};
      for (let s = 1; s <= 8; s++) winners[s] = s <= aWins ? 0 : 1;
      await setResults(c, winners);
      await c.svc.finalise(c.gameId);
      const result = (await c.repo.getResult(c.gameId))!;
      expect(result.outcome).toBe(outcome);
      if (outcome === 'draw') expect(result.winners.sort()).toEqual(c.p.map((p) => p.playerId).sort());
    }
  });

  it('two players, 4-4 after one is also missing a seat (6 decided seats, 3-3) is still a draw', async () => {
    const c = await new Ctx().started(2, 1);
    await driveTo(c, 'counting');
    await setResults(c, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: null, 8: null });
    await c.svc.finalise(c.gameId);
    expect((await c.repo.getResult(c.gameId))!.outcome).toBe('draw');
  });

  it('nobody campaigned: committed voters still decide every seat, so there is always a winner', async () => {
    for (const n of [3, 2]) {
      const c = await new Ctx().started(n, 1);
      await driveTo(c, 'finished');
      const res = await c.repo.listSeatResults(c.gameId);
      expect(res.every((r) => r.winner !== null)).toBe(true);
    }
  });

  it('points are whole numbers and the opposition scores 0', async () => {
    const c = await new Ctx().started(3, 1);
    await driveTo(c, 'counting');
    await setResults(c, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1, 8: 2 });
    await c.svc.finalise(c.gameId);
    const result = (await c.repo.getResult(c.gameId))!;
    expect(result.outcome).toBe('majority');
    for (const p of result.points) expect(Number.isInteger(p.total)).toBe(true);
    expect(result.points.filter((p) => p.playerId !== c.p[0].playerId).every((p) => p.total === c.cfg.points.opposition && p.total === 0)).toBe(true);
    expect(result.points.find((p) => p.playerId === c.p[0].playerId)!.total).toBeGreaterThan(0);
  });
});
