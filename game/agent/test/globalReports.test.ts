// get_global_reports: the free news-agency projections (offline fake session; the client call is mocked).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { WORLD_CONFIG } from '@hp/shared';
import type { GlobalReports } from '@hp/shared';
import { ACTION_BY_NAME, executeAction } from '../src/actions';
import { GameClient } from '../src/client';
import { applyMessage, newState } from '../src/state';
import { renderRules, rulesValues } from '../src/rules';
import { fakeSession, seatDir } from './fake';
import type { SeatDirectory } from '../src/resolve';

let dir: SeatDirectory;
beforeAll(async () => { dir = await seatDir(); });

const ids = ['h', 'me', 'c', 'd'];
function reports(): GlobalReports {
  const t0 = Date.now() - 60_000;
  const seats = (a: number[]) => Object.fromEntries(ids.map((id, i) => [id, a[i]]));
  return {
    asOf: t0 + 30_000, sampleIntervalMs: 30_000,
    agencies: WORLD_CONFIG.news.agencies.map((a, k) => ({
      id: a.name.toLowerCase().replace(/\W+/g, '-'), name: a.name,
      points: [{ t: t0, seats: seats([125, 125, 125, 125]) }, { t: t0 + 30_000, seats: seats([160 + k, 140, 120, 80 - k]) }],
      ranges: Object.fromEntries(ids.map((id, i) => [id, [100 + i, 180 + i + k] as [number, number]])),
    })),
  };
}

describe('get_global_reports', () => {
  it('is a free, read-only tool in the action table; the client has a matching call', () => {
    const a = ACTION_BY_NAME.get('get_global_reports')!;
    expect(a).toBeTruthy();
    expect(a.readOnly).toBe(true);
    expect(a.description).toMatch(/free/i);
    expect(typeof GameClient.prototype.globalReports).toBe('function');
  });

  it('returns each configured agency with the latest seats and range per named party, sorted, and costs nothing', async () => {
    const { s, c } = fakeSession(dir);
    c.globalReports = vi.fn(async () => reports()) as never;
    const before = c.state.priv!.budget;
    const r = await executeAction(s, 'get_global_reports', {});
    expect(r.ok).toBe(true);
    const d = (r as { data: any }).data;
    expect(d.agencies.map((a: any) => a.name)).toEqual(WORLD_CONFIG.news.agencies.map((a) => a.name));
    const first = d.agencies[0];
    expect(first.parties).toHaveLength(4);
    expect(first.parties[0].party).toBe('Party Asha');
    expect(first.parties[0].projected_seats).toBe(160);
    expect(first.parties[0].range_seats).toEqual([100, 180]);
    expect(first.parties.map((p: any) => p.projected_seats)).toEqual([...first.parties.map((p: any) => p.projected_seats)].sort((x: number, y: number) => y - x));
    expect(first.history.length).toBe(2);
    expect(c.state.priv!.budget).toBe(before);
  });

  it('is refused in the lobby and when news agencies are switched off, without asking the server', async () => {
    const lobby = fakeSession(dir, { status: 'lobby' });
    lobby.c.globalReports = vi.fn(async () => reports()) as never;
    const e1 = await executeAction(lobby.s, 'get_global_reports', {});
    expect(e1.ok).toBe(false);
    expect((e1 as any).error.code).toBe('WRONG_PHASE');
    expect(lobby.c.globalReports).not.toHaveBeenCalled();

    const { s, c } = fakeSession(dir);
    c.globalReports = vi.fn(async () => reports()) as never;
    const prev = WORLD_CONFIG.news.enabled;
    WORLD_CONFIG.news.enabled = false;
    try {
      const e2 = await executeAction(s, 'get_global_reports', {});
      expect((e2 as any).error.code).toBe('FORBIDDEN');
      expect(c.globalReports).not.toHaveBeenCalled();
    } finally { WORLD_CONFIG.news.enabled = prev; }
  });

  it('works after the campaign too (the graphs are frozen then)', async () => {
    const { s, c } = fakeSession(dir, { status: 'counting' });
    c.globalReports = vi.fn(async () => reports()) as never;
    expect((await executeAction(s, 'get_global_reports', {})).ok).toBe(true);
  });
});

describe('state: globalReports message', () => {
  it('is kept as the latest reports and adds no event to the log', () => {
    const st = newState();
    const r = reports();
    expect(applyMessage(st, { type: 'globalReports', reports: r }, Date.now())).toEqual([]);
    expect(st.globalReports).toEqual(r);
  });
});

describe('RULES: global reports section', () => {
  it('names the agencies and the tool, from the config, with no unrendered placeholder', () => {
    const text = renderRules(WORLD_CONFIG);
    expect(text).not.toContain('{{');
    for (const a of WORLD_CONFIG.news.agencies) expect(text).toContain(a.name);
    expect(text).toContain('get_global_reports');
    expect(rulesValues(WORLD_CONFIG).NEWS_AGENCY_NAMES).toContain(WORLD_CONFIG.news.agencies[0].name);
    expect(rulesValues(WORLD_CONFIG).NEWS_ERROR_START_TEXT).toContain(String(WORLD_CONFIG.news.errorStartMinPct));
  });
  it('says the reports are switched off when news is disabled', () => {
    const text = renderRules({ ...WORLD_CONFIG, news: { ...WORLD_CONFIG.news, enabled: false } });
    expect(text).toMatch(/global reports? .*switched off/i);
  });
});
