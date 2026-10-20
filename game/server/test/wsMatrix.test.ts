// Every WebSocket action x every game status x every player status: the expected outcome is written down as a rule
// (oracle below), not copied from the implementation. A failing row means either the rule or the service is wrong.
import { describe, expect, it } from 'vitest';
import type { ClientMessage, ErrorCode, PlayerStatus } from '@hp/shared';
import { Ctx, driveTo } from './helpers';

type GameStatus = 'lobby' | 'campaign' | 'counting' | 'postCounting' | 'finished' | 'abandoned';
type Outcome = ErrorCode | 'OK';

const GAME_STATUSES: GameStatus[] = ['lobby', 'campaign', 'counting', 'postCounting', 'finished', 'abandoned'];
const PLAYER_STATUSES: PlayerStatus[] = ['active', 'eliminated', 'pending', 'rejected'];

async function build(gs: GameStatus, n = 4): Promise<Ctx> {
  const c = new Ctx();
  if (gs === 'lobby') {
    await c.lobby(n, 3);
    for (const p of c.p) await c.svc.connect(c.gameId, p.token, p.conn);
    return c;
  }
  await c.started(n, 3);
  await driveTo(c, gs);
  return c;
}

/** Sends `msg` as player `i` and reports OK or the error code of the (single) error answer. */
async function outcome(c: Ctx, i: number, msg: ClientMessage): Promise<Outcome> {
  const before = c.notifier.to(c.p[i].playerId, 'error').length;
  await c.send(i, msg);
  const errs = c.notifier.to(c.p[i].playerId, 'error') as { error: ErrorCode }[];
  expect(errs.length - before).toBeLessThanOrEqual(1);
  return errs.length > before ? errs[errs.length - 1].error : 'OK';
}

const live = (gs: GameStatus) => gs === 'counting' || gs === 'postCounting';

/** campaign / buyReport: contender only, then the campaign window. */
function campaignRule(gs: GameStatus, ps: PlayerStatus): Outcome {
  if (ps !== 'active') return 'FORBIDDEN';
  if (gs === 'lobby') return 'WRONG_PHASE';
  return gs === 'campaign' ? 'OK' : 'TOO_LATE';
}
/** chat: only while counting; then membership (pending/rejected are not members, eliminated players still are). */
function chatRule(gs: GameStatus, ps: PlayerStatus): Outcome {
  if (!live(gs)) return 'WRONG_PHASE';
  return ps === 'pending' || ps === 'rejected' ? 'FORBIDDEN' : 'OK';
}
/** proposeGovernment / respondOffer: only while counting, then active contenders only. */
function negotiateRule(gs: GameStatus, ps: PlayerStatus): Outcome {
  if (!live(gs)) return 'WRONG_PHASE';
  return ps === 'active' ? 'OK' : 'FORBIDDEN';
}

describe('WebSocket action matrix (4 players, so the 3-member negotiation minimum holds even when one is forced out)', () => {
  for (const gs of GAME_STATUSES) {
    describe(`game ${gs}`, () => {
      for (const ps of PLAYER_STATUSES) {
        it(`player ${ps}`, async () => {
          const c = await build(gs, 4);
          const me = 1;
          const other = c.p[2].playerId;
          // a real offer from player 0 to player 1 (needed for respondOffer) while negotiation is open
          let offerId = 'no-such-offer';
          if (live(gs)) {
            await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[me].playerId] } });
            offerId = (await c.repo.listOffers(c.gameId))[0].offerId;
          }
          if (ps !== 'active') await c.repo.updatePlayer(c.gameId, c.p[me].playerId, { status: ps });

          const campaignAct: ClientMessage = { action: 'campaign', type: 'rally', seat: 7 };
          expect(await outcome(c, me, { action: 'ping', clientTime: 1 })).toBe('OK');
          expect(await outcome(c, me, campaignAct)).toBe(campaignRule(gs, ps));
          expect(await outcome(c, me, { action: 'buyReport', scope: 'global' })).toBe(campaignRule(gs, ps));
          expect(await outcome(c, me, { action: 'chat', to: [other], text: 'hello' })).toBe(chatRule(gs, ps));
          expect(await outcome(c, me, { action: 'proposeGovernment', portfolios: { PM: [c.p[me].playerId], HOME: [other] } })).toBe(negotiateRule(gs, ps));
          // proposing may have superseded/changed the offer under test: respond to the original one if it is still open
          expect(await outcome(c, me, { action: 'respondOffer', offerId, accept: false })).toBe(
            negotiateRule(gs, ps) === 'OK' && ps === 'active' ? 'OK' : negotiateRule(gs, ps),
          );
          // nobody has offer 'no-such-offer': OFFER_NOT_FOUND whatever the game / player status (withdraw has no status guard)
          expect(await outcome(c, me, { action: 'withdrawOffer', offerId: 'no-such-offer' })).toBe('OFFER_NOT_FOUND');
        });
      }
    });
  }
});

