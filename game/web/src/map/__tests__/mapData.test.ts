import { describe, expect, it, vi } from 'vitest';

vi.mock('@hp/shared', async importOriginal => {
  const orig = await importOriginal<typeof import('@hp/shared')>();
  return {
    ...orig,
    MAP_MANIFESTS: [
      { id: 'world-500', name: 'World', description: 'd', seatCount: 500, thumbnail: 'thumbnail.jpg', site: 'site/index.html', gamePackage: 'site/data/game.json' },
      { id: 'india-543', name: 'India', description: 'd', seatCount: 543, thumbnail: 'thumb.png', site: 'web/home.html', gamePackage: 'pkg/data/game.json' },
    ],
  };
});

import { coarseTopoUrl, detailTopoUrl, gamePackageUrl, manifestFor, mapDataUrl, mapSiteUrl, mapThumbnailUrl, siteUrlOf, thumbnailUrlOf } from '../mapData';

describe('mapData URL helpers build URLs for any mapId', () => {
  it('site and thumbnail urls come from the manifest', () => {
    expect(mapSiteUrl('world-500')).toBe('/maps/world-500/site/index.html');
    expect(mapThumbnailUrl('world-500')).toBe('/maps/world-500/thumbnail.jpg');
    expect(mapSiteUrl('india-543')).toBe('/maps/india-543/web/home.html');
    expect(mapThumbnailUrl('india-543')).toBe('/maps/india-543/thumb.png');
  });
  it('data files live next to the game package of that map', () => {
    expect(mapDataUrl('world-500', 'seats.json')).toBe('/maps/world-500/site/data/seats.json');
    expect(mapDataUrl('india-543', 'seats.json')).toBe('/maps/india-543/pkg/data/seats.json');
    expect(coarseTopoUrl('india-543')).toBe('/maps/india-543/pkg/data/world.topo.json');
    expect(detailTopoUrl('world-500')).toBe('/maps/world-500/site/data/detail.topo.json');
    expect(gamePackageUrl('india-543')).toBe('/maps/india-543/pkg/data/game.json');
  });
  it('manifest-based helpers work for a manifest that is not registered', () => {
    const m = { id: 'x-1', name: 'X', description: '', seatCount: 1, thumbnail: 't.jpg', site: 'site/index.html', gamePackage: 'site/data/game.json' };
    expect(siteUrlOf(m)).toBe('/maps/x-1/site/index.html');
    expect(thumbnailUrlOf(m)).toBe('/maps/x-1/t.jpg');
  });
  it('unknown ids fall back to the conventional layout instead of throwing', () => {
    expect(manifestFor('nope')).toBeUndefined();
    expect(mapDataUrl('nope', 'seats.json')).toBe('/maps/nope/site/data/seats.json');
    expect(mapSiteUrl('nope')).toBe('/maps/nope/site/index.html');
  });
});
