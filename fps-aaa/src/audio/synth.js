/**
 * OVERPRESSURE — procedural voice library.
 *
 * Every export is a *constructor*: you call it once at init with an
 * AudioContext (and a static config), and it hands back a `play(when, opts)`
 * function that spawns one instance, schedules its own teardown and returns a
 * handle `{ out, end }`.
 *
 *   const fire = gunshot( ctx, WEAPON_PROFILES[ 'VK-7' ] );
 *   const h = fire( ctx.currentTime, { dest: bus, tail: tailSend, verb: verbSend } );
 *
 * `out` is always a plain GainNode with a *static* gain value. That invariant
 * lets the mixer in audio.js steal a voice by ramping `out.gain` to zero
 * without fighting any envelope automation.
 *
 * Nothing here allocates an AudioBuffer after construction — all noise is read
 * from shared, looping buffers created once per AudioContext.
 */

import { makeNoiseBuffer } from './impulse.js';

// ---------------------------------------------------------------------------
// Shared per-context resources
// ---------------------------------------------------------------------------

const _resources = new WeakMap();

function shaperCurve( amount, n = 2048 ) {

	const c = new Float32Array( n );
	const k = Math.max( 0.001, amount );
	const norm = Math.tanh( k );
	for ( let i = 0; i < n; i ++ ) {

		const x = ( i * 2 ) / ( n - 1 ) - 1;
		// tanh for the symmetric squash + a touch of even harmonic asymmetry,
		// which is what gives a muzzle blast its "chuff" rather than a clean fuzz
		const y = Math.tanh( k * x ) / norm;
		c[ i ] = y * 0.94 + ( y * y - 0.333 ) * 0.06;

	}

	return c;

}

/** Noise buffers + waveshaper curves, built once per AudioContext. */
export function synthResources( ctx ) {

	let r = _resources.get( ctx );
	if ( r ) return r;

	const curves = new Map();
	r = {
		white: makeNoiseBuffer( ctx, 2.0, 'white', { channels: 2, seed: 0x11A5 } ),
		pink: makeNoiseBuffer( ctx, 2.0, 'pink', { channels: 1, seed: 0x22B6 } ),
		brown: makeNoiseBuffer( ctx, 4.0, 'brown', { channels: 2, seed: 0x33C7, loopFade: 0.35 } ),
		curve( amount ) {

			const key = Math.round( amount * 4 ) / 4;
			let c = curves.get( key );
			if ( ! c ) { c = shaperCurve( key ); curves.set( key, c ); }
			return c;

		},
	};

	_resources.set( ctx, r );
	return r;

}

// ---------------------------------------------------------------------------
// Voice builder
// ---------------------------------------------------------------------------

const DUMMY_PARAM = {
	value: 0,
	setValueAtTime() { return this; },
	linearRampToValueAtTime() { return this; },
	exponentialRampToValueAtTime() { return this; },
	setTargetAtTime() { return this; },
	cancelScheduledValues() { return this; },
};

/**
 * Tracks every node in one voice so a single `onended` can tear the whole
 * thing down. Keeps per-shot bookkeeping out of the individual sound designs.
 */
class Voice {

	constructor( ctx, when ) {

		this.ctx = ctx;
		this.t = Math.max( when, ctx.currentTime );
		this.nodes = [];
		this.srcs = [];
		this.end = this.t;

	}

	keep( n ) { this.nodes.push( n ); return n; }

	gain( value = 0 ) {

		const g = this.ctx.createGain();
		g.gain.value = value;
		return this.keep( g );

	}

	filter( type, freq, Q = 1, gainDb ) {

		const f = this.ctx.createBiquadFilter();
		f.type = type;
		f.frequency.value = Math.max( 10, Math.min( freq, this.ctx.sampleRate * 0.48 ) );
		f.Q.value = Q;
		if ( gainDb !== undefined ) f.gain.value = gainDb;
		return this.keep( f );

	}

	shaper( curve, oversample = '2x' ) {

		const w = this.ctx.createWaveShaper();
		w.curve = curve;
		w.oversample = oversample;
		return this.keep( w );

	}

	pan( value = 0 ) {

		if ( this.ctx.createStereoPanner ) {

			const p = this.ctx.createStereoPanner();
			p.pan.value = value;
			return this.keep( p );

		}

		// Extremely old WebAudio: degrade to a straight pass-through rather
		// than accidentally modulating gain with a pan value.
		const g = this.ctx.createGain();
		g.pan = DUMMY_PARAM;
		return this.keep( g );

	}

	osc( type, freq ) {

		const o = this.ctx.createOscillator();
		o.type = type;
		o.frequency.value = Math.max( 0.01, freq );
		this.srcs.push( o );
		return this.keep( o );

	}

	/** Looping read head into one of the shared noise buffers. */
	noise( buffer, rate = 1 ) {

		const s = this.ctx.createBufferSource();
		s.buffer = buffer;
		s.loop = true;
		s.playbackRate.value = rate;
		this.srcs.push( s );
		return this.keep( s );

	}

	play( src, at, dur, offset ) {

		const d = Math.max( 0.004, dur );
		const start = Math.max( at, this.ctx.currentTime );
		if ( src.buffer ) {

			const off = offset === undefined
				? Math.random() * Math.max( 0.001, src.buffer.duration - 0.05 )
				: offset;
			src.start( start, off );

		} else {

			src.start( start );

		}

		const stopAt = start + d;
		src.stop( stopAt );
		src._stopAt = stopAt;
		if ( stopAt > this.end ) this.end = stopAt;
		return src;

	}

	/** Hook teardown onto whichever source finishes last. */
	seal() {

		let last = null;
		let lt = - Infinity;
		for ( let i = 0; i < this.srcs.length; i ++ ) {

			const s = this.srcs[ i ];
			const st = s._stopAt === undefined ? - Infinity : s._stopAt;
			if ( st > lt ) { lt = st; last = s; }

		}

		const nodes = this.nodes;
		if ( last ) {

			last.onended = () => {

				for ( let i = 0; i < nodes.length; i ++ ) {

					try { nodes[ i ].disconnect(); } catch ( e ) { /* already gone */ }

				}

				nodes.length = 0;

			};

		}

		return this;

	}

}

const EPS = 0.00008;

/** Percussive amplitude envelope. Returns the time it finishes. */
function ampEnv( param, t, peak, attack, decay, hold = 0 ) {

	const p = Math.max( EPS * 2, peak );
	const a = Math.max( 0.0004, attack );
	const d = Math.max( 0.003, decay );
	param.setValueAtTime( EPS, t );
	param.exponentialRampToValueAtTime( p, t + a );
	if ( hold > 0 ) param.setValueAtTime( p, t + a + hold );
	param.exponentialRampToValueAtTime( EPS, t + a + hold + d );
	param.setValueAtTime( 0, t + a + hold + d );
	return t + a + hold + d;

}

/** Exponential glide on any positive-valued AudioParam. */
function glide( param, t, from, to, dur ) {

	param.setValueAtTime( Math.max( 1e-4, from ), t );
	param.exponentialRampToValueAtTime( Math.max( 1e-4, to ), t + Math.max( 0.002, dur ) );

}

function rnd( spread ) { return 1 + ( Math.random() * 2 - 1 ) * spread; }

function clamp( v, a, b ) { return v < a ? a : ( v > b ? b : v ); }

/**
 * Wire a voice's master gain + its two aux sends. Every one-shot in this file
 * starts here so send behaviour is identical everywhere.
 */
function head( v, o, level ) {

	const out = v.gain( Math.max( 0, level ) );
	if ( o.dest ) out.connect( o.dest );

	if ( o.verb && ( o.verbGain || 0 ) > 0.0005 ) {

		const s = v.gain( o.verbGain );
		out.connect( s );
		s.connect( o.verb );

	}

	if ( o.tail && ( o.tailGain || 0 ) > 0.0005 ) {

		const s = v.gain( o.tailGain );
		out.connect( s );
		s.connect( o.tail );

	}

	return out;

}

function finish( v, out ) {

	v.seal();
	return { out, end: v.end };

}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

/**
 * Three distinct weapon voices. The differences are structural, not just
 * pitch: the rifle leans on the low thump + long body sweep, the pistol on a
 * hard high-mid snap, the SMG on a thin fast body with a loud bolt tick.
 */
export const WEAPON_PROFILES = {

	// Battle rifle: deep, punchy, mid-heavy crack with real low-end weight.
	'VK-7': {
		key: 'VK-7',
		level: 1.0,
		variance: 0.04,
		thump: { f0: 94, f1: 43, glide: 0.026, decay: 0.115, gain: 1.0, cut: 400 },
		body: { f0: 1750, f1: 330, Q: 1.35, decay: 0.135, gain: 0.9, noise: 'white' },
		boom: { cut: 245, decay: 0.2, gain: 0.62 },
		crack: { f: 3050, Q: 2.1, decay: 0.034, gain: 0.6 },
		click: { hp: 2500, decay: 0.013, gain: 0.55 },
		mech: { f: 4600, delay: 0.019, decay: 0.031, gain: 0.17 },
		drive: 3.5,
		tone: 11500,
		tail: 0.95,
		verb: 0.55,
	},

	// Sidearm: tight, dry, sharp — almost no sustain, lots of high-mid bark.
	'RG-9': {
		key: 'RG-9',
		level: 0.92,
		variance: 0.045,
		thump: { f0: 124, f1: 57, glide: 0.019, decay: 0.07, gain: 0.68, cut: 520 },
		body: { f0: 2450, f1: 530, Q: 1.9, decay: 0.086, gain: 0.94, noise: 'white' },
		boom: { cut: 335, decay: 0.105, gain: 0.4 },
		crack: { f: 4250, Q: 2.7, decay: 0.026, gain: 0.78 },
		click: { hp: 3400, decay: 0.009, gain: 0.64 },
		mech: { f: 5700, delay: 0.013, decay: 0.026, gain: 0.22 },
		drive: 2.9,
		tone: 13000,
		tail: 0.75,
		verb: 0.5,
	},

	// SMG: thin, fast, clicky — the action is nearly as loud as the muzzle.
	'SR-12': {
		key: 'SR-12',
		level: 0.9,
		variance: 0.05,
		thump: { f0: 108, f1: 52, glide: 0.015, decay: 0.05, gain: 0.5, cut: 560 },
		body: { f0: 2150, f1: 640, Q: 2.3, decay: 0.062, gain: 0.84, noise: 'pink' },
		boom: { cut: 310, decay: 0.072, gain: 0.27 },
		crack: { f: 3750, Q: 3.0, decay: 0.021, gain: 0.64 },
		click: { hp: 3800, decay: 0.0075, gain: 0.7 },
		mech: { f: 6200, delay: 0.0095, decay: 0.023, gain: 0.32 },
		drive: 2.3,
		tone: 14000,
		tail: 0.6,
		verb: 0.44,
	},

	// Generic hostile weapon — deliberately duller so it never masks the player.
	'HOSTILE': {
		key: 'HOSTILE',
		level: 0.92,
		variance: 0.06,
		thump: { f0: 88, f1: 41, glide: 0.03, decay: 0.1, gain: 0.8, cut: 340 },
		body: { f0: 1500, f1: 300, Q: 1.5, decay: 0.12, gain: 0.8, noise: 'white' },
		boom: { cut: 230, decay: 0.18, gain: 0.55 },
		crack: { f: 2750, Q: 2.3, decay: 0.03, gain: 0.5 },
		click: { hp: 2200, decay: 0.012, gain: 0.42 },
		mech: { f: 4200, delay: 0.021, decay: 0.03, gain: 0.12 },
		drive: 3.2,
		tone: 9500,
		tail: 1.0,
		verb: 0.7,
	},

};

