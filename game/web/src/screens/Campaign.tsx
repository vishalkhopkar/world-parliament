import { useCallback, useEffect, useMemo, useRef } from 'react';
import { SeatActionModal, ReportToast } from '../components/SeatActionModal';
import { useStore } from '../state/store';
import { SeatMap, type SeatMapHandle } from '../map/SeatMap';
import { AnalystShop, CampaignHud, MyActions } from '../components/campaign';
import { NewsTicker } from '../components/NewsTicker';
import './game.css';
import { colourHex, useSeatPhases, useServerNow } from '../lib';

export function Campaign() {
  const snap = useStore(s => s.snapshot);
  const priv = useStore(s => s.priv);
  const names = useStore(s => s.names);
  const selected = useStore(s => s.selectedSeat);
  const selectSeat = useStore(s => s.selectSeat);
  const pulseState = useStore(s => s.pulse);
  const polledSeats = useStore(s => s.polledSeats);
  const mapRef = useRef<SeatMapHandle>(null);
  const closeModal = useCallback(() => selectSeat(null), [selectSeat]);
  useEffect(() => () => selectSeat(null), [selectSeat]); // leaving the campaign screen clears the selection
  const now = useServerNow();
  const phaseOf = useSeatPhases(snap?.phases ?? 1);
  const pkg = useStore(s => s.gamePkg);
  const centres = useMemo(() => (pkg ? Object.fromEntries(pkg.seats.map(s => [s.id, [s.x, s.y] as [number, number]])) : undefined), [pkg]);

  // seats whose polling phase has closed (from the map package if present, else from phaseClosed messages)
  const polled = useMemo(() => {
    const s = new Set<number>(polledSeats);
    if (phaseOf && snap) phaseOf.forEach((ph, seat) => { if (snap.polledPhases.includes(ph) || (snap.timeline && snap.timeline.phaseCloses[ph] <= now)) s.add(seat); });
    return s;
    // `now` is intentionally coarse: recompute only when a phase boundary passes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polledSeats, phaseOf, snap?.polledPhases, snap?.timeline, snap && snap.timeline ? snap.timeline.phaseCloses.filter(c => c <= now).length : 0]);

  const pulse = useMemo(() => {
    if (!pulseState || !snap) return null;
    const p = snap.players.find(x => x.playerId === pulseState.playerId);
    return { seat: pulseState.seat, key: pulseState.key, colour: colourHex(p?.party?.colour) };
  }, [pulseState, snap]);

  if (!snap || !priv) return <div className="page"><p className="hint">Connecting…</p></div>;

  return (
    <div className="game">
      <CampaignHud snap={snap} priv={priv} now={now} />
      <div className="game-body">
        <div className="map-col">
          <SeatMap ref={mapRef} names={names} centres={centres} dimmed={polled} selectedSeat={selected} onSeatClick={selectSeat} pulse={pulse} />
          {selected != null && (
            <SeatActionModal seat={selected} snap={snap} priv={priv} now={now} phaseOf={phaseOf} polled={polled} onClose={closeModal} />
          )}
        </div>
        <aside className="side">
          <p className="hint">Click a seat to campaign there.</p>
          <AnalystShop snap={snap} priv={priv} now={now} />
          <ReportToast />
          <MyActions priv={priv} />
        </aside>
      </div>
      <NewsTicker onPick={s => { selectSeat(s); mapRef.current?.zoomToSeat(s); }} />
    </div>
  );
}
