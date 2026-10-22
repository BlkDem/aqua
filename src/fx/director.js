import * as THREE from 'three';
import { rand, pick, clamp } from './shaderPatch.js';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export const VIEWS = [
  { name: 'Фронт', pos: V(0, 3.3, 14.5), look: V(0, 2.6, 0) },
  { name: 'Сбоку', pos: V(11.5, 3.6, 6.5), look: V(0, 2.4, 0) },
  { name: 'Сверху', pos: V(0.5, 13, 7), look: V(0, 1.5, 0) },
  { name: 'У дна', pos: V(-3.5, 1.0, 2.0), look: V(1.5, 1.5, -1.5) },
  { name: 'Крупно', pos: V(-1.5, 2.2, 6.0), look: V(-1.5, 1.6, 0) },
];

export class Director {
  constructor(camera, controls, eco, post) {
    this.camera = camera;
    this.controls = controls;
    this.eco = eco;
    this.post = post;
    this.mode = 'free';
    this.view = 0;
    this.subject = null;
    this.shot = null;
    this.look = controls.target.clone();
    this.fly = null;
    this.fade = 0; this.fadeDir = 0;
    this.pendingFocus = null;
    this.letterbox = 0;
    this.dofOn = true;
    this.lastSubjectPos = V();
  }

  setMode(m) {
    this.mode = m;
    this.controls.enabled = m === 'free' || m === 'follow';
    if (m === 'cinematic' || m === 'observe') this.nextShot(true);
    if (m === 'free') { this.subject = null; this.shot = null; }
  }

  follow(subject) {
    this.subject = subject;
    this.mode = 'follow';
    this.controls.enabled = true;
    const p = subject.pos;
    const dir = this.camera.position.clone().sub(p).normalize();
    const dist = 1.6 + (subject.size || 0.2) * 3;
    this.flyTo(p.clone().addScaledVector(dir, dist).add(V(0, 0.2, 0)), p.clone(), 1.6);
    this.lastSubjectPos.copy(p);
  }

  unfollow() { if (this.mode === 'follow') { this.mode = 'free'; this.subject = null; } }

  flyTo(pos, look, dur = 2) {
    this.fly = { from: this.camera.position.clone(), to: pos.clone(), lf: this.controls.target.clone(), lt: look.clone(), t: 0, dur };
  }

  cycleView() {
    this.view = (this.view + 1) % VIEWS.length;
    const v = VIEWS[this.view];
    this.mode = 'free'; this.subject = null; this.controls.enabled = true;
    this.flyTo(v.pos, v.look, 2.2);
    return v.name;
  }

  onStory(s) {
    if ((this.mode === 'observe' || this.mode === 'cinematic') && s.focus && Math.random() < (s.rare ? 0.95 : 0.45)) {
      this.pendingFocus = s.focus;
    }
  }

