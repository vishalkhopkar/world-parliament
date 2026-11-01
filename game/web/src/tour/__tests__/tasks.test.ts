import { describe, expect, it } from 'vitest';
import type { GameSnapshot, PrivateState } from '@hp/shared';
import { FIELD_TASK_SEATS, fieldedByMe, taskDone } from '../tasks';
import type { TaskInput } from '../tasks';

const priv = (over: Partial<PrivateState> = {}): PrivateState => ({ you: 'me', budget: 1, myActions: [], myReports: [], ...over });
const base = (over: Partial<TaskInput> = {}): TaskInput => ({ selectedSeat: null, priv: priv(), snapshot: null, error: null, now: 1000, ...over });
const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'counting', phases: 1, timeline: null, players: [], news: [], fielding: {}, fieldingDone: [], contestedSeats: 0, majority: 1, polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null, ...over,
});
/** A snapshot where `me` stands in the first `mine` seats and a rival stands in seats 100 and up. */
const standing = (mine: number, rival = 3) => snap({
  status: 'preCampaign',
  fielding: {
    ...Object.fromEntries(Array.from({ length: mine }, (_, i) => [i + 1, [{ playerId: 'me', name: 'A' }, { playerId: 'rival', name: 'B' }]])),
    ...Object.fromEntries(Array.from({ length: rival }, (_, i) => [100 + i, [{ playerId: 'rival', name: 'C' }]])),
  },
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

  // Rule: the painting task is done once a few of your own candidates stand (rivals' do not count).
  it('field: done when at least the asked number of seats hold a candidate of yours', () => {
    expect(fieldedByMe(null, 'me')).toBe(0);
    expect(fieldedByMe(standing(4), 'me')).toBe(4);
    expect(fieldedByMe(standing(0, 50), 'me')).toBe(0);
    expect(taskDone('field', base({ snapshot: standing(FIELD_TASK_SEATS - 1, 50) }))).toBe(false);
    expect(taskDone('field', base({ snapshot: standing(FIELD_TASK_SEATS) }))).toBe(true);
    expect(taskDone('field', base({ snapshot: null }))).toBe(false);
  });

  // Rule: the withdraw task is done when you hold fewer candidates than you did at your peak (you fielded, then withdrew).
  it('withdraw: done once you hold fewer candidates than at your peak', () => {
    expect(taskDone('withdraw', base({ snapshot: standing(5), peakFielded: 0 }))).toBe(false);
    expect(taskDone('withdraw', base({ snapshot: standing(5), peakFielded: 5 }))).toBe(false);
    expect(taskDone('withdraw', base({ snapshot: standing(5), peakFielded: 6 }))).toBe(true);
    expect(taskDone('withdraw', base({ snapshot: standing(0), peakFielded: 1 }))).toBe(true);
    expect(taskDone('withdraw', base({ snapshot: standing(0) }))).toBe(false);
  });

  // Rule: the Done task is done once YOUR Done is listed in the snapshot (a rival's Done does not count).
  it('done: your own id is in the snapshot fieldingDone list', () => {
    expect(taskDone('done', base({ snapshot: null }))).toBe(false);
    expect(taskDone('done', base({ snapshot: snap({ fieldingDone: [] }) }))).toBe(false);
    expect(taskDone('done', base({ snapshot: snap({ fieldingDone: ['rival'] }) }))).toBe(false);
    expect(taskDone('done', base({ snapshot: snap({ fieldingDone: ['rival', 'me'] }) }))).toBe(true);
    expect(taskDone('done', base({ snapshot: snap({ fieldingDone: ['me'] }), priv: null }))).toBe(false);
  });

  it('minorRally: a minor rally appears in my actions (a major rally or a roadshow does not count)', () => {
    expect(taskDone('minorRally', base())).toBe(false);
    expect(taskDone('minorRally', base({ priv: priv({ myActions: [{ type: 'rally', seat: 1, ts: 1 }, { type: 'roadshow', seat: 1, ts: 2 }] }) }))).toBe(false);
    expect(taskDone('minorRally', base({ priv: priv({ myActions: [{ type: 'minorRally', seat: 1, ts: 1 }] }) }))).toBe(true);
    // and a minor rally is not a major one: the rally task stays open
    expect(taskDone('rally', base({ priv: priv({ myActions: [{ type: 'minorRally', seat: 1, ts: 1 }] }) }))).toBe(false);
  });
});
