import * as THREE from "three";
import {
  BuildingId,
  CONST,
  ITEM_COLORS,
  ItemId,
} from "./constants.js";
import { TextureLibrary } from "./proceduralTextures.js";

function hash2(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise2(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(a, b, u),
    THREE.MathUtils.lerp(c, d, u),
    v
  );
}

function fbm(x, z) {
  return (
    noise2(x * 0.04, z * 0.04) * 1.0 +
    noise2(x * 0.08, z * 0.08) * 0.3 +
    noise2(x * 0.16, z * 0.16) * 0.12
  );
}

export function getHeight(x, z, seed = 42) {
  const ox = seed * 0.17;
  const oz = seed * 0.31;
  return (fbm(x / CONST.PLANET_SCALE + ox, z / CONST.PLANET_SCALE + oz) * 2 - 1) * CONST.TERRAIN_HEIGHT;
}

function terrainBlend(x, y, z, seed) {
  const heightT = THREE.MathUtils.clamp((y + CONST.TERRAIN_HEIGHT) / (CONST.TERRAIN_HEIGHT * 2), 0, 1);
  const slope =
    Math.abs(getHeight(x + 1, z, seed) - getHeight(x - 1, z, seed)) +
    Math.abs(getHeight(x, z + 1, seed) - getHeight(x, z - 1, seed));
  const slopeT = THREE.MathUtils.clamp(slope * 0.15, 0, 1);
  const grassW = THREE.MathUtils.clamp((1 - heightT * 1.4) * (1 - slopeT * 0.85), 0, 1);
  const rockW = THREE.MathUtils.clamp(slopeT * 0.9 + Math.max(0, heightT - 0.55) * 1.2, 0, 1);
  const dirtW = THREE.MathUtils.clamp(1 - grassW - rockW, 0, 1);
  const sum = grassW + dirtW + rockW || 1;
  return { grassW: grassW / sum, dirtW: dirtW / sum, rockW: rockW / sum };
}

function createGrassBladeGeometry() {
  const geo = new THREE.PlaneGeometry(0.12, 0.75, 1, 4);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y + 0.375) / 0.75;
    const bend = t * t * 0.08;
    pos.setX(i, pos.getX(i) + bend);
  }
  geo.translate(0, 0.375, 0);
  geo.computeVertexNormals();
  return geo;
}

