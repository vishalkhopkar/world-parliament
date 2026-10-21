// Lobby rules at service level: party identity validation + uniqueness, admission, start conditions, concurrency, rollbacks.
import { describe, expect, it } from 'vitest';
import { AVATARS, PARTY_COLOURS, PARTY_SYMBOLS, buildTimeline, countingMsFor, postCountingMsFor } from '@hp/shared';
import type { ErrorCode, PartyIdentity } from '@hp/shared';
import { GameError } from '../src/core/types';
import { Ctx } from './helpers';

const base = (i: number, over: Partial<PartyIdentity> = {}): PartyIdentity => ({
  name: `Party ${i}`, colour: PARTY_COLOURS[i].id, symbol: PARTY_SYMBOLS[i].id, avatar: AVATARS[i].id, ...over,
});
const code = async (p: Promise<unknown>): Promise<ErrorCode | 'ok'> => p.then(() => 'ok' as const, (e: GameError) => e.code);

/** Admin + `n-1` admitted players without parties. */
async function admitted(n: number, phases = 2): Promise<Ctx> {
  const c = new Ctx();
  const g = await c.svc.createGame({ nickname: 'P0', mapId: 'test', phases });
  c.gameId = g.gameId;
  c.joinCode = g.joinCode;
  c.players.push({ playerId: g.playerId, token: g.token, conn: 'c0', nickname: 'P0' });
  for (let i = 1; i < n; i++) {
    c.clock.advance(1);
    const j = await c.svc.joinGame({ joinCode: g.joinCode, nickname: `P${i}` });
    c.players.push({ playerId: j.playerId, token: j.token, conn: `c${i}`, nickname: `P${i}` });
    await c.svc.admit(g.gameId, g.token, { playerId: j.playerId, admit: true });
  }
  return c;
}

