// Designer's rules (FEATURE REQUIREMENTS.docx):
//  - a negotiated government is confirmed only once EVERY seat has been declared; the game then ends at once;
//  - at least one party must stay out of the government (no everyone-in coalitions);
//  - offers say who declined them / which offer superseded them;
//  - the chat window opens at the campaign or at counting (Chat.Campaigning = OFF);
//  - the local timer scheduler stops waiting for the end of post-counting once the game is finished.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { majorityOf } from '@hp/shared';
import type { CoalitionOffer, GameTimeline, ServerMessage } from '@hp/shared';
import { TimerScheduler } from '../src/local/timerScheduler';
import type { GameService } from '../src/core/gameService';
import { stepTime } from '../src/core/counting';
import { Ctx, TEST_CFG, driveTo, lineMap, pollAll } from './helpers';

const offers = (c: Ctx) => c.repo.listOffers(c.gameId);
const errs = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'error') as { error: string; message: string }[];
const msgs = (c: Ctx, i: number, type: string) => c.notifier.to(c.p[i].playerId, type);
const statuses = (c: Ctx, i: number) => (msgs(c, i, 'status') as { status: string }[]).map((m) => m.status);

/** No committed voters, influence or random voters: every seat goes to the only party that campaigned there. */
const PURE = { ...TEST_CFG, voting: { influenceMaxPercent: 0, randomMaxPercent: 0 }, committed: { ...TEST_CFG.committed, bands: [] } };

/**
 * n players on an 8-seat line map (no spill-over): player 0 roadshows seats 1-5 (5 = majority of 8), the others share the rest.
 * Returns with every seat polled and counting at step 0.
 */
async function fiveForP0(n: number, opts: { opensAt?: 'campaign' | 'counting' } = {}): Promise<Ctx> {
  const c = await new Ctx({ map: lineMap(8), cfg: { ...PURE, mapId: 'line', seatCount: 8, chat: { campaigning: opts.opensAt === 'campaign' ? 'INDV' : 'OFF' } } }).started(n, 1);
  for (let s = 1; s <= 8; s++) await c.send(s <= 5 ? 0 : 1 + ((s - 6) % (n - 1)), { action: 'campaign', type: 'roadshow', seat: s });
  await pollAll(c);
  const wins = (await c.repo.listSeatResults(c.gameId)).filter((r) => r.winner === c.p[0].playerId).length;
  expect(wins).toBe(5);
  return c;
}

/** NO party at the majority. 5 players on 8 seats: p0 wins 1-3, p1 4-5, p2 6-7, p3 8, p4 nothing. p1 (PM) + p2 (Home) = 4, short of 5; + p3 = 5. */
async function split(): Promise<Ctx> {
  const c = await new Ctx({ map: lineMap(8), cfg: { ...PURE, mapId: 'line', seatCount: 8, chat: { campaigning: 'OFF' } } }).started(5, 1);
  const owner = [0, 0, 0, 1, 1, 2, 2, 3];
  for (let s = 1; s <= 8; s++) await c.send(owner[s - 1], { action: 'campaign', type: 'roadshow', seat: s });
  await pollAll(c);
  const results = await c.repo.listSeatResults(c.gameId);
  expect(owner.map((o, i) => results.find((r) => r.seat === i + 1)!.winner === c.p[o].playerId)).toEqual(Array(8).fill(true));
  return c;
}

async function propose(c: Ctx, i: number, portfolios: Record<string, number[]>, partners?: number[]): Promise<CoalitionOffer> {
  const ids = (xs: number[]) => xs.map((x) => c.p[x].playerId);
  await c.send(i, { action: 'proposeGovernment', portfolios: Object.fromEntries(Object.entries(portfolios).map(([k, v]) => [k, ids(v)])), ...(partners ? { partners: ids(partners) } : {}) });
  return (await offers(c)).sort((a, b) => a.createdAt - b.createdAt).pop()!;
}

