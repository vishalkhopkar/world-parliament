import type { ComponentType, ReactNode } from 'react';
import { Anchor, Bell, Bot, BookOpen, Compass, Feather, Flame, Globe, KeyRound, Leaf, Mountain, Rocket, Scale, Star, Sun, TreePine, Umbrella } from 'lucide-react';
import type { LucideProps } from 'lucide-react';
import { PARTY_SYMBOLS } from '@hp/shared';
import type { PartyIdentity, PlayerKind, PlayerPublic } from '@hp/shared';
import { avatarById, avatarUrl, avatarVariantFor } from '../avatars';
import { colourHex } from '../lib';
import './ui.css';

const ICONS: Record<string, ComponentType<LucideProps>> = {
  Anchor, KeyRound, Globe, Leaf, Mountain, Scale, Flame, Sun, Star, TreePine, Bell, BookOpen, Umbrella, Feather, Compass, Rocket,
};

export function SymbolIcon({ symbol, size = 16 }: { symbol?: string; size?: number }) {
  const def = PARTY_SYMBOLS.find(s => s.id === symbol);
  const Icon = (def && ICONS[def.icon]) || Star;
  return <Icon size={size} strokeWidth={2.2} aria-hidden />;
}

export { avatarVariantFor };

function PartySymbolDot({ party, size = 22 }: { party?: PartyIdentity; size?: number }) {
  return (
    <span className="party-dot" style={{ '--party-colour': colourHex(party?.colour), '--dot-size': `${size}px` } as React.CSSProperties}>
      <SymbolIcon symbol={party?.symbol} size={Math.round(size * 0.62)} />
    </span>
  );
}

/**
 * A party's face: its avatar (round, party-colour ring; thumbnail up to 64 css px, full image above) or, for players
 * without an avatar (old games), the party symbol on a coloured dot.
 */
export function PartyAvatar({ party, size = 22 }: { party?: PartyIdentity; size?: number }) {
  const a = avatarById(party?.avatar);
  if (!a) return <PartySymbolDot party={party} size={size} />;
  return (
    <span className="party-avatar" style={{ '--party-colour': colourHex(party?.colour), '--dot-size': `${size}px` } as React.CSSProperties}>
      <img src={avatarUrl(a.id, avatarVariantFor(size))} alt={a.label} loading="lazy" decoding="async" width={size} height={size} />
    </span>
  );
}
/** Same thing under its old name: every list that showed a dot now shows the avatar. */
export const PartyDot = PartyAvatar;

/** Robot badge for AI players (PlayerPublic.kind === 'agent'). */
export function AiBadge() {
  return <span className="ai-badge" title="AI player"><Bot size={12} strokeWidth={2.4} aria-hidden />AI</span>;
}

export function PartyBadge({ party, nickname, kind, size = 22 }: { party?: PartyIdentity; nickname?: string; kind?: PlayerKind; size?: number }) {
  return (
    <span className="party-badge">
      <PartyAvatar party={party} size={size} />
      <span className="pb-text">
        <strong>{party?.name ?? nickname ?? '—'}</strong>
        {party && nickname ? <small>{nickname}</small> : null}
      </span>
      {kind === 'agent' && <AiBadge />}
    </span>
  );
}

/** A row of parties (avatar + name, AI badge for agents) for a list of player ids, e.g. the members of a government. */
export function PartyTags({ players, ids, size = 28 }: { players: PlayerPublic[]; ids: string[]; size?: number }) {
  return (
    <span className="party-tags">
      {ids.map(id => {
        const p = players.find(x => x.playerId === id);
        return <PartyBadge key={id} party={p?.party} nickname={p?.party ? undefined : p?.nickname} kind={p?.kind} size={size} />;
      })}
    </span>
  );
}

export function Emblem({ size = 40 }: { size?: number }) {
  return (
    <svg className="emblem" width={size} height={size} viewBox="-50 -50 100 100" aria-hidden focusable="false">
      <g fill="none" stroke="#d9b24c" strokeLinecap="round">
        <circle r="46" strokeWidth="5" />
        <circle r="9" strokeWidth="3" />
        <g strokeWidth="2.4">
          {Array.from({ length: 12 }, (_, i) => <line key={i} x1="0" y1="-44" x2="0" y2="44" transform={`rotate(${i * 15})`} />)}
        </g>
      </g>
      <circle r="4" fill="#d9b24c" />
    </svg>
  );
}

export function Card({ title, children, className = '', right }: { title?: string; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <section className={'card ' + className}>
      {title && <h3 className="card-title"><span>{title}</span>{right}</h3>}
      {children}
    </section>
  );
}
