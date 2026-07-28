import * as THREE from 'three';
import { engine } from '../core/engine.js';
import { bus } from '../core/events.js';
import { qualityPreset } from '../core/settings.js';

/**
 * OVERPRESSURE particle systems.
 *
 * Everything is pooled and everything is a single draw call. There is no
 * allocation anywhere in `update()` — particle state lives in one flat
 * Float32Array per pool with a swap-remove free list, and the GPU attribute
 * arrays are written in place from that state.
 *
 * Billboarding happens in the vertex shader (view-space corner offsets), so
 * the CPU never needs the camera basis and quads never pop when you spin.
 * The spark pool additionally aligns and stretches its quads along the
 * view-projected velocity, which is what makes ricochets read as streaks
 * rather than dots.
 *
 * Draw calls: 6 quad pools + tracers + shells + dust motes = 9.
 */

// ---------------------------------------------------------------------------
// sprite textures — procedural, like everything else in this project
// ---------------------------------------------------------------------------

function canvas2d( size ) {
	const c = document.createElement( 'canvas' );
	c.width = c.height = size;
	return c;
}

function finishTexture( canvas ) {
	const t = new THREE.CanvasTexture( canvas );
	t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
	t.minFilter = THREE.LinearMipmapLinearFilter;
	t.magFilter = THREE.LinearFilter;
	t.needsUpdate = true;
	return t;
}

function makeSoftTexture( size = 64, power = 2.2 ) {
	const c = canvas2d( size );
	const ctx = c.getContext( '2d' );
	const img = ctx.createImageData( size, size );
	const d = img.data;
	const h = size * 0.5;
	for ( let y = 0; y < size; y ++ ) {
		for ( let x = 0; x < size; x ++ ) {
			const dx = ( x + 0.5 - h ) / h, dy = ( y + 0.5 - h ) / h;
			const r = Math.min( 1, Math.sqrt( dx * dx + dy * dy ) );
			const a = Math.pow( 1 - r, power );
			const i = ( y * size + x ) * 4;
			d[ i ] = d[ i + 1 ] = d[ i + 2 ] = 255;
			d[ i + 3 ] = a * 255;
		}
	}
	ctx.putImageData( img, 0, 0 );
	return finishTexture( c );
}

function makeFlashTexture( size = 128 ) {
	const c = canvas2d( size );
	const ctx = c.getContext( '2d' );
	const h = size * 0.5;

	ctx.clearRect( 0, 0, size, size );
	ctx.globalCompositeOperation = 'lighter';

	// halo
	let g = ctx.createRadialGradient( h, h, 0, h, h, h );
	g.addColorStop( 0, 'rgba(255,255,255,0.95)' );
	g.addColorStop( 0.16, 'rgba(255,238,196,0.62)' );
	g.addColorStop( 0.45, 'rgba(255,168,72,0.20)' );
	g.addColorStop( 1, 'rgba(255,120,30,0)' );
	ctx.fillStyle = g;
	ctx.fillRect( 0, 0, size, size );

	// star lobes: uneven lengths so it never reads as a symmetric decal
	const LOBES = 7;
	for ( let i = 0; i < LOBES; i ++ ) {
		const a = ( i / LOBES ) * Math.PI * 2 + 0.31;
		const len = h * ( 0.5 + ( i % 3 ) * 0.18 );
		const wid = h * ( 0.055 + ( i % 2 ) * 0.03 );
		ctx.save();
		ctx.translate( h, h );
		ctx.rotate( a );
		const lg = ctx.createLinearGradient( 0, 0, len, 0 );
		lg.addColorStop( 0, 'rgba(255,255,250,0.9)' );
		lg.addColorStop( 0.35, 'rgba(255,214,140,0.35)' );
		lg.addColorStop( 1, 'rgba(255,150,50,0)' );
		ctx.fillStyle = lg;
		ctx.beginPath();
		ctx.moveTo( 0, - wid );
		ctx.lineTo( len, 0 );
		ctx.lineTo( 0, wid );
		ctx.closePath();
		ctx.fill();
		ctx.restore();
	}

	// blown-out core
	g = ctx.createRadialGradient( h, h, 0, h, h, h * 0.17 );
	g.addColorStop( 0, 'rgba(255,255,255,1)' );
	g.addColorStop( 1, 'rgba(255,246,224,0)' );
	ctx.fillStyle = g;
	ctx.fillRect( 0, 0, size, size );

	return finishTexture( c );
}

function makeSmokeTexture( size = 128 ) {
	const c = canvas2d( size );
	const ctx = c.getContext( '2d' );
	const h = size * 0.5;
	ctx.clearRect( 0, 0, size, size );

	// lumpy puff built from overlapping soft blobs
	let seed = 1234;
	const rnd = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
	for ( let i = 0; i < 26; i ++ ) {
		const a = rnd() * Math.PI * 2;
		const rr = Math.pow( rnd(), 0.7 ) * h * 0.46;
		const x = h + Math.cos( a ) * rr;
		const y = h + Math.sin( a ) * rr;
		const r = h * ( 0.14 + rnd() * 0.24 );
		const g = ctx.createRadialGradient( x, y, 0, x, y, r );
		g.addColorStop( 0, 'rgba(255,255,255,0.30)' );
		g.addColorStop( 1, 'rgba(255,255,255,0)' );
		ctx.fillStyle = g;
		ctx.beginPath(); ctx.arc( x, y, r, 0, Math.PI * 2 ); ctx.fill();
	}

	// clamp to a circle so the quad edge never shows
	const img = ctx.getImageData( 0, 0, size, size );
	const d = img.data;
	for ( let y = 0; y < size; y ++ ) {
		for ( let x = 0; x < size; x ++ ) {
			const dx = ( x + 0.5 - h ) / h, dy = ( y + 0.5 - h ) / h;
			const r = Math.sqrt( dx * dx + dy * dy );
			const mask = Math.max( 0, 1 - Math.pow( Math.min( 1, r ), 1.7 ) );
			const i = ( y * size + x ) * 4;
			d[ i ] = d[ i + 1 ] = d[ i + 2 ] = 255;
			d[ i + 3 ] = Math.min( 255, d[ i + 3 ] * 2.6 * mask );
		}
	}
	ctx.putImageData( img, 0, 0 );
	return finishTexture( c );
}

function makeSparkTexture( size = 64 ) {
	// Head at u = 1 so the velocity-aligned quad puts the hot end forward.
	const c = canvas2d( size );
	const ctx = c.getContext( '2d' );
	const img = ctx.createImageData( size, size );
	const d = img.data;
	for ( let y = 0; y < size; y ++ ) {
		const v = ( y + 0.5 ) / size;
		const across = Math.exp( - Math.pow( ( v - 0.5 ) * 6.4, 2 ) );
		for ( let x = 0; x < size; x ++ ) {
			const u = ( x + 0.5 ) / size;
			const along = Math.pow( u, 2.6 );
			const a = across * along;
			const i = ( y * size + x ) * 4;
			d[ i ] = 255;
			d[ i + 1 ] = 220 + 35 * along;
			d[ i + 2 ] = 170 + 60 * along;
			d[ i + 3 ] = Math.min( 255, a * 300 );
		}
	}
	ctx.putImageData( img, 0, 0 );
	return finishTexture( c );
}

