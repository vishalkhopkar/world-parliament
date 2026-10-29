// "@Party name" tags in the group chat. Pure functions: the server uses findMentions to fill ChatMessage.mentions,
// the web app uses the rest for the @ picker and to highlight tags.
import type { PlayerId } from '@hp/shared';

export interface Mentionable { id: PlayerId; name: string }
export interface TextPiece { text: string; mention?: PlayerId }

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

/** The party whose name starts at text[at] (just after an '@'), longest name first; null when none matches. */
function nameAt(text: string, at: number, people: readonly Mentionable[]): Mentionable | null {
  const lower = text.toLowerCase();
  let best: Mentionable | null = null;
  for (const p of people) {
    const n = p.name.trim();
    if (!n || (best && best.name.trim().length >= n.length)) continue;
    if (lower.startsWith(n.toLowerCase(), at) && !isWordChar(text[at + n.length])) best = p;
  }
  return best;
}

/** Walks every '@' that starts a word (start of text or after a non-word character) and reports the tag found there. */
function scan(text: string, people: readonly Mentionable[], onTag: (start: number, end: number, who: Mentionable) => void): void {
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (isWordChar(text[i - 1])) continue;
    const who = nameAt(text, i + 1, people);
    if (who) onTag(i, i + 1 + who.name.trim().length, who);
  }
}

/** Ids of the parties tagged with "@Name" (case-insensitive, whole names), in order of first appearance, without `self`. */
export function findMentions(text: string, people: readonly Mentionable[], self?: PlayerId): PlayerId[] {
  const out: PlayerId[] = [];
  scan(text, people, (_s, _e, who) => { if (who.id !== self && !out.includes(who.id)) out.push(who.id); });
  return out;
}

/** The text cut into plain pieces and tagged names. With `only`, just those ids are marked (what the server found). */
export function splitMentions(text: string, people: readonly Mentionable[], only?: readonly PlayerId[]): TextPiece[] {
  const out: TextPiece[] = [];
  let pos = 0;
  scan(text, people, (start, end, who) => {
    if (only && !only.includes(who.id)) return;
    if (start > pos) out.push({ text: text.slice(pos, start) });
    out.push({ text: text.slice(start, end), mention: who.id });
    pos = end;
  });
  if (pos < text.length || !out.length) out.push({ text: text.slice(pos) });
  return out;
}

/** While typing: the "@word" that ends at the caret (start = index of the '@'), or null. At most 4 spaces (party names). */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || isWordChar(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/[\n@]/.test(query) || (query.match(/ /g) ?? []).length > 4 || query.length > 40) return null;
  return { start: at, query };
}

/** Replaces text[start..caret) (the "@word" being typed) with "@Name " and returns the new text and caret. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const tag = `@${name}${after.startsWith(' ') ? '' : ' '}`;
  return { text: text.slice(0, start) + tag + after, caret: start + tag.length + (after.startsWith(' ') ? 1 : 0) };
}
