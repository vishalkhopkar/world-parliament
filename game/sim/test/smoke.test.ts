// Simulator smoke tests: every strategy plays complete games on the real world map, the incremental state agrees with the
// engine, games are deterministic, and the CLI entry point runs. (The balance numbers themselves live in REPORT.md.)
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG, majorityOf } from '@hp/shared';
import { DEFAULT_POOL, STRATEGIES } from '../src/bots';
import { runGame } from '../src/game';
import { Agg, fieldTable, pad, padR, pct } from '../src/metrics';
import { buildWorld, loadMap } from '../src/world';

const w = buildWorld(loadMap(), WORLD_CONFIG);
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
});

describe('strategies', () => {
  it('registry: every default-pool strategy exists and there are 18 strategies', () => {
    expect(Object.keys(STRATEGIES)).toHaveLength(18);
    for (const s of DEFAULT_POOL) expect(STRATEGIES[s]).toBeTypeOf('function');
  });

  it.each(Object.keys(STRATEGIES))('%s plays a 3-phase game against two opponents: no frozen-seat actions, budget never negative, effects match the engine', (name) => {
    const r = runGame(w, [name, 'RALLY', 'ROADSHOW'], 3, 'smoke:' + name, { verify: true });
    expect(r.verifyDiff).toBeLessThan(1e-9);
    expect(r.seatsDecided).toBe(500);
    for (const p of r.players) {
      expect(p.rejected, `${p.strategy} acted on a frozen seat`).toBe(0);
      expect(p.budgetLeft).toBeGreaterThanOrEqual(0);
      expect(p.budgetLeft).toBeLessThanOrEqual(WORLD_CONFIG.budget);
      expect(p.rallies * WORLD_CONFIG.costs.rally + p.roadshows * WORLD_CONFIG.costs.roadshow + p.reportSpend + p.budgetLeft).toBe(WORLD_CONFIG.budget);
      expect(p.seats).toBeGreaterThanOrEqual(0);
    }
    expect(r.players.reduce((s, p) => s + p.seats, 0)).toBeLessThanOrEqual(500);
  });

  it.each([1, 2, 3, 4, 5])('%i polling phases: games complete for 2, 5 and 10 players', (k) => {
    for (const P of [2, 5, 10]) {
      const pool = Array.from({ length: P }, (_, i) => DEFAULT_POOL[i % DEFAULT_POOL.length]);
      const r = runGame(w, pool, k, `phases:${k}:${P}`);
      expect(r.players).toHaveLength(P);
      expect(r.players.every((p) => p.rejected === 0)).toBe(true);
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
    const table = fieldTable(agg, 2, 500, WORLD_CONFIG.budget);
    expect(table).toContain('RALLY');
    expect(table).toContain('ROADSHOW');
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
  }, 120_000);
  it('an unknown flag is an error', async () => {
    const code = await new Promise<number>((resolve) => { execFile(process.execPath, [tsx, 'src/run.ts', '--bogus'], { cwd: simDir, timeout: 60_000 }, (e) => resolve(e ? 1 : 0)); });
    expect(code).toBe(1);
  }, 60_000);
});