function makeChipTexture( size = 32 ) {
	const c = canvas2d( size );
	const ctx = c.getContext( '2d' );
	ctx.clearRect( 0, 0, size, size );
	ctx.fillStyle = '#ffffff';
	ctx.beginPath();
	const n = 6;
	for ( let i = 0; i < n; i ++ ) {
		const a = ( i / n ) * Math.PI * 2;
		const r = size * ( 0.24 + ( ( i * 7 ) % 5 ) * 0.038 );
		const x = size * 0.5 + Math.cos( a ) * r;
		const y = size * 0.5 + Math.sin( a ) * r * 0.8;
		if ( i === 0 ) ctx.moveTo( x, y ); else ctx.lineTo( x, y );
	}
	ctx.closePath();
	ctx.fill();
	return finishTexture( c );
}

function makeRingTexture( size = 64 ) {
	const c = canvas2d( size );
	const ctx = c.getContext( '2d' );
	const img = ctx.createImageData( size, size );
	const d = img.data;
	const h = size * 0.5;
	for ( let y = 0; y < size; y ++ ) {
		for ( let x = 0; x < size; x ++ ) {
			const dx = ( x + 0.5 - h ) / h, dy = ( y + 0.5 - h ) / h;
			const r = Math.sqrt( dx * dx + dy * dy );
			const a = Math.exp( - Math.pow( ( r - 0.72 ) * 9.0, 2 ) );
			const i = ( y * size + x ) * 4;
			d[ i ] = 255; d[ i + 1 ] = 246; d[ i + 2 ] = 226;
			d[ i + 3 ] = Math.min( 255, a * 255 );
		}
	}
	ctx.putImageData( img, 0, 0 );
	return finishTexture( c );
}

// ---------------------------------------------------------------------------
// quad pool
// ---------------------------------------------------------------------------

const QUAD_VERT = /* glsl */`
attribute vec2 aCorner;
attribute vec2 aScale;
attribute float aRot;
attribute vec4 aColor;
#ifdef ALIGNED
attribute vec3 aVel;
#endif

varying vec2 vUv;
varying vec4 vColor;

void main() {
	vUv = aCorner + 0.5;
	vColor = aColor;

	vec4 mv = modelViewMatrix * vec4( position, 1.0 );

	#ifdef ALIGNED
		vec3 vv = ( modelViewMatrix * vec4( aVel, 0.0 ) ).xyz;
		vec2 ax = length( vv.xy ) > 1e-5 ? normalize( vv.xy ) : vec2( 1.0, 0.0 );
		vec2 ay = vec2( - ax.y, ax.x );
		mv.xy += ax * ( aCorner.x * aScale.x ) + ay * ( aCorner.y * aScale.y );
	#else
		float c = cos( aRot ), s = sin( aRot );
		vec2 o = vec2( aCorner.x * aScale.x, aCorner.y * aScale.y );
		mv.xy += vec2( o.x * c - o.y * s, o.x * s + o.y * c );
	#endif

	gl_Position = projectionMatrix * mv;
}
`;

const QUAD_FRAG = /* glsl */`
precision mediump float;
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;

void main() {
	vec4 t = texture2D( uMap, vUv );
	float a = t.a * vColor.a;
	if ( a < 0.003 ) discard;
	gl_FragColor = vec4( vColor.rgb * t.rgb, a );
}
`;

// state layout (stride 20)
const S_PX = 0, S_PY = 1, S_PZ = 2;
const S_VX = 3, S_VY = 4, S_VZ = 5;
const S_AGE = 6, S_LIFE = 7;
const S_S0 = 8, S_S1 = 9;
const S_R = 10, S_G = 11, S_B = 12, S_A = 13;
const S_ROT = 14, S_ROTV = 15;
const S_GRAV = 16, S_DRAG = 17, S_FADE = 18, S_STRETCH = 19;
const STRIDE = 20;

class QuadPool {

