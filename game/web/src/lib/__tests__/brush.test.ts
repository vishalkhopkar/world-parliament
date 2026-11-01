// The paint brush of the pre-campaign: strokes are sampled densely enough not to skip seats, a seat is recognised from a seat path or a
// small-seat hit circle, only what is on top of the map counts, and the batcher sends what the budget can pay for, once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brushProbes, brushZoomFilter, createStrokeBatcher, interpolateStroke, isDrag, seatFromElement, seatsFromStack, seatsUnderBrush } from '../brush';

const svgNs = 'http://www.w3.org/2000/svg';
function makeMap() {
  const svg = document.createElementNS(svgNs, 'svg');
  const seat = (id: number, tag = 'path', cls = 'seat') => {
    const el = document.createElementNS(svgNs, tag);
    el.setAttribute('class', cls); el.setAttribute('data-seat', String(id));
    svg.appendChild(el);
    return el;
  };
  return { svg, seat };
}

describe('stroke interpolation', () => {
  it('leaves no gap larger than the step between the start of a stroke and its end', () => {
    const pts = interpolateStroke([0, 0], [100, 0], 14);
    const all = [[0, 0], ...pts];
    for (let i = 1; i < all.length; i++) expect(Math.hypot(all[i][0] - all[i - 1][0], all[i][1] - all[i - 1][1])).toBeLessThanOrEqual(14);
    expect(pts[pts.length - 1]).toEqual([100, 0]);
  });
  it('gives just the end point when it is closer than one step', () => {
    expect(interpolateStroke([5, 5], [6, 5], 14)).toEqual([[6, 5]]);
  });
  it('gives nothing when the pointer did not move', () => {
    expect(interpolateStroke([5, 5], [5, 5], 14)).toEqual([]);
  });
});

describe('what counts as a drag', () => {
  it('a movement under 3 pixels is still a click', () => {
    expect(isDrag([0, 0], [2, 2])).toBe(false);
  });
  it('a movement of 3 pixels or more is a stroke', () => {
    expect(isDrag([0, 0], [3, 0])).toBe(true);
  });
});

describe('brush probes', () => {
  it('tests the centre and 8 points on the circle', () => {
    const p = brushProbes([10, 20], 5);
    expect(p).toHaveLength(9);
    expect(p[0]).toEqual([10, 20]);
    for (const q of p.slice(1)) expect(Math.hypot(q[0] - 10, q[1] - 20)).toBeCloseTo(5);
  });
});

describe('recognising seats', () => {
  it('reads the seat from a seat path and from a small-seat hit circle', () => {
    const { seat } = makeMap();
    expect(seatFromElement(seat(7))).toBe(7);
    expect(seatFromElement(seat(8, 'circle', 'hit'))).toBe(8);
  });
  it('ignores any other element, even one carrying a seat number', () => {
    const { seat } = makeMap();
    expect(seatFromElement(seat(9, 'g', 'seat-badge'))).toBeNull();
    expect(seatFromElement(document.createElement('div'))).toBeNull();
  });
  it('collects every seat in the stack under a point', () => {
    const { svg, seat } = makeMap();
    expect(seatsFromStack([seat(1, 'circle', 'hit'), seat(2), svg], svg)).toEqual([1, 2]);
  });
  it('paints nothing under a panel that covers the map', () => {
    const { svg, seat } = makeMap();
    expect(seatsFromStack([document.createElement('div'), seat(2), svg], svg)).toEqual([]);
  });
  it('collects each seat once along all the probed points', () => {
    const { svg, seat } = makeMap();
    const a = seat(1), b = seat(2);
    const at = (x: number) => (x < 10 ? [a, svg] : [b, svg]);
    expect(seatsUnderBrush([[0, 0], [20, 0]], 3, x => at(x), svg).sort()).toEqual([1, 2]);
  });
});

describe('zoom filter in brush mode', () => {
  const ev = (type: string, button = 0, ctrlKey = false) => ({ type, button, ctrlKey });
  it('gives a left-button drag to the brush', () => {
    expect(brushZoomFilter(ev('mousedown'), true, false)).toBe(false);
  });
  it('pans with the right button', () => {
    expect(brushZoomFilter(ev('mousedown', 2), true, false)).toBe(true);
  });
  it('pans with the left button while Space is held', () => {
    expect(brushZoomFilter(ev('mousedown'), true, true)).toBe(true);
  });
  it('keeps the wheel and touch gestures', () => {
    expect(brushZoomFilter(ev('wheel'), true, false)).toBe(true);
    expect(brushZoomFilter(ev('touchstart'), true, false)).toBe(true);
  });
  it('is the normal d3 behaviour outside brush mode: left drag pans, right does not', () => {
    expect(brushZoomFilter(ev('mousedown'), false, false)).toBe(true);
    expect(brushZoomFilter(ev('mousedown', 2), false, false)).toBe(false);
  });
});

describe('stroke batcher', () => {
  const COST = 50;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  function setup(start = 1000, taken: number[] = []) {
    const budget = { left: start };
    const send = vi.fn((seats: number[]) => { budget.left -= seats.length * COST; });
    const onBroke = vi.fn();
    const b = createStrokeBatcher({ cost: COST, intervalMs: 150, available: () => budget.left, taken: s => taken.includes(s), send, onBroke });
    return { b, send, onBroke };
  }
  it('sends the seats of a stroke together once per interval', () => {
    const { b, send } = setup();
    b.add([1, 2]); b.add([3]);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([1, 2, 3]);
  });
  it('sends what is waiting at once when the stroke ends', () => {
    const { b, send } = setup();
    b.add([1]);
    b.endStroke();
    expect(send).toHaveBeenCalledWith([1]);
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('skips seats already fielded or already in flight', () => {
    const { b, send } = setup(1000, [2]);
    b.add([1, 2]);
    vi.advanceTimersByTime(150);
    b.add([1, 3]);
    vi.advanceTimersByTime(150);
    expect(send.mock.calls).toEqual([[[1]], [[3]]]);
  });
  it('stops with one message when the remaining budget cannot cover another candidate', () => {
    const { b, send, onBroke } = setup(2 * COST);
    b.add([1, 2, 3, 4]);
    b.add([5]);
    vi.advanceTimersByTime(150);
    b.add([6]);
    b.endStroke();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([1, 2]);
    expect(onBroke).toHaveBeenCalledTimes(1);
  });
  it('a new stroke may try again and warns again', () => {
    const { b, onBroke } = setup(0);
    b.add([1]); b.endStroke();
    b.add([1]); b.endStroke();
    expect(onBroke).toHaveBeenCalledTimes(2);
  });
  it('a seat withdrawn after the stroke can be painted again by the next stroke', () => {
    const { b, send } = setup();
    b.add([1]); b.endStroke();
    b.add([1]); b.endStroke();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
