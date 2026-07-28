import * as THREE from 'three';
import { qualityPreset } from '../core/settings.js';

/**
 * OVERPRESSURE — pooled bullet-hole decals.
 *
 * One InstancedMesh, one draw call, one procedurally generated 2x2 atlas
 * (concrete chip / metal dent / wood splinter / glass crack). The variant is
 * chosen per instance through an instanced UV-offset attribute, and per
 * instance alpha lets the oldest decals fade out instead of popping when the
 * ring buffer wraps.
 */

const ATLAS_CELL = 128;
const UNIT_Z = new THREE.Vector3( 0, 0, 1 );

const _q = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _nrm = new THREE.Vector3();

// surface tag -> atlas cell index
const SURFACE_CELL = {
	concrete: 0, plaster: 0, asphalt: 0, dirt: 0, sand: 0,
	metal: 1, rustmetal: 1, rustMetal: 1,
	wood: 2,
	glass: 3,
};

// atlas cell index -> UV offset (canvas rows are flipped by CanvasTexture)
const CELL_UV = [ 0, 0.5, 0.5, 0.5, 0, 0, 0.5, 0 ];

function rnd( a, b ) { return a + Math.random() * ( b - a ); }

function drawConcrete( g, x, y, s ) {
	const cx = x + s / 2, cy = y + s / 2;
	// dusty halo
	let grad = g.createRadialGradient( cx, cy, s * 0.04, cx, cy, s * 0.46 );
	grad.addColorStop( 0, 'rgba(60,56,52,0.95)' );
	grad.addColorStop( 0.30, 'rgba(120,114,105,0.55)' );
	grad.addColorStop( 0.68, 'rgba(150,144,134,0.20)' );
	grad.addColorStop( 1, 'rgba(150,144,134,0)' );
	g.fillStyle = grad;
	g.beginPath(); g.arc( cx, cy, s * 0.46, 0, Math.PI * 2 ); g.fill();
	// chipped crater edge
	g.beginPath();
	const pts = 11;
	for ( let i = 0; i <= pts; i ++ ) {
		const a = i / pts * Math.PI * 2;
		const r = s * rnd( 0.115, 0.175 );
		const px = cx + Math.cos( a ) * r, py = cy + Math.sin( a ) * r;
		if ( i === 0 ) g.moveTo( px, py ); else g.lineTo( px, py );
	}
	g.closePath();
	g.fillStyle = 'rgba(22,20,19,0.97)';
	g.fill();
	g.strokeStyle = 'rgba(190,184,172,0.55)';
	g.lineWidth = s * 0.012;
	g.stroke();
	// radial hairline cracks
	g.strokeStyle = 'rgba(38,35,32,0.75)';
	for ( let i = 0; i < 7; i ++ ) {
		const a = rnd( 0, Math.PI * 2 );
		const len = s * rnd( 0.16, 0.34 );
		g.lineWidth = s * rnd( 0.004, 0.011 );
		g.beginPath();
		g.moveTo( cx + Math.cos( a ) * s * 0.13, cy + Math.sin( a ) * s * 0.13 );
		g.lineTo( cx + Math.cos( a + rnd( - 0.3, 0.3 ) ) * ( s * 0.13 + len ),
			cy + Math.sin( a + rnd( - 0.3, 0.3 ) ) * ( s * 0.13 + len ) );
		g.stroke();
	}
}

function drawMetal( g, x, y, s ) {
	const cx = x + s / 2, cy = y + s / 2;
	let grad = g.createRadialGradient( cx, cy, s * 0.03, cx, cy, s * 0.34 );
	grad.addColorStop( 0, 'rgba(18,18,20,0.98)' );
	grad.addColorStop( 0.42, 'rgba(96,100,108,0.72)' );
	grad.addColorStop( 0.72, 'rgba(178,184,196,0.42)' );
	grad.addColorStop( 1, 'rgba(178,184,196,0)' );
	g.fillStyle = grad;
	g.beginPath(); g.arc( cx, cy, s * 0.36, 0, Math.PI * 2 ); g.fill();
	// bright torn lip
	g.strokeStyle = 'rgba(226,232,240,0.85)';
	g.lineWidth = s * 0.016;
	g.beginPath();
	for ( let i = 0; i <= 12; i ++ ) {
		const a = i / 12 * Math.PI * 2;
		const r = s * rnd( 0.10, 0.135 );
		const px = cx + Math.cos( a ) * r, py = cy + Math.sin( a ) * r;
		if ( i === 0 ) g.moveTo( px, py ); else g.lineTo( px, py );
	}
	g.closePath(); g.stroke();
	g.fillStyle = 'rgba(10,10,12,0.98)';
	g.fill();
	// scraped streaks
	g.strokeStyle = 'rgba(210,216,226,0.28)';
	for ( let i = 0; i < 9; i ++ ) {
		const a = rnd( 0, Math.PI * 2 );
		g.lineWidth = s * rnd( 0.003, 0.009 );
		g.beginPath();
		g.moveTo( cx + Math.cos( a ) * s * 0.12, cy + Math.sin( a ) * s * 0.12 );
		g.lineTo( cx + Math.cos( a ) * s * rnd( 0.20, 0.33 ), cy + Math.sin( a ) * s * rnd( 0.20, 0.33 ) );
		g.stroke();
	}
}

