// Shown to a player who is out while the game runs: they keep reading and writing in the chat, and can no longer act.
import type { GameSnapshot, PlayerId, PrivateState } from '@hp/shared';
import { seatsOfParty } from '../lib/fielding';
import './eliminatedBanner.css';

export const isEliminated = (snap: GameSnapshot, me: PlayerId | null | undefined) => snap.players.find(p => p.playerId === me)?.status === 'eliminated';

export function EliminatedBanner({ snap, priv }: { snap: GameSnapshot; priv: PrivateState | null }) {
  if (!isEliminated(snap, priv?.you)) return null;
  // the candidates of a party that goes out later are removed too, so having campaigned tells the two cases apart
  const neverFielded = seatsOfParty(snap.fielding, priv?.you).size === 0 && !priv?.myActions.length;
  return (
    <div className="eliminated-banner" role="status" data-testid="eliminated-banner">
      <strong>{neverFielded ? "You fielded no candidates, so you're out of this election." : "You're out of this election."}</strong> You can still use the chat.
    </div>
  );
}
