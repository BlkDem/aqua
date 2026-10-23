import * as THREE from 'three';
import { patchMaterial, rand } from '../fx/shaderPatch.js';
import { sandHeight, TANK } from './tank.js';
import { decorNode } from './decorAssets.js';
import { DAY } from '../life/world.js';

// Plants grow over days (from half size towards full size), and some spread: now and then a
// clump sends out a runner and a young plant appears nearby. every: days between runners.
const SPREAD = {
  vallisneria: { title: 'Валлиснерия', every: [5, 9], cap: 14, dist: [0.45, 0.8] },
  crypt: { title: 'Криптокорина', every: [7, 12], cap: 9, dist: [0.35, 0.6] },
  sword: { title: 'Эхинодорус', every: [12, 20], cap: 6, dist: [0.7, 1.0] },
};
const VARIANTS = { vallisneria: 3, sword: 2, crypt: 2, limnophila: 2, cabomba: 2, ludwigia: 2, anubias: 2 };
const NODE = { vallisneria: 'SwayVallis', sword: 'SwaySword', crypt: 'SwayCrypt', limnophila: 'SwayLimno', cabomba: 'SwayCabomba', ludwigia: 'SwayLudwigia', anubias: 'SwayAnubias' };
const growth = (rec, t) => 0.5 + 0.5 * (1 - Math.exp(-Math.max(0, t - rec.planted) / (5 * DAY)));

// Every plant has its origin at the root and local y = height above it,
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

const UP = new THREE.Vector3(0, 1, 0);

function placeOnSand(obj, x, z) {
  obj.position.set(x, sandHeight(x, z) - 0.03, z);
  return obj;
}

