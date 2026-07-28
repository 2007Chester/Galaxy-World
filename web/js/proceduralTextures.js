import * as THREE from "three";

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext("2d") };
}

function makeTextureFromCanvas(c, opts = {}) {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.colorSpace = opts.colorSpace ?? THREE.SRGBColorSpace;
  if (opts.repeat) tex.repeat.set(opts.repeat, opts.repeat);
  tex.anisotropy = 8;
  return tex;
}

function noise(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function fbm(x, y, oct = 4) {
  let v = 0;
  let a = 0.5;
  for (let i = 0; i < oct; i++) {
    v += noise(x * (1 << i), y * (1 << i)) * a;
    a *= 0.5;
  }
  return v;
}

export function makeGrassTexture() {
  const { c, ctx } = canvas(256, 256);
  ctx.fillStyle = "#2a5a32";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const g = 80 + Math.random() * 80;
    ctx.fillStyle = `rgb(${30 + Math.random() * 20},${g},${25 + Math.random() * 25})`;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 2 + Math.random() * 4);
  }
  for (let i = 0; i < 400; i++) {
    ctx.strokeStyle = `rgba(${40 + Math.random() * 30},${100 + Math.random() * 60},40,0.25)`;
    ctx.beginPath();
    ctx.moveTo(Math.random() * 256, Math.random() * 256);
    ctx.lineTo(Math.random() * 256, Math.random() * 256);
    ctx.stroke();
  }
  return makeTextureFromCanvas(c, { repeat: 8 });
}

export function makeDirtTexture() {
  const { c, ctx } = canvas(256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const n = fbm(x * 0.04, y * 0.04);
      const r = 90 + n * 50;
      const g = 65 + n * 35;
      const b = 40 + n * 25;
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  for (let i = 0; i < 800; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.15})`;
    ctx.beginPath();
    ctx.arc(Math.random() * 256, Math.random() * 256, Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  return makeTextureFromCanvas(c, { repeat: 8 });
}

export function makeRockTexture() {
  const { c, ctx } = canvas(256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const n = fbm(x * 0.06, y * 0.06, 5);
      const v = 110 + n * 70;
      ctx.fillStyle = `rgb(${v | 0},${(v * 0.95) | 0},${(v * 0.9) | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalAlpha = 0.35;
  for (let i = 0; i < 120; i++) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 0.5 + Math.random();
    ctx.beginPath();
    const sx = Math.random() * 256;
    const sy = Math.random() * 256;
    ctx.moveTo(sx, sy);
    for (let j = 0; j < 4; j++) {
      ctx.lineTo(sx + (Math.random() - 0.5) * 30, sy + (Math.random() - 0.5) * 30);
    }
    ctx.stroke();
  }
  return makeTextureFromCanvas(c, { repeat: 8 });
}

export function makeNormalFromHeight(drawFn, size = 256) {
  const { c, ctx } = canvas(size, size);
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      heights[y * size + x] = drawFn(x / size, y / size);
    }
  }
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = heights[y * size + Math.max(0, x - 1)];
      const r = heights[y * size + Math.min(size - 1, x + 1)];
      const u = heights[Math.max(0, y - 1) * size + x];
      const d = heights[Math.min(size - 1, y + 1) * size + x];
      const nx = (l - r) * 2;
      const ny = (u - d) * 2;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = makeTextureFromCanvas(c, { repeat: 8, colorSpace: THREE.NoColorSpace });
  return tex;
}

export function makeTerrainNormalMap() {
  return makeNormalFromHeight((u, v) => fbm(u * 8, v * 8) * 0.6 + fbm(u * 24, v * 24) * 0.2);
}

export function makeBarkTexture() {
  const { c, ctx } = canvas(128, 256);
  ctx.fillStyle = "#4a3020";
  ctx.fillRect(0, 0, 128, 256);
  for (let x = 0; x < 128; x += 6) {
    ctx.fillStyle = `rgba(${50 + Math.random() * 30},${30 + Math.random() * 20},15,0.5)`;
    ctx.fillRect(x + Math.random() * 2, 0, 2 + Math.random() * 3, 256);
  }
  for (let i = 0; i < 200; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.2})`;
    ctx.fillRect(Math.random() * 128, Math.random() * 256, 1, 4 + Math.random() * 8);
  }
  return makeTextureFromCanvas(c, { repeat: 1 });
}

export function makeLeafTexture() {
  const { c, ctx } = canvas(256, 256);
  ctx.fillStyle = "#1a4028";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    ctx.fillStyle = `rgba(${30 + Math.random() * 40},${80 + Math.random() * 80},${30 + Math.random() * 30},${0.3 + Math.random() * 0.5})`;
    ctx.beginPath();
    ctx.ellipse(x, y, 2 + Math.random() * 4, 1 + Math.random() * 3, Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  return makeTextureFromCanvas(c, { repeat: 1 });
}

export function makeMetalTexture(tint = "#6a7580") {
  const { c, ctx } = canvas(256, 256);
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const n = fbm(x * 0.08, y * 0.08);
      const v = 140 + n * 40;
      ctx.fillStyle = `rgb(${v | 0},${(v * 0.98) | 0},${(v * 0.95) | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < 60; i++) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(Math.random() * 256, Math.random() * 256);
    ctx.lineTo(Math.random() * 256, Math.random() * 256);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.15;
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = Math.random() > 0.5 ? "#000" : "#fff";
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1, 1);
  }
  return makeTextureFromCanvas(c, { repeat: 4 });
}

