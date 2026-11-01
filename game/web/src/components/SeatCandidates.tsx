// Who is fielded in a seat (public), used by the fielding panel and the campaign seat panel; and the stick figure outside the map.
import type { GameSnapshot, PlayerId, SeatId } from '@hp/shared';
import candidateFigureSvg from '../assets/candidate-figure.svg?raw';
import { partyOf, playerName } from '../lib';
import { candidatesIn } from '../lib/fielding';
import { PartyDot } from './ui';
import './seatCandidates.css';

export function SeatCandidates({ snap, seat, me, className }: { snap: GameSnapshot; seat: SeatId; me: PlayerId | null; className: string }) {
  const list = candidatesIn(snap, seat);
  return (
    <ul className={'seat-candidates-list ' + className}>
      {list.length === 0 && <li className="hint">No party has a candidate here.</li>}
      {list.map(c => (
        <li key={c.playerId} data-player={c.playerId}>
          <PartyDot party={partyOf(snap.players, c.playerId)} size={20} />
          <span className="scl-party">{playerName(snap.players, c.playerId)}{c.playerId === me ? ' (you)' : ''}</span>
          {c.name && <span className="scl-name">{c.name}</span>}
        </li>
      ))}
    </ul>
  );
}

/** The stick figure as a plain icon, in a party's colour. Static asset, so setting its markup is safe. */
export function CandidateIcon({ colour }: { colour: string }) {
  return <span className="candidate-icon" aria-hidden style={{ '--party-colour': colour } as React.CSSProperties} dangerouslySetInnerHTML={{ __html: candidateFigureSvg }} />;
}
