import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { bus } from '../core/events.js';
import { qualityPreset } from '../core/settings.js';

/**
 * OVERPRESSURE post stack.
 *
 *   RenderPass(world)          HDR, linear, NoToneMapping
 *   RenderPass(viewmodel)      clear=false + clearDepth so the gun sits on top
 *                              of the world but still eats every effect below
 *   UnrealBloomPass            subtle, threshold high enough that only lamps,
 *                              muzzle flashes and the sun disc bloom
 *   GradePass                  ONE fragment shader doing: ACES tonemap,
 *                              lift/gamma/gain, teal/amber split tone,
 *                              saturation + contrast, radial chromatic
 *                              aberration, ADS radial blur, vignette, damage
 *                              vignette, hit flash, animated grain, sRGB encode
 *   SMAAPass                   antialiasing on the final LDR image
 *
 * The vendored SMAAPass carries its area/search LUTs as inline base64 data URIs
 * (verified — it has no dependency on the deleted examples/jsm/libs folder), so
 * no FXAA fallback is needed.
 *
 * Because the grade shader performs ACES itself, the renderer is switched to
 * NoToneMapping here; double-tonemapping would crush every highlight.
 */

const GradeShader = {

	name: 'OverpressureGrade',

	uniforms: {
		tDiffuse: { value: null },
		uTime: { value: 0 },
		uResolution: { value: new THREE.Vector2( 1, 1 ) },
		uAspect: { value: 1 },

		uExposure: { value: 1.02 },
		uSaturation: { value: 1.12 },
		uContrast: { value: 1.10 },
		uSCurve: { value: 0.16 },

		uLift: { value: new THREE.Vector3( - 0.012, - 0.004, 0.014 ) },
		uGamma: { value: new THREE.Vector3( 1.02, 1.00, 0.97 ) },
		uGain: { value: new THREE.Vector3( 1.03, 1.00, 0.97 ) },

		uShadowTint: { value: new THREE.Vector3( 0.72, 0.92, 1.18 ) },   // teal-slate
		uHighlightTint: { value: new THREE.Vector3( 1.14, 1.01, 0.84 ) }, // warm amber
		uSplit: { value: new THREE.Vector2( 0.38, 0.45 ) },

		uCA: { value: 1.0 },
		uGrain: { value: 0.018 },
		uVignette: { value: new THREE.Vector3( 0.28, 0.92, 0.58 ) }, // start, end, strength

		uDamage: { value: 0 },   // sustained low-health state, slow pulse
		uHurt: { value: 0 },     // sharp punch on taking a hit, ~0.35s decay
		uFlash: { value: 0 },
		uAdsBlur: { value: 0 },
	},

	vertexShader: /* glsl */`
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}
	`,

	fragmentShader: /* glsl */`
		precision highp float;

		uniform sampler2D tDiffuse;
		uniform float uTime;
		uniform vec2 uResolution;
		uniform float uAspect;

		uniform float uExposure;
		uniform float uSaturation;
		uniform float uContrast;
		uniform float uSCurve;

		uniform vec3 uLift;
		uniform vec3 uGamma;
		uniform vec3 uGain;

		uniform vec3 uShadowTint;
		uniform vec3 uHighlightTint;
		uniform vec2 uSplit;

		uniform float uCA;
		uniform float uGrain;
		uniform vec3 uVignette;

		uniform float uDamage;
		uniform float uHurt;
		uniform float uFlash;
		uniform float uAdsBlur;

		varying vec2 vUv;

		const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );

		// Stephen Hill's ACES fit, matching three.js ACESFilmicToneMapping so the
		// look is identical whether or not the composer is active.
		const mat3 ACES_IN = mat3(
			0.59719, 0.07600, 0.02840,
			0.35458, 0.90834, 0.13383,
			0.04823, 0.01566, 0.83777
		);
		const mat3 ACES_OUT = mat3(
			 1.60475, -0.10208, -0.00327,
			-0.53108,  1.10813, -0.07276,
			-0.07367, -0.00605,  1.07602
		);

		vec3 rrtOdtFit( vec3 v ) {
			vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
			vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
			return a / b;
		}

		vec3 acesFilmic( vec3 color ) {
			color *= 1.0 / 0.6;
			color = ACES_IN * color;
			color = rrtOdtFit( color );
			color = ACES_OUT * color;
			return clamp( color, 0.0, 1.0 );
		}

		vec3 linearToSRGB( vec3 c ) {
			return mix( c * 12.92, 1.055 * pow( max( c, vec3( 0.0 ) ), vec3( 0.41666 ) ) - 0.055,
				step( vec3( 0.0031308 ), c ) );
		}

		float hash12( vec2 p ) {
			vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
			p3 += dot( p3, p3.yzx + 33.33 );
			return fract( ( p3.x + p3.y ) * p3.z );
		}

		void main() {
			vec2 uv = vUv;
			vec2 dir = uv - 0.5;

			vec2 aspectDir = vec2( dir.x * uAspect, dir.y );
			float r2 = dot( aspectDir, aspectDir );
			float r = sqrt( r2 );

			// --- chromatic aberration: zero at the centre, grows with r^2 -----
			vec2 caOff = dir * uCA * ( 0.0005 + r2 * 0.0024 );

			vec3 col = vec3(
				texture2D( tDiffuse, uv + caOff ).r,
				texture2D( tDiffuse, uv ).g,
				texture2D( tDiffuse, uv - caOff ).b
			);

			// --- ADS radial smear (uniform branch, so it is free when idle) ---
			if ( uAdsBlur > 0.001 ) {
				float amt = uAdsBlur * ( 0.014 + r2 * 0.085 );
				vec3 acc = col;
				acc += texture2D( tDiffuse, 0.5 + dir * ( 1.0 - amt * 0.34 ) ).rgb;
				acc += texture2D( tDiffuse, 0.5 + dir * ( 1.0 - amt * 0.67 ) ).rgb;
				acc += texture2D( tDiffuse, 0.5 + dir * ( 1.0 - amt ) ).rgb;
				col = acc * 0.25;
			}

			// --- tonemap + display encode -------------------------------------
			col = acesFilmic( col * uExposure );
			col = linearToSRGB( col );

			// --- lift / gamma / gain ------------------------------------------
			col = clamp( col, 0.0, 1.0 );
			col = uGain * ( col + uLift * ( 1.0 - col ) );
			col = pow( max( col, vec3( 0.0 ) ), uGamma );

			// --- split toning: teal shadows against amber highlights ----------
			float luma = dot( col, LUMA );
			float shadowW = ( 1.0 - luma ) * ( 1.0 - luma );
			float highW = luma * luma;
			col = mix( col, col * uShadowTint, shadowW * uSplit.x );
			col = mix( col, col * uHighlightTint, highW * uSplit.y );

			// --- saturation + contrast ----------------------------------------
			luma = dot( col, LUMA );
			col = mix( vec3( luma ), col, uSaturation );
			col = ( col - 0.5 ) * uContrast + 0.5;
			col = clamp( col, 0.0, 1.0 );
			// soft filmic toe/shoulder so the contrast push does not hard-clip
			col = mix( col, col * col * ( 3.0 - 2.0 * col ), uSCurve );

			// --- vignette -------------------------------------------------------
			float vig = smoothstep( uVignette.x, uVignette.y, r );
			col *= 1.0 - vig * uVignette.z;

			// --- damage: strictly an EDGE treatment -----------------------------
			// A p=4 superellipse hugs all four edges evenly (a plain radius only
			// reaches the left and right sides at 16:9), and the squared
			// smoothstep leaves the centre ~55% of the frame untouched so cover,
			// floor and enemy silhouettes still separate at 20 HP.
			float hurtDrive = max( uDamage * ( 0.58 + 0.16 * sin( uTime * 1.9 ) ), uHurt );
			if ( hurtDrive > 0.002 ) {
				vec2 e2 = ( dir * 2.0 ) * ( dir * 2.0 );
				vec2 e4 = e2 * e2;
				float rr = sqrt( sqrt( e4.x + e4.y ) );
				float edge = smoothstep( 0.45, 1.05, rr );
				float amt = edge * edge * hurtDrive;

				// Crush green and blue rather than adding red. The scene is
				// already amber at dusk, so an additive red push is invisible
				// against it; suppressing the other two channels is what reads
				// as blood, and it darkens rather than brightens the edge.
				float g0 = dot( col, LUMA );
				vec3 hurt = vec3( g0 * 1.10 + col.r * 0.30, g0 * 0.26, g0 * 0.22 );
				hurt *= 1.0 - 0.42 * amt;
				col = mix( col, hurt, min( amt, 0.78 ) );
			}

			// --- hit confirm flash ---------------------------------------------
			col += vec3( 1.0, 0.97, 0.92 ) * uFlash;

			// --- grain ----------------------------------------------------------
			// One cell per device pixel (gl_FragCoord, not uv * uResolution, which
			// quantised to CSS pixels and read as compression blocking), held for
			// 1/24s so it flickers like film rather than video, and rolled off
			// quadratically with brightness so the sky stays clean.
			vec2 gseed = floor( uTime * 24.0 ) * vec2( 17.13, 31.77 );
			float g = hash12( gl_FragCoord.xy + gseed ) - 0.5;
			float shade = 1.0 - dot( col, LUMA );
			col += g * uGrain * ( 0.10 + shade * shade * 1.10 );

			gl_FragColor = vec4( clamp( col, 0.0, 1.0 ), 1.0 );
		}
	`,
};

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene       world scene
 * @param {THREE.Camera} camera     world camera
 * @param {THREE.Scene} viewScene   viewmodel scene
 * @param {THREE.Camera} viewCamera viewmodel camera
 */
