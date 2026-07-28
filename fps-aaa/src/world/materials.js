import * as THREE from 'three';
import { qualityPreset } from '../core/settings.js';

/**
 * Procedural material library for OVERPRESSURE.
 *
 * Every texel in the game is generated here at load time on <canvas> — there is
 * not a single image file in the project. The pipeline is:
 *
 *   1. Three seamless multi-octave value-noise fields are baked once into
 *      Float32Arrays (blob / mid / grit frequency bands). Materials sample
 *      those instead of each re-running fbm, which keeps load under ~350ms.
 *   2. A per-material `shade()` writes albedo + roughness + metalness +
 *      alpha + an analytic height for every texel.
 *   3. Vector detail (cracks, weld seams, drip streaks, paint chips) is drawn
 *      on top of the albedo canvas with 2D path ops.
 *   4. The final height field — analytic height blended with albedo luminance
 *      so the vector detail shows up too — is run through a Sobel pass to
 *      produce a tangent-space normal map.
 *
 * Roughness and metalness share one texture (three.js reads .g and .b
 * respectively), halving the sampler count on every PBR material.
 *
 * UVs are baked at world scale by map.js, so every texture stays at repeat 1,1.
 */

const FIELD = 512;
const FMASK = FIELD - 1;
const FSHIFT = 9;

// ---------------------------------------------------------------------------
// noise
// ---------------------------------------------------------------------------

function mulberry32( seed ) {
	let a = seed >>> 0;
	return function () {
		a = ( a + 0x6D2B79F5 ) | 0;
		let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
	};
}

/**
 * Bake one seamless value-noise field. `octaves` lists lattice resolutions from
 * coarse to fine; each octave contributes half the amplitude of the previous.
 * The lattice wraps, so the resulting FIELDxFIELD image tiles perfectly.
 */
function buildField( seed, octaves ) {
	const out = new Float32Array( FIELD * FIELD );
	const rng = mulberry32( seed );
	let amp = 1, norm = 0;

	for ( let o = 0; o < octaves.length; o ++ ) {
		const cells = octaves[ o ];
		const lat = new Float32Array( cells * cells );
		for ( let i = 0; i < lat.length; i ++ ) lat[ i ] = rng();

		const step = cells / FIELD;
		for ( let y = 0; y < FIELD; y ++ ) {
			const fy = y * step;
			const y0 = fy | 0;
			const ty = fy - y0;
			const sy = ty * ty * ( 3 - 2 * ty );
			const r0 = ( y0 % cells ) * cells;
			const r1 = ( ( y0 + 1 ) % cells ) * cells;
			const row = y << FSHIFT;
			for ( let x = 0; x < FIELD; x ++ ) {
				const fx = x * step;
				const x0 = fx | 0;
				const tx0 = fx - x0;
				const sx = tx0 * tx0 * ( 3 - 2 * tx0 );
				const c0 = x0 % cells;
				const c1 = ( x0 + 1 ) % cells;
				const a = lat[ r0 + c0 ], b = lat[ r0 + c1 ];
				const c = lat[ r1 + c0 ], d = lat[ r1 + c1 ];
				out[ row + x ] += ( ( a + ( b - a ) * sx ) * ( 1 - sy ) + ( c + ( d - c ) * sx ) * sy ) * amp;
			}
		}
		norm += amp;
		amp *= 0.5;
	}

	const inv = 1 / norm;
	for ( let i = 0; i < out.length; i ++ ) out[ i ] *= inv;
	return out;
}

let F_BLOB = null, F_MID = null, F_GRIT = null;

function ensureFields() {
	if ( F_BLOB ) return;
	F_BLOB = buildField( 0x51ed, [ 2, 4, 8, 16 ] );     // metre-scale patches / stains
	F_MID = buildField( 0x2c9a, [ 8, 16, 32, 64 ] );    // decimetre detail
	F_GRIT = buildField( 0x7b13, [ 48, 96, 192, 384 ] ); // aggregate / pitting
}

/** Nearest sample, wrapped. x/y are field texels (may exceed FIELD). */
function nf( f, x, y ) {
	return f[ ( ( y & FMASK ) << FSHIFT ) + ( x & FMASK ) ];
}

/** Bilinear sample, wrapped. */
function bf( f, x, y ) {
	const x0 = x | 0, y0 = y | 0;
	const tx = x - x0, ty = y - y0;
	const r0 = ( y0 & FMASK ) << FSHIFT, r1 = ( ( y0 + 1 ) & FMASK ) << FSHIFT;
	const c0 = x0 & FMASK, c1 = ( x0 + 1 ) & FMASK;
	const a = f[ r0 + c0 ], b = f[ r0 + c1 ], c = f[ r1 + c0 ], d = f[ r1 + c1 ];
	return ( a + ( b - a ) * tx ) * ( 1 - ty ) + ( c + ( d - c ) * tx ) * ty;
}

// ---------------------------------------------------------------------------
// small math helpers
// ---------------------------------------------------------------------------

const clamp01 = ( x ) => x < 0 ? 0 : x > 1 ? 1 : x;
const mix = ( a, b, t ) => a + ( b - a ) * t;

function smoothstep( e0, e1, x ) {
	let t = ( x - e0 ) / ( e1 - e0 );
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	return t * t * ( 3 - 2 * t );
}

function hash2( x, y ) {
	let h = Math.imul( x | 0, 374761393 ) ^ Math.imul( y | 0, 668265263 );
	h = Math.imul( h ^ ( h >>> 13 ), 1274126177 );
	return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967296;
}

// ---------------------------------------------------------------------------
// canvas / texture plumbing
// ---------------------------------------------------------------------------

function makeCanvas( size ) {
	const c = document.createElement( 'canvas' );
	c.width = size;
	c.height = size;
	return c;
}

// scratch written by every shade() so the per-texel loop never allocates:
// [ r, g, b, roughness, metalness, alpha, height ]
const OUT = new Float32Array( 7 );

