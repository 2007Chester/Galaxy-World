import * as THREE from "three";
import { BuildingId, CONST, ItemId } from "./constants.js";
import { buildBuildingVisual } from "./buildingMeshes.js";
import { buildResourceVisual } from "./resourceMeshes.js";
import { TextureLibrary } from "./proceduralTextures.js";
import {
  bakeSkyEnvironment,
  configureSunLight,
  createSky,
  setSunFromAngles,
} from "./graphics.js";
import { buildShipVisual } from "./shipMeshes.js";

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

/** 0..~2 — mountain uplift; ranges vary from hills to tall massifs. */
export function mountainElevation(x, z, seed = 42) {
  const ox = seed * 0.17;
  const oz = seed * 0.41;
  const dist = Math.hypot(x, z);
  // Keep spawn approachable — mountains appear farther out
  const spawnFade = THREE.MathUtils.smoothstep(52, 110, dist);

  // Large domains: whole ranges, not speckles
  const domain = noise2(x * 0.0036 + ox, z * 0.0036 + oz);
  if (domain < 0.6) return 0;

  const band = (domain - 0.6) / 0.4;
  // Massif scale: small foothills vs big mountains
  const massif = 0.3 + noise2(x * 0.0016 + 9.1, z * 0.0016 + oz) * 1.8;
  const ridge = fbm(x * 0.022 + ox, z * 0.022 + oz);
  const peak = Math.pow(band, 1.4) * (0.2 + ridge * 0.8);
  return peak * massif * spawnFade;
}

export function getHeight(x, z, seed = 42) {
  const ox = seed * 0.13;
  const oz = seed * 0.29;
  let h = (fbm(x * 0.04 + ox, z * 0.04 + oz) * 2 - 1) * CONST.TERRAIN_HEIGHT;

  // Mountains of varying size (separate from base rolling hills)
  h += mountainElevation(x, z, seed) * CONST.TERRAIN_HEIGHT * 1.75;

  // River carve — winding channel
  const riverN = noise2(x * 0.012 + ox, z * 0.012 + oz);
  const riverDist = Math.abs(riverN - 0.52);
  if (riverDist < 0.045) {
    const depth = (1 - riverDist / 0.045) * 3.2;
    h -= depth;
  }

  // Starter lake basin near spawn
  const ldx = x + 8;
  const ldz = z - 16;
  const lakeR = 9;
  const lakeD = ldx * ldx + ldz * ldz;
  if (lakeD < lakeR * lakeR) {
    const t = 1 - Math.sqrt(lakeD) / lakeR;
    h = Math.min(h, CONST.WATER_LEVEL - 0.6 - t * 1.8);
  }

  // Coastal sea — far positive X slopes into ocean
  if (x > 55) {
    const coast = Math.min(1, (x - 55) / 40);
    h -= coast * 6;
  }

  return h;
}

export function isWaterCell(x, z, seed = 42) {
  return getHeight(x, z, seed) < CONST.WATER_LEVEL;
}

export function waterBodyLabel(x, z, seed = 42) {
  if (x > 70) return "Море";
  const riverN = noise2(x * 0.012 + seed * 0.13, z * 0.012 + seed * 0.29);
  if (Math.abs(riverN - 0.52) < 0.05) return "Река";
  return "Озеро";
}

/** Near water but on land — clay banks. */
function nearWaterBank(x, z, seed) {
  if (isWaterCell(x, z, seed)) return false;
  const step = 2.5;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      if (isWaterCell(x + dx * step, z + dz * step, seed)) return true;
    }
  }
  return false;
}

export const Biome = {
  WATER: "water",
  PLAINS: "plains",
  FOREST: "forest",
  DESERT: "desert",
  MOUNTAIN: "mountain",
};

/**
 * Large-scale climate fields. Forests and deserts sit on opposite axes
 * so they rarely share the same region.
 */
function climateFields(x, z, seed) {
  const moisture =
    noise2(x * 0.0032 + seed * 0.11, z * 0.0032 + seed * 0.19) * 0.78 +
    noise2(x * 0.011 + 4.2, z * 0.011 + 1.7) * 0.22;
  const heat =
    noise2(x * 0.003 + 81.5, z * 0.003 + seed * 0.31) * 0.78 +
    noise2(x * 0.01 + 6.4, z * 0.01 + 2.8) * 0.22;
  return { moisture, heat };
}

/**
 * Biome at world position. Spawn stays plains; forests / deserts / mountains
 * appear as separated regions farther out.
 */
export function getBiome(x, z, seed = 42) {
  if (isWaterCell(x, z, seed)) return Biome.WATER;

  const elev = mountainElevation(x, z, seed);
  if (elev > 0.32) return Biome.MOUNTAIN;

  const dist = Math.hypot(x, z);
  // Soft ring: biomes fade in away from camp so they aren't stacked at spawn
  const explore = THREE.MathUtils.smoothstep(42, 95, dist);
  if (explore < 0.08) return Biome.PLAINS;

  const { moisture, heat } = climateFields(x, z, seed);
  const forestScore = (moisture - 0.56) * explore;
  const desertScore = (heat - moisture * 0.92 - 0.1) * explore;

  // Contested climate → plains buffer so forest and desert don't sit flush
  if (forestScore > 0.04 && desertScore > 0.04 && Math.abs(forestScore - desertScore) < 0.05) {
    return Biome.PLAINS;
  }

  if (desertScore > 0.055 && desertScore >= forestScore + 0.02) return Biome.DESERT;
  if (forestScore > 0.05) return Biome.FOREST;
  return Biome.PLAINS;
}

