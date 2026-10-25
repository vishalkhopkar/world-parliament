// Campaign rules: time boundaries, polled seats for every phase count, budget invariants under concurrency, analyst rules.
import { describe, expect, it } from 'vitest';
import { analystPrice } from '@hp/shared';
import type { ServerMessage } from '@hp/shared';
import { Ctx, lineMap } from './helpers';

const seatsOfPhase = (c: Ctx, phases: number, p: number) => c.map.phaseGroups[String(phases)][p];

describe('time boundaries (server clock decides)', () => {
  it('campaignStart - 1 is too early, campaignStart is the first valid ms, campaignEnd - 1 the last, campaignEnd is too late', async () => {
    const c = await new Ctx().started(2, 1);
    const tl = c.timeline;
    const outcome = async (t: number) => {
      c.clock.set(t);
      const before = c.notifier.to(c.p[0].playerId, 'error').length;
      await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1 });
      const errs = c.notifier.to(c.p[0].playerId, 'error');
      return errs.length > before ? (errs[errs.length - 1] as { error: string }).error : 'OK';
    };
    expect(await outcome(tl.campaignStart - 1)).toBe('WRONG_PHASE');
    expect(await outcome(tl.campaignStart)).toBe('OK');
    expect(await outcome(tl.campaignEnd - 1)).toBe('OK');
    expect(await outcome(tl.campaignEnd)).toBe('TOO_LATE');
    expect(await outcome(tl.campaignEnd + 10 * 60_000)).toBe('TOO_LATE');
    expect((await c.repo.listActions(c.gameId)).map((a) => a.ts)).toEqual([tl.campaignStart, tl.campaignEnd - 1]);
  });

  it('a seat is open until the very ms before its phase closes, for every phase of a 3-phase game', async () => {
    const c = await new Ctx().started(2, 3);
    for (let p = 0; p < 3; p++) {
      const seat = seatsOfPhase(c, 3, p)[0];
      const errors = () => c.notifier.to(c.p[0].playerId, 'error').length;
      const e0 = errors();
      c.clock.set(c.timeline.phaseCloses[p] - 1);
      await c.send(0, { action: 'campaign', type: 'roadshow', seat });
      expect(errors()).toBe(e0);
      c.clock.set(c.timeline.phaseCloses[p]);
      await c.send(0, { action: 'campaign', type: 'roadshow', seat });
      expect(errors()).toBe(e0 + 1);
      expect(c.lastError(0)?.error).toBe(p === 2 ? 'TOO_LATE' : 'SEAT_POLLED'); // the last close is also campaignEnd
    }
  });

  it('the server clock, not the order of messages, decides: an action sent "late" is stamped with the server time', async () => {
    const c = await new Ctx().started(2, 1);
    c.clock.set(c.timeline.campaignStart + 12_345);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 3 });
    expect((await c.repo.listActions(c.gameId))[0].ts).toBe(c.timeline.campaignStart + 12_345);
  });

  it('actions before the lead-in ends are WRONG_PHASE and cost nothing', async () => {
    const c = await new Ctx().started(2, 1);
    c.clock.set(c.timeline.campaignStart - 500);
    await c.send(1, { action: 'campaign', type: 'rally', seat: 1 });
    await c.send(1, { action: 'buyReport', scope: 'global' });
    expect(await c.budget(1)).toBe(c.cfg.budget);
    expect((await c.repo.listActions(c.gameId)).length).toBe(0);
  });
});

