import * as THREE from 'three';
import { engine } from './core/engine.js';
import { input } from './core/input.js';
import { bus } from './core/events.js';
import { settings, saveSettings, qualityPreset } from './core/settings.js';

/**
 * Bootstrap + integration layer.
 *
 * Modules are loaded with dynamic import and individually guarded: a subsystem
 * that fails to load degrades to a no-op stub instead of taking the whole game
 * down. That keeps the build bootable while parallel workstreams land.
 */

const boot = {
	errors: [],
	loaded: [],
};

async function tryImport( path, label ) {
	try {
		const m = await import( path );
		boot.loaded.push( label );
		return m;
	} catch ( e ) {
		console.error( `[boot] failed to load ${label} (${path})`, e );
		boot.errors.push( { label, path, message: String( e && e.message || e ) } );
		return null;
	}
}

const noop = () => {};
const stub = ( extra = {} ) => ( { update: noop, ...extra } );

// --------------------------------------------------------------------------

const game = {
	state: 'loading', // loading | menu | playing | paused | dead
	stats: { kills: 0, headshots: 0, shots: 0, hits: 0, wave: 0, score: 0, startedAt: 0, timeAlive: 0 },
	world: null,
	player: null,
	weapons: null,
	enemies: null,
	vfx: null,
	audio: null,
	hud: null,
	menu: null,
	minimap: null,
	postfx: null,
};

window.__game = game;

// --------------------------------------------------------------------------

function showFatal( message, detail ) {
	const el = document.createElement( 'div' );
	el.style.cssText = `position:fixed;inset:0;display:grid;place-items:center;background:#0b0e11;color:#e8eef2;
		font:14px/1.6 ui-monospace,Menlo,monospace;padding:40px;text-align:center;z-index:9999;white-space:pre-wrap`;
	el.textContent = `${message}\n\n${detail || ''}`;
	document.body.appendChild( el );
}

function setLoadProgress( pct, label ) {
	bus.emit( 'boot:progress', { pct, label } );
	const el = document.getElementById( 'boot-progress' );
	if ( el ) {
		el.style.setProperty( '--pct', `${pct}%` );
		el.dataset.label = label;
	}
}

// --------------------------------------------------------------------------

