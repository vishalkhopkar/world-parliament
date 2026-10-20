import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NewsItem, PlayerPublic, SeatId } from '@hp/shared';
import { useStore } from '../state/store';
import { PartyDot } from './ui';
import { colourHex, seatName } from '../lib';
import headlinesRaw from '../data/headlines.json';
import './newsTicker.css';

const SPEED = 80; // px per second
const MAX_RALLIES = 8;

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

type Entry = { kind: 'head'; key: string; text: string } | { kind: 'rally'; key: string; n: NewsItem };

function RallyBit({ n, players, names, onPick }: { n: NewsItem; players: PlayerPublic[]; names: Record<SeatId, string>; onPick?: (s: SeatId) => void }) {
  const p = players.find(x => x.playerId === n.playerId);
  return (
    <button className="nt-rally" style={{ '--party-colour': colourHex(p?.party?.colour) } as React.CSSProperties} onClick={() => onPick?.(n.seat)}>
      <PartyDot party={p?.party} size={22} />
      <span><strong>{p?.party?.name ?? p?.nickname}</strong> rallied in <em>{seatName(names, n.seat)}</em></span>
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
  const latestKey = rallies.length ? rallies[0].ts + ':' + rallies[0].seat : '';

  // Queue: newest rally first, 2-4 headlines between rallies, headline tail so the crawl never stops.
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const rnd = mulberry32(rallies.length * 7919 + 13);
    const pushHeads = (k: number) => { for (let i = 0; i < k; i++) out.push({ kind: 'head', key: 'h' + out.length, text: nextHeadline() }); };
    rallies.slice(0, MAX_RALLIES).forEach((n, i) => {
      out.push({ kind: 'rally', key: 'r' + i + ':' + n.ts, n });
      pushHeads(2 + Math.floor(rnd() * 3));
    });
    pushHeads(Math.max(14, 20 - out.length));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rallies]);

  const copyRef = useRef<HTMLDivElement>(null);
  const [dur, setDur] = useState(60);
  useLayoutEffect(() => {
    const el = copyRef.current; if (!el) return;
    const upd = () => { const w = el.getBoundingClientRect().width; if (w > 0) setDur(w / SPEED); };
    upd();
    const ro = new ResizeObserver(upd); ro.observe(el);
    return () => ro.disconnect();
  }, [entries]);

  // restart the crawl when a new rally arrives so it is next in line
  const [epoch, setEpoch] = useState(0);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setEpoch(e => e + 1); }, [latestKey]);

  const renderEntry = (e: Entry) => e.kind === 'rally'
    ? <span className="nt-item nt-real" key={e.key}><RallyBit n={e.n} players={players} names={names} onPick={onPick} /></span>
    : <span className="nt-item nt-head" key={e.key}><i className="nt-sep">•</i>{e.text}</span>;

  const staticItem = entries[0];

  return (
    <div className="nt">
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
        <div className="nt-view">
          <div className="nt-track" key={epoch} style={{ '--nt-duration': `${dur}s` } as React.CSSProperties}>
            <div className="nt-copy" ref={copyRef}>{entries.map(renderEntry)}</div>
            <div className="nt-copy" aria-hidden>{entries.map(e => <span key={'b' + e.key} className="nt-contents">{renderEntry(e)}</span>)}</div>
          </div>
          <div className="nt-static">{staticItem && renderEntry(staticItem)}</div>
        </div>
        <button className="btn ghost sm nt-btn" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'History'}</button>
      </div>
    </div>
  );
}
