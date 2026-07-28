import * as THREE from "three";
import {
  BuildingId,
  CONST,
  ITEM_COLORS,
  ItemId,
} from "./constants.js";

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
    noise2(x * 0.08, z * 0.08) * 0.3
  );
}

export function getHeight(x, z, seed = 42) {
  const ox = seed * 0.17;
  const oz = seed * 0.31;
  return (fbm(x / CONST.PLANET_SCALE + ox, z / CONST.PLANET_SCALE + oz) * 2 - 1) * CONST.TERRAIN_HEIGHT;
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
    scene.add(this.group);
  }

  build() {
    this._makeSky();
    this._makeTerrain();
    this._makePod();
    this._spawnResources();
    this._spawnWreckage();
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
    this.resources = [];
    this.wreckage = [];
    this.buildings = [];
  }

  _makeSky() {
    const hemi = new THREE.HemisphereLight(0x8eb1ff, 0x2a3a28, 0.85);
    this.group.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d1, 1.2);
    this.sun.position.set(40, 60, 20);
    this.sun.castShadow = false;
    this.group.add(this.sun);

    const anomaly = new THREE.Mesh(
      new THREE.SphereGeometry(3, 24, 24),
      new THREE.MeshStandardMaterial({
        color: 0x6640ff,
        emissive: 0x5533ff,
        emissiveIntensity: 1.4,
      })
    );
    anomaly.position.set(-40, 35, -50);
    this.group.add(anomaly);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(20, 1.2, 12, 64),
      new THREE.MeshStandardMaterial({
        color: 0xaabbcc,
        transparent: true,
        opacity: 0.55,
        emissive: 0x334466,
        emissiveIntensity: 0.4,
      })
    );
    ring.position.set(0, 60, -80);
    ring.rotation.set(1.2, 0, 0.25);
    this.group.add(ring);
  }

  _makeTerrain() {
    const size = CONST.PLANET_SIZE;
    const scale = CONST.PLANET_SCALE;
    const geo = new THREE.PlaneGeometry(
      size * scale,
      size * scale,
      size,
      size
    );
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = getHeight(x, z, this.seed);
      pos.setY(i, y);
      const t = THREE.MathUtils.clamp((y + CONST.TERRAIN_HEIGHT) / (CONST.TERRAIN_HEIGHT * 2), 0, 1);
      colors.push(0.18 + t * 0.12, 0.42 + t * 0.2, 0.2 + t * 0.08);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.05,
    });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.group.add(this.terrain);
  }

  surfaceY(x, z) {
    return getHeight(x, z, this.seed);
  }

  _makePod() {
    const h = this.surfaceY(0, 0);
    const pod = new THREE.Mesh(
      new THREE.CapsuleGeometry(1.2, 1.4, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0xbcc6d6, metalness: 0.6, roughness: 0.35 })
    );
    pod.position.set(0, h + 1.6, 0);
    this.group.add(pod);
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
    let n = 0;
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const r = 8 + (i % 7) * 6 + hash2(i, this.seed) * 4;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = this.surfaceY(x, z) + 0.5;
      const itemId = types[i % types.length];
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: ITEM_COLORS[itemId] })
      );
      mesh.position.set(x, y, z);
      mesh.userData = {
        kind: "resource",
        itemId,
        drop: 2 + (i % 4),
        hp: 80 + (i % 4) * 10,
        maxHp: 80 + (i % 4) * 10,
      };
      this.group.add(mesh);
      this.resources.push(mesh);
      n++;
    }
    return n;
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
      const y = this.surfaceY(x, z) + 0.4;
      const isCore = i === 0;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(isCore ? 3.2 : 2, isCore ? 1.6 : 1, isCore ? 2.4 : 1.5),
        new THREE.MeshStandardMaterial({
          color: isCore ? 0x4d80e6 : 0x59626b,
          metalness: 0.75,
          roughness: 0.4,
          emissive: isCore ? 0x2244aa : 0x000000,
          emissiveIntensity: isCore ? 0.8 : 0,
        })
      );
      mesh.position.set(x, y, z);
      mesh.userData = {
        kind: "wreckage",
        isCore,
        looted: false,
        lootItem: ItemId.CIRCUIT,
        lootAmount: isCore ? 3 : 2,
      };
      this.group.add(mesh);
      this.wreckage.push(mesh);
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
        yOff = 1;
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
      emissive: id === BuildingId.GENERATOR ? 0x3377ff : 0x000000,
      emissiveIntensity: id === BuildingId.GENERATOR ? 0.6 : 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position);
    mesh.position.y += yOff;
    mesh.userData = { kind: "building", buildingId: id };
    this.group.add(mesh);
    this.buildings.push(mesh);
    return mesh;
  }

  updateDayNight(t) {
    if (!this.sun) return;
    const angle = t * 0.05;
    this.sun.position.set(Math.cos(angle) * 50, 30 + Math.sin(angle) * 40, Math.sin(angle) * 50);
    this.sun.intensity = 0.7 + Math.max(Math.sin(angle), 0) * 0.7;
  }
}
