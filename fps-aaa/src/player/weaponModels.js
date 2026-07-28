import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * OVERPRESSURE — procedural first-person weapon models.
 *
 * Everything is built from primitives (chamfered extrusions, cylinders,
 * lathes) in metres, then merged per material so a weapon is a handful of
 * draw calls: 2 static merges (gunmetal + polymer), a glove merge, the optic
 * glass + emissive reticle, and the animated parts (magazine, bolt/slide,
 * charging handle, trigger) which must stay separate to move.
 *
 * Weapon space: -Z is forward (muzzle), +Y up, +X right. The origin sits just
 * above the pistol grip so the viewmodel can pose it around a sane pivot.
 */

// ---------------------------------------------------------------- materials

export const WEAPON_MATERIALS = {
	// envMapIntensity is held well under 1: the viewmodel scene is given the
	// world's PMREM environment by the bootstrap, and at full strength a dusk
	// sky turns 85%-metalness gunmetal into pale beige. Damping the environment
	// keeps the weapon reading as dark metal while still picking up the ambient
	// colour of wherever the player is standing.
	metal: new THREE.MeshStandardMaterial( {
		color: 0x2b2e33, roughness: 0.42, metalness: 0.85, envMapIntensity: 0.55,
	} ),
	polymer: new THREE.MeshStandardMaterial( {
		color: 0x1b1e22, roughness: 0.75, metalness: 0.05, envMapIntensity: 0.40,
	} ),
	glove: new THREE.MeshStandardMaterial( {
		color: 0x141619, roughness: 0.92, metalness: 0.04, envMapIntensity: 0.35,
	} ),
	glass: new THREE.MeshStandardMaterial( {
		color: 0x0b1a1f, roughness: 0.06, metalness: 0.35, envMapIntensity: 1.0,
		transparent: true, opacity: 0.34, side: THREE.DoubleSide,
	} ),
	reticle: null, // built lazily (needs a canvas texture)
};

function reticleTexture() {
	const c = document.createElement( 'canvas' );
	c.width = c.height = 64;
	const g = c.getContext( '2d' );
	g.clearRect( 0, 0, 64, 64 );
	// soft halo
	const grad = g.createRadialGradient( 32, 32, 0, 32, 32, 26 );
	grad.addColorStop( 0, 'rgba(255,120,80,0.85)' );
	grad.addColorStop( 0.18, 'rgba(255,70,40,0.35)' );
	grad.addColorStop( 1, 'rgba(255,40,20,0)' );
	g.fillStyle = grad;
	g.fillRect( 0, 0, 64, 64 );
	// hot core
	const core = g.createRadialGradient( 32, 32, 0, 32, 32, 7 );
	core.addColorStop( 0, 'rgba(255,240,225,1)' );
	core.addColorStop( 0.45, 'rgba(255,110,60,1)' );
	core.addColorStop( 1, 'rgba(255,60,30,0)' );
	g.fillStyle = core;
	g.beginPath(); g.arc( 32, 32, 8, 0, Math.PI * 2 ); g.fill();
	const tex = new THREE.CanvasTexture( c );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.needsUpdate = true;
	return tex;
}

function reticleMaterial() {
	if ( ! WEAPON_MATERIALS.reticle ) {
		WEAPON_MATERIALS.reticle = new THREE.MeshBasicMaterial( {
			map: reticleTexture(),
			color: 0xffffff,
			transparent: true,
			blending: THREE.AdditiveBlending,
			depthWrite: false,
			toneMapped: false,
		} );
	}
	return WEAPON_MATERIALS.reticle;
}

// ---------------------------------------------------------------- geometry kit

const _m4 = new THREE.Matrix4();
const _eu = new THREE.Euler();
const _qt = new THREE.Quaternion();
const _pv = new THREE.Vector3();
const _sv = new THREE.Vector3( 1, 1, 1 );

/** Chamfered box built as a bevelled extrusion — reads far better than a cube. */
function chamferBox( w, h, d, c = 0.0035, bevelSegments = 1 ) {
	c = Math.min( c, w * 0.45, h * 0.45, d * 0.45 );
	const iw = Math.max( 0.0002, w - 2 * c );
	const ih = Math.max( 0.0002, h - 2 * c );
	const dep = Math.max( 0.0002, d - 2 * c );
	const shape = new THREE.Shape();
	shape.moveTo( - iw / 2, - ih / 2 );
	shape.lineTo( iw / 2, - ih / 2 );
	shape.lineTo( iw / 2, ih / 2 );
	shape.lineTo( - iw / 2, ih / 2 );
	shape.closePath();
	const g = new THREE.ExtrudeGeometry( shape, {
		depth: dep, bevelEnabled: true, bevelThickness: c, bevelSize: c,
		bevelOffset: 0, bevelSegments, steps: 1, curveSegments: 1,
	} );
	g.translate( 0, 0, - dep / 2 );
	return g;
}