	/**
	 * @param {THREE.Object3D} parent
	 * @param {object} opts { cap, map, additive, aligned, renderOrder }
	 */
	constructor( parent, opts ) {
		const cap = this.cap = opts.cap;
		this.count = 0;
		this._lastN = 0;
		this.state = new Float32Array( cap * STRIDE );
		this.aligned = !! opts.aligned;

		const verts = cap * 4;
		this.aPos = new Float32Array( verts * 3 );
		this.aScale = new Float32Array( verts * 2 );
		this.aRot = new Float32Array( verts );
		this.aColor = new Float32Array( verts * 4 );
		this.aVel = this.aligned ? new Float32Array( verts * 3 ) : null;

		const corner = new Float32Array( verts * 2 );
		const index = new ( verts > 65535 ? Uint32Array : Uint16Array )( cap * 6 );
		for ( let i = 0; i < cap; i ++ ) {
			const v = i * 4, c = v * 2, t = i * 6;
			corner[ c ] = - 0.5; corner[ c + 1 ] = - 0.5;
			corner[ c + 2 ] = 0.5; corner[ c + 3 ] = - 0.5;
			corner[ c + 4 ] = 0.5; corner[ c + 5 ] = 0.5;
			corner[ c + 6 ] = - 0.5; corner[ c + 7 ] = 0.5;
			index[ t ] = v; index[ t + 1 ] = v + 1; index[ t + 2 ] = v + 2;
			index[ t + 3 ] = v; index[ t + 4 ] = v + 2; index[ t + 5 ] = v + 3;
		}

		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.BufferAttribute( this.aPos, 3 ) );
		geo.setAttribute( 'aCorner', new THREE.BufferAttribute( corner, 2 ) );
		geo.setAttribute( 'aScale', new THREE.BufferAttribute( this.aScale, 2 ) );
		geo.setAttribute( 'aRot', new THREE.BufferAttribute( this.aRot, 1 ) );
		geo.setAttribute( 'aColor', new THREE.BufferAttribute( this.aColor, 4 ) );
		if ( this.aligned ) geo.setAttribute( 'aVel', new THREE.BufferAttribute( this.aVel, 3 ) );
		geo.setIndex( new THREE.BufferAttribute( index, 1 ) );
		geo.setDrawRange( 0, 0 );
		geo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e6 );

		for ( const name of [ 'position', 'aScale', 'aRot', 'aColor' ] ) {
			geo.attributes[ name ].setUsage( THREE.DynamicDrawUsage );
		}
		if ( this.aligned ) geo.attributes.aVel.setUsage( THREE.DynamicDrawUsage );

		const mat = new THREE.ShaderMaterial( {
			uniforms: { uMap: { value: opts.map } },
			vertexShader: QUAD_VERT,
			fragmentShader: QUAD_FRAG,
			defines: this.aligned ? { ALIGNED: '' } : {},
			transparent: true,
			depthWrite: false,
			depthTest: true,
			blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
			side: THREE.DoubleSide,
			fog: false,
		} );

		this.geometry = geo;
		this.material = mat;
		this.mesh = new THREE.Mesh( geo, mat );
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = opts.renderOrder !== undefined ? opts.renderOrder : 10;
		this.mesh.matrixAutoUpdate = false;
		parent.add( this.mesh );
	}

	/** Positional on purpose: this runs dozens of times per shot and must not allocate. */
	spawn( x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, rot, rotv, grav, drag, fade, stretch ) {
		let i = this.count;
		if ( i >= this.cap ) i = ( Math.random() * this.cap ) | 0;  // recycle the unlucky
		else this.count ++;

		const s = this.state, o = i * STRIDE;
		s[ o + S_PX ] = x; s[ o + S_PY ] = y; s[ o + S_PZ ] = z;
		s[ o + S_VX ] = vx; s[ o + S_VY ] = vy; s[ o + S_VZ ] = vz;
		s[ o + S_AGE ] = 0; s[ o + S_LIFE ] = life;
		s[ o + S_S0 ] = s0; s[ o + S_S1 ] = s1;
		s[ o + S_R ] = r; s[ o + S_G ] = g; s[ o + S_B ] = b; s[ o + S_A ] = a;
		s[ o + S_ROT ] = rot; s[ o + S_ROTV ] = rotv;
		s[ o + S_GRAV ] = grav; s[ o + S_DRAG ] = drag;
		s[ o + S_FADE ] = fade; s[ o + S_STRETCH ] = stretch || 0;
	}

	update( dt ) {
		const s = this.state;
		let n = this.count;
		if ( n === 0 && this._lastN === 0 ) return; // idle pool: skip the upload

		for ( let i = 0; i < n; ) {
			const o = i * STRIDE;
			const age = s[ o + S_AGE ] + dt;
			if ( age >= s[ o + S_LIFE ] ) {
				n --;
				if ( i !== n ) s.copyWithin( o, n * STRIDE, n * STRIDE + STRIDE );
				continue;
			}
			s[ o + S_AGE ] = age;

			const d = 1 - Math.min( 0.98, s[ o + S_DRAG ] * dt );
			s[ o + S_VX ] *= d;
			s[ o + S_VY ] = s[ o + S_VY ] * d + s[ o + S_GRAV ] * dt;
			s[ o + S_VZ ] *= d;

			s[ o + S_PX ] += s[ o + S_VX ] * dt;
			s[ o + S_PY ] += s[ o + S_VY ] * dt;
			s[ o + S_PZ ] += s[ o + S_VZ ] * dt;
			s[ o + S_ROT ] += s[ o + S_ROTV ] * dt;
			i ++;
		}
		this.count = n;

		const pos = this.aPos, sc = this.aScale, rt = this.aRot, cl = this.aColor, vl = this.aVel;
		for ( let i = 0; i < n; i ++ ) {
			const o = i * STRIDE;
			const t = s[ o + S_AGE ] / s[ o + S_LIFE ];
			const size = s[ o + S_S0 ] + ( s[ o + S_S1 ] - s[ o + S_S0 ] ) * t;
			const alpha = s[ o + S_A ] * Math.pow( 1 - t, s[ o + S_FADE ] );

			let sx = size;
			if ( vl ) {
				const vx = s[ o + S_VX ], vy = s[ o + S_VY ], vz = s[ o + S_VZ ];
				sx = size * ( 1 + Math.sqrt( vx * vx + vy * vy + vz * vz ) * s[ o + S_STRETCH ] );
			}

			const px = s[ o + S_PX ], py = s[ o + S_PY ], pz = s[ o + S_PZ ];
			const r = s[ o + S_R ], g = s[ o + S_G ], b = s[ o + S_B ];
			const rot = s[ o + S_ROT ];
			const base = i * 4;
			for ( let k = 0; k < 4; k ++ ) {
				const v = base + k;
				const i3 = v * 3, i2 = v * 2, i4 = v * 4;
				pos[ i3 ] = px; pos[ i3 + 1 ] = py; pos[ i3 + 2 ] = pz;
				sc[ i2 ] = sx; sc[ i2 + 1 ] = size;
				rt[ v ] = rot;
				cl[ i4 ] = r; cl[ i4 + 1 ] = g; cl[ i4 + 2 ] = b; cl[ i4 + 3 ] = alpha;
				if ( vl ) { vl[ i3 ] = s[ o + S_VX ]; vl[ i3 + 1 ] = s[ o + S_VY ]; vl[ i3 + 2 ] = s[ o + S_VZ ]; }
			}
		}

		const a = this.geometry.attributes;
		a.position.needsUpdate = true;
		a.aScale.needsUpdate = true;
		a.aRot.needsUpdate = true;
		a.aColor.needsUpdate = true;
		if ( vl ) a.aVel.needsUpdate = true;
		this.geometry.setDrawRange( 0, n * 6 );
		this._lastN = n;
	}

	dispose() {
		this.geometry.dispose();
		this.material.dispose();
		if ( this.mesh.parent ) this.mesh.parent.remove( this.mesh );
	}
}

// ---------------------------------------------------------------------------
// tracer pool — stretched view-aligned beams
// ---------------------------------------------------------------------------

const BEAM_VERT = /* glsl */`
attribute vec3 aEnd;
attribute vec2 aCorner;
attribute float aWidth;
attribute vec4 aColor;
varying vec2 vUv;
varying vec4 vColor;

void main() {
	vUv = aCorner + 0.5;
	vColor = aColor;
	vec4 a = modelViewMatrix * vec4( position, 1.0 );
	vec4 b = modelViewMatrix * vec4( aEnd, 1.0 );
	vec4 p = mix( a, b, aCorner.x + 0.5 );
	vec2 d = b.xy - a.xy;
	vec2 dir = length( d ) > 1e-5 ? normalize( d ) : vec2( 1.0, 0.0 );
	p.xy += vec2( - dir.y, dir.x ) * aCorner.y * aWidth;
	gl_Position = projectionMatrix * p;
}
`;

const BEAM_FRAG = /* glsl */`
precision mediump float;
varying vec2 vUv;
varying vec4 vColor;
void main() {
	float along = pow( vUv.x, 2.4 );
	float across = 1.0 - abs( vUv.y * 2.0 - 1.0 );
	across = pow( max( across, 0.0 ), 1.6 );
	float a = along * across * vColor.a;
	if ( a < 0.004 ) discard;
	gl_FragColor = vec4( vColor.rgb, a );
}
`;

const T_X0 = 0, T_Y0 = 1, T_Z0 = 2;
const T_DX = 3, T_DY = 4, T_DZ = 5;
const T_DIST = 6, T_T = 7, T_SPEED = 8, T_TRAIL = 9;
const T_R = 10, T_G = 11, T_B = 12, T_A = 13, T_WIDTH = 14, T_FADE = 15;
const T_STRIDE = 16;

class BeamPool {