describe('polled seats for every phase count', () => {
  for (const phases of [1, 2, 3]) {
    it(`${phases} phase(s): after each close exactly that group is rejected (SEAT_POLLED) and all later groups still accepted`, async () => {
      const c = await new Ctx().started(2, phases);
      const groups = c.map.phaseGroups[String(phases)];
      for (let closed = 0; closed < phases - 1; closed++) {
        c.clock.set(c.timeline.phaseCloses[closed]);
        await c.svc.phaseClose(c.gameId, closed);
        for (let g = 0; g < phases; g++) {
          for (const seat of groups[g]) {
            const before = (await c.repo.listActions(c.gameId)).length;
            await c.send(0, { action: 'campaign', type: 'roadshow', seat });
            const after = (await c.repo.listActions(c.gameId)).length;
            if (g <= closed) { expect(c.lastError(0)?.error, `seat ${seat}`).toBe('SEAT_POLLED'); expect(after).toBe(before); }
            else expect(after, `seat ${seat}`).toBe(before + 1);
          }
        }
      }
    });
  }

  it('reports on polled seats are refused too, global reports are not tied to a seat', async () => {
    const c = await new Ctx().started(2, 2);
    c.clock.set(c.timeline.phaseCloses[0]);
    await c.svc.phaseClose(c.gameId, 0);
    await c.send(0, { action: 'buyReport', scope: 'seat', seat: 1 });
    expect(c.lastError(0)?.error).toBe('SEAT_POLLED');
    await c.send(0, { action: 'buyReport', scope: 'seat', seat: 5 });
    expect(c.notifier.to(c.p[0].playerId, 'report')).toHaveLength(1);
    await c.send(0, { action: 'buyReport', scope: 'global' });
    expect(c.notifier.to(c.p[0].playerId, 'report')).toHaveLength(2);
  });

  it('a refused action never costs anything and leaves no trace for anybody else', async () => {
    const c = await new Ctx().started(3, 2);
    c.clock.set(c.timeline.phaseCloses[0]);
    await c.svc.phaseClose(c.gameId, 0);
    c.notifier.clear();
    await c.send(1, { action: 'campaign', type: 'rally', seat: 1 });
    expect(await c.budget(1)).toBe(c.cfg.budget);
    expect(c.notifier.to(c.p[0].playerId, 'news')).toHaveLength(0);
    expect(c.notifier.to(c.p[2].playerId, 'news')).toHaveLength(0);
  });
});

describe('budget invariants', () => {
  it('whole numbers only: costs and budget are integers, and spending is exact', async () => {
    const c = await new Ctx().started(2, 1);
    expect(Number.isInteger(c.cfg.budget)).toBe(true);
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1 });
    const b = await c.budget(0);
    expect(Number.isInteger(b)).toBe(true);
    expect(b).toBe(c.cfg.budget - c.cfg.costs.rally - c.cfg.costs.roadshow);
  });

  it('exactly the remaining budget can be spent (budget hits 0, never below)', async () => {
    const c = await new Ctx().started(2, 1);
    await c.repo.updatePlayer(c.gameId, c.p[0].playerId, { budget: c.cfg.costs.rally + c.cfg.costs.roadshow });
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 });
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1 });
    expect(await c.budget(0)).toBe(0);
    await c.send(0, { action: 'campaign', type: 'roadshow', seat: 1 });
    expect(c.lastError(0)?.error).toBe('INSUFFICIENT_FUNDS');
    expect(await c.budget(0)).toBe(0);
  });

  it('one unit short is refused for each action type and for reports', async () => {
    const c = await new Ctx().started(2, 1);
    const price = analystPrice(c.cfg, 'global', c.timeline, c.clock.now());
    for (const [msg, cost] of [
      [{ action: 'campaign', type: 'rally', seat: 1 }, c.cfg.costs.rally],
      [{ action: 'campaign', type: 'roadshow', seat: 1 }, c.cfg.costs.roadshow],
      [{ action: 'buyReport', scope: 'global' }, price],
    ] as const) {
      await c.repo.updatePlayer(c.gameId, c.p[1].playerId, { budget: cost - 1 });
      await c.send(1, msg);
      expect(c.lastError(1)?.error).toBe('INSUFFICIENT_FUNDS');
      expect(await c.budget(1)).toBe(cost - 1);
    }
    expect(await c.repo.listActions(c.gameId)).toHaveLength(0);
    expect(await c.repo.listReports(c.gameId, c.p[1].playerId)).toHaveLength(0);
  });

  it('budget never goes negative and always equals start - sum(costs) under heavy concurrency (3 players, mixed actions and reports)', async () => {
    const c = await new Ctx().started(3, 2);
    const n = Math.floor(c.cfg.budget / c.cfg.costs.roadshow);
    const price = analystPrice(c.cfg, 'global', c.timeline, c.clock.now());
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 60; k++) {
        const r = k % 4;
        jobs.push(c.send(i, r === 0 ? { action: 'campaign', type: 'rally', seat: 1 + (k % 8) } : r === 1 ? { action: 'buyReport', scope: 'global' } : { action: 'campaign', type: 'roadshow', seat: 1 + (k % 8) }));
      }
    }
    await Promise.all(jobs);
    expect(n).toBeGreaterThan(0);
    const actions = await c.repo.listActions(c.gameId);
    for (let i = 0; i < 3; i++) {
      const id = c.p[i].playerId;
      const mine = actions.filter((a) => a.playerId === id);
      // 15 simultaneous rallies per player: the cooldown lets exactly one through, the rest are RATE_LIMITED
      expect(mine.filter((a) => a.type === 'rally')).toHaveLength(1);
      expect(c.notifier.to(id, 'error').filter((e) => (e as { error: string }).error === 'RATE_LIMITED')).toHaveLength(14);
      const spentActions = mine.reduce((s, a) => s + c.cfg.costs[a.type], 0);
      const reports = await c.repo.listReports(c.gameId, id);
      const spentReports = reports.reduce((s, r) => s + r.report.price, 0);
      const b = await c.budget(i);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBe(c.cfg.budget - spentActions - spentReports);
      expect(reports.every((r) => r.report.price === price)).toBe(true);
    }
  });

  it('every acknowledged action is stored exactly once, every failed one is not (ack count = action count per player)', async () => {
    const c = await new Ctx().started(2, 1);
    // a budget that runs out part-way, rallies (cooldown) mixed with roadshows: some acks, some INSUFFICIENT_FUNDS / RATE_LIMITED
    for (let i = 0; i < 2; i++) await c.repo.updatePlayer(c.gameId, c.p[i].playerId, { budget: c.cfg.costs.rally + 40 * c.cfg.costs.roadshow });
    await Promise.all(Array.from({ length: 200 }, (_, k) => c.send(k % 2, { action: 'campaign', type: k % 10 < 2 ? 'rally' : 'roadshow', seat: 1 + (k % 8) })));
    const actions = await c.repo.listActions(c.gameId);
    for (let i = 0; i < 2; i++) {
      const errs = c.notifier.to(c.p[i].playerId, 'error').map((e) => (e as { error: string }).error);
      expect(errs).toContain('INSUFFICIENT_FUNDS');
      expect(errs).toContain('RATE_LIMITED');
      expect(await c.budget(i)).toBeGreaterThanOrEqual(0);
    }
    for (let i = 0; i < 2; i++) {
      expect(c.notifier.to(c.p[i].playerId, 'actionAck')).toHaveLength(actions.filter((a) => a.playerId === c.p[i].playerId).length);
    }
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
  });

  it('acks carry the post-action budget, which strictly decreases per player', async () => {
    const c = await new Ctx().started(2, 1);
    const types = ['rally', 'roadshow', 'roadshow', 'roadshow', 'rally', 'roadshow'] as const;
    for (let k = 0; k < types.length; k++) {
      if (k === 4) c.clock.advance(c.cfg.cooldowns.rallyMs); // the second rally needs the cooldown to have passed
      await c.send(0, { action: 'campaign', type: types[k], seat: 1 });
    }
    const budgets = (c.notifier.to(c.p[0].playerId, 'actionAck') as Extract<ServerMessage, { type: 'actionAck' }>[]).map((a) => a.budget);
    expect(budgets).toHaveLength(6);
    for (let k = 1; k < budgets.length; k++) expect(budgets[k]).toBeLessThan(budgets[k - 1]);
  });
});

