// Test helper: the shipped config switches the analyst reports off, so tests that BUY reports (offline fake sessions and the
// in-process dev server share the WORLD_CONFIG object) switch them on for their file and restore the flags afterwards.
import { afterAll, beforeAll } from 'vitest';
import { WORLD_CONFIG } from '@hp/shared';

export function setReportFlags(seat: boolean, global: boolean): () => void {
  const a = WORLD_CONFIG.analyst;
  const prev = { seat: a.seatReport.enabled, global: a.globalReport.enabled };
  a.seatReport.enabled = seat;
  a.globalReport.enabled = global;
  return () => { a.seatReport.enabled = prev.seat; a.globalReport.enabled = prev.global; };
}

/** Switch both reports on for every test of the calling file. */
export function enableReportsForFile(): void {
  let restore: (() => void) | null = null;
  beforeAll(() => { restore = setReportFlags(true, true); });
  afterAll(() => { restore?.(); });
}
