/**
 * Coach Module - Ring Mode air-dribble coaching
 *
 * Tells the player where to put their thumb (stick) and how much to feather
 * boost to hit the next ring. All logic lives here; the original modules only
 * carry small hooks:
 *   - ringMode.js  -> calls update() from the physics step
 *   - rendering.js -> calls draw() after the existing HUD
 *
 * The pure functions (predictLanding / idealInput / stickForNose / scoreFrame)
 * have no THREE or DOM dependency so they can be tested headlessly in Node
 * (see tests/coach-sim.mjs).
 *
 * Coordinates: grid XY (x right, y up) in game units, time in game seconds.
 */

import * as CONST from './constants.js';

export const BOOST_ACCEL = CONST.RING_BOOST_ACCEL;
export const GRAVITY = CONST.RING_GRAVITY;
export const MAX_SPEED = CONST.RING_MAX_SPEED;
export const GRID_BOUNDS = CONST.RING_GRID_BOUNDS;

const SIM_DT = 1 / 120;       // prediction step
const MIN_T = 0.4;            // planning horizon floor: 2*err/t^2 explodes as t -> 0, and no thumb can chase that
const BOOST_AVG_TAU = 0.4;    // seconds, smoothing for the "actual boost duty" readout

// Stick PD (nose-angle error -> stick). The game is rate controlled: stick
// magnitude * wMax is the commanded angular speed, so P alone already closes
// the error; D compensates the angular-acceleration lag.
const PD_KP = 5.0;            // 1/s
const PD_KD = 0.35;           // s ... multiplies error rate (negative while closing)
const PD_DEADBAND = 0.02;     // rad - hold still when this close
const DEFAULT_WMAX = 5.5;     // rad/s, matches physics global cap

// ============================================================================
// PURE LOGIC
// ============================================================================

/**
 * Step the Ring Mode physics forward by t seconds with a fixed nose and a
 * fixed boost state. Mirrors updateRingModePhysics(): velocity integrate,
 * speed clamp, position integrate, bounds clamp.
 *
 * @param {{x:number,y:number}} pos
 * @param {{x:number,y:number}} vel
 * @param {{x:number,y:number}} noseDir - nose projected on the XY plane
 *        (length <= 1; an out-of-plane nose gives less in-plane boost, like the game)
 * @param {boolean} boostOn
 * @param {number} t - seconds to simulate
 * @param {{gravity?:number, easy?:boolean}} [opts]
 * @returns {{x:number,y:number,vx:number,vy:number}}
 */
export function predictLanding(pos, vel, noseDir, boostOn, t, opts = {}) {
  const g = opts.gravity ?? GRAVITY;
  const easy = !!opts.easy;
  let px = pos.x, py = easy ? 0 : pos.y;
  let vx = vel.x, vy = easy ? 0 : vel.y;
  const steps = Math.max(1, Math.ceil(Math.max(0, t) / SIM_DT));
  const h = Math.max(0, t) / steps;

  for (let i = 0; i < steps; i++) {
    let ax = 0;
    let ay = easy ? 0 : g;
    if (boostOn) {
      ax += noseDir.x * BOOST_ACCEL;
      if (!easy) ay += noseDir.y * BOOST_ACCEL;
    }
    vx += ax * h;
    vy += ay * h;
    if (easy) vy = 0;
    const sp = Math.hypot(vx, vy);
    if (sp > MAX_SPEED) { vx *= MAX_SPEED / sp; vy *= MAX_SPEED / sp; }
    px += vx * h;
    py += vy * h;
    if (easy) py = 0;
    px = Math.max(-GRID_BOUNDS, Math.min(GRID_BOUNDS, px));
    py = Math.max(-GRID_BOUNDS, Math.min(GRID_BOUNDS, py));
  }
  return { x: px, y: py, vx, vy };
}

/**
 * Constant-acceleration plan to put the car on the ring centre in time t:
 *   a = 2 (target - pos - vel t) / t^2
 *   boost = a - gravity
 * Boost direction is the ideal nose; |boost| / BOOST_ACCEL is the duty cycle.
 *
 * @param {{x:number,y:number}} pos
 * @param {{x:number,y:number}} vel
 * @param {{x:number,y:number}} ringTarget - ring centre on the grid
 * @param {number} t - seconds until the ring arrives
 * @param {{gravity?:number, easy?:boolean, minT?:number}} [opts]
 * @returns {{accel:{x:number,y:number}, boost:{x:number,y:number}, noseAngle:number,
 *            noseDir:{x:number,y:number}, rawDuty:number, duty:number, reachable:boolean}}
 */
