// Messaging mode flag: 'group' (default) = ONE common chat everybody in the game reads; 'individual' = private threads.
import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG } from '@hp/shared';
import type { ChatMessage, ServerMessage } from '@hp/shared';
import { Ctx, TEST_CFG, driveTo } from './helpers';

const group = () => new Ctx({ cfg: { ...TEST_CFG, messaging: { mode: 'group', opensAt: 'counting' } } });
const individual = () => new Ctx({ cfg: { ...TEST_CFG, messaging: { mode: 'individual', opensAt: 'counting' } } });
const errs = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'error') as { error: string }[];
const chats = (c: Ctx, i: number) => c.notifier.to(c.p[i].playerId, 'chat') as Extract<ServerMessage, { type: 'chat' }>[];
const hello = async (c: Ctx, i: number) => {
  const p = (await c.repo.getPlayer(c.gameId, c.p[i].playerId))!;
  return (await c.svc.hello(p)) as Extract<ServerMessage, { type: 'hello' }>;
};

describe('group chat (messaging.mode = group, the default)', () => {
  it('the default of the game is group chat', () => { expect(WORLD_CONFIG.messaging.mode).toBe('group'); });

  it('every member reads every message, whoever it was "to"; the sender gets one echo', async () => {
    const c = await group().started(4, 1);
    await driveTo(c, 'counting');
    c.notifier.clear();
    await c.send(2, { action: 'chat', to: [c.p[0].playerId], text: 'hello everyone' });
    for (let i = 0; i < 4; i++) expect(chats(c, i), `player ${i}`).toHaveLength(1);
    const m = chats(c, 3)[0].message;
    expect(m).toMatchObject({ from: c.p[2].playerId, text: 'hello everyone' });
    expect(m.to.sort()).toEqual([c.p[0].playerId, c.p[1].playerId, c.p[3].playerId].sort());
  });

  it('recipients need not be given at all (the whole table is the audience)', async () => {
    const c = await group().started(3, 1);
    await driveTo(c, 'counting');
    c.notifier.clear();
    await c.send(0, { action: 'chat', text: 'no to field' } as never);
    expect(errs(c, 0)).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect(chats(c, i)).toHaveLength(1);
    await c.send(1, { action: 'chat', to: [], text: 'empty to' });
    expect(errs(c, 1)).toHaveLength(0);
    expect(chats(c, 2)).toHaveLength(2);
  });

  it('works in postCounting and reaches an eliminated player (a member)', async () => {
    const c = await group().started(4, 1);
    await driveTo(c, 'postCounting');
    await c.svc.eliminate(c.gameId, c.p[3].playerId);
    c.notifier.clear();
    await c.send(0, { action: 'chat', text: 'still here?' } as never);
    expect(chats(c, 3)).toHaveLength(1);
    expect(chats(c, 2)).toHaveLength(1);
  });

  it('keeps every rule of the private chat: phase, 3+ players, text validation', async () => {
    const early = await group().started(3, 1);
    await early.send(0, { action: 'chat', text: 'too soon' } as never);
    expect(errs(early, 0).pop()!.error).toBe('WRONG_PHASE');

    const two = await group().started(2, 1);
    await driveTo(two, 'counting');
    await two.send(0, { action: 'chat', text: 'hi' } as never);
    expect(errs(two, 0).pop()!.error).toBe('NEGOTIATION_DISABLED');

    const c = await group().started(3, 1);
    await driveTo(c, 'counting');
    for (const text of ['', '   ', 7 as never, 'x'.repeat(501)]) {
      await c.send(0, { action: 'chat', text } as never);
      expect(errs(c, 0).pop()!.error).toBe('BAD_REQUEST');
    }
    expect(await c.repo.listChat(c.gameId)).toHaveLength(0);
  });

  it('a (re)connecting player gets the whole conversation in hello, oldest first', async () => {
    const c = await group().started(3, 1);
    await driveTo(c, 'counting');
    await c.send(0, { action: 'chat', text: 'one' } as never);
    await c.send(1, { action: 'chat', text: 'two' } as never);
    await c.send(2, { action: 'chat', text: 'three' } as never);
    for (let i = 0; i < 3; i++) expect((await hello(c, i)).chat?.map((m) => m.text), `player ${i}`).toEqual(['one', 'two', 'three']);
  });

  it('hello carries a bounded history (newest kept) so it stays under the WebSocket frame limit', async () => {
    const c = await group().started(3, 1);
    await driveTo(c, 'counting');
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

describe('individual threads (messaging.mode = individual)', () => {
  it('still deliver only to the chosen recipients and the sender', async () => {
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

  it('hello gives a player only the messages they sent or received', async () => {
    const c = await individual().started(4, 1);
    await driveTo(c, 'counting');
    await c.send(0, { action: 'chat', to: [c.p[1].playerId], text: 'a to b' });
    await c.send(2, { action: 'chat', to: [c.p[3].playerId], text: 'c to d' });
    expect((await hello(c, 1)).chat?.map((m) => m.text)).toEqual(['a to b']);
    expect((await hello(c, 3)).chat?.map((m) => m.text)).toEqual(['c to d']);
    expect((await hello(c, 0)).chat?.map((m) => m.text)).toEqual(['a to b']);
  });
});
