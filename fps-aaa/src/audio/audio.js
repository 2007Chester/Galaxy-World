/**
 * OVERPRESSURE — audio system.
 *
 * 100% procedural WebAudio. No files, no CDN, no npm. Every buffer and impulse
 * response is synthesised once, at unlock time, inside impulse.js / synth.js.
 *
 * The module is a pure event-bus consumer: it imports only core/events.js,
 * core/settings.js and its own two siblings. It never reaches into player,
 * combat, world or ui.
 *
 * --------------------------------------------------------------------------
 * MIX TOPOLOGY
 * --------------------------------------------------------------------------
 *
 *   player gunfire ─► gunDry ─────────────┐
 *   spatial one-shots ─► chan[i].in ─► chan[i].lp ─► chan[i].panner(HRTF) ─┤
 *   non-spatial world sfx ────────────────┤
 *   reverb return ◄── envConv ◄── verbPre ◄── verbSend ◄── (voice aux sends)
 *   gun-tail return ◄── tailConv ◄── tailPre ◄── tailSend ◄── (voice aux sends)
 *   tight return ◄── tightConv ◄── tightSend ◄── (viewmodel/UI aux sends)
 *                                          │
 *                                     ┌────┴──── sfxBus ─► sfxMuffle(LP) ─► sfxGain ─┐
 *   ui / hitmarkers / stingers ──────────────────────────► uiGain ──────────────────┤
 *   music bed + motif ───────────────────────────────────► musicGain ───────────────┤─► duck
 *   ambience bed ─► ambDuck ─────────────────────────────► ambGain ─────────────────┘    │
 *                                                                                        ▼
 *   tinnitus ring ─────────────────────────────────────────────────► limiter (DynamicsCompressor)
 *                                                                              │
 *                                                                              ▼
 *                                                                        masterGain ─► destination
 *
 * The limiter sits last so a firefight glues instead of clipping. The sub-heavy
 * layers of every gunshot bypass their voice's waveshaper, so sustained
 * full-auto compresses rather than turning to mush.
 */

import { bus } from '../core/events.js';
import { settings } from '../core/settings.js';
import { makeImpulseSet } from './impulse.js';
import * as S from './synth.js';

const MAX_VOICES = 24;
const MAX_VOICES_LOW = 14;
const SPATIAL_CHANNELS = 20;

const PANNER_REF = 4;
const PANNER_ROLLOFF = 1.3;
const PANNER_MAX = 120;

/**
 * The player's own weapon is the loudest thing in the game and everything else
 * is levelled against it. Tuned so one shot peaks just under the limiter
 * threshold, leaving the limiter to handle overlap only.
 */
const GUN_LEVEL = 0.45;

/** Seconds of propagation delay per metre (~343 m/s), capped so it never feels laggy. */
const DELAY_PER_METRE = 0.0029;
const MAX_PROP_DELAY = 0.22;

const STEP_SURFACES = { concrete: 1, metal: 1, wood: 1, dirt: 1, sand: 1, glass: 1 };
const IMPACT_SURFACES = { concrete: 1, metal: 1, wood: 1, dirt: 1, sand: 1, glass: 1, flesh: 1 };

function clamp( v, a, b ) { return v < a ? a : ( v > b ? b : v ); }
function lerp( a, b, t ) { return a + ( b - a ) * t; }

/**
 * @param {{matrixWorld:{elements:ArrayLike<number>}}} camera  the world camera; its
 *        world matrix drives the AudioListener every frame.
 */
