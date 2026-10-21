import { describe, expect, it } from 'vitest';
import type { SeatDeclaration, SeatSharesMessage } from '@hp/shared';
import { PANEL_GAP, PANEL_H, ResultFeed, panelCount, wantKey } from '../resultFeed';
import { contrastText } from '../textContrast';
import { fitFontSize } from '../useFitText';

const decl = (seat: number, status: 'leading' | 'won', playerId: string): SeatDeclaration => ({ seat, status, playerId });
const seatsOf = (...ds: SeatDeclaration[]) => Object.fromEntries(ds.map(d => [d.seat, d]));
const ans = (seat: number, status: 'leading' | 'won', shares: Record<string, number>): SeatSharesMessage => ({ type: 'seatShares', seat, status, shares });
const none = new Set<string>();

describe('panelCount', () => {
  it('fits as many cards (with gaps) as the height allows, at least 2', () => {
    expect(panelCount(0)).toBe(2);
    expect(panelCount(PANEL_H)).toBe(2);
    expect(panelCount(3 * PANEL_H + 2 * PANEL_GAP)).toBe(3);
    expect(panelCount(4 * PANEL_H + 3 * PANEL_GAP - 1)).toBe(3);
    expect(panelCount(900)).toBe(Math.floor((900 + PANEL_GAP) / (PANEL_H + PANEL_GAP)));
    expect(panelCount(1000, 100, 0)).toBe(10);
  });
});

describe('contrastText', () => {
  it('picks black on light and white on dark colours', () => {
    expect(contrastText('#ffffff')).toBe('#000000');
    expect(contrastText('#E8C547')).toBe('#000000');
    expect(contrastText('#000000')).toBe('#ffffff');
    expect(contrastText('#1F5FBF')).toBe('#ffffff');
    expect(contrastText('#fff')).toBe('#000000');
    expect(contrastText('nonsense')).toBe('#ffffff');
  });
});

describe('fitFontSize', () => {
  it('returns the largest size that fits, else the minimum', () => {
    expect(fitFontSize(15, 10, s => s <= 12)).toBe(12);
    expect(fitFontSize(15, 10, () => true)).toBe(15);
    expect(fitFontSize(15, 10, () => false)).toBe(10);
  });
});