function bakeTerrainMap(size, worldHalf, seed, grassTex, dirtTex, rockTex) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const gCtx = grassTex.image.getContext("2d");
  const dCtx = dirtTex.image.getContext("2d");
  const rCtx = rockTex.image.getContext("2d");
  const img = ctx.createImageData(size, size);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const wx = (px / size - 0.5) * worldHalf * 2;
      const wz = (py / size - 0.5) * worldHalf * 2;
      const wy = getHeight(wx, wz, seed);
      const { grassW, dirtW, rockW } = terrainBlend(wx, wy, wz, seed);
      const n = noise2(wx * 0.05 + seed, wz * 0.05) * 0.06;

      const gu = (Math.abs(Math.floor(wx * 64)) % 256);
      const gv = (Math.abs(Math.floor(wz * 64)) % 256);
      const g = gCtx.getImageData(gu | 0, gv | 0, 1, 1).data;
      const d = dCtx.getImageData(gu | 0, gv | 0, 1, 1).data;
      const r = rCtx.getImageData(gu | 0, gv | 0, 1, 1).data;

      const i = (py * size + px) * 4;
      img.data[i] = (g[0] * grassW + d[0] * dirtW + r[0] * rockW) * (1 + n);
      img.data[i + 1] = (g[1] * grassW + d[1] * dirtW + r[1] * rockW) * (1 + n);
      img.data[i + 2] = (g[2] * grassW + d[2] * dirtW + r[2] * rockW) * (1 + n);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function buildResourceCluster(itemId, textures) {
  const group = new THREE.Group();
  const color = ITEM_COLORS[itemId];
  const crystalKey = ["stone", "iron", "copper", "silicon", "organic"][itemId];
  const crystalTex = textures.crystals[crystalKey];

  const baseMat = new THREE.MeshStandardMaterial({
    map: crystalTex,
    color,
    emissive: color,
    emissiveIntensity: 0.45,
    roughness: 0.25,
    metalness: 0.65,
    flatShading: true,
  });

  const glowMat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 1.2,
    roughness: 0.15,
    metalness: 0.2,
    transparent: true,
    opacity: 0.85,
    flatShading: true,
  });

  const configs = {
    [ItemId.STONE]: () => {
      for (let i = 0; i < 5; i++) {
        const s = 0.25 + hash2(i, 1) * 0.25;
        const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), baseMat);
        m.position.set((hash2(i, 2) - 0.5) * 0.7, s * 0.4, (hash2(i, 3) - 0.5) * 0.7);
        m.rotation.set(hash2(i, 4) * 2, hash2(i, 5) * 2, hash2(i, 6) * 2);
        m.castShadow = true;
        group.add(m);
      }
    },
    [ItemId.IRON]: () => {
      for (let i = 0; i < 4; i++) {
        const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.28 + i * 0.04, 0), baseMat);
        m.position.set(Math.cos(i * 1.4) * 0.35, 0.2 + i * 0.08, Math.sin(i * 1.4) * 0.35);
        m.rotation.y = i * 0.9;
        m.castShadow = true;
        group.add(m);
      }
      const core = new THREE.Mesh(new THREE.TetrahedronGeometry(0.18, 0), glowMat);
      core.position.y = 0.45;
      group.add(core);
    },
    [ItemId.COPPER]: () => {
      for (let i = 0; i < 6; i++) {
        const m = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.55 + hash2(i, 7) * 0.2, 4), baseMat);
        m.position.set((hash2(i, 8) - 0.5) * 0.6, 0.25, (hash2(i, 9) - 0.5) * 0.6);
        m.rotation.set(hash2(i, 10), hash2(i, 11) * Math.PI, hash2(i, 12));
        m.castShadow = true;
        group.add(m);
      }
    },
    [ItemId.SILICON]: () => {
      for (let i = 0; i < 5; i++) {
        const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), glowMat);
        m.position.set(Math.cos(i * 1.25) * 0.3, 0.15 + i * 0.12, Math.sin(i * 1.25) * 0.3);
        m.rotation.set(0.4, i * 0.7, 0.3);
        m.castShadow = true;
        group.add(m);
      }
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 6), glowMat);
      beam.position.y = 0.55;
      group.add(beam);
    },
    [ItemId.ORGANIC]: () => {
      for (let i = 0; i < 4; i++) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.22 + hash2(i, 13) * 0.12, 8, 6), baseMat);
        m.position.set((hash2(i, 14) - 0.5) * 0.5, 0.18 + i * 0.06, (hash2(i, 15) - 0.5) * 0.5);
        m.scale.y = 0.7;
        m.castShadow = true;
        group.add(m);
      }
      const spore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 0), glowMat);
      spore.position.y = 0.55;
      group.add(spore);
    },
  };

  (configs[itemId] || configs[ItemId.STONE])();
  return group;
}

