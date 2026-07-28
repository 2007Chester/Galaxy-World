import * as THREE from 'three';

/**
 * Procedural golden-hour dusk sky.
 *
 * A single inverted sphere shaded by a analytic atmosphere model: horizon glow
 * biased toward the sun azimuth, a bloomable sun disc, a zenith falloff into
 * teal, and drifting fbm cloud banding. Nothing here is textured.
 *
 * The same shader also feeds `PMREMGenerator.fromScene()` so every PBR material
 * in the world gets image-based lighting that actually matches what you see —
 * that IBL is what stops the metal reading as flat grey.
 *
 * Render order: the sphere is opaque with depthWrite off and renderOrder 1000,
 * so it draws *after* the world geometry and early-Z rejects every pixel the
 * level already covers. The fbm therefore only runs on visible sky.
 */

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
	vec4 world = modelMatrix * vec4( position, 1.0 );
	vDir = world.xyz - cameraPosition;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const SKY_FRAG = /* glsl */`
precision highp float;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;
uniform vec3 uGroundColor;
uniform float uSunIntensity;
uniform float uCloudAmount;
uniform float uTime;
uniform float uEnvMode;        // 1.0 only while baking the PMREM
uniform vec3 uGroundBounce;

varying vec3 vDir;

float hash21( vec2 p ) {
	p = fract( p * vec2( 123.34, 456.21 ) );
	p += dot( p, p + 45.32 );
	return fract( p.x * p.y );
}

float vnoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	float a = hash21( i );
	float b = hash21( i + vec2( 1.0, 0.0 ) );
	float c = hash21( i + vec2( 0.0, 1.0 ) );
	float d = hash21( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}

float fbm( vec2 p ) {
	float v = 0.0;
	float a = 0.5;
	for ( int i = 0; i < 5; i ++ ) {
		v += a * vnoise( p );
		p = p * 2.03 + 17.1;
		a *= 0.5;
	}
	return v;
}

void main() {
	vec3 dir = normalize( vDir );
	float h = dir.y;

	// --- base gradient -----------------------------------------------------
	float up = clamp( ( h + 0.04 ) / 0.62, 0.0, 1.0 );
	vec3 col = mix( uHorizonColor, uZenithColor, pow( up, 0.68 ) );

	// hazy sea / ground haze below the horizon line
	col = mix( uGroundColor, col, smoothstep( -0.16, 0.004, h ) );

	// --- sun ---------------------------------------------------------------
	float cosA = dot( dir, uSunDir );
	float sunAzi = pow( max( 0.0, dot( normalize( vec3( dir.x, 0.0, dir.z ) ),
		normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) ) ) ), 2.4 );

	// warm bloom hugging the horizon on the sun's side
	col += uHorizonColor * sunAzi * exp( - max( h, 0.0 ) * 5.5 ) * 0.65;

	float glow = pow( max( cosA, 0.0 ), 420.0 ) * 0.85
		+ pow( max( cosA, 0.0 ), 34.0 ) * 0.30
		+ pow( max( cosA, 0.0 ), 7.0 ) * 0.10;
	col += uSunColor * glow * uSunIntensity;

	// the disc itself is pushed well over 1.0 so bloom picks it up
	float disc = smoothstep( 0.99930, 0.99972, cosA );
	col += uSunColor * disc * uSunIntensity * 26.0;

	// --- clouds ------------------------------------------------------------
	if ( h > -0.02 ) {
		vec2 cp = dir.xz / ( abs( h ) + 0.20 );
		float drift = uTime * 0.011;
		float n = fbm( cp * 0.80 + vec2( drift, drift * 0.35 ) );
		float band = fbm( vec2( cp.x * 0.30 + drift * 0.55, cp.y * 2.4 ) );
		float cloud = smoothstep( 0.44, 0.88, n * 0.66 + band * 0.48 );
		cloud *= smoothstep( 0.0, 0.19, h ) * uCloudAmount;

		vec3 cloudDark = uZenithColor * 0.62 + uGroundColor * 0.16;
		vec3 cloudLit = uSunColor * ( 0.42 + 1.15 * sunAzi );
		vec3 cloudCol = mix( cloudDark, cloudLit, pow( sunAzi, 1.5 ) * 0.9 + 0.08 );
		col = mix( col, cloudCol, cloud * 0.82 );
	}

	// --- ground bounce, IBL only -------------------------------------------
	// The visible sky's lower hemisphere is a dark sea haze, which is right to
	// look at but leaves every downward-facing and shadow-side normal with
	// almost no irradiance — that is what turned the containers into black
	// silhouettes. For the PMREM bake only, swap the ground half for a warm
	// bounce lobe (sunlit asphalt kicking light back up), brightest toward the
	// sun azimuth. Costs nothing at runtime: uEnvMode is 0 for the drawn sky.
	if ( uEnvMode > 0.5 ) {
		float down = smoothstep( 0.06, - 0.45, h );
		vec3 bounce = uGroundBounce * ( 0.62 + 0.90 * sunAzi );
		col = mix( col, bounce, down );
		// Lift the upper dome so sky fill actually reaches verticals facing away
		// from the key. Pulled 45% toward the horizon colour: lifting with the
		// raw zenith turned every up-facing surface in the level moonlight blue.
		col += mix( uZenithColor, uHorizonColor, 0.45 ) * 0.52 * smoothstep( - 0.05, 0.45, h );
	}

	// break up the gradient banding before the grade pass quantises it
	col += ( hash21( gl_FragCoord.xy ) - 0.5 ) * 0.0035;

	gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );
}
`;

