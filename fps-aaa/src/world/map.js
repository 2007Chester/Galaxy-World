import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * "TIDEWORKS" — the OVERPRESSURE vertical-slice arena.
 *
 * An abandoned coastal industrial compound, 60m x 60m, at golden-hour dusk.
 * Three interlocking lanes that all see each other but never in a straight line:
 *
 *   LANE A  container yard      x  0..28   open asphalt, stacked 20ft boxes at
 *                                          varied rotations forming corridors
 *   LANE B  warehouse interior  x -30..-8  enclosed, corrugated roof with four
 *                                          gaps that spear light onto the floor
 *   LANE C  gantry              y = 4.4    mezzanine -> catwalk -> crane deck,
 *                                          overlooking both A and B
 *
 * plus a shallow drainage channel at z = 10 that runs the full width as a
 * low, crouched flanking route, and a central courtyard tying them together.
 *
 * Readability rule applied throughout: floors are dark (asphalt / wet
 * concrete), cover is mid-value (rust, painted steel), and the sky behind the
 * low south seawall is bright — so a standing enemy always has a value edge.
 *
 * Performance: every static surface is merged per material into one mesh, all
 * repeated props are InstancedMesh, and the whole level is ~35 draw calls.
 *
 * Axes: +X east, +Z south, Y up. The sun rakes in from the west-south-west.
 */

const HALF_PI = Math.PI / 2;

// Mirrors the default sun in sky.js (azimuth -0.83 rad, elevation ~14deg). The
// hand-authored light shafts below are aimed along it.
const SUN_DIR = new THREE.Vector3( - 0.716, 0.240, 0.655 );

/**
 * Shafts, as [ x0,y0,z0, x1,y1,z1, widthStart, widthEnd, colorHex, gain ].
 *
 * Sunlight travels along -SUN_DIR = (0.716, -0.240, -0.655): east, north and
 * down at ~14deg. Warehouse roof gaps sit at z = -24.5, -16.5 and -8.5 spanning
 * x -30..-8; the south wall has a 6m doorway at x -23..-17. Each endpoint is
 * where that ray meets the east wall (x = -8), the north wall (z = -30) or the
 * floor, whichever comes first.
 */
const SHAFT_DEFS = [
	// -- through the southern roof gap: the long hero beams across the floor
	[ - 29.0, 7.0, - 8.5, - 8.0, 0.02, - 27.7, 1.5, 2.9, 0xffb877, 1.00 ],
	[ - 25.4, 7.0, - 8.5, - 8.0, 1.19, - 24.4, 1.3, 2.6, 0xffb877, 0.85 ],
	[ - 21.6, 7.0, - 8.5, - 8.0, 2.46, - 20.9, 1.2, 2.4, 0xffad6a, 0.70 ],
	// -- middle gap: cut short by the north wall, so they hit high and bright
	[ - 28.4, 7.0, - 16.5, - 13.6, 2.05, - 30.0, 1.4, 2.5, 0xffb877, 0.92 ],
	[ - 24.2, 7.0, - 16.5, - 9.4, 2.05, - 30.0, 1.2, 2.2, 0xffad6a, 0.72 ],
	// -- northern gap: short, steep, close to the wall
	[ - 27.6, 7.0, - 24.5, - 21.6, 4.98, - 30.0, 1.1, 1.7, 0xffb877, 0.62 ],
	[ - 23.0, 7.0, - 24.5, - 17.0, 4.98, - 30.0, 1.0, 1.6, 0xffad6a, 0.50 ],
	// -- through the 6m south doorway: the widest, warmest wedge in the level
	[ - 21.5, 4.6, - 2.2, - 8.0, 0.06, - 14.6, 2.6, 4.2, 0xffc089, 1.10 ],
	[ - 18.6, 3.4, - 2.2, - 8.6, 0.04, - 11.9, 2.2, 3.4, 0xffb877, 0.80 ],

	// -- practical glows: short widening cones under the lamp housings
	[ - 8.9, 5.15, - 13.5, - 8.9, 0.6, - 13.5, 0.5, 3.4, 0xff9c3a, 0.85 ],
	[ - 19.0, 5.95, - 18.5, - 19.0, 0.5, - 18.5, 0.45, 3.0, 0xff9430, 0.75 ],
	[ 13.0, 8.2, - 6.0, 12.1, 0.4, - 3.6, 0.7, 4.4, 0xffab48, 0.80 ],
	[ - 19.5, 3.95, - 6.2, - 19.5, 1.1, - 6.2, 0.35, 1.9, 0xbfe0ff, 0.45 ],
];

const SHAFT_VERT = /* glsl */`
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec2 aW;
attribute vec3 aColor;
attribute float aSeed;

varying vec2 vShaft;
varying vec3 vCol;
varying float vSeed;
varying float vFacing;
varying float vDist;

void main() {
	float u = position.x;   // 0 at the source, 1 at the far end
	float v = position.y;   // -0.5 .. 0.5 across the beam
	vec3 p = mix( aStart, aEnd, u );
	vec3 axis = normalize( aEnd - aStart );
	vec3 toCam = cameraPosition - p;

	// spin the quad about the beam axis so its face always turns to the camera
	vec3 side = cross( axis, toCam );
	float sl = length( side );
	side = sl > 1e-5 ? side / sl : vec3( 1.0, 0.0, 0.0 );
	p += side * ( v * mix( aW.x, aW.y, u ) );

	vShaft = vec2( u, v );
	vCol = aColor;
	vSeed = aSeed;
	// looking straight down the barrel of a beam there is nothing to scatter
	vFacing = 1.0 - abs( dot( normalize( toCam ), axis ) );
	vDist = length( toCam );

	gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
}
`;

const SHAFT_FRAG = /* glsl */`
precision mediump float;

uniform float uTime;
uniform float uOpacity;

varying vec2 vShaft;
varying vec3 vCol;
varying float vSeed;
varying float vFacing;
varying float vDist;

void main() {
	// gaussian-ish across the beam so there is no hard silhouette edge
	float across = max( 0.0, 1.0 - abs( vShaft.y ) * 2.0 );
	across *= across * across;

	// ramp on at the aperture, hold most of the run, fade before the hard end
	float along = smoothstep( 0.0, 0.10, vShaft.x ) * ( 1.0 - smoothstep( 0.62, 1.02, vShaft.x ) );

	// two incommensurate travelling bands: dust moving through the beam
	float band = 0.68
		+ 0.20 * sin( vShaft.x * 8.3 - uTime * 0.33 + vSeed * 6.3 )
		+ 0.16 * sin( vShaft.x * 19.7 + uTime * 0.19 + vSeed * 2.7 );

	// hold back until a couple of metres out; standing inside a beam should not
	// paint the whole screen
	float near = smoothstep( 0.6, 3.0, vDist );

	float a = across * along * band * vFacing * near * uOpacity;
	gl_FragColor = vec4( vCol * a, a );
}
`;

// ---------------------------------------------------------------------------
// merge groups — one draw call each
// tile is UV repeats per world metre. surface feeds hit reactions + footsteps.
// ---------------------------------------------------------------------------

const GROUP_DEFS = {
	asphalt: { mat: 'asphalt', surface: 'concrete', cast: false, receive: true, tile: 0.22 },
	concrete: { mat: 'concrete', surface: 'concrete', cast: true, receive: true, tile: 0.38 },
	concreteDark: { mat: 'concreteDark', surface: 'concrete', cast: true, receive: true, tile: 0.32 },
	plaster: { mat: 'plaster', surface: 'concrete', cast: true, receive: true, tile: 0.45 },
	metal: { mat: 'metal', surface: 'metal', cast: true, receive: true, tile: 0.7 },
	metalDark: { mat: 'metalDark', surface: 'metal', cast: true, receive: true, tile: 0.85 },
	metalPainted: { mat: 'metalPainted', surface: 'metal', cast: true, receive: true, tile: 0.5 },
	rustMetal: { mat: 'rustMetal', surface: 'metal', cast: true, receive: true, tile: 0.45 },
	corrugated: { mat: 'corrugated', surface: 'metal', cast: true, receive: true, tile: 0.42 },
	wood: { mat: 'wood', surface: 'wood', cast: true, receive: true, tile: 0.62 },
	dirt: { mat: 'dirt', surface: 'dirt', cast: false, receive: true, tile: 0.33 },
	sand: { mat: 'sand', surface: 'sand', cast: false, receive: true, tile: 0.5 },
	glass: { mat: 'glass', surface: 'glass', cast: false, receive: false, tile: 0.5 },
	grate: { mat: 'grate', surface: 'metal', cast: true, receive: true, tile: 0.66 },
	tarp: { mat: 'tarp', surface: 'dirt', cast: true, receive: true, tile: 0.5 },

	// Shipping containers: same corrugated texture, three weathered paint jobs.
	// The tint is a LINEAR multiply on top of an already mid-dark albedo, so
	// these have to stay near-white with only a hue bias. Saturated tints here
	// (the first pass used 0x8f4433) drive the product below 0.01 linear and the
	// containers become black cut-outs the moment they face away from the sun.
	containerA: { mat: 'corrugated', surface: 'metal', cast: true, receive: true, tile: 0.42, tint: 0xf09a80 },
	containerB: { mat: 'corrugated', surface: 'metal', cast: true, receive: true, tile: 0.42, tint: 0x93cfc9 },
	containerC: { mat: 'corrugated', surface: 'metal', cast: true, receive: true, tile: 0.42, tint: 0xe4bd7e },

	// emissive trim + lamp lenses; these are what the bloom pass eats
	trimAmber: { emissive: [ 0xffa63c, 2.6 ], surface: 'metal', cast: false, receive: false, tile: 1 },
	trimRed: { emissive: [ 0xff2a1c, 3.4 ], surface: 'metal', cast: false, receive: false, tile: 1 },
	lampSodium: { emissive: [ 0xffb45a, 6.5 ], surface: 'glass', cast: false, receive: false, tile: 1 },
	lampCool: { emissive: [ 0xcfe8ff, 4.2 ], surface: 'glass', cast: false, receive: false, tile: 1 },
	lampExit: { emissive: [ 0x39ff9a, 3.0 ], surface: 'glass', cast: false, receive: false, tile: 1 },
};

