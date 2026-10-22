import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial, rand, mulberry32 } from '../fx/shaderPatch.js';
import { sandHeight } from './tank.js';

// Every plant is built from geometry whose local y = height above its root,
// so the sway shader can bend it naturally.

function colorize(geo, fn) {
  const p = geo.attributes.position;
  const cols = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    fn(c, p.getX(i), p.getY(i), p.getZ(i), i);
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return geo;
}

// Long ribbon blade (vallisneria) — curved and slightly twisted
function ribbon(h, w, lean, twist, hue) {
  const g = new THREE.PlaneGeometry(w, h, 1, 28);
  g.translate(0, h / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), t = y / h;
    let x = p.getX(i) * (1 - t * 0.55);
    const a = t * twist;
    const z = Math.sin(t * Math.PI * 0.5) * lean;
    p.setXYZ(i, x * Math.cos(a), y * (1 - t * 0.04), x * Math.sin(a) + z);
  }
  g.computeVertexNormals();
  return colorize(g, (c, x, y) => c.setHSL(hue + (y / h) * 0.04, 0.6, 0.18 + (y / h) * 0.3));
}

// Wide leaf (amazon sword) — elliptic, arched outward
function wideLeaf(len, wid, arch, hue, sat = 0.6) {
  const g = new THREE.PlaneGeometry(1, 1, 6, 16);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) + 0.5, v = p.getY(i) + 0.5; // u across, v along
    const halfW = Math.sin(Math.PI * Math.pow(v, 0.8)) * wid * 0.5 * (v < 0.15 ? v / 0.15 * 0.3 : 1);
    const x = (u - 0.5) * 2 * halfW;
    const ang = v * arch;
    const r = v * len;
    const y = Math.sin(ang + 0.2) * r * 0.9 + 0.02;
    const z = (1 - Math.cos(ang)) * r * 0.6 + v * len * 0.2;
    const fold = Math.abs(u - 0.5) * wid * 0.25; // midrib fold
    p.setXYZ(i, x, y + fold, z);
  }
  g.computeVertexNormals();
  return colorize(g, (c, x, y, z, i) => {
    const v = 1 - Math.floor(i / 7) / 16;
    const rib = Math.abs(x) < wid * 0.03 ? 0.08 : 0;
    c.setHSL(hue + v * 0.03, sat, 0.2 + v * 0.18 + rib);
  });
}

function placeOnSand(obj, x, z) {
  obj.position.set(x, sandHeight(x, z) - 0.03, z);
  return obj;
}

