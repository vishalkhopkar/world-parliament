/** Black or white text, whichever reads better on a background colour (#rgb or #rrggbb; anything else -> white). */
export function contrastText(bg: string): '#000000' | '#ffffff' {
  let h = bg.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return '#ffffff';
  const lin = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  // contrast with white = 1.05 / (lum + .05); with black = (lum + .05) / .05; they are equal at lum ~ 0.179
  return lum > 0.179 ? '#000000' : '#ffffff';
}
