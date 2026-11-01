// The pre-campaign: paint candidates onto seats on a desktop (tap a seat and use its panel on a phone) or field every seat at once, press Done fielding (unless preCampaign.doneEnabled is off), watch the rivals' counts and make informal alliances in the one-to-one chats.
// The map shows only your own figures; the rivals appear as avatar + live count in the side panel.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Check } from 'lucide-react';
import { chatModeFor } from '@hp/shared';
import { useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { SeatMap } from '../map/SeatMap';
import { CampaignHud } from '../components/campaign';
import { ChatSection } from '../components/ChatSection';
import { EliminatedBanner, isEliminated } from '../components/EliminatedBanner';
import { FieldingPanel } from '../components/FieldingPanel';
import { PartyAvatar } from '../components/ui';
import { doneFielding, fieldCandidates } from '../net/client';
import { colourHex, formatMoney, playerName, useSeatPhases, useServerNow } from '../lib';
import { FINE_POINTER, createStrokeBatcher } from '../lib/brush';
import { committedFills } from '../lib/committedShade';
import { candidateCounts, candidateRows, doneProgress, hasCandidate } from '../lib/fielding';
import { selectFieldSmoke } from '../lib/repSmoke';
import { useMediaQuery } from '../lib/useMediaQuery';
import './game.css';
import './preCampaign.css';

const IN_GAME = new Set(['active', 'disconnected', 'eliminated']);

export function PreCampaign() {
  const snap = useStore(s => s.snapshot);
  const priv = useStore(s => s.priv);
  const names = useStore(s => s.names);
  const me = useStore(s => s.me);
  const selected = useStore(s => s.selectedSeat);
  const selectSeat = useStore(s => s.selectSeat);
  const fieldFx = useStore(s => s.fieldFx);
  const pkg = useStore(s => s.gamePkg);
  const doneStats = useStore(s => s.doneStats);
  const pending = useStore(s => s.fieldPending);
  const cfg = useMapConfig();
  const now = useServerNow();
  const phaseOf = useSeatPhases(snap?.phases ?? 1);
  const fine = useMediaQuery(FINE_POINTER);
  const closePanel = useCallback(() => selectSeat(null), [selectSeat]);
  useEffect(() => () => selectSeat(null), [selectSeat]); // a seat picked here must not stay selected on the next screen

  const cost = cfg.costs.candidate;
  const symbol = cfg.currency.symbol;
  const centres = useMemo(() => (pkg ? Object.fromEntries(pkg.seats.map(s => [s.id, [s.x, s.y] as [number, number]])) : undefined), [pkg]);
  const fielding = snap?.fielding;
  const players = snap?.players;
  // only the own figures are drawn on the map; the seat panel still lists every party fielded in a seat
  const candidates = useMemo(() => {
    if (!fielding || !players) return undefined;
    const own = candidateRows(fielding, players, me);
    const out: typeof own = {};
    for (const [seat, row] of Object.entries(own)) { const mine = row.filter(c => c.id === me); if (mine.length) out[Number(seat)] = mine; }
    return out;
  }, [fielding, players, me]);
  const counts = useMemo(() => candidateCounts(fielding ?? {}), [fielding]);
  const gains = useMemo(() => (fieldFx && cfg.display.fieldingSmoke ? selectFieldSmoke(fieldFx, cost) : null), [fieldFx, cost, cfg.display.fieldingSmoke]);
  // the seats "Field all seats" would field: every seat of the map that is neither ours nor on its way
  const missing = useMemo(() => (pkg && fielding ? pkg.seats.map(s => s.id).filter(id => !pending.has(id) && !(fielding[id] ?? []).some(c => c.playerId === me)) : []), [pkg, fielding, pending, me]);

  // own committed voters, shaded as in the campaign
  const myColour = colourHex(players?.find(p => p.playerId === priv?.you)?.party?.colour);
  const committedFill = useMemo(() => {
    const all = committedFills(priv?.committed, myColour);
    return Object.keys(all).length ? all : undefined;
  }, [priv?.committed, myColour]);

  // the stroke: reads the store when it runs, so it always sees the newest budget and candidates
  const batcher = useRef(createStrokeBatcher({
    cost,
    available: () => { const s = useStore.getState(); return (s.priv?.budget ?? 0) - s.fieldPending.size * cost; },
    taken: seat => { const s = useStore.getState(); return s.fieldPending.has(seat) || (!!s.snapshot && hasCandidate(s.snapshot, seat, s.me)); },
    send: fieldCandidates,
    onBroke: () => useStore.getState().setError(`Not enough budget for another candidate (${formatMoney(cost, symbol)} each)`),
  }));
  useEffect(() => { const b = batcher.current; return () => b.dispose(); }, []);
  const out = !!snap && isEliminated(snap, me);
  const brush = useMemo(() => (out ? undefined : {
    radiusPx: cfg.display.brushRadiusPx,
    onPaint: (seats: number[]) => batcher.current.add(seats),
    onStrokeEnd: () => batcher.current.endStroke(),
  }), [out, cfg.display.brushRadiusPx]);

  const fieldAll = () => {
    const s = useStore.getState();
    const seats = missing;
    if (!seats.length) return;
    if ((s.priv?.budget ?? 0) - s.fieldPending.size * cost < seats.length * cost) {
      s.setError(`Not enough budget to field all ${seats.length} seats (${formatMoney(seats.length * cost, symbol)} needed)`);
      return;
    }
    fieldCandidates(seats);
  };

  if (!snap || !priv || !players) return <div className="page"><p className="hint">Connecting…</p></div>;

  const rows = players.filter(p => IN_GAME.has(p.status)).sort((a, b) => Number(b.playerId === me) - Number(a.playerId === me));
  const chatMode = chatModeFor(cfg, 'preCampaign');
  const iAmDone = !!me && snap.fieldingDone.includes(me);
  const noCandidates = (counts[me ?? ''] ?? 0) === 0;
  const progress = doneProgress(snap, doneStats);
  const doneOn = cfg.preCampaign.doneEnabled; // false = the Done fielding feature is switched off (no button, count or ticks; the phase always runs its full time)

  return (
    <div className="game">
      <CampaignHud snap={snap} priv={priv} now={now} />
      <EliminatedBanner snap={snap} priv={priv} />
      <div className="game-body">
        <div className="map-col" data-tour="map">
          <SeatMap names={names} centres={centres} fills={committedFill} fillStyle={committedFill ? 'committed' : undefined} candidates={candidates} selectedSeat={selected} onSeatClick={selectSeat} gains={gains} brush={brush} />
          {selected != null && <FieldingPanel seat={selected} phaseOf={phaseOf} onClose={closePanel} />}
        </div>
        <aside className="side" data-tour="side">
          <p className="hint precampaign-hint">
            {fine
              ? 'Drag across the map to field candidates. Right-drag, or hold Space and drag, to move the map. Click a seat to see who is fielded there or to withdraw.'
              : 'Tap a seat to field a candidate there, see who is fielded or withdraw.'}
            {' '}Field all seats puts a candidate in every seat you do not have yet.
            {doneOn && ' Press Done fielding when you are finished: the campaign starts as soon as everybody is done.'}
            {' '}A party with no candidates when this phase ends is out of the election.
          </p>
          {!out && (
            <div className="fp-actions">
              <div className="fp-buttons">
                <button type="button" className="btn fp-field-all" data-tour="field-all" disabled={!missing.length} onClick={fieldAll}>
                  Field all seats
                  {missing.length > 0 && <small>{missing.length} {missing.length === 1 ? 'seat' : 'seats'}, {formatMoney(missing.length * cost, symbol)}</small>}
                </button>
                {doneOn && <button type="button" className={`btn fp-done${iAmDone ? ' on' : ' primary'}`} data-tour="done-fielding" disabled={noCandidates && !iAmDone} aria-pressed={iAmDone} onClick={() => doneFielding(!iAmDone)}>
                  {iAmDone ? 'Not done yet' : 'Done fielding'}
                </button>}
              </div>
              {doneOn && noCandidates && !iAmDone && <p className="fp-done-reason">Field at least one candidate before you can say you are done.</p>}
              {doneOn && <p className="cc-done-count">{progress.doneCount} of {progress.needed} done</p>}
            </div>
          )}
          <div className="candidate-counts" data-tour="candidate-counts">
            <ul>
              {rows.map(p => (
                <li key={p.playerId} data-player={p.playerId}>
                  <PartyAvatar party={p.party} size={28} />
                  <span className="cc-name">{playerName(players, p.playerId)}{p.playerId === me ? ' (you)' : ''}</span>
                  {doneOn && <span className="cc-tick">{snap.fieldingDone.includes(p.playerId) && <Check className="cc-done" size={18} strokeWidth={3} aria-label="Done fielding" />}</span>}
                  <strong className="cc-count">{counts[p.playerId] ?? 0}</strong>
                </li>
              ))}
            </ul>
            <p className="cc-majority">Majority: <strong>{snap.majority}</strong> of {snap.contestedSeats} contested seats</p>
          </div>
          {chatMode && me && <div data-tour="precampaign-chat" className="chat-slot"><ChatSection snap={snap} me={me} mode={chatMode} /></div>}
        </aside>
      </div>
    </div>
  );
}
