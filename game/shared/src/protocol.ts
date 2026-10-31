// Wire protocol between browser and backend.
// REST (API Gateway HTTP API) for lobby; WebSocket (API Gateway WebSocket API) for everything live.
// Rule: the server never sends hidden information (roadshows, effect totals, other players' budgets). The one exception: a player's OWN rounded reputation (PrivateState.reputation, actionAck.reputation).

import type {
  ActionType, AnalystReport, CoalitionOffer, FinalResult, GameId, GameStatus, GameTimeline,
  Government, PartyIdentity, PlayerId, PlayerPublic, PortfolioAssignment, ReportScope, SeatId, SeatTally,
} from './types';
import type { CommittedLevel } from './mapConfig';

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

/**
 * `retryAt` (server epoch ms) is set on RATE_LIMITED: the earliest server time at which the same request can succeed
 * (e.g. the next allowed rally, see cooldowns.rallyMs).
 */
export interface ApiError { error: ErrorCode; message: string; retryAt?: number }

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

/** One graph point of a news agency: projected seats per party at time t (server epoch ms). The values sum to the seat count. */
export interface GlobalReportPoint {
  t: number;
  seats: Record<PlayerId, number>;
}

/** One news agency's graph: the noisy series and, for the latest point, each party's seat range [low, high] (whole numbers, 0..seatCount). */
export interface NewsAgencyReport {
  /** Slug of the agency name, e.g. "kal-tak". */
  id: string;
  name: string;
  points: GlobalReportPoint[];
  ranges: Record<PlayerId, [number, number]>;
}

/**
 * The free global reports. Built by buildGlobalReports (engine/newsAgencies.ts) from the hidden state, but only the noisy
 * numbers are sent. `asOf` = the time of the latest point's data horizon: min(now, campaignEnd) (frozen once the campaign is over).
 * `sampleIntervalMs` = the spacing of the points actually used (the configured one, lengthened when the campaign would need more than news.maxPoints).
 */
export interface GlobalReports {
  asOf: number;
  sampleIntervalMs: number;
  agencies: NewsAgencyReport[];
}

export type ClientMessage =
  | { action: 'ping'; clientTime: number }
  | { action: 'campaign'; type: ActionType; seat: SeatId; clientRef?: string }
  | { action: 'buyReport'; scope: ReportScope; seat?: SeatId }
  /** Campaign start onwards (free, every player): the news agencies' noisy projections. Answered, to the requester only, with 'globalReports'. */
  | { action: 'globalReports' }
  /** Counting phase onwards: the vote shares (and candidate names) of a seat that already has a lead or a result. Answered with 'seatShares'. */
  | { action: 'peekSeat'; seat: SeatId }
  /**
   * A chat message (3+ players; the stage's mode is `chatModeFor(cfg, status)`). GROUP: everybody reads it, `to` is ignored,
   * and "@Party name" in the text tags that party (the server works out `mentions`). INDV: `to` = exactly ONE other player.
   */
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
  /**
   * Own committed voters only (never another party's): one entry per seat with a band. `percent` is the band's figure
   * (shown as "~30%"), never the value after influence. Missing/empty before the player's bands are dealt.
   */
  committed?: CommittedView[];
  /**
   * Own reputation among swing voters only (never another party's): seat -> round(effect x display.reputationScale),
   * zeros omitted (missing = 0). Whole numbers; raw effect totals are never sent.
   */
  reputation?: Record<SeatId, number>;
  /**
   * Server epoch ms from which this player's next rally is allowed (cooldowns.rallyMs after their last accepted rally).
   * null/absent = a rally is allowed now (never rallied). Roadshows have no cooldown.
   */
  nextRallyAt?: number | null;
}

export interface CommittedView { seat: SeatId; band: number; percent: number; level: CommittedLevel }

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

/** 'group' = the common chat everybody reads; 'direct' = a one-to-one message (`to` = the one recipient). */
export type ChatChannel = 'group' | 'direct';

export interface ChatMessage {
  id: string; from: PlayerId; to: PlayerId[]; text: string; ts: number;
  /** Missing on messages stored before one-to-one chats existed: read as 'group'. */
  channel?: ChatChannel;
  /** Group messages: the players tagged with "@Party name" in the text (they get a badge). */
  mentions?: PlayerId[];
}

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
  | { type: 'hello'; serverTime: number; /** server capabilities; 'actionRef' = campaign messages with a clientRef are applied at most once */ features?: string[]; snapshot: GameSnapshot; private: PrivateState; chat?: ChatMessage[] }
  | { type: 'pong'; clientTime: number; serverTime: number }
  | { type: 'private'; private: PrivateState }
  | { type: 'status'; status: GameStatus; timeline: GameTimeline | null }
  | { type: 'players'; players: PlayerPublic[] }
  | { type: 'news'; item: NewsItem }
  /** `nextRallyAt` = as in PrivateState (server epoch ms of the next allowed rally; null/absent = allowed now). */
  | { type: 'actionAck'; clientRef?: string; /** true when this clientRef had already been applied: nothing was charged again */ duplicate?: true; ok: true; budget: number; reputation?: Record<SeatId, number>; nextRallyAt?: number | null }
  | { type: 'report'; report: AnalystReport; budget: number }
  | { type: 'globalReports'; reports: GlobalReports }
  | { type: 'phaseClosed'; phase: number; seats: SeatId[] }
  | { type: 'seatUpdate'; declaration: SeatDeclaration; tally: CountTally }
  | SeatSharesMessage
  | { type: 'chat'; message: ChatMessage }
  | { type: 'offer'; offer: CoalitionOffer }
  | { type: 'government'; government: Government }
  | { type: 'result'; result: FinalResult }
  /** `retryAt` as in ApiError (set on RATE_LIMITED). */
  | { type: 'error'; error: ErrorCode; message: string; clientRef?: string; retryAt?: number };
