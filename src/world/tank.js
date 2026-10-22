import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { G, patchMaterial, noise3 } from '../fx/shaderPatch.js';

export const TANK = {
  W: 12, D: 5, H: 6.3,
  waterY: 5.6,
  inner: { x: 5.85, z: 2.35 },
};

export function sandHeight(x, z) {
  const back = (-z + TANK.D / 2) / TANK.D; // 0 front -> 1 back
  let h = 0.42 + back * back * 0.55;
  h += noise3(x * 0.6, 0.3, z * 0.7) * 0.07 + noise3(x * 2.1, 1.7, z * 2.3) * 0.025;
  // mounds under decor zones
  h += 0.35 * Math.exp(-((x + 3.9) ** 2 + (z + 0.9) ** 2) / 2.2);
  h += 0.22 * Math.exp(-((x - 3.6) ** 2 + (z + 0.4) ** 2) / 3.0);
  h += 0.18 * Math.exp(-((x - 0.2) ** 2 + (z + 1.5) ** 2) / 1.6);
  return h;
}

function sandTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#b59a6e';
  g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 90000; i++) {
    const x = Math.random() * 1024, y = Math.random() * 1024;
    const r = Math.random() * 1.8 + 0.4;
    const l = 38 + Math.random() * 34;
    const hue = 30 + Math.random() * 20;
    const sat = 20 + Math.random() * 35;
    g.fillStyle = `hsl(${hue},${sat}%,${l}%)`;
    if (Math.random() < 0.04) g.fillStyle = `hsl(${Math.random() * 360},15%,${30 + Math.random() * 30}%)`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // a few pebbles
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * 1024, y = Math.random() * 1024;
    const r = Math.random() * 5 + 2;
    const l = 35 + Math.random() * 40;
    g.fillStyle = `hsl(${20 + Math.random() * 30},${10 + Math.random() * 25}%,${l}%)`;
    g.beginPath(); g.ellipse(x, y, r, r * (0.6 + Math.random() * 0.4), Math.random() * 3, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 1.4);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function noiseNormalTexture(size = 256, freq = 6) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const hgt = (x, y) => {
    const u = (x / size) * Math.PI * 2, v = (y / size) * Math.PI * 2;
    let s = 0;
    for (let k = 1; k <= 4; k++) {
      s += Math.sin(u * freq * k * 0.5 + Math.cos(v * k + k)) * Math.cos(v * freq * k * 0.4 + Math.sin(u * k * 1.3)) / k;
    }
    return s;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = hgt(x + 1, y) - hgt(x - 1, y);
    const dy = hgt(x, y + 1) - hgt(x, y - 1);
    const n = new THREE.Vector3(-dx * 2, -dy * 2, 1).normalize();
    const i = (y * size + x) * 4;
    img.data[i] = (n.x * 0.5 + 0.5) * 255;
    img.data[i + 1] = (n.y * 0.5 + 0.5) * 255;
    img.data[i + 2] = (n.z * 0.5 + 0.5) * 255;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function buildTank(scene) {
  const { W, D, H } = TANK;
  const group = new THREE.Group();
  scene.add(group);
  const out = { group, waterNormal: null, led: null, ledMat: null, backdropMat: null, surface: null, walkables: [] };

  // ---------- Room backdrop (big gradient dome) ----------
  const roomMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uTop: { value: new THREE.Color('#1b2436') }, uBottom: { value: new THREE.Color('#05070c') }, uGlow: { value: new THREE.Color('#2a3d5c') } },
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
    fragmentShader: `uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uGlow; varying vec3 vP;
      void main(){ float h = vP.y*0.5+0.5; vec3 c = mix(uBottom,uTop,smoothstep(0.2,0.9,h));
        float glow = pow(max(dot(vP, normalize(vec3(0.0,0.15,-1.0))),0.0), 6.0);
        c += uGlow*glow*0.8; gl_FragColor = vec4(c,1.0); }`,
  });
  const room = new THREE.Mesh(new THREE.SphereGeometry(80, 48, 24), roomMat);
  scene.add(room);
  out.roomMat = roomMat;

  // ---------- Cabinet ----------
  const woodC = document.createElement('canvas'); woodC.width = 512; woodC.height = 128;
  const wg = woodC.getContext('2d');
  wg.fillStyle = '#3a2a20'; wg.fillRect(0, 0, 512, 128);
  for (let i = 0; i < 160; i++) {
    wg.strokeStyle = `rgba(${90 + Math.random() * 40},${60 + Math.random() * 25},${40 + Math.random() * 20},${0.15 + Math.random() * 0.25})`;
    wg.lineWidth = Math.random() * 2 + 0.5;
    const y = Math.random() * 128;
    wg.beginPath(); wg.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) wg.lineTo(x, y + Math.sin(x * 0.02 + i) * 3);
    wg.stroke();
  }
  const woodTex = new THREE.CanvasTexture(woodC); woodTex.colorSpace = THREE.SRGBColorSpace;
  const cabinetMat = new THREE.MeshPhysicalMaterial({ map: woodTex, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.25, fog: false });
  const cabinet = new THREE.Mesh(new RoundedBoxGeometry(W + 1.2, 3.2, D + 1.2, 6, 0.12), cabinetMat);
  cabinet.position.set(0, -1.75, 0);
  cabinet.receiveShadow = true;
  group.add(cabinet);
  const trimMat = new THREE.MeshStandardMaterial({ color: '#111318', metalness: 0.8, roughness: 0.3, fog: false });
  const trim = new THREE.Mesh(new RoundedBoxGeometry(W + 0.5, 0.18, D + 0.5, 4, 0.06), trimMat);
  trim.position.set(0, -0.08, 0);
  group.add(trim);
  // floor + soft shadow disc
  const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: '#0d1016', roughness: 0.9, fog: false }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -3.35; floor.receiveShadow = true;
  group.add(floor);

  // ---------- Glass ----------
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#e8fbff'), metalness: 0, roughness: 0.02, transmission: 0, opacity: 0.1,
    transparent: true, envMapIntensity: 0.6, specularIntensity: 0.6, clearcoat: 0.3, clearcoatRoughness: 0.02,
    attenuationColor: new THREE.Color('#d8fbf6'), attenuationDistance: 25, fog: false,
  });
  // the glass must not occlude transparent things inside (fins, bubbles, light shafts)
  glassMat.depthWrite = false;
  const t = 0.14;
  const panels = [
    { s: [W, H, t], p: [0, H / 2, D / 2] },
    { s: [W, H, t], p: [0, H / 2, -D / 2] },
    { s: [t, H, D], p: [W / 2, H / 2, 0] },
    { s: [t, H, D], p: [-W / 2, H / 2, 0] },
  ];
  out.glassPanels = [];
  for (const pd of panels) {
    // flat-edged panels: rounded edges catch a razor-sharp sun glint that blooms into a blob
    const m = new THREE.Mesh(new THREE.BoxGeometry(...pd.s), glassMat);
    m.position.set(...pd.p);
    m.renderOrder = 2;
    group.add(m);
    out.glassPanels.push(m);
  }
  // Glass edge (green tint of thick glass) + silicone seams
  const edgeMat = new THREE.MeshPhysicalMaterial({ color: '#7fd9c4', transparent: true, opacity: 0.35, roughness: 0.1, fog: false });
  const sealMat = new THREE.MeshStandardMaterial({ color: '#0b0d10', roughness: 0.6, fog: false });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const seal = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, H, 12), sealMat);
    seal.position.set(sx * (W / 2 - 0.06), H / 2, sz * (D / 2 - 0.06));
    group.add(seal);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.03, H, 0.03), edgeMat);
    edge.position.set(sx * (W / 2 + 0.07), H / 2, sz * (D / 2 + 0.07));
    group.add(edge);
  }
  // Bottom glass/base frame
  const baseFrame = new THREE.Mesh(new RoundedBoxGeometry(W + 0.3, 0.22, D + 0.3, 4, 0.08), trimMat);
  baseFrame.position.set(0, 0.03, 0);
  group.add(baseFrame);

  // ---------- Lid + LED ----------
  const lid = new THREE.Group();
  const lidMat = new THREE.MeshPhysicalMaterial({ color: '#15181e', metalness: 0.3, roughness: 0.55, clearcoat: 0.2, clearcoatRoughness: 0.5, envMapIntensity: 0.12, fog: false });
  const lidRim = new THREE.Mesh(new RoundedBoxGeometry(W + 0.32, 0.16, D + 0.32, 4, 0.06), lidMat);
  lidRim.position.y = H + 0.02;
  lid.add(lidRim);
  // frosted cover plate: hides the bare LED from inside (it otherwise smears into a hot blob through the glass)
  const cover = new THREE.Mesh(new THREE.BoxGeometry(W - 0.1, 0.03, D - 0.1), new THREE.MeshStandardMaterial({ color: '#1d2a33', roughness: 0.6, emissive: new THREE.Color('#9fe6ff'), emissiveIntensity: 0.06, fog: false }));
  cover.position.y = H + 0.06;
  lid.add(cover);
  out.cover = cover;
  // LED bar on legs
  const ledBody = new THREE.Mesh(new RoundedBoxGeometry(W - 0.6, 0.18, 1.1, 4, 0.08), lidMat);
  ledBody.position.set(0, H + 0.55, 0);
  lid.add(ledBody);
  const ledMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: new THREE.Color('#e8fbff'), emissiveIntensity: 3.0, fog: false });
  const ledStrip = new THREE.Mesh(new THREE.BoxGeometry(W - 0.9, 0.03, 0.75), ledMat);
  ledStrip.position.set(0, H + 0.45, 0);
  lid.add(ledStrip);
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.9), lidMat);
    leg.position.set(sx * (W / 2 - 0.4), H + 0.3, 0);
    lid.add(leg);
  }
  // small blue moon-LEDs
  const moonLeds = [];
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), new THREE.MeshBasicMaterial({ color: '#5aa7ff', fog: false }));
    m.position.set(-W / 2 + 0.8 + i * ((W - 1.6) / 11), H + 0.44, 0.42);
    lid.add(m);
    moonLeds.push(m);
  }
  group.add(lid);
  out.ledMat = ledMat;
  out.moonLeds = moonLeds;

  // ---------- Filter (inside, back-right corner) ----------
  const filterMat = patchMaterial(new THREE.MeshPhysicalMaterial({ color: '#2b3540', roughness: 0.35, metalness: 0.2, clearcoat: 0.7 }), { caustics: 0.5 });
  const filter = new THREE.Group();
  const fBody = new THREE.Mesh(new RoundedBoxGeometry(0.55, 4.6, 0.4, 4, 0.12), filterMat);
  fBody.position.y = 2.9;
  filter.add(fBody);
  const slotMat = new THREE.MeshStandardMaterial({ color: '#0d1116', roughness: 0.8 });
  for (let i = 0; i < 9; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.02), slotMat);
    s.position.set(0, 1.2 + i * 0.22, 0.21);
    filter.add(s);
  }
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.4, 16), filterMat);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(0, 5.05, 0.35);
  filter.add(nozzle);
  filter.position.set(5.35, 0, -1.95);
  group.add(filter);
  out.filterOutlet = new THREE.Vector3(5.35, 5.05, -1.45);
  out.filterIntake = new THREE.Vector3(5.35, 1.6, -1.6);

  // ---------- Backdrop (deep painted background inside back glass) ----------
  const backdropMat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: { uTime: G.uTime, uDeep: { value: new THREE.Color('#06324a') }, uTop: { value: new THREE.Color('#1aa0b8') }, uNight: G.uNight },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
    fragmentShader: `uniform float uTime; uniform vec3 uDeep; uniform vec3 uTop; uniform float uNight; varying vec2 vUv;
      float hsh(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
      float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hsh(i),hsh(i+vec2(1,0)),f.x), mix(hsh(i+vec2(0,1)),hsh(i+vec2(1,1)),f.x), f.y); }
      void main(){
        vec2 uv = vUv;
        vec3 c = mix(uDeep, uTop, pow(uv.y, 1.4));
        // distant rays
        float r = 0.0;
        for (int i=0;i<3;i++){ float fi=float(i); r += smoothstep(0.55,1.0, n2(vec2(uv.x*6.0 + uv.y*1.5 + fi*7.0, uTime*0.08 + fi))) ; }
        c += vec3(0.4,0.8,0.9) * r * 0.12 * uv.y * (1.0-uNight*0.8);
        // silhouettes of far plants / rocks
        float hill = 0.18 + 0.08*sin(uv.x*7.0) + 0.05*sin(uv.x*17.0+1.0) + 0.03*n2(vec2(uv.x*30.0,1.0));
        float stems = 0.0;
        for (int i=0;i<14;i++){ float fi=float(i); float x = fract(fi*0.137+0.05)+0.02*sin(uTime*0.3+fi+uv.y*4.0);
          float w = 0.004 + 0.004*fract(fi*0.71); float hh = 0.3 + 0.35*fract(fi*0.433);
          stems = max(stems, (1.0-smoothstep(w, w*2.5, abs(uv.x - x - uv.y*0.03*sin(fi)))) * step(uv.y, hh)); }
        float sil = max(1.0 - smoothstep(hill-0.01, hill+0.01, uv.y), stems*0.7);
        c = mix(c, uDeep*0.45, sil*0.75);
        c *= mix(1.0, 0.25, uNight);
        c += vec3(0.0, 0.02, 0.06)*uNight;
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.1, H - 0.2), backdropMat);
  backdrop.position.set(0, H / 2, -D / 2 - 0.12);
  group.add(backdrop);
  out.backdropMat = backdropMat;

  // ---------- Sand ----------
  const sandGeo = new THREE.PlaneGeometry(W - 0.15, D - 0.15, 240, 100);
  sandGeo.rotateX(-Math.PI / 2);
  const pa = sandGeo.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), z = pa.getZ(i);
    let y = sandHeight(x, z);
    // ripples
    y += Math.sin(x * 5.0 + Math.sin(z * 2.0) * 1.5) * 0.012;
    pa.setY(i, y);
  }
  sandGeo.computeVertexNormals();
  const sandMat = patchMaterial(new THREE.MeshStandardMaterial({ map: sandTexture(), roughness: 0.92, metalness: 0, normalMap: noiseNormalTexture(256, 14), normalScale: new THREE.Vector2(0.4, 0.4) }), { caustics: 1.3 });
  sandMat.normalMap.repeat.set(6, 3);
  const sand = new THREE.Mesh(sandGeo, sandMat);
  sand.receiveShadow = true;
  group.add(sand);
  out.sand = sand;
  // sand side "wall" visible through front glass (cross-section layer)
  const sideMat = new THREE.MeshStandardMaterial({ color: '#b89a6a', roughness: 1 });
  const front = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.15, 0.5, 120, 1), sideMat);
  const fpa = front.geometry.attributes.position;
  for (let i = 0; i < fpa.count; i++) {
    const x = fpa.getX(i);
    const top = sandHeight(x, D / 2 - 0.08);
    fpa.setY(i, fpa.getY(i) > 0 ? top : 0.1);
  }
  front.position.set(0, 0, D / 2 - 0.08);
  group.add(front);

  // ---------- Water surface ----------
  const waterNormal = noiseNormalTexture(256, 4);
  waterNormal.repeat.set(3, 1.5);
  const surfMat = new THREE.MeshPhysicalMaterial({
    color: '#2aa8bf', roughness: 0.04, metalness: 0, transmission: 0.0, transparent: true, opacity: 0.24,
    emissive: new THREE.Color('#0b4a5a'), emissiveIntensity: 0.5,
    normalMap: waterNormal, normalScale: new THREE.Vector2(0.8, 0.8), side: THREE.DoubleSide, envMapIntensity: 0.3,
    ior: 1.33, depthWrite: false, fog: false,
  });
  const surfGeo = new THREE.PlaneGeometry(W - 0.15, D - 0.15, 96, 40);
  surfGeo.rotateX(-Math.PI / 2);
  const surface = new THREE.Mesh(surfGeo, surfMat);
  surface.position.y = TANK.waterY;
  surface.renderOrder = 3;
  group.add(surface);
  out.surface = surface;
  out.waterNormal = waterNormal;
  out.surfaceBase = Float32Array.from(surfGeo.attributes.position.array);

  // thin meniscus line where water meets glass (bright)
  const menMat = new THREE.MeshBasicMaterial({ color: '#cff8ff', transparent: true, opacity: 0.35, fog: false, blending: THREE.AdditiveBlending, depthWrite: false });
  const men = new THREE.Mesh(new THREE.BoxGeometry(W - 0.14, 0.025, 0.01), menMat);
  men.position.set(0, TANK.waterY, D / 2 - 0.08);
  group.add(men);

  return out;
}

export function updateTank(tank, t, dt) {
  tank.waterNormal.offset.x = t * 0.012;
  tank.waterNormal.offset.y = Math.sin(t * 0.1) * 0.03;
  const pa = tank.surface.geometry.attributes.position;
  const base = tank.surfaceBase;
  for (let i = 0; i < pa.count; i++) {
    const x = base[i * 3], z = base[i * 3 + 2];
    let y = Math.sin(x * 1.3 + t * 1.1) * 0.025 + Math.sin(z * 2.1 - t * 1.4 + x * 0.4) * 0.02 + Math.sin((x + z) * 3.3 + t * 2.2) * 0.008;
    // filter outlet turbulence
    const dx = x - 5.3, dz = z + 1.4;
    y += Math.sin(t * 7 + Math.sqrt(dx * dx + dz * dz) * 9) * 0.03 * Math.exp(-(dx * dx + dz * dz) * 1.3);
    // ripples (from taps / food)
    for (const r of tank.ripples || []) {
      const d = Math.hypot(x - r.x, z - r.z);
      const age = t - r.t;
      y += Math.sin((d - age * 2.2) * 9) * 0.05 * Math.exp(-Math.abs(d - age * 2.2) * 3) * Math.exp(-age * 1.2);
    }
    pa.setY(i, y);
  }
  pa.needsUpdate = true;
  tank.surface.geometry.computeVertexNormals();
  if (tank.ripples) tank.ripples = tank.ripples.filter((r) => t - r.t < 4);
}
