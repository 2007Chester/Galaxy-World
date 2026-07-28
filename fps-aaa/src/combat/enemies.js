import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bus } from '../core/events.js';
import { engine } from '../core/engine.js';

/**
 * OVERPRESSURE — hostile infantry.
 *
 * One set of shared merged geometries is built at module init and reused by a
 * fixed pool of soldiers (only the materials are cloned, so bodies can fade
 * independently on death). Every soldier carries a hot red-orange visor and
 * chest lamp so the silhouette reads instantly at any distance.
 *
 * The AI is deliberately fair: it telegraphs before firing, has a human
 * reaction window (0.45-0.9s), fires visible tracers, and the squad shares a
 * hard incoming-DPS budget so a bad corner never deletes you instantly.
 */

const MAX_ENEMIES = 14;

// --- body metrics (metres, origin at the feet) -----------------------------
const HIP_Y = 0.92;
const SHOULDER_Y = 1.40;
const EYE_Y = 1.58;
const BODY_RADIUS = 0.34;

// --- AI tuning --------------------------------------------------------------
const VIEW_DISTANCE = 62;
const VIEW_COS = Math.cos( 1.15 );          // ~132 degree cone
const WALK_SPEED = 2.35;
const ADVANCE_SPEED = 4.05;
const LOS_INTERVAL = 0.17;
// Hard ceiling on incoming damage, shared by the whole squad. Now that idle
// soldiers go hunting the player instead of guarding a wall, far more of the
// squad is shooting at once, and the old 27/s deleted a stationary player in
// about seven seconds. 16/s against 100hp gives roughly six seconds of standing
// in the open — long enough to pick a fight and break contact, short enough that
// you cannot ignore it — and the wave scaling puts the pressure back later.
const SQUAD_DPS_CAP = 16;
const SQUAD_DPS_BURST = 26;
const SQUAD_DPS_PER_WAVE = 0.07;

const CLASS_NAMES = [ 'RIFLEMAN', 'BREACHER', 'MARKSMAN' ];

// --- scratch -----------------------------------------------------------------
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _target = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _rayHits = [];
const _m4 = new THREE.Matrix4();
const _eu = new THREE.Euler();
const _qt = new THREE.Quaternion();
const _sc = new THREE.Vector3( 1, 1, 1 );
const _pv = new THREE.Vector3();

function rnd( a, b ) { return a + Math.random() * ( b - a ); }
function clamp( v, a, b ) { return v < a ? a : v > b ? b : v; }
function damp( c, t, l, dt ) { return c + ( t - c ) * ( 1 - Math.exp( - l * dt ) ); }

// ---------------------------------------------------------------- geometry kit

function put( bucket, geo, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0 ) {
	_eu.set( rx, ry, rz );
	_qt.setFromEuler( _eu );
	_pv.set( px, py, pz );
	_sc.set( 1, 1, 1 );
	_m4.compose( _pv, _qt, _sc );
	geo.applyMatrix4( _m4 );
	bucket.push( geo.index ? geo.toNonIndexed() : geo );
}

function box( w, h, d ) { return new THREE.BoxGeometry( w, h, d ); }
function cyl( rt, rb, h, seg = 8 ) { return new THREE.CylinderGeometry( rt, rb, h, seg ); }

function bake( bucket, offsetY = 0, offsetX = 0, offsetZ = 0 ) {
	if ( ! bucket.length ) return null;
	const g = mergeGeometries( bucket, false );
	bucket.length = 0;
	if ( ! g ) return null;
	if ( offsetX || offsetY || offsetZ ) g.translate( - offsetX, - offsetY, - offsetZ );
	return g;
}

/**
 * Build the shared soldier geometry set exactly once.
 * Returns geometries expressed in their own pivot space so the pool can
 * animate them without touching vertex data.
 */
