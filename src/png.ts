// Minimal grayscale PNG encoder. Pure JS, deterministic, no canvas: the engine
// runs and tests identically in Node and in the Even Hub WebView.
// Deflate uses stored (uncompressed) blocks; the SDK LZ4-compresses again before
// Bluetooth, so the PNG only has to cross the in-phone bridge.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  const view = new DataView(out.buffer);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const len = Math.min(65535, raw.length - start);
    out[o++] = i === blocks - 1 ? 1 : 0;
    view.setUint16(o, len, true);
    view.setUint16(o + 2, ~len & 0xffff, true);
    o += 4;
    out.set(raw.subarray(start, start + len), o);
    o += len;
  }
  view.setUint32(o, adler32(raw));
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export type PngBitDepth = 4 | 8;

/**
 * Encode levels 0..15 as a grayscale PNG. Bit depth 4 stores levels directly;
 * bit depth 8 stores level*17, which any 8->4 bit conversion (>>4 or /17) maps back exactly.
 */
export function encodeGrayPng(levels: Uint8Array, width: number, height: number, bitDepth: PngBitDepth = 4): Uint8Array {
  if (levels.length !== width * height) throw new RangeError(`expected ${width * height} levels, got ${levels.length}`);
  const rowBytes = bitDepth === 4 ? Math.ceil(width / 2) : width;
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (rowBytes + 1) + 1; // filter byte 0 (None) precedes each row
    const src = y * width;
    if (bitDepth === 4) {
      for (let x = 0; x < width; x += 2) {
        const hi = levels[src + x] & 15;
        const lo = x + 1 < width ? levels[src + x + 1] & 15 : 0;
        raw[o + (x >> 1)] = (hi << 4) | lo;
      }
    } else {
      for (let x = 0; x < width; x++) raw[o + x] = (levels[src + x] & 15) * 17;
    }
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = bitDepth;
  header[9] = 0; // grayscale; bytes 10-12: deflate, adaptive filtering, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
