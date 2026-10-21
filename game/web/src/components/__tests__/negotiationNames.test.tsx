import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { GameSnapshot, PlayerPublic } from '@hp/shared';
import { Chat } from '../Negotiation';
import { useStore } from '../../state/store';

const players: PlayerPublic[] = [
  { playerId: 'a', nickname: 'Asha', isAdmin: true, status: 'active', party: { name: 'Lotus Front', colour: '#E8710A', symbol: 'sun' } },
  { playerId: 'b', nickname: 'Ben', isAdmin: false, status: 'active', party: { name: 'Blue Anchor', colour: '#1F5FBF', symbol: 'globe' } },
  { playerId: 'c', nickname: 'Chitra', isAdmin: false, status: 'active', party: { name: 'Green Leaf', colour: '#1E8C45', symbol: 'leaf' } },
];

describe('private chat shows party names, never nicknames', () => {
  it('chips, placeholder, thread label and sender use the party name', () => {
    useStore.setState({ chat: [{ id: 'm1', from: 'b', to: ['a'], text: 'hello', ts: 1000 }] } as any);
    const { container } = render(<Chat snap={{ players } as GameSnapshot} me="a" />);
    expect(screen.getAllByRole('button', { name: 'Blue Anchor' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Green Leaf' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Blue Anchor' })[0]);
    expect(screen.getByPlaceholderText('Message Blue Anchor')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Asha|Ben\b|Chitra/);
  });
});