const PROFILE_ALIASES = {
	rifle: 'VK-7', ar: 'VK-7', carbine: 'VK-7', vk7: 'VK-7',
	pistol: 'RG-9', sidearm: 'RG-9', handgun: 'RG-9', rg9: 'RG-9',
	smg: 'SR-12', sub: 'SR-12', smg12: 'SR-12', sr12: 'SR-12',
	enemy: 'HOSTILE', hostile: 'HOSTILE',
};

/** Resolve a `weapon:equipped` / `weapon:fire` id (or name) to a profile. */
export function profileFor( id, name ) {

	if ( id && WEAPON_PROFILES[ id ] ) return WEAPON_PROFILES[ id ];
	if ( name && WEAPON_PROFILES[ name ] ) return WEAPON_PROFILES[ name ];

	const probe = String( id || name || '' ).toLowerCase().replace( /[^a-z0-9]/g, '' );
	if ( PROFILE_ALIASES[ probe ] ) return WEAPON_PROFILES[ PROFILE_ALIASES[ probe ] ];
	for ( const k in PROFILE_ALIASES ) {

		if ( probe.indexOf( k ) !== - 1 ) return WEAPON_PROFILES[ PROFILE_ALIASES[ k ] ];

	}

	return WEAPON_PROFILES[ 'VK-7' ];

}

/**
 * The hero sound. Four scheduled layers into one voice:
 *
 *   1. transient  — 1ms filtered noise spike + an 80->45Hz sine "thump"
 *   2. body       — noise through a resonant bandpass sweeping down, saturated
 *   3. boom       — brown noise under a lowpass, the chest weight (clean, no drive)
 *   4. mechanical — delayed high-passed metallic bolt tick
 *
 * Low end bypasses the waveshaper entirely; only the mid/high layers are
 * saturated. Driving the sub is what makes cheap gun sounds turn to mud when
 * you hold the trigger down.
 *
 * @param {BaseAudioContext} ctx
 * @param {object} params  a WEAPON_PROFILES entry (or partial override)
 * @returns {(when:number, opts:object) => ({out:GainNode,end:number}|null)}
 */
export function gunshot( ctx, params = {} ) {

	const P = { ...WEAPON_PROFILES[ 'VK-7' ], ...params };
	const R = synthResources( ctx );
	const curve = R.curve( P.drive );
	const bodyBuf = P.body.noise === 'pink' ? R.pink : R.white;

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;

		const v = new Voice( ctx, when );
		const t = v.t;
		const k = rnd( P.variance );          // per-shot pitch scatter
		const silenced = !! o.silenced;
		const lite = !! o.lite;               // sustained-fire CPU/mix relief

		const level = ( o.gain === undefined ? 1 : o.gain ) * P.level * rnd( 0.055 );
		const tailAmt = ( silenced ? 0.18 : 1 ) * P.tail * ( o.tailGain === undefined ? 1 : o.tailGain ) * ( lite ? 0.55 : 1 );
		const verbAmt = ( silenced ? 0.4 : 1 ) * P.verb * ( o.verbGain === undefined ? 1 : o.verbGain );

		const out = head( v, { ...o, tailGain: tailAmt, verbGain: verbAmt }, level );

		// Saturated mid/high chain. Everything bright goes through here.
		const tone = v.filter( 'lowpass', P.tone * k, 0.6 );
		const sat = v.shaper( curve, lite ? 'none' : '2x' );
		const pre = v.gain( silenced ? 0.5 : 0.85 );
		pre.connect( sat );
		sat.connect( tone );
		tone.connect( out );

		// --- 1a. transient click -------------------------------------------
		{

			const s = v.noise( R.white, rnd( 0.1 ) );
			const hp = v.filter( 'highpass', P.click.hp * k, 0.7 );
			const g = v.gain( 0 );
			s.connect( hp ); hp.connect( g ); g.connect( pre );
			const e = ampEnv( g.gain, t, P.click.gain * ( silenced ? 0.45 : 1 ), 0.0005, P.click.decay );
			v.play( s, t, e - t + 0.004 );

		}

		// --- 1b. low thump: the punch you feel -------------------------------
		{

			const osc = v.osc( 'sine', P.thump.f0 * k );
			glide( osc.frequency, t, P.thump.f0 * k, P.thump.f1 * k, P.thump.glide );
			const lp = v.filter( 'lowpass', P.thump.cut, 0.7 );
			const g = v.gain( 0 );
			osc.connect( g ); g.connect( lp ); lp.connect( out );
			const e = ampEnv( g.gain, t, P.thump.gain * ( silenced ? 0.55 : 1 ), 0.0016, P.thump.decay );
			v.play( osc, t, e - t + 0.01 );

		}

		// --- 2. body: swept resonant noise, the actual "blast" ---------------
		{

			const s = v.noise( bodyBuf, rnd( 0.07 ) );
			const bp = v.filter( 'bandpass', P.body.f0 * k, P.body.Q );
			glide( bp.frequency, t, P.body.f0 * k * ( silenced ? 0.55 : 1 ), P.body.f1 * k, P.body.decay * 0.9 );
			const g = v.gain( 0 );
			s.connect( bp ); bp.connect( g ); g.connect( pre );
			const e = ampEnv( g.gain, t, P.body.gain * ( silenced ? 0.4 : 1 ), 0.0018, P.body.decay );
			v.play( s, t, e - t + 0.006 );

		}

		// --- 2b. air crack ---------------------------------------------------
		if ( ! silenced ) {

			const s = v.noise( R.white, rnd( 0.12 ) );
			const bp = v.filter( 'bandpass', P.crack.f * k, P.crack.Q );
			const g = v.gain( 0 );
			s.connect( bp ); bp.connect( g ); g.connect( pre );
			const e = ampEnv( g.gain, t, P.crack.gain, 0.0006, P.crack.decay );
			v.play( s, t, e - t + 0.004 );

		}

		// --- 3. boom: clean sub weight, never saturated ----------------------
		if ( ! lite ) {

			const s = v.noise( R.brown, rnd( 0.1 ) );
			const lp = v.filter( 'lowpass', P.boom.cut * k, 1.15 );
			const g = v.gain( 0 );
			s.connect( lp ); lp.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, t, P.boom.gain * ( silenced ? 0.35 : 1 ), 0.0045, P.boom.decay );
			v.play( s, t, e - t + 0.006 );

		}

		// --- 4. mechanical: bolt / slide tick --------------------------------
		if ( ! lite ) {

			const mt = t + P.mech.delay * rnd( 0.2 );
			const amt = P.mech.gain * ( silenced ? 2.1 : 1 );

			const s = v.noise( R.white, rnd( 0.15 ) );
			const hp = v.filter( 'highpass', 2400, 0.7 );
			const bp = v.filter( 'bandpass', P.mech.f * k, 7 );
			const g = v.gain( 0 );
			s.connect( hp ); hp.connect( bp ); bp.connect( g ); g.connect( pre );
			const e1 = ampEnv( g.gain, mt, amt, 0.0006, P.mech.decay );
			v.play( s, mt, e1 - mt + 0.004 );

			const osc = v.osc( 'triangle', P.mech.f * 1.37 * k );
			const og = v.gain( 0 );
			osc.connect( og ); og.connect( pre );
			const e2 = ampEnv( og.gain, mt, amt * 0.5, 0.0008, P.mech.decay * 1.5 );
			v.play( osc, mt, e2 - mt + 0.006 );

		}

		// --- suppressor gas puff ---------------------------------------------
		if ( silenced ) {

			const s = v.noise( R.pink, rnd( 0.1 ) );
			const lp = v.filter( 'lowpass', 1500 * k, 0.9 );
			const g = v.gain( 0 );
			s.connect( lp ); lp.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, t, 0.5, 0.004, 0.1 );
			v.play( s, t, e - t + 0.006 );

		}

		return finish( v, out );

	};

}

/** Brass hitting the ground a beat after the shot. Small detail, big payoff. */
export function shellCasing( ctx ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.8 );

		const bounces = 2 + ( Math.random() < 0.5 ? 1 : 0 );
		let bt = t;
		let amp = 1;

		for ( let i = 0; i < bounces; i ++ ) {

			const f = ( 2400 + Math.random() * 2600 ) * ( 1 + i * 0.16 );

			const osc = v.osc( 'triangle', f );
			const bp = v.filter( 'bandpass', f, 12 );
			const g = v.gain( 0 );
			osc.connect( bp ); bp.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, bt, 0.5 * amp, 0.0006, 0.045 + Math.random() * 0.04 );
			v.play( osc, bt, e - bt + 0.005 );

			const s = v.noise( R.white, rnd( 0.2 ) );
			const hp = v.filter( 'highpass', 3800, 0.8 );
			const ng = v.gain( 0 );
			s.connect( hp ); hp.connect( ng ); ng.connect( out );
			const e2 = ampEnv( ng.gain, bt, 0.3 * amp, 0.0005, 0.012 );
			v.play( s, bt, e2 - bt + 0.004 );

			bt += 0.07 + Math.random() * 0.06;
			amp *= 0.55;

		}

		return finish( v, out );

	};

}

/** Dead trigger: firing pin on an empty chamber. */
export function emptyClick( ctx ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.6 );

		const s = v.noise( R.white, rnd( 0.1 ) );
		const hp = v.filter( 'highpass', 2600, 0.7 );
		const bp = v.filter( 'bandpass', 4300 * rnd( 0.06 ), 5 );
		const g = v.gain( 0 );
		s.connect( hp ); hp.connect( bp ); bp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, 0.85, 0.0004, 0.011 );
		v.play( s, t, e - t + 0.004 );

		const osc = v.osc( 'square', 2150 * rnd( 0.05 ) );
		const of = v.filter( 'bandpass', 2150, 9 );
		const og = v.gain( 0 );
		osc.connect( of ); of.connect( og ); og.connect( out );
		const e2 = ampEnv( og.gain, t, 0.28, 0.0005, 0.026 );
		v.play( osc, t, e2 - t + 0.006 );

		// dull mechanical body under the tink
		const s2 = v.noise( R.pink, 1 );
		const lp = v.filter( 'lowpass', 900, 1.1 );
		const g2 = v.gain( 0 );
		s2.connect( lp ); lp.connect( g2 ); g2.connect( out );
		const e3 = ampEnv( g2.gain, t, 0.3, 0.0008, 0.022 );
		v.play( s2, t, e3 - t + 0.004 );

		return finish( v, out );

	};

}

