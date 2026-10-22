import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial, rand, pick, clamp } from '../fx/shaderPatch.js';
import { TANK } from '../world/tank.js';

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const GLASS = { front: TANK.D / 2 - 0.08, back: -TANK.D / 2 + 0.08, side: TANK.W / 2 - 0.08 };

function orient(obj, up, fwd, k) {
  // build basis: y = up, z = forward projected on plane
  _a.copy(fwd).addScaledVector(up, -fwd.dot(up));
  if (_a.lengthSq() < 1e-6) _a.set(1, 0, 0).addScaledVector(up, -up.x);
  _a.normalize();
  _b.crossVectors(up, _a).normalize();
  _m.makeBasis(_b, up, _a);
  _q.setFromRotationMatrix(_m);
  obj.quaternion.slerp(_q, k);
}

// ============================================================ SHRIMP
function shrimpModel(color) {
  const g = new THREE.Group();
  const mat = patchMaterial(new THREE.MeshPhysicalMaterial({ color, roughness: 0.25, clearcoat: 1, sheen: 0.5, sheenColor: new THREE.Color('#fff') }), { caustics: 0.6 });
  const segs = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const r = 0.035 * (1 - t * 0.55);
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), mat);
    s.scale.set(0.9, 1, 1.5);
    s.castShadow = true;
    const piv = new THREE.Group();
    piv.add(s);
    segs.push(piv);
  }
  // chain the segments (curved spine)
  segs[0].position.set(0, 0.04, 0.03);
  g.add(segs[0]);
  for (let i = 1; i < n; i++) { segs[i].position.set(0, -0.004, -0.032 * (1 - i * 0.06)); segs[i].rotation.x = -0.18; segs[i - 1].add(segs[i]); }
  // head, rostrum, eyes, antennae, legs and claws: one mesh; legs walk in the vertex shader
  const parts = [];
  const add = (geo, m4, color = [1, 1, 1], leg = [0, 0, 0], legLen = 0) => {
    geo = geo.index ? geo.toNonIndexed() : geo;
    geo.deleteAttribute('uv');
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3), lg = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      col.set(color, k * 3);
      const w = legLen ? Math.min(1, -geo.attributes.position.getY(k) / legLen) : 0;
      lg.set([leg[0], w * leg[1], leg[2]], k * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aLeg', new THREE.BufferAttribute(lg, 3));
    geo.applyMatrix4(m4);
    parts.push(geo);
  };
  const M = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  add(new THREE.SphereGeometry(0.036, 14, 10), M(0, 0.045, 0.075, 0, 0, 0, 0.9, 0.95, 1.6));
  add(new THREE.ConeGeometry(0.007, 0.06, 6), M(0, 0.06, 0.13, Math.PI / 2 - 0.2));
  for (const s of [-1, 1]) {
    add(new THREE.SphereGeometry(0.009, 8, 6), M(s * 0.02, 0.06, 0.11), [0.02, 0.02, 0.02]);
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(s * 0.01, 0.05, 0.12), new THREE.Vector3(s * 0.06, 0.1, 0.22), new THREE.Vector3(s * 0.1, 0.08, 0.3), new THREE.Vector3(s * 0.12, 0.02, 0.32)]);
    add(new THREE.TubeGeometry(curve, 16, 0.0016, 4), new THREE.Matrix4());
  }
  const legGeo = () => new THREE.CylinderGeometry(0.002, 0.0015, 0.05, 4).translate(0, -0.025, 0);
  for (let i = 0; i < 5; i++) for (const s of [-1, 1]) {
    add(legGeo(), M(s * 0.02, 0.03, 0.09 - i * 0.017, 0, 0, s * 0.6), [1, 1, 1], [i * 1.1 + (s > 0 ? 0 : Math.PI), 1, 0], 0.05);
  }
  for (const s of [-1, 1]) add(legGeo(), M(s * 0.012, 0.03, 0.11, -0.8, 0, s * 0.2), [1, 1, 1], [s * 1.7, 1, 1], 0.05);
  const anim = { uWalk: { value: 0 }, uWalkAmp: { value: 0 }, uClaw: { value: 0 }, uClawAmp: { value: 0 } };
  const bodyMat = new THREE.MeshPhysicalMaterial({ color, vertexColors: true, roughness: 0.25, clearcoat: 1, sheen: 0.5, sheenColor: new THREE.Color('#fff') });
  bodyMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, anim);
    sh.vertexShader = 'attribute vec3 aLeg; uniform float uWalk, uWalkAmp, uClaw, uClawAmp;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float sw = aLeg.z > 0.5 ? sin(uClaw + aLeg.x) * uClawAmp : sin(uWalk + aLeg.x) * uWalkAmp;
      transformed.z += sw * aLeg.y * 0.025;
      transformed.y += max(0.0, sw) * aLeg.y * 0.006 * (1.0 - aLeg.z);`);
  };
  bodyMat.customProgramCacheKey = () => 'shrimp-body';
  const front = new THREE.Mesh(mergeGeometries(parts), bodyMat);
  front.castShadow = true;
  g.add(front);
  // tail fan (one mesh), follows the last segment
  const fan = [];
  for (let k = -1; k <= 1; k++) {
    fan.push(new THREE.CircleGeometry(0.02, 8).applyMatrix4(M(k * 0.012, 0, -0.02, -Math.PI / 2 + 0.3, 0, k * 0.5, 0.6, 1.4, 1)));
  }
  const tail = new THREE.Mesh(mergeGeometries(fan), mat);
  tail.position.set(0, 0, -0.03);
  segs[n - 1].add(tail);
  return { group: g, anim, segs, tail };
}

class Shrimp {
  constructor(eco, color, name, id) {
    this.eco = eco; this.kind = 'shrimp'; this.name = name; this.id = id;
    this.title = 'Креветка';
    this.model = shrimpModel(color);
    this.root = new THREE.Group();
    this.root.add(this.model.group);
    this.root.scale.setScalar(rand(0.85, 1.25));
    this.root.traverse((o) => { if (o.isMesh) o.userData.critter = this; });
    this.pos = new THREE.Vector3();
    this.heading = new THREE.Vector3(1, 0, 0);
    this.state = 'WANDER';
    this.t = 0; this.dur = 3;
    this.target = new THREE.Vector3();
    this.walk = 0;
    this.hop = null;
    this.p = { curiosity: Math.random(), shyness: Math.random() };
  }
  init() {
    const s = this.eco.randomSurfacePoint(true);
    this.pos.copy(s);
    this.pickTarget();
  }
  pickTarget(mode) {
    const eco = this.eco;
    if (mode === 'climb') {
      // highest point within a radius
      let best = null, bh = -1;
      for (let i = 0; i < 40; i++) {
        const p = eco.randomSurfacePoint(false, this.pos, 2.5);
        if (p.y > bh) { bh = p.y; best = p; }
      }
      this.target.copy(best);
    } else {
      this.target.copy(eco.randomSurfacePoint(false, this.pos, mode === 'far' ? 4 : 1.2));
    }
  }
  scare(from) {
    _a.copy(this.pos).sub(from).setY(0).normalize();
    const to = this.eco.surfacePoint(this.pos.x + _a.x * rand(0.6, 1.4), this.pos.z + _a.z * rand(0.4, 1.0));
    this.startHop(to, 0.5);
  }
  startHop(to, h = 0.4) {
    this.hop = { from: this.pos.clone(), to: to.clone(), t: 0, dur: 0.6 + this.pos.distanceTo(to) * 0.5, h };
    this.state = 'HOP';
  }
  update(dt) {
    const eco = this.eco;
    this.t += dt;
    if (this.state === 'HOP') {
      const H = this.hop;
      H.t += dt / H.dur;
      const k = Math.min(1, H.t);
      const s = k * k * (3 - 2 * k);
      _a.lerpVectors(H.from, H.to, s);
      _a.y += Math.sin(k * Math.PI) * (H.h + H.from.distanceTo(H.to) * 0.2);
      _b.copy(_a).sub(this.pos);
      if (_b.lengthSq() > 1e-8) this.heading.copy(_b).normalize();
      this.pos.copy(_a);
      this.root.position.copy(this.pos);
      orient(this.root, UP, this.heading, 1 - Math.exp(-8 * dt));
      // swimmerets flutter & tail flick
      this.model.tail.rotation.x = Math.sin(this.t * 30) * 0.4;
      for (const sg of this.model.segs) sg.rotation.x = -0.1 + Math.sin(this.t * 20) * 0.1;
      if (k >= 1) { this.state = 'WANDER'; this.pickTarget(); }
      return;
    }
    // food on the ground?
    if (this.state !== 'FOOD' && eco.food.length && Math.random() < dt * 0.6) {
      const f = eco.food.find((f) => !f.eaten && f.grounded && f.pos.distanceTo(this.pos) < 2.5);
      if (f) { this.state = 'FOOD'; this.food = f; this.t = 0; }
    }
    if (this.state === 'FOOD') {
      if (!this.food || this.food.eaten) { this.state = 'FORAGE'; this.t = 0; this.dur = rand(2, 5); }
      else { this.target.copy(this.food.pos); if (this.pos.distanceTo(this.food.pos) < 0.09) eco.eatFood(this.food, this); }
    }
    if (this.state === 'FORAGE') {
      // pick at the ground with claws
      this.model.anim.uClaw.value = this.t * 9;
      this.model.anim.uClawAmp.value = 1;
      this.model.group.rotation.x = 0.15 + Math.sin(this.t * 2) * 0.05;
      if (this.t > this.dur) this.next();
      this.place(dt, 0);
      return;
    }
    this.model.group.rotation.x *= 0.9;
    // walk toward target over the surface
    _a.copy(this.target).sub(this.pos); _a.y = 0;
    const d = _a.length();
    if (d < 0.05) { this.state === 'FOOD' ? null : this.next(); this.place(dt, 0); return; }
    _a.normalize();
    this.heading.lerp(_a, 1 - Math.exp(-4 * dt)).normalize();
    const sp = 0.16 * (this.state === 'FOOD' ? 1.6 : 1);
    const nx = this.pos.x + this.heading.x * sp * dt, nz = this.pos.z + this.heading.z * sp * dt;
    const ny = eco.surfaceAt(nx, nz);
    if (ny - this.pos.y > 0.25) { this.startHop(eco.surfacePoint(this.target.x, this.target.z), 0.3); return; }
    this.pos.set(nx, ny, nz);
    this.place(dt, sp);
  }
  next() {
    const r = Math.random();
    this.t = 0;
    if (r < 0.35) { this.state = 'FORAGE'; this.dur = rand(2, 7); }
    else if (r < 0.5) { this.state = 'WANDER'; this.pickTarget('climb'); if (Math.random() < 0.2) this.eco.story('shrimp-climb', `Креветка ${this.name} карабкается повыше`, this.target, { cooldown: 60, focus: this }); }
    else if (r < 0.58) { this.startHop(this.eco.randomSurfacePoint(false, this.pos, 3), 0.6); }
    else { this.state = 'WANDER'; this.pickTarget(Math.random() < 0.2 ? 'far' : null); }
  }
  place(dt, speed) {
    const eco = this.eco;
    this.walk += speed * dt * 60;
    const n = eco.surfaceNormal(this.pos.x, this.pos.z);
    this.root.position.copy(this.pos);
    orient(this.root, n, this.heading, 1 - Math.exp(-6 * dt));
    this.model.anim.uWalk.value = this.walk;
    this.model.anim.uWalkAmp.value = speed > 0 ? 1 : 0.1;
    if (this.state !== 'FORAGE') this.model.anim.uClawAmp.value *= 0.9;
    this.model.tail.rotation.x = Math.sin(eco.time * 1.5 + this.id) * 0.1;
  }
}

// ============================================================ SNAIL
function shellGeometry(type) {
  const turns = type === 'ramshorn' ? 3.2 : 3.6;
  const pts = [], radii = [];
  const N = 160;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = t * turns * Math.PI * 2;
    const r = 0.012 + t * (type === 'ramshorn' ? 0.06 : 0.05);
    const h = type === 'ramshorn' ? 0 : (1 - t) * 0.11;
    pts.push(new THREE.Vector3(Math.cos(a) * r, h, Math.sin(a) * r));
    radii.push(0.006 + t * (type === 'ramshorn' ? 0.035 : 0.045));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, N, 1, 14, false);
  const p = g.attributes.position;
  const cols = [];
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const seg = Math.floor(i / 15);
    const t = seg / N;
    const center = curve.getPointAt(Math.min(1, t));
    _a.fromBufferAttribute(p, i).sub(center);
    _a.multiplyScalar(radii[Math.min(N, seg)]);
    _a.add(center);
    p.setXYZ(i, _a.x, _a.y, _a.z);
    if (type === 'nerite') c.setHSL(0.1, 0.5, Math.sin(t * 90) > 0.2 ? 0.12 : 0.55);
    else if (type === 'ramshorn') c.setHSL(0.0, 0.75, 0.35 + t * 0.15);
    else c.setHSL(0.12, 0.85, 0.45 + Math.sin(t * 60) * 0.05).offsetHSL(0, 0, t * 0.1);
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeVertexNormals();
  return g;
}

class Snail {
  constructor(eco, type, name, id) {
    this.eco = eco; this.kind = 'snail'; this.name = name; this.id = id; this.type = type;
    this.title = { nerite: 'Улитка-нерита', ramshorn: 'Катушка', mystery: 'Ампулярия' }[type];
    this.root = new THREE.Group();
    const inner = new THREE.Group();
    this.root.add(inner);
    const shellMat = patchMaterial(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1 }), { caustics: 0.7 });
    const shell = new THREE.Mesh(shellGeometry(type), shellMat);
    shell.castShadow = true;
    if (type === 'ramshorn') { shell.rotation.x = Math.PI / 2; shell.position.set(0, 0.07, -0.02); }
    else { shell.rotation.x = -0.5; shell.position.set(0, 0.05, -0.02); shell.scale.setScalar(1.0); }
    inner.add(shell);
    const bodyMat = patchMaterial(new THREE.MeshPhysicalMaterial({ color: type === 'mystery' ? '#e9d7a8' : '#5b5248', roughness: 0.55, sheen: 1, sheenColor: new THREE.Color('#fff0d0') }), { caustics: 0.5 });
    const foot = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.12, 6, 12), bodyMat);
    foot.rotation.x = Math.PI / 2; foot.scale.set(1, 1, 0.45); foot.position.set(0, 0.016, 0.02);
    inner.add(foot);
    const head = new THREE.Group();
    head.position.set(0, 0.03, 0.1);
    inner.add(head);
    const tentGeo = new THREE.CylinderGeometry(0.003, 0.006, 0.07, 6); tentGeo.translate(0, 0.035, 0);
    this.tents = [];
    for (const s of [-1, 1]) {
      const t = new THREE.Mesh(tentGeo, bodyMat); t.position.set(s * 0.018, 0, 0); t.rotation.set(0.9, 0, s * 0.35); head.add(t);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.005, 6, 6), new THREE.MeshBasicMaterial({ color: '#111' })); eye.position.y = 0.07; t.add(eye);
      this.tents.push(t);
    }
    this.root.scale.setScalar(type === 'mystery' ? 1.6 : 1.1);
    this.root.traverse((o) => { if (o.isMesh) o.userData.critter = this; });
    this.inner = inner;
    this.mode = 'ground';
    this.pos = new THREE.Vector3();
    this.heading = new THREE.Vector3(1, 0, 0);
    this.normal = new THREE.Vector3(0, 1, 0);
    this.ang = rand(0, 6.28);
    this.retract = 0;
    this.t = 0;
    this.goal = null;
    this.reachedTop = false;
  }
  init(onGlass) {
    if (onGlass) {
      this.mode = 'glass';
      this.pane = pick(['back', 'front', 'left', 'right']);
      this.u = rand(-4, 4); this.v = rand(1.5, 4.5);
      this.ang = rand(0, 6.28);
    } else {
      this.pos.copy(this.eco.randomSurfacePoint(true));
    }
  }
  scare() { this.retract = 1; this.pause = rand(3, 6); }
  paneFrame() {
    // returns origin mapping (u,v) -> world and normal into the tank
    switch (this.pane) {
      case 'back': return { p: (u, v) => _a.set(u, v, GLASS.back), n: _b.set(0, 0, 1), umax: 5.6 };
      case 'front': return { p: (u, v) => _a.set(u, v, GLASS.front), n: _b.set(0, 0, -1), umax: 5.6 };
      case 'left': return { p: (u, v) => _a.set(-GLASS.side, v, u), n: _b.set(1, 0, 0), umax: 2.1 };
      default: return { p: (u, v) => _a.set(GLASS.side, v, u), n: _b.set(-1, 0, 0), umax: 2.1 };
    }
  }
  update(dt) {
    const eco = this.eco;
    this.t += dt;
    if (this.pause > 0) { this.pause -= dt; }
    else this.retract = Math.max(0, this.retract - dt * 0.6);
    for (const t of this.tents) t.scale.y = 1 - this.retract * 0.85;
    this.inner.position.y = Math.sin(this.t * 0.8) * 0.002;
    const speed = this.pause > 0 ? 0 : 0.035 * (1 - this.retract);
    // tentacles wave
    this.tents[0].rotation.z = -0.35 + Math.sin(this.t * 1.3) * 0.15;
    this.tents[1].rotation.z = 0.35 + Math.sin(this.t * 1.1 + 1) * 0.15;

    // food on ground nearby
    if (!this.food && eco.food.length && Math.random() < dt * 0.3) {
      const f = eco.food.find((f) => !f.eaten && f.grounded && f.pos.distanceTo(this.pos) < 1.2);
      if (f) { this.food = f; if (this.mode === 'ground' && Math.random() < 0.5) eco.story('snail-food', `Корм упал прямо перед улиткой ${this.name}!`, f.pos, { cooldown: 60, focus: this }); }
    }
    if (this.food && (this.food.eaten || this.mode !== 'ground')) this.food = null;

    if (this.mode === 'glass') {
      const F = this.paneFrame();
      this.ang += (Math.random() - 0.5) * dt * 0.8;
      if (this.goalTop) this.ang += (Math.PI / 2 - this.ang) * dt * 0.5;
      this.u += Math.cos(this.ang) * speed * dt;
      this.v += Math.sin(this.ang) * speed * dt;
      if (Math.abs(this.u) > F.umax) { this.u = Math.sign(this.u) * F.umax; this.ang = Math.PI - this.ang; }
      if (this.v > 5.5) {
        this.v = 5.5; this.ang = -Math.PI / 2 + rand(-0.6, 0.6);
        if (!this.reachedTop) { this.reachedTop = true; eco.story('snail-top', `Улитка ${this.name} добралась до самого верха стекла!`, this.pos, { cooldown: 120, focus: this, rare: true }); }
        this.goalTop = false;
      }
      const floor = eco.surfaceAt(F.p(this.u, 0).x, F.p(this.u, 0).z);
      if (this.v < floor + 0.02) {
        if (Math.random() < 0.5) { this.mode = 'ground'; this.pos.copy(F.p(this.u, floor)).addScaledVector(F.n, 0.12); this.pos.y = eco.surfaceAt(this.pos.x, this.pos.z); this.heading.copy(F.n); }
        else { this.v = floor + 0.03; this.ang = Math.PI / 2 + rand(-0.6, 0.6); }
      }
      if (this.v > 4.5) this.reachedTop = this.reachedTop && this.v > 4.0;
      const n = F.n.clone();
      F.p(this.u, this.v);
      this.pos.copy(_a).addScaledVector(n, 0.005);
      // forward direction on pane
      const tangU = this.pane === 'back' || this.pane === 'front' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const fwd = tangU.multiplyScalar(Math.cos(this.ang)).add(new THREE.Vector3(0, Math.sin(this.ang), 0));
      this.root.position.copy(this.pos);
      orient(this.root, n, fwd, 1 - Math.exp(-3 * dt));
      return;
    }
    // ground mode
    if (!this.goal || this.pos.distanceTo(this.goal) < 0.05 || this.food) {
      this.goal = this.food ? this.food.pos : eco.randomSurfacePoint(false, this.pos, 1.5);
    }
    if (this.food && this.pos.distanceTo(this.food.pos) < 0.08) { eco.eatFood(this.food, this); this.food = null; this.pause = rand(2, 4); }
    _a.copy(this.goal).sub(this.pos); _a.y = 0; _a.normalize();
    this.heading.lerp(_a, 1 - Math.exp(-1.5 * dt)).normalize();
    const nx = this.pos.x + this.heading.x * speed * dt, nz = this.pos.z + this.heading.z * speed * dt;
    this.pos.set(nx, eco.surfaceAt(nx, nz), nz);
    this.normal.lerp(eco.surfaceNormal(nx, nz), 1 - Math.exp(-3 * dt)).normalize();
    this.root.position.copy(this.pos);
    orient(this.root, this.normal, this.heading, 1 - Math.exp(-3 * dt));
    // reached a wall -> climb glass
    const nearWall = Math.abs(nx) > GLASS.side - 0.2 ? (nx > 0 ? 'right' : 'left') : (nz > GLASS.front - 0.2 ? 'front' : nz < GLASS.back + 0.2 ? 'back' : null);
    if (nearWall && Math.random() < dt * 0.5) this.toGlass(nearWall);
  }
  toGlass(pane) {
    this.mode = 'glass'; this.pane = pane;
    this.u = pane === 'back' || pane === 'front' ? this.pos.x : this.pos.z;
    this.v = this.pos.y + 0.05;
    this.ang = Math.PI / 2 + rand(-0.5, 0.5);
  }
  journey() {
    if (this.mode === 'ground') {
      this.goal = this.eco.randomSurfacePoint(false, this.pos, 5);
    } else this.goalTop = true;
  }
}

// ============================================================ CRAB
class Crab {
  constructor(eco, name, id) {
    this.eco = eco; this.kind = 'crab'; this.name = name; this.id = id;
    this.title = 'Крабик';
    const mat = patchMaterial(new THREE.MeshPhysicalMaterial({ color: '#ff6a3a', roughness: 0.35, clearcoat: 1 }), { caustics: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: '#111' });
    this.root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 14), mat); body.scale.set(1.3, 0.55, 1); body.position.y = 0.07; body.castShadow = true;
    this.root.add(body);
    this.legs = [];
    const lg = new THREE.CylinderGeometry(0.008, 0.006, 0.11, 6); lg.translate(0, -0.055, 0);
    for (const s of [-1, 1]) for (let i = 0; i < 4; i++) {
      const piv = new THREE.Group(); piv.position.set(s * 0.09, 0.07, 0.04 - i * 0.03);
      const l = new THREE.Mesh(lg, mat); l.rotation.z = s * 1.0; piv.add(l);
      this.root.add(piv); this.legs.push({ piv, s, i });
    }
    this.claws = [];
    for (const s of [-1, 1]) {
      const piv = new THREE.Group(); piv.position.set(s * 0.07, 0.08, 0.08);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.07, 6), mat); arm.rotation.x = Math.PI / 2; arm.position.z = 0.035; piv.add(arm);
      const claw = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), mat); claw.scale.set(0.8, 0.6, 1.3); claw.position.z = 0.08; piv.add(claw);
      this.root.add(piv); this.claws.push(piv);
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.05, 4), mat); st.position.set(s * 0.025, 0.12, 0.06); this.root.add(st);
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), dark); e.position.set(s * 0.025, 0.15, 0.06); this.root.add(e);
    }
    this.root.traverse((o) => { if (o.isMesh) o.userData.critter = this; });
    this.pos = new THREE.Vector3(); this.facing = rand(0, 6.28); this.t = 0; this.goal = null; this.wave = 0; this.walk = 0;
  }
  init() { this.pos.copy(this.eco.randomSurfacePoint(true)); }
  scare(from) { _a.copy(this.pos).sub(from).setY(0).normalize(); this.goal = this.eco.surfacePoint(this.pos.x + _a.x * 1.2, this.pos.z + _a.z * 1.2); this.fast = 2; }
  update(dt) {
    const eco = this.eco;
    this.t += dt;
    this.fast = Math.max(0, (this.fast || 0) - dt);
    if (this.idle > 0) { this.idle -= dt; }
    else if (!this.goal || this.pos.distanceTo(this.goal) < 0.05) {
      this.goal = eco.randomSurfacePoint(true, this.pos, 1.5);
      this.idle = Math.random() < 0.4 ? rand(1, 4) : 0;
      if (Math.random() < 0.15) this.wave = 2.5;
    }
    let speed = 0;
    if (!(this.idle > 0)) {
      _a.copy(this.goal).sub(this.pos); _a.y = 0;
      const d = _a.length(); _a.normalize();
      speed = (this.fast > 0 ? 0.45 : 0.14) * Math.min(1, d * 4);
      // crabs walk sideways: body faces perpendicular to motion
      const target = Math.atan2(_a.x, _a.z) + Math.PI / 2;
      let dd = target - this.facing; dd = Math.atan2(Math.sin(dd), Math.cos(dd));
      if (Math.abs(dd) > Math.PI / 2) dd -= Math.sign(dd) * Math.PI;
      this.facing += dd * Math.min(1, dt * 2);
      const nx = this.pos.x + _a.x * speed * dt, nz = this.pos.z + _a.z * speed * dt;
      this.pos.set(nx, eco.surfaceAt(nx, nz), nz);
    }
    this.walk += speed * dt * 120;
    for (const L of this.legs) L.piv.rotation.x = Math.sin(this.walk + L.i * 1.3 + (L.s > 0 ? 0 : Math.PI)) * (speed > 0 ? 0.35 : 0.02);
    this.wave = Math.max(0, this.wave - dt);
    this.claws.forEach((c, i) => { c.rotation.x = this.wave > 0 ? -0.8 + Math.sin(this.t * 8 + i * 3) * 0.6 : Math.sin(this.t * 1.2 + i) * 0.1; c.rotation.y = (i ? -1 : 1) * 0.3; });
    this.root.position.copy(this.pos);
    orient(this.root, eco.surfaceNormal(this.pos.x, this.pos.z), _b.set(Math.sin(this.facing), 0, Math.cos(this.facing)), 1 - Math.exp(-5 * dt));
  }
}

export function buildCritters(eco, scene) {
  const list = [];
  const shrimpCols = ['#ff2a2a', '#ff3b30', '#e8101e', '#ff5a36', '#2f7dff', '#ffd400', '#ff2a6a', '#c9d6d9'];
  const shrimpNames = ['Креветыч', 'Вишенка', 'Клешня', 'Усик', 'Малинка', 'Голубика', 'Лимончик', 'Призрачка'];
  shrimpCols.forEach((c, i) => list.push(new Shrimp(eco, c, shrimpNames[i], eco.nextId++)));
  const snails = [['mystery', 'Галя', true], ['nerite', 'Зебра', true], ['ramshorn', 'Завиток', false], ['nerite', 'Тихоход', false], ['mystery', 'Турбо', true], ['ramshorn', 'Колесо', false]];
  for (const [type, name, glass] of snails) { const s = new Snail(eco, type, name, eco.nextId++); s._glass = glass; list.push(s); }
  list.push(new Crab(eco, 'Краб Валера', eco.nextId++));
  for (const c of list) {
    c.init(c._glass);
    scene.add(c.root);
  }
  return list;
}
