import * as THREE from 'three';

/**
 * OVERPRESSURE — hitscan resolution.
 *
 * Rays start at the camera centre (never the muzzle) so what the crosshair
 * covers is what gets hit; spread is applied in camera space. World geometry
 * uses a single reused Raycaster, enemies are tested as AABB hitboxes so we
 * never pay for per-triangle tests on animated bodies.
 *
 * Thin materials ('wood', 'glass') can be shot through: the ray restarts just
 * past the exit point with a damage multiplier, up to MAX_PENETRATIONS.
 */

const MAX_PENETRATIONS = 2;
const RESULT_POOL = 6;

/** Damage retained after punching through one layer of each surface. */
const PENETRABLE = {
	wood: 0.55,
	glass: 0.86,
};

const _ray = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _saved = new THREE.Vector3();
const _savedN = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _raw = [];

function surfaceOf( obj ) {
	let o = obj;
	while ( o ) {
		if ( o.userData && o.userData.surface ) return o.userData.surface;
		o = o.parent;
	}
	return 'concrete';
}

function makeResult() {
	return {
		hit: false,
		point: new THREE.Vector3(),
		normal: new THREE.Vector3(),
		surface: 'concrete',
		enemy: null,
		bodyPart: '',
		partMult: 1,
		distance: 0,
		object: null,
		damageScale: 1,
		penetrated: 0,
	};
}

/** Box normal for the face nearest to `point`. */
function boxNormal( box, point, out ) {
	const cx = ( box.min.x + box.max.x ) * 0.5;
	const cy = ( box.min.y + box.max.y ) * 0.5;
	const cz = ( box.min.z + box.max.z ) * 0.5;
	const ex = ( box.max.x - box.min.x ) * 0.5 || 1e-5;
	const ey = ( box.max.y - box.min.y ) * 0.5 || 1e-5;
	const ez = ( box.max.z - box.min.z ) * 0.5 || 1e-5;
	const dx = ( point.x - cx ) / ex;
	const dy = ( point.y - cy ) / ey;
	const dz = ( point.z - cz ) / ez;
	const ax = Math.abs( dx ), ay = Math.abs( dy ), az = Math.abs( dz );
	if ( ax >= ay && ax >= az ) out.set( Math.sign( dx ) || 1, 0, 0 );
	else if ( ay >= az ) out.set( 0, Math.sign( dy ) || 1, 0 );
	else out.set( 0, 0, Math.sign( dz ) || 1 );
	return out;
}

/**
 * Linear damage falloff.
 * @param {object} f { start, end, min } — full damage <= start, `min` scale >= end.
 */
export function falloffScale( distance, f ) {
	if ( ! f ) return 1;
	if ( distance <= f.start ) return 1;
	if ( distance >= f.end ) return f.min;
	const t = ( distance - f.start ) / ( f.end - f.start );
	return 1 + ( f.min - 1 ) * t;
}

/**
 * @param {object} world  { hitMeshes }
 * @param {object} deps   { enemies } — may be attached after construction.
 */