describe('a government forms only after every seat is declared, and then the game ends at once', () => {
  it('stays accepted (no government message) while seats are still being revealed, even with a majority of WON seats', async () => {
    const c = await fiveForP0(4);
    const o = await propose(c, 0, { PM: [0], HOME: [1] });
    await c.send(1, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await c.repo.getOffer(c.gameId, o.offerId))!.status).toBe('accepted');
    const plan = (await c.repo.getCountPlan(c.gameId))!;
    // one step before the last: all but the last seat are declared won
    c.clock.set(stepTime(plan, plan.steps - 1));
    const r = await c.svc.countReveal(c.gameId);
    expect(r.done).toBe(false);
    const ups = msgs(c, 2, 'seatUpdate') as Extract<ServerMessage, { type: 'seatUpdate' }>[];
    const wins = ups[ups.length - 1].tally.wins;
    expect((wins[c.p[0].playerId] ?? 0) + (wins[c.p[1].playerId] ?? 0)).toBeGreaterThanOrEqual(majorityOf(8));
    expect(ups[ups.length - 1].tally.declared).toBeLessThan(8);
    expect(await c.repo.getGovernment(c.gameId)).toBeNull();
    expect((await c.repo.getOffer(c.gameId, o.offerId))!.status).toBe('accepted');
    for (let i = 0; i < 4; i++) expect(msgs(c, i, 'government')).toHaveLength(0);
    expect((await c.game()).status).toBe('counting');
    // a direct evaluation does not jump the gun either
    await c.svc.evaluateOffers(c.gameId);
    expect(await c.repo.getGovernment(c.gameId)).toBeNull();
  });

  it('is confirmed at the last count step: government, then finished + result, each exactly once', async () => {
    const c = await fiveForP0(4);
    const o = await propose(c, 0, { PM: [0], HOME: [1] });
    await c.send(1, { action: 'respondOffer', offerId: o.offerId, accept: true });
    c.notifier.clear();
    const r = await c.runCampaignToCountingEnd();
    expect(r.done).toBe(true);
    const gov = (await c.repo.getGovernment(c.gameId))!;
    expect(gov.pm).toBe(c.p[0].playerId);
    expect(gov.viaNegotiation).toBe(true);
    expect((await c.repo.getOffer(c.gameId, o.offerId))!.status).toBe('formed');
    const game = await c.game();
    expect(game.status).toBe('finished');
    expect(game.finalised).toBe(true);
    expect((await c.repo.getResult(c.gameId))!.outcome).toBe('coalition');
    for (let i = 0; i < 4; i++) {
      expect(msgs(c, i, 'government'), `player ${i}`).toHaveLength(1);
      expect(msgs(c, i, 'result'), `player ${i}`).toHaveLength(1);
      expect(statuses(c, i)).toEqual(['postCounting', 'finished']);
    }
    // the scheduled finalise at postCountingEnd is a no-op; another reveal too
    const before = JSON.stringify(c.notifier.log);
    c.clock.set(c.timeline.postCountingEnd);
    await c.svc.finalise(c.gameId);
    expect(await c.svc.countReveal(c.gameId)).toMatchObject({ done: true });
    expect(JSON.stringify(c.notifier.log)).toBe(before);
  });

  it('in post-counting the acceptance that completes a valid offer forms the government and finishes the game', async () => {
    const c = await split();
    await c.runCampaignToCountingEnd();
    expect((await c.game()).status).toBe('postCounting');
    const o = await propose(c, 1, { PM: [1], HOME: [2], DEFENCE: [3] });
    await c.send(2, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await c.game()).status).toBe('postCounting'); // p3 has not accepted yet
    c.notifier.clear();
    await c.send(3, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect(errs(c, 3)).toHaveLength(0);
    expect((await c.game()).status).toBe('finished');
    expect((await c.repo.getGovernment(c.gameId))!.members.sort()).toEqual([c.p[1].playerId, c.p[2].playerId, c.p[3].playerId].sort());
    for (let i = 0; i < 5; i++) {
      expect(msgs(c, i, 'government')).toHaveLength(1);
      expect(msgs(c, i, 'result')).toHaveLength(1);
      expect(statuses(c, i)).toEqual(['finished']);
    }
    // nothing can be negotiated any more
    await c.send(4, { action: 'proposeGovernment', portfolios: { PM: [c.p[4].playerId] } });
    expect(errs(c, 4).pop()!.error).toBe('WRONG_PHASE');
  });

  it('in post-counting an elimination that gives an accepted offer its majority forms the government and finishes the game', async () => {
    const c = await new Ctx().started(4, 1);
    await driveTo(c, 'postCounting');
    const [a, b, d, e] = c.p.map((p) => p.playerId);
    // a wins 1-4 with b as runner-up; b wins 5-6, d 7, e 8
    await c.repo.putSeatResults(c.gameId, [
      ...[1, 2, 3, 4].map((seat) => ({ seat, phase: 0, winner: a, shares: { [a]: 0.6, [b]: 0.4 } })),
      ...[5, 6].map((seat) => ({ seat, phase: 0, winner: b, shares: { [b]: 1 } })),
      { seat: 7, phase: 0, winner: d, shares: { [d]: 1 } },
      { seat: 8, phase: 0, winner: e, shares: { [e]: 1 } },
    ]);
    const o = await propose(c, 1, { PM: [1], HOME: [2] }); // b + d = 3 seats: short
    await c.send(2, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await c.game()).status).toBe('postCounting');
    await c.svc.eliminate(c.gameId, a); // seats 1-4 go to b: b + d = 7
    expect((await c.repo.getGovernment(c.gameId))!.pm).toBe(b);
    expect((await c.game()).status).toBe('finished');
    expect(msgs(c, 3, 'result')).toHaveLength(1);
  });

  it('an accepted offer short of the majority does not hold the game back: the lone majority party ends it at once', async () => {
    const c = await fiveForP0(4);
    const o = await propose(c, 1, { PM: [1], HOME: [2] });
    await c.send(2, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await c.repo.getOffer(c.gameId, o.offerId))!.status).toBe('accepted');
    await c.runCampaignToCountingEnd();
    expect((await c.game()).status).toBe('finished');
    expect((await c.repo.getResult(c.gameId))!.outcome).toBe('majority');
  });
});

