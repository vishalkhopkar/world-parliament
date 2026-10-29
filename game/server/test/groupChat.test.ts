// Chat modes per stage (Chat.Campaigning; counting and post-counting are always INDV): GROUP = ONE common chat everybody reads in the campaign, with
// "@Party name" tags (mentions); INDV = one-to-one messages only. Offers carry a log of what each party did ("Accepted").
import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG } from '@hp/shared';
import type { ChatMessage, CoalitionOffer, MapConfig, ServerMessage } from '@hp/shared';
import { Ctx, TEST_CFG, driveTo } from './helpers';

const ctx = (campaigning: MapConfig['chat']['campaigning']) =>
  new Ctx({ cfg: { ...TEST_CFG, chat: { campaigning } } });
const group = () => ctx('GROUP');
const individual = () => ctx('OFF');
const shipped = () => ctx(WORLD_CONFIG.chat.campaigning);
const errs = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'error') as { error: string; message: string }[];
const chats = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'chat') as Extract<ServerMessage, { type: 'chat' }>[];
const offers = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'offer') as Extract<ServerMessage, { type: 'offer' }>[];
const hello = async (c: Ctx, i: number) => {
  const p = (await c.repo.getPlayer(c.gameId, c.p[i].playerId))!;
  return (await c.svc.hello(p)) as Extract<ServerMessage, { type: 'hello' }>;
};
const partyName = async (c: Ctx, i: number) => (await c.repo.getPlayer(c.gameId, c.p[i].playerId))!.party!.name;

describe('the shipped modes: one group chat during the campaign, one-to-one chats from counting', () => {
  it('the default config is GROUP then INDV', () => { expect(WORLD_CONFIG.chat).toEqual({ campaigning: 'GROUP' }); });

  it('during the campaign a message goes to everybody (channel group); from counting only to the one recipient (channel direct)', async () => {
    const c = await shipped().started(3, 1);
    c.notifier.clear();
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'campaign hello' });
    for (let i = 0; i < 3; i++) expect(chats(c, i), `player ${i}`).toHaveLength(1);
    expect(chats(c, 2)[0].message.channel).toBe('group');
    await driveTo(c, 'counting');
    c.notifier.clear();
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'counting deal' });
    expect(chats(c, 0)).toHaveLength(1);
    expect(chats(c, 1)).toHaveLength(1);
    expect(chats(c, 2)).toHaveLength(0);
    expect(chats(c, 1)[0].message).toMatchObject({ channel: 'direct', to: [c.p[1].playerId], text: 'counting deal' });
  });

  it('from counting a message needs a recipient (the group chat has closed)', async () => {
    const c = await shipped().started(3, 1);
    await driveTo(c, 'counting');
    await c.send(0, { action: 'chat', text: 'to all?' } as never);
    expect(errs(c, 0).pop()!.error).toBe('BAD_REQUEST');
  });
});

