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
    expect(WORLD_CONFIG.effects.distanceUnitKm).toBe(n('effects.distanceUnitKm'));
    expect(WORLD_CONFIG.effects.rally.decay).toEqual({ spread: n('effects.rally.decay.spread'), maxKm: n('effects.rally.decay.maxKm') });
    expect(WORLD_CONFIG.effects.roadshow.local).toBe(n('effects.roadshow.local'));
    expect(WORLD_CONFIG.effects.roadshow.decay).toEqual({ spread: n('effects.roadshow.decay.spread'), maxKm: n('effects.roadshow.decay.maxKm') });
    expect(WORLD_CONFIG.cooldowns).toEqual({ rallyMs: n('cooldowns.rallyMs') });
    expect(WORLD_CONFIG.display.reputationScale).toBe(n('display.reputationScale'));
    expect(WORLD_CONFIG.effects.firstMover).toEqual({ rally: n('effects.firstMover.rally'), roadshow: n('effects.firstMover.roadshow') });
    expect(WORLD_CONFIG.timeMultiplier).toEqual({ start: n('timeMultiplier.start'), end: n('timeMultiplier.end') });
    expect(WORLD_CONFIG.durations.campaignMs).toBe(n('durations.campaignMs'));
    expect(WORLD_CONFIG.points.seatMultiplier).toBe(n('points.seatMultiplier'));
    expect(WORLD_CONFIG.connection).toEqual({ retryMs: n('connection.retryMs') });
    expect(WORLD_CONFIG.points.portfolios.map((p) => p.id)).toEqual(
      [...props.keys()].filter((k) => /^points\.portfolios\.\d+\.id$/.test(k)).map((k) => props.get(k)));
    expect(WORLD_CONFIG.currency).toEqual({ name: props.get('currency.name'), symbol: props.get('currency.symbol') });
  });

  it('the agreed values (60,000 budget, round costs, first-mover bonus on)', () => {
    expect(WORLD_CONFIG.budget).toBe(60_000);
    expect(WORLD_CONFIG.costs).toEqual({ rally: 8_000, roadshow: 400 });
    expect(WORLD_CONFIG.analyst.seatReport).toEqual({ start: 800, end: 1_800 });
    expect(WORLD_CONFIG.analyst.globalReport).toEqual({ start: 2_800, end: 6_200 });
    expect(WORLD_CONFIG.effects.firstMover.rally).toBeGreaterThan(0);
    expect(WORLD_CONFIG.effects.firstMover.roadshow).toBeGreaterThan(0);
  });

  it('the agreed Gaussian spread: rally 0.25 + 10 e^(-0.5 x^2) to 400 km, roadshow purely local (6.25, no spill-over), x in units of 100 km', () => {
    const e = WORLD_CONFIG.effects;
    expect(e.distanceUnitKm).toBe(100);
    expect(e.rally.global).toBe(0.25);
    expect(e.rally.local).toBe(10);
    expect(e.rally.decay).toEqual({ spread: 0.5, maxKm: 400 });
    expect(e.roadshow.local).toBe(6.25); // x display scale 4 = 25 shown
    expect(e.roadshow.decay.maxKm).toBe(0); // no spill-over into other seats
  });

  it('rallies are rate limited to one per 15 s per player (roadshows are not) and the own reputation is shown x4', () => {
    expect(WORLD_CONFIG.cooldowns.rallyMs).toBe(15_000);
    expect(WORLD_CONFIG.display.reputationScale).toBe(4);
    expect(Object.keys(WORLD_CONFIG.cooldowns)).toEqual(['rallyMs']); // no roadshow cooldown
  });

  it('the old exponential-decay keys (halfDistanceKm, capRatio) are gone from the file and from the config', () => {
    expect(propsText).not.toMatch(/^\s*effects\.\w+\.decay\.(halfDistanceKm|capRatio)\s*=/m);
    for (const d of [WORLD_CONFIG.effects.rally.decay, WORLD_CONFIG.effects.roadshow.decay]) {
      expect(Object.keys(d).sort()).toEqual(['maxKm', 'spread']);
    }
  });

  it('browsers retry a lost connection every 5 s by default', () => {
    expect(WORLD_CONFIG.connection.retryMs).toBe(5_000);
  });

  it('counting display tunables (pie chart refresh, result panel timings and trailing mix) come from the file', () => {
    const c = WORLD_CONFIG.counting;
    expect(c.pieRefreshMs).toBe(n('counting.pieRefreshMs'));
    expect(c.panelDisplayMs).toBe(n('counting.panelDisplayMs'));
    expect(c.panelStaggerMs).toBe(n('counting.panelStaggerMs'));
    expect(c.panelRunnerUpPercent).toBe(n('counting.panelRunnerUpPercent'));
    expect(c.panelOtherPercent).toBe(n('counting.panelOtherPercent'));
  });

  it('the agreed display values: pie every 1 s, each result panel 5 s, 0.5 s stagger, runner-up 75% / other 25%', () => {
    const c = WORLD_CONFIG.counting;
    expect([c.pieRefreshMs, c.panelDisplayMs, c.panelStaggerMs]).toEqual([1_000, 5_000, 500]);
    expect([c.panelRunnerUpPercent, c.panelOtherPercent]).toEqual([75, 25]);
  });

  it('messaging is one group chat everybody can read by default (the flag allows private threads)', () => {
    expect(WORLD_CONFIG.messaging).toEqual({ mode: props.get('messaging.mode'), opensAt: props.get('messaging.opensAt') });
    expect(WORLD_CONFIG.messaging.mode).toBe('group');
  });

  it('chat opens at the start of the campaign by default (the flag allows counting start)', () => {
    expect(WORLD_CONFIG.messaging.opensAt).toBe('campaign');
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
  it('rejects a connection retry interval under one second (it would hammer the server)', () => {
    const r = run(propsText.replace(/^connection\.retryMs=.*$/m, 'connection.retryMs=500'));
    expect(r.ok).toBe(false);
    expect(r.err).toContain('connection.retryMs');
  }, 30_000);
  it('rejects a missing connection.retryMs', () => {
    const r = run(propsText.replace(/^connection\.retryMs=.*$/m, ''));
    expect(r.ok).toBe(false);
    expect(r.err).toContain('connection.retryMs');
  }, 30_000);
  it.each([
    ['a pie refresh under 250 ms', /^counting\.pieRefreshMs=.*$/m, 'counting.pieRefreshMs=100', 'counting.pieRefreshMs'],
    ['a zero panel display time', /^counting\.panelDisplayMs=.*$/m, 'counting.panelDisplayMs=0', 'counting.panelDisplayMs'],
    ['a stagger that is not shorter than the display time', /^counting\.panelStaggerMs=.*$/m, 'counting.panelStaggerMs=5_000','counting.panelStaggerMs'],
    ['a negative stagger', /^counting\.panelStaggerMs=.*$/m, 'counting.panelStaggerMs=-1', 'counting.panelStaggerMs'],
    ['runner-up / other percentages that do not add up to 100', /^counting\.panelOtherPercent=.*$/m, 'counting.panelOtherPercent=30', 'counting.panelOtherPercent'],
    ['a percentage over 100', /^counting\.panelRunnerUpPercent=.*$/m, 'counting.panelRunnerUpPercent=150', 'counting.panelRunnerUpPercent'],
  ])('rejects %s', (_label, re, line, key) => {
    const r = run(propsText.replace(re, line));
    expect(r.ok).toBe(false);
    expect(r.err).toContain(key);
  }, 30_000);
  it.each(['pieRefreshMs', 'panelDisplayMs', 'panelStaggerMs', 'panelRunnerUpPercent', 'panelOtherPercent'])('rejects a missing counting.%s', (k) => {
    const r = run(propsText.replace(new RegExp(`^counting\\.${k}=.*$`, 'm'), ''));
    expect(r.ok).toBe(false);
    expect(r.err).toContain(`counting.${k}`);
  }, 30_000);
  it.each(['group', 'individual'])('accepts messaging.mode=%s', (mode) => {
    expect(run(propsText.replace(/^messaging\.mode=.*$/m, `messaging.mode=${mode}`)).ok).toBe(true);
  }, 30_000);
  it.each(['threads', 'GROUP', ''])('rejects messaging.mode=%j', (mode) => {
    const r = run(propsText.replace(/^messaging\.mode=.*$/m, `messaging.mode=${mode}`));
    expect(r.ok).toBe(false);
    expect(r.err).toContain('messaging.mode');
  }, 30_000);
  it.each(['campaign', 'counting'])('accepts messaging.opensAt=%s', (v) => {
    expect(run(propsText.replace(/^messaging\.opensAt=.*$/m, `messaging.opensAt=${v}`)).ok).toBe(true);
  }, 30_000);
  it.each(['lobby', 'CAMPAIGN', ''])('rejects messaging.opensAt=%j', (v) => {
    const r = run(propsText.replace(/^messaging\.opensAt=.*$/m, `messaging.opensAt=${v}`));
    expect(r.ok).toBe(false);
    expect(r.err).toContain('messaging.opensAt');
  }, 30_000);
  it('rejects a missing messaging.opensAt', () => {
    const r = run(propsText.replace(/^messaging\.opensAt=.*$/m, ''));
    expect(r.ok).toBe(false);
    expect(r.err).toContain('messaging.opensAt');
  }, 30_000);
  it('rejects a missing messaging.mode', () => {
    const r = run(propsText.replace(/^messaging\.mode=.*$/m, ''));
    expect(r.ok).toBe(false);
    expect(r.err).toContain('messaging.mode');
  }, 30_000);
  it.each([
    ['a zero rally spread', /^effects\.rally\.decay\.spread=.*$/m, 'effects.rally.decay.spread=0', 'effects.rally.decay.spread'],
    ['a negative roadshow spread', /^effects\.roadshow\.decay\.spread=.*$/m, 'effects.roadshow.decay.spread=-1', 'effects.roadshow.decay.spread'],
    ['a negative rally cutoff distance', /^effects\.rally\.decay\.maxKm=.*$/m, 'effects.rally.decay.maxKm=-5', 'effects.rally.decay.maxKm'],
    ['a zero distance unit', /^effects\.distanceUnitKm=.*$/m, 'effects.distanceUnitKm=0', 'effects.distanceUnitKm'],
    ['a zero rally local effect', /^effects\.rally\.local=.*$/m, 'effects.rally.local=0', 'effects.rally.local'],
    ['a zero roadshow local effect', /^effects\.roadshow\.local=.*$/m, 'effects.roadshow.local=0', 'effects.roadshow.local'],
    ['a negative rally cooldown', /^cooldowns\.rallyMs=.*$/m, 'cooldowns.rallyMs=-1', 'cooldowns.rallyMs'],
  ])('rejects %s', (_label, re, line, key) => {
    const r = run(propsText.replace(re, line));
    expect(r.ok).toBe(false);
    expect(r.err).toContain(key);
  }, 30_000);
  it('accepts a zero rally cooldown (cooldown switched off)', () => {
    expect(run(propsText.replace(/^cooldowns\.rallyMs=.*$/m, 'cooldowns.rallyMs=0')).ok).toBe(true);
  }, 30_000);
  it.each(['effects.distanceUnitKm', 'effects.rally.decay.spread', 'effects.roadshow.decay.spread', 'cooldowns.rallyMs'])('rejects a missing %s', (k) => {
    const r = run(propsText.replace(new RegExp(`^${k.replace(/\./g, '\.')}=.*$`, 'm'), ''));
    expect(r.ok).toBe(false);
    expect(r.err).toContain(k);
  }, 30_000);
  it.each(['effects.rally.decay.halfDistanceKm', 'effects.roadshow.decay.capRatio'])('rejects the removed key %s as unknown', (k) => {
    const r = run(propsText + `
${k}=1
`);
    expect(r.ok).toBe(false);
    expect(r.err).toContain(k);
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
    expect(() => validateConfig({ ...WORLD_CONFIG, connection: { retryMs: 200 } })).toThrow(/connection.retryMs/);
    expect(() => validateConfig({ ...WORLD_CONFIG, costs: { rally: -1, roadshow: 1 } })).toThrow(/costs.rally/);
    expect(() => validateConfig({ ...WORLD_CONFIG, messaging: { ...WORLD_CONFIG.messaging, mode: 'threads' } } as never)).toThrow(/messaging.mode/);
    expect(() => validateConfig({ ...WORLD_CONFIG, messaging: { ...WORLD_CONFIG.messaging, opensAt: 'lobby' } } as never)).toThrow(/messaging.opensAt/);
    const counting = (over: object) => ({ ...WORLD_CONFIG, counting: { ...WORLD_CONFIG.counting, ...over } });
    expect(() => validateConfig(counting({ pieRefreshMs: 100 }))).toThrow(/counting.pieRefreshMs/);
    expect(() => validateConfig(counting({ panelDisplayMs: 0 }))).toThrow(/counting.panelDisplayMs/);
    expect(() => validateConfig(counting({ panelStaggerMs: -5 }))).toThrow(/counting.panelStaggerMs/);
    expect(() => validateConfig(counting({ panelStaggerMs: 5_000 }))).toThrow(/counting.panelStaggerMs/);
    expect(() => validateConfig(counting({ panelRunnerUpPercent: 60, panelOtherPercent: 60 }))).toThrow(/counting.panelOtherPercent/);
    expect(() => validateConfig(counting({ panelRunnerUpPercent: undefined }))).toThrow(/counting.panelRunnerUpPercent/);
    expect(() => validateConfig({ ...WORLD_CONFIG, effects: { ...WORLD_CONFIG.effects, firstMover: { rally: 0 } } } as never)).toThrow(/firstMover/);
    const eff = (over: object) => ({ ...WORLD_CONFIG, effects: { ...WORLD_CONFIG.effects, ...over } });
    const E = WORLD_CONFIG.effects;
    expect(() => validateConfig(eff({ distanceUnitKm: 0 }))).toThrow(/effects.distanceUnitKm/);
    expect(() => validateConfig(eff({ rally: { ...E.rally, decay: { ...E.rally.decay, spread: 0 } } }))).toThrow(/effects.rally.decay.spread/);
    expect(() => validateConfig(eff({ roadshow: { ...E.roadshow, decay: { ...E.roadshow.decay, spread: -2 } } }))).toThrow(/effects.roadshow.decay.spread/);
    expect(() => validateConfig(eff({ roadshow: { ...E.roadshow, decay: { ...E.roadshow.decay, maxKm: -1 } } }))).toThrow(/effects.roadshow.decay.maxKm/);
    expect(() => validateConfig(eff({ rally: { ...E.rally, decay: { maxKm: 400 } } }))).toThrow(/effects.rally.decay.spread/);
    expect(() => validateConfig({ ...WORLD_CONFIG, cooldowns: { rallyMs: -1 } })).toThrow(/cooldowns.rallyMs/);
    expect(() => validateConfig({ ...WORLD_CONFIG, cooldowns: undefined } as never)).toThrow(/cooldowns.rallyMs/);
    expect(() => validateConfig({ ...WORLD_CONFIG, cooldowns: { rallyMs: 0 } })).not.toThrow();
  });
});
