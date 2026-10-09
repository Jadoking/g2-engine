// Render one full turn of the demo coin through the engine's quantizer and PNG
// encoder, one PNG per frame. These are the exact 16-level tiles the glasses get.
// Usage: node scripts/coin-frames.ts <outDir> [frames=40]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Surface, quantize, encodeGrayPng } from '../src/index.ts';
import { DEMO_COIN, coinBounds, coinShader } from '../demos/coin/coin.ts';

const outDir = process.argv[2];
const frames = Number(process.argv[3] ?? 40);
if (!outDir || !Number.isInteger(frames) || frames < 1) {
  console.error('usage: node scripts/coin-frames.ts <outDir> [frames=40]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const region = { x: 144, y: 0, width: 288, height: 288 }; // the two image tiles of the large layout
const surface = new Surface(576, 288);
const bounds = coinBounds(DEMO_COIN);
for (let i = 0; i < frames; i++) {
  surface.clear(0);
  surface.shade(bounds, coinShader(DEMO_COIN, (2 * Math.PI * i) / frames), 1);
  const levels = quantize(surface, region);
  writeFileSync(join(outDir, `coin-${String(i).padStart(3, '0')}.png`), encodeGrayPng(levels, region.width, region.height, 8));
}
console.log(`${frames} frames -> ${outDir}`);
