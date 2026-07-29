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
  tex.anisotropy = opts.anisotropy ?? 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
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
  const size = 512;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.04, y * 0.04, 5);
      const n2 = fbm(x * 0.12 + 5, y * 0.11, 3);
      const dry = fbm(x * 0.02 + 30, y * 0.02, 2);
      let r = 28 + n * 35 + n2 * 12;
      let g = 72 + n * 70 + n2 * 25;
      let b = 22 + n * 28;
      if (dry > 0.62) {
        r += 28;
        g += 10;
        b -= 4;
      }
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  // Blade streaks
  ctx.globalAlpha = 0.35;
  for (let i = 0; i < 12000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const g = 90 + Math.random() * 90;
    ctx.strokeStyle = `rgba(${25 + Math.random() * 30},${g},${20 + Math.random() * 30},0.55)`;
    ctx.lineWidth = 0.6 + Math.random();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 3, y - 4 - Math.random() * 8);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.2;
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = `rgba(${60 + Math.random() * 40},${40 + Math.random() * 20},20,0.4)`;
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, 1 + Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return makeTextureFromCanvas(c, { repeat: 6 });
}

export function makeGrassNormalMap() {
  return makeNormalFromHeight((u, v) => {
    const blades = fbm(u * 40, v * 40, 4);
    const clumps = fbm(u * 12, v * 12, 3);
    return blades * 0.55 + clumps * 0.45;
  }, 512);
}

export function makeGrassRoughnessMap() {
  const size = 256;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.09, y * 0.09, 4);
      const v = 160 + n * 70;
      ctx.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return makeTextureFromCanvas(c, { repeat: 6, colorSpace: THREE.NoColorSpace });
}

