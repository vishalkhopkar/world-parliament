import { useEffect, useMemo, useState } from 'react';
import type { Outcome, SeatId } from '@hp/shared';
import { selectIsAdmin, useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { SeatMap } from '../map/SeatMap';
import { Card, PartyBadge, PartyTags } from '../components/ui';
import { SeatSharesModal } from '../components/SeatSharesModal';
import { SeatShareHint } from '../components/SeatShareHint';
import { colourHex, playerName } from '../lib';
import { isTour, leaveGame, playAgain } from '../net/client';
import { PhasesSelect } from '../components/PhasesSelect';
import './Result.css';
import { TallyBar } from './Counting';

const HEADLINE: Record<Outcome, string> = {
  majority: 'Outright majority',
  coalition: 'Coalition government',
  draw: 'A dead heat: it is a draw',
  noGovernment: 'No government formed. Everyone loses.',
};

/** Host: pick the phases and start the next game with the same players. Others: wait. Nothing in the tour or for abandoned games. */
function PlayAgain({ phases }: { phases: number }) {
  const cfg = useMapConfig();
  const isAdmin = useStore(selectIsAdmin);
  const moved = useStore(s => !!s.snapshot?.nextGameId);
  const [choice, setChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isAdmin) return <p className="hint play-again-wait" data-testid="play-again-wait">Waiting for the host to play again.</p>;
  if (moved) return <p className="hint play-again-wait" data-testid="play-again-wait">Starting the next game…</p>;
  const go = async () => { setBusy(true); try { await playAgain(choice ?? phases); } finally { setBusy(false); } };
  return (
    <div className="play-again" data-testid="play-again">
      <PhasesSelect range={cfg.phases} value={choice ?? phases} onChange={setChoice} disabled={busy} />
      <button className="btn primary" disabled={busy} onClick={() => void go()}>{busy ? 'Starting…' : 'Play again'}</button>
    </div>
  );
}

export function Result() {
  const snap = useStore(s => s.snapshot);
  const names = useStore(s => s.names);
  const me = useStore(s => s.me);
  const cfg = useMapConfig();
  const selectedSeat = useStore(s => s.selectedSeat);
  const selectSeat = useStore(s => s.selectSeat);
  // the selection lives in the store: do not carry it over to another screen
  useEffect(() => () => selectSeat(null), [selectSeat]);

  const fills = useMemo(() => {
    const f: Record<SeatId, string> = {};
    if (snap) for (const d of Object.values(snap.seats)) f[d.seat] = colourHex(snap.players.find(p => p.playerId === d.playerId)?.party?.colour);
    return f;
  }, [snap]);

  const r = snap?.result;
  if (!snap || !r) return <div className="page"><p className="hint">Waiting for the result…</p></div>;
  const gov = r.government;
  const iWon = !!me && r.winners.includes(me);
  const points = [...r.points].sort((a, b) => b.total - a.total);

  return (
    <>
    <SeatShareHint />
    <div className="page result">
      <div className={'banner ' + (iWon ? 'win' : 'neutral')}>
        <h2>{HEADLINE[r.outcome]}</h2>
        <p className="winners">
          {r.winners.length
            ? <>Winner{r.winners.length > 1 ? 's' : ''}: <PartyTags players={snap.players} ids={r.winners} size={34} />{iWon ? ' (you!)' : ''}</>
            : 'Nobody wins this time.'}
        </p>
      </div>

      <div className="grid-2 result-grid">
        <div className="result-map">
          <SeatMap names={names} fills={fills} selectedSeat={selectedSeat} onSeatClick={selectSeat} />
          {selectedSeat !== null && <SeatSharesModal seat={selectedSeat} onClose={() => selectSeat(null)} />}
        </div>
        <div>
          <Card title="Seats"><TallyBar snap={snap} /></Card>
          {gov && (
            <Card title={gov.viaNegotiation ? 'Government (negotiated)' : 'Government (single-party majority)'}>
              <ul className="plain">
                {cfg.points.portfolios.filter(p => gov.portfolios[p.id]?.length).map(p => (
                  <li key={p.id}>{p.label}: <b>{gov.portfolios[p.id].map(id => playerName(snap.players, id)).join(', ')}</b></li>
                ))}
              </ul>
              <p className="hint gov-members">Parties in government: <PartyTags players={snap.players} ids={gov.members} size={26} /></p>
            </Card>
          )}
        </div>
      </div>

      <Card title="Points">
        <div className="table-wrap">
          <table className="points">
            <thead><tr><th>Party</th><th>Seats</th><th>Portfolio</th><th>Seats pts</th><th>Floor</th><th>Total</th></tr></thead>
            <tbody>
              {points.map(p => {
                const pl = snap.players.find(x => x.playerId === p.playerId);
                return (
                  <tr key={p.playerId} className={r.winners.includes(p.playerId) ? 'winner' : ''}>
                    <td><PartyBadge party={pl?.party} kind={pl?.kind} size={36} /></td>
                    <td>{r.tally[p.playerId] ?? 0}</td>
                    <td>{p.portfolioPoints}</td>
                    <td>{p.seatPoints}</td>
                    <td>{p.governmentFloor}</td>
                    <td><b>{p.total}</b></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="actions">
        {snap.status === 'finished' && !isTour && <PlayAgain phases={snap.phases} />}
        <button className={'btn ' + (snap.status === 'finished' && !isTour ? 'ghost' : 'primary')} onClick={() => leaveGame()}>Back to start</button>
      </div>
    </div>
    </>
  );
}
