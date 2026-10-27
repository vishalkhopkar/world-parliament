import type { MapConfig } from '../mapConfig';
import { WORLD_CONFIG } from '../mapConfig';
import type { GlobalReportPoint, GlobalReports, NewsAgencyReport } from '../protocol';
import type { Action, GameMapPackage, GameTimeline, PlayerId, SeatResult } from '../types';
import { computeEffects } from './effects';
import { createRng, gaussian } from './rng';
import type { Committed, Kernels } from './types';
import { expectedShareArray } from './votes';

/**
 * News agencies ("global reports"): free, noised projections of every party's seats over time. Pure functions; the server calls
 * buildGlobalReports with the same inputs buyReport uses. Everything tunable is in cfg.news (game.properties `news.*`).
 *
 * Model per sample time t (sample k is at campaignStart + k x interval, see newsSampleTimes):
 *  - true projection = per party the SUM over seats of its expected vote share (smooth, unlike counting wins). A seat whose phase
 *    has closed by t and has a poll result counts for its real winner. At k = 0 every agency shows seats / parties exactly.
 *  - error rate of an agency  err(t) = e0 x (end + (1 - end) x exp(-k f)) x (1 + noise x eps_k), clamped to [errorWobbleMin, errorWobbleMax] (0.5 / 1.5) of the trend,
 *    with f = elapsed campaign fraction, e0 drawn once per agency in [errorStartMinPct, errorStartMaxPct]%, end = errorEndFraction,
 *    k = errorDecayRate, noise = errorNoise and eps_k a smoothed (AR(1), noiseSmoothing) seeded standard-normal sequence with eps_0 = 0.
 *  - point = true x (1 + err x gaussian) per party, floored at 0, then rescaled so the parties add up to the seat count.
 *  - range of a party (latest point p) = [round(p (1 - err)), round(p (1 + err))] clamped to [0, seatCount].
 * Seeds: `${seed}:news:${agencyId}:${k}` for the points (first draw = eps_k, then one gaussian per party in player order) and
 * `${seed}:news:${agencyId}:e0` for the start error, with seed = newsSeed(gameId, secret). The secret is a server-only random string
 * per game (GameRecord.newsSecret, never sent to a client): the game id alone is public and the generator is in the client bundle, so
 * a client that could rebuild the noise could invert it and read the true projection. Same secret -> identical series on every call,
 * so a series needs no storage.
 * cfg.news.enabled is NOT checked here: the caller (server) refuses the request when the feature is switched off.
 */

/** Seed base of one game's news noise: the public game id mixed with the server-only secret. Throws on an empty secret (fail safe). */
export function newsSeed(gameId: string, secret: string): string {
  if (!secret) throw new Error('news noise needs a non-empty server-only secret');
  return `${gameId}:${secret}`;
}

export interface NewsAgency {
  /** Name lower-cased, runs of other characters replaced by "-" (unique: a repeat gets "-2", "-3" ...). */
  id: string;
  name: string;
}

/** "Kal Tak" -> "kal-tak" (lower case; every run of characters other than a-z 0-9 becomes one dash; none at the ends). */
export function newsAgencyId(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'agency';
}

/** The agencies of a config, in display order, with unique ids. */
export function newsAgencies(cfg: MapConfig): NewsAgency[] {
  const seen = new Map<string, number>();
  return cfg.news.agencies.map((a) => {
    const base = newsAgencyId(a.name);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: n === 1 ? base : `${base}-${n}`, name: a.name };
  });
}

/** The agencies of the shipped config (Kal Tak, Toofan Express, Woof News, World Today). */
export const NEWS_AGENCIES: NewsAgency[] = newsAgencies(WORLD_CONFIG);

/** Spacing of the graph points: cfg.news.sampleIntervalMs, lengthened (whole ms) so the campaign needs at most news.maxPoints points. */
export function newsSampleInterval(cfg: MapConfig, timeline: GameTimeline): number {
  const span = Math.max(0, timeline.campaignEnd - timeline.campaignStart);
  return Math.max(cfg.news.sampleIntervalMs, Math.ceil(span / Math.max(1, cfg.news.maxPoints - 1)));
}

/**
 * Times of the graph points visible at `now`: campaignStart + k x interval for k = 0.. up to min(now, campaignEnd) (point 0 is always
 * included, also before the start). Once the campaign is over one more point at campaignEnd closes the graph when the interval does not
 * divide the campaign. Never more than news.maxPoints entries. Each entry carries its seed index k.
 */
