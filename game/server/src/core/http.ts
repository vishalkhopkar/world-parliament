// Transport-independent REST routing for the lobby, shared by the Lambda handler and the local dev server.
import type { GameService } from './gameService';
import { GameError, HTTP_STATUS } from './types';

export interface RestRequest {
  method: string;
  /** Path without query string, e.g. /games/abc/admit */
  path: string;
  headers: Record<string, string | undefined>; // lower-case keys
  body: string | undefined;
}
export interface RestResponse { status: number; body: unknown }

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-max-age': '3600',
};

function bearer(headers: Record<string, string | undefined>): string | undefined {
  const h = headers['authorization'];
  if (!h) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : undefined;
}

function parseBody(body: string | undefined): any {
  if (!body) return {};
  try {
    const v = JSON.parse(body);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new GameError('BAD_REQUEST', 'Body must be a JSON object');
  }
}

export async function handleRest(svc: GameService, req: RestRequest): Promise<RestResponse> {
  try {
    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') return { status: 204, body: undefined };
    const parts = req.path.split('/').filter(Boolean);
    const token = bearer(req.headers);
    if (parts[0] !== 'games') throw new GameError('NOT_FOUND', 'Not found');
    if (method === 'POST' && parts.length === 1) return { status: 200, body: await svc.createGame(parseBody(req.body)) };
    if (method === 'POST' && parts.length === 2 && parts[1] === 'join') return { status: 200, body: await svc.joinGame(parseBody(req.body)) };
    if (parts.length >= 2) {
      const gameId = decodeURIComponent(parts[1]);
      if (method === 'GET' && parts.length === 2) return { status: 200, body: await svc.getLobby(gameId, token) };
      if (method === 'POST' && parts.length === 3) {
        switch (parts[2]) {
          case 'admit': return { status: 200, body: await svc.admit(gameId, token, parseBody(req.body)) };
          case 'admission': return { status: 200, body: await svc.setAdmission(gameId, token, parseBody(req.body)) };
          case 'settings': return { status: 200, body: await svc.setSettings(gameId, token, parseBody(req.body)) };
          case 'party': return { status: 200, body: await svc.setParty(gameId, token, parseBody(req.body)) };
          case 'start': return { status: 200, body: await svc.start(gameId, token) };
        }
      }
    }
    throw new GameError('NOT_FOUND', 'Not found');
  } catch (e) {
    if (e instanceof GameError) {
      return { status: HTTP_STATUS[e.code], body: { error: e.code, message: e.message, ...(e.retryAt !== undefined ? { retryAt: e.retryAt } : {}) } };
    }
    console.error('REST handler failed', e);
    return { status: 500, body: { error: 'INTERNAL', message: 'Internal error' } };
  }
}
