// Who has a candidate where: reading the public fielding map, applying changes to it idempotently, and what the map draws for it.
import { describe, expect, it } from 'vitest';
import type { FieldedCandidate, PlayerPublic } from '@hp/shared';
import { MAX_FIGURES, MAX_POP_IN_FIGURES, applyFielding, candidateCounts, candidateRows, candidatesIn, figuresToShow, hasCandidate, popsIn, seatsOfParty, vacantSeats } from '../fielding';

const pl = (id: string, colour: string): PlayerPublic => ({ playerId: id, nickname: id, isAdmin: false, status: 'active', party: { name: id, colour, symbol: 'sun' } });
const f: Record<number, FieldedCandidate[]> = { 1: [{ playerId: 'a', name: 'Asha' }, { playerId: 'b' }], 2: [{ playerId: 'b' }], 3: [] };

describe('reading the fielding map', () => {
  it('lists the candidates of a seat, and nobody where there are none', () => {
    expect(candidatesIn({ fielding: f }, 1)).toHaveLength(2);
    expect(candidatesIn({ fielding: f }, 9)).toEqual([]);
  });
  it('tells whether a party has a candidate in a seat', () => {
    expect(hasCandidate({ fielding: f }, 2, 'b')).toBe(true);
    expect(hasCandidate({ fielding: f }, 2, 'a')).toBe(false);
  });
  it('counts the candidates of every party', () => {
    expect(candidateCounts(f)).toEqual({ a: 1, b: 2 });
  });
  it('lists the seats of a party', () => {
    expect([...seatsOfParty(f, 'b')].sort()).toEqual([1, 2]);
  });
});

describe('applying a fielding change', () => {
  it('adds a candidate with their name and removes one', () => {
    const next = applyFielding(f, 'a', [{ seat: 2, name: 'Ravi' }], [1]);
    expect(next[2]).toEqual([{ playerId: 'b' }, { playerId: 'a', name: 'Ravi' }]);
    expect(next[1]).toEqual([{ playerId: 'b' }]);
  });
  it('removes the seat entry once its last candidate has gone', () => {
    expect(applyFielding(f, 'b', [], [2])[2]).toBeUndefined();
  });
  it('applying the same change twice changes nothing more (ack and broadcast both carry it)', () => {
    const once = applyFielding(f, 'a', [{ seat: 2 }], []);
    expect(applyFielding(once, 'a', [{ seat: 2 }], [])).toEqual(once);
  });
  it('does not change the map it was given', () => {
    const copy = JSON.stringify(f);
    applyFielding(f, 'a', [{ seat: 2 }], [1]);
    expect(JSON.stringify(f)).toBe(copy);
  });
});

describe('vacant seats', () => {
  it('are the seats with no candidate', () => {
    expect([...vacantSeats({ fielding: f, contestedSeats: 2 }, [1, 2, 3, 4])].sort()).toEqual([3, 4]);
  });
  it('do not exist when every seat is contested', () => {
    expect(vacantSeats({ fielding: {}, contestedSeats: 4 }, [1, 2, 3, 4]).size).toBe(0);
  });
});

describe('figures on the map', () => {
  const players = [pl('a', '#111111'), pl('b', '#222222'), pl('c', '#333333')];
  it('puts the own figure first, in party colours', () => {
    const rows = candidateRows({ 1: [{ playerId: 'b' }, { playerId: 'a' }] }, players, 'a');
    expect(rows[1]).toEqual([{ id: 'a', colour: '#111111' }, { id: 'b', colour: '#222222' }]);
  });
  it('leaves seats without candidates out', () => {
    expect(candidateRows({ 3: [] }, players, 'a')[3]).toBeUndefined();
  });
  it(`shows up to ${MAX_FIGURES} figures and counts the rest as "+n" when the seat is big enough`, () => {
    expect(figuresToShow(7, 500)).toEqual({ shown: MAX_FIGURES, extra: 7 - MAX_FIGURES });
    expect(figuresToShow(2, 500)).toEqual({ shown: 2, extra: 0 });
  });
  it('always shows one figure, however small the seat is on screen, without a "+n"', () => {
    expect(figuresToShow(3, 2)).toEqual({ shown: 1, extra: 0 });
  });
  it('shows nothing for a seat with no candidates', () => {
    expect(figuresToShow(0, 500)).toEqual({ shown: 0, extra: 0 });
  });
  it('a stroke of new figures pops in, a bulk arrival does not', () => {
    expect(popsIn(MAX_POP_IN_FIGURES)).toBe(true);
    expect(popsIn(MAX_POP_IN_FIGURES + 1)).toBe(false);
  });
});
