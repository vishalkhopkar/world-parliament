import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatMessage, CoalitionOffer } from '@hp/shared';
import { DirectChat } from '../index';
import type { ChatPerson } from '../index';

const others: ChatPerson[] = [
  { id: 'b', name: 'Blue Anchor', subtitle: '120 seats' },
  { id: 'c', name: 'Green Leaf', subtitle: '80 seats' },
  { id: 'd', name: 'Red Star', subtitle: '30 seats' },
];
const dm = (id: string, from: string, to: string, text: string, ts: number): ChatMessage => ({ id, from, to: [to], text, ts, channel: 'direct' });
const offer = (o: Partial<CoalitionOffer> = {}): CoalitionOffer => ({ offerId: 'o1', proposer: 'c', portfolios: { PM: ['c'], HOME: ['a'] }, partners: ['a'], accepted: [], status: 'open', createdAt: 5000, ...o });
const tabs = () => screen.getAllByRole('tab');
const tabName = (t: HTMLElement) => t.querySelector('.hpchat-name')?.textContent;
const tabPreview = (t: HTMLElement) => t.querySelector('small')?.textContent;
const tab = (name: string) => tabs().find(t => tabName(t) === name)!;
const pane = () => screen.getByRole('tabpanel');
const props = () => ({ me: 'a', people: others, read: {}, onRead: vi.fn(), onSend: vi.fn() });

describe('DirectChat (one-to-one chats, Teams style)', () => {
  it('lists one conversation per party, newest activity first, the rest in the given order', () => {
    render(<DirectChat {...props()} messages={[dm('m1', 'd', 'a', 'hi from d', 1000), dm('m2', 'a', 'c', 'to c', 2000)]} />);
    expect(tabs().map(tabName)).toEqual(['Green Leaf', 'Red Star', 'Blue Anchor']);
    expect(tabs().map(tabPreview)).toEqual(['You: to c', 'hi from d', '120 seats']);
  });

  it('opens the newest conversation; others show an unread badge for what the other party sent', () => {
    render(<DirectChat {...props()} messages={[dm('m1', 'd', 'a', 'one', 1000), dm('m2', 'd', 'a', 'two', 1500), dm('m3', 'b', 'a', 'newest', 2000)]} />);
    expect(screen.getByRole('tabpanel', { name: 'Chat with Blue Anchor' })).toBeInTheDocument();
    expect(within(pane()).getByText('newest')).toBeInTheDocument();
    expect(within(pane()).queryByText('two')).toBeNull(); // only the open conversation is shown
    expect(screen.getByLabelText('2 unread from Red Star')).toHaveTextContent('2');
    expect(screen.queryByLabelText(/unread from Blue Anchor/)).toBeNull(); // the open one is being read
  });

  it('the badge respects what was already read', () => {
    render(<DirectChat {...props()} read={{ 'dm:d': 1000 }} active="b" messages={[dm('m1', 'd', 'a', 'one', 1000), dm('m2', 'd', 'a', 'two', 1500)]} />);
    expect(screen.getByLabelText('1 unread from Red Star')).toBeInTheDocument();
  });

  it('switching conversation shows its messages, marks it read and sends to that party only', () => {
    const p = props();
    render(<DirectChat {...p} messages={[dm('m1', 'b', 'a', 'from b', 1000), dm('m2', 'd', 'a', 'from d', 3000)]} />);
    fireEvent.click(tab('Blue Anchor'));
    expect(within(pane()).getByText('from b')).toBeInTheDocument();
    expect(p.onRead).toHaveBeenCalledWith('dm:b', 1000);
    const input = screen.getByPlaceholderText('Message Blue Anchor');
    fireEvent.change(input, { target: { value: 'deal?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(p.onSend).toHaveBeenCalledWith('b', 'deal?');
  });

  it('an offer appears in the proposer\'s conversation, drawn by renderOffer, with "Accepted" lines after it', () => {
    const o = offer({ log: [{ type: 'accepted', by: 'a', ts: 6000 }] });
    render(<DirectChat {...props()} messages={[]} offers={[o]} renderOffer={x => <div data-testid="card">Offer {x.offerId}</div>} />);
    const p = screen.getByRole('tabpanel', { name: 'Chat with Green Leaf' });
    expect(within(p).getByTestId('card')).toHaveTextContent('Offer o1');
    expect(within(p).getByText('Accepted')).toBeInTheDocument();
    expect(within(p).getByText('You')).toBeInTheDocument(); // I accepted
  });

  it('an incoming offer badges its conversation when it is not open', () => {
    render(<DirectChat {...props()} active="b" messages={[]} offers={[offer()]} />);
    expect(screen.getByLabelText('1 unread from Green Leaf')).toBeInTheDocument();
    expect(tabPreview(tab('Green Leaf'))).toBe('Government offer');
  });

  it('says so when nobody has written yet, and with nobody to talk to', () => {
    const { unmount } = render(<DirectChat {...props()} messages={[]} />);
    expect(screen.getByText(/No messages with Blue Anchor yet/)).toBeInTheDocument();
    unmount();
    render(<DirectChat {...props()} people={[]} messages={[]} />);
    expect(screen.getByText('Nobody to chat with.')).toBeInTheDocument();
  });

  it('a message from another party never switches the open conversation: it gets a badge instead', () => {
    const p = props();
    const { rerender } = render(<DirectChat {...p} messages={[dm('m1', 'b', 'a', 'from b', 1000)]} />);
    expect(screen.getByRole('tabpanel', { name: 'Chat with Blue Anchor' })).toBeInTheDocument();
    rerender(<DirectChat {...p} messages={[dm('m1', 'b', 'a', 'from b', 1000), dm('m2', 'd', 'a', 'new from d', 2000)]} />);
    expect(screen.getByRole('tabpanel', { name: 'Chat with Blue Anchor' })).toBeInTheDocument();
    expect(tabName(tabs()[0])).toBe('Red Star'); // the list still puts the newest first
    expect(screen.getByLabelText('1 unread from Red Star')).toBeInTheDocument();
    expect(p.onRead).not.toHaveBeenCalledWith('dm:d', 2000);
  });

  it('onActiveChange reports the chosen conversation', () => {
    const onActiveChange = vi.fn();
    render(<DirectChat {...props()} messages={[]} onActiveChange={onActiveChange} />);
    fireEvent.click(tabs()[2]);
    expect(onActiveChange).toHaveBeenCalledWith('d');
  });
});