  // --------------------------------------------------------------- shot library
  makeShot(kind) {
    const eco = this.eco;
    const cin = this.mode === 'cinematic';
    const dur = cin ? rand(6, 11) : rand(11, 20);
    const live = eco.fish.filter((f) => !f.hidden);
    switch (kind) {
      case 'wide': {
        const a0 = rand(-0.7, 0.7), da = rand(-0.25, 0.25), r = rand(11, 15), y = rand(2.5, 5.5);
        return { kind, dur, pos: (t) => V(Math.sin(a0 + da * t) * r, y + t * 0.3, Math.cos(a0 + da * t) * r * 0.9 + 1), look: () => V(0, 2.6, 0), focus: r };
      }
      case 'dolly': {
        const x0 = rand(-5, 0), x1 = x0 + rand(3, 6) * (Math.random() < 0.5 ? 1 : -1), y = rand(1.4, 3.5), z = rand(4.5, 7.5);
        return { kind, dur, pos: (t) => V(x0 + (x1 - x0) * t, y, z), look: (t) => V(x0 + (x1 - x0) * t * 1.1, y - 0.4, -0.5), focus: z + 0.5 };
      }
      case 'fish': {
        const f = this.pendingFocus && !this.pendingFocus.hidden ? this.pendingFocus : pick(live.filter((f) => f.size > 0.3) .concat(live));
        this.pendingFocus = null;
        const side = Math.random() < 0.5 ? -1 : 1;
        const d = (f.size || 0.15) * 3.5 + rand(0.8, 1.6);
        const up = rand(-0.1, 0.5);
        return {
          kind, dur, subject: f,
          pos: () => {
            const h = f.heading || V(1, 0, 0);
            const s = V().crossVectors(h, V(0, 1, 0)).normalize().multiplyScalar(side * d);
            const p = f.pos.clone().add(s).addScaledVector(h, d * 0.3).add(V(0, up, 0));
            if (p.z < 2.3) { p.x = clamp(p.x, -5.6, 5.6); p.y = clamp(p.y, 0.7, 5.3); p.z = Math.max(p.z, -2.1); }
            return p;
          },
          look: () => f.pos.clone(),
          track: true,
        };
      }
      case 'critter': {
        const c = this.pendingFocus && this.pendingFocus.kind !== 'fish' ? this.pendingFocus : pick(eco.critters);
        this.pendingFocus = null;
        const a = rand(0, Math.PI * 2);
        return {
          kind, dur, subject: c,
          pos: (t) => {
            const p = c.pos.clone().add(V(Math.sin(a + t * 0.4) * 0.8, 0.35, Math.cos(a + t * 0.4) * 0.8 + 0.4));
            p.x = clamp(p.x, -5.6, 5.6); p.z = clamp(p.z, -2.0, 4); p.y = Math.max(p.y, c.pos.y + 0.15);
            return p;
          },
          look: () => c.pos.clone().add(V(0, 0.05, 0)), track: true,
        };
      }
      case 'school': {
        const ids = Object.keys(eco.schools);
        const s = eco.schools[pick(ids)];
        const off = V(rand(-2, 2), rand(0, 1), rand(3, 5));
        return {
          kind, dur,
          pos: () => s.target.clone().add(off),
          look: () => s.target.clone(),
          track: true,
        };
      }
      case 'lowSand': {
        const x0 = rand(-5, 3), dx = rand(1.5, 2.5);
        return { kind, dur, pos: (t) => V(x0 + dx * t, 0.95, 1.85), look: (t) => V(x0 + dx * t + 1.5, 1.2, -1.5), focus: 2.5 };
      }
      case 'surface': {
        const x = rand(-4, 4);
        return { kind, dur, pos: (t) => V(x + t * 0.6, 1.2 + t * 0.3, 1.9), look: (t) => V(x + 1.2 + t, 5.6, -0.8), focus: 4 };
      }
      case 'decor': {
        const s = pick(eco.spots.filter((q) => q.kind !== 'open' && q.kind !== 'plants' || Math.random() < 0.3));
        const a = rand(-0.5, 0.5);
        return { kind, dur, pos: (t) => s.pos.clone().add(V(Math.sin(a) * (3.6 - t * 1.4), 0.4 + (1 - t) * 0.5, Math.cos(a) * (3.6 - t * 1.4))), look: () => s.pos.clone(), track: true };
      }
      case 'orbitFish': {
        const f = pick(live.filter((f) => f.size > 0.35));
        const a0 = rand(0, 6.28), r = f.size * 3 + 0.9;
        return {
          kind, dur, subject: f,
          pos: (t) => { const p = f.pos.clone().add(V(Math.sin(a0 + t * 1.2) * r, 0.25, Math.cos(a0 + t * 1.2) * r)); p.x = clamp(p.x, -5.6, 5.6); p.y = clamp(p.y, 0.8, 5.3); p.z = clamp(p.z, -2.1, 6); return p; },
          look: () => f.pos.clone(), track: true,
        };
      }
    }
  }

