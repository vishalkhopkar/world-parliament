// How the tour notices that the player did what a task step asked. Pure functions of the game store's state.
import type { GameSnapshot, PrivateState, SeatId } from '@hp/shared';
import type { TaskId } from './steps';

export interface TaskInput {
  selectedSeat: SeatId | null;
  priv: PrivateState | null;
  snapshot: GameSnapshot | null;
  error: string | null;
  /** Server-synchronised time now (ms). */
  now: number;
  /** The most seats of yours that held a candidate at any moment so far (the overlay keeps it: a withdrawal is a drop from it). */
  peakFielded?: number;
}

/** How many seats the painting task asks for ("at least a few"). */
export const FIELD_TASK_SEATS = 5;

/** Seats where `you` has a candidate. */
export function fieldedByMe(snapshot: GameSnapshot | null, you: string | undefined): number {
  if (!snapshot || !you) return 0;
  return Object.values(snapshot.fielding ?? {}).filter(list => list.some(c => c.playerId === you)).length;
}

/** The refusal text of a second rally during the cooldown (the mock, the tour and the real server all say "next rally in N s" or "once every"). */
export const COOLDOWN_REFUSAL = /(once every|next rally)/i;

export function taskDone(id: TaskId, s: TaskInput): boolean {
  switch (id) {
    case 'committed':
      return s.selectedSeat !== null && !!s.priv?.committed?.some(c => c.seat === s.selectedSeat);
    case 'rally':
      return !!s.priv?.myActions.some(a => a.type === 'rally');
    case 'cooldown':
      // refused (toast), or the Rally button of an open seat panel is on cooldown
      return (!!s.error && /rally/i.test(s.error) && COOLDOWN_REFUSAL.test(s.error))
        || (s.selectedSeat !== null && (s.priv?.nextRallyAt ?? 0) > s.now);
    case 'roadshow':
      return !!s.priv?.myActions.some(a => a.type === 'roadshow');
    case 'minorRally':
      return !!s.priv?.myActions.some(a => a.type === 'minorRally');
    case 'field':
      return fieldedByMe(s.snapshot, s.priv?.you) >= FIELD_TASK_SEATS;
    case 'withdraw':
      return (s.peakFielded ?? 0) > 0 && fieldedByMe(s.snapshot, s.priv?.you) < (s.peakFielded ?? 0);
    case 'govern':
      return s.snapshot?.status === 'finished' || !!s.snapshot?.offers.some(o => o.status === 'accepted' || o.status === 'formed');
  }
}
