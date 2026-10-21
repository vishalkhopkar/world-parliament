// Post-election analysis report: one CSV per finished election (seats x parties, vote %).
import type { PlayerId, SeatId, SeatResult } from '@hp/shared';

export interface ReportSink {
  /** Stores one finished election's CSV under `name` (see electionReportName). May throw; callers swallow failures. */
  saveElectionCsv(name: string, csv: string): Promise<void>;
}

/** Default sink: discards the report. */
export const noopReportSink: ReportSink = { saveElectionCsv: async () => undefined };

export interface ReportParty { playerId: PlayerId; name: string }

const esc = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * Header `seat,<party name>,...` (party NAME, never nickname; every party incl. eliminated, in the given order),
 * then one row per seat id in ascending order. Cells = the party's vote share in that seat in percent (2 decimals),
 * taken from the stored SeatResult.shares (post-swing effect ratio). Missing shares / seats without effect -> 0.00.
 */
export function buildElectionCsv(seatIds: readonly SeatId[], results: readonly SeatResult[], parties: readonly ReportParty[]): string {
  const bySeat = new Map(results.map((r) => [r.seat, r]));
  const rows = [['seat', ...parties.map((p) => p.name)].map(esc).join(',')];
  for (const seat of [...seatIds].sort((a, b) => a - b)) {
    const shares = bySeat.get(seat)?.shares ?? {};
    rows.push([String(seat), ...parties.map((p) => ((shares[p.playerId] ?? 0) * 100).toFixed(2))].join(','));
  }
  return rows.join('\n') + '\n';
}

/** election-<UTC timestamp like 2026-10-20T14-32-05Z>-<gameId>.csv */
export function electionReportName(finishedAtMs: number, gameId: string): string {
  const ts = new Date(finishedAtMs).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  return `election-${ts}-${gameId}.csv`;
}
