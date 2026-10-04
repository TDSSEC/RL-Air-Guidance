/**
 * physics.js
 * Car physics calculations for the L4 DAR prototype
 * Handles angular velocity, PD control, damping, and quaternion integration
 */

import * as THREE from 'three';
import * as CONST from './constants.js';
import * as Car from './car.js';
import * as Input from './input.js';
import * as Settings from './settings.js';
import * as Coach from './coach.js';

// Debug logging flag - set to true for development
const DEBUG = false;

// ============================================================================
// MODULE-SCOPED PHYSICS STATE
// ============================================================================

// Reference to central game state (injected via init())
let gameState = null;

// Reference to RingMode module (injected via init() to avoid circular dependency)
let RingMode = null;

// Angular velocity vector (rad/s)
let w = new THREE.Vector3(0, 0, 0);

// Input history for smoothing
let inputHistory = { x: [], y: [] };
const INPUT_HISTORY_SIZE = CONST.INPUT_HISTORY_SIZE;

// Previous angular acceleration (for derivative term)
let prevAlpha = new THREE.Vector3(0, 0, 0);

// Axis lock states
let pitchLocked = false;
let yawLocked = false;
let rollLocked = false;

// Tornado circle - measured axis data at min and max stick input (right direction)
let AXIS_MIN_DATA = null; // { centerLocal: Vector3, axisLocal: Vector3, radius: number }
let AXIS_MAX_DATA = null; // { centerLocal: Vector3, axisLocal: Vector3, radius: number }

// Angular velocity tracking for wobble minimization
const HISTORY_LENGTH = CONST.ANGULAR_VELOCITY_HISTORY_LENGTH; // Number of frames to track
let angularVelocityHistory = [];
let previousCarQuaternion = null;

// Frame counter to skip expensive operations on first few frames
let frameCounter = 0;

// Load axis data from localStorage
function loadAxisDataFromStorage() {
  try {
    const minData = localStorage.getItem('tornadoAxisMinData');
    const maxData = localStorage.getItem('tornadoAxisMaxData');

    if (minData) {
      const parsed = JSON.parse(minData);
      AXIS_MIN_DATA = {
        centerLocal: new THREE.Vector3(parsed.centerLocal.x, parsed.centerLocal.y, parsed.centerLocal.z),
        axisLocal: new THREE.Vector3(parsed.axisLocal.x, parsed.axisLocal.y, parsed.axisLocal.z),
        radius: parsed.radius
      };
    }

    if (maxData) {
      const parsed = JSON.parse(maxData);
      AXIS_MAX_DATA = {
        centerLocal: new THREE.Vector3(parsed.centerLocal.x, parsed.centerLocal.y, parsed.centerLocal.z),
        axisLocal: new THREE.Vector3(parsed.axisLocal.x, parsed.axisLocal.y, parsed.axisLocal.z),
        radius: parsed.radius
      };
    }
  } catch (e) {
    console.error('Failed to load axis data from localStorage:', e);
  }
}

// Save axis data to localStorage
function saveAxisDataToStorage() {
  try {
    if (AXIS_MIN_DATA) {
      localStorage.setItem('tornadoAxisMinData', JSON.stringify({
        centerLocal: { x: AXIS_MIN_DATA.centerLocal.x, y: AXIS_MIN_DATA.centerLocal.y, z: AXIS_MIN_DATA.centerLocal.z },
        axisLocal: { x: AXIS_MIN_DATA.axisLocal.x, y: AXIS_MIN_DATA.axisLocal.y, z: AXIS_MIN_DATA.axisLocal.z },
        radius: AXIS_MIN_DATA.radius
      }));
    }

    if (AXIS_MAX_DATA) {
      localStorage.setItem('tornadoAxisMaxData', JSON.stringify({
        centerLocal: { x: AXIS_MAX_DATA.centerLocal.x, y: AXIS_MAX_DATA.centerLocal.y, z: AXIS_MAX_DATA.centerLocal.z },
        axisLocal: { x: AXIS_MAX_DATA.axisLocal.x, y: AXIS_MAX_DATA.axisLocal.y, z: AXIS_MAX_DATA.axisLocal.z },
        radius: AXIS_MAX_DATA.radius
      }));
    }
  } catch (e) {
    console.error('Failed to save axis data to localStorage:', e);
  }
}

// Load on module init
loadAxisDataFromStorage();

// Tornado circle tracking - measure nose position at 0° and 180° roll to find axis
let tornadoMeasurement = {
  measuring: false,
  targetStickMag: 0,      // 0.10 for min, 1.0 for max
  startNose: null,        // Nose position at 0° roll
  oppositeNose: null,     // Nose position at 180° roll
  nosePositions: [],      // Array of nose positions from 179° to 181°
  rotationAngle: 0,
  prevRotation: new THREE.Quaternion()
};

// ============================================================================
// PHYSICS CONSTANTS
// ============================================================================

// Legacy roll PD gains (not actively used, kept for compatibility)
const KP_ROLL = 3.2, KD_ROLL = 0.25;

// PD control gains for pitch/yaw/roll
// Kp increased to 200.0 to allow car to reach 5.5 rad/s velocity cap
// Kd set to 0.0 - deceleration ONLY from exponential damping when stick released (matches RL physics)
// DAR mode uses higher gains for snappier response
const KpPitch = 200.0, KdPitch = 0.0;
const KpYaw   = 200.0, KdYaw   = 0.0;
const KpRoll  = 200.0, KdRoll  = 0.0;
const KpPitchDAR = 1.0, KdPitchDAR = 0.0;   // Lower gains for DAR (softer response)
const KpYawDAR   = 1.0, KdYawDAR   = 0.0;
const KpRollDAR  = 400.0, KdRollDAR  = 0.0;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the Physics module with game state and Ring Mode dependency
 * This breaks the circular dependency by injecting dependencies at runtime
 * @param {GameState} state - Central game state instance
 * @param {Object} ringModeModule - RingMode module reference
 */
export function init(state, ringModeModule) {
  gameState = state;
  RingMode = ringModeModule;

  // Sync initial angular velocity with game state
  w = gameState.getAngularVelocityRef();

}

