import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

/** Largest font size in [min, max] (whole px) for which fits(size) is true; min if none does. */
export function fitFontSize(max: number, min: number, fits: (size: number) => boolean): number {
  for (let s = max; s > min; s--) if (fits(s)) return s;
  return min;
}

/**
 * Shrinks the text of `ref` (font-size, px) from max to min until it fits its box; below min the CSS (2 lines + ellipsis)
 * takes over. Re-fits when `text` changes. A no-op where layout is unavailable (jsdom).
 */
export function useFitText(ref: RefObject<HTMLElement>, text: string, max: number, min: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.fontSize = `${max}px`;
    if (!el.clientHeight && !el.clientWidth) return;
    const size = fitFontSize(max, min, s => {
      el.style.fontSize = `${s}px`;
      return el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;
    });
    el.style.fontSize = `${size}px`;
  }, [ref, text, max, min]);
}
