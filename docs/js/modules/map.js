/**
 * Map Module - "Ice Rings" environment for Ring Mode
 *
 * Turns the flat grid into a rings map you fly through: an icy floor at the
 * bottom of the play area, rock walls at its sides, misty sky, snow drifting
 * past, and rings that look like the ones in community rings maps - thick
 * teal hoops on poles standing up out of the ice.
 *
 * The physics are unchanged: the car still moves on its XY plane at z = 0 and
 * rings travel toward it. Here the world scrolls toward the camera at the
 * target ring's speed, so it reads as flying forward through a course. The
 * floor and walls sit exactly on the out-of-bounds limits (RING_GRID_BOUNDS),
 * so touching them is what loses a life.
 *
 * Hooked from ringMode.updateRingModeRendering(); Settings -> Game -> Map.
 */

import * as THREE from 'three';
import * as CONST from './constants.js';

const B = CONST.RING_GRID_BOUNDS;          // floor at -B, walls at +-B
const Z_NEAR = 1400;                       // past the camera (camera z = 760)
const Z_FAR = -7000;
const LEN = Z_NEAR - Z_FAR;
const WALL_TOP = B + 900;
const PERIOD = 6000;                       // repeat length of scenery (scrolls and wraps)
const COPIES = 3;                          // copies of each scenery strip to cover the view

const SKY = 0xa7bccd;
const FOG_NEAR = 1300;
const FOG_FAR = 5200;
const RING_TEAL = 0x1d9fae;
const RING_TARGET = 0x6ff4ff;
const RING_TUBE = 22;                      // visual tube radius (collision still uses RING_TUBE_RADIUS)
const FADE_IN = 260;                       // units of travel over which a new ring fades in

let scene = null;
let root = null;                // everything the map adds
let floor = null, walls = [];
let strips = [];                // scrolling scenery copies
let snow = null;
let poles = null;
let ringGeom = null, poleGeom = null, shadowGeom = null;
let scroll = 0;
let saved = null;               // scene state to restore on hide
let hidden = [];                // objects we hid (grid etc.) and their old visibility

// ============================================================================
// PROCEDURAL TEXTURES (no image files needed)
// ============================================================================

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function canvasTexture(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Packed snow / ice: soft blotches, wind streaks running along the course. */
function iceTexture() {
  return canvasTexture(512, 512, (g, w, h) => {
    const r = rng(7);
    g.fillStyle = '#c9d6e0';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      const x = r() * w, y = r() * h, s = 6 + r() * 40;
      const l = 70 + r() * 22;
      g.fillStyle = `hsla(205, 22%, ${l}%, ${0.08 + r() * 0.12})`;
      g.beginPath(); g.ellipse(x, y, s, s * (0.3 + r() * 0.5), 0, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < 160; i++) {            // streaks along v (the course direction)
      const x = r() * w, y = r() * h, l = 30 + r() * 120;
      g.lineWidth = 1 + r() * 2;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 6, y + l); g.stroke();
    }
    g.strokeStyle = 'rgba(120,150,175,0.25)';   // a few cracks
    for (let i = 0; i < 18; i++) {
      let x = r() * w, y = r() * h;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (r() - 0.5) * 60; y += (r() - 0.5) * 60; g.lineTo(x, y); }
      g.stroke();
    }
  });
}

/** Dark blue-grey rock with strata and frost. */
function rockTexture() {
  return canvasTexture(512, 512, (g, w, h) => {
    const r = rng(11);
    g.fillStyle = '#56626f';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 700; i++) {
      const x = r() * w, y = r() * h, s = 8 + r() * 60;
      const l = 28 + r() * 22;
      g.fillStyle = `hsla(210, 12%, ${l}%, ${0.15 + r() * 0.2})`;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 5; k++) g.lineTo(x + (r() - 0.5) * s * 2, y + (r() - 0.5) * s);
      g.closePath(); g.fill();
    }
    g.strokeStyle = 'rgba(20,28,36,0.35)';
    for (let i = 0; i < 40; i++) {             // strata
      const y = r() * h;
      g.lineWidth = 1 + r() * 3;
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= w; x += 32) g.lineTo(x, y + Math.sin(x * 0.02 + i) * 6 + (r() - 0.5) * 4);
      g.stroke();
    }
    g.fillStyle = 'rgba(225,235,245,0.35)';    // frost
    for (let i = 0; i < 260; i++) {
      g.fillRect(r() * w, r() * h, 2 + r() * 10, 1 + r() * 2);
    }
  });
}

