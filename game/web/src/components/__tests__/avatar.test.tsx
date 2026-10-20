import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AiBadge, PartyAvatar, PartyBadge, PartyDot, avatarVariantFor } from '../ui';
import { avatarUrl } from '../../avatars';

const party = { name: 'Lotus', colour: '#E8710A', symbol: 'sun', avatar: 'modi' };

describe('avatar urls', () => {
  it('maps an avatar id to /avatars/ thumb and full urls', () => {
    expect(avatarUrl('modi', 'thumb')).toBe('/avatars/thumb/modi.jpg');
    expect(avatarUrl('modi', 'full')).toBe('/avatars/full/modi.jpg');
    expect(avatarUrl('nobody', 'thumb')).toBeUndefined();
  });
  it('uses the thumbnail up to 64 css px and the full image above', () => {
    expect(avatarVariantFor(18)).toBe('thumb');
    expect(avatarVariantFor(64)).toBe('thumb');
    expect(avatarVariantFor(65)).toBe('full');
    expect(avatarVariantFor(120)).toBe('full');
  });
});

describe('PartyAvatar', () => {
  it('renders the thumbnail for small sizes', () => {
    render(<PartyAvatar party={party} size={40} />);
    const img = screen.getByRole('img', { name: 'Modi' });
    expect(img).toHaveAttribute('src', '/avatars/thumb/modi.jpg');
    expect(img).toHaveAttribute('loading', 'lazy');
  });
  it('renders the full image for large sizes', () => {
    render(<PartyAvatar party={party} size={96} />);
    expect(screen.getByRole('img', { name: 'Modi' })).toHaveAttribute('src', '/avatars/full/modi.jpg');
  });
  it('falls back to the party symbol when there is no avatar (old games)', () => {
    const { container } = render(<PartyAvatar party={{ ...party, avatar: undefined }} size={40} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('.party-dot svg')).not.toBeNull();
  });
  it('falls back to the symbol for an unknown avatar id', () => {
    const { container } = render(<PartyAvatar party={{ ...party, avatar: 'ghost' }} size={40} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('.party-dot')).not.toBeNull();
  });
  it('PartyDot shows the avatar too, so every party list gets it', () => {
    render(<PartyDot party={party} size={18} />);
    expect(screen.getByRole('img', { name: 'Modi' })).toHaveAttribute('src', '/avatars/thumb/modi.jpg');
  });
});

describe('AI badge', () => {
  it('is shown for agents with an AI label and tooltip', () => {
    render(<PartyBadge party={party} nickname="Bot" kind="agent" />);
    expect(screen.getByTitle('AI player')).toHaveTextContent('AI');
  });
  it('is not shown for humans or when kind is missing', () => {
    const { rerender } = render(<PartyBadge party={party} nickname="Hu" kind="human" />);
    expect(screen.queryByTitle('AI player')).toBeNull();
    rerender(<PartyBadge party={party} nickname="Hu" />);
    expect(screen.queryByTitle('AI player')).toBeNull();
  });
  it('can be used on its own', () => {
    render(<AiBadge />);
    expect(screen.getByTitle('AI player')).toBeInTheDocument();
  });
});
