import * as THREE from 'three';

// Global uniforms shared by every patched material in the scene.
export const G = {
  uTime: { value: 0 },
  uCaustic: { value: 1 },
  uCausticColor: { value: new THREE.Color(1.0, 0.97, 0.85) },
  uCurrent: { value: new THREE.Vector2(0, 0) },
  uFish: { value: Array.from({ length: 16 }, () => new THREE.Vector4(0, -100, 0, 0)) },
  uNight: { value: 0 },
};

const CAUSTIC_GLSL = /* glsl */ `
float cWave(vec2 uv, float time){
  vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
  vec2 i = p; float c = 1.0; float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float t = time * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
vec3 causticRGB(vec2 uv, float t){
  float g = cWave(uv, t);
  return vec3(g * 0.95, g, g * 1.08) * 1.1;
}
`;

/**
 * Patch a built-in material with aquarium features.
 * opts.caustics: strength (0 = off)
 * opts.sway: plant sway strength (0 = off) — uses local vertex height above the root
 * opts.wag: {value: Vector4(phase, amplitude, bend, length)} — fish body undulation
 *   (opts.instanced: wag and pect come from the per-instance attributes iWag / iPect instead)
 * opts.glow: {value: float} extra fresnel-ish rim glow (night creatures)
 * opts.solidFins: the solid fins of a sculpted model move on their own (aFin from tools/fin_map.py,
 *   per instance iFinA = (fin phase, dorsal/anal erect, fin activity, tail spread),
 *   iFinB = (left and right pectoral extra angle, pelvic spread, pelvic beat phase))
 */