async function init() {
	const canvas = document.getElementById( 'game' );
	if ( ! canvas ) return showFatal( 'Missing #game canvas.' );

	try {
		engine.init( canvas );
	} catch ( e ) {
		return showFatal( 'WebGL2 initialisation failed.', String( e && e.message || e ) );
	}

	input.attach( canvas );
	const uiRoot = document.getElementById( 'ui-root' );

	setLoadProgress( 5, 'materials' );

	// ---- world -----------------------------------------------------------
	const materialsMod = await tryImport( './world/materials.js', 'materials' );
	const skyMod = await tryImport( './world/sky.js', 'sky' );
	const lightingMod = await tryImport( './world/lighting.js', 'lighting' );
	const mapMod = await tryImport( './world/map.js', 'map' );
	const postfxMod = await tryImport( './world/postfx.js', 'postfx' );
	const vfxMod = await tryImport( './world/vfx.js', 'vfx' );

	setLoadProgress( 25, 'building world' );

	const matlib = materialsMod?.createMaterialLibrary
		? materialsMod.createMaterialLibrary( engine.renderer )
		: fallbackMaterials();

	const sky = skyMod?.createSky ? skyMod.createSky( engine.scene, engine.renderer ) : null;

	const lighting = lightingMod?.setupLighting
		? lightingMod.setupLighting( engine.scene, engine.renderer, sky )
		: fallbackLighting();

	// The viewmodel scene needs the same IBL as the world, otherwise the
	// weapon's metal materials render nearly black (metals have no diffuse
	// term and rely almost entirely on the environment for their response).
	if ( engine.scene.environment ) {
		engine.viewScene.environment = engine.scene.environment;
		engine.viewScene.environmentIntensity = ( engine.scene.environmentIntensity ?? 1 ) * 1.35;
	}

	const world = mapMod?.buildMap ? mapMod.buildMap( engine.scene, matlib ) : fallbackWorld();
	game.world = world;
	normalizeWorld( world );

	setLoadProgress( 50, 'post-processing' );

	game.postfx = postfxMod?.createPostFX
		? postfxMod.createPostFX( engine.renderer, engine.scene, engine.camera, engine.viewScene, engine.viewCamera )
		: null;
	if ( game.postfx?.composer ) engine.setComposer( game.postfx.composer );

	game.vfx = vfxMod?.createVFX ? vfxMod.createVFX( engine.scene, engine.viewScene ) : stub( {
		muzzleFlash: noop, tracer: noop, impact: noop, bloodImpact: noop,
		shellEject: noop, smoke: noop, spark: noop,
	} );

	setLoadProgress( 65, 'combat systems' );

	// ---- combat ----------------------------------------------------------
	const decalsMod = await tryImport( './combat/decals.js', 'decals' );
	const controllerMod = await tryImport( './player/controller.js', 'controller' );
	const weaponsMod = await tryImport( './player/weapons.js', 'weapons' );
	const enemiesMod = await tryImport( './combat/enemies.js', 'enemies' );

	const decals = decalsMod?.createDecals ? decalsMod.createDecals( engine.scene ) : stub( { add: noop, clear: noop } );
	game.decals = decals;

	setLoadProgress( 78, 'audio' );

	// ---- audio -----------------------------------------------------------
	const audioMod = await tryImport( './audio/audio.js', 'audio' );
	game.audio = audioMod?.createAudio ? audioMod.createAudio( engine.camera ) : stub( { unlock: noop, setVolume: noop } );

	const deps = { vfx: game.vfx, audio: game.audio, decals, world };

	game.player = controllerMod?.createPlayer
		? controllerMod.createPlayer( world, deps )
		: fallbackPlayer( world );
	deps.player = game.player;

	game.enemies = enemiesMod?.createEnemies
		? enemiesMod.createEnemies( world, game.player, deps )
		: stub( { list: [], spawnWave: noop, reset: noop } );
	deps.enemies = game.enemies;

	game.weapons = weaponsMod?.createWeapons
		? weaponsMod.createWeapons( world, game.player, deps )
		: stub( { list: [], current: null } );
	deps.weapons = game.weapons;

	setLoadProgress( 90, 'interface' );

	// ---- ui --------------------------------------------------------------
	const hudMod = await tryImport( './ui/hud.js', 'hud' );
	const menuMod = await tryImport( './ui/menu.js', 'menu' );
	const minimapMod = await tryImport( './ui/minimap.js', 'minimap' );

	game.hud = hudMod?.createHUD ? hudMod.createHUD( uiRoot ) : stub( { setVisible: noop, reset: noop } );

	// The HUD owns the radar canvas; the minimap module draws into it.
	const minimapCanvas = game.hud?.minimapCanvas
		|| document.getElementById( 'op-minimap' )
		|| document.querySelector( '[data-minimap-canvas]' );
	if ( minimapMod?.createMinimap && minimapCanvas ) {
		game.minimap = minimapMod.createMinimap( minimapCanvas );
		game.minimap.setWorld?.( world );
	} else if ( minimapMod?.createMinimap ) {
		console.warn( '[boot] minimap module loaded but no radar canvas was found' );
	}

	game.menu = menuMod?.createMenu ? menuMod.createMenu( uiRoot, {
		onStart: startGame,
		onResume: resumeGame,
		onRestart: restartGame,
		onSettings: applySettings,
	} ) : stub( { showMain: noop, showPause: noop, showDeath: noop, hide: noop } );

	wireGameFlow();
	registerUpdates();

	setLoadProgress( 100, 'ready' );
	document.body.classList.add( 'boot-done' );

	engine.start();
	game.state = 'menu';
	game.hud.setVisible?.( false );
	game.menu.showMain?.();

	if ( boot.errors.length ) {
		console.warn( '[boot] degraded systems:', boot.errors );
		bus.emit( 'ui:toast', {
			text: 'DEGRADED BUILD',
			sub: boot.errors.map( ( e ) => e.label ).join( ', ' ) + ' failed to load',
		} );
	}

	setupDebugHarness();
}

// --------------------------------------------------------------------------
// game flow

