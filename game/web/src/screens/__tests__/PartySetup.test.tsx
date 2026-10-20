import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PlayerPublic } from '@hp/shared';

vi.mock('../../net/client', () => ({ setParty: vi.fn(async () => true) }));

import { setParty } from '../../net/client';
import { useStore } from '../../state/store';
import { PartySetup } from '../PartySetup';

const me: PlayerPublic = { playerId: 'p1', nickname: 'Asha', isAdmin: true, status: 'active' };
const other: PlayerPublic = {
  playerId: 'p2', nickname: 'Ravi', isAdmin: false, status: 'active', kind: 'agent',
  party: { name: 'Blue Front', colour: '#1F5FBF', symbol: 'anchor', avatar: 'kim' },
};

function setup(players: PlayerPublic[] = [me, other]) {
  useStore.setState({
    me: 'p1', gameId: 'g1',
    snapshot: { gameId: 'g1', mapId: 'world-500', status: 'lobby', phases: 2, timeline: null, players, news: [], polledPhases: [], seats: {}, tally: null, offers: [], government: null, result: null },
  });
  return userEvent.setup();
}

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText("e.g. People's Front"), 'Lotus Front');
  await user.click(screen.getByRole('button', { name: 'Saffron' }));
  await user.click(screen.getByRole('button', { name: 'Sun' }));
}

beforeEach(() => vi.clearAllMocks());

describe('PartySetup avatar picker', () => {
  it('shows the avatar thumbnails and disables the ones other players use', () => {
    setup();
    render(<PartySetup />);
    expect(screen.getByAltText('Modi')).toHaveAttribute('src', '/avatars/thumb/modi.jpg');
    expect(screen.getByRole('radio', { name: 'Kim' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Kim' })).toHaveAttribute('title', 'Kim (taken)');
    expect(screen.getByRole('radio', { name: 'Modi' })).toBeEnabled();
  });

  it('previews the chosen avatar with the full image', async () => {
    const user = setup();
    render(<PartySetup />);
    await user.click(screen.getByRole('radio', { name: 'Modi' }));
    expect(screen.getByAltText('Selected avatar: Modi')).toHaveAttribute('src', '/avatars/full/modi.jpg');
  });

  it('blocks saving without an avatar and says why', async () => {
    const user = setup();
    render(<PartySetup />);
    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: 'Save party' }));
    expect(setParty).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/avatar/i);
    await user.click(screen.getByRole('radio', { name: 'Modi' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends party.avatar on save', async () => {
    const user = setup();
    render(<PartySetup />);
    await fillBasics(user);
    await user.click(screen.getByRole('radio', { name: 'Modi' }));
    await user.click(screen.getByRole('button', { name: 'Save party' }));
    expect(setParty).toHaveBeenCalledWith({ name: 'Lotus Front', colour: '#E8710A', symbol: 'sun', avatar: 'modi' });
  });

  it('keeps my own current avatar selectable when editing', () => {
    setup([{ ...me, party: { name: 'Lotus', colour: '#E8710A', symbol: 'sun', avatar: 'xi' } }, other]);
    render(<PartySetup />);
    expect(screen.getByRole('radio', { name: 'Xi' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Xi' })).toBeEnabled();
  });
});
