import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { NewsItem, PlayerPublic, SeatId } from '@hp/shared';
import { useStore } from '../state/store';
import { PartyDot, PartyLabel } from './ui';
import { colourHex, seatName } from '../lib';
import headlinesRaw from '../data/headlines.json';
import './newsTicker.css';

const SPEED = 70; // px per second
const MAX_RALLIES = 8; // rallies queued when the ticker first appears
const MAX_PENDING = 30;

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// shuffled once per page load
const HEADLINES: string[] = (() => {
  const arr = [...(headlinesRaw as string[])];
  const rnd = mulberry32((Date.now() ^ (Math.random() * 1e9)) >>> 0);
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
})();
let hCursor = 0; // no repeats until the list is exhausted (module-level so it survives remounts)
const nextHeadline = () => HEADLINES[hCursor++ % HEADLINES.length];

type Entry =
  | { kind: 'gap'; key: string; width: number }
  | { kind: 'head'; key: string; text: string }
  | { kind: 'rally'; key: string; n: NewsItem };
const newsKey = (n: NewsItem) => `${n.ts}:${n.seat}:${n.playerId}`;

function RallyBit({ n, players, names, onPick }: { n: NewsItem; players: PlayerPublic[]; names: Record<SeatId, string>; onPick?: (s: SeatId) => void }) {
  const p = players.find(x => x.playerId === n.playerId);
  return (
    <button className="nt-rally" style={{ '--party-colour': colourHex(p?.party?.colour) } as React.CSSProperties} onClick={() => onPick?.(n.seat)}>
      <PartyDot party={p?.party} size={22} />
      <span><PartyLabel party={p?.party} fallback={p?.nickname} /> rallied in <em>{seatName(names, n.seat)}</em></span>
    </button>
  );
}

export function NewsTicker({ onPick }: { onPick?: (seat: SeatId) => void }) {
  const snap = useStore(s => s.snapshot);
  const names = useStore(s => s.names);
  const [open, setOpen] = useState(false);
  const news = snap?.news;
  const players = snap?.players ?? [];
  const rallies = useMemo(() => [...(news ?? [])].reverse(), [news]);

  // One endless left-moving strip: items are appended on the right as room appears and dropped once they leave on the left.
  // Rallies wait in `pending` and are mixed in between 1-3 shuffled headlines.
  const [items, setItems] = useState<Entry[]>([]);
  const viewRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<Entry[]>([]);
  const pending = useRef<NewsItem[]>([]);
  const seen = useRef(new Set<string>());
  const gapLeft = useRef(0);
  const uid = useRef(0);
  const hover = useRef(false);

  useEffect(() => {
    const fresh = rallies.filter(n => !seen.current.has(newsKey(n)));
    if (!fresh.length) return;
    const firstLoad = seen.current.size === 0;
    fresh.forEach(n => seen.current.add(newsKey(n)));
    // first load: newest rallies first; later: arrival order
    const add = firstLoad ? fresh.slice(0, MAX_RALLIES) : [...fresh].reverse();
    pending.current = [...pending.current, ...add].slice(-MAX_PENDING);
  }, [rallies]);

  useEffect(() => {
    const view = viewRef.current, track = trackRef.current;
    if (!view || !track) return;
    const rnd = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);
    let x = 0, last = 0, raf = 0;
    const next = (): Entry => {
      const key = 'e' + uid.current++;
      if (pending.current.length && gapLeft.current <= 0) {
        gapLeft.current = 1 + Math.floor(rnd() * 3);
        return { kind: 'rally', key, n: pending.current.shift()! };
      }
      gapLeft.current--;
      return { kind: 'head', key, text: nextHeadline() };
    };
    const commit = (list: Entry[]) => { itemsRef.current = list; flushSync(() => setItems(list)); };
    const totalWidth = () => Array.from(track.children).reduce((w, c) => w + (c as HTMLElement).getBoundingClientRect().width, 0);

    if (!itemsRef.current.length) { // new items enter from the right edge (plain setState: flushSync is not allowed inside an effect)
      itemsRef.current = [{ kind: 'gap', key: 'gap', width: view.clientWidth }]; setItems(itemsRef.current);
    }
    const frame = (t: number) => {
      const dt = last ? Math.min((t - last) / 1000, 0.1) : 0; last = t;
      if (!hover.current) x += SPEED * dt;
      let list = itemsRef.current;
      // drop items that have fully left on the left
      let first = track.firstElementChild as HTMLElement | null;
      let fw = first ? first.getBoundingClientRect().width : 0;
      while (first && fw > 0 && list.length > 1 && x >= fw) { // fw 0 = not laid out (hidden): never churn items
        x -= fw;
        list = list.slice(1); commit(list);
        first = track.firstElementChild as HTMLElement | null;
        fw = first ? first.getBoundingClientRect().width : 0;
      }
      // keep at least one viewport (+ a little) of content to the right of the visible area
      let guard = 0;
      while (view.clientWidth > 0 && totalWidth() - x < view.clientWidth + 400 && guard++ < 6) { list = [...list, next()]; commit(list); }
      track.style.transform = `translateX(${-x}px)`;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const renderEntry = (e: Entry) => e.kind === 'gap'
    ? <span className="nt-gap" key={e.key} style={{ width: e.width }} />
    : e.kind === 'rally'
      ? <span className="nt-item nt-real" key={e.key}><RallyBit n={e.n} players={players} names={names} onPick={onPick} /></span>
      : <span className="nt-item nt-head" key={e.key}><i className="nt-sep">•</i>{e.text}</span>;

  return (
    <div className="nt" data-tour="ticker">
      {open && (
        <div className="nt-hist" role="dialog" aria-label="Rally history">
          <div className="nt-hist-head"><strong>Rally news</strong><button className="btn ghost sm" onClick={() => setOpen(false)}>Close</button></div>
          <div className="nt-hist-list">
            {rallies.length === 0 && <p className="nt-none">No rallies yet.</p>}
            {rallies.slice(0, 300).map((n, i) => (
              <RallyBit key={n.ts + ':' + n.seat + ':' + i} n={n} players={players} names={names} onPick={onPick} />
            ))}
          </div>
        </div>
      )}
      <div className="nt-bar">
        <span className="nt-label"><b className="nt-live">LIVE</b>NEWS</span>
        <div className="nt-view" ref={viewRef} onMouseEnter={() => { hover.current = true; }} onMouseLeave={() => { hover.current = false; }}>
          <div className="nt-track" ref={trackRef}>{items.map(renderEntry)}</div>
        </div>
        <button className="btn ghost sm nt-btn" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'History'}</button>
      </div>
    </div>
  );
}
