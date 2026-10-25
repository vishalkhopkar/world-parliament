// Sharing a game: copy to clipboard (works on phones too) and the invite link that pre-fills the join code.

/** Copy text. Tries the async Clipboard API, then a hidden-textarea execCommand fallback (insecure http pages, iOS Safari). */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* denied or unsupported: use the fallback */ }
  return execCopy(text);
}

function execCopy(text: string): boolean {
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px'; // 16px stops iOS zooming in
  document.body.appendChild(el);
  try {
    el.focus();
    el.select();
    el.setSelectionRange(0, text.length); // iOS ignores select() alone
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(el);
  }
}

/** Invite link: this page with `?join=CODE`. `server` and `mock` are kept so a dev link reaches the same backend; `as` (per-tab session namespace) is not. */
export function buildJoinLink(code: string, loc: Location = location): string {
  const from = new URLSearchParams(loc.search);
  const q = new URLSearchParams({ join: code.trim().toUpperCase() });
  for (const k of ['server', 'mock']) if (from.has(k)) q.set(k, from.get(k) ?? '');
  return `${loc.origin}${loc.pathname}?${q.toString().replace(/mock=(&|$)/, 'mock$1')}`;
}

/** The join code in an invite link (`?join=CODE`), upper-cased; '' when absent or not a plausible code. */
export function joinCodeFromSearch(search: string = typeof location !== 'undefined' ? location.search : ''): string {
  const v = (new URLSearchParams(search).get('join') ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{4,8}$/.test(v) ? v : '';
}
