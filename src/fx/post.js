import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Removes NaN/Inf pixels before bloom so a single bad sample can't flare into a blob
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      bool bad = any(isnan(c.rgb)) || any(isinf(c.rgb));
      gl_FragColor = vec4(bad ? vec3(0.0) : min(c.rgb, vec3(40.0)), 1.0);
    }`,
};

// Depth of field from the depth the main pass already wrote (no second scene render): each
// out-of-focus pixel gathers a golden-angle disc whose radius grows with the distance from focus.
const DofShader = {
  uniforms: {
    tColor: { value: null }, tDepth: { value: null }, focus: { value: 12 }, aperture: { value: 0.001 },
    maxblur: { value: 0.006 }, aspect: { value: 1 }, near: { value: 0.1 }, far: { value: 100 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    #include <packing>
    uniform sampler2D tColor, tDepth; uniform float focus, aperture, maxblur, aspect, near, far;
    varying vec2 vUv;
    float coc(vec2 uv) {
      float z = -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, near, far);
      return min(abs(z - focus) * aperture, maxblur);
    }
    void main() {
      vec4 c0 = texture2D(tColor, vUv);
      float r0 = coc(vUv);
      if (r0 < 0.0004) { gl_FragColor = c0; return; }
      vec3 acc = c0.rgb; float wsum = 1.0;
      for (int i = 0; i < 20; i++) {
        float fi = float(i) + 0.5;
        float rr = sqrt(fi / 20.0) * r0;
        vec2 uv = vUv + vec2(cos(fi * 2.39996) / aspect, sin(fi * 2.39996)) * rr;
        // a sample only spreads this far if it is blurred that much itself (keeps sharp edges)
        float w = clamp(coc(uv) / max(rr, 1e-5), 0.0, 1.0);
        acc += texture2D(tColor, uv).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(acc / wsum, c0.a);
    }`,
};

class DofPass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({ ...DofShader, uniforms: THREE.UniformsUtils.clone(DofShader.uniforms) });
    this.uniforms = this.material.uniforms;
    this.fsQuad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms;
    u.tColor.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    u.near.value = this.camera.near;
    u.far.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uLetter: { value: 0 }, uFade: { value: 0 }, uUnder: { value: 0 },
    uVignette: { value: 0.9 }, uChroma: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uLetter, uFade, uUnder, uVignette, uChroma; uniform vec2 uRes;
    varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      // underwater wobble when the camera is inside the tank
      uv += uUnder * vec2(sin(uv.y * 18.0 + uTime * 1.3), cos(uv.x * 14.0 + uTime * 1.1)) * 0.0022;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * 0.012 * uChroma;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + off).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - off).b;
      // gentle teal-orange grade & underwater tint
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, col * vec3(1.03, 1.0, 0.97), smoothstep(0.2, 0.9, l));
      col = mix(col, col * vec3(0.9, 1.0, 1.06), smoothstep(0.5, 0.0, l) * 0.6);
      col = mix(col, col * vec3(0.75, 0.95, 1.08) + vec3(0.0, 0.01, 0.02), uUnder * 0.5);
      // vignette
      float vig = smoothstep(0.85, 0.2, r2 * 1.6 * uVignette);
      col *= mix(0.55, 1.0, vig);
      // fine grain
      col += (h(uv * uRes + fract(uTime)) - 0.5) * 0.012;
      // letterbox & fade
      float bars = 0.115 * uLetter;
      if (vUv.y < bars || vUv.y > 1.0 - bars) col *= 0.0;
      col *= 1.0 - uFade;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export function buildPost(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  // the scene's depth stays available to the depth of field pass
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(size.x, size.y) });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bokeh = new DofPass(camera);
  bokeh.enabled = false;
  composer.addPass(bokeh);
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.38, 0.55, 0.92);
  composer.addPass(bloom);
  // bloom can run at reduced internal resolution (big fill-rate saving, looks almost identical)
  let bloomScale = 0.5, lastW = size.x, lastH = size.y;
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => { lastW = w; lastH = h; bloomSetSize(Math.max(1, Math.round(w * bloomScale)), Math.max(1, Math.round(h * bloomScale))); };
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  composer.addPass(new OutputPass());
  return {
    composer, bokeh, bloom, grade,
    setBloomScale(s) { bloomScale = s; bloom.setSize(lastW, lastH); },
    setSamples(n) {
      for (const t of [composer.renderTarget1, composer.renderTarget2]) { t.samples = n; t.dispose(); }
    },
    setSize(w, h) {
      composer.setSize(w, h);
      bokeh.uniforms.aspect.value = w / h;
      grade.uniforms.uRes.value.set(w, h);
    },
  };
}
