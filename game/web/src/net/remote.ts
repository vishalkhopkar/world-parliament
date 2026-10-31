// Real transport: REST (fetch) for the lobby + one WebSocket for the live game.
// - Bearer token on every call except create/join.
// - The server sends `hello` only in reply to the client's FIRST message, so we ping as soon as the socket opens
//   (and on every reconnect). Periodic pings keep the connection alive and refresh the server-clock offset (pong).
// - Automatic reconnect with the same token (the server restores the player within its grace period).
// - Phones: a backgrounded tab / browser app freezes timers and often leaves a socket that still says OPEN but is dead.
//   So we (a) probe the socket whenever the page comes back (visibilitychange / pageshow / focus) and reconnect at
//   once if nothing answers, (b) reconnect at once on `online`, (c) treat 2 silent ping intervals as a dead socket, and
//   (d) restart the give-up clock on every resume, so time spent asleep never counts as "server unreachable".
import { WORLD_CONFIG } from '@hp/shared';
import type {
  AdmissionRequest, AdmitRequest, ApiError, ClientMessage, CreateGameRequest, CreateGameResponse, GameId,
  JoinGameRequest, JoinGameResponse, LobbyView, PartyRequest, RematchRequest, RematchResponse, ServerMessage, SettingsRequest, StartResponse,
} from '@hp/shared';
import { ApiException, type LinkState, type Transport } from './transport';

/** `retryMs`: wait between automatic reconnect attempts (default: connection.retryMs from game.properties). */
export interface RemoteOptions { apiUrl: string; wsUrl: string; retryMs?: number }

const PING_MS = 15_000;
/** After the page returns, how long the server gets to answer our probe ping before the socket is declared dead. */
const PROBE_MS = 3_000;
/** A socket that has not delivered the server's `hello` this long after we started connecting is abandoned (a mobile network can
 *  leave a socket CONNECTING for minutes, or the first ping / hello can be lost): never wait forever on one attempt. */
const HELLO_MS = 8_000;

export class RemoteTransport implements Transport {
  private readonly api: string;
  private readonly ws: string;
  private readonly retryMs: number;
  private sock: WebSocket | null = null;
  private gen = 0; // bumps on every connect()/disconnect(); events of older sockets are ignored
  private timers: { retry?: ReturnType<typeof setTimeout>; ping?: ReturnType<typeof setInterval>; probe?: ReturnType<typeof setTimeout>; hello?: ReturnType<typeof setTimeout>; watchdog?: ReturnType<typeof setInterval> } = {};
  private lastRx = 0; // time of the last frame received from the server
  private session: { gameId: GameId; token: string; onMessage: (m: ServerMessage) => void; onState?: (s: LinkState) => void } | null = null;
  private failures = 0;
  private attemptAt = 0; // when the current connection attempt started
  private link: LinkState = 'connecting';
  private queue: ClientMessage[] = []; // messages sent while (re)connecting (pings are never queued)

  constructor(opts: RemoteOptions) {
    this.api = opts.apiUrl.replace(/\/+$/, '');
    this.ws = opts.wsUrl.replace(/\/+$/, '');
    this.retryMs = Math.max(1000, opts.retryMs ?? WORLD_CONFIG.connection.retryMs);
  }

  // ------------------------------------------------------------------ REST
  private async rest<T>(method: 'GET' | 'POST', path: string, token?: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.api + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiException('INTERNAL', 'Cannot reach the game server. Check your connection and try again.');
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
    if (!res.ok) {
      const e = json as Partial<ApiError> | undefined;
      throw new ApiException(e?.error ?? (res.status === 404 ? 'NOT_FOUND' : 'INTERNAL'), e?.message ?? `Server error (${res.status})`);
    }
    return json as T;
  }
  private game = (id: GameId) => `/games/${encodeURIComponent(id)}`;

  createGame(req: CreateGameRequest) { return this.rest<CreateGameResponse>('POST', '/games', undefined, req); }
  joinGame(req: JoinGameRequest) { return this.rest<JoinGameResponse>('POST', '/games/join', undefined, req); }
  getLobby(id: GameId, token: string) { return this.rest<LobbyView>('GET', this.game(id), token); }
  async admit(id: GameId, token: string, req: AdmitRequest) { await this.rest('POST', this.game(id) + '/admit', token, req); }
  async setAdmission(id: GameId, token: string, req: AdmissionRequest) { await this.rest('POST', this.game(id) + '/admission', token, req); }
  async setSettings(id: GameId, token: string, req: SettingsRequest) { await this.rest('POST', this.game(id) + '/settings', token, req); }
  async setParty(id: GameId, token: string, req: PartyRequest) { await this.rest('POST', this.game(id) + '/party', token, req); }
  start(id: GameId, token: string) { return this.rest<StartResponse>('POST', this.game(id) + '/start', token, {}); }