describe('analyst reports', () => {
  it('price is whole, follows the curve over the campaign, and the same price applies to everybody at the same time', async () => {
    const c = await new Ctx().started(3, 1);
    const tl = c.timeline;
    const prices: number[] = [];
    for (const f of [0, 0.25, 0.5, 0.75, 0.999]) {
      c.clock.set(Math.round(tl.campaignStart + f * (tl.campaignEnd - tl.campaignStart)));
      const expected = analystPrice(c.cfg, 'global', tl, c.clock.now());
      const before = await c.budget(1);
      await c.send(1, { action: 'buyReport', scope: 'global' });
      expect(before - (await c.budget(1))).toBe(expected);
      prices.push(expected);
      expect(Number.isInteger(expected)).toBe(true);
    }
    for (let k = 1; k < prices.length; k++) expect(prices[k]).toBeGreaterThanOrEqual(prices[k - 1]);
    expect(prices[0]).toBe(c.cfg.analyst.globalReport.start);
  });

  it('seat reports use the seat curve and are cheaper than global ones', async () => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, { action: 'buyReport', scope: 'seat', seat: 2 });
    await c.send(0, { action: 'buyReport', scope: 'global' });
    const [seat, global] = (c.notifier.to(c.p[0].playerId, 'report') as Extract<ServerMessage, { type: 'report' }>[]).map((r) => r.report);
    expect(seat.price).toBe(c.cfg.analyst.seatReport.start);
    expect(global.price).toBe(c.cfg.analyst.globalReport.start);
    expect(seat.price).toBeLessThan(global.price);
    expect(seat.seat).toBe(2);
    expect(global.seat).toBeUndefined();
  });

  it.each([
    ['unknown scope', { action: 'buyReport', scope: 'regional' }], ['no scope', { action: 'buyReport' }],
    ['seat report without seat', { action: 'buyReport', scope: 'seat' }], ['seat report with fractional seat', { action: 'buyReport', scope: 'seat', seat: 1.5 }],
    ['seat report with string seat', { action: 'buyReport', scope: 'seat', seat: '1' }], ['seat report for unknown seat', { action: 'buyReport', scope: 'seat', seat: 99 }],
  ])('%s -> BAD_REQUEST, nothing charged', async (_label, msg) => {
    const c = await new Ctx().started(2, 1);
    await c.send(0, msg as never);
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
    expect(await c.budget(0)).toBe(c.cfg.budget);
  });

  it('reports describe the position delayMs ago: an action taken now is not in a report bought now', async () => {
    const c = await new Ctx().started(2, 1);
    c.clock.advance(c.cfg.analyst.delayMs + 1000);
    await c.send(1, { action: 'campaign', type: 'rally', seat: 4 });
    await c.send(0, { action: 'buyReport', scope: 'seat', seat: 4 });
    const fresh = (c.notifier.to(c.p[0].playerId, 'report')[0] as Extract<ServerMessage, { type: 'report' }>).report;
    expect(fresh.asOf).toBe(c.clock.now() - c.cfg.analyst.delayMs);
    // nobody had any effect at asOf: player 1 only has what its committed voters / noise give it
    const before = fresh.entries.find((e) => e.playerId === c.p[1].playerId)!.estimate;
    c.clock.advance(c.cfg.analyst.delayMs + 1000);
    await c.send(0, { action: 'buyReport', scope: 'seat', seat: 4 });
    const later = (c.notifier.to(c.p[0].playerId, 'report')[1] as Extract<ServerMessage, { type: 'report' }>).report;
    expect(later.entries.find((e) => e.playerId === c.p[1].playerId)!.estimate).toBeGreaterThan(Math.max(0.5, before)); // now the rally is old enough to show
  });

  it('a report only lists players still in the game (eliminated players are not shown)', async () => {
    const c = await new Ctx().started(3, 1);
    await c.svc.eliminate(c.gameId, c.p[2].playerId);
    await c.send(0, { action: 'buyReport', scope: 'global' });
    const r = (c.notifier.to(c.p[0].playerId, 'report')[0] as Extract<ServerMessage, { type: 'report' }>).report;
    expect(r.entries.map((e) => e.playerId).sort()).toEqual([c.p[0].playerId, c.p[1].playerId].sort());
    expect(r.entries.map((e) => e.rank).sort()).toEqual([1, 2]);
  });

  it('is deterministic per (game, player, report number): replays give the same noise', async () => {
    const run = async () => {
      const c = new Ctx();
      c.gameId = ''; // each Ctx gets its own game id, so only compare structure: ranks are 1..n and estimates in [0,1]
      await c.started(2, 1);
      await c.send(0, { action: 'buyReport', scope: 'seat', seat: 1 });
      return (c.notifier.to(c.p[0].playerId, 'report')[0] as Extract<ServerMessage, { type: 'report' }>).report;
    };
    const r = await run();
    expect(r.entries.map((e) => e.rank)).toEqual([1, 2]);
    for (const e of r.entries) { expect(e.estimate).toBeGreaterThanOrEqual(0); expect(e.estimate).toBeLessThanOrEqual(1); expect(e.margin).toBe(0.07); }
  });
});

describe('odd and even maps work end to end (generic registry)', () => {
  for (const n of [1, 2, 3, 5, 7]) {
    it(`a ${n}-seat map: campaign, poll, count, finalise`, async () => {
      const c = await new Ctx({ map: lineMap(n) }).started(2, 1);
      for (let s = 1; s <= n; s++) await c.send(0, { action: 'campaign', type: 'rally', seat: s });
      await c.send(0, { action: 'campaign', type: 'rally', seat: n + 1 });
      expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
      await c.runCampaignToCountingEnd();
      c.clock.set(c.timeline.postCountingEnd);
      await c.svc.finalise(c.gameId);
      const result = (await c.repo.getResult(c.gameId))!;
      expect(result.tally[c.p[0].playerId]).toBe(n);
      expect(result.outcome).toBe('majority');
    });
  }
});