/** Holster / draw: cloth swish plus two metallic settles. */
export function weaponSwitch( ctx ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 1.5 );

		// cloth
		const s = v.noise( R.pink, rnd( 0.08 ) );
		const bp = v.filter( 'bandpass', 900, 1.1 );
		glide( bp.frequency, t, 700, 2400, 0.16 );
		const g = v.gain( 0 );
		s.connect( bp ); bp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, 0.5, 0.03, 0.16 );
		v.play( s, t, e - t + 0.006 );

		// two mechanical settles
		const times = [ t + 0.06, t + 0.235 ];
		const freqs = [ 3100, 2200 ];
		for ( let i = 0; i < 2; i ++ ) {

			const ct = times[ i ];
			const ns = v.noise( R.white, rnd( 0.15 ) );
			const hp = v.filter( 'highpass', 1800, 0.7 );
			const cb = v.filter( 'bandpass', freqs[ i ] * rnd( 0.06 ), 6 );
			const cg = v.gain( 0 );
			ns.connect( hp ); hp.connect( cb ); cb.connect( cg ); cg.connect( out );
			const ce = ampEnv( cg.gain, ct, 0.55 - i * 0.15, 0.0005, 0.018 + i * 0.01 );
			v.play( ns, ct, ce - ct + 0.004 );

		}

		return finish( v, out );

	};

}

function adsMove( ctx, rising ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.62 );

		const s = v.noise( R.pink, rnd( 0.08 ) );
		const bp = v.filter( 'bandpass', 1100, 0.9 );
		glide( bp.frequency, t, rising ? 780 : 1900, rising ? 2000 : 720, 0.11 );
		const g = v.gain( 0 );
		s.connect( bp ); bp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, 0.55, 0.014, 0.1 );
		v.play( s, t, e - t + 0.006 );

		// detent click at the end of the movement
		const ct = t + ( rising ? 0.075 : 0.05 );
		const ns = v.noise( R.white, 1 );
		const hp = v.filter( 'highpass', 3000, 0.8 );
		const cg = v.gain( 0 );
		ns.connect( hp ); hp.connect( cg ); cg.connect( out );
		const ce = ampEnv( cg.gain, ct, 0.3, 0.0004, 0.01 );
		v.play( ns, ct, ce - ct + 0.004 );

		return finish( v, out );

	};

}

export function adsIn( ctx ) { return adsMove( ctx, true ); }
export function adsOut( ctx ) { return adsMove( ctx, false ); }

// ---------------------------------------------------------------------------
// Reload sequence
// ---------------------------------------------------------------------------

/**
 * Reload parts, each independently schedulable so audio.js can lay them out
 * across the real reload duration reported by `weapon:reloadStart`.
 */
export function reloadSounds( ctx ) {

	const R = synthResources( ctx );

	function metalTick( v, out, t, freq, gain, decay, Q = 8 ) {

		const s = v.noise( R.white, rnd( 0.15 ) );
		const hp = v.filter( 'highpass', 2000, 0.7 );
		const bp = v.filter( 'bandpass', freq, Q );
		const g = v.gain( 0 );
		s.connect( hp ); hp.connect( bp ); bp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, gain, 0.0005, decay );
		v.play( s, t, e - t + 0.004 );

		const osc = v.osc( 'triangle', freq * 1.61 );
		const og = v.gain( 0 );
		osc.connect( og ); og.connect( out );
		const e2 = ampEnv( og.gain, t, gain * 0.35, 0.0006, decay * 1.8 );
		v.play( osc, t, e2 - t + 0.006 );

	}

	function thunk( v, out, t, cut, gain, decay, subFreq ) {

		const s = v.noise( R.pink, rnd( 0.1 ) );
		const lp = v.filter( 'lowpass', cut, 1.2 );
		const g = v.gain( 0 );
		s.connect( lp ); lp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, gain, 0.0018, decay );
		v.play( s, t, e - t + 0.006 );

		if ( subFreq ) {

			const osc = v.osc( 'sine', subFreq );
			glide( osc.frequency, t, subFreq, subFreq * 0.62, decay * 0.7 );
			const og = v.gain( 0 );
			osc.connect( og ); og.connect( out );
			const e2 = ampEnv( og.gain, t, gain * 0.7, 0.002, decay * 1.1 );
			v.play( osc, t, e2 - t + 0.008 );

		}

	}

	/** Small sprung catch releasing — sharp, quiet, high. */
	function magRelease( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.9 );
		metalTick( v, out, v.t, 3900 * rnd( 0.05 ), 0.8, 0.012, 9 );
		metalTick( v, out, v.t + 0.014, 2600 * rnd( 0.05 ), 0.35, 0.02, 7 );
		return finish( v, out );

	}

	/** Magazine hits the deck and bounces twice. */
	function magDrop( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.42 );

		thunk( v, out, t, 620 * rnd( 0.08 ), 0.85, 0.09, 105 );
		metalTick( v, out, t + 0.002, 1750 * rnd( 0.07 ), 0.4, 0.05, 5 );

		const b1 = t + 0.088 + Math.random() * 0.02;
		thunk( v, out, b1, 780, 0.34, 0.05, 140 );
		metalTick( v, out, b1, 2100, 0.2, 0.03, 6 );

		const b2 = b1 + 0.062 + Math.random() * 0.02;
		metalTick( v, out, b2, 2500, 0.13, 0.024, 7 );

		return finish( v, out );

	}

	/** Fresh magazine seated: body thunk then the latch click. */
	function magInsert( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.62 );

		// scrape of the mag entering the well
		const s = v.noise( R.pink, rnd( 0.1 ) );
		const bp = v.filter( 'bandpass', 1400, 1.6 );
		glide( bp.frequency, t, 1100, 2200, 0.05 );
		const g = v.gain( 0 );
		s.connect( bp ); bp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, 0.28, 0.008, 0.05 );
		v.play( s, t, e - t + 0.006 );

		thunk( v, out, t + 0.05, 520 * rnd( 0.07 ), 0.95, 0.075, 92 );
		metalTick( v, out, t + 0.058, 3300 * rnd( 0.05 ), 0.6, 0.014, 9 );

		return finish( v, out );

	}

	/**
	 * Charging handle / slide: a ratcheting metallic scrape that rises in
	 * pitch, then a hard snap as it flies forward.
	 */
	function chargingHandle( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.66 );
		const dur = o.scrape === undefined ? 0.085 : o.scrape;

		// part 1: scrape
		const s = v.noise( R.white, rnd( 0.08 ) );
		const bp = v.filter( 'bandpass', 1600, 3.2 );
		glide( bp.frequency, t, 1250, 2900, dur );
		const hp = v.filter( 'highpass', 700, 0.7 );
		const g = v.gain( 0 );
		s.connect( hp ); hp.connect( bp ); bp.connect( g ); g.connect( out );
		g.gain.setValueAtTime( EPS, t );
		g.gain.exponentialRampToValueAtTime( 0.42, t + 0.012 );
		g.gain.exponentialRampToValueAtTime( 0.3, t + dur );
		g.gain.exponentialRampToValueAtTime( EPS, t + dur + 0.02 );
		g.gain.setValueAtTime( 0, t + dur + 0.02 );
		v.play( s, t, dur + 0.026 );

		// ratchet texture riding on the scrape
		const lfo = v.osc( 'square', 78 );
		const lg = v.gain( 0.35 );
		lfo.connect( lg ); lg.connect( g.gain );
		v.play( lfo, t, dur + 0.02 );

		// part 2: snap home
		const st = t + dur + 0.012;
		metalTick( v, out, st, 4200 * rnd( 0.05 ), 1.0, 0.017, 8 );
		metalTick( v, out, st + 0.004, 1900 * rnd( 0.05 ), 0.55, 0.045, 5 );
		thunk( v, out, st, 480, 0.4, 0.04, 130 );

		return finish( v, out );

	}

	/** Bolt release only — the hard chunk that ends a reload. */
	function boltRelease( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.72 );
		metalTick( v, out, t, 4600 * rnd( 0.05 ), 1.0, 0.015, 9 );
		metalTick( v, out, t + 0.005, 2050 * rnd( 0.05 ), 0.6, 0.05, 5 );
		thunk( v, out, t, 450, 0.5, 0.045, 120 );
		return finish( v, out );

	}

	/**
	 * Lay the whole reload out over `duration` seconds. Returns the array of
	 * voice handles so the mixer can register each one.
	 */
	function sequence( when, duration, o = {} ) {

		const d = clamp( duration || 1.9, 0.6, 4.5 );
		const handles = [];
		const push = ( h ) => { if ( h ) handles.push( h ); };

		push( magRelease( when + d * 0.04, o ) );
		push( magDrop( when + d * 0.16, o ) );
		push( magInsert( when + d * 0.5, o ) );
		if ( d > 1.1 ) push( chargingHandle( when + d * 0.78, o ) );
		return handles;

	}

	return { magRelease, magDrop, magInsert, chargingHandle, boltRelease, sequence };

}

// ---------------------------------------------------------------------------
// Impacts
// ---------------------------------------------------------------------------

const IMPACT_SURFACES = {

	concrete: { thudCut: 210, thudDec: 0.075, thudGain: 0.9, bodyF: 950, bodyQ: 1.1, bodyDec: 0.05, bodyGain: 0.55, grit: 5, gritHp: 3200, gritGain: 0.3, sub: 78, drive: 2.4 },
	metal: { thudCut: 420, thudDec: 0.03, thudGain: 0.4, bodyF: 2100, bodyQ: 2.2, bodyDec: 0.035, bodyGain: 0.5, grit: 2, gritHp: 6000, gritGain: 0.35, sub: 0, drive: 3.0 },
	wood: { thudCut: 430, thudDec: 0.065, thudGain: 0.8, bodyF: 780, bodyQ: 2.6, bodyDec: 0.06, bodyGain: 0.6, grit: 4, gritHp: 2600, gritGain: 0.34, sub: 96, drive: 2.2 },
	glass: { thudCut: 900, thudDec: 0.02, thudGain: 0.28, bodyF: 3400, bodyQ: 1.6, bodyDec: 0.03, bodyGain: 0.5, grit: 9, gritHp: 4200, gritGain: 0.55, sub: 0, drive: 1.8 },
	dirt: { thudCut: 480, thudDec: 0.085, thudGain: 0.95, bodyF: 620, bodyQ: 0.9, bodyDec: 0.07, bodyGain: 0.3, grit: 3, gritHp: 2000, gritGain: 0.12, sub: 62, drive: 1.6 },
	sand: { thudCut: 900, thudDec: 0.07, thudGain: 0.6, bodyF: 1400, bodyQ: 0.7, bodyDec: 0.09, bodyGain: 0.34, grit: 4, gritHp: 3000, gritGain: 0.14, sub: 54, drive: 1.4 },
	flesh: { thudCut: 240, thudDec: 0.06, thudGain: 1.0, bodyF: 700, bodyQ: 3.2, bodyDec: 0.035, bodyGain: 0.42, grit: 0, gritHp: 0, gritGain: 0, sub: 68, drive: 2.6 },

};