function buildWreckageGroup(isCore, textures) {
  const group = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({
    map: textures.metal,
    color: isCore ? 0x5a7088 : 0x4a5258,
    metalness: 0.88,
    roughness: 0.28,
    emissive: isCore ? 0x224466 : 0x0a1018,
    emissiveIntensity: isCore ? 0.35 : 0.08,
  });
  const panelMat = new THREE.MeshStandardMaterial({
    map: textures.metalDark,
    color: 0x3a4248,
    metalness: 0.92,
    roughness: 0.22,
  });
  const engineMat = new THREE.MeshStandardMaterial({
    map: textures.metalBlue,
    color: 0x3a6090,
    metalness: 0.85,
    roughness: 0.18,
    emissive: isCore ? 0x2266cc : 0x112233,
    emissiveIntensity: isCore ? 1.4 : 0.25,
  });

  const scale = isCore ? 1.35 : 1;

  const hull = new THREE.Mesh(new THREE.BoxGeometry(2.8 * scale, 1.2 * scale, 1.8 * scale), hullMat);
  hull.position.y = 0.5 * scale;
  hull.castShadow = true;
  hull.receiveShadow = true;
  group.add(hull);

  const panel = new THREE.Mesh(new THREE.BoxGeometry(1.6 * scale, 0.08, 2.2 * scale), panelMat);
  panel.position.set(0, 1.15 * scale, 0.3);
  panel.rotation.x = -0.35;
  panel.castShadow = true;
  group.add(panel);

  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.8 * scale, 0.15), panelMat);
  beam.position.set(-1.1 * scale, 0.9 * scale, -0.5 * scale);
  beam.rotation.z = 0.25;
  beam.castShadow = true;
  group.add(beam);

  const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.35 * scale, 0.5 * scale, 0.9 * scale, 10), engineMat);
  engine.position.set(1.2 * scale, 0.45 * scale, -0.6 * scale);
  engine.rotation.z = Math.PI / 2;
  engine.castShadow = true;
  group.add(engine);

  const pipe = new THREE.Mesh(new THREE.TorusGeometry(0.4 * scale, 0.05, 6, 16, Math.PI), panelMat);
  pipe.position.set(-0.5 * scale, 0.7 * scale, 0.8 * scale);
  pipe.rotation.x = Math.PI / 2;
  group.add(pipe);

  if (isCore) {
    const coreGlow = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 16, 16),
      new THREE.MeshStandardMaterial({
        color: 0x4488ff,
        emissive: 0x3388ff,
        emissiveIntensity: 2.5,
        roughness: 0.1,
        metalness: 0.3,
        transparent: true,
        opacity: 0.9,
      })
    );
    coreGlow.position.set(0, 0.55 * scale, 0);
    group.add(coreGlow);

    for (let i = 0; i < 3; i++) {
      const shard = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 1.2), panelMat);
      shard.position.set((i - 1) * 1.1 * scale, 0.15, -1.1 * scale);
      shard.rotation.y = (i - 1) * 0.4;
      shard.castShadow = true;
      group.add(shard);
    }
  } else {
    const debris = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.25, 1.4), hullMat);
    debris.position.set(0.8 * scale, 0.12, 0.9 * scale);
    debris.rotation.y = 0.6;
    debris.castShadow = true;
    group.add(debris);
  }

  return group;
}

export class World {
  constructor(scene, seed = 42) {
    this.scene = scene;
    this.seed = seed;
    this.resources = [];
    this.wreckage = [];
    this.buildings = [];
    this.spawn = new THREE.Vector3(0, 0, 0);
    this.group = new THREE.Group();
    this.textures = new TextureLibrary();
    this.dayFactor = 1;
    scene.add(this.group);
  }

  build() {
    this._makeStars();
    this._makeSky();
    this._makeTerrain();
    this._makeGrass();
    this._makeTrees();
    this._makeDust();
    this._makePod();
    this._spawnResources();
    this._spawnWreckage();
  }

  dispose() {
    this.scene.remove(this.group);
    if (this.stars) {
      this.scene.remove(this.stars);
      this.stars.geometry.dispose();
      this.stars.material.dispose();
      this.stars = null;
    }
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
    if (this.terrainMap) this.terrainMap.dispose();
    this.textures.dispose();
    this.resources = [];
    this.wreckage = [];
    this.buildings = [];
  }

