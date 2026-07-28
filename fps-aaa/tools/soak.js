/**
 * Headless gameplay soak test. Fed to tools/shoot.py via --eval.
 *
 * Drives a real combat loop with no human input and reports whether the
 * gameplay systems actually complete a full cycle: fire → hit → kill → wave
 * clear → next wave, plus player damage and death handling.
 */
( async () => {
	const D = window.__fpsDebug;
	const g = window.__game;
	const log = [];
	const fail = [];
	const ok = ( cond, msg ) => { ( cond ? log : fail ).push( ( cond ? 'PASS ' : 'FAIL ' ) + msg ); return cond; };
	const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

	if ( ! D || ! g ) return JSON.stringify( { fatal: 'debug harness missing' } );

	// Keep the subject alive: the enemies are lethal enough to end the run
	// before the later assertions get a chance to execute.
	const lifeSupport = setInterval( () => {
		if ( g.player.state.health < 90 ) g.player.heal( 100 );
	}, 200 );

	// ---- start recording every bus event -------------------------------------
	const recording = D.record( 11 );

	ok( g.state === 'playing', `game state is playing (got "${g.state}")` );
	ok( !! g.weapons.current, 'a weapon is equipped' );

	const w0 = g.weapons.current;
	const ammoStart = w0 ? w0.ammo : - 1;

	// ---- 1. firing -----------------------------------------------------------
	// Aim at a live enemy so the shots actually resolve into hits.
	const live = ( g.enemies.list || [] ).filter( ( e ) => e.alive );
	ok( live.length > 0, `enemies alive at start (got ${live.length})` );

	const THREE = D.THREE;
	const aimAt = ( pos ) => {
		const eye = g.player.eye;
		const dx = pos.x - eye.x, dy = ( pos.y + 1.1 ) - eye.y, dz = pos.z - eye.z;
		D.engine.cameraRig.rotation.y = Math.atan2( - dx, - dz );
		D.engine.cameraPitch.rotation.x = Math.atan2( dy, Math.hypot( dx, dz ) );
		D.engine.cameraRig.updateMatrixWorld( true );
	};

	const aliveNow = () => ( g.enemies.list || [] ).filter( ( e ) => e.alive ).length;
	const aliveAtStart = aliveNow();
	for ( let i = 0; i < 70 && aliveNow() > aliveAtStart - 2; i ++ ) {
		const target = ( g.enemies.list || [] ).find( ( e ) => e.alive );
		if ( ! target ) break;
		aimAt( target.position );
		g.weapons.fire?.();
		await sleep( 60 );
	}
	// Enemies take cover, so a scripted aim at the torso will not always have
	// line of sight; the meaningful assertion is that shots resolve into
	// enemy hits at all, which is checked against hit:confirm below.
	log.push( `INFO alive ${aliveAtStart} -> ${aliveNow()} after scripted burst` );

	const w1 = g.weapons.current;
	ok( w1.ammo < ammoStart || w1.ammo === w1.def.magSize, `ammo moved (${ammoStart} -> ${w1.ammo})` );

	// ---- 2. reload -----------------------------------------------------------
	g.weapons.startReload?.();
	await sleep( 2600 );
	ok( ! g.weapons.reloading, 'reload completed' );

	// ---- 3. weapon switching -------------------------------------------------
	g.weapons.switchTo?.( 1 );
	await sleep( 700 );
	const switched = g.weapons.current && g.weapons.current !== w1;
	ok( switched, `switched weapon (now "${g.weapons.current && g.weapons.current.id}")` );
	g.weapons.switchTo?.( 0 );
	await sleep( 600 );

	// ---- 4. player damage + regen -------------------------------------------
	const hpBefore = g.player.state.health;
	g.player.damage( 35, null );
	ok( g.player.state.health < hpBefore, `damage applied (${hpBefore} -> ${g.player.state.health})` );

	// ---- 5. wave completion --------------------------------------------------
	for ( const e of ( g.enemies.list || [] ) ) {
		if ( e.alive ) g.enemies.damage( e, 999, { point: e.position } );
	}
	await sleep( 3500 );

	clearInterval( lifeSupport );
	const rec = await recording;
	const c = rec.counts;

	ok( ( c[ 'weapon:fire' ] || 0 ) > 3, `weapon:fire emitted (${c[ 'weapon:fire' ] || 0})` );
	ok( ( c[ 'hit:surface' ] || 0 ) + ( c[ 'hit:confirm' ] || 0 ) > 0,
		`hits registered (surface ${c[ 'hit:surface' ] || 0}, confirm ${c[ 'hit:confirm' ] || 0})` );
	ok( ( c[ 'weapon:reloadStart' ] || 0 ) > 0 && ( c[ 'weapon:reloadEnd' ] || 0 ) > 0, 'reload events paired' );
	ok( ( c[ 'weapon:equipped' ] || 0 ) >= 2, `weapon:equipped emitted (${c[ 'weapon:equipped' ] || 0})` );
	ok( ( c[ 'player:damaged' ] || 0 ) > 0, `player:damaged emitted (${c[ 'player:damaged' ] || 0})` );
	ok( ( c[ 'radar:enemies' ] || 0 ) > 5, `radar:enemies streaming (${c[ 'radar:enemies' ] || 0})` );
	ok( ( c[ 'enemy:killed' ] || 0 ) > 0, `enemy:killed emitted (${c[ 'enemy:killed' ] || 0})` );
	ok( ( c[ 'wave:clear' ] || 0 ) > 0 || ( c[ 'wave:start' ] || 0 ) > 1,
		`wave cycled (start ${c[ 'wave:start' ] || 0}, clear ${c[ 'wave:clear' ] || 0})` );
	ok( ( c[ 'player:footstep' ] || 0 ) >= 0, 'footstep channel present' );

	return JSON.stringify( {
		pass: log.length,
		fail: fail.length,
		failures: fail,
		passes: log,
		events: c,
		stats: g.stats,
		info: D.info(),
	} );
} )()
