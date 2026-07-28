# OVERPRESSURE — module contract

Original tactical FPS vertical slice. Three.js r171 vendored at `vendor/three`.
No build step: plain ES modules + importmap. Served by `serve.py`.

**Import specifiers (must use exactly these):**
```js
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
```

**Never** add a bundler, npm dependency, external CDN URL, or binary asset.
All textures/audio must be generated procedurally at runtime (canvas / WebAudio).
No copyrighted names, logos, weapon trademarks, or Call of Duty assets.

---

## Core (already written — read, do not modify)

- `src/core/engine.js` — singleton `engine`.
  - `engine.scene`, `engine.viewScene` (viewmodel layer), `engine.camera`, `engine.viewCamera`
  - `engine.cameraRig` (yaw + eye position, driven by player), `engine.cameraPitch` (pitch)
  - `engine.renderer`, `engine.maxAnisotropy`, `engine.dt`, `engine.elapsed`
  - `engine.onUpdate(fn)` / `engine.onLateUpdate(fn)` / `engine.onResize(fn)`
  - `engine.addShake(amount0to1)`, `engine.addFovKick(deg)`, `engine.setFovScale(s)`
  - `engine.setRecoilOffset(pitch, yaw, roll, kickZ)` — weapon writes each frame
  - `engine.setComposer(composer)`
- `src/core/input.js` — singleton `input`: `down(code)`, `pressed(code)`, `mouseDown(b)`,
  `mousePressed(b)`, `consumeMouse(sensScale)`, `requestLock()`, `locked`, `wheel`.
- `src/core/events.js` — singleton `bus`: `on/off/once/emit`.
- `src/core/settings.js` — `settings`, `qualityPreset()`, `saveSettings()`, `QUALITY`.

---

## Event bus vocabulary (canonical — do not invent variants)

Emitted by gameplay, consumed by UI / audio / VFX:

| event | payload |
|---|---|
| `game:start` | `{}` |
| `game:pause` / `game:resume` | `{}` |
| `game:over` | `{ score, kills, timeAlive, wave }` |
| `wave:start` | `{ wave, enemyCount }` |
| `wave:clear` | `{ wave, bonus }` |
| `weapon:equipped` | `{ id, name, ammo, reserve, magSize, fireMode }` |
| `weapon:fire` | `{ id, ammo, reserve, silenced }` |
| `weapon:dry` | `{ id }` |
| `weapon:reloadStart` | `{ id, duration }` |
| `weapon:reloadEnd` | `{ id, ammo, reserve }` |
| `weapon:ads` | `{ active }` |
| `weapon:spread` | `{ value01 }` — drives dynamic crosshair gap |
| `hit:surface` | `{ point:Vector3, normal:Vector3, surface:string }` |
| `hit:confirm` | `{ headshot:bool, damage, killed:bool, point:Vector3 }` |
| `enemy:killed` | `{ id, name, headshot, distance, weapon, point:Vector3 }` |
| `enemy:spawned` | `{ id }` |
| `player:damaged` | `{ amount, health, maxHealth, dirWorld:Vector3 }` |
| `player:healed` | `{ health }` |
| `player:died` | `{}` |
| `player:footstep` | `{ surface, sprinting, position:Vector3 }` |
| `player:land` | `{ impact01, surface }` |
| `player:jump` | `{}` |
| `score:add` | `{ amount, label, point:Vector3 }` |
| `radar:enemies` | `{ list:[{x,z,angle,alive,visible}] , player:{x,z,yaw} }` (emitted ~10Hz) |
| `perf:sample` | `{ fps, calls, tris, frameMs }` |
| `camera:shake` | `{ amount }` |
| `camera:fovKick` | `{ amount }` |
| `ui:toast` | `{ text, sub }` |

---

## World API — `src/world/map.js`

```js
export function buildMap(scene, matlib) -> World
```
```ts
World = {
  root: THREE.Group,             // already added to scene
  colliders: THREE.Box3[],       // static AABBs for player/enemy movement
  hitMeshes: THREE.Object3D[],   // raycast targets; each has userData.surface
  playerSpawn: { position: THREE.Vector3, yaw: number },
  enemySpawns: Array<{ position: THREE.Vector3, yaw: number }>,
  coverPoints: THREE.Vector3[],  // AI reposition targets, on the floor
  bounds: THREE.Box3,
  minimap: { min:{x,z}, max:{x,z}, walls: Array<{x,z,w,h,rot}> },
  update?: (dt) => void
}
```
Surface tags used everywhere: `'concrete' | 'metal' | 'wood' | 'dirt' | 'glass' | 'sand'`.

## `src/world/materials.js`
```js
export function createMaterialLibrary(renderer) -> {
  concrete, concreteDark, metal, metalPainted, wood, dirt, sand, glass,
  rustMetal, plaster, asphalt, emissive(colorHex, intensity), ...
}   // MeshStandardMaterial instances, textures procedural (canvas), tiled via repeat
```

## `src/world/lighting.js`
```js
export function setupLighting(scene, renderer) -> { sun, hemi, env, update(dt), lights:[] }
```

## `src/world/postfx.js`
```js
export function createPostFX(renderer, scene, camera, viewScene, viewCamera) -> {
  composer, setSize(w,h), update(dt),
  setDamage(v01), pulseHit(strength), setAdsBlur(v01), setQuality(name)
}
```

## `src/world/vfx.js`
```js
export function createVFX(scene, viewScene) -> {
  muzzleFlash(pos, dir, scale, inViewLayer),
  tracer(fromVec, toVec, speed),
  impact(point, normal, surface),
  bloodImpact(point, normal),
  shellEject(worldPos, rightDir),
  smoke(pos, scale), spark(pos, dir, count),
  update(dt)
}
```

## Player / combat — `src/player/*`, `src/combat/*`
```js
export function createPlayer(world, deps) -> { update(dt), state, position, damage(n, fromPos), reset() }
export function createWeapons(world, player, deps) -> { update(dt), current, list, giveAmmo() }
export function createEnemies(world, player, deps) -> { update(dt), list, reset(), spawnWave(n) }
export function createDecals(scene) -> { add(point, normal, surface), clear(), update(dt) }
```
`deps = { vfx, audio, decals, enemies, weapons }` (subset as needed).

## UI — `src/ui/*`
```js
export function createHUD(rootEl) -> { update(dt), setVisible(b) }   // 100% bus-driven
export function createMenu(rootEl, hooks) -> { showMain(), showPause(), showDeath(stats), hide(), visible }
```
`hooks = { onStart(), onResume(), onRestart(), onSettings(patch) }`

## Audio — `src/audio/audio.js`
```js
export function createAudio(camera) -> { unlock(), update(dt), setVolume(v) } // bus-driven, WebAudio synthesis only
```

---

## Performance budget (mid MacBook, 1440x900, DPR capped 1.75)

- ≤ 220 draw calls, ≤ 400k triangles in view
- Merge static geometry aggressively (`BufferGeometryUtils.mergeGeometries`)
- Instance repeated props; pool all particles/decals/tracers — **zero per-frame allocation**
- Max 6 shadow-casting lights; only the sun casts a large shadow map
