/**
 * rendering.js - HUD Rendering Module
 *
 * Handles all HUD canvas rendering:
 * - HUD canvas utilities
 * - Joystick drawing
 * - DAR button drawing
 * - Boost button drawing
 * - Ring Mode HUD (score, lives, compass, trail, target orb)
 * - Main HUD renderer
 */

import * as THREE from 'three';
import * as Car from './car.js';
import * as RingMode from './ringMode.js';
import * as Coach from './coach.js';

// HUD canvas context
let hud, hctx;

/**
 * Initialize HUD canvas and context
 * @param {HTMLCanvasElement} hudElement - The HUD canvas element
 */
export function initHUD(hudElement) {
  hud = hudElement;
  hctx = hud.getContext('2d');
  sizeHud();
}

/**
 * Resize HUD canvas to match window size
 */
export function sizeHud() {
  hud.width = innerWidth;
  hud.height = innerHeight;
}

// ============================================================================
// HUD Drawing Utilities
// ============================================================================

export function Hclear() {
  hctx.setTransform(1, 0, 0, 1, 0, 0);
  hctx.clearRect(0, 0, hud.width, hud.height);
}

export function Hcircle(x, y, r, strokeStyle, width) {
  hctx.beginPath();
  hctx.lineWidth = width;
  hctx.strokeStyle = strokeStyle;
  hctx.arc(x, y, r, 0, Math.PI * 2);
  hctx.stroke();
}

export function HfillCircle(x, y, r, fillStyle) {
  hctx.beginPath();
  hctx.fillStyle = fillStyle;
  hctx.arc(x, y, r, 0, Math.PI * 2);
  hctx.fill();
}

export function Harc(x, y, r, a1, a2, strokeStyle, width) {
  hctx.beginPath();
  hctx.lineWidth = width;
  hctx.strokeStyle = strokeStyle;
  hctx.arc(x, y, r, a1, a2);
  hctx.stroke();
}

export function Hline(x1, y1, x2, y2, strokeStyle, width) {
  hctx.beginPath();
  hctx.lineWidth = width;
  hctx.strokeStyle = strokeStyle;
  hctx.moveTo(x1, y1);
  hctx.lineTo(x2, y2);
  hctx.stroke();
}

export function Htri(x, y, a, r, fillStyle) {
  hctx.save();
  hctx.translate(x, y);
  hctx.rotate(a);
  hctx.beginPath();
  hctx.moveTo(0, -r);
  hctx.lineTo(r * 0.9, r * 0.9);
  hctx.lineTo(-r * 0.9, r * 0.9);
  hctx.closePath();
  hctx.fillStyle = fillStyle;
  hctx.fill();
  hctx.restore();
}

// ============================================================================
// Control Button Drawing
// ============================================================================

const COLS = { UP: '#ff5c5c', RIGHT: '#4c8dff', DOWN: '#53d769', LEFT: '#ffd166' };

/**
 * Draw joystick on HUD
 * @param {object} state - Joystick state { JOY_CENTER, JOY_BASE_R, JOY_KNOB_R, joyVec }
 */
export function drawJoystick(state) {
  const { JOY_CENTER, JOY_BASE_R, JOY_KNOB_R, joyVec } = state;
  const cx = JOY_CENTER.x, cy = JOY_CENTER.y, r = JOY_BASE_R;
  const t = performance.now();
  // Pulse synced to car 360° roll: 2π / (2π / DAR_ROLL_SPEED) = DAR_ROLL_SPEED / 1000
  // With DAR_ROLL_SPEED = 5.5 rad/s, one full roll takes ~1.14 seconds
  const pulse = 1 + 0.06 * Math.sin(t * 0.0055), halo = r * pulse + 10;

  Hcircle(cx, cy, halo, 'rgba(76,141,255,0.28)', 8);
  Harc(cx, cy, r, -Math.PI / 4, Math.PI / 4, COLS.RIGHT, 12);
  Harc(cx, cy, r, Math.PI / 4, 3 * Math.PI / 4, COLS.UP, 12);
  Harc(cx, cy, r, 3 * Math.PI / 4, 5 * Math.PI / 4, COLS.LEFT, 12);
  Harc(cx, cy, r, 5 * Math.PI / 4, 7 * Math.PI / 4, COLS.DOWN, 12);
  Hcircle(cx, cy, r - 18, '#b9c1cd', 2);
  Hline(cx - r + 12, cy, cx + r - 12, cy, '#cfd6e2', 1.5);
  Hline(cx, cy - r + 12, cx, cy + r - 12, '#cfd6e2', 1.5);

  const kx = cx + joyVec.x, ky = cy + joyVec.y;
  Hcircle(kx, ky, JOY_KNOB_R, '#4c8dff', 4);
  HfillCircle(kx, ky, JOY_KNOB_R, '#0f1116');
  hctx.fillStyle = '#222';
  hctx.beginPath();
  hctx.arc(cx, cy, 3, 0, Math.PI * 2);
  hctx.fill();
}

