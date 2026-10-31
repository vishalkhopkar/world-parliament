// Where avatars and the AI badge appear: campaign HUD (own), counting tally legend, negotiation panel, result table + banner.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { GameSnapshot, PlayerPublic, PrivateState } from '@hp/shared';

vi.mock('../../net/client', () => ({
  buyReport: vi.fn(), chat: vi.fn(), proposeGovernment: vi.fn(), respondOffer: vi.fn(), withdrawOffer: vi.fn(), leaveGame: vi.fn(), playAgain: vi.fn(), isTour: false,
}));
vi.mock('../../map/SeatMap', () => ({ SeatMap: () => <div data-testid="seatmap" /> }));

import { useStore } from '../../state/store';
import { CampaignHud } from '../../components/campaign';
import { Negotiation } from '../../components/Negotiation';
import { TallyBar } from '../Counting';
import { Result } from '../Result';

const ash: PlayerPublic = { playerId: 'p1', nickname: 'Asha', isAdmin: true, status: 'active', party: { name: 'Lotus Front', colour: '#E8710A', symbol: 'sun', avatar: 'modi' } };
const bot: PlayerPublic = { playerId: 'p2', nickname: 'R2', isAdmin: false, status: 'active', kind: 'agent', party: { name: 'Blue Front', colour: '#1F5FBF', symbol: 'anchor', avatar: 'kim' } };
const old: PlayerPublic = { playerId: 'p3', nickname: 'Old', isAdmin: false, status: 'active', party: { name: 'Old Guard', colour: '#1E8C45', symbol: 'leaf' } };
const players = [ash, bot, old];

const snap = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
  gameId: 'g', mapId: 'world-500', status: 'counting', phases: 2,
  timeline: { campaignStart: 0, phaseCloses: [1, 2], campaignEnd: 2, countingEnd: 3, postCountingEnd: 4 },
  players, news: [], polledPhases: [], seats: {}, tally: { leads: { p1: 10, p2: 5 }, wins: { p1: 100, p2: 50 }, declared: 150, total: 500 },
  offers: [], government: null, result: null, ...over,
});
const priv: PrivateState = { you: 'p1', budget: 1_000_000_00, myActions: [], myReports: [] };

beforeEach(() => useStore.setState({ me: 'p1', gameId: 'g', chat: [] }));

describe('avatars and AI badges across the UI', () => {
  it('campaign HUD shows my own avatar and party', () => {
    render(<CampaignHud snap={snap({ status: 'campaign' })} priv={priv} now={1} />);
    const me = screen.getByTitle('Lotus Front');
    expect(within(me).getByRole('img', { name: 'Modi' })).toHaveAttribute('src', '/avatars/thumb/modi.jpg'); // 44 px: thumbnail
  });

  it('counting tally legend shows avatars, falling back to the symbol for players without one', () => {
    const { container } = render(<TallyBar snap={snap()} />);
    expect(screen.getByAltText('Modi')).toBeInTheDocument();
    expect(screen.getByAltText('Kim')).toBeInTheDocument();
    expect(container.querySelectorAll('.tl-item .party-dot')).toHaveLength(1); // "Old Guard" has no avatar
  });

  it('negotiation panel: the chat list shows the other parties with avatars (symbol fallback) and "AI player" for agents only', () => {
    render(<Negotiation snap={snap()} />);
    const bot = screen.getByRole('tab', { name: /Blue Front/ });
    expect(within(bot).getByAltText('Kim')).toBeInTheDocument();
    expect(bot).toHaveTextContent('AI player · 55 seats');
    const old = screen.getByRole('tab', { name: /Old Guard/ });
    expect(old).not.toHaveTextContent('AI player');
    expect(old.querySelector('.party-dot')).not.toBeNull();
  });

  it('government banner shows the PM and parties with avatars', () => {
    const gov = { pm: 'p1', members: ['p1', 'p2'], portfolios: { PM: ['p1'] }, formedAt: 1, viaNegotiation: true };
    render(<Negotiation snap={snap({ government: gov })} />);
    const banner = screen.getByText('Government formed').closest('.banner')!;
    expect(within(banner as HTMLElement).getAllByAltText('Modi')).toHaveLength(2); // PM + member list
    expect(within(banner as HTMLElement).getByAltText('Kim')).toBeInTheDocument();
    expect(within(banner as HTMLElement).getByTitle('AI player')).toBeInTheDocument();
  });

  it('result table and winner banner show avatars and AI badges', () => {
    const result = {
      outcome: 'coalition' as const, tally: { p1: 200, p2: 150, p3: 150 }, winners: ['p2'],
      government: { pm: 'p1', members: ['p1', 'p2'], portfolios: { PM: ['p1'] }, formedAt: 1, viaNegotiation: true },
      points: [{ playerId: 'p1', portfolioPoints: 1, seatPoints: 2, governmentFloor: 3, total: 6 }, { playerId: 'p2', portfolioPoints: 1, seatPoints: 2, governmentFloor: 3, total: 7 }, { playerId: 'p3', portfolioPoints: 0, seatPoints: 0, governmentFloor: 0, total: 0 }],
    };
    useStore.setState({ snapshot: snap({ status: 'finished', result }), names: {} });
    const { container } = render(<Result />);
    const table = container.querySelector('table.points') as HTMLElement;
    expect(within(table).getByAltText('Modi')).toBeInTheDocument();
    expect(within(table).getByAltText('Kim')).toBeInTheDocument();
    expect(within(table).getAllByTitle('AI player')).toHaveLength(1);
    const banner = container.querySelector('.banner') as HTMLElement;
    expect(within(banner).getByAltText('Kim')).toBeInTheDocument(); // winner is the AI
    expect(within(banner).getByTitle('AI player')).toBeInTheDocument();
  });
});
