// The game's chat section: wires @hp/chat (group chat / one-to-one chats) to the store and the network.
// Which chat a stage has comes from the map config (Chat.Campaigning; counting and post-counting are always one-to-one) via chatModeFor.
import { useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { MessageCircle } from 'lucide-react';
import { Badge, DirectChat, GroupChat, conversationKey, directConversations, groupItems, unreadCount, unreadTotal } from '@hp/chat';
import type { ChatPerson } from '@hp/chat';
import type { ChatMode, CoalitionOffer, GameSnapshot, PlayerId } from '@hp/shared';
import { useStore } from '../state/store';
import { chat } from '../net/client';
import { PartyAvatar } from './ui';
import { playerName } from '../lib';
import './chatSection.css';

/** Players the chat can reach: everybody who started the game (eliminated parties still read and write). */
const MEMBER = new Set(['active', 'disconnected', 'eliminated']);

/** Seats (won + leading) of a party during counting, for the conversation list. */
const seatsOf = (snap: GameSnapshot, id: PlayerId) => (snap.tally?.wins[id] ?? 0) + (snap.tally?.leads[id] ?? 0);

/** Every member as the chat shows them: party name (never a nickname), colour, "AI player", seats once counting has started. */
export function chatPeople(snap: GameSnapshot): ChatPerson[] {
  return snap.players.filter(p => MEMBER.has(p.status)).map(p => ({
    id: p.playerId,
    name: playerName(snap.players, p.playerId),
    colour: p.party?.colour,
    subtitle: [p.kind === 'agent' ? 'AI player' : '', p.status === 'eliminated' ? 'eliminated' : snap.tally ? `${seatsOf(snap, p.playerId)} seats` : '']
      .filter(Boolean).join(' · ') || undefined,
  }));
}

/** The unread count of the whole chat section: tags of me in the group chat, everything from others one-to-one. */
export function chatUnread(snap: GameSnapshot, me: PlayerId, mode: ChatMode, chatLog: Parameters<typeof groupItems>[0], read: Record<string, number>, withOffers: boolean): number {
  if (mode === 'GROUP') return unreadCount(groupItems(chatLog), me, read[conversationKey(null)], true);
  return unreadTotal(directConversations(chatLog, withOffers ? snap.offers : [], me), me, read);
}

export function ChatSection({ snap, me, mode, renderOffer }: {
  snap: GameSnapshot;
  me: PlayerId;
  mode: ChatMode;
  /** One-to-one chats only: offers appear in the conversations, drawn by this. */
  renderOffer?: (offer: CoalitionOffer) => ReactNode;
}) {
  const messages = useStore(s => s.chat);
  const read = useStore(s => s.chatRead);
  const markRead = useStore(s => s.markChatRead);
  const people = useMemo(() => chatPeople(snap), [snap]);
  const others = useMemo(() => people.filter(p => p.id !== me), [people, me]);
  const avatar = useCallback((id: PlayerId, size: number) => <PartyAvatar party={snap.players.find(p => p.playerId === id)?.party} size={size} />, [snap.players]);
  const onGroupRead = useCallback((ts: number) => markRead(conversationKey(null), ts), [markRead]);
  const total = chatUnread(snap, me, mode, messages, read, !!renderOffer);
  const group = mode === 'GROUP';

  return (
    <section className={'card chat-card ' + (group ? 'group' : 'direct')} id="chat-section">
      <h3 className="card-title">
        <span>{group ? 'Group chat' : 'Chats'}</span>
        <Badge count={total} label={`${total} unread in the chat`} />
      </h3>
      {group
        ? <GroupChat me={me} people={people} messages={messages} renderAvatar={avatar} onRead={onGroupRead} onSend={text => chat([], text)} />
        : <DirectChat me={me} people={others} messages={messages} offers={renderOffer ? snap.offers : []} read={read} onRead={markRead}
            renderAvatar={avatar} renderOffer={renderOffer} onSend={(to, text) => chat([to], text)} />}
      {total > 0 && (
        // phones: the side panel sits below the map, so a floating button says there is something new and jumps there
        <button type="button" className="chat-fab" onClick={() => document.getElementById('chat-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
          <MessageCircle size={18} aria-hidden /> Chat <Badge count={total} label={`${total} unread`} />
        </button>
      )}
    </section>
  );
}
