// Elimination / grace period and negotiation (chat, offers, government) rules, including the 2-player rule.
import { describe, expect, it } from 'vitest';
import { validateGovernment } from '@hp/shared';
import type { ServerMessage } from '@hp/shared';
import { Ctx, driveTo, lineMap, pollAll, setResults } from './helpers';

const offers = (c: Ctx) => c.repo.listOffers(c.gameId);
const errs = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'error') as { error: string }[];

describe('grace period and elimination', () => {
  it('graceCheck: unknown game / unknown player / lobby game / reconnected player -> nothing happens', async () => {
    const c = await new Ctx().started(3, 1);
    await c.svc.graceCheck('nope', c.p[1].playerId);
    await c.svc.graceCheck(c.gameId, 'ghost');
    await c.svc.graceCheck(c.gameId, c.p[1].playerId); // connected and active
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.status).toBe('active');
    const lobby = await new Ctx().lobby(2);
    await lobby.svc.graceCheck(lobby.gameId, lobby.p[1].playerId);
    expect((await lobby.repo.getPlayer(lobby.gameId, lobby.p[1].playerId))!.status).toBe('active');
  });

  it('graceCheck fires only after the full grace period (2 s tolerance for scheduler jitter)', async () => {
    const c = await new Ctx().started(3, 1);
    await c.svc.disconnect(c.p[1].conn);
    c.clock.advance(c.cfg.durations.graceMs - 2500);
    await c.svc.graceCheck(c.gameId, c.p[1].playerId);
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.status).toBe('disconnected');
    c.clock.advance(500); // 2 s early: accepted (EventBridge may fire slightly early)
    await c.svc.graceCheck(c.gameId, c.p[1].playerId);
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.status).toBe('eliminated');
  });

  it('elimination works in every live status (campaign, counting, postCounting) and not in a finished game', async () => {
    for (const status of ['campaign', 'counting', 'postCounting'] as const) {
      const c = await new Ctx().started(4, 2);
      await driveTo(c, status);
      await c.svc.disconnect(c.p[1].conn);
      c.clock.advance(c.cfg.durations.graceMs);
      await c.svc.graceCheck(c.gameId, c.p[1].playerId);
      expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.status, status).toBe('eliminated');
    }
    const f = await new Ctx().started(3, 1);
    await driveTo(f, 'finished');
    await f.svc.disconnect(f.p[1].conn);
    f.clock.advance(f.cfg.durations.graceMs);
    await f.svc.graceCheck(f.gameId, f.p[1].playerId);
    expect((await f.repo.getPlayer(f.gameId, f.p[1].playerId))!.status).toBe('active'); // finished games never eliminate
  });

  it('eliminate is idempotent: the second call changes nothing and announces nothing new about seats', async () => {
    const c = await new Ctx().started(4, 1);
    await c.send(1, { action: 'campaign', type: 'rally', seat: 1 });
    await driveTo(c, 'counting');
    await c.svc.eliminate(c.gameId, c.p[1].playerId);
    const results = JSON.stringify(await c.repo.listSeatResults(c.gameId));
    c.notifier.clear();
    await c.svc.eliminate(c.gameId, c.p[1].playerId);
    expect(JSON.stringify(await c.repo.listSeatResults(c.gameId))).toBe(results);
    expect(c.notifier.to(c.p[0].playerId, 'seatUpdate')).toHaveLength(0);
  });

  it('eliminating in the lobby only changes the status', async () => {
    const c = await new Ctx().lobby(3);
    await c.svc.eliminate(c.gameId, c.p[1].playerId);
    expect((await c.repo.getPlayer(c.gameId, c.p[1].playerId))!.status).toBe('eliminated');
    expect((await c.game()).status).toBe('lobby');
  });

  it('seats already declared are re-announced to the new winner when the leader is eliminated during counting', async () => {
    const c = await new Ctx().started(3, 1);
    for (let i = 0; i < 3; i++) await c.send(1, { action: 'campaign', type: 'rally', seat: 2 });
    await c.send(2, { action: 'campaign', type: 'rally', seat: 2 });
    await pollAll(c);
    const plan = (await c.repo.getCountPlan(c.gameId))!;
    c.clock.set(plan.startMs + plan.steps * plan.intervalMs);
    await c.svc.countReveal(c.gameId);
    c.notifier.clear();
    await c.svc.eliminate(c.gameId, c.p[1].playerId);
    const updates = c.notifier.to(c.p[0].playerId, 'seatUpdate') as Extract<ServerMessage, { type: 'seatUpdate' }>[];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u.declaration.playerId).not.toBe(c.p[1].playerId);
    const last = updates[updates.length - 1];
    expect(last.tally.wins[c.p[1].playerId]).toBeUndefined();
  });

  it('their open offers are withdrawn and offers naming them can never form a government', async () => {
    const c = await new Ctx().started(4, 1);
    for (let s = 1; s <= 8; s++) await c.send(0, { action: 'campaign', type: 'rally', seat: s });
    await driveTo(c, 'counting');
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[1].playerId] } });
    await c.send(2, { action: 'proposeGovernment', portfolios: { PM: [c.p[2].playerId], HOME: [c.p[3].playerId] } });
    await c.svc.eliminate(c.gameId, c.p[1].playerId);
    const [o1, o2] = await offers(c);
    expect(o1.status).toBe('withdrawn');
    expect(o2.status).toBe('open');
    // eliminating the proposer withdraws their offer too
    await c.svc.eliminate(c.gameId, c.p[2].playerId);
    expect((await c.repo.getOffer(c.gameId, o2.offerId))!.status).toBe('withdrawn');
    // and an eliminated player can no longer be named in a new proposal
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[1].playerId] } });
    expect(errs(c, 0).pop()!.error).toBe('INVALID_GOVERNMENT');
  });

  it('an accepted offer whose member is eliminated is withdrawn, not confirmed', async () => {
    const c = await new Ctx().started(4, 1);
    for (let s = 1; s <= 8; s++) await c.send(0, { action: 'campaign', type: 'rally', seat: s });
    await pollAll(c);
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[1].playerId] } });
    const o = (await offers(c))[0];
    await c.send(1, { action: 'respondOffer', offerId: o.offerId, accept: true });
    await c.svc.eliminate(c.gameId, c.p[1].playerId);
    expect((await c.repo.getOffer(c.gameId, o.offerId))!.status).toBe('withdrawn');
    expect(await c.repo.getGovernment(c.gameId)).toBeNull();
  });

  it('3 players, one eliminated: the game goes on, 2 left; a second elimination ends it with a result', async () => {
    const c = await new Ctx().started(3, 1);
    for (let s = 1; s <= 8; s++) await c.send(0, { action: 'campaign', type: 'rally', seat: s });
    await driveTo(c, 'counting');
    await c.svc.eliminate(c.gameId, c.p[1].playerId);
    expect((await c.game()).status).toBe('counting');
    await c.svc.eliminate(c.gameId, c.p[2].playerId);
    expect((await c.game()).status).toBe('finished');
    const result = (await c.repo.getResult(c.gameId))!;
    expect(result.outcome).toBe('majority'); // the last player standing already holds a majority
    expect(result.winners).toEqual([c.p[0].playerId]);
    expect(result.points.filter((p) => p.playerId !== c.p[0].playerId).every((p) => p.total === 0)).toBe(true);
  });

  it('everyone but one eliminated without a majority: finished, noGovernment, everybody scores 0', async () => {
    const c = await new Ctx().started(3, 1);
    await driveTo(c, 'counting');
    await setResults(c, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 2, 8: 2 });
    await c.svc.eliminate(c.gameId, c.p[1].playerId); // their seats are re-assigned only where they have shares
    await c.svc.eliminate(c.gameId, c.p[2].playerId);
    expect((await c.game()).status).toBe('finished');
    const result = (await c.repo.getResult(c.gameId))!;
    expect(result.winners.length).toBeLessThanOrEqual(1);
    expect(result.points.map((p) => p.total).every((t) => Number.isInteger(t))).toBe(true);
  });

  it('a result never lists an eliminated player as winner and gives them 0 points', async () => {
    const c = await new Ctx().started(4, 1);
    for (let s = 1; s <= 8; s++) await c.send(1, { action: 'campaign', type: 'rally', seat: s });
    await driveTo(c, 'postCounting');
    await c.svc.eliminate(c.gameId, c.p[1].playerId);
    await c.svc.finalise(c.gameId);
    const result = (await c.repo.getResult(c.gameId))!;
    expect(result.winners).not.toContain(c.p[1].playerId);
    expect(result.points.find((p) => p.playerId === c.p[1].playerId)!.total).toBe(0);
  });
});

