// GameClient: REST + one WebSocket for ONE AI player. Mirrors what the browser client does, nothing more.
// There is deliberately NO createGame method: an AI agent can only join games created by humans.
import type {
  ActionType, AnalystReport, ChatMessage, ClientMessage, CoalitionOffer, ErrorCode, JoinGameRequest, JoinGameResponse,
  LobbyView, PartyIdentity, PlayerId, PortfolioAssignment, ReportScope, SeatId, ServerMessage,
} from '@hp/shared';
import { AgentError } from './errors';
import type { AgentErrorCode } from './errors';
import { admissionOf, applyMessage, EventLog, newState } from './state';
import type { Admission, ClientState, EventType, WaitResult } from './state';

export interface Session {
  server: string;
  gameId: string;
  playerId: PlayerId;
  token: string;
  joinCode?: string;
  nickname?: string;
}

export interface ClientOptions {
  /** REST base, default http://localhost:8787 */
  server?: string;
  /** WebSocket endpoint (without query), default derived from `server` (+ /ws). */
  ws?: string;
  /** diagnostics (stderr in the MCP server) */
  log?: (msg: string) => void;
  pingMs?: number;
  /** Reconnect backoff base in ms (default 500, doubling up to 10 s). */
  reconnectBaseMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CampaignResult { type: ActionType; seat: SeatId; budget: number }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const defaultWsFor = (server: string): string => server.replace(/\/+$/, '').replace(/^http/, 'ws') + '/ws';

interface Collector {
  errors: { error: ErrorCode; message: string }[];
  matched: unknown;
  match?: (m: ServerMessage) => unknown;
}

export class GameClient {
  readonly state: ClientState = newState();
  readonly events = new EventLog();
  session: Session | null = null;
  /** Set when the connection is permanently lost (bad token, game gone, declined, finished). */
  lostReason: string | null = null;

