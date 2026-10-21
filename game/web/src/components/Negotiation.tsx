import { useMemo, useState } from 'react';
import { majorityOf } from '@hp/shared';
import type { CoalitionOffer, GameSnapshot, PlayerId, PortfolioAssignment } from '@hp/shared';
import { useStore } from '../state/store';
import { useMapConfig } from '../state/mapConfig';
import { chat, proposeGovernment, respondOffer, withdrawOffer } from '../net/client';
import { Card, PartyBadge, PartyTags } from './ui';
import './Negotiation.css';
import { formatTime, playerName, seatCountOf } from '../lib';

const key = (ids: PlayerId[]) => [...ids].sort().join('|');

// ---------------------------------------------------------------- chat
export function Chat({ snap, me }: { snap: GameSnapshot; me: PlayerId }) {
  const messages = useStore(s => s.chat);
  const others = snap.players.filter(p => p.playerId !== me && (p.status === 'active' || p.status === 'disconnected'));
  const [to, setTo] = useState<PlayerId[]>([]);
  const [text, setText] = useState('');

  const threads = useMemo(() => {
    const m = new Map<string, PlayerId[]>();
    for (const c of messages) { const parts = [...new Set([c.from, ...c.to])].filter(x => x !== me); m.set(key(parts), parts); }
    return [...m.values()];
  }, [messages, me]);

  const thread = messages.filter(c => key([...new Set([c.from, ...c.to])].filter(x => x !== me)) === key(to));
  const toggle = (id: PlayerId) => setTo(t => (t.includes(id) ? t.filter(x => x !== id) : [...t, id]));
  const label = (ids: PlayerId[]) => ids.map(id => playerName(snap.players, id)).join(', ');
  const send = () => { if (!text.trim() || !to.length) return; chat(to, text.trim()); setText(''); };

  return (
    <Card title="Private chat">
      <div className="chips">
        {others.map(p => (
          <button key={p.playerId} className={'chip btn-chip' + (to.includes(p.playerId) ? ' on' : '')} onClick={() => toggle(p.playerId)}>{playerName(snap.players, p.playerId)}</button>
        ))}
      </div>
      {threads.length > 0 && (
        <div className="chips threads"><small className="muted">Threads:</small>
          {threads.map(t => <button key={key(t)} className="chip btn-chip" onClick={() => setTo(t)}>{label(t)}</button>)}
        </div>
      )}
      <div className="chat-log">
        {to.length === 0 ? <p className="hint">Pick who to talk to. Only they will see it.</p> :
          thread.length === 0 ? <p className="hint">No messages with {label(to)} yet.</p> :
            thread.map(c => (
              <div key={c.id} className={'msg' + (c.from === me ? ' mine' : '')}>
                <small><b>{c.from === me ? 'You' : playerName(snap.players, c.from)}</b> · {formatTime(c.ts)}</small>
                <div>{c.text}</div>
              </div>
            ))}
      </div>
      <div className="row">
        <input className="input" value={text} placeholder={to.length ? `Message ${label(to)}` : 'Choose recipients first'} disabled={!to.length}
          onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send(); }} maxLength={500} />
        <button className="btn primary sm" disabled={!to.length || !text.trim()} onClick={send}>Send</button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- offers
function seatsOf(snap: GameSnapshot, id: PlayerId) {
  return (snap.tally?.wins[id] ?? 0) + (snap.tally?.leads[id] ?? 0);
}

function OfferView({ o, snap, me }: { o: CoalitionOffer; snap: GameSnapshot; me: PlayerId }) {
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
      {o.status === 'open' && mineIncoming && !iAccepted && (
        <div className="actions">
          <button className="btn primary sm" onClick={() => respondOffer(o.offerId, true)}>Accept</button>
          <button className="btn ghost sm" onClick={() => respondOffer(o.offerId, false)}>Decline</button>
        </div>
      )}
      {o.status === 'open' && mineIncoming && iAccepted && <div className="hint">You accepted. Waiting for the others.</div>}
      {o.status === 'accepted' && <div className="hint">Everyone accepted. The government is confirmed once its WON seats reach the majority.</div>}
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
  const ok = partners.length > 0 && combined >= maj;

  return (
    <Card title="Propose a government (you are PM)">
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
      {!ok && <p className="hint">{partners.length === 0 ? 'Add at least one partner.' : 'Not enough seats for a majority yet.'}</p>}
    </Card>
  );
}

export function Negotiation({ snap }: { snap: GameSnapshot }) {
  const me = useStore(s => s.me)!;
  const gov = snap.government;
  const offers = [...snap.offers].sort((a, b) => b.createdAt - a.createdAt);
  // Designer's rule: with 2 players (counting eliminated ones) there is no chat or coalition-building.
  if (snap.players.filter(p => p.status !== 'pending' && p.status !== 'rejected').length < 3) {
    return (
      <Card title="No coalition-building">
        <p className="hint">With 2 players there is no coalition-building: the party with a majority wins; an exact tie is a draw.</p>
      </Card>
    );
  }
  return (
    <>
      {gov && (
        <div className="banner gov">
          <strong>Government formed</strong>
          <div className="gov-line"><span>PM</span><PartyTags players={snap.players} ids={[gov.pm]} /></div>
          <div className="gov-line"><span>Parties</span><PartyTags players={snap.players} ids={gov.members} /></div>
        </div>
      )}
      {!gov && (
        <>
          <Card title="Parties">
            {snap.players.filter(p => p.status === 'active' || p.status === 'disconnected').map(p => (
              <div className="row" key={p.playerId}>
                <PartyBadge party={p.party} kind={p.kind} size={34} />
                <span className="spacer" />
                <b>{seatsOf(snap, p.playerId)}</b>
              </div>
            ))}
          </Card>
          <OfferBuilder snap={snap} me={me} />
        </>
      )}
      {offers.length > 0 && (
        <Card title="Offers">
          {offers.map(o => <OfferView key={o.offerId} o={o} snap={snap} me={me} />)}
        </Card>
      )}
      <Chat snap={snap} me={me} />
    </>
  );
}
