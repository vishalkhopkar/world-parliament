import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PlayerId, SeatId, SeatSharesMessage } from '@hp/shared';
import { useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { peekSeat } from '../net/client';
import { seatName } from '../lib';
import { useMediaQuery } from '../lib/useMediaQuery';
import { ResultFeed, panelCount, wantKey } from '../lib/resultFeed';
import type { PanelKind } from '../lib/resultFeed';
import { ResultPanel } from './ResultPanel';
import './ResultPanels.css';

/** A peek answer that has not arrived after this long is given up on (the card is skipped). */
export const PEEK_TIMEOUT_MS = 1500;
/** Wide-screen only: below this the column is not rendered at all (no timers, no peeks). */
export const PANELS_MIN_WIDTH = '(min-width: 1200px)';
const MAX_TRIES = 4;

interface Card { id: number; seat: SeatId; kind: PanelKind; partyId: PlayerId; candidate: string }

/** The "result panel set": a column of flashing candidate cards beside the map, only while counting on wide screens. */
export function ResultPanels() {
  const wide = useMediaQuery(PANELS_MIN_WIDTH);
  const counting = useStore(s => s.snapshot?.status === 'counting');
  if (!wide || !counting) return null;
  return <PanelColumn />;
}

function PanelColumn() {
  const { panelDisplayMs, panelStaggerMs, panelRunnerUpPercent, panelOtherPercent } = useMapConfig().counting;
  const seats = useStore(s => s.snapshot?.seats);
  const colRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(2);
  const [cards, setCards] = useState<(Card | null)[]>([]);
  const cardsRef = useRef<(Card | null)[]>([]);
  const feedRef = useRef<ResultFeed>();
  if (!feedRef.current) feedRef.current = new ResultFeed();
  const feed = feedRef.current;
  const nextId = useRef(0);

  // number of cards = what fits the column height
  useLayoutEffect(() => {
    const el = colRef.current;
    if (!el) return;
    const measure = () => setCount(panelCount(el.clientHeight));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // declarations -> feed events (declared before the timers so the feed is current at their first tick)
  useEffect(() => { if (seats) feed.update(seats); }, [seats, feed]);

  // one clock per slot: first card at k x stagger, then a new card every panelDisplayMs
  useEffect(() => {
    let dead = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const pending = new Map<SeatId, Promise<SeatSharesMessage | null>>();

    /** Asks the server for a seat's shares; at most one outstanding request per seat. */
    const fetchShares = (seat: SeatId) => {
      const open = pending.get(seat);
      if (open) return open;
      const before = useStore.getState().seatShares[seat];
      const p = new Promise<SeatSharesMessage | null>(resolve => {
        let t: ReturnType<typeof setTimeout>;
        const unsub = useStore.subscribe(s => {
          const m = s.seatShares[seat];
          if (m && m !== before) done(m);
        });
        function done(m: SeatSharesMessage | null) { unsub(); clearTimeout(t); pending.delete(seat); resolve(m); }
        t = setTimeout(() => done(null), PEEK_TIMEOUT_MS);
      });
      pending.set(seat, p);
      peekSeat(seat);
      return p;
    };

    const refresh = async (slot: number) => {
      const skip = new Set<string>();
      for (let i = 0; i < MAX_TRIES && !dead; i++) {
        const snap = useStore.getState().snapshot;
        if (!snap || snap.status !== 'counting') return;
        const visible = new Set(cardsRef.current.flatMap((c, j) => (c && j !== slot ? [wantKey(c)] : [])));
        const want = feed.pick(snap.seats, visible, skip);
        if (!want) return;
        const answer = await fetchShares(want.seat);
        if (dead) return;
        const decl = useStore.getState().snapshot?.seats[want.seat];
        const pick = answer && decl && feed.resolve(want, decl, answer, snap.players.map(p => p.playerId),
          { runnerUp: panelRunnerUpPercent, other: panelOtherPercent });
        if (!pick || !answer) { skip.add(wantKey(want)); continue; }
        const party = snap.players.find(p => p.playerId === pick.partyId)?.party;
        const card: Card = {
          id: nextId.current++, ...pick,
          candidate: answer.candidates?.[pick.partyId] ?? `${party?.name ?? 'Party'} candidate`,
        };
        const next = cardsRef.current.slice();
        next[slot] = card;
        cardsRef.current = next;
        setCards(next);
        return;
      }
    };

    cardsRef.current = cardsRef.current.slice(0, count);
    setCards(cardsRef.current);
    for (let k = 0; k < count; k++) {
      timers.push(setTimeout(() => {
        void refresh(k);
        timers.push(setInterval(() => void refresh(k), panelDisplayMs));
      }, k * panelStaggerMs));
    }
    return () => { dead = true; timers.forEach(t => { clearTimeout(t); clearInterval(t); }); };
  }, [count, panelDisplayMs, panelStaggerMs, panelRunnerUpPercent, panelOtherPercent, feed]);

  const names = useStore(s => s.names);
  const players = useStore(s => s.snapshot?.players);
  return (
    <div className="result-panels" ref={colRef} aria-label="Latest results">
      {Array.from({ length: count }, (_, k) => {
        const c = cards[k];
        const party = c && players?.find(p => p.playerId === c.partyId)?.party;
        return (
          <div key={k} className="result-slot">
            {c && party && <ResultPanel key={c.id} kind={c.kind} candidate={c.candidate} party={party} constituency={seatName(names, c.seat)} />}
          </div>
        );
      })}
    </div>
  );
}