  nextShot(first = false) {
    const cin = this.mode === 'cinematic';
    let kind;
    if (this.pendingFocus) kind = this.pendingFocus.kind === 'fish' ? 'fish' : 'critter';
    else {
      const w = cin
        ? { wide: 1, dolly: 1.2, fish: 2.2, critter: 0.7, school: 1.2, lowSand: 0.9, surface: 0.6, decor: 1, orbitFish: 1.2 }
        : { wide: 2.2, dolly: 1.5, fish: 1.2, critter: 0.4, school: 1, lowSand: 0.5, surface: 0.4, decor: 0.8, orbitFish: 0.5 };
      if (first) kind = 'wide';
      else {
        let sum = 0; for (const k in w) sum += w[k];
        let r = Math.random() * sum;
        for (const k in w) { r -= w[k]; if (r <= 0) { kind = k; break; } }
      }
    }
    const shot = this.makeShot(kind || 'wide');
    shot.t = 0;
    const cut = first || (cin ? Math.random() < 0.65 : Math.random() < 0.25);
    this.shot = shot;
    if (cut) { this.fade = 1; this.fadeDir = -1; this.snap = true; }
    else this.snap = false;
  }

  update(dt) {
    const cam = this.camera, ctr = this.controls;
    // flight (presets, follow start)
    if (this.fly) {
      const f = this.fly;
      f.t += dt / f.dur;
      const k = ease(Math.min(1, f.t));
      if (this.mode === 'follow' && this.subject) f.lt.copy(this.subject.pos);
      cam.position.lerpVectors(f.from, f.to, k);
      ctr.target.lerpVectors(f.lf, f.lt, k);
      if (f.t >= 1) this.fly = null;
    }
    if (this.mode === 'follow' && this.subject && !this.fly) {
      const p = this.subject.pos;
      const delta = p.clone().sub(this.lastSubjectPos);
      cam.position.add(delta);
      ctr.target.lerp(p, 1 - Math.exp(-dt * 4));
      this.lastSubjectPos.copy(p);
    } else if (this.subject) this.lastSubjectPos.copy(this.subject.pos);

    let focusDist = cam.position.distanceTo(ctr.target);
    if (this.mode === 'cinematic' || this.mode === 'observe') {
      const s = this.shot;
      if (s) {
        s.t += dt;
        const u = Math.min(1, s.t / s.dur);
        const pos = s.pos(ease(u) * 0.6 + u * 0.4);
        const look = s.look(u);
        if (this.snap) { cam.position.copy(pos); this.look.copy(look); this.snap = false; }
        else {
          const k = 1 - Math.exp(-dt * (s.track ? 2.2 : 1.2));
          cam.position.lerp(pos, k);
          this.look.lerp(look, 1 - Math.exp(-dt * 3));
        }
        cam.lookAt(this.look);
        ctr.target.copy(this.look);
        focusDist = cam.position.distanceTo(this.look);
        if (s.t > s.dur - 0.35 && this.fadeDir === 0 && this.mode === 'cinematic') this.fadeDir = 1;
        if (s.t > s.dur || (this.pendingFocus && s.t > 3 && !s.subject)) { this.nextShot(); }
      }
      this.letterbox += ((this.mode === 'cinematic' ? 1 : 0) - this.letterbox) * Math.min(1, dt * 2);
    } else {
      this.letterbox += (0 - this.letterbox) * Math.min(1, dt * 3);
      ctr.update();
    }
    // fades
    if (this.fadeDir !== 0) {
      this.fade = clamp(this.fade + this.fadeDir * dt * 3, 0, 1);
      if (this.fade <= 0 || this.fade >= 1) this.fadeDir = this.fade >= 1 ? -1 : 0;
    }
    // DOF
    const p = this.post;
    const want = this.dofOn && (this.mode !== 'free');
    p.bokeh.enabled = want;
    p.bokeh.uniforms.focus.value += (focusDist - p.bokeh.uniforms.focus.value) * Math.min(1, dt * 4);
    const close = this.shot && this.shot.track && this.mode !== 'follow';
    p.bokeh.uniforms.aperture.value = this.mode === 'follow' ? 0.0012 : close ? (this.mode === 'cinematic' ? 0.0014 : 0.0009) : 0.00035;
    p.grade.uniforms.uLetter.value = this.letterbox;
    p.grade.uniforms.uFade.value = this.fade;
    const inside = Math.abs(cam.position.x) < 5.9 && Math.abs(cam.position.z) < 2.42 && cam.position.y < 5.6 && cam.position.y > 0;
    p.grade.uniforms.uUnder.value += ((inside ? 1 : 0) - p.grade.uniforms.uUnder.value) * Math.min(1, dt * 5);
  }
}
