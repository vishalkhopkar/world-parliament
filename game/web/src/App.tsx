import { useEffect, useState } from 'react';
import { currentScreen, selectMapId, useStore } from './state/store';
import { loadGamePackage, loadSeatNames } from './map/mapData';
import { Emblem } from './components/ui';
import { Toast } from './components/Toast';
import { Home } from './screens/Home';
import { Lobby } from './screens/Lobby';
import { PartySetup } from './screens/PartySetup';
import { Campaign } from './screens/Campaign';
import { Counting } from './screens/Counting';
import { Result } from './screens/Result';
import { leaveGame, resumeSession } from './net/client';
import './App.css';

let resuming: Promise<boolean> | null = null; // StrictMode runs effects twice in dev: resume only once

export function App() {
  const screen = useStore(s => currentScreen(s));
  const inGame = useStore(s => !!s.gameId);
  const joinCode = useStore(s => s.joinCode);
  const link = useStore(s => s.link);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    resuming ??= resumeSession();
    void resuming.finally(() => setBooting(false));
  }, []);

  // seat names + map package of the CURRENT game's map (reloaded if the game's map changes)
  const mapId = useStore(selectMapId);
  useEffect(() => {
    if (!mapId) return;
    let stale = false;
    void loadSeatNames(mapId).then(n => { if (!stale) useStore.getState().setNames(n); });
    void loadGamePackage(mapId).then(p => { if (!stale) useStore.getState().setGamePkg(p); });
    return () => { stale = true; };
  }, [mapId]);

  return (
    <div className={'app screen-' + screen}>
      <header className="site-header">
        <Emblem size={42} />
        <div className="titles">
          <h1>HUNG PARLIAMENT</h1>
          <p>Fight for the seats. Then fight over who governs.</p>
        </div>
        {inGame && (
          <div className="hdr-right">
            {joinCode && <span className="code-chip" title="Join code">{joinCode}</span>}
            <button className="btn ghost sm" onClick={() => leaveGame()}>Leave</button>
          </div>
        )}
      </header>
      {inGame && link !== 'open' && (
        <div className="link-banner" role="status">
          {link === 'down' ? 'Disconnected from the server. Reload the page to rejoin.' : 'Reconnecting to the server…'}
        </div>
      )}
      <main className="main">
        {booting && screen === 'home' && <p className="hint">Looking for your game…</p>}
        {!booting && screen === 'home' && <Home />}
        {screen === 'lobby' && <Lobby />}
        {screen === 'party' && <PartySetup />}
        {screen === 'campaign' && <Campaign />}
        {screen === 'counting' && <Counting />}
        {screen === 'result' && <Result />}
      </main>
      <Toast />
    </div>
  );
}
