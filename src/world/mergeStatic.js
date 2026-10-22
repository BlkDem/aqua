import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Bakes every static mesh under `root` into one mesh per (material, shadow flags).
// Meshes inside `skip` subtrees, instanced meshes and swaying materials stay as they are.
export function mergeStatic(root, skip = []) {
  const skipSet = new Set();
  for (const s of skip) s && s.traverse((o) => skipSet.add(o));
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const groups = new Map();
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || skipSet.has(o) || !o.visible) return;
    const m = o.material;
    if (Array.isArray(m)) return;
    const key = m.customProgramCacheKey && m.customProgramCacheKey();
    if (typeof key === 'string' && key.split('-')[2] === 'true') return; // sway shader uses local height
    const k = `${m.uuid}|${o.castShadow}|${o.receiveShadow}|${o.renderOrder}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  });

  let removed = 0, added = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const mat = list[0].material;
    const needUv = !!(mat.map || mat.normalMap || mat.roughnessMap);
    const needColor = !!mat.vertexColors;
    const geos = [], used = [];
    for (const o of list) {
      let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      if (!g.attributes.normal) g.computeVertexNormals();
      if (needUv && !g.attributes.uv) continue;
      if (needColor && !g.attributes.color) continue;
      for (const name of Object.keys(g.attributes)) {
        if (name === 'position' || name === 'normal' || (name === 'uv' && needUv) || (name === 'color' && needColor)) continue;
        g.deleteAttribute(name);
      }
      g.morphAttributes = {};
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      geos.push(g);
      used.push(o);
    }
    if (geos.length < 2) continue;
    const merged = mergeGeometries(geos);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = list[0].castShadow;
    mesh.receiveShadow = list[0].receiveShadow;
    mesh.renderOrder = list[0].renderOrder;
    root.add(mesh);
    added++;
    for (const o of used) { o.parent.remove(o); removed++; }
  }
  return { removed, added };
}
