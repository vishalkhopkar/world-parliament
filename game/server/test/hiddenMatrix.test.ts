// Hidden information, audited across player counts and phase counts: roadshows, budgets, reports, effects, tokens,
// other players' chat/offers never reach somebody who must not see them. Every outbound message of a full game is scanned.
import { describe, expect, it } from 'vitest';
import { createRng } from '@hp/shared';
import type { ServerMessage } from '@hp/shared';
import { Ctx, driveTo } from './helpers';

type Json = unknown;
function keys(v: Json, fn: (key: string, value: Json, path: string[]) => void, path: string[] = []): void {
  if (Array.isArray(v)) v.forEach((x, i) => keys(x, fn, [...path, String(i)]));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { fn(k, x, [...path, k]); keys(x, fn, [...path, k]); }
}

const SECRET_KEYS = new Set(['roadshow', 'roadshows', 'effect', 'effects', 'tokenHash', 'token', 'connectionId', 'graceSchedule', 'disconnectedAt', 'joinedAt', 'kernel', 'kernels', 'candidateColumn']);
const PRIVATE_ONLY = new Set(['hello', 'private', 'actionAck', 'report']);

interface Played { c: Ctx; roadshowTs: Map<number, number[]>; reportTs: number[] }

/** Plays a whole game: random rallies / roadshows / reports at distinct timestamps, then counting, chat, offers, finalise. */
async function play(players: number, phases: number, seed: string): Promise<Played> {
  const c = await new Ctx().started(players, phases);
  const rng = createRng(seed);
  const roadshowTs = new Map<number, number[]>();
  const reportTs: number[] = [];
  const span = c.timeline.campaignEnd - c.timeline.campaignStart;
  let t = c.timeline.campaignStart;
  for (let k = 0; k < 60; k++) {
    t += Math.floor(span / 61) + 7 + (k % 5); // strictly increasing, distinct, never on a phase boundary multiple
    c.clock.set(t);
    const i = Math.floor(rng() * players);
    const seat = 1 + Math.floor(rng() * 8);
    const r = rng();
    if (r < 0.15) { await c.send(i, { action: 'buyReport', scope: rng() < 0.5 ? 'global' : 'seat', seat }); reportTs.push(t); }
    else if (r < 0.55) {
      const before = (await c.repo.listActions(c.gameId)).length;
      await c.send(i, { action: 'campaign', type: 'roadshow', seat });
      if ((await c.repo.listActions(c.gameId)).length > before) roadshowTs.set(i, [...(roadshowTs.get(i) ?? []), t]);
    } else await c.send(i, { action: 'campaign', type: 'rally', seat });
    // players reconnect now and then: a fresh hello must be just as clean
    if (k % 17 === 5) {
      const conn = `re${k}`;
      await c.svc.connect(c.gameId, c.p[i].token, conn);
      c.p[i].conn = conn;
      await c.send(i, { action: 'ping', clientTime: k });
    }
  }
  await c.runCampaignToCountingEnd();
  if (players >= 3) {
    const [a, b] = [c.p[0].playerId, c.p[1].playerId];
    await c.send(0, { action: 'chat', to: [b], text: 'secret-deal-' + seed });
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [a], HOME: [b] } });
    const o = (await c.repo.listOffers(c.gameId))[0];
    if (o) await c.send(1, { action: 'respondOffer', offerId: o.offerId, accept: true });
  }
  c.clock.set(c.timeline.postCountingEnd);
  await c.svc.finalise(c.gameId);
  for (let i = 0; i < players; i++) { await c.svc.connect(c.gameId, c.p[i].token, `final${i}`); c.p[i].conn = `final${i}`; await c.send(i, { action: 'ping', clientTime: 99 }); }
  return { c, roadshowTs, reportTs };
}

