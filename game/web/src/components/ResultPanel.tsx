import { useRef } from 'react';
import { SymbolIcon } from './ui';
import { PersonPlaceholder } from './PersonPlaceholder';
import { colourHex } from '../lib';
import { contrastText } from '../lib/textContrast';
import { useFitText } from '../lib/useFitText';
import type { PanelKind } from '../lib/resultFeed';
import './ResultPanel.css';

export interface ResultPanelProps {
  kind: PanelKind;
  candidate: string;
  party: { name: string; colour?: string; symbol?: string };
  constituency: string;
}

/** One flashing result card: kind strip, photo, candidate, party (on the party colour), constituency. */
export function ResultPanel({ kind, candidate, party, constituency }: ResultPanelProps) {
  const nameRef = useRef<HTMLDivElement>(null);
  const partyRef = useRef<HTMLDivElement>(null);
  const seatRef = useRef<HTMLDivElement>(null);
  const bg = colourHex(party.colour);
  const name = candidate.toUpperCase();
  useFitText(nameRef, name, 15, 10);
  useFitText(partyRef, party.name, 13, 9);
  useFitText(seatRef, constituency, 13, 9);
  return (
    <article className={`rp rp-${kind.toLowerCase()}`} data-kind={kind}>
      <header className="rp-head">{kind}</header>
      <PersonPlaceholder className="rp-photo" />
      <div className="rp-box rp-name"><div ref={nameRef} className="rp-text">{name}</div></div>
      <div className="rp-box rp-party" style={{ background: bg, color: contrastText(bg) }}>
        <div ref={partyRef} className="rp-text">{party.name}</div>
        <SymbolIcon symbol={party.symbol} size={16} className="rp-symbol" />
      </div>
      <div className="rp-box rp-seat"><div ref={seatRef} className="rp-text">{constituency}</div></div>
    </article>
  );
}