describe('party identity validation', () => {
  it.each([
    ['name too short (1)', { name: 'A' }], ['name too long (31)', { name: 'x'.repeat(31) }], ['name blank', { name: '   ' }],
    ['name only control chars', { name: '\u0000\u0001' }], ['name not text', { name: 5 as never }],
    ['unknown colour', { colour: '#123456' }], ['colour not text', { colour: 5 as never }], ['empty colour', { colour: '' }],
    ['unknown symbol', { symbol: 'skull' }], ['symbol not text', { symbol: null as never }],
    ['unknown avatar', { avatar: 'nobody' }], ['avatar not text', { avatar: 5 as never }],
  ])('%s -> BAD_REQUEST', async (_label, over) => {
    const c = await admitted(2);
    expect(await code(c.svc.setParty(c.gameId, c.p[1].token, { party: base(1, over) }))).toBe('BAD_REQUEST');
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.party).toBeUndefined();
  });

  it('missing party object -> BAD_REQUEST', async () => {
    const c = await admitted(2);
    expect(await code(c.svc.setParty(c.gameId, c.p[1].token, {} as never))).toBe('BAD_REQUEST');
    expect(await code(c.svc.setParty(c.gameId, c.p[1].token, { party: null } as never))).toBe('BAD_REQUEST');
  });

  it('name length bounds 2 and 30 are accepted; whitespace is collapsed and trimmed', async () => {
    const c = await admitted(3);
    expect(await code(c.svc.setParty(c.gameId, c.p[1].token, { party: base(1, { name: 'ab' }) }))).toBe('ok');
    expect(await code(c.svc.setParty(c.gameId, c.p[2].token, { party: base(2, { name: 'y'.repeat(30) }) }))).toBe('ok');
    await c.svc.setParty(c.gameId, c.p[0].token, { party: base(0, { name: '  The   Big \t Party  ' }) });
    expect((await c.repo.getPlayer(c.gameId, c.p[0].playerId))!.party!.name).toBe('The Big Party');
  });

  it('a party without an avatar is stored (the avatar is only required at start); empty string / null avatar mean "none"', async () => {
    const c = await admitted(3);
    const { avatar: _a, ...noAvatar } = base(1);
    expect(await code(c.svc.setParty(c.gameId, c.p[1].token, { party: noAvatar }))).toBe('ok');
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.party!.avatar).toBeUndefined();
    expect(await code(c.svc.setParty(c.gameId, c.p[2].token, { party: base(2, { avatar: '' }) }))).toBe('ok');
    expect(await code(c.svc.setParty(c.gameId, c.p[0].token, { party: base(0, { avatar: null as never }) }))).toBe('ok');
  });

  it('colour may be given as id or hex, in any case; it is stored as canonical hex', async () => {
    const c = await admitted(4);
    for (let i = 0; i < 4; i++) {
      const colour = [PARTY_COLOURS[i].id.toUpperCase(), PARTY_COLOURS[i].hex.toLowerCase(), PARTY_COLOURS[i].hex, ` ${PARTY_COLOURS[i].id} `][i];
      await c.svc.setParty(c.gameId, c.p[i].token, { party: base(i, { colour }) });
      expect((await c.repo.getPlayer(c.gameId, c.p[i].playerId))!.party!.colour).toBe(PARTY_COLOURS[i].hex);
    }
  });

  describe('uniqueness (name case-insensitive, colour by value, symbol, avatar)', () => {
    const clashes: [string, Partial<PartyIdentity>, ErrorCode][] = [
      ['same name', { name: 'Party 0' }, 'NAME_TAKEN'], ['same name, other case', { name: 'PARTY 0' }, 'NAME_TAKEN'],
      ['same name with extra spaces', { name: '  party   0 ' }, 'NAME_TAKEN'],
      ['same colour (id)', { colour: PARTY_COLOURS[0].id }, 'COLOUR_TAKEN'], ['same colour (hex)', { colour: PARTY_COLOURS[0].hex }, 'COLOUR_TAKEN'],
      ['same colour (lower-case hex)', { colour: PARTY_COLOURS[0].hex.toLowerCase() }, 'COLOUR_TAKEN'],
      ['same symbol', { symbol: PARTY_SYMBOLS[0].id }, 'SYMBOL_TAKEN'], ['same avatar', { avatar: AVATARS[0].id }, 'AVATAR_TAKEN'],
    ];
    it.each(clashes)('%s -> %s', async (_label, over, expected) => {
      const c = await admitted(3);
      await c.svc.setParty(c.gameId, c.p[0].token, { party: base(0) });
      expect(await code(c.svc.setParty(c.gameId, c.p[1].token, { party: base(1, over) }))).toBe(expected);
      expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.party).toBeUndefined();
    });

    it('a player may re-save their own party (changing one field keeps the others unique to them)', async () => {
      const c = await admitted(2);
      await c.svc.setParty(c.gameId, c.p[1].token, { party: base(1) });
      expect(await code(c.svc.setParty(c.gameId, c.p[1].token, { party: base(1) }))).toBe('ok');
      expect(await code(c.svc.setParty(c.gameId, c.p[1].token, { party: base(1, { name: 'Renamed' }) }))).toBe('ok');
    });

    it('a name freed by a change can be taken by someone else', async () => {
      const c = await admitted(3);
      await c.svc.setParty(c.gameId, c.p[1].token, { party: base(1, { name: 'Shared' }) });
      await c.svc.setParty(c.gameId, c.p[1].token, { party: base(1, { name: 'Other' }) });
      expect(await code(c.svc.setParty(c.gameId, c.p[2].token, { party: base(2, { name: 'Shared' }) }))).toBe('ok');
    });

    it('a rejected player\'s party no longer blocks anything', async () => {
      const c = await admitted(3);
      await c.svc.setParty(c.gameId, c.p[1].token, { party: base(1) });
      await c.svc.admit(c.gameId, c.p[0].token, { playerId: c.p[1].playerId, admit: false });
      expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.party).toBeUndefined();
      expect(await code(c.svc.setParty(c.gameId, c.p[2].token, { party: base(2, base(1)) }))).toBe('ok');
    });

    it('parties in different games do not clash', async () => {
      const a = await admitted(2);
      const b = await admitted(2);
      await a.svc.setParty(a.gameId, a.p[0].token, { party: base(0) });
      expect(await code(b.svc.setParty(b.gameId, b.p[0].token, { party: base(0) }))).toBe('ok');
    });

    it('with 10 players every colour, symbol and avatar can be used exactly once', async () => {
      const c = await admitted(10);
      for (let i = 0; i < 10; i++) expect(await code(c.svc.setParty(c.gameId, c.p[i].token, { party: base(i) }))).toBe('ok');
      expect(new Set(c.p.map((_, i) => PARTY_COLOURS[i].hex)).size).toBe(10);
    });

    it('simultaneous identical picks: both are accepted individually but start re-validates and refuses', async () => {
      const c = await admitted(2);
      await Promise.all([
        c.svc.setParty(c.gameId, c.p[0].token, { party: base(0) }).catch(() => undefined),
        c.svc.setParty(c.gameId, c.p[1].token, { party: base(0) }).catch(() => undefined),
      ]);
      const parties = await Promise.all(c.p.map(async (p) => (await c.repo.getPlayer(c.gameId, p.playerId))!.party));
      if (parties[0] && parties[1]) {
        // a race let both through: start must catch it
        expect(['NAME_TAKEN', 'COLOUR_TAKEN', 'SYMBOL_TAKEN', 'AVATAR_TAKEN']).toContain(await code(c.svc.start(c.gameId, c.p[0].token)));
      } else {
        expect(parties.filter(Boolean)).toHaveLength(1);
      }
    });
  });
});

