import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial, noise3, rand, mulberry32 } from '../fx/shaderPatch.js';
import { sandHeight } from './tank.js';

const std = (o, caustics = 1) => patchMaterial(new THREE.MeshStandardMaterial(o), { caustics });
const phys = (o, caustics = 1) => patchMaterial(new THREE.MeshPhysicalMaterial(o), { caustics });

function shade(m) { m.castShadow = true; m.receiveShadow = true; return m; }

export function rockGeometry(r, seed, squash = 0.7, detail = 4) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position;
  const R = mulberry32(seed);
  const o1 = R() * 10, o2 = R() * 10, o3 = R() * 10;
  const colors = [];
  const base = new THREE.Color().setHSL(0.07 + R() * 0.06, 0.12 + R() * 0.12, 0.32 + R() * 0.15);
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    const d = 1 + noise3(n.x * 2 + o1, n.y * 2 + o2, n.z * 2 + o3) * 0.22 + noise3(n.x * 6 + o2, n.y * 6, n.z * 6 + o1) * 0.06;
    v.multiplyScalar(d);
    // flatten facets a bit for a chiseled look
    v.y *= squash;
    if (v.y < -r * 0.2) v.y = -r * 0.2 + (v.y + r * 0.2) * 0.2;
    p.setXYZ(i, v.x, v.y, v.z);
    const c = base.clone();
    const k = noise3(v.x * 4 + o3, v.y * 4, v.z * 4) * 0.08;
    c.offsetHSL(0, 0, k + (v.y > r * 0.3 ? 0.04 : -0.02));
    colors.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

