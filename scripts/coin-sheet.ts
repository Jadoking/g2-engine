// Offline render of the coin at several angles: contact sheet + per-frame timing.
// Usage: node scripts/coin-sheet.ts [out.png]
import { writeFileSync } from 'node:fs';
import { Surface, quantize, encodeGrayPng } from '../src/index.ts';
import { DEMO_COIN, coinBounds, coinShader } from '../demos/coin/coin.ts';

const COIN = DEMO_COIN;
const out = process.argv[2] ?? 'artifacts/coin-sheet.png';
const angles = [0, 20, 40, 60, 75, 88, 120, 160, 180, 200, 300, 320, 335, 345, 355];
const cell = { x: 144, y: 0, width: 288, height: 288 }; // the two image tiles
const cols = 5, rows = Math.ceil(angles.length / cols);
const sheet = new Uint8Array(cols * cell.width * rows * cell.height);
const surface = new Surface(576, 288);
const bounds = coinBounds(COIN);
const times: number[] = [];

angles.forEach((deg, i) => {
  surface.clear(0);
  surface.shade(bounds, coinShader(COIN, (deg * Math.PI) / 180), 1); // JIT warm-up
  const t0 = performance.now();
  surface.shade(bounds, coinShader(COIN, (deg * Math.PI) / 180), 1);
  const levels = quantize(surface, cell);
  times.push(performance.now() - t0);
  const ox = (i % cols) * cell.width, oy = Math.floor(i / cols) * cell.height;
  for (let y = 0; y < cell.height; y++) sheet.set(levels.subarray(y * cell.width, (y + 1) * cell.width), (oy + y) * cols * cell.width + ox);
});

writeFileSync(out, encodeGrayPng(sheet, cols * cell.width, rows * cell.height, 8));
const hist = new Array(16).fill(0);
for (const v of sheet) hist[v]++;
console.log(JSON.stringify({ out, angles, msPerFrame: times.map((t) => +t.toFixed(1)), levelsUsed: hist.filter((n) => n > 0).length }));