export function newsSampleTimes(cfg: MapConfig, timeline: GameTimeline, now: number): { k: number; t: number }[] {
  const start = timeline.campaignStart;
  const end = Math.max(start, timeline.campaignEnd);
  const interval = newsSampleInterval(cfg, timeline);
  const horizon = Math.min(Math.max(now, start), end);
  const out: { k: number; t: number }[] = [];
  for (let k = 0; out.length < cfg.news.maxPoints; k++) {
    const t = start + k * interval;
    if (t > horizon) break;
    out.push({ k, t });
    if (t >= end) break;
  }
  const last = out[out.length - 1];
  if (horizon >= end && last.t < end && out.length < cfg.news.maxPoints) out.push({ k: last.k + 1, t: end });
  return out;
}

/** Elapsed fraction of the campaign at t, clamped to [0, 1] (1 for an empty campaign). */
function elapsedFraction(timeline: GameTimeline, t: number): number {
  const span = timeline.campaignEnd - timeline.campaignStart;
  return span <= 0 ? 1 : Math.min(1, Math.max(0, (t - timeline.campaignStart) / span));
}

/** The start error rate (fraction, 0.3 = +-30%) of one agency in one game: seeded, within [errorStartMinPct, errorStartMaxPct] / 100. */
export function newsStartError(cfg: MapConfig, seed: string, agencyId: string): number {
  const { errorStartMinPct: lo, errorStartMaxPct: hi } = cfg.news;
  return (lo + (hi - lo) * createRng(`${seed}:news:${agencyId}:e0`)()) / 100;
}

/** The error rate of an agency without the wobble: e0 x (end + (1 - end) x exp(-decayRate x f)); f in [0,1]. Falls monotonically from e0 to ~e0 x end. */
export function newsErrorTrend(cfg: MapConfig, e0: number, f: number): number {
  const end = cfg.news.errorEndFraction;
  return e0 * (end + (1 - end) * Math.exp(-cfg.news.errorDecayRate * f));
}

/** Seeded smoothed wobble eps_k for k = 0..n-1 of one agency: eps_0 = 0, eps_k = s eps_(k-1) + sqrt(1 - s^2) z_k (z_k = first draw of the sample's rng). */
function wobble(cfg: MapConfig, seed: string, agencyId: string, ks: number[]): number[] {
  const s = cfg.news.noiseSmoothing;
  const mix = Math.sqrt(1 - s * s);
  const out: number[] = [];
  let prev = 0;
  for (const k of ks) {
    const eps = k === 0 ? 0 : s * prev + mix * gaussian(createRng(`${seed}:news:${agencyId}:${k}`));
    out.push(eps);
    prev = eps;
  }
  return out;
}

/**
 * Error rate (fraction) of one agency at each of `times` (as returned by newsSampleTimes: consecutive indices k from 0).
 * trend x (1 + errorNoise x wobble), the wobble factor clamped to [errorWobbleMin, errorWobbleMax] so the rate never jumps wildly and is
 * never negative. `seed` = newsSeed(gameId, secret).
 * At k = 0 the error is exactly the start error.
 */
export function newsErrorRates(
  cfg: MapConfig, seed: string, agencyId: string, timeline: GameTimeline, times: { k: number; t: number }[],
): number[] {
  const e0 = newsStartError(cfg, seed, agencyId);
  const eps = wobble(cfg, seed, agencyId, times.map((x) => x.k));
  return times.map((x, i) => {
    const factor = Math.min(cfg.news.errorWobbleMax, Math.max(cfg.news.errorWobbleMin, 1 + cfg.news.errorNoise * eps[i]));
    return newsErrorTrend(cfg, e0, elapsedFraction(timeline, x.t)) * (x.k === 0 ? 1 : factor);
  });
}

/** Inputs of buildGlobalReports: the same ones buyReport gathers in the server's gameService. */
export interface GlobalReportsInput {
  gameId: string;
  /** Server-only random secret of this game (never sent to a client); mixed into every noise seed. Must not be empty. */
  secret: string;
  cfg: MapConfig;
  map: GameMapPackage;
  kernels: Kernels;
  timeline: GameTimeline;
  /** Number of polling phases of this game (game.phases). */
  phases: number;
  /** All campaign actions so far (repo.listActions). */
  actions: Action[];
  /** The parties in the vote, in the fixed player order (the contenders). */
  players: PlayerId[];
  /** Committed voters of those parties (committedMatrix). */
  committed: Committed;
  /** Poll results stored so far (repo.listSeatResults); a seat's real winner counts from its phase's close time on. */
  decided: SeatResult[];
  /** Eliminated players (their actions are ignored), as in buyReport. */
  exclude?: Set<PlayerId>;
  /** Server time of the request. */
  now: number;
}