/**
 * Rasterise a material spec into { map, ormMap, normalMap }.
 *
 * spec = {
 *   size, shade(o,u,v,fx,fy), decorate?(ctx,size,rng), heightFromAlbedo?, bump?
 * }
 */
function rasterise( spec, anisotropy ) {
	const S = spec.size;
	const k = FIELD / S;

	const albedoCanvas = makeCanvas( S );
	const actx = albedoCanvas.getContext( '2d', { willReadFrequently: true } );
	const aimg = actx.createImageData( S, S );
	const ad = aimg.data;

	const ormCanvas = makeCanvas( S );
	const octx = ormCanvas.getContext( '2d' );
	const oimg = octx.createImageData( S, S );
	const od = oimg.data;

	const analytic = new Float32Array( S * S );
	const invS = 1 / S;

	// No real surface reflects less than ~4% — anything darker than this is a
	// black hole under any lighting rig, which is what crushed the containers
	// and the shadow-side concrete. Darkness has to come from the lighting.
	const floor = spec.albedoFloor !== undefined ? spec.albedoFloor : 46;

	for ( let y = 0; y < S; y ++ ) {
		const fy = y * k;
		const v = y * invS;
		const row = y * S;
		for ( let x = 0; x < S; x ++ ) {
			spec.shade( OUT, x * invS, v, x * k, fy );
			const i = ( row + x ) * 4;
			ad[ i ] = OUT[ 0 ] < floor ? floor : OUT[ 0 ];
			ad[ i + 1 ] = OUT[ 1 ] < floor ? floor : OUT[ 1 ];
			ad[ i + 2 ] = OUT[ 2 ] < floor ? floor : OUT[ 2 ];
			ad[ i + 3 ] = OUT[ 5 ] * 255;
			od[ i ] = 255;                       // unused (kept opaque-white for clarity)
			od[ i + 1 ] = OUT[ 3 ] * 255;        // roughness -> .g
			od[ i + 2 ] = OUT[ 4 ] * 255;        // metalness -> .b
			od[ i + 3 ] = 255;
			analytic[ row + x ] = OUT[ 6 ];
		}
	}

	actx.putImageData( aimg, 0, 0 );
	octx.putImageData( oimg, 0, 0 );

	if ( spec.decorate ) {
		actx.save();
		spec.decorate( actx, S, mulberry32( spec.seed || 0x1234 ) );
		actx.restore();
	}

	// ---- height = analytic blended with albedo luminance, then Sobel --------
	const painted = actx.getImageData( 0, 0, S, S ).data;
	const lumWeight = spec.heightFromAlbedo !== undefined ? spec.heightFromAlbedo : 0.35;
	const height = new Float32Array( S * S );
	let lumSum = 0;
	for ( let i = 0, p = 0; i < height.length; i ++, p += 4 ) {
		const lum = ( painted[ p ] * 0.299 + painted[ p + 1 ] * 0.587 + painted[ p + 2 ] * 0.114 ) / 255;
		lumSum += lum;
		height[ i ] = mix( analytic[ i ], lum, lumWeight );
	}
	// mean is handed to the detile shader patch so the second sample divides out
	// to ~1 and only modulates, never darkens
	const meanLum = lumSum / height.length;

	const normalCanvas = makeCanvas( S );
	const nctx = normalCanvas.getContext( '2d' );
	const nimg = nctx.createImageData( S, S );
	const nd = nimg.data;
	const strength = ( spec.bump !== undefined ? spec.bump : 1 ) * S * 0.045;
	const m = S - 1;

	for ( let y = 0; y < S; y ++ ) {
		const ym = ( ( y - 1 ) & m ) * S, yp = ( ( y + 1 ) & m ) * S, yc = y * S;
		for ( let x = 0; x < S; x ++ ) {
			const xm = ( x - 1 ) & m, xp = ( x + 1 ) & m;
			// Sobel
			const tl = height[ ym + xm ], t = height[ ym + x ], tr = height[ ym + xp ];
			const l = height[ yc + xm ], r = height[ yc + xp ];
			const bl = height[ yp + xm ], b = height[ yp + x ], br = height[ yp + xp ];
			const dx = ( tr + 2 * r + br ) - ( tl + 2 * l + bl );
			const dy = ( bl + 2 * b + br ) - ( tl + 2 * t + tr );
			let nx = - dx * strength, ny = dy * strength, nz = 1;
			const inv = 1 / Math.sqrt( nx * nx + ny * ny + 1 );
			nx *= inv; ny *= inv; nz *= inv;
			const i = ( yc + x ) * 4;
			nd[ i ] = ( nx * 0.5 + 0.5 ) * 255;
			nd[ i + 1 ] = ( ny * 0.5 + 0.5 ) * 255;
			nd[ i + 2 ] = ( nz * 0.5 + 0.5 ) * 255;
			nd[ i + 3 ] = 255;
		}
	}
	nctx.putImageData( nimg, 0, 0 );

	const map = new THREE.CanvasTexture( albedoCanvas );
	map.colorSpace = THREE.SRGBColorSpace;

	const ormMap = new THREE.CanvasTexture( ormCanvas );
	const normalMap = new THREE.CanvasTexture( normalCanvas );

	for ( const t of [ map, ormMap, normalMap ] ) {
		t.wrapS = THREE.RepeatWrapping;
		t.wrapT = THREE.RepeatWrapping;
		t.anisotropy = anisotropy;
		t.needsUpdate = true;
	}

	return { map, ormMap, normalMap, meanLum };
}

// ---------------------------------------------------------------------------
// shared vector-detail painters
// ---------------------------------------------------------------------------

