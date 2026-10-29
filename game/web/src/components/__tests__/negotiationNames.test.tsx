import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GameSnapshot, PlayerPublic } from '@hp/shared';

vi.mock('../../net/client', () => ({ chat: vi.fn(), proposeGovernment: vi.fn(), respondOffer: vi.fn(), withdrawOffer: vi.fn() }));

import { ChatSection } from '../ChatSection';
import { useStore } from '../../state/store';

const players: PlayerPublic[] = [
  { playerId: 'a', nickname: 'Asha', isAdmin: true, status: 'active', party: { name: 'Lotus Front', colour: '#E8710A', symbol: 'sun' } },
  { playerId: 'b', nickname: 'Ben', isAdmin: false, status: 'active', party: { name: 'Blue Anchor', colour: '#1F5FBF', symbol: 'globe' } },
  { playerId: 'c', nickname: 'Chitra', isAdmin: false, status: 'active', party: { name: 'Green Leaf', colour: '#1E8C45', symbol: 'leaf' } },
];

describe('one-to-one chats show party names, never nicknames', () => {
  it('conversation list, placeholder, header and sender use the party name', () => {
    useStore.setState({ chat: [{ id: 'm1', from: 'b', to: ['a'], text: 'hello', ts: 1000, channel: 'direct' }], chatRead: {} } as never);
    const snap = { players, offers: [], tally: null } as unknown as GameSnapshot;
    const { container } = render(<ChatSection snap={snap} me="a" mode="INDV" />);
    expect(screen.getByRole('tab', { name: /Blue Anchor/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Green Leaf/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Blue Anchor/ }));
    expect(screen.getByPlaceholderText('Message Blue Anchor')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Asha|Ben\b|Chitra/);
  });
});