  _makeStars() {
    const count = 2800;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = 180 + Math.random() * 100;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi) * 0.6 + 20;
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      sizes[i] = 0.35 + Math.random() * 0.65;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    this.stars = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xddeeff,
        size: 0.55,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        sizeAttenuation: true,
      })
    );
    this.scene.add(this.stars);
  }

  _makeSky() {
    this.hemi = new THREE.HemisphereLight(0x9ec4ff, 0x1a2e1a, 0.55);
    this.group.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0x334466, 0.25);
    this.group.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff0d4, 1.35);
    this.sun.position.set(40, 60, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 180;
    const s = 70;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0004;
    this.group.add(this.sun);

    // Distant planet
    this.distantPlanet = new THREE.Mesh(
      new THREE.SphereGeometry(12, 48, 48),
      new THREE.MeshStandardMaterial({
        map: this.textures.planet,
        roughness: 0.85,
        metalness: 0.05,
      })
    );
    this.distantPlanet.position.set(90, 55, -120);
    this.group.add(this.distantPlanet);

    const planetAtmo = new THREE.Mesh(
      new THREE.SphereGeometry(12.8, 32, 32),
      new THREE.MeshBasicMaterial({
        color: 0x6699cc,
        transparent: true,
        opacity: 0.12,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    planetAtmo.position.copy(this.distantPlanet.position);
    this.group.add(planetAtmo);

    // Anomaly sphere with texture + atmosphere rim
    this.anomaly = new THREE.Mesh(
      new THREE.SphereGeometry(3, 48, 48),
      new THREE.MeshStandardMaterial({
        map: this.textures.anomaly,
        color: 0x8866ff,
        emissive: 0x5533ff,
        emissiveIntensity: 2.2,
        emissiveMap: this.textures.anomaly,
        roughness: 0.15,
        metalness: 0.2,
        transparent: true,
        opacity: 0.95,
      })
    );
    this.anomaly.position.set(-40, 35, -50);
    this.group.add(this.anomaly);

    this.anomalyAtmo = new THREE.Mesh(
      new THREE.SphereGeometry(3.6, 32, 32),
      new THREE.MeshBasicMaterial({
        color: 0xaa66ff,
        transparent: true,
        opacity: 0.18,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    this.anomalyAtmo.position.copy(this.anomaly.position);
    this.group.add(this.anomalyAtmo);

    // Multi-band ring system
    this.rings = new THREE.Group();
    const ringConfigs = [
      { r: 18, tube: 0.5, opacity: 0.55, tilt: 0 },
      { r: 22, tube: 0.9, opacity: 0.35, tilt: 0.08 },
      { r: 26, tube: 1.4, opacity: 0.22, tilt: -0.05 },
    ];
    for (const cfg of ringConfigs) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(cfg.r, cfg.tube, 2, 128),
        new THREE.MeshStandardMaterial({
          map: this.textures.ring,
          color: 0xd0e0f8,
          transparent: true,
          opacity: cfg.opacity,
          emissive: 0x446688,
          emissiveIntensity: 0.45,
          roughness: 0.35,
          metalness: 0.55,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      ring.rotation.x = 1.2 + cfg.tilt;
      ring.rotation.z = 0.25;
      this.rings.add(ring);
    }
    this.rings.position.set(0, 60, -80);
    this.group.add(this.rings);
  }

  _makeTerrain() {
    const size = CONST.PLANET_SIZE;
    const scale = CONST.PLANET_SCALE;
    const worldHalf = (size * scale) / 2;
    const geo = new THREE.PlaneGeometry(size * scale, size * scale, size, size);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const uvs = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = getHeight(x, z, this.seed);
      pos.setY(i, y);
      uvs.push((x / worldHalf + 1) * 0.5, (z / worldHalf + 1) * 0.5);
    }
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();

    this.terrainMap = bakeTerrainMap(512, worldHalf, this.seed, this.textures.grass, this.textures.dirt, this.textures.rock);

    const mat = new THREE.MeshStandardMaterial({
      map: this.terrainMap,
      normalMap: this.textures.terrainNormal,
      normalScale: new THREE.Vector2(0.65, 0.65),
      roughness: 0.92,
      metalness: 0.03,
    });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.group.add(this.terrain);
  }

  _makeGrass() {
    const count = 3200;
    const bladeGeo = createGrassBladeGeometry();
    const mat = new THREE.MeshStandardMaterial({
      map: this.textures.grassBlade,
      alphaMap: this.textures.grassBlade,
      transparent: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      roughness: 0.95,
      metalness: 0,
    });

    this.grass = new THREE.InstancedMesh(bladeGeo, mat, count);
    this.grass.castShadow = false;
    this.grass.receiveShadow = true;

    const dummy = new THREE.Object3D();
    let placed = 0;
    let attempts = 0;
    while (placed < count && attempts < count * 8) {
      attempts++;
      const r = 5 + hash2(attempts, this.seed) * 75;
      const a = hash2(attempts * 2, this.seed) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = getHeight(x, z, this.seed);
      const { grassW, rockW } = terrainBlend(x, y, z, this.seed);
      if (grassW < 0.45 || rockW > 0.35) continue;

      dummy.position.set(x, y, z);
      dummy.rotation.y = hash2(attempts * 3, this.seed) * Math.PI * 2;
      dummy.rotation.x = (hash2(attempts * 4, this.seed) - 0.5) * 0.15;
      const s = 0.7 + hash2(attempts * 5, this.seed) * 0.8;
      dummy.scale.set(s, s * (0.85 + hash2(attempts * 6, this.seed) * 0.3), s);
      dummy.updateMatrix();
      this.grass.setMatrixAt(placed, dummy.matrix);
      placed++;
    }
    this.grass.count = placed;
    this.grass.instanceMatrix.needsUpdate = true;
    this.group.add(this.grass);

    // Crossed blade clusters for depth
    this.grass2 = new THREE.InstancedMesh(bladeGeo, mat, Math.floor(placed * 0.5));
    let placed2 = 0;
    for (let i = 0; i < placed && placed2 < this.grass2.count; i += 2) {
      this.grass.getMatrixAt(i, dummy.matrix);
      dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
      dummy.rotation.y += Math.PI * 0.5;
      dummy.updateMatrix();
      this.grass2.setMatrixAt(placed2++, dummy.matrix);
    }
    this.grass2.count = placed2;
    this.grass2.instanceMatrix.needsUpdate = true;
    this.group.add(this.grass2);
  }

  _makeTrees() {
    const treeCount = 55;
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.22, 2.4, 8);
    trunkGeo.translate(0, 1.2, 0);
    const trunkMat = new THREE.MeshStandardMaterial({
      map: this.textures.bark,
      color: 0x6a5038,
      roughness: 0.92,
      metalness: 0.02,
    });
    const canopyGeo = new THREE.IcosahedronGeometry(1.15, 1);
    canopyGeo.translate(0, 2.8, 0);
    const canopyMat = new THREE.MeshStandardMaterial({
      map: this.textures.leaf,
      color: 0x2a6838,
      roughness: 0.88,
      metalness: 0,
      flatShading: true,
    });

    this.treeTrunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    this.treeCanopies = new THREE.InstancedMesh(canopyGeo, canopyMat, treeCount);
    this.treeTrunks.castShadow = true;
    this.treeCanopies.castShadow = true;

    const dummy = new THREE.Object3D();
    let placed = 0;
    let attempts = 0;
    while (placed < treeCount && attempts < treeCount * 12) {
      attempts++;
      const r = 12 + hash2(attempts + 100, this.seed) * 55;
      const a = hash2(attempts + 200, this.seed) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = getHeight(x, z, this.seed);
      const { grassW, rockW } = terrainBlend(x, y, z, this.seed);
      if (grassW < 0.5 || rockW > 0.2) continue;
      if (Math.hypot(x, z) < 6) continue;

      dummy.position.set(x, y, z);
      dummy.rotation.y = hash2(attempts, this.seed) * Math.PI * 2;
      const s = 0.75 + hash2(attempts + 50, this.seed) * 0.55;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      this.treeTrunks.setMatrixAt(placed, dummy.matrix);
      this.treeCanopies.setMatrixAt(placed, dummy.matrix);
      placed++;
    }
    this.treeTrunks.count = placed;
    this.treeCanopies.count = placed;
    this.treeTrunks.instanceMatrix.needsUpdate = true;
    this.treeCanopies.instanceMatrix.needsUpdate = true;
    this.group.add(this.treeTrunks);
    this.group.add(this.treeCanopies);
  }

  _makeDust() {
    const count = 140;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 120;
      positions[i * 3 + 1] = Math.random() * 8 + 1;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 120;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.dust = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xaaccdd,
        size: 0.12,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      })
    );
    this.group.add(this.dust);
  }

  surfaceY(x, z) {
    return getHeight(x, z, this.seed);
  }

  _makePod() {
    const h = this.surfaceY(0, 0);
    const podBody = new THREE.Mesh(
      new THREE.CapsuleGeometry(1.2, 1.4, 8, 16),
      new THREE.MeshStandardMaterial({
        map: this.textures.metal,
        color: 0xbcc6d6,
        metalness: 0.72,
        roughness: 0.22,
        emissive: 0x223344,
        emissiveIntensity: 0.15,
      })
    );
    podBody.position.set(0, h + 1.6, 0);
    podBody.castShadow = true;
    this.group.add(podBody);

    const podWindow = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 12, 12),
      new THREE.MeshStandardMaterial({
        color: 0x88ccff,
        emissive: 0x2266aa,
        emissiveIntensity: 0.6,
        roughness: 0.05,
        metalness: 0.1,
        transparent: true,
        opacity: 0.85,
      })
    );
    podWindow.position.set(0, h + 2.1, 0.95);
    this.group.add(podWindow);

    const beacon = new THREE.PointLight(0x44aaff, 1.2, 12);
    beacon.position.set(0, h + 3.2, 0);
    this.group.add(beacon);
    this.spawn.set(0, h + 1.6, 2);
  }

  _spawnResources() {
    const types = [
      ItemId.STONE,
      ItemId.IRON,
      ItemId.COPPER,
      ItemId.SILICON,
      ItemId.ORGANIC,
    ];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const r = 8 + (i % 7) * 6 + hash2(i, this.seed) * 4;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = this.surfaceY(x, z);
      const itemId = types[i % types.length];
      const cluster = buildResourceCluster(itemId, this.textures);
      cluster.position.set(x, y + 0.05, z);
      cluster.rotation.y = hash2(i * 3, this.seed) * Math.PI;
      cluster.userData = {
        kind: "resource",
        itemId,
        drop: 2 + (i % 4),
        hp: 80 + (i % 4) * 10,
        maxHp: 80 + (i % 4) * 10,
        baseScale: 1,
        pulse: hash2(i, this.seed * 2) * Math.PI * 2,
      };
      cluster.traverse((c) => {
        if (c.isMesh) {
          c.castShadow = true;
          c.userData.kind = "resource";
          c.userData.itemId = itemId;
        }
      });
      this.group.add(cluster);
      this.resources.push(cluster);
    }
  }

  _spawnWreckage() {
    const positions = [
      [15, 10],
      [-20, 25],
      [30, -15],
      [-10, -30],
      [45, 35],
    ];
    positions.forEach(([x, z], i) => {
      const y = this.surfaceY(x, z);
      const isCore = i === 0;
      const wreck = buildWreckageGroup(isCore, this.textures);
      wreck.position.set(x, y, z);
      wreck.rotation.y = hash2(x, z) * Math.PI;
      wreck.userData = {
        kind: "wreckage",
        isCore,
        looted: false,
        lootItem: ItemId.CIRCUIT,
        lootAmount: isCore ? 3 : 2,
      };
      wreck.traverse((c) => {
        if (c.isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
          c.userData.kind = "wreckage";
          c.userData.isCore = isCore;
        }
      });
      this.group.add(wreck);
      this.wreckage.push(wreck);
    });
  }

  addBuilding(id, position) {
    let geo;
    let color = 0x8899aa;
    let yOff = 0.15;
    switch (id) {
      case BuildingId.FOUNDATION:
        geo = new THREE.BoxGeometry(2, 0.3, 2);
        color = 0x73737a;
        break;
      case BuildingId.HABITAT:
        geo = new THREE.BoxGeometry(2, 2, 2);
        color = 0x99a6bf;
        break;
      case BuildingId.STORAGE:
        geo = new THREE.BoxGeometry(2, 1.5, 2);
        color = 0x8c804f;
        yOff = 0.75;
        break;
      case BuildingId.GENERATOR:
        geo = new THREE.CylinderGeometry(0.8, 1, 1.5, 12);
        color = 0x4d99e6;
        yOff = 0.75;
        break;
      case BuildingId.OXYGEN_STATION:
        geo = new THREE.BoxGeometry(1.5, 2, 1.5);
        color = 0x66bfd9;
        yOff = 1;
        break;
      default:
        geo = new THREE.BoxGeometry(1, 1, 1);
    }
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.45,
      metalness: 0.35,
      emissive: id === BuildingId.GENERATOR ? 0x3377ff : 0x000000,
      emissiveIntensity: id === BuildingId.GENERATOR ? 0.75 : 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position);
    mesh.position.y += yOff;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { kind: "building", buildingId: id };
    this.group.add(mesh);
    this.buildings.push(mesh);
    return mesh;
  }

  updateDayNight(t) {
    if (!this.sun) return;
    const angle = t * 0.05;
    const sunY = 30 + Math.sin(angle) * 40;
    this.sun.position.set(Math.cos(angle) * 50, sunY, Math.sin(angle) * 50);
    const daylight = Math.max(Math.sin(angle), 0);
    this.dayFactor = 0.25 + daylight * 0.75;
    this.sun.intensity = 0.35 + daylight * 1.15;
    this.hemi.intensity = 0.25 + daylight * 0.45;

    const skyDay = new THREE.Color(0x1a2848);
    const skyNight = new THREE.Color(0x050810);
    const fogDay = new THREE.Color(0x1a2848);
    const fogNight = new THREE.Color(0x060810);
    this.scene.background = skyNight.clone().lerp(skyDay, daylight);
    if (this.scene.fog) {
      this.scene.fog.color = fogNight.clone().lerp(fogDay, daylight);
      this.scene.fog.near = 35 + daylight * 10;
      this.scene.fog.far = 110 + daylight * 35;
    }

    if (this.anomaly) {
      this.anomaly.material.emissiveIntensity = 1.6 + Math.sin(t * 2) * 0.4;
      this.anomaly.rotation.y = t * 0.08;
    }
    if (this.anomalyAtmo) {
      this.anomalyAtmo.rotation.y = t * 0.08;
    }
    if (this.distantPlanet) {
      this.distantPlanet.rotation.y = t * 0.015;
    }
    if (this.rings) {
      this.rings.rotation.y = t * 0.01;
    }

    if (this.dust) {
      const pos = this.dust.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        pos.setY(i, pos.getY(i) + Math.sin(t + i) * 0.002);
      }
      pos.needsUpdate = true;
    }

    for (const r of this.resources) {
      r.rotation.y += 0.004;
      const pulse = 1 + Math.sin(t * 2.5 + r.userData.pulse) * 0.06;
      r.scale.setScalar(pulse);
    }
  }
}
