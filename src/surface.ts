/** Axis-aligned pixel rectangle in screen coordinates. */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Per-pixel program. Receives continuous screen coordinates (pixel centres sit
 * at +0.5) and returns display intensity: 0 is off, 1 is full brightness.
 */
export type Shader = (x: number, y: number) => number;

/** Floating-point intensity framebuffer. Quantization to 16 levels happens at present time. */
export class Surface {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Float32Array(width * height);
  }

  clear(intensity = 0): void {
    this.data.fill(intensity);
  }

  get(x: number, y: number): number {
    return this.data[y * this.width + x];
  }

  /** Evaluate `shader` for every pixel in `rect`, averaging `samples`×`samples` sub-pixel points. */
  shade(rect: Rect, shader: Shader, samples = 1): void {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(this.width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(this.height, Math.ceil(rect.y + rect.height));
    const step = 1 / samples;
    const weight = 1 / (samples * samples);
    for (let y = y0; y < y1; y++) {
      const row = y * this.width;
      for (let x = x0; x < x1; x++) {
        let sum = 0;
        for (let sy = 0; sy < samples; sy++) {
          for (let sx = 0; sx < samples; sx++) sum += shader(x + (sx + 0.5) * step, y + (sy + 0.5) * step);
        }
        this.data[row + x] = sum * weight;
      }
    }
  }
}