// props built once, then stamped with InstancedMesh
const PROP_DEFS = {
	barrel: { group: 'rustMetal' },
	pallet: { group: 'wood' },
	crate: { group: 'wood' },
	barrier: { group: 'concrete' },
	sandbag: { group: 'sand' },
	spool: { group: 'wood' },
	post: { group: 'metalDark' },
	bollard: { group: 'metalPainted' },
	vent: { group: 'metal' },
	tyre: { group: 'tarp' },
};

// ---------------------------------------------------------------------------
// geometry helpers (load-time only; nothing here runs per frame)
// ---------------------------------------------------------------------------

const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _eul = new THREE.Euler();
const _pos = new THREE.Vector3();
const _one = new THREE.Vector3( 1, 1, 1 );

function xform( geo, x, y, z, rx = 0, ry = 0, rz = 0 ) {
	_eul.set( rx, ry, rz, 'YXZ' );
	_quat.setFromEuler( _eul );
	_mat4.compose( _pos.set( x, y, z ), _quat, _one );
	geo.applyMatrix4( _mat4 );
	return geo;
}

/**
 * World-space box projection. Because UVs are baked from final world position,
 * every merged piece tiles continuously with its neighbours and the shared
 * material can stay at repeat (1,1).
 */
function applyBoxUV( geo, tile ) {
	const pos = geo.attributes.position;
	const nor = geo.attributes.normal;
	const uv = geo.attributes.uv;
	const n = pos.count;
	for ( let i = 0; i < n; i ++ ) {
		const x = pos.getX( i ), y = pos.getY( i ), z = pos.getZ( i );
		const ax = Math.abs( nor.getX( i ) ), ay = Math.abs( nor.getY( i ) ), az = Math.abs( nor.getZ( i ) );
		let u, v;
		if ( ay >= ax && ay >= az ) { u = x; v = z; }
		else if ( ax >= az ) { u = z; v = y; }
		else { u = x; v = y; }
		uv.setXY( i, u * tile, v * tile );
	}
	uv.needsUpdate = true;
	return geo;
}

function scaleUV( geo, su, sv ) {
	const uv = geo.attributes.uv;
	for ( let i = 0; i < uv.count; i ++ ) uv.setXY( i, uv.getX( i ) * su, uv.getY( i ) * sv );
	return geo;
}

function aabb( w, h, d, x, y, z, ry ) {
	const c = Math.abs( Math.cos( ry ) ), s = Math.abs( Math.sin( ry ) );
	const hw = ( w * c + d * s ) * 0.5;
	const hd = ( w * s + d * c ) * 0.5;
	return new THREE.Box3(
		new THREE.Vector3( x - hw, y - h * 0.5, z - hd ),
		new THREE.Vector3( x + hw, y + h * 0.5, z + hd ),
	);
}

/** Three boxes standing in for a rolled I-section; reads correctly at gameplay distance. */
function iBeamGeometry( length, depth, flange, web, axis ) {
	const parts = [
		new THREE.BoxGeometry( length, web, flange ),
		new THREE.BoxGeometry( length, depth - web * 2, web ),
		new THREE.BoxGeometry( length, web, flange ),
	];
	parts[ 0 ].translate( 0, ( depth - web ) * 0.5, 0 );
	parts[ 2 ].translate( 0, - ( depth - web ) * 0.5, 0 );
	const g = mergeGeometries( parts );
	for ( const p of parts ) p.dispose();
	if ( axis === 'z' ) g.rotateY( HALF_PI );
	else if ( axis === 'y' ) g.rotateZ( HALF_PI );
	return g;
}

/** All shafts in one non-indexed buffer: two triangles each, one draw call. */
function buildShafts() {
	const n = SHAFT_DEFS.length;
	const V = n * 6;
	const corner = new Float32Array( V * 3 );
	const start = new Float32Array( V * 3 );
	const end = new Float32Array( V * 3 );
	const width = new Float32Array( V * 2 );
	const color = new Float32Array( V * 3 );
	const seed = new Float32Array( V );

	// u along the beam, v across it
	const QUAD = [ 0, - 0.5, 1, - 0.5, 1, 0.5, 0, - 0.5, 1, 0.5, 0, 0.5 ];
	const c = new THREE.Color();

	for ( let i = 0; i < n; i ++ ) {
		const d = SHAFT_DEFS[ i ];
		c.setHex( d[ 8 ] ).multiplyScalar( d[ 9 ] );
		for ( let k = 0; k < 6; k ++ ) {
			const o = ( i * 6 + k );
			corner[ o * 3 ] = QUAD[ k * 2 ];
			corner[ o * 3 + 1 ] = QUAD[ k * 2 + 1 ];
			corner[ o * 3 + 2 ] = 0;
			start[ o * 3 ] = d[ 0 ]; start[ o * 3 + 1 ] = d[ 1 ]; start[ o * 3 + 2 ] = d[ 2 ];
			end[ o * 3 ] = d[ 3 ]; end[ o * 3 + 1 ] = d[ 4 ]; end[ o * 3 + 2 ] = d[ 5 ];
			width[ o * 2 ] = d[ 6 ]; width[ o * 2 + 1 ] = d[ 7 ];
			color[ o * 3 ] = c.r; color[ o * 3 + 1 ] = c.g; color[ o * 3 + 2 ] = c.b;
			seed[ o ] = i * 1.618;
		}
	}

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.BufferAttribute( corner, 3 ) );
	g.setAttribute( 'aStart', new THREE.BufferAttribute( start, 3 ) );
	g.setAttribute( 'aEnd', new THREE.BufferAttribute( end, 3 ) );
	g.setAttribute( 'aW', new THREE.BufferAttribute( width, 2 ) );
	g.setAttribute( 'aColor', new THREE.BufferAttribute( color, 3 ) );
	g.setAttribute( 'aSeed', new THREE.BufferAttribute( seed, 1 ) );
	// vertices are placed entirely in the vertex shader, so the CPU-side bounds
	// are meaningless — cover the arena and never cull
	g.boundingSphere = new THREE.Sphere( new THREE.Vector3( - 12, 4, - 14 ), 60 );

	const material = new THREE.ShaderMaterial( {
		uniforms: {
			uTime: { value: 0 },
			// pushed over 1 on purpose: the shafts have to survive ACES and give
			// the bloom threshold something to catch
			uOpacity: { value: 1.35 },
		},
		vertexShader: SHAFT_VERT,
		fragmentShader: SHAFT_FRAG,
		transparent: true,
		blending: THREE.AdditiveBlending,
		depthWrite: false,
		depthTest: true,
		side: THREE.DoubleSide,
		fog: false,
	} );

	const mesh = new THREE.Mesh( g, material );
	mesh.name = 'lightShafts';
	mesh.frustumCulled = false;
	mesh.matrixAutoUpdate = false;
	mesh.renderOrder = 6;
	mesh.castShadow = false;
	mesh.receiveShadow = false;
	return mesh;
}

// ---------------------------------------------------------------------------

/**
 * @param {THREE.Scene} scene
 * @param {object} matlib result of createMaterialLibrary()
 * @returns World (see CONTRACT.md)
 */
