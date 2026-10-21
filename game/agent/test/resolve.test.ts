import { beforeAll, describe, expect, it } from 'vitest';
import { PARTY_COLOURS, PARTY_SYMBOLS, WORLD_CONFIG } from '@hp/shared';
import type { PlayerPublic } from '@hp/shared';
import { loadGamePackage } from '../src/gamePackage';
import { SeatDirectory, norm, resolveColour, resolveOption, resolvePlayer, resolvePortfolio } from '../src/resolve';

const players: PlayerPublic[] = [
  { playerId: 'p1', nickname: 'Asha', isAdmin: true, status: 'active', party: { name: 'Saffron Front', colour: '#E8710A', symbol: 'sun' } },
  { playerId: 'p2', nickname: 'Claude', isAdmin: false, kind: 'agent', status: 'active', party: { name: 'Blue Wave', colour: '#1F5FBF', symbol: 'globe' } },
  { playerId: 'p3', nickname: 'Codex', isAdmin: false, kind: 'agent', status: 'active', party: { name: 'Green Deal', colour: '#1E8C45', symbol: 'leaf' } },
  { playerId: 'p4', nickname: 'Clara', isAdmin: false, status: 'active' },
];

describe('norm', () => {
  it('strips accents, unifies dashes and case', () => {
    expect(norm('Córdoba–Patagonia')).toBe('cordoba patagonia');
    expect(norm('  Terai-Basti ')).toBe('terai basti');
    expect(norm('Saharanpur—Meerut')).toBe('saharanpur meerut');
  });
});

describe('resolvePlayer', () => {
  it('matches id, party name (case-insensitive), "me"', () => {
    expect(resolvePlayer(players, 'p2', 'p1').playerId).toBe('p2');
    expect(resolvePlayer(players, 'saffron front', 'p1').playerId).toBe('p1');
    expect(resolvePlayer(players, 'BLUE WAVE', 'p1').playerId).toBe('p2');
    expect(resolvePlayer(players, 'green deal', 'p1').playerId).toBe('p3');
    expect(resolvePlayer(players, 'me', 'p3').playerId).toBe('p3');
  });
  it('accepts unique prefixes but refuses ambiguous ones', () => {
    expect(resolvePlayer(players, 'gre', 'p1').playerId).toBe('p3');
    expect(() => resolvePlayer(players, 'cl', 'p1')).toThrow(/matches/);
    expect(() => resolvePlayer([...players, { ...players[2], playerId: 'p5', party: { ...players[2].party!, name: 'Green Wave' } }], 'green', 'p1')).toThrow(/ambiguous/);
  });
  it('lists the players when nothing matches', () => {
    try { resolvePlayer(players, 'zorro', 'p1'); expect.unreachable(); } catch (e: any) {
      expect(e.code).toBe('UNKNOWN_PLAYER');
      expect(e.message).not.toContain('Asha');
      expect(e.message).not.toContain('Claude');
      expect(e.message).toContain('Blue Wave');
    }
  });
});

describe('party options', () => {
  it('colours by hex (with/without #), id and label', () => {
    expect(resolveColour(PARTY_COLOURS, '#1f5fbf').hex).toBe('#1F5FBF');
    expect(resolveColour(PARTY_COLOURS, '1F5FBF').hex).toBe('#1F5FBF');
    expect(resolveColour(PARTY_COLOURS, 'Saffron').hex).toBe('#E8710A');
    expect(resolveColour(PARTY_COLOURS, 'crimson').label).toBe('Crimson');
    expect(() => resolveColour(PARTY_COLOURS, 'chartreuse')).toThrow(/Valid:/);
  });
  it('symbols by id or label', () => {
    expect(resolveOption(PARTY_SYMBOLS, 'Scales', 'symbol').id).toBe('scales');
    expect(resolveOption(PARTY_SYMBOLS, 'rocket', 'symbol').id).toBe('rocket');
    expect(() => resolveOption(PARTY_SYMBOLS, 'banana', 'symbol')).toThrow(/Unknown symbol/);
  });
  it('portfolios by id or label', () => {
    const defs = WORLD_CONFIG.points.portfolios;
    expect(resolvePortfolio(defs, 'pm')).toBe('PM');
    expect(resolvePortfolio(defs, 'Prime Minister')).toBe('PM');
    expect(resolvePortfolio(defs, 'external affairs')).toBe('EXTERNAL');
    expect(() => resolvePortfolio(defs, 'tea')).toThrow(/Unknown portfolio/);
  });
});

describe('SeatDirectory (real world-500 package)', () => {
  let dir: SeatDirectory;
  beforeAll(async () => {
    const pkg = await loadGamePackage('world-500');
    expect(pkg).not.toBeNull();
    dir = new SeatDirectory(pkg!);
  });

  it('resolves ids, numeric strings, exact names, dash/accents variants', () => {
    expect(dir.resolve(2).name).toBe('Delhi East');
    expect(dir.resolve('2').name).toBe('Delhi East');
    expect(dir.resolve('#2').name).toBe('Delhi East');
    expect(dir.resolve('delhi east').id).toBe(2);
    expect(dir.resolve('Cordoba-Patagonia').name).toBe('Córdoba–Patagonia');
    // seat names are edited by hand in seats.json, so derive the name instead of hard-coding it
    expect(dir.resolve(dir.resolve(1).name.toLowerCase()).id).toBe(1);
  });
  it('resolves unique prefixes/substrings and refuses ambiguous ones with candidates', () => {
    expect(dir.resolve('Istan').name).toBe('Istanbul');
    try { dir.resolve('Delhi'); expect.unreachable(); } catch (e: any) {
      expect(e.code).toBe('UNKNOWN_SEAT');
      expect(e.message).toContain('Delhi East');
      expect(e.message).toContain('Delhi West');
    }
  });
  it('rejects unknown ids and names helpfully', () => {
    expect(() => dir.resolve(9999)).toThrow(/valid ids: 1\.\.500/);
    expect(() => dir.resolve('Atlantis')).toThrow(/No seat is named/);
    expect(() => dir.resolve('')).toThrow();
  });
  it('search() finds names by substring regardless of accents', () => {
    expect(dir.search('cordoba').map((s) => s.name)).toContain('Córdoba–Patagonia');
    expect(dir.search('delhi').length).toBeGreaterThanOrEqual(2);
  });
});

describe('resolvePlayer never matches nicknames', () => {
  it('rejects a nickname even when it is exact or a prefix', () => {
    for (const nick of ['Asha', 'asha', 'Claude', 'cod', 'Clara']) {
      expect(() => resolvePlayer(players, nick, 'p1'), nick).toThrow(/No player matches/);
    }
  });
});