function drawCracks( ctx, S, rng, count, alpha, width ) {
	ctx.lineCap = 'round';
	for ( let c = 0; c < count; c ++ ) {
		let x = rng() * S, y = rng() * S;
		let ang = rng() * Math.PI * 2;
		const segs = 6 + ( rng() * 10 | 0 );
		ctx.beginPath();
		ctx.moveTo( x, y );
		for ( let s = 0; s < segs; s ++ ) {
			ang += ( rng() - 0.5 ) * 1.1;
			const len = S * ( 0.015 + rng() * 0.05 );
			x += Math.cos( ang ) * len;
			y += Math.sin( ang ) * len;
			ctx.lineTo( x, y );
		}
		ctx.strokeStyle = `rgba(0,0,0,${ alpha * ( 0.4 + rng() * 0.6 ) })`;
		ctx.lineWidth = width * ( 0.5 + rng() );
		ctx.stroke();
		// A faint bright lip sells the depth once the Sobel runs. Kept very low:
		// at higher alpha these read as pale starbursts and became the single
		// most obvious tiling tell on the perimeter wall.
		ctx.strokeStyle = `rgba(255,255,255,${ alpha * 0.07 })`;
		ctx.lineWidth = width * 0.5;
		ctx.stroke();
	}
}

function drawDrips( ctx, S, rng, count, color, alpha ) {
	for ( let i = 0; i < count; i ++ ) {
		const x = rng() * S;
		const top = rng() * S * 0.5;
		const len = S * ( 0.15 + rng() * 0.6 );
		const w = 1 + rng() * S * 0.014;
		const g = ctx.createLinearGradient( 0, top, 0, top + len );
		g.addColorStop( 0, `rgba(${color},${ alpha * ( 0.5 + rng() * 0.5 ) })` );
		g.addColorStop( 0.5, `rgba(${color},${ alpha * 0.45 })` );
		g.addColorStop( 1, `rgba(${color},0)` );
		ctx.fillStyle = g;
		ctx.fillRect( x, top, w, len );
		if ( x + w > S ) ctx.fillRect( x - S, top, w, len );
	}
}

function drawStains( ctx, S, rng, count, color, alpha ) {
	for ( let i = 0; i < count; i ++ ) {
		const x = rng() * S, y = rng() * S;
		const r = S * ( 0.06 + rng() * 0.22 );
		const g = ctx.createRadialGradient( x, y, 0, x, y, r );
		g.addColorStop( 0, `rgba(${color},${ alpha })` );
		g.addColorStop( 0.6, `rgba(${color},${ alpha * 0.45 })` );
		g.addColorStop( 1, `rgba(${color},0)` );
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.arc( x, y, r, 0, Math.PI * 2 );
		ctx.fill();
	}
}

// ---------------------------------------------------------------------------
// material specifications
// ---------------------------------------------------------------------------

function specConcrete() {
	return {
		size: 512, seed: 11, bump: 0.75, heightFromAlbedo: 0.4,
		shade( o, u, v, fx, fy ) {
			const blob = nf( F_BLOB, fx, fy );
			const mid = nf( F_MID, fx, fy );
			const grit = nf( F_GRIT, fx, fy );
			// exposed aggregate: only the top of the grit band pokes through
			const agg = smoothstep( 0.72, 0.94, grit );
			// water staining collects in the low-frequency lows
			const stain = smoothstep( 0.46, 0.16, blob ) * ( 0.55 + mid * 0.45 );
			// horizontal form-work bands from the pour
			const band = Math.abs( ( ( v * 4 ) % 1 ) - 0.5 ) < 0.035 ? 1 : 0;

			// the low-frequency blob term is deliberately weak: it is the layer
			// that reads as a repeating motif across a 60m merged wall
			let l = 0.62 + ( blob - 0.5 ) * 0.15 + ( mid - 0.5 ) * 0.19 + ( grit - 0.5 ) * 0.10;
			l += agg * 0.20;
			l -= stain * 0.17 + band * 0.08;
			l = clamp01( l );

			o[ 0 ] = 150 * l + 44;
			o[ 1 ] = 146 * l + 43;
			o[ 2 ] = 137 * l + 44;
			// stains cool and darken the hue toward the shadow palette
			o[ 0 ] -= stain * 14; o[ 1 ] -= stain * 8; o[ 2 ] -= stain * 1;
			o[ 3 ] = clamp01( 0.96 - agg * 0.26 - stain * 0.30 - ( mid - 0.5 ) * 0.10 );
			o[ 4 ] = 0;
			o[ 5 ] = 1;
			o[ 6 ] = 0.5 + ( mid - 0.5 ) * 0.4 + agg * 0.5 - band * 0.35;
		},
		decorate( ctx, S, rng ) {
			drawStains( ctx, S, rng, 11, '62,58,50', 0.10 );
			drawDrips( ctx, S, rng, 16, '68,62,54', 0.20 );
			drawCracks( ctx, S, rng, 6, 0.26, 1.1 );
		},
	};
}

function specConcreteDark() {
	return {
		size: 512, seed: 27, bump: 0.65, heightFromAlbedo: 0.35,
		shade( o, u, v, fx, fy ) {
			const blob = nf( F_BLOB, fx, fy );
			const mid = nf( F_MID, fx + 91, fy + 37 );
			const grit = nf( F_GRIT, fx, fy );
			// standing water: broad, flat, very low roughness
			const wet = smoothstep( 0.52, 0.30, blob );
			const agg = smoothstep( 0.78, 0.96, grit );
			let l = 0.52 + ( blob - 0.5 ) * 0.26 + ( mid - 0.5 ) * 0.14 + ( grit - 0.5 ) * 0.07 + agg * 0.07;
			l = clamp01( l - wet * 0.24 );

			o[ 0 ] = 96 * l + 38;
			o[ 1 ] = 94 * l + 36;
			o[ 2 ] = 92 * l + 36;
			o[ 3 ] = clamp01( mix( 0.88 - agg * 0.2, 0.14, wet ) );
			o[ 4 ] = wet * 0.10;
			o[ 5 ] = 1;
			o[ 6 ] = mix( 0.5 + ( mid - 0.5 ) * 0.5 + agg * 0.4, 0.28, wet );
		},
		decorate( ctx, S, rng ) {
			drawStains( ctx, S, rng, 9, '18,22,26', 0.26 );
			// oil slick — dark with a faint warm rim
			for ( let i = 0; i < 3; i ++ ) {
				const x = rng() * S, y = rng() * S, r = S * ( 0.08 + rng() * 0.12 );
				const g = ctx.createRadialGradient( x, y, r * 0.2, x, y, r );
				g.addColorStop( 0, 'rgba(10,10,14,0.62)' );
				g.addColorStop( 0.8, 'rgba(30,24,18,0.32)' );
				g.addColorStop( 1, 'rgba(30,24,18,0)' );
				ctx.fillStyle = g;
				ctx.beginPath(); ctx.arc( x, y, r, 0, Math.PI * 2 ); ctx.fill();
			}
			drawCracks( ctx, S, rng, 7, 0.5, 1.2 );
		},
	};
}

