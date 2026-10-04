/**
 * ringMode.js
 * Ring Mode game logic for L4 DAR prototype
 * Handles ring spawning, physics, collision detection, and camera control
 */

import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as CONST from './constants.js';
import * as Car from './car.js';
import * as Audio from './audio.js';
import { getSetting, saveSettings } from './settings.js';
import * as Coach from './coach.js';
import * as Arena from './arena.js';

// ============================================================================
// MODULE DEPENDENCIES (injected via init())
// ============================================================================

// Reference to central game state (injected via init() to avoid circular dependency)
let gameState = null;

// Reference to Input module (injected via init() to avoid circular dependency)
let Input = null;

// ============================================================================
// PRIVATE STATE VARIABLES
// ============================================================================

// Ring Mode state
let ringModeActive = false;
let ringModeScore = 0;
let ringModeHighScore = 0; // Current difficulty high score (loaded based on difficulty)
let ringModeLives = 5;
let ringModeRingCount = 0;
let ringCameraSpeed = getSetting('ringCameraSpeed') ?? 0.02;
let inverseGravity = getSetting('inverseGravity') ?? false; // Inverse gravity toggle

// Ring Mode physics
let ringModeVelocity = new THREE.Vector2(0, 0); // XY velocity only
let ringModePosition = new THREE.Vector2(0, 0); // Car position in 2D plane
let ringModeStarted = false; // Track if player has started (boosted at least once)
let ringModePaused = false; // Track pause state
let ignoreBoostUntilRelease = false; // Ignore boost input after respawn until released
let lastRingModeActive = false; // Track transitions to run cleanup when exiting

// Boost flame effects
let boostFlames = [];

// Boundary visualization
let boundaryGrid = null; // Visual indicator showing the kill barrier
let landingIndicator = null; // 3D dashed circle showing where target ring will land on grid
let targetPointSphere = null; // 3D sphere showing the target point (top of ring) for input assist

// Landing indicator cache (to avoid rebuilding every frame)
let cachedTargetRingId = null; // Track which ring we built the indicator for
let cachedPlayerInsideState = null; // Track if player was inside/outside

// Camera smooth path tracking
let cameraTargetX = 0; // Smooth interpolated camera target position
let cameraTargetY = 0;

// Ring geometry and spawning
let rings = []; // Active rings in the scene
let currentColorIndex = 0;

// Preloaded ring resources (cached geometry and materials)
let ringGeometryCache = null;
let ringMaterialCache = new Map(); // Cache materials by color
let ringResourcesPreloaded = false;

// Ring spawning state
let ringSpawnTimer = 0;
let ringSpawnIndex = 0; // Track spawn order for camera focusing

let currentDifficulty = getSetting('ringDifficulty') ?? 'normal';

// Pattern generation variables
let currentPattern = 'random';
let patternProgress = 0; // Progress through current pattern (0-1)
let patternLength = 15; // Number of rings in this pattern
let patternRingCount = 0; // Rings spawned in current pattern
const PATTERN_TYPES = ['sine_horizontal', 'sine_vertical', 'spiral', 'helix', 'figure8', 'vertical_line', 'horizontal_line', 'wave_combo', 'random', 'square', 'triangle', 'star', 'pentagon'];

// Pattern parameters (randomized when pattern changes)
let patternAmplitude = 400; // Wave/spiral amplitude
let patternFrequency = 0.5; // Oscillation frequency
let patternPhase = 0; // Starting phase offset

// Hard mode section management
let currentSection = null; // Current section type (gauntlet, geometric, flowing, chaos)
let sectionRingCount = 0; // Rings spawned in current section
let sectionDuration = 0; // Total rings in current section
let sectionSpawnInterval = 1.0; // Spawn interval multiplier for this section
let sectionSpeed = 1.0; // Speed multiplier for this section
let sectionAmplitude = 1.0; // Amplitude multiplier for this section

// Scene and camera references (set during initialization)
let scene = null;
let camera = null;
let renderer = null;

// External physics state (passed in from main code)
let externalOrbitOn = null; // Orbit mode flag (object with value property)

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the RingMode module with game state dependency
 * This breaks the circular dependency by injecting dependencies at runtime
 * @param {GameState} state - Central game state instance
 * @param {object} inputModule - Input module for boost button control
 */
export function init(state, inputModule) {
  gameState = state;
  Input = inputModule;
}

// ============================================================================
// EXPORTED GETTERS
// ============================================================================

export function getRingModeActive() { return ringModeActive; }
export function getRingModeScore() { return ringModeScore; }
export function getRingModeHighScore() { return ringModeHighScore; }
export function getRingModeLives() { return ringModeLives; }
export function getRingModeRingCount() { return ringModeRingCount; }
export function getRingCameraSpeed() { return ringCameraSpeed; }
export function getRingModeVelocity() { return new THREE.Vector2(ringModeVelocity.x, ringModeVelocity.y); }
export function getRingModePosition() { return new THREE.Vector2(ringModePosition.x, ringModePosition.y); }
export function getRingModeStarted() { return ringModeStarted; }
export function getRingModePaused() { return ringModePaused; }
export function getCurrentDifficulty() { return currentDifficulty; }
export function getRings() { return rings; }

/**
 * Target ring for coaching: oldest unpassed ring still ahead of the car
 * (same rule updateRingModeRendering uses). Returns null if none.
 * arrival = game seconds until the ring reaches the car's plane (z = 0).
 */
export function getTargetRing() {
  let best = null;
  for (const r of rings) {
    if (!r || !r.mesh || r.passed || r.missed || r.mesh.position.z >= 0) continue;
    if (!best || r.spawnIndex < best.spawnIndex ||
        (r.spawnIndex === best.spawnIndex && r.mesh.position.z > best.mesh.position.z)) best = r;
  }
  if (!best) return null;
  const half = best.size / 2;
  return {
    id: best.spawnIndex,
    x: best.mesh.position.x,
    y: best.mesh.position.y,
    innerR: half - CONST.RING_TUBE_RADIUS,
    outerR: half + CONST.RING_TUBE_RADIUS,
    arrival: best.speed > 0 ? -best.mesh.position.z / best.speed : Infinity
  };
}
export function getCameraTarget() { return { x: cameraTargetX, y: cameraTargetY }; }
export function getBoostFlames() { return boostFlames; }

// ============================================================================
// HIGH SCORE HELPERS
// ============================================================================

/**
 * Get the settings key for the current difficulty's high score
 * @param {string} difficulty - Difficulty level ('easy', 'normal', 'hard', 'expert')
 * @returns {string} Settings key for that difficulty's high score
 */
function getHighScoreKey(difficulty) {
  switch (difficulty) {
    case 'easy': return 'ringModeHighScoreEasy';
    case 'hard': return 'ringModeHighScoreHard';
    case 'expert': return 'ringModeHighScoreExpert';
    case 'normal':
    default: return 'ringModeHighScoreNormal';
  }
}

/**
 * Load high score for current difficulty
 */
function loadHighScoreForDifficulty() {
  const key = getHighScoreKey(currentDifficulty);
  ringModeHighScore = getSetting(key) ?? 0;
}

/**
 * Save high score for current difficulty
 */
function saveHighScoreForDifficulty() {
  const key = getHighScoreKey(currentDifficulty);
  const settings = {};
  settings[key] = ringModeHighScore;
  saveSettings(settings);
}

// ============================================================================
// EXPORTED SETTERS
// ============================================================================

export function setRingModeActive(active) { ringModeActive = active; }
export function setRingModePaused(paused) { ringModePaused = paused; }
export function toggleRingModePaused() {
  ringModePaused = !ringModePaused;
  return ringModePaused;
}
export function setRingCameraSpeed(speed) { ringCameraSpeed = speed; }
export function setCurrentDifficulty(diff) {
  currentDifficulty = diff;
  saveSettings({ ringDifficulty: diff });
  // Load the high score for the new difficulty
  loadHighScoreForDifficulty();
}
export function setInverseGravity(enabled) {
  inverseGravity = enabled;
  saveSettings({ inverseGravity: enabled });
}
export function setRingModeLives(lives) { ringModeLives = lives; }
export function setRingModePosition(x, y) { ringModePosition.set(x, y); }
export function setRingModeVelocity(x, y) { ringModeVelocity.set(x, y); }

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize Ring Mode with scene and camera references
 * @param {THREE.Scene} sceneRef - Three.js scene
 * @param {THREE.Camera} cameraRef - Three.js camera
 * @param {THREE.WebGLRenderer} rendererRef - Three.js renderer
 * @param {Object} orbitOnRef - Orbit mode flag reference (object with value property)
 */
export function initRingMode(sceneRef, cameraRef, rendererRef, orbitOnRef) {
  scene = sceneRef;
  camera = cameraRef;
  renderer = rendererRef;
  externalOrbitOn = orbitOnRef;

  // Load settings
  currentDifficulty = getSetting('ringDifficulty') ?? 'normal';
  ringCameraSpeed = getSetting('ringCameraSpeed') ?? 0.1;

  // Load difficulty-specific high score
  loadHighScoreForDifficulty();

  // Preload resources
  preloadRingResources();

}

// ============================================================================
// RESOURCE PRELOADING
// ============================================================================

/**
 * Preload ring resources to prevent lag on first spawn
 */
function preloadRingResources() {
  if (ringResourcesPreloaded) {
    return;
  }

  // Cache shared geometry (all rings use same torus geometry)
  ringGeometryCache = new THREE.TorusGeometry(CONST.INITIAL_RING_SIZE / 2, CONST.RING_TUBE_RADIUS, 16, 32);

  // Cache materials for each color
  CONST.RING_COLORS.forEach(color => {
    const material = new THREE.MeshStandardMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 0.8,
      metalness: 0.3,
      roughness: 0.2
    });
    ringMaterialCache.set(color, material);
  });

  // Create a dummy ring offscreen and render it to compile shaders
  const dummyRing = new THREE.Mesh(
    ringGeometryCache,
    ringMaterialCache.get(CONST.RING_COLORS[0])
  );
  dummyRing.position.set(0, 0, -5000); // Far offscreen

  // Add point light to compile light shaders too
  const dummyLight = new THREE.PointLight(CONST.RING_COLORS[0], 2, 150);
  dummyRing.add(dummyLight);

  scene.add(dummyRing);

  // Render one frame to compile shaders
  renderer.render(scene, camera);

  // Clean up dummy ring
  scene.remove(dummyRing);
  dummyLight.dispose();

  // Preload boost flame geometry/material (compile shaders)
  if (Car.car) {
    // Create boost flames if they don't exist
    if (boostFlames.length === 0) {
      createBoostFlames();
    }

    // Briefly activate to compile shaders
    updateBoostFlames(true);
    renderer.render(scene, camera);
    updateBoostFlames(false);
  }

  ringResourcesPreloaded = true;
}

/**
 * Create boundary box visualization showing the kill barrier
 */
