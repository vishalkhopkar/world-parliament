// The guided tour on top of the normal screens: a callout card anchored to a highlighted element, an optional dimmed
// backdrop with a cut-out, task steps that wait for what the player does, and Back / Next / Skip.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { leaveTour } from '../net/client';
import { useTour } from './tourStore';
import { makeCtx, visibleSteps } from './steps';
import type { TourStep } from './steps';
import { taskDone } from './tasks';
import { placeCallout, SHEET_MAX_WIDTH } from './placement';
import type { Box } from './placement';
import './tour.css';

/** Union of the on-screen boxes of every element the selectors match (null when none is on the page). */
function measure(selectors: string[] | undefined): Box | null {
  if (!selectors?.length) return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(el => {
      const q = el.getBoundingClientRect();
      if (q.width < 2 || q.height < 2) return;
      l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
    });
  }
  return Number.isFinite(l) ? { left: Math.round(l), top: Math.round(t), width: Math.round(r - l), height: Math.round(b - t) } : null;
}
const sameBox = (a: Box | null, b: Box | null) => (a === b) || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);

function useAnchorBox(selectors: string[] | undefined): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    const update = () => setBox(prev => { const n = measure(selectors); return sameBox(prev, n) ? prev : n; });
    update();
    const h = setInterval(update, 200);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { clearInterval(h); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [selectors]);
  return box;
}

const HEADER = ['.site-header'];

