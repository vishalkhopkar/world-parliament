// Load the GameMapPackage (centres, neighbours, polling-phase groups) for a map id, and the seat NAMES from seats.json
// (the only place names live; game.json has ids only).
// Order: HP_GAME_PACKAGE env file -> generated registry (server/src/maps.generated.ts) -> maps/<id>/site/data/game.json (disk).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GameMapPackage } from '@hp/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root = game/agent/src/../../.. */
export const REPO_ROOT = resolve(HERE, '..', '..', '..');

const cache = new Map<string, GameMapPackage | null>();

function readPkg(file: string): GameMapPackage | null {
  try {
    const p = JSON.parse(readFileSync(file, 'utf8')) as GameMapPackage;
    return p && Array.isArray(p.seats) && p.phaseGroups ? p : null;
  } catch { return null; }
}

async function fromRegistry(mapId: string): Promise<GameMapPackage | null> {
  try {
    const file = resolve(HERE, '..', '..', 'server', 'src', 'maps.generated.ts');
    if (!existsSync(file)) return null;
    const spec = pathToFileURL(file).href; // variable specifier: not resolved by tsc, only works where TS can be imported (tsx/vitest)
    const mod = (await import(/* @vite-ignore */ spec)) as { GAME_PACKAGES?: Record<string, unknown> };
    let v: unknown = mod.GAME_PACKAGES?.[mapId];
    if (typeof v === 'function') v = await (v as () => unknown)();
    const p = v as GameMapPackage | undefined;
    return p && Array.isArray(p.seats) ? p : null;
  } catch { return null; }
}

export function packageCandidates(mapId: string, root = REPO_ROOT): string[] {
  const out: string[] = [];
  if (process.env.HP_GAME_PACKAGE) out.push(resolve(process.env.HP_GAME_PACKAGE));
  out.push(join(root, 'maps', mapId, 'site', 'data', 'game.json'));
  return out;
}

/** Seat id -> name from maps/<id>/site/data/seats.json (next to HP_GAME_PACKAGE when that is set). {} when unavailable. */
export function loadSeatNames(mapId: string, root = REPO_ROOT): Record<number, string> {
  const file = process.env.HP_GAME_PACKAGE
    ? join(dirname(resolve(process.env.HP_GAME_PACKAGE)), 'seats.json')
    : join(root, 'maps', mapId, 'site', 'data', 'seats.json');
  try {
    const rows = JSON.parse(readFileSync(file, 'utf8')) as { id: number; name: string }[];
    return Object.fromEntries(rows.filter((r) => Number.isInteger(r.id) && typeof r.name === 'string').map((r) => [r.id, r.name]));
  } catch { return {}; }
}

export async function loadGamePackage(mapId: string, opts: { root?: string; noRegistry?: boolean } = {}): Promise<GameMapPackage | null> {
  const key = `${opts.root ?? ''}|${mapId}`;
  if (cache.has(key) && cache.get(key)) return cache.get(key) ?? null;
  let pkg: GameMapPackage | null = null;
  if (!process.env.HP_GAME_PACKAGE && !opts.noRegistry) pkg = await fromRegistry(mapId);
  if (!pkg) {
    for (const f of packageCandidates(mapId, opts.root)) {
      if (existsSync(f)) { pkg = readPkg(f); if (pkg) break; }
    }
  }
  cache.set(key, pkg);
  return pkg;
}
