import { Surface, type Rect } from './surface.ts';
import { quantize, type Dither } from './quantize.ts';
import { encodeGrayPng, type PngBitDepth } from './png.ts';

export const SCREEN_WIDTH = 576;
export const SCREEN_HEIGHT = 288;
/** Even Hub SDK 0.0.16 page limits for image containers. */
export const MAX_IMAGE_TILES = 4;
export const TILE_MIN_SIZE = 20;
export const TILE_MAX_WIDTH = 288;
export const TILE_MAX_HEIGHT = 144;

/** Throws if `tiles` cannot be mapped onto G2 image containers. */
export function validateTiles(tiles: readonly Rect[]): void {
  if (tiles.length === 0 || tiles.length > MAX_IMAGE_TILES) throw new RangeError(`need 1..${MAX_IMAGE_TILES} tiles, got ${tiles.length}`);
  tiles.forEach((t, i) => {
    if (![t.x, t.y, t.width, t.height].every(Number.isInteger)) throw new RangeError(`tile ${i} must use integer pixels`);
    if (t.width < TILE_MIN_SIZE || t.width > TILE_MAX_WIDTH || t.height < TILE_MIN_SIZE || t.height > TILE_MAX_HEIGHT) {
      throw new RangeError(`tile ${i} is ${t.width}x${t.height}; allowed ${TILE_MIN_SIZE}..${TILE_MAX_WIDTH} x ${TILE_MIN_SIZE}..${TILE_MAX_HEIGHT}`);
    }
    if (t.x < 0 || t.y < 0 || t.x + t.width > SCREEN_WIDTH || t.y + t.height > SCREEN_HEIGHT) throw new RangeError(`tile ${i} is off screen`);
    for (let j = 0; j < i; j++) {
      const o = tiles[j];
      if (t.x < o.x + o.width && o.x < t.x + t.width && t.y < o.y + o.height && o.y < t.y + t.height) throw new RangeError(`tiles ${j} and ${i} overlap`);
    }
  });
}

/** Delivers one encoded tile to the glasses. The engine never calls it concurrently. */
export type TileSink = (tileIndex: number, png: Uint8Array) => Promise<void>;

export type PresentResult = { sentTiles: number; bytes: number };

export type EngineOptions = {
  tiles: readonly Rect[];
  sink: TileSink;
  dither?: Dither;
  gamma?: number;
  bitDepth?: PngBitDepth;
};

function sameLevels(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Owns the framebuffer and the link to the glasses. Draw into `surface`, then
 * `present()`: each tile is quantized and only tiles whose 16-level pixels
 * differ from what the glasses already show are encoded and sent.
 */
export class Engine {
  readonly surface = new Surface(SCREEN_WIDTH, SCREEN_HEIGHT);
  readonly tiles: readonly Rect[];
  dither: Dither;
  gamma: number;
  bitDepth: PngBitDepth;
  private readonly sink: TileSink;
  private readonly shown: (Uint8Array | null)[];
  private presenting = false;

  constructor(options: EngineOptions) {
    validateTiles(options.tiles);
    this.tiles = options.tiles.map((t) => ({ ...t }));
    this.sink = options.sink;
    this.dither = options.dither ?? 'none';
    this.gamma = options.gamma ?? 1;
    this.bitDepth = options.bitDepth ?? 4;
    this.shown = this.tiles.map(() => null);
  }

  async present(): Promise<PresentResult> {
    if (this.presenting) throw new Error('present() is already running; await it first');
    this.presenting = true;
    let sentTiles = 0;
    let bytes = 0;
    try {
      for (let i = 0; i < this.tiles.length; i++) {
        const tile = this.tiles[i];
        const levels = quantize(this.surface, tile, { dither: this.dither, gamma: this.gamma });
        if (sameLevels(this.shown[i], levels)) continue;
        const png = encodeGrayPng(levels, tile.width, tile.height, this.bitDepth);
        await this.sink(i, png);
        this.shown[i] = levels; // only after the glasses accepted it
        sentTiles++;
        bytes += png.length;
      }
    } finally {
      this.presenting = false;
    }
    return { sentTiles, bytes };
  }

  /** Forget what the glasses show, so the next present() resends every tile (after a page rebuild or reconnect). */
  invalidate(): void {
    this.shown.fill(null);
  }
}

export type FrameInfo = { frame: number; dt: number; time: number };
export type FrameStats = { fps: number; renderMs: number; presentMs: number; tilesPerFrame: number; bytesPerFrame: number };

export type FrameLoopOptions = {
  maxFps?: number;
  statsIntervalMs?: number;
  onStats?: (stats: FrameStats) => void;
  onError?: (error: unknown) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Real-time animation driver. Each frame draws with the wall-clock delta, then
 * waits for present() to finish. A slow link therefore drops frames instead of
 * queueing them: the animation keeps its speed and the glasses always get the newest image.
 */
export class FrameLoop {
  private readonly engine: Engine;
  private readonly draw: (surface: Surface, frame: FrameInfo) => void;
  private readonly options: Required<Omit<FrameLoopOptions, 'onStats' | 'onError'>> & Pick<FrameLoopOptions, 'onStats' | 'onError'>;
  private running: Promise<void> | null = null;
  private stopping = false;

  constructor(engine: Engine, draw: (surface: Surface, frame: FrameInfo) => void, options: FrameLoopOptions = {}) {
    this.engine = engine;
    this.draw = draw;
    this.options = {
      maxFps: options.maxFps ?? 30,
      statsIntervalMs: options.statsIntervalMs ?? 1000,
      now: options.now ?? (() => performance.now()),
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      onStats: options.onStats,
      onError: options.onError,
    };
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.run().finally(() => {
      this.running = null;
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.running;
  }

  private async run(): Promise<void> {
    const { now, sleep, maxFps, statsIntervalMs, onStats, onError } = this.options;
    const minFrameMs = 1000 / maxFps;
    let frame = 0;
    let time = 0;
    let last = now();
    let windowStart = last;
    let frames = 0, renderMs = 0, presentMs = 0, tiles = 0, bytes = 0;
    while (!this.stopping) {
      const start = now();
      const dt = (start - last) / 1000;
      last = start;
      time += dt;
      try {
        this.draw(this.engine.surface, { frame, dt, time });
        const drawn = now();
        const result = await this.engine.present();
        const presented = now();
        frames++;
        renderMs += drawn - start;
        presentMs += presented - drawn;
        tiles += result.sentTiles;
        bytes += result.bytes;
      } catch (error) {
        onError?.(error);
        await sleep(500); // unsent tiles stay dirty and are retried next frame
      }
      frame++;
      const elapsedWindow = now() - windowStart;
      if (elapsedWindow >= statsIntervalMs && frames > 0) {
        onStats?.({
          fps: (frames * 1000) / elapsedWindow,
          renderMs: renderMs / frames,
          presentMs: presentMs / frames,
          tilesPerFrame: tiles / frames,
          bytesPerFrame: bytes / frames,
        });
        windowStart = now();
        frames = renderMs = presentMs = tiles = bytes = 0;
      }
      const spent = now() - start;
      await sleep(Math.max(0, minFrameMs - spent));
    }
  }
}
