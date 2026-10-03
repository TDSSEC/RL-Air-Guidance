/**
 * settings.js
 * LocalStorage management and settings persistence
 * Handles saving/loading all app settings
 */

import { PHYSICS_DEFAULTS } from './constants.js';

// ============================================================================
// SETTINGS STATE (PRIVATE)
// ============================================================================

// Track if localStorage is available
let localStorageAvailable = true;

// Private settings object - not exported directly to prevent external mutation
let _settings = {
  // Physics
  maxAccelPitch: PHYSICS_DEFAULTS.accelPitch,
  maxAccelYaw: PHYSICS_DEFAULTS.accelYaw,
  maxAccelRoll: PHYSICS_DEFAULTS.accelRoll,
  inputPow: PHYSICS_DEFAULTS.curve,
  stickRange: PHYSICS_DEFAULTS.stickRange,
  stickSize: 100,
  damp: PHYSICS_DEFAULTS.damp,
  dampDAR: PHYSICS_DEFAULTS.dampDAR,
  brakeOnRelease: PHYSICS_DEFAULTS.brake,
  wMax: PHYSICS_DEFAULTS.wmax,
  wMaxPitch: PHYSICS_DEFAULTS.wmaxPitch,
  wMaxYaw: PHYSICS_DEFAULTS.wmaxYaw,
  wMaxRoll: PHYSICS_DEFAULTS.wmaxRoll,

  // View
  circleTiltAngle: 34,
  circleTiltModifier: 0,
  circleScale: 0.3,
  zoom: 1.0,
  arrowScale: 4.0,
  showArrow: true,
  showCircle: true,
  minimalUi: false,

  // Theme
  isDarkMode: true,
  brightnessDark: 1.0,
  brightnessLight: 1.0,

  // Air Roll
  airRoll: 0,
  lastActiveAirRoll: -1,
  airRollIsToggle: false,

  // Gamepad
  gpEnabled: true,
  gpBindings: null,
  gpPreset: 'ps5',
  gpDeadzone: 0.15,
  dualStickMode: false,
  rightStickAssignment: 'none', // 'none', 'rollFree', 'rollLeft', 'rollRight'

  // Keyboard
  kbBindings: null,

  // Touch
  touchDeadzone: 0.09,

  // Car
  selectedCarBody: 'octane',

  // Audio
  gameSoundsEnabled: true,
  gameMusicEnabled: true,
  gameMusicVolume: 0.3,
  gameSfxVolume: 1.0,

  // Ring Mode
  ringModeHighScore: 0, // Legacy - kept for backwards compatibility
  ringModeHighScoreEasy: 0,
  ringModeHighScoreNormal: 0,
  ringModeHighScoreHard: 0,
  ringDifficulty: 'normal',
  ringCameraSpeed: 0.1,
  inverseGravity: false,
  inputAssist: false,

  // Coach overlays (all off by default)
  coachGhost: false,
  coachShadow: false,
  coachVelocity: false,
  coachStick: false,

  // Game Speed
  gameSpeed: 1.0 // 0.05 = 5%, 1.0 = 100%, 1.5 = 150%
};

// ============================================================================
// LOAD/SAVE
// ============================================================================

/**
 * Load settings from localStorage
 */
export function loadSettings() {
  try {
    const saved = localStorage.getItem('darSettings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);

        // Validate that parsed is an object
        if (typeof parsed !== 'object' || parsed === null) {
          console.warn('Invalid settings format in localStorage - using defaults');
          return { ..._settings };
        }

        // SECURITY: Validate each property before merging to prevent prototype pollution
        // Filter out dangerous keys like __proto__, constructor, prototype
        const validatedSettings = {};
        for (const [key, value] of Object.entries(parsed)) {
          // Block prototype pollution attempts
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            console.warn(`Blocked prototype pollution attempt: ${key}`);
            continue;
          }

          // Validate the setting using existing validation logic
          if (validateSetting(key, value)) {
            validatedSettings[key] = value;
          } else {
            console.warn(`Invalid setting from localStorage ignored: ${key} = ${value}`);
          }
        }

        // Merge only validated settings with defaults
        _settings = { ..._settings, ...validatedSettings };
        return { ..._settings }; // Return copy to prevent external mutation
      } catch (e) {
        console.error('Failed to parse saved settings:', e);
        return { ..._settings }; // Return copy
      }
    }
  } catch (e) {
    // localStorage access failed (might be disabled or in private mode)
    console.warn('localStorage not available:', e);
    localStorageAvailable = false;
  }
  return { ..._settings }; // Return copy
}