export function createHitscan( world, deps = {} ) {

	const results = [];
	for ( let i = 0; i < RESULT_POOL; i ++ ) results.push( makeResult() );

	/** Perturb `baseDir` inside a cone of `spreadRad`, using camera axes. */
	function applySpread( out, baseDir, spreadRad, camera ) {
		out.copy( baseDir );
		if ( spreadRad <= 0 ) return out.normalize();
		camera.updateMatrixWorld();
		_right.setFromMatrixColumn( camera.matrixWorld, 0 );
		_up.setFromMatrixColumn( camera.matrixWorld, 1 );
		const a = Math.random() * Math.PI * 2;
		const r = Math.sqrt( Math.random() ) * spreadRad;
		const t = Math.tan( r );
		out.addScaledVector( _right, Math.cos( a ) * t );
		out.addScaledVector( _up, Math.sin( a ) * t );
		return out.normalize();
	}

	/** Nearest world-geometry intersection into `res`. Returns distance or Infinity. */
	function castWorld( origin, dir, maxDist, res ) {
		const meshes = ( world && world.hitMeshes ) || null;
		if ( ! meshes || ! meshes.length ) return Infinity;
		_ray.set( origin, dir );
		_ray.near = 0;
		_ray.far = maxDist;
		_raw.length = 0;
		_ray.intersectObjects( meshes, true, _raw );
		for ( let i = 0; i < _raw.length; i ++ ) {
			const it = _raw[ i ];
			if ( ! it.object.visible ) continue;
			res.point.copy( it.point );
			if ( it.face ) {
				res.normal.copy( it.face.normal ).transformDirection( it.object.matrixWorld ).normalize();
				if ( res.normal.dot( dir ) > 0 ) res.normal.negate();
			} else {
				res.normal.copy( dir ).negate();
			}
			res.surface = surfaceOf( it.object );
			res.object = it.object;
			return it.distance;
		}
		return Infinity;
	}

	/** Nearest enemy hitbox intersection into `res`. Returns distance or Infinity. */
	function castEnemies( origin, dir, maxDist, res, ignore ) {
		const enemies = deps.enemies;
		const list = enemies && enemies.list;
		if ( ! list || ! list.length ) return Infinity;
		_ray.set( origin, dir );
		_ray.near = 0;
		_ray.far = maxDist;

		let best = Infinity;
		for ( let i = 0; i < list.length; i ++ ) {
			const e = list[ i ];
			if ( ! e.alive || e === ignore ) continue;
			if ( ! _ray.ray.intersectsBox( e.bounds ) ) continue;
			const boxes = e.hitboxes;
			for ( let b = 0; b < boxes.length; b ++ ) {
				const hb = boxes[ b ];
				if ( _ray.ray.intersectBox( hb.box, _pt ) === null ) continue;
				const d = _pt.distanceTo( origin );
				if ( d >= best || d > maxDist ) continue;
				best = d;
				res.point.copy( _pt );
				boxNormal( hb.box, _pt, _nrm );
				res.normal.copy( _nrm );
				res.enemy = e;
				res.bodyPart = hb.part;
				res.partMult = hb.mult;
				res.surface = 'flesh';
				res.object = null;
			}
		}
		return best;
	}

	/**
	 * Cast one bullet. Fills the pooled result list in hit order (index 0 is
	 * the first thing struck) and returns the number of hits.
	 *
	 * @param {THREE.Vector3} origin
	 * @param {THREE.Vector3} dir      normalised
	 * @param {object} opts { maxDistance, penetrate, ignore }
	 */
	function cast( origin, dir, opts = {} ) {
		const maxDistance = opts.maxDistance ?? 320;
		const penetrate = opts.penetrate !== false;

		_origin.copy( origin );
		_dir.copy( dir ).normalize();

		let count = 0;
		let travelled = 0;
		let damageScale = 1;
		let penetrations = 0;

		while ( count < RESULT_POOL ) {
			const res = results[ count ];
			res.hit = false;
			res.enemy = null;
			res.bodyPart = '';
			res.partMult = 1;
			res.object = null;
			res.surface = 'concrete';
			res.penetrated = penetrations;

			const remaining = maxDistance - travelled;
			if ( remaining <= 0.05 ) break;

			const dWorld = castWorld( _origin, _dir, remaining, res );

			// enemies write into the same result only if they are closer
			const savedSurface = res.surface;
			const savedObject = res.object;
			_saved.copy( res.point );
			_savedN.copy( res.normal );
			const dEnemy = castEnemies( _origin, _dir, Math.min( remaining, dWorld ), res, opts.ignore );

			let d;
			if ( dEnemy < dWorld ) {
				d = dEnemy;
			} else if ( dWorld < Infinity ) {
				d = dWorld;
				// defensive: restore world data if an enemy test touched the result
				res.enemy = null;
				res.bodyPart = '';
				res.partMult = 1;
				res.surface = savedSurface;
				res.object = savedObject;
				res.point.copy( _saved );
				res.normal.copy( _savedN );
			} else {
				break;
			}

			res.hit = true;
			res.distance = travelled + d;
			res.damageScale = damageScale;
			count ++;

			if ( res.enemy ) break;                       // bodies stop the bullet here
			if ( ! penetrate || penetrations >= MAX_PENETRATIONS ) break;
			const retain = PENETRABLE[ res.surface ];
			if ( ! retain ) break;

			penetrations ++;
			damageScale *= retain;
			travelled = res.distance + 0.06;
			_origin.copy( res.point ).addScaledVector( _dir, 0.06 );
		}

		return count;
	}

	/** Convenience: closest hit only, or null. */
	function castOne( origin, dir, opts ) {
		return cast( origin, dir, opts ) > 0 ? results[ 0 ] : null;
	}

	return {
		cast,
		castOne,
		applySpread,
		falloffScale,
		results,
		get penetrable() { return PENETRABLE; },
	};
}

export default createHitscan;
