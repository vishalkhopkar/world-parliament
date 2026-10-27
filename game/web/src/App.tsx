import { useEffect, useState } from 'react';
import { currentScreen, selectMapId, useStore } from './state/store';
import { loadGamePackage, loadSeatNames } from './map/mapData';
import { Emblem } from './components/ui';
import { Toast } from './components/Toast';
import { LinkBanner } from './components/LinkBanner';
import { useMapConfig } from './state/mapConfig';
import { Home } from './screens/Home';
import { Lobby } from './screens/Lobby';
import { PartySetup } from './screens/PartySetup';
import { Campaign } from './screens/Campaign';
import { Counting } from './screens/Counting';
import { Result } from './screens/Result';
import { isTour, leaveGame, reconnect, resumeSession } from './net/client';
import { startTourGame } from './tour/boot';
import { TourOverlay } from './tour/TourOverlay';
import './App.css';

let resuming: Promise<boolean> | null = null; // StrictMode runs effects twice in dev: resume only once

export function App() {
  const screen = useStore(s => currentScreen(s));
  const inGame = useStore(s => !!s.gameId);
  const joinCode = useStore(s => s.joinCode);
  const link = useStore(s => s.link);
  const cfg = useMapConfig();
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    if (isTour) { void startTourGame().finally(() => setBooting(false)); return; } // the tour never resumes a saved game
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
            {isTour ? <span className="code-chip tour-chip" title="Practice game">Guided tour</span> : joinCode && <span className="code-chip" title="Join code">{joinCode}</span>}
            <button className="btn ghost sm" onClick={() => leaveGame()}>Leave</button>
          </div>
        )}
      </header>
      {inGame && <LinkBanner link={link} retryMs={cfg.connection.retryMs} onReconnect={reconnect} />}
      <main className="main">
        {booting && screen === 'home' && <p className="hint">{isTour ? 'Setting up your practice election…' : 'Looking for your game…'}</p>}
        {!booting && screen === 'home' && !isTour && <Home />}
        {!booting && screen === 'home' && isTour && (
          <div className="page narrow tour-error">
            <h2>The tour could not start</h2>
            <p className="hint">The map did not load. Check your connection and try again.</p>
            <div className="actions"><button className="btn primary" onClick={() => window.location.reload()}>Try again</button><button className="btn ghost" onClick={() => leaveGame()}>Back to the home page</button></div>
          </div>
        )}
        {screen === 'lobby' && <Lobby />}
        {screen === 'party' && <PartySetup />}
        {screen === 'campaign' && <Campaign />}
        {screen === 'counting' && <Counting />}
        {screen === 'result' && <Result />}
      </main>
      <Toast />
      {isTour && inGame && <TourOverlay />}
    </div>
  );
}