  rematch(id: GameId, token: string, req: RematchRequest) { return this.rest<RematchResponse>('POST', this.game(id) + '/rematch', token, req); }

  // ------------------------------------------------------------------ WebSocket
  connect(gameId: GameId, token: string, onMessage: (m: ServerMessage) => void, onState?: (s: LinkState) => void) {
    this.disconnect();
    this.session = { gameId, token, onMessage, onState };
    this.failures = 0;
    this.listen(true);
    this.startWatchdog();
    this.open();
  }

  /**
   * Safety net independent of the retry chain: if the link is not up and the current attempt has been running far longer than
   * a normal attempt (handshake timeout + wait), something stalled (frozen timers, lost callback): start over.
   */
  private startWatchdog() {
    if (this.timers.watchdog) return;
    this.timers.watchdog = setInterval(() => {
      if (!this.session || this.link === 'open') return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (Date.now() - this.attemptAt > HELLO_MS + 2 * this.retryMs) this.reconnectNow();
    }, this.retryMs);
  }
  private stopWatchdog() { if (this.timers.watchdog) clearInterval(this.timers.watchdog); this.timers.watchdog = undefined; }

  // ---- phone lifecycle: come back from background / network change
  private readonly onVisible = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') this.resume(); };
  private readonly onOnline = () => { if (this.session) this.reconnectNow(); };
  private listen(on: boolean) {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const op = on ? 'addEventListener' : 'removeEventListener';
    document[op]('visibilitychange', this.onVisible);
    document[op]('resume', this.onVisible); // Chrome (Android) page-lifecycle: fired when a frozen tab thaws
    window[op]('pageshow', this.onVisible);
    window[op]('focus', this.onVisible);
    window[op]('online', this.onOnline);
  }

  /** The page is visible again: verify the socket is really alive, otherwise reconnect right away. */
  private resume() {
    if (!this.session) return;
    const ws = this.sock;
    if (!ws || ws.readyState !== WebSocket.OPEN) { this.reconnectNow(); return; }
    const sentAt = Date.now();
    this.rawSend({ action: 'ping', clientTime: sentAt });
    if (this.timers.probe) clearTimeout(this.timers.probe);
    this.timers.probe = setTimeout(() => {
      this.timers.probe = undefined;
      if (this.sock === ws && this.lastRx < sentAt) this.reconnectNow(); // nothing came back: half-open socket
    }, PROBE_MS);
  }

  /** Public: the user pressed "Reconnect now" (also works after the transport gave up). */
  reconnect() { this.reconnectNow(); }

  private clearHelloTimer() { if (this.timers.hello) clearTimeout(this.timers.hello); this.timers.hello = undefined; }

  /** Drop whatever socket / retry state we have and open a fresh connection immediately (backoff and give-up reset). */
  private reconnectNow() {
    if (!this.session) return;
    if (this.timers.retry) { clearTimeout(this.timers.retry); this.timers.retry = undefined; }
    if (this.timers.probe) { clearTimeout(this.timers.probe); this.timers.probe = undefined; }
    this.clearHelloTimer();
    this.stopPing();
    const old = this.sock;
    this.sock = null;
    if (old) { old.onopen = old.onmessage = old.onclose = old.onerror = null; try { old.close(); } catch { /* ignore */ } }
    this.failures = 0;
    this.startWatchdog();
    this.open();
  }

  private state(s: LinkState) { this.link = s; this.session?.onState?.(s); }

