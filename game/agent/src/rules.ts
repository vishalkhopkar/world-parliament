// Renders RULES.md (a template with {{PLACEHOLDERS}}) from the live MapConfig so the numbers can never go stale.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP_CONFIGS, WORLD_CONFIG, majorityOf } from '@hp/shared';
import type { GameTimeline, MapConfig } from '@hp/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RULES_TEMPLATE_PATH = resolve(HERE, '..', 'RULES.md');

export function rulesTemplate(): string { return readFileSync(RULES_TEMPLATE_PATH, 'utf8'); }

/** MapConfig for a map id (falls back to WORLD_CONFIG, e.g. when the id is a renamed registry id). */
export function configForMap(mapId: string | null | undefined): MapConfig {
  if (mapId && MAP_CONFIGS[mapId]) return MAP_CONFIGS[mapId];
  if (mapId) {
    const byId = Object.values(MAP_CONFIGS).find((c) => c.mapId === mapId);
    if (byId) return byId;
  }
  return WORLD_CONFIG;
}

/** One standard deviation (km) of a Gaussian exp(-spread x^2) with x = km / unitKm: exp(-km^2 / (2 sigma^2)) -> sigma = unit / sqrt(2 spread). */
const sigmaKm = (unitKm: number, spread: number): number => unitKm / Math.sqrt(2 * spread);
/** Most rallies one player can hold in a campaign: limited by budget and by the cooldown (the first rally is free of waiting). */
export function maxRallies(cfg: MapConfig, campaignMs: number): number {
  const byBudget = Math.floor(cfg.budget / cfg.costs.rally);
  return cfg.cooldowns.rallyMs > 0 ? Math.min(byBudget, Math.floor(campaignMs / cfg.cooldowns.rallyMs) + 1) : byBudget;
}
const trim = (n: number, d = 2): string => String(Number(n.toFixed(d)));
const group = (n: number): string => n.toLocaleString('en-US');

/** Whole-number money with thousands separators, e.g. W₹50,000. */
export const money = (cfg: MapConfig, n: number): string => `${cfg.currency.symbol}${group(Math.round(n))}`;

export interface RenderOptions {
  mapName?: string;
  /** Actual timeline of the joined game (overrides the config's default durations in the text). */
  timeline?: GameTimeline | null;
}

const SWITCHED_OFF = 'currently switched off in this game';

/** First bullet of RULES section 5: which reports can be bought in this game. */
function reportsStatus(cfg: MapConfig): string {
  const seat = cfg.analyst.seatReport.enabled, global = cfg.analyst.globalReport.enabled;
  if (seat && global) return 'Both reports (seat and global) are on sale in this game.';
  if (!seat && !global) {
    return 'Analyst reports are currently switched off in this game: `buy_report` is refused for both scopes (nothing is charged). Ignore the rest of this section, and put the whole budget into campaigning.';
  }
  return `The ${seat ? 'global' : 'seat'} report is currently switched off in this game: \`buy_report\` refuses that scope (nothing is charged). Only the ${seat ? 'seat' : 'global'} report can be bought.`;
}

