import { describe, expect, it } from 'vitest';
import {
  NEWS_AGENCIES, WORLD_CONFIG, buildGlobalReports, buildKernels, buildTimeline, committedMatrix, newsAgencies, newsAgencyId,
  newsErrorRates, newsErrorTrend, newsSeed, newsSampleInterval, newsSampleTimes, newsStartError, newsTrueProjection,
} from '../src';
import type { ClientMessage, GlobalReports, GlobalReportsInput, MapConfig, NewsAgency, ServerMessage } from '../src';
import { NO_COMMITTED, T0, TEST_CFG, act, testMap } from './helpers';

const map = testMap();
const cfg: MapConfig = TEST_CFG; // 600 s campaign, news.* from the shipped file (30 s points)
const kernels = buildKernels(map, cfg);
const tl = buildTimeline(cfg, 1, T0);
const tl3 = buildTimeline(cfg, 3, T0);
const players = ['A', 'B', 'C'];
const N = kernels.n; // 8 seats
const actions = [
  act('A', 'rally', 1, T0 + 40_000), act('A', 'roadshow', 1, T0 + 50_000), act('A', 'roadshow', 2, T0 + 60_000),
  act('B', 'roadshow', 4, T0 + 100_000), act('C', 'rally', 8, T0 + 200_000),
];

function input(over: Partial<GlobalReportsInput> = {}): GlobalReportsInput {
  return {
    gameId: 'g1', secret: 'sec-1', cfg, map, kernels, timeline: tl, phases: 1, actions, players, committed: NO_COMMITTED, decided: [], now: tl.campaignEnd, ...over,
  };
}
const withNews = (news: Partial<MapConfig['news']>): MapConfig => ({ ...cfg, news: { ...cfg.news, ...news } });
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

describe('config: news.* in game.properties', () => {
  it('ships 4 agencies, a 30 s sample interval and a 20-40 % start error', () => {
    expect(WORLD_CONFIG.news.enabled).toBe(true);
    expect(WORLD_CONFIG.news.agencies.map((a) => a.name)).toEqual(['Kal Tak', 'Toofan Express', 'Woof News', 'World Today']);
    expect(WORLD_CONFIG.news.sampleIntervalMs).toBe(30_000);
    expect(WORLD_CONFIG.news.errorStartMinPct).toBe(20);
    expect(WORLD_CONFIG.news.errorStartMaxPct).toBe(40);
  });
});

describe('agencies', () => {
  it('are derived from the config; ids are slugs of the names', () => {
    const list: NewsAgency[] = newsAgencies(WORLD_CONFIG);
    expect(list).toEqual(NEWS_AGENCIES);
    expect(list.map((a) => a.id)).toEqual(['kal-tak', 'toofan-express', 'woof-news', 'world-today']);
    expect(newsAgencyId('  Dainik  Bhaskar!! 24 ')).toBe('dainik-bhaskar-24');
    expect(newsAgencyId('!!!')).toBe('agency');
  });
  it('a config with other names / more agencies changes the output; duplicate slugs get a suffix', () => {
    const c = withNews({ agencies: [{ name: 'A B' }, { name: 'a-b' }, { name: 'Zed' }] });
    expect(newsAgencies(c).map((a) => a.id)).toEqual(['a-b', 'a-b-2', 'zed']);
    const r = buildGlobalReports(input({ cfg: c }));
    expect(r.agencies.map((a) => a.name)).toEqual(['A B', 'a-b', 'Zed']);
  });
});

