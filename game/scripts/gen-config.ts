// Game-constants generator.  Run from game/:  npx tsx scripts/gen-config.ts   (npm run gen:config)
//
// Reads config/game.properties (the file the designer edits to tune the game) and writes
//   shared/src/config.generated.ts   -> GAME_CONFIG_VALUES (nested object, same shape as MapConfig minus mapId / seatCount)
// shared/src/mapConfig.ts builds WORLD_CONFIG from it, so the server, web app, agent, simulator and tests all read the
// properties file and no number is hard-coded in the engine. The generated file is committed.
// Exits non-zero on a missing / malformed key or an unknown key (typos are errors, not silently ignored).
//
// Options:
//   --file=PATH  read PATH instead of config/game.properties (or env HP_CONFIG_FILE)
//   --dry        validate only, write nothing
//   --check      validate and fail (exit 2) if the committed generated file differs from what would be written
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gameDir = path.resolve(here, '..');
const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = path.resolve(flagValue('file') ?? process.env.HP_CONFIG_FILE ?? path.join(gameDir, 'config/game.properties'));
const DRY = argv.includes('--dry');
const CHECK = argv.includes('--check');

type Kind = 'number' | 'string';
/** Every key the game understands (portfolios and committed-voter bands are numbered: points.portfolios.<1..n>.<field>, committed.bands.<1..n>.<field>). */
const NUMBER_KEYS = [
  'budget', 'costs.rally', 'costs.roadshow',
  'analyst.seatReport.start', 'analyst.seatReport.end', 'analyst.globalReport.start', 'analyst.globalReport.end',
  'analyst.delayMs', 'analyst.noise', 'analyst.marginFactor',
  'effects.rally.local', 'effects.rally.global',
  'effects.rally.decay.halfDistanceKm', 'effects.rally.decay.maxKm', 'effects.rally.decay.capRatio',
  'effects.roadshow.local',
  'effects.roadshow.decay.halfDistanceKm', 'effects.roadshow.decay.maxKm', 'effects.roadshow.decay.capRatio',
  'effects.firstMover.rally', 'effects.firstMover.roadshow',
  'timeMultiplier.start', 'timeMultiplier.end',
  'committed.seatMaxPercent', 'voting.influenceMaxPercent', 'voting.randomMaxPercent',
  'phases.min', 'phases.max', 'phases.default', 'players.min', 'players.max',
  'durations.campaignMs', 'durations.countingMs', 'durations.countingMsTwoPlayers', 'durations.countingStepMs',
  'durations.postCountingMs', 'durations.postCountingMsTwoPlayers', 'durations.graceMs',
  'connection.retryMs',
  'counting.winStartFraction', 'counting.allLeadsByFraction', 'counting.leadNoiseStart', 'counting.leadNoiseExponent',
  'counting.leadNoiseEpochFraction', 'counting.winJitter',
  'counting.pieRefreshMs', 'counting.panelDisplayMs', 'counting.panelStaggerMs',
  'counting.panelRunnerUpPercent', 'counting.panelOtherPercent',
  'points.seatMultiplier', 'points.governmentFloor', 'points.opposition',
];
const STRING_KEYS = ['currency.name', 'currency.symbol', 'messaging.mode', 'messaging.opensAt'];
const PORTFOLIO_FIELDS: Record<string, Kind> = { id: 'string', label: 'string', points: 'number', max: 'number' };
const BAND_FIELDS: Record<string, Kind> = { percent: 'number', seats: 'number', level: 'string' };
const BAND_LEVELS = ['HIGH', 'MEDIUM', 'LOW'];

const errors: string[] = [];
if (!fs.existsSync(file)) { console.error(`config file not found: ${file}`); process.exit(1); }

const raw = new Map<string, { value: string; line: number }>();
fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).forEach((text, i) => {
  const t = text.trim();
  if (!t || t.startsWith('#') || t.startsWith('!')) return;
  const eq = t.indexOf('=');
  if (eq < 1) { errors.push(`line ${i + 1}: expected key=value, got "${t}"`); return; }
  const key = t.slice(0, eq).trim();
  if (raw.has(key)) errors.push(`line ${i + 1}: duplicate key "${key}"`);
  raw.set(key, { value: t.slice(eq + 1).trim(), line: i + 1 });
});

