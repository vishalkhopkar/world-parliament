// Per-map tuning. Every number that depends on the map lives here, so a new map
// (e.g. India) only needs a new MapConfig + map package. Values marked TUNE are
// placeholders until the simulator (game/sim) picks them; update FEATURE REQUIREMENTS.docx after.

export interface DecayParams {
  /** Spill-over halves every `halfDistanceKm` of great-circle distance between seat centres. */
  halfDistanceKm: number;
  /** Beyond this distance the spill-over is exactly 0. */
  maxKm: number;
  /** Spill-over into another seat is never more than capRatio x the local effect (guards very close centres). */
  capRatio: number;
}

export interface EffectParams {
  rally: {
    local: number;      // y : effect in the seat where the rally is held
    global: number;     // c : added to EVERY seat (news/social media), including the rally seat
    decay: DecayParams; // y_d : spill-over to other seats = local * decay(d)
  };
  roadshow: {
    local: number;      // s : must be significantly larger than rally.global (docx) and larger than rally.local
    decay: DecayParams; // s_d : decays much faster than the rally's
  };
}

export interface PortfolioDef {
  id: string;        // "PM", "DPM", "HOME", ...
  label: string;
  points: number;    // whole number
  max: number;       // how many players can hold it (Deputy PM: 2)
}

export interface PointsConfig {
  portfolios: PortfolioDef[];
  /** Seat points for a government party = round(seatMultiplier * seats / N). */
  seatMultiplier: number;
  /** Flat points for being in the government at all. */
  governmentFloor: number;
  /** Points for a party not in the government. */
  opposition: number;
}

export interface PriceCurve {
  /** Price at campaign start and at campaign end; linear in between, rounded to a whole number. */
  start: number;
  end: number;
}

export interface MapConfig {
  mapId: string;
  seatCount: number;
  currency: { name: string; symbol: string };
  /** Starting budget per player (whole World Rupees). */
  budget: number;
  costs: { rally: number; roadshow: number };
  effects: EffectParams;
  /** Multiplier applied to c, y, s by the time an action is taken: linear from start (campaign start) to end (campaign end). Marginal (docx). */
  timeMultiplier: { start: number; end: number };
  analyst: {
    seatReport: PriceCurve;
    globalReport: PriceCurve;
    /** Reports describe the position this many ms before purchase. */
    delayMs: number;
    /** Relative noise: estimates get a random error with this standard deviation (fraction of the true value / share points). */
    noise: number;
    /** Margin of error shown to the player, as a multiple of the noise. */
    marginFactor: number;
  };
  /** Small random swing applied to each seat's shares at polling (fraction, e.g. 0.02 = up to about +/-2% relative). */
  randomSwing: number;
  phases: { min: number; max: number; default: number };
  durations: {
    campaignMs: number;
    countingMs: number;
    postCountingMs: number;
    graceMs: number;
  };
  players: { min: number; max: number };
  points: PointsConfig;
}

/** Majority mark for N seats: floor(N/2) + 1. */
export function majorityOf(seatCount: number): number {
  return Math.floor(seatCount / 2) + 1;
}

const STANDARD_PORTFOLIOS: PortfolioDef[] = [
  { id: 'PM', label: 'Prime Minister', points: 100, max: 1 },
  { id: 'DPM', label: 'Deputy Prime Minister', points: 50, max: 2 },
  { id: 'HOME', label: 'Home', points: 20, max: 1 },
  { id: 'DEFENCE', label: 'Defence', points: 20, max: 1 },
  { id: 'FINANCE', label: 'Finance', points: 20, max: 1 },
  { id: 'EXTERNAL', label: 'External Affairs', points: 20, max: 1 },
  { id: 'SPEAKER', label: 'Speaker of Parliament', points: 10, max: 1 },
];

/** Map the game uses when a client does not ask for a specific one (folder name under maps/). */
export const DEFAULT_MAP_ID = 'world-500';

export const WORLD_CONFIG: MapConfig = {
  mapId: 'world-500',
  seatCount: 500,
  currency: { name: 'World Rupee', symbol: 'W₹' },
  budget: 250_000_000,  // W₹25 crore: designer cut the sim-tuned W₹100 crore by 75% (20 Oct 2026)
  costs: { rally: 20_000_000, roadshow: 4_000_000 }, // tuned by sim (see game/sim/REPORT.md)
  effects: {
    rally: { local: 1.0, global: 0.01, decay: { halfDistanceKm: 150, maxKm: 800, capRatio: 0.5 } },   // tuned by sim (see game/sim/REPORT.md)
    roadshow: { local: 3.0, decay: { halfDistanceKm: 40, maxKm: 200, capRatio: 0.4 } },                // tuned by sim (see game/sim/REPORT.md)
  },
  timeMultiplier: { start: 1.0, end: 1.1 },
  analyst: {
    seatReport: { start: 8_000_000, end: 18_000_000 },     // tuned by sim (see game/sim/REPORT.md)
    globalReport: { start: 28_000_000, end: 62_000_000 },  // tuned by sim (see game/sim/REPORT.md)
    delayMs: 30_000,
    noise: 0.07,
    marginFactor: 1.0,
  },
  randomSwing: 0.02,
  phases: { min: 1, max: 5, default: 3 },
  durations: { campaignMs: 600_000, countingMs: 180_000, postCountingMs: 120_000, graceMs: 90_000 },
  players: { min: 2, max: 10 },
  points: { portfolios: STANDARD_PORTFOLIOS, seatMultiplier: 200, governmentFloor: 10, opposition: 0 },
};

export const MAP_CONFIGS: Record<string, MapConfig> = { 'world-500': WORLD_CONFIG };

/**
 * MapConfig for any map folder under maps/. Maps without their own entry in MAP_CONFIGS get a copy of
 * WORLD_CONFIG with mapId / seatCount replaced; per-map tuning should be added via the simulator (game/sim).
 */
export function configForMap(mapId: string, seatCount: number): MapConfig {
  return MAP_CONFIGS[mapId] ?? { ...WORLD_CONFIG, mapId, seatCount };
}