// ============================================================================
// GEOMETRY HELPERS
// ============================================================================

/** Low-poly rock: an icosahedron with jittered vertices, flat shaded. */
function rockGeometry(r, seed) {
  const g = new THREE.IcosahedronGeometry(1, 1);   // already non-indexed
  const p = g.attributes.position;
  const rand = rng(seed);
  // jitter shared corners consistently: key by rounded position
  const offs = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!offs.has(k)) offs.set(k, 0.7 + rand() * 0.6);
    const f = offs.get(k);
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.8, p.getZ(i) * f);
  }
  g.scale(r, r, r);
  g.computeVertexNormals();
  return g;
}

/** Merge non-indexed geometries (position + normal) into one, each with a transform. */
function merge(parts) {
  let n = 0;
  for (const { geom } of parts) n += geom.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  let o = 0;
  for (const { geom, matrix } of parts) {
    const p = geom.attributes.position, q = geom.attributes.normal;
    nm.getNormalMatrix(matrix);
    for (let i = 0; i < p.count; i++, o++) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      pos[o * 3] = v.x; pos[o * 3 + 1] = v.y; pos[o * 3 + 2] = v.z;
      v.fromBufferAttribute(q, i).applyMatrix3(nm).normalize();
      nor[o * 3] = v.x; nor[o * 3 + 1] = v.y; nor[o * 3 + 2] = v.z;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}

// ============================================================================
// BUILD
// ============================================================================

function build() {
  root = new THREE.Group();
  root.name = 'IceRingsMap';

  // Floor: one long plane on the bottom limit; its texture scrolls
  const iceTex = iceTexture();
  iceTex.repeat.set((2 * B + 1600) / 700, LEN / 700);
  floor = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * B + 1600, LEN),
    new THREE.MeshBasicMaterial({ map: iceTex, color: 0xdfe8ef })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -B, (Z_NEAR + Z_FAR) / 2);
  root.add(floor);

  // Rock walls on the side limits
  const rockTex = rockTexture();
  rockTex.repeat.set(LEN / 900, (WALL_TOP + B) / 900);
  for (const side of [-1, 1]) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(LEN, WALL_TOP + B),
      new THREE.MeshBasicMaterial({ map: side < 0 ? rockTex : rockTex.clone(), color: 0xb8c4cf })
    );
    m.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    m.position.set(side * B, (WALL_TOP - B) / 2, (Z_NEAR + Z_FAR) / 2);
    root.add(m);
    walls.push(m);
  }

  // Scenery strip: boulders along the wall bases and on top of the walls,
  // ice spikes on the floor edges, glowing lane lights - all in one period
  // that scrolls and wraps.
  const rand = rng(23);
  const rockParts = [], iceParts = [];
  const variants = [0, 1, 2, 3].map(i => rockGeometry(1, 100 + i));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), t = new THREE.Vector3();
  const place = (list, geom, x, y, z, sx, sy, sz, ry) => {
    e.set(rand() * 0.4, ry, rand() * 0.4);
    q.setFromEuler(e);
    m4.compose(t.set(x, y, z), q, s.set(sx, sy, sz));
    list.push({ geom, matrix: m4.clone() });
  };
  for (const side of [-1, 1]) {
    for (let z = 0; z > -PERIOD; z -= 260 + rand() * 260) {       // wall-base boulders
      const r = 140 + rand() * 260;
      place(rockParts, variants[(rand() * 4) | 0], side * (B - r * 0.35), -B + r * 0.3, z, r * (0.8 + rand() * 0.5), r * (0.6 + rand() * 0.6), r, rand() * 6.28);
    }
    for (let z = 0; z > -PERIOD; z -= 380 + rand() * 420) {       // ridge on top of the walls
      const r = 260 + rand() * 420;
      place(rockParts, variants[(rand() * 4) | 0], side * (B + r * 0.4), WALL_TOP - r * 0.2, z, r, r * (0.8 + rand() * 0.9), r, rand() * 6.28);
    }
    for (let z = -100; z > -PERIOD; z -= 700 + rand() * 900) {    // ice spikes on the floor
      const h = 120 + rand() * 260;
      const spike = new THREE.ConeGeometry(1, 1, 5).toNonIndexed();
      spike.computeVertexNormals();
      place(iceParts, spike, side * (B - 260 - rand() * 400), -B + h / 2, z, 40 + rand() * 40, h, 40 + rand() * 40, rand() * 6.28);
    }
  }
  const rockGeom = merge(rockParts);
  const iceGeom = merge(iceParts);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x46525e, roughness: 1, metalness: 0, flatShading: true });
  const iceMat = new THREE.MeshStandardMaterial({ color: 0xbfe6f2, roughness: 0.25, metalness: 0.1, flatShading: true, transparent: true, opacity: 0.85 });

  // Lane lights: small glowing pucks along both floor edges (like the yellow
  // pads in community maps) - also a steady speed cue.
  const lightParts = [];
  const puck = new THREE.CylinderGeometry(1, 1, 1, 10).toNonIndexed();
  puck.computeVertexNormals();
  for (const side of [-1, 1]) {
    for (let z = 0; z > -PERIOD; z -= 500) {
      m4.compose(t.set(side * (B - 120), -B + 6, z), q.identity(), s.set(55, 12, 55));
      lightParts.push({ geom: puck, matrix: m4.clone() });
    }
  }
  const lightGeom = merge(lightParts);
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xffe35a });

  // Edge lines on the floor (yellow boundary stripe)
  const stripeMat = new THREE.MeshBasicMaterial({ color: 0xf2d64b, transparent: true, opacity: 0.8 });
  for (const side of [-1, 1]) {
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(18, LEN), stripeMat);
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(side * (B - 40), -B + 2, (Z_NEAR + Z_FAR) / 2);
    root.add(stripe);
  }

  for (let i = 0; i < COPIES; i++) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(rockGeom, rockMat), new THREE.Mesh(iceGeom, iceMat), new THREE.Mesh(lightGeom, lightMat));
    g.children.forEach(c => { c.frustumCulled = false; });
    root.add(g);
    strips.push(g);
  }

  // Drifting snow around the camera
  const N = 700;
  const sp = new Float32Array(N * 3);
  const r2 = rng(5);
  for (let i = 0; i < N; i++) {
    sp[i * 3] = (r2() - 0.5) * 3600;
    sp[i * 3 + 1] = (r2() - 0.5) * 2400;
    sp[i * 3 + 2] = -r2() * 4000 + 800;
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  snow = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 7, transparent: true, opacity: 0.8, depthWrite: false }));
  snow.frustumCulled = false;
  snow.userData.base = sp.slice();
  root.add(snow);

  // Ring props: shared thick hoop geometry, poles and floor shadows
  ringGeom = new THREE.TorusGeometry(CONST.INITIAL_RING_SIZE / 2, RING_TUBE, 18, 64);
  ringGeom.userData.shared = true;
  poleGeom = new THREE.CylinderGeometry(1, 1, 1, 12);
  shadowGeom = new THREE.CircleGeometry(1, 40);
  poles = new THREE.Group();
  root.add(poles);
}

