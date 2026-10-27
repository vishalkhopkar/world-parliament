// State of the guided tour (?tour). Kept apart from the game store so the normal game never depends on it.
import { create } from 'zustand';

/** What the overlay can ask the tour transport to do. Registered by TourTransport. */
export interface TourControls {
  /** End the campaign and start the count (the count pauses by itself at the coalition point). */
  startCounting(): void;
}

interface TourState {
  /** The tour overlay is on (set once the practice game exists). */
  active: boolean;
  /** Index into the visible step list. */
  step: number;
  /** The campaign / counting clocks read 0:00 (a practice game has no running clock). */
  frozenClock: boolean;
  /** The scripted count has reached the coalition point and waits for a government. */
  countPaused: boolean;
  /** Tasks the player has completed (sticky, by task id). */
  done: Record<string, true>;
  controls: TourControls | null;
  // actions
  begin(): void;
  goto(i: number): void;
  markDone(id: string): void;
  setCountPaused(p: boolean): void;
  register(c: TourControls | null): void;
  reset(): void;
}

const initial = { active: false, step: 0, frozenClock: false, countPaused: false, done: {} as Record<string, true> };

export const useTour = create<TourState>((set) => ({
  ...initial,
  controls: null,
  begin: () => set({ ...initial, active: true, frozenClock: true }),
  goto: i => set({ step: Math.max(0, i) }),
  markDone: id => set(s => (s.done[id] ? s : { done: { ...s.done, [id]: true } })),
  setCountPaused: countPaused => set({ countPaused }),
  register: controls => set({ controls }),
  reset: () => set({ ...initial }),
}));
