/** Lightweight procedural WebAudio — no external assets. */
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.ambience = null;
    this.enabled = false;
  }

  init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(this.ctx.destination);
    this.enabled = true;
  }

  resume() {
    this.init();
    if (this.ctx?.state === "suspended") this.ctx.resume();
  }

  startAmbience() {
    this.resume();
    if (!this.enabled || this.ambience) return;

    const t = this.ctx.currentTime;
    const wind = this.ctx.createBufferSource();
    const buf = this._noiseBuffer(4);
    wind.buffer = buf;
    wind.loop = true;

    const windFilter = this.ctx.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 180;
    windFilter.Q.value = 0.4;

    const windGain = this.ctx.createGain();
    windGain.gain.value = 0.08;

    const lfo = this.ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.04;
    lfo.connect(lfoGain);
    lfoGain.connect(windGain.gain);

    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(this.master);
    wind.start(t);
    lfo.start(t);

    const hum = this.ctx.createOscillator();
    hum.type = "sine";
    hum.frequency.value = 42;
    const humGain = this.ctx.createGain();
    humGain.gain.value = 0.015;
    hum.connect(humGain);
    humGain.connect(this.master);
    hum.start(t);

    this.ambience = { wind, lfo, hum };
  }

  stopAmbience() {
    if (!this.ambience) return;
    for (const node of Object.values(this.ambience)) {
      try {
        node.stop?.();
        node.disconnect?.();
      } catch (_) {}
    }
    this.ambience = null;
  }

  playMineHit() {
    this.resume();
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.08);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  playMineBreak() {
    this.resume();
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = 220 + i * 80;
      const g = this.ctx.createGain();
      const start = t + i * 0.03;
      g.gain.setValueAtTime(0.12, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.1);
      osc.connect(g);
      g.connect(this.master);
      osc.start(start);
      osc.stop(start + 0.12);
    }
  }

  playFootstep() {
    this.resume();
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 55 + Math.random() * 20;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.04, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  _noiseBuffer(seconds) {
    const sampleRate = this.ctx.sampleRate;
    const len = sampleRate * seconds;
    const buf = this.ctx.createBuffer(1, len, sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }
}
