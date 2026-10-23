import type { CommittedView, SeatId } from '@hp/shared';

/** Share of white mixed into the party colour per committed-voters level (HIGH = full colour, darkest). */
export const COMMITTED_WHITE_MIX: Record<CommittedView['level'], number> = { HIGH: 0, MEDIUM: 0.45, LOW: 0.75 };

function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) h = '808080';
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** Party colour mixed with white for a committed-voters level; always #rrggbb. */
export function committedFill(hex: string, level: CommittedView['level']): string {
  const t = COMMITTED_WHITE_MIX[level];
  return '#' + parseHex(hex).map(c => Math.round(c + (255 - c) * t).toString(16).padStart(2, '0')).join('');
}

/** seat -> shaded party colour for the player's own committed seats. */
export function committedFills(committed: readonly CommittedView[] | undefined, hex: string): Record<SeatId, string> {
  const out: Record<SeatId, string> = {};
  for (const c of committed ?? []) out[c.seat] = committedFill(hex, c.level);
  return out;
}