function tube( rTop, rBot, len, seg = 12, open = false ) {
	const g = new THREE.CylinderGeometry( rTop, rBot, len, seg, 1, open );
	g.rotateX( Math.PI / 2 );   // align the axis with Z (forward)
	return g;
}

function lathePart( profile, seg = 14 ) {
	const g = new THREE.LatheGeometry( profile, seg );
	g.rotateX( Math.PI / 2 );
	return g;
}

/** Transform a geometry into weapon space and queue it for merging. */
function put( bucket, geo, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0 ) {
	_eu.set( rx, ry, rz );
	_qt.setFromEuler( _eu );
	_pv.set( px, py, pz );
	_sv.set( 1, 1, 1 );
	_m4.compose( _pv, _qt, _sv );
	geo.applyMatrix4( _m4 );
	bucket.push( geo.index ? geo.toNonIndexed() : geo );
	return geo;
}

function mergeBucket( bucket, material ) {
	if ( ! bucket.length ) return null;
	const g = mergeGeometries( bucket, false );
	bucket.length = 0;
	if ( ! g ) return null;
	// normals survive applyMatrix4 on every source geometry, so no recompute:
	// recomputing would flatten the lathed / cylindrical shading.
	const mesh = new THREE.Mesh( g, material );
	mesh.frustumCulled = false;
	return mesh;
}

/** Build an animated sub-assembly whose transform pivots around (px,py,pz). */
function makePart( px, py, pz, entries ) {
	const grp = new THREE.Group();
	grp.position.set( px, py, pz );
	for ( let i = 0; i < entries.length; i ++ ) {
		const mesh = mergeBucket( entries[ i ][ 0 ], entries[ i ][ 1 ] );
		if ( ! mesh ) continue;
		mesh.geometry.translate( - px, - py, - pz );
		grp.add( mesh );
	}
	grp.userData.restPos = new THREE.Vector3( px, py, pz );
	return grp;
}

function marker( parent, x, y, z ) {
	const o = new THREE.Object3D();
	o.position.set( x, y, z );
	parent.add( o );
	return o;
}

// ---------------------------------------------------------------- sub-assemblies

/** Picatinny rail: base slab + teeth. */
function addRail( metal, x, y, z, length, width = 0.044 ) {
	put( metal, chamferBox( width, 0.008, length, 0.0015 ), x, y, z );
	const teeth = Math.max( 3, Math.floor( length / 0.0225 ) );
	const step = length / teeth;
	for ( let i = 0; i < teeth; i ++ ) {
		const tz = z - length / 2 + step * ( i + 0.5 );
		put( metal, chamferBox( width * 0.94, 0.006, step * 0.55, 0.0012 ), x, y + 0.007, tz );
	}
}

/**
 * Open reflex sight. Returns the world-space (weapon-space) centre of the dot,
 * which is what ADS aligns to the screen centre.
 */
function addReflexSight( metal, glass, retic, x, railTopY, z, scale = 1 ) {
	const s = scale;
	const baseH = 0.014 * s;
	const baseY = railTopY + baseH * 0.5;
	put( metal, chamferBox( 0.036 * s, baseH, 0.062 * s, 0.002 ), x, baseY, z );
	// throw-lever clamp
	put( metal, chamferBox( 0.046 * s, 0.010 * s, 0.016 * s, 0.0015 ), x - 0.004 * s, baseY, z + 0.020 * s );

	const dotY = railTopY + 0.030 * s;
	const hoodH = 0.040 * s;
	// side plates
	put( metal, chamferBox( 0.0045 * s, hoodH, 0.046 * s, 0.0012 ), x + 0.019 * s, dotY + 0.004 * s, z - 0.006 * s );
	put( metal, chamferBox( 0.0045 * s, hoodH, 0.046 * s, 0.0012 ), x - 0.019 * s, dotY + 0.004 * s, z - 0.006 * s );
	// hood
	put( metal, chamferBox( 0.042 * s, 0.006 * s, 0.046 * s, 0.0015 ), x, dotY + 0.024 * s, z - 0.006 * s );
	// emitter housing at the rear of the window
	put( metal, chamferBox( 0.030 * s, 0.012 * s, 0.010 * s, 0.0015 ), x, dotY - 0.014 * s, z + 0.014 * s );
	// windage / elevation turret
	put( metal, tube( 0.005 * s, 0.005 * s, 0.008 * s, 8 ), x + 0.021 * s, dotY + 0.010 * s, z + 0.012 * s, 0, Math.PI / 2, 0 );

	// canted glass
	const gg = new THREE.PlaneGeometry( 0.032 * s, 0.034 * s );
	put( glass, gg, x, dotY + 0.003 * s, z - 0.014 * s, 0.20, 0, 0 );

	// emissive dot, facing the shooter (+Z)
	const rg = new THREE.PlaneGeometry( 0.013 * s, 0.013 * s );
	put( retic, rg, x, dotY, z - 0.0135 * s );

	return { dotY, dotZ: z - 0.0135 * s };
}

