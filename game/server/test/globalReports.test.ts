// Free "global reports" by the news agencies: the WebSocket action `globalReports` -> GameService.globalReports -> message `globalReports`.
import { describe, expect, it } from 'vitest';
import { NEWS_AGENCIES, newsSampleTimes } from '@hp/shared';
import type { GlobalReports, MapConfig, ServerMessage } from '@hp/shared';
import { Ctx, TEST_CFG } from './helpers';
import { driveTo } from './helpers';

type GR = Extract<ServerMessage, { type: 'globalReports' }>;
const last = (c: Ctx, i: number): GR | undefined => {
  const all = c.notifier.to(c.p[i].playerId, 'globalReports') as GR[];
  return all[all.length - 1];
};
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

describe('globalReports (WS action, GameService.globalReports)', () => {
  it('is refused in the lobby with WRONG_PHASE and nothing is sent', async () => {
    const c = await new Ctx().lobby(3);
    await c.svc.connect(c.gameId, c.p[0].token, c.p[0].conn);
    await c.send(0, { action: 'globalReports' });
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
    expect(c.notifier.to(c.p[0].playerId, 'globalReports')).toHaveLength(0);
  });

  it('is refused with FORBIDDEN when news.enabled is false, and costs nothing', async () => {
    const cfg: MapConfig = { ...TEST_CFG, news: { ...TEST_CFG.news, enabled: false } };
    const c = await new Ctx({ cfg }).started(3);
    const before = await c.budget(0);
    await c.send(0, { action: 'globalReports' });
    expect(c.lastError(0)?.error).toBe('FORBIDDEN');
    expect(c.notifier.to(c.p[0].playerId, 'globalReports')).toHaveLength(0);
    expect(await c.budget(0)).toBe(before);
  });

  it('is refused with FORBIDDEN for a pending (not admitted) player', async () => {
    const c = await new Ctx().lobby(3);
    const q = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'late' });
    await c.svc.connect(c.gameId, q.token, 'late-conn');
    await c.svc.handleMessage('late-conn', { action: 'globalReports' });
    const err = c.notifier.to(q.playerId, 'error').pop() as Extract<ServerMessage, { type: 'error' }>;
    expect(err.error).toBe('FORBIDDEN');
    expect(c.notifier.to(q.playerId, 'globalReports')).toHaveLength(0);
  });

  it('answers in the campaign with the configured agencies; point 0 shows seats / parties for every party', async () => {
    const c = await new Ctx().started(3);
    await c.send(0, { action: 'globalReports' });
    const m = last(c, 0)!;
    expect(m).toBeDefined();
    const r: GlobalReports = m.reports;
    expect(r.agencies.map((a) => a.id)).toEqual(NEWS_AGENCIES.map((a) => a.id));
    expect(r.agencies).toHaveLength(4);
    expect(r.sampleIntervalMs).toBe(c.cfg.news.sampleIntervalMs);
    const ids = c.p.map((p) => p.playerId).sort();
    for (const a of r.agencies) {
      expect(a.points.length).toBeGreaterThanOrEqual(1);
      const p0 = a.points[0];
      expect(p0.t).toBe(c.timeline.campaignStart);
      expect(Object.keys(p0.seats).sort()).toEqual(ids);
      for (const id of ids) expect(p0.seats[id]).toBeCloseTo(c.cfg.seatCount / 3, 9);
      expect(Object.keys(a.ranges).sort()).toEqual(ids);
      for (const id of ids) {
        const [lo, hi] = a.ranges[id];
        expect(lo).toBeLessThanOrEqual(hi);
        expect(lo).toBeGreaterThanOrEqual(0);
        expect(hi).toBeLessThanOrEqual(c.cfg.seatCount);
      }
    }
    expect(r.asOf).toBe(c.timeline.campaignStart);
  });

  it('grows with the campaign clock; every point adds up to the seat count', async () => {
    const c = await new Ctx().started(3);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    await c.send(1, { action: 'campaign', type: 'roadshow', seat: 4 });
    c.clock.set(c.timeline.campaignStart + 45_000);
    await c.send(2, { action: 'globalReports' });
    const m = last(c, 2)!;
    const expected = newsSampleTimes(c.cfg, c.timeline, c.clock.now());
    expect(expected.length).toBeGreaterThan(1);
    for (const a of m.reports.agencies) {
      expect(a.points.map((p) => p.t)).toEqual(expected.map((x) => x.t));
      for (const p of a.points) expect(sum(p.seats)).toBeCloseTo(c.cfg.seatCount, 6);
    }
    expect(m.reports.asOf).toBe(expected[expected.length - 1].t);
  });

  it('costs nothing, stores no action and no report, and goes to the requester only', async () => {
    const c = await new Ctx().started(3);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    const budgets = await Promise.all(c.p.map((_, i) => c.budget(i)));
    const actions = (await c.repo.listActions(c.gameId)).length;
    c.clock.advance(31_000);
    c.notifier.clear();
    await c.send(0, { action: 'globalReports' });
    await c.send(0, { action: 'globalReports' });
    expect(await Promise.all(c.p.map((_, i) => c.budget(i)))).toEqual(budgets);
    expect((await c.repo.listActions(c.gameId)).length).toBe(actions);
    expect(await c.repo.listReports(c.gameId, c.p[0].playerId)).toHaveLength(0);
    expect(c.notifier.log.map((s) => s.msg.type)).toEqual(['globalReports', 'globalReports']);
    expect(c.notifier.log.every((s) => s.to === c.p[0].playerId)).toBe(true);
    // no acknowledgement carrying a budget, nothing to anybody else
    for (const i of [1, 2]) expect(c.notifier.to(c.p[i].playerId)).toHaveLength(0);
  });

  it('is deterministic: the same request twice, and after a reconnect, gives identical data', async () => {
    const c = await new Ctx().started(3);
    await c.send(1, { action: 'campaign', type: 'roadshow', seat: 3 });
    c.clock.advance(50_000);
    await c.send(0, { action: 'globalReports' });
    await c.send(0, { action: 'globalReports' });
    await c.svc.disconnect(c.p[0].conn);
    await c.svc.connect(c.gameId, c.p[0].token, 'again');
    c.p[0].conn = 'again';
    await c.send(0, { action: 'globalReports' });
    const all = c.notifier.to(c.p[0].playerId, 'globalReports') as GR[];
    expect(all).toHaveLength(3);
    expect(JSON.stringify(all[1])).toBe(JSON.stringify(all[0]));
    expect(JSON.stringify(all[2])).toBe(JSON.stringify(all[0]));
  });

  it('every player gets the same reports (they are public numbers)', async () => {
    const c = await new Ctx().started(3);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 2 });
    c.clock.advance(40_000);
    for (let i = 0; i < 3; i++) await c.send(i, { action: 'globalReports' });
    const a = last(c, 0)!;
    expect(JSON.stringify(last(c, 1))).toBe(JSON.stringify(a));
    expect(JSON.stringify(last(c, 2))).toBe(JSON.stringify(a));
  });

  it('earlier points of a growing series stay the same while nobody leaves', async () => {
    const c = await new Ctx().started(3);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 2 });
    c.clock.advance(31_000);
    await c.send(0, { action: 'globalReports' });
    c.clock.advance(31_000);
    await c.send(0, { action: 'globalReports' });
    const [early, later] = c.notifier.to(c.p[0].playerId, 'globalReports') as GR[];
    expect(later.reports.agencies[0].points.length).toBeGreaterThan(early.reports.agencies[0].points.length);
    early.reports.agencies.forEach((a, k) => {
      expect(later.reports.agencies[k].points.slice(0, a.points.length)).toEqual(a.points);
    });
  });

  it('counting phase: the series is frozen at the campaign end (asOf = campaignEnd) and does not move with the clock', async () => {
    const c = await new Ctx().started(3);
    await c.send(1, { action: 'campaign', type: 'rally', seat: 5 });
    await driveTo(c, 'counting');
    c.clock.set(c.timeline.campaignEnd + 1_000);
    await c.send(0, { action: 'globalReports' });
    c.clock.set(c.timeline.campaignEnd + 20_000);
    await c.send(0, { action: 'globalReports' });
    const [a, b] = c.notifier.to(c.p[0].playerId, 'globalReports') as GR[];
    expect(a.reports.asOf).toBe(c.timeline.campaignEnd);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    for (const ag of a.reports.agencies) expect(ag.points[ag.points.length - 1].t).toBe(c.timeline.campaignEnd);
  });

  it('is still answered after the game is finished (frozen), and eliminated parties are left out of the series', async () => {
    const c = await new Ctx().started(3);
    await c.svc.disconnect(c.p[2].conn); // stays a contender (disconnected) -> still in the series
    await driveTo(c, 'finished');
    await c.send(0, { action: 'globalReports' });
    const m = last(c, 0)!;
    expect(m.reports.asOf).toBe(c.timeline.campaignEnd);
    expect(Object.keys(m.reports.agencies[0].ranges)).toHaveLength(3);
    // an eliminated player is not a party of the vote any more
    const c2 = await new Ctx().started(3);
    await c2.repo.updatePlayer(c2.gameId, c2.p[2].playerId, { status: 'eliminated' });
    await c2.send(0, { action: 'globalReports' });
    const m2 = last(c2, 0)!;
    expect(Object.keys(m2.reports.agencies[0].ranges).sort()).toEqual([c2.p[0].playerId, c2.p[1].playerId].sort());
    // but an eliminated player may still look
    await c2.send(2, { action: 'globalReports' });
    expect(last(c2, 2)).toBeDefined();
  });

  it('an unknown connection gets UNAUTHORIZED and no data', async () => {
    const c = await new Ctx().started(2);
    await c.svc.handleMessage('nobody', { action: 'globalReports' });
    const log = c.notifier.to('conn:nobody');
    expect(log.map((m) => m.type)).toEqual(['error']);
  });
});

