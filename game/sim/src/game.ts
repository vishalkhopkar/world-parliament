import {
  analystPrice, analystReport, buildTimeline, committedMatrix, computeEffects, createRng, dealCommitted, majorityOf, pollSeats, tallySeats,
} from '@hp/shared';
import type { AnalystReport, CommittedSet, SeatResult } from '@hp/shared';
import { STRATEGIES } from './bots';
import type { Bot, BotCtx, OwnCommitted } from './bots';
import { State } from './state';
import type { World } from './world';

export const T0 = 1_000_000;
export const TICK_MS = 2_000;

export interface PlayerResult {
  strategy: string;
  seats: number;
  voteShare: number;       // mean vote share over decided seats
  win: number;             // 1 sole winner (most seats), 1/m split on exact ties
  majority: boolean;
  rallies: number;
  roadshows: number;
  reports: number;
  reportSpend: number;
  budgetLeft: number;
  /** seats where this player is the only one with non-c local effect and has a direct roadshow */
  loneSeats: number;
  loneWins: number;
  /** actions refused because the seat was already frozen (bugs in bot timing if > 0) */
  rejected: number;
}

export interface GameResult {
  players: PlayerResult[];
  seatsDecided: number;
  /** seats where no player has any non-c (local or spill) effect */
  pureC: number;
  /** seats won by the player who would have won on c alone (and nobody had local effect there) */
  cOnlyWinnerSame: number;
  /** seats where the actual winner equals the c-only winner (includes seats with local effects) */
  cWinnerMatches: number;
  /** max |incremental - engine| effect difference (only when verify) */
  verifyDiff: number;
  /** winner player index per seat index (-1 = nobody) */
  winners: Int16Array;
  /** per decided seat: winning vote share and margin (winner share - runner-up share), for the balance metrics */
  topShares: number[];
  margins: number[];
  ms: number;
}

