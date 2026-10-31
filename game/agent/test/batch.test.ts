// campaign_batch transport: bounded concurrency, unique idempotency keys, TIMEOUT semantics (offline, scripted socket).
import { describe, expect, it } from 'vitest';
import { GameClient } from '../src/client';
import { executeAction } from '../src/actions';
import { fakeSession, seatDir } from './fake';
import type { ServerMessage } from '@hp/shared';

interface Sent { action: string; type: string; seat: number; clientRef: string }

/** A GameClient whose socket is scripted: the script decides what the "server" answers (via the client's message handler). */
function scripted(opts: { actionTimeoutMs?: number; batchConcurrency?: number; features?: string[] } = {}) {
  const c = new GameClient({ ...opts });
  const sent: Sent[] = [];
  let inflight = 0, maxInflight = 0;
  let budget = 10_000;
  const handle = (m: ServerMessage) => (c as unknown as { handle(m: ServerMessage): void }).handle(m);
  const ack = (ref: string, extra: object = {}) => handle({ type: 'actionAck', clientRef: ref, ok: true, budget, ...extra } as ServerMessage);
  let script: (s: Sent, n: number) => void = (s) => { budget -= 100; setTimeout(() => { inflight--; ack(s.clientRef); }, 1); };
  const ws = { readyState: 1, send(text: string) {
    const s = JSON.parse(text) as Sent;
    if (s.action !== 'campaign') return;
    sent.push(s); inflight++; maxInflight = Math.max(maxInflight, inflight);
    script(s, sent.filter((x) => x.clientRef === s.clientRef).length);
  } };
  Object.assign(c as unknown as object, { ws, session: { server: 'x', gameId: 'g', playerId: 'me', token: 't' } });
  c.state.features = opts.features ?? [];
  return {
    c, sent, ack, setScript: (f: typeof script) => { script = f; },
    max: () => maxInflight, dec: () => { inflight--; }, chargeOne: () => { budget -= 100; },
  };
}
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'roadshow' as const, seat: i + 1 }));

describe('campaignBatch transport', () => {
  it('keeps at most batchConcurrency messages in flight, answers all 50 and sends them in input order', async () => {
    const t = scripted({ batchConcurrency: 5 });
    const res = await t.c.campaignBatch(items(50));
    expect(res.every((r) => r.ok)).toBe(true);
    expect(t.sent).toHaveLength(50);
    expect(t.max()).toBeLessThanOrEqual(5);
    expect(t.sent.map((s) => s.seat)).toEqual(items(50).map((i) => i.seat));
  });

  it('default concurrency is bounded (6), not 50', async () => {
    const t = scripted();
    await t.c.campaignBatch(items(50));
    expect(t.max()).toBeLessThanOrEqual(6);
    expect(t.max()).toBeGreaterThan(1);
  });

  it('every message has its own clientRef, and two clients never share refs (the server dedupes by ref)', async () => {
    const a = scripted(); const b = scripted();
    await a.c.campaignBatch(items(10)); await b.c.campaignBatch(items(10));
    const refs = [...a.sent, ...b.sent].map((s) => s.clientRef);
    expect(new Set(refs).size).toBe(20);
    for (const r of refs) expect(r).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('the per-action timeout starts when the message is sent, so a queued action is not timed out while it waits for a slot', async () => {
    const t = scripted({ batchConcurrency: 1, actionTimeoutMs: 80 });
    t.setScript((s) => { t.chargeOne(); setTimeout(() => { t.dec(); t.ack(s.clientRef); }, 50); }); // 8 x 50 ms = 400 ms, far above 80 ms
    const res = await t.c.campaignBatch(items(8));
    expect(res.every((r) => r.ok)).toBe(true);
  });

  it('an old server (no actionRef): a TIMEOUT is reported as unknown and is NEVER resent', async () => {
    const t = scripted({ actionTimeoutMs: 40 });
    t.setScript((s) => { t.dec(); if (s.seat !== 2) { t.chargeOne(); t.ack(s.clientRef); } }); // seat 2 never answers
    const res = await t.c.campaignBatch(items(3));
    expect(res.map((r) => r.ok)).toEqual([true, false, true]);
    const r = res[1] as { ok: false; error: { code: string }; unknown?: boolean };
    expect(r.error.code).toBe('TIMEOUT');
    expect(r.unknown).toBe(true);
    expect(t.sent.filter((s) => s.seat === 2)).toHaveLength(1);
  });

  it('a server with actionRef: the timed-out action is resent once with the SAME clientRef and the duplicate ack resolves it', async () => {
    const t = scripted({ actionTimeoutMs: 40, features: ['actionRef'] });
    t.setScript((s, n) => {
      t.dec();
      if (s.seat === 2 && n === 1) return; // applied on the server, ack lost
      t.ack(s.clientRef, s.seat === 2 ? { duplicate: true } : {});
    });
    const res = await t.c.campaignBatch(items(3));
    expect(res.every((r) => r.ok)).toBe(true);
    const two = t.sent.filter((s) => s.seat === 2);
    expect(two).toHaveLength(2);
    expect(two[0].clientRef).toBe(two[1].clientRef);
  });

  it('a resend is attempted only once even if it times out again', async () => {
    const t = scripted({ actionTimeoutMs: 30, features: ['actionRef'] });
    t.setScript(() => { t.dec(); });
    const res = await t.c.campaignBatch(items(2));
    expect(res.every((r) => !r.ok && (r as { unknown?: boolean }).unknown)).toBe(true);
    expect(t.sent).toHaveLength(4);
  });

  it('a late ack after the timeout still records the action in my_actions', async () => {
    const t = scripted({ actionTimeoutMs: 20 });
    t.c.state.priv = { you: 'me', budget: 1000, myActions: [], myReports: [] };
    t.setScript((s) => { t.dec(); setTimeout(() => t.ack(s.clientRef), 60); });
    const res = await t.c.campaignBatch(items(1));
    expect(res[0].ok).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.c.state.priv!.myActions).toHaveLength(1);
  });
});

describe('campaign_batch action reports unknown outcomes', () => {
  it('a TIMEOUT row is marked outcome_unknown with a do-not-resend hint; the other rows are untouched', async () => {
    const { s, c } = fakeSession(await seatDir());
    c.campaignBatch = (async (list: { type: string; seat: number }[]) => list.map((_, k) => (k === 1
      ? { ok: false as const, unknown: true, error: Object.assign(new Error('x'), { code: 'TIMEOUT', hint: undefined, name: 'AgentError' }) }
      : { ok: true as const, budget: 1 }))) as never;
    const r = await executeAction(s, 'campaign_batch', { actions: [{ type: 'roadshow', seat: 1 }, { type: 'rally', seat: 2 }, { type: 'roadshow', seat: 3 }] });
    expect(r.ok).toBe(true);
    const rows = (r as { data: { results: any[] } }).data.results;
    expect(rows[1].ok).toBe(false);
    expect(rows[1].outcome_unknown).toBe(true);
    expect(rows[1].error.hint).toMatch(/get_state/);
    expect(rows[0].outcome_unknown).toBeUndefined();
  });
});
