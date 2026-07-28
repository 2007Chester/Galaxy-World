import * as THREE from 'three';
import { engine } from '../core/engine.js';
import { WEAPON_MATERIALS } from './weaponModels.js';

/**
 * OVERPRESSURE — first-person viewmodel presentation.
 *
 * The weapon pose is composited numerically every frame rather than nested in
 * a chain of Object3Ds: one blended base pose (sprint <-> hip <-> ADS) plus
 * additive offsets (sway, bob, breathing, recoil springs, reload timeline,
 * weapon switch). That keeps the ADS solve exact — we place the weapon so its
 * `sightPoint` lands on the optical centre of engine.viewCamera, solved at
 * runtime from the actual transforms instead of hand-tuned numbers.
 */

// ---- scratch --------------------------------------------------------------
const _v = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pBase = new THREE.Vector3();
const _pAds = new THREE.Vector3();
const _off = new THREE.Vector3();
const _qBase = new THREE.Quaternion();
const _qAds = new THREE.Quaternion();
const _qOff = new THREE.Quaternion();
const _eOff = new THREE.Euler();
const _mat = new THREE.Matrix4();

function clamp( v, a, b ) { return v < a ? a : v > b ? b : v; }
function damp( c, t, l, dt ) { return c + ( t - c ) * ( 1 - Math.exp( - l * dt ) ); }

/** Smoothstep-interpolated keyframe track: keys = [t0,v0, t1,v1, ...]. */
function track( t, keys ) {
	const n = keys.length;
	if ( t <= keys[ 0 ] ) return keys[ 1 ];
	for ( let i = 0; i + 3 < n; i += 2 ) {
		const t1 = keys[ i + 2 ];
		if ( t <= t1 ) {
			const t0 = keys[ i ];
			let u = ( t - t0 ) / Math.max( 1e-6, t1 - t0 );
			u = u * u * ( 3 - 2 * u );
			return keys[ i + 1 ] + ( keys[ i + 3 ] - keys[ i + 1 ] ) * u;
		}
	}
	return keys[ n - 1 ];
}

// Reload tracks are expressed in normalised time (0..1 of the reload duration)
// so tactical and empty reloads share the same choreography at different tempo.
const RL_TILT_Z = [ 0.00, 0, 0.14, 0.42, 0.62, 0.40, 0.86, 0.10, 1.00, 0 ];
const RL_TILT_Y = [ 0.00, 0, 0.14, 0.34, 0.70, 0.30, 0.92, 0.05, 1.00, 0 ];
const RL_TILT_X = [ 0.00, 0, 0.16, - 0.20, 0.60, - 0.16, 0.90, 0, 1.00, 0 ];
const RL_POS_Y = [ 0.00, 0, 0.13, - 0.055, 0.66, - 0.048, 0.90, - 0.004, 1.00, 0 ];
const RL_POS_X = [ 0.00, 0, 0.15, - 0.030, 0.70, - 0.026, 0.94, 0, 1.00, 0 ];
const RL_POS_Z = [ 0.00, 0, 0.18, 0.040, 0.72, 0.034, 0.95, 0, 1.00, 0 ];
// magazine: drop free, disappear, new one rides up into the well, then seats
const RL_MAG_Y = [ 0.00, 0, 0.10, 0, 0.30, - 0.42, 0.44, - 0.60, 0.52, - 0.34, 0.74, - 0.02, 0.80, 0.008, 0.86, 0 ];
const RL_MAG_R = [ 0.00, 0, 0.10, 0, 0.32, 0.55, 0.46, 0.75, 0.56, 0.22, 0.76, 0, 1.00, 0 ];
// charging handle / slide rack, only on an empty reload (normalised late window)
const RL_CH = [ 0.78, 0, 0.86, 1, 0.90, 1, 0.96, 0, 1.00, 0 ];
// seat punch: a sharp jolt when the magazine locks in
const RL_PUNCH = [ 0.78, 0, 0.815, 1, 0.90, 0, 1.00, 0 ];

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------
// The weapons are modelled at true real-world scale (the rifle is 0.82m long and
// 0.42m from optic crown to magazine floor) because the muzzle/eject/sight
// markers drive world-space VFX and the ADS solve. Real scale means the hip pose
// cannot be authored by eye: held 0.15m from the lens a rifle subtends more than
// the entire viewport, which is exactly the "wall of geometry" failure.
//
// So the framing is *declared in NDC and solved for* at load time instead of
// hand-tuned. Two knobs set the apparent size — the distance the weapon is held
// at, and the lens it is filmed through — and it is worth being precise about
// how they interact, because it is easy to get backwards:
//
//   ndcHeight = modelHeight / (distance * tan(fov/2))
//
// A *narrower* viewmodel lens is a zoom: it makes the weapon bigger and has to
// be paid for with even more distance. Only their ratio is visible to the
// player; it sets the perspective distortion. Close + wide gives the bulging,
// foreshortened receiver we are trying to get away from, far + narrow gives a
// flat, readable, product-shot silhouette.
//
// We therefore leave engine.viewCamera at its authored 62 deg (also avoiding
// mutating a camera this module does not own) and let the solver buy the
// framing with distance alone. It settles the grip around 0.6-0.7m, which is
// further than a shouldered weapon physically sits — but that distance is not
// directly perceivable, whereas the reduced distortion very much is.
//
// Framing is re-solved on resize because NDC-x depends on the aspect ratio.

