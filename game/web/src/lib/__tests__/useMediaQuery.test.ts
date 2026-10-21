import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMediaQuery } from '../useMediaQuery';

afterEach(() => { vi.unstubAllGlobals(); });

function mockMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const mql = { matches: initial, addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) };
  vi.stubGlobal('matchMedia', vi.fn(() => mql));
  return { set: (v: boolean) => { mql.matches = v; listeners.forEach(f => f()); }, listeners };
}

describe('useMediaQuery', () => {
  it('reflects the query and follows changes', () => {
    const m = mockMatchMedia(false);
    const { result, unmount } = renderHook(() => useMediaQuery('(min-width: 1200px)'));
    expect(result.current).toBe(false);
    act(() => m.set(true));
    expect(result.current).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith('(min-width: 1200px)');
    unmount();
    expect(m.listeners.size).toBe(0);
  });

  it('is false where matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(renderHook(() => useMediaQuery('(min-width: 1200px)')).result.current).toBe(false);
  });
});
