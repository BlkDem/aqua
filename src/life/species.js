import * as THREE from 'three';

// Colour helpers for procedural body patterns.
// nx: side (-1..1), ny: belly(-1) .. back(+1), nz: tail(-1) .. head(+1)
const C = (hex) => new THREE.Color(hex);
const mix = (a, b, t) => a.clone().lerp(b, Math.max(0, Math.min(1, t)));
const band = (v, a, b, soft = 0.05) => {
  const s1 = (v - a) / soft, s2 = (b - v) / soft;
  return Math.max(0, Math.min(1, s1)) * Math.max(0, Math.min(1, s2));
};

export const SPECIES = {
  neon: {
    id: 'neon', title: 'Неон', count: 16, len: 0.34, height: 0.1, width: 0.065,
    profile: { headRound: 0.8, taper: 0.55, peduncle: 0.35, hump: 0.0, belly: 0.1 },
    tail: { type: 'fork', len: 0.12, span: 0.09 }, dorsal: { at: [-0.05, 0.25], h: 0.05, sweep: 0.3 }, anal: { at: [-0.4, -0.05], h: 0.035 },
    pect: 0.04, eye: 0.024,
    body: (c, x, y, z, R) => {
      const silver = C('#d9e4ea'), back = C('#59603f'), blue = C('#19c8ff'), red = C('#ff2242');
      let col = mix(silver, back, (y + 0.2) * 1.5);
      if (z > -0.65) col = mix(col, blue, band(y, 0.05, 0.38, 0.06) * 1.2);
      if (z < 0.15) col = mix(col, red, band(y, -0.95, -0.02, 0.08));
      c.copy(col);
    },
    fin: C('#cfe9f2'), finOpacity: 0.35, irid: 0.9, emissiveStripe: true,
    swim: { cruise: 0.95, max: 2.6, freq: 15, amp: 0.05, accel: 5, turn: 5.5, burst: 0.7 },
    school: 1.0, zone: [1.0, 3.6], social: 0.5,
    traits: { activity: 0.8, bravery: 0.3, curiosity: 0.4, playfulness: 0.6, shyness: 0.6, aggression: 0.05, gluttony: 0.6, territoriality: 0.0 },
    diet: 'flakes', nocturnal: false,
  },
  guppy: {
    id: 'guppy', title: 'Гуппи', count: 7, len: 0.36, height: 0.11, width: 0.07,
    profile: { headRound: 0.7, taper: 0.45, peduncle: 0.45, hump: 0.0, belly: 0.25 },
    tail: { type: 'fan', len: 0.26, span: 0.22, droop: 0.02 }, dorsal: { at: [-0.25, 0.05], h: 0.08, sweep: 0.6 }, anal: { at: [-0.3, -0.1], h: 0.03 },
    pect: 0.04, eye: 0.026,
    variants: ['#ff6a3d', '#ffb21f', '#3f8cff', '#ff3fa4', '#8a5bff', '#28d6a8', '#ff2f2f'],
    body: (c, x, y, z, R, v) => {
      const base = C('#c9c7b8');
      const pal = C(v);
      let col = mix(base, C('#6f7564'), (y + 0.1) * 0.8);
      col = mix(col, pal, Math.max(0, -z - 0.1) * 1.4);
      if (R > 0.5) col = mix(col, C('#111'), band(Math.sin(z * 30 + y * 10), 0.85, 1.1, 0.05) * Math.max(0, -z));
      c.copy(col);
    },
    finFromVariant: true, finOpacity: 0.75, irid: 0.5,
    swim: { cruise: 0.6, max: 1.9, freq: 12, amp: 0.06, accel: 3.5, turn: 4.5, burst: 0.4 },
    school: 0.45, zone: [2.6, 5.3], social: 0.7,
    traits: { activity: 0.75, bravery: 0.5, curiosity: 0.6, playfulness: 0.8, shyness: 0.3, aggression: 0.1, gluttony: 0.7, territoriality: 0.0 },
  },
  goldfish: {
    id: 'goldfish', title: 'Золотая рыбка', count: 2, len: 0.85, height: 0.5, width: 0.36,
    profile: { headRound: 0.95, taper: 0.7, peduncle: 0.35, hump: 0.12, belly: 0.25 },
    tail: { type: 'double', len: 0.6, span: 0.5, droop: 0.15 }, dorsal: { at: [-0.25, 0.25], h: 0.24, sweep: 0.5 }, anal: { at: [-0.45, -0.25], h: 0.12, double: true },
    pect: 0.13, eye: 0.06, bulgeEye: true,
    variants: ['#ff7a12', '#ff5a1f'],
    body: (c, x, y, z, R, v) => {
      const o = C(v), w = C('#fff1d6'), g = C('#ffc04a');
      let col = mix(w, o, (y + 0.6) * 0.9);
      col = mix(col, g, Math.max(0, z - 0.4) * 1.2 * (0.5 + y * 0.5));
      if (R > 0.5) col = mix(col, w, band(Math.sin(x * 8 + z * 6) + y, 0.9, 2, 0.2));
      c.copy(col);
    },
    fin: C('#ffb260'), finOpacity: 0.62, irid: 0.2,
    swim: { cruise: 0.42, max: 1.3, freq: 4.2, amp: 0.13, accel: 1.4, turn: 1.8, burst: 0 },
    school: 0, zone: [1.2, 4.8], social: 0.6, big: true,
    traits: { activity: 0.5, bravery: 0.8, curiosity: 0.6, playfulness: 0.5, shyness: 0.1, aggression: 0.15, gluttony: 1.0, territoriality: 0.0 },
  },
  angelfish: {
    id: 'angelfish', title: 'Скалярия', count: 3, len: 0.62, height: 0.75, width: 0.12,
    profile: { headRound: 0.55, taper: 0.5, peduncle: 0.45, hump: 0.05, belly: 0.0, diamond: true },
    tail: { type: 'lyre', len: 0.32, span: 0.32 }, dorsal: { at: [-0.4, 0.1], h: 0.36, sweep: 1.3 }, anal: { at: [-0.4, 0.1], h: 0.36, sweep: 1.3 },
    pect: 0.06, eye: 0.045, ventralStreamers: 0.5,
    body: (c, x, y, z, R) => {
      const s = C('#e8e6dc'), d = C('#1d1d22'), gold = C('#ffd37a');
      let col = mix(s, C('#c9c3a4'), (y + 1) * 0.3);
      col = mix(col, gold, Math.max(0, y - 0.5) * 0.8 * Math.max(0, z));
      const st = Math.sin((z + 0.12) * 11.0);
      col = mix(col, d, band(st, 0.82, 1.1, 0.08) * (z < 0.85 ? 1 : 0) * 0.85);
      c.copy(col);
    },
    fin: C('#dfe6ea'), finOpacity: 0.32, finStripes: true, irid: 0.4,
    swim: { cruise: 0.33, max: 1.2, freq: 3.2, amp: 0.05, accel: 1.2, turn: 2.0, burst: 0, glide: true },
    school: 0.15, zone: [1.8, 4.6], social: 0.5, big: true,
    traits: { activity: 0.35, bravery: 0.6, curiosity: 0.5, playfulness: 0.2, shyness: 0.3, aggression: 0.3, gluttony: 0.6, territoriality: 0.3 },
  },
  clown: {
    id: 'clown', title: 'Рыба-клоун', count: 2, len: 0.46, height: 0.21, width: 0.13,
    profile: { headRound: 0.95, taper: 0.45, peduncle: 0.5, hump: 0.0, belly: 0.1 },
    tail: { type: 'round', len: 0.13, span: 0.15 }, dorsal: { at: [-0.4, 0.3], h: 0.09, sweep: 0.2, notch: true }, anal: { at: [-0.35, -0.05], h: 0.07 },
    pect: 0.07, eye: 0.04,
    body: (c, x, y, z, R) => {
      const o = C('#ff6a00'), w = C('#ffffff'), k = C('#151515');
      let col = o.clone();
      const bands = [0.55, 0.0, -0.62];
      for (const b of bands) {
        const d = Math.abs(z - b);
        if (d < 0.11) col = w.clone();
        else if (d < 0.15) col = k.clone();
      }
      c.copy(col);
    },
    fin: C('#ff6a00'), finEdge: C('#111'), finOpacity: 0.9, irid: 0.1,
    swim: { cruise: 0.45, max: 1.6, freq: 9, amp: 0.05, accel: 3, turn: 4, burst: 0.2, wiggle: true },
    school: 0, zone: [0.9, 3.0], social: 0.5, homeKind: 'anemone',
    traits: { activity: 0.6, bravery: 0.7, curiosity: 0.5, playfulness: 0.5, shyness: 0.2, aggression: 0.45, gluttony: 0.6, territoriality: 0.7 },
  },
  cory: {
    id: 'cory', title: 'Сомик-коридорас', count: 5, len: 0.42, height: 0.17, width: 0.15,
    profile: { headRound: 0.6, taper: 0.5, peduncle: 0.45, hump: 0.08, belly: -0.15, flatBelly: true },
    tail: { type: 'fork', len: 0.12, span: 0.13 }, dorsal: { at: [0.05, 0.3], h: 0.12, sweep: 0.2 }, anal: { at: [-0.4, -0.2], h: 0.03 },
    pect: 0.08, eye: 0.028, barbels: true, bottom: true,
    body: (c, x, y, z, R) => {
      const b = C('#c8b291'), d = C('#4b3b2c'), belly = C('#efe3cf');
      let col = mix(belly, b, (y + 0.7) * 1.2);
      const sp = Math.sin(x * 40 + z * 23) * Math.sin(y * 31 + z * 17);
      if (y > -0.3) col = mix(col, d, band(sp, 0.55, 1.1, 0.1));
      if (y > -0.2) col = mix(col, d, band(Math.abs(y - 0.1), 0, 0.08, 0.04) * 0.6 * (z < 0.5 ? 1 : 0));
      c.copy(col);
    },
    fin: C('#d9c6a5'), finOpacity: 0.55, irid: 0.2,
    swim: { cruise: 0.35, max: 1.4, freq: 10, amp: 0.05, accel: 3, turn: 3.8, burst: 0.6 },
    school: 0.35, zone: [0, 0.6], social: 0.8,
    traits: { activity: 0.6, bravery: 0.4, curiosity: 0.8, playfulness: 0.4, shyness: 0.4, aggression: 0, gluttony: 0.8, territoriality: 0 },
    nocturnal: true,
  },
  cichlid: {
    id: 'cichlid', title: 'Цихлида', count: 2, len: 0.58, height: 0.24, width: 0.13,
    profile: { headRound: 0.75, taper: 0.5, peduncle: 0.55, hump: 0.05, belly: 0.05 },
    tail: { type: 'round', len: 0.16, span: 0.18 }, dorsal: { at: [-0.45, 0.4], h: 0.09, sweep: 0.3 }, anal: { at: [-0.45, -0.1], h: 0.1, sweep: 0.5 },
    pect: 0.08, eye: 0.04,
    variants: ['#2f6dff', '#ffd21f'],
    body: (c, x, y, z, R, v) => {
      const base = C(v), dark = C('#0b1640');
      let col = base.clone().offsetHSL(0, 0, (y) * 0.08);
      if (v === '#2f6dff') col = mix(col, dark, band(Math.sin(z * 18), 0.6, 1.1, 0.12) * 0.6);
      else col = mix(col, C('#fff6c4'), Math.max(0, -y - 0.3));
      c.copy(col);
    },
    finFromVariant: true, finEdge: C('#111'), finOpacity: 0.85, irid: 0.5,
    swim: { cruise: 0.55, max: 2.0, freq: 7, amp: 0.05, accel: 3, turn: 3.6, burst: 0.3 },
    school: 0, zone: [0.6, 3.2], social: 0.2,
    traits: { activity: 0.6, bravery: 0.9, curiosity: 0.5, playfulness: 0.2, shyness: 0.05, aggression: 0.85, gluttony: 0.8, territoriality: 1.0 },
  },
  discus: {
    id: 'discus', title: 'Дискус', count: 2, len: 0.6, height: 0.58, width: 0.11,
    profile: { headRound: 0.98, taper: 0.25, peduncle: 0.32, hump: 0.0, belly: 0.0, disc: true },
    tail: { type: 'fan', len: 0.12, span: 0.15 }, dorsal: { at: [-0.75, 0.55], h: 0.06, sweep: 0.1, follow: true }, anal: { at: [-0.75, 0.45], h: 0.06, follow: true },
    pect: 0.06, eye: 0.04, redEye: true,
    variants: ['#ff4a2a', '#2ad4c8'],
    body: (c, x, y, z, R, v) => {
      const a = C(v), b = v === '#ff4a2a' ? C('#38c6d8') : C('#ff7a3a');
      const w = Math.sin(y * 22 + Math.sin(z * 9) * 2.0);
      let col = mix(a, b, band(w, 0.3, 1.1, 0.25));
      col = mix(col, C('#3a1d10'), band(Math.sin(z * 9.5), 0.93, 1.1, 0.03) * 0.5);
      c.copy(col);
    },
    finFromVariant: true, finOpacity: 0.8, irid: 0.7,
    swim: { cruise: 0.28, max: 1.1, freq: 3.5, amp: 0.035, accel: 1.1, turn: 1.8, burst: 0, glide: true },
    school: 0.2, zone: [1.5, 4.2], social: 0.6, big: true,
    traits: { activity: 0.3, bravery: 0.4, curiosity: 0.4, playfulness: 0.2, shyness: 0.6, aggression: 0.1, gluttony: 0.5, territoriality: 0.2 },
  },
  barb: {
    id: 'barb', title: 'Суматранский барбус', count: 7, len: 0.38, height: 0.19, width: 0.08,
    profile: { headRound: 0.75, taper: 0.5, peduncle: 0.45, hump: 0.08, belly: 0.05 },
    tail: { type: 'fork', len: 0.13, span: 0.13 }, dorsal: { at: [-0.1, 0.25], h: 0.1, sweep: 0.2 }, anal: { at: [-0.4, -0.1], h: 0.05 },
    pect: 0.05, eye: 0.03, redNose: true,
    body: (c, x, y, z, R) => {
      const g = C('#f5c84a'), k = C('#151515'), r = C('#ff3a2a');
      let col = mix(C('#fff2c2'), g, (y + 0.6));
      for (const b of [0.62, 0.22, -0.2, -0.68]) if (Math.abs(z - b) < 0.075) col = k.clone();
      if (z > 0.92) col = mix(col, r, 0.6);
      c.copy(col);
    },
    fin: C('#ff4430'), finEdge: C('#111'), finOpacity: 0.85, irid: 0.3,
    swim: { cruise: 1.0, max: 2.6, freq: 13, amp: 0.05, accel: 5, turn: 5.5, burst: 0.6 },
    school: 0.85, zone: [1.0, 4.0], social: 0.6, mischief: true,
    traits: { activity: 0.95, bravery: 0.7, curiosity: 0.6, playfulness: 0.9, shyness: 0.1, aggression: 0.5, gluttony: 0.8, territoriality: 0 },
  },
  betta: {
    id: 'betta', title: 'Петушок', count: 1, len: 0.42, height: 0.14, width: 0.09,
    profile: { headRound: 0.7, taper: 0.4, peduncle: 0.6, hump: 0.0, belly: 0.05 },
    tail: { type: 'veil', len: 0.55, span: 0.42, droop: 0.2 }, dorsal: { at: [-0.5, 0.0], h: 0.22, sweep: 1.1 }, anal: { at: [-0.6, 0.3], h: 0.26, sweep: 0.9 },
    pect: 0.05, eye: 0.03,
    variants: ['#d4142e'],
    body: (c, x, y, z, R, v) => {
      let col = mix(C(v), C('#2b5bff'), Math.max(0, Math.sin(z * 9 + y * 5)) * 0.35);
      c.copy(col.offsetHSL(0, 0, -Math.max(0, z - 0.6) * 0.15));
    },
    finFromVariant: true, finGradient: C('#3b6dff'), finOpacity: 0.78, irid: 1.0,
    swim: { cruise: 0.25, max: 1.2, freq: 3.0, amp: 0.06, accel: 1.6, turn: 2.8, burst: 0 },
    school: 0, zone: [3.2, 5.3], social: 0.1,
    traits: { activity: 0.35, bravery: 0.9, curiosity: 0.6, playfulness: 0.2, shyness: 0.1, aggression: 0.7, gluttony: 0.7, territoriality: 0.9 },
  },
  rainbow: {
    id: 'rainbow', title: 'Радужница', count: 4, len: 0.48, height: 0.2, width: 0.07,
    profile: { headRound: 0.6, taper: 0.5, peduncle: 0.45, hump: 0.15, belly: 0.1 },
    tail: { type: 'fork', len: 0.15, span: 0.16 }, dorsal: { at: [-0.4, 0.1], h: 0.09, sweep: 0.3, double: true }, anal: { at: [-0.45, 0.1], h: 0.07 },
    pect: 0.05, eye: 0.035,
    body: (c, x, y, z, R) => {
      const a = C('#3a9cff'), b = C('#ffd166'), p = C('#ff6fb1');
      let col = mix(b, a, z * 0.6 + 0.5);
      col = mix(col, p, Math.max(0, -y - 0.2) * 0.8);
      col = mix(col, C('#ffffff'), band(Math.sin(y * 30), 0.9, 1.2, 0.1) * 0.25);
      c.copy(col);
    },
    fin: C('#ffb04a'), finEdge: C('#ff3d6f'), finOpacity: 0.7, irid: 1.0,
    swim: { cruise: 1.1, max: 2.6, freq: 11, amp: 0.045, accel: 4.5, turn: 4.0, burst: 0.4 },
    school: 0.8, zone: [3.0, 5.2], social: 0.6,
    traits: { activity: 0.9, bravery: 0.6, curiosity: 0.5, playfulness: 0.7, shyness: 0.2, aggression: 0.1, gluttony: 0.6, territoriality: 0 },
  },
  moonfish: {
    id: 'moonfish', title: 'Лунная рыбка', count: 1, len: 0.5, height: 0.3, width: 0.1, rare: true,
    profile: { headRound: 0.85, taper: 0.55, peduncle: 0.35, hump: 0.0, belly: 0.05 },
    tail: { type: 'veil', len: 0.45, span: 0.38, droop: 0.05 }, dorsal: { at: [-0.4, 0.3], h: 0.2, sweep: 0.9 }, anal: { at: [-0.4, 0.0], h: 0.15, sweep: 0.9 },
    pect: 0.08, eye: 0.04,
    body: (c, x, y, z, R) => {
      const a = C('#c9f6ff'), b = C('#7a7cff');
      let col = mix(b, a, (y + 1) * 0.5 + Math.sin(z * 12) * 0.15);
      c.copy(col);
    },
    fin: C('#a9c8ff'), finOpacity: 0.45, irid: 1.0, glow: true,
    swim: { cruise: 0.35, max: 1.3, freq: 3.5, amp: 0.06, accel: 1.6, turn: 2.5, burst: 0, glide: true },
    school: 0, zone: [1.5, 5.0], social: 0.3,
    traits: { activity: 0.4, bravery: 0.4, curiosity: 0.9, playfulness: 0.6, shyness: 0.7, aggression: 0, gluttony: 0.3, territoriality: 0 },
    nocturnal: true,
  },
};

