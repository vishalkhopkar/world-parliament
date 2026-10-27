// SeatMap: a change of `gains.key` makes green "+N" smoke nodes at the seat centres plus one global label.
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';

const topo = {
  type: 'Topology', arcs: [],
  objects: { seats: { type: 'GeometryCollection', geometries: [1, 2, 3].map(id => ({ type: 'Polygon', id, properties: { seat: id }, arcs: [] })) } },
};
vi.mock('../mapData', () => ({
  loadTopo: vi.fn(async () => topo), coarseTopoUrl: () => 'c', detailTopoUrl: () => 'd', manifestFor: () => undefined,
}));
vi.mock('topojson-client', () => ({
  feature: () => ({ type: 'FeatureCollection', features: [1, 2, 3].map(id => ({ type: 'Feature', id, properties: { seat: id },
    geometry: { type: 'Polygon', coordinates: [[[id * 20, 0], [id * 20 + 10, 0], [id * 20 + 10, 10], [id * 20, 10], [id * 20, 0]]] } })) }),
}));

import { SeatMap } from '../SeatMap';

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {}); // jsdom has no SVG viewBox: d3-zoom's initial transform throws after the seats are drawn
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
});

describe('SeatMap smoke', () => {
  it('creates a +N node per gained seat and one global label, then removes them', async () => {
    const { container, rerender } = render(<SeatMap names={{}} />);
    await waitFor(() => expect(container.querySelectorAll('path.seat').length).toBe(3));
    rerender(<SeatMap names={{}} gains={{ key: 1, seats: { 1: 20, 2: 9 }, globalText: 'Every other seat +1' }} />);
    const nodes = [...container.querySelectorAll('g.rep-smoke')];
    expect(nodes.map(n => n.textContent).sort()).toEqual(['+20', '+9', 'Every other seat +1'].sort());
    expect(container.querySelectorAll('g.rep-smoke.global').length).toBe(1);
    // same key again: nothing new
    rerender(<SeatMap names={{}} gains={{ key: 1, seats: { 1: 20, 2: 9 }, globalText: 'Every other seat +1' }} />);
    expect(container.querySelectorAll('g.rep-smoke').length).toBe(3);
    await act(async () => { await new Promise(r => setTimeout(r, 2600)); });
    expect(container.querySelectorAll('g.rep-smoke').length).toBe(0);
  });
});
