import { useEffect, useMemo, useState } from 'react';
import { PARTY_COLOURS, majorityOf } from '@hp/shared';
import type { PartyIdentity, PlayerId, PlayerPublic, SeatId } from '@hp/shared';
import { useStore } from './state/store';

/** W₹ amounts: 1 crore = 10,000,000. */
export function formatMoney(n: number, currencySymbol: string): string {
  const cr = n / 10_000_000;
  const s = cr.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return `${currencySymbol} ${s} crore`;
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
export const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** PartyIdentity.colour may be a preset id or a hex string; always resolve to hex. */
export function colourHex(c: string | undefined): string {
  if (!c) return '#8a8676';
  return PARTY_COLOURS.find(x => x.id === c)?.hex ?? c;
}
export const sameColour = (a: string, b: string) => colourHex(a).toLowerCase() === colourHex(b).toLowerCase();

export function playerColour(players: PlayerPublic[], id: PlayerId): string {
  return colourHex(players.find(p => p.playerId === id)?.party?.colour);
}
export function playerName(players: PlayerPublic[], id: PlayerId): string {
  const p = players.find(x => x.playerId === id);
  return p ? (p.party?.name ?? p.nickname) : 'Unknown';
}
export const partyOf = (players: PlayerPublic[], id: PlayerId): PartyIdentity | undefined => players.find(p => p.playerId === id)?.party;

/** Server-synchronised clock, ticking 4x a second. */
export function useServerNow(intervalMs = 250): number {
  const offset = useStore(s => s.clockOffset);
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now() + offset), intervalMs);
    setNow(Date.now() + offset);
    return () => clearInterval(h);
  }, [offset, intervalMs]);
  return now;
}

/** seat -> phase index, from the map package (null when the package is missing). */
export function useSeatPhases(phases: number): Map<SeatId, number> | null {
  const pkg = useStore(s => s.gamePkg);
  return useMemo(() => {
    const groups = pkg?.phaseGroups[String(phases)];
    if (!groups) return null;
    const m = new Map<SeatId, number>();
    groups.forEach((g, i) => g.forEach(id => m.set(id, i)));
    return m;
  }, [pkg, phases]);
}

/** Seats in the game: the tally total once counting starts, else the map's seat count (`fallback`, from useMapConfig). */
export const seatCountOf = (total: number | undefined, fallback: number) => total ?? fallback;
export { majorityOf };

export function seatName(names: Record<SeatId, string>, id: SeatId): string {
  return names[id] ?? `Seat ${id}`;
}