export const IMPACT_SURFACE_NAMES = Object.keys( IMPACT_SURFACES );

/**
 * Bullet impact, one constructor per surface.
 * `metal` and `glass` get extra structure (inharmonic partials / a shatter
 * cluster) because those are the two surfaces a listener can name blindfolded.
 */
export function impactSound( ctx, surface = 'concrete', params = {} ) {

	const S = { ...( IMPACT_SURFACES[ surface ] || IMPACT_SURFACES.concrete ), ...params };
	const R = synthResources( ctx );
	const curve = R.curve( S.drive );
	const isMetal = surface === 'metal';
	const isGlass = surface === 'glass';
	const isFlesh = surface === 'flesh';

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;

		const v = new Voice( ctx, when );
		const t = v.t;
		const k = rnd( 0.13 );
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.85 * rnd( 0.12 ) );

		const sat = v.shaper( curve, 'none' );
		const tone = v.filter( 'lowpass', 15000, 0.6 );
		sat.connect( tone ); tone.connect( out );

		// --- thud body -------------------------------------------------------
		{

			const s = v.noise( isFlesh ? R.brown : R.pink, rnd( 0.12 ) );
			const lp = v.filter( 'lowpass', S.thudCut * k, 1.2 );
			const g = v.gain( 0 );
			s.connect( lp ); lp.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, t, S.thudGain, 0.0012, S.thudDec );
			v.play( s, t, e - t + 0.006 );

		}

		// --- resonant band ----------------------------------------------------
		{

			const s = v.noise( R.white, rnd( 0.12 ) );
			const bp = v.filter( 'bandpass', S.bodyF * k, S.bodyQ );
			if ( isFlesh ) glide( bp.frequency, t, S.bodyF * k, S.bodyF * k * 0.45, S.bodyDec );
			const g = v.gain( 0 );
			s.connect( bp ); bp.connect( g ); g.connect( sat );
			const e = ampEnv( g.gain, t, S.bodyGain, 0.0008, S.bodyDec );
			v.play( s, t, e - t + 0.005 );

		}

		// --- sub thump ---------------------------------------------------------
		if ( S.sub > 0 ) {

			const osc = v.osc( 'sine', S.sub * k );
			glide( osc.frequency, t, S.sub * k, S.sub * k * 0.6, 0.03 );
			const g = v.gain( 0 );
			osc.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, t, isFlesh ? 0.7 : 0.45, 0.0015, isFlesh ? 0.08 : 0.055 );
			v.play( osc, t, e - t + 0.008 );

		}

		// --- debris / grit -----------------------------------------------------
		if ( S.grit > 0 ) {

			const n = S.grit;
			for ( let i = 0; i < n; i ++ ) {

				const gt = t + 0.004 + Math.random() * ( isGlass ? 0.16 : 0.075 );
				const s = v.noise( R.white, rnd( 0.25 ) );
				const bp = v.filter( 'bandpass', S.gritHp * ( 0.7 + Math.random() * 1.4 ), isGlass ? 9 : 3 );
				const g = v.gain( 0 );
				s.connect( bp ); bp.connect( g ); g.connect( sat );
				const e = ampEnv( g.gain, gt, S.gritGain * ( 0.35 + Math.random() * 0.8 ), 0.0005, ( isGlass ? 0.035 : 0.018 ) * ( 0.5 + Math.random() ) );
				v.play( s, gt, e - gt + 0.004 );

			}

		}

		// --- metal: inharmonic ring + ricochet whine -----------------------------
		if ( isMetal ) {

			const base = ( 900 + Math.random() * 750 ) * k;
			const ratios = [ 1, 2.76, 5.4 ];
			const decays = [ 0.34, 0.2, 0.12 ];
			const gains = [ 0.34, 0.2, 0.12 ];
			for ( let i = 0; i < 3; i ++ ) {

				const osc = v.osc( 'sine', base * ratios[ i ] );
				const g = v.gain( 0 );
				osc.connect( g ); g.connect( out );
				const e = ampEnv( g.gain, t, gains[ i ], 0.0008, decays[ i ] );
				v.play( osc, t, e - t + 0.01 );

			}

			if ( Math.random() < 0.55 ) {

				const wt = t + 0.012;
				const osc = v.osc( 'sawtooth', 3600 * k );
				glide( osc.frequency, wt, 3600 * k, 1150 * k, 0.26 );
				const bp = v.filter( 'bandpass', 2400, 6 );
				glide( bp.frequency, wt, 3400, 1200, 0.26 );
				const vib = v.osc( 'sine', 18 );
				const vg = v.gain( 55 );
				vib.connect( vg ); vg.connect( osc.frequency );
				v.play( vib, wt, 0.3 );
				const g = v.gain( 0 );
				osc.connect( bp ); bp.connect( g ); g.connect( out );
				const e = ampEnv( g.gain, wt, 0.16, 0.006, 0.25 );
				v.play( osc, wt, e - wt + 0.01 );

			}

		}

		// --- glass: bright shatter chirps ------------------------------------
		if ( isGlass ) {

			const n = 5 + ( Math.random() * 4 ) | 0;
			for ( let i = 0; i < n; i ++ ) {

				const gt = t + 0.006 + Math.random() * 0.19;
				const f = 2600 + Math.random() * 6200;
				const osc = v.osc( 'sine', f );
				glide( osc.frequency, gt, f, f * 0.78, 0.05 );
				const g = v.gain( 0 );
				osc.connect( g ); g.connect( out );
				const e = ampEnv( g.gain, gt, 0.1 + Math.random() * 0.13, 0.0008, 0.03 + Math.random() * 0.05 );
				v.play( osc, gt, e - gt + 0.006 );

			}

		}

		return finish( v, out );

	};

}

// ---------------------------------------------------------------------------
// Footsteps / movement
// ---------------------------------------------------------------------------

const STEP_SURFACES = {

	concrete: { heel: 'highpass', heelF: 1150, heelQ: 0.8, heelDec: 0.036, heelGain: 0.62, bandF: 2050, bandQ: 1.1, bandGain: 0.42, low: 122, lowGain: 0.34, lowDec: 0.05, toeDelay: 0.046, grain: 0, ring: null, rustle: 0.10 },
	metal: { heel: 'highpass', heelF: 1500, heelQ: 0.8, heelDec: 0.03, heelGain: 0.58, bandF: 2650, bandQ: 2.0, bandGain: 0.46, low: 142, lowGain: 0.3, lowDec: 0.045, toeDelay: 0.042, grain: 0, ring: [ 1180, 2360, 3170 ], rustle: 0.11 },
	wood: { heel: 'bandpass', heelF: 820, heelQ: 1.3, heelDec: 0.045, heelGain: 0.66, bandF: 1300, bandQ: 2.4, bandGain: 0.36, low: 108, lowGain: 0.4, lowDec: 0.07, toeDelay: 0.05, grain: 0, ring: [ 236 ], rustle: 0.10 },
	dirt: { heel: 'lowpass', heelF: 1250, heelQ: 0.8, heelDec: 0.05, heelGain: 0.6, bandF: 700, bandQ: 0.9, bandGain: 0.3, low: 96, lowGain: 0.3, lowDec: 0.06, toeDelay: 0.055, grain: 4, ring: null, rustle: 0.13 },
	sand: { heel: 'lowpass', heelF: 2300, heelQ: 0.7, heelDec: 0.075, heelGain: 0.5, bandF: 1500, bandQ: 0.6, bandGain: 0.3, low: 82, lowGain: 0.2, lowDec: 0.05, toeDelay: 0.06, grain: 6, ring: null, rustle: 0.14 },
	glass: { heel: 'highpass', heelF: 2400, heelQ: 0.8, heelDec: 0.03, heelGain: 0.5, bandF: 3600, bandQ: 1.6, bandGain: 0.42, low: 112, lowGain: 0.26, lowDec: 0.04, toeDelay: 0.044, grain: 7, ring: null, rustle: 0.11 },

};

export const STEP_SURFACE_NAMES = Object.keys( STEP_SURFACES );

/**
 * Layered footstep: heel transient, toe transient, low body weight, a gear /
 * cloth rustle and (per surface) loose grain or a metallic ring.
 *
 * play() options: `sprint` 0..1 (faster roll, brighter, more gear noise) and
 * `heavy` 0..1 (used by the landing voice for extra weight and a longer heel).
 */