function specAsphalt() {
	return {
		size: 512, seed: 43, bump: 0.9, heightFromAlbedo: 0.45,
		shade( o, u, v, fx, fy ) {
			const blob = nf( F_BLOB, fx + 200, fy + 11 );
			const mid = nf( F_MID, fx, fy );
			const grit = nf( F_GRIT, fx, fy );
			const stone = smoothstep( 0.62, 0.90, grit );
			const worn = smoothstep( 0.40, 0.72, blob );
			let l = 0.40 + ( mid - 0.5 ) * 0.16 + ( grit - 0.5 ) * 0.16 + stone * 0.34 + worn * 0.10;
			l = clamp01( l );
			o[ 0 ] = 108 * l + 34;
			o[ 1 ] = 102 * l + 31;
			o[ 2 ] = 94 * l + 27;
			o[ 3 ] = clamp01( 0.92 - stone * 0.30 - worn * 0.16 );
			o[ 4 ] = 0;
			o[ 5 ] = 1;
			o[ 6 ] = 0.42 + stone * 0.58 + ( mid - 0.5 ) * 0.2;
		},
		decorate( ctx, S, rng ) {
			// tar-sealed cracks read as slightly raised glossy worms
			ctx.lineCap = 'round';
			for ( let c = 0; c < 6; c ++ ) {
				let x = rng() * S, y = rng() * S, ang = rng() * Math.PI * 2;
				ctx.beginPath(); ctx.moveTo( x, y );
				for ( let s = 0; s < 10; s ++ ) {
					ang += ( rng() - 0.5 ) * 1.3;
					x += Math.cos( ang ) * S * 0.06;
					y += Math.sin( ang ) * S * 0.06;
					ctx.lineTo( x, y );
				}
				ctx.strokeStyle = 'rgba(16,16,18,0.85)';
				ctx.lineWidth = 2 + rng() * 4;
				ctx.stroke();
			}
			drawStains( ctx, S, rng, 5, '10,10,12', 0.35 );
			drawStains( ctx, S, rng, 4, '150,140,124', 0.10 );
		},
	};
}

function specMetal() {
	return {
		size: 256, seed: 61, bump: 0.5, heightFromAlbedo: 0.3,
		shade( o, u, v, fx, fy ) {
			// anisotropic brushing: high frequency across U, stretched along V
			const brush = bf( F_GRIT, fx * 3, fy * 0.25 );
			const mid = nf( F_MID, fx, fy );
			const blob = nf( F_BLOB, fx, fy );
			const spangle = smoothstep( 0.55, 0.85, nf( F_MID, fx * 2 + 300, fy * 2 ) );
			let l = 0.66 + ( brush - 0.5 ) * 0.20 + ( mid - 0.5 ) * 0.10 + spangle * 0.10;
			l = clamp01( l - smoothstep( 0.55, 0.2, blob ) * 0.12 );
			o[ 0 ] = 178 * l + 24;
			o[ 1 ] = 182 * l + 26;
			o[ 2 ] = 188 * l + 30;
			o[ 3 ] = clamp01( 0.36 + ( brush - 0.5 ) * 0.24 + ( 1 - spangle ) * 0.10 );
			o[ 4 ] = 1;
			o[ 5 ] = 1;
			o[ 6 ] = 0.5 + ( brush - 0.5 ) * 0.5;
		},
		decorate( ctx, S, rng ) {
			// weld beads along a couple of horizontal seams
			for ( let i = 0; i < 2; i ++ ) {
				const y = rng() * S;
				ctx.beginPath();
				for ( let x = 0; x <= S; x += 3 ) {
					ctx.lineTo( x, y + Math.sin( x * 0.35 ) * 1.6 );
				}
				ctx.strokeStyle = 'rgba(120,116,110,0.7)';
				ctx.lineWidth = 4;
				ctx.stroke();
				ctx.strokeStyle = 'rgba(214,214,218,0.35)';
				ctx.lineWidth = 1.5;
				ctx.stroke();
			}
			drawDrips( ctx, S, rng, 6, '96,62,34', 0.35 );
		},
	};
}

