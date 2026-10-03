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
const MIN_T = 0.12;           // below this, 1/t² blows up - clamp the horizon
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
 * Uses the same car-frame convention as the existing Input Assist compass
 * (stick angle 0 = driver's "up"), then sets stick magnitude with a PD law
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
  const right = { x: -fwd.y * up.z + fwd.z * up.y, y: -fwd.z * up.x + fwd.x * up.z, z: -fwd.x * up.y + fwd.y * up.x }; // fwd x up

  const tl = Math.hypot(targetDir.x, targetDir.y);
  const to = tl > 1e-9 ? { x: targetDir.x / tl, y: targetDir.y / tl, z: 0 } : { x: 0, y: 1, z: 0 };
  const fc = Math.max(-1, Math.min(1, dot(to, fwd)));
  const err = Math.acos(fc);

  const plank = { x: to.x - fwd.x * fc, y: to.y - fwd.y * fc, z: to.z - fwd.z * fc };
  const plen = Math.hypot(plank.x, plank.y, plank.z);

  if (err < PD_DEADBAND || plen < 1e-6) return { x: 0, y: 0, mag: 0, err };

  let stickAngle = Math.atan2(dot(plank, right) / plen, -dot(plank, up) / plen);
  if (fc < 0) stickAngle += Math.PI;
  const screenAngle = stickAngle - Math.PI / 2;

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

  snap = {
    pos: s.pos, vel: s.vel, nose, target: s.target, t,
    coast, full, now, ideal, targetStick, stick: live,
    stickErr, boostErr, boostActual: boostAvg, inSpread
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

export function reset() { snap = null; prevErr = null; boostAvg = 0; resetStats(); }

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
 */
export function draw(ctx, view) {
  if (!ctx || !view || !view.active || !snap) return;
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

function drawStickPanel(ctx, view) {
  const { targetStick, stick, ideal, boostActual } = snap;
  const R = 52;
  const cx = view.width / 2 - 70;
  const cy = view.height - R - 28;

  // Backing
  ctx.fillStyle = 'rgba(10,12,18,0.55)';
  roundRect(ctx, cx - R - 14, cy - R - 14, R * 2 + 14 + 150, R * 2 + 28, 12);
  ctx.fill();

  // Stick well
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.globalAlpha = 0.25;
  ctx.stroke();
  ctx.globalAlpha = 1;

  const tx = cx + targetStick.x * R, ty = cy + targetStick.y * R;
  const lx = cx + stick.x * R, ly = cy + stick.y * R;

  // Error line
  ctx.strokeStyle = 'rgba(255,90,90,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(lx, ly);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  // Live stick (white) and target (green)
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(lx, ly, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgb(80,255,140)';
  ctx.strokeStyle = '#0f1116';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(tx, ty, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  // Boost bar: fill = actual duty, tick = target duty
  const bx = cx + R + 28, by = cy - R, bw = 22, bh = R * 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.fillStyle = 'rgba(255,170,60,0.85)';
  ctx.fillRect(bx, by + bh * (1 - boostActual), bw, bh * boostActual);
  const ty2 = by + bh * (1 - ideal.duty);
  ctx.strokeStyle = 'rgb(80,255,140)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(bx - 6, ty2); ctx.lineTo(bx + bw + 6, ty2);
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = '12px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('BOOST', bx + bw + 12, by);
  ctx.fillText(`want ${Math.round(ideal.duty * 100)}%`, bx + bw + 12, by + 16);
  ctx.fillText(`have ${Math.round(boostActual * 100)}%`, bx + bw + 12, by + 32);
  if (!ideal.reachable) {
    ctx.fillStyle = 'rgb(255,120,120)';
    ctx.fillText('too far!', bx + bw + 12, by + 52);
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
