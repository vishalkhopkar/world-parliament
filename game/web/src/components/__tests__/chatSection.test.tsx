// The game's chat section: GROUP = one common chat with @ tags (badge only when tagged); INDV = one-to-one chats with
// government offers inside the conversations ("Accepted" lines) and a badge per chat plus one on the section.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { WORLD_CONFIG } from '@hp/shared';
import type { ChatMessage, CoalitionOffer, GameSnapshot, PlayerPublic } from '@hp/shared';

vi.mock('../../net/client', () => ({ chat: vi.fn(), proposeGovernment: vi.fn(), respondOffer: vi.fn(), withdrawOffer: vi.fn() }));

import { chat, respondOffer } from '../../net/client';
import { ChatSection, chatPeople, chatUnread } from '../ChatSection';
import { Negotiation } from '../Negotiation';
import { useStore } from '../../state/store';

const players: PlayerPublic[] = [
  { playerId: 'a', nickname: 'Asha', isAdmin: true, status: 'active', party: { name: 'Lotus Front', colour: '#E8710A', symbol: 'sun' } },
  { playerId: 'b', nickname: 'Ben', isAdmin: false, status: 'active', party: { name: 'Blue Anchor', colour: '#1F5FBF', symbol: 'globe' } },
  { playerId: 'c', nickname: 'Chitra', isAdmin: false, status: 'active', party: { name: 'Green Leaf', colour: '#1E8C45', symbol: 'leaf' } },
  { playerId: 'd', nickname: 'Dev', isAdmin: false, status: 'active', party: { name: 'Red Star', colour: '#B3261E', symbol: 'star' } },
];
const snap = (over: Partial<GameSnapshot> = {}) => ({
  gameId: 'g', mapId: 'world-500', status: 'counting', players, offers: [], government: null,
  tally: { wins: { a: 150, b: 120, c: 90, d: 40 }, leads: {}, declared: 400, total: 500 }, ...over,
} as unknown as GameSnapshot);
const gm = (id: string, from: string, text: string, ts: number, mentions?: string[]): ChatMessage => ({ id, from, to: [], text, ts, channel: 'group', ...(mentions ? { mentions } : {}) });
const dm = (id: string, from: string, to: string, text: string, ts: number): ChatMessage => ({ id, from, to: [to], text, ts, channel: 'direct' });
const setChat = (log: ChatMessage[], read: Record<string, number> = {}) => useStore.setState({ me: 'a', gameId: 'g', chat: log, chatRead: read, lobby: null, gamePkg: null } as never);
const sectionBadge = () => screen.queryByLabelText(/unread in the chat/);

beforeEach(() => { vi.mocked(chat).mockClear(); vi.mocked(respondOffer).mockClear(); });

describe('config: one group chat in the campaign, one-to-one chats from counting', () => {
  it('the shipped modes', () => { expect(WORLD_CONFIG.chat).toEqual({ campaigning: 'GROUP' }); });
});

