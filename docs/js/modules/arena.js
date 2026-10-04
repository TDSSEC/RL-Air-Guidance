/**
 * Arena Module - 3D depth cues for Ring Mode
 *
 * Purely visual: the car still moves on its flat XY plane at z = 0 (the coach
 * maths depends on that). This adds things to judge depth against:
 *   1. Corridor - floor, ceiling and side walls around the car, receding
 *      into the distance, with depth "rungs" every RUNG_STEP units.
 *   2. Ring shadows - each incoming ring gets a drop line to the floor and a
 *      shadow on the floor and both side walls. The car gets matching markers
 *      plus "rails" running forward from its shadows: when a ring's shadow sits
 *      on your rail, you're lined up on that axis.
 *
 * Hooked from ringMode.updateRingModeRendering(); toggles in Settings -> Game.
 */

import * as THREE from 'three';

// The camera only frames ~±400 units around the car, so walls at the real
// play boundary (±1500) would be off-screen. Instead the corridor box rides
// with the car, sitting just outside the view - but its grid lines are fixed
// in the world, so you see yourself move against them.
const HALF_W = 650;                 // car -> side wall
const HALF_H = 420;                 // car -> floor / ceiling
const Z_NEAR = 200;                 // corridor ends just past the car plane
const Z_FAR = -2600;                // fog hides anything further
const LANE_STEP = 150;              // world-fixed spacing of lines running into the distance
const RUNG_STEP = 250;              // spacing of depth rungs
const MAX_RINGS = 16;
const MAX_CORRIDOR_SEGS = 400;

const LINE_COLOR = 0x4c8dff;
const CAR_COLOR = 0xffffff;

let scene = null;
let corridor = null;
let shadowGroup = null;
let dropLines = null;
let rails = null;
let carMarks = [];
let pool = [];          // per-ring { floor, left, right } shadow meshes
let circleGeom = null;

// ============================================================================
// BUILD
// ============================================================================

function dynamicLines(maxSegments, color, opacity, fog = true) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxSegments * 6), 3));
  geom.setDrawRange(0, 0);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false, fog });
  const l = new THREE.LineSegments(geom, mat);
  l.frustumCulled = false;
  return l;
}

function shadowMesh(color, opacity) {
  const m = new THREE.Mesh(circleGeom, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, fog: false
  }));
  m.visible = false;
  return m;
}

function buildShadows() {
  shadowGroup = new THREE.Group();
  circleGeom = new THREE.CircleGeometry(1, 40);

  for (let i = 0; i < MAX_RINGS; i++) {
    const s = { floor: shadowMesh(0xffffff, 0.3), left: shadowMesh(0xffffff, 0.3), right: shadowMesh(0xffffff, 0.3) };
    s.floor.rotation.x = -Math.PI / 2;      // lie on the floor (XZ)
    s.left.rotation.y = Math.PI / 2;        // lie on the walls (YZ)
    s.right.rotation.y = Math.PI / 2;
    shadowGroup.add(s.floor, s.left, s.right);
    pool.push(s);
  }

  dropLines = dynamicLines(MAX_RINGS, 0xffffff, 0.55, false);
  rails = dynamicLines(3, CAR_COLOR, 0.5);
  shadowGroup.add(dropLines, rails);

  // Car markers: floor, left wall, right wall
  carMarks = [shadowMesh(CAR_COLOR, 0.85), shadowMesh(CAR_COLOR, 0.85), shadowMesh(CAR_COLOR, 0.85)];
  carMarks[0].rotation.x = -Math.PI / 2;
  carMarks[1].rotation.y = Math.PI / 2;
  carMarks[2].rotation.y = Math.PI / 2;
  shadowGroup.add(...carMarks);
}

/** Rebuild corridor lines around the car (box moves, lines stay world-fixed). */
function updateCorridor(cx, cy) {
  const x0 = cx - HALF_W, x1 = cx + HALF_W, y0 = cy - HALF_H, y1 = cy + HALF_H;
  const pos = corridor.geometry.attributes.position;
  let n = 0;
  const seg = (ax, ay, az, bx, by, bz) => {
    if (n >= MAX_CORRIDOR_SEGS) return;
    pos.setXYZ(n * 2, ax, ay, az);
    pos.setXYZ(n * 2 + 1, bx, by, bz);
    n++;
  };
  // Lanes running into the distance, at world-fixed x (floor/ceiling) and y (walls)
  for (let x = Math.ceil(x0 / LANE_STEP) * LANE_STEP; x <= x1; x += LANE_STEP) {
    seg(x, y0, Z_NEAR, x, y0, Z_FAR);
    seg(x, y1, Z_NEAR, x, y1, Z_FAR);
  }
  for (let y = Math.ceil(y0 / LANE_STEP) * LANE_STEP; y <= y1; y += LANE_STEP) {
    seg(x0, y, Z_NEAR, x0, y, Z_FAR);
    seg(x1, y, Z_NEAR, x1, y, Z_FAR);
  }
  // Box edges
  seg(x0, y0, Z_NEAR, x0, y0, Z_FAR); seg(x1, y0, Z_NEAR, x1, y0, Z_FAR);
  seg(x0, y1, Z_NEAR, x0, y1, Z_FAR); seg(x1, y1, Z_NEAR, x1, y1, Z_FAR);
  // Depth rungs: a frame around the cross-section every RUNG_STEP
  for (let z = 0; z >= Z_FAR; z -= RUNG_STEP) {
    seg(x0, y0, z, x1, y0, z);
    seg(x1, y0, z, x1, y1, z);
    seg(x1, y1, z, x0, y1, z);
    seg(x0, y1, z, x0, y0, z);
  }
  pos.needsUpdate = true;
  corridor.geometry.setDrawRange(0, n * 2);
}