let SHARED = null;
function buildSharedGeometry() {
	if ( SHARED ) return SHARED;

	const body = [], glow = [], arms = [], leg = [];

	// ---- torso -----------------------------------------------------------
	put( body, box( 0.34, 0.20, 0.22 ), 0, HIP_Y + 0.06, 0 );              // pelvis
	put( body, box( 0.38, 0.30, 0.23 ), 0, HIP_Y + 0.26, 0 );              // abdomen
	put( body, box( 0.44, 0.30, 0.26 ), 0, HIP_Y + 0.50, 0 );              // chest
	put( body, box( 0.46, 0.34, 0.30 ), 0, HIP_Y + 0.44, - 0.01 );         // plate carrier
	put( body, box( 0.40, 0.06, 0.06 ), 0, HIP_Y + 0.30, - 0.15 );         // mag pouches
	put( body, box( 0.12, 0.10, 0.07 ), - 0.11, HIP_Y + 0.24, - 0.15 );
	put( body, box( 0.12, 0.10, 0.07 ), 0.11, HIP_Y + 0.24, - 0.15 );
	put( body, box( 0.30, 0.32, 0.18 ), 0, HIP_Y + 0.46, 0.21 );           // assault pack
	put( body, box( 0.10, 0.16, 0.10 ), 0.14, HIP_Y + 0.60, 0.20 );        // radio
	put( body, cyl( 0.012, 0.012, 0.34, 5 ), 0.18, HIP_Y + 0.86, 0.20 );   // antenna
	// shoulders
	put( body, box( 0.14, 0.16, 0.20 ), - 0.25, SHOULDER_Y - 0.02, 0 );
	put( body, box( 0.14, 0.16, 0.20 ), 0.25, SHOULDER_Y - 0.02, 0 );
	// neck + head
	put( body, cyl( 0.06, 0.07, 0.09, 7 ), 0, SHOULDER_Y + 0.10, 0 );
	put( body, box( 0.15, 0.18, 0.17 ), 0, SHOULDER_Y + 0.23, 0.005 );
	// helmet
	const helm = new THREE.SphereGeometry( 0.125, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.58 );
	helm.scale( 1.0, 0.92, 1.06 );
	put( body, helm, 0, SHOULDER_Y + 0.245, 0.005 );
	put( body, box( 0.24, 0.035, 0.06 ), 0, SHOULDER_Y + 0.245, - 0.10 );  // brim
	put( body, box( 0.06, 0.05, 0.10 ), 0.11, SHOULDER_Y + 0.28, 0.02 );   // side rail
	put( body, box( 0.06, 0.05, 0.10 ), - 0.11, SHOULDER_Y + 0.28, 0.02 );
	put( body, box( 0.05, 0.09, 0.05 ), 0.05, SHOULDER_Y + 0.36, - 0.02 ); // nvg mount

	// ---- emissive read-at-distance package ----------------------------------
	// Sized for the 20-35m engagement band. At 30m a 6cm lamp is barely a pixel
	// wide, so the markings are broad bands rather than dots, and they wrap the
	// torso and shoulders so a soldier facing away still reads as a target.
	put( glow, box( 0.200, 0.070, 0.02 ), 0, SHOULDER_Y + 0.22, - 0.086 );     // visor
	put( glow, box( 0.090, 0.048, 0.02 ), 0, HIP_Y + 0.50, - 0.152 );          // chest lamp
	put( glow, box( 0.052, 0.022, 0.02 ), - 0.17, HIP_Y + 0.52, - 0.150 );     // chest IFF strips
	put( glow, box( 0.052, 0.022, 0.02 ), 0.17, HIP_Y + 0.52, - 0.150 );
	put( glow, box( 0.036, 0.150, 0.02 ), - 0.232, HIP_Y + 0.44, - 0.148 );    // flank stripes
	put( glow, box( 0.036, 0.150, 0.02 ), 0.232, HIP_Y + 0.44, - 0.148 );
	// rear-facing set so a soldier who has broken contact is still legible
	put( glow, box( 0.150, 0.040, 0.02 ), 0, HIP_Y + 0.56, 0.302 );            // pack beacon bar
	put( glow, box( 0.040, 0.110, 0.02 ), 0, HIP_Y + 0.40, 0.303 );
	put( glow, box( 0.100, 0.030, 0.02 ), 0, SHOULDER_Y + 0.20, 0.100 );       // helmet rear band
	// shoulder caps read from any angle
	put( glow, box( 0.150, 0.026, 0.150 ), - 0.25, SHOULDER_Y + 0.062, 0 );
	put( glow, box( 0.150, 0.026, 0.150 ), 0.25, SHOULDER_Y + 0.062, 0 );
	put( glow, box( 0.014, 0.014, 0.03 ), 0.11, SHOULDER_Y + 0.28, - 0.03 );   // helmet marker

	// ---- arms + carried weapon (one rigid unit pivoting at the shoulders) ----
	// left arm forward on the handguard, right arm back on the grip
	put( arms, box( 0.115, 0.115, 0.30 ), - 0.20, SHOULDER_Y - 0.06, - 0.12, - 0.35 );
	put( arms, box( 0.100, 0.100, 0.26 ), - 0.16, SHOULDER_Y - 0.16, - 0.30, - 0.15 );
	put( arms, box( 0.095, 0.095, 0.10 ), - 0.14, SHOULDER_Y - 0.19, - 0.42 );      // left glove
	put( arms, box( 0.115, 0.115, 0.26 ), 0.21, SHOULDER_Y - 0.08, - 0.04, - 0.20 );
	put( arms, box( 0.100, 0.100, 0.24 ), 0.16, SHOULDER_Y - 0.20, - 0.16, - 0.55 );
	put( arms, box( 0.095, 0.095, 0.10 ), 0.11, SHOULDER_Y - 0.25, - 0.24 );        // right glove
	// carbine
	put( arms, box( 0.055, 0.090, 0.28 ), 0.02, SHOULDER_Y - 0.18, - 0.22 );        // receiver
	put( arms, box( 0.050, 0.055, 0.24 ), 0.02, SHOULDER_Y - 0.18, - 0.44 );        // handguard
	put( arms, cyl( 0.012, 0.012, 0.22, 7 ), 0.02, SHOULDER_Y - 0.175, - 0.60, Math.PI / 2 );
	put( arms, cyl( 0.019, 0.019, 0.05, 7 ), 0.02, SHOULDER_Y - 0.175, - 0.72, Math.PI / 2 );
	put( arms, box( 0.030, 0.150, 0.05 ), 0.02, SHOULDER_Y - 0.28, - 0.20, 0.18 );  // magazine
	put( arms, box( 0.045, 0.055, 0.12 ), 0.02, SHOULDER_Y - 0.09, - 0.08 );        // stock
	put( arms, box( 0.030, 0.030, 0.16 ), 0.02, SHOULDER_Y - 0.10, - 0.30 );        // top rail

	// ---- leg (built around the hip pivot, mirrored at runtime) ---------------
	put( leg, box( 0.155, 0.46, 0.17 ), 0, HIP_Y - 0.23, 0 );
	put( leg, box( 0.130, 0.06, 0.16 ), 0, HIP_Y - 0.46, 0 );        // knee pad
	put( leg, box( 0.130, 0.42, 0.145 ), 0, HIP_Y - 0.70, 0 );
	put( leg, box( 0.145, 0.10, 0.26 ), 0, HIP_Y - 0.93, - 0.035 );  // boot

	SHARED = {
		body: bake( body ),
		glow: bake( glow ),
		arms: bake( arms, SHOULDER_Y ),
		leg: bake( leg, HIP_Y ),
	};
	return SHARED;
}

const BASE_BODY_MAT = new THREE.MeshStandardMaterial( {
	// Dark and cool. The map is a warm dusk yard, so a soldier lit warm reads as
	// part of the scenery; keeping the fatigues cold and low-value makes the
	// silhouette a hole in the background rather than more of it.
	color: 0x21262d, roughness: 0.86, metalness: 0.10, envMapIntensity: 0.55,
} );

/**
 * Fresnel backlight on the soldier's fatigues.
 *
 * A dark grey soldier standing against a dark shipping container is invisible no
 * matter how good the AI is. Rather than wash the whole model out, a view-angle
 * term lights only the edges, so the reading is a hot outline that separates the
 * silhouette from whatever is behind it while the body stays dark and grounded.
 *
 * The rim is deliberately *cool*. An orange rim on an orange dusk yard is
 * camouflage; a cold edge is the one thing in this palette that cannot be
 * mistaken for rusted steel or low sun, and it survives being backlit by the
 * sky as well as being lost in a container's shadow. Hostile identification is
 * carried by the red markings, not by the rim.
 *
 * Uniforms are shared by every clone, which is what we want — one squad, one
 * rim setting, and no per-enemy uniform churn.
 */
const RIM_UNIFORMS = {
	uRimColor: { value: new THREE.Color( 0x9fc6ff ) },
	uRimPower: { value: 2.2 },
	uRimStrength: { value: 1.9 },
};

BASE_BODY_MAT.onBeforeCompile = ( shader ) => {
	shader.uniforms.uRimColor = RIM_UNIFORMS.uRimColor;
	shader.uniforms.uRimPower = RIM_UNIFORMS.uRimPower;
	shader.uniforms.uRimStrength = RIM_UNIFORMS.uRimStrength;
	shader.fragmentShader = shader.fragmentShader
		.replace( '#include <common>', `#include <common>
			uniform vec3 uRimColor;
			uniform float uRimPower;
			uniform float uRimStrength;` )
		// emissivemap_fragment runs after normal_fragment_begin, so `normal` and
		// vViewPosition are both live here
		.replace( '#include <emissivemap_fragment>', `#include <emissivemap_fragment>
			float rimF = 1.0 - max( dot( normal, normalize( vViewPosition ) ), 0.0 );
			totalEmissiveRadiance += uRimColor * pow( rimF, uRimPower ) * uRimStrength;` );
};
BASE_BODY_MAT.customProgramCacheKey = () => 'op-enemy-rim';

