import { describe, expect, it } from 'vitest';
import { Ctx } from './helpers';
import { GameError } from '../src/core/types';

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) { return e instanceof GameError ? e.code : `ERR:${String(e)}`; }
}

describe('player kind (human | agent)', () => {
  it('defaults to human; kind "agent" is stored and exposed in PlayerPublic', async () => {
    const c = new Ctx();
    const g = await c.svc.createGame({ nickname: 'Host', mapId: 'test', phases: 2 });
    const h = await c.svc.joinGame({ joinCode: g.joinCode, nickname: 'Human2' });
    const a = await c.svc.joinGame({ joinCode: g.joinCode, nickname: 'Bot', kind: 'agent' });
    const explicitHuman = await c.svc.joinGame({ joinCode: g.joinCode, nickname: 'Human3', kind: 'human' });
    for (const j of [h, a, explicitHuman]) await c.svc.admit(g.gameId, g.token, { playerId: j.playerId, admit: true });
    const view = await c.svc.getLobby(g.gameId, g.token);
    const kind = (name: string) => view.players.find((p) => p.nickname === name)?.kind;
    expect(kind('Host')).toBe('human');
    expect(kind('Human2')).toBe('human');
    expect(kind('Human3')).toBe('human');
    expect(kind('Bot')).toBe('agent');
    // the agent sees the same thing, and so does the snapshot in hello
    const botView = await c.svc.getLobby(g.gameId, a.token);
    expect(botView.players.find((p) => p.nickname === 'Bot')?.kind).toBe('agent');
  });

  it('rejects an invalid kind on join', async () => {
    const c = new Ctx();
    const g = await c.svc.createGame({ nickname: 'Host', mapId: 'test', phases: 2 });
    expect(await code(c.svc.joinGame({ joinCode: g.joinCode, nickname: 'X', kind: 'robot' as never }))).toBe('BAD_REQUEST');
  });

  it('an agent cannot create a game (CreateGameRequest with kind:"agent" -> FORBIDDEN)', async () => {
    const c = new Ctx();
    expect(await code(c.svc.createGame({ nickname: 'Bot', mapId: 'test', phases: 2, kind: 'agent' } as never))).toBe('FORBIDDEN');
    expect(await code(c.svc.createGame({ nickname: 'Human', mapId: 'test', phases: 2, kind: 'human' } as never))).toBe('OK');
    expect(await code(c.svc.createGame({ nickname: 'Human', mapId: 'test', phases: 2 }))).toBe('OK');
  });

  it('kind is visible in the hello snapshot and in broadcast player lists', async () => {
    const c = new Ctx();
    await c.lobby(2);
    const j = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'Bot', kind: 'agent' });
    await c.svc.admit(c.gameId, c.p[0].token, { playerId: j.playerId, admit: true });
    await c.svc.setParty(c.gameId, j.token, { party: { name: 'Robots', colour: 'teal', symbol: 'rocket' } });
    await c.svc.connect(c.gameId, c.p[0].token, 'c0');
    const rec = await c.repo.getPlayer(c.gameId, c.p[0].playerId);
    const hello = await c.svc.hello(rec!);
    expect(hello.type).toBe('hello');
    if (hello.type === 'hello') expect(hello.snapshot.players.find((p) => p.nickname === 'Bot')?.kind).toBe('agent');
  });
});
