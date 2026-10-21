import { describe, expect, it, vi } from 'vitest';
import { DeleteConnectionCommand, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { GameTimeline, ServerMessage } from '@hp/shared';
import { ApiGwNotifier } from '../src/aws/apiGwNotifier';
import { DynamoRepo } from '../src/aws/dynamoRepo';
import { SfnScheduler, atExpression } from '../src/aws/sfnScheduler';
import type { GameRecord, PlayerRecord } from '../src/core/types';
import { FakeDdb } from './fakes/fakeDdb';

/* eslint-disable @typescript-eslint/no-explicit-any */
const named = (name: string, status?: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
const pong = (n: number): ServerMessage => ({ type: 'pong', clientTime: n, serverTime: n });
const GAME: GameRecord = {
  gameId: 'g1', joinCode: 'X', mapId: 'm', phases: 1, status: 'lobby', admissionOpen: true, adminId: 'a', createdAt: 1,
  timeline: null, closedPhases: 0, revealedStep: 0,
};
const pl = (id: string, over: Partial<PlayerRecord> = {}): PlayerRecord => ({
  gameId: 'g1', playerId: id, nickname: id, tokenHash: 'h', isAdmin: false, status: 'active', budget: 1, joinedAt: 1, ...over,
});

function setupNotifier(send?: (cmd: unknown) => unknown) {
  const ddb = new FakeDdb();
  const repo = new DynamoRepo(ddb as never, ddb.tableName);
  const sent: { cmd: unknown }[] = [];
  const client = { send: vi.fn(async (cmd: unknown) => { sent.push({ cmd }); return send ? send(cmd) : {}; }) };
  return { ddb, repo, client, sent, notifier: new ApiGwNotifier(client as never, repo) };
}
const posts = (sent: { cmd: unknown }[]) => sent.filter((s) => s.cmd instanceof PostToConnectionCommand)
  .map((s) => {
    const i = (s.cmd as PostToConnectionCommand).input;
    return { id: i.ConnectionId, data: JSON.parse(Buffer.from(i.Data as Uint8Array).toString()) };
  });

describe('ApiGwNotifier', () => {
  it('sendToConnection posts JSON payloads in order, one PostToConnection per message', async () => {
    const t = setupNotifier();
    await t.notifier.sendToConnection('c1', [pong(1), pong(2)]);
    await t.notifier.sendToConnection('c2', pong(3));
    expect(posts(t.sent)).toEqual([{ id: 'c1', data: pong(1) }, { id: 'c1', data: pong(2) }, { id: 'c2', data: pong(3) }]);
  });

  it('payload is bytes containing UTF-8 JSON (non-ASCII survives)', async () => {
    const t = setupNotifier();
    const msg: ServerMessage = { type: 'error', error: 'BAD_REQUEST', message: 'नमस्ते ✓' };
    await t.notifier.sendToConnection('c1', msg);
    const data = (t.sent[0].cmd as PostToConnectionCommand).input.Data;
    expect(data).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(data as Uint8Array))).toEqual(msg);
  });

  it('GoneException removes the connection record and stops sending further messages to it', async () => {
    const t = setupNotifier(() => { throw named('GoneException', 410); });
    await t.repo.putConnection({ connectionId: 'dead', gameId: 'g1', playerId: 'p1' });
    await t.notifier.sendToConnection('dead', [pong(1), pong(2), pong(3)]);
    expect(posts(t.sent)).toHaveLength(1);
    expect(await t.repo.getConnection('dead')).toBeNull();
  });

  it('a bare 410 status (no error name) is treated as gone too', async () => {
    const t = setupNotifier(() => { throw Object.assign(new Error('x'), { $metadata: { httpStatusCode: 410 } }); });
    await t.repo.putConnection({ connectionId: 'dead', gameId: 'g1', playerId: 'p1' });
    await t.notifier.sendToConnection('dead', pong(1));
    expect(await t.repo.getConnection('dead')).toBeNull();
  });

  it('other (non-throttle) errors are logged and swallowed; the connection record is kept', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = setupNotifier(() => { throw named('InternalFailure', 500); });
    await t.repo.putConnection({ connectionId: 'c', gameId: 'g1', playerId: 'p1' });
    await expect(t.notifier.sendToConnection('c', [pong(1), pong(2)])).resolves.toBeUndefined();
    expect(posts(t.sent)).toHaveLength(1);
    expect(await t.repo.getConnection('c')).not.toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  describe('throttling (API Gateway answers 429 "Too Many Requests" when many seat updates are pushed at once)', () => {
    const throttled = () => named('TooManyRequestsException', 429);
    const noSleep = async () => undefined;
    const withRetry = (send: (cmd: unknown) => unknown) => {
      const ddb = new FakeDdb();
      const repo = new DynamoRepo(ddb as never, ddb.tableName);
      const sent: { cmd: unknown }[] = [];
      const client = { send: vi.fn(async (cmd: unknown) => { sent.push({ cmd }); return send(cmd); }) };
      return { sent, notifier: new ApiGwNotifier(client as never, repo, noSleep) };
    };

    it('retries a throttled post and still delivers every message, in order', async () => {
      let n = 0;
      const t = withRetry(() => { if (++n % 3 === 1) throw throttled(); return {}; }); // every 3rd call attempt is throttled once
      await t.notifier.sendToConnection('c', [pong(1), pong(2), pong(3), pong(4)]);
      const delivered: number[] = [];
      // a post "succeeds" when it is not the throttled attempt: replay the sequence
      let k = 0;
      for (const p of posts(t.sent)) { if (++k % 3 !== 1) delivered.push(p.data.clientTime); }
      expect(delivered).toEqual([1, 2, 3, 4]);
    });

    it('a message that stays throttled is skipped but does NOT drop the rest of the batch', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const t = withRetry((cmd) => {
        const d = JSON.parse(Buffer.from((cmd as PostToConnectionCommand).input.Data as Uint8Array).toString());
        if (d.clientTime === 2) throw throttled();
        return {};
      });
      await t.notifier.sendToConnection('c', [pong(1), pong(2), pong(3)]);
      const ids = posts(t.sent).map((p) => p.data.clientTime);
      expect(ids).toContain(3);                 // the message after the failing one was still sent
      expect(ids.filter((x) => x === 2).length).toBeGreaterThan(1); // and the failing one was retried
      spy.mockRestore();
    });
  });

  it('a failure removing a gone connection does not propagate', async () => {
    const t = setupNotifier(() => { throw named('GoneException', 410); });
    vi.spyOn(t.repo, 'deleteConnection').mockRejectedValue(new Error('ddb down'));
    await expect(t.notifier.sendToConnection('dead', pong(1))).resolves.toBeUndefined();
  });

  it('sendToPlayer looks up the connection id; nothing is sent for players without a connection', async () => {
    const t = setupNotifier();
    await t.repo.createGame(GAME, pl('a', { connectionId: 'ca' }));
    await t.repo.putPlayer(pl('b'));
    await t.notifier.sendToPlayer('g1', 'a', pong(1));
    await t.notifier.sendToPlayer('g1', 'b', pong(2));
    await t.notifier.sendToPlayer('g1', 'nobody', pong(3));
    expect(posts(t.sent)).toEqual([{ id: 'ca', data: pong(1) }]);
  });

  it('broadcast reaches every connected player except pending/rejected ones (no hidden-info leak to unadmitted players) once and tolerates gone sockets', async () => {
    const t = setupNotifier((cmd) => {
      if ((cmd as PostToConnectionCommand).input.ConnectionId === 'cb') throw named('GoneException', 410);
      return {};
    });
    await t.repo.createGame(GAME, pl('a', { connectionId: 'ca' }));
    await t.repo.putPlayer(pl('b', { connectionId: 'cb' }));
    await t.repo.putPlayer(pl('c', { connectionId: 'cc', status: 'rejected' }));
    await t.repo.putPlayer(pl('d'));
    await t.repo.putPlayer(pl('f', { connectionId: 'cf', status: 'pending' }));
    await t.repo.putPlayer(pl('e', { connectionId: 'ce', status: 'disconnected' }));
    await t.repo.putConnection({ connectionId: 'cb', gameId: 'g1', playerId: 'b' });
    await t.notifier.broadcast('g1', [pong(1), pong(2)]);
    expect(posts(t.sent).map((p) => p.id).sort()).toEqual(['ca', 'ca', 'cb', 'ce', 'ce']);
    expect(await t.repo.getConnection('cb')).toBeNull();
  });

  it('closeConnection issues DeleteConnection and tolerates GoneException only', async () => {
    const t = setupNotifier();
    await t.notifier.closeConnection('c9');
    const cmd = t.sent[0].cmd as DeleteConnectionCommand;
    expect(cmd).toBeInstanceOf(DeleteConnectionCommand);
    expect(cmd.input).toEqual({ ConnectionId: 'c9' });
    const gone = setupNotifier(() => { throw named('GoneException', 410); });
    await expect(gone.notifier.closeConnection('c9')).resolves.toBeUndefined();
    const bad = setupNotifier(() => { throw named('AccessDeniedException', 403); });
    await expect(bad.notifier.closeConnection('c9')).rejects.toMatchObject({ name: 'AccessDeniedException' });
  });
});