export function idealInput(pos, vel, ringTarget, t, opts = {}) {
  const g = opts.gravity ?? GRAVITY;
  const easy = !!opts.easy;
  const tt = Math.max(t, opts.minT ?? MIN_T);

  const ax = (2 * (ringTarget.x - pos.x - vel.x * tt)) / (tt * tt);
  const ay = easy ? 0 : (2 * (ringTarget.y - pos.y - vel.y * tt)) / (tt * tt);

  // Gravity pulls down for free, so boost must supply a - g.
  const bx = ax;
  const by = easy ? 0 : ay - g;
  const mag = Math.hypot(bx, by);
  const rawDuty = mag / BOOST_ACCEL;

  let noseAngle;
  if (mag < 1e-6) noseAngle = easy ? 0 : Math.PI / 2;   // nothing to correct: hold nose up
  else noseAngle = Math.atan2(by, bx);

  return {
    accel: { x: ax, y: ay },
    boost: { x: bx, y: by },
    noseAngle,
    noseDir: { x: Math.cos(noseAngle), y: Math.sin(noseAngle) },
    rawDuty,
    duty: Math.min(1, rawDuty),
    reachable: rawDuty <= 1
  };
}

/** Rotate vector v by quaternion q ({x,y,z,w}). */
function rotate(q, v) {
  const { x, y, z, w } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx)
  };
}
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Car nose (local +Z) in world space. */
export function noseOf(quat) { return rotate(quat, { x: 0, y: 0, z: 1 }); }

/** Angle (rad) between the car's nose and a desired in-plane direction. */
export function noseError(targetDir, quat) {
  const fwd = noseOf(quat);
  const l = Math.hypot(targetDir.x, targetDir.y) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (fwd.x * targetDir.x + fwd.y * targetDir.y) / l)));
}

/**
 * Convert "I want the nose to point along targetDir" into a stick position.
 * Convention measured against the real game (tests/coach-sim.mjs, and
 * tests/follow-live in the browser): stick (sx, sy), y down, swings the nose
 * toward sx*right + sy*up in the car frame. Then sets stick magnitude with a PD law
 * on the nose-angle error and inverts the game's deadzone/curve shaping.
 *
 * @param {{x:number,y:number}} targetDir - desired nose direction in the XY plane
 * @param {{x:number,y:number,z:number,w:number}} quat - car orientation
 * @param {number} errRate - d(error)/dt in rad/s (negative while converging)
 * @param {{wMax?:number, deadzone?:number, curve?:number, range?:number}} [opts]
 * @returns {{x:number,y:number,mag:number,err:number}} x,y are unit-disc screen
 *          coordinates (y down, same as joyVec / baseR); err is nose error in rad
 */
export function stickForNose(targetDir, quat, errRate = 0, opts = {}) {
  const wMax = opts.wMax ?? DEFAULT_WMAX;
  const dz = opts.deadzone ?? 0.09;
  const curve = opts.curve ?? 1;
  const range = opts.range ?? 1;

  const fwd = noseOf(quat);
  const up = rotate(quat, { x: 0, y: 1, z: 0 });
  // right = fwd x up (world direction the stick's right pushes the nose toward)
  const right = { x: fwd.y * up.z - fwd.z * up.y, y: fwd.z * up.x - fwd.x * up.z, z: fwd.x * up.y - fwd.y * up.x };

  const tl = Math.hypot(targetDir.x, targetDir.y);
  const to = tl > 1e-9 ? { x: targetDir.x / tl, y: targetDir.y / tl, z: 0 } : { x: 0, y: 1, z: 0 };
  const fc = Math.max(-1, Math.min(1, dot(to, fwd)));
  const err = Math.acos(fc);

  // Direction (perpendicular to the nose) the nose must swing toward.
  let plank = { x: to.x - fwd.x * fc, y: to.y - fwd.y * fc, z: to.z - fwd.z * fc };
  let plen = Math.hypot(plank.x, plank.y, plank.z);
  if (err < PD_DEADBAND) return { x: 0, y: 0, mag: 0, err };
  if (plen < 1e-6) { plank = up; plen = 1; }   // target dead behind the nose: any swing works

  // Measured in the real game: stick (sx, sy) [y down] swings the nose toward
  // sx * right + sy * up (car frame). So the stick is the plank's coordinates.
  const sx = dot(plank, right) / plen;
  const sy = dot(plank, up) / plen;
  const screenAngle = Math.atan2(sy, sx);

  // Commanded angular speed fraction (rate control: stick * wMax = rad/s)
  let eff = (PD_KP * err + PD_KD * errRate) / wMax;
  eff = Math.max(0, Math.min(1, eff));

  // Invert the game's shaping: eff = ((m - dz)/(1 - dz))^curve * range
  let mag = 0;
  if (eff > 0) {
    const e = Math.min(1, eff / range);
    mag = Math.min(1, dz + (1 - dz) * Math.pow(e, 1 / curve));
  }
  return { x: Math.cos(screenAngle) * mag, y: Math.sin(screenAngle) * mag, mag, err };
}