function specMetalPainted() {
	return {
		size: 512, seed: 73, bump: 0.7, heightFromAlbedo: 0.4,
		shade( o, u, v, fx, fy ) {
			const blob = nf( F_BLOB, fx, fy );
			const mid = nf( F_MID, fx, fy );
			const grit = nf( F_GRIT, fx, fy );
			// paint survives where the blob field is high; elsewhere it flakes
			const chip = smoothstep( 0.50, 0.34, blob * 0.7 + mid * 0.3 );
			const rustHalo = smoothstep( 0.62, 0.42, blob * 0.7 + mid * 0.3 ) * ( 1 - chip );
			const l = clamp01( 0.62 + ( mid - 0.5 ) * 0.18 + ( grit - 0.5 ) * 0.06 );

			// industrial sea-green paint
			let r = 62 * l + 12, g = 92 * l + 16, b = 88 * l + 18;
			// bare pitted steel in the chips
			const sr = 132 * l + 20, sg = 130 * l + 20, sb = 128 * l + 22;
			r = mix( r, sr, chip ); g = mix( g, sg, chip ); b = mix( b, sb, chip );
			// rust bleeding out of the chip edges
			r = mix( r, 128 * l + 30, rustHalo ); g = mix( g, 68 * l + 16, rustHalo ); b = mix( b, 38 * l + 10, rustHalo );

			o[ 0 ] = r; o[ 1 ] = g; o[ 2 ] = b;
			o[ 3 ] = clamp01( mix( 0.48 + ( grit - 0.5 ) * 0.1, 0.86, Math.max( chip, rustHalo ) ) );
			o[ 4 ] = mix( 0.18, 0.85, chip ) * ( 1 - rustHalo * 0.6 );
			o[ 5 ] = 1;
			o[ 6 ] = 0.55 - chip * 0.35 + ( grit - 0.5 ) * 0.2;
		},
		decorate( ctx, S, rng ) {
			drawDrips( ctx, S, rng, 16, '108,58,28', 0.34 );
			drawStains( ctx, S, rng, 5, '20,26,26', 0.18 );
			drawCracks( ctx, S, rng, 4, 0.3, 1.0 );
		},
	};
}

function specRustMetal() {
	return {
		size: 512, seed: 89, bump: 1.0, heightFromAlbedo: 0.45,
		shade( o, u, v, fx, fy ) {
			const blob = nf( F_BLOB, fx, fy );
			const mid = nf( F_MID, fx + 55, fy + 17 );
			const grit = nf( F_GRIT, fx, fy );
			const deep = smoothstep( 0.58, 0.28, blob );          // deep corroded pockets
			const bright = smoothstep( 0.52, 0.80, blob * 0.6 + mid * 0.4 );
			const pit = smoothstep( 0.66, 0.92, grit );
			const l = clamp01( 0.58 + ( mid - 0.5 ) * 0.26 + ( grit - 0.5 ) * 0.14 );

			let r = 138 * l + 24, g = 78 * l + 12, b = 44 * l + 8;
			r = mix( r, 74 * l + 12, deep ); g = mix( g, 44 * l + 8, deep ); b = mix( b, 34 * l + 8, deep );
			r = mix( r, 182 * l + 30, bright ); g = mix( g, 108 * l + 16, bright ); b = mix( b, 54 * l + 8, bright );

			o[ 0 ] = r; o[ 1 ] = g; o[ 2 ] = b;
			o[ 3 ] = clamp01( 0.90 - bright * 0.16 + pit * 0.08 );
			// iron oxide is a dielectric — at the old 0.62 base the pillars
			// mirrored the blue zenith and went mottled cyan
			o[ 4 ] = clamp01( 0.30 - deep * 0.26 + bright * 0.24 );
			o[ 5 ] = 1;
			o[ 6 ] = 0.55 + ( mid - 0.5 ) * 0.5 - deep * 0.4 + pit * 0.25;
		},
		decorate( ctx, S, rng ) {
			drawDrips( ctx, S, rng, 22, '92,44,18', 0.40 );
			drawStains( ctx, S, rng, 8, '48,26,14', 0.28 );
			drawStains( ctx, S, rng, 4, '196,124,60', 0.16 );
		},
	};
}

function specCorrugated() {
	const RIDGES = 12;
	return {
		// bump was 1.5: the ridge frequency is high enough that a strong normal
		// map aliased into crawling speckle on every container roof
		size: 512, seed: 101, bump: 0.85, heightFromAlbedo: 0.12,
		shade( o, u, v, fx, fy ) {
			// trapezoidal profile reads far crisper than a pure sine at grazing angles
			const p = ( u * RIDGES ) % 1;
			const tri = p < 0.5 ? p * 2 : ( 1 - p ) * 2;
			const ridge = smoothstep( 0.12, 0.88, tri );
			const valley = 1 - ridge;

			const mid = nf( F_MID, fx, fy );
			const grit = nf( F_GRIT, fx, fy );
			const blob = nf( F_BLOB, fx, fy );
			// rust and grime collect in the valleys and run down V
			const streak = bf( F_MID, fx * 2, fy * 0.2 );
			const rust = clamp01( valley * 0.65 * smoothstep( 0.35, 0.75, streak ) + smoothstep( 0.62, 0.30, blob ) * 0.5 );

			const l = clamp01( 0.50 + ridge * 0.21 + ( mid - 0.5 ) * 0.14 + ( grit - 0.5 ) * 0.05 );
			// offsets are high on purpose: this map gets multiplied by the
			// container tint, and a dark base times a dark tint is a black hole
			let r = 108 * l + 40, g = 111 * l + 42, b = 109 * l + 44;
			r = mix( r, 134 * l + 48, rust ); g = mix( g, 76 * l + 32, rust ); b = mix( b, 42 * l + 24, rust );

			o[ 0 ] = r; o[ 1 ] = g; o[ 2 ] = b;
			o[ 3 ] = clamp01( 0.52 + rust * 0.36 + valley * 0.08 );
			// painted steel: dielectric where the paint survives, and the rust
			// patches are not metal at all
			o[ 4 ] = clamp01( 0.52 - rust * 0.44 );
			o[ 5 ] = 1;
			o[ 6 ] = tri * 0.92 + ( grit - 0.5 ) * 0.08;
		},
		decorate( ctx, S, rng ) {
			// fastener rows every few ridges
			ctx.fillStyle = 'rgba(58,52,46,0.85)';
			for ( let ry = 0; ry < 4; ry ++ ) {
				const y = ( ry + 0.5 ) * S / 4 + ( rng() - 0.5 ) * 6;
				for ( let i = 0; i < RIDGES; i += 2 ) {
					const x = ( i + 0.5 ) * S / RIDGES;
					ctx.beginPath(); ctx.arc( x, y, S * 0.006, 0, Math.PI * 2 ); ctx.fill();
				}
			}
			drawDrips( ctx, S, rng, 10, '96,48,20', 0.30 );
		},
	};
}