/** Backup iron sights (folded up), purely cosmetic detail. */
function addIronSights( metal, railTopY, frontZ, rearZ ) {
	// front post + hood ears
	put( metal, chamferBox( 0.020, 0.006, 0.014, 0.0012 ), 0, railTopY + 0.003, frontZ );
	put( metal, chamferBox( 0.004, 0.022, 0.006, 0.001 ), 0.008, railTopY + 0.014, frontZ );
	put( metal, chamferBox( 0.004, 0.022, 0.006, 0.001 ), - 0.008, railTopY + 0.014, frontZ );
	put( metal, chamferBox( 0.003, 0.018, 0.004, 0.001 ), 0, railTopY + 0.012, frontZ );
	// rear aperture
	put( metal, chamferBox( 0.026, 0.006, 0.012, 0.0012 ), 0, railTopY + 0.003, rearZ );
	put( metal, chamferBox( 0.005, 0.018, 0.005, 0.001 ), 0.009, railTopY + 0.013, rearZ );
	put( metal, chamferBox( 0.005, 0.018, 0.005, 0.001 ), - 0.009, railTopY + 0.013, rearZ );
	put( metal, chamferBox( 0.022, 0.005, 0.005, 0.001 ), 0, railTopY + 0.021, rearZ );
}

function addTriggerGuard( metal, z, yTop ) {
	put( metal, chamferBox( 0.010, 0.007, 0.062, 0.002 ), 0, yTop - 0.044, z - 0.004 );
	put( metal, chamferBox( 0.010, 0.030, 0.008, 0.002 ), 0, yTop - 0.030, z - 0.033 );
	put( metal, chamferBox( 0.010, 0.024, 0.008, 0.002 ), 0, yTop - 0.034, z + 0.026 );
}

/** Raked pistol grip with finger swells. */
function addPistolGrip( poly, x, y, z, rake, w = 0.036, h = 0.108, d = 0.050 ) {
	put( poly, chamferBox( w, h, d, 0.006, 2 ), x, y, z, rake );
	// palm swell + beavertail
	put( poly, chamferBox( w * 0.92, 0.030, d * 0.55, 0.006, 2 ), x, y + h * 0.44, z + 0.014, rake );
	// finger grooves on the front face
	const c = Math.cos( rake ), s = Math.sin( rake );
	for ( let i = 0; i < 3; i ++ ) {
		const ly = h * 0.26 - i * 0.024;
		const lz = - d * 0.44;
		put( poly, chamferBox( w * 0.86, 0.008, 0.008, 0.003 ),
			x, y + ly * c - lz * s, z + ly * s + lz * c, rake );
	}
	// flared grip base
	put( poly, chamferBox( w * 1.06, 0.012, d * 0.96, 0.004 ),
		x, y - h * 0.5 * c, z - h * 0.5 * s, rake );
}

/**
 * Tactical glove. Kept dark, chunky and low-contrast so it reads as a
 * silhouette rather than competing with the weapon.
 * `side` = +1 for the right (trigger) hand, -1 for the left (support) hand.
 */
