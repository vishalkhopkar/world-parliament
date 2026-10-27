import { describe, expect, it } from 'vitest';
import type { GameSnapshot, PrivateState } from '@hp/shared';
import { taskDone } from '../tasks';
import type { TaskInput } from '../tasks';

const priv = (over: Partial<PrivateState> = {}): PrivateState => ({ you: 'me', budget: 1, myActions: [], myReports: [], ...over });
const base = (over: Partial<TaskInput> = {}): TaskInput => ({ selectedSeat: null, priv: priv(), snapshot: null, error: null, now: 1000, ...over });
const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'counting', phases: 1, timeline: null, players: [], news: [], polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});

describe('taskDone', () => {
  it('committed: a committed seat is selected', () => {
    const p = priv({ committed: [{ seat: 7, band: 1, percent: 30, level: 'HIGH' }] });
    expect(taskDone('committed', base({ priv: p }))).toBe(false);
    expect(taskDone('committed', base({ priv: p, selectedSeat: 8 }))).toBe(false);
    expect(taskDone('committed', base({ priv: p, selectedSeat: 7 }))).toBe(true);
  });

  it('rally / roadshow: the action list grew', () => {
    expect(taskDone('rally', base())).toBe(false);
    expect(taskDone('rally', base({ priv: priv({ myActions: [{ type: 'roadshow', seat: 1, ts: 1 }] }) }))).toBe(false);
    expect(taskDone('rally', base({ priv: priv({ myActions: [{ type: 'rally', seat: 1, ts: 1 }] }) }))).toBe(true);
    expect(taskDone('roadshow', base({ priv: priv({ myActions: [{ type: 'rally', seat: 1, ts: 1 }] }) }))).toBe(false);
    expect(taskDone('roadshow', base({ priv: priv({ myActions: [{ type: 'roadshow', seat: 1, ts: 1 }] }) }))).toBe(true);
  });

  it('cooldown: the refusal toast, or a seat panel open while the cooldown runs', () => {
    expect(taskDone('cooldown', base())).toBe(false);
    expect(taskDone('cooldown', base({ error: 'You can rally once every 15 s; next rally in 9 s' }))).toBe(true);
    expect(taskDone('cooldown', base({ error: 'Not enough funds' }))).toBe(false);
    expect(taskDone('cooldown', base({ selectedSeat: 3, priv: priv({ nextRallyAt: 5000 }) }))).toBe(true);
    expect(taskDone('cooldown', base({ selectedSeat: null, priv: priv({ nextRallyAt: 5000 }) }))).toBe(false); // no panel open
    expect(taskDone('cooldown', base({ selectedSeat: 3, priv: priv({ nextRallyAt: 500 }) }))).toBe(false); // cooldown over
  });

  it('govern: an offer was accepted, or the game is over', () => {
    const offer = (status: GameSnapshot['offers'][number]['status']) => ({ offerId: 'o', proposer: 'me', portfolios: {}, partners: [], accepted: [], status, createdAt: 1 });
    expect(taskDone('govern', base({ snapshot: snap() }))).toBe(false);
    expect(taskDone('govern', base({ snapshot: snap({ offers: [offer('open')] }) }))).toBe(false);
    expect(taskDone('govern', base({ snapshot: snap({ offers: [offer('declined')] }) }))).toBe(false);
    expect(taskDone('govern', base({ snapshot: snap({ offers: [offer('accepted')] }) }))).toBe(true);
    expect(taskDone('govern', base({ snapshot: snap({ status: 'finished' }) }))).toBe(true);
  });
});