  private open() {
    const s = this.session;
    if (!s) return;
    const gen = ++this.gen;
    this.attemptAt = Date.now();
    this.state('connecting');
    const url = `${this.ws}?gameId=${encodeURIComponent(s.gameId)}&token=${encodeURIComponent(s.token)}`;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { this.scheduleRetry(gen); return; }
    this.sock = ws;
    this.clearHelloTimer();
    this.timers.hello = setTimeout(() => {
      this.timers.hello = undefined;
      if (gen !== this.gen || this.sock !== ws) return;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch { /* ignore */ }
      this.sock = null;
      this.stopPing();
      this.scheduleRetry(gen);
    }, HELLO_MS);
    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.rawSend({ action: 'ping', clientTime: Date.now() }); // triggers `hello`
    };
    ws.onmessage = ev => {
      if (gen !== this.gen) return;
      this.lastRx = Date.now();
      let m: ServerMessage;
      try { m = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
      if (m.type === 'hello') {
        this.clearHelloTimer();
        this.failures = 0;
        this.state('open');
        this.startPing(gen);
        // deliver hello first (it replaces the snapshot), then flush what the user did while offline
        s.onMessage(m);
        const q = this.queue; this.queue = [];
        for (const c of q) this.rawSend(c);
        return;
      }
      s.onMessage(m);
    };
    ws.onclose = ev => {
      if (gen !== this.gen) return;
      this.clearHelloTimer();
      this.stopPing();
      this.sock = null;
      if (ev.code === 1008) { this.giveUp('Your request to join was declined.'); return; } // the server closes rejected players with 1008
      this.scheduleRetry(gen);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private startPing(gen: number) {
    this.stopPing();
    this.lastRx = Date.now();
    this.timers.ping = setInterval(() => {
      if (gen !== this.gen) return;
      // hidden tabs have frozen / throttled timers and sockets: judge them when the page returns (resume()), not now
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (!hidden && Date.now() - this.lastRx > PING_MS * 2) { this.reconnectNow(); return; }
      this.rawSend({ action: 'ping', clientTime: Date.now() });
    }, PING_MS);
  }
  private stopPing() { if (this.timers.ping) clearInterval(this.timers.ping); this.timers.ping = undefined; }

  private scheduleRetry(gen: number) {
    const s = this.session;
    if (!s || gen !== this.gen) return;
    this.failures++;
    this.state('connecting');
    // a steady beat (connection.retryMs, +0..10 % jitter), never a growing backoff and no time-based give-up: a phone that was
    // away or offline for minutes must reconnect by itself. Only "declined" / "game gone" (checked below) are final.
    const wait = this.retryMs * (1 + Math.random() * 0.1);
    this.timers.retry = setTimeout(() => {
      this.timers.retry = undefined;
      if (gen !== this.gen) return;
      // hidden page: do not retry in the background; resume() reconnects the moment the page is shown again
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      // a socket that never opens can mean "declined" or "game gone" (the upgrade is refused): check over REST, but IN
      // PARALLEL with the next attempt and with a timeout - a hanging fetch on a bad network must never stall reconnecting
      if (this.failures >= 2) {
        const session = this.session;
        void this.probe().then(fatal => { if (fatal && this.session === session) this.giveUp(fatal); });
      }
      this.open();
    }, wait);
  }

  /** Returns an error text if the session can never work again (declined / unknown game / bad token). */
  private async probe(): Promise<string | null> {
    const s = this.session;
    if (!s) return null;
    try {
      const lobby = await Promise.race([
        this.getLobby(s.gameId, s.token),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 5_000)),
      ]);
      const me = lobby.players.find(p => p.playerId === lobby.you);
      return me?.status === 'rejected' ? 'Your request to join was declined.' : null;
    } catch (e) {
      if (e instanceof ApiException && (e.code === 'UNAUTHORIZED' || e.code === 'NOT_FOUND')) return 'This game is no longer available.';
      return null;
    }
  }

  private giveUp(message: string) {
    const s = this.session;
    this.gen++;
    this.stopPing();
    this.stopWatchdog();
    this.clearHelloTimer();
    if (this.timers.retry) clearTimeout(this.timers.retry);
    this.sock = null;
    if (!s) return;
    s.onState?.('down');
    s.onMessage({ type: 'error', error: 'FORBIDDEN', message });
  }

  private rawSend(msg: ClientMessage) {
    if (this.sock && this.sock.readyState === WebSocket.OPEN) this.sock.send(JSON.stringify(msg));
  }

  send(msg: ClientMessage) {
    if (msg.action === 'ping') { this.rawSend(msg); return; }
    if (this.sock && this.sock.readyState === WebSocket.OPEN) { this.rawSend(msg); return; }
    // not connected right now: keep a short queue so a click during a blip is not lost
    this.queue.push(msg);
    if (this.queue.length > 20) this.queue.shift();
  }

  disconnect() {
    this.gen++;
    this.listen(false);
    this.stopWatchdog();
    this.stopPing();
    this.clearHelloTimer();
    if (this.timers.retry) clearTimeout(this.timers.retry);
    this.timers.retry = undefined;
    if (this.timers.probe) clearTimeout(this.timers.probe);
    this.timers.probe = undefined;
    const ws = this.sock;
    this.sock = null;
    this.session = null;
    this.queue = [];
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch { /* ignore */ } }
  }
}