describe('group chat (GROUP)', () => {
  it('every member reads every message, whoever it was "to"; the sender gets one echo', async () => {
    const c = await group().started(4, 1);
    c.notifier.clear();
    await c.send(2, { action: 'chat', to: [c.p[0].playerId], text: 'hello everyone' });
    for (let i = 0; i < 4; i++) expect(chats(c, i), `player ${i}`).toHaveLength(1);
    const m = chats(c, 3)[0].message;
    expect(m).toMatchObject({ from: c.p[2].playerId, text: 'hello everyone', channel: 'group' });
    expect(m.mentions).toBeUndefined();
    expect(m.to.sort()).toEqual([c.p[0].playerId, c.p[1].playerId, c.p[3].playerId].sort());
  });

  it('"@Party name" tags fill mentions (whole names, case-insensitive, never the sender), stored and in hello', async () => {
    const c = await group().started(4, 1);
    const [n0, n1, n3] = [await partyName(c, 0), await partyName(c, 1), await partyName(c, 3)];
    await c.send(0, { action: 'chat', text: `@${n1.toLowerCase()} and @${n3}, not @${n0} (me) - @${n1} again` } as never);
    const m = chats(c, 2)[0].message;
    expect(m.mentions).toEqual([c.p[1].playerId, c.p[3].playerId]);
    expect((await c.repo.listChat(c.gameId))[0].mentions).toEqual(m.mentions);
    expect((await hello(c, 1)).chat![0].mentions).toEqual(m.mentions);
  });

  it('recipients need not be given at all (the whole table is the audience)', async () => {
    const c = await group().started(3, 1);
    c.notifier.clear();
    await c.send(0, { action: 'chat', text: 'no to field' } as never);
    expect(errs(c, 0)).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect(chats(c, i)).toHaveLength(1);
    await c.send(1, { action: 'chat', to: [], text: 'empty to' });
    expect(errs(c, 1)).toHaveLength(0);
    expect(chats(c, 2)).toHaveLength(2);
  });

  it('in postCounting the chat is one-to-one even with a GROUP campaign, and reaches an eliminated player (a member)', async () => {
    const c = await group().started(4, 1);
    await driveTo(c, 'postCounting');
    await c.svc.eliminate(c.gameId, c.p[3].playerId);
    c.notifier.clear();
    await c.send(0, { action: 'chat', text: 'still here?' } as never);
    expect(errs(c, 0).pop()!.error).toBe('BAD_REQUEST');
    await c.send(0, { action: 'chat', to: [c.p[3].playerId], text: 'still here?' });
    expect(chats(c, 3)).toHaveLength(1);
    expect(chats(c, 2)).toHaveLength(0);
  });

  it('keeps the rules: phase, 3+ players, text validation', async () => {
    const lobby = await group().lobby(3);
    await lobby.svc.connect(lobby.gameId, lobby.p[0].token, lobby.p[0].conn);
    await lobby.send(0, { action: 'chat', text: 'too soon' } as never);
    expect(errs(lobby, 0).pop()).toMatchObject({ error: 'WRONG_PHASE', message: 'Chat opens when the campaign starts' });

    const two = await group().started(2, 1);
    await driveTo(two, 'counting');
    await two.send(0, { action: 'chat', text: 'hi' } as never);
    expect(errs(two, 0).pop()!.error).toBe('NEGOTIATION_DISABLED');

    const c = await group().started(3, 1);
    for (const text of ['', '   ', 7 as never, 'x'.repeat(501)]) {
      await c.send(0, { action: 'chat', text } as never);
      expect(errs(c, 0).pop()!.error).toBe('BAD_REQUEST');
    }
    expect(await c.repo.listChat(c.gameId)).toHaveLength(0);
  });

  it('a (re)connecting player gets the whole conversation in hello, oldest first', async () => {
    const c = await group().started(3, 1);
    await c.send(0, { action: 'chat', text: 'one' } as never);
    await c.send(1, { action: 'chat', text: 'two' } as never);
    await c.send(2, { action: 'chat', text: 'three' } as never);
    for (let i = 0; i < 3; i++) expect((await hello(c, i)).chat?.map((m) => m.text), `player ${i}`).toEqual(['one', 'two', 'three']);
  });

  it('hello carries a bounded history (newest kept) so it stays under the WebSocket frame limit', async () => {
    const c = await group().started(3, 1);
    const long = 'y'.repeat(480);
    for (let k = 0; k < 60; k++) await c.send(k % 3, { action: 'chat', text: `${k} ${long}` } as never);
    const h = await hello(c, 0);
    const texts = h.chat!.map((m: ChatMessage) => m.text);
    expect(texts.length).toBeLessThan(60);
    expect(texts.length).toBeGreaterThan(5);
    expect(texts[texts.length - 1].startsWith('59 ')).toBe(true);
    expect(JSON.stringify(h.chat).length).toBeLessThanOrEqual(15_000);
  });
});

