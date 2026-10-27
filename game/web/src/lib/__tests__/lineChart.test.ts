import { describe, expect, it } from 'vitest';
import { chartScales, formatElapsed, linePath, niceTicks, spreadLabels, timeTicks } from '../lineChart';

const box = { width: 300, height: 200, left: 30, right: 20, top: 10, bottom: 20 };

describe('lineChart helpers', () => {
  it('chartScales maps times and values into the plot area', () => {
    const s = chartScales(1000, 5000, 100, box);
    expect(s.plot).toEqual({ x0: 30, x1: 280, y0: 10, y1: 180 });
    expect(s.x(1000)).toBe(30);
    expect(s.x(5000)).toBe(280);
    expect(s.x(3000)).toBe(155);
    expect(s.y(0)).toBe(180);
    expect(s.y(100)).toBe(10);
    expect(s.y(50)).toBe(95);
  });
  it('chartScales survives a zero time span and a zero maximum', () => {
    const s = chartScales(7, 7, 0, box);
    expect(s.x(7)).toBe(30);
    expect(Number.isFinite(s.y(0))).toBe(true);
  });
  it('linePath builds M/L commands, empty for no points', () => {
    expect(linePath([])).toBe('');
    expect(linePath([{ x: 1, y: 2 }, { x: 3.14159, y: 4 }])).toBe('M1 2 L3.1 4');
  });
  it('niceTicks start at 0 and end at or above the maximum', () => {
    const t = niceTicks(500, 4);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(500);
    expect(t).toEqual([0, 200, 400, 600].slice(0, t.length));
    expect(niceTicks(0)).toEqual([0, 1]);
  });
  it('timeTicks and formatElapsed', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(90_000)).toBe('1:30');
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
    const t = timeTicks(240_000, 4);
    expect(t[0]).toEqual({ t: 0, label: '0:00' });
    expect(t.length).toBeLessThanOrEqual(5);
    expect(timeTicks(0)).toEqual([{ t: 0, label: '0:00' }]);
  });
  it('spreadLabels separates close labels, keeps bounds and input order', () => {
    const out = spreadLabels([50, 51, 52, 200], 10, 0, 100);
    expect(out).toHaveLength(4);
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(10 - 1e-9);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...out)).toBeLessThanOrEqual(100);
    expect(out[0]).toBeLessThan(out[1]);
    expect(out[1]).toBeLessThan(out[2]);
    expect(spreadLabels([], 10, 0, 100)).toEqual([]);
    expect(spreadLabels([5, 80], 10, 0, 100)).toEqual([5, 80]);
  });
});
