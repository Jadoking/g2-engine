// Spinning-coin proof of concept: animation through the engine's tile path.
// Two layouts, switched with a long press:
//   large: 248 px coin across 2 stacked image tiles. Tiles update one after
//          another, so a frame can show the top half newer than the bottom (tearing).
//   small: 132 px coin inside 1 tile. Each frame is one atomic update: no tearing,
//          half the bytes.
// Label and live stats are native text, so the page is a hybrid native/raster page.
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  OsEventTypeList,
  type EvenAppBridge,
  type EvenHubEvent,
  type DeviceStatus,
} from '@evenrealities/even_hub_sdk';
import { Engine, FrameLoop, quantize, SCREEN_WIDTH, SCREEN_HEIGHT, type Dither, type FrameStats, type Rect, type TileSink } from '../../src/index.ts';
import { evenHubSink, imageContainers, serialQueue, type Serial } from '../../src/adapters/evenhub.ts';
import { DEMO_COIN, coinBounds, coinShader, type Coin } from './coin.ts';

type Layout = { name: 'large' | 'small'; tiles: Rect[]; coin: Coin };

const LAYOUTS: Layout[] = [
  {
    name: 'large',
    tiles: [{ x: 144, y: 0, width: 288, height: 144 }, { x: 144, y: 144, width: 288, height: 144 }],
    coin: DEMO_COIN,
  },
  {
    name: 'small',
    tiles: [{ x: 144, y: 72, width: 288, height: 144 }],
    coin: { ...DEMO_COIN, radius: 64, halfThickness: 5 },
  },
];
const LABEL = 'G2 ENGINE\n\nspinning coin\n\nray-cast\n4x AA\n16 levels';

// URL options: ?layout=small starts with the 1-tile coin; ?telemetry also POSTs every
// log line as JSON to ./telemetry on the serving origin (for hardware measurement runs).
const params = new URLSearchParams(location.search);
const telemetry = params.has('telemetry');
const session = Math.random().toString(36).slice(2, 8);

const state = { angle: 0, speed: 0.5, paused: false, dither: 'none' as Dither, layout: params.get('layout') === 'small' ? 1 : 0, switching: false };

const statusEl = document.getElementById('status')!;
const mirror = (document.getElementById('mirror') as HTMLCanvasElement).getContext('2d')!;
const mirrorImage = mirror.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);

function log(tag: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(tag, text);
  statusEl.textContent = `${tag} ${text}`;
  if (telemetry) {
    void fetch('telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, t: Date.now(), tag, value }),
      keepalive: true,
    }).catch(() => {});
  }
}

addEventListener('error', (e) => log('COIN_ERROR', String(e.error?.stack ?? e.message)));
addEventListener('unhandledrejection', (e) => log('COIN_ERROR', String(e.reason?.stack ?? e.reason)));

/** Per-call timings of updateImageRawData (including the wait in the serial queue). */
function timingSummary(samples: number[]) {
  if (samples.length === 0) return { n: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
  return { n: s.length, p50: at(0.5), p90: at(0.9), max: Math.round(s[s.length - 1]) };
}

/** Battery and connection state, without the serial number. */
function deviceStatus(status: DeviceStatus | undefined) {
  if (!status) return { status: null };
  const { connectType, batteryLevel, isCharging, isWearing, isInCase } = status;
  return { connectType, batteryLevel, isCharging, isWearing, isInCase };
}

async function connect(): Promise<EvenAppBridge | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
  return Promise.race([waitForEvenAppBridge(), timeout]);
}

function pageContainers(layout: Layout) {
  return {
    containerTotalNum: 2 + layout.tiles.length,
    textObject: [
      new TextContainerProperty({ containerID: 1, containerName: 'label', xPosition: 0, yPosition: 0, width: 144, height: 288, content: LABEL, isEventCapture: 1, borderWidth: 0, paddingLength: 8 }),
      new TextContainerProperty({ containerID: 2, containerName: 'stats', xPosition: 432, yPosition: 0, width: 144, height: 288, content: 'starting', borderWidth: 0, paddingLength: 8 }),
    ],
    imageObject: imageContainers(layout.tiles),
  };
}

function statsText(s: FrameStats): string {
  return [
    `fps ${s.fps.toFixed(1)}`,
    `draw ${s.renderMs.toFixed(0)} ms`,
    `link ${s.presentMs.toFixed(0)} ms`,
    `${s.tilesPerFrame.toFixed(1)} tiles/frame`,
    `${(s.bytesPerFrame / 1024).toFixed(1)} KB/frame`,
    '',
    state.paused ? 'PAUSED' : `spin ${state.speed.toFixed(2)} r/s`,
    `dither ${state.dither}`,
    `${LAYOUTS[state.layout].name} coin`,
  ].join('\n');
}