// Palette keys for the golden-hour ramp. t = 0 is sun-on-the-deck, t = 1 is a
// higher, cooler late afternoon.
const PALETTE = {
	horizonLow: 0xff8a3c, horizonHigh: 0xffc79a,
	zenithLow: 0x1d3550, zenithHigh: 0x3f6d95,
	groundLow: 0x2b2a2e, groundHigh: 0x4a4a4c,
	sunLow: 0xff9642, sunHigh: 0xfff0d2,
};

// Effective albedo of the ground bounce lobe injected into the IBL bake.
const BOUNCE_ALBEDO = 0.26;

const _cA = new THREE.Color();
const _cB = new THREE.Color();

function ramp( target, loHex, hiHex, t ) {
	_cA.setHex( loHex );
	_cB.setHex( hiHex );
	target.copy( _cA ).lerp( _cB, t );
	return target;
}

/**
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} [renderer] pass it to build the env map immediately
 */
export function createSky( scene, renderer = null ) {

	const uniforms = {
		uSunDir: { value: new THREE.Vector3( - 0.716, 0.240, 0.655 ) },
		uSunColor: { value: new THREE.Color( PALETTE.sunLow ) },
		uHorizonColor: { value: new THREE.Color( PALETTE.horizonLow ) },
		uZenithColor: { value: new THREE.Color( PALETTE.zenithLow ) },
		uGroundColor: { value: new THREE.Color( PALETTE.groundLow ) },
		uSunIntensity: { value: 1.0 },
		uCloudAmount: { value: 0.85 },
		uTime: { value: 0 },
		uEnvMode: { value: 0 },
		uGroundBounce: { value: new THREE.Color( 0x000000 ) },
	};

	const geometry = new THREE.SphereGeometry( 320, 40, 24 );
	const material = new THREE.ShaderMaterial( {
		uniforms,
		vertexShader: SKY_VERT,
		fragmentShader: SKY_FRAG,
		side: THREE.BackSide,
		depthWrite: false,
		fog: false,
	} );

	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = 'sky';
	mesh.frustumCulled = false;
	mesh.renderOrder = 1000; // draw last so early-Z kills the covered pixels
	scene.add( mesh );

	const sunDirection = uniforms.uSunDir.value;

	// azimuth chosen so the sun rakes in from the west-south-west: long shadows
	// stretch across the container yard and light spears through the roof gaps.
	const AZIMUTH = - 0.83;
	// 0.34 puts the sun at ~14deg: shadows run ~4x object height, which stripes
	// the yard into readable bands of amber and teal without blacking it out.
	let time = 0.34;
	let elapsed = 0;
	let envRT = null;

	function setTime( t ) {
		time = THREE.MathUtils.clamp( t, 0, 1 );

		const elevation = THREE.MathUtils.lerp( 0.10, 0.52, time ); // 5.7deg -> 30deg
		const ce = Math.cos( elevation );
		sunDirection.set( ce * Math.sin( AZIMUTH ), Math.sin( elevation ), ce * Math.cos( AZIMUTH ) );

		// the lower the sun, the more saturated and warm everything gets
		const warm = 1 - time;
		ramp( uniforms.uHorizonColor.value, PALETTE.horizonLow, PALETTE.horizonHigh, 1 - warm * 0.85 );
		ramp( uniforms.uZenithColor.value, PALETTE.zenithLow, PALETTE.zenithHigh, 1 - warm * 0.8 );
		ramp( uniforms.uGroundColor.value, PALETTE.groundLow, PALETTE.groundHigh, 1 - warm * 0.9 );
		ramp( uniforms.uSunColor.value, PALETTE.sunLow, PALETTE.sunHigh, 1 - warm * 0.9 );
		uniforms.uSunIntensity.value = THREE.MathUtils.lerp( 1.35, 2.1, time );

		// Ground bounce = sunlit warm concrete/asphalt. Tied to the sun colour so
		// it tracks the palette ramp, then scaled to a plausible albedo (~0.16)
		// times the amount of sky the ground can see.
		uniforms.uGroundBounce.value
			.copy( uniforms.uSunColor.value )
			.lerp( uniforms.uHorizonColor.value, 0.35 )
			.multiplyScalar( BOUNCE_ALBEDO );
	}

	setTime( time );

	/**
	 * Render the sky into a PMREM cube so `scene.environment` matches the
	 * visible atmosphere. Safe to call again after setTime().
	 */
	function generateEnvironment( r ) {
		if ( ! r ) return null;

		const pmrem = new THREE.PMREMGenerator( r );

		// A throwaway copy sharing the live uniforms, so the real mesh keeps its
		// depth/renderOrder tweaks and the world scene is untouched while the
		// cube camera runs.
		const proxyMat = new THREE.ShaderMaterial( {
			uniforms,
			vertexShader: SKY_VERT,
			fragmentShader: SKY_FRAG,
			side: THREE.BackSide,
			depthWrite: true,
			depthTest: false,
			fog: false,
		} );

		const proxyScene = new THREE.Scene();
		const proxy = new THREE.Mesh( geometry, proxyMat );
		proxy.frustumCulled = false;
		proxyScene.add( proxy );

		if ( envRT ) envRT.dispose();
		uniforms.uEnvMode.value = 1;
		envRT = pmrem.fromScene( proxyScene, 0.02, 1, 900 );
		uniforms.uEnvMode.value = 0;

		proxyMat.dispose();
		pmrem.dispose();

		api.envMap = envRT.texture;
		return envRT.texture;
	}

	function update( dt ) {
		elapsed += dt;
		uniforms.uTime.value = elapsed;
	}

	function dispose() {
		scene.remove( mesh );
		geometry.dispose();
		material.dispose();
		if ( envRT ) { envRT.dispose(); envRT = null; }
	}

	const api = {
		mesh,
		material,
		uniforms,
		sunDirection,
		envMap: null,
		get time() { return time; },
		setTime,
		generateEnvironment,
		update,
		dispose,
	};

	if ( renderer ) generateEnvironment( renderer );

	return api;
}

export default createSky;