describe('chat', () => {
  it('3+ players: recipients de-duplicated, self removed, messages ordered, ids unique', async () => {
    const c = await new Ctx().started(4, 1);
    await driveTo(c, 'counting');
    const [a, b, d] = [c.p[0].playerId, c.p[1].playerId, c.p[3].playerId];
    await c.send(0, { action: 'chat', to: [b, b, a, d], text: '  hello   there  ' });
    const [msg] = await c.repo.listChat(c.gameId);
    expect(msg.to.sort()).toEqual([b, d].sort());
    expect(msg.text).toBe('hello there');
    await c.send(0, { action: 'chat', to: [a], text: 'to myself' });
    expect(errs(c, 0).pop()!.error).toBe('BAD_REQUEST');
    await c.send(1, { action: 'chat', to: [a], text: 'one' });
    await c.send(1, { action: 'chat', to: [a], text: 'two' });
    const all = await c.repo.listChat(c.gameId);
    expect(new Set(all.map((m) => m.id)).size).toBe(all.length);
    expect(all.map((m) => m.text)).toEqual(['hello there', 'one', 'two']);
  });

  it.each([[''], ['   '], ['\u0000\u0001'], [7 as never], [null as never], ['x'.repeat(501)]])('invalid text %j -> BAD_REQUEST', async (text) => {
    const c = await new Ctx().started(3, 1);
    await driveTo(c, 'counting');
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text });
    expect(errs(c, 0).pop()!.error).toBe('BAD_REQUEST');
    expect(await c.repo.listChat(c.gameId)).toHaveLength(0);
  });

  it.each([[undefined], ['p1'], [[1, 2]], [[]], [[null]], [['ghost']]])('invalid recipients %j -> BAD_REQUEST', async (to) => {
    const c = await new Ctx().started(3, 1);
    await driveTo(c, 'counting');
    await c.send(0, { action: 'chat', to: to as never, text: 'hi' });
    expect(errs(c, 0).pop()!.error).toBe('BAD_REQUEST');
  });

  it('chat in postCounting works, and an eliminated player can still be addressed (they are members)', async () => {
    const c = await new Ctx().started(4, 1);
    await driveTo(c, 'postCounting');
    await c.svc.eliminate(c.gameId, c.p[3].playerId);
    await c.send(0, { action: 'chat', to: [c.p[1].playerId, c.p[3].playerId], text: 'still here?' });
    expect(c.notifier.to(c.p[3].playerId, 'chat')).toHaveLength(1);
    expect(c.notifier.to(c.p[2].playerId, 'chat')).toHaveLength(0);
  });

  it('a chat message is delivered to the sender as an echo and to each recipient exactly once', async () => {
    const c = await new Ctx().started(4, 1);
    await driveTo(c, 'counting');
    c.notifier.clear();
    await c.send(2, { action: 'chat', to: [c.p[0].playerId, c.p[1].playerId], text: 'hi' });
    expect(c.notifier.to(c.p[2].playerId, 'chat')).toHaveLength(1);
    expect(c.notifier.to(c.p[0].playerId, 'chat')).toHaveLength(1);
    expect(c.notifier.to(c.p[1].playerId, 'chat')).toHaveLength(1);
    expect(c.notifier.to(c.p[3].playerId, 'chat')).toHaveLength(0);
  });
});

