/**
 * main.js
 * Main game initialization and loop for L4 DAR prototype
 * Version: 2025-11-29-v2 (localStorage persistence fix)
 */

import * as THREE from "three";

// Import modular components
import * as CONST from './modules/constants.js';
import * as Audio from './modules/audio.js';
import * as Settings from './modules/settings.js';
import * as Car from './modules/car.js';
import * as Rendering from './modules/rendering.js';
import * as Input from './modules/input.js';
import * as TouchInput from './modules/input/touchInput.js';
import * as RingMode from './modules/ringMode.js';
import * as RhythmMode from './modules/rhythmMode.js';
import * as RhythmModeUI from './modules/rhythmModeUI.js';
import * as Physics from './modules/physics.js';
import * as ControlsMenu from './modules/controlsMenu.js';
import { MenuSystem } from './modules/menuSystem.js';
import { GameState } from './modules/gameState.js';
import { SceneManager } from './modules/sceneManager.js';
import { ThemeManager } from './modules/themeManager.js';
import { UIManager } from './modules/uiManager.js';
import { CameraController } from './modules/cameraController.js';

// ============================================================================
// MANAGERS
// ============================================================================

let sceneManager;
let themeManager;
let uiManager;
let cameraController;
let isRunning = false;
let rafId = null;

// ============================================================================
// SETTINGS VARIABLES
// ============================================================================

// Menu open/close wrapper functions
function openMenu() {
  uiManager.openMenu(() => {
    Input.setChromeShown(true);
  });
}

function closeMenu() {
  uiManager.closeMenu(() => {
    Input.setChromeShown(false);
  });
}

// ============================================================================
// SETTINGS PROXY
// ============================================================================

// Flag to defer saves during initialization
let isInitializing = false;

// Create proxy that reads/writes from Settings module
// This eliminates duplicate state while maintaining backward compatibility
const settingsHandler = {
  get(target, prop) {
    return Settings.getSetting(prop);
  },
  set(target, prop, value) {
    // Update in Settings module
    const updates = { [prop]: value };
    // Only save if not initializing (to avoid 23 saves on startup)
    if (!isInitializing) {
      Settings.saveSettings(updates);
    } else {
      // During init, just update in memory without saving
      Settings.updateSettingsInMemory(updates);
    }
    return true;
  }
};

// Proxy object that delegates to Settings module
const settings = new Proxy({}, settingsHandler);

// Wrapper function to save settings to Settings module
function saveSettings() {
  // Collect additional settings that aren't in the main settings object
  const additionalSettings = {
    ringModeHighScore: RingMode.getRingModeHighScore(),
    ringDifficulty: RingMode.getCurrentDifficulty()
  };

  // Add optional settings if elements exist
  const gpPresetEl = document.getElementById('gpPreset');
  if (gpPresetEl) {
    additionalSettings.gpPreset = gpPresetEl.value;
  }

  const presetSelEl = document.getElementById('presetSel');
  if (presetSelEl) {
    additionalSettings.selectedCarBody = presetSelEl.value;
  }

  // Save additional settings (main settings are already saved via proxy)
  Settings.saveSettings(additionalSettings);
}

// Wrapper for syncTags that uses UIManager
function syncTags() {
  uiManager.syncTags(settings, {
    getJoyBaseR: () => Input.getJoyBaseR()
  });
}

// Wrapper for setupEditableTags that uses UIManager
function setupEditableTags() {
  uiManager.setupEditableTags(
    settings,
    () => cameraController.applyZoom(),
    (dark) => themeManager.applyTheme(dark),
    syncTags,
    saveSettings
  );
}

// Wrapper for initSettingsSliders that uses UIManager
function initSettingsSliders() {
  uiManager.initSettingsSliders(settings, {
    applyZoom: () => cameraController.setZoom(settings.zoom),
    applyTheme: (dark) => themeManager.applyTheme(dark),
    syncTags,
    saveSettings,
    buildCar: (name) => {
      console.log(`Building car: ${name}`, CONST.CAR_PRESETS[name]);
      Car.buildCar(CONST.CAR_PRESETS[name], name, sceneManager.getScene());
      Car.car.quaternion.identity();
      Car.car.rotation.set(Math.PI * 1.5, 0, Math.PI);
    },
    resetAngularVelocity: () => Physics.resetAngularVelocity(),
    setJoyBaseR: (v) => Input.setJoyBaseR(v),
    setJoyKnobR: (v) => Input.setJoyKnobR(v),
    getJoyBaseR: () => Input.getJoyBaseR(),
    clampJoyCenter: () => Input.clampJoyCenter(),
    positionHints: () => Input.positionHints(),
    getSetting: (key) => Settings.getSetting(key)
  });
}

// Wrapper for updateMenuButtonStyling that uses UIManager
function updateMenuButtonStyling() {
  // Show selected air roll direction in menu
  const selectedRoll = Input.getSelectedAirRoll();
  uiManager.updateMenuButtonStyling(selectedRoll);
}

// ============================================================================
// GAME LOOP FUNCTIONS
// ============================================================================

/**
 * Update tornado circle visualization in world space
 * Uses calibrated axis data to render a stable, non-wobbling circle
 */
function updateTornadoCircle() {
  // Yellow tornado circle rendering removed - will be reimplemented
}

function integrate(dt) {
  // Skip physics when menu is open OR when Ring Mode is paused
  if (uiManager.getChromeShown() || (RingMode.getRingModeActive() && RingMode.getRingModePaused())) {
    return;
  }

  // Call physics module
  Physics.updatePhysics(dt, {
    // Visualization
    showArrow: settings.showArrow,
    showCircle: settings.showCircle,
    arrowScale: settings.arrowScale,

    // Input shaping
    inputPow: settings.inputPow,
    stickRange: settings.stickRange,

    // Damping
    damp: settings.damp,
    dampDAR: settings.dampDAR,
    brakeOnRelease: settings.brakeOnRelease,

    // Accelerations (deg/s²)
    maxAccelPitch: settings.maxAccelPitch,
    maxAccelYaw: settings.maxAccelYaw,
    maxAccelRoll: settings.maxAccelRoll,

    // Velocity limits (rad/s)
    wMax: settings.wMax,
    wMaxPitch: settings.wMaxPitch,
    wMaxYaw: settings.wMaxYaw,
    wMaxRoll: settings.wMaxRoll
  }, uiManager.getChromeShown());
}

