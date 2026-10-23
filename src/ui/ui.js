// Minimal glass UI. All DOM, no framework.
import { SPECIES } from '../life/species.js';
import { STAGE, RARE } from '../life/lifecycle.js';
import { duration, fishWord } from '../life/words.js';
import { pwa } from '../pwa.js';
import { KIND_TITLE, gpuPref, setGpuPref, switchHelp } from '../fx/gpu.js';

const PREFS = 'aq.settings';
const IDLE_MS = 3000;   // the pointer rests this long before the chrome hides
const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

const ICONS = {
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke-width="1.9"/></svg>',
  unfull: '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" fill="none" stroke-width="1.9"/></svg>',
  feed: '<svg viewBox="0 0 24 24"><circle cx="7" cy="8" r="1.6"/><circle cx="12" cy="5.5" r="1.6"/><circle cx="16.5" cy="9" r="1.6"/><circle cx="10" cy="12" r="1.6"/><circle cx="14" cy="15" r="1.6"/><circle cx="9" cy="18.5" r="1.6"/></svg>',
  watch: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" fill="none" stroke-width="1.8"/><circle cx="12" cy="12" r="3"/></svg>',
  cine: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2.5" fill="none" stroke-width="1.8"/><path d="M16 10.5l5-3v9l-5-3z"/></svg>',
  cam: '<svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="none" stroke-width="1.8"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" fill="none" stroke-width="1.4"/></svg>',
  fish: '<svg viewBox="0 0 24 24"><path d="M3 12c3-5 9-6.5 13-3l4-3v12l-4-3c-4 3.5-10 2-13-3z" fill="none" stroke-width="1.8"/><circle cx="8" cy="11" r="1.2"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><g stroke-width="1.8"><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></g></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2" fill="none" stroke-width="1.8"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke-width="1.8"/></svg>',
};

export class UI {
  constructor(app) {
    this.app = app;
    const root = (this.root = h('div', 'ui'));
    document.body.appendChild(root);

    // story feed
    this.feed = h('div', 'stories');
    root.appendChild(this.feed);

    // dock
    const dock = (this.dock = h('div', 'dock'));
    const btn = (id, label, icon, fn) => {
      const b = h('button', 'dock-btn', `<span class="ico">${icon}</span><span class="lbl">${label}</span>`);
      b.dataset.id = id;
      b.addEventListener('click', (e) => { e.stopPropagation(); app.audio.start(); fn(b); });
      dock.appendChild(b);
      return b;
    };
    btn('feed', 'Кормить', ICONS.feed, (b) => { app.feed(); b.classList.add('pulse'); setTimeout(() => b.classList.remove('pulse'), 600); });
    btn('observe', 'Наблюдать', ICONS.watch, () => app.setMode('observe'));
    btn('cine', 'Cinematic', ICONS.cine, () => app.setMode('cinematic'));
    btn('cam', 'Камера', ICONS.cam, () => this.hint(`Камера: ${app.director.cycleView()}`));
    btn('fish', 'Обитатели', ICONS.fish, () => this.togglePanel('roster'));
    this.dayBtn = btn('day', 'Авто', ICONS.sun, (b) => {
      const order = ['auto', 'day', 'evening', 'night'];
      const m = order[(order.indexOf(app.day.mode) + 1) % order.length];
      app.day.setMode(m);
      this.savePref('dayMode', m);
      b.querySelector('.lbl').textContent = { auto: 'Авто', day: 'День', evening: 'Вечер', night: 'Ночь' }[m];
      this.hint(m === 'auto' ? 'Смена дня и ночи: автоматически' : `Освещение: ${b.querySelector('.lbl').textContent}`);
    });
    btn('settings', 'Настройки', ICONS.gear, () => this.togglePanel('settings'));
    // full screen (not offered where the page cannot do it, or already runs full screen as an app)
    if (document.fullscreenEnabled && !matchMedia('(display-mode: fullscreen)').matches) {
      this.fullBtn = btn('full', 'Экран', ICONS.full, () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      });
      document.addEventListener('fullscreenchange', () => {
        const on = !!document.fullscreenElement;
        this.fullBtn.querySelector('.ico').innerHTML = on ? ICONS.unfull : ICONS.full;
        this.fullBtn.querySelector('.lbl').textContent = on ? 'Окно' : 'Экран';
      });
    }
    root.appendChild(dock);