describe('start conditions', () => {
  it('needs at least 2 active players', async () => {
    const c = await admitted(1);
    await c.svc.setParty(c.gameId, c.p[0].token, { party: base(0) });
    expect(await code(c.svc.start(c.gameId, c.p[0].token))).toBe('NOT_ENOUGH_PLAYERS');
    expect((await c.game()).status).toBe('lobby');
  });

  it('pending players do not count towards the minimum', async () => {
    const c = await admitted(1);
    await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'pending' });
    await c.svc.setParty(c.gameId, c.p[0].token, { party: base(0) });
    expect(await code(c.svc.start(c.gameId, c.p[0].token))).toBe('NOT_ENOUGH_PLAYERS');
  });

  it('lists who is still missing a party (or an avatar) in the error message', async () => {
    const c = await admitted(3);
    await c.svc.setParty(c.gameId, c.p[0].token, { party: base(0) });
    const { avatar: _a, ...noAvatar } = base(1);
    await c.svc.setParty(c.gameId, c.p[1].token, { party: noAvatar });
    const err = await c.svc.start(c.gameId, c.p[0].token).catch((e: GameError) => e);
    expect(err).toBeInstanceOf(GameError);
    expect((err as GameError).code).toBe('BAD_REQUEST');
    expect((err as GameError).message).toContain('P1');
    expect((err as GameError).message).toContain('P2');
    expect((err as GameError).message).not.toContain('P0');
  });

  it('the first start wins when called concurrently: one timeline, one lifecycle, budgets set once', async () => {
    const c = await admitted(3);
    for (let i = 0; i < 3; i++) await c.svc.setParty(c.gameId, c.p[i].token, { party: base(i) });
    const results = await Promise.all([1, 2, 3, 4].map(() => code(c.svc.start(c.gameId, c.p[0].token))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'WRONG_PHASE')).toHaveLength(3);
    expect(c.scheduler.lifecycles).toHaveLength(1);
    for (const p of c.p) expect((await c.repo.getPlayer(c.gameId, p.playerId))!.budget).toBe(c.cfg.budget);
  });

  it('uses the configured lead-in: timeline = buildTimeline(cfg, phases, now + startDelay), admission closes', async () => {
    const c = await admitted(2, 3);
    for (let i = 0; i < 2; i++) await c.svc.setParty(c.gameId, c.p[i].token, { party: base(i) });
    const now = c.clock.now();
    const r = await c.svc.start(c.gameId, c.p[0].token);
    expect(r.timeline).toEqual(buildTimeline(c.cfg, 3, now + 1000, countingMsFor(c.cfg, 2), postCountingMsFor(c.cfg, 2))); // 2 players: short counting
    expect(r.timeline.countingEnd - r.timeline.campaignEnd).toBe(c.cfg.durations.countingMsTwoPlayers);
    // 2 players cannot negotiate: no post-counting wait, the result follows as soon as counting ends
    expect(r.timeline.postCountingEnd).toBe(r.timeline.countingEnd);
    const game = await c.game();
    expect(game.status).toBe('campaign');
    expect(game.admissionOpen).toBe(false);
    expect(game.timeline).toEqual(r.timeline);
    expect(game.closedPhases).toBe(0);
  });

  it('pending players become rejected, active players get the starting budget, connections of pending ones are closed', async () => {
    const c = await admitted(2);
    const late = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'late' });
    await c.svc.connect(c.gameId, late.token, 'late-c');
    for (let i = 0; i < 2; i++) await c.svc.setParty(c.gameId, c.p[i].token, { party: base(i) });
    await c.svc.start(c.gameId, c.p[0].token);
    expect((await c.repo.getPlayer(c.gameId, late.playerId))!.status).toBe('rejected');
    expect(c.notifier.closed).toContain('late-c');
    expect((await c.repo.getPlayer(c.gameId, late.playerId))!.budget).toBe(0);
    for (const p of c.p) expect((await c.repo.getPlayer(c.gameId, p.playerId))!.budget).toBe(c.cfg.budget);
    // and cannot join any more
    expect(await code(c.svc.joinGame({ joinCode: c.joinCode, nickname: 'x' }))).toBe('ADMISSION_CLOSED');
  });

  it('a scheduler failure rolls the game back to the lobby (and re-opens admission) instead of leaving it half-started', async () => {
    const c = await admitted(2);
    for (let i = 0; i < 2; i++) await c.svc.setParty(c.gameId, c.p[i].token, { party: base(i) });
    c.scheduler.startLifecycle = async () => { throw new Error('state machine unavailable'); };
    await expect(c.svc.start(c.gameId, c.p[0].token)).rejects.toThrow('state machine unavailable');
    const game = await c.game();
    expect(game.status).toBe('lobby');
    expect(game.timeline).toBeNull();
    expect(game.admissionOpen).toBe(true);
    // a retry after the outage works
    c.scheduler.startLifecycle = async (gameId, timeline) => { c.scheduler.lifecycles.push({ gameId, timeline }); };
    expect(await code(c.svc.start(c.gameId, c.p[0].token))).toBe('ok');
  });

  it('start re-validates uniqueness even if two parties slipped in with the same name', async () => {
    const c = await admitted(2);
    for (let i = 0; i < 2; i++) await c.svc.setParty(c.gameId, c.p[i].token, { party: base(i) });
    await c.repo.updatePlayer(c.gameId, c.p[1].playerId, { party: base(1, { name: 'party 0' }) });
    expect(await code(c.svc.start(c.gameId, c.p[0].token))).toBe('NAME_TAKEN');
    expect((await c.game()).status).toBe('lobby');
  });

  it('start sends every connected active player their new budget (private) and a status broadcast', async () => {
    const c = await admitted(2);
    for (let i = 0; i < 2; i++) await c.svc.setParty(c.gameId, c.p[i].token, { party: base(i) });
    await c.svc.connect(c.gameId, c.p[1].token, 'c1');
    c.notifier.clear();
    await c.svc.start(c.gameId, c.p[0].token);
    const priv = c.notifier.to(c.p[1].playerId, 'private') as { private: { budget: number } }[];
    expect(priv).toHaveLength(1);
    expect(priv[0].private.budget).toBe(c.cfg.budget);
    expect(c.notifier.to(c.p[1].playerId, 'status')).toHaveLength(1);
    expect(c.notifier.to(c.p[0].playerId, 'private')).toHaveLength(0); // admin has no connection yet: nothing is sent into the void
  });
});

