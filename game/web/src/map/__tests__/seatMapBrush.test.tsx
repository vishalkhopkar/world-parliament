// SeatMap in the pre-campaign: a left-button stroke paints the seats under the brush and opens no panel, a click opens the panel and paints
// nothing, touch keeps tap and pan, the figures appear in party colours with only new ones animated, and the smoke shows spends and refunds.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { MAX_FIGURES } from '../../lib/fielding';

const topo = { type: 'Topology', arcs: [], objects: { seats: { type: 'GeometryCollection', geometries: [] } } };
vi.mock('../mapData', () => ({
  loadTopo: vi.fn(async () => topo), coarseTopoUrl: () => 'c', detailTopoUrl: () => 'd', manifestFor: () => undefined,
}));
// big squares: jsdom stays at zoom 1, and a seat 100 units wide has room for every figure
vi.mock('topojson-client', () => ({
  feature: () => ({ type: 'FeatureCollection', features: [1, 2, 3].map(id => ({ type: 'Feature', id, properties: { seat: id },
    geometry: { type: 'Polygon', coordinates: [[[id * 200, 0], [id * 200 + 100, 0], [id * 200 + 100, 100], [id * 200, 100], [id * 200, 0]]] } })) }),
}));

import { SeatMap } from '../SeatMap';

let fine = true;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {}); // jsdom has no SVG viewBox: d3-zoom's initial transform throws after the seats are drawn
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
});
beforeEach(() => {
  fine = true;
  window.matchMedia = ((q: string) => ({ matches: fine, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => { delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint; });

const fire = (target: EventTarget, type: string, x: number, y: number, init: MouseEventInit & { pointerType?: string } = {}) => {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons: 1, ...init });
  Object.defineProperty(e, 'pointerType', { value: init.pointerType ?? 'mouse' });
  act(() => { target.dispatchEvent(e); });
};
const seatEl = (c: HTMLElement, id: number) => c.querySelector<SVGPathElement>(`path.seat[data-seat="${id}"]`)!;
/** Everything on the map at x < 100 is seat 1, from there on seat 2. */
const stubHits = (c: HTMLElement) => {
  (document as unknown as { elementsFromPoint: (x: number) => Element[] }).elementsFromPoint = x => [seatEl(c, x < 100 ? 1 : 2), c.querySelector('svg')!];
};
const brush = () => ({ radiusPx: 5, onPaint: vi.fn(), onStrokeEnd: vi.fn() });
async function mounted(props: Parameters<typeof SeatMap>[0]) {
  const r = render(<SeatMap names={{}} {...props} />);
  await waitFor(() => expect(r.container.querySelectorAll('path.seat').length).toBe(3));
  return r;
}

describe('painting with the brush', () => {
  it('shows the brush cursor only with a fine pointer', async () => {
    const { container } = await mounted({ brush: brush() });
    expect(container.querySelector('.brush-cursor')).toBeInTheDocument();
    expect(container.querySelector('svg.map')).toHaveClass('brushing');
    fine = false;
    const other = render(<SeatMap names={{}} brush={brush()} />);
    expect(other.container.querySelector('.brush-cursor')).toBeNull();
  });
  it('a left-button stroke paints every seat it crosses, with the seat under the start included, and ends the stroke', async () => {
    const b = brush();
    const { container } = await mounted({ brush: b });
    stubHits(container);
    fire(seatEl(container, 1), 'pointerdown', 50, 50);
    fire(window, 'pointermove', 180, 50);
    fire(window, 'pointerup', 180, 50, { buttons: 0 });
    const seats = new Set(b.onPaint.mock.calls.flatMap(c => c[0] as number[]));
    expect([...seats].sort()).toEqual([1, 2]);
    expect(b.onStrokeEnd).toHaveBeenCalledTimes(1);
  });
  it('a real stroke does not also open the panel when it ends on the seat where it started', async () => {
    const b = brush(), onSeatClick = vi.fn();
    const { container } = await mounted({ brush: b, onSeatClick });
    stubHits(container);
    const seat = seatEl(container, 1);
    fire(seat, 'pointerdown', 50, 50);
    fire(window, 'pointermove', 80, 50);
    fire(window, 'pointerup', 80, 50, { buttons: 0 });
    fire(seat, 'click', 80, 50, { buttons: 0 });
    expect(b.onPaint).toHaveBeenCalled();
    expect(onSeatClick).not.toHaveBeenCalled();
  });
  it('a click with no movement opens the panel and paints nothing', async () => {
    const b = brush(), onSeatClick = vi.fn();
    const { container } = await mounted({ brush: b, onSeatClick });
    stubHits(container);
    const seat = seatEl(container, 1);
    fire(seat, 'pointerdown', 50, 50);
    fire(window, 'pointermove', 51, 51);
    fire(window, 'pointerup', 51, 51, { buttons: 0 });
    fire(seat, 'click', 51, 51, { buttons: 0 });
    expect(onSeatClick).toHaveBeenCalledWith(1);
    expect(b.onPaint).not.toHaveBeenCalled();
    expect(b.onStrokeEnd).not.toHaveBeenCalled();
  });
  it('the next click still works after a stroke', async () => {
    const b = brush(), onSeatClick = vi.fn();
    const { container } = await mounted({ brush: b, onSeatClick });
    stubHits(container);
    const seat = seatEl(container, 1);
    fire(seat, 'pointerdown', 50, 50);
    fire(window, 'pointermove', 80, 50);
    fire(window, 'pointerup', 80, 50, { buttons: 0 });
    fire(seat, 'pointerdown', 80, 50);
    fire(window, 'pointerup', 80, 50, { buttons: 0 });
    fire(seat, 'click', 80, 50, { buttons: 0 });
    expect(onSeatClick).toHaveBeenCalledWith(1);
  });
  it('the right button never paints, and the context menu is held back on the map', async () => {
    const b = brush();
    const { container } = await mounted({ brush: b });
    stubHits(container);
    fire(seatEl(container, 1), 'pointerdown', 50, 50, { button: 2, buttons: 2 });
    fire(window, 'pointermove', 90, 50, { button: 2, buttons: 2 });
    expect(b.onPaint).not.toHaveBeenCalled();
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    container.querySelector('svg')!.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
  });
  it('holding Space turns a left drag into panning, not painting', async () => {
    const b = brush();
    const { container } = await mounted({ brush: b });
    stubHits(container);
    fire(seatEl(container, 1), 'pointermove', 50, 50, { buttons: 0 }); // the pointer is over the map
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); });
    fire(seatEl(container, 1), 'pointerdown', 50, 50);
    fire(window, 'pointermove', 90, 50);
    expect(b.onPaint).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' })); });
    fire(window, 'pointerup', 90, 50, { buttons: 0 });
  });
  it('touch keeps tap: a touch press never starts a stroke', async () => {
    const b = brush(), onSeatClick = vi.fn();
    const { container } = await mounted({ brush: b, onSeatClick });
    stubHits(container);
    const seat = seatEl(container, 1);
    fire(seat, 'pointerdown', 50, 50, { pointerType: 'touch' });
    fire(window, 'pointermove', 90, 50, { pointerType: 'touch' });
    fire(window, 'pointerup', 90, 50, { pointerType: 'touch', buttons: 0 });
    fire(seat, 'click', 50, 50, { buttons: 0 });
    expect(b.onPaint).not.toHaveBeenCalled();
    expect(onSeatClick).toHaveBeenCalledWith(1);
  });
  it('without a brush a press never paints and the map has no brush cursor', async () => {
    const onSeatClick = vi.fn();
    const { container } = await mounted({ onSeatClick });
    expect(container.querySelector('.brush-cursor')).toBeNull();
    fire(seatEl(container, 2), 'click', 250, 50, { buttons: 0 });
    expect(onSeatClick).toHaveBeenCalledWith(2);
  });
});

