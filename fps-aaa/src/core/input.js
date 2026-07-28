import { bus } from './events.js';
import { settings } from './settings.js';

/**
 * Pointer-lock input. Mouse deltas are accumulated per-frame and consumed by
 * the player controller via consumeMouse(); this keeps look independent of
 * event firing rate (high-polling-rate mice fire many events per frame).
 */
class Input {
	constructor() {
		this.keys = new Set();
		this.mouseDX = 0;
		this.mouseDY = 0;
		this.buttons = [ false, false, false ];
		this._buttonPressed = [ false, false, false ];
		this._buttonReleased = [ false, false, false ];
		this._pressedThisFrame = new Set();
		this.locked = false;
		this.wheel = 0;
		this.enabled = true;
	}

	attach( element ) {
		this.element = element;

		document.addEventListener( 'keydown', ( e ) => {
			if ( e.repeat ) return;
			const c = e.code;
			this.keys.add( c );
			this._pressedThisFrame.add( c );
			if ( c === 'Tab' || ( c === 'Slash' && this.locked ) ) e.preventDefault();
			if ( c === 'Space' && this.locked ) e.preventDefault();
			bus.emit( 'input:keydown', { code: c, key: e.key } );
		} );

		document.addEventListener( 'keyup', ( e ) => {
			this.keys.delete( e.code );
			bus.emit( 'input:keyup', { code: e.code } );
		} );

		document.addEventListener( 'mousemove', ( e ) => {
			if ( ! this.locked || ! this.enabled ) return;
			this.mouseDX += e.movementX || 0;
			this.mouseDY += e.movementY || 0;
		} );

		document.addEventListener( 'mousedown', ( e ) => {
			if ( ! this.locked ) return;
			if ( e.button < 3 ) {
				this.buttons[ e.button ] = true;
				this._buttonPressed[ e.button ] = true;
			}
		} );

		document.addEventListener( 'mouseup', ( e ) => {
			if ( e.button < 3 ) {
				this.buttons[ e.button ] = false;
				this._buttonReleased[ e.button ] = true;
			}
		} );

		document.addEventListener( 'wheel', ( e ) => {
			if ( ! this.locked ) return;
			this.wheel += Math.sign( e.deltaY );
		}, { passive: true } );

		document.addEventListener( 'contextmenu', ( e ) => { if ( this.locked ) e.preventDefault(); } );

		document.addEventListener( 'pointerlockchange', () => {
			this.locked = document.pointerLockElement === element;
			this.keys.clear();
			this.buttons = [ false, false, false ];
			bus.emit( this.locked ? 'input:lock' : 'input:unlock' );
		} );

		document.addEventListener( 'pointerlockerror', () => {
			bus.emit( 'input:lockerror' );
		} );

		window.addEventListener( 'blur', () => { this.keys.clear(); this.buttons = [ false, false, false ]; } );

		return this;
	}

	requestLock() {
		if ( this.locked || ! this.element ) return;
		// unadjustedMovement removes OS mouse acceleration where supported; both
		// the request and the fallback can reject (e.g. no user gesture yet).
		try {
			const p = this.element.requestPointerLock?.( { unadjustedMovement: true } );
			if ( p && p.catch ) {
				p.catch( () => {
					try {
						const q = this.element.requestPointerLock();
						if ( q && q.catch ) q.catch( () => {} );
					} catch ( e ) { /* ignore */ }
				} );
			}
		} catch ( e ) { /* ignore */ }
	}

	exitLock() { if ( this.locked ) document.exitPointerLock(); }

	down( code ) { return this.keys.has( code ); }
	pressed( code ) { return this._pressedThisFrame.has( code ); }
	mouseDown( b ) { return this.buttons[ b ]; }
	mousePressed( b ) { return this._buttonPressed[ b ]; }
	mouseReleased( b ) { return this._buttonReleased[ b ]; }

	/** Returns {x, y} in radians, already scaled by sensitivity, then zeroes the accumulator. */
	consumeMouse( sensScale = 1 ) {
		const s = settings.sensitivity * sensScale;
		const x = this.mouseDX * s;
		const y = this.mouseDY * s * ( settings.invertY ? - 1 : 1 );
		this.mouseDX = 0;
		this.mouseDY = 0;
		return { x, y };
	}

	/** Called at the very end of each frame by main.js. */
	endFrame() {
		this._pressedThisFrame.clear();
		this._buttonPressed[ 0 ] = this._buttonPressed[ 1 ] = this._buttonPressed[ 2 ] = false;
		this._buttonReleased[ 0 ] = this._buttonReleased[ 1 ] = this._buttonReleased[ 2 ] = false;
		this.wheel = 0;
	}
}

export const input = new Input();
export default input;