export function patchMaterial(mat, opts = {}) {
  const caustics = opts.caustics ?? 1;
  const sway = opts.sway ?? 0;
  const wag = opts.wag;
  const inst = !!opts.instanced;
  const key = `aq-${caustics > 0}-${sway > 0}-${!!wag}-${!!opts.glow}-${!!opts.pect}-${inst}-${!!opts.solidFins}`;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = G.uTime;
    sh.uniforms.uCaustic = G.uCaustic;
    sh.uniforms.uCausticColor = G.uCausticColor;
    sh.uniforms.uCurrent = G.uCurrent;
    sh.uniforms.uFish = G.uFish;
    sh.uniforms.uCStrength = { value: caustics };
    sh.uniforms.uSway = { value: sway };
    if (wag && !inst) sh.uniforms.uWag = wag;
    if (opts.glow) sh.uniforms.uGlow = opts.glow;
    if (opts.pect && !inst) sh.uniforms.uPect = opts.pect;

    let head = `
uniform float uTime; uniform vec2 uCurrent; uniform vec4 uFish[16]; uniform float uSway;
varying vec3 vCWorld; varying vec3 vCNorm;
${wag ? (inst ? 'attribute vec4 iWag;\n#define uWag iWag' : 'uniform vec4 uWag;') : ''}
${opts.pect ? (inst ? 'attribute float iPect;\n#define uPect iPect\nattribute vec4 aPect;' : 'uniform float uPect; attribute vec4 aPect;') : ''}
${opts.solidFins ? 'attribute vec4 iFinA; attribute vec4 iFinB; attribute float aFin;' : ''}
`;
    sh.vertexShader = head + sh.vertexShader;

    if (wag) {
      // The fish bends around a spine running along -Z. Cross-sections rotate with the spine
      // tangent (normals too, so the bend reads in the lighting); behind the peduncle the
      // caudal fin is a plate that pivots and flexes, keeping its length instead of shearing.
      sh.vertexShader = sh.vertexShader.replace('void main() {', `
const float FISH_K = 5.4; // wave number * L: a bit over one body length per wave
// lateral spine offset at z and its slope along the swimming axis (u = -z)
vec2 fishSpine(float z, float lag) {
  float L = uWag.w, k = FISH_K / L;
  float s = clamp((L * 0.5 - z) / L, 0.0, 1.0);
  // carangiform envelope: slight head recoil, still point at ~1/5 L, largest at the tail
  float env = 0.12 - 0.6 * s + 1.48 * s * s;
  float denv = (-0.6 + 2.96 * s) * (-1.0 / L);
  float a = uWag.x + k * z - lag; // the crest travels nose -> tail
  float zb = min(z, 0.0);
  float x = uWag.y * env * sin(a) + uWag.z * zb * zb;
  float dxdz = uWag.y * (denv * sin(a) + env * k * cos(a)) + 2.0 * uWag.z * zb;
  return vec2(x, -dxdz);
}
// finU: 0 at a fin's root .. 1 at its tip (-1 for the body), finTail: 1 on the caudal fin
float fishAngle(float lag) { return clamp(atan(fishSpine(-0.47 * uWag.w, lag).y), -0.7, 0.7); }
vec3 fishBend(vec3 p, inout vec3 n, float finU, float finTail) {
  float L = uWag.w, zP = -0.47 * L, k = FISH_K / L;
  vec2 sp = fishSpine(max(p.z, zP), 0.0);
  float phi = clamp(atan(sp.y), -0.6, 0.6);
  vec3 q;
  if (p.z < zP) {
    // caudal fin hinged at the peduncle. The soft rays lag behind the peduncle more and more
    // towards the tip, so a wave runs down the fin and long veil tails flow like cloth
    float d = zP - p.z;
    float u = finTail > 0.5 ? finU : clamp(d / (0.3 * L), 0.0, 1.0);
    float phiM = fishAngle(0.8 * u) * (1.0 - 0.15 * u), phiE = fishAngle(1.6 * u) * (1.0 - 0.3 * u);
    q = vec3(sp.x + d * sin(phiM) + p.x * cos(phiE), p.y, zP - d * cos(phiM) + p.x * sin(phiE));
    phi = phiE;
  } else {
    q = vec3(sp.x + p.x * cos(phi), p.y, p.z + p.x * sin(phi));
  }
  if (finU > 0.0) {
    // soft fins never hold still: a ripple runs from root to tip (harmonic of the tail beat plus
    // a slow drift), growing towards the free edge
    float fl = sin(2.0 * uWag.x - finU * 5.0 + p.y * 4.0 / L) * 0.6
             + sin(uTime * 3.1 + uWag.x * 0.37 - finU * 3.0 + p.z * 9.0 / L) * 0.4;
    q.x += fl * pow(finU, 1.4) * (0.012 * L + 0.3 * uWag.y) * cos(phi);
  }
  float c = cos(phi), si = sin(phi);
  n = vec3(c * n.x - si * n.z, n.y, si * n.x + c * n.z);
  return q;
}
${opts.solidFins ? `
// a solid fin moving on its own (aFin = type + 0.98 u: 1 tail, 2 dorsal, 3 anal, 4 pelvic, 5 pectoral)
vec3 finMotion(float code, vec3 p) {
  float type = floor(code + 1e-3);
  if (type < 0.5) return p;
  float L = uWag.w, u = clamp((code - type) / 0.98, 0.0, 1.0), act = iFinA.z;
  // every soft fin flickers at the rim: a small fast wave running out from the root
  float flick = sin(iFinA.x * 2.3 - u * 4.0 + p.z * 11.0 / L + p.y * 7.0 / L) * pow(u, 1.4) * L * (0.012 + 0.03 * act);
  float side = p.x >= 0.0 ? 1.0 : -1.0;
  if (type < 1.5) {
    // tail: the rays fan out and close up, the rim flutters
    // seen from the side: the fan keeps opening and closing a little, a wave runs along its rim
    p.y *= 1.0 + (iFinA.w * 0.2 + 0.12 * act * sin(iFinA.x * 0.9)) * u;
    p.z += u * L * 0.025 * act * sin(iFinA.x * 0.7 + p.y * 6.0 / L);
    p.x += flick * 1.5 + sin(iFinA.x * 1.7 - abs(p.y) * 9.0 / L) * u * u * L * 0.035 * act;
  } else if (type < 3.5) {
    // dorsal (2) and anal (3): a wave runs front to back along the fin; folded down and back at speed
    float s = type < 2.5 ? 1.0 : -1.0, fold = 1.0 - iFinA.y, h = abs(p.y);
    p.y -= s * fold * 0.45 * u * h;
    p.z -= fold * 0.3 * u * h;
    p.x += sin(iFinA.x - p.z * 12.0 / L + s * 0.9) * pow(u, 1.2) * L * (0.03 + 0.07 * act) + flick;
    // seen from the side: the rays rise and fall one after another, the fin rocks to and fro
    p.y += s * pow(u, 1.2) * L * (0.02 + 0.04 * act) * sin(iFinA.x * 0.8 - p.z * 10.0 / L);
    p.z += u * L * 0.03 * act * sin(iFinA.x * 0.6 + s);
  } else if (type < 4.5) {
    // pelvic pair: beating out and in by turns, spread wide to brake and hover
    p.x += side * u * L * (0.07 * iFinB.z + 0.06 * act * sin(iFinB.w + side * 1.3)) + flick * 0.6;
        p.z += u * L * 0.07 * act * cos(iFinB.w + side * 1.3);
    p.y += u * L * 0.03 * act * sin(iFinB.w + side * 1.3);
  } else {
    // pectoral left in the body: sculls out and back with its side's angle (left = -x)
    float a = side < 0.0 ? iFinB.x : iFinB.y;
    p.x += side * u * L * 0.22 * a + flick * 0.6;
    p.z -= u * L * 0.08 * abs(a);
    p.y += u * L * 0.05 * a;
  }
  return p;
}` : ''}
void main() {`);
      sh.vertexShader = sh.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        vec3 fishPos = position;
        ${opts.pect ? `
        if (aPect.x != 0.0) {
          // pectoral fin paddling: rotate around the fin root (Y), then tilt (X)
          vec3 p = fishPos - aPect.yzw;
          float a = aPect.x * uPect${opts.solidFins ? ' + aPect.x * (aPect.x < 0.0 ? iFinB.x : iFinB.y)' : ''};
          mat2 ry = mat2(cos(a), -sin(a), sin(a), cos(a)), rx = mat2(cos(0.3), sin(0.3), -sin(0.3), cos(0.3));
          p.xz = ry * p.xz; p.yz = rx * p.yz;
          objectNormal.xz = ry * objectNormal.xz; objectNormal.yz = rx * objectNormal.yz;
          fishPos = p + aPect.yzw;
        }` : ''}
        ${opts.pect ? `
        // fin atlas: left half of U = caudal fin, right half = other fins; U runs root -> tip
        float finTail = step(uv.x, 0.5);
        float finU = finTail > 0.5 ? uv.x * 2.0 : uv.x * 2.0 - 1.0;` : 'float finU = -1.0, finTail = 0.0;'}
        ${opts.solidFins ? 'fishPos = finMotion(aFin, fishPos);' : ''}
        fishPos = fishBend(fishPos, objectNormal, finU, finTail);`
      );
      sh.vertexShader = sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed = fishPos;`
      );
    }

    sh.vertexShader = sh.vertexShader.replace(
      '#include <project_vertex>',
      `
      vec4 cLocal = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        cLocal = instanceMatrix * cLocal;
      #endif
      vec4 cWorld = modelMatrix * cLocal;
      ${sway > 0 ? `
      {
        float h = max(transformed.y, 0.0);
        float hs = pow(h, 1.35) * uSway;
        float ph = cWorld.x * 0.7 + cWorld.z * 0.45;
        vec2 sw = vec2(
          sin(uTime * 0.9 + ph) + 0.45 * sin(uTime * 2.3 + cWorld.y * 1.7 + ph * 2.0),
          0.6 * cos(uTime * 0.7 + ph * 1.3) + 0.3 * sin(uTime * 1.9 + cWorld.y * 2.1)
        ) * 0.07 + uCurrent;
        vec2 push = vec2(0.0);
        for (int i = 0; i < 8; i++) {
          vec3 d = cWorld.xyz - uFish[i].xyz;
          float dl = length(d);
          float rad = uFish[i].w * 2.6 + 0.001;
          float f = uFish[i].w * smoothstep(rad, 0.0, dl);
          push += normalize(d.xz + vec2(1e-4)) * f;
        }
        cWorld.xz += sw * hs + push * 0.5 * min(h, 1.2);
        cWorld.y -= dot(sw * hs, sw * hs) * 0.6;
      }` : ''}
      vCWorld = cWorld.xyz;
      vCNorm = normalize(mat3(modelMatrix) * objectNormal);
      vec4 mvPosition = viewMatrix * cWorld;
      gl_Position = projectionMatrix * mvPosition;
      `
    );

    sh.fragmentShader = `
uniform float uTime; uniform float uCaustic; uniform vec3 uCausticColor; uniform float uCStrength;
varying vec3 vCWorld; varying vec3 vCNorm;
${opts.glow ? 'uniform float uGlow;' : ''}
${caustics > 0 ? CAUSTIC_GLSL : ''}
` + sh.fragmentShader;

    let inject = '';
    if (caustics > 0) {
      inject += `
      {
        bool inside = abs(vCWorld.x) < 6.0 && abs(vCWorld.z) < 2.6 && vCWorld.y < 5.7;
        if (inside) {
          float ny = vCNorm.y == vCNorm.y ? vCNorm.y : 1.0; // guard against NaN normals
          float up = clamp(ny * 0.75 + 0.35, 0.0, 1.0);
          float depthFade = mix(0.55, 1.0, clamp(vCWorld.y / 5.5, 0.0, 1.0));
          vec3 cc = clamp(causticRGB(vCWorld.xz * 0.23 + vCWorld.y * 0.05, uTime * 0.55), 0.0, 3.0);
          outgoingLight += diffuseColor.rgb * cc * uCausticColor * uCaustic * uCStrength * up * depthFade * 1.6;
        }
      }`;
    }
    if (opts.glow) {
      inject += `
      {
        vec3 vd = normalize(vViewPosition);
        float fr = pow(1.0 - abs(dot(normalize(normal), -vd)), 2.0);
        outgoingLight += diffuseColor.rgb * uGlow * (0.6 + fr * 2.0);
      }`;
    }
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', inject + '\n#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

// Small deterministic RNG helpers
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const smooth = (t) => t * t * (3 - 2 * t);

// Cheap smooth 2D/3D noise for geometry displacement
export function noise3(x, y, z) {
  return (
    Math.sin(x * 1.7 + Math.sin(y * 1.3 + z * 0.7) * 1.3) * 0.5 +
    Math.sin(y * 2.3 + Math.sin(z * 1.9 + x * 0.6) * 1.1) * 0.3 +
    Math.sin(z * 2.9 + Math.sin(x * 2.2 + y * 1.4)) * 0.2
  );
}