describe('candidate figures', () => {
  const row = (...ids: string[]) => ids.map((id, i) => ({ id, colour: `#00000${i}` }));
  const figures = (c: HTMLElement, seat?: number) => [...c.querySelectorAll<SVGGElement>(seat === undefined ? '.candidate-figure' : `.seat-candidates[data-seat="${seat}"] .candidate-figure`)];
  it('draws a figure per party in its colour, own first as given', async () => {
    const { container } = await mounted({ candidates: { 1: row('a', 'b') } });
    const f = figures(container, 1);
    expect(f.map(x => x.style.color)).toEqual(['rgb(0, 0, 0)', 'rgb(0, 0, 1)']);
    expect(f[0].querySelector('use')).toBeInTheDocument();
  });
  it(`draws at most ${MAX_FIGURES} figures and a "+n" for the rest`, async () => {
    const { container } = await mounted({ candidates: { 1: row('a', 'b', 'c', 'd', 'e', 'f') } });
    expect(figures(container, 1)).toHaveLength(MAX_FIGURES);
    expect(container.querySelector('.candidate-more')?.textContent).toBe(`+${6 - MAX_FIGURES}`);
  });
  it('animates only the newly added figures, not the ones present when the map was drawn', async () => {
    const { container, rerender } = await mounted({ candidates: { 1: row('a') } });
    expect(container.querySelectorAll('.candidate-figure.pop')).toHaveLength(0);
    rerender(<SeatMap names={{}} candidates={{ 1: row('a', 'b'), 2: row('c') }} />);
    expect(figures(container)).toHaveLength(3);
    expect(container.querySelectorAll('.candidate-figure.pop')).toHaveLength(2);
    expect(figures(container, 1)[0].classList.contains('pop')).toBe(false);
  });
  it('removes the figure of a withdrawn candidate and hides them all when none are passed', async () => {
    const { container, rerender } = await mounted({ candidates: { 1: row('a', 'b') } });
    rerender(<SeatMap names={{}} candidates={{ 1: row('a') }} />);
    expect(figures(container, 1)).toHaveLength(1);
    rerender(<SeatMap names={{}} />);
    expect(figures(container)).toHaveLength(0);
  });
});

describe('dimming seats without an own candidate', () => {
  it('fades every seat outside the contesting set', async () => {
    const { container } = await mounted({ contesting: new Set([2]) });
    expect(seatEl(container, 1)).toHaveClass('faded');
    expect(seatEl(container, 2)).not.toHaveClass('faded');
  });
  it('fades nothing when no set is passed', async () => {
    const { container } = await mounted({});
    expect(container.querySelectorAll('path.seat.faded')).toHaveLength(0);
  });
});

describe('money smoke', () => {
  it('shows a red -cost on seats paid for and a green +cost on seats refunded', async () => {
    const { container, rerender } = await mounted({});
    rerender(<SeatMap names={{}} gains={{ key: 1, seats: {}, spends: { 1: 50 }, refunds: { 2: 50 } }} />);
    expect(container.querySelector('g.seat-spend')?.textContent).toBe('-50');
    expect(container.querySelector('g.seat-refund')?.textContent).toBe('+50');
  });
});
