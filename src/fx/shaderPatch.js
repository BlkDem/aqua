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
 * opts.glow: {value: float} extra fresnel-ish rim glow (night creatures)
 */
export function patchMaterial(mat, opts = {}) {
  const caustics = opts.caustics ?? 1;
  const sway = opts.sway ?? 0;
  const wag = opts.wag;
  const key = `aq-${caustics > 0}-${sway > 0}-${!!wag}-${!!opts.glow}-${!!opts.pect}`;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = G.uTime;
    sh.uniforms.uCaustic = G.uCaustic;
    sh.uniforms.uCausticColor = G.uCausticColor;
    sh.uniforms.uCurrent = G.uCurrent;
    sh.uniforms.uFish = G.uFish;
    sh.uniforms.uCStrength = { value: caustics };
    sh.uniforms.uSway = { value: sway };
    if (wag) sh.uniforms.uWag = wag;
    if (opts.glow) sh.uniforms.uGlow = opts.glow;
    if (opts.pect) sh.uniforms.uPect = opts.pect;

    let head = `
uniform float uTime; uniform vec2 uCurrent; uniform vec4 uFish[16]; uniform float uSway;
varying vec3 vCWorld; varying vec3 vCNorm;
${wag ? 'uniform vec4 uWag;' : ''}
${opts.pect ? 'uniform float uPect; attribute vec4 aPect;' : ''}
`;
    sh.vertexShader = head + sh.vertexShader;

    if (wag) {
      sh.vertexShader = sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        ${opts.pect ? `
        if (aPect.x != 0.0) {
          // pectoral fin paddling: rotate around the fin root (Y), then tilt (X)
          vec3 p = transformed - aPect.yzw;
          float a = aPect.x * uPect;
          p.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * p.xz;
          p.yz = mat2(cos(0.3), sin(0.3), -sin(0.3), cos(0.3)) * p.yz;
          transformed = p + aPect.yzw;
        }` : ''}
        {
          float L = uWag.w;
          float zt = clamp((L * 0.18 - transformed.z) / (L * 0.9), 0.0, 1.6);
          float w = sin(uWag.x - transformed.z * 5.5 / L);
          float zb = min(transformed.z, 0.0);
          transformed.x += w * uWag.y * zt * zt + uWag.z * zb * zb;
          transformed.y += sin(uWag.x * 0.5 + transformed.z * 3.0 / L) * uWag.y * 0.08 * zt;
        }`
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
