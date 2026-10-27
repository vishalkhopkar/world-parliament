import { describe, expect, it } from 'vitest';
import {
  WORLD_CONFIG, finalResult, governmentFromOffer, majorityGovernment, validateGovernment,
} from '../src';
import type { CoalitionOffer, Government } from '../src';

const cfg = WORLD_CONFIG;

describe('validateGovernment', () => {
  const tally = { A: 120, B: 110, C: 67, D: 56, E: 47 };
  it('accepts a valid majority coalition', () => {
    expect(validateGovernment({ PM: ['B'], DPM: ['C', 'D'] }, tally, cfg, 400)).toBeNull();
    expect(validateGovernment({ PM: ['A'], DPM: ['B', 'C'] }, tally, cfg, 400)).toBeNull();
  });
  it('requires exactly one PM', () => {
    expect(validateGovernment({ DPM: ['C'] }, tally, cfg, 400)).toMatch(/Prime Minister/);
    expect(validateGovernment({ PM: [], DPM: ['C'] }, tally, cfg, 400)).toMatch(/Prime Minister/);
    expect(validateGovernment({ PM: ['A', 'B'] }, tally, cfg, 400)).toMatch(/only one/);
  });
  it('rejects portfolios over their max', () => {
    expect(validateGovernment({ PM: ['A'], DPM: ['B', 'C', 'D'] }, tally, cfg, 400)).toMatch(/Deputy/);
    expect(validateGovernment({ PM: ['A'], HOME: ['B', 'C'] }, tally, cfg, 400)).toMatch(/Home/);
  });
  it('rejects unknown portfolios', () => {
    expect(validateGovernment({ PM: ['A'], TREASURER: ['B'] }, tally, cfg, 400)).toMatch(/Unknown portfolio/);
  });
  it('requires a majority among named players (members), threshold odd/even', () => {
    expect(validateGovernment({ PM: ['C'], DPM: ['D'] }, tally, cfg, 400)).toMatch(/needs 201/);
    expect(validateGovernment({ PM: ['A'], DPM: ['B'] }, { A: 100, B: 100 }, cfg, 400)).toMatch(/needs 201/);
    expect(validateGovernment({ PM: ['A'], DPM: ['B'] }, { A: 100, B: 101 }, cfg, 400)).toBeNull();
    expect(validateGovernment({ PM: ['A'], DPM: ['B'] }, { A: 125, B: 125 }, cfg, 501)).toMatch(/needs 251/);
    expect(validateGovernment({ PM: ['A'], DPM: ['B'] }, { A: 125, B: 126 }, cfg, 501)).toBeNull();
  });
  it('counts a player only once even if they hold several portfolios', () => {
    expect(validateGovernment({ PM: ['C'], HOME: ['C'], DEFENCE: ['C'] }, tally, cfg, 400)).toMatch(/needs 201/);
  });
  it('counts partners invited without a portfolio towards the majority (once each)', () => {
    expect(validateGovernment({ PM: ['B'], HOME: ['C'] }, tally, cfg, 400)).toMatch(/needs 201/);
    expect(validateGovernment({ PM: ['B'], HOME: ['C'] }, tally, cfg, 400, ['D'])).toBeNull();
    expect(validateGovernment({ PM: ['B'], HOME: ['C'] }, tally, cfg, 400, ['C', 'B'])).toMatch(/needs 201/);
  });
});