// ---- Session scoring -------------------------------------------------------

let current = null;  // accumulators for the ring being tracked
let session = freshSession();

function freshSession() {
  return { rings: 0, hits: 0, stickErrSum: 0, boostErrSum: 0, last: null };
}

/**
 * Accumulate stick/boost error for the ring currently being tracked.
 * When ringId changes, the previous ring is finalised into session stats.
 *
 * @param {number} dt
 * @param {{ringId:*, stickErr:number, boostErr:number, missDist:number, innerR:number}} f
 */
export function scoreFrame(dt, f) {
  if (!current || current.ringId !== f.ringId) {
    finishRing();
    current = { ringId: f.ringId, time: 0, stickErr: 0, boostErr: 0, missDist: Infinity, innerR: f.innerR };
  }
  current.time += dt;
  current.stickErr += f.stickErr * dt;
  current.boostErr += f.boostErr * dt;
  current.missDist = f.missDist;
  current.innerR = f.innerR;
}

function finishRing() {
  if (!current || current.time <= 0.2) { current = null; return; }
  const r = {
    stickErr: current.stickErr / current.time,
    boostErr: current.boostErr / current.time,
    hit: current.missDist <= current.innerR
  };
  session.rings++;
  if (r.hit) session.hits++;
  session.stickErrSum += r.stickErr;
  session.boostErrSum += r.boostErr;
  session.last = r;
  current = null;
}

/** Finalise any in-flight ring (call when a ring is passed / mode ends). */
export function endRing() { finishRing(); }

export function resetStats() { current = null; session = freshSession(); }

export function getSessionStats() {
  const n = session.rings;
  return {
    rings: n,
    hits: session.hits,
    avgStickErr: n ? session.stickErrSum / n : 0,
    avgBoostErr: n ? session.boostErrSum / n : 0,
    last: session.last
  };
}

// ============================================================================
// LIVE COACH STATE (updated from the physics step)
// ============================================================================

let snap = null;          // latest computed coaching data, null when inactive
let boostAvg = 0;         // smoothed actual boost duty
let prevErr = null;
let aimAngle = null;      // target nose angle shown to the player (frozen while coasting)
let pulsePhase = 0;       // boost light PWM phase

// Coach levels (Settings -> Game -> Coach level). Each adds difficulty and removes help.
export const LEVELS = {
  0: { name: 'Off' },
  1: { name: 'Steer', difficulty: 'easy', lock: true, cues: 'always' },
  2: { name: 'Hover', difficulty: 'normal', lock: true, cues: 'always' },
  3: { name: 'Full control', difficulty: 'normal', lock: false, cues: 'always' },
  4: { name: 'Fade', difficulty: 'normal', lock: false, cues: 'when-off' }
};
const PULSE_PERIOD = 0.6;   // s (game time) - slow enough to follow by hand
const COAST_DUTY = 0.08;    // below this: let go of boost

