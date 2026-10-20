// Interfaces the GameService depends on. No AWS imports in core/.
import type {
  Action, AnalystReport, CoalitionOffer, ErrorCode, FinalResult, GameMapPackage, GameStatus, GameTimeline,
  Government, MapConfig, PartyIdentity, PlayerId, PlayerKind, PlayerStatus, ServerMessage, SeatId, SeatResult, ChatMessage,
  Kernels,
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
  party?: PartyIdentity;
  budget: number;
  joinedAt: number;
  connectionId?: string;
  disconnectedAt?: number;
  graceSchedule?: string;
}

export interface ConnectionRecord { connectionId: string; gameId: string; playerId: PlayerId; helloSent?: boolean }

/** Deterministic counting schedule (stored once when counting starts). */
export interface CountPlan {
  order: SeatId[];          // random order in which seats are declared
  steps: number;            // S
  intervalMs: number;
  startMs: number;          // counting start (= campaign end)
  gap: number;              // steps between 'leading' and 'won'
}

export interface StoredReport { playerId: PlayerId; ts: number; report: AnalystReport }
export interface StoredChat extends ChatMessage {}

export type SpendResult = 'ok' | 'insufficient' | 'conflict';

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

  // campaign (atomic: deduct budget with budget >= cost AND player active, insert, check game campaign & closedPhases)
  addAction(gameId: string, playerId: PlayerId, cost: number, action: Action, expectClosedPhases: number): Promise<SpendResult>;
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

export interface LoadedMap { map: GameMapPackage; cfg: MapConfig; kernels: Kernels }
export type MapProvider = (mapId: string) => LoadedMap | undefined;

export interface GameServiceOptions {
  /** Lead-in between /start and the campaign start (ms). */
  startDelayMs?: number;
  /** Ttl for nothing at core level; kept for symmetry. */
}

export class GameError extends Error {
  constructor(public code: ErrorCode, message: string) { super(message); this.name = 'GameError'; }
}
export const HTTP_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  GAME_FULL: 409, ADMISSION_CLOSED: 409, NAME_TAKEN: 409, COLOUR_TAKEN: 409, SYMBOL_TAKEN: 409, AVATAR_TAKEN: 409,
  WRONG_PHASE: 409, INSUFFICIENT_FUNDS: 409, SEAT_POLLED: 409, TOO_LATE: 409, RATE_LIMITED: 429,
  INVALID_GOVERNMENT: 422, OFFER_NOT_FOUND: 404, ALREADY_COMMITTED: 409, NOT_ENOUGH_PLAYERS: 409, INTERNAL: 500, NEGOTIATION_DISABLED: 409,
};
