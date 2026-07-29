import * as THREE from "three";
import { BuildingId } from "./constants.js";
import { getResourceTextures } from "./resourceMeshes.js";

function mat(opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: opts.color ?? 0xffffff,
    map: opts.map ?? null,
    normalMap: opts.normalMap ?? null,
    roughness: opts.roughness ?? 0.75,
    metalness: opts.metalness ?? 0.1,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    flatShading: opts.flatShading ?? false,
    envMapIntensity: opts.envMapIntensity ?? 0.85,
  });
}

function shadow(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeFoundation(tex) {
  const g = new THREE.Group();
  const stone = mat({
    map: tex.rock,
    normalMap: tex.rockNormal,
    roughness: 0.9,
    color: 0xc8c4bc,
  });
  const base = shadow(new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.28, 2.2), stone));
  base.position.y = 0.14;
  g.add(base);
  const rim = shadow(new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.1, 2.35), stone));
  rim.position.y = 0.05;
  g.add(rim);
  for (const [x, z] of [
    [-0.9, -0.9],
    [0.9, -0.9],
    [-0.9, 0.9],
    [0.9, 0.9],
  ]) {
    const peg = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.22, 6), stone));
    peg.position.set(x, 0.28, z);
    g.add(peg);
  }
  return g;
}

function makeHabitat(tex) {
  const g = new THREE.Group();
  const hull = mat({
    map: tex.metal,
    normalMap: tex.metalNormal,
    roughness: 0.45,
    metalness: 0.55,
    color: 0xb8c4d4,
  });
  const accent = mat({
    map: tex.metalDark,
    roughness: 0.5,
    metalness: 0.7,
    color: 0x5a6a7a,
  });
  const glass = mat({
    color: 0x66e0ff,
    roughness: 0.15,
    metalness: 0.2,
    transparent: true,
    opacity: 0.55,
    emissive: 0x2288aa,
    emissiveIntensity: 0.35,
  });

  const pad = shadow(new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.25, 0.18, 12), accent));
  pad.position.y = 0.09;
  g.add(pad);

  const body = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.05, 1.5, 14), hull));
  body.position.y = 0.95;
  g.add(body);

  const dome = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.95, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), hull));
  dome.position.y = 1.7;
  g.add(dome);

  const window = shadow(new THREE.Mesh(new THREE.CircleGeometry(0.28, 12), glass));
  window.position.set(0, 1.05, 1.02);
  g.add(window);

  const door = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.9, 0.08), accent));
  door.position.set(0, 0.55, 1.08);
  g.add(door);

  const antenna = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), accent));
  antenna.position.set(0.35, 2.35, -0.2);
  g.add(antenna);
  const tip = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), glass));
  tip.position.set(0.35, 2.7, -0.2);
  g.add(tip);

  return g;
}

function makeStorage(tex) {
  const g = new THREE.Group();
  const wood = mat({
    map: tex.bark,
    normalMap: tex.barkNormal,
    roughness: 0.9,
    color: 0xc4a66a,
  });
  const metal = mat({
    map: tex.metalDark,
    roughness: 0.55,
    metalness: 0.65,
    color: 0x6a7060,
  });

  const crate = shadow(new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.3, 1.5), wood));
  crate.position.y = 0.75;
  g.add(crate);

  const lid = shadow(new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 1.6), metal));
  lid.position.y = 1.45;
  lid.rotation.x = -0.08;
  g.add(lid);

  for (let i = 0; i < 3; i++) {
    const band = shadow(new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.08, 1.55), metal));
    band.position.y = 0.35 + i * 0.4;
    g.add(band);
  }

  const latch = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.2, 0.12), metal));
  latch.position.set(0, 1.2, 0.8);
  g.add(latch);

  return g;
}

function makeGenerator(tex) {
  const g = new THREE.Group();
  const metal = mat({
    map: tex.metal,
    normalMap: tex.metalNormal,
    roughness: 0.4,
    metalness: 0.75,
    color: 0x7a90a8,
  });
  const dark = mat({
    map: tex.metalDark,
    roughness: 0.5,
    metalness: 0.8,
    color: 0x3a4555,
  });
  const glow = mat({
    color: 0x3db0ff,
    emissive: 0x2288ff,
    emissiveIntensity: 0.85,
    roughness: 0.25,
    metalness: 0.4,
  });

  const base = shadow(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.35, 1.6), dark));
  base.position.y = 0.18;
  g.add(base);

  const body = shadow(new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.1, 1.2), metal));
  body.position.y = 0.9;
  g.add(body);

  const coil = shadow(new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.12, 8, 16), glow));
  coil.rotation.x = Math.PI / 2;
  coil.position.set(0, 1.15, 0);
  g.add(coil);

  const stack = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 1.2, 10), dark));
  stack.position.set(0.45, 1.85, -0.2);
  g.add(stack);

  const vent = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 0.35), glow));
  vent.position.set(-0.4, 1.5, 0.55);
  g.add(vent);

  return g;
}