export function makeDirtTexture() {
  const size = 512;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.035, y * 0.035, 5);
      const n2 = fbm(x * 0.11 + 20, y * 0.1, 3);
      const pebble = fbm(x * 0.22, y * 0.22, 2);
      let r = 78 + n * 55 + n2 * 18;
      let g = 52 + n * 38 + n2 * 10;
      let b = 28 + n * 22;
      if (pebble > 0.72) {
        r += 18;
        g += 12;
        b += 8;
      }
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  // Cracks / organic streaks
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < 90; i++) {
    ctx.strokeStyle = `rgb(${40 + Math.random() * 25},${28 + Math.random() * 15},${15 + Math.random() * 10})`;
    ctx.lineWidth = 0.6 + Math.random() * 1.8;
    ctx.beginPath();
    let sx = Math.random() * size;
    let sy = Math.random() * size;
    ctx.moveTo(sx, sy);
    for (let j = 0; j < 6; j++) {
      sx += (Math.random() - 0.5) * 28;
      sy += (Math.random() - 0.5) * 28;
      ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.12})`;
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, 0.5 + Math.random() * 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  return makeTextureFromCanvas(c, { repeat: 5 });
}

export function makeDirtNormalMap() {
  return makeNormalFromHeight((u, v) => {
    const n = fbm(u * 18, v * 18, 5);
    const n2 = fbm(u * 42 + 3, v * 40, 3);
    return n * 0.7 + n2 * 0.35;
  }, 512);
}

export function makeDirtRoughnessMap() {
  const size = 256;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.08, y * 0.08, 4);
      const v = 140 + n * 90;
      ctx.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return makeTextureFromCanvas(c, { repeat: 5, colorSpace: THREE.NoColorSpace });
}

export function makeRockTexture() {
  const size = 512;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.045, y * 0.045, 6);
      const n2 = fbm(x * 0.14 + 7, y * 0.13, 3);
      const vein = fbm(x * 0.08 + 20, y * 0.02, 2);
      let v = 95 + n * 75 + n2 * 20;
      let r = v;
      let g = v * 0.96;
      let b = v * 0.9;
      if (vein > 0.68) {
        r += 25;
        g += 18;
        b += 10;
      }
      if (n2 > 0.75) {
        r *= 0.82;
        g *= 0.82;
        b *= 0.85;
      }
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalAlpha = 0.3;
  for (let i = 0; i < 180; i++) {
    ctx.strokeStyle = Math.random() > 0.5 ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.35)";
    ctx.lineWidth = 0.5 + Math.random() * 1.5;
    ctx.beginPath();
    const sx = Math.random() * size;
    const sy = Math.random() * size;
    ctx.moveTo(sx, sy);
    for (let j = 0; j < 5; j++) {
      ctx.lineTo(sx + (Math.random() - 0.5) * 40, sy + (Math.random() - 0.5) * 40);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return makeTextureFromCanvas(c, { repeat: 4 });
}

export function makeRockNormalMap() {
  return makeNormalFromHeight((u, v) => {
    const n = fbm(u * 16, v * 16, 5);
    const cracks = fbm(u * 48, v * 48, 2);
    return n * 0.7 + (cracks > 0.7 ? 0.4 : 0) + fbm(u * 32, v * 32, 3) * 0.25;
  }, 512);
}

export function makeRockRoughnessMap() {
  const size = 256;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.08, y * 0.08, 4);
      const v = 130 + n * 100;
      ctx.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return makeTextureFromCanvas(c, { repeat: 4, colorSpace: THREE.NoColorSpace });
}

export function makeNormalFromHeight(drawFn, size = 256, repeat = 4) {
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
      const nx = (l - r) * 2.4;
      const ny = (u - d) * 2.4;
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
  return makeTextureFromCanvas(c, { repeat, colorSpace: THREE.NoColorSpace });
}

export function makeTerrainNormalMap() {
  return makeNormalFromHeight(
    (u, v) => fbm(u * 10, v * 10, 5) * 0.55 + fbm(u * 28, v * 28, 3) * 0.3 + fbm(u * 60, v * 60, 2) * 0.15,
    512,
    6
  );
}

export function makeBarkTexture() {
  const w = 256;
  const h = 512;
  const { c, ctx } = canvas(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ridge = fbm(x * 0.12, y * 0.015, 4);
      const pore = fbm(x * 0.35, y * 0.08, 2);
      let r = 62 + ridge * 45;
      let g = 38 + ridge * 28;
      let b = 22 + ridge * 16;
      if (pore > 0.7) {
        r *= 0.7;
        g *= 0.7;
        b *= 0.7;
      }
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  // Vertical furrows
  ctx.globalAlpha = 0.4;
  for (let x = 0; x < w; x += 5 + (Math.random() * 4) | 0) {
    ctx.strokeStyle = `rgba(${30 + Math.random() * 20},${18 + Math.random() * 12},8,0.7)`;
    ctx.lineWidth = 1 + Math.random() * 2.5;
    ctx.beginPath();
    ctx.moveTo(x + Math.random() * 2, 0);
    for (let y = 0; y < h; y += 16) {
      ctx.lineTo(x + Math.sin(y * 0.05) * 2, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(Math.random() * w, Math.random() * h, 1, 3 + Math.random() * 10);
  }
  ctx.globalAlpha = 1;
  return makeTextureFromCanvas(c, { repeat: 2 });
}

export function makeBarkNormalMap() {
  return makeNormalFromHeight((u, v) => {
    const ridges = Math.sin(u * Math.PI * 18) * 0.35 + fbm(u * 22, v * 6, 4) * 0.65;
    return 0.5 + ridges * 0.5;
  }, 512, 2);
}

export function makeLeafTexture() {
  const size = 512;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.05, y * 0.05, 5);
      const n2 = fbm(x * 0.15 + 4, y * 0.14, 3);
      let r = 22 + n * 40 + n2 * 15;
      let g = 68 + n * 85 + n2 * 30;
      let b = 24 + n * 35;
      if (n2 > 0.7) {
        r += 20;
        g += 35;
      }
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalAlpha = 0.45;
  for (let i = 0; i < 8000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.fillStyle = `rgba(${40 + Math.random() * 50},${100 + Math.random() * 100},${30 + Math.random() * 40},0.5)`;
    ctx.beginPath();
    ctx.ellipse(x, y, 1.5 + Math.random() * 5, 0.8 + Math.random() * 3, Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // Vein lines
  ctx.globalAlpha = 0.2;
  for (let i = 0; i < 60; i++) {
    ctx.strokeStyle = "rgba(20,60,25,0.6)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    const sx = Math.random() * size;
    const sy = Math.random() * size;
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(sx + 20, sy - 30, sx + (Math.random() - 0.5) * 40, sy - 50);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return makeTextureFromCanvas(c, { repeat: 2 });
}

export function makeLeafNormalMap() {
  return makeNormalFromHeight((u, v) => fbm(u * 28, v * 28, 4) * 0.7 + fbm(u * 60, v * 60, 2) * 0.3, 512, 2);
}

export function makeMetalTexture(tint = "#6a7580") {
  const size = 512;
  const { c, ctx } = canvas(size, size);
  // Parse tint roughly
  const base = new THREE.Color(tint);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.06, y * 0.06, 5);
      const brush = fbm(x * 0.2, y * 0.015, 3);
      const scratch = fbm(x * 0.4 + 10, y * 0.02, 2);
      const lum = 0.55 + n * 0.35 + brush * 0.12;
      let r = base.r * 255 * lum;
      let g = base.g * 255 * lum;
      let b = base.b * 255 * lum;
      if (scratch > 0.78) {
        r = Math.min(255, r + 40);
        g = Math.min(255, g + 40);
        b = Math.min(255, b + 45);
      }
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < 100; i++) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.4 + Math.random() * 0.8;
    ctx.beginPath();
    const sy = Math.random() * size;
    ctx.moveTo(0, sy);
    ctx.lineTo(size, sy + (Math.random() - 0.5) * 8);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.15;
  for (let i = 0; i < 50; i++) {
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(Math.random() * size, Math.random() * size);
    ctx.lineTo(Math.random() * size, Math.random() * size);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return makeTextureFromCanvas(c, { repeat: 3 });
}

export function makeMetalNormalMap() {
  return makeNormalFromHeight((u, v) => {
    const brush = Math.sin(v * Math.PI * 40) * 0.15 + fbm(u * 8, v * 50, 3) * 0.5;
    const dents = fbm(u * 30, v * 30, 2);
    return 0.5 + brush + (dents > 0.75 ? 0.2 : 0);
  }, 512, 3);
}

export function makeMetalRoughnessMap() {
  const size = 256;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.1, y * 0.1, 4);
      const v = 60 + n * 100;
      ctx.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return makeTextureFromCanvas(c, { repeat: 3, colorSpace: THREE.NoColorSpace });
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
  const size = 256;
  const { c, ctx } = canvas(size, size);
  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, emissiveHex);
  grd.addColorStop(0.45, baseHex);
  grd.addColorStop(1, "#0a0a12");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.08, y * 0.08, 3);
      if (n > 0.72) {
        ctx.fillStyle = `rgba(255,255,255,${((n - 0.72) * 1.2).toFixed(3)})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 120; i++) {
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(size / 2, size / 2);
    ctx.lineTo(Math.random() * size, Math.random() * size);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return makeTextureFromCanvas(c);
}

