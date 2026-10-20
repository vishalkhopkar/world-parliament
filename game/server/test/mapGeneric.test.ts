// The map registry is generic: a temporary fake map folder goes through the real gen-maps validation (child process),
// and fake maps (any seat count, any seat ids) run through the real GameService.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAP_MANIFESTS, WORLD_CONFIG, configForMap } from '@hp/shared';
import type { GameMapPackage } from '@hp/shared';
import { GAME_PACKAGES } from '../src/maps.generated';
import { makeMapProvider, makeRegistryMapProvider, registryEntries } from '../src/core/maps';
import { Ctx, driveTo, lineMap } from './helpers';

const gameDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsx = path.join(gameDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-maps-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// ------------------------------------------------------------------ fake map folders
type Pkg = Record<string, any>;
interface Opts {
  manifest?: (m: Record<string, any>) => void;
  pkg?: (p: Pkg) => void;
  skip?: string[];
  rawManifest?: string;
  rawPkg?: string;
}

function goodPackage(id: string, n: number): Pkg {
  const base = JSON.parse(JSON.stringify(lineMap(n, id)));
  const ids: number[] = base.seats.map((s: { id: number }) => s.id);
  for (const k of [4, 5]) base.phaseGroups[String(k)] = Array.from({ length: k }, (_, g) => ids.filter((_id, i) => i % k === g));
  return { ...base, topo: { coarse: 'world.topo.json', detail: 'detail.topo.json' } };
}

/** Creates <maps>/<id>/ with a valid map.json, thumbnail, site and game package; `opts` break one thing. */
function makeMap(mapsDir: string, id: string, n: number, opts: Opts = {}): void {
  const dir = path.join(mapsDir, id);
  fs.mkdirSync(path.join(dir, 'site', 'data'), { recursive: true });
  const manifest: Record<string, any> = {
    id, name: `Fake ${id}`, description: 'a fake map', seatCount: n, thumbnail: 'thumbnail.jpg', site: 'site/index.html', gamePackage: 'site/data/game.json',
  };
  opts.manifest?.(manifest);
  const pkg = goodPackage(id, n);
  opts.pkg?.(pkg);
  const write = (rel: string, data: string | Buffer) => { if (!opts.skip?.includes(rel)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); } };
  write('map.json', opts.rawManifest ?? JSON.stringify(manifest));
  write('thumbnail.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  write('site/index.html', '<!doctype html>');
  write('site/data/game.json', opts.rawPkg ?? JSON.stringify(pkg));
  write('site/data/world.topo.json', '{}');
  write('site/data/detail.topo.json', '{}');
}

interface Run { code: number; out: string; err: string }
function genMaps(mapsDir: string, ...flags: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [tsx, 'scripts/gen-maps.ts', `--maps-dir=${mapsDir}`, '--dry', ...flags], { cwd: gameDir, timeout: 60_000 }, (e, out, err) => {
      resolve({ code: e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0, out, err });
    });
  });
}

let counter = 0;
const fresh = () => { const d = path.join(root, `case${counter++}`); fs.mkdirSync(d); return d; };