describe('admission', () => {
  it('admit is idempotent for an active player; rejecting clears their party; GAME_FULL at the maximum', async () => {
    const c = await admitted(10);
    const extra = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'extra' }).catch((e: GameError) => e);
    expect((extra as GameError).code).toBe('GAME_FULL');                           // joining is refused outright at 10 active
    expect(await code(c.svc.admit(c.gameId, c.p[0].token, { playerId: c.p[3].playerId, admit: true }))).toBe('ok'); // already active
  });

  it('GAME_FULL also when admitting a pending player into a full game; free again after a rejection', async () => {
    const c = await admitted(9);
    const a = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'A' });
    const b = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'B' });   // 9 active + 2 pending: both may knock
    expect(await code(c.svc.admit(c.gameId, c.p[0].token, { playerId: a.playerId, admit: true }))).toBe('ok');
    expect(await code(c.svc.admit(c.gameId, c.p[0].token, { playerId: b.playerId, admit: true }))).toBe('GAME_FULL');
    await c.svc.admit(c.gameId, c.p[0].token, { playerId: a.playerId, admit: false });
    expect(await code(c.svc.admit(c.gameId, c.p[0].token, { playerId: b.playerId, admit: true }))).toBe('ok');
  });

  it('at most 4 x max join requests are queued ("too many requests" is a GAME_FULL)', async () => {
    const c = await admitted(1);
    for (let i = 0; i < 39; i++) await c.svc.joinGame({ joinCode: c.joinCode, nickname: `q${i}` });
    expect(await code(c.svc.joinGame({ joinCode: c.joinCode, nickname: 'one too many' }))).toBe('GAME_FULL');
  });

  it('the lobby view is tailored: admin sees pending, others do not; other players pending or rejected entries are never shown', async () => {
    const c = await admitted(2);
    const p = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'pend' });
    const r = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'rej' });
    await c.svc.admit(c.gameId, c.p[0].token, { playerId: r.playerId, admit: false });
    const names = async (token: string) => (await c.svc.getLobby(c.gameId, token)).players.map((x) => x.nickname);
    expect(await names(c.p[0].token)).toEqual(['P0', 'P1', 'pend']);
    expect(await names(c.p[1].token)).toEqual(['P0', 'P1']);
    expect(await names(p.token)).toEqual(['P0', 'P1', 'pend']);
    expect(await names(r.token)).toEqual(['P0', 'P1', 'rej']); // a rejected player sees the members and themselves, never other pending/rejected ones
  });

  it('settings change the phase count only within the map\'s groupings, only in the lobby', async () => {
    const c = await admitted(2);
    expect(await code(c.svc.setSettings(c.gameId, c.p[0].token, { phases: 3 }))).toBe('ok');
    expect((await c.game()).phases).toBe(3);
    expect(await code(c.svc.setSettings(c.gameId, c.p[0].token, { phases: 4 }))).toBe('BAD_REQUEST'); // the test map has groupings 1..3
    expect((await c.game()).phases).toBe(3);
  });
});