export function makeGrassBladeTexture() {
  const { c, ctx } = canvas(64, 128);
  ctx.clearRect(0, 0, 64, 128);
  const grd = ctx.createLinearGradient(32, 128, 32, 0);
  grd.addColorStop(0, "#1a3a18");
  grd.addColorStop(0.4, "#2f6a30");
  grd.addColorStop(0.75, "#5a9a48");
  grd.addColorStop(1, "#8cc868");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.moveTo(26, 128);
  ctx.quadraticCurveTo(18, 64, 28, 0);
  ctx.quadraticCurveTo(36, 64, 38, 128);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(32, 120);
  ctx.quadraticCurveTo(30, 60, 32, 8);
  ctx.stroke();
  return makeTextureFromCanvas(c);
}

export function makeClayTexture() {
  const size = 512;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.04, y * 0.04, 5);
      const n2 = fbm(x * 0.13 + 8, y * 0.12, 3);
      const wet = fbm(x * 0.02 + 40, y * 0.02, 2);
      let r = 168 + n * 42 + n2 * 15;
      let g = 108 + n * 28 + n2 * 10;
      let b = 62 + n * 18;
      // Slightly darker damp streaks near “wet” clay
      if (wet > 0.58) {
        r *= 0.88;
        g *= 0.9;
        b *= 0.95;
      }
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  // Dried mud plate cracks
  ctx.globalAlpha = 0.28;
  for (let i = 0; i < 70; i++) {
    const cx = Math.random() * size;
    const cy = Math.random() * size;
    ctx.strokeStyle = `rgb(${90 + Math.random() * 30},${55 + Math.random() * 20},${30 + Math.random() * 15})`;
    ctx.lineWidth = 0.8 + Math.random();
    for (let r = 0; r < 5; r++) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      const ang = Math.random() * Math.PI * 2;
      const len = 12 + Math.random() * 40;
      ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < 500; i++) {
    ctx.fillStyle = `rgba(${200 + Math.random() * 40},${140 + Math.random() * 30},${80},0.5)`;
    ctx.beginPath();
    ctx.ellipse(
      Math.random() * size,
      Math.random() * size,
      2 + Math.random() * 10,
      1 + Math.random() * 4,
      Math.random() * Math.PI,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return makeTextureFromCanvas(c, { repeat: 4 });
}

export function makeClayNormalMap() {
  return makeNormalFromHeight((u, v) => {
    const n = fbm(u * 14, v * 14, 5);
    const cracks = fbm(u * 55 + 9, v * 55, 2);
    return n * 0.55 + (cracks > 0.62 ? 0.35 : 0) + fbm(u * 30, v * 30, 3) * 0.25;
  }, 512);
}

export function makeClayRoughnessMap() {
  const size = 256;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.07, y * 0.07, 4);
      const wet = fbm(x * 0.03 + 10, y * 0.03, 2);
      // Wet clay = lower roughness (shinier)
      const v = 100 + n * 80 - wet * 50;
      ctx.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return makeTextureFromCanvas(c, { repeat: 4, colorSpace: THREE.NoColorSpace });
}

