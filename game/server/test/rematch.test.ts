// Play again (rematch): POST /games/{id}/rematch on a finished game creates a NEW game with every member rolled over
// (same playerId, token and party), started at once in the campaign phase. Only the number of phases can change.
import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@hp/shared';
import { GameError } from '../src/core/types';
import type { PlayerRecord } from '../src/core/types';
import { Ctx, driveTo } from './helpers';

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) { return e instanceof GameError ? e.code : `ERR:${String(e)}`; }
}

/** A finished n-player game (no majority, so the result is declared at the end of post-counting). */
async function finished(n = 3, phases = 2): Promise<Ctx> {
  const c = await new Ctx().started(n, phases);
  await driveTo(c, 'finished');
  expect((await c.game()).status).toBe('finished');
  return c;
}

const byId = (ps: PlayerRecord[]) => new Map(ps.map((p) => [p.playerId, p]));

describe('rematch: who and when', () => {
  it('admin only: any other member gets FORBIDDEN and nothing is created', async () => {
    const c = await finished(3);
    expect(await code(c.svc.rematch(c.gameId, c.p[1].token, { phases: 2 }))).toBe('FORBIDDEN');
    expect(await code(c.svc.rematch(c.gameId, c.p[2].token, { phases: 2 }))).toBe('FORBIDDEN');
    expect(await code(c.svc.rematch(c.gameId, 'not-a-token', { phases: 2 }))).toBe('UNAUTHORIZED');
    expect(await code(c.svc.rematch(c.gameId, undefined, { phases: 2 }))).toBe('UNAUTHORIZED');
    expect(await code(c.svc.rematch('missing', c.p[0].token, { phases: 2 }))).toBe('NOT_FOUND');
    expect((await c.game()).rematchGameId).toBeUndefined();
    expect(c.scheduler.lifecycles).toHaveLength(1);
  });

  it('only from a finished game: lobby, campaign, counting, postCounting and abandoned are WRONG_PHASE (admin) / FORBIDDEN (others)', async () => {
    const lobby = await new Ctx().lobby(3);
    expect(await code(lobby.svc.rematch(lobby.gameId, lobby.p[0].token, { phases: 2 }))).toBe('WRONG_PHASE');
    expect(await code(lobby.svc.rematch(lobby.gameId, lobby.p[1].token, { phases: 2 }))).toBe('FORBIDDEN');
    for (const status of ['campaign', 'counting', 'postCounting', 'abandoned'] as const) {
      const c = await new Ctx().started(3, 2);
      await driveTo(c, status);
      expect((await c.game()).status, status).toBe(status);
      expect(await code(c.svc.rematch(c.gameId, c.p[0].token, { phases: 2 })), status).toBe('WRONG_PHASE');
      expect(await code(c.svc.rematch(c.gameId, c.p[1].token, { phases: 2 })), status).toBe('FORBIDDEN');
      expect((await c.game()).rematchGameId, status).toBeUndefined();
      expect(c.scheduler.lifecycles, status).toHaveLength(1);
    }
  });

  it('a finished game without a stored result is WRONG_PHASE', async () => {
    const c = await new Ctx().started(3, 2);
    await c.repo.updateGame(c.gameId, { status: 'finished' });
    expect(await code(c.svc.rematch(c.gameId, c.p[0].token, { phases: 2 }))).toBe('WRONG_PHASE');
  });

  it('bad phases are BAD_REQUEST (same rule as create/settings)', async () => {
    const c = await finished(3);
    for (const phases of [0, 4, -1, 1.5, '2', null, undefined]) {
      expect(await code(c.svc.rematch(c.gameId, c.p[0].token, { phases } as never)), String(phases)).toBe('BAD_REQUEST');
    }
    expect(await code(c.svc.rematch(c.gameId, c.p[0].token, undefined as never))).toBe('BAD_REQUEST');
    expect((await c.game()).rematchGameId).toBeUndefined();
  });

  it('too few members for the map is NOT_ENOUGH_PLAYERS', async () => {
    const c = await finished(2);
    c.cfg = { ...c.cfg, players: { ...c.cfg.players, min: 3 } };
    expect(await code(c.svc.rematch(c.gameId, c.p[0].token, { phases: 2 }))).toBe('NOT_ENOUGH_PLAYERS');
    expect((await c.game()).rematchGameId).toBeUndefined();
  });
});

