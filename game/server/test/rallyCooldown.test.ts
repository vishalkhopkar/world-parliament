// Rally cooldown: a player may rally only cooldowns.rallyMs after their previous ACCEPTED rally (server clock).
// Roadshows have no cooldown. Refusals are RATE_LIMITED (HTTP 429) with retryAt = the next allowed rally time.
import { describe, expect, it } from 'vitest';
import { rallyAvailableAt } from '@hp/shared';
import type { PrivateState, ServerMessage } from '@hp/shared';
import { GameService } from '../src/core/gameService';
import { DynamoRepo } from '../src/aws/dynamoRepo';
import { HTTP_STATUS } from '../src/core/types';
import { FakeDdb } from './fakes/fakeDdb';
import { Ctx, FakeNotifier } from './helpers';

type Ack = Extract<ServerMessage, { type: 'actionAck' }>;
type Err = Extract<ServerMessage, { type: 'error' }>;
const rally = (seat: number, clientRef?: string) => ({ action: 'campaign' as const, type: 'rally' as const, seat, ...(clientRef ? { clientRef } : {}) });
const roadshow = (seat: number) => ({ action: 'campaign' as const, type: 'roadshow' as const, seat });

const acks = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'actionAck') as Ack[];
const errors = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'error') as Err[];
const rallies = async (c: Ctx, i?: number) =>
  (await c.repo.listActions(c.gameId)).filter((a) => a.type === 'rally' && (i === undefined || a.playerId === c.p[i].playerId));