/* XYZ Gizmo */
const gizmoScene = new THREE.Scene();
const gizmoCam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
gizmoCam.position.set(0,0,6);
const gizmoAxes = new THREE.AxesHelper(3.2);
gizmoScene.add(gizmoAxes);
const gizmoTarget = new THREE.Object3D();
gizmoScene.add(gizmoTarget);
gizmoAxes.position.copy(gizmoTarget.position);

/* Render HUD & loop */
function renderHUD(){
  Rendering.renderHUD({
    // Joystick state
    JOY_CENTER: Input.getJoyCenter(),
    JOY_BASE_R: Input.getJoyBaseR(),
    JOY_KNOB_R: Input.getJoyKnobR(),
    joyVec: Input.getJoyVec(),
    COLS: uiManager.getCOLS(),
    // DAR button state
    DAR_CENTER: Input.getDarCenter(),
    DAR_R: Input.getDarR(),
    darOn: Input.getDarOn(),
    airRoll: Input.getAirRoll(),
    selectedAirRoll: Input.getSelectedAirRoll(),
    airRollIsToggle: Input.getAirRollIsToggle(),
    // Boost button state
    BOOST_CENTER: Input.getBoostCenter(),
    BOOST_R: Input.getBoostR(),
    ringModeBoostActive: Input.getRingModeBoostActive(),
    showBoostButton: Input.getShowBoostButton(),
    // Ring Mode state
    ringModeActive: RingMode.getRingModeActive(),
    ringModeStarted: RingMode.getRingModeStarted(),
    ringModePaused: RingMode.getRingModePaused(),
    ringModeLives: RingMode.getRingModeLives(),
    ringModeScore: RingMode.getRingModeScore(),
    ringModeHighScore: RingMode.getRingModeHighScore(),
    ringModeRingCount: RingMode.getRingModeRingCount(),
    ringModePosition: RingMode.getRingModePosition(),
    rings: RingMode.getRings(),
    isMobile: Input.getIsMobile(),
    currentDifficulty: RingMode.getCurrentDifficulty(),
    minimalUi: settings.minimalUi,
    // Coach stick panel replaces the compass while it is on
    inputAssist: settings.inputAssist && !settings.coachStick,
    coach: {
      ghost: !!settings.coachGhost,
      shadow: !!settings.coachShadow,
      velocity: !!settings.coachVelocity,
      stick: !!settings.coachStick
    },
    // Camera for 3D projection
    camera: sceneManager.getCamera()
  });
}

let lastT = performance.now()/1000;
function tick(){
  // Stop if application has been shut down
  if (!isRunning) {
    return;
  }

  const frameStart = performance.now();
  const t = frameStart / 1000;
  const dt = Math.min(0.033, Math.max(0.001, t - lastT));
  lastT = t;

  // Performance profiling
  let profileStart = performance.now();
  cameraController.update(dt);
  const cameraTime = performance.now() - profileStart;

  profileStart = performance.now();
  Input.updateInput(dt);
  const inputTime = performance.now() - profileStart;

  profileStart = performance.now();
  integrate(dt);
  const physicsTime = performance.now() - profileStart;

  profileStart = performance.now();
  RhythmMode.updateRhythmMode(dt);
  RhythmModeUI.updateRhythmModeUI();
  const rhythmTime = performance.now() - profileStart;

  profileStart = performance.now();
  updateTornadoCircle();
  const tornadoTime = performance.now() - profileStart;

  const renderer = sceneManager.getRenderer();
  const scene = sceneManager.getScene();
  const camera = sceneManager.getCamera();

  renderer.setScissorTest(false);
  renderer.setViewport(0,0,innerWidth,innerHeight);
  renderer.render(scene, camera);

  // Gizmo rendering (only if gizmoFrame element exists)
  const gizmoFrameElement = document.getElementById('gizmoFrame');
  if (gizmoFrameElement && Car.car) {
    gizmoTarget.quaternion.copy(Car.car.quaternion);
    gizmoAxes.quaternion.copy(gizmoTarget.quaternion);

    const gf = gizmoFrameElement.getBoundingClientRect();
    const sx = Math.floor(gf.left), sy = Math.floor(innerHeight - gf.bottom);
    const sw = Math.floor(gf.width), sh = Math.floor(gf.height);
    renderer.setScissorTest(true);
    renderer.setScissor(sx,sy,sw,sh);
    renderer.setViewport(sx,sy,sw,sh);
    renderer.render(gizmoScene, gizmoCam);
    renderer.setScissorTest(false);
  }

  renderHUD();

  // Performance monitoring disabled for normal builds (kept for manual perf profiling)
  // const frameTime = performance.now() - frameStart;
  // if (frameTime > 16.67) { // Slower than 60 FPS
  //   console.warn(`Slow frame: ${frameTime.toFixed(2)}ms`);
  //   console.warn(`Profile - Camera: ${cameraTime.toFixed(2)}ms, Input: ${inputTime.toFixed(2)}ms, Physics: ${physicsTime.toFixed(2)}ms, Rhythm: ${rhythmTime.toFixed(2)}ms, Tornado: ${tornadoTime.toFixed(2)}ms`);
  // }

  if (isRunning) {
    rafId = requestAnimationFrame(tick);
  }
}

function resize(){
  sceneManager.resize();

  // Update gizmo camera aspect ratio (only if gizmoFrame exists)
  const gizmoRectElement = document.getElementById('gizmoFrame');
  if (gizmoRectElement) {
    const gizmoRect = gizmoRectElement.getBoundingClientRect();
    gizmoCam.aspect = gizmoRect.width/gizmoRect.height;
    gizmoCam.updateProjectionMatrix();
  }

  Rendering.sizeHud();
  Input.handleResize();
  cameraController.applyZoom();
}

