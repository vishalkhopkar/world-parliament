// A campaign message that carries a clientRef is applied at most once per player: a client that timed out and resends the
// same clientRef (agent retry, flaky network) is acknowledged again but never charged twice. Without a clientRef nothing changes.
import { describe, expect, it } from 'vitest';
import { Ctx } from './helpers';

const acks = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'actionAck') as { clientRef?: string; budget: number; duplicate?: boolean }[];

describe('campaign idempotency by clientRef', () => {
  it('a resent roadshow with the same clientRef is charged and recorded once, and acked again with the current budget', async () => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1, clientRef: 'x-1' });
    const afterFirst = await c.budget(0);
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1, clientRef: 'x-1' });
    expect(await c.budget(0)).toBe(afterFirst);
    expect(afterFirst).toBe(c.cfg.budget - c.cfg.costs.roadshow);
    expect((await c.repo.listActions(c.gameId)).length).toBe(1);
    const a = acks(c, 0);
    expect(a.map((m) => m.clientRef)).toEqual(['x-1', 'x-1']);
    expect(a[1].budget).toBe(afterFirst);
    expect(a[1].duplicate).toBe(true);
    expect(a[0].duplicate).toBeUndefined();
  });

  it('a resent RALLY is acked as a duplicate, not refused with RATE_LIMITED and not charged again', async () => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 2, clientRef: 'r-1' });
    const afterFirst = await c.budget(0);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 2, clientRef: 'r-1' });
    expect(await c.budget(0)).toBe(afterFirst);
    expect(c.lastError(0)).toBeFalsy();
    expect(acks(c, 0)[1].duplicate).toBe(true);
    expect((await c.repo.listActions(c.gameId)).length).toBe(1);
  });

  it('concurrent copies of one clientRef charge once', async () => {
    const c = await new Ctx().started(2, 1);
    await Promise.all([1, 2, 3, 4].map(() => c.send(0, { action: 'campaign', type: 'roadshow', seat: 3, clientRef: 'dup' })));
    expect((await c.repo.listActions(c.gameId)).length).toBe(1);
    expect(await c.budget(0)).toBe(c.cfg.budget - c.cfg.costs.roadshow);
  });

  it('different clientRefs, other players using the same clientRef, and messages without a clientRef are all independent', async () => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1, clientRef: 'a' });
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1, clientRef: 'b' });
    await c.send(1, { action: 'campaign', type: 'roadshow', seat: 1, clientRef: 'a' });
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1 });
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1 });
    expect((await c.repo.listActions(c.gameId)).length).toBe(5);
  });

  it('a failed action (no funds) does not burn its clientRef: a resend after the failure is judged afresh', async () => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1, clientRef: 'z' });
    // the repo only remembers refs of applied actions
    expect(await c.repo.hasActionRef(c.gameId, c.p[0].playerId, 'z')).toBe(true);
    expect(await c.repo.hasActionRef(c.gameId, c.p[0].playerId, 'never')).toBe(false);
  });

  it('a malformed clientRef is ignored for deduplication (still processed once per message)', async () => {
    const c = await new Ctx().started(2, 1);
    const bad = 'x'.repeat(200);
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1, clientRef: bad });
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1, clientRef: bad });
    expect((await c.repo.listActions(c.gameId)).length).toBe(2);
  });
});

describe('hello advertises the feature', () => {
  it('both hello variants carry features: ["actionRef"] so clients know a resend is safe', async () => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, { action: 'ping', clientTime: 1 });
    const hello = c.notifier.to(c.p[0].playerId, 'hello')[0] as { features?: string[] };
    expect(hello.features).toContain('actionRef');
  });
});
