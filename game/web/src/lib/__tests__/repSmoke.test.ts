import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG } from '@hp/shared';
import type { GameMapPackage } from '@hp/shared';
import { selectSmoke } from '../repSmoke';

const cfg = WORLD_CONFIG;
const G = Math.round(cfg.effects.rally.global * cfg.display.reputationScale);
// three seats: 1 and 2 close together (Delhi/Jaipur-ish), 3 on the other side of the world
const pkg = { seats: [
  { id: 1, x: 0, y: 0, lon: 77, lat: 28, neighbours: [] },
  { id: 2, x: 0, y: 0, lon: 76, lat: 27, neighbours: [] },
  { id: 3, x: 0, y: 0, lon: -120, lat: -30, neighbours: [] },
] } as unknown as GameMapPackage;

describe('selectSmoke', () => {
  it('roadshow: every positive seat gets smoke, no global label', () => {
    const r = selectSmoke({ key: 1, type: 'roadshow', seat: 1, seats: { 1: 6, 2: 0, 3: -1 } }, pkg, cfg);
    expect(r.seats).toEqual({ 1: 6 });
    expect(r.globalText).toBeUndefined();
  });
  it('rally: Gaussian seats individual, far seats folded into the "Every other seat" label', () => {
    const r = selectSmoke({ key: 2, type: 'rally', seat: 1, seats: { 1: 20, 2: 9, 3: G } }, pkg, cfg);
    expect(r.seats[1]).toBe(20);
    expect(r.seats[2]).toBe(9);
    expect(r.seats[3]).toBeUndefined();
    expect(r.globalText).toBe(`Every other seat +${G}`);
  });
  it('rally without a map package: only gains above G are individual', () => {
    const r = selectSmoke({ key: 3, type: 'rally', seat: 1, seats: { 1: 20, 2: G, 3: G } }, null, cfg);
    expect(r.seats).toEqual({ 1: 20 });
  });
  it('no label when the global part rounds to 0', () => {
    const c = { ...cfg, effects: { ...cfg.effects, rally: { ...cfg.effects.rally, global: 0 } } };
    expect(selectSmoke({ key: 4, type: 'rally', seat: 1, seats: { 1: 20 } }, null, c).globalText).toBeUndefined();
  });
});