describe('a lone party with a majority of the seats ends the game as soon as every seat is declared', () => {
  it('no offers: finished at the last count step, outcome majority, government = that party, each message once', async () => {
    const c = await fiveForP0(3);
    c.notifier.clear();
    const r = await c.runCampaignToCountingEnd();
    expect(r.done).toBe(true);
    expect((await c.game()).status).toBe('finished');
    const result = (await c.repo.getResult(c.gameId))!;
    expect(result.outcome).toBe('majority');
    expect((await c.repo.getGovernment(c.gameId))!.pm).toBe(c.p[0].playerId);
    for (let i = 0; i < 3; i++) {
      expect(msgs(c, i, 'government'), `player ${i}`).toHaveLength(1);
      expect(msgs(c, i, 'result'), `player ${i}`).toHaveLength(1);
      expect(statuses(c, i)).toEqual(['postCounting', 'finished']);
    }
    const before = JSON.stringify(c.notifier.log);
    c.clock.set(c.timeline.postCountingEnd);
    await c.svc.finalise(c.gameId);
    expect(JSON.stringify(c.notifier.log)).toBe(before);
  });

  it('still waiting while seats are being declared (no early finish before the last step)', async () => {
    const c = await fiveForP0(3);
    const plan = (await c.repo.getCountPlan(c.gameId))!;
    c.clock.set(stepTime(plan, plan.steps - 1));
    expect((await c.svc.countReveal(c.gameId)).done).toBe(false);
    await c.svc.evaluateOffers(c.gameId);
    expect((await c.game()).status).toBe('counting');
    expect(await c.repo.getGovernment(c.gameId)).toBeNull();
  });

  it('a majority that arises from an elimination finishes the game', async () => {
    const c = await new Ctx().started(4, 1);
    await driveTo(c, 'postCounting');
    const [a, b, d, e] = c.p.map((p) => p.playerId);
    await c.repo.putSeatResults(c.gameId, [
      ...[1, 2, 3, 4].map((seat) => ({ seat, phase: 0, winner: b, shares: { [b]: 1 } })),
      { seat: 5, phase: 0, winner: d, shares: { [d]: 0.6, [b]: 0.4 } },
      { seat: 6, phase: 0, winner: e, shares: { [e]: 1 } },
      { seat: 7, phase: 0, winner: e, shares: { [e]: 1 } },
      { seat: 8, phase: 0, winner: a, shares: { [a]: 1 } },
    ]);
    expect((await c.game()).status).toBe('postCounting');
    await c.svc.eliminate(c.gameId, d); // seat 5 goes to b: b = 5
    expect((await c.game()).status).toBe('finished');
    expect((await c.repo.getGovernment(c.gameId))!.pm).toBe(b);
    expect((await c.repo.getResult(c.gameId))!.outcome).toBe('majority');
  });

  it('open and declined offers do not block it', async () => {
    const c = await fiveForP0(4);
    const o1 = await propose(c, 1, { PM: [1], HOME: [2] });
    c.clock.advance(1);
    const o2 = await propose(c, 2, { PM: [2], HOME: [3] });
    await c.send(3, { action: 'respondOffer', offerId: o2.offerId, accept: false });
    expect((await c.repo.getOffer(c.gameId, o1.offerId))!.status).toBe('open');
    expect((await c.repo.getOffer(c.gameId, o2.offerId))!.status).toBe('declined');
    await c.runCampaignToCountingEnd();
    expect((await c.game()).status).toBe('finished');
    expect((await c.repo.getResult(c.gameId))!.outcome).toBe('majority');
  });

  it('an eliminated majority holder does not end the game', async () => {
    const c = await fiveForP0(3);
    await c.svc.eliminate(c.gameId, c.p[0].playerId);
    await c.runCampaignToCountingEnd();
    expect((await c.repo.getResult(c.gameId))?.outcome).not.toBe('majority');
  });

  it('no party at the majority: the game still waits for the post-counting timer (hung parliament)', async () => {
    const c = await new Ctx({ map: lineMap(8), cfg: { ...PURE, mapId: 'line', seatCount: 8, chat: { campaigning: 'OFF' } } }).started(4, 1);
    const owner = [0, 0, 0, 1, 1, 2, 2, 3];
    for (let s = 1; s <= 8; s++) await c.send(owner[s - 1], { action: 'campaign', type: 'roadshow', seat: s });
    await pollAll(c);
    await c.runCampaignToCountingEnd();
    expect((await c.game()).status).toBe('postCounting');
    expect(await c.repo.getResult(c.gameId)).toBeNull();
    c.clock.set(c.timeline.postCountingEnd);
    await c.svc.finalise(c.gameId);
    expect((await c.game()).status).toBe('finished');
    expect((await c.repo.getResult(c.gameId))!.outcome).not.toBe('majority');
  });
});

