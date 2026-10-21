// Core domain types shared by server, web and simulator.
// Source of truth for the rules: FEATURE REQUIREMENTS.docx (repo root).
// Everything here is map-agnostic: never assume 500 seats or a 251 majority.

export type SeatId = number;
export type PlayerId = string;
export type GameId = string;
export type ActionType = 'rally' | 'roadshow';

// ---------------------------------------------------------------- map package
// Produced per map by maps/<mapId>/source/build/07_game_map.py -> maps/<mapId>/site/data/game.json

export interface GameMapSeat {
  id: SeatId;
  // No name here on purpose: seat names live ONLY in maps/<id>/site/data/seats.json (renamed by hand), everything else uses ids.
  /** Centre of the seat (area centroid), WGS84 degrees. Distances between seats are great-circle km between these. */
  lon: number;
  lat: number;
  /** Same centre in the projected map space used by the topojson (Equal Earth, scale 200, y down). */
  x: number;
  y: number;
  /** Seats sharing a land border (or a short ferry link) with this one. */
  neighbours: SeatId[];
  /** Future: seat headquarters city; when present, distances use it instead of the centroid. */
  hq?: { name: string; lon: number; lat: number };
}

export interface GameMapPackage {
  mapId: string;              // e.g. "world-500"
  version: number;
  seatCount: number;          // N
  seats: GameMapSeat[];       // sorted by id
  /**
   * Predetermined polling-phase groupings, keyed by number of phases ("1".."5").
   * phaseGroups["3"] = [[seat ids polled in phase 1], [phase 2], [phase 3]].
   * Every seat appears exactly once per key; each group is contiguous.
   */
  phaseGroups: Record<string, SeatId[][]>;
  /** Paths (relative to the map package) of the topojson files used to draw the map. */
  topo: { coarse: string; detail?: string };
}

// ---------------------------------------------------------------- map registry
// Every folder maps/<id>/ (repo root) is a map: a static study site + the game package.
// maps/<id>/map.json is this manifest; paths are relative to maps/<id>/.

export interface MapManifest {
  id: string;                 // folder name, e.g. "world-500"
  name: string;               // e.g. "World – 500 seats"
  description: string;
  seatCount: number;
  thumbnail: string;          // e.g. "thumbnail.jpg"
  site: string;               // static study site entry, e.g. "site/index.html"
  gamePackage: string;        // GameMapPackage JSON, e.g. "site/data/game.json"
}

// ---------------------------------------------------------------- players & parties

export interface PartyIdentity {
  name: string;
  colour: string;   // the HEX value (e.g. "#E8710A") of one of PARTY_COLOURS (presets.ts)
  symbol: string;   // one of PARTY_SYMBOLS ids (presets.ts)
  /** Avatar id from the avatar manifest (game/assets/avatars). Unique within a game. Required to start (phase-2 change). */
  avatar?: string;
}

/** Who controls a player. AI agents (via MCP/CLI) can only JOIN games; only humans create/host them. */
export type PlayerKind = 'human' | 'agent';

export type PlayerStatus = 'pending' | 'active' | 'disconnected' | 'eliminated' | 'rejected';

/** What every player may know about another player. Never contains budget or roadshow data. */
export interface PlayerPublic {
  playerId: PlayerId;
  nickname: string;
  isAdmin: boolean;
  /** 'agent' = an AI player joined via MCP/CLI (shown with a robot badge). Missing = 'human'. */
  kind?: PlayerKind;
  party?: PartyIdentity;
  status: PlayerStatus;
}

// ---------------------------------------------------------------- game lifecycle

export type GameStatus = 'lobby' | 'campaign' | 'counting' | 'postCounting' | 'finished' | 'abandoned';

/** All absolute timestamps are server epoch milliseconds. */
export interface GameTimeline {
  campaignStart: number;
  /** Close time of each polling phase; the last one equals campaignEnd. Length = number of phases. */
  phaseCloses: number[];
  campaignEnd: number;
  countingEnd: number;
  postCountingEnd: number;
}

export interface Action {
  id: string;
  playerId: PlayerId;
  type: ActionType;
  seat: SeatId;
  ts: number;       // server time the action was accepted
}

// ---------------------------------------------------------------- results

export interface SeatResult {
  seat: SeatId;
  phase: number;                         // 0-based polling phase index
  winner: PlayerId | null;               // null only if nobody has any effect (no rally anywhere, no roadshow nearby)
  /** Vote shares 0..1 per player after the random swing; sums to 1 (or empty if winner null). */
  shares: Record<PlayerId, number>;
}

export type SeatTally = Record<PlayerId, number>;

// ---------------------------------------------------------------- government & points

/** Portfolio ids are defined per map in MapConfig.points.portfolios (e.g. "PM", "DPM", "HOME"). */
export type PortfolioId = string;

/** Which player holds each portfolio. Portfolios with max > 1 (Deputy PM) hold several players. */
export type PortfolioAssignment = Record<PortfolioId, PlayerId[]>;

export interface Government {
  pm: PlayerId;
  /** All parties in the government, including the PM's party. */
  members: PlayerId[];
  portfolios: PortfolioAssignment;
  formedAt: number;
  /**
   * true if formed through negotiation (an accepted coalition offer).
   * false = a single party with an outright majority that did not negotiate (it holds every portfolio).
   */
  viaNegotiation: boolean;
}

export interface PointsBreakdown {
  playerId: PlayerId;
  portfolioPoints: number;
  seatPoints: number;
  governmentFloor: number;
  total: number;            // always a whole number
}

export type Outcome =
  | 'majority'          // one party has a majority and did not negotiate -> clear winner
  | 'coalition'         // government formed through negotiation -> winner decided by points
  | 'draw'              // exact tie between two players, no government possible
  | 'noGovernment';     // nobody formed a government before the post-counting deadline -> everyone loses

export interface FinalResult {
  outcome: Outcome;
  tally: SeatTally;
  government: Government | null;
  points: PointsBreakdown[];          // one per player (eliminated players get 0)
  /** Winning player(s). Empty for noGovernment; two players for a draw. */
  winners: PlayerId[];
}

// ---------------------------------------------------------------- analyst reports

export type ReportScope = 'seat' | 'global';

export interface ReportEntry {
  playerId: PlayerId;
  rank: number;                 // 1 = leading
  /** Estimated vote share as a fraction 0..1 (seat report) or estimated seat count (global report), already noised. */
  estimate: number;
  /** +/- margin of error shown to the player (same unit as estimate). */
  margin: number;
}

export interface AnalystReport {
  scope: ReportScope;
  seat?: SeatId;
  /** Server time of the position the report describes (always earlier than purchase time). */
  asOf: number;
  purchasedAt: number;
  price: number;
  entries: ReportEntry[];
}

// ---------------------------------------------------------------- coalition offers

export type OfferStatus = 'open' | 'accepted' | 'declined' | 'withdrawn' | 'superseded' | 'formed';

export interface CoalitionOffer {
  offerId: string;
  /** The proposer is always the PM candidate. */
  proposer: PlayerId;
  portfolios: PortfolioAssignment;
  /** Partners whose acceptance is needed (every non-proposer named in portfolios, plus any listed here without a portfolio). */
  partners: PlayerId[];
  accepted: PlayerId[];
  status: OfferStatus;
  createdAt: number;
}