describe('rematch: the new game', () => {
  it('every member rolls over with the same id, token, nickname, kind, admin flag and party; pending/rejected are dropped', async () => {
    const c = new Ctx();
    await c.lobby(4, 2);
    // a pending request (rejected at the start) and a rejected one
    const pend = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'Late' });
    const rej = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'Nope', kind: 'agent' });
    await c.svc.admit(c.gameId, c.p[0].token, { playerId: rej.playerId, admit: false });
    await c.svc.start(c.gameId, c.p[0].token);
    for (const p of c.p) await c.svc.connect(c.gameId, p.token, p.conn);
    c.clock.set(c.timeline.campaignStart);
    await driveTo(c, 'finished');
    // an AI agent, a disconnected and an eliminated member: all come back as active
    await c.repo.updatePlayer(c.gameId, c.p[1].playerId, { kind: 'agent' });
    await c.repo.updatePlayer(c.gameId, c.p[2].playerId, { status: 'disconnected', disconnectedAt: c.clock.now(), graceSchedule: 'g-old', connectionId: undefined });
    await c.repo.updatePlayer(c.gameId, c.p[3].playerId, { status: 'eliminated' });
    const old = byId(await c.repo.listPlayers(c.gameId));

    const r = await c.svc.rematch(c.gameId, c.p[0].token, { phases: 2 });
    expect(r.gameId).not.toBe(c.gameId);
    const next = byId(await c.repo.listPlayers(r.gameId));
    expect([...next.keys()].sort()).toEqual(c.p.map((p) => p.playerId).sort());
    expect(next.has(pend.playerId)).toBe(false);
    expect(next.has(rej.playerId)).toBe(false);
    for (const p of c.p) {
      const a = old.get(p.playerId)!;
      const b = next.get(p.playerId)!;
      expect(b.gameId).toBe(r.gameId);
      expect(b.tokenHash).toBe(a.tokenHash);
      expect(b.nickname).toBe(a.nickname);
      expect(b.isAdmin).toBe(a.isAdmin);
      expect(b.kind).toBe(a.kind);
      expect(b.party).toEqual(a.party);
      expect(b.status).toBe('active');
      expect(b.connectionId).toBeUndefined();
      expect(b.disconnectedAt).toBeUndefined();
      expect(b.graceSchedule).toBeUndefined();
    }
    expect(next.get(c.p[1].playerId)!.kind).toBe('agent');
    expect(next.get(c.p[0].playerId)!.isAdmin).toBe(true);
  });

  it('starts at once in the campaign with a timeline for the chosen phases (may differ from the old game), admission closed', async () => {
    const c = await finished(3, 2);
    const r = await c.svc.rematch(c.gameId, c.p[0].token, { phases: 3 });
    const g = (await c.repo.getGame(r.gameId))!;
    expect(g.status).toBe('campaign');
    expect(g.phases).toBe(3);
    expect(g.admissionOpen).toBe(false);
    expect(g.adminId).toBe(c.p[0].playerId);
    expect(g.mapId).toBe(c.map.mapId);
    expect(g.closedPhases).toBe(0);
    expect(g.revealedStep).toBe(0);
    expect(g.timeline!.phaseCloses).toHaveLength(3);
    expect(g.timeline!.campaignStart).toBeGreaterThan(c.clock.now());
    // the lifecycle (phase closes, counting, finalise) runs for the NEW game
    expect(c.scheduler.lifecycles).toHaveLength(2);
    expect(c.scheduler.lifecycles[1]).toEqual({ gameId: r.gameId, timeline: g.timeline });
    // the old game is untouched apart from the link
    const old = await c.game();
    expect(old.status).toBe('finished');
    expect(old.phases).toBe(2);
    expect(old.rematchGameId).toBe(r.gameId);
    expect(old.rematchJoinCode).toBe(r.joinCode);
  });

  it('budgets, committed voters, candidate columns, news secret and join code are fresh; rally history is cleared', async () => {
    const c = await finished(3, 2);
    for (const p of c.p) await c.repo.updatePlayer(c.gameId, p.playerId, { budget: 7, lastRallyAt: c.clock.now() });
    const oldGame = await c.game();
    const old = byId(await c.repo.listPlayers(c.gameId));
    const r = await c.svc.rematch(c.gameId, c.p[0].token, { phases: 2 });
    const g = (await c.repo.getGame(r.gameId))!;
    expect(r.joinCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(r.joinCode).not.toBe(oldGame.joinCode);
    expect(g.joinCode).toBe(r.joinCode);
    expect(g.newsSecret).toBeTruthy();
    expect(g.newsSecret).not.toBe(oldGame.newsSecret);
    expect(g.finalised).toBeUndefined();
    expect(g.rematchGameId).toBeUndefined();
    expect(await c.repo.findGameByCode(r.joinCode)).toMatchObject({ gameId: r.gameId });
    const next = [...(await c.repo.listPlayers(r.gameId))];
    const cols = next.map((p) => p.candidateColumn);
    for (const col of cols) {
      expect(Number.isInteger(col)).toBe(true);
      expect(col!).toBeGreaterThanOrEqual(0);
      expect(col!).toBeLessThan(c.cfg.players.max);
    }
    expect(new Set(cols).size).toBe(next.length);
    for (const p of next) {
      expect(p.budget).toBe(c.cfg.budget);
      expect(p.lastRallyAt).toBeUndefined();
      expect(p.committed).toBeTruthy();
    }
    // dealt afresh for the new game (seeded by the new game id), not copied
    expect(next.some((p) => JSON.stringify(p.committed) !== JSON.stringify(old.get(p.playerId)!.committed))).toBe(true);
    // nothing of the old game leaks into the new one
    expect(await c.repo.listActions(r.gameId)).toEqual([]);
    expect(await c.repo.listChat(r.gameId)).toEqual([]);
    expect(await c.repo.getResult(r.gameId)).toBeNull();
  });

  it('the old token authenticates in the new game (REST lobby + WebSocket hello with the party, budget and campaign status)', async () => {
    const c = await finished(3, 2);
    const r = await c.svc.rematch(c.gameId, c.p[0].token, { phases: 1 });
    for (const [i, p] of c.p.entries()) {
      const lobby = await c.svc.getLobby(r.gameId, p.token);
      expect(lobby).toMatchObject({ gameId: r.gameId, joinCode: r.joinCode, status: 'campaign', phases: 1, admissionOpen: false, you: p.playerId });
      expect(lobby.players).toHaveLength(3);
      expect(lobby.nextGameId).toBeUndefined();
      const conn = `n${i}`;
      expect(await c.svc.connect(r.gameId, p.token, conn)).toBe(p.playerId);
      c.notifier.clear();
      await c.svc.handleMessage(conn, { action: 'ping', clientTime: 1 });
      const hello = c.notifier.to(p.playerId, 'hello')[0] as Extract<ServerMessage, { type: 'hello' }>;
      expect(hello.snapshot.gameId).toBe(r.gameId);
      expect(hello.snapshot.status).toBe('campaign');
      expect(hello.snapshot.players.every((x) => x.party && x.status === 'active')).toBe(true);
      expect(hello.private.budget).toBe(c.cfg.budget);
      expect(hello.snapshot.result).toBeNull();
      expect(hello.features).toContain('rematch');
    }
    // and the new game can be campaigned in once the lead-in is over
    c.clock.set(c.scheduler.lifecycles[1].timeline.campaignStart);
    c.notifier.clear();
    await c.svc.handleMessage('n1', { action: 'campaign', type: 'rally', seat: 1 });
    expect(c.notifier.to(c.p[1].playerId, 'error')).toEqual([]);
    expect((await c.repo.getPlayer(r.gameId, c.p[1].playerId))!.budget).toBe(c.cfg.budget - c.cfg.costs.rally);
  });

  it('nobody can join the new game or the old one by code', async () => {
    const c = await finished(3, 2);
    const r = await c.svc.rematch(c.gameId, c.p[0].token, { phases: 2 });
    expect(await code(c.svc.joinGame({ joinCode: r.joinCode, nickname: 'x' }))).toBe('ADMISSION_CLOSED');
    expect(await code(c.svc.joinGame({ joinCode: c.joinCode, nickname: 'x' }))).toBe('ADMISSION_CLOSED');
  });

  it('the new game plays to the end and can itself be played again', async () => {
    const c = await finished(3, 2);
    const r = await c.svc.rematch(c.gameId, c.p[0].token, { phases: 3 });
    c.gameId = r.gameId;
    c.joinCode = r.joinCode;
    c.scheduler.lifecycles.shift(); // ctx.timeline = the new game's
    for (const p of c.p) await c.svc.connect(c.gameId, p.token, `${p.conn}-2`);
    c.clock.set(c.timeline.campaignStart);
    await driveTo(c, 'finished');
    expect((await c.game()).status).toBe('finished');
    const again = await c.svc.rematch(c.gameId, c.p[0].token, { phases: 1 });
    expect(again.gameId).not.toBe(r.gameId);
    expect((await c.repo.getGame(again.gameId))!.status).toBe('campaign');
  });
});

