// Where the tour's callout card goes, relative to the highlighted element. Pure geometry (unit-tested).

export interface Box { left: number; top: number; width: number; height: number }
export interface Placement { left: number; top: number; mode: 'sheet' | 'float' }

/** Phones and narrow windows get a bottom sheet instead of a floating card. */
export const SHEET_MAX_WIDTH = 720;
const GAP = 12;
const MARGIN = 10;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function placeCallout(anchor: Box | null, view: { w: number; h: number }, size: { w: number; h: number }, corner = false): Placement {
  if (view.w < SHEET_MAX_WIDTH) return { left: 0, top: 0, mode: 'sheet' };
  if (corner) return { left: view.w - size.w - MARGIN, top: view.h - size.h - MARGIN, mode: 'float' };
  const centred: Placement = { left: Math.round((view.w - size.w) / 2), top: Math.round((view.h - size.h) / 2), mode: 'float' };
  if (!anchor) return centred;
  const right = anchor.left + anchor.width;
  const bottom = anchor.top + anchor.height;
  const cx = anchor.left + anchor.width / 2;
  const fitsRight = right + GAP + size.w + MARGIN <= view.w;
  const fitsLeft = anchor.left - GAP - size.w >= MARGIN;
  const fitsBelow = bottom + GAP + size.h + MARGIN <= view.h;
  const fitsAbove = anchor.top - GAP - size.h >= MARGIN;
  const atRight = (): Placement => ({ left: right + GAP, top: clamp(anchor.top, MARGIN, view.h - size.h - MARGIN), mode: 'float' });
  const atLeft = (): Placement => ({ left: anchor.left - GAP - size.w, top: clamp(anchor.top, MARGIN, view.h - size.h - MARGIN), mode: 'float' });
  const below = (): Placement => ({ left: clamp(cx - size.w / 2, MARGIN, view.w - size.w - MARGIN), top: bottom + GAP, mode: 'float' });
  const above = (): Placement => ({ left: clamp(cx - size.w / 2, MARGIN, view.w - size.w - MARGIN), top: anchor.top - GAP - size.h, mode: 'float' });

  const small = anchor.height < 160 && anchor.width < view.w * 0.7;
  const nearTop = anchor.top < 160;
  const nearBottom = bottom > view.h - 140;
  const order: Array<[boolean, () => Placement]> = [];
  if (small && nearTop) order.push([fitsBelow, below]);
  if (small && nearBottom) order.push([fitsAbove, above]);
  if (cx > view.w / 2) order.push([fitsLeft, atLeft], [fitsRight, atRight]);
  else order.push([fitsRight, atRight], [fitsLeft, atLeft]);
  order.push([fitsBelow, below], [fitsAbove, above]);
  for (const [fits, make] of order) if (fits) return make();
  // nothing fits next to it (a huge anchor): bottom right of the window
  return { left: view.w - size.w - MARGIN, top: view.h - size.h - MARGIN, mode: 'float' };
}