/** decor: for its colliders (new plants do not sprout inside rocks); world: saved growth. */
export function buildPlants(scene, world, decor) {
  const group = new THREE.Group();
  scene.add(group);
  const out = { group, clumps: [], growing: [] };
  const saved = world.state.plants;
  const counter = {};

  const addClump = (name, x, z, radius) => out.clumps.push({ name, pos: new THREE.Vector3(x, sandHeight(x, z) + 0.6, z), radius });

  // Every plant model variant is drawn as one instanced mesh (a draw call per variant rather
  // than per clump). Each plant is a transform-only proxy object; sync() copies the proxies
  // into the instances after they move or grow.
  const batches = new Map();
  const batch = (model, node) => {
    if (!batches.has(node)) {
      const src = decorNode(model, node);
      const mesh = new THREE.InstancedMesh(src.geometry, src.material, 48);
      mesh.count = 0;
      mesh.castShadow = src.castShadow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      group.add(mesh);
      batches.set(node, { mesh, items: [] });
    }
    return batches.get(node);
  };
  out.sync = (only) => {
    for (const [node, b] of batches) {
      if (only && !node.includes(only)) continue;
      b.items.forEach((o, i) => { o.updateMatrix(); b.mesh.setMatrixAt(i, o.matrix); });
      b.mesh.count = b.items.length;
      b.mesh.instanceMatrix.needsUpdate = true;
    }
  };

  // Blender-made plants: origin at the root, swaying with the current.
  // Each placement remembers when it was planted, its variant, turn and vigour.
  const now = world.now();
  const place = (kind, id, x, z, scale, rec) => {
    const m = new THREE.Object3D();
    batch(kind, `${NODE[kind]}${rec.variant % VARIANTS[kind]}`).items.push(m);
    m.position.set(x, sandHeight(x, z) - 0.03, z);
    m.rotation.y = rec.rot;
    out.growing.push({ obj: m, kind, id, x, z, base: scale * rec.gene, rec });
    m.scale.setScalar(scale * rec.gene * growth(rec, now));
    return m;
  };
  const planted = (kind, x, z, scale = 1) => {
    counter[kind] = (counter[kind] || 0) + 1;
    const id = `${kind}-${counter[kind]}`;
    // the first plants were put in some days before the aquarium opened
    const rec = saved[id] ||= { planted: world.state.created - rand(3, 9) * DAY, gene: rand(0.85, 1.15), variant: Math.floor(rand(0, 9)), rot: rand(0, Math.PI * 2) };
    // the first runners come after the aquarium opened
    if (SPREAD[kind] && !rec.nextRunner) rec.nextRunner = Math.max(rec.planted, world.state.created) + rand(...SPREAD[kind].every) * DAY;
    return place(kind, id, x, z, scale, rec);
  };

  // ---------- Vallisneria forests along the back ----------
  for (const [cx, cz] of [[-5.3, -2.0], [-5.6, -0.6], [-2.6, -2.05], [-1.6, -1.9], [1.2, -2.15], [5.55, -2.15], [-0.4, -2.1], [3.5, -2.15]]) {
    planted('vallisneria', cx, cz);
    addClump('заросли валлиснерии', cx, cz + 0.3, 0.6);
  }

  // ---------- Amazon swords (rosettes) ----------
  for (const [cx, cz] of [[-2.95, 0.4], [-4.4, 0.45], [-0.5, 0.95], [5.0, 0.35]]) {
    planted('sword', cx, cz, 0.95);
    addClump('куст эхинодоруса', cx, cz, 0.7);
  }

  // ---------- Cryptocoryne in the foreground ----------
  for (const [cx, cz] of [[-3.5, 1.0], [2.6, 1.15], [-1.9, 1.35], [4.4, 1.6]]) {
    planted('crypt', cx, cz, 1.1);
    addClump('криптокорина', cx, cz, 0.4);
  }

  // ---------- Stem plants: red ludwigia and feathery limnophila / cabomba ----------
  for (const [cx, cz, kind] of [[-5.55, -1.75, 'ludwigia'], [-1.25, -2.15, 'limnophila'], [0.9, -1.0, 'ludwigia'], [-5.4, 0.9, 'limnophila']]) {
    planted(kind, cx, cz);
    addClump(kind === 'ludwigia' ? 'красные стебли' : 'лимнофила', cx, cz, 0.5);
  }
  for (const [cx, cz] of [[-3.3, -2.25], [2.7, -2.2], [-1.1, -1.4]]) {
    planted('cabomba', cx, cz);
    addClump('кабомба', cx, cz + 0.3, 0.5);
  }

  // ---------- Anubias tied to driftwood and stones (settled onto them in finishMoss) ----------
  out.onDecor = [];
  for (const [cx, cz] of [[-0.6, -1.3], [1.4, -1.45], [-3.0, 1.15], [3.0, 1.6]]) {
    out.onDecor.push({ obj: planted('anubias', cx, cz, 1.3), x: cx, z: cz });
  }
  // young plants that sprouted from runners earlier
  for (const e of world.state.extraPlants) place(e.kind, e.id, e.x, e.z, e.scale, e);

  /** Growth and spreading up to time t (also used to catch up after an absence). */
  out.tick = (t) => {
    let sprouted = 0;
    for (let i = 0; i < out.growing.length; i++) {   // new plants are appended and spread too
      const g = out.growing[i], S = SPREAD[g.kind];
      g.obj.scale.setScalar(g.base * growth(g.rec, t));
      if (!S) continue;
      g.rec.nextRunner ||= g.rec.planted + rand(...S.every) * DAY;
      while (g.rec.nextRunner <= t) {
        const at = g.rec.nextRunner;
        g.rec.nextRunner += rand(...S.every) * DAY;
        if (out.growing.filter((o) => o.kind === g.kind).length >= S.cap) break;
        const spot = freeSpot(g.x, g.z, S.dist);
        if (!spot) continue;
        const id = `${g.kind}-r${world.state.extraPlants.length + 1}`;
        const rec = { id, kind: g.kind, x: spot[0], z: spot[1], scale: g.base / g.rec.gene, planted: at, gene: rand(0.85, 1.15), variant: Math.floor(rand(0, 9)), rot: rand(0, Math.PI * 2) };
        world.state.extraPlants.push(rec);
        const m = place(g.kind, id, rec.x, rec.z, rec.scale, rec);
        m.scale.setScalar(rec.scale * rec.gene * growth(rec, t));
        world.log('plant', `${S.title} пустила новый побег — рядом вырос молодой куст`, at);
        sprouted++;
      }
    }
    out.sync();
    return sprouted;
  };
  // a free patch of sand near (x, z): inside the tank, clear of rocks and other plants
  const freeSpot = (x, z, [d0, d1]) => {
    for (let k = 0; k < 12; k++) {
      const a = rand(0, Math.PI * 2), d = rand(d0, d1);
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d * 0.7;
      if (Math.abs(px) > 5.5 || pz < -2.2 || pz > 2.0) continue;
      if (decor.colliders.some((c) => c.c.y - c.r < 0.7 && Math.hypot(c.c.x - px, c.c.z - pz) < c.r * 0.9 + 0.2)) continue;
      if (out.growing.some((o) => Math.hypot(o.x - px, o.z - pz) < 0.42)) continue;
      return [px, pz];
    }
    return null;
  };

  // ---------- Water lettuce floating on the surface ----------
  out.floaters = [];
  for (const [x, z] of [[-3.2, -0.6], [-1.0, 0.9], [1.9, -1.2], [3.6, 0.4], [-4.6, 1.0]]) {
    const i = Math.floor(rand(0, 3));
    const f = new THREE.Object3D();   // leaves and roots share the floater's transform
    batch('pistia', `SwayPistia${i}`).items.push(f);
    batch('pistia', `RootsPistia${i}`).items.push(f);
    f.position.set(x, TANK.waterY - 0.03, z);
    f.rotation.y = rand(0, Math.PI * 2);
    f.scale.setScalar(rand(0.9, 1.3));
    out.floaters.push({ obj: f, x, z, ph: rand(0, 6) });
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
    const tuft = decorNode('moss', 'MossTuft');
    const N = 2600;
    const inst = new THREE.InstancedMesh(tuft.geometry, tuft.material, N);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    const centers = [[-2.0, -0.9, 0.85, 1.05], [-3.9, -0.9, 0.9, 0.85], [0.4, -1.4, 0.6, 0.65], [-1.3, 0.05, 0.8, 1.05], [-5.3, 0.4, 0.45, 0.3], [3.0, -1.9, 0.5, 0.5]];
    const marimo = [[0.2, 1.85, 0.16], [-2.2, 1.95, 0.12], [4.0, 1.9, 0.14]];
    let k = 0;
    for (const [x, z, r] of marimo) {
      const y = sandHeight(x, z) + r * 0.85;
      for (let i = 0; i < 220; i++, k++) {
        const v = new THREE.Vector3().randomDirection();
        p.set(x, y, z).addScaledVector(v, r * rand(0.82, 0.92));
        // tufts stand out radially from the ball, each spun randomly about its own axis
        q.setFromUnitVectors(UP, v).multiply(new THREE.Quaternion().setFromAxisAngle(UP, rand(0, 6.28)));
        s.setScalar(rand(0.7, 1.2));
        m.compose(p, q, s); inst.setMatrixAt(k, m);
        col.setHSL(0.27 + rand(-0.02, 0.02), 0.35, rand(0.6, 0.9)); inst.setColorAt(k, col);
      }
    }
    out._mossPending = { inst, k, N, centers };
    group.add(inst);
    out.moss = inst;
  }

  // ---------- Corals (fluorescent at night: the baked colour doubles as emission) ----------
  {
    out.coralMats = [];
    const glowing = (obj, glow) => {
      obj.traverse((o) => {
        if (!o.isMesh || out.coralMats.includes(o.material)) return;
        o.material.emissive = new THREE.Color(glow);
        o.material.emissiveMap = o.material.map;
        o.material.emissiveIntensity = 0.05;
        out.coralMats.push(o.material);
      });
      return obj;
    };
    const corals = [[2.4, 0.1, 0, '#ff2f86'], [-5.2, -0.5, 1, '#8a3dff'], [0.1, -0.5, 2, '#ff5a1f'], [0.5, 1.2, 3, '#16c6ff']];
    for (const [x, z, k, glow] of corals) {
      const m = glowing(decorNode('corals', `Coral${k}`), glow);
      placeOnSand(m, x, z);
      m.rotation.y = rand(0, Math.PI * 2);
      group.add(m);
      addClump('коралл', x, z, 0.4);
    }
    const brain = glowing(decorNode('corals', 'Brain'), '#9dff3a');
    placeOnSand(brain, -0.2, 1.75);
    group.add(brain);
    // sea anemone (wavy tentacles, used by clownfish)
    const anem = new THREE.Group();
    anem.add(decorNode('corals', 'AnemoneBase'), decorNode('corals', 'SwayAnemone'));
    glowing(anem, '#ff63c8');
    placeOnSand(anem, 1.3, 0.75);
    group.add(anem);
    out.anemone = new THREE.Vector3(1.3, sandHeight(1.3, 0.75) + 0.35, 0.75);
    addClump('актиния', 1.3, 0.75, 0.35);
  }

  return out;
}