export function footstep( ctx, surface = 'concrete', params = {} ) {

	const S = { ...( STEP_SURFACES[ surface ] || STEP_SURFACES.concrete ), ...params };
	const R = synthResources( ctx );

	function tap( v, out, t, gain, rate, filterType, freq, Q, dec ) {

		const s = v.noise( R.white, rate );
		const f = v.filter( filterType, freq, Q );
		const g = v.gain( 0 );
		s.connect( f ); f.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, gain, filterType === 'lowpass' ? 0.0035 : 0.001, dec );
		v.play( s, t, e - t + 0.005 );

	}

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;

		const v = new Voice( ctx, when );
		const t = v.t;
		const sprint = clamp( o.sprint === undefined ? 0 : o.sprint, 0, 1 );
		const heavy = o.heavy === undefined ? 0 : clamp( o.heavy, 0, 1 );
		const k = rnd( 0.09 ) * ( 1 + sprint * 0.1 - heavy * 0.14 );
		const power = ( 0.72 + sprint * 0.4 + heavy * 0.5 );
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.55 * power * rnd( 0.1 ) );

		// heel
		tap( v, out, t, S.heelGain, rnd( 0.12 ), S.heel, S.heelF * k, S.heelQ, S.heelDec * ( 1 + heavy * 0.5 ) );
		// mid band that gives the surface its identity
		tap( v, out, t + 0.002, S.bandGain, rnd( 0.12 ), 'bandpass', S.bandF * k, S.bandQ, S.heelDec * 1.2 );

		// toe, quieter and a touch later; sprinting rolls the foot faster
		const toeT = t + S.toeDelay * ( 1 - sprint * 0.35 ) * rnd( 0.15 );
		tap( v, out, toeT, S.heelGain * ( 0.5 + heavy * 0.3 ), rnd( 0.12 ), S.heel, S.heelF * k * 1.15, S.heelQ, S.heelDec * 0.8 );

		// low body weight
		{

			const osc = v.osc( 'sine', S.low * k );
			glide( osc.frequency, t, S.low * k, S.low * k * 0.66, S.lowDec );
			const lp = v.filter( 'lowpass', 320, 0.8 );
			const g = v.gain( 0 );
			osc.connect( g ); g.connect( lp ); lp.connect( out );
			const e = ampEnv( g.gain, t, S.lowGain * ( 1 + heavy * 1.1 ), 0.0022, S.lowDec * ( 1 + heavy * 0.8 ) );
			v.play( osc, t, e - t + 0.008 );

		}

		// loose grain (gravel, sand, glass shards)
		if ( S.grain > 0 ) {

			const n = ( S.grain * ( 0.6 + sprint * 0.6 + heavy * 0.5 ) ) | 0;
			for ( let i = 0; i < n; i ++ ) {

				const gt = t + Math.random() * 0.07;
				const s = v.noise( R.white, rnd( 0.3 ) );
				const bp = v.filter( 'bandpass', 2400 * ( 0.6 + Math.random() * 1.6 ), 4 );
				const g = v.gain( 0 );
				s.connect( bp ); bp.connect( g ); g.connect( out );
				const e = ampEnv( g.gain, gt, 0.1 * ( 0.4 + Math.random() ), 0.0005, 0.014 * ( 0.5 + Math.random() ) );
				v.play( s, gt, e - gt + 0.004 );

			}

		}

		// grating / plank resonance
		if ( S.ring ) {

			for ( let i = 0; i < S.ring.length; i ++ ) {

				const osc = v.osc( 'sine', S.ring[ i ] * k * rnd( 0.03 ) );
				const g = v.gain( 0 );
				osc.connect( g ); g.connect( out );
				const e = ampEnv( g.gain, t, 0.075 / ( i + 1 ) * ( 1 + heavy ), 0.0012, 0.16 / ( i + 1 ) );
				v.play( osc, t, e - t + 0.01 );

			}

		}

		// gear / cloth
		{

			const rt = t + 0.012 + Math.random() * 0.02;
			const s = v.noise( R.pink, rnd( 0.2 ) );
			const bp = v.filter( 'bandpass', 3200 * rnd( 0.25 ), 1.1 );
			const hp = v.filter( 'highpass', 1600, 0.7 );
			const g = v.gain( 0 );
			s.connect( hp ); hp.connect( bp ); bp.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, rt, S.rustle * ( 0.7 + sprint * 0.9 + heavy * 0.7 ), 0.006, 0.06 + sprint * 0.03 );
			v.play( s, rt, e - rt + 0.006 );

		}

		return finish( v, out );

	};

}

/** Landing after a fall — a heavier footstep with knee-bend gear noise. */
export function landing( ctx, surface = 'concrete' ) {

	const step = footstep( ctx, surface );
	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const impact = clamp( o.impact === undefined ? 0.5 : o.impact, 0, 1 );
		const h = step( when, { ...o, heavy: 0.55 + impact * 0.45, gain: ( o.gain === undefined ? 1 : o.gain ) * ( 0.5 + impact * 0.32 ) } );
		if ( ! h ) return null;

		// extra kit rattle on top, scaled by fall force
		const v = new Voice( ctx, when + 0.02 );
		const t = v.t;
		const out = v.gain( 0.35 * ( 0.4 + impact ) );
		out.connect( o.dest );
		const s = v.noise( R.pink, rnd( 0.2 ) );
		const bp = v.filter( 'bandpass', 2600, 1.0 );
		const g = v.gain( 0 );
		s.connect( bp ); bp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, 0.5, 0.008, 0.13 );
		v.play( s, t, e - t + 0.006 );
		v.seal();

		return { out: h.out, end: Math.max( h.end, v.end ) };

	};

}

/** Push-off: gear compression, no vocalisation. */
export function jumpEffort( ctx ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.7 );

		const s = v.noise( R.pink, rnd( 0.15 ) );
		const bp = v.filter( 'bandpass', 1900, 0.9 );
		glide( bp.frequency, t, 1400, 3000, 0.09 );
		const g = v.gain( 0 );
		s.connect( bp ); bp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, 0.6, 0.01, 0.09 );
		v.play( s, t, e - t + 0.006 );

		const osc = v.osc( 'sine', 120 );
		glide( osc.frequency, t, 120, 78, 0.05 );
		const og = v.gain( 0 );
		osc.connect( og ); og.connect( out );
		const e2 = ampEnv( og.gain, t, 0.22, 0.003, 0.05 );
		v.play( osc, t, e2 - t + 0.008 );

		return finish( v, out );

	};

}

/** Enemy body hitting the ground. */
export function bodyFall( ctx ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.8 );

		const s = v.noise( R.brown, rnd( 0.12 ) );
		const lp = v.filter( 'lowpass', 260 * rnd( 0.15 ), 1.1 );
		const g = v.gain( 0 );
		s.connect( lp ); lp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, 0.95, 0.004, 0.16 );
		v.play( s, t, e - t + 0.008 );

		const osc = v.osc( 'sine', 76 * rnd( 0.12 ) );
		glide( osc.frequency, t, 76, 44, 0.07 );
		const og = v.gain( 0 );
		osc.connect( og ); og.connect( out );
		const e2 = ampEnv( og.gain, t, 0.55, 0.003, 0.13 );
		v.play( osc, t, e2 - t + 0.01 );

		// kit / weapon clatter
		for ( let i = 0; i < 3; i ++ ) {

			const ct = t + 0.03 + Math.random() * 0.24;
			const ns = v.noise( R.white, rnd( 0.2 ) );
			const bp = v.filter( 'bandpass', 1800 * ( 0.6 + Math.random() * 1.6 ), 6 );
			const cg = v.gain( 0 );
			ns.connect( bp ); bp.connect( cg ); cg.connect( out );
			const ce = ampEnv( cg.gain, ct, 0.16 * ( 0.5 + Math.random() ), 0.0008, 0.03 + Math.random() * 0.04 );
			v.play( ns, ct, ce - ct + 0.005 );

		}

		return finish( v, out );

	};

}

// ---------------------------------------------------------------------------
// Feedback: hit markers, damage, whizby
// ---------------------------------------------------------------------------

/**
 * Hit confirmation. Crisp, short, with a tiny sub under it so it lands with
 * weight instead of reading as a menu beep, and a small send to the tight
 * convolver so it sits in a space.
 *
 * @param {boolean} headshot  brighter, wider two-tone variant
 */
export function hitmarker( ctx, headshot = false ) {

	const R = synthResources( ctx );
	const f0 = headshot ? 1580 : 1245;
	const f1 = headshot ? 2370 : 1868;
	const dec = headshot ? 0.05 : 0.038;

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * ( headshot ? 0.62 : 0.5 ) );

		// front tick — the "crisp"
		{

			const s = v.noise( R.white, 1 );
			const hp = v.filter( 'highpass', headshot ? 6000 : 4200, 0.8 );
			const g = v.gain( 0 );
			s.connect( hp ); hp.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, t, headshot ? 0.5 : 0.38, 0.0004, 0.006 );
			v.play( s, t, e - t + 0.004 );

		}

		// two-tone
		const tones = [ { f: f0, at: 0, g: 0.6, d: dec }, { f: f1, at: 0.013, g: headshot ? 0.5 : 0.32, d: dec * 0.85 } ];
		if ( headshot ) tones.push( { f: 3160, at: 0.024, g: 0.22, d: 0.03 } );

		for ( let i = 0; i < tones.length; i ++ ) {

			const T = tones[ i ];
			const tt = t + T.at;
			const osc = v.osc( i === 2 ? 'triangle' : 'sine', T.f );
			const bp = v.filter( 'bandpass', T.f, 2.2 );
			const g = v.gain( 0 );
			osc.connect( bp ); bp.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, tt, T.g, 0.0008, T.d );
			v.play( osc, tt, e - tt + 0.006 );

		}

		// weight
		{

			const osc = v.osc( 'sine', 190 );
			glide( osc.frequency, t, 190, 120, 0.045 );
			const g = v.gain( 0 );
			osc.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, t, 0.2, 0.001, 0.05 );
			v.play( osc, t, e - t + 0.008 );

		}

		return finish( v, out );

	};

}

/** Kill confirmation: a descending three-note chirp that resolves downward. */
export function killConfirm( ctx ) {

	const R = synthResources( ctx );
	const notes = [ 1480, 1108, 740 ];
	const decs = [ 0.07, 0.085, 0.16 ];

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.55 );

		for ( let i = 0; i < notes.length; i ++ ) {

			const nt = t + i * 0.045;
			const f = notes[ i ];

			const osc = v.osc( 'triangle', f );
			glide( osc.frequency, nt, f, f * 0.985, decs[ i ] );
			const bp = v.filter( 'bandpass', f * 1.1, 1.8 );
			const g = v.gain( 0 );
			osc.connect( bp ); bp.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, nt, 0.5 - i * 0.06, 0.0012, decs[ i ] );
			v.play( osc, nt, e - nt + 0.008 );

			const sub = v.osc( 'sine', f * 0.5 );
			const sg = v.gain( 0 );
			sub.connect( sg ); sg.connect( out );
			const e2 = ampEnv( sg.gain, nt, 0.22 - i * 0.03, 0.0014, decs[ i ] * 1.1 );
			v.play( sub, nt, e2 - nt + 0.008 );

		}

		// closing thump so the chirp lands rather than just stopping
		{

			const ct = t + 0.09;
			const osc = v.osc( 'sine', 132 );
			glide( osc.frequency, ct, 132, 62, 0.11 );
			const g = v.gain( 0 );
			osc.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, ct, 0.42, 0.002, 0.14 );
			v.play( osc, ct, e - ct + 0.01 );

		}

		// airy shimmer
		{

			const s = v.noise( R.white, 1 );
			const bp = v.filter( 'bandpass', 6200, 1.4 );
			glide( bp.frequency, t, 7200, 3200, 0.2 );
			const g = v.gain( 0 );
			s.connect( bp ); bp.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, t, 0.12, 0.004, 0.2 );
			v.play( s, t, e - t + 0.006 );

		}

		return finish( v, out );

	};

}