function poleMesh() {
  const m = new THREE.Mesh(poleGeom, new THREE.MeshStandardMaterial({ color: 0x17707b, roughness: 0.4, metalness: 0.3, transparent: true }));
  const sh = new THREE.Mesh(shadowGeom, new THREE.MeshBasicMaterial({ color: 0x24394a, transparent: true, opacity: 0.35, depthWrite: false }));
  sh.rotation.x = -Math.PI / 2;
  poles.add(m, sh);
  return { pole: m, shadow: sh };
}

// ============================================================================
// RINGS
// ============================================================================

/** Give a ring the map look (thick teal hoop, own material so it can fade in). */
function dressRing(r) {
  const mesh = r.mesh;
  if (!mesh.userData.mapDressed) {
    mesh.userData.origGeom = mesh.geometry;
    mesh.userData.origMat = mesh.material;
    mesh.geometry = ringGeom;
    mesh.material = new THREE.MeshStandardMaterial({
      color: RING_TEAL, emissive: RING_TEAL, emissiveIntensity: 0.35,
      metalness: 0.45, roughness: 0.25, transparent: true
    });
    const light = mesh.children.find(c => c.isLight);
    if (light) { mesh.userData.origLightColor = light.color.getHex(); light.color.setHex(RING_TEAL); }
    mesh.userData.mapDressed = true;
  }
}

