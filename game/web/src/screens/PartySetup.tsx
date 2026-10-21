import { useState } from 'react';
import { PARTY_COLOURS, PARTY_SYMBOLS } from '@hp/shared';
import { selectMe, useStore } from '../state/store';
import { setParty } from '../net/client';
import { Card, PartyBadge, SymbolIcon } from '../components/ui';
import { AvatarPicker } from '../components/AvatarPicker';
import './PartySetup.css';
import { colourHex, sameColour } from '../lib';

export function PartySetup() {
  const snap = useStore(s => s.snapshot);
  const me = useStore(selectMe);
  const setPage = useStore(s => s.setLobbyPage);
  const others = (snap?.players ?? []).filter(p => p.playerId !== me?.playerId && p.party && p.status !== 'rejected');

  const [name, setName] = useState(me?.party?.name ?? '');
  const [colour, setColour] = useState(me?.party ? colourHex(me.party.colour) : '');
  const [symbol, setSymbol] = useState(me?.party?.symbol ?? '');
  const [avatar, setAvatar] = useState(me?.party?.avatar ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  const colourTaken = (hex: string) => others.some(p => sameColour(p.party!.colour, hex));
  const symbolTaken = (id: string) => others.some(p => p.party!.symbol === id);
  const avatarTaken = others.flatMap(p => (p.party!.avatar ? [p.party!.avatar] : []));
  const pick = <T,>(set: (v: T) => void) => (v: T) => { set(v); setProblem(null); };

  /** First thing missing, as a message for the player (null = good to save). */
  const validate = (): string | null => {
    if (name.trim().length < 2) return 'Give your party a name (at least 2 letters).';
    if (!colour) return 'Choose a colour.';
    if (!symbol) return 'Choose a symbol.';
    if (!avatar) return 'Choose an avatar.';
    return null;
  };

  const save = async () => {
    const msg = validate();
    setProblem(msg);
    if (msg) return;
    const r = await setParty({ name: name.trim(), colour, symbol, avatar });
    if (r) setPage('lobby');
  };

  return (
    <div className="page narrow">
      <Card title="Your party">
        <label className="field">Party name
          <input className="input" value={name} maxLength={30} placeholder="e.g. People's Front" onChange={e => pick(setName)(e.target.value)} />
        </label>

        <div className="field">Colour</div>
        <div className="swatches">
          {PARTY_COLOURS.map(c => {
            const taken = colourTaken(c.hex);
            return (
              <button key={c.id} type="button" className={'swatch' + (colour.toLowerCase() === c.hex.toLowerCase() ? ' on' : '')} disabled={taken}
                style={{ '--swatch-colour': c.hex } as React.CSSProperties} title={taken ? `${c.label} (taken)` : c.label} aria-label={c.label} onClick={() => pick(setColour)(c.hex)} />
            );
          })}
        </div>

        <div className="field">Symbol</div>
        <div className="symbols">
          {PARTY_SYMBOLS.map(s => {
            const taken = symbolTaken(s.id);
            return (
              <button key={s.id} type="button" className={'symbol' + (symbol === s.id ? ' on' : '')} disabled={taken}
                title={taken ? `${s.label} (taken)` : s.label} aria-label={s.label} onClick={() => pick(setSymbol)(s.id)}>
                <SymbolIcon symbol={s.id} size={22} />
              </button>
            );
          })}
        </div>

        <div className="field">Avatar</div>
        <AvatarPicker value={avatar} taken={avatarTaken} onChange={pick(setAvatar)} />

        <div className="preview">
          <span className="muted">Preview</span>
          <PartyBadge party={{ name: name.trim() || 'Your party', colour: colour || '#8a8676', symbol, avatar: avatar || undefined }} kind={me?.kind} size={56} />
        </div>
        {problem && <p className="form-error" role="alert">{problem}</p>}
        <div className="actions">
          <button className="btn ghost" onClick={() => setPage('lobby')}>Back</button>
          <button className="btn primary" onClick={() => void save()}>Save party</button>
        </div>
      </Card>
    </div>
  );
}
