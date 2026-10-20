import { describe, expect, it } from 'vitest';
import { Ctx } from './helpers';
import { GameError } from '../src/core/types';

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) { return e instanceof GameError ? e.code : `ERR:${String(e)}`; }
}

describe('lobby', () => {
  it('create, join (pending), admit, party, start', async () => {
    const c = new Ctx();
    await c.lobby(3);
    const view = await c.svc.getLobby(c.gameId, c.p[0].token);
    expect(view.players).toHaveLength(3);
    expect(view.players.every((p) => p.status === 'active' && p.party)).toBe(true);
    expect(view.phases).toBe(3);
    const r = await c.svc.start(c.gameId, c.p[0].token);
    expect(r.timeline.phaseCloses).toHaveLength(3);
    expect(c.scheduler.lifecycles).toHaveLength(1);
    expect((await c.game()).status).toBe('campaign');
    // budgets set
    expect(await c.budget(1)).toBe(c.cfg.budget);
  });

  it('only the admin can admit, start, change settings or close admission', async () => {
    const c = new Ctx();
    await c.lobby(2);
    const j = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'X' });
    expect(await code(c.svc.admit(c.gameId, c.p[1].token, { playerId: j.playerId, admit: true }))).toBe('FORBIDDEN');
    expect(await code(c.svc.start(c.gameId, c.p[1].token))).toBe('FORBIDDEN');
    expect(await code(c.svc.setSettings(c.gameId, c.p[1].token, { phases: 2 }))).toBe('FORBIDDEN');
    expect(await code(c.svc.setAdmission(c.gameId, c.p[1].token, { open: false }))).toBe('FORBIDDEN');
    expect(await code(c.svc.admit(c.gameId, c.p[0].token, { playerId: j.playerId, admit: true }))).toBe('OK');
    expect(await code(c.svc.setSettings(c.gameId, c.p[0].token, { phases: 2 }))).toBe('OK');
    expect(await code(c.svc.setSettings(c.gameId, c.p[0].token, { phases: 9 }))).toBe('BAD_REQUEST');
  });

  it('rejects bad tokens and unknown games', async () => {
    const c = new Ctx();
    await c.lobby(2);
    expect(await code(c.svc.getLobby(c.gameId, 'nope'))).toBe('UNAUTHORIZED');
    expect(await code(c.svc.getLobby(c.gameId, undefined))).toBe('UNAUTHORIZED');
    expect(await code(c.svc.getLobby('missing', c.p[0].token))).toBe('NOT_FOUND');
    expect(await code(c.svc.joinGame({ joinCode: 'ZZZZZZ', nickname: 'a' }))).toBe('NOT_FOUND');
  });

  it('party name, colour and symbol must be unique', async () => {
    const c = new Ctx();
    await c.lobby(3);
    const t = c.p[2].token;
    expect(await code(c.svc.setParty(c.gameId, t, { party: { name: ' party 0 ', colour: 'teal', symbol: 'rocket' } }))).toBe('NAME_TAKEN');
    expect(await code(c.svc.setParty(c.gameId, t, { party: { name: 'New', colour: 'saffron', symbol: 'rocket' } }))).toBe('COLOUR_TAKEN');
    expect(await code(c.svc.setParty(c.gameId, t, { party: { name: 'New', colour: 'teal', symbol: 'anchor' } }))).toBe('SYMBOL_TAKEN');
    expect(await code(c.svc.setParty(c.gameId, t, { party: { name: 'New', colour: 'nonsense', symbol: 'rocket' } }))).toBe('BAD_REQUEST');
    expect(await code(c.svc.setParty(c.gameId, t, { party: { name: 'New', colour: 'teal', symbol: 'rocket' } }))).toBe('OK');
    // a player may re-submit their own identity
    expect(await code(c.svc.setParty(c.gameId, t, { party: { name: 'New', colour: 'teal', symbol: 'rocket' } }))).toBe('OK');
  });

  it('enforces max players and admission closed', async () => {
    const c = new Ctx();
    await c.lobby(10);
    expect(await code(c.svc.joinGame({ joinCode: c.joinCode, nickname: 'late' }))).toBe('GAME_FULL');
    const c2 = new Ctx();
    await c2.lobby(2);
    await c2.svc.setAdmission(c2.gameId, c2.p[0].token, { open: false });
    expect(await code(c2.svc.joinGame({ joinCode: c2.joinCode, nickname: 'late' }))).toBe('ADMISSION_CLOSED');
    await c2.svc.setAdmission(c2.gameId, c2.p[0].token, { open: true });
    expect(await code(c2.svc.joinGame({ joinCode: c2.joinCode, nickname: 'late' }))).toBe('OK');
  });

  it('start needs >= 2 active players, all with parties; denied players are out', async () => {
    const c = new Ctx();
    const g = await c.svc.createGame({ nickname: 'solo', mapId: 'test', phases: 1 });
    expect(await code(c.svc.start(g.gameId, g.token))).toBe('NOT_ENOUGH_PLAYERS');
    const j = await c.svc.joinGame({ joinCode: g.joinCode, nickname: 'b' });
    expect(await code(c.svc.start(g.gameId, g.token))).toBe('NOT_ENOUGH_PLAYERS'); // pending does not count
    await c.svc.admit(g.gameId, g.token, { playerId: j.playerId, admit: true });
    expect(await code(c.svc.start(g.gameId, g.token))).toBe('BAD_REQUEST'); // no parties
    await c.svc.setParty(g.gameId, g.token, { party: { name: 'Alpha', colour: 'blue', symbol: 'key', avatar: 'kim' } });
    await c.svc.setParty(g.gameId, j.token, { party: { name: 'Beta', colour: 'green', symbol: 'leaf', avatar: 'xi' } });
    const denied = await c.svc.joinGame({ joinCode: g.joinCode, nickname: 'd' });
    await c.svc.admit(g.gameId, g.token, { playerId: denied.playerId, admit: false });
    expect(await code(c.svc.start(g.gameId, g.token))).toBe('OK');
    expect(await code(c.svc.start(g.gameId, g.token))).toBe('WRONG_PHASE');
    expect(await code(c.svc.joinGame({ joinCode: g.joinCode, nickname: 'z' }))).toBe('ADMISSION_CLOSED');
  });

  it('non-admin sees only active players; admin also sees pending', async () => {
    const c = new Ctx();
    await c.lobby(2);
    const j = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'pend' });
    expect((await c.svc.getLobby(c.gameId, c.p[0].token)).players.map((p) => p.status)).toContain('pending');
    expect((await c.svc.getLobby(c.gameId, c.p[1].token)).players.map((p) => p.status)).not.toContain('pending');
    const mine = await c.svc.getLobby(c.gameId, j.token);
    expect(mine.you).toBe(j.playerId);
    expect(mine.players.find((p) => p.playerId === j.playerId)?.status).toBe('pending');
  });

  it('stores only the token hash', async () => {
    const c = new Ctx();
    await c.lobby(2);
    const p = (await c.repo.listPlayers(c.gameId))[0];
    expect(p.tokenHash).not.toBe(c.p[0].token);
    expect(p.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(p)).not.toContain(c.p[0].token);
  });

  it('stores party colours as canonical hex', async () => {
    const c = new Ctx();
    await c.lobby(2);
    const lobby = await c.svc.getLobby(c.gameId, c.p[0].token);
    expect(lobby.players[0].party!.colour).toMatch(/^#[0-9A-F]{6}$/);
    expect(await code(c.svc.setParty(c.gameId, c.p[1].token, { party: { name: 'Lower', colour: lobby.players[0].party!.colour.toLowerCase(), symbol: 'rocket' } }))).toBe('COLOUR_TAKEN');
  });

  it('pending players can connect and get lobby-level messages; rejected ones are disconnected', async () => {
    const c = new Ctx();
    await c.lobby(2);
    const j = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'pend' });
    await c.svc.connect(c.gameId, j.token, 'cp');
    await c.svc.connect(c.gameId, c.p[0].token, 'c0');
    await c.svc.handleMessage('cp', { action: 'ping', clientTime: 1 });
    const hello = c.notifier.to(j.playerId, 'hello')[0] as any;
    expect(hello.snapshot.news).toEqual([]);
    expect(hello.private.budget).toBe(0);
    expect(hello.snapshot.players.map((p: any) => p.playerId)).toContain(j.playerId);
    // game actions are refused
    await c.svc.handleMessage('cp', { action: 'campaign', type: 'rally', seat: 1 });
    expect((c.notifier.to(j.playerId, 'error').pop() as any).error).toBe('FORBIDDEN');
    // admin hears about a new request
    c.notifier.clear();
    const j2 = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'pend2' });
    const adminList = (c.notifier.to(c.p[0].playerId, 'players').pop() as any).players;
    expect(adminList.map((p: any) => p.playerId)).toContain(j2.playerId);
    // admitting notifies the applicant; denying disconnects them
    c.notifier.clear();
    await c.svc.admit(c.gameId, c.p[0].token, { playerId: j.playerId, admit: true });
    expect((c.notifier.to(j.playerId, 'players').pop() as any).players.find((p: any) => p.playerId === j.playerId).status).toBe('active');
    await c.svc.connect(c.gameId, j2.token, 'cp2');
    await c.svc.admit(c.gameId, c.p[0].token, { playerId: j2.playerId, admit: false });
    expect(c.notifier.closed).toContain('cp2');
    await expect(c.svc.connect(c.gameId, j2.token, 'cp3')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('start sends each connected player a private state with their new budget', async () => {
    const c = new Ctx();
    await c.lobby(2);
    await c.svc.connect(c.gameId, c.p[0].token, 'c0');
    await c.svc.connect(c.gameId, c.p[1].token, 'c1');
    c.notifier.clear();
    await c.svc.start(c.gameId, c.p[0].token);
    for (const p of c.p) {
      const priv = c.notifier.to(p.playerId, 'private') as any[];
      expect(priv).toHaveLength(1);
      expect(priv[0].private.you).toBe(p.playerId);
      expect(priv[0].private.budget).toBe(c.cfg.budget);
    }
  });
});