describe('gen-maps validation of a temporary maps folder (real script, child process)', () => {
  it('accepts several valid fake maps of different sizes and reports them (no files written: --dry)', async () => {
    const dir = fresh();
    makeMap(dir, 'tiny-3', 3);
    makeMap(dir, 'odd-7', 7);
    makeMap(dir, 'big-120', 120);
    const before = fs.readFileSync(path.join(gameDir, 'shared/src/maps.generated.ts'), 'utf8');
    const r = await genMaps(dir);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('3 map(s)');
    expect(r.out).toContain('tiny-3 (3 seats)');
    expect(r.out).toContain('big-120 (120 seats)');
    expect(fs.readFileSync(path.join(gameDir, 'shared/src/maps.generated.ts'), 'utf8')).toBe(before);
  }, 60_000);

  const broken: [string, Opts, RegExp][] = [
    ['id differs from the folder name', { manifest: (m) => { m.id = 'other'; } }, /must equal the folder name/],
    ['manifest field missing', { manifest: (m) => { delete m.description; } }, /missing "description"/],
    ['manifest field empty', { manifest: (m) => { m.name = ''; } }, /missing "name"/],
    ['seatCount is not an integer', { manifest: (m) => { m.seatCount = 4.5; } }, /seatCount must be a positive integer/],
    ['seatCount is zero', { manifest: (m) => { m.seatCount = 0; } }, /seatCount must be a positive integer/],
    ['thumbnail file missing', { skip: ['thumbnail.jpg'] }, /"thumbnail" file not found/],
    ['site entry missing', { skip: ['site/index.html'] }, /"site" file not found/],
    ['game package missing', { skip: ['site/data/game.json'] }, /"gamePackage" file not found/],
    ['manifest is not JSON', { rawManifest: '{ nope' }, /map.json is not valid JSON/],
    ['game package is not JSON', { rawPkg: '<html>' }, /game package is not valid JSON/],
    ['package mapId differs', { pkg: (p) => { p.mapId = 'x'; } }, /mapId "x" must equal/],
    ['package seatCount differs from the manifest', { pkg: (p) => { p.seatCount = 6; } }, /seatCount 6 != manifest 5/],
    ['fewer seats than seatCount', { pkg: (p) => { p.seats.pop(); } }, /seats.length 4 != 5/],
    ['duplicate seat ids', { pkg: (p) => { p.seats[1].id = p.seats[0].id; } }, /duplicate seat ids/],
    ['seat without a name', { pkg: (p) => { delete p.seats[2].name; } }, /seat 3 malformed/],
    ['seat with a non-finite coordinate', { pkg: (p) => { p.seats[0].lon = 'east'; } }, /seat 1 malformed/],
    ['neighbour that does not exist', { pkg: (p) => { p.seats[0].neighbours = [99]; } }, /unknown neighbour/],
    ['phaseGroups key missing', { pkg: (p) => { delete p.phaseGroups['4']; } }, /phaseGroups\["4"\] missing/],
    ['phaseGroups with the wrong number of groups', { pkg: (p) => { p.phaseGroups['2'] = [p.phaseGroups['2'][0]]; } }, /phaseGroups\["2"\] has 1 groups/],
    ['a seat in no group', { pkg: (p) => { p.phaseGroups['3'][0].pop(); } }, /phaseGroups\["3"\].*partitioned/],
    ['a seat in two groups', { pkg: (p) => { p.phaseGroups['2'][1].push(p.phaseGroups['2'][0][0]); } }, /phaseGroups\["2"\].*partitioned/],
    ['topo.coarse missing from the package', { pkg: (p) => { delete p.topo.coarse; } }, /topo.coarse missing/],
    ['topo file does not exist', { skip: ['site/data/world.topo.json'] }, /topo.coarse file not found/],
    ['detail topo declared but missing', { skip: ['site/data/detail.topo.json'] }, /topo.detail file not found/],
  ];

  // all broken maps live in ONE maps folder and are validated in a single run (each gen-maps start costs ~1.5 s)
  let all: Run;
  beforeAll(async () => {
    const dir = fresh();
    makeMap(dir, 'good-5', 5);
    broken.forEach(([, opts], i) => makeMap(dir, `bad${String(i).padStart(2, '0')}`, 5, opts));
    all = await genMaps(dir);
  }, 60_000);

  it('one broken map fails the whole run (exit 1) and the good map next to them is not blamed', () => {
    expect(all.code).toBe(1);
    expect(all.err).toContain('map validation FAILED');
    expect(all.err).not.toContain('maps/good-5');
  });

  it.each(broken.map((b, i) => [b[0], i, b[2]] as const))('rejects: %s', (_label, i, expected) => {
    const lines = all.err.split(/\r?\n/).filter((l) => l.includes(`maps/bad${String(i).padStart(2, '0')}:`));
    expect(lines.length, all.err).toBeGreaterThan(0);
    expect(lines.join(' | ')).toMatch(expected);
  });

  it('a folder without map.json is skipped with a warning, not an error', async () => {
    const dir = fresh();
    makeMap(dir, 'real', 4);
    fs.mkdirSync(path.join(dir, 'just-notes'));
    fs.writeFileSync(path.join(dir, 'README.md'), 'not a map');
    const r = await genMaps(dir);
    expect(r.code, r.err).toBe(0);
    expect(r.out + r.err).toContain('skip maps/just-notes');
    expect(r.out).toContain('1 map(s)');
  }, 60_000);

  it('an empty maps folder or a missing one is an error', async () => {
    const empty = fresh();
    expect((await genMaps(empty)).code).toBe(1);
    expect((await genMaps(path.join(root, 'does-not-exist'))).code).toBe(1);
  }, 60_000);

  it('--check fails (exit 2, "STALE") when the committed registry does not match the maps folder, and passes for the real repo', async () => {
    const dir = fresh();
    makeMap(dir, 'something-else', 4);
    const stale = await new Promise<Run>((resolve) => execFile(process.execPath, [tsx, 'scripts/gen-maps.ts', `--maps-dir=${dir}`, '--check'], { cwd: gameDir }, (e, out, err) => resolve({ code: e ? (e as { code?: number }).code ?? 1 : 0, out, err })));
    expect(stale.code).toBe(2);
    expect(stale.err).toContain('STALE');
    const real = await new Promise<Run>((resolve) => execFile(process.execPath, [tsx, 'scripts/gen-maps.ts', '--check'], { cwd: gameDir }, (e, out, err) => resolve({ code: e ? (e as { code?: number }).code ?? 1 : 0, out, err })));
    expect(real.code, real.err).toBe(0);
  }, 60_000);
});

