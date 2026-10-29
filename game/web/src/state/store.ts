import { create } from 'zustand';
import type {
  ActionType, ChatMessage, GameMapPackage, GameSnapshot, GameStatus, LobbyView, PlayerId, PlayerPublic, PrivateState,
  GlobalReports, SeatId, SeatSharesMessage, ServerMessage,
} from '@hp/shared';
import type { LinkState } from '../net/transport';

export type Screen = 'home' | 'lobby' | 'party' | 'campaign' | 'counting' | 'result';

export interface RepGainState { key: number; type: 'rally' | 'roadshow'; seat: SeatId; seats: Record<SeatId, number> }
export interface Pulse { seat: SeatId; playerId: PlayerId; key: number }

interface State {
  // session
  gameId: string | null;
  token: string | null;
  me: PlayerId | null;
  joinCode: string | null;
  // server data
  lobby: LobbyView | null;
  snapshot: GameSnapshot | null;
  priv: PrivateState | null;
  chat: ChatMessage[];
  /** Newest item time already read per conversation ('group', 'dm:<id>'): drives the unread badges. Kept per game in localStorage. */
  chatRead: Record<string, number>;
  clockOffset: number; // serverTime - Date.now()
  link: LinkState; // websocket state (always 'open' for the mock)
  polledSeats: SeatId[]; // seats closed so far (from phaseClosed messages)
  /** Latest answer to peekSeat per seat (vote shares + candidate names); lead answers swing, won answers never change. */
  seatShares: Record<SeatId, SeatSharesMessage>;
  /** Latest answer to requestGlobalReports (the news agencies' noisy projections); null until asked. */
  globalReports: GlobalReports | null;
  // map data
  names: Record<SeatId, string>;
  gamePkg: GameMapPackage | null;
  // ui
  lobbyPage: 'lobby' | 'party';
  selectedSeat: SeatId | null;
  pulse: Pulse | null;
  /** Latest rise of the player's own reputation caused by their own rally/roadshow (drives the green "+N" smoke on the map). */
  repGain: RepGainState | null;
  error: string | null;
  // actions
  setSession(s: { gameId: string; token: string; me: PlayerId; joinCode: string }): void;
  setLobby(v: LobbyView): void;
  applyServer(m: ServerMessage): void;
  setNames(n: Record<SeatId, string>): void;
  setGamePkg(p: GameMapPackage | null): void;
  setLobbyPage(p: 'lobby' | 'party'): void;
  selectSeat(s: SeatId | null): void;
  setError(e: string | null): void;
  setLink(l: LinkState): void;
  /** Remember what a pending campaign message (by clientRef) was, so its actionAck can extend priv.myActions. */
  trackAction(ref: string, a: { type: ActionType; seat: SeatId }): void;
  /** A conversation was on screen up to item time `ts` (only ever moves forward). */
  markChatRead(key: string, ts: number): void;
  reset(): void;
}

const initial = {
  gameId: null, token: null, me: null, joinCode: null, lobby: null, snapshot: null, priv: null,
  chat: [] as ChatMessage[], chatRead: {} as Record<string, number>, clockOffset: 0, link: 'open' as LinkState, polledSeats: [] as SeatId[], seatShares: {} as Record<SeatId, SeatSharesMessage>, globalReports: null as GlobalReports | null, lobbyPage: 'lobby' as const, selectedSeat: null,
  pulse: null as Pulse | null, repGain: null as RepGainState | null, error: null as string | null,
};

let pulseKey = 0;
let gainKey = 0;
const pendingActions = new Map<string, { type: ActionType; seat: SeatId }>();

const readKey = (gameId: string, me: PlayerId) => `hp.chatRead.${gameId}.${me}`;
/** Read state of this game's chats from an earlier visit (a reload must not bring back every badge); {} when unavailable. */
function loadChatRead(gameId: string, me: PlayerId): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(readKey(gameId, me)) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function saveChatRead(gameId: string | null, me: PlayerId | null, read: Record<string, number>) {
  if (!gameId || !me) return;
  try { localStorage.setItem(readKey(gameId, me), JSON.stringify(read)); } catch { /* private mode / storage full: badges just reset on reload */ }
}

