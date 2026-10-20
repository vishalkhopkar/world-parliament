import { createHash, randomBytes, randomInt as cryptoRandomInt } from 'node:crypto';
import { GameError } from './types';

export function newToken(): string { return randomBytes(32).toString('base64url'); }
export function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
let lastMs = 0;
let counter = 0;
/**
 * Time-sortable unique id: 9 base36 chars of epoch ms (monotonic) + 4 hex chars of a per-process counter + `bytes` random bytes (hex).
 * Ids created later sort later (lexicographically), including within the same millisecond.
 */
export function newId(bytes = 3): string {
  const ms = Math.max(Date.now(), lastMs);
  if (ms !== lastMs) { lastMs = ms; counter = 0; }
  counter = (counter + 1) & 0xffff;
  return ms.toString(36).padStart(9, '0') + counter.toString(16).padStart(4, '0') + randomBytes(bytes).toString('hex');
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newJoinCode(len = 6): string {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

export function cleanText(v: unknown, min: number, max: number, what: string): string {
  if (typeof v !== 'string') throw new GameError('BAD_REQUEST', `${what} must be text`);
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < min || t.length > max) throw new GameError('BAD_REQUEST', `${what} must be ${min}-${max} characters`);
  return t;
}

export function uniq<T>(xs: T[]): T[] { return [...new Set(xs)]; }

/** Uniform random integer in [0, max) from the OS CSPRNG. */
export function randomInt(max: number): number { return cryptoRandomInt(max); }
