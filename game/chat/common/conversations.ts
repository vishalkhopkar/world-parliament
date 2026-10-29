// What a player sees in the chat: the group chat's items, and one conversation per other party for one-to-one chats,
// with government offers (and what was done to them) filed into the conversation between the proposer and each partner.
import type { ChatMessage, CoalitionOffer, OfferEvent, PlayerId } from '@hp/shared';

/** One line of a conversation. `from` = who did it (badges count items from others). */
export type ChatItem =
  | { kind: 'message'; id: string; ts: number; from: PlayerId; message: ChatMessage }
  | { kind: 'offer'; id: string; ts: number; from: PlayerId; offer: CoalitionOffer }
  | { kind: 'offerEvent'; id: string; ts: number; from: PlayerId; offer: CoalitionOffer; event: OfferEvent };

/** Messages stored before one-to-one chats existed have no channel: they were group chat. */
export const channelOf = (m: ChatMessage) => m.channel ?? 'group';

/** Read-state key of a conversation: 'group' for the group chat, 'dm:<id>' for the one-to-one chat with that party. */
export const conversationKey = (with_: PlayerId | null) => (with_ === null ? 'group' : `dm:${with_}`);

const byTime = (a: ChatItem, b: ChatItem) => a.ts - b.ts;

/** The group chat, oldest first. */
export function groupItems(messages: readonly ChatMessage[]): ChatItem[] {
  return messages.filter((m) => channelOf(m) === 'group')
    .map((m): ChatItem => ({ kind: 'message', id: m.id, ts: m.ts, from: m.from, message: m }))
    .sort(byTime);
}

/**
 * One-to-one conversations of `me`, keyed by the other party, each oldest first.
 * - a direct message: under the other party (a sender's message to several parties is filed under each);
 * - an offer: the proposer sees it with every partner, a partner sees it with the proposer;
 * - accepted / declined / unaccepted by a partner: only in that partner's conversation with the proposer;
 * - withdrawn by the proposer: wherever the offer itself is.
 */
export function directConversations(messages: readonly ChatMessage[], offers: readonly CoalitionOffer[], me: PlayerId): Map<PlayerId, ChatItem[]> {
  const out = new Map<PlayerId, ChatItem[]>();
  const add = (who: PlayerId, item: ChatItem) => { if (who !== me) out.set(who, [...(out.get(who) ?? []), item]); };
  for (const m of messages) {
    if (channelOf(m) !== 'direct') continue;
    const item: ChatItem = { kind: 'message', id: m.id, ts: m.ts, from: m.from, message: m };
    if (m.from === me) m.to.forEach((t) => add(t, item));
    else if (m.to.includes(me)) add(m.from, item);
  }
  for (const o of offers) {
    const mine = o.proposer === me;
    if (!mine && !o.partners.includes(me)) continue;
    const withWhom = mine ? o.partners : [o.proposer];
    withWhom.forEach((w) => add(w, { kind: 'offer', id: `offer:${o.offerId}`, ts: o.createdAt, from: o.proposer, offer: o }));
    (o.log ?? []).forEach((e, i) => {
      const item: ChatItem = { kind: 'offerEvent', id: `offer:${o.offerId}:${i}`, ts: e.ts, from: e.by, offer: o, event: e };
      if (e.by === o.proposer) withWhom.forEach((w) => add(w, item));
      else if (mine) add(e.by, item);
      else if (e.by === me) add(o.proposer, item);
    });
  }
  for (const items of out.values()) items.sort(byTime);
  return out;
}

/** Newest item time of a conversation (0 when empty): the list is sorted by it. */
export const lastActivity = (items: readonly ChatItem[]) => items.reduce((t, i) => Math.max(t, i.ts), 0);

/**
 * Badge count: items from others newer than `lastRead` (server time of the newest item already seen).
 * mentionsOnly (group chat): only messages that tag `me`.
 */
export function unreadCount(items: readonly ChatItem[], me: PlayerId, lastRead: number | undefined, mentionsOnly = false): number {
  return items.filter((i) => i.from !== me && i.ts > (lastRead ?? -Infinity)
    && (!mentionsOnly || (i.kind === 'message' && !!i.message.mentions?.includes(me)))).length;
}

/** Sum of the one-to-one badges, leaving out the conversation that is open on screen (it is being read). */
export function unreadTotal(convs: ReadonlyMap<PlayerId, readonly ChatItem[]>, me: PlayerId, read: Readonly<Record<string, number>>, open?: PlayerId | null): number {
  let n = 0;
  for (const [who, items] of convs) if (who !== open) n += unreadCount(items, me, read[conversationKey(who)]);
  return n;
}
