import { useEffect } from 'react';
import { selectIsAdmin, selectMapId, selectMe, useStore } from '../state/store';
import { manifestFor } from '../map/mapData';
import { useMapConfig } from '../state/mapConfig';
import { admit, refreshLobby, setAdmission, setPhases, start } from '../net/client';
import { AiBadge, Card, PartyBadge } from '../components/ui';
import './Lobby.css';

export function Lobby() {
  const lobby = useStore(s => s.lobby);
  const snap = useStore(s => s.snapshot);
  const me = useStore(selectMe);
  const isAdmin = useStore(selectIsAdmin);
  const joinCode = useStore(s => s.joinCode);
  const mapId = useStore(selectMapId);
  const map = mapId ? manifestFor(mapId) : undefined;
  const cfg = useMapConfig();
  const setPage = useStore(s => s.setLobbyPage);

  useEffect(() => {
    const h = setInterval(() => void refreshLobby(), 1500);
    return () => clearInterval(h);
  }, []);

  const players = snap?.players ?? lobby?.players ?? [];
  const active = players.filter(p => p.status === 'active');
  const pending = players.filter(p => p.status === 'pending');
  const canStart = active.length >= cfg.players.min && active.every(p => !!p.party?.avatar);
  const phases = lobby?.phases ?? snap?.phases ?? cfg.phases.default;
  const open = lobby?.admissionOpen ?? true;
  const iAmPending = me?.status === 'pending';

  return (
    <div className="page">
      <div className="grid-2 lobby-grid">
        <Card title="Join code">
          <div className="big-code">{joinCode ?? lobby?.joinCode}</div>
          <p className="hint">Share this code. Players ask to join and the admin lets them in.</p>
          <button className="btn ghost sm" onClick={() => void navigator.clipboard?.writeText(joinCode ?? '')}>Copy code</button>
        </Card>

        <Card title="Game settings">
          <p className="map-line">Map: <strong>{map?.name ?? mapId ?? '—'}</strong></p>
          <label className="field">Polling phases
            <select className="input" value={phases} disabled={!isAdmin} onChange={e => void setPhases(Number(e.target.value))}>
              {Array.from({ length: cfg.phases.max }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {isAdmin ? (
            <label className="toggle">
              <input type="checkbox" checked={open} onChange={e => void setAdmission(e.target.checked)} />
              <span>Accepting join requests</span>
            </label>
          ) : <p className="hint">Only the admin can change settings.</p>}
          <p className="hint">{cfg.players.min}-{cfg.players.max} players. {cfg.seatCount} seats.</p>
        </Card>
      </div>

      {isAdmin && pending.length > 0 && (
        <Card title={`Join requests (${pending.length})`} className="requests">
          {pending.map(p => (
            <div className="row" key={p.playerId}>
              <strong>{p.nickname}</strong>
              {p.kind === 'agent' && <AiBadge />}
              <span className="spacer" />
              <button className="btn primary sm" onClick={() => void admit(p.playerId, true)}>Admit</button>
              <button className="btn ghost sm" onClick={() => void admit(p.playerId, false)}>Deny</button>
            </div>
          ))}
        </Card>
      )}

      <Card title={`Players (${active.length}/${cfg.players.max})`}>
        {iAmPending && <p className="hint">Waiting for the admin to let you in…</p>}
        {active.map(p => (
          <div className="row" key={p.playerId}>
            {p.party ? <PartyBadge party={p.party} nickname={p.nickname} kind={p.kind} size={40} /> : <span><strong>{p.nickname}</strong>{p.kind === 'agent' && <> <AiBadge /></>} <small className="muted">choosing a party…</small></span>}
            <span className="spacer" />
            {p.isAdmin && <span className="chip">admin</span>}
            {p.playerId === me?.playerId && <span className="chip you">you</span>}
          </div>
        ))}
      </Card>

      <div className="actions">
        {!iAmPending && (
          <button className="btn" onClick={() => setPage('party')}>{me?.party ? 'Edit my party' : 'Set up my party'}</button>
        )}
        {isAdmin ? (
          <button className="btn primary" disabled={!canStart} onClick={() => void start()}>Start the campaign</button>
        ) : (
          <span className="hint">The admin starts the game once every player has a party and avatar.</span>
        )}
      </div>
      {isAdmin && !canStart && <p className="hint">Need at least {cfg.players.min} active players, all with a party and avatar.</p>}
    </div>
  );
}