describe('group chat (GROUP)', () => {
  it('is titled "Group chat", has no conversation list, shows every group message with party names (never nicknames)', () => {
    setChat([gm('m1', 'b', 'hello all', 1000), gm('m2', 'a', 'my own', 2000)]);
    const { container } = render(<ChatSection snap={snap({ status: 'campaign' })} me="a" mode="GROUP" />);
    expect(screen.getByText('Group chat')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText('hello all')).toBeInTheDocument();
    expect(screen.getByText('Blue Anchor')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Asha|Ben\b|Chitra/);
  });

  it('sends to everybody (no recipients)', () => {
    setChat([]);
    render(<ChatSection snap={snap({ status: 'campaign' })} me="a" mode="GROUP" />);
    const input = screen.getByPlaceholderText(/Message everyone/);
    fireEvent.change(input, { target: { value: 'hi @Blue Anchor' } });
    fireEvent.keyDown(input, { key: 'Enter' }); // the @ picker is open: Enter completes the tag
    expect(chat).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('hi @Blue Anchor ');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(chat).toHaveBeenCalledWith([], 'hi @Blue Anchor');
  });

  it('badge counts only messages that tag me (none for plain messages)', () => {
    const log = [gm('m1', 'b', 'plain', 1000), gm('m2', 'c', '@Lotus Front deal?', 2000, ['a']), gm('m3', 'd', '@Blue Anchor', 3000, ['b']), gm('m4', 'b', '@Lotus Front?', 4000, ['a'])];
    expect(chatUnread(snap(), 'a', 'GROUP', log, {}, false)).toBe(2);
    expect(chatUnread(snap(), 'a', 'GROUP', log, { group: 2000 }, false)).toBe(1);
    expect(chatUnread(snap(), 'b', 'GROUP', log, {}, false)).toBe(1);
  });

  it('marks the group chat read up to the newest message once shown', () => {
    setChat([gm('m1', 'b', 'plain', 1000), gm('m2', 'c', '@Lotus Front deal?', 2000, ['a'])]);
    render(<ChatSection snap={snap({ status: 'campaign' })} me="a" mode="GROUP" />);
    expect(useStore.getState().chatRead.group).toBe(2000);
    expect(sectionBadge()).toBeNull();
  });
});

