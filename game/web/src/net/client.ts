// Action layer used by the UI. Same operations the real backend exposes.
// Transport selection (see .env.example):
//   ?mock                      -> in-browser mock (bots), always
//   ?server=local              -> http://<page host>:8787 + ws://<page host>:8787/ws (npm run dev in game/server)
//   ?server=http(s)://host:port -> that server (ws URL derived: same host, /ws)
//   VITE_API_URL (+VITE_WS_URL) -> real deployment
//   otherwise                  -> mock
import type { ActionType, GameSnapshot, PartyIdentity, PlayerId, PortfolioAssignment, ReportScope, SeatId, ServerMessage } from '@hp/shared';
import { useStore } from '../state/store';
import { ApiException, type Transport } from './transport';
import { MockTransport } from './mock';
import { RemoteTransport } from './remote';

const query = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

function toWs(httpUrl: string): string { return httpUrl.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws'; }

function remoteConfig(): { apiUrl: string; wsUrl: string } | null {
  if (query.has('mock')) return null;
  const server = query.get('server');
  if (server === 'local') {
    const host = typeof location !== 'undefined' && location.hostname ? location.hostname : 'localhost';
    return { apiUrl: `http://${host}:8787`, wsUrl: `ws://${host}:8787/ws` };
  }
  if (server && /^https?:\/\//i.test(server)) return { apiUrl: server.replace(/\/+$/, ''), wsUrl: toWs(server) };
  const api = (env.VITE_API_URL ?? '').trim();
  if (api) return { apiUrl: api, wsUrl: (env.VITE_WS_URL ?? '').trim() || toWs(api) };
  return null;
}

const cfg = remoteConfig();
/** true when talking to a real backend (false = in-browser mock) */
export const isRemote = cfg !== null;
export let transport: Transport = cfg ? new RemoteTransport(cfg) : new MockTransport();
/** Plug-in point (tests can swap the transport). */
export function setTransport(t: Transport) { transport = t; }

const st = () => useStore.getState();

// ---------------------------------------------------------------- session persistence (remote only)
interface SavedSession { gameId: string; playerId: PlayerId; token: string; joinCode: string }
const STORE_KEY = 'hp.session' + (query.get('as') ? ':' + query.get('as') : '');
function saveSession(s: SavedSession | null) {
  if (!isRemote) return;
  try { if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s)); else localStorage.removeItem(STORE_KEY); } catch { /* storage unavailable */ }
}
function loadSession(): SavedSession | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<SavedSession> | null;
    return v && v.gameId && v.playerId && v.token ? { gameId: v.gameId, playerId: v.playerId, token: v.token, joinCode: v.joinCode ?? '' } : null;
  } catch { return null; }
}

async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); }
  catch (e) {
    const msg = e instanceof ApiException ? e.message : e instanceof Error ? e.message : String(e);
    st().setError(msg);
    return undefined;
  }
}

function session() {
  const { gameId, token } = st();
  if (!gameId || !token) throw new ApiException('UNAUTHORIZED', 'Not in a game');
  return { gameId, token };
}

// ---------------------------------------------------------------- self-heal for missed seat declarations
// Every seatUpdate carries the running tally. If frames were lost (a throttled push), the tally says more seats are declared
// than the map holds. A reconnect makes the server send a fresh `hello` with every declaration, so resync when the gap persists.
const GAP_CHECK_MS = 4_000;
const GAP_COOLDOWN_MS = 20_000;
let gapTimer: ReturnType<typeof setTimeout> | undefined;
let lastResync = -Infinity;

/** true when the tally claims more declared (won) seats than this client holds. */
export function countingGap(snap: GameSnapshot): boolean {
  if (!snap.tally) return false;
  const won = Object.values(snap.seats).filter(d => d.status === 'won').length;
  return snap.tally.declared > won;
}

function scheduleGapCheck() {
  if (!isRemote || gapTimer) return;
  gapTimer = setTimeout(() => {
    gapTimer = undefined;
    const snap = st().snapshot;
    if (!snap || !countingGap(snap)) return;
    if (Date.now() - lastResync < GAP_COOLDOWN_MS) return;
    lastResync = Date.now();
    reconnect();
  }, GAP_CHECK_MS);
}

export function onServerMessage(m: ServerMessage) {
  st().applyServer(m);
  if (m.type === 'seatUpdate' || m.type === 'status') scheduleGapCheck();
  // being declined: the server reports our own status as 'rejected' (then closes the socket)
  if (m.type === 'players') {
    const me = st().me;
    if (me && m.players.some(p => p.playerId === me && p.status === 'rejected')) leaveGame('The admin declined your request to join.');
  } else if (m.type === 'error' && /declined|no longer available/.test(m.message)) {
    leaveGame(m.message); // the transport gave up for good (declined / game gone)
  }
}

