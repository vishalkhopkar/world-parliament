// Name resolution: players (nickname / party name / id), seats (id / name), party options (colour / symbol / avatar).
// Everything is lenient (case, accents, dashes, unique prefixes) but never guesses when the answer is ambiguous.
import type { GameMapPackage, GameMapSeat, PlayerPublic, SeatId } from '@hp/shared';
import { AgentError } from './errors';

/** Lower-case, strip accents, unify dashes/punctuation to single spaces. */
export function norm(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‐-―−_\-–—]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// ------------------------------------------------------------------ players
export function resolvePlayer(players: PlayerPublic[], ref: unknown, me: string | null, opts: { allowSelf?: boolean } = {}): PlayerPublic {
  const raw = typeof ref === 'number' ? String(ref) : typeof ref === 'string' ? ref.trim() : '';
  if (!raw) throw new AgentError('UNKNOWN_PLAYER', 'Empty player reference.');
  const nr = norm(raw);
  if (nr === 'me' || nr === 'self' || nr === 'myself') {
    const mine = players.find((p) => p.playerId === me);
    if (mine) return mine;
  }
  const byId = players.find((p) => p.playerId === raw);
  if (byId) return byId;
  const eq = (get: (p: PlayerPublic) => string | undefined) => players.filter((p) => { const v = get(p); return v !== undefined && norm(v) === nr; });
  for (const get of [(p: PlayerPublic) => p.nickname, (p: PlayerPublic) => p.party?.name]) {
    const hits = eq(get);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw ambiguousPlayer(raw, hits);
  }
  const pref = players.filter((p) => norm(p.nickname).startsWith(nr) || (p.party && norm(p.party.name).startsWith(nr)));
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) throw ambiguousPlayer(raw, pref);
  throw new AgentError('UNKNOWN_PLAYER', `No player matches "${raw}". Players: ${players.map(describePlayer).join('; ') || '(none visible)'}.`);
}

export const describePlayer = (p: PlayerPublic): string => `${p.nickname}${p.party ? ` (party "${p.party.name}")` : ''}`;

function ambiguousPlayer(raw: string, hits: PlayerPublic[]): AgentError {
  return new AgentError('UNKNOWN_PLAYER', `"${raw}" is ambiguous: ${hits.map(describePlayer).join('; ')}. Use the exact nickname or the player id.`);
}

// ------------------------------------------------------------------ seats
export class SeatDirectory {
  private byId = new Map<SeatId, GameMapSeat>();
  private names: { seat: GameMapSeat; n: string }[];
  constructor(readonly pkg: GameMapPackage) {
    for (const s of pkg.seats) this.byId.set(s.id, s);
    this.names = pkg.seats.map((seat) => ({ seat, n: norm(seat.name) }));
  }
  get(id: SeatId): GameMapSeat | undefined { return this.byId.get(id); }
  name(id: SeatId): string { return this.byId.get(id)?.name ?? `Seat ${id}`; }
  all(): GameMapSeat[] { return this.pkg.seats; }

