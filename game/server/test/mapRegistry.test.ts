import { describe, expect, it } from 'vitest';
import { MAP_MANIFESTS, WORLD_CONFIG, configForMap } from '@hp/shared';
import { GameService } from '../src/core/gameService';
import { makeRegistryMapProvider } from '../src/core/maps';
import { GameError } from '../src/core/types';
import { GAME_PACKAGES } from '../src/maps.generated';
import { FakeClock, FakeNotifier, FakeScheduler } from './helpers';
import { MemoryRepo } from '../src/local/memoryRepo';

describe('generated map registry (maps/<id>/map.json)', () => {
  it('has a game package for every manifest, matching its seat count', () => {
    expect(MAP_MANIFESTS.length).toBeGreaterThan(0);
    for (const m of MAP_MANIFESTS) {
      const pkg = GAME_PACKAGES[m.id];
      expect(pkg, m.id).toBeDefined();
      expect(pkg.mapId).toBe(m.id);
      expect(pkg.seatCount).toBe(m.seatCount);
      expect(pkg.seats.length).toBe(m.seatCount);
    }
  });

  it('serves world-500 with the tuned WORLD_CONFIG and rejects unknown ids', () => {
    const maps = makeRegistryMapProvider();
    expect(maps('world-500')?.cfg).toBe(WORLD_CONFIG);
    expect(maps('nope')).toBeUndefined();
    expect(maps('toString')).toBeUndefined();
  });

  it('configForMap falls back to a WORLD_CONFIG copy for unknown maps', () => {
    const c = configForMap('india-543', 543);
    expect(c.mapId).toBe('india-543');
    expect(c.seatCount).toBe(543);
    expect(c.budget).toBe(WORLD_CONFIG.budget);
    expect(WORLD_CONFIG.seatCount).toBe(500);
  });

  it('createGame rejects an unknown mapId with BAD_REQUEST and accepts a registered one', async () => {
    const repo = new MemoryRepo();
    const svc = new GameService({
      repo, notifier: new FakeNotifier(repo), scheduler: new FakeScheduler(), clock: new FakeClock(), maps: makeRegistryMapProvider(),
    });
    const err = await svc.createGame({ nickname: 'Host', mapId: 'nope', phases: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(GameError);
    expect((err as GameError).code).toBe('BAD_REQUEST');
    const ok = await svc.createGame({ nickname: 'Host', mapId: 'world-500', phases: 2 });
    expect(ok.gameId).toBeTruthy();
  });
});
