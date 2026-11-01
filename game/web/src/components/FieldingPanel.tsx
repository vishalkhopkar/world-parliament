// The seat panel of the pre-campaign. It reads everything live from the store and stays open across field / withdraw, so it switches
// state by itself in both directions. It has no backdrop: the map beside it stays paintable, and clicking another seat just moves the panel there.
import { useEffect } from 'react';
import type { SeatId } from '@hp/shared';
import { useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { fieldCandidates, withdrawCandidates } from '../net/client';
import { formatMoney, seatName } from '../lib';
import { candidatesIn } from '../lib/fielding';
import { isEliminated } from './EliminatedBanner';
import { SeatCandidates } from './SeatCandidates';
import './seatActionModal.css';
import './fieldingPanel.css';

export function FieldingPanel({ seat, phaseOf, onClose }: { seat: SeatId; phaseOf: Map<SeatId, number> | null; onClose(): void }) {
  const snap = useStore(s => s.snapshot);
  const priv = useStore(s => s.priv);
  const names = useStore(s => s.names);
  const pending = useStore(s => s.fieldPending.has(seat));
  const cfg = useMapConfig();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!snap || !priv) return null;

  const cost = cfg.costs.candidate;
  const money = formatMoney(cost, cfg.currency.symbol);
  const own = candidatesIn(snap, seat).find(c => c.playerId === priv.you);
  const committed = priv.committed?.find(c => c.seat === seat);
  const phase = phaseOf?.get(seat);
  const out = isEliminated(snap, priv.you);
  const reason = out ? "You're out of this election" : !own && priv.budget < cost ? `Not enough budget (need ${money})` : null;
  const title = seatName(names, seat);

  return (
    <div className="fp-card" role="dialog" aria-label={title} data-tour="fielding-panel">
      <button className="sam-x" aria-label="Close" onClick={onClose}>×</button>
      <h3 className="sam-title">{title}</h3>
      <p className="sam-sub">Seat {seat}{phase !== undefined ? ` · Polls in phase ${phase + 1}` : ''}</p>
      {committed && <p className="sam-committed">Committed voters: ~{committed.percent}% · {committed.level}</p>}
      {own ? (
        <>
          <p className="fp-own">{own.name ? <>Your candidate: <strong>{own.name}</strong></> : 'You have a candidate here.'}</p>
          <button className="btn fp-withdraw" disabled={pending || !!reason} title={reason ?? undefined} onClick={() => withdrawCandidates([seat])}>Withdraw (+{money})</button>
        </>
      ) : (
        <button className="btn primary fp-field" disabled={pending || !!reason} title={reason ?? undefined} onClick={() => fieldCandidates([seat])}>Field a candidate ({money})</button>
      )}
      {reason && <p className="hint fp-reason">{reason}</p>}
      <h4 className="fp-list-title">Fielded here</h4>
      <SeatCandidates snap={snap} seat={seat} me={priv.you} className="fp-candidates" />
    </div>
  );
}
