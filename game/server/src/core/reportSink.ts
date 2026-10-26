// Post-election analysis report: one CSV per finished election (per seat and party: vote %, exact reputation, committed %).
import type { PlayerId, SeatId, SeatResult } from '@hp/shared';

export interface ReportSink {
  /** Stores one finished election's CSV under `name` (see electionReportName). May throw; callers swallow failures. */
  saveElectionCsv(name: string, csv: string): Promise<void>;
}

/** Default sink: discards the report. */
export const noopReportSink: ReportSink = { saveElectionCsv: async () => undefined };

export interface ReportParty { playerId: PlayerId; name: string }

const esc = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Per-party figures of one election, keyed by player id then seat id (missing = none). */
export interface ElectionFigures {
  results: readonly SeatResult[];
  /** Reputation in display terms (effect x display.reputationScale) but NOT rounded. */
  reputation: ReadonlyMap<PlayerId, ReadonlyMap<SeatId, number>>;
  /** Committed voters in percent of the seat's voters. */
  committedPercent: ReadonlyMap<PlayerId, ReadonlyMap<SeatId, number>>;
}

/**
 * Header `seat,seat_name,<party> vote %,...,<party> reputation,...,<party> committed %,...` (party NAME, never nickname; every party
 * incl. eliminated, in the given order), then one row per seat id in ascending order (seat_name = the map's name, else "Seat <id>").
 * Vote % = the party's share in percent (2 decimals) from the stored SeatResult.shares (post-swing); reputation = the effect x
 * display.reputationScale, unrounded; committed % in percent (2 decimals). Missing figures -> 0.
 */
export function buildElectionCsv(
  seatIds: readonly SeatId[], seatNames: Readonly<Record<number, string>>, parties: readonly ReportParty[], f: ElectionFigures,
): string {
  const bySeat = new Map(f.results.map((r) => [r.seat, r]));
  const rows = [[
    'seat', 'seat_name',
    ...parties.map((p) => `${p.name} vote %`), ...parties.map((p) => `${p.name} reputation`), ...parties.map((p) => `${p.name} committed %`),
  ].map(esc).join(',')];
  for (const seat of [...seatIds].sort((a, b) => a - b)) {
    const shares = bySeat.get(seat)?.shares ?? {};
    rows.push([
      String(seat), esc(seatNames[seat] ?? `Seat ${seat}`),
      ...parties.map((p) => ((shares[p.playerId] ?? 0) * 100).toFixed(2)),
      ...parties.map((p) => String(f.reputation.get(p.playerId)?.get(seat) ?? 0)),
      ...parties.map((p) => (f.committedPercent.get(p.playerId)?.get(seat) ?? 0).toFixed(2)),
    ].join(','));
  }
  return rows.join('\n') + '\n';
}

/** election-<UTC timestamp like 2026-10-20T14-32-05Z>-<gameId>.csv */
export function electionReportName(finishedAtMs: number, gameId: string): string {
  const ts = new Date(finishedAtMs).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  return `election-${ts}-${gameId}.csv`;
}
