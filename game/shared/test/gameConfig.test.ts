import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG, chatModeFor, configForMap, validateConfig } from '../src';

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
const b = (k: string) => props.get(k) === 'true';

describe('game.properties is the source of the game constants', () => {
  it('WORLD_CONFIG carries exactly the values in the properties file', () => {
    expect(WORLD_CONFIG.budget).toBe(n('budget'));
    expect(WORLD_CONFIG.costs).toEqual({ rally: n('costs.rally'), roadshow: n('costs.roadshow') });
    expect(WORLD_CONFIG.analyst.seatReport).toEqual({ start: n('analyst.seatReport.start'), end: n('analyst.seatReport.end'), enabled: b('analyst.seatReport.enabled') });
    expect(WORLD_CONFIG.analyst.globalReport).toEqual({ start: n('analyst.globalReport.start'), end: n('analyst.globalReport.end'), enabled: b('analyst.globalReport.enabled') });
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
    expect(WORLD_CONFIG.analyst.seatReport).toEqual({ start: 800, end: 1_800, enabled: false });
    expect(WORLD_CONFIG.analyst.globalReport).toEqual({ start: 2_800, end: 6_200, enabled: false });
    expect(WORLD_CONFIG.effects.firstMover.rally).toBeGreaterThan(0);
    expect(WORLD_CONFIG.effects.firstMover.roadshow).toBeGreaterThan(0);
  });

  it('the agreed Gaussian spread: rally 0.25 + 10 e^(-0.1 x^2) to 700 km, roadshow purely local (6.25, no spill-over), x in units of 100 km', () => {
    const e = WORLD_CONFIG.effects;
    expect(e.distanceUnitKm).toBe(100);
    expect(e.rally.global).toBe(0.25);
    expect(e.rally.local).toBe(10);
    expect(e.rally.decay).toEqual({ spread: 0.1, maxKm: 700 });
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

  it('chat: one group chat during the campaign, one-to-one chats during counting and post-counting (the designer keys)', () => {
    expect(WORLD_CONFIG.chat).toEqual({ campaigning: props.get('Chat.Campaigning') });
    expect(WORLD_CONFIG.chat).toEqual({ campaigning: 'GROUP' });
  });

  it('chatModeFor: campaign -> Chat.Campaigning (OFF = null), counting / postCounting -> always INDV, other stages none', () => {
    const cfg = (campaigning: string) => ({ chat: { campaigning } } as never);
    expect(chatModeFor(cfg('GROUP'), 'campaign')).toBe('GROUP');
    expect(chatModeFor(cfg('INDV'), 'campaign')).toBe('INDV');
    expect(chatModeFor(cfg('OFF'), 'campaign')).toBeNull();
    for (const c of ['GROUP', 'INDV', 'OFF']) {
      expect(chatModeFor(cfg(c), 'counting')).toBe('INDV');
      expect(chatModeFor(cfg(c), 'postCounting')).toBe('INDV');
    }
    for (const st of ['lobby', 'finished', 'abandoned', undefined]) expect(chatModeFor(cfg('GROUP'), st)).toBeNull();
  });

  it('news agency tunables come from the file (agencies numbered 1..n become a list)', () => {
    const c = WORLD_CONFIG.news;
    expect(c.enabled).toBe(b('news.enabled'));
    expect(c.agencies.map((a) => a.name)).toEqual(
      [...props.keys()].filter((k) => /^news\.agency\d+\.name$/.test(k)).map((k) => props.get(k)));
    for (const k of ['sampleIntervalMs', 'errorStartMinPct', 'errorStartMaxPct', 'errorEndFraction', 'errorDecayRate', 'errorNoise', 'noiseSmoothing', 'errorWobbleMin', 'errorWobbleMax', 'maxPoints'] as const) {
      expect(c[k]).toBe(n(`news.${k}`));
    }
    expect(c.agencies.map((a) => a.name)).toEqual(['Kal Tak', 'Toofan Express', 'Woof News', 'World Today']);
    expect([c.sampleIntervalMs, c.errorStartMinPct, c.errorStartMaxPct]).toEqual([30_000, 20, 40]);
    expect(typeof c.enabled).toBe('boolean');
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
  it.each(['seatReport', 'globalReport'])('accepts analyst.%s.enabled=true and =false and emits real booleans', (k) => {
    for (const v of ['true', 'false']) {
      expect(run(propsText.replace(new RegExp(`^analyst\.${k}\.enabled=.*$`, 'm'), `analyst.${k}.enabled=${v}`)).ok).toBe(true);
    }
    expect(typeof WORLD_CONFIG.analyst[k as 'seatReport' | 'globalReport'].enabled).toBe('boolean');
  }, 60_000);
  it.each(['seatReport', 'globalReport'])('rejects analyst.%s.enabled=yes (only true / false)', (k) => {
    const r = run(propsText.replace(new RegExp(`^analyst\.${k}\.enabled=.*$`, 'm'), `analyst.${k}.enabled=yes`));
    expect(r.ok).toBe(false);
    expect(r.err).toContain(`analyst.${k}.enabled`);
  }, 30_000);
  it.each(['seatReport', 'globalReport'])('rejects a missing analyst.%s.enabled', (k) => {
    const r = run(propsText.replace(new RegExp(`^analyst\.${k}\.enabled=.*$`, 'm'), ''));
    expect(r.ok).toBe(false);
    expect(r.err).toContain(`analyst.${k}.enabled`);
  }, 30_000);
  it('validateConfig rejects a non-boolean enabled flag', () => {
    const bad = { ...WORLD_CONFIG, analyst: { ...WORLD_CONFIG.analyst, seatReport: { ...WORLD_CONFIG.analyst.seatReport, enabled: 'yes' as unknown as boolean } } };
    expect(() => validateConfig(bad)).toThrow(/analyst\.seatReport\.enabled/);
  });
  it.each(['true', 'false'])('accepts news.enabled=%s', (v) => {
    expect(run(propsText.replace(/^news\.enabled=.*$/m, `news.enabled=${v}`)).ok).toBe(true);
  }, 30_000);
  it.each([
    ['news.enabled=yes (only true / false)', /^news\.enabled=.*$/m, 'news.enabled=yes', 'news.enabled'],
    ['a start error min above the max', /^news\.errorStartMinPct=.*$/m, 'news.errorStartMinPct=50', 'news.errorStartMinPct'],
    ['a zero start error min', /^news\.errorStartMinPct=.*$/m, 'news.errorStartMinPct=0', 'news.errorStartMinPct'],
    ['a start error max over 100', /^news\.errorStartMaxPct=.*$/m, 'news.errorStartMaxPct=150', 'news.errorStartMinPct'],
    ['an end fraction over 1', /^news\.errorEndFraction=.*$/m, 'news.errorEndFraction=1.5', 'news.errorEndFraction'],
    ['a negative end fraction', /^news\.errorEndFraction=.*$/m, 'news.errorEndFraction=-0.1', 'news.errorEndFraction'],
    ['a negative decay rate', /^news\.errorDecayRate=.*$/m, 'news.errorDecayRate=-1', 'news.errorDecayRate'],
    ['a noise over 1', /^news\.errorNoise=.*$/m, 'news.errorNoise=2', 'news.errorNoise'],
    ['a smoothing of 1', /^news\.noiseSmoothing=.*$/m, 'news.noiseSmoothing=1', 'news.noiseSmoothing'],
    ['a sample interval under one second', /^news\.sampleIntervalMs=.*$/m, 'news.sampleIntervalMs=500', 'news.sampleIntervalMs'],
    ['a wobble min above 1', /^news\.errorWobbleMin=.*$/m, 'news.errorWobbleMin=1.2', 'news.errorWobbleMin'],
    ['a negative wobble min', /^news\.errorWobbleMin=.*$/m, 'news.errorWobbleMin=-0.1', 'news.errorWobbleMin'],
    ['a wobble max below 1', /^news\.errorWobbleMax=.*$/m, 'news.errorWobbleMax=0.8', 'news.errorWobbleMax'],
    ['fewer than 2 points', /^news\.maxPoints=.*$/m, 'news.maxPoints=1', 'news.maxPoints'],
    ['two agencies with the same name', /^news\.agency2\.name=.*$/m, 'news.agency2.name=kal tak', 'news agency names'],
    ['a gap in the agency numbering', /^news\.agency4\.name=.*$/m, 'news.agency6.name=World Today', 'news agencies must be numbered'],
  ])('rejects %s', (_label, re, line, key) => {
    const r = run(propsText.replace(re, line));
    expect(r.ok).toBe(false);
    expect(r.err).toContain(key);
  }, 30_000);
  it.each(['sampleIntervalMs', 'errorStartMinPct', 'errorStartMaxPct', 'errorEndFraction', 'errorDecayRate', 'errorNoise', 'noiseSmoothing', 'errorWobbleMin', 'errorWobbleMax', 'maxPoints', 'enabled'])('rejects a missing news.%s', (k) => {
    const r = run(propsText.replace(new RegExp(`^news\.${k}=.*$`, 'm'), ''));
    expect(r.ok).toBe(false);
    expect(r.err).toContain(`news.${k}`);
  }, 30_000);
  it('rejects a file without any news agency', () => {
    const r = run(propsText.replace(/^news\.agency\d+\.name=.*$/gm, ''));
    expect(r.ok).toBe(false);
    expect(r.err).toContain('no news agencies');
  }, 30_000);
  it('validateConfig reports a config error (not a TypeError) when the news section is missing', () => {
    const { news: _news, ...rest } = WORLD_CONFIG;
    let err: unknown;
    try { validateConfig(rest as unknown as typeof WORLD_CONFIG); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/game config: news/);
  });
  it('validateConfig rejects bad news values at run time', () => {
    const w = (news: Partial<typeof WORLD_CONFIG.news>) => ({ ...WORLD_CONFIG, news: { ...WORLD_CONFIG.news, ...news } });
    expect(() => validateConfig(w({ enabled: 'yes' as unknown as boolean }))).toThrow(/news\.enabled/);
    expect(() => validateConfig(w({ agencies: [] }))).toThrow(/news\.agencies/);
    expect(() => validateConfig(w({ agencies: [{ name: 'A' }, { name: 'a' }] }))).toThrow(/news\.agencies/);
    expect(() => validateConfig(w({ errorStartMinPct: 50, errorStartMaxPct: 40 }))).toThrow(/news\.errorStartMinPct/);
    expect(() => validateConfig(w({ errorEndFraction: 2 }))).toThrow(/news\.errorEndFraction/);
    expect(() => validateConfig(w({ noiseSmoothing: 1 }))).toThrow(/news\.noiseSmoothing/);
    expect(() => validateConfig(w({ maxPoints: 2.5 }))).toThrow(/news\.maxPoints/);
    expect(() => validateConfig(w({ maxPoints: 1 }))).toThrow(/news\.maxPoints/);
    expect(() => validateConfig(w({ errorWobbleMin: 1.1 }))).toThrow(/news\.errorWobbleMin/);
    expect(() => validateConfig(w({ errorWobbleMax: 0.9 }))).toThrow(/news\.errorWobbleMax/);
    expect(() => validateConfig(w({ sampleIntervalMs: 0 }))).toThrow(/news\.sampleIntervalMs/);
    expect(() => validateConfig(w({}))).not.toThrow();
  });
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
  it.each(['GROUP', 'INDV', 'OFF'])('accepts Chat.Campaigning=%s', (v) => {
    expect(run(propsText.replace(/^Chat\.Campaigning=.*$/m, `Chat.Campaigning=${v}`)).ok).toBe(true);
  }, 30_000);
  it.each(['group', 'threads', ''])('rejects Chat.Campaigning=%j', (v) => {
    const r = run(propsText.replace(/^Chat\.Campaigning=.*$/m, `Chat.Campaigning=${v}`));
    expect(r.ok).toBe(false);
    expect(r.err).toContain('Chat.Campaigning');
  }, 30_000);
  it.each(['Chat.Campaigning'])('rejects a missing %s', (k) => {
    const r = run(propsText.replace(new RegExp(`^${k.replace(/\./g, '\.')}=.*$`, 'm'), ''));
    expect(r.ok).toBe(false);
    expect(r.err).toContain(k);
  }, 30_000);
  it.each(['messaging.mode', 'messaging.opensAt', 'Chat.post-campaigning'])('rejects the removed key %s as unknown', (k) => {
    const r = run(propsText + `
${k}=group
`);
    expect(r.ok).toBe(false);
    expect(r.err).toContain(k);
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
    expect(() => validateConfig({ ...WORLD_CONFIG, chat: { ...WORLD_CONFIG.chat, campaigning: 'group' } } as never)).toThrow(/Chat.Campaigning/);
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
