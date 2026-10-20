import { describe, expect, it } from 'vitest';
import { analystPrice } from '@hp/shared';
import { Ctx } from './helpers';

describe('campaign', () => {
  it('deducts the cost atomically and acks with the new budget', async () => {
    const c = await new Ctx().started(3);
    await c.send(1, { action: 'campaign', type: 'rally', seat: 1, clientRef: 'r1' });
    expect(await c.budget(1)).toBe(c.cfg.budget - c.cfg.costs.rally);
    const ack = c.notifier.to(c.p[1].playerId, 'actionAck')[0] as { budget: number; clientRef: string };
    expect(ack.budget).toBe(c.cfg.budget - c.cfg.costs.rally);
    expect(ack.clientRef).toBe('r1');
    await c.send(1, { action: 'campaign', type: 'roadshow', seat: 2 });
    expect(await c.budget(1)).toBe(c.cfg.budget - c.cfg.costs.rally - c.cfg.costs.roadshow);
    expect(await c.budget(0)).toBe(c.cfg.budget);
  });

  it('never overspends', async () => {
    const c = await new Ctx().started(2);
    const n = Math.floor(c.cfg.budget / c.cfg.costs.rally);
    for (let i = 0; i < n + 5; i++) await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    expect(await c.budget(0)).toBeGreaterThanOrEqual(0);
    expect(await c.budget(0)).toBe(c.cfg.budget - n * c.cfg.costs.rally);
    expect(c.lastError(0)?.error).toBe('INSUFFICIENT_FUNDS');
    expect((await c.repo.listActions(c.gameId)).length).toBe(n);
  });

  it('concurrent actions cannot overspend either', async () => {
    const c = await new Ctx().started(2);
    const n = Math.floor(c.cfg.budget / c.cfg.costs.rally);
    await Promise.all(Array.from({ length: n + 20 }, () => c.send(0, { action: 'campaign', type: 'rally', seat: 3 })));
    expect(await c.budget(0)).toBeGreaterThanOrEqual(0);
    expect((await c.repo.listActions(c.gameId)).length).toBeLessThanOrEqual(n);
  });

  it('rejects an action on a seat whose phase has been polled', async () => {
    const c = await new Ctx().started(2, 3);
    c.clock.set(c.timeline.phaseCloses[0]);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 2 }); // phase 0 seat, at the close time
    expect(c.lastError(0)?.error).toBe('SEAT_POLLED');
    await c.send(0, { action: 'campaign', type: 'rally', seat: 5 }); // still open
    expect(c.notifier.to(c.p[0].playerId, 'actionAck')).toHaveLength(1);
    await c.svc.phaseClose(c.gameId, 0);
    c.clock.set(c.timeline.phaseCloses[0] - 1); // even if the clock were wrong, the stored phase state blocks it
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    expect(c.lastError(0)?.error).toBe('SEAT_POLLED');
    expect(await c.budget(0)).toBe(c.cfg.budget - c.cfg.costs.rally);
  });

  it('rejects late actions (server time) and early actions', async () => {
    const c = await new Ctx().started(2, 1);
    c.clock.set(c.timeline.campaignStart - 1);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
    c.clock.set(c.timeline.campaignEnd);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    expect(c.lastError(0)?.error).toBe('TOO_LATE');
    expect(await c.budget(0)).toBe(c.cfg.budget);
  });

  it('rejects malformed actions', async () => {
    const c = await new Ctx().started(2);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 999 });
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
    await c.send(0, { action: 'campaign', type: 'nuke' as never, seat: 1 });
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
    await c.send(0, { action: 'dance' } as never);
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
  });

  it('broadcasts a rally to everyone but never a roadshow', async () => {
    const c = await new Ctx().started(3);
    c.notifier.clear();
    await c.send(1, { action: 'campaign', type: 'roadshow', seat: 4 });
    for (const p of c.p) expect(c.notifier.to(p.playerId, 'news')).toHaveLength(0);
    await c.send(1, { action: 'campaign', type: 'rally', seat: 4 });
    for (const p of c.p) {
      const news = c.notifier.to(p.playerId, 'news');
      expect(news).toHaveLength(1);
      expect((news[0] as { item: object }).item).toEqual({ playerId: c.p[1].playerId, seat: 4, ts: c.clock.now() });
    }
  });

  it('first message triggers hello with snapshot (news only has rallies)', async () => {
    const c = await new Ctx().started(2);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 2 });
    await c.send(1, { action: 'ping', clientTime: 5 });
    const hello = c.notifier.to(c.p[1].playerId, 'hello')[0] as any;
    expect(hello.snapshot.news).toHaveLength(1);
    expect(hello.private.you).toBe(c.p[1].playerId);
    expect(hello.private.myActions).toEqual([]);
    expect(c.notifier.to(c.p[1].playerId, 'pong')).toHaveLength(1);
    await c.send(0, { action: 'ping', clientTime: 1 });
    expect(c.notifier.to(c.p[0].playerId, 'hello')).toHaveLength(1); // only once
    const priv = await c.svc.privateState(c.gameId, c.p[0].playerId);
    expect(priv.myActions.map((a) => a.type)).toEqual(['rally', 'roadshow']);
  });

  it("phase close polls exactly that phase's seats and hides results until counting", async () => {
    const c = await new Ctx().started(2, 3);
    for (const s of [1, 4, 7]) await c.send(0, { action: 'campaign', type: 'rally', seat: s });
    c.notifier.clear();
    c.clock.set(c.timeline.phaseCloses[0]);
    await c.svc.phaseClose(c.gameId, 0);
    const res = await c.repo.listSeatResults(c.gameId);
    expect(res.map((r) => r.seat).sort()).toEqual([1, 2, 3]);
    expect(res.every((r) => r.phase === 0)).toBe(true);
    const closed = c.notifier.to(c.p[1].playerId, 'phaseClosed') as any[];
    expect(closed).toEqual([{ type: 'phaseClosed', phase: 0, seats: [1, 2, 3] }]);
    expect(c.notifier.to(c.p[1].playerId, 'seatUpdate')).toHaveLength(0);
    expect((await c.game()).closedPhases).toBe(1);
    // idempotent
    await c.svc.phaseClose(c.gameId, 0);
    expect((await c.repo.listSeatResults(c.gameId)).length).toBe(3);
    c.clock.set(c.timeline.phaseCloses[1]);
    await c.svc.phaseClose(c.gameId, 1);
    expect((await c.repo.listSeatResults(c.gameId)).map((r) => r.seat).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await c.game()).status).toBe('campaign');
    c.clock.set(c.timeline.phaseCloses[2]);
    await c.svc.phaseClose(c.gameId, 2);
    expect((await c.game()).status).toBe('counting');
  });

  it('only actions before the close count for the polled seats', async () => {
    const c = await new Ctx().started(2, 2);
    c.clock.set(c.timeline.phaseCloses[0] - 10);
    await c.send(1, { action: 'campaign', type: 'rally', seat: 5 });
    c.clock.set(c.timeline.phaseCloses[0] + 10);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 6 }); // after the first close
    await c.svc.phaseClose(c.gameId, 0);
    const res = await c.repo.listSeatResults(c.gameId);
    // only player 1 acted before the close, so they win seats 1..4
    expect(res.every((r) => r.winner === c.p[1].playerId)).toBe(true);
  });
});

