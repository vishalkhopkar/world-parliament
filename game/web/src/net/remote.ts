// Real transport: REST (fetch) for the lobby + one WebSocket for the live game.
// - Bearer token on every call except create/join.
// - The server sends `hello` only in reply to the client's FIRST message, so we ping as soon as the socket opens
//   (and on every reconnect). Periodic pings keep the connection alive and refresh the server-clock offset (pong).
// - Automatic reconnect with the same token (the server restores the player within its grace period).
import type {
  AdmissionRequest, AdmitRequest, ApiError, ClientMessage, CreateGameRequest, CreateGameResponse, GameId,
  JoinGameRequest, JoinGameResponse, LobbyView, PartyRequest, ServerMessage, SettingsRequest, StartResponse,
} from '@hp/shared';
import { ApiException, type LinkState, type Transport } from './transport';

export interface RemoteOptions { apiUrl: string; wsUrl: string }

const PING_MS = 15_000;
const BACKOFF_MS = [300, 600, 1200, 2500, 5000, 8000];
/** Stop retrying after this long without a working connection (the server's grace period is 90 s). */
const GIVE_UP_MS = 150_000;

export class RemoteTransport implements Transport {
  private readonly api: string;
  private readonly ws: string;
  private sock: WebSocket | null = null;
  private gen = 0; // bumps on every connect()/disconnect(); events of older sockets are ignored
  private timers: { retry?: ReturnType<typeof setTimeout>; ping?: ReturnType<typeof setInterval> } = {};
  private session: { gameId: GameId; token: string; onMessage: (m: ServerMessage) => void; onState?: (s: LinkState) => void } | null = null;
  private failures = 0;
  private downSince = 0;
  private queue: ClientMessage[] = []; // messages sent while (re)connecting (pings are never queued)

  constructor(opts: RemoteOptions) {
    this.api = opts.apiUrl.replace(/\/+$/, '');
    this.ws = opts.wsUrl.replace(/\/+$/, '');
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

  // ------------------------------------------------------------------ WebSocket
  connect(gameId: GameId, token: string, onMessage: (m: ServerMessage) => void, onState?: (s: LinkState) => void) {
    this.disconnect();
    this.session = { gameId, token, onMessage, onState };
    this.failures = 0;
    this.downSince = 0;
    this.open();
  }

  private state(s: LinkState) { this.session?.onState?.(s); }

  private open() {
    const s = this.session;
    if (!s) return;
    const gen = ++this.gen;
    this.state('connecting');
    const url = `${this.ws}?gameId=${encodeURIComponent(s.gameId)}&token=${encodeURIComponent(s.token)}`;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { this.scheduleRetry(gen); return; }
    this.sock = ws;
    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.rawSend({ action: 'ping', clientTime: Date.now() }); // triggers `hello`
    };
    ws.onmessage = ev => {
      if (gen !== this.gen) return;
      let m: ServerMessage;
      try { m = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
      if (m.type === 'hello') {
        this.failures = 0; this.downSince = 0;
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
      this.stopPing();
      this.sock = null;
      if (ev.code === 1008) { this.giveUp('Your request to join was declined.'); return; } // the server closes rejected players with 1008
      this.scheduleRetry(gen);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private startPing(gen: number) {
    this.stopPing();
    this.timers.ping = setInterval(() => { if (gen === this.gen) this.rawSend({ action: 'ping', clientTime: Date.now() }); }, PING_MS);
  }
  private stopPing() { if (this.timers.ping) clearInterval(this.timers.ping); this.timers.ping = undefined; }

  private scheduleRetry(gen: number) {
    const s = this.session;
    if (!s || gen !== this.gen) return;
    if (!this.downSince) this.downSince = Date.now();
    this.failures++;
    this.state('connecting');
    if (Date.now() - this.downSince > GIVE_UP_MS) { this.giveUp('Connection to the game server was lost.'); return; }
    const wait = BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)] + Math.random() * 200;
    this.timers.retry = setTimeout(() => {
      if (gen !== this.gen) return;
      // a socket that never opens can mean "declined" or "game gone" (the upgrade is refused): check over REST
      if (this.failures >= 2) {
        void this.probe().then(fatal => { if (gen !== this.gen) return; if (fatal) this.giveUp(fatal); else this.open(); });
      } else this.open();
    }, wait);
  }

  /** Returns an error text if the session can never work again (declined / unknown game / bad token). */
  private async probe(): Promise<string | null> {
    const s = this.session;
    if (!s) return null;
    try {
      const lobby = await this.getLobby(s.gameId, s.token);
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
    this.stopPing();
    if (this.timers.retry) clearTimeout(this.timers.retry);
    this.timers.retry = undefined;
    const ws = this.sock;
    this.sock = null;
    this.session = null;
    this.queue = [];
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch { /* ignore */ } }
  }
}