/**
 * True soft projection at time t (hidden information, never sent): per party the sum over all seats of its expected vote share,
 * with effects as of t; seats of phases closed by t with a poll result count 1 for the real winner. Adds up to the number of seats
 * (when there are players). Seats without a winner (nobody had any effect) are projected like open seats.
 */
export function newsTrueProjection(input: GlobalReportsInput, t: number): Record<PlayerId, number> {
  const { cfg, kernels, timeline, map, phases, actions, players, committed, decided, exclude } = input;
  const out: Record<PlayerId, number> = {};
  for (const p of players) out[p] = 0;
  if (!players.length) return out;
  const effects = computeEffects(actions, kernels, cfg, timeline, map, phases, { upTo: t, exclude });
  const closedWinner = new Map<number, PlayerId>();
  for (const r of decided) {
    const closeAt = timeline.phaseCloses[r.phase];
    if (r.winner !== null && closeAt !== undefined && closeAt <= t && out[r.winner] !== undefined) closedWinner.set(r.seat, r.winner);
  }
  for (let i = 0; i < kernels.n; i++) {
    const w = closedWinner.get(kernels.seatIds[i]);
    if (w !== undefined) { out[w] += 1; continue; }
    const sh = expectedShareArray(effects, committed, players, kernels, cfg, i);
    for (let k = 0; k < players.length; k++) out[players[k]] += sh[k] ?? 0;
  }
  return out;
}

/** One agency's noisy point from the true projection: true x (1 + err x gaussian), floored at 0, rescaled to add up to `total`. */
function noisyPoint(
  trueSeats: Record<PlayerId, number>, players: PlayerId[], err: number, total: number, rng: () => number,
): Record<PlayerId, number> {
  const raw = players.map((p) => Math.max(0, trueSeats[p] * (1 + err * gaussian(rng))));
  const sum = raw.reduce((a, b) => a + b, 0);
  const out: Record<PlayerId, number> = {};
  players.forEach((p, i) => { out[p] = sum > 0 ? (raw[i] * total) / sum : total / players.length; });
  return out;
}

/**
 * The global reports of all agencies as of `input.now` (frozen at the campaign end): a growing series of points per agency plus the
 * seat ranges of the latest point. Deterministic for the same inputs (seeds in the file comment). Cost: one computeEffects per sample time
 * (shared by the agencies). A point is a function of the actions up to its sample time, so
 * earlier points stay as they are while the campaign runs, EXCEPT when the set of contenders / eliminated players changes (a player
 * leaving or being eliminated changes the party list and the effects counted) or a poll result of a closed phase arrives late; a cache
 * must therefore key on those inputs too (the server's does).
 */
export function buildGlobalReports(input: GlobalReportsInput): GlobalReports {
  const { cfg, timeline, players, kernels } = input;
  const seed = newsSeed(input.gameId, input.secret);
  const total = kernels.n;
  const times = newsSampleTimes(cfg, timeline, input.now);
  const truth = times.map((x, i) => (i === 0 ? null : newsTrueProjection(input, x.t)));
  const asOf = times[times.length - 1].t;
  const agencies: NewsAgencyReport[] = newsAgencies(cfg).map((agency) => {
    const errs = newsErrorRates(cfg, seed, agency.id, timeline, times);
    const points: GlobalReportPoint[] = times.map((x, i) => {
      const tr = truth[i];
      if (!tr) { // t = campaign start: every agency shows seats / parties exactly
        const even: Record<PlayerId, number> = {};
        for (const p of players) even[p] = total / players.length;
        return { t: x.t, seats: even };
      }
      const rng = createRng(`${seed}:news:${agency.id}:${x.k}`);
      gaussian(rng); // the first draw of a sample's rng is its wobble value (see wobble); the party gaussians follow
      return { t: x.t, seats: noisyPoint(tr, players, errs[i], total, rng) };
    });
    const latest = points[points.length - 1];
    const err = errs[errs.length - 1];
    const ranges: Record<PlayerId, [number, number]> = {};
    for (const p of players) {
      const v = latest.seats[p];
      ranges[p] = [clampSeats(Math.round(v * (1 - err)), total), clampSeats(Math.round(v * (1 + err)), total)];
    }
    return { id: agency.id, name: agency.name, points, ranges };
  });
  return { asOf, sampleIntervalMs: newsSampleInterval(cfg, timeline), agencies };
}

function clampSeats(n: number, total: number): number {
  return Math.min(total, Math.max(0, n));
}
