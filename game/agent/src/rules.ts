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

const CRORE = 10_000_000;
const trim = (n: number, d = 2): string => String(Number(n.toFixed(d)));
const group = (n: number): string => n.toLocaleString('en-US');

export const crore = (cfg: MapConfig, n: number): string => `${cfg.currency.symbol}${trim(n / CRORE)} crore`;

export interface RenderOptions {
  mapName?: string;
  /** Actual timeline of the joined game (overrides the config's default durations in the text). */
  timeline?: GameTimeline | null;
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
  return {
    MAP_NAME: opts.mapName ?? cfg.mapId,
    PLAYERS_MIN: String(cfg.players.min),
    PLAYERS_MAX: String(cfg.players.max),
    SEATS: String(n),
    MAJORITY: String(majorityOf(n)),
    CURRENCY: cfg.currency.name,
    SYM: cfg.currency.symbol,
    PHASES_MIN: String(cfg.phases.min),
    PHASES_MAX: String(cfg.phases.max),
    BUDGET: group(cfg.budget),
    BUDGET_CR: crore(cfg, cfg.budget),
    RALLY_COST_CR: crore(cfg, cfg.costs.rally),
    ROADSHOW_COST_CR: crore(cfg, cfg.costs.roadshow),
    MAX_RALLIES: String(Math.floor(cfg.budget / cfg.costs.rally)),
    MAX_ROADSHOWS: String(Math.floor(cfg.budget / cfg.costs.roadshow)),
    SEAT_REPORT_START_CR: crore(cfg, cfg.analyst.seatReport.start),
    SEAT_REPORT_END_CR: crore(cfg, cfg.analyst.seatReport.end),
    GLOBAL_REPORT_START_CR: crore(cfg, cfg.analyst.globalReport.start),
    GLOBAL_REPORT_END_CR: crore(cfg, cfg.analyst.globalReport.end),
    RALLY_LOCAL: trim(r.local),
    RALLY_GLOBAL: trim(r.global, 4),
    RALLY_HALF: String(r.decay.halfDistanceKm),
    RALLY_MAX: String(r.decay.maxKm),
    RALLY_CAP: trim(r.decay.capRatio),
    ROADSHOW_LOCAL: trim(s.local),
    ROADSHOW_HALF: String(s.decay.halfDistanceKm),
    ROADSHOW_MAX: String(s.decay.maxKm),
    ROADSHOW_CAP: trim(s.decay.capRatio),
    S_OVER_Y: trim(s.local / r.local),
    COST_RATIO: `1/${trim(cfg.costs.rally / cfg.costs.roadshow, 1)}`,
    TM_START: trim(cfg.timeMultiplier.start),
    TM_END: trim(cfg.timeMultiplier.end),
    REPORT_DELAY_S: String(Math.round(cfg.analyst.delayMs / 1000)),
    NOISE_PCT: String(Math.round(cfg.analyst.noise * 100)),
    SWING_PCT: String(Math.round(cfg.randomSwing * 100)),
    CAMPAIGN_MIN: minutes(campaignMs),
    COUNTING_MIN: minutes(countingMs),
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
