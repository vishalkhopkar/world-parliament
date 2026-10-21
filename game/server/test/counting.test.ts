import { describe, expect, it } from 'vitest';
import { finalResult, majorityGovernment, majorityOf } from '@hp/shared';
import type { SeatDeclaration, ServerMessage } from '@hp/shared';
import { Ctx } from './helpers';

/** Everything polled, counting started (step 0), clock at campaignEnd. */
async function startCounting(c: Ctx) {
  const game = await c.game();
  for (let p = 0; p < game.phases; p++) {
    c.clock.set(c.timeline.phaseCloses[p]);
    await c.svc.phaseClose(c.gameId, p);
  }
  return c.svc.countReveal(c.gameId);
}

/** Player 0 rallies in every seat (phases = 1) so they win all 8 seats. */
async function aWinsAll(c: Ctx) {
  for (let s = 1; s <= 8; s++) await c.send(0, { action: 'campaign', type: 'rally', seat: s });
}

describe('counting', () => {
  it('declares every seat (leading, then won) by the end of counting and the tally adds up', async () => {
    const c = await new Ctx().started(3, 3);
    for (let s = 1; s <= 8; s++) await c.send(s % 3, { action: 'campaign', type: 'rally', seat: s });
    c.notifier.clear();
    const first = await startCounting(c);
    expect(first.done).toBe(false);
    expect((await c.game()).status).toBe('counting');
    expect(c.notifier.to(c.p[0].playerId, 'seatUpdate')).toHaveLength(0);
    expect(first.nextAtMs).toBeGreaterThan(c.timeline.campaignEnd);
    expect(first.nextAtMs).toBeLessThanOrEqual(c.timeline.countingEnd);

    let r = first;
    let calls = 0;
    let lastNext = 0;
    while (!r.done) {
      expect(r.nextAtMs).toBeGreaterThan(lastNext);
      lastNext = r.nextAtMs;
      c.clock.set(r.nextAtMs);
      r = await c.svc.countReveal(c.gameId);
      calls++;
    }
    expect(calls).toBeGreaterThan(3);
    expect(c.clock.now()).toBeLessThanOrEqual(c.timeline.countingEnd);
    expect((await c.game()).status).toBe('postCounting');

    const updates = c.notifier.to(c.p[2].playerId, 'seatUpdate') as Extract<ServerMessage, { type: 'seatUpdate' }>[];
    const seen = new Map<number, string[]>();
    for (const u of updates) seen.set(u.declaration.seat, [...(seen.get(u.declaration.seat) ?? []), u.declaration.status]);
    expect(seen.size).toBe(8);
    for (const statuses of seen.values()) {
      // leads first (they may change their mind: several 'leading' updates), then exactly one 'won' as the last update
      expect(statuses.length).toBeGreaterThanOrEqual(2);
      expect(statuses[statuses.length - 1]).toBe('won');
      expect(statuses.filter((x) => x === 'won')).toHaveLength(1);
      expect(statuses[0]).toBe('leading');
    }
    const last = updates[updates.length - 1];
    expect(last.tally.declared).toBe(8);
    expect(last.tally.total).toBe(8);
    expect(Object.values(last.tally.wins).reduce((a, b) => a + b, 0)).toBe(8);
    expect(Object.values(last.tally.leads).reduce((a, b) => a + b, 0)).toBe(0);
    // tally is monotonic in declared seats
    let prev = 0;
    for (const u of updates) { expect(u.tally.declared).toBeGreaterThanOrEqual(prev); prev = u.tally.declared; }
    // won declarations carry shares summing to 1
    for (const u of updates) {
      if (u.declaration.status === 'won') {
        expect(Object.values(u.declaration.shares!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      } else expect(u.declaration.shares).toBeUndefined();
    }
    // matches stored results
    const stored = await c.repo.listSeatResults(c.gameId);
    for (const u of updates) {
      if (u.declaration.status === 'won') expect(stored.find((s) => s.seat === u.declaration.seat)!.winner).toBe(u.declaration.playerId);
    }
  });

  it('a late count-reveal call catches up, and repeated calls are harmless', async () => {
    const c = await new Ctx().started(2, 1);
    await aWinsAll(c);
    await startCounting(c);
    c.notifier.clear();
    c.clock.set(c.timeline.countingEnd + 500);
    const r = await c.svc.countReveal(c.gameId);
    expect(r.done).toBe(true);
    const n = c.notifier.to(c.p[1].playerId, 'seatUpdate').length;
    expect(n).toBe(16);
    await c.svc.countReveal(c.gameId);
    expect(c.notifier.to(c.p[1].playerId, 'seatUpdate').length).toBe(n);
  });

  it('a reconnecting player gets declarations so far in the hello snapshot', async () => {
    const c = await new Ctx().started(2, 1);
    await aWinsAll(c);
    await startCounting(c);
    const plan = (await c.repo.getCountPlan(c.gameId))!;
    c.clock.set(plan.startMs + Math.floor(0.9 * plan.steps) * plan.intervalMs); // confirmed wins only start at 75 %
    await c.svc.countReveal(c.gameId);
    await c.svc.connect(c.gameId, c.p[1].token, 'c1new');
    await c.svc.handleMessage('c1new', { action: 'ping', clientTime: 1 });
    const hello = c.notifier.to(c.p[1].playerId, 'hello').pop() as any;
    expect(hello.snapshot.status).toBe('counting');
    const decl = Object.values(hello.snapshot.seats) as SeatDeclaration[];
    expect(decl.length).toBeGreaterThan(0);
    expect(hello.snapshot.tally.declared).toBe(decl.filter((d) => d.status === 'won').length);
    expect(hello.snapshot.polledPhases).toEqual([0]);
  });
});

describe('chat', () => {
  it('only during counting, 500 chars max, valid recipients, delivered only to sender and recipients', async () => {
    const c = await new Ctx().started(3, 1);
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'too early' });
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
    await aWinsAll(c);
    await startCounting(c);
    c.notifier.clear();
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'join me' });
    expect(c.notifier.to(c.p[0].playerId, 'chat')).toHaveLength(1);
    expect(c.notifier.to(c.p[1].playerId, 'chat')).toHaveLength(1);
    expect(c.notifier.to(c.p[2].playerId, 'chat')).toHaveLength(0);
    expect((await c.repo.listChat(c.gameId)).map((m) => m.text)).toEqual(['join me']);
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'x'.repeat(501) });
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
    await c.send(0, { action: 'chat', to: ['nobody'], text: 'hi' });
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
    await c.send(0, { action: 'chat', to: [], text: 'hi' });
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
    await c.send(0, { action: 'chat', to: [c.p[1].playerId, c.p[2].playerId], text: 'x'.repeat(500) });
    expect(c.notifier.to(c.p[2].playerId, 'chat')).toHaveLength(1);
  });
});

