import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Fish models generated in Blender (tools/blender/make_fish.py) or brought in ready-made
// (tools/import_fish.py: a lone Body with the eyes and fins painted on, no Fins/Pect/Eye parts;
// tools/fin_map.py marks its fins in uv1).
// Species without a model fall back to the procedural builder.
export const ASSETS = {};

function bakedGeometry(mesh) {
  const g = mesh.geometry.clone();
  g.applyMatrix4(mesh.matrixWorld);
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'uv1'].includes(name)) g.deleteAttribute(name);
  return g;
}

export async function loadFishAssets(ids, onProgress) {
  const loader = new GLTFLoader();
  let done = 0;
  await Promise.all(ids.map(async (id) => {
    try {
      const gltf = await loader.loadAsync(`models/fish/${id}.glb`);
      gltf.scene.updateMatrixWorld(true);
      const nodes = {};
      gltf.scene.traverse((o) => { if (o.isMesh) nodes[o.name] = o; });
      const eye = (o) => {
        o.geometry.computeBoundingSphere();
        const s = o.geometry.boundingSphere;
        return { pos: s.center.clone().applyMatrix4(o.matrixWorld), r: s.radius };
      };
      const pect = (o) => ({ geo: bakedGeometry(o), pivot: new THREE.Vector3().setFromMatrixPosition(o.matrixWorld) });
      ASSETS[id] = {
        body: bakedGeometry(nodes.Body),
        bodyMap: nodes.Body.material.map,
        bodyNormal: nodes.Body.material.normalMap,
        fins: nodes.Fins ? bakedGeometry(nodes.Fins) : null,
        finMap: nodes.Fins?.material.map,
        pects: nodes.PectL ? [pect(nodes.PectL), pect(nodes.PectR)] : [],
        eyes: nodes.EyeL ? [eye(nodes.EyeL), eye(nodes.EyeR)] : [],
      };
      for (const t of [ASSETS[id].bodyMap, ASSETS[id].finMap]) if (t) t.anisotropy = 8;
    } catch (e) {
      console.warn(`fish model "${id}" not loaded, using procedural fallback`, e);
    }
    onProgress && onProgress(++done / ids.length);
  }));
  return ASSETS;
}