// ============================================================================
// PUBLIC
// ============================================================================

/**
 * Per-frame update from Ring Mode.
 * @param {THREE.Scene} sceneRef
 * @param {object} s
 * @param {boolean} s.active - ring mode running
 * @param {boolean} s.corridor - show corridor
 * @param {boolean} s.shadows - show ring shadows / drop lines
 * @param {Array} s.rings - ring objects ({mesh, size, passed, missed, spawnIndex})
 * @param {{x:number,y:number}} s.car - car position on the plane
 */
export function update(sceneRef, s) {
  if (sceneRef !== scene) { dispose(); scene = sceneRef; }
  if (!scene) return;

  const wantCorridor = s.active && s.corridor;
  const wantShadows = s.active && s.shadows;
  const { x: cx, y: cy } = s.car;

  if (wantCorridor && !corridor) {
    corridor = dynamicLines(MAX_CORRIDOR_SEGS, LINE_COLOR, 0.4);
    corridor.renderOrder = -1;
    scene.add(corridor);
  }
  if (corridor) {
    corridor.visible = wantCorridor;
    if (wantCorridor) updateCorridor(cx, cy);
  }

  if (wantShadows && !shadowGroup) { buildShadows(); scene.add(shadowGroup); }
  if (!shadowGroup) return;
  shadowGroup.visible = wantShadows;
  if (!wantShadows) return;

  const floorY = cy - HALF_H, leftX = cx - HALF_W, rightX = cx + HALF_W, ceilY = cy + HALF_H;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // Upcoming rings in arrival order; the first one is the target
  const upcoming = s.rings
    .filter(r => r && r.mesh && !r.passed && !r.missed && r.mesh.position.z < 0)
    .sort((a, b) => a.spawnIndex - b.spawnIndex)
    .slice(0, MAX_RINGS);

  const drop = dropLines.geometry.attributes.position;
  for (let i = 0; i < MAX_RINGS; i++) {
    const sh = pool[i];
    const r = upcoming[i];
    if (!r) { sh.floor.visible = sh.left.visible = sh.right.visible = false; continue; }

    const { x, y, z } = r.mesh.position;
    const rad = r.size / 2;
    const target = i === 0;
    const col = r.mesh.material && r.mesh.material.color ? r.mesh.material.color : null;
    const thick = target ? 45 : 30;

    // Shadows sit on the visible corridor surfaces. A ring beyond a wall is
    // pinned to that edge and drawn faint, meaning "further that way".
    const fx = clamp(x, leftX, rightX), wy = clamp(y, floorY, ceilY);
    const fxOut = fx !== x, wyOut = wy !== y;
    const base = target ? 0.6 : 0.25;

    for (const m of [sh.floor, sh.left, sh.right]) {
      m.visible = true;
      if (col) m.material.color.copy(col);
    }
    sh.floor.material.opacity = fxOut ? base * 0.4 : base;
    sh.left.material.opacity = sh.right.material.opacity = wyOut ? base * 0.4 : base;

    sh.floor.position.set(fx, floorY + 2, z);
    sh.floor.scale.set(rad, thick, 1);
    sh.left.position.set(leftX + 2, wy, z);
    sh.left.scale.set(thick, rad, 1);
    sh.right.position.set(rightX - 2, wy, z);
    sh.right.scale.set(thick, rad, 1);

    // Drop line from the ring's lowest point down to its floor shadow
    drop.setXYZ(i * 2, x, Math.max(floorY, y - rad), z);
    drop.setXYZ(i * 2 + 1, fx, floorY, z);
  }
  drop.needsUpdate = true;
  dropLines.geometry.setDrawRange(0, upcoming.length * 2);

  // Car markers + rails running forward from them ("your line")
  carMarks[0].position.set(cx, floorY + 3, 0);
  carMarks[1].position.set(leftX + 3, cy, 0);
  carMarks[2].position.set(rightX - 3, cy, 0);
  for (const m of carMarks) { m.scale.set(22, 22, 1); m.visible = true; }

  const rp = rails.geometry.attributes.position;
  rp.setXYZ(0, cx, floorY + 3, 0); rp.setXYZ(1, cx, floorY + 3, Z_FAR);
  rp.setXYZ(2, leftX + 3, cy, 0); rp.setXYZ(3, leftX + 3, cy, Z_FAR);
  rp.setXYZ(4, rightX - 3, cy, 0); rp.setXYZ(5, rightX - 3, cy, Z_FAR);
  rp.needsUpdate = true;
  rails.geometry.setDrawRange(0, 6);
}

/** Hide everything (ring mode stopped). */
export function hide() {
  if (corridor) corridor.visible = false;
  if (shadowGroup) shadowGroup.visible = false;
}

/** Remove and free all arena objects. */
export function dispose() {
  if (corridor) {
    if (scene) scene.remove(corridor);
    corridor.geometry.dispose();
    corridor.material.dispose();
    corridor = null;
  }
  if (shadowGroup) {
    if (scene) scene.remove(shadowGroup);
    shadowGroup.traverse(o => {
      if (o.material) o.material.dispose();
      if (o.geometry && o.geometry !== circleGeom) o.geometry.dispose();
    });
    if (circleGeom) circleGeom.dispose();
    shadowGroup = null;
    circleGeom = null;
    dropLines = null;
    rails = null;
    carMarks = [];
    pool = [];
  }
}