/**
 * Draw DAR (directional air roll) button on HUD
 * @param {object} state - DAR state { DAR_CENTER, DAR_R, darOn, airRoll, selectedAirRoll, airRollIsToggle }
 */
export function drawDAR(state) {
  const { DAR_CENTER, DAR_R, darOn, airRoll, selectedAirRoll, airRollIsToggle } = state;
  const cx = DAR_CENTER.x, cy = DAR_CENTER.y, r = DAR_R;

  // Determine background color based on toggle mode and activation state
  let bgColor;
  if (airRollIsToggle) {
    // Toggle mode is active - use solid blue background (matches .btn.active: #0066ff)
    bgColor = darOn ? '#0066ff' : '#0066ff';
  } else {
    // Hold mode - show dark background, blue only when active
    bgColor = darOn ? 'rgba(0,102,255,0.18)' : 'rgba(24,26,32,0.75)';
  }

  HfillCircle(cx, cy, r, bgColor);

  Hcircle(cx, cy, r, darOn ? '#4c8dff' : '#3a3d45', darOn ? 5 : 3);
  const a = (airRoll > 0) ? Math.PI / 2 : -Math.PI / 2;
  Htri(cx, cy, a, r * 0.55, darOn ? '#0e0f12' : '#e8e8ea');
  Hcircle(cx, cy, r - 12, '#bdbdbd', 1.5);

  // Display selected air roll direction as text
  let dirText = '';
  if (selectedAirRoll === -1) dirText = 'L';
  else if (selectedAirRoll === 1) dirText = 'R';
  else if (selectedAirRoll === 2) dirText = 'F';

  if (dirText) {
    hctx.fillStyle = darOn ? '#0e0f12' : '#e8e8ea';
    hctx.font = 'bold 18px system-ui';
    hctx.textAlign = 'center';
    hctx.textBaseline = 'middle';
    hctx.fillText(dirText, cx, cy + r - 6);
  }
}

/**
 * Draw Boost button on HUD
 * @param {object} state - Boost state { BOOST_CENTER, BOOST_R, ringModeBoostActive }
 */
export function drawBoost(state) {
  const { BOOST_CENTER, BOOST_R, ringModeBoostActive } = state;
  const cx = BOOST_CENTER.x, cy = BOOST_CENTER.y, r = BOOST_R;

  HfillCircle(cx, cy, r, ringModeBoostActive ? 'rgba(255,92,92,0.25)' : 'rgba(24,26,32,0.75)');
  Hcircle(cx, cy, r, ringModeBoostActive ? '#ff5c5c' : '#3a3d45', ringModeBoostActive ? 5 : 3);

  // Draw "B" text
  hctx.fillStyle = ringModeBoostActive ? '#0e0f12' : '#e8e8ea';
  hctx.font = 'bold 24px system-ui';
  hctx.textAlign = 'center';
  hctx.textBaseline = 'middle';
  hctx.fillText('B', cx, cy);
}

// ============================================================================
// Ring Mode HUD
// ============================================================================

/**
 * Draw Ring Mode HUD (score, lives, ring count, compass, trail, target orb)
 * @param {object} state - Ring Mode state
 */