function addGloveHand( glove, x, y, z, rake, side, opts = {} ) {
	const palmW = opts.palmW ?? 0.048;
	const palmH = opts.palmH ?? 0.086;
	const palmD = opts.palmD ?? 0.052;
	const fingerLen = opts.fingerLen ?? 0.052;
	const yawT = opts.yaw ?? 0;

	const c = Math.cos( rake ), s = Math.sin( rake );
	// local (ly, lz) -> world, rotated about X by `rake` around (x,y,z)
	const wy = ( ly, lz ) => y + ly * c - lz * s;
	const wz = ( ly, lz ) => z + ly * s + lz * c;

	// back of the hand
	put( glove, chamferBox( palmW, palmH, palmD, 0.008, 2 ),
		x + side * 0.010, wy( 0, 0 ), wz( 0, 0 ), rake, yawT );

	// knuckle pad
	put( glove, chamferBox( palmW * 0.92, 0.016, palmD * 0.55, 0.005, 2 ),
		x + side * 0.012, wy( palmH * 0.40, - palmD * 0.16 ), wz( palmH * 0.40, - palmD * 0.16 ), rake, yawT );

	// four fingers curling around the front of the grip
	for ( let i = 0; i < 4; i ++ ) {
		const ly = palmH * 0.30 - i * 0.021;
		const curl = 0.30 + i * 0.10;
		const lz = - palmD * 0.52 - 0.004;
		// proximal segment
		put( glove, chamferBox( 0.019, 0.019, fingerLen, 0.006, 2 ),
			x + side * 0.008, wy( ly, lz ), wz( ly, lz ), rake + 0.10, yawT );
		// curled tip
		put( glove, chamferBox( 0.018, 0.018, 0.024, 0.006, 2 ),
			x - side * 0.006, wy( ly - 0.010, lz - fingerLen * 0.46 ), wz( ly - 0.010, lz - fingerLen * 0.46 ),
			rake + curl, yawT );
	}

	// thumb, laid diagonally across the far side
	put( glove, chamferBox( 0.020, 0.021, 0.046, 0.007, 2 ),
		x - side * 0.020, wy( palmH * 0.20, - palmD * 0.20 ), wz( palmH * 0.20, - palmD * 0.20 ),
		rake + 0.35, yawT, side * 0.45 );

	// wrist cuff + a stub of forearm running off the bottom of the screen
	put( glove, chamferBox( palmW * 1.10, 0.056, 0.040, 0.010, 2 ),
		x + side * 0.012, wy( - palmH * 0.56, 0.022 ), wz( - palmH * 0.56, 0.022 ), rake, yawT );
	put( glove, chamferBox( palmW * 1.02, 0.050, 0.120, 0.012, 2 ),
		x + side * 0.014, wy( - palmH * 0.78, 0.090 ), wz( - palmH * 0.78, 0.090 ), rake * 0.6, yawT );
}

/** Support hand wrapped over a handguard (fingers over the top, thumb below). */
function addSupportHand( glove, x, y, z, roll ) {
	// palm on the left side of the handguard
	put( glove, chamferBox( 0.044, 0.070, 0.070, 0.010, 2 ), x, y, z, 0, 0, roll );
	for ( let i = 0; i < 4; i ++ ) {
		const fz = z - 0.024 + i * 0.019;
		put( glove, chamferBox( 0.052, 0.018, 0.017, 0.006, 2 ), x + 0.026, y + 0.026, fz, 0, 0, roll + 0.25 );
		put( glove, chamferBox( 0.022, 0.017, 0.016, 0.006, 2 ), x + 0.050, y + 0.012, fz, 0, 0, roll + 0.9 );
	}
	// thumb over the top rail-side
	put( glove, chamferBox( 0.046, 0.019, 0.020, 0.007, 2 ), x + 0.016, y - 0.026, z + 0.026, 0.4, 0, roll - 0.3 );
	// wrist trailing down/back
	put( glove, chamferBox( 0.046, 0.048, 0.070, 0.012, 2 ), x - 0.014, y - 0.040, z + 0.070, - 0.45, 0, roll );
}

// ---------------------------------------------------------------- rifle