// Called once the ecosystem has built its surface height grid: moss settles on decor tops and
// epiphytes (anubias) sit on whatever they are tied to.
export function finishMoss(plants, eco) {
  for (const a of plants.onDecor) a.obj.position.y = eco.surfaceAt(a.x, a.z) - 0.04;
  plants.sync();
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
    p.set(x, y - 0.01, z);
    q.setFromUnitVectors(UP, n).multiply(new THREE.Quaternion().setFromAxisAngle(UP, rand(0, 6.28)));
    const sc = rand(0.7, 1.5);
    s.set(sc, sc * rand(0.6, 1.1), sc);
    m.compose(p, q, s); inst.setMatrixAt(k, m);
    col.setHSL(0.25 + rand(-0.03, 0.04), 0.35, rand(0.55, 0.95)); inst.setColorAt(k, col);
    k++;
  }
  inst.count = k;
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
}

export function updatePlants(plants, t, night) {
  for (const m of plants.coralMats) m.emissiveIntensity = 0.04 + night * 0.9;
  // floating plants drift slowly and bob with the ripples
  for (const f of plants.floaters) {
    f.obj.position.x = f.x + Math.sin(t * 0.05 + f.ph) * 0.35;
    f.obj.position.z = f.z + Math.cos(t * 0.04 + f.ph * 1.3) * 0.2;
    f.obj.position.y = TANK.waterY - 0.03 + Math.sin(t * 0.9 + f.ph) * 0.01;
    f.obj.rotation.y += 0.0004;
  }
  plants.sync('Pistia');
}