export function drawRingModeHUD(state) {
  const {
    ringModeScore,
    ringModeHighScore,
    ringModeRingCount,
    ringModeLives,
    ringModeStarted,
    ringModePaused,
    ringModePosition,
    rings,
    isMobile,
    currentDifficulty,
    minimalUi,
    camera
  } = state;

  const ctx = hctx;

  // Scale text down on mobile/tablet for less distraction
  const textScale = isMobile ? 0.65 : 1.0;

  // Ring count - top center (just the number, no label)
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.floor(32 * textScale)}px system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // Ring Mode button: top 1rem (16px) + padding ~.6rem + content → clears at ~65-70px
  // On mobile, text is smaller so needs more physical space to stay visible
  const hudTop = isMobile ? 75 : 68; 
  ctx.fillText(`${ringModeRingCount}`, innerWidth / 2, hudTop);

  // Lives - top left with heart symbols (below fullscreen button)
  // Fullscreen button: top .6rem (9.6px) + 44px height = ~54px bottom
  // Add clearance so hearts don't overlap button
  ctx.textAlign = 'left';
  ctx.font = `bold ${Math.floor(28 * textScale)}px system-ui`;
  const heartSpacing = 35 * textScale;
  const heartStartY = isMobile ? 62 : 60; // Position just below fullscreen button
  for (let i = 0; i < Math.min(ringModeLives, 10); i++) {
    ctx.fillStyle = '#ff5c5c';
    ctx.fillText('♥', 20, heartStartY + i * heartSpacing);
  }

  // Ring landing indicator - NOW RENDERED AS 3D OBJECT IN ringMode.js
  // (Disabled 2D canvas version - see updateLandingIndicator() in ringMode.js)
  // The 3D version is properly attached to the grid and doesn't warp when the camera moves

  // Directional arrow compass for distant rings
  if (!state.coachLevel && ringModeStarted && !ringModePaused && ringModeLives > 0 && rings.length > 0) {
    // Find the target ring (oldest unpassed ring)
    const targetRing = rings.find(r => !r.passed && !r.missed);

    if (targetRing) {
      // Calculate 2D distance from car to ring (on grid plane)
      const dx = targetRing.mesh.position.x - ringModePosition.x;
      const dy = targetRing.mesh.position.y - ringModePosition.y;
      const distance2D = Math.sqrt(dx * dx + dy * dy);

      // Convert grid positions to screen positions
      // Player is always at screen center
      const playerScreenX = innerWidth / 2;
      const playerScreenY = innerHeight / 2;

      // Project the ring's GRID position (XY at Z=0) to screen coordinates
      // This shows where the dashed circle indicator is on the grid (2D), not the ring's 3D position
      // The landing indicator and arrow should point to where the player needs to be on the GRID,
      // which is the ring's XY position at Z=0, NOT the ring's current 3D position in space
      let ringScreenX, ringScreenY;
      if (camera) {
        // Project the ring's position on the GRID PLANE (Z=0) - this is 2D, not 3D
        const gridWorldPos = new THREE.Vector3(
          targetRing.mesh.position.x,  // Ring's X position on grid
          targetRing.mesh.position.y,  // Ring's Y position on grid
          0                             // ALWAYS Z=0 - on the grid plane, not in 3D space
        );
        const projected = gridWorldPos.clone().project(camera);
        // Convert normalized device coordinates (-1 to 1) to screen pixels
        ringScreenX = (projected.x * 0.5 + 0.5) * innerWidth;
        ringScreenY = (-(projected.y * 0.5) + 0.5) * innerHeight;
      } else {
        // Fallback to 2D offset math if camera not available
        ringScreenX = playerScreenX + dx;
        ringScreenY = playerScreenY - dy;
      }

      // Show arrow and distance for rings that started 1000+ units away
      // Keep showing until car reaches the dashed circle (landing zone)
      const wasInitiallyDistant = targetRing.initialDistance2D && targetRing.initialDistance2D >= 1000;
      const ringRadius = targetRing.size / 2;

      // Determine if the ring is offscreen in HUD coordinates.
      // Player is always at screen center; ringScreenX/Y are relative to that.
      const isOffscreen = (ringScreenX < 0 || ringScreenX > innerWidth || ringScreenY < 0 || ringScreenY > innerHeight);

      // Distance-based rule: show indicator while car is still far from the landing zone
      // For initially distant rings: hide when very close (within ring radius)
      // For nearby rings: hide only when VERY close (within 200 units) to allow car to approach grid landing indicator
      const distanceBased = wasInitiallyDistant ? distance2D > ringRadius : distance2D > 200;
      const showIndicator = isOffscreen || distanceBased;

      // Calculate direction angle (in 2D, looking down from above)
      // Negate dy because screen Y is inverted (increases downward, grid Y increases upward)
      const angle = Math.atan2(-dy, dx);

      // Convert player grid position to screen position (centered on screen)
      // The car is always at screen center, so the compass is also at screen center
      const compassCenterX = innerWidth / 2;
      const compassCenterY = innerHeight / 2;
      const compassRadius = 170;

      // Draw compass circle when peripheral mode enabled OR when showing direction indicator
      if (state.inputAssist || showIndicator) {
        ctx.save();

        // Draw thin circle outline only (removed semi-transparent black fill)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(compassCenterX, compassCenterY, compassRadius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();
      }

      // Draw peripheral mode indicator if enabled (always show when peripheral mode on)
      if (state.inputAssist && Car.car) {
        // Phase-based input assist: helps user approach, enter, and stabilize at rings
        
        const carPos3D = Car.car.position;
        const epsilon = 1e-6;
        
        // Get car's basis vectors
        const carForward = new THREE.Vector3(0, 0, 1);
        carForward.applyQuaternion(Car.car.quaternion);
        
        const carUp = new THREE.Vector3(0, 1, 0);
        carUp.applyQuaternion(Car.car.quaternion);
        
        const carRight = new THREE.Vector3().crossVectors(carForward, carUp);
        
        // Get current velocity and position from Ring Mode
        const ringVel = RingMode.getRingModeVelocity();
        const velocityMagnitude = ringVel.length();
        
        // Determine assist target based on ring state
        let assistTarget = null;
        let assistPhase = "none";
        
        if (targetRing) {
          // Ring exists - calculate distance and determine phase
          const ringRadius = targetRing.size / 2;
          const ringCenter = new THREE.Vector3(
            targetRing.mesh.position.x,
            targetRing.mesh.position.y + ringRadius,
            0
          );
          
          const toRing = ringCenter.clone().sub(carPos3D);
          const distanceToRing = toRing.length();
          
          // Thresholds for phase transitions
          const APPROACH_DISTANCE = 200;  // When to switch from approaching to entering
          const STABILIZE_DISTANCE = 80;  // When to consider "in ring"
          const STABILIZE_VELOCITY = 50;  // Velocity threshold for stabilized state
          
          if (distanceToRing > APPROACH_DISTANCE) {
            // APPROACHING: Point nose at ring
            assistPhase = "approaching";
            assistTarget = ringCenter.clone();
          } else if (distanceToRing < STABILIZE_DISTANCE && velocityMagnitude < STABILIZE_VELOCITY) {
            // STABILIZED: Point nose up to maintain position
            assistPhase = "stabilized";
            // Target: car position + world up direction
            assistTarget = carPos3D.clone().add(new THREE.Vector3(0, 1, 0));
          } else if (distanceToRing < APPROACH_DISTANCE && velocityMagnitude > STABILIZE_VELOCITY) {
            // ENTERING: Point nose opposite to velocity to cancel momentum
            assistPhase = "entering";
            // Create target that's opposite to velocity direction
            const antiVelocity = new THREE.Vector3(-ringVel.x, -ringVel.y, 0);
            if (antiVelocity.length() > epsilon) {
              antiVelocity.normalize();
              // Target is far in the anti-velocity direction
              assistTarget = carPos3D.clone().add(antiVelocity.multiplyScalar(1000));
            } else {
              // Fallback to ring if no velocity
              assistTarget = ringCenter.clone();
            }
          } else {
            // TRANSITION states: approach or stabilize
            assistPhase = "approaching";
            assistTarget = ringCenter.clone();
          }
        } else {
          // NO RING: Point nose up
          assistPhase = "despawned";
          assistTarget = carPos3D.clone().add(new THREE.Vector3(0, 1, 0));
        }
        
        // Draw indicator if assistTarget is valid
        if (assistTarget) {
          const toTarget = assistTarget.clone().sub(carPos3D);
          const distance = toTarget.length();
          if (distance >= epsilon) {
            toTarget.divideScalar(distance);
            
            // Project target onto plane perpendicular to nose (the plane the plank pivots on)
            const forwardComponent = toTarget.dot(carForward);
            const plankDirection = toTarget.clone().sub(carForward.clone().multiplyScalar(forwardComponent));
            
            const plankLength = plankDirection.length();
            if (plankLength >= epsilon) {
              plankDirection.normalize();
        
              // Measure where the plank points in that plane using car's up/right as axes
              // This is from the driver's perspective inside the car
              const upComponent = plankDirection.dot(carUp);
              const rightComponent = plankDirection.dot(carRight);
              
              // Calculate plank angle: 0° = pointing where driver sees "up", 90° = pointing where driver sees "right"
              let stickAngle = Math.atan2(rightComponent, -upComponent);
              
              // When target is behind nose, add 180° to correct the inverted perpendicular
              if (forwardComponent < 0) {
                stickAngle += Math.PI;
              }
              
              // Indicator opacity: full opacity in all assist phases
              // The green dot position itself shows the direction clearly
              let indicatorAlpha = 1.0;
              
              // Convert to screen space for compass display
              // Rotate by -90° so that 0° (push up) appears at top of compass
              const screenAngle = stickAngle - Math.PI / 2;
              
              // Draw indicator marker on compass circle
              const indicatorX = compassCenterX + Math.cos(screenAngle) * compassRadius;
              const indicatorY = compassCenterY + Math.sin(screenAngle) * compassRadius;
              
              ctx.save();
              ctx.translate(indicatorX, indicatorY);
              
              // Draw small filled circle as indicator with alpha based on alignment
              ctx.fillStyle = `rgba(0, 255, 0, ${indicatorAlpha})`; // Green with variable opacity
              ctx.strokeStyle = `rgba(255, 255, 255, ${indicatorAlpha})`;
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.arc(0, 0, 8, 0, Math.PI * 2); // 8px radius circle
              ctx.fill();
              ctx.stroke();
              
              ctx.restore();
            }
          }
        }
      }

      // Calculate arrow position (will be used for dashed line start point)
      let arrowX, arrowY;

      if (showIndicator) {

        // Calculate arrow position on circle perimeter
        arrowX = compassCenterX + Math.cos(angle) * compassRadius;
        arrowY = compassCenterY + Math.sin(angle) * compassRadius;

        // Draw arrow at edge of circle pointing toward ring
        ctx.save();
        ctx.translate(arrowX, arrowY);
        ctx.rotate(angle);

        // Draw prominent arrow shape
        const arrowSize = 30;
        ctx.fillStyle = '#ff5c5c';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(arrowSize, 0); // Arrow tip (pointing right = direction of rotation)
        ctx.lineTo(-arrowSize / 2, -arrowSize / 2); // Top back
        ctx.lineTo(-arrowSize / 2, arrowSize / 2); // Bottom back
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.restore();

        // Distance text next to arrow (offset outward from circle)
        const distText = `${Math.round(distance2D)}u`;
        // Position text outside the arrow with extra spacing so it doesn't overlap
        const textOffsetDistance = 65; // Increased from 45 to give arrow more space
        const textX = arrowX + Math.cos(angle) * textOffsetDistance;
        const textY = arrowY + Math.sin(angle) * textOffsetDistance;

        ctx.font = 'bold 24px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 4;
        ctx.strokeText(distText, textX, textY);
        ctx.fillText(distText, textX, textY);
      }

      // Draw dashed trail from arrow to ring position on grid
      // Only show when arrow/compass is showing
      if (showIndicator && arrowX && arrowY) {
        const startX = arrowX;
        const startY = arrowY;

        // Draw dashed line (starting from arrow or car edge)
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 92, 92, 0.6)'; // Semi-transparent red
        ctx.lineWidth = 3;
        ctx.setLineDash([15, 10]); // Dashed pattern: 15px dash, 10px gap
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(ringScreenX, ringScreenY);
        ctx.stroke();
        ctx.setLineDash([]); // Reset dash pattern
        ctx.restore();

        // Draw target orb at ring position
        ctx.save();
        // Outer glow
        const gradient = ctx.createRadialGradient(ringScreenX, ringScreenY, 0, ringScreenX, ringScreenY, 25);
        gradient.addColorStop(0, 'rgba(255, 92, 92, 0.8)');
        gradient.addColorStop(0.5, 'rgba(255, 92, 92, 0.4)');
        gradient.addColorStop(1, 'rgba(255, 92, 92, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(ringScreenX, ringScreenY, 25, 0, Math.PI * 2);
        ctx.fill();

        // Inner solid orb
        ctx.fillStyle = '#ff5c5c';
        ctx.beginPath();
        ctx.arc(ringScreenX, ringScreenY, 12, 0, Math.PI * 2);
        ctx.fill();

        // White center highlight
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.beginPath();
        ctx.arc(ringScreenX - 4, ringScreenY - 4, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    } else if (state.inputAssist && Car.car) {
      // No target ring - show input assist pointing toward world up
      const compassCenterX = innerWidth / 2;
      const compassCenterY = innerHeight / 2;
      const compassRadius = 170;
      
      // Draw compass circle
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(compassCenterX, compassCenterY, compassRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      
      // Calculate stick input needed to point car toward world up (0, 1, 0)
      const carForward = new THREE.Vector3(0, 0, 1);
      carForward.applyQuaternion(Car.car.quaternion);
      
      const carUp = new THREE.Vector3(0, 1, 0);
      carUp.applyQuaternion(Car.car.quaternion);
      
      const carRight = new THREE.Vector3().crossVectors(carForward, carUp);
      
      // Target is world up direction
      const worldUp = new THREE.Vector3(0, 1, 0);
      
      // Project world up onto plane perpendicular to car's forward
      const forwardComponent = worldUp.dot(carForward);
      const perpendicular = worldUp.clone().sub(carForward.clone().multiplyScalar(forwardComponent));
      
      const epsilon = 1e-6;
      const lenPerp = perpendicular.length();
      if (lenPerp > epsilon) {
        perpendicular.divideScalar(lenPerp);
        
        // Measure angle in perpendicular plane
        const upComponent = perpendicular.dot(carUp);
        const rightComponent = perpendicular.dot(carRight);
        
        const stickAngle = Math.atan2(rightComponent, -upComponent);
        const screenAngle = stickAngle - Math.PI / 2;
        
        // Draw indicator (always full opacity when no target ring)
        const indicatorX = compassCenterX + Math.cos(screenAngle) * compassRadius;
        const indicatorY = compassCenterY + Math.sin(screenAngle) * compassRadius;
        
        ctx.save();
        ctx.translate(indicatorX, indicatorY);
        ctx.fillStyle = 'rgba(0, 255, 0, 1.0)'; // Green, fully visible
        ctx.strokeStyle = 'rgba(255, 255, 255, 1.0)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
  }
  
  // Show input assist pointing to world up when no rings exist
  if (ringModeStarted && !ringModePaused && ringModeLives > 0 && rings.length === 0 && state.inputAssist && Car.car) {
    const compassCenterX = innerWidth / 2;
    const compassCenterY = innerHeight / 2;
    const compassRadius = 170;
    
    // Draw compass circle
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(compassCenterX, compassCenterY, compassRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    
    // Calculate stick input needed to point car toward world up (0, 1, 0)
    const carForward = new THREE.Vector3(0, 0, 1);
    carForward.applyQuaternion(Car.car.quaternion);
    
    const carUp = new THREE.Vector3(0, 1, 0);
    carUp.applyQuaternion(Car.car.quaternion);
    
    const carRight = new THREE.Vector3().crossVectors(carForward, carUp);
    
    // Target is world up direction
    const worldUp = new THREE.Vector3(0, 1, 0);
    
    // Project world up onto plane perpendicular to car's forward
    const forwardComponent = worldUp.dot(carForward);
    const perpendicular = worldUp.clone().sub(carForward.clone().multiplyScalar(forwardComponent));
    
    const epsilon = 1e-6;
    const lenPerp = perpendicular.length();
    if (lenPerp > epsilon) {
      perpendicular.divideScalar(lenPerp);
      
      // Measure angle in perpendicular plane
      const upComponent = perpendicular.dot(carUp);
      const rightComponent = perpendicular.dot(carRight);
      
      const stickAngle = Math.atan2(rightComponent, -upComponent);
      const screenAngle = stickAngle - Math.PI / 2;
      
      // Draw indicator (always full opacity when no target ring)
      const indicatorX = compassCenterX + Math.cos(screenAngle) * compassRadius;
      const indicatorY = compassCenterY + Math.sin(screenAngle) * compassRadius;
      
      ctx.save();
      ctx.translate(indicatorX, indicatorY);
      ctx.fillStyle = 'rgba(0, 255, 0, 1.0)'; // Green, fully visible
      ctx.strokeStyle = 'rgba(255, 255, 255, 1.0)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // Game over or paused text
  if (ringModeLives <= 0) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, innerHeight / 2 - 140, innerWidth, 160);
    ctx.fillStyle = '#ff5c5c';
    ctx.font = 'bold 48px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GAME OVER', innerWidth / 2, innerHeight / 2 - 80);
    ctx.font = 'bold 24px system-ui';
    ctx.fillText(`Final Score: ${ringModeScore}`, innerWidth / 2, innerHeight / 2 - 30);
    ctx.fillText(`High Score: ${ringModeHighScore}`, innerWidth / 2, innerHeight / 2);

    // Draw retry button
    const retryButtonWidth = 200;
    const retryButtonHeight = 50;
    const retryButtonX = innerWidth / 2 - retryButtonWidth / 2;
    const retryButtonY = innerHeight / 2 + 30;

    ctx.fillStyle = '#4c8dff';
    ctx.fillRect(retryButtonX, retryButtonY, retryButtonWidth, retryButtonHeight);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeRect(retryButtonX, retryButtonY, retryButtonWidth, retryButtonHeight);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px system-ui';
    ctx.fillText('RETRY', innerWidth / 2, retryButtonY + retryButtonHeight / 2);
  } else if (ringModePaused) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, innerHeight / 2 - 40, innerWidth, 80);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 48px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PAUSED', innerWidth / 2, innerHeight / 2);
  } else if (!ringModeStarted) {
    const messageY = innerHeight - 100;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, messageY - 40, innerWidth, 80);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Press Boost to Start!', innerWidth / 2, messageY);
  }
}

// ============================================================================
// Main HUD Renderer
// ============================================================================

/**
 * Render the complete HUD
 * @param {object} state - Complete rendering state
 */
export function renderHUD(state) {
  Hclear();

  if (!state.minimalUi) {
    // Draw joystick
    drawJoystick({
      JOY_CENTER: state.JOY_CENTER,
      JOY_BASE_R: state.JOY_BASE_R,
      JOY_KNOB_R: state.JOY_KNOB_R,
      joyVec: state.joyVec
    });

    // Draw DAR button
    drawDAR({
      DAR_CENTER: state.DAR_CENTER,
      DAR_R: state.DAR_R,
      darOn: state.darOn,
      airRoll: state.airRoll,
      selectedAirRoll: state.selectedAirRoll,
      airRollIsToggle: state.airRollIsToggle
    });
  }

  // Draw Ring Mode HUD if active
  if (state.ringModeActive) {
    if (state.showBoostButton && !state.minimalUi) {
      drawBoost({
        BOOST_CENTER: state.BOOST_CENTER,
        BOOST_R: state.BOOST_R,
        ringModeBoostActive: state.ringModeBoostActive
      });
    }

    drawRingModeHUD({
      ringModeScore: state.ringModeScore,
      ringModeHighScore: state.ringModeHighScore,
      ringModeRingCount: state.ringModeRingCount,
      ringModeLives: state.ringModeLives,
      ringModeStarted: state.ringModeStarted,
      ringModePaused: state.ringModePaused,
      ringModePosition: state.ringModePosition,
      rings: state.rings,
      isMobile: state.isMobile,
      currentDifficulty: state.currentDifficulty,
      inputAssist: state.inputAssist,
      coachLevel: state.coachLevel,
      camera: state.camera
    });

    // Coach overlays (each toggle off by default)
    if (state.coach && state.camera) {
      const cam = state.camera;
      const v = new THREE.Vector3();
      Coach.draw(hctx, {
        flags: state.coach,
        level: state.coachLevel || 0,
        width: innerWidth,
        height: innerHeight,
        active: !state.ringModePaused && state.ringModeLives > 0,
        project: (x, y, z = 0) => {
          v.set(x, y, z).project(cam);
          return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, behind: v.z > 1 };
        }
      });
    }
  }
}
