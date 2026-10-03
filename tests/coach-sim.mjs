// Headless logic check for the coach: random start states, closed-loop sim
// driven only by idealInput()'s recommendations. Run: node tests/coach-sim.mjs
import { idealInput, predictLanding, BOOST_ACCEL, GRAVITY } from '../docs/js/modules/coach.js';
import * as CONST from '../docs/js/modules/constants.js';

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const range = (a, b) => a + (b - a) * rnd();

const DT = 1 / 60;
const MAX_NOSE_RATE = 5.5;   // rad/s, game's global angular cap
const NOSE_TAU = 0.12;       // s, first-order lag standing in for angular-accel limits

/** Closed loop. noseMode: 'instant' | 'lagged'. Returns miss distance at arrival. */
function run(start, ring, T, { easy, noseMode }) {
  const gravity = easy ? 0 : GRAVITY;
  let x = start.x, y = easy ? 0 : start.y, vx = start.vx, vy = easy ? 0 : start.vy;
  let nose = Math.PI / 2;      // starts nose-up like the game
  let acc = 0;                 // sigma-delta boost modulator (feathering)
  let t = T;
  while (t > 1e-9) {
    const h = Math.min(DT, t);
    const ideal = idealInput({ x, y }, { x: vx, y: vy }, ring, t, { gravity, easy });

    if (noseMode === 'instant') nose = ideal.noseAngle;
    else {
      let d = ideal.noseAngle - nose;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const want = Math.max(-MAX_NOSE_RATE, Math.min(MAX_NOSE_RATE, d / NOSE_TAU));
      nose += want * h;
    }
    const nd = { x: Math.cos(nose), y: Math.sin(nose) };

    // Feather: boost on this tick iff the accumulated duty crosses 1
    acc += ideal.duty;
    const boostOn = noseMode === 'control' ? false : acc >= 1;
    if (boostOn) acc -= 1;

    const r = predictLanding({ x, y }, { x: vx, y: vy }, nd, boostOn, h, { gravity, easy });
    x = r.x; y = r.y; vx = r.vx; vy = r.vy;
    t -= h;
  }
  return Math.hypot(x - ring.x, easy ? 0 : y - ring.y);
}

function trial(opts) {
  const T = range(2.0, 5.0);
  const start = { x: range(-900, 900), y: range(-900, 900), vx: range(-500, 500), vy: range(-500, 500) };
  const ring = { x: range(-900, 900), y: range(-900, 900) };
  const size = range(300, 600);
  if (opts.easy) { start.y = 0; ring.y = 0; }
  const innerR = size / 2 - CONST.RING_TUBE_RADIUS;
  // "Reachable" = a constant-boost plan at t=T exists within boost capability.
  const reachable = idealInput(start, { x: start.vx, y: start.vy }, ring, T, { gravity: opts.easy ? 0 : GRAVITY, easy: opts.easy }).reachable;
  const miss = run(start, ring, T, opts);
  return { reachable, hit: miss <= innerR, miss };
}

let failed = false;
for (const easy of [true, false]) {
  for (const noseMode of ['instant', 'lagged', 'control']) {
    let reach = 0, hitReach = 0, all = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const r = trial({ easy, noseMode });
      all++;
      if (r.reachable) { reach++; if (r.hit) hitReach++; }
    }
    const pct = (100 * hitReach / reach).toFixed(1);
    // 'control' (never boosts) must FAIL most rings, proving the check can tell good from bad
    const need = noseMode === 'instant' ? 99 : 95;
    const ok = noseMode === 'control' ? parseFloat(pct) < 50 : parseFloat(pct) >= need;
    if (!ok) failed = true;
    console.log(`${easy ? 'easy  ' : 'normal'} nose=${noseMode.padEnd(7)} reachable ${reach}/${all}  hit ${hitReach}/${reach} = ${pct}%  (${noseMode === 'control' ? 'expect < 50%' : 'need >= ' + need + '%'}) ${ok ? 'PASS' : 'FAIL'}`);
  }
}
process.exit(failed ? 1 : 0);