function makeOxygenStation(tex) {
  const g = new THREE.Group();
  const metal = mat({
    map: tex.metal,
    normalMap: tex.metalNormal,
    roughness: 0.4,
    metalness: 0.7,
    color: 0xa0b8c8,
  });
  const dark = mat({ map: tex.metalDark, roughness: 0.5, metalness: 0.75, color: 0x445566 });
  const o2 = mat({
    color: 0x66e8ff,
    emissive: 0x33aadd,
    emissiveIntensity: 0.55,
    roughness: 0.3,
    metalness: 0.3,
    transparent: true,
    opacity: 0.85,
  });

  const pad = shadow(new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.1, 0.15, 12), dark));
  pad.position.y = 0.08;
  g.add(pad);

  for (const x of [-0.45, 0.45]) {
    const tank = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.35, 1.6, 12), o2));
    tank.position.set(x, 0.95, 0);
    g.add(tank);
    const cap = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 8), metal));
    cap.position.set(x, 1.75, 0);
    g.add(cap);
  }

  const pipe = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 8), metal));
  pipe.rotation.z = Math.PI / 2;
  pipe.position.set(0, 1.2, 0);
  g.add(pipe);

  const panel = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.15), dark));
  panel.position.set(0, 0.7, 0.7);
  g.add(panel);
  const screen = shadow(new THREE.Mesh(new THREE.PlaneGeometry(0.35, 0.25), o2));
  screen.position.set(0, 0.75, 0.79);
  g.add(screen);

  return g;
}

function makeHangar(tex) {
  const g = new THREE.Group();
  const wood = mat({
    map: tex.bark,
    normalMap: tex.barkNormal,
    roughness: 0.88,
    color: 0xb8956a,
  });
  const clay = mat({
    map: tex.clay,
    normalMap: tex.clayNormal,
    roughness: 0.85,
    color: 0xd4a070,
  });
  const metal = mat({
    map: tex.metalDark,
    roughness: 0.5,
    metalness: 0.7,
    color: 0x5a6570,
  });
  const glow = mat({
    color: 0xffcc66,
    emissive: 0xaa7722,
    emissiveIntensity: 0.4,
    roughness: 0.4,
  });

  // Floor
  const floor = shadow(new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.25, 10.2), clay));
  floor.position.y = 0.12;
  g.add(floor);

  // Side walls
  const wallL = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.2, 9.5), wood));
  wallL.position.set(-3.9, 1.7, 0);
  g.add(wallL);
  const wallR = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.2, 9.5), wood));
  wallR.position.set(3.9, 1.7, 0);
  g.add(wallR);

  // Back wall
  const back = shadow(new THREE.Mesh(new THREE.BoxGeometry(8.2, 3.2, 0.35), wood));
  back.position.set(0, 1.7, -4.8);
  g.add(back);

  // Arched roof segments
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const z = -4.2 + t * 8.4;
    const beam = shadow(new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.28, 0.35), metal));
    beam.position.set(0, 3.55, z);
    g.add(beam);
    // curved-ish side braces
    for (const side of [-1, 1]) {
      const brace = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.4, 0.2), metal));
      brace.position.set(side * 3.5, 3.0, z);
      brace.rotation.z = side * -0.55;
      g.add(brace);
    }
  }

  // Roof panels
  const roof = shadow(new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.15, 10), wood));
  roof.position.set(0, 3.85, 0);
  g.add(roof);

  // Front frame / open bay
  const postL = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.4, 3.4, 0.4), metal));
  postL.position.set(-3.7, 1.7, 4.7);
  g.add(postL);
  const postR = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.4, 3.4, 0.4), metal));
  postR.position.set(3.7, 1.7, 4.7);
  g.add(postR);
  const lintel = shadow(new THREE.Mesh(new THREE.BoxGeometry(8.0, 0.35, 0.4), metal));
  lintel.position.set(0, 3.5, 4.7);
  g.add(lintel);

  // Interior work lights
  for (const z of [-2, 1, 3.5]) {
    const lamp = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), glow));
    lamp.position.set(0, 3.5, z);
    g.add(lamp);
  }

  // Side crates
  const crate = shadow(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 1.0), wood));
  crate.position.set(-2.8, 0.55, -3.2);
  g.add(crate);

  return g;
}