describe('coalition', () => {
  const allThree = (c: Ctx) => ({ PM: [c.p[0].playerId], DPM: [c.p[1].playerId], HOME: [c.p[2].playerId] });

  it('rejects offers outside counting and invalid portfolios', async () => {
    const c = await new Ctx().started(3, 1);
    await c.send(0, { action: 'proposeGovernment', portfolios: allThree(c) });
    expect(c.lastError(0)?.error).toBe('WRONG_PHASE');
    await aWinsAll(c);
    await startCounting(c);
    const bad = async (portfolios: Record<string, string[]>) => {
      await c.send(0, { action: 'proposeGovernment', portfolios });
      return c.lastError(0)?.error;
    };
    expect(await bad({ PM: [c.p[1].playerId] })).toBe('INVALID_GOVERNMENT'); // proposer must be PM
    expect(await bad({ PM: [c.p[0].playerId, c.p[1].playerId] })).toBe('INVALID_GOVERNMENT');
    expect(await bad({ PM: [c.p[0].playerId], MAGIC: [c.p[1].playerId] })).toBe('INVALID_GOVERNMENT');
    expect(await bad({ PM: [c.p[0].playerId], HOME: [c.p[1].playerId, c.p[2].playerId] })).toBe('INVALID_GOVERNMENT'); // max 1
    expect(await bad({ PM: [c.p[0].playerId], HOME: ['ghost'] })).toBe('INVALID_GOVERNMENT');
    expect(await bad({ DPM: [c.p[1].playerId, c.p[2].playerId, c.p[0].playerId] })).toBe('INVALID_GOVERNMENT'); // DPM max 2
    expect(await c.repo.listOffers(c.gameId)).toHaveLength(0);
  });

  it('forms only when the members have a majority of WON seats; stays accepted until then', async () => {
    const c = await new Ctx().started(3, 3);
    for (let s = 1; s <= 8; s++) await c.send(s % 3, { action: 'campaign', type: 'rally', seat: s });
    await startCounting(c);
    await c.send(0, { action: 'proposeGovernment', portfolios: allThree(c) });
    const offer = (await c.repo.listOffers(c.gameId))[0];
    expect(offer.partners.sort()).toEqual([c.p[1].playerId, c.p[2].playerId].sort());
    expect(offer.status).toBe('open');
    // partners only
    expect(c.notifier.to(c.p[1].playerId, 'offer').length).toBeGreaterThan(0);
    await c.send(1, { action: 'respondOffer', offerId: offer.offerId, accept: true });
    expect((await c.repo.getOffer(c.gameId, offer.offerId))!.status).toBe('open');
    await c.send(2, { action: 'respondOffer', offerId: offer.offerId, accept: true });
    // everyone accepted, but no seat has been declared won yet
    expect((await c.repo.getOffer(c.gameId, offer.offerId))!.status).toBe('accepted');
    expect(await c.repo.getGovernment(c.gameId)).toBeNull();
    // run the count: confirmed automatically as soon as the won seats reach the majority (5 of 8)
    let r = await c.svc.countReveal(c.gameId);
    let govAtWins = -1;
    while (!r.done) {
      c.clock.set(r.nextAtMs);
      r = await c.svc.countReveal(c.gameId);
      const gov = await c.repo.getGovernment(c.gameId);
      if (gov && govAtWins < 0) {
        const ups = c.notifier.to(c.p[0].playerId, 'seatUpdate') as any[];
        govAtWins = ups[ups.length - 1].tally.wins ? Object.values(ups[ups.length - 1].tally.wins as Record<string, number>).reduce((a, b) => a + b, 0) : 0;
      }
    }
    const gov = await c.repo.getGovernment(c.gameId);
    expect(gov).not.toBeNull();
    expect(gov!.pm).toBe(c.p[0].playerId);
    expect(gov!.viaNegotiation).toBe(true);
    expect(govAtWins).toBeGreaterThanOrEqual(majorityOf(8));
    expect((await c.repo.getOffer(c.gameId, offer.offerId))!.status).toBe('formed');
    expect(c.notifier.to(c.p[2].playerId, 'government')).toHaveLength(1);
  });

  it('a coalition without a majority of seats is never confirmed', async () => {
    const c = await new Ctx().started(3, 1);
    await aWinsAll(c); // player 0 holds all seats; 1 + 2 have none
    await startCounting(c);
    await c.send(1, { action: 'proposeGovernment', portfolios: { PM: [c.p[1].playerId], HOME: [c.p[2].playerId] } });
    const offer = (await c.repo.listOffers(c.gameId))[0];
    await c.send(2, { action: 'respondOffer', offerId: offer.offerId, accept: true });
    c.clock.set(c.timeline.countingEnd);
    await c.svc.countReveal(c.gameId);
    expect(await c.repo.getGovernment(c.gameId)).toBeNull();
    expect((await c.repo.getOffer(c.gameId, offer.offerId))!.status).toBe('accepted');
  });

  it('accepting a second offer drops the first acceptance', async () => {
    const c = await new Ctx().started(3, 1);
    await aWinsAll(c);
    await startCounting(c);
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], DPM: [c.p[1].playerId] } });
    await c.send(2, { action: 'proposeGovernment', portfolios: { PM: [c.p[2].playerId], DPM: [c.p[1].playerId] } });
    const [o1, o2] = await c.repo.listOffers(c.gameId);
    expect(o1.proposer).toBe(c.p[0].playerId);
    await c.send(1, { action: 'respondOffer', offerId: o1.offerId, accept: true });
    expect((await c.repo.getOffer(c.gameId, o1.offerId))!.status).toBe('accepted');
    await c.send(1, { action: 'respondOffer', offerId: o2.offerId, accept: true });
    const a = (await c.repo.getOffer(c.gameId, o1.offerId))!;
    const b = (await c.repo.getOffer(c.gameId, o2.offerId))!;
    expect(a.accepted).toEqual([]);
    expect(a.status).toBe('open');
    expect(b.accepted).toEqual([c.p[1].playerId]);
    expect(b.status).toBe('accepted');
    // the proposer of the first offer is told
    const lastOffer = c.notifier.to(c.p[0].playerId, 'offer').pop() as any;
    expect(lastOffer.offer.offerId).toBe(o1.offerId);
    expect(lastOffer.offer.status).toBe('open');
  });

  it('proposing a new offer supersedes your previous one; only the proposer can withdraw; decline kills the offer', async () => {
    const c = await new Ctx().started(3, 1);
    await aWinsAll(c);
    await startCounting(c);
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[1].playerId] } });
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[2].playerId] } });
    const [o1, o2] = await c.repo.listOffers(c.gameId);
    expect(o1.status).toBe('superseded');
    expect(o2.status).toBe('open');
    await c.send(2, { action: 'withdrawOffer', offerId: o2.offerId });
    expect(c.lastError(2)?.error).toBe('OFFER_NOT_FOUND');
    await c.send(1, { action: 'respondOffer', offerId: o2.offerId, accept: true });
    expect(c.lastError(1)?.error).toBe('OFFER_NOT_FOUND'); // not a partner
    await c.send(2, { action: 'respondOffer', offerId: o2.offerId, accept: false });
    expect((await c.repo.getOffer(c.gameId, o2.offerId))!.status).toBe('declined');
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [c.p[0].playerId], HOME: [c.p[2].playerId] } });
    const o3 = (await c.repo.listOffers(c.gameId)).pop()!;
    await c.send(0, { action: 'withdrawOffer', offerId: o3.offerId });
    expect((await c.repo.getOffer(c.gameId, o3.offerId))!.status).toBe('withdrawn');
  });

  it('the first confirmed government wins even with concurrent evaluation', async () => {
    const c = await new Ctx().started(3, 1);
    await aWinsAll(c);
    await startCounting(c);
    await c.send(1, { action: 'proposeGovernment', portfolios: { PM: [c.p[1].playerId], DPM: [c.p[0].playerId] } });
    const o = (await c.repo.listOffers(c.gameId))[0];
    await c.send(0, { action: 'respondOffer', offerId: o.offerId, accept: true });
    c.clock.set(c.timeline.countingEnd);
    await Promise.all([1, 2, 3, 4].map(() => c.svc.countReveal(c.gameId)));
    await Promise.all([1, 2, 3].map(() => c.svc.evaluateOffers(c.gameId)));
    const gov = await c.repo.getGovernment(c.gameId);
    expect(gov!.pm).toBe(c.p[1].playerId);
    expect(c.notifier.to(c.p[0].playerId, 'government')).toHaveLength(1);
    // the repo primitive: second write loses
    expect(await c.repo.putGovernmentIfAbsent(c.gameId, majorityGovernment(c.p[2].playerId, c.cfg, 1))).toBe(false);
    expect((await c.repo.getGovernment(c.gameId))!.pm).toBe(c.p[1].playerId);
    // no more offers once a government exists
    await c.send(2, { action: 'proposeGovernment', portfolios: { PM: [c.p[2].playerId] } });
    expect(c.lastError(2)?.error).toBe('ALREADY_COMMITTED');
  });
});

