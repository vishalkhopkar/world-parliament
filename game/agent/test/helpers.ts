// Shared helpers for the integration tests: an in-process dev server and a scripted human host.
import { startDevServer } from '../../server/src/local/devServer';
import type { DevServer } from '../../server/src/local/devServer';
import { executeAction, formatResultText } from '../src/actions';
import type { AgentSession } from '../src/session';

export const SHORT_ENV = {
  HP_CAMPAIGN_MS: '16000', HP_COUNTING_MS: '9000', HP_POST_MS: '7000', HP_GRACE_MS: '2500', HP_START_DELAY_MS: '1200',
};

export async function startServer(env: Record<string, string> = SHORT_ENV): Promise<{ srv: DevServer; base: string }> {
  const srv = await startDevServer({ port: 0, env });
  return { srv, base: 'http://127.0.0.1:' + srv.port };
}

export class Human {
  gameId = ''; joinCode = ''; playerId = ''; token = '';
  constructor(public base: string) {}
  async api(method: string, path: string, body?: unknown, token = this.token): Promise<{ status: number; json: any }> {
    const r = await fetch(this.base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  async create(nickname = 'Asha', phases = 2): Promise<this> {
    const r = await this.api('POST', '/games', { nickname, mapId: 'world-500', phases }, '');
    if (r.status !== 200) throw new Error('create failed: ' + JSON.stringify(r));
    Object.assign(this, { gameId: r.json.gameId, joinCode: r.json.joinCode, playerId: r.json.playerId, token: r.json.token });
    return this;
  }
  lobby() { return this.api('GET', '/games/' + this.gameId); }
  async admit(playerId: string, admit = true) { return this.api('POST', `/games/${this.gameId}/admit`, { playerId, admit }); }
  async setParty(name: string, colour: string, symbol: string, avatar = 'putin') { return this.api('POST', `/games/${this.gameId}/party`, { party: { name, colour, symbol, avatar } }); }
  start() { return this.api('POST', `/games/${this.gameId}/start`); }
  async pending(): Promise<any[]> { return ((await this.lobby()).json.players as any[]).filter((p) => p.status === 'pending'); }
}

/** Run an action through the shared table; throws with the LLM-facing text on failure. */
export async function call<T = any>(s: AgentSession, name: string, args: unknown = {}): Promise<T> {
  const r = await executeAction(s, name, args);
  if (!r.ok) throw new Error(formatResultText(r));
  return r.data as T;
}

/** Run an action and return the error info (fails the test if it succeeded). */
export async function callErr(s: AgentSession, name: string, args: unknown = {}) {
  const r = await executeAction(s, name, args);
  if (r.ok) throw new Error(`expected ${name} to fail but it returned ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.error;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function until(cond: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await sleep(40);
  }
  throw new Error('timed out waiting for ' + what);
}
