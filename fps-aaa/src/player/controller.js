import * as THREE from 'three';
import { engine } from '../core/engine.js';
import { input } from '../core/input.js';
import { bus } from '../core/events.js';
import { settings } from '../core/settings.js';

/**
 * OVERPRESSURE — player controller.
 *
 * Quake-lineage acceleration model (wish-direction + friction) rather than
 * direct velocity assignment, so strafing carries momentum and stopping has
 * weight. Collision is a swept axis-separated AABB against world.colliders
 * with a step-up pass, which keeps the player from catching on ledges.
 *
 * Writes engine.cameraRig.position (eye), cameraRig.rotation.y (yaw),
 * cameraPitch.rotation.x (pitch) and cameraPitch.rotation.z (roll/lean).
 * Recoil, shake and FOV kick are layered by the engine on separate nodes.
 */

// ---- tuning ---------------------------------------------------------------
const RADIUS = 0.34;
const STAND_HEIGHT = 1.82;
const CROUCH_HEIGHT = 1.20;
const EYE_STAND = 1.68;
const EYE_CROUCH = 1.05;
const EYE_LERP = 9.0;

const GRAVITY = 20.5;
const JUMP_VEL = 5.1;
const COYOTE_TIME = 0.11;
const JUMP_BUFFER = 0.10;

const GROUND_ACCEL = 62.0;
const AIR_ACCEL = 9.0;
const AIR_WISH_CAP = 6.4;      // air-control cap: wish speed the air accel may chase
const FRICTION = 11.0;
const STOP_SPEED = 1.9;

const SPEED_WALK = 4.5;
const SPEED_SPRINT = 7.2;
const SPEED_CROUCH = 2.3;
const SPEED_ADS = 2.6;
const SPEED_BACK_SCALE = 0.82;
const SPRINT_SPINUP = 0.12;

const STEP_HEIGHT = 0.45;
const GROUND_PROBE = 0.14;
const SKIN = 0.015;

const MAX_PITCH = 88 * Math.PI / 180;

const MAX_HEALTH = 100;
const REGEN_DELAY = 4.5;
const REGEN_RATE = 22;

const STRIDE_WALK = 1.72;
const STRIDE_SPRINT = 2.25;
const STRIDE_CROUCH = 1.34;

// ---- module scratch (never allocate in update) ----------------------------
const _wish = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _box = new THREE.Box3();
const _probe = new THREE.Box3();
const _down = new THREE.Vector3( 0, - 1, 0 );
const _rayFoot = new THREE.Raycaster();
const _rayHits = [];

_rayFoot.far = 2.4;

function clamp01( v ) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function damp( current, target, lambda, dt ) {
	return current + ( target - current ) * ( 1 - Math.exp( - lambda * dt ) );
}

function surfaceOf( obj ) {
	let o = obj;
	while ( o ) {
		if ( o.userData && o.userData.surface ) return o.userData.surface;
		o = o.parent;
	}
	return 'concrete';
}

