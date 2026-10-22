// Wire protocol between browser and backend.
// REST (API Gateway HTTP API) for lobby; WebSocket (API Gateway WebSocket API) for everything live.
// Rule: the server never sends hidden information (roadshows, effect totals, other players' budgets).

import type {
  ActionType, AnalystReport, CoalitionOffer, FinalResult, GameId, GameStatus, GameTimeline,
  Government, PartyIdentity, PlayerId, PlayerPublic, PortfolioAssignment, ReportScope, SeatId, SeatTally,
} from './types';

// ================================================================ REST (lobby)
// Auth: every call except create/join sends header `Authorization: Bearer <playerToken>`.

/** POST /games */
export interface CreateGameRequest { nickname: string; mapId: string; phases: number }
export interface CreateGameResponse { gameId: GameId; joinCode: string; playerId: PlayerId; token: string }

/** POST /games/join */
/** kind 'agent' marks an AI player (MCP/CLI). There is deliberately no way for an agent to create a game. */
export interface JoinGameRequest { joinCode: string; nickname: string; kind?: 'human' | 'agent' }
export interface JoinGameResponse { gameId: GameId; playerId: PlayerId; token: string; status: 'pending' }

/** GET /games/{gameId} */
export interface LobbyView {
  gameId: GameId;
  joinCode: string;
  mapId: string;
  phases: number;
  status: GameStatus;
  admissionOpen: boolean;
  you: PlayerId;
  players: PlayerPublic[];   // admin sees pending players too; others see only active ones
}

/** POST /games/{gameId}/admit (admin only) */
export interface AdmitRequest { playerId: PlayerId; admit: boolean }

/** POST /games/{gameId}/admission (admin only) */
export interface AdmissionRequest { open: boolean }

/** POST /games/{gameId}/settings (admin only, lobby only) */
export interface SettingsRequest { phases: number }

/** POST /games/{gameId}/party */
export interface PartyRequest { party: PartyIdentity }

/** POST /games/{gameId}/start (admin only; needs >= players.min active players, all with a party) */
export type StartResponse = { ok: true; timeline: GameTimeline };

export interface ApiError { error: ErrorCode; message: string }

export type ErrorCode =
  | 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'GAME_FULL' | 'ADMISSION_CLOSED' | 'NAME_TAKEN' | 'COLOUR_TAKEN' | 'SYMBOL_TAKEN' | 'AVATAR_TAKEN'
  | 'WRONG_PHASE' | 'INSUFFICIENT_FUNDS' | 'SEAT_POLLED' | 'TOO_LATE' | 'RATE_LIMITED'
  | 'INVALID_GOVERNMENT' | 'OFFER_NOT_FOUND' | 'ALREADY_COMMITTED' | 'NOT_ENOUGH_PLAYERS' | 'INTERNAL'
  // chat / coalition offers are disabled in 2-player games (majority wins, exact tie = draw)
  | 'NEGOTIATION_DISABLED';

// ================================================================ WebSocket
// Connect: wss://<ws-endpoint>?gameId=<id>&token=<playerToken>
// Route selection expression on API Gateway: $request.body.action
// API Gateway cannot push during $connect, so the server sends 'hello' in reply to the client's FIRST message:
// clients must send { action: 'ping' } immediately after the socket opens (and on reconnect).
// Pending (not yet admitted) players may connect; they receive a minimal hello and lobby-level messages only.
// Party colours are sent as the hex value of a PARTY_COLOURS entry.