describe('sample times', () => {
  it('start at the campaign start, step by the interval, stop at now and at the campaign end', () => {
    const at = (now: number) => newsSampleTimes(cfg, tl, now).map((x) => x.t - T0);
    expect(at(T0 - 5_000)).toEqual([0]);
    expect(at(T0)).toEqual([0]);
    expect(at(T0 + 29_999)).toEqual([0]);
    expect(at(T0 + 30_000)).toEqual([0, 30_000]);
    expect(at(T0 + 95_000)).toEqual([0, 30_000, 60_000, 90_000]);
    expect(at(T0 + 600_000)).toHaveLength(21); // 0..600 s, last = campaign end
    expect(at(T0 + 9_999_999)).toEqual(at(T0 + 600_000)); // frozen after the campaign
  });
  it('a closing point lands on the campaign end when the interval does not divide the campaign', () => {
    const c = withNews({ sampleIntervalMs: 45_000 });
    const t = newsSampleTimes(c, tl, tl.campaignEnd + 1);
    expect(t[t.length - 2].t - T0).toBe(585_000);
    expect(t[t.length - 1].t).toBe(tl.campaignEnd);
    expect(t.map((x) => x.k)).toEqual(t.map((_, i) => i));
  });
  it('news.maxPoints caps the number of points by lengthening the interval', () => {
    const c = withNews({ maxPoints: 5 });
    expect(newsSampleInterval(c, tl)).toBe(150_000);
    const t = newsSampleTimes(c, tl, tl.campaignEnd + 1);
    expect(t).toHaveLength(5);
    expect(t[4].t).toBe(tl.campaignEnd);
    expect(newsSampleInterval(cfg, tl)).toBe(30_000);
    for (const mp of [2, 3, 7, 11]) for (const iv of [1_000, 33_333, 250_000]) {
      const cc = withNews({ maxPoints: mp, sampleIntervalMs: iv });
      expect(newsSampleTimes(cc, tl, tl.campaignEnd + 1).length).toBeLessThanOrEqual(mp);
      expect(newsSampleTimes(cc, tl, tl.campaignEnd + 1).slice(-1)[0].t).toBe(tl.campaignEnd);
    }
  });
});

