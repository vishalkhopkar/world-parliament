import { useEffect, useState } from 'react';

const read = (q: string) => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q).matches : false);

/** Live result of a CSS media query (false where matchMedia is unavailable). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => read(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const on = () => setMatches(mql.matches);
    on();
    mql.addEventListener?.('change', on);
    return () => mql.removeEventListener?.('change', on);
  }, [query]);
  return matches;
}