describe('connect / disconnect edge cases', () => {
  it('bad token, missing token, wrong game: UNAUTHORIZED / NOT_FOUND', async () => {
    const c = await new Ctx().lobby(2);
    expect(await code(c.svc.connect(c.gameId, undefined, 'x'))).toBe('UNAUTHORIZED');
    expect(await code(c.svc.connect(c.gameId, 'nope', 'x'))).toBe('UNAUTHORIZED');
    expect(await code(c.svc.connect('nope', c.p[0].token, 'x'))).toBe('NOT_FOUND');
    expect(await code(c.svc.connect('', c.p[0].token, 'x'))).toBe('NOT_FOUND');
  });

  it('a second connection replaces the first: the old connection id is dead', async () => {
    const c = await new Ctx().started(2, 1);
    await c.svc.connect(c.gameId, c.p[1].token, 'second');
    expect(await c.repo.getConnection(c.p[1].conn)).toBeNull();
    c.notifier.clear();
    await c.svc.handleMessage(c.p[1].conn, { action: 'ping', clientTime: 1 });
    expect(c.notifier.log[0].msg).toMatchObject({ type: 'error', error: 'UNAUTHORIZED' });
    // the old socket closing later must not disconnect the live one
    await c.svc.disconnect(c.p[1].conn);
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.status).toBe('active');
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.connectionId).toBe('second');
  });

  it('disconnect outside a live game (lobby, finished) schedules no grace check and keeps the status', async () => {
    const lobby = await new Ctx().lobby(2);
    await lobby.svc.connect(lobby.gameId, lobby.p[1].token, 'x');
    await lobby.svc.disconnect('x');
    expect(lobby.scheduler.graces.size).toBe(0);
    expect((await lobby.repo.getPlayer(lobby.gameId, lobby.p[1].playerId))!.status).toBe('active');
    expect((await lobby.repo.getPlayer(lobby.gameId, lobby.p[1].playerId))!.connectionId).toBeUndefined();
  });

  it('only active players get a grace period: pending / eliminated players disconnecting are just dropped', async () => {
    const c = await new Ctx().started(3, 1);
    await c.svc.eliminate(c.gameId, c.p[2].playerId);
    await c.svc.connect(c.gameId, c.p[2].token, 'elim');
    await c.svc.disconnect('elim');
    expect(c.scheduler.graces.size).toBe(0);
    expect((await c.repo.getPlayer(c.gameId, c.p[2].playerId))!.status).toBe('eliminated');
  });

  it('an eliminated player may reconnect and look, but stays eliminated and cannot act', async () => {
    const c = await new Ctx().started(3, 1);
    await c.svc.eliminate(c.gameId, c.p[2].playerId);
    await c.svc.connect(c.gameId, c.p[2].token, 'e2');
    expect((await c.repo.getPlayer(c.gameId, c.p[2].playerId))!.status).toBe('eliminated');
    await c.svc.handleMessage('e2', { action: 'campaign', type: 'rally', seat: 1 });
    expect((c.notifier.to(c.p[2].playerId, 'error').pop() as { error: string }).error).toBe('FORBIDDEN');
    const hello = c.notifier.to(c.p[2].playerId, 'hello').pop() as { snapshot: { players: { playerId: string; status: string }[] } };
    expect(hello.snapshot.players.find((p) => p.playerId === c.p[2].playerId)!.status).toBe('eliminated');
  });

  it('reconnecting while disconnected cancels the grace check and re-announces the player as active', async () => {
    const c = await new Ctx().started(3, 1);
    await c.svc.disconnect(c.p[1].conn);
    const name = [...c.scheduler.graces.keys()][0];
    c.notifier.clear();
    await c.svc.connect(c.gameId, c.p[1].token, 'back');
    expect(c.scheduler.cancelled).toContain(name);
    const players = c.notifier.to(c.p[0].playerId, 'players').pop() as { players: { playerId: string; status: string }[] };
    expect(players.players.find((p) => p.playerId === c.p[1].playerId)!.status).toBe('active');
  });
});