// ============================================================================
// EXPORTED GETTERS
// ============================================================================

/**
 * Get the current angular velocity vector
 * @returns {THREE.Vector3} Angular velocity (rad/s)
 */
export function getAngularVelocity() {
  return w.clone();
}

/**
 * Get the input history buffer (for debugging)
 * @returns {Object} Input history { x: [], y: [] }
 */
export function getInputHistory() {
  return {
    x: [...inputHistory.x],
    y: [...inputHistory.y]
  };
}

// ============================================================================
// EXPORTED SETTERS
// ============================================================================

/**
 * Set the angular velocity to a specific value
 * @param {number} x - Pitch velocity (rad/s)
 * @param {number} y - Yaw velocity (rad/s)
 * @param {number} z - Roll velocity (rad/s)
 */
export function setAngularVelocity(x, y, z) {
  w.set(x, y, z);
}

/**
 * Reset angular velocity to zero
 */
export function resetAngularVelocity() {
  w.set(0, 0, 0);
}

/**
 * Reset input history (for smoothing)
 */
export function resetInputHistory() {
  inputHistory = { x: [], y: [] };
}

/**
 * Reset all physics state
 */
export function resetPhysics() {
  w.set(0, 0, 0);
  inputHistory = { x: [], y: [] };
  prevAlpha.set(0, 0, 0);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const MIN_STICK_MAG = 0.10;  // Min measurement stick magnitude
const MAX_STICK_MAG = 1.00;  // Max measurement stick magnitude

/**
 * Interpolate axis data between MIN and MAX measurements based on stick magnitude
 * @param {number} stickMag - Current stick magnitude (0 to 1)
 * @returns {Object|null} { centerLocal, axisLocal, radius, t } or null
 */
function getInterpolatedAxisData(stickMag) {
  if (!AXIS_MIN_DATA || !AXIS_MAX_DATA) return null;

  // Normalize stickMag into 0..1 range
  const tRaw = (stickMag - MIN_STICK_MAG) / (MAX_STICK_MAG - MIN_STICK_MAG);
  const t = THREE.MathUtils.clamp(isNaN(tRaw) ? 0 : tRaw, 0, 1);

  const centerLocal = new THREE.Vector3().lerpVectors(
    AXIS_MIN_DATA.centerLocal,
    AXIS_MAX_DATA.centerLocal,
    t
  );

  const axisLocal = new THREE.Vector3().lerpVectors(
    AXIS_MIN_DATA.axisLocal,
    AXIS_MAX_DATA.axisLocal,
    t
  ).normalize();

  const radius = THREE.MathUtils.lerp(
    AXIS_MIN_DATA.radius,
    AXIS_MAX_DATA.radius,
    t
  );

  return { centerLocal, axisLocal, radius, t };
}

/**
 * Smooth joystick input using a rolling average
 * @param {number} jx - Raw joystick X input
 * @param {number} jy - Raw joystick Y input
 * @returns {Object} Smoothed input { x, y }
 */
function smoothInput(jx, jy) {
  inputHistory.x.push(jx);
  inputHistory.y.push(jy);
  if (inputHistory.x.length > INPUT_HISTORY_SIZE) {
    inputHistory.x.shift();
    inputHistory.y.shift();
  }

  const avgX = inputHistory.x.reduce((a, b) => a + b, 0) / inputHistory.x.length;
  const avgY = inputHistory.y.reduce((a, b) => a + b, 0) / inputHistory.y.length;
  return { x: avgX, y: avgY };
}

/**
 * Soft clamp angular velocity to prevent sudden stops
 * @param {THREE.Vector3} w - Angular velocity vector
 * @param {number} max - Maximum allowed magnitude
 */
function softClampAngularVelocity(w, max) {
  const mag = w.length();
  if (mag <= max) return;

  const excess = mag - max;
  const reduction = Math.min(1.0, excess / max);
  const scale = 1.0 - (reduction * 0.3);
  w.multiplyScalar(scale);
}

// ============================================================================
// VISUALIZATION UPDATE
// ============================================================================

/**
 * Update front-face arrow and tornado circle visualizations
 * @param {number} ux - Unit stick X (-1 to 1, right = +ux)
 * @param {number} uy - Unit stick Y (-1 to 1, up = +uy)
 * @param {number} eff - Effective input magnitude (0 to 1)
 * @param {Object} settings - Visualization settings
 */
function updateVisualizations(ux, uy, eff, settings) {
  const {
    showArrow,
    showCircle,
    arrowScale,
    circleScale,
    circleTiltAngle,
    circleTiltModifier
  } = settings;

  // --- Front-face arrow visualization ---
  if (Car.faceArrow && Car.faceTip) {
    const show = showArrow && eff > 0.02;
    Car.faceArrow.visible = show;
    Car.faceTip.visible   = show;

    if (show) {
      const lenMax = Math.min(Car.BOX.hx, Car.BOX.hy) * 0.95;
      const len    = Math.max(10, lenMax * eff * (arrowScale || 1));
      const zFace  = Car.BOX.hz + 0.6;

      const x2 = ux * len;
      const y2 = -uy * len;

      const pos = Car.faceArrow.geometry.attributes.position.array;
      pos[0] = 0;  pos[1] = 0;  pos[2] = zFace;
      pos[3] = x2; pos[4] = y2; pos[5] = zFace;
      Car.faceArrow.geometry.attributes.position.needsUpdate = true;

      const col = (Math.abs(x2) > Math.abs(y2))
        ? (x2 >= 0 ? CONST.COL_LEFT : CONST.COL_RIGHT)
        : (uy >= 0 ? CONST.COL_DOWN : CONST.COL_UP);
      Car.faceArrow.material.color.setHex(col);
      Car.faceTip.material.color.setHex(col);

      Car.faceTip.position.set(x2, y2, zFace);
      const ang = Math.atan2(x2, -y2) + Math.PI;
      Car.faceTip.rotation.set(0, 0, ang);
      const s = 0.95 * (arrowScale || 1);
      Car.faceTip.scale.set(s, s, 1);
    }
  }

}

// ============================================================================
// MAIN PHYSICS UPDATE
// ============================================================================

/**
 * Update physics simulation for one timestep
 * @param {number} dt - Time delta (seconds)
 * @param {Object} settings - Physics settings object
 * @param {boolean} chromeShown - True if menu is open (pauses physics)
 *
 * Settings object contains:
 * - showArrow, showCircle: Visualization toggles
 * - arrowScale, circleScale, circleTiltAngle, circleTiltModifier: Visualization parameters
 * - inputPow: Input curve exponent (1.0 = linear)
 * - stickRange: Stick range multiplier (1.0 = full range, 0.5 = half range)
 * - damp, dampDAR: Damping coefficients for normal/DAR mode
 * - brakeOnRelease: Extra damping when stick is released (non-DAR only)
 * - maxAccelPitch, maxAccelYaw, maxAccelRoll: Max angular accelerations (deg/s²)
 * - wMax, wMaxPitch, wMaxYaw, wMaxRoll: Max angular velocities (rad/s)
 */
export function updatePhysics(dt, settings, chromeShown) {
  try {
    frameCounter++;

    // Apply game speed multiplier to dt - this slows down time
    const gameSpeed = Settings.getSetting('gameSpeed') || 1.0;
    const adjustedDt = dt * gameSpeed;

    // Skip physics when menu is open OR when Ring Mode is paused
    // EXCEPT during automated measurement mode
    const allowMeasurement = window.measurementState && window.measurementState.active;
    if (!allowMeasurement && (chromeShown || gameState.isRingModePaused())) {
      return;
    }

    // Skip physics if car hasn't been built yet
    if (!Car.car) {
      return;
    }

    // Skip expensive operations for first 10 frames to allow system to stabilize
    const skipExpensiveOps = frameCounter < 10;

  // Destructure settings for easier access
  const {
    showArrow,
    showCircle,
    arrowScale,
    circleScale,
    circleTiltAngle,
    circleTiltModifier,
    inputPow,
    stickRange,
    damp,
    dampDAR,
    brakeOnRelease,
    maxAccelPitch,
    maxAccelYaw,
    maxAccelRoll,
    wMax,
    wMaxPitch,
    wMaxYaw,
    wMaxRoll
  } = settings;

  // --- 1. Get smoothed joystick position from Input module ---
  const joyVec = Input.getJoyVec();
  const baseR = Input.getJoyBaseR();
  const jx = joyVec.x / baseR;
  const jy = -joyVec.y / baseR; // up is positive
  let mag = Math.hypot(jx, jy);

  let eff = 0;
  let ux = 0, uy = 0;

  // Get right stick input for dual stick mode
  const rightStick = Input.getRightStickInput();
  const rightStickX = rightStick ? rightStick.x : 0;
  const rightStickY = rightStick ? rightStick.y : 0;

  // Process right stick with same magnitude shaping as left stick
  let rightStickMag = Math.hypot(rightStickX, rightStickY);
  let rightEff = 0;
  let rightUx = 0, rightUy = 0;

  // Get current deadzone from settings
  const stickDeadzone = Input.getTouchDeadzone ? Input.getTouchDeadzone() : 0.09;

  if (rightStickMag > stickDeadzone) {
    const clampedMag = Math.min(rightStickMag, 1.0);
    const m2 = (clampedMag - stickDeadzone) / (1 - stickDeadzone);
    const shaped = Math.pow(Math.max(0, m2), inputPow || 1.0);
    rightEff = shaped * (stickRange || 1.0);
    rightUx = -rightStickX; // right = +ux
    rightUy = -rightStickY; // up = +uy (invert Y like left stick)
  }

  if (mag > stickDeadzone) {
    // Clamp mag to max 1.0, then apply shaping
    const clampedMag = Math.min(mag, 1.0);
    const m2 = (clampedMag - stickDeadzone) / (1 - stickDeadzone);
    const shaped = Math.pow(Math.max(0, m2), inputPow || 1.0);

    // Apply stick range multiplier (1.0 = normal, 0.5 = half range, etc.)
    eff = shaped * (stickRange || 1.0);

    // Direct 1:1 mapping - stick position = input value
    ux = -jx; // right = +ux
    uy = jy;  // up = +uy

    // DEBUG: Log stick input values - only when magnitude changes significantly
    if (DEBUG && mag > 0.02) {
      const airRoll = Input.getAirRoll();
      const isDARActive = (airRoll === -1 || airRoll === 1) || Input.getDarOn();
      // Only log when values change by >0.01 to reduce spam
      if (!window.lastLoggedStick || Math.abs(ux - window.lastLoggedStick.ux) > 0.01 || Math.abs(uy - window.lastLoggedStick.uy) > 0.01) {
        console.log(`[STICK] ux: ${ux.toFixed(3)} | uy: ${uy.toFixed(3)} | angle: ${(Math.atan2(uy, ux) * 180 / Math.PI).toFixed(1)}° | mag: ${mag.toFixed(3)}`);
        window.lastLoggedStick = {ux, uy};
      }
    }
  }

  // === RING MODE: Calculate movement forces (normal rotation physics will run below) ===
  if (gameState.getRingModeActive() && RingMode && Car.car) {
    // Always call updateRingModePhysics so it can handle game-over logic (like stopping boost sound)
    RingMode.updateRingModePhysics(adjustedDt, {
      boostActive: Input.getRingModeBoostActive()
    }, Car.car.quaternion);
  }

  // === RHYTHM MODE: Calculate movement forces (normal rotation physics will run below) ===
  if (gameState.getRhythmModeActive() && RingMode && Car.car) {
    RingMode.updateRingModePhysics(adjustedDt, {
      boostActive: Input.getRingModeBoostActive()
    }, Car.car.quaternion);
  }

  // --- 2. Update visualizations (front-face arrow and tornado circle) ---
  updateVisualizations(ux, uy, eff, {
    showArrow,
    showCircle,
    arrowScale,
    circleScale,
    circleTiltAngle,
    circleTiltModifier
  });

  // --- 3. Slider conversions (deg/s² → rad/s²) ---
  let maxAccelPitchRad = (maxAccelPitch * Math.PI) / 180;
  let maxAccelYawRad   = (maxAccelYaw   * Math.PI) / 180;
  let maxAccelRollRad  = (maxAccelRoll  * Math.PI) / 180;

  // --- 4. Desired angular velocities (rate control) ---
  // During tornado spins (DAR + stick input), RL achieves much lower pitch/yaw than the global cap
  // From yaw_dar_test.csv: wx≈5.13, wy≈-0.73, wz≈1.84 during steady tornado spin
  // So we need to limit the desired speeds during tornado spins, not use the slider max (24 rad/s)
  let maxPitchSpeed = wMaxPitch;  // rad/s, slider already in "ω"
  let maxYawSpeed   = wMaxYaw;    // rad/s
  let targetRollSpeed = 0;        // rad/s

  // Check if using Air Roll (Free) mode
  const isAirRollFree = (Input.getAirRoll() === 2);

  // Check if using directional air roll (Left/Right)
  const isDirectionalAirRoll = (Input.getAirRoll() === -1 || Input.getAirRoll() === 1);

  // --- 3.5. DAR acceleration multipliers (from RL measurements) ---
  // DISABLED FOR TORNADO SPINS: These multipliers make controls too aggressive
  // The 2-3x acceleration boost causes cardinals to dominate over diagonals
  // when the global 5.5 rad/s cap is active
  // TODO: Research if these multipliers apply to tornado spins in actual RL
  /*
  if (isDirectionalAirRoll || Input.getDarOn()) {
    maxAccelPitchRad *= 2.33;   // DAR: 733→1711 deg/s² (2.33x multiplier)
    maxAccelYawRad *= 2.96;      // DAR: 528→1562 deg/s² (2.96x multiplier)
    maxAccelRollRad *= 1.60;     // DAR: 898→1437 deg/s² (1.60x multiplier)
  }
  */

  // Directional air roll tornado spin
  // This activates when:
  // 1. Air Roll Left/Right buttons are pressed (Square/Circle on gamepad, Q/E on keyboard)
  // 2. DAR button is active with a selected direction in the menu
  if ((isDirectionalAirRoll || Input.getDarOn()) && !isAirRollFree) {
    // DAR roll speed: 5.5 rad/s (one full roll every ~1.14 seconds)
    // Multiply by analog intensity for trigger support (0.0 to 1.0)
    const intensity = Input.getAirRollIntensity();
    targetRollSpeed = Input.getAirRoll() * CONST.DAR_ROLL_SPEED * intensity;  // rad/s
  }

  // stick → desired spin rates
  let wx_des, wy_des, wz_des;

  // Check if right stick should be used (dual stick mode)
  const useRightStick = rightStickMag > stickDeadzone;
  
  // Determine which stick inputs to use for control
  const controlX = useRightStick ? rightUx : ux;
  const controlY = useRightStick ? rightUy : uy;
  const controlEff = useRightStick ? rightEff : eff;

  if (isAirRollFree) {
    // Air Roll (Free): horizontal stick controls roll, vertical controls pitch
    wx_des = maxPitchSpeed * controlEff * controlY; // pitch (up/down)
    wy_des = 0;                                      // no yaw
    wz_des = wMaxRoll * controlEff * (-controlX);   // roll (left/right)
  } else {
    // Directional Air Roll (tornado spin) vs Normal flight
    if (isDirectionalAirRoll || Input.getDarOn()) {
      // DAR tornado spin: share a fixed angular velocity budget so axes don't stack
      // Use stick direction AND magnitude for pitch/yaw; roll stays at DAR speed
      const darPitchYawCap = wMax * 0.50; // ~2.75 rad/s when wMax=5.5 (matches RL budget share)
      const maxPitchSpeedDar = Math.min(maxPitchSpeed, darPitchYawCap);
      const maxYawSpeedDar   = Math.min(maxYawSpeed,   darPitchYawCap);

      const wx_raw = maxPitchSpeedDar * controlEff * controlY;  // pitch
      const wy_raw = maxYawSpeedDar   * controlEff * controlX;  // yaw
      const wz_raw = targetRollSpeed;     // roll

      // Normalize full vector to the global cap so pitch/yaw trade off smoothly
      const rawMag = Math.sqrt(wx_raw * wx_raw + wy_raw * wy_raw + wz_raw * wz_raw);
      if (rawMag > 1e-6) {
        const scale = Math.min(1, wMax / rawMag);
        wx_des = wx_raw * scale;
        wy_des = wy_raw * scale;
        wz_des = wz_raw * scale;
      } else {
        wx_des = 0;
        wy_des = 0;
        wz_des = 0;
      }
    } else {
      // Normal flight (no DAR): independent pitch/yaw control
      wx_des = maxPitchSpeed * controlEff * controlY; // pitch
      wy_des = maxYawSpeed * controlEff * controlX;   // yaw
      wz_des = 0; // no roll command
    }
  }

  // DEBUG: Log desired angular velocities during DAR
  if (DEBUG && isDirectionalAirRoll && eff > 0.02) {
    if (!window.lastLoggedDesiredW ||
        Math.abs(wx_des - window.lastLoggedDesiredW.wx) > 0.1 ||
        Math.abs(wy_des - window.lastLoggedDesiredW.wy) > 0.1) {
      console.log(`[DESIRED W] wx_des: ${wx_des.toFixed(3)} | wy_des: ${wy_des.toFixed(3)} | wz_des: ${wz_des.toFixed(3)} | eff: ${eff.toFixed(3)}`);
      window.lastLoggedDesiredW = {wx: wx_des, wy: wy_des};
    }
  }

  // --- Update tornado circle visualizer ---
  const stickMag = Math.sqrt(ux * ux + uy * uy);

  // MEASUREMENT MODE: Track nose position through 179°-181° roll rotation
  if (tornadoMeasurement.measuring && stickMag > 0.01 && !skipExpensiveOps) {
    const carQuat = Car.car.quaternion.clone();
    const carPos = Car.car.position.clone();
    const noseLocal = new THREE.Vector3(0, 0, Car.BOX.hz);
    const noseWorld = noseLocal.clone().applyQuaternion(carQuat).add(carPos);

    // Track roll rotation angle
    const rotationDelta = carQuat.clone().multiply(tornadoMeasurement.prevRotation.clone().invert());
    rotationDelta.normalize();
    const angle = 2 * Math.acos(Math.min(1, Math.abs(rotationDelta.w)));
    tornadoMeasurement.rotationAngle += angle;
    tornadoMeasurement.prevRotation.copy(carQuat);

    const rotationDegrees = tornadoMeasurement.rotationAngle * 180 / Math.PI;

    // Collect nose positions between 179° and 181°
    if (rotationDegrees >= 179 && rotationDegrees <= 181) {
      tornadoMeasurement.nosePositions.push(noseWorld.clone());
    }

    // When we pass 181°, calculate the axis
    if (rotationDegrees > 181) {
      if (tornadoMeasurement.nosePositions.length > 0) {
      // Average all nose positions between 179° and 181° to get the opposite point
      const oppositeNose = new THREE.Vector3();
      for (const pos of tornadoMeasurement.nosePositions) {
        oppositeNose.add(pos);
      }
      oppositeNose.divideScalar(tornadoMeasurement.nosePositions.length);

      const startNose = tornadoMeasurement.startNose;

      // Circle center is midpoint (in world space)
      const centerWorld = startNose.clone().add(oppositeNose).multiplyScalar(0.5);

      // Axis direction is from start to opposite (diameter)
      const axisWorld = oppositeNose.clone().sub(startNose).normalize();

      // Radius is half the distance
      const radius = startNose.distanceTo(oppositeNose) * 0.5;

      // Convert to car-local space
      const centerLocal = centerWorld.clone().sub(carPos).applyQuaternion(carQuat.clone().invert());
      const axisLocal = axisWorld.clone().applyQuaternion(carQuat.clone().invert());

      // Store based on stick magnitude
      const data = { centerLocal, axisLocal, radius };
      if (Math.abs(tornadoMeasurement.targetStickMag - 0.10) < 0.05) {
        AXIS_MIN_DATA = data;
        saveAxisDataToStorage();
      } else if (Math.abs(tornadoMeasurement.targetStickMag - 1.0) < 0.1) {
        AXIS_MAX_DATA = data;
        saveAxisDataToStorage();
      }

      // Stop measuring
      tornadoMeasurement.measuring = false;

      // Reset automated measurement state
      if (window.measurementState) {
        window.measurementState.active = false;
        window.measurementState.input.x = 0;
        window.measurementState.input.y = 0;
      }
      }
    }
  }

  // Reset measurement when stick released (but NOT during automated measurement)
  if (tornadoMeasurement.measuring && stickMag < 0.01 && !(window.measurementState && window.measurementState.active)) {
    tornadoMeasurement.measuring = false;
  }

  // Yellow tornado line - show/hide and rotate based on stick input with wobble minimization
  // Only active when using air roll left or right (DAR), not air roll free
  // Also respects the showCircle setting (Don't Show Ring hides the tornado spin indicator)
  const airRoll = Input.getAirRoll();

  if (stickMag > 0.01 && ((airRoll === -1 || airRoll === 1) || Input.getDarOn()) && showCircle && !skipExpensiveOps) {
    Car.yellowTornadoLine.visible = true; // Must be visible for children to show

    // Make the yellow line itself invisible by setting opacity to 0
    if (Car.yellowTornadoLine.material) {
      Car.yellowTornadoLine.material.transparent = true;
      Car.yellowTornadoLine.material.opacity = 0;
    }

    // Update magenta circle color based on stick direction (like analog stick visualization)
    if (Car.magentaCircle) {
      // Both air roll directions need X inverted for color mapping
      const adjustedUx = -ux;
      const angle = Math.atan2(uy, adjustedUx);

      // Map angle to color (0=right/blue, 90=up/green, 180=left/yellow, 270=down/red)
      let color;
      const degrees = ((angle * 180 / Math.PI) + 360) % 360;

      if (degrees >= 45 && degrees < 135) {
        // Up quadrant - GREEN
        color = 0x00ff00;
      } else if (degrees >= 135 && degrees < 225) {
        // Left quadrant - YELLOW
        color = 0xffff00;
      } else if (degrees >= 225 && degrees < 315) {
        // Down quadrant - RED
        color = 0xff0000;
      } else {
        // Right quadrant - BLUE
        color = 0x0000ff;
      }

      // Only update magenta circle color
      Car.magentaCircle.material.color.setHex(color);
    }

    // Calculate angular velocity from quaternion change
    if (previousCarQuaternion && !skipExpensiveOps) {
      // Get current rotation delta
      const currentQuat = Car.car.quaternion.clone();
      const deltaQuat = new THREE.Quaternion();
      deltaQuat.copy(currentQuat).multiply(previousCarQuaternion.clone().invert());

      // Convert quaternion to axis-angle to get angular velocity direction
      const angle = 2 * Math.acos(Math.min(1, Math.abs(deltaQuat.w)));

      if (angle > 0.001) { // Only if there's significant rotation
        const sinHalfAngle = Math.sqrt(1 - deltaQuat.w * deltaQuat.w);
        const angularVelocity = new THREE.Vector3(
          deltaQuat.x / sinHalfAngle,
          deltaQuat.y / sinHalfAngle,
          deltaQuat.z / sinHalfAngle
        ).normalize();

        // Add to history
        angularVelocityHistory.push(angularVelocity.clone());

        // Keep history at fixed length
        if (angularVelocityHistory.length > HISTORY_LENGTH) {
          angularVelocityHistory.shift();
        }
      }
    }

    // Store current quaternion for next frame
    previousCarQuaternion = Car.car.quaternion.clone();

    // If we have enough history, use averaged angular velocity
    if (angularVelocityHistory.length >= 15) {
      // Calculate average angular velocity direction
      const avgAngularVel = new THREE.Vector3();
      for (let i = 0; i < angularVelocityHistory.length; i++) {
        avgAngularVel.add(angularVelocityHistory[i]);
      }
      avgAngularVel.normalize();

      // Invert the direction (angular velocity points opposite to desired line direction)
      avgAngularVel.negate();

      // Convert to car-local space
      const carQuat = Car.car.quaternion.clone().invert();
      const axisLocal = avgAngularVel.clone().applyQuaternion(carQuat);

      // Orient yellow line to this axis
      const defaultDirection = new THREE.Vector3(0, 0, 1);
      const lineQuat = new THREE.Quaternion().setFromUnitVectors(defaultDirection, axisLocal);

      // Apply the quaternion rotation (don't use slerp, just set it)
      Car.yellowTornadoLine.quaternion.copy(lineQuat);
    } else {
      // Not enough history yet, use simple stick-based rotation
      // Fix: for Air Roll Right, invert stickY so up/down are not swapped when rotation is locked
      const airRoll = Input.getAirRoll();
      const invertForAirRollLeft = (airRoll === -1);
      const invertStickYForAirRollRight = (airRoll === 1);

      const stickX = invertForAirRollLeft ? ux : -ux;
      const stickY = invertStickYForAirRollRight ? -uy : uy;
      const lineDirectionX = -stickY;
      const lineDirectionY = stickX;
      const tiltAmount = 0.5;

      // Use Euler angles for initial rotation, then convert to quaternion
      const euler = new THREE.Euler(
        lineDirectionY * tiltAmount,
        lineDirectionX * tiltAmount,
        0,
        'XYZ'
      );
      Car.yellowTornadoLine.quaternion.setFromEuler(euler);
    }
  } else {
    Car.yellowTornadoLine.visible = false;
    // Clear history when stick is released
    angularVelocityHistory = [];
    previousCarQuaternion = null;
  }

  // Update magenta dot position and circle to stay perpendicular to yellow line
  if (Car.magentaCircle && Car.magentaLinePoint && Car.carNosePoint && Car.yellowTornadoLine) {
    // Get world positions
    const redNoseWorld = new THREE.Vector3();
    Car.carNosePoint.getWorldPosition(redNoseWorld);

    // Get yellow line position and direction in world space
    const lineWorldPos = new THREE.Vector3();
    Car.yellowTornadoLine.getWorldPosition(lineWorldPos);

    const yellowLineDirection = new THREE.Vector3(0, 0, 1);
    yellowLineDirection.applyQuaternion(Car.yellowTornadoLine.getWorldQuaternion(new THREE.Quaternion()));

    // Project the red nose onto the yellow line to find the magenta dot position
    // This ensures the circle stays perpendicular to the yellow line
    const lineToNose = new THREE.Vector3().subVectors(redNoseWorld, lineWorldPos);
    const projectionLength = lineToNose.dot(yellowLineDirection);

    // Position on yellow line closest to nose (projection point)
    const magentaDotWorld = new THREE.Vector3().copy(lineWorldPos).add(
      yellowLineDirection.clone().multiplyScalar(projectionLength)
    );

    // Convert to yellow line's local space
    const lineWorldQuatInverse = Car.yellowTornadoLine.getWorldQuaternion(new THREE.Quaternion()).invert();
    const magentaDotLocal = new THREE.Vector3().subVectors(magentaDotWorld, lineWorldPos).applyQuaternion(lineWorldQuatInverse);

    // Update magenta dot and circle positions
    Car.magentaLinePoint.position.copy(magentaDotLocal);
    Car.magentaCircle.position.copy(magentaDotLocal);

    // Calculate dynamic radius (distance from magenta dot to nose)
    const radius = magentaDotWorld.distanceTo(redNoseWorld);

    // Update circle scale
    Car.magentaCircle.scale.set(radius, radius, radius);

    // Orient circle perpendicular to yellow line
    // Circle normal = yellow line direction
    const circleNormalLocal = new THREE.Vector3(0, 0, 1); // Already in line's local space

    // Orient circle to face along the line (perpendicular to line means normal along line)
    const defaultNormal = new THREE.Vector3(0, 0, 1);
    const quat = new THREE.Quaternion().setFromUnitVectors(defaultNormal, circleNormalLocal);

    Car.magentaCircle.quaternion.copy(quat);

    // Update debug lines
    if (Car.debugLine1 && Car.debugLine2 && Car.debugLine3 && Car.debugLine4) {
      const lineLength = 100;

      // Line 1 (RED): From nose to magenta
      const line1Pos = Car.debugLine1.geometry.attributes.position;
      line1Pos.setXYZ(0, redNoseWorld.x, redNoseWorld.y, redNoseWorld.z);
      line1Pos.setXYZ(1, magentaDotWorld.x, magentaDotWorld.y, magentaDotWorld.z);
      line1Pos.needsUpdate = true;

      // Calculate magentaToNose for debug lines
      const magentaToNose = new THREE.Vector3().subVectors(redNoseWorld, magentaDotWorld).normalize();

      // Line 2 (GREEN): Perpendicular to nose-magenta, centered at magenta dot
      const perp1 = new THREE.Vector3().crossVectors(yellowLineDirection, magentaToNose).normalize();
      const line2Start = magentaDotWorld.clone().add(perp1.clone().multiplyScalar(-lineLength / 2));
      const line2End = magentaDotWorld.clone().add(perp1.clone().multiplyScalar(lineLength / 2));
      const line2Pos = Car.debugLine2.geometry.attributes.position;
      line2Pos.setXYZ(0, line2Start.x, line2Start.y, line2Start.z);
      line2Pos.setXYZ(1, line2End.x, line2End.y, line2End.z);
      line2Pos.needsUpdate = true;

      // Line 3 (BLUE): Another perpendicular to nose-magenta (different direction), centered at magenta dot
      const perp2 = new THREE.Vector3().crossVectors(magentaToNose, perp1).normalize();
      const line3Start = magentaDotWorld.clone().add(perp2.clone().multiplyScalar(-lineLength / 2));
      const line3End = magentaDotWorld.clone().add(perp2.clone().multiplyScalar(lineLength / 2));
      const line3Pos = Car.debugLine3.geometry.attributes.position;
      line3Pos.setXYZ(0, line3Start.x, line3Start.y, line3Start.z);
      line3Pos.setXYZ(1, line3End.x, line3End.y, line3End.z);
      line3Pos.needsUpdate = true;

      // Line 4 (CYAN): Perpendicular to BOTH perp1 and perp2, centered at magenta dot
      const perp3 = new THREE.Vector3().crossVectors(perp1, perp2).normalize();
      const line4Start = magentaDotWorld.clone().add(perp3.clone().multiplyScalar(-lineLength / 2));
      const line4End = magentaDotWorld.clone().add(perp3.clone().multiplyScalar(lineLength / 2));
      const line4Pos = Car.debugLine4.geometry.attributes.position;
      line4Pos.setXYZ(0, line4Start.x, line4Start.y, line4Start.z);
      line4Pos.setXYZ(1, line4End.x, line4End.y, line4End.z);
      line4Pos.needsUpdate = true;
    }
  }

  // --- 5. PD control → angular acceleration per axis ---
  // CRITICAL: Control logic depends on mode!
  // Normal mode: PD control with acceleration
  // DAR mode: Direct velocity assignment for ZERO inertia (instant direction changes)
  const hasStickInput = eff >= 0.02;
  const hasRollCommand = Math.abs(targetRollSpeed) > 0.01; // Air Roll Left/Right or DAR active
  const isDARActive = isDirectionalAirRoll || Input.getDarOn();
  const noInput = !hasStickInput && !hasRollCommand && !isDARActive; // DAR keeps PD active

  let ax = 0, ay = 0, az = 0;
  
  if (!noInput) {
    // PD control with acceleration (applies to DAR too; global cap will clamp magnitude)
    const kpPitch = KpPitch;
    const kpYaw   = KpYaw;
    const kpRoll  = KpRoll;
    const kdPitch = KdPitch;
    const kdYaw   = KdYaw;
    const kdRoll  = KdRoll;

    const ax_des = kpPitch * (wx_des - w.x) - kdPitch * w.x;
    const ay_des = kpYaw   * (wy_des - w.y) - kdYaw   * w.y;
    const az_des = kpRoll  * (wz_des - w.z) - kdRoll  * w.z;

    ax = THREE.MathUtils.clamp(ax_des, -maxAccelPitchRad, maxAccelPitchRad);
    ay = THREE.MathUtils.clamp(ay_des, -maxAccelYawRad,   maxAccelYawRad);
    az = THREE.MathUtils.clamp(az_des, -maxAccelRollRad,  maxAccelRollRad);

    // DEBUG: Log angular accelerations during DAR
    if (DEBUG && isDirectionalAirRoll && eff > 0.02) {
      if (!window.lastLoggedAccel ||
          Math.abs(ax - window.lastLoggedAccel.ax) > 0.5 ||
          Math.abs(ay - window.lastLoggedAccel.ay) > 0.5) {
        console.log(`[ACCEL] ax: ${ax.toFixed(2)} | ay: ${ay.toFixed(2)} | az: ${az.toFixed(2)} | current w: (${w.x.toFixed(2)}, ${w.y.toFixed(2)}, ${w.z.toFixed(2)})`);
        window.lastLoggedAccel = {ax, ay};
      }
    }
  }
  // else: All inputs released - no PD control, only damping will apply later

  // --- 6. Integrate angular velocity ---
  w.x += ax * adjustedDt;
  w.y += ay * adjustedDt;
  w.z += az * adjustedDt;

  // Apply axis locks - set velocity to 0 for locked axes
  // Coach levels 1-2 lock pitch and roll so the stick works like a steering
  // wheel: left/right always turns the nose anticlockwise/clockwise on screen.
  const coachLevel = Settings.getSetting('coachLevel') || 0;
  const coachLock = gameState.getRingModeActive() ? Coach.levelLocks(coachLevel) : { pitch: false, roll: false };
  if (pitchLocked || coachLock.pitch) w.x = 0;
  if (yawLocked) w.y = 0;
  if (rollLocked || coachLock.roll) w.z = 0;

  // --- 7. Damping + release brake ---
  // CRITICAL: Damping behavior depends on mode!
  // Normal mode: Only damp when ALL inputs released (matches RL)
  // DAR mode: No damping needed - velocity is set directly
  if (noInput) {
    // All inputs released - apply normal damping
    const baseDamp = isDARActive ? dampDAR : damp;
    const dampEff = (baseDamp || 0) + ((!isDARActive) ? (brakeOnRelease || 0) : 0);
    const scale = Math.exp(-dampEff * adjustedDt);
    w.multiplyScalar(scale);
  }
  // DAR with active input: No damping - velocity is set directly for zero inertia

  // --- 8. Per-axis caps + Global magnitude cap ---
  // Apply per-axis caps first (DAR uses tighter pitch/yaw cap to match RL budget)
  const wMaxPitchCap = isDARActive ? Math.min(wMaxPitch, wMax * 0.50) : wMaxPitch;
  const wMaxYawCap   = isDARActive ? Math.min(wMaxYaw,   wMax * 0.50) : wMaxYaw;

  if (Math.abs(w.x) > wMaxPitchCap) w.x = Math.sign(w.x) * wMaxPitchCap;
  if (Math.abs(w.y) > wMaxYawCap)   w.y = Math.sign(w.y) * wMaxYawCap;
  if (Math.abs(w.z) > wMaxRoll)     w.z = Math.sign(w.z) * wMaxRoll;

  // Global magnitude cap (5.5 rad/s) - only applies during DAR mode
  // Air Roll (Free) and normal flight allow independent per-axis control
  if (isDARActive) {
    const totalMag = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
    if (totalMag > wMax) {
      const scale = wMax / totalMag;
      w.x *= scale;
      w.y *= scale;
      w.z *= scale;
    }
  }

  // DEBUG: Log final angular velocity after all processing
  if (DEBUG && isDirectionalAirRoll && eff > 0.02) {
    if (!window.lastLoggedFinalW ||
        Math.abs(w.x - window.lastLoggedFinalW.wx) > 0.1 ||
        Math.abs(w.y - window.lastLoggedFinalW.wy) > 0.1) {
      const finalMag = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
      console.log(`[FINAL W] wx: ${w.x.toFixed(3)} | wy: ${w.y.toFixed(3)} | wz: ${w.z.toFixed(3)} | mag: ${finalMag.toFixed(3)}`);
      window.lastLoggedFinalW = {wx: w.x, wy: w.y};
    }
  }

  // --- 9. Quaternion integration ---
  const wx = w.x, wy = w.y, wz = w.z, halfdt = 0.5 * adjustedDt;

  const q = Car.car.quaternion;
  const rw = -q.x * wx - q.y * wy - q.z * wz;
  const rx =  q.w * wx + q.y * wz - q.z * wy;
  const ry =  q.w * wy + q.z * wx - q.x * wz;
  const rz =  q.w * wz + q.x * wy - q.y * wx;
  q.w += rw * halfdt;
  q.x += rx * halfdt;
  q.y += ry * halfdt;
  q.z += rz * halfdt;
  q.normalize();

  // Roll axis locking disabled - car can rotate freely
  // (Previously locked to align with green line)

  // === RING MODE: Override car position and update rings ===
  RingMode.updateRingModeRendering(adjustedDt);
  } catch (error) {
    console.error('[Physics] Error in updatePhysics:', error);
    // Reset angular velocity on physics error to prevent unstable state
    if (gameState) {
      gameState.resetAngularVelocity();
    }
  }
}

// ============================================================================
// TORNADO CIRCLE AXIS MEASUREMENT FUNCTIONS
// ============================================================================

/**
 * Start measuring axis at minimum stick input (~25%)
 * Hold DAR + stick at ~25%, call this, then rotate 180°
 */
export function measureMinAxis() {
  if (!Car.car) {
    console.warn('Cannot measure axis: car not initialized');
    return;
  }

  tornadoMeasurement.measuring = true;
  tornadoMeasurement.targetStickMag = 0.10;
  const carQuat = Car.car.quaternion.clone();
  const carPos = Car.car.position.clone();
  const noseLocal = new THREE.Vector3(0, 0, Car.BOX.hz);
  const noseWorld = noseLocal.clone().applyQuaternion(carQuat).add(carPos);
  tornadoMeasurement.startNose = noseWorld.clone();
  tornadoMeasurement.nosePositions = [];
  tornadoMeasurement.rotationAngle = 0;
  tornadoMeasurement.prevRotation.copy(carQuat);
}

/**
 * Start measuring axis at maximum stick input (100%)
 * Hold DAR + stick at 100%, call this, then rotate 180°
 */
export function measureMaxAxis() {
  if (!Car.car) {
    console.warn('Cannot measure axis: car not initialized');
    return;
  }

  tornadoMeasurement.measuring = true;
  tornadoMeasurement.targetStickMag = 1.0;
  const carQuat = Car.car.quaternion.clone();
  const carPos = Car.car.position.clone();
  const noseLocal = new THREE.Vector3(0, 0, Car.BOX.hz);
  const noseWorld = noseLocal.clone().applyQuaternion(carQuat).add(carPos);
  tornadoMeasurement.startNose = noseWorld.clone();
  tornadoMeasurement.nosePositions = [];
  tornadoMeasurement.rotationAngle = 0;
  tornadoMeasurement.prevRotation.copy(carQuat);
}

/**
 * Print the measured axis data for hardcoding
 */
export function printAxisData() {
  // Axis data is automatically saved to localStorage
  // No console output needed
}

// ============================================================================
// AXIS LOCK FUNCTIONS
// ============================================================================

/**
 * Toggle pitch lock with validation
 * Prevents locking during high rotation to avoid physics jitter
 * @returns {boolean} - New lock state
 */
export function togglePitchLock() {
  const angularVelMagnitude = w.length();
  if (angularVelMagnitude > 2.0) {
    console.warn('Cannot toggle pitch lock during high rotation (rate:', angularVelMagnitude.toFixed(2), 'rad/s)');
    return pitchLocked;
  }
  pitchLocked = !pitchLocked;
  return pitchLocked;
}

/**
 * Toggle yaw lock with validation
 * Prevents locking during high rotation to avoid physics jitter
 * @returns {boolean} - New lock state
 */
export function toggleYawLock() {
  const angularVelMagnitude = w.length();
  if (angularVelMagnitude > 2.0) {
    console.warn('Cannot toggle yaw lock during high rotation (rate:', angularVelMagnitude.toFixed(2), 'rad/s)');
    return yawLocked;
  }
  yawLocked = !yawLocked;
  return yawLocked;
}

/**
 * Toggle roll lock with validation
 * Prevents locking during high rotation to avoid physics jitter
 * @returns {boolean} - New lock state
 */
export function toggleRollLock() {
  const angularVelMagnitude = w.length();
  if (angularVelMagnitude > 2.0) {
    console.warn('Cannot toggle roll lock during high rotation (rate:', angularVelMagnitude.toFixed(2), 'rad/s)');
    return rollLocked;
  }
  rollLocked = !rollLocked;
  return rollLocked;
}

// ============================================================================
// CLEANUP AND MEMORY MANAGEMENT
// ============================================================================

/**
 * Cleanup physics module resources
 * Call this when shutting down the application to prevent memory leaks
 */
export function cleanup() {
  // Reset all physics state
  w.set(0, 0, 0);
  prevAlpha.set(0, 0, 0);
  pitchLocked = false;
  yawLocked = false;
  rollLocked = false;

  // Clear input history
  inputHistory.x = [];
  inputHistory.y = [];

  // Clear axis data
  AXIS_MIN_DATA = null;
  AXIS_MAX_DATA = null;

  // Clear angular velocity history
  angularVelocityHistory = [];
  previousCarQuaternion = null;

  // Reset game state reference
  gameState = null;
}

// ============================================================================