export function buildRifle() {
	const group = new THREE.Group();
	const metal = [], poly = [], glass = [], retic = [], glove = [];
	const magMetal = [], boltB = [], chB = [], trigB = [];

	// --- receiver -------------------------------------------------------
	put( metal, chamferBox( 0.068, 0.086, 0.245, 0.005 ), 0, 0.004, - 0.010 );
	put( metal, chamferBox( 0.058, 0.030, 0.255, 0.004 ), 0, 0.050, - 0.014 );   // upper
	addRail( metal, 0, 0.068, - 0.060, 0.300, 0.046 );
	// ejection port surround + brass deflector
	put( metal, chamferBox( 0.008, 0.034, 0.076, 0.002 ), 0.035, 0.022, - 0.040 );
	put( metal, chamferBox( 0.014, 0.026, 0.028, 0.004 ), 0.036, 0.040, 0.006, 0, 0, - 0.5 );
	// forward assist
	put( metal, tube( 0.008, 0.009, 0.024, 10 ), 0.038, 0.012, 0.030, 0, Math.PI / 2, 0 );
	// mag release + safety detail
	put( metal, tube( 0.006, 0.006, 0.014, 8 ), 0.036, - 0.014, - 0.036, 0, Math.PI / 2, 0 );
	put( metal, chamferBox( 0.016, 0.008, 0.020, 0.002 ), - 0.036, - 0.006, 0.030 );

	// --- magwell --------------------------------------------------------
	put( metal, chamferBox( 0.050, 0.062, 0.082, 0.004 ), 0, - 0.062, - 0.026 );

	// --- handguard ------------------------------------------------------
	put( poly, chamferBox( 0.056, 0.060, 0.250, 0.006 ), 0, 0.004, - 0.268 );
	addRail( metal, 0, 0.038, - 0.268, 0.240, 0.044 );
	// side + bottom m-lok style ribs
	for ( let i = 0; i < 6; i ++ ) {
		const z = - 0.372 + i * 0.038;
		put( poly, chamferBox( 0.062, 0.012, 0.020, 0.003 ), 0, 0.004, z );
		put( poly, chamferBox( 0.040, 0.010, 0.020, 0.003 ), 0, - 0.028, z );
	}
	put( metal, chamferBox( 0.030, 0.014, 0.050, 0.003 ), 0, - 0.032, - 0.230 );  // handstop

	// --- barrel / gas system / muzzle ------------------------------------
	put( metal, tube( 0.0115, 0.0125, 0.360, 14 ), 0, 0.006, - 0.320 );
	put( metal, chamferBox( 0.026, 0.030, 0.032, 0.003 ), 0, 0.024, - 0.430 );    // gas block
	put( metal, tube( 0.0035, 0.0035, 0.250, 8 ), 0, 0.034, - 0.320 );            // gas tube
	// flash hider, lathed profile
	const fhProfile = [
		new THREE.Vector2( 0.0001, 0 ),
		new THREE.Vector2( 0.0125, 0 ),
		new THREE.Vector2( 0.0135, - 0.006 ),
		new THREE.Vector2( 0.0125, - 0.012 ),
		new THREE.Vector2( 0.0165, - 0.020 ),
		new THREE.Vector2( 0.0165, - 0.052 ),
		new THREE.Vector2( 0.0120, - 0.052 ),
		new THREE.Vector2( 0.0100, - 0.048 ),
		new THREE.Vector2( 0.0100, 0 ),
	];
	put( metal, lathePart( fhProfile, 14 ), 0, 0.006, - 0.482 );
	// prong slots
	for ( let i = 0; i < 3; i ++ ) {
		const a = i * Math.PI * 2 / 3 + 0.5;
		put( metal, chamferBox( 0.005, 0.014, 0.030, 0.001 ),
			Math.cos( a ) * 0.014, 0.006 + Math.sin( a ) * 0.014, - 0.518, 0, 0, a );
	}

	// --- stock ------------------------------------------------------------
	put( metal, tube( 0.019, 0.019, 0.170, 12 ), 0, 0.030, 0.190 );               // buffer tube
	put( poly, chamferBox( 0.044, 0.070, 0.110, 0.008, 2 ), 0, 0.024, 0.205 );    // carbine stock body
	put( poly, chamferBox( 0.040, 0.086, 0.026, 0.007, 2 ), 0, 0.018, 0.272 );    // butt pad
	put( poly, chamferBox( 0.030, 0.026, 0.090, 0.006, 2 ), 0, 0.062, 0.196 );    // cheek riser
	put( poly, chamferBox( 0.020, 0.020, 0.030, 0.005 ), 0.024, 0.006, 0.240 );   // qd sling cup

	// --- grip + trigger guard ----------------------------------------------
	const rake = - 0.34;
	addPistolGrip( poly, 0, - 0.086, 0.074, rake );
	addTriggerGuard( metal, 0.026, - 0.030 );

	// --- sights --------------------------------------------------------------
	const railTop = 0.068 + 0.008 + 0.006;
	addIronSights( metal, railTop, - 0.196, 0.056 );
	const sight = addReflexSight( metal, glass, retic, 0, railTop, - 0.070, 1.0 );

	// --- animated parts --------------------------------------------------------
	// Magazine (metal body + floorplate), pivoting at the magwell mouth. Sized
	// off a real 30-round box: it clears the magwell by ~0.15m, so the floor
	// lands ~0.22m under the bore rather than dangling a third of a metre down.
	put( magMetal, chamferBox( 0.030, 0.072, 0.058, 0.005 ), 0, - 0.126, - 0.022, 0.10 );
	put( magMetal, chamferBox( 0.029, 0.062, 0.055, 0.005 ), 0, - 0.188, 0.002, 0.26 );
	for ( let i = 0; i < 4; i ++ ) {
		put( magMetal, chamferBox( 0.032, 0.005, 0.050, 0.002 ), 0, - 0.106 - i * 0.023, - 0.028 + i * 0.006, 0.16 );
	}
	put( magMetal, chamferBox( 0.036, 0.014, 0.060, 0.004 ), 0, - 0.217, 0.016, 0.26 );
	const mag = makePart( 0, - 0.090, - 0.024, [ [ magMetal, WEAPON_MATERIALS.metal ] ] );

	// bolt carrier face visible through the ejection port
	put( boltB, chamferBox( 0.012, 0.026, 0.062, 0.002 ), 0.030, 0.022, - 0.040 );
	put( boltB, tube( 0.008, 0.008, 0.014, 8 ), 0.030, 0.022, - 0.070, 0, Math.PI / 2, 0 );
	const bolt = makePart( 0.030, 0.022, - 0.040, [ [ boltB, WEAPON_MATERIALS.metal ] ] );

	// charging handle
	put( chB, chamferBox( 0.052, 0.010, 0.030, 0.002 ), 0, 0.062, 0.110 );
	put( chB, chamferBox( 0.020, 0.016, 0.014, 0.002 ), - 0.028, 0.062, 0.104 );
	const chargingHandle = makePart( 0, 0.062, 0.110, [ [ chB, WEAPON_MATERIALS.metal ] ] );

	// trigger (pivots at the pin)
	put( trigB, chamferBox( 0.008, 0.030, 0.012, 0.003 ), 0, - 0.024, 0.026, 0.22 );
	const trigger = makePart( 0, - 0.012, 0.030, [ [ trigB, WEAPON_MATERIALS.metal ] ] );

	// --- hands ------------------------------------------------------------------
	addGloveHand( glove, 0.012, - 0.096, 0.086, rake, 1 );
	addSupportHand( glove, - 0.040, - 0.010, - 0.262, 0.15 );

	// --- assemble -----------------------------------------------------------------
	const m1 = mergeBucket( metal, WEAPON_MATERIALS.metal );
	const m2 = mergeBucket( poly, WEAPON_MATERIALS.polymer );
	const m3 = mergeBucket( glove, WEAPON_MATERIALS.glove );
	const m4 = mergeBucket( glass, WEAPON_MATERIALS.glass );
	const m5 = mergeBucket( retic, reticleMaterial() );
	if ( m4 ) m4.renderOrder = 2;
	if ( m5 ) m5.renderOrder = 3;
	for ( const m of [ m1, m2, m3, m4, m5 ] ) if ( m ) group.add( m );
	group.add( mag, bolt, chargingHandle, trigger );

	const muzzleTip = marker( group, 0, 0.006, - 0.552 );
	const ejectPort = marker( group, 0.046, 0.026, - 0.030 );
	const sightPoint = marker( group, 0, sight.dotY, sight.dotZ );

	return { group, muzzleTip, ejectPort, sightPoint, parts: { mag, bolt, chargingHandle, trigger } };
}