function specWood() {
	const PLANKS = 5;
	return {
		size: 512, seed: 131, bump: 0.8, heightFromAlbedo: 0.4,
		shade( o, u, v, fx, fy ) {
			const pf = v * PLANKS;
			const pi = pf | 0;
			const pv = pf - pi;
			const tone = hash2( pi, 7 );
			// grain runs along U; the fbm warp keeps it from looking like a barcode
			const warp = bf( F_MID, fx * 0.5, fy * 3 ) * 14;
			const grain = Math.sin( ( v * 260 + warp ) ) * 0.5 + 0.5;
			const fine = nf( F_GRIT, fx, fy );
			const gap = smoothstep( 0.06, 0.0, pv ) + smoothstep( 0.94, 1.0, pv );

			let l = 0.56 + ( tone - 0.5 ) * 0.20 + ( grain - 0.5 ) * 0.16 + ( fine - 0.5 ) * 0.08;
			l = clamp01( l - gap * 0.55 );

			o[ 0 ] = 168 * l + 14;
			o[ 1 ] = 128 * l + 10;
			o[ 2 ] = 86 * l + 8;
			o[ 3 ] = clamp01( 0.82 + ( grain - 0.5 ) * 0.12 + gap * 0.1 );
			o[ 4 ] = 0;
			o[ 5 ] = 1;
			o[ 6 ] = 0.55 + ( grain - 0.5 ) * 0.35 - gap * 0.55;
		},
		decorate( ctx, S, rng ) {
			// knots
			for ( let i = 0; i < 5; i ++ ) {
				const x = rng() * S, y = ( ( rng() * 5 | 0 ) + 0.5 ) * S / 5;
				const r = S * ( 0.012 + rng() * 0.022 );
				for ( let k = 4; k >= 1; k -- ) {
					ctx.beginPath();
					ctx.ellipse( x, y, r * k * 0.32, r * k * 0.22, 0, 0, Math.PI * 2 );
					ctx.strokeStyle = `rgba(52,34,18,${ 0.5 / k + 0.12 })`;
					ctx.lineWidth = 1.6;
					ctx.stroke();
				}
			}
			drawStains( ctx, S, rng, 5, '40,28,16', 0.20 );
			drawStains( ctx, S, rng, 3, '30,40,44', 0.14 );
		},
	};
}

function specDirt() {
	return {
		size: 512, seed: 149, bump: 1.1, heightFromAlbedo: 0.45,
		shade( o, u, v, fx, fy ) {
			const blob = nf( F_BLOB, fx, fy );
			const mid = nf( F_MID, fx, fy );
			const grit = nf( F_GRIT, fx, fy );
			const pebble = smoothstep( 0.74, 0.93, grit );
			const damp = smoothstep( 0.48, 0.22, blob );
			let l = 0.52 + ( blob - 0.5 ) * 0.24 + ( mid - 0.5 ) * 0.2 + pebble * 0.28;
			l = clamp01( l - damp * 0.26 );
			o[ 0 ] = 128 * l + 12;
			o[ 1 ] = 102 * l + 10;
			o[ 2 ] = 74 * l + 10;
			o[ 3 ] = clamp01( 0.97 - pebble * 0.22 - damp * 0.30 );
			o[ 4 ] = 0;
			o[ 5 ] = 1;
			o[ 6 ] = 0.45 + pebble * 0.55 + ( mid - 0.5 ) * 0.2 - damp * 0.15;
		},
		decorate( ctx, S, rng ) {
			drawStains( ctx, S, rng, 8, '32,26,18', 0.24 );
			drawStains( ctx, S, rng, 5, '150,132,96', 0.12 );
		},
	};
}

function specSand() {
	return {
		size: 256, seed: 167, bump: 0.7, heightFromAlbedo: 0.4,
		shade( o, u, v, fx, fy ) {
			const blob = nf( F_BLOB, fx, fy );
			const grit = nf( F_GRIT, fx, fy );
			// wind ripples, warped so they never look like a stripe pattern
			const warp = bf( F_MID, fx * 0.6, fy * 0.6 ) * 20;
			const ripple = Math.sin( v * 42 + warp ) * 0.5 + 0.5;
			const l = clamp01( 0.66 + ( blob - 0.5 ) * 0.16 + ripple * 0.14 + ( grit - 0.5 ) * 0.12 );
			o[ 0 ] = 198 * l + 22;
			o[ 1 ] = 174 * l + 18;
			o[ 2 ] = 132 * l + 14;
			o[ 3 ] = clamp01( 0.96 + ( grit - 0.5 ) * 0.06 );
			o[ 4 ] = 0;
			o[ 5 ] = 1;
			o[ 6 ] = 0.4 + ripple * 0.4 + ( grit - 0.5 ) * 0.3;
		},
		decorate( ctx, S, rng ) {
			drawStains( ctx, S, rng, 4, '96,76,50', 0.16 );
		},
	};
}

function specPlaster() {
	return {
		size: 256, seed: 181, bump: 0.85, heightFromAlbedo: 0.45,
		shade( o, u, v, fx, fy ) {
			const blob = nf( F_BLOB, fx, fy );
			const mid = nf( F_MID, fx, fy );
			const grit = nf( F_GRIT, fx, fy );
			const peel = smoothstep( 0.47, 0.40, blob * 0.6 + mid * 0.4 );
			const l = clamp01( 0.70 + ( mid - 0.5 ) * 0.14 + ( grit - 0.5 ) * 0.07 );
			let r = 214 * l + 18, g = 202 * l + 16, b = 180 * l + 14;
			r = mix( r, 126 * l + 14, peel ); g = mix( g, 112 * l + 12, peel ); b = mix( b, 96 * l + 12, peel );
			o[ 0 ] = r; o[ 1 ] = g; o[ 2 ] = b;
			o[ 3 ] = clamp01( 0.86 + peel * 0.10 );
			o[ 4 ] = 0;
			o[ 5 ] = 1;
			o[ 6 ] = 0.62 - peel * 0.4 + ( grit - 0.5 ) * 0.12;
		},
		decorate( ctx, S, rng ) {
			drawCracks( ctx, S, rng, 9, 0.35, 1.0 );
			drawDrips( ctx, S, rng, 8, '92,80,62', 0.22 );
		},
	};
}

