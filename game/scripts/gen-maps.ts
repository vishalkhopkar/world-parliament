// Map registry generator.  Run from game/:  npx tsx scripts/gen-maps.ts   (npm run gen:maps)
//
// Scans ../maps/*/map.json (one folder per map), validates every manifest and its game package, and writes
//   shared/src/maps.generated.ts   -> MAP_MANIFESTS: MapManifest[]            (used by web + shared)
//   server/src/maps.generated.ts   -> GAME_PACKAGES: Record<id, GameMapPackage> (static JSON imports, so esbuild /
//                                                                                vite / vitest bundle them; used by the server)
//   (and the same file's CANDIDATES: each map's optional site/data/candidates.csv, validated: header candidate_1..K, one row of K names per seat)
// Adding a map = adding a maps/<id>/ folder with a valid map.json, then running this script. No code changes.
// The generated files are committed. Exits non-zero on any validation error.
//
// Options (used by tests and CI):
//   --maps-dir=DIR  scan DIR instead of ../maps (or env HP_MAPS_DIR)
//   --dry           validate only, write nothing
//   --check         validate and fail (exit 2) if the committed generated files differ from what would be written (stale registry)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gameDir = path.resolve(here, '..');
const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const mapsDir = path.resolve(flagValue('maps-dir') ?? process.env.HP_MAPS_DIR ?? path.resolve(gameDir, '../maps'));
const DRY = argv.includes('--dry');
const CHECK = argv.includes('--check');
const MANIFEST_KEYS = ['id', 'name', 'description', 'seatCount', 'thumbnail', 'site', 'gamePackage'] as const;

interface Manifest {
  id: string; name: string; description: string; seatCount: number; thumbnail: string; site: string; gamePackage: string;
}

const errors: string[] = [];
const err = (id: string, msg: string) => errors.push(`maps/${id}: ${msg}`);

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function validateSeatPartition(id: string, label: string, groups: unknown, seatIds: number[]) {
  if (!Array.isArray(groups)) return err(id, `${label}: not an array`);
  const flat = (groups as number[][]).flat().sort((a, b) => a - b);
  const want = [...seatIds].sort((a, b) => a - b);
  if (flat.length !== want.length || flat.some((v, i) => v !== want[i])) err(id, `${label}: seats are not partitioned exactly once`);
}

function validate(id: string, dir: string, m: Manifest): boolean {
  const before = errors.length;
  for (const k of MANIFEST_KEYS) if (m[k] === undefined || m[k] === null || m[k] === '') err(id, `map.json: missing "${k}"`);
  if (m.id !== id) err(id, `map.json: id "${m.id}" must equal the folder name "${id}"`);
  if (!Number.isInteger(m.seatCount) || m.seatCount < 1) err(id, 'map.json: seatCount must be a positive integer');
  for (const k of ['thumbnail', 'site', 'gamePackage'] as const) {
    if (typeof m[k] === 'string' && !fs.existsSync(path.join(dir, m[k]))) err(id, `map.json: "${k}" file not found: ${m[k]}`);
  }
  if (errors.length > before) return false;

  const pkgFile = path.join(dir, m.gamePackage);
  let pkg: any;
  try { pkg = readJson(pkgFile); } catch (e) { err(id, `game package is not valid JSON: ${(e as Error).message}`); return false; }
  if (pkg.mapId !== id) err(id, `game package: mapId "${pkg.mapId}" must equal "${id}"`);
  if (pkg.seatCount !== m.seatCount) err(id, `game package: seatCount ${pkg.seatCount} != manifest ${m.seatCount}`);
  if (!Array.isArray(pkg.seats) || pkg.seats.length !== m.seatCount) err(id, `game package: seats.length ${pkg.seats?.length} != ${m.seatCount}`);
  else {
    const ids: number[] = pkg.seats.map((s: any) => s.id);
    if (new Set(ids).size !== ids.length) err(id, 'game package: duplicate seat ids');
    const idSet = new Set(ids);
    for (const s of pkg.seats) {
      if ('name' in s) { err(id, `game package: seat ${s.id} has a name; names live only in seats.json`); break; }
      if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat) || !Array.isArray(s.neighbours)) { err(id, `game package: seat ${s.id} malformed`); break; }
      if (s.neighbours.some((n: number) => !idSet.has(n))) { err(id, `game package: seat ${s.id} has an unknown neighbour`); break; }
    }
    for (let k = 1; k <= 5; k++) {
      const g = pkg.phaseGroups?.[String(k)];
      if (!g) { err(id, `game package: phaseGroups["${k}"] missing`); continue; }
      if (g.length !== k) err(id, `game package: phaseGroups["${k}"] has ${g.length} groups`);
      validateSeatPartition(id, `phaseGroups["${k}"]`, g, ids);
    }
  }
  for (const k of ['coarse', 'detail'] as const) {
    const rel = pkg.topo?.[k];
    if (k === 'coarse' && !rel) err(id, 'game package: topo.coarse missing');
    if (rel && !fs.existsSync(path.join(path.dirname(pkgFile), rel))) err(id, `game package: topo.${k} file not found: ${rel}`);
  }
  return errors.length === before;
}

