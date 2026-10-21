import { describe, expect, it } from 'vitest';
import { pieSlices } from '../pie';

const v = (id: string, value: number) => ({ id, value, colour: '#' + id });

describe('pieSlices', () => {
  it('returns [] for empty input or only unusable values', () => {
    expect(pieSlices([])).toEqual([]);
    expect(pieSlices([v('a', 0), v('b', -1), v('c', NaN), v('d', Infinity)])).toEqual([]);
  });

  it('normalises to fractions that sum to 1, whatever the scale', () => {
    for (const k of [1, 0.01, 1000]) {
      const s = pieSlices([v('a', 3 * k), v('b', 2 * k), v('c', 5 * k)]);
      [0.3, 0.2, 0.5].forEach((f, i) => expect(s[i].fraction).toBeCloseTo(f, 9));
      expect(s.reduce((a, x) => a + x.fraction, 0)).toBeCloseTo(1, 9);
    }
  });

  it('drops zero, negative and non-finite values but keeps the order of the rest', () => {
    const s = pieSlices([v('a', 1), v('z', 0), v('b', 1), v('n', -3), v('x', NaN), v('c', 2)]);
    expect(s.map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(s.map(x => x.fraction)).toEqual([0.25, 0.25, 0.5]);
  });

  it('starts at 12 o clock and runs clockwise without gaps', () => {
    const s = pieSlices([v('a', 1), v('b', 1), v('c', 2)]);
    expect(s[0].startAngle).toBe(0);
    expect(s[0].endAngle).toBeCloseTo(Math.PI / 2, 9);
    expect(s[1].startAngle).toBeCloseTo(s[0].endAngle, 9);
    expect(s[2].endAngle).toBeCloseTo(Math.PI * 2, 9);
    // first wedge: from the top (100 0) to the right (200 100) for radius 100
    expect(s[0].path).toBe('M 100 100 L 100 0 A 100 100 0 0 1 200 100 Z');
  });

  it('sets the large-arc flag only for slices over half', () => {
    const [big, small] = pieSlices([v('a', 60), v('b', 40)]);
    expect(big.path).toMatch(/A 100 100 0 1 1/);
    expect(small.path).toMatch(/A 100 100 0 0 1/);
    const [half] = pieSlices([v('a', 1), v('b', 1)]);
    expect(half.path).toMatch(/A 100 100 0 0 1/);
  });

  it('draws a single 100% slice as a full circle (two arcs), also when others are zero', () => {
    for (const s of [pieSlices([v('a', 7)]), pieSlices([v('a', 7), v('b', 0)])]) {
      expect(s).toHaveLength(1);
      expect(s[0].fraction).toBe(1);
      expect(s[0].path.match(/A /g)).toHaveLength(2);
      expect(s[0].path).not.toContain('L ');
    }
  });

  it('honours radius and centre, and carries colour and label (label defaults to the id)', () => {
    const [a, b] = pieSlices([{ id: 'a', value: 1, colour: '#111', label: 'Alpha' }, v('b', 1)], { radius: 50, cx: 60, cy: 70 });
    expect(a.path).toBe('M 60 70 L 60 20 A 50 50 0 0 1 60 120 Z');
    expect(a.colour).toBe('#111');
    expect(a.label).toBe('Alpha');
    expect(b.label).toBe('b');
  });
});