function createBoundaryGrid() {
  if (boundaryGrid) {
    // Clean up existing boundary
    scene.remove(boundaryGrid);
    boundaryGrid.geometry.dispose();
    boundaryGrid.material.dispose();
  }

  const size = CONST.RING_GRID_BOUNDS; // 1500 units

  // Create a simple box outline in XY plane (car moves in XY at z=0)
  // Box dimensions: width (X), height (Y), depth (Z toward camera)
  const geometry = new THREE.BoxGeometry(size * 2, size * 2, 10);
  const edges = new THREE.EdgesGeometry(geometry);
  const material = new THREE.LineBasicMaterial({
    color: 0xff0000, // Red
    opacity: 0.4,
    transparent: true
  });

  const boundaryBox = new THREE.LineSegments(edges, material);
  boundaryBox.position.z = 0; // Same Z as car (2D movement plane)

  geometry.dispose(); // Clean up the temporary geometry

  boundaryGrid = boundaryBox;
  scene.add(boundaryGrid);
}

/**
 * Create or update the 3D dashed circle landing indicator on the grid
 * This shows where the target ring will be positioned on the grid plane
 * Dashes are thick arcs that are hollow when player is outside, filled when inside
 * OPTIMIZATION: Only rebuilds geometry when ring changes or player crosses threshold
 */
function updateLandingIndicator() {
  // Find the target ring (oldest unpassed ring)
  const targetRing = rings.find(r => !r.passed && !r.missed);

  if (!targetRing) {
    // No target ring - hide indicator
    if (landingIndicator) {
      scene.remove(landingIndicator);

      // Clean up based on type (Mesh or Group)
      if (landingIndicator.geometry) {
        // It's a Mesh (filled state)
        landingIndicator.geometry.dispose();
        if (landingIndicator.material) {
          landingIndicator.material.dispose();
        }
      } else if (landingIndicator.children) {
        // It's a Group (hollow state)
        landingIndicator.children.forEach(child => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) child.material.dispose();
        });
        landingIndicator.children.length = 0;
      }

      landingIndicator = null;
      cachedTargetRingId = null;
      cachedPlayerInsideState = null;
    }

    // Also remove target point sphere if it exists
    if (targetPointSphere) {
      scene.remove(targetPointSphere);
      if (targetPointSphere.geometry) targetPointSphere.geometry.dispose();
      if (targetPointSphere.material) targetPointSphere.material.dispose();
      targetPointSphere = null;
    }
    return;
  }

  // Get ring's grid position (XY on the grid plane)
  const ringX = targetRing.mesh.position.x;
  const ringY = targetRing.mesh.position.y;
  const ringRadius = targetRing.size / 2;
  const ringColor = targetRing.mesh.material.color;

  // Check if player would pass through the ring (aligned properly)
  // Use same threshold as actual collision detection for accuracy
  const distanceToRing = Math.sqrt(
    (ringModePosition.x - ringX) ** 2 +
    (ringModePosition.y - ringY) ** 2
  );
  const wouldPass = distanceToRing <= ringRadius;

  // PERFORMANCE OPTIMIZATION: Only rebuild if ring changed or alignment state changed
  const ringId = targetRing.spawnIndex; // Use spawn index as unique ID
  if (cachedTargetRingId === ringId && cachedPlayerInsideState === wouldPass && landingIndicator) {
    // Ring and state unchanged - just update position (ring might be moving toward player)
    landingIndicator.position.set(ringX, ringY, 0);
    
    // Update target point sphere position if input assist is enabled
    if (getSetting('inputAssist') && targetPointSphere) {
      targetPointSphere.position.set(ringX, ringY + ringRadius, 0);
    }
    return;
  }

  // Cache miss - need to rebuild geometry
  cachedTargetRingId = ringId;
  cachedPlayerInsideState = wouldPass;

  // Dash configuration
  const dashCount = 24; // Number of dashes around circle
  const dashThickness = 12; // Thickness of each dash
  const dashOuterRadius = ringRadius;
  const dashInnerRadius = ringRadius - dashThickness;
  const dashAngle = 12; // degrees per dash
  const gapAngle = 3; // degrees between dashes

  // Create geometry for all dashes
  const dashGeometries = [];

  for (let i = 0; i < dashCount; i++) {
    const startAngle = i * (dashAngle + gapAngle) * (Math.PI / 180);
    const endAngle = (i * (dashAngle + gapAngle) + dashAngle) * (Math.PI / 180);

    if (wouldPass) {
      // FILLED: Draw solid dash segment
      const shape = new THREE.Shape();

      // Start at outer arc
      shape.moveTo(Math.cos(startAngle) * dashOuterRadius, Math.sin(startAngle) * dashOuterRadius);
      // Draw outer arc
      shape.absarc(0, 0, dashOuterRadius, startAngle, endAngle, false);
      // Line to inner radius
      shape.lineTo(Math.cos(endAngle) * dashInnerRadius, Math.sin(endAngle) * dashInnerRadius);
      // Draw inner arc backwards
      shape.absarc(0, 0, dashInnerRadius, endAngle, startAngle, true);
      // Close path
      shape.closePath();

      const geometry = new THREE.ShapeGeometry(shape);
      dashGeometries.push(geometry);
    } else {
      // HOLLOW: Draw only outer and inner arc outlines
      const outerPoints = [];
      const innerPoints = [];
      const segments = 16; // Segments per dash arc

      // Outer arc
      for (let j = 0; j <= segments; j++) {
        const angle = startAngle + (endAngle - startAngle) * (j / segments);
        outerPoints.push(new THREE.Vector3(
          Math.cos(angle) * dashOuterRadius,
          Math.sin(angle) * dashOuterRadius,
          0
        ));
      }

      // Inner arc
      for (let j = 0; j <= segments; j++) {
        const angle = startAngle + (endAngle - startAngle) * (j / segments);
        innerPoints.push(new THREE.Vector3(
          Math.cos(angle) * dashInnerRadius,
          Math.sin(angle) * dashInnerRadius,
          0
        ));
      }

      const outerGeometry = new THREE.BufferGeometry().setFromPoints(outerPoints);
      const innerGeometry = new THREE.BufferGeometry().setFromPoints(innerPoints);
      dashGeometries.push(outerGeometry, innerGeometry);
    }
  }

  // Remove old indicator
  if (landingIndicator) {
    scene.remove(landingIndicator);

    // Clean up based on type (Mesh or Group)
    if (landingIndicator.geometry) {
      // It's a Mesh (filled state with merged geometry)
      landingIndicator.geometry.dispose();
      if (landingIndicator.material) {
        landingIndicator.material.dispose();
      }
    } else if (landingIndicator.children) {
      // It's a Group (hollow state with multiple line segments)
      landingIndicator.children.forEach(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
      // Clear children array
      landingIndicator.children.length = 0;
    }

    landingIndicator = null;
  }

  if (wouldPass) {
    // Merge all filled dash geometries into one mesh
    const mergedGeometry = BufferGeometryUtils.mergeGeometries(dashGeometries);
    dashGeometries.forEach(g => g.dispose());

    const material = new THREE.MeshBasicMaterial({
      color: ringColor,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide
    });

    landingIndicator = new THREE.Mesh(mergedGeometry, material);
  } else {
    // Create line segments for hollow dashes
    const material = new THREE.LineBasicMaterial({
      color: ringColor,
      transparent: true,
      opacity: 0.8,
      linewidth: 2
    });

    landingIndicator = new THREE.Group();
    dashGeometries.forEach(geom => {
      const line = new THREE.Line(geom, material);
      landingIndicator.add(line);
    });
  }

  landingIndicator.position.set(ringX, ringY, 0); // Position on grid at z=0
  scene.add(landingIndicator);

  // Update target point sphere if input assist is enabled
  if (getSetting('inputAssist')) {
    updateTargetPointSphere(ringX, ringY, ringRadius, ringColor);
  } else if (targetPointSphere) {
    // Input assist disabled - remove sphere if it exists
    scene.remove(targetPointSphere);
    if (targetPointSphere.geometry) targetPointSphere.geometry.dispose();
    if (targetPointSphere.material) targetPointSphere.material.dispose();
    targetPointSphere = null;
  }
}

/**
 * Create or update the target point sphere (for input assist visualization)
 * Shows a 3D sphere at the top of the ring on the grid
 */
function updateTargetPointSphere(ringX, ringY, ringRadius, ringColor) {
  if (!scene) return;

  // Remove old plane if it exists
  if (targetPointSphere) {
    scene.remove(targetPointSphere);
    if (targetPointSphere.geometry) targetPointSphere.geometry.dispose();
    if (targetPointSphere.material) targetPointSphere.material.dispose();
    targetPointSphere = null;
  }

  // Create 200x400 square plane at target point (top of ring), perpendicular to grid
  // 200 units wide (left-right), 400 units tall (forward-back)
  const planeGeometry = new THREE.PlaneGeometry(200, 400);
  const planeMaterial = new THREE.MeshBasicMaterial({
    color: ringColor,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide
  });

  targetPointSphere = new THREE.Mesh(planeGeometry, planeMaterial);
  targetPointSphere.position.set(ringX, ringY + ringRadius, 0); // Top of ring on grid at z=0
  // Rotate to be perpendicular to grid (facing up/down in world space)
  targetPointSphere.rotation.x = Math.PI / 2;
  scene.add(targetPointSphere);
}

// ============================================================================
// RING MODE CONTROL
// ============================================================================

/**
 * Reset Ring Mode (for retry button)
 */
/**
 * Reset only physics state (for rhythm mode)
 * Does NOT reset game state or start ring mode
 */
export function resetRingModePhysicsOnly() {
  ringModeVelocity.set(0, 0);
  ringModePosition.set(0, 0);
  ringModeStarted = false;
  ignoreBoostUntilRelease = true;
  
  // Also reset car to match ring mode starting position/rotation (respect gravity setting)
  if (Car.car) {
    Car.car.quaternion.identity();
    const yRotation = inverseGravity ? Math.PI : 0;
    Car.car.rotation.set(Math.PI * 1.5, yRotation, Math.PI);
    Car.car.position.set(0, 0, 0);
  }
  
  // Reset external physics state
  if (gameState) {
    gameState.resetAngularVelocity();
  }
}

export function resetRingMode() {
  Coach.reset();
  ringModeScore = 0;
  ringModeLives = CONST.DIFFICULTY_SETTINGS[currentDifficulty].initialLives;
  ringModeRingCount = 0;
  ringModeVelocity.set(0, 0);
  ringModePosition.set(0, 0);
  ringSpawnTimer = 0;
  ringSpawnIndex = 0;
  currentColorIndex = 0;
  ringModeStarted = false;
  ringModePaused = false;
  ignoreBoostUntilRelease = true; // Ignore boost until player releases it
  patternRingCount = 0;
  cameraTargetX = 0;
  cameraTargetY = 0;

  // Reset section variables for hard mode
  currentSection = null;
  sectionRingCount = 0;
  sectionDuration = 0;
  sectionSpawnInterval = 1.0;
  sectionSpeed = 1.0;
  sectionAmplitude = 1.0;

  clearAllRings();
  clearBoostFlames();

  if (Car.car) {
    Car.car.quaternion.identity();
    // Respect gravity setting for car orientation
    const yRotation = inverseGravity ? Math.PI : 0;
    Car.car.rotation.set(Math.PI * 1.5, yRotation, Math.PI);
    Car.car.position.set(0, 0, 0);
  }

  // Reset external physics state
  if (gameState) {
    gameState.resetAngularVelocity();
  }

  if (externalOrbitOn) {
    externalOrbitOn.value = false;
  }

  spawnRing();

  // Restart music
  Audio.startBackgroundMusic();
}

