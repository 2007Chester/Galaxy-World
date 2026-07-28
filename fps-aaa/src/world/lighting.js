import * as THREE from 'three';
import { engine } from '../core/engine.js';
import { qualityPreset } from '../core/settings.js';

/**
 * Golden-hour lighting rig.
 *
 * Key   : one warm DirectionalLight locked to sky.sunDirection, with an ortho
 *         shadow frustum fitted to the 60x60 playable area rather than the
 *         whole world so 2048px actually buys us sharp contact shadows.
 * Fill  : HemisphereLight (cool sky above, warm bounced ground below) plus the
 *         PMREM environment generated from the sky shader. The hemisphere is
 *         deliberately weak — the env map does most of the ambient work, the
 *         hemisphere just keeps un-reflective surfaces from going flat.
 * Haze  : FogExp2 in a colour lifted straight out of the horizon so distant
 *         geometry dissolves into the sky instead of ending on a hard line.
 * Practicals: five sodium / emergency / fluorescent sources with noise-driven
 *         flicker. Exactly one (the yard floodlight) casts shadows. All five
 *         are created up front and never added or removed, because changing the
 *         light count at runtime forces every material in the scene to
 *         recompile and produces a visible hitch.
 *
 * Palette contract with the art direction: warm amber key (#ffb066) against
 * teal-slate shadow fill (#2a3d4d).
 */

const SUN_COLOR = 0xffb066;
// Desaturated on purpose. Fully saturated sky blue here turns every interior
// floor into moonlight; the teal in the shadows should come from the grade's
// split tone, not from painting the fill lights blue.
const SKY_FILL = 0x9fb4c4;
const GROUND_FILL = 0x7a5f45;
const FILL_COLOR = 0x8098b4;   // cool bounce from the anti-sun half of the dome

// Aerial perspective. FogExp2 only holds one colour, so `update()` swings it
// between these two based on where the camera is looking relative to the sun —
// warm into the light, cool away from it. That directional swing is what makes
// distant geometry separate instead of sitting at one flat value.
const FOG_WARM = 0xc9814a;
const FOG_COOL = 0x546b82;
const FOG_DENSITY = 0.0158;

const ENV_INTENSITY = 1.75;

// Half-extent of the ortho shadow frustum. The arena is 60x60, whose diagonal
// is ~85, so 43 covers every corner no matter where the sun azimuth ends up.
const SHADOW_EXTENT = 43;
const SHADOW_DISTANCE = 95;

/** Deterministic value-noise walk used for flicker; no allocation, no Math.random. */
function flickerNoise( t, seed ) {
	return (
		Math.sin( t * 11.3 + seed * 1.7 ) * 0.5 +
		Math.sin( t * 27.9 + seed * 4.1 ) * 0.28 +
		Math.sin( t * 61.7 + seed * 9.3 ) * 0.14 +
		Math.sin( t * 4.1 + seed * 2.3 ) * 0.35
	) / 1.27;
}

function hash1( n ) {
	const s = Math.sin( n * 127.1 ) * 43758.5453;
	return s - Math.floor( s );
}

// module scratch — update() must not allocate
const _v = new THREE.Vector3();
const _view = new THREE.Vector3();
const _sunFlat = new THREE.Vector3();
const _fogWarm = new THREE.Color( FOG_WARM );
const _fogCool = new THREE.Color( FOG_COOL );

/**
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {object} [sky] result of createSky(); supplies sunDirection + envMap
 */