function drawWood( g, x, y, s ) {
	const cx = x + s / 2, cy = y + s / 2;
	let grad = g.createRadialGradient( cx, cy, s * 0.03, cx, cy, s * 0.40 );
	grad.addColorStop( 0, 'rgba(24,16,10,0.98)' );
	grad.addColorStop( 0.34, 'rgba(74,50,30,0.70)' );
	grad.addColorStop( 1, 'rgba(120,86,52,0)' );
	g.fillStyle = grad;
	g.beginPath(); g.arc( cx, cy, s * 0.42, 0, Math.PI * 2 ); g.fill();
	// splintered star
	g.fillStyle = 'rgba(150,110,68,0.62)';
	for ( let i = 0; i < 12; i ++ ) {
		const a = rnd( 0, Math.PI * 2 );
		const len = s * rnd( 0.14, 0.36 );
		const wdt = s * rnd( 0.012, 0.030 );
		g.beginPath();
		g.moveTo( cx + Math.cos( a ) * s * 0.08, cy + Math.sin( a ) * s * 0.08 );
		g.lineTo( cx + Math.cos( a + 0.08 ) * len, cy + Math.sin( a + 0.08 ) * len );
		g.lineTo( cx + Math.cos( a - 0.08 ) * ( len - wdt ), cy + Math.sin( a - 0.08 ) * ( len - wdt ) );
		g.closePath(); g.fill();
	}
	g.fillStyle = 'rgba(14,9,6,0.98)';
	g.beginPath(); g.ellipse( cx, cy, s * 0.10, s * 0.085, rnd( 0, 3 ), 0, Math.PI * 2 ); g.fill();
}

function drawGlass( g, x, y, s ) {
	const cx = x + s / 2, cy = y + s / 2;
	g.strokeStyle = 'rgba(228,244,255,0.80)';
	// radial fractures
	const spokes = 13;
	const ends = [];
	for ( let i = 0; i < spokes; i ++ ) {
		const a = i / spokes * Math.PI * 2 + rnd( - 0.12, 0.12 );
		const r = s * rnd( 0.22, 0.46 );
		ends.push( a, r );
		g.lineWidth = s * rnd( 0.004, 0.012 );
		g.beginPath();
		g.moveTo( cx, cy );
		g.lineTo( cx + Math.cos( a ) * r, cy + Math.sin( a ) * r );
		g.stroke();
	}
	// concentric webs
	g.lineWidth = s * 0.006;
	for ( let ring = 0.30; ring < 1.0; ring += 0.30 ) {
		g.beginPath();
		for ( let i = 0; i <= spokes; i ++ ) {
			const idx = ( i % spokes ) * 2;
			const a = ends[ idx ], r = ends[ idx + 1 ] * ring;
			const px = cx + Math.cos( a ) * r, py = cy + Math.sin( a ) * r;
			if ( i === 0 ) g.moveTo( px, py ); else g.lineTo( px, py );
		}
		g.closePath(); g.stroke();
	}
	const grad = g.createRadialGradient( cx, cy, 0, cx, cy, s * 0.14 );
	grad.addColorStop( 0, 'rgba(10,14,18,0.95)' );
	grad.addColorStop( 0.7, 'rgba(200,228,244,0.55)' );
	grad.addColorStop( 1, 'rgba(200,228,244,0)' );
	g.fillStyle = grad;
	g.beginPath(); g.arc( cx, cy, s * 0.14, 0, Math.PI * 2 ); g.fill();
}

function buildAtlas() {
	const c = document.createElement( 'canvas' );
	c.width = c.height = ATLAS_CELL * 2;
	const g = c.getContext( '2d' );
	g.clearRect( 0, 0, c.width, c.height );
	drawConcrete( g, 0, 0, ATLAS_CELL );
	drawMetal( g, ATLAS_CELL, 0, ATLAS_CELL );
	drawWood( g, 0, ATLAS_CELL, ATLAS_CELL );
	drawGlass( g, ATLAS_CELL, ATLAS_CELL, ATLAS_CELL );
	const tex = new THREE.CanvasTexture( c );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.anisotropy = 4;
	tex.needsUpdate = true;
	return tex;
}

/**
 * @param {THREE.Scene} scene
 */
