// Local-server adapters (env overrides, WebSocket notifier, timer scheduler) and core/util helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORLD_CONFIG } from '@hp/shared';
import { MAP_MANIFESTS } from '@hp/shared';
import { applyEnvOverrides, loadLocalMaps, startDelayFromEnv } from '../src/local/localEnv';
import { LocalNotifier } from '../src/local/localNotifier';
import { MemoryRepo } from '../src/local/memoryRepo';
import { TimerScheduler } from '../src/local/timerScheduler';
import { GameError } from '../src/core/types';
import { cleanText, hashToken, newId, newJoinCode, newToken, uniq } from '../src/core/util';
import type { GameService } from '../src/core/gameService';
import type { GameTimeline } from '@hp/shared';
import { Ctx } from './helpers';

describe('applyEnvOverrides / startDelayFromEnv', () => {
  const d = WORLD_CONFIG.durations;
  it('no env: unchanged durations', () => {
    expect(applyEnvOverrides(WORLD_CONFIG, {}).durations).toEqual(d);
  });
  it('overrides each duration independently', () => {
    expect(applyEnvOverrides(WORLD_CONFIG, { HP_CAMPAIGN_MS: '1000' }).durations).toEqual({ ...d, campaignMs: 1000 });
    expect(applyEnvOverrides(WORLD_CONFIG, { HP_COUNTING_MS: '2000' }).durations).toEqual({ ...d, countingMs: 2000 });
    expect(applyEnvOverrides(WORLD_CONFIG, { HP_POST_MS: '3000' }).durations).toEqual({ ...d, postCountingMs: 3000 });
    expect(applyEnvOverrides(WORLD_CONFIG, { HP_GRACE_MS: '4000' }).durations).toEqual({ ...d, graceMs: 4000 });
  });
  it.each([[''], ['abc'], ['-5'], ['NaN'], ['Infinity'], [' ']])('ignores the invalid value %j', (v) => {
    expect(applyEnvOverrides(WORLD_CONFIG, { HP_CAMPAIGN_MS: v }).durations.campaignMs).toBe(d.campaignMs);
  });
  it('0 is accepted (instant phases for tests); decimals too', () => {
    expect(applyEnvOverrides(WORLD_CONFIG, { HP_GRACE_MS: '0' }).durations.graceMs).toBe(0);
    expect(applyEnvOverrides(WORLD_CONFIG, { HP_GRACE_MS: '1500.5' }).durations.graceMs).toBe(1500.5);
  });
  it('never mutates the input config and keeps everything else', () => {
    const copy = JSON.stringify(WORLD_CONFIG);
    const out = applyEnvOverrides(WORLD_CONFIG, { HP_CAMPAIGN_MS: '1' });
    expect(JSON.stringify(WORLD_CONFIG)).toBe(copy);
    expect({ ...out, durations: undefined }).toEqual({ ...WORLD_CONFIG, durations: undefined });
  });
  it('startDelayFromEnv: default 5000, override, invalid ignored', () => {
    expect(startDelayFromEnv({})).toBe(5000);
    expect(startDelayFromEnv({ HP_START_DELAY_MS: '1200' })).toBe(1200);
    expect(startDelayFromEnv({ HP_START_DELAY_MS: 'soon' })).toBe(5000);
    expect(startDelayFromEnv({ HP_START_DELAY_MS: '0' })).toBe(0);
  });
  it('loadLocalMaps applies the overrides to every registered map', () => {
    const maps = loadLocalMaps({ HP_CAMPAIGN_MS: '777' });
    for (const m of MAP_MANIFESTS) expect(maps(m.id)!.cfg.durations.campaignMs).toBe(777);
  });
});

// ------------------------------------------------------------------ LocalNotifier
function fakeSocket(open = true) {
  return { OPEN: 1, readyState: open ? 1 : 3, sent: [] as string[], closed: undefined as undefined | [number, string], send(s: string) { this.sent.push(s); }, close(code: number, reason: string) { this.closed = [code, reason]; } };
}

