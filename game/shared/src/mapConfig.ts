// Per-map tuning types and the game constants. The NUMBERS live in game/config/game.properties (edit that file, not this
// one); `npm run gen:config` turns it into config.generated.ts, which WORLD_CONFIG is built from. A new map (e.g. India)
// only needs a map package; it gets a copy of these values unless MAP_CONFIGS has an entry for it.
import { GAME_CONFIG_VALUES } from './config.generated';

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
  /**
   * First mover's advantage: the very first party to rally OR roadshow in a seat gets this extra effect in THAT seat
   * (the amount depends on which action it used). Not scaled by the time multiplier. 0 = off.
   */
  firstMover: { rally: number; roadshow: number };
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

export interface CountingParams {
  /** No seat is confirmed ('won') before this fraction of the counting time; confirmations are then spread up to the end. */
  winStartFraction: number;
  /** Every seat shows a lead (however noisy) no later than this fraction. */
  allLeadsByFraction: number;
  /** Lead noise: estimated score = share x exp(sigma x gaussian); sigma at the start of counting... */
  leadNoiseStart: number;
  /** ...falling as (1 - elapsed)^exponent. */
  leadNoiseExponent: number;
  /** A lead can change at most once per this fraction of the counting time. */
  leadNoiseEpochFraction: number;
  /** Seats are confirmed in order of (winning margin + winJitter x random), biggest first. */
  winJitter: number;
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
    /** Counting lasts this long instead of countingMs when the game has exactly 2 players. */
    countingMsTwoPlayers: number;
    /** One counting step: the reveal advances (and may broadcast) this often. */
    countingStepMs: number;
    postCountingMs: number;
    /** Post-counting time instead of postCountingMs when the game has exactly 2 players (0 = straight to the result). */
    postCountingMsTwoPlayers: number;
    graceMs: number;
  };
  /** How the count is revealed: noisy leads first, confirmed wins only late. All fractions are of the counting time. */
  counting: CountingParams;
  players: { min: number; max: number };
  points: PointsConfig;
}

/** Majority mark for N seats: floor(N/2) + 1. */
export function majorityOf(seatCount: number): number {
  return Math.floor(seatCount / 2) + 1;
}

/** Map the game uses when a client does not ask for a specific one (folder name under maps/). */
export const DEFAULT_MAP_ID = 'world-500';

/** Throws (naming the key) if a number is missing, not finite or out of range. Runs once at start-up on the file values. */
export function validateConfig(cfg: MapConfig): void {
  const bad = (key: string, why: string): never => { throw new Error(`game config: ${key} ${why}`); };
  const num = (key: string, v: unknown, min = 0, strict = false) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) bad(key, `must be a number (got ${String(v)})`);
    if (strict ? (v as number) <= min : (v as number) < min) bad(key, `must be ${strict ? '>' : '>='} ${min} (got ${String(v)})`);
  };
  num('budget', cfg.budget, 0, true);
  num('costs.rally', cfg.costs?.rally, 0, true);
  num('costs.roadshow', cfg.costs?.roadshow, 0, true);
  const decay = (k: string, d: DecayParams) => {
    num(`${k}.halfDistanceKm`, d?.halfDistanceKm, 0, true);
    num(`${k}.maxKm`, d?.maxKm);
    num(`${k}.capRatio`, d?.capRatio);
  };
  num('effects.rally.local', cfg.effects?.rally?.local);
  num('effects.rally.global', cfg.effects?.rally?.global);
  decay('effects.rally.decay', cfg.effects?.rally?.decay);
  num('effects.roadshow.local', cfg.effects?.roadshow?.local);
  decay('effects.roadshow.decay', cfg.effects?.roadshow?.decay);
  num('effects.firstMover.rally', cfg.effects?.firstMover?.rally);
  num('effects.firstMover.roadshow', cfg.effects?.firstMover?.roadshow);
  num('timeMultiplier.start', cfg.timeMultiplier?.start);
  num('timeMultiplier.end', cfg.timeMultiplier?.end);
  num('analyst.seatReport.start', cfg.analyst?.seatReport?.start);
  num('analyst.seatReport.end', cfg.analyst?.seatReport?.end);
  num('analyst.globalReport.start', cfg.analyst?.globalReport?.start);
  num('analyst.globalReport.end', cfg.analyst?.globalReport?.end);
  num('randomSwing', cfg.randomSwing);
  num('durations.countingMs', cfg.durations?.countingMs, 0, true);
  num('durations.countingMsTwoPlayers', cfg.durations?.countingMsTwoPlayers, 0, true);
  num('durations.countingStepMs', cfg.durations?.countingStepMs, 0, true);
  num('counting.winStartFraction', cfg.counting?.winStartFraction, 0, true);
  num('counting.allLeadsByFraction', cfg.counting?.allLeadsByFraction, 0, true);
  num('counting.leadNoiseStart', cfg.counting?.leadNoiseStart);
  num('counting.leadNoiseExponent', cfg.counting?.leadNoiseExponent);
  num('counting.leadNoiseEpochFraction', cfg.counting?.leadNoiseEpochFraction, 0, true);
  num('counting.winJitter', cfg.counting?.winJitter);
  if (!cfg.points?.portfolios?.length) bad('points.portfolios', 'must list at least one portfolio');
}

export const WORLD_CONFIG: MapConfig = {
  mapId: 'world-500',
  seatCount: 500,
  ...GAME_CONFIG_VALUES,
};
validateConfig(WORLD_CONFIG);

export const MAP_CONFIGS: Record<string, MapConfig> = { 'world-500': WORLD_CONFIG };

/**
 * MapConfig for any map folder under maps/. Maps without their own entry in MAP_CONFIGS get a copy of
 * WORLD_CONFIG with mapId / seatCount replaced; per-map tuning should be added via the simulator (game/sim).
 */
export function configForMap(mapId: string, seatCount: number): MapConfig {
  return MAP_CONFIGS[mapId] ?? { ...WORLD_CONFIG, mapId, seatCount };
}