/**
 * Start Ring Mode
 */
export function startRingMode() {
  ringModeActive = true;
  gameState.setRingModeActive(true);

  // Show boost button and ensure positions are correct
  if (Input) {
    Input.setRingModeActive(true);
    Input.handleResize(); // Ensure button positions are updated for current window size
  }

  // Initialize Ring Mode
  ringModeScore = 0;
  ringModeLives = CONST.DIFFICULTY_SETTINGS[currentDifficulty].initialLives;
  ringModeRingCount = 0;
  ringModeVelocity.set(0, 0);
  ringModePosition.set(0, 0);
  ringSpawnTimer = 0;
  ringSpawnIndex = 0;
  currentColorIndex = 0;
  ringModeStarted = false;
  ringModePaused = false;
  ignoreBoostUntilRelease = true; // Ignore boost until player releases it
  patternRingCount = 0;
  cameraTargetX = 0;
  cameraTargetY = 0;

  // Reset section variables for hard mode
  currentSection = null;
  sectionRingCount = 0;
  sectionDuration = 0;
  sectionSpawnInterval = 1.0;
  sectionSpeed = 1.0;
  sectionAmplitude = 1.0;

  clearAllRings();

  // Create boundary grid visualization
  createBoundaryGrid();

  // Resources already preloaded at startup, just spawn first ring
  spawnRing();

  if (Car.car) {
    Car.car.quaternion.identity();
    // Set car orientation based on gravity mode
    // Normal gravity: nose pointing up (default)
    // Inverse gravity: nose pointing down (180° yaw rotation)
    if (inverseGravity) {
      Car.car.rotation.set(Math.PI * 1.5, Math.PI, Math.PI); // Rotate 180° around yaw axis
    } else {
      Car.car.rotation.set(Math.PI * 1.5, 0, Math.PI); // Normal orientation
    }
    Car.car.position.set(0, 0, 0);
  }

  // Reset external physics state
  gameState.resetAngularVelocity();

  if (externalOrbitOn) {
    externalOrbitOn.value = false;
  }

  // Start background music
  Audio.startBackgroundMusic();
}

/**
 * Stop Ring Mode
 */
export function stopRingMode() {
  ringModeActive = false;
  gameState.setRingModeActive(false);

  // Hide boost button
  if (Input) {
    Input.setRingModeActive(false);
  }

  // Clean up
  ringModeVelocity.set(0, 0);
  ringModePosition.set(0, 0);
  clearAllRings();
  clearBoostFlames();

  // Remove boundary grid
  if (boundaryGrid) {
    scene.remove(boundaryGrid);
    boundaryGrid.geometry.dispose();
    boundaryGrid.material.dispose();
    boundaryGrid = null;
  }

  // Remove landing indicator
  if (landingIndicator) {
    scene.remove(landingIndicator);

    // Clean up based on type (Mesh or Group)
    if (landingIndicator.geometry) {
      // It's a Mesh (filled state)
      landingIndicator.geometry.dispose();
      landingIndicator.material.dispose();
    } else if (landingIndicator.children) {
      // It's a Group (hollow state)
      landingIndicator.children.forEach(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
    }

    landingIndicator = null;
  }

  // Return car to default spawn/orientation for main mode
  if (Car.car) {
    Car.car.quaternion.identity();
    Car.car.rotation.set(0, 0, 0);
    Car.car.position.set(0, 0, 0);
  }

  // Clear any carried angular velocity from ring mode
  gameState.resetAngularVelocity();

  // Stop background music
  Audio.stopBackgroundMusic();
}

/**
 * Toggle Ring Mode on/off
 */
export function toggleRingMode() {
  if (ringModeActive) {
    stopRingMode();
  } else {
    startRingMode();
  }
  return ringModeActive;
}

// ============================================================================
// RING CREATION AND MANAGEMENT
// ============================================================================

/**
 * Create a ring with neon 80s aesthetic (uses cached resources)
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} z - Z position
 * @param {number} size - Ring size
 * @param {number} speed - Movement speed
 * @param {number} spawnIndex - Spawn order index
 * @returns {Object} Ring object
 */
function createRing(x, y, z, size, speed, spawnIndex) {
  // VALIDATION: Ensure all position values are finite numbers
  if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
    console.error('Invalid ring position detected:', { x, y, z });
    // Use safe defaults if NaN detected (center of grid)
    x = isFinite(x) ? x : 0;
    y = isFinite(y) ? y : 0;
    z = isFinite(z) ? z : -1000; // Default spawn distance
  }

  const color = CONST.RING_COLORS[currentColorIndex];
  currentColorIndex = (currentColorIndex + 1) % CONST.RING_COLORS.length;

  // ALWAYS use cached geometry for performance (prevents lag on spawn)
  // Scale the mesh instead of creating new geometry for different sizes
  const geometry = ringGeometryCache;
  const cachedMaterial = ringMaterialCache.get(color);
  const material = cachedMaterial || new THREE.MeshStandardMaterial({
    color: color,
    emissive: color,
    emissiveIntensity: 0.8,
    metalness: 0.3,
    roughness: 0.2
  });

  const ring = new THREE.Mesh(geometry, material);
  ring.position.set(x, y, z);

  // Scale ring to match requested size (cached geometry is for CONST.INITIAL_RING_SIZE)
  const scale = size / CONST.INITIAL_RING_SIZE;
  ring.scale.set(scale, scale, scale);

  // Add point light for glow effect
  const light = new THREE.PointLight(color, 2, 150);
  light.position.set(0, 0, 0);
  ring.add(light);

  scene.add(ring);

  const spawnTime = performance.now() / 1000; // Convert to seconds
  
  return {
    mesh: ring,
    size: size,
    speed: speed,
    passed: false,
    spawnTime: spawnTime,
    spawnZ: z,
    spawnX: x,
    spawnY: y,
    spawnDistance: Math.abs(z),
    missed: false,
    spawnIndex: spawnIndex, // Track when this ring was spawned
    playerReachedTime: null, // Will be set when player reaches ring XY
    ringPassedTime: null // Will be set when ring reaches z=0
  };
}

/**
 * Properly dispose a ring's resources (geometry, material, lights)
 * @param {object} ring - Ring object to dispose
 */
function disposeRing(ring) {
  // Null safety: ensure ring and ring.mesh exist
  if (!ring || !ring.mesh) return;

  // Remove from scene
  scene.remove(ring.mesh);

  // Dispose point light (child of ring mesh)
  if (ring.mesh.children && ring.mesh.children.length > 0) {
    ring.mesh.children.forEach(child => {
      if (child instanceof THREE.Light) {
        child.dispose(); // Dispose light resources
      }
    });
  }

  // Don't dispose geometry/materials - they're cached and reused!
  // Only dispose if not using cache (fallback case)
  if (ring.mesh.geometry !== ringGeometryCache) {
    ring.mesh.geometry.dispose();
  }

  // Check if material is cached by comparing against cached materials
  let isCached = false;
  for (const cachedMaterial of ringMaterialCache.values()) {
    if (cachedMaterial === ring.mesh.material) {
      isCached = true;
      break;
    }
  }
  if (!isCached) {
    ring.mesh.material.dispose();
  }
}

/**
 * Remove all rings from scene
 */
function clearAllRings() {
  rings.forEach(r => disposeRing(r));
  rings = [];
  
  // Also clear target point sphere when all rings are removed
  if (targetPointSphere) {
    scene.remove(targetPointSphere);
    if (targetPointSphere.geometry) targetPointSphere.geometry.dispose();
    if (targetPointSphere.material) targetPointSphere.material.dispose();
    targetPointSphere = null;
  }
}

// ============================================================================
// PATTERN GENERATION
// ============================================================================

/**
 * Select a new section for hard mode
 */
function selectNewSection() {
  const sectionTypes = Object.keys(CONST.HARD_MODE_SECTIONS);
  const sectionType = sectionTypes[Math.floor(Math.random() * sectionTypes.length)];
  const section = CONST.HARD_MODE_SECTIONS[sectionType];

  currentSection = sectionType;
  sectionRingCount = 0;
  sectionDuration = section.duration;
  sectionSpawnInterval = section.spawnIntervalMultiplier;
  sectionSpeed = section.speedMultiplier;
  sectionAmplitude = section.amplitudeMultiplier;

  return section;
}

/**
 * Select a new ring pattern based on difficulty and progression
 */