describe('governmentFromOffer', () => {
  const base: CoalitionOffer = {
    offerId: 'o1', proposer: 'B', partners: ['C', 'D', 'E'], accepted: ['C', 'D', 'E'], status: 'accepted', createdAt: 1,
    portfolios: { PM: ['B'], FINANCE: ['B'], DPM: ['C', 'D'], HOME: ['C'], DEFENCE: ['D'], EXTERNAL: ['E'], SPEAKER: ['E'] },
  };
  it('builds members, pm, viaNegotiation', () => {
    const g = governmentFromOffer(base, 99);
    expect(g.pm).toBe('B');
    expect(g.members).toEqual(['B', 'C', 'D', 'E']);
    expect(g.viaNegotiation).toBe(true);
    expect(g.formedAt).toBe(99);
    expect(g.portfolios).toEqual(base.portfolios);
    expect(g.portfolios).not.toBe(base.portfolios);
  });
  it('assigns the proposer PM if missing or held by someone else; adds portfolio holders', () => {
    const g = governmentFromOffer({ ...base, partners: ['C'], portfolios: { DPM: ['C'], HOME: ['Z'] } }, 5);
    expect(g.portfolios.PM).toEqual(['B']);
    expect(g.members).toEqual(['B', 'C', 'Z']);
    const g2 = governmentFromOffer({ ...base, portfolios: { PM: ['C'] } }, 5);
    expect(g2.portfolios.PM).toEqual(['B']);
    expect(g2.pm).toBe('B');
  });
  it('gives the proposer every portfolio slot nobody was invited to hold (and so its points)', () => {
    const offer: CoalitionOffer = {
      ...base, partners: ['C', 'D'], accepted: ['C', 'D'], portfolios: { PM: ['B'], HOME: ['C'], DEFENCE: ['D'], DPM: ['C'] },
    };
    const g = governmentFromOffer(offer, 5);
    expect(g.portfolios.HOME).toEqual(['C']);
    expect(g.portfolios.DEFENCE).toEqual(['D']);
    expect(g.portfolios.DPM).toEqual(['C', 'B']);
    for (const def of cfg.points.portfolios) {
      if (['PM', 'HOME', 'DEFENCE', 'DPM'].includes(def.id)) continue;
      expect(g.portfolios[def.id]).toEqual(Array.from({ length: def.max }, () => 'B'));
    }
    expect(offer.portfolios.FINANCE).toBeUndefined();
    const res = finalResult({ B: 100, C: 60, D: 50 }, g, ['B', 'C', 'D'], new Set(), cfg, 400);
    const pts = (p: string) => res.points.find((x) => x.playerId === p)!.portfolioPoints;
    const total = cfg.points.portfolios.reduce((s, d) => s + d.points * d.max, 0);
    const held = (id: string) => cfg.points.portfolios.find((d) => d.id === id)!;
    expect(pts('C')).toBe(held('HOME').points + held('DPM').points);
    expect(pts('D')).toBe(held('DEFENCE').points);
    expect(pts('B') + pts('C') + pts('D')).toBe(total);
  });
});

describe('majorityGovernment', () => {
  it('holds every portfolio up to its max, not via negotiation', () => {
    const g = majorityGovernment('A', cfg, 7);
    expect(g.pm).toBe('A');
    expect(g.members).toEqual(['A']);
    expect(g.viaNegotiation).toBe(false);
    expect(g.portfolios.PM).toEqual(['A']);
    expect(g.portfolios.DPM).toEqual(['A', 'A']);
    expect(g.portfolios.HOME).toEqual(['A']);
    expect(g.portfolios.SPEAKER).toEqual(['A']);
    expect(Object.keys(g.portfolios).sort()).toEqual(cfg.points.portfolios.map((p) => p.id).sort());
  });
  it('majority result: all portfolio points + seats + floor, winner = pm', () => {
    const g = majorityGovernment('A', cfg, 7);
    const tally = { A: 260, B: 140 };
    const r = finalResult(tally, g, ['A', 'B'], new Set(), cfg, 400);
    expect(r.outcome).toBe('majority');
    expect(r.winners).toEqual(['A']);
    const a = r.points.find((p) => p.playerId === 'A')!;
    expect(a.portfolioPoints).toBe(100 + 2 * 50 + 4 * 20 + 10); // 290
    expect(a.seatPoints).toBe(130);
    expect(a.governmentFloor).toBe(10);
    expect(a.total).toBe(430);
    expect(r.points.find((p) => p.playerId === 'B')!.total).toBe(0);
  });
});

