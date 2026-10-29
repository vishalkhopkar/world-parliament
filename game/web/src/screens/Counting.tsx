import { useEffect, useMemo } from 'react';
import { majorityOf } from '@hp/shared';
import type { GameSnapshot, SeatId } from '@hp/shared';
import { useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { SeatMap } from '../map/SeatMap';
import { Negotiation } from '../components/Negotiation';
import { ResultPanels } from '../components/ResultPanels';
import { SeatShareHint } from '../components/SeatShareHint';
import { SeatSharesModal } from '../components/SeatSharesModal';
import { PartyDot, PartyLabel } from '../components/ui';
import './game.css';
import './Counting.css';
import { colourHex, formatClock, seatCountOf, seatName, useServerNow } from '../lib';

export function TallyBar({ snap }: { snap: GameSnapshot }) {
  const cfg = useMapConfig();
  const total = seatCountOf(snap.tally?.total, cfg.seatCount);
  const maj = majorityOf(total);
  const rows = snap.players.filter(p => p.status === 'active' || p.status === 'disconnected' || p.status === 'eliminated')
    .map(p => ({ p, wins: snap.tally?.wins[p.playerId] ?? 0, leads: snap.tally?.leads[p.playerId] ?? 0 }))
    .sort((a, b) => b.wins + b.leads - (a.wins + a.leads));
  return (
    <div className="tally">
      <div className="tally-bar" role="img" aria-label="Seat tally">
        {rows.map(r => (
          <div key={r.p.playerId} className="seg" style={{ '--seg-width': `${(r.wins / total) * 100}%`, '--party-colour': colourHex(r.p.party?.colour) } as React.CSSProperties} />
        ))}
        {rows.map(r => (
          <div key={'l' + r.p.playerId} className="seg lead" style={{ '--seg-width': `${(r.leads / total) * 100}%`, '--party-colour': colourHex(r.p.party?.colour) } as React.CSSProperties} />
        ))}
        <div className="majority" style={{ '--majority-left': `${(maj / total) * 100}%` } as React.CSSProperties}><span>Majority {maj}</span></div>
      </div>
      <div className="tally-legend">
        {rows.map(r => (
          <span key={r.p.playerId} className="tl-item">
            <PartyDot party={r.p.party} size={26} />
            <PartyLabel party={r.p.party} fallback={r.p.nickname} />
            <span>{r.wins} won{r.leads ? ` + ${r.leads} leading` : ''}</span>
          </span>
        ))}
      </div>
      <div className="muted tally-foot">{snap.tally?.declared ?? 0} of {total} seats declared</div>
    </div>
  );
}

export function Counting() {
  const snap = useStore(s => s.snapshot);
  const names = useStore(s => s.names);
  const selected = useStore(s => s.selectedSeat);
  const selectSeat = useStore(s => s.selectSeat);
  const now = useServerNow();

  // a seat picked here must not stay selected on the next screen
  useEffect(() => () => selectSeat(null), [selectSeat]);

  const { fills, leading } = useMemo(() => {
    const f: Record<SeatId, string> = {};
    const l = new Set<SeatId>();
    if (snap) for (const d of Object.values(snap.seats)) {
      f[d.seat] = colourHex(snap.players.find(p => p.playerId === d.playerId)?.party?.colour);
      if (d.status === 'leading') l.add(d.seat);
    }
    return { fills: f, leading: l };
  }, [snap?.seats, snap?.players]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!snap) return <div className="page"><p className="hint">Connecting…</p></div>;
  const t = snap.timeline;
  const counting = snap.status === 'counting';
  const left = t ? (counting ? t.countingEnd : t.postCountingEnd) - now : 0;
  const decl = selected != null ? snap.seats[selected] : undefined;
  const dp = decl ? snap.players.find(p => p.playerId === decl.playerId) : undefined;

  return (
    <div className="game">
      <SeatShareHint />
      <div className="hud">
        <div className="hud-item"><span>{counting ? 'Counting ends in' : snap.government && snap.status === 'postCounting' ? 'Final result in' : 'Government must form within'}</span><strong>{formatClock(left)}</strong></div>
        <div className="hud-item wide" data-tour="tally"><TallyBar snap={snap} /></div>
      </div>
      <div className="game-body wide-side">
        <div className="map-col" data-tour="map">
          {counting && <div className="result-col"><ResultPanels /></div>}
          <SeatMap names={names} fills={fills} leading={leading} selectedSeat={selected} onSeatClick={selectSeat} />
          {selected != null && (
            <div className="map-note">
              <strong>{seatName(names, selected)}</strong>{' '}
              {decl ? <span>{decl.status === 'won' ? 'won by' : 'leading:'} <b className="party-text" style={{ '--party-colour': colourHex(dp?.party?.colour) } as React.CSSProperties}>{dp?.party?.name}</b></span> : <span className="muted">not yet declared</span>}
            </div>
          )}
          {selected != null && <SeatSharesModal seat={selected} onClose={() => selectSeat(null)} />}
        </div>
        <aside className="side" data-tour="side">
          <Negotiation snap={snap} />
        </aside>
      </div>
    </div>
  );
}
