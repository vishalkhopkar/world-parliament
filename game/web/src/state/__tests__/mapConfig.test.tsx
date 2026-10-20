import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { DEFAULT_MAP_ID, WORLD_CONFIG } from '@hp/shared';
import type { GameMapPackage } from '@hp/shared';
import { FAKE_CONFIG, FAKE_MAP_ID, registerFakeMap } from '../../../test/fakeMap';
import { useStore } from '../store';
import { useMapConfig } from '../mapConfig';

registerFakeMap();

const inGame = (mapId: string) => useStore.setState({
  snapshot: { gameId: 'g', mapId, status: 'lobby', phases: 2, timeline: null, players: [], news: [], polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null },
});
const pkg = (mapId: string, seatCount: number) => ({ mapId, seatCount, version: 1, seats: [], phaseGroups: {}, topo: { coarse: '' } }) as GameMapPackage;

beforeEach(() => useStore.setState({ snapshot: null, lobby: null, gamePkg: null }));

describe('useMapConfig', () => {
  it("is the config of the current game's map", () => {
    inGame(FAKE_MAP_ID);
    const { result } = renderHook(() => useMapConfig());
    expect(result.current.mapId).toBe(FAKE_MAP_ID);
    expect(result.current.costs).toEqual(FAKE_CONFIG.costs);
    expect(result.current.currency.symbol).toBe('F$');
  });

  it('falls back to the default map outside a game', () => {
    const { result } = renderHook(() => useMapConfig());
    expect(result.current.mapId).toBe(DEFAULT_MAP_ID);
    expect(result.current.costs).toEqual(WORLD_CONFIG.costs);
  });

  it('follows the lobby map before the snapshot arrives', () => {
    useStore.setState({ lobby: { gameId: 'g', joinCode: 'X', mapId: FAKE_MAP_ID, phases: 2, status: 'lobby', admissionOpen: true, you: 'p', players: [] } });
    expect(renderHook(() => useMapConfig()).result.current.mapId).toBe(FAKE_MAP_ID);
  });

  it('takes the seat count from the loaded map package of that map', () => {
    inGame('unregistered-map');
    useStore.setState({ gamePkg: pkg('unregistered-map', 77) });
    const { result } = renderHook(() => useMapConfig());
    expect(result.current.mapId).toBe('unregistered-map');
    expect(result.current.seatCount).toBe(77);
  });

  it('ignores a package that belongs to another map', () => {
    inGame('unregistered-map');
    useStore.setState({ gamePkg: pkg(DEFAULT_MAP_ID, 500) });
    expect(renderHook(() => useMapConfig()).result.current.seatCount).not.toBe(77);
  });
});