export function createDecals( scene ) {

	const limit = Math.max( 16, qualityPreset().decalLimit );

	const geo = new THREE.PlaneGeometry( 1, 1 );
	const uvOffsets = new Float32Array( limit * 2 );
	const alphas = new Float32Array( limit );
	for ( let i = 0; i < limit; i ++ ) alphas[ i ] = 0;
	const uvAttr = new THREE.InstancedBufferAttribute( uvOffsets, 2 );
	const alphaAttr = new THREE.InstancedBufferAttribute( alphas, 1 );
	uvAttr.setUsage( THREE.DynamicDrawUsage );
	alphaAttr.setUsage( THREE.DynamicDrawUsage );
	geo.setAttribute( 'aUvOffset', uvAttr );
	geo.setAttribute( 'aDecalAlpha', alphaAttr );

	const material = new THREE.MeshStandardMaterial( {
		map: buildAtlas(),
		transparent: true,
		depthWrite: false,
		roughness: 0.94,
		metalness: 0.0,
		polygonOffset: true,
		polygonOffsetFactor: - 4,
		polygonOffsetUnits: - 8,
		side: THREE.FrontSide,
	} );

	material.onBeforeCompile = ( shader ) => {
		shader.vertexShader = shader.vertexShader
			.replace( '#include <common>',
				'#include <common>\nattribute vec2 aUvOffset;\nattribute float aDecalAlpha;\nvarying float vDecalAlpha;' )
			.replace( '#include <uv_vertex>',
				'#include <uv_vertex>\n\tvMapUv = uv * 0.5 + aUvOffset;\n\tvDecalAlpha = aDecalAlpha;' );
		shader.fragmentShader = shader.fragmentShader
			.replace( '#include <common>', '#include <common>\nvarying float vDecalAlpha;' )
			.replace( '#include <map_fragment>', '#include <map_fragment>\n\tdiffuseColor.a *= vDecalAlpha;' );
	};
	material.customProgramCacheKey = () => 'overpressure-decal';

	const mesh = new THREE.InstancedMesh( geo, material, limit );
	mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
	mesh.frustumCulled = false;
	mesh.receiveShadow = false;
	mesh.castShadow = false;
	mesh.renderOrder = 1;
	mesh.count = 0;
	mesh.name = 'decals';
	scene.add( mesh );

	// slot bookkeeping — a ring buffer keyed by monotonically increasing order
	const born = new Int32Array( limit );
	const fadeIn = new Float32Array( limit );
	let used = 0;
	let writeIndex = 0;
	let order = 0;
	let alphaDirty = false;

	const FADE_START = Math.max( 4, Math.floor( limit * 0.78 ) );
	const FADE_SPAN = Math.max( 2, limit - FADE_START );

	/**
	 * @param {THREE.Vector3} point   impact point in world space
	 * @param {THREE.Vector3} normal  surface normal (unit)
	 * @param {string} surface        surface tag
	 * @param {number} [scale]        decal diameter in metres
	 */
	function add( point, normal, surface, scale ) {
		if ( ! point || ! normal ) return;
		const cell = SURFACE_CELL[ surface ] ?? 0;
		const slot = writeIndex % limit;
		writeIndex ++;
		if ( used < limit ) used ++;

		_nrm.copy( normal );
		if ( _nrm.lengthSq() < 1e-8 ) _nrm.set( 0, 1, 0 ); else _nrm.normalize();

		_q.setFromUnitVectors( UNIT_Z, _nrm );
		_qRoll.setFromAxisAngle( _nrm, Math.random() * Math.PI * 2 );
		_q.premultiply( _qRoll );

		_pos.copy( point ).addScaledVector( _nrm, 0.008 );
		const s = scale || ( surface === 'glass' ? 0.14 : 0.085 ) * ( 0.78 + Math.random() * 0.5 );
		_scale.set( s, s, s );

		_mat.compose( _pos, _q, _scale );
		mesh.setMatrixAt( slot, _mat );
		mesh.instanceMatrix.needsUpdate = true;

		uvOffsets[ slot * 2 ] = CELL_UV[ cell * 2 ];
		uvOffsets[ slot * 2 + 1 ] = CELL_UV[ cell * 2 + 1 ];
		uvAttr.needsUpdate = true;

		born[ slot ] = order ++;
		fadeIn[ slot ] = 0;
		alphas[ slot ] = 0;
		alphaDirty = true;

		mesh.count = used;
	}

	function update( dt ) {
		if ( used === 0 ) return;
		for ( let i = 0; i < used; i ++ ) {
			const rank = order - 1 - born[ i ];
			let target = 1;
			if ( rank >= FADE_START ) target = Math.max( 0, 1 - ( rank - FADE_START ) / FADE_SPAN );
			if ( fadeIn[ i ] < 1 ) fadeIn[ i ] = Math.min( 1, fadeIn[ i ] + dt * 22 );
			const a = target * fadeIn[ i ];
			if ( Math.abs( a - alphas[ i ] ) > 0.003 ) {
				alphas[ i ] = a;
				alphaDirty = true;
			}
		}
		if ( alphaDirty ) {
			alphaAttr.needsUpdate = true;
			alphaDirty = false;
		}
	}

	function clear() {
		used = 0;
		writeIndex = 0;
		order = 0;
		mesh.count = 0;
		for ( let i = 0; i < limit; i ++ ) { alphas[ i ] = 0; fadeIn[ i ] = 0; }
		alphaAttr.needsUpdate = true;
	}

	function dispose() {
		scene.remove( mesh );
		geo.dispose();
		material.map.dispose();
		material.dispose();
	}

	return { add, update, clear, dispose, mesh, get limit() { return limit; }, get count() { return used; } };
}

export default createDecals;
