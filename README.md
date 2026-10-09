# g2-engine

Software raster engine for the Even Realities G2 display (576×288, 16 gray levels).

Draw into a float framebuffer, quantize to 16 levels, and send only the image tiles whose pixels changed.
The core (`src/`) has no SDK or DOM dependency and runs the same in Node and in the Even Hub WebView.
`src/adapters/evenhub.ts` is the only file that touches the Even Hub SDK.

## Layout

- `src/surface.ts`: float intensity framebuffer and supersampled per-pixel shaders.
- `src/quantize.ts`: 16-level quantizer with optional gamma and a screen-anchored Bayer 4×4 dither.
- `src/png.ts`: deterministic grayscale PNG encoder, 4- or 8-bit, with no canvas.
- `src/engine.ts`: tile validation against the SDK limits, dirty-tile diff, and the frame loop. The loop drops stale frames instead of queueing them.
- `src/adapters/evenhub.ts`: maps tiles to image containers and serializes bridge calls.
- `demos/coin/`: spinning-coin animation demo.

## Coin demo

```sh
npm install
npm run dev   # http://127.0.0.1:47846
evenhub-simulator http://127.0.0.1:47846/ --automation-port 47845
```

The coin is a ray-cast cylinder, leaned back 20°, with bump-mapped relief, a reeded edge and Phong highlights.

Glasses input:

- Click pauses the coin.
- Swipe up or down changes the spin speed.
- Double-click toggles dithering.
- Long press switches layout:
  - `large` uses 2 stacked tiles. These update one after another, so the coin can tear at the seam while it moves.
  - `small` uses 1 tile. It does not tear and sends half the bytes per frame.

The labels around the coin are native text containers.

## Checks

```sh
npm run check            # tsc + node --test
node scripts/coin-sheet.ts artifacts/coin-sheet.png
```