export function createPlayer( world, deps = {} ) {

	const colliders = ( world && world.colliders ) || [];
	const hitMeshes = ( world && world.hitMeshes ) || [];
	const spawn = ( world && world.playerSpawn ) || { position: new THREE.Vector3( 0, 0, 0 ), yaw: 0 };
	const bounds = world && world.bounds ? world.bounds : null;

	// position is the FEET position; eye = position + eyeHeight
	const position = new THREE.Vector3().copy( spawn.position );
	const velocity = new THREE.Vector3();
	const eye = new THREE.Vector3();

	const state = {
		health: MAX_HEALTH,
		maxHealth: MAX_HEALTH,
		grounded: false,
		sprinting: false,
		crouching: false,
		ads: false,
		speed: 0,
		velocity,
		alive: true,
		moving: false,
		height: STAND_HEIGHT,
	};

	// look
	let yaw = spawn.yaw || 0;
	let pitch = 0;
	const look = { x: 0, y: 0 };  // consumed mouse delta this frame (radians)

	// aim punch / recoil accumulators (added on top of the base look angles)
	let recoilPitch = 0, recoilYaw = 0;
	let recoilVelP = 0, recoilVelY = 0;
	let recoilHold = 0;
	let punchPitch = 0, punchYaw = 0;   // damage punch, fully recovers

	// vertical / posture
	let eyeHeight = EYE_STAND;
	let bodyHeight = STAND_HEIGHT;
	let crouch01 = 0;
	let wantCrouch = false;

	// jump / ground bookkeeping
	let coyote = 0;
	let jumpBuffer = 0;
	let jumpHeld = false;
	let wasGrounded = true;
	let prevVelY = 0;
	let landDip = 0, landDipVel = 0;

	// sprint
	let sprint01 = 0;
	let sprintLock = 0;

	// bob / lean
	let bobPhase = 0;
	let bobAmp = 0;
	let roll = 0;
	let leanVel = 0;

	// footsteps
	let strideAccum = 0;
	let lastSurface = 'concrete';

	// health
	let lastDamageTime = - 999;
	let healEmitAccum = 0;
	let timeAlive = 0;

	// aim state written by the weapon system
	const aim = { active: false, progress: 0, fovScale: settings.adsFovScale };

	// ---------------------------------------------------------------- helpers

	function refreshBox() {
		_box.min.set( position.x - RADIUS, position.y, position.z - RADIUS );
		_box.max.set( position.x + RADIUS, position.y + bodyHeight, position.z + RADIUS );
	}

	function boxAt( x, y, z, h, target ) {
		target.min.set( x - RADIUS, y, z - RADIUS );
		target.max.set( x + RADIUS, y + h, z + RADIUS );
		return target;
	}

	function boxFree( b ) {
		for ( let i = 0; i < colliders.length; i ++ ) {
			const c = colliders[ i ];
			if ( b.max.x > c.min.x && b.min.x < c.max.x &&
				b.max.y > c.min.y && b.min.y < c.max.y &&
				b.max.z > c.min.z && b.min.z < c.max.z ) return false;
		}
		return b.min.y >= - 0.001;
	}

	/**
	 * Move along a single axis and depenetrate. Returns true if we hit something.
	 * Axis-separated resolution is what lets the player slide along walls.
	 */
	function moveAxis( axis, amount ) {
		if ( amount === 0 ) return false;
		position[ axis ] += amount;
		refreshBox();
		let hit = false;
		// two passes handle wedges between two colliders without jitter
		for ( let pass = 0; pass < 2; pass ++ ) {
			let corrected = false;
			for ( let i = 0; i < colliders.length; i ++ ) {
				const c = colliders[ i ];
				if ( _box.max.x <= c.min.x || _box.min.x >= c.max.x ) continue;
				if ( _box.max.y <= c.min.y || _box.min.y >= c.max.y ) continue;
				if ( _box.max.z <= c.min.z || _box.min.z >= c.max.z ) continue;
				const delta = amount > 0
					? ( c.min[ axis ] - _box.max[ axis ] - SKIN )
					: ( c.max[ axis ] - _box.min[ axis ] + SKIN );
				position[ axis ] += delta;
				refreshBox();
				hit = true;
				corrected = true;
			}
			if ( ! corrected ) break;
		}
		return hit;
	}

	/** Horizontal move with an automatic step-up over ledges <= STEP_HEIGHT. */
	function moveHorizontal( axis, amount ) {
		if ( amount === 0 ) return;
		_prev.copy( position );
		const blocked = moveAxis( axis, amount );
		if ( ! blocked ) return;

		const canStep = ( state.grounded || coyote > 0 ) && velocity.y <= 0.6;
		if ( ! canStep ) { velocity[ axis ] = 0; return; }

		const stoppedAt = position[ axis ];
		// Attempt: lift, translate, then drop back down onto the ledge.
		position.copy( _prev );
		position.y += STEP_HEIGHT;
		refreshBox();
		if ( ! boxFree( _box ) ) { position.copy( _prev ); position[ axis ] = stoppedAt; velocity[ axis ] = 0; return; }

		const stillBlocked = moveAxis( axis, amount );
		if ( stillBlocked ) { position.copy( _prev ); position[ axis ] = stoppedAt; velocity[ axis ] = 0; return; }

		const topY = position.y;
		moveAxis( 'y', - STEP_HEIGHT );
		if ( position.y < 0 ) position.y = 0;
		const dropped = topY - position.y;
		if ( dropped > STEP_HEIGHT - 0.002 ) {
			// nothing to stand on over there — this was a gap, not a step
			position.copy( _prev );
			position[ axis ] = stoppedAt;
			velocity[ axis ] = 0;
		}
		refreshBox();
	}

	/** Thin slab under the feet; also snaps to the surface so stairs don't chatter. */
	function groundCheck() {
		_probe.min.set( position.x - RADIUS + 0.02, position.y - GROUND_PROBE, position.z - RADIUS + 0.02 );
		_probe.max.set( position.x + RADIUS - 0.02, position.y + 0.02, position.z + RADIUS - 0.02 );

		let best = - Infinity;
		for ( let i = 0; i < colliders.length; i ++ ) {
			const c = colliders[ i ];
			if ( _probe.max.x <= c.min.x || _probe.min.x >= c.max.x ) continue;
			if ( _probe.max.z <= c.min.z || _probe.min.z >= c.max.z ) continue;
			if ( c.max.y <= _probe.min.y || c.max.y > _probe.max.y ) continue;
			if ( c.max.y > best ) best = c.max.y;
		}
		// implicit floor plane at y = 0 so an empty collider list still works
		if ( position.y - GROUND_PROBE <= 0 && best < 0 ) best = 0;

		if ( best > - Infinity && velocity.y <= 0.001 ) {
			position.y = best;
			velocity.y = 0;
			return true;
		}
		return false;
	}

	function accelerate( dirX, dirZ, wishSpeed, accel, dt ) {
		const current = velocity.x * dirX + velocity.z * dirZ;
		const add = wishSpeed - current;
		if ( add <= 0 ) return;
		let accelSpeed = accel * dt;
		if ( accelSpeed > add ) accelSpeed = add;
		velocity.x += accelSpeed * dirX;
		velocity.z += accelSpeed * dirZ;
	}

	function applyFriction( dt ) {
		const speed = Math.sqrt( velocity.x * velocity.x + velocity.z * velocity.z );
		if ( speed < 0.0001 ) { velocity.x = 0; velocity.z = 0; return; }
		const control = speed < STOP_SPEED ? STOP_SPEED : speed;
		let newSpeed = speed - control * FRICTION * dt;
		if ( newSpeed < 0 ) newSpeed = 0;
		const scale = newSpeed / speed;
		velocity.x *= scale;
		velocity.z *= scale;
	}

	function sampleSurface() {
		if ( ! hitMeshes.length ) return 'concrete';
		_tmp.set( position.x, position.y + 0.4, position.z );
		_rayFoot.set( _tmp, _down );
		_rayHits.length = 0;
		_rayFoot.intersectObjects( hitMeshes, true, _rayHits );
		if ( _rayHits.length ) return surfaceOf( _rayHits[ 0 ].object );
		return 'concrete';
	}

	// ------------------------------------------------------------------ update

	function update( dt ) {

		timeAlive += dt;

		// ---- look ------------------------------------------------------
		const sensScale = aim.active || aim.progress > 0.15
			? THREE.MathUtils.lerp( 1, settings.adsSensitivityScale, aim.progress )
			: 1;
		const m = input.consumeMouse( sensScale );
		look.x = m.x;
		look.y = m.y;
		yaw -= m.x;
		pitch -= m.y;
		if ( yaw > Math.PI ) yaw -= Math.PI * 2; else if ( yaw < - Math.PI ) yaw += Math.PI * 2;
		if ( pitch > MAX_PITCH ) pitch = MAX_PITCH; else if ( pitch < - MAX_PITCH ) pitch = - MAX_PITCH;

		// ---- recoil accumulator recovery -------------------------------
		recoilHold -= dt;
		if ( recoilHold <= 0 ) {
			// critically-damped-ish spring back to zero
			const k = 46, c = 12;
			recoilVelP += ( - recoilPitch * k - recoilVelP * c ) * dt;
			recoilVelY += ( - recoilYaw * k - recoilVelY * c ) * dt;
			recoilPitch += recoilVelP * dt;
			recoilYaw += recoilVelY * dt;
			if ( Math.abs( recoilPitch ) < 1e-5 && Math.abs( recoilVelP ) < 1e-4 ) { recoilPitch = 0; recoilVelP = 0; }
			if ( Math.abs( recoilYaw ) < 1e-5 && Math.abs( recoilVelY ) < 1e-4 ) { recoilYaw = 0; recoilVelY = 0; }
		}
		punchPitch = damp( punchPitch, 0, 9, dt );
		punchYaw = damp( punchYaw, 0, 9, dt );

		// ---- intent ----------------------------------------------------
		const locked = input.locked;
		let mf = 0, ms = 0;
		if ( locked && state.alive ) {
			if ( input.down( 'KeyW' ) || input.down( 'ArrowUp' ) ) mf += 1;
			if ( input.down( 'KeyS' ) || input.down( 'ArrowDown' ) ) mf -= 1;
			if ( input.down( 'KeyD' ) || input.down( 'ArrowRight' ) ) ms += 1;
			if ( input.down( 'KeyA' ) || input.down( 'ArrowLeft' ) ) ms -= 1;
		}
		const hasInput = mf !== 0 || ms !== 0;

		wantCrouch = locked && state.alive && ( input.down( 'ControlLeft' ) || input.down( 'ControlRight' ) || input.down( 'KeyC' ) );

		// ---- crouch resolution (needs headroom to stand back up) --------
		let targetCrouch = wantCrouch ? 1 : 0;
		if ( targetCrouch === 0 && crouch01 > 0 ) {
			boxAt( position.x, position.y, position.z, STAND_HEIGHT, _probe );
			if ( ! boxFree( _probe ) ) targetCrouch = 1;
		}
		crouch01 = damp( crouch01, targetCrouch, EYE_LERP, dt );
		if ( crouch01 < 0.001 ) crouch01 = 0;
		if ( crouch01 > 0.999 ) crouch01 = 1;
		state.crouching = crouch01 > 0.5;
		bodyHeight = THREE.MathUtils.lerp( STAND_HEIGHT, CROUCH_HEIGHT, crouch01 );

		// ---- sprint ------------------------------------------------------
		sprintLock -= dt;
		const wantSprint = locked && state.alive && mf > 0 && ! aim.active && sprintLock <= 0 &&
			crouch01 < 0.4 && ( input.down( 'ShiftLeft' ) || input.down( 'ShiftRight' ) );
		sprint01 = wantSprint
			? Math.min( 1, sprint01 + dt / SPRINT_SPINUP )
			: Math.max( 0, sprint01 - dt / 0.09 );
		state.sprinting = sprint01 > 0.6 && state.grounded;

		// ---- target speed --------------------------------------------------
		let wishSpeed;
		if ( crouch01 > 0.5 ) wishSpeed = THREE.MathUtils.lerp( SPEED_WALK, SPEED_CROUCH, crouch01 );
		else if ( aim.progress > 0.01 ) wishSpeed = THREE.MathUtils.lerp( SPEED_WALK, SPEED_ADS, aim.progress );
		else wishSpeed = SPEED_WALK;
		wishSpeed = THREE.MathUtils.lerp( wishSpeed, SPEED_SPRINT, sprint01 * ( 1 - crouch01 ) );
		if ( mf < 0 ) wishSpeed *= SPEED_BACK_SCALE;

		// ---- wish direction in world space ----------------------------------
		const sy = Math.sin( yaw ), cy = Math.cos( yaw );
		_fwd.set( - sy, 0, - cy );
		_right.set( cy, 0, - sy );
		_wish.set( 0, 0, 0 );
		if ( hasInput ) {
			_wish.addScaledVector( _fwd, mf ).addScaledVector( _right, ms );
			const len = Math.hypot( _wish.x, _wish.z );
			if ( len > 0 ) { _wish.x /= len; _wish.z /= len; }
		}

		// ---- jump ---------------------------------------------------------
		const spaceDown = locked && state.alive && input.down( 'Space' );
		if ( spaceDown && ! jumpHeld ) jumpBuffer = JUMP_BUFFER;
		jumpHeld = spaceDown;
		jumpBuffer -= dt;
		coyote -= dt;

		// ---- integrate ------------------------------------------------------
		if ( state.grounded ) {
			if ( ! hasInput || wishSpeed <= 0 ) applyFriction( dt );
			else {
				// partial friction while accelerating keeps direction changes crisp
				applyFriction( dt * 0.35 );
				accelerate( _wish.x, _wish.z, wishSpeed, GROUND_ACCEL, dt );
			}
		} else if ( hasInput ) {
			const capped = Math.min( wishSpeed, AIR_WISH_CAP );
			accelerate( _wish.x, _wish.z, capped, AIR_ACCEL, dt );
		}

		if ( jumpBuffer > 0 && ( state.grounded || coyote > 0 ) ) {
			velocity.y = JUMP_VEL;
			state.grounded = false;
			coyote = 0;
			jumpBuffer = 0;
			landDipVel += 1.4;
			bus.emit( 'player:jump', {} );
		}

		velocity.y -= GRAVITY * dt;
		if ( velocity.y < - 55 ) velocity.y = - 55;

		prevVelY = velocity.y;

		// ---- collide: Y, then X, then Z --------------------------------------
		if ( colliders.length ) {
			moveAxis( 'y', velocity.y * dt );
			if ( position.y < 0 ) { position.y = 0; if ( velocity.y < 0 ) velocity.y = 0; }
			refreshBox();
			moveHorizontal( 'x', velocity.x * dt );
			moveHorizontal( 'z', velocity.z * dt );
		} else {
			position.y += velocity.y * dt;
			if ( position.y < 0 ) { position.y = 0; velocity.y = 0; }
			position.x += velocity.x * dt;
			position.z += velocity.z * dt;
		}

		// ceiling bonk
		if ( velocity.y > 0 ) {
			boxAt( position.x, position.y, position.z, bodyHeight, _probe );
			_probe.min.y = _probe.max.y - 0.02;
			if ( ! boxFree( _probe ) ) velocity.y = 0;
		}

		const groundedNow = groundCheck();
		state.grounded = groundedNow;
		if ( groundedNow ) coyote = COYOTE_TIME;

		if ( bounds ) {
			if ( position.x < bounds.min.x + RADIUS ) { position.x = bounds.min.x + RADIUS; velocity.x = 0; }
			if ( position.x > bounds.max.x - RADIUS ) { position.x = bounds.max.x - RADIUS; velocity.x = 0; }
			if ( position.z < bounds.min.z + RADIUS ) { position.z = bounds.min.z + RADIUS; velocity.z = 0; }
			if ( position.z > bounds.max.z - RADIUS ) { position.z = bounds.max.z - RADIUS; velocity.z = 0; }
		}

		const hspeed = Math.hypot( velocity.x, velocity.z );
		state.speed = hspeed;
		state.moving = hspeed > 0.35;
		state.height = bodyHeight;

		// ---- landing -----------------------------------------------------
		if ( groundedNow && ! wasGrounded ) {
			const fall = Math.max( 0, - prevVelY );
			if ( fall > 1.1 ) {
				const impact01 = clamp01( ( fall - 1.8 ) / 10.5 );
				lastSurface = sampleSurface();
				bus.emit( 'player:land', { impact01, surface: lastSurface } );
				landDipVel -= 2.4 + impact01 * 9.5;
				if ( impact01 > 0.25 ) engine.addShake( 0.06 + impact01 * 0.22 );
				if ( impact01 > 0.86 ) {
					// hard fall hurts
					damage( Math.round( ( impact01 - 0.86 ) * 160 ), null );
				}
			}
		}
		wasGrounded = groundedNow;

		// knee-bend spring
		landDipVel += ( - landDip * 130 - landDipVel * 15 ) * dt;
		landDip += landDipVel * dt;
		if ( landDip < - 0.34 ) { landDip = - 0.34; landDipVel = 0; }

		// ---- footsteps (distance based) --------------------------------------
		if ( groundedNow && hspeed > 0.6 ) {
			strideAccum += hspeed * dt;
			const stride = state.crouching ? STRIDE_CROUCH : ( state.sprinting ? STRIDE_SPRINT : STRIDE_WALK );
			if ( strideAccum >= stride ) {
				strideAccum -= stride;
				lastSurface = sampleSurface();
				bus.emit( 'player:footstep', {
					surface: lastSurface,
					sprinting: state.sprinting,
					position: _tmp2.copy( position ).clone(),
				} );
			}
		} else if ( ! groundedNow ) {
			strideAccum = Math.min( strideAccum, 1.2 );
		} else {
			strideAccum = damp( strideAccum, 0, 4, dt );
		}

		// ---- head bob (figure-8) ---------------------------------------------
		const bobSpeed = groundedNow ? hspeed : 0;
		bobPhase += bobSpeed * dt * 3.05;
		if ( bobPhase > Math.PI * 200 ) bobPhase -= Math.PI * 200;
		const adsDamp = 1 - aim.progress * 0.88;
		const targetAmp = clamp01( bobSpeed / SPEED_SPRINT ) * adsDamp * ( state.crouching ? 0.55 : 1 );
		bobAmp = damp( bobAmp, targetAmp, 7, dt );
		const bobX = Math.sin( bobPhase ) * 0.045 * bobAmp;
		const bobY = Math.sin( bobPhase * 2 ) * 0.032 * bobAmp - Math.abs( Math.sin( bobPhase ) ) * 0.010 * bobAmp;

		// ---- roll: strafe lean + turn lean ------------------------------------
		const strafeSign = hasInput ? ms : 0;
		const strafeRoll = - strafeSign * ( 1.1 * Math.PI / 180 ) * ( 1 - aim.progress * 0.65 ) * clamp01( hspeed / SPEED_WALK );
		const turnTarget = THREE.MathUtils.clamp( look.x * 2.4, - 0.026, 0.026 ) * ( 1 - aim.progress * 0.5 );
		leanVel = damp( leanVel, turnTarget, 11, dt );
		roll = damp( roll, strafeRoll + leanVel, 8, dt );

		// ---- eye height --------------------------------------------------------
		const targetEye = THREE.MathUtils.lerp( EYE_STAND, EYE_CROUCH, crouch01 );
		eyeHeight = damp( eyeHeight, targetEye, EYE_LERP, dt );

		// ---- health regen ------------------------------------------------------
		if ( state.alive && state.health < MAX_HEALTH && engine.elapsed - lastDamageTime > REGEN_DELAY ) {
			state.health = Math.min( MAX_HEALTH, state.health + REGEN_RATE * dt );
			healEmitAccum += dt;
			if ( healEmitAccum > 0.1 ) {
				healEmitAccum = 0;
				bus.emit( 'player:healed', { health: state.health } );
			}
		}

		// ---- write the camera rig -------------------------------------------------
		eye.set( position.x, position.y + eyeHeight + bobY + landDip, position.z );
		eye.addScaledVector( _right, bobX );

		engine.cameraRig.position.copy( eye );
		engine.cameraRig.rotation.y = yaw + recoilYaw + punchYaw;
		engine.cameraPitch.rotation.x = THREE.MathUtils.clamp( pitch + recoilPitch + punchPitch, - MAX_PITCH, MAX_PITCH );
		engine.cameraPitch.rotation.z = roll;

		// FOV: sprint widens slightly, ADS narrows
		const sprintFov = 1 + 0.06 * sprint01 * clamp01( hspeed / ( SPEED_SPRINT * 0.8 ) );
		engine.setFovScale( THREE.MathUtils.lerp( sprintFov, aim.fovScale, aim.progress ) );

		// keep the camera matrices fresh for hitscan / viewmodel solves this frame
		engine.cameraRig.updateMatrixWorld( true );
	}

	// ------------------------------------------------------------------- public

	function damage( amount, fromPos ) {
		if ( ! state.alive || amount <= 0 ) return;
		state.health -= amount;
		lastDamageTime = engine.elapsed;
		healEmitAccum = 0;

		_tmp.set( 0, 0, 0 );
		if ( fromPos ) {
			_tmp.copy( fromPos ).sub( eye );
			_tmp.y = 0;
			if ( _tmp.lengthSq() < 1e-6 ) _tmp.set( - Math.sin( yaw ), 0, - Math.cos( yaw ) );
			_tmp.normalize();
		} else {
			_tmp.set( 0, - 1, 0 );
		}

		// directional camera punch away from the shooter
		const rel = Math.atan2( _tmp.x, _tmp.z ) - Math.atan2( - Math.sin( yaw ), - Math.cos( yaw ) );
		const k = Math.min( 1, amount / 30 );
		punchPitch += 0.016 * k + Math.random() * 0.006;
		punchYaw += - Math.sin( rel ) * 0.020 * k;
		engine.addShake( 0.10 + k * 0.20 );

		if ( state.health <= 0 ) {
			state.health = 0;
			state.alive = false;
			bus.emit( 'player:damaged', { amount, health: 0, maxHealth: MAX_HEALTH, dirWorld: _tmp.clone() } );
			bus.emit( 'player:died', {} );
			return;
		}
		bus.emit( 'player:damaged', { amount, health: state.health, maxHealth: MAX_HEALTH, dirWorld: _tmp.clone() } );
	}

	function heal( amount ) {
		if ( ! state.alive ) return;
		state.health = Math.min( MAX_HEALTH, state.health + amount );
		bus.emit( 'player:healed', { health: state.health } );
	}

	/**
	 * Weapon recoil. `persist` is the fraction that is baked permanently into
	 * the aim (aim punch) — the rest springs back like modern shooters.
	 */
	function addRecoil( pitchRad, yawRad, persist = 0.3 ) {
		const bakeP = pitchRad * persist;
		const bakeY = yawRad * persist;
		pitch = THREE.MathUtils.clamp( pitch + bakeP, - MAX_PITCH, MAX_PITCH );
		yaw += bakeY;
		recoilPitch += pitchRad - bakeP;
		recoilYaw += yawRad - bakeY;
		recoilHold = 0.075;
	}

	function cancelSprint( lockSeconds = 0.22 ) {
		sprint01 = 0;
		sprintLock = Math.max( sprintLock, lockSeconds );
	}

	function setAimState( active, progress, fovScale ) {
		aim.active = !! active;
		aim.progress = clamp01( progress );
		if ( fovScale ) aim.fovScale = fovScale;
		state.ads = aim.active;
	}

	function reset() {
		position.copy( spawn.position );
		velocity.set( 0, 0, 0 );
		yaw = spawn.yaw || 0;
		pitch = 0;
		recoilPitch = recoilYaw = recoilVelP = recoilVelY = 0;
		punchPitch = punchYaw = 0;
		state.health = MAX_HEALTH;
		state.alive = true;
		state.grounded = false;
		state.sprinting = false;
		state.crouching = false;
		crouch01 = 0;
		sprint01 = 0;
		eyeHeight = EYE_STAND;
		bodyHeight = STAND_HEIGHT;
		landDip = 0; landDipVel = 0;
		bobPhase = 0; bobAmp = 0;
		strideAccum = 0;
		lastDamageTime = - 999;
		timeAlive = 0;
		wasGrounded = true;
	}

	// world-space eye position for AI / hitscan origins
	function getEye( target ) { return target.copy( eye ); }

	return {
		update,
		state,
		position,
		eye,
		velocity,
		look,
		damage,
		heal,
		addRecoil,
		cancelSprint,
		setAimState,
		getEye,
		reset,
		get yaw() { return yaw; },
		get pitch() { return pitch; },
		get timeAlive() { return timeAlive; },
		get crouch01() { return crouch01; },
		get bobPhase() { return bobPhase; },
		get sprint01() { return sprint01; },
		get radius() { return RADIUS; },
	};
}

export default createPlayer;
