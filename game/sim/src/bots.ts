import type { AnalystReport, Rng } from '@hp/shared';
import type { World } from './world';

/** What a bot can do and see. Bots never see other players' roadshows (only public rallies and noisy reports). */
export interface BotCtx {
  w: World;
  k: number;
  rng: Rng;
  me: number;
  P: number;
  /** ms since campaign start */
  now: number;
  campaignMs: number;
  budget: number;
  costs: { rally: number; roadshow: number };
  startBudget: number;
  isOpen(i: number): boolean;
  /** fraction of the campaign at which seat i freezes */
  closeFrac(i: number): number;
  phaseOf(i: number): number;
  /** my own total effect at seat i (I know my own actions) */
  ownEff(i: number): number;
  /** all other players' PUBLIC effect (rallies) at seat i */
  rivalPub(i: number): number;
  visited(i: number): boolean;
  /** my own committed fraction of seat i's voters (0..1, private: only my own patch is known) */
  ownCommitted(i: number): number;
  rally(i: number): boolean;
  roadshow(i: number): boolean;
  report(scope: 'seat' | 'global', i?: number): AnalystReport | null;
  seatReportPrice(): number;
  globalReportPrice(): number;
}

export interface Bot { name: string; tick(ctx: BotCtx): void }
/** A bot's own committed patch (private): seat indices in walk order (core first) and the committed fraction per seat index. */
export interface OwnCommitted { seats: number[]; frac: Float64Array }
export type BotFactory = (w: World, k: number, budget: number, rng: Rng, own: OwnCommitted) => Bot;

// ------------------------------------------------------------------ helpers

function shuffle<T>(a: T[], rng: Rng): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function allSeats(n: number): number[] { return Array.from({ length: n }, (_, i) => i); }

const MARGIN = 0.012; // keep planned times this far (fraction of campaign) before the seat's phase closes

interface Planned { frac: number; type: 'rally' | 'roadshow'; seat: number }

function planBot(name: string, plan: Planned[]): Bot {
  const sorted = [...plan].sort((a, b) => a.frac - b.frac);
  let ptr = 0;
  return {
    name,
    tick(ctx) {
      while (ptr < sorted.length && sorted[ptr].frac * ctx.campaignMs <= ctx.now) {
        const a = sorted[ptr++];
        if (a.type === 'rally') ctx.rally(a.seat); else ctx.roadshow(a.seat);
      }
    },
  };
}

type Timing = 'spread' | 'early' | 'late';

function timeFor(w: World, k: number, seat: number, timing: Timing, rng: Rng): number {
  const po = w.phaseOf.get(k) as Int16Array;
  const p = po[seat];
  const dl = (p + 1) / k - MARGIN;
  const wStart = p / k;
  if (timing === 'spread') return rng() * dl;
  if (timing === 'early') return rng() * Math.min(dl, 0.1);
  // late: last third of the seat's phase window
  const len = 1 / k;
  const lo = wStart + (2 / 3) * len;
  return lo + rng() * Math.max(0.0005, dl - lo);
}

/** Greedy coverage-saturating choice of rally seats within the given candidate seats. */
function greedyRallySeats(w: World, cand: number[], m: number, rng: Rng, noise = 0.25, sat?: number): number[] {
  const T = sat ?? w.cfg.effects.rally.local * 1.0;
  const cov = new Float64Array(w.n);
  const chosen: number[] = [];
  const used = new Set<number>();
  for (let r = 0; r < m && used.size < cand.length; r++) {
    let best = -1;
    let bestG = -1;
    for (const i of cand) {
      if (used.has(i)) continue;
      const row = w.rallyRows[i];
      let g = 0;
      for (let q = 0; q < row.idx.length; q++) g += Math.min(row.w[q], Math.max(0, T - cov[row.idx[q]]));
      g *= 1 + noise * rng();
      if (g > bestG) { bestG = g; best = i; }
    }
    if (best < 0) break;
    used.add(best);
    chosen.push(best);
    const row = w.rallyRows[best];
    for (let q = 0; q < row.idx.length; q++) cov[row.idx[q]] += row.w[q];
  }
  return chosen;
}