// ============================================================================
// INITIALIZATION
// ============================================================================

export function init() {

  // ============================================================================
  // INITIALIZE MANAGERS
  // ============================================================================

  sceneManager = new SceneManager();
  const hud = sceneManager.init();

  uiManager = new UIManager();
  themeManager = new ThemeManager(sceneManager);
  cameraController = new CameraController(sceneManager.getCamera(), Car);

  // Initialize HUD
  Rendering.initHUD(hud);

  // Load settings from Settings module
  const savedSettings = Settings.loadSettings();

  // Set initialization flag to defer saves
  isInitializing = true;

  // Restore settings into settings object
  settings.isDarkMode = savedSettings.isDarkMode ?? true;
  settings.brightnessDark = savedSettings.brightnessDark ?? 1.0;
  settings.brightnessLight = savedSettings.brightnessLight ?? 1.0;
  settings.maxAccelPitch = savedSettings.maxAccelPitch ?? 715;
  settings.maxAccelYaw = savedSettings.maxAccelYaw ?? 565;
  settings.maxAccelRoll = savedSettings.maxAccelRoll ?? 1030;
  settings.inputPow = savedSettings.inputPow ?? 1.5;
  settings.damp = savedSettings.damp ?? 2.96;
  settings.dampDAR = savedSettings.dampDAR ?? 4.35;
  settings.brakeOnRelease = savedSettings.brakeOnRelease ?? 0.0;
  settings.wMax = savedSettings.wMax ?? 6.0;
  settings.wMaxPitch = savedSettings.wMaxPitch ?? 8.5;
  settings.wMaxYaw = savedSettings.wMaxYaw ?? 9.0;
  settings.wMaxRoll = savedSettings.wMaxRoll ?? 6.0;
  settings.zoom = savedSettings.zoom ?? 1.0;
  settings.arrowScale = savedSettings.arrowScale ?? 4.0;
  settings.showArrow = savedSettings.showArrow ?? true;
  settings.showCircle = savedSettings.showCircle ?? true;
  settings.minimalUi = savedSettings.minimalUi ?? false;
  settings.stickSize = savedSettings.stickSize ?? 100;
  settings.gameSoundsEnabled = savedSettings.gameSoundsEnabled ?? true;
  settings.gameMusicEnabled = savedSettings.gameMusicEnabled ?? true;
  settings.gameMusicVolume = savedSettings.gameMusicVolume ?? 0.3;
  settings.gameSfxVolume = savedSettings.gameSfxVolume ?? 1.0;

  // Apply minimal UI class immediately on load
  document.body.classList.toggle('minimal-ui', settings.minimalUi);

  // Clear initialization flag and save once
  isInitializing = false;
  Settings.saveSettings();

  // Sync zoom with CameraController
  cameraController.setZoom(settings.zoom);

  // Sync audio settings with Audio module
  Audio.setGameSoundsEnabled(settings.gameSoundsEnabled);
  Audio.setGameMusicEnabled(settings.gameMusicEnabled);
  Audio.setGameMusicVolume(settings.gameMusicVolume);
  Audio.setGameSfxVolume(settings.gameSfxVolume);

  // ============================================================================
  // INITIALIZE GAME STATE (breaks circular dependencies)
  // ============================================================================

  const gameState = new GameState();

  // Initialize modules with game state (dependency injection)
  Physics.init(gameState, RingMode);
  RingMode.init(gameState, Input);
  RhythmMode.init(gameState);
  RhythmModeUI.initRhythmModeUI(sceneManager.getScene(), sceneManager.getCamera(), uiManager);

  // Expose core modules for interactive debugging in browser console
  // Usage example: window.__APP.Car.carCenterPoint.visible = true;
  window.__APP = {
    sceneManager,
    cameraController,
    Car,
    RingMode,
    Physics,
    Input,
    scene: sceneManager.getScene(),
    camera: sceneManager.getCamera()
  };

  // Apply loaded values to sliders
  const accelPitch = document.getElementById('accelPitch');
  const accelYaw = document.getElementById('accelYaw');
  const accelRoll = document.getElementById('accelRoll');
  const curveRange = document.getElementById('curveRange');
  const stickRangeSlider = document.getElementById('stickRangeSlider');
  const dampRange = document.getElementById('dampRange');
  const dampDARRange = document.getElementById('dampDARRange');
  const brakeRange = document.getElementById('brakeRange');
  const wmaxRange = document.getElementById('wmaxRange');
  const wmaxPitchRange = document.getElementById('wmaxPitch');
  const wmaxYawRange = document.getElementById('wmaxYaw');
  const wmaxRollRange = document.getElementById('wmaxRoll');
  const stickSizeSlider = document.getElementById('stickSizeSlider');
  const zoomSlider = document.getElementById('zoomSlider');
  const arrowSlider = document.getElementById('arrowSlider');

  accelPitch.value = settings.maxAccelPitch;
  accelYaw.value = settings.maxAccelYaw;
  accelRoll.value = settings.maxAccelRoll;
  curveRange.value = settings.inputPow;
  stickRangeSlider.value = settings.stickRange;
  dampRange.value = settings.damp;
  dampDARRange.value = settings.dampDAR;
  brakeRange.value = settings.brakeOnRelease;
  wmaxRange.value = settings.wMax;
  wmaxPitchRange.value = settings.wMaxPitch;
  wmaxYawRange.value = settings.wMaxYaw;
  wmaxRollRange.value = settings.wMaxRoll;
  if (stickSizeSlider) {
    stickSizeSlider.value = settings.stickSize;
  }
  zoomSlider.value = settings.zoom;
  arrowSlider.value = settings.arrowScale;

  // Sync gamepad stick deadzones and sensitivities
  const gpLeftStickDeadzone = document.getElementById('gpLeftStickDeadzone');
  const gpRightStickDeadzone = document.getElementById('gpRightStickDeadzone');
  const gpLeftStickSensitivity = document.getElementById('gpLeftStickSensitivity');
  const gpRightStickSensitivity = document.getElementById('gpRightStickSensitivity');
  
  if (gpLeftStickDeadzone) gpLeftStickDeadzone.value = savedSettings.gpLeftStickDeadzone ?? 0.15;
  if (gpRightStickDeadzone) gpRightStickDeadzone.value = savedSettings.gpRightStickDeadzone ?? 0.15;
  if (gpLeftStickSensitivity) gpLeftStickSensitivity.value = savedSettings.gpLeftStickSensitivity ?? 1.00;
  if (gpRightStickSensitivity) gpRightStickSensitivity.value = savedSettings.gpRightStickSensitivity ?? 1.00;

  // Initialize UI
  setupEditableTags();
  initSettingsSliders();
  syncTags();

  // Initialize menu buttons
  const menuBtn = document.getElementById('menuBtn');
  const menuOverlay = document.getElementById('menuOverlay');
  const menuCloseBtn = document.getElementById('menuCloseBtn');

  menuBtn.addEventListener('click',()=> Input.getChromeShown() ? closeMenu() : openMenu());
  menuCloseBtn.addEventListener('click', closeMenu);
  menuOverlay.addEventListener('click',(e)=>{ if(e.target===menuOverlay) closeMenu(); });

  // Menu button click handlers - delegate to Input module
  document.getElementById('rollL').addEventListener('click', () => {
    Input.selectAirRoll(-1);
    updateMenuButtonStyling();
  });
  document.getElementById('rollR').addEventListener('click', () => {
    Input.selectAirRoll(1);
    updateMenuButtonStyling();
  });
  document.getElementById('rollFree').addEventListener('click', () => {
    Input.selectAirRoll(2);
    updateMenuButtonStyling();
  });

  // Reset Physics to Defaults button
  document.getElementById('resetPhysicsDefaults').addEventListener('click', () => {
    Settings.clearAllSettings();
    location.reload();
  });

  // Toggle/Hold mode button
  document.getElementById('toggleMode').addEventListener('click', () => {
    const newMode = !Input.getAirRollIsToggle();
    Input.setAirRollIsToggle(newMode);
    const btn = document.getElementById('toggleMode');
    btn.classList.toggle('active', newMode);
    btn.textContent = newMode ? 'Toggle' : 'Hold';
  });

  // Lock Pitch button
  document.getElementById('lockPitch').addEventListener('click', () => {
    const locked = Physics.togglePitchLock();
    const btn = document.getElementById('lockPitch');
    btn.classList.toggle('active', locked);
  });

  // Lock Yaw button
  document.getElementById('lockYaw').addEventListener('click', () => {
    const locked = Physics.toggleYawLock();
    const btn = document.getElementById('lockYaw');
    btn.classList.toggle('active', locked);
  });

  // Lock Roll button
  document.getElementById('lockRoll').addEventListener('click', () => {
    const locked = Physics.toggleRollLock();
    const btn = document.getElementById('lockRoll');
    btn.classList.toggle('active', locked);
  });

  // Ring Mode button removed from main menu - now only in Ring Mode menu panel

  // Ring Mode camera speed slider (Menu version is now primary)
  const ringCameraSpeedSlider = document.getElementById('ringCameraSpeedMenu');
  const ringCameraSpeedVal = document.getElementById('ringCameraSpeedMenuVal');
  ringCameraSpeedSlider.addEventListener('input', () => {
    const speed = parseFloat(ringCameraSpeedSlider.value);
    RingMode.setRingCameraSpeed(speed);
    ringCameraSpeedVal.textContent = speed.toFixed(2);
  });

  // Game speed slider
  const gameSpeedSlider = document.getElementById('gameSpeedMenu');
  const gameSpeedVal = document.getElementById('gameSpeedMenuVal');
  
  if (gameSpeedSlider && gameSpeedVal) {
    // Initialize slider from saved value
    const savedGameSpeed = Settings.getSetting('gameSpeed') || 1.0;
    gameSpeedSlider.value = savedGameSpeed;
    gameSpeedVal.textContent = Math.round(savedGameSpeed * 100) + '%';
    
    gameSpeedSlider.addEventListener('input', () => {
      const speed = parseFloat(gameSpeedSlider.value);
      Settings.updateSetting('gameSpeed', speed);
      gameSpeedVal.textContent = Math.round(speed * 100) + '%';
    });
  }

  // Ring Mode difficulty selector (Menu version is now primary)
  const ringDifficultySelector = document.getElementById('ringDifficultyMenu');
  ringDifficultySelector.addEventListener('change', () => {
    const difficulty = ringDifficultySelector.value;
    RingMode.setCurrentDifficulty(difficulty);
    saveSettings();

    // If Ring Mode is active, restart it with new difficulty
    if (RingMode.getRingModeActive()) {
      RingMode.resetRingMode();
    }
  });

  // Audio toggles (Menu versions are now primary)
  const toggleSoundsBtn = document.getElementById('toggleSoundsMenu');
  const soundsStatusTag = document.getElementById('soundsStatusMenu');
  const toggleMusicBtn = document.getElementById('toggleMusicMenu');
  const musicStatusTag = document.getElementById('musicStatusMenu');
  const musicVolumeSlider = document.getElementById('musicVolumeMenu');
  const musicVolumeVal = document.getElementById('musicVolumeMenuVal');
  const sfxVolumeSlider = document.getElementById('sfxVolumeMenu');
  const sfxVolumeVal = document.getElementById('sfxVolumeMenuVal');

  if (toggleSoundsBtn && soundsStatusTag && toggleMusicBtn && musicStatusTag) {
    // Set initial button states
    toggleSoundsBtn.classList.toggle('active', settings.gameSoundsEnabled);
    soundsStatusTag.textContent = settings.gameSoundsEnabled ? 'Enabled' : 'Disabled';
    toggleMusicBtn.classList.toggle('active', settings.gameMusicEnabled);
    musicStatusTag.textContent = settings.gameMusicEnabled ? 'Enabled' : 'Disabled';

    toggleSoundsBtn.addEventListener('click', () => {
      settings.gameSoundsEnabled = !settings.gameSoundsEnabled;
      toggleSoundsBtn.classList.toggle('active', settings.gameSoundsEnabled);
      soundsStatusTag.textContent = settings.gameSoundsEnabled ? 'Enabled' : 'Disabled';

      // Update Audio module settings
      Audio.setGameSoundsEnabled(settings.gameSoundsEnabled);

      saveSettings();
    });

    toggleMusicBtn.addEventListener('click', () => {
      settings.gameMusicEnabled = !settings.gameMusicEnabled;
      toggleMusicBtn.classList.toggle('active', settings.gameMusicEnabled);
      musicStatusTag.textContent = settings.gameMusicEnabled ? 'Enabled' : 'Disabled';

      // Update Audio module settings
      Audio.setGameMusicEnabled(settings.gameMusicEnabled);

      // Start music if enabled and Ring Mode is active
      if (settings.gameMusicEnabled && RingMode.getRingModeActive()) {
        // Start immediately when enabling during an active Ring Mode session
        Audio.forceStartBackgroundMusic();
      }

      saveSettings();
    });
  }

  if (musicVolumeSlider && musicVolumeVal) {
    musicVolumeSlider.value = settings.gameMusicVolume ?? 0.3;
    musicVolumeVal.textContent = Math.round((settings.gameMusicVolume ?? 0.3) * 100) + '%';
    musicVolumeSlider.addEventListener('input', () => {
      const volume = parseFloat(musicVolumeSlider.value);
      settings.gameMusicVolume = volume;
      musicVolumeVal.textContent = Math.round(volume * 100) + '%';
      Audio.setGameMusicVolume(volume);
      saveSettings();
    });
  }

  if (sfxVolumeSlider && sfxVolumeVal) {
    sfxVolumeSlider.value = settings.gameSfxVolume ?? 1.0;
    sfxVolumeVal.textContent = Math.round((settings.gameSfxVolume ?? 1.0) * 100) + '%';
    sfxVolumeSlider.addEventListener('input', () => {
      const volume = parseFloat(sfxVolumeSlider.value);
      settings.gameSfxVolume = volume;
      sfxVolumeVal.textContent = Math.round(volume * 100) + '%';
      Audio.setGameSfxVolume(volume);
      saveSettings();
    });
  }

  // Inverse Gravity toggle
  const inverseGravityBtn = document.getElementById('inverseGravityMenu');
  const inverseGravityStatusTag = document.getElementById('inverseGravityStatusMenu');
  
  if (inverseGravityBtn && inverseGravityStatusTag) {
    // Set initial state
    inverseGravityBtn.classList.toggle('active', settings.inverseGravity || false);
    inverseGravityStatusTag.textContent = settings.inverseGravity ? 'On' : 'Off';
    
    // Sync saved setting to Ring Mode module
    RingMode.setInverseGravity(settings.inverseGravity || false);

    inverseGravityBtn.addEventListener('click', () => {
      settings.inverseGravity = !settings.inverseGravity;
      inverseGravityBtn.classList.toggle('active', settings.inverseGravity);
      inverseGravityStatusTag.textContent = settings.inverseGravity ? 'On' : 'Off';
      
      // Update Ring Mode with new setting
      RingMode.setInverseGravity(settings.inverseGravity);
      
      // Immediately update car orientation
      if (Car.car) {
        const yRotation = settings.inverseGravity ? Math.PI : 0;
        Car.car.rotation.set(Math.PI * 1.5, yRotation, Math.PI);
      }
      
      saveSettings();
    });
  }

  // Input Assist toggle
  const inputAssistBtn = document.getElementById('inputAssistToggle');
  const inputAssistStatusTag = document.getElementById('inputAssistStatus');
  
  if (inputAssistBtn && inputAssistStatusTag) {
    // Set initial state
    inputAssistBtn.classList.toggle('active', settings.inputAssist || false);
    inputAssistStatusTag.textContent = settings.inputAssist ? 'On' : 'Off';

    inputAssistBtn.addEventListener('click', () => {
      settings.inputAssist = !settings.inputAssist;
      inputAssistBtn.classList.toggle('active', settings.inputAssist);
      inputAssistStatusTag.textContent = settings.inputAssist ? 'On' : 'Off';
      saveSettings();
    });
  }

  // Coach overlay + 3D depth cue toggles (all off by default)
  [['coachGhost', 'coachGhostToggle', 'coachGhostStatus'],
   ['coachShadow', 'coachShadowToggle', 'coachShadowStatus'],
   ['coachVelocity', 'coachVelocityToggle', 'coachVelocityStatus'],
   ['coachStick', 'coachStickToggle', 'coachStickStatus'],
   ['arenaCorridor', 'arenaCorridorToggle', 'arenaCorridorStatus'],
   ['arenaShadows', 'arenaShadowsToggle', 'arenaShadowsStatus']].forEach(([key, btnId, tagId]) => {
    const btn = document.getElementById(btnId);
    const tag = document.getElementById(tagId);
    if (!btn || !tag) return;
    btn.classList.toggle('active', !!settings[key]);
    tag.textContent = settings[key] ? 'On' : 'Off';
    btn.addEventListener('click', () => {
      settings[key] = !settings[key];
      btn.classList.toggle('active', settings[key]);
      tag.textContent = settings[key] ? 'On' : 'Off';
      saveSettings();
    });
  });

  // NOTE: Ring Mode settings consolidated into Ring Mode menu only
  // Main menu Ring Mode card has been removed - all settings now in ringModePanel

  // Centralized reset used by both restart button and end-game flow
  const resetToDefaultState = () => {
    if (Car.car) {
      Car.car.quaternion.identity();
      Car.car.rotation.set(Math.PI * 1.5, 0, Math.PI); // X: +270°, Y: 0°, Z: +180°
      Car.car.position.set(0, 0, 0);
    }
    Physics.resetAngularVelocity();
    cameraController.resetCamera();
    document.getElementById('orbitCW').classList.remove('active');
    document.getElementById('orbitCCW').classList.remove('active');
    if (Car.faceArrow) Car.faceArrow.visible = false;
    if (Car.faceTip)   Car.faceTip.visible   = false;
  };

  // Restart button
  document.getElementById('restart').addEventListener('click',()=>{
    resetToDefaultState();

    // Reset Ring Mode if active
    if(RingMode.getRingModeActive()){
      RingMode.resetRingMode();
    }
  });

  // Orbit buttons
  document.getElementById('orbitCW').addEventListener('click',()=>{
    const btn = document.getElementById('orbitCW');
    const active = cameraController.toggleOrbitCW();
    btn.classList.toggle('active', active);
    if (active) {
      document.getElementById('orbitCCW').classList.remove('active');
    }
  });
  document.getElementById('orbitCCW').addEventListener('click',()=>{
    const btn = document.getElementById('orbitCCW');
    const active = cameraController.toggleOrbitCCW();
    btn.classList.toggle('active', active);
    if (active) {
      document.getElementById('orbitCW').classList.remove('active');
    }
  });

  // Theme toggle (main screen button)
  document.getElementById('themeBtn').addEventListener('click',()=>{
    settings.isDarkMode = !settings.isDarkMode;
    themeManager.applyTheme(settings.isDarkMode);
    const btn = document.getElementById('themeBtn');
    btn.textContent = settings.isDarkMode ? '🌙' : '☀️';
    syncTags(); // Update brightness slider to show correct value for new theme
    saveSettings();
  });

  // Fullscreen toggle
  document.getElementById('fullscreenBtn').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      // Enter fullscreen
      document.documentElement.requestFullscreen().catch(err => {
      });
    } else {
      // Exit fullscreen
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  });

  // Update fullscreen button icon when fullscreen state changes
  document.addEventListener('fullscreenchange', () => {
    const btn = document.getElementById('fullscreenBtn');
    const isMobile = Input.getIsMobile();
    if (document.fullscreenElement) {
      btn.textContent = '⛶'; // Fullscreen exit icon
      btn.title = isMobile ? 'Exit Fullscreen' : 'Exit Fullscreen (Esc)';
    } else {
      btn.textContent = '⛶'; // Fullscreen enter icon
      btn.title = 'Enter Fullscreen';
    }
  });

  // Hard-coded ESC to exit fullscreen
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.fullscreenElement) {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  });

  // Ring Mode button - opens menu instead of directly toggling
  const ringModeBtn = document.getElementById('ringModeBtn');
  const updateRingModeButtonDim = () => {
    if (ringModeBtn) {
      ringModeBtn.classList.toggle('dimmed', RingMode.getRingModeActive());
    }
  };

  if (ringModeBtn) {
    updateRingModeButtonDim();

    ringModeBtn.addEventListener('click', () => {
      const overlay = document.getElementById('ringModeOverlay');
      overlay.style.display = 'block';

      // Update START/END GAME button text based on current state
      const startBtn = document.getElementById('startRingModeBtn');
      const isActive = RingMode.getRingModeActive();
      startBtn.textContent = isActive ? 'END GAME' : 'START GAME';
    });
  }

  // Ring Mode menu close button
  document.getElementById('ringModeCloseBtn').addEventListener('click', () => {
    document.getElementById('ringModeOverlay').style.display = 'none';
  });

  // Ring Mode overlay click (close when clicking outside panel)
  document.getElementById('ringModeOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'ringModeOverlay') {
      document.getElementById('ringModeOverlay').style.display = 'none';
    }
  });

  // Start/End Ring Mode button
  document.getElementById('startRingModeBtn').addEventListener('click', () => {
    const startBtn = document.getElementById('startRingModeBtn');
    const isActive = RingMode.getRingModeActive();

    if (isActive) {
      // End Ring Mode
      RingMode.toggleRingMode();
      startBtn.textContent = 'START GAME';
      if (ringModeBtn) {
        ringModeBtn.classList.remove('active');
        updateRingModeButtonDim();
      }

      // Snap back to default camera/car state (same as restart)
      resetToDefaultState();
    } else {
      // Start Ring Mode
      RingMode.toggleRingMode();
      startBtn.textContent = 'END GAME';
      if (ringModeBtn) {
        ringModeBtn.classList.add('active');
        updateRingModeButtonDim();
      }
    }

    // Close the menu
    document.getElementById('ringModeOverlay').style.display = 'none';
  });

  // Ring Mode menu controls are now primary - no sync needed

  // Button repositioning on window resize
  // Ensures buttons stay in correct positions when screen is resized
  // Fixes issue where buttons get stuck after DevTools open/close
  function repositionButtons() {
    // Get all fixed-position buttons
    const buttons = [
      document.getElementById('fullscreenBtn'),
      document.getElementById('themeBtn'),
      document.getElementById('menuBtn'),
      document.getElementById('ringModeBtn')
    ].filter(Boolean); // Remove null entries

    // Force browser to recalculate layout by toggling a layout-affecting property
    // This fixes the DevTools resize bug where buttons get stuck
    buttons.forEach(btn => {
      // Reading offsetHeight forces layout recalculation
      const _ = btn.offsetHeight;

      // Alternative: temporarily toggle display to force reflow
      const display = btn.style.display;
      btn.style.display = 'none';
      btn.offsetHeight; // Force reflow
      btn.style.display = display || '';
    });
  }

  // Reposition on window resize with debouncing
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(repositionButtons, 100);
  });

  // Initial positioning
  repositionButtons();

  // Stop music when page loses focus (tab switching, app backgrounding)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Page is hidden - pause audio (keep state so it can resume)
      Audio.pauseBackgroundMusic();
      Audio.stopBoostRumble();
    } else {
      // Resume music if enabled; will fallback to gesture if autoplay is blocked
      if (settings.gameMusicEnabled) {
        Audio.resumeBackgroundMusic();
      }
    }
  });

  // Extra lifecycle hooks for tab switches / screen off-on
  window.addEventListener('pagehide', () => {
    Audio.pauseBackgroundMusic();
    Audio.stopBoostRumble();
  });

  window.addEventListener('pageshow', () => {
    if (settings.gameMusicEnabled) {
      Audio.resumeBackgroundMusic();
    }
  });

  window.addEventListener('blur', () => {
    Audio.pauseBackgroundMusic();
    Audio.stopBoostRumble();
  });

  window.addEventListener('focus', () => {
    if (settings.gameMusicEnabled) {
      Audio.resumeBackgroundMusic();
    }
  });

  // Arrow and Circle toggles
  document.getElementById('arrowToggle').addEventListener('click',()=>{
    settings.showArrow = !settings.showArrow;
    const btn = document.getElementById('arrowToggle');
    btn.classList.toggle('active', settings.showArrow);
    btn.textContent = settings.showArrow ? 'Show Arrow' : 'Hide Arrow';
    saveSettings();
  });

  document.getElementById('circleToggle').addEventListener('click',()=>{
    settings.showCircle = !settings.showCircle;
    const btn = document.getElementById('circleToggle');
    btn.classList.toggle('active', settings.showCircle);
    btn.textContent = settings.showCircle ? 'Show Circle' : 'Hide Circle';
    saveSettings();
  });

  // Add Controls button listener
  const controlsBtn = document.getElementById('controlsBtn');
  if (controlsBtn) {
    controlsBtn.addEventListener('click', () => {
      ControlsMenu.openControlsMenu();
    });
  }

  // Initialize Input module with callbacks
  Input.initInput(hud, {
    savedKbBindings: savedSettings.kbBindings,
    savedGpBindings: savedSettings.gpBindings,
    savedGpEnabled: savedSettings.gpEnabled,
    savedGpPreset: savedSettings.gpPreset,
    savedAirRollState: {
      airRoll: savedSettings.airRoll,
      lastActiveAirRoll: savedSettings.lastActiveAirRoll,
      airRollIsToggle: savedSettings.airRollIsToggle
    },
    execBinding: (action) => {
      // Handle gamepad button actions
      switch(action) {
        case 'toggleDAR': {
          // Toggle DAR with last active air roll
          const currentAirRoll = Input.getAirRoll();
          const lastActive = Input.getLastActiveAirRoll();
          if (currentAirRoll === 0) {
            // Turn on DAR with last active direction
            Input.selectAirRoll(lastActive);
          } else {
            // Turn off DAR
            Input.selectAirRoll(0);
          }
          break;
        }
        case 'rollLeft':
        case 'rollRight':
        case 'rollFree':
          // These are handled internally by Input module
          break;
        case 'boost':
          // Boost handled internally by Input module
          break;
        case 'pause': {
          if (RingMode.getRingModeActive()) {
            const paused = RingMode.toggleRingModePaused();
            Input.setRingModePaused(paused);
            // Stop boost sound when pausing
            if (paused) {
              Audio.stopBoostRumble();
            }
          } else if (RhythmMode.getRhythmModeActive()) {
            // Pause/unpause rhythm mode (pause audio and stop spawning)
            if (RhythmMode.getIsAudioPlaying()) {
              RhythmMode.pauseAudio();
              Audio.stopBoostRumble();
            } else {
              RhythmMode.playAudio();
            }
          }
          break;
        }
        case 'restart': {
          if (RingMode.getRingModeActive()) {
            // In Ring Mode: Quick respawn (costs a life, respawns at next ring)
            const lives = RingMode.getRingModeLives();
            if (lives > 0) {
              // Lose a life
              RingMode.setRingModeLives(lives - 1);

              // Reset velocity and position to next ring
              const rings = RingMode.getRings();
              const nextRing = rings.find(r => !r.passed && !r.missed);
              if (nextRing) {
                RingMode.setRingModePosition(nextRing.mesh.position.x, nextRing.mesh.position.y);
              } else {
                RingMode.setRingModePosition(0, 0);
              }
              RingMode.setRingModeVelocity(0, 0);

              // Reset car rotation (respect gravity setting)
              if (Car.car) {
                Car.car.quaternion.identity();
                const yRotation = settings.inverseGravity ? Math.PI : 0;
                Car.car.rotation.set(Math.PI * 1.5, yRotation, Math.PI);
              }
              Physics.resetAngularVelocity();

            }
          } else if (RhythmMode.getRhythmModeActive()) {
            // In Rhythm Mode: Stop and return to menu
            RhythmMode.stopRhythmMode();
            document.getElementById('rhythmStats').style.display = 'none';
            document.getElementById('rhythmBoostToStart').style.display = 'none';
            document.getElementById('rhythmStart').disabled = false;
            document.getElementById('rhythmStop').disabled = true;
          } else {
            // Normal mode: Full restart (reset car orientation, camera, orbit)
            if (Car.car) {
              Car.car.quaternion.identity();
              const yRotation = settings.inverseGravity ? Math.PI : 0;
              Car.car.rotation.set(Math.PI * 1.5, yRotation, Math.PI);
            }
            Physics.resetAngularVelocity();
            cameraController.resetCamera();
            document.getElementById('orbitCW').classList.remove('active');
            document.getElementById('orbitCCW').classList.remove('active');
            if (Car.faceArrow) Car.faceArrow.visible = false;
            if (Car.faceTip) Car.faceTip.visible = false;
          }
          break;
        }
        case 'retry':
          // Retry - only works when Ring Mode is active and game is over
          if (RingMode.getRingModeActive()) {
            const lives = RingMode.getRingModeLives();
            if (lives <= 0) {
              // Game over - reset Ring Mode
              RingMode.resetRingMode();
            }
          }
          break;
        case 'orbitCW':
          cameraController.toggleOrbitCW();
          break;
        case 'orbitCCW':
          cameraController.toggleOrbitCCW();
          break;
        case 'toggleTheme': {
          settings.isDarkMode = !settings.isDarkMode;
          themeManager.applyTheme(settings.isDarkMode);
          // Update theme button icon
          const themeBtn = document.getElementById('themeBtn');
          themeBtn.textContent = settings.isDarkMode ? '🌙' : '☀️';
          saveSettings();
          break;
        }
        case 'openMenu':
          if (!uiManager.getChromeShown()) {
            openMenu();
          } else {
            closeMenu();
          }
          break;
      }
    },
    openMenu: openMenu,
    closeMenu: closeMenu,
    retry: () => RingMode.resetRingMode(),
    getRingModeLives: () => RingMode.getRingModeLives()
  });

  // Apply saved stick size after touch input is initialized
  if (settings.stickSize) {
    Input.setJoyBaseR(settings.stickSize);
  }

  // Sync tags again after Input is initialized and stick size is applied
  syncTags();

  // Apply minimal UI state after Input module is initialized
  Input.setMinimalUiEnabled(settings.minimalUi);

  // Initialize MenuSystem for navigation
  const menuSystem = new MenuSystem('#menuPanel');
  menuSystem.init();
  Input.setMenuSystem(menuSystem);
  window.menuSystem = menuSystem; // expose for debugging

  // Restore saved car body or default to octane
  const presetSel = document.getElementById('presetSel');
  const savedCarBody = savedSettings.selectedCarBody || 'octane';
  if (CONST.CAR_PRESETS[savedCarBody]) {
    Car.buildCar(CONST.CAR_PRESETS[savedCarBody], savedCarBody, sceneManager.getScene());
    presetSel.value = savedCarBody;
  } else {
    Car.buildCar(CONST.CAR_PRESETS.octane, "octane", sceneManager.getScene());
  }

  // Set initial menu button styling based on saved selection
  updateMenuButtonStyling();

  // Set initial rotation: roof facing camera, nose pointing up (or down if inverse gravity)
  // X: +270°, Y: 0° or 180° (based on gravity), Z: +180°
  if (Car.car) {
    const yRotation = savedSettings.inverseGravity ? Math.PI : 0;
    Car.car.rotation.set(Math.PI * 1.5, yRotation, Math.PI);
  }

  // Initialize Ring Mode module with scene references
  const orbitOnRef = {
    get value() { return cameraController.getOrbitOn(); },
    set value(v) {
      // Ring Mode might need to disable orbit - not fully implemented yet
    }
  };
  RingMode.initRingMode(sceneManager.getScene(), sceneManager.getCamera(), sceneManager.getRenderer(), orbitOnRef);

  // Apply zoom and theme
  cameraController.applyZoom();
  themeManager.applyTheme(settings.isDarkMode); // Initialize theme

  // Restore theme button state (main screen)
  const themeBtn = document.getElementById('themeBtn');
  themeBtn.textContent = settings.isDarkMode ? '🌙' : '☀️';

  // Restore arrow and circle toggle button states
  const arrowToggleBtn = document.getElementById('arrowToggle');
  arrowToggleBtn.classList.toggle('active', settings.showArrow);
  arrowToggleBtn.textContent = settings.showArrow ? 'Show Arrow' : 'Hide Arrow';

  const circleToggleBtn = document.getElementById('circleToggle');
  circleToggleBtn.classList.toggle('active', settings.showCircle);
  circleToggleBtn.textContent = settings.showCircle ? 'Show Circle' : 'Hide Circle';

  // Restore toggle/hold mode button state
  const toggleModeBtn = document.getElementById('toggleMode');
  toggleModeBtn.classList.toggle('active', Input.getAirRollIsToggle());
  toggleModeBtn.textContent = Input.getAirRollIsToggle() ? 'Toggle' : 'Hold';

  // Restore Ring Mode difficulty selector
  if (ringDifficultySelector) {
    ringDifficultySelector.value = RingMode.getCurrentDifficulty();
  }

  // Initialize Controls Menu
  ControlsMenu.initControlsMenu();

  // Setup Dual Stick Mode toggle
  const dualStickToggle = document.getElementById('dualStickToggle');
  if (dualStickToggle) {
    dualStickToggle.classList.toggle('active', savedSettings.dualStickMode);
    dualStickToggle.addEventListener('click', () => {
      settings.dualStickMode = !settings.dualStickMode;
      dualStickToggle.classList.toggle('active', settings.dualStickMode);
      saveSettings();
      // Refresh controls menu to show/hide right stick assignment
      ControlsMenu.initControlsMenu();
    });
  }

  // Setup Minimal UI toggle
  const minimalUiToggle = document.getElementById('minimalUiToggle');
  const minimalUiStatus = document.getElementById('minimalUiStatus');
  if (minimalUiToggle && minimalUiStatus) {
    minimalUiToggle.classList.toggle('active', settings.minimalUi);
    minimalUiStatus.textContent = settings.minimalUi ? 'On' : 'Off';

    minimalUiToggle.addEventListener('click', () => {
      settings.minimalUi = !settings.minimalUi;
      document.body.classList.toggle('minimal-ui', settings.minimalUi);
      minimalUiToggle.classList.toggle('active', settings.minimalUi);
      minimalUiStatus.textContent = settings.minimalUi ? 'On' : 'Off';
      Input.setMinimalUiEnabled(settings.minimalUi);
      saveSettings();
    });
  }

  // Resize handler
  addEventListener('resize', resize);

  // Start game loop
  isRunning = true;
  rafId = requestAnimationFrame(tick);

  // Expose axis measurement functions
  window.measureMinAxis = Physics.measureMinAxis;
  window.measureMaxAxis = Physics.measureMaxAxis;
  window.printAxisData = Physics.printAxisData;

  // Expose cleanup function for proper shutdown
  window.cleanup = cleanup;

  // Measurement state
}

// ============================================================================
// CLEANUP AND MEMORY MANAGEMENT
// ============================================================================

/**
 * Cleanup all application resources
 * Call this when shutting down the application to prevent memory leaks
 */
function cleanup() {
  try {
    // Stop game loop
    isRunning = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    // Cleanup all modules
    Physics.cleanup();
    RingMode.cleanup();
    Input.cleanup();
    RhythmMode.cleanup();

    // Cleanup managers
    if (sceneManager) {
      sceneManager.cleanup();
    }
    if (uiManager) {
      uiManager.cleanup();
    }
    if (themeManager) {
      themeManager.cleanup();
    }
    if (cameraController) {
      cameraController.cleanup();
    }

    // Clear global references
    sceneManager = null;
    uiManager = null;
    themeManager = null;
    cameraController = null;

    console.log('[Main] Application cleanup completed');
  } catch (error) {
    console.error('[Main] Error during cleanup:', error);
  }
}
