import * as THREE from 'three';
import { mergeVertices, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../fx/shaderPatch.js';

const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Radius profile along the body; t: 0 = tail end, 1 = nose
export function profileAt(sp, t) {
  const p = sp.profile;
  if (p.disc) {
    const u = 2 * t - 1;
    const r = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(u), 2.2)));
    return Math.max(r, t < 0.12 ? p.peduncle : 0);
  }
  const peak = p.diamond ? 0.6 : 0.58;
  if (t >= peak) {
    const u = (t - peak) / (1 - peak);
    return Math.pow(Math.max(0, 1 - Math.pow(u, 2.0)), 0.35 + 0.45 * (1 - p.headRound));
  }
  const u = (peak - t) / peak;
  const e = p.diamond ? 0.8 : 1.25 - p.taper * 0.5;
  return 1 - (1 - p.peduncle) * Math.pow(u, e);
}

function finGrid(nu, nv, fn, colFn) {
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const u = i / nu, v = j / nv;
    const p = fn(u, v);
    pos.push(p.x, p.y, p.z);
    colFn(c, u, v);
    col.push(c.r, c.g, c.b);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, d = a + nu + 1, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildFishModel(sp, variant, R) {
  const L = sp.len, H = sp.height, W = sp.width;
  const root = new THREE.Group();
  const wag = { value: new THREE.Vector4(0, sp.swim.amp * L, 0, L) };
  const glow = sp.glow ? { value: 0 } : null;
  const pect = { value: 0.55 };

  // ---------- body ----------
  let g = new THREE.CylinderGeometry(1, 1, 1, 28, 36, false);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-5);
  const pa = g.attributes.position;
  const cols = new Float32Array(pa.count * 3);
  const c = new THREE.Color();
  const p = sp.profile;
  const centerY = (t) => (p.hump || 0) * H * Math.sin(Math.PI * t) * 0.5;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
    const t = y + 0.5;
    const d = Math.min(1, Math.hypot(x, z));
    const th = Math.atan2(x, z);
    const side = Math.sin(th) * d, up = Math.cos(th) * d;
    const r = profileAt(sp, t);
    let Y = up * r * H * 0.5;
    if (up < 0) Y *= 1 + (p.belly || 0);
    if (p.flatBelly) Y = Math.max(Y, -H * 0.32 * r);
    Y += centerY(t);
    // slightly narrower back ridge for a more fish-like cross-section
    const X = side * r * W * 0.5 * (1 - Math.max(0, up) * 0.25);
    const Z = (t - 0.5) * L;
    pa.setXYZ(i, X, Y, Z);
    sp.body(c, side, up, 2 * t - 1, R(), variant);
    // mouth / nose shading & gill line
    if (t > 0.97 && up < 0.2) c.multiplyScalar(0.55);
    if (Math.abs(t - 0.78) < 0.008 && Math.abs(up) < 0.7) c.multiplyScalar(0.8);
    // counter-shading
    c.multiplyScalar(0.85 + 0.25 * Math.max(0, -up) * 0.6 + 0.1 * Math.max(0, up));
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.computeVertexNormals();

  const bodyMat = patchMaterial(new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.3, metalness: 0.05, clearcoat: 0.7, clearcoatRoughness: 0.18,
    iridescence: sp.irid || 0, iridescenceIOR: 1.35, iridescenceThicknessRange: [200, 600],
    sheen: 0.4, sheenColor: new THREE.Color('#ffffff'), sheenRoughness: 0.5,
    emissive: sp.glow ? new THREE.Color('#8fe9ff') : new THREE.Color('#000'), emissiveIntensity: sp.glow ? 0.4 : 0,
  }), { caustics: 0.55, wag, glow });
  const body = new THREE.Mesh(g, bodyMat);
  body.castShadow = true;
  root.add(body);

  // ---------- fins ----------
  const finBase = sp.finFromVariant ? new THREE.Color(variant) : (sp.fin || new THREE.Color('#ddd'));
  const finEdge = sp.finEdge || null;
  const finGrad = sp.finGradient || null;
  const finMat = patchMaterial(new THREE.MeshPhysicalMaterial({
    vertexColors: true, transparent: true, opacity: sp.finOpacity ?? 0.7, side: THREE.DoubleSide, roughness: 0.35,
    depthWrite: false, iridescence: (sp.irid || 0) * 0.8, iridescenceIOR: 1.3,
    emissive: sp.glow ? new THREE.Color('#8fb6ff') : new THREE.Color('#000'), emissiveIntensity: sp.glow ? 0.6 : 0,
    sheen: 0.5, sheenColor: finBase.clone().offsetHSL(0, 0, 0.2),
  }), { caustics: 0.4, wag, glow, pect });
  finMat.forceSinglePass = true; // avoid the extra back-face pass for transparent double-sided fins
  const finColor = (cc, u, v, rays = 6) => {
    cc.copy(finBase);
    if (finGrad) cc.lerp(finGrad, u * 0.8);
    cc.multiplyScalar(1 - 0.22 * Math.pow(Math.abs(Math.sin(v * Math.PI * rays)), 4));
    if (finEdge && u > 0.82) cc.lerp(finEdge, (u - 0.82) / 0.18);
    if (sp.finStripes) cc.lerp(new THREE.Color('#222'), Math.pow(Math.max(0, Math.sin(u * 14)), 8) * 0.6);
  };
  const tz0 = -L / 2 + L * 0.03;
  const pedR = profileAt(sp, 0.02) * H * 0.5;
  const tail = sp.tail;
  const lenF = {
    fork: (v) => 0.5 + 0.5 * Math.pow(Math.abs(v), 0.9),
    fan: (v) => 1 - 0.15 * v * v,
    round: (v) => 1 - 0.35 * v * v,
    lyre: (v) => 0.45 + 0.55 * Math.pow(Math.abs(v), 2.5),
    veil: (v) => 1 - 0.12 * v * v,
    double: (v) => 0.7 + 0.3 * Math.abs(v),
  }[tail.type];
  const spanPow = tail.type === 'fan' || tail.type === 'veil' ? 0.55 : 0.85;
  const makeTail = (xs) => finGrid(10, 14, (u, vv) => {
    const v = vv * 2 - 1;
    const span = pedR + (tail.span * 0.5 - pedR) * Math.pow(u, spanPow);
    const ruff = tail.type === 'veil' || tail.type === 'double' ? Math.sin(v * 9 + u * 5) * 0.012 * u : 0;
    return new THREE.Vector3(
      xs * u * tail.span * 0.35 + ruff,
      v * span - (tail.droop || 0) * u * u,
      tz0 - u * tail.len * lenF(v),
    );
  }, (cc, u, v) => finColor(cc, u, v * 2 - 1, 7));
  const tails = tail.type === 'double' ? [makeTail(1), makeTail(-1)] : [makeTail(0)];
  // all fixed fins share one material -> merged into a single mesh (one draw call)
  const finGeos = [...tails];

  // dorsal
  const topAt = (t) => profileAt(sp, t) * H * 0.5 + centerY(t);
  const botAt = (t) => -profileAt(sp, t) * H * 0.5 * (1 + (p.belly || 0)) + centerY(t);
  const dorsalLike = (cfg, dir) => {
    const [a, b] = cfg.at;
    const ta = (a + 1) / 2, tb = (b + 1) / 2;
    return finGrid(14, 8, (u, v) => {
      const t = ta + (tb - ta) * u;
      let hh = cfg.h * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.15)), 0.6);
      if (cfg.notch) hh *= 0.65 + 0.35 * Math.abs(Math.sin(u * Math.PI * 2));
      if (cfg.follow) hh = cfg.h * Math.pow(Math.sin(Math.PI * u), 0.3);
      const baseY = dir > 0 ? topAt(t) : botAt(t);
      const z = (t - 0.5) * L - v * (cfg.sweep || 0.3) * cfg.h * (1 - u * 0.3);
      return new THREE.Vector3(0, baseY - dir * 0.006 + dir * v * hh, z);
    }, (cc, u, v) => finColor(cc, v, u, 8));
  };
  finGeos.push(dorsalLike(sp.dorsal, 1), dorsalLike(sp.anal, -1));
  if (sp.dorsal.double) {
    finGeos.push(dorsalLike({ at: [0.15, 0.45], h: sp.dorsal.h * 0.7, sweep: 0.3 }, 1));
  }

  // ventral streamers (angelfish)
  if (sp.ventralStreamers) {
    for (const s of [-1, 1]) {
      const vg = finGrid(2, 10, (u, v) => new THREE.Vector3(s * 0.01 + (u - 0.5) * 0.012, botAt(0.7) - v * sp.ventralStreamers, L * 0.18 - v * v * 0.15), (cc) => cc.set('#f0eadb'));
      finGeos.push(vg);
    }
  }

  // pectoral fins join the same mesh; their paddling happens in the vertex shader (aPect)
  for (const g0 of finGeos) g0.setAttribute('aPect', new THREE.BufferAttribute(new Float32Array(g0.attributes.position.count * 4), 4));
  for (const s of [-1, 1]) {
    const pg = finGrid(6, 6, (u, v) => new THREE.Vector3(0, (v - 0.5) * sp.pect * 0.8, -u * sp.pect * 1.4 * (0.7 + 0.3 * Math.sin(Math.PI * v))), (cc, u, v) => finColor(cc, u, v, 4));
    const t = 0.72;
    const piv = new THREE.Vector3(s * profileAt(sp, t) * W * 0.45, -H * 0.12 * profileAt(sp, t), (t - 0.5) * L);
    pg.translate(piv.x, piv.y, piv.z);
    const n = pg.attributes.position.count, ap = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) ap.set([s, piv.x, piv.y, piv.z], i * 4);
    pg.setAttribute('aPect', new THREE.BufferAttribute(ap, 4));
    finGeos.push(pg);
  }
  const fins = new THREE.Mesh(mergeGeometries(finGeos), finMat);
  fins.renderOrder = 5;
  root.add(fins);

  // ---------- eyes + barbels: one vertex-coloured mesh ----------
  const eyeT = 0.85;
  const er = sp.eye * 0.82;
  const parts = [];
  const part = (geo, color, x, y, z, rot) => {
    geo.deleteAttribute('uv');
    if (rot) geo.rotateX(rot[0]).rotateZ(rot[2]);
    geo.translate(x, y, z);
    const n = geo.attributes.position.count, cc = new THREE.Color(color), arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) cc.toArray(arr, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    parts.push(geo);
  };
  const eyes = [];
  for (const s of [-1, 1]) {
    const ex = s * (profileAt(sp, eyeT) * W * 0.5 * 0.8 + (sp.bulgeEye ? er * 0.4 : 0));
    const ey = topAt(eyeT) * 0.3, ez = (eyeT - 0.5) * L;
    part(new THREE.SphereGeometry(er, 14, 10), sp.redEye ? '#ff5533' : '#f4f1e8', ex, ey, ez);
    part(new THREE.SphereGeometry(er * 0.62, 12, 8), '#050505', ex + s * er * 0.5, ey, ez + er * 0.12);
    part(new THREE.SphereGeometry(er * 0.18, 6, 4), '#ffffff', ex + s * er * 0.95, ey + er * 0.3, ez + er * 0.25);
  }
  if (sp.barbels) {
    for (const s of [-1, 1]) for (const k of [0, 1]) {
      part(new THREE.CylinderGeometry(0.003, 0.005, 0.06, 4), '#d8c7a8', s * (0.015 + k * 0.012), botAt(0.96) + 0.004, L * 0.47, [0.9, 0, s * 0.5]);
    }
  }
  // eyes live in the body mesh (front of the fish, untouched by the tail wag)
  body.geometry = mergeGeometries([body.geometry, ...parts]);

  return { root, body, bodyMat, finMat, wag, pect, glow };
}