/**
 * Called every physics step from ringMode.updateRingModePhysics().
 *
 * @param {number} dt - game-time step
 * @param {object} s
 * @param {{x:number,y:number}} s.pos
 * @param {{x:number,y:number}} s.vel
 * @param {{x:number,y:number,z:number,w:number}} s.quat
 * @param {boolean} s.boostActive
 * @param {{id:*, x:number, y:number, innerR:number, outerR:number, arrival:number}|null} s.target
 * @param {boolean} s.easy
 * @param {number} s.gravity - signed gravity accel (0 handled via easy)
 * @param {{x:number,y:number}|null} s.stick - live stick, unit-disc screen coords
 * @param {{wMax?:number,deadzone?:number,curve?:number,range?:number}} [s.shaping]
 * @param {Array<{x:number,y:number,z:number}>} [s.path] - upcoming ring centres, arrival order
 */
export function update(dt, s) {
  boostAvg += ((s.boostActive ? 1 : 0) - boostAvg) * (1 - Math.exp(-dt / BOOST_AVG_TAU));

  if (!s.target) {
    snap = null;
    prevErr = null;
    endRing();
    return;
  }

  const opts = { gravity: s.gravity, easy: s.easy };
  const fwd = noseOf(s.quat);
  const nose = { x: fwd.x, y: fwd.y };
  const t = Math.max(0, s.target.arrival);

  const coast = predictLanding(s.pos, s.vel, nose, false, t, opts);
  const full = predictLanding(s.pos, s.vel, nose, true, t, opts);
  const now = s.boostActive ? full : coast;

  const ideal = idealInput(s.pos, s.vel, s.target, t, opts);

  const err = noseError(ideal.noseDir, s.quat);
  const rate = prevErr === null || dt <= 0 ? 0 : (err - prevErr) / dt;
  const targetStick = stickForNose(ideal.noseDir, s.quat, rate, s.shaping);
  prevErr = targetStick.err;

  // Hold the stick at neutral when no boost is needed: nothing to aim.
  const live = s.stick || { x: 0, y: 0 };
  const stickErr = Math.hypot(targetStick.x - live.x, targetStick.y - live.y);
  const boostErr = Math.abs(ideal.duty - boostAvg);

  // Where we'd end up relative to ring centre if we keep the current input
  const missDist = Math.hypot(now.x - s.target.x, (s.easy ? 0 : now.y - s.target.y));
  scoreFrame(dt, { ringId: s.target.id, stickErr, boostErr, missDist, innerR: s.target.innerR });

  // Can the ring still be made? Ring centre within innerR of the coast->full segment.
  const inSpread = distToSegment(s.target, coast, full) <= s.target.innerR;

  // Simple-mode cues: where the nose points / should point on screen, and a
  // boost light that blinks at the wanted duty (slow PWM a thumb can follow).
  const coasting = ideal.duty < COAST_DUTY;
  if (!coasting || aimAngle === null) aimAngle = ideal.noseAngle;
  pulsePhase = (pulsePhase + dt / PULSE_PERIOD) % 1;
  const boostLight = ideal.duty > 1 - COAST_DUTY ? true : coasting ? false : pulsePhase < ideal.duty;
  const noseAngle = Math.atan2(nose.y, nose.x);
  const noseInPlane = Math.hypot(nose.x, nose.y);
  let turn = aimAngle - noseAngle;
  turn = Math.atan2(Math.sin(turn), Math.cos(turn));   // + = anticlockwise on screen

  snap = {
    pos: s.pos, vel: s.vel, nose, target: s.target, t,
    coast, full, now, ideal, targetStick, stick: live,
    stickErr, boostErr, boostActual: boostAvg, inSpread,
    coasting, aimAngle, noseAngle, noseInPlane, turn, boostLight,
    boostActive: !!s.boostActive, path: s.path || []
  };
}

function distToSegment(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  let u = l2 > 1e-9 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2 : 0;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(p.x - (a.x + abx * u), p.y - (a.y + aby * u));
}

export function getSnapshot() { return snap; }

export function reset() { snap = null; prevErr = null; aimAngle = null; pulsePhase = 0; boostAvg = 0; resetStats(); }

// ============================================================================
// OVERLAYS
// ============================================================================

const CAR_LEN = CONST.CAR_WIDTH * CONST.CAR_SCALE;   // nominal footprint on the wall
const CAR_WID = CONST.CAR_HEIGHT * CONST.CAR_SCALE;