    // notices in the top right corner (new version, graphics card)
    this.notices = h('div', 'notices');
    root.appendChild(this.notices);

    // hint bubble
    this.hintEl = h('div', 'hint');
    root.appendChild(this.hintEl);

    // hover label
    this.label = h('div', 'hover-label');
    document.body.appendChild(this.label);

    // creature card
    this.card = h('div', 'card hidden');
    root.appendChild(this.card);

    // saved settings (applied before the panels show their values)
    this.showStories = true;
    try { this.prefs = JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch (e) { this.prefs = {}; }
    for (const [k, v] of Object.entries(this.prefs)) {
      if (k === 'master' || k === 'music' || k === 'fx') app.audio.setVolume(k, v);
      else if (k !== 'tab') this.applyPref(k, v);
    }

    // panels
    this.panels = {};
    this.panels.roster = this.buildRoster();
    this.panels.settings = this.buildSettings();

    this.setupIdle();

    // exit button for immersive modes
    this.exitBtn = h('button', 'exit-btn', '✕ Выйти');
    this.exitBtn.addEventListener('click', (e) => { e.stopPropagation(); app.setMode('free'); });
    document.body.appendChild(this.exitBtn);
    let moveT = 0;
    window.addEventListener('pointermove', () => {
      if (!document.body.classList.contains('immersive')) return;
      this.exitBtn.classList.add('show');
      clearTimeout(moveT);
      moveT = setTimeout(() => this.exitBtn.classList.remove('show'), 2200);
    });
  }