// Bright enough that the scene's bloom pass catches the markings, which is what
// actually makes them legible past ~25m: bloom spreads a two-pixel marking into
// something the eye can find. Pushed to a saturated red rather than the dusk's
// own orange so it separates from the sky and the rusted containers.
const GLOW_BASE = 7.5;

const BASE_GLOW_MAT = new THREE.MeshStandardMaterial( {
	color: 0x240200, emissive: 0xff1c08, emissiveIntensity: GLOW_BASE,
	roughness: 0.4, metalness: 0.0, toneMapped: false,
} );

/**
 * @param {object} world  World from buildMap()
 * @param {object} player createPlayer() instance
 * @param {object} deps   { vfx, audio, decals } — all optional
 */
export function createEnemies( world, player, deps = {} ) {

	const geo = buildSharedGeometry();
	const scene = engine.scene;
	const root = new THREE.Group();
	root.name = 'enemies';
	scene.add( root );

	const colliders = ( world && world.colliders ) || [];
	const hitMeshes = ( world && world.hitMeshes ) || [];
	const coverPoints = ( world && world.coverPoints ) || [];
	const spawns = ( world && world.enemySpawns ) || [];

	// Cover reservation. A squad that all picks the "best" slot ends up standing
	// inside itself, so a point is owned by exactly one enemy from the moment it
	// is chosen until that enemy repaths, dies or despawns — holding the claim
	// while it is actually stood there, not just while walking to it.
	const coverClaims = new Int32Array( coverPoints.length ).fill( - 1 );

	const list = [];
	let idCounter = 0;
	let wave = 0;
	let waveActive = false;
	let waveSpawned = 0;
	let dpsBudget = SQUAD_DPS_BURST;
	let radarTimer = 0;

	// reusable radar payload (emitted 10x/second — never allocate here)
	const radarEntries = [];
	for ( let i = 0; i < MAX_ENEMIES; i ++ ) {
		radarEntries.push( { x: 0, z: 0, angle: 0, alive: false, visible: false } );
	}
	const radarPayload = { list: [], player: { x: 0, z: 0, yaw: 0 } };

	// ---------------------------------------------------------------- pool

	function createEnemy( slot ) {
		const g = new THREE.Group();
		g.visible = false;

		const bodyMat = BASE_BODY_MAT.clone();
		const glowMat = BASE_GLOW_MAT.clone();

		const bodyMesh = new THREE.Mesh( geo.body, bodyMat );
		const glowMesh = new THREE.Mesh( geo.glow, glowMat );
		bodyMesh.castShadow = true;
		glowMesh.castShadow = false;

		const armsPivot = new THREE.Object3D();
		armsPivot.position.set( 0, SHOULDER_Y, 0 );
		const armsMesh = new THREE.Mesh( geo.arms, bodyMat );
		armsMesh.castShadow = true;
		armsPivot.add( armsMesh );
		const muzzle = new THREE.Object3D();
		muzzle.position.set( 0.02, - 0.175, - 0.76 );
		armsPivot.add( muzzle );

		const legL = new THREE.Object3D();
		legL.position.set( - 0.105, HIP_Y, 0 );
		const legLMesh = new THREE.Mesh( geo.leg, bodyMat );
		legLMesh.castShadow = true;
		legL.add( legLMesh );

		const legR = new THREE.Object3D();
		legR.position.set( 0.105, HIP_Y, 0 );
		const legRMesh = new THREE.Mesh( geo.leg, bodyMat );
		legRMesh.castShadow = true;
		legR.add( legRMesh );

		g.add( bodyMesh, glowMesh, armsPivot, legL, legR );
		root.add( g );

		return {
			slot,
			id: 0,
			name: CLASS_NAMES[ 0 ],
			group: g,
			bodyMat, glowMat,
			armsPivot, muzzle, legL, legR,
			position: new THREE.Vector3(),
			velocity: new THREE.Vector3(),
			facing: 0,
			targetFacing: 0,
			active: false,
			alive: false,
			health: 100,
			maxHealth: 100,
			damage: 8,
			accuracy: 0.34,
			state: 'idle',
			stateTime: 0,
			reactTimer: 0,
			burstLeft: 0,
			burstTimer: 0,
			telegraph: 0,
			restTimer: 0,
			hasLos: false,
			losTimer: rnd( 0, LOS_INTERVAL ),
			lostLosTime: 0,
			distance: 999,
			moveTarget: new THREE.Vector3(),
			hasMoveTarget: false,
			coverIndex: - 1,
			repathTimer: 0,
			huntDelay: 0,
			walkPhase: rnd( 0, 6.28 ),
			flinch: 0,
			flinchDir: 0,
			deathTime: - 1,
			deathSpinX: 0,
			deathSpinZ: 0,
			deathYaw: 0,
			glowPulse: 0,
			bounds: new THREE.Box3(),
			// Boxes are kept disjoint in Y/X so a centre-mass round can never be
			// scored as a limb. Arm boxes rotate with the body; the rest are
			// symmetric about the spine so yaw does not matter.
			hitboxes: [
				{ part: 'head', mult: 2.5, box: new THREE.Box3(), c: new THREE.Vector3( 0, 1.65, 0 ), s: new THREE.Vector3( 0.30, 0.30, 0.30 ) },
				{ part: 'torso', mult: 1.0, box: new THREE.Box3(), c: new THREE.Vector3( 0, 1.20, 0 ), s: new THREE.Vector3( 0.50, 0.60, 0.40 ) },
				{ part: 'limb', mult: 0.75, box: new THREE.Box3(), c: new THREE.Vector3( 0, 0.45, 0 ), s: new THREE.Vector3( 0.46, 0.90, 0.36 ) },
				{ part: 'limb', mult: 0.75, box: new THREE.Box3(), c: new THREE.Vector3( - 0.28, 1.26, - 0.06 ), s: new THREE.Vector3( 0.30, 0.42, 0.34 ) },
				{ part: 'limb', mult: 0.75, box: new THREE.Box3(), c: new THREE.Vector3( 0.28, 1.26, - 0.06 ), s: new THREE.Vector3( 0.30, 0.42, 0.34 ) },
			],
		};
	}

	for ( let i = 0; i < MAX_ENEMIES; i ++ ) list.push( createEnemy( i ) );

	// ---------------------------------------------------------------- helpers

	function playerEye( out ) {
		out.copy( player.eye );
		if ( out.lengthSq() === 0 ) out.copy( player.position ).setY( player.position.y + 1.6 );
		return out;
	}

	function hasLineOfSight( fromX, fromY, fromZ, toVec ) {
		_v.set( fromX, fromY, fromZ );
		_dir.copy( toVec ).sub( _v );
		const dist = _dir.length();
		if ( dist < 0.001 ) return true;
		_dir.divideScalar( dist );
		if ( ! hitMeshes.length ) return true;
		_ray.set( _v, _dir );
		_ray.near = 0;
		_ray.far = dist - 0.25;
		_rayHits.length = 0;
		_ray.intersectObjects( hitMeshes, true, _rayHits );
		for ( let i = 0; i < _rayHits.length; i ++ ) {
			if ( _rayHits[ i ].object.visible ) return false;
		}
		return true;
	}

	function resolveCollisions( e, dt ) {
		// world AABBs — push out along the shallowest XZ axis.
		// Anything whose top is at or below knee height is ground, not a wall:
		// testing it would eject the soldier sideways off the floor slab.
		for ( let i = 0; i < colliders.length; i ++ ) {
			const c = colliders[ i ];
			if ( c.max.y <= e.position.y + 0.35 ) continue;
			if ( c.min.y >= e.position.y + 1.78 ) continue;
			const cx = clamp( e.position.x, c.min.x, c.max.x );
			const cz = clamp( e.position.z, c.min.z, c.max.z );
			const dx = e.position.x - cx;
			const dz = e.position.z - cz;
			const d2 = dx * dx + dz * dz;
			if ( d2 >= BODY_RADIUS * BODY_RADIUS ) continue;
			if ( d2 > 1e-6 ) {
				const d = Math.sqrt( d2 );
				const push = ( BODY_RADIUS - d ) / d;
				e.position.x += dx * push;
				e.position.z += dz * push;
			} else {
				// centre inside the box: eject along the nearest face
				const l = e.position.x - c.min.x, r = c.max.x - e.position.x;
				const b = e.position.z - c.min.z, f = c.max.z - e.position.z;
				const m = Math.min( l, r, b, f );
				if ( m === l ) e.position.x = c.min.x - BODY_RADIUS;
				else if ( m === r ) e.position.x = c.max.x + BODY_RADIUS;
				else if ( m === b ) e.position.z = c.min.z - BODY_RADIUS;
				else e.position.z = c.max.z + BODY_RADIUS;
			}
		}
		// separation from squadmates
		for ( let i = 0; i < list.length; i ++ ) {
			const o = list[ i ];
			if ( o === e || ! o.alive ) continue;
			const dx = e.position.x - o.position.x;
			const dz = e.position.z - o.position.z;
			const d2 = dx * dx + dz * dz;
			const min = 0.85;
			if ( d2 > min * min || d2 < 1e-6 ) continue;
			const d = Math.sqrt( d2 );
			const push = ( min - d ) / d * 0.5;
			e.position.x += dx * push;
			e.position.z += dz * push;
		}
		// stay inside the map
		const b = world && world.bounds;
		if ( b ) {
			e.position.x = clamp( e.position.x, b.min.x + 0.6, b.max.x - 0.6 );
			e.position.z = clamp( e.position.z, b.min.z + 0.6, b.max.z - 0.6 );
		}
	}

	function groundHeightAt( x, z, fallback ) {
		let best = 0;
		for ( let i = 0; i < colliders.length; i ++ ) {
			const c = colliders[ i ];
			if ( x < c.min.x - 0.2 || x > c.max.x + 0.2 ) continue;
			if ( z < c.min.z - 0.2 || z > c.max.z + 0.2 ) continue;
			if ( c.max.y > fallback + 0.6 ) continue;   // don't snap onto walls
			if ( c.max.y > best ) best = c.max.y;
		}
		return best;
	}

	function releaseCover( e ) {
		if ( e.coverIndex >= 0 ) {
			if ( coverClaims[ e.coverIndex ] === e.id ) coverClaims[ e.coverIndex ] = - 1;
			e.coverIndex = - 1;
		}
	}

	/** True if a live squadmate is physically stood on this point. */
	function occupied( cp, self ) {
		for ( let j = 0; j < list.length; j ++ ) {
			const o = list[ j ];
			if ( o === self || ! o.active || ! o.alive ) continue;
			const dx = o.position.x - cp.x, dz = o.position.z - cp.z;
			if ( dx * dx + dz * dz < 1.44 ) return true;
		}
		return false;
	}

	/** Pick a cover point that can see the player and is a healthy distance out. */
	function chooseCover( e, preferClose ) {
		playerEye( _eye );
		releaseCover( e );
		if ( ! coverPoints.length ) {
			// no cover data: flank toward the player and stop at a fighting distance
			const a = Math.atan2( e.position.x - _eye.x, e.position.z - _eye.z ) + rnd( - 0.7, 0.7 );
			const d = preferClose ? rnd( 7, 12 ) : rnd( 12, 20 );
			e.moveTarget.set( _eye.x + Math.sin( a ) * d, e.position.y, _eye.z + Math.cos( a ) * d );
			e.hasMoveTarget = true;
			return;
		}

		let bestScore = - Infinity;
		let bestIdx = - 1;
		const n = coverPoints.length;
		// walk the whole ring from a random phase so every point is reachable,
		// but only score a bounded slice of it per repath
		const tries = Math.min( n, 14 );
		const offset = Math.floor( Math.random() * n );
		const step = Math.max( 1, Math.floor( n / tries ) );
		for ( let i = 0; i < tries; i ++ ) {
			const idx = ( offset + i * step ) % n;
			if ( coverClaims[ idx ] !== - 1 ) continue;      // reserved by a squadmate
			const cp = coverPoints[ idx ];
			if ( occupied( cp, e ) ) continue;               // someone is stood there

			const distToPlayer = cp.distanceTo( _eye );
			const distToSelf = cp.distanceTo( e.position );
			const ideal = preferClose ? 11 : 17;
			let score = - Math.abs( distToPlayer - ideal ) * 1.4 - distToSelf * 0.55;
			if ( hasLineOfSight( cp.x, cp.y + EYE_Y, cp.z, _eye ) ) score += 24;
			score += Math.random() * 4;
			if ( score > bestScore ) { bestScore = score; bestIdx = idx; }
		}
		if ( bestIdx >= 0 ) {
			coverClaims[ bestIdx ] = e.id;
			e.coverIndex = bestIdx;
			e.moveTarget.copy( coverPoints[ bestIdx ] );
			e.hasMoveTarget = true;
		} else {
			// every slot is spoken for — flank instead of piling in
			const a = Math.atan2( e.position.x - _eye.x, e.position.z - _eye.z ) + rnd( - 0.9, 0.9 );
			const d = preferClose ? rnd( 8, 13 ) : rnd( 13, 19 );
			e.moveTarget.set( _eye.x + Math.sin( a ) * d, e.position.y, _eye.z + Math.cos( a ) * d );
			e.hasMoveTarget = true;
		}
	}

	function alertSquad( source, radius ) {
		for ( let i = 0; i < list.length; i ++ ) {
			const o = list[ i ];
			if ( o === source || ! o.alive ) continue;
			if ( o.state !== 'idle' ) continue;
			if ( o.position.distanceToSquared( source.position ) > radius * radius ) continue;
			o.state = 'alert';
			o.stateTime = 0;
			o.reactTimer = rnd( 0.55, 1.05 );
		}
	}

	// ---------------------------------------------------------------- shooting

	function enemyShoot( e ) {
		if ( ! player.state.alive ) return;
		playerEye( _eye );
		e.muzzle.getWorldPosition( _v2 );

		const dist = e.position.distanceTo( _eye );
		const playerSpeed01 = clamp( player.state.speed / 6.5, 0, 1 );

		// accuracy degrades with distance and with player movement — and every
		// shot is capped by the squad damage budget so it never feels cheap
		let chance = e.accuracy;
		chance *= clamp( 1.25 - dist / 55, 0.30, 1.0 );
		chance *= 1 - playerSpeed01 * 0.34;
		if ( player.state.crouching ) chance *= 0.88;

		const willHit = Math.random() < chance && dpsBudget >= e.damage;

		if ( willHit ) {
			_target.set(
				_eye.x + rnd( - 0.12, 0.12 ),
				_eye.y + rnd( - 0.25, 0.05 ),
				_eye.z + rnd( - 0.12, 0.12 ),
			);
		} else {
			// deliberate near miss, still visible so the player can read the threat
			const spread = 0.55 + dist * 0.030;
			_target.set(
				_eye.x + rnd( - spread, spread ),
				_eye.y + rnd( - spread * 0.7, spread * 0.9 ),
				_eye.z + rnd( - spread, spread ),
			);
		}

		_dir.copy( _target ).sub( _v2 );
		const shotLen = _dir.length() || 1;
		_dir.divideScalar( shotLen );

		deps.vfx?.muzzleFlash?.( _v2, _dir, 0.85, false );
		deps.vfx?.tracer?.( _v2, _target, 190 );
		deps.audio?.enemyShot?.( _v2 );

		if ( willHit ) {
			dpsBudget -= e.damage;
			player.damage( e.damage, e.position );
		} else {
			// suppression: a close miss cracks past your ear
			if ( dist < 24 ) engine.addShake( 0.018 );
			// place a real impact behind the player so misses chew up the cover
			if ( Math.random() < 0.55 && hitMeshes.length ) {
				_ray.set( _v2, _dir );
				_ray.near = shotLen * 0.5;
				_ray.far = shotLen + 26;
				_rayHits.length = 0;
				_ray.intersectObjects( hitMeshes, true, _rayHits );
				if ( _rayHits.length ) {
					const it = _rayHits[ 0 ];
					_v3.copy( it.point );
					if ( it.face ) _nrm.copy( it.face.normal ).transformDirection( it.object.matrixWorld ).normalize();
					else _nrm.copy( _dir ).negate();
					const surf = it.object.userData && it.object.userData.surface || 'concrete';
					deps.vfx?.impact?.( _v3, _nrm, surf );
					deps.decals?.add?.( _v3, _nrm, surf );
				}
			}
		}
	}

	// ---------------------------------------------------------------- damage

	/**
	 * @param {object} e       enemy from `list`
	 * @param {number} amount  post-multiplier damage
	 * @param {object} opts    { headshot, point, normal, weapon }
	 */
	function damage( e, amount, opts = {} ) {
		if ( ! e || ! e.alive ) return null;
		e.health -= amount;
		e.flinch = Math.min( 1, e.flinch + clamp( amount / 40, 0.18, 0.7 ) );
		e.flinchDir = Math.random() < 0.5 ? - 1 : 1;
		e.glowPulse = 1;

		if ( e.state === 'idle' ) {
			e.state = 'alert';
			e.stateTime = 0;
			e.reactTimer = rnd( 0.30, 0.55 );   // being shot at wakes you up fast
			alertSquad( e, 22 );
		}

		const killed = e.health <= 0;
		const point = opts.point ? opts.point.clone() : e.position.clone().setY( e.position.y + 1.2 );

		bus.emit( 'hit:confirm', {
			headshot: !! opts.headshot,
			damage: amount,
			killed,
			point,
		} );

		if ( killed ) kill( e, opts );
		return { killed, damage: amount };
	}

	function kill( e, opts = {} ) {
		e.alive = false;
		e.state = 'dead';
		e.deathTime = 0;
		releaseCover( e );
		e.hasMoveTarget = false;
		e.deathSpinX = rnd( 0.9, 1.7 ) * ( Math.random() < 0.5 ? - 1 : 1 );
		e.deathSpinZ = rnd( - 1.1, 1.1 );
		e.deathYaw = rnd( - 1.4, 1.4 );
		e.bodyMat.transparent = true;
		e.glowMat.transparent = true;
		e.bodyMat.needsUpdate = true;
		e.glowMat.needsUpdate = true;

		playerEye( _eye );
		const distance = e.position.distanceTo( _eye );
		const point = opts.point ? opts.point.clone() : e.position.clone().setY( e.position.y + 1.3 );

		bus.emit( 'enemy:killed', {
			id: e.id,
			name: e.name,
			headshot: !! opts.headshot,
			distance,
			weapon: opts.weapon || 'unknown',
			point,
		} );

		const base = opts.headshot ? 150 : 100;
		const bonus = distance > 35 ? 50 : 0;
		bus.emit( 'score:add', {
			amount: base + bonus,
			label: opts.headshot ? 'HEADSHOT' : ( bonus ? 'LONG SHOT' : 'ELIMINATION' ),
			point: point.clone(),
		} );
	}

	// ---------------------------------------------------------------- spawning

	function activate( e, pos, yaw ) {
		e.id = ++ idCounter;
		e.name = CLASS_NAMES[ Math.floor( Math.random() * CLASS_NAMES.length ) ];
		e.active = true;
		e.alive = true;
		e.maxHealth = 100 + wave * 9;
		e.health = e.maxHealth;
		e.damage = clamp( 7 + wave * 0.55, 7, 13 );
		e.accuracy = clamp( 0.30 + wave * 0.035, 0.30, 0.62 );
		e.position.copy( pos );
		e.velocity.set( 0, 0, 0 );
		e.facing = yaw || 0;
		e.targetFacing = e.facing;
		e.state = 'idle';
		e.stateTime = 0;
		e.reactTimer = 0;
		e.burstLeft = 0;
		e.burstTimer = 0;
		e.telegraph = 0;
		e.restTimer = rnd( 0.3, 1.2 );
		e.hasLos = false;
		e.lostLosTime = 0;
		e.hasMoveTarget = false;
		e.repathTimer = 0;
		// later waves press the attack sooner
		e.huntDelay = rnd( 2.4, 8.5 ) / ( 1 + wave * 0.16 );
		e.flinch = 0;
		e.deathTime = - 1;
		e.glowPulse = 0;
		e.bodyMat.opacity = 1;
		e.glowMat.opacity = 1;
		e.bodyMat.transparent = false;
		e.glowMat.transparent = false;
		e.bodyMat.needsUpdate = true;
		e.glowMat.needsUpdate = true;
		e.glowMat.emissiveIntensity = GLOW_BASE;
		e.group.visible = true;
		e.group.position.copy( pos );
		e.group.rotation.set( 0, e.facing, 0 );
		e.armsPivot.rotation.set( 0, 0, 0 );
		e.legL.rotation.set( 0, 0, 0 );
		e.legR.rotation.set( 0, 0, 0 );
		bus.emit( 'enemy:spawned', { id: e.id } );
	}

	/**
	 * Radial push-apart so soldiers never interpenetrate. Cover reservation stops
	 * them *aiming* at the same spot; this stops them merging while manoeuvring
	 * through the same doorway. n is capped at MAX_ENEMIES so the pair loop is a
	 * couple of dozen iterations at worst, and it allocates nothing.
	 */
	function separate() {
		const R = 0.9, R2 = R * R;
		for ( let i = 0; i < list.length; i ++ ) {
			const a = list[ i ];
			if ( ! a.active || ! a.alive ) continue;
			for ( let j = i + 1; j < list.length; j ++ ) {
				const b = list[ j ];
				if ( ! b.active || ! b.alive ) continue;
				let dx = b.position.x - a.position.x;
				let dz = b.position.z - a.position.z;
				const d2 = dx * dx + dz * dz;
				if ( d2 >= R2 ) continue;
				let d = Math.sqrt( d2 );
				if ( d < 1e-4 ) {
					// exactly coincident: break the tie deterministically by id
					const ang = ( a.id * 2.399963 ) % 6.283185;
					dx = Math.cos( ang ); dz = Math.sin( ang ); d = 1e-4;
				} else {
					dx /= d; dz /= d;
				}
				// Resolve the overlap itself rather than applying a dt-scaled
				// force: a velocity nudge loses to two soldiers steering at the
				// same doorway, and going frame-rate independent here means a
				// stutter can't let them merge. 0.3 each clears 60% per frame,
				// which converges in a few frames without visible popping.
				const push = ( R - d ) * 0.3;
				a.position.x -= dx * push; a.position.z -= dz * push;
				b.position.x += dx * push; b.position.z += dz * push;
			}
		}
	}

	function deactivate( e ) {
		e.active = false;
		e.alive = false;
		e.group.visible = false;
		e.state = 'idle';
		releaseCover( e );
		e.hasMoveTarget = false;
	}

	function spawnWave( n ) {
		wave ++;
		const count = Math.max( 1, Math.min( MAX_ENEMIES, n || ( 3 + Math.floor( wave * 1.6 ) ) ) );
		playerEye( _eye );

		let spawned = 0;
		for ( let i = 0; i < list.length && spawned < count; i ++ ) {
			const e = list[ i ];
			if ( e.active ) continue;

			let pos = null, yaw = 0;
			if ( spawns.length ) {
				// prefer spawns away from the player so nothing materialises in their face
				let best = null, bestScore = - Infinity;
				for ( let t = 0; t < 6; t ++ ) {
					const s = spawns[ Math.floor( Math.random() * spawns.length ) ];
					const d = s.position.distanceTo( _eye );
					const score = ( d > 12 ? 20 : - 30 ) - Math.abs( d - 28 ) + Math.random() * 8;
					if ( score > bestScore ) { bestScore = score; best = s; }
				}
				pos = best.position;
				yaw = best.yaw || 0;
			} else {
				const a = Math.random() * Math.PI * 2;
				const d = rnd( 22, 34 );
				_v.set( _eye.x + Math.cos( a ) * d, 0, _eye.z + Math.sin( a ) * d );
				pos = _v;
				yaw = a + Math.PI;
			}

			activate( e, pos, yaw );
			spawned ++;
		}

		waveSpawned = spawned;
		waveActive = spawned > 0;
		bus.emit( 'wave:start', { wave, enemyCount: spawned } );
		return spawned;
	}

	// ---------------------------------------------------------------- ai + anim

	function updateEnemy( e, dt, doLos ) {

		// ---- death: kinematic tumble, then sink and fade -----------------
		if ( e.deathTime >= 0 ) {
			e.deathTime += dt;
			const t = e.deathTime;
			const g = e.group;
			const fall = Math.min( 1, t / 0.85 );
			const ease = 1 - ( 1 - fall ) * ( 1 - fall );
			g.rotation.x = e.deathSpinX * ease * 0.95;
			g.rotation.z = e.deathSpinZ * ease * 0.75;
			g.rotation.y = e.facing + e.deathYaw * ease;
			g.position.y = e.position.y - ease * 0.06 + Math.sin( fall * Math.PI ) * 0.10;
			// limbs go slack
			e.armsPivot.rotation.x = damp( e.armsPivot.rotation.x, 0.9, 6, dt );
			e.armsPivot.rotation.z = damp( e.armsPivot.rotation.z, - 0.5, 5, dt );
			e.legL.rotation.x = damp( e.legL.rotation.x, - 0.45, 5, dt );
			e.legR.rotation.x = damp( e.legR.rotation.x, 0.35, 5, dt );
			e.glowMat.emissiveIntensity = Math.max( 0, GLOW_BASE - t * 7.5 );
			if ( t > 3.4 ) {
				const fade = clamp( 1 - ( t - 3.4 ) / 1.5, 0, 1 );
				e.bodyMat.opacity = fade;
				e.glowMat.opacity = fade;
				g.position.y = e.position.y - ( 1 - fade ) * 0.55;
				if ( fade <= 0.001 ) deactivate( e );
			}
			return;
		}

		e.stateTime += dt;
		playerEye( _eye );
		e.distance = e.position.distanceTo( _eye );

		// ---- line of sight (staggered across frames) -----------------------
		if ( doLos ) {
			e.hasLos = e.distance < VIEW_DISTANCE &&
				hasLineOfSight( e.position.x, e.position.y + EYE_Y, e.position.z, _eye );
			if ( e.hasLos ) e.lostLosTime = 0;
		}
		if ( ! e.hasLos ) e.lostLosTime += dt;

		// ---- state machine --------------------------------------------------
		let moveSpeed = 0;
		let wantAim = false;

		switch ( e.state ) {

			case 'idle': {
				e.restTimer -= dt;
				if ( e.restTimer <= 0 ) {
					e.targetFacing += rnd( - 1.1, 1.1 );
					e.restTimer = rnd( 1.8, 3.6 );
				}
				// A soldier who happens to spawn facing a wall would otherwise
				// stand there for the whole wave. Once the contact is live they
				// go looking, on a staggered delay so the squad trickles into
				// the fight instead of arriving as one blob.
				e.huntDelay -= dt;
				if ( waveActive && e.huntDelay <= 0 ) {
					e.state = 'advance';
					e.stateTime = 0;
					e.repathTimer = 0;
					break;
				}
				// sight cone check
				if ( e.hasLos && e.distance < VIEW_DISTANCE ) {
					_dir.copy( _eye ).sub( e.position ).setY( 0 ).normalize();
					_v2.set( Math.sin( e.facing ), 0, Math.cos( e.facing ) );
					if ( _dir.dot( _v2 ) > VIEW_COS ) {
						e.state = 'alert';
						e.stateTime = 0;
						e.reactTimer = rnd( 0.45, 0.90 );
						alertSquad( e, 18 );
					}
				}
				break;
			}

			case 'alert': {
				// telegraphed wake-up: square up, visor flares, then commit
				wantAim = true;
				e.targetFacing = Math.atan2( _eye.x - e.position.x, _eye.z - e.position.z );
				e.reactTimer -= dt;
				e.glowPulse = Math.max( e.glowPulse, 0.55 );
				if ( e.reactTimer <= 0 ) {
					if ( e.hasLos && e.distance < 34 ) { e.state = 'engage'; e.burstTimer = rnd( 0.10, 0.30 ); }
					else { e.state = 'advance'; chooseCover( e, e.distance > 26 ); e.repathTimer = rnd( 3, 5 ); }
					e.stateTime = 0;
				}
				break;
			}

			case 'advance': {
				moveSpeed = e.distance > 22 ? ADVANCE_SPEED : WALK_SPEED;
				e.repathTimer -= dt;
				if ( ! e.hasMoveTarget || e.repathTimer <= 0 ) {
					chooseCover( e, e.distance > 26 );
					e.repathTimer = rnd( 3.0, 5.0 );
				}
				if ( e.hasMoveTarget ) {
					_v2.copy( e.moveTarget ).sub( e.position ).setY( 0 );
					const d = _v2.length();
					if ( d < 1.0 ) {
						e.hasMoveTarget = false;
						e.state = 'engage';
						e.stateTime = 0;
						e.burstTimer = rnd( 0.35, 0.75 );
					} else {
						_v2.divideScalar( d );
						e.velocity.x = damp( e.velocity.x, _v2.x * moveSpeed, 9, dt );
						e.velocity.z = damp( e.velocity.z, _v2.z * moveSpeed, 9, dt );
						e.targetFacing = Math.atan2( _v2.x, _v2.z );
					}
				}
				// opportunistic fire while pushing
				if ( e.hasLos && e.distance < 26 && e.stateTime > 0.8 ) {
					e.state = 'engage';
					e.stateTime = 0;
					e.burstTimer = rnd( 0.25, 0.6 );
				}
				break;
			}

			case 'engage': {
				wantAim = true;
				e.targetFacing = Math.atan2( _eye.x - e.position.x, _eye.z - e.position.z );
				e.velocity.x = damp( e.velocity.x, 0, 12, dt );
				e.velocity.z = damp( e.velocity.z, 0, 12, dt );

				if ( ! e.hasLos ) {
					if ( e.lostLosTime > 0.65 ) {
						e.state = 'reposition';
						e.stateTime = 0;
						e.burstLeft = 0;
						chooseCover( e, true );
						e.repathTimer = rnd( 2.5, 4.5 );
					}
					break;
				}

				if ( e.burstLeft > 0 ) {
					e.burstTimer -= dt;
					if ( e.burstTimer <= 0 ) {
						enemyShoot( e );
						e.burstLeft --;
						e.burstTimer = rnd( 0.095, 0.135 );
						if ( e.burstLeft <= 0 ) e.burstTimer = rnd( 0.85, 1.75 );
					}
				} else if ( e.telegraph > 0 ) {
					// muzzle settles on target and the visor flares before the burst
					e.telegraph -= dt;
					e.glowPulse = Math.max( e.glowPulse, 0.8 );
					if ( e.telegraph <= 0 ) {
						e.burstLeft = 3 + Math.floor( Math.random() * 4 );
						e.burstTimer = 0;
					}
				} else {
					e.burstTimer -= dt;
					if ( e.burstTimer <= 0 ) {
						e.telegraph = rnd( 0.22, 0.38 );
						deps.audio?.enemyAlert?.( e.position );
					}
				}

				// don't let them stand still forever
				if ( e.stateTime > rnd( 6, 9 ) ) {
					e.state = 'reposition';
					e.stateTime = 0;
					chooseCover( e, e.distance > 20 );
					e.repathTimer = rnd( 2.5, 4.5 );
				}
				break;
			}

			case 'reposition': {
				moveSpeed = ADVANCE_SPEED;
				e.repathTimer -= dt;
				if ( ! e.hasMoveTarget || e.repathTimer <= 0 ) {
					chooseCover( e, true );
					e.repathTimer = rnd( 2.5, 4.5 );
				}
				if ( e.hasMoveTarget ) {
					_v2.copy( e.moveTarget ).sub( e.position ).setY( 0 );
					const d = _v2.length();
					if ( d < 1.0 ) {
						e.hasMoveTarget = false;
						e.state = 'engage';
						e.stateTime = 0;
						e.burstTimer = rnd( 0.3, 0.7 );
					} else {
						_v2.divideScalar( d );
						e.velocity.x = damp( e.velocity.x, _v2.x * moveSpeed, 9, dt );
						e.velocity.z = damp( e.velocity.z, _v2.z * moveSpeed, 9, dt );
						e.targetFacing = Math.atan2( _v2.x, _v2.z );
					}
				} else if ( e.hasLos ) {
					e.state = 'engage';
					e.stateTime = 0;
				}
				break;
			}
		}

		// ---- integrate movement -----------------------------------------------
		if ( moveSpeed <= 0 ) {
			e.velocity.x = damp( e.velocity.x, 0, 11, dt );
			e.velocity.z = damp( e.velocity.z, 0, 11, dt );
		}
		e.position.x += e.velocity.x * dt;
		e.position.z += e.velocity.z * dt;
		resolveCollisions( e, dt );
		e.position.y = damp( e.position.y, groundHeightAt( e.position.x, e.position.z, e.position.y ), 12, dt );

		// ---- facing ------------------------------------------------------------
		let df = e.targetFacing - e.facing;
		while ( df > Math.PI ) df -= Math.PI * 2;
		while ( df < - Math.PI ) df += Math.PI * 2;
		e.facing += df * Math.min( 1, dt * ( wantAim ? 9 : 5 ) );

		// ---- procedural animation ------------------------------------------------
		const speed = Math.hypot( e.velocity.x, e.velocity.z );
		const stride = clamp( speed / ADVANCE_SPEED, 0, 1 );
		e.walkPhase += dt * ( 3.0 + speed * 1.9 );
		const swing = Math.sin( e.walkPhase ) * ( 0.28 + stride * 0.52 );

		e.legL.rotation.x = swing * ( 0.25 + stride );
		e.legR.rotation.x = - swing * ( 0.25 + stride );
		e.legL.rotation.z = Math.sin( e.walkPhase * 2 ) * 0.04 * stride;
		e.legR.rotation.z = - Math.sin( e.walkPhase * 2 ) * 0.04 * stride;

		// aim pose: pitch the whole upper rig at the player, cant it while moving
		const aimPitch = wantAim
			? clamp( Math.atan2( e.position.y + SHOULDER_Y - _eye.y, Math.max( 0.5, Math.hypot( _eye.x - e.position.x, _eye.z - e.position.z ) ) ), - 0.7, 0.7 )
			: 0;
		const readyPose = wantAim ? 0 : 0.45;
		e.flinch = Math.max( 0, e.flinch - dt * 3.4 );
		e.armsPivot.rotation.x = damp( e.armsPivot.rotation.x,
			aimPitch + readyPose + e.flinch * 0.30, 12, dt );
		e.armsPivot.rotation.y = damp( e.armsPivot.rotation.y,
			- swing * 0.10 * stride + e.flinch * 0.22 * e.flinchDir, 10, dt );
		e.armsPivot.rotation.z = damp( e.armsPivot.rotation.z,
			( wantAim ? 0 : - 0.32 ) + e.flinch * 0.25 * e.flinchDir, 10, dt );

		// body bob + flinch lean
		const bob = Math.abs( Math.sin( e.walkPhase ) ) * 0.035 * stride;
		e.group.position.set( e.position.x, e.position.y + bob, e.position.z );
		e.group.rotation.y = e.facing;
		e.group.rotation.z = e.flinch * 0.10 * e.flinchDir;
		e.group.rotation.x = - stride * 0.06 + e.flinch * 0.08;

		// visor pulse when alerted / hit
		e.glowPulse = Math.max( 0, e.glowPulse - dt * 2.4 );
		e.glowMat.emissiveIntensity = GLOW_BASE + e.glowPulse * 5.5;

		// ---- hitboxes ---------------------------------------------------------------
		const cf = Math.cos( e.facing ), sf = Math.sin( e.facing );
		for ( let i = 0; i < e.hitboxes.length; i ++ ) {
			const hb = e.hitboxes[ i ];
			const ox = hb.c.x * cf + hb.c.z * sf;
			const oz = - hb.c.x * sf + hb.c.z * cf;
			_v.set( e.position.x + ox, e.position.y + hb.c.y + bob, e.position.z + oz );
			hb.box.setFromCenterAndSize( _v, hb.s );
		}
		e.bounds.setFromCenterAndSize(
			_v.set( e.position.x, e.position.y + 0.95, e.position.z ),
			_v2.set( 1.0, 2.05, 1.0 ) );
	}

	// ---------------------------------------------------------------- main update

	function update( dt ) {

		const waveScale = 1 + wave * SQUAD_DPS_PER_WAVE;
		dpsBudget = Math.min( SQUAD_DPS_BURST * waveScale, dpsBudget + SQUAD_DPS_CAP * waveScale * dt );

		// stagger LOS raycasts: at most 2 enemies per frame
		let losA = - 1, losB = - 1;
		if ( list.length ) {
			const step = Math.floor( engine.frame % list.length );
			losA = step;
			losB = ( step + Math.ceil( list.length / 2 ) ) % list.length;
		}

		let aliveCount = 0;
		for ( let i = 0; i < list.length; i ++ ) {
			const e = list[ i ];
			if ( ! e.active ) continue;
			const doLos = ( i === losA || i === losB ) && e.alive;
			if ( doLos ) e.losTimer = 0; else e.losTimer += dt;
			updateEnemy( e, dt, doLos || ( e.alive && e.losTimer > LOS_INTERVAL * 3 ) );
			if ( e.alive ) aliveCount ++;
		}

		separate();

		// ---- wave completion -------------------------------------------
		if ( waveActive && aliveCount === 0 ) {
			waveActive = false;
			bus.emit( 'wave:clear', { wave, bonus: 250 + wave * 125 } );
		}

		// ---- radar feed (~10Hz) ------------------------------------------
		radarTimer += dt;
		if ( radarTimer >= 0.1 ) {
			radarTimer = 0;
			let n = 0;
			for ( let i = 0; i < list.length; i ++ ) {
				const e = list[ i ];
				if ( ! e.active || ! e.alive ) continue;
				const entry = radarEntries[ n ++ ];
				entry.x = e.position.x;
				entry.z = e.position.z;
				entry.angle = e.facing;
				entry.alive = true;
				entry.visible = e.hasLos;
				if ( n >= MAX_ENEMIES ) break;
			}
			radarPayload.list.length = 0;
			for ( let i = 0; i < n; i ++ ) radarPayload.list.push( radarEntries[ i ] );
			radarPayload.player.x = player.position.x;
			radarPayload.player.z = player.position.z;
			radarPayload.player.yaw = player.yaw;
			bus.emit( 'radar:enemies', radarPayload );
		}
	}

	// ---------------------------------------------------------------- public

	function reset() {
		for ( let i = 0; i < list.length; i ++ ) deactivate( list[ i ] );
		coverClaims.fill( - 1 );
		wave = 0;
		waveActive = false;
		waveSpawned = 0;
		dpsBudget = SQUAD_DPS_BURST;
	}

	function aliveCount() {
		let n = 0;
		for ( let i = 0; i < list.length; i ++ ) if ( list[ i ].alive ) n ++;
		return n;
	}

	function dispose() {
		scene.remove( root );
	}

	return {
		update,
		list,
		reset,
		spawnWave,
		damage,
		dispose,
		aliveCount,
		get wave() { return wave; },
		get waveActive() { return waveActive; },
		get waveSpawned() { return waveSpawned; },
	};
}

export default createEnemies;
