import { describe, expect, it } from 'vitest';
import { Ctx } from './helpers';

async function toCounting(c: Ctx, rallies: [number, number][]) {
  for (const [i, s] of rallies) await c.send(i, { action: 'campaign', type: 'rally', seat: s });
  await c.runCampaignToCountingEnd();
}
const all = (i: number) => [...Array(8)].map((_, k): [number, number] => [i, k + 1]);

describe('2-player games have no negotiation', () => {
  it('rejects chat and government proposals/responses with NEGOTIATION_DISABLED', async () => {
    const c = await new Ctx().started(2, 1);
    await toCounting(c, all(0));
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'deal?' });
    expect(c.lastError(0)?.error).toBe('NEGOTIATION_DISABLED');
    expect(await c.repo.listChat(c.gameId)).toHaveLength(0);
    await c.send(1, { action: 'proposeGovernment', portfolios: { PM: [c.p[1].playerId], DPM: [c.p[0].playerId] } });
    expect(c.lastError(1)?.error).toBe('NEGOTIATION_DISABLED');
    await c.send(0, { action: 'respondOffer', offerId: 'x', accept: true });
    expect(c.lastError(0)?.error).toBe('NEGOTIATION_DISABLED');
    await c.send(0, { action: 'withdrawOffer', offerId: 'x' });
    expect(c.lastError(0)?.error).toBe('NEGOTIATION_DISABLED');
    expect(await c.repo.listOffers(c.gameId)).toHaveLength(0);
  });

  it('finalise still gives a majority outcome', async () => {
    const c = await new Ctx().started(2, 1);
    await toCounting(c, all(0));
    c.clock.set(c.timeline.postCountingEnd);
    await c.svc.finalise(c.gameId);
    const r = (await c.repo.getResult(c.gameId))!;
    expect(r.outcome).toBe('majority');
    expect(r.winners).toEqual([c.p[0].playerId]);
  });

  it('finalise gives a draw on an exact tie', async () => {
    const c = await new Ctx().started(2, 1);
    await toCounting(c, all(0));
    // force an exact 4-4 split of the stored seat results
    const rs = await c.repo.listSeatResults(c.gameId);
    await c.repo.putSeatResults(c.gameId, rs.map((r) => ({ ...r, winner: (r.seat <= 4 ? c.p[0] : c.p[1]).playerId })));
    c.clock.set(c.timeline.postCountingEnd);
    await c.svc.finalise(c.gameId);
    const r = (await c.repo.getResult(c.gameId))!;
    expect(r.outcome).toBe('draw');
    expect(r.winners).toHaveLength(2);
  });

  it('3-player games can still chat and propose', async () => {
    const c = await new Ctx().started(3, 1);
    await toCounting(c, all(0));
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'deal?' });
    expect(c.notifier.to(c.p[1].playerId, 'chat')).toHaveLength(1);
    await c.send(1, { action: 'proposeGovernment', portfolios: { PM: [c.p[1].playerId], DPM: [c.p[0].playerId] } });
    expect(await c.repo.listOffers(c.gameId)).toHaveLength(1);
  });
});
