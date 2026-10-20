// CLI + daemon test: start a real background daemon, call actions through it, stop it.
import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DevServer } from '../../server/src/local/devServer';
import { logFile, sessionFile, stateFile } from '../src/paths';
import { Human, startServer, until } from './helpers';

const run = promisify(execFile);
const REPO = resolve(__dirname, '..', '..', '..');
const CLI = 'game/agent/bin/cli.mjs'; // relative: run from the repo root, like an agent would
const NAME = `vitest-${process.pid}`;

let srv: DevServer;
let base: string;
beforeAll(async () => { ({ srv, base } = await startServer()); });
afterAll(async () => {
  await cli(['stop', '--name', NAME]).catch(() => undefined);
  await srv.close();
  for (const f of [stateFile(NAME), logFile(NAME), sessionFile(NAME)]) rmSync(f, { force: true });
});

async function cli(args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const r = await run(process.execPath, [CLI, ...args], { cwd: REPO, timeout: 90_000, env: { ...process.env, HP_SERVER: base } });
    return { stdout: r.stdout.trim(), code: 0 };
  } catch (e: any) {
    return { stdout: String(e.stdout ?? '').trim(), code: e.code ?? 1 };
  }
}

describe('CLI + daemon', () => {
  it('start, call actions (JSON and key=value), stop', async () => {
    // before start: clear error, exit code 2
    const none = await cli(['get_state', '--name', NAME]);
    expect(none.code).toBe(2);
    expect(none.stdout).toMatch(/^ERROR DAEMON/);

    const t0 = Date.now();
    const started = await cli(['start', '--name', NAME, '--server', base]);
    expect(started.code).toBe(0);
    const info = JSON.parse(started.stdout);
    expect(info.ok).toBe(true);
    expect(info.port).toBeGreaterThan(0);
    expect(existsSync(stateFile(NAME))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(30_000);
    const again = JSON.parse((await cli(['start', '--name', NAME, '--server', base])).stdout);
    expect(again.already_running).toBe(true);
    expect(again.pid).toBe(info.pid);

    const list = JSON.parse((await cli(['list'])).stdout);
    expect(list.daemons.some((d: any) => d.name === NAME && d.running)).toBe(true);

    const actions = JSON.parse((await cli(['actions', '--name', NAME])).stdout);
    expect(actions.map((a: any) => a.name)).toContain('campaign_batch');
    expect(actions.find((a: any) => a.name === 'campaign').input_schema.required).toEqual(['type', 'seat']);

    // 3 actions through the daemon
    const rules = await cli(['get_rules', '--name', NAME]);
    expect(rules.code).toBe(0);
    expect(rules.stdout).toContain('HUNG PARLIAMENT');
    expect(rules.stdout).toContain('W₹50,000');

    const human = await new Human(base).create('Asha', 1);
    const t1 = Date.now();
    const joined = await cli(['join_game', '--name', NAME, JSON.stringify({ join_code: human.joinCode, nickname: 'CliBot' })]);
    expect(joined.code).toBe(0);
    expect(JSON.parse(joined.stdout).status).toBe('pending');
    expect(Date.now() - t1).toBeLessThan(15_000);
    await until(async () => (await human.pending()).length === 1, 5000, 'pending cli agent');
    expect((await human.pending())[0].kind).toBe('agent');
    await human.admit((await human.pending())[0].playerId);

    const adm = await cli(['wait_for_admission', '--name', NAME, 'timeout_s=10']);
    expect(JSON.parse(adm.stdout).status).toBe('admitted');
    const state = JSON.parse((await cli(['get_state', '--name', NAME])).stdout);
    expect(state.you.nickname).toBe('CliBot');
    expect(state.admission).toBe('admitted');
    const party = await cli(['set_party', '--name', NAME, '{name:Cli Party,colour:Teal,symbol:rocket,avatar:macron}']); // shell-mangled JSON is tolerated
    expect(JSON.parse(party.stdout).ok).toBe(true);

    // error paths: text + exit code 1
    const err = await cli(['campaign', '--name', NAME, 'type=rally', 'seat=3']);
    expect(err.code).toBe(1);
    expect(err.stdout).toMatch(/^ERROR WRONG_PHASE/);
    expect(err.stdout).toContain('Hint:');
    const unknown = await cli(['frobnicate', '--name', NAME]);
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toMatch(/UNKNOWN_ACTION/);

    // call latency is dominated by the tsx start-up, not by the daemon
    const t2 = Date.now();
    await cli(['get_state', '--name', NAME]);
    expect(Date.now() - t2).toBeLessThan(8000);

    const stopped = JSON.parse((await cli(['stop', '--name', NAME])).stdout);
    expect(stopped.ok).toBe(true);
    expect(existsSync(stateFile(NAME))).toBe(false);
    await until(async () => { try { process.kill(info.pid, 0); return false; } catch { return true; } }, 8000, 'daemon process exit');
    const after = await cli(['get_state', '--name', NAME]);
    expect(after.code).toBe(2);
  });
});
