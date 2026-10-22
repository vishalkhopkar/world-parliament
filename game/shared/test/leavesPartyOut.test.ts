import { describe, expect, it } from 'vitest';
import { leavesPartyOut } from '../src';

describe('leavesPartyOut (a government must leave at least one party in opposition)', () => {
  it('true when some contender is not a member', () => {
    expect(leavesPartyOut(['a', 'b'], ['a', 'b', 'c'])).toBe(true);
    expect(leavesPartyOut(['a'], ['a', 'b', 'c', 'd'])).toBe(true);
  });

  it('false when every contender is a member', () => {
    expect(leavesPartyOut(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(false);
    expect(leavesPartyOut(['c', 'b', 'a', 'a'], ['a', 'b', 'c'])).toBe(false); // order and duplicates do not matter
  });

  it('members that are not contenders (eliminated players) do not count as covering anybody', () => {
    expect(leavesPartyOut(['a', 'b', 'x'], ['a', 'b', 'c'])).toBe(true);
    expect(leavesPartyOut(['a', 'b', 'c', 'x'], ['a', 'b', 'c'])).toBe(false);
  });

  it('with no contenders there is nobody to leave out', () => {
    expect(leavesPartyOut([], [])).toBe(false);
    expect(leavesPartyOut(['a'], [])).toBe(false);
  });
});