/** Put a ring back to the classic look. */
function undressRing(r) {
  const mesh = r && r.mesh;
  if (!mesh || !mesh.userData.mapDressed) return;
  mesh.material.dispose();
  mesh.geometry = mesh.userData.origGeom;
  mesh.material = mesh.userData.origMat;
  const light = mesh.children.find(c => c.isLight);
  if (light && mesh.userData.origLightColor !== undefined) light.color.setHex(mesh.userData.origLightColor);
  mesh.userData.mapDressed = false;
}

// ============================================================================
// SCENE STATE
// ============================================================================

function applySceneLook(extraHide) {
  if (!saved) {
    saved = { background: scene.background, fog: scene.fog };
    hidden = [];
    // The classic grid wall and the red boundary box are replaced by the map
    scene.traverse(o => {
      if ((o.isGridHelper || o.type === 'GridHelper') && o.visible) hidden.push(o);
    });
    for (const o of extraHide) if (o && o.visible) hidden.push(o);
    hidden.forEach(o => { o.visible = false; });
  }
  if (!(scene.background && scene.background.isColor && scene.background.getHex() === SKY)) scene.background = new THREE.Color(SKY);
  if (!scene.fog || scene.fog.color.getHex() !== SKY || scene.fog.near !== FOG_NEAR) scene.fog = new THREE.Fog(SKY, FOG_NEAR, FOG_FAR);
}

function restoreSceneLook() {
  if (!saved) return;
  scene.background = saved.background;
  scene.fog = saved.fog;
  hidden.forEach(o => { o.visible = true; });
  hidden = [];
  saved = null;
}

// ============================================================================
// PUBLIC
// ============================================================================

/**
 * Per-frame update from Ring Mode.
 * @param {THREE.Scene} sceneRef
 * @param {object} s
 * @param {boolean} s.active - map wanted (ring mode running and setting on)
 * @param {Array} s.rings - ring objects ({mesh, size, speed, spawnZ, passed, missed, spawnIndex})
 * @param {boolean} s.moving - rings are moving this frame (started, not paused)
 * @param {number} s.dt - frame step (game seconds)
 * @param {Array} [s.hide] - extra objects to hide while the map shows (boundary box)
 */