// ---------------------------------------------------------------- pistol

export function buildPistol() {
	const group = new THREE.Group();
	const metal = [], poly = [], glass = [], retic = [], glove = [];
	const magB = [], slideB = [], trigB = [];

	// --- frame -------------------------------------------------------------
	put( poly, chamferBox( 0.028, 0.032, 0.150, 0.005 ), 0, - 0.014, - 0.038 );
	put( poly, chamferBox( 0.032, 0.020, 0.062, 0.004 ), 0, - 0.026, - 0.086 );   // dust cover / rail block
	addRail( metal, 0, - 0.036, - 0.086, 0.052, 0.024 );
	put( metal, chamferBox( 0.006, 0.014, 0.048, 0.002 ), 0.017, - 0.004, - 0.010 ); // slide stop
	put( metal, tube( 0.005, 0.005, 0.012, 8 ), 0.016, - 0.014, 0.014, 0, Math.PI / 2, 0 ); // mag release

	// --- grip --------------------------------------------------------------
	const rake = - 0.30;
	addPistolGrip( poly, 0, - 0.078, 0.030, rake, 0.032, 0.112, 0.046 );
	addTriggerGuard( metal, - 0.024, - 0.028 );
	// stippling suggestion
	for ( let i = 0; i < 4; i ++ ) {
		put( poly, chamferBox( 0.034, 0.006, 0.006, 0.002 ), 0, - 0.052 - i * 0.020, 0.052 + i * 0.006, rake );
	}

	// --- barrel + muzzle ------------------------------------------------------
	put( metal, tube( 0.0095, 0.0095, 0.030, 12 ), 0, 0.014, - 0.140 );
	put( metal, tube( 0.0115, 0.0115, 0.012, 12 ), 0, 0.014, - 0.132 );  // bushing

	// --- optic ------------------------------------------------------------------
	const slideTopY = 0.034;
	const sight = addReflexSight( metal, glass, retic, 0, slideTopY, 0.006, 0.72 );

	// --- animated: slide -----------------------------------------------------------
	put( slideB, chamferBox( 0.030, 0.036, 0.180, 0.004 ), 0, 0.016, - 0.048 );
	put( slideB, chamferBox( 0.022, 0.014, 0.150, 0.003 ), 0, 0.036, - 0.040 );   // top flat
	// cocking serrations
	for ( let i = 0; i < 7; i ++ ) {
		put( slideB, chamferBox( 0.032, 0.026, 0.004, 0.001 ), 0, 0.016, 0.016 - i * 0.009 );
	}
	for ( let i = 0; i < 5; i ++ ) {
		put( slideB, chamferBox( 0.032, 0.022, 0.004, 0.001 ), 0, 0.016, - 0.104 - i * 0.009 );
	}
	// front + rear irons on the slide
	put( slideB, chamferBox( 0.005, 0.010, 0.006, 0.001 ), 0, 0.039, - 0.118 );
	put( slideB, chamferBox( 0.020, 0.010, 0.008, 0.001 ), 0, 0.039, 0.030 );
	// ejection port lip
	put( slideB, chamferBox( 0.008, 0.014, 0.048, 0.002 ), 0.014, 0.028, - 0.030 );
	const slide = makePart( 0, 0.016, - 0.048, [ [ slideB, WEAPON_MATERIALS.metal ] ] );

	// --- animated: magazine ---------------------------------------------------------
	put( magB, chamferBox( 0.026, 0.116, 0.042, 0.003 ), 0, - 0.100, 0.040, rake );
	put( magB, chamferBox( 0.032, 0.010, 0.050, 0.003 ), 0, - 0.160, 0.058, rake );
	const mag = makePart( 0, - 0.060, 0.030, [ [ magB, WEAPON_MATERIALS.metal ] ] );

	// --- animated: trigger -----------------------------------------------------------
	put( trigB, chamferBox( 0.007, 0.028, 0.010, 0.003 ), 0, - 0.026, - 0.024, 0.18 );
	const trigger = makePart( 0, - 0.014, - 0.020, [ [ trigB, WEAPON_MATERIALS.metal ] ] );

	// --- hands ---------------------------------------------------------------------------
	addGloveHand( glove, 0.012, - 0.086, 0.044, rake, 1, { palmW: 0.046, palmH: 0.082, palmD: 0.048 } );
	// support hand cupping the firing hand
	addGloveHand( glove, - 0.030, - 0.098, 0.056, rake - 0.10, - 1,
		{ palmW: 0.042, palmH: 0.074, palmD: 0.046, fingerLen: 0.044, yaw: 0.22 } );

	const m1 = mergeBucket( metal, WEAPON_MATERIALS.metal );
	const m2 = mergeBucket( poly, WEAPON_MATERIALS.polymer );
	const m3 = mergeBucket( glove, WEAPON_MATERIALS.glove );
	const m4 = mergeBucket( glass, WEAPON_MATERIALS.glass );
	const m5 = mergeBucket( retic, reticleMaterial() );
	if ( m4 ) m4.renderOrder = 2;
	if ( m5 ) m5.renderOrder = 3;
	for ( const m of [ m1, m2, m3, m4, m5 ] ) if ( m ) group.add( m );
	group.add( slide, mag, trigger );

	const muzzleTip = marker( group, 0, 0.014, - 0.156 );
	const ejectPort = marker( group, 0.026, 0.030, - 0.026 );
	const sightPoint = marker( group, 0, sight.dotY, sight.dotZ );

	return { group, muzzleTip, ejectPort, sightPoint, parts: { slide, mag, trigger } };
}