/** Split m items across phases proportionally to the number of seats in each phase. */
function perPhase(w: World, k: number, m: number): number[] {
  const ps = w.phaseSeats.get(k) as number[][];
  const raw = ps.map((g) => (m * g.length) / w.n);
  const out = raw.map(Math.floor);
  let rest = m - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f);
  for (let q = 0; rest > 0; q = (q + 1) % order.length, rest--) out[order[q].i]++;
  return out;
}

function budgetSplit(B: number, cr: number, cs: number, fRally: number) {
  const nr = Math.floor((fRally * B) / cr);
  const ns = Math.floor((B - nr * cr) / cs);
  return { nr, ns };
}

// ------------------------------------------------------------------ plan-based strategies

function rallyBot(name: string, timing: Timing): BotFactory {
  return (w, k, B, rng) => {
    const { nr } = budgetSplit(B, w.cfg.costs.rally, w.cfg.costs.roadshow, 1);
    const seats = shuffle(allSeats(w.n), rng).slice(0, nr);
    return planBot(name, seats.map((s) => ({ frac: timeFor(w, k, s, timing, rng), type: 'rally', seat: s })));
  };
}

function roadshowBot(name: string): BotFactory {
  return (w, k, B, rng) => {
    const { ns } = budgetSplit(B, w.cfg.costs.rally, w.cfg.costs.roadshow, 0);
    const seats = shuffle(allSeats(w.n), rng).slice(0, ns);
    return planBot(name, seats.map((s) => ({ frac: timeFor(w, k, s, 'spread', rng), type: 'roadshow', seat: s })));
  };
}

/** fRally of the budget on rallies placed greedily in dense clusters (per phase), rest on random roadshows. */
function mixedBot(name: string, fRally: number, timing: Timing, rallyTiming: Timing = timing): BotFactory {
  return (w, k, B, rng) => {
    const { nr, ns } = budgetSplit(B, w.cfg.costs.rally, w.cfg.costs.roadshow, fRally);
    const ps = w.phaseSeats.get(k) as number[][];
    const plan: Planned[] = [];
    const rp = perPhase(w, k, nr);
    const used = new Set<number>();
    ps.forEach((g, p) => {
      for (const s of greedyRallySeats(w, g, rp[p], rng)) {
        used.add(s);
        plan.push({ frac: timeFor(w, k, s, rallyTiming, rng), type: 'rally', seat: s });
      }
    });
    const pool = shuffle(allSeats(w.n).filter((s) => !used.has(s)), rng).slice(0, ns);
    for (const s of pool) plan.push({ frac: timeFor(w, k, s, timing, rng), type: 'roadshow', seat: s });
    return planBot(name, plan);
  };
}

/** City-heavy: concentrate everything in a few dense clusters; rallies compound there. */
function clusterBot(name: string, fRally = 0.4, nSeeds = 10): BotFactory {
  return (w, k, B, rng) => {
    const { nr, ns } = budgetSplit(B, w.cfg.costs.rally, w.cfg.costs.roadshow, fRally);
    const ps = w.phaseSeats.get(k) as number[][];
    const plan: Planned[] = [];
    const seedsPer = perPhase(w, k, nSeeds).map((x) => Math.max(1, x));
    const nrP = perPhase(w, k, nr);
    const nsP = perPhase(w, k, ns);
    const used = new Set<number>();
    ps.forEach((g, p) => {
      // seeds: densest seats, at least 450 km apart
      const noisy = new Map<number, number>(g.map((s) => [s, w.density[s] * (0.7 + 0.6 * rng())]));
      const ranked = [...g].sort((a, b) => (noisy.get(b) as number) - (noisy.get(a) as number));
      const seeds: number[] = [];
      for (const s of ranked) {
        if (seeds.length >= seedsPer[p]) break;
        if (seeds.every((t) => w.kernels.distanceKm[s * w.n + t] > 450)) seeds.push(s);
      }
      if (seeds.length === 0) return;
      const inP = new Set(g);
      // per seed: rallies on the seed and nearest seats, roadshows on the next nearest
      for (let q = 0; q < seeds.length; q++) {
        const nrq = Math.floor(nrP[p] / seeds.length) + (q < nrP[p] % seeds.length ? 1 : 0);
        const nsq = Math.floor(nsP[p] / seeds.length) + (q < nsP[p] % seeds.length ? 1 : 0);
        const near = [seeds[q], ...w.nearest(seeds[q], 120).filter((j) => inP.has(j))].filter((j) => !used.has(j));
        let pos = 0;
        for (let r = 0; r < nrq && pos < near.length; r++, pos++) {
          used.add(near[pos]);
          plan.push({ frac: timeFor(w, k, near[pos], 'spread', rng), type: 'rally', seat: near[pos] });
        }
        for (let r = 0; r < nsq && pos < near.length; r++, pos++) {
          used.add(near[pos]);
          plan.push({ frac: timeFor(w, k, near[pos], 'spread', rng), type: 'roadshow', seat: near[pos] });
        }
      }
    });
    return planBot(name, plan);
  };
}