function openSocket(gameId: string, token: string) {
  st().setLink(isRemote ? 'connecting' : 'open');
  transport.connect(gameId, token, onServerMessage, l => st().setLink(l));
}

/** The "Reconnect now" button: drop the current socket and connect again immediately. */
export function reconnect() {
  if (!isRemote) return;
  st().setLink('connecting');
  transport.reconnect?.();
}

async function enterGame(r: SavedSession) {
  st().setSession({ gameId: r.gameId, token: r.token, me: r.playerId, joinCode: r.joinCode });
  saveSession(r);
  openSocket(r.gameId, r.token);
  await refreshLobby();
}

export async function createGame(nickname: string, phases: number, mapId: string) {
  return guard(async () => {
    const r = await transport.createGame({ nickname, mapId, phases });
    await enterGame({ gameId: r.gameId, playerId: r.playerId, token: r.token, joinCode: r.joinCode });
  });
}

export async function joinGame(joinCode: string, nickname: string) {
  return guard(async () => {
    const code = joinCode.trim().toUpperCase();
    const r = await transport.joinGame({ joinCode: code, nickname });
    await enterGame({ gameId: r.gameId, playerId: r.playerId, token: r.token, joinCode: code });
  });
}

/** After a page reload: rejoin the saved game (remote only). Returns true when a game was resumed. */
export async function resumeSession(): Promise<boolean> {
  if (!isRemote || st().gameId) return false;
  const saved = loadSession();
  if (!saved) return false;
  try {
    const lobby = await transport.getLobby(saved.gameId, saved.token);
    const me = lobby.players.find(p => p.playerId === saved.playerId);
    if (!me || me.status === 'rejected' || lobby.status === 'abandoned') { saveSession(null); return false; }
    st().setSession({ gameId: saved.gameId, token: saved.token, me: saved.playerId, joinCode: saved.joinCode || lobby.joinCode });
    st().setLobby(lobby);
    openSocket(saved.gameId, saved.token);
    return true;
  } catch (e) {
    // unknown game / bad token: forget it. A network error keeps it so the next reload can retry.
    if (e instanceof ApiException && e.code !== 'INTERNAL') saveSession(null);
    return false;
  }
}

export async function refreshLobby() {
  const { gameId, token } = st();
  if (!gameId || !token) return;
  const v = await guard(() => transport.getLobby(gameId, token));
  if (v) st().setLobby(v);
}

export const admit = (playerId: PlayerId, ok: boolean) =>
  guard(async () => { const s = session(); await transport.admit(s.gameId, s.token, { playerId, admit: ok }); await refreshLobby(); });
export const setAdmission = (open: boolean) =>
  guard(async () => { const s = session(); await transport.setAdmission(s.gameId, s.token, { open }); await refreshLobby(); });
export const setPhases = (phases: number) =>
  guard(async () => { const s = session(); await transport.setSettings(s.gameId, s.token, { phases }); await refreshLobby(); });
export const setParty = (party: PartyIdentity) =>
  guard(async () => { const s = session(); await transport.setParty(s.gameId, s.token, { party }); await refreshLobby(); return true; });
export const start = () =>
  guard(async () => { const s = session(); await transport.start(s.gameId, s.token); await refreshLobby(); });

// ---- WebSocket operations (results arrive as ServerMessages through applyServer)
export const campaign = (type: ActionType, seat: SeatId) => {
  const clientRef = Math.random().toString(36).slice(2, 8);
  st().trackAction(clientRef, { type, seat });
  transport.send({ action: 'campaign', type, seat, clientRef });
};
export const buyReport = (scope: ReportScope, seat?: SeatId) => transport.send({ action: 'buyReport', scope, seat });
export const chat = (to: PlayerId[], text: string) => transport.send({ action: 'chat', to, text });
export const proposeGovernment = (portfolios: PortfolioAssignment, partners?: PlayerId[]) =>
  transport.send({ action: 'proposeGovernment', portfolios, partners });
export const respondOffer = (offerId: string, accept: boolean) => transport.send({ action: 'respondOffer', offerId, accept });
export const withdrawOffer = (offerId: string) => transport.send({ action: 'withdrawOffer', offerId });

/** Leave the game (forget the saved session). `notice` is shown as a toast on the home screen. */
export function leaveGame(notice?: string) {
  transport.disconnect();
  saveSession(null);
  st().reset();
  if (notice) st().setError(notice);
}
