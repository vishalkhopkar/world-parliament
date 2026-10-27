import { describe, expect, it } from 'vitest';
import { createRng, majorityOf } from '@hp/shared';
import { assignSeats, buildReveal, pickCores, quotasInPartyOrder, replayReveal, tourSeatCounts } from '../tourScript';
import { gridPackage } from '../../../test/fakePackage';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('tourSeatCounts', () => {
  it('is the designed result for 500 seats', () => {
    expect(tourSeatCounts(500)).toEqual({ largest: 249, you: 110, small: [30, 28, 25, 20, 17, 12, 9] });
  });

  for (const n of [500, 543, 250, 100, 60, 17, 18, 21, 99, 1001]) {
    it(`keeps every property for ${n} seats`, () => {
      const c = tourSeatCounts(n);
      const maj = majorityOf(n);
      expect(c.small).toHaveLength(7);
      expect(c.largest + c.you + sum(c.small)).toBe(n);
      expect(c.largest).toBeLessThan(maj); // the largest party alone is short
      expect(c.largest).toBeGreaterThan(c.you); // it really is the largest
      expect(c.you).toBeGreaterThan(Math.max(...c.small)); // you are the runner-up
      expect(c.small.every(s => s >= 1)).toBe(true);
      expect(c.small).toEqual([...c.small].sort((a, b) => b - a));
      expect(c.you + sum(c.small)).toBe(maj); // you + ALL seven = exactly the majority...
      for (const s of c.small) expect(c.you + sum(c.small) - s).toBeLessThan(maj); // ...and dropping any one falls short
    });
  }

  it('refuses maps too small to hold nine parties', () => {
    expect(() => tourSeatCounts(16)).toThrow();
  });

  it('orders quotas as you, largest, then the smaller parties', () => {
    expect(quotasInPartyOrder(tourSeatCounts(500))).toEqual([110, 249, 30, 28, 25, 20, 17, 12, 9]);
  });
});

describe('assignSeats', () => {
  const pkg = gridPackage(10, 12); // 120 seats
  const nodes = pkg.seats.map(s => ({ id: s.id, x: s.x, y: s.y, neighbours: s.neighbours }));

  function setup(n: number) {
    const counts = tourSeatCounts(n);
    const quotas = quotasInPartyOrder(counts);
    const mine = new Set([61, 62, 63, 73, 74]);
    const others = pickCores(nodes, mine, 8);
    const cores = [61, ...others];
    const pre = new Map([...mine].map(id => [id, 0] as const));
    return { quotas, cores, pre, mine };
  }

  it('hits every quota exactly and gives every seat to somebody', () => {
    const { quotas, cores, pre } = setup(120);
    const owner = assignSeats(nodes, quotas, cores, pre);
    expect(owner.size).toBe(120);
    quotas.forEach((q, p) => expect([...owner.values()].filter(x => x === p).length).toBe(q));
  });

  it('keeps the preassigned seats with their party and the cores with theirs', () => {
    const { quotas, cores, pre } = setup(120);
    const owner = assignSeats(nodes, quotas, cores, pre);
    for (const [id, p] of pre) expect(owner.get(id)).toBe(p);
    cores.forEach((c, p) => expect(owner.get(c)).toBe(p));
  });

  it('is deterministic and grows one block for the player and for the largest party', () => {
    const { quotas, cores, pre } = setup(120);
    const a = assignSeats(nodes, quotas, cores, pre);
    const b = assignSeats(nodes, quotas, cores, pre);
    expect([...a]).toEqual([...b]);
    const byId = new Map(nodes.map(s => [s.id, s]));
    // the player and the largest party form one block (small boxed-in parties may get a detached leftover seat)
    [0, 1].forEach(p => {
      const seats = [...a].filter(([, q]) => q === p).map(([id]) => id);
      const left = new Set(seats);
      const stack = [seats[0]];
      left.delete(seats[0]);
      while (stack.length) for (const nb of byId.get(stack.pop()!)!.neighbours) if (left.delete(nb)) stack.push(nb);
      expect(left.size).toBe(0);
    });
  });

  it('places leftovers (islands) with the nearest party that has quota left', () => {
    // two islands with no neighbours at all
    const island = [...nodes, { id: 1001, x: 500, y: 500, neighbours: [] }, { id: 1002, x: -500, y: -500, neighbours: [] }];
    const quotas = [50, 30, 10, 10, 6, 6, 4, 4, 2];
    const cores = [61, 1, 12, 24, 36, 100, 110, 120, 7];
    const owner = assignSeats(island, quotas, cores, new Map());
    expect(owner.size).toBe(122);
    quotas.forEach((q, p) => expect([...owner.values()].filter(x => x === p).length).toBe(q));
  });

  it('rejects quotas that do not add up', () => {
    expect(() => assignSeats(nodes, [1, 2], [1, 2])).toThrow();
  });

  it('works on the one-row chain too', () => {
    const chain = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, x: i, y: 0, neighbours: [i, i + 2].filter(j => j >= 1 && j <= 40) }));
    const counts = tourSeatCounts(40);
    const owner = assignSeats(chain, quotasInPartyOrder(counts), [20, 1, 40, 5, 10, 30, 35, 15, 25], new Map());
    expect(owner.size).toBe(40);
  });
});