// ---------------------------------------------------------------- smg

export function buildSMG() {
	const group = new THREE.Group();
	const metal = [], poly = [], glass = [], retic = [], glove = [];
	const magB = [], boltB = [], trigB = [];

	// --- receiver ---------------------------------------------------------
	put( metal, chamferBox( 0.058, 0.078, 0.215, 0.005 ), 0, 0.004, - 0.014 );
	put( poly, chamferBox( 0.062, 0.026, 0.200, 0.005 ), 0, - 0.030, - 0.020 );    // lower shell
	addRail( metal, 0, 0.048, - 0.056, 0.230, 0.042 );
	put( metal, chamferBox( 0.006, 0.030, 0.058, 0.002 ), 0.030, 0.018, - 0.048 ); // eject port
	put( metal, chamferBox( 0.008, 0.020, 0.030, 0.003 ), - 0.030, 0.020, 0.052 ); // charging slot cover

	// --- shroud + barrel ---------------------------------------------------
	put( poly, chamferBox( 0.048, 0.048, 0.130, 0.006 ), 0, 0.002, - 0.176 );
	for ( let i = 0; i < 4; i ++ ) {
		put( poly, chamferBox( 0.054, 0.010, 0.014, 0.003 ), 0, 0.002, - 0.226 + i * 0.030 );
	}
	addRail( metal, 0, 0.028, - 0.176, 0.120, 0.040 );
	put( metal, tube( 0.0095, 0.0100, 0.190, 12 ), 0, 0.002, - 0.200 );
	// compensator
	put( metal, tube( 0.0155, 0.0155, 0.044, 12 ), 0, 0.002, - 0.272 );
	for ( let i = 0; i < 3; i ++ ) {
		put( metal, chamferBox( 0.034, 0.005, 0.006, 0.001 ), 0, 0.017, - 0.262 - i * 0.011 );
	}

	// --- folding stock ------------------------------------------------------
	put( metal, tube( 0.007, 0.007, 0.150, 8 ), 0.020, 0.036, 0.166 );
	put( metal, tube( 0.007, 0.007, 0.150, 8 ), - 0.020, 0.036, 0.166 );
	put( metal, tube( 0.007, 0.007, 0.048, 8 ), 0, 0.036, 0.238, 0, Math.PI / 2, 0 );
	put( poly, chamferBox( 0.052, 0.058, 0.020, 0.006, 2 ), 0, 0.022, 0.246 );
	put( metal, chamferBox( 0.030, 0.024, 0.026, 0.004 ), 0, 0.030, 0.096 );       // hinge

	// --- grip + guard --------------------------------------------------------
	const rake = - 0.32;
	addPistolGrip( poly, 0, - 0.088, 0.068, rake, 0.034, 0.100, 0.048 );
	addTriggerGuard( metal, 0.022, - 0.034 );
	// vertical foregrip
	put( poly, chamferBox( 0.030, 0.070, 0.032, 0.008, 2 ), 0, - 0.058, - 0.170, 0.12 );
	for ( let i = 0; i < 3; i ++ ) {
		put( poly, chamferBox( 0.034, 0.006, 0.006, 0.002 ), 0, - 0.040 - i * 0.020, - 0.186 );
	}

	// --- sights ----------------------------------------------------------------
	const railTop = 0.048 + 0.008 + 0.006;
	addIronSights( metal, railTop, - 0.150, 0.040 );
	const sight = addReflexSight( metal, glass, retic, 0, railTop, - 0.058, 0.88 );

	// --- animated: magazine (straight stick) ----------------------------------------
	put( magB, chamferBox( 0.028, 0.170, 0.046, 0.004 ), 0, - 0.140, - 0.026, 0.05 );
	for ( let i = 0; i < 5; i ++ ) {
		put( magB, chamferBox( 0.030, 0.004, 0.042, 0.002 ), 0, - 0.086 - i * 0.030, - 0.028 );
	}
	put( magB, chamferBox( 0.034, 0.012, 0.050, 0.003 ), 0, - 0.232, - 0.020 );
	const mag = makePart( 0, - 0.050, - 0.024, [ [ magB, WEAPON_MATERIALS.metal ] ] );

	// --- animated: reciprocating bolt handle -----------------------------------------
	put( boltB, chamferBox( 0.020, 0.016, 0.034, 0.003 ), - 0.036, 0.020, 0.030 );
	put( boltB, tube( 0.007, 0.007, 0.020, 8 ), - 0.046, 0.020, 0.030, 0, Math.PI / 2, 0 );
	const bolt = makePart( - 0.036, 0.020, 0.030, [ [ boltB, WEAPON_MATERIALS.metal ] ] );

	put( trigB, chamferBox( 0.008, 0.028, 0.011, 0.003 ), 0, - 0.026, 0.022, 0.20 );
	const trigger = makePart( 0, - 0.014, 0.026, [ [ trigB, WEAPON_MATERIALS.metal ] ] );

	// --- hands -----------------------------------------------------------------------
	addGloveHand( glove, 0.012, - 0.098, 0.080, rake, 1, { palmW: 0.046, palmH: 0.082 } );
	addSupportHand( glove, - 0.038, - 0.030, - 0.168, 0.28 );

	const m1 = mergeBucket( metal, WEAPON_MATERIALS.metal );
	const m2 = mergeBucket( poly, WEAPON_MATERIALS.polymer );
	const m3 = mergeBucket( glove, WEAPON_MATERIALS.glove );
	const m4 = mergeBucket( glass, WEAPON_MATERIALS.glass );
	const m5 = mergeBucket( retic, reticleMaterial() );
	if ( m4 ) m4.renderOrder = 2;
	if ( m5 ) m5.renderOrder = 3;
	for ( const m of [ m1, m2, m3, m4, m5 ] ) if ( m ) group.add( m );
	group.add( mag, bolt, trigger );

	const muzzleTip = marker( group, 0, 0.002, - 0.296 );
	const ejectPort = marker( group, 0.040, 0.022, - 0.040 );
	const sightPoint = marker( group, 0, sight.dotY, sight.dotZ );

	return { group, muzzleTip, ejectPort, sightPoint, parts: { mag, bolt, trigger } };
}

export default { buildRifle, buildPistol, buildSMG, WEAPON_MATERIALS };
