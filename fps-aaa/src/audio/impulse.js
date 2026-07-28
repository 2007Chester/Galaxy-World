/**
 * OVERPRESSURE — procedural impulse responses & noise buffers.
 *
 * Everything in this file is generated mathematically into AudioBuffers at
 * init time. No files, no fetches, no base64. Nothing here may be called
 * during gameplay: a single warehouse IR is ~250k samples per channel and
 * costs single-digit milliseconds to synthesise.
 *
 * The reverb model is a two-part one: a discrete early-reflection cluster
 * (short filtered noise bursts placed at real tap times, decorrelated per
 * channel) followed by an exponentially decaying diffuse tail whose density
 * ramps up over the first ~45ms and whose lowpass cutoff falls over the decay
 * to emulate air absorption. That combination is what makes a synthetic IR
 * read as "a room" instead of "a wash of noise".
 */

const TWO_PI = Math.PI * 2;

/** Deterministic PRNG so IRs are byte-identical between runs (easier to tune). */
function mulberry32( seed ) {

	let a = seed >>> 0;
	return function () {

		a = ( a + 0x6D2B79F5 ) | 0;
		let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

/** One-pole smoothing coefficient for a given -3dB corner. */
function onePole( freq, sr ) {

	return 1 - Math.exp( - TWO_PI * Math.min( sr * 0.45, Math.max( 1, freq ) ) / sr );

}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

function fillWhite( out, rnd ) {

	for ( let i = 0; i < out.length; i ++ ) out[ i ] = rnd() * 2 - 1;

}

/** Paul Kellett's refined pink filter — flat-ish -3dB/oct down to ~10Hz. */
function fillPink( out, rnd ) {

	let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
	for ( let i = 0; i < out.length; i ++ ) {

		const w = rnd() * 2 - 1;
		b0 = 0.99886 * b0 + w * 0.0555179;
		b1 = 0.99332 * b1 + w * 0.0750759;
		b2 = 0.96900 * b2 + w * 0.1538520;
		b3 = 0.86650 * b3 + w * 0.3104856;
		b4 = 0.55000 * b4 + w * 0.5329522;
		b5 = - 0.7616 * b5 - w * 0.0168980;
		out[ i ] = ( b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362 ) * 0.11;
		b6 = w * 0.115926;

	}

}

/** Leaky integrator -> -6dB/oct. Leak keeps it from wandering off to DC. */
function fillBrown( out, rnd ) {

	let last = 0;
	for ( let i = 0; i < out.length; i ++ ) {

		const w = rnd() * 2 - 1;
		last = ( last + 0.02 * w ) / 1.02;
		out[ i ] = last * 3.5;

	}

}

function fillNoise( out, type, rnd ) {

	if ( type === 'pink' ) fillPink( out, rnd );
	else if ( type === 'brown' ) fillBrown( out, rnd );
	else fillWhite( out, rnd );

}

/**
 * Remove DC + subsonic drift in place (one-pole highpass).
 *
 * The filter state is primed from the tail of the buffer first, because these
 * buffers are looped: the samples "before" index 0 are the ones at the end.
 * Without priming, the first ~50ms is unfiltered and the loop point thumps.
 */
function dcBlock( data, sr, corner = 18 ) {

	const len = data.length;
	let mean = 0;
	for ( let i = 0; i < len; i ++ ) mean += data[ i ];
	mean /= len;

	const a = onePole( corner, sr );
	let lp = 0;

	const warm = Math.min( len, Math.floor( sr * 0.4 ) );
	for ( let i = len - warm; i < len; i ++ ) lp += a * ( ( data[ i ] - mean ) - lp );

	for ( let i = 0; i < len; i ++ ) {

		const x = data[ i ] - mean;
		lp += a * ( x - lp );
		data[ i ] = x - lp;

	}

}

function normalizeBuffer( buffer, peakTarget = 1 ) {

	let peak = 0;
	for ( let c = 0; c < buffer.numberOfChannels; c ++ ) {

		const d = buffer.getChannelData( c );
		for ( let i = 0; i < d.length; i ++ ) {

			const a = d[ i ] < 0 ? - d[ i ] : d[ i ];
			if ( a > peak ) peak = a;

		}

	}

	if ( peak < 1e-7 ) return buffer;
	const s = peakTarget / peak;
	for ( let c = 0; c < buffer.numberOfChannels; c ++ ) {

		const d = buffer.getChannelData( c );
		for ( let i = 0; i < d.length; i ++ ) d[ i ] *= s;

	}

	return buffer;

}

/**
 * Generate a noise AudioBuffer.
 *
 * @param {BaseAudioContext} ctx
 * @param {number} seconds        usable length (excluding the crossfade surplus)
 * @param {'white'|'pink'|'brown'} type
 * @param {object} [options]
 * @param {number} [options.channels=1]
 * @param {number} [options.seed]
 * @param {number} [options.loopFade=0]  seconds of surplus crossfaded back over
 *                                       the head so the buffer loops seamlessly
 * @param {boolean} [options.normalize=true]
 * @param {number} [options.peak=1]
 * @returns {AudioBuffer}
 */
export function makeNoiseBuffer( ctx, seconds = 2, type = 'white', options = {} ) {

	const {
		channels = 1,
		seed = 0x5EED1234,
		loopFade = 0,
		normalize = true,
		peak = 1,
	} = options;

	const sr = ctx.sampleRate;
	const fade = Math.max( 0, Math.floor( loopFade * sr ) );
	const outLen = Math.max( 128, Math.floor( seconds * sr ) );
	const total = outLen + fade;
	const buffer = ctx.createBuffer( channels, outLen, sr );

	for ( let c = 0; c < channels; c ++ ) {

		const rnd = mulberry32( seed + c * 104729 + ( type.charCodeAt( 0 ) << 11 ) );
		const tmp = new Float32Array( total );
		fillNoise( tmp, type, rnd );

		// Seamless loop: blend the surplus tail back across the head so the
		// wrap point is continuous in both value and slope.
		if ( fade > 0 ) {

			for ( let i = 0; i < fade; i ++ ) {

				const w = 0.5 - 0.5 * Math.cos( Math.PI * ( i / fade ) );
				tmp[ i ] = tmp[ i ] * w + tmp[ outLen + i ] * ( 1 - w );

			}

		}

		const d = buffer.getChannelData( c );
		d.set( tmp.subarray( 0, outLen ) );
		if ( type !== 'white' ) dcBlock( d, sr, type === 'brown' ? 20 : 12 );

	}

	if ( normalize ) normalizeBuffer( buffer, peak );
	return buffer;

}

// ---------------------------------------------------------------------------
// Reverb impulse responses
// ---------------------------------------------------------------------------

/**
 * Build a short windowed noise burst used as the "shape" of one early
 * reflection. A raw single-sample tap reads as a digital click; a 1-2ms
 * lowpassed burst reads as a wall.
 */
function reflectionKernel( sr, rnd, ms = 1.4, cutoff = 6500 ) {

	const n = Math.max( 4, Math.floor( ( ms / 1000 ) * sr ) );
	const k = new Float32Array( n );
	const a = onePole( cutoff, sr );
	let lp = 0;
	for ( let i = 0; i < n; i ++ ) {

		lp += a * ( ( rnd() * 2 - 1 ) - lp );
		// half-Hann: instant attack, smooth release -> impulsive but click-free
		k[ i ] = lp * ( 0.5 + 0.5 * Math.cos( Math.PI * ( i / n ) ) );

	}

	return k;

}

function addTap( data, index, gain, kernel ) {

	const end = Math.min( data.length, index + kernel.length );
	for ( let i = index < 0 ? - index : 0, j = index + i; j < end; i ++, j ++ ) {

		data[ j ] += kernel[ i ] * gain;

	}

}

/** Procedurally grow a plausible reflection cluster when none is supplied. */
function defaultReflections( seconds, rnd ) {

	const taps = [];
	let t = 0.005 + rnd() * 0.005;
	let g = 1;
	const limit = Math.min( 0.16, seconds * 0.4 );
	while ( t < limit && taps.length < 14 ) {

		taps.push( { t, g } );
		t *= 1.38 + rnd() * 0.3;
		g *= 0.72 + rnd() * 0.1;

	}

	return taps;

}

/**
 * Mathematically generated reverb impulse response.
 *
 * @param {BaseAudioContext} ctx
 * @param {number} seconds  total IR length
 * @param {number} decay    exponent of the (1-u)^decay tail envelope; higher = tighter
 * @param {object} [options]
 * @param {number} [options.channels=2]
 * @param {number} [options.preDelay]     seconds before the diffuse tail starts
 * @param {number} [options.build]        seconds for the tail to reach full level
 * @param {number} [options.brightStart]  tail lowpass cutoff at t=0
 * @param {number} [options.brightEnd]    tail lowpass cutoff at t=seconds (air absorption)
 * @param {number} [options.lowCut]       highpass corner applied to the whole IR
 * @param {number} [options.diffusion]    0..1, how quickly the tail becomes dense
 * @param {Array<{t:number,g:number}>} [options.earlyReflections]
 * @param {number} [options.erGain]       overall level of the reflection cluster
 * @param {number} [options.tailGain]     overall level of the diffuse tail
 * @param {number} [options.seed]
 * @returns {AudioBuffer}
 */
export function makeReverbIR( ctx, seconds = 1.6, decay = 2.6, options = {} ) {

	const {
		channels = 2,
		preDelay = 0.008,
		build = 0.010,
		brightStart = 9500,
		brightEnd = 900,
		lowCut = 70,
		diffusion = 0.8,
		earlyReflections = null,
		erGain = 0.7,
		tailGain = 1,
		erCutoff = 6500,
		seed = 0x9E3779B9,
	} = options;

	const sr = ctx.sampleRate;
	const len = Math.max( 256, Math.floor( seconds * sr ) );
	const buffer = ctx.createBuffer( channels, len, sr );

	// Density ramp: at t=0 only ~12% of samples are "live" (discrete echoes),
	// reaching full density after densityTime. Sparse onsets are what separate
	// a room from a noise wash.
	const densityTime = 0.012 + ( 1 - diffusion ) * 0.09;
	const hpA = onePole( lowCut, sr );
	const logBright = Math.log( Math.max( 60, brightEnd ) / Math.max( 80, brightStart ) );

	for ( let c = 0; c < channels; c ++ ) {

		const rnd = mulberry32( seed + c * 7919 + 17 );
		const d = buffer.getChannelData( c );

		// --- diffuse tail -------------------------------------------------
		const pd = Math.floor( ( preDelay + c * 0.00085 ) * sr );
		const bl = Math.max( 1, Math.floor( build * sr ) );
		const span = Math.max( 1, len - pd );

		let lp = 0;
		let a = onePole( brightStart, sr );

		for ( let i = pd; i < len; i ++ ) {

			const k = i - pd;
			const u = k / span;
			const t = k / sr;

			if ( ( k & 63 ) === 0 ) {

				a = onePole( Math.max( 80, brightStart ) * Math.exp( logBright * u ), sr );

			}

			const dens = Math.min( 1, 0.12 + t / densityTime );
			const x = rnd() < dens ? ( rnd() * 2 - 1 ) : 0;
			lp += a * ( x - lp );

			const ramp = k < bl ? k / bl : 1;
			d[ i ] = lp * Math.pow( 1 - u, decay ) * ramp * tailGain;

		}

		// --- early reflections --------------------------------------------
		const taps = earlyReflections || defaultReflections( seconds, mulberry32( seed + 991 ) );
		const kernel = reflectionKernel( sr, rnd, 1.4 + rnd() * 0.6, erCutoff );

		for ( let i = 0; i < taps.length; i ++ ) {

			const tap = taps[ i ];
			// Per-channel time/level jitter is the stereo decorrelation: the two
			// ears never receive the same reflection at the same instant.
			const jitterT = ( rnd() * 2 - 1 ) * 0.0007 + ( c === 0 ? - 0.00035 : 0.00035 );
			const jitterG = 0.78 + rnd() * 0.44;
			const idx = Math.floor( ( tap.t + jitterT ) * sr );
			if ( idx < 0 || idx >= len ) continue;
			const sign = rnd() < 0.5 ? - 1 : 1;
			addTap( d, idx, tap.g * jitterG * erGain * sign, kernel );

		}

		// --- final highpass so the convolver never pumps sub energy ---------
		let hlp = 0;
		for ( let i = 0; i < len; i ++ ) {

			const x = d[ i ];
			hlp += hpA * ( x - hlp );
			d[ i ] = x - hlp;

		}

		// Guarantee a silent last millisecond so looping convolution is clean.
		const tailPad = Math.min( len, Math.floor( sr * 0.002 ) );
		for ( let i = 0; i < tailPad; i ++ ) {

			d[ len - 1 - i ] *= i / tailPad;

		}

	}

	return normalizeBuffer( buffer, 1 );

}

/**
 * Named spaces. `outdoorYard` is the default game space: short, bright, with a
 * hard slapback off the far wall. `warehouse` is the big interior. `tight` is a
 * near-field box used for viewmodel / mechanical sounds so reloads and hit
 * markers sit in a small believable room rather than in an anechoic void.
 */
export const REVERB_PRESETS = {

	outdoorYard: {
		seconds: 1.12,
		decay: 3.0,
		options: {
			preDelay: 0.011,
			build: 0.006,
			brightStart: 11000,
			brightEnd: 1500,
			lowCut: 95,
			diffusion: 0.55,
			erGain: 0.95,
			tailGain: 0.72,
			erCutoff: 7800,
			earlyReflections: [
				{ t: 0.0128, g: 0.98 }, { t: 0.0214, g: 0.72 }, { t: 0.0296, g: 0.61 },
				{ t: 0.0433, g: 0.46 }, { t: 0.0612, g: 0.35 }, { t: 0.0847, g: 0.26 },
				{ t: 0.1155, g: 0.19 }, { t: 0.1583, g: 0.13 },
			],
			seed: 0x0A11CE,
		},
	},

	warehouse: {
		seconds: 2.62,
		decay: 2.05,
		options: {
			preDelay: 0.019,
			build: 0.016,
			brightStart: 7400,
			brightEnd: 560,
			lowCut: 52,
			diffusion: 0.94,
			erGain: 0.55,
			tailGain: 1.0,
			erCutoff: 4800,
			earlyReflections: [
				{ t: 0.0192, g: 0.85 }, { t: 0.0311, g: 0.68 }, { t: 0.0455, g: 0.58 },
				{ t: 0.0679, g: 0.47 }, { t: 0.0921, g: 0.38 }, { t: 0.1284, g: 0.29 },
				{ t: 0.1731, g: 0.22 }, { t: 0.2296, g: 0.16 }, { t: 0.3012, g: 0.11 },
			],
			seed: 0xBADCAB,
		},
	},

	tight: {
		seconds: 0.25,
		decay: 2.4,
		options: {
			preDelay: 0.0022,
			build: 0.002,
			brightStart: 13500,
			brightEnd: 2400,
			lowCut: 170,
			diffusion: 0.7,
			erGain: 0.7,
			tailGain: 0.85,
			erCutoff: 9500,
			earlyReflections: [
				{ t: 0.0034, g: 0.9 }, { t: 0.0067, g: 0.66 }, { t: 0.0108, g: 0.5 },
				{ t: 0.0169, g: 0.36 }, { t: 0.0247, g: 0.24 },
			],
			seed: 0x7137,
		},
	},

};

/** Build one named preset. */
export function makeReverbPreset( ctx, name ) {

	const p = REVERB_PRESETS[ name ] || REVERB_PRESETS.outdoorYard;
	return makeReverbIR( ctx, p.seconds, p.decay, p.options );

}

/**
 * The gunshot tail.
 *
 * This is deliberately NOT a reverb: it is a dense, bright, fast-decaying
 * slapback cluster with a short diffuse skirt. Convolving a dry muzzle blast
 * with it is what turns "a noise burst" into "a rifle fired between two
 * concrete buildings". Keep the tail short (<1s) so sustained full-auto stacks
 * without turning into porridge.
 */
export function makeGunTailIR( ctx, options = {} ) {

	return makeReverbIR( ctx, options.seconds || 0.88, options.decay || 3.6, {
		preDelay: 0.0035,
		build: 0.0035,
		brightStart: 12500,
		brightEnd: 1250,
		lowCut: 115,
		diffusion: 0.5,
		erGain: 1.25,
		tailGain: 0.6,
		erCutoff: 9000,
		earlyReflections: [
			{ t: 0.0088, g: 1.00 }, { t: 0.0161, g: 0.86 }, { t: 0.0247, g: 0.72 },
			{ t: 0.0369, g: 0.60 }, { t: 0.0524, g: 0.49 }, { t: 0.0731, g: 0.39 },
			{ t: 0.0988, g: 0.31 }, { t: 0.1327, g: 0.24 }, { t: 0.1746, g: 0.18 },
			{ t: 0.2283, g: 0.13 }, { t: 0.2961, g: 0.09 }, { t: 0.3814, g: 0.06 },
		],
		seed: 0xC0FFEE,
		...( options.override || {} ),
	} );

}

/**
 * Pre-generate every convolution buffer the game needs. Called exactly once,
 * from audio.js, immediately after the AudioContext is created.
 */
export function makeImpulseSet( ctx ) {

	return {
		outdoorYard: makeReverbPreset( ctx, 'outdoorYard' ),
		warehouse: makeReverbPreset( ctx, 'warehouse' ),
		tight: makeReverbPreset( ctx, 'tight' ),
		gunTail: makeGunTailIR( ctx ),
	};

}

export default { makeNoiseBuffer, makeReverbIR, makeReverbPreset, makeGunTailIR, makeImpulseSet, REVERB_PRESETS };
