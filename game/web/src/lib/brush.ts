// The paint brush of the pre-campaign: pure helpers for the stroke (sampling, hit test, zoom filter) and the batcher that sends it.
import type { SeatId } from '@hp/shared';

export type Pt = readonly [number, number];

/** The brush needs a real mouse (or pen); phones and touch screens tap a seat and use the Field button. */
export const FINE_POINTER = '(hover:hover) and (pointer:fine)';
/** A press that moves less than this many pixels is a click, not a stroke. */
export const CLICK_SLOP_PX = 3;
/** How often a running stroke sends its seats. */
export const BRUSH_BATCH_MS = 150;

export const isDrag = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]) >= CLICK_SLOP_PX;

/** Points after `from` up to and including `to`, never more than `maxStep` apart, so a fast stroke skips no seat. */
export function interpolateStroke(from: Pt, to: Pt, maxStep: number): Pt[] {
  const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (d === 0) return [];
  const n = Math.ceil(d / maxStep);
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 1) / n;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t] as const;
  });
}

/** Where to test a brush at `c`: its centre and 8 points on its circle. */
export function brushProbes(c: Pt, r: number): Pt[] {
  return [c, ...Array.from({ length: 8 }, (_, i) => [c[0] + r * Math.cos((i * Math.PI) / 4), c[1] + r * Math.sin((i * Math.PI) / 4)] as const)];
}

/** The seat of a seat path or a small-seat hit circle (both carry data-seat); null for anything else. */
export function seatFromElement(el: Element): SeatId | null {
  if (!el.classList.contains('seat') && !el.classList.contains('hit')) return null;
  const v = el.getAttribute('data-seat');
  return v === null ? null : Number(v);
}

/** The seats in a stack of elements under one point (topmost first). Stops at the first element off the map: a panel over the map hides what is below it. */
export function seatsFromStack(stack: readonly Element[], map: Element): SeatId[] {
  const out: SeatId[] = [];
  for (const el of stack) {
    if (!map.contains(el)) break;
    const s = seatFromElement(el);
    if (s !== null) out.push(s);
  }
  return out;
}

/** Every seat touched by a brush of radius `r` at any of `points`. */
export function seatsUnderBrush(points: readonly Pt[], r: number, elementsAt: (x: number, y: number) => readonly Element[], map: Element): SeatId[] {
  const out = new Set<SeatId>();
  for (const c of points) for (const [x, y] of brushProbes(c, r)) for (const s of seatsFromStack(elementsAt(x, y), map)) out.add(s);
  return [...out];
}

/** d3-zoom's filter. In brush mode a left-button drag belongs to the brush and the map pans by right-drag or Space+drag; the wheel and touch stay as they are. */
export function brushZoomFilter(e: { type: string; button?: number; ctrlKey?: boolean }, brushOn: boolean, spaceHeld: boolean): boolean {
  if (brushOn && e.type === 'mousedown') return !!e.button || spaceHeld;
  return (!e.ctrlKey || e.type === 'wheel') && !e.button; // d3's default
}

export interface StrokeBatcher {
  /** Seats the running stroke touched. */
  add(seats: readonly SeatId[]): void;
  /** The stroke is over: send what is waiting. */
  endStroke(): void;
  /** Leaving the screen: forget what is waiting. */
  dispose(): void;
}

export function createStrokeBatcher(o: {
  cost: number;
  /** Money left after everything already sent. */
  available(): number;
  /** A seat with the player's candidate, or one on its way there. */
  taken(seat: SeatId): boolean;
  send(seats: SeatId[]): void;
  /** The budget cannot pay for another candidate: called once per stroke. */
  onBroke(): void;
  intervalMs?: number;
}): StrokeBatcher {
  const queue = new Set<SeatId>();
  const sent = new Set<SeatId>(); // this stroke's seats: a slow ack must not send one twice
  let broke = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const flush = () => {
    stopTimer();
    if (!queue.size) return;
    const seats = [...queue];
    queue.clear();
    seats.forEach(s => sent.add(s));
    o.send(seats);
  };
  return {
    add(seats) {
      for (const s of seats) {
        if (broke) break;
        if (queue.has(s) || sent.has(s) || o.taken(s)) continue;
        if (o.available() < (queue.size + 1) * o.cost) { broke = true; o.onBroke(); break; }
        queue.add(s);
      }
      if (queue.size && timer === undefined) timer = setTimeout(flush, o.intervalMs ?? BRUSH_BATCH_MS);
    },
    endStroke() { flush(); sent.clear(); broke = false; },
    dispose() { stopTimer(); queue.clear(); sent.clear(); },
  };
}