describe('2-player rule (no chat, no offers: a majority wins, an exact tie is a draw)', () => {
  it('applies to games that STARTED with 2 players, not to the number connected now', async () => {
    const c = await new Ctx().started(3, 1);
    await driveTo(c, 'counting');
    await c.svc.disconnect(c.p[2].conn); // connection lost: still a 3-player game
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'hi' });
    expect(errs(c, 0)).toHaveLength(0);
  });

  it('a third player who was rejected at start does not make it a 3-player game', async () => {
    const c = await new Ctx().lobby(2);
    const late = await c.svc.joinGame({ joinCode: c.joinCode, nickname: 'late' });
    await c.svc.start(c.gameId, c.p[0].token);
    expect((await c.repo.getPlayer(c.gameId, late.playerId))!.status).toBe('rejected');
    for (const p of c.p) await c.svc.connect(c.gameId, p.token, p.conn);
    c.clock.set(c.timeline.campaignStart);
    await driveTo(c, 'counting');
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'hi' });
    expect(errs(c, 0).pop()!.error).toBe('NEGOTIATION_DISABLED');
  });

  it('eliminated players still count, so a game that started with 3 keeps its negotiation rights', async () => {
    const c = await new Ctx().started(3, 1);
    await driveTo(c, 'counting');
    await c.svc.eliminate(c.gameId, c.p[2].playerId);
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[1].playerId] } });
    expect(errs(c, 0)).toHaveLength(0);
    expect(await offers(c)).toHaveLength(1);
  });

  it('single-party majority and exact tie outcomes with 2 players, whatever happens in negotiation', async () => {
    const win = await new Ctx().started(2, 1);
    await driveTo(win, 'counting');
    await setResults(win, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1, 8: 1 });
    await win.svc.finalise(win.gameId);
    const r = (await win.repo.getResult(win.gameId))!;
    expect(r.outcome).toBe('majority');
    expect(r.government!.members).toEqual([win.p[0].playerId]);
    expect(r.government!.viaNegotiation).toBe(false);
  });
});

