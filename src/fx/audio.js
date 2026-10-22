// Fully synthesized, relaxing soundscape — no audio files needed.
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21]; // major pentatonic
const CHORDS = [[0, 4, 7, 11], [-3, 0, 4, 7], [5, 9, 12, 16], [2, 5, 9, 12], [-5, -1, 2, 7]];
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class AquaAudio {
  constructor() {
    this.ctx = null;
    this.vol = { master: 0.7, music: 0.55, fx: 0.8 };
    this.night = 0;
    this.lastPop = 0;
  }
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain(); this.master.gain.value = 0;
    this.master.gain.linearRampToValueAtTime(this.vol.master, ctx.currentTime + 4);
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    this.musicBus = ctx.createGain(); this.musicBus.gain.value = this.vol.music;
    this.fxBus = ctx.createGain(); this.fxBus.gain.value = this.vol.fx;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(4.5, 2.2);
    const wet = ctx.createGain(); wet.gain.value = 0.55;
    this.reverb.connect(wet).connect(this.master);
    this.musicBus.connect(this.master); this.musicBus.connect(this.reverb);
    this.fxBus.connect(this.master);
    const fxWet = ctx.createGain(); fxWet.gain.value = 0.25; this.fxBus.connect(fxWet).connect(this.reverb);

    this.startWater();
    this.startFilterHum();
    this.scheduleBubbles();
    this.chordIdx = 0;
    this.nextChord = ctx.currentTime + 0.5;
    this.nextBell = ctx.currentTime + 3;
    this.timer = setInterval(() => this.tick(), 200);
  }
  impulse(sec, decay) {
    const ctx = this.ctx, len = ctx.sampleRate * sec;
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }
  noiseBuffer(sec, brown = true) {
    const ctx = this.ctx, len = ctx.sampleRate * sec;
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return b;
  }
  startWater() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(8); src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.4;
    const g = ctx.createGain(); g.gain.value = 0.32;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 160;
    lfo.connect(lfoG).connect(lp.frequency);
    src.connect(lp).connect(g).connect(this.fxBus);
    src.start(); lfo.start();
  }
  startFilterHum() {
    const ctx = this.ctx;
    // trickle at the filter outlet
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(6, false); src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.value = 0.018;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.31;
    const lg = ctx.createGain(); lg.gain.value = 0.008;
    lfo.connect(lg).connect(g.gain);
    const pan = ctx.createStereoPanner(); pan.pan.value = 0.6;
    src.connect(bp).connect(g).connect(pan).connect(this.fxBus);
    src.start(); lfo.start();
    // very soft motor hum
    for (const f of [55, 110]) {
      const o = ctx.createOscillator(); o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = f === 55 ? 0.012 : 0.004;
      o.connect(og).connect(pan); o.start();
    }
  }
  bubble(vol = 0.05, pan = Math.random() * 2 - 1, size = Math.random()) {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    const f0 = 380 + (1 - size) * 1400;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * (1.8 + Math.random()), t + 0.06 + size * 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09 + size * 0.06);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    o.connect(g).connect(p).connect(this.fxBus);
    o.start(t); o.stop(t + 0.2);
  }
  scheduleBubbles() {
    const loop = () => {
      if (!this.ctx) return;
      const n = Math.random() < 0.15 ? 3 + Math.floor(Math.random() * 4) : 1;
      for (let i = 0; i < n; i++) setTimeout(() => this.bubble(0.012 + Math.random() * 0.02, -0.6 + Math.random() * 0.4), i * (40 + Math.random() * 60));
      setTimeout(loop, 120 + Math.random() * 600);
    };
    loop();
  }
  pop(x = 0) {
    if (!this.ctx) return;
    const now = performance.now();
    if (now - this.lastPop < 90) return;
    this.lastPop = now;
    this.bubble(0.02 + Math.random() * 0.02, Math.max(-1, Math.min(1, x / 6)), Math.random() * 0.5);
  }
  pad(chord, t) {
    const ctx = this.ctx;
    const root = 57 - (this.night > 0.5 ? 5 : 0);
    const dur = 9;
    chord.forEach((n, i) => {
      for (const det of [-6, 5]) {
        const o = ctx.createOscillator(); o.type = i === 0 ? 'sine' : 'triangle';
        o.frequency.value = mtof(root + n + (i === 0 ? -12 : 0)); o.detune.value = det;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700 + (1 - this.night) * 600;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.022, t + 3);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 2);
        o.connect(lp).connect(g).connect(this.musicBus);
        o.start(t); o.stop(t + dur + 2.2);
      }
    });
  }
  bell(t) {
    const ctx = this.ctx;
    const note = 69 + SCALE[Math.floor(Math.random() * SCALE.length)] - (this.night > 0.5 ? 12 : 0);
    for (const [mul, vol] of [[1, 0.03], [2.01, 0.008], [3.0, 0.004]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = mtof(note) * mul;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5 / mul);
      const p = ctx.createStereoPanner(); p.pan.value = Math.random() * 1.4 - 0.7;
      o.connect(g).connect(p).connect(this.musicBus);
      o.start(t); o.stop(t + 4);
    }
  }
  tick() {
    const ctx = this.ctx; const t = ctx.currentTime;
    if (t > this.nextChord - 0.2) {
      this.chordIdx = (this.chordIdx + (Math.random() < 0.7 ? 1 : 2)) % CHORDS.length;
      this.pad(CHORDS[this.chordIdx], this.nextChord);
      this.nextChord += 8 + (this.night > 0.5 ? 2 : 0);
    }
    if (t > this.nextBell) {
      this.bell(t + 0.05);
      if (Math.random() < 0.35) this.bell(t + 0.35 + Math.random() * 0.3);
      this.nextBell = t + 2 + Math.random() * (this.night > 0.5 ? 7 : 5);
    }
  }
  tap() {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(0.1, false);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 3;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    src.connect(bp).connect(g).connect(this.fxBus); src.start(t);
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.12);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.25, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(og).connect(this.fxBus); o.start(t); o.stop(t + 0.2);
  }
  sprinkle() {
    if (!this.ctx) return;
    for (let i = 0; i < 10; i++) setTimeout(() => this.bubble(0.03, Math.random() * 2 - 1, 0.1 + Math.random() * 0.3), i * 70 + Math.random() * 60);
  }
  chime() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.bell(t); this.bell(t + 0.15); this.bell(t + 0.3);
  }
  setVolume(k, v) {
    this.vol[k] = v;
    if (!this.ctx) return;
    if (k === 'master') this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
    if (k === 'music') this.musicBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
    if (k === 'fx') this.fxBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }
}