export function buildPlants(scene) {
  const group = new THREE.Group();
  scene.add(group);
  const out = { group, clumps: [] };

  const leafMat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }), { caustics: 0.8, sway: 0.55 });
  const leafMatSoft = patchMaterial(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.4, side: THREE.DoubleSide, sheen: 0.6, sheenColor: new THREE.Color('#bfffb0') }), { caustics: 0.8, sway: 0.25 });
  const stiffMat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }), { caustics: 0.9, sway: 0.12 });

  const addClump = (name, x, z, radius) => out.clumps.push({ name, pos: new THREE.Vector3(x, sandHeight(x, z) + 0.6, z), radius });

  // ---------- Vallisneria forests along the back ----------
  const valClumps = [[-5.3, -2.0], [-2.6, -2.05], [-1.6, -1.9], [2.1, -2.0], [1.2, -2.1], [5.3, -0.9], [-0.4, -2.1], [3.2, -2.15]];
  for (const [cx, cz] of valClumps) {
    const blades = [];
    const n = 9 + Math.floor(rand(0, 8));
    for (let i = 0; i < n; i++) {
      const h = rand(2.6, 4.8);
      const b = ribbon(h, rand(0.06, 0.1), rand(0.2, 0.9), rand(-1.5, 1.5), rand(0.26, 0.31));
      b.rotateY(rand(0, Math.PI * 2));
      b.translate(rand(-0.3, 0.3), 0, rand(-0.15, 0.15));
      blades.push(b);
    }
    const m = new THREE.Mesh(mergeGeometries(blades), leafMat);
    placeOnSand(m, cx, cz);
    m.castShadow = true;
    group.add(m);
    addClump('заросли валлиснерии', cx, cz + 0.3, 0.6);
  }

  // ---------- Amazon swords (rosettes) ----------
  const swords = [[-2.9, -0.6, 0.33], [2.85, -1.4, 0.29], [-0.5, 0.95, 0.31], [5.0, 0.35, 0.3]];
  for (const [cx, cz, hue] of swords) {
    const leaves = [];
    const n = 11 + Math.floor(rand(0, 6));
    for (let i = 0; i < n; i++) {
      const l = wideLeaf(rand(0.9, 1.7), rand(0.25, 0.42), rand(0.6, 1.4), hue + rand(-0.02, 0.02));
      l.rotateY((i / n) * Math.PI * 2 + rand(-0.2, 0.2));
      leaves.push(l);
    }
    const m = new THREE.Mesh(mergeGeometries(leaves), leafMatSoft);
    placeOnSand(m, cx, cz);
    m.castShadow = true; m.receiveShadow = true;
    m.scale.setScalar(rand(0.8, 1.1));
    group.add(m);
    addClump('куст эхинодоруса', cx, cz, 0.7);
  }

  // ---------- Red ludwigia / rotala stems (bushy columns of small leaves) ----------
  const stemGroups = [[-4.6, -1.3, 0.98], [4.3, -1.8, 0.02], [0.9, -1.0, 0.95], [-5.4, 0.9, 0.05]];
  for (const [cx, cz, hue] of stemGroups) {
    const parts = [];
    const stems = 7 + Math.floor(rand(0, 5));
    for (let s = 0; s < stems; s++) {
      const ox = rand(-0.3, 0.3), oz = rand(-0.25, 0.25);
      const h = rand(1.4, 2.8);
      const stem = new THREE.CylinderGeometry(0.012, 0.016, h, 5, 6);
      stem.translate(ox, h / 2, oz);
      parts.push(colorize(stem, (c) => c.setHSL(0.25, 0.4, 0.25)));
      const leafCount = Math.floor(h / 0.09);
      for (let k = 0; k < leafCount; k++) {
        const y = 0.1 + k * 0.09;
        const t = y / h;
        const lg = new THREE.PlaneGeometry(0.06, 0.16 * (1 - t * 0.4), 1, 2);
        lg.translate(0, 0.08, 0);
        lg.rotateX(-1.0 + t * 0.5);
        lg.rotateY(k * 2.4);
        lg.translate(ox, y, oz);
        const hh = hue + (t > 0.6 ? (hue > 0.5 ? 0.02 : 0.01) : 0);
        parts.push(colorize(lg, (c) => c.setHSL(t > 0.55 ? hh : 0.3, t > 0.55 ? 0.75 : 0.5, 0.22 + t * 0.25)));
      }
    }
    const m = new THREE.Mesh(mergeGeometries(parts), leafMat);
    placeOnSand(m, cx, cz);
    m.castShadow = true;
    group.add(m);
    addClump('красные стебли', cx, cz, 0.5);
  }

  // ---------- Cabomba-like feathery stems ----------
  const feathery = [[-3.6, -1.95], [3.9, -2.05], [-1.1, -1.4]];
  for (const [cx, cz] of feathery) {
    const parts = [];
    for (let s = 0; s < 6; s++) {
      const ox = rand(-0.25, 0.25), oz = rand(-0.2, 0.2);
      const h = rand(2.4, 3.8);
      for (let y = 0.15; y < h; y += 0.14) {
        const t = y / h;
        for (let k = 0; k < 6; k++) {
          const ng = new THREE.PlaneGeometry(0.012, 0.18 * (1 - t * 0.3), 1, 1);
          ng.translate(0, 0.09, 0);
          ng.rotateX(-1.25);
          ng.rotateY((k / 6) * Math.PI * 2 + y * 3);
          ng.translate(ox, y, oz);
          parts.push(colorize(ng, (c) => c.setHSL(0.3, 0.75, 0.32 + t * 0.2)));
        }
      }
    }
    const m = new THREE.Mesh(mergeGeometries(parts), leafMat);
    placeOnSand(m, cx, cz);
    group.add(m);
    addClump('перистые стебли', cx, cz + 0.3, 0.5);
  }

  // ---------- Java fern on driftwood / rocks (stiffer, dark) ----------
  const ferns = [[-0.6, -1.3, 0.55], [1.4, -1.45, 0.75], [-3.4, -0.15, 0.85], [3.2, -0.2, 1.0]];
  for (const [cx, cz, lift] of ferns) {
    const leaves = [];
    for (let i = 0; i < 9; i++) {
      const l = wideLeaf(rand(0.4, 0.7), rand(0.08, 0.13), rand(0.8, 1.6), 0.3, 0.5);
      l.rotateY(rand(0, Math.PI * 2));
      leaves.push(l);
    }
    const m = new THREE.Mesh(mergeGeometries(leaves), stiffMat);
    m.position.set(cx, sandHeight(cx, cz) + lift * 0.6, cz);
    group.add(m);
  }

  // ---------- Grass carpet (instanced) ----------
  {
    const blade = new THREE.PlaneGeometry(0.025, 0.22, 1, 4);
    blade.translate(0, 0.11, 0);
    const bp = blade.attributes.position;
    for (let i = 0; i < bp.count; i++) { const t = bp.getY(i) / 0.22; bp.setX(i, bp.getX(i) * (1 - t)); bp.setZ(i, t * t * 0.05); }
    blade.computeVertexNormals();
    colorize(blade, (c, x, y) => c.setHSL(0.28, 0.7, 0.18 + y * 1.4));
    const mat = patchMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }), { caustics: 0, sway: 1.6 });
    const N = 9000;
    const inst = new THREE.InstancedMesh(blade, mat, N);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const patches = [[-1.0, 1.6, 1.4, 0.5], [3.4, 1.7, 1.2, 0.45], [-4.0, 1.5, 1.1, 0.5], [0.6, 0.4, 0.9, 0.5], [-2.8, 0.9, 0.6, 0.4]];
    let k = 0;
    while (k < N) {
      const [px, pz, rx, rz] = patches[k % patches.length];
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random());
      const x = px + Math.cos(a) * r * rx, z = pz + Math.sin(a) * r * rz;
      if (Math.abs(x) > 5.8 || Math.abs(z) > 2.3) { k++; continue; }
      p.set(x, sandHeight(x, z) - 0.01, z);
      q.setFromEuler(new THREE.Euler(rand(-0.25, 0.25), rand(0, 6.28), rand(-0.25, 0.25)));
      const sc = rand(0.6, 1.4) * (1 - r * 0.4);
      s.set(sc, sc, sc);
      m.compose(p, q, s);
      inst.setMatrixAt(k, m);
      k++;
    }
    inst.receiveShadow = true;
    group.add(inst);
  }

  // ---------- Moss balls & moss carpets on rocks (instanced fuzzy) ----------
  {
    const blob = new THREE.IcosahedronGeometry(0.045, 0);
    const mat = patchMaterial(new THREE.MeshStandardMaterial({ roughness: 0.95 }), { caustics: 0.9, sway: 0.0 });
    const N = 2600;
    const inst = new THREE.InstancedMesh(blob, mat, N);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    const centers = [[-2.0, -0.9, 0.85, 1.05], [-3.9, -0.9, 0.9, 0.85], [0.4, -1.4, 0.6, 0.65], [-1.3, 0.05, 0.8, 1.05], [-5.3, 0.4, 0.45, 0.3], [3.0, -1.9, 0.5, 0.5]];
    const marimo = [[0.2, 1.85, 0.16], [-2.2, 1.95, 0.12], [4.0, 1.9, 0.14]];
    let k = 0;
    for (const [x, z, r] of marimo) {
      const y = sandHeight(x, z) + r * 0.85;
      for (let i = 0; i < 220; i++, k++) {
        const v = new THREE.Vector3().randomDirection().multiplyScalar(r * rand(0.88, 1.0));
        p.set(x + v.x, y + v.y, z + v.z);
        q.setFromEuler(new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)));
        s.setScalar(rand(0.8, 1.4));
        m.compose(p, q, s); inst.setMatrixAt(k, m);
        col.setHSL(0.27 + rand(-0.02, 0.02), 0.65, rand(0.16, 0.3)); inst.setColorAt(k, col);
      }
    }
    out._mossPending = { inst, k, N, centers };
    group.add(inst);
    out.moss = inst;
  }

  // ---------- Corals (stylized, fluorescent at night) ----------
  {
    const R = mulberry32(99);
    out.coralMats = [];
    const coralBranch = (parts, start, dir, len, rad, depth) => {
      const end = start.clone().addScaledVector(dir, len);
      const g = new THREE.CylinderGeometry(rad * 0.7, rad, len, 8, 1);
      g.translate(0, len / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
      g.translate(start.x, start.y, start.z);
      parts.push(g);
      const tip = new THREE.SphereGeometry(rad * 0.75, 8, 6);
      tip.translate(end.x, end.y, end.z);
      parts.push(tip);
      if (depth > 0) {
        for (let i = 0; i < 2 + (R() < 0.4 ? 1 : 0); i++) {
          const nd = dir.clone().add(new THREE.Vector3(R() - 0.5, R() * 0.5, R() - 0.5).multiplyScalar(1.1)).normalize();
          coralBranch(parts, end, nd, len * 0.75, rad * 0.75, depth - 1);
        }
      }
    };
    const corals = [[2.4, 0.1, '#ff6fa8', '#ff2f86'], [-5.2, -0.5, '#b07cff', '#8a3dff'], [0.1, -0.5, '#ff9a5a', '#ff5a1f'], [4.6, -0.6, '#6fe7ff', '#16c6ff']];
    for (const [x, z, color, glow] of corals) {
      const parts = [];
      for (let i = 0; i < 3; i++) coralBranch(parts, new THREE.Vector3(R() * 0.2 - 0.1, 0, R() * 0.2 - 0.1), new THREE.Vector3(R() - 0.5, 2, R() - 0.5).normalize(), 0.32, 0.055, 3);
      const mat = patchMaterial(new THREE.MeshPhysicalMaterial({ color, roughness: 0.45, clearcoat: 0.4, sheen: 1, sheenColor: new THREE.Color(color), emissive: new THREE.Color(glow), emissiveIntensity: 0.05 }), { caustics: 1, sway: 0.03 });
      out.coralMats.push(mat);
      const m = new THREE.Mesh(mergeGeometries(parts.map((g) => g.toNonIndexed())), mat);
      placeOnSand(m, x, z);
      m.castShadow = true;
      group.add(m);
      addClump('коралл', x, z, 0.4);
    }
    // brain coral
    const bg = new THREE.SphereGeometry(0.35, 64, 32, 0, Math.PI * 2, 0, Math.PI * 0.55);
    const bp = bg.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(bp, i);
      const n = v.clone().normalize();
      const ridge = Math.abs(Math.sin(n.x * 22 + Math.sin(n.z * 14) * 2) * Math.sin(n.z * 20 + Math.sin(n.x * 12) * 2));
      v.multiplyScalar(1 + ridge * 0.06);
      bp.setXYZ(i, v.x, v.y * 0.75, v.z);
    }
    bg.computeVertexNormals();
    const brainMat = patchMaterial(new THREE.MeshPhysicalMaterial({ color: '#c7e86b', roughness: 0.6, sheen: 1, sheenColor: new THREE.Color('#e8ff9a'), emissive: new THREE.Color('#9dff3a'), emissiveIntensity: 0.03 }), { caustics: 1 });
    out.coralMats.push(brainMat);
    const brain = new THREE.Mesh(bg, brainMat);
    placeOnSand(brain, -0.2, 1.75);
    brain.castShadow = true;
    group.add(brain);
    // sea anemone (wavy tentacles, used by clownfish)
    const tent = [];
    for (let i = 0; i < 60; i++) {
      const h = rand(0.35, 0.6);
      const g = new THREE.CylinderGeometry(0.012, 0.025, h, 6, 8);
      g.translate(0, h / 2, 0);
      const tip = new THREE.SphereGeometry(0.026, 8, 6); tip.translate(0, h, 0);
      const both = mergeGeometries([g.toNonIndexed(), tip.toNonIndexed()]);
      both.rotateZ(rand(-0.6, 0.6)); both.rotateY(rand(0, 6.28));
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.22;
      both.translate(Math.cos(a) * r, 0.08, Math.sin(a) * r);
      tent.push(colorize(both, (c, x, y) => c.setHSL(0.92 - y * 0.15, 0.75, 0.55 + y * 0.4)));
    }
    const base = new THREE.CylinderGeometry(0.28, 0.32, 0.14, 24); base.translate(0, 0.07, 0);
    tent.push(colorize(base.toNonIndexed(), (c) => c.setHSL(0.95, 0.4, 0.45)));
    const anemMat = patchMaterial(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.4, sheen: 1, sheenColor: new THREE.Color('#ffd2f0'), emissive: new THREE.Color('#ff63c8'), emissiveIntensity: 0.04 }), { caustics: 0.8, sway: 3.5 });
    out.coralMats.push(anemMat);
    const anem = new THREE.Mesh(mergeGeometries(tent), anemMat);
    placeOnSand(anem, 2.0, -0.1 + 1.0);
    anem.position.x = 1.3; anem.position.z = 0.75; anem.position.y = sandHeight(1.3, 0.75) - 0.03;
    group.add(anem);
    out.anemone = new THREE.Vector3(1.3, sandHeight(1.3, 0.75) + 0.35, 0.75);
    addClump('актиния', 1.3, 0.75, 0.35);
  }

  return out;
}

