import * as THREE from 'three';
import { engine } from '../core/engine.js';
import { input } from '../core/input.js';
import { bus } from '../core/events.js';
import { settings } from '../core/settings.js';
import { buildRifle, buildPistol, buildSMG } from './weaponModels.js';
import { createViewmodel } from './viewmodel.js';
import { createHitscan, falloffScale } from '../combat/hitscan.js';

/**
 * OVERPRESSURE — weapon system.
 *
 * Three originals with distinct handling. Fire timing carries its remainder
 * across frames so the cyclic rate is exact at any framerate; recoil is driven
 * by a deterministic per-weapon pattern table (learnable) plus a small random
 * jitter, applied to the real aim through player.addRecoil() with only part of
 * it springing back — the rest is permanent aim punch you have to pull down.
 */

const DEG = Math.PI / 180;

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _spread = new THREE.Vector3();
const _muzzleW = new THREE.Vector3();
const _muzzleV = new THREE.Vector3();
const _ejectW = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _end = new THREE.Vector3();

function clamp( v, a, b ) { return v < a ? a : v > b ? b : v; }

// ---------------------------------------------------------------- recoil patterns
// Degrees per shot. +pitch = muzzle climbs, +yaw = drifts right on screen.

const PATTERN_VK7 = [
	{ pitch: 0.62, yaw: 0.05 }, { pitch: 0.70, yaw: - 0.04 }, { pitch: 0.75, yaw: 0.08 },
	{ pitch: 0.72, yaw: 0.13 }, { pitch: 0.68, yaw: 0.21 }, { pitch: 0.60, yaw: 0.31 },
	{ pitch: 0.55, yaw: 0.43 }, { pitch: 0.50, yaw: 0.51 }, { pitch: 0.45, yaw: 0.56 },
	{ pitch: 0.41, yaw: 0.52 }, { pitch: 0.37, yaw: 0.40 }, { pitch: 0.35, yaw: 0.17 },
	{ pitch: 0.33, yaw: - 0.13 }, { pitch: 0.31, yaw: - 0.38 }, { pitch: 0.30, yaw: - 0.55 },
	{ pitch: 0.29, yaw: - 0.62 }, { pitch: 0.28, yaw: - 0.57 }, { pitch: 0.27, yaw: - 0.41 },
	{ pitch: 0.27, yaw: - 0.17 }, { pitch: 0.26, yaw: 0.11 }, { pitch: 0.26, yaw: 0.35 },
	{ pitch: 0.25, yaw: 0.50 }, { pitch: 0.25, yaw: 0.55 }, { pitch: 0.24, yaw: 0.47 },
	{ pitch: 0.24, yaw: 0.29 }, { pitch: 0.24, yaw: 0.04 }, { pitch: 0.23, yaw: - 0.23 },
	{ pitch: 0.23, yaw: - 0.43 }, { pitch: 0.23, yaw: - 0.51 }, { pitch: 0.23, yaw: - 0.44 },
];

const PATTERN_RG9 = [
	{ pitch: 1.15, yaw: 0.10 }, { pitch: 1.06, yaw: - 0.15 }, { pitch: 1.10, yaw: 0.17 },
	{ pitch: 1.00, yaw: - 0.11 }, { pitch: 0.96, yaw: 0.13 }, { pitch: 0.92, yaw: - 0.09 },
];

const PATTERN_SR12 = [
	{ pitch: 0.34, yaw: 0.04 }, { pitch: 0.36, yaw: - 0.06 }, { pitch: 0.35, yaw: 0.10 },
	{ pitch: 0.33, yaw: 0.18 }, { pitch: 0.31, yaw: 0.26 }, { pitch: 0.29, yaw: 0.30 },
	{ pitch: 0.28, yaw: 0.24 }, { pitch: 0.27, yaw: 0.08 }, { pitch: 0.26, yaw: - 0.14 },
	{ pitch: 0.25, yaw: - 0.30 }, { pitch: 0.24, yaw: - 0.36 }, { pitch: 0.24, yaw: - 0.30 },
	{ pitch: 0.23, yaw: - 0.12 }, { pitch: 0.23, yaw: 0.12 }, { pitch: 0.22, yaw: 0.30 },
	{ pitch: 0.22, yaw: 0.36 }, { pitch: 0.22, yaw: 0.26 }, { pitch: 0.21, yaw: 0.02 },
	{ pitch: 0.21, yaw: - 0.22 }, { pitch: 0.21, yaw: - 0.34 },
];