describe('LocalNotifier', () => {
  async function setup() {
    const c = await new Ctx().started(3, 1);
    const n = new LocalNotifier(c.repo);
    const socks = c.p.map(() => fakeSocket());
    c.p.forEach((p, i) => n.sockets.set(p.conn, socks[i] as never));
    return { c, n, socks };
  }
  const msg = { type: 'pong', clientTime: 1, serverTime: 2 } as const;

  it('sendToConnection: JSON per message, in order; unknown or closed sockets are ignored', async () => {
    const { n, c, socks } = await setup();
    await n.sendToConnection(c.p[0].conn, [msg, { ...msg, clientTime: 2 }]);
    expect(socks[0].sent.map((s) => JSON.parse(s).clientTime)).toEqual([1, 2]);
    await n.sendToConnection('nobody', msg);
    socks[1].readyState = 3;
    await n.sendToConnection(c.p[1].conn, msg);
    expect(socks[1].sent).toEqual([]);
  });

  it('sendToPlayer: via the player\'s connection id; players without a connection get nothing', async () => {
    const { n, c, socks } = await setup();
    await n.sendToPlayer(c.gameId, c.p[2].playerId, msg);
    expect(socks[2].sent).toHaveLength(1);
    expect(socks[0].sent).toHaveLength(0);
    await c.repo.updatePlayer(c.gameId, c.p[2].playerId, { connectionId: undefined });
    await n.sendToPlayer(c.gameId, c.p[2].playerId, msg);
    await n.sendToPlayer(c.gameId, 'ghost', msg);
    expect(socks[2].sent).toHaveLength(1);
  });

  it('broadcast: every connected player once, never a rejected one', async () => {
    const { n, c, socks } = await setup();
    await c.repo.updatePlayer(c.gameId, c.p[1].playerId, { status: 'rejected' });
    await n.broadcast(c.gameId, [msg, msg]);
    expect(socks.map((s) => s.sent.length)).toEqual([2, 0, 2]);
  });

  it('closeConnection closes with 1008 "rejected"; unknown ids are fine', async () => {
    const { n, c, socks } = await setup();
    await n.closeConnection(c.p[0].conn);
    await n.closeConnection('nobody');
    expect(socks[0].closed).toEqual([1008, 'rejected']);
    expect(socks[1].closed).toBeUndefined();
  });
});

