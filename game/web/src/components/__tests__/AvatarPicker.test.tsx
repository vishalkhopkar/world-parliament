import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AVATARS } from '@hp/shared';
import { AvatarPicker } from '../AvatarPicker';

describe('AvatarPicker', () => {
  it('shows a lazy thumbnail with alt=label for every avatar', () => {
    render(<AvatarPicker value="" taken={[]} onChange={() => undefined} />);
    for (const a of AVATARS) {
      const img = screen.getByAltText(a.label);
      expect(img).toHaveAttribute('src', `/avatars/${a.thumb}`);
      expect(img).toHaveAttribute('loading', 'lazy');
    }
    expect(screen.getAllByRole('radio')).toHaveLength(AVATARS.length);
  });

  it('disables taken avatars and explains why', () => {
    render(<AvatarPicker value="" taken={['kim']} onChange={() => undefined} />);
    const kim = screen.getByRole('radio', { name: 'Kim' });
    expect(kim).toBeDisabled();
    expect(kim).toHaveAttribute('title', 'Kim (taken)');
    expect(screen.getByRole('radio', { name: 'Modi' })).toBeEnabled();
  });

  it('calls onChange when an avatar is chosen, also with the keyboard', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AvatarPicker value="" taken={[]} onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: 'Modi' }));
    expect(onChange).toHaveBeenLastCalledWith('modi');
    screen.getByRole('radio', { name: 'Xi' }).focus();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('xi');
  });

  it('does not select a taken avatar', async () => {
    const onChange = vi.fn();
    render(<AvatarPicker value="" taken={['kim']} onChange={onChange} />);
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Kim' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('previews the selected avatar with the full image, at most 256 css px', () => {
    render(<AvatarPicker value="putin" taken={[]} onChange={() => undefined} />);
    const prev = screen.getByAltText('Selected avatar: Putin');
    expect(prev).toHaveAttribute('src', '/avatars/full/putin.jpg');
    expect(Number(prev.getAttribute('width'))).toBeLessThanOrEqual(256);
    expect(screen.getByRole('radio', { name: 'Putin' })).toBeChecked();
  });

  it('shows a prompt instead of a preview when nothing is selected', () => {
    render(<AvatarPicker value="" taken={[]} onChange={() => undefined} />);
    expect(screen.queryByAltText(/Selected avatar/)).toBeNull();
    expect(screen.getByText(/pick an avatar/i)).toBeInTheDocument();
  });
});