describe('partners invited without a portfolio count towards the majority', () => {
  it('accepted during counting: confirmed and finished at the last count step', async () => {
    const c = await split();
    const o = await propose(c, 1, { PM: [1], HOME: [2] }, [3]);
    await c.send(2, { action: 'respondOffer', offerId: o.offerId, accept: true });
    await c.send(3, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await c.repo.getOffer(c.gameId, o.offerId))!.status).toBe('accepted');
    c.notifier.clear();
    await c.runCampaignToCountingEnd();
    expect((await c.game()).status).toBe('finished');
    const result = (await c.repo.getResult(c.gameId))!;
    expect(result.outcome).toBe('coalition');
    expect(result.government!.members.sort()).toEqual([1, 2, 3].map((i) => c.p[i].playerId).sort());
    for (let i = 0; i < 5; i++) expect(statuses(c, i)).toEqual(['postCounting', 'finished']);
  });

  it('accepted in post-counting: confirmed and finished at once', async () => {
    const c = await split();
    await c.runCampaignToCountingEnd();
    expect((await c.game()).status).toBe('postCounting');
    const o = await propose(c, 1, { PM: [1], HOME: [2] }, [3]);
    await c.send(2, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await c.game()).status).toBe('postCounting');
    await c.send(3, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await c.game()).status).toBe('finished');
    expect((await c.repo.getResult(c.gameId))!.outcome).toBe('coalition');
  });
});

