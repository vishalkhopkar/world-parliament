import { describe, expect, it } from 'vitest';
import { committedFill, committedFills, COMMITTED_WHITE_MIX } from '../committedShade';

const lum = (hex: string) => {
  const lin = (i: number) => { const c = parseInt(hex.slice(1 + i, 3 + i), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
};

describe('committedFill', () => {
  it('HIGH is the party colour itself', () => {
    expect(committedFill('#1F5FBF', 'HIGH').toLowerCase()).toBe('#1f5fbf');
    expect(committedFill('#abc', 'HIGH')).toBe('#aabbcc');
  });
  it('MEDIUM is lighter than HIGH and LOW lighter than MEDIUM', () => {
    const [h, m, l] = (['HIGH', 'MEDIUM', 'LOW'] as const).map(v => lum(committedFill('#E8710A', v)));
    expect(m).toBeGreaterThan(h);
    expect(l).toBeGreaterThan(m);
  });
  it('always returns #rrggbb, and white mixes are ordered', () => {
    for (const v of ['HIGH', 'MEDIUM', 'LOW'] as const) expect(committedFill('#0a0b0c', v)).toMatch(/^#[0-9a-f]{6}$/);
    expect(COMMITTED_WHITE_MIX.HIGH).toBe(0);
    expect(COMMITTED_WHITE_MIX.MEDIUM).toBeLessThan(COMMITTED_WHITE_MIX.LOW);
  });
});

describe('committedFills', () => {
  it('maps each committed seat to its shade', () => {
    const f = committedFills([{ seat: 3, band: 5, percent: 50, level: 'HIGH' }, { seat: 9, band: 1, percent: 10, level: 'LOW' }], '#1F5FBF');
    expect(Object.keys(f).sort()).toEqual(['3', '9']);
    expect(f[3]).toBe(committedFill('#1F5FBF', 'HIGH'));
    expect(f[9]).toBe(committedFill('#1F5FBF', 'LOW'));
  });
  it('is empty for undefined', () => { expect(committedFills(undefined, '#fff')).toEqual({}); });
});
