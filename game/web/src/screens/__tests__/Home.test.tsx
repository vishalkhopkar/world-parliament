import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@hp/shared', async importOriginal => {
  const orig = await importOriginal<typeof import('@hp/shared')>();
  return {
    ...orig,
    MAP_MANIFESTS: [
      { id: 'world-500', name: 'World – 500 seats', description: 'The whole world.', seatCount: 500, thumbnail: 'thumbnail.jpg', site: 'site/index.html', gamePackage: 'site/data/game.json' },
      { id: 'india-543', name: 'India – 543 seats', description: 'Just India.', seatCount: 543, thumbnail: 'thumb.png', site: 'web/home.html', gamePackage: 'site/data/game.json' },
    ],
  };
});
vi.mock('../../net/client', () => ({ createGame: vi.fn(async () => undefined), joinGame: vi.fn(async () => undefined), isRemote: true }));

import { createGame, joinGame } from '../../net/client';
import { Home } from '../Home';

beforeEach(() => vi.clearAllMocks());

describe('Home map chooser', () => {
  it('lists every map from MAP_MANIFESTS below the hero heading', () => {
    render(<Home />);
    expect(screen.getByRole('heading', { name: 'Win seats. Build a government.' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Choose a map' })).toBeInTheDocument();
    expect(screen.getAllByTestId('map-card')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /World/ })).toBeChecked(); // DEFAULT_MAP_ID
  });

  it('sends the default map when the player does not choose', async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.type(screen.getByPlaceholderText('e.g. Vishal'), 'Asha');
    await user.click(screen.getByRole('button', { name: 'Create game' }));
    expect(createGame).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createGame).mock.calls[0][0]).toBe('Asha');
    expect(vi.mocked(createGame).mock.calls[0][2]).toBe('world-500');
  });

  it('sends the selected map as mapId in createGame', async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.type(screen.getByPlaceholderText('e.g. Vishal'), 'Asha');
    await user.click(screen.getByRole('radio', { name: /India/ }));
    expect(screen.getByRole('radio', { name: /India/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Create game' }));
    expect(vi.mocked(createGame).mock.calls[0][2]).toBe('india-543');
  });

  it('every card has a View map link that opens the site in a new tab', () => {
    render(<Home />);
    const india = screen.getAllByTestId('map-card')[1];
    const link = within(india).getByRole('link', { name: /View map/ });
    expect(link).toHaveAttribute('href', '/maps/india-543/web/home.html');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('joining does not involve the map choice', async () => {
    const user = userEvent.setup();
    render(<Home />);
    await user.type(screen.getByPlaceholderText('e.g. Vishal'), 'Ben');
    await user.type(screen.getByPlaceholderText('HP7K2Q'), 'ABCD');
    await user.click(screen.getByRole('button', { name: 'Ask to join' }));
    expect(joinGame).toHaveBeenCalledWith('ABCD', 'Ben');
  });
});