describe('at least one party must stay out of the government', () => {
  it.each([3, 4])('%i players: every party in the portfolios -> INVALID_GOVERNMENT, no offer', async (n) => {
    const c = await fiveForP0(n);
    const portfolios = n === 3 ? { PM: [0], DPM: [1], HOME: [2] } : { PM: [0], DPM: [1, 2], HOME: [3] };
    await propose(c, 0, portfolios);
    const e = errs(c, 0).pop()!;
    expect(e.error).toBe('INVALID_GOVERNMENT');
    expect(e.message).toMatch(/at least one party must stay out/i);
    expect(await offers(c)).toHaveLength(0);
  });

  it.each([3, 4])('%i players: every party via partners without portfolios -> INVALID_GOVERNMENT', async (n) => {
    const c = await fiveForP0(n);
    await propose(c, 0, { PM: [0], HOME: [1] }, Array.from({ length: n - 2 }, (_, k) => k + 2));
    expect(errs(c, 0).pop()!.error).toBe('INVALID_GOVERNMENT');
    expect(await offers(c)).toHaveLength(0);
  });

  it('a subset is fine; eliminated players do not have to be left out (the remaining contenders count)', async () => {
    const c = await fiveForP0(4);
    await propose(c, 0, { PM: [0], DPM: [1, 2] });
    expect(errs(c, 0)).toHaveLength(0);
    expect(await offers(c)).toHaveLength(1);
    // p3 is eliminated: p0 + p1 + p2 would now be everybody still in the game
    await c.svc.eliminate(c.gameId, c.p[3].playerId);
    await propose(c, 0, { PM: [0], DPM: [1, 2] });
    expect(errs(c, 0).pop()!.error).toBe('INVALID_GOVERNMENT');
    expect(await offers(c)).toHaveLength(1);
    await propose(c, 0, { PM: [0], DPM: [1] });
    expect(errs(c, 0)).toHaveLength(1); // only the error above
    expect((await offers(c)).map((o) => o.status).sort()).toEqual(['open', 'superseded']);
  });

  it('a disconnected player is still a contender who can be the one left out', async () => {
    const c = await fiveForP0(3);
    await c.svc.disconnect(c.p[2].conn);
    await propose(c, 0, { PM: [0], HOME: [1] });
    expect(errs(c, 0)).toHaveLength(0);
    await propose(c, 0, { PM: [0], HOME: [1], DEFENCE: [2] });
    expect(errs(c, 0).pop()!.error).toBe('INVALID_GOVERNMENT');
  });

  it('an accepted offer that covers every remaining contender after an elimination is never confirmed', async () => {
    const c = await split();
    const o = await propose(c, 1, { PM: [1], HOME: [2] }, [3]); // leaves p0 and p4 out: valid when made
    await c.send(2, { action: 'respondOffer', offerId: o.offerId, accept: true });
    await c.send(3, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await c.repo.getOffer(c.gameId, o.offerId))!.status).toBe('accepted');
    await c.svc.eliminate(c.gameId, c.p[0].playerId);
    await c.svc.eliminate(c.gameId, c.p[4].playerId);
    await c.runCampaignToCountingEnd();
    expect(await c.repo.getGovernment(c.gameId)).toBeNull();
    expect((await c.repo.getOffer(c.gameId, o.offerId))!.status).toBe('accepted');
    expect((await c.game()).status).toBe('postCounting');
    c.clock.set(c.timeline.postCountingEnd);
    await c.svc.finalise(c.gameId);
    const result = (await c.repo.getResult(c.gameId))!;
    expect(result.government?.viaNegotiation ?? false).toBe(false);
  });
});