function paintMirror(engine: Engine): void {
  const levels = quantize(engine.surface, { x: 0, y: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT }, { dither: engine.dither });
  const px = mirrorImage.data;
  for (let i = 0; i < levels.length; i++) {
    const v = levels[i] * 17;
    px[i * 4] = Math.round(v * 0.35);
    px[i * 4 + 1] = v;
    px[i * 4 + 2] = Math.round(v * 0.35);
    px[i * 4 + 3] = 255;
  }
  mirror.putImageData(mirrorImage, 0, 0);
}

/** One running layout: its engine and frame loop. Replaced wholesale on a layout switch. */
function startLayout(layout: Layout, bridge: EvenAppBridge | null, serial: Serial): FrameLoop {
  const sends: number[] = [];
  const base: TileSink = bridge ? evenHubSink(bridge, serial) : async () => {};
  const sink: TileSink = async (index, png) => {
    const start = performance.now();
    await base(index, png);
    sends.push(performance.now() - start);
  };
  const engine = new Engine({ tiles: layout.tiles, sink, dither: state.dither });
  const bounds = coinBounds(layout.coin);
  const loop = new FrameLoop(
    engine,
    (surface, { dt }) => {
      if (!state.paused) state.angle += 2 * Math.PI * state.speed * dt;
      engine.dither = state.dither;
      surface.shade(bounds, coinShader(layout.coin, state.angle), 1);
      paintMirror(engine);
    },
    {
      maxFps: 30,
      onStats: (stats) => {
        const send = timingSummary(sends.splice(0));
        log('COIN_STATS', { layout: layout.name, ...stats, send, paused: state.paused, speed: state.speed, dither: state.dither });
        if (!bridge) return;
        const content = statsText(stats);
        serial(() => bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 2, containerName: 'stats', content }))).catch((e) => log('COIN_ERROR', String(e)));
      },
      onError: (error) => log('COIN_ERROR', String(error)),
    },
  );
  loop.start();
  log('COIN_LAYOUT', { layout: layout.name, tiles: layout.tiles.length, bounds });
  return loop;
}

async function main(): Promise<void> {
  const bridge = await connect();
  const serial = serialQueue();
  let loop: FrameLoop;

  if (bridge) {
    const info = await bridge.getDeviceInfo().catch(() => null);
    log('COIN_DEVICE', { model: info?.model ?? null, ...deviceStatus(info?.status) });
    bridge.onDeviceStatusChanged((status) => log('COIN_DEVICE', deviceStatus(status)));
    const first = pageContainers(LAYOUTS[state.layout]);
    const created = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(first));
    let rebuilt: boolean | null = null;
    if (created !== 0) {
      // A page already exists (dev reload): replace it.
      rebuilt = await bridge.rebuildPageContainer(new RebuildPageContainer(first));
      if (!rebuilt) throw new Error(`page create returned ${created} and rebuild failed`);
    }
    log('COIN_PAGE', { created, rebuilt });
  }

  async function switchLayout(): Promise<void> {
    if (state.switching) return;
    state.switching = true;
    try {
      await loop.stop();
      state.layout = (state.layout + 1) % LAYOUTS.length;
      const layout = LAYOUTS[state.layout];
      if (bridge) {
        const ok = await serial(() => bridge.rebuildPageContainer(new RebuildPageContainer(pageContainers(layout))));
        if (!ok) throw new Error('rebuildPageContainer failed');
      }
      mirror.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
      loop = startLayout(layout, bridge, serial);
    } finally {
      state.switching = false;
    }
  }

  function onInput(event: EvenHubEvent): void {
    const source = event.textEvent ?? event.sysEvent;
    if (!source) return;
    const type = source.eventType ?? OsEventTypeList.CLICK_EVENT; // protobuf omits the zero value
    if (type === OsEventTypeList.CLICK_EVENT) state.paused = !state.paused;
    else if (type === OsEventTypeList.SCROLL_TOP_EVENT) state.speed = Math.min(2, state.speed + 0.25);
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) state.speed = Math.max(-2, state.speed - 0.25);
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) state.dither = state.dither === 'none' ? 'bayer4' : 'none';
    else if (type === OsEventTypeList.LONG_PRESS_EVENT) void switchLayout().catch((e) => log('COIN_ERROR', String(e)));
    else return;
    log('COIN_INPUT', { type, paused: state.paused, speed: state.speed, dither: state.dither });
  }

  bridge?.onEvenHubEvent(onInput);
  log('COIN_READY', { glasses: Boolean(bridge), layout: LAYOUTS[state.layout].name, userAgent: navigator.userAgent });
  loop = startLayout(LAYOUTS[state.layout], bridge, serial);
}

main().catch((error) => log('COIN_ERROR', String(error?.stack ?? error)));