// Called once the ecosystem has built its surface height grid: moss settles on decor tops.
export function finishMoss(plants, eco) {
  const { inst, centers, N } = plants._mossPending;
  let k = plants._mossPending.k;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const col = new THREE.Color();
  let guard = 0;
  while (k < N && guard < 60000) {
    guard++;
    const [cx, cz, rx, rz] = centers[k % centers.length];
    const x = cx + rand(-rx, rx), z = cz + rand(-rz, rz);
    const y = eco.surfaceAt(x, z);
    if (y < sandHeight(x, z) + 0.06) continue;
    const e = 0.05;
    const n = new THREE.Vector3(eco.surfaceAt(x - e, z) - eco.surfaceAt(x + e, z), 2 * e, eco.surfaceAt(x, z - e) - eco.surfaceAt(x, z + e)).normalize();
    if (n.y < 0.5) continue;
    p.set(x, y + 0.005, z);
    q.setFromEuler(new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)));
    s.set(rand(0.8, 1.8), rand(0.4, 0.9), rand(0.8, 1.8));
    m.compose(p, q, s); inst.setMatrixAt(k, m);
    col.setHSL(0.25 + rand(-0.03, 0.04), 0.6, rand(0.14, 0.3)); inst.setColorAt(k, col);
    k++;
  }
  inst.count = k;
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
}

export function updatePlants(plants, t, night) {
  for (const m of plants.coralMats) m.emissiveIntensity = 0.04 + night * 0.9;
}
