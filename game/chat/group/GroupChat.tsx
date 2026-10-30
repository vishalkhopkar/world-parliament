// The common group chat (Chat.Campaigning = GROUP; the campaign only): one conversation everybody reads.
// Typing @ opens a picker of parties; the tagged party gets a badge (the server works out who was tagged).
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { ChatMessage, PlayerId } from '@hp/shared';
import { groupItems } from '../common/conversations';
import { insertMention, mentionQuery } from '../common/mentions';
import { Composer } from '../common/ui/Composer';
import { ItemList } from '../common/ui/ItemList';
import { Avatar } from '../common/ui/parts';
import type { AvatarRenderer, ChatPerson } from '../common/ui/types';
import '../common/ui/chat.css';

export interface GroupChatProps {
  me: PlayerId;
  /** Every party in the game (the viewer included): names for senders and the @ picker. */
  people: readonly ChatPerson[];
  messages: readonly ChatMessage[];
  onSend(text: string): void;
  /** Called with the newest message time once the conversation has been on screen. */
  onRead?(ts: number): void;
  renderAvatar?: AvatarRenderer;
  placeholder?: string;
  empty?: ReactNode;
}

/** Parties to offer for "@query": names starting with the query first, then names containing it. Never the viewer. */
export function mentionCandidates(people: readonly ChatPerson[], me: PlayerId, query: string): ChatPerson[] {
  const q = query.trim().toLowerCase();
  const others = people.filter(p => p.id !== me);
  const starts = others.filter(p => p.name.toLowerCase().startsWith(q));
  const has = others.filter(p => !starts.includes(p) && p.name.toLowerCase().includes(q));
  return [...starts, ...has];
}

export function GroupChat({ me, people, messages, onSend, onRead, renderAvatar, placeholder = 'Message everyone (@ tags a party)', empty }: GroupChatProps) {
  const items = useMemo(() => groupItems(messages), [messages]);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null); // Escape closes the picker for this @
  const input = useRef<HTMLInputElement>(null);
  // After picking a party the caret goes behind the inserted tag. Done in a layout effect (right after the DOM update,
  // before the browser can handle the next keystroke); a later requestAnimationFrame moved the caret back while the user was already typing.
  const [restore, setRestore] = useState(0);
  useLayoutEffect(() => {
    const el = input.current;
    if (restore > 0 && el) { el.focus(); el.setSelectionRange(caret, caret); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restore]);

  const q = mentionQuery(text, caret);
  // "@Green Leaf " (a whole name and a space) is a finished tag: no picker
  const finished = !!q && /\s$/.test(q.query) && people.some(p => p.name.toLowerCase() === q.query.trim().toLowerCase());
  const candidates = q && !finished && q.start !== closedAt ? mentionCandidates(people, me, q.query) : [];
  const open = candidates.length > 0;

  const choose = (p: ChatPerson) => {
    if (!q) return;
    const r = insertMention(text, q.start, caret, p.name);
    setText(r.text); setCaret(r.caret); setPick(0);
    setRestore(n => n + 1);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setPick(i => (i + (e.key === 'ArrowDown' ? 1 : candidates.length - 1)) % candidates.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(candidates[Math.min(pick, candidates.length - 1)]); return true; }
    if (e.key === 'Escape') { setClosedAt(q!.start); return true; }
    return false;
  };

  const picker = open && (
    <ul className="hpchat-mentions" role="listbox" aria-label="Tag a party">
      {candidates.map((p, i) => (
        <li key={p.id} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''}
          onMouseDown={e => { e.preventDefault(); choose(p); }}>
          <Avatar person={p} size={22} render={renderAvatar} /><span>{p.name}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="hpchat hpchat-group">
      <ItemList items={items} me={me} people={people} render={renderAvatar} onRead={onRead}
        empty={empty ?? 'No messages yet. Everyone in the game reads this chat; type @ to tag a party.'} />
      <Composer value={text} placeholder={placeholder} inputRef={input} above={picker} onKeyDown={onKeyDown}
        onChange={(v, c) => { setText(v); setCaret(c); setPick(0); if (closedAt !== null && !mentionQuery(v, c)) setClosedAt(null); }}
        onSelect={setCaret}
        onSend={t => { onSend(t); setText(''); setCaret(0); setClosedAt(null); }} />
    </div>
  );
}