// ---------------------------------------------------------------------------------------------------------
const CFG = {
  stateMachineArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:hp-dev-lifecycle',
  schedulerRoleArn: 'arn:aws:iam::123456789012:role/hp-dev-scheduler',
  graceCheckArn: 'arn:aws:lambda:ap-south-1:123456789012:function:hp-dev-grace-check',
  scheduleGroup: 'hp-dev-grace',
};
const TL: GameTimeline = {
  campaignStart: Date.UTC(2026, 9, 20, 9, 0, 0),
  phaseCloses: [Date.UTC(2026, 9, 20, 10, 0, 0), Date.UTC(2026, 9, 20, 11, 30, 15, 250)],
  campaignEnd: Date.UTC(2026, 9, 20, 11, 30, 15, 250),
  countingEnd: Date.UTC(2026, 9, 20, 12, 0, 0),
  postCountingEnd: Date.UTC(2026, 9, 20, 12, 30, 0),
};
function setupSched(sfnSend?: (c: unknown) => unknown, schSend?: (c: unknown) => unknown) {
  const sfn = { send: vi.fn(async (c: unknown) => (sfnSend ? sfnSend(c) : {})) };
  const sch = { send: vi.fn(async (c: unknown) => (schSend ? schSend(c) : {})) };
  return { sfn, sch, s: new SfnScheduler(sfn as never, sch as never, CFG) };
}