// The window every weapon must project inside — the hard limit the integration
// harness asserts. Per-weapon targets sit inside this with margin.
const FRAME_LIMIT = { xMin: - 0.05, xMax: 0.98, yMin: - 0.98, yMax: 0.35 };

// Default target: lower-right third, barrel running up toward screen centre.
const FRAME_RIFLE = { xMin: - 0.02, xMax: 0.94, yMin: - 0.88, yMax: 0.16, muzzleX: 0.20, muzzleY: - 0.06 };

const _fpV = new THREE.Vector3();
const _fpQ = new THREE.Quaternion();
const _fpP = new THREE.Vector3();
const _fpE = new THREE.Euler();
const _bounds = { xMin: 0, xMax: 0, yMin: 0, yMax: 0, muzzleX: 0, muzzleY: 0, depth: 0, behind: 0 };

/**
 * Decimated local-space point cloud of a weapon's visible geometry.
 *
 * A coarse AABB is far too pessimistic for a long thin object: its near corners
 * claim the full height of the weapon at the depth of the stock, so a solver fed
 * AABB corners pushes the gun much further away than it needs to be. Sampling
 * real vertices gives the true silhouette.
 */
function collectFramingPoints( group ) {
	const pts = [];
	const m = new THREE.Matrix4();
	const v = new THREE.Vector3();
	group.updateMatrixWorld( true );
	const inv = new THREE.Matrix4().copy( group.matrixWorld ).invert();
	group.traverse( ( o ) => {
		if ( ! o.isMesh || ! o.visible || ! o.geometry ) return;
		const pos = o.geometry.getAttribute( 'position' );
		if ( ! pos ) return;
		m.copy( inv ).multiply( o.matrixWorld );
		// stride so a 4k-triangle weapon yields a few hundred points
		const stride = Math.max( 1, Math.floor( pos.count / 120 ) );
		for ( let i = 0; i < pos.count; i += stride ) {
			v.fromBufferAttribute( pos, i ).applyMatrix4( m );
			pts.push( v.x, v.y, v.z );
		}
		// always include this mesh's own AABB corners so a coarse stride can
		// never miss an extremity
		o.geometry.computeBoundingBox();
		const bb = o.geometry.boundingBox;
		for ( let c = 0; c < 8; c ++ ) {
			v.set( c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z );
			v.applyMatrix4( m );
			pts.push( v.x, v.y, v.z );
		}
	} );
	return new Float32Array( pts );
}

/**
 * Project a weapon's framing cloud through viewCamera and return NDC bounds.
 * Pure maths on the camera's projection parameters — no matrices, no garbage.
 */
function projectBounds( entry, quat, pos, out ) {
	const cam = engine.viewCamera;
	const tanV = Math.tan( THREE.MathUtils.degToRad( cam.fov ) * 0.5 );
	const tanH = tanV * Math.max( 1.2, cam.aspect );
	const p = entry.framePoints;
	let xMin = Infinity, xMax = - Infinity, yMin = Infinity, yMax = - Infinity;
	let depthSum = 0, behind = 0, n = 0;
	for ( let i = 0; i < p.length; i += 3 ) {
		_fpV.set( p[ i ], p[ i + 1 ], p[ i + 2 ] ).applyQuaternion( quat ).add( pos );
		const d = - _fpV.z;
		if ( d <= 0.01 ) { behind ++; continue; }
		const nx = _fpV.x / ( d * tanH );
		const ny = _fpV.y / ( d * tanV );
		if ( nx < xMin ) xMin = nx;
		if ( nx > xMax ) xMax = nx;
		if ( ny < yMin ) yMin = ny;
		if ( ny > yMax ) yMax = ny;
		depthSum += d; n ++;
	}
	out.xMin = xMin; out.xMax = xMax; out.yMin = yMin; out.yMax = yMax;
	out.depth = n > 0 ? depthSum / n : 1;
	out.behind = behind;

	// muzzle tip, same projection
	_fpV.copy( entry.muzzleLocal ).applyQuaternion( quat ).add( pos );
	const md = Math.max( 0.01, - _fpV.z );
	out.muzzleX = _fpV.x / ( md * tanH );
	out.muzzleY = _fpV.y / ( md * tanV );
	return out;
}