/**
 * Patch-based: defends and extends its own committed patch. Rallies go to the greedy cluster inside the patch region (the
 * seats nearest its core), roadshows to the patch seats with the lowest committed share first, then to the nearest seats around.
 */
function patchBot(name: string, fRally = 0.3): BotFactory {
  return (w, k, B, rng, own) => {
    const { nr, ns } = budgetSplit(B, w.cfg.costs.rally, w.cfg.costs.roadshow, fRally);
    const core = own.seats[0] ?? Math.floor(rng() * w.n);
    const region = [core, ...w.nearest(core, Math.max(120, ns))];
    const ps = w.phaseSeats.get(k) as number[][];
    const plan: Planned[] = [];
    const used = new Set<number>();
    const rp = perPhase(w, k, nr);
    ps.forEach((g, p) => {
      const inP = new Set(g);
      const cand = region.filter((s) => inP.has(s)).slice(0, 60);
      for (const s of greedyRallySeats(w, cand.length ? cand : g, rp[p], rng)) {
        used.add(s);
        plan.push({ frac: timeFor(w, k, s, 'spread', rng), type: 'rally', seat: s });
      }
    });
    const patch = [...own.seats].sort((a, b) => own.frac[a] - own.frac[b]);
    const order = [...patch, ...region.filter((s) => own.frac[s] === 0)].filter((s) => !used.has(s));
    for (const s of order.slice(0, ns)) plan.push({ frac: timeFor(w, k, s, 'spread', rng), type: 'roadshow', seat: s });
    return planBot(name, plan);
  };
}

// ------------------------------------------------------------------ dynamic strategies

/**
 * Pick the open candidate seat where a roadshow adds the most coverage: counts the seat itself and neighbours that
 * receive roadshow spill, weighting each by how weak the visible rival (public rally) effect is there, and discounting
 * seats this player already covers.
 */
function pickSnipe(ctx: BotCtx, cand: number[], taken: Set<number>, rng: Rng, mode: 'remote' | 'coverage' = 'coverage'): number {
  const w = ctx.w;
  const s = w.cfg.effects.roadshow.local;
  let best = -1; let bv = -Infinity;
  for (const i of cand) {
    if (taken.has(i) || !ctx.isOpen(i)) continue;
    if (mode === 'remote') {
      const v = -ctx.rivalPub(i) * (1 + 0.15 * rng()) - 1e-6 * rng();
      if (v > bv) { bv = v; best = i; }
      continue;
    }
    const row = w.roadRows[i];
    let v = 0;
    for (let q = 0; q < row.idx.length; q++) {
      const j = row.idx[q];
      if (!ctx.isOpen(j)) continue;
      const have = Math.min(1, ctx.ownEff(j) / (0.6 * s));
      v += (row.w[q] / s) * (1 - have) / (0.3 + ctx.rivalPub(j));
    }
    v *= 1 + 0.15 * rng();
    if (v > bv) { bv = v; best = i; }
  }
  return best;
}

