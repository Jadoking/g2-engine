// Link probe: times updateImageRawData on real glasses for a grid of image sizes and
// contents, plus native text updates, and reports every sample as telemetry.
// Run it once per hardware/firmware/app combination; the medians say what frame rate
// an animation of a given size and kind can reach.
//
// Page: four image containers of different sizes across the top, one text container
// (status, receives input) across the bottom. Tap to run the probe again.
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  OsEventTypeList,
  type EvenAppBridge,
  type DeviceStatus,
} from '@evenrealities/even_hub_sdk';
import { Surface, quantize, encodeGrayPng, type Rect, type PngBitDepth } from '../../src/index.ts';
import { imageContainers, FIRST_TILE_ID, tileName } from '../../src/adapters/evenhub.ts';
import { DEMO_COIN, coinBounds, coinShader, type Coin } from '../coin/coin.ts';

// Areas 41472, 20736, 5184, 576 px: 1, 1/2, 1/8, 1/72 of a full tile.
const TILES: Rect[] = [
  { x: 0, y: 0, width: 288, height: 144 },
  { x: 288, y: 0, width: 144, height: 144 },
  { x: 432, y: 0, width: 72, height: 72 },
  { x: 504, y: 0, width: 24, height: 24 },
];
const STATUS = { id: 1, name: 'status' };

type Content = 'black' | 'flat' | 'coin' | 'coin-same' | 'noise';
type Case =
  | { kind: 'image'; name: string; tile: number; content: Content; bitDepth: PngBitDepth; gapMs: number }
  | { kind: 'text'; name: string };

const SAMPLES_PER_BLOCK = 4; // the first sample of each block is a warm-up and is not in the medians
const ROUNDS = 2; // round 2 runs the cases in reverse order, so drift over time shows up
const TIMEOUT_MS = 15000;

function buildCases(): Case[] {
  const cases: Case[] = [];
  TILES.forEach((t, tile) => {
    for (const content of ['black', 'flat', 'coin', 'noise'] as const) {
      cases.push({ kind: 'image', name: `${t.width}x${t.height} ${content}`, tile, content, bitDepth: 4, gapMs: 0 });
    }
  });
  cases.push({ kind: 'image', name: '288x144 coin-same', tile: 0, content: 'coin-same', bitDepth: 4, gapMs: 0 });
  cases.push({ kind: 'image', name: '288x144 coin 8-bit png', tile: 0, content: 'coin', bitDepth: 8, gapMs: 0 });
  cases.push({ kind: 'image', name: '288x144 coin gap400', tile: 0, content: 'coin', bitDepth: 4, gapMs: 400 });
  cases.push({ kind: 'image', name: '24x24 black gap400', tile: 3, content: 'black', bitDepth: 4, gapMs: 400 });
  cases.push({ kind: 'text', name: 'text update' });
  return cases;
}

const session = Math.random().toString(36).slice(2, 8);
const statusEl = document.getElementById('status')!;

function log(tag: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(tag, text);
  statusEl.textContent = `${tag} ${text}`;
  void fetch('telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, t: Date.now(), tag, value }),
    keepalive: true,
  }).catch(() => {});
}

addEventListener('error', (e) => log('PROBE_ERROR', String(e.error?.stack ?? e.message)));
addEventListener('unhandledrejection', (e) => log('PROBE_ERROR', String(e.reason?.stack ?? e.reason)));

function deviceStatus(status: DeviceStatus | undefined) {
  if (!status) return { status: null };
  const { connectType, batteryLevel, isCharging, isWearing, isInCase } = status;
  return { connectType, batteryLevel, isCharging, isWearing, isInCase };
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Levels 0..15 for one sample. Contents that change between samples change on every sample. */
function levelsFor(content: Content, width: number, height: number, sample: number): Uint8Array {
  const n = width * height;
  if (content === 'black') return new Uint8Array(n);
  if (content === 'flat') return new Uint8Array(n).fill(8);
  if (content === 'noise') {
    const rand = mulberry32(sample * 7919 + width);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 16);
    return out;
  }
  const radius = Math.floor(0.45 * Math.min(width, height));
  const coin: Coin = { ...DEMO_COIN, cx: width / 2, cy: height / 2, radius, halfThickness: Math.max(2, Math.round(radius * 0.07)) };
  const angle = content === 'coin-same' ? 0.6 : 0.6 + sample * 0.21;
  const surface = new Surface(width, height);
  surface.shade(coinBounds(coin), coinShader(coin, angle));
  return quantize(surface, { x: 0, y: 0, width, height });
}

function nonZero(levels: Uint8Array): number {
  let c = 0;
  for (const v of levels) if (v) c++;
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function timed<T>(call: () => Promise<T>): Promise<{ ms: number; result: T | 'timeout' }> {
  const start = performance.now();
  const result = await Promise.race([call(), sleep(TIMEOUT_MS).then(() => 'timeout' as const)]);
  return { ms: performance.now() - start, result };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function setStatus(bridge: EvenAppBridge, content: string): Promise<void> {
  await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: STATUS.id, containerName: STATUS.name, content }));
}