function selectNewPattern() {
  const difficultySettings = CONST.DIFFICULTY_SETTINGS[currentDifficulty];

  // Progressive difficulty based on rings completed (affected by difficulty setting)
  const difficultyLevel = Math.floor(ringModeRingCount / 5 * difficultySettings.progressionRate);

  // HARD MODE: Use section-based pattern selection
  if (currentDifficulty === 'hard') {
    // Check if we need a new section
    if (sectionRingCount === 0 || sectionRingCount >= sectionDuration) {
      const section = selectNewSection();
      // Pick pattern from section's allowed patterns
      currentPattern = section.patterns[Math.floor(Math.random() * section.patterns.length)];
      patternRingCount = 0;
      patternLength = section.duration;
    } else {
      // Continue current section - optionally change pattern mid-section
      const section = CONST.HARD_MODE_SECTIONS[currentSection];
      if (patternRingCount >= patternLength) {
        currentPattern = section.patterns[Math.floor(Math.random() * section.patterns.length)];
        patternRingCount = 0;
        patternLength = Math.max(3, Math.floor(section.duration / 2)); // Vary pattern within section
      }
    }

    // Section-specific amplitude and frequency
    const baseAmplitude = (250 + (difficultyLevel * 80)) * sectionAmplitude;
    const amplitudeVariance = (150 + (difficultyLevel * 40)) * sectionAmplitude;
    patternAmplitude = Math.min(baseAmplitude + Math.random() * amplitudeVariance, CONST.RING_GRID_BOUNDS * 0.9);

    const baseFrequency = 0.4 + (difficultyLevel * 0.08);
    patternFrequency = Math.min(baseFrequency + Math.random() * 0.4, 1.8);

    patternPhase = Math.random() * Math.PI * 2;
    return;
  }

  // NORMAL/EASY MODE: Original progressive unlock logic
  let availablePatterns = difficultySettings.allowedPatterns || PATTERN_TYPES;

  // If no specific pattern restriction, use progressive unlock (Normal/Hard modes)
  if (!difficultySettings.allowedPatterns) {
    if (difficultyLevel < 2) {
      // First 10 rings: easier straight/simple patterns
      availablePatterns = ['horizontal_line', 'vertical_line', 'sine_horizontal', 'sine_vertical'];
    } else if (difficultyLevel < 4) {
      // Rings 10-20: introduce more complex patterns
      availablePatterns = ['sine_horizontal', 'sine_vertical', 'wave_combo', 'helix', 'spiral'];
    }
    // After 20 rings: all patterns available

    // Exclude 'random' pattern if difficulty setting requires it (Normal mode)
    if (difficultySettings.excludeRandomPattern) {
      availablePatterns = availablePatterns.filter(p => p !== 'random');
    }
  }

  currentPattern = availablePatterns[Math.floor(Math.random() * availablePatterns.length)];
  patternRingCount = 0;
  patternLength = 8 + Math.floor(Math.random() * 12); // 8-20 rings per pattern

  // Progressive amplitude and frequency increase (affected by difficulty)
  // Expert mode starts with wider spreads immediately (baseAmplitude boosted by +400)
  // Easy mode gets even wider spread to force player movement
  const expertBoost = currentDifficulty === 'expert' ? 400 : 0;
  const easyBoost = currentDifficulty === 'easy' ? 300 : 0; // Extra spread for easy mode
  const baseAmplitude = (200 + expertBoost + easyBoost + (difficultyLevel * 100)) * difficultySettings.patternAmplitudeMultiplier;
  const amplitudeVariance = (200 + (difficultyLevel * 50)) * difficultySettings.patternAmplitudeMultiplier;
  patternAmplitude = Math.min(baseAmplitude + Math.random() * amplitudeVariance, CONST.RING_GRID_BOUNDS * 0.9);

  const baseFrequency = 0.3 + (difficultyLevel * 0.1); // Faster oscillations as difficulty increases
  patternFrequency = Math.min(baseFrequency + Math.random() * 0.5, 2.0);

  patternPhase = Math.random() * Math.PI * 2;
}

/**
 * Get position for ring based on current pattern
 * @param {number} progress - Progress through pattern (0-1)
 * @returns {Object} { x, y } position
 */
function getPatternPosition(progress) {
  const t = progress; // 0 to 1 through the pattern
  let x = 0, y = 0;

  switch(currentPattern) {
    case 'sine_horizontal':
      // Horizontal sine wave
      x = Math.sin(t * Math.PI * 2 * patternFrequency + patternPhase) * patternAmplitude;
      y = (Math.random() - 0.5) * 200; // Small random Y variance
      break;

    case 'sine_vertical':
      // Vertical sine wave
      x = (Math.random() - 0.5) * 200;
      y = Math.sin(t * Math.PI * 2 * patternFrequency + patternPhase) * patternAmplitude;
      break;

    case 'spiral': {
      // Expanding or contracting spiral
      const spiralRadius = patternAmplitude * (0.3 + t * 0.7);
      const spiralAngle = t * Math.PI * 4 + patternPhase;
      x = Math.cos(spiralAngle) * spiralRadius;
      y = Math.sin(spiralAngle) * spiralRadius;
      break;
    }

    case 'helix': {
      // Helix (circular with vertical oscillation)
      const helixAngle = t * Math.PI * 3 + patternPhase;
      x = Math.cos(helixAngle) * patternAmplitude;
      y = Math.sin(t * Math.PI * 2 * patternFrequency) * (patternAmplitude * 0.5);
      break;
    }

    case 'figure8': {
      // Figure-8 pattern
      const fig8t = t * Math.PI * 2 + patternPhase;
      x = Math.sin(fig8t) * patternAmplitude;
      y = Math.sin(fig8t * 2) * patternAmplitude * 0.7;
      break;
    }

    case 'vertical_line':
      // Straight vertical line
      x = (Math.random() - 0.5) * 100;
      y = -patternAmplitude + (t * patternAmplitude * 2);
      break;

    case 'horizontal_line':
      // Straight horizontal line
      x = -patternAmplitude + (t * patternAmplitude * 2);
      y = (Math.random() - 0.5) * 100;
      break;

    case 'wave_combo':
      // Combined horizontal and vertical waves
      x = Math.sin(t * Math.PI * 2 * patternFrequency + patternPhase) * patternAmplitude;
      y = Math.cos(t * Math.PI * 2 * patternFrequency * 1.3) * (patternAmplitude * 0.6);
      break;

    case 'square': {
      // Square path
      const squareSide = Math.min(Math.floor(t * 4), 3); // 4 sides, clamp to 0-3
      const sideProgress = (t * 4) % 1; // Progress along current side
      const squareSize = patternAmplitude * 0.8;
      if (squareSide === 0) {
        // Bottom side (left to right)
        x = -squareSize + sideProgress * squareSize * 2;
        y = -squareSize;
      } else if (squareSide === 1) {
        // Right side (bottom to top)
        x = squareSize;
        y = -squareSize + sideProgress * squareSize * 2;
      } else if (squareSide === 2) {
        // Top side (right to left)
        x = squareSize - sideProgress * squareSize * 2;
        y = squareSize;
      } else {
        // Left side (top to bottom)
        x = -squareSize;
        y = squareSize - sideProgress * squareSize * 2;
      }
      break;
    }

    case 'triangle': {
      // Triangle path
      const triSide = Math.min(Math.floor(t * 3), 2); // 3 sides, clamp to 0-2
      const triProgress = (t * 3) % 1;
      const triSize = patternAmplitude * 0.8;
      if (triSide === 0) {
        // Bottom side (left to right)
        x = -triSize + triProgress * triSize * 2;
        y = -triSize * 0.577; // Height of equilateral triangle
      } else if (triSide === 1) {
        // Right side (bottom-right to top)
        x = triSize - triProgress * triSize;
        y = -triSize * 0.577 + triProgress * triSize * 1.732;
      } else {
        // Left side (top to bottom-left)
        x = 0 - triProgress * triSize;
        y = triSize * 1.155 - triProgress * triSize * 1.732;
      }
      break;
    }

    case 'star': {
      // 5-pointed star
      const starPoints = 10; // 5 outer + 5 inner points
      const starIndex = Math.floor(t * starPoints) % starPoints;
      const isOuter = starIndex % 2 === 0;
      const starRadius = isOuter ? patternAmplitude : patternAmplitude * 0.4;
      const pointAngle = (starIndex / starPoints) * Math.PI * 2 + patternPhase;
      x = Math.cos(pointAngle) * starRadius;
      y = Math.sin(pointAngle) * starRadius;
      break;
    }

    case 'pentagon': {
      // Pentagon path
      const pentSide = Math.min(Math.floor(t * 5), 4); // 5 sides, clamp to 0-4
      const pentProgress = (t * 5) % 1;
      const pentRadius = patternAmplitude * 0.8;
      const angle1 = (pentSide / 5) * Math.PI * 2 - Math.PI / 2 + patternPhase;
      const angle2 = ((pentSide + 1) / 5) * Math.PI * 2 - Math.PI / 2 + patternPhase;
      const x1 = Math.cos(angle1) * pentRadius;
      const y1 = Math.sin(angle1) * pentRadius;
      const x2 = Math.cos(angle2) * pentRadius;
      const y2 = Math.sin(angle2) * pentRadius;
      x = x1 + (x2 - x1) * pentProgress;
      y = y1 + (y2 - y1) * pentProgress;
      break;
    }

    case 'random':
    default:
      // Pure random
      x = (Math.random() - 0.5) * CONST.RING_GRID_BOUNDS * 0.8;
      y = (Math.random() - 0.5) * CONST.RING_GRID_BOUNDS * 0.8;
      break;
  }

  // Distance cap: Limit maximum distance from current player position
  // Max distance = grid radius (center to edge = 1500 units)
  const MAX_RING_DISTANCE = CONST.RING_GRID_BOUNDS; // 1500 units (half the total grid width)
  const dx = x - ringModePosition.x;
  const dy = y - ringModePosition.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance > MAX_RING_DISTANCE) {
    // Clamp to max distance while preserving direction
    const scale = MAX_RING_DISTANCE / distance;
    x = ringModePosition.x + dx * scale;
    y = ringModePosition.y + dy * scale;
  }

  return { x, y };
}

/**
 * Calculate minimum time needed to reach a ring position on the 2D grid
 * Physics-based calculation using realistic car acceleration with gravity strategy
 * 
 * CORE MODEL: 2D grid-based movement
 * - Player is always at Z=0 on the grid
 * - Target ring is at (ringX, ringY, 0) on the grid
 * - Ring travels 1100 units from spawn point to reach grid
 * - Player must reach ring center simultaneously with ring arrival
 * 
 * GRAVITY STRATEGY:
 * - X-axis: Full boost available (1300 units/s²), angled slightly up to fight gravity
 * - Y-axis (up): Boost (1300) - Gravity (650) = 650 units/s²
 * - Y-axis (down): Boost (1300) + Gravity (650) = 1950 units/s² (gravity assists)
 * 
 * TIME COMPONENTS:
 * - Reaction time: Difficulty-dependent (100-250ms)
 * - Orientation time: Angle-based rotation to face target
 * - Travel time: Physics calculation for X and Y distances (using max time for both axes)
 * - Stabilization time: Buffer to settle in ring (200ms)
 * - Efficiency scaling: Difficulty-based player ability curve
 *
 * @param {number} targetX - Ring X position
 * @param {number} targetY - Ring Y position
 * @param {number} currentX - Current car X position
 * @param {number} currentY - Current car Y position
 * @param {number} currentVelX - Current car X velocity
 * @param {number} currentVelY - Current car Y velocity
 * @param {number} ringCount - Current ring count for progressive skill scaling
 * @param {string} difficulty - Difficulty level for reaction time and efficiency
 * @returns {number} Minimum time in seconds to reach the ring
 */
