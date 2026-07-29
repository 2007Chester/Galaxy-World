import * as THREE from "three";
import { ItemId } from "./constants.js";
import { TextureLibrary } from "./proceduralTextures.js";

/** Shared textures for all resource nodes (lazy singleton). */
let sharedTex = null;
export function getResourceTextures() {
  if (!sharedTex) sharedTex = new TextureLibrary();
  return sharedTex;
}

function mat(map, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    map,
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0.05,
    color: opts.color ?? 0xffffff,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    flatShading: opts.flatShading ?? false,
    envMapIntensity: opts.envMapIntensity ?? 0.55,
  });
  if (opts.normalMap) {
    m.normalMap = opts.normalMap;
    m.normalScale = opts.normalScale ?? new THREE.Vector2(1, 1);
  }
  if (opts.roughnessMap) m.roughnessMap = opts.roughnessMap;
  return m;
}

function addShadow(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeTree(tex) {
  const g = new THREE.Group();
  const trunk = addShadow(
    new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.38, 1.9, 10),
      mat(tex.bark, {
        roughness: 0.92,
        color: 0xffffff,
        normalMap: tex.barkNormal,
        normalScale: new THREE.Vector2(1.2, 1.2),
      })
    )
  );
  trunk.position.y = 0.95;
  g.add(trunk);

  const leafMat = mat(tex.leaf, {
    roughness: 0.72,
    normalMap: tex.leafNormal,
    normalScale: new THREE.Vector2(0.85, 0.85),
  });
  const clusters = [
    [0, 2.35, 0, 0.95],
    [0.45, 2.05, 0.25, 0.7],
    [-0.4, 2.15, -0.2, 0.65],
    [0.15, 2.55, -0.35, 0.55],
  ];
  for (const [x, y, z, r] of clusters) {
    const canopy = addShadow(
      new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), leafMat)
    );
    canopy.position.set(x, y, z);
    canopy.rotation.set(Math.random(), Math.random(), Math.random());
    g.add(canopy);
  }

  // Roots
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const root = addShadow(
      new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.12, 0.45, 5),
        mat(tex.bark, { roughness: 1 })
      )
    );
    root.position.set(Math.cos(a) * 0.28, 0.12, Math.sin(a) * 0.28);
    root.rotation.z = Math.cos(a) * 0.9;
    root.rotation.x = Math.sin(a) * 0.9;
    g.add(root);
  }
  return g;
}

function makeClayMound(tex) {
  const g = new THREE.Group();
  const clayMat = mat(tex.clay, {
    roughness: 0.88,
    normalMap: tex.clayNormal,
    roughnessMap: tex.clayRoughness,
    normalScale: new THREE.Vector2(1.2, 1.2),
  });
  const dirtMat = mat(tex.dirt, {
    roughness: 0.95,
    normalMap: tex.dirtNormal,
    roughnessMap: tex.dirtRoughness,
  });

  const base = addShadow(new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), clayMat));
  base.scale.set(1.35, 0.55, 1.15);
  base.position.y = 0.28;
  g.add(base);

  const lump = addShadow(new THREE.Mesh(new THREE.SphereGeometry(0.38, 8, 6), clayMat));
  lump.position.set(0.25, 0.45, 0.1);
  lump.scale.set(1.1, 0.7, 0.9);
  g.add(lump);

  const lump2 = addShadow(new THREE.Mesh(new THREE.SphereGeometry(0.28, 7, 5), dirtMat));
  lump2.position.set(-0.3, 0.35, -0.15);
  g.add(lump2);

  // Grass tufts on mound
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(
      new THREE.ConeGeometry(0.04, 0.28, 4),
      mat(tex.leaf, { roughness: 0.7 })
    );
    blade.position.set((Math.random() - 0.5) * 0.8, 0.55, (Math.random() - 0.5) * 0.6);
    blade.rotation.z = (Math.random() - 0.5) * 0.4;
    g.add(addShadow(blade));
  }
  return g;
}

function makeRock(tex, variant = "stone") {
  const g = new THREE.Group();
  const rockMat = mat(tex.rock, {
    roughness: 0.88,
    flatShading: false,
    normalMap: tex.rockNormal,
    roughnessMap: tex.rockRoughness,
    normalScale: new THREE.Vector2(1.3, 1.3),
  });
  const crystalKey =
    variant === "iron"
      ? "iron"
      : variant === "copper"
        ? "copper"
        : variant === "silicon"
          ? "silicon"
          : "stone";
  const crystalMat = mat(tex.crystals[crystalKey], {
    roughness: 0.28,
    metalness: variant === "stone" ? 0.2 : 0.55,
    emissive: variant === "silicon" ? 0x114466 : variant === "copper" ? 0x442200 : 0x221100,
    emissiveIntensity: variant === "stone" ? 0.08 : 0.4,
    envMapIntensity: 1.2,
  });

  const main = addShadow(
    new THREE.Mesh(new THREE.DodecahedronGeometry(0.55, 1), rockMat)
  );
  main.position.y = 0.4;
  main.rotation.set(0.3, 0.5, 0.1);
  main.scale.set(1.1, 0.85, 1);
  g.add(main);

  const side = addShadow(
    new THREE.Mesh(new THREE.DodecahedronGeometry(0.28, 0), rockMat)
  );
  side.position.set(0.45, 0.22, 0.15);
  side.rotation.set(0.8, 0.2, 0.4);
  g.add(side);

  if (variant !== "stone") {
    for (let i = 0; i < 3; i++) {
      const spike = addShadow(
        new THREE.Mesh(new THREE.OctahedronGeometry(0.18 + i * 0.04, 0), crystalMat)
      );
      spike.position.set(
        (i - 1) * 0.22,
        0.75 + i * 0.08,
        (i % 2) * 0.12 - 0.05
      );
      spike.rotation.set(0.2 * i, 0.4 * i, 0.1);
      spike.scale.set(0.7, 1.4 + i * 0.2, 0.7);
      g.add(spike);
    }
  }
  return g;
}