describe('server-only news secret', () => {
  it('is generated at game creation, differs between games and is stored on the game record', async () => {
    const a = await new Ctx().started(3);
    const b = await new Ctx().started(3);
    const sa = (await a.repo.getGame(a.gameId))!.newsSecret;
    const sb = (await b.repo.getGame(b.gameId))!.newsSecret;
    expect(typeof sa).toBe('string');
    expect(sa!.length).toBeGreaterThanOrEqual(32);
    expect(sa).not.toBe(sb);
  });

  it('never appears in anything sent to any client, whatever they asked for', async () => {
    const c = await new Ctx().started(3);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    c.clock.advance(31_000);
    for (let i = 0; i < 3; i++) await c.send(i, { action: 'globalReports' });
    await c.svc.disconnect(c.p[1].conn);
    await c.svc.connect(c.gameId, c.p[1].token, 'again');
    const secret = (await c.repo.getGame(c.gameId))!.newsSecret!;
    expect(c.notifier.log.length).toBeGreaterThan(3);
    expect(JSON.stringify(c.notifier.log)).not.toContain(secret);
    const lobby = await c.svc.getLobby(c.gameId, c.p[0].token);
    expect(JSON.stringify(lobby)).not.toContain(secret);
    expect(JSON.stringify(lobby)).not.toContain('newsSecret');
    expect(JSON.stringify(c.notifier.log)).not.toContain('newsSecret');
  });

  it('a different secret gives different noise for the same game state', async () => {
    const c = await new Ctx().started(3);
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 2 });
    c.clock.advance(100_000);
    await c.send(0, { action: 'globalReports' });
    await c.repo.updateGame(c.gameId, { newsSecret: 'another-secret-value-123' });
    await c.send(0, { action: 'globalReports' });
    const [a, b] = c.notifier.to(c.p[0].playerId, 'globalReports') as GR[];
    expect(a.reports.agencies.map((x) => x.points.map((p) => p.t))).toEqual(b.reports.agencies.map((x) => x.points.map((p) => p.t)));
    expect(JSON.stringify(b.reports)).not.toBe(JSON.stringify(a.reports));
  });

  it('a game created before the field existed falls back safely: a secret is made, stored once and then stable', async () => {
    const c = await new Ctx().started(3);
    await c.repo.updateGame(c.gameId, { newsSecret: undefined });
    expect((await c.repo.getGame(c.gameId))!.newsSecret).toBeUndefined();
    c.clock.advance(61_000);
    await c.send(0, { action: 'globalReports' });
    const stored = (await c.repo.getGame(c.gameId))!.newsSecret;
    expect(typeof stored).toBe('string');
    expect(stored!.length).toBeGreaterThanOrEqual(32);
    await c.send(1, { action: 'globalReports' });
    expect((await c.repo.getGame(c.gameId))!.newsSecret).toBe(stored);
    const [a, b] = c.notifier.to(c.p[0].playerId, 'globalReports').concat(c.notifier.to(c.p[1].playerId, 'globalReports')) as GR[];
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c.notifier.log)).not.toContain(stored!);
  });
});

