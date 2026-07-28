// Global event bus. Every subsystem talks through this so modules stay decoupled.

class EventBus {
	constructor() {
		this._map = new Map();
	}

	on( name, fn ) {
		let set = this._map.get( name );
		if ( ! set ) { set = new Set(); this._map.set( name, set ); }
		set.add( fn );
		return () => this.off( name, fn );
	}

	once( name, fn ) {
		const off = this.on( name, ( p ) => { off(); fn( p ); } );
		return off;
	}

	off( name, fn ) {
		const set = this._map.get( name );
		if ( set ) set.delete( fn );
	}

	emit( name, payload ) {
		const set = this._map.get( name );
		if ( ! set ) return;
		for ( const fn of set ) {
			try { fn( payload ); } catch ( e ) { console.error( `[bus:${name}]`, e ); }
		}
	}
}

export const bus = new EventBus();
export default bus;