export const NAMES = [
  'Боб', 'Шустрик', 'Капитан', 'Толстяк', 'Пират', 'Искорка', 'Бублик', 'Зефир', 'Марго', 'Сырник', 'Кнопка', 'Тоша',
  'Лучик', 'Пончик', 'Граф', 'Ириска', 'Вихрь', 'Мармелад', 'Фантик', 'Сёма', 'Буля', 'Звёздочка', 'Бисер', 'Кекс',
  'Хвостик', 'Плюх', 'Адмирал', 'Профессор', 'Ниндзя', 'Соня', 'Чудик', 'Огонёк', 'Барон', 'Жемчуг', 'Каспер', 'Рыжик',
  'Тень', 'Бусинка', 'Шкипер', 'Маэстро', 'Пузырь', 'Персик', 'Фунтик', 'Изюм', 'Комета', 'Бриз', 'Ватсон', 'Дюна',
  'Финик', 'Луна', 'Мичман', 'Кокос', 'Сапфир', 'Дракоша', 'Ёжик', 'Тыковка', 'Барабан', 'Сморчок', 'Шерлок', 'Юнга',
  'Карамель', 'Неон', 'Призрак', 'Гусар', 'Прыг', 'Монетка', 'Тучка', 'Лаки', 'Мусс', 'Пинг', 'Понг', 'Батон',
];