function makeO2Filler(tex) {
  const g = new THREE.Group();
  const metal = mat({
    map: tex.metal,
    normalMap: tex.metalNormal,
    roughness: 0.35,
    metalness: 0.8,
    color: 0x8aa0b8,
  });
  const dark = mat({ map: tex.metalDark, roughness: 0.45, metalness: 0.75 });
  const glow = mat({
    color: 0x4dc4ff,
    emissive: 0x2288ff,
    emissiveIntensity: 0.9,
    roughness: 0.25,
    metalness: 0.3,
  });

  const base = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.85, 0.25, 12), dark));
  base.position.y = 0.12;
  g.add(base);

  const tank = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 1.8, 14), glow));
  tank.position.y = 1.15;
  g.add(tank);

  const ring = shadow(new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.06, 8, 20), metal));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 1.15;
  g.add(ring);

  const nozzle = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.7, 8), metal));
  nozzle.rotation.z = Math.PI / 2;
  nozzle.position.set(0.75, 1.0, 0);
  g.add(nozzle);

  const hose = shadow(new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.05, 6, 14, Math.PI), dark));
  hose.rotation.y = Math.PI / 2;
  hose.position.set(1.0, 0.7, 0);
  g.add(hose);

  const cap = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), metal));
  cap.position.y = 2.15;
  g.add(cap);

  const beacon = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), glow));
  beacon.position.y = 2.55;
  g.add(beacon);

  return g;
}

function makeFarmPlot(tex) {
  const g = new THREE.Group();
  const wood = mat({
    map: tex.bark,
    normalMap: tex.barkNormal,
    roughness: 0.92,
    color: 0x8a6238,
  });
  const dirt = mat({
    map: tex.dirt,
    normalMap: tex.dirtNormal,
    roughness: 0.95,
    color: 0x6b4a28,
  });
  const plant = mat({
    map: tex.plant,
    normalMap: tex.plantNormal,
    roughness: 0.7,
    color: 0x4a9a40,
  });

  // Raised bed frame
  const frame = shadow(new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.35, 2.6), wood));
  frame.position.y = 0.18;
  g.add(frame);

  const soil = shadow(new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.2, 2.2), dirt));
  soil.position.y = 0.35;
  g.add(soil);

  // Crops rows
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const stem = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.35, 5), wood));
      stem.position.set(-0.7 + col * 0.7, 0.55, -0.7 + row * 0.7);
      g.add(stem);
      const leaf = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.16, 7, 5), plant));
      leaf.scale.set(1.2, 0.7, 1);
      leaf.position.set(-0.7 + col * 0.7, 0.75, -0.7 + row * 0.7);
      g.add(leaf);
    }
  }

  return g;
}

/** Approximate footprint size for build preview ghost. */
export function getBuildingFootprint(id) {
  switch (id) {
    case BuildingId.HANGAR:
      return { w: 8.2, h: 4, d: 10.2 };
    case BuildingId.FARM_PLOT:
      return { w: 2.6, h: 0.8, d: 2.6 };
    case BuildingId.O2_FILLER:
      return { w: 1.8, h: 2.6, d: 1.8 };
    case BuildingId.GENERATOR:
      return { w: 1.8, h: 2.2, d: 1.6 };
    case BuildingId.HABITAT:
      return { w: 2.4, h: 2.8, d: 2.4 };
    case BuildingId.STORAGE:
      return { w: 2.0, h: 1.6, d: 1.8 };
    case BuildingId.OXYGEN_STATION:
      return { w: 2.2, h: 2.2, d: 2.0 };
    case BuildingId.FOUNDATION:
    default:
      return { w: 2.4, h: 0.4, d: 2.4 };
  }
}

/**
 * Build a recognizable structure mesh for a building id (local origin at ground).
 */
export function buildBuildingVisual(id) {
  const tex = getResourceTextures();
  let group;
  switch (id) {
    case BuildingId.FOUNDATION:
      group = makeFoundation(tex);
      break;
    case BuildingId.HABITAT:
      group = makeHabitat(tex);
      break;
    case BuildingId.STORAGE:
      group = makeStorage(tex);
      break;
    case BuildingId.GENERATOR:
      group = makeGenerator(tex);
      break;
    case BuildingId.OXYGEN_STATION:
      group = makeOxygenStation(tex);
      break;
    case BuildingId.HANGAR:
      group = makeHangar(tex);
      break;
    case BuildingId.O2_FILLER:
      group = makeO2Filler(tex);
      break;
    case BuildingId.FARM_PLOT:
      group = makeFarmPlot(tex);
      break;
    default:
      group = makeFoundation(tex);
  }
  return group;
}
