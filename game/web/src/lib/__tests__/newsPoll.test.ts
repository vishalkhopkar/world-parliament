import { describe, expect, it } from 'vitest';
import { NEWS_POLL_LAG_MS, nextNewsPollDelay, newsReportsFresh } from '../newsPoll';

const S = 1_000_000; // campaign start
const I = 30_000;
const E = S + 100_000; // campaign end (not on the grid: 3 x 30 s + 10 s)

describe('nextNewsPollDelay (poll just after the next sample-grid time, not every interval from opening)', () => {
  it('opened mid-interval: waits until the next grid time plus the lag', () => {
    expect(nextNewsPollDelay(S + 10_000, S, I, E)).toBe(20_000 + NEWS_POLL_LAG_MS);
  });
  it('lands on the grid whatever the opening time: successive polls are interval apart on the grid', () => {
    let now = S + 7_321;
    const at: number[] = [];
    for (let i = 0; i < 3; i++) { const d = nextNewsPollDelay(now, S, I, E)!; now += d; at.push(now); }
    expect(at.map((t) => t - S - NEWS_POLL_LAG_MS)).toEqual([30_000, 60_000, 90_000]);
  });
  it('just after a grid time but inside the lag waits for the lag only; after the lag waits for the next grid time', () => {
    expect(nextNewsPollDelay(S + I + 100, S, I, E)).toBe(NEWS_POLL_LAG_MS - 100);
    expect(nextNewsPollDelay(S + I + NEWS_POLL_LAG_MS, S, I, E)).toBe(I);
  });
  it('before the campaign start: the first poll follows the start', () => {
    expect(nextNewsPollDelay(S - 5_000, S, I, E)).toBe(5_000 + NEWS_POLL_LAG_MS);
  });
  it('the closing point at the campaign end (off the grid) is polled, then it stops', () => {
    expect(nextNewsPollDelay(S + 91_000, S, I, E)).toBe(E - (S + 91_000) + NEWS_POLL_LAG_MS);
    expect(nextNewsPollDelay(E + NEWS_POLL_LAG_MS, S, I, E)).toBeNull();
    expect(nextNewsPollDelay(E + 60_000, S, I, E)).toBeNull();
  });
  it('without a timeline it falls back to one interval from now; never zero or negative', () => {
    expect(nextNewsPollDelay(5_000, undefined, I, undefined)).toBe(I);
    for (let k = 0; k < 400; k++) expect(nextNewsPollDelay(S + k * 997, S, I, undefined)!).toBeGreaterThan(0);
  });
});

describe('newsReportsFresh (the browser keeps the answer until a new point is due)', () => {
  it('fresh while the held answer has the newest grid point', () => {
    expect(newsReportsFresh(S + 40_000, S + 30_000, S, I, E)).toBe(true);
    expect(newsReportsFresh(S + 29_000, S, S, I, E)).toBe(true);
  });
  it('stale once a newer grid point exists (after the lag)', () => {
    expect(newsReportsFresh(S + 30_000 + NEWS_POLL_LAG_MS, S, S, I, E)).toBe(false);
    expect(newsReportsFresh(S + 61_000, S + 30_000, S, I, E)).toBe(false);
  });
  it('after the campaign end only the closing point makes it fresh', () => {
    expect(newsReportsFresh(E + 5_000, S + 90_000, S, I, E)).toBe(false);
    expect(newsReportsFresh(E + 5_000, E, S, I, E)).toBe(true);
  });
  it('nothing held or no timeline: not fresh', () => {
    expect(newsReportsFresh(S + 1_000, undefined, S, I, E)).toBe(false);
    expect(newsReportsFresh(S + 1_000, S, undefined, I, E)).toBe(false);
  });
});
