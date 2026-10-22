// Minimal glass UI. All DOM, no framework.
const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

const ICONS = {
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
      b.querySelector('.lbl').textContent = { auto: 'Авто', day: 'День', evening: 'Вечер', night: 'Ночь' }[m];
      this.hint(m === 'auto' ? 'Смена дня и ночи: автоматически' : `Освещение: ${b.querySelector('.lbl').textContent}`);
    });
    btn('settings', 'Настройки', ICONS.gear, () => this.togglePanel('settings'));
    root.appendChild(dock);

    // hint bubble
    this.hintEl = h('div', 'hint');
    root.appendChild(this.hintEl);

    // hover label
    this.label = h('div', 'hover-label');
    document.body.appendChild(this.label);

    // creature card
    this.card = h('div', 'card hidden');
    root.appendChild(this.card);

    // panels
    this.panels = {};
    this.panels.roster = this.buildRoster();
    this.panels.settings = this.buildSettings();

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
    this.showStories = true;
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
      <div class="tabs"><button data-t="list" class="on">Жители</button><button data-t="log">Дневник</button></div>
      <div class="roster-body"></div><div class="log-body hidden"></div><div class="secrets"></div>`;
    p.querySelector('.x').addEventListener('click', () => p.classList.remove('open'));
    p.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
      p.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
      p.querySelector('.roster-body').classList.toggle('hidden', b.dataset.t !== 'list');
      p.querySelector('.log-body').classList.toggle('hidden', b.dataset.t !== 'log');
      if (b.dataset.t === 'log') this.renderLog();
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
      if (!groups.has(f.sp.title)) groups.set(f.sp.title, []);
      groups.get(f.sp.title).push(f);
    }
    for (const c of eco.critters) {
      if (!groups.has(c.title)) groups.set(c.title, []);
      groups.get(c.title).push(c);
    }
    for (const [title, list] of groups) {
      const g = h('div', 'group', `<div class="gtitle">${title} <span>${list.length}</span></div>`);
      for (const f of list) {
        const row = h('div', 'row', `<span class="nm">${f.name}</span><span class="st">${f.statusText ? f.statusText() : critterStatus(f)}</span>`);
        row.addEventListener('click', () => this.app.select(f, true));
        g.appendChild(row);
      }
      body.appendChild(g);
    }
    const found = (eco.store.secrets || []).length;
    this.panels.roster.querySelector('.secrets').textContent = `Найдено секретов: ${found} из 6`;
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

  buildSettings() {
    const app = this.app;
    const p = h('div', 'panel settings');
    p.innerHTML = `<div class="panel-head"><span>Настройки</span><button class="x">✕</button></div>
      <label>Громкость <input type="range" min="0" max="1" step="0.01" data-k="master" value="${app.audio.vol.master}"></label>
      <label>Музыка <input type="range" min="0" max="1" step="0.01" data-k="music" value="${app.audio.vol.music}"></label>
      <label>Звуки воды <input type="range" min="0" max="1" step="0.01" data-k="fx" value="${app.audio.vol.fx}"></label>
      <label>Свечение (bloom) <input type="range" min="0" max="1.5" step="0.01" data-k="bloom" value="${app.post.bloom.strength}"></label>
      <label>Яркость <input type="range" min="0.6" max="1.6" step="0.01" data-k="exposure" value="1"></label>
      <label>Длина суток, мин <input type="range" min="2" max="30" step="1" data-k="cycle" value="${app.day.cycleMinutes}"></label>
      <label class="chk"><input type="checkbox" data-k="dof" checked> Глубина резкости</label>
      <label class="chk"><input type="checkbox" data-k="stories" checked> Показывать истории</label>
      <label>Качество графики <select data-k="quality">
        <option value="low">Низкое</option><option value="medium">Среднее</option><option value="high">Высокое</option><option value="ultra">Ультра (HiDPI)</option>
      </select></label>
      <label class="chk"><input type="checkbox" data-k="fps" ${(() => { try { return localStorage.getItem('aq.fps') === '0' ? '' : 'checked'; } catch (e) { return 'checked'; } })()}> Показывать FPS и видеокарту</label>
      <div class="tip">Совет: кликните по стеклу, чтобы постучать. Наведите на рыбку, чтобы узнать имя. В аквариуме спрятано несколько секретов…</div>`;
    p.querySelector('.x').addEventListener('click', () => p.classList.remove('open'));
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    const qs = p.querySelector('select[data-k="quality"]');
    try { qs.value = localStorage.getItem('aq.quality') || 'medium'; } catch (e) { qs.value = 'medium'; }
    qs.addEventListener('change', () => { app.setQuality(qs.value); this.hint(`Качество: ${qs.options[qs.selectedIndex].text}`); });
    p.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => {
      const k = inp.dataset.k, v = inp.type === 'checkbox' ? inp.checked : parseFloat(inp.value);
      if (k === 'master' || k === 'music' || k === 'fx') { app.audio.start(); app.audio.setVolume(k, v); }
      if (k === 'bloom') app.post.bloom.strength = v;
      if (k === 'exposure') app.dayCtx.exposureMul = v;
      if (k === 'cycle') app.day.cycleMinutes = v;
      if (k === 'dof') app.director.dofOn = v;
      if (k === 'stories') this.showStories = v;
      if (k === 'fps') app.setFps(v);
    }));
    this.root.appendChild(p);
    return p;
  }

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
        <div class="species">${isFish ? c.sp.title : c.title}</div>
        ${isFish ? `<div class="trait">${c.character}</div>
        <div class="kv"><span>Любимое место</span><b class="fav"></b></div>` : ''}
        <div class="kv"><span>Сейчас</span><b class="status"></b></div>
        ${isFish ? `<div class="bar"><span>Сытость</span><i><em class="full"></em></i></div>
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
      q('.full').style.width = `${Math.round((1 - c.hunger) * 100)}%`;
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
  }
}

function critterStatus(c) {
  if (c.kind === 'snail') return c.retract > 0.5 ? 'Спряталась в раковину' : c.mode === 'glass' ? 'Ползёт по стеклу' : c.food ? 'Ползёт к корму' : 'Исследует грунт';
  if (c.kind === 'shrimp') return { HOP: 'Прыгает', FORAGE: 'Ищет еду', FOOD: 'Нашла корм!', WANDER: 'Бродит по декорациям' }[c.state] || 'Занята делами';
  if (c.kind === 'crab') return c.idle > 0 ? 'Размышляет' : c.wave > 0 ? 'Машет клешнями' : 'Ходит боком';
  return '';
}