/** Remote sniper: roadshows only; in the later part of each phase window picks open seats with the least public rival effect. */
function sniperBot(name: string): BotFactory {
  return (w, k, B, rng) => {
    const ns = Math.floor(B / w.cfg.costs.roadshow);
    const ps = w.phaseSeats.get(k) as number[][];
    const alloc = perPhase(w, k, ns);
    const done = new Array(k).fill(0);
    const taken = new Set<number>();
    return {
      name,
      tick(ctx) {
        const tf = ctx.now / ctx.campaignMs;
        for (let p = 0; p < k; p++) {
          const a = p / k;
          const b = (p + 1) / k - MARGIN;
          const start = a + 0.4 / k;
          if (tf < start || done[p] >= alloc[p]) continue;
          const target = Math.ceil(alloc[p] * Math.min(1, (tf - start) / Math.max(1e-9, b - start)));
          while (done[p] < target && done[p] < alloc[p]) {
            const best = pickSnipe(ctx, ps[p], taken, rng, 'remote');
            if (best < 0) { done[p] = alloc[p]; break; }
            taken.add(best);
            if (!ctx.roadshow(best)) { done[p] = alloc[p]; break; }
            done[p]++;
          }
        }
      },
    };
  };
}

/**
 * Adaptive: per phase window, first a mixed opening, then a few noisy analyst reports on contested own seats;
 * tops up seats that look close, writes off lost causes, and snipes neglected seats with the rest.
 */
function adaptiveBot(name: string, opt: { seat: boolean; global: boolean; reserve: number } = { seat: true, global: false, reserve: 0.06 }): BotFactory {
  return (w, k, B, rng) => {
    const cr = w.cfg.costs.rally;
    const cs = w.cfg.costs.roadshow;
    const reportBudget = opt.reserve * B;
    const mainBudget = B - reportBudget;
    const ps = w.phaseSeats.get(k) as number[][];
    const allocMoney = ps.map((g) => (mainBudget * g.length) / w.n);
    const spent: number[] = new Array(k).fill(0);
    const taken = new Set<number>();
    const rallyPlanned: number[][] = ps.map((g, p) => greedyRallySeats(w, g, Math.floor((0.4 * allocMoney[p]) / cr), rng));
    const rallyDone: number[] = new Array(k).fill(0);
    const stage2done: boolean[] = new Array(k).fill(false);
    const closeSeats: number[][] = ps.map(() => []);
    let reportsSpent = 0;
    let sniperMode = false;
    let globalDone = false;
    const maxReportsPerPhase = Math.max(1, Math.floor(6 / k));

    const buyRoadshow = (ctx: BotCtx, p: number, seat: number): boolean => {
      if (ctx.budget < cs) return false;
      if (!ctx.roadshow(seat)) return false;
      spent[p] += cs;
      return true;
    };

    return {
      name,
      tick(ctx) {
        const tf = ctx.now / ctx.campaignMs;
        if (opt.global && !globalDone && tf >= 0.5 && reportsSpent + ctx.globalReportPrice() <= reportBudget) {
          globalDone = true;
          const rep = ctx.report('global');
          if (rep) {
            reportsSpent += rep.price;
            const mine = rep.entries.find((e) => e.playerId === `P${ctx.me}`);
            if (mine && mine.rank > 1) sniperMode = true;
          }
        }
        for (let p = 0; p < k; p++) {
          const a = p / k;
          const len = 1 / k;
          const b = a + len - MARGIN;
          if (tf < a || tf >= b) continue;
          const rel = (tf - a) / len;
          // stage 1: opening (rel < 0.45): rallies early, roadshows paced up to 40% of the phase allocation
          if (rel < 0.45) {
            while (rallyDone[p] < rallyPlanned[p].length && rallyDone[p] < Math.ceil((rel / 0.2) * rallyPlanned[p].length)) {
              const s = rallyPlanned[p][rallyDone[p]++];
              if (ctx.isOpen(s) && ctx.rally(s)) spent[p] += cr;
            }
            const target = 0.4 * allocMoney[p] * (rel / 0.45);
            let guard = 0;
            while (spent[p] + cs <= target && guard++ < 50) {
              const cand = ps[p][Math.floor(rng() * ps[p].length)];
              if (taken.has(cand) || !ctx.isOpen(cand)) continue;
              taken.add(cand);
              if (!buyRoadshow(ctx, p, cand)) break;
            }
            continue;
          }
          // stage 2 (once): reports on own seats
          if (!stage2done[p]) {
            stage2done[p] = true;
            const mine = ps[p].filter((i) => ctx.visited(i) && ctx.isOpen(i));
            shuffle(mine, rng);
            let bought = 0;
            for (const i of mine) {
              if (!opt.seat) break;
              if (bought >= maxReportsPerPhase) break;
              if (reportsSpent + ctx.seatReportPrice() > reportBudget) break;
              const rep = ctx.report('seat', i);
              if (!rep) break;
              bought++;
              reportsSpent += rep.price;
              const me = rep.entries.find((e) => e.playerId === `P${ctx.me}`);
              const share = me ? me.estimate : 0;
              if (share >= 0.25 && share <= 0.62) closeSeats[p].push(i);
            }
          }
          // stage 3: top-ups on close seats, then sniping with the rest, paced to the window end
          const s3 = Math.min(1, (rel - 0.45) / Math.max(1e-9, (b - a) / len - 0.45));
          let target = allocMoney[p] * (0.4 + 0.6 * s3);
          // last phase: also spend whatever the analyst reserve did not use
          if (p === k - 1) target += (mainBudget - allocMoney.reduce((x, y) => x + y, 0)) + (reportBudget - reportsSpent) * s3;
          let guard = 0;
          while (spent[p] + cs <= target && guard++ < 400) {
            let seat = -1;
            if (!sniperMode && closeSeats[p].length > 0) {
              seat = closeSeats[p].shift() as number;
              if (!ctx.isOpen(seat)) continue;
            } else {
              seat = pickSnipe(ctx, ps[p], taken, rng);
              if (seat < 0) break;
              taken.add(seat);
            }
            if (!buyRoadshow(ctx, p, seat)) break;
          }
        }
      },
    };
  };
}