export function createAudio( camera ) {

	let ctx = null;
	let built = false;
	let irs = null;

	const n = {};          // graph nodes
	const voices = [];     // { out, end, prio, start }
	const chans = [];      // spatial channel pool
	const V = {};          // pre-constructed voice players

	let ambience = null;
	let music = null;

	const st = {
		volumeScale: 1,
		maxVoices: MAX_VOICES,
		perfScale: 1,
		lowFps: 0,
		highFps: 0,

		// listener
		lx: 0, ly: 0, lz: 0,

		// weapon
		profile: S.WEAPON_PROFILES[ 'VK-7' ],
		equippedOnce: false,

		// pacing / rate limits
		lastShot: - 1,
		shotTimes: new Float64Array( 40 ).fill( - 1000 ),
		shotHead: 0,
		gates: Object.create( null ),
		budgets: Object.create( null ),

		// dynamics
		suppress: 0,
		ringUntil: - 1,
		duckUntil: - 1,
		duckStrength: 0,
		ambDuckUntil: - 1,
		curDuck: 1,
		curAmbDuck: 1,
		curMuffle: 20000,

		// player condition
		health01: 1,
		dead: false,
		paused: false,
		inGame: false,

		// schedulers
		heartNext: 0,
		ambNext: { clang: 0, gull: 0, creak: 0, boom: 0 },
		musicNext: 0,
		musicStep: 0,
		waveIntensity: 0,
		threat: 0,
		intensity: 0,
		curIntensity: - 1,

		// cached settings
		cMaster: - 1, cSfx: - 1, cMusic: - 1,
	};

	// ------------------------------------------------------------------
	// Graph construction
	// ------------------------------------------------------------------

	function build() {

		if ( built ) return;

		const AC = window.AudioContext || window.webkitAudioContext;
		if ( ! AC ) return;

		ctx = new AC( { latencyHint: 'interactive' } );
		irs = makeImpulseSet( ctx );

		// --- master chain -------------------------------------------------
		n.master = ctx.createGain();
		n.master.gain.value = 0.0001;
		n.master.connect( ctx.destination );

		// Light glue limiter. Sources are levelled so a single loud event sits
		// just under the threshold; this only engages when events stack, which
		// is exactly what happens in a firefight.
		n.limiter = ctx.createDynamicsCompressor();
		n.limiter.threshold.value = - 3.5;
		n.limiter.knee.value = 8;
		n.limiter.ratio.value = 10;
		n.limiter.attack.value = 0.003;
		n.limiter.release.value = 0.22;
		n.limiter.connect( n.master );

		n.duck = ctx.createGain();
		n.duck.gain.value = 1;
		n.duck.connect( n.limiter );

		// --- categories ------------------------------------------------------
		n.sfxGain = ctx.createGain();
		n.sfxGain.gain.value = 1;
		n.sfxGain.connect( n.duck );

		// Low-health / concussion muffle. Sits on the sfx bus only so UI stays
		// legible when the player is nearly dead.
		n.sfxMuffle = ctx.createBiquadFilter();
		n.sfxMuffle.type = 'lowpass';
		n.sfxMuffle.frequency.value = 20000;
		n.sfxMuffle.Q.value = 0.7;
		n.sfxMuffle.connect( n.sfxGain );

		n.sfxBus = ctx.createGain();
		n.sfxBus.gain.value = 1;
		n.sfxBus.connect( n.sfxMuffle );

		n.uiGain = ctx.createGain();
		n.uiGain.gain.value = 1;
		n.uiGain.connect( n.duck );

		n.musicGain = ctx.createGain();
		n.musicGain.gain.value = 0;
		n.musicGain.connect( n.duck );

		n.ambGain = ctx.createGain();
		n.ambGain.gain.value = 0;
		n.ambGain.connect( n.duck );

		n.ambDuck = ctx.createGain();
		n.ambDuck.gain.value = 1;
		n.ambDuck.connect( n.ambGain );

		// --- aux: environment reverb ------------------------------------------
		n.envConv = ctx.createConvolver();
		n.envConv.normalize = true;
		n.envConv.buffer = irs.outdoorYard;

		n.verbReturn = ctx.createGain();
		n.verbReturn.gain.value = 0.85;
		n.envConv.connect( n.verbReturn );
		n.verbReturn.connect( n.sfxBus );

		n.verbPreHp = ctx.createBiquadFilter();
		n.verbPreHp.type = 'highpass';
		n.verbPreHp.frequency.value = 180;
		n.verbPreLp = ctx.createBiquadFilter();
		n.verbPreLp.type = 'lowpass';
		n.verbPreLp.frequency.value = 8500;
		n.verbPreHp.connect( n.verbPreLp );
		n.verbPreLp.connect( n.envConv );

		n.verbSend = ctx.createGain();
		n.verbSend.gain.value = 0.5;
		n.verbSend.connect( n.verbPreHp );

		// --- aux: gun tail (the slapback that sells the space) ------------------
		n.tailConv = ctx.createConvolver();
		n.tailConv.normalize = true;
		n.tailConv.buffer = irs.gunTail;

		n.tailReturn = ctx.createGain();
		n.tailReturn.gain.value = 0.95;
		n.tailConv.connect( n.tailReturn );
		n.tailReturn.connect( n.sfxBus );

		n.tailPre = ctx.createBiquadFilter();
		n.tailPre.type = 'highpass';
		n.tailPre.frequency.value = 150;
		n.tailPre.connect( n.tailConv );

		n.tailSend = ctx.createGain();
		n.tailSend.gain.value = 0.7;
		n.tailSend.connect( n.tailPre );

		// --- aux: tight box for viewmodel + UI ----------------------------------
		n.tightConv = ctx.createConvolver();
		n.tightConv.normalize = true;
		n.tightConv.buffer = irs.tight;

		n.tightReturn = ctx.createGain();
		n.tightReturn.gain.value = 0.5;
		n.tightConv.connect( n.tightReturn );
		n.tightReturn.connect( n.sfxBus );

		n.tightSend = ctx.createGain();
		n.tightSend.gain.value = 0.55;
		n.tightSend.connect( n.tightConv );

		// --- player weapon dry path ---------------------------------------------
		n.gunDry = ctx.createGain();
		n.gunDry.gain.value = 1;
		n.gunDry.connect( n.sfxBus );

		// --- tinnitus ring (bypasses the duck so it survives the dip) -------------
		n.tinGain = ctx.createGain();
		n.tinGain.gain.value = 0;
		n.tinGain.connect( n.limiter );

		n.tinBp = ctx.createBiquadFilter();
		n.tinBp.type = 'bandpass';
		n.tinBp.frequency.value = 6200;
		n.tinBp.Q.value = 1.2;
		n.tinBp.connect( n.tinGain );

		for ( let i = 0; i < 2; i ++ ) {

			const o = ctx.createOscillator();
			o.type = 'sine';
			o.frequency.value = i === 0 ? 5280 : 7910;
			const g = ctx.createGain();
			g.gain.value = i === 0 ? 1 : 0.45;
			o.connect( g );
			g.connect( n.tinBp );
			o.start();
			n[ 'tinOsc' + i ] = o;

		}

		// --- spatial channel pool --------------------------------------------------
		for ( let i = 0; i < SPATIAL_CHANNELS; i ++ ) {

			const input = ctx.createGain();
			input.gain.value = 1;

			const lp = ctx.createBiquadFilter();
			lp.type = 'lowpass';
			lp.frequency.value = 19000;
			lp.Q.value = 0.5;

			const panner = ctx.createPanner();
			panner.panningModel = 'HRTF';
			panner.distanceModel = 'inverse';
			panner.refDistance = PANNER_REF;
			panner.rolloffFactor = PANNER_ROLLOFF;
			panner.maxDistance = PANNER_MAX;
			panner.coneInnerAngle = 360;
			panner.coneOuterAngle = 360;
			panner.coneOuterGain = 1;

			input.connect( lp );
			lp.connect( panner );
			panner.connect( n.sfxBus );

			chans.push( { input, lp, panner, free: 0 } );

		}

		buildVoices();

		ambience = S.createAmbienceBed( ctx );
		ambience.out.connect( n.ambDuck );

		music = S.createMusicBed( ctx, { bpm: 96, root: 55 } );
		music.out.connect( n.musicGain );

		built = true;

	}

	function buildVoices() {

		V.guns = {};
		for ( const key in S.WEAPON_PROFILES ) {

			V.guns[ key ] = S.gunshot( ctx, S.WEAPON_PROFILES[ key ] );

		}

		V.impacts = {};
		for ( const s in IMPACT_SURFACES ) V.impacts[ s ] = S.impactSound( ctx, s );

		V.steps = {};
		V.lands = {};
		for ( const s in STEP_SURFACES ) {

			V.steps[ s ] = S.footstep( ctx, s );
			V.lands[ s ] = S.landing( ctx, s );

		}

		V.reload = S.reloadSounds( ctx );
		V.ui = S.uiSounds( ctx );
		V.hit = S.hitmarker( ctx, false );
		V.hitHead = S.hitmarker( ctx, true );
		V.kill = S.killConfirm( ctx );
		V.whizby = S.bulletWhizby( ctx );
		V.dry = S.emptyClick( ctx );
		V.switch = S.weaponSwitch( ctx );
		V.adsIn = S.adsIn( ctx );
		V.adsOut = S.adsOut( ctx );
		V.shell = S.shellCasing( ctx );
		V.body = S.bodyFall( ctx );
		V.damage = S.damageSting( ctx );
		V.regen = S.regenSwell( ctx );
		V.clang = S.metalClang( ctx );
		V.gull = S.gullCry( ctx );
		V.creak = S.creak( ctx );
		V.boom = S.distantBoom( ctx );
		V.rumble = S.subRumble( ctx );
		V.jump = S.jumpEffort( ctx );

	}

	// ------------------------------------------------------------------
	// Voice budget
	// ------------------------------------------------------------------

	function stealVoice( rec ) {

		const now = ctx.currentTime;
		const g = rec.out.gain;
		try {

			const cur = g.value;
			g.cancelScheduledValues( now );
			g.setValueAtTime( cur, now );
			g.linearRampToValueAtTime( 0, now + 0.02 );

		} catch ( e ) { /* node already torn down */ }

	}

	/**
	 * Register a freshly spawned voice. Over budget we steal the least
	 * important still-sounding voice; if the newcomer *is* the least important
	 * it mutes itself instead, so the cap is a hard ceiling either way.
	 */
	function addVoice( h, prio ) {

		if ( ! h || ! h.out ) return h;
		const now = ctx.currentTime;

		for ( let i = voices.length - 1; i >= 0; i -- ) {

			if ( voices[ i ].end <= now ) voices.splice( i, 1 );

		}

		while ( voices.length >= st.maxVoices ) {

			let idx = 0;
			for ( let i = 1; i < voices.length; i ++ ) {

				const a = voices[ i ], b = voices[ idx ];
				if ( a.prio < b.prio || ( a.prio === b.prio && a.start < b.start ) ) idx = i;

			}

			const victim = voices[ idx ];
			if ( victim.prio > prio ) { stealVoice( h ); return h; }
			stealVoice( victim );
			voices.splice( idx, 1 );

		}

		voices.push( { out: h.out, end: h.end, prio, start: now } );
		return h;

	}

	function addVoices( list, prio ) {

		if ( ! list ) return;
		for ( let i = 0; i < list.length; i ++ ) addVoice( list[ i ], prio );

	}

	/** Minimum-interval gate keyed by name. */
	function gate( name, minInterval ) {

		const now = ctx.currentTime;
		const last = st.gates[ name ];
		if ( last !== undefined && now - last < minInterval ) return false;
		st.gates[ name ] = now;
		return true;

	}

	/**
	 * Sliding-window budget. Unlike `gate` this allows a burst within one frame
	 * (several bullets can land on the same tick) while still capping the rate
	 * over time.
	 */
	function budget( name, window, max ) {

		const now = ctx.currentTime;
		let b = st.budgets[ name ];
		if ( ! b ) { b = st.budgets[ name ] = { start: now, count: 0 }; }
		if ( now - b.start >= window ) { b.start = now; b.count = 0; }
		if ( b.count >= max ) return false;
		b.count ++;
		return true;

	}

	// ------------------------------------------------------------------
	// Spatialisation
	// ------------------------------------------------------------------

	function distanceTo( x, y, z ) {

		const dx = x - st.lx, dy = y - st.ly, dz = z - st.lz;
		return Math.sqrt( dx * dx + dy * dy + dz * dz );

	}

	/**
	 * Grab a pooled HRTF channel positioned at (x,y,z) and pre-filtered for the
	 * distance. Returns the send levels + propagation delay the caller should
	 * apply, so far gunfire loses treble, gains reverb and arrives late.
	 */
	function acquire( x, y, z, holdFor ) {

		const now = ctx.currentTime;
		const dist = distanceTo( x, y, z );

		let ch = null;
		for ( let i = 0; i < chans.length; i ++ ) {

			if ( chans[ i ].free <= now ) { ch = chans[ i ]; break; }

		}

		if ( ! ch ) {

			ch = chans[ 0 ];
			for ( let i = 1; i < chans.length; i ++ ) if ( chans[ i ].free < ch.free ) ch = chans[ i ];

		}

		ch.free = now + ( holdFor || 0.4 );

		// Aux sends are taken from the voice *before* the panner, so they would
		// otherwise ignore distance entirely and a shot 40m away would drown the
		// mix in reverb. Fold the panner's own inverse-distance gain into them.
		const atten = PANNER_REF / ( PANNER_REF + PANNER_ROLLOFF * Math.max( 0, Math.min( dist, PANNER_MAX ) - PANNER_REF ) );

		const p = ch.panner;
		if ( p.positionX ) {

			p.positionX.value = x;
			p.positionY.value = y;
			p.positionZ.value = z;

		} else if ( p.setPosition ) {

			p.setPosition( x, y, z );

		}

		// Air absorption: high frequencies die with distance. This single filter
		// is most of what makes a 60m firefight read as "over there".
		ch.lp.frequency.value = clamp( 19000 * Math.exp( - dist / 26 ), 800, 19000 );

		return {
			dest: ch.input,
			dist,
			atten,
			verbGain: atten * clamp( 0.2 + dist / 42, 0.2, 1.3 ),
			tailGain: atten * clamp( 0.5 + dist / 32, 0.5, 1.6 ),
			delay: Math.min( dist * DELAY_PER_METRE, MAX_PROP_DELAY ),
		};

	}

	function updateListener() {

		if ( ! camera || ! camera.matrixWorld ) return;
		const e = camera.matrixWorld.elements;

		st.lx = e[ 12 ]; st.ly = e[ 13 ]; st.lz = e[ 14 ];

		// Three's camera looks down -Z; column 2 is +Z, column 1 is up.
		const fx = - e[ 8 ], fy = - e[ 9 ], fz = - e[ 10 ];
		const ux = e[ 4 ], uy = e[ 5 ], uz = e[ 6 ];

		const L = ctx.listener;
		if ( L.positionX ) {

			L.positionX.value = st.lx;
			L.positionY.value = st.ly;
			L.positionZ.value = st.lz;
			L.forwardX.value = fx;
			L.forwardY.value = fy;
			L.forwardZ.value = fz;
			L.upX.value = ux;
			L.upY.value = uy;
			L.upZ.value = uz;

		} else {

			if ( L.setPosition ) L.setPosition( st.lx, st.ly, st.lz );
			if ( L.setOrientation ) L.setOrientation( fx, fy, fz, ux, uy, uz );

		}

	}

	// ------------------------------------------------------------------
	// Dynamics: ducking, suppression, tinnitus, muffle
	// ------------------------------------------------------------------

	function duckAmbience( seconds ) {

		st.ambDuckUntil = Math.max( st.ambDuckUntil, ctx.currentTime + ( seconds || 0.35 ) );

	}

	function triggerTinnitus( strength ) {

		const now = ctx.currentTime;
		if ( now < st.ringUntil - 1.2 ) return;

		const s = clamp( strength, 0, 1 );
		const dur = 1.6 + s * 2.4;
		st.ringUntil = now + dur;

		const g = n.tinGain.gain;
		try {

			g.cancelScheduledValues( now );
			g.setValueAtTime( Math.max( 0.00005, g.value ), now );
			g.exponentialRampToValueAtTime( 0.016 + 0.05 * s, now + 0.035 );
			g.exponentialRampToValueAtTime( 0.00005, now + dur );
			g.setValueAtTime( 0, now + dur );

		} catch ( e ) { /* ignore */ }

		st.duckUntil = now + 0.45 + s * 0.9;
		st.duckStrength = Math.max( st.duckStrength, 0.2 + s * 0.22 );
		duckAmbience( 0.9 );

	}

	function setHealth( h01 ) {

		const v = clamp( h01, 0, 1 );
		const wasLow = st.health01 < 0.35;
		st.health01 = v;
		if ( wasLow && v > 0.55 && ! st.dead ) {

			if ( gate( 'regen', 4 ) ) addVoice( V.regen( ctx.currentTime, { dest: n.uiGain, gain: 0.8 } ), 6 );

		}

	}

	// ------------------------------------------------------------------
	// Event routing
	// ------------------------------------------------------------------

	function shotRate() {

		const now = ctx.currentTime;
		let count = 0;
		for ( let i = 0; i < st.shotTimes.length; i ++ ) {

			if ( now - st.shotTimes[ i ] < 1 ) count ++;

		}

		return count;

	}

	function onFire( p ) {

		if ( ! ready() ) return;
		const now = ctx.currentTime;
		if ( now - st.lastShot < 0.028 ) return;   // hard retrigger ceiling (~35/s)
		st.lastShot = now;
		st.shotTimes[ st.shotHead ] = now;
		st.shotHead = ( st.shotHead + 1 ) % st.shotTimes.length;

		const rate = shotRate();
		// Sustained fire: shed the mechanical + boom layers and pull the tail
		// send down. Keeps CPU flat and stops the tail from stacking into mush.
		const lite = rate > 13 || st.perfScale < 1;
		const crowd = clamp( ( rate - 6 ) / 14, 0, 1 );

		const prof = S.profileFor( p && p.id, p && p.name ) || st.profile;
		const play = V.guns[ prof.key ] || V.guns[ 'VK-7' ];
		const silenced = !! ( p && p.silenced );

		addVoice( play( now + 0.001, {
			dest: n.gunDry,
			tail: n.tailSend,
			verb: n.verbSend,
			gain: GUN_LEVEL * ( 1 - crowd * 0.28 ) * ( lite ? 0.94 : 1 ),
			tailGain: lite ? 0.55 : 1,
			verbGain: 0.85 - crowd * 0.3,
			silenced,
			lite,
		} ), 10 );

		if ( ! lite && st.perfScale >= 1 && Math.random() < 0.8 ) {

			addVoice( V.shell( now + 0.24 + Math.random() * 0.13, {
				dest: n.sfxBus, tail: null, verb: n.verbSend, verbGain: 0.25, gain: 0.5,
			} ), 2 );

		}

		st.suppress += silenced ? 0.012 : 0.05;
		duckAmbience( 0.55 );

	}

	function onDry() {

		if ( ! ready() ) return;
		if ( ! gate( 'dry', 0.08 ) ) return;
		addVoice( V.dry( ctx.currentTime, { dest: n.sfxBus, verb: n.tightSend, verbGain: 0.4, gain: 1 } ), 8 );

	}

	function onReloadStart( p ) {

		if ( ! ready() ) return;
		const now = ctx.currentTime;
		const o = { dest: n.sfxBus, verb: n.tightSend, verbGain: 0.6, gain: 1 };
		addVoices( V.reload.sequence( now, p && p.duration, o ), 8 );

	}

	function onReloadEnd() {

		if ( ! ready() ) return;
		addVoice( V.reload.boltRelease( ctx.currentTime, {
			dest: n.sfxBus, verb: n.tightSend, verbGain: 0.6, gain: 1,
		} ), 8 );

	}

	function onEquipped( p ) {

		if ( ! ready() ) return;
		st.profile = S.profileFor( p && p.id, p && p.name );
		const first = ! st.equippedOnce;
		st.equippedOnce = true;
		addVoice( V.switch( ctx.currentTime, {
			dest: n.sfxBus, verb: n.tightSend, verbGain: 0.5, gain: first ? 0.4 : 1,
		} ), 7 );

	}

	function onAds( p ) {

		if ( ! ready() ) return;
		if ( ! gate( 'ads', 0.09 ) ) return;
		const play = ( p && p.active ) ? V.adsIn : V.adsOut;
		addVoice( play( ctx.currentTime, { dest: n.sfxBus, verb: n.tightSend, verbGain: 0.35 } ), 5 );

	}

	function onHitSurface( p ) {

		if ( ! ready() || ! p || ! p.point ) return;
		if ( ! budget( 'impact', 0.1, 6 ) ) return;

		const surface = IMPACT_SURFACES[ p.surface ] ? p.surface : 'concrete';
		const sp = acquire( p.point.x, p.point.y, p.point.z, 0.5 );
		const play = V.impacts[ surface ];

		addVoice( play( ctx.currentTime + sp.delay, {
			dest: sp.dest,
			verb: n.verbSend,
			verbGain: sp.verbGain * 0.5,
			gain: 1.2,
		} ), 5 );

	}

	function onHitConfirm( p ) {

		if ( ! ready() || ! p ) return;

		const marker = p.headshot ? V.hitHead : V.hit;
		if ( gate( 'hitmarker', 0.035 ) ) {

			addVoice( marker( ctx.currentTime, {
				dest: n.uiGain, verb: n.tightSend, verbGain: 0.3, gain: 1,
			} ), 9 );

		}

		if ( p.point && gate( 'flesh', 0.03 ) ) {

			const sp = acquire( p.point.x, p.point.y, p.point.z, 0.4 );
			addVoice( V.impacts.flesh( ctx.currentTime + sp.delay, {
				dest: sp.dest, verb: n.verbSend, verbGain: sp.verbGain * 0.35, gain: 1.1,
			} ), 6 );

		}

	}

	function onEnemyKilled( p ) {

		if ( ! ready() ) return;

		if ( gate( 'kill', 0.06 ) ) {

			addVoice( V.kill( ctx.currentTime, {
				dest: n.uiGain, verb: n.tightSend, verbGain: 0.35, gain: 1,
			} ), 9 );

		}

		if ( p && p.point ) {

			const sp = acquire( p.point.x, p.point.y, p.point.z, 0.9 );
			addVoice( V.body( ctx.currentTime + sp.delay + 0.34, {
				dest: sp.dest, verb: n.verbSend, verbGain: sp.verbGain * 0.6, gain: 1.2,
			} ), 4 );

		}

	}

	function onEnemySpawned() {

		if ( ! ready() ) return;
		if ( ! gate( 'spawn', 1.1 ) ) return;

		const a = Math.random() * Math.PI * 2;
		const d = 16 + Math.random() * 20;
		const sp = acquire( st.lx + Math.cos( a ) * d, st.ly - 0.5, st.lz + Math.sin( a ) * d, 1.6 );
		addVoice( V.clang( ctx.currentTime + sp.delay, {
			dest: sp.dest, verb: n.verbSend, verbGain: sp.verbGain, gain: 2.2,
		} ), 2 );

	}

	function onFootstep( p ) {

		if ( ! ready() || ! p ) return;
		if ( ! gate( 'step', 0.07 ) ) return;

		const surface = STEP_SURFACES[ p.surface ] ? p.surface : 'concrete';
		const play = V.steps[ surface ];
		const sprint = p.sprinting ? 1 : 0;

		const dist = p.position ? distanceTo( p.position.x, p.position.y, p.position.z ) : 0;

		if ( dist > 2.2 && p.position ) {

			const sp = acquire( p.position.x, p.position.y, p.position.z, 0.35 );
			addVoice( play( ctx.currentTime + sp.delay, {
				dest: sp.dest, verb: n.verbSend, verbGain: sp.verbGain * 0.35, sprint, gain: 1.3,
			} ), 3 );

		} else {

			addVoice( play( ctx.currentTime, {
				dest: n.sfxBus, verb: n.verbSend, verbGain: 0.18, sprint, gain: 0.85,
			} ), 3 );

		}

	}

	function onLand( p ) {

		if ( ! ready() ) return;
		const surface = p && STEP_SURFACES[ p.surface ] ? p.surface : 'concrete';
		const impact = clamp( p && p.impact01 !== undefined ? p.impact01 : 0.5, 0, 1 );
		addVoice( V.lands[ surface ]( ctx.currentTime, {
			dest: n.sfxBus, verb: n.verbSend, verbGain: 0.22, impact, gain: 0.7,
		} ), 6 );
		if ( impact > 0.7 ) duckAmbience( 0.3 );

	}

	function onJump() {

		if ( ! ready() ) return;
		if ( ! gate( 'jump', 0.15 ) ) return;
		addVoice( V.jump( ctx.currentTime, { dest: n.sfxBus, verb: n.verbSend, verbGain: 0.15 } ), 3 );

	}

	function onDamaged( p ) {

		if ( ! ready() || ! p ) return;

		const amount = p.amount || 0;
		const maxH = p.maxHealth || 100;
		setHealth( ( p.health === undefined ? st.health01 * maxH : p.health ) / maxH );

		if ( gate( 'damage', 0.09 ) ) {

			addVoice( V.damage( ctx.currentTime, {
				dest: n.sfxBus, verb: n.verbSend, verbGain: 0.3,
				amount: clamp( amount / 35, 0.15, 1 ),
			} ), 9 );

		}

		// Incoming fire from `dirWorld`: a whizby past the ear plus the distant
		// report of the weapon that fired it. The direction vector is the only
		// positional information the contract gives us for hostile fire.
		if ( p.dirWorld && gate( 'incoming', 0.12 ) ) {

			const dx = p.dirWorld.x || 0, dy = p.dirWorld.y || 0, dz = p.dirWorld.z || 0;
			const len = Math.sqrt( dx * dx + dy * dy + dz * dz ) || 1;
			const ux = dx / len, uy = dy / len, uz = dz / len;

			// dirWorld points from the shooter toward the player; walk back along it
			const range = 14 + Math.random() * 16;
			const sx = st.lx - ux * range;
			const sy = st.ly - uy * range + 0.2;
			const sz = st.lz - uz * range;

			addVoice( V.whizby( ctx.currentTime, {
				dest: n.sfxBus, verb: n.verbSend, verbGain: 0.2,
				close: 0.75, side: ux >= 0 ? 1 : - 1, gain: 0.9,
			} ), 6 );

			const sp = acquire( sx, sy, sz, 1.0 );
			addVoice( V.guns.HOSTILE( ctx.currentTime + sp.delay, {
				dest: sp.dest, tail: n.tailSend, verb: n.verbSend,
				gain: 1.6, tailGain: sp.tailGain, verbGain: sp.verbGain, lite: st.perfScale < 1,
			} ), 7 );

		}

		st.suppress += amount / 55;
		if ( amount > 24 ) triggerTinnitus( clamp( amount / 55, 0.35, 1 ) );
		duckAmbience( 0.5 );

	}

	function onHealed( p ) {

		if ( ! ready() || ! p ) return;
		setHealth( ( p.health || 0 ) / 100 );

	}

	function onDied() {

		if ( ! ready() ) return;
		st.dead = true;
		st.health01 = 0;
		st.waveIntensity = 0;
		st.threat = 0;
		st.intensity = 0;
		triggerTinnitus( 1 );
		addVoice( V.ui.death( ctx.currentTime + 0.05, {
			dest: n.uiGain, verb: n.verbSend, verbGain: 0.7, gain: 1,
		} ), 10 );
		duckAmbience( 2.5 );

	}

	function onGameOver() {

		if ( ! ready() ) return;
		st.inGame = false;
		st.waveIntensity = 0;
		st.threat = 0;
		if ( ! st.dead ) {

			addVoice( V.ui.death( ctx.currentTime, { dest: n.uiGain, verb: n.verbSend, verbGain: 0.6 } ), 10 );

		}

	}

	function onWaveStart( p ) {

		if ( ! ready() ) return;
		st.dead = false;
		const wave = ( p && p.wave ) || 1;
		st.waveIntensity = clamp( 0.42 + wave * 0.06, 0, 0.92 );
		addVoice( V.ui.waveStart( ctx.currentTime + 0.02, {
			dest: n.uiGain, verb: n.verbSend, verbGain: 0.5, gain: 1,
		} ), 10 );
		duckAmbience( 1.4 );

	}

	function onWaveClear() {

		if ( ! ready() ) return;
		st.waveIntensity = 0;
		st.threat = 0;
		addVoice( V.ui.waveClear( ctx.currentTime + 0.05, {
			dest: n.uiGain, verb: n.verbSend, verbGain: 0.45, gain: 1,
		} ), 10 );

	}

	function onRadar( p ) {

		if ( ! ready() || ! p || ! p.list || ! p.player ) return;

		let nearest = Infinity;
		for ( let i = 0; i < p.list.length; i ++ ) {

			const e = p.list[ i ];
			if ( ! e || ! e.alive ) continue;
			const dx = e.x - p.player.x, dz = e.z - p.player.z;
			const d = Math.sqrt( dx * dx + dz * dz );
			if ( d < nearest ) nearest = d;

		}

		st.threat = nearest === Infinity ? 0 : clamp( 1 - ( nearest - 5 ) / 30, 0, 1 );

	}

	function onScore() {

		if ( ! ready() ) return;
		if ( ! gate( 'score', 0.09 ) ) return;
		addVoice( V.ui.score( ctx.currentTime, { dest: n.uiGain, gain: 0.7 } ), 4 );

	}

	function onToast() {

		if ( ! ready() ) return;
		if ( ! gate( 'toast', 0.15 ) ) return;
		addVoice( V.ui.toast( ctx.currentTime, { dest: n.uiGain, gain: 0.8 } ), 5 );

	}

	function onShake( p ) {

		if ( ! ready() ) return;
		const amount = ( p && p.amount ) || 0;
		if ( amount < 0.45 ) return;
		if ( ! gate( 'rumble', 0.5 ) ) return;
		addVoice( V.rumble( ctx.currentTime, { dest: n.sfxBus, amount: clamp( amount, 0, 1 ) } ), 3 );

	}

	function onPerf( p ) {

		if ( ! ready() || ! p ) return;
		const fps = p.fps || 60;

		if ( fps < 42 ) { st.lowFps ++; st.highFps = 0; } else if ( fps > 56 ) { st.highFps ++; st.lowFps = 0; } else { st.lowFps = 0; st.highFps = 0; }

		if ( st.lowFps >= 4 && st.perfScale === 1 ) {

			st.perfScale = 0.6;
			st.maxVoices = MAX_VOICES_LOW;
			n.tightReturn.gain.setTargetAtTime( 0, ctx.currentTime, 0.2 );

		} else if ( st.highFps >= 6 && st.perfScale < 1 ) {

			st.perfScale = 1;
			st.maxVoices = MAX_VOICES;
			n.tightReturn.gain.setTargetAtTime( 0.5, ctx.currentTime, 0.2 );

		}

	}

	function onGameStart() {

		unlock();
		if ( ! built ) return;
		st.inGame = true;
		st.dead = false;
		st.health01 = 1;
		st.suppress = 0;
		st.waveIntensity = 0;
		st.threat = 0;
		st.equippedOnce = false;
		startBeds();
		if ( ready() ) {

			addVoice( V.ui.open( ctx.currentTime, { dest: n.uiGain, gain: 0.7 } ), 8 );

		}

	}

	function onPause() {

		if ( ! ready() ) return;
		st.paused = true;
		addVoice( V.ui.open( ctx.currentTime, { dest: n.uiGain, gain: 0.6 } ), 8 );

	}

	function onResume() {

		if ( ! ready() ) return;
		st.paused = false;
		addVoice( V.ui.close( ctx.currentTime, { dest: n.uiGain, gain: 0.6 } ), 8 );

	}

	function startBeds() {

		if ( ! built ) return;
		const now = ctx.currentTime;
		ambience.start( now + 0.05 );
		music.start( now + 0.05 );
		st.ambNext.clang = now + 6 + Math.random() * 12;
		st.ambNext.gull = now + 3 + Math.random() * 9;
		st.ambNext.creak = now + 8 + Math.random() * 14;
		st.ambNext.boom = now + 12 + Math.random() * 20;
		st.musicNext = now + 0.2;
		st.heartNext = now + 1;

	}

	// ------------------------------------------------------------------
	// Per-frame schedulers
	// ------------------------------------------------------------------

	function scheduleAmbience( now ) {

		const A = st.ambNext;
		const horizon = now + 0.3;
		const busy = st.perfScale < 1;

		if ( A.clang <= horizon ) {

			const a = Math.random() * Math.PI * 2;
			const d = 14 + Math.random() * 22;
			const sp = acquire( st.lx + Math.cos( a ) * d, st.ly + Math.random() * 4 - 1, st.lz + Math.sin( a ) * d, 2.2 );
			addVoice( V.clang( A.clang + sp.delay, {
				dest: sp.dest, verb: n.verbSend, verbGain: sp.verbGain * 1.1, gain: 2.0,
			} ), 2 );
			A.clang = now + ( busy ? 22 : 11 ) + Math.random() * 26;

		}

		if ( A.gull <= horizon ) {

			const a = Math.random() * Math.PI * 2;
			const d = 18 + Math.random() * 24;
			const sp = acquire( st.lx + Math.cos( a ) * d, st.ly + 6 + Math.random() * 10, st.lz + Math.sin( a ) * d, 1.6 );
			addVoice( V.gull( A.gull + sp.delay, {
				dest: sp.dest, verb: n.verbSend, verbGain: sp.verbGain * 0.9, gain: 2.2,
			} ), 1 );
			A.gull = now + ( busy ? 20 : 9 ) + Math.random() * 22;

		}

		if ( A.creak <= horizon ) {

			const a = Math.random() * Math.PI * 2;
			const d = 8 + Math.random() * 16;
			const sp = acquire( st.lx + Math.cos( a ) * d, st.ly + Math.random() * 5, st.lz + Math.sin( a ) * d, 2.0 );
			addVoice( V.creak( A.creak + sp.delay, {
				dest: sp.dest, verb: n.verbSend, verbGain: sp.verbGain, gain: 1.8,
			} ), 1 );
			A.creak = now + ( busy ? 26 : 14 ) + Math.random() * 30;

		}

		if ( A.boom <= horizon ) {

			// Deliberately far: the point is that it is filtered, reverberant and
			// late, not that it is loud.
			const a = Math.random() * Math.PI * 2;
			const d = 55 + Math.random() * 45;
			const sp = acquire( st.lx + Math.cos( a ) * d, st.ly, st.lz + Math.sin( a ) * d, 1.8 );
			addVoice( V.boom( A.boom + sp.delay, {
				dest: sp.dest, verb: n.verbSend, verbGain: sp.verbGain * 2.4, gain: 5,
			} ), 1 );
			A.boom = now + ( busy ? 40 : 20 ) + Math.random() * 34;

		}

	}

	function scheduleMusic( now ) {

		const stepDur = 60 / music.bpm / 2;
		if ( st.musicNext < now - 0.6 ) st.musicNext = now;   // resync after a stall

		const audible = st.intensity > 0.28 && settings.musicVolume > 0.001 && ! st.paused;

		while ( st.musicNext < now + 0.3 ) {

			if ( audible ) {

				const i = st.musicStep % 16;
				// accent the downbeat, thin out the off-beats
				const vel = ( i % 4 === 0 ) ? 1 : ( i % 2 === 0 ? 0.62 : 0.34 );
				if ( i % 2 === 0 || st.intensity > 0.7 ) {

					addVoice( music.step( st.musicNext, st.musicStep, vel * st.intensity ), 4 );

				}

			}

			st.musicStep ++;
			st.musicNext += stepDur;

		}

	}

	function scheduleHeartbeat( now ) {

		if ( st.dead || st.health01 > 0.42 || ! st.inGame || st.paused ) {

			st.heartNext = Math.max( st.heartNext, now + 0.4 );
			return;

		}

		if ( st.heartNext > now + 0.3 ) return;

		const urgency = clamp( ( 0.42 - st.health01 ) / 0.42, 0, 1 );
		const period = lerp( 1.05, 0.5, urgency );
		const at = Math.max( st.heartNext, now );

		addVoice( V.ui.heartbeat( at, {
			dest: n.uiGain, gain: 0.55 + urgency * 0.5, intensity: urgency,
		} ), 7 );

		st.heartNext = at + period;

	}

	// ------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------

	function ready() {

		return built && ctx !== null && ctx.state === 'running';

	}

	let autoUnlockArmed = false;
	const autoUnlockEvents = [ 'pointerdown', 'mousedown', 'keydown', 'touchstart' ];

	function autoUnlockHandler() { unlock(); }

	function armAutoUnlock() {

		if ( autoUnlockArmed || typeof window === 'undefined' ) return;
		autoUnlockArmed = true;
		for ( let i = 0; i < autoUnlockEvents.length; i ++ ) {

			window.addEventListener( autoUnlockEvents[ i ], autoUnlockHandler, { passive: true } );

		}

	}

	function disarmAutoUnlock() {

		if ( ! autoUnlockArmed || typeof window === 'undefined' ) return;
		autoUnlockArmed = false;
		for ( let i = 0; i < autoUnlockEvents.length; i ++ ) {

			window.removeEventListener( autoUnlockEvents[ i ], autoUnlockHandler );

		}

	}

	/**
	 * Create the context (first call) and resume it. Safe to call from any user
	 * gesture, and safe to call repeatedly.
	 */
	function unlock() {

		try {

			build();
			if ( ! ctx ) return;

			if ( ctx.state !== 'running' && ctx.resume ) {

				ctx.resume().then( () => {

					if ( ctx.state === 'running' ) {

						disarmAutoUnlock();
						fadeInMaster();
						startBeds();

					}

				} ).catch( () => { /* still locked; the next gesture retries */ } );

			} else if ( ctx.state === 'running' ) {

				disarmAutoUnlock();
				fadeInMaster();
				startBeds();

			}

		} catch ( e ) {

			console.warn( '[audio] unlock failed', e );

		}

	}

	function fadeInMaster() {

		const now = ctx.currentTime;
		const target = Math.max( 0.0001, settings.masterVolume * st.volumeScale );
		const g = n.master.gain;
		g.cancelScheduledValues( now );
		g.setValueAtTime( Math.max( 0.0001, g.value ), now );
		g.exponentialRampToValueAtTime( target, now + 0.5 );
		st.cMaster = settings.masterVolume;

	}

	function applySettings( now ) {

		const m = settings.masterVolume * st.volumeScale;
		if ( Math.abs( m - st.cMaster * st.volumeScale ) > 0.001 || st.cMaster < 0 ) {

			st.cMaster = settings.masterVolume;
			n.master.gain.setTargetAtTime( Math.max( 0.0001, m ), now, 0.05 );

		}

		if ( Math.abs( settings.sfxVolume - st.cSfx ) > 0.001 ) {

			st.cSfx = settings.sfxVolume;
			n.sfxGain.gain.setTargetAtTime( st.cSfx, now, 0.05 );
			n.uiGain.gain.setTargetAtTime( st.cSfx * 0.9, now, 0.05 );
			n.ambGain.gain.setTargetAtTime( st.cSfx * 0.42, now, 0.15 );

		}

		if ( Math.abs( settings.musicVolume - st.cMusic ) > 0.001 ) {

			st.cMusic = settings.musicVolume;
			n.musicGain.gain.setTargetAtTime( st.cMusic * 0.45, now, 0.15 );

		}

	}

	/**
	 * @param {number} dt
	 * @param {{health?:number,maxHealth?:number}} [playerState] optional live
	 *        player snapshot; health drives the muffle/heartbeat if provided.
	 */
	function update( dt, playerState ) {

		if ( ! built || ! ctx || ctx.state !== 'running' ) return;

		const now = ctx.currentTime;

		updateListener();
		applySettings( now );

		if ( playerState && typeof playerState.health === 'number' ) {

			const maxH = playerState.maxHealth || 100;
			st.health01 = clamp( playerState.health / maxH, 0, 1 );

		}

		// --- suppression -> tinnitus ---------------------------------------
		st.suppress = Math.max( 0, st.suppress - dt * 0.55 );
		if ( st.suppress > 1 ) {

			triggerTinnitus( 0.45 );
			st.suppress = 0.3;

		}

		// --- ducking --------------------------------------------------------
		const ringing = now < st.ringUntil;
		const duckTarget = st.paused ? 0.3 : ( now < st.duckUntil ? 1 - st.duckStrength : 1 );
		if ( Math.abs( duckTarget - st.curDuck ) > 0.005 ) {

			st.curDuck = duckTarget;
			n.duck.gain.setTargetAtTime( duckTarget, now, duckTarget < 1 ? 0.03 : 0.18 );

		}

		if ( now >= st.duckUntil ) st.duckStrength = 0;

		const ambTarget = st.paused ? 0.35 : ( now < st.ambDuckUntil ? 0.62 : 1 );
		if ( Math.abs( ambTarget - st.curAmbDuck ) > 0.01 ) {

			st.curAmbDuck = ambTarget;
			n.ambDuck.gain.setTargetAtTime( ambTarget, now, ambTarget < 1 ? 0.05 : 0.5 );

		}

		// --- low-health / concussion muffle ------------------------------------
		let muffle = 20000;
		if ( st.health01 < 0.5 ) {

			// Interpolate in log-frequency with a smoothstep: linear Hz barely
			// changes the perceived brightness until it is almost at the floor.
			const t = clamp( ( 0.5 - st.health01 ) / 0.5, 0, 1 );
			const s = t * t * ( 3 - 2 * t );
			muffle = 20000 * Math.pow( 650 / 20000, s );

		}

		if ( st.dead ) muffle = Math.min( muffle, 420 );
		if ( ringing ) muffle = Math.min( muffle, 2800 );

		if ( Math.abs( muffle - st.curMuffle ) / Math.max( 1, st.curMuffle ) > 0.02 ) {

			st.curMuffle = muffle;
			n.sfxMuffle.frequency.setTargetAtTime( muffle, now, 0.25 );

		}

		// --- music intensity ---------------------------------------------------
		const target = st.dead || ! st.inGame ? 0 : Math.max( st.waveIntensity, st.threat * 0.85 );
		st.intensity += ( target - st.intensity ) * Math.min( 1, dt * ( target > st.intensity ? 0.6 : 0.35 ) );
		if ( st.intensity < 0.005 ) st.intensity = 0;

		// Only touch the bed when it actually moved: setIntensity schedules three
		// AudioParam events, and doing that 60x/second grows the timelines forever.
		const musTarget = st.paused ? st.intensity * 0.25 : st.intensity;
		if ( Math.abs( musTarget - st.curIntensity ) > 0.004 ) {

			st.curIntensity = musTarget;
			music.setIntensity( musTarget, now );

		}

		// --- schedulers ---------------------------------------------------------
		if ( ! st.paused ) scheduleAmbience( now );
		scheduleMusic( now );
		scheduleHeartbeat( now );

		// --- voice bookkeeping ---------------------------------------------------
		for ( let i = voices.length - 1; i >= 0; i -- ) {

			if ( voices[ i ].end <= now ) voices.splice( i, 1 );

		}

	}

	/** Extra master trim on top of `settings.masterVolume` (0..1+). */
	function setVolume( v ) {

		st.volumeScale = clamp( v, 0, 2 );
		if ( built && ctx ) n.master.gain.setTargetAtTime( Math.max( 0.0001, settings.masterVolume * st.volumeScale ), ctx.currentTime, 0.05 );

	}

	/** Swap the environment reverb. Buffers are pre-generated; this is free. */
	function setSpace( name ) {

		if ( ! built ) return;
		const buf = irs[ name ];
		if ( buf ) n.envConv.buffer = buf;

	}

	/** Emergency silence — used if the host wants a hard stop. */
	function panic() {

		if ( ! built ) return;
		const now = ctx.currentTime;
		for ( let i = 0; i < voices.length; i ++ ) stealVoice( voices[ i ] );
		voices.length = 0;
		n.master.gain.cancelScheduledValues( now );
		n.master.gain.setTargetAtTime( 0.0001, now, 0.03 );

	}

	// ------------------------------------------------------------------
	// Subscriptions — every relevant CONTRACT.md event
	// ------------------------------------------------------------------

	bus.on( 'game:start', onGameStart );
	bus.on( 'game:pause', onPause );
	bus.on( 'game:resume', onResume );
	bus.on( 'game:over', onGameOver );

	bus.on( 'wave:start', onWaveStart );
	bus.on( 'wave:clear', onWaveClear );

	bus.on( 'weapon:equipped', onEquipped );
	bus.on( 'weapon:fire', onFire );
	bus.on( 'weapon:dry', onDry );
	bus.on( 'weapon:reloadStart', onReloadStart );
	bus.on( 'weapon:reloadEnd', onReloadEnd );
	bus.on( 'weapon:ads', onAds );

	bus.on( 'hit:surface', onHitSurface );
	bus.on( 'hit:confirm', onHitConfirm );

	bus.on( 'enemy:killed', onEnemyKilled );
	bus.on( 'enemy:spawned', onEnemySpawned );

	bus.on( 'player:damaged', onDamaged );
	bus.on( 'player:healed', onHealed );
	bus.on( 'player:died', onDied );
	bus.on( 'player:footstep', onFootstep );
	bus.on( 'player:land', onLand );
	bus.on( 'player:jump', onJump );

	bus.on( 'score:add', onScore );
	bus.on( 'radar:enemies', onRadar );
	bus.on( 'perf:sample', onPerf );
	bus.on( 'camera:shake', onShake );
	bus.on( 'ui:toast', onToast );

	// Optional menu cues. The contract has no events for these (menus talk to
	// the game through hooks, not the bus), so they are wired both as opt-in
	// bus names and as direct methods on the returned object.
	const uiCue = ( name ) => () => {

		if ( ! ready() ) return;
		const fn = V.ui[ name ];
		if ( fn && gate( 'ui-' + name, 0.03 ) ) addVoice( fn( ctx.currentTime, { dest: n.uiGain } ), 8 );

	};

	const cueHover = uiCue( 'hover' );
	const cueClick = uiCue( 'click' );
	const cueBack = uiCue( 'back' );
	const cueOpen = uiCue( 'open' );
	const cueClose = uiCue( 'close' );

	bus.on( 'ui:hover', cueHover );
	bus.on( 'ui:click', cueClick );
	bus.on( 'ui:back', cueBack );
	bus.on( 'ui:open', cueOpen );
	bus.on( 'ui:close', cueClose );

	armAutoUnlock();

	return {

		unlock,
		update,
		setVolume,
		setSpace,
		panic,

		get ready() { return ready(); },
		get context() { return ctx; },
		get voiceCount() { return voices.length; },

		ui: {
			hover: cueHover,
			click: cueClick,
			back: cueBack,
			open: cueOpen,
			close: cueClose,
		},

	};

}

export default createAudio;