export type ClientMessage =
  | { action: 'ping'; clientTime: number }
  | { action: 'campaign'; type: ActionType; seat: SeatId; clientRef?: string }
  | { action: 'buyReport'; scope: ReportScope; seat?: SeatId }
  /** Counting phase onwards: the vote shares (and candidate names) of a seat that already has a lead or a result. Answered with 'seatShares'. */
  | { action: 'peekSeat'; seat: SeatId }
  /** Counting & post-counting only. `to` picks the recipients in 'individual' mode; in 'group' mode (default) everybody reads it and `to` is ignored. */
  | { action: 'chat'; to?: PlayerId[]; text: string }
  | { action: 'proposeGovernment'; portfolios: PortfolioAssignment; partners?: PlayerId[] }
  | { action: 'respondOffer'; offerId: string; accept: boolean }
  | { action: 'withdrawOffer'; offerId: string };

/** Personal state: only ever sent to its owner. */
export interface PrivateState {
  you: PlayerId;
  budget: number;
  /** Own actions so far (players can see their own roadshows). */
  myActions: { type: ActionType; seat: SeatId; ts: number }[];
  myReports: AnalystReport[];
}

export interface GameSnapshot {
  gameId: GameId;
  mapId: string;
  status: GameStatus;
  phases: number;
  timeline: GameTimeline | null;
  players: PlayerPublic[];
  /** Public news so far (every rally). */
  news: NewsItem[];
  /** 0-based indices of polling phases already closed; their seats = map.phaseGroups[String(phases)][index] (same seats as each phaseClosed message). */
  polledPhases: number[];
  /** Counting progress (public once counting starts). */
  seats: Record<SeatId, SeatDeclaration>;
  tally: CountTally | null;
  offers: CoalitionOffer[];          // only offers the receiving player is part of
  government: Government | null;
  result: FinalResult | null;
}

export interface NewsItem { playerId: PlayerId; seat: SeatId; ts: number }

export interface SeatDeclaration {
  seat: SeatId;
  status: 'leading' | 'won';
  playerId: PlayerId;
  /** Present once status = 'won'. */
  shares?: Record<PlayerId, number>;
}

/**
 * leads = seats currently 'leading' (not yet won) per player; wins = seats 'won' per player;
 * declared = number of seats already 'won' (final); total = N.
 */
export interface CountTally { leads: SeatTally; wins: SeatTally; declared: number; total: number }

export interface ChatMessage { id: string; from: PlayerId; to: PlayerId[]; text: string; ts: number }

/**
 * Private reply to 'peekSeat'. status 'won' = the seat's true final shares (they never change); 'leading' = the server's
 * current ESTIMATE of every party's share (it swings from step to step and settles on the truth by confirmation; its
 * biggest slice is always the party the seat shows as leading). Shares are 0..1 and add up to ~1. `candidates` = each
 * party's candidate in this seat (omitted when the map has no candidates.csv).
 */
export interface SeatSharesMessage {
  type: 'seatShares';
  seat: SeatId;
  status: 'leading' | 'won';
  shares: Record<PlayerId, number>;
  candidates?: Record<PlayerId, string>;
}

export type ServerMessage =
  /** `chat` = the conversation so far that this player may read (newest messages, bounded), so a reconnect keeps it. */
  | { type: 'hello'; serverTime: number; snapshot: GameSnapshot; private: PrivateState; chat?: ChatMessage[] }
  | { type: 'pong'; clientTime: number; serverTime: number }
  | { type: 'private'; private: PrivateState }
  | { type: 'status'; status: GameStatus; timeline: GameTimeline | null }
  | { type: 'players'; players: PlayerPublic[] }
  | { type: 'news'; item: NewsItem }
  | { type: 'actionAck'; clientRef?: string; ok: true; budget: number }
  | { type: 'report'; report: AnalystReport; budget: number }
  | { type: 'phaseClosed'; phase: number; seats: SeatId[] }
  | { type: 'seatUpdate'; declaration: SeatDeclaration; tally: CountTally }
  | SeatSharesMessage
  | { type: 'chat'; message: ChatMessage }
  | { type: 'offer'; offer: CoalitionOffer }
  | { type: 'government'; government: Government }
  | { type: 'result'; result: FinalResult }
  | { type: 'error'; error: ErrorCode; message: string; clientRef?: string };