function calculateMinimumTimeToReach(targetX, targetY, currentX, currentY, currentVelX, currentVelY, ringCount = 0, difficulty = 'normal') {
  // Physics constants
  const BOOST_ACCEL = CONST.RING_BOOST_ACCEL; // 1300 units/s²
  const GRAVITY = Math.abs(CONST.RING_GRAVITY); // 650 units/s²
  const TURN_SPEED = CONST.DAR_ROLL_SPEED; // 5.5 rad/s
  
  // Time components - difficulty-dependent reaction time
  let REACTION_TIME;
  if (difficulty === 'easy') {
    REACTION_TIME = 0.25; // 250ms - novice players need more time to react
  } else if (difficulty === 'normal') {
    REACTION_TIME = 0.20; // 200ms - moderate reaction time
  } else if (difficulty === 'hard') {
    REACTION_TIME = 0.15; // 150ms - experienced players
  } else if (difficulty === 'expert') {
    REACTION_TIME = 0.10; // 100ms - expert players react fast
  }
  const STABILIZATION_TIME = 0.20; // 200ms to stabilize in ring
  
  // Calculate 2D distance and direction
  const dx = targetX - currentX;
  const dy = targetY - currentY;
  const distance2D = Math.sqrt(dx * dx + dy * dy);
  
  // PROGRESSIVE SKILL SCALING - Each difficulty has its own efficiency curve
  const SKILL_START_RING = CONST.RING_SKILL_START_COUNT;
  const SKILL_END_RING = CONST.RING_SKILL_END_COUNT;
  let efficiency;
  
  // Determine efficiency range based on difficulty
  let startEfficiency, endEfficiency;
  if (difficulty === 'easy') {
    startEfficiency = CONST.RING_SKILL_EASY_START_EFFICIENCY;
    endEfficiency = CONST.RING_SKILL_EASY_END_EFFICIENCY;
  } else if (difficulty === 'normal') {
    startEfficiency = CONST.RING_SKILL_NORMAL_START_EFFICIENCY;
    endEfficiency = CONST.RING_SKILL_NORMAL_END_EFFICIENCY;
  } else if (difficulty === 'hard') {
    startEfficiency = CONST.RING_SKILL_HARD_START_EFFICIENCY;
    endEfficiency = CONST.RING_SKILL_HARD_END_EFFICIENCY;
  } else if (difficulty === 'expert') {
    startEfficiency = CONST.RING_SKILL_EXPERT_START_EFFICIENCY;
    endEfficiency = CONST.RING_SKILL_EXPERT_MAX_EFFICIENCY;
  }
  
  // Calculate progressive efficiency based on ring count
  if (ringCount >= SKILL_END_RING) {
    efficiency = endEfficiency;
  } else if (ringCount > SKILL_START_RING) {
    const progress = (ringCount - SKILL_START_RING) / (SKILL_END_RING - SKILL_START_RING);
    efficiency = startEfficiency + (progress * (endEfficiency - startEfficiency));
  } else {
    efficiency = startEfficiency;
  }
  
  // Close-range simplified calculation
  if (distance2D < CONST.RING_CLOSE_DISTANCE_THRESHOLD) {
    const perfectCloseTime = REACTION_TIME + 0.1 + CONST.RING_CLOSE_RING_SIMPLIFIED_TIME + STABILIZATION_TIME;
    return perfectCloseTime / Math.max(0.01, efficiency);
  }
  
  // === CALCULATE ORIENTATION TIME ===
  // Calculate actual angle needed to face the target
  const carFacingAngle = 0; // Car faces +X direction
  const angleToTarget = Math.atan2(dy, dx);
  let angleDifference = angleToTarget - carFacingAngle;
  
  // Normalize to shortest rotation path (-π to π)
  while (angleDifference > Math.PI) angleDifference -= 2 * Math.PI;
  while (angleDifference < -Math.PI) angleDifference += 2 * Math.PI;
  
  const actualTurnAngle = Math.abs(angleDifference);
  const orientationTime = actualTurnAngle / TURN_SPEED;
  
  // === CALCULATE TRAVEL TIME FOR EACH AXIS INDEPENDENTLY ===
  // The player must reach both the X and Y targets simultaneously
  // This means we calculate time for each axis and use the maximum
  
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  
  // X-AXIS CALCULATION: Full boost available (need to angle slightly up to fight gravity)
  // Effective acceleration: BOOST_ACCEL * cos(θ) where sin(θ) = GRAVITY/BOOST_ACCEL
  const horizontalBoostAccel = BOOST_ACCEL * Math.sqrt(1 - Math.pow(GRAVITY / BOOST_ACCEL, 2)); // ≈1126 units/s²
  
  let travelTimeX = 0;
  if (absX > 10) {
    // Simple acceleration from current velocity to reach distance
    // Using kinematic equation: d = v₀t + 0.5at²
    // Solve for t: 0.5at² + v₀t - d = 0
    const a = 0.5 * horizontalBoostAccel;
    const b = currentVelX; // Start with current velocity in X direction
    const c = -absX; // Distance to cover
    
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      travelTimeX = (-b + Math.sqrt(discriminant)) / (2 * a);
      travelTimeX = Math.max(0, travelTimeX); // Ensure non-negative
    } else {
      // Fallback: constant velocity if discriminant fails
      travelTimeX = absX / Math.max(1, Math.abs(currentVelX));
    }
  }
  
  // Y-AXIS CALCULATION: Boost with gravity assistance/hindrance
  // Inverse gravity flips the gravity direction
  const isGoingUp = inverseGravity ? (dy < 0) : (dy > 0); // Flip direction if inverse gravity
  const verticalAccel = isGoingUp ? (BOOST_ACCEL - GRAVITY) : (BOOST_ACCEL + GRAVITY); // 650 or 1950 units/s²
  
  let travelTimeY = 0;
  if (absY > 10) {
    // Same kinematic approach as X-axis, but with different acceleration
    const a = 0.5 * verticalAccel;
    const b = currentVelY; // Start with current velocity in Y direction
    const c = -absY; // Distance to cover
    
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      travelTimeY = (-b + Math.sqrt(discriminant)) / (2 * a);
      travelTimeY = Math.max(0, travelTimeY); // Ensure non-negative
    } else {
      // Fallback: constant velocity if discriminant fails
      travelTimeY = absY / Math.max(1, Math.abs(currentVelY));
    }
  }
  
  // Player must cover both X and Y distances - use maximum time
  const perfectTravelTime = Math.max(travelTimeX, travelTimeY);
  
  // Scale by player efficiency
  const scaledTravelTime = perfectTravelTime / Math.max(0.01, efficiency);
  
  // Total time: reaction + turn + travel + stabilization
  const totalTime = REACTION_TIME + orientationTime + scaledTravelTime + STABILIZATION_TIME;
  
  return totalTime;
}

/**
 * SAFEGUARD 1: Check if rings are too close together in Z-axis
 * Prevents clustering by enforcing minimum Z-distance between rings
 * @returns {boolean} true if there's a close ring (should skip spawn)
 */
function checkZSpacingSafeguard() {
  return rings.some(r => Math.abs(r.mesh.position.z - CONST.RING_SPAWN_DISTANCE) < CONST.RING_MIN_Z_SPACING);
}

/**
 * Get spawn position from pattern and update pattern state
 * @returns {{x: number, y: number, z: number}} Spawn coordinates
 */
function calculateRingSpawnPosition() {
  // Check if we need a new pattern
  if (patternRingCount === 0 || patternRingCount >= patternLength) {
    selectNewPattern();
  }

  // Get position from current pattern
  patternProgress = patternRingCount / patternLength;
  const pos = getPatternPosition(patternProgress);
  const spawnX = pos.x;
  // Easy difficulty: lock rings to X-axis only (no vertical movement)
  const spawnY = currentDifficulty === 'easy' ? 0 : pos.y;
  const spawnZ = CONST.RING_SPAWN_DISTANCE;

  patternRingCount++;

  return { x: spawnX, y: spawnY, z: spawnZ };
}

/**
 * Calculate ring size based on progression and difficulty
 * @param {number} ringCount - Current ring count
 * @returns {number} Ring size in units
 */
function calculateRingSize(ringCount) {
  const difficultySettings = CONST.DIFFICULTY_SETTINGS[currentDifficulty];

  // Calculate progression based on ring count (every 10 rings, affected by difficulty)
  // CAP at level 5 (50 rings) to prevent extreme difficulty at high ring counts
  const progressionLevel = Math.min(Math.floor(ringCount / 10 * difficultySettings.progressionRate), 5);

  // Size: -5% every 10 rings (max 50% reduction at level 10), then apply difficulty multiplier
  const sizeReduction = progressionLevel * 0.05;
  return CONST.INITIAL_RING_SIZE * (1 - Math.min(sizeReduction, 0.5)) * difficultySettings.sizeMultiplier;
}

/**
 * Calculate ring speed based on physics-based timing
 * @param {number} spawnX - Ring spawn X position
 * @param {number} spawnY - Ring spawn Y position
 * @param {number} ringSize - Ring size in units (unused, kept for compatibility)
 * @param {number} distanceRatio - Distance ratio (unused, kept for compatibility)
 * @param {number} sourceX - Source X position (where player is coming from - usually previous ring)
 * @param {number} sourceY - Source Y position (where player is coming from - usually previous ring)
 * @returns {number} Ring speed in units per second
 */
function calculateRingSpeed(spawnX, spawnY, ringSize, distanceRatio, sourceX, sourceY) {
  // Use provided source position (previous ring), or fall back to player position
  const calcSourceX = sourceX !== undefined ? sourceX : ringModePosition.x;
  const calcSourceY = sourceY !== undefined ? sourceY : ringModePosition.y;
  
  // PHYSICS-BASED TIMING CALCULATION
  // This calculates how long it takes for the player to realistically reach the ring position
  // accounting for: reaction time, turn speed, acceleration with gravity, deceleration, and stabilization
  // Starting from the previous ring's position (or player position if no previous ring)
  const minTimeToReach = calculateMinimumTimeToReach(
    spawnX, spawnY,
    calcSourceX, calcSourceY,
    0, 0,  // Assume starting from rest at previous ring (velocity = 0)
    ringModeRingCount,
    currentDifficulty
  );

  // Ring travels from spawn distance to pass-through point (z=0)
  const ringTravelDistance = Math.abs(CONST.RING_SPAWN_DISTANCE);
  
  // Speed = distance / time
  // The minTimeToReach already includes all difficulty scaling via efficiency factors
  // No additional multipliers needed - the physics calculation is the difficulty
  const ringSpeed = ringTravelDistance / minTimeToReach;

  // Clamp to reasonable bounds (prevent extreme cases)
  return Math.max(80, Math.min(350, ringSpeed));
}

/**
 * SAFEGUARDS 2 & 3: Check arrival time and momentum conflicts
 * @param {number} spawnX - Ring spawn X position
 * @param {number} spawnY - Ring spawn Y position
 * @param {number} spawnZ - Ring spawn Z position
 * @param {number} ringSpeed - Ring speed in units per second
 * @returns {boolean} true if spawn is safe, false if conflicts detected
 */