/** Taking damage: a hard body hit plus a short adrenaline whump. */
export function damageSting( ctx ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const amount = clamp( o.amount === undefined ? 0.4 : o.amount, 0, 1 );
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * ( 0.28 + amount * 0.32 ) );

		// impact
		const s = v.noise( R.brown, rnd( 0.12 ) );
		const lp = v.filter( 'lowpass', 380 * rnd( 0.12 ), 1.4 );
		const g = v.gain( 0 );
		s.connect( lp ); lp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, 0.95, 0.0015, 0.1 + amount * 0.08 );
		v.play( s, t, e - t + 0.008 );

		// sub whump
		const osc = v.osc( 'sine', 118 );
		glide( osc.frequency, t, 118, 41, 0.12 );
		const og = v.gain( 0 );
		osc.connect( og ); og.connect( out );
		const e2 = ampEnv( og.gain, t, 0.6 + amount * 0.3, 0.002, 0.17 );
		v.play( osc, t, e2 - t + 0.01 );

		// abrasive mid so it reads as "you were hit", not "something fell over"
		const s2 = v.noise( R.white, 1 );
		const bp = v.filter( 'bandpass', 1150 * rnd( 0.15 ), 2.2 );
		glide( bp.frequency, t, 1400, 520, 0.09 );
		const g2 = v.gain( 0 );
		s2.connect( bp ); bp.connect( g2 ); g2.connect( out );
		const e3 = ampEnv( g2.gain, t, 0.34, 0.001, 0.075 );
		v.play( s2, t, e3 - t + 0.006 );

		return finish( v, out );

	};

}

/** Health regeneration crossing back into safety — soft, upward, brief. */
export function regenSwell( ctx ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.85 );

		const s = v.noise( R.pink, 1 );
		const bp = v.filter( 'bandpass', 900, 1.2 );
		glide( bp.frequency, t, 500, 3000, 0.7 );
		const g = v.gain( 0 );
		s.connect( bp ); bp.connect( g ); g.connect( out );
		g.gain.setValueAtTime( EPS, t );
		g.gain.exponentialRampToValueAtTime( 0.3, t + 0.35 );
		g.gain.exponentialRampToValueAtTime( EPS, t + 0.85 );
		g.gain.setValueAtTime( 0, t + 0.85 );
		v.play( s, t, 0.86 );

		const freqs = [ 523.25, 784, 1046.5 ];
		for ( let i = 0; i < 3; i ++ ) {

			const nt = t + 0.1 + i * 0.09;
			const osc = v.osc( 'sine', freqs[ i ] );
			const g2 = v.gain( 0 );
			osc.connect( g2 ); g2.connect( out );
			const e = ampEnv( g2.gain, nt, 0.16 - i * 0.03, 0.02, 0.3 );
			v.play( osc, nt, e - nt + 0.01 );

		}

		return finish( v, out );

	};

}

/**
 * Enemy round passing close. Doppler is faked with a downward bandpass sweep
 * through the point of closest approach, plus a supersonic snap at the apex
 * and a left/right pan sweep. Cheap and viscerally effective.
 */
export function bulletWhizby( ctx, params = {} ) {

	const R = synthResources( ctx );
	const P = { fStart: 3400, fEnd: 950, Q: 5.5, dur: 0.19, gain: 0.55, ...params };

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;

		const v = new Voice( ctx, when );
		const t = v.t;
		const close = clamp( o.close === undefined ? 0.5 : o.close, 0, 1 );
		const dur = P.dur * ( 0.7 + Math.random() * 0.6 );
		const k = rnd( 0.15 );
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * P.gain * ( 0.45 + close * 0.75 ) );

		const side = o.side === undefined ? ( Math.random() < 0.5 ? - 1 : 1 ) : o.side;
		const panner = v.pan( - side * 0.85 );
		panner.connect( out );
		panner.pan.setValueAtTime( - side * 0.85, t );
		panner.pan.linearRampToValueAtTime( side * 0.85, t + dur );

		// swept noise: the "vvvip"
		const s = v.noise( R.white, rnd( 0.1 ) );
		const bp = v.filter( 'bandpass', P.fStart * k, P.Q );
		glide( bp.frequency, t, P.fStart * k, P.fEnd * k, dur );
		const hp = v.filter( 'highpass', 400, 0.7 );
		const g = v.gain( 0 );
		s.connect( hp ); hp.connect( bp ); bp.connect( g ); g.connect( panner );
		g.gain.setValueAtTime( EPS, t );
		g.gain.exponentialRampToValueAtTime( 1, t + dur * 0.35 );
		g.gain.exponentialRampToValueAtTime( EPS, t + dur * 1.15 );
		g.gain.setValueAtTime( 0, t + dur * 1.15 );
		v.play( s, t, dur * 1.16 );

		// supersonic crack at closest approach
		if ( close > 0.35 ) {

			const ct = t + dur * 0.35;
			const ns = v.noise( R.white, 1 );
			const chp = v.filter( 'highpass', 2400, 0.8 );
			const cg = v.gain( 0 );
			ns.connect( chp ); chp.connect( cg ); cg.connect( panner );
			const e = ampEnv( cg.gain, ct, 0.55 * close, 0.0004, 0.012 );
			v.play( ns, ct, e - ct + 0.004 );

		}

		return finish( v, out );

	};

}

// ---------------------------------------------------------------------------
// Ambience one-shots
// ---------------------------------------------------------------------------

/** Far-off metal panel / container being struck. Inharmonic, long, gritty. */
export function metalClang( ctx ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.4 );

		const base = 130 + Math.random() * 260;
		const ratios = [ 1, 1.73, 2.61, 3.94, 5.32, 7.11 ];
		for ( let i = 0; i < ratios.length; i ++ ) {

			const f = base * ratios[ i ] * rnd( 0.02 );
			const osc = v.osc( 'sine', f );
			const g = v.gain( 0 );
			osc.connect( g ); g.connect( out );
			const dec = ( 1.5 / ( 1 + i * 0.75 ) ) * ( 0.8 + Math.random() * 0.5 );
			const e = ampEnv( g.gain, t, 0.42 / ( 1 + i * 0.9 ), 0.0015, dec );
			v.play( osc, t, e - t + 0.02 );

		}

		const s = v.noise( R.white, 1 );
		const bp = v.filter( 'bandpass', base * 4.5, 1.6 );
		const g = v.gain( 0 );
		s.connect( bp ); bp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, 0.24, 0.0008, 0.09 );
		v.play( s, t, e - t + 0.006 );

		return finish( v, out );

	};

}

/** Gull-like cry: two pitch-contoured formant tones with a breathy edge. */
export function gullCry( ctx ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.95 );

		const n = 2 + ( Math.random() * 2 ) | 0;
		let ct = t;
		for ( let i = 0; i < n; i ++ ) {

			const base = 780 + Math.random() * 420;
			const dur = 0.16 + Math.random() * 0.12;

			const osc = v.osc( 'sawtooth', base );
			osc.frequency.setValueAtTime( base * 0.72, ct );
			osc.frequency.exponentialRampToValueAtTime( base * 1.25, ct + dur * 0.3 );
			osc.frequency.exponentialRampToValueAtTime( base * 0.6, ct + dur );

			const form = v.filter( 'bandpass', base * 1.6, 4.5 );
			const form2 = v.filter( 'bandpass', base * 3.1, 6 );
			const mix = v.gain( 0 );
			osc.connect( form ); form.connect( mix );
			osc.connect( form2 ); form2.connect( mix );
			mix.connect( out );
			const e = ampEnv( mix.gain, ct, 0.5 - i * 0.08, 0.02, dur );
			v.play( osc, ct, e - ct + 0.01 );

			const br = v.noise( R.white, 1 );
			const bhp = v.filter( 'highpass', 3000, 0.8 );
			const bg = v.gain( 0 );
			br.connect( bhp ); bhp.connect( bg ); bg.connect( out );
			const e2 = ampEnv( bg.gain, ct, 0.06, 0.02, dur * 0.6 );
			v.play( br, ct, e2 - ct + 0.006 );

			ct += dur + 0.08 + Math.random() * 0.13;

		}

		return finish( v, out );

	};

}

/** Structural creak: slow filtered noise with a wandering resonance. */
export function creak( ctx ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const dur = 0.55 + Math.random() * 1.1;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 2.6 );

		const s = v.noise( R.pink, rnd( 0.2 ) );
		const bp = v.filter( 'bandpass', 420, 7 );
		const f0 = 230 + Math.random() * 340;
		glide( bp.frequency, t, f0, f0 * ( 1.5 + Math.random() ), dur );
		const g = v.gain( 0 );
		s.connect( bp ); bp.connect( g ); g.connect( out );

		// stick-slip amplitude wobble
		const lfo = v.osc( 'sawtooth', 9 + Math.random() * 14 );
		const lg = v.gain( 0.45 );
		lfo.connect( lg ); lg.connect( g.gain );
		v.play( lfo, t, dur + 0.05 );

		const e = ampEnv( g.gain, t, 0.55, 0.08, dur );
		v.play( s, t, e - t + 0.01 );

		return finish( v, out );

	};

}

/** Distant gunfire / industrial thud somewhere outside the play space. */
export function distantBoom( ctx ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.8 );

		const n = 1 + ( Math.random() * 3 ) | 0;
		for ( let i = 0; i < n; i ++ ) {

			const bt = t + i * ( 0.09 + Math.random() * 0.09 );
			const s = v.noise( R.brown, rnd( 0.2 ) );
			const lp = v.filter( 'lowpass', 420 * rnd( 0.3 ), 1.0 );
			const g = v.gain( 0 );
			s.connect( lp ); lp.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, bt, 0.6, 0.006, 0.26 + Math.random() * 0.2 );
			v.play( s, bt, e - bt + 0.01 );

			const osc = v.osc( 'sine', 62 * rnd( 0.2 ) );
			glide( osc.frequency, bt, 62, 38, 0.14 );
			const og = v.gain( 0 );
			osc.connect( og ); og.connect( out );
			const e2 = ampEnv( og.gain, bt, 0.3, 0.006, 0.2 );
			v.play( osc, bt, e2 - bt + 0.01 );

		}

		return finish( v, out );

	};

}

/** Sub-bass rumble used for heavy camera shake / structural events. */
export function subRumble( ctx ) {

	const R = synthResources( ctx );

	return function play( when, o = {} ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const amount = clamp( o.amount === undefined ? 0.5 : o.amount, 0, 1 );
		const dur = 0.35 + amount * 0.5;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.5 * amount );

		const s = v.noise( R.brown, 0.6 );
		const lp = v.filter( 'lowpass', 90, 1.4 );
		const g = v.gain( 0 );
		s.connect( lp ); lp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, 0.9, 0.02, dur );
		v.play( s, t, e - t + 0.02 );

		return finish( v, out );

	};

}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/**
 * The UI palette. Deliberately warm and short — these play a lot, so anything
 * with a long tail would smear the mix.
 */
