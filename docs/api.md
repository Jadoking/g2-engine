# API reference

g2-engine is not published to npm yet.
Clone the repository and import from `src/index.ts`, or copy `src/` into your project.
The Even Hub adapter has its own entry point, `src/adapters/evenhub.ts`, so code that never talks to the glasses does not load the SDK.

## Minimal example

This page draws a pulsing ring in one 288×144 tile in the middle of the screen.

```ts
import { waitForEvenAppBridge, CreateStartUpPageContainer } from '@evenrealities/even_hub_sdk';
import { Engine, FrameLoop } from './src/index.ts';
import { evenHubSink, imageContainers, serialQueue } from './src/adapters/evenhub.ts';

const tiles = [{ x: 144, y: 72, width: 288, height: 144 }];

const bridge = await waitForEvenAppBridge();
await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: tiles.length,
  imageObject: imageContainers(tiles),
}));

const engine = new Engine({ tiles, sink: evenHubSink(bridge, serialQueue()) });

new FrameLoop(engine, (surface, { time }) => {
  const radius = 40 + 20 * Math.sin(time * 2);
  surface.shade(tiles[0], (x, y) => {
    const d = Math.hypot(x - 288, y - 144);
    return Math.max(0, 1 - Math.abs(d - radius) / 4); // a 4 px soft ring
  });
}).start();
```

A real page also needs a container with `isEventCapture: 1` to receive input. The coin demo in `demos/coin/main.ts` shows a complete page with native text, input handling and a fallback for page reloads.

## Constants

| Name | Value | Meaning |
| --- | --- | --- |
| `SCREEN_WIDTH`, `SCREEN_HEIGHT` | 576, 288 | Display size in pixels. |
| `LEVELS` | 16 | Brightness levels. Quantized pixels are 0..15. |
| `MAX_IMAGE_TILES` | 4 | Image containers allowed on one page. |
| `TILE_MIN_SIZE` | 20 | Smallest tile width or height. |
| `TILE_MAX_WIDTH`, `TILE_MAX_HEIGHT` | 288, 144 | Largest tile size. |

## Surface

```ts
type Rect = { x: number; y: number; width: number; height: number };
type Shader = (x: number, y: number) => number;

class Surface {
  constructor(width: number, height: number);
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;   // row-major intensity, 0 is off and 1 is full brightness
  clear(intensity?: number): void;
  get(x: number, y: number): number;
  shade(rect: Rect, shader: Shader, samples?: number): void;
}
```

`shade` writes `shader(x, y)` into every pixel of `rect` that is on the surface.
Coordinates are continuous, and pixel centres are at `+0.5`.
`samples` (default 1) averages a `samples × samples` grid inside each pixel.
Values outside 0..1 are allowed in the surface and are clamped when quantized.

## quantize

```ts
type Dither = 'none' | 'bayer4';
type QuantizeOptions = { dither?: Dither; gamma?: number };

function quantize(surface: Surface, rect: Rect, options?: QuantizeOptions): Uint8Array;
```

Returns one byte per pixel of `rect`, row by row, each 0..15.
With `dither: 'none'` (the default), each pixel rounds to the nearest level.
With `'bayer4'`, a 4×4 ordered dither fixed to screen coordinates is applied.
`gamma` (default 1) applies `intensity^(1/gamma)` before quantizing.

## encodeGrayPng

```ts
type PngBitDepth = 4 | 8;
function encodeGrayPng(levels: Uint8Array, width: number, height: number, bitDepth?: PngBitDepth): Uint8Array;
function crc32(bytes: Uint8Array, start?: number, end?: number): number;
```

Encodes levels 0..15 as a grayscale PNG.
Bit depth 4 (the default) stores the levels directly.
Bit depth 8 stores `level × 17`.
The output is the same for the same input on every platform.
Throws a `RangeError` if `levels.length` is not `width × height`.

## validateTiles

```ts
function validateTiles(tiles: readonly Rect[]): void;
```

Throws a `RangeError` unless there are 1 to 4 tiles and every tile has integer coordinates, is 20..288 pixels wide and 20..144 pixels high, lies on the screen, and does not overlap another tile.
The `Engine` constructor calls this for you.

## Engine

```ts
type TileSink = (tileIndex: number, png: Uint8Array) => Promise<void>;
type EngineOptions = {
  tiles: readonly Rect[];
  sink: TileSink;
  dither?: Dither;        // default 'none'
  gamma?: number;         // default 1
  bitDepth?: PngBitDepth; // default 4
};
type PresentResult = { sentTiles: number; bytes: number };

class Engine {
  constructor(options: EngineOptions);
  readonly surface: Surface;    // 576×288
  readonly tiles: readonly Rect[];
  dither: Dither;
  gamma: number;
  bitDepth: PngBitDepth;
  present(): Promise<PresentResult>;
  invalidate(): void;
}
```

`present()` quantizes each tile and calls `sink` for each tile whose levels differ from the last levels the sink accepted.
Tiles are sent in order, one at a time.
If `sink` rejects, `present()` rejects with that error, and the failed tile and any tiles after it are sent again on the next call.
Calling `present()` while another call is still running throws.

`invalidate()` makes the next `present()` send every tile.
Call it after a page rebuild, a reconnect, or anything else that changes what the glasses show without going through the engine.

You can change `dither`, `gamma` and `bitDepth` between frames.
A change that alters the quantized pixels causes the affected tiles to be sent.

A `TileSink` can deliver tiles anywhere: the glasses, a file, a test double, or a network connection.
The engine never calls a sink again before the previous call has finished.

## FrameLoop

```ts
type FrameInfo = { frame: number; dt: number; time: number }; // dt and time in seconds
type FrameStats = { fps: number; renderMs: number; presentMs: number; tilesPerFrame: number; bytesPerFrame: number };
type FrameLoopOptions = {
  maxFps?: number;           // default 30
  statsIntervalMs?: number;  // default 1000
  onStats?: (stats: FrameStats) => void;
  onError?: (error: unknown) => void;
  now?: () => number;                     // milliseconds; default performance.now
  sleep?: (ms: number) => Promise<void>;  // default setTimeout
};

class FrameLoop {
  constructor(engine: Engine, draw: (surface: Surface, frame: FrameInfo) => void, options?: FrameLoopOptions);
  readonly isRunning: boolean;
  start(): void;
  stop(): Promise<void>;
}
```

Each frame calls `draw` with the time since the previous frame, then waits for `engine.present()`.
A frame never starts before the previous frame was delivered, so a slow link lowers the frame rate instead of building a queue.
If `present()` throws, `onError` receives the error and the loop waits 500 ms before the next frame.
`stop()` resolves after the current frame finishes.
`now` and `sleep` let tests run the loop on a fake clock.

## Even Hub adapter

Exported from `src/adapters/evenhub.ts`:

```ts
const FIRST_TILE_ID = 10;
type Serial = <T>(task: () => Promise<T>) => Promise<T>;

function serialQueue(): Serial;
function tileName(index: number): string; // 'g2e-tile-0', 'g2e-tile-1', ...
function imageContainers(tiles: readonly Rect[]): ImageContainerProperty[];
function evenHubSink(bridge: EvenAppBridge, serial: Serial): TileSink;
```

`imageContainers` creates one SDK image container per tile, with container IDs starting at 10 so they do not clash with your own text containers.
`evenHubSink` sends each tile with `bridge.updateImageRawData` and rejects if the result is not `success`.

`serialQueue` runs tasks one after another in call order, even if an earlier task failed.
Pass the same queue to the sink and to your other bridge calls, such as `textContainerUpgrade` or `rebuildPageContainer`, so that no two bridge calls overlap.
