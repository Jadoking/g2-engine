import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync, crc32 as zlibCrc32 } from 'node:zlib';
import { Engine, FrameLoop, Surface, quantize, encodeGrayPng, crc32, validateTiles, type FrameInfo } from '../src/index.ts';

function readChunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; data: Uint8Array; crc: number; crcInput: Uint8Array }[] = [];
  let o = 8;
  while (o < png.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    chunks.push({ type, data: png.subarray(o + 8, o + 8 + len), crc: view.getUint32(o + 8 + len), crcInput: png.subarray(o + 4, o + 8 + len) });
    o += 12 + len;
  }
  return chunks;
}

test('PNG 4-bit: valid chunks, valid zlib stream, levels packed two per byte', () => {
  const png = encodeGrayPng(Uint8Array.from([0, 15, 7, 1, 2, 3]), 3, 2, 4);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = readChunks(png);
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  for (const c of chunks) assert.equal(c.crc, zlibCrc32(c.crcInput));
  assert.deepEqual([...chunks[0].data], [0, 0, 0, 3, 0, 0, 0, 2, 4, 0, 0, 0, 0]);
  // Row = filter byte, then nibbles (odd width pads the last low nibble with 0).
  assert.deepEqual([...inflateSync(chunks[1].data)], [0, 0x0f, 0x70, 0, 0x12, 0x30]);
});

test('PNG 8-bit stores level*17 so 8->4 bit conversion is exact', () => {
  const chunks = readChunks(encodeGrayPng(Uint8Array.from([0, 1, 15]), 3, 1, 8));
  assert.equal(chunks[0].data[8], 8);
  assert.deepEqual([...inflateSync(chunks[1].data)], [0, 0, 17, 255]);
});

test('PNG larger than one stored deflate block round-trips', () => {
  const w = 288, h = 144;
  const levels = Uint8Array.from({ length: w * h }, (_, i) => i % 16);
  const raw = inflateSync(readChunks(encodeGrayPng(levels, w, h, 8)).find((c) => c.type === 'IDAT')!.data);
  assert.equal(raw.length, (w + 1) * h);
  assert.equal(raw[1 + 17], 17); // x=17 -> level 1 -> 17
  assert.equal(raw[(w + 1) * 143 + 1 + 287], ((143 * w + 287) % 16) * 17);
});

test('crc32 matches zlib', () => {
  const bytes = new TextEncoder().encode('IEND');
  assert.equal(crc32(bytes), 0xae426082);
});

test('quantize maps k/15 exactly to level k and clamps', () => {
  const s = new Surface(18, 1);
  for (let k = 0; k < 16; k++) s.data[k] = k / 15;
  s.data[16] = -0.5;
  s.data[17] = 1.5;
  assert.deepEqual([...quantize(s, { x: 0, y: 0, width: 18, height: 1 })], [...Array.from({ length: 16 }, (_, k) => k), 0, 15]);
});

test('bayer4 dither preserves mean intensity of a flat field', () => {
  const s = new Surface(8, 8);
  for (const v of [0.1, 0.33, 0.5, 0.77]) {
    s.clear(v);
    const levels = quantize(s, { x: 0, y: 0, width: 8, height: 8 }, { dither: 'bayer4' });
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length / 15;
    assert.ok(Math.abs(mean - v) <= 1 / 30, `v=${v} mean=${mean}`);
  }
});

test('validateTiles enforces the Even Hub image limits', () => {
  assert.doesNotThrow(() => validateTiles([{ x: 0, y: 0, width: 288, height: 144 }, { x: 288, y: 144, width: 288, height: 144 }]));
  assert.throws(() => validateTiles([{ x: 0, y: 0, width: 289, height: 144 }]), /289x144/);
  assert.throws(() => validateTiles([{ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 }]), /overlap/);
  assert.throws(() => validateTiles(Array.from({ length: 5 }, (_, i) => ({ x: i * 100, y: 0, width: 50, height: 50 }))), /1\.\.4/);
  assert.throws(() => validateTiles([{ x: 500, y: 0, width: 100, height: 100 }]), /off screen/);
});

function recordingEngine() {
  const sent: number[] = [];
  let fail = false;
  const engine = new Engine({
    tiles: [{ x: 0, y: 0, width: 288, height: 144 }, { x: 288, y: 0, width: 288, height: 144 }],
    sink: async (i) => {
      if (fail) throw new Error('link down');
      sent.push(i);
    },
  });
  return { engine, sent, setFail: (v: boolean) => { fail = v; } };
}

test('present sends every tile first, then only tiles whose 16-level pixels changed', async () => {
  const { engine, sent } = recordingEngine();
  assert.deepEqual(await engine.present().then((r) => r.sentTiles), 2);
  assert.deepEqual(sent, [0, 1]);
  sent.length = 0;
  assert.equal((await engine.present()).sentTiles, 0);
  engine.surface.data[300] = 0.01; // below half a level: same quantized image, nothing sent
  assert.equal((await engine.present()).sentTiles, 0);
  engine.surface.data[300] = 1; // x=300 lives in tile 1
  await engine.present();
  assert.deepEqual(sent, [1]);
});

test('a tile that fails to send stays dirty and is resent', async () => {
  const { engine, sent, setFail } = recordingEngine();
  await engine.present();
  sent.length = 0;
  engine.surface.data[10] = 1;
  setFail(true);
  await assert.rejects(engine.present(), /link down/);
  setFail(false);
  await engine.present();
  assert.deepEqual(sent, [0]);
});

test('invalidate forces a full resend', async () => {
  const { engine, sent } = recordingEngine();
  await engine.present();
  engine.invalidate();
  await engine.present();
  assert.deepEqual(sent, [0, 1, 0, 1]);
});

test('frame loop drops frames on a slow link instead of queueing them', async () => {
  let clock = 0;
  const frames: FrameInfo[] = [];
  const engine = new Engine({
    tiles: [{ x: 0, y: 0, width: 288, height: 144 }],
    sink: async () => { clock += 250; }, // every tile takes 250 ms to deliver
  });
  const loop: FrameLoop = new FrameLoop(
    engine,
    (surface, info) => {
      frames.push(info);
      surface.data[0] = info.frame % 2; // force a change every frame
      if (info.time >= 2) void loop.stop();
    },
    { maxFps: 30, now: () => clock, sleep: async (ms) => { clock += ms; } },
  );
  loop.start();
  while (loop.isRunning) await new Promise((r) => setTimeout(r, 0));
  const last = frames.at(-1)!;
  assert.ok(last.time >= 2 && last.time < 2.3, `animation time ${last.time}`);
  assert.ok(frames.length >= 8 && frames.length <= 10, `${frames.length} frames in ~2 s at 4 fps`);
  // Animation time equals wall time: dt reflects the slow link, not a fixed 1/30 s step.
  assert.ok(frames.slice(2).every((f) => Math.abs(f.dt - 0.25) < 1e-9), frames.map((f) => f.dt).join(','));
});
