// Who has a candidate where: the pure part of the pre-campaign's fielding, shared by the repos.
import type { SeatId } from '@hp/shared';
import type { FieldingChange } from './types';

/**
 * The effect of a batch on a party's fielded list: `added` / `removed` hold only the seats that really change (seats already fielded,
 * without a candidate, or repeated in the batch are skipped), `fielded` is the new list (existing order kept, new seats appended).
 */
export function applyFieldingChange(current: readonly SeatId[] | undefined, change: Pick<FieldingChange, 'op' | 'seats'>): { added: SeatId[]; removed: SeatId[]; fielded: SeatId[] } {
  const have = new Set(current ?? []);
  const wanted = [...new Set(change.seats)];
  if (change.op === 'field') {
    const added = wanted.filter((s) => !have.has(s));
    return { added, removed: [], fielded: [...(current ?? []), ...added] };
  }
  const removed = wanted.filter((s) => have.has(s));
  const gone = new Set(removed);
  return { added: [], removed, fielded: (current ?? []).filter((s) => !gone.has(s)) };
}
