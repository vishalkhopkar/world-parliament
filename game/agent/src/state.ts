// Client-side game state and event log, maintained by applying every ServerMessage (same idea as web/src/state/store.ts).
// Pure and synchronous: no network here, so it is unit-testable.
import type {
  ActionType, ChatMessage, GameSnapshot, LobbyView, PlayerId, PrivateState, SeatId, ServerMessage,
} from '@hp/shared';

export type EventType =
  | 'news' | 'phaseClosed' | 'seatUpdate' | 'chat' | 'offer' | 'government' | 'result' | 'status' | 'players' | 'report' | 'error';

export const EVENT_TYPES: readonly EventType[] = [
  'news', 'phaseClosed', 'seatUpdate', 'chat', 'offer', 'government', 'result', 'status', 'players', 'report', 'error',
];

export interface AgentEvent {
  /** Monotonically increasing, starts at 1. */
  cursor: number;
  /** Estimated server epoch ms when the event was received. */
  at: number;
  type: EventType;
  /** The raw payload of the ServerMessage (everything except `type`). */
  data: Record<string, unknown>;
}

export interface WaitResult { events: AgentEvent[]; cursor: number; timedOut: boolean }

/** Append-only (bounded) event log with a monotonically increasing cursor and long-polling. */
export class EventLog {
  private events: AgentEvent[] = [];
  private last = 0;
  private waiters = new Set<() => void>();
  constructor(private readonly max = 5000) {}

  /** Cursor of the most recent event (0 = none yet). */
  get cursor(): number { return this.last; }

  push(type: EventType, data: Record<string, unknown>, at: number): AgentEvent {
    const ev: AgentEvent = { cursor: ++this.last, at, type, data };
    this.events.push(ev);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    for (const w of [...this.waiters]) w();
    return ev;
  }

  /**
   * Events after `since` (exclusive), optionally filtered by type. `cursor` is what to pass next time: the latest cursor
   * overall (so filtered-out events are skipped for good), or the last returned event's cursor when `limit` truncated the list.
   */
  since(since: number, opts: { types?: readonly EventType[]; limit?: number } = {}): { events: AgentEvent[]; cursor: number; more: boolean } {
    const types = opts.types && opts.types.length ? new Set<EventType>(opts.types) : undefined;
    const out: AgentEvent[] = [];
    let more = false;
    let cursor = this.last;
    for (const e of this.events) {
      if (e.cursor <= since) continue;
      if (types && !types.has(e.type)) continue;
      if (opts.limit !== undefined && out.length >= opts.limit) { more = true; cursor = out[out.length - 1].cursor; break; }
      out.push(e);
    }
    return { events: out, cursor: Math.max(cursor, Math.min(since, this.last)), more };
  }

  /** Resolves as soon as at least one matching event after `since` exists, or after timeoutMs with no events. */
  async wait(since: number, timeoutMs: number, opts: { types?: readonly EventType[]; limit?: number } = {}): Promise<WaitResult> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const r = this.since(since, opts);
      if (r.events.length) return { events: r.events, cursor: r.cursor, timedOut: false };
      const left = deadline - Date.now();
      if (left <= 0) return { events: [], cursor: r.cursor, timedOut: true };
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
        const t = setTimeout(done, left);
        this.waiters.add(done);
      });
    }
  }
}

export type LinkState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
export type Admission = 'unknown' | 'pending' | 'admitted' | 'declined';

export interface ClientState {
  gameId: string | null;
  me: PlayerId | null;
  joinCode: string | null;
  nickname: string | null;
  lobby: LobbyView | null;
  snapshot: GameSnapshot | null;
  priv: PrivateState | null;
  chat: ChatMessage[];
  /** serverTime - local Date.now() (ms). */
  serverOffsetMs: number;
  link: LinkState;
  /** 0-based polling phases known to be closed (hello snapshot + phaseClosed messages). */
  polledPhases: Set<number>;
  /** clientRef -> what that campaign message was (so an actionAck can extend myActions). */
  pendingActions: Map<string, { type: ActionType; seat: SeatId }>;
  /** The campaign started but the server's budget update (sent right after the status event) has not arrived yet. */
  budgetPending: boolean;
}

export function newState(): ClientState {
  return {
    gameId: null, me: null, joinCode: null, nickname: null, lobby: null, snapshot: null, priv: null, chat: [],
    serverOffsetMs: 0, link: 'idle', polledPhases: new Set(), pendingActions: new Map(), budgetPending: false,
  };
}

