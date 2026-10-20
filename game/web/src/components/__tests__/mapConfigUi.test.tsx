// The seat panel costs and the offer builder portfolios come from the current game's map config.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { GameSnapshot, PlayerPublic, PrivateState } from '@hp/shared';
import { WORLD_CONFIG } from '@hp/shared';
import { FAKE_MAP_ID, registerFakeMap } from '../../../test/fakeMap';

vi.mock('../../net/client', () => ({
  buyReport: vi.fn(), campaign: vi.fn(), chat: vi.fn(), proposeGovernment: vi.fn(), respondOffer: vi.fn(), withdrawOffer: vi.fn(),
}));

import { useStore } from '../../state/store';
import { SeatActionModal } from '../SeatActionModal';
import { AnalystShop, CampaignHud } from '../campaign';
import { Negotiation } from '../Negotiation';

registerFakeMap();

const pl = (id: string, n: string): PlayerPublic => ({ playerId: id, nickname: n, isAdmin: id === 'p1', status: 'active', party: { name: n + ' Party', colour: '#E8710A', symbol: 'sun' } });
const players = [pl('p1', 'Asha'), pl('p2', 'Ben'), pl('p3', 'Chitra')];
const snap = (mapId: string): GameSnapshot => ({
  gameId: 'g', mapId, status: 'campaign', phases: 2, timeline: null,
  players, news: [], polledPhases: [], seats: {}, tally: { leads: {}, wins: { p1: 10, p2: 10, p3: 10 }, declared: 0, total: 30 }, offers: [], government: null, result: null,
});
const priv: PrivateState = { you: 'p1', budget: 900_000_000, myActions: [], myReports: [] };

const costOf = (label: string) => screen.getByText(label).closest('.sam-opt-row')!.querySelector('.sam-cost')!.textContent;

function modal(mapId: string, budget = priv.budget) {
  const s = snap(mapId);
  useStore.setState({ me: 'p1', gameId: 'g', snapshot: s, names: {} });
  render(<SeatActionModal seat={1} snap={s} priv={{ ...priv, budget }} now={1} phaseOf={null} polled={new Set()} onClose={() => undefined} />);
}

beforeEach(() => useStore.setState({ snapshot: null, lobby: null, gamePkg: null, chat: [] }));

describe('seat panel costs follow the current map', () => {
  it('uses the fake map costs, report price and currency', () => {
    modal(FAKE_MAP_ID);
    expect(costOf('Rally')).toBe('F$ 5 crore');
    expect(costOf('Roadshow')).toBe('F$ 3 crore');
    expect(costOf('Local report')).toBe('F$ 7 crore');
  });
  it('uses the world costs for the world map', () => {
    modal(WORLD_CONFIG.mapId);
    expect(costOf('Rally')).toBe('W₹ 2 crore');
    expect(costOf('Roadshow')).toBe('W₹ 0.4 crore');
  });
  it("disables an action the budget cannot cover at that map's price", () => {
    modal(FAKE_MAP_ID, 40_000_000); // 4 crore: enough for the world rally (2) but not for the fake one (5)
    expect(screen.getByText('Rally').closest('button')).toBeDisabled();
  });
});

describe('campaign panels follow the current map', () => {
  it('HUD budget and analyst prices use the map currency and prices', () => {
    const s = snap(FAKE_MAP_ID);
    useStore.setState({ me: 'p1', gameId: 'g', snapshot: s });
    render(<><CampaignHud snap={s} priv={{ ...priv, budget: 900_000_000 }} now={1} /><AnalystShop snap={s} priv={priv} now={1} /></>);
    expect(screen.getByText('F$ 90 crore')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Global report \(F\$ 11 crore\)/ })).toBeInTheDocument();
    expect(screen.getByText(/45 s ago/)).toBeInTheDocument();
  });
});

describe('offer builder follows the current map', () => {
  it('lists the fake map portfolios (not the world ones) with their slots', () => {
    const s = snap(FAKE_MAP_ID);
    useStore.setState({ me: 'p1', gameId: 'g', snapshot: s });
    render(<Negotiation snap={s} />);
    const card = screen.getByRole('heading', { name: /Propose a government/ }).closest('section')!;
    expect(within(card).getByText(/Minister of Magic/)).toBeInTheDocument();
    expect(within(card).getByText(/Deputy Wizard/)).toBeInTheDocument();
    expect(within(card).getByText(/25 pts, up to 3/)).toBeInTheDocument();
    expect(within(card).queryByText(/Home/)).toBeNull();
    expect(within(card).queryByText(/Defence/)).toBeNull();
    expect(within(card).getAllByRole('combobox')).toHaveLength(1 + 3); // MAGIC x1 + DEPUTIES x3
  });
  it('lists the world portfolios for the world map', () => {
    const s = snap(WORLD_CONFIG.mapId);
    useStore.setState({ me: 'p1', gameId: 'g', snapshot: s });
    render(<Negotiation snap={s} />);
    const card = screen.getByRole('heading', { name: /Propose a government/ }).closest('section')!;
    expect(within(card).getByText(/Home/)).toBeInTheDocument();
    expect(within(card).queryByText(/Minister of Magic/)).toBeNull();
  });
});
