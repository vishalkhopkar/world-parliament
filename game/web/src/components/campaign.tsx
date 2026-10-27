import { useMemo, useState } from 'react';
import type { AnalystReport, GameSnapshot, PlayerPublic, PrivateState, SeatId } from '@hp/shared';
import { useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { useTour } from '../tour/tourStore';
import { buyReport } from '../net/client';
import { Card, PartyAvatar, PartyLabel, PartyDot, SymbolIcon } from './ui';
import '../screens/game.css';
import './campaign.css';
import { colourHex, formatClock, formatMoney, formatTime, playerColour, playerName, seatName } from '../lib';

// ---------------------------------------------------------------- timers + budget
export function CampaignHud({ snap, priv, now }: { snap: GameSnapshot; priv: PrivateState; now: number }) {
  const cfg = useMapConfig();
  const t = snap.timeline;
  const phaseIdx = t ? t.phaseCloses.findIndex(c => c > now) : -1;
  const totalLeft = t ? t.campaignEnd - now : 0;
  const phaseLeft = t && phaseIdx >= 0 ? t.phaseCloses[phaseIdx] - now : 0;
  const startsIn = t ? t.campaignStart - now : 0;
  const mine = snap.players.find(p => p.playerId === priv.you);
  const frozen = useTour(s => s.frozenClock); // the guided tour has no running clock: both timers read 0:00
  const clock = (ms: number) => formatClock(frozen ? 0 : ms);
  return (
    <div className="hud">
      {mine?.party && (
        <div className="hud-item hud-me" title={mine.party.name} data-tour="hud-party">
          <PartyAvatar party={mine.party} size={44} />
          <span className="hud-me-text"><span>You lead</span><PartyLabel party={mine.party} /></span>
        </div>
      )}
      {startsIn > 0 && !frozen && <div className="hud-item"><span>Campaign starts in</span><strong>{formatClock(startsIn)}</strong></div>}
      <div className="hud-item" data-tour="hud-campaign"><span>Campaign ends in</span><strong>{clock(totalLeft)}</strong></div>
      <div className="hud-item" data-tour="hud-phase">
        <span>{phaseIdx >= 0 ? `Phase ${phaseIdx + 1} of ${snap.phases} polls in` : 'All phases polled'}</span>
        <strong>{phaseIdx >= 0 ? clock(phaseLeft) : '0:00'}</strong>
      </div>
      <div className="hud-item budget" data-tour="hud-budget"><span>Your budget</span><strong>{formatMoney(priv.budget, cfg.currency.symbol)}</strong></div>
    </div>
  );
}

// ---------------------------------------------------------------- analyst
function curvePrice(curve: { start: number; end: number }, snap: GameSnapshot, now: number) {
  const t = snap.timeline;
  if (!t) return curve.start;
  const f = Math.min(1, Math.max(0, (now - t.campaignStart) / (t.campaignEnd - t.campaignStart)));
  return Math.round(curve.start + (curve.end - curve.start) * f);
}

function ReportView({ r, players, names }: { r: AnalystReport; players: PlayerPublic[]; names: Record<SeatId, string> }) {
  const seat = r.scope === 'seat';
  const fmt = (v: number) => (seat ? `${(v * 100).toFixed(1)}%` : String(Math.round(v)));
  return (
    <div className="report">
      <div className="report-head">
        <strong>{seat ? seatName(names, r.seat!) : 'Global (seats)'}</strong>
        <small className="muted">as of {formatTime(r.asOf)}</small>
      </div>
      {r.entries.map(e => (
        <div className="report-row" key={e.playerId}>
          <span className="swatch-sm" style={{ '--party-colour': playerColour(players, e.playerId) } as React.CSSProperties} />
          <span className="rr-name">{playerName(players, e.playerId)}</span>
          <span className="rr-val">{fmt(e.estimate)} <small>± {fmt(e.margin)}</small></span>
        </div>
      ))}
    </div>
  );
}

export function AnalystShop({ snap, priv, now }: { snap: GameSnapshot; priv: PrivateState; now: number }) {
  const names = useStore(s => s.names);
  const cfg = useMapConfig();
  const globalPrice = curvePrice(cfg.analyst.globalReport, snap, now);
  const reports = useMemo(() => [...priv.myReports].sort((a, b) => b.purchasedAt - a.purchasedAt), [priv.myReports]);
  // Reports are switched off in the config: nothing to buy, so no card. (The seat report is bought from the seat panel.)
  if (!cfg.analyst.seatReport.enabled && !cfg.analyst.globalReport.enabled) return null;
  return (
    <Card title="Analyst">
      {cfg.analyst.globalReport.enabled && (
        <div className="actions">
          <button className="btn" disabled={priv.budget < globalPrice} onClick={() => buyReport('global')}>
            Global report ({formatMoney(globalPrice, cfg.currency.symbol)})
          </button>
        </div>
      )}
      <p className="hint">Reports describe the position {Math.round(cfg.analyst.delayMs / 1000)} s ago and are noisy. Prices rise as the campaign goes on.</p>
      {reports.length === 0 ? <p className="hint">No reports bought yet.</p> : reports.map(r => <ReportView key={r.purchasedAt + ':' + (r.seat ?? 'g')} r={r} players={snap.players} names={names} />)}
    </Card>
  );
}

// ---------------------------------------------------------------- my actions
export function MyActions({ priv }: { priv: PrivateState }) {
  const names = useStore(s => s.names);
  const list = [...priv.myActions].reverse();
  return (
    <Card title={`My actions (${list.length})`}>
      {list.length === 0 ? <p className="hint">Nothing yet.</p> : (
        <ul className="plain">
          {list.map((a, i) => (
            <li key={i}><strong>{a.type === 'rally' ? 'Rally' : 'Roadshow'}</strong> in {seatName(names, a.seat)} <small className="muted">{formatTime(a.ts)}</small></li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export { SymbolIcon };