// ---------------------------------------------------------------- weapon defs

const DEFS = [
	{
		id: 'vk7',
		name: 'VK-7 VECTOR RIFLE',
		build: buildRifle,
		fireMode: 'auto',
		rpm: 700,
		magSize: 30,
		reserveMax: 210,
		damage: 26,
		headMult: 2.1,
		limbMult: 0.75,
		falloff: { start: 30, end: 78, min: 0.55 },
		range: 320,
		penetrate: true,
		spreadHip: 0.60,
		spreadAds: 0.09,
		spreadMove: 0.85,
		spreadAir: 1.9,
		bloomPerShot: 0.115,
		bloomMax: 1.55,
		bloomRecover: 2.6,
		pattern: PATTERN_VK7,
		recoilJitter: 0.075,
		recoilPersist: 0.32,
		adsTime: 0.20,
		adsFovScale: 0.72,
		reloadTactical: 2.15,
		reloadEmpty: 2.90,
		shake: 0.085,
		fovKick: 0.85,
		vm: {
			// the rifle is the biggest read on screen: it fills the lower-right
			// third, muzzle running up toward centre
			frame: { xMin: - 0.03, xMax: 0.95, yMin: - 0.94, yMax: 0.28, muzzleX: 0.20, muzzleY: - 0.05 },
			hipRot: [ 0.020, - 0.060, 0.026 ],
			sprintOffset: [ 0.045, - 0.062, 0.098 ], sprintRot: [ - 0.30, 0.30, - 0.44 ],
			adsDistance: 0.285, adsTime: 0.20, recoilScale: 1.0,
			boltTravel: 0.026, chTravel: 0.034, magDrop: 0.36,
		},
	},
	{
		id: 'rg9',
		name: 'RG-9 SIDEARM',
		build: buildPistol,
		fireMode: 'semi',
		rpm: 430,
		magSize: 12,
		reserveMax: 60,
		damage: 34,
		headMult: 2.1,
		limbMult: 0.75,
		falloff: { start: 16, end: 46, min: 0.45 },
		range: 220,
		penetrate: false,
		spreadHip: 1.05,
		spreadAds: 0.11,
		spreadMove: 1.1,
		spreadAir: 2.4,
		bloomPerShot: 0.34,
		bloomMax: 2.0,
		bloomRecover: 4.4,
		pattern: PATTERN_RG9,
		recoilJitter: 0.11,
		recoilPersist: 0.42,
		adsTime: 0.14,
		adsFovScale: 0.82,
		reloadTactical: 1.55,
		reloadEmpty: 2.05,
		shake: 0.095,
		fovKick: 1.05,
		vm: {
			// a sidearm must read as a sidearm: markedly smaller footprint and
			// carried lower than the rifle
			frame: { xMin: 0.16, xMax: 0.86, yMin: - 0.90, yMax: - 0.06, muzzleX: 0.32, muzzleY: - 0.26 },
			hipRot: [ 0.030, - 0.086, 0.030 ],
			sprintOffset: [ 0.042, - 0.058, 0.090 ], sprintRot: [ - 0.32, 0.34, - 0.46 ],
			adsDistance: 0.335, adsTime: 0.14, recoilScale: 1.25,
			boltTravel: 0.030, chTravel: 0.030, magDrop: 0.30,
		},
	},
	{
		id: 'sr12',
		name: 'SR-12 COMPACT SMG',
		build: buildSMG,
		fireMode: 'auto',
		rpm: 950,
		magSize: 32,
		reserveMax: 240,
		damage: 19,
		headMult: 2.1,
		limbMult: 0.75,
		falloff: { start: 18, end: 52, min: 0.42 },
		range: 260,
		penetrate: true,
		spreadHip: 1.30,
		spreadAds: 0.28,
		spreadMove: 0.62,
		spreadAir: 1.7,
		bloomPerShot: 0.085,
		bloomMax: 1.85,
		bloomRecover: 3.1,
		pattern: PATTERN_SR12,
		recoilJitter: 0.09,
		recoilPersist: 0.26,
		adsTime: 0.17,
		adsFovScale: 0.80,
		reloadTactical: 1.85,
		reloadEmpty: 2.45,
		shake: 0.055,
		fovKick: 0.55,
		vm: {
			// compact: between the rifle and the sidearm
			frame: { xMin: 0.03, xMax: 0.92, yMin: - 0.92, yMax: 0.18, muzzleX: 0.24, muzzleY: - 0.10 },
			hipRot: [ 0.022, - 0.070, 0.028 ],
			sprintOffset: [ 0.044, - 0.060, 0.094 ], sprintRot: [ - 0.30, 0.32, - 0.45 ],
			adsDistance: 0.295, adsTime: 0.17, recoilScale: 0.78,
			boltTravel: 0.022, chTravel: 0.026, magDrop: 0.32,
		},
	},
];