export function rulesValues(cfg: MapConfig, opts: RenderOptions = {}): Record<string, string> {
  const n = cfg.seatCount;
  const minutes = (ms: number) => trim(ms / 60_000, 1);
  const tl = opts.timeline;
  const campaignMs = tl ? tl.campaignEnd - tl.campaignStart : cfg.durations.campaignMs;
  const countingMs = tl ? tl.countingEnd - tl.campaignEnd : cfg.durations.countingMs;
  const postMs = tl ? tl.postCountingEnd - tl.countingEnd : cfg.durations.postCountingMs;
  const r = cfg.effects.rally;
  const s = cfg.effects.roadshow;
  const exampleSeats = Math.max(1, Math.round(n * 0.24));
  const dpm = cfg.points.portfolios.find((p) => p.id === 'DPM')?.points ?? 50;
  const exampleSeatPts = Math.round((cfg.points.seatMultiplier * exampleSeats) / n);
  const table = [
    '  | Portfolio id | Meaning | Points | Max holders |',
    '  |---|---|---|---|',
    ...cfg.points.portfolios.map((p) => `  | \`${p.id}\` | ${p.label} | ${p.points} | ${p.max} |`),
  ].join('\n');
  const bandTable = [
    '  | Band | Committed share of the seat | Seats | Level |',
    '  |---|---|---|---|',
    ...cfg.committed.bands.map((b, i) => `  | ${i + 1} | ~${b.percent}% | ${b.seats} | ${b.level} |`),
  ].join('\n');
  return {
    MAP_NAME: opts.mapName ?? cfg.mapId,
    PLAYERS_MIN: String(cfg.players.min),
    PLAYERS_MAX: String(cfg.players.max),
    SEATS: String(n),
    MAJORITY: String(majorityOf(n)),
    CHAT_RULE: (cfg.messaging.mode === 'group'
      ? '**Group chat**: `chat {text}` posts to ONE common chat that everyone in the game reads (the `to` list is ignored). Read what others wrote with `get_chat` or `wait_for_events`.'
      : '**Private chat**: `chat {to:[names], text}` to one or more players. Only you and the recipients see it. Read replies with `get_chat` or `wait_for_events`.')
      + (cfg.messaging.opensAt === 'campaign'
        ? ' Chat opens at the start of the campaign (not only at counting) and stays open until the end of the game.'
        : ' Chat opens when counting starts and stays open until the end of the game.'),
    CURRENCY: cfg.currency.name,
    SYM: cfg.currency.symbol,
    PHASES_MIN: String(cfg.phases.min),
    PHASES_MAX: String(cfg.phases.max),
    BUDGET_TEXT: money(cfg, cfg.budget),
    RALLY_COST_TEXT: money(cfg, cfg.costs.rally),
    ROADSHOW_COST_TEXT: money(cfg, cfg.costs.roadshow),
    MAX_RALLIES: String(Math.floor(cfg.budget / cfg.costs.rally)),
    MAX_RALLIES_EFFECTIVE: String(maxRallies(cfg, campaignMs)),
    MAX_ROADSHOWS: String(Math.floor(cfg.budget / cfg.costs.roadshow)),
    SEAT_REPORT_PRICE_TEXT: cfg.analyst.seatReport.enabled
      ? `${money(cfg, cfg.analyst.seatReport.start)} at campaign start, rising linearly to ${money(cfg, cfg.analyst.seatReport.end)} at the end`
      : SWITCHED_OFF,
    GLOBAL_REPORT_PRICE_TEXT: cfg.analyst.globalReport.enabled
      ? `${money(cfg, cfg.analyst.globalReport.start)} rising linearly to ${money(cfg, cfg.analyst.globalReport.end)}`
      : SWITCHED_OFF,
    REPORTS_STATUS: reportsStatus(cfg),
    SEAT_REPORT_START_TEXT: money(cfg, cfg.analyst.seatReport.start),
    SEAT_REPORT_END_TEXT: money(cfg, cfg.analyst.seatReport.end),
    GLOBAL_REPORT_START_TEXT: money(cfg, cfg.analyst.globalReport.start),
    GLOBAL_REPORT_END_TEXT: money(cfg, cfg.analyst.globalReport.end),
    RALLY_LOCAL: trim(r.local),
    RALLY_GLOBAL: trim(r.global, 4),
    RALLY_SPREAD_KM: String(Math.round(sigmaKm(cfg.effects.distanceUnitKm, r.decay.spread))),
    RALLY_SPREAD: trim(r.decay.spread),
    ROADSHOW_SPREAD: trim(s.decay.spread),
    RALLY_REACH_KM: String(r.decay.maxKm),
    RALLY_AT_1UNIT: trim(r.local * Math.exp(-r.decay.spread), 2),
    ROADSHOW_LOCAL: trim(s.local),
    ROADSHOW_SIGMA_KM: String(Math.round(sigmaKm(cfg.effects.distanceUnitKm, s.decay.spread))),
    ROADSHOW_REACH_KM: String(s.decay.maxKm),
    DISTANCE_UNIT_KM: String(cfg.effects.distanceUnitKm),
    RALLY_COOLDOWN_S: String(Math.round(cfg.cooldowns.rallyMs / 1000)),
    FIRST_MOVER_RALLY: trim(cfg.effects.firstMover.rally),
    FIRST_MOVER_ROADSHOW: trim(cfg.effects.firstMover.roadshow),
    COST_RATIO: `1/${trim(cfg.costs.rally / cfg.costs.roadshow, 1)}`,
    TM_START: trim(cfg.timeMultiplier.start),
    TM_END: trim(cfg.timeMultiplier.end),
    REPORT_DELAY_S: String(Math.round(cfg.analyst.delayMs / 1000)),
    NOISE_PCT: String(Math.round(cfg.analyst.noise * 100)),
    INFLUENCE_PCT: String(cfg.voting.influenceMaxPercent),
    RANDOM_PCT: String(cfg.voting.randomMaxPercent),
    REPUTATION_SCALE: String(cfg.display.reputationScale),
    SEAT_CAP_PCT: String(cfg.committed.seatMaxPercent),
    COMMITTED_SEATS: String(cfg.committed.bands.reduce((a, b) => a + b.seats, 0)),
    COMMITTED_BAND_COUNT: String(cfg.committed.bands.length),
    COMMITTED_TABLE: bandTable,
    CAMPAIGN_MIN: minutes(campaignMs),
    COUNTING_MIN: minutes(countingMs),
    COUNTING_MIN_2P: minutes(cfg.durations.countingMsTwoPlayers),
    COUNTING_MIN_3P: minutes(cfg.durations.countingMs),
    WIN_START_PCT: String(Math.round(cfg.counting.winStartFraction * 100)),
    LEADS_BY_PCT: String(Math.round(cfg.counting.allLeadsByFraction * 100)),
    POST_MIN: minutes(postMs),
    GRACE_S: String(Math.round(cfg.durations.graceMs / 1000)),
    PORTFOLIO_TABLE: table,
    SEAT_MULT: String(cfg.points.seatMultiplier),
    GOV_FLOOR: String(cfg.points.governmentFloor),
    OPP_POINTS: String(cfg.points.opposition),
    DPM_POINTS: String(dpm),
    PM_POINTS: String(cfg.points.portfolios.find((p) => p.id === 'PM')?.points ?? 100),
    EXAMPLE_SEATS: String(exampleSeats),
    EXAMPLE_SEAT_PTS: String(exampleSeatPts),
    EXAMPLE_TOTAL: String(dpm + exampleSeatPts + cfg.points.governmentFloor),
  };
}

export function renderRules(cfg: MapConfig, opts: RenderOptions = {}, template = rulesTemplate()): string {
  const v = rulesValues(cfg, opts);
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, k: string) => {
    if (!(k in v)) throw new Error(`RULES.md placeholder {{${k}}} has no value`);
    return v[k];
  });
  return out;
}