describe.each([[2, 1], [2, 3], [3, 1], [3, 2], [5, 3], [10, 2]])('full game audit: %i players, %i phases', (players, phases) => {
  it('no message carries data its recipient must not see', async () => {
    const { c, roadshowTs } = await play(players, phases, `audit-${players}-${phases}`);
    const finalBudgets = await Promise.all(c.p.map((_, i) => c.budget(i)));
    for (let i = 0; i < players; i++) {
      const me = c.p[i].playerId;
      const received = c.notifier.log.filter((s) => s.to === me).map((s) => s.msg);
      expect(received.length).toBeGreaterThan(0);
      for (const m of received) {
        const text = JSON.stringify(m);
        // 1. secrets never appear as keys anywhere
        keys(m, (k, _v, path) => {
          expect(SECRET_KEYS.has(k), `${m.type}: ${path.join('.')}`).toBe(false);
          // 2. `budget` only in the owner-only messages
          if (k === 'budget') expect(PRIVATE_ONLY.has(m.type), `${m.type} leaks budget`).toBe(true);
        });
        // 3. owner-only messages are addressed to their owner
        if (m.type === 'hello' || m.type === 'private') expect(m.private.you).toBe(me);
        if (m.type === 'hello') {
          for (const pl of m.snapshot.players) expect(Object.keys(pl).every((k) => ['playerId', 'nickname', 'isAdmin', 'kind', 'party', 'status'].includes(k)), 'PlayerPublic has only public fields').toBe(true);
          for (const n of m.snapshot.news) expect(Object.keys(n).sort()).toEqual(['playerId', 'seat', 'ts']);
          if (m.snapshot.status === 'campaign') {
            expect(Object.keys(m.snapshot.seats)).toHaveLength(0);
            expect(m.snapshot.tally).toBeNull();
            expect(m.snapshot.result).toBeNull();
          }
          const mine = (await c.repo.listActions(c.gameId)).filter((a) => a.playerId === me);
          for (const a of m.private.myActions) expect(mine.some((x) => x.ts === a.ts && x.seat === a.seat && x.type === a.type), 'myActions only lists my own actions').toBe(true);
          for (const o of m.snapshot.offers) expect([o.proposer, ...o.partners]).toContain(me);
        }
        if (m.type === 'players') for (const pl of m.players) expect('budget' in pl).toBe(false);
        if (m.type === 'chat') expect([m.message.from, ...m.message.to]).toContain(me);
        if (m.type === 'offer') expect([m.offer.proposer, ...m.offer.partners]).toContain(me);
        if (m.type === 'news') expect(Object.keys(m.item).sort()).toEqual(['playerId', 'seat', 'ts']);
        // 4. nobody else's roadshow timestamps (unique per action) appear in messages to me
        for (const [owner, tss] of roadshowTs) {
          if (owner === i) continue;
          for (const ts of tss) expect(new RegExp(`(?<![0-9])${ts}(?![0-9])`).test(text), `roadshow of player ${owner} at ${ts} leaked to ${i} in ${m.type}`).toBe(false);
        }
        // 5. secret chat text only to its participants
        if (text.includes('secret-deal-')) expect(i === 0 || i === 1).toBe(true);
      }
      // 6. my reports are mine: every 'report' message equals one of my stored reports
      const stored = await c.repo.listReports(c.gameId, me);
      const got = received.filter((m): m is Extract<ServerMessage, { type: 'report' }> => m.type === 'report');
      expect(got).toHaveLength(stored.length);
      for (const g of got) expect(stored.some((s) => JSON.stringify(s.report) === JSON.stringify(g.report))).toBe(true);
      // 7. results / seat declarations only after counting started
      const types = received.map((m) => m.type);
      const firstUpdate = types.indexOf('seatUpdate');
      if (firstUpdate >= 0) expect(received.slice(0, firstUpdate).some((m) => m.type === 'status' && m.status === 'counting')).toBe(true);
      expect(finalBudgets[i]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('lobby-level privacy', () => {
  it('a pending player gets no game data, no other pending player, no party of non-members; admin sees the queue', async () => {
    const c = await new Ctx().lobby(2);
    const a = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'queued-a' });
    const b = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'queued-b' });
    await c.svc.connect(c.gameId, a.token, 'qa');
    await c.svc.handleMessage('qa', { action: 'ping', clientTime: 1 });
    const hello = c.notifier.to(a.playerId, 'hello')[0] as Extract<ServerMessage, { type: 'hello' }>;
    expect(hello.private).toEqual({ you: a.playerId, budget: 0, myActions: [], myReports: [] });
    expect(hello.snapshot.players.map((p) => p.nickname)).not.toContain('queued-b');
    expect(hello.snapshot.players.map((p) => p.nickname)).toContain('queued-a');
    expect(hello.snapshot).toMatchObject({ news: [], seats: {}, offers: [], government: null, result: null, tally: null, polledPhases: [] });
    // the admin's lobby sees both queued players, the other pending one does not see b
    const lobbyA = await c.svc.getLobby(c.gameId, a.token);
    expect(lobbyA.players.map((p) => p.playerId)).not.toContain(b.playerId);
    expect((await c.svc.getLobby(c.gameId, c.p[0].token)).players.map((p) => p.playerId)).toContain(b.playerId);
  });

  it('a pending or rejected player receives none of the broadcasts of a running game', async () => {
    const c = await new Ctx().lobby(3);
    const queued = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'late' });
    await c.svc.connect(c.gameId, queued.token, 'late-conn');
    for (const p of c.p) await c.svc.connect(c.gameId, p.token, p.conn);
    await c.svc.start(c.gameId, c.p[0].token); // queued -> rejected + disconnected
    c.clock.set(c.timeline.campaignStart);
    c.notifier.clear();
    await c.send(1, { action: 'campaign', type: 'rally', seat: 2 });
    await driveTo(c, 'finished');
    expect(c.notifier.log.filter((s) => s.to === queued.playerId)).toEqual([]);
  });

  it('error messages never include internals (stack traces, repo names, tokens)', async () => {
    const c = await new Ctx().started(2, 1);
    c.repo.listActions = async () => { throw new Error('secret-internal-detail token=abc'); };
    const { vi } = await import('vitest');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    } finally { spy.mockRestore(); }
    const e = c.notifier.to(c.p[0].playerId, 'error').pop() as { error: string; message: string };
    expect(e.error).toBe('INTERNAL');
    expect(JSON.stringify(e)).not.toContain('secret-internal-detail');
  });
});