describe('finalResult', () => {
  it('worked example: N=400 coalition', () => {
    const tally = { A: 120, B: 110, C: 67, D: 56, E: 47 };
    const offer: CoalitionOffer = {
      offerId: 'o', proposer: 'B', partners: ['C', 'D', 'E'], accepted: ['C', 'D', 'E'], status: 'accepted', createdAt: 0,
      portfolios: { PM: ['B'], FINANCE: ['B'], DPM: ['C', 'D'], HOME: ['C'], DEFENCE: ['D'], EXTERNAL: ['E'], SPEAKER: ['E'] },
    };
    expect(validateGovernment(offer.portfolios, tally, cfg, 400)).toBeNull();
    const g = governmentFromOffer(offer, 1);
    const r = finalResult(tally, g, ['A', 'B', 'C', 'D', 'E'], new Set(), cfg, 400);
    const total = Object.fromEntries(r.points.map((p) => [p.playerId, p.total]));
    expect(total).toEqual({ A: 0, B: 185, C: 114, D: 108, E: 64 });
    expect(r.outcome).toBe('coalition');
    expect(r.winners).toEqual(['B']);
    expect(r.government).toBe(g);
    // breakdown details
    const c = r.points.find((p) => p.playerId === 'C')!;
    expect(c).toEqual({ playerId: 'C', portfolioPoints: 70, seatPoints: 34, governmentFloor: 10, total: 114 });
    const e = r.points.find((p) => p.playerId === 'E')!;
    expect(e).toEqual({ playerId: 'E', portfolioPoints: 30, seatPoints: 24, governmentFloor: 10, total: 64 });
    for (const p of r.points) expect(Number.isInteger(p.total)).toBe(true);
  });

  it('coalition ties share the win', () => {
    const g: Government = {
      pm: 'A', members: ['A', 'B'], viaNegotiation: true, formedAt: 0,
      portfolios: { PM: ['A'], DPM: ['B', 'B'] },
    };
    // A: 100 + seats ; B: 100 + seats ; equal seats
    const r = finalResult({ A: 100, B: 100, C: 20 }, g, ['A', 'B', 'C'], new Set(), cfg, 220);
    expect(r.outcome).toBe('coalition');
    expect(r.winners.sort()).toEqual(['A', 'B']);
  });

  it('eliminated players get 0 and cannot win', () => {
    const g: Government = {
      pm: 'A', members: ['A', 'B'], viaNegotiation: true, formedAt: 0, portfolios: { PM: ['A'], HOME: ['B'] },
    };
    const r = finalResult({ A: 150, B: 100, C: 0 }, g, ['A', 'B', 'C'], new Set(['C']), cfg, 250);
    expect(r.points.find((p) => p.playerId === 'C')).toEqual({
      playerId: 'C', portfolioPoints: 0, seatPoints: 0, governmentFloor: 0, total: 0,
    });
    expect(r.winners).toEqual(['A']);
  });

  it('2-player exact tie without government -> draw with equal points', () => {
    const r = finalResult({ A: 250, B: 250 }, null, ['A', 'B'], new Set(), cfg, 500);
    expect(r.outcome).toBe('draw');
    expect(r.winners.sort()).toEqual(['A', 'B']);
    expect(r.government).toBeNull();
    const [a, b] = r.points;
    expect(a.total).toBe(b.total);
    expect(a.portfolioPoints).toBe(0);
    expect(a.total).toBe(100 + 10); // round(200*250/500) + floor
  });

  it('draw also applies when a third player was eliminated', () => {
    const r = finalResult({ A: 100, B: 100 }, null, ['A', 'B', 'C'], new Set(['C']), cfg, 200);
    expect(r.outcome).toBe('draw');
    expect(r.points.find((p) => p.playerId === 'C')!.total).toBe(0);
  });

  it('no government -> noGovernment, nobody wins, all totals = opposition', () => {
    const r = finalResult({ A: 200, B: 150, C: 150 }, null, ['A', 'B', 'C'], new Set(), cfg, 500);
    expect(r.outcome).toBe('noGovernment');
    expect(r.winners).toEqual([]);
    expect(r.points.map((p) => p.total)).toEqual([0, 0, 0]);
    // 2 players, not tied
    const r2 = finalResult({ A: 260, B: 240 }, null, ['A', 'B'], new Set(), cfg, 500);
    expect(r2.outcome).toBe('noGovernment');
    // 3 players with an equal pair is NOT a draw
    const r3 = finalResult({ A: 250, B: 250, C: 0 }, null, ['A', 'B', 'C'], new Set(), cfg, 500);
    expect(r3.outcome).toBe('noGovernment');
  });

  it('seat points rounding uses Math.round (x.5 rounds up)', () => {
    const g = majorityGovernment('A', cfg, 0);
    const r = finalResult({ A: 67 }, g, ['A'], new Set(), cfg, 400);
    expect(r.points[0].seatPoints).toBe(34);
  });
});