describe('buildReveal', () => {
  const nodes = gridPackage(10, 12).seats.map(s => ({ id: s.id, x: s.x, y: s.y, neighbours: s.neighbours }));
  const counts = tourSeatCounts(120);
  const truth = assignSeats(nodes, quotasInPartyOrder(counts), [61, 1, 12, 24, 36, 110, 120, 100, 7], new Map());
  const plan = buildReveal(truth, 9, createRng('reveal'), { pauseMs: 20_000, resumeMs: 9_000, margin: s => (s % 7) / 7 });

  it('at the pause every seat leads (or has won) its true winner, about 60% of them confirmed', () => {
    const at = replayReveal(plan, plan.pauseMs);
    expect(at.size).toBe(120);
    for (const [seat, d] of at) expect(d.party).toBe(truth.get(seat));
    const won = [...at.values()].filter(d => d.status === 'won').length;
    expect(won).toBe(72);
  });

  it('shows some wrong leads early on (the noisy start)', () => {
    const early = plan.events.filter(e => e.status === 'leading' && e.party !== truth.get(e.seat));
    expect(early.length).toBeGreaterThan(10);
    expect(early.every(e => e.t < plan.pauseMs)).toBe(true);
  });

  it('declares everything by the end, the last seat exactly at endMs', () => {
    const end = replayReveal(plan, plan.endMs);
    expect([...end.values()].every(d => d.status === 'won')).toBe(true);
    for (const [seat, d] of end) expect(d.party).toBe(truth.get(seat));
    expect(Math.max(...plan.events.map(e => e.t))).toBe(plan.endMs);
    expect(plan.events.filter(e => e.t > plan.pauseMs).every(e => e.status === 'won')).toBe(true);
  });

  it('declares each seat at most once as won and never leads a seat after it has been won', () => {
    const wonAt = new Map<number, number>();
    for (const e of plan.events) if (e.status === 'won') { expect(wonAt.has(e.seat)).toBe(false); wonAt.set(e.seat, e.t); }
    for (const e of plan.events) if (e.status === 'leading' && wonAt.has(e.seat)) expect(e.t).toBeLessThan(wonAt.get(e.seat)!);
  });

  it('the tally at the pause equals the scripted result', () => {
    const at = replayReveal(plan, plan.pauseMs);
    const tally = Array.from({ length: 9 }, () => 0);
    for (const d of at.values()) tally[d.party]++;
    expect(tally).toEqual(quotasInPartyOrder(counts));
  });
});
