// Starting the guided tour: straight into the practice game, no home screen, no lobby, nothing saved.
import { DEFAULT_MAP_ID } from '@hp/shared';
import { createGame } from '../net/client';
import { useStore } from '../state/store';
import { useTour } from './tourStore';

let starting: Promise<void> | null = null;

/** Creates the scripted practice game and switches the overlay on. Runs once per page (React StrictMode runs effects twice). */
export function startTourGame(): Promise<void> {
  starting ??= (async () => {
    await createGame('You', 1, DEFAULT_MAP_ID);
    if (useStore.getState().gameId) useTour.getState().begin();
  })();
  return starting;
}

/** Test hook: forget that the tour was started. */
export function resetTourBoot() { starting = null; }
