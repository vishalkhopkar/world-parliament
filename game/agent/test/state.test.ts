import { describe, expect, it } from 'vitest';
import type { GameSnapshot, PlayerPublic, PrivateState, ServerMessage } from '@hp/shared';
import { EventLog, admissionOf, applyMessage, newState } from '../src/state';

const players: PlayerPublic[] = [
  { playerId: 'h', nickname: 'Host', isAdmin: true, status: 'active' },
  { playerId: 'me', nickname: 'Bot', isAdmin: false, kind: 'agent', status: 'pending' },
];
const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g1', mapId: 'world-500', status: 'lobby', phases: 3, timeline: null, players, news: [], polledPhases: [],
  seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});
const priv = (over: Partial<PrivateState> = {}): PrivateState => ({ you: 'me', budget: 1000, myActions: [], myReports: [], ...over });
const hello = (over: Partial<GameSnapshot> = {}, serverTime = 5000): ServerMessage => ({ type: 'hello', serverTime, snapshot: snap(over), private: priv() });

describe('chat history in hello', () => {
  const msg = (id: string, ts: number) => ({ id, from: 'h', to: ['me'], text: id, ts });
  it('a hello with history replaces the chat log (a restarted daemon or reconnect keeps the conversation); without one it is kept', () => {
    const st = newState();
    applyMessage(st, { type: 'chat', message: msg('live', 1) }, 1000);
    applyMessage(st, { ...(hello() as object), chat: [msg('a', 5), msg('b', 6)] } as ServerMessage, 1000);
    expect(st.chat.map((m) => m.id)).toEqual(['a', 'b']);
    applyMessage(st, hello(), 1000);
    expect(st.chat.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('EventLog', () => {
  it('assigns monotonically increasing cursors starting at 1', () => {
    const log = new EventLog();
    expect(log.cursor).toBe(0);
    const a = log.push('news', { n: 1 }, 10);
    const b = log.push('chat', { n: 2 }, 11);
    expect([a.cursor, b.cursor]).toEqual([1, 2]);
    expect(log.cursor).toBe(2);
  });

  it('since() returns later events, filters by type and advances the cursor past filtered-out events', () => {
    const log = new EventLog();
    log.push('news', {}, 1); log.push('chat', {}, 2); log.push('news', {}, 3); log.push('status', {}, 4);
    expect(log.since(0).events.map((e) => e.cursor)).toEqual([1, 2, 3, 4]);
    expect(log.since(2).events.map((e) => e.cursor)).toEqual([3, 4]);
    const r = log.since(0, { types: ['chat'] });
    expect(r.events.map((e) => e.cursor)).toEqual([2]);
    expect(r.cursor).toBe(4); // news/status skipped for good
    expect(log.since(4).events).toEqual([]);
    expect(log.since(4).cursor).toBe(4);
  });

  it('limit truncates and the returned cursor points at the last returned event', () => {
    const log = new EventLog();
    for (let i = 0; i < 5; i++) log.push('news', { i }, i);
    const r = log.since(0, { limit: 2 });
    expect(r.events.map((e) => e.cursor)).toEqual([1, 2]);
    expect(r.more).toBe(true);
    expect(r.cursor).toBe(2);
    const r2 = log.since(r.cursor, { limit: 10 });
    expect(r2.events.map((e) => e.cursor)).toEqual([3, 4, 5]);
    expect(r2.more).toBe(false);
  });

  it('is bounded but keeps cursors monotonic', () => {
    const log = new EventLog(3);
    for (let i = 0; i < 10; i++) log.push('news', {}, i);
    expect(log.since(0).events.map((e) => e.cursor)).toEqual([8, 9, 10]);
    expect(log.cursor).toBe(10);
  });

  it('wait() resolves immediately when events exist, times out when none, and wakes up on push', async () => {
    const log = new EventLog();
    log.push('news', {}, 1);
    expect((await log.wait(0, 1000)).events).toHaveLength(1);
    const t0 = Date.now();
    const idle = await log.wait(1, 120);
    expect(idle.timedOut).toBe(true);
    expect(idle.events).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    const pending = log.wait(1, 5000, { types: ['chat'] });
    setTimeout(() => log.push('news', {}, 2), 20); // wrong type: must not end the wait
    setTimeout(() => log.push('chat', { x: 1 }, 3), 60);
    const r = await pending;
    expect(r.timedOut).toBe(false);
    expect(r.events.map((e) => e.type)).toEqual(['chat']);
    expect(r.cursor).toBe(3);
  });
});

describe('applyMessage (state reducer)', () => {
  it('hello sets snapshot, private state, polled phases and the server clock offset', () => {
    const st = newState();
    st.me = 'me';
    expect(applyMessage(st, hello({ polledPhases: [0] }, 10_000), 4_000)).toEqual([]);
    expect(st.snapshot?.gameId).toBe('g1');
    expect(st.priv?.budget).toBe(1000);
    expect(st.serverOffsetMs).toBe(6_000);
    expect(st.polledPhases.has(0)).toBe(true);
  });

  it('pong refines the offset assuming symmetric latency', () => {
    const st = newState();
    applyMessage(st, { type: 'pong', clientTime: 1000, serverTime: 6000 }, 1200);
    expect(st.serverOffsetMs).toBe(6000 - 1100);
    applyMessage(st, { type: 'pong', clientTime: 0, serverTime: 9999 }, 1200); // clientTime 0 = unknown: ignored
    expect(st.serverOffsetMs).toBe(4900);
  });

  it('actionAck updates the budget and appends the tracked action by clientRef', () => {
    const st = newState();
    st.me = 'me';
    applyMessage(st, hello(), 0);
    st.pendingActions.set('a1', { type: 'rally', seat: 7 });
    applyMessage(st, { type: 'actionAck', clientRef: 'a1', ok: true, budget: 400 }, 100);
    expect(st.priv?.budget).toBe(400);
    expect(st.priv?.myActions).toHaveLength(1);
    expect(st.priv?.myActions[0]).toMatchObject({ type: 'rally', seat: 7 });
    expect(st.pendingActions.size).toBe(0);
    applyMessage(st, { type: 'actionAck', ok: true, budget: 100 }, 100); // untracked: only the budget changes
    expect(st.priv?.budget).toBe(100);
    expect(st.priv?.myActions).toHaveLength(1);
  });

  it('actionAck carries the server nextRallyAt into priv (kept when an ack has none)', () => {
    const st = newState();
    st.me = 'me';
    applyMessage(st, hello(), 0);
    applyMessage(st, { type: 'actionAck', ok: true, budget: 400, nextRallyAt: 12345 }, 100);
    expect(st.priv?.nextRallyAt).toBe(12345);
    applyMessage(st, { type: 'actionAck', ok: true, budget: 300 }, 100);
    expect(st.priv?.nextRallyAt).toBe(12345);
  });

  it('applies news, phaseClosed, status, players, report, seatUpdate, chat (deduplicated), offer (replaced by id), government and result', () => {
    const st = newState();
    st.me = 'me';
    applyMessage(st, hello(), 0);
    expect(applyMessage(st, { type: 'news', item: { playerId: 'h', seat: 3, ts: 1 } }, 0)[0].type).toBe('news');
    expect(st.snapshot?.news).toHaveLength(1);
    applyMessage(st, { type: 'phaseClosed', phase: 1, seats: [3, 4] }, 0);
    applyMessage(st, { type: 'phaseClosed', phase: 1, seats: [3, 4] }, 0);
    expect([...st.polledPhases]).toEqual([1]);
    expect(st.snapshot?.polledPhases).toEqual([1]);
    applyMessage(st, { type: 'status', status: 'campaign', timeline: null }, 0);
    expect(st.snapshot?.status).toBe('campaign');
    applyMessage(st, { type: 'players', players: [players[0]] }, 0);
    expect(st.snapshot?.players).toHaveLength(1);
    applyMessage(st, { type: 'report', budget: 50, report: { scope: 'global', asOf: 1, purchasedAt: 2, price: 10, entries: [] } }, 0);
    expect(st.priv?.myReports).toHaveLength(1);
    expect(st.priv?.budget).toBe(50);
    const decl = { seat: 3, status: 'leading' as const, playerId: 'h' };
    applyMessage(st, { type: 'seatUpdate', declaration: decl, tally: { leads: { h: 1 }, wins: {}, declared: 0, total: 8 } }, 0);
    expect(st.snapshot?.seats[3]).toEqual(decl);
    expect(st.snapshot?.tally?.leads.h).toBe(1);
    const msg = { id: 'm1', from: 'h', to: ['me'], text: 'hi', ts: 1 };
    expect(applyMessage(st, { type: 'chat', message: msg }, 0)).toHaveLength(1);
    expect(applyMessage(st, { type: 'chat', message: msg }, 0)).toHaveLength(0);
    expect(st.chat).toHaveLength(1);
    const offer = { offerId: 'o1', proposer: 'h', portfolios: { PM: ['h'] }, partners: ['me'], accepted: [], status: 'open' as const, createdAt: 1 };
    applyMessage(st, { type: 'offer', offer }, 0);
    applyMessage(st, { type: 'offer', offer: { ...offer, status: 'accepted', accepted: ['me'] } }, 0);
    expect(st.snapshot?.offers).toHaveLength(1);
    expect(st.snapshot?.offers[0].status).toBe('accepted');
    applyMessage(st, { type: 'government', government: { pm: 'h', members: ['h', 'me'], portfolios: { PM: ['h'] }, formedAt: 1, viaNegotiation: true } }, 0);
    expect(st.snapshot?.government?.pm).toBe('h');
    applyMessage(st, { type: 'result', result: { outcome: 'coalition', tally: {}, government: null, points: [], winners: ['h'] } }, 0);
    expect(st.snapshot?.status).toBe('finished');
    expect(st.snapshot?.result?.winners).toEqual(['h']);
  });

  it('error with clientRef drops the pending action and is logged', () => {
    const st = newState();
    st.pendingActions.set('a9', { type: 'roadshow', seat: 1 });
    const ev = applyMessage(st, { type: 'error', error: 'SEAT_POLLED', message: 'closed', clientRef: 'a9' }, 0);
    expect(st.pendingActions.size).toBe(0);
    expect(ev[0]).toMatchObject({ type: 'error', data: { error: 'SEAT_POLLED', clientRef: 'a9' } });
  });

  it('admissionOf follows my entry in the player list', () => {
    const st = newState();
    st.me = 'me';
    expect(admissionOf(st)).toBe('unknown');
    applyMessage(st, hello(), 0);
    expect(admissionOf(st)).toBe('pending');
    applyMessage(st, { type: 'players', players: [players[0], { ...players[1], status: 'active' }] }, 0);
    expect(admissionOf(st)).toBe('admitted');
    applyMessage(st, { type: 'players', players: [{ ...players[1], status: 'rejected' }] }, 0);
    expect(admissionOf(st)).toBe('declined');
  });
});

describe('applyMessage with frames it does not know', () => {
  it('ignores them instead of crashing (API Gateway sends bare {"message":...} frames)', () => {
    const st = newState();
    expect(applyMessage(st, { message: 'Internal server error' } as unknown as ServerMessage, 0)).toEqual([]);
    expect(applyMessage(st, { type: 'somethingNew' } as unknown as ServerMessage, 0)).toEqual([]);
  });
});