export function update(sceneRef, s) {
  if (sceneRef !== scene) { dispose(); scene = sceneRef; }
  if (!scene) return;

  if (!s.active) { hide(s.rings); return; }
  if (!root) { build(); scene.add(root); }
  root.visible = true;
  applySceneLook(s.hide || []);

  const upcoming = s.rings
    .filter(r => r && r.mesh && !r.passed && !r.missed && r.mesh.position.z < 0)
    .sort((a, b) => a.spawnIndex - b.spawnIndex);

  // Scroll the world at the speed the target ring approaches
  const speed = s.moving && upcoming.length ? upcoming[0].speed : 0;
  scroll += speed * (s.dt || 0);
  const off = ((scroll % PERIOD) + PERIOD) % PERIOD;
  strips.forEach((g, i) => { g.position.z = off + PERIOD * (1 - i) + 600; });
  floor.material.map.offset.y = (scroll / 700) % 1;
  // Left wall's u runs away from the camera, right wall's toward it
  walls[0].material.map.offset.x = (scroll / 900) % 1;
  walls[1].material.map.offset.x = -(scroll / 900) % 1;

  // Snow: drift toward the camera with the course, fall slowly, wrap
  const sp = snow.geometry.attributes.position, base = snow.userData.base;
  const fall = (performance.now() / 1000) * 40;
  for (let i = 0; i < sp.count; i++) {
    const z = ((base[i * 3 + 2] - 800 + scroll * 1.0) % 4000 + 4000) % 4000 - 4000 + 800;
    const y = ((base[i * 3 + 1] - fall) % 2400 + 2400) % 2400 - 1200;
    sp.setXYZ(i, base[i * 3] + (s.camera ? s.camera.x : 0), y + (s.camera ? s.camera.y : 0), z);
  }
  sp.needsUpdate = true;

  // Rings: thick teal hoops on poles. The target glows; new rings fade in.
  let pi = 0;
  const kids = poles.children;
  for (const r of s.rings) {
    if (!r || !r.mesh) continue;
    dressRing(r);
    const mesh = r.mesh;
    const isTarget = r === upcoming[0];
    const travelled = mesh.position.z - (r.spawnZ ?? CONST.RING_SPAWN_DISTANCE);
    const fade = THREE.MathUtils.clamp(travelled / FADE_IN, 0, 1);
    const done = r.passed || r.missed;
    const mat = mesh.material;
    mat.color.setHex(isTarget ? RING_TARGET : RING_TEAL);
    mat.emissive.setHex(isTarget ? RING_TARGET : RING_TEAL);
    mat.emissiveIntensity = isTarget ? 0.75 : 0.3;
    mat.opacity = (done ? 0.35 : 1) * fade;

    if (done || mesh.position.z > 400) continue;
    // Pole from the bottom of the hoop down to the ice, plus a shadow
    const rad = r.size / 2;
    const bottom = mesh.position.y - rad - RING_TUBE;
    if (pi + 1 >= kids.length) poleMesh();
    const pole = kids[pi], sh = kids[pi + 1];
    pi += 2;
    const h = bottom + B;
    pole.visible = h > 10;
    if (pole.visible) {
      pole.position.set(mesh.position.x, -B + h / 2, mesh.position.z);
      pole.scale.set(12, h, 12);
      pole.material.opacity = fade;
    }
    sh.visible = true;
    sh.position.set(mesh.position.x, -B + 3, mesh.position.z);
    sh.scale.set(rad * 0.9, rad * 0.35, 1);
    sh.material.opacity = 0.35 * fade;
  }
  for (let i = pi; i < kids.length; i++) kids[i].visible = false;
}

/** Hide the map and restore the classic look (ring mode stopped or setting off). */
export function hide(rings) {
  if (root) root.visible = false;
  if (rings) rings.forEach(undressRing);
  if (scene) restoreSceneLook();
}

/** True when a geometry belongs to the map and must not be disposed with a ring. */
export function ownsGeometry(g) { return !!g && g === ringGeom; }

/** Remove and free all map objects. */
export function dispose() {
  if (scene) restoreSceneLook();
  if (root) {
    if (scene) scene.remove(root);
    const seen = new Set();
    root.traverse(o => {
      if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
      if (o.material && !seen.has(o.material)) {
        seen.add(o.material);
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
  }
  if (ringGeom) ringGeom.dispose();
  root = floor = snow = poles = null;
  walls = []; strips = [];
  ringGeom = poleGeom = shadowGeom = null;
  scroll = 0;
}
