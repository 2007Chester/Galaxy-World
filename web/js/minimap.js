import { CONST } from "./constants.js";
import { getHeight, isWaterCell } from "./world.js";

const CELL = 6;
const VIEW_RANGE = 72;
const REVEAL_RADIUS = 22;

function cellKey(cx, cz) {
  return `${cx},${cz}`;
}

function worldToCell(x, z) {
  return [Math.floor(x / CELL), Math.floor(z / CELL)];
}

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.explored = new Set();
    this.size = canvas.width;
    this.visible = true;
    this._lastReveal = "";
  }

  reset(exploredKeys = []) {
    this.explored = new Set(exploredKeys);
    this._lastReveal = "";
  }

  serialize() {
    return [...this.explored];
  }

  setVisible(on) {
    this.visible = on;
    this.canvas.parentElement?.classList.toggle("hidden", !on);
  }

  reveal(x, z) {
    const [pcx, pcz] = worldToCell(x, z);
    const r = Math.ceil(REVEAL_RADIUS / CELL);
    const tag = `${pcx},${pcz}`;
    // Always mark nearby; skip full loop only when standing still in same cell after first pass
    if (tag === this._lastReveal && this.explored.has(cellKey(pcx, pcz))) {
      // still expand a bit if somehow missing neighbors
    }
    this._lastReveal = tag;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r) continue;
        this.explored.add(cellKey(pcx + dx, pcz + dz));
      }
    }
  }

  /**
   * @param {{
   *   x:number,z:number,yaw:number,seed:number,
   *   buildings?:Array, ships?:Array, mode?:string
   * }} state
   */
  draw(state) {
    if (!this.visible || !this.ctx) return;
    const { ctx, canvas, size } = this;
    const { x, z, yaw, seed, buildings = [], ships = [], mode } = state;

    if (mode === "space") {
      this._drawSpace(yaw);
      return;
    }

    this.reveal(x, z);

    ctx.clearRect(0, 0, size, size);

    // Frame / bg
    ctx.fillStyle = "#050b12";
    ctx.fillRect(0, 0, size, size);

    const scale = size / (VIEW_RANGE * 2);
    const half = size / 2;

    // Explored terrain cells
    for (const key of this.explored) {
      const [cx, cz] = key.split(",").map(Number);
      const wx = (cx + 0.5) * CELL;
      const wz = (cz + 0.5) * CELL;
      const dx = wx - x;
      const dz = wz - z;
      if (Math.abs(dx) > VIEW_RANGE + CELL || Math.abs(dz) > VIEW_RANGE + CELL) continue;

      const h = getHeight(wx, wz, seed);
      if (h <  -1.2) {
        ctx.fillStyle = "rgb(40,110,170)";
      } else {
        const t = Math.max(0, Math.min(1, (h + 10) / 20));
        const g = 70 + Math.floor(t * 50);
        const b = 55 + Math.floor((1 - t) * 40);
        const r = 40 + Math.floor(t * 30);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      }

      const sx = half + dx * scale;
      const sy = half + dz * scale;
      const cs = CELL * scale + 0.6;
      ctx.fillRect(sx - cs / 2, sy - cs / 2, cs, cs);
    }

    // Fog overlay for unexplored in view (soft)
    const fog = ctx.createRadialGradient(half, half, size * 0.28, half, half, half);
    fog.addColorStop(0, "rgba(0,0,0,0)");
    fog.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, size, size);

    // Buildings
    for (const b of buildings) {
      const bx = b.position?.x ?? b.x;
      const bz = b.position?.z ?? b.z;
      if (!this._isExplored(bx, bz)) continue;
      const dx = bx - x;
      const dz = bz - z;
      if (Math.abs(dx) > VIEW_RANGE || Math.abs(dz) > VIEW_RANGE) continue;
      const id = b.userData?.buildingId ?? b.id;
      ctx.fillStyle = id === 5 ? "#c4a574" : id === 6 ? "#5eb8ff" : "#d0dde8";
      ctx.fillRect(half + dx * scale - 2, half + dz * scale - 2, 4, 4);
    }

    // Ships
    for (const s of ships) {
      const sx = s.position?.x ?? s.x;
      const sz = s.position?.z ?? s.z;
      if (!this._isExplored(sx, sz)) continue;
      const dx = sx - x;
      const dz = sz - z;
      if (Math.abs(dx) > VIEW_RANGE || Math.abs(dz) > VIEW_RANGE) continue;
      ctx.fillStyle = "#7ef0d4";
      ctx.beginPath();
      ctx.arc(half + dx * scale, half + dz * scale, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Player
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(-yaw);
    ctx.fillStyle = "#9ad7ff";
    ctx.strokeStyle = "#041018";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Crosshair center
    ctx.strokeStyle = "rgba(154, 215, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(half - 5, half);
    ctx.lineTo(half + 5, half);
    ctx.moveTo(half, half - 5);
    ctx.lineTo(half, half + 5);
    ctx.stroke();

    // Border ring drawn via CSS; coords label
    const label = document.getElementById("minimap-coords");
    if (label) {
      label.textContent = `${Math.round(x)}, ${Math.round(z)} · ${this.explored.size} зон`;
    }
  }

  _isExplored(x, z) {
    const [cx, cz] = worldToCell(x, z);
    return this.explored.has(cellKey(cx, cz));
  }

  _drawSpace(yaw) {
    const { ctx, size } = this;
    const half = size / 2;
    ctx.fillStyle = "#02050c";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    for (let i = 0; i < 40; i++) {
      const a = (i * 47 + yaw * 40) % size;
      const b = (i * 91) % size;
      ctx.fillRect(a, b, 1, 1);
    }
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(-yaw);
    ctx.fillStyle = "#7ef0d4";
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const label = document.getElementById("minimap-coords");
    if (label) label.textContent = "ORBIT · SPACE";
  }
}
