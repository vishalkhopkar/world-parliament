import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@hp/shared';
import { startDevServer } from '../src/local/devServer';
import type { DevServer } from '../src/local/devServer';

let srv: DevServer;
const base = () => 'http://127.0.0.1:' + srv.port;

beforeAll(async () => {
  srv = await startDevServer({
    port: 0,
    env: { HP_CAMPAIGN_MS: '1500', HP_COUNTING_MS: '600', HP_POST_MS: '400', HP_GRACE_MS: '500', HP_START_DELAY_MS: '200' },
  });
});
afterAll(async () => { await srv.close(); });

async function api(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(base() + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}

function client(gameId: string, token: string) {
  const ws = new WebSocket('ws://127.0.0.1:' + srv.port + '/ws?gameId=' + gameId + '&token=' + token);
  const msgs: ServerMessage[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  const open = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); ws.on('unexpected-response', (_q, r) => rej(new Error('HTTP ' + r.statusCode))); });
  const waitFor = async (pred: (m: ServerMessage) => boolean, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = msgs.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timeout waiting for message; got ' + msgs.map((m) => m.type).join(','));
  };
  return { ws, msgs, open, waitFor, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe('dev server (REST + WebSocket, real timers)', () => {
  it('plays a short game end to end', async () => {
    const created = await api('POST', '/games', { nickname: 'Asha', mapId: 'world-500', phases: 2 });
    expect(created.status).toBe(200);
    const { gameId, joinCode, token: t0 } = created.json;
    const joined = await api('POST', '/games/join', { joinCode, nickname: 'Ben' });
    expect(joined.status).toBe(200);
    const { playerId: p1, token: t1 } = joined.json;

    // unauthenticated / forbidden
    expect((await api('GET', '/games/' + gameId)).status).toBe(401);
    expect((await api('POST', '/games/' + gameId + '/admit', { playerId: p1, admit: true }, t1)).status).toBe(403);
    expect((await api('GET', '/games/nope', undefined, t0)).status).toBe(404);

    // the pending player opens a socket right away
    const c1 = client(gameId, t1);
    await c1.open;
    c1.send({ action: 'ping', clientTime: 1 });
    await c1.waitFor((m) => m.type === 'hello');

    expect((await api('POST', '/games/' + gameId + '/admit', { playerId: p1, admit: true }, t0)).status).toBe(200);
    await c1.waitFor((m) => m.type === 'players' && m.players.some((p) => p.playerId === p1 && p.status === 'active'));
    expect((await api('POST', '/games/' + gameId + '/party', { party: { name: 'Sun', colour: '#E8710A', symbol: 'sun', avatar: 'kim' } }, t0)).status).toBe(200);
    expect((await api('POST', '/games/' + gameId + '/party', { party: { name: 'Moon', colour: '#E8710A', symbol: 'star', avatar: 'xi' } }, t1)).json.error).toBe('COLOUR_TAKEN');
    expect((await api('POST', '/games/' + gameId + '/party', { party: { name: 'Moon', colour: '#1F5FBF', symbol: 'star', avatar: 'kim' } }, t1)).json.error).toBe('AVATAR_TAKEN');
    expect((await api('POST', '/games/' + gameId + '/start', undefined, t0)).json.error).toBe('BAD_REQUEST'); // Ben has no party yet
    expect((await api('POST', '/games/' + gameId + '/party', { party: { name: 'Moon', colour: '#1F5FBF', symbol: 'star', avatar: 'xi' } }, t1)).status).toBe(200);
    const lobby = await api('GET', '/games/' + gameId, undefined, t1);
    expect(lobby.json.players).toHaveLength(2);

    const started = await api('POST', '/games/' + gameId + '/start', undefined, t0);
    expect(started.status).toBe(200);
    const tl = started.json.timeline;
    expect(tl.phaseCloses).toHaveLength(2);

    const c0 = client(gameId, t0);
    await c0.open;
    c0.send({ action: 'ping', clientTime: 1 });
    await c0.waitFor((m) => m.type === 'hello');
    await new Promise((r) => setTimeout(r, Math.max(0, tl.campaignStart - Date.now() + 20)));
    c0.send({ action: 'campaign', type: 'rally', seat: 1, clientRef: 'x' });
    await c0.waitFor((m) => m.type === 'actionAck');
    await c1.waitFor((m) => m.type === 'news');
    c1.send({ action: 'campaign', type: 'roadshow', seat: 2 });
    await c1.waitFor((m) => m.type === 'actionAck');
    expect(c0.msgs.filter((m) => m.type === 'news')).toHaveLength(1);

    await c0.waitFor((m) => m.type === 'phaseClosed' && m.phase === 1, 5000);
    await c0.waitFor((m) => m.type === 'status' && m.status === 'counting');
    const last = await c0.waitFor((m) => m.type === 'seatUpdate' && m.tally.declared === m.tally.total, 6000);
    expect((last as any).tally.total).toBe(500);
    const result = (await c1.waitFor((m) => m.type === 'result', 8000)) as Extract<ServerMessage, { type: 'result' }>;
    expect(result.result.points).toHaveLength(2);
    c0.ws.close(); c1.ws.close();
  }, 30000);

  it('rejects a websocket with a bad token', async () => {
    const c = client('abc', 'bad');
    await expect(c.open).rejects.toThrow(/HTTP 40[14]/);
  });
});
