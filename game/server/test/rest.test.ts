// REST router (core/http.ts) + permissions + one reachable path for every ErrorCode (and its HTTP status).
import { describe, expect, it, vi } from 'vitest';
import { AVATARS, PARTY_COLOURS, PARTY_SYMBOLS, majorityGovernment } from '@hp/shared';
import type { ClientMessage, ErrorCode } from '@hp/shared';
import { handleRest } from '../src/core/http';
import type { RestResponse } from '../src/core/http';
import { GameService } from '../src/core/gameService';
import { GameError, HTTP_STATUS } from '../src/core/types';
import { Ctx, driveTo } from './helpers';

const authHeader = (token?: string, scheme = 'Bearer') => (token === undefined ? {} : { authorization: `${scheme} ${token}` });

function api(c: Ctx) {
  return (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<RestResponse> =>
    handleRest(c.svc, {
      method, path, headers: { ...authHeader(token), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
}

/** A fresh REST world: admin created a game; `others` joined (pending). */
async function world(others = 0) {
  const c = new Ctx();
  const call = api(c);
  const created = await call('POST', '/games', { nickname: 'Admin', mapId: 'test', phases: 2 });
  expect(created.status).toBe(200);
  const g = created.body as { gameId: string; joinCode: string; playerId: string; token: string };
  const players: { playerId: string; token: string }[] = [];
  for (let i = 0; i < others; i++) {
    const j = await call('POST', '/games/join', { joinCode: g.joinCode, nickname: `P${i + 1}` });
    expect(j.status).toBe(200);
    players.push(j.body as { playerId: string; token: string });
  }
  c.gameId = g.gameId;
  return { c, call, g, players };
}

const party = (i: number, over: Record<string, unknown> = {}) => ({
  party: { name: `Party ${i}`, colour: PARTY_COLOURS[i].id, symbol: PARTY_SYMBOLS[i].id, avatar: AVATARS[i].id, ...over },
});

describe('routing', () => {
  it('OPTIONS answers 204 on any path (CORS pre-flight), even without auth', async () => {
    const { call } = await world();
    for (const p of ['/games', '/games/join', '/games/x/start', '/nothing']) {
      const r = await call('OPTIONS', p);
      expect(r.status).toBe(204);
      expect(r.body).toBeUndefined();
    }
  });

  it.each([
    ['GET', '/'], ['GET', '/nothing'], ['POST', '/nothing'], ['GET', '/games'], ['PUT', '/games'], ['DELETE', '/games'],
    ['GET', '/games/join'], ['POST', '/games/x'], ['PUT', '/games/x'], ['DELETE', '/games/x'], ['GET', '/games/x/admit'],
    ['POST', '/games/x/unknown'], ['POST', '/games/x/start/extra'], ['POST', '/games/join/extra'], ['PATCH', '/games/x/party'],
    ['GET', '/game/x'], ['POST', '/Games'],
  ])('%s %s -> 404 NOT_FOUND', async (method, path) => {
    const { call, g } = await world();
    const r = await call(method, path, {}, g.token);
    // GET /games/join is a lobby read for a game called "join": it is looked up and not found as well
    expect(r.status).toBe(404);
    expect((r.body as { error: string }).error).toBe('NOT_FOUND');
  });

  it('method names are case-insensitive and extra slashes are ignored', async () => {
    const { call, g } = await world();
    const r = await call('get', `//games//${g.gameId}//`, undefined, g.token);
    expect(r.status).toBe(200);
    expect((r.body as { gameId: string }).gameId).toBe(g.gameId);
  });

  it('a percent-encoded game id is decoded', async () => {
    const { call, g } = await world();
    const encoded = [...g.gameId].map((ch) => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    expect((await call('GET', `/games/${encoded}`, undefined, g.token)).status).toBe(200);
  });

  it.each([['not json'], ['[]'], ['null'], ['"text"'], ['42'], ['{"a":']])('malformed body %s -> 400 BAD_REQUEST', async (body) => {
    const { call, g } = await world();
    for (const [path, token] of [['/games', undefined], ['/games/join', undefined], [`/games/${g.gameId}/admit`, g.token], [`/games/${g.gameId}/party`, g.token], [`/games/${g.gameId}/rematch`, g.token]] as const) {
      const r = await call('POST', path, body, token);
      expect(r.status, path).toBe(400);
      expect((r.body as { error: string }).error).toBe('BAD_REQUEST');
    }
  });

  it('an empty body is treated as {} (then fails field validation, never crashes)', async () => {
    const { call } = await world();
    const r = await call('POST', '/games');
    expect(r.status).toBe(400);
    expect((r.body as { message: string }).message).toMatch(/Nickname/);
  });

  it('every error body has the ApiError shape and the status of its code', async () => {
    const { call } = await world();
    const r = await call('POST', '/games/join', { joinCode: 'ZZZZZZ', nickname: 'x' });
    expect(r.body).toEqual({ error: 'NOT_FOUND', message: expect.any(String) });
    expect(r.status).toBe(HTTP_STATUS.NOT_FOUND);
  });
});

describe('authentication', () => {
  const routes: [string, string, unknown][] = [
    ['GET', '', undefined], ['POST', '/admit', { playerId: 'x', admit: true }], ['POST', '/admission', { open: true }],
    ['POST', '/settings', { phases: 2 }], ['POST', '/party', party(0)], ['POST', '/start', undefined], ['POST', '/rematch', { phases: 2 }],
  ];

  it.each(routes)('%s /games/{id}%s needs a valid bearer token', async (method, suffix, body) => {
    const { call, g, c } = await world(1);
    const path = `/games/${g.gameId}${suffix}`;
    const code = async (token?: string, scheme?: string, headers?: Record<string, string>) => {
      const r = await handleRest(c.svc, { method, path, headers: { ...(token === undefined ? {} : { authorization: `${scheme ?? 'Bearer'} ${token}` }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return [r.status, (r.body as { error?: string }).error] as const;
    };
    expect(await code()).toEqual([401, 'UNAUTHORIZED']);                         // no header
    expect(await code('')).toEqual([401, 'UNAUTHORIZED']);                       // "Bearer "
    expect(await code(g.token, 'Basic')).toEqual([401, 'UNAUTHORIZED']);         // wrong scheme
    expect(await code('not-a-token')).toEqual([401, 'UNAUTHORIZED']);
    expect(await code(g.token + 'x')).toEqual([401, 'UNAUTHORIZED']);
    expect(await code(g.token.slice(1))).toEqual([401, 'UNAUTHORIZED']);
    expect(await code(g.token, 'Bearer', { authorization: `Bearer a b ${g.token}` })).toEqual([401, 'UNAUTHORIZED']); // two tokens
    expect((await call(method, path, body, g.token)).status).not.toBe(401);
    void call;
  });

  it('the scheme is case-insensitive and surrounding whitespace is tolerated', async () => {
    const { call, g } = await world();
    for (const header of [`bearer ${g.token}`, `BEARER ${g.token}`, `Bearer   ${g.token}  `]) {
      const r = await call('GET', `/games/${g.gameId}`, undefined, undefined, { authorization: header });
      expect(r.status, header).toBe(200);
    }
  });

  it('unknown game: NOT_FOUND with a token, UNAUTHORIZED without one (token is checked first)', async () => {
    const { call, g } = await world();
    expect((await call('GET', '/games/nope', undefined, g.token)).status).toBe(404);
    expect((await call('GET', '/games/nope')).status).toBe(401);
  });

  it('a token is only valid in its own game', async () => {
    const a = await world();
    const b = (await a.call('POST', '/games', { nickname: 'Other', mapId: 'test' })).body as { gameId: string; token: string };
    expect((await a.call('GET', `/games/${b.gameId}`, undefined, a.g.token)).status).toBe(401);
    expect((await a.call('GET', `/games/${a.g.gameId}`, undefined, b.token)).status).toBe(401);
    expect((await a.call('GET', `/games/${b.gameId}`, undefined, b.token)).status).toBe(200);
  });
});

describe('permissions', () => {
  const adminOnly: [string, string, unknown][] = [
    ['POST', '/admit', { playerId: 'x', admit: true }], ['POST', '/admission', { open: false }], ['POST', '/settings', { phases: 3 }], ['POST', '/start', undefined],
    ['POST', '/rematch', { phases: 2 }],
  ];

  it.each(adminOnly)('%s %s is admin-only: active, pending and rejected players get FORBIDDEN, nothing changes', async (_m, suffix, body) => {
    const { c, call, g, players } = await world(3);
    await call('POST', `/games/${g.gameId}/admit`, { playerId: players[0].playerId, admit: true }, g.token);   // active
    await call('POST', `/games/${g.gameId}/admit`, { playerId: players[2].playerId, admit: false }, g.token);  // rejected
    // players[1] stays pending
    const before = JSON.stringify(await c.repo.getGame(g.gameId));
    for (const p of players) {
      const r = await call('POST', `/games/${g.gameId}${suffix}`, body, p.token);
      expect(r.status).toBe(403);
      expect((r.body as { error: string }).error).toBe('FORBIDDEN');
    }
    expect(JSON.stringify(await c.repo.getGame(g.gameId))).toBe(before);
  });

  it('admin-only checks run before the lobby-state check (non-admin on a started game is FORBIDDEN, admin is WRONG_PHASE)', async () => {
    const c = await new Ctx().started(3, 2);
    const call = api(c);
    for (const [suffix, body] of [['/admit', { playerId: c.p[1].playerId, admit: true }], ['/admission', { open: true }], ['/settings', { phases: 2 }], ['/start', undefined], ['/rematch', { phases: 2 }]] as const) {
      const asPlayer = await call('POST', `/games/${c.gameId}${suffix}`, body, c.p[1].token);
      expect((asPlayer.body as { error: string }).error, suffix).toBe('FORBIDDEN');
      const asAdmin = await call('POST', `/games/${c.gameId}${suffix}`, body, c.p[0].token);
      expect((asAdmin.body as { error: string }).error, suffix).toBe('WRONG_PHASE');
      expect(asAdmin.status).toBe(409);
    }
  });

  it('party: only an admitted (active) player in the lobby', async () => {
    const { call, g, players } = await world(3);
    await call('POST', `/games/${g.gameId}/admit`, { playerId: players[0].playerId, admit: true }, g.token);
    await call('POST', `/games/${g.gameId}/admit`, { playerId: players[2].playerId, admit: false }, g.token);
    expect((await call('POST', `/games/${g.gameId}/party`, party(0), players[0].token)).status).toBe(200);
    expect((await call('POST', `/games/${g.gameId}/party`, party(1), players[1].token)).status).toBe(403); // pending
    expect((await call('POST', `/games/${g.gameId}/party`, party(2), players[2].token)).status).toBe(403); // rejected
    expect((await call('POST', `/games/${g.gameId}/party`, party(3), g.token)).status).toBe(200);           // the admin plays too
  });

  it('party after the start is WRONG_PHASE', async () => {
    const c = await new Ctx().started(2, 1);
    const r = await api(c)('POST', `/games/${c.gameId}/party`, party(5), c.p[1].token);
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toBe('WRONG_PHASE');
  });

  it('the admin cannot admit / reject themselves or an unknown player (NOT_FOUND)', async () => {
    const { call, g } = await world(1);
    for (const playerId of [g.playerId, 'ghost', undefined, 42]) {
      for (const admit of [true, false]) {
        const r = await call('POST', `/games/${g.gameId}/admit`, { playerId, admit }, g.token);
        expect(r.status).toBe(404);
      }
    }
  });
});

describe('lobby over REST (validation tables)', () => {
  it.each([
    ['nickname missing', { mapId: 'test', phases: 2 }],
    ['nickname empty', { nickname: '', mapId: 'test' }],
    ['nickname blank', { nickname: '   ', mapId: 'test' }],
    ['nickname 25 chars', { nickname: 'x'.repeat(25), mapId: 'test' }],
    ['nickname not text', { nickname: 7, mapId: 'test' }],
    ['unknown map', { nickname: 'a', mapId: 'atlantis' }],
    ['prototype-polluting map id', { nickname: 'a', mapId: '__proto__' }],
    ['constructor as map id', { nickname: 'a', mapId: 'constructor' }],
    ['phases 0', { nickname: 'a', mapId: 'test', phases: 0 }],
    ['phases 4 (no grouping)', { nickname: 'a', mapId: 'test', phases: 4 }],
    ['phases 6', { nickname: 'a', mapId: 'test', phases: 6 }],
    ['phases -1', { nickname: 'a', mapId: 'test', phases: -1 }],
    ['phases 1.5', { nickname: 'a', mapId: 'test', phases: 1.5 }],
    ['phases "2"', { nickname: 'a', mapId: 'test', phases: '2' }],
    ['phases null', { nickname: 'a', mapId: 'test', phases: null }],
  ])('create: %s -> 400 BAD_REQUEST', async (_label, body) => {
    const { call } = await world();
    const r = await call('POST', '/games', body);
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe('BAD_REQUEST');
  });

  it('create: nickname is trimmed/collapsed, control characters become spaces, 24 chars is the maximum', async () => {
    const { call, c } = await world();
    const r = await call('POST', '/games', { nickname: '  A\u0000\tB   C  ', mapId: 'test' });
    expect(r.status).toBe(200);
    const body = r.body as { gameId: string; playerId: string };
    expect((await c.repo.getPlayer(body.gameId, body.playerId))!.nickname).toBe('A B C');
    expect((await call('POST', '/games', { nickname: 'y'.repeat(24), mapId: 'test' })).status).toBe(200);
  });

  it('create: mapId missing or not a string falls back to the default map (unknown in this test registry -> 400)', async () => {
    const { call } = await world();
    const r = await call('POST', '/games', { nickname: 'a' });
    expect(r.status).toBe(400); // DEFAULT_MAP_ID is world-500, which this test provider does not serve
    expect((r.body as { message: string }).message).toContain('world-500');
  });

  it('create: phases default to the config default when omitted', async () => {
    const { call, c } = await world();
    const r = await call('POST', '/games', { nickname: 'a', mapId: 'test' });
    expect((await c.repo.getGame((r.body as { gameId: string }).gameId))!.phases).toBe(c.cfg.phases.default);
  });

  it('create: returns a 6-character join code from the unambiguous alphabet, ids and a token', async () => {
    const { call } = await world();
    const r = (await call('POST', '/games', { nickname: 'a', mapId: 'test' })).body as { joinCode: string; token: string; gameId: string; playerId: string };
    expect(r.joinCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(r.token.length).toBeGreaterThanOrEqual(32);
    expect(r.gameId).toBeTruthy();
    expect(r.playerId).toBeTruthy();
  });

  it('join: code is case-insensitive and trimmed; the new player is pending', async () => {
    const { call, g, c } = await world();
    const r = await call('POST', '/games/join', { joinCode: `  ${g.joinCode.toLowerCase()} `, nickname: 'Zed' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ gameId: g.gameId, status: 'pending' });
    expect((await c.repo.getPlayer(g.gameId, (r.body as { playerId: string }).playerId))!.status).toBe('pending');
  });

  it.each([
    ['no code', { nickname: 'a' }, 404], ['empty code', { joinCode: '', nickname: 'a' }, 404], ['numeric code', { joinCode: 123456, nickname: 'a' }, 404],
    ['unknown code', { joinCode: 'ABCDEF', nickname: 'a' }, 404], ['no nickname', { joinCode: 'ABCDEF' }, 400], ['long nickname', { joinCode: 'ABCDEF', nickname: 'z'.repeat(25) }, 400],
  ])('join: %s', async (_label, body, status) => {
    const { call } = await world();
    expect((await call('POST', '/games/join', body)).status).toBe(status);
  });

  it('join: kind must be human or agent', async () => {
    const { call, g } = await world();
    for (const kind of ['robot', 1, null, '']) {
      expect((await call('POST', '/games/join', { joinCode: g.joinCode, nickname: 'k', kind })).status, String(kind)).toBe(400);
    }
    for (const kind of ['human', 'agent', undefined]) {
      expect((await call('POST', '/games/join', { joinCode: g.joinCode, nickname: 'k', kind })).status, String(kind)).toBe(200);
    }
  });

  it('settings: phases validated; start needs everything', async () => {
    const { call, g, players } = await world(2);
    const bad = async (phases: unknown) => (await call('POST', `/games/${g.gameId}/settings`, { phases }, g.token)).status;
    expect(await bad(0)).toBe(400);
    expect(await bad(4)).toBe(400);
    expect(await bad('3')).toBe(400);
    expect(await bad(undefined)).toBe(400);
    expect(await bad(3)).toBe(200);
    expect(((await call('GET', `/games/${g.gameId}`, undefined, g.token)).body as { phases: number }).phases).toBe(3);
    // not enough active players
    expect((await call('POST', `/games/${g.gameId}/start`, undefined, g.token)).status).toBe(409);
    for (const p of players) await call('POST', `/games/${g.gameId}/admit`, { playerId: p.playerId, admit: true }, g.token);
    // active but without parties
    const r = await call('POST', `/games/${g.gameId}/start`, undefined, g.token);
    expect(r.status).toBe(400);
    expect((r.body as { message: string }).message).toContain('Admin');
  });

  it('admission: boolean only; closing it makes join fail with ADMISSION_CLOSED', async () => {
    const { call, g } = await world();
    for (const open of ['yes', 1, null, undefined]) expect((await call('POST', `/games/${g.gameId}/admission`, { open }, g.token)).status).toBe(400);
    expect((await call('POST', `/games/${g.gameId}/admission`, { open: false }, g.token)).status).toBe(200);
    const r = await call('POST', '/games/join', { joinCode: g.joinCode, nickname: 'late' });
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toBe('ADMISSION_CLOSED');
    expect((await call('POST', `/games/${g.gameId}/admission`, { open: true }, g.token)).status).toBe(200);
    expect((await call('POST', '/games/join', { joinCode: g.joinCode, nickname: 'late' })).status).toBe(200);
  });

  it('the full lobby flow over REST ends with a started game and a timeline', async () => {
    const { call, g, players } = await world(2);
    for (const p of players) await call('POST', `/games/${g.gameId}/admit`, { playerId: p.playerId, admit: true }, g.token);
    expect((await call('POST', `/games/${g.gameId}/party`, party(0), g.token)).status).toBe(200);
    expect((await call('POST', `/games/${g.gameId}/party`, party(1), players[0].token)).status).toBe(200);
    expect((await call('POST', `/games/${g.gameId}/party`, party(2), players[1].token)).status).toBe(200);
    const r = await call('POST', `/games/${g.gameId}/start`, undefined, g.token);
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean; timeline: { phaseCloses: number[] } }).ok).toBe(true);
    expect((r.body as { timeline: { phaseCloses: number[] } }).timeline.phaseCloses).toHaveLength(2);
    const lobby = (await call('GET', `/games/${g.gameId}`, undefined, g.token)).body as { status: string; admissionOpen: boolean };
    expect(lobby.status).toBe('campaign');
    expect(lobby.admissionOpen).toBe(false);
    // starting twice
    expect((await call('POST', `/games/${g.gameId}/start`, undefined, g.token)).status).toBe(409);
  });
});

describe('play again over REST (POST /games/{id}/rematch)', () => {
  it('admin of a finished game: 200 {gameId, joinCode}; the old lobby links to it; the same token works there; a repeat returns the same game', async () => {
    const c = await new Ctx().started(3, 2);
    await driveTo(c, 'finished');
    const call = api(c);
    const r = await call('POST', `/games/${c.gameId}/rematch`, { phases: 3 }, c.p[0].token);
    expect(r.status).toBe(200);
    const body = r.body as { gameId: string; joinCode: string };
    expect(Object.keys(body).sort()).toEqual(['gameId', 'joinCode']);
    expect(body.gameId).not.toBe(c.gameId);
    const old = (await call('GET', `/games/${c.gameId}`, undefined, c.p[1].token)).body as { status: string; nextGameId?: string; nextJoinCode?: string };
    expect(old).toMatchObject({ status: 'finished', nextGameId: body.gameId, nextJoinCode: body.joinCode });
    const next = await call('GET', `/games/${encodeURIComponent(body.gameId)}`, undefined, c.p[1].token);
    expect(next.status).toBe(200);
    expect(next.body).toMatchObject({ gameId: body.gameId, joinCode: body.joinCode, status: 'campaign', phases: 3, admissionOpen: false, you: c.p[1].playerId });
    expect((await call('POST', `/games/${c.gameId}/rematch`, { phases: 1 }, c.p[0].token)).body).toEqual(body);
    // the server never hands out a token: the body has no token and the new game does not accept a made-up one
    expect((await call('GET', `/games/${body.gameId}`, undefined, 'nope')).status).toBe(401);
  });

  it('status codes: 400 bad phases / body, 401 no token, 403 non-admin, 404 unknown game, 409 not finished or too few players', async () => {
    const c = await new Ctx().started(2, 2);
    const call = api(c);
    const path = `/games/${c.gameId}/rematch`;
    const err = (r: RestResponse) => [r.status, (r.body as { error?: string }).error];
    expect(err(await call('POST', path, { phases: 2 }, c.p[0].token))).toEqual([409, 'WRONG_PHASE']); // campaign
    await driveTo(c, 'finished');
    expect(err(await call('POST', path, { phases: 2 }))).toEqual([401, 'UNAUTHORIZED']);
    expect(err(await call('POST', path, { phases: 2 }, c.p[1].token))).toEqual([403, 'FORBIDDEN']);
    expect(err(await call('POST', '/games/nope/rematch', { phases: 2 }, c.p[0].token))).toEqual([404, 'NOT_FOUND']);
    for (const body of [{}, { phases: 0 }, { phases: 4 }, { phases: '2' }, 'not json', '[]']) {
      expect(err(await call('POST', path, body, c.p[0].token)), JSON.stringify(body)).toEqual([400, 'BAD_REQUEST']);
    }
    c.cfg = { ...c.cfg, players: { ...c.cfg.players, min: 3 } };
    expect(err(await call('POST', path, { phases: 2 }, c.p[0].token))).toEqual([409, 'NOT_ENOUGH_PLAYERS']);
    expect((await call('GET', path, undefined, c.p[0].token)).status).toBe(404);
  });
});

describe('each ErrorCode has a reachable path and its HTTP status', () => {
  const restCode = (r: RestResponse): ErrorCode => (r.body as { error: ErrorCode }).error;
  const ws = async (c: Ctx, i: number, msg: ClientMessage): Promise<ErrorCode | undefined> => {
    await c.send(i, msg);
    return c.lastError(i)?.error;
  };

  const cases: Record<ErrorCode, () => Promise<ErrorCode | undefined>> = {
    BAD_REQUEST: async () => restCode(await (await world()).call('POST', '/games', {})),
    UNAUTHORIZED: async () => { const w = await world(); return restCode(await w.call('GET', `/games/${w.g.gameId}`)); },
    FORBIDDEN: async () => { const w = await world(1); return restCode(await w.call('POST', `/games/${w.g.gameId}/start`, undefined, w.players[0].token)); },
    NOT_FOUND: async () => restCode(await (await world()).call('GET', '/games/none', undefined, 'x')),
    GAME_FULL: async () => {
      const c = await new Ctx().lobby(10);
      return c.svc.joinGame({ joinCode: c.joinCode, nickname: 'eleven' }).then(() => undefined, (e: GameError) => e.code);
    },
    ADMISSION_CLOSED: async () => {
      const c = await new Ctx().lobby(2);
      await c.svc.setAdmission(c.gameId, c.p[0].token, { open: false });
      return c.svc.joinGame({ joinCode: c.joinCode, nickname: 'x' }).then(() => undefined, (e: GameError) => e.code);
    },
    NAME_TAKEN: async () => partyClash({ name: 'party 0' }),
    COLOUR_TAKEN: async () => partyClash({ colour: PARTY_COLOURS[0].hex.toLowerCase() }),
    SYMBOL_TAKEN: async () => partyClash({ symbol: PARTY_SYMBOLS[0].id }),
    AVATAR_TAKEN: async () => partyClash({ avatar: AVATARS[0].id }),
    WRONG_PHASE: async () => { const c = await new Ctx().started(2, 1); return c.svc.setSettings(c.gameId, c.p[0].token, { phases: 1 }).then(() => undefined, (e: GameError) => e.code); },
    INSUFFICIENT_FUNDS: async () => { const c = await new Ctx().started(2, 1); await c.repo.updatePlayer(c.gameId, c.p[1].playerId, { budget: 1 }); return ws(c, 1, { action: 'campaign', type: 'rally', seat: 1 }); },
    SEAT_POLLED: async () => { const c = await new Ctx().started(2, 3); c.clock.set(c.timeline.phaseCloses[0]); return ws(c, 1, { action: 'campaign', type: 'rally', seat: 1 }); },
    TOO_LATE: async () => { const c = await new Ctx().started(2, 1); c.clock.set(c.timeline.campaignEnd); return ws(c, 1, { action: 'campaign', type: 'rally', seat: 1 }); },
    RATE_LIMITED: async () => {
      const c = await new Ctx().started(2, 1);
      await c.send(1, { action: 'campaign', type: 'rally', seat: 1 });
      c.clock.advance(c.cfg.cooldowns.rallyMs - 1);
      return ws(c, 1, { action: 'campaign', type: 'rally', seat: 2 }); // second rally inside cooldowns.rallyMs
    },
    INVALID_GOVERNMENT: async () => { const c = await new Ctx().started(3, 1); await driveTo(c, 'counting'); return ws(c, 0, { action: 'proposeGovernment', portfolios: { PM: [c.p[1].playerId] } }); },
    OFFER_NOT_FOUND: async () => { const c = await new Ctx().started(3, 1); await driveTo(c, 'counting'); return ws(c, 1, { action: 'respondOffer', offerId: 'nope', accept: true }); },
    ALREADY_COMMITTED: async () => {
      // a formed government ends the game at once (later requests get WRONG_PHASE): this is the short window in between
      const c = await new Ctx().started(3, 1);
      await driveTo(c, 'postCounting');
      await c.repo.putGovernmentIfAbsent(c.gameId, majorityGovernment(c.p[0].playerId, c.cfg, c.clock.now()));
      return ws(c, 1, { action: 'proposeGovernment', portfolios: { PM: [c.p[1].playerId] } });
    },
    NOT_ENOUGH_PLAYERS: async () => { const c = await new Ctx().lobby(1); return c.svc.start(c.gameId, c.p[0].token).then(() => undefined, (e: GameError) => e.code); },
    NEGOTIATION_DISABLED: async () => { const c = await new Ctx().started(2, 1); await driveTo(c, 'counting'); return ws(c, 0, { action: 'chat', to: [c.p[1].playerId], text: 'hi' }); },
    INTERNAL: async () => {
      const c = new Ctx();
      const boom = new GameService({ ...(c.svc as unknown as { d: ConstructorParameters<typeof GameService>[0] }).d, repo: new Proxy(c.repo, { get: () => () => { throw new Error('db down'); } }) });
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const r = await handleRest(boom, { method: 'POST', path: '/games', headers: {}, body: JSON.stringify({ nickname: 'a', mapId: 'test' }) });
        expect(r.status).toBe(500);
        expect(r.body).toEqual({ error: 'INTERNAL', message: 'Internal error' }); // no leaking of the underlying error text
        return (r.body as { error: ErrorCode }).error;
      } finally { spy.mockRestore(); }
    },
  };

  async function partyClash(over: Record<string, unknown>): Promise<ErrorCode | undefined> {
    const c = await new Ctx().lobby(2);
    const p1 = c.p[1];
    const base = { name: 'Other Party', colour: PARTY_COLOURS[5].id, symbol: PARTY_SYMBOLS[5].id, avatar: AVATARS[5].id };
    return c.svc.setParty(c.gameId, p1.token, { party: { ...base, ...over } as never }).then(() => undefined, (e: GameError) => e.code);
  }

  for (const [code, run] of Object.entries(cases) as [ErrorCode, () => Promise<ErrorCode | undefined>][]) {
    it(`${code} (HTTP ${HTTP_STATUS[code]})`, async () => {
      const got = await run();
      expect(got).toBe(code);
    });
  }

  it('RATE_LIMITED (HTTP 429) carries retryAt over REST too when a GameError has one', async () => {
    expect(HTTP_STATUS.RATE_LIMITED).toBe(429);
    const svc = { createGame: async () => { throw new GameError('RATE_LIMITED', 'Next rally in 5 s', 12_345); } } as unknown as GameService;
    const r = await handleRest(svc, { method: 'POST', path: '/games', headers: {}, body: '{}' });
    expect(r).toEqual({ status: 429, body: { error: 'RATE_LIMITED', message: 'Next rally in 5 s', retryAt: 12_345 } });
    const plain = { createGame: async () => { throw new GameError('BAD_REQUEST', 'x'); } } as unknown as GameService;
    expect((await handleRest(plain, { method: 'POST', path: '/games', headers: {}, body: '{}' })).body).toEqual({ error: 'BAD_REQUEST', message: 'x' });
  });

  it('HTTP statuses: 4xx for client errors, 409 for state conflicts, 422 for invalid government, 500 only for INTERNAL', () => {
    const expected: Record<ErrorCode, number> = {
      BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, GAME_FULL: 409, ADMISSION_CLOSED: 409, NAME_TAKEN: 409,
      COLOUR_TAKEN: 409, SYMBOL_TAKEN: 409, AVATAR_TAKEN: 409, WRONG_PHASE: 409, INSUFFICIENT_FUNDS: 409, SEAT_POLLED: 409, TOO_LATE: 409,
      RATE_LIMITED: 429, INVALID_GOVERNMENT: 422, OFFER_NOT_FOUND: 404, ALREADY_COMMITTED: 409, NOT_ENOUGH_PLAYERS: 409, INTERNAL: 500,
      NEGOTIATION_DISABLED: 409,
    };
    expect(HTTP_STATUS).toEqual(expected);
  });

  it('a join code that cannot be allocated is an INTERNAL error, not a crash', async () => {
    const c = new Ctx();
    c.repo.findGameByCode = async () => ({ gameId: 'g' } as never); // every code "exists"
    await expect(c.svc.createGame({ nickname: 'a', mapId: 'test', phases: 1 })).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
