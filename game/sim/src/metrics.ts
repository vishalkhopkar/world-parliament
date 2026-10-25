import type { GameResult } from './game';

export class StratAgg {
  appearances = 0;
  seats = 0;
  vote = 0;
  win = 0;
  maj = 0;
  rallies = 0;
  roadshows = 0;
  reportSpend = 0;
  budgetLeft = 0;
  loneSeats = 0;
  loneWins = 0;
  seatsSq = 0;
  rejected = 0;
  cooled = 0;
}

/** Seat-balance metrics over all polled seats: landslides (> 80% share), margin of victory (winner - runner-up share). */
export class Balance {
  seats = 0;
  over80 = 0;
  under10 = 0;
  /** histogram of margins in 0.1-point bins (0..100 points) */
  hist = new Array<number>(1001).fill(0);
  /** histogram of the winner's share in 0.1-point bins (0..100 points) */
  topHist = new Array<number>(1001).fill(0);
  add(r: GameResult) {
    for (let i = 0; i < r.margins.length; i++) {
      this.seats++;
      if (r.topShares[i] > 0.8) this.over80++;
      if (r.margins[i] < 0.1) this.under10++;
      this.hist[Math.min(1000, Math.round(r.margins[i] * 1000))]++;
      this.topHist[Math.min(1000, Math.round(r.topShares[i] * 1000))]++;
    }
  }
  merge(o: Balance) {
    this.seats += o.seats; this.over80 += o.over80; this.under10 += o.under10;
    for (let i = 0; i < this.hist.length; i++) { this.hist[i] += o.hist[i]; this.topHist[i] += o.topHist[i]; }
  }
  /** quantile q (0..1) of a 0.1-point histogram, in share points (0..100) */
  private quantile(h: number[], q: number): number {
    let acc = 0;
    for (let i = 0; i < h.length; i++) { acc += h[i]; if (acc >= this.seats * q) return i / 10; }
    return 0;
  }
  /** median margin in share points (0..100) */
  get medianMargin(): number { return this.quantile(this.hist, 0.5); }
  /** 75th percentile of the margin (a quarter of the seats are decided by more than this) */
  get p75Margin(): number { return this.quantile(this.hist, 0.75); }
  /** median winner share in points (0..100) */
  get medianTop(): number { return this.quantile(this.topHist, 0.5); }
  /** 75th percentile of the winner share */
  get p75Top(): number { return this.quantile(this.topHist, 0.75); }
  get over80Pct(): number { return this.seats ? (100 * this.over80) / this.seats : 0; }
  get under10Pct(): number { return this.seats ? (100 * this.under10) / this.seats : 0; }
  line(): string {
    return `balance: seats won with >80% share ${this.over80Pct.toFixed(1)}%   median margin ${this.medianMargin.toFixed(1)} pts   seats with margin <10 pts ${this.under10Pct.toFixed(1)}%   margin p75 ${this.p75Margin.toFixed(1)}   winner share median ${this.medianTop.toFixed(1)} p75 ${this.p75Top.toFixed(1)}   (${this.seats} seats)`;
  }
}

export class Agg {
  bal = new Balance();
  by = new Map<string, StratAgg>();
  games = 0;
  ms = 0;
  pureC = 0;
  cMatch = 0;
  decided = 0;
  rejected = 0;
  cooled = 0;
  add(r: GameResult) {
    this.games++;
    this.bal.add(r);
    this.ms += r.ms;
    this.pureC += r.pureC;
    this.cMatch += r.cWinnerMatches;
    this.decided += r.seatsDecided;
    for (const p of r.players) {
      this.rejected += p.rejected;
      this.cooled += p.cooled;
      let a = this.by.get(p.strategy);
      if (!a) { a = new StratAgg(); this.by.set(p.strategy, a); }
      a.appearances++;
      a.seats += p.seats;
      a.seatsSq += p.seats * p.seats;
      a.vote += p.voteShare;
      a.win += p.win;
      a.maj += p.majority ? 1 : 0;
      a.rallies += p.rallies;
      a.roadshows += p.roadshows;
      a.reportSpend += p.reportSpend;
      a.budgetLeft += p.budgetLeft;
      a.loneSeats += p.loneSeats;
      a.loneWins += p.loneWins;
      a.rejected += p.rejected;
      a.cooled += p.cooled;
    }
  }
}

export function pct(x: number, d = 1): string { return (100 * x).toFixed(d) + '%'; }
export function pad(s: string | number, w: number): string { const t = String(s); return t.length >= w ? t : ' '.repeat(w - t.length) + t; }
export function padR(s: string | number, w: number): string { const t = String(s); return t.length >= w ? t : t + ' '.repeat(w - t.length); }

/** Per-strategy table for a multi-player aggregate. */
export function fieldTable(agg: Agg, P: number, seatCount: number, budget: number): string {
  const rows: string[] = [];
  rows.push(`${padR('strategy', 13)}${pad('n', 6)}${pad('seats%', 8)}${pad('vote%', 8)}${pad('win%', 8)}${pad('win/fair', 9)}${pad('maj%', 7)}${pad('rally', 6)}${pad('road', 6)}${pad('left%', 7)}`);
  const names = [...agg.by.keys()].sort();
  for (const s of names) {
    const a = agg.by.get(s) as StratAgg;
    const n = a.appearances;
    rows.push(
      `${padR(s, 13)}${pad(n, 6)}${pad(pct(a.seats / n / seatCount), 8)}${pad(pct(a.vote / n), 8)}${pad(pct(a.win / n), 8)}${pad((a.win / n * P).toFixed(2), 9)}${pad(pct(a.maj / n, 0), 7)}${pad((a.rallies / n).toFixed(0), 6)}${pad((a.roadshows / n).toFixed(0), 6)}${pad(pct(a.budgetLeft / n / budget, 0), 7)}`,
    );
  }
  return rows.join('\n');
}
