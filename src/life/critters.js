import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { patchMaterial, rand, pick, clamp } from '../fx/shaderPatch.js';
import { TANK } from '../world/tank.js';

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const GLASS = { front: TANK.D / 2 - 0.08, back: -TANK.D / 2 + 0.08, side: TANK.W / 2 - 0.08 };

/**
 * Draw a critter made of many small animated parts in a single call. The part meshes stay in
 * the scene graph, invisible, and act as bones (so the animation code below keeps moving them
 * as before); one rigidly skinned mesh with their geometry in one buffer renders them all.
 * Part colours (material colour or userData.tint x vertex colours) are baked into vertex colours.
 */
function skinParts(root, mat) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((o) => { if (o.isMesh) parts.push(o); });
  const extra = new Set();
  for (const m of parts) for (const k of Object.keys(m.geometry.attributes)) if (k.startsWith('a')) extra.add(k);
  const keep = ['position', 'normal', 'color', ...extra];
  if (parts.every((m) => m.geometry.attributes.uv)) keep.push('uv');   // textured models
  const geos = parts.map((m, i) => {
    let g = m.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
    if (!g.index) g = mergeVertices(g);   // shared vertices are skinned and shaded only once
    const n = g.attributes.position.count;
    const vc = g.attributes.color, tint = m.userData.tint;
    const c = tint ? new THREE.Color(...tint) : m.material.color || new THREE.Color(1, 1, 1);
    const col = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      col[k * 3] = (vc ? vc.getX(k) : 1) * c.r;
      col[k * 3 + 1] = (vc ? vc.getY(k) : 1) * c.g;
      col[k * 3 + 2] = (vc ? vc.getZ(k) : 1) * c.b;
      si[k * 4] = i;
      sw[k * 4] = 1;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    for (const k of extra) if (!g.attributes[k]) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    m.visible = false;   // still there for animation and picking, no longer drawn
    return g;
  });
  // bones are the part meshes themselves; bind matrices are identity, so the skinned mesh lives
  // in world space and its vertices are moved by the parts' world matrices
  const skin = new THREE.SkinnedMesh(mergeGeometries(geos), mat);
  skin.bind(new THREE.Skeleton(parts, parts.map(() => new THREE.Matrix4())), new THREE.Matrix4());
  skin.castShadow = true;
  // the skinned mesh sits at the world origin, so frustum culling uses a sphere that rides on
  // the critter itself: its centre IS root.position (the same vector), its radius covers the
  // model in any orientation with room for raised claws
  const s = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere());
  skin.boundingSphere = new THREE.Sphere(root.position, (s.center.distanceTo(root.position) + s.radius) * 1.3);
  return skin;
}