async function runProbe(bridge: EvenAppBridge): Promise<void> {
  const cases = buildCases();
  const samples = new Map<string, number[]>();
  const info = await bridge.getDeviceInfo().catch(() => null);
  log('PROBE_START', { cases: cases.length, rounds: ROUNDS, samplesPerBlock: SAMPLES_PER_BLOCK, ...deviceStatus(info?.status) });
  const started = performance.now();
  let step = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const order = round === 0 ? cases : [...cases].reverse();
    for (const c of order) {
      step++;
      await setStatus(bridge, `LINK PROBE  ${step}/${cases.length * ROUNDS}\n${c.name}\nkeep the glasses on and connected`);
      for (let i = 0; i < SAMPLES_PER_BLOCK; i++) {
        const sample = round * SAMPLES_PER_BLOCK + i;
        let ms: number;
        let ok: boolean | string;
        let detail: Record<string, unknown> = {};
        if (c.kind === 'text') {
          const content = `LINK PROBE  ${step}/${cases.length * ROUNDS}\ntext update sample ${sample}\n${'0123456789'.slice(0, (sample % 10) + 1)}`;
          const r = await timed(() => setStatus(bridge, content));
          ms = r.ms;
          ok = r.result === 'timeout' ? 'timeout' : true;
          detail = { chars: content.length };
        } else {
          const t = TILES[c.tile];
          const levels = levelsFor(c.content, t.width, t.height, sample);
          const png = encodeGrayPng(levels, t.width, t.height, c.bitDepth);
          if (c.gapMs) await sleep(c.gapMs);
          const r = await timed(() => bridge.updateImageRawData(new ImageRawDataUpdate({
            containerID: FIRST_TILE_ID + c.tile,
            containerName: tileName(c.tile),
            imageData: png,
          })));
          ms = r.ms;
          ok = r.result === ImageRawDataUpdateResult.success ? true : String(r.result);
          detail = { w: t.width, h: t.height, content: c.content, bitDepth: c.bitDepth, gapMs: c.gapMs, png: png.length, lit: nonZero(levels) };
        }
        log('PROBE_SAMPLE', { case: c.name, round, i, ms: Math.round(ms), ok, ...detail });
        if (i > 0 && ok === true) {
          const list = samples.get(c.name) ?? [];
          list.push(ms);
          samples.set(c.name, list);
        }
      }
    }
  }
  const medians = cases.map((c) => ({ case: c.name, ms: Math.round(median(samples.get(c.name) ?? []) ?? -1), n: (samples.get(c.name) ?? []).length }));
  const end = await bridge.getDeviceInfo().catch(() => null);
  log('PROBE_DONE', { seconds: Math.round((performance.now() - started) / 1000), medians, ...deviceStatus(end?.status) });
  const pick = (name: string) => medians.find((m) => m.case === name)?.ms ?? -1;
  await setStatus(bridge, [
    'PROBE DONE: median ms per update (tap to rerun)',
    `288x144: black ${pick('288x144 black')}  coin ${pick('288x144 coin')}  noise ${pick('288x144 noise')}`,
    `144x144: black ${pick('144x144 black')}  coin ${pick('144x144 coin')}  noise ${pick('144x144 noise')}`,
    `72x72 coin ${pick('72x72 coin')}   24x24 black ${pick('24x24 black')}   text ${pick('text update')}`,
  ].join('\n'));
}

async function main(): Promise<void> {
  const bridge = await Promise.race([waitForEvenAppBridge(), sleep(2000).then(() => null)]);
  if (!bridge) {
    log('PROBE_READY', { glasses: false });
    return;
  }
  const page = {
    containerTotalNum: 1 + TILES.length,
    textObject: [
      new TextContainerProperty({ containerID: STATUS.id, containerName: STATUS.name, xPosition: 0, yPosition: 152, width: 576, height: 136, content: 'LINK PROBE  starting', isEventCapture: 1, borderWidth: 0, paddingLength: 6 }),
    ],
    imageObject: imageContainers(TILES),
  };
  const created = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page));
  let rebuilt: boolean | null = null;
  if (created !== 0) {
    rebuilt = await bridge.rebuildPageContainer(new RebuildPageContainer(page));
    if (!rebuilt) throw new Error(`page create returned ${created} and rebuild failed`);
  }
  log('PROBE_READY', { glasses: true, created, rebuilt, userAgent: navigator.userAgent });

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runProbe(bridge);
    } catch (error) {
      log('PROBE_ERROR', String((error as Error)?.stack ?? error));
    } finally {
      running = false;
    }
  };
  bridge.onEvenHubEvent((event) => {
    const source = event.textEvent ?? event.sysEvent;
    if (source && (source.eventType ?? OsEventTypeList.CLICK_EVENT) === OsEventTypeList.CLICK_EVENT) void run();
  });
  await run();
}

main().catch((error) => log('PROBE_ERROR', String(error?.stack ?? error)));
