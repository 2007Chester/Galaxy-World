import * as THREE from "three";
import { CONST, ItemId } from "./constants.js";
import { buildResourceVisual } from "./resourceMeshes.js";
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
    noise2(x * 0.035, z * 0.035) +
    noise2(x * 0.07, z * 0.07) * 0.45 +
    noise2(x * 0.14, z * 0.14) * 0.2
  );
}

export function getHeight(x, z, seed = 42) {
  const ox = seed * 0.13;
  const oz = seed * 0.29;
  return (fbm(x * 0.04 + ox, z * 0.04 + oz) * 2 - 1) * CONST.TERRAIN_HEIGHT;
}

function makeTerrainMaterial(tex) {
  return new THREE.MeshStandardMaterial({
    map: tex.grass,
    roughness: 0.92,
    metalness: 0.04,
    flatShading: false,
  });
}

function resourceKey(itemId, x, z) {
  return `${itemId}:${x.toFixed(1)}:${z.toFixed(1)}`;
}

function createResourceNode(itemId, x, y, z) {
  const group = buildResourceVisual(itemId);
  group.position.set(x, y, z);
  // Slight random yaw so nodes don't look identical
  group.rotation.y = hash2(x * 0.7, z * 1.3) * Math.PI * 2;
  const key = resourceKey(itemId, x, z);
  group.userData = {
    kind: "resource",
    itemId,
    key,
    drop: itemId === ItemId.WRECK_PART ? 1 : 2 + ((Math.abs(x * 10) | 0) % 3),
    hp: 70,
    maxHp: 70,
  };
  group.traverse((c) => {
    if (c.isMesh) {
      c.castShadow = true;
      c.userData = group.userData;
    }
  });
  return group;
}

export class ChunkWorld {
  constructor(scene, seed) {
    this.scene = scene;
    this.seed = seed;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.chunks = new Map();
    this.resources = [];
    this.buildings = [];
    this.wreckage = [];
    this.ships = [];
    this.hangars = [];
    this.harvested = new Set();
    this.spawn = new THREE.Vector3(0, 0, 0);
    this.textures = new TextureLibrary();
    this.terrainMat = makeTerrainMaterial(this.textures);
    this._sky();
  }

  setHarvested(keys = []) {
    this.harvested = new Set(keys);
  }

  markHarvested(node) {
    const key = node?.userData?.key;
    if (key) this.harvested.add(key);
  }

  _tryAddResource(id, x, z, nodes = null) {
    const key = resourceKey(id, x, z);
    if (this.harvested.has(key)) return null;
    const y = getHeight(x, z, this.seed);
    const node = createResourceNode(id, x, y, z);
    this.group.add(node);
    this.resources.push(node);
    if (nodes) nodes.push(node);
    if (id === ItemId.WRECK_PART) this.wreckage.push(node);
    return node;
  }

  key(cx, cz) {
    return `${cx},${cz}`;
  }

  build() {
    this.spawn.set(0, getHeight(0, 0, this.seed) + 1.6, 2);
    this.updateChunks(0, 0);
    // Guarantee starter resources near spawn
    this._ensureStarter();
  }

  _sky() {
    const hemi = new THREE.HemisphereLight(0x9ec9ff, 0x2a3a28, 0.9);
    this.group.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 1.15);
    this.sun.position.set(40, 70, 25);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.group.add(this.sun);