export function uiSounds( ctx ) {

	const R = synthResources( ctx );

	function blip( when, o, f0, f1, dur, gain, type = 'sine', bright = 0 ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * gain );

		const osc = v.osc( type, f0 );
		if ( f1 && f1 !== f0 ) glide( osc.frequency, t, f0, f1, dur );
		const bp = v.filter( 'bandpass', ( f0 + ( f1 || f0 ) ) * 0.5, 1.4 );
		const g = v.gain( 0 );
		osc.connect( bp ); bp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, 0.7, 0.0015, dur );
		v.play( osc, t, e - t + 0.008 );

		if ( bright > 0 ) {

			const s = v.noise( R.white, 1 );
			const hp = v.filter( 'highpass', 5000, 0.8 );
			const ng = v.gain( 0 );
			s.connect( hp ); hp.connect( ng ); ng.connect( out );
			const e2 = ampEnv( ng.gain, t, bright, 0.0004, 0.006 );
			v.play( s, t, e2 - t + 0.004 );

		}

		return finish( v, out );

	}

	function sweep( when, o, f0, f1, dur, gain ) {

		if ( ! o.dest ) return null;
		const v = new Voice( ctx, when );
		const t = v.t;
		const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * gain );

		const s = v.noise( R.pink, 1 );
		const bp = v.filter( 'bandpass', f0, 1.5 );
		glide( bp.frequency, t, f0, f1, dur );
		const g = v.gain( 0 );
		s.connect( bp ); bp.connect( g ); g.connect( out );
		const e = ampEnv( g.gain, t, 0.55, dur * 0.25, dur * 0.8 );
		v.play( s, t, e - t + 0.008 );

		const osc = v.osc( 'sine', f0 * 0.35 );
		glide( osc.frequency, t, f0 * 0.35, f1 * 0.35, dur );
		const og = v.gain( 0 );
		osc.connect( og ); og.connect( out );
		const e2 = ampEnv( og.gain, t, 0.3, dur * 0.2, dur * 0.7 );
		v.play( osc, t, e2 - t + 0.008 );

		return finish( v, out );

	}

	return {

		hover: ( when, o = {} ) => blip( when, o, 1180, 1180, 0.028, 0.14, 'sine', 0.05 ),
		click: ( when, o = {} ) => blip( when, o, 1520, 1140, 0.045, 0.28, 'triangle', 0.18 ),
		back: ( when, o = {} ) => blip( when, o, 880, 520, 0.07, 0.24, 'triangle', 0.06 ),
		toast: ( when, o = {} ) => blip( when, o, 1760, 2200, 0.05, 0.16, 'sine', 0.08 ),
		score: ( when, o = {} ) => blip( when, o, 2340, 2640, 0.03, 0.1, 'sine', 0.05 ),

		open: ( when, o = {} ) => sweep( when, o, 320, 1500, 0.22, 0.3 ),
		close: ( when, o = {} ) => sweep( when, o, 1500, 300, 0.2, 0.3 ),

		/** Wave incoming: low brass-ish swell with a front impact. */
		waveStart( when, o = {} ) {

			if ( ! o.dest ) return null;
			const v = new Voice( ctx, when );
			const t = v.t;
			const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.5 );

			// front impact
			const s = v.noise( R.brown, 1 );
			const lp = v.filter( 'lowpass', 300, 1.2 );
			const g = v.gain( 0 );
			s.connect( lp ); lp.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, t, 0.85, 0.003, 0.5 );
			v.play( s, t, e - t + 0.01 );

			const sub = v.osc( 'sine', 74 );
			glide( sub.frequency, t, 74, 37, 0.4 );
			const sg = v.gain( 0 );
			sub.connect( sg ); sg.connect( out );
			const e2 = ampEnv( sg.gain, t, 0.7, 0.004, 0.7 );
			v.play( sub, t, e2 - t + 0.01 );

			// stacked saws through a filter that opens then closes
			const stack = v.gain( 0 );
			const vcf = v.filter( 'lowpass', 300, 4 );
			const sat = v.shaper( R.curve( 2 ), 'none' );
			stack.connect( vcf ); vcf.connect( sat ); sat.connect( out );
			vcf.frequency.setValueAtTime( 260, t );
			vcf.frequency.exponentialRampToValueAtTime( 2600, t + 0.42 );
			vcf.frequency.exponentialRampToValueAtTime( 420, t + 1.25 );

			const partials = [ 82.4, 123.5, 164.8, 246.9 ];
			for ( let i = 0; i < partials.length; i ++ ) {

				const a = v.osc( 'sawtooth', partials[ i ] );
				const b = v.osc( 'sawtooth', partials[ i ] * 1.006 );
				const pg = v.gain( 0.26 / ( 1 + i * 0.4 ) );
				a.connect( pg ); b.connect( pg ); pg.connect( stack );
				v.play( a, t, 1.32 );
				v.play( b, t, 1.32 );

			}

			const e3 = ampEnv( stack.gain, t, 0.75, 0.05, 1.05, 0.16 );
			stack.gain.setValueAtTime( 0, Math.max( e3, t + 1.3 ) );
			if ( v.end < t + 1.34 ) v.end = t + 1.34;

			return finish( v, out );

		},

		/** Wave cleared: a rising, resolved figure. */
		waveClear( when, o = {} ) {

			if ( ! o.dest ) return null;
			const v = new Voice( ctx, when );
			const t = v.t;
			const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.42 );

			const notes = [ 440, 554.37, 659.25, 880 ];
			for ( let i = 0; i < notes.length; i ++ ) {

				const nt = t + i * 0.085;
				const osc = v.osc( 'triangle', notes[ i ] );
				const osc2 = v.osc( 'sine', notes[ i ] * 2 );
				const bp = v.filter( 'bandpass', notes[ i ] * 1.3, 1.3 );
				const g = v.gain( 0 );
				const g2 = v.gain( 0.25 );
				osc.connect( bp ); osc2.connect( g2 ); g2.connect( bp );
				bp.connect( g ); g.connect( out );
				const e = ampEnv( g.gain, nt, 0.45, 0.008, 0.34 + i * 0.12 );
				v.play( osc, nt, e - nt + 0.01 );
				v.play( osc2, nt, e - nt + 0.01 );

			}

			const s = v.noise( R.white, 1 );
			const bp = v.filter( 'bandpass', 4000, 1.2 );
			glide( bp.frequency, t, 2600, 8000, 0.6 );
			const g = v.gain( 0 );
			s.connect( bp ); bp.connect( g ); g.connect( out );
			const e = ampEnv( g.gain, t, 0.1, 0.12, 0.5 );
			v.play( s, t, e - t + 0.01 );

			return finish( v, out );

		},

		/** Two-thump heartbeat, felt more than heard. */
		heartbeat( when, o = {} ) {

			if ( ! o.dest ) return null;
			const v = new Voice( ctx, when );
			const t = v.t;
			const intensity = clamp( o.intensity === undefined ? 0.6 : o.intensity, 0, 1 );
			const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * ( 0.2 + intensity * 0.36 ) );

			const beats = [ { at: 0, f: 56, g: 1.0, d: 0.13 }, { at: 0.155, f: 46, g: 0.72, d: 0.16 } ];
			for ( let i = 0; i < beats.length; i ++ ) {

				const B = beats[ i ];
				const bt = t + B.at;
				const osc = v.osc( 'sine', B.f );
				glide( osc.frequency, bt, B.f, B.f * 0.62, B.d * 0.7 );
				const lp = v.filter( 'lowpass', 150, 0.9 );
				const g = v.gain( 0 );
				osc.connect( g ); g.connect( lp ); lp.connect( out );
				const e = ampEnv( g.gain, bt, B.g, 0.008, B.d );
				v.play( osc, bt, e - bt + 0.01 );

				// muscular thud texture
				const s = v.noise( R.brown, 0.7 );
				const slp = v.filter( 'lowpass', 190, 1.1 );
				const sg = v.gain( 0 );
				s.connect( slp ); slp.connect( sg ); sg.connect( out );
				const e2 = ampEnv( sg.gain, bt, B.g * 0.5, 0.006, B.d * 0.8 );
				v.play( s, bt, e2 - bt + 0.008 );

			}

			return finish( v, out );

		},

		/** Death: everything falls apart and drops out of the room. */
		death( when, o = {} ) {

			if ( ! o.dest ) return null;
			const v = new Voice( ctx, when );
			const t = v.t;
			const out = head( v, o, ( o.gain === undefined ? 1 : o.gain ) * 0.55 );

			const vcf = v.filter( 'lowpass', 2200, 3 );
			vcf.frequency.setValueAtTime( 2400, t );
			vcf.frequency.exponentialRampToValueAtTime( 180, t + 1.8 );
			vcf.connect( out );

			for ( let i = 0; i < 3; i ++ ) {

				const f = 220 * ( 1 + i * 0.007 );
				const osc = v.osc( 'sawtooth', f );
				glide( osc.frequency, t, f, 54 * ( 1 + i * 0.01 ), 1.7 );
				const g = v.gain( 0 );
				osc.connect( g ); g.connect( vcf );
				const e = ampEnv( g.gain, t, 0.22, 0.02, 2.0 );
				v.play( osc, t, e - t + 0.02 );

			}

			const sub = v.osc( 'sine', 76 );
			glide( sub.frequency, t, 76, 26, 1.5 );
			const sg = v.gain( 0 );
			sub.connect( sg ); sg.connect( out );
			const e = ampEnv( sg.gain, t, 0.6, 0.01, 2.1 );
			v.play( sub, t, e - t + 0.02 );

			// air being sucked out
			const s = v.noise( R.pink, 1 );
			const bp = v.filter( 'bandpass', 2000, 1.1 );
			glide( bp.frequency, t, 3200, 340, 1.6 );
			const g = v.gain( 0 );
			s.connect( bp ); bp.connect( g ); g.connect( out );
			const e2 = ampEnv( g.gain, t, 0.3, 0.05, 1.9 );
			v.play( s, t, e2 - t + 0.02 );

			return finish( v, out );

		},

	};

}

// ---------------------------------------------------------------------------
// Persistent beds (ambience + music)
// ---------------------------------------------------------------------------

/**
 * Continuously running ambience: two decorrelated wind layers with slowly
 * modulated cutoff and level, a low industrial hum with a tremolo, and a sub
 * drone. All modulation comes from free-running LFOs at incommensurate rates
 * so the bed never repeats audibly.
 *
 * @returns {{out:GainNode, start(when:number):void, stop(when:number):void, setLevel(v:number,when:number):void}}
 */
