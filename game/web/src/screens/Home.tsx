import { useState } from 'react';
import { DEFAULT_MAP_ID, MAP_MANIFESTS } from '@hp/shared';
import { createGame, isRemote, joinGame } from '../net/client';
import { Card } from '../components/ui';
import { MapChooser } from '../components/MapChooser';
import { mapConfigFor } from '../state/mapConfig';
import './Home.css';

export function Home() {
  const [nick, setNick] = useState('');
  const [phasesChoice, setPhases] = useState<number | null>(null);
  const [code, setCode] = useState('');
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
          <button className="btn primary" disabled={!nickOk || code.trim().length < 4 || busy} onClick={() => run(() => joinGame(code, nick.trim()))}>Ask to join</button>
        </Card>
      </div>
      {!isRemote && <p className="hint">Mock mode: no server yet. Bots play the other parties.</p>}
    </div>
  );
}
