// Lambda handlers (src/handlers/*): event parsing and error mapping, with the GameService replaced by a stub.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameError, HTTP_STATUS } from '../src/core/types';

const svc = vi.hoisted(() => ({
  phaseClose: vi.fn(async () => undefined),
  countReveal: vi.fn(async () => ({ done: false, nextAtMs: 1_700_000_000_000 })),
  finalise: vi.fn(async () => undefined),
  graceCheck: vi.fn(async () => undefined),
  connect: vi.fn(async () => 'p1'),
  disconnect: vi.fn(async () => undefined),
  handleMessage: vi.fn(async () => undefined),
  createGame: vi.fn(async () => ({ gameId: 'g' })),
  getLobby: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/aws/factory', () => ({ getService: () => svc }));

import { handler as phaseClose } from '../src/handlers/phase-close';
import { handler as countReveal } from '../src/handlers/count-reveal';
import { handler as finalise } from '../src/handlers/finalise';
import { handler as graceCheck } from '../src/handlers/grace-check';
import { handler as wsConnect } from '../src/handlers/ws-connect';
import { handler as wsDisconnect } from '../src/handlers/ws-disconnect';
import { handler as wsMessage } from '../src/handlers/ws-message';
import { handler as lobby } from '../src/handlers/lobby';

beforeEach(() => { for (const f of Object.values(svc)) f.mockClear(); });
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

describe('phase-close (Step Functions, 1-based phase)', () => {
  it.each([[1, 0], [2, 1], [5, 4], ['3', 2]])('phase %s -> service phase index %i', async (input, index) => {
    expect(await phaseClose({ gameId: 'g', phase: input as number })).toEqual({ ok: true });
    expect(svc.phaseClose).toHaveBeenCalledWith('g', index);
  });
  it.each([[0], [-1], [1.5], ['x'], [undefined], [null], [Number.NaN]])('bad phase %j throws and does nothing', async (phase) => {
    await expect(phaseClose({ gameId: 'g', phase: phase as number })).rejects.toThrow(/bad phase-close input/);
    expect(svc.phaseClose).not.toHaveBeenCalled();
  });
  it('missing gameId throws', async () => {
    await expect(phaseClose({ gameId: '', phase: 1 })).rejects.toThrow();
    expect(svc.phaseClose).not.toHaveBeenCalled();
  });
  it('service errors propagate so Step Functions can retry', async () => {
    svc.phaseClose.mockRejectedValueOnce(new Error('ddb throttled'));
    await expect(phaseClose({ gameId: 'g', phase: 1 })).rejects.toThrow('ddb throttled');
  });
});

describe('count-reveal', () => {
  it('returns done and the next wake-up as an ISO timestamp', async () => {
    expect(await countReveal({ gameId: 'g' })).toEqual({ done: false, nextAtIso: new Date(1_700_000_000_000).toISOString() });
    svc.countReveal.mockResolvedValueOnce({ done: true, nextAtMs: 5 });
    expect(await countReveal({ gameId: 'g' })).toEqual({ done: true, nextAtIso: '1970-01-01T00:00:00.005Z' });
  });
  it('requires a gameId', async () => {
    await expect(countReveal({ gameId: '' })).rejects.toThrow('gameId required');
    expect(svc.countReveal).not.toHaveBeenCalled();
  });
});

describe('finalise', () => {
  it('passes error:true only for a literal true', async () => {
    await finalise({ gameId: 'g' });
    expect(svc.finalise).toHaveBeenLastCalledWith('g', { error: false });
    await finalise({ gameId: 'g', error: true });
    expect(svc.finalise).toHaveBeenLastCalledWith('g', { error: true });
    await finalise({ gameId: 'g', error: 'true' as never });
    expect(svc.finalise).toHaveBeenLastCalledWith('g', { error: false });
  });
  it('requires a gameId and returns ok', async () => {
    await expect(finalise({ gameId: '' })).rejects.toThrow();
    expect(await finalise({ gameId: 'g' })).toEqual({ ok: true });
  });
});

describe('grace-check', () => {
  it('needs both ids', async () => {
    await expect(graceCheck({ gameId: 'g', playerId: '' })).rejects.toThrow();
    await expect(graceCheck({ gameId: '', playerId: 'p' })).rejects.toThrow();
    expect(svc.graceCheck).not.toHaveBeenCalled();
    expect(await graceCheck({ gameId: 'g', playerId: 'p' })).toEqual({ ok: true });
    expect(svc.graceCheck).toHaveBeenCalledWith('g', 'p');
  });
});

describe('ws-connect ($connect)', () => {
  const ev = (q: Record<string, string> | null | undefined) => ({ requestContext: { connectionId: 'c1' }, queryStringParameters: q });
  it('200 on success, passing gameId/token/connectionId', async () => {
    expect(await wsConnect(ev({ gameId: 'g', token: 't' }))).toEqual({ statusCode: 200 });
    expect(svc.connect).toHaveBeenCalledWith('g', 't', 'c1');
  });
  it('missing query string -> empty gameId and undefined token are passed on (service rejects them)', async () => {
    for (const q of [null, undefined, {}]) {
      await wsConnect(ev(q));
      expect(svc.connect).toHaveBeenLastCalledWith('', undefined, 'c1');
    }
  });
  it.each(Object.keys(HTTP_STATUS) as (keyof typeof HTTP_STATUS)[])('GameError %s -> its HTTP status and JSON body', async (code) => {
    svc.connect.mockRejectedValueOnce(new GameError(code, 'nope'));
    const r = await wsConnect(ev({ gameId: 'g', token: 't' })) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(HTTP_STATUS[code]);
    expect(JSON.parse(r.body)).toEqual({ error: code, message: 'nope' });
  });
  it('unexpected errors -> 500 without a body (no internals leaked) and are logged', async () => {
    const spy = quiet();
    svc.connect.mockRejectedValueOnce(new Error('db password is hunter2'));
    const r = await wsConnect(ev({ gameId: 'g', token: 't' })) as { statusCode: number; body?: string };
    expect(r.statusCode).toBe(500);
    expect(r.body).toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('ws-disconnect ($disconnect)', () => {
  it('always answers 200, even when the service fails', async () => {
    expect(await wsDisconnect({ requestContext: { connectionId: 'c1' } })).toEqual({ statusCode: 200 });
    expect(svc.disconnect).toHaveBeenCalledWith('c1');
    const spy = quiet();
    svc.disconnect.mockRejectedValueOnce(new Error('boom'));
    expect(await wsDisconnect({ requestContext: { connectionId: 'c2' } })).toEqual({ statusCode: 200 });
    spy.mockRestore();
  });
});

describe('ws-message (routes + $default)', () => {
  const ev = (body: string | null | undefined, isBase64Encoded = false) => ({ requestContext: { connectionId: 'c1' }, body, isBase64Encoded });
  it('parses the JSON body and always answers 200', async () => {
    expect(await wsMessage(ev('{"action":"ping","clientTime":5}'))).toEqual({ statusCode: 200 });
    expect(svc.handleMessage).toHaveBeenCalledWith('c1', { action: 'ping', clientTime: 5 });
  });
  it('decodes base64 bodies (UTF-8 survives)', async () => {
    const body = Buffer.from(JSON.stringify({ action: 'chat', to: ['p'], text: 'नमस्ते 🌍' })).toString('base64');
    await wsMessage(ev(body, true));
    expect(svc.handleMessage).toHaveBeenCalledWith('c1', { action: 'chat', to: ['p'], text: 'नमस्ते 🌍' });
  });
  it.each([['not json'], [''], [null], [undefined], ['{"a":']])('unparseable body %j is handed to the service as undefined (it answers BAD_REQUEST itself)', async (body) => {
    expect(await wsMessage(ev(body as string))).toEqual({ statusCode: 200 });
    expect(svc.handleMessage).toHaveBeenCalledWith('c1', undefined);
  });
});

describe('lobby (HTTP API payload v2)', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    rawPath: '/games', headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' }, body: undefined as string | undefined, isBase64Encoded: false,
    requestContext: { http: { method: 'GET' } }, ...over,
  });
  it('lower-cases header names and adds CORS + no-store headers', async () => {
    const r = await lobby(event({ rawPath: '/games/g1' }) as never) as { statusCode: number; headers: Record<string, string>; body: string };
    expect(svc.getLobby).toHaveBeenCalledWith('g1', 'abc');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });
  it('decodes a base64 body', async () => {
    const body = Buffer.from(JSON.stringify({ nickname: 'Zoë', mapId: 'world-500' })).toString('base64');
    await lobby(event({ rawPath: '/games', body, isBase64Encoded: true, requestContext: { http: { method: 'POST' } } }) as never);
    expect(svc.createGame).toHaveBeenCalledWith({ nickname: 'Zoë', mapId: 'world-500' });
  });
  it('OPTIONS -> 204 with an empty body; unknown route -> 404 JSON; GameError -> mapped status', async () => {
    const o = await lobby(event({ requestContext: { http: { method: 'OPTIONS' } } }) as never) as { statusCode: number; body: string };
    expect(o).toMatchObject({ statusCode: 204, body: '' });
    const n = await lobby(event({ rawPath: '/nowhere' }) as never) as { statusCode: number; body: string };
    expect(n.statusCode).toBe(404);
    svc.getLobby.mockRejectedValueOnce(new GameError('FORBIDDEN', 'x'));
    expect((await lobby(event({ rawPath: '/games/g1' }) as never) as { statusCode: number }).statusCode).toBe(403);
  });
  it('a missing header object does not crash', async () => {
    const r = await lobby(event({ headers: undefined, rawPath: '/games/g1' }) as never) as { statusCode: number };
    expect(r.statusCode).toBe(200);
    expect(svc.getLobby).toHaveBeenCalledWith('g1', undefined);
  });
});