describe('one-to-one chats (INDV)', () => {
  it('chatUnread: everything others sent one-to-one (offers too, when shown) that is not read yet', () => {
    const log = [dm('m1', 'b', 'a', 'x', 1000), dm('m2', 'a', 'b', 'mine', 1500), dm('m3', 'c', 'a', 'y', 2000)];
    expect(chatUnread(snap(), 'a', 'INDV', log, {}, false)).toBe(2);
    expect(chatUnread(snap(), 'a', 'INDV', log, { 'dm:b': 1000 }, false)).toBe(1);
    const o: CoalitionOffer = { offerId: 'o', proposer: 'd', portfolios: { PM: ['d'] }, partners: ['a'], accepted: [], status: 'open', createdAt: 3000 };
    expect(chatUnread(snap({ offers: [o] }), 'a', 'INDV', log, {}, true)).toBe(3);
    expect(chatUnread(snap({ offers: [o] }), 'a', 'INDV', log, {}, false)).toBe(2);
  });


  it('lists every other party with its seats; the section badge sums what others sent that is unread', () => {
    setChat([dm('m1', 'b', 'a', 'from b', 1000), dm('m2', 'c', 'a', 'c one', 2000), dm('m3', 'c', 'a', 'c two', 3000)], { 'dm:b': 1000 });
    render(<ChatSection snap={snap()} me="a" mode="INDV" />);
    expect(screen.getByText('Chats')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: /Red Star/ })).toHaveTextContent('40 seats');
    // the newest conversation (Green Leaf) is open and read; Blue Anchor was read before
    expect(screen.getByRole('tabpanel', { name: 'Chat with Green Leaf' })).toBeInTheDocument();
    expect(useStore.getState().chatRead['dm:c']).toBe(3000);
    expect(sectionBadge()).toBeNull();
  });

  it('a new message in a conversation that is not open badges it and the section', () => {
    setChat([dm('m1', 'a', 'd', 'mine', 5000), dm('m2', 'b', 'a', 'psst', 1000), dm('m3', 'b', 'a', 'psst 2', 2000)]);
    render(<ChatSection snap={snap()} me="a" mode="INDV" />);
    expect(screen.getByRole('tabpanel', { name: 'Chat with Red Star' })).toBeInTheDocument();
    expect(screen.getByLabelText('2 unread from Blue Anchor')).toBeInTheDocument();
    expect(sectionBadge()).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: /^Chat/ })).toBeInTheDocument(); // the floating button for phones
    fireEvent.click(screen.getByRole('tab', { name: /Blue Anchor/ }));
    expect(sectionBadge()).toBeNull();
  });

  it('sends to the open conversation only', () => {
    setChat([]);
    render(<ChatSection snap={snap()} me="a" mode="INDV" />);
    fireEvent.click(screen.getByRole('tab', { name: /Green Leaf/ }));
    const input = screen.getByPlaceholderText('Message Green Leaf');
    fireEvent.change(input, { target: { value: 'coalition?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(chat).toHaveBeenCalledWith(['c'], 'coalition?');
  });
});

describe('offers inside the one-to-one chats (counting screen)', () => {
  const offer = (o: Partial<CoalitionOffer>): CoalitionOffer => ({ offerId: 'o1', proposer: 'b', portfolios: { PM: ['b'], HOME: ['a'] }, partners: ['a'], accepted: [], status: 'open', createdAt: 4000, ...o });

  it('an incoming offer appears in the chat with its proposer, with Accept / Decline there', () => {
    setChat([]);
    useStore.setState({ snapshot: snap({ offers: [offer({})] }) } as never);
    render(<Negotiation snap={snap({ offers: [offer({})] })} />);
    const pane = screen.getByRole('tabpanel', { name: 'Chat with Blue Anchor' });
    expect(within(pane).getByText('Blue Anchor proposes')).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole('button', { name: 'Accept' }));
    expect(respondOffer).toHaveBeenCalledWith('o1', true);
    expect(screen.queryByText('Offers')).toBeNull(); // no separate Offers card with one-to-one chats
  });

  it('"Accepted" is printed in the chat of the party who accepted (my own acceptance too)', () => {
    setChat([]);
    const o = offer({ accepted: ['a'], log: [{ type: 'accepted', by: 'a', ts: 5000 }] });
    render(<Negotiation snap={snap({ offers: [o] })} />);
    const pane = screen.getByRole('tabpanel', { name: 'Chat with Blue Anchor' });
    expect(within(pane).getByText('Accepted')).toBeInTheDocument();
  });

  it('my offer appears in my chat with each partner; their acceptance shows there as "Accepted"', () => {
    setChat([]);
    const mine = offer({ proposer: 'a', portfolios: { PM: ['a'], HOME: ['b'], FINANCE: ['c'] }, partners: ['b', 'c'], accepted: ['c'], log: [{ type: 'accepted', by: 'c', ts: 6000 }] });
    render(<Negotiation snap={snap({ offers: [mine] })} />);
    // Green Leaf accepted last, so its chat is the newest and open
    const pane = screen.getByRole('tabpanel', { name: 'Chat with Green Leaf' });
    expect(within(pane).getByText('Your proposal')).toBeInTheDocument();
    expect(within(pane).getByText('Accepted')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Blue Anchor/ }));
    const other = screen.getByRole('tabpanel', { name: 'Chat with Blue Anchor' });
    expect(within(other).getByText('Your proposal')).toBeInTheDocument();
    expect(within(other).queryByText('Accepted')).toBeNull();
  });

  it('the offer builder stays outside the chat', () => {
    setChat([]);
    const { container } = render(<Negotiation snap={snap()} />);
    const builder = container.querySelector('.tour-offer-builder')!;
    expect(builder).toBeInTheDocument();
    expect(builder.closest('.chat-card')).toBeNull();
  });
});

describe('chatPeople', () => {
  it('members only (no pending / rejected), party names, seats in counting, "eliminated"', () => {
    const ps = [...players, { playerId: 'e', nickname: 'Eve', isAdmin: false, status: 'pending' } as PlayerPublic, { ...players[3], playerId: 'f', status: 'eliminated' } as PlayerPublic];
    const people = chatPeople(snap({ players: ps }));
    expect(people.map(p => p.id)).toEqual(['a', 'b', 'c', 'd', 'f']);
    expect(people[1]).toMatchObject({ name: 'Blue Anchor', subtitle: '120 seats' });
    expect(people[4].subtitle).toBe('eliminated');
    expect(chatPeople(snap({ tally: null }))[0].subtitle).toBeUndefined();
  });
});