describe('analyst', () => {
  it('deducts the price at purchase time and is private', async () => {
    const c = await new Ctx().started(3);
    c.clock.advance(30_000);
    const price = analystPrice(c.cfg, 'seat', c.timeline, c.clock.now());
    await c.send(1, { action: 'campaign', type: 'rally', seat: 7 });
    c.clock.advance(5_000);
    const before = await c.budget(2);
    await c.send(2, { action: 'buyReport', scope: 'seat', seat: 7 });
    const p2 = analystPrice(c.cfg, 'seat', c.timeline, c.clock.now());
    expect(p2).toBeGreaterThanOrEqual(price);
    expect(await c.budget(2)).toBe(before - p2);
    const reps = c.notifier.to(c.p[2].playerId, 'report') as any[];
    expect(reps).toHaveLength(1);
    expect(reps[0].report.price).toBe(p2);
    expect(reps[0].report.asOf).toBe(c.clock.now() - c.cfg.analyst.delayMs);
    expect(reps[0].budget).toBe(before - p2);
    expect(c.notifier.to(c.p[0].playerId, 'report')).toHaveLength(0);
    expect(c.notifier.to(c.p[1].playerId, 'report')).toHaveLength(0);
    await c.send(2, { action: 'buyReport', scope: 'global' });
    const g = (c.notifier.to(c.p[2].playerId, 'report') as any[])[1];
    expect(g.report.scope).toBe('global');
    expect(g.report.price).toBe(analystPrice(c.cfg, 'global', c.timeline, c.clock.now()));
    // private state contains own reports only
    const priv = await c.svc.privateState(c.gameId, c.p[2].playerId);
    expect(priv.myReports).toHaveLength(2);
    expect((await c.svc.privateState(c.gameId, c.p[0].playerId)).myReports).toHaveLength(0);
  });

  it('rejects when funds are short, a seat report without a seat, and polled seats', async () => {
    const c = await new Ctx().started(2, 3);
    await c.repo.updatePlayer(c.gameId, c.p[0].playerId, { budget: 10 });
    await c.send(0, { action: 'buyReport', scope: 'global' });
    expect(c.lastError(0)?.error).toBe('INSUFFICIENT_FUNDS');
    expect(await c.budget(0)).toBe(10);
    await c.send(1, { action: 'buyReport', scope: 'seat' });
    expect(c.lastError(1)?.error).toBe('BAD_REQUEST');
    c.clock.set(c.timeline.phaseCloses[0]);
    await c.send(1, { action: 'buyReport', scope: 'seat', seat: 1 });
    expect(c.lastError(1)?.error).toBe('SEAT_POLLED');
  });
});

