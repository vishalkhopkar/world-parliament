import { useEffect, useMemo, useRef, useId } from 'react';
import type { NewsAgencyReport, PartyIdentity, PlayerPublic } from '@hp/shared';
import { useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { requestGlobalReports } from '../net/client';
import { colourHex } from '../lib';
import { nextNewsPollDelay, newsReportsFresh } from '../lib/newsPoll';
import { avatarById, avatarUrl, avatarVariantFor } from '../avatars';
import { chartScales, linePath, niceTicks, spreadLabels, timeTicks } from '../lib/lineChart';
import type { ChartBox } from '../lib/lineChart';
import { PartyAvatar, PartyLabel } from './ui';
import './globalReportsModal.css';

interface Props { onClose(): void }

const BOX: ChartBox = { width: 340, height: 210, left: 34, right: 20, top: 14, bottom: 26 };
const AV_R = 10;

/** "lo–hi" seat range of a party in one agency's latest report. */
export const rangeText = (r: [number, number] | undefined) => (r ? `${r[0]}–${r[1]}` : '–');

function AgencyChart({ agency, players, campaignStart, fallbackSpan }: { agency: NewsAgencyReport; players: PlayerPublic[]; campaignStart: number; fallbackSpan: number }) {
  const uid = useId().replace(/:/g, '');
  const { geo, ticksY, ticksX, lines } = useMemo(() => {
    const pts = agency.points;
    const t0 = campaignStart || pts[0]?.t || 0;
    const tLast = pts.length ? pts[pts.length - 1].t : t0;
    const t1 = tLast > t0 ? tLast : t0 + fallbackSpan;
    let vMax = 1;
    for (const p of pts) for (const v of Object.values(p.seats)) if (v > vMax) vMax = v;
    const ty = niceTicks(vMax, 4);
    const s = chartScales(t0, t1, ty[ty.length - 1], BOX);
    const ids = players.filter(pl => pl.party && pts.some(p => pl.playerId in p.seats)).map(pl => pl.playerId);
    const ends = ids.map(id => s.y(pts[pts.length - 1]?.seats[id] ?? 0));
    const spread = spreadLabels(ends, AV_R * 2 + 1, s.plot.y0, s.plot.y1);
    const ls = ids.map((id, i) => {
      const pl = players.find(x => x.playerId === id)!;
      const xy = pts.filter(p => id in p.seats).map(p => ({ x: s.x(p.t), y: s.y(p.seats[id]) }));
      const last = xy[xy.length - 1];
      return { id, party: pl.party as PartyIdentity, path: linePath(xy), cx: last ? last.x : s.plot.x0, cy: spread[i], ly: last ? last.y : spread[i] };
    });
    return { geo: s, ticksY: ty.map(v => ({ v, y: s.y(v) })), ticksX: timeTicks(t1 - t0, 4).map(k => ({ ...k, x: s.x(t0 + k.t) })), lines: ls };
  }, [agency, players, campaignStart, fallbackSpan]);

  return (
    <svg className="gr-chart" data-testid="gr-chart" viewBox={`0 0 ${BOX.width} ${BOX.height}`} role="img" aria-label={`${agency.name}: projected seats per party over time`}>
      {ticksY.map(k => (
        <g key={'y' + k.v}>
          <line className="gr-grid" x1={geo.plot.x0} x2={geo.plot.x1} y1={k.y} y2={k.y} />
          <text className="gr-tick" x={geo.plot.x0 - 4} y={k.y + 3} textAnchor="end">{k.v}</text>
        </g>
      ))}
      {ticksX.map(k => <text key={'x' + k.t} className="gr-tick" x={k.x} y={geo.plot.y1 + 14} textAnchor="middle">{k.label}</text>)}
      <line className="gr-axis" x1={geo.plot.x0} x2={geo.plot.x1} y1={geo.plot.y1} y2={geo.plot.y1} />
      <line className="gr-axis" x1={geo.plot.x0} x2={geo.plot.x0} y1={geo.plot.y0} y2={geo.plot.y1} />
      {lines.map(l => <path key={l.id} className="gr-line" d={l.path} stroke={colourHex(l.party.colour)} fill="none" />)}
      {lines.map(l => {
        const a = avatarById(l.party.avatar);
        const clip = `gr-clip-${uid}-${l.id}`;
        return (
          <g key={'a' + l.id} className="gr-av">
            {Math.abs(l.cy - l.ly) > 1 && <line className="gr-lead" x1={l.cx} y1={l.ly} x2={l.cx} y2={l.cy} stroke={colourHex(l.party.colour)} />}
            <clipPath id={clip}><circle cx={l.cx} cy={l.cy} r={AV_R} /></clipPath>
            {a
              ? <image href={avatarUrl(a.id, avatarVariantFor(AV_R * 2))} x={l.cx - AV_R} y={l.cy - AV_R} width={AV_R * 2} height={AV_R * 2} clipPath={`url(#${clip})`} preserveAspectRatio="xMidYMid slice" />
              : <circle cx={l.cx} cy={l.cy} r={AV_R} fill={colourHex(l.party.colour)} />}
            <circle cx={l.cx} cy={l.cy} r={AV_R} fill="none" stroke={colourHex(l.party.colour)} strokeWidth={2} />
          </g>
        );
      })}
    </svg>
  );
}

function RangeList({ agency, players }: { agency: NewsAgencyReport; players: PlayerPublic[] }) {
  const rows = useMemo(() => players
    .filter(p => p.party && agency.ranges[p.playerId])
    .map(p => ({ p, r: agency.ranges[p.playerId] }))
    .sort((a, b) => (b.r[0] + b.r[1]) - (a.r[0] + a.r[1])), [agency, players]);
  return (
    <ul className="gr-ranges">
      {rows.map(({ p, r }) => (
        <li key={p.playerId} className="gr-range">
          <PartyAvatar party={p.party} size={22} />
          <PartyLabel party={p.party} fallback={p.nickname} />
          <span className="gr-range-val">{rangeText(r)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Popup with the news agencies' global reports: one card per agency (line chart of projected seats per party + the seat ranges).
 * Requests the data on open and again just after every sample-grid time (campaignStart + k x interval, server time) while open, up to
 * the campaign end (see lib/newsPoll.ts).
 */
export function GlobalReportsModal({ onClose }: Props) {
  const reports = useStore(s => s.globalReports);
  const players = useStore(s => s.snapshot?.players);
  const timeline = useStore(s => s.snapshot?.timeline);
  const cfg = useMapConfig();
  const cardRef = useRef<HTMLDivElement>(null);
  const interval = reports?.sampleIntervalMs ?? cfg.news.sampleIntervalMs;
  // read when a poll is scheduled (not as render state), so the chain below never restarts and the modal does not re-render 4x a second
  const pollRef = useRef({ start: timeline?.campaignStart, end: timeline?.campaignEnd, interval });
  pollRef.current = { start: timeline?.campaignStart, end: timeline?.campaignEnd, interval };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { cardRef.current?.focus(); }, []);
  // Ask now, then just after every sample-grid time (campaignStart + k x interval, in server time) up to the campaign end, once more at
  // the end for the closing point; afterwards the series is frozen and the polling stops.
  useEffect(() => {
    let h: ReturnType<typeof setTimeout> | undefined;
    // The data only changes at grid times, so a request is skipped when the cached answer (kept in the store across closes) is current.
    const ask = () => {
      const p = pollRef.current;
      const st = useStore.getState();
      if (!newsReportsFresh(Date.now() + st.clockOffset, st.globalReports?.asOf, p.start, p.interval, p.end)) requestGlobalReports();
    };
    const schedule = () => {
      const p = pollRef.current;
      const delay = nextNewsPollDelay(Date.now() + useStore.getState().clockOffset, p.start, p.interval, p.end);
      if (delay === null) return;
      h = setTimeout(() => { ask(); schedule(); }, delay);
    };
    ask();
    schedule();
    return () => { if (h !== undefined) clearTimeout(h); };
  }, []);

  const list = useMemo(() => (players ?? []).filter(p => p.status !== 'pending' && p.status !== 'rejected'), [players]);

  return (
    <div className="gr-backdrop" onClick={onClose}>
      <div className="gr-card" ref={cardRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="News agencies" onClick={e => e.stopPropagation()}>
        <button className="gr-x" aria-label="Close" onClick={onClose}>×</button>
        <h3 className="gr-title">News agencies</h3>
        <p className="gr-sub">What the news agencies project: seats per party. Every agency is a little off, and less so as the campaign goes on.</p>
        {!reports ? <p className="gr-loading">Loading…</p> : !reports.agencies.length ? <p className="gr-loading">No reports yet.</p> : (
          <div className="gr-grid2">
            {reports.agencies.map(a => (
              <section key={a.id} className="gr-agency" data-testid="gr-agency">
                <h4 className="gr-agency-name">{a.name}</h4>
                <AgencyChart agency={a} players={list} campaignStart={timeline?.campaignStart ?? 0} fallbackSpan={reports.sampleIntervalMs} />
                <RangeList agency={a} players={list} />
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