function wireGameFlow() {
	bus.on( 'enemy:killed', ( e ) => {
		game.stats.kills ++;
		if ( e?.headshot ) game.stats.headshots ++;
	} );
	bus.on( 'weapon:fire', () => { game.stats.shots ++; } );
	bus.on( 'hit:confirm', () => { game.stats.hits ++; } );
	bus.on( 'score:add', ( e ) => { game.stats.score += ( e?.amount || 0 ); } );
	bus.on( 'wave:start', ( e ) => { game.stats.wave = e?.wave ?? game.stats.wave; } );
	bus.on( 'player:died', () => endGame() );

	bus.on( 'input:keydown', ( e ) => {
		if ( e.code !== 'Escape' ) return;
		if ( game.state === 'playing' ) pauseGame();
		else if ( game.state === 'paused' ) resumeGame();
	} );

	bus.on( 'input:unlock', () => {
		if ( game.state === 'playing' ) pauseGame();
	} );

	document.addEventListener( 'visibilitychange', () => {
		if ( document.hidden && game.state === 'playing' ) pauseGame();
	} );
}

function applySettings( patch ) {
	Object.assign( settings, patch || {} );
	saveSettings();
	if ( 'quality' in ( patch || {} ) ) {
		const q = qualityPreset();
		engine.renderer.setPixelRatio( Math.min( window.devicePixelRatio, q.pixelRatioCap ) );
		engine.renderer.shadowMap.enabled = q.shadowsEnabled;
		game.postfx?.setQuality?.( settings.quality );
		engine.resize();
	}
	if ( 'fov' in ( patch || {} ) ) engine.camera.updateProjectionMatrix();
	game.audio?.setVolume?.( settings.masterVolume );
	bus.emit( 'settings:changed', settings );
}

function startGame() {
	if ( game.state === 'playing' ) return;
	game.audio?.unlock?.();
	game.stats = { kills: 0, headshots: 0, shots: 0, hits: 0, wave: 0, score: 0, startedAt: performance.now(), timeAlive: 0 };
	game.player.reset?.();
	game.enemies.reset?.();
	// re-emits weapon:equipped, which the HUD needs since it is built after the
	// weapon system and therefore misses the construction-time event
	game.weapons.reset?.();
	game.decals?.clear?.();
	game.hud.reset?.();
	game.menu.hide?.();
	game.hud.setVisible?.( true );
	game.state = 'playing';
	engine.paused = false;
	input.requestLock();
	bus.emit( 'game:start', {} );
}

function pauseGame() {
	if ( game.state !== 'playing' ) return;
	game.state = 'paused';
	engine.paused = true;
	input.exitLock();
	game.menu.showPause?.();
	bus.emit( 'game:pause', {} );
}

function resumeGame() {
	if ( game.state !== 'paused' ) return;
	game.state = 'playing';
	engine.paused = false;
	game.menu.hide?.();
	input.requestLock();
	bus.emit( 'game:resume', {} );
}

function restartGame() {
	game.state = 'menu';
	startGame();
}

function endGame() {
	if ( game.state === 'dead' ) return;
	game.state = 'dead';
	game.stats.timeAlive = ( performance.now() - game.stats.startedAt ) / 1000;
	input.exitLock();
	const accuracy = game.stats.shots ? ( game.stats.hits / game.stats.shots ) * 100 : 0;
	const payload = { ...game.stats, accuracy };
	bus.emit( 'game:over', payload );
	setTimeout( () => {
		engine.paused = true;
		game.hud.setVisible?.( false );
		game.menu.showDeath?.( payload );
	}, 1600 );
}

// --------------------------------------------------------------------------

/**
 * Slow cinematic drift behind the main menu. The map can nominate a hero
 * framing via world.menuView; otherwise we derive one from the map bounds.
 */
