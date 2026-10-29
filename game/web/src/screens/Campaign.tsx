import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SeatActionModal, ReportToast } from '../components/SeatActionModal';
import { useStore } from '../state/store';
import { SeatMap, type SeatMapHandle } from '../map/SeatMap';
import { AnalystShop, CampaignHud, MyActions } from '../components/campaign';
import { NewsTicker } from '../components/NewsTicker';
import { ChatSection } from '../components/ChatSection';
import { GlobalReportsModal } from '../components/GlobalReportsModal';
import { useMapConfig } from '../state/mapConfig';
import { chatModeFor } from '@hp/shared';
import './game.css';
import { colourHex, useSeatPhases, useServerNow } from '../lib';
import { committedFills } from '../lib/committedShade';
import { selectSmoke } from '../lib/repSmoke';

export function Campaign() {
  const snap = useStore(s => s.snapshot);
  const priv = useStore(s => s.priv);
  const names = useStore(s => s.names);
  const me = useStore(s => s.me);
  const cfg = useMapConfig();
  const selected = useStore(s => s.selectedSeat);
  const selectSeat = useStore(s => s.selectSeat);
  const pulseState = useStore(s => s.pulse);
  const polledSeats = useStore(s => s.polledSeats);
  const [reportsOpen, setReportsOpen] = useState(false);
  const closeReports = useCallback(() => setReportsOpen(false), []);
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

  // polling phase currently open (0-based); -1 once every phase has polled
  const phaseIdx = snap?.timeline ? snap.timeline.phaseCloses.findIndex(c => c > now) : -1;
  const multiPhase = (snap?.phases ?? 1) > 1 && !!phaseOf;
  const [focusPhase, setFocusPhase] = useState(false);
  // faint phase number on every seat that has not polled yet
  const labels = useMemo(() => {
    if (!multiPhase || !phaseOf) return undefined;
    const out: Record<number, string> = {};
    phaseOf.forEach((ph, seat) => { if (!polled.has(seat)) out[seat] = String(ph + 1); });
    return out;
  }, [multiPhase, phaseOf, polled]);
  // "focus on this phase": everything not polled in the open phase is blurred out
  const blurred = useMemo(() => {
    if (!focusPhase || !multiPhase || !phaseOf || phaseIdx < 0) return undefined;
    const s = new Set<number>();
    phaseOf.forEach((ph, seat) => { if (ph !== phaseIdx) s.add(seat); });
    return s;
  }, [focusPhase, multiPhase, phaseOf, phaseIdx]);

  const repGain = useStore(s => s.repGain);
  const gains = useMemo(() => (repGain ? selectSmoke(repGain, pkg, cfg) : null), [repGain, pkg, cfg]);

  const pulse = useMemo(() => {
    if (!pulseState || !snap) return null;
    const p = snap.players.find(x => x.playerId === pulseState.playerId);
    return { seat: pulseState.seat, key: pulseState.key, colour: colourHex(p?.party?.colour) };
  }, [pulseState, snap]);

  // own committed voters: party colour, darker = stronger; polled seats are left out so they keep the polled hatch
  const myColour = colourHex(snap?.players.find(p => p.playerId === priv?.you)?.party?.colour);
  const committedFill = useMemo(() => {
    const all = committedFills(priv?.committed, myColour);
    for (const seat of polled) delete all[seat];
    return Object.keys(all).length ? all : undefined;
  }, [priv?.committed, myColour, polled]);

  // own reputation among swing voters: a badge on every seat (0 until something happens there), in the party colour
  const reputation = priv?.reputation;
  const badgeSeats = useMemo(() => (pkg ? pkg.seats.map(s => s.id) : Object.keys(reputation ?? {}).map(Number)), [pkg, reputation]);
  const badges = useMemo(() => {
    const out: Record<number, { text: string; colour: string }> = {};
    for (const id of badgeSeats) out[id] = { text: String(reputation?.[id] ?? 0), colour: myColour };
    return out;
  }, [badgeSeats, reputation, myColour]);

  if (!snap || !priv) return <div className="page"><p className="hint">Connecting…</p></div>;

  // Chat.Campaigning: GROUP / INDV chat from the campaign start, OFF = none until counting; never with fewer than 3 players
  const chatMode = snap.players.filter(p => p.status !== 'pending' && p.status !== 'rejected').length >= 3 ? chatModeFor(cfg, 'campaign') : null;

  return (
    <div className="game">
      <CampaignHud snap={snap} priv={priv} now={now} />
      <div className="game-body">
        <div className="map-col" data-tour="map">
          <SeatMap ref={mapRef} names={names} centres={centres} dimmed={polled} fills={committedFill} fillStyle={committedFill ? 'committed' : undefined} blurred={blurred} labels={labels} badges={badges} selectedSeat={selected} onSeatClick={selectSeat} pulse={pulse} gains={gains} />
          {selected != null && (
            <SeatActionModal seat={selected} snap={snap} priv={priv} now={now} phaseOf={phaseOf} polled={polled} onClose={closeModal} />
          )}
        </div>
        <aside className="side" data-tour="side">
          <p className="hint">Click a seat to campaign there.</p>
          {multiPhase && (
            <label className="phase-focus">
              <input type="checkbox" role="switch" checked={focusPhase} onChange={e => setFocusPhase(e.target.checked)} />
              <span className="phase-focus-track" aria-hidden />
              <span>{phaseIdx >= 0 ? `Focus on phase ${phaseIdx + 1} seats` : 'Focus on current phase'}</span>
            </label>
          )}
          {cfg.news.enabled && (
            <button type="button" className="btn global-reports-btn" data-tour="global-reports" onClick={() => setReportsOpen(true)}>News agencies</button>
          )}
          <AnalystShop snap={snap} priv={priv} now={now} />
          <ReportToast />
          <div data-tour="my-actions"><MyActions priv={priv} /></div>
          {chatMode && me && <div data-tour="chat" className="chat-slot"><ChatSection snap={snap} me={me} mode={chatMode} /></div>}
        </aside>
      </div>
      {reportsOpen && cfg.news.enabled && <GlobalReportsModal onClose={closeReports} />}
      <NewsTicker onPick={s => { selectSeat(s); mapRef.current?.zoomToSeat(s); }} />
    </div>
  );
}