	constructor( parent, cap ) {
		this.cap = cap;
		this.count = 0;
		this._lastN = 0;
		this.state = new Float32Array( cap * T_STRIDE );

		const verts = cap * 4;
		this.aPos = new Float32Array( verts * 3 );
		this.aEnd = new Float32Array( verts * 3 );
		this.aWidth = new Float32Array( verts );
		this.aColor = new Float32Array( verts * 4 );

		const corner = new Float32Array( verts * 2 );
		const index = new ( verts > 65535 ? Uint32Array : Uint16Array )( cap * 6 );
		for ( let i = 0; i < cap; i ++ ) {
			const v = i * 4, c = v * 2, t = i * 6;
			corner[ c ] = - 0.5; corner[ c + 1 ] = - 0.5;
			corner[ c + 2 ] = 0.5; corner[ c + 3 ] = - 0.5;
			corner[ c + 4 ] = 0.5; corner[ c + 5 ] = 0.5;
			corner[ c + 6 ] = - 0.5; corner[ c + 7 ] = 0.5;
			index[ t ] = v; index[ t + 1 ] = v + 1; index[ t + 2 ] = v + 2;
			index[ t + 3 ] = v; index[ t + 4 ] = v + 2; index[ t + 5 ] = v + 3;
		}

		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.BufferAttribute( this.aPos, 3 ) );
		geo.setAttribute( 'aEnd', new THREE.BufferAttribute( this.aEnd, 3 ) );
		geo.setAttribute( 'aCorner', new THREE.BufferAttribute( corner, 2 ) );
		geo.setAttribute( 'aWidth', new THREE.BufferAttribute( this.aWidth, 1 ) );
		geo.setAttribute( 'aColor', new THREE.BufferAttribute( this.aColor, 4 ) );
		geo.setIndex( new THREE.BufferAttribute( index, 1 ) );
		geo.setDrawRange( 0, 0 );
		geo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e6 );
		for ( const name of [ 'position', 'aEnd', 'aWidth', 'aColor' ] ) {
			geo.attributes[ name ].setUsage( THREE.DynamicDrawUsage );
		}

		this.geometry = geo;
		this.material = new THREE.ShaderMaterial( {
			uniforms: {},
			vertexShader: BEAM_VERT,
			fragmentShader: BEAM_FRAG,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			side: THREE.DoubleSide,
			fog: false,
		} );
		this.mesh = new THREE.Mesh( geo, this.material );
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 12;
		this.mesh.matrixAutoUpdate = false;
		parent.add( this.mesh );
	}

	spawn( x0, y0, z0, x1, y1, z1, speed, trail, r, g, b, a, width ) {
		let i = this.count;
		if ( i >= this.cap ) i = ( Math.random() * this.cap ) | 0;
		else this.count ++;

		const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
		const dist = Math.max( 0.001, Math.sqrt( dx * dx + dy * dy + dz * dz ) );
		const s = this.state, o = i * T_STRIDE;
		s[ o + T_X0 ] = x0; s[ o + T_Y0 ] = y0; s[ o + T_Z0 ] = z0;
		s[ o + T_DX ] = dx / dist; s[ o + T_DY ] = dy / dist; s[ o + T_DZ ] = dz / dist;
		s[ o + T_DIST ] = dist;
		s[ o + T_T ] = 0;
		s[ o + T_SPEED ] = speed;
		s[ o + T_TRAIL ] = trail;
		s[ o + T_R ] = r; s[ o + T_G ] = g; s[ o + T_B ] = b; s[ o + T_A ] = a;
		s[ o + T_WIDTH ] = width;
		s[ o + T_FADE ] = 0;
	}

	update( dt ) {
		const s = this.state;
		let n = this.count;
		if ( n === 0 && this._lastN === 0 ) return;

		for ( let i = 0; i < n; ) {
			const o = i * T_STRIDE;
			s[ o + T_T ] += s[ o + T_SPEED ] * dt;
			if ( s[ o + T_T ] >= s[ o + T_DIST ] ) {
				s[ o + T_FADE ] += dt * 22;
				if ( s[ o + T_FADE ] >= 1 ) {
					n --;
					if ( i !== n ) s.copyWithin( o, n * T_STRIDE, n * T_STRIDE + T_STRIDE );
					continue;
				}
			}
			i ++;
		}
		this.count = n;

		const pos = this.aPos, end = this.aEnd, wid = this.aWidth, col = this.aColor;
		for ( let i = 0; i < n; i ++ ) {
			const o = i * T_STRIDE;
			const dist = s[ o + T_DIST ];
			const head = Math.min( dist, s[ o + T_T ] );
			const tail = Math.max( 0, head - s[ o + T_TRAIL ] );
			const dx = s[ o + T_DX ], dy = s[ o + T_DY ], dz = s[ o + T_DZ ];
			const x0 = s[ o + T_X0 ], y0 = s[ o + T_Y0 ], z0 = s[ o + T_Z0 ];
			const tx = x0 + dx * tail, ty = y0 + dy * tail, tz = z0 + dz * tail;
			const hx = x0 + dx * head, hy = y0 + dy * head, hz = z0 + dz * head;
			const alpha = s[ o + T_A ] * ( 1 - s[ o + T_FADE ] );
			const base = i * 4;
			for ( let k = 0; k < 4; k ++ ) {
				const v = base + k, i3 = v * 3, i4 = v * 4;
				pos[ i3 ] = tx; pos[ i3 + 1 ] = ty; pos[ i3 + 2 ] = tz;
				end[ i3 ] = hx; end[ i3 + 1 ] = hy; end[ i3 + 2 ] = hz;
				wid[ v ] = s[ o + T_WIDTH ];
				col[ i4 ] = s[ o + T_R ]; col[ i4 + 1 ] = s[ o + T_G ];
				col[ i4 + 2 ] = s[ o + T_B ]; col[ i4 + 3 ] = alpha;
			}
		}

		const a = this.geometry.attributes;
		a.position.needsUpdate = true;
		a.aEnd.needsUpdate = true;
		a.aWidth.needsUpdate = true;
		a.aColor.needsUpdate = true;
		this.geometry.setDrawRange( 0, n * 6 );
		this._lastN = n;
	}

	dispose() {
		this.geometry.dispose();
		this.material.dispose();
		if ( this.mesh.parent ) this.mesh.parent.remove( this.mesh );
	}
}

// ---------------------------------------------------------------------------
// main factory
// ---------------------------------------------------------------------------

const SURFACES = {
	concrete: {
		dust: 13, dustCol: [ 0.78, 0.74, 0.68 ], dustSize: 0.30,
		chips: 9, chipCol: [ 0.55, 0.52, 0.46 ],
		sparks: 0, flash: 0.42, flashCol: [ 1.0, 0.95, 0.86 ], light: 0,
	},
	metal: {
		dust: 4, dustCol: [ 0.55, 0.53, 0.52 ], dustSize: 0.18,
		chips: 3, chipCol: [ 0.62, 0.58, 0.54 ],
		sparks: 24, sparkCol: [ 1.0, 0.60, 0.16 ], flash: 0.95, flashCol: [ 1.0, 0.82, 0.44 ], light: 1,
	},
	wood: {
		dust: 7, dustCol: [ 0.50, 0.42, 0.30 ], dustSize: 0.24,
		chips: 13, chipCol: [ 0.46, 0.33, 0.18 ],
		sparks: 0, flash: 0.26, flashCol: [ 1.0, 0.86, 0.60 ], light: 0,
	},
	glass: {
		dust: 4, dustCol: [ 0.80, 0.88, 0.90 ], dustSize: 0.18,
		chips: 17, chipCol: [ 0.78, 0.90, 0.94 ],
		sparks: 5, sparkCol: [ 0.86, 0.96, 1.0 ], flash: 0.80, flashCol: [ 0.86, 0.96, 1.0 ], light: 0,
	},
	dirt: {
		dust: 19, dustCol: [ 0.44, 0.36, 0.26 ], dustSize: 0.40,
		chips: 6, chipCol: [ 0.34, 0.27, 0.19 ],
		sparks: 0, flash: 0.14, flashCol: [ 0.9, 0.8, 0.6 ], light: 0,
	},
	sand: {
		dust: 23, dustCol: [ 0.76, 0.67, 0.49 ], dustSize: 0.44,
		chips: 3, chipCol: [ 0.62, 0.54, 0.40 ],
		sparks: 0, flash: 0.12, flashCol: [ 1.0, 0.9, 0.7 ], light: 0,
	},
};

