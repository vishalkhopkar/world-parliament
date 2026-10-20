import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MapManifest } from '@hp/shared';
import { MapChooser } from '../MapChooser';

const MAPS: MapManifest[] = [
  { id: 'world-500', name: 'World – 500 seats', description: 'The whole world.', seatCount: 500, thumbnail: 'thumbnail.jpg', site: 'site/index.html', gamePackage: 'site/data/game.json' },
  { id: 'india-543', name: 'India – 543 seats', description: 'Just India.', seatCount: 543, thumbnail: 'thumb.png', site: 'web/home.html', gamePackage: 'site/data/game.json' },
];

describe('MapChooser', () => {
  it('renders one card per manifest with thumbnail, name, seat count and description', () => {
    const { container } = render(<MapChooser maps={MAPS} value="world-500" onChange={() => undefined} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByText('World – 500 seats')).toBeInTheDocument();
    expect(screen.getByText('India – 543 seats')).toBeInTheDocument();
    expect(screen.getByText('The whole world.')).toBeInTheDocument();
    expect(container.querySelectorAll('.map-card-seats')[1]).toHaveTextContent('543 seats');
    const srcs = [...container.querySelectorAll('img')].map(i => i.getAttribute('src'));
    expect(srcs).toEqual(['/maps/world-500/thumbnail.jpg', '/maps/india-543/thumb.png']);
  });

  it('marks the given map as selected', () => {
    render(<MapChooser maps={MAPS} value="india-543" onChange={() => undefined} />);
    expect(screen.getByRole('radio', { name: /India/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /World/ })).not.toBeChecked();
  });

  it('reports the selection when a card is clicked', async () => {
    const onChange = vi.fn();
    render(<MapChooser maps={MAPS} value="world-500" onChange={onChange} />);
    await userEvent.setup().click(screen.getByText('India – 543 seats'));
    expect(onChange).toHaveBeenCalledWith('india-543');
  });

  it('can be driven with the keyboard (radio group)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<MapChooser maps={MAPS} value="world-500" onChange={onChange} />);
    screen.getByRole('radio', { name: /World/ }).focus();
    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenCalledWith('india-543');
  });

  it('"View map" opens the static study site in a new tab', () => {
    render(<MapChooser maps={MAPS} value="world-500" onChange={() => undefined} />);
    const cards = screen.getAllByTestId('map-card');
    expect(cards).toHaveLength(2);
    const w = within(cards[0]).getByRole('link', { name: /View map/ });
    expect(w).toHaveAttribute('href', '/maps/world-500/site/index.html');
    expect(w).toHaveAttribute('target', '_blank');
    expect(w).toHaveAttribute('rel', expect.stringContaining('noopener'));
    const i = within(cards[1]).getByRole('link', { name: /View map/ });
    expect(i).toHaveAttribute('href', '/maps/india-543/web/home.html');
  });

  it('clicking View map does not change the selection', async () => {
    const onChange = vi.fn();
    render(<MapChooser maps={MAPS} value="world-500" onChange={onChange} />);
    const links = screen.getAllByRole('link', { name: /View map/ });
    links[1].addEventListener('click', e => e.preventDefault()); // keep jsdom from "navigating"
    await userEvent.setup().click(links[1]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