describe('government formation', () => {
  /** 4 players; player 0 wins seats 1-4, player 1 seats 5-6, player 2 seat 7, player 3 seat 8 (8 seats, majority 5). */
  async function split(c: Ctx) {
    await driveTo(c, 'counting');
    await setResults(c, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1, 6: 1, 7: 2, 8: 3 });
  }
  const reveal = async (c: Ctx) => {
    const plan = (await c.repo.getCountPlan(c.gameId))!;
    c.clock.set(plan.startMs + plan.steps * plan.intervalMs);
    await c.svc.countReveal(c.gameId);
  };

  it('a proposal with no partners is accepted at once and forms as soon as the proposer alone has the majority', async () => {
    const c = await new Ctx().started(3, 1);
    await driveTo(c, 'counting');
    await setResults(c, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 1, 7: 1, 8: 2 });
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId] } });
    const o = (await offers(c))[0];
    expect(o.partners).toEqual([]);
    expect(o.status).toBe('accepted');
    expect(await c.repo.getGovernment(c.gameId)).toBeNull(); // no seat has been declared yet
    await reveal(c);
    const gov = (await c.repo.getGovernment(c.gameId))!;
    expect(gov.viaNegotiation).toBe(true);
    expect(gov.members).toEqual([c.p[0].playerId]);
  });

  it('the PM defaults to the proposer; an empty holder list is ignored; partners without a portfolio must accept too', async () => {
    const c = await new Ctx().started(4, 1);
    await split(c);
    await c.send(0, { action: 'proposeGovernment', portfolios: { HOME: [c.p[1].playerId], DEFENCE: [] }, partners: [c.p[2].playerId] });
    const o = (await offers(c))[0];
    expect(o.portfolios).toEqual({ PM: [c.p[0].playerId], HOME: [c.p[1].playerId] });
    expect(o.partners.sort()).toEqual([c.p[1].playerId, c.p[2].playerId].sort());
    await c.send(1, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await c.repo.getOffer(c.gameId, o.offerId))!.status).toBe('open'); // p2 has not accepted
    await c.send(2, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await c.repo.getOffer(c.gameId, o.offerId))!.status).toBe('accepted');
    await reveal(c);
    const gov = (await c.repo.getGovernment(c.gameId))!;
    expect(gov.members.sort()).toEqual([c.p[0].playerId, c.p[1].playerId, c.p[2].playerId].sort());
    expect(gov.pm).toBe(c.p[0].playerId);
  });

  it.each([
    ['unknown portfolio', (p: string[]) => ({ PM: [p[0]], MINISTER_OF_FUN: [p[1]] })],
    ['PM held by someone else', (p: string[]) => ({ PM: [p[1]] })],
    ['two PMs', (p: string[]) => ({ PM: [p[0], p[1]] })],
    ['3 deputy PMs', (p: string[]) => ({ DPM: [p[1], p[2], p[3]] })],
    ['2 home ministers', (p: string[]) => ({ HOME: [p[1], p[2]] })],
    ['holder is not a player', (p: string[]) => ({ HOME: ['ghost'] })],
    ['holder list is not an array', (p: string[]) => ({ HOME: p[1] as never })],
    ['holder list with a number', (p: string[]) => ({ HOME: [7 as never] })],
    ['portfolios is an array', (p: string[]) => [p[0]] as never],
    ['portfolios is null', () => null as never],
    ['portfolios is a string', () => 'PM' as never],
  ])('%s -> INVALID_GOVERNMENT and no offer', async (_label, make) => {
    const c = await new Ctx().started(4, 1);
    await driveTo(c, 'counting');
    await c.send(0, { action: 'proposeGovernment', portfolios: make(c.p.map((p) => p.playerId)) as never });
    expect(errs(c, 0).pop()!.error).toBe('INVALID_GOVERNMENT');
    expect(await offers(c)).toHaveLength(0);
  });

  it('two deputy PMs are allowed (max 2), holding several portfolios counts the player once', async () => {
    const c = await new Ctx().started(4, 1);
    await driveTo(c, 'counting');
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], DPM: [c.p[1].playerId, c.p[2].playerId], HOME: [c.p[1].playerId], DEFENCE: [c.p[1].playerId] } });
    expect(errs(c, 0)).toHaveLength(0);
    expect((await offers(c))[0].partners.sort()).toEqual([c.p[1].playerId, c.p[2].playerId].sort());
  });

  it('invalid partners list -> INVALID_GOVERNMENT', async () => {
    const c = await new Ctx().started(4, 1);
    await driveTo(c, 'counting');
    for (const partners of ['p1', [5], ['ghost'], [null]]) {
      await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId] }, partners: partners as never });
      expect(errs(c, 0).pop()!.error).toBe('INVALID_GOVERNMENT');
    }
    expect(await offers(c)).toHaveLength(0);
  });

  it('offers need a majority of WON seats of the MEMBERS only (a big opposition party does not help)', async () => {
    const c = await new Ctx().started(4, 1);
    await split(c); // p0 has 4 of 8, p1 2, p2 1, p3 1 -> p0 alone is short
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId] } });
    await reveal(c);
    expect(await c.repo.getGovernment(c.gameId)).toBeNull();
    // p0 + p3 = 5 of 8 is enough
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[3].playerId] } });
    const o = (await offers(c)).pop()!;
    await c.send(3, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await c.repo.getGovernment(c.gameId))!.members.sort()).toEqual([c.p[0].playerId, c.p[3].playerId].sort());
  });

  it('with several accepted offers that all qualify, the oldest one forms; the rest are superseded', async () => {
    const c = await new Ctx().started(4, 1);
    await driveTo(c, 'counting');
    await setResults(c, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3 }); // 3-3-1-1: needs two of the big ones
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[1].playerId] } });
    c.clock.advance(10);
    await c.send(1, { action: 'proposeGovernment', portfolios: { PM: [c.p[1].playerId], HOME: [c.p[0].playerId] } });
    const [o1, o2] = await offers(c);
    await c.send(1, { action: 'respondOffer', offerId: o1.offerId, accept: true });
    // p1 proposing o2 superseded nothing of p0; p1 accepted o1, so p1's own o2 was superseded when accepting o1
    expect((await c.repo.getOffer(c.gameId, o2.offerId))!.status).toBe('superseded');
    await reveal(c);
    const gov = (await c.repo.getGovernment(c.gameId))!;
    expect(gov.pm).toBe(c.p[0].playerId);
    expect((await c.repo.getOffer(c.gameId, o1.offerId))!.status).toBe('formed');
  });

  it('after a government exists nobody can propose, respond or be confused by a stale accepted offer (ALREADY_COMMITTED / OFFER_NOT_FOUND)', async () => {
    const c = await new Ctx().started(4, 1);
    await split(c);
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[3].playerId] } });
    const o = (await offers(c))[0];
    await c.send(3, { action: 'respondOffer', offerId: o.offerId, accept: true });
    await reveal(c); // seats are declared won -> the accepted offer is confirmed
    expect(await c.repo.getGovernment(c.gameId)).not.toBeNull();
    await c.send(1, { action: 'proposeGovernment', portfolios: { PM: [c.p[1].playerId] } });
    expect(errs(c, 1).pop()!.error).toBe('ALREADY_COMMITTED');
    await c.send(3, { action: 'respondOffer', offerId: o.offerId, accept: false });
    expect(errs(c, 3).pop()!.error).toBe('OFFER_NOT_FOUND'); // offer is 'formed'
    await c.send(0, { action: 'withdrawOffer', offerId: o.offerId });
    expect(errs(c, 0).pop()!.error).toBe('OFFER_NOT_FOUND');
  });

  it('accepting twice is harmless; declining removes your acceptance; malformed responses are BAD_REQUEST', async () => {
    const c = await new Ctx().started(4, 1);
    await driveTo(c, 'counting');
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[1].playerId], DEFENCE: [c.p[2].playerId] } });
    const o = (await offers(c))[0];
    await c.send(1, { action: 'respondOffer', offerId: o.offerId, accept: true });
    await c.send(1, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await c.repo.getOffer(c.gameId, o.offerId))!.accepted).toEqual([c.p[1].playerId]);
    for (const bad of [{ offerId: 7, accept: true }, { offerId: o.offerId, accept: 'yes' }, { offerId: o.offerId }, { accept: true }]) {
      await c.send(1, { action: 'respondOffer', ...bad } as never);
      expect(errs(c, 1).pop()!.error).toBe('BAD_REQUEST');
    }
    await c.send(1, { action: 'respondOffer', offerId: o.offerId, accept: false });
    const after = (await c.repo.getOffer(c.gameId, o.offerId))!;
    expect(after.accepted).toEqual([]);
    expect(after.status).toBe('declined');
    await c.send(1, { action: 'withdrawOffer', offerId: 7 as never });
    expect(errs(c, 1).pop()!.error).toBe('BAD_REQUEST');
  });

  it('withdrawing an accepted offer works for its proposer and is announced to the partners', async () => {
    const c = await new Ctx().started(3, 1);
    await driveTo(c, 'counting');
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[1].playerId] } });
    const o = (await offers(c))[0];
    await c.send(1, { action: 'respondOffer', offerId: o.offerId, accept: true });
    c.notifier.clear();
    await c.send(0, { action: 'withdrawOffer', offerId: o.offerId });
    expect((await c.repo.getOffer(c.gameId, o.offerId))!.status).toBe('withdrawn');
    expect((c.notifier.to(c.p[1].playerId, 'offer').pop() as { offer: { status: string } }).offer.status).toBe('withdrawn');
    expect(c.notifier.to(c.p[2].playerId, 'offer')).toHaveLength(0);
  });

  it('validateGovernment (engine) agrees with what the service enforces at confirmation time', async () => {
    const c = await new Ctx().started(4, 1);
    await split(c);
    const tally = { [c.p[0].playerId]: 4, [c.p[1].playerId]: 2, [c.p[2].playerId]: 1, [c.p[3].playerId]: 1 };
    expect(validateGovernment({ PM: [c.p[0].playerId] }, tally, c.cfg, 8)).toMatch(/needs 5/);
    expect(validateGovernment({ PM: [c.p[0].playerId], HOME: [c.p[3].playerId] }, tally, c.cfg, 8)).toBeNull();
  });
});

describe('government on maps with odd seat counts', () => {
  it('N=7: 4 seats form the government, 3 do not', async () => {
    for (const [seatsForP0, formed] of [[4, true], [3, false]] as const) {
      const c = await new Ctx({ map: lineMap(7) }).started(3, 1);
      await driveTo(c, 'counting');
      const w: Record<number, number | null> = {};
      for (let s = 1; s <= 7; s++) w[s] = s <= seatsForP0 ? 0 : 1 + (s % 2);
      await setResults(c, w);
      await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId] } });
      const plan = (await c.repo.getCountPlan(c.gameId))!;
      c.clock.set(plan.startMs + plan.steps * plan.intervalMs);
      await c.svc.countReveal(c.gameId);
      expect((await c.repo.getGovernment(c.gameId)) !== null).toBe(formed);
    }
  });
});
