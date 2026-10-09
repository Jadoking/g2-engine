// Spinning coin, ray-cast per pixel: a short cylinder leaning back slightly and
// spinning about the vertical axis, seen by an orthographic camera pitched down.
// Faces carry bump-mapped relief (star / sunburst), the edge is reeded, and
// shading is Lambert + two Phong lobes so the metal flashes as it turns.
import type { Rect, Shader } from '../../src/surface.ts';

export type Coin = {
  cx: number; // screen centre, px
  cy: number;
  radius: number; // px
  halfThickness: number; // px
  pitch: number; // camera pitch, radians (positive looks down at the coin)
  lean: number; // face tilted back from vertical, radians; lets the face catch the overhead light
};

/** The demo coin: centred in the two middle image tiles. */
export const DEMO_COIN: Coin = { cx: 288, cy: 144, radius: 124, halfThickness: 9, pitch: (15 * Math.PI) / 180, lean: (20 * Math.PI) / 180 };

type Vec3 = [number, number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// Camera space: x right, y up, z towards the viewer.
// world = Rx(-pitch)·camera; coin-local = Rx(lean)·Ry(-angle)·world. The coin axis is local z.
function toLocal(v: Vec3, coin: Coin, angle: number): Vec3 {
  const cp = Math.cos(-coin.pitch), sp = Math.sin(-coin.pitch);
  const wx = v[0];
  const wy = v[1] * cp - v[2] * sp;
  const wz = v[1] * sp + v[2] * cp;
  const ca = Math.cos(-angle), sa = Math.sin(-angle);
  const sx = wx * ca + wz * sa;
  const sz = -wx * sa + wz * ca;
  const cl = Math.cos(coin.lean), sl = Math.sin(coin.lean);
  return [sx, wy * cl - sz * sl, wy * sl + sz * cl];
}

// Upper-left key light. With the lean, each face's normal sweeps through the
// half-vector once per turn, which is the metal flash.
const LIGHT_CAMERA = normalize([-0.55, 0.35, 0.75]);
const EYE_DISTANCE = 1000;
const BUMP = 0.03; // relief slope scale in face units
const EPS = 0.004; // finite-difference step in face units (~0.5 px)
const REEDS = 90;

export type CoinFrame = {
  coin: Coin;
  ex: Vec3; // local images of the camera basis
  ey: Vec3;
  ez: Vec3;
  light: Vec3; // in local space
};

export function prepareCoin(coin: Coin, angle: number): CoinFrame {
  return {
    coin,
    ex: toLocal([1, 0, 0], coin, angle),
    ey: toLocal([0, 1, 0], coin, angle),
    ez: toLocal([0, 0, 1], coin, angle),
    light: toLocal(LIGHT_CAMERA, coin, angle),
  };
}

export type CoinHit = { kind: 'front' | 'back' | 'edge'; x: number; y: number; z: number };

/** Ray/cylinder intersection for the pixel-space point (px, py). Slab ∩ infinite cylinder, entry = max of entries. */
export function traceCoin(f: CoinFrame, px: number, py: number): CoinHit | null {
  const { radius: R, halfThickness: T } = f.coin;
  const u = px - f.coin.cx;
  const v = f.coin.cy - py;
  const ox = u * f.ex[0] + v * f.ey[0] + EYE_DISTANCE * f.ez[0];
  const oy = u * f.ex[1] + v * f.ey[1] + EYE_DISTANCE * f.ez[1];
  const oz = u * f.ex[2] + v * f.ey[2] + EYE_DISTANCE * f.ez[2];
  const dx = -f.ez[0], dy = -f.ez[1], dz = -f.ez[2];

  // Slab |z| <= T.
  let slabIn: number, slabOut: number;
  if (Math.abs(dz) < 1e-12) {
    if (Math.abs(oz) > T) return null;
    slabIn = -Infinity;
    slabOut = Infinity;
  } else {
    const t1 = (-T - oz) / dz, t2 = (T - oz) / dz;
    slabIn = Math.min(t1, t2);
    slabOut = Math.max(t1, t2);
  }
  // Infinite cylinder x² + y² <= R².
  const a = dx * dx + dy * dy;
  const c = ox * ox + oy * oy - R * R;
  let cylIn: number, cylOut: number;
  if (a < 1e-12) {
    if (c > 0) return null;
    cylIn = -Infinity;
    cylOut = Infinity;
  } else {
    const b = 2 * (ox * dx + oy * dy);
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    cylIn = (-b - s) / (2 * a);
    cylOut = (-b + s) / (2 * a);
  }
  const tIn = Math.max(slabIn, cylIn);
  if (tIn > Math.min(slabOut, cylOut)) return null;
  const x = ox + tIn * dx, y = oy + tIn * dy, z = oz + tIn * dz;
  const kind = slabIn >= cylIn ? (dz < 0 ? 'front' : 'back') : 'edge';
  return { kind, x, y, z };
}

// --- Relief height fields, in face units (unit disc, y up, x to the viewer's right) ---

// Five-pointed star signed distance (after Inigo Quilez, sdStar5).
function sdStar5(px: number, py: number, r: number, rf: number): number {
  const k1x = 0.809016994375, k1y = -0.587785252292;
  const k2x = -k1x, k2y = k1y;
  px = Math.abs(px);
  let d = 2 * Math.max(k1x * px + k1y * py, 0);
  px -= d * k1x; py -= d * k1y;
  d = 2 * Math.max(k2x * px + k2y * py, 0);
  px -= d * k2x; py -= d * k2y;
  px = Math.abs(px);
  py -= r;
  const bax = rf * -k1y, bay = rf * k1x - 1;
  const h = Math.min(r, Math.max(0, (px * bax + py * bay) / (bax * bax + bay * bay)));
  return Math.hypot(px - bax * h, py - bay * h) * Math.sign(py * bax - px * bay);
}

function rim(r: number): number {
  return smoothstep(0.84, 0.88, r);
}

function frontHeight(x: number, y: number): number {
  const r = Math.hypot(x, y);
  const step = (2 * Math.PI) / 36;
  const k = Math.round(Math.atan2(y, x) / step);
  const bead = 1 - smoothstep(0.022, 0.036, Math.hypot(x - 0.76 * Math.cos(k * step), y - 0.76 * Math.sin(k * step)));
  const star = 1 - smoothstep(-0.015, 0.015, sdStar5(x, y, 0.56, 0.42));
  return Math.max(rim(r), bead, star);
}

function backHeight(x: number, y: number): number {
  const r = Math.hypot(x, y);
  const rays = smoothstep(0.55, 0.9, Math.cos(16 * Math.atan2(y, x))) * smoothstep(0.2, 0.24, r) * (1 - smoothstep(0.62, 0.66, r));
  const ring = 1 - smoothstep(0.008, 0.02, Math.abs(r - 0.72));
  const hub = 1 - smoothstep(0.13, 0.16, r);
  return Math.max(rim(r), rays, ring, hub);
}

function shadeNormal(f: CoinFrame, n: Vec3, albedo: number): number {
  const L = f.light;
  const V = f.ez;
  const nl = Math.max(0, dot(n, L));
  const nv = dot(n, V);
  // Mirror reflection of the eye ray; the lobes model a broad studio light at L.
  const rl = Math.max(0, 2 * nv * dot(n, L) - dot(V, L));
  return albedo * (0.12 + 0.5 * nl) + 0.35 * Math.pow(rl, 6) + 0.9 * Math.pow(rl, 40);
}

function shadeHit(f: CoinFrame, hit: CoinHit): number {
  const R = f.coin.radius;
  if (hit.kind === 'edge') {
    const phi = Math.atan2(hit.y, hit.x);
    const c = Math.cos(phi), s = Math.sin(phi);
    const w = 0.35 * Math.sin(REEDS * phi);
    return shadeNormal(f, normalize([c - w * s, s + w * c, 0]), 0.9);
  }
  // Bump-mapped face. Face coords mirror x on the back so its design reads correctly.
  const sigma = hit.kind === 'front' ? 1 : -1;
  const ax = (sigma * hit.x) / R, ay = hit.y / R;
  const h = sigma === 1 ? frontHeight : backHeight;
  const hx = (h(ax + EPS, ay) - h(ax - EPS, ay)) / (2 * EPS);
  const hy = (h(ax, ay + EPS) - h(ax, ay - EPS)) / (2 * EPS);
  // Polished relief on a matte field: raised parts reflect more.
  return shadeNormal(f, normalize([-sigma * BUMP * hx, -BUMP * hy, sigma]), 0.7 + 0.3 * h(ax, ay));
}

// Rotated-grid offsets: 4 coverage samples, distinct in x and y.
const AA = [[-0.375, -0.125], [0.125, -0.375], [0.375, 0.125], [-0.125, 0.375]];

/**
 * One pixel (px, py = pixel centre). Silhouette is anti-aliased with 4 cheap
 * coverage rays; the expensive shading runs once, at the first covered sample.
 * Relief edges are ~4 px wide, so they need no extra samples.
 */
export function shadeCoin(f: CoinFrame, px: number, py: number): number {
  let covered = 0;
  let first: CoinHit | null = null;
  for (const [dx, dy] of AA) {
    const hit = traceCoin(f, px + dx, py + dy);
    if (!hit) continue;
    covered++;
    first ??= hit;
  }
  return first ? (covered / AA.length) * shadeHit(f, first) : 0;
}

export function coinShader(coin: Coin, angle: number): Shader {
  const frame = prepareCoin(coin, angle);
  return (x, y) => shadeCoin(frame, x, y);
}

/** Screen rectangle that contains the coin at every angle (bounding sphere). */
export function coinBounds(coin: Coin): Rect {
  const r = Math.ceil(Math.hypot(coin.radius, coin.halfThickness)) + 1;
  return { x: Math.floor(coin.cx - r), y: Math.floor(coin.cy - r), width: 2 * r, height: 2 * r };
}