// scratch vectors — module scope so nothing in the hot path allocates
const _n = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _camPos = new THREE.Vector3();

function orthoBasis( nx, ny, nz ) {
	// builds two tangents around the normal into _t1 / _t2, no allocation
	if ( Math.abs( ny ) < 0.9 ) _t1.set( 0, 1, 0 ); else _t1.set( 1, 0, 0 );
	_n.set( nx, ny, nz );
	_t2.crossVectors( _n, _t1 ).normalize();
	_t1.crossVectors( _t2, _n ).normalize();
}

/**
 * @param {THREE.Scene} scene     world scene
 * @param {THREE.Scene} viewScene viewmodel scene (first-person muzzle flash)
 */
export function createVFX( scene, viewScene ) {

	const q = qualityPreset();
	const scale = q.particleScale;
	const cap = ( n ) => Math.max( 24, Math.round( n * scale ) );

	const texSoft = makeSoftTexture( 64, 2.2 );
	const texFlash = makeFlashTexture( 128 );
	const texSmoke = makeSmokeTexture( 128 );
	const texSpark = makeSparkTexture( 64 );
	const texChip = makeChipTexture( 32 );
	const texRing = makeRingTexture( 64 );

	const sparks = new QuadPool( scene, { cap: cap( 640 ), map: texSpark, additive: true, aligned: true, renderOrder: 14 } );
	const debris = new QuadPool( scene, { cap: cap( 420 ), map: texChip, additive: false, renderOrder: 9 } );
	const smokePool = new QuadPool( scene, { cap: cap( 400 ), map: texSmoke, additive: false, renderOrder: 8 } );
	const glow = new QuadPool( scene, { cap: cap( 220 ), map: texSoft, additive: true, renderOrder: 13 } );
	const rings = new QuadPool( scene, { cap: 40, map: texRing, additive: true, renderOrder: 13 } );
	const flashWorld = new QuadPool( scene, { cap: 28, map: texFlash, additive: true, renderOrder: 15 } );
	const flashView = new QuadPool( viewScene, { cap: 14, map: texFlash, additive: true, renderOrder: 15 } );
	const tracers = new BeamPool( scene, 56 );

	const quadPools = [ sparks, debris, smokePool, glow, rings, flashWorld, flashView ];

	// ---- muzzle / impact lights -------------------------------------------
	// Created once and never added or removed: changing the scene's light count
	// at runtime forces every material to recompile and stutters the frame.

	const LIGHT_COUNT = 3;
	const lights = [];
	const lightLife = new Float32Array( LIGHT_COUNT );
	const lightPeak = new Float32Array( LIGHT_COUNT );
	const lightDur = new Float32Array( LIGHT_COUNT );
	for ( let i = 0; i < LIGHT_COUNT; i ++ ) {
		const l = new THREE.PointLight( 0xffb060, 0, 9, 2 );
		l.castShadow = false;
		l.visible = false;
		scene.add( l );
		lights.push( l );
	}
	let lightCursor = 0;

	function popLight( x, y, z, colorHex, peak, duration ) {
		let idx = - 1;
		for ( let i = 0; i < LIGHT_COUNT; i ++ ) {
			if ( lightLife[ i ] <= 0 ) { idx = i; break; }
		}
		if ( idx < 0 ) { idx = lightCursor; lightCursor = ( lightCursor + 1 ) % LIGHT_COUNT; }
		const l = lights[ idx ];
		l.position.set( x, y, z );
		l.color.setHex( colorHex );
		l.visible = true;
		l.intensity = peak;
		lightLife[ idx ] = duration;
		lightDur[ idx ] = duration;
		lightPeak[ idx ] = peak;
	}

	// ---- shell casings -----------------------------------------------------

	const SHELL_CAP = 26;
	const shellGeo = new THREE.BoxGeometry( 0.02, 0.02, 0.055 );
	const shellMat = new THREE.MeshStandardMaterial( {
		color: 0xc8a03a, metalness: 1.0, roughness: 0.32, envMapIntensity: 1.6,
	} );
	const shells = new THREE.InstancedMesh( shellGeo, shellMat, SHELL_CAP );
	shells.frustumCulled = false;
	shells.castShadow = false;
	shells.receiveShadow = false;
	shells.count = 0;
	shells.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
	scene.add( shells );

	// px py pz vx vy vz rx ry rz wx wy wz age life bounced
	const SH_STRIDE = 15;
	const shellState = new Float32Array( SHELL_CAP * SH_STRIDE );
	let shellCount = 0;
	const _shellM = new THREE.Matrix4();
	const _shellQ = new THREE.Quaternion();
	const _shellE = new THREE.Euler();
	const _shellP = new THREE.Vector3();
	const _shellS = new THREE.Vector3();

	// ---- ambient dust motes ------------------------------------------------
	// One Points cloud that wraps around the camera in the vertex shader, so it
	// costs literally zero CPU per frame and never runs out of motes.

	// A 26m box put almost every mote too far away to cover a pixel. 17m keeps
	// the same count inside a third of the volume, which is what makes the layer
	// actually read.
	const MOTE_BOX = 15;
	const moteCount = Math.round( 2200 * scale );
	const motePos = new Float32Array( moteCount * 3 );
	const motePhase = new Float32Array( moteCount );
	const moteSize = new Float32Array( moteCount );
	for ( let i = 0; i < moteCount; i ++ ) {
		motePos[ i * 3 ] = ( Math.random() - 0.5 ) * MOTE_BOX;
		motePos[ i * 3 + 1 ] = ( Math.random() - 0.5 ) * MOTE_BOX;
		motePos[ i * 3 + 2 ] = ( Math.random() - 0.5 ) * MOTE_BOX;
		motePhase[ i ] = Math.random() * 100;
		moteSize[ i ] = 0.5 + Math.random() * 1.6;
	}

	const moteGeo = new THREE.BufferGeometry();
	moteGeo.setAttribute( 'position', new THREE.BufferAttribute( motePos, 3 ) );
	moteGeo.setAttribute( 'aPhase', new THREE.BufferAttribute( motePhase, 1 ) );
	moteGeo.setAttribute( 'aSize', new THREE.BufferAttribute( moteSize, 1 ) );
	moteGeo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e6 );

	const moteMat = new THREE.ShaderMaterial( {
		uniforms: {
			uTime: { value: 0 },
			uCenter: { value: new THREE.Vector3() },
			uBox: { value: MOTE_BOX },
			uSunDir: { value: new THREE.Vector3( - 0.716, 0.240, 0.655 ) },
			uPixelScale: { value: 7 },
			uMap: { value: texSoft },
			uTint: { value: new THREE.Color( 0xffd2a0 ) },
			uOpacity: { value: 0.42 },
		},
		vertexShader: /* glsl */`
			attribute float aPhase;
			attribute float aSize;
			uniform float uTime;
			uniform vec3 uCenter;
			uniform float uBox;
			uniform vec3 uSunDir;
			uniform float uPixelScale;
			varying float vGlint;

			void main() {
				vec3 drift = vec3(
					sin( uTime * 0.29 + aPhase ),
					sin( uTime * 0.17 + aPhase * 1.7 ) * 0.55,
					cos( uTime * 0.23 + aPhase * 0.6 )
				) * 0.45;
				vec3 p = position + drift;
				// wrap the field around the camera: infinite motes, zero CPU cost
				vec3 rel = mod( p - uCenter + uBox * 0.5, uBox ) - uBox * 0.5;
				p = uCenter + rel;

				vec4 mv = modelViewMatrix * vec4( p, 1.0 );
				gl_Position = projectionMatrix * mv;
				// clamped below as well as above: sub-pixel motes alias into
				// sparkle, oversized ones read as falling snow
				gl_PointSize = clamp( aSize * uPixelScale / max( 0.15, - mv.z ), 1.0, 6.5 );

				// forward scattering: motes light up when they sit toward the sun
				vec3 toMote = normalize( p - cameraPosition );
				float fs = max( dot( toMote, uSunDir ), 0.0 );
				vGlint = 0.20 + pow( fs, 6.0 ) * 0.95 + pow( fs, 40.0 ) * 1.60;
				vGlint *= 0.68 + 0.32 * sin( uTime * 2.1 + aPhase * 3.0 );
				// fade the nearest ones out so they never smear over the sights
				vGlint *= smoothstep( 0.5, 2.2, - mv.z );
			}
		`,
		fragmentShader: /* glsl */`
			precision mediump float;
			uniform sampler2D uMap;
			uniform vec3 uTint;
			uniform float uOpacity;
			varying float vGlint;
			void main() {
				float a = texture2D( uMap, gl_PointCoord ).a * uOpacity * max( vGlint, 0.0 );
				if ( a < 0.004 ) discard;
				gl_FragColor = vec4( uTint, a );
			}
		`,
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		fog: false,
	} );

	const motes = new THREE.Points( moteGeo, moteMat );
	motes.frustumCulled = false;
	motes.renderOrder = 7;
	motes.matrixAutoUpdate = false;
	scene.add( motes );

	// =======================================================================
	// public effects
	// =======================================================================

	function smoke( px, py, pz, s = 1 ) {
		const n = 3 + ( Math.random() * 3 | 0 );
		for ( let i = 0; i < n; i ++ ) {
			smokePool.spawn(
				px + ( Math.random() - 0.5 ) * 0.14 * s,
				py + ( Math.random() - 0.5 ) * 0.14 * s,
				pz + ( Math.random() - 0.5 ) * 0.14 * s,
				( Math.random() - 0.5 ) * 0.5, 0.28 + Math.random() * 0.4, ( Math.random() - 0.5 ) * 0.5,
				0.9 + Math.random() * 0.8,
				0.16 * s, ( 0.9 + Math.random() * 0.7 ) * s,
				0.42, 0.40, 0.38, 0.30,
				Math.random() * 6.28, ( Math.random() - 0.5 ) * 1.1,
				0.25, 1.4, 1.5, 0,
			);
		}
	}

	function spark( px, py, pz, dx, dy, dz, count, r = 1.0, g = 0.6, b = 0.16, speed = 6 ) {
		orthoBasis( dx, dy, dz );
		for ( let i = 0; i < count; i ++ ) {
			const spread = 0.55;
			const a = Math.random() * Math.PI * 2;
			const rr = Math.random() * spread;
			const vx = dx + ( _t1.x * Math.cos( a ) + _t2.x * Math.sin( a ) ) * rr;
			const vy = dy + ( _t1.y * Math.cos( a ) + _t2.y * Math.sin( a ) ) * rr;
			const vz = dz + ( _t1.z * Math.cos( a ) + _t2.z * Math.sin( a ) ) * rr;
			const sp = speed * ( 0.35 + Math.random() * Math.random() * 1.25 );
			sparks.spawn(
				px, py, pz,
				vx * sp, vy * sp + Math.random() * 1.2, vz * sp,
				0.16 + Math.random() * 0.42,
				0.028, 0.012,
				r, g, b, 1.0,
				0, 0,
				- 11.5, 1.5, 1.1, 0.030,
			);
		}
	}

	function impactInternal( px, py, pz, nx, ny, nz, surface ) {
		const S = SURFACES[ surface ] || SURFACES.concrete;
		orthoBasis( nx, ny, nz );

		// dust puff pushed out along the normal, spreading as it rises
		const dustN = Math.max( 2, Math.round( S.dust * scale ) );
		for ( let i = 0; i < dustN; i ++ ) {
			const a = Math.random() * Math.PI * 2;
			const rr = Math.random() * 0.95;
			const sp = 0.7 + Math.random() * 2.1;
			const ox = ( _t1.x * Math.cos( a ) + _t2.x * Math.sin( a ) ) * rr;
			const oy = ( _t1.y * Math.cos( a ) + _t2.y * Math.sin( a ) ) * rr;
			const oz = ( _t1.z * Math.cos( a ) + _t2.z * Math.sin( a ) ) * rr;
			smokePool.spawn(
				px + nx * 0.03, py + ny * 0.03, pz + nz * 0.03,
				( nx * 0.9 + ox ) * sp, ( ny * 0.9 + oy ) * sp + 0.5, ( nz * 0.9 + oz ) * sp,
				0.55 + Math.random() * 0.75,
				S.dustSize * 0.35, S.dustSize * ( 2.4 + Math.random() ),
				S.dustCol[ 0 ], S.dustCol[ 1 ], S.dustCol[ 2 ], 0.52,
				Math.random() * 6.28, ( Math.random() - 0.5 ) * 2.2,
				- 0.5, 2.4, 1.6, 0,
			);
		}

		// chips / splinters / shards: gravity-driven, they settle
		const chipN = Math.max( 1, Math.round( S.chips * scale ) );
		for ( let i = 0; i < chipN; i ++ ) {
			const a = Math.random() * Math.PI * 2;
			const rr = 0.2 + Math.random() * 0.9;
			const sp = 1.8 + Math.random() * 4.4;
			const ox = ( _t1.x * Math.cos( a ) + _t2.x * Math.sin( a ) ) * rr;
			const oy = ( _t1.y * Math.cos( a ) + _t2.y * Math.sin( a ) ) * rr;
			const oz = ( _t1.z * Math.cos( a ) + _t2.z * Math.sin( a ) ) * rr;
			debris.spawn(
				px + nx * 0.02, py + ny * 0.02, pz + nz * 0.02,
				( nx + ox ) * sp, ( ny + oy ) * sp + 1.2, ( nz + oz ) * sp,
				0.5 + Math.random() * 0.7,
				0.035 + Math.random() * 0.03, 0.02,
				S.chipCol[ 0 ], S.chipCol[ 1 ], S.chipCol[ 2 ], 0.95,
				Math.random() * 6.28, ( Math.random() - 0.5 ) * 16,
				- 13.5, 0.4, 0.9, 0,
			);
		}

		if ( S.sparks > 0 ) {
			const c = S.sparkCol;
			spark( px + nx * 0.02, py + ny * 0.02, pz + nz * 0.02, nx, ny, nz,
				Math.max( 3, Math.round( S.sparks * scale ) ), c[ 0 ], c[ 1 ], c[ 2 ], 7.5 );
			orthoBasis( nx, ny, nz ); // spark() reused the scratch basis
			// two ricochet streaks that skate along the surface
			for ( let i = 0; i < 2; i ++ ) {
				const a = Math.random() * Math.PI * 2;
				const sp = 9 + Math.random() * 7;
				sparks.spawn(
					px, py, pz,
					( _t1.x * Math.cos( a ) + _t2.x * Math.sin( a ) ) * sp + nx * 1.5,
					( _t1.y * Math.cos( a ) + _t2.y * Math.sin( a ) ) * sp + ny * 1.5,
					( _t1.z * Math.cos( a ) + _t2.z * Math.sin( a ) ) * sp + nz * 1.5,
					0.34 + Math.random() * 0.24,
					0.034, 0.014,
					c[ 0 ], c[ 1 ], c[ 2 ], 1.0,
					0, 0, - 9.5, 0.8, 1.0, 0.045,
				);
			}
		}

		// impact flash + expanding shock ring
		if ( S.flash > 0 ) {
			const fc = S.flashCol;
			glow.spawn( px + nx * 0.05, py + ny * 0.05, pz + nz * 0.05, 0, 0, 0,
				0.075, 0.55 * S.flash, 0.12, fc[ 0 ], fc[ 1 ], fc[ 2 ], S.flash * 1.6,
				Math.random() * 6.28, 0, 0, 0, 1.4, 0 );
			rings.spawn( px + nx * 0.06, py + ny * 0.06, pz + nz * 0.06, 0, 0, 0,
				0.18, 0.12, 1.05 * S.flash + 0.3, fc[ 0 ], fc[ 1 ], fc[ 2 ], S.flash * 0.8,
				Math.random() * 6.28, 0, 0, 0, 1.8, 0 );
		}

		if ( S.light ) popLight( px + nx * 0.2, py + ny * 0.2, pz + nz * 0.2, 0xffa040, 7, 0.085 );
	}

	let directImpacts = false;

	function impact( point, normal, surface ) {
		directImpacts = true;
		if ( ! point ) return;
		const nx = normal ? normal.x : 0, ny = normal ? normal.y : 1, nz = normal ? normal.z : 0;
		impactInternal( point.x, point.y, point.z, nx, ny, nz, surface );
	}

	// Works before gameplay wiring exists; the first direct impact() call takes
	// over so nothing ever double-fires.
	const offHitSurface = bus.on( 'hit:surface', ( p ) => {
		if ( directImpacts || ! p || ! p.point ) return;
		const n = p.normal;
		impactInternal( p.point.x, p.point.y, p.point.z,
			n ? n.x : 0, n ? n.y : 1, n ? n.z : 0, p.surface );
	} );

	function bloodImpact( point, normal ) {
		if ( ! point ) return;
		const nx = normal ? normal.x : 0, ny = normal ? normal.y : 1, nz = normal ? normal.z : 0;
		orthoBasis( nx, ny, nz );
		const px = point.x, py = point.y, pz = point.z;

		const n = Math.max( 5, Math.round( 16 * scale ) );
		for ( let i = 0; i < n; i ++ ) {
			const a = Math.random() * Math.PI * 2;
			const rr = Math.random() * 0.85;
			const sp = 1.4 + Math.random() * 3.4;
			debris.spawn(
				px, py, pz,
				( nx + ( _t1.x * Math.cos( a ) + _t2.x * Math.sin( a ) ) * rr ) * sp,
				( ny + ( _t1.y * Math.cos( a ) + _t2.y * Math.sin( a ) ) * rr ) * sp + 0.9,
				( nz + ( _t1.z * Math.cos( a ) + _t2.z * Math.sin( a ) ) * rr ) * sp,
				0.34 + Math.random() * 0.34,
				0.036, 0.016,
				0.34, 0.035, 0.035, 0.95,
				Math.random() * 6.28, ( Math.random() - 0.5 ) * 12,
				- 12.5, 1.0, 0.85, 0,
			);
		}
		// a short dark mist so the burst reads at range without being gory
		for ( let i = 0; i < 4; i ++ ) {
			smokePool.spawn(
				px, py, pz,
				nx * 1.1 + ( Math.random() - 0.5 ), ny * 1.1 + ( Math.random() - 0.5 ), nz * 1.1 + ( Math.random() - 0.5 ),
				0.30 + Math.random() * 0.2,
				0.10, 0.42,
				0.26, 0.03, 0.03, 0.55,
				Math.random() * 6.28, ( Math.random() - 0.5 ) * 3,
				- 1.2, 3.0, 1.4, 0,
			);
		}
	}

	function muzzleFlash( pos, dir, s = 1, inViewLayer = false ) {
		if ( ! pos ) return;
		const pool = inViewLayer ? flashView : flashWorld;
		const px = pos.x, py = pos.y, pz = pos.z;
		const dx = dir ? dir.x : 0, dy = dir ? dir.y : 0, dz = dir ? dir.z : - 1;
		const vs = inViewLayer ? 0.34 : 1.0;  // viewmodel space is much smaller

		// core star + two offset lobes at different rotations
		pool.spawn( px, py, pz, 0, 0, 0, 0.045, 0.62 * s * vs, 0.34 * s * vs,
			1.0, 0.92, 0.74, 2.4, Math.random() * 6.28, 0, 0, 0, 1.1, 0 );
		pool.spawn( px + dx * 0.06 * vs, py + dy * 0.06 * vs, pz + dz * 0.06 * vs, 0, 0, 0,
			0.062, 0.34 * s * vs, 0.75 * s * vs,
			1.0, 0.70, 0.34, 1.5, Math.random() * 6.28, 0, 0, 0, 1.6, 0 );
		pool.spawn( px + dx * 0.14 * vs, py + dy * 0.14 * vs, pz + dz * 0.14 * vs, 0, 0, 0,
			0.05, 0.20 * s * vs, 0.52 * s * vs,
			1.0, 0.55, 0.22, 1.1, Math.random() * 6.28, 0, 0, 0, 1.8, 0 );

		if ( ! inViewLayer ) {
			// hot gas cone + a few burning grains thrown forward
			glow.spawn( px + dx * 0.18, py + dy * 0.18, pz + dz * 0.18, dx * 2.2, dy * 2.2, dz * 2.2,
				0.09, 0.22 * s, 0.55 * s, 1.0, 0.66, 0.3, 1.3, 0, 0, 0.4, 3.5, 1.5, 0 );
			spark( px + dx * 0.14, py + dy * 0.14, pz + dz * 0.14, dx, dy, dz,
				Math.max( 3, Math.round( 8 * scale ) ), 1.0, 0.68, 0.28, 9 );
			smokePool.spawn( px + dx * 0.3, py + dy * 0.3, pz + dz * 0.3,
				dx * 1.4, dy * 1.4 + 0.4, dz * 1.4,
				0.7, 0.12 * s, 0.85 * s, 0.5, 0.47, 0.44, 0.20,
				Math.random() * 6.28, ( Math.random() - 0.5 ) * 1.5, 0.3, 2.2, 1.6, 0 );
		} else {
			// the view-layer flash still needs to light the world
			glow.spawn( px, py, pz, 0, 0, 0, 0.05, 0.14 * s, 0.3 * s,
				1.0, 0.74, 0.4, 1.2, 0, 0, 0, 0, 1.4, 0 );
		}

		// The dynamic light always lives in the world scene. For a viewmodel
		// flash the incoming position is in viewmodel space, so derive a world
		// muzzle position from the camera instead.
		if ( inViewLayer && engine.camera ) {
			engine.camera.getWorldPosition( _camPos );
			engine.camera.getWorldDirection( _d );
			popLight(
				_camPos.x + _d.x * 0.75, _camPos.y + _d.y * 0.75 - 0.12, _camPos.z + _d.z * 0.75,
				0xffc070, 26 * s, 0.055,
			);
		} else {
			popLight( px, py, pz, 0xffc070, 26 * s, 0.055 );
		}
	}

	function tracer( from, to, speed = 340 ) {
		if ( ! from || ! to ) return;
		tracers.spawn( from.x, from.y, from.z, to.x, to.y, to.z,
			speed, 3.2, 1.0, 0.80, 0.42, 0.85, 0.035 );
	}

	function shellEject( worldPos, rightDir ) {
		if ( ! worldPos ) return;
		let i = shellCount;
		if ( i >= SHELL_CAP ) i = ( Math.random() * SHELL_CAP ) | 0;
		else shellCount ++;

		const rx = rightDir ? rightDir.x : 1;
		const ry = rightDir ? rightDir.y : 0;
		const rz = rightDir ? rightDir.z : 0;
		const o = i * SH_STRIDE;
		const s = shellState;
		s[ o ] = worldPos.x; s[ o + 1 ] = worldPos.y; s[ o + 2 ] = worldPos.z;
		const sp = 2.1 + Math.random() * 1.1;
		s[ o + 3 ] = rx * sp + ( Math.random() - 0.5 ) * 0.6;
		s[ o + 4 ] = 1.7 + Math.random() * 0.8;
		s[ o + 5 ] = rz * sp + ( Math.random() - 0.5 ) * 0.6;
		s[ o + 6 ] = Math.random() * 6.28; s[ o + 7 ] = Math.random() * 6.28; s[ o + 8 ] = Math.random() * 6.28;
		s[ o + 9 ] = ( Math.random() - 0.5 ) * 26;
		s[ o + 10 ] = ( Math.random() - 0.5 ) * 26;
		s[ o + 11 ] = ( Math.random() - 0.5 ) * 26;
		s[ o + 12 ] = 0;
		s[ o + 13 ] = 2.6;
		s[ o + 14 ] = 0;
	}

	// =======================================================================
	// frame
	// =======================================================================

	let elapsed = 0;

	function update( dt ) {
		elapsed += dt;

		for ( let i = 0; i < quadPools.length; i ++ ) quadPools[ i ].update( dt );
		tracers.update( dt );

		// ---- lights ----
		for ( let i = 0; i < LIGHT_COUNT; i ++ ) {
			if ( lightLife[ i ] <= 0 ) continue;
			lightLife[ i ] -= dt;
			if ( lightLife[ i ] <= 0 ) {
				lights[ i ].intensity = 0;
				lights[ i ].visible = false;
			} else {
				const k = lightLife[ i ] / lightDur[ i ];
				lights[ i ].intensity = lightPeak[ i ] * k * k;
			}
		}

		// ---- shells ----
		if ( shellCount > 0 ) {
			let n = shellCount;
			for ( let i = 0; i < n; ) {
				const o = i * SH_STRIDE;
				const s = shellState;
				s[ o + 12 ] += dt;
				if ( s[ o + 12 ] >= s[ o + 13 ] ) {
					n --;
					if ( i !== n ) s.copyWithin( o, n * SH_STRIDE, n * SH_STRIDE + SH_STRIDE );
					continue;
				}
				s[ o + 4 ] -= 15.5 * dt;
				s[ o ] += s[ o + 3 ] * dt;
				s[ o + 1 ] += s[ o + 4 ] * dt;
				s[ o + 2 ] += s[ o + 5 ] * dt;
				s[ o + 6 ] += s[ o + 9 ] * dt;
				s[ o + 7 ] += s[ o + 10 ] * dt;
				s[ o + 8 ] += s[ o + 11 ] * dt;

				// one bounce, then it lies still and shrinks away
				if ( s[ o + 1 ] < 0.012 && s[ o + 4 ] < 0 ) {
					if ( s[ o + 14 ] < 1 ) {
						s[ o + 14 ] = 1;
						s[ o + 1 ] = 0.012;
						s[ o + 4 ] = - s[ o + 4 ] * 0.36;
						s[ o + 3 ] *= 0.5; s[ o + 5 ] *= 0.5;
						s[ o + 9 ] *= 0.35; s[ o + 10 ] *= 0.35; s[ o + 11 ] *= 0.35;
					} else {
						s[ o + 1 ] = 0.012;
						s[ o + 3 ] *= 0.82; s[ o + 4 ] = 0; s[ o + 5 ] *= 0.82;
						s[ o + 9 ] *= 0.8; s[ o + 10 ] *= 0.8; s[ o + 11 ] *= 0.8;
					}
				}

				const fade = Math.min( 1, ( s[ o + 13 ] - s[ o + 12 ] ) / 0.5 );
				_shellE.set( s[ o + 6 ], s[ o + 7 ], s[ o + 8 ] );
				_shellQ.setFromEuler( _shellE );
				_shellM.compose( _shellP.set( s[ o ], s[ o + 1 ], s[ o + 2 ] ), _shellQ, _shellS.setScalar( fade ) );
				shells.setMatrixAt( i, _shellM );
				i ++;
			}
			shellCount = n;
			shells.count = n;
			shells.instanceMatrix.needsUpdate = true;
		}

		// ---- dust motes ----
		moteMat.uniforms.uTime.value = elapsed;
		if ( engine.camera ) {
			engine.camera.getWorldPosition( _camPos );
			moteMat.uniforms.uCenter.value.copy( _camPos );
		}
		if ( engine.renderer ) {
			// point size is in device pixels, so track the backing-store height
			moteMat.uniforms.uPixelScale.value = engine.renderer.domElement.height * 0.0085;
		}
	}

	function setSunDirection( v ) {
		if ( v ) moteMat.uniforms.uSunDir.value.copy( v );
	}

	function clear() {
		for ( const p of quadPools ) { p.count = 0; p.geometry.setDrawRange( 0, 0 ); }
		tracers.count = 0;
		tracers.geometry.setDrawRange( 0, 0 );
		shellCount = 0;
		shells.count = 0;
		for ( let i = 0; i < LIGHT_COUNT; i ++ ) {
			lightLife[ i ] = 0;
			lights[ i ].intensity = 0;
			lights[ i ].visible = false;
		}
	}

	function dispose() {
		offHitSurface();
		for ( const p of quadPools ) p.dispose();
		tracers.dispose();
		scene.remove( shells, motes );
		for ( const l of lights ) scene.remove( l );
		shellGeo.dispose();
		shellMat.dispose();
		moteGeo.dispose();
		moteMat.dispose();
		for ( const t of [ texSoft, texFlash, texSmoke, texSpark, texChip, texRing ] ) t.dispose();
	}

	return {
		muzzleFlash,
		tracer,
		impact,
		bloodImpact,
		shellEject,
		smoke: ( pos, s ) => { if ( pos ) smoke( pos.x, pos.y, pos.z, s ); },
		spark: ( pos, dir, count ) => {
			if ( ! pos ) return;
			const d = dir || _d.set( 0, 1, 0 );
			spark( pos.x, pos.y, pos.z, d.x, d.y, d.z, count || 10 );
		},
		update,
		setSunDirection,
		clear,
		dispose,
		pools: { sparks, debris, smoke: smokePool, glow, rings, flashWorld, flashView, tracers },
		motes,
		lights,
	};
}

export default createVFX;