/**
 * Validate a setting value based on its key
 * @param {string} key - Setting key
 * @param {*} value - Value to validate
 * @returns {boolean} true if valid
 */
export function validateSetting(key, value) {
  // Type validation - allow null for bindings specifically
  if (value === undefined || (value === null && !['gpBindings', 'kbBindings'].includes(key))) return false;

  // Numeric settings validation
  const numericSettings = [
    'maxAccelPitch', 'maxAccelYaw', 'maxAccelRoll', 'inputPow', 'stickRange',
    'damp', 'dampDAR', 'brakeOnRelease', 'wMax', 'wMaxPitch', 'wMaxYaw', 'wMaxRoll',
    'circleTiltAngle', 'circleTiltModifier', 'circleScale', 'zoom', 'arrowScale',
    'brightnessDark', 'brightnessLight', 'airRoll', 'lastActiveAirRoll',
    'ringModeHighScore', 'ringModeHighScoreEasy', 'ringModeHighScoreNormal',
    'ringModeHighScoreHard', 'ringCameraSpeed', 'gameMusicVolume', 'gameSfxVolume',
    'stickSize', 'gpLeftStickDeadzone', 'gpRightStickDeadzone', 'gpLeftStickSensitivity', 'gpRightStickSensitivity', 'touchDeadzone'
  ];

  if (numericSettings.includes(key)) {
    if (typeof value !== 'number' || !isFinite(value)) return false;
    // Prevent negative values for most settings
    if (value < 0 && !['circleTiltModifier', 'airRoll', 'lastActiveAirRoll'].includes(key)) {
      return false;
    }
    // Clamp zoom and scale values
    if (key === 'zoom' && (value < 0.67 || value > 1.78)) {
      return false;
    }
    if (['circleScale', 'arrowScale'].includes(key) && (value < 0.1 || value > 10)) {
      return false;
    }
    if (['gameMusicVolume', 'gameSfxVolume'].includes(key) && (value < 0 || value > 1)) {
      return false;
    }
    if (key === 'stickSize' && (value < 60 || value > 180)) {
      return false;
    }
    // Deadzone validation (0 to 0.5)
    if (['gpLeftStickDeadzone', 'gpRightStickDeadzone', 'touchDeadzone'].includes(key) && (value < 0 || value > 0.5)) {
      return false;
    }
    // Sensitivity validation (0.01 to 10.00)
    if (['gpLeftStickSensitivity', 'gpRightStickSensitivity'].includes(key) && (value < 0.01 || value > 10.00)) {
      return false;
    }
    return true;
  }

  // Boolean settings validation
  const booleanSettings = [
    'showArrow', 'showCircle', 'minimalUi', 'isDarkMode', 'airRollIsToggle',
    'gpEnabled', 'gameSoundsEnabled', 'gameMusicEnabled', 'dualStickMode', 'inverseGravity', 'inputAssist',
    'coachGhost', 'coachShadow', 'coachVelocity', 'coachStick'
  ];

  if (booleanSettings.includes(key)) {
    return typeof value === 'boolean';
  }

  // String enum validation
  if (key === 'selectedCarBody') {
    return typeof value === 'string' && ['octane', 'fennec', 'dominus', 'placeholder'].includes(value);
  }

  if (key === 'gpPreset') {
    return typeof value === 'string' && ['ps5', 'xbox', 'generic'].includes(value);
  }

  if (key === 'ringDifficulty') {
    return typeof value === 'string' && ['easy', 'normal', 'hard', 'expert'].includes(value);
  }

  // Game speed validation (0.05 to 1.5)
  if (key === 'gameSpeed') {
    return typeof value === 'number' && value >= 0.05 && value <= 1.5;
  }

  // Right stick assignment validation
  if (key === 'rightStickAssignment') {
    return typeof value === 'string' && ['none', 'rollFree', 'rollLeft', 'rollRight'].includes(value);
  }

  // Object/null validation for gpBindings
  if (key === 'gpBindings') {
    return value === null || typeof value === 'object';
  }

  // Unknown key - allow for backwards compatibility
  return true;
}

