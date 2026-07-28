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
    noise2(x * 0.08, z * 0.08) * 0.3 +
    noise2(x * 0.16, z * 0.16) * 0.12
  );
}

export function getHeight(x, z, seed = 42) {
  const ox = seed * 0.17;
  const oz = seed * 0.31;
  return (fbm(x / CONST.PLANET_SCALE + ox, z / CONST.PLANET_SCALE + oz) * 2 - 1) * CONST.TERRAIN_HEIGHT;
}

function terrainColor(x, y, z, seed) {
  const n = noise2(x * 0.05 + seed, z * 0.05);
  const heightT = THREE.MathUtils.clamp((y + CONST.TERRAIN_HEIGHT) / (CONST.TERRAIN_HEIGHT * 2), 0, 1);
  const slope = Math.abs(getHeight(x + 1, z, seed) - getHeight(x - 1, z, seed)) +
    Math.abs(getHeight(x, z + 1, seed) - getHeight(x, z - 1, seed));
  const slopeT = THREE.MathUtils.clamp(slope * 0.15, 0, 1);

  // valley moss → mid grass → high rock
  const low = new THREE.Color(0x1a3d28);
  const mid = new THREE.Color(0x2d5a38);
  const high = new THREE.Color(0x5a6b72);
  const rock = new THREE.Color(0x8a9499);

  const c = new THREE.Color();
  if (heightT < 0.35) c.lerpColors(low, mid, heightT / 0.35);
  else if (heightT < 0.65) c.lerpColors(mid, high, (heightT - 0.35) / 0.3);
  else c.lerpColors(high, rock, (heightT - 0.65) / 0.35);

  c.lerp(rock, slopeT * 0.65);
  c.offsetHSL(0, 0, (n - 0.5) * 0.06);
  return c;
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
    this.dayFactor = 1;
    scene.add(this.group);
  }

  build() {
    this._makeStars();
    this._makeSky();
    this._makeTerrain();
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
    this.resources = [];
    this.wreckage = [];
    this.buildings = [];
  }

  _makeStars() {
    const count = 2200;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 180 + Math.random() * 80;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi) * 0.6 + 20;
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.stars = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xddeeff,
        size: 0.55,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
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

    this.anomaly = new THREE.Mesh(
      new THREE.SphereGeometry(3, 32, 32),
      new THREE.MeshStandardMaterial({
        color: 0x6640ff,
        emissive: 0x5533ff,
        emissiveIntensity: 2.2,
        roughness: 0.2,
        metalness: 0.1,
      })
    );
    this.anomaly.position.set(-40, 35, -50);
    this.group.add(this.anomaly);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(20, 1.2, 12, 64),
      new THREE.MeshStandardMaterial({
        color: 0xc8d8ee,
        transparent: true,
        opacity: 0.45,
        emissive: 0x446688,
        emissiveIntensity: 0.55,
        roughness: 0.35,
        metalness: 0.4,
      })
    );
    ring.position.set(0, 60, -80);
    ring.rotation.set(1.2, 0, 0.25);
    this.group.add(ring);
  }

  _makeTerrain() {
    const size = CONST.PLANET_SIZE;
    const scale = CONST.PLANET_SCALE;
    const geo = new THREE.PlaneGeometry(size * scale, size * scale, size, size);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = getHeight(x, z, this.seed);
      pos.setY(i, y);
      const c = terrainColor(x, y, z, this.seed);
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.04,
    });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.group.add(this.terrain);
  }

  _makeDust() {
    const count = 120;
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
    const pod = new THREE.Mesh(
      new THREE.CapsuleGeometry(1.2, 1.4, 8, 16),
      new THREE.MeshStandardMaterial({
        color: 0xbcc6d6,
        metalness: 0.65,
        roughness: 0.28,
        emissive: 0x223344,
        emissiveIntensity: 0.15,
      })
    );
    pod.position.set(0, h + 1.6, 0);
    pod.castShadow = true;
    this.group.add(pod);

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
      const y = this.surfaceY(x, z) + 0.55;
      const itemId = types[i % types.length];
      const color = ITEM_COLORS[itemId];
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.55, 0),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.35,
          roughness: 0.35,
          metalness: 0.55,
          flatShading: true,
        })
      );
      mesh.position.set(x, y, z);
      mesh.rotation.y = hash2(i * 3, this.seed) * Math.PI;
      mesh.castShadow = true;
      mesh.userData = {
        kind: "resource",
        itemId,
        drop: 2 + (i % 4),
        hp: 80 + (i % 4) * 10,
        maxHp: 80 + (i % 4) * 10,
        baseScale: 1,
        pulse: hash2(i, this.seed * 2) * Math.PI * 2,
      };
      this.group.add(mesh);
      this.resources.push(mesh);
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
      const y = this.surfaceY(x, z) + 0.4;
      const isCore = i === 0;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(isCore ? 3.2 : 2, isCore ? 1.6 : 1, isCore ? 2.4 : 1.5),
        new THREE.MeshStandardMaterial({
          color: isCore ? 0x4d80e6 : 0x59626b,
          metalness: 0.78,
          roughness: 0.32,
          emissive: isCore ? 0x3366cc : 0x111820,
          emissiveIntensity: isCore ? 1.1 : 0.2,
        })
      );
      mesh.position.set(x, y, z);
      mesh.rotation.y = hash2(x, z) * Math.PI;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
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