/**
 * @param {object} world  World from buildMap()
 * @param {object} player createPlayer() instance
 * @param {object} deps   { vfx, audio, decals, enemies } — all optional
 */
export function createWeapons( world, player, deps = {} ) {

	const viewmodel = createViewmodel( deps );
	const hitscan = createHitscan( world, deps );

	// --- build runtime weapons ------------------------------------------
	const list = DEFS.map( ( def ) => {
		const built = def.build();
		viewmodel.register( def.id, built, {
			frame: def.vm.frame,
			hipRot: def.vm.hipRot,
			sprintOffset: def.vm.sprintOffset,
			sprintRot: def.vm.sprintRot,
			adsDistance: def.vm.adsDistance,
			adsTime: def.vm.adsTime,
			recoilScale: def.vm.recoilScale,
			boltTravel: def.vm.boltTravel,
			chTravel: def.vm.chTravel,
			magDrop: def.vm.magDrop,
		} );
		return {
			def,
			built,
			id: def.id,
			name: def.name,
			ammo: def.magSize,
			reserve: def.reserveMax,
			bloom: 0,
			shotIndex: 0,
			cooldown: 0,
		};
	} );

	let index = 0;
	let lastIndex = 1;
	let current = list[ index ];

	// --- state ------------------------------------------------------------
	let reloading = false;
	let reloadTimer = 0;
	let reloadDur = 0;
	let reloadWasEmpty = false;
	let adsActive = false;
	let adsToggleState = false;
	let sprintOut = 0;
	let sinceShot = 99;
	let semiLatch = false;
	let switching = false;
	let adsEmitted = false;
	let dryTimer = 0;
	let adsForced = null;   // debug/screenshot override

	// camera visual recoil springs (separate from and smaller than the viewmodel's)
	let cRotX = 0, cRotY = 0, cRotZ = 0, cKickZ = 0;
	let cVelX = 0, cVelY = 0, cVelZ = 0, cVelK = 0;

	// ---------------------------------------------------------------- helpers

	function interval( w ) { return 60 / w.def.rpm; }

	function emitEquipped( w ) {
		bus.emit( 'weapon:equipped', {
			id: w.id, name: w.name, ammo: w.ammo, reserve: w.reserve,
			magSize: w.def.magSize, fireMode: w.def.fireMode,
		} );
	}

	function maxSpreadOf( w ) {
		return w.def.spreadHip + w.def.bloomMax + w.def.spreadMove;
	}

	function currentSpreadDeg( w ) {
		const ads = viewmodel.adsProgress;
		const base = w.def.spreadHip + ( w.def.spreadAds - w.def.spreadHip ) * ads;
		const speed01 = clamp( player.state.speed / 7.2, 0, 1 );
		let s = base + speed01 * w.def.spreadMove * ( 1 - ads * 0.55 ) + w.bloom;
		if ( ! player.state.grounded ) s += w.def.spreadAir;
		if ( player.state.crouching ) s *= 0.82;
		return s;
	}

	// ---------------------------------------------------------------- switching

	function switchTo( i, instant ) {
		if ( i === index || i < 0 || i >= list.length ) return;
		if ( switching ) return;
		if ( reloading ) cancelReload();
		lastIndex = index;
		index = i;
		switching = true;
		viewmodel.equip( list[ i ].id, {
			instant: !! instant,
			lowerTime: 0.15,
			onSwap: () => {
				current = list[ index ];
				switching = false;
				current.bloom = 0;
				current.shotIndex = 0;
				current.cooldown = 0;
				emitEquipped( current );
			},
		} );
		if ( instant ) {
			current = list[ i ];
			switching = false;
			emitEquipped( current );
		}
	}

	function cycle( dir ) {
		let i = ( index + dir ) % list.length;
		if ( i < 0 ) i += list.length;
		switchTo( i );
	}

	// ---------------------------------------------------------------- reload

	function startReload() {
		const w = current;
		if ( reloading || switching ) return;
		if ( w.reserve <= 0 ) return;
		if ( w.ammo >= w.def.magSize + ( w.ammo > 0 ? 1 : 0 ) ) return;
		if ( w.ammo >= w.def.magSize ) return;
		reloading = true;
		reloadWasEmpty = w.ammo <= 0;
		reloadDur = reloadWasEmpty ? w.def.reloadEmpty : w.def.reloadTactical;
		reloadTimer = 0;
		viewmodel.startReload( reloadDur, reloadWasEmpty );
		bus.emit( 'weapon:reloadStart', { id: w.id, duration: reloadDur } );
	}

	function finishReload() {
		const w = current;
		reloading = false;
		// a tactical reload keeps the chambered round
		const capacity = w.def.magSize + ( reloadWasEmpty ? 0 : ( w.ammo > 0 ? 1 : 0 ) );
		const need = Math.max( 0, capacity - w.ammo );
		const take = Math.min( need, w.reserve );
		w.ammo += take;
		w.reserve -= take;
		bus.emit( 'weapon:reloadEnd', { id: w.id, ammo: w.ammo, reserve: w.reserve } );
	}

	function cancelReload() {
		if ( ! reloading ) return;
		reloading = false;
		viewmodel.cancelReload();
		bus.emit( 'weapon:reloadEnd', { id: current.id, ammo: current.ammo, reserve: current.reserve } );
	}

	// ---------------------------------------------------------------- firing

	function applyRecoil( w ) {
		const p = w.def.pattern;
		const step = p[ Math.min( Math.floor( w.shotIndex ), p.length - 1 ) ];
		const ads = viewmodel.adsProgress;
		let scale = 1 - ads * 0.22;
		if ( player.state.crouching ) scale *= 0.86;
		if ( ! player.state.grounded ) scale *= 1.35;

		const jit = w.def.recoilJitter;
		const pitchDeg = ( step.pitch + ( Math.random() - 0.5 ) * jit ) * scale;
		const yawDeg = ( step.yaw + ( Math.random() - 0.5 ) * jit * 2.2 ) * scale;

		// yaw is inverted: the controller's +yaw turns left, the pattern's +yaw is right
		player.addRecoil( pitchDeg * DEG, - yawDeg * DEG, w.def.recoilPersist );

		// visual-only camera kick
		cVelX += pitchDeg * DEG * 5.2;
		cVelY += - yawDeg * DEG * 4.0;
		cVelZ += ( Math.random() - 0.5 ) * 0.9;
		cVelK += 0.42 * scale;

		w.shotIndex ++;
	}

	function shoot() {
		const w = current;
		const def = w.def;

		w.ammo --;
		sinceShot = 0;
		semiLatch = true;

		// ---- aim ray from the camera centre ----------------------------
		engine.camera.updateMatrixWorld();
		engine.camera.getWorldPosition( _origin );
		engine.camera.getWorldDirection( _dir );
		const spreadRad = currentSpreadDeg( w ) * DEG;
		hitscan.applySpread( _spread, _dir, spreadRad, engine.camera );

		const count = hitscan.cast( _origin, _spread, {
			maxDistance: def.range,
			penetrate: def.penetrate,
		} );

		// ---- viewmodel + camera feedback --------------------------------
		viewmodel.fire( 1 );
		applyRecoil( w );
		engine.addShake( def.shake * ( 1 - viewmodel.adsProgress * 0.35 ) );
		engine.addFovKick( def.fovKick * ( 1 - viewmodel.adsProgress * 0.4 ) );

		w.bloom = Math.min( def.bloomMax, w.bloom + def.bloomPerShot );

		// ---- muzzle / shell VFX ------------------------------------------
		viewmodel.getMuzzleView( _muzzleV );
		viewmodel.getMuzzleWorld( _muzzleW );
		viewmodel.getForwardView( _fwd );
		viewmodel.getRightWorld( _right );
		viewmodel.getEjectWorld( _ejectW );

		const flashScale = 0.9 + Math.random() * 0.35;
		deps.vfx?.muzzleFlash?.( _muzzleV, _fwd, flashScale, true );
		deps.vfx?.muzzleFlash?.( _muzzleW, _spread, flashScale * 0.85, false );
		deps.vfx?.shellEject?.( _ejectW, _right );

		// ---- resolve hits -------------------------------------------------
		let endSet = false;
		for ( let i = 0; i < count; i ++ ) {
			const hit = hitscan.results[ i ];
			if ( ! hit.hit ) break;
			endSet = true;

			if ( hit.enemy ) {
				const headshot = hit.bodyPart === 'head';
				const partMult = headshot ? def.headMult : ( hit.bodyPart === 'limb' ? def.limbMult : 1 );
				const dmg = def.damage * partMult
					* falloffScale( hit.distance, def.falloff )
					* hit.damageScale;

				deps.vfx?.bloodImpact?.( hit.point, hit.normal );
				// enemies.damage() owns the hit:confirm emit — it is the only
				// place that knows whether the round was lethal
				deps.enemies?.damage?.( hit.enemy, dmg, {
					headshot, point: hit.point, normal: hit.normal, weapon: def.id,
				} );
			} else {
				deps.vfx?.impact?.( hit.point, hit.normal, hit.surface );
				deps.decals?.add?.( hit.point, hit.normal, hit.surface );
				bus.emit( 'hit:surface', {
					point: hit.point.clone(),
					normal: hit.normal.clone(),
					surface: hit.surface,
				} );
			}
			// only the last hit terminates the tracer
			_end.copy( hit.point );
		}
		if ( ! endSet ) _end.copy( _origin ).addScaledVector( _spread, def.range );

		deps.vfx?.tracer?.( _muzzleW, _end, 340 );

		bus.emit( 'weapon:fire', { id: w.id, ammo: w.ammo, reserve: w.reserve, silenced: false } );

		if ( w.ammo <= 0 ) {
			// auto-reload feels better than dry-clicking through a firefight
			startReload();
		}
	}

	function canShoot() {
		if ( ! player.state.alive ) return false;
		if ( reloading || switching ) return false;
		if ( sprintOut > 0 ) return false;
		return current.ammo > 0;
	}

	// ---------------------------------------------------------------- update

	function update( dt ) {

		const w = current;
		const def = w.def;
		const locked = input.locked;
		const alive = player.state.alive;

		sinceShot += dt;
		sprintOut = Math.max( 0, sprintOut - dt );

		// ---- input: switching -------------------------------------------
		if ( locked && alive ) {
			if ( input.pressed( 'Digit1' ) ) switchTo( 0 );
			else if ( input.pressed( 'Digit2' ) ) switchTo( 1 );
			else if ( input.pressed( 'Digit3' ) ) switchTo( 2 );
			else if ( input.pressed( 'KeyQ' ) ) switchTo( lastIndex );
			else if ( input.wheel !== 0 ) cycle( input.wheel > 0 ? 1 : - 1 );
			if ( input.pressed( 'KeyR' ) ) startReload();
		}

		// ---- input: ADS ---------------------------------------------------
		const adsBlocked = ! locked || ! alive || switching;
		if ( settings.adsToggle === true ) {
			if ( locked && alive && input.mousePressed( 2 ) ) adsToggleState = ! adsToggleState;
			adsActive = adsToggleState && ! adsBlocked;
		} else {
			adsActive = ! adsBlocked && input.mouseDown( 2 );
			adsToggleState = false;
		}
		if ( adsForced !== null ) adsActive = adsForced && ! switching;
		if ( adsActive && player.state.sprinting ) player.cancelSprint( 0.05 );
		viewmodel.setAds( adsActive );
		if ( adsActive !== adsEmitted ) {
			adsEmitted = adsActive;
			bus.emit( 'weapon:ads', { active: adsActive } );
		}

		// ---- input: trigger --------------------------------------------------
		const held = locked && alive && input.mouseDown( 0 );
		if ( ! input.mouseDown( 0 ) ) semiLatch = false;

		if ( held && ( player.state.sprinting || player.sprint01 > 0.15 ) ) {
			player.cancelSprint( 0.28 );
			if ( sprintOut <= 0 && sinceShot > 0.2 ) sprintOut = 0.12;
		}
		dryTimer -= dt;

		// ---- fire-rate accumulator -----------------------------------------
		w.cooldown -= dt;
		const iv = interval( w );
		if ( def.fireMode === 'auto' ) {
			if ( held ) {
				let guard = 0;
				while ( w.cooldown <= 0 && guard < 8 ) {
					if ( ! canShoot() ) {
						if ( ! reloading && ! switching && w.ammo <= 0 && sprintOut <= 0 && dryTimer <= 0 ) {
							dryTimer = 0.45;
							bus.emit( 'weapon:dry', { id: w.id } );
						}
						w.cooldown = 0;
						break;
					}
					shoot();
					w.cooldown += iv;
					guard ++;
					if ( current !== w ) break;   // reload/switch swapped under us
				}
			} else if ( w.cooldown < 0 ) {
				w.cooldown = 0;
			}
		} else {
			if ( held && ! semiLatchConsumed() ) {
				if ( w.cooldown <= 0 ) {
					if ( canShoot() ) {
						shoot();
						w.cooldown = iv;
					} else if ( ! reloading && ! switching && w.ammo <= 0 ) {
						if ( dryTimer <= 0 ) { dryTimer = 0.45; bus.emit( 'weapon:dry', { id: w.id } ); }
						w.cooldown = 0.22;
						startReload();
					}
				}
			}
			if ( w.cooldown < 0 ) w.cooldown = 0;
		}

		// ---- reload progression -----------------------------------------------
		if ( reloading ) {
			reloadTimer += dt;
			if ( reloadTimer >= reloadDur ) finishReload();
			if ( player.state.sprinting && reloadTimer < reloadDur * 0.55 ) cancelReload();
		} else {
			reloadTimer = 0;
		}

		// ---- spread recovery ----------------------------------------------------
		if ( sinceShot > 0.085 && w.bloom > 0 ) {
			w.bloom = Math.max( 0, w.bloom - def.bloomRecover * dt );
		}
		if ( sinceShot > 0.28 && w.shotIndex > 0 ) {
			w.shotIndex = Math.max( 0, w.shotIndex - dt * 11 );
		}

		// ---- camera visual recoil springs -----------------------------------------
		const K = 205, C = 23;
		cVelX += ( - cRotX * K - cVelX * C ) * dt;
		cVelY += ( - cRotY * K - cVelY * C ) * dt;
		cVelZ += ( - cRotZ * K * 0.6 - cVelZ * C ) * dt;
		cVelK += ( - cKickZ * K * 0.8 - cVelK * C ) * dt;
		cRotX += cVelX * dt; cRotY += cVelY * dt; cRotZ += cVelZ * dt; cKickZ += cVelK * dt;
		engine.setRecoilOffset(
			clamp( cRotX, - 0.02, 0.075 ),
			clamp( cRotY, - 0.05, 0.05 ),
			clamp( cRotZ * 0.02, - 0.03, 0.03 ),
			clamp( cKickZ * 0.02, - 0.004, 0.05 ),
		);

		// ---- drive the viewmodel + player aim state ---------------------------------
		viewmodel.update( dt, {
			speed: player.state.speed,
			maxSpeed: 7.2,
			sprint01: player.sprint01,
			crouch01: player.crouch01,
			grounded: player.state.grounded,
			lookX: player.look.x,
			lookY: player.look.y,
			moving: player.state.moving,
		} );

		// viewmodel.update() may have completed a weapon swap, so read `current`
		// again rather than the copy taken at the top of the frame
		const now = current;
		player.setAimState( adsActive, viewmodel.adsProgress, now.def.adsFovScale );

		// ---- crosshair feed --------------------------------------------------------------
		const value01 = clamp( currentSpreadDeg( now ) / maxSpreadOf( now ), 0, 1 );
		bus.emit( 'weapon:spread', { value01 } );
	}

	/** Semi-auto needs a fresh trigger pull for every shot. */
	function semiLatchConsumed() { return semiLatch; }

	// ---------------------------------------------------------------- public

	function giveAmmo( fraction = 1 ) {
		for ( const w of list ) {
			w.reserve = Math.min( w.def.reserveMax, Math.round( w.reserve + w.def.reserveMax * fraction ) );
		}
		emitEquipped( current );
		bus.emit( 'ui:toast', { text: 'AMMO RESUPPLY', sub: 'reserves topped up' } );
	}

	function reset() {
		for ( const w of list ) {
			w.ammo = w.def.magSize;
			w.reserve = w.def.reserveMax;
			w.bloom = 0;
			w.shotIndex = 0;
			w.cooldown = 0;
		}
		reloading = false;
		switching = false;
		adsActive = false;
		adsToggleState = false;
		index = 0;
		lastIndex = 1;
		current = list[ 0 ];
		viewmodel.equip( current.id, { instant: true } );
		viewmodel.setAds( false );
		emitEquipped( current );
	}

	/** Force ADS on/off (screenshot harness); pass null to return to input. */
	function setAds( on ) { adsForced = on === null ? null : !! on; }

	/** Fire a single round now, if the weapon is able to. Used by the debug harness. */
	function fire() {
		if ( ! canShoot() ) return false;
		shoot();
		current.cooldown = interval( current );
		return true;
	}

	// initial equip
	viewmodel.equip( current.id, { instant: true } );
	emitEquipped( current );
	bus.on( 'debug:fire', () => fire() );

	return {
		update,
		list,
		giveAmmo,
		reset,
		switchTo,
		startReload,
		setAds,
		fire,
		viewmodel,
		hitscan,
		get current() { return current; },
		get ads() { return adsActive; },
		get adsProgress() { return viewmodel.adsProgress; },
		get reloading() { return reloading; },
		get spread01() { return clamp( currentSpreadDeg( current ) / maxSpreadOf( current ), 0, 1 ); },
	};
}

export default createWeapons;
