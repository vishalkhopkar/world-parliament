import { afterEach, describe, expect, it } from 'vitest';
import { MockTransport } from '../mock';
import { ApiException } from '../transport';

let t: MockTransport;
afterEach(() => t?.disconnect());

async function lobbyOf(t: MockTransport, mapId = 'world-500') {
  const r = await t.createGame({ nickname: 'Vishal', mapId, phases: 2 });
  return { r, lobby: await t.getLobby(r.gameId, r.token) };
}

describe('mock transport peekSeat', () => {
  it('refuses before counting has started and replies with an error, not shares', async () => {
    t = new MockTransport();
    const { r } = await lobbyOf(t);
    const got: { type: string; error?: string }[] = [];
    t.connect(r.gameId, r.token, m => got.push(m as never));
    t.send({ action: 'peekSeat', seat: 1 });
    await new Promise(res => setTimeout(res, 100)); // the mock delivers messages after ~20 ms
    expect(got.filter(m => m.type === 'seatShares')).toHaveLength(0);
    expect(got.find(m => m.type === 'error')?.error).toBe('WRONG_PHASE');
  });
});

describe('mock transport avatars / AI / map', () => {
  it('bots have avatars and one bot is an AI agent', async () => {
    t = new MockTransport();
    const { lobby } = await lobbyOf(t);
    const bots = lobby.players.filter(p => p.nickname !== 'Vishal');
    expect(bots.length).toBeGreaterThanOrEqual(2);
    expect(bots.filter(b => b.kind === 'agent')).toHaveLength(1);
    const active = bots.filter(b => b.status === 'active');
    expect(active.every(b => !!b.party?.avatar)).toBe(true);
  });

  it('uses the mapId of the request for the game', async () => {
    t = new MockTransport();
    const { lobby } = await lobbyOf(t, 'world-500');
    expect(lobby.mapId).toBe('world-500');
  });

  it('rejects an unknown map', async () => {
    t = new MockTransport();
    await expect(t.createGame({ nickname: 'V', mapId: 'atlantis', phases: 2 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects an unknown avatar with BAD_REQUEST and a taken avatar with AVATAR_TAKEN', async () => {
    t = new MockTransport();
    const { r, lobby } = await lobbyOf(t);
    const takenAvatar = lobby.players.find(p => p.party?.avatar)!.party!.avatar!;
    const base = { name: 'My Party', colour: '#C0182F', symbol: 'torch' };
    await expect(t.setParty(r.gameId, r.token, { party: { ...base, avatar: 'nobody' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const err = await t.setParty(r.gameId, r.token, { party: { ...base, avatar: takenAvatar } }).catch(e => e);
    expect(err).toBeInstanceOf(ApiException);
    expect(err.code).toBe('AVATAR_TAKEN');
    await expect(t.setParty(r.gameId, r.token, { party: { ...base, avatar: 'putin' } })).resolves.toBeUndefined();
    const after = await t.getLobby(r.gameId, r.token);
    expect(after.players.find(p => p.playerId === r.playerId)?.party?.avatar).toBe('putin');
  });

  it('start requires every active player to have an avatar', async () => {
    t = new MockTransport();
    const { r } = await lobbyOf(t);
    await t.setParty(r.gameId, r.token, { party: { name: 'No Avatar', colour: '#C0182F', symbol: 'torch' } });
    await expect(t.start(r.gameId, r.token)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