describe('one-to-one chats (INDV)', () => {
  it('deliver only to the chosen recipient and the sender', async () => {
    const c = await individual().started(4, 1);
    await driveTo(c, 'counting');
    c.notifier.clear();
    await c.send(2, { action: 'chat', to: [c.p[0].playerId], text: 'psst' });
    expect(chats(c, 2)).toHaveLength(1);
    expect(chats(c, 0)).toHaveLength(1);
    expect(chats(c, 1)).toHaveLength(0);
    expect(chats(c, 3)).toHaveLength(0);
    await c.send(2, { action: 'chat', text: 'no recipients' } as never);
    expect(errs(c, 2).pop()!.error).toBe('BAD_REQUEST');
  });

  it('a message to several parties becomes one private copy each: nobody sees who else got it', async () => {
    const c = await individual().started(4, 1);
    await driveTo(c, 'counting');
    c.notifier.clear();
    await c.send(0, { action: 'chat', to: [c.p[1].playerId, c.p[2].playerId], text: 'same offer to you both' });
    const stored = await c.repo.listChat(c.gameId);
    expect(stored.map((m) => m.to)).toEqual([[c.p[1].playerId], [c.p[2].playerId]]);
    expect(stored.every((m) => m.channel === 'direct' && !m.mentions)).toBe(true);
    expect(new Set(stored.map((m) => m.id)).size).toBe(2);
    expect(chats(c, 1).map((m) => m.message.to)).toEqual([[c.p[1].playerId]]);
    expect(chats(c, 2).map((m) => m.message.to)).toEqual([[c.p[2].playerId]]);
    expect(chats(c, 0)).toHaveLength(2); // the sender's echo of each copy
    expect(chats(c, 3)).toHaveLength(0);
  });

  it('tags are not worked out in one-to-one chats', async () => {
    const c = await individual().started(3, 1);
    await driveTo(c, 'counting');
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: `@${await partyName(c, 2)} is out` });
    expect((await c.repo.listChat(c.gameId))[0].mentions).toBeUndefined();
  });

  it('hello gives a player only the messages they sent or received, plus every group message', async () => {
    const c = await ctx('GROUP').started(4, 1);
    await c.send(3, { action: 'chat', text: 'campaign group' } as never);
    await driveTo(c, 'counting');
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'a to b' });
    await c.send(2, { action: 'chat', to: [c.p[3].playerId], text: 'c to d' });
    expect((await hello(c, 1)).chat?.map((m) => m.text)).toEqual(['campaign group', 'a to b']);
    expect((await hello(c, 3)).chat?.map((m) => m.text)).toEqual(['campaign group', 'c to d']);
    expect((await hello(c, 0)).chat?.map((m) => [m.text, m.channel])).toEqual([['campaign group', 'group'], ['a to b', 'direct']]);
  });

  it('a message stored before channels existed reads as group chat in hello', async () => {
    const c = await individual().started(3, 1);
    await driveTo(c, 'counting');
    await c.repo.addChat(c.gameId, { id: 'old', from: c.p[1].playerId, to: [c.p[0].playerId, c.p[2].playerId], text: 'old style', ts: c.clock.now() });
    expect((await hello(c, 2)).chat).toEqual([expect.objectContaining({ id: 'old', channel: 'group' })]);
  });
});

describe('offer log: what each party did, for the one-to-one chats ("Accepted")', () => {
  const propose = async (c: Ctx, by: number, partners: number[]) => {
    c.clock.advance(10); // a distinct createdAt, so "newest" is this one
    await c.send(by, { action: 'proposeGovernment', portfolios: { PM: [c.p[by].playerId] }, partners: partners.map((i) => c.p[i].playerId) });
    return (await c.repo.listOffers(c.gameId)).filter((o) => o.proposer === c.p[by].playerId).sort((a, b) => b.createdAt - a.createdAt)[0];
  };
  const stored = async (c: Ctx, id: string) => (await c.repo.getOffer(c.gameId, id)) as CoalitionOffer;

  it('a fresh offer has no log; accepting logs "accepted" by that partner, with the time, and tells the parties', async () => {
    const c = await individual().started(4, 1);
    await driveTo(c, 'counting');
    const o = await propose(c, 0, [1, 2]);
    expect(o.log).toBeUndefined();
    c.clock.advance(1_000);
    c.notifier.clear();
    await c.send(1, { action: 'respondOffer', offerId: o.offerId, accept: true });
    expect((await stored(c, o.offerId)).log).toEqual([{ type: 'accepted', by: c.p[1].playerId, ts: c.clock.now() }]);
    expect(offers(c, 0).pop()!.offer.log).toHaveLength(1);
    expect(offers(c, 2).pop()!.offer.log![0].type).toBe('accepted');
    expect(offers(c, 3)).toHaveLength(0); // still private to the parties of the offer
  });

  it('declining logs "declined"; withdrawing logs "withdrawn" by the proposer', async () => {
    const c = await individual().started(4, 1);
    await driveTo(c, 'counting');
    const o = await propose(c, 0, [1]);
    await c.send(1, { action: 'respondOffer', offerId: o.offerId, accept: false });
    expect((await stored(c, o.offerId)).log!.map((e) => [e.type, e.by])).toEqual([['declined', c.p[1].playerId]]);
    const o2 = await propose(c, 0, [2]);
    await c.send(0, { action: 'withdrawOffer', offerId: o2.offerId });
    expect((await stored(c, o2.offerId)).log!.map((e) => [e.type, e.by])).toEqual([['withdrawn', c.p[0].playerId]]);
  });

  it('accepting another offer logs "unaccepted" on the earlier one', async () => {
    const c = await individual().started(4, 1);
    await driveTo(c, 'counting');
    const first = await propose(c, 0, [2]);
    const second = await propose(c, 1, [2]);
    await c.send(2, { action: 'respondOffer', offerId: first.offerId, accept: true });
    await c.send(2, { action: 'respondOffer', offerId: second.offerId, accept: true });
    expect((await stored(c, first.offerId)).log!.map((e) => e.type)).toEqual(['accepted', 'unaccepted']);
    expect((await stored(c, second.offerId)).log!.map((e) => e.type)).toEqual(['accepted']);
  });
});
