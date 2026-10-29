import { describe, expect, it } from 'vitest';
import type { ChatMessage, CoalitionOffer } from '@hp/shared';
import { conversationKey, directConversations, groupItems, lastActivity, unreadCount, unreadTotal } from '../common';

const dm = (id: string, from: string, to: string, ts: number, text = id): ChatMessage => ({ id, from, to: [to], text, ts, channel: 'direct' });
const gm = (id: string, from: string, ts: number, mentions?: string[]): ChatMessage => ({ id, from, to: [], text: id, ts, channel: 'group', ...(mentions ? { mentions } : {}) });
const offer = (o: Partial<CoalitionOffer>): CoalitionOffer => ({ offerId: 'o1', proposer: 'a', portfolios: { PM: ['a'] }, partners: ['b', 'c'], accepted: [], status: 'open', createdAt: 50, ...o });

describe('directConversations (one-to-one chats, Teams style)', () => {
  it('files a direct message under the other party, for both sides', () => {
    const msgs = [dm('m1', 'a', 'b', 10), dm('m2', 'b', 'a', 20), dm('m3', 'c', 'b', 30)];
    const forA = directConversations(msgs, [], 'a');
    expect([...forA.keys()]).toEqual(['b']);
    expect(forA.get('b')!.map((i) => i.id)).toEqual(['m1', 'm2']);
    const forB = directConversations(msgs, [], 'b');
    expect(forB.get('a')!.map((i) => i.id)).toEqual(['m1', 'm2']);
    expect(forB.get('c')!.map((i) => i.id)).toEqual(['m3']);
  });

  it('ignores group messages (and old messages without a channel, which were group chat)', () => {
    const old = { id: 'x', from: 'b', to: ['a', 'c'], text: 'old', ts: 5 } as ChatMessage;
    expect(directConversations([gm('g1', 'b', 1), old], [], 'a').size).toBe(0);
  });

  it('puts an offer in the proposer\'s chat with each partner, and in each partner\'s chat with the proposer', () => {
    const o = offer({});
    const forA = directConversations([], [o], 'a');
    expect([...forA.keys()].sort()).toEqual(['b', 'c']);
    expect(forA.get('b')![0]).toMatchObject({ kind: 'offer', from: 'a', ts: 50 });
    const forB = directConversations([], [o], 'b');
    expect([...forB.keys()]).toEqual(['a']);
    expect(forB.get('a')![0]).toMatchObject({ kind: 'offer', from: 'a' });
    expect(directConversations([], [o], 'd').size).toBe(0); // not part of the offer: never sees it
  });

  it('"Accepted" by a partner shows in the partner\'s chat with the proposer only (other partners do not see it there)', () => {
    const o = offer({ log: [{ type: 'accepted', by: 'b', ts: 60 }] });
    const forA = directConversations([], [o], 'a');
    expect(forA.get('b')!.map((i) => i.kind)).toEqual(['offer', 'offerEvent']);
    expect(forA.get('c')!.map((i) => i.kind)).toEqual(['offer']);
    const forB = directConversations([], [o], 'b');
    expect(forB.get('a')!.map((i) => i.kind)).toEqual(['offer', 'offerEvent']);
    expect(forB.get('a')![1]).toMatchObject({ kind: 'offerEvent', from: 'b', event: { type: 'accepted' } });
    const forC = directConversations([], [o], 'c');
    expect(forC.get('a')!.map((i) => i.kind)).toEqual(['offer']);
  });

  it('a withdrawal by the proposer shows in every partner chat', () => {
    const o = offer({ status: 'withdrawn', log: [{ type: 'withdrawn', by: 'a', ts: 70 }] });
    const forA = directConversations([], [o], 'a');
    expect(forA.get('b')!.map((i) => i.kind)).toEqual(['offer', 'offerEvent']);
    expect(forA.get('c')!.map((i) => i.kind)).toEqual(['offer', 'offerEvent']);
    expect(directConversations([], [o], 'c').get('a')!.map((i) => i.kind)).toEqual(['offer', 'offerEvent']);
  });

  it('keeps every conversation in time order, messages and offers mixed', () => {
    const o = offer({ partners: ['b'], log: [{ type: 'accepted', by: 'b', ts: 55 }] });
    const items = directConversations([dm('m1', 'b', 'a', 40), dm('m2', 'a', 'b', 52), dm('m3', 'b', 'a', 58)], [o], 'a').get('b')!;
    expect(items.map((i) => i.id)).toEqual(['m1', 'offer:o1', 'm2', 'offer:o1:0', 'm3']);
  });
});

describe('groupItems', () => {
  it('keeps only group messages (old ones without a channel count as group), oldest first', () => {
    const old = { id: 'x', from: 'b', to: ['a', 'c'], text: 'old', ts: 5 } as ChatMessage;
    expect(groupItems([gm('g2', 'c', 20), dm('d1', 'a', 'b', 15), old, gm('g1', 'b', 10)]).map((i) => i.id)).toEqual(['x', 'g1', 'g2']);
  });
});

describe('unread badges', () => {
  const items = directConversations([dm('m1', 'b', 'a', 10), dm('m2', 'a', 'b', 20), dm('m3', 'b', 'a', 30)], [], 'a').get('b')!;

  it('counts what others sent after the last read time; own messages never count', () => {
    expect(unreadCount(items, 'a', undefined)).toBe(2);
    expect(unreadCount(items, 'a', 10)).toBe(1);
    expect(unreadCount(items, 'a', 30)).toBe(0);
  });

  it('offers and "Accepted" from the other side count too', () => {
    const o = offer({ proposer: 'b', partners: ['a'], log: [{ type: 'withdrawn', by: 'b', ts: 80 }] });
    const conv = directConversations([], [o], 'a').get('b')!;
    expect(unreadCount(conv, 'a', undefined)).toBe(2);
    const mine = directConversations([], [offer({ partners: ['b'], log: [{ type: 'accepted', by: 'b', ts: 60 }] })], 'a').get('b')!;
    expect(unreadCount(mine, 'a', undefined)).toBe(1); // my own offer does not count, b's acceptance does
  });

  it('group chat: only messages that tag me count (mentionsOnly)', () => {
    const g = groupItems([gm('g1', 'b', 10), gm('g2', 'b', 20, ['a']), gm('g3', 'c', 30, ['c', 'a']), gm('g4', 'a', 40, ['a'])]);
    expect(unreadCount(g, 'a', undefined, true)).toBe(2);
    expect(unreadCount(g, 'a', 20, true)).toBe(1);
    expect(unreadCount(g, 'a', undefined)).toBe(3);
  });

  it('unreadTotal sums the badges of every conversation except the one open on screen', () => {
    const convs = directConversations([dm('m1', 'b', 'a', 10), dm('m2', 'c', 'a', 20), dm('m3', 'c', 'a', 30)], [], 'a');
    expect(unreadTotal(convs, 'a', {})).toBe(3);
    expect(unreadTotal(convs, 'a', { [conversationKey('c')]: 20 })).toBe(2);
    expect(unreadTotal(convs, 'a', {}, 'c')).toBe(1);
  });

  it('lastActivity is the newest item time (0 when empty)', () => {
    expect(lastActivity(items)).toBe(30);
    expect(lastActivity([])).toBe(0);
  });

  it('conversation keys: "group" for the group chat, "dm:<id>" for one-to-one chats', () => {
    expect(conversationKey(null)).toBe('group');
    expect(conversationKey('b')).toBe('dm:b');
  });
});