describe('buildGlobalReports', () => {
  it('at t = 0 every agency shows seats / parties exactly, even with committed voters', () => {
    const committed = committedMatrix([['A', { core: 1, seats: [{ seat: 1, band: 1 }, { seat: 2, band: 2 }] }]], kernels, cfg);
    for (const now of [T0 - 1, T0, T0 + 29_000]) {
      const r = buildGlobalReports(input({ now, committed }));
      expect(r.agencies).toHaveLength(4);
      for (const a of r.agencies) {
        expect(a.points).toHaveLength(1);
        expect(a.points[0].t).toBe(T0);
        for (const p of players) expect(a.points[0].seats[p]).toBe(N / players.length);
      }
    }
  });

  it('every point adds up to the seat count; points are non-negative; time stamps match the sample times', () => {
    const r: GlobalReports = buildGlobalReports(input());
    const times = newsSampleTimes(cfg, tl, tl.campaignEnd).map((x) => x.t);
    expect(r.asOf).toBe(tl.campaignEnd);
    expect(r.sampleIntervalMs).toBe(30_000);
    for (const a of r.agencies) {
      expect(a.points.map((p) => p.t)).toEqual(times);
      for (const pt of a.points) {
        expect(Object.keys(pt.seats).sort()).toEqual(players);
        expect(sum(pt.seats)).toBeCloseTo(N, 9);
        for (const v of Object.values(pt.seats)) expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('ranges are whole numbers, ordered, clamped to 0..seatCount and contain the latest point', () => {
    for (const now of [T0, T0 + 100_000, tl.campaignEnd]) {
      const r = buildGlobalReports(input({ now, gameId: `gr${now}` }));
      for (const a of r.agencies) {
        const latest = a.points[a.points.length - 1];
        for (const p of players) {
          const [lo, hi] = a.ranges[p];
          expect(Number.isInteger(lo) && Number.isInteger(hi)).toBe(true);
          expect(lo).toBeGreaterThanOrEqual(0);
          expect(hi).toBeLessThanOrEqual(N);
          expect(lo).toBeLessThanOrEqual(hi);
          expect(lo).toBeLessThanOrEqual(Math.round(latest.seats[p]));
          expect(hi).toBeGreaterThanOrEqual(Math.round(latest.seats[p]));
        }
      }
    }
    // a huge error rate still clamps
    const wild = withNews({ errorStartMinPct: 100, errorStartMaxPct: 100, errorEndFraction: 1 });
    for (const a of buildGlobalReports(input({ cfg: wild })).agencies) {
      for (const p of players) { expect(a.ranges[p][0]).toBeGreaterThanOrEqual(0); expect(a.ranges[p][1]).toBeLessThanOrEqual(N); }
    }
  });

  it('is deterministic; another game gives another series; earlier points do not change as time passes (inputs fixed)', () => {
    const a = buildGlobalReports(input());
    expect(buildGlobalReports(input())).toEqual(a);
    expect(buildGlobalReports(input({ gameId: 'other' }))).not.toEqual(a);
    expect(buildGlobalReports(input({ secret: 'sec-1' }))).toEqual(a);
    const early = buildGlobalReports(input({ now: T0 + 300_000 }));
    for (let i = 0; i < a.agencies.length; i++) {
      expect(a.agencies[i].points.slice(0, early.agencies[i].points.length)).toEqual(early.agencies[i].points);
    }
    const afterEnd = buildGlobalReports(input({ now: tl.campaignEnd + 500_000 }));
    expect(afterEnd).toEqual(a);
  });

  it('EXCEPTION to "earlier points stay": a party leaving / being eliminated changes the parties and the effects counted, so history moves', () => {
    const before = buildGlobalReports(input({ now: T0 + 300_000 }));
    const after = buildGlobalReports(input({ now: T0 + 300_000, players: ['A', 'B'], exclude: new Set(['C']) }));
    expect(Object.keys(after.agencies[0].points[1].seats).sort()).toEqual(['A', 'B']);
    expect(after.agencies[0].points[1].seats).not.toEqual(before.agencies[0].points[1].seats);
    expect(after.agencies[0].points.map((p) => p.t)).toEqual(before.agencies[0].points.map((p) => p.t));
  });

  it('agencies differ from each other (each is noisy in its own way)', () => {
    const r = buildGlobalReports(input());
    const last = r.agencies.map((a) => a.points[a.points.length - 1].seats.A);
    expect(new Set(last.map((v) => v.toFixed(6))).size).toBe(4);
  });

  it('follows the truth: the party that acted most projects highest with a small error rate, and the series is the noisy truth', () => {
    const quiet = withNews({ errorStartMinPct: 1, errorStartMaxPct: 1, errorEndFraction: 1, errorNoise: 0 });
    const r = buildGlobalReports(input({ cfg: quiet }));
    const truth = newsTrueProjection(input({ cfg: quiet }), tl.campaignEnd);
    expect(sum(truth)).toBeCloseTo(N, 9);
    expect(truth.A).toBeGreaterThan(truth.B);
    expect(truth.A).toBeGreaterThan(truth.C);
    for (const a of r.agencies) {
      const latest = a.points[a.points.length - 1].seats;
      for (const p of players) expect(Math.abs(latest[p] - truth[p])).toBeLessThan(0.5);
    }
  });

  it('no parties: empty points and ranges, no crash', () => {
    const r = buildGlobalReports(input({ players: [], actions: [] }));
    for (const a of r.agencies) {
      expect(a.ranges).toEqual({});
      expect(a.points.every((p) => Object.keys(p.seats).length === 0)).toBe(true);
    }
  });

  it('seats whose phase has closed count for their real winner from the close time on (not before)', () => {
    const decided = [1, 2, 3, 4, 5, 6, 7, 8].map((seat) => ({ seat, phase: 0, winner: 'C', shares: { C: 1 } }));
    const quiet = withNews({ errorStartMinPct: 1, errorStartMaxPct: 1, errorEndFraction: 1, errorNoise: 0 });
    const before = newsTrueProjection(input({ cfg: quiet, decided }), tl.campaignEnd - 1);
    expect(before.C).toBeLessThan(N);
    const after = newsTrueProjection(input({ cfg: quiet, decided }), tl.campaignEnd);
    expect(after).toEqual({ A: 0, B: 0, C: N });
    const r = buildGlobalReports(input({ cfg: quiet, decided }));
    for (const a of r.agencies) expect(a.points[a.points.length - 1].seats.C).toBeGreaterThan(N - 1);
  });

  it('phases: later phases open later (the truth uses effects as of each sample time)', () => {
    const r = buildGlobalReports(input({ timeline: tl3, phases: 3 }));
    for (const a of r.agencies) expect(a.points.at(-1)!.t).toBe(tl3.campaignEnd);
  });
});

describe('server-only secret in the noise seeds', () => {
  it('a different secret gives different noise (points and ranges), the same secret the same; the true position is untouched', () => {
    const a = buildGlobalReports(input());
    const b = buildGlobalReports(input({ secret: 'sec-2' }));
    expect(b).not.toEqual(a);
    expect(buildGlobalReports(input({ secret: 'sec-2' }))).toEqual(b);
    expect(b.agencies.map((x) => x.id)).toEqual(a.agencies.map((x) => x.id));
    expect(b.agencies.map((x) => x.points.map((p) => p.t))).toEqual(a.agencies.map((x) => x.points.map((p) => p.t)));
    for (const [i, ag] of a.agencies.entries()) {
      expect(ag.points.slice(1).some((p, j) => JSON.stringify(p.seats) !== JSON.stringify(b.agencies[i].points[j + 1].seats))).toBe(true);
    }
  });
  it('the noise cannot be rebuilt from the game id alone: no seed made of the id and a guessed (empty / public) value matches', () => {
    const real = buildGlobalReports(input({ secret: 'top-secret-value' }));
    // what a client could compute with only public data: the old seed form `${gameId}:news:...`, i.e. an empty secret is refused
    expect(() => buildGlobalReports(input({ secret: '' }))).toThrow(/secret/);
    for (const guess of ['g1', '', 'news', 'sec']) {
      if (!guess) continue;
      expect(buildGlobalReports(input({ secret: guess }))).not.toEqual(real);
    }
    expect(newsSeed('g1', 'x')).not.toBe(newsSeed('g1', 'y'));
    expect(newsSeed('g1', 'x')).not.toBe(newsSeed('g2', 'x'));
    expect(() => newsSeed('g1', '')).toThrow();
  });
  it('the wobble clamp is config-driven (errorWobbleMin / errorWobbleMax)', () => {
    const times = newsSampleTimes(cfg, tl, tl.campaignEnd);
    const wild = withNews({ errorNoise: 1, noiseSmoothing: 0, errorWobbleMin: 0.9, errorWobbleMax: 1.1 });
    for (let g = 0; g < 30; g++) {
      const e = newsErrorRates(wild, `s${g}`, 'kal-tak', tl, times);
      const e0 = newsStartError(wild, `s${g}`, 'kal-tak');
      e.forEach((v, i) => {
        const trend = newsErrorTrend(wild, e0, (times[i].t - T0) / 600_000);
        expect(v / trend).toBeGreaterThanOrEqual(0.9 - 1e-9);
        expect(v / trend).toBeLessThanOrEqual(1.1 + 1e-9);
      });
    }
    const none = withNews({ errorNoise: 1, noiseSmoothing: 0, errorWobbleMin: 1, errorWobbleMax: 1 });
    const e = newsErrorRates(none, 's1', 'kal-tak', tl, times);
    const e0 = newsStartError(none, 's1', 'kal-tak');
    e.forEach((v, i) => expect(v).toBeCloseTo(newsErrorTrend(none, e0, (times[i].t - T0) / 600_000), 12));
  });
});

describe('error rate', () => {
  const games = Array.from({ length: 300 }, (_, i) => `seed-${i}`);

  it('the start error of every agency and game lies within [errorStartMinPct, errorStartMaxPct]', () => {
    let lo = Infinity; let hi = -Infinity;
    for (const g of games) for (const a of NEWS_AGENCIES) {
      const e0 = newsStartError(cfg, g, a.id);
      lo = Math.min(lo, e0); hi = Math.max(hi, e0);
      expect(e0).toBeGreaterThanOrEqual(cfg.news.errorStartMinPct / 100);
      expect(e0).toBeLessThanOrEqual(cfg.news.errorStartMaxPct / 100);
      expect(newsStartError(cfg, g, a.id)).toBe(e0);
    }
    expect(lo).toBeLessThan(0.23); // the whole band is used
    expect(hi).toBeGreaterThan(0.37);
  });

  it('the first sample has exactly the start error; the trend falls monotonically towards errorEndFraction x start', () => {
    const times = newsSampleTimes(cfg, tl, tl.campaignEnd);
    const e = newsErrorRates(cfg, 'g1', 'kal-tak', tl, times);
    expect(e[0]).toBe(newsStartError(cfg, 'g1', 'kal-tak'));
    expect(e).toHaveLength(times.length);
    let prev = Infinity;
    for (let i = 0; i <= 10; i++) {
      const v = newsErrorTrend(cfg, 0.3, i / 10);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
    expect(newsErrorTrend(cfg, 0.3, 0)).toBeCloseTo(0.3, 12);
    expect(newsErrorTrend(cfg, 0.3, 1)).toBeCloseTo(0.3 * (cfg.news.errorEndFraction + (1 - cfg.news.errorEndFraction) * Math.exp(-cfg.news.errorDecayRate)), 12);
  });

  it('falls on average over many games (mean error in the last third < mean in the first third), no wild jumps', () => {
    const times = newsSampleTimes(cfg, tl, tl.campaignEnd);
    const third = Math.floor(times.length / 3);
    let early = 0; let late = 0; let n = 0; let maxJump = 0; let stepSum = 0; let steps = 0;
    for (const g of games) for (const a of NEWS_AGENCIES) {
      const e = newsErrorRates(cfg, g, a.id, tl, times);
      for (let i = 1; i <= third; i++) early += e[i];
      for (let i = times.length - third; i < times.length; i++) late += e[i];
      n += third;
      for (let i = 1; i < e.length; i++) { const j = Math.abs(e[i] - e[i - 1]) / e[0]; maxJump = Math.max(maxJump, j); stepSum += j; steps++; }
      for (const v of e) expect(v).toBeGreaterThan(0);
    }
    expect(late / n).toBeLessThan((early / n) * 0.7);
    expect(maxJump).toBeLessThan(0.9); // hard bound: the wobble factor is clamped to 0.5..1.5 of the trend
    expect(stepSum / steps).toBeLessThan(0.15); // typical step between neighbouring points: small
  });

  it('is config-driven: no wobble gives the pure trend; end fraction 1 means no improvement; a new start band moves e0', () => {
    const times = newsSampleTimes(cfg, tl, tl.campaignEnd);
    const flat = withNews({ errorNoise: 0 });
    const e = newsErrorRates(flat, 'g1', 'woof-news', tl, times);
    const e0 = newsStartError(flat, 'g1', 'woof-news');
    times.forEach((x, i) => expect(e[i]).toBeCloseTo(newsErrorTrend(flat, e0, (x.t - T0) / 600_000), 12));
    const noImprove = withNews({ errorEndFraction: 1, errorNoise: 0 });
    for (const v of newsErrorRates(noImprove, 'g1', 'woof-news', tl, times)) expect(v).toBeCloseTo(e0, 12);
    const band = withNews({ errorStartMinPct: 5, errorStartMaxPct: 6 });
    const b0 = newsStartError(band, 'g1', 'woof-news');
    expect(b0).toBeGreaterThanOrEqual(0.05);
    expect(b0).toBeLessThanOrEqual(0.06);
    const smooth = withNews({ noiseSmoothing: 0.95 });
    const jag = withNews({ noiseSmoothing: 0 });
    const roughness = (c: MapConfig) => {
      let r = 0;
      for (const g of games.slice(0, 50)) {
        const x = newsErrorRates(c, g, 'kal-tak', tl, times).map((v, i) => v / newsErrorTrend(c, newsStartError(c, g, 'kal-tak'), (times[i].t - T0) / 600_000));
        for (let i = 2; i < x.length; i++) r += Math.abs(x[i] - x[i - 1]);
      }
      return r;
    };
    expect(roughness(smooth)).toBeLessThan(roughness(jag));
  });

  it('the points really get closer to the truth later in the campaign (statistical)', () => {
    const times = newsSampleTimes(cfg, tl, tl.campaignEnd);
    const mid = times.length >> 1;
    // use a static position so the truth is the same at every sample: no actions -> truth = N / parties everywhere
    let early = 0; let late = 0;
    for (let g = 0; g < 80; g++) {
      const r = buildGlobalReports(input({ gameId: `acc${g}`, actions: [] }));
      for (const a of r.agencies) {
        for (let i = 1; i <= 4; i++) for (const p of players) early += Math.abs(a.points[i].seats[p] - N / 3);
        for (let i = times.length - 4; i < times.length; i++) for (const p of players) late += Math.abs(a.points[i].seats[p] - N / 3);
      }
    }
    expect(mid).toBeGreaterThan(4);
    expect(late).toBeLessThan(early * 0.8);
  });
});

describe('protocol types', () => {
  it('globalReports is a client action and a server message carrying GlobalReports', () => {
    const ask: ClientMessage = { action: 'globalReports' };
    const reply: ServerMessage = { type: 'globalReports', reports: buildGlobalReports(input({ now: T0 })) };
    expect(ask.action).toBe('globalReports');
    expect(reply.type).toBe('globalReports');
    expect(reply.reports.agencies).toHaveLength(4);
  });
});