/**
 * Save current settings to localStorage
 */
export function saveSettings(partialSettings = {}) {
  // Validate and filter partial settings
  const validatedSettings = {};
  for (const [key, value] of Object.entries(partialSettings)) {
    if (validateSetting(key, value)) {
      validatedSettings[key] = value;
    } else {
      console.warn(`Invalid setting value ignored: ${key} = ${value}`);
    }
  }

  // Merge validated updates
  _settings = { ..._settings, ...validatedSettings };

  // Skip localStorage save if not available
  if (!localStorageAvailable) {
    console.info('localStorage not available - settings stored in memory only');
    return;
  }

  try {
    const json = JSON.stringify(_settings);
    localStorage.setItem('darSettings', json);
  } catch (e) {
    // Handle quota exceeded error specifically
    if (e.name === 'QuotaExceededError') {
      console.warn('localStorage quota exceeded. Switching to in-memory mode.');
      localStorageAvailable = false;
    } else {
      console.error('Failed to save settings:', e);
      // If localStorage is broken, switch to in-memory mode
      localStorageAvailable = false;
    }
  }
}

/**
 * Update settings in memory only (without saving to localStorage)
 * Used during initialization to avoid excessive saves
 */
export function updateSettingsInMemory(partialSettings = {}) {
  _settings = { ..._settings, ...partialSettings };
}

/**
 * Update a specific setting and save
 */
export function updateSetting(key, value) {
  if (validateSetting(key, value)) {
    _settings[key] = value;
    saveSettings();
  } else {
    console.warn(`Invalid setting value rejected: ${key} = ${value}`);
  }
}

/**
 * Update multiple settings and save
 */
export function updateSettings(updates) {
  const validatedUpdates = {};
  for (const [key, value] of Object.entries(updates)) {
    if (validateSetting(key, value)) {
      validatedUpdates[key] = value;
    } else {
      console.warn(`Invalid setting value ignored: ${key} = ${value}`);
    }
  }
  Object.assign(_settings, validatedUpdates);
  saveSettings();
}

/**
 * Reset specific setting to default
 */
export function resetSetting(key) {
  if (PHYSICS_DEFAULTS[key] !== undefined) {
    _settings[key] = PHYSICS_DEFAULTS[key];
    saveSettings();
  }
}

/**
 * Reset all physics settings to defaults
 */
export function resetPhysicsDefaults() {
  _settings.maxAccelPitch = PHYSICS_DEFAULTS.accelPitch;
  _settings.maxAccelYaw = PHYSICS_DEFAULTS.accelYaw;
  _settings.maxAccelRoll = PHYSICS_DEFAULTS.accelRoll;
  _settings.inputPow = PHYSICS_DEFAULTS.curve;
  _settings.stickRange = PHYSICS_DEFAULTS.stickRange;
  _settings.damp = PHYSICS_DEFAULTS.damp;
  _settings.dampDAR = PHYSICS_DEFAULTS.dampDAR;
  _settings.brakeOnRelease = PHYSICS_DEFAULTS.brake;
  _settings.wMax = PHYSICS_DEFAULTS.wmax;
  _settings.wMaxPitch = PHYSICS_DEFAULTS.wmaxPitch;
  _settings.wMaxYaw = PHYSICS_DEFAULTS.wmaxYaw;
  _settings.wMaxRoll = PHYSICS_DEFAULTS.wmaxRoll;
  saveSettings();
}

/**
 * Clear all settings (force defaults on next load)
 */
export function clearAllSettings() {
  localStorage.removeItem('darSettings');
}

// ============================================================================
// GETTERS
// ============================================================================

/**
 * Get a specific setting value
 */
export function getSetting(key) {
  return _settings[key];
}

/**
 * Get all settings (returns copy to prevent external mutation)
 */
export function getAllSettings() {
  return { ..._settings };
}
