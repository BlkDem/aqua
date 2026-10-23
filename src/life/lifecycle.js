// Growth, pairs, broods and inheritance. These rules work on the saved fish records, so the
// same code runs live (the ecosystem stages the courtship and birth on screen) and in a
// quick catch-up for the time the aquarium was closed.
import { SPECIES } from './species.js';
import { DAY, HOUR } from './world.js';
import { clamp, pick, rand } from '../fx/shaderPatch.js';
import { fryWord } from './words.js';

export const ageDays = (rec, t) => (t - rec.born) / DAY;

export function stageOf(rec, t) {
  const L = SPECIES[rec.sp].life, a = ageDays(rec, t);
  if (a < L.juvenile) return 'fry';
  if (a < L.adult) return 'juvenile';
  return a > L.span * 0.75 ? 'elder' : 'adult';
}

/** Body length relative to an adult: a fry hatches at 30% and grows quickly at first. */
export function growthOf(rec, t) {
  const u = clamp(ageDays(rec, t) / SPECIES[rec.sp].life.adult, 0, 1);
  return 0.3 + 0.7 * (1 - (1 - u) * (1 - u));
}

export const STAGE = { fry: 'малёк', juvenile: 'подросток', adult: 'взрослая рыбка', elder: 'старожил' };

// rare colours that show up now and then in a brood (multiplied over the body texture)
export const RARE = {
  gold: { title: 'золотистый окрас', tint: [1.0, 0.8, 0.42] },
  pearl: { title: 'жемчужный окрас', tint: [0.9, 0.94, 1.0] },
  sapphire: { title: 'сапфировый окрас', tint: [0.62, 0.74, 1.0] },
  rose: { title: 'розовый окрас', tint: [1.0, 0.72, 0.84] },
};

const vary = (a, b, j) => (a + b) / 2 + (Math.random() - 0.5) * j;
// all fish together: beyond this the aquarium gets crowded (and slow)
export const POPULATION_CAP = 75;

/** A child record: looks and character are a mix of the parents with a little variation. */
export function inherit(world, mom, dad, t, nursery) {
  const sp = SPECIES[mom.sp];
  const traits = {};
  for (const k of Object.keys(mom.traits)) traits[k] = clamp(vary(mom.traits[k], dad.traits[k], 0.25), 0, 1);
  let variant = pick([mom, dad]).gene.variant;
  let rare = null;
  if (sp.variants?.length > 1 && Math.random() < 0.05) variant = Math.floor(Math.random() * sp.variants.length);
  if (Math.random() < 0.025) rare = pick(Object.keys(RARE));
  else if (mom.gene.rare && mom.gene.rare === dad.gene.rare && Math.random() < 0.5) rare = mom.gene.rare;
  else if ((mom.gene.rare || dad.gene.rare) && Math.random() < 0.2) rare = mom.gene.rare || dad.gene.rare;
  const tint = rare ? RARE[rare].tint.slice() : mom.gene.tint.map((v, i) => clamp(vary(v, dad.gene.tint[i], 0.07), 0.72, 1));
  return world.add({
    sp: sp.id, name: world.takeName(), sex: Math.random() < 0.5 ? 'f' : 'm', born: t, traits,
    gene: { size: clamp(vary(mom.gene.size, dad.gene.size, 0.1), 0.8, 1.25), tint, variant, rare },
    parents: [mom.uid, dad.uid], parentNames: [mom.name, dad.name], gen: Math.max(mom.gen || 1, dad.gen || 1) + 1,
    mate: null, nextBrood: null, fav: null, friends: {}, nursery,
  });
}

export function pair(world, f, m, t) {
  const B = SPECIES[f.sp].life.breed;
  f.mate = m.uid; m.mate = f.uid;
  // the very first pair of a new aquarium gets on with it, so there is something to discover early
  const first = world.mark('first-pair');
  f.nextBrood = t + (first ? rand(0.75, 1.5) * HOUR : B.every * rand(0.4, 0.7) * DAY);
  world.log('pair', `${f.name} и ${m.name} стали парой (${SPECIES[f.sp].title})`, t);
}

export function brood(world, f, m, t, n, nursery) {
  const B = SPECIES[f.sp].life.breed;
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(inherit(world, f, m, t, nursery));
  f.nextBrood = t + B.every * rand(0.8, 1.25) * DAY;
  const sp = SPECIES[f.sp];
  world.log('birth', `${f.name} и ${m.name} стали родителями: ${fryWord(n)} (${sp.title})`, t);
  for (const k of kids) {
    if (k.gene.rare) world.log('rare', `В новом выводке ${f.name} и ${m.name} — ${k.name}: у ${k.sex === 'f' ? 'неё' : 'него'} ${RARE[k.gene.rare].title}!`, t);
  }
  return kids;
}

