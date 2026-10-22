// Chat component: one common group chat by default (messaging.mode = group), private threads in 'individual' mode.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MAP_CONFIGS, WORLD_CONFIG } from '@hp/shared';
import type { GameSnapshot, PlayerPublic } from '@hp/shared';

vi.mock('../../net/client', () => ({ chat: vi.fn(), proposeGovernment: vi.fn(), respondOffer: vi.fn(), withdrawOffer: vi.fn() }));

import { chat } from '../../net/client';
import { Chat } from '../Negotiation';
import { useStore } from '../../state/store';

MAP_CONFIGS['fake-group'] = { ...WORLD_CONFIG, mapId: 'fake-group', messaging: { mode: 'group' } };
MAP_CONFIGS['fake-individual'] = { ...WORLD_CONFIG, mapId: 'fake-individual', messaging: { mode: 'individual' } };

const players: PlayerPublic[] = [
  { playerId: 'a', nickname: 'Asha', isAdmin: true, status: 'active', party: { name: 'Lotus Front', colour: '#E8710A', symbol: 'sun' } },
  { playerId: 'b', nickname: 'Ben', isAdmin: false, status: 'active', party: { name: 'Blue Anchor', colour: '#1F5FBF', symbol: 'globe' } },
  { playerId: 'c', nickname: 'Chitra', isAdmin: false, status: 'active', party: { name: 'Green Leaf', colour: '#1E8C45', symbol: 'leaf' } },
];
const snap = (mapId: string) => ({ gameId: 'g', mapId, status: 'counting', players } as unknown as GameSnapshot);
const inGame = (mapId: string, chatLog: object[] = []) => useStore.setState({ snapshot: snap(mapId), lobby: null, gamePkg: null, chat: chatLog } as never);

beforeEach(() => vi.mocked(chat).mockClear());

describe('group chat (default)', () => {
  it('the default map config is group chat', () => { expect(WORLD_CONFIG.messaging.mode).toBe('group'); });

  it('is titled "Group chat", has no recipient picker and no thread list', () => {
    inGame('fake-group', [{ id: 'm1', from: 'b', to: ['a', 'c'], text: 'hello', ts: 1000 }]);
    render(<Chat snap={snap('fake-group')} me="a" />);
    expect(screen.getByText('Group chat')).toBeInTheDocument();
    expect(screen.queryByText('Private chat')).toBeNull();
    expect(screen.queryByText(/Threads:/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Blue Anchor' })).toBeNull();
  });

  it('shows every message of the table, including those the viewer is not "to", with the party name as sender', () => {
    inGame('fake-group', [
      { id: 'm1', from: 'b', to: ['a', 'c'], text: 'hello all', ts: 1000 },
      { id: 'm2', from: 'c', to: ['a', 'b'], text: 'hi Ben', ts: 2000 },
      { id: 'm3', from: 'a', to: ['b', 'c'], text: 'my own', ts: 3000 },
    ]);
    const { container } = render(<Chat snap={snap('fake-group')} me="a" />);
    for (const t of ['hello all', 'hi Ben', 'my own']) expect(screen.getByText(t)).toBeInTheDocument();
    expect(container.querySelectorAll('.msg')).toHaveLength(3);
    expect(container.querySelectorAll('.msg.mine')).toHaveLength(1);
    expect(screen.getByText('Blue Anchor')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Asha|Ben\b|Chitra/);
  });

  it('the input is usable straight away; sending goes to everyone else and clears the box', () => {
    inGame('fake-group');
    render(<Chat snap={snap('fake-group')} me="a" />);
    const input = screen.getByPlaceholderText('Message everyone') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: '  let us talk  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(chat).toHaveBeenCalledWith(['b', 'c'], 'let us talk');
    expect(input.value).toBe('');
  });

  it('Send stays disabled for an empty message; Enter sends', () => {
    inGame('fake-group');
    render(<Chat snap={snap('fake-group')} me="a" />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    const input = screen.getByPlaceholderText('Message everyone');
    fireEvent.change(input, { target: { value: 'enter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(chat).toHaveBeenCalledWith(['b', 'c'], 'enter');
  });

  it('says so when nobody has written yet', () => {
    inGame('fake-group');
    render(<Chat snap={snap('fake-group')} me="a" />);
    expect(screen.getByText(/No messages yet/)).toBeInTheDocument();
  });
});

describe("individual threads ('individual' mode)", () => {
  it('keep the recipient chips, the Private chat title and the per-thread view', () => {
    inGame('fake-individual', [
      { id: 'm1', from: 'b', to: ['a'], text: 'psst', ts: 1000 },
      { id: 'm2', from: 'c', to: ['b'], text: 'not for a', ts: 2000 },
    ]);
    render(<Chat snap={snap('fake-individual')} me="a" />);
    expect(screen.getByText('Private chat')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Blue Anchor' })[0]);
    expect(screen.getByText('psst')).toBeInTheDocument();
    expect(screen.queryByText('not for a')).toBeNull();
    expect(screen.getByPlaceholderText('Message Blue Anchor')).toBeInTheDocument();
  });
});
