import * as THREE from 'three';
import { G, rand, pick } from './shaderPatch.js';
import { TANK } from '../world/tank.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();

// ======================================================= BUBBLES
export class Bubbles {
  constructor(scene, max = 700) {
    this.max = max;
    const mat = new THREE.MeshPhysicalMaterial({
      color: '#ffffff', roughness: 0, metalness: 0, transparent: true, opacity: 0.32, iridescence: 1, iridescenceIOR: 1.3,
      iridescenceThicknessRange: [100, 500], envMapIntensity: 2.5, depthWrite: false, specularIntensity: 1, clearcoat: 1,
    });
    // fresnel rim so bubbles read as hollow
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
        float fr = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 3.0);
        outgoingLight += vec3(0.75, 0.95, 1.0) * fr * 0.9;
        diffuseColor.a = clamp(diffuseColor.a * 0.4 + fr * 0.9, 0.0, 1.0);
        #include <opaque_fragment>`);
    };
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
    this.list = [];
    this.sources = [];
    this.popCb = null;
    this.frame = 0;
  }
  addSource(name, pos, rate, rMin, rMax, spread = 0.03) {
    const s = { name, pos: pos.clone(), rate, rMin, rMax, spread, acc: 0, burst: 0 };
    this.sources.push(s);
    return s;
  }
  spawn(pos, r, vel) {
    if (this.list.length >= this.max) return null;
    const b = { pos: pos.clone(), vel: vel ? vel.clone() : new THREE.Vector3(0, 0.1, 0), r, ph: Math.random() * 10, wob: rand(0.5, 1.5), age: 0 };
    this.list.push(b);
    return b;
  }
  burst(pos, n = 20, rMin = 0.01, rMax = 0.05, spread = 0.15) {
    for (let i = 0; i < n; i++) this.spawn(_p.copy(pos).add(new THREE.Vector3(rand(-spread, spread), rand(0, spread), rand(-spread, spread))), rand(rMin, rMax), new THREE.Vector3(rand(-0.2, 0.2), rand(0.1, 0.5), rand(-0.2, 0.2)));
  }
  nearest(pos, maxD) {
    let best = null, bd = maxD * maxD;
    for (const b of this.list) { const d = b.pos.distanceToSquared(pos); if (d < bd) { bd = d; best = b; } }
    return best;
  }
  poke(b, dir) {
    b.vel.addScaledVector(dir, 0.6);
    if (b.r > 0.025 && Math.random() < 0.08) {
      b.r /= 1.26;
      this.spawn(b.pos.clone().add(new THREE.Vector3(b.r, 0, 0)), b.r, b.vel.clone().add(new THREE.Vector3(0.2, 0, 0)));
    }
  }
  update(dt, t) {
    for (const s of this.sources) {
      if (s.rate <= 0 && s.burst <= 0) continue;
      s.acc += dt * (s.rate + (s.burst > 0 ? 40 : 0));
      s.burst -= dt;
      while (s.acc > 1) {
        s.acc -= 1;
        this.spawn(_p.copy(s.pos).add(new THREE.Vector3(rand(-s.spread, s.spread), 0, rand(-s.spread, s.spread))), rand(s.rMin, s.rMax), s.vel);
      }
    }
    const top = TANK.waterY;
    const L = this.list;
    this.frame++;
    for (let i = L.length - 1; i >= 0; i--) {
      const b = L[i];
      b.age += dt;
      const term = 0.35 + b.r * 9;
      b.vel.y += (term - b.vel.y) * Math.min(1, dt * 2.5);
      b.vel.x *= 1 - dt * 1.5; b.vel.z *= 1 - dt * 1.5;
      b.ph += dt * (6 + b.r * 40) * b.wob;
      b.pos.addScaledVector(b.vel, dt);
      b.pos.x += Math.sin(b.ph) * dt * (0.05 + b.r * 2) + G.uCurrent.value.x * dt * 3;
      b.pos.z += Math.cos(b.ph * 0.8) * dt * (0.04 + b.r * 1.5);
      // filter current pushes bubbles near the outlet
      if (b.pos.x > 4.2 && b.pos.y > 4.4) b.pos.x -= dt * 0.6;
      if (b.r > 0.07 && Math.random() < dt * 0.6) {
        b.r /= 1.26;
        this.spawn(b.pos.clone().add(new THREE.Vector3(b.r * 1.2, 0, 0)), b.r, new THREE.Vector3(0.15, b.vel.y, 0));
      }
      if (b.pos.y > top - b.r * 0.5) {
        if (this.popCb) this.popCb(b);
        L.splice(i, 1);
      }
    }
    // merging (cheap, every other frame)
    if (this.frame % 2 === 0) {
      L.sort((p, q) => p.pos.y - q.pos.y);
      for (let i = 0; i < L.length; i++) {
        const a = L[i];
        for (let j = i + 1; j < L.length; j++) {
          const b = L[j];
          const rr = (a.r + b.r) * 0.85;
          if (b.pos.y - a.pos.y > 0.2) break;
          if (a.pos.distanceToSquared(b.pos) < rr * rr) {
            a.r = Math.cbrt(a.r ** 3 + b.r ** 3);
            a.vel.add(b.vel).multiplyScalar(0.5);
            L.splice(j, 1); j--;
          }
        }
      }
    }
    for (let i = 0; i < L.length; i++) {
      const b = L[i];
      const sq = 1 + Math.sin(b.ph * 1.7) * 0.08 * Math.min(1, b.r * 30);
      _s.set(b.r * sq, b.r / sq * 0.92, b.r * sq);
      _m.compose(b.pos, _q.identity(), _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = L.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ======================================================= DUST / SUSPENSION
export function buildDust(scene, count = 5000) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rand(-5.9, 5.9); pos[i * 3 + 1] = rand(0.4, 5.6); pos[i * 3 + 2] = rand(-2.4, 2.4);
    seed[i] = Math.random();
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: G.uTime, uRay: { value: 1 }, uColor: { value: new THREE.Color('#d8f4ff') }, uPx: { value: window.devicePixelRatio } },
    vertexShader: `
      uniform float uTime; uniform float uPx; attribute float seed; varying float vA; varying float vS;
      void main(){
        vec3 p = position;
        float t = uTime * (0.05 + seed * 0.05);
        p.x += sin(t * 3.1 + seed * 40.0) * 0.25 + sin(uTime*0.02 + seed*10.0)*0.4;
        p.y += sin(t * 2.3 + seed * 13.0) * 0.18 - mod(uTime * 0.01 * seed, 0.5);
        p.z += cos(t * 2.7 + seed * 27.0) * 0.2;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float big = step(0.985, seed);
        float sz = mix(1.2 + seed * 2.0, 10.0 + seed * 10.0, big);
        gl_PointSize = sz * uPx * (10.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
        // brighter inside light shafts
        float ray = 0.5 + 0.5 * sin(p.x * 1.3 + p.y * 0.35 + uTime * 0.15) * sin(p.x * 0.7 - uTime * 0.11 + p.z);
        vA = (0.25 + ray * 0.9) * mix(1.0, 0.18, big) * smoothstep(0.2, 1.5, p.y);
        vS = big;
      }`,
    fragmentShader: `
      uniform float uRay; uniform vec3 uColor; varying float vA; varying float vS;
      void main(){
        vec2 c = gl_PointCoord - 0.5; float d = length(c);
        float a = mix(smoothstep(0.5, 0.0, d), smoothstep(0.5, 0.35, d) * 0.6 + smoothstep(0.35, 0.0, d) * 0.4, vS);
        gl_FragColor = vec4(uColor * a * vA * uRay, 1.0);
      }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 7;
  scene.add(pts);
  return { pts, mat, count };
}

// ======================================================= GOD RAYS
export function buildGodRays(scene) {
  const group = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: G.uTime, uInt: { value: 1 }, uColor: { value: new THREE.Color('#bff6ff') } },
    vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform float uTime; uniform float uInt; uniform vec3 uColor; varying vec2 vUv; varying vec3 vW;
      float hsh(float n){ return fract(sin(n)*43758.5453); }
      float n1(float x){ float i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f); return mix(hsh(i), hsh(i+1.0), f); }
      void main(){
        float x = vUv.x;
        float streak = n1(x * 9.0 + uTime * 0.25 + vW.z) * n1(x * 23.0 - uTime * 0.4 + 7.0) ;
        streak = pow(streak, 1.6) * 2.0;
        float edge = smoothstep(0.0, 0.25, x) * smoothstep(1.0, 0.75, x);
        float v = vUv.y;
        float fade = smoothstep(0.0, 0.55, v) * (0.5 + 0.5 * v);
        float flick = 0.75 + 0.25 * sin(uTime * 0.7 + vW.x * 2.0);
        float a = streak * edge * fade * flick * uInt * 0.11;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
  });
  const rays = [];
  for (let i = 0; i < 9; i++) {
    const w = rand(1.0, 2.4), h = 5.3;
    const geo = new THREE.PlaneGeometry(w, h, 1, 1);
    geo.translate(0, -h / 2, 0);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(-5 + i * 1.25 + rand(-0.3, 0.3), TANK.waterY, rand(-1.6, 1.6));
    m.rotation.z = rand(0.12, 0.28);
    m.userData.tilt = m.rotation.z;
    m.renderOrder = 8;
    group.add(m);
    rays.push(m);
  }
  scene.add(group);
  return {
    group, mat, rays,
    update(camera) {
      for (const r of rays) {
        // cylindrical billboard around the (tilted) axis
        const dx = camera.position.x - r.position.x, dz = camera.position.z - r.position.z;
        r.rotation.set(0, Math.atan2(dx, dz), 0);
        r.rotateZ(r.userData.tilt);
      }
    },
  };
}

// ======================================================= FOOD
export class Food {
  constructor(scene, eco, max = 260) {
    this.eco = eco;
    const geo = new THREE.CylinderGeometry(1, 1, 0.35, 7);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, emissive: new THREE.Color('#331100'), emissiveIntensity: 0.4 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    this.max = max;
    this.items = eco.food;
    this.colors = ['#ff8a3d', '#ffb347', '#e94b3c', '#8bc34a', '#ffd166', '#c0712f'].map((c) => new THREE.Color(c));
    for (let i = 0; i < max; i++) this.mesh.setColorAt(i, pick(this.colors));
  }
  drop(x, z, n = 26) {
    for (let i = 0; i < n; i++) {
      if (this.items.length >= this.max) break;
      const it = {
        pos: new THREE.Vector3(x + rand(-0.6, 0.6), TANK.waterY - 0.01, z + rand(-0.4, 0.4)),
        vel: new THREE.Vector3(rand(-0.05, 0.05), 0, rand(-0.05, 0.05)),
        float: rand(0.5, 3.5), sink: rand(0.12, 0.3), r: rand(0.018, 0.035),
        rot: new THREE.Euler(rand(0, 3), rand(0, 3), rand(0, 3)), spin: rand(-2, 2),
        claim: new Set(), eaten: false, grounded: false, age: 0, ph: rand(0, 10),
      };
      this.items.push(it);
    }
  }
  update(dt) {
    const eco = this.eco;
    const L = this.items;
    for (let i = L.length - 1; i >= 0; i--) {
      const f = L[i];
      f.age += dt;
      if (f.eaten) { L.splice(i, 1); continue; }
      if (f.float > 0) {
        f.float -= dt;
        f.pos.x += f.vel.x * dt + Math.sin(f.age * 2 + f.ph) * 0.02 * dt;
        f.pos.z += f.vel.z * dt;
        f.pos.y = TANK.waterY - 0.02 + Math.sin(f.age * 3 + f.ph) * 0.01;
      } else if (!f.grounded) {
        f.pos.y -= f.sink * dt;
        f.pos.x += Math.sin(f.age * 1.7 + f.ph) * 0.08 * dt + G.uCurrent.value.x * dt * 2;
        f.pos.z += Math.cos(f.age * 1.3 + f.ph) * 0.06 * dt;
        f.rot.x += f.spin * dt; f.rot.z += f.spin * 0.7 * dt;
        const floor = eco.surfaceAt(f.pos.x, f.pos.z) + 0.01;
        if (f.pos.y <= floor) { f.pos.y = floor; f.grounded = true; f.groundT = 0; }
      } else {
        f.groundT += dt;
        if (f.groundT > 70) { L.splice(i, 1); continue; }
      }
      f.pos.x = Math.max(-5.85, Math.min(5.85, f.pos.x));
      f.pos.z = Math.max(-2.3, Math.min(2.3, f.pos.z));
    }
    for (let i = 0; i < L.length; i++) {
      const f = L[i];
      _q.setFromEuler(f.rot);
      const s = f.grounded ? f.r * Math.max(0, 1 - Math.max(0, f.groundT - 60) / 10) : f.r;
      _s.set(s, s, s);
      _m.compose(f.pos, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = L.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