/**
 * Draw all enabled overlays. Called from rendering.renderHUD after the HUD.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view
 * @param {(x:number,y:number,z?:number)=>{x:number,y:number,behind:boolean}} view.project
 * @param {{ghost:boolean,shadow:boolean,velocity:boolean,stick:boolean}} view.flags
 * @param {number} view.width
 * @param {number} view.height
 * @param {boolean} view.active - ring mode running (not paused / game over)
 * @param {number} [view.level] - coach level; > 0 replaces the overlays with the simple guide
 */
export function draw(ctx, view) {
  if (!ctx || !view || !view.active || !snap) return;
  if (view.level > 0) { ctx.save(); drawLevel(ctx, view); ctx.restore(); return; }
  const f = view.flags;
  if (!f.ghost && !f.shadow && !f.velocity && !f.stick) return;

  ctx.save();
  if (f.shadow) drawShadow(ctx, view);
  if (f.ghost) drawGhost(ctx, view);
  if (f.velocity) drawVelocity(ctx, view);
  if (f.stick) drawStickPanel(ctx, view);
  ctx.restore();
}

function px(view, x, y) { return view.project(x, y, 0); }

/** Screen pixels per grid unit near (x,y) on the wall plane. */
function pixelsPerUnit(view, x, y) {
  const a = px(view, x, y), b = px(view, x + 100, y);
  return Math.hypot(b.x - a.x, b.y - a.y) / 100;
}