  readonly server: string;
  readonly wsUrl: string;
  private readonly log: (m: string) => void;
  private readonly pingMs: number;
  private readonly reconnectBaseMs: number;
  private readonly fetchImpl: typeof fetch;

  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closedByUs = false;
  private helloWaiters: (() => void)[] = [];
  private everHello = false;
  private refCounter = 0;
  private pendingRefs = new Map<string, { resolve: (budget: number) => void; reject: (e: AgentError) => void; timer: ReturnType<typeof setTimeout> }>();
  private barriers = new Map<number, () => void>();
  private barrierSeq = 0;
  private collector: Collector | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: ClientOptions = {}) {
    this.server = (opts.server ?? 'http://localhost:8787').replace(/\/+$/, '');
    this.wsUrl = (opts.ws ?? defaultWsFor(this.server)).replace(/\/+$/, '');
    this.log = opts.log ?? (() => undefined);
    this.pingMs = opts.pingMs ?? 15_000;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 500;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  // ------------------------------------------------------------------ clock
  /** Estimated server epoch ms right now. */
  serverNow(): number { return Date.now() + this.state.serverOffsetMs; }

  get me(): PlayerId | null { return this.state.me; }
  get admission(): Admission { return admissionOf(this.state); }

  // ------------------------------------------------------------------ REST
  private async rest<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) {
      if (!this.session) throw new AgentError('NOT_JOINED', 'You have not joined a game yet.');
      headers.authorization = 'Bearer ' + this.session.token;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.server + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new AgentError('NO_CONNECTION', `Cannot reach the game server at ${this.server}: ${(e as Error).message}`,
        'Check that the human host runs the server and that HP_SERVER points to it.');
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!res.ok) {
      const j = (json ?? {}) as { error?: string; message?: string };
      throw new AgentError((j.error as AgentErrorCode) ?? 'INTERNAL', j.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }

  /**
   * Join an existing game as an AI player (kind 'agent'). The host still has to admit you.
   * There is intentionally no way to create a game from here.
   */
  async join(joinCode: string, nickname: string): Promise<Session> {
    if (this.session) throw new AgentError('ALREADY_JOINED', `Already joined game ${this.session.gameId} as "${this.session.nickname}".`);
    const req: JoinGameRequest = { joinCode: joinCode.trim().toUpperCase(), nickname: nickname.trim(), kind: 'agent' };
    const r = await this.rest<JoinGameResponse>('POST', '/games/join', req, false);
    this.session = { server: this.server, gameId: r.gameId, playerId: r.playerId, token: r.token, joinCode: req.joinCode, nickname: req.nickname };
    this.attachSession();
    await this.connect().catch((e) => this.log('initial connect failed: ' + (e as Error).message));
    return this.session;
  }

  /** Re-attach to a game from a stored session (restarted MCP server / daemon). */
  async resume(session: Session): Promise<void> {
    if (this.session) throw new AgentError('ALREADY_JOINED', 'Already attached to a game.');
    this.session = { ...session, server: this.server };
    this.attachSession();
    try {
      await this.refreshLobby(); // validates the token (401/404 -> throws)
    } catch (e) {
      this.session = null;
      this.state.gameId = this.state.me = this.state.joinCode = this.state.nickname = null;
      throw e;
    }
    await this.connect().catch((e) => this.log('resume connect failed: ' + (e as Error).message));
  }

  private attachSession(): void {
    const s = this.session as Session;
    this.state.gameId = s.gameId;
    this.state.me = s.playerId;
    this.state.joinCode = s.joinCode ?? null;
    this.state.nickname = s.nickname ?? null;
    this.closedByUs = false;
    this.lostReason = null;
    this.everHello = false;
    this.attempts = 0;
  }

  async refreshLobby(): Promise<LobbyView> {
    const s = this.requireSession();
    const v = await this.rest<LobbyView>('GET', '/games/' + encodeURIComponent(s.gameId));
    this.state.lobby = v;
    this.state.joinCode = v.joinCode;
    return v;
  }

  async setParty(party: PartyIdentity): Promise<void> {
    const s = this.requireSession();
    await this.rest('POST', `/games/${encodeURIComponent(s.gameId)}/party`, { party });
    await this.refreshLobby().catch(() => undefined);
  }

  private requireSession(): Session {
    if (!this.session) throw new AgentError('NOT_JOINED', 'You have not joined a game yet.');
    return this.session;
  }

  // ------------------------------------------------------------------ websocket
  /** Open the socket and resolve once the server's hello arrived (it only answers after our first ping). */
  connect(timeoutMs = 10_000): Promise<void> {
    const s = this.requireSession();
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.everHello) return Promise.resolve();
    this.openSocket(s);
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { remove(); reject(new AgentError('TIMEOUT', 'Timed out waiting for the server hello.')); }, timeoutMs);
      const w = () => { clearTimeout(t); resolve(); };
      const remove = () => { this.helloWaiters = this.helloWaiters.filter((x) => x !== w); };
      this.helloWaiters.push(w);
      if (this.everHello && this.ws && this.ws.readyState === WebSocket.OPEN) w();
    });
  }

  private openSocket(s: Session): void {
    if (this.closedByUs) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.state.link = this.attempts === 0 ? 'connecting' : 'reconnecting';
    const url = `${this.wsUrl}?gameId=${encodeURIComponent(s.gameId)}&token=${encodeURIComponent(s.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.state.link = 'open';
      this.attempts = 0;
      this.sendRaw({ action: 'ping', clientTime: Date.now() }); // the server sends hello only after our first message
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.sendRaw({ action: 'ping', clientTime: Date.now() }), this.pingMs);
      this.pingTimer.unref?.();
    };
    ws.onmessage = (e) => {
      let m: ServerMessage;
      try { m = JSON.parse(String(e.data)) as ServerMessage; } catch { return; }
      this.handle(m);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      this.failPending(new AgentError('NO_CONNECTION', 'The connection to the game server was lost; reconnecting.'));
      if (this.closedByUs) { this.state.link = 'closed'; return; }
      this.state.link = 'reconnecting';
      void this.scheduleReconnect();
    };
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.reconnectTimer || this.closedByUs) return;
    const finished = this.state.snapshot?.status === 'finished' || this.state.snapshot?.status === 'abandoned';
    if (finished) { this.state.link = 'closed'; return; }
    const delay = Math.min(10_000, this.reconnectBaseMs * 2 ** Math.min(this.attempts, 5)) + Math.floor(Math.random() * 200);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void (async () => {
        if (this.closedByUs || !this.session) return;
        // Is it still worth reconnecting? (token valid, game exists, not declined)
        try {
          const v = await this.refreshLobby();
          const mine = v.players.find((p) => p.playerId === this.state.me);
          if (mine?.status === 'rejected') { this.giveUp('The host declined your request to join.'); return; }
          if (mine?.status === 'eliminated') this.log('player was eliminated; staying connected read-only');
        } catch (e) {
          const code = e instanceof AgentError ? e.code : '';
          if (code === 'UNAUTHORIZED' || code === 'NOT_FOUND') { this.giveUp('The game no longer exists or the token is invalid (' + code + ').'); return; }
          // server unreachable: keep trying
        }
        if (this.session) this.openSocket(this.session);
      })();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private giveUp(reason: string): void {
    this.lostReason = reason;
    this.closedByUs = true;
    this.state.link = 'closed';
    this.log('giving up: ' + reason);
    for (const w of this.helloWaiters) w();
    this.helloWaiters = [];
  }

  private sendRaw(m: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  private handle(m: ServerMessage): void {
    const now = Date.now();
    if (m.type === 'hello') {
      this.everHello = true;
      const hw = this.helloWaiters;
      this.helloWaiters = [];
      applyMessage(this.state, m, now);
      for (const w of hw) w();
      return;
    }
    if (m.type === 'pong') {
      applyMessage(this.state, m, now);
      const b = this.barriers.get(m.clientTime);
      if (b) { this.barriers.delete(m.clientTime); b(); }
      return;
    }
    if (m.type === 'actionAck' && m.clientRef) {
      const p = this.pendingRefs.get(m.clientRef);
      applyMessage(this.state, m, now);
      if (p) { clearTimeout(p.timer); this.pendingRefs.delete(m.clientRef); p.resolve(m.budget); }
      return;
    }
    if (m.type === 'error' && m.clientRef) {
      const p = this.pendingRefs.get(m.clientRef);
      for (const l of applyMessage(this.state, m, now)) this.events.push(l.type, l.data, this.serverNow());
      if (p) { clearTimeout(p.timer); this.pendingRefs.delete(m.clientRef); p.reject(new AgentError(m.error, m.message)); }
      return;
    }
    if (this.collector) {
      if (m.type === 'error') this.collector.errors.push({ error: m.error, message: m.message });
      else if (this.collector.match && this.collector.matched === undefined) {
        const r = this.collector.match(m);
        if (r !== undefined) this.collector.matched = r;
      }
    }
    for (const l of applyMessage(this.state, m, now)) this.events.push(l.type, l.data, this.serverNow());
  }

  private failPending(e: AgentError): void {
    for (const [ref, p] of this.pendingRefs) { clearTimeout(p.timer); p.reject(e); this.pendingRefs.delete(ref); }
    for (const [k, b] of this.barriers) { this.barriers.delete(k); b(); }
  }

  private requireOpen(): void {
    if (!this.session) throw new AgentError('NOT_JOINED', 'You have not joined a game yet.');
    if (this.lostReason) throw new AgentError('NO_CONNECTION', 'Connection permanently lost: ' + this.lostReason);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new AgentError('NO_CONNECTION', 'The live connection is down (reconnecting automatically, up to 90 s grace).');
    }
  }

  // ------------------------------------------------------------------ campaign
  /** Send a campaign action; resolves with the new budget when the server acks (matched by clientRef). Pipelined. */
  campaign(type: ActionType, seat: SeatId, timeoutMs = 15_000): Promise<CampaignResult> {
    try { this.requireOpen(); } catch (e) { return Promise.reject(e); }
    const ref = `a${++this.refCounter}`;
    this.state.pendingActions.set(ref, { type, seat });
    return new Promise<CampaignResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRefs.delete(ref);
        this.state.pendingActions.delete(ref);
        reject(new AgentError('TIMEOUT', `No answer from the server for ${type} in seat ${seat}.`));
      }, timeoutMs);
      this.pendingRefs.set(ref, {
        timer, reject,
        resolve: (budget) => resolve({ type, seat, budget }),
      });
      if (!this.sendRaw({ action: 'campaign', type, seat, clientRef: ref })) {
        clearTimeout(timer);
        this.pendingRefs.delete(ref);
        this.state.pendingActions.delete(ref);
        reject(new AgentError('NO_CONNECTION', 'The live connection is down.'));
      }
    });
  }

  /** Send many campaign actions at once (the server processes a connection's messages in order). Results in input order. */
  async campaignBatch(list: { type: ActionType; seat: SeatId }[]): Promise<({ ok: true; budget: number } | { ok: false; error: AgentError })[]> {
    const settled = await Promise.allSettled(list.map((a) => this.campaign(a.type, a.seat)));
    return settled.map((r) => (r.status === 'fulfilled'
      ? { ok: true as const, budget: r.value.budget }
      : { ok: false as const, error: r.reason instanceof AgentError ? r.reason : new AgentError('INTERNAL', String(r.reason)) }));
  }

  // ------------------------------------------------------------------ one-at-a-time requests (no clientRef on the wire)
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Send a message that has no clientRef and wait for its outcome. A ping sent right behind it acts as a barrier:
   * the server handles a connection's messages in order, so once that pong arrives every reply to our message was sent.
   */
  private request<T>(msg: ClientMessage, match: (m: ServerMessage) => T | undefined, opts: { silentOk?: T; timeoutMs?: number } = {}): Promise<T> {
    return this.exclusive(async () => {
      this.requireOpen();
      const collector: Collector = { errors: [], matched: undefined, match: match as (m: ServerMessage) => unknown };
      this.collector = collector;
      try {
        const marker = Date.now() + ((++this.barrierSeq % 900) + 1) / 1000;
        const timeoutMs = opts.timeoutMs ?? 10_000;
        const barrier = new Promise<void>((resolve) => this.barriers.set(marker, resolve));
        this.sendRaw(msg);
        this.sendRaw({ action: 'ping', clientTime: marker });
        const timedOut = await Promise.race([barrier.then(() => false), sleep(timeoutMs).then(() => true)]);
        if (timedOut) { this.barriers.delete(marker); throw new AgentError('TIMEOUT', 'The server did not answer in time.'); }
        // out-of-order delivery on some transports: give a late confirmation a moment
        for (let i = 0; i < 20 && collector.matched === undefined && collector.errors.length === 0; i++) await sleep(50);
        if (collector.errors.length) {
          const e = collector.errors[0];
          throw new AgentError(e.error, e.message);
        }
        if (collector.matched !== undefined) return collector.matched as T;
        if (opts.silentOk !== undefined) return opts.silentOk;
        throw new AgentError('NO_CONFIRMATION', 'The server did not confirm the action.');
      } finally {
        this.collector = null;
      }
    });
  }

  async buyReport(scope: ReportScope, seat?: SeatId): Promise<{ report: AnalystReport; budget: number }> {
    return this.request<{ report: AnalystReport; budget: number }>(
      { action: 'buyReport', scope, ...(seat !== undefined ? { seat } : {}) },
      (m) => (m.type === 'report' ? { report: m.report, budget: m.budget } : undefined),
    );
  }

  async chat(to: PlayerId[], text: string): Promise<ChatMessage> {
    const me = this.state.me;
    return this.request<ChatMessage>({ action: 'chat', to, text },
      (m) => (m.type === 'chat' && m.message.from === me && m.message.text.trim() === text.trim() ? m.message : undefined));
  }

  async proposeGovernment(portfolios: PortfolioAssignment, partners?: PlayerId[]): Promise<CoalitionOffer> {
    const me = this.state.me;
    const known = new Set((this.state.snapshot?.offers ?? []).map((o) => o.offerId));
    return this.request<CoalitionOffer>({ action: 'proposeGovernment', portfolios, ...(partners ? { partners } : {}) },
      (m) => (m.type === 'offer' && m.offer.proposer === me && !known.has(m.offer.offerId) ? m.offer : undefined));
  }

  async respondOffer(offerId: string, accept: boolean): Promise<CoalitionOffer | null> {
    return this.request<CoalitionOffer | null>({ action: 'respondOffer', offerId, accept },
      (m) => (m.type === 'offer' && m.offer.offerId === offerId ? m.offer : undefined), { silentOk: null });
  }

  async withdrawOffer(offerId: string): Promise<CoalitionOffer> {
    return this.request<CoalitionOffer>({ action: 'withdrawOffer', offerId },
      (m) => (m.type === 'offer' && m.offer.offerId === offerId ? m.offer : undefined));
  }

  // ------------------------------------------------------------------ waiting
  waitForEvents(since: number, timeoutMs: number, types?: readonly EventType[], limit?: number): Promise<WaitResult> {
    return this.events.wait(since, timeoutMs, { types, limit });
  }

  /** Waits until the host admits (or declines) us; falls back to polling REST in case a websocket message was missed. */
  async waitForAdmission(timeoutMs: number): Promise<'admitted' | 'declined' | 'pending'> {
    const deadline = Date.now() + timeoutMs;
    let lastPoll = 0;
    for (;;) {
      const a = this.admission;
      if (a === 'admitted') return 'admitted';
      if (a === 'declined') return 'declined';
      if (Date.now() - lastPoll > 1500) {
        lastPoll = Date.now();
        try { await this.refreshLobby(); } catch (e) { if (e instanceof AgentError && (e.code === 'UNAUTHORIZED' || e.code === 'NOT_FOUND')) throw e; }
        const mine = this.state.lobby?.players.find((p) => p.playerId === this.state.me);
        if (mine && mine.status !== 'pending') return mine.status === 'rejected' ? 'declined' : 'admitted';
      }
      if (Date.now() >= deadline) return 'pending';
      await this.events.wait(this.events.cursor, Math.min(1000, Math.max(50, deadline - Date.now())), { types: ['players', 'status'] });
    }
  }

  // ------------------------------------------------------------------ shutdown
  /** Close the socket and stop reconnecting. After the 90 s grace period the server eliminates a disconnected player. */
  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.failPending(new AgentError('NO_CONNECTION', 'The client was closed.'));
    const ws = this.ws;
    this.ws = null;
    this.state.link = 'closed';
    try { ws?.close(); } catch { /* ignore */ }
    for (const w of this.helloWaiters) w();
    this.helloWaiters = [];
  }

  /** Forget the session (after leave_game). */
  reset(): void {
    this.close();
    this.session = null;
    Object.assign(this.state, newState());
  }
}
