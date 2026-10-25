import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from '../transport';

const SAVED = { gameId: 'g1', playerId: 'p1', token: 't', joinCode: 'HP1234' };

async function load(search: string) {
  vi.resetModules();
  window.history.replaceState({}, '', '/' + search);
  const client = await import('../client');
  const getLobby = vi.fn(async () => ({ gameId: 'g1', joinCode: 'HP1234', status: 'lobby', players: [{ playerId: 'p1', status: 'active' }] }));
  client.setTransport({ getLobby, connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() } as unknown as Transport);
  return { client, getLobby };
}

beforeEach(() => localStorage.setItem('hp.session', JSON.stringify(SAVED)));
afterEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/'); });

describe('resumeSession with an invite link', () => {
  it('does not resume the old game when the link is for a different game, and keeps the saved session', async () => {
    const { client, getLobby } = await load('?server=https://api.test&join=ZZ9999');
    expect(await client.resumeSession()).toBe(false);
    expect(getLobby).not.toHaveBeenCalled();
    expect(localStorage.getItem('hp.session')).not.toBeNull();
  });

  it('resumes when the link is for the game the player is already in', async () => {
    const { client } = await load('?server=https://api.test&join=hp1234');
    expect(await client.resumeSession()).toBe(true);
  });

  it('resumes as usual without a link', async () => {
    const { client } = await load('?server=https://api.test');
    expect(await client.resumeSession()).toBe(true);
  });
});