describe('WebSocket action matrix (2 players: no negotiation)', () => {
  for (const gs of GAME_STATUSES) {
    it(`game ${gs}`, async () => {
      const c = await build(gs, 2);
      const a = c.p[0].playerId;
      const b = c.p[1].playerId;
      // without a game that has started, the status guard fires before the 2-player guard
      const negotiating = live(gs);
      const wrong = (code: ErrorCode): Outcome => (negotiating ? 'NEGOTIATION_DISABLED' : code);
      expect(await outcome(c, 0, { action: 'chat', to: [b], text: 'hi' })).toBe(wrong('WRONG_PHASE'));
      expect(await outcome(c, 0, { action: 'proposeGovernment', portfolios: { PM: [a], HOME: [b] } })).toBe(wrong('WRONG_PHASE'));
      expect(await outcome(c, 1, { action: 'respondOffer', offerId: 'x', accept: true })).toBe(wrong('WRONG_PHASE'));
      expect(await outcome(c, 0, { action: 'withdrawOffer', offerId: 'x' })).toBe('NEGOTIATION_DISABLED');
      expect(await c.repo.listOffers(c.gameId)).toHaveLength(0);
      expect(await c.repo.listChat(c.gameId)).toHaveLength(0);
    });
  }
});

describe('malformed messages', () => {
  const bad: [string, unknown][] = [
    ['null', null], ['a string', 'campaign'], ['a number', 42], ['an array', []], ['no action', {}], ['numeric action', { action: 7 }],
    ['unknown action', { action: 'dance' }], ['createGame over the socket', { action: 'createGame', nickname: 'x' }],
    ['startGame over the socket', { action: 'start' }], ['admit over the socket', { action: 'admit', playerId: 'x', admit: true }],
  ];
  for (const [label, msg] of bad) {
    it(`${label} -> BAD_REQUEST and nothing changes`, async () => {
      const c = await new Ctx().started(3, 2);
      const budgets = [await c.budget(0), await c.budget(1), await c.budget(2)];
      expect(await outcome(c, 1, msg as ClientMessage)).toBe('BAD_REQUEST');
      expect([await c.budget(0), await c.budget(1), await c.budget(2)]).toEqual(budgets);
      expect((await c.game()).status).toBe('campaign');
    });
  }

  it('a message from an unknown connection id is answered with UNAUTHORIZED and does not touch the game', async () => {
    const c = await new Ctx().started(2, 1);
    await c.svc.handleMessage('ghost', { action: 'campaign', type: 'rally', seat: 1 });
    const answer = c.notifier.log.find((s) => s.to === 'conn:ghost');
    expect(answer?.msg).toMatchObject({ type: 'error', error: 'UNAUTHORIZED' });
    expect(await c.repo.listActions(c.gameId)).toHaveLength(0);
  });

  it('a rejected player\'s old connection is gone: messages get UNAUTHORIZED', async () => {
    const c = await new Ctx().lobby(2);
    const j = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'late' });
    await c.svc.connect(c.gameId, j.token, 'late-conn');
    await c.svc.admit(c.gameId, c.p[0].token, { playerId: j.playerId, admit: false });
    expect(c.notifier.closed).toContain('late-conn');
    await c.svc.handleMessage('late-conn', { action: 'ping', clientTime: 1 });
    expect(c.notifier.log.at(-1)?.msg).toMatchObject({ type: 'error', error: 'UNAUTHORIZED' });
    await expect(c.svc.connect(c.gameId, j.token, 'late-conn-2')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('clientRef is echoed on errors of campaign actions, never on unrelated ones', async () => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 999, clientRef: 'abc' });
    expect(c.lastError(0)).toMatchObject({ error: 'BAD_REQUEST', clientRef: 'abc' });
    await c.send(0, { action: 'buyReport', scope: 'seat' });
    expect(c.lastError(0)?.clientRef).toBeUndefined();
  });
});

describe('every ErrorCode of the contract is either reachable or documented as unused', () => {
  it('RATE_LIMITED is declared (HTTP 429) but no code path throws it yet', async () => {
    const { HTTP_STATUS } = await import('../src/core/types');
    expect(HTTP_STATUS.RATE_LIMITED).toBe(429);
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../src/core/gameService.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain("'RATE_LIMITED'"); // if this fails, RATE_LIMITED became reachable: add a test for it in errorCodes.test.ts
  });
});
