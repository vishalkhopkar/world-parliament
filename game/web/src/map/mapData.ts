import { MAP_MANIFESTS } from '@hp/shared';
import type { GameMapPackage, MapManifest, SeatId } from '@hp/shared';
import type { Topology } from 'topojson-specification';

// Map files live in the repo's maps/<id>/ folders. vite.config.ts serves them at /maps/<id>/... in dev and copies
// them to dist/maps/<id>/ on build. Every helper takes the mapId of the game (or chooser card) it is for;
// there is no global "current map".

export function manifestFor(mapId: string): MapManifest | undefined {
  return MAP_MANIFESTS.find(m => m.id === mapId);
}

/** `/maps/<id>/<relative path inside the map folder>` */
export const mapFileUrl = (mapId: string, rel: string): string => `/maps/${mapId}/${rel.replace(/^\/+/, '')}`;

/** Static study site of a map, e.g. /maps/world-500/site/index.html */
export const siteUrlOf = (m: MapManifest): string => mapFileUrl(m.id, m.site);
export const thumbnailUrlOf = (m: MapManifest): string => mapFileUrl(m.id, m.thumbnail);
export const mapSiteUrl = (mapId: string): string => mapFileUrl(mapId, manifestFor(mapId)?.site ?? 'site/index.html');
export const mapThumbnailUrl = (mapId: string): string => mapFileUrl(mapId, manifestFor(mapId)?.thumbnail ?? 'thumbnail.jpg');

/** `/maps/<id>/<gamePackage dir>/<file>`, e.g. mapDataUrl('world-500', 'seats.json') -> /maps/world-500/site/data/seats.json */
export function mapDataUrl(mapId: string, file: string): string {
  const pkgPath = manifestFor(mapId)?.gamePackage ?? 'site/data/game.json';
  const dir = pkgPath.includes('/') ? pkgPath.slice(0, pkgPath.lastIndexOf('/')) : '';
  return mapFileUrl(mapId, dir ? `${dir}/${file}` : file);
}

export const gamePackageUrl = (mapId: string): string => mapFileUrl(mapId, manifestFor(mapId)?.gamePackage ?? 'site/data/game.json');
export const coarseTopoUrl = (mapId: string): string => mapDataUrl(mapId, 'world.topo.json');
export const detailTopoUrl = (mapId: string): string => mapDataUrl(mapId, 'detail.topo.json');

/** seat names from maps/<id>/site/data/seats.json (authoritative; renamed by hand by the owner). */
export async function loadSeatNames(mapId: string): Promise<Record<SeatId, string>> {
  try {
    const r = await fetch(mapDataUrl(mapId, 'seats.json'));
    if (!r.ok) return {};
    const list = (await r.json()) as { id: number; name: string }[];
    return Object.fromEntries(list.map(s => [s.id, s.name]));
  } catch { return {}; }
}

/** Map package (centroids, neighbours, phase groups). May not exist yet -> null. */
export async function loadGamePackage(mapId: string): Promise<GameMapPackage | null> {
  try {
    const r = await fetch(gamePackageUrl(mapId));
    if (!r.ok) return null;
    const pkg = (await r.json()) as GameMapPackage;
    return pkg && Array.isArray(pkg.seats) ? pkg : null;
  } catch { return null; }
}

export async function loadTopo(url: string): Promise<Topology> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as Topology;
}