/** Minimal CSV reader (RFC-4180 quotes, CRLF/LF); returns rows of cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c !== '')) rows.push(row);
  return rows;
}

/** Optional site/data/candidates.csv: header candidate_1..candidate_K, then one row of K non-empty names per seat (row n = seat n). */
function loadCandidates(id: string, dir: string, m: Manifest): string[][] | undefined {
  const file = path.join(dir, path.dirname(m.gamePackage), 'candidates.csv');
  if (!fs.existsSync(file)) return undefined;
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const [header, ...body] = rows;
  const k = header?.length ?? 0;
  const before = errors.length;
  if (k < 1 || header.some((h, i) => h.trim() !== `candidate_${i + 1}`)) err(id, 'candidates.csv: header must be candidate_1..candidate_K');
  if (body.length !== m.seatCount) err(id, `candidates.csv: ${body.length} rows, expected one per seat (${m.seatCount})`);
  const bad = body.findIndex(r => r.length !== k || r.some(c => !c.trim()));
  if (bad >= 0) err(id, `candidates.csv: row ${bad + 1} must have exactly ${k} non-empty names`);
  return errors.length === before ? body.map(r => r.map(c => c.trim())) : undefined;
}

if (!fs.existsSync(mapsDir)) { console.error(`maps dir not found: ${mapsDir}`); process.exit(1); }
const manifests: Manifest[] = [];
const candidatesByMap: Record<string, string[][]> = {};
for (const ent of fs.readdirSync(mapsDir, { withFileTypes: true }).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = path.join(mapsDir, ent.name);
  const file = path.join(dir, 'map.json');
  if (!fs.existsSync(file)) { console.warn(`skip maps/${ent.name}: no map.json`); continue; }
  let raw: any;
  try { raw = readJson(file); } catch (e) { err(ent.name, `map.json is not valid JSON: ${(e as Error).message}`); continue; }
  const m: Manifest = Object.fromEntries(MANIFEST_KEYS.map(k => [k, raw[k]])) as unknown as Manifest;
  if (validate(ent.name, dir, m)) {
    manifests.push(m);
    const cands = loadCandidates(ent.name, dir, m);
    if (cands) candidatesByMap[ent.name] = cands;
  }
}
if (errors.length) { console.error('map validation FAILED:\n  ' + errors.join('\n  ')); process.exit(1); }
if (!manifests.length) { console.error('no maps found under ' + mapsDir); process.exit(1); }

const HEADER = '// GENERATED by game/scripts/gen-maps.ts from ../maps/*/map.json - do not edit. Regenerate: npm run gen:maps (in game/).\n';

const ident = (id: string) => 'pkg_' + id.replace(/[^A-Za-z0-9]/g, '_');
const outputs: [string, string][] = [
  [path.join(gameDir, 'shared/src/maps.generated.ts'),
    HEADER + "import type { MapManifest } from './types';\n\n" +
    'export const MAP_MANIFESTS: MapManifest[] = ' + JSON.stringify(manifests, null, 2) + ';\n'],
  [path.join(gameDir, 'server/src/maps.generated.ts'),
    HEADER + "import type { GameMapPackage } from '@hp/shared';\n" +
    manifests.map(m => `import ${ident(m.id)} from '../../../maps/${m.id}/${m.gamePackage}';`).join('\n') + '\n\n' +
    '/** Every maps/<id>/ game package, statically imported so the Lambda bundle and the local server both contain them. */\n' +
    'export const GAME_PACKAGES: Record<string, GameMapPackage> = {\n' +
    manifests.map(m => `  ${JSON.stringify(m.id)}: ${ident(m.id)} as unknown as GameMapPackage,`).join('\n') + '\n};\n\n' +
    "/** Each map's optional candidates.csv (site/data/candidates.csv) as rows of names (row n = seat n); the server turns a party's column into the candidate names players see. */\n" +
    'export const CANDIDATES: Record<string, string[][]> = ' + JSON.stringify(candidatesByMap) + ';\n'],
];
if (CHECK) {
  const norm = (t: string) => t.replace(/\r\n/g, '\n');
  const stale = outputs.filter(([file, text]) => !fs.existsSync(file) || norm(fs.readFileSync(file, 'utf8')) !== text).map(([file]) => path.relative(gameDir, file));
  if (stale.length) { console.error('generated map registry is STALE (run `npm run gen:maps` and commit): ' + stale.join(', ')); process.exit(2); }
} else if (!DRY) {
  for (const [file, text] of outputs) fs.writeFileSync(file, text);
}

console.log(`gen-maps: ${manifests.length} map(s): ${manifests.map(m => `${m.id} (${m.seatCount} seats)`).join(', ')}`);
