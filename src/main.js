import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { G, rand } from './fx/shaderPatch.js';
import { buildTank, updateTank, TANK } from './world/tank.js';
import { buildDecor, updateDecor } from './world/decor.js';
import { buildPlants, finishMoss, updatePlants } from './world/plants.js';
import { DayCycle } from './world/daycycle.js';
import { mergeStatic } from './world/mergeStatic.js';
import { Bubbles, buildDust, buildGodRays } from './fx/particles.js';
import { buildPost } from './fx/post.js';
import { Director } from './fx/director.js';
import { AquaAudio } from './fx/audio.js';
import { Ecosystem } from './life/ecosystem.js';
import { UI } from './ui/ui.js';

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // refreshed manually, see quality.shadowEvery
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2('#1b7890', 0.03);
const pmrem = new THREE.PMREMGenerator(renderer);
// soft studio environment: gradient dome + broad overhead softbox, no hot spots
const envScene = new THREE.Scene();
envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), new THREE.ShaderMaterial({
  side: THREE.BackSide,
  vertexShader: 'varying vec3 vN; void main(){ vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `varying vec3 vN; void main(){
    float y = vN.y;
    vec3 c = mix(vec3(0.03, 0.035, 0.05), vec3(0.45, 0.6, 0.7), smoothstep(-0.3, 0.9, y));
    c += vec3(1.0, 0.97, 0.9) * pow(max(y, 0.0), 6.0) * 1.2;
    c += vec3(0.2, 0.45, 0.6) * pow(max(dot(vN, normalize(vec3(0.0, 0.2, -1.0))), 0.0), 4.0) * 0.4;
    gl_FragColor = vec4(c, 1.0); }`,
})));
scene.environment = pmrem.fromScene(envScene, 0.03).texture;
scene.background = new THREE.Color('#05070c');

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, 3.3, 14.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 2.6, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 0.8;
controls.maxDistance = 26;
controls.maxPolarAngle = Math.PI * 0.62;
controls.rotateSpeed = 0.6;
controls.zoomSpeed = 0.8;

// ------------------------------------------------------------------ lights
const sun = new THREE.DirectionalLight('#fff1db', 3.4);
sun.position.set(2.5, 14, 3.5);
sun.target.position.set(0, 0, 0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 5, bottom: -5, near: 4, far: 20 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 4;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight('#c9efff', '#4a3a24', 1.0);
scene.add(hemi);
const moon = new THREE.SpotLight('#5a7dff', 0, 16, 0.6, 0.8, 1.2);
moon.position.set(-2, 11, 2);
moon.target.position.set(0, 0.5, 0);
scene.add(moon, moon.target);
const fill = new THREE.DirectionalLight('#9fdfff', 0.6);
fill.position.set(-14, 4, 2); // from the side: a frontal fill glints on the front glass
scene.add(fill);

// ------------------------------------------------------------------ world
const tank = buildTank(scene);
const decor = buildDecor(scene);
const plants = buildPlants(scene);
scene.updateMatrixWorld(true);
const bubbles = new Bubbles(scene);
const dust = buildDust(scene);
const rays = buildGodRays(scene);
const eco = new Ecosystem(scene, decor, plants, bubbles, tank);
finishMoss(plants, eco);
// bake static scenery into a handful of meshes (draw calls are the main cost)
const mergedDecor = mergeStatic(decor.group, [decor.chest.group, decor.duck, ...decor.interactive.map((i) => i.mesh)]);
const mergedTank = mergeStatic(tank.group, [tank.surface, ...tank.glassPanels]);
console.info('static merge:', mergedDecor, mergedTank);
// transparent double-sided materials would otherwise be drawn in two passes
scene.traverse((o) => { const m = o.material; if (m && m.transparent && m.side === THREE.DoubleSide) m.forceSinglePass = true; });
// soften image-based light a little so the underwater lighting reads clearly
scene.traverse((o) => {
  const m = o.material;
  if (m && m.isMeshStandardMaterial && m.envMapIntensity === 1 && !m.transmission) m.envMapIntensity = 0.5;
});

const post = buildPost(renderer, scene, camera);
post.setSize(window.innerWidth, window.innerHeight);
const director = new Director(camera, controls, eco, post);
const audio = new AquaAudio();
const dayCtx = { sun, hemi, moon, fill, scene, tank, renderer, rays, dust, plants, decor, exposureMul: 1 };
const day = new DayCycle(dayCtx);

bubbles.popCb = (b) => {
  if (b.r > 0.02 && Math.random() < 0.3) (tank.ripples ||= []).push({ x: b.pos.x, z: b.pos.z, t: eco.time });
  if (Math.random() < 0.25) audio.pop(b.pos.x);
};

// selection halo
const halo = new THREE.Mesh(
  new THREE.RingGeometry(0.9, 1.0, 48),
  new THREE.MeshBasicMaterial({ color: '#9feaff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
);
halo.renderOrder = 9;
scene.add(halo);

// ------------------------------------------------------------------ quality presets
const QUALITY = {
  low: { pr: 0.75, msaa: 0, shadowEvery: 3, bloom: 0.35, dust: 0.4 },
  medium: { pr: 1, msaa: 2, shadowEvery: 2, bloom: 0.5, dust: 0.7 },
  high: { pr: 1, msaa: 4, shadowEvery: 1, bloom: 0.75, dust: 1 },
  ultra: { pr: 'dpr', msaa: 4, shadowEvery: 1, bloom: 1, dust: 1 },
};

// ------------------------------------------------------------------ app facade
const app = {
  eco, director, audio, post, day, dayCtx, selected: null, mode: 'free',
  feed() {
    eco.feed();
    audio.sprinkle();
  },
  setMode(m) {
    if (m === this.mode && m !== 'free') m = 'free';
    this.mode = m;
    document.body.classList.toggle('immersive', m === 'observe' || m === 'cinematic');
    if (m === 'observe' || m === 'cinematic') {
      ui.hideCard();
      for (const p of Object.values(ui.panels)) p.classList.remove('open');
      director.setMode(m);
    } else {
      director.setMode(this.selected ? 'follow' : 'free');
      if (this.selected) director.follow(this.selected);
      else director.flyTo(new THREE.Vector3(0, 3.3, 14.5), new THREE.Vector3(0, 2.6, 0), 2.5);
    }
  },
  select(obj) {
    this.selected = obj;
    if (!obj) { ui.hideCard(); director.unfollow(); return; }
    if (this.mode !== 'free') this.setMode('free');
    ui.showCard(obj);
    director.follow(obj);
    audio.chime();
  },
  quality: null,
  setQuality(name) {
    const Q = QUALITY[name] || QUALITY.medium;
    this.quality = { name, ...Q };
    renderer.setPixelRatio(Q.pr === 'dpr' ? Math.min(window.devicePixelRatio, 2) : Q.pr);
    post.composer.setPixelRatio(renderer.getPixelRatio());
    post.setSamples(Q.msaa);
    post.setBloomScale(Q.bloom);
    dust.pts.geometry.setDrawRange(0, Math.floor(dust.count * Q.dust));
    renderer.shadowMap.needsUpdate = true;
    try { localStorage.setItem('aq.quality', name); } catch (e) { /* ignore */ }
    onResize();
  },
};
const ui = new UI(app);
eco.onStory((s) => { ui.story(s); director.onStory(s); if (s.rare) audio.chime(); });

// ------------------------------------------------------------------ input
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const pickables = [];
for (const f of eco.fish) pickables.push(f.body);
for (const c of eco.critters) c.root.traverse((o) => o.isMesh && pickables.push(o));
const props = [];
for (const it of decor.interactive) it.mesh.traverse((o) => { if (o.isMesh) { o.userData.prop = it.kind; props.push(o); } });
const frontPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(TANK.D / 2));
let hover = null, lastMove = 0, downPos = null;

function setNdc(e) {
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
function pickCreature() {
  const vis = pickables.filter((m) => { const f = m.userData.fish; return !(f && f.hidden); });
  const hit = ray.intersectObjects(vis, false)[0];
  if (!hit) return null;
  return hit.object.userData.fish || hit.object.userData.critter || null;
}
function tankPoint() {
  // where the pointer meets the aquarium: front glass if outside, else a point ahead
  const p = new THREE.Vector3();
  const inside = Math.abs(camera.position.z) < TANK.D / 2;
  if (!inside && ray.ray.intersectPlane(frontPlane, p) && Math.abs(p.x) < TANK.W / 2 && p.y > 0.3 && p.y < TANK.waterY) return p;
  if (inside) return ray.ray.at(2.5, p);
  return null;
}

renderer.domElement.addEventListener('pointermove', (e) => {
  if (app.mode === 'observe' || app.mode === 'cinematic') return;
  setNdc(e);
  hover = pickCreature();
  ui.setHover(hover, e.clientX, e.clientY);
  document.body.classList.toggle('hovering', !!hover);
  const p = tankPoint();
  if (p) {
    eco.cursor.point.copy(p);
    eco.cursor.point.z = Math.min(p.z, TANK.D / 2 - 0.35);
    eco.cursor.active = true;
    lastMove = performance.now();
  } else eco.cursor.active = false;
});
renderer.domElement.addEventListener('pointerleave', () => { eco.cursor.active = false; ui.setHover(null); });
renderer.domElement.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; audio.start(); });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 6) return;
  if (app.mode === 'observe' || app.mode === 'cinematic') return;
  setNdc(e);
  const c = pickCreature();
  if (c) { app.select(c); return; }
  const ph = ray.intersectObjects(props, false)[0];
  if (ph) { eco.clickProp(ph.object.userData.prop); audio.chime(); return; }
  const gh = ray.intersectObjects(tank.glassPanels, false)[0];
  if (gh) {
    const p = gh.point.clone();
    p.x = THREE.MathUtils.clamp(p.x, -5.6, 5.6); p.z = THREE.MathUtils.clamp(p.z, -2.1, 2.1); p.y = THREE.MathUtils.clamp(p.y, 0.6, 5.3);
    eco.tap(p);
    audio.tap();
    tapFlash(gh.point);
    return;
  }
  if (app.selected) app.select(null);
});
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') { if (app.mode !== 'free') app.setMode('free'); else app.select(null); }
  if (e.key === 'f' || e.key === 'а') app.feed();
  if (e.key === 'c' || e.key === 'с') app.setMode('cinematic');
  if (e.key === 'o' || e.key === 'щ') app.setMode('observe');
  if (e.key === 'h' || e.key === 'р') document.body.classList.toggle('immersive');
});

// tap flash on the glass
const flashes = [];
const flashMat = new THREE.MeshBasicMaterial({ color: '#d8f8ff', transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
function tapFlash(p) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.05, 32), flashMat.clone());
  m.position.copy(p);
  m.position.z += 0.08 * Math.sign(camera.position.z - p.z);
  m.lookAt(camera.position);
  scene.add(m);
  flashes.push({ m, t: 0 });
}

// ------------------------------------------------------------------ resize
function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  post.setSize(w, h);
}
window.addEventListener('resize', onResize);

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
let frameNo = 0;
let savedQ = 'medium';
try { savedQ = localStorage.getItem('aq.quality') || 'medium'; } catch (e) { /* ignore */ }
app.setQuality(savedQ);
let first = true;
// let the world run for a few seconds "off camera" so it is alive at first sight
for (let i = 0; i < 90; i++) { eco.update(1 / 30); bubbles.update(1 / 30, i / 30); }

const fpsEl = document.createElement('div');
fpsEl.className = 'fps';
document.body.appendChild(fpsEl);
const gl = renderer.getContext();
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
const software = /swiftshader|llvmpipe|software|basic render/i.test(gpu);
console.info('GPU:', gpu);
let fpsN = 0, fpsT = performance.now();
renderer.info.autoReset = false;
let showFps = true;
try { showFps = localStorage.getItem('aq.fps') !== '0'; } catch (e) { /* ignore */ }
fpsEl.classList.toggle('hidden', !showFps);
app.setFps = (v) => { showFps = v; fpsEl.classList.toggle('hidden', !v); try { localStorage.setItem('aq.fps', v ? '1' : '0'); } catch (e) { /* ignore */ } };
app.showFps = () => showFps;

function frame() {
  fpsN++;
  if (performance.now() - fpsT > 1000) {
    const inf = renderer.info.render;
    fpsEl.textContent = `${fpsN} fps · ${inf.calls} calls · ${(inf.triangles / 1e6).toFixed(2)}M tris · ${gpu.replace(/ANGLE \((.*)\)/, '$1').slice(0, 60)}${software ? ' — ПРОГРАММНЫЙ РЕНДЕР! включите аппаратное ускорение в браузере' : ''}`;
    fpsEl.classList.toggle('warn', software);
    fpsN = 0; fpsT = performance.now();
  }
  const dt = Math.min(clock.getDelta(), 1 / 20);
  G.uTime.value += dt;
  const t = G.uTime.value;
  G.uCurrent.value.set(Math.sin(t * 0.05) * 0.03 + Math.sin(t * 0.13) * 0.015, Math.cos(t * 0.04) * 0.02);

  const c = day.update(dt);
  eco.night = c.night;
  audio.night = c.night;
  eco.cameraPos.copy(camera.position);
  eco.update(dt);
  if (eco.cursor.active && performance.now() - lastMove > 3500) eco.cursor.active = false;

  updateTank(tank, t, dt);
  updateDecor(decor, t, dt, c.night);
  updatePlants(plants, t, c.night);
  bubbles.update(dt, t);
  rays.update(camera);
  director.update(dt);
  post.grade.uniforms.uTime.value = t;

  // halo around the selected creature
  const s = app.selected;
  if (s && !s.hidden && app.mode !== 'observe' && app.mode !== 'cinematic') {
    halo.position.copy(s.pos);
    halo.lookAt(camera.position);
    const sc = (s.size || 0.15) * 0.9 + 0.12 + Math.sin(t * 3) * 0.01;
    halo.scale.setScalar(sc);
    halo.material.opacity += (0.35 - halo.material.opacity) * 0.1;
  } else halo.material.opacity *= 0.9;

  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    f.t += dt;
    f.m.scale.setScalar(1 + f.t * 14);
    f.m.material.opacity = 0.5 * (1 - f.t / 0.6);
    if (f.t > 0.6) { scene.remove(f.m); f.m.geometry.dispose(); flashes.splice(i, 1); }
  }

  ui.update();
  if (++frameNo % app.quality.shadowEvery === 0) renderer.shadowMap.needsUpdate = true;
  renderer.info.reset();
  post.composer.render(dt);

  if (first) {
    first = false;
    setTimeout(() => {
      document.getElementById('loader').classList.add('gone');
      setTimeout(() => ui.hint('Кликните по стеклу, наведите на рыбку или нажмите «Кормить»'), 1800);
    }, 300);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// expose for tinkering in the console
window.aquarium = { app, eco, scene, camera, renderer };
