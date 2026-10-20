// The local dev server's transport layer: CORS, error bodies, WebSocket upgrade rules, per-message robustness.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@hp/shared';
import { startDevServer } from '../src/local/devServer';
import type { DevServer } from '../src/local/devServer';

let srv: DevServer;
const base = () => 'http://127.0.0.1:' + srv.port;
beforeAll(async () => { srv = await startDevServer({ port: 0, env: { HP_CAMPAIGN_MS: '30000', HP_START_DELAY_MS: '100' } }); });
afterAll(async () => { await srv.close(); });

async function create() {
  const r = await fetch(base() + '/games', { method: 'POST', body: JSON.stringify({ nickname: 'Asha', mapId: 'world-500', phases: 1 }), headers: { 'content-type': 'application/json' } });
  return (await r.json()) as { gameId: string; token: string; joinCode: string; playerId: string };
}

/** Opens a socket; resolves with the status line on a refused upgrade. */
function open(url: string): Promise<{ ws?: WebSocket; status?: number; msgs: ServerMessage[] }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const msgs: ServerMessage[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('unexpected-response', (_q, r) => resolve({ status: r.statusCode, msgs }));
    ws.on('error', () => undefined);
  });
}
const until = async (cond: () => boolean, ms = 4000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

describe('HTTP', () => {
  it('every response (including errors) carries JSON content type, no-store and CORS headers', async () => {
    for (const [method, path] of [['GET', '/games/none'], ['POST', '/games'], ['GET', '/nothing']]) {
      const r = await fetch(base() + path, { method });
      expect(r.headers.get('content-type')).toBe('application/json');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  it('OPTIONS pre-flight: 204, empty body, allowed headers include authorization', async () => {
    const r = await fetch(base() + '/games', { method: 'OPTIONS', headers: { origin: 'http://example.com', 'access-control-request-method': 'POST' } });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    expect(r.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(r.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('unknown route and garbage bodies are clean JSON errors, never a hung request or a crash', async () => {
    const r404 = await fetch(base() + '/nothing');
    expect(r404.status).toBe(404);
    expect(await r404.json()).toMatchObject({ error: 'NOT_FOUND' });
    const bad = await fetch(base() + '/games', { method: 'POST', body: '{{{' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'BAD_REQUEST' });
    const big = await fetch(base() + '/games', { method: 'POST', body: JSON.stringify({ nickname: 'x'.repeat(100_000) }) });
    expect(big.status).toBe(400);
    expect((await fetch(base() + '/games/none', { headers: { authorization: 'Bearer x' } })).status).toBe(404);
  });

  it('query strings are ignored for routing', async () => {
    const g = await create();
    const r = await fetch(base() + `/games/${g.gameId}?x=1&y=2`, { headers: { authorization: 'Bearer ' + g.token } });
    expect(r.status).toBe(200);
  });
});

describe('WebSocket upgrade', () => {
  it('only /ws upgrades; other paths are 404', async () => {
    const g = await create();
    expect((await open(`ws://127.0.0.1:${srv.port}/socket?gameId=${g.gameId}&token=${g.token}`)).status).toBe(404);
    expect((await open(`ws://127.0.0.1:${srv.port}/?gameId=${g.gameId}&token=${g.token}`)).status).toBe(404);
  });

  it.each([
    ['no query at all', (_g: { gameId: string; token: string }) => ''],
    ['no token', (g: { gameId: string; token: string }) => `?gameId=${g.gameId}`],
    ['wrong token', (g: { gameId: string; token: string }) => `?gameId=${g.gameId}&token=nope`],
    ['no game id', (g: { gameId: string; token: string }) => `?token=${g.token}`],
    ['unknown game', (g: { gameId: string; token: string }) => `?gameId=zzz&token=${g.token}`],
  ])('refused upgrade: %s', async (_label, q) => {
    const g = await create();
    const r = await open(`ws://127.0.0.1:${srv.port}/ws${q(g)}`);
    expect(r.ws).toBeUndefined();
    expect([401, 404]).toContain(r.status);
  });

  it('a valid socket gets the hello only after its first message (API Gateway semantics)', async () => {
    const g = await create();
    const r = await open(`ws://127.0.0.1:${srv.port}/ws?gameId=${g.gameId}&token=${g.token}`);
    expect(r.ws).toBeDefined();
    await new Promise((res) => setTimeout(res, 150));
    expect(r.msgs).toEqual([]);
    r.ws!.send(JSON.stringify({ action: 'ping', clientTime: 7 }));
    await until(() => r.msgs.some((m) => m.type === 'pong'));
    expect(r.msgs.map((m) => m.type)).toEqual(['hello', 'pong']);
    expect(r.msgs[1]).toMatchObject({ type: 'pong', clientTime: 7 });
    r.ws!.close();
  });

  it('non-JSON, binary and unknown messages are answered with BAD_REQUEST and the socket stays usable', async () => {
    const g = await create();
    const r = await open(`ws://127.0.0.1:${srv.port}/ws?gameId=${g.gameId}&token=${g.token}`);
    const ws = r.ws!;
    ws.send('this is not json');
    await until(() => r.msgs.some((m) => m.type === 'error'));
    ws.send(Buffer.from([0, 1, 2, 3]));
    ws.send(JSON.stringify({ action: 'launchMissiles' }));
    ws.send(JSON.stringify({ action: 'ping', clientTime: 1 }));
    await until(() => r.msgs.some((m) => m.type === 'pong'));
    const errors = r.msgs.filter((m): m is Extract<ServerMessage, { type: 'error' }> => m.type === 'error');
    expect(errors.length).toBe(3);
    expect(errors.every((e) => e.error === 'BAD_REQUEST')).toBe(true);
    ws.close();
  });

  it('messages are processed strictly in order per socket (a burst of pings is answered in order)', async () => {
    const g = await create();
    const r = await open(`ws://127.0.0.1:${srv.port}/ws?gameId=${g.gameId}&token=${g.token}`);
    for (let i = 0; i < 50; i++) r.ws!.send(JSON.stringify({ action: 'ping', clientTime: i }));
    await until(() => r.msgs.filter((m) => m.type === 'pong').length === 50);
    expect(r.msgs.filter((m): m is Extract<ServerMessage, { type: 'pong' }> => m.type === 'pong').map((m) => m.clientTime)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    r.ws!.close();
  });

  it('a second socket for the same player replaces the first one for messages', async () => {
    const g = await create();
    const a = await open(`ws://127.0.0.1:${srv.port}/ws?gameId=${g.gameId}&token=${g.token}`);
    const b = await open(`ws://127.0.0.1:${srv.port}/ws?gameId=${g.gameId}&token=${g.token}`);
    a.ws!.send(JSON.stringify({ action: 'ping', clientTime: 1 }));
    await until(() => a.msgs.some((m) => m.type === 'error'));
    expect(a.msgs.find((m) => m.type === 'error')).toMatchObject({ error: 'UNAUTHORIZED' }); // old connection id is gone
    b.ws!.send(JSON.stringify({ action: 'ping', clientTime: 2 }));
    await until(() => b.msgs.some((m) => m.type === 'pong'));
    a.ws!.close(); b.ws!.close();
  });

  it('close(): the server stops listening and drops sockets', async () => {
    const s = await startDevServer({ port: 0, env: {} });
    const r = await fetch(`http://127.0.0.1:${s.port}/games`, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    await s.close();
    await expect(fetch(`http://127.0.0.1:${s.port}/games`, { method: 'OPTIONS', signal: AbortSignal.timeout(1500) })).rejects.toBeTruthy();
  });
});
