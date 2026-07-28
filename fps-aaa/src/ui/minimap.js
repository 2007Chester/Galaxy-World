// OVERPRESSURE — tactical minimap / radar.
//
// Canvas2D, heading-up, circular mask + bezel. The static map footprint is
// rasterised to an offscreen canvas exactly once in setWorld(); the live pass
// is throttled to 30Hz and only blits that layer plus a handful of blips.

import { bus } from '../core/events.js';

const TAU = Math.PI * 2;
const TICK_30 = 1 / 30;
const DPR_CAP = 2;

const VIEW_RADIUS = 34;   // world units from the player to the bezel
const TEX_MAX = 900;      // px on the long axis of the pre-rendered wall layer

const COL_FLOOR = 'rgba(16, 34, 45, 0.5)';
const COL_WALL = 'rgba(132, 170, 192, 0.42)';
const COL_WALL_EDGE = 'rgba(186, 226, 246, 0.8)';
const COL_RING = 'rgba(232, 238, 242, 0.14)';
const COL_BEZEL = 'rgba(232, 238, 242, 0.42)';
const COL_ACCENT = '#ffb347';
const COL_HOSTILE = '#ff4d4d';

export function createMinimap( canvasEl ) {

	const canvas = canvasEl;
	const ctx = canvas ? canvas.getContext( '2d' ) : null;

	const wallTex = document.createElement( 'canvas' );
	const wallCtx = wallTex.getContext( '2d' );

	const state = {
		hasWorld: false,
		minX: - 50, minZ: - 50, maxX: 50, maxZ: 50,
		px: 0, pz: 0, yaw: 0,
		list: [],
		sweep: 0,
		pulse: 0,
		acc: 0,
		cssSize: 0,
		dpr: 1,
		alive: true,
	};

	/* ------------------------------------------------------- static layer */

	function setWorld( world ) {
		const mm = world && world.minimap;
		if ( ! mm || ! mm.min || ! mm.max ) { state.hasWorld = false; return; }

		const pad = 3;
		state.minX = mm.min.x - pad;
		state.minZ = mm.min.z - pad;
		state.maxX = mm.max.x + pad;
		state.maxZ = mm.max.z + pad;

		const wW = Math.max( 1, state.maxX - state.minX );
		const wH = Math.max( 1, state.maxZ - state.minZ );
		const texScale = TEX_MAX / Math.max( wW, wH );

		wallTex.width = Math.max( 2, Math.round( wW * texScale ) );
		wallTex.height = Math.max( 2, Math.round( wH * texScale ) );

		const c = wallCtx;
		c.setTransform( 1, 0, 0, 1, 0, 0 );
		c.clearRect( 0, 0, wallTex.width, wallTex.height );

		// world units -> texture px
		c.setTransform( texScale, 0, 0, texScale, - state.minX * texScale, - state.minZ * texScale );

		// walkable footprint tint
		c.fillStyle = COL_FLOOR;
		c.fillRect( state.minX, state.minZ, wW, wH );

		// survey grid every 8 units
		c.lineWidth = 1 / texScale;
		c.strokeStyle = 'rgba(120, 170, 195, 0.10)';
		c.beginPath();
		const g = 8;
		for ( let x = Math.ceil( state.minX / g ) * g; x < state.maxX; x += g ) {
			c.moveTo( x, state.minZ ); c.lineTo( x, state.maxZ );
		}
		for ( let z = Math.ceil( state.minZ / g ) * g; z < state.maxZ; z += g ) {
			c.moveTo( state.minX, z ); c.lineTo( state.maxX, z );
		}
		c.stroke();

		// wall footprint
		const walls = mm.walls || [];
		c.lineWidth = 1.6 / texScale;
		for ( let i = 0; i < walls.length; i ++ ) {
			const w = walls[ i ];
			if ( ! w ) continue;
			const ww = Math.max( 0.12, w.w || 0.2 );
			const hh = Math.max( 0.12, w.h || 0.2 );
			c.save();
			c.translate( w.x || 0, w.z || 0 );
			if ( w.rot ) c.rotate( w.rot );
			c.fillStyle = COL_WALL;
			c.fillRect( - ww * 0.5, - hh * 0.5, ww, hh );
			c.strokeStyle = COL_WALL_EDGE;
			c.strokeRect( - ww * 0.5, - hh * 0.5, ww, hh );
			c.restore();
		}

		c.setTransform( 1, 0, 0, 1, 0, 0 );
		state.hasWorld = true;
	}

	/* ------------------------------------------------------------ live pass */

	function resize() {
		if ( ! canvas ) return 0;
		const cssSize = canvas.clientWidth || 168;
		const dpr = Math.min( window.devicePixelRatio || 1, DPR_CAP );
		const px = Math.max( 2, Math.round( cssSize * dpr ) );
		if ( canvas.width !== px || canvas.height !== px ) {
			canvas.width = px;
			canvas.height = px;
		}
		state.cssSize = cssSize;
		state.dpr = dpr;
		return px;
	}

	function draw() {
		if ( ! ctx ) return;
		const size = resize();
		if ( ! size ) return;

		const cx = size * 0.5;
		const cy = size * 0.5;
		const rOuter = size * 0.5 - 1;
		const rIn = rOuter - size * 0.045;
		const s = rIn / VIEW_RADIUS;       // world units -> screen px

		ctx.setTransform( 1, 0, 0, 1, 0, 0 );
		ctx.clearRect( 0, 0, size, size );

		/* ---- inside the lens -------------------------------------------- */
		ctx.save();
		ctx.beginPath();
		ctx.arc( cx, cy, rIn, 0, TAU );
		ctx.clip();

		// base wash so the radar reads on any backdrop
		const wash = ctx.createRadialGradient( cx, cy, rIn * 0.1, cx, cy, rIn );
		wash.addColorStop( 0, 'rgba(6, 14, 20, 0.72)' );
		wash.addColorStop( 1, 'rgba(4, 8, 12, 0.86)' );
		ctx.fillStyle = wash;
		ctx.fillRect( 0, 0, size, size );

		if ( state.hasWorld ) {
			ctx.save();
			ctx.translate( cx, cy );
			ctx.rotate( state.yaw );
			ctx.scale( s, s );
			ctx.translate( - state.px, - state.pz );
			ctx.imageSmoothingEnabled = true;
			ctx.drawImage(
				wallTex,
				state.minX, state.minZ,
				state.maxX - state.minX, state.maxZ - state.minZ
			);
			ctx.restore();
		}

		// range rings
		ctx.strokeStyle = COL_RING;
		ctx.lineWidth = Math.max( 1, state.dpr * 0.75 );
		for ( let i = 1; i <= 2; i ++ ) {
			ctx.beginPath();
			ctx.arc( cx, cy, rIn * ( i / 3 ), 0, TAU );
			ctx.stroke();
		}
		ctx.beginPath();
		ctx.moveTo( cx, cy - rIn ); ctx.lineTo( cx, cy + rIn );
		ctx.moveTo( cx - rIn, cy ); ctx.lineTo( cx + rIn, cy );
		ctx.strokeStyle = 'rgba(232, 238, 242, 0.06)';
		ctx.stroke();

		// radar sweep — layered wedges, no conic-gradient dependency
		const slices = 14;
		const arc = 0.055;
		for ( let i = 0; i < slices; i ++ ) {
			const a0 = state.sweep - i * arc;
			const a = ( 1 - i / slices );
			ctx.beginPath();
			ctx.moveTo( cx, cy );
			ctx.arc( cx, cy, rIn, a0 - arc, a0 );
			ctx.closePath();
			ctx.fillStyle = 'rgba(111, 227, 255,' + ( 0.055 * a * a ).toFixed( 4 ) + ')';
			ctx.fill();
		}
		// leading edge
		ctx.beginPath();
		ctx.moveTo( cx, cy );
		ctx.lineTo( cx + Math.cos( state.sweep ) * rIn, cy + Math.sin( state.sweep ) * rIn );
		ctx.strokeStyle = 'rgba(111, 227, 255, 0.30)';
		ctx.lineWidth = Math.max( 1, state.dpr );
		ctx.stroke();

		/* ---- contacts ---------------------------------------------------- */
		const list = state.list;
		const cosY = Math.cos( state.yaw ), sinY = Math.sin( state.yaw );
		const pulse = 0.5 + 0.5 * Math.sin( state.pulse * 6.0 );

		for ( let i = 0; i < list.length; i ++ ) {
			const e = list[ i ];
			if ( ! e || e.alive === false ) continue;

			const rx = ( e.x - state.px );
			const rz = ( e.z - state.pz );
			// rotate world offset into heading-up screen space
			let bx = rx * cosY - rz * sinY;
			let by = rx * sinY + rz * cosY;
			bx *= s; by *= s;

			const dist = Math.hypot( bx, by );
			const visible = e.visible !== false;
			const edge = dist > rIn - 6 * state.dpr;

			if ( edge ) {
				// clamp off-radar contacts to the rim as small chevrons
				const k = ( rIn - 6 * state.dpr ) / ( dist || 1 );
				const ex = cx + bx * k, ey = cy + by * k;
				const a = Math.atan2( by, bx );
				ctx.save();
				ctx.translate( ex, ey );
				ctx.rotate( a );
				ctx.beginPath();
				ctx.moveTo( 4 * state.dpr, 0 );
				ctx.lineTo( - 3 * state.dpr, 3 * state.dpr );
				ctx.lineTo( - 3 * state.dpr, - 3 * state.dpr );
				ctx.closePath();
				ctx.fillStyle = 'rgba(255, 77, 77, 0.55)';
				ctx.fill();
				ctx.restore();
				continue;
			}

			const bxp = cx + bx, byp = cy + by;
			const r = ( visible ? 3.6 : 2.6 ) * state.dpr;

			if ( visible ) {
				const pr = r + ( 2.5 + pulse * 4.5 ) * state.dpr;
				ctx.beginPath();
				ctx.arc( bxp, byp, pr, 0, TAU );
				ctx.strokeStyle = 'rgba(255, 77, 77,' + ( 0.42 * ( 1 - pulse ) + 0.12 ).toFixed( 3 ) + ')';
				ctx.lineWidth = Math.max( 1, state.dpr );
				ctx.stroke();
			}

			// facing tick
			if ( typeof e.angle === 'number' ) {
				const fa = state.yaw - e.angle;
				ctx.beginPath();
				ctx.moveTo( bxp, byp );
				ctx.lineTo( bxp + Math.sin( fa ) * r * 2.4, byp - Math.cos( fa ) * r * 2.4 );
				ctx.strokeStyle = 'rgba(255, 120, 100, 0.55)';
				ctx.lineWidth = Math.max( 1, state.dpr * 0.9 );
				ctx.stroke();
			}

			ctx.beginPath();
			ctx.arc( bxp, byp, r, 0, TAU );
			ctx.fillStyle = visible ? COL_HOSTILE : 'rgba(200, 70, 70, 0.65)';
			ctx.shadowColor = 'rgba(255, 40, 40, 0.9)';
			ctx.shadowBlur = visible ? 8 * state.dpr : 0;
			ctx.fill();
			ctx.shadowBlur = 0;
		}

		ctx.restore(); // end lens clip

		/* ---- player arrow ------------------------------------------------ */
		const aR = 6.5 * state.dpr;
		ctx.save();
		ctx.translate( cx, cy );
		ctx.beginPath();
		ctx.moveTo( 0, - aR );
		ctx.lineTo( aR * 0.72, aR * 0.72 );
		ctx.lineTo( 0, aR * 0.34 );
		ctx.lineTo( - aR * 0.72, aR * 0.72 );
		ctx.closePath();
		ctx.fillStyle = '#f2f7fa';
		ctx.strokeStyle = 'rgba(4, 8, 12, 0.9)';
		ctx.lineWidth = Math.max( 1, state.dpr );
		ctx.fill();
		ctx.stroke();
		ctx.restore();

		/* ---- bezel -------------------------------------------------------- */
		ctx.beginPath();
		ctx.arc( cx, cy, rIn, 0, TAU );
		ctx.strokeStyle = 'rgba(4, 8, 12, 0.85)';
		ctx.lineWidth = Math.max( 2, size * 0.045 );
		ctx.stroke();

		ctx.beginPath();
		ctx.arc( cx, cy, rIn + 0.5, 0, TAU );
		ctx.strokeStyle = COL_BEZEL;
		ctx.lineWidth = Math.max( 1, state.dpr );
		ctx.stroke();

		ctx.beginPath();
		ctx.arc( cx, cy, rOuter, 0, TAU );
		ctx.strokeStyle = 'rgba(232, 238, 242, 0.14)';
		ctx.lineWidth = Math.max( 1, state.dpr * 0.75 );
		ctx.stroke();

		// heading ticks every 30 degrees, long ones on the quadrants
		for ( let i = 0; i < 12; i ++ ) {
			const a = ( i / 12 ) * TAU - Math.PI * 0.5;
			const long = i % 3 === 0;
			const r0 = rIn + 1 * state.dpr;
			const r1 = rIn + ( long ? 5 : 3 ) * state.dpr;
			ctx.beginPath();
			ctx.moveTo( cx + Math.cos( a ) * r0, cy + Math.sin( a ) * r0 );
			ctx.lineTo( cx + Math.cos( a ) * r1, cy + Math.sin( a ) * r1 );
			ctx.strokeStyle = long ? 'rgba(232, 238, 242, 0.42)' : 'rgba(232, 238, 242, 0.2)';
			ctx.lineWidth = Math.max( 1, state.dpr * ( long ? 1 : 0.75 ) );
			ctx.stroke();
		}

		// rotating north index
		const nx = cx + Math.sin( state.yaw ) * ( rIn - 8 * state.dpr );
		const ny = cy - Math.cos( state.yaw ) * ( rIn - 8 * state.dpr );
		ctx.font = '700 ' + ( 9 * state.dpr ) + 'px ui-monospace, "SF Mono", Menlo, monospace';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillStyle = COL_ACCENT;
		ctx.shadowColor = 'rgba(0,0,0,0.9)';
		ctx.shadowBlur = 4 * state.dpr;
		ctx.fillText( 'N', nx, ny );
		ctx.shadowBlur = 0;
	}

	/* ---------------------------------------------------------------- bus */

	const offRadar = bus.on( 'radar:enemies', ( p ) => {
		if ( ! p ) return;
		if ( p.player ) {
			state.px = p.player.x || 0;
			state.pz = p.player.z || 0;
			if ( typeof p.player.yaw === 'number' ) state.yaw = p.player.yaw;
		}
		state.list = p.list || [];
	} );

	function update( dt ) {
		if ( ! state.alive ) return;
		if ( ! ( dt > 0 ) ) dt = 0.016;
		if ( dt > 0.1 ) dt = 0.1;

		state.sweep += dt * 1.45;
		if ( state.sweep > TAU ) state.sweep -= TAU;
		state.pulse += dt;

		state.acc += dt;
		if ( state.acc < TICK_30 ) return;
		state.acc = state.acc % TICK_30;
		draw();
	}

	function destroy() {
		state.alive = false;
		offRadar();
		state.list = [];
		wallTex.width = wallTex.height = 2;
		if ( ctx && canvas ) ctx.clearRect( 0, 0, canvas.width, canvas.height );
	}

	if ( canvas ) { resize(); draw(); }

	return { setWorld, update, destroy };
}

export default createMinimap;
