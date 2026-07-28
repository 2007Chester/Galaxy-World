import * as THREE from 'three';
import { bus } from './events.js';
import { settings, qualityPreset } from './settings.js';

/**
 * Engine owns the renderer, the two render layers (world + viewmodel), the
 * camera rig and the fixed-ish update loop. Everything else registers update
 * callbacks via engine.onUpdate().
 *
 * Camera rig hierarchy:
 *   cameraRig (yaw, position = player eye)  ->  cameraPitch  ->  camera
 * The player controller drives cameraRig.position + rig.rotation.y + pitch.rotation.x.
 * Engine layers recoil / shake / bob on top through additive offset nodes so
 * gameplay code and feedback code never fight over the same transform.
 */
class Engine {
	constructor() {
		this.canvas = null;
		this.renderer = null;
		this.scene = null;
		this.viewScene = null;
		this.camera = null;
		this.viewCamera = null;
		this.composer = null;
		this.clock = new THREE.Clock();
		this.elapsed = 0;
		this.frame = 0;
		this.dt = 0;
		this.running = false;
		this.paused = false;

		this._updates = [];
		this._lateUpdates = [];
		this._resizeHandlers = [];

		// additive camera feedback state
		this._shakeTrauma = 0;
		this._shakeDecay = 1.6;
		this._shakeSeed = Math.random() * 1000;
		this._recoilPos = new THREE.Vector3();
		this._recoilRot = new THREE.Euler();
		this._fovKick = 0;
		this._fovKickVel = 0;
		this._baseFov = settings.fov;
		this._targetFovScale = 1;
		this._fovScale = 1;

		this._fpsAccum = 0;
		this._fpsFrames = 0;
		this.fps = 0;
		this.frameMs = 0;
		this._perfSamples = [];
	}

	init( canvas ) {
		const q = qualityPreset();
		this.canvas = canvas;

		const renderer = new THREE.WebGLRenderer( {
			canvas,
			antialias: false, // handled by SMAA in post
			powerPreference: 'high-performance',
			stencil: false,
			depth: true,
		} );
		renderer.setPixelRatio( Math.min( window.devicePixelRatio, q.pixelRatioCap ) );
		renderer.setSize( window.innerWidth, window.innerHeight );
		renderer.shadowMap.enabled = q.shadowsEnabled;
		renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.0;
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.info.autoReset = false;
		this.renderer = renderer;

		this.maxAnisotropy = Math.min( q.anisotropy, renderer.capabilities.getMaxAnisotropy() );

		this.scene = new THREE.Scene();
		this.viewScene = new THREE.Scene();

		const aspect = window.innerWidth / window.innerHeight;
		this.camera = new THREE.PerspectiveCamera( settings.fov, aspect, 0.06, 400 );
		// Viewmodel camera: tight near plane + narrower FOV so the gun reads big
		// and never intersects world geometry.
		this.viewCamera = new THREE.PerspectiveCamera( 62, aspect, 0.004, 12 );

		// --- camera rig ---
		this.cameraRig = new THREE.Object3D();          // yaw + world position
		this.cameraPitch = new THREE.Object3D();        // pitch
		this.cameraShakeNode = new THREE.Object3D();    // additive shake
		this.cameraRecoilNode = new THREE.Object3D();   // additive recoil
		this.cameraRig.add( this.cameraPitch );
		this.cameraPitch.add( this.cameraShakeNode );
		this.cameraShakeNode.add( this.cameraRecoilNode );
		this.cameraRecoilNode.add( this.camera );
		this.scene.add( this.cameraRig );

		// Viewmodel root lives in viewScene, driven to mirror shake/recoil subtly.
		this.viewRoot = new THREE.Object3D();
		this.viewScene.add( this.viewRoot );
		this.viewScene.add( this.viewCamera );

		window.addEventListener( 'resize', () => this.resize() );

		bus.on( 'camera:shake', ( p ) => this.addShake( p?.amount ?? 0.2 ) );
		bus.on( 'camera:fovKick', ( p ) => this.addFovKick( p?.amount ?? 2 ) );

		return this;
	}

	setComposer( composer ) { this.composer = composer; }

	onUpdate( fn ) { this._updates.push( fn ); return fn; }
	onLateUpdate( fn ) { this._lateUpdates.push( fn ); return fn; }
	onResize( fn ) { this._resizeHandlers.push( fn ); return fn; }

	resize() {
		const w = window.innerWidth, h = window.innerHeight;
		const q = qualityPreset();
		this.renderer.setPixelRatio( Math.min( window.devicePixelRatio, q.pixelRatioCap ) );
		this.renderer.setSize( w, h );
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.viewCamera.aspect = w / h;
		this.viewCamera.updateProjectionMatrix();
		if ( this.composer ) this.composer.setSize( w, h );
		for ( const fn of this._resizeHandlers ) fn( w, h );
	}