  /** Accepts a seat id (number or numeric string) or a seat name. */
  resolve(ref: unknown): GameMapSeat {
    if (typeof ref === 'number' && Number.isInteger(ref)) return this.must(ref);
    if (typeof ref !== 'string' || !ref.trim()) throw new AgentError('UNKNOWN_SEAT', `Invalid seat reference: ${JSON.stringify(ref)}.`);
    const raw = ref.trim();
    if (/^#?\d+$/.test(raw)) return this.must(Number(raw.replace('#', '')));
    const n = norm(raw);
    const exact = this.names.filter((x) => x.n === n);
    if (exact.length === 1) return exact[0].seat;
    if (exact.length > 1) throw ambiguousSeat(raw, exact.map((x) => x.seat));
    const pref = this.names.filter((x) => x.n.startsWith(n));
    if (pref.length === 1) return pref[0].seat;
    const sub = this.names.filter((x) => x.n.includes(n));
    if (pref.length === 0 && sub.length === 1) return sub[0].seat;
    const cand = pref.length ? pref : sub;
    if (cand.length > 1) throw ambiguousSeat(raw, cand.map((x) => x.seat));
    const near = this.suggest(n);
    throw new AgentError('UNKNOWN_SEAT', `No seat is named "${raw}".${near.length ? ` Did you mean: ${near.map((s) => `${s.name} (#${s.id})`).join(', ')}?` : ''}`);
  }

  private must(id: number): GameMapSeat {
    const s = this.byId.get(id);
    if (!s) throw new AgentError('UNKNOWN_SEAT', `There is no seat #${id} (valid ids: 1..${this.pkg.seatCount}).`);
    return s;
  }

  /** Substring search over names (accent/dash insensitive), best matches first. */
  search(query: string): GameMapSeat[] {
    const n = norm(query);
    if (!n) return this.pkg.seats;
    const toks = n.split(' ');
    return this.names
      .filter((x) => toks.every((t) => x.n.includes(t)))
      .sort((a, b) => Number(b.n.startsWith(n)) - Number(a.n.startsWith(n)) || a.n.length - b.n.length)
      .map((x) => x.seat);
  }

  private suggest(n: string): GameMapSeat[] {
    const toks = n.split(' ').filter((t) => t.length >= 3);
    const scored = this.names
      .map((x) => ({ seat: x.seat, score: toks.filter((t) => x.n.includes(t)).length * 10 - lev(x.n.slice(0, n.length + 2), n) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return scored.filter((s) => s.score > -4).map((s) => s.seat);
  }
}

function ambiguousSeat(raw: string, seats: GameMapSeat[]): AgentError {
  const shown = seats.slice(0, 8).map((s) => `${s.name} (#${s.id})`).join(', ');
  return new AgentError('UNKNOWN_SEAT', `"${raw}" matches several seats: ${shown}${seats.length > 8 ? ', ...' : ''}. Use the seat id.`);
}

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// ------------------------------------------------------------------ party options
export interface Option { id: string; label: string; hex?: string }

/** Match a colour by hex (with or without #), id or label. Returns the option (hex is the canonical value to send). */
export function resolveColour(options: { id: string; hex: string; label: string }[], ref: unknown): { id: string; hex: string; label: string } {
  const raw = typeof ref === 'string' ? ref.trim() : '';
  if (!raw) throw new AgentError('UNKNOWN_OPTION', 'A party colour is required.');
  const hex = raw.startsWith('#') ? raw.toLowerCase() : /^[0-9a-f]{6}$/i.test(raw) ? '#' + raw.toLowerCase() : null;
  const n = norm(raw);
  const hit = options.find((o) => (hex && o.hex.toLowerCase() === hex) || norm(o.id) === n || norm(o.label) === n);
  if (hit) return hit;
  throw new AgentError('UNKNOWN_OPTION', `Unknown colour "${raw}". Valid: ${options.map((o) => `${o.label} ${o.hex}`).join(', ')}.`);
}

export function resolveOption<T extends { id: string; label: string }>(options: T[], ref: unknown, what: string): T {
  const raw = typeof ref === 'string' ? ref.trim() : '';
  if (!raw) throw new AgentError('UNKNOWN_OPTION', `A party ${what} is required.`);
  const n = norm(raw);
  const hit = options.find((o) => norm(o.id) === n || norm(o.label) === n);
  if (hit) return hit;
  throw new AgentError('UNKNOWN_OPTION', `Unknown ${what} "${raw}". Valid: ${options.map((o) => `${o.label} (${o.id})`).join(', ')}.`);
}

/** Portfolio id from an id or label, case-insensitive ("pm", "Prime Minister", "home", "External Affairs"). */
export function resolvePortfolio(defs: { id: string; label: string }[], ref: string): string {
  const n = norm(ref);
  const hit = defs.find((d) => norm(d.id) === n || norm(d.label) === n);
  if (hit) return hit.id;
  throw new AgentError('INVALID_INPUT', `Unknown portfolio "${ref}". Valid: ${defs.map((d) => `${d.id} (${d.label})`).join(', ')}.`);
}
