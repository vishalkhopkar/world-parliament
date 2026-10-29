import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CoalitionOffer, PlayerId } from '@hp/shared';
import type { ChatItem } from '../conversations';
import { lastActivity } from '../conversations';
import { EventRow, MessageText, Row } from './parts';
import type { AvatarRenderer, ChatPerson } from './types';

/** Follow-ups from the same sender within this time are drawn without avatar and header (Teams style). */
const GROUP_MS = 120_000;

/** True while the element is on screen and the tab is visible (always true where IntersectionObserver is missing). */
export function useOnScreen(ref: React.RefObject<HTMLElement>): boolean {
  const [inView, setInView] = useState(true);
  const [tabVisible, setTabVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(es => setInView(es.some(e => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const on = () => setTabVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return inView && tabVisible;
}

/**
 * The scrolling list of a conversation. Keeps the newest line in view and reports the newest time once it has been
 * on screen (`onRead`), which clears the badge.
 */
export function ItemList({ items, me, people, render, renderOffer, onRead, empty }: {
  items: readonly ChatItem[];
  me: PlayerId;
  people: readonly ChatPerson[];
  render?: AvatarRenderer;
  renderOffer?: (offer: CoalitionOffer) => ReactNode;
  onRead?: (ts: number) => void;
  empty: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(ref);
  const newest = lastActivity(items);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [items.length]);
  useEffect(() => { if (onScreen && newest > 0) onRead?.(newest); }, [onScreen, newest, onRead]);
  const person = (id: PlayerId) => people.find(p => p.id === id);
  return (
    <div className="hpchat-log" ref={ref} role="log" aria-live="polite">
      {items.length === 0 ? <p className="hpchat-empty">{empty}</p> : items.map((it, i) => {
        const prev = items[i - 1];
        const mine = it.from === me;
        if (it.kind === 'offerEvent') return <EventRow key={it.id} person={person(it.from)} mine={mine} event={it.event} />;
        if (it.kind === 'offer') {
          return (
            <Row key={it.id} person={person(it.from)} mine={mine} ts={it.ts} render={render} className="offer-row">
              {renderOffer ? renderOffer(it.offer) : 'Government offer'}
            </Row>
          );
        }
        const compact = !!prev && prev.kind === 'message' && prev.from === it.from && it.ts - prev.ts < GROUP_MS;
        return (
          <Row key={it.id} person={person(it.from)} mine={mine} ts={it.ts} compact={compact} render={render}>
            <MessageText text={it.message.text} people={people} mentions={it.message.mentions} me={me} />
          </Row>
        );
      })}
    </div>
  );
}
