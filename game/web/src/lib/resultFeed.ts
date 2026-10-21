import type { PlayerId, SeatDeclaration, SeatId, SeatSharesMessage } from '@hp/shared';

export type PanelKind = 'LEADS' | 'WON' | 'TRAILS' | 'LOST';
export interface PanelWant { seat: SeatId; kind: PanelKind }
/** What a card shows: the seat, the kind and the party it is about. */
export interface PanelPick { seat: SeatId; kind: PanelKind; partyId: PlayerId }

export const PANEL_W = 220;
export const PANEL_H = 200;
export const PANEL_GAP = 8;
export const MAX_STACK = 60;

/** How many cards fit a column of the given height (at least 2). */
export function panelCount(availableHeight: number, cardHeight = PANEL_H, gap = PANEL_GAP): number {
  return Math.max(2, Math.floor((availableHeight + gap) / (cardHeight + gap)));
}

export const wantKey = (w: PanelWant) => `${w.seat}:${w.kind}`;
const isPrimary = (k: PanelKind) => k === 'LEADS' || k === 'WON';
/** The kind a card can have for a seat in this status: stale LEADS/TRAILS of a won seat become WON/LOST. */
const settle = (kind: PanelKind, status: 'leading' | 'won'): PanelKind =>
  status === 'won' ? (isPrimary(kind) ? 'WON' : 'LOST') : (isPrimary(kind) ? 'LEADS' : 'TRAILS');
const kindsFor = (status: 'leading' | 'won'): PanelKind[] => (status === 'won' ? ['WON', 'LOST'] : ['LEADS', 'TRAILS']);

/**
 * Which seat/kind the next card shows. Policy: newest event first, then random declared seats.
 * Pure state machine: the random source is injectable; no timers, no network.
 */
export class ResultFeed {
  private stack: PanelWant[] = [];
  private known: Map<SeatId, string> | null = null;
  constructor(private random: () => number = Math.random, private maxStack = MAX_STACK) {}

  get size() { return this.stack.length; }

  /** Feed the latest declarations; a seat that is new or changed (status, leader) pushes events. The first call only seeds. */
  update(seats: Record<SeatId, SeatDeclaration>) {
    const next = new Map<SeatId, string>();
    for (const d of Object.values(seats)) {
      const sig = `${d.status}:${d.playerId}`;
      next.set(d.seat, sig);
      if (this.known && this.known.get(d.seat) !== sig) {
        // companion first, so the primary is popped first and the companion right after it
        const [primary, companion] = kindsFor(d.status);
        this.stack.push({ seat: d.seat, kind: companion }, { seat: d.seat, kind: primary });
      }
    }
    this.known = next;
    if (this.stack.length > this.maxStack) this.stack.splice(0, this.stack.length - this.maxStack);
  }

  /**
   * Next seat+kind to show. `visible` = keys (wantKey) on screen now, `skip` = keys to avoid (failed this round).
   * Returns null when nothing is declared. Duplicates of visible cards are avoided if an alternative exists.
   */
  pick(seats: Record<SeatId, SeatDeclaration>, visible: Set<string>, skip: Set<string> = new Set()): PanelWant | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const ev = this.stack[i];
      const d = seats[ev.seat];
      if (!d) { this.stack.splice(i, 1); continue; }
      const w = { seat: ev.seat, kind: settle(ev.kind, d.status) };
      if (visible.has(wantKey(w)) || skip.has(wantKey(w))) continue;
      this.stack.splice(i, 1);
      return w;
    }
    const all: PanelWant[] = [];
    for (const d of Object.values(seats)) for (const kind of kindsFor(d.status)) all.push({ seat: d.seat, kind });
    const free = all.filter(w => !visible.has(wantKey(w)) && !skip.has(wantKey(w)));
    const pool = free.length ? free : all.filter(w => !skip.has(wantKey(w)));
    return pool.length ? pool[Math.floor(this.random() * pool.length)] : null;
  }

  /**
   * Final card for a want, once the shares answer is in. LEADS/WON: the declared leader. TRAILS/LOST: the runner-up
   * (runnerUp/(runnerUp+other) of the time, else a random other non-leading party; always the runner-up if there is
   * no other). Random calls: one for runner-up vs other, one more to choose among the others.
   */
  resolve(want: PanelWant, decl: SeatDeclaration, answer: SeatSharesMessage, knownParties: PlayerId[],
    pct: { runnerUp: number; other: number }): PanelPick | null {
    const kind = settle(want.kind, answer.status);
    if (isPrimary(kind)) return { seat: want.seat, kind, partyId: decl.playerId };
    const others = Object.entries(answer.shares)
      .filter(([id]) => id !== decl.playerId && knownParties.includes(id))
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    if (!others.length) return null;
    const [runner, ...rest] = others;
    const total = pct.runnerUp + pct.other;
    const useRunner = !rest.length || (total > 0 ? this.random() * total < pct.runnerUp : true);
    const partyId = useRunner ? runner : rest[Math.floor(this.random() * rest.length)];
    return { seat: want.seat, kind, partyId };
  }
}
