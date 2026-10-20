import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG, configForMap, validateConfig } from '../src';

const gameDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const propsFile = path.join(gameDir, 'config/game.properties');
const propsText = fs.readFileSync(propsFile, 'utf8');
const props = new Map<string, string>();
for (const line of propsText.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  props.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
}
const n = (k: string) => Number((props.get(k) ?? 'NaN').replace(/_/g, ''));

describe('game.properties is the source of the game constants', () => {
  it('WORLD_CONFIG carries exactly the values in the properties file', () => {
    expect(WORLD_CONFIG.budget).toBe(n('budget'));
    expect(WORLD_CONFIG.costs).toEqual({ rally: n('costs.rally'), roadshow: n('costs.roadshow') });
    expect(WORLD_CONFIG.analyst.seatReport).toEqual({ start: n('analyst.seatReport.start'), end: n('analyst.seatReport.end') });
    expect(WORLD_CONFIG.analyst.globalReport).toEqual({ start: n('analyst.globalReport.start'), end: n('analyst.globalReport.end') });
    expect(WORLD_CONFIG.effects.rally.local).toBe(n('effects.rally.local'));
    expect(WORLD_CONFIG.effects.rally.global).toBe(n('effects.rally.global'));
    expect(WORLD_CONFIG.effects.roadshow.decay.maxKm).toBe(n('effects.roadshow.decay.maxKm'));
    expect(WORLD_CONFIG.effects.firstMover).toEqual({ rally: n('effects.firstMover.rally'), roadshow: n('effects.firstMover.roadshow') });
    expect(WORLD_CONFIG.timeMultiplier).toEqual({ start: n('timeMultiplier.start'), end: n('timeMultiplier.end') });
    expect(WORLD_CONFIG.durations.campaignMs).toBe(n('durations.campaignMs'));
    expect(WORLD_CONFIG.points.seatMultiplier).toBe(n('points.seatMultiplier'));
    expect(WORLD_CONFIG.points.portfolios.map((p) => p.id)).toEqual(
      [...props.keys()].filter((k) => /^points\.portfolios\.\d+\.id$/.test(k)).map((k) => props.get(k)));
    expect(WORLD_CONFIG.currency).toEqual({ name: props.get('currency.name'), symbol: props.get('currency.symbol') });
  });

  it('the agreed values (50,000 budget, round costs, first-mover bonus on)', () => {
    expect(WORLD_CONFIG.budget).toBe(50_000);
    expect(WORLD_CONFIG.costs).toEqual({ rally: 2_000, roadshow: 400 });
    expect(WORLD_CONFIG.analyst.seatReport).toEqual({ start: 800, end: 1_800 });
    expect(WORLD_CONFIG.analyst.globalReport).toEqual({ start: 2_800, end: 6_200 });
    expect(WORLD_CONFIG.effects.firstMover.rally).toBeGreaterThan(0);
    expect(WORLD_CONFIG.effects.firstMover.roadshow).toBeGreaterThan(0);
  });

  it('every map without its own entry shares the file values', () => {
    const c = configForMap('some-new-map', 123);
    expect(c.mapId).toBe('some-new-map');
    expect(c.seatCount).toBe(123);
    expect(c.budget).toBe(WORLD_CONFIG.budget);
    expect(c.effects.firstMover).toEqual(WORLD_CONFIG.effects.firstMover);
  });

  it('the committed generated file is up to date with the properties file', () => {
    expect(() => execFileSync('npx', ['tsx', 'scripts/gen-config.ts', '--check'], { cwd: gameDir, shell: true, stdio: 'pipe' })).not.toThrow();
  }, 30_000);
});

describe('gen-config rejects a bad properties file', () => {
  const run = (text: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-config-'));
    const f = path.join(dir, 'bad.properties');
    fs.writeFileSync(f, text);
    try {
      execFileSync('npx', ['tsx', 'scripts/gen-config.ts', '--dry', `--file=${f}`], { cwd: gameDir, shell: true, stdio: 'pipe' });
      return { ok: true, err: '' };
    } catch (e) {
      return { ok: false, err: String((e as { stderr?: Buffer }).stderr ?? e) };
    }
  };
  it('accepts the real file', () => { expect(run(propsText).ok).toBe(true); }, 30_000);
  it('rejects a non-numeric value', () => {
    const r = run(propsText.replace(/^budget=.*$/m, 'budget=lots'));
    expect(r.ok).toBe(false);
    expect(r.err).toContain('budget');
  }, 30_000);
  it('rejects a missing key', () => {
    const r = run(propsText.replace(/^costs\.rally=.*$/m, ''));
    expect(r.ok).toBe(false);
    expect(r.err).toContain('costs.rally');
  }, 30_000);
  it('rejects an unknown (typo) key', () => {
    const r = run(propsText + '\nbudgett=5\n');
    expect(r.ok).toBe(false);
    expect(r.err).toContain('budgett');
  }, 30_000);
  it('rejects a negative first-mover bonus', () => {
    const r = run(propsText.replace(/^effects\.firstMover\.rally=.*$/m, 'effects.firstMover.rally=-1'));
    expect(r.ok).toBe(false);
  }, 30_000);
});

describe('validateConfig', () => {
  it('accepts WORLD_CONFIG', () => { expect(() => validateConfig(WORLD_CONFIG)).not.toThrow(); });
  it('rejects NaN, negative and missing numbers', () => {
    expect(() => validateConfig({ ...WORLD_CONFIG, budget: NaN })).toThrow(/budget/);
    expect(() => validateConfig({ ...WORLD_CONFIG, costs: { rally: -1, roadshow: 1 } })).toThrow(/costs.rally/);
    expect(() => validateConfig({ ...WORLD_CONFIG, effects: { ...WORLD_CONFIG.effects, firstMover: { rally: 0 } } } as never)).toThrow(/firstMover/);
  });
});