    const stars = new THREE.Points(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          Float32Array.from({ length: 1500 }, () => (Math.random() - 0.5) * 400),
          3
        )
      ),
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.45, sizeAttenuation: true })
    );
    this.group.add(stars);

    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(14, 24, 24),
      new THREE.MeshStandardMaterial({ color: 0x4a6fa5, roughness: 0.8, emissive: 0x102040, emissiveIntensity: 0.2 })
    );
    planet.position.set(-70, 45, -100);
    this.group.add(planet);
  }

  _ensureStarter() {
    const starters = [
      [ItemId.WOOD, 4, 0, 6],
      [ItemId.WOOD, -5, 0, 8],
      [ItemId.WOOD, 7, 0, -4],
      [ItemId.CLAY, 3, 0, 10],
      [ItemId.CLAY, -8, 0, 5],
      [ItemId.STONE, 6, 0, 3],
      [ItemId.WATER, -3, 0, 12],
      [ItemId.FOOD, 10, 0, 2],
      [ItemId.SEEDS, 2, 0, -8],
      [ItemId.WRECK_PART, 12, 0, 12],
      [ItemId.WRECK_PART, -14, 0, 9],
    ];
    for (const [id, x, , z] of starters) {
      this._tryAddResource(id, x, z);
    }
  }

  worldToChunk(x, z) {
    const s = CONST.CHUNK_SIZE;
    return [Math.floor(x / s), Math.floor(z / s)];
  }

  updateChunks(px, pz) {
    const [pcx, pcz] = this.worldToChunk(px, pz);
    const need = new Set();
    const r = CONST.CHUNK_LOAD_RADIUS;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        need.add(this.key(pcx + dx, pcz + dz));
        if (!this.chunks.has(this.key(pcx + dx, pcz + dz))) {
          this._spawnChunk(pcx + dx, pcz + dz);
        }
      }
    }
    for (const [k, chunk] of [...this.chunks.entries()]) {
      if (!need.has(k)) {
        this._disposeChunk(k, chunk);
      }
    }
  }

  _spawnChunk(cx, cz) {
    const size = CONST.CHUNK_SIZE;
    const res = CONST.CHUNK_RES;
    const geo = new THREE.PlaneGeometry(size, size, res, res);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = [];
    const ox = cx * size + size / 2;
    const oz = cz * size + size / 2;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const lz = pos.getZ(i);
      const wx = ox + lx;
      const wz = oz + lz;
      const y = getHeight(wx, wz, this.seed);
      pos.setY(i, y);
      const t = THREE.MathUtils.clamp((y + CONST.TERRAIN_HEIGHT) / (CONST.TERRAIN_HEIGHT * 2), 0, 1);
      colors.push(0.25 + t * 0.15, 0.45 + (1 - t) * 0.25, 0.22);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = this.terrainMat.clone();
    mat.vertexColors = true;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(ox, 0, oz);
    mesh.receiveShadow = true;
    mesh.userData.chunk = true;
    this.group.add(mesh);

    const nodes = [];
    // Skip (0,0) dense spawn handled by starter
    if (!(cx === 0 && cz === 0)) {
      const count = 4 + ((hash2(cx + this.seed, cz) * 6) | 0);
      for (let i = 0; i < count; i++) {
        const lx = (hash2(cx, i * 3 + cz) - 0.5) * size * 0.85;
        const lz = (hash2(cz, i * 7 + cx) - 0.5) * size * 0.85;
        const wx = ox + lx;
        const wz = oz + lz;
        const roll = hash2(wx * 0.1, wz * 0.1 + this.seed);
        let id = ItemId.WOOD;
        if (roll < 0.12) id = ItemId.WRECK_PART;
        else if (roll < 0.28) id = ItemId.CLAY;
        else if (roll < 0.4) id = ItemId.STONE;
        else if (roll < 0.5) id = ItemId.IRON;
        else if (roll < 0.58) id = ItemId.COPPER;
        else if (roll < 0.64) id = ItemId.SILICON;
        else if (roll < 0.72) id = ItemId.FOOD;
        else if (roll < 0.8) id = ItemId.WATER;
        else if (roll < 0.88) id = ItemId.SEEDS;
        else if (roll < 0.94) id = ItemId.ORGANIC;
        this._tryAddResource(id, wx, wz, nodes);
      }
    }

    this.chunks.set(this.key(cx, cz), { mesh, nodes });
  }

  _disposeChunk(k, chunk) {
    this.group.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    chunk.mesh.material.dispose();
    for (const n of chunk.nodes) {
      this.group.remove(n);
      this.resources = this.resources.filter((r) => r !== n);
      this.wreckage = this.wreckage.filter((r) => r !== n);
    }
    this.chunks.delete(k);
  }

  surfaceY(x, z) {
    return getHeight(x, z, this.seed);
  }

  addBuilding(id, position, extra = {}) {
    const colors = {
      0: 0x888888,
      1: 0x99a6bf,
      2: 0x8c804f,
      3: 0x4d99e6,
      4: 0x66bfd9,
      5: 0x6b5a40,
      6: 0x3d8bfd,
      7: 0x4a8f3a,
    };
    let geo = new THREE.BoxGeometry(2, 1.2, 2);
    let yOff = 0.6;
    if (id === 5) {
      // Hangar
      geo = new THREE.BoxGeometry(8, 4, 10);
      yOff = 2;
    } else if (id === 6) {
      geo = new THREE.CylinderGeometry(0.8, 1, 2, 10);
      yOff = 1;
    } else if (id === 7) {
      geo = new THREE.BoxGeometry(2.5, 0.25, 2.5);
      yOff = 0.12;
    }
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: colors[id] || 0x777777,
        metalness: id === 5 || id === 6 ? 0.45 : 0.1,
        roughness: 0.6,
        emissive: id === 6 ? 0x2244aa : 0x000000,
        emissiveIntensity: id === 6 ? 0.5 : 0,
      })
    );
    mesh.position.copy(position);
    mesh.position.y = this.surfaceY(position.x, position.z) + yOff;
    mesh.userData = { kind: "building", buildingId: id, ...extra };
    mesh.castShadow = true;
    this.group.add(mesh);
    this.buildings.push(mesh);
    if (id === 5) this.hangars.push(mesh);
    return mesh;
  }

  addShip(position) {
    const ship = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.8, 4.5),
      new THREE.MeshStandardMaterial({ color: 0x8a9bb0, metalness: 0.7, roughness: 0.3 })
    );
    body.position.y = 0.6;
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(4.5, 0.12, 1.2),
      new THREE.MeshStandardMaterial({ color: 0x5a6a7a, metalness: 0.6, roughness: 0.4 })
    );
    wing.position.set(0, 0.55, 0.2);
    const cockpit = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 12, 10),
      new THREE.MeshStandardMaterial({
        color: 0x66ddff,
        transparent: true,
        opacity: 0.7,
        emissive: 0x2288aa,
        emissiveIntensity: 0.4,
      })
    );
    cockpit.position.set(0, 1.0, -1.3);
    ship.add(body, wing, cockpit);
    ship.position.copy(position);
    ship.position.y = this.surfaceY(position.x, position.z);
    ship.userData = { kind: "ship", ready: true };
    ship.traverse((c) => {
      if (c.isMesh) c.userData = ship.userData;
    });
    this.group.add(ship);
    this.ships.push(ship);
    return ship;
  }

  updateDayNight(t) {
    if (!this.sun) return;
    const a = t * 0.04;
    this.sun.position.set(Math.cos(a) * 55, 35 + Math.sin(a) * 40, Math.sin(a) * 55);
    this.sun.intensity = 0.65 + Math.max(Math.sin(a), 0) * 0.7;
  }

  serializePlanet() {
    return {
      seed: this.seed,
      harvested: [...this.harvested],
      buildings: this.buildings.map((b) => ({
        id: b.userData.buildingId,
        x: b.position.x,
        y: b.position.y,
        z: b.position.z,
      })),
      ships: this.ships.map((s) => ({
        x: s.position.x,
        y: s.position.y,
        z: s.position.z,
      })),
    };
  }

  restoreStructures(state) {
    if (!state) return;
    for (const b of state.buildings || []) {
      this.addBuilding(b.id, { x: b.x, y: b.y, z: b.z });
    }
    for (const s of state.ships || []) {
      this.addShip({ x: s.x, y: s.y, z: s.z });
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.chunks.clear();
    this.resources = [];
    this.buildings = [];
    this.wreckage = [];
    this.ships = [];
    this.hangars = [];
  }
}

// Back-compat alias used by game.js
export { ChunkWorld as World };