/**
 * One step of family life over dtDays. Live, a due brood is reported ('due') and the
 * ecosystem stages nesting and calls brood() itself; in catch-up it happens right away.
 */
export function lifeTick(world, t, dtDays, live, out) {
  const bySp = new Map();
  for (const r of world.fish) {
    if (!bySp.has(r.sp)) bySp.set(r.sp, []);
    bySp.get(r.sp).push(r);
  }
  const pendingAll = Object.values(world.pending || {}).reduce((a, b) => a + b, 0);
  let roomAll = POPULATION_CAP - world.fish.length - pendingAll;
  for (const [id, list] of bySp) {
    const B = SPECIES[id].life.breed;
    if (!B) continue;
    let room = Math.min(roomAll, B.cap - list.length - (world.pending?.[id] || 0));
    // pairing: now and then a single female and a male (one she already likes, preferably)
    // get together; the very first pair of an aquarium forms within its first hour or so
    if (room > 0) {
      const singles = list.filter((r) => !r.mate && stageOf(r, t) === 'adult');
      const males = singles.filter((r) => r.sex === 'm');
      for (const f of singles) {
        if (f.sex !== 'f' || !males.length) continue;
        const eager = !world.state.marks['first-pair'];
        const liked = males.some((m) => (f.friends[m.uid] || 0) > 0.3);
        if (Math.random() > (eager ? 12 : liked ? 0.2 : 0.1) * dtDays) continue;
        males.sort((a, b) => (f.friends[b.uid] || 0) - (f.friends[a.uid] || 0) + rand(-0.1, 0.1));
        const m = males.shift();
        pair(world, f, m, t);
        out.push({ type: 'pair', f, m, t });
      }
    }
    // broods
    for (const f of list) {
      if (f.sex !== 'f' || !f.mate || !f.nextBrood || f.nextBrood > t) continue;
      const m = world.byUid(f.mate);
      if (!m) { f.mate = null; f.nextBrood = null; continue; }
      if (room <= 0) { f.nextBrood = t + B.every * rand(0.8, 1.2) * DAY; continue; }
      const n = Math.min(room, Math.round(rand(B.brood[0], B.brood[1])));
      room -= n;
      roomAll -= n;
      if (live) {
        f.nextBrood = null;   // the ecosystem takes it from here
        out.push({ type: 'due', f, m, n, t });
      } else {
        // unseen broods grow up around the mother's favourite place
        out.push({ type: 'birth', f, m, kids: brood(world, f, m, t, n, f.fav), t });
      }
    }
  }
  // a very old fish may quietly reach the end of a long life (only ever while nobody watches)
  if (!live) {
    for (const r of world.fish.slice()) {
      const L = SPECIES[r.sp].life;
      if (ageDays(r, t) > L.span * (1 + (r.uid % 7) * 0.05) && Math.random() < 0.15 * dtDays) {
        world.remove(r);
        world.log('farewell', `${r.name} ${r.sex === 'f' ? 'прожила' : 'прожил'} долгую и спокойную жизнь — ${Math.round(ageDays(r, t))} дней`, t);
        out.push({ type: 'farewell', r, t });
      }
    }
  }
}

/**
 * Catch up with the time the aquarium was closed and sum up the pleasant changes for
 * "while you were away". Returns null after a short absence.
 */
export function catchUp(world, t1) {
  const t0 = world.state.lastSeen;
  if (t1 - t0 < 20 * 60000) return null;
  const stage0 = new Map(world.fish.map((r) => [r.uid, stageOf(r, t0)]));
  const school0 = schoolSizes(world, t0);
  const span = Math.min(t1 - t0, 60 * DAY);
  const step = span > 10 * DAY ? 6 * HOUR : HOUR;
  const out = [];
  for (let t = t1 - span + step; t <= t1; t += step) lifeTick(world, t, step / DAY, false, out);
  const grew = { juvenile: 0, adult: 0 };
  for (const r of world.fish) {
    const a = stage0.get(r.uid), b = stageOf(r, t1);
    if (a === 'fry' && b !== 'fry') grew.juvenile++;
    if (a === 'juvenile' && (b === 'adult' || b === 'elder')) grew.adult++;
  }
  const school1 = schoolSizes(world, t1);
  return {
    away: t1 - t0,
    pairs: out.filter((e) => e.type === 'pair'),
    births: out.filter((e) => e.type === 'birth'),
    grew,
    schools: Object.keys(school1).filter((id) => school1[id] > (school0[id] || 0)).map((id) => ({ sp: SPECIES[id], from: school0[id] || 0, to: school1[id] })),
  };
}

/** Grown-up members of each schooling species (fry keep to themselves). */
export function schoolSizes(world, t) {
  const n = {};
  for (const r of world.fish) if (SPECIES[r.sp].school > 0.6 && stageOf(r, t) !== 'fry') n[r.sp] = (n[r.sp] || 0) + 1;
  return n;
}
