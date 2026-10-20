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
}

export class Agg {
  by = new Map<string, StratAgg>();
  games = 0;
  ms = 0;
  pureC = 0;
  cMatch = 0;
  decided = 0;
  rejected = 0;
  add(r: GameResult) {
    this.games++;
    this.ms += r.ms;
    this.pureC += r.pureC;
    this.cMatch += r.cWinnerMatches;
    this.decided += r.seatsDecided;
    for (const p of r.players) {
      this.rejected += p.rejected;
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