/**
 * Solve the hip translation (and refine hip yaw) so the weapon lands inside its
 * target NDC window with the muzzle pointing up toward screen centre.
 *
 * Fixed-point iteration: measure the projected bounds, push the weapon along -Z
 * until its span matches the target span, recentre in X/Y, and nudge yaw/pitch
 * to walk the muzzle to its mark. NDC scales as 1/depth, so the depth step is a
 * good predictor and this converges in a few dozen damped steps.
 */
function solveHipFraming( entry ) {
	const cam = engine.viewCamera;
	const tanV = Math.tan( THREE.MathUtils.degToRad( cam.fov ) * 0.5 );
	const tanH = tanV * Math.max( 1.2, cam.aspect );
	const t = entry.frame;
	const tcx = ( t.xMin + t.xMax ) * 0.5, tcy = ( t.yMin + t.yMax ) * 0.5;
	const tw = t.xMax - t.xMin, th = t.yMax - t.yMin;

	const pos = _fpP.copy( entry.hipSeed );
	let yaw = entry.hipEuler.y, pitch = entry.hipEuler.x;

	for ( let it = 0; it < 64; it ++ ) {
		_fpE.set( pitch, yaw, entry.hipEuler.z );
		_fpQ.setFromEuler( _fpE );
		const b = projectBounds( entry, _fpQ, pos, _bounds );

		if ( b.behind > 0 || ! isFinite( b.xMin ) ) {
			// some geometry is at or behind the lens — back off hard and retry
			pos.z -= 0.12;
			continue;
		}

		// 1. size: fit the tighter of the two axes
		const s = Math.min( tw / Math.max( 1e-4, b.xMax - b.xMin ), th / Math.max( 1e-4, b.yMax - b.yMin ) );
		const dz = b.depth * ( 1 / s - 1 );
		pos.z -= dz * 0.6;

		// 2. centre it in the window
		const bcx = ( b.xMin + b.xMax ) * 0.5, bcy = ( b.yMin + b.yMax ) * 0.5;
		pos.x += ( tcx - bcx ) * b.depth * tanH * 0.6;
		pos.y += ( tcy - bcy ) * b.depth * tanV * 0.6;

		// 3. aim the muzzle at its mark (rotating about the grip swings the
		//    barrel far more than the body, which is exactly the lever we want).
		//    +yaw swings the muzzle to -x, +pitch lifts it, hence the signs.
		yaw += ( b.muzzleX - t.muzzleX ) * 0.10;
		pitch -= ( b.muzzleY - t.muzzleY ) * 0.10;
		yaw = clamp( yaw, - 0.10, 0.40 );
		pitch = clamp( pitch, - 0.24, 0.24 );
	}

	entry.hipPos.copy( pos );
	entry.hipEuler.x = pitch;
	entry.hipEuler.y = yaw;
	entry.hipQuat.setFromEuler( entry.hipEuler );
	entry.sprintPos.copy( pos ).add( entry.sprintOffset );
}

// How much environment reflection the weapon should actually receive, whatever
// exposure the host scene is running at.
const ENV_TARGET = { metal: 0.50, polymer: 0.34, glove: 0.30, glass: 0.85 };
let lastEnvIntensity = - 1;

/**
 * Keep the weapon reading as dark gunmetal regardless of the viewScene's
 * exposure. The bootstrap hands viewScene the world's PMREM environment and
 * sets environmentIntensity to whatever suits the world (currently ~2.4); left
 * alone that multiplies straight into an 85%-metalness material and turns the
 * rifle into pale beige. Rather than hardcode a counterweight that silently
 * rots if the host retunes, divide it out so the product stays put.
 */
function syncEnvExposure() {
	const envI = engine.viewScene.environmentIntensity ?? 1;
	if ( envI === lastEnvIntensity ) return;
	lastEnvIntensity = envI;
	const s = 1 / Math.max( 0.05, envI );
	WEAPON_MATERIALS.metal.envMapIntensity = ENV_TARGET.metal * s;
	WEAPON_MATERIALS.polymer.envMapIntensity = ENV_TARGET.polymer * s;
	WEAPON_MATERIALS.glove.envMapIntensity = ENV_TARGET.glove * s;
	WEAPON_MATERIALS.glass.envMapIntensity = ENV_TARGET.glass * s;
}

let sharedLights = null;