// ---------------------------------------------------------------- Blender-made fish
const EYE_UV = [0.997, 0.997];
const IRIS = { neon: '#8fd6ff', guppy: '#d8c070', goldfish: '#e0a030', angelfish: '#d04a2a', clown: '#e07a20', cory: '#b89a60', cichlid: '#ffd040', discus: '#ff3b1f', barb: '#ff5533', betta: '#5a3a80', rainbow: '#e6c060', moonfish: '#b0e8ff' }; // white, flat texel block reserved in every body texture

export function buildAssetFishModel(sp, A) {
  const L = sp.len;
  const root = new THREE.Group();
  const wag = { value: new THREE.Vector4(0, sp.swim.amp * L, 0, L) };
  const glow = sp.glow ? { value: 0 } : null;
  const pect = { value: 0.55 };
  const withColor = (g, color) => {
    const n = g.attributes.position.count, arr = new Float32Array(n * 3), c = new THREE.Color(color);
    for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  };

  // body + cartoon eyes in one mesh
  const parts = [withColor(A.body.clone(), '#ffffff')];
  const eyePart = (r, ws, hs, color, pos) => {
    const g = new THREE.SphereGeometry(r, ws, hs);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, EYE_UV[0], EYE_UV[1]);
    g.translate(pos.x, pos.y, pos.z);
    parts.push(withColor(g, color));
  };
  // natural eyes: coloured iris ball, big dark pupil, small specular glint
  const iris = IRIS[sp.id] || '#c9a24a';
  A.eyes.forEach((e, k) => {
    const s = k === 0 ? -1 : 1, er = e.r * 0.85, p = e.pos;
    eyePart(er, 16, 12, iris, p);
    eyePart(er * 0.62, 14, 10, '#030303', p.clone().add(new THREE.Vector3(s * er * 0.48, 0, er * 0.05)));
    eyePart(er * 0.13, 6, 4, '#ffffff', p.clone().add(new THREE.Vector3(s * er * 0.98, er * 0.32, er * 0.28)));
  });
  const bodyMat = patchMaterial(new THREE.MeshPhysicalMaterial({
    map: A.bodyMap, normalMap: A.bodyNormal, normalScale: new THREE.Vector2(0.7, 0.7), vertexColors: true,
    roughness: 0.3, metalness: 0.05, clearcoat: 0.7, clearcoatRoughness: 0.18,
    iridescence: sp.irid || 0, iridescenceIOR: 1.35, iridescenceThicknessRange: [200, 600],
    sheen: 0.4, sheenColor: new THREE.Color('#ffffff'), sheenRoughness: 0.5,
    emissive: sp.glow ? new THREE.Color('#8fe9ff') : new THREE.Color('#000'), emissiveIntensity: sp.glow ? 0.4 : 0,
  }), { caustics: 0.55, wag, glow });
  const body = new THREE.Mesh(mergeGeometries(parts), bodyMat);
  body.castShadow = true;
  root.add(body);

  // fins: fixed fins + pectorals (paddled in the shader around their pivots)
  const fixed = A.fins.clone();
  fixed.setAttribute('aPect', new THREE.BufferAttribute(new Float32Array(fixed.attributes.position.count * 4), 4));
  const finGeos = [fixed];
  A.pects.forEach((pc, k) => {
    const g = pc.geo.clone(), n = g.attributes.position.count, ap = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) ap.set([k === 0 ? -1 : 1, pc.pivot.x, pc.pivot.y, pc.pivot.z], i * 4);
    g.setAttribute('aPect', new THREE.BufferAttribute(ap, 4));
    finGeos.push(g);
  });
  const finMat = patchMaterial(new THREE.MeshPhysicalMaterial({
    map: A.finMap, transparent: true, side: THREE.DoubleSide, depthWrite: false, roughness: 0.35,
    iridescence: (sp.irid || 0) * 0.8, iridescenceIOR: 1.3, sheen: 0.5, sheenColor: new THREE.Color('#ffffff'),
    emissive: sp.glow ? new THREE.Color('#8fb6ff') : new THREE.Color('#000'), emissiveIntensity: sp.glow ? 0.6 : 0,
  }), { caustics: 0.4, wag, glow, pect });
  finMat.forceSinglePass = true;
  const fins = new THREE.Mesh(mergeGeometries(finGeos), finMat);
  fins.renderOrder = 5;
  root.add(fins);

  return { root, body, bodyMat, finMat, wag, pect, glow };
}
