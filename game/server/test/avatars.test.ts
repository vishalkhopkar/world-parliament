import { describe, expect, it } from 'vitest';
import { AVATARS } from '@hp/shared';
import { Ctx } from './helpers';
import { GameError, HTTP_STATUS } from '../src/core/types';

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) { return e instanceof GameError ? e.code : `ERR:${String(e)}`; }
}

describe('party avatars', () => {
  it('AVATAR_TAKEN is a 409', () => {
    expect(HTTP_STATUS.AVATAR_TAKEN).toBe(409);
  });

  it('an avatar must be a known id and is stored on the party', async () => {
    const c = new Ctx();
    await c.lobby(2);
    const t = c.p[1].token;
    const base = { name: 'Fresh', colour: 'teal', symbol: 'rocket' };
    expect(await code(c.svc.setParty(c.gameId, t, { party: { ...base, avatar: 'nobody-at-all' } }))).toBe('BAD_REQUEST');
    expect(await code(c.svc.setParty(c.gameId, t, { party: { ...base, avatar: AVATARS[5].id } }))).toBe('OK');
    const view = await c.svc.getLobby(c.gameId, t);
    expect(view.players.find((p) => p.playerId === c.p[1].playerId)?.party?.avatar).toBe(AVATARS[5].id);
  });

  it('avatars are unique within a game, but a player may keep their own', async () => {
    const c = new Ctx();
    await c.lobby(2); // P0 has AVATARS[0], P1 has AVATARS[1]
    const t = c.p[1].token;
    const base = { name: 'Fresh', colour: 'teal', symbol: 'rocket' };
    expect(await code(c.svc.setParty(c.gameId, t, { party: { ...base, avatar: AVATARS[0].id } }))).toBe('AVATAR_TAKEN');
    expect(await code(c.svc.setParty(c.gameId, t, { party: { ...base, avatar: AVATARS[1].id } }))).toBe('OK'); // own avatar
  });

  it('the admin cannot start until every active player has a party WITH an avatar', async () => {
    const c = new Ctx();
    await c.lobby(2);
    await c.svc.setParty(c.gameId, c.p[1].token, { party: { name: 'Party 1', colour: 'blue', symbol: 'key' } }); // drops the avatar
    expect(await code(c.svc.start(c.gameId, c.p[0].token))).toBe('BAD_REQUEST');
    await c.svc.setParty(c.gameId, c.p[1].token, { party: { name: 'Party 1', colour: 'blue', symbol: 'key', avatar: AVATARS[1].id } });
    expect(await code(c.svc.start(c.gameId, c.p[0].token))).toBe('OK');
  });
});
