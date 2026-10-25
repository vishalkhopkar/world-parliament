// Per-map tuning types and the game constants. The NUMBERS live in game/config/game.properties (edit that file, not this
// one); `npm run gen:config` turns it into config.generated.ts, which WORLD_CONFIG is built from. A new map (e.g. India)
// only needs a map package; it gets a copy of these values unless MAP_CONFIGS has an entry for it.
import { GAME_CONFIG_VALUES } from './config.generated';

export interface DecayParams {
  /** Gaussian width: the spill-over is exp(-spread x x^2) with x = distance_km / effects.distanceUnitKm (larger = narrower). */
  spread: number;
  /** Beyond this distance the Gaussian part is exactly 0 (a rally keeps only its global part). */
  maxKm: number;
}

export interface EffectParams {
  /** Distances are measured in units of this many km: x = distance_km / distanceUnitKm. */
  distanceUnitKm: number;
  rally: {
    local: number;      // peak of the Gaussian: the effect in the seat where the rally is held
    global: number;     // c : added to EVERY open seat (news/social media), including the rally seat, at any distance
    decay: DecayParams; // rally in a seat = global + local * exp(-spread x^2)
  };
  roadshow: {
    local: number;      // effect in the seat of the roadshow
    decay: DecayParams; // roadshow in a seat = local * exp(-spread x^2); no global part
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

/** Colour shade / label group of a committed-voter band. */
export type CommittedLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface CommittedBand {
  /** Share of the seat's voters committed to the party, in % (30 = 30%). */
  percent: number;
  /** How many seats get this band (filled in band order by the breadth-first walk from the core seat). */
  seats: number;
  level: CommittedLevel;
}

export interface CommittedConfig {
  /** Band 1 first (the core seat and its nearest seats), then band 2, ... */
  bands: CommittedBand[];
  /** A seat is skipped for a band that would take its committed total (all parties) above this %. */
  seatMaxPercent: number;
}

export interface VotingConfig {
  /** Each committed party brings extra voters: a random 0..this % of its committed voters (relative). */
  influenceMaxPercent: number;
  /** A random 0..this % of the uncommitted voters vote for random parties in random amounts. */
  randomMaxPercent: number;
}

/** 'group' = one common chat, every message readable by everybody; 'individual' = private threads. */
export type MessagingMode = 'group' | 'individual';
/** When the chat opens: at the start of the campaign, or only once counting has started. */
export type ChatOpensAt = 'campaign' | 'counting';

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
  /** Seat pie chart: how often (ms) an open pie of a LEADING seat fetches the current shares again. */
  pieRefreshMs: number;
  /** Result panels: how long (ms) each card stays. */
  panelDisplayMs: number;
  /** Result panels: panel k first appears k x this many ms after panel 0 (and keeps the offset when refreshing). */
  panelStaggerMs: number;
  /** A TRAILS / LOST card shows the seat's runner-up this % of the time... */
  panelRunnerUpPercent: number;
  /** ...and a random other non-leading party this % of the time (the two add up to 100). */
  panelOtherPercent: number;
}

export interface MapConfig {
  mapId: string;
  seatCount: number;
  currency: { name: string; symbol: string };
  /** Starting budget per player (whole World Rupees). */
  budget: number;
  costs: { rally: number; roadshow: number };
  effects: EffectParams;
  /** Rate limits. */
  cooldowns: {
    /** Minimum gap (ms) between two rallies of the same player (the leader has to be present). Roadshows have no cooldown. 0 = off. */
    rallyMs: number;
  };
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
  /** Committed voters per party (bands dealt around a core seat). */
  committed: CommittedConfig;
  /** How a seat's votes are made up: committed, influence, randomness, then reputation. */
  voting: VotingConfig;
  /** What players see: a party's own reputation in a seat is shown as round(engine reputation x reputationScale). */
  display: { reputationScale: number };
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
  /** Chat between players during counting / post-counting: one group chat everybody reads, or private threads. */
  messaging: { mode: MessagingMode; opensAt: ChatOpensAt };
  /** Browser connection behaviour. */
  connection: {
    /** Milliseconds between automatic reconnect attempts while the link is down (min 1000). */
    retryMs: number;
  };
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
    num(`${k}.spread`, d?.spread, 0, true);
    num(`${k}.maxKm`, d?.maxKm);
  };
  num('effects.distanceUnitKm', cfg.effects?.distanceUnitKm, 0, true);
  num('effects.rally.local', cfg.effects?.rally?.local, 0, true);
  num('effects.rally.global', cfg.effects?.rally?.global);
  decay('effects.rally.decay', cfg.effects?.rally?.decay);
  num('effects.roadshow.local', cfg.effects?.roadshow?.local, 0, true);
  decay('effects.roadshow.decay', cfg.effects?.roadshow?.decay);
  num('effects.firstMover.rally', cfg.effects?.firstMover?.rally);
  num('effects.firstMover.roadshow', cfg.effects?.firstMover?.roadshow);
  num('cooldowns.rallyMs', cfg.cooldowns?.rallyMs);
  num('timeMultiplier.start', cfg.timeMultiplier?.start);
  num('timeMultiplier.end', cfg.timeMultiplier?.end);
  num('analyst.seatReport.start', cfg.analyst?.seatReport?.start);
  num('analyst.seatReport.end', cfg.analyst?.seatReport?.end);
  num('analyst.globalReport.start', cfg.analyst?.globalReport?.start);
  num('analyst.globalReport.end', cfg.analyst?.globalReport?.end);
  const pct = (key: string, v: unknown) => {
    num(key, v);
    if ((v as number) > 100) bad(key, `must be <= 100 (got ${String(v)})`);
  };
  pct('committed.seatMaxPercent', cfg.committed?.seatMaxPercent);
  pct('voting.influenceMaxPercent', cfg.voting?.influenceMaxPercent);
  pct('voting.randomMaxPercent', cfg.voting?.randomMaxPercent);
  num('display.reputationScale', cfg.display?.reputationScale, 0, true);
  if (!Array.isArray(cfg.committed?.bands)) bad('committed.bands', 'must be a list');
  cfg.committed.bands.forEach((b, i) => {
    pct(`committed.bands.${i + 1}.percent`, b?.percent);
    if (!Number.isInteger(b?.seats) || b.seats < 0) bad(`committed.bands.${i + 1}.seats`, `must be a whole number >= 0 (got ${String(b?.seats)})`);
    if (b.level !== 'HIGH' && b.level !== 'MEDIUM' && b.level !== 'LOW') bad(`committed.bands.${i + 1}.level`, `must be HIGH, MEDIUM or LOW (got ${String(b.level)})`);
  });
  if (cfg.messaging?.mode !== 'group' && cfg.messaging?.mode !== 'individual') bad('messaging.mode', `must be "group" or "individual" (got ${String(cfg.messaging?.mode)})`);
  if (cfg.messaging?.opensAt !== 'campaign' && cfg.messaging?.opensAt !== 'counting') bad('messaging.opensAt', `must be "campaign" or "counting" (got ${String(cfg.messaging?.opensAt)})`);
  num('connection.retryMs', cfg.connection?.retryMs, 999, true);
  num('durations.countingMs', cfg.durations?.countingMs, 0, true);
  num('durations.countingMsTwoPlayers', cfg.durations?.countingMsTwoPlayers, 0, true);
  num('durations.countingStepMs', cfg.durations?.countingStepMs, 0, true);
  num('counting.winStartFraction', cfg.counting?.winStartFraction, 0, true);
  num('counting.allLeadsByFraction', cfg.counting?.allLeadsByFraction, 0, true);
  num('counting.leadNoiseStart', cfg.counting?.leadNoiseStart);
  num('counting.leadNoiseExponent', cfg.counting?.leadNoiseExponent);
  num('counting.leadNoiseEpochFraction', cfg.counting?.leadNoiseEpochFraction, 0, true);
  num('counting.winJitter', cfg.counting?.winJitter);
  num('counting.pieRefreshMs', cfg.counting?.pieRefreshMs, 249, true);
  num('counting.panelDisplayMs', cfg.counting?.panelDisplayMs, 0, true);
  num('counting.panelStaggerMs', cfg.counting?.panelStaggerMs);
  if (cfg.counting.panelStaggerMs >= cfg.counting.panelDisplayMs) bad('counting.panelStaggerMs', 'must be shorter than counting.panelDisplayMs');
  num('counting.panelRunnerUpPercent', cfg.counting?.panelRunnerUpPercent);
  num('counting.panelOtherPercent', cfg.counting?.panelOtherPercent);
  if (cfg.counting.panelRunnerUpPercent > 100 || cfg.counting.panelRunnerUpPercent + cfg.counting.panelOtherPercent !== 100) {
    bad('counting.panelOtherPercent', 'must add up to 100 together with counting.panelRunnerUpPercent');
  }
  if (!cfg.points?.portfolios?.length) bad('points.portfolios', 'must list at least one portfolio');
}

export const WORLD_CONFIG: MapConfig = {
  mapId: 'world-500',
  seatCount: 500,
  ...GAME_CONFIG_VALUES,
  // the generated file types the mode as a plain string; validateConfig below checks it
  messaging: GAME_CONFIG_VALUES.messaging as MapConfig['messaging'],
  committed: GAME_CONFIG_VALUES.committed as MapConfig['committed'],
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