export function runGame(w: World, strategies: string[], k: number, seed: string, opts: { verify?: boolean } = {}): GameResult {
  const t0 = performance.now();
  const cfg = w.cfg;
  const P = strategies.length;
  const timeline = buildTimeline(cfg, k, T0);
  const st = new State(w, timeline, k, P);
  const playerIds = strategies.map((_, p) => `P${p}`);
  const budget = new Array<number>(P).fill(cfg.budget);
  const counts = strategies.map(() => ({ rally: 0, road: 0, rep: 0, repSpend: 0, rej: 0 }));
  const groups = w.map.phaseGroups[String(k)];
  const results: SeatResult[] = [];
  const polled = new Array<boolean>(k).fill(false);
  const pollRng = createRng(`${seed}:poll`);
  const reportRng = createRng(`${seed}:report`);
  const orderRng = createRng(`${seed}:order`);
  const phaseOf = w.phaseOf.get(k) as Int16Array;
  const campaignMs = cfg.durations.campaignMs;

  // committed voters: dealt at game start, one player after another (as at admission), seeded per game
  const dealRng = createRng(`${seed}:deal`);
  const sets: CommittedSet[] = [];
  for (let p = 0; p < P; p++) sets.push(dealCommitted(w.map, w.kernels, cfg, sets, dealRng));
  const committed = committedMatrix(sets.map((s, p) => [playerIds[p], s] as [string, CommittedSet]), w.kernels, cfg);
  const owns: OwnCommitted[] = sets.map((s, p) => ({
    seats: s.seats.map((x) => w.kernels.index.get(x.seat) as number),
    frac: committed.get(playerIds[p]) as Float64Array,
  }));

  const bots: Bot[] = strategies.map((s, p) => {
    const f = STRATEGIES[s];
    if (!f) throw new Error(`unknown strategy ${s}`);
    return f(w, k, cfg.budget, createRng(`${seed}:bot${p}`), owns[p]);
  });

  let nowMs = 0;
  let clock = 0; // ms offset inside the tick to keep action timestamps strictly increasing

  const pollPhase = (p: number) => {
    polled[p] = true;
    const eff = computeEffects(st.actions, w.kernels, cfg, timeline, w.map, k);
    results.push(...pollSeats(eff, committed, playerIds, w.kernels, cfg, groups[p], p, pollRng));
  };

  const makeCtx = (p: number): BotCtx => {
    const ctx: BotCtx = {
      w, k, me: p, P, rng: createRng(`${seed}:ctx${p}`),
      get now() { return nowMs; },
      campaignMs,
      get budget() { return budget[p]; },
      costs: cfg.costs,
      startBudget: cfg.budget,
      isOpen: (i) => st.isOpen(i, T0 + nowMs + clock),
      closeFrac: (i) => (phaseOf[i] + 1) / k,
      phaseOf: (i) => phaseOf[i],
      ownEff: (i) => st.eff[p][i],
      rivalPub: (i) => st.rivalPub(p, i),
      ownCommitted: (i) => owns[p].frac[i],
      visited: (i) => st.visitedRoad[p][i] === 1 || st.rallied[p][i] === 1,
      rally(i) {
        if (budget[p] < cfg.costs.rally) return false;
        if (!st.apply(p, 'rally', i, T0 + nowMs + clock++)) { counts[p].rej++; return false; }
        budget[p] -= cfg.costs.rally; counts[p].rally++;
        return true;
      },
      roadshow(i) {
        if (budget[p] < cfg.costs.roadshow) return false;
        if (!st.apply(p, 'roadshow', i, T0 + nowMs + clock++)) { counts[p].rej++; return false; }
        budget[p] -= cfg.costs.roadshow; counts[p].road++;
        return true;
      },
      report(scope, i) {
        const ts = T0 + nowMs + clock++;
        const price = analystPrice(cfg, scope, timeline, ts);
        if (budget[p] < price) return null;
        budget[p] -= price; counts[p].rep++; counts[p].repSpend += price;
        const eff = computeEffects(st.actions, w.kernels, cfg, timeline, w.map, k, { upTo: ts - cfg.analyst.delayMs });
        const rep: AnalystReport = analystReport(
          eff, committed, w.kernels, cfg, scope, scope === 'seat' ? w.kernels.seatIds[i as number] : undefined,
          results, playerIds, ts - cfg.analyst.delayMs, ts, price, reportRng,
        );
        return rep;
      },
      seatReportPrice: () => analystPrice(cfg, 'seat', timeline, T0 + nowMs),
      globalReportPrice: () => analystPrice(cfg, 'global', timeline, T0 + nowMs),
    };
    return ctx;
  };
  const ctxs = strategies.map((_, p) => makeCtx(p));

  const order = Array.from({ length: P }, (_, i) => i);
  for (nowMs = 0; nowMs < campaignMs; nowMs += TICK_MS) {
    for (let p = 0; p < k; p++) {
      if (!polled[p] && T0 + nowMs >= timeline.phaseCloses[p]) pollPhase(p);
    }
    for (let i = P - 1; i > 0; i--) {
      const j = Math.floor(orderRng() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    clock = 0;
    for (const p of order) bots[p].tick(ctxs[p]);
  }
  for (let p = 0; p < k; p++) if (!polled[p]) pollPhase(p);

  // -------- metrics
  let verifyDiff = 0;
  if (opts.verify) {
    const eff = computeEffects(st.actions, w.kernels, cfg, timeline, w.map, k);
    for (let p = 0; p < P; p++) {
      const v = eff.get(`P${p}`);
      for (let i = 0; i < w.n; i++) verifyDiff = Math.max(verifyDiff, Math.abs((v ? v[i] : 0) - st.eff[p][i]));
    }
  }
  const tally = tallySeats(results);
  const seatCounts = playerIds.map((id) => tally[id] ?? 0);
  const best = Math.max(...seatCounts);
  const nBest = seatCounts.filter((x) => x === best).length;
  const majority = majorityOf(cfg.seatCount);
  const voteSum = new Array<number>(P).fill(0);
  let decided = 0;
  const topShares: number[] = [];
  const margins: number[] = [];
  const loneSeats = new Array<number>(P).fill(0);
  const loneWins = new Array<number>(P).fill(0);
  let pureC = 0;
  let cWinnerMatches = 0;
  const winnerOf = new Map<number, string | null>();
  for (const r of results) {
    winnerOf.set(w.kernels.index.get(r.seat) as number, r.winner);
    if (r.winner === null) continue;
    decided++;
    const sh = Object.values(r.shares).sort((a, b) => b - a);
    topShares.push(sh[0] ?? 0);
    margins.push((sh[0] ?? 0) - (sh[1] ?? 0));
    for (let p = 0; p < P; p++) voteSum[p] += r.shares[`P${p}`] ?? 0;
  }
  for (let i = 0; i < w.n; i++) {
    let localPlayers = 0;
    let lonePlayer = -1;
    let bestC = -1; let bestCp = -1; let bestCtie = false;
    for (let p = 0; p < P; p++) {
      const local = st.eff[p][i] - st.cEff[p][i];
      if (local > 1e-12) { localPlayers++; lonePlayer = p; }
      const cv = st.cEff[p][i];
      if (cv > bestC + 1e-12) { bestC = cv; bestCp = p; bestCtie = false; } else if (Math.abs(cv - bestC) <= 1e-12) bestCtie = true;
    }
    const win = winnerOf.get(i);
    if (localPlayers === 0) pureC++;
    if (!bestCtie && bestCp >= 0 && win === `P${bestCp}`) cWinnerMatches++;
    if (localPlayers === 1 && st.visitedRoad[lonePlayer][i] === 1) {
      loneSeats[lonePlayer]++;
      if (win === `P${lonePlayer}`) loneWins[lonePlayer]++;
    }
  }
  const players: PlayerResult[] = strategies.map((s, p) => ({
    strategy: s,
    seats: seatCounts[p],
    voteShare: decided > 0 ? voteSum[p] / decided : 0,
    win: seatCounts[p] === best ? 1 / nBest : 0,
    majority: seatCounts[p] >= majority,
    rallies: counts[p].rally,
    roadshows: counts[p].road,
    reports: counts[p].rep,
    reportSpend: counts[p].repSpend,
    budgetLeft: budget[p],
    loneSeats: loneSeats[p],
    loneWins: loneWins[p],
    rejected: counts[p].rej,
  }));
  const winners = new Int16Array(w.n).fill(-1);
  for (let i = 0; i < w.n; i++) { const wn = winnerOf.get(i); if (wn) winners[i] = Number(wn.slice(1)); }
  return { players, winners, seatsDecided: decided, pureC, cOnlyWinnerSame: pureC, cWinnerMatches, verifyDiff, topShares, margins, ms: performance.now() - t0 };
}