describe('offer bookkeeping: declinedBy and supersededBy', () => {
  it('a new proposal supersedes the old one with its id, and the old partners are told', async () => {
    const c = await fiveForP0(3);
    const o1 = await propose(c, 0, { PM: [0], HOME: [1] });
    c.notifier.clear();
    c.clock.advance(1);
    const o2 = await propose(c, 0, { PM: [0], HOME: [2] });
    expect(o2.offerId).not.toBe(o1.offerId);
    const old = (await c.repo.getOffer(c.gameId, o1.offerId))!;
    expect(old.status).toBe('superseded');
    expect(old.supersededBy).toBe(o2.offerId);
    const told = (msgs(c, 1, 'offer') as { offer: CoalitionOffer }[]).find((m) => m.offer.offerId === o1.offerId)!;
    expect(told.offer).toMatchObject({ status: 'superseded', supersededBy: o2.offerId });
    expect(o2.supersededBy).toBeUndefined();
  });

  it('declining records who declined, delivered to the proposer', async () => {
    const c = await fiveForP0(4);
    const o = await propose(c, 0, { PM: [0], HOME: [1], DEFENCE: [2] });
    c.notifier.clear();
    await c.send(2, { action: 'respondOffer', offerId: o.offerId, accept: false });
    const stored = (await c.repo.getOffer(c.gameId, o.offerId))!;
    expect(stored.status).toBe('declined');
    expect(stored.declinedBy).toBe(c.p[2].playerId);
    const told = (msgs(c, 0, 'offer') as { offer: CoalitionOffer }[]).pop()!;
    expect(told.offer).toMatchObject({ offerId: o.offerId, status: 'declined', declinedBy: c.p[2].playerId });
  });
});

describe('chat window (Chat.Campaigning: GROUP / INDV = from the campaign, OFF = from counting)', () => {
  const ctx = (opensAt: 'campaign' | 'counting', mode: 'GROUP' | 'INDV' = 'GROUP') =>
    new Ctx({ cfg: { ...TEST_CFG, chat: { campaigning: opensAt === 'campaign' ? mode : 'OFF' } } });

  it('opensAt=campaign: refused in the lobby, allowed during the campaign (group and individual modes)', async () => {
    const lobby = await ctx('campaign').lobby(3);
    await lobby.svc.connect(lobby.gameId, lobby.p[0].token, lobby.p[0].conn);
    await lobby.send(0, { action: 'chat', text: 'hi' } as never);
    expect(errs(lobby, 0).pop()).toMatchObject({ error: 'WRONG_PHASE', message: 'Chat opens when the campaign starts' });

    for (const mode of ['GROUP', 'INDV'] as const) {
      const c = await ctx('campaign', mode).started(3, 1);
      c.notifier.clear();
      await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'early bird' });
      expect(errs(c, 0), mode).toHaveLength(0);
      expect(msgs(c, 1, 'chat'), mode).toHaveLength(1);
      expect(await c.repo.listChat(c.gameId)).toHaveLength(1);
    }
  });

  it('opensAt=campaign: proposals stay closed until counting; 2-player games still have no chat', async () => {
    const c = await ctx('campaign').started(3, 1);
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId] } });
    expect(errs(c, 0).pop()!.error).toBe('WRONG_PHASE');
    const two = await ctx('campaign').started(2, 1);
    await two.send(0, { action: 'chat', text: 'hi' } as never);
    expect(errs(two, 0).pop()!.error).toBe('NEGOTIATION_DISABLED');
  });

  it('opensAt=counting: refused during the campaign with the old message, allowed from counting', async () => {
    const c = await ctx('counting').started(3, 1);
    await c.send(0, { action: 'chat', text: 'too soon' } as never);
    expect(errs(c, 0).pop()).toMatchObject({ error: 'WRONG_PHASE', message: 'Chat opens when counting starts' });
    await driveTo(c, 'counting');
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'now' });
    expect(errs(c, 0)).toHaveLength(1);
  });

  it('chat is closed once the game is finished', async () => {
    const c = await ctx('campaign').started(3, 1);
    await driveTo(c, 'finished');
    await c.send(0, { action: 'chat', text: 'gg' } as never);
    expect(errs(c, 0).pop()!.error).toBe('WRONG_PHASE');
  });

  it('a (re)connecting player gets the campaign chat history in hello', async () => {
    const c = await ctx('campaign').started(3, 1);
    await c.send(0, { action: 'chat', text: 'one' } as never);
    await c.send(1, { action: 'chat', text: 'two' } as never);
    await c.svc.connect(c.gameId, c.p[2].token, 'c2new');
    await c.svc.handleMessage('c2new', { action: 'ping', clientTime: 1 });
    const hello = msgs(c, 2, 'hello').pop() as Extract<ServerMessage, { type: 'hello' }>;
    expect(hello.snapshot.status).toBe('campaign');
    expect(hello.chat?.map((m) => m.text)).toEqual(['one', 'two']);
  });
});

