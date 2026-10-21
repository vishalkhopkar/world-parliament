import { useEffect, useMemo, useRef } from 'react';
import type { SeatId } from '@hp/shared';
import { useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { peekSeat } from '../net/client';
import { colourHex, seatName } from '../lib';
import { PieChart } from './PieChart';
import type { PieChartItem } from './PieChart';
import './seatSharesModal.css';

interface Props {
  seat: SeatId;
  onClose(): void;
}

/**
 * Popup with the vote-share pie of a seat that has a lead or a result (renders nothing otherwise).
 * A leading seat is re-fetched every counting.pieRefreshMs while open; once confirmed it gets one last fetch and then stays steady.
 */
export function SeatSharesModal({ seat, onClose }: Props) {
  const decl = useStore(s => s.snapshot?.seats[seat]);
  const players = useStore(s => s.snapshot?.players);
  const names = useStore(s => s.names);
  const answer = useStore(s => s.seatShares[seat]);
  const { pieRefreshMs } = useMapConfig().counting;
  const cardRef = useRef<HTMLDivElement>(null);
  const declared = !!decl;
  const confirmed = decl?.status === 'won' || answer?.status === 'won';
  const prev = useRef<{ seat: SeatId; confirmed: boolean } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { cardRef.current?.focus(); }, [seat, declared]);

  // first fetch on open / seat change, and one last fetch at the moment the seat turns confirmed
  useEffect(() => {
    if (!declared) { prev.current = null; return; }
    const p = prev.current;
    if (!p || p.seat !== seat || (confirmed && !p.confirmed)) peekSeat(seat);
    prev.current = { seat, confirmed };
  }, [seat, declared, confirmed]);
  // leading seats swing: poll until confirmed
  useEffect(() => {
    if (!declared || confirmed) return;
    const h = setInterval(() => peekSeat(seat), pieRefreshMs);
    return () => clearInterval(h);
  }, [seat, declared, confirmed, pieRefreshMs]);

  const items = useMemo<PieChartItem[]>(() => {
    if (!answer || !players) return [];
    const out: PieChartItem[] = [];
    for (const [id, value] of Object.entries(answer.shares)) {
      const p = players.find(x => x.playerId === id);
      if (!p) continue; // a share for a party that is not in the game: skip
      out.push({ id, value, colour: colourHex(p.party?.colour), label: p.party?.name ?? p.nickname, candidate: answer.candidates?.[id] });
    }
    return out;
  }, [answer, players]);

  if (!decl) return null;
  const title = seatName(names, seat);
  return (
    <div className="ssm-backdrop" onClick={onClose}>
      <div className="ssm-card" ref={cardRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <button className="ssm-x" aria-label="Close" onClick={onClose}>×</button>
        <h3 className="ssm-title">{title}</h3>
        <p className={'ssm-badge ' + (confirmed ? 'ssm-won' : 'ssm-leading')}>
          {confirmed ? 'Confirmed — final result' : 'Leading — counting in progress, numbers can still swing'}
        </p>
        {answer ? <PieChart items={items} ariaLabel={`Vote share in ${title}`} /> : <p className="ssm-loading">Loading…</p>}
      </div>
    </div>
  );
}