function specTarp() {
	return {
		size: 256, seed: 197, bump: 1.2, heightFromAlbedo: 0.3,
		shade( o, u, v, fx, fy ) {
			// woven weave: two out-of-phase high-frequency bands
			const weave = ( Math.sin( u * 340 ) * Math.sin( v * 340 ) ) * 0.5 + 0.5;
			const fold = nf( F_BLOB, fx, fy );
			const grime = nf( F_MID, fx, fy );
			const l = clamp01( 0.46 + ( fold - 0.5 ) * 0.42 + ( weave - 0.5 ) * 0.16 - ( grime - 0.5 ) * 0.12 );
			o[ 0 ] = 62 * l + 10;
			o[ 1 ] = 86 * l + 12;
			o[ 2 ] = 84 * l + 14;
			o[ 3 ] = clamp01( 0.80 + ( weave - 0.5 ) * 0.12 );
			o[ 4 ] = 0;
			o[ 5 ] = 1;
			o[ 6 ] = fold * 0.7 + weave * 0.3;
		},
		decorate( ctx, S, rng ) {
			drawStains( ctx, S, rng, 6, '24,30,28', 0.28 );
		},
	};
}

function specGlass() {
	return {
		size: 256, seed: 211, bump: 0.35, heightFromAlbedo: 0.2,
		shade( o, u, v, fx, fy ) {
			const blob = nf( F_BLOB, fx, fy );
			const mid = nf( F_MID, fx, fy );
			const smudge = clamp01( smoothstep( 0.42, 0.72, blob ) * 0.8 + ( mid - 0.5 ) * 0.3 );
			const l = 0.86 + ( mid - 0.5 ) * 0.10;
			o[ 0 ] = 176 * l + 40;
			o[ 1 ] = 196 * l + 42;
			o[ 2 ] = 198 * l + 46;
			o[ 3 ] = clamp01( 0.04 + smudge * 0.42 );
			o[ 4 ] = 0;
			o[ 5 ] = 1;
			o[ 6 ] = 0.5 + ( mid - 0.5 ) * 0.2;
		},
		decorate( ctx, S, rng ) {
			drawDrips( ctx, S, rng, 10, '150,160,150', 0.18 );
			drawCracks( ctx, S, rng, 2, 0.22, 0.8 );
		},
	};
}

function specGrate() {
	// Diamond expanded-metal / chain-link. Alpha-tested, so the holes are real.
	const N = 9;
	const WIRE = 0.13;
	return {
		size: 256, seed: 223, bump: 0.9, heightFromAlbedo: 0.15,
		shade( o, u, v, fx, fy ) {
			const a = ( ( u + v ) * N ) % 1;
			const b = ( ( u - v + 4 ) * N ) % 1;
			const da = Math.abs( a - 0.5 ), db = Math.abs( b - 0.5 );
			const inA = da > 0.5 - WIRE ? 1 : 0;
			const inB = db > 0.5 - WIRE ? 1 : 0;
			const wire = Math.max( inA, inB );
			// round the wire cross-section so the normal map gives it volume
			const cyl = wire === 0 ? 0 : Math.sqrt( Math.max( 0, 1 - Math.pow( ( inA ? ( 0.5 - da ) : ( 0.5 - db ) ) / WIRE, 2 ) ) );
			const grit = nf( F_GRIT, fx, fy );
			const rust = smoothstep( 0.45, 0.78, nf( F_BLOB, fx, fy ) );
			const l = clamp01( 0.45 + cyl * 0.40 + ( grit - 0.5 ) * 0.12 );
			o[ 0 ] = mix( 128, 150, rust ) * l + 14;
			o[ 1 ] = mix( 132, 96, rust ) * l + 14;
			o[ 2 ] = mix( 134, 58, rust ) * l + 16;
			o[ 3 ] = clamp01( 0.44 + rust * 0.42 );
			o[ 4 ] = clamp01( 0.9 - rust * 0.35 );
			o[ 5 ] = wire;
			o[ 6 ] = cyl;
		},
	};
}

// ---------------------------------------------------------------------------
// library assembly
// ---------------------------------------------------------------------------

/**
 * Break up visible tiling by modulating the albedo with a second sample of the
 * same map at an irrational scale ratio and a prime-ish offset. Dividing by the
 * baked mean luminance keeps the modulation centred on 1.0, so it perturbs the
 * low-frequency value across a big merged wall without darkening it. One extra
 * texture fetch, and it is the only thing that reliably kills a 2.5m repeat on
 * a 60m surface.
 */
function applyDetile( material, amount, scale, meanLum ) {
	const uDetile = { value: new THREE.Vector3( scale, amount, Math.max( 0.02, meanLum ) ) };
	material.userData.uDetile = uDetile;

	material.onBeforeCompile = ( shader ) => {
		shader.uniforms.uDetile = uDetile;
		shader.fragmentShader = shader.fragmentShader
			.replace( '#include <common>', '#include <common>\nuniform vec3 uDetile;' )
			.replace( '#include <map_fragment>', /* glsl */`
				#ifdef USE_MAP
					vec4 sampledDiffuseColor = texture2D( map, vMapUv );
					vec3 detileSample = texture2D( map, vMapUv * uDetile.x + vec2( 0.37, 0.61 ) ).rgb;
					float detileLum = dot( detileSample, vec3( 0.299, 0.587, 0.114 ) ) / uDetile.z;
					sampledDiffuseColor.rgb *= mix( 1.0, detileLum, uDetile.y );
					diffuseColor *= sampledDiffuseColor;
				#endif
			` );
	};
	// distinct key so three does not share a program with the undetiled variant
	material.customProgramCacheKey = () => 'detile' + scale.toFixed( 3 );
	return material;
}

