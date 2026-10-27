/** Extra wait after a sample-grid time so the server's newest point exists when we ask (clock offset error, network). */
export const NEWS_POLL_LAG_MS = 500;

/**
 * Milliseconds until the news-agencies modal should ask the server again, in SERVER time: just after the next point of the sample
 * grid (campaignStart + k x interval; the server adds one point per grid time), instead of every interval from when the modal opened.
 * The campaign end is polled once too (the closing point is off the grid when the interval does not divide the campaign); after it
 * the series is frozen and the result is null (stop). Without a campaign start: one interval from now. Always > 0 or null.
 */
/**
 * True when the answer we already hold (its asOf = time of its newest point) still has the newest point the server could give at
 * `now` (server time): the data only changes at sample-grid times and at the campaign end, so no request is needed. Reopening the
 * modal, or any poll that fires before the next grid time, then costs nothing. Without a timeline we cannot tell: not fresh.
 */
export function newsReportsFresh(now: number, asOf: number | undefined, start: number | undefined, interval: number, end: number | undefined): boolean {
  if (asOf === undefined || start === undefined || !(interval > 0)) return false;
  const t = now - NEWS_POLL_LAG_MS;
  if (t < start) return asOf >= start;
  if (end !== undefined && t >= end) return asOf >= end;
  return asOf >= start + Math.floor((t - start) / interval) * interval;
}

export function nextNewsPollDelay(now: number, start: number | undefined, interval: number, end: number | undefined): number | null {
  const lag = NEWS_POLL_LAG_MS;
  if (end !== undefined && now >= end + lag) return null;
  if (start === undefined || !(interval > 0)) return interval > 0 ? interval : null;
  // first grid time + lag strictly after now
  const k = Math.max(0, Math.floor((now - lag - start) / interval) + 1);
  let target = start + k * interval + lag;
  if (end !== undefined && end + lag < target) target = end + lag;
  return target - now;
}
