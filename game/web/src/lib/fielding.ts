// Who has a candidate where (GameSnapshot.fielding, public and live) and what the map draws for it.
import type { FieldedCandidate, FieldedSeat, GameSnapshot, PlayerId, PlayerPublic, SeatId } from '@hp/shared';
import { PARTY_COLOURS } from '@hp/shared';

type Fielding = GameSnapshot['fielding'];

/** Most figures drawn on one seat; any more are counted as "+n". */
export const MAX_FIGURES = 4;
/** Width of a figure on the map, in screen pixels. */
export const FIGURE_WIDTH_PX = 10;
/** A seat smaller than this on screen has no room for the "+n". */
const MORE_MIN_SEAT_PX = 24;
/** More new figures than this at once is a bulk arrival, not a player painting: they appear without the pop-in. */
export const MAX_POP_IN_FIGURES = 60;
export const popsIn = (newFigures: number) => newFigures <= MAX_POP_IN_FIGURES;

export const candidatesIn = (s: Pick<GameSnapshot, 'fielding'>, seat: SeatId): FieldedCandidate[] => s.fielding[seat] ?? [];
export const hasCandidate = (s: Pick<GameSnapshot, 'fielding'>, seat: SeatId, id: PlayerId | null | undefined) => candidatesIn(s, seat).some(c => c.playerId === id);

export function seatsOfParty(fielding: Fielding, id: PlayerId | null | undefined): Set<SeatId> {
  const out = new Set<SeatId>();
  for (const [seat, list] of Object.entries(fielding)) if (list.some(c => c.playerId === id)) out.add(Number(seat));
  return out;
}

export function candidateCounts(fielding: Fielding): Record<PlayerId, number> {
  const out: Record<PlayerId, number> = {};
  for (const list of Object.values(fielding)) for (const c of list) out[c.playerId] = (out[c.playerId] ?? 0) + 1;
  return out;
}

/** The map after a party fielded `added` and withdrew `removed`. Idempotent: the ack and the broadcast both carry the same change. */
export function applyFielding(fielding: Fielding, id: PlayerId, added: readonly FieldedSeat[], removed: readonly SeatId[]): Fielding {
  const next = { ...fielding };
  for (const seat of removed) {
    const list = (next[seat] ?? []).filter(c => c.playerId !== id);
    if (list.length) next[seat] = list; else delete next[seat];
  }
  for (const { seat, name } of added) {
    const list = next[seat] ?? [];
    if (!list.some(c => c.playerId === id)) next[seat] = [...list, { playerId: id, ...(name !== undefined ? { name } : {}) }];
  }
  return next;
}

/** "n of m done": the counts of the latest fieldingDone message, else worked out from the snapshot (the connected active players must all be done). */
export function doneProgress(s: Pick<GameSnapshot, 'fieldingDone' | 'players'>, stats: { doneCount: number; needed: number } | null | undefined): { doneCount: number; needed: number } {
  return stats ?? { doneCount: s.fieldingDone.length, needed: s.players.filter(p => p.status === 'active').length };
}

/** Seats nobody contests: they are out of the election (shown hatched). */
export function vacantSeats(s: Pick<GameSnapshot, 'fielding' | 'contestedSeats'>, seatIds: readonly SeatId[]): Set<SeatId> {
  if (s.contestedSeats >= seatIds.length) return new Set();
  return new Set(seatIds.filter(id => !s.fielding[id]?.length));
}

export interface CandidateParty { id: PlayerId; colour: string }

const hexOf = (c: string | undefined) => (c ? PARTY_COLOURS.find(x => x.id === c)?.hex ?? c : '#8a8676');

/** seat -> the parties to draw there, own party first. */
export function candidateRows(fielding: Fielding, players: readonly PlayerPublic[], me: PlayerId | null | undefined): Record<SeatId, CandidateParty[]> {
  const colour = new Map(players.map(p => [p.playerId, hexOf(p.party?.colour)]));
  const out: Record<SeatId, CandidateParty[]> = {};
  for (const [seat, list] of Object.entries(fielding)) {
    if (!list.length) continue;
    const row = list.map(c => ({ id: c.playerId, colour: colour.get(c.playerId) ?? hexOf(undefined) }));
    out[Number(seat)] = row.sort((a, b) => Number(b.id === me) - Number(a.id === me));
  }
  return out;
}

/** How many of `total` figures fit on a seat this big on screen (own first, so a tiny seat still shows that it is yours), and the "+n". */
export function figuresToShow(total: number, seatPx: number): { shown: number; extra: number } {
  if (total <= 0) return { shown: 0, extra: 0 };
  const shown = Math.min(total, MAX_FIGURES, Math.max(1, Math.floor(seatPx / FIGURE_WIDTH_PX)));
  return { shown, extra: seatPx >= MORE_MIN_SEAT_PX ? total - shown : 0 };
}
