// Headless logic check for the coach: random start states, closed-loop sim
// driven only by idealInput()'s recommendations. Run: node tests/coach-sim.mjs
import { idealInput, predictLanding, stickForNose, stableStick, resetStable, BOOST_ACCEL, GRAVITY } from '../docs/js/modules/coach.js';
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

// Instruction stabiliser (Level 3 flicker). 60 fps for 10 s.
{
  const raw8 = st => st.mag === 0 ? 'C' : String(((Math.round(Math.atan2(st.y, st.x) / (Math.PI / 4)) % 8) + 8) % 8);
  const run = gen => {
    resetStable();
    let rawLast, rawN = 0, shownLast, shownN = 0;
    for (let i = 0; i < 600; i++) {
      const st = gen(i / 60);
      const r = raw8(st); if (r !== rawLast) { rawN++; rawLast = r; }
      const o = stableStick(st, false, i * 1000 / 60);
      const w = o.sector === null ? 'C' : String(o.sector); if (w !== shownLast) { shownN++; shownLast = w; }
    }
    return { raw: rawN / 10, shown: shownN / 10 };
  };
  // Near target: tiny error (~3-6 deg) in a random direction every frame
  const near = run(() => { const a = rnd() * 2 * Math.PI; return { x: 0.15 * Math.cos(a), y: 0.15 * Math.sin(a), mag: 0.15, err: 0.05 + 0.05 * rnd() }; });
  // Wobbling just above the centre zone: error 9-14 deg, direction random each frame
  const wobble = run(() => { const a = rnd() * 2 * Math.PI; return { x: 0.3 * Math.cos(a), y: 0.3 * Math.sin(a), mag: 0.3, err: 0.16 + 0.08 * rnd() }; });
  // Car rolling at 1 turn per 2 s: needed stick rotates steadily (a real change)
  const spin = run(t => { const a = Math.PI * t; return { x: 0.8 * Math.cos(a), y: 0.8 * Math.sin(a), mag: 0.8, err: 0.6 }; });
  const okNear = near.shown <= 0.5, okWob = wobble.shown <= 0.5, okSpin = spin.shown >= 3 && spin.shown <= 5;
  if (!okNear || !okWob || !okSpin) failed = true;
  console.log(`stabiliser: near-target noise  raw ${near.raw.toFixed(1)}/s -> shown ${near.shown.toFixed(1)}/s (want <= 0.5)  ${okNear ? 'PASS' : 'FAIL'}`);
  console.log(`stabiliser: noisy wobble      raw ${wobble.raw.toFixed(1)}/s -> shown ${wobble.shown.toFixed(1)}/s (want <= 0.5)  ${okWob ? 'PASS' : 'FAIL'}`);
  console.log(`stabiliser: steady roll 0.5 rev/s raw ${spin.raw.toFixed(1)}/s -> shown ${spin.shown.toFixed(1)}/s (want 3-5: follows, no extra flicker)  ${okSpin ? 'PASS' : 'FAIL'}`);
}

// Stick convention regression. Measured in the real game from the Ring Mode
// start pose (Euler XYZ 1.5pi, 0, pi; nose = world +Y): stick right swings the
// nose toward world +x, stick left toward -x. (A sign slip here once made the
// coach point the opposite way while the sim above still passed.)
{
  const qm = (a, b) => ({ x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y, y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
                          z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w, w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z });
  const ax = (x, y, z, ang) => ({ x: x*Math.sin(ang/2), y: y*Math.sin(ang/2), z: z*Math.sin(ang/2), w: Math.cos(ang/2) });
  const q = qm(qm(ax(1,0,0,Math.PI*1.5), ax(0,1,0,0)), ax(0,0,1,Math.PI));
  const checks = [
    ['target +x -> stick right', stickForNose({x:1,y:0}, q), s => s.x > 0.5 && Math.abs(s.y) < 0.2],
    ['target -x -> stick left',  stickForNose({x:-1,y:0}, q), s => s.x < -0.5 && Math.abs(s.y) < 0.2],
    ['target dead behind nose -> still commands a swing', stickForNose({x:0,y:-1}, q), s => s.mag > 0.5],
    ['target on nose -> stick centred', stickForNose({x:0,y:1}, q), s => s.mag === 0]
  ];
  for (const [name, r, ok] of checks) {
    const pass = ok(r);
    if (!pass) failed = true;
    console.log(`stick convention: ${name.padEnd(52)} ${pass ? 'PASS' : 'FAIL'}`);
  }
}

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
