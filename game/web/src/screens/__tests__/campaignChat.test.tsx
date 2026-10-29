// Campaign screen: the chat card follows Chat.Campaigning (GROUP / INDV / OFF) with 3+ players; counting is always one-to-one. HUD label rules.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MAP_CONFIGS, WORLD_CONFIG } from '@hp/shared';
import type { GameSnapshot, PlayerPublic } from '@hp/shared';

vi.mock('../../net/client', () => ({ chat: vi.fn(), leaveGame: vi.fn(), peekSeat: vi.fn(), proposeGovernment: vi.fn(), respondOffer: vi.fn(), withdrawOffer: vi.fn(), campaign: vi.fn(), buyReport: vi.fn() }));
vi.mock('../../map/SeatMap', () => ({ SeatMap: () => <div data-testid="seatmap" /> }));
vi.mock('../../components/ResultPanels', () => ({ ResultPanels: () => <div /> }));

import { useStore } from '../../state/store';
import { Campaign } from '../Campaign';
import { Counting } from '../Counting';

MAP_CONFIGS['chat-campaign'] = { ...WORLD_CONFIG, mapId: 'chat-campaign', chat: { campaigning: 'GROUP' } };
MAP_CONFIGS['chat-counting'] = { ...WORLD_CONFIG, mapId: 'chat-counting', chat: { campaigning: 'OFF' } };
MAP_CONFIGS['chat-indv'] = { ...WORLD_CONFIG, mapId: 'chat-indv', chat: { campaigning: 'INDV' } };

const pl = (id: string, n: string, status: PlayerPublic['status'] = 'active'): PlayerPublic => ({ playerId: id, nickname: n, isAdmin: id === 'a', status, party: { name: n + ' Party', colour: '#E8710A', symbol: 'sun' } });
const t = () => ({ campaignStart: 0, phaseCloses: [Date.now() + 1e5], campaignEnd: Date.now() + 1e5, countingEnd: Date.now() + 2e5, postCountingEnd: Date.now() + 3e5 });
const snap = (mapId: string, players: PlayerPublic[], over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId, status: 'campaign', phases: 1, timeline: t(), players, news: [], polledPhases: [], seats: {},
  tally: null, offers: [], government: null, result: null, ...over,
});
const priv = { you: 'a', budget: 100, myActions: [], myReports: [] };
const three = [pl('a', 'Asha'), pl('b', 'Ben'), pl('c', 'Chitra')];
const setup = (s: GameSnapshot) => useStore.setState({ me: 'a', gameId: 'g', snapshot: s, priv, lobby: null, gamePkg: null, names: {}, chat: [], selectedSeat: null } as never);

beforeEach(() => setup(snap('chat-campaign', three)));

describe('Campaign screen chat', () => {
  it('shows the group chat card (Chat.Campaigning = GROUP) with 3 players', () => {
    render(<Campaign />);
    expect(screen.getByText('Group chat')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
  it('shows one-to-one chats during the campaign with Chat.Campaigning = INDV', () => {
    setup(snap('chat-indv', three));
    render(<Campaign />);
    expect(screen.getByText('Chats')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });
  it('shows no chat when Chat.Campaigning = OFF', () => {
    setup(snap('chat-counting', three));
    render(<Campaign />);
    expect(screen.queryByText('Group chat')).toBeNull();
  });
  it('shows no chat with only 2 players (pending/rejected do not count)', () => {
    setup(snap('chat-campaign', [pl('a', 'Asha'), pl('b', 'Ben'), pl('c', 'Chitra', 'pending'), pl('d', 'Dev', 'rejected')]));
    render(<Campaign />);
    expect(screen.queryByText('Group chat')).toBeNull();
  });
});

describe('Counting screen keeps the chat; HUD label', () => {
  const gov = { pm: 'a', members: ['a', 'b'], portfolios: { PM: ['a'] }, formedAt: 1, viaNegotiation: true };
  it('counting has one-to-one chats whatever the campaign had', () => {
    for (const map of ['chat-campaign', 'chat-counting', 'chat-indv']) {
      setup(snap(map, three, { status: 'counting' }));
      const { unmount } = render(<Counting />);
      expect(screen.getByText('Chats')).toBeInTheDocument();
      expect(screen.queryByText('Group chat')).toBeNull();
      unmount();
    }
  });
  it('"Counting ends in" while counting even with an accepted/formed government', () => {
    setup(snap('chat-campaign', three, { status: 'counting', government: gov }));
    render(<Counting />);
    expect(screen.getByText('Counting ends in')).toBeInTheDocument();
    expect(screen.queryByText('Final result in')).toBeNull();
  });
  it('"Final result in" only when postCounting with a government; otherwise "Government must form within"', () => {
    setup(snap('chat-campaign', three, { status: 'postCounting', government: gov }));
    const { unmount } = render(<Counting />);
    expect(screen.getByText('Final result in')).toBeInTheDocument();
    unmount();
    setup(snap('chat-campaign', three, { status: 'postCounting' }));
    render(<Counting />);
    expect(screen.getByText('Government must form within')).toBeInTheDocument();
  });
});