describe('elimination', () => {
  it('disconnect schedules a grace check; reconnecting in time cancels it', async () => {
    const c = await new Ctx().started(3);
    await c.svc.disconnect(c.p[1].conn);
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.status).toBe('disconnected');
    expect(c.scheduler.graces.size).toBe(1);
    const g = [...c.scheduler.graces.values()][0];
    expect(g.atMs).toBe(c.clock.now() + c.cfg.durations.graceMs);
    const players = c.notifier.to(c.p[0].playerId, 'players').pop() as any;
    expect(players.players.find((p: any) => p.playerId === c.p[1].playerId).status).toBe('disconnected');
    c.clock.advance(1000);
    await c.svc.connect(c.gameId, c.p[1].token, 'c1b');
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.status).toBe('active');
    expect(c.scheduler.graces.size).toBe(0);
    c.clock.advance(c.cfg.durations.graceMs);
    await c.svc.graceCheck(c.gameId, c.p[1].playerId);
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.status).toBe('active');
    // old connection id is gone, so a late disconnect event for it is harmless
    await c.svc.disconnect(c.p[1].conn);
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.status).toBe('active');
  });

  it('grace-check eliminates, excludes their actions and re-assigns decided seats', async () => {
    const c = await new Ctx().started(3, 1);
    // p1 rallies heavily, p2 lightly: p1 wins everything.
    for (let i = 0; i < 3; i++) await c.send(1, { action: 'campaign', type: 'rally', seat: 1 });
    await c.send(2, { action: 'campaign', type: 'rally', seat: 1 });
    c.clock.set(c.timeline.phaseCloses[0]);
    await c.svc.phaseClose(c.gameId, 0);
    let res = await c.repo.listSeatResults(c.gameId);
    expect(res.every((r) => r.winner === c.p[1].playerId)).toBe(true);
    await c.svc.disconnect(c.p[1].conn);
    c.clock.advance(c.cfg.durations.graceMs);
    await c.svc.graceCheck(c.gameId, c.p[1].playerId);
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.status).toBe('eliminated');
    res = await c.repo.listSeatResults(c.gameId);
    expect(res.every((r) => r.winner === c.p[2].playerId)).toBe(true);
    expect(res.every((r) => !(c.p[1].playerId in r.shares))).toBe(true);
  });

  it("eliminated players' actions are excluded from later phases and they cannot act", async () => {
    const c = await new Ctx().started(3, 2);
    for (let i = 0; i < 3; i++) await c.send(1, { action: 'campaign', type: 'rally', seat: 6 });
    await c.send(2, { action: 'campaign', type: 'rally', seat: 6 });
    await c.svc.eliminate(c.gameId, c.p[1].playerId);
    await c.send(1, { action: 'campaign', type: 'rally', seat: 7 });
    expect(c.lastError(1)?.error).toBe('FORBIDDEN');
    c.clock.set(c.timeline.phaseCloses[0]);
    await c.svc.phaseClose(c.gameId, 0);
    c.clock.set(c.timeline.phaseCloses[1]);
    await c.svc.phaseClose(c.gameId, 1);
    const res = await c.repo.listSeatResults(c.gameId);
    expect(res.every((r) => r.winner === c.p[2].playerId)).toBe(true);
  });

  it('a stale grace check does not eliminate a player who reconnected and dropped again', async () => {
    const c = await new Ctx().started(3);
    await c.svc.disconnect(c.p[1].conn);
    c.clock.advance(1000);
    await c.svc.connect(c.gameId, c.p[1].token, 'c1b');
    c.clock.advance(1000);
    await c.svc.disconnect('c1b');
    c.clock.advance(c.cfg.durations.graceMs - 2500); // the first schedule would fire now
    await c.svc.graceCheck(c.gameId, c.p[1].playerId);
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.status).toBe('disconnected');
  });

  it('fewer than two players left ends the game', async () => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    await c.svc.disconnect(c.p[1].conn);
    c.clock.advance(c.cfg.durations.graceMs);
    await c.svc.graceCheck(c.gameId, c.p[1].playerId);
    expect((await c.game()).status).toBe('finished');
    const result = await c.repo.getResult(c.gameId);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('noGovernment');
    // lifecycle calls afterwards are harmless
    await c.svc.phaseClose(c.gameId, 0);
    expect(await c.svc.countReveal(c.gameId)).toMatchObject({ done: true });
    await c.svc.finalise(c.gameId);
  });
});