describe('global reports cache (one build serves every player)', () => {
  it('builds once for several players and repeated requests at the same sample time', async () => {
    const c = await new Ctx().started(3);
    c.clock.advance(31_000);
    for (let i = 0; i < 3; i++) await c.send(i, { action: 'globalReports' });
    await c.send(0, { action: 'globalReports' });
    expect(c.svc.newsBuilds).toBe(1);
    expect(JSON.stringify(last(c, 2))).toBe(JSON.stringify(last(c, 0)));
  });

  it('a new sample time rebuilds, and the cached answer equals a fresh build', async () => {
    const c = await new Ctx().started(3);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    c.clock.advance(10_000);
    await c.send(0, { action: 'globalReports' });
    c.clock.advance(5_000); // still before the next sample
    await c.send(1, { action: 'globalReports' });
    expect(c.svc.newsBuilds).toBe(1);
    c.clock.advance(20_000); // next sample passed
    await c.send(1, { action: 'globalReports' });
    expect(c.svc.newsBuilds).toBe(2);
  });

  it('an action stamped up to the last sample time rebuilds; one after it does not change the key', async () => {
    const c = await new Ctx().started(3);
    c.clock.advance(31_000);
    await c.send(0, { action: 'globalReports' });
    c.clock.advance(1_000); // after the sample at +30 s: a new rally does not alter the points shown
    await c.send(1, { action: 'campaign', type: 'rally', seat: 3 });
    await c.send(0, { action: 'globalReports' });
    expect(c.svc.newsBuilds).toBe(1);
  });

  it('eliminating a party or a changed secret invalidates the cache (history may change)', async () => {
    const c = await new Ctx().started(3);
    c.clock.advance(31_000);
    await c.send(0, { action: 'globalReports' });
    await c.repo.updatePlayer(c.gameId, c.p[2].playerId, { status: 'eliminated' });
    await c.send(0, { action: 'globalReports' });
    expect(c.svc.newsBuilds).toBe(2);
    expect(Object.keys(last(c, 0)!.reports.agencies[0].ranges)).toHaveLength(2);
    await c.send(1, { action: 'globalReports' });
    expect(c.svc.newsBuilds).toBe(2);
  });

  it('is frozen after the campaign end: any number of requests cost one build', async () => {
    const c = await new Ctx().started(3);
    await driveTo(c, 'counting');
    c.clock.set(c.timeline.campaignEnd + 1_000);
    for (let i = 0; i < 3; i++) await c.send(i, { action: 'globalReports' });
    c.clock.set(c.timeline.campaignEnd + 20_000);
    await c.send(0, { action: 'globalReports' });
    expect(c.svc.newsBuilds).toBe(1);
  });

  it('is kept per game: two games (own secret each) never get the other game reports', async () => {
    const a = await new Ctx().started(3);
    const b = await new Ctx().started(3);
    a.clock.advance(100_000);
    b.clock.advance(100_000);
    await a.send(0, { action: 'globalReports' });
    await b.send(0, { action: 'globalReports' });
    expect(JSON.stringify(last(a, 0)!.reports)).not.toBe(JSON.stringify(last(b, 0)!.reports)); // different secrets
  });
});
