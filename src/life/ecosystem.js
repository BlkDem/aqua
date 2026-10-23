import * as THREE from 'three';
import { SPECIES } from './species.js';
import { Fish, BOUNDS } from './fish.js';
import { FishBatch } from './fishModel.js';
import { buildCritters } from './critters.js';
import { lifeTick, brood, schoolSizes, RARE } from './lifecycle.js';
import { fryWord, count } from './words.js';
import { DAY } from './world.js';
import { Food } from '../fx/particles.js';
import { sandHeight, TANK } from '../world/tank.js';
import { G, rand, pick, clamp } from '../fx/shaderPatch.js';

// automatic feeding times (hour of the day) for 2, 3 or 4 meals a day
export const FEED_TIMES = { 2: [9, 19], 3: [9, 14, 20], 4: [8, 12, 16, 20] };
const SCHOOL_MARKS = [10, 15, 20, 25];

export class Ecosystem {
  constructor(scene, decor, plants, bubbles, tank, world) {
    this.world = world;
    this.scene = scene;
    this.decor = decor;
    this.plants = plants;
    this.bubbles = bubbles;
    this.tank = tank;
    this.nextId = 1;
    this.time = 0;
    this.night = 0;
    this.fish = [];
    this.critters = [];
    this.food = [];
    this.byId = new Map();
    this.colliders = decor.colliders;
    this.spots = decor.spots.slice();
    for (const c of plants.clumps) this.spots.push({ name: c.name, pos: c.pos.clone(), kind: 'plants', radius: c.radius });
    this.clumps = plants.clumps;
    this.cursor = { active: false, point: new THREE.Vector3(), t: 0 };
    this.cameraPos = new THREE.Vector3(0, 3, 14);
    this.filterOutlet = tank.filterOutlet;
    this.listeners = [];
    this.storyLog = [];
    this.cool = {};
    this.lastStoryT = -99;
    this.timers = [];
    this.byUid = new Map();
    this.fishListeners = [];
    this.batches = new Map();
    world.pending = {};

    this.buildHeightGrid(decor.walkables);

    // ---------- fish: everyone who lives in the saved aquarium ----------
    for (const rec of world.fish) this.spawnFish(rec);
    for (const f of this.fish) {   // friendships are saved by uid
      for (const [uid, v] of Object.entries(f.rec.friends || {})) {
        const o = this.byUid.get(Number(uid));
        if (o) f.mem.friends.set(o.id, v);
      }
    }
    for (const f of this.fish) f.init();
    // rare species start hidden
    for (const f of this.fish) if (f.sp.rare) { f.hidden = true; f.root.visible = false; }
    // milestones already reached by the founders are not news
    const schools = schoolSizes(world, world.now());
    for (const [id, n] of Object.entries(schools)) for (const m of SCHOOL_MARKS) if (n >= m) world.mark(`school-${id}-${m}`);
    this.lifeT = 0;
    this.saveT = 0;
    this.lastLife = world.now();

    // schools
    this.schools = {};
    for (const sp of Object.values(SPECIES)) if (sp.school > 0.6) {
      this.schools[sp.id] = { target: new THREE.Vector3(rand(-3, 3), (sp.zone[0] + sp.zone[1]) / 2, rand(-1, 1)), goal: new THREE.Vector3(), next: 0, speed: 0.8, mode: 'roam', sp };
    }

    // ---------- critters ----------
    this.critters = buildCritters(this, scene);
    for (const c of this.critters) this.byId.set(c.id, c);

    // ---------- food ----------
    this.foodSys = new Food(scene, this);

    // ---------- bubble sources ----------
    const aer = new THREE.Vector3(-2.65, sandHeight(-2.65, -2.05) + 0.05, -2.05);
    this.aerator = bubbles.addSource('аэратора', aer, 16, 0.008, 0.03, 0.05);
    this.filterSrc = bubbles.addSource('фильтра', tank.filterOutlet.clone().add(new THREE.Vector3(-0.1, -0.05, 0)), 5, 0.005, 0.014, 0.04);
    this.filterSrc.vel = new THREE.Vector3(-0.8, -0.1, 0.2);
    this.diverSrc = bubbles.addSource('водолаза', decor.diverHelmet, 0, 0.01, 0.035, 0.02);
    this.chestSrc = bubbles.addSource('сундука', decor.chest.pos, 0, 0.01, 0.05, 0.15);
    this.sandSrc = bubbles.addSource('песка', new THREE.Vector3(), 0, 0.01, 0.03, 0.02);
    // small aerator stone
    const stone = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.08, 16), new THREE.MeshStandardMaterial({ color: '#4a4f57', roughness: 0.9 }));
    stone.position.copy(aer).add(new THREE.Vector3(0, -0.03, 0));
    scene.add(stone);

    this.nextEvent = rand(6, 12);
    this.nextRare = rand(50, 90);
    this.nextMemory = 30;
    this.nextDiver = rand(6, 14);
  }

  get store() { return this.world.state; }
  /** Save the world, with what each fish has come to like and whom it is friends with. */
  save() {
    for (const f of this.fish) {
      f.rec.fav = f.fav?.name || null;
      const friends = [...f.mem.friends.entries()].filter(([, v]) => v > 0.1).sort((a, b) => b[1] - a[1]).slice(0, 5);
      f.rec.friends = Object.fromEntries(friends.map(([id, v]) => [this.byId.get(id)?.uid, Math.round(v * 100) / 100]).filter(([u]) => u));
    }
    this.world.save();
  }
  rename(f, name) {
    f.name = name;
    f.rec.name = name;
    this.save();
  }
  onFish(cb) { this.fishListeners.push(cb); }

  /** The shared instanced meshes for every fish drawn from one model. */
  fishBatch(sp, key, asset) {
    if (!this.batches.has(key)) this.batches.set(key, new FishBatch(sp, asset, this.scene));
    return this.batches.get(key);
  }

  /** Bring a saved fish into the scene (optionally at a point, e.g. a nest). */
  spawnFish(rec, at) {
    const idx = this.fish.filter((o) => o.sp.id === rec.sp).length;
    const f = new Fish(this, rec, idx);
    this.fish.push(f);
    this.byId.set(f.id, f);
    this.byUid.set(rec.uid, f);
    this.scene.add(f.root);
    if (at) f.init(at);
    for (const cb of this.fishListeners) cb(f);
    return f;
  }

  /** A notable moment: shown now and kept in the aquarium's history. */
  chronicle(kind, text, pos, opts = {}) {
    this.world.log(kind, text);
    this.story(kind, text, pos, { cooldown: 0, ...opts, rare: true });
  }

  /** The user adds a young fish of a species (if there is room for it). */
  addFish(spId) {
    const sp = SPECIES[spId];
    if (this.world.count(spId) >= (sp.life.breed?.cap || sp.count)) return null;
    const rec = this.world.newcomer(spId);
    const f = this.spawnFish(rec, new THREE.Vector3(rand(-3, 3), 4.9, rand(-0.5, 1)));
    f.setState('EXPLORE', { spot: pick(this.spots), point: f.randomZonePoint() }, 10);
    this.chronicle('newcomer', `В аквариуме новый житель: ${sp.title} ${f.name}`, f.pos, { focus: f });
    this.save();
    return f;
  }
  spotByName(n) { return this.spots.find((s) => s.name === n); }
  bubbleSources() { return [this.aerator, this.diverSrc, this.filterSrc]; }
  heightAt(x, z) { return sandHeight(x, z); }

  // ----------------------------------------------------------- height grid for walkers
  buildHeightGrid(walkables) {
    const sx = 0.1;
    const nx = Math.ceil((TANK.W - 0.3) / sx) + 1, nz = Math.ceil((TANK.D - 0.3) / sx) + 1;
    const x0 = -(TANK.W - 0.3) / 2, z0 = -(TANK.D - 0.3) / 2;
    const h = new Float32Array(nx * nz), deco = new Uint8Array(nx * nz);
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const o = new THREE.Vector3();
    for (const w of walkables) w.updateWorldMatrix(true, false);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + i * sx, z = z0 + j * sx;
      let y = sandHeight(x, z);
      o.set(x, 7, z);
      ray.set(o, down);
      ray.far = 7;
      const hit = ray.intersectObjects(walkables, false)[0];
      if (hit && hit.point.y > y && hit.point.y < 5.3) { y = hit.point.y; deco[j * nx + i] = 1; }
      h[j * nx + i] = y;
    }
    this.grid = { h, deco, nx, nz, x0, z0, sx };
  }
  surfaceAt(x, z) {
    const g = this.grid;
    const fx = clamp((x - g.x0) / g.sx, 0, g.nx - 1.001), fz = clamp((z - g.z0) / g.sx, 0, g.nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const a = g.h[j * g.nx + i], b = g.h[j * g.nx + i + 1], c = g.h[(j + 1) * g.nx + i], d = g.h[(j + 1) * g.nx + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }
  surfaceNormal(x, z) {
    const e = 0.08;
    const hx = this.surfaceAt(x + e, z) - this.surfaceAt(x - e, z);
    const hz = this.surfaceAt(x, z + e) - this.surfaceAt(x, z - e);
    const n = new THREE.Vector3(-hx, 2 * e, -hz).normalize();
    // limit tilt so walkers don't look glued sideways
    if (n.y < 0.45) { n.y = 0.45; n.normalize(); }
    return n;
  }
  surfacePoint(x, z) {
    x = clamp(x, -5.7, 5.7); z = clamp(z, -2.2, 2.2);
    return new THREE.Vector3(x, this.surfaceAt(x, z), z);
  }
  randomSurfacePoint(groundOnly, near, radius = 2) {
    for (let k = 0; k < 30; k++) {
      let x, z;
      if (near) { x = near.x + rand(-radius, radius); z = near.z + rand(-radius, radius) * 0.6; }
      else { x = rand(-5.6, 5.6); z = rand(-2.1, 2.1); }
      x = clamp(x, -5.7, 5.7); z = clamp(z, -2.2, 2.2);
      const y = this.surfaceAt(x, z);
      if (groundOnly && y > sandHeight(x, z) + 0.05) continue;
      return new THREE.Vector3(x, y, z);
    }
    return this.surfacePoint(near ? near.x : 0, near ? near.z : 1.5);
  }

  // ----------------------------------------------------------- stories
  onStory(cb) { this.listeners.push(cb); }
  story(kind, text, pos, opts = {}) {
    const cd = opts.cooldown ?? 15;
    if (this.cool[kind] && this.time < this.cool[kind]) return false;
    if (!opts.rare && this.time - this.lastStoryT < 4.5) return false;
    this.cool[kind] = this.time + cd;
    this.lastStoryT = this.time;
    const s = { kind, text, pos: pos ? pos.clone() : null, focus: opts.focus || null, rare: !!opts.rare, t: this.time };
    this.storyLog.unshift(s);
    if (this.storyLog.length > 40) this.storyLog.pop();
    for (const l of this.listeners) l(s);
    return true;
  }
  after(sec, fn) { this.timers.push({ t: this.time + sec, fn }); }

  // ----------------------------------------------------------- user actions
  feed(x, auto = false) {
    const px = x ?? rand(-4, 4);
    const pz = rand(-0.8, 1.2);
    const type = this.world.state.feeder.food;
    this.foodSys.drop(px, pz, 30, type);
    this.after(rand(0.6, 1.4), () => this.foodSys.drop(px + rand(-1.2, 1.2), pz + rand(-0.3, 0.3), 18, type));
    if (type === 'worms') for (const f of this.fish) f.hunger = Math.min(1, f.hunger + 0.3);   // a treat!
    (this.tank.ripples ||= []).push({ x: px, z: pz, t: this.time });
    this.lastFeed = { x: px, z: pz, t: this.time };
    for (const f of this.fish) {
      if (f.hidden) continue;
      // fish that remember feeding place react faster
      if (f.mem.foodSpot && f.mem.foodSpot.distanceTo(new THREE.Vector3(px, f.mem.foodSpot.y, pz)) < 2 && Math.random() < 0.6) f.thinkT = 0;
    }
    const text = auto
      ? pick(['Автокормушка: время обеда', 'Автокормушка насыпала корм', 'По расписанию — обед!'])
      : pick(['Время обеда! Корм опускается в воду', 'Кормление! Все к поверхности', 'Сверху посыпался корм…']);
    this.story('feed', text, new THREE.Vector3(px, 5, pz), { rare: true, cooldown: 2 });
  }

  /** Feed by the schedule; a meal missed while the page was closed is served shortly after opening. */
  feederCheck(t) {
    const F = this.world.state.feeder;
    if (!F.on) return;
    const day = new Date(t);
    let slot = 0;
    for (const back of [0, 1]) {
      for (const hr of FEED_TIMES[F.perDay] || FEED_TIMES[3]) {
        const d = new Date(day);
        d.setDate(d.getDate() - back);
        d.setHours(hr, 0, 0, 0);
        if (d.getTime() <= t) slot = Math.max(slot, d.getTime());
      }
    }
    if (slot > F.last) {
      F.last = t;
      this.feed(undefined, true);
    }
  }

  eatFood(f, eater) {
    if (f.eaten) return;
    f.eaten = true;
    if (eater.kind === 'fish') {
      eater.hunger = Math.max(0, eater.hunger - 0.12);
      eater.gulp = 1;
      eater.mem.meals++;
      const lf = this.lastFeed;
      if (lf) {
        const spot = new THREE.Vector3(lf.x, 4.8, lf.z);
        eater.mem.foodSpot = eater.mem.foodSpot ? eater.mem.foodSpot.lerp(spot, 0.3) : spot;
      }
      const rivals = [...f.claim].filter((o) => o !== eater && o.kind === 'fish' && o.state === 'EAT' && o.ctx.food === f && o.pos.distanceTo(f.pos) < 0.7);
      if (rivals.length >= 3) this.story('many', `Сразу ${rivals.length + 1} рыбки гнались за одним кусочком — повезло ${eater.name}`, f.pos, { cooldown: 25, focus: eater });
      else if (rivals.length) {
        const r = rivals[0];
        if (eater.size < r.size * 0.6) this.story('small-steal', `Маленький ${eater.name} утащил корм прямо у ${r.name}!`, f.pos, { cooldown: 25, focus: eater });
        else this.story('steal', pick([`${eater.name} стащил корм прямо из-под носа у ${r.name}`, `${eater.name} оказался шустрее, чем ${r.name}`]), f.pos, { cooldown: 25, focus: eater });
        eater.remember(r, 'соперничали за корм', -0.03);
        r.remember(eater, 'украл корм', -0.06);
      }
      if (eater.mem.meals === 1 && eater.p.gluttony > 0.8 && Math.random() < 0.4) this.story('first', `${eater.name}, как всегда, первым у корма`, f.pos, { cooldown: 40, focus: eater });
    } else {
      if (Math.random() < 0.4) this.story('critter-eat', `${eater.title} ${eater.name} подобрал${eater.kind === 'snail' ? 'а' : ''} кусочек корма со дна`, f.pos, { cooldown: 40, focus: eater });
    }
  }

  tap(point) {
    let scared = 0, curious = [];
    for (const f of this.fish) {
      if (f.hidden) continue;
      const d = f.pos.distanceTo(point);
      if (d > 2.6) continue;
      if (f.p.curiosity > 0.65 && f.p.bravery > 0.55 && Math.random() < 0.5) {
        curious.push(f);
        this.after(rand(0.8, 2.2), () => f.setState('CURIOUS', { point: point.clone() }, rand(4, 8)));
        f.flee(point, 0.4);
      } else {
        f.flee(point, 0.6 + (2.6 - d) * 0.6 * (0.5 + f.p.shyness));
        scared++;
        // come back after a while
        this.after(rand(3, 7), () => { if (f.state !== 'EAT') f.setState(f.sp.school > 0.6 ? 'SCHOOL' : 'RETURN'); });
      }
    }
    for (const c of this.critters) if (c.pos.distanceTo(point) < 1.8) c.scare(point);
    if (curious.length && Math.random() < 0.6) this.story('tap-curious', `${curious[0].name} не испугался и подплыл посмотреть, кто стучит`, point, { cooldown: 20, focus: curious[0] });
    else if (scared > 3) this.story('tap', pick(['Тук-тук! Рыбки бросились врассыпную', 'Стук по стеклу напугал рыбок', 'Ой! Все разбежались']), point, { cooldown: 15 });
  }

  clickProp(kind) {
    const d = this.decor;
    if (kind === 'chest') {
      d.chest.target = 1;
      this.chestSrc.burst = 1.2;
      this.after(7, () => { d.chest.target = 0; });
      const near = this.fish.filter((f) => !f.hidden && f.p.curiosity > 0.4).sort((a, b) => a.pos.distanceTo(d.chest.pos) - b.pos.distanceTo(d.chest.pos)).slice(0, 4);
      for (const f of near) this.after(rand(0.5, 2), () => f.setState('INVESTIGATE', { spot: this.spotByName('сундук'), ang: rand(0, 6), dir: 1 }, rand(5, 9)));
      this.chestOpens = (this.chestOpens || 0) + 1;
      this.story('chest', this.chestOpens === 3 ? 'Сундук снова открыт… кажется, рыбки уже привыкли к сокровищам' : 'Сундук приоткрылся — из него вырвались пузыри!', d.chest.pos, { rare: true, cooldown: 3 });
      this.secret('chest');
    } else if (kind === 'bottle') {
      const notes = [
        'Записка в бутылке: «Если смотреть достаточно долго, рыбки начнут смотреть в ответ»',
        'Записка в бутылке: «Здесь был Капитан. Сокровище — в сундуке. Пароль: пузырь»',
        'Записка в бутылке: «Ночью в пещере что-то светится…»',
        'Записка в бутылке: «Говорят, когда-то здесь проплывала резиновая уточка»',
      ];
      this.story('bottle', pick(notes), null, { rare: true, cooldown: 2 });
      this.secret('bottle');
    } else if (kind === 'crystal') {
      this.decor.crystalLight.intensity = 6;
      this.story('crystal', 'Вы нашли секретный кристалл в пещере! Рыбки слетаются посмотреть', this.decor.secretCave.pos, { rare: true, cooldown: 5 });
      for (const f of this.fish.filter((f) => !f.hidden).sort(() => Math.random() - 0.5).slice(0, 6)) {
        f.setState('INVESTIGATE', { spot: this.spotByName('пещера'), ang: rand(0, 6), dir: 1 }, rand(6, 10));
      }
      this.secret('crystal');
    }
  }
  secret(id) {
    const s = this.store.secrets || (this.store.secrets = []);
    if (!s.includes(id)) { s.push(id); this.save(); }
  }

  // ----------------------------------------------------------- scheduled mini-stories
  pickFish(filter) {
    const c = this.fish.filter((f) => !f.hidden && filter(f));
    return c.length ? pick(c) : null;
  }

  miniEvent() {
    const night = this.night;
    const events = [
      [1.0 * (1 - night), () => { // neon race
        const s = this.schools.neon; if (!s) return;
        s.mode = 'race'; s.raceT = 0; this.after(rand(7, 11), () => (s.mode = 'roam'));
        this.story('race', pick(['Неоны устроили гонку!', 'Стайка неонов носится наперегонки']), s.target, { cooldown: 60 });
      }],
      [0.9, () => { // guppies found new place
        const s = pick(this.spots.filter((q) => q.kind !== 'hide'));
        for (const f of this.fish) if (f.sp.id === 'guppy' && !f.hidden && f.state !== 'EAT') f.setState('EXPLORE', { spot: s, point: f.randomPointNear(s.pos, 0.8) }, rand(10, 16));
        this.story('guppy', `Гуппи нашли новое место: ${s.name}`, s.pos, { cooldown: 60 });
      }],
      [0.8, () => { // catfish & cave
        const f = this.pickFish((f) => f.sp.id === 'cory'); if (!f) return;
        f.setState('INVESTIGATE', { spot: this.spotByName('пещера'), ang: 0, dir: 1 }, 12);
        this.story('cory-cave', `Сомик ${f.name} исследует пещеру`, f.pos, { cooldown: 60, focus: f });
      }],
      [0.8, () => { // shrimp climbs driftwood
        const s = pick(this.critters.filter((c) => c.kind === 'shrimp'));
        const wc = this.decor.woodCenter;
        s.startHop(this.surfacePoint(wc.x + rand(-1, 1), wc.z + rand(-0.2, 0.3)), 0.5);
        this.story('shrimp-wood', `Креветка ${s.name} забралась на корягу`, wc, { cooldown: 60, focus: s });
      }],
      [0.7, () => { // goldfish chases a bubble
        const f = this.pickFish((f) => f.sp.id === 'goldfish'); if (!f) return;
        const p = this.randomSurfacePoint(true);
        const b = this.bubbles.spawn(p.clone().add(new THREE.Vector3(0, 0.05, 0)), 0.06, new THREE.Vector3(0, 0.05, 0));
        if (!b) return;
        f.setState('SCRIPT', { point: b.pos, speed: 1.1, label: 'Преследует пузырь' }, 7);
        this.story('gold-bubble', `Золотая рыбка ${f.name} преследует пузырь`, p, { cooldown: 60, focus: f });
      }],
      [0.6, () => { // dispute over shelter
        const a = this.pickFish((f) => !f.sp.school && f.size > 0.35 && f.state !== 'EAT');
        const b = a && this.pickFish((f) => f !== a && !f.sp.school && f.size > 0.35 && f.state !== 'EAT');
        if (!a || !b) return;
        const s = pick(this.spots.filter((q) => q.kind === 'hide' || q.kind === 'cave'));
        a.setState('SCRIPT', { point: s.pos.clone().add(new THREE.Vector3(0.2, 0.2, 0.3)), speed: 1, label: `Плывёт к укрытию (${s.name})` }, 8);
        b.setState('SCRIPT', { point: s.pos.clone().add(new THREE.Vector3(-0.2, 0.2, 0.3)), speed: 1, label: `Плывёт к укрытию (${s.name})` }, 8);
        this.after(6, () => {
          if (a.state === 'SCRIPT' && b.state === 'SCRIPT' && a.dist(b) < 1.5) {
            a.startStandoff(b);
            this.cool.standoff = 0;
            this.story('dispute', `${a.name} и ${b.name} спорят за укрытие`, s.pos, { cooldown: 60, focus: a, rare: true });
          }
        });
      }],
      [0.7, () => { // snail trip
        const s = pick(this.critters.filter((c) => c.kind === 'snail'));
        s.journey();
        this.story('snail-trip', `Улитка ${s.name} отправилась в путешествие`, s.pos, { cooldown: 90, focus: s });
      }],
      [0.6, () => { // barb mischief
        const b = this.pickFish((f) => f.sp.id === 'barb');
        const t = this.pickFish((f) => f.sp.id === 'angelfish' || f.sp.id === 'goldfish' || f.sp.id === 'betta');
        if (!b || !t) return;
        b.setState('PLAY', { other: t, role: 'chase', tags: 0 }, 6);
        t.setState('PLAY', { other: b, role: 'run', tags: 0 }, 6);
        this.story('mischief', `Барбус ${b.name} дразнит ${t.name} — хулиган!`, b.pos, { cooldown: 60, focus: b });
      }],
      [0.6, () => { // circle plant
        const c = pick(this.clumps);
        const group = this.fish.filter((f) => !f.hidden && !f.sp.bottom && f.p.playfulness > 0.4 && f.state !== 'EAT').sort(() => Math.random() - 0.5).slice(0, Math.floor(rand(3, 6)));
        if (group.length < 3) return;
        const center = c.pos.clone().add(new THREE.Vector3(0, 0.8, 0));
        group.forEach((f, i) => f.setState('CIRCLE', { center, r: c.radius + 0.6, ang: (i / group.length) * Math.PI * 2, dir: 1 }, rand(8, 12)));
        this.story('circle-group', `Несколько рыбок кружат вокруг растения (${c.name})`, center, { cooldown: 80, focus: group[0] });
      }],
      [0.5, () => { // cory air
        const f = this.pickFish((f) => f.sp.id === 'cory'); if (f) f.enter('AIR');
      }],
      [0.6, () => { // friends
        const f = this.pickFish((f) => f.bestFriend()); if (f) f.enter('SOCIALIZE', f.bestFriend());
      }],
      [0.5, () => { // play pair
        const f = this.pickFish((f) => f.p.playfulness > 0.6 && !f.sp.bottom); if (f) f.enter('PLAY');
      }],
      [0.4, () => { // diver burps
        this.diverSrc.burst = 0.6;
        this.story('diver', 'Водолаз выпустил облачко пузырей', this.decor.diverHelmet, { cooldown: 60 });
      }],
      [0.5, () => { // sand bubble
        const p = this.randomSurfacePoint(true);
        this.sandSrc.pos.copy(p); this.sandSrc.burst = 0.25;
        const f = this.pickFish((q) => q.p.curiosity > 0.6 && q.pos.distanceTo(p) < 3);
        if (f) { f.setState('SCRIPT', { point: p.clone().add(new THREE.Vector3(0, 0.3, 0)), speed: 0.9, label: 'Изучает странные пузырьки', face: p }, 6); this.story('sand-bubble', `Из песка вырвались пузырьки — ${f.name} спешит разобраться`, p, { cooldown: 60, focus: f }); }
      }],
      [night * 1.4, () => { // night: sleepers & nocturnals
        const f = this.pickFish((f) => f.sp.nocturnal); if (!f) return;
        this.story('night-active', `Ночью ${f.name} особенно активен`, f.pos, { cooldown: 120, focus: f });
      }],
    ];
    let sum = 0; for (const e of events) sum += e[0];
    let r = Math.random() * sum;
    for (const e of events) { r -= e[0]; if (r <= 0) { e[1](); break; } }
  }

  rareEvent() {
    const night = this.night;
    const events = [
      [1.0, 'school-turn', () => {
        const s = this.schools[pick(Object.keys(this.schools))];
        const c = s.target.clone();
        s.goal.set(-c.x * 0.8, c.y, -c.z * 0.5);
        s.target.copy(s.goal); s.next = this.time + 8;
        for (const f of this.fish) if (f.sp === s.sp && !f.hidden) { f.vel.multiplyScalar(0.3); f.burst = 0.3; f.setState('SCHOOL'); }
        this.story('school-turn', `Вся стая «${s.sp.title}» синхронно развернулась!`, c, { rare: true, cooldown: 200 });
      }],
      [0.8, 'watcher', () => {
        const f = this.pickFish((f) => f.p.curiosity > 0.5 && !f.sp.bottom && f.sp.school < 0.6); if (!f) return;
        f.setState('WATCH', { ox: rand(-1.5, 1.5) }, rand(10, 16));
        this.story('watcher', `${f.name} уже долго наблюдает за вами…`, f.pos, { rare: true, cooldown: 240, focus: f });
      }],
      [0.8, 'cave-surprise', () => {
        const f = this.pickFish((f) => !f.sp.bottom && f.size < 0.7 && f.sp.school < 0.6); if (!f) return;
        const cave = this.spotByName('пещера');
        f.pos.copy(cave.pos).add(new THREE.Vector3(0, 0, -0.25));
        f.root.position.copy(f.pos);
        f.vel.set(0, 0.3, 1.5);
        f.heading.set(0, 0.2, 1).normalize();
        f.setState('FLEE', { dir: new THREE.Vector3(rand(-0.4, 0.4), 0.3, 1).normalize(), prev: 'IDLE' }, 1.2);
        this.story('cave-surprise', `Неожиданно из пещеры вынырнул ${f.name}!`, cave.pos, { rare: true, cooldown: 200, focus: f });
      }],
      [0.7, 'shrimp-odd', () => {
        const s = pick(this.critters.filter((c) => c.kind === 'shrimp'));
        let best = null;
        for (let i = 0; i < 300; i++) { const p = this.randomSurfacePoint(false); if (!best || p.y > best.y) best = p; }
        s.startHop(best, 1.2);
        this.story('shrimp-odd', `Креветка ${s.name} забралась в совершенно неожиданное место`, best, { rare: true, cooldown: 240, focus: s });
      }],
      [0.6, 'snail-top', () => {
        const s = pick(this.critters.filter((c) => c.kind === 'snail' && c.mode === 'glass'));
        if (s) { s.goalTop = true; s.reachedTop = false; }
      }],
      [0.6, 'group-play', () => {
        const players = this.fish.filter((f) => !f.hidden && f.p.playfulness > 0.5 && !f.sp.bottom && f.size < 0.6).sort(() => Math.random() - 0.5).slice(0, 6);
        for (let i = 0; i + 1 < players.length; i += 2) {
          players[i].setState('PLAY', { other: players[i + 1], role: 'chase', tags: 0 }, 10);
          players[i + 1].setState('PLAY', { other: players[i], role: 'run', tags: 0 }, 10);
        }
        if (players.length >= 4) this.story('group-play', 'Несколько рыбок затеяли общую игру в догонялки!', players[0].pos, { rare: true, cooldown: 200, focus: players[0] });
      }],
      [0.25, 'carousel', () => {
        const center = new THREE.Vector3(0, 3.0, 0.1);
        const list = this.fish.filter((f) => !f.hidden && !f.sp.bottom);
        list.forEach((f, i) => f.setState('CAROUSEL', { center, r: 3.6, rx: 3.8 + rand(-0.4, 0.4), rz: 1.5 + rand(-0.2, 0.2), dy: rand(-1, 1.2), ang: (i / list.length) * Math.PI * 2, dir: 1, angSpeed: 0.35 }, rand(14, 18)));
        this.story('carousel', '✨ Редкое событие: все рыбки закружились в большой карусели!', center, { rare: true, cooldown: 600 });
        this.secret('carousel');
      }],
      [0.2, 'duck', () => {
        const d = this.decor.duck;
        d.visible = true; d.position.set(-6.3, TANK.waterY + 0.05, rand(-1, 1));
        this.duckRun = { t: 0, dur: 45, z: d.position.z };
        this.story('duck', 'По поверхности проплывает… резиновая уточка?!', d.position, { rare: true, cooldown: 900 });
        this.secret('duck');
        for (const f of this.fish.filter((f) => !f.hidden && f.p.curiosity > 0.6).slice(0, 5)) {
          this.after(rand(2, 8), () => f.setState('SCRIPT', { point: d.position.clone().setY(5.0), speed: 0.8, label: 'Разглядывает уточку', face: d.position }, 8));
        }
      }],
      [night > 0.6 ? 2.0 : 0, 'moonfish', () => {
        const m = this.fish.find((f) => f.sp.id === 'moonfish' && f.hidden);
        if (!m) return;
        const cave = this.spotByName('пещера');
        m.hidden = false; m.root.visible = true;
        m.pos.copy(cave.pos); m.root.position.copy(m.pos);
        m.setState('EXPLORE', { spot: pick(this.spots), point: m.randomZonePoint() }, 14);
        this.story('moonfish', `✨ Из пещеры выплыла светящаяся Лунная рыбка — ${m.name}`, cave.pos, { rare: true, cooldown: 300, focus: m });
        this.secret('moonfish');
      }],
    ];
    let sum = 0; for (const e of events) sum += e[0];
    let r = Math.random() * sum;
    for (const e of events) { r -= e[0]; if (r <= 0) { e[2](); break; } }
  }

  memoryTick() {
    for (const f of this.fish) {
      if (f.hidden) continue;
      let best = null, bv = 0;
      for (const [n, v] of Object.entries(f.mem.visits)) if (v > bv) { bv = v; best = n; }
      const favV = f.mem.visits[f.fav.name] || 0;
      if (best && best !== f.fav.name && bv > favV + 5 && Math.random() < 0.25) {
        const s = this.spotByName(best);
        if (s) {
          f.fav = s;
          if (f.p.territoriality < 0.5) f.home = s;
          this.story('new-fav', `${f.name}, похоже, нашёл новое любимое место: ${s.name}`, s.pos, { cooldown: 90, focus: f });
        }
      }
      // slow decay keeps memory "fresh"
      for (const k in f.mem.visits) f.mem.visits[k] *= 0.97;
    }
  }

  updateSchools(dt) {
    for (const s of Object.values(this.schools)) {
      const sp = s.sp;
      if (s.mode === 'race') {
        s.raceT += dt;
        const a = s.raceT * 0.9;
        s.goal.set(Math.cos(a) * 4.3, (sp.zone[0] + sp.zone[1]) / 2 + Math.sin(a * 2) * 0.5, Math.sin(a) * 1.4);
        s.target.lerp(s.goal, Math.min(1, dt * 3));
        s.speed = 1.9;
        continue;
      }
      s.speed += (0.85 - s.speed) * dt;
      if (this.time > s.next) {
        s.next = this.time + rand(4, 11);
        for (let k = 0; k < 10; k++) {
          s.goal.set(rand(-4.8, 4.8), rand(sp.zone[0] + 0.4, sp.zone[1]), rand(-1.6, 1.7));
          if (!this.colliders.some((c) => c.c.distanceTo(s.goal) < c.r + 0.5)) break;
        }
        if (this.night > 0.6) s.goal.y = Math.min(s.goal.y, 2.2);
      }
      const step = Math.min(1, dt * 0.35);
      s.target.lerp(s.goal, step);
    }
  }

  /** Every few seconds: growth, pairs, broods, milestones, the feeder, saving. */
  lifeUpdate() {
    const w = this.world, t = w.now();
    for (const f of this.fish) {
      const prev = f.stage;
      f.updateLife(t);
      if (prev !== f.stage) this.onStage(f, prev);
    }
    const out = [];
    lifeTick(w, t, (t - this.lastLife) / DAY, true, out);
    this.lastLife = t;
    for (const e of out) {
      const f = this.byUid.get(e.f.uid), m = this.byUid.get(e.m.uid);
      if (e.type === 'pair') this.story('pair', `${e.f.name} и ${e.m.name} стали парой`, f?.pos, { rare: true, cooldown: 0, focus: f });
      if (e.type === 'due') this.startNesting(e, f, m);
    }
    // schools growing, friendships forming, first visits to the cave
    for (const [id, n] of Object.entries(schoolSizes(w, t))) {
      for (const mk of SCHOOL_MARKS) {
        if (n >= mk && w.mark(`school-${id}-${mk}`)) this.chronicle('school', `Стая «${SPECIES[id].title}» выросла до ${count(n, ['рыбки', 'рыбок', 'рыбок'])}`, this.schools[id]?.target);
      }
    }
    for (const f of this.fish) {
      if (f.hidden) continue;
      // only a lasting friendship makes it into the history, and not too often
      const b = f.bestFriend();
      if (b && f.mem.friends.get(b.id) > 0.8 && this.time - (this.friendLogT ?? -1e9) > 600 && w.mark(`friends-${Math.min(f.uid, b.uid)}-${Math.max(f.uid, b.uid)}`)) {
        this.friendLogT = this.time;
        this.chronicle('friends', `${f.name} и ${b.name} подружились — теперь их часто видят вместе`, f.pos, { focus: f });
      }
      if (f.mem.discoveries.has('пещера') && f.stage !== 'fry' && w.mark(`cave-${f.uid}`) && Math.random() < 0.5) {
        this.chronicle('cave', `${f.name} впервые заплыл${f.sex === 'f' ? 'а' : ''} в пещеру`, this.spotByName('пещера')?.pos, { focus: f });
      }
    }
    if (this.plants.tick(t)) this.story('plant', 'Одно из растений пустило новый побег', null, { rare: true, cooldown: 60 });
    this.feederCheck(t);
  }

  onStage(f, prev) {
    const w = this.world, r = f.rec;
    const family = r.parentNames || [];
    const brood = `${r.sp}-${Math.round(r.born / 60000)}`;
    if (prev === 'fry' && f.stage === 'juvenile' && w.mark(`grew-${brood}`)) {
      this.chronicle('grew', family.length === 2 ? `Подросли мальки пары ${family[0]} и ${family[1]} — теперь они осваивают аквариум` : `${f.name} подрос${f.sex === 'f' ? 'ла' : ''}`, f.pos, { focus: f });
    } else if (prev === 'juvenile' && f.stage === 'adult' && w.mark(`adult-${brood}`)) {
      this.chronicle('adult', family.length === 2 ? `Повзрослели дети пары ${family[0]} и ${family[1]}` : `${f.name} стал${f.sex === 'f' ? 'а' : ''} взрослой рыбкой`, f.pos, { focus: f });
    } else if (prev === 'adult' && f.stage === 'elder') {
      this.chronicle('elder', `${f.name} теперь старожил аквариума`, f.pos, { focus: f });
    }
  }

  /** A brood is due: the pair picks a sheltered spot, circles over it, then the fry appear. */
  startNesting(e, f, m) {
    const w = this.world, sp = SPECIES[e.f.sp];
    w.pending[sp.id] = (w.pending[sp.id] || 0) + e.n;
    const near = (f || m)?.fav?.pos || new THREE.Vector3();
    const cands = this.spots.filter((s) => s.kind === 'plants' || s.kind === 'hide' || (sp.homeKind === 'anemone' && s.name === 'актиния'));
    const spot = cands.sort((a, b) => a.pos.distanceTo(near) - b.pos.distanceTo(near) + rand(-1, 1))[0];
    const nest = sp.homeKind === 'anemone' ? this.spotByName('актиния') : spot;
    for (const p of [f, m]) if (p && !p.hidden) p.setState('NEST', { spot: nest, ang: rand(0, 6.28), dir: p === f ? 1 : -1 }, 40);
    if (f) this.story('nest', sp.life.breed.live ? `${f.name} ждёт малышей у ${nest.name}` : `${e.f.name} и ${e.m.name} выбрали место для икры: ${nest.name}`, nest.pos, { rare: true, cooldown: 0, focus: f });
    this.after(rand(28, 40), () => {
      w.pending[sp.id] -= e.n;
      const kids = brood(w, e.f, e.m, w.now(), e.n, nest.name);
      let first = null;
      for (const k of kids) {
        const fk = this.spawnFish(k, nest.pos.clone().add(new THREE.Vector3(rand(-0.25, 0.25), rand(0, 0.2), rand(-0.15, 0.15))));
        first ||= fk;
      }
      this.sandSrc.pos.copy(nest.pos); this.sandSrc.burst = 0.3;
      const rare = kids.find((k) => k.gene.rare);
      this.story('birth', `${e.f.name} и ${e.m.name} стали родителями: ${fryWord(kids.length)}!`, nest.pos, { rare: true, cooldown: 0, focus: first });
      if (rare) this.after(6, () => this.story('rare-color', `Один из малышей — ${rare.name} — с необычным окрасом: ${RARE[rare.gene.rare].title}`, nest.pos, { rare: true, cooldown: 0, focus: this.byUid.get(rare.uid) }));
      if (sp.life.breed.care) for (const p of [f, m]) if (p) p.guardUntil = w.now() + DAY * 0.5;
      this.save();
    });
  }

  update(dt) {
    this.time += dt;
    this.lifeT -= dt;
    if (this.lifeT <= 0) { this.lifeT = 4; this.lifeUpdate(); }
    this.saveT -= dt;
    if (this.saveT <= 0) { this.saveT = 20; this.save(); }
    G.uNight.value = this.night;
    // timers
    for (let i = this.timers.length - 1; i >= 0; i--) if (this.time >= this.timers[i].t) { const t = this.timers[i]; this.timers.splice(i, 1); t.fn(); }
    this.updateSchools(dt);
    for (const f of this.fish) f.update(dt);
    for (const b of this.batches.values()) b.update();
    for (const c of this.critters) c.update(dt);
    this.foodSys.update(dt);

    // event scheduler — random intervals, never periodic
    if (this.time > this.nextEvent) { this.nextEvent = this.time + rand(9, 24); this.miniEvent(); }
    if (this.time > this.nextRare) { this.nextRare = this.time + rand(45, 110); this.rareEvent(); }
    if (this.time > this.nextMemory) { this.nextMemory = this.time + rand(25, 40); this.memoryTick(); }
    if (this.time > this.nextDiver) { this.nextDiver = this.time + rand(10, 30); this.diverSrc.burst = rand(0.15, 0.4); }

    // moonfish leaves at dawn
    for (const f of this.fish) if (f.sp.rare && !f.hidden && this.night < 0.3 && f.state !== 'SCRIPT') {
      const cave = this.spotByName('пещера');
      f.setState('SCRIPT', { point: cave.pos, speed: 1.2, label: 'Возвращается в пещеру' }, 20);
      this.after(8, () => { f.hidden = true; f.root.visible = false; });
    }
    // rubber duck crossing
    if (this.duckRun) {
      const d = this.decor.duck, r = this.duckRun;
      r.t += dt;
      d.position.x = -6.3 + (r.t / r.dur) * 12.6;
      d.position.y = TANK.waterY + 0.04 + Math.sin(this.time * 2) * 0.02;
      d.position.z = r.z + Math.sin(r.t * 0.3) * 0.4;
      d.rotation.z = Math.sin(this.time * 1.7) * 0.08;
      if (r.t > r.dur) { d.visible = false; this.duckRun = null; }
    }

    // push the biggest fish into the plant-sway uniform
    const arr = G.uFish.value;
    const big = this.fish.filter((f) => !f.hidden).sort((a, b) => b.size - a.size);
    for (let i = 0; i < arr.length; i++) {
      const f = big[i];
      if (f) arr[i].set(f.pos.x, f.pos.y, f.pos.z, f.size * 0.6 * Math.min(1.5, 0.3 + f.vel.length()));
      else arr[i].set(0, -100, 0, 0);
    }
  }
}
