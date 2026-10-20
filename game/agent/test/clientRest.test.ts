// GameClient REST layer with a fake fetch: what an AI player is allowed to send, error mapping, and no way to host.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GameClient } from '../src/client';
import { AgentError } from '../src/errors';

interface Call { method: string; url: string; headers: Record<string, string>; body: any }

function fake(handler: (c: Call) => { status?: number; json?: unknown; text?: string } | Error) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = { method: String(init.method), url: String(url), headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = handler(call);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => (r.text !== undefined ? r.text : JSON.stringify(r.json ?? {})) } as Response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const clients: GameClient[] = [];
const mk = (handler: Parameters<typeof fake>[0]) => {
  const f = fake(handler);
  // ws on a closed port: the live connection fails fast and quietly, the REST layer is what is under test
  const c = new GameClient({ server: 'http://game.test:8787/', ws: 'ws://127.0.0.1:1/ws', fetchImpl: f.fetchImpl, reconnectBaseMs: 60_000 });
  c.connect = async () => undefined; // no live connection in these tests (an unreachable socket would make every join wait for its 10 s timeout)
  clients.push(c);
  return { c, ...f };
};
afterEach(() => { for (const c of clients.splice(0)) c.close(); });

const joined = { gameId: 'g/1', playerId: 'p1', token: 'tok', status: 'pending' };

describe('join', () => {
  it('sends kind "agent", an upper-cased trimmed join code and a trimmed nickname, without credentials', async () => {
    const { c, calls } = mk(() => ({ json: joined }));
    const s = await c.join('  ab12cd ', '  Claude  ');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://game.test:8787/games/join', body: { joinCode: 'AB12CD', nickname: 'Claude', kind: 'agent' } });
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(s).toMatchObject({ gameId: 'g/1', playerId: 'p1', token: 'tok', joinCode: 'AB12CD', nickname: 'Claude' });
    expect(c.me).toBe('p1');
    expect(c.state.gameId).toBe('g/1');
  });

  it('joining twice is ALREADY_JOINED and sends nothing more', async () => {
    const { c, calls } = mk(() => ({ json: joined }));
    await c.join('ABC123', 'Bot');
    const before = calls.length;
    await expect(c.join('ABC123', 'Bot2')).rejects.toMatchObject({ code: 'ALREADY_JOINED' });
    expect(calls.length).toBe(before);
  });

  it.each([
    [404, 'NOT_FOUND', 'No game with that join code'], [409, 'ADMISSION_CLOSED', 'The game has already started'], [409, 'GAME_FULL', 'The game is full'], [400, 'BAD_REQUEST', 'Nickname must be 1-24 characters'],
  ])('server error %i %s becomes an AgentError with the same code and message, and no session is kept', async (status, code, message) => {
    const { c } = mk(() => ({ status, json: { error: code, message } }));
    await expect(c.join('ABC123', 'Bot')).rejects.toMatchObject({ code, message });
    expect(c.session).toBeNull();
    expect(c.me).toBeNull();
  });

  it('network failure -> NO_CONNECTION naming the server', async () => {
    const { c } = mk(() => new Error('connect ECONNREFUSED'));
    const e = (await c.join('ABC123', 'Bot').catch((x) => x)) as AgentError;
    expect(e).toBeInstanceOf(AgentError);
    expect(e.code).toBe('NO_CONNECTION');
    expect(e.message).toContain('http://game.test:8787');
    expect(e.hint).toBeTruthy();
  });

  it('a non-JSON error page (proxy / gateway) -> INTERNAL "HTTP 502" instead of a crash', async () => {
    const { c } = mk(() => ({ status: 502, text: '<html>Bad gateway</html>' }));
    await expect(c.join('ABC123', 'Bot')).rejects.toMatchObject({ code: 'INTERNAL', message: 'HTTP 502' });
  });

  it('an error body without a code is INTERNAL; with an unknown code it is passed through', async () => {
    expect(await mk(() => ({ status: 500, json: { message: 'oops' } })).c.join('A', 'b').catch((e) => e.code)).toBe('INTERNAL');
    expect(await mk(() => ({ status: 418, json: { error: 'TEAPOT', message: 'short and stout' } })).c.join('A', 'b').catch((e) => e.code)).toBe('TEAPOT');
  });
});