/** Where I stand in the lobby, from the freshest player list available. */
export function admissionOf(st: ClientState): Admission {
  const list = st.snapshot?.players ?? st.lobby?.players;
  const mine = list?.find((p) => p.playerId === st.me);
  if (!mine) return 'unknown';
  switch (mine.status) {
    case 'pending': return 'pending';
    case 'rejected': return 'declined';
    default: return 'admitted';
  }
}

export interface Logged { type: EventType; data: Record<string, unknown> }
const ev = (type: EventType, data: Record<string, unknown>): Logged => ({ type, data });

/**
 * Apply one ServerMessage to the state. Returns the events to append to the log (possibly none).
 * `localNow` is Date.now() at receipt.
 */
export function applyMessage(st: ClientState, m: ServerMessage, localNow: number): Logged[] {
  const snap = st.snapshot;
  switch (m.type) {
    case 'hello':
      st.snapshot = m.snapshot;
      st.priv = m.private;
      st.budgetPending = false;
      st.serverOffsetMs = m.serverTime - localNow;
      st.polledPhases = new Set(m.snapshot.polledPhases);
      if (m.chat) st.chat = m.chat; // the conversation so far (kept across a reconnect)
      return [];
    case 'pong':
      // clientTime is the local send time: assume symmetric latency
      if (m.clientTime > 0) st.serverOffsetMs = m.serverTime - (localNow + m.clientTime) / 2;
      return [];
    case 'private':
      st.priv = m.private;
      st.budgetPending = false;
      return [];
    case 'status':
      if (m.status === 'campaign' && snap?.status !== 'campaign' && st.priv && st.priv.budget === 0) st.budgetPending = true;
      if (snap) st.snapshot = { ...snap, status: m.status, timeline: m.timeline };
      return [ev('status', { status: m.status, timeline: m.timeline })];
    case 'players':
      if (snap) st.snapshot = { ...snap, players: m.players };
      return [ev('players', { players: m.players })];
    case 'news':
      if (snap) st.snapshot = { ...snap, news: [...snap.news, m.item] };
      return [ev('news', { item: m.item })];
    case 'actionAck': {
      st.budgetPending = false;
      const a = m.clientRef ? st.pendingActions.get(m.clientRef) : undefined;
      if (m.clientRef) st.pendingActions.delete(m.clientRef);
      if (st.priv) {
        st.priv = {
          ...st.priv, budget: m.budget,
          ...(m.nextRallyAt !== undefined ? { nextRallyAt: m.nextRallyAt } : {}),
          myActions: a ? [...st.priv.myActions, { ...a, ts: localNow + st.serverOffsetMs }] : st.priv.myActions,
        };
      }
      return [];
    }
    case 'report':
      st.budgetPending = false;
      if (st.priv) st.priv = { ...st.priv, budget: m.budget, myReports: [...st.priv.myReports, m.report] };
      return [ev('report', { report: m.report, budget: m.budget })];
    case 'phaseClosed':
      st.polledPhases.add(m.phase);
      if (snap && !snap.polledPhases.includes(m.phase)) st.snapshot = { ...snap, polledPhases: [...snap.polledPhases, m.phase] };
      return [ev('phaseClosed', { phase: m.phase, seats: m.seats })];
    case 'seatUpdate':
      if (snap) st.snapshot = { ...snap, seats: { ...snap.seats, [m.declaration.seat]: m.declaration }, tally: m.tally };
      return [ev('seatUpdate', { declaration: m.declaration, tally: m.tally })];
    case 'chat':
      if (st.chat.some((c) => c.id === m.message.id)) return [];
      st.chat = [...st.chat, m.message];
      return [ev('chat', { message: m.message })];
    case 'offer':
      if (snap) st.snapshot = { ...snap, offers: snap.offers.filter((o) => o.offerId !== m.offer.offerId).concat(m.offer) };
      return [ev('offer', { offer: m.offer })];
    case 'government':
      if (snap) st.snapshot = { ...snap, government: m.government };
      return [ev('government', { government: m.government })];
    case 'result':
      if (snap) st.snapshot = { ...snap, result: m.result, status: 'finished' };
      return [ev('result', { result: m.result })];
    case 'error':
      if (m.clientRef) st.pendingActions.delete(m.clientRef);
      return [ev('error', { error: m.error, message: m.message, ...(m.clientRef ? { clientRef: m.clientRef } : {}) })];
    default:
      return []; // unknown frames (e.g. API Gateway's own {"message":...} replies) must never crash the client
  }
}
