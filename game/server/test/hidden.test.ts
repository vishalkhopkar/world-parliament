import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@hp/shared';
import { Ctx } from './helpers';

type Json = unknown;
function walk(v: Json, fn: (key: string | null, value: Json, path: string[]) => void, path: string[] = []): void {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, fn, [...path, String(i)]));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { fn(k, x, [...path, k]); walk(x, fn, [...path, k]); }
  else fn(null, v, path);
}

/** Plays a full game with every kind of action, then audits every outbound message. */
describe('hidden information', () => {
  it('no outbound message leaks roadshows, budgets, effects or other players\' reports/chat/offers', async () => {
    const c = await new Ctx().started(3, 3);
    const [a, b, d] = c.p.map((p) => p.playerId);
    // a: rally + roadshow + report; b: roadshows only; d: rally + global report
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 2 });
    await c.send(1, { action: 'campaign', type: 'roadshow', seat: 7 });
    await c.send(1, { action: 'campaign', type: 'roadshow', seat: 7 });
    await c.send(2, { action: 'campaign', type: 'rally', seat: 5 });
    c.clock.advance(2000);
    await c.send(0, { action: 'buyReport', scope: 'seat', seat: 7 });
    await c.send(2, { action: 'buyReport', scope: 'global' });
    await c.send(1, { action: 'globalReports' }); // b asks for the free news-agency graphs: only b gets them
    // a reconnect mid-campaign produces a fresh hello
    await c.svc.disconnect('c1');
    await c.svc.connect(c.gameId, c.p[1].token, 'c1b');
    c.p[1].conn = 'c1b';
    await c.send(1, { action: 'ping', clientTime: 1 });
    await c.runCampaignToCountingEnd();
    await c.send(0, { action: 'chat', to: [b], text: 'secret deal' });
    await c.send(0, { action: 'proposeGovernment', portfolios: { PM: [a], HOME: [b] } });
    const offer = (await c.repo.listOffers(c.gameId))[0];
    await c.send(1, { action: 'respondOffer', offerId: offer.offerId, accept: true });
    await c.send(2, { action: 'ping', clientTime: 1 }); // d reconnects-like: fresh view mid/post counting
    c.clock.set(c.timeline.postCountingEnd);
    await c.svc.finalise(c.gameId);
    await c.send(2, { action: 'ping', clientTime: 2 });
    await c.svc.connect(c.gameId, c.p[2].token, 'c2b');
    await c.svc.handleMessage('c2b', { action: 'ping', clientTime: 3 });

    const budgets = new Map<string, number>();
    for (const p of c.p) budgets.set(p.playerId, await c.budget(c.p.indexOf(p)));

    const allowedPrivate = new Set(['hello', 'private']);
    for (const p of c.p) {
      const received = c.notifier.log.filter((s) => s.to === p.playerId).map((s) => s.msg);
      expect(received.length).toBeGreaterThan(0);
      for (const m of received) {
        const text = JSON.stringify(m);
        // roadshows are never visible, not even to their owner outside the owner's own private state
        if (!allowedPrivate.has(m.type)) expect(text).not.toContain('roadshow');
        // budget / private data only addressed to its owner
        if (m.type === 'hello') {
          expect(m.private.you).toBe(p.playerId);
          expect(JSON.stringify(m.snapshot)).not.toContain('roadshow');
          expect(JSON.stringify(m.snapshot)).not.toContain('budget');
          // snapshot never holds results of undecided seats
          if (m.snapshot.status === 'campaign') expect(Object.keys(m.snapshot.seats)).toHaveLength(0);
          for (const act of m.private.myActions) expect(['rally', 'roadshow']).toContain(act.type);
        }
        if (m.type === 'private') expect(m.private.you).toBe(p.playerId);
        // nothing but the owner's own messages carries `budget`
        walk(m, (k, v, path) => {
          if (k === 'budget') {
            expect(['actionAck', 'report', 'hello', 'private']).toContain(m.type);
            if (m.type === 'hello') expect(path[0]).toBe('private');
          }
          // own rounded reputation: only on the owner's private state / ack
          if (k === 'reputation') {
            expect(['actionAck', 'hello', 'private']).toContain(m.type);
            if (m.type === 'hello') expect(path[0]).toBe('private');
          }
          // effect totals never appear
          expect(['effect', 'effects', 'roadshows', 'tokenHash', 'token']).not.toContain(k as string);
        });
        // reports, acks and chat go only to the right people
        if (m.type === 'chat') expect([m.message.from, ...m.message.to]).toContain(p.playerId);
        if (m.type === 'offer') expect([m.offer.proposer, ...m.offer.partners]).toContain(p.playerId);
      }
      // each player receives exactly their own acks / reports
      const actions = (await c.repo.listActions(c.gameId)).filter((x) => x.playerId === p.playerId).length;
      expect(received.filter((m) => m.type === 'actionAck')).toHaveLength(actions);
      const reports = await c.repo.listReports(c.gameId, p.playerId);
      expect(received.filter((m) => m.type === 'report')).toHaveLength(reports.length);
      // seat declarations only after counting started
      const types = received.map((m) => m.type);
      const firstSeat = types.indexOf('seatUpdate');
      const statusCounting = received.findIndex((m) => m.type === 'status' && m.status === 'counting');
      expect(firstSeat).toBeGreaterThan(statusCounting);
      expect(statusCounting).toBeGreaterThan(-1);
    }
    // no other player's budget value appears as a `budget` field in someone else's messages
    for (const p of c.p) {
      for (const q of c.p) {
        if (p === q) continue;
        const bq = budgets.get(q.playerId)!;
        if (bq === budgets.get(p.playerId)) continue;
        for (const s of c.notifier.log.filter((x) => x.to === p.playerId)) {
          walk(s.msg, (k, v) => { if (k === 'budget') expect(v).not.toBe(bq); });
        }
      }
    }
    // roadshow-only player b: nobody else saw any news from b
    const news = c.notifier.log.filter((s) => s.msg.type === 'news').map((s) => (s.msg as Extract<ServerMessage, { type: 'news' }>).item);
    expect(news.every((n) => n.playerId !== b)).toBe(true);
    // snapshot news via a fresh hello contains only rallies
    const h = c.notifier.to(d, 'hello').pop() as Extract<ServerMessage, { type: 'hello' }>;
    expect(h.snapshot.news.map((n) => n.playerId).sort()).toEqual([a, d].sort());
    // the global reports went to b alone, hold only the noisy public series and name nobody but the parties of this game
    expect(c.notifier.to(b, 'globalReports')).toHaveLength(1);
    expect(c.notifier.to(a, 'globalReports')).toHaveLength(0);
    expect(c.notifier.to(d, 'globalReports')).toHaveLength(0);
    const gr = c.notifier.to(b, 'globalReports')[0] as Extract<ServerMessage, { type: 'globalReports' }>;
    const grText = JSON.stringify(gr);
    for (const k of ['budget', 'reputation', 'committed', 'effect', 'roadshow', 'token']) expect(grText).not.toContain(k);
    expect(Object.keys(gr.reports).sort()).toEqual(['agencies', 'asOf', 'sampleIntervalMs']);
    for (const ag of gr.reports.agencies) {
      expect(Object.keys(ag).sort()).toEqual(['id', 'name', 'points', 'ranges']);
      expect(Object.keys(ag.ranges).sort()).toEqual([a, b, d].sort());
    }
    // the server-only news secret (seeds the agencies' noise) never reaches anybody, in any message
    const newsSecret = (await c.repo.getGame(c.gameId))!.newsSecret!;
    expect(newsSecret.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(c.notifier.log)).not.toContain(newsSecret);
    expect(JSON.stringify(c.notifier.log)).not.toContain('newsSecret');
    // the other players' reports never reach b
    expect(c.notifier.to(b, 'report')).toHaveLength(0);
    // the chat reached only a and b
    expect(c.notifier.to(d, 'chat')).toHaveLength(0);
    // d is not in the offer between a and b
    expect(c.notifier.to(d, 'offer')).toHaveLength(0);
    expect((h.snapshot.offers)).toHaveLength(0);
  });
});