describe('ResultFeed', () => {
  it('seeds silently on the first update', () => {
    const f = new ResultFeed(() => 0);
    f.update(seatsOf(decl(1, 'leading', 'a')));
    expect(f.size).toBe(0);
  });

  it('pops the newest event first, its companion right after, then older events', () => {
    const f = new ResultFeed(() => 0);
    f.update(seatsOf(decl(1, 'leading', 'a'), decl(2, 'leading', 'a')));
    f.update(seatsOf(decl(1, 'won', 'a'), decl(2, 'leading', 'a')));
    const s2 = seatsOf(decl(1, 'won', 'a'), decl(2, 'leading', 'b'));
    f.update(s2);
    expect(f.pick(s2, none)).toEqual({ seat: 2, kind: 'LEADS' });
    expect(f.pick(s2, none)).toEqual({ seat: 2, kind: 'TRAILS' });
    expect(f.pick(s2, none)).toEqual({ seat: 1, kind: 'WON' });
    expect(f.pick(s2, none)).toEqual({ seat: 1, kind: 'LOST' });
    expect(f.size).toBe(0);
  });

  it('turns a stale LEADS event into WON once the seat is won', () => {
    const f = new ResultFeed(() => 0);
    f.update(seatsOf(decl(1, 'leading', 'a')));
    f.update(seatsOf(decl(1, 'leading', 'b')));
    expect(f.pick(seatsOf(decl(1, 'won', 'b')), none)).toEqual({ seat: 1, kind: 'WON' });
  });

  it('falls back to a random declared seat and a kind valid for its status', () => {
    const s = seatsOf(decl(1, 'leading', 'a'), decl(2, 'won', 'a'));
    // pool order: 1 LEADS, 1 TRAILS, 2 WON, 2 LOST
    expect(new ResultFeed(() => 0).pick(s, none)).toEqual({ seat: 1, kind: 'LEADS' });
    expect(new ResultFeed(() => 0.99).pick(s, none)).toEqual({ seat: 2, kind: 'LOST' });
    expect(new ResultFeed(() => 0.6).pick(s, none)).toEqual({ seat: 2, kind: 'WON' });
  });

  it('avoids a seat+kind that is already visible when an alternative exists, else repeats', () => {
    const s = seatsOf(decl(1, 'leading', 'a'));
    const f = new ResultFeed(() => 0);
    expect(f.pick(s, new Set([wantKey({ seat: 1, kind: 'LEADS' })]))).toEqual({ seat: 1, kind: 'TRAILS' });
    const both = new Set([wantKey({ seat: 1, kind: 'LEADS' }), wantKey({ seat: 1, kind: 'TRAILS' })]);
    expect(f.pick(s, both)).not.toBeNull();
    expect(f.pick(s, both, both)).toBeNull();
    expect(f.pick({}, none)).toBeNull();
  });

  it('bounds the stack, dropping the oldest', () => {
    const f = new ResultFeed(() => 0, 5);
    f.update(seatsOf(decl(1, 'leading', 'a')));
    for (let i = 2; i < 12; i++) f.update(seatsOf(decl(1, 'leading', 'a'), decl(i, 'leading', 'a')));
    expect(f.size).toBe(5);
  });

  describe('resolve (the party of a card)', () => {
    const d = decl(1, 'leading', 'a');
    const a = ans(1, 'leading', { a: 0.4, b: 0.3, c: 0.2, d: 0.1 });
    const parties = ['a', 'b', 'c', 'd'];
    const pct = { runnerUp: 75, other: 25 };
    const want = { seat: 1, kind: 'TRAILS' as const };
    const seq = (...v: number[]) => { let i = 0; return () => v[i++]; };

    it('LEADS uses the declared leader, WON likewise', () => {
      expect(new ResultFeed().resolve({ seat: 1, kind: 'LEADS' }, d, a, parties, pct)).toEqual({ seat: 1, kind: 'LEADS', partyId: 'a' });
      expect(new ResultFeed().resolve({ seat: 1, kind: 'LEADS' }, d, ans(1, 'won', a.shares), parties, pct)).toEqual({ seat: 1, kind: 'WON', partyId: 'a' });
    });

    it('picks the runner-up when random < 75%', () => {
      expect(new ResultFeed(() => 0.74).resolve(want, d, a, parties, pct)?.partyId).toBe('b');
      expect(new ResultFeed(() => 0).resolve(want, d, a, parties, pct)?.partyId).toBe('b');
    });

    it('picks a random other non-leading, non-runner-up party otherwise', () => {
      expect(new ResultFeed(seq(0.75, 0)).resolve(want, d, a, parties, pct)?.partyId).toBe('c');
      expect(new ResultFeed(seq(0.99, 0.99)).resolve(want, d, a, parties, pct)?.partyId).toBe('d');
    });

    it('always the runner-up with only two parties; LOST for a won seat; null without a rival', () => {
      const two = ans(1, 'won', { a: 0.6, b: 0.4 });
      expect(new ResultFeed(() => 0.99).resolve({ seat: 1, kind: 'LOST' }, decl(1, 'won', 'a'), two, ['a', 'b'], pct)).toEqual({ seat: 1, kind: 'LOST', partyId: 'b' });
      expect(new ResultFeed().resolve(want, d, ans(1, 'leading', { a: 1 }), ['a'], pct)).toBeNull();
    });

    it('ignores share entries of unknown parties', () => {
      expect(new ResultFeed(() => 0).resolve(want, d, ans(1, 'leading', { a: 0.5, zz: 0.4, b: 0.1 }), ['a', 'b'], pct)?.partyId).toBe('b');
    });

    it('follows the configured percentages', () => {
      expect(new ResultFeed(seq(0.4, 0)).resolve(want, d, a, parties, { runnerUp: 50, other: 50 })?.partyId).toBe('b');
      expect(new ResultFeed(seq(0.5, 0)).resolve(want, d, a, parties, { runnerUp: 50, other: 50 })?.partyId).toBe('c');
    });
  });
});
