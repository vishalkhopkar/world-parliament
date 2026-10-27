import { describe, expect, it } from 'vitest';
import { placeCallout } from '../placement';

const view = { w: 1366, h: 800 };
const size = { w: 340, h: 220 };
const inside = (p: { left: number; top: number }) => p.left >= 0 && p.top >= 0 && p.left + size.w <= view.w && p.top + size.h <= view.h;

describe('placeCallout', () => {
  it('uses a bottom sheet on narrow screens', () => {
    expect(placeCallout({ left: 10, top: 10, width: 50, height: 50 }, { w: 390, h: 844 }, size).mode).toBe('sheet');
  });

  it('centres the card when nothing is highlighted', () => {
    const p = placeCallout(null, view, size);
    expect(p).toEqual({ left: 513, top: 290, mode: 'float' });
  });

  it('puts the card below a small element at the top of the page (the HUD)', () => {
    const a = { left: 60, top: 70, width: 160, height: 50 };
    const p = placeCallout(a, view, size);
    expect(p.top).toBeGreaterThanOrEqual(a.top + a.height);
    expect(inside(p)).toBe(true);
  });

  it('puts the card above an element at the bottom (the news ticker)', () => {
    const a = { left: 0, top: 750, width: 1366, height: 50 };
    const p = placeCallout(a, view, size);
    expect(p.top + size.h).toBeLessThanOrEqual(a.top);
    expect(inside(p)).toBe(true);
  });

  it('puts the card to the LEFT of a side-panel element and to the RIGHT of the map', () => {
    const side = { left: 1010, top: 200, width: 346, height: 300 };
    const l = placeCallout(side, view, size);
    expect(l.left + size.w).toBeLessThanOrEqual(side.left);
    const map = { left: 0, top: 125, width: 1006, height: 635 };
    const r = placeCallout(map, view, size);
    expect(r.left).toBeGreaterThanOrEqual(map.left + map.width);
    expect(inside(r)).toBe(true);
  });

  it('falls back to the bottom-right corner when nothing fits beside a huge element', () => {
    const p = placeCallout({ left: 0, top: 0, width: 1366, height: 800 }, view, size);
    expect(p).toEqual({ left: 1366 - 340 - 10, top: 800 - 220 - 10, mode: 'float' });
  });

  it('stays on screen whatever the anchor is', () => {
    for (const a of [{ left: 1300, top: 700, width: 60, height: 60 }, { left: 0, top: 0, width: 30, height: 30 }, { left: 600, top: 390, width: 120, height: 40 }]) {
      expect(inside(placeCallout(a, view, size))).toBe(true);
    }
  });

  it('corner = always bottom-right', () => {
    expect(placeCallout({ left: 100, top: 100, width: 50, height: 50 }, view, size, true)).toEqual({ left: 1016, top: 570, mode: 'float' });
  });
});