function standard( tex, opts = {} ) {
	const { normalStrength = 1, detile = 0, detileScale = 0.173, ...params } = opts;
	const m = new THREE.MeshStandardMaterial( {
		map: tex.map,
		roughnessMap: tex.ormMap,
		metalnessMap: tex.ormMap,
		normalMap: tex.normalMap,
		roughness: 1,
		metalness: 1,
		...params,
	} );
	m.normalScale.set( normalStrength, normalStrength );
	if ( detile > 0 ) applyDetile( m, detile, detileScale, tex.meanLum );
	return m;
}

/**
 * Build every material used by the world. Call once, after the renderer exists.
 * Returns MeshStandardMaterial instances plus an `emissive()` factory.
 */
export function createMaterialLibrary( renderer ) {
	ensureFields();

	const q = qualityPreset();
	const aniso = Math.min( q.anisotropy, renderer.capabilities.getMaxAnisotropy() );

	const specs = {
		concrete: specConcrete(),
		concreteDark: specConcreteDark(),
		asphalt: specAsphalt(),
		metal: specMetal(),
		metalPainted: specMetalPainted(),
		rustMetal: specRustMetal(),
		corrugated: specCorrugated(),
		wood: specWood(),
		dirt: specDirt(),
		sand: specSand(),
		plaster: specPlaster(),
		tarp: specTarp(),
		glass: specGlass(),
		grate: specGrate(),
	};

	const tex = {};
	for ( const key in specs ) tex[ key ] = rasterise( specs[ key ], aniso );

	// Detiling is worth its extra fetch only on the big merged surfaces where a
	// 2-4m repeat is legible from across the arena.
	const lib = {
		concrete: standard( tex.concrete, {
			envMapIntensity: 0.95, normalStrength: 1.0, detile: 0.52, detileScale: 0.173,
		} ),
		concreteDark: standard( tex.concreteDark, {
			envMapIntensity: 1.05, normalStrength: 0.9, detile: 0.34, detileScale: 0.211,
		} ),
		asphalt: standard( tex.asphalt, {
			envMapIntensity: 0.8, normalStrength: 1.1, detile: 0.30, detileScale: 0.149,
		} ),
		metal: standard( tex.metal, { envMapIntensity: 1.35, normalStrength: 0.7 } ),
		metalPainted: standard( tex.metalPainted, { envMapIntensity: 1.1, normalStrength: 1.0 } ),
		rustMetal: standard( tex.rustMetal, { envMapIntensity: 0.95, normalStrength: 1.25 } ),
		corrugated: standard( tex.corrugated, {
			envMapIntensity: 1.15, normalStrength: 0.9, detile: 0.26, detileScale: 0.317,
		} ),
		wood: standard( tex.wood, { envMapIntensity: 0.7, normalStrength: 1.0 } ),
		dirt: standard( tex.dirt, { envMapIntensity: 0.6, normalStrength: 1.2 } ),
		sand: standard( tex.sand, { envMapIntensity: 0.7, normalStrength: 0.9 } ),
		plaster: standard( tex.plaster, {
			envMapIntensity: 0.85, normalStrength: 1.0, detile: 0.36, detileScale: 0.191,
		} ),
		tarp: standard( tex.tarp, { envMapIntensity: 0.6, normalStrength: 1.2, side: THREE.DoubleSide } ),
		glass: standard( tex.glass, {
			envMapIntensity: 2.2, normalStrength: 0.4,
			transparent: true, opacity: 0.30, depthWrite: false,
			color: 0xbcd6d8, side: THREE.DoubleSide,
		} ),
		grate: standard( tex.grate, {
			envMapIntensity: 1.1, normalStrength: 1.0,
			alphaTest: 0.5, side: THREE.DoubleSide,
		} ),
	};

	// Steel with no paint left at all — used for pipes and railings so they read
	// darker than the painted structure and keep the value hierarchy clean.
	lib.metalDark = lib.metal.clone();
	lib.metalDark.color.setHex( 0x6d7176 );
	lib.metalDark.envMapIntensity = 1.0;

	// Named cache so repeated emissive() calls share one material/program.
	const emissiveCache = new Map();

	/** Unlit-looking glowing material; intensity > 1 gives the bloom pass something to bite on. */
	lib.emissive = function ( colorHex, intensity = 2.0 ) {
		const key = `${ colorHex }|${ intensity }`;
		let m = emissiveCache.get( key );
		if ( m ) return m;
		m = new THREE.MeshStandardMaterial( {
			color: 0x05060a,
			emissive: new THREE.Color( colorHex ),
			emissiveIntensity: intensity,
			roughness: 0.35,
			metalness: 0,
			envMapIntensity: 0.4,
		} );
		emissiveCache.set( key, m );
		return m;
	};

	lib._textures = tex;
	lib._emissiveCache = emissiveCache;
	lib.anisotropy = aniso;

	return lib;
}

export function disposeMaterialLibrary( lib ) {
	if ( ! lib ) return;

	if ( lib._textures ) {
		for ( const key in lib._textures ) {
			const t = lib._textures[ key ];
			t.map.dispose();
			t.ormMap.dispose();
			t.normalMap.dispose();
		}
		lib._textures = null;
	}

	for ( const key in lib ) {
		const m = lib[ key ];
		if ( m && m.isMaterial ) m.dispose();
	}

	if ( lib._emissiveCache ) {
		for ( const m of lib._emissiveCache.values() ) m.dispose();
		lib._emissiveCache.clear();
	}
}

export default createMaterialLibrary;