describe('finalise', () => {
  it('single-party majority without negotiation -> outcome majority; idempotent', async () => {
    const c = await new Ctx().started(3, 1);
    await aWinsAll(c);
    await c.runCampaignToCountingEnd();
    c.clock.set(c.timeline.postCountingEnd);
    await c.svc.finalise(c.gameId);
    const result = (await c.repo.getResult(c.gameId))!;
    expect(result.outcome).toBe('majority');
    expect(result.winners).toEqual([c.p[0].playerId]);
    expect(result.government!.viaNegotiation).toBe(false);
    expect((await c.game()).status).toBe('finished');
    const expected = finalResult(
      { [c.p[0].playerId]: 8 }, result.government, c.p.map((p) => p.playerId), new Set(), c.cfg, 8,
    );
    expect(result).toEqual({ ...expected, government: result.government });
    const before = JSON.stringify(c.notifier.log);
    await c.svc.finalise(c.gameId);
    await c.svc.finalise(c.gameId, { error: true });
    expect(JSON.stringify(c.notifier.log)).toBe(before);
    expect(c.notifier.to(c.p[1].playerId, 'result')).toHaveLength(1);
  });

  it('coalition outcome matches finalResult; winner decided by points', async () => {
    const c = await new Ctx().started(3, 1);
    await aWinsAll(c);
    await c.runCampaignToCountingEnd();
    await c.send(1, { action: 'proposeGovernment', portfolios: { PM: [c.p[1].playerId], DPM: [c.p[0].playerId] } });
    const o = (await c.repo.listOffers(c.gameId))[0];
    await c.send(0, { action: 'respondOffer', offerId: o.offerId, accept: true });
    // all seats are declared: confirmed at acceptance
    const gov = (await c.repo.getGovernment(c.gameId))!;
    expect(gov.pm).toBe(c.p[1].playerId);
    c.clock.set(c.timeline.postCountingEnd);
    await c.svc.finalise(c.gameId);
    const result = (await c.repo.getResult(c.gameId))!;
    const expected = finalResult({ [c.p[0].playerId]: 8 }, gov, c.p.map((p) => p.playerId), new Set(), c.cfg, 8);
    expect(result).toEqual(expected);
    expect(result.outcome).toBe('coalition');
    expect(result.winners).toEqual([c.p[0].playerId]); // 200 seat points + 50 DPM + 10 vs PM 100 + 10
  });

  it('no majority and no government -> noGovernment', async () => {
    const c = await new Ctx().started(3, 3);
    // P0 wins 1,2,7; P1 wins 3,4,6,8; P2 wins 5 -> nobody has 5 of 8
    for (const [i, s] of [[0, 1], [0, 7], [1, 3], [1, 8], [1, 6], [2, 5]]) await c.send(i, { action: 'campaign', type: 'rally', seat: s });
    await c.runCampaignToCountingEnd();
    const tally = Object.values((await c.repo.listSeatResults(c.gameId)).reduce<Record<string, number>>((t, r) => {
      if (r.winner) t[r.winner] = (t[r.winner] ?? 0) + 1;
      return t;
    }, {}));
    expect(Math.max(...tally)).toBeLessThan(majorityOf(8)); // rally pattern spreads the seats
    c.clock.set(c.timeline.postCountingEnd);
    await c.svc.finalise(c.gameId);
    const result = (await c.repo.getResult(c.gameId))!;
    expect(result.outcome).toBe('noGovernment');
    expect(result.winners).toEqual([]);
    expect(result.points.every((p) => p.total === 0)).toBe(true);
  });

  it('finalise with error=true on a half-finished game still produces a result', async () => {
    const c = await new Ctx().started(2, 2);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    await c.svc.finalise(c.gameId, { error: true });
    expect((await c.game()).status).toBe('finished');
    expect(await c.repo.getResult(c.gameId)).not.toBeNull();
    expect((await c.repo.listSeatResults(c.gameId)).length).toBe(8);
  });
});
