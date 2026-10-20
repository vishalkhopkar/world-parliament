import type { Rng } from './types';

/** xmur3 string hash -> 32-bit seed generator. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** sfc32 generator. */
function sfc32(a: number, b: number, c: number, d: number): Rng {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** Deterministic PRNG (xmur3 hash of the seed string -> sfc32). */
export function createRng(seed: string): Rng {
  const h = xmur3(seed);
  const rng = sfc32(h(), h(), h(), h());
  for (let i = 0; i < 12; i++) rng(); // warm up
  return rng;
}

/** Standard normal sample (Box-Muller) using the given rng. */
export function gaussian(rng: Rng): number {
  const u1 = 1 - rng(); // (0,1]
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