describe('isFinished (used by the local scheduler)', () => {
  it('false while the game is running, true once finished or unknown', async () => {
    const c = await split();
    expect(await c.svc.isFinished(c.gameId)).toBe(false);
    await c.runCampaignToCountingEnd();
    expect(await c.svc.isFinished(c.gameId)).toBe(false);
    const o = await propose(c, 1, { PM: [1], HOME: [2] }, [3]);
    await c.send(2, { action: 'respondOffer', offerId: o.offerId, accept: true });
    await c.send(3, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect(await c.svc.isFinished(c.gameId)).toBe(true);
    expect(await c.svc.isFinished('nope')).toBe(true);
  });
});

describe('TimerScheduler stops waiting for postCountingEnd once the game is finished', () => {
  const T0 = 1_000_000;
  const timeline: GameTimeline = { campaignStart: T0 + 100, phaseCloses: [T0 + 1000], campaignEnd: T0 + 1000, countingEnd: T0 + 2000, postCountingEnd: T0 + 60_000 };
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  const stub = (finishedAt: number) => ({
    phaseClose: vi.fn(async () => undefined),
    countReveal: vi.fn(async () => { const done = Date.now() >= T0 + 2000; return { done, nextAtMs: done ? Date.now() : Date.now() + 500 }; }),
    finalise: vi.fn(async () => undefined),
    graceCheck: vi.fn(async () => undefined),
    isFinished: vi.fn(async () => Date.now() >= finishedAt),
  });

  it('finalises within about a second of the game finishing, long before postCountingEnd', async () => {
    const svc = stub(T0 + 5000);
    const s = new TimerScheduler({ now: () => Date.now() });
    s.bind(svc as unknown as GameService);
    await s.startLifecycle('g', timeline);
    await vi.advanceTimersByTimeAsync(4900);
    expect(svc.finalise).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1100);
    expect(svc.finalise).toHaveBeenCalledTimes(1);
    expect(svc.finalise).toHaveBeenCalledWith('g');
    expect(svc.isFinished).toHaveBeenCalledWith('g');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(svc.finalise).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('a game that never finishes early is still finalised exactly at postCountingEnd', async () => {
    const svc = stub(Number.POSITIVE_INFINITY);
    const s = new TimerScheduler({ now: () => Date.now() });
    s.bind(svc as unknown as GameService);
    await s.startLifecycle('g', timeline);
    await vi.advanceTimersByTimeAsync(59_999); // postCountingEnd = T0 + 60 000
    expect(svc.finalise).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(svc.finalise).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('stop() during the post-counting wait prevents finalise', async () => {
    const svc = stub(Number.POSITIVE_INFINITY);
    const s = new TimerScheduler({ now: () => Date.now() });
    s.bind(svc as unknown as GameService);
    await s.startLifecycle('g', timeline);
    await vi.advanceTimersByTimeAsync(10_000);
    s.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(svc.finalise).not.toHaveBeenCalled();
  });
});
