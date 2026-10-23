import * as THREE from 'three';
import { rand } from '../fx/shaderPatch.js';
import { sandHeight } from './tank.js';
import { decorModel, decorNode, partsOf } from './decorAssets.js';

export function buildDecor(scene, ctx) {
  const group = new THREE.Group();
  scene.add(group);
  const colliders = []; // {c: Vector3, r}
  const spots = [];     // named places: {name, pos, kind, radius}
  const walkables = [];
  const glowMats = [];  // emissive things that get brighter at night
  const interactive = []; // {mesh, onClick}
  const out = { group, colliders, spots, walkables, glowMats, interactive };

  const addCol = (x, y, z, r) => colliders.push({ c: new THREE.Vector3(x, y, z), r });
  const spot = (name, x, y, z, kind, radius = 0.6) => {
    const s = { name, pos: new THREE.Vector3(x, y, z), kind, radius };
    spots.push(s);
    return s;
  };

  const placeRock = (x, z, r, seed, squash = 0.7, sink = 0.25) => {
    const m = decorNode('rocks', `Rock${seed % 6}`);
    m.scale.set(r, r * (0.6 + squash * 0.55), r);
    const y = sandHeight(x, z) - r * sink;
    m.position.set(x, y, z);
    m.rotation.y = rand(0, Math.PI * 2);
    group.add(m);
    walkables.push(m);
    addCol(x, y + r * 0.2, z, r * 0.95);
    return m;
  };

  // =============== ZONE A: Castle on a rocky mound (left) ===============
  {
    const cx = -3.9, cz = -1.05;
    const base = sandHeight(cx, cz);
    const castle = decorModel('castle', glowMats);
    castle.position.set(cx, base - 0.06, cz);
    castle.rotation.y = 0.18;
    group.add(castle);
    castle.updateMatrixWorld(true);
    castle.traverse((o) => o.isMesh && walkables.push(o));
    const at = (x, y, z) => castle.localToWorld(new THREE.Vector3(x, y, z));
    const col = (x, y, z, r) => { const p = at(x, y, z); addCol(p.x, p.y, p.z, r); };
    col(0, 0.15, 0, 1.2);            // mound
    col(-0.62, 1.2, 0.08, 0.38);     // flanking towers
    col(0.62, 1.1, 0.08, 0.38);
    col(0, 1.6, -0.34, 0.38);        // rear tower
    col(0, 0.8, 0.06, 0.42);         // keep
    const sp = (name, x, y, z, kind, r) => { const p = at(x, y, z); spot(name, p.x, p.y, p.z, kind, r); };
    sp('замок', 0, 0.95, 1.05, 'castle', 0.5);
    sp('ворота замка', 0, 0.5, 0.55, 'hide', 0.25);
    sp('башня', 0, 3.9, -0.34, 'landmark', 0.7);
    out.castle = castle;
  }

  // =============== ZONE B: Driftwood centerpiece (center-back) ===============
  {
    const bx = 0.4, bz = -1.45;
    const by = sandHeight(bx, bz);
    const wood = decorModel('driftwood');
    wood.position.set(bx, by, bz);
    group.add(wood);
    wood.updateMatrixWorld(true);
    wood.traverse((o) => o.isMesh && walkables.push(o));
    out.driftwood = wood;
    // colliders along the limbs (coarse)
    const mesh = partsOf(wood, 'Static')[0];
    const pos = mesh.geometry.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 40))) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      addCol(v.x, v.y, v.z, 0.22);
    }
    spot('коряга', bx, by + 1.6, bz + 0.5, 'landmark', 0.8);
    spot('под корягой', bx - 0.4, by + 0.35, bz + 0.6, 'hide', 0.35);
    out.woodCenter = new THREE.Vector3(bx, by + 1.5, bz);
  }

  // =============== ZONE C: Shipwreck + treasure (right) ===============
  {
    const sx = 3.6, sz = -0.75;
    const ship = decorModel('ship', glowMats);
    ship.position.set(sx, sandHeight(sx, sz) + 0.45, sz);
    ship.rotation.set(0.05, -0.35, -0.22);
    group.add(ship);
    ship.traverse((o) => o.isMesh && walkables.push(o));
    for (let i = -2; i <= 2; i++) addCol(sx + i * 0.75, sandHeight(sx, sz) + 0.4, sz + i * 0.22, 0.6);
    addCol(sx - 0.5, sandHeight(sx, sz) + 1.6, sz - 0.1, 0.35);
    spot('затонувший корабль', sx, sandHeight(sx, sz) + 1.0, sz + 0.9, 'ship', 0.8);
    spot('трюм корабля', sx + 0.3, sandHeight(sx, sz) + 0.55, sz + 0.25, 'hide', 0.3);
    out.ship = ship;

    // ---- Treasure chest (clickable secret) ----
    const chest = decorModel('chest');
    // gold and gems shimmer softly by day and glow at night
    for (const o of partsOf(chest, 'Glow')) {
      if (!glowMats.some((g) => g.mat === o.material)) glowMats.push({ mat: o.material, day: 0.35, night: 0.9 });
    }
    const lid = chest.getObjectByName('Lid');
    lid.rotation.x = -0.12;
    const cx2 = 2.2, cz2 = 0.75;
    chest.position.set(cx2, sandHeight(cx2, cz2) - 0.06, cz2);
    chest.rotation.set(0.04, -0.5, 0.08);
    group.add(chest);
    walkables.push(chest.getObjectByName('Chest'));
    addCol(cx2, sandHeight(cx2, cz2) + 0.2, cz2, 0.4);
    spot('сундук', cx2, sandHeight(cx2, cz2) + 0.6, cz2 + 0.3, 'landmark', 0.4);
    out.chest = { group: chest, lid, open: 0, target: 0, pos: new THREE.Vector3(cx2, sandHeight(cx2, cz2) + 0.35, cz2) };
    interactive.push({ mesh: chest, kind: 'chest' });

    // bottle with message (easter egg)
    const bottle = decorModel('bottle');
    bottle.position.set(-1.55, sandHeight(-1.55, 1.45) + 0.05, 1.45);
    bottle.rotation.set(Math.PI / 2 - 0.1, 0, 0.7);
    group.add(bottle);
    interactive.push({ mesh: bottle, kind: 'bottle' });
    spot('бутылка', -1.55, sandHeight(-1.55, 1.45) + 0.4, 1.45, 'landmark', 0.3);
  }

  // =============== ZONE D: Stone arch + cave (center-left front) ===============
  {
    const ax = -1.3, az = 0.05;
    const ay = sandHeight(ax, az);
    const arch = decorModel('arch', glowMats);
    arch.position.set(ax, ay - 0.05, az);
    group.add(arch);
    arch.traverse((o) => o.isMesh && walkables.push(o));
    for (let i = 0; i <= 12; i += 3) {
      const a = (i / 12) * Math.PI;
      addCol(ax + Math.cos(a) * 0.85, ay + Math.sin(a) * 1.0, az, 0.3);
    }
    spot('каменная арка', ax, ay + 0.55, az, 'arch', 0.35);
    // cave: hollow rock open to the front, behind the arch, with glowing crystals inside
    const cx = -2.0, cz = -0.9;
    const cave = decorModel('cave');
    cave.position.set(cx, sandHeight(cx, cz) - 0.05, cz);
    group.add(cave);
    cave.updateMatrixWorld(true);
    partsOf(cave, 'Static').forEach((o) => walkables.push(o));
    addCol(cx, sandHeight(cx, cz) + 0.5, cz - 0.3, 0.75);
    spot('пещера', cx + 0.05, sandHeight(cx, cz) + 0.28, cz + 0.6, 'cave', 0.35);
    // secret crystal inside cave (only visible from certain angles / at night)
    const crystals = partsOf(cave, 'Glow')[0];
    glowMats.push({ mat: crystals.material, day: 0.5, night: 4.0 });
    const cpos = crystals.getWorldPosition(new THREE.Vector3());
    const cl = new THREE.PointLight('#5fe6ff', 0.6, 1.6, 2);
    cl.position.copy(cpos).add(new THREE.Vector3(0, 0.25, 0.2));
    group.add(cl);
    out.crystalLight = cl;
    out.secretCave = { pos: cpos };
    interactive.push({ mesh: crystals, kind: 'crystal' });
  }

  // =============== Little mushroom house (front right) ===============
  {
    const hx = 4.6, hz = 1.25;
    const hy = sandHeight(hx, hz);
    const house = decorModel('mushroom');
    partsOf(house, 'Glow').forEach((o) => glowMats.push({ mat: o.material, day: 0.1, night: 3.0 }));
    house.position.set(hx, hy - 0.02, hz);
    house.rotation.y = -0.5;
    group.add(house);
    house.traverse((o) => o.isMesh && walkables.push(o));
    addCol(hx, hy + 0.4, hz, 0.5);
    spot('грибной домик', hx - 0.2, hy + 0.3, hz + 0.45, 'hide', 0.3);
  }

  // =============== Old lantern (front left) ===============
  {
    const lx = -4.9, lz = 1.4;
    const ly = sandHeight(lx, lz);
    const lantern = decorModel('lantern');
    partsOf(lantern, 'Glow').forEach((o) => glowMats.push({ mat: o.material, day: 0.4, night: 5.0 }));
    lantern.position.set(lx, ly - 0.02, lz);
    lantern.rotation.set(0.15, 0.4, -0.25);
    lantern.scale.setScalar(1.3);
    group.add(lantern);
    const pl = new THREE.PointLight('#ffb35a', 0.0, 2.8, 2);
    pl.position.set(lx, ly + 0.35, lz);
    group.add(pl);
    out.lanternLight = pl;
    spot('старый фонарь', lx, ly + 0.5, lz, 'landmark', 0.3);
  }

  // =============== Diver statue (center right, bubbles from helmet) ===============
  {
    const dx = 1.5, dz = -0.35;
    const dy = sandHeight(dx, dz);
    const diver = decorModel('diver');
    diver.position.set(dx, dy + 0.06, dz);
    diver.rotation.y = -0.4;
    diver.scale.setScalar(0.95);
    group.add(diver);
    diver.traverse((o) => o.isMesh && walkables.push(o));
    addCol(dx, dy + 0.6, dz, 0.4);
    spot('водолаз', dx, dy + 1.1, dz + 0.5, 'landmark', 0.4);
    diver.updateMatrixWorld(true);
    out.diverHelmet = diver.localToWorld(new THREE.Vector3(0.25, 1.05, -0.1)); // exhaust valve
  }

  // =============== Ruins: overgrown gateway (back right, behind the wreck) ===============
  {
    const rx = 4.55, rz = -1.95;
    const ruins = decorModel('ruins');
    ruins.position.set(rx, sandHeight(rx, rz) - 0.04, rz);
    ruins.rotation.y = 0.12;
    ruins.scale.setScalar(0.75);
    group.add(ruins);
    ruins.updateMatrixWorld(true);
    ruins.traverse((o) => o.isMesh && walkables.push(o));
    const at = (x, y, z) => ruins.localToWorld(new THREE.Vector3(x, y, z));
    for (const [x, y, z, r] of [[-0.62, 0.9, 0, 0.26], [0.62, 0.9, 0, 0.26], [0, 2.3, 0, 0.35], [1.35, 0.5, 0.25, 0.24]]) {
      const p = at(x, y, z); addCol(p.x, p.y, p.z, r);
    }
    const sp = at(0, 1.0, 0.3);
    spot('руины', sp.x, sp.y, sp.z, 'landmark', 0.6);
  }

  // =============== Rubber duck on the surface (very rare easter egg) ===============
  {
    const duck = decorModel('duck');
    duck.rotation.y = Math.PI / 2; // model faces +Z, the swim code moves it along +X
    const holder = new THREE.Group();
    holder.add(duck);
    holder.visible = false;
    holder.position.set(-7, 5.65, 0);
    group.add(holder);
    out.duck = holder;
  }

  // =============== Scatter rocks / pebbles ===============
  const scatter = [
    [-0.4, 1.3, 0.38], [0.7, 1.55, 0.25], [5.6, 0.75, 0.45], [-5.3, 0.4, 0.5],
    [-0.9, -2.0, 0.55], [1.6, 1.2, 0.18], [-2.4, 1.7, 0.2], [-5.4, -0.8, 0.45],
  ];
  scatter.forEach(([x, z, r], i) => placeRock(x, z, r, 1000 + i, 0.6 + Math.random() * 0.3));
  // heaps of dark craggy rocks
  for (const [x, z, k, rot, sc] of [[-3.0, 1.15, 0, 0.6, 1.0], [3.0, 1.6, 1, -0.4, 1.1]]) {
    const pile = decorNode('rockpile', `Pile${k}`);
    pile.position.set(x, sandHeight(x, z) - 0.05, z);
    pile.rotation.y = rot;
    pile.scale.setScalar(sc);
    group.add(pile);
    walkables.push(pile);
    addCol(x, sandHeight(x, z) + 0.3 * sc, z, 0.6 * sc);
  }
  // things fallen from the wreck: barrels and a cannon
  for (const [node, x, z, rot] of [['Cannon', 3.4, 0.3, 2.3], ['Barrel0', 4.35, 0.55, 0.3], ['Barrel1', 3.85, 0.95, 1.1]]) {
    const o = decorNode('wreckage', node);
    o.position.set(x, sandHeight(x, z) - 0.02, z);
    o.rotation.y = rot;
    group.add(o);
    walkables.push(o);
    addCol(x, sandHeight(x, z) + 0.2, z, 0.3);
  }
  spot('пушка', 3.4, sandHeight(3.4, 0.3) + 0.5, 0.6, 'landmark', 0.35);

  // pebble instanced field
  {
    const src = decorNode('pebbles', 'Pebble0');
    const n = 420;
    const inst = new THREE.InstancedMesh(src.geometry, src.material, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const x = rand(-5.8, 5.8), z = rand(-2.3, 2.3);
      p.set(x, sandHeight(x, z) + 0.005, z);
      q.setFromEuler(new THREE.Euler(rand(-0.3, 0.3), rand(0, 6.28), rand(-0.3, 0.3)));
      const k = rand(0.025, 0.08);
      sc.set(k, k * rand(0.7, 1.2), k * rand(0.8, 1.2));
      m.compose(p, q, sc);
      inst.setMatrixAt(i, m);
      col.setHSL(rand(0.02, 0.12), rand(0.05, 0.3), rand(0.55, 1.0));
      inst.setColorAt(i, col);
    }
    inst.receiveShadow = true; inst.castShadow = true;
    group.add(inst);
  }
  // seashells
  for (let i = 0; i < 9; i++) {
    const m = decorNode('shells', `Shell${i % 2}`);
    const x = rand(-5.5, 5.5), z = rand(0.2, 2.2);
    m.position.set(x, sandHeight(x, z) - 0.005, z);
    m.rotation.set(rand(-0.2, 0.2), rand(0, 6), rand(-0.2, 0.2));
    m.scale.setScalar(rand(0.8, 1.3));
    group.add(m);
  }

  // open-water spots (for explorers)
  spot('у поверхности', 0, 5.0, 0.2, 'open', 1.5);
  spot('у фильтра', 4.9, 4.6, -1.3, 'filter', 0.6);
  spot('середина аквариума', -0.5, 3.0, 0.6, 'open', 1.5);
  spot('у переднего стекла', 1.0, 2.5, 1.9, 'glass', 1.2);

  return out;
}

export function updateDecor(decor, t, dt, night) {
  for (const g of decor.glowMats) g.mat.emissiveIntensity = THREE.MathUtils.lerp(g.day, g.night, night) * (0.92 + 0.08 * Math.sin(t * 3 + g.day * 10));
  decor.lanternLight.intensity = night * 2.2 * (0.85 + 0.15 * Math.sin(t * 7.3) * Math.sin(t * 3.1));
  decor.crystalLight.intensity = 0.3 + night * 1.6;
  const ch = decor.chest;
  ch.open += (ch.target - ch.open) * Math.min(1, dt * 2.5);
  ch.lid.rotation.x = -0.12 - ch.open * 1.6;
}