describe('rematch: idempotent', () => {
  it('a second call returns the same new game (its phases are ignored), no second lifecycle', async () => {
    const c = await finished(3, 2);
    const a = await c.svc.rematch(c.gameId, c.p[0].token, { phases: 3 });
    const b = await c.svc.rematch(c.gameId, c.p[0].token, { phases: 1 });
    expect(b).toEqual(a);
    // even with bad phases once the rematch exists
    expect(await c.svc.rematch(c.gameId, c.p[0].token, { phases: 99 })).toEqual(a);
    expect(c.scheduler.lifecycles).toHaveLength(2);
    expect((await c.repo.getGame(a.gameId))!.phases).toBe(3);
  });

  it('two concurrent calls agree on one game; only that game is started', async () => {
    const c = await finished(3, 2);
    const [a, b] = await Promise.all([
      c.svc.rematch(c.gameId, c.p[0].token, { phases: 2 }),
      c.svc.rematch(c.gameId, c.p[0].token, { phases: 3 }),
    ]);
    expect(b).toEqual(a);
    expect((await c.game()).rematchGameId).toBe(a.gameId);
    expect(c.scheduler.lifecycles.map((l) => l.gameId)).toEqual([c.gameId, a.gameId]);
    expect((await c.repo.getGame(a.gameId))!.status).toBe('campaign');
  });

  it('a call that loses the claim returns the winner and starts nothing', async () => {
    const c = await finished(3, 2);
    const orig = c.repo.updateGame.bind(c.repo);
    let raced = false;
    c.repo.updateGame = async (id, patch, cond) => {
      if (!raced && id === c.gameId && patch.rematchGameId) { // another call links its game first
        raced = true;
        await orig(id, { rematchGameId: 'winner', rematchJoinCode: 'WINNER' });
      }
      return orig(id, patch, cond);
    };
    expect(await c.svc.rematch(c.gameId, c.p[0].token, { phases: 2 })).toEqual({ gameId: 'winner', joinCode: 'WINNER' });
    expect(raced).toBe(true);
    expect(c.scheduler.lifecycles).toHaveLength(1);
    expect(c.notifier.log.filter((s) => s.msg.type === 'rematch')).toEqual([]);
  });

  it('a failed lifecycle start releases the claim so the host can try again', async () => {
    const c = await finished(3, 2);
    const orig = c.scheduler.startLifecycle.bind(c.scheduler);
    c.scheduler.startLifecycle = async () => { throw new Error('sfn down'); };
    await expect(c.svc.rematch(c.gameId, c.p[0].token, { phases: 2 })).rejects.toThrow('sfn down');
    const old = await c.game();
    expect(old.rematchGameId).toBeUndefined();
    expect(old.rematchJoinCode).toBeUndefined();
    expect(c.notifier.log.filter((s) => s.msg.type === 'rematch')).toEqual([]);
    c.scheduler.startLifecycle = orig;
    const r = await c.svc.rematch(c.gameId, c.p[0].token, { phases: 2 });
    expect((await c.repo.getGame(r.gameId))!.status).toBe('campaign');
    expect((await c.game()).rematchGameId).toBe(r.gameId);
  });
});

