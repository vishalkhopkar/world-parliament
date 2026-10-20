import { useEffect, useRef, useState } from 'react';
import type { AnalystReport, GameSnapshot, PrivateState, SeatId } from '@hp/shared';
import { useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { buyReport, campaign } from '../net/client';
import { formatMoney, seatName } from '../lib';
import './seatActionModal.css';

function curvePrice(curve: { start: number; end: number }, snap: GameSnapshot, now: number) {
  const t = snap.timeline;
  if (!t) return curve.start;
  const f = Math.min(1, Math.max(0, (now - t.campaignStart) / (t.campaignEnd - t.campaignStart)));
  return Math.round(curve.start + (curve.end - curve.start) * f);
}

interface Props {
  seat: SeatId;
  snap: GameSnapshot;
  priv: PrivateState;
  now: number;
  phaseOf: Map<SeatId, number> | null;
  polled: ReadonlySet<SeatId>;
  onClose(): void;
}

/** Centre-of-map popup shown when a seat is clicked during the campaign. Any choice runs the action and closes it. */
export function SeatActionModal({ seat, snap, priv, now, phaseOf, polled, onClose }: Props) {
  const names = useStore(s => s.names);
  const cfg = useMapConfig();
  const money = (n: number) => formatMoney(n, cfg.currency.symbol);
  const cardRef = useRef<HTMLDivElement>(null);
  const isPolled = polled.has(seat);
  const phase = phaseOf?.get(seat);
  const started = !snap.timeline || now >= snap.timeline.campaignStart;
  const reportPrice = curvePrice(cfg.analyst.seatReport, snap, now);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { cardRef.current?.focus(); }, [seat]);
  // the phase for this seat closed while the panel was open
  useEffect(() => {
    if (!isPolled) return;
    const h = setTimeout(onClose, 1800);
    return () => clearTimeout(h);
  }, [isPolled, onClose]);

  const reasonFor = (cost: number): string | null => {
    if (!started) return 'Campaign has not started yet';
    if (priv.budget < cost) return `Not enough budget (need ${money(cost)})`;
    return null;
  };
  const options = [
    { key: 'rally', label: 'Rally', cost: cfg.costs.rally, desc: 'Public news. Boosts your party here and nearby.', run: () => campaign('rally', seat) },
    { key: 'roadshow', label: 'Roadshow', cost: cfg.costs.roadshow, desc: 'Secret. Only helps nearby.', run: () => campaign('roadshow', seat) },
    { key: 'report', label: 'Local report', cost: reportPrice, desc: 'Analyst estimate for this seat (delayed, noisy).', run: () => buyReport('seat', seat) },
  ];

  return (
    <div className="sam-backdrop" onClick={onClose}>
      <div className="sam-card" ref={cardRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={seatName(names, seat)} onClick={e => e.stopPropagation()}>
        <button className="sam-x" aria-label="Close" onClick={onClose}>×</button>
        <h3 className="sam-title">{seatName(names, seat)}</h3>
        <p className="sam-sub">Seat {seat}{phase !== undefined ? ` · Polls in phase ${phase + 1}` : ''}</p>
        {isPolled ? (
          <p className="sam-closed">Polling here is closed</p>
        ) : (
          <div className="sam-options">
            {options.map(o => {
              const reason = reasonFor(o.cost);
              return (
                <button key={o.key} className={'sam-opt sam-' + o.key} disabled={!!reason} title={reason ?? undefined}
                  onClick={() => { o.run(); onClose(); }}>
                  <span className="sam-opt-row"><strong>{o.label}</strong><span className="sam-cost">{money(o.cost)}</span></span>
                  <small>{reason ?? o.desc}</small>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** Pops a small toast summarising each newly arrived analyst report (the modal has closed by then). */
export function ReportToast() {
  const priv = useStore(s => s.priv);
  const names = useStore(s => s.names);
  const players = useStore(s => s.snapshot?.players);
  const count = priv?.myReports.length ?? 0;
  const prev = useRef<number | null>(null);
  const [shown, setShown] = useState<AnalystReport | null>(null);

  useEffect(() => {
    if (prev.current !== null && count > prev.current && priv) setShown(priv.myReports[priv.myReports.length - 1]);
    prev.current = count;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);
  useEffect(() => {
    if (!shown) return;
    const h = setTimeout(() => setShown(null), 7000);
    return () => clearTimeout(h);
  }, [shown]);
  if (!shown) return null;
  const seat = shown.scope === 'seat';
  const fmt = (v: number) => (seat ? `${(v * 100).toFixed(1)}%` : String(Math.round(v)));
  const top = [...shown.entries].sort((a, b) => b.estimate - a.estimate).slice(0, 3);
  return (
    <div className="sam-toast" role="status" onClick={() => setShown(null)}>
      <strong>{seat ? `Report: ${seatName(names, shown.seat!)}` : 'Global report'}</strong>
      {top.map(e => {
        const p = players?.find(x => x.playerId === e.playerId);
        return <div key={e.playerId}>{p?.party?.name ?? p?.nickname ?? 'Player'}: {fmt(e.estimate)} ± {fmt(e.margin)}</div>;
      })}
    </div>
  );
}