// ------------------------------------------------------------------ TimerScheduler
describe('TimerScheduler (fake timers)', () => {
  const T0 = 1_000_000;
  const timeline: GameTimeline = { campaignStart: T0 + 100, phaseCloses: [T0 + 1000, T0 + 2000], campaignEnd: T0 + 2000, countingEnd: T0 + 3000, postCountingEnd: T0 + 4000 };
  let now = T0;
  const clock = { now: () => now };
  const stub = () => {
    const calls: string[] = [];
    const svc = {
      phaseClose: vi.fn(async (_g: string, p: number) => { calls.push(`phase${p}@${Date.now()}`); }),
      countReveal: vi.fn(async () => { calls.push(`reveal@${Date.now()}`); const done = Date.now() >= T0 + 3000; return { done, nextAtMs: done ? Date.now() : Date.now() + 500 }; }),
      finalise: vi.fn(async (_g: string, opts?: { error?: boolean }) => { calls.push(`finalise${opts?.error ? '(error)' : ''}@${Date.now()}`); }),
      graceCheck: vi.fn(async (_g: string, p: string) => { calls.push(`grace-${p}@${Date.now()}`); }),
    };
    return { svc, calls };
  };
  beforeEach(() => { vi.useFakeTimers(); now = T0; vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });
  const advance = async (ms: number) => { now += ms; await vi.advanceTimersByTimeAsync(ms); };

  it('runs phase closes, then the counting loop, then finalises at postCountingEnd - in that order and at those times', async () => {
    const { svc, calls } = stub();
    const s = new TimerScheduler({ now: () => Date.now() });
    s.bind(svc as unknown as GameService);
    await s.startLifecycle('g', timeline);
    await vi.advanceTimersByTimeAsync(1000);
    expect(svc.phaseClose).toHaveBeenCalledTimes(1);
    expect(svc.phaseClose).toHaveBeenLastCalledWith('g', 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(svc.phaseClose).toHaveBeenCalledTimes(2);
    expect(svc.phaseClose).toHaveBeenLastCalledWith('g', 1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(svc.countReveal.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(svc.finalise).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(svc.finalise).toHaveBeenCalledTimes(1);
    expect(svc.finalise).toHaveBeenCalledWith('g');
    expect(calls.indexOf(calls.find((c) => c.startsWith('phase1'))!)).toBeLessThan(calls.findIndex((c) => c.startsWith('reveal')));
    s.stop();
  });

  it('stop() prevents everything that has not run yet', async () => {
    const { svc } = stub();
    const s = new TimerScheduler({ now: () => Date.now() });
    s.bind(svc as unknown as GameService);
    await s.startLifecycle('g', timeline);
    await s.scheduleGraceCheck('g', 'p', T0 + 500);
    s.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(svc.phaseClose).not.toHaveBeenCalled();
    expect(svc.graceCheck).not.toHaveBeenCalled();
    expect(svc.finalise).not.toHaveBeenCalled();
  });

  it('a failing step finalises with error:true instead of leaving the game hanging', async () => {
    const { svc } = stub();
    svc.phaseClose.mockRejectedValueOnce(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = new TimerScheduler({ now: () => Date.now() });
    s.bind(svc as unknown as GameService);
    await s.startLifecycle('g', timeline);
    await vi.advanceTimersByTimeAsync(1100);
    expect(svc.finalise).toHaveBeenCalledWith('g', { error: true });
    spy.mockRestore();
    s.stop();
  });

  it('grace checks fire at the requested time, have unique names, and can be cancelled', async () => {
    const { svc } = stub();
    const s = new TimerScheduler({ now: () => Date.now() });
    s.bind(svc as unknown as GameService);
    const a = await s.scheduleGraceCheck('g', 'p1', T0 + 300);
    const b = await s.scheduleGraceCheck('g', 'p1', T0 + 300);
    const c = await s.scheduleGraceCheck('g', 'p2', T0 + 300);
    expect(new Set([a, b, c]).size).toBe(3);
    await s.cancelGraceCheck(b);
    await s.cancelGraceCheck('does-not-exist');
    await advance(299);
    expect(svc.graceCheck).not.toHaveBeenCalled();
    await advance(2);
    expect(svc.graceCheck.mock.calls.map((x) => x[1]).sort()).toEqual(['p1', 'p2']);
    s.stop();
  });

  it('a grace time in the past fires immediately', async () => {
    const { svc } = stub();
    const s = new TimerScheduler({ now: () => Date.now() });
    s.bind(svc as unknown as GameService);
    await s.scheduleGraceCheck('g', 'p', T0 - 5000);
    await advance(1);
    expect(svc.graceCheck).toHaveBeenCalledTimes(1);
    s.stop();
  });
});

// ------------------------------------------------------------------ util
describe('cleanText', () => {
  const ok = (v: unknown, min = 1, max = 10) => cleanText(v, min, max, 'Thing');
  it('trims, collapses whitespace and turns control characters into spaces', () => {
    expect(ok('  a   b  ')).toBe('a b');
    expect(ok('a\tb\nc')).toBe('a b c');
    expect(ok('a\u0000b\u001fc\u007fd')).toBe('a b c d');
  });
  it('keeps non-ASCII text (names in any script, emoji)', () => {
    expect(ok('नमस्ते')).toBe('नमस्ते');
    expect(ok('Zoë 🌍', 1, 10)).toBe('Zoë 🌍');
  });
  it('length bounds are inclusive and measured after cleaning', () => {
    expect(ok('abc', 3, 3)).toBe('abc');
    expect(() => ok('ab', 3, 3)).toThrow(GameError);
    expect(() => ok('abcd', 3, 3)).toThrow(GameError);
    expect(ok('  a  ', 1, 1)).toBe('a');
    expect(() => ok('\u0000\u0001', 1, 5)).toThrow(GameError);
  });
  it.each([[undefined], [null], [5], [{}], [[]], [true]])('non-text %j -> BAD_REQUEST mentioning the field', (v) => {
    try { ok(v); expect.unreachable(); } catch (e) { expect(e).toBeInstanceOf(GameError); expect((e as GameError).code).toBe('BAD_REQUEST'); expect((e as GameError).message).toContain('Thing'); }
  });
});

describe('ids, tokens, join codes', () => {
  it('newToken: URL-safe, long, unique', () => {
    const t = Array.from({ length: 200 }, newToken);
    expect(new Set(t).size).toBe(200);
    for (const x of t) expect(x).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('hashToken is deterministic, hex, different per token and never the token itself', () => {
    expect(hashToken('a')).toBe(hashToken('a'));
    expect(hashToken('a')).not.toBe(hashToken('b'));
    expect(hashToken('a')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('newJoinCode: requested length, unambiguous alphabet (no 0 O 1 I L)', () => {
    for (let i = 0; i < 300; i++) expect(newJoinCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(newJoinCode(10)).toHaveLength(10);
  });
  it('join codes are well spread (no obvious bias)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(newJoinCode());
    expect(seen.size).toBeGreaterThan(1990);
  });
  it('newId: length depends on the random bytes, sortable prefix', () => {
    expect(newId(3)).toHaveLength(9 + 4 + 6);
    expect(newId(5)).toHaveLength(9 + 4 + 10);
    const ids = Array.from({ length: 500 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
  });
  it('uniq keeps first occurrences in order', () => {
    expect(uniq([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
    expect(uniq([])).toEqual([]);
  });
});

describe('MemoryRepo semantics the service relies on', () => {
  it('returns copies: mutating a returned record does not change the store', async () => {
    const c = await new Ctx().started(2, 1);
    const p = (await c.repo.getPlayer(c.gameId, c.p[0].playerId))!;
    p.budget = -1;
    expect((await c.repo.getPlayer(c.gameId, c.p[0].playerId))!.budget).toBe(c.cfg.budget);
    const g = (await c.repo.getGame(c.gameId))!;
    g.status = 'finished';
    expect((await c.repo.getGame(c.gameId))!.status).toBe('campaign');
  });
  it('updateGame with a condition only applies when the condition matches; undefined removes an attribute', async () => {
    const c = await new Ctx().lobby(2);
    expect(await c.repo.updateGame(c.gameId, { phases: 5 }, { status: 'campaign' })).toBe(false);
    expect((await c.game()).phases).toBe(3);
    expect(await c.repo.updateGame(c.gameId, { finalised: true })).toBe(true);
    expect(await c.repo.updateGame(c.gameId, { finalised: undefined })).toBe(true);
    expect('finalised' in (await c.game())).toBe(false);
    expect(await c.repo.updateGame('nope', { phases: 1 })).toBe(false);
  });
});