export const useStore = create<State>((set, get) => ({
  ...initial,
  names: {},
  gamePkg: null,

  setSession: s => set({ ...s, polledSeats: [], seatShares: {}, globalReports: null, lobby: null, snapshot: null, priv: null, chat: [], chatRead: loadChatRead(s.gameId, s.me), lobbyPage: 'lobby', selectedSeat: null, repGain: null }),
  setLobby: v => set({ lobby: v }),
  setNames: names => set({ names }),
  setGamePkg: gamePkg => set({ gamePkg }),
  setLobbyPage: lobbyPage => set({ lobbyPage }),
  selectSeat: selectedSeat => set({ selectedSeat }),
  setError: error => set({ error }),
  setLink: link => set({ link }),
  trackAction: (ref, a) => { pendingActions.set(ref, a); if (pendingActions.size > 200) pendingActions.delete(pendingActions.keys().next().value as string); },
  markChatRead: (key, ts) => {
    const { chatRead, gameId, me } = get();
    if ((chatRead[key] ?? -Infinity) >= ts) return;
    const next = { ...chatRead, [key]: ts };
    set({ chatRead: next });
    saveChatRead(gameId, me, next);
  },
  reset: () => { pendingActions.clear(); set({ ...initial }); },

  applyServer(m) {
    const { snapshot: snap, priv } = get();
    switch (m.type) {
      case 'hello':
        set({ snapshot: m.snapshot, priv: m.private, clockOffset: m.serverTime - Date.now(), ...(m.chat ? { chat: m.chat } : {}) });
        break;
      case 'pong':
        set({ clockOffset: m.serverTime - (Date.now() + m.clientTime) / 2 });
        break;
      case 'private': set({ priv: m.private }); break;
      case 'status':
        if (snap) set({ snapshot: { ...snap, status: m.status, timeline: m.timeline } });
        break;
      case 'players': if (snap) set({ snapshot: { ...snap, players: m.players } }); break;
      case 'news':
        if (snap) set({ snapshot: { ...snap, news: [...snap.news, m.item] }, pulse: { seat: m.item.seat, playerId: m.item.playerId, key: ++pulseKey } });
        break;
      case 'actionAck': {
        // the server sends only the new budget; add the action to our own list (its clientRef tells us which one it was)
        const a = m.clientRef ? pendingActions.get(m.clientRef) : undefined;
        if (m.clientRef) pendingActions.delete(m.clientRef);
        if (priv) set({ priv: { ...priv, budget: m.budget, reputation: m.reputation ?? priv.reputation, nextRallyAt: m.nextRallyAt !== undefined ? m.nextRallyAt : priv.nextRallyAt, myActions: a ? [...priv.myActions, { ...a, ts: Date.now() + get().clockOffset }] : priv.myActions } });
        if (priv && a && m.reputation && (a.type === 'rally' || a.type === 'roadshow')) {
          const seats: Record<SeatId, number> = {};
          for (const [k, v] of Object.entries(m.reputation)) { const d = v - (priv.reputation?.[Number(k)] ?? 0); if (d > 0) seats[Number(k)] = d; }
          if (Object.keys(seats).length) set({ repGain: { key: ++gainKey, type: a.type, seat: a.seat, seats } });
        }
        break;
      }
      case 'report':
        if (priv) set({ priv: { ...priv, budget: m.budget, myReports: [...priv.myReports, m.report] } });
        break;
      case 'phaseClosed':
        if (snap) set(s => ({ polledSeats: [...new Set([...s.polledSeats, ...m.seats])], snapshot: snap.polledPhases.includes(m.phase) ? snap : { ...snap, polledPhases: [...snap.polledPhases, m.phase] } }));
        break;
      case 'seatUpdate':
        if (snap) set({ snapshot: { ...snap, seats: { ...snap.seats, [m.declaration.seat]: m.declaration }, tally: m.tally } });
        break;
      case 'globalReports': set({ globalReports: m.reports }); break;
      case 'seatShares': set(s => ({ seatShares: { ...s.seatShares, [m.seat]: m } })); break;
      case 'chat': set(s => ({ chat: s.chat.some(c => c.id === m.message.id) ? s.chat : [...s.chat, m.message] })); break;
      case 'offer':
        if (snap) {
          const offers = snap.offers.filter(o => o.offerId !== m.offer.offerId).concat(m.offer);
          set({ snapshot: { ...snap, offers } });
        }
        break;
      case 'government': if (snap) set({ snapshot: { ...snap, government: m.government } }); break;
      case 'result': if (snap) set({ snapshot: { ...snap, result: m.result, status: 'finished' } }); break;
      case 'error':
        if (m.clientRef) pendingActions.delete(m.clientRef);
        set({ error: m.message });
        break;
    }
  },
}));

// ---- derived helpers
export function currentScreen(s: Pick<State, 'gameId' | 'snapshot' | 'lobby' | 'lobbyPage'>): Screen {
  if (!s.gameId) return 'home';
  const status: GameStatus = s.snapshot?.status ?? s.lobby?.status ?? 'lobby';
  switch (status) {
    case 'lobby': return s.lobbyPage;
    case 'campaign': return 'campaign';
    case 'counting': case 'postCounting': return 'counting';
    case 'finished': case 'abandoned': return 'result';
  }
}

/** The map of the CURRENT game (snapshot first, lobby before the snapshot arrives); null outside a game. */
export const selectMapId = (s: Pick<State, 'snapshot' | 'lobby'>): string | null => s.snapshot?.mapId ?? s.lobby?.mapId ?? null;

export const selectMe = (s: State): PlayerPublic | undefined => s.snapshot?.players.find(p => p.playerId === s.me);
export const selectIsAdmin = (s: State) => !!selectMe(s)?.isAdmin;
