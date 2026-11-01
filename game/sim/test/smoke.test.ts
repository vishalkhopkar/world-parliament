// Simulator smoke tests: every strategy plays complete games on the real world map, the incremental state agrees with the
// engine, games are deterministic, and the CLI entry point runs. (The balance numbers themselves live in REPORT.md.)
// The sim models every seat as contested: each player starts the campaign on fullyFieldedBudget(cfg) (budget minus a candidate in every seat).
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG, fullyFieldedBudget, majorityOf, rallyAvailableAt } from '@hp/shared';
import type { MapConfig } from '@hp/shared';
import { DEFAULT_POOL, STRATEGIES } from '../src/bots';
import type { Bot } from '../src/bots';
import { TICK_MS, runGame } from '../src/game';
import { Agg, fieldTable, pad, padR, pct } from '../src/metrics';
import { buildWorld, loadMap } from '../src/world';

// campaign length pinned: bot-plan tests must not move when the shipped campaign length is tuned
const w = buildWorld(loadMap(), { ...WORLD_CONFIG, durations: { ...WORLD_CONFIG.durations, campaignMs: 600_000 } });
const START = fullyFieldedBudget(w.cfg);
const simDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(simDir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

describe('world', () => {
  it('is built from the real map: 500 seats, kernels, a sparse row per seat, every phase count', () => {
    expect(w.n).toBe(500);
    expect(w.rallyRows).toHaveLength(500);
    expect(w.roadRows).toHaveLength(500);
    for (const k of [1, 2, 3, 4, 5]) {
      expect(w.phaseOf.get(k)!.every((p) => p >= 0 && p < k)).toBe(true);
      expect(w.phaseSeats.get(k)!.flat()).toHaveLength(500);
    }
    expect(w.nearest(0, 5)).toHaveLength(5);
    for (const row of w.rallyRows) expect(row.idx.length).toBeGreaterThanOrEqual(1); // at least the seat itself
  });

  it('Gaussian kernels: sparse rows hold only seats inside the cutoff, never above the peak, and the global floor is not in the rows', () => {
    const { rally, roadshow, minorRally } = WORLD_CONFIG.effects;
    const n = w.n;
    expect(w.minorRows).toHaveLength(500);
    for (let i = 0; i < n; i++) {
      for (const [rows, p] of [[w.rallyRows, rally], [w.roadRows, roadshow], [w.minorRows, minorRally]] as const) {
        const row = rows[i];
        expect(Array.from(row.idx)).toContain(i);
        for (let q = 0; q < row.idx.length; q++) {
          expect(row.w[q]).toBeGreaterThan(0);
          expect(row.w[q]).toBeLessThanOrEqual(p.local + 1e-6);
          expect(w.kernels.distanceKm[i * n + row.idx[q]]).toBeLessThanOrEqual(p.decay.maxKm + 1e-3);
        }
      }
    }
    // roadshows reach far fewer seats than rallies
    const avg = (rows: { idx: Int32Array }[]) => rows.reduce((s, r) => s + r.idx.length, 0) / n;
    expect(avg(w.roadRows)).toBeLessThan(avg(w.rallyRows));
    expect(avg(w.roadRows)).toBeLessThan(3);
    // a minor rally reaches more seats than a roadshow and fewer than a major rally
    expect(avg(w.minorRows)).toBeGreaterThan(avg(w.roadRows));
    expect(avg(w.minorRows)).toBeLessThan(avg(w.rallyRows));
  });

  it('every player starts the campaign on fullyFieldedBudget: 85,000 - 500 x 50 = 60,000', () => {
    expect(START).toBe(60_000);
    const r = runGame(w, ['ROADSHOW', 'ROADSHOW'], 1, 'start-budget');
    for (const p of r.players) {
      expect(p.budgetLeft).toBeLessThanOrEqual(START);
      expect(p.roadshows * WORLD_CONFIG.costs.roadshow + p.budgetLeft).toBe(START); // not WORLD_CONFIG.budget
    }
  });
});

/** A test strategy: asks for a rally `perTick` times in EVERY tick (on its own fixed seats) and logs the accepted ones. */
function spammer(perTick: number, log: { at: number[]; refused: number }): () => Bot {
  return () => ({
    name: 'SPAM',
    tick(ctx) {
      for (let q = 0; q < perTick; q++) {
        const seat = (ctx.me * 7 + q) % ctx.w.n;
        if (!ctx.isOpen(seat)) continue;
        if (ctx.rally(seat)) log.at.push(ctx.now); else log.refused++;
      }
    },
  });
}

function withStrategy<T>(name: string, f: () => Bot, run: () => T): T {
  STRATEGIES[name] = f;
  try { return run(); } finally { delete STRATEGIES[name]; }
}

describe('rally cooldown (cooldowns.rallyMs)', () => {
  const gap = WORLD_CONFIG.cooldowns.rallyMs;
  const rich = (over: Partial<MapConfig> = {}): MapConfig => ({ ...JSON.parse(JSON.stringify(WORLD_CONFIG)), budget: 10_000_000, ...over });

  it('rallyAvailableAt is the shared rule the sim enforces: never rallied = always available, else last + gap', () => {
    expect(rallyAvailableAt(undefined, WORLD_CONFIG)).toBe(-Infinity);
    expect(rallyAvailableAt(1_000, WORLD_CONFIG)).toBe(1_000 + gap);
  });

  it('a bot that asks for a rally 3 times in every tick gets one per cooldown, never closer; refusals are counted as cooldown refusals (not frozen-seat ones)', () => {
    const wr = buildWorld(loadMap(), rich());
    const log = { at: [] as number[], refused: 0 };
    const r = withStrategy('SPAM', spammer(3, log), () => runGame(wr, ['SPAM', 'ROADSHOW'], 1, 'cool1'));
    const p = r.players[0];
    expect(log.at.length).toBe(p.rallies);
    expect(p.rallies).toBeGreaterThanOrEqual(19); // 600 s campaign / 30 s
    expect(p.rallies).toBeLessThanOrEqual(20);
    for (let i = 1; i < log.at.length; i++) expect(log.at[i] - log.at[i - 1]).toBeGreaterThanOrEqual(gap);
    expect(p.cooled).toBe(log.refused);
    expect(p.cooled).toBeGreaterThan(0);
    expect(p.rejected).toBe(0);
    expect(p.rallies * WORLD_CONFIG.costs.rally + p.budgetLeft).toBe(fullyFieldedBudget(wr.cfg));
  });

  it('the starting campaign budget buys only 7 rallies, so a 30 s gap never limits a bot that paces itself', () => {
    const log = { at: [] as number[], refused: 0 };
    const r = withStrategy('SPAM', spammer(1, log), () => runGame(w, ['SPAM', 'ROADSHOW'], 3, 'cool2'));
    expect(r.players[0].rallies).toBe(Math.floor(START / WORLD_CONFIG.costs.rally));
    expect(r.players[0].budgetLeft).toBeLessThan(WORLD_CONFIG.costs.rally);
    expect(r.players[0].rejected).toBe(0);
  });

  it('cooldown 0 switches the rule off: a burst of rallies in one tick is all accepted (until the money is gone)', () => {
    const w0 = buildWorld(loadMap(), rich({ cooldowns: { rallyMs: 0 } }));
    const log = { at: [] as number[], refused: 0 };
    const r = withStrategy('SPAM', spammer(5, log), () => runGame(w0, ['SPAM', 'ROADSHOW'], 1, 'cool0'));
    expect(r.players[0].cooled).toBe(0);
    expect(r.players[0].rallies).toBe(log.at.length);
    expect(log.at.filter((t) => t === 0).length).toBe(5);
  });

  it('roadshows have no cooldown: 20 roadshows in one tick are all accepted', () => {
    const done: number[] = [];
    const f = (): Bot => ({ name: 'RS', tick(ctx) { if (ctx.now === 0 && ctx.me === 0) for (let s = 0; s < 20; s++) if (ctx.roadshow(s)) done.push(s); } });
    const r = withStrategy('RS', f, () => runGame(w, ['RS', 'ROADSHOW'], 1, 'cool3'));
    expect(done).toHaveLength(20);
    expect(r.players[0].cooled).toBe(0);
  });

  it('a minor rally is not a rally: it has no cooldown, so 10 in one tick are all accepted and none counts as a cooldown refusal', () => {
    const done: number[] = [];
    const f = (): Bot => ({ name: 'MR', tick(ctx) { if (ctx.now === 0 && ctx.me === 0) for (let q = 0; q < 10; q++) if (ctx.minorRally(q)) done.push(q); } });
    const r = withStrategy('MR', f, () => runGame(w, ['MR', 'ROADSHOW'], 1, 'cool-minor'));
    expect(done).toHaveLength(10);
    expect(r.players[0].cooled).toBe(0);
    expect(r.players[0].minorRallies).toBe(10);
    expect(r.players[0].rallies).toBe(0);
  });

  it('ctx.rallyReady() is true at the start, false right after a rally, true again once the gap has passed (and a rally then works)', () => {
    const seen: { t: number; ready: boolean; ok?: boolean }[] = [];
    const f = (): Bot => ({
      name: 'PROBE',
      tick(ctx) {
        if (ctx.me !== 0) return;
        const ready = ctx.rallyReady();
        if (ctx.now === 0) { const ok = ctx.rally(1); seen.push({ t: ctx.now, ready, ok }); seen.push({ t: ctx.now, ready: ctx.rallyReady() }); }
        else if (ctx.now === TICK_MS) seen.push({ t: ctx.now, ready });
        else if (ctx.now >= gap && ready && !seen.some((x) => x.t >= gap)) seen.push({ t: ctx.now, ready, ok: ctx.rally(2) });
      },
    });
    withStrategy('PROBE', f, () => runGame(w, ['PROBE', 'ROADSHOW'], 1, 'probe'));
    expect(seen[0]).toEqual({ t: 0, ready: true, ok: true });
    expect(seen[1].ready).toBe(false);
    expect(seen[2].ready).toBe(false);
    expect(seen[3].t).toBeGreaterThanOrEqual(gap);
    expect(seen[3].t).toBeLessThanOrEqual(gap + TICK_MS);
    expect(seen[3].ok).toBe(true);
  });
});

describe('minor rally in the sim', () => {
  const cm = WORLD_CONFIG.costs.minorRally;

  it('costs costs.minorRally from the budget, is refused on a frozen seat (counted as rejected) and when the money is gone', () => {
    const seen: boolean[] = [];
    const seat = Array.from(w.phaseOf.get(3) as Int16Array).findIndex((ph) => ph === 0); // a seat of phase 0 of 3: frozen from 1/3 of the campaign on
    const f = (): Bot => ({
      name: 'MR',
      tick(ctx) {
        if (ctx.me !== 0) return;
        if (ctx.now === 0) seen.push(ctx.minorRally(seat)); // open seat
        if (ctx.now === Math.floor(ctx.campaignMs * 0.5)) seen.push(ctx.minorRally(seat));
      },
    });
    const r = withStrategy('MR', f, () => runGame(w, ['MR', 'ROADSHOW'], 3, 'minor-frozen'));
    expect(seen).toEqual([true, false]);
    expect(r.players[0].minorRallies).toBe(1);
    expect(r.players[0].rejected).toBe(1);
    expect(r.players[0].budgetLeft).toBe(START - cm);
  });

  it('a bot with no money left for a minor rally is refused without a charge', () => {
    const poor = buildWorld(loadMap(), { ...JSON.parse(JSON.stringify(WORLD_CONFIG)), budget: 25_000 + cm - 1, durations: WORLD_CONFIG.durations });
    const f = (): Bot => ({ name: 'MR', tick(ctx) { if (ctx.now === 0 && ctx.me === 0) ctx.minorRally(1); } });
    const r = withStrategy('MR', f, () => runGame(poor, ['MR', 'ROADSHOW'], 1, 'minor-poor'));
    expect(r.players[0].minorRallies).toBe(0);
    expect(r.players[0].budgetLeft).toBe(cm - 1);
  });

  it('the first mover bonus of the minor rally goes to the seat once, and the incremental state matches the engine', () => {
    const f = (): Bot => ({ name: 'MR', tick(ctx) { if (ctx.now === 0) { ctx.minorRally(ctx.me); ctx.minorRally(ctx.me === 0 ? 1 : 0); } } });
    const r = withStrategy('MR', f, () => runGame(w, ['MR', 'MR', 'ROADSHOW'], 2, 'minor-fm', { verify: true }));
    expect(r.verifyDiff).toBeLessThan(1e-9);
  });

  it.each(['MINOR100', 'MINOR50'])('%s spends only on candidates-free actions it can afford: rallies + roadshows + minor rallies + reports + what is left = the starting budget', (name) => {
    for (const k of [1, 3, 5]) {
      const r = runGame(w, [name, 'RALLY_EARLY', 'ROADSHOW'], k, `minor-bot:${name}:${k}`, { verify: true });
      expect(r.verifyDiff).toBeLessThan(1e-9);
      const p = r.players[0];
      expect(p.minorRallies).toBeGreaterThan(0);
      expect(p.rejected).toBe(0);
      expect(p.cooled).toBe(0);
      expect(p.rallies).toBe(0);
      expect(p.minorRallies * cm + p.roadshows * WORLD_CONFIG.costs.roadshow + p.reportSpend + p.budgetLeft).toBe(START);
    }
  });

  it('MINOR100 puts (nearly) the whole budget into minor rallies: floor(60,000 / 2,000) = 30', () => {
    const r = runGame(w, ['MINOR100', 'ROADSHOW'], 3, 'minor100');
    expect(r.players[0].minorRallies).toBe(Math.floor(START / cm));
    expect(r.players[0].roadshows).toBe(0);
  });
});

describe('strategies', () => {
  it('registry: every default-pool strategy exists and there are 24 strategies', () => {
    expect(Object.keys(STRATEGIES)).toHaveLength(24);
    for (const s of DEFAULT_POOL) expect(STRATEGIES[s]).toBeTypeOf('function');
  });

  it.each(Object.keys(STRATEGIES))('%s plays a 3-phase game against two opponents: no frozen-seat actions, budget never negative, effects match the engine', (name) => {
    const r = runGame(w, [name, 'RALLY', 'ROADSHOW'], 3, 'smoke:' + name, { verify: true });
    expect(r.verifyDiff).toBeLessThan(1e-9);
    expect(r.seatsDecided).toBe(500);
    for (const p of r.players) {
      expect(p.rejected, `${p.strategy} acted on a frozen seat`).toBe(0);
      expect(p.cooled, `${p.strategy} ran into the rally cooldown`).toBe(0);
      expect(p.budgetLeft).toBeGreaterThanOrEqual(0);
      expect(p.budgetLeft).toBeLessThanOrEqual(START);
      expect(p.rallies * WORLD_CONFIG.costs.rally + p.minorRallies * WORLD_CONFIG.costs.minorRally + p.roadshows * WORLD_CONFIG.costs.roadshow + p.reportSpend + p.budgetLeft).toBe(START);
      expect(p.seats).toBeGreaterThanOrEqual(0);
    }
    expect(r.players.reduce((s, p) => s + p.seats, 0)).toBeLessThanOrEqual(500);
  });

  it.each(['RALLY', 'RALLY_EARLY', 'MIX100', 'MIX100E', 'LATE', 'MIX50'])('%s: plan bots lose no rallies to the cooldown (they wait and retry): every planned rally is played, in every phase count', (name) => {
    const cr = WORLD_CONFIG.costs.rally;
    const planned = (f: number) => Math.floor((f * START) / cr);
    const want = ({ RALLY: planned(1), RALLY_EARLY: planned(1), MIX100: planned(1), MIX100E: planned(1), MIX50: planned(0.5), LATE: planned(0.3) } as Record<string, number>)[name];
    for (const k of [1, 2, 3, 5]) {
      for (let g = 0; g < 4; g++) {
        const r = runGame(w, [name, 'ROADSHOW'], k, `rallies:${name}:${k}:${g}`);
        expect(r.players[0].rallies, `${name} k=${k} g=${g}`).toBe(want);
        expect(r.players[0].cooled).toBe(0);
        expect(r.players[0].rejected).toBe(0);
      }
    }
  });

  it('ADAPTIVE and BLIND still rally (their rally budget is spread over the phases, not rounded to zero per phase)', () => {
    for (const k of [1, 3, 5]) {
      const r = runGame(w, ['ADAPTIVE', 'BLIND'], k, `adaptive-rallies:${k}`);
      expect(r.players[0].rallies, `ADAPTIVE k=${k}`).toBeGreaterThanOrEqual(1);
      expect(r.players[1].rallies, `BLIND k=${k}`).toBeGreaterThanOrEqual(1);
    }
  });

  it.each([1, 2, 3, 4, 5])('%i polling phases: games complete for 2, 5 and 10 players', (k) => {
    for (const P of [2, 5, 10]) {
      const pool = Array.from({ length: P }, (_, i) => DEFAULT_POOL[i % DEFAULT_POOL.length]);
      const r = runGame(w, pool, k, `phases:${k}:${P}`);
      expect(r.players).toHaveLength(P);
      expect(r.players.every((p) => p.rejected === 0 && p.cooled === 0)).toBe(true);
      const total = r.players.reduce((s, p) => s + p.seats, 0);
      expect(total).toBeLessThanOrEqual(500);
      expect(r.players.filter((p) => p.seats >= majorityOf(500)).length).toBeLessThanOrEqual(1); // at most one player can hold a majority
    }
  });

  it('the same seed gives the identical game; a different seed gives a different one', () => {
    const run = (seed: string) => JSON.stringify(runGame(w, ['MIX50', 'ADAPTIVE', 'SNIPER'], 3, seed).players);
    expect(run('a')).toBe(run('a'));
    expect(run('a')).not.toBe(run('b'));
  });

  it('unknown strategies fail loudly', () => {
    expect(() => runGame(w, ['NO_SUCH_BOT', 'RALLY'], 2, 'x')).toThrow(/unknown strategy/);
  });

  it('win shares of a game add up to 1 (ties split)', () => {
    for (let g = 0; g < 10; g++) {
      const r = runGame(w, ['RALLY', 'MIX30', 'CLUSTER'], 2, 'win' + g);
      expect(r.players.reduce((s, p) => s + p.win, 0)).toBeCloseTo(1, 9);
    }
  });
});

describe('metrics helpers', () => {
  it('formatting helpers pad and round', () => {
    expect(pct(0.1234)).toBe('12.3%');
    expect(pct(0.5, 0)).toBe('50%');
    expect(pad(5, 4)).toBe('   5');
    expect(padR('ab', 4)).toBe('ab  ');
    expect(pad('toolong', 3)).toBe('toolong');
  });
  it('Agg collects games and renders a table with one row per strategy', () => {
    const agg = new Agg();
    for (let g = 0; g < 4; g++) agg.add(runGame(w, ['RALLY', 'ROADSHOW'], 2, 'm' + g));
    expect(agg.games).toBe(4);
    const table = fieldTable(agg, 2, 500, START);
    expect(table).toContain('RALLY');
    expect(table).toContain('ROADSHOW');
    expect(table).toContain('mino'); // the minor rally column
  });
});

describe('committed voters and balance metrics', () => {
  it('every game deals committed voters; seat balance metrics are consistent', () => {
    const agg = new Agg();
    for (let g = 0; g < 3; g++) agg.add(runGame(w, ['PATCH', 'RALLY', 'ROADSHOW'], 3, 'bal' + g));
    expect(agg.bal.seats).toBe(1500);
    expect(agg.bal.medianMargin).toBeGreaterThanOrEqual(0);
    expect(agg.bal.under10Pct).toBeLessThanOrEqual(100);
    expect(agg.bal.line()).toContain('median margin');
  });
  it('turning the committed bands, influence and randomness off removes the committed layer (old rules)', () => {
    const off = JSON.parse(JSON.stringify(WORLD_CONFIG));
    off.committed.bands.forEach((b: { percent: number }) => { b.percent = 0; });
    const w0 = buildWorld(loadMap(), off);
    const r = runGame(w0, ['ROADSHOW', 'RALLY'], 2, 'old');
    expect(r.seatsDecided).toBe(500);
  });
});

describe('CLI', () => {
  it('a tiny field run prints the table and exits 0', async () => {
    const out = await new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile(process.execPath, [tsx, 'src/run.ts', '--mode', 'field', '--games', '2', '--players', '3', '--phases', '2', '--quiet'], { cwd: simDir, timeout: 120_000 }, (e, stdout) => resolve({ code: e ? 1 : 0, stdout }));
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('FIELD  players=3 phases=2');
    expect(out.stdout).toContain('actions rejected (frozen seat) 0');
    expect(out.stdout).toContain('rally cooldown refusals 0');
  }, 120_000);
  it('the analytic checks mode prints the Gaussian reach and the rally cooldown', async () => {
    const out = await new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile(process.execPath, [tsx, 'src/run.ts', '--mode', 'checks', '--quiet'], { cwd: simDir, timeout: 60_000 }, (e, stdout) => resolve({ code: e ? 1 : 0, stdout }));
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`rally cooldown ${WORLD_CONFIG.cooldowns.rallyMs / 1000} s`);
    expect(out.stdout).toContain('Gaussian');
    expect(out.stdout).toContain('minor rally');
    expect(out.stdout).toContain(`campaign budget ${fullyFieldedBudget(WORLD_CONFIG).toLocaleString()}`); // after the candidates are paid
  }, 60_000);
  it('an unknown flag is an error', async () => {
    const code = await new Promise<number>((resolve) => { execFile(process.execPath, [tsx, 'src/run.ts', '--bogus'], { cwd: simDir, timeout: 60_000 }, (e) => resolve(e ? 1 : 0)); });
    expect(code).toBe(1);
  }, 60_000);
});
