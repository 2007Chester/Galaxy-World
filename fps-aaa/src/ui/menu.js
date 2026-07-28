// OVERPRESSURE — front end: title screen, settings, pause, after-action report.
//
// createMenu(rootEl, hooks) -> { showMain, showPause, showDeath, hide, visible }
// hooks = { onStart, onResume, onRestart, onSettings(patch) }

import { bus } from '../core/events.js';
import { settings, saveSettings } from '../core/settings.js';

const BUILD = '0.9.4';

const CONTROLS = [
	[ [ 'W', 'A', 'S', 'D' ], 'Move' ],
	[ [ 'Shift' ], 'Sprint' ],
	[ [ 'C' ], 'Crouch' ],
	[ [ 'Space' ], 'Jump' ],
	[ [ 'LMB' ], 'Fire' ],
	[ [ 'RMB' ], 'Aim down sight' ],
	[ [ 'R' ], 'Reload' ],
	[ [ '1', '2', '3' ], 'Select weapon' ],
	[ [ 'Q' ], 'Quick swap' ],
	[ [ 'Esc' ], 'Pause' ],
];

const pct = ( v ) => Math.round( v * 100 ) + '%';

const SETTING_GROUPS = [
	{
		title: 'Input & optics',
		items: [
			{ key: 'sensitivity', label: 'Mouse sensitivity', type: 'range', min: 0.0004, max: 0.006, step: 0.0001, fmt: ( v ) => ( v * 1000 ).toFixed( 2 ) },
			{ key: 'adsSensitivityScale', label: 'ADS sens. scale', type: 'range', min: 0.2, max: 1, step: 0.02, fmt: ( v ) => v.toFixed( 2 ) + '\u00D7' },
			{ key: 'fov', label: 'Field of view', type: 'range', min: 65, max: 110, step: 1, fmt: ( v ) => Math.round( v ) + '\u00B0' },
			{ key: 'crosshairScale', label: 'Crosshair scale', type: 'range', min: 0.6, max: 1.8, step: 0.05, fmt: ( v ) => v.toFixed( 2 ) + '\u00D7' },
			{ key: 'invertY', label: 'Invert look Y', type: 'toggle' },
		],
	},
	{
		title: 'Audio & rendering',
		items: [
			{ key: 'masterVolume', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
			{ key: 'sfxVolume', label: 'Weapons & world', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
			{ key: 'musicVolume', label: 'Soundtrack', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
			{ key: 'quality', label: 'Graphics quality', type: 'opts', opts: [ 'low', 'medium', 'high' ] },
			{ key: 'showFps', label: 'Performance readout', type: 'toggle' },
		],
	},
];

/* ---------------------------------------------------------------- helpers */

function el( tag, cls, parent, text ) {
	const n = document.createElement( tag );
	if ( cls ) n.className = cls;
	if ( text != null ) n.textContent = text;
	if ( parent ) parent.appendChild( n );
	return n;
}

function button( parent, label, index, variant ) {
	const b = el( 'button', 'op-btn' + ( variant ? ' op-btn--' + variant : '' ), parent );
	b.type = 'button';
	el( 'span', 'op-btn__i', b, index );
	el( 'span', 'op-btn__l', b, label );
	el( 'span', 'op-btn__i', b, '\u203A' );
	return b;
}

function clock( sec ) {
	const s = Math.max( 0, Math.round( sec ) );
	const m = Math.floor( s / 60 );
	return m + ':' + ( s % 60 < 10 ? '0' : '' ) + ( s % 60 );
}

const reducedMotion = () =>
	window.matchMedia && window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

/* ------------------------------------------------------------------- menu */

export function createMenu( rootEl, hooks ) {

	const H = hooks || {};
	const call = ( name, arg ) => { if ( typeof H[ name ] === 'function' ) H[ name ]( arg ); };
	const root = rootEl || document.getElementById( 'ui-root' ) || document.body;

	/* ------------------------------------------------------------- shell */

	const menu = el( 'div', 'op-menu', root );
	menu.id = 'op-menu';
	menu.setAttribute( 'role', 'dialog' );
	menu.setAttribute( 'aria-modal', 'true' );
	menu.setAttribute( 'aria-label', 'OVERPRESSURE menu' );

	el( 'div', 'op-menu__bg', menu );
	el( 'div', 'op-menu__pool', menu );
	el( 'div', 'op-menu__grid', menu );
	el( 'div', 'op-menu__scan', menu );
	el( 'div', 'op-menu__vig', menu );

	const screens = {};

	function makeScreen( id ) {
		const s = el( 'div', 'op-screen op-screen--' + id, menu );
		s.id = 'op-screen-' + id;
		s.hidden = true;
		const inner = el( 'div', 'op-screen__in', s );
		screens[ id ] = { el: s, in: inner };
		return inner;
	}

	/* -------------------------------------------------------- main screen */

	const mainIn = makeScreen( 'main' );

	const brand = el( 'div', 'op-brand', mainIn );
	el( 'div', 'op-brand__k', brand, 'Tactical engagement simulator' );
	const wm = el( 'h1', 'op-wordmark', brand );
	el( 'span', 'op-wordmark__a', wm, 'OVER' );
	el( 'span', 'op-wordmark__b', wm, 'PRESSURE' );
	const rule = el( 'div', 'op-brand__rule', brand );
	el( 'div', 'op-brand__sub', rule, 'Close-quarters survival \u00B7 Grid 7-Delta \u00B7 Vertical slice' );

	const grid = el( 'div', 'op-main-grid', mainIn );

	const leftCol = el( 'div', '', grid );
	const actions = el( 'div', 'op-actions', leftCol );
	const btnDeploy = button( actions, 'Deploy', '01', 'primary' );
	const btnSettingsMain = button( actions, 'Settings', '02' );
	const hint = el( 'div', 'op-hintline', leftCol );
	el( 'div', '', hint ).innerHTML = 'Press <b>Enter</b> or click anywhere to deploy.';
	el( 'div', '', hint ).innerHTML = '<b>Esc</b> pauses the operation at any time.';

	const ctrlPanel = el( 'div', 'op-panel', grid );
	el( 'div', 'op-panel__h', ctrlPanel, 'Control scheme' );
	const keys = el( 'div', 'op-keys', ctrlPanel );
	for ( let i = 0; i < CONTROLS.length; i ++ ) {
		const row = el( 'div', 'op-keyrow', keys );
		const caps = el( 'div', 'op-caps', row );
		const list = CONTROLS[ i ][ 0 ];
		for ( let j = 0; j < list.length; j ++ ) el( 'kbd', 'op-cap', caps, list[ j ] );
		el( 'div', 'op-keyrow__d', row, CONTROLS[ i ][ 1 ] );
	}

	// Pinned to the bottom edge, full width — anchors the composition and lets
	// the sky in the upper right stay empty on purpose.
	const briefWrap = el( 'div', 'op-mainstrip', screens.main.el );
	const brief = el( 'div', 'op-stats', briefWrap );
	const briefData = [
		[ 'Sector', 'Grid 7-Delta' ],
		[ 'Threat', 'Elevated' ],
		[ 'Mode', 'Survival' ],
		[ 'Extraction', 'Denied' ],
	];
	for ( let i = 0; i < briefData.length; i ++ ) {
		const cell = el( 'div', 'op-stat', brief );
		el( 'div', 'op-stat__l', cell, briefData[ i ][ 0 ] );
		el( 'div', 'op-stat__v', cell, briefData[ i ][ 1 ] );
	}

	/* ------------------------------------------------------- pause screen */

	const pauseIn = makeScreen( 'pause' );
	const pauseBrand = el( 'div', 'op-brand', pauseIn );
	el( 'div', 'op-brand__k', pauseBrand, 'Operation suspended \u00B7 paused' );
	const pwm = el( 'h1', 'op-wordmark', pauseBrand );
	el( 'span', 'op-wordmark__a', pwm, 'STAND' );
	el( 'span', 'op-wordmark__b', pwm, 'BY' );
	const pauseGrid = el( 'div', 'op-main-grid', pauseIn );
	const pauseActions = el( 'div', 'op-actions', pauseGrid );
	const btnResume = button( pauseActions, 'Resume', '01', 'primary' );
	const btnRestartPause = button( pauseActions, 'Restart operation', '02' );
	const btnSettingsPause = button( pauseActions, 'Settings', '03' );
	const pausePanel = el( 'div', 'op-panel', pauseGrid );
	el( 'div', 'op-panel__h', pausePanel, 'Live status' );
	const pauseStats = el( 'div', 'op-stats', pausePanel );
	const pauseStatNodes = {};
	[ [ 'kills', 'Eliminations' ], [ 'headshots', 'Headshots' ], [ 'accuracy', 'Accuracy' ], [ 'wave', 'Wave' ] ]
		.forEach( ( d ) => {
			const cell = el( 'div', 'op-stat', pauseStats );
			el( 'div', 'op-stat__l', cell, d[ 1 ] );
			pauseStatNodes[ d[ 0 ] ] = el( 'div', 'op-stat__v', cell, '0' );
		} );

	/* ------------------------------------------------------- death screen */

	const deathIn = makeScreen( 'death' );
	const deathHead = el( 'div', 'op-brand', deathIn );
	el( 'div', 'op-death__k', deathHead, 'Vitals flatlined \u00B7 after-action report' );
	el( 'h1', 'op-death__t', deathHead, 'Mission failed' );
	const deathStats = el( 'div', 'op-stats', deathIn );
	const statDefs = [
		[ 'score', 'Score', true ],
		[ 'kills', 'Eliminations', false ],
		[ 'headshots', 'Headshots', false ],
		[ 'accuracy', 'Accuracy', false ],
		[ 'wave', 'Wave reached', false ],
		[ 'time', 'Time survived', false ],
	];
	const deathNodes = {};
	for ( let i = 0; i < statDefs.length; i ++ ) {
		const cell = el( 'div', 'op-stat' + ( statDefs[ i ][ 2 ] ? ' op-stat--hero' : '' ), deathStats );
		el( 'div', 'op-stat__l', cell, statDefs[ i ][ 1 ] );
		deathNodes[ statDefs[ i ][ 0 ] ] = el( 'div', 'op-stat__v', cell, '0' );
	}
	const deathActions = el( 'div', 'op-actions op-actions--narrow', deathIn );
	const btnRedeploy = button( deathActions, 'Redeploy', '01', 'primary' );
	const btnSettingsDeath = button( deathActions, 'Settings', '02' );

	/* ---------------------------------------------------- settings screen */

	const setIn = makeScreen( 'settings' );
	const setBrand = el( 'div', 'op-brand', setIn );
	el( 'div', 'op-brand__k', setBrand, 'Configuration' );
	const swm = el( 'h1', 'op-wordmark', setBrand );
	el( 'span', 'op-wordmark__a', swm, 'SET' );
	el( 'span', 'op-wordmark__b', swm, 'TINGS' );

	const setGrid = el( 'div', 'op-settings', setIn );
	const controlRefs = [];

	let saveTimer = 0;
	function persist() {
		if ( saveTimer ) return;
		saveTimer = window.setTimeout( () => { saveTimer = 0; saveSettings(); }, 220 );
	}

	function apply( key, value ) {
		settings[ key ] = value;
		const patch = {};
		patch[ key ] = value;
		call( 'onSettings', patch );
		persist();
	}

	for ( let g = 0; g < SETTING_GROUPS.length; g ++ ) {
		const group = SETTING_GROUPS[ g ];
		const panel = el( 'div', 'op-panel', setGrid );
		el( 'div', 'op-panel__h', panel, group.title );

		for ( let i = 0; i < group.items.length; i ++ ) {
			const def = group.items[ i ];
			const row = el( 'div', 'op-set', panel );
			const labelId = 'op-set-' + def.key;
			el( 'div', 'op-set__l', row, def.label ).id = labelId;

			if ( def.type === 'range' ) {
				const out = el( 'div', 'op-set__v', row, def.fmt( settings[ def.key ] ) );
				const wrap = el( 'div', 'op-set__c', row );
				const input = el( 'input', 'op-range', wrap );
				input.type = 'range';
				input.min = def.min;
				input.max = def.max;
				input.step = def.step;
				input.value = settings[ def.key ];
				input.setAttribute( 'aria-labelledby', labelId );
				const paint = () => {
					const v = parseFloat( input.value );
					input.style.setProperty( '--p', ( ( v - def.min ) / ( def.max - def.min ) ).toFixed( 4 ) );
					out.textContent = def.fmt( v );
				};
				paint();
				input.addEventListener( 'input', () => { paint(); apply( def.key, parseFloat( input.value ) ); } );
				controlRefs.push( { def, sync: () => { input.value = settings[ def.key ]; paint(); } } );

			} else if ( def.type === 'toggle' ) {
				const lab = el( 'label', 'op-toggle', row );
				const input = el( 'input', '', lab );
				input.type = 'checkbox';
				input.checked = !! settings[ def.key ];
				input.setAttribute( 'aria-labelledby', labelId );
				el( 'span', 'op-toggle__t', lab );
				input.addEventListener( 'change', () => apply( def.key, input.checked ) );
				controlRefs.push( { def, sync: () => { input.checked = !! settings[ def.key ]; } } );

			} else if ( def.type === 'opts' ) {
				const wrap = el( 'div', 'op-set__c op-opts', row );
				const inputs = [];
				for ( let o = 0; o < def.opts.length; o ++ ) {
					const opt = def.opts[ o ];
					const lab = el( 'label', 'op-opt', wrap );
					const input = el( 'input', '', lab );
					input.type = 'radio';
					input.name = 'op-' + def.key;
					input.value = opt;
					input.checked = settings[ def.key ] === opt;
					input.setAttribute( 'aria-label', def.label + ': ' + opt );
					el( 'span', '', lab, opt );
					input.addEventListener( 'change', () => { if ( input.checked ) apply( def.key, opt ); } );
					inputs.push( input );
				}
				controlRefs.push( { def, sync: () => {
					for ( let o = 0; o < inputs.length; o ++ ) inputs[ o ].checked = settings[ def.key ] === inputs[ o ].value;
				} } );
			}
		}
	}

	const setActions = el( 'div', 'op-actions op-actions--narrow op-actions--spaced', setIn );
	const btnBack = button( setActions, 'Back', '\u2190', 'primary' );

	/* ---------------------------------------------------------- footer */

	const foot = el( 'div', 'op-menu__foot', menu );
	el( 'span', '', foot, 'OVERPRESSURE \u00B7 BUILD ' + BUILD + ' \u00B7 VERTICAL SLICE' );
	el( 'span', '', foot, 'ORIGINAL WORK \u00B7 NO THIRD-PARTY ASSETS' );
	el( 'span', '', foot, 'WEBGL2 \u00B7 60HZ TARGET' );

	/* ------------------------------------------------------- run stats */

	const run = { shots: 0, hits: 0, kills: 0, headshots: 0, wave: 0, t0: 0, acc: 0, paused: false, pauseAt: 0 };

	function resetRun() {
		run.shots = 0; run.hits = 0; run.kills = 0; run.headshots = 0; run.wave = 0;
		run.acc = 0; run.paused = false; run.pauseAt = 0;
		run.t0 = performance.now();
	}
	resetRun();

	function elapsed() {
		const base = run.acc + ( run.paused ? 0 : performance.now() - run.t0 );
		return Math.max( 0, base / 1000 );
	}

	const offs = [];
	const on = ( n, f ) => offs.push( bus.on( n, f ) );

	on( 'game:start', () => resetRun() );
	on( 'weapon:fire', () => run.shots ++ );
	on( 'hit:confirm', () => run.hits ++ );
	on( 'enemy:killed', ( p ) => { run.kills ++; if ( p && p.headshot ) run.headshots ++; } );
	on( 'wave:start', ( p ) => { if ( p && p.wave ) run.wave = p.wave; } );
	on( 'game:pause', () => {
		if ( ! run.paused ) { run.paused = true; run.acc += performance.now() - run.t0; }
		if ( ! state.open ) showPause();
	} );
	on( 'game:resume', () => {
		if ( run.paused ) { run.paused = false; run.t0 = performance.now(); }
		if ( state.open && state.screen === 'pause' ) hide();
	} );
	on( 'game:over', ( p ) => {
		if ( state.open && state.screen === 'death' ) return;
		showDeath( p || {} );
	} );

	function accuracy() {
		return run.shots > 0 ? Math.round( ( run.hits / run.shots ) * 100 ) : 0;
	}

	/* --------------------------------------------------- number count-up */

	let raf = 0;
	let anims = null;

	function stopCount() {
		if ( raf ) cancelAnimationFrame( raf );
		raf = 0;
		anims = null;
	}

	function countUp( list ) {
		stopCount();
		if ( reducedMotion() ) {
			for ( let i = 0; i < list.length; i ++ ) list[ i ].node.textContent = list[ i ].fmt( list[ i ].to );
			return;
		}
		anims = list;
		const t0 = performance.now();
		const dur = 950;
		const step = ( now ) => {
			const p = Math.min( 1, ( now - t0 ) / dur );
			const e = 1 - Math.pow( 1 - p, 3 );
			for ( let i = 0; i < anims.length; i ++ ) {
				const a = anims[ i ];
				a.node.textContent = a.fmt( a.to * e );
			}
			if ( p < 1 ) raf = requestAnimationFrame( step );
			else { raf = 0; anims = null; }
		};
		raf = requestAnimationFrame( step );
	}

	/* ------------------------------------------------------ screen logic */

	const state = { open: false, screen: 'main', back: 'main' };

	function focusFirst() {
		const s = screens[ state.screen ];
		if ( ! s ) return;
		const target = s.el.querySelector( '.op-btn--primary' ) ||
			s.el.querySelector( '.op-btn' ) ||
			s.el.querySelector( 'input, [tabindex]' );
		if ( target ) {
			try { target.focus( { preventScroll: true } ); } catch ( e ) { target.focus(); }
		}
	}

	function show( name ) {
		for ( const k in screens ) screens[ k ].el.hidden = k !== name;
		state.screen = name;
		state.open = true;
		menu.classList.add( 'is-open' );
		menu.setAttribute( 'data-screen', name );
		// restart the entrance animation on the newly shown panel
		const inner = screens[ name ].in;
		inner.style.animation = 'none';
		void inner.offsetWidth;
		inner.style.animation = '';
		focusFirst();
	}

	function showMain() {
		stopCount();
		show( 'main' );
		state.back = 'main';
	}

	function showPause() {
		stopCount();
		pauseStatNodes.kills.textContent = String( run.kills );
		pauseStatNodes.headshots.textContent = String( run.headshots );
		pauseStatNodes.accuracy.textContent = accuracy() + '%';
		pauseStatNodes.wave.textContent = run.wave ? String( run.wave ) : '\u2014';
		show( 'pause' );
		state.back = 'pause';
	}

	function showDeath( stats ) {
		const s = stats || {};
		const score = s.score != null ? s.score : 0;
		const kills = s.kills != null ? s.kills : run.kills;
		const heads = s.headshots != null ? s.headshots : run.headshots;
		const acc = s.accuracy != null ? s.accuracy : accuracy();
		const wave = s.wave != null ? s.wave : run.wave;
		const time = s.timeAlive != null ? s.timeAlive : ( s.time != null ? s.time : elapsed() );

		show( 'death' );
		state.back = 'death';

		countUp( [
			{ node: deathNodes.score, to: score, fmt: ( v ) => String( Math.round( v ) ) },
			{ node: deathNodes.kills, to: kills, fmt: ( v ) => String( Math.round( v ) ) },
			{ node: deathNodes.headshots, to: heads, fmt: ( v ) => String( Math.round( v ) ) },
			{ node: deathNodes.accuracy, to: acc, fmt: ( v ) => Math.round( v ) + '%' },
			{ node: deathNodes.wave, to: wave, fmt: ( v ) => String( Math.round( v ) ) },
			{ node: deathNodes.time, to: time, fmt: ( v ) => clock( v ) },
		] );
	}

	function showSettings() {
		for ( let i = 0; i < controlRefs.length; i ++ ) controlRefs[ i ].sync();
		const from = state.screen === 'settings' ? state.back : state.screen;
		show( 'settings' );
		state.back = from === 'settings' ? 'main' : from;
	}

	function hide() {
		stopCount();
		state.open = false;
		menu.classList.remove( 'is-open' );
		for ( const k in screens ) screens[ k ].el.hidden = true;
		if ( document.activeElement && menu.contains( document.activeElement ) ) document.activeElement.blur();
	}

	/* ------------------------------------------------------------ wiring */

	function startGame() {
		hide();
		if ( run.paused ) { run.paused = false; run.t0 = performance.now(); }
		else resetRun();
		call( 'onStart' );
	}

	function resumeGame() {
		hide();
		if ( run.paused ) { run.paused = false; run.t0 = performance.now(); }
		call( 'onResume' );
	}

	function restartGame() {
		hide();
		resetRun();
		call( 'onRestart' );
	}

	btnDeploy.addEventListener( 'click', startGame );
	btnResume.addEventListener( 'click', resumeGame );
	btnRestartPause.addEventListener( 'click', restartGame );
	btnRedeploy.addEventListener( 'click', restartGame );
	btnSettingsMain.addEventListener( 'click', showSettings );
	btnSettingsPause.addEventListener( 'click', showSettings );
	btnSettingsDeath.addEventListener( 'click', showSettings );
	btnBack.addEventListener( 'click', () => {
		const target = state.back && state.back !== 'settings' ? state.back : 'main';
		if ( target === 'pause' ) showPause();
		else if ( target === 'death' ) show( 'death' );
		else showMain();
	} );

	// click the backdrop of the title screen to deploy
	screens.main.el.addEventListener( 'click', ( e ) => {
		if ( e.target.closest( 'button, input, label, a, kbd' ) ) return;
		startGame();
	} );

	function focusables() {
		const s = screens[ state.screen ];
		if ( ! s ) return [];
		return Array.prototype.filter.call(
			s.el.querySelectorAll( 'button, input, [href], [tabindex]:not([tabindex="-1"])' ),
			( n ) => ! n.disabled && n.offsetParent !== null
		);
	}

	function onKeyDown( e ) {
		if ( e.key === 'Escape' ) {
			if ( ! state.open ) {
				bus.emit( 'game:pause' );
				e.preventDefault();
				return;
			}
			if ( state.screen === 'settings' ) {
				const target = state.back && state.back !== 'settings' ? state.back : 'main';
				if ( target === 'pause' ) showPause();
				else if ( target === 'death' ) show( 'death' );
				else showMain();
				e.preventDefault();
				return;
			}
			if ( state.screen === 'pause' ) {
				resumeGame();
				bus.emit( 'game:resume' );
				e.preventDefault();
			}
			return;
		}

		if ( ! state.open ) return;

		if ( e.key === 'Enter' && state.screen === 'main' ) {
			const t = e.target;
			if ( ! t || ! ( t.tagName === 'BUTTON' || t.tagName === 'INPUT' ) ) {
				startGame();
				e.preventDefault();
			}
			return;
		}

		// soft focus wrap — never strands the caret outside the open panel
		if ( e.key === 'Tab' ) {
			const list = focusables();
			if ( list.length < 2 ) return;
			const first = list[ 0 ], last = list[ list.length - 1 ];
			const active = document.activeElement;
			if ( ! menu.contains( active ) ) {
				( e.shiftKey ? last : first ).focus();
				e.preventDefault();
			} else if ( ! e.shiftKey && active === last ) {
				first.focus();
				e.preventDefault();
			} else if ( e.shiftKey && active === first ) {
				last.focus();
				e.preventDefault();
			}
		}
	}

	window.addEventListener( 'keydown', onKeyDown );

	function destroy() {
		stopCount();
		for ( let i = 0; i < offs.length; i ++ ) offs[ i ]();
		offs.length = 0;
		window.removeEventListener( 'keydown', onKeyDown );
		if ( saveTimer ) { clearTimeout( saveTimer ); saveTimer = 0; }
		if ( menu.parentNode ) menu.parentNode.removeChild( menu );
	}

	showMain();

	return {
		showMain,
		showPause,
		showDeath,
		showSettings,
		hide,
		destroy,
		root: menu,
		get visible() { return state.open; },
		get screen() { return state.screen; },
	};
}

export default createMenu;
