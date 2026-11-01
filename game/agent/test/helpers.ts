// Shared helpers for the integration tests: an in-process dev server and a scripted human host.
import { startDevServer } from '../../server/src/local/devServer';
import type { DevServer } from '../../server/src/local/devServer';
import { executeAction, formatResultText } from '../src/actions';
import type { AgentSession } from '../src/session';

export const SHORT_ENV = {
  HP_PRECAMPAIGN_MS: '5000', HP_CAMPAIGN_MS: '16000', HP_COUNTING_MS: '9000', HP_POST_MS: '7000', HP_GRACE_MS: '2500', HP_START_DELAY_MS: '1200',
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
  /** Host: "Play again" from the finished game; switches this helper to the new game (same player id and token). */
  async playAgain(phases = 2): Promise<{ status: number; json: any }> {
    const r = await this.api('POST', `/games/${this.gameId}/rematch`, { phases });
    if (r.status === 200) Object.assign(this, { gameId: r.json.gameId, joinCode: r.json.joinCode });
    return r;
  }
  private ws: WebSocket | null = null;
  private wsGame = '';
  private acks: any[] = [];
  private async socket(): Promise<WebSocket> {
    if (!this.ws || this.wsGame !== this.gameId || this.ws.readyState !== WebSocket.OPEN) {
      this.close();
      const ws = new WebSocket(`${this.base.replace(/^http/, 'ws')}/ws?gameId=${encodeURIComponent(this.gameId)}&token=${encodeURIComponent(this.token)}`);
      this.ws = ws; this.wsGame = this.gameId; this.acks = [];
      ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === 'fieldAck' || m.type === 'error' || (m.type === 'fieldingDone' && m.playerId === this.playerId)) this.acks.push(m); };
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('host socket failed')); });
      ws.send(JSON.stringify({ action: 'ping', clientTime: Date.now() }));
    }
    return this.ws;
  }
  /** Host: field candidates over the game's WebSocket, like the web client (the pre-campaign is WebSocket-only). Resolves with the fieldAck. */
  async field(seats: number[], timeoutMs = 5000): Promise<any> {
    const ws = await this.socket();
    const ref = 'host-' + Math.random().toString(36).slice(2, 8);
    ws.send(JSON.stringify({ action: 'field', seats, clientRef: ref }));
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = this.acks.find((m) => m.clientRef === ref);
      if (hit) { if (hit.type === 'error') throw new Error('host field failed: ' + hit.error); return hit; }
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('host field timed out');
  }
  /** Host: press "Done fielding" (or take it back) over the WebSocket. Resolves with the host's own fieldingDone message. */
  async done(done = true, timeoutMs = 5000): Promise<any> {
    const ws = await this.socket();
    const ref = 'host-' + Math.random().toString(36).slice(2, 8);
    const seen = this.acks.length;
    ws.send(JSON.stringify({ action: 'doneFielding', done, clientRef: ref }));
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const err = this.acks.find((m) => m.clientRef === ref && m.type === 'error');
      if (err) throw new Error('host done failed: ' + err.error);
      const hit = this.acks.slice(seen).find((m) => m.type === 'fieldingDone' && m.done === done);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('host done timed out');
  }
  close(): void { try { this.ws?.close(); } catch { /* ignore */ } this.ws = null; }
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