function createMenuCamera( world ) {
	const view = world.menuView || null;
	const c = world.bounds.getCenter( new THREE.Vector3() );
	const size = world.bounds.getSize( new THREE.Vector3() );

	const from = view?.position
		? new THREE.Vector3().copy( view.position )
		: new THREE.Vector3( c.x + size.x * 0.34, 6.5, c.z + size.z * 0.36 );
	const at = view?.target
		? new THREE.Vector3().copy( view.target )
		: new THREE.Vector3( c.x - size.x * 0.1, 2.4, c.z - size.z * 0.15 );

	const dir = new THREE.Vector3().subVectors( at, from );
	const baseYaw = Math.atan2( - dir.x, - dir.z );
	const basePitch = Math.atan2( dir.y, Math.hypot( dir.x, dir.z ) );
	let t = 0;

	return function updateMenuCamera( dt ) {
		if ( game.state !== 'menu' && game.state !== 'dead' ) return;
		t += dt;
		// gentle parallax so the frame never feels like a frozen still
		engine.cameraRig.position.set(
			from.x + Math.sin( t * 0.09 ) * 1.15,
			from.y + Math.sin( t * 0.13 ) * 0.22,
			from.z + Math.cos( t * 0.075 ) * 1.15,
		);
		engine.cameraRig.rotation.y = baseYaw + Math.sin( t * 0.06 ) * 0.035;
		engine.cameraPitch.rotation.x = basePitch + Math.sin( t * 0.05 ) * 0.012;
		engine.cameraPitch.rotation.z = 0;
		engine.setFovScale( 0.94 );
	};
}

function registerUpdates() {
	const updateMenuCamera = createMenuCamera( game.world );
	engine.onUpdate( updateMenuCamera );

	engine.onUpdate( ( dt ) => {
		if ( game.state !== 'playing' ) return;
		game.player?.update?.( dt );
		game.weapons?.update?.( dt );
		game.enemies?.update?.( dt );
	} );

	engine.onUpdate( ( dt ) => {
		// the weapon has no business being on screen behind a menu
		engine.viewRoot.visible = game.state === 'playing';
		game.world?.update?.( dt );
		game.vfx?.update?.( dt );
		game.decals?.update?.( dt );
		game.postfx?.update?.( dt );
		game.hud?.update?.( dt );
		game.minimap?.update?.( dt );
		game.audio?.update?.( dt, game.player?.state );
	} );

	engine.onLateUpdate( () => input.endFrame() );
}

// --------------------------------------------------------------------------
// fallbacks — only used when a module is missing so the build still boots

function fallbackMaterials() {
	const mk = ( color, roughness = 0.85, metalness = 0.05 ) =>
		new THREE.MeshStandardMaterial( { color, roughness, metalness } );
	return {
		concrete: mk( 0x8a8d8f ), concreteDark: mk( 0x4a4d50 ), asphalt: mk( 0x33363a ),
		metal: mk( 0x8c9196, 0.4, 0.9 ), metalPainted: mk( 0x5d6b74, 0.55, 0.6 ),
		rustMetal: mk( 0x7a4a32, 0.8, 0.5 ), corrugated: mk( 0x6b7078, 0.6, 0.7 ),
		wood: mk( 0x8a6640 ), dirt: mk( 0x5a4c3a ), sand: mk( 0xbfa77e ),
		glass: new THREE.MeshStandardMaterial( { color: 0x9fc6d8, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.35 } ),
		plaster: mk( 0xb8b2a8 ), grate: mk( 0x50565c, 0.6, 0.7 ),
		emissive: ( hex, i = 2 ) => new THREE.MeshStandardMaterial( { color: 0x111111, emissive: hex, emissiveIntensity: i } ),
	};
}

function fallbackLighting() {
	const sun = new THREE.DirectionalLight( 0xffd2a1, 2.6 );
	sun.position.set( - 30, 34, 18 );
	sun.castShadow = true;
	sun.shadow.mapSize.set( 2048, 2048 );
	const c = sun.shadow.camera;
	c.left = - 45; c.right = 45; c.top = 45; c.bottom = - 45; c.near = 1; c.far = 120;
	c.updateProjectionMatrix();
	const hemi = new THREE.HemisphereLight( 0x8fb6d6, 0x30281f, 0.85 );
	engine.scene.add( sun, hemi );
	engine.scene.fog = new THREE.FogExp2( 0x9a8570, 0.011 );
	engine.scene.background = new THREE.Color( 0x6f7b86 );
	return { sun, hemi, update: noop, practicals: [] };
}

