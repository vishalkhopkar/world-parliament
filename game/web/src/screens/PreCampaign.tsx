// The pre-campaign: paint candidates onto seats on a desktop (tap a seat and use its panel on a phone), watch the rivals' counts and make informal alliances in the one-to-one chats.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { chatModeFor } from '@hp/shared';
import { useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { SeatMap } from '../map/SeatMap';
import { CampaignHud } from '../components/campaign';
import { ChatSection } from '../components/ChatSection';
import { EliminatedBanner, isEliminated } from '../components/EliminatedBanner';
import { FieldingPanel } from '../components/FieldingPanel';
import { CandidateIcon } from '../components/SeatCandidates';
import { fieldCandidates } from '../net/client';
import { colourHex, formatMoney, playerName, useSeatPhases, useServerNow } from '../lib';
import { FINE_POINTER, createStrokeBatcher } from '../lib/brush';
import { committedFills } from '../lib/committedShade';
import { candidateCounts, candidateRows, hasCandidate } from '../lib/fielding';
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
  const candidates = useMemo(() => (fielding && players ? candidateRows(fielding, players, me) : undefined), [fielding, players, me]);
  const counts = useMemo(() => candidateCounts(fielding ?? {}), [fielding]);
  const gains = useMemo(() => (fieldFx ? selectFieldSmoke(fieldFx, cost) : null), [fieldFx, cost]);

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

  if (!snap || !priv || !players) return <div className="page"><p className="hint">Connecting…</p></div>;

  const rows = players.filter(p => IN_GAME.has(p.status)).sort((a, b) => Number(b.playerId === me) - Number(a.playerId === me));
  const chatMode = chatModeFor(cfg, 'preCampaign');

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
            {' '}A party with no candidates when this phase ends is out of the election.
          </p>
          <div className="candidate-counts" data-tour="candidate-counts">
            <ul>
              {rows.map(p => (
                <li key={p.playerId} data-player={p.playerId}>
                  <CandidateIcon colour={colourHex(p.party?.colour)} />
                  <span className="cc-name">{playerName(players, p.playerId)}{p.playerId === me ? ' (you)' : ''}</span>
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
