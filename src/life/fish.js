import * as THREE from 'three';
import { buildFishModel } from './fishModel.js';
import { ASSETS } from './fishAssets.js';
import { SPECIES } from './species.js';
import { stageOf, growthOf } from './lifecycle.js';
import { rand, pick, clamp, mulberry32 } from '../fx/shaderPatch.js';

const V = () => new THREE.Vector3();
const _a = V(), _b = V(), _c = V(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0), ZERO = new THREE.Vector3();
const PICK = new THREE.MeshBasicMaterial();

export const BOUNDS = { x: 5.55, zMin: -2.05, zMax: 2.05, yMax: 5.35 };

const ACTIVE = new Set(['IDLE', 'EXPLORE', 'SCHOOL', 'RETURN', 'INVESTIGATE', 'PLAY', 'FOLLOW', 'SOCIALIZE', 'PATROL', 'NURSERY', 'COURT']);

export class Fish {
  /** rec: the saved record (see world.js): name, sex, birth, inherited looks and character. */
  constructor(eco, rec, idx) {
    const sp = SPECIES[rec.sp];
    this.eco = eco;
    this.sp = sp;
    this.rec = rec;
    this.kind = 'fish';
    this.idx = idx;
    this.uid = rec.uid;
    this.id = eco.nextId++;
    this.name = rec.name;
    this.sex = rec.sex;
    const R = mulberry32(rec.uid * 7919 + 17);
    this.R = R;
    this.p = { ...rec.traits };
    // --- visual: the inherited colour variant and tint, size from age and genes ---
    const vi = rec.gene.variant % (sp.variants?.length || 1);
    this.variant = sp.variants ? sp.variants[vi] : null;
    const key = sp.texVariants ? `${sp.id}-${vi}` : sp.id;
    if (ASSETS[key]) {
      // drawn by the shared instanced meshes of its model; the root only carries the transform
      const batch = eco.fishBatch(sp, key, ASSETS[key]);
      this.root = new THREE.Object3D();
      this.body = new THREE.Mesh(batch.pickGeo, PICK);   // invisible stand-in for picking
      this.body.visible = false;
      this.root.add(this.body);
      this.wag = { value: new THREE.Vector4(0, sp.swim.amp * sp.len, 0, sp.len) };
      this.pect = { value: 0.55 };
      this.glowU = batch.glow;
      batch.add(this, rec.gene.tint);
    } else {
      const model = buildFishModel(sp, this.variant, R);
      Object.assign(this, { root: model.root, body: model.body, wag: model.wag, pect: model.pect, glowU: model.glow });
      model.bodyMat.color.setRGB(...rec.gene.tint);
      model.finMat.color.setRGB(...rec.gene.tint);
    }
    this.updateLife(eco.world.now());
    this.scale = this.targetScale;
    this.size = sp.len * this.scale;
    this.root.scale.setScalar(this.scale);
    this.body.userData.fish = this;
    this.root.traverse((o) => { if (o.isMesh) o.userData.fish = this; });
    // --- motion ---
    this.pos = V();
    this.vel = new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1)).setLength(sp.swim.cruise * 0.5);
    this.heading = this.vel.clone().normalize();
    this.yawRate = 0;
    this.pitch = 0;
    this.wantDir = this.heading.clone();
    this.tail = 0.5; // tail-beat intensity, 1 = cruise
    this.pectF = 0;
    this.pectBrake = 0;
    this.pectS = 0; // smoothed for the fin animation
    this.pectB = 0;
    // slow cruisers (under ~1.5 body lengths/s) keep fanning their pectorals all the time
    this.idleScull = 0.35 * clamp(1 - sp.swim.cruise / sp.len / 1.5, 0, 1);
    this.phase = R() * 10;
    this.finPhase = R() * 10;
    this.burstT = rand(0, 2);
    this.burst = 0;
    this.gulp = 0;
    this.flare = 0;
    this.speedMul = 1;
    // --- needs & mind ---
    this.hunger = rand(0.2, 0.6);
    this.fear = 0;
    this.state = 'IDLE';
    this.stateT = 0;
    this.stateDur = rand(3, 8);
    this.thinkT = rand(0, 0.5);
    this.goal = V();
    this.face = null;
    this.ctx = {};
    this.mem = { friends: new Map(), last: null, foodSpot: null, visits: {}, meals: 0, discoveries: new Set() };
    this.hidden = false; // for rare/nocturnal species
  }

  /** Age-dependent state: life stage, body size and swimming speed. */
  updateLife(t) {
    this.stage = stageOf(this.rec, t);
    this.growth = growthOf(this.rec, t);
    this.targetScale = this.growth * this.rec.gene.size;
    this.speedK = (0.45 + 0.55 * this.growth) * (this.stage === 'elder' ? 0.85 : 1);
    // how far a youngster dares to stray from where it hatched
    this.independence = clamp((this.growth - 0.3) / 0.45, 0, 1);
  }

  get mate() { return this.rec.mate ? this.eco.byUid.get(this.rec.mate) || null : null; }

  /** Where a youngster grows up: the spot it hatched at, or its favourite place. */
  nurseryPos() {
    const s = this.rec.nursery && this.eco.spotByName(this.rec.nursery);
    return (s || this.fav).pos;
  }

  get character() {
    const P = this.p;
    const pairs = [
      [P.curiosity * 1.1, 'Любопытный исследователь'],
      [P.shyness * 1.15, 'Пугливый тихоня'],
      [P.gluttony * (this.sp.traits.gluttony > 0.9 ? 1.2 : 0.9), 'Большой обжора'],
      [P.aggression * 1.2, 'Задира'],
      [P.playfulness * 1.05, 'Неутомимый игрун'],
      [P.territoriality * 1.25, 'Хозяин территории'],
      [P.bravery * 1.0, 'Смельчак'],
      [(1 - P.activity) * 1.1, 'Неторопливый философ'],
    ];
    pairs.sort((a, b) => b[0] - a[0]);
    return pairs[0][1];
  }

  init(at) {
    const eco = this.eco, sp = this.sp, R = this.R;
    // favourite place: remembered from earlier visits, or chosen by character + species
    const spots = eco.spots;
    let fav = this.rec.fav && eco.spotByName(this.rec.fav);
    if (fav) { /* keeps its old favourite */ }
    else if (sp.homeKind === 'anemone') fav = eco.spotByName('актиния');
    else if (this.p.territoriality > 0.6) fav = pick(spots.filter((s) => ['castle', 'cave', 'hide', 'ship', 'arch'].includes(s.kind)));
    else if (sp.bottom) fav = pick(spots.filter((s) => s.pos.y < 1.6));
    else if (this.p.shyness > 0.55) fav = pick(spots.filter((s) => s.kind === 'hide' || s.kind === 'plants' || s.kind === 'cave'));
    else if (this.p.curiosity > 0.65) fav = pick(spots.filter((s) => ['landmark', 'ship', 'castle', 'filter', 'arch'].includes(s.kind)));
    else fav = pick(spots.filter((s) => s.kind === 'plants' || s.kind === 'open' || s.kind === 'landmark'));
    this.fav = fav || pick(spots);
    this.home = this.fav;
    let best = null, bd = 1e9;
    for (const s of spots) if (s.kind === 'hide' || s.kind === 'cave' || s.kind === 'plants') {
      const d = s.pos.distanceTo(this.fav.pos) + R() * 2;
      if (d < bd) { bd = d; best = s; }
    }
    this.hideSpot = best;
    if (at) this.pos.copy(at);
    else if (this.stage === 'fry') this.pos.copy(this.randomPointNear(this.nurseryPos(), 0.6));
    else this.pos.set(rand(-BOUNDS.x, BOUNDS.x) * 0.9, rand(sp.zone[0] + 0.5, sp.zone[1]), rand(-1.5, 1.5));
    if (sp.bottom) this.pos.y = eco.heightAt(this.pos.x, this.pos.z) + 0.12;
    this.root.position.copy(this.pos);
    this.setState(this.stage === 'fry' ? 'NURSERY' : sp.school > 0.6 ? 'SCHOOL' : 'IDLE');
  }

  dist(o) { return this.pos.distanceTo(o.pos); }

  setState(s, ctx = {}, dur) {
    this.state = s;
    this.ctx = ctx;
    this.stateT = 0;
    this.stateDur = dur ?? rand(4, 12) * (0.6 + (1 - this.p.activity) * 0.8);
    this.face = null;
  }

  remember(other, kind, delta = 0) {
    if (!other) return;
    const f = this.mem.friends;
    f.set(other.id, clamp((f.get(other.id) || 0) + delta, -1, 1));
    this.mem.last = { who: other.name, kind, t: this.eco.time };
  }
  bestFriend() {
    let best = null, bv = 0.15;
    for (const [id, v] of this.mem.friends) if (v > bv) { const o = this.eco.byId.get(id); if (o && !o.hidden) { best = o; bv = v; } }
    return best;
  }

  // ------------------------------------------------------------------ think
  think() {
    const eco = this.eco, sp = this.sp, P = this.p;
    if (this.hidden) return;
    const s = this.state;
    const busy = s === 'FLEE' || s === 'STANDOFF' || s === 'CAROUSEL' || s === 'SCRIPT';

    // 1. Threats: much bigger fish rushing close
    if (!busy && s !== 'EAT' && s !== 'DEFEND') {
      for (const o of eco.fish) {
        if (o === this || o.hidden || (o.sp === sp && this.stage === 'fry')) continue;
        if (o.size > this.size * 2.0 || o.state === 'DEFEND' && o.ctx.target === this) {
          const d = this.dist(o);
          const r = o.size * 1.2 + 0.25;
          // startle only when the big fish is actually closing in; a big fish just passing by
          // is calmly given way to by the steering (see steer)
          const closing = d > 1e-4 ? ((this.pos.x - o.pos.x) * o.vel.x + (this.pos.y - o.pos.y) * o.vel.y + (this.pos.z - o.pos.z) * o.vel.z) / d : 0;
          const attacked = o.state === 'DEFEND' && o.ctx.target === this;
          if (d < r && (attacked || closing > o.sp.swim.cruise * (0.9 - P.shyness * 0.4))) {
            this.flee(o.pos, 0.6 + P.shyness * 0.8, o);
            if (sp.school > 0.6 && Math.random() < 0.06) eco.story('scatter', `Стайка «${sp.title}» расступилась перед ${o.name}`, this.pos, { cooldown: 40 });
            return;
          }
        }
      }
    }

    // 2. Food
    if (eco.food.length && s !== 'EAT' && !busy) {
      const sleepy = sp.nocturnal ? 0 : eco.night;
      let p = (0.25 + P.gluttony * 0.75) * (0.4 + this.hunger) * (1 - sleepy * 0.6);
      if (Math.random() < p) {
        const f = this.pickFood();
        if (f) { this.setState('EAT', { food: f }, rand(6, 14)); f.claim.add(this); return; }
      }
    }

    // 3. Territory defence
    if (P.territoriality > 0.5 && !busy && (s === 'PATROL' || s === 'IDLE' || s === 'REST' || s === 'RETURN') && this.pos.distanceTo(this.home.pos) < 1.6) {
      for (const o of eco.fish) {
        if (o === this || o.hidden || o.state === 'FLEE') continue;
        if (o.pos.distanceTo(this.home.pos) < 0.9 + this.size && Math.random() < P.aggression * 0.5) {
          if (o.p.territoriality > 0.5 && o.size > this.size * 0.6 && o.state !== 'STANDOFF') {
            this.startStandoff(o);
          } else if (o.size < this.size * 1.6) {
            this.setState('DEFEND', { target: o }, rand(2, 4));
            this.remember(o, 'прогнал', -0.1);
            o.remember(this, 'был прогнан', -0.15);
            eco.story('defend', `${this.name} прогоняет ${o.name} со своей территории`, this.pos, { cooldown: 25, focus: this });
          }
          return;
        }
      }
    }

    // 4. Cursor curiosity / shyness
    const cur = eco.cursor;
    if (cur.active && !busy && s !== 'EAT' && s !== 'CURIOUS') {
      const d = this.pos.distanceTo(cur.point);
      if (d < 2.6) {
        if (P.curiosity > 0.55 && P.bravery > 0.35 && Math.random() < 0.06 * P.curiosity) {
          this.setState('CURIOUS', { point: cur.point, follow: true }, rand(5, 12));
          return;
        }
      }
    }

    // 5. Next state when time is up
    if (this.stateT > this.stateDur) this.chooseNext();
  }

  pickFood() {
    let best = null, bs = -1e9;
    for (const f of this.eco.food) {
      if (f.eaten) continue;
      if (this.sp.bottom && f.pos.y > this.eco.heightAt(f.pos.x, f.pos.z) + 1.4) continue;
      const d = this.pos.distanceTo(f.pos);
      if (d > 6.5) continue;
      const score = -d - f.claim.size * 0.4 * (1 - this.p.aggression) + Math.random() * 0.8;
      if (score > bs) { bs = score; best = f; }
    }
    return best;
  }

  flee(from, dur = 1.2, who = null) {
    _a.copy(this.pos).sub(from);
    if (_a.lengthSq() < 1e-4) _a.set(rand(-1, 1), rand(-0.3, 0.3), rand(-1, 1));
    _a.y *= 0.4;
    _a.normalize();
    const prev = this.state === 'FLEE' ? this.ctx.prev : this.state;
    this.setState('FLEE', { dir: _a.clone(), prev, who }, dur);
    this.fear = Math.min(1, this.fear + 0.6);
    this.burst = 0.3;
    if (who && who.kind === 'fish') this.remember(who, 'испугался', -0.05);
  }

  startStandoff(o) {
    const dur = rand(3, 5.5);
    this.setState('STANDOFF', { rival: o }, dur);
    o.setState('STANDOFF', { rival: this }, dur);
    this.remember(o, 'мерялись характером', -0.1);
    o.remember(this, 'мерялись характером', -0.1);
    this.eco.story('standoff', pick([
      `${this.name} и ${o.name} меряются характером`,
      `${this.name} и ${o.name} спорят, кто тут главный`,
      `Напряжённый момент: ${this.name} против ${o.name}`,
    ]), this.pos, { cooldown: 30, focus: this });
  }

  chooseNext() {
    const eco = this.eco, sp = this.sp, P = this.p, mem = this.mem;
    const night = eco.night;
    const sleepy = sp.nocturnal ? 0.2 * (1 - night) : night;
    if (this.stage === 'fry') {
      // youngsters stay close to where they hatched, hide a lot and play with each other
      const w = { NURSERY: 3, HIDE: 0.4 + P.shyness * 0.8 + sleepy, PLAY: P.playfulness * 0.5 * (1 - sleepy), EXPLORE: this.independence * 0.6 * (1 - sleepy) };
      let sum = 0;
      for (const k in w) sum += w[k];
      let r = Math.random() * sum;
      for (const k in w) { r -= w[k]; if (r <= 0) return this.enter(k); }
      return this.enter('NURSERY');
    }
    const school = sp.school > 0.6;
    const farFromFav = this.pos.distanceTo(this.fav.pos) > 2.5;
    const friend = this.bestFriend();
    const w = {
      IDLE: 0.8,
      SCHOOL: school ? 4.5 * (1 - sleepy * 0.6) : 0,
      EXPLORE: 1.1 * P.curiosity * P.activity * (1 - sleepy),
      RETURN: 0.4 + (farFromFav ? 1.2 : 0),
      REST: 0.3 * (1 - P.activity) + sleepy * 3.5,
      HIDE: P.shyness * 0.8 + sleepy * 1.2 * P.shyness + this.fear,
      SOCIALIZE: friend ? sp.social * 1.2 : 0,
      FOLLOW: 0.35 * P.curiosity * (1 - sleepy),
      PLAY: P.playfulness * 0.8 * (1 - sleepy) * (school ? 0.35 : 1),
      INVESTIGATE: P.curiosity * 0.7 * (1 - sleepy),
      BUBBLES: P.playfulness * 0.25 * (1 - sleepy),
      WAIT_FOOD: this.hunger > 0.55 && mem.foodSpot ? 0.7 * P.gluttony : 0,
      PATROL: P.territoriality > 0.5 ? 1.6 * P.territoriality : 0,
      CIRCLE: 0.12 * P.playfulness,
      AIR: sp.id === 'cory' ? 0.08 : 0,
      CRUISE: sp.bottom ? 2.5 : 0,
      COURT: this.mate && !this.mate.hidden && this.mate.stage !== 'fry' ? 1.4 * (1 - sleepy * 0.7) : 0,
      GUARD: this.guardUntil > eco.world.now() ? 3.5 : 0,
    };
    if (this.stage === 'elder') { w.REST *= 2.5; w.PLAY *= 0.3; w.EXPLORE *= 0.5; }
    if (sp.bottom) { w.EXPLORE *= 0.3; w.BUBBLES = 0; w.CIRCLE = 0; }
    let sum = 0;
    for (const k in w) sum += w[k];
    let r = Math.random() * sum, next = 'IDLE';
    for (const k in w) { r -= w[k]; if (r <= 0) { next = k; break; } }
    this.enter(next, friend);
  }

  enter(next, friend) {
    const eco = this.eco, sp = this.sp, P = this.p;
    switch (next) {
      case 'EXPLORE': {
        // prefer spots visited least
        const cand = eco.spots.slice().sort((a, b) => (this.mem.visits[a.name] || 0) - (this.mem.visits[b.name] || 0) + rand(-3, 3));
        const s = cand[0];
        const first = !this.mem.discoveries.has(s.name);
        this.setState('EXPLORE', { spot: s, point: this.randomPointNear(s.pos, 1.2) }, rand(8, 16));
        if (first && Math.random() < 0.25) eco.story('explore', `${this.name} отправился изучать ${s.name}`, this.pos, { cooldown: 25, focus: this });
        break;
      }
      case 'INVESTIGATE': {
        const s = pick(eco.spots.filter((q) => q.kind !== 'open'));
        this.setState('INVESTIGATE', { spot: s, ang: rand(0, 6.28), dir: Math.random() < 0.5 ? -1 : 1 }, rand(8, 15));
        if (Math.random() < 0.3) {
          const what = sp.id === 'cory' && s.kind === 'cave' ? `${this.sp.title} ${this.name} исследует пещеру` : `${this.name} внимательно изучает: ${s.name}`;
          eco.story('investigate', what, s.pos, { cooldown: 20, focus: this });
        }
        break;
      }
      case 'SOCIALIZE':
        this.setState('SOCIALIZE', { other: friend, side: Math.random() < 0.5 ? -1 : 1 }, rand(8, 18));
        if (Math.random() < 0.25) eco.story('friends', `${this.name} и ${friend.name} плавают вместе`, this.pos, { cooldown: 30, focus: this });
        break;
      case 'FOLLOW': {
        const o = this.nearestOther((o) => !o.hidden && o.sp !== this.sp && o.size > this.size * 0.5, 3.5);
        if (!o) return this.enter('IDLE');
        this.setState('FOLLOW', { other: o }, rand(6, 12));
        if (Math.random() < 0.25) eco.story('follow', `${this.name} увязался за ${o.name}`, this.pos, { cooldown: 25, focus: this });
        break;
      }
      case 'PLAY': {
        const o = this.nearestOther((o) => !o.hidden && o.p.playfulness > 0.35 && ACTIVE.has(o.state) && o.size < this.size * 2.2 && o.size > this.size * 0.45, 3.5);
        if (!o) return this.enter('EXPLORE');
        const dur = rand(6, 12);
        this.setState('PLAY', { other: o, role: 'chase', tags: 0 }, dur);
        o.setState('PLAY', { other: this, role: 'run', tags: 0 }, dur);
        eco.story('play', pick([`${this.name} и ${o.name} играют в догонялки`, `${this.name} гоняется за ${o.name}`, `Игра! ${this.name} и ${o.name} носятся по аквариуму`]), this.pos, { cooldown: 18, focus: this });
        break;
      }
      case 'BUBBLES':
        this.setState('BUBBLES', { src: pick(eco.bubbleSources()) }, rand(6, 12));
        if (Math.random() < 0.35) eco.story('bubbles', pick([`${this.name} играет с пузырьками`, `${this.name} ловит пузыри у ${this.ctx.src.name}`]), this.pos, { cooldown: 30, focus: this });
        break;
      case 'WAIT_FOOD':
        this.setState('WAIT_FOOD', {}, rand(6, 12));
        if (Math.random() < 0.3) eco.story('wait', `${this.name} ждёт корм там, где его обычно кормят`, this.pos, { cooldown: 60, focus: this });
        break;
      case 'HIDE':
        this.setState('HIDE', { spot: this.hideSpot, peek: rand(3, 8) }, rand(8, 20));
        break;
      case 'CIRCLE': {
        const c = pick(eco.clumps);
        this.setState('CIRCLE', { center: c.pos.clone().add(new THREE.Vector3(0, rand(0.3, 1.2), 0)), r: c.radius + rand(0.4, 0.8), ang: rand(0, 6.28), dir: Math.random() < 0.5 ? -1 : 1 }, rand(6, 12));
        if (Math.random() < 0.3) eco.story('circle', `${this.name} кружит вокруг растения`, c.pos, { cooldown: 30, focus: this });
        break;
      }
      case 'AIR':
        this.setState('AIR', { phase: 0, x: this.pos.x, z: this.pos.z }, 6);
        eco.story('air', pick([`Сомик ${this.name} метнулся к поверхности за глотком воздуха`, `${this.name} сделал рывок за воздухом — так умеют только сомики`]), this.pos, { cooldown: 50, focus: this });
        break;
      case 'CRUISE':
        this.setState('CRUISE', { point: this.randomBottomPoint() }, rand(5, 12));
        break;
      case 'NURSERY':
        this.setState('NURSERY', {}, rand(8, 16));
        break;
      case 'COURT': {
        const m = this.mate;
        this.setState('COURT', { other: m, side: Math.random() < 0.5 ? -1 : 1 }, rand(10, 20));
        if (Math.random() < 0.2) eco.story('court', pick([`${this.name} и ${m.name} не расстаются`, `${this.name} кружит рядом со своей парой — ${m.name}`]), this.pos, { cooldown: 60, focus: this });
        break;
      }
      case 'GUARD':
        this.setState('GUARD', { ang: rand(0, 6.28) }, rand(10, 18));
        if (Math.random() < 0.2) eco.story('guard', `${this.name} присматривает за мальками`, this.pos, { cooldown: 90, focus: this });
        break;
      default:
        this.setState(next, {}, undefined);
    }
  }

  nearestOther(filter, maxD = 99) {
    let best = null, bd = maxD;
    for (const o of this.eco.fish) {
      if (o === this || !filter(o)) continue;
      const d = this.dist(o);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  randomPointNear(p, r) {
    const sp = this.sp;
    return new THREE.Vector3(
      clamp(p.x + rand(-r, r), -BOUNDS.x, BOUNDS.x),
      clamp(p.y + rand(-r, r) * 0.5, sp.zone[0] + 0.3, Math.min(BOUNDS.yMax, sp.zone[1] + 0.6)),
      clamp(p.z + rand(-r, r) * 0.6, BOUNDS.zMin, BOUNDS.zMax),
    );
  }
  randomZonePoint() {
    const sp = this.sp;
    return new THREE.Vector3(rand(-BOUNDS.x, BOUNDS.x) * 0.9, rand(sp.zone[0] + 0.3, sp.zone[1]), rand(BOUNDS.zMin, BOUNDS.zMax) * 0.9);
  }
  randomBottomPoint() {
    const near = Math.random() < 0.6 ? this.fav.pos : new THREE.Vector3(rand(-5, 5), 0, rand(-1.8, 2));
    const x = clamp(near.x + rand(-1.8, 1.8), -5.4, 5.4), z = clamp(near.z + rand(-1, 1), -2.0, 2.0);
    return new THREE.Vector3(x, this.eco.heightAt(x, z) + 0.1, z);
  }

  // ------------------------------------------------------------------ behave
  behave(dt) {
    const eco = this.eco, sp = this.sp, P = this.p, c = this.ctx;
    const g = this.goal;
    let spd = 0.7;
    this.face = null;
    switch (this.state) {
      case 'IDLE': {
        // leisurely wandering: the next waypoint lies roughly ahead and is picked before the
        // current one is reached, so the path flows instead of zig-zagging point to point
        if (!c.point || this.pos.distanceTo(c.point) < Math.max(0.35, this.size * 2.5)) {
          _a.copy(this.heading).setY(0).normalize().multiplyScalar(rand(0.8, 1.6)).add(this.pos);
          c.point = this.randomPointNear(_a, 0.7);
        }
        g.copy(c.point); spd = 0.45;
        break;
      }
      case 'SCHOOL': {
        const st = eco.schools[sp.id];
        g.copy(st.target).add(_a.set(Math.sin(this.idx * 1.7) * 0.4, Math.cos(this.idx * 2.3) * 0.2, Math.sin(this.idx * 0.9) * 0.3));
        spd = st.speed;
        break;
      }
      case 'CRUISE': {
        if (this.pos.distanceTo(c.point) < 0.15 || (c.pause > 0)) {
          c.pause = (c.pause ?? rand(0.6, 2.5)) - dt;
          if (c.pause <= 0) { c.point = this.randomBottomPoint(); c.pause = undefined; }
          spd = 0.05;
          g.copy(this.pos).add(this.heading);
        } else { g.copy(c.point); spd = 0.8; }
        break;
      }
      case 'EXPLORE': {
        if (this.pos.distanceTo(c.point) < 0.4) {
          c.point = this.randomPointNear(c.spot.pos, 1.0);
          this.mem.visits[c.spot.name] = (this.mem.visits[c.spot.name] || 0) + 1;
          this.mem.discoveries.add(c.spot.name);
        }
        g.copy(c.point); spd = 0.9;
        break;
      }
      case 'RETURN': {
        g.copy(this.fav.pos); spd = 0.8;
        if (this.pos.distanceTo(g) < this.fav.radius + 0.2) { this.mem.visits[this.fav.name] = (this.mem.visits[this.fav.name] || 0) + 1; this.setState(Math.random() < 0.5 ? 'REST' : 'IDLE'); }
        break;
      }
      case 'REST': {
        const t = eco.time * 0.3 + this.idx;
        g.copy(this.fav.pos).add(_a.set(Math.sin(t) * 0.3, Math.sin(t * 0.7) * 0.1, Math.cos(t * 0.8) * 0.2));
        if (sp.bottom) g.y = eco.heightAt(g.x, g.z) + 0.1;
        spd = 0.22;
        if (eco.night > 0.6 && !sp.nocturnal) spd = 0.1;
        break;
      }
      case 'HIDE': {
        const s = c.spot;
        c.peek -= dt;
        if (c.peek < 0 && c.peek > -2.2) {
          g.copy(s.pos).add(_a.set(0, 0.2, 0.9)); spd = 1.4;
          if (!c.peeked) { c.peeked = true; if (Math.random() < 0.3) eco.story('peek', `${this.name} выглянул из укрытия (${s.name})`, s.pos, { cooldown: 40, focus: this }); }
        } else {
          if (c.peek <= -2.2) c.peek = rand(5, 12), c.peeked = false;
          const t = eco.time * 0.4 + this.idx;
          g.copy(s.pos).add(_a.set(Math.sin(t) * s.radius * 0.6, 0, Math.cos(t * 1.3) * s.radius * 0.4));
          spd = 0.3;
        }
        break;
      }
      case 'SOCIALIZE': {
        const o = c.other;
        if (!o || o.hidden) { this.setState('IDLE'); break; }
        _a.crossVectors(o.heading, UP).normalize().multiplyScalar(c.side * (o.size + this.size) * 0.7);
        g.copy(o.pos).add(_a).addScaledVector(o.heading, 0.1);
        spd = clamp(o.vel.length() / sp.swim.cruise + this.pos.distanceTo(g) * 0.8, 0.2, 1.6);
        this.remember(o, 'плавали вместе', dt * 0.02);
        o.remember(this, 'плавали вместе', dt * 0.01);
        break;
      }
      case 'FOLLOW': {
        const o = c.other;
        if (!o || o.hidden) { this.setState('IDLE'); break; }
        g.copy(o.pos).addScaledVector(o.heading, -(o.size + this.size) * 0.9);
        spd = clamp(this.pos.distanceTo(g) * 1.2, 0.3, 1.5);
        this.remember(o, 'следовал', dt * 0.01);
        break;
      }
      case 'PLAY': {
        const o = c.other;
        if (!o || o.state !== 'PLAY' || o.ctx.other !== this) { this.setState('IDLE'); break; }
        if (c.role === 'chase') {
          g.copy(o.pos).addScaledVector(o.vel, 0.3); spd = 1.7;
          if (this.dist(o) < (this.size + o.size) * 0.45 && this.stateT > 0.8) {
            c.role = 'run'; o.ctx.role = 'chase'; c.tags++; o.ctx.tags++;
            this.stateT = Math.min(this.stateT, this.stateDur - 2);
            o.burst = 0.4;
            this.remember(o, 'играли', 0.08); o.remember(this, 'играли', 0.08);
          }
        } else {
          if (!c.point || this.pos.distanceTo(c.point) < 0.5 || this.pos.distanceTo(o.pos) < 0.6 && Math.random() < 0.05) {
            _a.copy(this.pos).sub(o.pos).setLength(2.2).add(this.pos).add(_b.set(rand(-1.5, 1.5), rand(-0.6, 0.6), rand(-1, 1)));
            c.point = this.randomPointNear(_a, 0.2);
          }
          g.copy(c.point); spd = 1.55;
        }
        break;
      }
      case 'BUBBLES': {
        const s = c.src;
        const t = eco.time * 2 + this.idx;
        g.copy(s.pos).add(_a.set(Math.sin(t) * 0.25, 0.4 + (Math.sin(t * 0.37) * 0.5 + 0.5) * 2.0, Math.cos(t) * 0.25));
        spd = 1.0;
        const b = eco.bubbles.nearest(this.pos, this.size * 0.8 + 0.05);
        if (b) { eco.bubbles.poke(b, this.heading); }
        break;
      }
      case 'WAIT_FOOD': {
        const fs = this.mem.foodSpot;
        g.set(fs.x + Math.sin(eco.time + this.idx) * 0.4, Math.min(fs.y, 5.0), fs.z);
        spd = 0.4;
        break;
      }
      case 'PATROL': {
        const h = this.home.pos;
        c.ang = (c.ang ?? rand(0, 6.28)) + dt * 0.5;
        g.set(h.x + Math.cos(c.ang) * 0.8, h.y + Math.sin(c.ang * 0.7) * 0.2, h.z + Math.sin(c.ang) * 0.4);
        spd = 0.55;
        break;
      }
      case 'DEFEND': {
        const o = c.target;
        if (!o) { this.setState('RETURN'); break; }
        g.copy(o.pos); spd = 1.8;
        this.flare = Math.min(1, this.flare + dt * 3);
        if (this.dist(o) < (this.size + o.size) * 0.5) { o.flee(this.pos, 1.6, this); if (Math.random() < 0.5) this.setState('RETURN'); }
        if (o.pos.distanceTo(this.home.pos) > 2.2) this.setState('RETURN');
        break;
      }
      case 'STANDOFF': {
        const o = c.rival;
        if (!o || o.state !== 'STANDOFF') { this.setState('RETURN'); break; }
        _a.copy(this.pos).sub(o.pos); _a.y = 0;
        if (_a.lengthSq() < 1e-4) _a.set(1, 0, 0);
        _a.setLength((this.size + o.size) * 0.55);
        g.copy(o.pos).add(_a).add(_b.set(0, Math.sin(eco.time * 4 + this.idx) * 0.03, 0));
        this.face = o.pos;
        spd = 0.6;
        this.flare = Math.min(1, this.flare + dt * 2);
        if (this.stateT > this.stateDur - 0.1 && !c.done) {
          c.done = true; o.ctx.done = true;
          const mine = this.p.bravery + this.size + Math.random() * 0.6, theirs = o.p.bravery + o.size + Math.random() * 0.6;
          const [win, lose] = mine > theirs ? [this, o] : [o, this];
          lose.flee(win.pos, 2.0, win);
          win.setState('DEFEND', { target: lose }, 2);
          if (Math.random() < 0.6) this.eco.story('standoff-end', pick([`${win.name} победил в споре, ${lose.name} отступает`, `${lose.name} решил не связываться с ${win.name}`]), win.pos, { cooldown: 20 });
        }
        break;
      }
      case 'EAT': {
        const f = c.food;
        if (!f || f.eaten) {
          const n = this.pickFood();
          if (n && this.hunger > 0.05) { c.food = n; n.claim.add(this); }
          else { this.setState(this.sp.school > 0.6 ? 'SCHOOL' : 'IDLE'); }
          break;
        }
        g.copy(f.pos); spd = 1.5 + this.p.gluttony * 0.6;
        if (this.pos.distanceTo(f.pos) < this.size * 0.45 + 0.07) eco.eatFood(f, this);
        break;
      }
      case 'FLEE': {
        g.copy(this.pos).addScaledVector(c.dir, 2.0); spd = 2.2;
        if (this.stateT > this.stateDur) {
          if (c.prev === 'SCHOOL') this.setState('SCHOOL');
          else if (this.p.shyness > 0.6 && Math.random() < 0.6) this.enter('HIDE');
          else this.setState('RETURN');
        }
        break;
      }
      case 'CURIOUS': {
        const pt = c.follow && eco.cursor.active ? eco.cursor.point : c.point;
        g.copy(pt); g.z = Math.min(g.z, BOUNDS.zMax - 0.05);
        const d = this.pos.distanceTo(g);
        spd = d > 0.5 ? 0.9 : 0.12;
        if (d < 0.6) this.face = pt;
        if (c.follow && !eco.cursor.active && this.stateT > 2) this.stateDur = Math.min(this.stateDur, this.stateT + 1);
        break;
      }
      case 'WATCH': {
        const cam = eco.cameraPos;
        g.set(clamp(cam.x * 0.25 + c.ox, -4.5, 4.5), clamp(cam.y * 0.4 + 1.2, 1.2, 4.5), BOUNDS.zMax - 0.15);
        this.face = cam;
        spd = this.pos.distanceTo(g) > 0.4 ? 0.8 : 0.05;
        break;
      }
      case 'INVESTIGATE': {
        const s = c.spot;
        const d = this.pos.distanceTo(s.pos);
        if (d > s.radius + 0.8) { g.copy(s.pos); spd = 0.8; }
        else {
          c.ang += c.dir * dt * 0.5;
          g.copy(s.pos).add(_a.set(Math.cos(c.ang) * (s.radius + 0.35), Math.sin(c.ang * 0.5) * 0.15, Math.sin(c.ang) * (s.radius + 0.35) * 0.6));
          spd = 0.35;
          if (Math.random() < dt * 0.4) this.face = s.pos;
          this.mem.visits[s.name] = (this.mem.visits[s.name] || 0) + dt * 0.2;
        }
        break;
      }
      case 'CIRCLE': case 'CAROUSEL': {
        const r = c.r;
        c.ang += c.dir * dt * (c.angSpeed || 1.0 / r);
        const ex = c.rx || r, ez = c.rz || r * 0.6;
        g.copy(c.center).add(_a.set(Math.cos(c.ang) * ex, Math.sin(c.ang * 2) * 0.15 + (c.dy || 0), Math.sin(c.ang) * ez));
        spd = this.state === 'CAROUSEL' ? 1.25 : 0.9;
        if (this.state === 'CAROUSEL' && this.stateT > this.stateDur) this.setState(sp.school > 0.6 ? 'SCHOOL' : 'RETURN');
        break;
      }
      case 'AIR': {
        if (c.phase === 0) { g.set(c.x, 5.5, c.z); spd = 2.2; if (this.pos.y > 5.3) c.phase = 1; }
        else { g.set(c.x + 0.5, eco.heightAt(c.x, c.z) + 0.15, c.z); spd = 1.2; if (this.pos.y < eco.heightAt(this.pos.x, this.pos.z) + 0.3) this.setState('CRUISE', { point: this.randomBottomPoint() }); }
        break;
      }
      case 'SCRIPT': {
        g.copy(c.point); spd = c.speed || 1;
        if (c.face) this.face = c.face;
        break;
      }
      case 'NURSERY': {
        // little loops around the nursery, wider as the youngster gains confidence
        const home = this.nurseryPos();
        if (!c.point || this.pos.distanceTo(c.point) < 0.15) c.point = this.randomPointNear(home, 0.3 + this.independence * 1.6);
        g.copy(c.point); spd = 0.5;
        break;
      }
      case 'COURT': {
        // side by side with the partner, now and then a little display
        const o = c.other;
        if (!o || o.hidden) { this.setState('IDLE'); break; }
        _a.crossVectors(o.heading, UP).normalize().multiplyScalar(c.side * (o.size + this.size) * 0.45);
        g.copy(o.pos).add(_a).addScaledVector(o.heading, 0.05);
        spd = clamp(o.vel.length() / sp.swim.cruise + this.pos.distanceTo(g) * 0.8, 0.2, 1.3);
        if (Math.sin(eco.time * 0.7 + this.idx) > 0.97) this.flare = Math.min(1, this.flare + dt * 2);
        break;
      }
      case 'NEST': {
        // the pair circles closely over the chosen spot before the brood arrives
        const s = c.spot;
        c.ang += c.dir * dt * 0.9;
        g.copy(s.pos).add(_a.set(Math.cos(c.ang) * 0.3, 0.15 + Math.sin(c.ang * 2) * 0.05, Math.sin(c.ang) * 0.2));
        if (sp.bottom) g.y = eco.heightAt(g.x, g.z) + 0.1;
        spd = 0.4;
        if (Math.random() < dt * 0.5) this.face = s.pos;
        break;
      }
      case 'GUARD': {
        // parents patrol around their youngsters and shoo away strangers
        const home = this.nurseryPos();
        c.ang += dt * 0.6;
        g.set(home.x + Math.cos(c.ang) * 0.6, home.y + 0.1 + Math.sin(c.ang * 0.7) * 0.15, home.z + Math.sin(c.ang) * 0.35);
        spd = 0.5;
        const intruder = this.nearestOther((o) => !o.hidden && o.sp !== sp && o.pos.distanceTo(home) < 0.9 && o.size < this.size * 1.6, 1.4);
        if (intruder && Math.random() < dt * 0.8) {
          this.setState('DEFEND', { target: intruder }, rand(1.5, 3));
          eco.story('guard-chase', `${this.name} отгоняет ${intruder.name} от своих мальков`, this.pos, { cooldown: 40, focus: this });
        }
        break;
      }
      default:
        g.copy(this.pos).add(this.heading); spd = 0.4;
    }
    // Sleep at night for diurnal fish (soft)
    if (!sp.nocturnal && eco.night > 0.7 && (this.state === 'REST' || this.state === 'HIDE')) spd *= 0.6;
    if (sp.nocturnal && eco.night > 0.5 && ACTIVE.has(this.state)) spd *= 1.25;
    this.speedMul = spd;
  }

  // ------------------------------------------------------------------ steer
  steer(dt) {
    const eco = this.eco, sp = this.sp, S = sp.swim;
    const acc = _c.set(0, 0, 0);
    // burst & glide rhythm
    let mul = this.speedMul;
    if (S.burst > 0 && this.speedMul > 0.3) {
      this.burstT -= dt;
      if (this.burstT < 0) { this.burst = rand(0.15, 0.3); this.burstT = rand(0.5, 2.2) / (0.4 + S.burst); }
    }
    if (this.burst > 0) { this.burst -= dt; mul *= 1 + 0.8 * S.burst; }
    const desiredSpeed = S.cruise * mul * this.speedK;
    // seek
    _a.copy(this.goal).sub(this.pos);
    const dist = _a.length();
    if (dist > 1e-4) {
      const arrive = Math.min(1, dist / (0.25 + this.size));
      _a.multiplyScalar(desiredSpeed * Math.max(arrive, 0.08) / dist);
      _a.y *= sp.bottom ? 1 : 0.7;
      acc.add(_a.sub(this.vel).multiplyScalar(2.2));
    }
    // flocking & separation
    const schoolW = this.state === 'SCHOOL' ? sp.school : (sp.school > 0.3 && ACTIVE.has(this.state) ? sp.school * 0.25 : 0);
    let n = 0;
    const coh = _b.set(0, 0, 0), ali = V();
    for (const o of eco.fish) {
      if (o === this || o.hidden) continue;
      const dx = o.pos.x - this.pos.x, dy = o.pos.y - this.pos.y, dz = o.pos.z - this.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const sepR = (this.size + o.size) * 0.55 + 0.04;
      if (d2 < sepR * sepR && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const f = (sepR - d) / sepR * 6;
        acc.x -= dx / d * f; acc.y -= dy / d * f * 0.6; acc.z -= dz / d * f;
      }
      if (schoolW > 0 && o.sp === sp && d2 < 1.2 && (o.state === 'SCHOOL' || o.state === this.state)) {
        coh.x += o.pos.x; coh.y += o.pos.y; coh.z += o.pos.z;
        ali.add(o.vel);
        n++;
      }
      // small fish avoid large fish gently even when not fleeing
      if (o.size > this.size * 2.2 && d2 < (o.size * 1.4) ** 2) {
        const d = Math.sqrt(d2) + 1e-4;
        const f = (o.size * 1.4 - d) * 3 * (0.5 + this.p.shyness);
        acc.x -= dx / d * f; acc.y -= dy / d * f * 0.5; acc.z -= dz / d * f;
      }
    }
    if (n > 0) {
      coh.multiplyScalar(1 / n).sub(this.pos).multiplyScalar(1.2 * schoolW);
      ali.multiplyScalar(1 / n).sub(this.vel).multiplyScalar(1.6 * schoolW);
      acc.add(coh).add(ali);
    }
    // obstacles
    for (const col of eco.colliders) {
      const dx = this.pos.x - col.c.x, dy = this.pos.y - col.c.y, dz = this.pos.z - col.c.z;
      const r = col.r + this.size * 0.5 + 0.12;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r * r) {
        const d = Math.sqrt(d2) + 1e-4;
        const f = (r - d) / r * 9;
        acc.x += dx / d * f; acc.y += dy / d * f * 0.8; acc.z += dz / d * f;
      }
    }
    // walls & floor & surface
    const m = 0.35;
    const floor = eco.heightAt(this.pos.x, this.pos.z) + (sp.bottom ? 0.07 : 0.25 + sp.height * 0.4);
    if (this.pos.x > BOUNDS.x - m) acc.x -= (this.pos.x - (BOUNDS.x - m)) * 14;
    if (this.pos.x < -BOUNDS.x + m) acc.x += (-BOUNDS.x + m - this.pos.x) * 14;
    if (this.pos.z > BOUNDS.zMax - m) acc.z -= (this.pos.z - (BOUNDS.zMax - m)) * 14;
    if (this.pos.z < BOUNDS.zMin + m) acc.z += (BOUNDS.zMin + m - this.pos.z) * 14;
    if (this.pos.y < floor + 0.15) acc.y += (floor + 0.15 - this.pos.y) * 16;
    const ceil = this.state === 'EAT' || this.state === 'AIR' ? 5.55 : BOUNDS.yMax - 0.1;
    if (this.pos.y > ceil) acc.y -= (this.pos.y - ceil) * 16;
    // cursor avoidance for shy fish
    const cur = eco.cursor;
    if (cur.active && this.p.shyness > 0.55) {
      _a.copy(this.pos).sub(cur.point);
      const d = _a.length();
      if (d < 1.0) acc.addScaledVector(_a.normalize(), (1.0 - d) * 4 * this.p.shyness);
    }
    // global current from filter
    _a.copy(eco.filterOutlet).sub(this.pos);
    if (_a.length() < 1.5) acc.add(_b.set(-0.6, -0.05, 0.1).multiplyScalar((1.5 - _a.length()) * 0.6));

    const maxA = S.accel * (this.state === 'FLEE' ? 2.2 : 1) * (this.burst > 0 ? 1.6 : 1);
    if (acc.length() > maxA) acc.setLength(maxA);
    // --- locomotion physics. Only fins move the fish:
    //  * the tail pushes along the body axis, thrust ~ (beat intensity)^2, so steady speed ~ intensity;
    //  * pectorals give a weak force in any direction (hovering, fine positioning, braking, backing up);
    //  * water drag is low along the body and strong sideways/vertically, so a fish cannot slide
    //    off its axis or keep moving without beating.
    // The tail animation is driven by the same intensity (this.tail), so motion and fins agree.
    const flee = this.state === 'FLEE' ? 2 : 1;
    const maxV = S.max * this.speedK * (this.state === 'FLEE' || this.state === 'DEFEND' || this.state === 'EAT' ? 1 : 0.75);
    const h = this.heading;
    let fwd = this.vel.dot(h);
    const speed = Math.max(0, fwd);
    // where the fish wants to go: the velocity it is asking for, low-passed so that
    // flickering steering forces don't twitch the body
    _a.copy(this.vel).addScaledVector(acc, 0.6);
    const wantSpeed = Math.min(_a.length(), maxV) * (mul < 0.2 ? 0.5 : 1);
    if (this.face) _a.copy(this.face).sub(this.pos);
    if (_a.lengthSq() > 1e-6) {
      _a.normalize();
      _a.y = clamp(_a.y * clamp(speed / (S.cruise * 0.5), 0.15, 1), -0.5, 0.5); // hovering fish level out
      this.wantDir.lerp(_a, 1 - Math.exp(-dt * 3 * flee)).normalize();
    }
    const w = this.wantDir;
    // yaw: critically damped turn, rate limited (tight turns need some speed)
    const yaw = Math.atan2(h.x, h.z);
    let err = Math.atan2(w.x, w.z) - yaw;
    if (err > Math.PI) err -= Math.PI * 2;
    if (err < -Math.PI) err += Math.PI * 2;
    const om = S.turn * flee;
    const maxRate = om * 0.6 * (0.35 + 0.65 * clamp(speed / S.cruise, 0, 1));
    this.yawRate = clamp(this.yawRate + (om * om * err - 2 * om * this.yawRate) * dt, -maxRate, maxRate);
    const ny = yaw + this.yawRate * dt;
    this.pitch += (Math.asin(clamp(w.y, -1, 1)) - this.pitch) * (1 - Math.exp(-dt * om * 0.5));
    h.set(Math.sin(ny) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(ny) * Math.cos(this.pitch));
    // wanted forward speed: slower in sharp turns; when the goal lies inside the turning circle
    // the fish almost stops and pivots instead of orbiting it
    const facing = Math.max(0, h.dot(w));
    const turnR = speed / Math.max(maxRate, 0.05);
    const tight = clamp((2.2 * turnR) / Math.max(dist, 1e-3), 0, 1);
    const target = wantSpeed * (0.25 + 0.75 * facing * facing) * (1 - tight * (1 - facing) * 0.9);
    // tail: beat intensity (1 = cruise) chosen to reach the target speed; muscles ramp up quickly
    // (faster for bursts and escapes) and relax a little slower -> coasting between beats
    fwd = this.vel.dot(h);
    const aWant = clamp(target / S.cruise + 1.2 * (target - fwd) / S.cruise, 0, (maxV / S.cruise) * 1.1);
    const ramp = aWant > this.tail ? (this.burst > 0 || flee > 1 ? 14 : 5) : 4;
    this.tail += (aWant - this.tail) * (1 - Math.exp(-dt * ramp));
    const T0 = S.accel * 0.6; // thrust (per unit mass) at cruise intensity
    const thrust = T0 * this.tail * this.tail;
    // pectorals: what the tail can't do, weakly. Sideways/vertical sculling only near hover (on the
    // move the fish turns with its body), braking only once the tail has stopped pushing.
    _b.copy(w).multiplyScalar(target).sub(this.vel).multiplyScalar(2);
    const along = _b.dot(h);
    const slow = clamp(1 - fwd / (S.cruise * 0.4), 0, 1);
    _b.addScaledVector(h, -along).multiplyScalar(0.1 + 0.9 * slow);
    if (along < 0) _b.addScaledVector(h, along * clamp((0.5 - this.tail) / 0.3, 0, 1));
    const pMax = T0 * 0.22;
    if (_b.length() > pMax) _b.setLength(pMax);
    this.pectF = _b.length() / pMax;
    this.pectBrake = clamp(-_b.dot(h) / pMax, 0, 1);
    this.vel.addScaledVector(h, thrust * dt).addScaledVector(_b, dt);
    // drag: quadratic + a little linear along the body; sideways/vertical much stronger
    fwd = this.vel.dot(h);
    _c.copy(this.vel).addScaledVector(h, -fwd);
    const cAx = T0 / (S.cruise * S.cruise);
    fwd *= Math.exp(-dt * (cAx * Math.abs(fwd) + 0.25));
    _c.multiplyScalar(Math.exp(-dt * (2.5 + 4 * clamp(Math.abs(fwd) / S.cruise, 0, 1))));
    this.vel.copy(h).multiplyScalar(fwd).add(_c);
    if (this.vel.length() > maxV * 1.15) this.vel.setLength(maxV * 1.15);
    this.pos.addScaledVector(this.vel, dt);
    // hard limits
    this.pos.x = clamp(this.pos.x, -BOUNDS.x - 0.1, BOUNDS.x + 0.1);
    this.pos.z = clamp(this.pos.z, BOUNDS.zMin - 0.1, BOUNDS.zMax + 0.1);
    const hf = eco.heightAt(this.pos.x, this.pos.z) + (sp.bottom ? 0.05 : sp.height * 0.35);
    this.pos.y = clamp(this.pos.y, hf, ceil + 0.05);
  }

  // ------------------------------------------------------------------ animate
  animate(dt) {
    const sp = this.sp, S = sp.swim;
    const speed = this.vel.length();
    _m.lookAt(this.heading, ZERO, UP);
    _q.setFromRotationMatrix(_m);
    let roll = clamp(-this.yawRate * 0.12, -0.5, 0.5);
    if (this.state === 'REST' && this.eco.night > 0.6 && !sp.nocturnal) roll += 0.12;
    _q2.setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll);
    _q.multiply(_q2);
    this.root.quaternion.slerp(_q, 1 - Math.exp(-10 * dt));
    this.root.position.copy(this.pos);

    // tail undulation: the same intensity that produces thrust. Frequency grows with intensity
    // (and so with speed); amplitude saturates. Turning on the spot takes a few tail sweeps too.
    const rel = speed / S.cruise;
    const spin = Math.min(1, Math.abs(this.yawRate) / (S.turn * 0.6)) * 0.5 * clamp(1 - rel, 0, 1);
    const act = Math.max(this.tail, spin);
    // Bainbridge: tail-beat frequency f ≈ 1.33·(1 + U/L) Hz, it never drops much below ~1.3 Hz;
    // at low speed the stroke gets smaller instead
    let freq = Math.PI * 2 * 1.33 * (1 + act * S.cruise / this.size);   // small fish beat faster
    let amp = S.amp * sp.len * (0.15 + 0.85 * Math.min(act / 0.6, 1));
    if (S.wiggle) amp *= 1.2;
    if (this.flare > 0) { freq *= 1.6; amp *= 1 + this.flare * 0.8; this.flare = Math.max(0, this.flare - dt * 0.7); }
    if (this.state === 'REST' && this.eco.night > 0.6 && !sp.nocturnal) { freq *= 0.4; amp *= 0.5; }
    this.phase += dt * freq;
    const W = this.wag.value;
    W.x = this.phase;
    W.y += (amp - W.y) * Math.min(1, dt * 4);
    // turning bends the body into a gentle C: tail tip offset up to ~15% of the length
    W.z += (0.6 * clamp(-this.yawRate / 3, -1, 1) / sp.len - W.z) * Math.min(1, dt * 5);
    // pectorals: they scull while hovering and whenever they produce force, and flare to brake
    const hover = clamp(1 - rel * 2.5, 0, 1);
    this.pectS += (Math.max(hover * 0.6, this.pectF, this.idleScull) - this.pectS) * Math.min(1, dt * 3);
    this.pectB += (this.pectBrake - this.pectB) * Math.min(1, dt * 3);
    const scull = this.pectS, brake = this.pectB;
    this.finPhase += dt * (4 + scull * 6);
    this.pect.value = 0.35 + hover * 0.25 + brake * 0.6 + Math.sin(this.finPhase) * (0.12 + scull * 0.45) + this.flare * 0.5;
    // growing up: the body follows the age-dependent size smoothly
    if (Math.abs(this.targetScale - this.scale) > 1e-4) {
      this.scale += (this.targetScale - this.scale) * Math.min(1, dt * 0.5);
      this.size = sp.len * this.scale;
      this.root.scale.setScalar(this.scale);
    }
    // gulp
    if (this.gulp > 0) {
      this.gulp = Math.max(0, this.gulp - dt * 3);
      const s = 1 + Math.sin(this.gulp * Math.PI) * 0.08;
      this.root.scale.set(this.scale * s, this.scale * s, this.scale * (2 - s));
    }
    if (this.glowU) this.glowU.value = 0.15 + this.eco.night * 0.9;
  }

  update(dt) {
    if (this.hidden) return;
    this.stateT += dt;
    this.hunger = Math.min(1, this.hunger + dt * 0.003 * (0.6 + this.p.gluttony));
    this.fear = Math.max(0, this.fear - dt * 0.2);
    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = rand(0.25, 0.6); this.think(); }
    this.behave(dt);
    this.steer(dt);
    this.animate(dt);
  }

  statusText() {
    const c = this.ctx;
    const nm = (o) => (o ? o.name : 'кем-то');
    switch (this.state) {
      case 'IDLE': return 'Неспешно плавает';
      case 'SCHOOL': return 'Плывёт со стаей';
      case 'CRUISE': return 'Копается в грунте';
      case 'EXPLORE': return `Исследует: ${c.spot?.name || 'аквариум'}`;
      case 'RETURN': return `Возвращается: ${this.fav.name}`;
      case 'REST': return this.eco.night > 0.6 && !this.sp.nocturnal ? 'Спит' : 'Отдыхает';
      case 'HIDE': return `Прячется: ${c.spot?.name || ''}`;
      case 'SOCIALIZE': return `Проводит время с ${nm(c.other)}`;
      case 'FOLLOW': return `Следует за ${nm(c.other)}`;
      case 'PLAY': return c.role === 'chase' ? `Догоняет ${nm(c.other)}` : `Удирает от ${nm(c.other)}`;
      case 'BUBBLES': return 'Играет с пузырьками';
      case 'WAIT_FOOD': return 'Ждёт корм';
      case 'PATROL': return 'Охраняет территорию';
      case 'DEFEND': return `Прогоняет ${nm(c.target)}`;
      case 'STANDOFF': return `Меряется характером с ${nm(c.rival)}`;
      case 'EAT': return 'Ловит корм!';
      case 'FLEE': return 'Испугался!';
      case 'CURIOUS': return 'С любопытством разглядывает';
      case 'WATCH': return 'Наблюдает за вами';
      case 'INVESTIGATE': return `Изучает: ${c.spot?.name || ''}`;
      case 'CIRCLE': return 'Кружит вокруг растения';
      case 'CAROUSEL': return 'Карусель!';
      case 'AIR': return 'Плывёт за глотком воздуха';
      case 'SCRIPT': return c.label || 'Занят делом';
      case 'NURSERY': return this.independence > 0.5 ? 'Осваивает окрестности' : 'Держится рядом с братьями и сёстрами';
      case 'COURT': return `Плавает со своей парой — ${nm(c.other)}`;
      case 'NEST': return 'Готовится к появлению мальков';
      case 'GUARD': return 'Присматривает за мальками';
      default: return 'Плавает';
    }
  }
}