describe('SfnScheduler', () => {
  it('atExpression: UTC at(yyyy-mm-ddThh:mm:ss), no millis/Z', () => {
    expect(atExpression(Date.UTC(2026, 0, 2, 3, 4, 5, 999))).toBe('at(2026-01-02T03:04:05)');
    expect(atExpression(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('at(2026-12-31T23:59:59)');
  });

  it('startLifecycle: StartExecution with the exact state-machine input shape', async () => {
    const t = setupSched();
    await t.s.startLifecycle('g_abc', TL);
    const cmd = t.sfn.send.mock.calls[0][0] as StartExecutionCommand;
    expect(cmd).toBeInstanceOf(StartExecutionCommand);
    expect(cmd.input.stateMachineArn).toBe(CFG.stateMachineArn);
    expect(cmd.input.name).toBe('game-g_abc');
    const input = JSON.parse(cmd.input.input as string);
    expect(input).toEqual({
      gameId: 'g_abc',
      timeline: TL,
      phaseClosesIso: ['2026-10-20T10:00:00.000Z', '2026-10-20T11:30:15.250Z'],
      countingEndIso: '2026-10-20T12:00:00.000Z',
      postCountingEndIso: '2026-10-20T12:30:00.000Z',
    });
    expect(Object.keys(input).sort()).toEqual(['countingEndIso', 'gameId', 'phaseClosesIso', 'postCountingEndIso', 'timeline']);
    expect(input.phaseClosesIso).toHaveLength(input.timeline.phaseCloses.length);
  });

  it('startLifecycle: execution name satisfies the Step Functions naming rules', async () => {
    const t = setupSched();
    await t.s.startLifecycle('0123456789', TL);
    expect((t.sfn.send.mock.calls[0][0] as StartExecutionCommand).input.name).toMatch(/^[0-9A-Za-z_-]{1,80}$/);
  });

  it('startLifecycle is idempotent on ExecutionAlreadyExists but rethrows other errors', async () => {
    await expect(setupSched(() => { throw named('ExecutionAlreadyExists'); }).s.startLifecycle('g', TL)).resolves.toBeUndefined();
    await expect(setupSched(() => { throw named('AccessDeniedException'); }).s.startLifecycle('g', TL)).rejects.toMatchObject({ name: 'AccessDeniedException' });
  });

  it('scheduleGraceCheck: one-time schedule in the right group with the right target/role and auto-delete', async () => {
    const t = setupSched();
    const name = await t.s.scheduleGraceCheck('g1', 'p1', Date.UTC(2026, 9, 20, 10, 5, 7, 900));
    const cmd = t.sch.send.mock.calls[0][0] as CreateScheduleCommand;
    expect(cmd).toBeInstanceOf(CreateScheduleCommand);
    const i = cmd.input;
    expect(i.Name).toBe(name);
    expect(i.GroupName).toBe(CFG.scheduleGroup);
    expect(i.ScheduleExpression).toBe('at(2026-10-20T10:05:07)');
    expect(i.ScheduleExpressionTimezone).toBe('UTC');
    expect(i.FlexibleTimeWindow).toEqual({ Mode: 'OFF' });
    expect(i.ActionAfterCompletion).toBe('DELETE');
    expect(i.Target?.Arn).toBe(CFG.graceCheckArn);
    expect(i.Target?.RoleArn).toBe(CFG.schedulerRoleArn);
    expect(JSON.parse(i.Target?.Input as string)).toEqual({ gameId: 'g1', playerId: 'p1' });
    expect(name).toMatch(/^[0-9A-Za-z._-]{1,64}$/);
  });

  it('scheduleGraceCheck: names are unique per (game, player, time) and capped at 64 chars', async () => {
    const t = setupSched();
    const a = await t.s.scheduleGraceCheck('g1', 'p1', 1_800_000_000_000);
    const b = await t.s.scheduleGraceCheck('g1', 'p1', 1_800_000_005_000);
    const c = await t.s.scheduleGraceCheck('g1', 'p2', 1_800_000_000_000);
    expect(new Set([a, b, c]).size).toBe(3);
    expect((await t.s.scheduleGraceCheck('g'.repeat(40), 'p'.repeat(40), 1_800_000_000_000)).length).toBeLessThanOrEqual(64);
  });

  it('scheduleGraceCheck: a retried create (ConflictException, same name) is not an error', async () => {
    const t = setupSched(undefined, () => { throw named('ConflictException', 409); });
    await expect(t.s.scheduleGraceCheck('g1', 'p1', 1_800_000_000_000)).resolves.toMatch(/^grace-g1-p1-/);
  });

  it('cancelGraceCheck: DeleteSchedule by name+group, tolerates ResourceNotFound only', async () => {
    const t = setupSched();
    await t.s.cancelGraceCheck('grace-x');
    const cmd = t.sch.send.mock.calls[0][0] as DeleteScheduleCommand;
    expect(cmd).toBeInstanceOf(DeleteScheduleCommand);
    expect(cmd.input).toEqual({ Name: 'grace-x', GroupName: CFG.scheduleGroup });
    await expect(setupSched(undefined, () => { throw named('ResourceNotFoundException', 404); }).s.cancelGraceCheck('x')).resolves.toBeUndefined();
    await expect(setupSched(undefined, () => { throw named('ThrottlingException', 429); }).s.cancelGraceCheck('x')).rejects.toMatchObject({ name: 'ThrottlingException' });
  });
});