function ensureViewLights() {
	if ( sharedLights ) return sharedLights;
	// The gun is lit by this rig *plus* whatever environment the bootstrap hands
	// viewScene, so the direct lights stay modest and do the shaping work while
	// the environment supplies colour. The rim is the one deliberately strong
	// term: it is what separates the weapon from both a bright dusk sky and a
	// black container interior, and it does not depend on the world at all.
	const key = new THREE.DirectionalLight( 0xffe2c4, 1.15 );
	key.position.set( - 0.45, 0.85, 0.55 );
	const rim = new THREE.DirectionalLight( 0x9ec8ff, 2.10 );
	rim.position.set( 0.78, 0.30, - 0.80 );
	const under = new THREE.DirectionalLight( 0x445066, 0.28 );
	under.position.set( 0.15, - 0.9, 0.25 );
	const amb = new THREE.AmbientLight( 0x20262e, 0.55 );
	engine.viewScene.add( key, rim, under, amb );
	sharedLights = { key, rim, under, amb };
	return sharedLights;
}

/**
 * @param {object} deps  { vfx, audio } — all optional.
 */
export function createViewmodel( deps = {} ) {

	ensureViewLights();

	const holder = new THREE.Object3D();
	engine.viewRoot.add( holder );

	const entries = new Map();   // id -> entry
	let current = null;
	let pending = null;          // queued weapon id during a switch

	// --- pose state -----------------------------------------------------
	let adsT = 0, adsVel = 0, adsTarget = 0;
	let sprintBlend = 0;
	let lowerT = 0, lowerTarget = 0, lowerSpeed = 6;
	let crouchSettle = 0;
	let bobPhase = 0, bobAmp = 0;
	let breathe = 0;

	// sway springs (driven by mouse impulses)
	let swayX = 0, swayY = 0, swayVX = 0, swayVY = 0;
	let leanRoll = 0;

	// recoil springs
	const rPos = new THREE.Vector3();
	const rVel = new THREE.Vector3();
	const rRot = new THREE.Vector3();
	const rRotVel = new THREE.Vector3();

	// reload / part animation
	let reloadTime = - 1, reloadDur = 1, reloadEmpty = false;
	let boltT = 0;      // 0..1 bolt/slide travel from firing
	let triggerT = 0;

	// ---------------------------------------------------------------- register

	/**
	 * @param {string} id
	 * @param {object} built  result of buildRifle()/buildPistol()/buildSMG()
	 * @param {object} cfg    pose + feel configuration
	 */
	function register( id, built, cfg = {} ) {
		const g = built.group;
		g.position.set( 0, 0, 0 );
		g.quaternion.identity();
		g.updateMatrixWorld( true );

		const sightLocal = new THREE.Vector3();
		built.sightPoint.getWorldPosition( sightLocal );
		g.worldToLocal( sightLocal );

		const muzzleLocal = new THREE.Vector3();
		built.muzzleTip.getWorldPosition( muzzleLocal );
		g.worldToLocal( muzzleLocal );

		// Seed only — solveHipFraming() decides the real hip translation.
		const hipPos = new THREE.Vector3( 0.11, - 0.12, - 0.30 );
		const hipEuler = new THREE.Euler().fromArray( cfg.hipRot || [ 0.020, - 0.062, 0.026 ] );
		const sprintEuler = new THREE.Euler().fromArray( cfg.sprintRot || [ - 0.30, 0.30, - 0.44 ] );

		const entry = {
			id,
			built,
			group: g,
			sightLocal,
			muzzleLocal,
			framePoints: collectFramingPoints( g ),
			frame: Object.assign( {}, FRAME_RIFLE, cfg.frame || {} ),
			hipSeed: hipPos.clone(),
			hipPos,
			hipEuler,
			hipQuat: new THREE.Quaternion().setFromEuler( hipEuler ),
			// authored as a delta so it rides along with the solved hip pose
			sprintOffset: new THREE.Vector3().fromArray( cfg.sprintOffset || [ 0.045, - 0.060, 0.095 ] ),
			sprintPos: new THREE.Vector3(),
			sprintQuat: new THREE.Quaternion().setFromEuler( sprintEuler ),
			adsQuat: new THREE.Quaternion().setFromEuler(
				new THREE.Euler().fromArray( cfg.adsRot || [ 0, 0, 0 ] ) ),
			adsDistance: cfg.adsDistance ?? 0.30,
			adsTime: cfg.adsTime ?? 0.20,
			recoilScale: cfg.recoilScale ?? 1,
			boltTravel: cfg.boltTravel ?? 0.024,
			magDrop: cfg.magDrop ?? 0.34,
			chTravel: cfg.chTravel ?? 0.030,
			parts: built.parts || {},
			restPos: {},
		};
		for ( const k in entry.parts ) {
			const p = entry.parts[ k ];
			if ( p ) entry.restPos[ k ] = p.position.clone();
		}
		g.visible = false;
		holder.add( g );
		entries.set( id, entry );
		solveHipFraming( entry );
		return entry;
	}

	/**
	 * Dev helper: NDC bounds of a weapon in its resting hip pose, plus whether
	 * it clears the hard framing limits. Callable from the console / harness.
	 * @param {string} [id]  defaults to the equipped weapon
	 */
	function debugFraming( id ) {
		const e = id ? entries.get( id ) : current;
		if ( ! e ) return null;
		const b = projectBounds( e, e.hipQuat, e.hipPos, _bounds );
		const fits = b.behind === 0 &&
			b.xMin >= FRAME_LIMIT.xMin && b.xMax <= FRAME_LIMIT.xMax &&
			b.yMin >= FRAME_LIMIT.yMin && b.yMax <= FRAME_LIMIT.yMax;
		return {
			id: e.id,
			xMin: +b.xMin.toFixed( 4 ), xMax: +b.xMax.toFixed( 4 ),
			yMin: +b.yMin.toFixed( 4 ), yMax: +b.yMax.toFixed( 4 ),
			muzzleX: +b.muzzleX.toFixed( 4 ), muzzleY: +b.muzzleY.toFixed( 4 ),
			gripDistance: +( - e.hipPos.z ).toFixed( 4 ),
			meanDepth: +b.depth.toFixed( 4 ),
			behindLens: b.behind,
			fov: engine.viewCamera.fov,
			aspect: +engine.viewCamera.aspect.toFixed( 4 ),
			fits,
		};
	}

	/** NDC bounds for every registered weapon. */
	function debugFramingAll() {
		const out = {};
		for ( const id of entries.keys() ) out[ id ] = debugFraming( id );
		return out;
	}

	// NDC-x depends on aspect, so a window resize invalidates the framing.
	engine.onResize( () => {
		for ( const e of entries.values() ) solveHipFraming( e );
	} );

	// ---------------------------------------------------------------- equip

	function setWeaponImmediate( id ) {
		const e = entries.get( id );
		if ( ! e ) return;
		if ( current ) current.group.visible = false;
		current = e;
		current.group.visible = true;
		resetSprings();
	}

	/** Lower the current weapon, swap, raise the new one. */
	function equip( id, opts = {} ) {
		if ( ! entries.has( id ) ) return;
		if ( ! current || opts.instant ) {
			setWeaponImmediate( id );
			lowerT = opts.instant ? 0 : 1;
			lowerTarget = 0;
			lowerSpeed = 9;
			pending = null;
			return;
		}
		if ( current.id === id && ! pending ) return;
		pending = { id, onSwap: opts.onSwap || null };
		lowerTarget = 1;
		lowerSpeed = 1 / Math.max( 0.05, opts.lowerTime ?? 0.15 );
	}

	function resetSprings() {
		rPos.set( 0, 0, 0 ); rVel.set( 0, 0, 0 );
		rRot.set( 0, 0, 0 ); rRotVel.set( 0, 0, 0 );
		swayX = swayY = swayVX = swayVY = 0;
		boltT = 0; triggerT = 0;
		reloadTime = - 1;
	}

	// ---------------------------------------------------------------- feedback

	/** @param {number} strength ~1 for a standard shot. */
	function fire( strength = 1 ) {
		if ( ! current ) return;
		const s = strength * current.recoilScale;
		const aimDamp = 1 - adsT * 0.42;
		rVel.z += 2.15 * s * aimDamp;                     // straight back into the shoulder
		rVel.y += ( 0.38 + Math.random() * 0.30 ) * s * aimDamp;
		rVel.x += ( Math.random() - 0.5 ) * 0.70 * s * aimDamp;
		rRotVel.x += ( 5.6 + Math.random() * 1.7 ) * s * aimDamp;   // muzzle rise
		rRotVel.y += ( Math.random() - 0.5 ) * 3.1 * s * aimDamp;
		rRotVel.z += ( Math.random() - 0.5 ) * 4.4 * s * aimDamp;
		boltT = 1;
		triggerT = 1;
	}

	function startReload( duration, empty ) {
		reloadTime = 0;
		reloadDur = Math.max( 0.2, duration );
		reloadEmpty = !! empty;
	}

	function cancelReload() { reloadTime = - 1; }

	function setAds( active ) { adsTarget = active ? 1 : 0; }

	// ---------------------------------------------------------------- update

	/**
	 * @param {number} dt
	 * @param {object} ctx { speed, maxSpeed, sprint01, crouch01, grounded,
	 *                       lookX, lookY, moving }
	 */
	function update( dt, ctx ) {

		syncEnvExposure();

		// --- weapon switch ------------------------------------------------
		if ( lowerTarget > lowerT ) lowerT = Math.min( 1, lowerT + dt * lowerSpeed );
		else if ( lowerTarget < lowerT ) lowerT = Math.max( 0, lowerT - dt * lowerSpeed );
		if ( pending && lowerT >= 0.999 ) {
			setWeaponImmediate( pending.id );
			if ( pending.onSwap ) pending.onSwap( pending.id );
			pending = null;
			lowerTarget = 0;
			lowerSpeed = 1 / 0.18;
		}
		if ( ! current ) return;

		// --- ADS spring (snappy, slight overshoot) ---------------------------
		const blockAds = reloadTime >= 0 || lowerT > 0.05;
		const at = blockAds ? 0 : adsTarget;
		const w = 4.8 / current.adsTime;
		adsVel += ( ( at - adsT ) * w * w - adsVel * ( 2 * 0.72 * w ) ) * dt;
		adsT += adsVel * dt;
		if ( adsT < 0 ) { adsT = 0; if ( adsVel < 0 ) adsVel = 0; }
		if ( adsT > 1.08 ) { adsT = 1.08; if ( adsVel > 0 ) adsVel = 0; }

		const adsDampF = 1 - Math.min( 1, adsT ) * 0.86;

		// --- sprint blend ------------------------------------------------------
		sprintBlend = damp( sprintBlend, ( ctx.sprint01 || 0 ) * ( 1 - Math.min( 1, adsT ) ), 10, dt );

		// --- sway from mouse motion --------------------------------------------
		const lookX = ctx.lookX || 0, lookY = ctx.lookY || 0;
		swayVX += lookX * 34;
		swayVY += lookY * 26;
		const K = 150, C = 17;
		swayVX += ( - swayX * K - swayVX * C ) * dt;
		swayVY += ( - swayY * K - swayVY * C ) * dt;
		swayX = clamp( swayX + swayVX * dt, - 0.085, 0.085 );
		swayY = clamp( swayY + swayVY * dt, - 0.070, 0.070 );
		leanRoll = damp( leanRoll, clamp( - lookX * 3.0, - 0.10, 0.10 ), 9, dt );

		// --- bob + breathing ------------------------------------------------------
		const speed = ctx.speed || 0;
		const maxSpeed = ctx.maxSpeed || 7.2;
		bobPhase += speed * dt * 3.05;
		if ( bobPhase > Math.PI * 200 ) bobPhase -= Math.PI * 200;
		const grounded = ctx.grounded !== false;
		bobAmp = damp( bobAmp, grounded ? clamp( speed / maxSpeed, 0, 1 ) : 0, 7, dt );
		breathe += dt;

		const bobBlend = bobAmp * adsDampF;
		const bobX = Math.sin( bobPhase ) * 0.020 * bobBlend;
		const bobY = ( Math.sin( bobPhase * 2 ) * 0.014 - Math.abs( Math.sin( bobPhase ) ) * 0.006 ) * bobBlend;
		const bobRoll = Math.sin( bobPhase ) * 0.045 * bobBlend;
		const bobPitch = Math.sin( bobPhase * 2 + 0.6 ) * 0.030 * bobBlend;

		const idle = ( 1 - bobAmp ) * adsDampF;
		const brX = Math.sin( breathe * 0.85 ) * 0.0042 * idle;
		const brY = Math.sin( breathe * 1.70 ) * 0.0030 * idle;
		const brR = Math.sin( breathe * 0.62 + 1.1 ) * 0.012 * idle;

		// --- recoil springs -----------------------------------------------------
		const RK = 168, RC = 19;
		rVel.x += ( - rPos.x * RK - rVel.x * RC ) * dt;
		rVel.y += ( - rPos.y * RK - rVel.y * RC ) * dt;
		rVel.z += ( - rPos.z * RK - rVel.z * RC ) * dt;
		rPos.addScaledVector( rVel, dt );
		const RKR = 190, RCR = 20;
		rRotVel.x += ( - rRot.x * RKR - rRotVel.x * RCR ) * dt;
		rRotVel.y += ( - rRot.y * RKR - rRotVel.y * RCR ) * dt;
		rRotVel.z += ( - rRot.z * RKR - rRotVel.z * RCR ) * dt;
		rRot.addScaledVector( rRotVel, dt );
		// scale into sane metres / radians
		const kickX = clamp( rPos.x * 0.012, - 0.05, 0.05 );
		const kickY = clamp( rPos.y * 0.012, - 0.05, 0.05 );
		const kickZ = clamp( rPos.z * 0.016, - 0.02, 0.075 );
		const rotX = clamp( rRot.x * 0.020, - 0.05, 0.30 );
		const rotY = clamp( rRot.y * 0.014, - 0.14, 0.14 );
		const rotZ = clamp( rRot.z * 0.016, - 0.20, 0.20 );

		// --- reload timeline ------------------------------------------------------
		let rlX = 0, rlY = 0, rlZ = 0, rlRX = 0, rlRY = 0, rlRZ = 0;
		let magY = 0, magR = 0, chT = 0;
		if ( reloadTime >= 0 ) {
			reloadTime += dt;
			const u = reloadTime / reloadDur;
			if ( u >= 1 ) {
				reloadTime = - 1;
			} else {
				rlZ = track( u, RL_POS_Z );
				rlX = track( u, RL_POS_X );
				rlY = track( u, RL_POS_Y );
				rlRX = track( u, RL_TILT_X );
				rlRY = track( u, RL_TILT_Y );
				rlRZ = track( u, RL_TILT_Z );
				magY = track( u, RL_MAG_Y ) * current.magDrop;
				magR = track( u, RL_MAG_R );
				if ( reloadEmpty ) chT = track( u, RL_CH );
				const punch = track( u, RL_PUNCH );
				rlY -= punch * 0.016;
				rlRX -= punch * 0.09;
			}
		}

		// --- crouch settle: the weapon sinks and tucks in as you go low --------------
		crouchSettle = damp( crouchSettle, ( ctx.crouch01 || 0 ) * adsDampF, 8, dt );
		const crX = crouchSettle * 0.016;
		const crY = crouchSettle * - 0.020;
		const crZ = crouchSettle * 0.014;
		const crRZ = crouchSettle * 0.055;

		// --- weapon switch offset ---------------------------------------------------
		const lowT = lowerT * lowerT;
		const lowY = - 0.24 * lowT;
		const lowZ = 0.10 * lowT;
		const lowRX = - 0.95 * lowT;
		const lowRZ = 0.30 * lowT;

		// --- base pose blend -----------------------------------------------------------
		_pBase.copy( current.hipPos ).lerp( current.sprintPos, sprintBlend );
		_qBase.copy( current.hipQuat ).slerp( current.sprintQuat, sprintBlend );

		if ( adsT > 0.0005 ) {
			_qAds.copy( current.adsQuat );
			_qBase.slerp( _qAds, Math.min( 1, adsT ) );

			// Solve the ADS position: place the weapon so sightPoint lands on the
			// optical axis of viewCamera at adsDistance, using the *current*
			// blended orientation so the convergence is exact at adsT == 1.
			engine.viewCamera.updateMatrixWorld();
			holder.updateMatrixWorld();
			_target.set( 0, 0, - current.adsDistance );
			_target.applyMatrix4( engine.viewCamera.matrixWorld );
			_mat.copy( holder.matrixWorld ).invert();
			_target.applyMatrix4( _mat );
			_v.copy( current.sightLocal ).applyQuaternion( _qBase );
			_pAds.copy( _target ).sub( _v );
			_pBase.lerp( _pAds, Math.min( 1, adsT ) );
		}

		// --- additive offsets --------------------------------------------------------------
		_off.set(
			swayX * - 0.36 * adsDampF + bobX + brX + kickX + rlX + crX,
			swayY * - 0.30 * adsDampF + bobY + brY + kickY + rlY + lowY + crY,
			kickZ + rlZ + lowZ + crZ,
		);
		_eOff.set(
			swayY * 1.05 * adsDampF + bobPitch + rotX + rlRX + lowRX,
			swayX * 1.35 * adsDampF + rotY + rlRY,
			leanRoll * adsDampF + bobRoll + brR + rotZ + rlRZ + lowRZ + crRZ,
		);
		_qOff.setFromEuler( _eOff );

		const g = current.group;
		g.position.copy( _pBase ).add( _off );
		g.quaternion.copy( _qBase ).multiply( _qOff );

		// --- animated parts -------------------------------------------------------------------
		const parts = current.parts;
		boltT = Math.max( 0, boltT - dt * 22 );
		triggerT = Math.max( 0, triggerT - dt * 12 );
		const boltCurve = boltT > 0.55 ? ( 1 - boltT ) / 0.45 : boltT / 0.55;

		const recip = parts.slide || parts.bolt;
		if ( recip ) {
			const rest = current.restPos[ parts.slide ? 'slide' : 'bolt' ];
			recip.position.z = rest.z + boltCurve * current.boltTravel + chT * current.chTravel;
		}
		if ( parts.chargingHandle ) {
			const rest = current.restPos.chargingHandle;
			parts.chargingHandle.position.z = rest.z + chT * current.chTravel + boltCurve * current.boltTravel * 0.25;
		}
		if ( parts.mag ) {
			const rest = current.restPos.mag;
			parts.mag.position.y = rest.y + magY;
			parts.mag.position.z = rest.z + magR * 0.05;
			parts.mag.rotation.x = magR * 0.55;
			parts.mag.rotation.z = magR * 0.30;
			parts.mag.visible = magY > - current.magDrop * 0.98;
		}
		if ( parts.trigger ) {
			parts.trigger.rotation.x = - triggerT * 0.34;
		}
	}

	// ---------------------------------------------------------------- queries

	/** Muzzle position in viewScene space (for view-layer VFX). */
	function getMuzzleView( target ) {
		if ( ! current ) return target.set( 0, 0, - 1 );
		return current.built.muzzleTip.getWorldPosition( target );
	}

	/**
	 * Map a point from viewCamera space into world space so that it *projects to
	 * the same pixel* through the world camera.
	 *
	 * The two cameras deliberately run different FOVs (48 vs the world FOV, which
	 * also breathes with sprint/ADS kicks), so copying coordinates across
	 * verbatim would land world VFX beside the rendered barrel rather than on it.
	 * Converting through NDC keeps flash, tracer and shells pinned to the muzzle
	 * no matter what either lens is doing.
	 */
	function viewToWorldOnScreen( target ) {
		const vc = engine.viewCamera, wc = engine.camera;
		const d = Math.max( 0.01, - target.z );
		const tanVv = Math.tan( THREE.MathUtils.degToRad( vc.fov ) * 0.5 );
		const ndcX = target.x / ( d * tanVv * vc.aspect );
		const ndcY = target.y / ( d * tanVv );
		const tanVw = Math.tan( THREE.MathUtils.degToRad( wc.fov ) * 0.5 );
		target.set( ndcX * d * tanVw * wc.aspect, ndcY * d * tanVw, - d );
		wc.updateMatrixWorld();
		return target.applyMatrix4( wc.matrixWorld );
	}

	/** Muzzle position mapped into world space (for tracers / world VFX). */
	function getMuzzleWorld( target ) {
		getMuzzleView( target );
		engine.viewCamera.updateMatrixWorld();
		_mat.copy( engine.viewCamera.matrixWorld ).invert();
		target.applyMatrix4( _mat );                 // -> viewCamera space
		return viewToWorldOnScreen( target );
	}

	/**
	 * Optic centre in viewScene space. At full ADS this must sit on the optical
	 * axis of viewCamera — it is the thing the ADS solve is solving for, so
	 * exposing it lets the framing be checked rather than trusted.
	 */
	function getSightView( target ) {
		if ( ! current ) return target.set( 0, 0, - 1 );
		return current.built.sightPoint.getWorldPosition( target );
	}

	function getEjectView( target ) {
		if ( ! current ) return target.set( 0, 0, - 1 );
		return current.built.ejectPort.getWorldPosition( target );
	}

	function getEjectWorld( target ) {
		getEjectView( target );
		engine.viewCamera.updateMatrixWorld();
		_mat.copy( engine.viewCamera.matrixWorld ).invert();
		target.applyMatrix4( _mat );
		return viewToWorldOnScreen( target );
	}

	/** Weapon forward axis in viewScene space (for view-layer muzzle VFX). */
	function getForwardView( target ) {
		if ( ! current ) return target.set( 0, 0, - 1 );
		current.group.updateMatrixWorld();
		target.setFromMatrixColumn( current.group.matrixWorld, 2 ).negate().normalize();
		return target;
	}

	/** World-space right vector of the weapon (shell ejection direction). */
	function getRightWorld( target ) {
		engine.camera.updateMatrixWorld();
		target.setFromMatrixColumn( engine.camera.matrixWorld, 0 ).normalize();
		return target;
	}

	function getForwardWorld( target ) {
		engine.camera.updateMatrixWorld();
		target.setFromMatrixColumn( engine.camera.matrixWorld, 2 ).negate().normalize();
		return target;
	}

	function dispose() {
		for ( const e of entries.values() ) holder.remove( e.group );
		engine.viewRoot.remove( holder );
		entries.clear();
		current = null;
	}

	return {
		root: holder,
		register,
		equip,
		update,
		fire,
		startReload,
		cancelReload,
		setAds,
		getMuzzleView,
		getMuzzleWorld,
		getSightView,
		getEjectView,
		getEjectWorld,
		getRightWorld,
		getForwardWorld,
		getForwardView,
		debugFraming,
		debugFramingAll,
		dispose,
		get adsProgress() { return Math.min( 1, adsT ); },
		get adsRaw() { return adsT; },
		get switching() { return pending !== null || lowerT > 0.02; },
		get currentId() { return current ? current.id : null; },
		get reloading() { return reloadTime >= 0; },
	};
}

export default createViewmodel;
