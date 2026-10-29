// One-to-one chats (Chat.Campaigning = INDV, and always from counting on), Microsoft Teams style: a list of conversations
// (one per party, newest activity first, an unread badge on each) and the open conversation beside it. Government
// offers and what was done to them ("Accepted") appear in the conversation between the proposer and each partner.
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatMessage, CoalitionOffer, PlayerId } from '@hp/shared';
import { conversationKey, directConversations, lastActivity, unreadCount } from '../common/conversations';
import type { ChatItem } from '../common/conversations';
import { Composer } from '../common/ui/Composer';
import { ItemList } from '../common/ui/ItemList';
import { Avatar, Badge } from '../common/ui/parts';
import type { AvatarRenderer, ChatPerson } from '../common/ui/types';
import '../common/ui/chat.css';

export interface DirectChatProps {
  me: PlayerId;
  /** The other parties, in the order to list them when nobody has written yet. */
  people: readonly ChatPerson[];
  messages: readonly ChatMessage[];
  /** Offers the viewer is part of (proposer or partner). */
  offers?: readonly CoalitionOffer[];
  /** Newest time already read per conversation key ('dm:<id>'). */
  read: Readonly<Record<string, number>>;
  onRead(key: string, ts: number): void;
  onSend(to: PlayerId, text: string): void;
  renderAvatar?: AvatarRenderer;
  /** Draws an offer inside the conversation (with its Accept / Decline / Withdraw buttons). */
  renderOffer?(offer: CoalitionOffer): ReactNode;
  /** Optional control of the open conversation. */
  active?: PlayerId | null;
  onActiveChange?(id: PlayerId): void;
}

const preview = (it: ChatItem | undefined, me: PlayerId): string => {
  if (!it) return '';
  const who = it.from === me ? 'You: ' : '';
  if (it.kind === 'message') return who + it.message.text;
  if (it.kind === 'offer') return who + 'Government offer';
  return who + ({ accepted: 'Accepted', declined: 'Declined', unaccepted: 'Acceptance withdrawn', withdrawn: 'Offer withdrawn' })[it.event.type];
};

export function DirectChat({ me, people, messages, offers = [], read, onRead, onSend, renderAvatar, renderOffer, active: activeIn, onActiveChange }: DirectChatProps) {
  const convs = useMemo(() => directConversations(messages, offers, me), [messages, offers, me]);
  // newest activity first (Teams); parties nobody has written with keep their given order at the end
  const list = useMemo(() => people.map((p, i) => ({ p, i, items: convs.get(p.id) ?? [] }))
    .sort((a, b) => lastActivity(b.items) - lastActivity(a.items) || a.i - b.i), [people, convs]);
  const [own, setOwn] = useState<PlayerId | null>(null);
  const activeId = activeIn ?? own ?? list[0]?.p.id ?? null;
  // a party that left the list (e.g. never existed) falls back to the first one
  const active = list.find(x => x.p.id === activeId) ?? list[0];
  const select = (id: PlayerId) => { setOwn(id); onActiveChange?.(id); };
  // keep the conversation first shown open: new activity elsewhere raises a badge, it never switches the chat under you
  useEffect(() => { if (own === null && activeIn == null && active) setOwn(active.p.id); }, [own, activeIn, active]);
  const [text, setText] = useState('');
  useEffect(() => setText(''), [active?.p.id]);

  if (!active) return <div className="hpchat hpchat-direct"><p className="hpchat-empty">Nobody to chat with.</p></div>;
  const key = conversationKey(active.p.id);

  return (
    <div className="hpchat hpchat-direct">
      <ul className="hpchat-list" role="tablist" aria-label="Chats">
        {list.map(({ p, items }) => {
          const n = p.id === active.p.id ? 0 : unreadCount(items, me, read[conversationKey(p.id)]);
          return (
            <li key={p.id}>
              <button type="button" role="tab" aria-selected={p.id === active.p.id} className={'hpchat-conv' + (p.id === active.p.id ? ' on' : '') + (n ? ' unread' : '')}
                title={p.name} onClick={() => select(p.id)}>
                <span className="hpchat-conv-avatar"><Avatar person={p} size={30} render={renderAvatar} /><Badge count={n} label={`${n} unread from ${p.name}`} /></span>
                <span className="hpchat-conv-text">
                  <b className="hpchat-name">{p.name}</b>
                  <small>{preview(items[items.length - 1], me) || p.subtitle || ''}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="hpchat-pane" role="tabpanel" aria-label={`Chat with ${active.p.name}`}>
        <div className="hpchat-pane-head">
          <Avatar person={active.p} size={26} render={renderAvatar} />
          <b className="hpchat-name">{active.p.name}</b>
          {active.p.subtitle && <small className="hpchat-sub">{active.p.subtitle}</small>}
        </div>
        <ItemList items={active.items} me={me} people={people} render={renderAvatar} renderOffer={renderOffer}
          onRead={ts => onRead(key, ts)} empty={`No messages with ${active.p.name} yet. Only the two of you see this chat.`} />
        <Composer value={text} onChange={setText} placeholder={`Message ${active.p.name}`}
          onSend={t => { onSend(active.p.id, t); setText(''); }} />
      </div>
    </div>
  );
}
