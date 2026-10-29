// Building blocks shared by the group chat and the one-to-one chats: badge, avatar, message text with tags, rows.
import type { ReactNode } from 'react';
import type { OfferEvent, PlayerId } from '@hp/shared';
import { splitMentions } from '../mentions';
import type { AvatarRenderer, ChatPerson } from './types';

/** Unread count bubble; nothing at 0, "99+" above 99. */
export function Badge({ count, label }: { count: number; label?: string }) {
  if (count <= 0) return null;
  return <span className="hpchat-badge" aria-label={label ?? `${count} unread`}>{count > 99 ? '99+' : count}</span>;
}

export function Avatar({ person, size, render }: { person: ChatPerson | undefined; size: number; render?: AvatarRenderer }) {
  if (person && render) return <span className="hpchat-avatar">{render(person.id, size)}</span>;
  return (
    <span className="hpchat-avatar hpchat-initial" aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45), background: person?.colour ?? '#8a8676' }}>
      {(person?.name ?? '?').trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** "14:05" in the viewer's clock. */
export const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Message text with "@Party" tags highlighted (the viewer's own tag stands out). */
export function MessageText({ text, people, mentions, me }: { text: string; people: readonly ChatPerson[]; mentions?: readonly PlayerId[]; me: PlayerId }) {
  if (!mentions?.length) return <>{text}</>;
  return (
    <>
      {splitMentions(text, people, mentions).map((p, i) => (p.mention
        ? <span key={i} className={'hpchat-tag' + (p.mention === me ? ' me' : '')}>{p.text}</span>
        : <span key={i}>{p.text}</span>))}
    </>
  );
}

/**
 * Teams-style row: avatar on the left, name and time on top, the content below. The viewer's own rows sit on the right
 * without an avatar. `compact` = a follow-up from the same sender (no avatar / header).
 */
export function Row({ person, mine, ts, compact, render, children, className = '' }: {
  person: ChatPerson | undefined; mine: boolean; ts: number; compact?: boolean; render?: AvatarRenderer; children: ReactNode; className?: string;
}) {
  return (
    <div className={'hpchat-row' + (mine ? ' mine' : '') + (compact ? ' compact' : '') + (className ? ' ' + className : '')}>
      {!mine && <span className="hpchat-row-avatar">{!compact && <Avatar person={person} size={32} render={render} />}</span>}
      <div className="hpchat-row-main">
        {!compact && (
          <div className="hpchat-row-head">
            <b className="hpchat-name">{mine ? 'You' : person?.name ?? 'A party'}</b>
            <time className="hpchat-time">{clock(ts)}</time>
          </div>
        )}
        <div className="hpchat-bubble">{children}</div>
      </div>
    </div>
  );
}

const EVENT_TEXT: Record<OfferEvent['type'], string> = {
  accepted: 'Accepted', declined: 'Declined', unaccepted: 'Acceptance withdrawn', withdrawn: 'Offer withdrawn',
};

/** What a party did to an offer, as a line in the conversation ("Accepted"). */
export function EventRow({ person, mine, event }: { person: ChatPerson | undefined; mine: boolean; event: OfferEvent }) {
  return (
    <div className={'hpchat-event ' + event.type + (mine ? ' mine' : '')}>
      <span className="hpchat-event-who">{mine ? 'You' : person?.name ?? 'A party'}</span>
      <span className="hpchat-event-pill">{EVENT_TEXT[event.type]}</span>
      <time className="hpchat-time">{clock(event.ts)}</time>
    </div>
  );
}