describe('rally cooldown (cooldowns.rallyMs)', () => {
  it('RATE_LIMITED is HTTP 429 and the test config uses a 30 s gap', () => {
    expect(HTTP_STATUS.RATE_LIMITED).toBe(429);
    expect(new Ctx().cfg.cooldowns.rallyMs).toBe(30_000);
  });

  it('a second rally within the gap is RATE_LIMITED: no charge, no action stored, no news, retryAt = next allowed time', async () => {
    const c = await new Ctx().started(2, 1);
    const t0 = c.clock.now();
    await c.send(0, rally(1));
    expect(acks(c, 0)).toHaveLength(1);
    const budget = await c.budget(0);
    c.notifier.clear();
    c.clock.advance(c.cfg.cooldowns.rallyMs - 1);
    await c.send(0, rally(3, 'second'));
    const e = c.lastError(0)!;
    expect(e).toMatchObject({ error: 'RATE_LIMITED', clientRef: 'second', retryAt: t0 + c.cfg.cooldowns.rallyMs });
    expect(e.message).toMatch(/Next rally in 1 s/);
    expect(await c.budget(0)).toBe(budget);
    expect(await rallies(c, 0)).toHaveLength(1);
    expect(c.notifier.to(c.p[1].playerId, 'news')).toHaveLength(0);
    expect(acks(c, 0)).toHaveLength(0);
  });

  it('the message rounds the wait up to whole seconds', async () => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, rally(1));
    c.clock.advance(1);
    await c.send(0, rally(1));
    expect(c.lastError(0)?.message).toMatch(/Next rally in 30 s/);
    c.clock.advance(10_500);
    await c.send(0, rally(1));
    expect(c.lastError(0)?.message).toMatch(/Next rally in 20 s/);
  });

  it('a rally is accepted again at exactly +rallyMs', async () => {
    const c = await new Ctx().started(2, 1);
    const t0 = c.clock.now();
    await c.send(0, rally(1));
    c.clock.set(t0 + c.cfg.cooldowns.rallyMs);
    await c.send(0, rally(2));
    expect(acks(c, 0)).toHaveLength(2);
    expect(errors(c, 0)).toHaveLength(0);
    expect((await rallies(c, 0)).map((a) => a.ts)).toEqual([t0, t0 + c.cfg.cooldowns.rallyMs]);
    expect(await c.budget(0)).toBe(c.cfg.budget - 2 * c.cfg.costs.rally);
  });

  it('a refused rally does not restart the gap (it is measured from the last ACCEPTED rally)', async () => {
    const c = await new Ctx().started(2, 1);
    const t0 = c.clock.now();
    await c.send(0, rally(1));
    c.clock.set(t0 + 20_000);
    await c.send(0, rally(1));
    expect(c.lastError(0)?.error).toBe('RATE_LIMITED');
    c.clock.set(t0 + c.cfg.cooldowns.rallyMs);
    await c.send(0, rally(1));
    expect(await rallies(c, 0)).toHaveLength(2);
  });

  it('roadshows have no cooldown: right after a rally, many in a row, and they neither reset nor extend the rally gap', async () => {
    const c = await new Ctx().started(2, 1);
    const t0 = c.clock.now();
    await c.send(0, rally(1));
    for (let k = 0; k < 5; k++) await c.send(0, roadshow(1 + k));
    c.clock.set(t0 + 29_999);
    await c.send(0, roadshow(2));
    expect(errors(c, 0)).toHaveLength(0);
    expect(acks(c, 0)).toHaveLength(7);
    await c.send(0, rally(2));
    expect(c.lastError(0)).toMatchObject({ error: 'RATE_LIMITED', retryAt: t0 + 30_000 }); // roadshows did not reset it
    c.clock.set(t0 + 30_000);
    await c.send(0, rally(2)); // nor extend it
    expect(await rallies(c, 0)).toHaveLength(2);
  });

  it('a first rally right after roadshows is allowed (roadshows never start a cooldown)', async () => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, roadshow(1));
    await c.send(0, rally(1));
    expect(errors(c, 0)).toHaveLength(0);
    expect(await rallies(c, 0)).toHaveLength(1);
  });

  it('two players are independent', async () => {
    const c = await new Ctx().started(3, 1);
    await c.send(0, rally(1));
    await c.send(1, rally(1));
    c.clock.advance(5_000);
    await c.send(2, rally(1));
    expect(errors(c, 0).concat(errors(c, 1), errors(c, 2))).toHaveLength(0);
    await c.send(1, rally(2));
    expect(c.lastError(1)?.error).toBe('RATE_LIMITED');
    expect(await rallies(c)).toHaveLength(3);
  });

  it('the cooldown is per player, not per seat, and survives a phase close', async () => {
    const c = await new Ctx().started(2, 3);
    const tl = c.timeline;
    // rally in a phase-0 seat just before phase 0 closes, then try a phase-2 seat right after the close
    c.clock.set(tl.phaseCloses[0] - 1_000);
    await c.send(0, rally(1));
    expect(acks(c, 0)).toHaveLength(1);
    c.clock.set(tl.phaseCloses[0]);
    await c.svc.phaseClose(c.gameId, 0);
    await c.send(0, rally(8));
    expect(c.lastError(0)).toMatchObject({ error: 'RATE_LIMITED', retryAt: tl.phaseCloses[0] - 1_000 + c.cfg.cooldowns.rallyMs });
    c.clock.set(tl.phaseCloses[0] - 1_000 + c.cfg.cooldowns.rallyMs);
    await c.send(0, rally(8));
    expect(await rallies(c, 0)).toHaveLength(2);
  });

  it('SEAT_POLLED is reported before RATE_LIMITED, and INSUFFICIENT_FUNDS after it', async () => {
    const c = await new Ctx().started(2, 3);
    await c.send(0, rally(4));
    c.clock.set(c.timeline.phaseCloses[0]);
    await c.svc.phaseClose(c.gameId, 0);
    await c.send(0, rally(1)); // polled seat and within the gap
    expect(c.lastError(0)?.error).toBe('SEAT_POLLED');
    await c.repo.updatePlayer(c.gameId, c.p[0].playerId, { budget: 0 });
    c.clock.set(c.timeline.phaseCloses[0] + 1);
    const last = (await rallies(c, 0))[0].ts;
    expect(c.clock.now()).toBeLessThan(last + c.cfg.cooldowns.rallyMs); // phase 0 closes inside the first gap
    await c.send(0, rally(4)); // within the gap and broke
    expect(c.lastError(0)?.error).toBe('RATE_LIMITED');
    c.clock.set(last + c.cfg.cooldowns.rallyMs);
    await c.send(0, rally(4));
    expect(c.lastError(0)?.error).toBe('INSUFFICIENT_FUNDS');
  });

  it('N simultaneous rallies by one player at one timestamp: exactly 1 accepted, N-1 RATE_LIMITED, charged once', async () => {
    const c = await new Ctx().started(2, 1);
    const N = 25;
    await Promise.all(Array.from({ length: N }, (_, k) => c.send(0, rally(1 + (k % 8), `r${k}`))));
    expect(acks(c, 0)).toHaveLength(1);
    const errs = errors(c, 0);
    expect(errs).toHaveLength(N - 1);
    expect(errs.every((e) => e.error === 'RATE_LIMITED' && e.retryAt === c.clock.now() + c.cfg.cooldowns.rallyMs)).toBe(true);
    expect(await rallies(c, 0)).toHaveLength(1);
    expect(await c.budget(0)).toBe(c.cfg.budget - c.cfg.costs.rally);
    expect(c.notifier.to(c.p[1].playerId, 'news')).toHaveLength(1);
  });

  it('concurrent rallies and roadshows: one rally, every roadshow, budget = start - sum(costs)', async () => {
    const c = await new Ctx().started(2, 1);
    const jobs = Array.from({ length: 40 }, (_, k) => c.send(0, k % 2 ? rally(1) : roadshow(2)));
    await Promise.all(jobs);
    const mine = (await c.repo.listActions(c.gameId)).filter((a) => a.playerId === c.p[0].playerId);
    expect(mine.filter((a) => a.type === 'rally')).toHaveLength(1);
    expect(mine.filter((a) => a.type === 'roadshow')).toHaveLength(20);
    expect(await c.budget(0)).toBe(c.cfg.budget - c.cfg.costs.rally - 20 * c.cfg.costs.roadshow);
  });

  it('nextRallyAt: absent/null before any rally, then lastRally + rallyMs in actionAck (rally and roadshow) and PrivateState', async () => {
    const c = await new Ctx().started(2, 1);
    expect((await c.svc.privateState(c.gameId, c.p[0].playerId)).nextRallyAt ?? null).toBeNull();
    await c.send(0, roadshow(1));
    expect(acks(c, 0)[0].nextRallyAt ?? null).toBeNull();
    const t0 = c.clock.now();
    await c.send(0, rally(1));
    expect(acks(c, 0)[1].nextRallyAt).toBe(t0 + c.cfg.cooldowns.rallyMs);
    expect(acks(c, 0)[1].nextRallyAt).toBe(rallyAvailableAt(t0, c.cfg));
    c.clock.advance(1_000);
    await c.send(0, roadshow(1));
    expect(acks(c, 0)[2].nextRallyAt).toBe(t0 + c.cfg.cooldowns.rallyMs);
    const ps: PrivateState = await c.svc.privateState(c.gameId, c.p[0].playerId);
    expect(ps.nextRallyAt).toBe(t0 + c.cfg.cooldowns.rallyMs);
    expect((await c.svc.privateState(c.gameId, c.p[1].playerId)).nextRallyAt ?? null).toBeNull(); // only own
  });

  it('nextRallyAt is in the hello (reconnect) private state', async () => {
    const c = await new Ctx().started(2, 1);
    const t0 = c.clock.now();
    await c.send(0, rally(1));
    const me = (await c.repo.getPlayer(c.gameId, c.p[0].playerId))!;
    const hello = (await c.svc.hello(me)) as Extract<ServerMessage, { type: 'hello' }>;
    expect(hello.private.nextRallyAt).toBe(t0 + c.cfg.cooldowns.rallyMs);
  });

  it('players stored before lastRallyAt existed (attribute missing) may rally', async () => {
    const c = await new Ctx().started(2, 1);
    const p = (await c.repo.getPlayer(c.gameId, c.p[0].playerId))!;
    expect(p.lastRallyAt).toBeUndefined();
    await c.send(0, rally(1));
    expect(acks(c, 0)).toHaveLength(1);
    expect((await c.repo.getPlayer(c.gameId, c.p[0].playerId))!.lastRallyAt).toBe(c.clock.now());
  });

  it('cooldowns.rallyMs = 0 disables the cooldown', async () => {
    const base = new Ctx();
    const c = await new Ctx({ cfg: { ...base.cfg, cooldowns: { rallyMs: 0 } } }).started(2, 1);
    for (let k = 0; k < 4; k++) await c.send(0, rally(1));
    await Promise.all(Array.from({ length: 4 }, () => c.send(0, rally(2))));
    expect(errors(c, 0)).toHaveLength(0);
    expect(await rallies(c, 0)).toHaveLength(8);
  });

  it('same rule on DynamoDB: concurrent rallies at one timestamp -> exactly one accepted, the rest RATE_LIMITED', async () => {
    const c = new Ctx();
    const ddb = new FakeDdb();
    const repo = new DynamoRepo(ddb as never, ddb.tableName, () => c.clock.now());
    c.repo = repo as never;
    c.notifier = new FakeNotifier(repo);
    c.svc = new GameService({ repo, notifier: c.notifier, scheduler: c.scheduler, clock: c.clock, maps: c.maps, startDelayMs: 1000 });
    await c.started(2, 1);
    await Promise.all(Array.from({ length: 12 }, () => c.send(0, rally(1))));
    expect(acks(c, 0)).toHaveLength(1);
    expect(errors(c, 0).map((e) => e.error)).toEqual(Array(11).fill('RATE_LIMITED'));
    expect(await c.budget(0)).toBe(c.cfg.budget - c.cfg.costs.rally);
    c.clock.advance(c.cfg.cooldowns.rallyMs);
    await c.send(0, rally(1));
    expect(acks(c, 0)).toHaveLength(2);
  });
});
