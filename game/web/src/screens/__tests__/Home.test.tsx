import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  describe('invite link (?join=CODE)', () => {
    afterEach(() => window.history.replaceState({}, '', '/'));

    it('prefills the join code and shows an invite banner', () => {
      window.history.replaceState({}, '', '/?join=ab3k7q');
      render(<Home />);
      expect(screen.getByPlaceholderText('HP7K2Q')).toHaveValue('AB3K7Q');
      expect(screen.getByTestId('invite-banner')).toHaveTextContent('AB3K7Q');
    });

    it('needs only a nickname and one tap, then clears ?join from the address bar', async () => {
      window.history.replaceState({}, '', '/?server=local&join=AB3K7Q');
      const user = userEvent.setup();
      render(<Home />);
      await user.type(screen.getByPlaceholderText('e.g. Vishal'), 'Ben');
      await user.click(screen.getByRole('button', { name: 'Ask to join' }));
      expect(joinGame).toHaveBeenCalledWith('AB3K7Q', 'Ben');
      expect(window.location.search).toBe('?server=local');
    });

    it('has no banner and an empty code without a link', () => {
      render(<Home />);
      expect(screen.queryByTestId('invite-banner')).toBeNull();
      expect(screen.getByPlaceholderText('HP7K2Q')).toHaveValue('');
    });
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

describe('Home guided tour entry', () => {
  afterEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); });

  it('offers a "Take a tour" button that opens ?tour in a NEW tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    render(<Home />);
    expect(screen.getByTestId('tour-card')).toHaveTextContent(/New here/i);
    await user.click(screen.getByRole('button', { name: 'Take a tour' }));
    expect(open).toHaveBeenCalledTimes(1);
    const [url, target] = open.mock.calls[0];
    expect(String(url)).toMatch(/\?tour$/);
    expect(target).toBe('_blank');
  });

  it('keeps server / mock / join params out of the tour link (the tour is offline)', async () => {
    window.history.replaceState({}, '', '/play/?server=local&mock&join=AB3K7Q&as=2');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    render(<Home />);
    await user.click(screen.getByRole('button', { name: 'Take a tour' }));
    const url = new URL(String(open.mock.calls[0][0]));
    expect(url.pathname).toBe('/play/');
    expect(url.search).toBe('?tour');
  });

  it('works without any nickname and does not touch the game forms', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    render(<Home />);
    expect(screen.getByRole('button', { name: 'Take a tour' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Take a tour' }));
    expect(createGame).not.toHaveBeenCalled();
    expect(joinGame).not.toHaveBeenCalled();
  });
});