function checkSpawnSafeguards(spawnX, spawnY, spawnZ, ringSpeed) {
  const thisRingArrivalTime = Math.abs(spawnZ) / ringSpeed;

  const MIN_ARRIVAL_TIME_SEPARATION = currentDifficulty === 'hard'
    ? CONST.RING_MIN_ARRIVAL_SEPARATION_HARD
    : CONST.RING_MIN_ARRIVAL_SEPARATION_NORMAL;
  const MOMENTUM_COMMITMENT_TIME = CONST.RING_MOMENTUM_COMMITMENT_TIME;
  const OPPOSITE_DIRECTION_THRESHOLD = CONST.RING_OPPOSITE_DIRECTION_THRESHOLD;

  // Find active rings and calculate their arrival times
  const activeRings = [];
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    // Null safety: ensure ring.mesh exists before accessing
    if (!ring || !ring.mesh) continue;
    if (!ring.passed && !ring.missed && ring.mesh.position.z < 0) {
      const distanceToArrival = Math.abs(ring.mesh.position.z);
      const arrivalTime = distanceToArrival / ring.speed;
      activeRings.push({ ring, arrivalTime });
    }
  }

  // Early exit if no active rings
  if (activeRings.length === 0) {
    return true; // Safe to spawn
  }

  // SAFEGUARD 2: Arrival Time Collision Check
  for (let i = 0; i < activeRings.length; i++) {
    const arrivalTimeDifference = Math.abs(thisRingArrivalTime - activeRings[i].arrivalTime);
    if (arrivalTimeDifference < MIN_ARRIVAL_TIME_SEPARATION) {
      return false; // CONFLICT: Rings would arrive too close together
    }
  }

  // SAFEGUARD 3: Momentum Conflict Check
  // Find the soonest arriving ring
  let nextRing = activeRings[0];
  for (let i = 1; i < activeRings.length; i++) {
    if (activeRings[i].arrivalTime < nextRing.arrivalTime) {
      nextRing = activeRings[i];
    }
  }

  // Only check momentum conflict if player is committed to next ring
  if (nextRing.arrivalTime < MOMENTUM_COMMITMENT_TIME) {
    // Null safety: ensure next ring mesh exists
    if (!nextRing.ring || !nextRing.ring.mesh) return true;
    const nextRingPos = nextRing.ring.mesh.position;

    // Calculate direction vectors
    const dx1 = nextRingPos.x - ringModePosition.x;
    const dy1 = nextRingPos.y - ringModePosition.y;
    const dx2 = spawnX - ringModePosition.x;
    const dy2 = spawnY - ringModePosition.y;

    const dist1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

    if (dist1 > 10 && dist2 > 10) {
      // Normalize and compute dot product
      const dotProduct = (dx1 / dist1) * (dx2 / dist2) + (dy1 / dist1) * (dy2 / dist2);

      // Check for opposite directions
      if (dotProduct < OPPOSITE_DIRECTION_THRESHOLD) {
        const arrivalGap = Math.abs(thisRingArrivalTime - nextRing.arrivalTime);
        if (arrivalGap < 2.5) {
          return false; // CONFLICT: Opposite direction with tight timing
        }
      }
    }
  }

  return true; // All safeguards passed
}

/**
 * Spawn a new ring
 *
 * CRITICAL SAFEGUARDS TO PROTECT PLAYER FROM UNFAIR SITUATIONS:
 *
 * 1. Z-Spacing Check: Prevents rings from spawning too close together in space
 * 2. Arrival Time Collision: Prevents multiple rings from arriving at nearly the same time
 * 3. Momentum/Directional Conflict: Prevents opposite-direction rings when player is committed
 *
 * Safeguard 2 (Arrival Time) protects against:
 * - Player waiting for a slow-moving far ring
 * - Fast-moving close ring spawning and arriving milliseconds later
 * - Impossible situation requiring player to be in two places at once
 *
 * Safeguard 3 (Momentum Conflict) protects against:
 * - Player rushing toward Ring A (building momentum)
 * - Ring B spawning in OPPOSITE direction
 * - Player must fight momentum for Ring A AND prepare for opposite Ring B
 * - Compound difficulty spike from directional reversal + tight timing
 *
 * By enforcing minimum arrival separation (1.5s) and momentum-aware directional checks,
 * we ensure fair, sequential challenges rather than simultaneous impossible scenarios.
 */
function spawnRing() {
  // SAFEGUARD 0: Check if there's an active far ring (bonus ring) that hasn't been resolved
  // Don't spawn next ring until player deals with the far ring to prevent unfair momentum scenarios
  const activeFarRing = rings.find(r => !r.passed && !r.missed && r.isBonusRing);
  if (activeFarRing) {
    return; // Wait for far ring to be resolved before spawning next ring
  }

  // SAFEGUARD 1: Z-Spacing Check
  if (checkZSpacingSafeguard()) {
    return; // Skip spawning, try again next interval
  }

  // Get spawn position from pattern
  const spawnPos = calculateRingSpawnPosition();
  const spawnX = spawnPos.x;
  const spawnY = spawnPos.y;
  const spawnZ = spawnPos.z;

  // Calculate ring size
  const ringSize = calculateRingSize(ringModeRingCount);

  // Calculate 2D distance to ring
  const distanceToRing = Math.sqrt(
    (spawnX - ringModePosition.x) ** 2 +
    (spawnY - ringModePosition.y) ** 2
  );
  const MAX_RING_DISTANCE = CONST.RING_GRID_BOUNDS;
  const distanceRatio = distanceToRing / MAX_RING_DISTANCE;

  // Check if this will be a bonus ring (very far away)
  const BONUS_RING_THRESHOLD = currentDifficulty === 'expert'
    ? CONST.RING_BONUS_THRESHOLD_EXPERT
    : CONST.RING_BONUS_THRESHOLD_NORMAL;
  const isBonusRing = distanceRatio >= BONUS_RING_THRESHOLD;

  // Find the previous ring (most recently spawned) to calculate timing from
  // This ensures each ring is timed from the previous ring's position, not player's current position
  let sourceX = ringModePosition.x;
  let sourceY = ringModePosition.y;
  
  if (rings.length > 0) {
    // Use the last ring in the array as the source position
    const lastRing = rings[rings.length - 1];
    if (lastRing && lastRing.mesh) {
      sourceX = lastRing.mesh.position.x;
      sourceY = lastRing.mesh.position.y;
    }
  }

  // Calculate ring speed based on time from previous ring (or player start if no previous ring)
  const ringSpeed = calculateRingSpeed(spawnX, spawnY, ringSize, distanceRatio, sourceX, sourceY);

  // SAFEGUARD 2 & 3: Check arrival time and momentum conflicts
  if (!checkSpawnSafeguards(spawnX, spawnY, spawnZ, ringSpeed)) {
    return; // Conflicts detected, skip spawn
  }

  // All safeguards passed - safe to create ring

  const ring = createRing(spawnX, spawnY, spawnZ, ringSize, ringSpeed, ringSpawnIndex++);

  // Mark rings spawned at far distances as bonus rings
  ring.isBonusRing = isBonusRing;

  // Determine if this bonus ring actually grants a life (chance-based by difficulty)
  // Easy: 100% chance (all bonus rings grant life)
  // Normal: 75% chance (3 in 4 bonus rings grant life)
  // Hard: 50% chance (1 in 2 bonus rings grant life)
  // Expert: 33% chance (1 in 3 bonus rings grant life)
  const bonusLifeChance = currentDifficulty === 'easy' ? 1.0 :
                          currentDifficulty === 'normal' ? 0.75 :
                          currentDifficulty === 'hard' ? 0.5 :
                          currentDifficulty === 'expert' ? 0.33 : 1.0;
  ring.grantsLife = isBonusRing && (Math.random() < bonusLifeChance);

  // Store initial 2D distance for distant ring indicator
  ring.initialDistance2D = distanceToRing;

  // Visual indicator: bonus rings glow brighter
  if (ring.isBonusRing && ring.mesh && ring.mesh.material) {
    ring.mesh.material.emissiveIntensity = 1.5; // Brighter glow
  }

  // Track section progress for hard mode
  if (currentDifficulty === 'hard') {
    sectionRingCount++;
  }

  rings.push(ring);
}

// ============================================================================
// BOOST FLAME EFFECTS
// ============================================================================

/**
 * Create boost flame effects
 */
function createBoostFlames() {
  if (!Car.car) return;

  // Create two flame cones for the tailpipes
  const flameGeometry = new THREE.ConeGeometry(16, 60, 8); // 2x bigger (radius: 8->16, height: 30->60)
  const flameMaterial = new THREE.MeshBasicMaterial({
    color: 0xff6600,
    transparent: true,
    opacity: 0.9
  });

  for (let i = 0; i < 2; i++) {
    const flame = new THREE.Mesh(flameGeometry, flameMaterial.clone());
    flame.visible = false;

    // Position in car's local space (at rear of car)
    const offset = (i === 0) ? -12 : 12; // Left and right offset
    flame.position.set(offset, 0, -100); // Local position: left/right, center height, rear

    // Rotate flame cone to point backward/downward (rear of car)
    // X rotation: tip points toward rear
    flame.rotation.set(Math.PI * 0.5, 0, 0); // 90° X rotation

    // Add point light for glow
    const light = new THREE.PointLight(0xff6600, 3, 80);
    flame.add(light);

    Car.car.add(flame); // Add as child of car so it moves with the car
    boostFlames.push(flame);
  }
}

/**
 * Update boost flame effects
 * @param {boolean} active - Whether boost is active
 */
function updateBoostFlames(active) {
  if (boostFlames.length === 0) {
    createBoostFlames();
  }

  if (!Car.car) return;

  boostFlames.forEach((flame) => {
    flame.visible = active;

    if (active) {
      // Flames are children of car, so they move automatically with it
      // Just animate the scale and opacity

      // Animate flame size
      const pulse = 0.7 + Math.random() * 0.6;
      flame.scale.set(pulse, pulse * 1.5, pulse);

      // Vary opacity
      flame.material.opacity = 0.7 + Math.random() * 0.3;
    }
  });
}

/**
 * Clear boost flames
 */
function clearBoostFlames() {
  boostFlames.forEach(flame => {
    if (flame.parent) flame.parent.remove(flame);
    flame.geometry.dispose();
    flame.material.dispose();
  });
  boostFlames = [];
}

// ============================================================================
// RING MODE PHYSICS UPDATE
// ============================================================================

/**
 * Update Ring Mode physics
 * Called from main integrate() function
 * @param {number} dt - Delta time
 * @param {Object} inputState - Input state { boostActive }
 * @param {THREE.Quaternion} carQuaternion - Car's quaternion for forward direction
 */