export function makeWaterNormalMap() {
  return makeNormalFromHeight((u, v) => {
    const w1 = Math.sin(u * Math.PI * 14) * Math.cos(v * Math.PI * 11) * 0.35;
    const w2 = fbm(u * 22, v * 22, 4) * 0.65;
    const w3 = fbm(u * 48 + 2, v * 45, 2) * 0.3;
    return 0.5 + w1 + w2 + w3;
  }, 512);
}

export function makeWaterTexture() {
  const size = 512;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.03, y * 0.035, 5);
      const n2 = fbm(x * 0.09 + 10, y * 0.08, 3);
      const r = 12 + n * 28 + n2 * 10;
      const g = 70 + n * 55 + n2 * 25;
      const b = 120 + n * 80 + n2 * 30;
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalAlpha = 0.28;
  for (let i = 0; i < 55; i++) {
    ctx.strokeStyle = "#e8f8ff";
    ctx.lineWidth = 0.8 + Math.random() * 1.4;
    ctx.beginPath();
    const sy = Math.random() * size;
    ctx.moveTo(0, sy);
    for (let x = 0; x < size; x += 12) {
      ctx.lineTo(x, sy + Math.sin(x * 0.05 + i) * 5 + Math.sin(x * 0.12 + i * 0.7) * 2);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.ellipse(
      Math.random() * size,
      Math.random() * size,
      20 + Math.random() * 40,
      4 + Math.random() * 8,
      Math.random() * Math.PI,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
  return makeTextureFromCanvas(c, { repeat: 3 });
}

export function makeFurTexture() {
  const size = 256;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.08, y * 0.08, 4);
      const r = 150 + n * 50;
      const g = 110 + n * 35;
      const b = 70 + n * 25;
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const shade = 120 + Math.random() * 80;
    ctx.strokeStyle = `rgba(${shade | 0},${(shade * 0.75) | 0},${(shade * 0.48) | 0},${0.35 + Math.random() * 0.35})`;
    ctx.lineWidth = 0.5 + Math.random() * 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 5, y - 4 - Math.random() * 8);
    ctx.stroke();
  }
  return makeTextureFromCanvas(c, { repeat: 3 });
}

export function makeFurNormalMap() {
  return makeNormalFromHeight((u, v) => fbm(u * 50, v * 20, 3) * 0.8 + fbm(u * 20, v * 40, 2) * 0.2, 256, 3);
}

export function makePlantTexture() {
  const size = 256;
  const { c, ctx } = canvas(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x * 0.06, y * 0.06, 4);
      const r = 30 + n * 40;
      const g = 90 + n * 80;
      const b = 35 + n * 35;
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  for (let i = 0; i < 200; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.fillStyle = `rgba(${50 + Math.random() * 60},${130 + Math.random() * 90},${40 + Math.random() * 50},0.65)`;
    ctx.beginPath();
    ctx.ellipse(x, y, 5 + Math.random() * 14, 2 + Math.random() * 7, Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  return makeTextureFromCanvas(c, { repeat: 2 });
}

export function makePlantNormalMap() {
  return makeNormalFromHeight((u, v) => fbm(u * 24, v * 24, 4), 256, 2);
}

export class TextureLibrary {
  constructor() {
    this.grass = makeGrassTexture();
    this.grassNormal = makeGrassNormalMap();
    this.grassRoughness = makeGrassRoughnessMap();
    this.dirt = makeDirtTexture();
    this.dirtNormal = makeDirtNormalMap();
    this.dirtRoughness = makeDirtRoughnessMap();
    this.rock = makeRockTexture();
    this.rockNormal = makeRockNormalMap();
    this.rockRoughness = makeRockRoughnessMap();
    this.terrainNormal = makeTerrainNormalMap();
    this.bark = makeBarkTexture();
    this.barkNormal = makeBarkNormalMap();
    this.leaf = makeLeafTexture();
    this.leafNormal = makeLeafNormalMap();
    this.clay = makeClayTexture();
    this.clayNormal = makeClayNormalMap();
    this.clayRoughness = makeClayRoughnessMap();
    this.water = makeWaterTexture();
    this.waterNormal = makeWaterNormalMap();
    this.fur = makeFurTexture();
    this.furNormal = makeFurNormalMap();
    this.plant = makePlantTexture();
    this.plantNormal = makePlantNormalMap();
    this.metal = makeMetalTexture();
    this.metalNormal = makeMetalNormalMap();
    this.metalRoughness = makeMetalRoughnessMap();
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