describe('registry (generated files)', () => {
  it('every manifest has a package with the same id and seat count, and vice versa', () => {
    expect(Object.keys(GAME_PACKAGES).sort()).toEqual(MAP_MANIFESTS.map((m) => m.id).sort());
    for (const m of MAP_MANIFESTS) {
      expect(GAME_PACKAGES[m.id].mapId).toBe(m.id);
      expect(GAME_PACKAGES[m.id].seatCount).toBe(m.seatCount);
      expect(GAME_PACKAGES[m.id].seats).toHaveLength(m.seatCount);
    }
  });

  it('manifest ids are unique and match their folder in maps/', () => {
    const ids = MAP_MANIFESTS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const mapsDir = path.resolve(gameDir, '../maps');
    for (const id of ids) expect(fs.existsSync(path.join(mapsDir, id, 'map.json'))).toBe(true);
    const folders = fs.readdirSync(mapsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(mapsDir, e.name, 'map.json'))).map((e) => e.name);
    expect(folders.sort()).toEqual([...ids].sort());
  });

  it('the registry provider serves every registered map with a config of the right mapId / seatCount and cached kernels', () => {
    const provider = makeRegistryMapProvider();
    for (const m of MAP_MANIFESTS) {
      const a = provider(m.id)!;
      expect(a.cfg.mapId).toBe(m.id);
      expect(a.cfg.seatCount).toBe(m.seatCount);
      expect(a.kernels.n).toBe(m.seatCount);
      expect(provider(m.id)!.kernels).toBe(a.kernels);
    }
  });

  it('unknown ids and prototype keys are not maps', () => {
    const provider = makeRegistryMapProvider();
    for (const id of ['', 'atlantis', 'constructor', '__proto__', 'toString', 'hasOwnProperty', ' world-500', 'WORLD-500']) expect(provider(id), JSON.stringify(id)).toBeUndefined();
  });

  it('registryEntries applies the tune function to every map without touching WORLD_CONFIG', () => {
    const entries = registryEntries((c) => ({ ...c, budget: 42 }));
    for (const e of Object.values(entries)) expect(e.cfg.budget).toBe(42);
    expect(WORLD_CONFIG.budget).not.toBe(42);
  });

  it('configForMap: tuned maps keep their own config, others get a WORLD_CONFIG copy with their id and seat count', () => {
    expect(configForMap('world-500', 500)).toBe(WORLD_CONFIG);
    const fake = configForMap('fake-12', 12);
    expect(fake).toMatchObject({ mapId: 'fake-12', seatCount: 12, budget: WORLD_CONFIG.budget });
    expect(fake).not.toBe(WORLD_CONFIG);
    expect(WORLD_CONFIG.seatCount).toBe(500);
  });
});

describe('fake maps play like real ones', () => {
  it('a provider with only a fake map: createGame accepts its id and rejects world-500', async () => {
    const c = new Ctx({ map: lineMap(9, 'fake-9') });
    await expect(c.svc.createGame({ nickname: 'a', mapId: 'world-500', phases: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const r = await c.svc.createGame({ nickname: 'a', mapId: 'fake-9', phases: 3 });
    expect((await c.repo.getGame(r.gameId))!.mapId).toBe('fake-9');
  });

  it('two maps side by side: each game uses its own seats and majority', async () => {
    const a = lineMap(5, 'five');
    const b = lineMap(8, 'eight');
    const provider = makeMapProvider({ five: { map: a, cfg: configForMap('five', 5) }, eight: { map: b, cfg: configForMap('eight', 8) } });
    expect(provider('five')!.map.seats).toHaveLength(5);
    expect(provider('eight')!.map.seats).toHaveLength(8);
    expect(provider('five')!.kernels.n).toBe(5);
    expect(provider('eight')!.cfg.seatCount).toBe(8);
  });

  it('seat ids need not be 1..N (e.g. 10, 20, ...): campaign, polling, counting and results use the real ids', async () => {
    const base = lineMap(5, 'sparse');
    const ids = [10, 20, 30, 40, 50];
    const map: GameMapPackage = {
      ...base,
      seats: base.seats.map((s, i) => ({ ...s, id: ids[i] })),
      phaseGroups: Object.fromEntries(Object.entries(base.phaseGroups).map(([k, g]) => [k, g.map((grp) => grp.map((id) => ids[id - 1]))])),
    };
    const c = await new Ctx({ map }).started(2, 2);
    for (const id of ids) await c.send(0, { action: 'campaign', type: 'rally', seat: id });
    await c.send(0, { action: 'campaign', type: 'rally', seat: 1 }); // 1 is not a seat of this map
    expect(c.lastError(0)?.error).toBe('BAD_REQUEST');
    await driveTo(c, 'finished');
    const res = await c.repo.listSeatResults(c.gameId);
    expect(res.map((r) => r.seat).sort((x, y) => x - y)).toEqual(ids);
    const result = (await c.repo.getResult(c.gameId))!;
    expect(result.tally[c.p[0].playerId]).toBe(5);
    expect(result.outcome).toBe('majority');
  });

  it('a map that lacks a phase grouping refuses games with that phase count', async () => {
    const c = new Ctx({ map: lineMap(2, 'two') }); // groupings 1 and 2 only
    await expect(c.svc.createGame({ nickname: 'a', mapId: 'two', phases: 3 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.svc.createGame({ nickname: 'a', mapId: 'two', phases: 2 })).resolves.toBeTruthy();
  });
});
