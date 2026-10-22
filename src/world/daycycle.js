import * as THREE from 'three';
import { G } from '../fx/shaderPatch.js';

const col = (h) => new THREE.Color(h);
export const PRESETS = {
  day: {
    sun: col('#fff1db'), sunI: 2.3, sky: col('#9fdcf0'), ground: col('#3a2e1c'), hemiI: 0.45,
    fog: col('#0f5f78'), fogD: 0.028, caustic: 0.85, causticCol: col('#fff6d8'), rays: 1.0, rayCol: col('#c8f7ff'),
    led: col('#ffffff'), ledI: 3.2, moon: 0, bgTop: col('#22b2c6'), bgDeep: col('#06415a'),
    roomTop: col('#1e2a3e'), roomBottom: col('#06080d'), roomGlow: col('#34507a'), exposure: 0.82, dust: 1.0, night: 0, fill: 0.35,
  },
  evening: {
    sun: col('#ffb27a'), sunI: 1.6, sky: col('#e0a888'), ground: col('#3a2030'), hemiI: 0.35,
    fog: col('#3b5a78'), fogD: 0.034, caustic: 0.65, causticCol: col('#ffcf9a'), rays: 0.8, rayCol: col('#ffd7a8'),
    led: col('#ffc08a'), ledI: 2.0, moon: 0.2, bgTop: col('#d07a5a'), bgDeep: col('#2a2348'),
    roomTop: col('#3a2a36'), roomBottom: col('#0a070b'), roomGlow: col('#a0584a'), exposure: 0.8, dust: 0.85, night: 0.3, fill: 0.25,
  },
  night: {
    sun: col('#7b95ff'), sunI: 0.35, sky: col('#2c4c9a'), ground: col('#05070f'), hemiI: 0.28,
    fog: col('#071d3a'), fogD: 0.042, caustic: 0.18, causticCol: col('#9db8ff'), rays: 0.22, rayCol: col('#9fb6ff'),
    led: col('#2a46ff'), ledI: 0.6, moon: 2.4, bgTop: col('#0e2d5c'), bgDeep: col('#020713'),
    roomTop: col('#090d1a'), roomBottom: col('#020306'), roomGlow: col('#1a2a55'), exposure: 0.85, dust: 0.5, night: 1, fill: 0.08,
  },
  morning: {
    sun: col('#ffd9c0'), sunI: 1.9, sky: col('#e8c8dc'), ground: col('#3a3040'), hemiI: 0.4,
    fog: col('#3a7a96'), fogD: 0.032, caustic: 0.8, causticCol: col('#fff0e0'), rays: 0.9, rayCol: col('#ffe4f0'),
    led: col('#ffe2d0'), ledI: 2.6, moon: 0.1, bgTop: col('#7fb8d0'), bgDeep: col('#1c3550'),
    roomTop: col('#2a2a3e'), roomBottom: col('#07070c'), roomGlow: col('#7a6a8a'), exposure: 0.82, dust: 0.9, night: 0.15, fill: 0.3,
  },
};

function lerpP(a, b, t, out) {
  for (const k of Object.keys(a)) {
    if (a[k] instanceof THREE.Color) (out[k] ||= new THREE.Color()).copy(a[k]).lerp(b[k], t);
    else out[k] = a[k] + (b[k] - a[k]) * t;
  }
  return out;
}

// auto cycle: [phase, preset]
const KEYS = [[0.0, 'morning'], [0.08, 'day'], [0.45, 'day'], [0.55, 'evening'], [0.63, 'night'], [0.92, 'night'], [1.0, 'morning']];

export class DayCycle {
  constructor(ctx) {
    this.ctx = ctx; // { sun, hemi, moon, fill, scene, tank, renderer, rays, dust, plants, decor }
    this.mode = 'auto';
    this.phase = 0.1;
    this.cycleMinutes = 8;
    this.cur = lerpP(PRESETS.day, PRESETS.day, 0, {});
    this.tmp = {};
    this.target = {};
  }
  setMode(m) { this.mode = m; }
  label() {
    if (this.mode !== 'auto') return { day: 'День', evening: 'Вечер', night: 'Ночь' }[this.mode];
    const p = this.phase;
    return p < 0.08 ? 'Утро' : p < 0.5 ? 'День' : p < 0.6 ? 'Вечер' : p < 0.95 ? 'Ночь' : 'Утро';
  }
  update(dt) {
    let goal;
    if (this.mode === 'auto') {
      this.phase = (this.phase + dt / (this.cycleMinutes * 60)) % 1;
      let i = 0;
      while (i < KEYS.length - 2 && this.phase > KEYS[i + 1][0]) i++;
      const [p0, a] = KEYS[i], [p1, b] = KEYS[i + 1];
      const t = (this.phase - p0) / Math.max(1e-5, p1 - p0);
      goal = lerpP(PRESETS[a], PRESETS[b], t * t * (3 - 2 * t), this.target);
    } else {
      goal = PRESETS[this.mode];
      // keep auto phase roughly in sync so returning to auto is smooth
      this.phase = { day: 0.25, evening: 0.55, night: 0.75 }[this.mode];
    }
    const k = 1 - Math.exp(-dt * 0.8);
    const c = lerpP(this.cur, goal, k, this.cur);
    const X = this.ctx;
    X.sun.color.copy(c.sun); X.sun.intensity = c.sunI;
    X.hemi.color.copy(c.sky); X.hemi.groundColor.copy(c.ground); X.hemi.intensity = c.hemiI;
    X.moon.intensity = c.moon * 40;
    X.fill.intensity = c.fill;
    X.scene.fog.color.copy(c.fog); X.scene.fog.density = c.fogD;
    G.uCaustic.value = c.caustic; G.uCausticColor.value.copy(c.causticCol);
    X.rays.mat.uniforms.uInt.value = c.rays; X.rays.mat.uniforms.uColor.value.copy(c.rayCol);
    X.dust.mat.uniforms.uRay.value = c.dust;
    X.tank.ledMat.emissive.copy(c.led); X.tank.ledMat.emissiveIntensity = c.ledI;
    X.tank.backdropMat.uniforms.uTop.value.copy(c.bgTop); X.tank.backdropMat.uniforms.uDeep.value.copy(c.bgDeep);
    X.tank.roomMat.uniforms.uTop.value.copy(c.roomTop); X.tank.roomMat.uniforms.uBottom.value.copy(c.roomBottom); X.tank.roomMat.uniforms.uGlow.value.copy(c.roomGlow);
    for (const m of X.tank.moonLeds) m.material.color.setRGB(0.2 + c.night * 0.3, 0.45 + c.night * 0.4, 1).multiplyScalar(0.3 + c.night * 2.5);
    X.renderer.toneMappingExposure = c.exposure * (X.exposureMul || 1);
    this.night = c.night;
    return c;
  }
}