export function updateRingModePhysics(dt, inputState, carQuaternion) {
  try {
    // Allow rhythm mode to use ring mode physics
    const isRhythmMode = gameState && gameState.getRhythmModeActive();

    if (!isRhythmMode && (!ringModeActive || ringModePaused || ringModeLives <= 0)) {
      // Stop boost sound when game is over or paused
      Audio.stopBoostRumble();
      return;
    }

  // Get car's forward direction from quaternion
  const forward = new THREE.Vector3(0, 0, 1); // Car's local forward (flipped from -1 to 1)
  forward.applyQuaternion(carQuaternion);

  // Project onto XY plane for 2D movement
  const boostDirX = forward.x;
  const boostDirY = forward.y;

  // Check if boost was released (to re-enable boost after respawn)
  if (!inputState.boostActive && ignoreBoostUntilRelease) {
    ignoreBoostUntilRelease = false;
  }

  // Determine if boost is actually active (considering ignore flag)
  const effectiveBoostActive = inputState.boostActive && !ignoreBoostUntilRelease;

  // Track if game has started (first boost press)
  if (effectiveBoostActive && !ringModeStarted) {
    ringModeStarted = true;
  }

  // Boost rumble sound control
  if (effectiveBoostActive) {
    Audio.startBoostRumble();
  } else {
    Audio.stopBoostRumble();
  }

  // Apply forces
  let accelX = 0;
  // Easy difficulty: no vertical movement (no gravity)
  // Inverse gravity flips the gravity direction (positive becomes negative)
  const gravityDirection = inverseGravity ? -1 : 1;
  let accelY = (ringModeStarted && currentDifficulty !== 'easy') ? (CONST.RING_GRAVITY * gravityDirection) : 0;

  if (effectiveBoostActive) {
    // Boost in the direction car's nose is facing
    accelX += boostDirX * CONST.RING_BOOST_ACCEL;
    // Easy difficulty: no vertical boost component
    if (currentDifficulty !== 'easy') {
      accelY += boostDirY * CONST.RING_BOOST_ACCEL;
    }
  }

  // Update boost flame visibility
  updateBoostFlames(inputState.boostActive);

  // Integrate velocity
  ringModeVelocity.x += accelX * dt;
  ringModeVelocity.y += accelY * dt;

  // Easy difficulty: lock Y velocity to 0 (horizontal movement only)
  if (currentDifficulty === 'easy') {
    ringModeVelocity.y = 0;
  }

  // Clamp to max speed
  const speed = ringModeVelocity.length();
  if (speed > CONST.RING_MAX_SPEED) {
    ringModeVelocity.multiplyScalar(CONST.RING_MAX_SPEED / speed);
  }

  // Integrate position
  ringModePosition.x += ringModeVelocity.x * dt;
  ringModePosition.y += ringModeVelocity.y * dt;

  // Easy difficulty: lock Y position to 0 (horizontal movement only)
  if (currentDifficulty === 'easy') {
    ringModePosition.y = 0;
  }

  // Clamp to bounds
  ringModePosition.x = THREE.MathUtils.clamp(ringModePosition.x, -CONST.RING_GRID_BOUNDS, CONST.RING_GRID_BOUNDS);
  ringModePosition.y = THREE.MathUtils.clamp(ringModePosition.y, -CONST.RING_GRID_BOUNDS, CONST.RING_GRID_BOUNDS);

  // Check out of bounds (player went too far)
  if (Math.abs(ringModePosition.x) >= CONST.RING_GRID_BOUNDS ||
      Math.abs(ringModePosition.y) >= CONST.RING_GRID_BOUNDS) {
    // Out of bounds - respawn at next ring position
    ringModeVelocity.set(0, 0);

    // Find next unpassed ring to respawn at
    const nextRing = rings.find(r => !r.passed && !r.missed);
    if (nextRing) {
      // Respawn at the ring's X/Y position
      ringModePosition.set(nextRing.mesh.position.x, nextRing.mesh.position.y);
    } else {
      // No rings available, respawn at center
      ringModePosition.set(0, 0);
    }

    ringModeStarted = false; // Wait for boost before falling
    ignoreBoostUntilRelease = true; // Ignore boost until player releases it
    ringModeLives--; // Lose a life
  }
  // Coach hook (all overlays off by default): feed the coach this step's state
  if (getSetting('coachGhost') || getSetting('coachShadow') || getSetting('coachVelocity') || getSetting('coachStick')) {
    let stick = null;
    if (Input && Input.getJoyVec && Input.getJoyBaseR) {
      const jv = Input.getJoyVec(), br = Input.getJoyBaseR();
      if (br) stick = { x: jv.x / br, y: jv.y / br };
    }
    Coach.update(dt, {
      pos: { x: ringModePosition.x, y: ringModePosition.y },
      vel: { x: ringModeVelocity.x, y: ringModeVelocity.y },
      quat: carQuaternion,
      boostActive: effectiveBoostActive,
      target: getTargetRing(),
      easy: currentDifficulty === 'easy',
      gravity: CONST.RING_GRAVITY * gravityDirection,
      stick,
      shaping: {
        deadzone: Input && Input.getTouchDeadzone ? Input.getTouchDeadzone() : 0.09,
        curve: getSetting('inputPow') || 1,
        range: getSetting('stickRange') || 1
      }
    });
  }
  } catch (error) {
    console.error('[RingMode] Error in updateRingModePhysics:', error);
    // Stop boost sound on error to prevent stuck audio
    Audio.stopBoostRumble();
  }
}

// ============================================================================
// RING MODE RENDERING UPDATE
// ============================================================================

/**
 * Update Ring Mode rendering (camera, rings, collision detection)
 * Called from main integrate() function after physics
 * @param {number} dt - Delta time
 */
