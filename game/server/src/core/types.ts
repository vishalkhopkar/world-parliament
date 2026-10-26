// Interfaces the GameService depends on. No AWS imports in core/.
import type {
  Action, AnalystReport, CoalitionOffer, ErrorCode, FinalResult, GameMapPackage, GameStatus, GameTimeline,
  Government, MapConfig, PartyIdentity, PlayerId, PlayerKind, PlayerStatus, ServerMessage, SeatId, SeatResult, ChatMessage,
  Kernels, CommittedSet,
} from '@hp/shared';

export interface GameRecord {
  gameId: string;
  joinCode: string;
  mapId: string;
  phases: number;
  status: GameStatus;
  admissionOpen: boolean;
  adminId: PlayerId;
  createdAt: number;
  timeline: GameTimeline | null;
  /** Number of polling phases already closed (polled). Used as optimistic-concurrency guard for campaign actions. */
  closedPhases: number;
  /** Counting: last step already revealed (0 = none). */
  revealedStep: number;
  /** Set when the result has been written (idempotent finalise). */
  finalised?: boolean;
  /** Committed-voter deals so far: bumped (with a condition on the old value) by every deal, so two deals never interleave. */
  committedSeq?: number;
}

export interface PlayerRecord {
  gameId: string;
  playerId: PlayerId;
  nickname: string;
  tokenHash: string;
  isAdmin: boolean;
  /** 'agent' = AI player joined via MCP/CLI; missing = 'human'. */
  kind?: PlayerKind;
  status: PlayerStatus;
  /** 0-based candidates.csv column this party draws its candidates from. Server-internal: set once at game start, never sent to clients. */
  candidateColumn?: number;
  /** This party's committed voters (dealt at admission). Server-internal; only the owner sees their own (PrivateState.committed). */
  committed?: CommittedSet;
  party?: PartyIdentity;
  budget: number;
  /**
   * Server time (ms) of this player's last ACCEPTED rally; missing = never rallied (also for records stored before the
   * rally cooldown existed). Written only by Repo.addAction in the same transaction as the budget deduction.
   */
  lastRallyAt?: number;
  joinedAt: number;
  connectionId?: string;
  disconnectedAt?: number;
  graceSchedule?: string;
}

export interface ConnectionRecord { connectionId: string; gameId: string; playerId: PlayerId; helloSent?: boolean }

/** Deterministic counting schedule (stored once when counting starts). */
export interface CountPlan {
  order: SeatId[];          // random order in which seats get their first lead
  steps: number;            // S: the last step; every declarable seat is 'won' by then
  intervalMs: number;
  startMs: number;          // counting start (= campaign end)
  seed: string;             // seeds the lead noise (the game id)
  winStart: number;         // first step at which any seat may be 'won' (ceil(winStartFraction * S))
  leadStep: Record<SeatId, number>; // step at which the seat first shows a lead (declarable seats only)
  winStep: Record<SeatId, number>;  // step at which the seat is confirmed 'won' (>= winStart, last seat = steps)
  noise: {
    start: number;          // sigma at t = 0
    exponent: number;       // sigma ~ (1 - t/S)^exponent
    epochSteps: number;     // a lead can change at most every epochSteps steps (also the ramp-down length before winStep)
  };
}

export interface StoredReport { playerId: PlayerId; ts: number; report: AnalystReport }
export interface StoredChat extends ChatMessage {}

/**
 * 'insufficient' = budget too low or player not active; 'conflict' = the game moved on (status / closedPhases), retry;
 * 'cooldown' = a rally refused because the player's stored lastRallyAt is less than rallyGapMs before it (final, no retry).
 */
export type SpendResult = 'ok' | 'insufficient' | 'conflict' | 'cooldown';

/**
 * Rally guard for Repo.addAction (pass it for rallies only): atomically with the budget deduction, require the stored
 * lastRallyAt to be missing or <= action.ts - rallyGapMs, and set lastRallyAt = action.ts. rallyGapMs <= 0 = no check.
 */
export interface AddActionOptions { rallyGapMs?: number }

export interface Repo {
  // games
  createGame(game: GameRecord, admin: PlayerRecord): Promise<void>;
  getGame(gameId: string): Promise<GameRecord | null>;
  findGameByCode(code: string): Promise<GameRecord | null>;
  /** Equality-conditional update; false when the condition fails. `undefined` values remove the attribute. */
  updateGame(gameId: string, patch: Partial<GameRecord>, cond?: Partial<GameRecord>): Promise<boolean>;
  /** SET closedPhases = n if closedPhases < n. */
  markPhaseClosed(gameId: string, n: number): Promise<void>;