function makeAnimal(tex) {
  const g = new THREE.Group();
  const fur = mat(tex.fur, {
    roughness: 0.85,
    normalMap: tex.furNormal,
    normalScale: new THREE.Vector2(1.1, 1.1),
  });
  const dark = mat(tex.fur, {
    roughness: 0.9,
    color: 0x886644,
    normalMap: tex.furNormal,
  });
  const legs = [];

  const body = addShadow(new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.55, 4, 10), fur));
  body.rotation.z = Math.PI / 2;
  body.position.set(0, 0.48, 0);
  g.add(body);

  const head = addShadow(new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), fur));
  head.position.set(0.42, 0.58, 0);
  g.add(head);

  const snout = addShadow(new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), dark));
  snout.position.set(0.58, 0.52, 0);
  snout.scale.set(1.2, 0.8, 0.8);
  g.add(snout);

  const legSpecs = [
    [0.18, 0.12, 0],
    [0.18, -0.12, Math.PI],
    [-0.22, 0.12, Math.PI],
    [-0.22, -0.12, 0],
  ];
  for (const [lx, lz, phase] of legSpecs) {
    const leg = addShadow(
      new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.35, 6), dark)
    );
    leg.position.set(lx, 0.18, lz);
    leg.userData.baseY = 0.18;
    leg.userData.phase = phase;
    legs.push(leg);
    g.add(leg);
  }

  for (const side of [-1, 1]) {
    const ear = addShadow(new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 5), dark));
    ear.position.set(0.38, 0.78, side * 0.12);
    ear.rotation.x = side * 0.3;
    g.add(ear);
  }

  const tail = addShadow(
    new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.06, 0.35, 5), fur)
  );
  tail.position.set(-0.4, 0.5, 0);
  tail.rotation.z = 1.1;
  g.userData.tail = tail;
  g.add(tail);

  g.userData.isAnimal = true;
  g.userData.legs = legs;
  return g;
}

function makePond(tex) {
  const g = new THREE.Group();
  const waterMat = mat(tex.water, {
    roughness: 0.15,
    metalness: 0.2,
    transparent: true,
    opacity: 0.82,
    color: 0xaaccff,
  });
  const rockMat = mat(tex.rock, {
    roughness: 0.9,
    flatShading: false,
    normalMap: tex.rockNormal,
    roughnessMap: tex.rockRoughness,
  });

  const water = addShadow(
    new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.9, 0.12, 16), waterMat)
  );
  water.position.y = 0.06;
  g.add(water);

  const rim = addShadow(
    new THREE.Mesh(new THREE.TorusGeometry(0.88, 0.12, 6, 18), rockMat)
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.08;
  rim.scale.set(1, 1, 0.35);
  g.add(rim);

  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const pebble = addShadow(
      new THREE.Mesh(new THREE.DodecahedronGeometry(0.12 + Math.random() * 0.08, 0), rockMat)
    );
    pebble.position.set(Math.cos(a) * 0.95, 0.1, Math.sin(a) * 0.75);
    pebble.rotation.set(Math.random(), Math.random(), Math.random());
    g.add(pebble);
  }
  return g;
}

function makeFish(tex) {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x4a9ec8,
    roughness: 0.35,
    metalness: 0.45,
  });
  const finMat = new THREE.MeshStandardMaterial({
    color: 0xe8a040,
    roughness: 0.5,
    metalness: 0.2,
  });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.4 });

  const body = addShadow(new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), bodyMat));
  body.scale.set(1.7, 0.7, 0.95);
  body.position.y = 0.12;
  g.add(body);

  const head = addShadow(new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), bodyMat));
  head.position.set(0.28, 0.12, 0);
  head.scale.set(1.1, 0.85, 0.9);
  g.add(head);

  const tail = addShadow(new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.22, 4), finMat));
  tail.rotation.z = Math.PI / 2;
  tail.position.set(-0.38, 0.12, 0);
  g.userData.tail = tail;
  g.add(tail);

  const dorsal = addShadow(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 4), finMat));
  dorsal.position.set(0.02, 0.32, 0);
  g.add(dorsal);

  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), eyeMat);
    eye.position.set(0.32, 0.16, side * 0.1);
    g.add(eye);
  }

  g.userData.isFish = true;
  g.scale.setScalar(1.15);
  return g;
}