export function TourOverlay() {
  const active = useTour(s => s.active);
  const idx = useTour(s => s.step);
  const done = useTour(s => s.done);
  const paused = useTour(s => s.countPaused);
  const controls = useTour(s => s.controls);
  const snap = useStore(s => s.snapshot);
  const priv = useStore(s => s.priv);
  const me = useStore(s => s.me);
  const selectedSeat = useStore(s => s.selectedSeat);
  const repGain = useStore(s => s.repGain);
  const selectSeat = useStore(s => s.selectSeat);
  const cfg = useMapConfig();
  const playerCount = snap?.players.filter(p => p.status === 'active' || p.status === 'disconnected').length ?? 9;

  const steps = useMemo<TourStep[]>(
    () => visibleSteps(() => controls?.startCounting(), cfg, playerCount),
    [cfg, playerCount, controls],
  );
  const at = Math.min(idx, steps.length - 1);
  const step = steps[at];
  const goto = useTour.getState().goto;

  const ctx = makeCtx({ cfg, snap, priv, me, selectedSeat, repGain, selectSeat });

  // task steps: notice what the player does (sticky once done)
  useEffect(() => {
    if (!active || !step?.task) return;
    const id = step.task.id;
    const check = () => {
      const s = useStore.getState();
      if (taskDone(id, { selectedSeat: s.selectedSeat, priv: s.priv, snapshot: s.snapshot, error: s.error, now: Date.now() + s.clockOffset })) useTour.getState().markDone(id);
    };
    check();
    const h = setInterval(check, 250);
    return () => clearInterval(h);
  }, [active, step]);

  // the game moves the tour on: counting started, or the result is in
  const status = snap?.status;
  useEffect(() => {
    if (!active || !step) return;
    const first = (phase: TourStep['phase']) => steps.findIndex(s => s.phase === phase);
    if (status === 'finished' && step.phase !== 'result' && first('result') >= 0) goto(first('result'));
    else if ((status === 'counting' || status === 'postCounting') && step.phase === 'campaign' && first('counting') >= 0) goto(first('counting'));
  }, [active, status, step, steps, goto]);

  // a seat panel left open from the previous step would hide the map
  const lastAt = useRef(at);
  useEffect(() => {
    if (lastAt.current !== at) { lastAt.current = at; selectSeat(null); }
  }, [at, selectSeat]);

  const box = useAnchorBox(step?.anchor);
  const header = useAnchorBox(HEADER); // the click blocker leaves the header (Leave) usable
  // bring an off-screen anchor into view (phones: the map and the side panel stack)
  useEffect(() => {
    if (!step?.anchor) return;
    const el = document.querySelector(step.anchor[0]);
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const q = el.getBoundingClientRect();
    if (q.top < 0 || q.bottom > window.innerHeight + 4) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id]);

  const cardRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 340, h: 220 });
  useLayoutEffect(() => {
    const q = cardRef.current?.getBoundingClientRect();
    if (q && q.width > 0 && (Math.round(q.width) !== size.w || Math.round(q.height) !== size.h)) setSize({ w: Math.round(q.width), h: Math.round(q.height) });
  });

  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const next = useCallback(() => goto(Math.min(steps.length - 1, at + 1)), [goto, steps.length, at]);

  const sheet = view.w < SHEET_MAX_WIDTH;
  // phones: leave room under the page for the bottom sheet, so everything can be scrolled above it
  useEffect(() => {
    if (!active || !sheet) return;
    document.body.classList.add('tour-sheet');
    return () => document.body.classList.remove('tour-sheet');
  }, [active, sheet]);

  if (!active || !step) return null;

  const place = placeCallout(box, view, size, step.corner);
  const prev = steps[at - 1];
  const canBack = !!prev && prev.phase === step.phase;
  const taskDoneNow = !!step.task && !!done[step.task.id];
  const gated = (step.gate === 'paused' && !paused) || (step.gate === 'finished' && status !== 'finished');
  const pad = 6;

  return createPortal(
    <div className="tour-root" data-testid="tour-root">
      {step.block && <div className="tour-block" style={{ top: header ? header.top + header.height : 0 }} />}
      {step.dim && box && (
        <div className="tour-hole" style={{ left: box.left - pad, top: box.top - pad, width: box.width + 2 * pad, height: box.height + 2 * pad }} />
      )}
      {step.dim && !box && <div className="tour-dim" />}
      {!step.dim && box && (
        <div className="tour-ring" style={{ left: box.left - 3, top: box.top - 3, width: box.width + 6, height: box.height + 6 }} />
      )}
      <div
        ref={cardRef}
        className={'tour-card-pop ' + (place.mode === 'sheet' ? 'sheet' : 'float')}
        style={place.mode === 'float' ? { left: place.left, top: place.top } : undefined}
        role="dialog" aria-label="Guided tour" data-testid="tour-callout" data-step={step.id}
      >
        <div className="tour-head">
          <span className="tour-count" data-testid="tour-count">Step {at + 1} of {steps.length}</span>
          <button className="tour-skip" onClick={() => leaveTour()}>Skip tour</button>
        </div>
        <h3 className="tour-title">{step.title}</h3>
        <div className="tour-body">{step.body(ctx)}</div>
        {step.task && (
          <div className={'tour-task' + (taskDoneNow ? ' done' : '')} data-testid="tour-task">
            {taskDoneNow
              ? <><span className="tour-tick">&#10003;</span><div>{step.task.done(ctx)}</div></>
              : <><span className="tour-arrow">&#9654;</span><div>{step.task.hint(ctx)}</div></>}
          </div>
        )}
        {gated && <div className="tour-wait" data-testid="tour-wait">{step.gate === 'paused' ? 'The count is coming to its pause point…' : 'Waiting for the last seats…'}</div>}
        <div className="tour-actions">
          {canBack && <button className="btn ghost sm" onClick={() => goto(at - 1)}>Back</button>}
          <span className="spacer" />
          {step.task?.helper && !taskDoneNow && <button className="btn sm" onClick={() => step.task!.helper!.run(ctx)}>{step.task.helper.label}</button>}
          {step.final ? (
            <>
              <button className="btn ghost sm" onClick={() => window.location.reload()}>Restart tour</button>
              <button className="btn primary sm" onClick={() => leaveTour()}>Play a real game</button>
            </>
          ) : step.action ? (
            <button className="btn primary sm" onClick={() => { step.action!.run(); }}>{step.action.label}</button>
          ) : step.task && !taskDoneNow ? (
            <button className="btn ghost sm" onClick={next}>Skip this step</button>
          ) : (
            <button className="btn primary sm" disabled={gated} onClick={next}>Next</button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
