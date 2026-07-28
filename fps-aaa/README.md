# OVERPRESSURE

An original browser-native tactical FPS vertical slice built on Three.js.

Not a clone of any commercial shooter — no third-party assets, textures, audio,
models, or trademarks are used. Every material, sound, weapon and level piece in
this project is generated procedurally in code at runtime. The design target is
the *production values* of a modern military shooter (weapon feel, feedback,
lighting hierarchy, HUD readability), delivered inside the constraints of a
browser.

---

## Running it

There is no build step and no npm dependency. Three.js r171 is vendored in
`vendor/three`, resolved through an importmap.

```bash
cd fps-aaa
python3 serve.py            # http://127.0.0.1:8123/
```

Then open **http://127.0.0.1:8123/** in Chrome, Edge, or Safari 16.4+.
Pass a port as the first argument to `serve.py` if 8123 is taken.

> A server is required — ES modules and the importmap will not load from a
> `file://` URL.

### Requirements

- A WebGL2-capable browser (Chrome 111+, Edge 111+, Firefox 115+, Safari 16.4+)
- Pointer Lock support (i.e. desktop, not mobile)

---

## Controls

| Action | Input |
|---|---|
| Move | `W` `A` `S` `D` |
| Sprint | `Shift` (hold) |
| Crouch | `C` / `Ctrl` |
| Jump | `Space` |
| Fire | Left mouse |
| Aim down sights | Right mouse |
| Reload | `R` |
| Weapon 1 / 2 / 3 | `1` `2` `3` |
| Quick swap | `Q` |
| Pause / menu | `Esc` |

---

## Architecture

```
fps-aaa/
├── index.html            importmap + canvas + ui root
├── serve.py              zero-dependency static dev server
├── CONTRACT.md           module + event-bus contract (read this first)
├── vendor/three/         vendored Three.js r171 (build + trimmed addons)
├── tools/                headless screenshot harness used by the review loop
└── src/
    ├── main.js           bootstrap, integration, game-state machine
    ├── core/             engine, input, event bus, settings
    ├── player/           controller, weapons, viewmodel, procedural gun models
    ├── combat/           hitscan, enemies + AI, decals
    ├── world/            map, materials, lighting, sky, post-processing, VFX
    ├── ui/               HUD, menus, minimap
    └── audio/            WebAudio synthesis, impulse responses
```

Subsystems never import each other directly. They communicate through the
event bus in `src/core/events.js`; the full event vocabulary is documented in
`CONTRACT.md`. This is what allows the HUD, audio and VFX layers to react to
gameplay without any of them knowing gameplay exists.

### Rendering

Two scene layers are composited in a single post-processing chain: the world
(`engine.scene` / `engine.camera`) and the first-person viewmodel
(`engine.viewScene` / `engine.viewCamera`, near plane 4mm) which renders with a
cleared depth buffer so the weapon never intersects level geometry while still
receiving bloom and colour grading.

The camera is a rig of nested nodes — yaw → pitch → shake → recoil → camera — so
gameplay code and feedback code write to different transforms and never fight
each other.

### Performance

Targets 60fps at 1440×900 on integrated graphics. Static level geometry is
merged per material, repeated props are instanced, and every particle, tracer,
decal and damage number is pooled with zero per-frame allocation. Quality
presets (low / medium / high) scale pixel-ratio cap, shadow resolution, particle
density and decal budget.

---

## Development

Screenshots for review are captured through headless Chrome:

```bash
python3 tools/shoot.py out.png "shot=2&hud=1&enemies=6"
```

Query parameters recognised by `src/main.js`:

| param | effect |
|---|---|
| `shot=N` | skip the menu and place the camera at scripted vantage point N |
| `hud=0` | hide the HUD |
| `enemies=N` | spawn a wave of N enemies |
| `freeze=0` | allow the player controller to run in shot mode |
| `debug=1` | expose `window.__fpsDebug` diagnostics |

`window.__fpsDebug.info()` reports fps, draw calls, triangle count and which
subsystems loaded.

---

## Licence / attribution

All code and content original to this project. Three.js is MIT licensed and
vendored unmodified under `vendor/three`.
