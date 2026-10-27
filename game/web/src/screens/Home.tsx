import { useState } from 'react';
import { DEFAULT_MAP_ID, MAP_MANIFESTS } from '@hp/shared';
import { createGame, isRemote, joinGame } from '../net/client';
import { buildTourLink, joinCodeFromSearch } from '../net/share';
import { Card } from '../components/ui';
import { MapChooser } from '../components/MapChooser';
import { mapConfigFor } from '../state/mapConfig';
import './Home.css';

/** Remove ?join=… from the address bar once used, so a refresh doesn't reopen the invite. */
function dropJoinParam() {
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has('join')) return;
    u.searchParams.delete('join');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  } catch { /* ignore */ }
}

export function Home() {
  const [nick, setNick] = useState('');
  const [phasesChoice, setPhases] = useState<number | null>(null);
  const [invited] = useState(joinCodeFromSearch); // from an invite link (?join=CODE)
  const [code, setCode] = useState(invited);
  const [mapId, setMapId] = useState<string>(() => (MAP_MANIFESTS.some(m => m.id === DEFAULT_MAP_ID) ? DEFAULT_MAP_ID : MAP_MANIFESTS[0]?.id ?? DEFAULT_MAP_ID));
  const [busy, setBusy] = useState(false);
  // phase limits are per map: the chosen map's config (a stale choice is clamped when the map changes)
  const cfg = mapConfigFor(mapId);
  const phases = Math.min(cfg.phases.max, Math.max(cfg.phases.min, phasesChoice ?? cfg.phases.default));

  const run = async (f: () => Promise<unknown>) => { setBusy(true); try { await f(); } finally { setBusy(false); } };
  const nickOk = nick.trim().length >= 2;

  return (
    <div className="page narrow">
      <div className="hero">
        <h2>Win seats. Build a government.</h2>
        <p>
          The map is split into parliament seats. Rally, roadshow and spy on rivals during the
          campaign; then, if nobody has a majority, bargain for portfolios in the count.
        </p>
      </div>
      <div className="tour-card" data-testid="tour-card">
        <div>
          <strong>New here?</strong>
          <p>Take a short guided tour: a practice election where you rally, count the votes and build a coalition. No account, no nickname, nobody else needed.</p>
        </div>
        <button className="btn primary" onClick={() => window.open(buildTourLink(), '_blank')}>Take a tour</button>
      </div>
      {invited && (
        <p className="invite-banner" data-testid="invite-banner">
          You've been invited to game <strong>{invited}</strong>. Enter a nickname and tap Ask to join.
        </p>
      )}
      {MAP_MANIFESTS.length > 0 && <MapChooser maps={MAP_MANIFESTS} value={mapId} onChange={setMapId} />}
      <Card title="Your nickname">
        <input className="input" value={nick} maxLength={20} placeholder="e.g. Vishal" onChange={e => setNick(e.target.value)} />
      </Card>
      <div className="grid-2">
        <Card title="Create a game">
          <label className="field">Polling phases
            <select className="input" value={phases} onChange={e => setPhases(Number(e.target.value))}>
              {Array.from({ length: cfg.phases.max - cfg.phases.min + 1 }, (_, i) => i + cfg.phases.min).map(n => (
                <option key={n} value={n}>{n} phase{n > 1 ? 's' : ''}</option>
              ))}
            </select>
          </label>
          <button className="btn primary" disabled={!nickOk || busy} onClick={() => run(() => createGame(nick.trim(), phases, mapId))}>Create game</button>
        </Card>
        <Card title="Join a game">
          <label className="field">Join code
            <input className="input code-input" value={code} maxLength={8} placeholder="HP7K2Q" onChange={e => setCode(e.target.value.toUpperCase())} />
          </label>
          <button className="btn primary" disabled={!nickOk || code.trim().length < 4 || busy} onClick={() => run(async () => { await joinGame(code, nick.trim()); dropJoinParam(); })}>Ask to join</button>
        </Card>
      </div>
      {!isRemote && <p className="hint">Mock mode: no server yet. Bots play the other parties.</p>}
    </div>
  );
}