const rockMat = () => std({ vertexColors: true, roughness: 0.85, metalness: 0.02 }, 1.1);

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

  const rmat = rockMat();
  const placeRock = (x, z, r, seed, squash = 0.7, sink = 0.25) => {
    const m = shade(new THREE.Mesh(rockGeometry(r, seed, squash), rmat));
    const y = sandHeight(x, z) - r * sink;
    m.position.set(x, y, z);
    m.rotation.y = rand(0, Math.PI * 2);
    group.add(m);
    walkables.push(m);
    addCol(x, y + r * 0.2, z, r * 0.95);
    return m;
  };

  // =============== ZONE A: Castle on a rocky hill (left) ===============
  {
    const cx = -3.9, cz = -0.9;
    const base = sandHeight(cx, cz);
    placeRock(cx - 0.9, cz + 0.5, 0.9, 11, 0.6);
    placeRock(cx + 0.8, cz + 0.6, 0.7, 12, 0.55);
    placeRock(cx, cz - 0.3, 1.1, 13, 0.5);
    const castle = new THREE.Group();
    const stone = std({ color: '#c9b79a', roughness: 0.8 }, 1);
    const stoneDark = std({ color: '#8e7b64', roughness: 0.85 }, 1);
    const roof = phys({ color: '#3f6fb0', roughness: 0.45, clearcoat: 0.6 }, 0.7);
    const winMat = new THREE.MeshStandardMaterial({ color: '#2a1a08', emissive: new THREE.Color('#ffb347'), emissiveIntensity: 0.2 });
    glowMats.push({ mat: winMat, day: 0.15, night: 3.2 });
    const tower = (x, z, r, h, roofH) => {
      const t = shade(new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.08, h, 24, 6), stone));
      t.position.set(x, h / 2, z);
      castle.add(t);
      // bricks: ring lines
      for (let i = 1; i < 6; i++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.01, 0.012, 4, 32), stoneDark);
        ring.rotation.x = Math.PI / 2; ring.position.set(x, (h / 6) * i, z);
        castle.add(ring);
      }
      // crenellations
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const b = shade(new THREE.Mesh(new THREE.BoxGeometry(r * 0.28, 0.16, r * 0.22), stone));
        b.position.set(x + Math.cos(a) * r * 0.95, h + 0.08, z + Math.sin(a) * r * 0.95);
        b.rotation.y = -a;
        castle.add(b);
      }
      const rf = shade(new THREE.Mesh(new THREE.ConeGeometry(r * 1.2, roofH, 24), roof));
      rf.position.set(x, h + 0.16 + roofH / 2, z);
      castle.add(rf);
      // flag
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.35, 6), stoneDark);
      pole.position.set(x, h + 0.16 + roofH + 0.15, z);
      castle.add(pole);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.13, 6, 1), patchMaterial(new THREE.MeshStandardMaterial({ color: '#e94b5a', side: THREE.DoubleSide }), { caustics: 0.5, sway: 2.0 }));
      flag.position.set(x + 0.11, h + 0.16 + roofH + 0.25, z);
      castle.add(flag);
      // windows
      for (let i = 0; i < 3; i++) {
        const a = rand(-0.6, 0.6) + Math.PI / 2;
        const w = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.18, 0.08), winMat);
        const wy = h * (0.45 + i * 0.17);
        w.position.set(x + Math.cos(a) * r, wy, z + Math.sin(a) * r);
        w.lookAt(x + Math.cos(a) * r * 3, wy, z + Math.sin(a) * r * 3);
        castle.add(w);
      }
    };
    tower(-0.55, 0, 0.36, 1.7, 0.7);
    tower(0.6, 0.05, 0.3, 1.35, 0.55);
    tower(0.05, -0.45, 0.42, 2.2, 0.9);
    // wall with arched gate
    const wallShape = new THREE.Shape();
    wallShape.moveTo(-0.6, 0); wallShape.lineTo(0.6, 0); wallShape.lineTo(0.6, 0.95); wallShape.lineTo(-0.6, 0.95); wallShape.lineTo(-0.6, 0);
    const hole = new THREE.Path();
    hole.moveTo(-0.2, 0); hole.lineTo(0.2, 0); hole.lineTo(0.2, 0.35); hole.absarc(0, 0.35, 0.2, 0, Math.PI, false); hole.lineTo(-0.2, 0);
    wallShape.holes.push(hole);
    const wall = shade(new THREE.Mesh(new THREE.ExtrudeGeometry(wallShape, { depth: 0.25, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 }), stone));
    wall.position.set(0, 0, 0.12);
    castle.add(wall);
    for (let i = 0; i < 6; i++) {
      const b = shade(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.27), stone));
      b.position.set(-0.52 + i * 0.208, 1.02, 0.245);
      castle.add(b);
    }
    // inner dark (so the gate looks like an entrance)
    const dark = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.05), new THREE.MeshBasicMaterial({ color: '#05070a' }));
    dark.position.set(0, 0.28, 0.0);
    castle.add(dark);
    castle.position.set(cx, base + 0.25, cz - 0.15);
    castle.rotation.y = 0.18;
    castle.scale.setScalar(1.05);
    group.add(castle);
    castle.traverse((o) => o.isMesh && walkables.push(o));
    addCol(cx - 0.55, base + 1.2, cz - 0.15, 0.45);
    addCol(cx + 0.6, base + 1.0, cz - 0.1, 0.4);
    addCol(cx + 0.05, base + 1.5, cz - 0.6, 0.55);
    spot('замок', cx + 0.05, base + 0.75, cz + 0.55, 'castle', 0.5);
    spot('ворота замка', cx + 0.02, base + 0.5, cz + 0.32, 'hide', 0.25);
    spot('башня', cx + 0.05, base + 3.2, cz - 0.5, 'landmark', 0.7);
    out.castle = castle;
  }

  // =============== ZONE B: Driftwood centerpiece (center-back) ===============
  {
    const woodMat = std({ color: '#5a3c26', roughness: 0.9, vertexColors: true }, 1.1);
    const branches = [];
    const R = mulberry32(777);
    const branch = (start, dir, len, rad, depth) => {
      const pts = [start.clone()];
      let p = start.clone(), d = dir.clone();
      const n = 8;
      for (let i = 0; i < n; i++) {
        d.add(new THREE.Vector3(R() - 0.5, (R() - 0.4) * 0.6, R() - 0.5).multiplyScalar(0.45)).normalize();
        p = p.clone().addScaledVector(d, len / n);
        pts.push(p);
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const g = new THREE.TubeGeometry(curve, 40, rad, 10, false);
      // taper + knots
      const pa = g.attributes.position;
      const cols = [];
      for (let i = 0; i < pa.count; i++) {
        const seg = Math.floor(i / 11) / 40;
        const c = curve.getPointAt(Math.min(seg, 1));
        const v = new THREE.Vector3().fromBufferAttribute(pa, i);
        const off = v.clone().sub(c);
        const taper = 1 - seg * 0.75;
        const knot = 1 + noise3(v.x * 5, v.y * 5, v.z * 5) * 0.18;
        v.copy(c).addScaledVector(off, taper * knot);
        pa.setXYZ(i, v.x, v.y, v.z);
        const l = 0.75 + noise3(v.x * 9, v.y * 3, v.z * 9) * 0.25;
        cols.push(l * 1.0, l * 0.85, l * 0.7);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      g.computeVertexNormals();
      branches.push(g);
      if (depth > 0) {
        const k = 1 + Math.floor(R() * 2);
        for (let j = 0; j < k; j++) {
          const at = curve.getPointAt(0.45 + R() * 0.4);
          const nd = d.clone().add(new THREE.Vector3(R() - 0.5, R() * 0.8, R() - 0.5)).normalize();
          branch(at, nd, len * 0.6, rad * 0.55, depth - 1);
        }
      }
    };
    const bx = 0.4, bz = -1.45;
    const by = sandHeight(bx, bz);
    branch(new THREE.Vector3(bx - 1.6, by - 0.05, bz + 0.3), new THREE.Vector3(1, 0.55, -0.1).normalize(), 3.0, 0.16, 2);
    branch(new THREE.Vector3(bx + 1.2, by - 0.05, bz + 0.2), new THREE.Vector3(-0.6, 0.9, -0.2).normalize(), 3.2, 0.14, 2);
    branch(new THREE.Vector3(bx - 0.4, by - 0.05, bz + 0.6), new THREE.Vector3(0.2, 1, -0.5).normalize(), 2.4, 0.11, 1);
    const wood = shade(new THREE.Mesh(mergeGeometries(branches), woodMat));
    group.add(wood);
    walkables.push(wood);
    out.driftwood = wood;
    // colliders along branches (coarse)
    const pos = wood.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 360) {
      addCol(pos.getX(i), pos.getY(i), pos.getZ(i), 0.22);
    }
    spot('коряга', bx, by + 1.6, bz + 0.5, 'landmark', 0.8);
    spot('под корягой', bx - 0.4, by + 0.35, bz + 0.6, 'hide', 0.35);
    out.woodCenter = new THREE.Vector3(bx, by + 1.5, bz);
  }

  // =============== ZONE C: Shipwreck + treasure (right) ===============
  {
    const ship = new THREE.Group();
    const plankMat = std({ color: '#6b4a2e', roughness: 0.8, vertexColors: true }, 1);
    const darkWood = std({ color: '#3b2817', roughness: 0.9 }, 0.8);
    const metal = phys({ color: '#9a7b3a', metalness: 0.9, roughness: 0.35 }, 0.6);
    // hull: lathe-like half shell
    const hullGeo = new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55);
    const hp = hullGeo.attributes.position;
    const hc = [];
    for (let i = 0; i < hp.count; i++) {
      let x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
      x *= 2.0; z *= 0.75; y *= 0.8;
      const bow = Math.max(0, x / 2.0);
      z *= 1 - bow * bow * 0.85;
      // broken edge on one side
      if (z > 0 && x > -0.5 && x < 0.9 && y > -0.35) y = Math.min(y, -0.35 + Math.sin(x * 14) * 0.06);
      hp.setXYZ(i, x, y, z);
      const plank = 0.75 + 0.25 * Math.sin(y * 40) * 0.5 + noise3(x * 3, y * 9, z) * 0.12;
      hc.push(plank, plank * 0.92, plank * 0.85);
    }
    hullGeo.setAttribute('color', new THREE.Float32BufferAttribute(hc, 3));
    hullGeo.computeVertexNormals();
    plankMat.side = THREE.DoubleSide;
    const hull = shade(new THREE.Mesh(hullGeo, plankMat));
    ship.add(hull);
    // deck planks
    for (let i = -6; i <= 4; i++) {
      if (i > -2 && i < 2 && Math.random() < 0.6) continue;
      const p = shade(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 1.1 - Math.abs(i) * 0.04), plankMat));
      p.position.set(i * 0.3, -0.05, 0);
      p.rotation.z = rand(-0.05, 0.05);
      ship.add(p);
    }
    // broken mast + crow's nest
    const mast = shade(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.6, 12), darkWood));
    mast.position.set(-0.3, 1.2, 0); mast.rotation.z = 0.35;
    ship.add(mast);
    const yard = shade(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 8), darkWood));
    yard.position.set(-0.62, 1.95, 0); yard.rotation.set(0.3, 0, 1.5);
    ship.add(yard);
    // torn sail
    const sailGeo = new THREE.PlaneGeometry(1.1, 0.9, 10, 10);
    const sp = sailGeo.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.getX(i), y = sp.getY(i);
      sp.setZ(i, Math.sin(x * 3) * 0.1 + Math.sin(y * 4) * 0.05);
      if (y < -0.2 && (x > 0.2 || Math.sin(x * 20) > 0.6)) sp.setY(i, -0.2 + Math.sin(x * 25) * 0.08);
    }
    sailGeo.computeVertexNormals();
    const sail = new THREE.Mesh(sailGeo, patchMaterial(new THREE.MeshStandardMaterial({ color: '#d8ccaf', roughness: 0.9, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }), { caustics: 0.8, sway: 0.25 }));
    sail.position.set(-0.6, 1.5, 0.03); sail.rotation.z = 0.32;
    ship.add(sail);
    // portholes
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.025, 8, 20), metal);
      ring.position.set(-1.2 + i * 0.55, -0.35, 0.63 - Math.max(0, (-1.2 + i * 0.55) / 2) ** 2 * 0.5);
      ship.add(ring);
    }
    // rudder & anchor
    const anchor = new THREE.Group();
    const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 8), metal); anchor.add(shank);
    const arm = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.03, 8, 20, Math.PI), metal); arm.rotation.z = Math.PI; arm.position.y = -0.2; anchor.add(arm);
    const ringA = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 8, 16), metal); ringA.position.y = 0.33; anchor.add(ringA);
    anchor.position.set(1.9, -0.25, 0.75); anchor.rotation.set(0.4, 0.3, 1.1);
    ship.add(anchor);
    const sx = 3.75, sz = -0.75;
    ship.position.set(sx, sandHeight(sx, sz) + 0.45, sz);
    ship.rotation.set(0.05, -0.35, -0.22);
    ship.scale.setScalar(1.05);
    group.add(ship);
    ship.traverse((o) => o.isMesh && walkables.push(o));
    for (let i = -2; i <= 2; i++) addCol(sx + i * 0.75, sandHeight(sx, sz) + 0.4, sz + i * 0.22, 0.6);
    addCol(sx - 0.5, sandHeight(sx, sz) + 1.6, sz - 0.1, 0.35);
    spot('затонувший корабль', sx, sandHeight(sx, sz) + 1.0, sz + 0.9, 'ship', 0.8);
    spot('трюм корабля', sx + 0.3, sandHeight(sx, sz) + 0.55, sz + 0.25, 'hide', 0.3);
    out.ship = ship;

    // ---- Treasure chest (clickable secret) ----
    const chest = new THREE.Group();
    const chestWood = std({ color: '#7a4a24', roughness: 0.7 }, 1);
    const box = shade(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.32, 0.4), chestWood));
    box.position.y = 0.16;
    chest.add(box);
    for (const x of [-0.22, 0.22]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.42), metal); band.position.set(x, 0.16, 0); chest.add(band);
    }
    const goldMat = new THREE.MeshStandardMaterial({ color: '#ffcf4a', metalness: 1, roughness: 0.25, emissive: new THREE.Color('#ffaa00'), emissiveIntensity: 0.35 });
    glowMats.push({ mat: goldMat, day: 0.35, night: 0.9 });
    const coins = new THREE.Group();
    for (let i = 0; i < 26; i++) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.01, 12), goldMat);
      c.position.set(rand(-0.24, 0.24), 0.3 + rand(0, 0.04), rand(-0.15, 0.15)); c.rotation.set(rand(-0.6, 0.6), 0, rand(-0.6, 0.6));
      coins.add(c);
    }
    chest.add(coins);
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, 0.32, -0.2);
    const lidM = shade(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.6, 16, 1, false, 0, Math.PI), chestWood));
    lidM.rotation.z = Math.PI / 2; lidM.position.set(0, 0, 0.2);
    lidPivot.add(lidM);
    chest.add(lidPivot);
    lidPivot.rotation.x = -0.12;
    const cx2 = 2.2, cz2 = 0.75;
    chest.position.set(cx2, sandHeight(cx2, cz2) - 0.06, cz2);
    chest.rotation.set(0.04, -0.5, 0.08);
    group.add(chest);
    walkables.push(box);
    addCol(cx2, sandHeight(cx2, cz2) + 0.2, cz2, 0.4);
    spot('сундук', cx2, sandHeight(cx2, cz2) + 0.6, cz2 + 0.3, 'landmark', 0.4);
    out.chest = { group: chest, lid: lidPivot, open: 0, target: 0, pos: new THREE.Vector3(cx2, sandHeight(cx2, cz2) + 0.35, cz2) };
    interactive.push({ mesh: chest, kind: 'chest' });

    // bottle with message (easter egg)
    const bottle = new THREE.Group();
    const glassG = phys({ color: '#3fa36b', roughness: 0.1, transparent: true, opacity: 0.7 }, 0.5);
    const bb = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.32, 16), glassG); bottle.add(bb);
    const bn = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.07, 0.14, 16), glassG); bn.position.y = 0.22; bottle.add(bn);
    const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.03, 0.05, 8), std({ color: '#a77b4f' })); cork.position.y = 0.31; bottle.add(cork);
    const scroll = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8), std({ color: '#efe0b8' })); bottle.add(scroll);
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
    // arch made of stacked rocks on a curve
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      const x = ax + Math.cos(a) * 0.85;
      const y = ay + Math.sin(a) * 1.0;
      const m = shade(new THREE.Mesh(rockGeometry(0.27 + Math.sin(a) * 0.04, 300 + i, 0.85, 3), rmat));
      m.position.set(x, y, az);
      m.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
      group.add(m);
      walkables.push(m);
      if (i % 3 === 0) addCol(x, y, az, 0.3);
    }
    spot('каменная арка', ax, ay + 0.55, az, 'arch', 0.35);
    // cave: hollow rock shell open to the front, behind the arch
    const caveGeo = rockGeometry(1.0, 404, 0.75, 4);
    const cp = caveGeo.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(cp, i);
      if (v.z > 0.35 && v.y < 0.55) { v.z = 0.35 + (v.z - 0.35) * 0.1; }
      cp.setXYZ(i, v.x, v.y, v.z);
    }
    caveGeo.computeVertexNormals();
    const caveOuter = shade(new THREE.Mesh(caveGeo, rmat));
    const cx = -2.0, cz = -0.9;
    caveOuter.position.set(cx, sandHeight(cx, cz) - 0.05, cz);
    caveOuter.scale.set(1.15, 1.15, 0.95);
    group.add(caveOuter);
    walkables.push(caveOuter);
    // dark mouth
    const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.42, 24), new THREE.MeshBasicMaterial({ color: '#020406' }));
    mouth.position.set(cx + 0.05, sandHeight(cx, cz) + 0.22, cz + 0.36);
    mouth.scale.y = 0.7;
    group.add(mouth);
    addCol(cx, sandHeight(cx, cz) + 0.5, cz - 0.3, 0.75);
    spot('пещера', cx + 0.05, sandHeight(cx, cz) + 0.28, cz + 0.6, 'cave', 0.35);
    // secret crystal inside cave (only visible from certain angles / at night)
    const crystalMat = new THREE.MeshPhysicalMaterial({ color: '#7ef0ff', emissive: new THREE.Color('#38d6ff'), emissiveIntensity: 0.6, roughness: 0.05, transparent: true, opacity: 0.95 });
    glowMats.push({ mat: crystalMat, day: 0.5, night: 4.0 });
    const crystals = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.06 + Math.random() * 0.05, 0), crystalMat);
      c.scale.y = 2.4;
      c.position.set(rand(-0.15, 0.15), 0.05, rand(-0.1, 0.1));
      c.rotation.set(rand(-0.4, 0.4), rand(0, 3), rand(-0.4, 0.4));
      crystals.add(c);
    }
    crystals.position.set(cx + 0.15, sandHeight(cx, cz) + 0.1, cz + 0.05);
    group.add(crystals);
    const cl = new THREE.PointLight('#5fe6ff', 0.6, 1.6, 2);
    cl.position.copy(crystals.position).add(new THREE.Vector3(0, 0.25, 0.2));
    group.add(cl);
    out.crystalLight = cl;
    out.secretCave = { pos: crystals.position.clone() };
    interactive.push({ mesh: crystals, kind: 'crystal' });
  }

  // =============== Little mushroom house (front right) ===============
  {
    const hx = 4.6, hz = 1.25;
    const hy = sandHeight(hx, hz);
    const house = new THREE.Group();
    const stem = shade(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.55, 24), std({ color: '#f1e6cf', roughness: 0.7 })));
    stem.position.y = 0.27; house.add(stem);
    const cap = shade(new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), phys({ color: '#d8423f', roughness: 0.35, clearcoat: 0.8 })));
    cap.scale.y = 0.7; cap.position.y = 0.52; house.add(cap);
    const dotMat = std({ color: '#fff7ea' });
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2, e = rand(0.2, 1.2);
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), dotMat);
      d.position.set(Math.cos(a) * Math.cos(e) * 0.49, 0.52 + Math.sin(e) * 0.34, Math.sin(a) * Math.cos(e) * 0.49);
      d.scale.y = 0.4; d.lookAt(0, 0, 0); house.add(d);
    }
    const door = new THREE.Mesh(new THREE.CircleGeometry(0.12, 20, 0, Math.PI), new THREE.MeshStandardMaterial({ color: '#2b1a0f' }));
    door.position.set(0, 0.06, 0.345); house.add(door);
    const doorB = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.1), door.material); doorB.position.set(0, 0.03, 0.345); house.add(doorB);
    const win = new THREE.MeshStandardMaterial({ color: '#332211', emissive: new THREE.Color('#ffcf7a'), emissiveIntensity: 0.2 });
    glowMats.push({ mat: win, day: 0.1, night: 3.0 });
    const w = new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), win); w.position.set(0.17, 0.32, 0.3); w.rotation.y = 0.5; house.add(w);
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
    const lantern = new THREE.Group();
    const iron = phys({ color: '#2e2f2c', metalness: 0.8, roughness: 0.5 }, 0.5);
    const glassL = new THREE.MeshStandardMaterial({ color: '#ffd28a', emissive: new THREE.Color('#ffb04a'), emissiveIntensity: 0.4, transparent: true, opacity: 0.85 });
    glowMats.push({ mat: glassL, day: 0.4, night: 5.0 });
    const baseL = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.06, 6), iron); baseL.position.y = 0.03; lantern.add(baseL);
    const g = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 6), glassL); g.position.y = 0.21; lantern.add(g);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; const bar = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.32, 0.02), iron); bar.position.set(Math.cos(a) * 0.125, 0.21, Math.sin(a) * 0.125); lantern.add(bar); }
    const top = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.15, 6), iron); top.position.y = 0.43; lantern.add(top);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 6, 16), iron); ring.position.y = 0.53; lantern.add(ring);
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
    const diver = new THREE.Group();
    const brass = phys({ color: '#c08a3e', metalness: 0.95, roughness: 0.28, clearcoat: 0.4 }, 0.8);
    const suit = std({ color: '#7d8a8f', roughness: 0.75 }, 1);
    const helmet = shade(new THREE.Mesh(new THREE.SphereGeometry(0.22, 32, 24), brass)); helmet.position.y = 0.95; diver.add(helmet);
    const port = new THREE.Mesh(new THREE.CircleGeometry(0.09, 24), phys({ color: '#14303a', roughness: 0.05, metalness: 0.2, clearcoat: 1 }, 0)); port.position.set(0, 0.95, 0.215); diver.add(port);
    const portRing = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.018, 8, 24), brass); portRing.position.copy(port.position); diver.add(portRing);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.1, 24), brass); collar.position.y = 0.77; diver.add(collar);
    const body = shade(new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.3, 8, 16), suit)); body.position.y = 0.5; diver.add(body);
    for (const s of [-1, 1]) {
      const leg = shade(new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.25, 6, 12), suit)); leg.position.set(s * 0.1, 0.16, 0); diver.add(leg);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.2), brass); boot.position.set(s * 0.1, 0.02, 0.03); diver.add(boot);
      const armM = shade(new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.28, 6, 12), suit)); armM.position.set(s * 0.26, 0.55, 0.05); armM.rotation.z = s * 0.5; diver.add(armM);
    }
    // little treasure in hands
    const pearl = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), new THREE.MeshPhysicalMaterial({ color: '#fff', roughness: 0.1, iridescence: 1, iridescenceIOR: 1.6, clearcoat: 1 }));
    pearl.position.set(0, 0.42, 0.24); diver.add(pearl);
    const pedestal = shade(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.14, 24), rmat)); pedestal.position.y = -0.04; diver.add(pedestal);
    diver.position.set(dx, dy, dz);
    diver.rotation.y = -0.4;
    diver.scale.setScalar(0.95);
    group.add(diver);
    diver.traverse((o) => o.isMesh && walkables.push(o));
    addCol(dx, dy + 0.6, dz, 0.4);
    spot('водолаз', dx, dy + 1.1, dz + 0.5, 'landmark', 0.4);
    out.diverHelmet = new THREE.Vector3(dx, dy + 1.18, dz);
  }

  // =============== Ruins: broken columns (back left) ===============
  {
    const marble = phys({ color: '#e8e2d6', roughness: 0.55, clearcoat: 0.2 }, 1.1);
    const cols = [[-5.2, -1.7, 1.6], [-4.5, -2.0, 0.9], [-3.0, -2.0, 2.3]];
    for (const [x, z, h] of cols) {
      const y = sandHeight(x, z);
      const c = shade(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, h, 16, 1), marble));
      // flutes
      const p = c.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) { const a = Math.atan2(p.getZ(i), p.getX(i)); const k = 1 + Math.cos(a * 16) * 0.04; p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k); }
      c.geometry.computeVertexNormals();
      c.position.set(x, y + h / 2 - 0.1, z);
      c.rotation.z = rand(-0.08, 0.08);
      group.add(c);
      walkables.push(c);
      const cap = shade(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), marble));
      cap.position.set(x, y + h - 0.05, z);
      if (h > 1.2) group.add(cap), walkables.push(cap);
      addCol(x, y + h / 2, z, 0.28);
    }
    // fallen column piece
    const f = shade(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 1.0, 16), marble));
    f.position.set(-4.1, sandHeight(-4.1, -2.0) + 0.1, -1.95);
    f.rotation.set(0, 0.3, Math.PI / 2);
    group.add(f);
    walkables.push(f);
    spot('руины', -4.4, 1.9, -1.6, 'landmark', 0.6);
  }

  // =============== Rubber duck on the surface (very rare easter egg) ===============
  {
    const duck = new THREE.Group();
    const y = phys({ color: '#ffd23a', roughness: 0.35, clearcoat: 1 }, 0);
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.18, 24, 16), y); b.scale.set(1.2, 0.8, 1); duck.add(b);
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 16), y); h.position.set(0.14, 0.15, 0); duck.add(h);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.09, 12), std({ color: '#ff7a1a' }, 0)); beak.rotation.z = -Math.PI / 2; beak.position.set(0.27, 0.14, 0); duck.add(beak);
    for (const s of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), new THREE.MeshBasicMaterial({ color: '#111' })); e.position.set(0.21, 0.19, s * 0.06); duck.add(e); }
    duck.visible = false;
    duck.position.set(-7, 5.65, 0);
    group.add(duck);
    out.duck = duck;
  }

  // =============== Scatter rocks / pebbles ===============
  const scatter = [
    [-0.4, 1.3, 0.38], [0.7, 1.55, 0.25], [2.9, 1.6, 0.3], [-3.0, 1.1, 0.42], [5.1, -0.2, 0.55], [-5.3, 0.4, 0.5],
    [3.0, -1.9, 0.6], [-0.9, -2.0, 0.55], [1.6, 1.2, 0.18], [-2.4, 1.7, 0.2], [4.0, 0.6, 0.26], [-5.4, -0.8, 0.45],
  ];
  scatter.forEach(([x, z, r], i) => placeRock(x, z, r, 1000 + i, 0.6 + Math.random() * 0.3));
  // pebble instanced field
  {
    const pg = rockGeometry(0.05, 5, 0.6, 1);
    const pm = std({ vertexColors: true, roughness: 0.6 }, 1);
    const n = 420;
    const inst = new THREE.InstancedMesh(pg, pm, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const x = rand(-5.8, 5.8), z = rand(-2.3, 2.3);
      p.set(x, sandHeight(x, z) + 0.005, z);
      q.setFromEuler(new THREE.Euler(rand(0, 3), rand(0, 3), rand(0, 3)));
      s.setScalar(rand(0.5, 2.2));
      m.compose(p, q, s);
      inst.setMatrixAt(i, m);
      col.setHSL(rand(0.02, 0.12), rand(0.05, 0.35), rand(0.35, 0.8));
      inst.setColorAt(i, col);
    }
    inst.receiveShadow = true; inst.castShadow = true;
    group.add(inst);
  }
  // seashells
  {
    const shellMat = phys({ color: '#f6d9c9', roughness: 0.3, clearcoat: 1, iridescence: 0.5 }, 1);
    for (let i = 0; i < 9; i++) {
      const g = new THREE.SphereGeometry(0.09, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      const p = g.attributes.position;
      for (let k = 0; k < p.count; k++) { const a = Math.atan2(p.getZ(k), p.getX(k)); p.setY(k, p.getY(k) * (1 + Math.cos(a * 9) * 0.12) * 0.6); }
      g.computeVertexNormals();
      const m = shade(new THREE.Mesh(g, shellMat));
      const x = rand(-5.5, 5.5), z = rand(0.2, 2.2);
      m.position.set(x, sandHeight(x, z) - 0.01, z);
      m.rotation.set(rand(-0.3, 0.3), rand(0, 6), rand(-0.3, 0.3));
      group.add(m);
    }
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
