import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { LobbyView, PlayerPublic } from '@hp/shared';

vi.mock('../../net/client', () => ({
  admit: vi.fn(), refreshLobby: vi.fn(async () => undefined), setAdmission: vi.fn(), setPhases: vi.fn(), start: vi.fn(),
}));

import { useStore } from '../../state/store';
import { Lobby } from '../Lobby';

const human: PlayerPublic = { playerId: 'p1', nickname: 'Asha', isAdmin: true, status: 'active', party: { name: 'Lotus Front', colour: '#E8710A', symbol: 'sun', avatar: 'modi' } };
const agent: PlayerPublic = { playerId: 'p2', nickname: 'R2', isAdmin: false, status: 'active', kind: 'agent', party: { name: 'Blue Front', colour: '#1F5FBF', symbol: 'anchor', avatar: 'kim' } };
const asking: PlayerPublic = { playerId: 'p3', nickname: 'C3PO', isAdmin: false, status: 'pending', kind: 'agent' };
const asking2: PlayerPublic = { playerId: 'p4', nickname: 'Human Hopeful', isAdmin: false, status: 'pending' };

function setup(mapId: string, me = 'p1') {
  const players = [human, agent, asking, asking2];
  const lobby: LobbyView = { gameId: 'g1', joinCode: 'HP1234', mapId, phases: 2, status: 'lobby', admissionOpen: true, you: me, players };
  useStore.setState({
    me, gameId: 'g1', joinCode: 'HP1234', lobby,
    snapshot: { gameId: 'g1', mapId, status: 'lobby', phases: 2, timeline: null, players, news: [], polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null },
  });
}

beforeEach(() => vi.clearAllMocks());

describe('Lobby', () => {
  it('shows a robot badge for AI players in the player list but not for humans', () => {
    setup('world-500');
    render(<Lobby />);
    const list = screen.getByRole('heading', { name: /Players \(/ }).closest('section')!;
    const rows = list.querySelectorAll('.row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).queryByTitle('AI player')).toBeNull();
    expect(within(rows[1] as HTMLElement).getByTitle('AI player')).toHaveTextContent('AI');
  });

  it('flags an AI asking to join in the admin admit list', () => {
    setup('world-500');
    render(<Lobby />);
    const reqs = screen.getByRole('heading', { name: /Join requests/ }).closest('section')!;
    const rows = reqs.querySelectorAll('.row');
    expect(within(rows[0] as HTMLElement).getByTitle('AI player')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByTitle('AI player')).toBeNull();
  });

  it("shows players' avatars", () => {
    setup('world-500');
    render(<Lobby />);
    expect(screen.getByAltText('Modi')).toHaveAttribute('src', '/avatars/thumb/modi.jpg');
    expect(screen.getByAltText('Kim')).toBeInTheDocument();
  });

  it("shows the game's map name", () => {
    setup('world-500');
    render(<Lobby />);
    expect(screen.getByText('World – 500 seats')).toBeInTheDocument();
  });

  describe('sharing the game', () => {
    const clip = (writeText: (t: string) => Promise<void>) => Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const setShare = (v: unknown) => Object.defineProperty(navigator, 'share', { value: v, configurable: true });
    afterEach(() => { setShare(undefined); Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); });

    it('Copy code copies the code and says so', async () => {
      const writeText = vi.fn(async (_t: string) => undefined);
      clip(writeText);
      setup('world-500');
      render(<Lobby />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
      expect(writeText).toHaveBeenCalledWith('HP1234');
      expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
    });

    it('copies the code shown even when the stored joinCode is missing (lobby has it)', async () => {
      const writeText = vi.fn(async (_t: string) => undefined);
      clip(writeText);
      setup('world-500');
      useStore.setState({ joinCode: null });
      render(<Lobby />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
      expect(writeText).toHaveBeenCalledWith('HP1234');
    });

    it('Copy invite link copies a join link for this game', async () => {
      const writeText = vi.fn(async (_t: string) => undefined);
      clip(writeText);
      setup('world-500');
      render(<Lobby />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy invite link' }));
      const link = writeText.mock.calls[0][0] as string;
      expect(new URL(link).searchParams.get('join')).toBe('HP1234');
      expect(await screen.findByRole('button', { name: 'Link copied!' })).toBeInTheDocument();
    });

    it('tells the player when copying is impossible', async () => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      document.execCommand = vi.fn(() => false);
      setup('world-500');
      render(<Lobby />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
      expect(await screen.findByRole('button', { name: /Copy failed/ })).toBeInTheDocument();
    });

    it('offers the share sheet only where the browser has one', async () => {
      setup('world-500');
      const { unmount } = render(<Lobby />);
      expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
      unmount();
      const share = vi.fn(async () => undefined);
      setShare(share);
      render(<Lobby />);
      fireEvent.click(screen.getByRole('button', { name: 'Share' }));
      expect(share).toHaveBeenCalledTimes(1);
      expect(new URL((share.mock.calls[0] as unknown as [{ url: string }])[0].url).searchParams.get('join')).toBe('HP1234');
    });
  });

  it('start needs an avatar for every player', () => {
    setup('world-500');
    useStore.setState(s => ({ snapshot: { ...s.snapshot!, players: [{ ...human, party: { ...human.party!, avatar: undefined } }, agent] } }));
    render(<Lobby />);
    expect(screen.getByRole('button', { name: 'Start the campaign' })).toBeDisabled();
  });
});
