// The rally button is disabled while the player's rally cooldown runs, with a live "Next rally in Ns" label; roadshows are never limited.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { GameSnapshot, PrivateState } from '@hp/shared';
import { WORLD_CONFIG } from '@hp/shared';

vi.mock('../../net/client', () => ({ buyReport: vi.fn(), campaign: vi.fn() }));

import { useStore } from '../../state/store';
import { nextRallyAtOf, SeatActionModal } from '../SeatActionModal';

const CD = WORLD_CONFIG.cooldowns.rallyMs;
const snap: GameSnapshot = {
  gameId: 'g', mapId: WORLD_CONFIG.mapId, status: 'campaign', phases: 2, timeline: null,
  players: [], news: [], polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null,
};
const base: PrivateState = { you: 'p1', budget: 50_000, myActions: [], myReports: [] };

function modal(priv: PrivateState, now: number) {
  useStore.setState({ me: 'p1', gameId: 'g', snapshot: snap, names: {} });
  return render(<SeatActionModal seat={1} snap={snap} priv={priv} now={now} phaseOf={null} polled={new Set()} onClose={() => undefined} />);
}
const rally = () => document.querySelector<HTMLButtonElement>('.sam-rally')!;
const roadshow = () => document.querySelector<HTMLButtonElement>('.sam-roadshow')!;

beforeEach(() => { cleanup(); useStore.setState({ snapshot: null, lobby: null, gamePkg: null, chat: [] }); });

describe('rally cooldown in the seat panel', () => {
  it('is enabled when the player never rallied', () => {
    modal(base, 1_000_000);
    expect(rally()).toBeEnabled();
    expect(screen.queryByText(/Next rally in/)).toBeNull();
  });

  it('is disabled with a countdown after a recent rally (computed from myActions), roadshow stays enabled', () => {
    const t0 = 1_000_000;
    modal({ ...base, myActions: [{ type: 'rally', seat: 7, ts: t0 }] }, t0 + 10_000);
    expect(rally()).toBeDisabled();
    expect(screen.getByText(`Next rally in ${Math.ceil((CD - 10_000) / 1000)}s`)).toBeInTheDocument();
    expect(roadshow()).toBeEnabled();
  });

  it("uses the server's nextRallyAt when present and re-enables the button once the time has passed", () => {
    const t0 = 2_000_000;
    const { unmount } = modal({ ...base, nextRallyAt: t0 + 5_000 }, t0);
    expect(rally()).toBeDisabled();
    expect(screen.getByText('Next rally in 5s')).toBeInTheDocument();
    unmount();
    modal({ ...base, nextRallyAt: t0 + 5_000 }, t0 + 5_001);
    expect(rally()).toBeEnabled();
  });

  it('closing and reopening keeps the countdown (it is derived from the private state, not the modal)', () => {
    const priv = { ...base, myActions: [{ type: 'rally' as const, seat: 7, ts: 3_000_000 }] };
    const first = modal(priv, 3_000_000 + 1_000);
    first.unmount();
    modal(priv, 3_000_000 + 2_000);
    expect(screen.getByText(`Next rally in ${CD / 1000 - 2}s`)).toBeInTheDocument();
  });

  it('nextRallyAtOf takes the later of the server value and last rally + cooldown', () => {
    expect(nextRallyAtOf({ ...base, myActions: [{ type: 'rally', seat: 1, ts: 100 }, { type: 'roadshow', seat: 2, ts: 900 }] }, CD)).toBe(100 + CD);
    expect(nextRallyAtOf({ ...base, nextRallyAt: 100 + CD + 50, myActions: [{ type: 'rally', seat: 1, ts: 100 }] }, CD)).toBe(100 + CD + 50);
    expect(nextRallyAtOf(base, CD)).toBe(-Infinity);
  });
});