export function updateRingModeRendering(dt) {
  try {
    // Check if rhythm mode is active
    const isRhythmMode = gameState && gameState.getRhythmModeActive();

    if (!ringModeActive && !isRhythmMode) {
      // If we just exited ring mode, snap the car back to the grid center
      if (lastRingModeActive) {
        if (Car.car) {
          Car.car.quaternion.identity();
          const yRotation = inverseGravity ? Math.PI : 0;
          Car.car.rotation.set(Math.PI * 1.5, yRotation, Math.PI); // Match Ring Mode start orientation with gravity setting
          Car.car.position.set(0, 0, 0);
        }
        ringModePosition.set(0, 0);
        ringModeVelocity.set(0, 0);
        if (gameState) {
          gameState.resetAngularVelocity();
        }
      }

      lastRingModeActive = false;
      Arena.hide();
      return;
    }

    lastRingModeActive = ringModeActive;

  // Override car position to stay on grid
  if (Car.car) {
    // VALIDATION: Ensure car position values are finite before assignment
    if (!isFinite(ringModePosition.x) || !isFinite(ringModePosition.y)) {
      console.error('Invalid ringModePosition detected:', ringModePosition);
      // Reset to safe center position
      ringModePosition.x = 0;
      ringModePosition.y = 0;
    }

    Car.car.position.x = ringModePosition.x;
    Car.car.position.y = ringModePosition.y;

    // Both ring mode AND rhythm mode lock Z to 0 (2D plane)
    // Rings come toward the car, not the other way around
    Car.car.position.z = 0;
  }

  // Find the closest ring and the next ring ahead of the car (negative Z)
  // Prioritize by spawn order (oldest unpassed ring first), then by Z-distance
  let targetRing = null;

  // Filter to only active rings (behind camera, not passed/missed)
  const activeRings = rings.filter(r => r.mesh.position.z < 0 && !r.passed && !r.missed);

  if (activeRings.length > 0) {
    // Sort by spawn index (oldest first), then by Z-distance (closest first)
    activeRings.sort((a, b) => {
      // First priority: spawn order (lower index = spawned earlier)
      if (a.spawnIndex !== b.spawnIndex) {
        return a.spawnIndex - b.spawnIndex;
      }
      // Second priority: Z-distance (higher Z = closer to camera)
      return b.mesh.position.z - a.mesh.position.z;
    });

    // Safety check: ensure we have rings before accessing
    if (activeRings.length > 0) {
      // Oldest unpassed ring is the target
      targetRing = activeRings[0];
    }
  }

  // Check if car is inside the target ring
  let carInsideTargetRing = false;
  if (targetRing) {
    const dx = ringModePosition.x - targetRing.mesh.position.x;
    const dy = ringModePosition.y - targetRing.mesh.position.y;
    const distanceToRing = Math.sqrt(dx * dx + dy * dy);
    const ringOuterRadius = targetRing.size / 2 + CONST.RING_TUBE_RADIUS;
    carInsideTargetRing = distanceToRing < ringOuterRadius;
  }

  // Smooth camera path following system - interpolate between multiple rings
  let cameraOffsetX = 0;
  let cameraOffsetY = CONST.CAM_BASE.y;

  if (targetRing && !carInsideTargetRing) {
    // Car is outside target ring - focus camera on rings
    // Calculate weighted average position of next 2-3 upcoming rings
    // This creates a smooth curve through ring centers
    let weightedX = 0;
    let weightedY = 0;
    let totalWeight = 0;

    // Get up to 3 upcoming rings for smooth path
    const upcomingRings = activeRings.slice(0, Math.min(3, activeRings.length));

    for (let i = 0; i < upcomingRings.length; i++) {
      const ring = upcomingRings[i];
      // Null safety: skip if ring.mesh is missing
      if (!ring || !ring.mesh) continue;

      const ringDepth = Math.abs(ring.mesh.position.z);

      // Weight based on depth - closer rings have more influence
      // But far rings still contribute to keep them in frame
      let weight = 1.0;
      if (i === 0) {
        weight = 3.0; // Current target ring has strongest influence
      } else if (i === 1) {
        weight = 1.5; // Next ring has moderate influence
      } else {
        weight = 0.5; // Future rings have minimal influence
      }

      // Reduce weight for very far rings to prevent camera from overshooting
      const depthFactor = Math.min(ringDepth / 1000, 1.0);
      weight *= (1.0 - depthFactor * 0.5);

      weightedX += ring.mesh.position.x * weight;
      weightedY += ring.mesh.position.y * weight;
      totalWeight += weight;
    }

    // Calculate average target position (smooth path through rings)
    if (totalWeight > 0) {
      const pathTargetX = weightedX / totalWeight;
      const pathTargetY = weightedY / totalWeight;

      // Smoothly interpolate camera target toward path
      const smoothing = 0.05; // Very smooth interpolation
      cameraTargetX += (pathTargetX - cameraTargetX) * smoothing;
      cameraTargetY += (pathTargetY - cameraTargetY) * smoothing;

      // Calculate direction from car to smooth path target
      const deltaX = cameraTargetX - ringModePosition.x;
      const deltaY = cameraTargetY - ringModePosition.y;
      const distXY = Math.hypot(deltaX, deltaY);

      if (distXY > 0.1) {
        // Normalize direction
        const dirX = deltaX / distXY;
        const dirY = deltaY / distXY;

        // Minimal camera orbit - keep it simple and smooth
        const orbitRadius = 150; // Fixed moderate orbit

        // Camera aims to keep path visible
        cameraOffsetX = -dirX * orbitRadius;
        cameraOffsetY = CONST.CAM_BASE.y - dirY * 100;
      }
    }
  }

  // Smoothly move camera to target offset position
  const targetCamX = ringModePosition.x + cameraOffsetX;
  const targetCamY = ringModePosition.y + cameraOffsetY;
  const targetCamZ = CONST.CAM_BASE.z;

  // NaN safety check - if target position is NaN, reset to safe defaults
  if (!isFinite(targetCamX) || !isFinite(targetCamY) || !isFinite(targetCamZ)) {
    console.warn('Camera target position is NaN - resetting to origin');
    camera.position.set(0, CONST.CAM_BASE.y, CONST.CAM_BASE.z);
    ringModePosition.set(0, 0);
    ringModeVelocity.set(0, 0);
  } else {
    // Calculate new camera positions
    const newCamX = camera.position.x + (targetCamX - camera.position.x) * ringCameraSpeed;
    const newCamY = camera.position.y + (targetCamY - camera.position.y) * ringCameraSpeed;
    const newCamZ = targetCamZ;

    // Validate calculated positions BEFORE assignment
    if (isFinite(newCamX) && isFinite(newCamY) && isFinite(newCamZ)) {
      camera.position.x = newCamX;
      camera.position.y = newCamY;
      camera.position.z = newCamZ;
    } else {
      console.warn('Camera lerp produced NaN - resetting to safe position');
      camera.position.set(0, CONST.CAM_BASE.y, CONST.CAM_BASE.z);
      ringModePosition.set(0, 0);
      ringModeVelocity.set(0, 0);
    }
  }

  // Look at point between car and next ring to keep distant rings visible
  let lookAtX = ringModePosition.x;
  let lookAtY = ringModePosition.y;
  let lookAtZ = 0;

  if (carInsideTargetRing) {
    // Car is inside target ring - focus camera on car
    lookAtX = ringModePosition.x;
    lookAtY = ringModePosition.y;
    lookAtZ = 0;
  } else if (targetRing && targetRing.mesh) {
    // Car is outside target ring - blend between car and ring
    // Calculate full 3D distance from car to ring
    const dx = targetRing.mesh.position.x - ringModePosition.x;
    const dy = targetRing.mesh.position.y - ringModePosition.y;
    const dz = targetRing.mesh.position.z - 0; // Car is at Z=0
    const ringDistance3D = Math.sqrt(dx*dx + dy*dy + dz*dz);

    // Much gentler blend - max 20% toward ring to keep car on screen
    // Only blend if ring is very far (>2000 units)
    const blendFactor = ringDistance3D > 2000 ? Math.min((ringDistance3D - 2000) / 4000, 0.2) : 0;

    lookAtX = ringModePosition.x * (1 - blendFactor) + targetRing.mesh.position.x * blendFactor;
    lookAtY = ringModePosition.y * (1 - blendFactor) + targetRing.mesh.position.y * blendFactor;
    lookAtZ = 0 * (1 - blendFactor) + targetRing.mesh.position.z * blendFactor * 0.2; // Minimal Z shift
  }

  camera.lookAt(lookAtX, lookAtY, lookAtZ);

  // Subtle camera roll tilt toward lateral target offset to give directional feedback
  // Compute lateral offset between camera and player and apply a small smoothed roll
  const lateralOffset = camera.position.x - ringModePosition.x;
  const targetRoll = THREE.MathUtils.clamp(-lateralOffset / 600, -0.25, 0.25); // radians
  // Smoothly approach target roll
  camera.rotation.z += (targetRoll - (camera.rotation.z || 0)) * 0.08;

  // Move rings toward camera (only if not paused, game has started, and not game over)
  if (!ringModePaused && ringModeStarted && ringModeLives > 0) {
    for(let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i];
      // Null safety: skip if ring.mesh is missing (can happen during disposal)
      if (!ring || !ring.mesh) continue;

      const prevZ = ring.mesh.position.z;
      ring.mesh.position.z += ring.speed * dt; // Use individual ring speed for progression
      const newZ = ring.mesh.position.z;

      // Update visual effects based on distance for depth perception
      const distanceZ = Math.abs(ring.mesh.position.z);

      // Opacity fade: full opacity when close, fade out when far
      // Starts fading at 3000 units, fully visible at 1000 units
      const opacityFactor = THREE.MathUtils.clamp(1 - (distanceZ - 1000) / 2000, 0.3, 1);
      ring.mesh.material.opacity = opacityFactor;
      ring.mesh.material.transparent = true;

      // Emissive intensity: brighter when close, dimmer when far
      // This creates a fog-like effect
      const emissiveFactor = THREE.MathUtils.clamp(1 - distanceZ / 4000, 0.3, 0.8);
      ring.mesh.material.emissiveIntensity = emissiveFactor;

      // Point light intensity also fades with distance
      if (ring.mesh.children[0] && ring.mesh.children[0].isLight) {
        const lightIntensity = THREE.MathUtils.clamp(2 - distanceZ / 2000, 0.5, 2);
        ring.mesh.children[0].intensity = lightIntensity;
      }

      // Track when player reaches ring's XY position (before ring reaches z=0)
      // Only track ONCE per ring, and only if player enters the ring radius (not already inside)
      if (!ring.playerReachedTime && ring.mesh.position.z < 0) {
        const carX = ringModePosition.x;
        const carY = ringModePosition.y;
        const ringX = ring.mesh.position.x;
        const ringY = ring.mesh.position.y;
        const dx = carX - ringX;
        const dy = carY - ringY;
        const distanceToCenter = Math.sqrt(dx * dx + dy * dy);
        const ringOuterRadius = ring.size / 2 + CONST.RING_TUBE_RADIUS;
        
        // Only set if this is the CLOSEST upcoming ring to the player
        const upcomingRings = rings.filter(r => r.mesh && r.mesh.position && !r.passed && !r.missed && r.mesh.position.z < 0);
        if (upcomingRings.length > 0) {
          upcomingRings.sort((a, b) => Math.abs(a.mesh.position.z) - Math.abs(b.mesh.position.z));
          const nextRing = upcomingRings[0];
          
          if (ring === nextRing && distanceToCenter <= ringOuterRadius) {
            const currentTime = performance.now() / 1000;
            ring.playerReachedTime = currentTime;
          }
        }
      }

      // Check if car passed through the ring's plane (Z=0, where car is locked)
      if (prevZ < 0 && newZ >= 0 && !ring.passed && !ring.missed) {
        // Ring crossed the car's Z plane - check for collision
        const currentTime = performance.now() / 1000;
        ring.ringPassedTime = currentTime;
        
        const carX = ringModePosition.x;
        const carY = ringModePosition.y;
        const ringX = ring.mesh.position.x;
        const ringY = ring.mesh.position.y;

        // Distance from car center to ring center in XY plane
        const dx = carX - ringX;
        const dy = carY - ringY;
        const distanceToCenter = Math.sqrt(dx * dx + dy * dy);

        // Validate distance calculation - if NaN, treat as complete miss
        if (!isFinite(distanceToCenter)) {
          console.warn('Ring collision distance is NaN - treating as miss');
          ring.missed = true;
          ringModeLives--;
          Audio.playRingMissSound();
          continue; // Skip to next ring
        }

        // Ring outer and inner radii
        const ringOuterRadius = ring.size / 2 + CONST.RING_TUBE_RADIUS;
        const ringInnerRadius = ring.size / 2 - CONST.RING_TUBE_RADIUS;

        if (distanceToCenter <= ringInnerRadius) {
          // Clean pass - car went through the center
          ring.passed = true;
          ringModeScore++;
          ringModeRingCount++;

          // Bonus life for passing rings that grant lives
          if (ring.grantsLife) {
            ringModeLives++;
          }

          // Update high score (difficulty-specific)
          if (ringModeScore > ringModeHighScore) {
            ringModeHighScore = ringModeScore;
            saveHighScoreForDifficulty();
          }

          // Audio feedback - play success sound
          Audio.playRingPassSound();
        } else if (distanceToCenter < ringOuterRadius) {
          // Hit the edge of the ring
          ring.missed = true;
          // Audio feedback - play miss sound
          Audio.playRingMissSound();
          // TODO: Apply heart damage
        } else {
          // Completely missed the ring
          ring.missed = true;
          ringModeLives--;
          // Audio feedback - play miss sound
          Audio.playRingMissSound();
        }
      }

      // Remove rings immediately after they pass through grid (Z=0)
      // No need to keep them traveling behind the player
      if(ring.mesh.position.z > 50) { // Small buffer past Z=0
        // Check if we missed an unpassed ring
        if (!ring.passed && !ring.missed) {
          ringModeLives--;
          // Audio feedback - play miss sound
          Audio.playRingMissSound();
        }
        // Properly dispose ring resources (including lights)
        disposeRing(ring);
        rings.splice(i, 1);
      }
    }

    // Spawn new rings periodically (affected by difficulty and section)
    // BUT: Do NOT spawn rings if rhythm mode is active (it handles its own ring spawning)
    if (!isRhythmMode) {
      ringSpawnTimer += dt;

      // Calculate spawn interval with difficulty and section multipliers
      let spawnInterval = CONST.RING_BASE_SPAWN_INTERVAL * CONST.DIFFICULTY_SETTINGS[currentDifficulty].spawnIntervalMultiplier;

      // Apply section spawn interval multiplier for hard mode
      if (currentDifficulty === 'hard' && currentSection) {
        spawnInterval *= sectionSpawnInterval;
      }

      if(ringSpawnTimer >= spawnInterval) {
        spawnRing();
        ringSpawnTimer = 0;
      }
    }
  }

  // Update the 3D dashed circle landing indicator on the grid
  updateLandingIndicator();

  // 3D depth cues (corridor, ring shadows) - both off by default
  Arena.update(scene, {
    active: true,
    corridor: !!getSetting('arenaCorridor'),
    shadows: !!getSetting('arenaShadows'),
    rings,
    car: { x: ringModePosition.x, y: ringModePosition.y }
  });
  } catch (error) {
    console.error('[RingMode] Error in updateRingModeRendering:', error);
    // Reset to safe state on rendering error
    if (Car.car) {
      Car.car.position.set(0, 0, 0);
    }
  }
}

// ============================================================================
// CLEANUP AND MEMORY MANAGEMENT
// ============================================================================

/**
 * Cleanup Ring Mode resources
 * Call this when shutting down the application to prevent memory leaks
 */
export function cleanup() {
  // Stop all audio
  Audio.stopBoostRumble();
  Audio.stopBackgroundMusic();

  // Reset all ring mode state
  ringModeActive = false;
  ringModePaused = false;
  ringModeStarted = false;
  ringModeLives = 3;
  ringModeScore = 0;
  ringModeHighScore = 0;
  ringModeRingCount = 0;

  // Clear ring arrays and dispose resources
  for (let i = rings.length - 1; i >= 0; i--) {
    disposeRing(rings[i]);
  }
  rings = [];

  // Reset positions and velocities
  ringModePosition.set(0, 0);
  ringModeVelocity.set(0, 0);

  // Reset timers
  ringSpawnTimer = 0;

  // Reset game state reference
  gameState = null;

  // Clear landing indicator with proper disposal
  if (landingIndicator) {
    scene.remove(landingIndicator);
    
    // Dispose of geometry and material(s)
    if (landingIndicator.geometry) {
      // It's a Mesh (filled state)
      landingIndicator.geometry.dispose();
      if (landingIndicator.material) {
        landingIndicator.material.dispose();
      }
    } else if (landingIndicator.children) {
      // It's a Group (hollow state)
      landingIndicator.children.forEach(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
    }
    
    landingIndicator = null;
  }

  // Clear target point sphere with proper disposal
  if (targetPointSphere) {
    scene.remove(targetPointSphere);
    if (targetPointSphere.geometry) targetPointSphere.geometry.dispose();
    if (targetPointSphere.material) targetPointSphere.material.dispose();
    targetPointSphere = null;
  }
}
