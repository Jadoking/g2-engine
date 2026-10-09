import type { Rect, Surface } from './surface.ts';

/** The G2 panel shows 16 brightness levels. */
export const LEVELS = 16;

export type Dither = 'none' | 'bayer4';

export type QuantizeOptions = {
  dither?: Dither;
  /** Applied as intensity^(1/gamma) before quantizing. Calibrate on hardware; 1 means no correction. */
  gamma?: number;
};

// 4x4 Bayer matrix. Thresholds are (value + 0.5) / 16, so a flat input of v
// produces levels whose block average is v (to within one level / 16).
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * Convert a surface region to levels 0..15 (one byte per pixel, row-major).
 * The dither pattern is anchored to screen coordinates, so neighbouring tiles line up.
 */
export function quantize(surface: Surface, rect: Rect, options: QuantizeOptions = {}): Uint8Array {
  const { dither = 'none', gamma = 1 } = options;
  const out = new Uint8Array(rect.width * rect.height);
  const max = LEVELS - 1;
  const inverseGamma = 1 / gamma;
  let i = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    const row = y * surface.width;
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      let v = surface.data[row + x];
      v = v <= 0 ? 0 : v >= 1 ? 1 : v;
      if (gamma !== 1) v = Math.pow(v, inverseGamma);
      v *= max;
      const level = dither === 'bayer4' ? Math.floor(v + (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16) : Math.round(v);
      out[i++] = level > max ? max : level;
    }
  }
  return out;
}