function drawShadow(ctx, view) {
  const { target, t } = snap;
  const r = target.outerR - CONST.RING_TUBE_RADIUS;   // ring centre-line radius
  const c = px(view, target.x, target.y);
  if (c.behind) return;

  ctx.strokeStyle = snap.inSpread ? 'rgba(80,255,140,0.9)' : 'rgba(255,200,80,0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const p = px(view, target.x + Math.cos(a) * r, target.y + Math.sin(a) * r);
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 18px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${t.toFixed(1)}s`, c.x, c.y);
}

function drawGhost(ctx, view) {
  const { coast, full, now, nose, inSpread } = snap;
  const col = inSpread ? '80,255,140' : '255,90,90';

  const pc = px(view, coast.x, coast.y), pf = px(view, full.x, full.y);
  ctx.strokeStyle = `rgba(${col},0.8)`;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(pc.x, pc.y);
  ctx.lineTo(pf.x, pf.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // End caps: coast / full boost
  for (const [p, label] of [[pc, 'C'], [pf, 'B']]) {
    ctx.fillStyle = `rgba(${col},0.9)`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, p.x, p.y - 6);
  }

  // Translucent car at the predicted spot (with current boost state), nose-oriented
  const pn = px(view, now.x, now.y);
  const scale = pixelsPerUnit(view, now.x, now.y);
  const ang = Math.atan2(-nose.y, nose.x); // screen y is down
  ctx.save();
  ctx.translate(pn.x, pn.y);
  ctx.rotate(ang);
  const L = CAR_LEN * scale, W = CAR_WID * scale;
  ctx.fillStyle = `rgba(${col},0.35)`;
  ctx.strokeStyle = `rgba(${col},0.95)`;
  ctx.lineWidth = 2;
  roundRect(ctx, -L / 2, -W / 2, L, W, W * 0.3);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();            // nose tick
  ctx.moveTo(L / 2, 0);
  ctx.lineTo(L / 2 + W * 0.4, 0);
  ctx.stroke();
  ctx.restore();
}

function drawVelocity(ctx, view) {
  const { pos, vel } = snap;
  const a = px(view, pos.x, pos.y);
  const lead = 0.5; // seconds of travel the arrow shows
  const b = px(view, pos.x + vel.x * lead, pos.y + vel.y * lead);
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 6) return;
  const ux = dx / len, uy = dy / len;
  ctx.strokeStyle = 'rgba(90,200,255,0.95)';
  ctx.fillStyle = 'rgba(90,200,255,0.95)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - ux * 12 - uy * 6, b.y - uy * 12 + ux * 6);
  ctx.lineTo(b.x - ux * 12 + uy * 6, b.y - uy * 12 - ux * 6);
  ctx.closePath();
  ctx.fill();
}

/**
 * Stick guide on the circle around the car. The circle is the stick's full
 * throw: the green dot is exactly where the stick should be (near the centre
 * = a small push), the white dot is where it is now. Put white on green.
 * A boost gauge sits beside the circle.
 */
function drawStickPanel(ctx, view) {
  const { targetStick, stick, ideal, boostActual } = snap;
  const cx = view.width / 2, cy = view.height / 2, R = 170;

  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  // Faint half-throw ring + centre cross so small pushes are readable
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.arc(cx, cy, R / 2, 0, Math.PI * 2);
  ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy);
  ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8);
  ctx.stroke();

  const clampDisc = v => { const m = Math.hypot(v.x, v.y); return m > 1 ? { x: v.x / m, y: v.y / m } : v; };
  const tv = clampDisc(targetStick), lv = clampDisc(stick);
  const tx = cx + tv.x * R, ty = cy + tv.y * R;
  const lx = cx + lv.x * R, ly = cy + lv.y * R;

  // Error line from where the stick is to where it should be
  ctx.strokeStyle = 'rgba(255,90,90,0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(lx, ly);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgb(80,255,140)';
  ctx.strokeStyle = '#0f1116';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(tx, ty, 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  if (targetStick.mag === 0) {
    ctx.fillStyle = 'rgba(80,255,140,0.9)';
    ctx.font = 'bold 14px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('nose on target - stick centred', cx, cy - R - 14);
  }

  // Boost gauge: fill = actual duty, tick = target duty
  const bx = cx + R + 22, bh = 120, by = cy - bh / 2, bw = 16;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.fillStyle = 'rgba(255,170,60,0.85)';
  ctx.fillRect(bx, by + bh * (1 - boostActual), bw, bh * boostActual);
  const dutyY = by + bh * (1 - ideal.duty);
  ctx.strokeStyle = 'rgb(80,255,140)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(bx - 6, dutyY); ctx.lineTo(bx + bw + 6, dutyY);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '12px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('BOOST', bx - 4, by - 18);
  ctx.fillText(`want ${Math.round(ideal.duty * 100)}%`, bx + bw + 10, by + 4);
  ctx.fillText(`have ${Math.round(boostActual * 100)}%`, bx + bw + 10, by + 20);
  if (!ideal.reachable) {
    ctx.fillStyle = 'rgb(255,120,120)';
    ctx.fillText('too far!', bx + bw + 10, by + 40);
  }
}

// ============================================================================
// SIMPLE GUIDE (coach levels 1-4)
// ============================================================================

/**
 * One needle (where your nose points = where boost pushes you), one green
 * notch (where it should point), one curved arrow between them, one line of
 * text telling you which way to push the stick, a boost light, and a numbered
 * path through the next rings. Nothing else.
 */
function drawLevel(ctx, view) {
  const lv = LEVELS[view.level] || LEVELS[1];
  const { turn, ideal, boostLight, boostActive, coasting, targetStick } = snap;

  drawPath(ctx, view);

  const offCourse = Math.abs(turn) > 0.45 || (boostLight !== boostActive && !coasting && Math.abs(ideal.duty - snap.boostActual) > 0.35);
  if (lv.cues === 'when-off' && !offCourse) return;

  const c = px(view, snap.pos.x, snap.pos.y);
  const R = 150;

  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
  ctx.stroke();

  // Screen angles: world y is up, canvas y is down
  const scr = a => -a;
  const nA = scr(snap.noseAngle), tA = scr(snap.aimAngle);

  // Turn arrow along the circle, nose -> target
  if (Math.abs(turn) > 0.1) {
    const end = nA - turn; // canvas angle direction is flipped
    ctx.strokeStyle = 'rgba(255,215,64,0.95)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R, nA, end, turn > 0);
    ctx.stroke();
    // arrowhead at the target end, pointing along the turn
    const dir = turn > 0 ? -1 : 1;
    const hx = c.x + Math.cos(end) * R, hy = c.y + Math.sin(end) * R;
    const tx = -Math.sin(end) * dir, ty = Math.cos(end) * dir;   // tangent
    const nx = Math.cos(end), ny = Math.sin(end);                // normal
    ctx.fillStyle = 'rgba(255,215,64,0.95)';
    ctx.beginPath();
    ctx.moveTo(hx + tx * 14, hy + ty * 14);
    ctx.lineTo(hx - tx * 4 + nx * 10, hy - ty * 4 + ny * 10);
    ctx.lineTo(hx - tx * 4 - nx * 10, hy - ty * 4 - ny * 10);
    ctx.closePath();
    ctx.fill();
  }

  // Target notch (green wedge on the circle)
  ctx.fillStyle = coasting ? 'rgba(80,255,140,0.45)' : 'rgb(80,255,140)';
  ctx.beginPath();
  ctx.moveTo(c.x + Math.cos(tA) * (R - 16), c.y + Math.sin(tA) * (R - 16));
  ctx.lineTo(c.x + Math.cos(tA + 0.09) * (R + 18), c.y + Math.sin(tA + 0.09) * (R + 18));
  ctx.lineTo(c.x + Math.cos(tA - 0.09) * (R + 18), c.y + Math.sin(tA - 0.09) * (R + 18));
  ctx.closePath();
  ctx.fill();

  // Nose needle (white): where boost will push you
  const faint = snap.noseInPlane < 0.35;
  ctx.strokeStyle = faint ? 'rgba(255,255,255,0.4)' : '#fff';
  ctx.lineWidth = 4;
  if (faint) ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(c.x + Math.cos(nA) * 40, c.y + Math.sin(nA) * 40);
  ctx.lineTo(c.x + Math.cos(nA) * (R + 10), c.y + Math.sin(nA) * (R + 10));
  ctx.stroke();
  ctx.setLineDash([]);

  // One instruction line
  let text;
  if (faint) text = 'Nose is pointing at/away from the camera - turn it back flat';
  else if (targetStick.mag === 0 || Math.abs(turn) < 0.1) text = 'Stick: centre  \u2713';
  else text = 'Stick: ' + stickWords(targetStick, lv.lock);
  ctx.font = 'bold 22px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.strokeText(text, c.x, c.y + R + 26);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, c.x, c.y + R + 26);

  // Boost light
  const bx = c.x + R + 40, by = c.y - 18;
  ctx.fillStyle = boostLight ? 'rgb(255,170,60)' : 'rgba(255,255,255,0.08)';
  ctx.strokeStyle = boostLight ? 'rgb(255,200,120)' : 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  roundRect(ctx, bx, by, 96, 36, 18);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = boostLight ? '#111' : 'rgba(255,255,255,0.8)';
  ctx.font = 'bold 15px system-ui';
  ctx.textBaseline = 'middle';
  ctx.fillText(boostLight ? 'BOOST' : 'let go', bx + 48, by + 18);
  if (!ideal.reachable) {
    ctx.fillStyle = 'rgb(255,120,120)';
    ctx.font = 'bold 13px system-ui';
    ctx.fillText('too far - get close as you can', bx + 48, by + 52);
  }
}

/** "RIGHT a little", "UP-LEFT hard", ... from a target stick vector. */
function stickWords(st, horizontalOnly) {
  const ax = Math.abs(st.x), ay = Math.abs(st.y);
  let dir;
  if (horizontalOnly || ax > ay * 2) dir = st.x > 0 ? 'RIGHT \u25B6' : '\u25C0 LEFT';
  else if (ay > ax * 2) dir = st.y > 0 ? 'DOWN \u25BC' : 'UP \u25B2';
  else dir = (st.y > 0 ? 'DOWN' : 'UP') + '-' + (st.x > 0 ? 'RIGHT' : 'LEFT');
  const m = st.mag;
  const amount = m < 0.4 ? 'a little' : m < 0.75 ? '' : 'hard';
  return (dir + ' ' + amount).trim();
}

/** Numbered dotted path from the car through the next rings. */
function drawPath(ctx, view) {
  const pts = [px(view, snap.pos.x, snap.pos.y)];
  for (const r of snap.path.slice(0, 4)) {
    const p = view.project(r.x, r.y, r.z);
    if (p.behind) break;
    pts.push(p);
  }
  if (pts.length < 2) return;
  ctx.lineWidth = 3;
  for (let i = 1; i < pts.length; i++) {
    ctx.strokeStyle = i === 1 ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)';
    ctx.setLineDash(i === 1 ? [] : [10, 8]);
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = 'bold 16px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 1; i < pts.length; i++) {
    ctx.fillStyle = i === 1 ? 'rgb(80,255,140)' : 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.fillText(String(i), pts[i].x, pts[i].y + 1);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