function fallbackWorld() {
	const root = new THREE.Group();
	const floor = new THREE.Mesh(
		new THREE.BoxGeometry( 80, 1, 80 ),
		new THREE.MeshStandardMaterial( { color: 0x6b6f73, roughness: 0.95 } ),
	);
	floor.position.y = - 0.5;
	floor.receiveShadow = true;
	floor.userData.surface = 'concrete';
	root.add( floor );
	engine.scene.add( root );

	const colliders = [ new THREE.Box3(
		new THREE.Vector3( - 40, - 1, - 40 ), new THREE.Vector3( 40, 0, 40 ) ) ];

	return {
		root, colliders, hitMeshes: [ floor ],
		playerSpawn: { position: new THREE.Vector3( 0, 0, 8 ), yaw: 0 },
		enemySpawns: [ { position: new THREE.Vector3( 0, 0, - 12 ), yaw: Math.PI } ],
		coverPoints: [ new THREE.Vector3( 6, 0, - 6 ), new THREE.Vector3( - 6, 0, - 6 ) ],
		bounds: new THREE.Box3( new THREE.Vector3( - 40, 0, - 40 ), new THREE.Vector3( 40, 12, 40 ) ),
		minimap: { min: { x: - 40, z: - 40 }, max: { x: 40, z: 40 }, walls: [] },
	};
}

/** Fill in anything a map module forgot so downstream systems never crash. */
function normalizeWorld( w ) {
	if ( ! w ) return;
	w.colliders = w.colliders || [];
	w.hitMeshes = w.hitMeshes || [];
	w.enemySpawns = w.enemySpawns?.length ? w.enemySpawns : [ { position: new THREE.Vector3( 0, 0, - 10 ), yaw: 0 } ];
	w.coverPoints = w.coverPoints?.length ? w.coverPoints : [ new THREE.Vector3( 0, 0, - 6 ) ];
	w.playerSpawn = w.playerSpawn || { position: new THREE.Vector3( 0, 0, 0 ), yaw: 0 };
	w.bounds = w.bounds || new THREE.Box3(
		new THREE.Vector3( - 50, 0, - 50 ), new THREE.Vector3( 50, 20, 50 ) );
	w.minimap = w.minimap || { min: { x: - 50, z: - 50 }, max: { x: 50, z: 50 }, walls: [] };
	// normalize spawn entries that were given as bare Vector3
	w.enemySpawns = w.enemySpawns.map( ( s ) => s.position ? s : { position: s, yaw: 0 } );
}

function fallbackPlayer( world ) {
	const state = { health: 100, maxHealth: 100, grounded: true, sprinting: false, crouching: false, ads: false, speed: 0, velocity: new THREE.Vector3() };
	const pos = world.playerSpawn.position.clone();
	let yaw = world.playerSpawn.yaw, pitch = 0;
	return {
		state,
		position: pos,
		reset() { pos.copy( world.playerSpawn.position ); state.health = 100; },
		damage( n ) { state.health = Math.max( 0, state.health - n ); },
		update( dt ) {
			const m = input.consumeMouse();
			yaw -= m.x; pitch = THREE.MathUtils.clamp( pitch - m.y, - 1.5, 1.5 );
			const f = ( input.down( 'KeyW' ) ? 1 : 0 ) - ( input.down( 'KeyS' ) ? 1 : 0 );
			const s = ( input.down( 'KeyD' ) ? 1 : 0 ) - ( input.down( 'KeyA' ) ? 1 : 0 );
			const sp = input.down( 'ShiftLeft' ) ? 7 : 4.5;
			pos.x += ( Math.sin( yaw ) * - f + Math.cos( yaw ) * s ) * sp * dt;
			pos.z += ( Math.cos( yaw ) * - f - Math.sin( yaw ) * s ) * sp * dt;
			engine.cameraRig.position.set( pos.x, pos.y + 1.68, pos.z );
			engine.cameraRig.rotation.y = yaw;
			engine.cameraPitch.rotation.x = pitch;
		},
	};
}

// --------------------------------------------------------------------------
// Debug / screenshot harness. Enabled with ?debug=1 or ?shot=<index>.