describe('rematch: telling the players of the old game', () => {
  it("every member of the old game gets {type:'rematch', gameId, joinCode}", async () => {
    const c = await finished(3, 2);
    await c.repo.updatePlayer(c.gameId, c.p[2].playerId, { status: 'eliminated' });
    c.notifier.clear();
    const r = await c.svc.rematch(c.gameId, c.p[0].token, { phases: 2 });
    for (const p of c.p) {
      expect(c.notifier.to(p.playerId, 'rematch')).toEqual([{ type: 'rematch', gameId: r.gameId, joinCode: r.joinCode }]);
    }
  });

  it('a later getLobby / hello of the old game carries nextGameId and nextJoinCode (reload, reconnect, offline agents)', async () => {
    const c = await finished(3, 2);
    const before = await c.svc.getLobby(c.gameId, c.p[1].token);
    expect(before.nextGameId).toBeUndefined();
    expect(before.nextJoinCode).toBeUndefined();
    const helloBefore = await c.svc.hello((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!);
    expect((helloBefore as Extract<ServerMessage, { type: 'hello' }>).snapshot.nextGameId).toBeUndefined();

    const r = await c.svc.rematch(c.gameId, c.p[0].token, { phases: 2 });
    for (const p of c.p) {
      const lobby = await c.svc.getLobby(c.gameId, p.token);
      expect(lobby).toMatchObject({ gameId: c.gameId, status: 'finished', nextGameId: r.gameId, nextJoinCode: r.joinCode });
      const hello = (await c.svc.hello((await c.repo.getPlayer(c.gameId, p.playerId))!)) as Extract<ServerMessage, { type: 'hello' }>;
      expect(hello.snapshot.gameId).toBe(c.gameId);
      expect(hello.snapshot.status).toBe('finished');
      expect(hello.snapshot.result).not.toBeNull();
      expect(hello.snapshot.nextGameId).toBe(r.gameId);
      expect(hello.snapshot.nextJoinCode).toBe(r.joinCode);
      expect(hello.features).toContain('rematch');
    }
  });

  it('hello advertises the rematch feature in every game', async () => {
    const c = await new Ctx().lobby(2);
    const hello = (await c.svc.hello((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!)) as Extract<ServerMessage, { type: 'hello' }>;
    expect(hello.features).toEqual(expect.arrayContaining(['actionRef', 'rematch']));
  });
});