export function createPostFX( renderer, scene, camera, viewScene, viewCamera ) {

	const q = qualityPreset();

	// The grade shader owns tonemapping from here on.
	renderer.toneMapping = THREE.NoToneMapping;
	renderer.toneMappingExposure = 1.0;

	const size = renderer.getSize( new THREE.Vector2() );
	let width = size.width;
	let height = size.height;

	const composer = new EffectComposer( renderer );
	composer.setPixelRatio( renderer.getPixelRatio() );

	const worldPass = new RenderPass( scene, camera );
	composer.addPass( worldPass );

	// Viewmodel on top: keep the colour buffer, wipe only depth so the gun can
	// never intersect level geometry but still receives bloom + grade + grain.
	const viewPass = new RenderPass( viewScene, viewCamera );
	viewPass.clear = false;
	viewPass.clearDepth = true;
	composer.addPass( viewPass );

	const bloom = new UnrealBloomPass( new THREE.Vector2( width, height ), 0.42, 0.5, 0.85 );
	bloom.enabled = q.bloom;
	composer.addPass( bloom );

	const grade = new ShaderPass( GradeShader );
	const u = grade.uniforms;
	composer.addPass( grade );

	const smaa = new SMAAPass( width * renderer.getPixelRatio(), height * renderer.getPixelRatio() );
	composer.addPass( smaa );

	// ---- state -------------------------------------------------------------

	let elapsed = 0;
	let low = 0;             // sustained low-health edge, eased
	let lowTarget = 0;
	let hurt = 0;            // per-hit punch, fast attack / ~0.35s decay
	let flash = 0;
	let adsTarget = 0;
	let ads = 0;
	let baseGrain = 0.018;

	function applyResolution() {
		u.uResolution.value.set( width, height );
		u.uAspect.value = width / Math.max( 1, height );
	}
	applyResolution();

	function setSize( w, h ) {
		width = w;
		height = h;
		// setPixelRatio picks up monitor/zoom changes; setSize then propagates the
		// effective resolution to every pass, including bloom's mip chain.
		composer.setPixelRatio( renderer.getPixelRatio() );
		composer.setSize( w, h );
		applyResolution();
	}

	// The engine already forwards resize to composer.setSize, but it cannot know
	// about device-pixel-ratio changes (monitor swap, browser zoom), so track
	// those here too. setSize is idempotent.
	const onWindowResize = () => setSize( window.innerWidth, window.innerHeight );
	window.addEventListener( 'resize', onWindowResize );

	// ---- gameplay hooks ----------------------------------------------------

	/**
	 * Sustained low-health state. Takes raw "damage taken" 0..1 (i.e.
	 * 1 - health/max) and shapes it so nothing shows above ~60% health; the
	 * HUD draws its own red edge in the DOM and the two have to compose.
	 */
	function setDamage( v01 ) {
		lowTarget = THREE.MathUtils.smoothstep( THREE.MathUtils.clamp( v01, 0, 1 ), 0.40, 0.95 );
	}

	/** Short sharp punch when the player is hit. Independent of health. */
	function pulseHurt( strength = 0.55 ) {
		hurt = Math.min( 0.9, hurt + strength );
	}

	function pulseHit( strength = 0.05 ) {
		flash = Math.min( 0.16, flash + strength );
	}

	function setAdsBlur( v01 ) {
		adsTarget = THREE.MathUtils.clamp( v01, 0, 1 );
	}

	const offDamaged = bus.on( 'player:damaged', ( p ) => {
		if ( ! p ) return;
		const max = p.maxHealth || 100;
		const health = p.health !== undefined ? p.health : max;
		setDamage( 1 - health / max );
		// the punch is a separate, short-lived channel — summing it into the
		// sustained state is what produced the full-screen red flood
		pulseHurt( THREE.MathUtils.clamp( 0.28 + ( p.amount || 10 ) / 55, 0, 0.9 ) );
	} );

	const offHealed = bus.on( 'player:healed', ( p ) => {
		if ( ! p ) return;
		setDamage( 1 - ( p.health || 100 ) / ( p.maxHealth || 100 ) );
	} );

	const offDied = bus.on( 'player:died', () => setDamage( 1 ) );

	const offConfirm = bus.on( 'hit:confirm', ( p ) => {
		pulseHit( p && p.headshot ? 0.09 : ( p && p.killed ? 0.08 : 0.05 ) );
	} );

	const offAds = bus.on( 'weapon:ads', ( p ) => setAdsBlur( p && p.active ? 1 : 0 ) );

	// ---- frame -------------------------------------------------------------

	function update( dt ) {
		elapsed += dt;
		u.uTime.value = elapsed;

		// low health eases in and out slowly; it is a state, not an event
		low += ( lowTarget - low ) * Math.min( 1, dt * 2.0 );
		u.uDamage.value = low;

		// ln(20)/0.35s: the punch is gone in about a third of a second
		hurt -= hurt * Math.min( 1, dt * 8.6 );
		if ( hurt < 0.002 ) hurt = 0;
		u.uHurt.value = hurt;

		flash -= flash * Math.min( 1, dt * 13 );
		if ( flash < 0.0005 ) flash = 0;
		u.uFlash.value = flash;

		ads += ( adsTarget - ads ) * Math.min( 1, dt * 12 );
		u.uAdsBlur.value = ads;

		// grain creeps up as the player bleeds out — cheap tension
		u.uGrain.value = baseGrain * ( 1 + low * 0.8 );
	}

	// ---- quality -----------------------------------------------------------

	function setQuality( name ) {
		const preset = { low: 0, medium: 1, high: 2 }[ name ];
		const level = preset === undefined ? 2 : preset;

		bloom.enabled = level >= 1;
		smaa.enabled = level >= 1;
		baseGrain = level === 0 ? 0.010 : 0.018;
		u.uCA.value = level >= 2 ? 1.0 : 0.45;
		u.uSCurve.value = level >= 1 ? 0.16 : 0.10;
	}

	function dispose() {
		window.removeEventListener( 'resize', onWindowResize );
		offDamaged(); offHealed(); offDied(); offConfirm(); offAds();
		bloom.dispose();
		smaa.dispose();
		grade.dispose();
		composer.dispose();
	}

	return {
		composer,
		passes: { world: worldPass, view: viewPass, bloom, grade, smaa },
		uniforms: u,
		setSize,
		update,
		setDamage,
		pulseHurt,
		pulseHit,
		setAdsBlur,
		setQuality,
		dispose,
	};
}

export default createPostFX;