function setupDebugHarness() {
	const params = new URLSearchParams( location.search );

	window.__fpsDebug = {
		boot,
		engine,
		game,
		bus,
		THREE,
		/** Record every bus event for `seconds`, then resolve with the tally. */
		record( seconds = 6 ) {
			const counts = {};
			const samples = {};
			const emit = bus.emit.bind( bus );
			bus.emit = ( name, payload ) => {
				counts[ name ] = ( counts[ name ] || 0 ) + 1;
				if ( ! samples[ name ] ) {
					try { samples[ name ] = JSON.parse( JSON.stringify( payload ?? null ) ); } catch ( e ) { samples[ name ] = '[unserialisable]'; }
				}
				emit( name, payload );
			};
			return new Promise( ( resolve ) => setTimeout( () => {
				bus.emit = emit;
				resolve( { counts, samples } );
			}, seconds * 1000 ) );
		},
		/** Teleport the camera to a scripted vantage point for critique screenshots. */
		setView( v ) {
			engine.cameraRig.position.set( v.x, v.y, v.z );
			engine.cameraRig.rotation.y = v.yaw ?? 0;
			engine.cameraPitch.rotation.x = v.pitch ?? 0;
		},
		/** Force aim-down-sights for a screenshot. */
		forceAds( on = true ) {
			const w = game.weapons;
			if ( ! w ) return false;
			if ( w.setAds ) { w.setAds( on ); return true; }
			w.forceAds = on;
			return true;
		},
		/** Fire a short burst so a capture shows muzzle flash + tracers. */
		burst( n = 5 ) {
			const w = game.weapons;
			if ( ! w ) return false;
			const fire = w.tryFire || w.fire;
			if ( ! fire ) { w.forceTrigger = true; return false; }
			for ( let i = 0; i < n; i ++ ) setTimeout( () => fire.call( w ), i * 85 );
			return true;
		},
		info() {
			return {
				fps: engine.fps,
				calls: engine.renderer.info.render.calls,
				tris: engine.renderer.info.render.triangles,
				programs: engine.renderer.info.programs?.length ?? 0,
				textures: engine.renderer.info.memory.textures,
				geometries: engine.renderer.info.memory.geometries,
				errors: boot.errors,
				loaded: boot.loaded,
				state: game.state,
			};
		},
	};

	// Signal capture-readiness once a stable run of frames has rendered.
	let frames = 0;
	engine.onLateUpdate( () => {
		frames ++;
		if ( frames === 75 ) window.__shotReady = true;
	} );

	const shot = params.get( 'shot' );
	if ( shot === null ) return;

	// Screenshot mode: run the real start path, then pin the camera.
	document.body.classList.add( 'shot-mode' );
	startGame();
	game.hud.setVisible?.( params.get( 'hud' ) !== '0' );

	const views = shotViews( game.world );
	const view = views[ Math.min( Number( shot ) || 0, views.length - 1 ) ];
	if ( view && params.get( 'pin' ) !== '0' ) {
		window.__fpsDebug.setView( view );
		// Freeze player movement so the scripted camera sticks.
		if ( game.player ) {
			const orig = game.player.update;
			game.player.update = ( dt ) => {
				if ( params.get( 'freeze' ) === '0' ) orig?.call( game.player, dt );
				window.__fpsDebug.setView( view );
			};
		}
	}

	if ( params.get( 'enemies' ) !== '0' ) game.enemies?.spawnWave?.( Number( params.get( 'enemies' ) ) || 5 );
	if ( params.get( 'firing' ) === '1' ) {
		setInterval( () => bus.emit( 'debug:fire' ), 90 );
	}
}

function shotViews( w ) {
	const s = w?.playerSpawn?.position || new THREE.Vector3();
	const base = [
		{ x: s.x, y: 1.68, z: s.z, yaw: w?.playerSpawn?.yaw ?? 0, pitch: 0 },
	];
	if ( w?.shotViews ) return w.shotViews.concat( base );
	return base.concat( [
		{ x: s.x + 6, y: 1.68, z: s.z - 14, yaw: - 0.8, pitch: - 0.05 },
		{ x: s.x - 8, y: 2.4, z: s.z - 22, yaw: 1.9, pitch: - 0.08 },
		{ x: s.x, y: 6.5, z: s.z - 10, yaw: 0.4, pitch: - 0.35 },
		{ x: s.x + 14, y: 1.68, z: s.z - 6, yaw: - 2.2, pitch: 0.02 },
	] );
}

// --------------------------------------------------------------------------

init().catch( ( e ) => {
	console.error( e );
	showFatal( 'Fatal error during boot.', String( e && e.stack || e ) );
} );