const used = new Set<string>();
function take(key: string, kind: Kind): number | string | undefined {
  const e = raw.get(key);
  if (!e) { errors.push(`missing key "${key}"`); return undefined; }
  used.add(key);
  if (kind === 'string') {
    if (!e.value) errors.push(`line ${e.line}: "${key}" must not be empty`);
    return e.value;
  }
  const n = Number(e.value.replace(/_/g, ''));
  if (e.value === '' || !Number.isFinite(n)) { errors.push(`line ${e.line}: "${key}" must be a number, got "${e.value}"`); return undefined; }
  return n;
}
function put(obj: Record<string, any>, key: string, v: unknown) {
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) o = (o[p] ??= {});
  o[parts[parts.length - 1]] = v;
}

const values: Record<string, any> = {};
for (const k of NUMBER_KEYS) put(values, k, take(k, 'number'));
for (const k of STRING_KEYS) put(values, k, take(k, 'string'));

const portfolioNums = [...new Set([...raw.keys()].map(k => /^points\.portfolios\.(\d+)\./.exec(k)?.[1]).filter((x): x is string => !!x))]
  .map(Number).sort((a, b) => a - b);
if (!portfolioNums.length) errors.push('no portfolios defined (points.portfolios.1.id ...)');
portfolioNums.forEach((n, i) => { if (n !== i + 1) errors.push(`portfolios must be numbered 1..n without gaps (found ${n} at position ${i + 1})`); });
values.points.portfolios = portfolioNums.map(n => Object.fromEntries(
  Object.entries(PORTFOLIO_FIELDS).map(([f, kind]) => [f, take(`points.portfolios.${n}.${f}`, kind)])));
const bandNums = [...new Set([...raw.keys()].map(k => /^committed\.bands\.(\d+)\./.exec(k)?.[1]).filter((x): x is string => !!x))]
  .map(Number).sort((a, b) => a - b);
bandNums.forEach((n, i) => { if (n !== i + 1) errors.push(`committed bands must be numbered 1..n without gaps (found ${n} at position ${i + 1})`); });
values.committed.bands = bandNums.map(n => Object.fromEntries(
  Object.entries(BAND_FIELDS).map(([f, kind]) => [f, take(`committed.bands.${n}.${f}`, kind)])));
for (const key of raw.keys()) if (!used.has(key)) errors.push(`line ${raw.get(key)!.line}: unknown key "${key}" (typo?)`);