export function buildMap( scene, matlib ) {

	const root = new THREE.Group();
	root.name = 'tideworks';
	scene.add( root );

	const colliders = [];
	const hitMeshes = [];
	const coverPoints = [];
	const enemySpawns = [];
	const minimapWalls = [];
	const materials = {};

	// ---- accumulation ------------------------------------------------------

	const buckets = new Map();
	function bucket( key ) {
		let b = buckets.get( key );
		if ( ! b ) { b = []; buckets.set( key, b ); }
		return b;
	}

	function materialFor( key ) {
		if ( materials[ key ] ) return materials[ key ];
		const def = GROUP_DEFS[ key ];
		let m;
		if ( def.emissive ) {
			m = matlib.emissive( def.emissive[ 0 ], def.emissive[ 1 ] );
		} else if ( def.tint !== undefined ) {
			m = matlib[ def.mat ].clone();
			m.color.setHex( def.tint );
		} else {
			m = matlib[ def.mat ];
		}
		materials[ key ] = m;
		return m;
	}

	/** Box, world-placed, merged into `key`. Adds an AABB collider unless ghost. */
	function box( key, w, h, d, x, y, z, ry = 0, ghost = false, tile = 0 ) {
		const def = GROUP_DEFS[ key ];
		const g = new THREE.BoxGeometry( w, h, d );
		xform( g, x, y, z, 0, ry, 0 );
		applyBoxUV( g, tile || def.tile );
		bucket( key ).push( g );
		if ( ! ghost ) colliders.push( aabb( w, h, d, x, y, z, ry ) );
		return g;
	}

	/** Same, but free to rotate on all three axes; never auto-collides. */
	function slab( key, w, h, d, x, y, z, rx, ry, rz, tile = 0 ) {
		const def = GROUP_DEFS[ key ];
		const g = new THREE.BoxGeometry( w, h, d );
		xform( g, x, y, z, rx, ry, rz );
		applyBoxUV( g, tile || def.tile );
		bucket( key ).push( g );
		return g;
	}

	function cylinder( key, rt, rb, h, seg, x, y, z, rx = 0, ry = 0, rz = 0, tile = 0 ) {
		const def = GROUP_DEFS[ key ];
		const g = new THREE.CylinderGeometry( rt, rb, h, seg, 1, false );
		xform( g, x, y, z, rx, ry, rz );
		applyBoxUV( g, tile || def.tile );
		bucket( key ).push( g );
		return g;
	}

	function beam( key, length, depth, flange, web, axis, x, y, z ) {
		const def = GROUP_DEFS[ key ];
		const g = iBeamGeometry( length, depth, flange, web, axis );
		xform( g, x, y, z );
		applyBoxUV( g, def.tile );
		bucket( key ).push( g );
		return g;
	}

	function collider( minX, minY, minZ, maxX, maxY, maxZ ) {
		colliders.push( new THREE.Box3(
			new THREE.Vector3( minX, minY, minZ ),
			new THREE.Vector3( maxX, maxY, maxZ ),
		) );
	}

	function wallFootprint( x, z, w, h, rot = 0 ) {
		minimapWalls.push( { x, z, w, h, rot } );
	}

	// prop instance lists
	const propXforms = {};
	for ( const k in PROP_DEFS ) propXforms[ k ] = [];
	function prop( kind, x, y, z, ry = 0, s = 1, rx = 0, rz = 0 ) {
		propXforms[ kind ].push( { x, y, z, rx, ry, rz, s } );
	}

	// =======================================================================
	// GROUND
	// =======================================================================

	const CH_N = 8.5, CH_S = 11.5, CH_FLOOR = - 0.85, CH_END = 28;

	// asphalt base, split around the drainage channel so the trench is a real
	// hole in the collision volume rather than a decal
	box( 'asphalt', 62, 1.2, 39.5, 0, - 0.6, ( - 31 + CH_N ) * 0.5, 0, true );
	box( 'asphalt', 62, 1.2, 19.5, 0, - 0.6, ( CH_S + 31 ) * 0.5, 0, true );
	box( 'asphalt', 3, 1.2, 3, 29.5, - 0.6, 10, 0, true );
	collider( - 31, - 3, - 31, 31, 0, CH_N );
	collider( - 31, - 3, CH_S, 31, 0, 31 );
	collider( CH_END, - 3, CH_N, 31, 0, CH_S );

	// channel bed
	box( 'concreteDark', 59, 1.0, 3, - 1.5, CH_FLOOR - 0.5, 10, 0, true );
	collider( - 31, - 3, CH_N, CH_END, CH_FLOOR, CH_S );
	// silt + standing water down the middle
	slab( 'dirt', 58, 0.06, 1.3, - 1.5, CH_FLOOR + 0.02, 10, 0, 0, 0 );
	// liner lips so the trench edge catches the sun
	slab( 'concreteDark', 58, 0.85, 0.18, - 1.5, CH_FLOOR + 0.42, CH_N + 0.09, 0, 0, 0 );
	slab( 'concreteDark', 58, 0.85, 0.18, - 1.5, CH_FLOOR + 0.42, CH_S - 0.09, 0, 0, 0 );

	// floor overlays: value separation between the three lanes
	slab( 'concreteDark', 22, 0.08, 28, - 19, 0.02, - 16, 0, 0, 0 );  // warehouse
	slab( 'concrete', 12, 0.08, 20.5, - 2, 0.02, - 1.75, 0, 0, 0 );   // courtyard
	slab( 'concrete', 9, 0.08, 7, 6, 0.035, - 14, 0, 0, 0 );          // crane footing apron

	// sand drifts blown up against the south wall
	slab( 'sand', 13, 0.16, 4.5, - 12, 0.04, 27.4, 0, 0, 0 );
	slab( 'sand', 9, 0.14, 3.6, 9, 0.03, 27.8, 0, 0.06, 0 );

	// =======================================================================
	// PERIMETER
	// =======================================================================

	box( 'concrete', 61.2, 7.0, 0.6, 0, 3.5, - 30.3 );
	box( 'concrete', 0.6, 7.0, 61.2, - 30.3, 3.5, 0 );
	box( 'concrete', 0.6, 6.0, 61.2, 30.3, 3.0, 0 );
	box( 'concrete', 61.2, 1.7, 0.6, 0, 0.85, 30.3 );  // low seawall: sky reads behind it

	wallFootprint( 0, - 30.3, 61.2, 0.6 );
	wallFootprint( - 30.3, 0, 0.6, 61.2 );
	wallFootprint( 30.3, 0, 0.6, 61.2 );
	wallFootprint( 0, 30.3, 61.2, 0.6 );

	// invisible ceiling-height perimeter so nobody vaults the seawall
	collider( - 31.6, 0, - 31.6, - 30.3, 14, 31.6 );
	collider( 30.3, 0, - 31.6, 31.6, 14, 31.6 );
	collider( - 31.6, 0, - 31.6, 31.6, 14, - 30.3 );
	collider( - 31.6, 0, 30.3, 31.6, 14, 31.6 );

	// mooring pylons along the seawall — pure silhouette against the dusk sky
	for ( const px of [ - 21, - 7, 8, 22 ] ) {
		box( 'rustMetal', 0.44, 5.4, 0.44, px, 2.7, 29.4 );
		slab( 'metalDark', 0.7, 0.16, 0.7, px, 5.42, 29.4, 0, 0.4, 0 );
	}
	slab( 'trimRed', 0.22, 0.22, 0.22, - 7, 5.62, 29.4, 0, 0, 0 );
	slab( 'trimRed', 0.22, 0.22, 0.22, 22, 5.62, 29.4, 0, 0, 0 );

	// =======================================================================
	// LANE B — WAREHOUSE  (x -30..-8, z -30..-2, eaves at y = 7)
	// =======================================================================

	const WH_E = - 8, WH_S = - 2, WH_ROOF = 7.0;

	// -- east wall: concrete plinth to 2.2, corrugated above, with two openings
	function eastWallSegment( z0, z1, opts = {} ) {
		const d = z1 - z0, cz = ( z0 + z1 ) * 0.5;
		if ( ! opts.noPlinth ) box( 'concrete', 0.5, 2.2, d, WH_E, 1.1, cz );
		const top = opts.top !== undefined ? opts.top : 2.2;
		if ( top < WH_ROOF ) box( 'corrugated', 0.42, WH_ROOF - top, d, WH_E, ( WH_ROOF + top ) * 0.5, cz );
		wallFootprint( WH_E, cz, 0.5, d );
	}
	eastWallSegment( - 30, - 29.2 );
	eastWallSegment( - 29.2, - 26.8, { top: 6.4 } );  // catwalk passes through here
	eastWallSegment( - 26.8, - 25.5 );
	eastWallSegment( - 25.5, - 24.2, { noPlinth: true, top: 2.3 } ); // personnel door
	box( 'metalPainted', 0.14, 2.3, 1.3, WH_E - 0.28, 1.15, - 24.85, 0, true ); // the door itself, ajar
	eastWallSegment( - 24.2, - 17 );
	eastWallSegment( - 17, - 11.5, { noPlinth: true, top: 5.0 } );   // roll-up bay
	eastWallSegment( - 11.5, WH_S );

	// bay door rolled half open, hanging just inside the opening
	slab( 'corrugated', 0.3, 1.1, 5.4, WH_E - 0.45, 5.6, - 14.25, 0, 0, 0 );
	slab( 'metalDark', 0.42, 0.16, 5.6, WH_E - 0.45, 5.02, - 14.25, 0, 0, 0 );

	// -- south wall with a 6m gap
	box( 'concrete', 8, 2.2, 0.5, - 26, 1.1, WH_S );
	box( 'corrugated', 8, 4.8, 0.42, - 26, 4.6, WH_S );
	box( 'concrete', 8, 2.2, 0.5, - 12, 1.1, WH_S );
	box( 'corrugated', 8, 4.8, 0.42, - 12, 4.6, WH_S );
	box( 'corrugated', 6, 2.5, 0.42, - 20, 5.75, WH_S );  // lintel over the gap
	wallFootprint( - 26, WH_S, 8, 0.5 );
	wallFootprint( - 12, WH_S, 8, 0.5 );

	// -- corrugated roof with gaps that spear light onto the floor
	const ROOF_BANDS = [
		[ - 30, - 25.25 ], [ - 23.75, - 17.25 ], [ - 15.75, - 9.25 ], [ - 7.75, - 2 ],
	];
	for ( let i = 0; i < ROOF_BANDS.length; i ++ ) {
		const [ z0, z1 ] = ROOF_BANDS[ i ];
		if ( i === 2 ) {
			// a whole panel is missing here: the big shaft lands mid-floor
			slab( 'corrugated', 13, 0.22, z1 - z0, - 23.5, WH_ROOF, ( z0 + z1 ) * 0.5, 0, 0, 0 );
			slab( 'corrugated', 5, 0.22, z1 - z0, - 10.5, WH_ROOF, ( z0 + z1 ) * 0.5, 0, 0, 0 );
		} else {
			slab( 'corrugated', 22, 0.22, z1 - z0, - 19, WH_ROOF, ( z0 + z1 ) * 0.5, 0, 0, 0 );
		}
		// purlin under each band
		slab( 'metalDark', 22, 0.12, 0.12, - 19, WH_ROOF - 0.2, z0 + 0.6, 0, 0, 0 );
	}

	// -- roof trusses + columns
	for ( const tz of [ - 27, - 21, - 13.5, - 6 ] ) {
		beam( 'metalPainted', 22, 0.55, 0.34, 0.06, 'x', - 19, WH_ROOF - 0.5, tz );
	}
	for ( const cx of [ - 24, - 14 ] ) {
		for ( const cz of [ - 25, - 16, - 6 ] ) {
			beam( 'metalPainted', 6.5, 0.4, 0.28, 0.06, 'y', cx, 3.25, cz );
			collider( cx - 0.2, 0, cz - 0.2, cx + 0.2, 6.5, cz + 0.2 );
			box( 'concrete', 0.9, 0.35, 0.9, cx, 0.16, cz, 0, true );
			wallFootprint( cx, cz, 0.5, 0.5 );
		}
	}

	// -- pipe run along the inside of the east wall
	for ( let i = 0; i < 3; i ++ ) {
		const py = 3.1 + i * 0.42;
		cylinder( 'metalDark', 0.09 + i * 0.02, 0.09 + i * 0.02, 26, 8, WH_E - 0.55 - i * 0.24, py, - 16, HALF_PI, 0, 0 );
	}
	for ( const bz of [ - 27, - 20, - 12, - 5 ] ) {
		slab( 'rustMetal', 1.1, 0.1, 0.14, WH_E - 1.0, 3.72, bz, 0, 0, 0 );
	}

	// -- ventilation duct hugging the north wall, then branching south
	slab( 'metal', 20, 0.7, 0.7, - 19, 5.7, - 29.4, 0, 0, 0 );
	slab( 'metal', 0.62, 0.62, 21, - 12.5, 5.7, - 18.6, 0, 0, 0 );
	slab( 'metal', 0.8, 0.8, 0.8, - 12.5, 5.7, - 29.4, 0, 0.4, 0 );
	for ( const dz of [ - 24, - 16, - 9.5 ] ) {
		slab( 'metal', 0.34, 0.7, 0.34, - 12.5, 5.15, dz, 0, 0, 0 );
		slab( 'metalDark', 0.5, 0.08, 0.5, - 12.5, 4.78, dz, 0, 0, 0 );
	}

	// =======================================================================
	// LANE C — MEZZANINE, CATWALK, CRANE DECK  (y = 4.4)
	// =======================================================================

	const DECK = 4.4;

	// -- mezzanine along the west wall
	box( 'metalPainted', 5, 0.2, 26, - 27.5, DECK - 0.1, - 17, 0, true );
	collider( - 30, DECK - 0.2, - 30, - 25, DECK, - 4 );
	for ( const sz of [ - 28, - 22, - 16, - 10, - 5 ] ) {
		beam( 'metalPainted', DECK, 0.3, 0.22, 0.05, 'y', - 25.3, DECK * 0.5, sz );
		slab( 'metalPainted', 4.6, 0.12, 0.18, - 27.6, DECK - 0.28, sz, 0, 0, 0 );
	}

	// -- catwalk east through the wall and out over the yard
	box( 'metalPainted', 17, 0.16, 2, - 16.5, DECK - 0.08, - 28, 0, true );
	collider( - 25, DECK - 0.16, - 29, - 8, DECK, - 27 );
	box( 'grate', 14, 0.1, 2, - 1, DECK - 0.05, - 28, 0, true );
	collider( - 8, DECK - 0.16, - 29, 6, DECK, - 27 );
	// -- catwalk south leg
	box( 'grate', 2, 0.1, 13, 6, DECK - 0.05, - 20.5, 0, true );
	collider( 5, DECK - 0.16, - 27, 7, DECK, - 14 );

	// catwalk stringers + hangers
	for ( let x = - 7; x <= 5; x += 3 ) {
		slab( 'metalDark', 0.1, 0.1, 2.2, x, DECK - 0.18, - 28, 0, 0, 0 );
	}
	slab( 'metalDark', 14.4, 0.14, 0.14, - 1, DECK - 0.2, - 29, 0, 0, 0 );
	slab( 'metalDark', 14.4, 0.14, 0.14, - 1, DECK - 0.2, - 27, 0, 0, 0 );
	// header on the north wall the outdoor span hangs from
	slab( 'metalDark', 14.4, 0.16, 0.16, - 1, 7.6, - 29.9, 0, 0, 0 );
	for ( const hx of [ - 5.5, - 1, 3.5 ] ) {
		cylinder( 'metalDark', 0.05, 0.05, 3.2, 6, hx, DECK + 1.6, - 29.9 );
		slab( 'metalDark', 0.6, 0.1, 0.1, hx, 7.6, - 30.1, 0, 0, 0 );
	}

	// -- crane deck
	box( 'metalPainted', 5, 0.18, 4.5, 6, DECK - 0.09, - 14.25, 0, true );
	collider( 3.5, DECK - 0.18, - 16.5, 8.5, DECK, - 12 );

	// -- rusted crane base lattice holding the deck up
	for ( const lx of [ 4.1, 7.9 ] ) {
		for ( const lz of [ - 16.1, - 12.4 ] ) {
			box( 'rustMetal', 0.32, DECK, 0.32, lx, DECK * 0.5, lz );
			wallFootprint( lx, lz, 0.32, 0.32 );
		}
		slab( 'rustMetal', 0.16, 0.16, 4.3, lx, 2.6, - 14.25, 0.72, 0, 0 );
		slab( 'rustMetal', 0.16, 0.16, 4.3, lx, 2.6, - 14.25, - 0.72, 0, 0 );
	}
	slab( 'rustMetal', 3.9, 0.16, 0.16, 6, 2.2, - 16.1, 0, 0, 0 );
	slab( 'rustMetal', 3.9, 0.16, 0.16, 6, 2.2, - 12.4, 0, 0, 0 );
	// the boom stub, snapped off
	slab( 'rustMetal', 0.5, 0.5, 7, 6, 5.4, - 17.6, 0.28, 0, 0 );

	// -- gantry support columns out in the yard
	for ( const gx of [ - 2.5, 3 ] ) {
		box( 'rustMetal', 0.36, DECK, 0.36, gx, DECK * 0.5, - 28.6 );
		slab( 'rustMetal', 0.14, 0.14, 2.6, gx, 3.4, - 28.6, 0, 0, 0.6 );
	}

	// -- stairs up to the mezzanine (solid risers double as clean AABBs)
	for ( let i = 0; i < 11; i ++ ) {
		const h = 0.4 * ( i + 1 );
		const cx = - 18.4 - 0.6 * ( i + 0.5 );
		box( 'metalPainted', 0.6, h, 1.8, cx, h * 0.5, - 8.7 );
	}
	slab( 'metalDark', 7.95, 0.1, 0.1, - 21.7, 3.18, - 7.75, 0, 0, - 0.588 );
	slab( 'metalDark', 7.95, 0.09, 0.09, - 21.7, 2.68, - 7.75, 0, 0, - 0.588 );
	for ( let i = 0; i < 6; i ++ ) {
		const cx = - 18.7 - i * 1.2;
		const h = 0.4 * ( ( - cx - 18.4 ) / 0.6 );
		prop( 'post', cx, h, - 7.78, 0, 1 );
	}

	// -- ramp from the yard up to the crane deck (visual smooth, collision stepped)
	slab( 'metalPainted', 2.4, 0.22, 10.05, 6, 2.25, - 7.5, 0.4494, 0, 0 );
	for ( let i = 0; i < 8; i ++ ) {
		const t0 = i / 8, t1 = ( i + 1 ) / 8;
		const z0 = - 3 - 9 * t1, z1 = - 3 - 9 * t0;
		collider( 4.8, 0, z0, 7.2, DECK * t1 + 0.05, z1 );
	}
	for ( let i = 0; i <= 6; i ++ ) {
		const t = i / 6;
		const z = - 3 - 9 * t;
		prop( 'post', 4.85, DECK * t, z, 0, 1 );
		prop( 'post', 7.15, DECK * t, z, 0, 1 );
	}
	slab( 'metalDark', 0.09, 0.09, 10.2, 4.85, 3.3, - 7.5, 0.4494, 0, 0 );
	slab( 'metalDark', 0.09, 0.09, 10.2, 7.15, 3.3, - 7.5, 0.4494, 0, 0 );

	// -- railings: posts are instanced, rails are merged straight runs
	function railRun( x0, z0, x1, z1, y, spacing = 1.7 ) {
		const dx = x1 - x0, dz = z1 - z0;
		const len = Math.hypot( dx, dz );
		const ry = Math.atan2( dx, dz );
		const cx = ( x0 + x1 ) * 0.5, cz = ( z0 + z1 ) * 0.5;
		slab( 'metalDark', 0.07, 0.07, len, cx, y + 1.02, cz, 0, ry, 0 );
		slab( 'metalDark', 0.06, 0.06, len, cx, y + 0.55, cz, 0, ry, 0 );
		const n = Math.max( 2, Math.round( len / spacing ) );
		for ( let i = 0; i <= n; i ++ ) {
			const t = i / n;
			prop( 'post', x0 + dx * t, y, z0 + dz * t, ry, 1 );
		}
		// chain-link infill on the outward-facing runs
		slab( 'grate', 0.02, 0.9, len, cx, y + 0.55, cz, 0, ry, 0, 0.9 );
		// railings are solid: falling off the gantry has to be a deliberate act
		colliders.push( aabb( 0.14, 1.1, len, cx, y + 0.55, cz, ry ) );
	}

	railRun( - 25, - 27, - 25, - 4, DECK );          // mezzanine east edge (gap at the catwalk)
	railRun( - 30, - 4, - 25, - 4, DECK );           // mezzanine south edge
	railRun( - 25, - 29, 6, - 29, DECK );            // catwalk north
	railRun( - 8, - 27, 5, - 27, DECK );             // catwalk south (over the yard)
	railRun( 7, - 27, 7, - 12, DECK );               // south leg east
	railRun( 5, - 17, 5, - 14, DECK );               // south leg west (partial: entry gap)
	railRun( 3.5, - 16.5, 3.5, - 12, DECK );         // crane deck west
	railRun( 3.5, - 12, 4.8, - 12, DECK );           // crane deck south lip
	railRun( 7.2, - 12, 8.5, - 12, DECK );
	railRun( 8.5, - 16.5, 8.5, - 12, DECK );

	// -- emissive trim so the gantry silhouette reads at range
	slab( 'trimAmber', 30.8, 0.05, 0.06, - 9.6, DECK - 0.16, - 29.02, 0, 0, 0 );
	slab( 'trimAmber', 0.06, 0.05, 13, 7.02, DECK - 0.16, - 20.5, 0, 0, 0 );
	slab( 'trimAmber', 5, 0.05, 0.06, - 27.5, DECK - 0.22, - 4.03, 0, 0, 0 );

	// =======================================================================
	// SITE OFFICE — blocks the straight line from the bay door to the north yard
	// =======================================================================

	const OF = { x0: - 7.5, x1: - 2.5, z0: - 24, z1: - 19.5, h: 3.1 };
	const ofw = OF.x1 - OF.x0, ofd = OF.z1 - OF.z0;
	const ofcx = ( OF.x0 + OF.x1 ) * 0.5, ofcz = ( OF.z0 + OF.z1 ) * 0.5;

	box( 'concrete', ofw, 0.5, ofd, ofcx, 0.25, ofcz, 0, true );
	collider( OF.x0, 0, OF.z0, OF.x1, 0.5, OF.z1 );
	// walls: plinth + plaster, with two window bands
	box( 'plaster', ofw, OF.h, 0.28, ofcx, 0.5 + OF.h * 0.5, OF.z0 );
	box( 'plaster', 0.28, OF.h, ofd, OF.x0, 0.5 + OF.h * 0.5, ofcz );
	box( 'plaster', 0.28, OF.h, ofd, OF.x1, 0.5 + OF.h * 0.5, ofcz );
	box( 'plaster', ofw, 0.9, 0.28, ofcx, 0.95, OF.z1 );
	box( 'plaster', ofw, 1.0, 0.28, ofcx, 3.1, OF.z1 );
	box( 'plaster', 1.4, 1.2, 0.28, ofcx - 1.8, 2.0, OF.z1 );
	slab( 'glass', 3.4, 1.2, 0.06, ofcx + 0.7, 2.0, OF.z1, 0, 0, 0 );
	slab( 'metalDark', 3.6, 1.34, 0.1, ofcx + 0.7, 2.0, OF.z1 + 0.06, 0, 0, 0 );
	box( 'concreteDark', ofw + 0.4, 0.24, ofd + 0.4, ofcx, 0.5 + OF.h + 0.12, ofcz );
	slab( 'metalDark', ofw + 0.5, 0.12, 0.12, ofcx, 0.5 + OF.h + 0.28, OF.z1 + 0.2, 0, 0, 0 );
	wallFootprint( ofcx, ofcz, ofw, ofd );
	slab( 'lampExit', 0.5, 0.16, 0.05, ofcx - 1.8, 3.05, OF.z1 - 0.16, 0, 0, 0 );
	prop( 'vent', ofcx + 1.4, 0.5 + OF.h + 0.24, ofcz - 0.8, 0.3, 1 );

	// tarp thrown over a pile of gear beside the office
	slab( 'tarp', 3.2, 1.1, 2.6, - 5.4, 0.55, - 17.2, 0.06, 0.4, - 0.05 );
	collider( - 7, 0, - 18.5, - 3.8, 1.1, - 15.9 );

	// =======================================================================
	// LANE A — CONTAINER YARD
	// =======================================================================

	const CONTAINERS = [
		[ 10.5, - 22.0, 0.03, 0, 'A' ],
		[ 10.5, - 22.0, 0.07, 1, 'B' ],
		[ 18.0, - 23.5, HALF_PI + 0.04, 0, 'C' ],
		[ 25.2, - 20.0, 0.02, 0, 'B' ],
		[ 24.6, - 11.0, HALF_PI - 0.05, 0, 'A' ],
		[ 24.6, - 11.0, HALF_PI - 0.01, 1, 'C' ],
		[ 15.5, - 8.5, - 0.30, 0, 'B' ],
		[ 11.0, - 2.0, HALF_PI + 0.08, 0, 'C' ],
		[ 19.0, 1.5, 0.05, 0, 'A' ],
		[ 19.0, 1.5, 0.02, 1, 'B' ],
		[ 26.6, 4.5, HALF_PI, 0, 'C' ],
		[ 9.0, 5.0, 0.10, 0, 'B' ],
		[ 23.0, 15.0, HALF_PI - 0.12, 0, 'A' ],
		[ 14.0, 18.0, 0.06, 0, 'C' ],
		[ 14.0, 18.0, 0.03, 1, 'A' ],
		[ 24.0, 24.0, 0.20, 0, 'B' ],
		[ 7.0, 24.0, HALF_PI + 0.06, 0, 'C' ],
	];

	const CL = 6.06, CH = 2.59, CW = 2.44;
	for ( const [ cx, cz, ry, level, tone ] of CONTAINERS ) {
		const key = 'container' + tone;
		const y = level * ( CH + 0.03 ) + CH * 0.5;
		box( key, CL, CH, CW, cx, y, cz, ry );
		// door end: flat plate + locking bars, so one end reads differently
		const ex = cx + Math.cos( ry ) * ( CL * 0.5 + 0.03 );
		const ez = cz - Math.sin( ry ) * ( CL * 0.5 + 0.03 );
		slab( 'rustMetal', 0.08, CH * 0.94, CW * 0.96, ex, y, ez, 0, ry, 0 );
		for ( const off of [ - 0.55, - 0.2, 0.2, 0.55 ] ) {
			slab( 'metalDark', 0.1, CH * 0.9, 0.07,
				ex + Math.sin( ry ) * off * CW, y, ez + Math.cos( ry ) * off * CW, 0, ry, 0 );
		}
		// top + bottom corner rails
		slab( 'metalDark', CL + 0.12, 0.14, CW + 0.12, cx, y + CH * 0.5 - 0.05, cz, 0, ry, 0 );
		slab( 'metalDark', CL + 0.12, 0.14, CW + 0.12, cx, y - CH * 0.5 + 0.05, cz, 0, ry, 0 );
		wallFootprint( cx, cz, CL, CW, ry );
	}

	// Crate staircase onto the northern container roofs — the yard's only
	// intentional way up, deliberately slow and completely exposed to the
	// gantry. Rises 0.52 -> 1.2 -> 1.7 -> 2.4 -> 2.59 (container deck).
	prop( 'pallet', 6.2, 0.075, - 19.0, 0.10, 1 );
	prop( 'pallet', 6.2, 0.225, - 19.0, 0.40, 1 );
	prop( 'pallet', 6.2, 0.375, - 19.0, 0.05, 1 );
	collider( 5.6, 0, - 19.6, 6.8, 0.52, - 18.4 );
	prop( 'crate', 7.4, 0.6, - 19.7, 0.2, 1 );
	prop( 'pallet', 7.4, 1.34, - 19.7, 0.5, 1 );
	prop( 'pallet', 7.4, 1.49, - 19.7, 0.15, 1 );
	collider( 6.8, 0, - 20.3, 8.0, 1.66, - 19.1 );
	prop( 'crate', 8.7, 0.6, - 19.9, - 0.15, 1 );
	prop( 'crate', 8.7, 1.8, - 19.9, 0.35, 1 );
	collider( 8.1, 0, - 20.5, 9.3, 2.4, - 19.3 );

	// second climb in the south: crate stack against the container at (14, 18)
	prop( 'pallet', 8.6, 0.075, 17.5, 0.3, 1 );
	prop( 'pallet', 8.6, 0.225, 17.5, 0.6, 1 );
	collider( 8.0, 0, 16.9, 9.2, 0.37, 18.1 );
	prop( 'crate', 9.8, 0.6, 17.5, 0.25, 1 );
	prop( 'crate', 9.8, 1.8, 17.5, 0.55, 1 );
	collider( 9.2, 0, 16.9, 10.4, 2.4, 18.1 );
	prop( 'spool', 12.4, 0.55, 14.0, 0.4, 1 );
	colliders.push( aabb( 2.1, 1.1, 2.1, 12.4, 0.55, 14.0, 0 ) );

	// =======================================================================
	// COURTYARD + YARD CLUTTER
	// =======================================================================

	// jersey barriers: profile is three stacked boxes, instanced
	const BARRIERS = [
		[ - 5.5, 2.0, 0.05 ], [ - 3.2, 2.2, 0.05 ], [ - 0.9, 2.4, 0.02 ],
		[ - 6.0, - 8.5, HALF_PI ], [ - 6.0, - 6.2, HALF_PI ],
		[ 2.4, - 4.0, 0.6 ], [ 3.9, - 1.6, 0.75 ],
		[ 16.5, - 15.0, 0.0 ], [ 18.8, - 15.1, 0.03 ],
		[ 21.5, 8.0, HALF_PI + 0.1 ], [ 21.4, 10.4, HALF_PI ],
		[ - 14.0, 14.0, 0.1 ], [ - 11.6, 14.2, 0.05 ],
	];
	for ( const [ bx, bz, bry ] of BARRIERS ) {
		prop( 'barrier', bx, 0, bz, bry, 1 );
		colliders.push( aabb( 2.2, 0.9, 0.62, bx, 0.45, bz, bry ) );
		wallFootprint( bx, bz, 2.2, 0.62, bry );
	}

	// sandbag emplacements: three horseshoes on the walkable floor
	const BAG_NESTS = [ [ - 3.0, 6.5, 0.3 ], [ 13.5, - 12.5, - 0.5 ], [ - 17.0, 5.0, 1.9 ] ];
	for ( const [ nx, nz, nrot ] of BAG_NESTS ) {
		for ( let row = 0; row < 3; row ++ ) {
			const count = 5 - row;
			for ( let i = 0; i < count; i ++ ) {
				const a = nrot + ( i - ( count - 1 ) * 0.5 ) * 0.42;
				const rr = 1.5;
				prop( 'sandbag',
					nx + Math.cos( a ) * rr, 0.13 + row * 0.24, nz + Math.sin( a ) * rr,
					a + HALF_PI + ( i % 2 ) * 0.12, 1 );
			}
		}
		colliders.push( aabb( 2.9, 0.86, 1.4,
			nx + Math.cos( nrot ) * 1.45, 0.43, nz + Math.sin( nrot ) * 1.45, nrot + HALF_PI ) );
	}

	// barrels — clustered where they read as cover, scattered where they read as noise
	const BARRELS = [
		[ - 4.2, - 10.5 ], [ - 3.4, - 11.2 ], [ - 4.6, - 11.6 ],
		[ 2.0, 4.5 ], [ 2.9, 5.1 ], [ 2.2, 5.6 ],
		[ 16.2, - 3.0 ], [ 17.0, - 3.6 ], [ 16.4, - 4.2 ], [ 17.4, - 2.6 ],
		[ - 22.5, - 12.0 ], [ - 21.7, - 12.6 ], [ - 22.9, - 13.0 ],
		[ - 16.0, - 27.0 ], [ - 15.2, - 26.4 ],
		[ 26.0, - 26.0 ], [ 27.0, - 25.2 ],
		[ 8.0, 13.5 ], [ 8.9, 14.1 ],
		[ - 26.0, 20.0 ], [ - 25.1, 20.6 ], [ - 26.4, 21.0 ],
		[ 20.0, 21.0 ], [ 20.9, 21.6 ],
	];
	for ( let i = 0; i < BARRELS.length; i ++ ) {
		const [ bx, bz ] = BARRELS[ i ];
		const tipped = i % 9 === 4;
		if ( tipped ) {
			prop( 'barrel', bx, 0.31, bz, i * 0.7, 1, 0, HALF_PI );
			colliders.push( aabb( 0.9, 0.62, 0.62, bx, 0.31, bz, 0 ) );
		} else {
			prop( 'barrel', bx, 0.44, bz, i * 1.1, 1 );
			colliders.push( aabb( 0.62, 0.88, 0.62, bx, 0.44, bz, 0 ) );
		}
	}

	// pallets and crates
	const PALLETS = [
		[ - 20.0, - 24.0, 0.1 ], [ - 20.0, - 24.0, 0.32 ], [ - 18.6, - 23.2, 0.5 ],
		[ - 12.5, - 10.0, 1.2 ], [ - 12.5, - 10.0, 1.35 ],
		[ 22.0, - 6.0, 0.4 ], [ 22.0, - 6.0, 0.55 ], [ 23.3, - 5.2, 0.2 ],
		[ - 27.5, - 8.0, 0.9 ], [ 12.0, - 26.5, 0.3 ], [ 12.0, - 26.5, 0.48 ],
		[ - 2.0, 16.0, 0.7 ], [ 17.0, 25.0, 0.25 ], [ - 22.0, 26.0, 1.1 ],
	];
	for ( let i = 0; i < PALLETS.length; i ++ ) {
		const [ px, pz, pry ] = PALLETS[ i ];
		const stacked = i > 0 && PALLETS[ i - 1 ][ 0 ] === px && PALLETS[ i - 1 ][ 1 ] === pz;
		prop( 'pallet', px, stacked ? 0.225 : 0.075, pz, pry, 1 );
		if ( ! stacked ) colliders.push( aabb( 1.2, 0.4, 1.0, px, 0.2, pz, pry ) );
	}

	const CRATES = [
		[ - 23.0, - 20.0, 0.2, 0 ], [ - 23.0, - 20.0, 0.45, 1 ], [ - 21.6, - 19.4, 0.05, 0 ],
		[ - 11.0, - 25.5, 0.6, 0 ], [ - 11.0, - 25.5, 0.9, 1 ],
		[ - 28.0, - 14.0, 0.15, 0 ], [ - 26.7, - 14.6, 0.4, 0 ],
		[ 0.5, - 9.0, 0.35, 0 ], [ 0.5, - 9.0, 0.7, 1 ],
		[ 27.0, 16.0, 0.5, 0 ], [ 25.8, 17.0, 0.1, 0 ],
		[ - 8.0, 22.0, 0.25, 0 ], [ - 8.0, 22.0, 0.55, 1 ], [ - 6.6, 22.6, 0.4, 0 ],
		[ 4.0, - 24.0, 0.3, 0 ], [ 5.2, - 24.6, 0.65, 0 ],
	];
	for ( const [ cx2, cz2, cry, lvl ] of CRATES ) {
		prop( 'crate', cx2, 0.6 + lvl * 1.2, cz2, cry, 1 );
		if ( lvl === 0 ) colliders.push( aabb( 1.2, 1.2, 1.2, cx2, 0.6, cz2, cry ) );
		else colliders.push( aabb( 1.2, 1.2, 1.2, cx2, 1.8, cz2, cry ) );
	}

	// cable spools
	const SPOOLS = [ [ - 1.5, - 5.0, 0.3 ], [ 19.5, - 19.0, 1.1 ], [ - 24.0, 1.5, 0.6 ],
		[ 3.0, 20.0, 0.2 ], [ 28.0, - 2.0, 0.9 ] ];
	for ( const [ sx, sz, sry ] of SPOOLS ) {
		prop( 'spool', sx, 0.55, sz, sry, 1 );
		colliders.push( aabb( 2.1, 1.1, 2.1, sx, 0.55, sz, 0 ) );
	}

	// bollards + tyres: pure silhouette noise, no collision needed
	for ( const [ bx, bz ] of [ [ - 8.6, - 6.0 ], [ - 8.6, - 3.4 ], [ 1.6, - 18.0 ], [ 1.6, - 15.4 ],
		[ 10.0, 9.4 ], [ 13.0, 9.4 ], [ 16.0, 9.4 ], [ - 10.0, 12.6 ], [ - 13.0, 12.6 ],
		[ 26.0, - 29.0 ], [ - 29.0, 12.0 ], [ 29.0, 26.0 ] ] ) {
		prop( 'bollard', bx, 0.45, bz, 0, 1 );
	}
	for ( const [ tx, tz, tr ] of [ [ - 6.0, 10.0, 0.2 ], [ - 5.2, 10.6, 1.1 ], [ 15.0, 5.0, 0.6 ],
		[ 15.7, 5.7, 0.3 ], [ - 19.0, 22.0, 0.9 ], [ 22.0, - 28.5, 0.4 ], [ 9.5, - 12.0, 0.7 ],
		[ - 28.0, - 3.0, 1.4 ], [ 3.4, 27.0, 0.2 ], [ 27.5, 10.5, 1.0 ] ] ) {
		prop( 'tyre', tx, 0.16, tz, tr, 1, HALF_PI, 0 );
	}

	// roof vents scattered over the warehouse
	for ( const [ vx, vz ] of [ [ - 26, - 27 ], [ - 21, - 20 ], [ - 15, - 12 ], [ - 11, - 5 ], [ - 25, - 6 ] ] ) {
		prop( 'vent', vx, WH_ROOF + 0.26, vz, ( vx + vz ) * 0.1, 1 );
	}

	// Extractor fans high on the warehouse east wall, mounted inboard so the
	// blades read against the bright bay opening. Layered west-to-east:
	// guard frame at -0.50, blade (added after the merge) at -0.34, and a dark
	// recess plate at -0.16 sitting flush in the corrugated skin. The blade's
	// X half-extent is 0.10, so nothing here intersects it.
	const FAN_SITES = [ [ - 8.05, 4.6, - 21.0 ], [ - 8.05, 4.6, - 9.0 ] ];
	for ( const [ fx, fy, fz ] of FAN_SITES ) {
		box( 'metalDark', 0.12, 1.34, 1.34, fx - 0.16, fy, fz, 0, true );
		// open guard: four bars, so the blade stays visible through it
		slab( 'rustMetal', 0.08, 0.13, 1.5, fx - 0.50, fy + 0.69, fz, 0, 0, 0 );
		slab( 'rustMetal', 0.08, 0.13, 1.5, fx - 0.50, fy - 0.69, fz, 0, 0, 0 );
		slab( 'rustMetal', 0.08, 1.25, 0.13, fx - 0.50, fy, fz + 0.69, 0, 0, 0 );
		slab( 'rustMetal', 0.08, 1.25, 0.13, fx - 0.50, fy, fz - 0.69, 0, 0, 0 );
	}

	// =======================================================================
	// DRAINAGE CHANNEL DRESSING
	// =======================================================================

	box( 'grate', 6, 0.08, 3, - 2, 0.02, 10, 0, true );
	collider( - 5, - 0.06, CH_N, 1, 0.04, CH_S );
	box( 'wood', 2.4, 0.16, 3.4, - 15, - 0.04, 10, 0, true );
	collider( - 16.2, - 0.16, CH_N, - 13.8, 0.04, CH_S );
	box( 'wood', 2.4, 0.16, 3.4, 17, - 0.04, 10, 0, true );
	collider( 15.8, - 0.16, CH_N, 18.2, 0.04, CH_S );

	// chain-link fence along the north lip, with a gap you can drop through
	function fence( x0, x1, z, h = 1.9 ) {
		const len = x1 - x0;
		slab( 'grate', len, h, 0.04, ( x0 + x1 ) * 0.5, h * 0.5, z, 0, 0, 0, 0.8 );
		slab( 'metalDark', len, 0.07, 0.07, ( x0 + x1 ) * 0.5, h, z, 0, 0, 0 );
		const n = Math.max( 2, Math.round( len / 2.4 ) );
		for ( let i = 0; i <= n; i ++ ) prop( 'post', x0 + len * ( i / n ), 0, z, 0, h / 1.05 );
		colliders.push( aabb( len, h, 0.14, ( x0 + x1 ) * 0.5, h * 0.5, z, 0 ) );
		wallFootprint( ( x0 + x1 ) * 0.5, z, len, 0.14 );
	}
	fence( 6.5, 20.5, CH_N - 0.35 );
	fence( - 29.5, - 20.5, CH_S + 0.35 );

	// outfall pipe emptying into the channel
	cylinder( 'rustMetal', 0.55, 0.55, 2.4, 12, - 29.4, CH_FLOOR + 0.55, 10, 0, 0, HALF_PI );
	slab( 'dirt', 3.4, 0.05, 2.2, - 26.5, CH_FLOOR + 0.05, 10, 0, 0, 0 );

	// =======================================================================
	// LAMPS — one housing per practical in lighting.js
	// =======================================================================

	// 1. sodium wall pack over the loading bay  (light at -8.9, 5.3, -13.5)
	slab( 'rustMetal', 0.5, 0.34, 0.42, - 8.55, 5.42, - 13.5, 0, 0, 0 );
	slab( 'lampSodium', 0.1, 0.24, 0.3, - 8.86, 5.3, - 13.5, 0, 0, 0 );
	slab( 'metalDark', 0.34, 0.09, 0.09, - 8.2, 5.62, - 13.5, 0, 0, 0 );

	// 2. yard mast floodlight  (light at 13, 8.4, -6)
	cylinder( 'metalDark', 0.11, 0.16, 8.4, 10, 13, 4.2, - 6 );
	collider( 12.8, 0, - 6.2, 13.2, 8.4, - 5.8 );
	box( 'concrete', 0.9, 0.4, 0.9, 13, 0.18, - 6, 0, true );
	slab( 'rustMetal', 0.7, 0.4, 0.5, 13, 8.42, - 5.72, - 0.5, 0, 0 );
	slab( 'lampSodium', 0.58, 0.06, 0.4, 13, 8.24, - 5.55, - 0.5, 0, 0 );
	wallFootprint( 13, - 6, 0.4, 0.4 );

	// 3. warehouse sodium pendant  (light at -19, 6.1, -18.5)
	cylinder( 'metalDark', 0.04, 0.04, 0.5, 6, - 19, 6.4, - 18.5 );
	cylinder( 'rustMetal', 0.14, 0.46, 0.34, 12, - 19, 6.16, - 18.5 );
	cylinder( 'lampSodium', 0.34, 0.34, 0.05, 12, - 19, 5.98, - 18.5 );

	// 4. dying fluorescent  (light at -19.5, 4.1, -6.2)
	slab( 'metalPainted', 1.7, 0.12, 0.26, - 19.5, 4.2, - 6.2, 0, 0, 0 );
	slab( 'lampCool', 1.5, 0.07, 0.16, - 19.5, 4.11, - 6.2, 0, 0, 0 );
	cylinder( 'metalDark', 0.02, 0.02, 2.3, 5, - 20.2, 5.35, - 6.2 );
	cylinder( 'metalDark', 0.02, 0.02, 2.3, 5, - 18.8, 5.35, - 6.2 );

	// 5. emergency strobe on the crane deck  (light at 6.2, 5.1, -14.2)
	cylinder( 'metalDark', 0.09, 0.12, 0.6, 8, 6.2, 4.7, - 14.2 );
	cylinder( 'trimRed', 0.15, 0.13, 0.26, 10, 6.2, 5.1, - 14.2 );
	slab( 'metalDark', 0.34, 0.05, 0.34, 6.2, 5.26, - 14.2, 0, 0, 0 );

	// floor marker studs down the courtyard: cheap, and they pull the eye
	for ( let i = 0; i < 7; i ++ ) {
		slab( 'trimAmber', 0.22, 0.03, 0.1, - 7.4, 0.07, - 10 + i * 2.6, 0, 0, 0 );
	}

	// =======================================================================
	// HANGING CABLES — catenary droop via CatmullRom + Tube
	// =======================================================================

	const cablePts = [ new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3() ];
	function cable( x0, y0, z0, x1, y1, z1, sag, radius = 0.03 ) {
		for ( let i = 0; i < 5; i ++ ) {
			const t = i / 4;
			cablePts[ i ].set(
				x0 + ( x1 - x0 ) * t,
				y0 + ( y1 - y0 ) * t - Math.sin( t * Math.PI ) * sag,
				z0 + ( z1 - z0 ) * t,
			);
		}
		const curve = new THREE.CatmullRomCurve3( cablePts.map( ( p ) => p.clone() ) );
		const g = new THREE.TubeGeometry( curve, 18, radius, 5, false );
		scaleUV( g, THREE.MathUtils.clamp( curve.getLength() * 0.5, 1, 40 ), 1 );
		bucket( 'metalDark' ).push( g );
	}

	cable( - 8.2, 6.2, - 13.5, 13, 8.0, - 6, 1.3 );
	cable( 13, 8.1, - 6, 30, 5.6, - 2, 1.5 );
	cable( - 8.2, 5.9, - 20, - 2.5, 5.2, - 24.2, 0.7 );
	cable( 6.2, 5.4, - 14.2, - 8.2, 6.0, - 10.5, 1.1 );
	cable( - 25, 5.2, - 29, - 25, 5.2, - 6, 1.0 );
	cable( 13, 7.9, - 6, 6.4, 5.3, - 13.8, 0.9 );
	cable( 30, 5.4, 8, 21.4, 2.4, 9.2, 0.8 );
	cable( - 30, 6.4, 18, - 21, 3.4, 20.0, 1.2 );

	// =======================================================================
	// PROP GEOMETRY + INSTANCING
	// =======================================================================

	function buildBarrel() {
		const parts = [
			new THREE.CylinderGeometry( 0.30, 0.30, 0.88, 14, 1, false ),
			new THREE.CylinderGeometry( 0.315, 0.315, 0.07, 14, 1, false ).translate( 0, 0.22, 0 ),
			new THREE.CylinderGeometry( 0.315, 0.315, 0.07, 14, 1, false ).translate( 0, - 0.22, 0 ),
			new THREE.CylinderGeometry( 0.305, 0.305, 0.05, 14, 1, false ).translate( 0, 0.44, 0 ),
		];
		const g = mergeGeometries( parts );
		for ( const p of parts ) p.dispose();
		return applyBoxUV( g, 0.9 );
	}

	function buildPallet() {
		const parts = [];
		for ( let i = 0; i < 5; i ++ ) {
			parts.push( new THREE.BoxGeometry( 1.2, 0.035, 0.13 ).translate( 0, 0.128, - 0.44 + i * 0.22 ) );
		}
		for ( let i = 0; i < 3; i ++ ) {
			parts.push( new THREE.BoxGeometry( 1.2, 0.03, 0.12 ).translate( 0, - 0.128, - 0.4 + i * 0.4 ) );
			parts.push( new THREE.BoxGeometry( 0.1, 0.19, 1.0 ).translate( - 0.5 + i * 0.5, 0, 0 ) );
		}
		const g = mergeGeometries( parts );
		for ( const p of parts ) p.dispose();
		return applyBoxUV( g, 1.1 );
	}

	function buildCrate() {
		const parts = [ new THREE.BoxGeometry( 1.14, 1.14, 1.14 ) ];
		for ( const sx of [ - 1, 1 ] ) {
			for ( const sz of [ - 1, 1 ] ) {
				parts.push( new THREE.BoxGeometry( 0.1, 1.2, 0.1 ).translate( sx * 0.55, 0, sz * 0.55 ) );
			}
			parts.push( new THREE.BoxGeometry( 1.2, 0.09, 0.09 ).translate( 0, sx * 0.55, 0.58 ) );
			parts.push( new THREE.BoxGeometry( 1.2, 0.09, 0.09 ).translate( 0, sx * 0.55, - 0.58 ) );
		}
		const g = mergeGeometries( parts );
		for ( const p of parts ) p.dispose();
		return applyBoxUV( g, 0.85 );
	}

	function buildBarrier() {
		const parts = [
			new THREE.BoxGeometry( 2.2, 0.22, 0.62 ).translate( 0, 0.11, 0 ),
			new THREE.BoxGeometry( 2.16, 0.42, 0.42 ).translate( 0, 0.44, 0 ),
			new THREE.BoxGeometry( 2.1, 0.28, 0.24 ).translate( 0, 0.78, 0 ),
		];
		const g = mergeGeometries( parts );
		for ( const p of parts ) p.dispose();
		return applyBoxUV( g, 0.6 );
	}

	function buildSandbag() {
		const g = new THREE.SphereGeometry( 0.28, 8, 6 );
		g.scale( 1.5, 0.62, 1.0 );
		return applyBoxUV( g, 1.4 );
	}

	function buildSpool() {
		// stood upright on its flanges: 1.12 tall, so y = 0.56 sits it on the deck
		const parts = [
			new THREE.CylinderGeometry( 1.02, 1.02, 0.12, 18, 1, false ).translate( 0, - 0.5, 0 ),
			new THREE.CylinderGeometry( 1.02, 1.02, 0.12, 18, 1, false ).translate( 0, 0.5, 0 ),
			new THREE.CylinderGeometry( 0.4, 0.4, 1.0, 14, 1, false ),
			new THREE.CylinderGeometry( 0.72, 0.72, 0.86, 16, 1, false ),
		];
		const g = mergeGeometries( parts );
		for ( const p of parts ) p.dispose();
		return applyBoxUV( g, 0.8 );
	}

	function buildPost() {
		const parts = [
			new THREE.CylinderGeometry( 0.042, 0.042, 1.05, 8, 1, false ).translate( 0, 0.525, 0 ),
			new THREE.BoxGeometry( 0.14, 0.03, 0.14 ).translate( 0, 0.02, 0 ),
		];
		const g = mergeGeometries( parts );
		for ( const p of parts ) p.dispose();
		return applyBoxUV( g, 1.2 );
	}

	function buildBollard() {
		const parts = [
			new THREE.CylinderGeometry( 0.13, 0.15, 0.9, 10, 1, false ),
			new THREE.CylinderGeometry( 0.14, 0.14, 0.06, 10, 1, false ).translate( 0, 0.45, 0 ),
		];
		const g = mergeGeometries( parts );
		for ( const p of parts ) p.dispose();
		return applyBoxUV( g, 1.4 );
	}

	function buildVent() {
		const parts = [
			new THREE.BoxGeometry( 0.8, 0.3, 0.8 ),
			new THREE.CylinderGeometry( 0.26, 0.3, 0.36, 10, 1, false ).translate( 0, 0.32, 0 ),
			new THREE.CylinderGeometry( 0.34, 0.34, 0.07, 10, 1, false ).translate( 0, 0.53, 0 ),
		];
		const g = mergeGeometries( parts );
		for ( const p of parts ) p.dispose();
		return applyBoxUV( g, 1.1 );
	}

	function buildTyre() {
		const g = new THREE.TorusGeometry( 0.42, 0.15, 6, 14 );
		return applyBoxUV( g, 1.6 );
	}

	const PROP_BUILDERS = {
		barrel: buildBarrel, pallet: buildPallet, crate: buildCrate, barrier: buildBarrier,
		sandbag: buildSandbag, spool: buildSpool, post: buildPost, bollard: buildBollard,
		vent: buildVent, tyre: buildTyre,
	};

	// =======================================================================
	// FLUSH: merge every bucket, build every InstancedMesh
	// =======================================================================

	const _m = new THREE.Matrix4();
	const _q2 = new THREE.Quaternion();
	const _e2 = new THREE.Euler();
	const _p2 = new THREE.Vector3();
	const _s2 = new THREE.Vector3();
	const _col = new THREE.Color();

	for ( const [ key, geoms ] of buckets ) {
		if ( geoms.length === 0 ) continue;
		const def = GROUP_DEFS[ key ];
		const merged = geoms.length === 1 ? geoms[ 0 ] : mergeGeometries( geoms );
		if ( geoms.length > 1 ) for ( const g of geoms ) g.dispose();
		merged.computeBoundingSphere();

		const mesh = new THREE.Mesh( merged, materialFor( key ) );
		mesh.name = 'static:' + key;
		mesh.castShadow = def.cast;
		mesh.receiveShadow = def.receive;
		mesh.matrixAutoUpdate = false;
		mesh.userData.surface = def.surface;
		root.add( mesh );
		hitMeshes.push( mesh );
	}

	for ( const kind in PROP_DEFS ) {
		const list = propXforms[ kind ];
		if ( list.length === 0 ) continue;
		const def = GROUP_DEFS[ PROP_DEFS[ kind ].group ];
		const geo = PROP_BUILDERS[ kind ]();
		geo.computeBoundingSphere();

		const mesh = new THREE.InstancedMesh( geo, materialFor( PROP_DEFS[ kind ].group ), list.length );
		mesh.name = 'prop:' + kind;
		// small clutter does not cast: it is the single cheapest shadow saving
		mesh.castShadow = kind !== 'post' && kind !== 'tyre' && kind !== 'bollard';
		mesh.receiveShadow = true;
		mesh.userData.surface = def.surface;
		mesh.instanceMatrix.setUsage( THREE.StaticDrawUsage );

		for ( let i = 0; i < list.length; i ++ ) {
			const t = list[ i ];
			_e2.set( t.rx, t.ry, t.rz, 'YXZ' );
			_q2.setFromEuler( _e2 );
			_m.compose( _p2.set( t.x, t.y, t.z ), _q2, _s2.setScalar( t.s ) );
			mesh.setMatrixAt( i, _m );
			// per-instance tint keeps 24 identical barrels from reading as a copy-paste
			const n = ( Math.sin( i * 12.9898 ) * 43758.5453 ) % 1;
			const j = 0.86 + Math.abs( n ) * 0.28;
			_col.setRGB( j, j * ( 0.97 + Math.abs( n ) * 0.06 ), j * ( 0.94 + Math.abs( n ) * 0.1 ) );
			mesh.setColorAt( i, _col );
		}
		mesh.instanceMatrix.needsUpdate = true;
		if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;
		mesh.computeBoundingSphere();
		root.add( mesh );
		hitMeshes.push( mesh );
	}

	// =======================================================================
	// LIGHT SHAFTS  (1 draw call)
	// =======================================================================
	// Axis-locked additive billboards: each quad spins around its own beam axis
	// to face the camera, so a shaft reads as a solid column of lit haze from
	// every angle instead of swinging around like a flat card. Endpoints are
	// authored by hand against SUN_DIR — each one enters a roof gap or a doorway
	// and terminates where the beam actually meets a wall or the floor.

	const shaftMesh = buildShafts();
	root.add( shaftMesh );

	// =======================================================================
	// ANIMATED DRESSING (2 extra draw calls, worth it — the eye reads motion)
	// =======================================================================

	// Blade geometry is authored with its spin axis along X so the mesh needs no
	// mounting rotation and `rotation.x` is an unambiguous spin.
	const fanBlade = ( () => {
		const parts = [ new THREE.CylinderGeometry( 0.06, 0.06, 0.12, 8, 1, false ) ];
		for ( let i = 0; i < 5; i ++ ) {
			const b = new THREE.BoxGeometry( 0.52, 0.025, 0.19 );
			b.rotateX( 0.42 );
			b.translate( 0.3, 0, 0 );
			b.rotateY( i * ( Math.PI * 2 / 5 ) );
			parts.push( b );
		}
		const g = mergeGeometries( parts );
		for ( const p of parts ) p.dispose();
		g.rotateZ( HALF_PI );
		return applyBoxUV( g, 1.5 );
	} )();

	const fans = [];
	for ( const [ fx, fy, fz ] of FAN_SITES ) {
		const blade = new THREE.Mesh( fanBlade, materialFor( 'metalDark' ) );
		blade.position.set( fx - 0.34, fy, fz );
		blade.castShadow = false;
		blade.receiveShadow = false;
		blade.userData.surface = 'metal';
		root.add( blade );
		fans.push( blade );
	}

	// =======================================================================
	// GAMEPLAY MARKUP
	// =======================================================================

	const playerSpawn = { position: new THREE.Vector3( - 2, 0, 21 ), yaw: 0 };

	const SPAWNS = [
		[ - 26, 0, - 25.5, 0.8 ],       // warehouse NW corner
		[ - 14.5, 0, - 20, 1.6 ],       // warehouse mid floor
		[ - 19, 0, - 5, 3.0 ],          // warehouse south opening
		[ - 27.5, DECK, - 20, 1.4 ],    // mezzanine
		[ - 1, DECK, - 28, 2.4 ],       // catwalk over the yard
		[ 6, DECK, - 14.5, 3.1 ],       // crane deck
		[ 20, 0, - 24, 2.9 ],           // yard north
		[ 26.5, 0, - 6, 4.0 ],          // yard east
		[ 14, 0, 12.5, 3.6 ],           // yard south
		[ 24, 0, 22, 3.9 ],             // yard south-east
		[ - 22, CH_FLOOR, 10, 1.57 ],   // drainage channel west
		[ - 2, 0, 6, 2.2 ],             // courtyard
	];
	for ( const [ sx, sy, sz, yaw ] of SPAWNS ) {
		enemySpawns.push( { position: new THREE.Vector3( sx, sy, sz ), yaw } );
	}

	const COVER = [
		[ - 4.4, 0, - 12.4 ], [ - 2.0, 0, - 9.2 ], [ 1.4, 0, - 5.2 ], [ - 6.6, 0, - 4.2 ],
		[ - 5.2, 0, 3.4 ], [ - 1.0, 0, 3.6 ], [ - 3.2, 0, 8.2 ], [ - 8.4, 0, 13.0 ],
		[ 8.0, 0, - 24.6 ], [ 13.6, 0, - 18.9 ], [ 20.4, 0, - 21.0 ], [ 22.0, 0, - 15.0 ],
		[ 26.8, 0, - 14.8 ], [ 21.5, 0, - 7.6 ], [ 15.2, 0, - 5.2 ], [ 12.2, 0, - 0.6 ],
		[ 22.0, 0, 4.0 ], [ 17.0, 0, 8.0 ], [ 26.5, 0, 12.0 ], [ 18.0, 0, 16.0 ],
		[ 10.5, 0, 21.5 ], [ 21.0, 0, 24.5 ], [ 3.0, 0, 26.0 ],
		[ - 21.5, 0, - 26.5 ], [ - 26.5, 0, - 21.0 ], [ - 16.5, 0, - 24.0 ], [ - 12.0, 0, - 16.0 ],
		[ - 22.5, 0, - 14.0 ], [ - 27.0, 0, - 10.0 ], [ - 15.0, 0, - 6.5 ], [ - 24.5, 0, - 3.5 ],
		[ - 27.0, DECK, - 26.0 ], [ - 27.0, DECK, - 12.0 ], [ - 27.0, DECK, - 6.0 ],
		[ - 14.0, DECK, - 28.0 ], [ - 4.0, DECK, - 28.0 ], [ 6.0, DECK, - 22.0 ],
		[ - 22.0, CH_FLOOR, 10.0 ], [ - 9.0, CH_FLOOR, 10.0 ], [ 6.0, CH_FLOOR, 10.0 ],
		[ 22.0, CH_FLOOR, 10.0 ],
		[ - 25.0, 0, 18.0 ], [ - 14.0, 0, 16.5 ], [ - 5.0, 0, 21.0 ], [ 27.0, 0, 22.0 ],
	];
	for ( const [ cx3, cy3, cz3 ] of COVER ) coverPoints.push( new THREE.Vector3( cx3, cy3, cz3 ) );

	const bounds = new THREE.Box3(
		new THREE.Vector3( - 31, - 2, - 31 ),
		new THREE.Vector3( 31, 13, 31 ),
	);

	// Hero framing for the main menu. Stood on the north-east container stack
	// looking west-south-west, ~20deg off the sun so the disc sits just out of
	// frame and everything between reads as rim-lit silhouette: the crane deck
	// and gantry cut the glow, the mast floodlight and the strobe sit in the
	// dark half, and the container rows run as leading lines into the light.
	const menuView = {
		position: new THREE.Vector3( 23.5, 6.2, - 20.5 ),
		target: new THREE.Vector3( - 10.0, 2.8, - 11.0 ),
	};

	// =======================================================================
	// RUNTIME
	// =======================================================================

	const trimAmber = materialFor( 'trimAmber' );
	const trimBase = trimAmber.emissiveIntensity;
	let elapsed = 0;

	function update( dt ) {
		elapsed += dt;
		fans[ 0 ].rotation.x = elapsed * 2.6;
		fans[ 1 ].rotation.x = - elapsed * 1.9 + 0.6;
		// slow breathe on the trim so the level never looks frozen
		trimAmber.emissiveIntensity = trimBase * ( 0.88 + 0.12 * Math.sin( elapsed * 1.7 ) );
		shaftMesh.material.uniforms.uTime.value = elapsed;
	}

	function dispose() {
		root.traverse( ( o ) => {
			if ( o.isMesh || o.isInstancedMesh ) o.geometry.dispose();
		} );
		shaftMesh.material.dispose();
		scene.remove( root );
	}

	return {
		root,
		colliders,
		hitMeshes,
		playerSpawn,
		enemySpawns,
		coverPoints,
		bounds,
		menuView,
		minimap: {
			min: { x: - 30, z: - 30 },
			max: { x: 30, z: 30 },
			walls: minimapWalls,
		},
		materials,
		update,
		dispose,
	};
}

export default buildMap;