  /**
   * Full screen (or the immersive modes): when the pointer rests for a few seconds, hide the
   * cursor, the toolbar and the other chrome, leaving the aquarium and its stories. Any
   * movement brings them back. Nothing hides while a panel or a dialog is open, or while the
   * pointer rests on the toolbar or a card.
   */
  setupIdle() {
    const body = document.body;
    let timer = 0, overUi = false;
    const full = () => !!document.fullscreenElement || matchMedia('(display-mode: fullscreen)').matches
      || (Math.abs(window.innerWidth - screen.width) < 2 && Math.abs(window.innerHeight - screen.height) < 2);
    const busy = () => overUi || Object.values(this.panels).some((p) => p.classList.contains('open')) || !!this.root.querySelector('.away');
    const sleep = () => {
      if (!(full() || body.classList.contains('immersive'))) return;
      if (busy()) { timer = setTimeout(sleep, IDLE_MS); return; }
      body.classList.add('idle');
    };
    const wake = (e) => {
      if (e?.target?.closest) overUi = !!e.target.closest('.dock, .card, .notices, .panel, .away');
      body.classList.remove('idle');
      clearTimeout(timer);
      timer = setTimeout(sleep, IDLE_MS);
    };
    for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, wake, { passive: true });
    document.addEventListener('fullscreenchange', wake);
    wake();
  }

  hint(text) {
    this.hintEl.textContent = text;
    this.hintEl.classList.add('show');
    clearTimeout(this._hintT);
    this._hintT = setTimeout(() => this.hintEl.classList.remove('show'), 2200);
  }

  story(s) {
    if (!this.showStories) return;
    const el = h('div', 'story' + (s.rare ? ' rare' : ''), `<span class="dot"></span>${s.text}`);
    if (s.focus) {
      el.classList.add('clickable');
      el.addEventListener('click', (e) => { e.stopPropagation(); this.app.select(s.focus, true); });
    }
    this.feed.prepend(el);
    requestAnimationFrame(() => el.classList.add('in'));
    while (this.feed.children.length > 4) this.feed.lastChild.remove();
    setTimeout(() => { el.classList.remove('in'); el.classList.add('out'); setTimeout(() => el.remove(), 900); }, s.rare ? 9000 : 6500);
    if (this.panels.roster.classList.contains('open')) this.renderLog();
  }

  togglePanel(id) {
    for (const [k, p] of Object.entries(this.panels)) {
      if (k === id) p.classList.toggle('open');
      else p.classList.remove('open');
    }
    if (id === 'roster' && this.panels.roster.classList.contains('open')) this.renderRoster();
  }

  buildRoster() {
    const p = h('div', 'panel roster');
    p.innerHTML = `<div class="panel-head"><span>Обитатели</span><button class="x">✕</button></div>
      <div class="tabs"><button data-t="list" class="on">Жители</button><button data-t="hist">История</button><button data-t="log">Сейчас</button></div>
      <div class="roster-body"></div><div class="hist-body hidden"></div><div class="log-body hidden"></div><div class="secrets"></div>`;
    p.querySelector('.x').addEventListener('click', () => p.classList.remove('open'));
    p.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
      p.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
      p.querySelector('.roster-body').classList.toggle('hidden', b.dataset.t !== 'list');
      p.querySelector('.hist-body').classList.toggle('hidden', b.dataset.t !== 'hist');
      p.querySelector('.log-body').classList.toggle('hidden', b.dataset.t !== 'log');
      if (b.dataset.t === 'log') this.renderLog();
      if (b.dataset.t === 'hist') this.renderHistory();
    }));
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.root.appendChild(p);
    return p;
  }

  renderRoster() {
    const eco = this.app.eco;
    const body = this.panels.roster.querySelector('.roster-body');
    body.innerHTML = '';
    const groups = new Map();
    for (const f of eco.fish) {
      if (f.hidden && f.sp.rare) continue;
      if (!groups.has(f.sp.title)) groups.set(f.sp.title, { sp: f.sp, list: [] });
      groups.get(f.sp.title).list.push(f);
    }
    for (const c of eco.critters) {
      if (!groups.has(c.title)) groups.set(c.title, { list: [] });
      groups.get(c.title).list.push(c);
    }
    const order = { fry: 0, juvenile: 1, adult: 2, elder: 3 };
    for (const [title, { sp, list }] of groups) {
      const cap = sp?.life.breed?.cap;
      const g = h('div', 'group', `<div class="gtitle">${title} <span>${list.length}</span></div>`);
      if (sp && !sp.rare && list.length < (cap || sp.count)) {
        // the user may bring in another fish of this kind
        const add = h('button', 'add', '+');
        add.title = 'Добавить ещё одну';
        add.addEventListener('click', (e) => { e.stopPropagation(); const f = eco.addFish(sp.id); if (f) { this.renderRoster(); this.hint(`${sp.title} ${f.name} теперь живёт в аквариуме`); } });
        g.firstChild.appendChild(add);
      }
      if (sp) list.sort((a, b) => order[b.stage] - order[a.stage]);
      for (const f of list) {
        const tag = f.stage && f.stage !== 'adult' ? `<i class="badge ${f.stage}">${STAGE[f.stage]}</i>` : '';
        const rare = f.rec?.gene.rare ? '<i class="badge rare" title="Редкий окрас">✦</i>' : '';
        const row = h('div', 'row', `<span class="nm">${f.name}${tag}${rare}</span><span class="st">${f.statusText ? f.statusText() : critterStatus(f)}</span>`);
        row.addEventListener('click', () => this.app.select(f, true));
        g.appendChild(row);
      }
      body.appendChild(g);
    }
    const found = (eco.store.secrets || []).length;
    this.panels.roster.querySelector('.secrets').textContent = `Найдено секретов: ${found} из 6`;
  }

  /** The aquarium's history, newest first, grouped by day. */
  renderHistory() {
    const body = this.panels.roster.querySelector('.hist-body');
    const hist = this.app.eco.world.state.history.slice().reverse();
    body.innerHTML = hist.length ? '' : '<div class="empty">История только начинается…</div>';
    let lastDay = '';
    for (const e of hist) {
      const d = new Date(e.t);
      const day = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      if (day !== lastDay) { body.appendChild(h('div', 'hday', day)); lastDay = day; }
      body.appendChild(h('div', `hist ${e.kind}`, `<span class="tm">${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>${e.text}`));
    }
  }

  /** "While you were away…": the pleasant changes since the last visit. */
  showAway(a) {
    if (!a) return;
    const items = [];
    const kids = a.births.reduce((n, e) => n + e.kids.length, 0);
    if (kids) {
      const bySp = {};
      for (const e of a.births) bySp[SPECIES[e.f.sp].title] = (bySp[SPECIES[e.f.sp].title] || 0) + e.kids.length;
      items.push(`Появились мальки: ${kids} — ${Object.entries(bySp).map(([t, n]) => `${t.toLowerCase()} ×${n}`).join(', ')}`);
      const rare = a.births.flatMap((e) => e.kids).find((k) => k.gene.rare);
      if (rare) items.push(`Среди них ${rare.name} — ${RARE[rare.gene.rare].title}!`);
    }
    if (a.pairs.length === 1) items.push(`${a.pairs[0].f.name} и ${a.pairs[0].m.name} стали парой`);
    else if (a.pairs.length) items.push(`Новых пар: ${a.pairs.length} — например, ${a.pairs[0].f.name} и ${a.pairs[0].m.name}`);
    if (a.grew.juvenile) items.push(`Подросли мальки: ${a.grew.juvenile}`);
    if (a.grew.adult) items.push(`Стали взрослыми: ${a.grew.adult}`);
    for (const s of a.schools) items.push(`Стая «${s.sp.title}» выросла: было ${s.from}, теперь ${s.to}`);
    if (a.plants) items.push(`Растения разрослись: молодых кустов — ${a.plants}`);
    else if (a.away > 86400000) items.push('Растения заметно подросли');
    if (!items.length) items.push('Рыбки спокойно жили своей жизнью — и, кажется, ждали вас');
    const el = h('div', 'away', `<div class="away-title">Пока вас не было…</div><div class="away-sub">прошло ${duration(a.away)}</div>
      <ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>
      <div class="away-actions"><button class="go">Смотреть</button>${kids ? '<button class="kids">Показать малышей</button>' : ''}</div>`);
    const close = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 500); };
    el.querySelector('.go').addEventListener('click', close);
    el.querySelector('.kids')?.addEventListener('click', () => {
      close();
      const fry = this.app.eco.fish.filter((f) => f.stage === 'fry' && !f.hidden);
      if (fry.length) this.app.select(fry[Math.floor(Math.random() * fry.length)]);
    });
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
  }

  renderLog() {
    const body = this.panels.roster.querySelector('.log-body');
    const eco = this.app.eco;
    body.innerHTML = eco.storyLog.length ? '' : '<div class="empty">Пока ничего не произошло… понаблюдайте немного</div>';
    for (const s of eco.storyLog) {
      const m = Math.floor(s.t / 60), sec = Math.floor(s.t % 60).toString().padStart(2, '0');
      body.appendChild(h('div', 'log' + (s.rare ? ' rare' : ''), `<span class="tm">${m}:${sec}</span>${s.text}`));
    }
  }

  /** Settings remembered between visits (quality, auto resolution and the FPS line keep their own keys). */
  loadPrefs() {
    try { this.prefs = JSON.parse(localStorage.getItem('aq.settings') || '{}'); } catch (e) { this.prefs = {}; }
    const P = this.prefs, app = this.app;
    for (const k of ['master', 'music', 'fx']) if (P[k] != null) app.audio.setVolume(k, P[k]);
    if (P.bloom != null) app.post.bloom.strength = P.bloom;
    if (P.exposure != null) app.dayCtx.exposureMul = P.exposure;
    if (P.cycle != null) app.day.cycleMinutes = P.cycle;
    if (P.dof != null) app.director.dofOn = P.dof;
    if (P.stories != null) this.showStories = P.stories;
    if (P.dayMode) {
      app.day.setMode(P.dayMode);
      this.dayBtn.querySelector('.lbl').textContent = { auto: 'Авто', day: 'День', evening: 'Вечер', night: 'Ночь' }[P.dayMode];
    }
  }
  savePref(k, v) {
    this.prefs[k] = v;
    try { localStorage.setItem('aq.settings', JSON.stringify(this.prefs)); } catch (e) { /* ignore */ }
  }

  buildSettings() {
    const app = this.app;
    const P = this.prefs;
    const F = app.eco.world.state.feeder;
    const p = h('div', 'panel settings');
    const range = (k, label, min, max, step, value) =>
      `<label><span class="lab">${label} <b data-v="${k}"></b></span><input type="range" min="${min}" max="${max}" step="${step}" data-k="${k}" value="${value}"></label>`;
    const check = (k, label, on) => `<label class="chk"><input type="checkbox" data-k="${k}" ${on ? 'checked' : ''}> ${label}</label>`;
    let fpsOn = true;
    try { fpsOn = localStorage.getItem('aq.fps') !== '0'; } catch (e) { /* ignore */ }
    p.innerHTML = `<div class="panel-head"><span>Настройки</span><button class="x">✕</button></div>
      <div class="tabs"><button data-t="life">Аквариум</button><button data-t="view">Изображение</button><button data-t="sound">Звук</button></div>
      <div class="set-body" data-p="life">
        <div class="sect">Автокормушка</div>
        ${check('feeder', 'Кормить по расписанию', F.on)}
        <label>Кормлений в день <select data-k="perDay"><option value="2">2 раза</option><option value="3">3 раза</option><option value="4">4 раза</option></select></label>
        <label>Корм <select data-k="food"><option value="flakes">Хлопья</option><option value="pellets">Гранулы — для донных рыб</option><option value="worms">Мотыль — лакомство</option></select></label>
        <div class="sect">Время и события</div>
        ${range('cycle', 'Длина суток', 2, 30, 1, app.day.cycleMinutes)}
        ${check('stories', 'Показывать истории', this.showStories)}
        <div class="sect">Приложение</div>
        <div class="app-box"></div>
        <div class="sect">Резервная копия</div>
        <div class="tip">Весь аквариум — рыбки, их семьи, растения и история — в одном файле. Его можно сохранить на память или перенести на другое устройство.</div>
        <div class="backup"><button class="wide save-file">Сохранить в файл</button><button class="wide load-file">Загрузить из файла</button></div>
        <div class="tip">Кликните по стеклу, чтобы постучать. Наведите на рыбку, чтобы узнать имя. В аквариуме спрятано несколько секретов…</div>
      </div>
      <div class="set-body" data-p="view">
        <label>Качество графики <select data-k="quality">
          <option value="low">Низкое</option><option value="medium">Среднее</option><option value="high">Высокое</option><option value="ultra">Ультра (HiDPI)</option>
        </select></label>
        ${check('autores', 'Авто-разрешение: держать 30+ FPS', app.res.auto)}
        ${check('dof', 'Глубина резкости', app.director.dofOn)}
        ${range('bloom', 'Свечение', 0, 1.5, 0.01, app.post.bloom.strength)}
        ${range('exposure', 'Яркость', 0.6, 1.6, 0.01, app.dayCtx.exposureMul)}
        ${check('fps', 'Показывать FPS и видеокарту', fpsOn)}
        <div class="sect">Видеокарта</div>
        <div class="tip gpu-name"></div>
        <label>Предпочитать <select data-k="gpuPref"><option value="high-performance">Мощную (дискретную)</option><option value="low-power">Экономную (встроенную)</option></select></label>
        <div class="gpu-reload hidden"><button class="wide">Перезапустить аквариум</button></div>
        <button class="wide gpu-help-btn">Как переключить видеокарту</button>
      </div>
      <div class="set-body" data-p="sound">
        ${range('master', 'Громкость', 0, 1, 0.01, app.audio.vol.master)}
        ${range('music', 'Музыка', 0, 1, 0.01, app.audio.vol.music)}
        ${range('fx', 'Звуки воды', 0, 1, 0.01, app.audio.vol.fx)}
      </div>`;
    p.querySelector('.x').addEventListener('click', () => p.classList.remove('open'));
    p.addEventListener('pointerdown', (e) => e.stopPropagation());

    // tabs: the last one opened is remembered
    const show = (t) => {
      p.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
      p.querySelectorAll('.set-body').forEach((b) => b.classList.toggle('hidden', b.dataset.p !== t));
      P.tab = t;
    };
    p.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { show(b.dataset.t); this.savePrefs(); }));
    show(P.tab || 'life');

    // slider readouts
    const fmt = {
      cycle: (v) => `${v} мин`, bloom: (v) => `${Math.round(v * 100)}%`, exposure: (v) => `${Math.round(v * 100)}%`,
      master: (v) => `${Math.round(v * 100)}%`, music: (v) => `${Math.round(v * 100)}%`, fx: (v) => `${Math.round(v * 100)}%`,
    };
    const readout = (k, v) => { const el = p.querySelector(`b[data-v="${k}"]`); if (el) el.textContent = fmt[k](v); };
    p.querySelectorAll('input[type="range"]').forEach((inp) => readout(inp.dataset.k, parseFloat(inp.value)));

    for (const k of ['perDay', 'food']) {
      const sel = p.querySelector(`select[data-k="${k}"]`);
      sel.value = String(F[k]);
      sel.addEventListener('change', () => { F[k] = k === 'perDay' ? Number(sel.value) : sel.value; app.eco.save(); });
    }
    const g = app.gpu;
    p.querySelector('.gpu-name').innerHTML = `Сейчас рисует: <b>${g.name}</b>${KIND_TITLE[g.kind] ? ` — ${KIND_TITLE[g.kind]}` : ''}`;
    const gs = p.querySelector('select[data-k="gpuPref"]');
    gs.value = gpuPref();
    gs.addEventListener('change', () => {
      setGpuPref(gs.value);
      p.querySelector('.gpu-reload').classList.remove('hidden');
      this.hint('Видеокарта выбирается при запуске — перезапустите аквариум');
    });
    p.querySelector('.gpu-reload button').addEventListener('click', () => { app.eco.save(); location.reload(); });
    p.querySelector('.gpu-help-btn').addEventListener('click', () => this.showGpuHelp());
    const qs = p.querySelector('select[data-k="quality"]');
    try { qs.value = localStorage.getItem('aq.quality') || 'medium'; } catch (e) { qs.value = 'medium'; }
    qs.addEventListener('change', () => { app.setQuality(qs.value); this.hint(`Качество: ${qs.options[qs.selectedIndex].text}`); });
    p.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => {
      const k = inp.dataset.k, v = inp.type === 'checkbox' ? inp.checked : parseFloat(inp.value);
      if (inp.type === 'range') readout(k, v);
      if (k === 'fps') app.setFps(v);
      else if (k === 'autores') app.setAutoRes(v);
      else if (k === 'feeder') { F.on = v; app.eco.save(); this.hint(v ? 'Автокормушка включена' : 'Автокормушка выключена — рыбки не пропадут, просто кормите сами, когда захочется'); }
      else { P[k] = v; this.applyPref(k, v); this.savePrefs(); }
    }));
    p.querySelector('.save-file').addEventListener('click', () => this.saveBackup());
    p.querySelector('.load-file').addEventListener('click', () => this.loadBackup());
    this.appBox = p.querySelector('.app-box');
    pwa.onChange = () => this.renderApp();
    pwa.onUpdate = (apply) => this.offerUpdate(apply);
    this.renderApp();
    this.root.appendChild(p);
    return p;
  }

  saveBackup() {
    const w = this.app.eco.world;
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const name = `аквариум-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
    const url = URL.createObjectURL(new Blob([w.exportJson()], { type: 'application/json' }));
    const a = h('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.hint(`Копия сохранена: ${name}`);
  }

  loadBackup() {
    const input = h('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const json = await file.text();
      let n = 0;
      try { n = JSON.parse(json).fish.length; } catch (e) { /* checked below */ }
      if (!n) { this.hint('Это не копия аквариума'); return; }
      if (!confirm(`Заменить нынешний аквариум копией из файла (${fishWord(n)})? Нынешний пропадёт, если его не сохранить.`)) return;
      if (this.app.eco.world.importJson(json)) location.reload();
      else this.hint('Не получилось загрузить копию');
    });
    input.click();
  }

  /** Install button and offline status in the settings. */
  renderApp() {
    const box = this.appBox;
    const status = pwa.standalone ? 'Аквариум открыт как приложение.'
      : pwa.offlineReady ? 'Аквариум сохранён на устройстве и откроется даже без интернета.'
      : 'После первого запуска аквариум будет открываться и без интернета.';
    let action = '';
    if (!pwa.standalone && pwa.canInstall) action = '<button class="wide">Установить как приложение</button>';
    else if (!pwa.standalone && pwa.ios) action = '<div class="tip">Чтобы установить: «Поделиться» → «На экран „Домой“».</div>';
    box.innerHTML = `<div class="tip">${status}</div>${action}`;
    box.querySelector('button')?.addEventListener('click', async () => {
      if (await pwa.install()) this.hint('Аквариум установлен — его можно открыть как отдельное приложение');
    });
  }

  /** A small card in the top right corner; returns it so buttons can be wired up. */
  notice(cls, html) {
    const el = h('div', `notice ${cls}`, html);
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.close = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 500); };
    this.notices.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    return el;
  }

  /** A new version has been downloaded: offer to switch to it (the world is saved on reload). */
  offerUpdate(apply) {
    if (this.notices.querySelector('.update')) return;
    const el = this.notice('update', '<div class="n-row"><span>Есть новая версия аквариума</span><button>Обновить</button><button class="later">Позже</button></div>');
    el.querySelector('button').addEventListener('click', () => { this.app.eco.save(); apply(); });
    el.querySelector('.later').addEventListener('click', () => el.close());
  }

  /** The aquarium ended up on weak graphics: say so once per card, with a way to fix it. */
  gpuNotice(v) {
    const key = 'aq.gpuNotice', id = this.app.gpu.renderer;
    try { if (localStorage.getItem(key) === id) return; } catch (e) { /* ignore */ }
    this.gpuVerdict = v;
    const el = this.notice('gpu' + (v.software ? ' warn' : ''), `<div class="n-title">${v.title}</div><div class="n-text">${v.text}</div>
      <div class="n-row"><button>Как исправить</button><button class="later">Понятно</button></div>`);
    const forget = () => { try { localStorage.setItem(key, id); } catch (e) { /* ignore */ } el.close(); };
    el.querySelector('button').addEventListener('click', () => { forget(); this.showGpuHelp(); });
    el.querySelector('.later').addEventListener('click', forget);
  }

  /** How to move the browser onto the stronger graphics card, for this system and browser. */
  showGpuHelp() {
    if (this.root.querySelector('.gpu-help')) return;
    const v = this.gpuVerdict;
    const help = switchHelp(v?.software);
    const g = this.app.gpu;
    const el = h('div', 'away gpu-help', `<div class="away-title">${v?.software ? 'Включить видеокарту' : 'Мощная видеокарта'}</div>
      <div class="away-sub">сейчас рисует: ${g.name}${KIND_TITLE[g.kind] ? ` — ${KIND_TITLE[g.kind]}` : ''}</div>
      <div class="gh-why">Сайт не может сам выбрать видеокарту — только попросить браузер. Если браузер остаётся на встроенной, его нужно переключить в настройках системы:</div>
      <ol>${help.steps.map((t) => `<li>${t}</li>`).join('')}</ol>
      ${help.extra.map((t) => `<div class="gh-extra">${t}</div>`).join('')}
      <div class="away-actions"><button class="go">Понятно</button></div>`);
    el.querySelector('.go').addEventListener('click', () => { el.classList.remove('in'); setTimeout(() => el.remove(), 500); });
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
  }

  /** The quality preset changed outside the settings (lowered automatically to keep it smooth). */
  qualityChanged(name, auto) {
    const qs = this.panels.settings.querySelector('select[data-k="quality"]');
    qs.value = name;
    if (auto) this.hint(`Качество снижено до «${qs.options[qs.selectedIndex].text}», чтобы аквариум не тормозил`);
  }

  /** Settings that live in this UI's own store (volumes, look, day length, stories). */
  applyPref(k, v) {
    const app = this.app;
    if (k === 'master' || k === 'music' || k === 'fx') { app.audio.start(); app.audio.setVolume(k, v); }
    if (k === 'bloom') app.post.bloom.strength = v;
    if (k === 'exposure') app.dayCtx.exposureMul = v;
    if (k === 'cycle') app.day.cycleMinutes = v;
    if (k === 'dof') app.director.dofOn = v;
    if (k === 'stories') this.showStories = v;
  }
  savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify(this.prefs)); } catch (e) { /* ignore */ } }

  // ------------------------------------------------------------ card
  showCard(c) {
    this.cardSubject = c;
    this.card.classList.remove('hidden');
    this.renderCard(true);
  }
  hideCard() { this.cardSubject = null; this.card.classList.add('hidden'); }
  renderCard(full) {
    const c = this.cardSubject;
    if (!c) return;
    const isFish = c.kind === 'fish';
    if (full) {
      this.card.innerHTML = `
        <button class="x">✕</button>
        <div class="name-row"><span class="name">${c.name}</span><button class="edit" title="Переименовать">✎</button></div>
        <div class="species">${isFish ? `${c.sp.title}${c.sp.life.breed ? ` <span class="sex">${c.sex === 'f' ? '♀' : '♂'}</span>` : ''}` : c.title}</div>
        ${isFish && c.rec.gene.rare ? `<div class="rare-tag">✦ ${RARE[c.rec.gene.rare].title}</div>` : ''}
        ${isFish ? `<div class="trait">${c.character}</div>
        <div class="kv"><span>Возраст</span><b class="age"></b></div>
        <div class="kv"><span>Любимое место</span><b class="fav"></b></div>` : ''}
        <div class="kv"><span>Сейчас</span><b class="status"></b></div>
        ${isFish ? `<div class="kv small"><span>Семья</span><b class="family"></b></div>
        <div class="kv small"><span>Друзья</span><b class="friends"></b></div>
        <div class="kv small"><span>Помнит</span><b class="memory"></b></div>` : ''}
        <div class="actions"><button class="follow">${this.app.director.mode === 'follow' ? 'Не следить' : 'Следить'}</button></div>`;
      this.card.querySelector('.x').addEventListener('click', () => this.app.select(null));
      this.card.querySelector('.follow').addEventListener('click', (e) => {
        if (this.app.director.mode === 'follow') { this.app.director.unfollow(); e.target.textContent = 'Следить'; }
        else { this.app.director.follow(c); e.target.textContent = 'Не следить'; }
      });
      this.card.querySelector('.edit').addEventListener('click', () => this.editName());
      this.card.querySelector('.name').addEventListener('dblclick', () => this.editName());
      this.card.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    const q = (s) => this.card.querySelector(s);
    q('.status').textContent = isFish ? c.statusText() : critterStatus(c);
    if (isFish) {
      q('.fav').textContent = c.fav.name;
      const w = this.app.eco.world;
      q('.age').textContent = `${STAGE[c.stage]} · ${duration(w.now() - c.rec.born)}`;
      const fam = [];
      if (c.mate) fam.push(`пара — ${c.mate.name}`);
      if (c.rec.parentNames) fam.push(`родители — ${c.rec.parentNames.join(' и ')}`);
      const kids = w.fish.filter((r) => r.parents?.includes(c.uid)).length;
      if (kids) fam.push(`мальков — ${kids}`);
      q('.family').textContent = fam.length ? fam.join(' · ') : 'пока сам по себе';
      const friends = [...c.mem.friends.entries()].filter(([, v]) => v > 0.12).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => this.app.eco.byId.get(id)?.name).filter(Boolean);
      q('.friends').textContent = friends.length ? friends.join(', ') : 'пока нет';
      const m = c.mem.last;
      q('.memory').textContent = m ? `${m.kind}: ${m.who}` : (c.mem.foodSpot ? 'где дают корм' : '—');
    }
  }
  editName() {
    const c = this.cardSubject;
    const nameEl = this.card.querySelector('.name');
    const inp = document.createElement('input');
    inp.value = c.name; inp.maxLength = 18; inp.className = 'name-input';
    nameEl.replaceWith(inp);
    inp.focus(); inp.select();
    const done = () => {
      const v = inp.value.trim();
      if (v && v !== c.name) {
        if (c.kind === 'fish') this.app.eco.rename(c, v); else c.name = v;
        this.hint(`Теперь это ${v}`);
      }
      this.renderCard(true);
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(); if (e.key === 'Escape') this.renderCard(true); });
    inp.addEventListener('blur', done);
  }

  setHover(obj, x, y) {
    if (!obj) { this.label.classList.remove('show'); return; }
    this.label.innerHTML = `<b>${obj.name}</b><span>${obj.kind === 'fish' ? obj.sp.title : obj.title}</span>`;
    this.label.style.transform = `translate(${x + 16}px, ${y - 10}px)`;
    this.label.classList.add('show');
  }

  update() {
    this._uiT = (this._uiT || 0) + 1;
    if (this._uiT % 15) return; // DOM refresh a few times per second is plenty
    if (this.cardSubject) this.renderCard(false);
    if (this.panels.roster.classList.contains('open') && this._uiT % 120 === 0) {
      const rows = this.panels.roster.querySelectorAll('.roster-body .row .st');
      if (rows.length) this.renderRoster();
    }
    if (this.panels.roster.classList.contains('open') && this._uiT % 300 === 0 && !this.panels.roster.querySelector('.hist-body').classList.contains('hidden')) this.renderHistory();
  }
}

function critterStatus(c) {
  if (c.kind === 'snail') return c.retract > 0.5 ? 'Спряталась в раковину' : c.mode === 'glass' ? 'Ползёт по стеклу' : c.food ? 'Ползёт к корму' : 'Исследует грунт';
  if (c.kind === 'shrimp') return { HOP: 'Прыгает', FORAGE: 'Ищет еду', FOOD: 'Нашла корм!', WANDER: 'Бродит по декорациям' }[c.state] || 'Занята делами';
  if (c.kind === 'crab') return c.idle > 0 ? 'Размышляет' : c.wave > 0 ? 'Машет клешнями' : 'Ходит боком';
  return '';
}