/**
 * Soil type for digging: "clay" | "dirt" | "grass" | "sand" | "rock" | "water"
 */
export function getSoilType(x, z, seed = 42) {
  if (isWaterCell(x, z, seed)) return "water";

  const biome = getBiome(x, z, seed);
  if (biome === Biome.DESERT) return "sand";
  if (biome === Biome.MOUNTAIN) {
    const rockN = noise2(x * 0.05 + seed, z * 0.05);
    return rockN > 0.45 ? "rock" : "dirt";
  }

  // Starter clay bank near lake (southeast of spawn lake center -8,16)
  const cdx = x + 2;
  const cdz = z - 10;
  if (cdx * cdx + cdz * cdz < 36 && nearWaterBank(x, z, seed)) return "clay";

  const clayN = noise2(x * 0.04 + seed * 0.17, z * 0.04 + seed * 0.31);
  if (nearWaterBank(x, z, seed) && clayN > 0.58) return "clay";

  // Rare inland clay pockets (not in desert)
  const pocket = noise2(x * 0.02 + 40, z * 0.02 + seed);
  if (pocket > 0.82 && clayN > 0.7) return "clay";

  const dirtN = noise2(x * 0.028 + 12, z * 0.028 + 7);
  const dirtLo = biome === Biome.FOREST ? 0.42 : 0.52;
  const dirtHi = biome === Biome.FOREST ? 0.88 : 0.78;
  if (dirtN > dirtLo && dirtN < dirtHi) return "dirt";

  return "grass";
}

/** Local canopy density inside a forest biome (0..1). */
export function forestDensity(x, z, seed = 42) {
  const n1 = noise2(x * 0.012 + seed * 0.11, z * 0.012 + seed * 0.19);
  const n2 = noise2(x * 0.03 + 11, z * 0.03 + seed * 0.07);
  return n1 * 0.65 + n2 * 0.35;
}

export function isForestCell(x, z, seed = 42) {
  return getBiome(x, z, seed) === Biome.FOREST;
}

function makeTerrainMaterial(tex) {
  return new THREE.MeshStandardMaterial({
    map: tex.grass,
    normalMap: tex.grassNormal,
    normalScale: new THREE.Vector2(1.1, 1.1),
    roughnessMap: tex.grassRoughness,
    roughness: 0.92,
    metalness: 0.02,
    flatShading: false,
    envMapIntensity: 0.55,
    vertexColors: true,
  });
}

function createWaterUniforms(tex) {
  return {
    uTime: { value: 0 },
    uMap: { value: tex.water },
    uNormalMap: { value: tex.waterNormal },
    uSunDir: { value: new THREE.Vector3(0.4, 0.85, 0.25).normalize() },
    uCamPos: { value: new THREE.Vector3() },
    uShallow: { value: new THREE.Color(0x5ad0ef) },
    uDeep: { value: new THREE.Color(0x062848) },
    uSky: { value: new THREE.Color(0xb8e4ff) },
    uHorizon: { value: new THREE.Color(0x7eb8e0) },
  };
}

function makeWaterMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute float aDepth;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vDepth;
      varying float vWave;

      void main() {
        vUv = uv;
        vDepth = aDepth;
        vec3 pos = position;
        float w1 = sin(pos.x * 0.48 + uTime * 1.35) * cos(pos.z * 0.37 + uTime * 0.95);
        float w2 = sin(pos.x * 1.05 - uTime * 1.85 + pos.z * 0.65) * 0.5;
        float w3 = sin((pos.x + pos.z) * 0.22 + uTime * 0.55) * 0.4;
        float w4 = sin(pos.x * 2.4 + pos.z * 1.8 - uTime * 2.6) * 0.12;
        float wave = (w1 + w2 + w3 + w4) * 0.11;
        pos.y += wave;
        vWave = wave;

        float dx = cos(pos.x * 0.48 + uTime * 1.35) * 0.48 * 0.11
                 + cos(pos.x * 1.05 - uTime * 1.85 + pos.z * 0.65) * 1.05 * 0.055;
        float dz = -sin(pos.z * 0.37 + uTime * 0.95) * 0.37 * 0.11
                 + cos(pos.x * 1.05 - uTime * 1.85 + pos.z * 0.65) * 0.65 * 0.055;
        vNormal = normalize(vec3(-dx, 1.0, -dz));

        vec4 world = modelMatrix * vec4(pos, 1.0);
        vWorldPos = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform sampler2D uMap;
      uniform sampler2D uNormalMap;
      uniform vec3 uSunDir;
      uniform vec3 uCamPos;
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uSky;
      uniform vec3 uHorizon;

      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vDepth;
      varying float vWave;

      void main() {
        vec2 uv1 = vUv * 2.2 + vec2(uTime * 0.028, uTime * 0.018);
        vec2 uv2 = vUv * 4.1 + vec2(-uTime * 0.022, uTime * 0.031);
        vec3 nTex1 = texture2D(uNormalMap, uv1).xyz * 2.0 - 1.0;
        vec3 nTex2 = texture2D(uNormalMap, uv2).xyz * 2.0 - 1.0;
        vec3 nMap = normalize(nTex1 * 0.7 + nTex2 * 0.55);
        vec3 N = normalize(vNormal + nMap * 0.55);

        vec3 V = normalize(uCamPos - vWorldPos);
        float ndv = max(dot(N, V), 0.0);
        float fresnel = pow(1.0 - ndv, 4.0);
        fresnel = mix(0.08, 1.0, fresnel);

        float depthFactor = clamp(vDepth / 3.4, 0.0, 1.0);
        vec3 baseTex = texture2D(uMap, vUv * 1.6 + uTime * 0.008).rgb;
        vec3 waterCol = mix(uShallow, uDeep, pow(depthFactor, 0.85));
        waterCol = mix(waterCol, baseTex, 0.22);

        // Fake sky reflection from view/reflection vector
        vec3 R = reflect(-V, N);
        float skyT = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 skyCol = mix(uHorizon, uSky, pow(skyT, 0.7));

        vec3 H = normalize(uSunDir + V);
        float spec = pow(max(dot(N, H), 0.0), 140.0);
        float sparkle = pow(max(dot(N, H), 0.0), 28.0) * 0.4;
        float diffuse = max(dot(N, uSunDir), 0.0) * 0.25;

        float foam = smoothstep(1.0, 0.12, vDepth);
        foam *= 0.5 + 0.5 * sin(vWorldPos.x * 3.2 + vWorldPos.z * 2.7 + uTime * 2.8);
        foam = clamp(foam + abs(vWave) * 2.0 * (1.0 - depthFactor), 0.0, 1.0);

        vec3 col = mix(waterCol, skyCol, fresnel * 0.82);
        col += diffuse * waterCol;
        col += vec3(0.9, 0.96, 1.0) * (spec * 1.55 + sparkle);
        col = mix(col, vec3(0.94, 0.98, 1.0), foam * 0.9);

        float alpha = mix(0.52, 0.9, depthFactor);
        alpha = mix(alpha, 0.96, foam * 0.55);
        alpha = mix(alpha, 0.94, fresnel * 0.4);

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

function makeDirtPatchMaterial(tex) {
  const mat = new THREE.MeshStandardMaterial({
    map: tex.dirt,
    normalMap: tex.dirtNormal,
    normalScale: new THREE.Vector2(1.25, 1.25),
    roughnessMap: tex.dirtRoughness,
    roughness: 1,
    metalness: 0.02,
    color: 0xb08958,
    envMapIntensity: 0.45,
  });
  if (tex.dirt) tex.dirt.repeat.set(5, 5);
  if (tex.dirtNormal) tex.dirtNormal.repeat.set(5, 5);
  if (tex.dirtRoughness) tex.dirtRoughness.repeat.set(5, 5);
  return mat;
}

function makeClayPatchMaterial(tex) {
  const mat = new THREE.MeshStandardMaterial({
    map: tex.clay,
    normalMap: tex.clayNormal,
    normalScale: new THREE.Vector2(1.45, 1.45),
    roughnessMap: tex.clayRoughness,
    roughness: 0.82,
    metalness: 0.05,
    color: 0xe0a878,
    envMapIntensity: 0.55,
  });
  if (tex.clay) tex.clay.repeat.set(4, 4);
  if (tex.clayNormal) tex.clayNormal.repeat.set(4, 4);
  if (tex.clayRoughness) tex.clayRoughness.repeat.set(4, 4);
  return mat;
}

function resourceKey(itemId, x, z) {
  return `${itemId}:${x.toFixed(1)}:${z.toFixed(1)}`;
}

function createResourceNode(itemId, x, y, z) {
  const group = buildResourceVisual(itemId);
  const legs = group.userData.legs || [];
  const tail = group.userData.tail || null;
  const isAnimal = !!group.userData.isAnimal;
  const isFish = !!group.userData.isFish;

  group.position.set(x, y, z);
  group.rotation.y = hash2(x * 0.7, z * 1.3) * Math.PI * 2;
  const key = resourceKey(itemId, x, z);
  group.userData = {
    kind: "resource",
    itemId,
    key,
    drop: itemId === ItemId.FISH ? 1 : itemId === ItemId.WRECK_PART ? 1 : 2 + ((Math.abs(x * 10) | 0) % 3),
    hp: itemId === ItemId.FISH ? 45 : itemId === ItemId.WRECK_PART ? 1 : 70,
    maxHp: itemId === ItemId.FISH ? 45 : itemId === ItemId.WRECK_PART ? 1 : 70,
    isAnimal,
    isFish,
    pickup: itemId === ItemId.WRECK_PART,
    displayName: itemId === ItemId.FISH ? "Рыба" : itemId === ItemId.WRECK_PART ? "Обломок корабля" : undefined,
    legs,
    tail,
    homeX: x,
    homeZ: z,
    walkPhase: Math.random() * Math.PI * 2,
    stateTimer: 0.5 + Math.random() * 2,
    walking: true,
    speed: isFish ? 1.6 + Math.random() * 1.2 : 1.15 + Math.random() * 0.85,
    targetX: x + (Math.random() - 0.5) * 6,
    targetZ: z + (Math.random() - 0.5) * 6,
  };
  group.traverse((c) => {
    if (c.isMesh) c.castShadow = true;
  });
  return group;
}

export class ChunkWorld {
  constructor(scene, seed, renderer = null) {
    this.scene = scene;
    this.renderer = renderer;
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
    this.waterUniforms = createWaterUniforms(this.textures);
    this.terrainMat = makeTerrainMaterial(this.textures);
    this.waterMat = makeWaterMaterial(this.waterUniforms);
    this.dirtPatchMat = makeDirtPatchMaterial(this.textures);
    this.clayPatchMat = makeClayPatchMaterial(this.textures);
    this._envCache = {};
    this._skyBakeTimer = 0;
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
    if (id === ItemId.WATER || id === ItemId.CLAY || id === ItemId.DIRT || id === ItemId.FISH) {
      return null;
    }
    if (isWaterCell(x, z, this.seed)) return null;
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

  _addWaterSurface(cx, cz) {
    const size = CONST.CHUNK_SIZE;
    const step = 1;
    const ox = cx * size;
    const oz = cz * size;
    const positions = [];
    const indices = [];
    const depths = [];
    let vi = 0;
    let wet = 0;
    const sampleLabel = { x: 0, z: 0 };

    for (let z = 0; z < size; z += step) {
      for (let x = 0; x < size; x += step) {
        const wx = ox + x + step * 0.5;
        const wz = oz + z + step * 0.5;
        if (!isWaterCell(wx, wz, this.seed)) continue;
        wet++;
        sampleLabel.x = wx;
        sampleLabel.z = wz;
        const y = CONST.WATER_LEVEL + 0.03;
        const x0 = ox + x;
        const z0 = oz + z;
        const x1 = x0 + step;
        const z1 = z0 + step;
        const corners = [
          [x0, z0],
          [x0, z1],
          [x1, z1],
          [x1, z0],
        ];
        for (const [px, pz] of corners) {
          positions.push(px, y, pz);
          depths.push(Math.max(0.05, CONST.WATER_LEVEL - getHeight(px, pz, this.seed)));
        }
        indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
        vi += 4;
      }
    }

    if (wet === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("aDepth", new THREE.Float32BufferAttribute(depths, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const uvs = [];
    for (let i = 0; i < positions.length / 3; i++) {
      uvs.push(positions[i * 3] * 0.07, positions[i * 3 + 2] * 0.07);
    }
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));

    const mesh = new THREE.Mesh(geo, this.waterMat);
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    const label = waterBodyLabel(sampleLabel.x, sampleLabel.z, this.seed);
    mesh.userData = {
      kind: "resource",
      itemId: ItemId.WATER,
      key: `water:${cx},${cz}`,
      drop: 2,
      hp: 50,
      maxHp: 50,
      infinite: true,
      waterBody: label,
      displayName: label,
      sharedWaterMat: true,
    };
    this.group.add(mesh);
    this.resources.push(mesh);
    return mesh;
  }

  _addFishInChunk(cx, cz) {
    const size = CONST.CHUNK_SIZE;
    const ox = cx * size;
    const oz = cz * size;
    const fish = [];
    const waterSamples = [];

    for (let z = 2; z < size; z += 4) {
      for (let x = 2; x < size; x += 4) {
        const wx = ox + x;
        const wz = oz + z;
        if (isWaterCell(wx, wz, this.seed)) waterSamples.push([wx, wz]);
      }
    }
    if (!waterSamples.length) return fish;

    // More fish in larger water bodies; guarantee a few in the starter lake chunk
    const lakeish = waterSamples.length >= 8;
    const count = Math.min(
      waterSamples.length,
      lakeish ? 2 + ((hash2(cx + 3, cz + this.seed) * 3) | 0) : hash2(cx, cz + 9) > 0.55 ? 1 : 0
    );
    // Starter lake around (-8, 16)
    const nearStarterLake =
      Math.hypot(ox + size * 0.5 + 8, oz + size * 0.5 - 16) < size * 1.2;
    const n = nearStarterLake ? Math.max(count, 3) : count;

    for (let i = 0; i < n; i++) {
      const idx = (hash2(cx * 17 + i, cz * 13 + this.seed) * waterSamples.length) | 0;
      const [wx, wz] = waterSamples[idx % waterSamples.length];
      const jx = wx + (hash2(wx, i) - 0.5) * 2;
      const jz = wz + (hash2(wz, i + 2) - 0.5) * 2;
      if (!isWaterCell(jx, jz, this.seed)) continue;
      const key = resourceKey(ItemId.FISH, jx, jz);
      if (this.harvested.has(key)) continue;
      const y = CONST.WATER_LEVEL - 0.35;
      const node = createResourceNode(ItemId.FISH, jx, y, jz);
      node.position.y = y;
      this.group.add(node);
      this.resources.push(node);
      fish.push(node);
    }
    return fish;
  }

  _addSoilPatches(cx, cz) {
    const size = CONST.CHUNK_SIZE;
    const step = 1;
    const ox = cx * size;
    const oz = cz * size;
    const dirtPos = [];
    const clayPos = [];
    const dirtIdx = [];
    const clayIdx = [];

    const pushQuad = (arr, indices, viRef, x0, z0) => {
      const x1 = x0 + step;
      const z1 = z0 + step;
      const corners = [
        [x0, z0],
        [x0, z1],
        [x1, z1],
        [x1, z0],
      ];
      for (const [px, pz] of corners) {
        const h = getHeight(px, pz, this.seed) + 0.05;
        const micro = (hash2(px * 1.7, pz * 2.1) - 0.5) * 0.04;
        arr.push(px, h + micro, pz);
      }
      const vi = viRef.v;
      indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
      viRef.v += 4;
    };

    const dRef = { v: 0 };
    const cRef = { v: 0 };

    for (let z = 0; z < size; z += step) {
      for (let x = 0; x < size; x += step) {
        const wx = ox + x + step * 0.5;
        const wz = oz + z + step * 0.5;
        const soil = getSoilType(wx, wz, this.seed);
        if (soil !== "dirt" && soil !== "clay") continue;
        if (soil === "clay") pushQuad(clayPos, clayIdx, cRef, ox + x, oz + z);
        else pushQuad(dirtPos, dirtIdx, dRef, ox + x, oz + z);
      }
    }

    const patches = [];
    const makePatch = (positions, indices, itemId, mat, label) => {
      if (!positions.length) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const uvs = [];
      for (let i = 0; i < positions.length / 3; i++) {
        uvs.push(positions[i * 3] * 0.18, positions[i * 3 + 2] * 0.18);
      }
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      try {
        geo.computeTangents();
      } catch {
        /* older three without indexed tangents */
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.userData = {
        kind: "resource",
        itemId,
        key: `${itemId === ItemId.CLAY ? "clay" : "dirt"}:${cx},${cz}`,
        drop: 2,
        hp: 55,
        maxHp: 55,
        infinite: true,
        displayName: label,
        groundDig: true,
        sharedSoilMat: true,
      };
      this.group.add(mesh);
      this.resources.push(mesh);
      return mesh;
    };

    const dirt = makePatch(dirtPos, dirtIdx, ItemId.DIRT, this.dirtPatchMat, "Земля");
    const clay = makePatch(clayPos, clayIdx, ItemId.CLAY, this.clayPatchMat, "Глиняная отмель");
    if (dirt) patches.push(dirt);
    if (clay) patches.push(clay);
    return patches;
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
    // Remove previous sky if any
    const oldSky = this.scene.getObjectByName("pbrSky");
    if (oldSky) this.scene.remove(oldSky);

    this.sky = createSky(this.scene);

    const hemi = new THREE.HemisphereLight(0xb8d8ff, 0x3a2a18, 0.55);
    this.group.add(hemi);
    this.hemi = hemi;

    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
    this.sun.position.set(40, 70, 25);
    configureSunLight(this.sun);
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    this.fill = new THREE.DirectionalLight(0x8eb8ff, 0.35);
    this.fill.position.set(-30, 25, -40);
    this.group.add(this.fill);

    this.ambient = new THREE.AmbientLight(0x1a2430, 0.22);
    this.group.add(this.ambient);

    // Distant planet / stars for horizon depth
    const stars = new THREE.Points(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          Float32Array.from({ length: 2400 }, () => (Math.random() - 0.5) * 500),
          3
        )
      ),
      new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.55,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      })
    );
    stars.position.y = 40;
    this.group.add(stars);

    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(16, 32, 32),
      new THREE.MeshStandardMaterial({
        color: 0x4a6fa5,
        roughness: 0.75,
        metalness: 0.1,
        emissive: 0x102040,
        emissiveIntensity: 0.25,
        envMapIntensity: 0.8,
      })
    );
    planet.position.set(-90, 55, -120);
    this.group.add(planet);

    setSunFromAngles(this.sky, this.sun, 0.72, 0.35);
    if (this.renderer) {
      bakeSkyEnvironment(this.renderer, this.sky, this.scene, this._envCache);
    }
  }

  setRenderer(renderer) {
    this.renderer = renderer;
    if (this.sky) bakeSkyEnvironment(renderer, this.sky, this.scene, this._envCache);
  }

  _ensureStarter() {
    const starters = [
      [ItemId.WOOD, 4, 0, 6],
      [ItemId.WOOD, -5, 0, 8],
      [ItemId.WOOD, 7, 0, -4],
      [ItemId.WOOD, -3, 0, -6],
      [ItemId.WOOD, 9, 0, 5],
      [ItemId.STONE, 6, 0, 3],
      [ItemId.FOOD, 10, 0, 2],
      [ItemId.SEEDS, 2, 0, -8],
      [ItemId.WRECK_PART, 12, 0, 12],
      [ItemId.WRECK_PART, -14, 0, 9],
    ];
    for (const [id, x, , z] of starters) {
      if (isWaterCell(x, z, this.seed)) continue;
      this._tryAddResource(id, x, z);
    }
  }

  _addTreesInChunk(cx, cz, nodes) {
    const size = CONST.CHUNK_SIZE;
    const ox = cx * size;
    const oz = cz * size;
    const centerBiome = getBiome(ox + size * 0.5, oz + size * 0.5, this.seed);
    if (centerBiome !== Biome.FOREST && centerBiome !== Biome.PLAINS) return;

    // Dense canopy only inside forest biomes
    if (centerBiome === Biome.FOREST) {
      const step = 3.8;
      for (let z = 1; z < size; z += step) {
        for (let x = 1; x < size; x += step) {
          const jx = ox + x + (hash2(cx + x, cz + z) - 0.5) * step * 0.7;
          const jz = oz + z + (hash2(cz + z, cx + x) - 0.5) * step * 0.7;
          if (getBiome(jx, jz, this.seed) !== Biome.FOREST) continue;
          if (isWaterCell(jx, jz, this.seed)) continue;
          const soil = getSoilType(jx, jz, this.seed);
          if (soil === "clay" || soil === "sand" || soil === "rock") continue;
          const dens = forestDensity(jx, jz, this.seed);
          if (dens < 0.38) continue;
          if (hash2(jx * 0.3, jz * 0.3 + this.seed) > 0.35 + dens * 0.45) continue;
          this._tryAddResource(ItemId.WOOD, jx, jz, nodes);
        }
      }
      return;
    }

    // Plains: rare lone trees only
    if (hash2(cx, cz + this.seed) > 0.55) return;
    const wx = ox + size * (0.2 + hash2(cx * 3, cz) * 0.6);
    const wz = oz + size * (0.2 + hash2(cz * 5, cx) * 0.6);
    if (getBiome(wx, wz, this.seed) !== Biome.PLAINS) return;
    if (isWaterCell(wx, wz, this.seed)) return;
    this._tryAddResource(ItemId.WOOD, wx, wz, nodes);
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
      const underwater = y < CONST.WATER_LEVEL;
      const soil = getSoilType(wx, wz, this.seed);
      const biome = underwater ? Biome.WATER : getBiome(wx, wz, this.seed);
      const elev = mountainElevation(wx, wz, this.seed);
      const t = THREE.MathUtils.clamp((y + CONST.TERRAIN_HEIGHT) / (CONST.TERRAIN_HEIGHT * 3.2), 0, 1);
      if (underwater) {
        colors.push(0.22, 0.28, 0.32);
      } else if (soil === "clay") {
        colors.push(0.78, 0.52, 0.32);
      } else if (biome === Biome.DESERT || soil === "sand") {
        const d = 0.72 + t * 0.12;
        colors.push(d, 0.58 + t * 0.1, 0.32 + t * 0.05);
      } else if (biome === Biome.MOUNTAIN || soil === "rock") {
        const g = 0.38 + elev * 0.12 + t * 0.2;
        colors.push(g * 0.95, g, g * 0.92);
      } else if (soil === "dirt") {
        colors.push(0.48, 0.34, 0.2);
      } else if (biome === Biome.FOREST) {
        colors.push(0.12 + t * 0.06, 0.36 + (1 - t) * 0.2, 0.14);
      } else {
        colors.push(0.25 + t * 0.15, 0.45 + (1 - t) * 0.25, 0.22);
      }
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    try {
      // UVs for grass tiling across chunk
      const uvs = [];
      for (let i = 0; i < pos.count; i++) {
        uvs.push(pos.getX(i) * 0.12, pos.getZ(i) * 0.12);
      }
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geo.computeTangents();
    } catch {
      /* ignore */
    }
    const mat = this.terrainMat.clone();
    mat.vertexColors = true;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(ox, 0, oz);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.userData.chunk = true;
    this.group.add(mesh);

    const nodes = [];
    const water = this._addWaterSurface(cx, cz);
    if (water) nodes.push(water);
    const soils = this._addSoilPatches(cx, cz);
    nodes.push(...soils);
    const fish = this._addFishInChunk(cx, cz);
    nodes.push(...fish);
    this._addTreesInChunk(cx, cz, nodes);

    // Skip (0,0) mixed loot — starters cover spawn; trees already added above
    if (!(cx === 0 && cz === 0)) {
      const count = 4 + ((hash2(cx + this.seed, cz) * 6) | 0);
      for (let i = 0; i < count; i++) {
        const lx = (hash2(cx, i * 3 + cz) - 0.5) * size * 0.85;
        const lz = (hash2(cz, i * 7 + cx) - 0.5) * size * 0.85;
        const wx = ox + lx;
        const wz = oz + lz;
        if (isWaterCell(wx, wz, this.seed)) continue;
        const biome = getBiome(wx, wz, this.seed);
        const roll = hash2(wx * 0.1, wz * 0.1 + this.seed);
        let id = ItemId.ORGANIC;
        if (biome === Biome.DESERT) {
          if (roll < 0.08) id = ItemId.WRECK_PART;
          else if (roll < 0.32) id = ItemId.STONE;
          else if (roll < 0.48) id = ItemId.SILICON;
          else if (roll < 0.6) id = ItemId.COPPER;
          else if (roll < 0.7) id = ItemId.IRON;
          else id = ItemId.ORGANIC;
        } else if (biome === Biome.MOUNTAIN) {
          if (roll < 0.06) id = ItemId.WRECK_PART;
          else if (roll < 0.38) id = ItemId.STONE;
          else if (roll < 0.55) id = ItemId.IRON;
          else if (roll < 0.68) id = ItemId.COPPER;
          else if (roll < 0.8) id = ItemId.SILICON;
          else id = ItemId.ORGANIC;
        } else if (biome === Biome.FOREST) {
          if (roll < 0.08) id = ItemId.WRECK_PART;
          else if (roll < 0.22) id = ItemId.WOOD;
          else if (roll < 0.36) id = ItemId.FOOD;
          else if (roll < 0.5) id = ItemId.SEEDS;
          else if (roll < 0.62) id = ItemId.ORGANIC;
          else if (roll < 0.74) id = ItemId.STONE;
          else id = ItemId.ORGANIC;
        } else {
          if (roll < 0.1) id = ItemId.WRECK_PART;
          else if (roll < 0.16) id = ItemId.WOOD;
          else if (roll < 0.3) id = ItemId.STONE;
          else if (roll < 0.4) id = ItemId.IRON;
          else if (roll < 0.48) id = ItemId.COPPER;
          else if (roll < 0.56) id = ItemId.SILICON;
          else if (roll < 0.7) id = ItemId.FOOD;
          else if (roll < 0.82) id = ItemId.SEEDS;
          else id = ItemId.ORGANIC;
        }
        this._tryAddResource(id, wx, wz, nodes);
      }
    }

    this.chunks.set(this.key(cx, cz), { mesh, nodes, water, soils, fish });
  }

  _disposeChunk(k, chunk) {
    this.group.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    chunk.mesh.material.dispose();
    if (chunk.water) {
      this.group.remove(chunk.water);
      chunk.water.geometry?.dispose();
      // Shared water material — do not dispose per chunk
      this.resources = this.resources.filter((r) => r !== chunk.water);
    }
    for (const s of chunk.soils || []) {
      this.group.remove(s);
      s.geometry?.dispose();
      // Shared soil materials
      this.resources = this.resources.filter((r) => r !== s);
    }
    for (const f of chunk.fish || []) {
      this.group.remove(f);
      this.resources = this.resources.filter((r) => r !== f);
    }
    for (const n of chunk.nodes) {
      if (
        n === chunk.water ||
        (chunk.soils || []).includes(n) ||
        (chunk.fish || []).includes(n)
      ) {
        continue;
      }
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
    const mesh = buildBuildingVisual(id);
    mesh.position.set(position.x, this.surfaceY(position.x, position.z), position.z);
    mesh.userData = { kind: "building", buildingId: id, ...extra };
    mesh.traverse((c) => {
      if (c.isMesh) {
        c.userData = mesh.userData;
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    this.group.add(mesh);
    this.buildings.push(mesh);
    if (id === BuildingId.HANGAR) this.hangars.push(mesh);
    return mesh;
  }

  addShip(position) {
    const ship = buildShipVisual();
    ship.position.copy(position);
    ship.position.y = this.surfaceY(position.x, position.z);
    ship.userData = { kind: "ship", ready: true };
    ship.traverse((c) => {
      if (c.isMesh || c.isLight) c.userData = ship.userData;
    });
    this.group.add(ship);
    this.ships.push(ship);
    return ship;
  }

  removeShip(ship) {
    if (!ship) return;
    this.group.remove(ship);
    this.ships = this.ships.filter((s) => s !== ship);
  }

  nearestShip(position, maxDist = 12) {
    let best = null;
    let bestD = maxDist;
    for (const s of this.ships) {
      const d = s.position.distanceTo(position);
      if (d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  updateDayNight(t, camera = null) {
    if (!this.sun) return;
    const a = t * 0.035;
    const elevation = 0.25 + Math.max(Math.sin(a), -0.15) * 0.7;
    const azimuth = a * 0.55 + 0.4;
    const dayFactor = THREE.MathUtils.clamp(Math.sin(a) * 0.5 + 0.55, 0.15, 1);

    if (this.sky) {
      setSunFromAngles(this.sky, null, elevation, azimuth);
      this.sky.material.uniforms.turbidity.value = THREE.MathUtils.lerp(6.5, 2.2, dayFactor);
      this.sky.material.uniforms.rayleigh.value = THREE.MathUtils.lerp(3.2, 1.4, dayFactor);
    }

    const dir = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - elevation, azimuth);
    const focus = camera
      ? new THREE.Vector3(camera.position.x, 0, camera.position.z)
      : new THREE.Vector3(0, 0, 0);
    this.sun.position.copy(focus).addScaledVector(dir, 85);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
    this.sun.intensity = 0.35 + dayFactor * 2.2;
    this.sun.color.setRGB(1, 0.92 + dayFactor * 0.06, 0.82 + dayFactor * 0.12);
    if (this.hemi) this.hemi.intensity = 0.25 + dayFactor * 0.45;
    if (this.fill) this.fill.intensity = 0.15 + (1 - dayFactor) * 0.35;
    if (this.ambient) this.ambient.intensity = 0.12 + dayFactor * 0.14;

    // Occasional env rebake (expensive) — keep soft reflections in sync with sun
    this._skyBakeTimer += 0.016;
    if (this.renderer && this.sky && this._skyBakeTimer > 4.5) {
      this._skyBakeTimer = 0;
      bakeSkyEnvironment(this.renderer, this.sky, this.scene, this._envCache);
    }

    if (this.waterUniforms) {
      this.waterUniforms.uTime.value = t;
      this.waterUniforms.uSunDir.value.copy(dir);
      if (camera) this.waterUniforms.uCamPos.value.copy(camera.position);
      const skyTint = dayFactor > 0.35 ? 0xb8e4ff : 0x3a5070;
      this.waterUniforms.uSky.value.set(skyTint);
      this.waterUniforms.uHorizon.value.set(dayFactor > 0.35 ? 0x7eb8e0 : 0x2a3850);
    }

    // Soft horizon fog matched to sky (skip if game set underwater density)
    if (this.scene.fog && this.scene.background?.isColor && this.scene.fog.density < 0.04) {
      const daySky = new THREE.Color().setHSL(0.58, 0.32, THREE.MathUtils.lerp(0.28, 0.7, dayFactor));
      const dusk = new THREE.Color(0xd47848);
      const night = new THREE.Color(0x070b14);
      let bg;
      if (elevation < 0.1) {
        bg = night.clone().lerp(dusk, THREE.MathUtils.clamp((elevation + 0.12) / 0.22, 0, 1));
      } else if (elevation < 0.32) {
        bg = dusk.clone().lerp(daySky, (elevation - 0.1) / 0.22);
      } else {
        bg = daySky;
      }
      this.scene.fog.color.copy(bg);
      this.scene.background.copy(bg);
      this.scene.fog.density = THREE.MathUtils.lerp(0.013, 0.0072, dayFactor);
    }
  }

  /**
   * Wander / flee AI for land animals + fish swimming in water.
   * @param {number} delta
   * @param {{x:number,z:number}|null} playerPos
   */
  updateAnimals(delta, playerPos = null) {
    for (const node of this.resources) {
      const u = node.userData;
      if (u?.isFish) {
        this._updateFish(node, delta, playerPos);
        continue;
      }
      if (!u?.isAnimal) continue;

      u.stateTimer -= delta;
      const px = playerPos?.x ?? node.position.x;
      const pz = playerPos?.z ?? node.position.z;
      const toPlayerX = node.position.x - px;
      const toPlayerZ = node.position.z - pz;
      const distPlayer = Math.hypot(toPlayerX, toPlayerZ);
      const fleeing = distPlayer < 9;

      if (fleeing) {
        u.walking = true;
        const len = distPlayer || 1;
        u.targetX = node.position.x + (toPlayerX / len) * 8;
        u.targetZ = node.position.z + (toPlayerZ / len) * 8;
        u.speed = 2.8;
      } else if (u.stateTimer <= 0) {
        u.walking = Math.random() > 0.35;
        u.stateTimer = u.walking ? 2 + Math.random() * 3.5 : 1 + Math.random() * 2.5;
        u.speed = 1.1 + Math.random() * 0.8;
        if (u.walking) {
          const ang = Math.random() * Math.PI * 2;
          const rad = 2 + Math.random() * 7;
          let tx = u.homeX + Math.cos(ang) * rad;
          let tz = u.homeZ + Math.sin(ang) * rad;
          if (isWaterCell(tx, tz, this.seed)) {
            tx = u.homeX;
            tz = u.homeZ;
          }
          u.targetX = tx;
          u.targetZ = tz;
        }
      }

      let moving = false;
      if (u.walking) {
        const dx = u.targetX - node.position.x;
        const dz = u.targetZ - node.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.35) {
          u.walking = false;
          u.stateTimer = 0.8 + Math.random() * 1.5;
        } else {
          const nx = node.position.x + (dx / dist) * Math.min(dist, u.speed * delta);
          const nz = node.position.z + (dz / dist) * Math.min(dist, u.speed * delta);
          if (!isWaterCell(nx, nz, this.seed)) {
            moving = true;
            node.position.x = nx;
            node.position.z = nz;
            node.rotation.y = Math.atan2(dx, dz) - Math.PI / 2;
          } else {
            u.walking = false;
            u.stateTimer = 0.5;
          }
        }
      }

      node.position.y = getHeight(node.position.x, node.position.z, this.seed);

      if (moving) {
        u.walkPhase += delta * (fleeing ? 14 : 9);
        for (const leg of u.legs || []) {
          const phase = leg.userData.phase || 0;
          const swing = Math.sin(u.walkPhase + phase) * 0.55;
          leg.rotation.z = swing;
          leg.position.y =
            (leg.userData.baseY || 0.18) + Math.abs(Math.sin(u.walkPhase + phase)) * 0.04;
        }
        if (u.tail) u.tail.rotation.y = Math.sin(u.walkPhase * 0.8) * 0.35;
      } else {
        for (const leg of u.legs || []) {
          leg.rotation.z *= 0.85;
          leg.position.y = leg.userData.baseY || 0.18;
        }
        if (u.tail) u.tail.rotation.y *= 0.9;
      }
    }
  }

  _updateFish(node, delta, playerPos) {
    const u = node.userData;
    u.stateTimer -= delta;
    const px = playerPos?.x ?? node.position.x;
    const pz = playerPos?.z ?? node.position.z;
    const toPlayerX = node.position.x - px;
    const toPlayerZ = node.position.z - pz;
    const distPlayer = Math.hypot(toPlayerX, toPlayerZ);
    const fleeing = distPlayer < 7;

    if (fleeing) {
      u.walking = true;
      const len = distPlayer || 1;
      u.targetX = node.position.x + (toPlayerX / len) * 6;
      u.targetZ = node.position.z + (toPlayerZ / len) * 6;
      u.speed = 3.2;
    } else if (u.stateTimer <= 0) {
      u.walking = Math.random() > 0.2;
      u.stateTimer = u.walking ? 1.5 + Math.random() * 3 : 0.6 + Math.random() * 1.5;
      u.speed = 1.4 + Math.random() * 1.1;
      if (u.walking) {
        const ang = Math.random() * Math.PI * 2;
        const rad = 1.5 + Math.random() * 5;
        let tx = u.homeX + Math.cos(ang) * rad;
        let tz = u.homeZ + Math.sin(ang) * rad;
        if (!isWaterCell(tx, tz, this.seed)) {
          tx = u.homeX;
          tz = u.homeZ;
        }
        u.targetX = tx;
        u.targetZ = tz;
      }
    }

    let moving = false;
    if (u.walking) {
      const dx = u.targetX - node.position.x;
      const dz = u.targetZ - node.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.3) {
        u.walking = false;
        u.stateTimer = 0.5 + Math.random();
      } else {
        const nx = node.position.x + (dx / dist) * Math.min(dist, u.speed * delta);
        const nz = node.position.z + (dz / dist) * Math.min(dist, u.speed * delta);
        if (isWaterCell(nx, nz, this.seed)) {
          moving = true;
          node.position.x = nx;
          node.position.z = nz;
          node.rotation.y = Math.atan2(dx, dz);
        } else {
          u.walking = false;
          u.stateTimer = 0.4;
        }
      }
    }

    u.walkPhase += delta * (moving ? 10 : 3);
    node.position.y = CONST.WATER_LEVEL - 0.25 + Math.sin(u.walkPhase * 0.7) * 0.08;
    if (u.tail) u.tail.rotation.y = Math.sin(u.walkPhase) * (moving ? 0.55 : 0.2);
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
    if (this.sky) {
      this.scene.remove(this.sky);
      this.sky = null;
    }
    if (this._envCache?.envRT) {
      this._envCache.envRT.dispose();
      this._envCache.envRT = null;
    }
    if (this.scene.environment) this.scene.environment = null;
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