	// ---- camera feedback API -------------------------------------------------

	addShake( amount ) {
		this._shakeTrauma = Math.min( 1, this._shakeTrauma + amount );
	}

	addFovKick( degrees ) {
		this._fovKickVel += degrees;
	}

	/** ADS / sprint FOV multiplier, smoothed. 1 = default. */
	setFovScale( scale ) { this._targetFovScale = scale; }

	/** Weapon recoil writes here every frame (already smoothed by the weapon). */
	setRecoilOffset( pitch, yaw, roll, kickZ ) {
		this._recoilRot.set( pitch, yaw, roll );
		this._recoilPos.set( 0, 0, kickZ );
	}

	_updateCameraFeedback( dt ) {
		// trauma-based shake: quadratic falloff feels punchier than linear
		this._shakeTrauma = Math.max( 0, this._shakeTrauma - this._shakeDecay * dt );
		const t = this._shakeTrauma * this._shakeTrauma;
		const time = this.elapsed;
		if ( t > 0.0001 ) {
			const n = ( a, b ) => Math.sin( time * a + this._shakeSeed * b ) * Math.sin( time * a * 1.7 + b * 3.1 );
			this.cameraShakeNode.rotation.set(
				n( 47, 1.0 ) * 0.030 * t,
				n( 39, 2.0 ) * 0.034 * t,
				n( 31, 3.0 ) * 0.050 * t,
			);
			this.cameraShakeNode.position.set(
				n( 53, 4.0 ) * 0.024 * t,
				n( 61, 5.0 ) * 0.022 * t,
				0,
			);
		} else if ( this.cameraShakeNode.position.lengthSq() > 0 ) {
			this.cameraShakeNode.rotation.set( 0, 0, 0 );
			this.cameraShakeNode.position.set( 0, 0, 0 );
		}

		this.cameraRecoilNode.rotation.copy( this._recoilRot );
		this.cameraRecoilNode.position.copy( this._recoilPos );

		// spring the FOV kick back to zero
		this._fovKick += this._fovKickVel * dt * 26;
		this._fovKickVel -= this._fovKickVel * Math.min( 1, dt * 18 );
		this._fovKick -= this._fovKick * Math.min( 1, dt * 12 );

		this._fovScale += ( this._targetFovScale - this._fovScale ) * Math.min( 1, dt * 13 );
		const fov = settings.fov * this._fovScale + this._fovKick;
		if ( Math.abs( this.camera.fov - fov ) > 0.001 ) {
			this.camera.fov = fov;
			this.camera.updateProjectionMatrix();
		}
	}

	start() {
		if ( this.running ) return;
		this.running = true;
		this.clock.start();
		const tick = () => {
			if ( ! this.running ) return;
			this._raf = requestAnimationFrame( tick );
			this._frame();
		};
		this._raf = requestAnimationFrame( tick );
	}

	stop() {
		this.running = false;
		if ( this._raf ) cancelAnimationFrame( this._raf );
	}

	_frame() {
		const t0 = performance.now();
		// clamp dt so alt-tab / breakpoints don't teleport the player
		const dt = Math.min( this.clock.getDelta(), 1 / 20 );
		this.dt = dt;
		this.elapsed += dt;
		this.frame ++;

		if ( ! this.paused ) {
			for ( let i = 0; i < this._updates.length; i ++ ) this._updates[ i ]( dt, this.elapsed );
			this._updateCameraFeedback( dt );
			for ( let i = 0; i < this._lateUpdates.length; i ++ ) this._lateUpdates[ i ]( dt, this.elapsed );
		}

		this.renderer.info.reset();
		if ( this.composer ) this.composer.render( dt );
		else {
			this.renderer.render( this.scene, this.camera );
			this.renderer.autoClear = false;
			this.renderer.clearDepth();
			this.renderer.render( this.viewScene, this.viewCamera );
			this.renderer.autoClear = true;
		}

		// perf accounting
		this.frameMs = performance.now() - t0;
		this._fpsAccum += dt;
		this._fpsFrames ++;
		if ( this._fpsAccum >= 0.4 ) {
			this.fps = this._fpsFrames / this._fpsAccum;
			this._fpsAccum = 0;
			this._fpsFrames = 0;
			bus.emit( 'perf:sample', {
				fps: this.fps,
				calls: this.renderer.info.render.calls,
				tris: this.renderer.info.render.triangles,
				frameMs: this.frameMs,
			} );
		}
	}
}

export const engine = new Engine();
export default engine;
