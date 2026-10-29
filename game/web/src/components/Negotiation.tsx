import { useState } from 'react';
import { leavesPartyOut, majorityOf } from '@hp/shared';
import type { CoalitionOffer, GameSnapshot, PlayerId, PortfolioAssignment } from '@hp/shared';
import { useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { proposeGovernment, respondOffer, withdrawOffer } from '../net/client';
import { Card, PartyTags } from './ui';
import { ChatSection } from './ChatSection';
import './Negotiation.css';
import { playerName, seatCountOf } from '../lib';

// ---------------------------------------------------------------- offers
function seatsOf(snap: GameSnapshot, id: PlayerId) {
  return (snap.tally?.wins[id] ?? 0) + (snap.tally?.leads[id] ?? 0);
}

/** The party with the most seats (wins + leads) among the players still in the game, or undefined. */
function largestParty(snap: GameSnapshot): PlayerId | undefined {
  const live = snap.players.filter(p => p.status === 'active' || p.status === 'disconnected');
  let best: PlayerId | undefined;
  for (const p of live) if (best === undefined || seatsOf(snap, p.playerId) > seatsOf(snap, best)) best = p.playerId;
  return best;
}

function LargestLeftOut({ snap, members }: { snap: GameSnapshot; members: PlayerId[] }) {
  const big = largestParty(snap);
  if (!big || members.includes(big)) return null;
  return <div className="hint muted">Largest party {playerName(snap.players, big)} is left out of this offer</div>;
}

/** A government offer with its Accept / Decline / Withdraw buttons (shown inside the one-to-one chats). */
export function OfferView({ o, snap, me }: { o: CoalitionOffer; snap: GameSnapshot; me: PlayerId }) {
  const cfg = useMapConfig();
  const portfolios = cfg.points.portfolios;
  const members = [o.proposer, ...o.partners];
  const combined = members.reduce((s, id) => s + seatsOf(snap, id), 0);
  const maj = majorityOf(seatCountOf(snap.tally?.total, cfg.seatCount));
  const mineIncoming = o.proposer !== me;
  const iAccepted = o.accepted.includes(me);
  return (
    <div className={'offer ' + o.status}>
      <div className="offer-head">
        <strong>{mineIncoming ? `${playerName(snap.players, o.proposer)} proposes` : 'Your proposal'}</strong>
        <span className={'chip status ' + o.status}>{o.status}</span>
      </div>
      <ul className="plain">
        {portfolios.filter(p => o.portfolios[p.id]?.length).map(p => (
          <li key={p.id}>{p.label}: <b>{o.portfolios[p.id].map(id => playerName(snap.players, id)).join(', ')}</b> <small className="muted">({p.points} pts)</small></li>
        ))}
      </ul>
      <div className="hint">Seats {combined} / majority {maj}. Accepted: {o.accepted.length}/{o.partners.length}
        {o.accepted.length > 0 && <> ({o.accepted.map(id => playerName(snap.players, id)).join(', ')})</>}
      </div>
      {o.status === 'declined' && o.declinedBy && <div className="hint">Declined by {playerName(snap.players, o.declinedBy)}</div>}
      {o.status === 'superseded' && o.supersededBy && <div className="hint">Replaced by a newer offer</div>}
      <LargestLeftOut snap={snap} members={members} />
      {o.status === 'open' && mineIncoming && !iAccepted && (
        <div className="actions">
          <button className="btn primary sm" onClick={() => respondOffer(o.offerId, true)}>Accept</button>
          <button className="btn ghost sm" onClick={() => respondOffer(o.offerId, false)}>Decline</button>
        </div>
      )}
      {o.status === 'open' && mineIncoming && iAccepted && <div className="hint">You accepted. Waiting for the others.</div>}
      {o.status === 'accepted' && <div className="hint">Everyone accepted. The government is confirmed once ALL seats are declared, if its members hold a majority of WON seats.</div>}
      {(o.status === 'open' || o.status === 'accepted') && !mineIncoming && (
        <div className="actions"><button className="btn ghost sm" onClick={() => withdrawOffer(o.offerId)}>Withdraw</button></div>
      )}
    </div>
  );
}

function OfferBuilder({ snap, me }: { snap: GameSnapshot; me: PlayerId }) {
  const others = snap.players.filter(p => p.playerId !== me && (p.status === 'active' || p.status === 'disconnected'));
  const cfg = useMapConfig();
  const defs = cfg.points.portfolios.filter(p => p.id !== 'PM');
  // slots[portfolioId] = array of player ids ('' = nobody)
  const [slots, setSlots] = useState<Record<string, PlayerId[]>>({});
  const [extra, setExtra] = useState<PlayerId[]>([]);

  const set = (pid: string, i: number, v: PlayerId) => setSlots(s => {
    const arr = [...(s[pid] ?? [])]; arr[i] = v; return { ...s, [pid]: arr };
  });
  const portfolios: PortfolioAssignment = { PM: [me] };
  for (const d of defs) {
    const ids = [...new Set((slots[d.id] ?? []).filter(Boolean))].slice(0, d.max);
    if (ids.length) portfolios[d.id] = ids;
  }
  const partners = [...new Set([...Object.values(portfolios).flat(), ...extra])].filter(id => id !== me);
  const members = [me, ...partners];
  const total = seatCountOf(snap.tally?.total, cfg.seatCount);
  const maj = majorityOf(total);
  const combined = members.reduce((s, id) => s + seatsOf(snap, id), 0);
  const contenders = others.map(p => p.playerId);
  const everyoneIn = partners.length > 0 && !leavesPartyOut(members, [me, ...contenders]);
  const ok = partners.length > 0 && !everyoneIn && combined >= maj;

  return (
    <Card title="Propose a government (you are PM)" className="tour-offer-builder">
      <div className="portfolio-grid">
        {defs.map(d => (
          <div key={d.id} className="pf">
            <span>{d.label} <small className="muted">{d.points} pts{d.max > 1 ? `, up to ${d.max}` : ''}</small></span>
            <div className="pf-selects">
              {Array.from({ length: d.max }, (_, i) => (
                <select key={i} className="input sm" value={(slots[d.id] ?? [])[i] ?? ''} onChange={e => set(d.id, i, e.target.value)}>
                  <option value="">—</option>
                  {others.map(p => <option key={p.playerId} value={p.playerId}>{playerName(snap.players, p.playerId)}</option>)}
                </select>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="chips"><small className="muted">Also invite without a portfolio:</small>
        {others.filter(p => !partners.includes(p.playerId) || extra.includes(p.playerId)).map(p => (
          <button key={p.playerId} className={'chip btn-chip' + (extra.includes(p.playerId) ? ' on' : '')}
            onClick={() => setExtra(e => (e.includes(p.playerId) ? e.filter(x => x !== p.playerId) : [...e, p.playerId]))}>{playerName(snap.players, p.playerId)}</button>
        ))}
      </div>
      <div className={'combined' + (combined >= maj ? ' good' : '')}>
        Combined seats: <b>{combined}</b> / majority {maj}
        <small className="muted"> ({members.map(id => `${playerName(snap.players, id)} ${seatsOf(snap, id)}`).join(' + ')})</small>
      </div>
      <button className="btn primary" disabled={!ok} onClick={() => proposeGovernment(portfolios, extra)}>Send offer</button>
      <LargestLeftOut snap={snap} members={members} />
      {!ok && <p className="hint">{partners.length === 0 ? 'Add at least one partner.' : everyoneIn ? 'At least one party must stay out of the government.' : 'Not enough seats for a majority yet.'}</p>}
    </Card>
  );
}

export function Negotiation({ snap }: { snap: GameSnapshot }) {
  const me = useStore(s => s.me)!;
  const gov = snap.government;
  // Designer's rule: with 2 players (counting eliminated ones) there is no chat or coalition-building.
  if (snap.players.filter(p => p.status !== 'pending' && p.status !== 'rejected').length < 3) {
    return (
      <Card title="No coalition-building">
        <p className="hint">With 2 players there is no coalition-building: the party with a majority wins; an exact tie is a draw.</p>
      </Card>
    );
  }
  // Counting and post-counting are always one-to-one: the (private) offers appear inside those chats
  return (
    <>
      {gov && (
        <div className="banner gov">
          <strong>Government formed</strong>
          <div className="gov-line"><span>PM</span><PartyTags players={snap.players} ids={[gov.pm]} /></div>
          <div className="gov-line"><span>Parties</span><PartyTags players={snap.players} ids={gov.members} /></div>
        </div>
      )}
      <div data-tour="chat" className="chat-slot">
        <ChatSection snap={snap} me={me} mode="INDV" renderOffer={o => <OfferView o={o} snap={snap} me={me} />} />
      </div>
      {!gov && <OfferBuilder snap={snap} me={me} />}
    </>
  );
}