export function createAmbienceBed( ctx ) {

	const R = synthResources( ctx );
	const nodes = [];
	const srcs = [];
	const keep = ( n ) => { nodes.push( n ); return n; };

	const out = keep( ctx.createGain() );
	out.gain.value = 1;

	const guard = keep( ctx.createBiquadFilter() );
	guard.type = 'highpass';
	guard.frequency.value = 24;
	guard.connect( out );

	function lfo( rate, depth, target, base ) {

		const o = ctx.createOscillator();
		o.type = 'sine';
		o.frequency.value = rate;
		const g = ctx.createGain();
		g.gain.value = depth;
		o.connect( g );
		g.connect( target );
		if ( base !== undefined ) target.value = base;
		keep( o ); keep( g ); srcs.push( o );
		return o;

	}

	// --- wind: two brown-noise layers, hard-panned, independently modulated
	const windMix = keep( ctx.createGain() );
	windMix.gain.value = 0.3;
	windMix.connect( guard );

	const windCfg = [
		{ rate: 0.83, pan: - 0.72, base: 620, depth: 260, gust: 90, lfoRate: 0.037, amp: 0.62, ampLfo: 0.019 },
		{ rate: 1.19, pan: 0.7, base: 540, depth: 230, gust: 80, lfoRate: 0.053, amp: 0.55, ampLfo: 0.0271 },
	];

	for ( let i = 0; i < windCfg.length; i ++ ) {

		const C = windCfg[ i ];
		const s = ctx.createBufferSource();
		s.buffer = R.brown;
		s.loop = true;
		s.playbackRate.value = C.rate;
		keep( s ); srcs.push( s );

		const lp = keep( ctx.createBiquadFilter() );
		lp.type = 'lowpass';
		lp.frequency.value = C.base;
		lp.Q.value = 0.9;

		const hp = keep( ctx.createBiquadFilter() );
		hp.type = 'highpass';
		hp.frequency.value = 90;

		const g = keep( ctx.createGain() );
		g.gain.value = C.amp;

		const p = ctx.createStereoPanner ? keep( ctx.createStereoPanner() ) : keep( ctx.createGain() );
		if ( p.pan ) p.pan.value = C.pan;

		s.connect( hp ); hp.connect( lp ); lp.connect( g ); g.connect( p ); p.connect( windMix );

		lfo( C.lfoRate, C.depth, lp.frequency, C.base );
		lfo( C.ampLfo, C.amp * 0.45, g.gain, C.amp );
		// slow gusts: a second, much slower cutoff modulation at an
		// incommensurate rate so the pair never repeats audibly
		lfo( C.lfoRate * 0.31, C.gust, lp.frequency );

	}

	// --- industrial hum: mains-ish fundamental + harmonic, tremolo'd
	const humMix = keep( ctx.createGain() );
	humMix.gain.value = 0.055;
	humMix.connect( guard );

	const humFreqs = [ 49.7, 99.4, 149.1 ];
	const humGains = [ 0.5, 0.26, 0.1 ];
	for ( let i = 0; i < humFreqs.length; i ++ ) {

		const o = ctx.createOscillator();
		o.type = i === 0 ? 'sawtooth' : 'sine';
		o.frequency.value = humFreqs[ i ];
		keep( o ); srcs.push( o );
		const bp = keep( ctx.createBiquadFilter() );
		bp.type = 'lowpass';
		bp.frequency.value = 420;
		const g = keep( ctx.createGain() );
		g.gain.value = humGains[ i ];
		o.connect( bp ); bp.connect( g ); g.connect( humMix );

	}

	lfo( 0.113, 0.025, humMix.gain, 0.055 );

	// --- sub drone: two barely-detuned sines beating against each other
	const subMix = keep( ctx.createGain() );
	subMix.gain.value = 0.08;
	const subLp = keep( ctx.createBiquadFilter() );
	subLp.type = 'lowpass';
	subLp.frequency.value = 110;
	subMix.connect( subLp ); subLp.connect( guard );

	const subFreqs = [ 34, 34.9, 51 ];
	for ( let i = 0; i < subFreqs.length; i ++ ) {

		const o = ctx.createOscillator();
		o.type = 'sine';
		o.frequency.value = subFreqs[ i ];
		keep( o ); srcs.push( o );
		const g = keep( ctx.createGain() );
		g.gain.value = i === 2 ? 0.25 : 0.5;
		o.connect( g ); g.connect( subMix );

	}

	lfo( 0.0411, 0.034, subMix.gain, 0.08 );

	// --- high air: a whisper of filtered pink so the top octave isn't dead
	{

		const s = ctx.createBufferSource();
		s.buffer = R.pink;
		s.loop = true;
		s.playbackRate.value = 0.93;
		keep( s ); srcs.push( s );
		const hp = keep( ctx.createBiquadFilter() );
		hp.type = 'highpass';
		hp.frequency.value = 3200;
		const g = keep( ctx.createGain() );
		g.gain.value = 0.022;
		s.connect( hp ); hp.connect( g ); g.connect( guard );
		lfo( 0.0237, 0.013, g.gain, 0.022 );

	}

	let started = false;

	return {

		out,

		start( when ) {

			if ( started ) return;
			started = true;
			const t = Math.max( when || ctx.currentTime, ctx.currentTime );
			for ( let i = 0; i < srcs.length; i ++ ) {

				try { srcs[ i ].start( t + Math.random() * 0.05 ); } catch ( e ) { /* already started */ }

			}

		},

		setLevel( v, when ) {

			out.gain.setTargetAtTime( Math.max( 0, v ), when || ctx.currentTime, 0.25 );

		},

		stop( when ) {

			const t = Math.max( when || ctx.currentTime, ctx.currentTime );
			out.gain.setTargetAtTime( 0, t, 0.4 );
			for ( let i = 0; i < srcs.length; i ++ ) {

				try { srcs[ i ].stop( t + 2.5 ); } catch ( e ) { /* fine */ }

			}

			started = false;

		},

	};

}

/** Semitone offsets from the root used by the tension motif (A natural minor). */
const MOTIF = [ 0, 7, 12, 15, 14, 12, 7, 10, 0, 7, 12, 19, 17, 15, 12, 7 ];

/**
 * Combat tension layer: a pulsing filtered drone bed plus a scheduled
 * arpeggiated motif. Intensity opens the filter, raises the bed level and
 * enables the motif; at intensity 0 it is silent but still running (no
 * oscillator churn during a firefight).
 */
export function createMusicBed( ctx, options = {} ) {

	const R = synthResources( ctx );
	const bpm = options.bpm || 96;
	const root = options.root || 55; // A1
	const nodes = [];
	const srcs = [];
	const keep = ( n ) => { nodes.push( n ); return n; };

	const out = keep( ctx.createGain() );
	out.gain.value = 1;

	// --- bed -------------------------------------------------------------
	const bedGain = keep( ctx.createGain() );
	bedGain.gain.value = 0;

	const pulse = keep( ctx.createGain() );
	pulse.gain.value = 0.66;

	const vcf = keep( ctx.createBiquadFilter() );
	vcf.type = 'lowpass';
	vcf.frequency.value = 180;
	vcf.Q.value = 5;

	const sat = keep( ctx.createWaveShaper() );
	sat.curve = R.curve( 1.75 );
	sat.oversample = 'none';

	bedGain.connect( vcf ); vcf.connect( sat ); sat.connect( pulse ); pulse.connect( out );

	const bedFreqs = [ root, root * 1.004, root * 1.4983, root * 0.5 ];
	for ( let i = 0; i < bedFreqs.length; i ++ ) {

		const o = ctx.createOscillator();
		o.type = i === 3 ? 'sine' : 'sawtooth';
		o.frequency.value = bedFreqs[ i ];
		keep( o ); srcs.push( o );
		const g = keep( ctx.createGain() );
		g.gain.value = i === 3 ? 0.5 : 0.24;
		o.connect( g ); g.connect( bedGain );

	}

	// eighth-note pulse, free-running so it never needs scheduling
	{

		const lfoOsc = ctx.createOscillator();
		lfoOsc.type = 'sine';
		lfoOsc.frequency.value = ( bpm / 60 ) * 2;
		const lg = keep( ctx.createGain() );
		lg.gain.value = 0.34;
		lfoOsc.connect( lg ); lg.connect( pulse.gain );
		keep( lfoOsc ); srcs.push( lfoOsc );

	}

	// --- motif voice bus --------------------------------------------------
	const noteBus = keep( ctx.createGain() );
	noteBus.gain.value = 0;
	const noteVerbish = keep( ctx.createBiquadFilter() );
	noteVerbish.type = 'lowpass';
	noteVerbish.frequency.value = 3600;
	noteBus.connect( noteVerbish ); noteVerbish.connect( out );

	let started = false;
	let intensity = 0;

	function note( when, semitone, velocity ) {

		const t = Math.max( when, ctx.currentTime );
		const f = root * 4 * Math.pow( 2, semitone / 12 );
		const v = new Voice( ctx, t );
		const g = v.gain( 0 );
		const bp = v.filter( 'bandpass', f * 1.6, 2.2 );
		g.connect( bp ); bp.connect( noteBus );

		const a = v.osc( 'triangle', f );
		const b = v.osc( 'sawtooth', f * 0.5 );
		const bg = v.gain( 0.35 );
		a.connect( g ); b.connect( bg ); bg.connect( g );

		const e = ampEnv( g.gain, t, 0.5 * velocity, 0.004, 0.34 );
		v.play( a, t, e - t + 0.01 );
		v.play( b, t, e - t + 0.01 );
		v.seal();
		return { out: g, end: v.end };

	}

	return {

		out,
		bpm,

		start( when ) {

			if ( started ) return;
			started = true;
			const t = Math.max( when || ctx.currentTime, ctx.currentTime );
			for ( let i = 0; i < srcs.length; i ++ ) {

				try { srcs[ i ].start( t ); } catch ( e ) { /* already started */ }

			}

		},

		get intensity() { return intensity; },

		setIntensity( v, when ) {

			intensity = clamp( v, 0, 1 );
			const t = when || ctx.currentTime;
			bedGain.gain.setTargetAtTime( intensity * 0.32, t, 0.6 );
			noteBus.gain.setTargetAtTime( intensity > 0.25 ? ( intensity - 0.25 ) * 0.5 : 0, t, 0.8 );
			vcf.frequency.setTargetAtTime( 170 + intensity * intensity * 1250, t, 0.7 );

		},

		/** Schedule motif step `index` at absolute time `when`. */
		step( when, index, velocity = 1 ) {

			const s = MOTIF[ index % MOTIF.length ];
			return note( when, s, velocity );

		},

		stop( when ) {

			const t = when || ctx.currentTime;
			intensity = 0;
			bedGain.gain.setTargetAtTime( 0, t, 0.4 );
			noteBus.gain.setTargetAtTime( 0, t, 0.4 );

		},

	};

}

export default {
	synthResources,
	WEAPON_PROFILES,
	profileFor,
	gunshot,
	shellCasing,
	emptyClick,
	weaponSwitch,
	adsIn,
	adsOut,
	reloadSounds,
	impactSound,
	footstep,
	landing,
	jumpEffort,
	bodyFall,
	hitmarker,
	killConfirm,
	damageSting,
	regenSwell,
	bulletWhizby,
	metalClang,
	gullCry,
	creak,
	distantBoom,
	subRumble,
	uiSounds,
	createAmbienceBed,
	createMusicBed,
};