export function makePlanetTexture(seed = 1) {
  const { c, ctx } = canvas(512, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 512; x++) {
      const u = x / 512;
      const v = y / 256;
      const n = fbm(u * 6 + seed, v * 4 + seed * 0.7, 5);
      const n2 = fbm(u * 14 + seed * 2, v * 10, 3);
      const land = n > 0.42 ? 1 : 0;
      const r = land ? 60 + n2 * 80 : 20 + n * 40;
      const g = land ? 90 + n2 * 60 : 40 + n * 50;
      const b = land ? 120 + n2 * 40 : 100 + n * 60;
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.05 + Math.random() * 0.15})`;
    ctx.beginPath();
    ctx.arc(Math.random() * 512, Math.random() * 256, 2 + Math.random() * 8, 0, Math.PI * 2);
    ctx.fill();
  }
  return makeTextureFromCanvas(c);
}

export function makeAnomalyTexture() {
  const { c, ctx } = canvas(256, 256);
  const cx = 128;
  const cy = 128;
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy) / 128;
      const n = fbm(x * 0.05, y * 0.05, 4);
      const r = 80 + n * 120;
      const g = 40 + n * 80;
      const b = 200 + n * 55;
      const a = Math.max(0, 1 - d * 1.1);
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${(a * (0.6 + n * 0.4)).toFixed(3)})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return makeTextureFromCanvas(c);
}

export function makeRingTexture() {
  const { c, ctx } = canvas(512, 64);
  ctx.clearRect(0, 0, 512, 64);
  for (let x = 0; x < 512; x++) {
    for (let y = 0; y < 64; y++) {
      const band = fbm(x * 0.02, y * 0.1);
      const v = 180 + band * 60;
      const a = (0.15 + band * 0.55) * (1 - Math.abs(y - 32) / 32);
      ctx.fillStyle = `rgba(${v | 0},${(v * 0.95) | 0},${(v * 0.85) | 0},${a.toFixed(3)})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return makeTextureFromCanvas(c);
}

export function makeCrystalTexture(baseHex, emissiveHex) {
  const { c, ctx } = canvas(128, 128);
  const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, emissiveHex);
  grd.addColorStop(0.5, baseHex);
  grd.addColorStop(1, "#111");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 128, 128);
  ctx.globalAlpha = 0.4;
  for (let i = 0; i < 80; i++) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(64, 64);
    ctx.lineTo(Math.random() * 128, Math.random() * 128);
    ctx.stroke();
  }
  return makeTextureFromCanvas(c);
}

export function makeGrassBladeTexture() {
  const { c, ctx } = canvas(64, 64);
  ctx.clearRect(0, 0, 64, 64);
  const grd = ctx.createLinearGradient(32, 64, 32, 0);
  grd.addColorStop(0, "#1a4020");
  grd.addColorStop(0.5, "#3a8040");
  grd.addColorStop(1, "#6ab060");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.moveTo(28, 64);
  ctx.quadraticCurveTo(24, 32, 30, 0);
  ctx.quadraticCurveTo(34, 32, 36, 64);
  ctx.fill();
  return makeTextureFromCanvas(c);
}

export class TextureLibrary {
  constructor() {
    this.grass = makeGrassTexture();
    this.dirt = makeDirtTexture();
    this.rock = makeRockTexture();
    this.terrainNormal = makeTerrainNormalMap();
    this.bark = makeBarkTexture();
    this.leaf = makeLeafTexture();
    this.metal = makeMetalTexture();
    this.metalDark = makeMetalTexture("#3a4550");
    this.metalBlue = makeMetalTexture("#4a6080");
    this.planet = makePlanetTexture(3.7);
    this.anomaly = makeAnomalyTexture();
    this.ring = makeRingTexture();
    this.grassBlade = makeGrassBladeTexture();
    this.crystals = {
      stone: makeCrystalTexture("#707070", "#999999"),
      iron: makeCrystalTexture("#6a4030", "#aa6644"),
      copper: makeCrystalTexture("#aa5522", "#dd8833"),
      silicon: makeCrystalTexture("#2266aa", "#55bbee"),
      organic: makeCrystalTexture("#226633", "#44cc66"),
    };
  }

  dispose() {
    for (const key of Object.keys(this)) {
      const v = this[key];
      if (v?.dispose) v.dispose();
      else if (typeof v === "object") {
        for (const t of Object.values(v)) t?.dispose?.();
      }
    }
  }
}