// Sanity rules (the same ones are re-checked at run time by validateConfig in shared/src/mapConfig.ts).
const val = (k: string): number => k.split('.').reduce((o: any, p) => o?.[p], values) as number;
const rule = (ok: boolean, msg: string) => { if (!ok) errors.push(msg); };
if (!errors.length) {
  rule(val('budget') > 0, 'budget must be > 0');
  for (const k of ['costs.rally', 'costs.roadshow']) rule(val(k) > 0, `${k} must be > 0`);
  for (const k of ['effects.firstMover.rally', 'effects.firstMover.roadshow']) rule(val(k) >= 0, `${k} must be >= 0`);
  rule(val('players.min') >= 2 && val('players.max') >= val('players.min'), 'players: need 2 <= min <= max');
  rule(val('phases.min') >= 1 && val('phases.max') >= val('phases.min'), 'phases: need 1 <= min <= max');
  rule(val('phases.default') >= val('phases.min') && val('phases.default') <= val('phases.max'), 'phases.default must be within min..max');
  rule(val('durations.countingMs') > 0 && val('durations.countingMsTwoPlayers') > 0 && val('durations.countingStepMs') > 0, 'durations.countingMs / countingMsTwoPlayers / countingStepMs must be > 0');
  rule(['group', 'individual'].includes(val('messaging.mode') as unknown as string), 'messaging.mode must be "group" or "individual"');
  rule(['campaign', 'counting'].includes(val('messaging.opensAt') as unknown as string), 'messaging.opensAt must be "campaign" or "counting"');
  rule(val('connection.retryMs') >= 1000, 'connection.retryMs must be >= 1000 (ms between browser reconnect attempts)');
  rule(val('counting.winStartFraction') > 0 && val('counting.winStartFraction') <= 1, 'counting.winStartFraction must be in (0, 1]');
  rule(val('counting.allLeadsByFraction') > 0 && val('counting.allLeadsByFraction') <= val('counting.winStartFraction'), 'counting.allLeadsByFraction must be in (0, winStartFraction]');
  rule(val('counting.leadNoiseStart') >= 0 && val('counting.leadNoiseExponent') >= 0 && val('counting.winJitter') >= 0, 'counting.leadNoiseStart / leadNoiseExponent / winJitter must be >= 0');
  rule(val('counting.leadNoiseEpochFraction') > 0 && val('counting.leadNoiseEpochFraction') <= 1, 'counting.leadNoiseEpochFraction must be in (0, 1]');
  rule(val('counting.pieRefreshMs') >= 250, 'counting.pieRefreshMs must be >= 250 (ms between pie chart refreshes)');
  rule(val('counting.panelDisplayMs') > 0, 'counting.panelDisplayMs must be > 0');
  rule(val('counting.panelStaggerMs') >= 0 && val('counting.panelStaggerMs') < val('counting.panelDisplayMs'), 'counting.panelStaggerMs must be >= 0 and shorter than counting.panelDisplayMs');
  for (const k of ['counting.panelRunnerUpPercent', 'counting.panelOtherPercent']) rule(val(k) >= 0 && val(k) <= 100, `${k} must be in 0..100`);
  rule(val('counting.panelRunnerUpPercent') + val('counting.panelOtherPercent') === 100, 'counting.panelOtherPercent + counting.panelRunnerUpPercent must add up to 100');
  rule(val('committed.seatMaxPercent') >= 0 && val('committed.seatMaxPercent') <= 100, 'committed.seatMaxPercent must be in 0..100');
  for (const k of ['voting.influenceMaxPercent', 'voting.randomMaxPercent']) rule(val(k) >= 0 && val(k) <= 100, `${k} must be in 0..100`);
  values.committed.bands.forEach((b: { percent: number; seats: number; level: string }, i: number) => {
    rule(b.percent >= 0 && b.percent <= 100, `committed.bands.${i + 1}.percent must be in 0..100`);
    rule(Number.isInteger(b.seats) && b.seats >= 0, `committed.bands.${i + 1}.seats must be a whole number >= 0`);
    rule(BAND_LEVELS.includes(b.level), `committed.bands.${i + 1}.level must be one of ${BAND_LEVELS.join(' / ')}`);
  });
  rule(val('analyst.seatReport.end') >=val('analyst.seatReport.start') && val('analyst.globalReport.end') >= val('analyst.globalReport.start'), 'analyst report end price must be >= start price');
}
if (errors.length) { console.error(`config FAILED (${path.relative(gameDir, file)}):\n  ` + errors.join('\n  ')); process.exit(1); }

const out = path.join(gameDir, 'shared/src/config.generated.ts');
const text = '// GENERATED by game/scripts/gen-config.ts from game/config/game.properties - do not edit. Edit the .properties file, then `npm run gen:config` (in game/).\n' +
  'export const GAME_CONFIG_VALUES = ' + JSON.stringify(values, null, 2) + ';\n';
if (CHECK) {
  const norm = (t: string) => t.replace(/\r\n/g, '\n');
  if (!fs.existsSync(out) || norm(fs.readFileSync(out, 'utf8')) !== text) {
    console.error('shared/src/config.generated.ts is STALE (run `npm run gen:config` and commit).');
    process.exit(2);
  }
} else if (!DRY) {
  fs.writeFileSync(out, text);
}
console.log(`gen-config: ${raw.size} keys from ${path.relative(gameDir, file)} (${portfolioNums.length} portfolios, ${bandNums.length} committed-voter bands)`);
