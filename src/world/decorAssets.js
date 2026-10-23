import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { patchMaterial } from '../fx/shaderPatch.js';

// Scenery and plant models generated in Blender (tools/blender/make_decor.py, make_plants.py).
// Node names carry roles:
//   Glow*  emissive parts that brighten at night     Sway*  parts bent by the water current
//   Glass* transparent parts                          anything else: static baked PBR surface
const MODELS = {};

const GLOW = { day: 0.15, night: 3.0 };
// how strongly Sway* parts of each model bend in the current
const SWAY = { castle: 2.0, ship: 0.25, vallisneria: 0.55, sword: 0.22, crypt: 0.18, anubias: 0.08, limnophila: 0.45, cabomba: 0.6, ludwigia: 0.4, pistia: 0, corals: 3.5 };

function prepare(scene, name) {
  const patched = new Map();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    // multi-material nodes become a group of meshes: the role sits on the nearest named ancestor
    let role = 'Static';
    for (let p = o; p && p !== scene; p = p.parent) {
      const r = /^(Glow|Sway|Glass)/.exec(p.name)?.[1];
      if (r) { role = r; break; }
    }
    o.userData.role = role;
    const m = o.material;
    if (!patched.has(m)) {
      if (m.map) m.map.anisotropy = 8;
      if (role === 'Glass') { m.transparent = true; m.opacity = Math.min(m.opacity, 0.75); m.depthWrite = false; }
      // textures with alpha outside glass (feathery leaves) are cutouts: no sorting, no blending
      else if (m.transparent && m.map) { m.transparent = false; m.alphaTest = 0.5; }
      if (role === 'Glow') m.emissiveIntensity = GLOW.day;
      patchMaterial(m, { caustics: role === 'Glow' ? 0 : 1, sway: role === 'Sway' ? SWAY[name] ?? 0.6 : 0 });
      patched.set(m, true);
    }
    o.castShadow = role !== 'Glass';
    o.receiveShadow = true;
  });
  return scene;
}

/** paths relative to models/, e.g. 'decor/castle'; models are keyed by file name. */
export async function loadDecorAssets(paths, onProgress) {
  const loader = new GLTFLoader();
  let done = 0;
  await Promise.all(paths.map(async (path) => {
    const name = path.split('/').pop();
    try {
      const gltf = await loader.loadAsync(`models/${path}.glb`);
      MODELS[name] = prepare(gltf.scene, name);
    } catch (e) {
      console.warn(`decor model "${name}" not loaded, using procedural fallback`, e);
    }
    onProgress && onProgress(++done / names.length);
  }));
  return MODELS;
}

/**
 * A fresh instance of a loaded model (geometry and materials are shared), or null.
 * glowMats receives {mat, day, night} for each emissive material so the day cycle can drive it.
 */
export function decorModel(name, glowMats) {
  const src = MODELS[name];
  if (!src) return null;
  const obj = src.clone(true);
  if (glowMats) {
    const seen = new Set(glowMats.map((g) => g.mat));
    obj.traverse((o) => {
      if (o.isMesh && o.userData.role === 'Glow' && !seen.has(o.material)) {
        seen.add(o.material);
        glowMats.push({ mat: o.material, ...GLOW });
      }
    });
  }
  return obj;
}

/** Meshes of a model instance by role. */
export function partsOf(obj, role) {
  const out = [];
  obj.traverse((o) => o.isMesh && o.userData.role === role && out.push(o));
  return out;
}

/** A fresh copy of one named node of a loaded model (e.g. one rock variant), or null. */
export function decorNode(name, node) {
  const src = MODELS[name]?.getObjectByName(node);
  if (!src) return null;
  const obj = src.clone(true);
  obj.position.set(0, 0, 0);
  obj.rotation.set(0, 0, 0);
  obj.scale.set(1, 1, 1);
  return obj;
}