function makeBush(tex, withSeeds = false) {
  const g = new THREE.Group();
  const stemMat = mat(tex.bark, {
    roughness: 0.95,
    color: 0x886644,
    normalMap: tex.barkNormal,
  });
  const leafMat = mat(tex.plant, {
    roughness: 0.7,
    normalMap: tex.plantNormal,
  });

  for (let i = 0; i < 5; i++) {
    const stem = addShadow(
      new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.55 + i * 0.08, 5), stemMat)
    );
    stem.position.set((i - 2) * 0.12, 0.3, (i % 2) * 0.08);
    stem.rotation.z = (i - 2) * 0.15;
    g.add(stem);
  }

  const bush = addShadow(new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 1), leafMat));
  bush.position.y = 0.7;
  bush.scale.set(1.1, 0.85, 1);
  g.add(bush);

  if (withSeeds) {
    const seedMat = mat(tex.dirt, {
      roughness: 0.55,
      color: 0xd4a84b,
      normalMap: tex.dirtNormal,
    });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const pod = addShadow(new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 5), seedMat));
      pod.position.set(Math.cos(a) * 0.4, 0.75 + (i % 2) * 0.15, Math.sin(a) * 0.35);
      g.add(pod);
    }
  }
  return g;
}

function makeOrganic(tex) {
  const g = new THREE.Group();
  const leafMat = mat(tex.leaf, {
    roughness: 0.65,
    normalMap: tex.leafNormal,
  });
  const glow = mat(tex.crystals.organic, {
    roughness: 0.32,
    emissive: 0x114422,
    emissiveIntensity: 0.45,
    envMapIntensity: 1,
  });

  const core = addShadow(new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 1), glow));
  core.position.y = 0.45;
  g.add(core);

  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const leaf = addShadow(new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), leafMat));
    leaf.scale.set(1.4, 0.35, 0.7);
    leaf.position.set(Math.cos(a) * 0.35, 0.4, Math.sin(a) * 0.35);
    leaf.rotation.y = a;
    leaf.rotation.z = 0.4;
    g.add(leaf);
  }
  return g;
}

function makeWreck(tex) {
  const g = new THREE.Group();
  const metal = mat(tex.metal, {
    roughness: 0.38,
    metalness: 0.82,
    normalMap: tex.metalNormal,
    roughnessMap: tex.metalRoughness,
    normalScale: new THREE.Vector2(0.9, 0.9),
    envMapIntensity: 1.1,
  });
  const dark = mat(tex.metalDark, {
    roughness: 0.48,
    metalness: 0.85,
    normalMap: tex.metalNormal,
    roughnessMap: tex.metalRoughness,
  });
  const glow = mat(tex.metalBlue, {
    roughness: 0.28,
    metalness: 0.65,
    emissive: 0x2255aa,
    emissiveIntensity: 0.55,
    normalMap: tex.metalNormal,
  });

  const hull = addShadow(new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.35, 0.9), metal));
  hull.position.y = 0.28;
  hull.rotation.y = 0.25;
  hull.rotation.z = 0.08;
  g.add(hull);

  const plate = addShadow(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.55), dark));
  plate.position.set(0.35, 0.5, 0.1);
  plate.rotation.x = -0.4;
  g.add(plate);

  const strut = addShadow(
    new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.7, 6), dark)
  );
  strut.position.set(-0.4, 0.55, -0.15);
  strut.rotation.z = 0.6;
  g.add(strut);

  const light = addShadow(new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), glow));
  light.position.set(0.55, 0.42, 0.25);
  g.add(light);

  // Rivet details
  for (let i = 0; i < 4; i++) {
    const rivet = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 5, 4),
      mat(tex.metal, { metalness: 0.9, roughness: 0.3 })
    );
    rivet.position.set(-0.4 + i * 0.25, 0.48, 0.4);
    g.add(rivet);
  }
  return g;
}

/**
 * Build a textured, recognizable resource mesh group (without world position).
 */
export function buildResourceVisual(itemId) {
  const tex = getResourceTextures();
  switch (itemId) {
    case ItemId.WOOD:
      return makeTree(tex);
    case ItemId.CLAY:
      return makeClayMound(tex);
    case ItemId.STONE:
      return makeRock(tex, "stone");
    case ItemId.IRON:
      return makeRock(tex, "iron");
    case ItemId.COPPER:
      return makeRock(tex, "copper");
    case ItemId.SILICON:
      return makeRock(tex, "silicon");
    case ItemId.FOOD:
      return makeAnimal(tex);
    case ItemId.FISH:
      return makeFish(tex);
    case ItemId.WATER:
      return makePond(tex);
    case ItemId.SEEDS:
      return makeBush(tex, true);
    case ItemId.ORGANIC:
      return makeOrganic(tex);
    case ItemId.WRECK_PART:
      return makeWreck(tex);
    default:
      return makeRock(tex, "stone");
  }
}
