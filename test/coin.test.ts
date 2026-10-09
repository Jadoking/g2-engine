import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Surface } from '../src/index.ts';
import { DEMO_COIN, coinBounds, coinShader, prepareCoin, traceCoin, type Coin } from '../demos/coin/coin.ts';

const COIN = DEMO_COIN;

/** Horizontal extent (px) of the ray-cast silhouette over all rows. */
function silhouetteWidth(coin: Coin, angle: number): number {
  const frame = prepareCoin(coin, angle);
  const b = coinBounds(coin);
  let min = Infinity, max = -Infinity;
  for (let y = b.y; y < b.y + b.height; y++) {
    for (let x = b.x; x < b.x + b.width; x++) {
      if (traceCoin(frame, x + 0.5, y + 0.5)) {
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
    }
  }
  return max - min + 1;
}

// Coin axis in world space: Ry(θ)·(0, sin β, cos β). Camera x = world x, so the
// screen width is the cylinder's support function along x: 2(R·√(1 − aₓ²) + T·|aₓ|).
test('silhouette width matches the cylinder support function', () => {
  for (const deg of [0, 30, 60, 85, 90, 135, 180, 250]) {
    const a = (deg * Math.PI) / 180;
    const ax = Math.cos(COIN.lean) * Math.sin(a);
    const expected = 2 * (COIN.radius * Math.sqrt(1 - ax * ax) + COIN.halfThickness * Math.abs(ax));
    const got = silhouetteWidth(COIN, a);
    assert.ok(Math.abs(got - expected) <= 2, `θ=${deg}°: ${got}px vs ${expected.toFixed(1)}px`);
  }
});

test('front at 0°, back at 180°, edge exactly where the face turns away: cos θ = −tan β·tan p', () => {
  const at = (a: number) => traceCoin(prepareCoin(COIN, a), COIN.cx + 0.5, COIN.cy + 0.5)?.kind;
  assert.equal(at(0), 'front');
  assert.equal(at(Math.PI), 'back');
  const edgeOn = Math.acos(-Math.tan(COIN.lean) * Math.tan(COIN.pitch)); // ≈ 95.6°
  assert.equal(at(edgeOn), 'edge');
  assert.equal(at(-edgeOn), 'edge');
  assert.equal(at(edgeOn - 0.3), 'front');
  assert.equal(at(edgeOn + 0.3), 'back');
});

test('the coin stays inside its bounds, background stays black', () => {
  const s = new Surface(576, 288);
  const b = coinBounds(COIN);
  for (const deg of [0, 45, 90]) {
    s.clear(0);
    s.shade({ x: 0, y: 0, width: 576, height: 288 }, coinShader(COIN, (deg * Math.PI) / 180), 1);
    for (let y = 0; y < 288; y++) {
      for (let x = 0; x < 576; x++) {
        const inside = x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
        if (!inside) assert.equal(s.get(x, y), 0, `lit pixel (${x},${y}) outside bounds at ${deg}°`);
      }
    }
    assert.equal(s.get(5, 5), 0);
    assert.ok(s.get(COIN.cx, COIN.cy) > 0);
  }
});

test('shading is a pure function of angle (identical frames => no tiles resent)', () => {
  const a = new Surface(576, 288), b = new Surface(576, 288);
  const r = coinBounds(COIN);
  a.shade(r, coinShader(COIN, 1.234), 1);
  b.shade(r, coinShader(COIN, 1.234), 1);
  assert.deepEqual(a.data, b.data);
});
