// OVERPRESSURE — HUD.
//
// 100% event-bus driven. Imports nothing but core/events + core/settings.
// Everything is pooled: killfeed rows, damage numbers, directional wedges.
// Text nodes are only touched when the value actually changed, and every
// animation runs on transform/opacity (or a canvas capped at 30Hz).

import { bus } from '../core/events.js';
import { settings } from '../core/settings.js';

const DPR_CAP = 2;
const TICK_30 = 1 / 30;

const POOL_DMG = 24;
const POOL_KF = 8;
const POOL_WEDGE = 8;
const KF_MAX = 5;
const KF_LIFE = 5.0;

// Ceiling for the DOM low-health edge + damage flash. Agent B's post-process
// vignette composes on top of these, so both stay deliberately restrained.
const EDGE_MAX = 0.55;
const FLASH_MAX = 0.55;

const CARDINALS = [ 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW' ];

/* ---------------------------------------------------------------- helpers */

function el( tag, cls, parent ) {
	const n = document.createElement( tag );
	if ( cls ) n.className = cls;
	if ( parent ) parent.appendChild( n );
	return n;
}

// Only write to the DOM when the string actually changed.
function setText( node, str ) {
	if ( node._v === str ) return;
	node._v = str;
	node.textContent = str;
}

function setAttr( node, name, val ) {
	const k = '_a_' + name;
	if ( node[ k ] === val ) return;
	node[ k ] = val;
	node.setAttribute( name, val );
}

function setStyle( node, prop, val ) {
	const k = '_s_' + prop;
	if ( node[ k ] === val ) return;
	node[ k ] = val;
	node.style.setProperty( prop, val );
}

function clamp( v, a, b ) { return v < a ? a : v > b ? b : v; }
function lerp( a, b, t ) { return a + ( b - a ) * t; }
function pad2( n ) { return n < 10 ? '0' + n : '' + n; }

function mixHex( a, b, t ) {
	const ar = ( a >> 16 ) & 255, ag = ( a >> 8 ) & 255, ab = a & 255;
	const br = ( b >> 16 ) & 255, bg = ( b >> 8 ) & 255, bb = b & 255;
	const r = Math.round( lerp( ar, br, t ) );
	const g = Math.round( lerp( ag, bg, t ) );
	const bl = Math.round( lerp( ab, bb, t ) );
	return 'rgb(' + r + ',' + g + ',' + bl + ')';
}

function sizeCanvas( cv, cssW, cssH ) {
	const dpr = Math.min( window.devicePixelRatio || 1, DPR_CAP );
	const w = Math.max( 1, Math.round( cssW * dpr ) );
	const h = Math.max( 1, Math.round( cssH * dpr ) );
	if ( cv.width !== w || cv.height !== h ) {
		cv.width = w;
		cv.height = h;
	}
	return dpr;
}

// Short, punchy weapon-family key for the CSS-drawn killfeed glyph.
function weaponFamily( name ) {
	const s = String( name || '' ).toLowerCase();
	if ( /pistol|sidearm|handgun|revolver/.test( s ) ) return 'pistol';
	if ( /smg|machine\s?pistol|vector|micro/.test( s ) ) return 'smg';
	if ( /shot|slug|breach|pump/.test( s ) ) return 'shotgun';
	if ( /sniper|marksman|dmr|bolt|scout/.test( s ) ) return 'sniper';
	return 'rifle';
}

/* ------------------------------------------------------------------- HUD */

export function createHUD( rootEl ) {

	const root = rootEl || document.getElementById( 'ui-root' ) || document.body;

	/* ---------------------------------------------------------- structure */

	const hud = el( 'div', 'op-hud', root );
	hud.id = 'op-hud';
	hud.setAttribute( 'aria-hidden', 'true' );

	el( 'div', 'op-scrims', hud );

	// low-health edge treatment (subtle, edge-only — composes with the 3D vignette)
	const edges = el( 'div', 'op-edges', hud );
	edges.id = 'op-edges';
	el( 'div', 'op-edges__in', edges );

	const flash = el( 'div', 'op-flash', hud );

	// --- radar cluster -----------------------------------------------------
	const radar = el( 'div', 'op-radar', hud );
	radar.id = 'op-radar';
	const minimapCanvas = el( 'canvas', 'op-radar__c', radar );
	minimapCanvas.id = 'op-minimap';
	const radarTag = el( 'div', 'op-radar__tag', radar );
	radarTag.textContent = 'TAC-NET // 40M';

	// --- score / streak ----------------------------------------------------
	const scoreBox = el( 'div', 'op-score', hud );
	scoreBox.id = 'op-score';
	const scoreTop = el( 'div', 'op-score__row', scoreBox );
	const scoreLbl = el( 'div', 'op-label', scoreTop );
	scoreLbl.textContent = 'SCORE';
	const scoreWave = el( 'div', 'op-score__wave', scoreTop );
	scoreWave.textContent = 'WAVE --';
	const scoreVal = el( 'div', 'op-score__v op-num', scoreBox );
	scoreVal.textContent = '0';
	const streak = el( 'div', 'op-streak', scoreBox );
	const streakN = el( 'span', 'op-streak__n op-num', streak );
	const streakT = el( 'span', 'op-streak__t', streak );
	streakT.textContent = 'STREAK';

	// --- compass -----------------------------------------------------------
	const compass = el( 'div', 'op-compass', hud );
	compass.id = 'op-compass';
	const compassStrip = el( 'div', 'op-compass__strip', compass );
	const compassCv = el( 'canvas', 'op-compass__c', compassStrip );
	const compassCtx = compassCv.getContext( '2d' );
	el( 'div', 'op-compass__pip', compass );
	const compassDeg = el( 'div', 'op-compass__deg', compass );
	compassDeg.textContent = '000\u00B0';

	// --- perf --------------------------------------------------------------
	const perf = el( 'div', 'op-perf', hud );
	perf.id = 'op-perf';
	const perfFps = el( 'span', 'op-perf__fps', perf );
	perfFps.textContent = '--';
	el( 'span', 'op-perf__sep', perf );
	const perfMs = el( 'span', 'op-perf__ms', perf );
	perfMs.textContent = '--';
	el( 'span', 'op-perf__sep', perf );
	const perfDc = el( 'span', 'op-perf__dc', perf );
	perfDc.textContent = '--';

	// --- killfeed ----------------------------------------------------------
	const killfeed = el( 'div', 'op-killfeed', hud );
	killfeed.id = 'op-killfeed';

	// --- centre stack ------------------------------------------------------
	const center = el( 'div', 'op-center', hud );
	const dmgring = el( 'div', 'op-dmgring', center );
	const xhairCv = el( 'canvas', 'op-crosshair', center );
	xhairCv.id = 'op-crosshair';
	const xhairCtx = xhairCv.getContext( '2d' );
	const hitmarker = el( 'div', 'op-hitmarker', center );
	hitmarker.id = 'op-hitmarker';
	for ( let i = 0; i < 4; i ++ ) el( 'i', 'op-hm__t', hitmarker );
	const dmgnums = el( 'div', 'op-dmgnums', center );

	// --- banner ------------------------------------------------------------
	const banner = el( 'div', 'op-banner', hud );
	banner.id = 'op-banner';
	el( 'div', 'op-banner__bar op-banner__bar--top', banner );
	const bannerBody = el( 'div', 'op-banner__body', banner );
	const bannerK = el( 'div', 'op-banner__k', bannerBody );
	const bannerT = el( 'div', 'op-banner__t', bannerBody );
	const bannerS = el( 'div', 'op-banner__s', bannerBody );
	el( 'div', 'op-banner__bar op-banner__bar--bot', banner );

	// --- toast -------------------------------------------------------------
	const toast = el( 'div', 'op-toast', hud );
	toast.id = 'op-toast';
	const toastT = el( 'div', 'op-toast__t', toast );
	const toastS = el( 'div', 'op-toast__s', toast );

	// --- ammo --------------------------------------------------------------
	const ammo = el( 'div', 'op-ammo op-bracket op-bracket--r', hud );
	ammo.id = 'op-ammo';
	const ammoHead = el( 'div', 'op-ammo__head', ammo );
	const ammoName = el( 'div', 'op-ammo__name', ammoHead );
	ammoName.textContent = 'NO WEAPON';
	const ammoMode = el( 'div', 'op-chip op-ammo__mode', ammoHead );
	ammoMode.textContent = '--';
	const ammoBody = el( 'div', 'op-ammo__body', ammo );
	const reload = el( 'div', 'op-reload', ammoBody );
	el( 'div', 'op-reload__track', reload );
	const reloadFill = el( 'div', 'op-reload__fill', reload );
	const reloadI = el( 'div', 'op-reload__i', reload );
	reloadI.textContent = 'RLD';
	const ammoCounts = el( 'div', 'op-ammo__counts', ammoBody );
	const ammoMag = el( 'div', 'op-ammo__mag op-num', ammoCounts );
	ammoMag.textContent = '--';
	const ammoSlash = el( 'div', 'op-ammo__slash', ammoCounts );
	ammoSlash.textContent = '/';
	const ammoRes = el( 'div', 'op-ammo__res op-num', ammoCounts );
	ammoRes.textContent = '--';
	const ammoSegs = el( 'div', 'op-seg op-ammo__segs', ammo );

	// --- health ------------------------------------------------------------
	const health = el( 'div', 'op-health op-bracket op-bracket--l', hud );
	health.id = 'op-health';
	const healthHead = el( 'div', 'op-health__head', health );
	const healthLbl = el( 'div', 'op-label', healthHead );
	healthLbl.textContent = 'VITALS';
	const healthVal = el( 'div', 'op-health__v op-num', healthHead );
	healthVal.textContent = '100';
	const healthUnit = el( 'div', 'op-health__u', healthHead );
	healthUnit.textContent = 'HP';
	const healthBar = el( 'div', 'op-seg op-health__bar', health );
	const healthSegs = [];
	for ( let i = 0; i < 12; i ++ ) healthSegs.push( el( 'i', 'op-seg__i', healthBar ) );
	const healthShim = el( 'div', 'op-health__shimmer', healthBar );

	/* ------------------------------------------------------------- pools */

	// damage numbers
	const dmgPool = [];
	for ( let i = 0; i < POOL_DMG; i ++ ) {
		const n = el( 'div', 'op-dmg', dmgnums );
		dmgPool.push( { el: n, live: false, t: 0, life: 0.9, x: 0, y: 0, vx: 0, vy: 0 } );
	}
	let dmgCursor = 0;
	let dmgAngle = 0;

	// directional damage wedges
	const wedgePool = [];
	for ( let i = 0; i < POOL_WEDGE; i ++ ) {
		const n = el( 'div', 'op-wedge', dmgring );
		wedgePool.push( { el: n, live: false, t: 0, life: 1.2, a: 0, amt: 1 } );
	}
	let wedgeCursor = 0;

	// killfeed rows
	const kfPool = [];
	for ( let i = 0; i < POOL_KF; i ++ ) {
		const row = el( 'div', 'op-kf', killfeed );
		const a = el( 'span', 'op-kf__a', row );
		const w = el( 'span', 'op-kf__w', row );
		const hs = el( 'span', 'op-kf__hs', row );
		const b = el( 'span', 'op-kf__b', row );
		kfPool.push( { el: row, a, w, hs, b, live: false, t: 0, out: false } );
	}
	const kfLive = [];

	// magazine segments (rebuilt only on weapon:equipped)
	const magSegs = [];
	function buildMagSegs( count ) {
		while ( magSegs.length < count ) magSegs.push( el( 'i', 'op-seg__i', ammoSegs ) );
		for ( let i = 0; i < magSegs.length; i ++ ) {
			const want = i < count ? '' : 'none';
			setStyle( magSegs[ i ], 'display', want );
		}
	}

	/* -------------------------------------------------------------- state */

	const S = {
		visible: true,

		// crosshair
		spread: 0, spreadTarget: 0, spreadVel: 0,
		fireKick: 0,
		ads: 0, adsTarget: 0,
		hot: false,
		xhairDirty: true,

		// hitmarker
		hmT: - 1, hmDur: 0.14, hmKind: 'normal',

		// player orientation from radar:enemies
		yaw: 0,
		_lastYaw: NaN,

		// ammo
		magSize: 0, ammoCur: 0, reserve: 0,
		reloading: false, reloadT: 0, reloadDur: 1,

		// health
		hp: 100, hpMax: 100, hpShown: - 1,
		regenT: 0,
		edgeShown: - 1,
		flashT: 0, flashAmp: 0,

		// score / streak
		score: 0, scoreShown: 0, streak: 0, streakBumpT: 0,
		wave: 0,

		// banner / toast
		bannerT: 0, toastT: 0,

		// throttles
		acc30: 0,
		compassW: 0,
		showFps: null,
	};

	/* ------------------------------------------------------------ painting */

	function paintCrosshair() {
		const dpr = sizeCanvas( xhairCv, 160, 160 );
		const ctx = xhairCtx;
		const w = xhairCv.width, h = xhairCv.height;
		ctx.setTransform( 1, 0, 0, 1, 0, 0 );
		ctx.clearRect( 0, 0, w, h );

		const adsHide = clamp( ( S.ads - 0.82 ) / 0.14, 0, 1 );
		const alpha = 1 - adsHide;
		setStyle( xhairCv, 'opacity', alpha < 0.02 ? '0' : alpha.toFixed( 2 ) );
		if ( alpha < 0.02 ) return;

		const scale = clamp( settings.crosshairScale || 1, 0.5, 2 ) * dpr;
		const cx = w * 0.5, cy = h * 0.5;

		const openness = clamp( S.spread + S.fireKick, 0, 1.6 );
		const tighten = lerp( 1, 0.16, S.ads );
		const gap = ( 5 + openness * 22 ) * tighten * scale;
		const len = ( 9 + openness * 5 ) * lerp( 1, 0.6, S.ads ) * scale;
		const thick = Math.max( 1.5, 2 * scale );

		const col = S.hot ? '#ffb347' : '#f2f7fa';

		ctx.lineCap = 'butt';

		// dark backing stroke keeps the reticle readable on a sunlit wall
		for ( let pass = 0; pass < 2; pass ++ ) {
			ctx.strokeStyle = pass === 0 ? 'rgba(0,0,0,0.78)' : col;
			ctx.lineWidth = pass === 0 ? thick + 2.8 * dpr : thick;
			ctx.beginPath();
			// up / down / left / right
			ctx.moveTo( cx, cy - gap ); ctx.lineTo( cx, cy - gap - len );
			ctx.moveTo( cx, cy + gap ); ctx.lineTo( cx, cy + gap + len );
			ctx.moveTo( cx - gap, cy ); ctx.lineTo( cx - gap - len, cy );
			ctx.moveTo( cx + gap, cy ); ctx.lineTo( cx + gap + len, cy );
			ctx.stroke();
		}

		// centre dot
		const dot = Math.max( 1.2, 1.5 * scale );
		ctx.fillStyle = 'rgba(0,0,0,0.72)';
		ctx.beginPath();
		ctx.arc( cx, cy, dot + 1.4 * dpr, 0, Math.PI * 2 );
		ctx.fill();
		ctx.fillStyle = col;
		ctx.beginPath();
		ctx.arc( cx, cy, dot, 0, Math.PI * 2 );
		ctx.fill();

		// target lock corners — subtle amber brackets when a hostile is centred
		if ( S.hot ) {
			const r = gap + len + 5 * scale;
			const arm = 3.6 * scale;
			ctx.strokeStyle = 'rgba(255,179,71,0.9)';
			ctx.lineWidth = Math.max( 1, 1.2 * scale );
			ctx.beginPath();
			for ( let i = 0; i < 4; i ++ ) {
				const sx = i === 0 || i === 3 ? - 1 : 1;
				const sy = i < 2 ? - 1 : 1;
				ctx.moveTo( cx + sx * r, cy + sy * r - sy * arm );
				ctx.lineTo( cx + sx * r, cy + sy * r );
				ctx.lineTo( cx + sx * r - sx * arm, cy + sy * r );
			}
			ctx.stroke();
		}
	}

	function paintCompass() {
		const cssW = compass.clientWidth || 380;
		const cssH = 30;
		const dpr = sizeCanvas( compassCv, cssW, cssH );
		const ctx = compassCtx;
		const w = compassCv.width, h = compassCv.height;
		ctx.setTransform( 1, 0, 0, 1, 0, 0 );
		ctx.clearRect( 0, 0, w, h );

		const span = 120; // degrees across the strip
		const pxPerDeg = w / span;
		const heading = ( ( - S.yaw * 180 / Math.PI ) % 360 + 360 ) % 360;

		// baseline (dark backing keeps it alive over a sunlit wall)
		ctx.fillStyle = 'rgba(0,0,0,0.45)';
		ctx.fillRect( 0, h - 3 * dpr, w, 3 * dpr );
		ctx.fillStyle = 'rgba(232,238,242,0.3)';
		ctx.fillRect( 0, h - 2 * dpr, w, 1 * dpr );

		const start = Math.floor( ( heading - span / 2 ) / 5 ) * 5;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'alphabetic';

		for ( let d = start; d <= heading + span / 2; d += 5 ) {
			const x = ( d - ( heading - span / 2 ) ) * pxPerDeg;
			if ( x < - 20 || x > w + 20 ) continue;
			const norm = ( ( d % 360 ) + 360 ) % 360;
			const major = norm % 45 === 0;
			const mid = norm % 15 === 0;

			const tickH = major ? 9 : mid ? 6 : 3.5;
			const tx = Math.round( x ) - 0.5 * dpr;
			const tw = Math.max( 1, dpr );
			ctx.fillStyle = 'rgba(0,0,0,0.5)';
			ctx.fillRect( tx - dpr, h - ( 2 + tickH ) * dpr - dpr, tw + 2 * dpr, tickH * dpr + dpr );
			ctx.fillStyle = major ? 'rgba(242,247,250,0.95)' : mid ? 'rgba(232,238,242,0.6)' : 'rgba(232,238,242,0.38)';
			ctx.fillRect( tx, h - ( 2 + tickH ) * dpr, tw, tickH * dpr );

			if ( major ) {
				const label = CARDINALS[ ( norm / 45 ) | 0 ];
				const isN = label === 'N';
				ctx.font = ( isN ? '700 ' : '500 ' ) + ( isN ? 12 : 10.5 ) * dpr +
					'px ui-monospace, "SF Mono", Menlo, monospace';
				ctx.shadowColor = 'rgba(0,0,0,0.95)';
				ctx.shadowBlur = 5 * dpr;
				ctx.fillStyle = isN ? '#ffb347' : '#eef4f8';
				ctx.fillText( label, x, h - 14 * dpr );
				ctx.fillText( label, x, h - 14 * dpr );
				ctx.shadowBlur = 0;
			}
		}

		const deg = Math.round( heading ) % 360;
		setText( compassDeg, ( deg < 100 ? ( deg < 10 ? '00' : '0' ) : '' ) + deg + '\u00B0' );
	}

	/* ------------------------------------------------------------ spawners */

	function spawnDamageNumber( amount, kind ) {
		const p = dmgPool[ dmgCursor ];
		dmgCursor = ( dmgCursor + 1 ) % POOL_DMG;

		// golden-angle stepping keeps rapid-fire numbers from stacking up
		dmgAngle += 2.39996;
		const a = dmgAngle + ( Math.random() - 0.5 ) * 0.5;
		const r = 22 + Math.random() * 18;
		p.x = Math.cos( a ) * r * 1.5;
		p.y = Math.sin( a ) * r * 0.75 - 14;
		p.vx = Math.cos( a ) * ( 26 + Math.random() * 22 );
		p.vy = - ( 34 + Math.random() * 26 );
		p.t = 0;
		p.life = kind === 'head' ? 1.0 : 0.82;
		p.live = true;

		setAttr( p.el, 'data-kind', kind );
		setText( p.el, String( Math.max( 1, Math.round( amount ) ) ) );
		p.el.style.opacity = '1';
	}

	function spawnWedge( dir, amount ) {
		if ( ! dir ) return;
		const dx = dir.x || 0, dz = dir.z || 0;
		if ( Math.abs( dx ) < 1e-5 && Math.abs( dz ) < 1e-5 ) return;
		const p = wedgePool[ wedgeCursor ];
		wedgeCursor = ( wedgeCursor + 1 ) % POOL_WEDGE;
		// world bearing of the incoming direction, rotated into screen space
		p.a = Math.atan2( dx, - dz ) + S.yaw;
		p.t = 0;
		p.live = true;
		p.amt = clamp( ( amount || 10 ) / 26, 0.45, 1 );
		p.el.style.opacity = '0';
	}

	function pushKill( actor, victim, weapon, headshot ) {
		// keep at most KF_MAX rows on screen
		let liveCount = 0;
		for ( let i = 0; i < kfLive.length; i ++ ) if ( ! kfLive[ i ].out ) liveCount ++;
		if ( liveCount >= KF_MAX ) {
			for ( let i = kfLive.length - 1; i >= 0; i -- ) {
				if ( ! kfLive[ i ].out ) { retireKill( kfLive[ i ] ); break; }
			}
		}

		let row = null;
		for ( let i = 0; i < kfPool.length; i ++ ) if ( ! kfPool[ i ].live ) { row = kfPool[ i ]; break; }
		if ( ! row ) { row = kfLive[ kfLive.length - 1 ]; releaseKill( row ); }

		setText( row.a, actor );
		setText( row.b, victim );
		setAttr( row.w, 'data-w', weaponFamily( weapon ) );
		setAttr( row.el, 'data-hs', headshot ? '1' : '0' );

		row.live = true;
		row.out = false;
		row.t = 0;
		row.el.classList.remove( 'is-out' );
		row.el.classList.remove( 'is-live' );
		// force a reflow so the entry animation restarts for a recycled node
		void row.el.offsetWidth;
		row.el.classList.add( 'is-live' );

		killfeed.insertBefore( row.el, killfeed.firstChild );
		const idx = kfLive.indexOf( row );
		if ( idx >= 0 ) kfLive.splice( idx, 1 );
		kfLive.unshift( row );
	}

	function retireKill( row ) {
		if ( row.out ) return;
		row.out = true;
		row.t = 0;
		row.el.classList.add( 'is-out' );
	}

	function releaseKill( row ) {
		row.live = false;
		row.out = false;
		row.el.classList.remove( 'is-live', 'is-out' );
		const idx = kfLive.indexOf( row );
		if ( idx >= 0 ) kfLive.splice( idx, 1 );
	}

	function showBanner( kicker, title, sub, tone, hold ) {
		setText( bannerK, kicker );
		setText( bannerT, title );
		setText( bannerS, sub );
		setAttr( banner, 'data-tone', tone );
		banner.classList.remove( 'is-in' );
		void banner.offsetWidth;
		banner.classList.add( 'is-in' );
		S.bannerT = hold || 2.8;
	}

	function showToast( text, sub ) {
		setText( toastT, String( text || '' ).toUpperCase() );
		setText( toastS, String( sub || '' ).toUpperCase() );
		setStyle( toastS, 'display', sub ? '' : 'none' );
		toast.classList.add( 'is-in' );
		S.toastT = 2.6;
	}

	/* -------------------------------------------------------------- writers */

	function writeAmmo() {
		const cur = S.ammoCur;
		setText( ammoMag, S.magSize > 0 ? pad2( cur ) : '--' );
		setText( ammoRes, S.magSize > 0 ? String( S.reserve ) : '--' );

		const frac = S.magSize > 0 ? cur / S.magSize : 1;
		ammo.classList.toggle( 'is-low', cur > 0 && frac <= 0.34 );
		ammo.classList.toggle( 'is-empty', S.magSize > 0 && cur === 0 );

		const n = magSegs.length;
		if ( ! n ) return;
		const shownSegs = Math.min( n, S.magSize > 0 ? Math.min( S.magSize, 40 ) : 0 );
		const onCount = S.magSize > 0 ? Math.ceil( ( cur / S.magSize ) * shownSegs ) : 0;
		for ( let i = 0; i < shownSegs; i ++ ) {
			const on = i < onCount;
			const seg = magSegs[ i ];
			if ( seg._on !== on ) { seg._on = on; seg.classList.toggle( 'is-on', on ); }
		}
	}

	function writeHealth() {
		const hp = Math.max( 0, Math.round( S.hp ) );
		if ( S.hpShown === hp ) return;
		S.hpShown = hp;
		setText( healthVal, String( hp ) );

		const t = clamp( S.hpMax > 0 ? hp / S.hpMax : 0, 0, 1 );
		// off-white -> amber -> red, losing saturation headroom as it drops
		let col, glow;
		if ( t > 0.55 ) {
			col = mixHex( 0xffb347, 0xe8eef2, clamp( ( t - 0.55 ) / 0.45, 0, 1 ) );
			glow = 'rgba(232,238,242,0.45)';
		} else if ( t > 0.28 ) {
			col = mixHex( 0xff6a4d, 0xffb347, clamp( ( t - 0.28 ) / 0.27, 0, 1 ) );
			glow = 'rgba(255,179,71,0.6)';
		} else {
			col = mixHex( 0xb02020, 0xff4d4d, clamp( t / 0.28, 0, 1 ) );
			glow = 'rgba(255,77,77,0.7)';
		}
		setStyle( health, '--hp-col', col );
		setStyle( health, '--hp-glow', glow );
		health.classList.toggle( 'is-critical', t <= 0.3 );

		const n = healthSegs.length;
		const onCount = Math.ceil( t * n );
		for ( let i = 0; i < n; i ++ ) {
			const on = i < onCount;
			const seg = healthSegs[ i ];
			if ( seg._on !== on ) { seg._on = on; seg.classList.toggle( 'is-on', on ); }
		}
	}

	function writeStreak() {
		const s = S.streak;
		if ( s < 2 ) {
			streak.classList.remove( 'is-on' );
			return;
		}
		streak.classList.add( 'is-on' );
		setText( streakN, '\u00D7' + s );
		const tier = s >= 10 ? 4 : s >= 7 ? 3 : s >= 4 ? 2 : 1;
		setAttr( streak, 'data-tier', String( tier ) );
		setText( streakT, tier >= 4 ? 'RAMPAGE' : tier === 3 ? 'DOMINANT' : 'STREAK' );
		streak.classList.add( 'is-bump' );
		S.streakBumpT = 0.16;
	}

	/* ------------------------------------------------------------ bus wiring */

	const offs = [];
	const on = ( name, fn ) => offs.push( bus.on( name, fn ) );

	on( 'weapon:equipped', ( p ) => {
		if ( ! p ) return;
		S.magSize = p.magSize || 0;
		S.ammoCur = p.ammo != null ? p.ammo : 0;
		S.reserve = p.reserve != null ? p.reserve : 0;
		S.reloading = false;
		reload.classList.remove( 'is-on' );
		setText( ammoName, String( p.name || p.id || 'WEAPON' ).toUpperCase() );
		setText( ammoMode, String( p.fireMode || 'SEMI' ).toUpperCase() );
		buildMagSegs( Math.min( Math.max( S.magSize, 1 ), 40 ) );
		writeAmmo();
		ammo.classList.remove( 'is-equip' );
		void ammo.offsetWidth;
		ammo.classList.add( 'is-equip' );
	} );

	on( 'weapon:fire', ( p ) => {
		if ( p ) {
			if ( p.ammo != null ) S.ammoCur = p.ammo;
			if ( p.reserve != null ) S.reserve = p.reserve;
			writeAmmo();
		}
		S.fireKick = Math.min( 0.55, S.fireKick + 0.16 );
		S.xhairDirty = true;
	} );

	on( 'weapon:dry', () => {
		ammo.classList.remove( 'is-dry' );
		void ammo.offsetWidth;
		ammo.classList.add( 'is-dry' );
		setStyle( ammoSlash, 'color', 'var(--c-danger)' );
		window.setTimeout( () => setStyle( ammoSlash, 'color', '' ), 420 );
	} );

	on( 'weapon:reloadStart', ( p ) => {
		S.reloading = true;
		S.reloadDur = Math.max( 0.15, ( p && p.duration ) || 1.6 );
		S.reloadT = 0;
		reload.classList.add( 'is-on' );
		setStyle( reloadFill, '--p', '0' );
	} );

	on( 'weapon:reloadEnd', ( p ) => {
		S.reloading = false;
		reload.classList.remove( 'is-on' );
		if ( p ) {
			if ( p.ammo != null ) S.ammoCur = p.ammo;
			if ( p.reserve != null ) S.reserve = p.reserve;
		}
		writeAmmo();
	} );

	on( 'weapon:ads', ( p ) => { S.adsTarget = p && p.active ? 1 : 0; S.xhairDirty = true; } );
	on( 'weapon:spread', ( p ) => { S.spreadTarget = clamp( ( p && p.value01 ) || 0, 0, 1 ); } );

	on( 'hit:confirm', ( p ) => {
		const headshot = !! ( p && p.headshot );
		const killed = !! ( p && p.killed );
		S.hmKind = killed ? 'kill' : headshot ? 'head' : 'normal';
		S.hmDur = killed ? 0.2 : headshot ? 0.16 : 0.14;
		S.hmT = 0;
		setAttr( hitmarker, 'data-kind', S.hmKind );
		if ( p && p.damage ) spawnDamageNumber( p.damage, killed ? 'kill' : headshot ? 'head' : 'normal' );
	} );

	on( 'enemy:killed', ( p ) => {
		pushKill( 'YOU', String( ( p && p.name ) || 'HOSTILE' ).toUpperCase(), p && p.weapon, p && p.headshot );
		S.streak ++;
		writeStreak();
	} );

	on( 'score:add', ( p ) => { if ( p && p.amount ) S.score += p.amount; } );

	on( 'player:damaged', ( p ) => {
		if ( ! p ) return;
		if ( p.maxHealth ) S.hpMax = p.maxHealth;
		if ( p.health != null ) S.hp = p.health;
		writeHealth();
		spawnWedge( p.dirWorld, p.amount );
		S.flashAmp = clamp( ( p.amount || 10 ) / 30, 0.2, 1 ) * FLASH_MAX;
		S.flashT = 0.34;
	} );

	on( 'player:healed', ( p ) => {
		if ( p && p.health != null ) S.hp = p.health;
		writeHealth();
		S.regenT = 1.2;
		health.classList.add( 'is-regen' );
	} );

	on( 'player:died', () => {
		S.hp = 0;
		writeHealth();
		S.streak = 0;
		writeStreak();
		streak.classList.remove( 'is-on' );
	} );

	on( 'radar:enemies', ( p ) => {
		if ( ! p ) return;
		if ( p.player && typeof p.player.yaw === 'number' ) S.yaw = p.player.yaw;

		// derive "aiming at a hostile" from radar geometry (no gameplay imports)
		let hot = false;
		if ( p.list && p.player ) {
			const fx = - Math.sin( S.yaw ), fz = - Math.cos( S.yaw );
			for ( let i = 0; i < p.list.length; i ++ ) {
				const e = p.list[ i ];
				if ( ! e || e.alive === false || e.visible === false ) continue;
				const dx = e.x - p.player.x, dz = e.z - p.player.z;
				const d = Math.hypot( dx, dz );
				if ( d < 0.01 || d > 70 ) continue;
				const dot = ( dx * fx + dz * fz ) / d;
				if ( dot > 0.9993 ) { hot = true; break; } // ~2.2 degrees
			}
		}
		if ( hot !== S.hot ) { S.hot = hot; S.xhairDirty = true; }
	} );

	on( 'wave:start', ( p ) => {
		S.wave = ( p && p.wave ) || S.wave + 1;
		setText( scoreWave, 'WAVE ' + pad2( S.wave ) );
		const n = ( p && p.enemyCount ) || 0;
		showBanner( 'HOSTILE CONTACT', 'WAVE ' + pad2( S.wave ),
			n ? n + ' TANGO' + ( n === 1 ? '' : 'S' ) + ' INBOUND' : 'STAND BY', 'start', 2.8 );
	} );

	on( 'wave:clear', ( p ) => {
		const w = ( p && p.wave ) || S.wave;
		const bonus = ( p && p.bonus ) || 0;
		showBanner( 'SECTOR SECURE', 'WAVE ' + pad2( w ) + ' CLEAR',
			bonus ? '+' + bonus + ' BONUS' : 'REARM AND HOLD', 'clear', 2.6 );
	} );

	on( 'ui:toast', ( p ) => { if ( p ) showToast( p.text, p.sub ); } );

	on( 'perf:sample', ( p ) => {
		if ( ! p ) return;
		const fps = Math.round( p.fps || 0 );
		setText( perfFps, fps + ' FPS' );
		setAttr( perfFps, 'data-q', fps >= 55 ? 'good' : fps >= 34 ? 'ok' : 'bad' );
		setText( perfMs, ( p.frameMs != null ? p.frameMs.toFixed( 1 ) : '--' ) + ' MS' );
		const tris = p.tris || 0;
		const triStr = tris >= 1000 ? ( tris / 1000 ).toFixed( 0 ) + 'K' : String( tris );
		setText( perfDc, ( p.calls || 0 ) + ' DC / ' + triStr + ' TRI' );
	} );

	on( 'game:start', () => { reset(); } );
	on( 'game:over', () => { S.streak = 0; writeStreak(); streak.classList.remove( 'is-on' ); } );

	/* --------------------------------------------------------------- update */

	function onResize() { S.xhairDirty = true; S.compassW = 0; }
	window.addEventListener( 'resize', onResize, { passive: true } );

	function update( dt ) {
		if ( ! ( dt > 0 ) ) dt = 0.016;
		if ( dt > 0.1 ) dt = 0.1;

		/* --- crosshair spring ------------------------------------------- */
		const k = 190, damp = 26;
		const target = S.spreadTarget;
		S.spreadVel += ( ( target - S.spread ) * k - S.spreadVel * damp ) * dt;
		S.spread += S.spreadVel * dt;
		if ( Math.abs( S.spread - target ) > 0.0015 || Math.abs( S.spreadVel ) > 0.01 ) S.xhairDirty = true;

		if ( S.fireKick > 0 ) {
			S.fireKick = Math.max( 0, S.fireKick - dt * 2.1 );
			S.xhairDirty = true;
		}

		if ( S.ads !== S.adsTarget ) {
			const step = dt / 0.14;
			S.ads = S.adsTarget > S.ads ? Math.min( S.adsTarget, S.ads + step ) : Math.max( S.adsTarget, S.ads - step );
			S.xhairDirty = true;
		}

		/* --- hitmarker ---------------------------------------------------- */
		if ( S.hmT >= 0 ) {
			S.hmT += dt;
			const p = S.hmT / S.hmDur;
			if ( p >= 1 ) {
				S.hmT = - 1;
				hitmarker.style.opacity = '0';
			} else {
				let s, o;
				if ( p < 0.2 ) {
					const q = p / 0.2;
					s = lerp( 0.5, 1.2, q * ( 2 - q ) );
					o = 1;
				} else {
					const q = ( p - 0.2 ) / 0.8;
					s = lerp( 1.2, 1.62, q * q );
					o = 1 - q * q;
				}
				const rot = S.hmKind === 'kill' ? lerp( - 16, 0, Math.min( 1, p * 2.4 ) ) : 0;
				hitmarker.style.opacity = o.toFixed( 3 );
				hitmarker.style.transform = 'rotate(' + rot.toFixed( 2 ) + 'deg) scale(' + s.toFixed( 3 ) + ')';
			}
		}

		/* --- damage numbers ------------------------------------------------ */
		for ( let i = 0; i < POOL_DMG; i ++ ) {
			const p = dmgPool[ i ];
			if ( ! p.live ) continue;
			p.t += dt;
			const q = p.t / p.life;
			if ( q >= 1 ) {
				p.live = false;
				p.el.style.opacity = '0';
				continue;
			}
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			p.vy += 46 * dt;      // gentle settle
			p.vx *= 1 - 1.6 * dt;
			const pop = q < 0.12 ? lerp( 1.4, 1, q / 0.12 ) : 1;
			const fade = q < 0.62 ? 1 : 1 - ( q - 0.62 ) / 0.38;
			p.el.style.opacity = fade.toFixed( 3 );
			p.el.style.transform = 'translate3d(' + p.x.toFixed( 1 ) + 'px,' + p.y.toFixed( 1 ) + 'px,0) scale(' + pop.toFixed( 3 ) + ')';
		}

		/* --- directional wedges -------------------------------------------- */
		for ( let i = 0; i < POOL_WEDGE; i ++ ) {
			const p = wedgePool[ i ];
			if ( ! p.live ) continue;
			p.t += dt;
			const q = p.t / p.life;
			if ( q >= 1 ) {
				p.live = false;
				p.el.style.opacity = '0';
				continue;
			}
			const inT = Math.min( 1, q / 0.08 );
			const o = ( q < 0.08 ? inT : 1 - ( q - 0.08 ) / 0.92 ) * p.amt;
			const s = lerp( 0.86, 1.06, Math.min( 1, q * 3 ) );
			p.el.style.opacity = o.toFixed( 3 );
			p.el.style.transform = 'rotate(' + ( p.a * 180 / Math.PI ).toFixed( 2 ) + 'deg) scale(' + s.toFixed( 3 ) + ')';
		}

		/* --- killfeed lifetimes --------------------------------------------- */
		for ( let i = kfLive.length - 1; i >= 0; i -- ) {
			const row = kfLive[ i ];
			row.t += dt;
			if ( ! row.out && row.t >= KF_LIFE ) retireKill( row );
			else if ( row.out && row.t >= 0.32 ) releaseKill( row );
		}

		/* --- reload arc ------------------------------------------------------ */
		if ( S.reloading ) {
			S.reloadT += dt;
			const p = clamp( S.reloadT / S.reloadDur, 0, 1 );
			setStyle( reloadFill, '--p', p.toFixed( 3 ) );
			if ( p >= 1 ) { S.reloading = false; reload.classList.remove( 'is-on' ); }
		}

		/* --- health flourishes ----------------------------------------------- */
		if ( S.regenT > 0 ) {
			S.regenT -= dt;
			if ( S.regenT <= 0 ) health.classList.remove( 'is-regen' );
		}

		// Hard-capped: the 3D pass owns the heavy lifting, this only tints the
		// outermost edge so the two never stack into a red flood.
		const hp01 = clamp( S.hpMax > 0 ? S.hp / S.hpMax : 0, 0, 1 );
		const edgeAmt = clamp( ( 0.38 - hp01 ) / 0.38, 0, 1 );
		const edgeOp = Math.min( EDGE_MAX, Math.pow( edgeAmt, 1.3 ) * EDGE_MAX );
		if ( Math.abs( edgeOp - S.edgeShown ) > 0.01 ) {
			S.edgeShown = edgeOp;
			edges.style.opacity = edgeOp.toFixed( 3 );
		}

		if ( S.flashT > 0 ) {
			S.flashT -= dt;
			const o = Math.max( 0, S.flashT / 0.34 ) * S.flashAmp;
			flash.style.opacity = o.toFixed( 3 );
			if ( S.flashT <= 0 ) flash.style.opacity = '0';
		}

		/* --- score count-up ---------------------------------------------------- */
		if ( S.scoreShown !== S.score ) {
			const diff = S.score - S.scoreShown;
			const step = Math.max( 1, Math.abs( diff ) * Math.min( 1, dt * 7 ) );
			S.scoreShown += diff > 0 ? Math.min( step, diff ) : Math.max( - step, diff );
			if ( Math.abs( S.score - S.scoreShown ) < 1 ) S.scoreShown = S.score;
			setText( scoreVal, String( Math.round( S.scoreShown ) ) );
		}

		if ( S.streakBumpT > 0 ) {
			S.streakBumpT -= dt;
			if ( S.streakBumpT <= 0 ) streak.classList.remove( 'is-bump' );
		}

		/* --- banner / toast ----------------------------------------------------- */
		if ( S.bannerT > 0 ) {
			S.bannerT -= dt;
			if ( S.bannerT <= 0 ) banner.classList.remove( 'is-in' );
		}
		if ( S.toastT > 0 ) {
			S.toastT -= dt;
			if ( S.toastT <= 0 ) toast.classList.remove( 'is-in' );
		}

		/* --- settings-driven toggles -------------------------------------------- */
		if ( S.showFps !== settings.showFps ) {
			S.showFps = settings.showFps;
			perf.classList.toggle( 'is-on', !! settings.showFps );
		}

		/* --- 30Hz canvas work ----------------------------------------------------- */
		S.acc30 += dt;
		if ( S.acc30 >= TICK_30 ) {
			S.acc30 = S.acc30 % TICK_30;
			if ( S.xhairDirty ) { paintCrosshair(); S.xhairDirty = false; }
			const w = compass.clientWidth;
			if ( w !== S.compassW || S.yaw !== S._lastYaw ) {
				S.compassW = w;
				S._lastYaw = S.yaw;
				paintCompass();
			}
		}
	}

	/* ---------------------------------------------------------------- api */

	function setVisible( b ) {
		S.visible = !! b;
		hud.classList.toggle( 'op-hud--hidden', ! S.visible );
	}

	function reset() {
		S.spread = S.spreadTarget = S.spreadVel = 0;
		S.fireKick = 0;
		S.ads = S.adsTarget = 0;
		S.hot = false;
		S.hmT = - 1;
		hitmarker.style.opacity = '0';

		for ( let i = 0; i < POOL_DMG; i ++ ) { dmgPool[ i ].live = false; dmgPool[ i ].el.style.opacity = '0'; }
		for ( let i = 0; i < POOL_WEDGE; i ++ ) { wedgePool[ i ].live = false; wedgePool[ i ].el.style.opacity = '0'; }
		for ( let i = kfLive.length - 1; i >= 0; i -- ) releaseKill( kfLive[ i ] );
		kfLive.length = 0;

		S.reloading = false;
		reload.classList.remove( 'is-on' );
		ammo.classList.remove( 'is-dry', 'is-empty', 'is-low' );

		S.hp = S.hpMax;
		S.hpShown = - 1;
		S.regenT = 0;
		health.classList.remove( 'is-regen', 'is-critical' );
		writeHealth();

		S.flashT = 0;
		flash.style.opacity = '0';
		S.edgeShown = - 1;
		edges.style.opacity = '0';

		S.score = 0;
		S.scoreShown = 0;
		setText( scoreVal, '0' );
		S.streak = 0;
		streak.classList.remove( 'is-on', 'is-bump' );
		S.wave = 0;
		setText( scoreWave, 'WAVE --' );

		S.bannerT = 0;
		banner.classList.remove( 'is-in' );
		S.toastT = 0;
		toast.classList.remove( 'is-in' );

		S.xhairDirty = true;
	}

	function destroy() {
		for ( let i = 0; i < offs.length; i ++ ) offs[ i ]();
		offs.length = 0;
		window.removeEventListener( 'resize', onResize );
		if ( hud.parentNode ) hud.parentNode.removeChild( hud );
	}

	// initial paint
	writeHealth();
	writeAmmo();
	paintCrosshair();
	paintCompass();
	perf.classList.toggle( 'is-on', !! settings.showFps );
	S.showFps = settings.showFps;

	return {
		update,
		setVisible,
		reset,
		destroy,
		root: hud,
		minimapCanvas,
	};
}

export default createHUD;
