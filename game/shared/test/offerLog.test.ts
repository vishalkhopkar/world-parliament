import { describe, expect, it } from 'vitest';
import { logOfferEvent } from '../src';
import type { CoalitionOffer } from '../src';

const offer = (): CoalitionOffer => ({ offerId: 'o1', proposer: 'a', portfolios: { PM: ['a'] }, partners: ['b', 'c'], accepted: [], status: 'open', createdAt: 1 });

describe('logOfferEvent (what parties did to an offer, shown in the one-to-one chats)', () => {
  it('starts the log on a fresh offer and returns the same offer', () => {
    const o = offer();
    expect(logOfferEvent(o, 'accepted', 'b', 10)).toBe(o);
    expect(o.log).toEqual([{ type: 'accepted', by: 'b', ts: 10 }]);
  });

  it('appends in order, never rewriting earlier events', () => {
    const o = offer();
    logOfferEvent(o, 'accepted', 'b', 10);
    const first = o.log;
    logOfferEvent(o, 'unaccepted', 'b', 20);
    logOfferEvent(o, 'withdrawn', 'a', 30);
    expect(o.log!.map((e) => e.type)).toEqual(['accepted', 'unaccepted', 'withdrawn']);
    expect(first).toHaveLength(1); // a new array each time: a copy sent earlier is not changed
  });
});
