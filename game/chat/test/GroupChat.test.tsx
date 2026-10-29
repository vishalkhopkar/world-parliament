import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@hp/shared';
import { GroupChat, mentionCandidates } from '../index';
import type { ChatPerson } from '../index';

const people: ChatPerson[] = [
  { id: 'a', name: 'Lotus Front', colour: '#E8710A' },
  { id: 'b', name: 'Blue Anchor', colour: '#1F5FBF' },
  { id: 'c', name: 'Green Leaf', colour: '#1E8C45' },
];
const optionNames = () => screen.getAllByRole('option').map(o => o.lastChild?.textContent);
const gm = (id: string, from: string, text: string, ts: number, mentions?: string[]): ChatMessage => ({ id, from, to: [], text, ts, channel: 'group', ...(mentions ? { mentions } : {}) });

describe('GroupChat (one common chat, Teams-style rows)', () => {
  it('shows every group message with the party name on top and the text below; own rows say You', () => {
    const { container } = render(<GroupChat me="a" people={people} onSend={vi.fn()}
      messages={[gm('m1', 'b', 'hello all', 1000), gm('m2', 'a', 'my own', 2000), { id: 'd', from: 'b', to: ['a'], text: 'private', ts: 3000, channel: 'direct' }]} />);
    expect(screen.getByText('hello all')).toBeInTheDocument();
    expect(screen.getByText('my own')).toBeInTheDocument();
    expect(screen.queryByText('private')).toBeNull(); // one-to-one messages never show in the group chat
    expect(screen.getByText('Blue Anchor')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(container.querySelectorAll('.hpchat-row')).toHaveLength(2);
    expect(container.querySelectorAll('.hpchat-row.mine')).toHaveLength(1);
    // the other party's row has an avatar on the left, ours does not
    expect(container.querySelectorAll('.hpchat-row:not(.mine) .hpchat-avatar')).toHaveLength(1);
  });

  it('a follow-up from the same sender within 2 minutes is drawn compact (no second header)', () => {
    const { container } = render(<GroupChat me="a" people={people} onSend={vi.fn()} messages={[gm('m1', 'b', 'one', 1000), gm('m2', 'b', 'two', 5000), gm('m3', 'b', 'three', 500_000)]} />);
    expect(container.querySelectorAll('.hpchat-row.compact')).toHaveLength(1);
  });

  it('highlights tags; the viewer\'s own tag stands out', () => {
    const { container } = render(<GroupChat me="a" people={people} onSend={vi.fn()} messages={[gm('m1', 'b', 'hi @Lotus Front and @Green Leaf', 1000, ['a', 'c'])]} />);
    const tags = [...container.querySelectorAll('.hpchat-tag')].map(t => [t.textContent, t.classList.contains('me')]);
    expect(tags).toEqual([['@Lotus Front', true], ['@Green Leaf', false]]);
  });

  it('sends trimmed text, clears the box; Send is disabled while empty', () => {
    const onSend = vi.fn();
    render(<GroupChat me="a" people={people} messages={[]} onSend={onSend} />);
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    const input = screen.getByPlaceholderText(/Message everyone/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  let us talk  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('let us talk');
    expect(input.value).toBe('');
    expect(screen.getByText(/No messages yet/)).toBeInTheDocument();
  });

  it('typing @ opens the party picker (never yourself); picking inserts "@Name " and Enter then sends', () => {
    const onSend = vi.fn();
    render(<GroupChat me="a" people={people} messages={[]} onSend={onSend} />);
    const input = screen.getByPlaceholderText(/Message everyone/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hey @', selectionStart: 5 } });
    expect(optionNames()).toEqual(['Blue Anchor', 'Green Leaf']);
    fireEvent.change(input, { target: { value: 'hey @gr', selectionStart: 7 } });
    expect(optionNames()).toEqual(['Green Leaf']);
    fireEvent.keyDown(input, { key: 'Enter' }); // picks, does not send
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('hey @Green Leaf ');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: 'hey @Green Leaf ok', selectionStart: 18 } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hey @Green Leaf ok');
  });

  it('clicking a party in the picker, arrow keys and Escape', () => {
    render(<GroupChat me="a" people={people} messages={[]} onSend={vi.fn()} />);
    const input = screen.getByPlaceholderText(/Message everyone/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '@', selectionStart: 1 } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: 'x @b', selectionStart: 4 } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /Blue Anchor/ }));
    expect(input.value).toBe('x @Blue Anchor ');
  });

  it('reports the newest message time as read once on screen', () => {
    const onRead = vi.fn();
    render(<GroupChat me="a" people={people} onSend={vi.fn()} onRead={onRead} messages={[gm('m1', 'b', 'one', 1000), gm('m2', 'c', 'two', 4000)]} />);
    expect(onRead).toHaveBeenLastCalledWith(4000);
  });
});

describe('mentionCandidates', () => {
  it('names starting with the query first, then names containing it, never the viewer', () => {
    expect(mentionCandidates(people, 'a', 'le').map(p => p.id)).toEqual(['c']); // "Green Leaf" contains le; Lotus Front is me
    expect(mentionCandidates(people, 'a', 'l').map(p => p.id)).toEqual(['b', 'c']);
    expect(mentionCandidates(people, 'b', 'l').map(p => p.id)).toEqual(['a', 'c']);
    expect(mentionCandidates(people, 'a', '').map(p => p.id)).toEqual(['b', 'c']);
  });
});