describe('after joining', () => {
  const server = (c: Call) => {
    if (c.url.endsWith('/games/join')) return { json: joined };
    if (c.method === 'GET') return { json: { gameId: 'g/1', joinCode: 'ABC123', mapId: 'world-500', phases: 2, status: 'lobby', admissionOpen: true, you: 'p1', players: [] } };
    return { json: { ok: true } };
  };

  it('refreshLobby: GET with the bearer token, game id URL-encoded, state updated', async () => {
    const { c, calls } = mk(server);
    await c.join('ABC123', 'Bot');
    const lobby = await c.refreshLobby();
    const call = calls.find((x) => x.method === 'GET')!;
    expect(call.url).toBe('http://game.test:8787/games/g%2F1');
    expect(call.headers.authorization).toBe('Bearer tok');
    expect(lobby.phases).toBe(2);
    expect(c.state.lobby).toEqual(lobby);
    expect(c.state.joinCode).toBe('ABC123');
  });

  it('setParty: POST /party with the party object and the token, then refreshes the lobby', async () => {
    const { c, calls } = mk(server);
    await c.join('ABC123', 'Bot');
    await c.setParty({ name: 'Blue', colour: '#1F5FBF', symbol: 'sun', avatar: 'xi' });
    const post = calls.find((x) => x.url.endsWith('/party'))!;
    expect(post).toMatchObject({ method: 'POST', body: { party: { name: 'Blue', colour: '#1F5FBF', symbol: 'sun', avatar: 'xi' } } });
    expect(post.headers.authorization).toBe('Bearer tok');
    expect(calls[calls.length - 1].method).toBe('GET');
  });

  it('the client only ever talks to join / lobby / party over REST: no create, admit, start, settings, admission', async () => {
    const { c, calls } = mk(server);
    await c.join('ABC123', 'Bot');
    await c.refreshLobby();
    await c.setParty({ name: 'Blue', colour: '#1F5FBF', symbol: 'sun', avatar: 'xi' });
    const paths = calls.map((x) => `${x.method} ${new URL(x.url).pathname.replace(/%2F/g, '/').replace('/games/g/1', '/games/ID')}`);
    expect([...new Set(paths)].sort()).toEqual(['GET /games/ID', 'POST /games/ID/party', 'POST /games/join']);
  });

  it('server errors on lobby calls keep their code (e.g. UNAUTHORIZED after a server restart)', async () => {
    let fail = false;
    const { c } = mk((call) => (fail && call.method === 'GET' ? { status: 401, json: { error: 'UNAUTHORIZED', message: 'Invalid token' } } : server(call)));
    await c.join('ABC123', 'Bot');
    fail = true;
    await expect(c.refreshLobby()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('party errors carry the hint of their code', async () => {
    const { c } = mk((call) => (call.url.endsWith('/party') ? { status: 409, json: { error: 'COLOUR_TAKEN', message: 'Another party already has that colour' } } : server(call)));
    await c.join('ABC123', 'Bot');
    const e = (await c.setParty({ name: 'Blue', colour: '#1F5FBF', symbol: 'sun', avatar: 'xi' }).catch((x) => x)) as AgentError;
    expect(e.code).toBe('COLOUR_TAKEN');
    expect(e.hint).toMatch(/list_party_options/);
  });
});

describe('before joining', () => {
  it.each(['refreshLobby', 'campaignBatch', 'buyReport', 'chat', 'proposeGovernment', 'respondOffer', 'withdrawOffer'] as const)('%s -> NOT_JOINED and nothing on the wire', async (method) => {
    const { c, calls } = mk(() => ({ json: {} }));
    const args: Record<string, unknown[]> = { refreshLobby: [], campaignBatch: [[{ type: 'rally', seat: 1 }]], buyReport: ['global'], chat: [['x'], 'hi'], proposeGovernment: [{ PM: ['me'] }], respondOffer: ['o', true], withdrawOffer: ['o'] };
    let code = '';
    try {
      const r = await (c[method] as (...a: unknown[]) => Promise<unknown>)(...args[method]);
      // campaignBatch reports failures per row instead of throwing
      if (method === 'campaignBatch') code = ((r as { ok: boolean; error?: AgentError }[])[0].error as AgentError).code;
    } catch (e) { code = (e as AgentError).code; }
    expect(code).toBe('NOT_JOINED');
    expect(calls).toEqual([]);
  });

  it('setParty without a session -> NOT_JOINED', async () => {
    const { c } = mk(() => ({ json: {} }));
    await expect(c.setParty({ name: 'x', colour: '#000000', symbol: 'sun', avatar: 'xi' })).rejects.toMatchObject({ code: 'NOT_JOINED' });
  });
});

describe('AI agents cannot create games', () => {
  it('the client source has no create call, no admin REST calls, and join always says kind agent', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/client.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/rest<[^>]*>\(\s*'POST',\s*'\/games'\s*[,)]/);
    expect(src).not.toMatch(/\/start|\/admit|\/settings|\/admission/);
    expect(src).toContain("kind: 'agent'");
    expect('createGame' in GameClient.prototype).toBe(false);
  });
  it('no source file of the agent package posts to /games (create) or mentions the host-only endpoints', () => {
    for (const f of ['actions.ts', 'client.ts', 'cli.ts', 'daemon.ts', 'mcp.ts', 'session.ts']) {
      const src = readFileSync(fileURLToPath(new URL('../src/' + f, import.meta.url)), 'utf8');
      expect(src, f).not.toMatch(/['"`]\/games['"`]/);
      expect(src, f).not.toMatch(/\/(start|admit|admission|settings)['"`/]/);
    }
  });
});