  // players
  putPlayer(p: PlayerRecord): Promise<void>;
  getPlayer(gameId: string, playerId: PlayerId): Promise<PlayerRecord | null>;
  listPlayers(gameId: string): Promise<PlayerRecord[]>;
  updatePlayer(gameId: string, playerId: PlayerId, patch: Partial<PlayerRecord>, cond?: Partial<PlayerRecord>): Promise<boolean>;

  // connections
  putConnection(c: ConnectionRecord): Promise<void>;
  getConnection(connectionId: string): Promise<ConnectionRecord | null>;
  deleteConnection(connectionId: string): Promise<void>;

  // campaign (atomic: deduct budget with budget >= cost AND player active [AND rally gap], insert, check game campaign & closedPhases)
  addAction(gameId: string, playerId: PlayerId, cost: number, action: Action, expectClosedPhases: number, opts?: AddActionOptions): Promise<SpendResult>;
  listActions(gameId: string): Promise<Action[]>;
  addReport(gameId: string, playerId: PlayerId, cost: number, rep: StoredReport, expectClosedPhases: number): Promise<SpendResult>;
  listReports(gameId: string, playerId: PlayerId): Promise<StoredReport[]>;

  // results
  putSeatResults(gameId: string, results: SeatResult[]): Promise<void>;
  listSeatResults(gameId: string): Promise<SeatResult[]>;
  putCountPlan(gameId: string, plan: CountPlan): Promise<void>;
  getCountPlan(gameId: string): Promise<CountPlan | null>;

  // chat
  addChat(gameId: string, msg: StoredChat): Promise<void>;
  listChat(gameId: string): Promise<StoredChat[]>;

  // offers & government & result
  putOffer(gameId: string, offer: CoalitionOffer): Promise<void>;
  getOffer(gameId: string, offerId: string): Promise<CoalitionOffer | null>;
  listOffers(gameId: string): Promise<CoalitionOffer[]>;
  /** attribute_not_exists write: true if this call created it (first confirmed government wins). */
  putGovernmentIfAbsent(gameId: string, g: Government): Promise<boolean>;
  getGovernment(gameId: string): Promise<Government | null>;
  putResultIfAbsent(gameId: string, r: FinalResult): Promise<boolean>;
  getResult(gameId: string): Promise<FinalResult | null>;
}

export interface Notifier {
  sendToPlayer(gameId: string, playerId: PlayerId, msg: ServerMessage | ServerMessage[]): Promise<void>;
  broadcast(gameId: string, msg: ServerMessage | ServerMessage[]): Promise<void>;
  /** Used for the reply to the connection that just connected / sent a message. */
  sendToConnection(connectionId: string, msg: ServerMessage | ServerMessage[]): Promise<void>;
  /** Forcibly close a connection (used for rejected players). */
  closeConnection(connectionId: string): Promise<void>;
}

export interface Scheduler {
  /** Start the lifecycle (phase closes -> counting loop -> finalise) for a started game. */
  startLifecycle(gameId: string, timeline: GameTimeline): Promise<void>;
  /** Returns an opaque schedule name stored on the player record. */
  scheduleGraceCheck(gameId: string, playerId: PlayerId, atMs: number): Promise<string>;
  cancelGraceCheck(name: string): Promise<void>;
}

export interface Clock { now(): number }

export interface LoadedMap {
  map: GameMapPackage; cfg: MapConfig; kernels: Kernels;
  /** The map's optional candidates.csv rows (row n = seat n, one name per column). */
  candidates?: string[][];
  /** Seat id -> name from the map's seats.json (reports only; absent = "Seat <id>"). */
  seatNames?: Record<number, string>;
}
export type MapProvider = (mapId: string) => LoadedMap | undefined;

export interface GameServiceOptions {
  /** Lead-in between /start and the campaign start (ms). */
  startDelayMs?: number;
  /** Ttl for nothing at core level; kept for symmetry. */
}

export class GameError extends Error {
  /** `retryAt` (server epoch ms): set on RATE_LIMITED, the earliest time the same request can succeed. */
  constructor(public code: ErrorCode, message: string, public retryAt?: number) { super(message); this.name = 'GameError'; }
}
export const HTTP_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  GAME_FULL: 409, ADMISSION_CLOSED: 409, NAME_TAKEN: 409, COLOUR_TAKEN: 409, SYMBOL_TAKEN: 409, AVATAR_TAKEN: 409,
  WRONG_PHASE: 409, INSUFFICIENT_FUNDS: 409, SEAT_POLLED: 409, TOO_LATE: 409, RATE_LIMITED: 429,
  INVALID_GOVERNMENT: 422, OFFER_NOT_FOUND: 404, ALREADY_COMMITTED: 409, NOT_ENOUGH_PLAYERS: 409, INTERNAL: 500, NEGOTIATION_DISABLED: 409,
};