/** One physical material for a whole critter (colours come from the vertices). */
function critterMat(opts, caustics) {
  return patchMaterial(new THREE.MeshPhysicalMaterial({ vertexColors: true, ...opts }), { caustics });
}

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
  const bodyMat = new THREE.MeshPhysicalMaterial({ color, vertexColors: true });
  // the whole shrimp is drawn with one material; legs and claws move in its vertex shader
  const skinMat = critterMat({ roughness: 0.25, clearcoat: 1, sheen: 0.5, sheenColor: new THREE.Color('#fff') }, 0.6);
  const patched = skinMat.onBeforeCompile, key = skinMat.customProgramCacheKey();
  skinMat.onBeforeCompile = (sh, r) => {
    patched(sh, r);
    Object.assign(sh.uniforms, anim);
    sh.vertexShader = 'attribute vec3 aLeg; uniform float uWalk, uWalkAmp, uClaw, uClawAmp;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float sw = aLeg.z > 0.5 ? sin(uClaw + aLeg.x) * uClawAmp : sin(uWalk + aLeg.x) * uWalkAmp;
      transformed.z += sw * aLeg.y * 0.025;
      transformed.y += max(0.0, sw) * aLeg.y * 0.006 * (1.0 - aLeg.z);`);
  };
  skinMat.customProgramCacheKey = () => `${key}-shrimp`;
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
  return { group: g, anim, segs, tail, skinMat };
}

class Shrimp {
  constructor(eco, color, name, id) {
    this.eco = eco; this.kind = 'shrimp'; this.name = name; this.id = id;
    this.title = 'Креветка';
    this.model = shrimpModel(color);
    this.skinMat = this.model.skinMat;
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

// ============================================================ MODELS
// Crab and snails are modelled in Blender (tools/blender/make_critters.py): rigid parts with
// their origins at the joints, all sharing one baked texture set.
export const CRITTER_ASSETS = {};
const MODELS = ['crab', 'snail-mystery', 'snail-nerite', 'snail-ramshorn'];

export async function loadCritterAssets() {
  const loader = new GLTFLoader();
  await Promise.all(MODELS.map(async (id) => {
    try {
      const gltf = await loader.loadAsync(`models/critters/${id}.glb`);
      let src = null;
      gltf.scene.traverse((o) => { if (o.isMesh && !src) src = o.material; });
      if (src.map) src.map.anisotropy = 8;
      CRITTER_ASSETS[id] = { scene: gltf.scene, src, mats: {} };
    } catch (e) {
      console.warn('critter model missing:', id, e);
    }
  }));
}

/** The model's baked textures on a wet-looking physical material (one per model and look). */
function modelMat(id, opts, caustics) {
  const A = CRITTER_ASSETS[id], key = JSON.stringify(opts);
  if (!A.mats[key]) {
    const s = A.src;
    A.mats[key] = critterMat({ map: s.map, normalMap: s.normalMap, normalScale: s.normalScale, roughnessMap: s.roughnessMap, roughness: 1, metalness: 0, ...opts }, caustics);
  }
  return A.mats[key];
}

/** A fresh copy of a model's parts (geometry and textures are shared). */
function modelParts(id) {
  const scene = CRITTER_ASSETS[id].scene.clone(true);
  const parts = {};
  scene.traverse((o) => { if (o.name) parts[o.name] = o; });
  return { scene, parts };
}

/** A joint: rest pose plus rotations about axes given in the parent's frame. */
class Joint {
  constructor(obj) {
    this.obj = obj;
    this.rest = obj.quaternion.clone();
  }
  set(...pairs) {   // pairs of [axis, angle]
    const q = this.obj.quaternion.copy(this.rest);
    for (const [axis, ang] of pairs) if (ang) q.premultiply(_q.setFromAxisAngle(axis, ang));
  }
}

// ============================================================ SNAIL
const SNAIL = {
  mystery: { title: 'Ампулярия', scale: 1.35 },
  nerite: { title: 'Улитка-нерита', scale: 1.6 },
  ramshorn: { title: 'Катушка', scale: 1.5 },
};
// apple snails come in several colours; the tint is multiplied over the shell's texture
const SHELL_TINTS = [[1, 1, 1], [0.78, 0.6, 0.45], [1.04, 1.02, 0.9], [0.85, 0.95, 0.78]];

class Snail {
  constructor(eco, type, name, id) {
    this.eco = eco; this.kind = 'snail'; this.name = name; this.id = id; this.type = type;
    this.title = SNAIL[type].title;
    this.root = new THREE.Group();
    const inner = new THREE.Group();
    this.root.add(inner);
    const { scene, parts } = modelParts('snail-' + type);
    inner.add(scene);
    this.shell = parts.Shell;
    this.shellRest = this.shell.position.clone();
    if (type === 'mystery') this.shell.userData.tint = SHELL_TINTS[id % SHELL_TINTS.length];
    this.tents = [parts.TentL, parts.TentR].map((o) => new Joint(o));
    this.root.scale.setScalar(SNAIL[type].scale * rand(0.9, 1.1));
    this.skinMat = modelMat('snail-' + type, { clearcoat: 0.8, clearcoatRoughness: 0.15 }, 0.7);
    this.root.traverse((o) => { if (o.isMesh) o.userData.critter = this; });
    this.inner = inner;
    this.mode = 'ground';
    this.pos = new THREE.Vector3();
    this.heading = new THREE.Vector3(1, 0, 0);
    this.normal = new THREE.Vector3(0, 1, 0);
    this.ang = rand(0, 6.28);
    this.retract = 0;
    this.t = 0;
    this.crawl = 0;
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
    const speed = this.pause > 0 ? 0 : 0.035 * (1 - this.retract);
    this.animate(dt, speed);

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
  /** Tentacles feel about (and pull in when scared); the foot ripples and the shell sways as it glides. */
  animate(dt, speed) {
    const t = this.t;
    this.crawl += speed * dt * 60;
    this.tents.forEach((j, i) => {
      const s = i ? -1 : 1;
      j.set([X_AXIS, Math.sin(t * 1.3 + i * 1.7) * 0.18 - 0.05], [Z_AXIS, s * Math.sin(t * 0.9 + i) * 0.18]);
      j.obj.scale.set(1, 1 - this.retract * 0.85, 1);
    });
    const glide = Math.min(1, speed / 0.03);
    this.inner.scale.set(1, 1, 1 + Math.sin(this.crawl * 0.9) * 0.025 * glide);
    this.shell.rotation.set(Math.sin(t * 0.7) * 0.02 - this.retract * 0.12, 0, Math.sin(this.crawl * 0.45 + 1) * 0.04 * glide);
    this.shell.position.copy(this.shellRest).y -= this.retract * 0.006;
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

/** A walking leg: hip (swing and lift), knee and ankle, all hinged across the leg. */
class Leg {
  constructor(parts, side, i) {
    this.j = [0, 1, 2].map((k) => new Joint(parts[`Leg${side}${i}_${k}`]));
    const out = this.j[1].obj.position.clone().setY(0).normalize();   // horizontal direction of the leg
    this.hinge = new THREE.Vector3().crossVectors(out, Y_AXIS).normalize();   // + lifts the leg
    this.s = side === 'L' ? 1 : -1;
    // alternating tetrapod gait: L0 R1 L2 R3 step together, then the other four
    this.phase = ((i + (side === 'L' ? 0 : 1)) % 2) * Math.PI + i * 0.25;
  }
  pose(walk, amp, dir, rest) {
    const ph = walk + this.phase;
    const lift = Math.max(0, Math.sin(ph)) * amp;
    // reach: the tip moves along the walking direction while in the air and back on the ground
    const reach = Math.cos(ph) * amp * dir * this.s;
    this.j[0].set([this.hinge, 0.42 * lift - 0.1 * reach + rest * 0.05], [Y_AXIS, 0.1 * Math.sin(ph) * amp]);
    this.j[1].set([this.hinge, 0.28 * reach - 0.2 * lift - rest * 0.08]);
    this.j[2].set([this.hinge, 0.12 * reach + 0.15 * lift]);
  }
}

class Crab {
  constructor(eco, name, id) {
    this.eco = eco; this.kind = 'crab'; this.name = name; this.id = id;
    this.title = 'Крабик';
    this.root = new THREE.Group();
    const { scene, parts } = modelParts('crab');
    this.root.add(scene);
    this.body = scene.getObjectByName('Body');
    this.bodyY = this.body.position.y;
    this.legs = [];
    for (const side of ['L', 'R']) for (let i = 0; i < 4; i++) this.legs.push(new Leg(parts, side, i));
    this.claws = ['L', 'R'].map((side) => {
      const j = [0, 1, 2, 3].map((k) => new Joint(parts[`Claw${side}_${k}`]));
      // the movable finger opens about an axis across the palm
      const palmDir = j[3].obj.position.clone().normalize();
      return { j, s: side === 'L' ? 1 : -1, open: new THREE.Vector3().crossVectors(palmDir, Y_AXIS).normalize() };
    });
    this.eyes = [parts.EyeL, parts.EyeR].map((o) => new Joint(o));
    this.root.scale.setScalar(0.95);
    this.root.traverse((o) => { if (o.isMesh) o.userData.critter = this; });
    this.skinMat = modelMat('crab', { clearcoat: 0.9, clearcoatRoughness: 0.25 }, 0.6);
    this.pos = new THREE.Vector3(); this.facing = rand(0, 6.28); this.t = 0; this.goal = null; this.wave = 0; this.walk = 0;
    this.amp = 0; this.dir = 1; this.scared = 0; this.pick = 0; this.food = null;
  }
  init() { this.pos.copy(this.eco.randomSurfacePoint(true)); }
  scare(from) {
    _a.copy(this.pos).sub(from).setY(0).normalize();
    this.goal = this.eco.surfacePoint(this.pos.x + _a.x * 1.2, this.pos.z + _a.z * 1.2);
    this.fast = 2; this.idle = 0; this.scared = 1.5; this.food = null;
  }
  update(dt) {
    const eco = this.eco;
    this.t += dt;
    this.fast = Math.max(0, (this.fast || 0) - dt);
    this.scared = Math.max(0, this.scared - dt);
    // a flake on the ground nearby: go and pick at it with the claws
    if (!this.food && !this.fast && eco.food.length && Math.random() < dt * 0.5) {
      const f = eco.food.find((f) => !f.eaten && f.grounded && f.pos.distanceTo(this.pos) < 1.8);
      if (f) { this.food = f; this.goal = f.pos; this.idle = 0; }
    }
    if (this.food) {
      if (this.food.eaten) { this.food = null; this.goal = null; }
      else if (this.pos.distanceTo(this.food.pos) < 0.12) {
        eco.eatFood(this.food, this);
        this.food = null; this.goal = null; this.idle = rand(2, 3.5); this.pick = this.idle;
      }
    }
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
      let side = 1;
      if (Math.abs(dd) > Math.PI / 2) { dd -= Math.sign(dd) * Math.PI; side = -1; }
      this.facing += dd * Math.min(1, dt * 2);
      this.dir = side;   // walking toward the body's left (+1) or right (-1)
      const nx = this.pos.x + _a.x * speed * dt, nz = this.pos.z + _a.z * speed * dt;
      this.pos.set(nx, eco.surfaceAt(nx, nz), nz);
    }
    this.animate(dt, speed);
    this.root.position.copy(this.pos);
    orient(this.root, eco.surfaceNormal(this.pos.x, this.pos.z), _b.set(Math.sin(this.facing), 0, Math.cos(this.facing)), 1 - Math.exp(-5 * dt));
  }
  animate(dt, speed) {
    const t = this.t;
    this.amp += ((speed > 0.01 ? 1 : 0) - this.amp) * Math.min(1, dt * 6);
    this.walk += speed * dt * 95;
    const breathe = Math.sin(t * 1.4) * 0.5 + 0.5;
    for (const L of this.legs) L.pose(this.walk, this.amp, this.dir, breathe * (1 - this.amp));
    // the body bobs with the steps and crouches when frightened
    this.body.position.y = this.bodyY + Math.abs(Math.sin(this.walk)) * 0.004 * this.amp - this.scared * 0.008;
    this.wave = Math.max(0, this.wave - dt);
    this.pick = Math.max(0, this.pick - dt);
    this.claws.forEach((c, i) => {
      const [merus, carpus, palm, finger] = c.j;
      let raise = Math.sin(t * 1.2 + i) * 0.05, swing = 0, wrist = 0, open = 0.08 + Math.sin(t * 0.8 + i * 2) * 0.06;
      if (this.wave > 0) {
        // a threat display: claws up and open, snapping
        raise = -0.75 + Math.sin(t * 6 + i * 3) * 0.25;
        open = 0.45 + Math.sin(t * 9 + i) * 0.3;
      } else if (this.pick > 0) {
        // picking at the ground and bringing the morsel to the mouth, claws taking turns
        const k = Math.sin(t * 5 + i * Math.PI);
        raise = k > 0 ? -0.35 * k : 0.15 * -k;
        swing = c.s * 0.35 * Math.max(0, k);
        wrist = c.s * 0.3 * Math.max(0, k);
        open = k < 0 ? 0.4 * -k : 0.05;
      } else if (this.scared > 0) {
        raise = -0.3; open = 0.5;   // claws up in defence
      }
      merus.set([X_AXIS, raise], [Y_AXIS, swing - this.amp * c.s * 0.05]);
      carpus.set([Y_AXIS, wrist]);
      palm.set([X_AXIS, Math.sin(t * 0.7 + i) * 0.05]);
      finger.set([c.open, open]);
    });
    // eyes on stalks: look about, fold down when frightened
    this.eyes.forEach((e, i) => e.set([X_AXIS, this.scared > 0 ? 0.9 : Math.sin(t * 0.6 + i * 2) * 0.12], [Y_AXIS, Math.sin(t * 0.43 + i) * 0.2]));
  }
}

/**
 * An invisible low-poly ellipsoid around a modelled critter for the mouse to hit, instead of
 * testing its detailed parts on every pointer move.
 */
const PROXY = new THREE.SphereGeometry(1, 10, 8);
function pickProxy(c) {
  c.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(c.root.children[0]);
  const inv = new THREE.Matrix4().copy(c.root.matrixWorld).invert();
  box.applyMatrix4(inv);   // into the root's own frame
  const m = new THREE.Mesh(PROXY, new THREE.MeshBasicMaterial());
  m.visible = false;
  box.getCenter(m.position);
  box.getSize(m.scale).multiplyScalar(0.55);
  m.userData.critter = c;
  c.root.add(m);
  return m;
}

export function buildCritters(eco, scene) {
  const list = [];
  const shrimpCols = ['#ff2a2a', '#ff3b30', '#e8101e', '#ff5a36', '#2f7dff', '#ffd400', '#ff2a6a', '#c9d6d9'];
  const shrimpNames = ['Креветыч', 'Вишенка', 'Клешня', 'Усик', 'Малинка', 'Голубика', 'Лимончик', 'Призрачка'];
  shrimpCols.forEach((c, i) => list.push(new Shrimp(eco, c, shrimpNames[i], eco.nextId++)));
  const snails = [['mystery', 'Галя', true], ['nerite', 'Зебра', true], ['ramshorn', 'Завиток', false], ['nerite', 'Тихоход', false], ['mystery', 'Турбо', true], ['ramshorn', 'Колесо', false]];
  for (const [type, name, glass] of snails) {
    if (!CRITTER_ASSETS['snail-' + type]) continue;
    const s = new Snail(eco, type, name, eco.nextId++);
    s._glass = glass;
    list.push(s);
  }
  if (CRITTER_ASSETS.crab) list.push(new Crab(eco, 'Краб Валера', eco.nextId++));
  for (const c of list) {
    c.init(c._glass);
    scene.add(c.root);
    scene.add(c.skin = skinParts(c.root, c.skinMat));
    if (c.kind !== 'shrimp') c.pickMesh = pickProxy(c);
  }
  return list;
}
