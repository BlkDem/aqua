// The persistent aquarium: who lives here, when they were born, who their parents are, how
// the plants have grown and what has happened so far. It runs on real time, so the world
// keeps living while the page is closed (see lifecycle.js for what happens meanwhile).
import { SPECIES, NAMES } from './species.js';
import { hashStr, mulberry32, clamp, pick, rand } from '../fx/shaderPatch.js';
import { fishWord } from './words.js';

export const DAY = 86400000;
export const HOUR = 3600000;

// Trying things out: ?timescale=600 makes one real second ten world minutes, ?away=48
// pretends the last visit was 48 hours ago. Both keep their own save, the real one is untouched.
const params = new URLSearchParams(location.search);
const SCALE = Math.max(1, Number(params.get('timescale')) || 1);
const AWAY = Math.max(0, Number(params.get('away')) || 0) * HOUR;
const DEBUG = SCALE > 1 || AWAY > 0;
const KEY = DEBUG ? 'living-aquarium.v2.debug' : 'living-aquarium.v2';
const OLD_KEY = 'living-aquarium.v1';
const START = Date.now();

/** Move every timestamp of a saved world by d milliseconds. */
function shiftTime(st, d) {
  for (const k of ['created', 'lastSeen', 'clock']) if (st[k]) st[k] += d;
  for (const r of st.fish) { r.born += d; if (r.nextBrood) r.nextBrood += d; }
  for (const h of st.history) h.t += d;
  for (const k in st.marks) st.marks[k] += d;
  for (const p of [...Object.values(st.plants), ...st.extraPlants]) { p.planted += d; if (p.nextRunner) p.nextRunner += d; }
  st.feeder.last += d;
}

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
}

export class World {
  constructor() {
    const saved = read(KEY) || (DEBUG && read('living-aquarium.v2'));
    const fresh = !(saved && saved.v === 2);
    this.state = fresh ? this.create(read(OLD_KEY)) : saved;
    const st = this.state;
    // world clock: real time, or a sped-up clock that continues where the last debug run stopped
    this.base = DEBUG ? Math.max(START, st.clock || START) : START;
    if (AWAY) {
      // a brand new debug aquarium is moved into the past, as if it was set up and left back then
      if (fresh) shiftTime(st, -AWAY);
      st.lastSeen = this.now() - AWAY;
    }
    st.visits = (st.visits || 0) + 1;
    this.uids = new Map(st.fish.map((r) => [r.uid, r]));
  }

  now() { return this.base + (Date.now() - START) * SCALE; }

  /** A new world, or one carried over from the first version (names, personalities, secrets). */
  create(old) {
    const t = START; // the world clock is not set up yet
    const st = {
      v: 2, salt: old?.salt || Math.random().toString(36).slice(2), created: t, lastSeen: t, visits: old?.visits || 0,
      secrets: old?.secrets || [], nextUid: 1, fish: [], plants: {}, extraPlants: [], history: [],
      feeder: { on: true, perDay: 3, food: 'flakes', last: t }, marks: {},
    };
    this.state = st;
    const names = old?.names || {};
    for (const sp of Object.values(SPECIES)) {
      for (let i = 0; i < sp.count; i++) {
        const key = `${sp.id}-${i}`;
        // the same seed as before, so carried-over fish keep their personality and size
        const R = mulberry32(hashStr(st.salt + key));
        const traits = {};
        for (const k of Object.keys(sp.traits)) traits[k] = clamp(sp.traits[k] + (R() - 0.5) * 0.55, 0, 1);
        const size = 0.85 + R() * 0.3;
        const L = sp.life;
        // founders are grown up; in a brand new aquarium a few are still youngsters
        const young = !old && Math.random() < 0.25;
        const age = young ? rand(L.juvenile, L.adult * 0.9) : rand(L.adult + 1, Math.min(L.span * 0.5, L.adult + 25));
        st.fish.push({
          uid: st.nextUid++, sp: sp.id, name: names[key] || null, sex: sp.life.breed ? (i % 2 ? 'm' : 'f') : 'm',
          born: t - age * DAY, traits, gene: { size, tint: [1, 1, 1], variant: sp.variants ? i % sp.variants.length : 0, rare: null },
          parents: null, gen: 1, mate: null, nextBrood: null, fav: null, friends: {},
        });
      }
    }
    for (const r of st.fish) if (!r.name) r.name = this.takeName();
    this.log('start', old
      ? `Начата история аквариума: здесь живут ${fishWord(st.fish.length)}`
      : `Аквариум запущен: ${fishWord(st.fish.length)} и первые растения`, t);
    return st;
  }

  save() {
    this.state.clock = this.now();
    this.state.lastSeen = this.now();
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch (e) { /* storage full or blocked */ }
  }

  get fish() { return this.state.fish; }
  byUid(uid) { return this.uids.get(uid) || null; }
  count(spId) { return this.state.fish.filter((r) => r.sp === spId).length; }

  takeName() {
    const used = new Set(this.state.fish.map((r) => r.name));
    const free = NAMES.filter((n) => !used.has(n));
    if (free.length) return pick(free);
    for (const suffix of ['II', 'III', 'IV', 'V', 'VI']) {
      const free2 = NAMES.filter((n) => !used.has(`${n} ${suffix}`));
      if (free2.length) return `${pick(free2)} ${suffix}`;
    }
    return `Рыбка ${this.state.nextUid}`;
  }

  /** A history entry that stays with the aquarium. */
  log(kind, text, t = this.now()) {
    const h = this.state.history;
    h.push({ t, kind, text });
    h.sort((a, b) => a.t - b.t);
    if (h.length > 400) h.splice(0, h.length - 400);
  }

  /** Remember that something happened once (school size reached, friendship formed...). */
  mark(id) {
    if (this.state.marks[id]) return false;
    this.state.marks[id] = this.now();
    return true;
  }

  add(rec) {
    rec.uid = this.state.nextUid++;
    this.state.fish.push(rec);
    this.uids.set(rec.uid, rec);
    return rec;
  }

  remove(rec) {
    const i = this.state.fish.indexOf(rec);
    if (i >= 0) this.state.fish.splice(i, 1);
    this.uids.delete(rec.uid);
    for (const r of this.state.fish) if (r.mate === rec.uid) { r.mate = null; r.nextBrood = null; }
  }

  /** A fish bought or brought in by the user: a youngster of the given species. */
  newcomer(spId, t = this.now()) {
    const sp = SPECIES[spId];
    const traits = {};
    for (const k of Object.keys(sp.traits)) traits[k] = clamp(sp.traits[k] + (Math.random() - 0.5) * 0.55, 0, 1);
    return this.add({
      sp: spId, name: this.takeName(), sex: sp.life.breed ? (Math.random() < 0.5 ? 'f' : 'm') : 'm',
      born: t - rand(sp.life.juvenile, sp.life.adult * 0.8) * DAY, traits,
      gene: { size: rand(0.85, 1.15), tint: [1, 1, 1], variant: sp.variants ? Math.floor(Math.random() * sp.variants.length) : 0, rare: null },
      parents: null, gen: 1, mate: null, nextBrood: null, fav: null, friends: {},
    });
  }
}