// ------------------------------------------------------------------ registry

export const STRATEGIES: Record<string, BotFactory> = {
  RALLY: rallyBot('RALLY', 'spread'),
  RALLY_EARLY: rallyBot('RALLY_EARLY', 'early'),
  ROADSHOW: roadshowBot('ROADSHOW'),
  MIX10: mixedBot('MIX10', 0.1, 'spread'),
  MIX20: mixedBot('MIX20', 0.2, 'spread'),
  MIX30: mixedBot('MIX30', 0.3, 'spread'),
  MIX50: mixedBot('MIX50', 0.5, 'spread'),
  MIX70: mixedBot('MIX70', 0.7, 'spread'),
  MIX100: mixedBot('MIX100', 1, 'spread'),
  MIX100E: mixedBot('MIX100E', 1, 'spread', 'early'),
  MIX50E: mixedBot('MIX50E', 0.5, 'spread', 'early'),
  MIX30_EARLYR: mixedBot('MIX30_EARLYR', 0.3, 'spread', 'early'),
  CLUSTER: clusterBot('CLUSTER'),
  PATCH: patchBot('PATCH'),
  SNIPER: sniperBot('SNIPER'),
  LATE: mixedBot('LATE', 0.3, 'late'),
  ADAPTIVE: adaptiveBot('ADAPTIVE'),
  ADAPTIVE_G: adaptiveBot('ADAPTIVE_G', { seat: true, global: true, reserve: 0.15 }),
  BLIND: adaptiveBot('BLIND', { seat: false, global: false, reserve: 0 }),
};

export const DEFAULT_POOL = ['RALLY', 'RALLY_EARLY', 'ROADSHOW', 'MIX30', 'MIX50', 'CLUSTER', 'SNIPER', 'LATE', 'ADAPTIVE', 'PATCH'];
