// GameClient: REST + one WebSocket for ONE AI player. Mirrors what the browser client does, nothing more.
// There is deliberately NO createGame method: an AI agent can only join games created by humans.
import type {
  ActionType, AnalystReport, ChatMessage, ClientMessage, CoalitionOffer, ErrorCode, GlobalReports, JoinGameRequest, JoinGameResponse,
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
  /** Max campaign messages in flight at once inside campaign_batch (default 6, env HP_BATCH_CONCURRENCY). */
  batchConcurrency?: number;
  /** How long one campaign message may wait for its ack, counted from the moment it is sent (default 30 s, env HP_ACTION_TIMEOUT_MS). */
  actionTimeoutMs?: number;
}

export const DEFAULT_BATCH_CONCURRENCY = 6;
export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const envInt = (name: string): number | undefined => {
  const n = Number(typeof process !== 'undefined' ? process.env[name] : undefined);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export type BatchOutcome = { ok: true; budget: number } | { ok: false; error: AgentError; /** true = the server may or may not have applied it */ unknown?: boolean };

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

  /** REST base. Replaced once by discover() when HP_SERVER is a site URL that publishes /config.json. */
  server: string;
  wsUrl: string;
  private readonly wsGiven: boolean;
  private discovering: Promise<void> | null = null;
  private readonly log: (m: string) => void;
  private readonly pingMs: number;
  private readonly reconnectBaseMs: number;
  private readonly fetchImpl: typeof fetch;

  /** Called whenever the session changed under us (a rematch moved us to the new game), so the owner can persist it. */
  onSession?: (s: Session) => void;

  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closedByUs = false;
  private helloWaiters: (() => void)[] = [];
  private everHello = false;
  private refCounter = 0;
  /** Random per-client prefix: clientRefs are unique per player on the server (idempotency key), so a restarted agent must never reuse "a1". */
  private readonly refPrefix = Math.random().toString(36).slice(2, 7);
  private readonly batchConcurrency: number;
  private readonly actionTimeoutMs: number;
  private pendingRefs = new Map<string, { resolve: (budget: number) => void; reject: (e: AgentError) => void; timer: ReturnType<typeof setTimeout> }>();
  private barriers = new Map<number, () => void>();
  private barrierSeq = 0;
  private collector: Collector | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: ClientOptions = {}) {
    this.server = (opts.server ?? 'http://localhost:8787').replace(/\/+$/, '');
    this.wsUrl = (opts.ws ?? defaultWsFor(this.server)).replace(/\/+$/, '');
    this.wsGiven = !!opts.ws;
    this.log = opts.log ?? (() => undefined);
    this.pingMs = opts.pingMs ?? 15_000;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 500;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.batchConcurrency = Math.max(1, opts.batchConcurrency ?? envInt('HP_BATCH_CONCURRENCY') ?? DEFAULT_BATCH_CONCURRENCY);
    this.actionTimeoutMs = opts.actionTimeoutMs ?? envInt('HP_ACTION_TIMEOUT_MS') ?? DEFAULT_ACTION_TIMEOUT_MS;
  }

  /** The server applies a campaign message carrying a clientRef at most once (advertised in `hello.features`). */
  get serverDedupesActions(): boolean { return this.state.features.includes('actionRef'); }

  // ------------------------------------------------------------------ clock
  /** Estimated server epoch ms right now. */
  serverNow(): number { return Date.now() + this.state.serverOffsetMs; }

  get me(): PlayerId | null { return this.state.me; }
  get admission(): Admission { return admissionOf(this.state); }

  // ------------------------------------------------------------------ endpoint discovery
  /**
   * The deployed site (CloudFront) serves only static files; the REST API and the WebSocket live on API Gateway hosts. The deploy
   * publishes `<site>/config.json` = {apiUrl, wsUrl}; when `server` is such a site this switches to those endpoints, so
   * `HP_SERVER=https://dxxxx.cloudfront.net` is all an agent needs. Skipped for localhost and when a ws URL was given explicitly;
   * any failure (404, the SPA's index.html, bad JSON, offline) keeps the URL as given. Looked up at most once.
   */
  discover(): Promise<void> {
    return (this.discovering ??= this.doDiscover());
  }

  private async doDiscover(): Promise<void> {
    if (this.wsGiven) return;
    let host = '';
    try { host = new URL(this.server).hostname; } catch { return; }
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return;
    try {
      const res = await this.fetchImpl(this.server + '/config.json', { method: 'GET', signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const j = JSON.parse(await res.text()) as { apiUrl?: unknown; wsUrl?: unknown };
      if (typeof j.apiUrl !== 'string' || typeof j.wsUrl !== 'string') return;
      if (!/^https?:\/\//i.test(j.apiUrl) || !/^wss?:\/\//i.test(j.wsUrl)) return;
      this.server = j.apiUrl.replace(/\/+$/, '');
      this.wsUrl = j.wsUrl.replace(/\/+$/, '');
      this.log(`endpoints from ${host}/config.json: ${this.server} , ${this.wsUrl}`);
    } catch { /* keep the URL as given */ }
  }

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
    await this.discover();
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
    await this.discover();
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
    for (let hop = 0; ; hop++) {
      const s = this.requireSession();
      const v = await this.rest<LobbyView>('GET', '/games/' + encodeURIComponent(s.gameId));
      // The host played again and we missed the push: follow the new game (same player id and token).
      if (v.nextGameId && v.nextGameId !== s.gameId && hop < 5 && !this.closedByUs) {
        this.followRematch(v.nextGameId, v.nextJoinCode ?? '');
        continue;
      }
      this.state.lobby = v;
      this.state.joinCode = v.joinCode;
      return v;
    }
  }

  /**
   * The host played again. Move this player to the new game: same playerId and token, new gameId + joinCode; the new game is
   * already in the campaign with our party. Per-game state is dropped (the event log, clock offset, features and nickname stay),
   * the old socket is closed and a new one is opened (its hello arrives after our first ping, as always). Idempotent per game id.
   */
  private followRematch(gameId: string, joinCode: string): boolean {
    const s = this.session;
    if (!s || gameId === s.gameId) return false;
    for (const l of applyMessage(this.state, { type: 'rematch', gameId, joinCode }, Date.now())) this.events.push(l.type, l.data, this.serverNow());
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.failPending(new AgentError('NO_CONNECTION', 'The host played again; this action belonged to the previous game.'));
    const old = this.ws;
    this.ws = null; // so the old socket's onclose is ignored
    try { old?.close(); } catch { /* ignore */ }
    this.session = { ...s, gameId, joinCode: joinCode || undefined };
    const st = this.state;
    st.snapshot = null; st.priv = null; st.chat = []; st.polledPhases = new Set(); st.pendingActions.clear();
    st.budgetPending = false; st.globalReports = null; st.lobby = null;
    this.attachSession();
    this.log(`rematch: moved to game ${gameId}`);
    try { this.onSession?.(this.session); } catch { /* ignore */ }
    this.openSocket(this.session);
    return true;
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
    // An abandoned game never comes back. A FINISHED game may get a rematch: keep a (slower) live link / REST check going.
    if (this.state.snapshot?.status === 'abandoned') { this.state.link = 'closed'; return; }
    const finished = this.state.snapshot?.status === 'finished';
    const delay = Math.min(10_000, this.reconnectBaseMs * 2 ** Math.min(this.attempts, 5)) + Math.floor(Math.random() * 200)
      + (finished ? Math.min(5000, this.reconnectBaseMs * 10) : 0);
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
    if (m.type === 'rematch') {
      if (m.gameId !== this.session?.gameId) this.followRematch(m.gameId, m.joinCode);
      return;
    }
    if (m.type === 'hello') {
      if (m.snapshot.nextGameId && m.snapshot.nextGameId !== this.session?.gameId && this.followRematch(m.snapshot.nextGameId, m.snapshot.nextJoinCode ?? '')) return;
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
  /**
   * Send a campaign action; resolves with the new budget when the server acks (matched by clientRef). Pipelined.
   * `ref` lets a caller resend the SAME logical action (a retry after TIMEOUT); only do that when serverDedupesActions.
   */
  campaign(type: ActionType, seat: SeatId, timeoutMs = this.actionTimeoutMs, ref: string = `${this.refPrefix}${++this.refCounter}`): Promise<CampaignResult> {
    try { this.requireOpen(); } catch (e) { return Promise.reject(e); }
    this.state.pendingActions.set(ref, { type, seat });
    return new Promise<CampaignResult>((resolve, reject) => {
      // On timeout the pendingActions entry is KEPT: the server may still apply the action and ack late, and that late ack
      // must still extend myActions (applyMessage consumes the entry).
      const timer = setTimeout(() => {
        this.pendingRefs.delete(ref);
        reject(new AgentError('TIMEOUT', `No answer from the server for ${type} in seat ${seat}.`,
          'The server may still have applied it (check budget / my_actions in get_state before resending; a resend can double-charge, a rally especially).'));
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

  /**
   * Send many campaign actions with at most `batchConcurrency` in flight (API Gateway runs every WebSocket message in its own
   * Lambda, in no particular order, all contending on one DynamoDB item: 50 at once made most of them time out). Results in input order.
   * A TIMEOUT means "unknown outcome". If the server advertises actionRef (idempotent clientRef) a timed-out action is resent ONCE
   * with the same clientRef after the pass (safe: the server charges it at most once); otherwise it is never resent.
   */
  async campaignBatch(list: { type: ActionType; seat: SeatId }[]): Promise<BatchOutcome[]> {
    const out: BatchOutcome[] = new Array(list.length);
    const refs = list.map(() => `${this.refPrefix}${++this.refCounter}`);
    const toOutcome = (r: PromiseSettledResult<CampaignResult>): BatchOutcome => {
      if (r.status === 'fulfilled') return { ok: true, budget: r.value.budget };
      const error = r.reason instanceof AgentError ? r.reason : new AgentError('INTERNAL', String(r.reason));
      return { ok: false, error, ...(error.code === 'TIMEOUT' ? { unknown: true } : {}) };
    };
    const pool = async (indexes: number[]) => {
      let next = 0;
      const worker = async () => {
        while (next < indexes.length) {
          const k = indexes[next++];
          const settled = await this.campaign(list[k].type, list[k].seat, this.actionTimeoutMs, refs[k]).then(
            (value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);
          out[k] = toOutcome(settled);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.batchConcurrency, indexes.length) }, worker));
    };
    await pool(list.map((_, k) => k));
    if (this.serverDedupesActions) {
      const retry = out.map((o, k) => (!o.ok && o.unknown ? k : -1)).filter((k) => k >= 0);
      if (retry.length) await pool(retry);
    }
    return out;
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

  /** Free news-agency projections (no budget cost); the server answers the requester only. */
  async globalReports(): Promise<GlobalReports> {
    return this.request<GlobalReports>({ action: 'globalReports' }, (m) => (m.type === 'globalReports' ? m.reports : undefined));
  }

  async chat(to: PlayerId[] | undefined, text: string): Promise<ChatMessage> {
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