export function setupLighting( scene, renderer, sky = null ) {

	const q = qualityPreset();

	// ---- environment + fog -------------------------------------------------

	let env = null;
	if ( sky ) {
		env = sky.envMap || sky.generateEnvironment( renderer );
	}
	if ( env ) {
		scene.environment = env;
		scene.environmentIntensity = ENV_INTENSITY;
	}

	scene.fog = new THREE.FogExp2( FOG_WARM, FOG_DENSITY );

	// ---- key light ---------------------------------------------------------

	const sun = new THREE.DirectionalLight( SUN_COLOR, 4.9 );
	sun.name = 'sun';
	sun.castShadow = q.shadowsEnabled;

	const target = new THREE.Object3D();
	target.position.set( 0, 1.4, 0 );
	scene.add( target );
	sun.target = target;

	const sc = sun.shadow.camera;
	sc.left = - SHADOW_EXTENT;
	sc.right = SHADOW_EXTENT;
	sc.top = SHADOW_EXTENT;
	sc.bottom = - SHADOW_EXTENT;
	sc.near = 20;
	sc.far = SHADOW_DISTANCE + 70;
	sc.updateProjectionMatrix();

	sun.shadow.mapSize.set( q.shadowMapSize, q.shadowMapSize );
	// 86m of frustum across 2048px is ~42mm per texel; these two values are
	// tuned together — bias kills the acne on the big flat slabs, normalBias
	// handles the grazing angles without visibly detaching contact shadows.
	sun.shadow.bias = - 0.00035;
	sun.shadow.normalBias = 0.032;
	sun.shadow.blurSamples = 8;
	scene.add( sun );

	const sunDir = sky ? sky.sunDirection : new THREE.Vector3( - 0.716, 0.240, 0.655 );

	function alignSun() {
		sun.position.copy( sunDir ).multiplyScalar( SHADOW_DISTANCE ).add( target.position );
		sun.updateMatrixWorld();

		// fill comes from the opposite azimuth, lifted to 35deg so it grazes
		// vertical faces the key never reaches
		_v.set( - sunDir.x, 0, - sunDir.z ).normalize();
		fill.position.set( _v.x * 45, 32, _v.z * 45 ).add( fillTarget.position );
		fill.updateMatrixWorld();

		// bounce comes from the same side but from below the horizon, standing in
		// for light returning off the sunlit deck
		bounce.position.set( sunDir.x * 30, - 16, sunDir.z * 30 ).add( fillTarget.position );
		bounce.updateMatrixWorld();
	}

	// ---- fill --------------------------------------------------------------
	// The hemisphere only lifts horizontal surfaces; a vertical wall facing away
	// from the key sees almost none of it. So there are two fills: the
	// hemisphere for up/down, and a directional from the anti-sun azimuth,
	// raked slightly downward, for shadow-side verticals. Neither casts.

	const hemi = new THREE.HemisphereLight( SKY_FILL, GROUND_FILL, 0.92 );
	hemi.position.set( 0, 20, 0 );
	scene.add( hemi );

	const fill = new THREE.DirectionalLight( FILL_COLOR, 1.20 );
	fill.name = 'skyFill';
	fill.castShadow = false;
	const fillTarget = new THREE.Object3D();
	fillTarget.position.set( 0, 1.6, 0 );
	scene.add( fillTarget );
	fill.target = fillTarget;
	scene.add( fill );

	// A second, weaker bounce from below-behind so container undersides and the
	// backs of stacks pick up warm ground return rather than going to zero.
	const bounce = new THREE.DirectionalLight( 0xb5794a, 0.30 );
	bounce.name = 'groundBounce';
	bounce.castShadow = false;
	bounce.target = fillTarget;
	scene.add( bounce );

	alignSun();

	// ---- practicals --------------------------------------------------------
	// Positions here are authored against map.js; every one of them has a
	// matching emissive lamp housing built in the level geometry.

	const practicals = [];

	function addPractical( light, cfg ) {
		light.userData.flicker = cfg;
		light.userData.baseIntensity = light.intensity;
		practicals.push( light );
		scene.add( light );
		return light;
	}

	// 1. Sodium wall pack over the warehouse loading bay
	const bayLamp = new THREE.PointLight( 0xffa23c, 26, 22, 2 );
	bayLamp.position.set( - 8.9, 5.3, - 13.5 );
	addPractical( bayLamp, { type: 'sodium', seed: 1.0, depth: 0.22 } );

	// 2. Yard floodlight on the mast — the only shadow caster besides the sun
	const flood = new THREE.SpotLight( 0xffb14a, 90, 30, 0.82, 0.55, 2 );
	flood.position.set( 13.0, 8.4, - 6.0 );
	const floodTarget = new THREE.Object3D();
	floodTarget.position.set( 12.0, 0, - 2.0 );
	scene.add( floodTarget );
	flood.target = floodTarget;
	flood.castShadow = q.shadowsEnabled;
	flood.shadow.mapSize.set( Math.min( 1024, q.shadowMapSize ), Math.min( 1024, q.shadowMapSize ) );
	flood.shadow.camera.near = 1.2;
	flood.shadow.camera.far = 32;
	flood.shadow.bias = - 0.0012;
	flood.shadow.normalBias = 0.03;
	addPractical( flood, { type: 'sodium', seed: 2.7, depth: 0.10 } );

	// 3. Sodium lamp deep inside the warehouse
	const innerLamp = new THREE.PointLight( 0xff9a30, 20, 19, 2 );
	innerLamp.position.set( - 19.0, 6.1, - 18.5 );
	addPractical( innerLamp, { type: 'sodium', seed: 5.3, depth: 0.28 } );

	// 4. Dying fluorescent tube by the stairs — hard stutter, cool white
	const tube = new THREE.PointLight( 0xbfe0ff, 11, 13, 2 );
	tube.position.set( - 19.5, 4.1, - 6.2 );
	addPractical( tube, { type: 'fluorescent', seed: 8.1, depth: 1.0 } );

	// 5. Emergency strobe on the crane base
	const strobe = new THREE.PointLight( 0xff2f18, 30, 17, 2 );
	strobe.position.set( 6.2, 5.1, - 14.2 );
	addPractical( strobe, { type: 'strobe', seed: 0.0, depth: 1.0, period: 1.35 } );

	// ---- runtime -----------------------------------------------------------

	let elapsed = 0;
	let fogMix = 0.5;

	function update( dt ) {
		elapsed += dt;

		// --- aerial perspective ---------------------------------------------
		// Swing the single fog colour toward warm when the camera looks into the
		// sun and cool when it looks away. Cheap stand-in for direction-dependent
		// in-scattering, and it is what stops everything past 25m sitting at one
		// value. Eased so a fast turn does not strobe the horizon.
		const cam = engine.camera;
		if ( cam && scene.fog ) {
			cam.getWorldDirection( _view );
			_view.y = 0;
			_sunFlat.set( sunDir.x, 0, sunDir.z );
			const lv = _view.length(), ls = _sunFlat.length();
			if ( lv > 1e-4 && ls > 1e-4 ) {
				const facing = ( _view.dot( _sunFlat ) / ( lv * ls ) ) * 0.5 + 0.5;
				fogMix += ( facing - fogMix ) * Math.min( 1, dt * 3.2 );
				scene.fog.color.copy( _fogCool ).lerp( _fogWarm, fogMix * fogMix );
			}
		}

		for ( let i = 0; i < practicals.length; i ++ ) {
			const light = practicals[ i ];
			const cfg = light.userData.flicker;
			const base = light.userData.baseIntensity;

			if ( cfg.type === 'sodium' ) {
				// slow arc wander with an occasional deeper dip
				const n = flickerNoise( elapsed * 0.9, cfg.seed );
				const dip = Math.max( 0, flickerNoise( elapsed * 0.31, cfg.seed + 3.3 ) ) ;
				light.intensity = base * ( 1 - cfg.depth * ( 0.5 + 0.5 * n ) * dip );
			} else if ( cfg.type === 'fluorescent' ) {
				// quantised stutter: mostly on, randomly gated off for a few frames
				const slot = Math.floor( elapsed * 17 );
				const r = hash1( slot + cfg.seed );
				const on = r > 0.24 ? 1 : ( r > 0.14 ? 0.35 : 0.02 );
				const buzz = 0.9 + 0.1 * Math.sin( elapsed * 120 );
				light.intensity = base * on * buzz;
			} else {
				// rotating beacon: a sharp lobe sweeping past
				const phase = ( elapsed % cfg.period ) / cfg.period;
				const lobe = Math.pow( Math.max( 0, Math.sin( phase * Math.PI * 2 ) ), 9 );
				light.intensity = base * lobe;
			}
		}
	}

	function setEnvironment( texture, intensity = ENV_INTENSITY ) {
		env = texture;
		scene.environment = texture;
		scene.environmentIntensity = intensity;
	}

	function dispose() {
		scene.remove( sun, hemi, fill, bounce, target, fillTarget, floodTarget );
		for ( const l of practicals ) scene.remove( l );
		sun.dispose();
		fill.dispose();
		bounce.dispose();
		for ( const l of practicals ) l.dispose();
	}

	return {
		sun,
		hemi,
		fill,
		bounce,
		env,
		lights: practicals,   // CONTRACT.md name
		practicals,           // art-direction name
		fog: scene.fog,
		alignSun,
		setEnvironment,
		update,
		dispose,
	};
}

export default setupLighting;
