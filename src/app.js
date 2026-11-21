/* ============================================================
   汉语学习 · Приложение «Китайский язык»
   Логика: роутер, уроки, SRS-карточки, тоны, пропись, чтение
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Хранилище ----------
   В iframe с непрозрачным origin (sandbox="allow-scripts") браузер запрещает
   доступ к localStorage. Поэтому используем безопасную обёртку с запасным
   хранилищем в памяти — приложение работает в любом контексте. */
const Store = (() => {
  const mem = {};
  let usable = true;
  try {
    localStorage.setItem('__zh_probe__', '1');
    localStorage.removeItem('__zh_probe__');
  } catch (e) { usable = false; }
  return {
    persistent: usable,
    get(k) {
      try { return usable ? localStorage.getItem(k) : (k in mem ? mem[k] : null); }
      catch (e) { return k in mem ? mem[k] : null; }
    },
    set(k, v) {
      try { if (usable) localStorage.setItem(k, v); else mem[k] = v; }
      catch (e) { mem[k] = v; }
    },
    remove(k) {
      try { if (usable) localStorage.removeItem(k); } catch (e) { }
      delete mem[k];
    }
  };
})();
window.Store = Store;

const KEY = 'zh_progress_v1';
const DEFAULT_STATE = { lessons: {}, cards: {}, custom: [], days: [], streak: 0, lastDay: '', quizLog: [], totalRight: 0, totalWrong: 0 };
let state = load();

function load() {
  try {
    const raw = Store.get(KEY);
    if (!raw) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (e) { return { ...DEFAULT_STATE }; }
}
function save() {
  Store.set(KEY, JSON.stringify(state));
  if (window.Auth) Auth.persist();
}
window.__state = () => state;
window.__setState = (s) => { state = { ...DEFAULT_STATE, ...s }; Store.set(KEY, JSON.stringify(state)); };

/* Слияние серверного прогресса с локальным.
   Нужно, когда ученик занимается и на телефоне, и на компьютере:
   берём лучшее из двух состояний, а не «кто последний сохранил». */
/* Объединение журнала занятий: одна запись = урок + время + результат.
   Ключ уникальности — урок и момент окончания, поэтому повторная
   синхронизация не размножает историю. */
function mergeQuizLog(...lists) {
  const seen = new Set();
  const out = [];
  const all = [];
  lists.forEach(list => {
    if (Array.isArray(list)) all.push(...list.filter(q => q && typeof q === 'object'));
  });
  // Сначала более новые записи, чтобы при слиянии осталось актуальное значение.
  all.sort((a, b) => (Number(b && b.at) || 0) - (Number(a && a.at) || 0));
  for (const q of all) {
    const key = [q.lesson || '', Number(q.at) || 0, Number(q.score) || 0].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  // Храним в хронологическом порядке, как раньше (slice(-6) в статистике).
  out.sort((a, b) => (Number(a && a.at) || 0) - (Number(b && b.at) || 0));
  return out.slice(-500);
}

function mergeProgress(incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return state;
  const server = incoming;

  const lessons = Object.assign({}, server.lessons || {});
  Object.keys(state.lessons || {}).forEach(id => {
    const lv = state.lessons[id] || {};
    const sv = lessons[id];
    if (!sv) { lessons[id] = lv; return; }
    lessons[id] = Object.assign({}, sv, lv, {
      score: Math.max(Number(lv.score) || 0, Number(sv.score) || 0),
      done: !!(lv.done || sv.done),
      at: Math.max(Number(lv.at) || 0, Number(sv.at) || 0)
    });
  });

  // Карточки: локальные «свежее» по коробке, серверные дополняют список.
  const cards = Object.assign({}, server.cards || {}, state.cards || {});
  const days = Array.from(new Set(
    [].concat(server.days || [], state.days || []).filter(d => typeof d === 'string')
  )).sort().slice(-400);
  // Журнал занятий объединяем без дублей: одно и то же занятие приходит и
  // с сервера, и из локального состояния при каждой синхронизации — раньше
  // история росла на одну запись за каждую синхронизацию.
  const quizLog = mergeQuizLog(server.quizLog, state.quizLog);

  state = Object.assign({}, DEFAULT_STATE, server, state, {
    lessons, cards, days, quizLog,
    totalRight: Math.max(Number(state.totalRight) || 0, Number(server.totalRight) || 0),
    totalWrong: Math.max(Number(state.totalWrong) || 0, Number(server.totalWrong) || 0),
    streak: Math.max(Number(state.streak) || 0, Number(server.streak) || 0),
    lastDay: (String(state.lastDay || '') > String(server.lastDay || ''))
      ? state.lastDay : server.lastDay
  });
  Store.set(KEY, JSON.stringify(state));
  return state;
}
window.__mergeProgress = mergeProgress;
window.__lessonTitle = (id) => (LESSONS[id] && LESSONS[id].title) || id;
/* Модуль домашки (src/homework.js) подключается отдельным файлом и берёт
   данные и оформление через window. Явные ссылки надёжнее, чем надежда
   на общую область видимости: сборка кладёт каждый файл в свой <script>. */
window.LESSONS = LESSONS;
window.ruby = ruby;
window.homeworkFor = homeworkFor;

function today() { return new Date().toISOString().slice(0, 10); }
function touchDay() {
  const t = today();
  if (state.lastDay !== t) {
    const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    state.streak = state.lastDay === y ? state.streak + 1 : 1;
    state.lastDay = t;
    if (!state.days.includes(t)) state.days.push(t);
    state.days = state.days.slice(-400);
    save();
  }
}

/* ---------- Настройки (скорость речи, тема, звуки) ---------- */
const PREFS = {
  get slow() { return Store.get('zh_rate') === 'slow'; },
  set slow(v) { Store.set('zh_rate', v ? 'slow' : 'normal'); },
  // Светлая тема — основная: у неё нет своего значения, она «по умолчанию».
  // Тёмную выбирают вручную, и выбор запоминается.
  get theme() { return Store.get('zh_theme') === 'dark' ? 'dark' : 'light'; },
  set theme(v) {
    Store.set('zh_theme', v === 'dark' ? 'dark' : 'light');
    if (typeof document !== 'undefined') {
      if (v === 'dark') document.documentElement.dataset.theme = 'dark';
      else document.documentElement.removeAttribute('data-theme');
    }
    // Цвет адресной строки на телефоне подстраивается под тему.
    const meta = typeof document !== 'undefined' && document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', v === 'dark' ? '#171327' : '#ffffff');
  },
  get sfx() { return Store.get('zh_sfx') !== 'off'; },
  set sfx(v) { Store.set('zh_sfx', v ? 'on' : 'off'); }
};
// Тему ставим до первой отрисовки, иначе страница мигнёт тёмным фоном.
if (typeof document !== 'undefined') {
  if (PREFS.theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else document.documentElement.removeAttribute('data-theme');
}

/* ---------- Речь (TTS) ---------- */
let voicesReady = false;
function initVoices() {
  if (!('speechSynthesis' in window)) return;
  voicesReady = true;
}
if ('speechSynthesis' in window) {
  initVoices();
  speechSynthesis.onvoiceschanged = initVoices;
}
function speak(text, rate) {
  if (!('speechSynthesis' in window)) { toast('Браузер не поддерживает озвучку'); return; }
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = rate !== undefined ? rate : (PREFS.slow ? 0.62 : 0.88);
    const v = speechSynthesis.getVoices().find(x => /zh|cmn|Chinese/i.test(x.lang + x.name));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch (e) { toast('Ошибка озвучки'); }
}
/* ---------- Голосовой учитель-панда ----------
   Озвучка объяснений на русском: отдельная дорожка (ru-RU), потому что
   speak() всегда говорит по-китайски. Пока Мэймэй говорит, у панды
   анимируется рот (класс .talking на панели учителя). */
function speakRu(text, rate) {
  if (!('speechSynthesis' in window)) { toast('Браузер не поддерживает озвучку'); return; }
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    u.rate = rate !== undefined ? rate : 0.95;
    const v = speechSynthesis.getVoices().find(x => /\bru\b|Russian|русск/i.test(x.lang + ' ' + x.name));
    if (v) u.voice = v;
    const av = document.querySelector('.panda-teacher');
    if (av) av.classList.add('talking');
    const stop = () => { if (av) av.classList.remove('talking'); };
    u.onend = stop;
    u.onerror = stop;
    speechSynthesis.speak(u);
  } catch (e) { toast('Ошибка озвучки'); }
}

/* Панда Мэймэй: уши, пятки вокруг глаз, нос. Рот — два элемента:
   закрытая дуга (idle) и открытый овал (анимация во время речи). */
function pandaSVG() {
  return `<svg class="pa-svg" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
    <circle cx="30" cy="30" r="16" class="pa-dark"/>
    <circle cx="90" cy="30" r="16" class="pa-dark"/>
    <ellipse cx="60" cy="64" rx="44" ry="40" class="pa-face"/>
    <ellipse cx="41" cy="55" rx="13" ry="15" class="pa-dark" transform="rotate(-14 41 55)"/>
    <ellipse cx="79" cy="55" rx="13" ry="15" class="pa-dark" transform="rotate(14 79 55)"/>
    <g class="pa-eye"><circle cx="41" cy="56" r="5.2" fill="#fff"/><circle cx="41.8" cy="56.6" r="2.7" class="pa-dark"/></g>
    <g class="pa-eye"><circle cx="79" cy="56" r="5.2" fill="#fff"/><circle cx="78.2" cy="56.6" r="2.7" class="pa-dark"/></g>
    <ellipse cx="28" cy="74" rx="7" ry="4.5" class="pa-blush"/>
    <ellipse cx="92" cy="74" rx="7" ry="4.5" class="pa-blush"/>
    <ellipse cx="60" cy="76" rx="6.5" ry="4.5" class="pa-dark"/>
    <path class="pa-mouth-closed" d="M52 84 Q60 90 68 84" fill="none"/>
    <ellipse class="pa-mouth-open" cx="60" cy="87" rx="7" ry="5"/>
  </svg>`;
}

/* Панель учителя: панда слева, объяснение урока текстом (ребёнок читает
   вместе с голосом) и кнопки «объяснить» / «медленнее». */
function renderTeacher(l) {
  const pan = el('div', 'panel panda-teacher');
  pan.innerHTML = `
    <button class="pa-wrap" type="button" title="Объяснить урок голосом" aria-label="Панда-учитель Мэймэй: объяснить урок голосом">${pandaSVG()}</button>
    <div class="pa-body">
      <div class="pa-name">Мэймэй · панда-учитель <span class="pa-hint">нажми на панду — она объяснит</span></div>
      <div class="pa-text">${esc(l.teacher)}</div>
      <div class="pa-actions">
        <button class="btn btn-primary btn-sm pa-say" aria-label="Объяснить урок голосом">🔊 Объяснить урок</button>
        <button class="speak sm pa-slow" title="Медленное объяснение" aria-label="Объяснить медленнее">🐢</button>
      </div>
    </div>`;
  const say = (rate) => speakRu(l.teacher, rate);
  pan.querySelector('.pa-say').onclick = () => say();
  pan.querySelector('.pa-slow').onclick = (e) => { e.preventDefault(); e.stopPropagation(); say(0.72); };
  pan.querySelector('.pa-wrap').onclick = () => say();
  return pan;
}

function toneBtn(text, cls = 'speak') {
  return `<button class="${cls}" data-speak="${esc(text)}" title="Прослушать" aria-label="Прослушать: ${esc(text)}">🔊</button>`;
}
document.addEventListener('click', e => {
  const slow = e.target.closest('[data-speak-slow]');
  if (slow) { e.preventDefault(); e.stopPropagation(); speak(slow.dataset.speakSlow, 0.5); return; }
  const b = e.target.closest('[data-speak]');
  if (b) { e.preventDefault(); e.stopPropagation(); speak(b.dataset.speak); }
});

/* ---------- Звуковые эффекты и конфетти ---------- */
function playSfx(kind) {
  if (!PREFS.sfx) return;
  try {
    const ctx = getCtx();
    const t0 = ctx.currentTime;
    const tone = (freq, start, dur, type = 'sine', gain = 0.08) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, start);
      g.gain.setValueAtTime(0.001, start);
      g.gain.exponentialRampToValueAtTime(gain, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(start); o.stop(start + dur);
    };
    if (kind === 'ok') {
      tone(523.25, t0, 0.14);
      tone(659.25, t0 + 0.07, 0.22);
    } else if (kind === 'bad') {
      tone(220, t0, 0.16, 'triangle', 0.07);
      tone(175, t0 + 0.08, 0.2, 'triangle', 0.06);
    } else if (kind === 'win') {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t0 + i * 0.08, 0.3, 'sine', 0.09));
    }
  } catch (e) { }
}
function launchConfetti() {
  try {
    const box = document.createElement('div');
    box.className = 'confetti-box';
    const colors = ['#ffd27a', '#f37a5c', '#4fd1a5', '#74a9ef', '#a98bf0', '#f28db4'];
    for (let i = 0; i < 34; i++) {
      const p = document.createElement('i');
      p.style.left = (Math.random() * 100) + '%';
      p.style.background = colors[i % colors.length];
      p.style.animationDelay = (Math.random() * 0.45) + 's';
      p.style.animationDuration = (1.6 + Math.random() * 0.9) + 's';
      p.style.setProperty('--dx', ((Math.random() - 0.5) * 160) + 'px');
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 2800);
  } catch (e) { }
}

/* ---------- Уведомления ---------- */
/* Скрытый канал для скринридеров: любую короткую новость («верно»,
   «добавлено в карточки») озвучиваем через него. Иначе ученик без зрения
   узнаёт о результате, только переставив фокус вручную. */
let liveRegion;
function announce(msg) {
  if (typeof document === 'undefined' || !msg) return;
  if (!liveRegion) {
    liveRegion = el('div', 'sr-only');
    liveRegion.setAttribute('role', 'status');
    liveRegion.setAttribute('aria-live', 'polite');
    liveRegion.setAttribute('aria-atomic', 'true');
    document.body.appendChild(liveRegion);
  }
  // Пустая строка между сообщениями заставляет диктор прочитать повтор.
  liveRegion.textContent = '';
  setTimeout(() => { liveRegion.textContent = msg; }, 60);
}

let toastEl;
function toast(msg) {
  if (!toastEl) { toastEl = el('div', 'toast'); document.body.appendChild(toastEl); }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  announce(msg);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

/* ============================================================
   РОУТЕР
   ============================================================ */
const ROUTES = {
  home: renderHome,
  plan: renderPlan,
  lesson: renderLesson,
  diag: renderDiagnostic,
  cards: renderCards,
  tones: renderTones,
  write: renderWrite,
  read: renderRead,
  phrases: renderPhrases,
  videos: renderVideos,
  tutor: renderTutor,
  stats: renderStats,
  dict: renderDict,
  homework: (root, rest) => (window.renderHomework ? window.renderHomework(root, rest) : root.appendChild(el('div', 'panel', 'Домашка недоступна'))),
  class: (root) => Auth.renderClass(root),
  account: renderAccount
};
function route() {
  if (typeof videoStop === 'function') videoStop();
  clearQuizKeys();
  const view = $('#view');
  view.innerHTML = '';
  if (window.Auth && Auth.needsAuth() && !window.__guest) { renderAuthGate(); return; }
  const hash = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, ...rest] = hash.split('/');
  const fn = ROUTES[name] || renderHome;
  view.scrollTop = 0;
  fn(view, rest);
  // Помощнику нужен полный словарь: если он ещё не доехал, догружаем
  // и перерисовываем раздел, чтобы ответы не были беднее, чем обычно.
  if (name === 'tutor' && typeof LEXICON_ROWS === 'undefined' && typeof loadLexicon === 'function') {
    loadLexicon().then(ok => {
      if (!ok || location.hash.replace(/^#\/?/, '').split('/')[0] !== 'tutor') return;
      if (typeof TUTOR_LEX !== 'undefined') TUTOR_LEX.reload();
      const v = $('#view');
      if (v) { v.innerHTML = ''; renderTutor(v, []); }
    });
  }
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === (name || 'home')));
  $$('#mnav a').forEach(a => a.classList.toggle('active', a.dataset.route === (name || 'home')));
  const fab = $('#tutorFab');
  if (fab) fab.style.display = name === 'tutor' ? 'none' : 'flex';
  window.scrollTo(0, 0);
}
function renderAuthGate() {
  const view = $('#view');
  view.innerHTML = '';
  Auth.renderAuth(view);
}
window.__showAuth = () => { window.__guest = false; renderAuthGate(); };
window.__afterAuth = () => { window.__guest = false; paintAccountFoot(); updateNavRoles(); if (typeof refreshHomeworkBadge === 'function') refreshHomeworkBadge(); route(); };
window.__guestMode = () => { window.__guest = true; route(); };
window.addEventListener('hashchange', () => {
  /* Ушли с урока — Мэймэй замолкает и перестаёт «говорить ртом». */
  if ('speechSynthesis' in window) { try { speechSynthesis.cancel(); } catch (e) {} }
  const av = document.querySelector('.panda-teacher');
  if (av) av.classList.remove('talking');
  route();
});

/* Словарь догружаем после того, как страница отрисована: ученик уже
   видит урок, а словарь доезжает фоном. В офлайне он берётся из кэша. */
(function warmLexicon() {
  const start = () => loadLexicon().then(ok => {
    if (ok && typeof TUTOR_LEX !== 'undefined') TUTOR_LEX.reload();
  });
  if (document.readyState === 'complete') setTimeout(start, 400);
  else window.addEventListener('load', () => setTimeout(start, 400));
})();

/* ============================================================
   ДАШБОРД
   ============================================================ */
function allLessonIds() { return Object.keys(LESSONS); }
function doneCount() { return Object.values(state.lessons).filter(l => l.done).length; }
function accuracy() {
  const t = state.totalRight + state.totalWrong;
  return t ? Math.round(state.totalRight / t * 100) : 0;
}
function nextLesson() {
  for (const m of MODULES) for (const id of m.lessons) if (!state.lessons[id]?.done) return id;
  return allLessonIds()[0];
}
function dueCards() {
  const now = Date.now();
  return Object.entries(state.cards).filter(([, c]) => (c.due || 0) <= now).map(([k]) => k);
}

function renderHome(root) {
  if (window.Auth && Auth.online && !Auth.hasUsers && !Auth.user) {
    const ob = el('div', 'owner-banner');
    ob.innerHTML = `<span>👑 <b>Первый запуск:</b> создайте аккаунт владельца (учителя), чтобы выдавать коды ученикам и видеть оценки класса.</span>`;
    const obBtn = el('button', 'btn btn-sm btn-primary', 'Создать аккаунт владельца →');
    obBtn.onclick = () => window.__showAuth();
    ob.appendChild(obBtn);
    root.appendChild(ob);
  }
  if (window.Auth && Auth.user && Auth.grade && (Auth.grade.grade || Auth.grade.comment)) {
    const gb = el('div', 'grade-banner');
    gb.innerHTML = `
      <div class="gb-left">
        <span class="gb-tag">🎓 Оценка учителя</span>
        ${Auth.grade.grade ? `<b class="gb-val">${esc(Auth.grade.grade)}</b>` : ''}
        ${Auth.grade.comment ? `<span class="gb-cmt">${esc(Auth.grade.comment)}</span>` : ''}
      </div>
      <a class="btn btn-sm btn-ghost" href="#/account">В профиль →</a>`;
    root.appendChild(gb);
  }
  const id = nextLesson();
  const l = LESSONS[id];
  const mod = MODULES.find(m => m.lessons.includes(id));
  const done = doneCount();
  const total = allLessonIds().length;
  const pct = Math.round(done / total * 100);
  const due = dueCards().length;

  root.appendChild(el('div', 'hero', `
    <div class="hero-bg">学</div>
    <div class="hero-seal" title="汉语学习">汉<br>语</div>
    <div class="hero-inner">
      <div class="hero-tag">汉语学习 · 学以致用</div>
      <span class="hero-hand" aria-hidden="true">учить и применять</span>
      <h1>Привет, 同学! ${scrawl('spark', { style: 'width:44px;height:44px;vertical-align:-6px' })}</h1>
      <p class="hero-sub">Продолжим с урока <b>${esc(mod.title.split('—')[1] || mod.title)}</b>: <b>«${esc(l.title)}»</b></p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="#/lesson/${id}">Продолжить урок →</a>
        <a class="btn btn-ghost" href="#/cards">Карточки${due ? ` <span class="pill">${due}</span>` : ''}</a>
        <a class="btn btn-ghost" href="#/videos">🎬 Видео</a>
        <a class="btn btn-ghost" href="#/tutor">🤖 ИИ-агент</a>
      </div>
      <div class="hero-stats">
        <div><b>${done}/${total}</b><span>уроков</span></div>
        <div><b>${pct}%</b><span>пройдено</span></div>
        <div><b>${accuracy()}%</b><span>точность</span></div>
        <div><b>${state.streak}</b><span>дней подряд</span></div>
      </div>
    </div>
    <div class="progress-ring" style="--p:${pct}"><div><b>${pct}%</b></div></div>
  `));

  /* Записка на «скотче»: совет дня, написанный будто от руки.
     Живая деталь, которую видно сразу — в отличие от тонких штрихов. */
  const tips = [
    'Учите по 10 минут каждый день — это лучше, чем час раз в неделю.',
    'Проговаривайте вслух: язык запоминается ртом, а не глазами.',
    'Ошибаться полезно: ошибка, которую заметили, запоминается крепче.',
    'Повторяйте вчерашние слова перед новым уроком — так держится база.',
    'Смотрите видео-урок дважды: сначала целиком, потом по репликам.'
  ];
  const tip = tips[new Date().getDate() % tips.length];
  root.appendChild(el('div', 'hand-note', esc(tip)));

  const grid = el('div', 'card-grid');
  const tiles = [
    { r: 'plan', ic: '📚', t: 'План курса', s: '4 модуля · 15 уроков' },
    { r: 'diag', ic: '🎯', t: 'Определить уровень', s: 'Тест из 50 вопросов' },
    { r: 'cards', ic: '🗂️', t: 'Карточки', s: due ? `${due} к повторению` : 'Все повторены — красавчик!' },
    { r: 'videos', ic: '🎬', t: 'Видео-уроки', s: 'Анимация со звуком' },
    { r: 'tutor', ic: '🤖', t: 'ИИ-репетитор', s: 'Спросить Сяо Мина' },
    { r: 'tones', ic: '🎵', t: 'Тоны', s: 'Тренажёр 4-го тона' },
    { r: 'write', ic: '✍️', t: 'Пропись', s: 'Иероглифы кистью' },
    { r: 'read', ic: '📄', t: 'Чтение', s: '3 текста с пиньинь' },
    { r: 'phrases', ic: '💬', t: 'Фразы', s: 'Готовые реплики' },
    { r: 'homework', ic: '🏠', t: 'Домашки', s: 'Сделать и отправить' },
    { r: 'dict', ic: '🔎', t: 'Словарь', s: 'Поиск по всем словам' },
    { r: 'stats', ic: '📊', t: 'Статистика', s: 'Прогресс и ошибки' }
  ];
  tiles.forEach(t => {
    const c = el('a', `tile${t.r === 'cards' && due ? ' tile-hot' : ''}`, `
      <div class="tile-ic">${t.ic}</div>
      <div><b>${t.t}</b><span>${t.s}</span></div>`);
    c.href = `#/${t.r}`;
    grid.appendChild(c);
  });
  root.appendChild(grid);

  if (state.quizLog.length) {
    const recent = state.quizLog.slice(-6).reverse();
    root.appendChild(el('div', 'panel', `
      <h3>Последние результаты</h3>
      <div class="mini-list">${recent.map(q => `
        <div class="mini-row"><span>${esc(LESSONS[q.lesson]?.title || q.lesson)}</span>
        <span class="score ${q.score >= 0.8 ? 'ok' : q.score >= 0.5 ? 'mid' : 'bad'}">${Math.round(q.score * 100)}%</span></div>`).join('')}</div>`));
  }
}

/* ============================================================
   ПЛАН КУРСА
   ============================================================ */
function renderPlan(root) {
  const wrap = el('div');
  wrap.appendChild(el('h1', 'page-title', 'План курса'));
  wrap.appendChild(el('p', 'page-sub', '15 уроков, 4 модуля. Каждый урок: словарь, грамматика, практика, домашка.'));
  MODULES.forEach(m => {
    const p = el('div', 'panel module');
    p.appendChild(el('div', 'module-head', `
      <div><div class="module-level">${esc(m.level)}</div><h3>${esc(m.title)}</h3><p>${esc(m.desc)}</p></div>`));
    const list = el('div', 'lesson-list');
    m.lessons.forEach(id => {
      const l = LESSONS[id];
      const st = state.lessons[id];
      const row = el('a', `lesson-row${st?.done ? ' done' : ''}`, `
        <span class="lr-num">${st?.done ? '✓' : m.lessons.indexOf(id) + 1}</span>
        <span class="lr-body"><b>${esc(l.title)}</b><span>${esc(l.subtitle)}</span></span>
        ${st?.done ? `<span class="lr-score">${Math.round(st.score * 100)}%</span>` : '<span class="lr-go">→</span>'}`);
      row.href = `#/lesson/${id}`;
      list.appendChild(row);
    });
    p.appendChild(list);
    wrap.appendChild(p);
  });
  root.appendChild(wrap);
}

/* ============================================================
   УРОК
   ============================================================ */
let quizState = null;

/* ---------- Детский первый урок ----------
   Ученики читают только с пиньинем, поэтому в детском уроке пиньинь —
   главный текст: крупный, первый, с разбором по слогам и тонами.
   Иероглиф идёт вторым, как картинка-подсказка. */

/* Номер тона по значку над гласной: ā=1, á=2, ǎ=3, à=4, без значка=0. */
function toneNumber(syl) {
  const s = String(syl || '');
  if (/[āēīōūǖ]/.test(s)) return 1;
  if (/[áéíóúǘ]/.test(s)) return 2;
  if (/[ǎěǐǒǔǚ]/.test(s)) return 3;
  if (/[àèìòùǜ]/.test(s)) return 4;
  return 0;
}
const TONE_NAMES = { 0: 'нейтральный', 1: '1-й · ровный', 2: '2-й · вверх', 3: '3-й · качели', 4: '4-й · вниз' };

/* Линия голоса для тона: та же геометрия, что и в видео-уроках. */
function toneCurveSVG(n) {
  const paths = {
    0: 'M 10 30 L 110 30',
    1: 'M 10 18 L 110 18',
    2: 'M 10 46 Q 60 36 110 14',
    3: 'M 10 34 Q 55 56 110 22',
    4: 'M 10 12 Q 60 28 110 50'
  };
  return `<svg viewBox="0 0 120 60" class="tone-curve" aria-hidden="true" focusable="false">
    <line x1="8" y1="30" x2="112" y2="30" stroke="rgba(120,100,60,.25)" stroke-dasharray="3 3"/>
    <path d="${paths[n] || paths[0]}" fill="none" stroke="var(--gold)" stroke-width="4" stroke-linecap="round"/>
  </svg>`;
}

/* Панель «как читать пиньинь + тоны»: стоит первой, до словаря. */
function renderKidIntro(l) {
  const pan = el('div', 'panel kid-intro');
  pan.appendChild(el('h3', '', '🔤 Сначала — как читать пиньинь'));
  pan.appendChild(el('p', 'kid-lead', 'Китайские звуки записаны латинскими буквами — это пиньинь. Читаем по слогам: <b>nǐ hǎo</b> — «ни-хао». Послушайте каждое слово кнопкой 🔊, а потом повторите медленно кнопкой 🐢.'));
  const grid = el('div', 'pg-grid');
  (l.pinyinGuide || []).forEach(g => {
    const c = el('div', 'pg-cell', `<div class="pg-g">${esc(g.g)}</div><div class="pg-ru">${esc(g.ru)}</div><div class="pg-note">${esc(g.note)}</div>`);
    grid.appendChild(c);
  });
  pan.appendChild(grid);

  pan.appendChild(el('h3', 'kid-tones-h', '🎵 Тоны: голос — как рука'));
  pan.appendChild(el('p', 'kid-lead', 'Тон — это значок над буквой. Он решает, какое слово вы сказали. Нажмите ▶ — услышите контур голоса, 🔊 — настоящее слово. Повторите рукой в воздухе.'));
  const tgrid = el('div', 'tone-cards');
  (l.tones || []).forEach(tn => {
    const c = el('div', 'tone-card');
    c.innerHTML = `
      <div class="tc-top"><span class="tc-mark">${esc(tn.mark)}</span><span class="tc-name">${esc(TONE_NAMES[tn.n] || tn.name)}</span></div>
      ${toneCurveSVG(tn.n)}
      <div class="tc-voice">${esc(tn.voice)}</div>
      <div class="tc-ex"><b class="tc-ex-p">${esc(tn.p)}</b> <span class="tc-ex-h">${esc(tn.h)}</span> · ${esc(tn.ru)} — ${esc(tn.r)}</div>
      <div class="tc-btns">
        <button class="btn btn-sm" data-tone="${tn.n}">▶ Контур</button>
        <button class="speak sm" data-speak="${esc(tn.h)}" aria-label="Прослушать: ${esc(tn.h)}">🔊</button>
        <button class="speak sm" data-speak-slow="${esc(tn.h)}" aria-label="Медленно: ${esc(tn.h)}">🐢</button>
      </div>`;
    const contourBtn = c.querySelector('[data-tone]');
    contourBtn.onclick = () => playTone(tn.n || 1);
    tgrid.appendChild(c);
  });
  pan.appendChild(tgrid);
  pan.appendChild(el('div', 'note', 'Один слог «ma» с разными значками — разные слова: <b>māma</b> мама · <b>mǎ</b> лошадь. Поэтому тон нельзя «примерно» — его слышно.'));
  return pan;
}

/* Карточка слова в детском уроке: пиньинь крупно и первым. */
function kidVocabCard(w) {
  const syls = (w.syl && w.syl.length ? w.syl : String(w.p).split(' ')).map(s => {
    const n = toneNumber(s);
    return `<span class="syl"><b>${esc(s)}</b><i>${n ? n + ' тон' : 'без тона'}</i></span>`;
  }).join('<span class="syl-sep">·</span>');
  const tones = (w.tone || []).map(n => `<span class="tone-badge t${n}">${n ? n : '0'}</span>`).join('');
  return el('div', 'vcard kid-card', `
    <div class="kid-p">${esc(w.p)}</div>
    <div class="kid-syls">${syls}</div>
    <div class="kid-h">${esc(w.h)}</div>
    <div class="kid-ru">читай: <b>${esc(w.ru || '')}</b></div>
    <div class="kid-r">${esc(w.r)}</div>
    ${w.note ? `<div class="kid-note">${esc(w.note)}</div>` : ''}
    <div class="kid-tools">
      <span class="tone-badges">${tones}</span>
      <button class="speak sm" data-speak="${esc(w.h)}" aria-label="Прослушать: ${esc(w.h)}">🔊</button>
      <button class="speak sm" data-speak-slow="${esc(w.h)}" aria-label="Медленно: ${esc(w.h)}">🐢</button>
      <button class="speak sm add-card" data-w="${esc(w.h)}|${esc(w.p)}|${esc(w.r)}" title="В карточки" aria-label="Добавить ${esc(w.h)} в карточки">＋</button>
    </div>`);
}

/* Диалог по ролям: каждая реплика — с озвучкой и медленным повтором. */
function renderDialogue(l) {
  const pan = el('div', 'panel dialogue');
  pan.appendChild(el('h3', '', '💬 Диалог: прочитайте по ролям'));
  pan.appendChild(el('p', 'kid-lead', 'Сначала послушайте каждую реплику, потом прочитайте вслух. Роль А — вы, роль Б — друг.'));
  const list = el('div', 'dlg-list');
  l.dialogue.forEach(line => {
    const row = el('div', 'dlg-row');
    row.innerHTML = `
      <div class="dlg-who">${esc(line.who)}</div>
      <div class="dlg-body">
        <div class="dlg-p">${esc(line.p)}</div>
        <div class="dlg-h">${esc(line.h)} <span class="dlg-r">${esc(line.r)}</span></div>
        <div class="dlg-ru">читай: ${esc(line.ru)}</div>
      </div>
      <div class="dlg-btns">
        <button class="speak sm" data-speak="${esc(line.h)}" aria-label="Прослушать реплику">🔊</button>
        <button class="speak sm" data-speak-slow="${esc(line.h)}" aria-label="Медленно: реплика">🐢</button>
      </div>`;
    list.appendChild(row);
  });
  pan.appendChild(list);
  return pan;
}

function renderLesson(root, args) {
  const id = args[0];
  const l = LESSONS[id];
  if (!l) {
    /* Тупик вместо подсказки: раньше был голый текст «Урок не найден»,
       и человеку некуда было нажать. Теперь — путь дальше. */
    const pan = el('div', 'panel');
    pan.innerHTML = '<h3>Такого урока нет</h3>' +
      '<p class="page-sub">Возможно, ссылка устарела. Вот что можно открыть:</p>' +
      '<div class="btn-row">' +
      '<a class="btn btn-primary" href="#/plan">📚 План курса</a>' +
      '<a class="btn btn-ghost" href="#/home">🏠 На главную</a>' +
      '<a class="btn btn-ghost" href="#/dict">📖 Словарь</a></div>';
    root.appendChild(pan);
    return;
  }
  const mod = MODULES.find(m => m.lessons.includes(id));
  touchDay();

  root.appendChild(el('div', 'lesson-head', `
    <div class="lh-badge">${esc(mod.level)} · ${esc(mod.title.split('—')[0].trim())}</div>
    <h1>${esc(l.title)}</h1>
    <p class="lh-sub">${esc(l.subtitle)}</p>`));

  /* --- Учитель-панда: голосовое объяснение материала урока --- */
  if (l.teacher) root.appendChild(renderTeacher(l));

  const goals = el('div', 'panel goals');
  goals.appendChild(el('h3', '', '🎯 Цели урока'));
  l.goals.forEach(g => goals.appendChild(el('div', 'goal', `• ${esc(g)}`)));
  root.appendChild(goals);

  /* --- Детский старт: сначала учимся читать пиньинь и тоны --- */
  if (l.kid) root.appendChild(renderKidIntro(l));

  /* --- Словарь --- */
  const v = el('div', 'panel');
  v.appendChild(el('div', 'panel-head', `<h3>📖 Новые слова (${l.vocab.length})</h3>
    <div class="btn-row">
      <button class="btn btn-sm" id="toggleRuby">${state.hideRuby ? 'Показать пиньинь' : 'Скрыть пиньинь'}</button>
      <button class="btn btn-sm" id="playAll">🔊 Прослушать все</button>
    </div>`));
  const tbl = el('div', 'vocab' + (l.kid ? ' kid-vocab' : ''));
  l.vocab.forEach(w => {
    tbl.appendChild(l.kid ? kidVocabCard(w) : el('div', 'vcard', `
      <div class="vc-h">${ruby(w.h)}</div>
      <div class="vc-p">${esc(w.p)}</div>
      <div class="vc-r">${esc(w.r)}</div>
      <div class="vc-tools">${toneBtn(w.h, 'speak sm')}<button class="speak sm add-card" data-w="${esc(w.h)}|${esc(w.p)}|${esc(w.r)}" title="В карточки" aria-label="Добавить ${esc(w.h)} в карточки">＋</button></div>`));
  });
  v.appendChild(tbl);
  root.appendChild(v);
  /* Пиньинь по умолчанию включён, но кто уже читает иероглифы — может скрыть. */
  $('#toggleRuby').onclick = () => {
    state.hideRuby = !state.hideRuby;
    document.body.classList.toggle('hide-ruby', !!state.hideRuby);
    save();
    renderLesson(root, args);
  };
  $('#toggleRuby').textContent = state.hideRuby ? 'Показать пиньинь' : 'Скрыть пиньинь';
  document.body.classList.toggle('hide-ruby', !!state.hideRuby);

  /* --- Грамматика --- */
  const g = el('div', 'panel');
  g.appendChild(el('h3', '', '📐 Грамматика'));
  l.grammar.forEach((gr, i) => {
    const b = el('div', 'gram');
    b.appendChild(el('div', 'gram-t', `${i + 1}. ${esc(gr.t)}`));
    b.appendChild(el('div', 'gram-b', gr.b));
    g.appendChild(b);
  });
  root.appendChild(g);

  /* --- Диалог: читаем по ролям, пиньинь крупно --- */
  if (l.dialogue && l.dialogue.length) root.appendChild(renderDialogue(l));

  /* --- Практика --- */
  quizState = { lesson: id, idx: 0, correct: 0, answers: [], done: false };
  const qz = el('div', 'panel quiz-panel');
  qz.id = 'quiz';
  qz.appendChild(el('h3', '', '✏️ Практика'));
  qz.appendChild(el('div', 'quiz-note', 'Выбирайте ответ или расставляйте слова — печатать иероглифы не нужно. В каждом вопросе есть пиньинь, а после ответа — объяснение.'));
  qz.appendChild(el('div', 'quiz-host'));
  root.appendChild(qz);
  renderQuestion($('#quiz .quiz-host'));

  /* --- Домашка: выполняется и отправляется прямо здесь --- */
  if (typeof window.renderHomeworkPanel === 'function') {
    window.renderHomeworkPanel(root, id);
  } else {
    const hw = el('div', 'panel hw');
    hw.appendChild(el('h3', '', '🏠 Домашка'));
    l.hw.forEach(h => hw.appendChild(el('div', 'hw-item', `□ ${esc(h)}`)));
    root.appendChild(hw);
  }

  root.appendChild(el('div', 'nav-lessons', lessonNavHTML(id)));
}

function lessonNavHTML(id) {
  const ids = allLessonIds();
  const i = ids.indexOf(id);
  const prev = ids[i - 1], next = ids[i + 1];
  return `<a class="btn btn-ghost" href="${prev ? `#/lesson/${prev}` : '#/plan'}">← Назад</a>
          <a class="btn btn-primary" href="${next ? `#/lesson/${next}` : '#/plan'}">Следующий урок →</a>`;
}

function quizSource() { return quizState.lesson === 'diag' ? DIAGNOSTIC : LESSONS[quizState.lesson]; }

/* Плеер для аудирования. Если у задания есть поле speak (слово из словаря
   урока), озвучиваем именно его: в вариантах стоят похожие иероглифы, и
   прочитать их вслух было бы подсказкой. */
function listenRow(q) {
  const word = q.speak || q.o[q.a];
  return el('div', 'listen-row', `${toneBtn(word, 'speak big')} <span>нажмите, чтобы услышать</span>`);
}

/* Горячие клавиши в практике: 1–4 — выбор ответа, Enter — следующий вопрос.
   Без этого на компьютере приходилось каждый раз тянуться к мыши. */
function setQuizKeys(handler) {
  clearQuizKeys();
  if (!quizState) return;
  quizState._keys = handler;
  document.addEventListener('keydown', handler);
}
function clearQuizKeys() {
  if (quizState && quizState._keys) {
    document.removeEventListener('keydown', quizState._keys);
    quizState._keys = null;
  }
}
function renderQuestion(host) {
  const l = quizSource();
  const q = l.quiz[quizState.idx];
  clearQuizKeys();
  host.innerHTML = '';
  if (!q) { finishQuiz(host); return; }

  const head = el('div', 'q-head', `
    <span>Вопрос ${quizState.idx + 1} из ${l.quiz.length}</span>
    <div class="q-bar"><div style="width:${quizState.idx / l.quiz.length * 100}%"></div></div>`);
  host.appendChild(head);

  const body = el('div', 'q-body');
  body.appendChild(el('div', 'q-text', ruby(q.q)));
  // Аудирование: плеер стоит ВЫШЕ вариантов. Раньше кнопка «услышать»
  // была под списком ответов, и ученик сначала читал иероглифы, а уже
  // потом включал звук — то есть задание не проверяло слух.
  if (q.k === 'listen') body.appendChild(listenRow(q));
  const fb = el('div', 'q-feedback');
  const controls = el('div', 'q-controls');

  const check = (ok, expl) => {
    if (body.dataset.answered) return;
    body.dataset.answered = '1';
    state.totalRight += ok ? 1 : 0;
    state.totalWrong += ok ? 0 : 1;
    if (ok) quizState.correct++;
    quizState.answers.push({ q: q.q, ok });
    playSfx(ok ? 'ok' : 'bad');
    fb.className = 'q-feedback ' + (ok ? 'ok' : 'bad');
    fb.setAttribute('role', 'status');
    fb.setAttribute('aria-live', 'assertive');
    fb.setAttribute('aria-atomic', 'true');
    fb.innerHTML = (ok ? '✅ Верно! ' : '❌ Не совсем. ') + (expl || '');
    fb.style.display = 'block';
    const next = el('button', 'btn btn-primary', quizState.idx + 1 >= l.quiz.length ? 'Итоги →' : 'Далее →');
    next.onclick = () => { quizState.idx++; renderQuestion(host); };
    controls.innerHTML = '';
    controls.appendChild(next);
    save();
  };

  if (q.k === 'mcq' || q.k === 'listen') {
    const opts = el('div', 'opts');
    q.o.forEach((o, i) => {
      const b = el('button', 'opt', `<span class="opt-k">${'ABCD'[i]}</span><span>${ruby(o)}</span>`);
      b.onclick = () => {
        const ok = i === q.a;
        $$('.opt', opts).forEach((x, xi) => {
          x.disabled = true;
          if (xi === q.a) x.classList.add('right');
          if (xi === i && !ok) x.classList.add('wrong');
        });
        check(ok, ok ? '' : `Правильный ответ: <b>${ruby(q.o[q.a])}</b>`);
      };
      opts.appendChild(b);
    });
    body.appendChild(opts);
    body.appendChild(el('div', 'q-hint', 'Клавиши 1–4 — ответ, Enter — далее'));
    setQuizKeys(e => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '')) return;
      if (body.dataset.answered) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const nb = controls.querySelector('button');
          if (nb) nb.click();
        }
        return;
      }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= q.o.length) {
        e.preventDefault();
        const btns = $$('.opt', opts);
        if (btns[n - 1]) btns[n - 1].click();
      }
    });
  } else if (q.k === 'gap') {
    const inp = el('input', 'gap-input');
    inp.placeholder = 'введите ответ по-китайски';  // практика курса без этого типа заданий
    inp.onkeydown = e => { if (e.key === 'Enter') submit(); };
    const sub = el('button', 'btn btn-primary', 'Проверить');
    const norm = s => String(s).trim().replace(/[。．.，,？?！!、\s]/g, '').toLowerCase();
    function submit() {
      const val = norm(inp.value);
      if (!val) return;
      const ok = q.a.some(a => norm(a) === val);
      inp.disabled = true; sub.disabled = true;
      inp.classList.add(ok ? 'right' : 'wrong');
      check(ok, ok ? '' : `Правильно: <b>${ruby(q.a[0])}</b>${q.h ? ' — ' + esc(q.h) : ''}`);
    }
    sub.onclick = submit;
    const row = el('div', 'gap-row');
    row.appendChild(inp); row.appendChild(sub);
    body.appendChild(row);
  } else if (q.k === 'order') {
    const picked = [];
    const pool = el('div', 'order-pool');
    const line = el('div', 'order-line');
    q.o.forEach((w, i) => {
      const b = el('button', 'ow', ruby(w));
      b.dataset.i = i;
      b.onclick = () => {
        if (b.classList.contains('used')) return;
        b.classList.add('used');
        picked.push({ w, i });
        line.appendChild(el('button', 'ow used-inline', ruby(w)));
      };
      pool.appendChild(b);
    });
    const back = el('button', 'btn btn-sm', '↺ Сбросить');
    back.onclick = () => {
      picked.length = 0; line.innerHTML = '';
      $$('.ow', pool).forEach(x => x.classList.remove('used'));
    };
    const sub = el('button', 'btn btn-primary', 'Проверить');
    sub.onclick = () => {
      const seq = picked.map(x => x.i);
      const ok = JSON.stringify(seq) === JSON.stringify(q.a);
      sub.disabled = true; back.disabled = true;
      check(ok, ok ? '' : `Правильно: <b>${ruby(q.a.map(i => q.o[i]).join(''))}</b>`);
    };
    body.appendChild(line);
    body.appendChild(pool);
    const ctr = el('div', 'q-controls-inline');
    ctr.appendChild(back); ctr.appendChild(sub);
    body.appendChild(ctr);
  }

  body.appendChild(fb);
  body.appendChild(controls);
  host.appendChild(body);
}

function finishQuiz(host) {
  clearQuizKeys();
  const l = quizSource();
  const score = quizState.correct / l.quiz.length;
  if (quizState.lesson === 'diag') { renderDiagResult(host, score); return; }
  const prev = state.lessons[quizState.lesson] || {};
  state.lessons[quizState.lesson] = {
    done: true,
    score: Math.max(prev.score || 0, score),
    last: score,
    at: Date.now()
  };
  state.quizLog.push({ lesson: quizState.lesson, score, at: Date.now() });
  // Без ограничения лог рос бы годами и раздувал и браузер, и запросы.
  state.quizLog = state.quizLog.slice(-500);
  save();
  if (score >= 0.6) { playSfx('win'); launchConfetti(); }
  /* Практика пройдена — урок засчитан, домашка открылась. Сразу ведём
     ученика к ней: раньше после итогов он уходил «к плану» и домашку
     приходилось искать самому. */
  const lessonId = quizState.lesson;
  const nextId = (allLessonIds()[allLessonIds().indexOf(lessonId) + 1]) || null;
  setTimeout(() => {
    // scroll: false — сразу после итогов ученик всё равно уходит в раздел
    // «Домашки», прокручивать урок к блоку домашки уже незачем.
    if (window.hwUnlock) window.hwUnlock(lessonId, nextId, { scroll: false });
  }, 0);

  host.innerHTML = `<div class="quiz-done">
      <div class="qd-emoji">${score >= 0.8 ? '🎉' : score >= 0.5 ? '👍' : '💪'}${score >= 0.8 ? scrawl('spark', { style: 'width:38px;height:38px' }) : ''}</div>
      <h3>Результат: ${quizState.correct} из ${l.quiz.length} (${Math.round(score * 100)}%)</h3>
      <p>${score >= 0.8 ? 'Отличная работа! Этот урок засчитан.'
        : score >= 0.5 ? 'Хорошо, но есть что подтянуть. Посмотрите ошибки выше и повторите урок.'
        : 'Пройдите урок ещё раз после повторения грамматики — и держите темп!'}</p>
      <div class="qd-unlock">🔓 Домашка к этому уроку открыта — переходим к ней…</div>
      <div class="qd-actions">
        <a class="btn btn-primary" id="goHomework" href="#/homework/${lessonId}">🏠 К домашке →</a>
        <a class="btn btn-ghost" href="#/lesson/${lessonId}">↻ Повторить урок</a>
        <a class="btn btn-ghost" href="#/plan">К плану →</a>
      </div>
    </div>`;

  /* Через несколько секунд сами переходим к домашке, но только если
     ученик ещё не ушёл со страницы итогов и не нажал свою кнопку. */
  const goBtn = host.querySelector('#goHomework');
  const cancel = () => {
    clearTimeout(finishQuiz._t);
    finishQuiz._t = null;
    window.removeEventListener('hashchange', cancel);
  };
  const go = () => {
    window.removeEventListener('hashchange', cancel);
    // Если ученик уже ушёл на другую страницу — не перетаскиваем его.
    if (!document.body.contains(goBtn)) return;
    location.hash = '#/homework/' + lessonId;
  };
  clearTimeout(finishQuiz._t);
  finishQuiz._t = setTimeout(go, 3500);
  window.addEventListener('hashchange', cancel);
  if (goBtn) goBtn.addEventListener('click', cancel);
}

/* ============================================================
   ДИАГНОСТИКА УРОВНЯ
   ============================================================ */
const LEVELS = [
  { min: 42, name: 'HSK 3–4', title: 'Уверенный новичок', mod: 'm3', lesson: 'l9',
    text: 'База есть: вы читаете иероглифы, понимаете структуру предложения. Стартуем с Модуля 3 — связная речь, модальные глаголы, 把.' },
  { min: 32, name: 'HSK 2–3', title: 'Средний', mod: 'm2', lesson: 'l5',
    text: 'Базовые конструкции вы знаете, но путаетесь в отрицаниях, 了 и времени. Стартуем с Модуля 2 — там как раз эти темы.' },
  { min: 20, name: 'HSK 1–2', title: 'Начальный', mod: 'm1', lesson: 'l3',
    text: 'Есть словарь и простые фразы, но систему пока не выстроили. Стартуем с Модуля 1: оседлаем грамматику, а не просто запоминаем слова.' },
  { min: 8, name: 'Уровень 0', title: 'Почти с нуля', mod: 'm1', lesson: 'l1',
    text: 'Пиньинь и первые слова. Начнём с азбуки звуков и 100 базовых иероглифов — это фундамент, с ним всё остальное пойдёт легко.' },
  { min: 0, name: 'Старт', title: 'Полный ноль', mod: 'm1', lesson: 'l1',
    text: 'Идеально для старта с нуля. Первый урок: тоны, пиньинь, первые 16 слов и первые фразы.' }
];
function levelFor(score) { return LEVELS.find(l => score >= l.min) || LEVELS[LEVELS.length - 1]; }

function renderDiagnostic(root) {
  const wrap = el('div');
  wrap.appendChild(el('h1', 'page-title', 'Диагностика уровня'));
  wrap.appendChild(el('p', 'page-sub', '50 вопросов на пиньинь, словарь и грамматику. Все ответы выбираются из вариантов — печатать иероглифы не нужно. Где сомневаетесь, выбирайте наугад: по ошибкам и строится разбор.'));
  const host = el('div', 'quiz-host');
  wrap.appendChild(host);
  root.appendChild(wrap);

  host.innerHTML = `<div class="panel quiz-intro">
    <h3>Как это работает</h3>
    <ul class="diag-list">
      <li>Тест занимает 10–15 минут</li>
      <li>Вопросы идут от простого к сложному</li>
      <li>В конце вы получите уровень и рекомендацию, с какого урока начать</li>
    </ul>
    <button class="btn btn-primary" id="startDiag">▶ Начать тест</button>
  </div>`;
  $('#startDiag').onclick = () => {
    quizState = { lesson: 'diag', idx: 0, correct: 0, answers: [], done: false };
    renderQuestion(host);
  };
}

function renderDiagResult(host, score) {
  const lvl = levelFor(Math.round(score * DIAGNOSTIC.quiz.length));
  const total = DIAGNOSTIC.quiz.length;
  const right = Math.round(score * total);
  state.lastDiag = { score, at: Date.now(), level: lvl.name };
  save();
  const weak = quizState.answers.filter(a => !a.ok).slice(0, 8).map(a => a.q);
  host.innerHTML = `<div class="panel quiz-done">
      <div class="qd-emoji">${score >= 0.8 ? '🎉' : score >= 0.5 ? '👍' : '💪'}${score >= 0.8 ? scrawl('spark', { style: 'width:38px;height:38px' }) : ''}</div>
      <div class="level-badge">${esc(lvl.name)}</div>
      <h3>${esc(lvl.title)}</h3>
      <p>Правильно ${right} из ${total} (${Math.round(score * 100)}%)</p>
      <div class="diag-result">${esc(lvl.text)}</div>
      ${weak.length ? `<div class="diag-weak"><b>Стоит подтянуть:</b>${weak.map(q => `<span class="weak-chip">${esc(q)}</span>`).join('')}</div>` : '<div class="diag-weak">Ошибок нет — отличный результат!</div>'}
      <div class="qd-actions">
        <a class="btn btn-primary" href="#/lesson/${lvl.lesson}">Начать с урока →</a>
        <a class="btn btn-ghost" href="#/plan">Все уроки</a>
        <button class="btn btn-ghost" id="redoDiag">↻ Пройти заново</button>
      </div>
    </div>`;
  $('#redoDiag').onclick = () => {
    quizState = { lesson: 'diag', idx: 0, correct: 0, answers: [], done: false };
    renderQuestion(host);
  };
}

/* ============================================================
   КАРТОЧКИ (SRS — Leitner)
   ============================================================ */
const BOX_DAYS = [0, 1, 2, 4, 8, 16];
function cardKey(w) { return w.h; }
function addCard(h, p, r, deferSave = false) {
  if (!state.cards[cardKey({ h })]) state.cards[cardKey({ h })] = { box: 0, due: Date.now(), right: 0, wrong: 0, p, r };
  else { const c = state.cards[cardKey({ h })]; if (p) c.p = p; if (r) c.r = r; }
  if (!deferSave) save();
}
function cardPool() {
  const pool = [];
  Object.entries(state.cards).forEach(([k, c]) => {
    const fb = (!c.r || !c.p) ? lookupCardInfo(k) : null;
    pool.push({
      h: k,
      p: c.p || (fb && fb.p) || '',
      r: c.r || (fb && fb.r) || ''
    });
  });
  return pool;
}
let cardSession = { pool: [], idx: 0, right: 0, wrong: 0, revealed: false };

function renderCards(root) {
  const wrap = el('div');
  wrap.appendChild(el('h1', 'page-title', 'Карточки для запоминания'));
  wrap.appendChild(el('p', 'page-sub', 'Интервальное повторение (Leitner): правильный ответ — карточка отодвигается дальше, ошибка — возвращается в начало.'));

  const pool = cardPool();
  const due = dueCards();
  const hard = pool.filter(c => {
    const st = state.cards[c.h];
    return st && st.wrong > 0 && (st.wrong >= st.right || st.box === 0);
  });
  const bar = el('div', 'panel srs-bar');
  bar.appendChild(el('div', 'srs-stats', `
    <div><b>${pool.length}</b><span>всего карточек</span></div>
    <div><b>${due.length}</b><span>к повторению</span></div>
    <div><b>${hard.length}</b><span>сложных</span></div>
    <div><b>${state.streak}</b><span>дней подряд</span></div>`));
  bar.appendChild(el('div', 'btn-row', `
    <button class="btn btn-primary" id="startSrs">▶ Начать повторение (${due.length || pool.length})</button>
    ${hard.length ? `<button class="btn btn-ghost" id="startHard">🎯 Работа над ошибками (${hard.length})</button>` : ''}
    <button class="btn btn-ghost" id="addAllVocab">＋ Добавить весь словарь курса</button>`));

  /* форма добавления своей карточки */
  const customForm = el('form', 'custom-card-form', `
    <input class="cc-in" name="h" placeholder="Иероглиф (напр. 加油)" required>
    <input class="cc-in" name="p" placeholder="Пиньинь (jiāyóu)">
    <input class="cc-in wide" name="r" placeholder="Перевод (не сдавайся!)" required>
    <button class="btn btn-sm btn-primary" type="submit">＋ Своё слово</button>`);
  customForm.onsubmit = (e) => {
    e.preventDefault();
    const h = customForm.querySelector('[name="h"]').value.trim();
    const p = customForm.querySelector('[name="p"]').value.trim();
    const r = customForm.querySelector('[name="r"]').value.trim();
    if (!h || !r) return;
    addCard(h, p, r);
    toast(`「${h}» добавлено`);
    root.innerHTML = '';
    renderCards(root);
  };
  bar.appendChild(customForm);
  wrap.appendChild(bar);

  const host = el('div', 'srs-host');
  wrap.appendChild(host);
  root.appendChild(wrap);

  $('#startSrs').onclick = () => {
    const p = (due.length ? due.map(k => pool.find(c => c.h === k)) : pool).filter(Boolean);
    if (!p.length) { toast('Сначала добавьте карточки'); return; }
    cardSession = { pool: shuffle(p), idx: 0, right: 0, wrong: 0, revealed: false };
    renderCard(host);
  };
  const hb = $('#startHard');
  if (hb) hb.onclick = () => {
    cardSession = { pool: shuffle(hard), idx: 0, right: 0, wrong: 0, revealed: false };
    renderCard(host);
  };
  $('#addAllVocab').onclick = () => {
    let n = 0;
    Object.values(LESSONS).forEach(l => l.vocab.forEach(w => { addCard(w.h, w.p, w.r, true); n++; }));
    save();
    toast(`Добавлено слов: ${n}`);
    root.innerHTML = '';
    renderCards(root);
  };
  root.appendChild(cardListPanel());
}
function cardListPanel() {
  const pool = cardPool();
  const p = el('div', 'panel');
  p.appendChild(el('h3', '', `Мои карточки (${pool.length})`));
  if (!pool.length) { p.appendChild(el('div', 'empty', 'Пока пусто. Нажмите «＋» рядом со словом в уроке или добавьте весь словарь.' + scrawl('curl', { style: 'width:34px;height:34px;margin-left:6px' }))); return p; }
  const list = el('div', 'card-list');
  pool.forEach(c => {
    const st = state.cards[c.h] || { box: 0 };
    const box = Math.max(0, Math.min(5, Number(st.box || 0)));
    const row = el('div', 'cl-row', `
      <span class="cl-h">${esc(c.h)}</span>
      <span class="cl-p">${esc(c.p)}</span>
      <span class="cl-r">${esc(c.r || '—')}</span>
      <span class="cl-box" title="Коробка Лейтнера">${'▮'.repeat(box + 1)}<i>${'▯'.repeat(5 - box)}</i></span>
      <button class="cl-del" data-del="${esc(c.h)}" title="Удалить" aria-label="Удалить ${esc(c.h)} из карточек">✕</button>`);
    list.appendChild(row);
  });
  p.appendChild(list);
  return p;
}
document.addEventListener('click', e => {
  const d = e.target.closest('[data-del]');
  if (d) { delete state.cards[d.dataset.del]; save(); toast('Удалено'); location.hash = '#/cards'; route(); }
});
document.addEventListener('click', e => {
  const a = e.target.closest('.add-card');
  if (a) {
    const [h, p, r] = a.dataset.w.split('|');
    addCard(h, p, r);
    toast(`「${h}» → в карточки`);
    a.textContent = '✓';
    a.classList.add('added');
  }
});
function shuffle(a) { const c = a.slice(); for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c; }

function lookupCardInfo(h) {
  for (const l of Object.values(LESSONS)) {
    const w = l.vocab.find(x => x.h === h);
    if (w) return w;
  }
  if (typeof PHRASES !== 'undefined') {
    for (const cat of PHRASES) {
      const w = (cat.items || []).find(x => x.h === h);
      if (w) return w;
    }
  }
  return null;
}

function renderCard(host) {
  host.innerHTML = '';
  const s = cardSession;
  const c = s.pool[s.idx];
  if (!c) {
    if (s.right > 0 && s.right >= s.wrong) { playSfx('win'); launchConfetti(); }
    host.appendChild(el('div', 'panel quiz-done', `
      <div class="qd-emoji">🏆</div>
      <h3>Сессия завершена!</h3>
      <p>Правильно: ${s.right} · Ошибок: ${s.wrong}</p>
      <div class="qd-actions"><button class="btn btn-primary" id="againSrs">Ещё раз</button><a class="btn btn-ghost" href="#/home">На главную</a></div>`));
    $('#againSrs').onclick = () => { cardSession = { pool: shuffle(s.pool), idx: 0, right: 0, wrong: 0, revealed: false }; renderCard(host); };
    return;
  }
  const fallback = (!c.r || !c.p) ? lookupCardInfo(c.h) : null;
  const py = c.p || (fallback && fallback.p) || '';
  const tr = c.r || (fallback && fallback.r) || '—';

  const card = el('div', 'flashcard fc-3d');
  const inner = el('div', 'fc-inner' + (s.revealed ? ' flipped' : ''));
  const front = el('div', 'fc-face fc-front');
  const back = el('div', 'fc-face fc-back');

  front.appendChild(el('div', 'fc-progress', `Карточка ${s.idx + 1} / ${s.pool.length}`));
  front.appendChild(el('div', 'fc-hanzi', esc(c.h)));
  front.appendChild(el('div', 'fc-pinyin', esc(py)));
  const showBtn = el('button', 'btn btn-primary fc-show', 'Показать перевод');
  front.appendChild(showBtn);
  front.appendChild(el('div', 'fc-speak-row', `${toneBtn(c.h, 'speak big')}<span>произношение · нажмите карточку</span>`));

  back.appendChild(el('div', 'fc-progress', `Карточка ${s.idx + 1} / ${s.pool.length}`));
  back.appendChild(el('div', 'fc-hanzi sm', esc(c.h)));
  back.appendChild(el('div', 'fc-pinyin', esc(py)));
  back.appendChild(el('div', 'fc-reveal', `<b>${esc(tr)}</b><br><span class="fc-tip">Перевод</span>`));
  back.appendChild(el('div', 'fc-speak-row', `${toneBtn(c.h, 'speak big')}<span>свайп ← снова · → помню</span>`));

  inner.appendChild(front);
  inner.appendChild(back);
  card.appendChild(inner);
  host.appendChild(card);

  const actions = el('div', 'fc-actions');
  host.appendChild(actions);

  const grade = (ok) => {
    const cur = state.cards[c.h];
    if (ok) { cur.box = Math.min(cur.box + 1, BOX_DAYS.length - 1); cur.right++; s.right++; playSfx('ok'); }
    else { cur.box = 0; cur.wrong++; s.wrong++; playSfx('bad'); }
    cur.due = Date.now() + BOX_DAYS[cur.box] * 864e5;
    save();
    s.idx++; s.revealed = false;
    renderCard(host);
  };

  function renderActions() {
    actions.innerHTML = '';
    if (!s.revealed) return;
    const again = el('button', 'btn btn-ghost', '↻ Снова');
    const good = el('button', 'btn btn-primary', '✓ Помню');
    again.onclick = () => grade(false);
    good.onclick = () => grade(true);
    actions.appendChild(again);
    actions.appendChild(good);
  }

  const reveal = () => {
    if (s.revealed) return;
    s.revealed = true;
    inner.classList.add('flipped');
    renderActions();
  };
  showBtn.onclick = (e) => { e.stopPropagation(); reveal(); };
  card.onclick = (e) => { if (!e.target.closest('button')) reveal(); };

  /* свайп влево/вправо на телефоне */
  let touchX = null;
  card.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches[0]) touchX = e.touches[0].clientX;
  }, { passive: true });
  card.addEventListener('touchend', (e) => {
    if (touchX === null || !e.changedTouches || !e.changedTouches[0]) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (!s.revealed && Math.abs(dx) > 40) { reveal(); return; }
    if (s.revealed && dx < -65) grade(false);
    else if (s.revealed && dx > 65) grade(true);
  }, { passive: true });

  renderActions();
}

/* ============================================================
   ТОНЫ
   ============================================================ */
let audioCtx = null;
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
/* Контуры тонов: 1 плоский, 2 восходящий, 3 падающе-восходящий, 4 падающий */
function playTone(n, dur = 1.0) {
  try {
    const ctx = getCtx();
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    const pts = {
      1: [[0, 260], [dur, 260]],
      2: [[0, 240], [dur * 0.85, 380]],
      3: [[0, 270], [dur * 0.42, 185], [dur * 0.85, 260]],
      4: [[0, 380], [dur * 0.9, 175]]
    }[n];
    osc.frequency.setValueAtTime(pts[0][1], t0);
    for (let i = 1; i < pts.length; i++) osc.frequency.linearRampToValueAtTime(pts[i][1], t0 + pts[i][0]);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.04);
    g.gain.setValueAtTime(0.25, t0 + dur - 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  } catch (e) { toast('Аудио недоступно'); }
}

let toneState = { mode: 'listen', idx: 0, right: 0, wrong: 0, locked: false, pool: [] };
function renderTones(root) {
  const wrap = el('div');
  wrap.appendChild(el('h1', 'page-title', 'Тренажёр тонов'));
  wrap.appendChild(el('p', 'page-sub', 'Тоны меняют значение слова. Сначала послушайте контур, потом определите тон. Синтез работает в браузере (Web Audio) — настоящее произношение — кнопкой 🔊.'));

  const tabs = el('div', 'tabs');
  [['listen', '🎧 Услышь → выбери тон'], ['rule', '📏 Правила чтения'], ['quiz', '📝 Тест по пиньиню']].forEach(([id, t]) => {
    const b = el('button', 'tab' + (toneState.mode === id ? ' active' : ''), t);
    b.onclick = () => { toneState.mode = id; renderTones(root); };
    tabs.appendChild(b);
  });
  wrap.appendChild(tabs);

  const host = el('div', 'tone-host');
  wrap.appendChild(host);
  root.appendChild(wrap);

  if (toneState.mode === 'listen') renderToneListen(host);
  else if (toneState.mode === 'rule') renderToneRules(host);
  else renderToneQuiz(host);
}

function renderToneListen(host) {
  host.innerHTML = '';
  const p = el('div', 'panel');
  p.appendChild(el('h3', '', 'Как звучат 4 тона'));
  const grid = el('div', 'tone-grid');
  TONE_EXAMPLES.filter(x => ['ā', 'á', 'ǎ', 'à'].includes(x.s)).forEach(t => {
    const c = el('div', 'tone-cell');
    c.innerHTML = `<div class="tc-s">${esc(t.s)}</div><div class="tc-n">Тон ${t.n}</div><div class="tc-r">${esc(t.r)}</div>`;
    const b = el('button', 'btn btn-sm', '▶ Контур');
    b.onclick = () => playTone(t.n);
    c.appendChild(b);
    grid.appendChild(c);
  });
  p.appendChild(grid);
  p.appendChild(el('div', 'note', 'Тон 1 — ровный; Тон 2 — восходящий; Тон 3 — падает и снова поднимается; Тон 4 — резко падает. Настоящее звучание — кнопка 🔊 рядом с примером.'));
  host.appendChild(p);

  const all = el('div', 'panel');
  all.appendChild(el('h3', '', 'Все 4 тона на одном слоге (a)'));
  const tbl = el('div', 'tone-table');
  TONE_EXAMPLES.forEach(t => {
    const row = el('div', 'tt-row', `
      <span class="tt-s">${esc(t.s)}</span>
      <span class="tt-n">${t.n}</span>
      <span class="tt-ex">${esc(t.ex)}</span>
      <span class="tt-r">${esc(t.r)}</span>`);
    const b = el('button', 'speak sm', '🔊');
    b.setAttribute('aria-label', 'Прослушать произношение');
    b.onclick = () => speak(t.ex.replace(/[^\u4e00-\u9fa5]/g, '') || t.s);
    row.appendChild(b);
    const tb = el('button', 'btn btn-sm', '▶');
    tb.onclick = () => playTone(t.n);
    row.appendChild(tb);
    tbl.appendChild(row);
  });
  all.appendChild(tbl);
  host.appendChild(all);
}

function renderToneRules(host) {
  host.innerHTML = '';
  const p = el('div', 'panel');
  p.appendChild(el('h3', '', 'Правила чтения пиньинь'));
  const rules = [
    ['a', 'ā á ǎ à', 'Тон 3 никогда не пишется на «a» — вместо него «a» с плоской чертой. ā á à — 1, 2, 4.'],
    ['o', 'ō ó ǒ ò', 'Тон 3 пишется как «o» с плоской чертой: ǒ.'],
    ['e', 'ē é ě è', 'Здесь все 4 тона пишутся полностью.'],
    ['i', 'ī í ǐ ì', 'После zh/ch/sh/r — i пишется как yi: zhī.'],
    ['u', 'ū ú ǔ ù', 'После zh/ch/sh/r — u пишется как yu: zhū.'],
    ['ü', 'ǖ ǘ ǚ ǜ', 'После j/q/x/y — ü пишется как u: ju. После n/l — ü сохраняется: nü.'],
    ['zhi chi shi ri', 'zhī chī shī rì', 'Это не zh + i: i здесь — «и» без зубного звука, звук [ɻ].'],
    ['zi ci si', 'zī cī sī', 'Здесь i звучит как [ɹ] — «цзы», «цы», «сы».'],
    ['yi', 'yī', 'Перед 4-м тоном → yí (yí gè 一 个). Перед 1/2/3 → yì в начале слова (yì tiān 一天).'],
    ['bu', 'bù', 'Перед 4-м тоном → bú (bú shì). Перед 1/2/3 → bù.'],
    ['ma', 'mā má mǎ mà', 'Не путать mā (мама) / má (конопля) / mǎ (лошадь) / mà (ругать).']
  ];
  const tbl = el('div', 'rule-table');
  rules.forEach(r => {
    tbl.appendChild(el('div', 'rt-row', `<b>${esc(r[0])}</b><span class="rt-v">${esc(r[1])}</span><span class="rt-b">${esc(r[2])}</span>`));
  });
  p.appendChild(tbl);
  host.appendChild(p);
}

function renderToneQuiz(host) {
  host.innerHTML = '';
  const p = el('div', 'panel');
  p.appendChild(el('h3', '', 'Угадай тон по пиньиню'));
  const s = toneState;
  if (!s.pool.length) {
    s.pool = shuffle(TONE_EXAMPLES.slice());
    s.idx = 0; s.right = 0; s.wrong = 0;
  }
  const item = s.pool[s.idx];
  const card = el('div', 'tone-quiz');
  card.appendChild(el('div', 'tq-info', `Вопрос ${s.idx + 1} / ${s.pool.length} · Верно: ${s.right} · Ошибок: ${s.wrong}`));
  card.appendChild(el('div', 'tq-syl', esc(item.s)));
  const play = el('button', 'btn btn-primary', '▶▶ Прослушать');
  play.onclick = () => playTone(item.n);
  card.appendChild(play);
  const opts = el('div', 'tone-opts');
  [1, 2, 3, 4].forEach(n => {
    const b = el('button', 'tone-opt', `${n}`);
    b.onclick = () => {
      if (s.locked) return;
      s.locked = true;
      const ok = n === item.n;
      if (ok) s.right++; else s.wrong++;
      $$('.tone-opt', opts).forEach(x => { x.disabled = true; if (+x.textContent === item.n) x.classList.add('right'); });
      if (!ok) b.classList.add('wrong');
      const next = el('button', 'btn btn-primary', 'Далее →');
      next.onclick = () => { s.idx++; s.locked = false; renderToneQuiz(host); };
      card.appendChild(next);
    };
    opts.appendChild(b);
  });
  card.appendChild(opts);
  card.appendChild(el('div', 'tq-ans', `Ответ: ${item.ex} — ${item.r}`));
  p.appendChild(card);
  host.appendChild(p);
}

/* ============================================================
   ПРОПИСЬ ИЕРОГЛИФОВ
   ============================================================ */
let writeState = { idx: 0 };
function renderWrite(root) {
  const wrap = el('div');
  wrap.appendChild(el('h1', 'page-title', 'Пропись иероглифов'));
  wrap.appendChild(el('p', 'page-sub', 'Обведите образец в клетке 天字格 (米字格). Мышь или палец. Сброс — кнопкой.'));
  const host = el('div', 'write-host');
  wrap.appendChild(host);
  root.appendChild(wrap);
  renderWriteCard(host);
}
function renderWriteCard(host) {
  host.innerHTML = '';
  const item = HANDWRITING[writeState.idx];
  const p = el('div', 'panel write-panel');
  const info = el('div', 'write-info', `
    <div class="wi-h">${esc(item.h)}</div>
    <div class="wi-p">${esc(item.p)}</div>
    <div class="wi-r">${esc(item.r)}</div>
    <div class="wi-s">${item.strokes} черт</div>`);
  p.appendChild(info);

  const box = el('div', 'write-box');
  const canvas = el('canvas', 'wcanvas');
  const size = 300;
  canvas.width = size * 2; canvas.height = size * 2;
  canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.scale(2, 2);

  function grid() {
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#fffdf7'; ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#e3b9a8'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size); ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2); ctx.stroke();
    ctx.strokeStyle = '#f0d5c8';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(size, size); ctx.moveTo(size, 0); ctx.lineTo(0, size); ctx.stroke();
    ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);
    ctx.fillStyle = 'rgba(60,60,60,0.13)';
    ctx.font = `${Math.round(size * 0.82)}px "Noto Serif SC", "Songti SC", serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(item.h, size / 2, size / 2 + size * 0.03);
  }
  grid();

  let demoTimer = null;
  function playDemo() {
    if (!ctx) return;
    clearInterval(demoTimer);
    grid();
    let step = 0;
    const total = 24;
    demoTimer = setInterval(() => {
      step++;
      grid();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, size, (size * step) / total);
      ctx.clip();
      ctx.fillStyle = 'rgba(208,69,58,0.68)';
      ctx.font = `${Math.round(size * 0.82)}px "Noto Serif SC", "Songti SC", serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(item.h, size / 2, size / 2 + size * 0.03);
      ctx.restore();
      if (step >= total) {
        clearInterval(demoTimer);
        setTimeout(grid, 700);
      }
    }, 45);
  }

  let drawing = false;
  const pos = e => {
    const r = canvas.getBoundingClientRect();
    let clientX, clientY;
    if (e.touches && e.touches.length) {
      clientX = e.touches[0].clientX; clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length && !e.clientX) {
      clientX = e.changedTouches[0].clientX; clientY = e.changedTouches[0].clientY;
    } else {
      clientX = e.clientX; clientY = e.clientY;
    }
    return [(clientX - r.left) * (size / r.width), (clientY - r.top) * (size / r.height)];
  };
  const start = e => { if (!ctx) return; clearInterval(demoTimer); e.preventDefault(); drawing = true; const [x, y] = pos(e); ctx.strokeStyle = '#1c1c1c'; ctx.lineWidth = 9; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y + 0.1); ctx.stroke(); };
  const move = e => { if (!drawing || !ctx) return; e.preventDefault(); const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); };
  const end = () => { drawing = false; };

  /* Pointer-события покрывают мышь, палец и стилус одним путём.
     mousedown/touchstart оставлены как запасной вариант для старых браузеров. */
  if (window.PointerEvent) {
    canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); start(e); });
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  } else {
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
  }

  /* Доступность: поле письма было недостижимо с клавиатуры и не описано
     для скринридера. Клавиатурный пользователь может пропустить знак. */
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label',
    `Пропись иероглифа ${item.h}. Нарисуйте знак мышью, пальцем или стилусом.`);
  canvas.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const idx = (writeState.idx + 1) % HANDWRITING.length;
      writeState.idx = idx;
      renderWriteCard(host);
    }
  });

  box.appendChild(canvas);
  p.appendChild(box);

  const ctr = el('div', 'write-ctr');
  const prev = el('button', 'btn btn-ghost', '←');
  prev.onclick = () => { clearInterval(demoTimer); writeState.idx = (writeState.idx - 1 + HANDWRITING.length) % HANDWRITING.length; renderWriteCard(host); };
  const next = el('button', 'btn btn-primary', 'Следующий →');
  next.onclick = () => { clearInterval(demoTimer); writeState.idx = (writeState.idx + 1) % HANDWRITING.length; renderWriteCard(host); };
  const demo = el('button', 'btn btn-ghost', '▶ Образец');
  demo.onclick = () => playDemo();
  const clr = el('button', 'btn btn-ghost', '🧽 Очистить');
  clr.onclick = () => { clearInterval(demoTimer); grid(); };
  const spk = el('button', 'btn btn-ghost', '🔊');
  spk.setAttribute('aria-label', 'Прослушать текст');
  spk.onclick = () => speak(item.h);
  ctr.appendChild(prev); ctr.appendChild(demo); ctr.appendChild(clr); ctr.appendChild(spk); ctr.appendChild(next);
  p.appendChild(ctr);
  host.appendChild(p);

  const idx = el('div', 'write-strip');
  HANDWRITING.forEach((h, i) => {
    const b = el('button', 'ws-item' + (i === writeState.idx ? ' active' : ''), esc(h.h));
    b.onclick = () => { writeState.idx = i; renderWriteCard(host); };
    idx.appendChild(b);
  });
  host.appendChild(idx);
}

/* ============================================================
   ЧТЕНИЕ
   ============================================================ */
let readState = { idx: 0, showPinyin: true, showRu: true };
function renderRead(root) {
  const wrap = el('div');
  wrap.appendChild(el('h1', 'page-title', 'Чтение с пиньинь'));
  wrap.appendChild(el('p', 'page-sub', 'Наведите курсор на иероглиф — увидите пиньинь и перевод. Нажмите на строку — услышите её.'));
  const tabs = el('div', 'tabs');
  TEXTS.forEach((t, i) => {
    const b = el('button', 'tab' + (readState.idx === i ? ' active' : ''), `${i + 1}. ${esc(t.title)}`);
    b.onclick = () => { readState.idx = i; renderRead(root); };
    tabs.appendChild(b);
  });
  wrap.appendChild(tabs);
  const host = el('div', 'read-host');
  wrap.appendChild(host);
  root.appendChild(wrap);
  renderText(host);
}
function renderText(host) {
  host.innerHTML = '';
  const t = TEXTS[readState.idx];
  const p = el('div', 'panel');
  p.appendChild(el('div', 'panel-head', `
    <div><h3>${esc(t.title)}</h3><span class="level-chip">${esc(t.level)}</span></div>
    <div class="btn-row">
      <button class="btn btn-sm" id="togglePy">${readState.showPinyin ? 'Скрыть пиньинь' : 'Показать пиньинь'}</button>
      <button class="btn btn-sm" id="toggleRu">${readState.showRu ? 'Скрыть перевод' : 'Показать перевод'}</button>
      <button class="btn btn-sm" id="readAloud">🔊 Всё вслух</button>
    </div>`));
  p.appendChild(el('div', 'note', 'О чём текст: ' + esc(t.ru)));

  const body = el('div', 'text-body');
  t.lines.forEach(ln => {
    const line = el('div', 'text-line');
    const row = el('div', 'tl-hanzi');
    buildLine(ln.h, ln.p).forEach(part => {
      if (part.punct) { row.appendChild(el('span', 'punct', esc(part.ch))); return; }
      row.appendChild(el('span', 'w', `<span class="w-h">${esc(part.ch)}</span><span class="w-p">${esc(part.py)}</span>`));
    });
    line.appendChild(row);
    // Перевод строки — виден сразу: без него непонятно, о чём речь.
    if (ln.ru) line.appendChild(el('div', 'tl-ru', esc(ln.ru)));
    line.onclick = () => speak(ln.h);
    line.title = 'Нажмите, чтобы услышать';
    body.appendChild(line);
  });
  p.appendChild(body);
  body.classList.toggle('hide-pinyin', !readState.showPinyin);
  body.classList.toggle('hide-ru', !readState.showRu);

  const hint = el('div', 'read-hint',
    '💡 Нажмите на любую строку — услышите её. Наведите на иероглиф, чтобы увидеть пиньинь и перевод.');
  p.appendChild(hint);
  const gl = el('div', 'gloss');
  t.glossary.forEach(g => gl.appendChild(el('div', 'gl-row', `<b>${ruby(g.h)}</b><span class="gl-p">${esc(g.p)}</span><span>${esc(g.r)}</span>`)));
  p.appendChild(el('h3', '', 'Словарь к тексту'));
  p.appendChild(gl);
  host.appendChild(p);

  $('#togglePy').onclick = () => { readState.showPinyin = !readState.showPinyin; renderText(host); };
  $('#toggleRu').onclick = () => { readState.showRu = !readState.showRu; renderText(host); };
  $('#readAloud').onclick = () => speak(t.lines.map(l => l.h).join(' '));
}
/* Разбор строки на символы: каждому иероглифу — свой слог пиньинь */
function buildLine(hanzi, pinyin) {
  const syls = String(pinyin).replace(/[，。？！、；：,.?!;:"'()（）]/g, ' ').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  return [...hanzi].map(ch => {
    if (/[\u4e00-\u9fa5]/.test(ch)) return { ch, py: syls[i++] || '' };
    return { ch, punct: true };
  });
}

/* ============================================================
   ФРАЗЫ
   ============================================================ */
function renderPhrases(root) {
  const wrap = el('div');
  wrap.appendChild(el('h1', 'page-title', 'Полезные фразы'));
  wrap.appendChild(el('p', 'page-sub', 'Готовые реплики для реальных ситуаций. Нажмите 🔊, чтобы услышать.'));
  PHRASES.forEach(cat => {
    const p = el('div', 'panel');
    p.appendChild(el('h3', '', esc(cat.c)));
    const list = el('div', 'ph-list');
    cat.items.forEach(it => {
      list.appendChild(el('div', 'ph-row', `
        <span class="ph-h">${ruby(it.h)}</span>
        <span class="ph-p">${esc(it.p)}</span>
        <span class="ph-r">${esc(it.r)}</span>
        ${toneBtn(it.h, 'speak sm')}`));
    });
    p.appendChild(list);
    wrap.appendChild(p);
  });
  root.appendChild(wrap);
}

/* ============================================================
   СЛОВАРЬ
   ============================================================ */
function allWords() {
  const w = [];
  Object.values(LESSONS).forEach(l => l.vocab.forEach(x => w.push({ ...x, src: 'Урок' })));
  TEXTS.forEach(t => t.glossary.forEach(x => w.push({ ...x, src: t.title })));
  PHRASES.forEach(c => c.items.forEach(x => w.push({ ...x, src: c.c })));
  return w;
}
let dictQuery = '';
function renderDict(root) {
  const wrap = el('div');
  wrap.appendChild(el('h1', 'page-title', 'Словарь'));
  const search = el('input', 'search');
  search.placeholder = 'Поиск по китайскому, пиньиню или переводу…';
  search.value = dictQuery;
  search.oninput = () => { dictQuery = search.value; paint(); };
  const res = el('div', 'dict-count');
  const list = el('div', 'dict-list');
  wrap.appendChild(search);
  wrap.appendChild(res);
  wrap.appendChild(list);
  root.appendChild(wrap);

  function paint() {
    const q = dictQuery.trim().toLowerCase();
    const all = allWords();
    const found = q ? all.filter(w => (w.h + ' ' + w.p + ' ' + w.r).toLowerCase().includes(q)) : all;
    res.textContent = `Найдено: ${found.length} из ${all.length}`;
    list.innerHTML = '';
    found.slice(0, 300).forEach(w => {
      list.appendChild(el('div', 'dict-row', `
        <span class="d-h">${ruby(w.h)}</span>
        <span class="d-p">${esc(w.p)}</span>
        <span class="d-r">${esc(w.r)}</span>
        <span class="d-src">${esc(w.src || '')}</span>
        ${toneBtn(w.h, 'speak sm')}`));
    });
  }
  paint();
}

/* ============================================================
   СТАТИСТИКА
   ============================================================ */
function renderStats(root) {
  const wrap = el('div');
  wrap.appendChild(el('h1', 'page-title', 'Статистика'));
  const done = doneCount(), total = allLessonIds().length;
  const grades = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10);
    return { d, on: state.days.includes(d) };
  });
  const panel = el('div', 'panel');
  panel.appendChild(el('div', 'stat-grid', `
    <div><b>${done}/${total}</b><span>уроков пройдено</span></div>
    <div><b>${accuracy()}%</b><span>верных ответов</span></div>
    <div><b>${state.totalRight + state.totalWrong}</b><span>всего ответов</span></div>
    <div><b>${state.streak}</b><span>дней подряд</span></div>
    <div><b>${Object.keys(state.cards).length}</b><span>карточек</span></div>
    <div><b>${dueCards().length}</b><span>к повторению</span></div>`));
  /* Новичок видит шесть нулей и не понимает, что делать. Даём понятный
     следующий шаг вместо пустого отчёта. */
  if (!done && !state.totalRight && !state.totalWrong && !state.days.length) {
    const start = el('div', 'panel');
    start.innerHTML = '<h3>Пока пусто — и это нормально 🙂</h3>' +
      '<p class="page-sub">Статистика появится после первого урока. Начать проще всего так:</p>' +
      '<div class="btn-row start-row">' +
      '<span class="start-hint">' + scrawl('arrow', { label: 'начните отсюда', style: 'width:64px;height:48px' }) +
      '<i>отсюда</i></span>' +
      '<a class="btn btn-primary" href="#/diag">🎯 Уровень за 10 минут</a>' +
      '<a class="btn btn-ghost" href="#/lesson/l1">📖 Первый урок</a></div>';
    wrap.appendChild(start);
  }
  panel.appendChild(el('h3', '', 'Последние 7 дней'));
  panel.appendChild(el('div', 'days', grades.map(g => `<div class="day ${g.on ? 'on' : ''}"><i>${g.on ? '●' : '○'}</i><span>${g.d.slice(8)}</span></div>`).join('')));
  wrap.appendChild(panel);

  if (state.quizLog.length) {
    const p = el('div', 'panel');
    p.appendChild(el('h3', '', 'Результаты тестов'));
    const list = el('div', 'mini-list');
    state.quizLog.slice().reverse().forEach(q => {
      list.appendChild(el('div', 'mini-row', `
        <span>${esc(LESSONS[q.lesson]?.title || q.lesson)}</span>
        <span class="score ${q.score >= 0.8 ? 'ok' : q.score >= 0.5 ? 'mid' : 'bad'}">${Math.round(q.score * 100)}%</span>`));
    });
    p.appendChild(list);
    wrap.appendChild(p);
  }

  const io = el('div', 'panel');
  io.appendChild(el('h3', '', 'Данные'));
  io.appendChild(el('p', 'page-sub', 'Прогресс хранится в браузере. Сохраните файл, чтобы перенести на другое устройство.'));
  const row = el('div', 'btn-row');
  const exp = el('button', 'btn btn-ghost', '⬇ Экспорт');
  exp.onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chinese-progress.json';
    a.click();
  };
  const imp = el('button', 'btn btn-ghost', '⬆ Импорт');
  imp.onclick = () => {
    const inp = el('input', 'file'); inp.type = 'file'; inp.accept = '.json';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try { state = { ...DEFAULT_STATE, ...JSON.parse(r.result) }; save(); toast('Импортировано'); route(); }
        catch (e) { toast('Неверный файл'); }
      };
      r.readAsText(f);
    };
    inp.click();
  };
  const rst = el('button', 'btn btn-danger', 'Сбросить прогресс');
  rst.onclick = () => { if (confirm('Удалить весь прогресс?')) { Store.remove(KEY); state = { ...DEFAULT_STATE }; toast('Сброшено'); route(); } };
  row.appendChild(exp); row.appendChild(imp); row.appendChild(rst);
  io.appendChild(row);
  wrap.appendChild(io);
  root.appendChild(wrap);
}

/* ============================================================
   ВИДЕО-УРОКИ (встроенный интерактивный плеер)
   ============================================================ */
let vidTimer = null;
let vidState = { lessonIdx: 0, sceneIdx: 0, playing: false, subs: true };
function videoStop() {
  clearTimeout(vidTimer);
  vidState.playing = false;
}


function renderVideos(root) {
  const wrap = el('div');
  wrap.appendChild(el('h1', 'page-title', '🎬 Видео-уроки'));
  wrap.appendChild(el('p', 'page-sub', 'Анимированные уроки со звуком, субтитрами и пиньинем: смотрите по кадрам, включайте озвучку и разбирайте реплики. Работают без интернета и VPN после первой загрузки.'));

  let lessons = (typeof VIDEO_LESSONS !== 'undefined' && VIDEO_LESSONS) || [];

  /* Сюжетный фильм «Первая поездка в Китай» — ставим первым: это не набор
     разрозненных сцен, а история с героем, которую интересно смотреть. */
  if (typeof STORY_CHAPTERS !== 'undefined' && STORY_CHAPTERS.length) {
    const story = STORY_CHAPTERS.map(c => ({ ...c, story: true }));
    lessons = story.concat(lessons);
  }
  if (lessons.length) {
    const player = el('div', 'panel vid-player');
    const stage = el('div', 'vid-stage');
    const ctr = el('div', 'vid-ctr');
    const list = el('div', 'vid-list');
    player.appendChild(stage);
    player.appendChild(ctr);
    wrap.appendChild(player);
    wrap.appendChild(el('h3', 'vid-sec-t', '🎞 Разбор по кадрам (интерактивно)'));
    wrap.appendChild(list);

    function drawToneCurve(tone) {
      if (!tone) return '';
      const paths = {
        1: 'M 10 18 L 110 18',
        2: 'M 10 46 Q 60 36 110 14',
        3: 'M 10 34 Q 55 56 110 22',
        4: 'M 10 12 Q 60 28 110 50'
      };
      const labels = { 1: '1-й тон (ровный)', 2: '2-й тон (вверх)', 3: '3-й тон (вниз-вверх)', 4: '4-й тон (резко вниз)' };
      return `<div class="vid-tone-box">
        <svg viewBox="0 0 120 60" class="vid-tone-svg">
          <line x1="8" y1="30" x2="112" y2="30" stroke="rgba(255,255,255,.12)" stroke-dasharray="3 3"/>
          <path d="${paths[tone] || ''}" fill="none" stroke="var(--gold)" stroke-width="4" stroke-linecap="round"/>
        </svg>
        <span>${labels[tone] || ''}</span>
      </div>`;
    }

    function paintPlayer() {
      const L = lessons[vidState.lessonIdx] || lessons[0];
      const sc = L.scenes[vidState.sceneIdx] || L.scenes[0];
      const pct = Math.round(((vidState.sceneIdx + 1) / L.scenes.length) * 100);

      /* Анимированный кадр: фон локации, герои и облачко с репликой.
         Каждый новый кадр получает key, чтобы CSS проиграл вход заново. */
      const animKey = `${vidState.lessonIdx}-${vidState.sceneIdx}-${vidState.playing ? 'p' : 's'}-${vidState.subs ? 1 : 0}`;
      stage.innerHTML = `
        <div class="vid-top">
          <span class="vid-badge">${esc(L.level)}</span>
          <span class="vid-time">Сцена ${vidState.sceneIdx + 1} / ${L.scenes.length} · ${esc(L.duration)}</span>
        </div>
        ${buildSceneStage(sc, L, vidState)}
        ${sc.tone ? drawToneCurve(sc.tone) : ''}
        <div class="vid-bar"><i style="width:${pct}%"></i></div>`;
      const sceneEl = stage.querySelector('.vs-scene');
      if (sceneEl) sceneEl.dataset.key = animKey;

      ctr.innerHTML = '';
      const playB = el('button', 'btn btn-primary', vidState.playing ? '⏸ Пауза' : '▶ Смотреть урок');
      playB.onclick = () => {
        if (vidState.playing) { videoStop(); paintPlayer(); return; }
        vidState.playing = true;
        playStep();
      };
      const prevB = el('button', 'btn btn-ghost', '⏮');
      prevB.onclick = () => { videoStop(); vidState.sceneIdx = Math.max(0, vidState.sceneIdx - 1); paintPlayer(); if (sc.speak) speak(L.scenes[vidState.sceneIdx].speak); };
      const nextB = el('button', 'btn btn-ghost', '⏭');
      nextB.onclick = () => { videoStop(); vidState.sceneIdx = (vidState.sceneIdx + 1) % L.scenes.length; paintPlayer(); speak(L.scenes[vidState.sceneIdx].speak); };
      const spkB = el('button', 'btn btn-ghost', '🔊 Озвучить сцену');
      spkB.onclick = () => {
        if (sc.tone && sc.tone >= 1 && sc.tone <= 4 && sc.hanzi.length === 1) playTone(sc.tone);
        speak(sc.speak || sc.hanzi);
      };
      const subB = el('button', 'btn btn-ghost', vidState.subs ? '💬 Субтитры: вкл' : '💬 Субтитры: выкл');
      subB.onclick = () => { vidState.subs = !vidState.subs; paintPlayer(); };

      ctr.appendChild(playB); ctr.appendChild(prevB); ctr.appendChild(nextB); ctr.appendChild(spkB); ctr.appendChild(subB);

      list.innerHTML = '';
      lessons.forEach((v, i) => {
        const card = el('button', 'vid-item' + (i === vidState.lessonIdx ? ' active' : ''), `
          <div class="vi-num">${i + 1}</div>
          <div class="vi-txt">
            <b>${v.story ? '🎬 ' : ''}${esc(v.title)}</b>
            <span>${esc(v.level)} · ${esc(v.duration)} — ${esc(v.desc)}</span>
          </div>`);
        card.onclick = () => {
          videoStop();
          vidState.lessonIdx = i;
          vidState.sceneIdx = 0;
          vidState.playing = true;
          playStep();
        };
        list.appendChild(card);
      });
    }

    function playStep() {
      clearTimeout(vidTimer);
      if (!vidState.playing) return;
      const L = lessons[vidState.lessonIdx] || lessons[0];
      const sc = L.scenes[vidState.sceneIdx];
      paintPlayer();
      if (sc) {
        if (sc.tone && sc.tone >= 1 && sc.tone <= 4 && sc.hanzi.length === 1) playTone(sc.tone);
        speak(sc.speak || sc.hanzi);
        vidTimer = setTimeout(() => {
          if (!vidState.playing) return;
          if (vidState.sceneIdx + 1 < L.scenes.length) {
            vidState.sceneIdx++;
            playStep();
          } else {
            vidState.playing = false;
            playSfx('win');
            paintPlayer();
            toast('Видео-урок завершён!');
          }
        }, (sc.dur || 4500) * (PREFS.slow ? 1.25 : 1));
      }
    }

    paintPlayer();
  }

  root.appendChild(wrap);
}


/* ============================================================
   ПИНЬИНЬ ПОД КАЖДЫМ СЛОВОМ
   Ученики читают с пиньинем, поэтому иероглифы всегда идут с
   подсказкой сверху: в словаре, в заданиях, в текстах и в чате ИИ.
   ============================================================ */
const PY_LESSON = (() => {
  const map = {};
  const put = (h, p) => {
    if (!h || !p) return;
    if (!(h in map)) map[h] = p;
  };
  try {
    Object.values(LESSONS).forEach(l => l.vocab.forEach(w => put(w.h, w.p)));
    if (typeof PHRASES !== 'undefined') PHRASES.forEach(c => c.items.forEach(w => put(w.h, w.p)));
    if (typeof TEXTS !== 'undefined') TEXTS.forEach(t => t.glossary.forEach(w => put(w.h, w.p)));
    if (typeof HANDWRITING !== 'undefined') HANDWRITING.forEach(w => put(w.h, w.p));
  } catch (e) { }
  return map;
})();

/* Пиньинь слова: сначала ищем готовое чтение в курсе,
   иначе собираем по слогам из таблицы иероглифов. */
function pinyinOf(word) {
  const w = String(word || '').trim();
  if (!w) return '';
  if (PY_LESSON[w]) return PY_LESSON[w];
  if (typeof PY_CHAR === 'undefined') return '';
  const out = [];
  for (const ch of w) {
    if (/[\u3400-\u9fff]/.test(ch)) out.push(PY_CHAR[ch] || '');
    else out.push(ch);
  }
  return out.join(' ').replace(/\s+([，。？！、；：,.?!;:])/g, '$1').trim();
}

/* ---------- Каракули ----------
   Живые пометки «от руки»: звёздочка восторга, стрелка, птичка, волна.
   Они проходят через SVG-фильтр с шумом (см. #rough-ink в шаблоне),
   поэтому линии не бывают ровными — как в тетради на полях.
   Вид: spark | arrow | check | bang | wave | curl | cn (иероглиф).
   Подпись идёт в aria-label: для скринридера это картинка с текстом,
   а не бессмысленный мусор в разметке. */
const SCRAWL_PATHS = {
  spark: `<g filter="url(#rough-ink)"><path d="M8,18 C11,11 13,8 18,6" stroke-width="2"/>`
    + `<g transform="translate(36,30) scale(1.5)"><path d="M0,-11 C1.5,-4 4,-1.5 11,0 C4,1.5 1.5,4 0,11 C-1.5,4 -4,1.5 -11,0 C-4,-1.5 -1.5,-4 0,-11 Z" fill="currentColor" stroke="none"/></g>`
    + `<g transform="translate(14,38) scale(.8)"><path d="M0,-11 C1.5,-4 4,-1.5 11,0 C4,1.5 1.5,4 0,11 C-1.5,4 -4,1.5 -11,0 C-4,-1.5 -1.5,-4 0,-11 Z" fill="currentColor" stroke="none"/></g>`
    + `<path d="M24,12 l4,-5" stroke-width="1.6"/></g>`,
  arrow: `<g filter="url(#rough-ink)" fill="none" stroke-linecap="round">`
    + `<path d="M6,44 C18,40 30,28 44,16 C50,11 54,9 60,7" stroke-width="2.2"/>`
    + `<path d="M48,6 C53,6.5 58,6.5 61,7 C60,11 58.5,15 56,19" stroke-width="2"/></g>`,
  check: `<g filter="url(#rough-ink)" fill="none" stroke-linecap="round">`
    + `<path d="M10,32 C15,38 20,46 24,50 C30,36 40,18 54,8" stroke-width="3.4"/>`
    + `<path d="M44,10 C50,7 54,6 58,5" stroke-width="2"/></g>`,
  bang: `<g filter="url(#rough-ink)" fill="none" stroke-linecap="round">`
    + `<path d="M28,8 C30,18 31,28 30,36" stroke-width="4"/>`
    + `<circle cx="29" cy="45" r="2.6" fill="currentColor" stroke="none"/></g>`,
  wave: `<g filter="url(#rough-ink)" fill="none" stroke-linecap="round">`
    + `<path d="M4,32 C14,20 22,44 34,30 C44,19 52,38 62,26" stroke-width="2.6"/></g>`,
  curl: `<g filter="url(#rough-ink)" fill="none" stroke-linecap="round">`
    + `<path d="M48,8 C34,10 20,18 14,30 C9,41 14,49 22,44 C28,40 26,30 20,31" stroke-width="2.2"/></g>`,
};

/* Китайские надписи «кистью»: иероглиф + карандашная черта под ним. */
const SCRAWL_CN = {
  '学': (size) => `${cnText('学', size)}<path d="M14,84 C30,80 52,82 74,78" stroke-width="2.6"/>`,
  '好': (size) => cnText('好', size),
  '加油': (size) => cnText('加油', size - 16),
  '很棒': (size) => cnText('很棒', size - 16),
  '字': (size) => `${cnText('字', size)}<circle cx="50" cy="50" r="34" stroke-width="1.8" stroke-dasharray="6 7"/>`,
};
function cnText(ch, size) {
  return `<text x="50" y="50" font-size="${size}" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="'Noto Serif SC','Songti SC','STSong',serif">${ch}</text>`;
}

let scrawlSeq = 0;
function scrawl(kind, opts) {
  const o = opts || {};
  const cn = kind === 'cn' ? (o.text || '学') : null;
  const draw = cn ? (SCRAWL_CN[cn] || SCRAWL_CN['学'])(74) : SCRAWL_PATHS[kind];
  if (!draw) return '';
  const label = o.label || (cn ? `надпись ${cn}` : 'пометка от руки');
  /* seed у фильтра свой для каждой пометки: иначе все звёздочки
     дрожат одинаково и сразу выдают, что это одна и та же картинка. */
  scrawlSeq += 1;
  const rot = o.tilt === undefined ? (scrawlSeq % 2 ? -4 : 3.5) : o.tilt;
  return `<span class="scrawl ${cn ? 'cn' : kind || 'spark'}${o.accent ? ' accent' : ''}" role="img" aria-label="${esc(label)}"` +
    ` style="transform:rotate(${rot}deg)${o.style ? ';' + o.style : ''}">` +
    `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">${draw}</svg></span>`;
}

/* Иероглифы + пиньинь сверху. addClass — дополнительный класс обёртки. */
function ruby(hanzi, cls = '') {
  const text = String(hanzi == null ? '' : hanzi);
  let html = '', i = 0;
  const re = /[\u3400-\u9fff]+/g;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > i) html += esc(text.slice(i, m.index));
    const chunk = m[0];
    /* подбираем самое длинное известное слово в курсе — так пиньинь точнее */
    let j = 0;
    while (j < chunk.length) {
      let hit = '';
      for (let len = Math.min(6, chunk.length - j); len >= 1; len--) {
        const sub = chunk.substr(j, len);
        if (PY_LESSON[sub]) { hit = sub; break; }
      }
      if (hit) {
        html += `<span class="rw${cls ? ' ' + cls : ''}"><span class="rw-p">${esc(PY_LESSON[hit])}</span><span class="rw-h">${esc(hit)}</span></span>`;
        j += hit.length;
      } else {
        const ch = chunk[j];
        const py = (typeof PY_CHAR !== 'undefined' && PY_CHAR[ch]) || '';
        html += `<span class="rw${cls ? ' ' + cls : ''}"><span class="rw-p">${esc(py)}</span><span class="rw-h">${esc(ch)}</span></span>`;
        j++;
      }
    }
    i = m.index + chunk.length;
  }
  if (i < text.length) html += esc(text.slice(i));
  return html;
}

/* ============================================================
   ВНУТРЕННИЙ ИИ-АГЕНТ (Сяо Мин · 小明)
   ============================================================ */
let tutorHistory = [];
let tutorHistoryRestored = (() => {
  try {
    const raw = localStorage.getItem('tutorChat');
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(m => m && m.role) : [];
  } catch (e) { return []; }
})();
let tutorContext = { mode: 'chat', step: 0, quiz: null };

function tutorAllVocab() {
  const list = [];
  const seen = new Set();
  const push = (w, src) => {
    if (!w || !w.h || seen.has(w.h + '|' + w.r)) return;
    seen.add(w.h + '|' + w.r);
    list.push({ h: w.h, p: w.p || '', r: w.r || '', lesson: src || '' });
  };
  Object.entries(LESSONS).forEach(([lid, l]) => l.vocab.forEach(w => push(w, l.title)));
  if (typeof PHRASES !== 'undefined') PHRASES.forEach(cat => (cat.items || []).forEach(w => push(w, cat.title)));
  if (typeof TEXTS !== 'undefined') TEXTS.forEach(t => (t.gloss || []).forEach(w => push(w, t.title)));
  if (typeof HANDWRITING !== 'undefined') HANDWRITING.forEach(w => push(w, 'Пропись'));
  [
    { h: '茶', p: 'chá', r: 'чай' },
    { h: '绿茶', p: 'lǜchá', r: 'зелёный чай' },
    { h: '爱', p: 'ài', r: 'любить' },
    { h: '中文', p: 'Zhōngwén', r: 'китайский язык' },
    { h: '汉语', p: 'Hànyǔ', r: 'китайский язык (путунхуа)' },
    { h: '加油', p: 'jiāyóu', r: 'не сдавайся! вперёд!' },
    { h: '老师', p: 'lǎoshī', r: 'учитель' },
    { h: '同学', p: 'tóngxué', r: 'одноклассник; ученик' }
  ].forEach(w => push(w, 'Базовый словарь'));

  /* Карманный словарь HSK: 4000+ слов, которых нет в 15 уроках.
     Раньше на «а как будет «билет»?» помощник честно отвечал «нет в курсе»
     — теперь он знает слово и подсказывает уровень HSK.
     Словарь грузится отдельным файлом уже после первого экрана: 30 КБ
     в сжатом виде, которые нужны только помощнику и поиску по словарю.
     Пока он едет, приложение работает на словаре курса. */
  (typeof LEXICON_ROWS !== 'undefined' ? LEXICON_ROWS : []).forEach(row => {
    const [h, pnum, py, ru, level] = row;
    /* Берём только переводы на русском или из курса: английский перевод
       ученику не помогает и путает («apartment» вместо «квартира»). */
    if (!h || !ru || !/[а-яА-ЯёЁ]/.test(ru)) return;
    if (list.some(x => x.h === h)) return;         // курс точнее — он важнее
    seen.add(h + '|' + ru);
    list.push({ h, p: py || pnum || '', r: ru, lesson: level ? `HSK ${level}` : 'Словарь HSK', hsk: level, num: pnum });
  });
  return list;
}

/* ---------- Ленивая загрузка словаря ----------
   Первый экран не должен ждать 30 КБ, которые нужны только помощнику.
   Поэтому словарь подключается отдельным скриптом: сразу после отрисовки
   (чтобы не мешать) и повторно — при входе в раздел помощника, если сеть
   была недоступна. Офлайн словарь уже лежит в кэше service worker. */
let lexLoading = null;
function loadLexicon() {
  if (typeof LEXICON_ROWS !== 'undefined') return Promise.resolve(true);
  if (lexLoading) return lexLoading;
  lexLoading = new Promise(resolve => {
    const done = ok => { lexLoading = null; resolve(ok); };
    if (typeof document === 'undefined') return done(false);
    const s = document.createElement('script');
    s.src = 'lexicon.js';
    s.async = true;
    s.onload = () => done(typeof LEXICON_ROWS !== 'undefined');
    s.onerror = () => done(false);
    document.head.appendChild(s);
    // Сеть бывает медленной: ждём не дольше 8 секунд, чтобы поиск
    // не «висел» вечно — он просто ответит по словарю курса.
    setTimeout(() => done(typeof LEXICON_ROWS !== 'undefined'), 8000);
  });
  return lexLoading;
}

/* Сколько слов знает помощник и откуда они: видно в интерфейсе */
function tutorVocabStats() {
  const rows = typeof LEXICON_ROWS !== 'undefined' ? LEXICON_ROWS : [];
  const course = Object.values(LESSONS).reduce((n, l) => n + l.vocab.length, 0);
  return { total: tutorAllVocab().length, course, hsk: rows.length };
}

/* ---------- Русские названия грамматических явлений ----------
   Ученикам проще, когда вместо «частица 了» написано ещё и по-русски,
   что она делает. */
const GRAMMAR_TIPS = {
  '吗': 'частица вопроса «да/нет», ставится в самом конце',
  '呢': 'частица «а ты?» — заменяет повтор вопроса',
  '吧': 'частица предположения: «наверное, да?»',
  '了': 'действие завершено (после глагола) ИЛИ ситуация изменилась (в конце)',
  '的': 'притяжательная частица: «чей, какой» — перед существительным',
  '得': 'стоит после глагола: «как именно сделано» — 跑得快',
  '把': 'выносит объект перед глаголом, когда у действия есть результат',
  '在': 'находиться в (месте); также «сейчас в процессе» перед глаголом',
  '不': 'отрицание в настоящем и будущем; перед 4-м тоном читается bú',
  '没': 'отрицание в прошлом; с 有 — «не иметь»',
  '要': 'хочу (сильное намерение); нужно',
  '想': 'хочу (мягче); думаю; скучаю',
  '会': 'умею (навык); также «будет» о будущем',
  '能': 'могу (есть возможность прямо сейчас)',
  '可以': 'можно, разрешено',
  '应该': 'следует, стоило бы',
  '个': 'самое частое счётное слово: 一个人, 一个朋友',
  '都': 'все, всё — всегда перед глаголом',
  '也': 'тоже — всегда перед глаголом',
  '很': 'очень; в утверждении делает фразу законченной',
  '是': 'быть, являться — связка между «кто» и «кто он»',
  '有': 'у меня есть; иметь. Отрицание — 没有',
  '和': 'и (между существительными)',
  '还是': 'или — в вопросе с выбором',
  '或者': 'или — в утверждении',
  '因为': 'потому что',
  '所以': 'поэтому',
  '但是': 'но',
  '如果': 'если',
  '太': 'слишком — с ним в конце обычно 了',
  '比': 'сравнение: A 比 B 冷 — A холоднее B',
  '最': 'самый',
  '更': 'ещё более',
  '给': 'давать; для (кого-то)',
  '跟': 'с (кем-то)',
  '从': 'от, из (откуда)',
  '到': 'до, прибывать',
  '再': 'ещё раз',
  '还': 'ещё, всё ещё',
  '才': 'только тогда, лишь',
  '就': 'уже, сразу',
  '别': 'не надо (делать)',
  '请': 'пожалуйста (просьба)',
  '吧': 'давай; наверное',
  '个': 'счётное слово'
};

/* Короткие переводы частых слов: нужны, чтобы собранная из словаря фраза
   не выглядела набором иероглифов. */
const RU_HINT = (() => {
  const m = {};
  const nums = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять'];
  const numHan = '零一二三四五六七八九十';
  [...numHan].forEach((ch, i) => { m[ch] = nums[i]; });
  Object.assign(m, {
    '我': 'я', '你': 'ты', '您': 'вы (вежливо)', '他': 'он', '她': 'она', '我们': 'мы', '他们': 'они',
    '是': 'быть', '不': 'не', '没': 'не (прошлое)', '有': 'есть, иметь', '没有': 'нет, не иметь',
    '要': 'хочу', '想': 'хочу', '会': 'умею', '能': 'могу', '可以': 'можно', '应该': 'следует',
    '喝': 'пить', '吃': 'есть, кушать', '喝茶': 'пить чай', '茶': 'чай', '水': 'вода', '咖啡': 'кофе',
    '饭': 'еда, рис', '面': 'лапша', '菜': 'блюдо', '肉': 'мясо', '牛肉': 'говядина', '鸡': 'курица',
    '去': 'идти, ехать', '来': 'приходить', '回': 'возвращаться', '走': 'идти', '坐': 'сидеть, ехать',
    '看': 'смотреть', '听': 'слушать', '说': 'говорить', '学': 'учить', '学习': 'учиться',
    '买': 'покупать', '卖': 'продавать', '做': 'делать', '工作': 'работа', '写': 'писать', '读': 'читать',
    '喜欢': 'нравиться', '爱': 'любить', '知道': 'знать (факт)', '认识': 'знать (человека)',
    '好': 'хорошо', '很好': 'очень хорошо', '不好': 'плохо', '大': 'большой', '小': 'маленький',
    '多': 'много', '少': 'мало', '贵': 'дорого', '便宜': 'дёшево', '新': 'новый', '旧': 'старый',
    '今天': 'сегодня', '明天': 'завтра', '昨天': 'вчера', '现在': 'сейчас', '以后': 'потом', '以前': 'раньше',
    '家': 'дом, семья', '公司': 'компания', '学校': 'школа', '老师': 'учитель', '学生': 'студент',
    '朋友': 'друг', '人': 'человек', '名字': 'имя', '中国': 'Китай', '中文': 'китайский язык',
    '汉语': 'китайский язык', '钱': 'деньги', '块': 'юань', '多少钱': 'сколько стоит',
    '谢谢': 'спасибо', '你好': 'здравствуйте', '再见': 'до свидания', '对不起': 'извините',
    '没关系': 'ничего страшного', '不客气': 'не за что', '请问': 'извините, скажите пожалуйста',
    '什么': 'что', '谁': 'кто', '哪里': 'где', '哪儿': 'где', '为什么': 'почему', '怎么': 'как',
    '怎么样': 'как (дела)', '什么时候': 'когда', '几点': 'который час', '多少': 'сколько',
    '个': '(счётное слово)', '本': '(счётное слово для книг)', '杯': 'чашка', '份': 'порция', '碗': 'пиала',
    '很': 'очень', '也': 'тоже', '都': 'все', '和': 'и', '在': 'в, находиться', '和': 'и',
    '也': 'тоже', '一下': 'немного, разок', '一点': 'немного'
  });
  return m;
})();

/* Собрать из словаря курса всё, что знаем о слове */
function tutorLookup(word) {
  const w = String(word || '').trim();
  if (!w) return null;
  const vocab = tutorAllVocab();
  return vocab.find(x => x.h === w) ||
    vocab.find(x => x.r.toLowerCase() === w.toLowerCase()) ||
    vocab.find(x => x.p && x.p.toLowerCase().replace(/\s+/g, '') === w.toLowerCase().replace(/\s+/g, '')) ||
    null;
}

/* Разбор фразы по словам: самое длинное совпадение, остальное — по символам */
function tutorSegment(text) {
  const vocab = tutorAllVocab();
  const chars = [...String(text)].filter(c => /[\u3400-\u9fff]/.test(c));
  const parts = [];
  let i = 0;
  while (i < chars.length) {
    let found = null;
    for (let len = Math.min(6, chars.length - i); len >= 1; len--) {
      const sub = chars.slice(i, i + len).join('');
      const hit = vocab.find(x => x.h === sub);
      if (hit) { found = hit; break; }
    }
    if (found) { parts.push(found); i += found.h.length; }
    else {
      const ch = chars[i];
      parts.push({ h: ch, p: (typeof PY_CHAR !== 'undefined' && PY_CHAR[ch]) || '', r: RU_HINT[ch] || '' });
      i++;
    }
  }
  return parts;
}

function tutorWordHtml(w) {
  const ru = w.r || RU_HINT[w.h] || '';
  return `<span class="tw-row"><span class="tw-h">${ruby(w.h)}</span>` +
    (ru ? `<span class="tw-r">${esc(ru)}</span>` : '') + '</span>';
}

/* ============================================================
   ИИ-ПОМОЩНИК СЯО МИН — ЛОКАЛЬНЫЙ ДВИЖОК РАССУЖДЕНИЯ
   ============================================================
   Раньше на каждый вопрос вешалась одна длинная цепочка из десяти
   регулярных выражений: любая фраза, не совпавшая с шаблоном дословно,
   падала в «я не понял». Здесь запрос сначала разбирается на признаки
   (о ком, о чём, какое действие), затем опечатки и падежи приводятся
   к словарной форме, и только потом собирается ответ — с учётом
   прогресса ученика и уже сказанного в диалоге.
   ============================================================ */

/* Приведение русского слова к грубой основе: убираем окончания,
   чтобы «спасибо», «спасиба» и «спасибу» находили одно и то же. */
function ruStem(word) {
  let w = String(word || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9-]/g, '');
  if (w.length <= 3) return w;
  const endings = ['ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ется', 'ится',
    'ать', 'ять', 'ить', 'еть', 'уть', 'ыть', 'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее',
    'ые', 'ие', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'ов', 'ев', 'ию', 'ия', 'ии', 'ью',
    'ть', 'ет', 'ют', 'ут', 'ат', 'ят', 'ит', 'ла', 'ло', 'ли', 'ыл', 'ил',
    'а', 'я', 'ы', 'и', 'у', 'ю', 'о', 'е', 'ь', 'й'];
  for (const end of endings) {
    if (w.length - end.length >= 3 && w.endsWith(end)) { w = w.slice(0, -end.length); break; }
  }
  return w;
}

/* Грубый корень: снимаем приставку и окончание. Нужен, чтобы «болезнь»
   и «заболеть» считались одним понятием, а «боль» и «больница» — нет
   (у последней корень короче порога). */
const RU_PREFIXES = ['пере', 'недо', 'при', 'про', 'пред', 'за', 'на', 'по',
  'вы', 'от', 'под', 'над', 'раз', 'рас', 'у', 'с', 'о', 'об'];

function ruRoot(word) {
  let w = ruStem(word);
  for (const pre of RU_PREFIXES) {
    if (w.length - pre.length >= 4 && w.startsWith(pre)) { w = w.slice(pre.length); break; }
  }
  return w;
}

/* Общий корень: начало в 4 буквы совпадает и слова не разъехались по длине.
   Это ловит разные части речи, но не склеивает «чай» и «часть». */
function shareRoot(a, b) {
  if (!a || !b || a.length < 4 || b.length < 4) return false;
  if (Math.abs(a.length - b.length) > 5) return false;
  return a.slice(0, 4) === b.slice(0, 4);
}

/* Расстояние Левенштейна: нужно, чтобы «спосибо» и «спасибо» считались
   одним словом, а не разными. Порог зависит от длины слова. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function fuzzyHit(query, candidates) {
  const q = ruStem(query);
  if (q.length < 4) return null;
  let best = null, bestD = 99;
  candidates.forEach(c => {
    const d = editDistance(q, ruStem(c));
    const limit = q.length >= 7 ? 2 : 1;
    if (d <= limit && d < bestD) { bestD = d; best = c; }
  });
  return best;
}

/* ---------- Быстрые доступы к данным курса ---------- */
function tutorLessonIds() {
  const ids = Object.keys(LESSONS);
  if (typeof MODULES !== 'undefined' && Array.isArray(MODULES)) {
    const ordered = [];
    MODULES.forEach(m => (m.lessons || []).forEach(id => ids.includes(id) && ordered.push(id)));
    ids.forEach(id => { if (!ordered.includes(id)) ordered.push(id); });
    return ordered;
  }
  return ids.sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
}

function tutorLexicon() {
  const seen = new Map();
  tutorAllVocab().forEach(w => {
    const key = w.h;
    if (!seen.has(key)) seen.set(key, []);
    const rec = seen.get(key);
    const val = { ru: (w.r || '').toLowerCase(), p: (w.p || '').toLowerCase(), lesson: w.lesson || '', word: w };
    if (!rec.some(x => x.ru === val.ru && x.p === val.p)) rec.push(val);
  });
  const entries = [];
  seen.forEach((list, h) => list.forEach(v => entries.push({ h, p: v.p, r: v.ru, lesson: v.lesson, word: v.word })));
  return entries;
}

const TUTOR_LEX = (() => {
  const cache = { dir: null, sum: '' };
  return {
    all() {
      const list = tutorAllVocab();
      const sum = list.length + '|' + doneCount() + '|' + Object.keys(state.lessons || {}).length;
      if (cache.sum !== sum || !cache.dir) { cache.dir = tutorLexicon(); cache.sum = sum; }
      return cache.dir;
    },
    reload() { cache.sum = ''; }
  };
})();

/* Проверки «правил» — общий набор для вопросов и для подсказок по ошибкам */
const TUTOR_RULES = [
  {
    id: 'ma', keys: ['吗', 'ma', 'общий вопрос', 'да нет', 'вопросительн'],
    title: '吗 — вопрос «да или нет»',
    body: 'Ставится в <b>самый конец</b> утверждения, порядок слов не меняется.<br>' +
      '<b>你喝茶。</b> — Ты пьёшь чай. → <b>你喝茶吗？</b> — Ты пьёшь чай?<br>' +
      'Ответ короткий: <b>喝。</b> — пью, <b>不喝。</b> — не пью.',
    ex: { h: '你喝茶吗？', p: 'nǐ hē chá ma?', r: 'Ты пьёшь чай?' },
    simple: 'Ставишь <b>吗</b> в конец фразы — и получается вопрос. Больше ничего менять не надо.',
    why: 'В китайском нет инверсии, как в русском: порядок слов не меняется, поэтому вопрос помечают частицей в конце.',
    more: '吗 — самая частая вопросительная частица. Сравните с <b>呢</b>: 呢 не задаёт вопрос, а возвращает его — «а ты?» (我很好，你呢？). Если в вопросе есть вопросительное слово (谁, 什么, 哪里), 吗 не нужна.',
  },
  {
    id: 'le', keys: ['了', 'le', 'прошлое', 'завершено', 'уже'],
    title: '了 — «уже сделано» или «ситуация изменилась»',
    body: 'Два места — два смысла.<br>• После глагола — действие завершено: <b>我吃了早饭。</b><br>' +
      '• В конце фразы — новое состояние: <b>我饿了。</b> — Я проголодался.<br>' +
      'Отрицание — через <b>没</b>: <b>我没吃早饭。</b>',
    ex: { h: '我吃了早饭', p: 'wǒ chī le zǎo fàn', r: 'Я позавтракал' },
    simple: '<b>了</b> = «уже». Поставили после глагола — действие закончилось: 我吃了 — «я уже поел».',
    why: '了 не время, а вид: она показывает, что действие дошло до результата или что состояние изменилось.',
    more: 'С глаголами чувств и состояний 了 стоит в конце: 我饿了, 他病了. С отрицанием 了 исчезает: 我没吃 (а не 我没吃了). Ещё есть 了 в значении «ещё столько-то»: 再等五分钟就好了.',
  },
  {
    id: 'bu_mei', keys: ['不', '没', 'bu', 'mei', 'отрицание', 'не'],
    title: '不 и 没 — два разных «не»',
    body: '<b>不 (bù)</b> — настоящее, будущее и привычка: <b>我不喝咖啡</b>.<br>' +
      '<b>没 (méi)</b> — прошлое и «не иметь»: <b>我没去</b> — не ходил, <b>我没有时间</b> — нет времени.<br>' +
      'Прилагательные отрицаем только через 不: <b>不好</b>, <b>不贵</b>.',
    ex: { h: '我不喝咖啡', p: 'wǒ bù hē kā fēi', r: 'Я не пью кофе' },
    simple: '<b>不</b> — «не сейчас / не буду». <b>没</b> — «не было / нет».',
    why: '不 отрицает намерение и признак, 没 — факт в прошлом и наличие.',
    more: 'Правило-подсказка: если можете добавить «в прошлом» — берите 没, если «вообще / не хочу» — 不. С 有 всегда 没: 没有. Вопрос «ты уже…?» тоже строится с 没: 你吃了吗 / 你吃没吃?',
  },
  {
    id: 'de', keys: ['的', 'de', 'притяж', 'чей'],
    title: '的 — «чей, какой»',
    body: 'Ставится <b>перед существительным</b>: <b>我的书</b> — моя книга, <b>中国的茶</b> — китайский чай.<br>' +
      'Не путать с <b>得</b>: она идёт <b>после глагола</b> — <b>跑得快</b> — бегает быстро.',
    ex: { h: '我的书', p: 'wǒ de shū', r: 'Моя книга' },
    simple: '<b>的</b> — «чей». Ставится между хозяином и вещью: 我的书 — моя книга.',
    why: 'Притяжание оформляется частицей, а не изменением слова.',
    more: 'Если вещь и так понятна, 的 можно опустить: 我妈妈. С 得 не путать: 得 идёт после глагола и говорит «как» (跑得快).',
  },
  {
    id: 'ba', keys: ['把', 'ba', 'объект'],
    title: '把 — объект перед глаголом',
    body: 'Нужна, когда с предметом что-то сделали и есть результат.<br>' +
      'Схема: <b>кто + 把 + что + глагол + результат</b><br><b>我把书放在桌上。</b> — Я положил книгу на стол.<br>' +
      'Если результата нет, 把 не нужна: <b>我买书。</b>',
    ex: { h: '我把书放在桌上', p: 'wǒ bǎ shū fàng zài zhuō shang', r: 'Я положил книгу на стол' },
    simple: '<b>把</b> выносит предмет вперёд, когда с ним что-то сделали: 我把书放在桌上.',
    why: 'Так подчёркивают результат действия над конкретным предметом.',
    more: 'Схема жёсткая: 把 + предмет + глагол + результат/место. После 把 не бывает простого глагола без результата. Отрицание и модальные идут перед 把: 我没把书放好.',
  },
  {
    id: 'tones', keys: ['тон', 'тоны', 'сандх', 'пиньинь', 'произнош', 'ma1'],
    title: 'Тоны: как не путать',
    body: 'Один слог — четыре смысла: <b>mā</b> мама, <b>má</b> конопля, <b>mǎ</b> лошадь, <b>mà</b> ругать.<br><br>' +
      '1-й — ровно высоко. 2-й — снизу вверх, как переспрос. 3-й — вниз и чуть вверх. 4-й — резко вниз.<br>' +
      'Два 3-х тона подряд: первый читается 2-м — <b>nǐ hǎo → ní hǎo</b>.',
    ex: { h: 'nǐ hǎo', p: 'ní hǎo', r: 'привет (второй тон вместо третьего)' },
    simple: 'Тон — это высота голоса. Ровно, вверх, вниз-вверх, резко вниз — четыре разных слова.',
    why: 'Один и тот же слог с разным тоном значит совсем разное.',
    more: 'Третий тон в потоке речи часто «недоделывается»: 你好 звучит как ní hǎo. 不 перед 4-м тоном читается bú, 一 меняет тон в зависимости от следующего слога.',
  },
  {
    id: 'counters', keys: ['счетн', 'счётн', 'классификатор', '个', '本', '杯', '份', '碗'],
    title: 'Счётные слова',
    body: 'Между числом и предметом всегда стоит счётное слово:<br>' +
      '• <b>个</b> — универсальное: 一个人<br>• <b>本</b> — книги: 一本书<br>• <b>杯</b> — чашки: 一杯茶<br>' +
      '• <b>份</b> — порции: 一份牛肉面<br>• <b>碗</b> — пиалы: 一碗面',
    ex: { h: '一杯茶', p: 'yī bēi chá', r: 'чашка чая' },
    simple: 'Перед предметом нужно слово-счётчик: «один + штука + человек».',
    why: 'Китайский считает не напрямую, а через категорию предмета.',
    more: '个 — универсальное, но для книг 本, для чашек 杯, для порций 份. Если сомневаетесь — 个 поймут почти всегда.',
  },
  {
    id: 'zai', keys: ['在', 'zai', 'где', 'место'],
    title: '在 — где находится',
    body: '<b>我在学校。</b> — Я в школе.<br>Вопрос: <b>你在哪里？</b> — Где ты?<br>' +
      'Ещё 在 перед глаголом значит «сейчас делаю»: <b>我在吃饭。</b> — Я сейчас ем.',
    ex: { h: '我在学校', p: 'wǒ zài xué xiào', r: 'Я в школе' },
    simple: '<b>在</b> — «находится в». 我在学校 — я в школе.',
    why: '在 ставится перед местом и заменяет русские предлоги «в/на».',
    more: 'Перед глаголом 在 значит «сейчас делаю»: 我在吃饭. Вопрос: 你在哪儿? Для места после глагола нужен 在 как результат: 放在桌上.',
  },
  {
    id: 'haishi', keys: ['还是', '或者', 'или', 'haishi', 'huozhe'],
    title: '还是 и 或者 — «или»',
    body: 'В вопросе — <b>还是</b>: <b>你喝茶还是咖啡？</b><br>' +
      'В утверждении — <b>或者</b>: <b>我喝茶或者咖啡都行。</b>',
    ex: { h: '你喝茶还是咖啡？', p: 'nǐ hē chá hái shi kā fēi?', r: 'Ты пьёшь чай или кофе?' }
  },
  {
    id: 'modals', keys: ['要', '想', '会', '能', '可以', 'хочу', 'модальн', 'умею', 'могу'],
    title: '要, 想, 会, 能, 可以 — кто из них «хочу»',
    body: '<b>要</b> — твёрдое намерение: <b>我要学中文。</b><br><b>想</b> — мягче, «хочется»: <b>我想喝茶。</b><br>' +
      '<b>会</b> — умею (навык), <b>能</b> — могу сейчас, <b>可以</b> — разрешено.',
    ex: { h: '我想喝茶', p: 'wǒ xiǎng hē chá', r: 'Я хочу чаю' }
  },
  {
    id: 'bi', keys: ['比', 'bi', 'сравн', 'чем'],
    title: 'Сравнение с 比',
    body: 'Схема: <b>A + 比 + B + прилагательное</b>.<br><b>今天比昨天冷。</b> — Сегодня холоднее, чем вчера.<br>' +
      'После 比 нельзя ставить 很. «Намного» — <b>得多</b>.',
    ex: { h: '今天比昨天冷', p: 'jīn tiān bǐ zuó tiān lěng', r: 'Сегодня холоднее, чем вчера' }
  },
  {
    id: 'le_gno', keys: ['过', 'guo', 'опыт'],
    title: '过 — «уже бывало в жизни»',
    body: 'Ставится после глагола и говорит про опыт: <b>我去过中国。</b> — Я бывал в Китае.<br>' +
      'Сравните: <b>我去了中国</b> — съездил (результат), <b>我去过中国</b> — есть такой опыт.',
    ex: { h: '我去过中国', p: 'wǒ qù guo Zhōng guó', r: 'Я бывал в Китае' }
  },
  {
    id: 'zheng', keys: ['正在', '在', 'сейчас', 'процесс'],
    title: '在 / 正在 — «сейчас в процессе»',
    body: '<b>我在吃饭。</b> — Я сейчас ем. Можно усилить: <b>我正在吃饭。</b><br>' +
      'Разница с 了: 了 — результат, 在 — действие идёт прямо сейчас.',
    ex: { h: '我正在吃饭', p: 'wǒ zhèng zài chī fàn', r: 'Я как раз ем' }
  },
  {
    id: 'de_bu', keys: ['不+', 'потенциал', '得', 'не могу'],
    title: '得 и 不 — «могу / не могу»',
    body: 'Между глаголом и результатом:<br><b>看得懂</b> — могу понять (читая), <b>看不懂</b> — не могу понять.<br>' +
      '<b>吃得完</b> — могу доесть, <b>吃不完</b> — не осилю.',
    ex: { h: '我看不懂', p: 'wǒ kàn bu dǒng', r: 'Я не понимаю (при чтении)' }
  }
];

/* Сопоставление вопроса с правилом: ключи проверяются как подстроки
   нормализованной строки, поэтому падежи и порядок слов не важны. */
function tutorMatchRule(low) {
  const norm = low.replace(/ё/g, 'е');
  const hits = [];
  TUTOR_RULES.forEach(rule => {
    let score = 0;
    rule.keys.forEach(k => {
      const key = k.replace(/ё/g, 'е');
      if (!key) return;
      if (/[\u3400-\u9fff]/.test(key)) { if (norm.includes(key)) score += 3; return; }
      if (norm.includes(key)) score += key.length >= 4 ? 3 : 1;
    });
    if (score) hits.push({ rule, score });
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.length && hits[0].score >= 2 ? hits[0].rule : null;
}

/* ---------- Поиск слова: иероглифы, пиньинь, русский, опечатки ---------- */
function tutorFindWords(text, limit = 6) {
  const q = String(text || '').trim();
  if (!q) return [];
  const lex = TUTOR_LEX.all();
  const hanzi = q.match(/[\u3400-\u9fff]+/g) || [];
  const out = [];
  const push = w => { if (w && !out.some(x => x.h === w.h && x.r === w.r)) out.push(w); };

  // 1. Полное совпадение иероглифов
  hanzi.forEach(chunk => lex.filter(w => w.h === chunk).forEach(push));
  // 2. Вхождение иероглифов
  hanzi.forEach(chunk => lex.filter(w => w.h.includes(chunk) || chunk.includes(w.h)).forEach(push));
  // 3. Пиньинь: сравниваем и с тонами, и без них
  const bare = s => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // снимаем тоны: ǎ → a
    .replace(/ü/g, 'v').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const plain = bare(q);
  if (plain && /^[a-z ]+$/.test(plain)) {
    const squash = s => s.replace(/\s+/g, '');
    const want = squash(plain);
    if (want.length >= 2) {
      lex.filter(w => w.p && squash(bare(w.p)) === want).forEach(push);
      if (!out.length) lex.filter(w => w.p && squash(bare(w.p)).includes(want)).forEach(push);
    }
  }
  // 4. Русский: сначала целое слово из словаря, потом — по основе
  const ruWords = q.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я]+/).filter(w => w.length > 1);
  const senseParts = w => w.r.replace(/ё/g, 'е').split(/[;,/()]+/).map(s => s.trim()).filter(Boolean);

  /* 4a. Точное совпадение целого значения — самый надёжный случай.
     Сравниваем без «основы»: «счёт» и «счётное слово» — разные слова,
     и раньше грубая основа склеивала их в одно (朵 вместо «счёт»). */
  ruWords.forEach(word => {
    lex.filter(w => senseParts(w).some(p => p.toLowerCase() === word)).forEach(push);
  });

  /* 4b. Только если точного нет — ищем по основе. Порог в 5 букв:
     короткие «счёт», «дом», «чай» иначе цепляются к любому похожему. */
  if (!out.length) ruWords.forEach(word => {
    const stem = ruStem(word);
    if (stem.length < 5) return;
    let hit = false;
    lex.filter(w => senseParts(w).some(p => ruStem(p) === stem)).forEach(w => { hit = true; push(w); });
    if (hit) return;
    lex.filter(w => senseParts(w).some(p => {
      const s = ruStem(p);
      return s.startsWith(stem) && s.length - stem.length <= 3;
    })).forEach(push);
  });
  /* 4b2. Другая часть речи / приставка у того же корня:
     «болезнь» ↔ 生病 «заболеть», «учить» ↔ 学习 «учёба».
     Сравниваем корни: отсекаем приставки, требуем общий корень в 4 буквы. */
  if (!out.length) ruWords.forEach(word => {
    const root = ruRoot(word);
    if (root.length < 4) return;
    lex.filter(w => senseParts(w).some(p => shareRoot(ruRoot(p), root))).forEach(push);
  });

  // 4c. Слово внутри длинного значения: «командировка» → 出差
  // («отправляться в командировку»). Берём начало слова: оно у русских
  // слов почти не меняется, в отличие от окончания.
  if (!out.length) ruWords.forEach(word => {
    if (word.length < 6) return;
    const core = word.slice(0, Math.min(7, word.length));
    lex.filter(w => senseParts(w).some(p => p.toLowerCase().includes(core))).forEach(push);
  });

  // 5. Опечатки: ищем ближайшее слово словаря целиком
  if (!out.length && ruWords.length) {
    const phrase = ruWords.join(' ');
    const dict = [...new Set(lex.map(w => w.r.split(/[;,/()]/)[0].trim()))].filter(Boolean);
    const fixed = fuzzyHit(phrase, dict);
    if (fixed) {
      lex.filter(w => w.r.startsWith(fixed)).forEach(push);
    }
  }
  return out.slice(0, limit);
}

/* Карточка слова: иероглиф + пиньинь + перевод (ученику так читаемо) */
function tutorCardHtml(w) {
  const isWord = w && w.h;
  if (!isWord) return '';
  return `<div class="tw-card"><b class="zh" style="font-size:22px">${ruby(w.h)}</b>` +
    `<div class="tw-ru">${esc(w.r)}</div>` +
    (w.lesson ? `<div class="tw-src">${esc(w.lesson)}</div>` : '') + '</div>';
}

/* ---------- Разбор китайской фразы: слова + грамматика ---------- */
function tutorParsePhrase(hanziOnly) {
  const parts = tutorSegment(hanziOnly);
  const exact = tutorLookup(hanziOnly);
  const pinyin = pinyinOf(hanziOnly);
  let html = '';
  if (exact) {
    html += tutorCardHtml(exact);
    html += `<div class="tw-py">${esc(exact.p || pinyin)}</div>`;
  }
  html += `<b>По словам</b> <span style="color:var(--txt3)">(${esc(pinyin)})</span>:` +
    parts.map(tutorWordHtml).join('');
  if (parts.some(p => !p.r)) {
    html += `<div class="tw-note">Серые слова — их пока нет в словаре курса, чтение подсказано по иероглифам.</div>`;
  }
  return { html, speak: hanziOnly, pinyin };
}

/* ---------- Мини-тест с привязкой к слабым местам ---------- */
function tutorQuizReply() {
  const pool = tutorAllVocab().filter(w => w.h && w.p && w.r);
  if (!pool.length) return { html: 'Словарь пуст — начните с первого урока.' };
  const weak = cardPool().filter(c => (state.cards[c.h] || {}).wrong > 0);
  const source = weak.length ? weak : pool;
  const target = source[Math.floor(Math.random() * source.length)];
  const decoys = shuffle(pool.filter(w => w.r !== target.r)).slice(0, 3);
  const opts = shuffle([target, ...decoys]);
  return {
    html: (weak.length ? 'Вопрос по слову, где вы ошибались.<br>' : '') +
      `Как переводится <b class="zh" style="font-size:20px">${ruby(target.h)}</b>` +
      `<span class="tw-py">(${esc(target.p)})</span>?`,
    speak: target.h,
    quiz: { target, opts }
  };
}

/* ---------- Совет по прогрессу с конкретикой ---------- */
function tutorAdviceReply() {
  const ids = tutorLessonIds();
  const done = doneCount(), total = ids.length;
  const due = dueCards().length;
  const nxt = LESSONS[nextLesson()];
  const hard = cardPool().filter(c => (state.cards[c.h] || {}).wrong > 0).slice(0, 5);
  const acc = accuracy();
  let txt = `Пройдено <b>${done} из ${total}</b> уроков, точность <b>${acc}%</b>, серия <b>${state.streak}</b> дн.<br>`;
  if (acc && acc < 60) txt += '🎯 Точность ниже 60% — сейчас важнее не новые уроки, а повторение. ';
  else if (acc >= 85 && done < total) txt += '🚀 Отличная точность — можно смело идти дальше. ';
  txt += '<br>';
  if (due) txt += `🗂️ <b>${due}</b> карточек ждут повторения — <a href="#/cards">Карточки</a>.<br>`;
  if (hard.length) {
    txt += '🎯 Слабее всего: ' + hard.map(c => `<b>${esc(c.h)}</b> (${esc(c.p)} — ${esc(c.r)})`).join(', ') + '.<br>';
  }
  if (nxt) txt += `📚 Следующий урок: <b>«${esc(nxt.title)}»</b> — <a href="#/lesson/${nextLesson()}">открыть →</a>`;
  const openHw = typeof hwOpenCount === 'function' ? hwOpenCount() : 0;
  if (openHw) txt += `<br>🏠 Домашек к сдаче: <b>${openHw}</b> — <a href="#/homework">открыть</a>`;
  return { html: txt };
}

function tutorAnswerCore(raw) {
  const q = String(raw || '').trim();
  const low = q.toLowerCase().replace(/ё/g, 'е');
  const hasHanzi = /[\u3400-\u9fff]/.test(q);
  const words = low.split(/[^a-zа-я0-9]+/).filter(Boolean);

  /* Диалог — это режим, но он не должен «залипать»: если посреди
     тренировки задали обычный вопрос, выходим из диалога и отвечаем
     по существу. Раньше после «давай поговорим» помощник на любой
     вопрос продолжал реплики диалога. */
  if (tutorContext.mode === 'dialogue' &&
      (/\?/.test(q) || /объясн|переведи|что значит|как сказать|что такое|разниц|правил|почему|что мне|проверь/.test(low))) {
    tutorContext.mode = 'chat';
    tutorContext.step = 0;
  }

  /* ---------- 2) Прогресс и совет ---------- */
  if (/прогресс|повторить|совет|что учить|план на|ошибк|получает|как у меня|идет ли|идёт ли|трудно дается|трудно даётся/.test(low)) {
    return tutorAdviceReply();
  }
  /* ---------- 1) Что умеет помощник ---------- */
  if (/(что|чем) (ты )?(умееш|можеш|умеет)|твои возможност|команд|помощь|как (тобой|тебя) пользов/.test(low)) {
    return {
      html: 'Спрашивайте по-русски своими словами — иероглифы набирать не нужно.<br><br>' +
        '• <b>Как сказать «спасибо»?</b> — дам иероглиф, пиньинь и перевод<br>' +
        '• <b>Что значит 出租车?</b> — разберу фразу или слово по частям<br>' +
        '• <b>Объясни 了 / 吗 / 把</b> — правило простыми словами и пример<br>' +
        '• <b>Как спросить дорогу?</b> — подберу готовые фразы по теме<br>' +
        '• <b>Проверь меня</b> — мини-тест по вашим слабым словам<br>' +
        '• <b>Что мне повторить?</b> — посмотрю прогресс и ошибки<br>' +
        '• <b>Давай поговорим</b> — тренировочный диалог'
    };
  }


  /* ---------- 3) Мини-тест ---------- */
  if (/(^|\s)(тест|проверь|проверься|викторин|экзамен|задани|испыта)/.test(low) ||
      /проверь меня|задай вопрос|потренируй меня/.test(low)) {
    return tutorQuizReply();
  }

  /* ---------- 3a) Живой разговор: эмоции, планы, «как дела» ----------
     Эти вопросы не про словарь, поэтому раньше они падали в «не понял»
     или получали случайное слово. Отвечаем по существу. */
  const talk = tutorTalkReply(low, q);
  if (talk) return talk;

  /* ---------- 3b) «Как спросить / заказать / что сказать» ----------
     Это просьба о готовых фразах, а не о переводе слова: раньше
     «как спросить дорогу» отвечало «路 — дорога», и ученик не получал
     ни одной фразы, которой можно спросить. */
  if (/как\s+(мне\s+)?(спросить|узнать|заказать|попросить|позвонить|объяснить|сказать в|договориться)|что\s+(сказать|говорить|спросить)|какие\s+фразы|фразы\s+(для|про|на)/.test(low)) {
    const sit = tutorSituation(low);
    if (sit) return tutorSituationReply(sit, q);
    const topic = tutorTopicReply(low);
    if (topic) return topic;
  }

  /* ---------- 4) «Как сказать X» / «переведи X» ---------- */
  const sayMatch = q.match(/(?:как\s+(?:будет|сказать|перевести|спросить|пишется|говорят|правильно)|переведи(?:те)?|перевод|что\s+значит|означает)\s*[:\-—]?\s*(.+)/i);
  if (sayMatch) {
    const phrase = sayMatch[1].replace(/[«»"'.?!]+$/g, '').trim();

    // 4a. Внутри — иероглифы: разбираем как фразу
    const han = phrase.match(/[\u3400-\u9fff]+/g);
    if (han) {
      const joined = han.join('');
      const parsed = tutorParsePhrase(joined);
      return { html: parsed.html, speak: parsed.speak };
    }

    /* 4a2. Развёрнутая просьба — это не одно слово, а ситуация:
       «как позвонить в ресторан и заказать столик» просит фразы, а не 饭店. */
    if (phrase.split(/\s+/).filter(w => w.length > 1).length >= 3) {
      const sit = tutorSituation(phrase);
      if (sit) return tutorSituationReply(sit, phrase);
    }

    // 4b. Ищем перевод в словаре (с учётом опечаток и падежей)
    const hits = tutorFindWords(phrase, 4);
    if (hits.length) {
      const best = hits[0];
      let html = `<div class="tw-py" style="margin:0 0 6px">«${esc(phrase)}» по-китайски:</div>`;
      html += hits.map(tutorCardHtml).join('');
      // Полезная связка: показываем, как сказать целую фразу просьбы
      if (/^(спасибо|извините|привет|здравствуйте|пока|до свидания)/.test(best.r) && hits.length < 3) {
        html += `<div class="tw-note">Хотите вежливее? Добавьте <b>请 (qǐng)</b> в начале или <b>一下 (yí xià)</b> — смягчает просьбу.</div>`;
      }
      return { html, speak: best.h };
    }

    // 4c. Тема, а не одно слово: «как спросить дорогу», «как заказать еду»
    const topic = tutorTopicReply(phrase);
    if (topic) return topic;

    // 4d. Честно говорим, что нет, и ведём туда, где ответ есть
    const near = tutorFindWords(phrase.split(/\s+/).slice(-2).join(' '), 3);
    const links = tutorDictLinks(phrase);
    return {
      html: `В словаре курса «${esc(phrase)}» нет — но это не тупик.` +
        (near.length ? `<br>Похожие слова из курса:<br>${near.map(tutorCardHtml).join('')}` : '') +
        `<div class="tw-links">Проверить в словарях: ` +
        links.slice(0, 3).map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)} ↗</a>`).join(' · ') +
        `</div><div class="tw-note">Так вы найдёте и слово, и примеры — и сможете добавить его в <a href="#/cards">карточки</a>.</div>`
    };
  }

  /* ---------- 5) Тема: дорога, еда, покупки, отель... ---------- */
  /* Про тему спрашивают прямо («фразы про еду», «как спросить дорогу»)
     или называют её одним-двумя словами. Иначе — не перехватываем:
     вопрос «сколько времени нужно учить» — про обучение, а не про темы. */
  const plainWords = words.length;
  const asksTopic = /фраз[ыа]?\s+(про|о|для|на тему)|по теме|диалог\s+(про|о)|(как|что)\s+(спросить|сказать|заказать)\s+(дорог|цен|еду|счет|счёт|путь|направлен|врач|билет)|(какие|дай|покажи)\s+(слова|фразы)/.test(low);
  const namesTopic = plainWords <= 4 && /^(дорог|еда|покупк|отел|такси|транспорт|погод|семь|работ|учеб|здоров|врач|деньг|врем|дата|месяц)/.test(low.trim());
  if (asksTopic || namesTopic || (/как\s+(спросить|сказать|объяснить|заказать)/.test(low) && plainWords <= 7)) {
    const sit = tutorSituation(low);
    if (sit) return tutorSituationReply(sit, q);
    const topic = tutorTopicReply(low);
    if (topic) return topic;
  }

  /* ---------- 6) Разбор китайской фразы ----------
     Но если спрашивают «в чём разница 不 и 没» — это вопрос о правиле,
     а не просьба перевести фразу: сначала правило. */
  const hanziCount = (q.match(/[\u3400-\u9fff]/g) || []).length;
  const wantsRule = /разниц|объясн|правил|грамматик|когда (использ|ставят|нужн)|почему|зачем/.test(low);
  /* Порог был «не больше двух иероглифов», но «объясни по-человечески 了»
     содержит их ровно один — и всё равно попадал в словарь вместо правила.
     Если правило найдено и вопрос про правило — отвечаем правилом. */
  const earlyRule = wantsRule ? tutorMatchRule(low) : null;
  if (earlyRule) {
    const ex = earlyRule.ex || {};
    return {
      html: `<b>📖 ${esc(earlyRule.title)}</b><br><br>${earlyRule.body}` +
        (ex.h ? `<div class="tw-card"><b class="zh" style="font-size:20px">${ruby(ex.h)}</b>` +
          `<div class="tw-py">${esc(ex.p || '')}</div><div class="tw-ru">${esc(ex.r || '')}</div></div>` : ''),
      speak: ex.h || ''
    };
  }

  if (hasHanzi && q.replace(/[^\u3400-\u9fff]/g, '').length >= 2) {
    const hanziOnly = q.match(/[\u3400-\u9fff]+/g).join('');
    const parsed = tutorParsePhrase(hanziOnly);
    const rule = TUTOR_RULES.find(r => r.id === 'le' && /了/.test(hanziOnly)) ||
      TUTOR_RULES.find(r => r.id === 'ma' && /吗/.test(hanziOnly)) ||
      TUTOR_RULES.find(r => r.id === 'ba' && /把/.test(hanziOnly));
    let html = parsed.html;
    if (rule) html += `<div class="tw-note">📖 Здесь работает <b>${esc(rule.title)}</b>. Спросите «объясни ${rule.id === 'le' ? '了' : rule.id === 'ma' ? '吗' : '把'}», если нужно подробнее.</div>`;
    return { html, speak: parsed.speak };
  }

  /* ---------- 7) Грамматика: правило по ключевым словам ---------- */
  const rule = tutorMatchRule(low);
  const asksRule = /объясн|правил|грамматик|как (использ|употребл|работает|построить|строит)|разниц|почему|зачем|когда/.test(low);
  if (rule && (asksRule || words.length <= 6 || !hasHanzi)) {
    const ex = rule.ex || {};
    return {
      html: `<b>📖 ${esc(rule.title)}</b><br><br>${rule.body}` +
        (ex.h ? `<div class="tw-card"><b class="zh" style="font-size:20px">${ruby(ex.h)}</b>` +
          `<div class="tw-py">${esc(ex.p || '')}</div><div class="tw-ru">${esc(ex.r || '')}</div></div>` : ''),
      speak: ex.h || ''
    };
  }

  /* ---------- 8) Один иероглиф ---------- */
  const singleHan = q.match(/^[\u3400-\u9fff]$/);
  if (singleHan) {
    const ch = singleHan[0];
    const py = (typeof PY_CHAR !== 'undefined' && PY_CHAR[ch]) || '';
    const known = typeof GRAMMAR_TIPS !== 'undefined' ? GRAMMAR_TIPS[ch] : '';
    const look = tutorLookup(ch);
    let html = `<b class="zh" style="font-size:30px">${ruby(ch)}</b>`;
    if (py) html += ` <span class="tw-py">[${esc(py)}]</span>`;
    if (look) html += `<br>Перевод: <b>${esc(look.r)}</b>`;
    if (known) html += `<br>В грамматике: ${esc(known)}`;
    if (!look && !known) html += '<div class="tw-note">Этот иероглиф пока не встречался в курсе. Спросите фразой — например «разбери 中国人».</div>';
    return { html, speak: ch };
  }

  /* ---------- 9) Диалог ----------
     Сам диалог живёт в tutorDialogueTurn: он помнит имя и выбор
     собеседника и реагирует на реплику, а не читает сценарий. */
  if (tutorContext.mode === 'dialogue') {
    const turn = tutorDialogueTurn(q);
    if (turn) return turn;
  }

  /* ---------- 9) Ситуация: бытовой запрос целиком ----------
     «что сказать в аптеке», «как заказать такси», «мне нужен врач» —
     это просьба о фразах, а не о переводе одного слова. */
  const isShort = words.filter(w => w.length > 2).length <= 3;
  if (!hasHanzi) {
    const sit = tutorSituation(low);
    if (sit && (!isShort || /фраз|сказать|спросить|как|что|нужн|хочу|можно/.test(low))) {
      return tutorSituationReply(sit, q);
    }
  }

  /* ---------- 10b) «Не понимаю» без темы — просим уточнить по-человечески ----------
     Стоит до словаря: иначе «совсем не понимаю» находило 不 и 没 и
     отвечало списком отрицаний вместо «давайте разберёмся». */
  if (/не\s+(понима|понял|поняла|разобрал)|ничего не понят|сложно понять|запутал/.test(low)) {
    return {
      html: 'Хорошо, давайте медленнее. Что именно непонятно?<br>' +
        '• слово — напишите его, разберу по частям;<br>' +
        '• правило — назовите частицу или конструкцию (了, 的, 把, 吗);<br>' +
        '• фраза — пришлите её целиком, переведу по словам.<br>' +
        '<div class="tw-note">Можно совсем просто: «объясни 了», «что значит 车站», «как сказать спасибо».</div>'
    };
  }

  /* ---------- 9b) Поиск по словарю ----------
     Ищем слово, только если вопрос короткий («билет», «аптека») или
     в нём есть иероглифы. Длинный вопрос — это не одно слово: раньше
     «сколько времени нужно учить китайский» получал в ответ 几, 多少,
     要不要 — четыре слова подряд вместо ответа. */
  const found = (isShort || hasHanzi) ? tutorFindWords(q, 6) : [];
  /* На длинный вопрос словарное совпадение почти всегда случайное:
     «сколько времени нужно учить китайский» ловило 几 и 要不要. Такое
     совпадение лучше не показывать вовсе, чем выдавать за ответ. */
  const noisy = !isShort && found.length > 0 && !found.some(
    w => ruStem(w.r) === ruStem(q) || w.h === q.trim());
  if (found.length && !noisy) {
    const exact = found.find(w => ruStem(w.r) === ruStem(q) || w.h === q.trim());
    if (exact && found.length === 1) {
      return {
        html: `<b class="zh" style="font-size:24px">${ruby(exact.h)}</b><span class="tw-py">${esc(exact.p)}</span><br>` +
          `Перевод: <b>${esc(exact.r)}</b>` +
          (exact.lesson ? `<div class="tw-src">Раздел курса: ${esc(exact.lesson)}</div>` : ''),
        speak: exact.h
      };
    }
    return {
      html: `Вот что есть по запросу «${esc(q)}»:<br>` + found.map(tutorWordHtml).join(''),
      speak: found[0].h
    };
  }

  /* ---------- 11) Всё равно не поняли: уточняем, а не отшиваем ---------- */
  // Пробуем вытащить хоть одно знакомое слово из вопроса
  const fragments = q.split(/[^a-zA-Zа-яА-ЯёЁ0-9\u3400-\u9fff]+/).filter(w => w.length > 2);
  const guess = fragments.map(f => tutorFindWords(f, 1)[0]).filter(Boolean).slice(0, 3);
  return {
    html: 'Не уверен, что понял — уточните, пожалуйста. Я лучше всего отвечаю на такие вопросы:<br>' +
      '• <b>как сказать «спасибо»</b><br>• <b>что значит 车站</b><br>• <b>объясни разницу 不 и 没</b><br>' +
      '• <b>как спросить дорогу</b><br>• <b>что мне повторить</b>' +
      (guess.length ? `<div class="tw-note">Возможно, вы про это: ${guess.map(w => `<b>${esc(w.h)}</b> (${esc(w.p)} — ${esc(w.r)})`).join(', ')}</div>` : '') +
      (tutorDictLinks(q.split(/[^\u3400-\u9fff]+/)[0] || q).length
        ? `<div class="tw-links">Или посмотрите сами: ` +
          tutorDictLinks(q.split(/[^\u3400-\u9fff]+/)[0] || q).slice(0, 2)
            .map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)} ↗</a>`).join(' · ') +
          `</div>` : '')
  };
}

/* ---------- Разговор по существу: то, о чём ученик спрашивает словами ----------
   Всё ниже — не перевод и не правило, а ответ на живой вопрос: «сколько
   учить», «я устал», «с чего начать». Раньше такие вопросы попадали
   в словарь («учить» → 学) или в «не понял». Здесь у каждого свой
   ответ, и он опирается на реальные цифры курса, а не на выдумки. */
function tutorTalkReply(low, q) {
  const done = doneCount(), total = allLessonIds().length;

  /* «как дела / как ты» — обычная человеческая реплика */
  if (/^(как дела|как ты|как жизнь|что нового|как настроение)[\s?!.]*$/.test(low)) {
    return {
      html: 'У меня всё отлично — я же не устаю 🙂<br>А как ваши дела? По-китайски это <b>你好吗？</b> ' +
        '<span class="tw-py">nǐ hǎo ma?</span> — буквально «ты хорошо?».<br>' +
        '<div class="tw-note">Ответ: <b>我很好</b> (wǒ hěn hǎo) — «у меня всё хорошо», или <b>还不错</b> (hái bú cuò) — «неплохо».</div>'
    };
  }

  /* «как сказать, что мне грустно / я устал» — эмоции */
  if (/груст|плохо|устал|тяжело|трудно|не получается|нет сил|бросить|сдаться/.test(low)) {
    const isTired = /устал|нет сил|тяжело|трудно/.test(low);
    return {
      html: (isTired
        ? 'Усталость — нормальная часть учёбы, особенно с китайским: тут нужно время, а не талант.<br>'
        : 'Понимаю. С языком бывает тяжело, и это не про ваши способности.<br>') +
        'Скажите об этом по-китайски:<br>' +
        '<div class="tw-card"><b class="zh" style="font-size:19px">我有点累。</b>' +
        '<div class="tw-py">wǒ yǒu diǎn lèi</div><div class="tw-ru">Я немного устал(а)</div></div>' +
        '<div class="tw-card"><b class="zh" style="font-size:19px">我今天心情不好。</b>' +
        '<div class="tw-py">wǒ jīn tiān xīn qíng bù hǎo</div><div class="tw-ru">У меня сегодня плохое настроение</div></div>' +
        `<div class="tw-note">Если сил мало — не начинайте новый урок. Откройте <a href="#/cards">Карточки</a>: 5 минут повторения держат слова живыми. Пройдено ${done} из ${total}, это уже путь.</div>`
    };
  }

  /* «сколько учить / когда заговорю» */
  if (/сколько (времени|лет|месяцев)|как быстро|когда (я )?(заговор|выуч|начну говорить)|реально ли выуч/.test(low)) {
    return {
      html: '<b>Честно, без обещаний «за месяц».</b><br>' +
        '• HSK 1–2 (около 300 слов) — обычно 3–6 месяцев по 20 минут в день;<br>' +
        '• HSK 3–4 (около 1200 слов) — ещё год-полтора;<br>' +
        '• свободная бытовая речь — 2–3 года регулярных занятий.<br>' +
        `<div class="tw-note">В вашем курсе ${total} уроков; пройдено ${done}. Главное — не длина занятия, а частота: 15 минут каждый день сильнее, чем 2 часа раз в неделю.</div>`
    };
  }

  /* «с чего начать / как учить / с чего продолжить» */
  if (/с чего начать|как учить|как заниматься|с чего продолжить|план обучен|как запоминать|как учить слова/.test(low)) {
    const nxt = LESSONS[nextLesson()];
    return {
      html: '<b>Простой порядок, который работает:</b><br>' +
        '1. Урок — 10–15 минут, вслух, с пиньинем.<br>' +
        '2. Сразу после — 5 минут <a href="#/cards">карточек</a>: они держат слова в памяти.<br>' +
        '3. Раз в неделю — <a href="#/tones">Тоны</a> и <a href="#/practice">Практика</a>.<br>' +
        (nxt ? `<div class="tw-note">Следующий шаг прямо сейчас: «${esc(nxt.title)}» — <a href="#/lesson/${nextLesson()}">открыть урок →</a></div>` : '')
    };
  }

  /* «забыл слово / не помню» — приём, а не перевод */
  if (/забыл|не помню|вылетело|не могу вспомнить/.test(low)) {
    return {
      html: 'Это нормально: забывать — часть запоминания.<br>' +
        'Три приёма, которые работают:<br>' +
        '• <b>Вспомните урок</b>, где слово встречалось, — контекст вытягивает слово.<br>' +
        '• <b>Опишите</b> его по-китайски: «то, на чём ездят» → 车 (chē).<br>' +
        '• <b>Загляните в карточки</b> — слово, которое вы забыли, уже ждёт в повторении.<br>' +
        '<div class="tw-note">Напишите мне по-русски, что помните о слове, — я подберу кандидатов.</div>'
    };
  }

  /* «расскажи про себя / кто ты» — коротко и по делу */
  if (/кто ты|расскажи (о себе|про себя)|ты робот|ты человек|что ты такое/.test(low)) {
    return {
      html: 'Я Сяо Мин (小明) — встроенный помощник этого курса.<br>' +
        'Я не человек: отвечаю по правилам курса, словарю HSK и найденным источникам, а где не уверен — говорю об этом прямо.<br>' +
        '<div class="tw-note">Можете спросить: «как сказать спасибо», «объясни 了», «как заказать столик».</div>'
    };
  }

  return null;
}

/* ---------- Ситуации: живой запрос → готовые фразы ----------
   Ученик редко спрашивает «какие фразы по теме еда». Он спрашивает
   «как позвонить в ресторан и заказать столик». Раньше такой вопрос
   попадал в словарь и получал 饭店 + 餐厅 — то есть перевод одного
   слова вместо готовой фразы. Здесь у каждой бытовой ситуации свой
   набор: проверенные фразы, пиньинь, перевод и короткая подсказка. */
const TUTOR_SITUATIONS = [
  {
    id: 'restaurant', title: 'В ресторане',
    keys: /ресторан|кафе|столик|официант|меню|заказать ед|поесть|обед|ужин|счёт|счет|оплатить|заплатить|поесть/,
    lines: [
      { h: '请问，有空位吗？', p: 'qǐng wèn, yǒu kòng wèi ma?', r: 'Извините, есть свободные места?' },
      { h: '我要订一张桌子。', p: 'wǒ yào dìng yì zhāng zhuō zi', r: 'Я хочу забронировать столик' },
      { h: '请给我菜单。', p: 'qǐng gěi wǒ cài dān', r: 'Дайте, пожалуйста, меню' },
      { h: '我要这个。', p: 'wǒ yào zhè ge', r: 'Я возьму вот это' },
      { h: '买单，谢谢。', p: 'mǎi dān, xiè xie', r: 'Счёт, пожалуйста' }
    ],
    tip: 'Для брони по телефону хватит трёх фраз: 我要订一张桌子 (хочу забронировать столик), 今天晚上 (на сегодня вечером) и 两个人 (два человека).'
  },
  {
    id: 'shop', title: 'Покупки и деньги',
    keys: /магазин|куп|сколько сто|цен|дорого|дешев|скидк|юан|оплат|картой|деньг|сдач/,
    lines: [
      { h: '多少钱？', p: 'duō shao qián?', r: 'Сколько стоит?' },
      { h: '太贵了。', p: 'tài guì le', r: 'Слишком дорого' },
      { h: '可以便宜一点吗？', p: 'kě yǐ pián yi yì diǎn ma?', r: 'Можно немного дешевле?' },
      { h: '我刷卡。', p: 'wǒ shuā kǎ', r: 'Я оплачу картой' },
      { h: '我要这个。', p: 'wǒ yào zhè ge', r: 'Я возьму это' }
    ],
    tip: 'Про скидку спрашивают мягко: 可以便宜一点吗？ — дословно «можно чуть дешевле?».'
  },
  {
    id: 'road', title: 'Дорога и транспорт',
    keys: /дорог|пройти|проехать|где находит|метро|такси|автобус|вокзал|аэропорт|билет|далеко|близко|налево|направо|заблуд/,
    lines: [
      { h: '请问，怎么走？', p: 'qǐng wèn, zěn me zǒu?', r: 'Извините, как пройти?' },
      { h: '最近的地铁站在哪里？', p: 'zuì jìn de dì tiě zhàn zài nǎ lǐ?', r: 'Где ближайшая станция метро?' },
      { h: '我迷路了。', p: 'wǒ mí lù le', r: 'Я заблудился' },
      { h: '请给我一张票。', p: 'qǐng gěi wǒ yì zhāng piào', r: 'Дайте, пожалуйста, один билет' },
      { h: '远不远？', p: 'yuǎn bu yuǎn?', r: 'Далеко?' }
    ],
    tip: 'Таксисту достаточно сказать «去 + место»: 去机场 (в аэропорт).'
  },
  {
    id: 'hotel', title: 'Гостиница',
    keys: /отел|гостиниц|номер|брон|засел|выпис|ключ/,
    lines: [
      { h: '我订了房间。', p: 'wǒ dìng le fáng jiān', r: 'Я забронировал номер' },
      { h: '还有房间吗？', p: 'hái yǒu fáng jiān ma?', r: 'Есть ещё номера?' },
      { h: '多少钱一晚？', p: 'duō shao qián yì wǎn?', r: 'Сколько стоит за ночь?' },
      { h: '几点退房？', p: 'jǐ diǎn tuì fáng?', r: 'Во сколько выезд?' },
      { h: '有 Wi-Fi 吗？', p: 'yǒu Wi-Fi ma?', r: 'Есть Wi-Fi?' }
    ],
    tip: 'Номер бронируют через 订 (dìng): 我订了房间 — «я забронировал номер».'
  },
  {
    id: 'health', title: 'Здоровье и аптека',
    keys: /бол|болит|врач|доктор|аптек|лекарств|температур|простуд|плохо себя|вызвать врач/,
    lines: [
      { h: '我不舒服。', p: 'wǒ bù shū fu', r: 'Я плохо себя чувствую' },
      { h: '我头疼。', p: 'wǒ tóu téng', r: 'У меня болит голова' },
      { h: '请叫医生。', p: 'qǐng jiào yī shēng', r: 'Вызовите врача, пожалуйста' },
      { h: '我要买药。', p: 'wǒ yào mǎi yào', r: 'Мне нужно купить лекарство' },
      { h: '医院在哪里？', p: 'yī yuàn zài nǎ lǐ?', r: 'Где больница?' }
    ],
    tip: 'Боль называют через 疼 (téng): 我头疼 — болит голова, 我肚子疼 — болит живот.'
  },
  {
    id: 'help', title: 'Помощь и вежливость',
    keys: /помог|извин|простит|не понима|говорите медлен|повторите|спасибо|вежлив/,
    lines: [
      { h: '对不起。', p: 'duì bu qǐ', r: 'Извините' },
      { h: '请再说一遍。', p: 'qǐng zài shuō yí biàn', r: 'Повторите, пожалуйста' },
      { h: '请说慢一点。', p: 'qǐng shuō màn yì diǎn', r: 'Говорите помедленнее, пожалуйста' },
      { h: '我没听懂。', p: 'wǒ méi tīng dǒng', r: 'Я не понял' },
      { h: '麻烦你帮我。', p: 'má fan nǐ bāng wǒ', r: 'Помогите мне, пожалуйста' }
    ],
    tip: 'Если не поняли — не молчите: 请再说一遍 и 请说慢一点 спасают разговор.'
  }
];

function tutorSituation(raw) {
  const low = String(raw || '').toLowerCase().replace(/ё/g, 'е');
  let best = null, bestScore = 0;
  TUTOR_SITUATIONS.forEach(sit => {
    const m = low.match(sit.keys);
    if (!m) return;
    /* Чем больше совпало ключевых слов — тем вернее ситуация:
       «позвонить в ресторан и заказать столик» — это ресторан. */
    const score = (low.match(new RegExp(sit.keys.source, 'g')) || []).length * 2 + m[0].length / 4;
    if (score > bestScore) { bestScore = score; best = sit; }
  });
  return best;
}

function tutorSituationReply(sit, raw) {
  const cards = sit.lines.map(l =>
    `<div class="tw-card"><b class="zh" style="font-size:19px">${ruby(l.h)}</b>` +
    `<div class="tw-py">${esc(l.p)}</div><div class="tw-ru">${esc(l.r)}</div></div>`).join('');
  return {
    html: `<b>💬 ${esc(sit.title)}</b><br>` +
      `<div class="tw-py" style="margin:2px 0 6px">Готовые фразы под ваш вопрос:</div>` + cards +
      `<div class="tw-note">${esc(sit.tip)}</div>`,
    speak: sit.lines[0].h
  };
}

/* ---------- Ответы по темам: готовые фразы из курса ----------
   Тема ищется не только по названию урока, но и по самим словам:
   иначе в «дорогу» попадали 把 и 拿 из соседнего урока. */
const TUTOR_TOPICS = [
  { id: 'greet', title: 'Приветствия и знакомство', ids: ['l1'],
    words: /приветств|здравств|знаком|(^|\s)имя|зовут|до свидан|спасибо|благодар|извинит|простит|вежлив/,
    topic: /приветств|знакомств|представит|вежлив/ },
  { id: 'money', title: 'Покупки и деньги', ids: ['l2'],
    words: /цен[аыуеой]|деньг|денег|дорого|дороже|дешев|стоит|скидк|покуп|магазин|юан/,
    topic: /покупк|магазин|деньг|торг|рынок/ },
  { id: 'family', title: 'Семья', ids: ['l3'],
    words: /семь[яиюей]|семей|мам[аыуеой]|пап[аыуеой]|брат|сестр|сын|доч|родител|бабушк|дедушк|жен[аыуеой]|муж[ауе]?\b/,
    topic: /семь|родствен|брат|сестр|мама|папа/ },
  { id: 'food', title: 'Еда и ресторан', ids: ['l4'],
    words: /ед[ауыеой]|заказ|ресторан|кафе|меню|вкусн|остр|ча[йяюе]|кофе|вод[аыуеой]|рис|лапш|мясо|блюд|счет|счёт|оплат|официант/,
    topic: /еда|заказ|ресторан|кафе|меню|поесть|блюд|обед/ },
  { id: 'place', title: 'Место и время (在)', ids: ['l5'],
    words: /где|находит|мест[оаеу]|дом[ауе]\b|школ|врем[яиюе]|час[аов]?\b|минут|утр[оае]|вечер|ноч[ьи]|сейчас/,
    topic: /мест|где находит|который час/ },
  { id: 'past', title: 'Прошедшее и частица 了', ids: ['l6'],
    words: /уже|сделал|вчера|прошл|законч|готов/,
    topic: /прошл|уже сдела|заверш/ },
  { id: 'weather', title: 'Погода и сезоны', ids: ['l11'],
    words: /погод|дожд|снег|холод|жарк|тепл|ветер|солнц|весн|лето|осен|зим|месяц|январ|феврал|апрел|июн|июл|август|сентябр|октябр|ноябр|декабр/,
    topic: /погод|времена года|сезон/ },
  { id: 'transport', title: 'Транспорт и дорога', ids: ['l12'],
    words: /такси|метро|автобус|поезд|самолет|самолёт|аэропорт|вокзал|билет|дорог[аиуеи]|улиц|налево|направ|прямо|рядом|идти|ехать|далеко|близко|карт[аыуе]|как пройти/,
    topic: /такси|метро|транспорт|аэропорт|вокзал|билет|дорог|улиц|направ|как пройти/ },
  { id: 'health', title: 'Здоровье и врач', ids: ['l13'],
    words: /бол[ьи]|болит|болезн|врач|доктор|аптек|лекарств|температур|простуд|голов[аыуе]|живот|горл[оа]/,
    topic: /здоров|врач|болезн|бол/ },
  { id: 'work', title: 'Работа и офис', ids: ['l14'],
    words: /работ|професс|офис|коллег|начальник|встреч|письм|должност|компани|зарплат/,
    topic: /работ|професс|офис|должност/ },
  { id: 'study', title: 'Учёба и планы', ids: ['l15'],
    words: /учит|уч[её]б|школ|универ|экзамен|hsk|план|будущ|собира|мечт/,
    topic: /учеб|экзамен|hsk|планы|будущ/ }
];

function tutorTopicReply(raw) {
  const low = String(raw || '').toLowerCase().replace(/ё/g, 'е');
  const scored = TUTOR_TOPICS.map(tp => ({ tp, score: (low.match(tp.words) ? 2 : 0) + (tp.topic.test(low) ? 3 : 0) }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const hit = scored[0].tp;

  const items = [];
  hit.ids.forEach(id => {
    const L = LESSONS[id];
    if (!L) return;
    (L.vocab || []).forEach(w => {
      const ru = (w.r || '').toLowerCase();
      /* берём слова урока, которые действительно про эту тему */
      if (hit.words.test(ru)) items.push({ h: w.h, p: w.p, r: w.r, lesson: L.title, score: 2 });
    });
  });
  if (typeof PHRASES !== 'undefined') {
    PHRASES.forEach(cat => {
      (cat.items || []).forEach(w => {
        if (hit.words.test((w.r || '').toLowerCase())) items.push({ h: w.h, p: w.p, r: w.r, lesson: cat.c, score: 3 });
      });
    });
  }
  if (!items.length) return null;
  /* Ключевые слова темы короче описательных фраз — они и полезнее
     в первую очередь: «дорога» раньше, чем «сколько стоит билет». */
  items.sort((a, b) => (b.score - a.score) || (a.r.length - b.r.length));
  const uniq = [];
  items.forEach(w => { if (!uniq.some(x => x.h === w.h)) uniq.push(w); });
  const first = uniq[0];
  const lessonLinks = hit.ids.map(id => LESSONS[id]
    ? `<a href="#/lesson/${id}">${esc(LESSONS[id].title)}</a>` : '').filter(Boolean).join(' · ');
  return {
    html: `<b>${esc(hit.title)}</b> — из курса:<br>` +
      uniq.slice(0, 6).map(tutorCardHtml).join('') +
      `<div class="tw-note">Разобрано в уроке: ${lessonLinks}. Ещё фразы — в разделе <a href="#/phrases">Фразы</a>.</div>`,
    speak: first.h
  };
}

/* ============================================================
   МОЗГ ПОМОЩНИКА: ПЛАН → ДЕЙСТВИЕ → ПРОВЕРКА → ПАМЯТЬ
   ============================================================
   До этого помощник был «умным поиском»: одно правило на вопрос,
   никакой памяти и никакой проверки собственного ответа. Теперь он
   сначала строит план (что за вопрос, на чём основан ответ, что
   подсказать дальше), затем собирает ответ по шагам, потом проверяет
   его — и только потом отдаёт. Между репликами он помнит, какой урок
   разбирали, что проверяли тестом, какое правило объясняли, — поэтому
   «а попроще?», «а пример?», «я ошибся» звучат осмысленно.
   ============================================================ */

/* ---------- Память разговора ---------- */
const TUTOR_MEMORY = {
  words: [],        // последние разобранные слова (иероглиф + перевод)
  rule: null,       // последнее объяснённое правило
  lesson: null,     // последний урок, о котором говорили
  quiz: null,       // последний тест: цель и варианты
  lastTopic: '',    // последняя тема (дорога, еда…)
  explained: [],    // id правил, которые уже объясняли
  asked: [],        // последние вопросы — чтобы «повтори» и «по-другому»
  turns: 0,
  lastKind: '',     // 'word' | 'rule' | 'lesson' — на чём остановились
  level: 'normal'   // normal | simple — глубина объяснения
};

function tutorRemember(kind, value) {
  if (kind === 'words' && Array.isArray(value)) {
    value.forEach(w => {
      if (!w || !w.h) return;
      TUTOR_MEMORY.words = TUTOR_MEMORY.words.filter(x => x.h !== w.h);
      TUTOR_MEMORY.words.unshift({ h: w.h, p: w.p || '', r: w.r || '', lesson: w.lesson || '' });
    });
    TUTOR_MEMORY.words = TUTOR_MEMORY.words.slice(0, 12);
    TUTOR_MEMORY.lastKind = 'word';
  } else if (kind === 'rule' && value) {
    TUTOR_MEMORY.rule = value;
    TUTOR_MEMORY.lastKind = 'rule';
    if (!TUTOR_MEMORY.explained.includes(value.id)) TUTOR_MEMORY.explained.push(value.id);
  } else if (kind === 'lesson' && value) {
    TUTOR_MEMORY.lesson = value;
  } else if (kind === 'quiz' && value) {
    TUTOR_MEMORY.quiz = value;
  } else if (kind === 'topic' && value) {
    TUTOR_MEMORY.lastTopic = value;
  } else if (kind === 'question' && value) {
    TUTOR_MEMORY.asked.push(String(value).slice(0, 160));
    TUTOR_MEMORY.asked = TUTOR_MEMORY.asked.slice(-6);
  }
}

/* ---------- Снимок знаний ученика: на нём строится любой совет ---------- */
function tutorLearner() {
  const lessons = state.lessons || {};
  const cards = state.cards || {};
  const ids = tutorLessonIds();
  const done = ids.filter(id => lessons[id] && lessons[id].done);
  const current = ids.find(id => !(lessons[id] && lessons[id].done)) || ids[ids.length - 1];
  const due = dueCards().length;
  const weak = cardPool()
    .map(c => ({ ...c, stat: cards[c.h] || {} }))
    .filter(c => (c.stat.wrong || 0) > 0)
    .sort((a, b) => (b.stat.wrong || 0) - (a.stat.wrong || 0))
    .slice(0, 6);
  const log = (state.quizLog || []).slice(-5);
  const lastQuiz = log.length ? log[log.length - 1] : null;
  const acc = accuracy();
  return {
    ids, done, current, due, weak, acc, log, lastQuiz,
    total: ids.length,
    doneCount: done.length,
    streak: state.streak || 0
  };
}

/* ============================================================
   ПРОВЕРКА ОТВЕТА УЧЕНИКА
   Раньше помощник только отвечал. Теперь его можно попросить
   проверить свою фразу: он сверяет с курсом и объясняет ошибку,
   а не просто говорит «неверно».
   ============================================================ */
function tutorCheckAnswer(raw) {
  /* Берём хвост после «проверь мой ответ»; если фраза пришла без
     префикса — работаем со всей строкой. */
  const full = String(raw || '');
  const m = full.match(/^проверь(?: меня| мой ответ)?[\s:—-]*([\s\S]*)$/i);
  const text = (m ? m[1] : full).trim();
  const hasHanzi = /[\u3400-\u9fff]/.test(text);

  /* Попросили проверить, но фразы не дали — просим её, а не молчим */
  if (!text) {
    return {
      html: 'Пришлите фразу — и я разберу её по словам:<br>' +
        '• <b>проверь мой ответ 我喝茶了</b> — иероглифы<br>' +
        '• <b>проверь мой ответ где вокзал</b> — по-русски тоже можно' +
        `<div class="tw-note">Я скажу, все ли слова есть в курсе, и что стоит поправить.</div>`
    };
  }

  /* 1. Китайская фраза: разбираем по словам и смотрим, что не из курса */
  if (hasHanzi) {
    /* Латиница внутри китайской фразы — почти всегда опечатка раскладки */
    const stray = (text.match(/[a-zA-Z]+/g) || []).filter(x => x.length <= 3);
    const han = text.match(/[\u3400-\u9fff]+/g).join('');
    const parts = tutorSegment(han);
    const unknown = parts.filter(pt => !pt.r);
    const pinyin = pinyinOf(han);
    let html = `<b>Ваша фраза:</b> <span class="zh" style="font-size:19px">${esc(han)}</span>` +
      `<div class="tw-py">${esc(pinyin)}</div>` +
      `<b>По словам:</b>` + parts.map(tutorWordHtml).join('');
    if (stray.length) {
      html += `<div class="tw-note">⚠️ Внутри фразы остались латинские буквы: ` +
        stray.map(s => `<b>${esc(s)}</b>`).join(', ') +
        `. Похоже, часть символов набрана в другой раскладке — проверьте эти места.</div>`;
    } else if (!unknown.length) {
      html += `<div class="tw-note">✅ Все слова есть в курсе, порядок читается нормально. ` +
        `Если это вопрос — проверьте, что в конце стоит <b>吗</b> или вопросительное слово.</div>`;
    } else {
      html += `<div class="tw-note">⚠️ Эти слова пока не встречались в курсе: ` +
        unknown.map(u => `<b>${esc(u.h)}</b>`).join(', ') +
        `. Возможно, опечатка в иероглифе — сверьтесь со <a href="#/dict">Словарём</a>.</div>`;
    }
    tutorRemember('words', parts);
    return { html, speak: han };
  }

  /* 2. Русская фраза — переводим по словарю и предупреждаем о порядке слов */
  const found = tutorFindWords(text, 5);
  if (!found.length) {
    return {
      html: 'Не нашёл знакомых слов в вашем ответе. Напишите фразу иероглифами (车站在哪里) ' +
        'или по-русски («где вокзал») — я разберу по словам.'
    };
  }
  const target = (typeof tutorMatchRule === 'function') ? null : null;
  let html = `<b>Разбор вашей фразы:</b><br>` + found.map(tutorCardHtml).join('');
  if (found.length === 1) {
    html += `<div class="tw-note">Это одно слово. Чтобы собрать фразу, добавьте глагол или вопрос: ` +
      `например <b>请问…怎么走</b> — «извините, как пройти…».</div>`;
  } else {
    html += `<div class="tw-note">Порядок в китайском: <b>кто + когда + где + глагол + что</b>. ` +
      `Вопрос — частицей <b>吗</b> в конце или вопросительным словом (什么, 哪里, 多少钱).</div>`;
  }
  tutorRemember('words', found);
  return { html, speak: found[0].h };
}

/* ---------- Как ученик формулирует просьбы ---------- */
const TUTOR_INTENT = [
  { id: 'simpler', re: /^(а\s+)?(попроще|проще)|простыми словами|объясни (понятн|проще|по-человечески)|как реб[её]нку|ещ[её] проще|слишком сложно/ },
  { id: 'example', re: /^(а\s+)?(еще\s+|ещё\s+)?пример|примеры|покажи пример|как сказать эту фразу|в предложении/ },
  { id: 'more', re: /^(а\s+)?(еще|ещё|дальше|подробнее|расскажи больше)|расскажи подробнее|а что еще|а что ещё/ },
  { id: 'repeat', re: /^(повтори|еще раз|ещё раз|не успел|проговори)|^повтори(\s+(это|ещё|еще))?$/ },
  { id: 'wrong', re: /я ошиб|я не угадал|неправильно|почему неверно|я неправильно/ },
  { id: 'dontknow', re: /^(не знаю|без понятия|не помню|забыл|подскажи( ответ)?)[.!?]*$/ },
  { id: 'enough', re: /хватит|достаточно|спасибо, понял|спасибо понял|понятно|ясно/ },
  { id: 'why', re: /а почему|почему так|откуда|зачем именно/ },
  { id: 'continue', re: /^(да|продолжай|дальше|поехали|ок|хорошо)$/ },
  { id: 'dialogue', re: /давай поговорим|потренируем диалог|поговорим|поиграем в диалог|потренироваться/ },
  { id: 'audio', re: /как (это )?(звучит|произносит|читает)|произнош|озвуч|послушать/ }
];

function tutorIntent(low) {
  const q = low.trim().replace(/[.!…]+$/, '');
  const out = (() => {
    for (const it of TUTOR_INTENT) if (it.re.test(q)) return it.id;
    return null;
  })();
  /* «не понимаю, почему тут 的» — это вопрос о правиле, а не голая
     просьба «объясни попроще»: иначе помощник отвечал «что именно
     объяснить?», хотя ученик уже сказал, что именно. */
  if (out === 'simpler' && /не\s+понима|не\s+понял|запутался|сложно/.test(q) &&
      q.split(/\s+/).length > 2) {
    return null;
  }
  return out;
}

/* ---------- План ответа: то, что раньше не строилось вовсе ---------- */
function tutorPlan(q, intent) {
  const low = q.toLowerCase().replace(/ё/g, 'е');
  const hasHanzi = /[\u3400-\u9fff]/.test(q);
  const isQuestion = /\?|^\s*(как|что|где|когда|почему|зачем|сколько|какой|какая|можно ли|нужно ли|в чём|чем)\b/.test(low);
  let kind = 'answer';
  if (intent === 'simpler' || intent === 'example' || intent === 'more' || intent === 'repeat' ||
      intent === 'wrong' || intent === 'dontknow' || intent === 'enough' || intent === 'why' ||
      intent === 'continue' || intent === 'audio') kind = 'followup';
  if (intent === 'dialogue') kind = 'dialogue-start';
  if (hasHanzi && !isQuestion && intent === null) kind = 'parse';
  const steps = [];
  if (kind === 'followup') steps.push('вспомнить', 'углубить');
  else if (kind === 'parse') steps.push('разобрать', 'добавить правило');
  else steps.push('понять', 'найти', 'собрать', 'проверить');
  return {
    kind, intent, hasHanzi, isQuestion, low, q, steps,
    /* на чём основан ответ: курс, правило, прогресс или память */
    basis: kind === 'followup' ? 'memory' : (hasHanzi ? 'course' : 'course')
  };
}

/* ---------- Проверка собственного ответа ----------
   Три вещи, за которые ученик раньше получал пустоту: иероглиф без
   пиньиня, пустой ответ и ответ «не по теме» на вопрос о прогрессе. */
function tutorSelfCheck(reply, plan) {
  if (!reply || !reply.html) return reply;
  let html = reply.html;
  /* 1. Каждый иероглиф в ответе должен читаться: если рядом нет
        латинского пиньиня, добавляем транскрипцию под фразой. */
  if (/[\u3400-\u9fff]/.test(html) && !/[a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/.test(html.replace(/<[^>]+>/g, ''))) {
    const han = (html.match(/[\u3400-\u9fff]{2,}/g) || [])[0];
    if (han) html += `<div class="tw-py">${esc(pinyinOf(han))}</div>`;
  }
  return { ...reply, html };
}

/* ---------- Исполнитель шага «углубить»: «а попроще?», «а пример?» ---------- */
function tutorFollowup(plan) {
  const intent = plan.intent;
  const M = TUTOR_MEMORY;

  /* «хватит / понятно» — закрываем тему по-человечески */
  if (intent === 'enough') {
    const openHw = typeof hwOpenCount === 'function' ? hwOpenCount() : 0;
    return {
      html: 'Отлично! Если захотите закрепить — вот два коротких шага:<br>' +
        '• <a href="#/practice">Практика</a> — 6 заданий без набора иероглифов<br>' +
        '• <a href="#/cards">Карточки</a> — повторение слов, где вы ошибались' +
        (openHw ? `<br>• <a href="#/homework">Домашки</a> к сдаче: <b>${openHw}</b>` : ''),
      speak: ''
    };
  }

  /* «не знаю / забыл» после теста — даём ответ и разбор, а не новый тест */
  if (intent === 'dontknow' && M.quiz) {
    const t = M.quiz.target;
    M.quiz = null;
    return {
      html: `Правильный ответ — <b>${esc(t.r)}</b>.<br>` + tutorCardHtml(t) +
        `<div class="tw-note">Слово уйдёт в повторение. Попробуйте ещё вопрос: <b>проверь меня</b>.</div>`,
      speak: t.h
    };
  }

  /* «я ошибся» после теста — объясняем разницу между своим выбором и верным */
  if (intent === 'wrong' && M.quiz) {
    const target = M.quiz.target;
    const wrong = (M.quiz.opts || []).find(o => o.h !== target.h);
    let html = `Ничего страшного — на ошибках и учимся.<br>Правильно: <b>${esc(target.r)}</b>`;
    html += tutorCardHtml(target);
    if (wrong) {
      html += `<div class="tw-note">Ваш вариант — <b>${esc(wrong.r)}</b>. Это ${wrong.r === target.r ? 'то же слово' : 'другое слово'}, ` +
        `поэтому и чтение другое. Сравните: <b>${esc(target.h)}</b> (${esc(target.p)}) и <b>${esc(wrong.h)}</b> (${esc(wrong.p)}).</div>`;
    }
    M.quiz = null;
    return { html, speak: target.h };
  }

  /* «а пример?» */
  if (intent === 'example') {
    const w = M.words[0];
    const rule = M.lastKind === 'word' ? null : M.rule;
    if (rule) {
      const ex = rule.ex || {};
      return {
        html: `Пример к правилу «${esc(rule.title)}»:<br>` +
          `<b class="zh" style="font-size:20px">${ruby(ex.h || '')}</b>` +
          `<div class="tw-py">${esc(ex.p || '')}</div>` +
          `<div class="tw-ru">${esc(ex.r || '')}</div>` +
          `<div class="tw-note">Скажите «попроще» — перескажу правило без терминов.</div>`,
        speak: ex.h || ''
      };
    }
    if (w) {
      const sentence = tutorExampleSentence(w);
      if (sentence) return sentence;
    }
    return {
      html: 'Уточните, к чему нужен пример: назовите слово, правило или фразу — и я соберу пример с пиньинем и переводом.'
    };
  }

  /* «попроще» */
  if (intent === 'simpler') {
    /* «объясни по-человечески 了» приходит сюда как «попроще», хотя
       правило назвали прямо в вопросе. Раньше в такой ситуации
       отвечало случайное слово из памяти (学 от прошлого вопроса),
       поэтому: сначала правило из самого вопроса, потом память. */
    const asked = String(plan.q || '').toLowerCase().replace(/ё/g, 'е');
    /* Правило ищем по самому вопросу без иероглифов: «объясни
       по-человечески 了» — про 了, хотя ключевые слова 学 там нет. */
    const askedRule = tutorMatchRule(asked.replace(/[\u3400-\u9fff]/g, ' ')) ||
      (/([\u3400-\u9fff])/.test(asked) ? tutorMatchRule(asked) : null);
    /* Если правило названо прямо в вопросе — оно главнее и памяти
       о прошлом слове (иначе «M.lastKind === 'word'» его отменял). */
    const rule = askedRule || (M.lastKind === 'word' ? null : M.rule);
    if (rule && rule.simple) {
      return {
        html: `<b>${esc(rule.title)}</b> — совсем просто:<br>${rule.simple}` +
          (rule.ex ? `<div class="tw-card"><b class="zh" style="font-size:20px">${ruby(rule.ex.h)}</b>` +
            `<div class="tw-py">${esc(rule.ex.p || '')}</div><div class="tw-ru">${esc(rule.ex.r || '')}</div></div>` : '') +
          `<div class="tw-note">Скажите «а пример?», если нужно ещё одно предложение.</div>`,
        speak: rule.ex ? rule.ex.h : ''
      };
    }
    /* Слово из памяти подходит, только если его спросили именно сейчас:
       иначе на «объясни по-человечески 了» приходило 学 из прошлого
       разговора — формально ответ, по сути не по теме. */
    const askedWord = tutorFindWords(asked, 1).find(x => M.words.some(m => m.h === x.h));
    const w = askedWord || (M.lastKind === 'word' ? M.words[0] : null);
    if (w) {
      return {
        html: `<b>${esc(w.h)}</b> (${esc(w.p)}) — это <b>${esc(w.r)}</b>.<br>` +
          `Читается как «${esc(w.p)}», в предложении работает как обычное слово.` +
          tutorCardHtml(w),
        speak: w.h
      };
    }
    if (M.lesson) {
      const L = LESSONS[M.lesson];
      if (L) {
        return {
          html: `Проще всего — от урока: «${esc(L.title)}».<br>` +
            `Главное в нём: ${(L.goals || []).slice(0, 2).map(g => esc(g)).join('; ')}.<br>` +
            `<a href="#/lesson/${M.lesson}">Открыть урок →</a>`,
          speak: ''
        };
      }
    }
    return { html: 'Что именно объяснить проще? Назовите правило или слово — перескажу без терминов.' };
  }

  /* «повтори» */
  if (intent === 'repeat' || intent === 'more') {
    /* Если только что разбирали слово, повторяем слово, а не правило
       из более раннего разговора. */
    const rule = M.lastKind === 'word' && intent === 'repeat' ? null : M.rule;
    if (rule && intent === 'more' && rule.more) {
      return { html: `<b>${esc(rule.title)} — подробнее</b><br><br>${rule.more}`, speak: (rule.ex && rule.ex.h) || '' };
    }
    if (rule) {
      return {
        html: `<b>${esc(rule.title)}</b><br><br>${rule.body}` +
          (rule.ex ? `<div class="tw-card"><b class="zh" style="font-size:20px">${ruby(rule.ex.h)}</b>` +
            `<div class="tw-py">${esc(rule.ex.p || '')}</div><div class="tw-ru">${esc(rule.ex.r || '')}</div></div>` : ''),
        speak: rule.ex ? rule.ex.h : ''
      };
    }
    const w = M.words[0];
    if (w) return { html: tutorCardHtml(w) + `<div class="tw-note">Ещё раз: <b>${esc(w.h)}</b> читается «${esc(w.p)}», значит «${esc(w.r)}».</div>`, speak: w.h };
    if (M.asked.length) {
      const last = M.asked[M.asked.length - 1];
      const core = tutorSelfCheck(tutorAnswerCore(last), { q: last, hasHanzi: /[\u3400-\u9fff]/.test(last) });
      return { html: `<div class="tw-py">Повторяю: ${esc(last)}</div>` + core.html, speak: core.speak || '' };
    }
    return { html: 'Что повторить? Я помню последнее правило, слово или тест — скажите, и проговорю ещё раз.' };
  }

  /* «почему так?» */
  if (intent === 'why') {
    const rule = M.rule;
    if (rule) return { html: `<b>Почему так:</b> ${rule.why || rule.body}`, speak: rule.ex ? rule.ex.h : '' };
    const w = M.words[0];
    if (w) {
      const L = w.lesson && Object.values(LESSONS).find(l => l.title === w.lesson);
      return {
        html: `Слово <b>${esc(w.h)}</b> (${esc(w.p)}) — «${esc(w.r)}».` +
          (L ? `<br>Оно встречается в уроке «${esc(L.title)}»: там же разобраны похожие слова.` : '') +
          `<div class="tw-note">Если нужна этимология иероглифа — такое в курсе не разбирается, я не буду выдумывать.</div>`
      };
    }
    return { html: 'Уточните, про что «почему»: про правило, слово или ваш ответ в тесте.' };
  }

  /* «как звучит?» */
  if (intent === 'audio') {
    const w = M.words[0];
    if (w) return { html: `Вот как звучит <b>${esc(w.h)}</b> — ${esc(w.p)}:<br>` + tutorCardHtml(w), speak: w.h };
    if (M.rule && M.rule.ex) return { html: `Пример правила звучит так: ${esc(M.rule.ex.h)}`, speak: M.rule.ex.h };
    return { html: 'Что озвучить? Напишите слово или фразу.' };
  }

  /* «да / продолжай» */
  if (intent === 'continue') {
    if (M.quiz) return tutorQuizReply();
    if (M.rule && M.rule.ex) {
      return {
        html: `Хорошо, идём дальше. Ещё один пример к правилу:<br>` +
          `<b class="zh" style="font-size:19px">${ruby(M.rule.ex.h)}</b>` +
          `<div class="tw-py">${esc(M.rule.ex.p || '')}</div><div class="tw-ru">${esc(M.rule.ex.r || '')}</div>` +
          `<br>Проверим себя? <b>проверь меня</b> — 4 варианта, без набора иероглифов.`
      };
    }
    return tutorAdviceReply();
  }

  return null;
}

/* Пример-предложение для слова, собранный из знаний курса (без выдумок) */
function tutorExampleSentence(w) {
  if (!w || !w.h) return null;
  const lex = TUTOR_LEX.all();
  /* ищем готовую фразу курса, где это слово уже встречается */
  const phrase = lex.find(x => x.h && x.h.length > w.h.length && x.h.includes(w.h) && x.p);
  if (phrase) {
    return {
      html: `Пример со словом <b>${esc(w.h)}</b>:<br>` +
        `<b class="zh" style="font-size:20px">${ruby(phrase.h)}</b>` +
        `<div class="tw-py">${esc(phrase.p)}</div><div class="tw-ru">${esc(phrase.r)}</div>`,
      speak: phrase.h
    };
  }
  return null;
}

/* ---------- Диалог, который слушает ---------- */
const TUTOR_DIALOGUE = {
  started: false,
  name: '',
  drink: '',        // чай или кофе — что выбрал ученик
  steps: 0,
  askedName: false,
  askedDrink: false,
  finished: false
};

function tutorDialogueTurn(raw) {
  const q = String(raw || '').trim();
  const low = q.toLowerCase().replace(/ё/g, 'е');
  const D = TUTOR_DIALOGUE;
  D.steps += 1;

  /* имя: «меня зовут Али», «我叫阿里», «Али» */
  const nameRu = q.match(/(?:меня зовут|моё имя|мое имя|я)\s+([A-Za-zА-Яа-яЁё-]{2,20})/i);
  const nameHan = q.match(/我叫([\u3400-\u9fff]{1,4})/);
  if (!D.name && (nameRu || nameHan)) {
    D.name = nameHan ? nameHan[1] : nameRu[1];
    if (nameHan) {
      return {
        html: `Отлично, <b>${esc(D.name)}</b>! Имя записал.<br>Читается «<span class="tw-py">Wǒ jiào ${esc(pinyinOf(D.name))}</span>».<br><br>` +
          `Теперь мой вопрос:<br><b class="zh" style="font-size:19px">${ruby('你喝茶还是咖啡？')}</b><br>` +
          `<span class="tw-py">Nǐ hē chá háishi kāfēi?</span><br>— Ты пьёшь чай или кофе?<br>` +
          `<i>Можно ответить по-русски: «чай» или «кофе».</i>`,
        speak: '你喝茶还是咖啡？'
      };
    }
    D.askedName = true;
    return {
      html: `Приятно познакомиться, <b>${esc(D.name)}</b>!<br><br>` +
        `Теперь мой вопрос:<br><b class="zh" style="font-size:19px">${ruby('你喝茶还是咖啡？')}</b><br>` +
        `<span class="tw-py">Nǐ hē chá háishi kāfēi?</span><br>— Ты пьёшь чай или кофе?`,
      speak: '你喝茶还是咖啡？'
    };
  }

  /* выбор напитка */
  if (/чай|茶|cha\b|чa/.test(low) && !/кофе|咖啡/.test(low)) {
    D.drink = 'tea';
    return {
      html: `Чай — хороший выбор, <b>茶 (chá)</b>!<br>` +
        `<b class="zh" style="font-size:19px">${ruby('我也喜欢喝茶。')}</b><br>` +
        `<span class="tw-py">Wǒ yě xǐhuan hē chá.</span><br>— Я тоже люблю чай.` +
        (D.steps >= 3 ? '' : `<br><br>Продолжим: <b>你从哪里来？</b> — «Откуда ты?»<br><i>Скажите, например: «из Душанбе».</i>`),
      speak: '我也喜欢喝茶。'
    };
  }
  if (/кофе|咖啡|kafei|coffee/.test(low)) {
    D.drink = 'coffee';
    return {
      html: `Кофе — тоже хорошо, <b>咖啡 (kāfēi)</b>!<br>` +
        `<b class="zh" style="font-size:19px">${ruby('我喜欢喝咖啡。')}</b><br>` +
        `<span class="tw-py">Wǒ xǐhuan hē kāfēi.</span><br>— Я люблю кофе.` +
        (D.steps >= 3 ? '' : `<br><br>Продолжим: <b>你从哪里来？</b> — «Откуда ты?»<br><i>Скажите, например: «из Душанбе».</i>`),
      speak: '我喜欢喝咖啡。'
    };
  }

  /* откуда родом */
  const from = q.match(/(?:из|откуда)\s+([A-Za-zА-Яа-яЁё-]{3,24})/i);
  if (from || /душанбе|таджикистан/.test(low)) {
    const place = from ? from[1] : 'Душанбе';
    return {
      html: `Здорово, <b>${esc(place)}</b>!<br>` +
        `<b class="zh" style="font-size:19px">${ruby('欢迎你！')}</b><br>` +
        `<span class="tw-py">Huānyíng nǐ!</span><br>— Добро пожаловать!<br><br>` +
        `Диалог получился${D.name ? `, <b>${esc(D.name)}</b>` : ''}: ты представился${D.drink === 'tea' ? ', выбрал <b>чай</b>' : D.drink === 'coffee' ? ', выбрал <b>кофе</b>' : ''} и рассказал, откуда ты. ` +
        `<b>你中文说得很好！</b> (Nǐ Zhōngwén shuō de hěn hǎo!) — Ты хорошо говоришь по-китайски!`,
      speak: '欢迎你！'
    };
  }

  /* ответ не по сценарию, но осмысленный — не выдумываем, а помогаем */
  if (D.steps >= 4) return finishDialogue();
  if (!D.name) {
    return {
      html: `Давай знакомиться по шагам. Ответь на мой вопрос:<br>` +
        `<b class="zh" style="font-size:19px">${ruby('你叫什么名字？')}</b><br>` +
        `<span class="tw-py">Nǐ jiào shénme míngzi?</span><br>— Как тебя зовут?<br>` +
        `<i>Подойдёт и по-русски: «меня зовут Али».</i>`,
      speak: '你叫什么名字？'
    };
  }
  return {
    html: `Хорошо! Продолжаем: <b class="zh">${ruby('你喝茶还是咖啡？')}</b><br>` +
      `<span class="tw-py">Nǐ hē chá háishi kāfēi?</span><br>— Ты пьёшь чай или кофе?<br>` +
      `<div class="tw-note">Скажите «хватит», чтобы закончить диалог и вернуться к вопросам.</div>`,
    speak: '你喝茶还是咖啡？'
  };
}

function finishDialogue() {
  TUTOR_DIALOGUE.finished = true;
  tutorContext.mode = 'chat';
  return {
    html: `Диалог закончен — получилось хорошо! 👏<br>` +
      `<b class="zh" style="font-size:19px">${ruby('你中文说得很好！继续加油！')}</b><br>` +
      `<span class="tw-py">Nǐ Zhōngwén shuō de hěn hǎo! Jìxù jiāyóu!</span><br>` +
      `— Ты хорошо говоришь по-китайски! Так держать!<br><br>` +
      `Можно закрепить: <a href="#/practice">Практика</a> или <b>проверь меня</b>.`,
    speak: '你中文说得很好！继续加油！'
  };
}

/* ---------- Главный вход: план → шаги → проверка → память ---------- */
function tutorReplyLocal(raw) {
  const q = String(raw || '').trim();
  const low = q.toLowerCase().replace(/ё/g, 'е');
  const intent = tutorIntent(low);
  const plan = tutorPlan(q, intent);

  /* «проверь мой ответ …» — отдельный сценарий, а не мини-тест */
  if (/^проверь (мой ответ|меня:)/.test(low) || /^(проверь|правильно ли)[^?]*[\u3400-\u9fff]/.test(q)) {
    TUTOR_MEMORY.turns += 1;
    tutorRemember('question', q);
    return tutorSelfCheck(tutorCheckAnswer(q), plan);
  }

  /* диалог и запуск диалога — отдельная ветка */
  if (intent === 'dialogue') {
    tutorContext.mode = 'dialogue';
    Object.assign(TUTOR_DIALOGUE, { step: 1, steps: 0, askedName: false, askedDrink: false, finished: false });
    TUTOR_DIALOGUE.name = TUTOR_DIALOGUE.name || '';
    TUTOR_MEMORY.turns += 1;
    const first = TUTOR_DIALOGUE.name
      ? { html: `Продолжим тренировку, <b>${esc(TUTOR_DIALOGUE.name)}</b>.` }
      : null;
    const turn = {
      html: (first ? first.html : 'Отлично, потренируем диалог. Я начинаю:') + '<br><br>' +
        `<b class="zh" style="font-size:19px">${ruby('你好！你叫什么名字？')}</b><br>` +
        `<span class="tw-py">Nǐ hǎo! Nǐ jiào shénme míngzi?</span><br>— Привет! Как тебя зовут?<br><br>` +
        `<i>Ответьте по-китайски (我叫阿里) или по-русски («меня зовут Али»). Скажите «хватит» — закончим.</i>`,
      speak: '你好！你叫什么名字？'
    };
    return tutorSelfCheck(turn, plan);
  }
  if (tutorContext.mode === 'dialogue') {
    /* выход из диалога по «хватит» */
    if (intent === 'enough') return finishDialogue();
    if (intent === 'simpler' || intent === 'repeat' || intent === 'example' ||
        /что значит|переведи|как сказать|объясн|проверь|разбери|что такое/.test(low)) {
      /* это не реплика диалога, а обычный вопрос — выходим из режима */
      tutorContext.mode = 'chat';
    } else {
      const turn = tutorDialogueTurn(q);
      if (turn) { TUTOR_MEMORY.turns += 1; return tutorSelfCheck(turn, plan); }
    }
  }

  /* продолжение разговора: «а пример?», «попроще», «повтори», «я ошибся» */
  if (plan.kind === 'followup') {
    const fu = tutorFollowup(plan);
    if (fu) {
      TUTOR_MEMORY.turns += 1;
      return tutorSelfCheck(fu, plan);
    }
    /* нечего углублять — отвечаем по существу, но говорим об этом мягко */
  }

  /* обычный ответ по знаниям курса */
  const reply = tutorAnswerCore(q);

  /* --- обновляем память по тому, что реально произошло --- */
  TUTOR_MEMORY.turns += 1;
  if (reply && reply.quiz) {
    tutorRemember('quiz', { target: reply.quiz.target, opts: reply.quiz.opts });
  } else if (TUTOR_MEMORY.quiz && /тест|проверь/.test(low) === false) {
    /* после ответа на тест память о нём не нужна */
  }
  const wordsInReply = tutorFindWords(q, 3);
  if (wordsInReply.length) tutorRemember('words', wordsInReply);
  if (/[\u3400-\u9fff]{2,}/.test(q)) {
    const han = (q.match(/[\u3400-\u9fff]+/g) || []).join('');
    const parsed = tutorSegment(han);
    if (parsed.length) tutorRemember('words', parsed);
    /* запоминаем урок, если слово из курса */
    const known = parsed.find(w => w.lesson);
    if (known) tutorRemember('lesson', null);
  }
  const rule = tutorMatchRule(low);
  if (rule && /объясн|правил|разниц|почему|зачем|когда|тоны|частиц/.test(low)) tutorRemember('rule', rule);
  if (/урок|план|прогресс|повторить/.test(low)) tutorRemember('lesson', nextLesson());
  tutorRemember('question', q);

  return tutorSelfCheck(reply, plan);
}

/* ============================================================
   ОТВЕТ ИЗ ВНЕШНИХ ИСТОЧНИКОВ
   Сервер умеет искать слово в CC-CEDICT, Викисловаре и Tatoeba.
   Здесь мы превращаем это в ответ с честными пометками: что найдено,
   где именно и куда пойти почитать. Если сеть закрыта — остаётся
   локальный словарь курса, и это не выглядит как ошибка.
   ============================================================ */
function tutorSourceLinks(sources) {
  const links = ((sources && sources.links) || []).filter(l => l && l.url);
  if (!links.length) return '';
  const uniq = [];
  links.forEach(l => { if (!uniq.some(x => x.url === l.url)) uniq.push(l); });
  return `<div class="t-links">Источники: ` +
    uniq.slice(0, 3).map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)} ↗</a>`).join(' · ') +
    `</div>`;
}

/* Ссылки «где проверить» можно дать даже офлайн: они ведут на известные
   словари, а не требуют запроса с нашего сервера. Это и есть «пойти
   почитать в книге»: ученик видит, куда смотреть. */
const TUTOR_DICT_LINKS = [
  { id: 'mdbg', title: 'CC-CEDICT / MDBG', zh: 'https://www.mdbg.net/chinese/dictionary?page=worddict&wdrst=0&wdqb=',
    ru: null, why: 'самый полный свободный словарь: значение, чтение, примеры' },
  { id: 'wkzh', title: 'Викисловарь (кит.)', zh: 'https://zh.wiktionary.org/wiki/',
    ru: null, why: 'состав иероглифа, радикалы, этимология' },
  { id: 'wkru', title: 'Викисловарь (рус.)', zh: 'https://ru.wiktionary.org/wiki/',
    ru: null, why: 'толкование по-русски и примеры употребления' },
  { id: 'tatoeba', title: 'Tatoeba', zh: 'https://tatoeba.org/en/sentences/search?query=',
    ru: null, why: 'живые предложения с переводом на русский' },
  { id: 'pinyin', title: 'Пиньинь и тоны', zh: null, ru: 'https://www.zdic.net/hans/',
    why: 'чтение и порядок черт в словаре 汉典' }
];

function tutorDictLinks(word) {
  const w = String(word || '').trim();
  if (!w) return [];
  return TUTOR_DICT_LINKS.filter(d => d.zh || d.ru).map(d => ({
    title: d.title,
    url: (d.zh || d.ru) + (d.zh ? encodeURIComponent(w) : ''),
    why: d.why
  }));
}

function tutorSourcesReply(payload, question) {
  const S = (payload && payload.sources) || {};
  const notes = (S.notes || []).filter(n => n && n.text);
  const links = (S.links || []).filter(l => l && l.url);
  if (!notes.length) return null;

  const used = (S.used || []).filter(Boolean);
  let html = `<div class="t-src-badge">🌐 ${esc(used.length ? used.join(' · ') : 'словари')}</div>`;
  html += `<div class="tw-py" style="margin:0 0 8px">По запросу «${esc(question)}»:</div>`;
  notes.slice(0, 4).forEach(n => {
    const src = n.source ? `<span class="tw-src">${esc(n.source)}</span>` : '';
    html += `<div class="tw-card tw-src-card"><div class="tw-ru">${esc(n.text)}</div>${src}</div>`;
  });
  if (links.length) {
    const uniq = [];
    links.forEach(l => { if (!uniq.some(x => x.url === l.url)) uniq.push(l); });
    html += `<div class="t-links">Где почитать: ` +
      uniq.slice(0, 4).map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)} ↗</a>`).join(' · ') +
      `</div>`;
  }
  html += `<div class="tw-note">Это данные словарей, а не курс: в уроках другое чтение или другой оттенок — уточните у учителя.</div>`;

  /* Озвучить можно первое найденное китайское слово */
  const han = (notes.map(n => (n.text.match(/[\u3400-\u9fff]{1,8}/) || [''])[0]).find(Boolean)) || '';
  return { html, speak: han, fromSources: true };
}

/* Что серверный ИИ должен знать про ученика, чтобы отвечать по делу */
function tutorServerContext() {
  const L = tutorLearner();
  const parts = [
    `Пройдено уроков: ${L.doneCount}/${L.total}`,
    `точность: ${L.acc}%`,
    `серия: ${L.streak} дн.`,
    L.current ? `сейчас на уроке «${(LESSONS[L.current] || {}).title || L.current}»` : '',
    L.due ? `к повторению карточек: ${L.due}` : '',
    L.weak.length ? `слабые слова: ${L.weak.slice(0, 4).map(w => w.h + ' (' + w.p + ') ' + w.r).join('; ')}` : '',
    TUTOR_MEMORY.rule ? `только что объясняли: ${TUTOR_MEMORY.rule.title}` : '',
    TUTOR_MEMORY.words.length ? `разбирали слова: ${TUTOR_MEMORY.words.slice(0, 4).map(w => w.h).join(', ')}` : '',
    TUTOR_MEMORY.lastTopic ? `тема разговора: ${TUTOR_MEMORY.lastTopic}` : ''
  ].filter(Boolean);
  return parts.join('; ').slice(0, 400);
}

function renderTutor(root) {
  const wrap = el('div', 'tutor-wrap');
  wrap.appendChild(el('h1', 'page-title', '🤖 ИИ-репетитор Сяо Мин (小明)'));
  wrap.appendChild(el('p', 'page-sub', 'Понимает вопрос своими словами, помнит, о чём вы говорили, и доводит объяснение до конца: «попроще», «а пример?», «я ошибся» — всё это он понимает.'));

  const chips = el('div', 't-chips');
  [
    ['🔎 Разбери фразу', 'разбери 我想喝茶'],
    ['🔍 Как сказать «спасибо»?', 'как сказать спасибо'],
    ['📖 Частица 了', 'объясни частицу 了'],
    ['⚖️ Разница 不 и 没', 'в чём разница между 不 и 没'],
    ['🎵 Тоны', 'объясни тоны'],
    ['🛣 Как спросить дорогу', 'как спросить дорогу'],
    ['💬 Диалог', 'давай поговорим'],
    ['🎯 Что повторить', 'что мне повторить сейчас'],
    ['🎲 Проверь меня', 'проверь меня тестом'],
    ['🧠 Проверь мой ответ', 'проверь мой ответ'],
    ['🌐 Поиск в словарях', 'найди в словарях 身份证']
  ].forEach(([label, query]) => {
    const b = el('button', 'btn btn-sm btn-ghost', label);
    b.onclick = () => sendMsg(query);
    chips.appendChild(b);
  });
  wrap.appendChild(chips);

  const box = el('div', 'panel tutor-box');
  const feed = el('div', 'tutor-feed');
  box.appendChild(feed);

  /* История чата живёт вне страницы. Раньше вход в аккаунт (Auth.boot
     завершается позже первого экрана) перерисовывал страницу и стирал
     весь разговор: ученик видел свой вопрос без ответа. */
  if (!tutorHistory.length && tutorHistoryRestored.length) {
    tutorHistory.push(...tutorHistoryRestored);
    tutorHistoryRestored = [];
  }
  if (!tutorHistory.length) {
    tutorHistory.push({
      role: 'assistant',
      html: ruby('你好') + '! Я <b>Сяо Мин (小明)</b> — ваш помощник по китайскому. Спросите перевод, грамматику или нажмите подсказку выше.',
      speak: '你好！我是小明。'
    });
  }

  function paintFeed() {
    feed.innerHTML = '';
    tutorHistory.forEach(m => {
      const row = el('div', 't-msg ' + (m.role === 'user' ? 't-user' : 't-bot'));
      const bubble = el('div', 't-bubble', m.html || esc(m.content || ''));
      if (m.speak) {
        const sp = el('div', 't-sp', `${toneBtn(m.speak, 'speak sm')} <span>прослушать</span>`);
        bubble.appendChild(sp);
      }
      if (m.quiz) {
        const qz = el('div', 't-quiz');
        m.quiz.opts.forEach(opt => {
          const ob = el('button', 'btn btn-sm btn-ghost', opt.r);
          ob.onclick = () => {
            if (qz.dataset.done) return;
            qz.dataset.done = '1';
            const ok = opt.h === m.quiz.target.h;
            ob.classList.remove('btn-ghost');
            ob.classList.add(ok ? 'btn-primary' : 'btn-danger');
            playSfx(ok ? 'ok' : 'bad');
            toast(ok ? 'Верно! 🎉' : `Правильно: ${m.quiz.target.r}`);
          };
          qz.appendChild(ob);
        });
        bubble.appendChild(qz);
      }
      row.appendChild(bubble);
      feed.appendChild(row);
    });
    feed.scrollTop = feed.scrollHeight;
  }

  const form = el('form', 'tutor-form');
  const inp = el('input', 't-input');
  inp.placeholder = 'Спросите своими словами: «как сказать спасибо», «объясни 了», «разбери 我想喝茶», «попроще»';
  const send = el('button', 'btn btn-primary', 'Отправить →');
  send.type = 'submit';
  form.appendChild(inp); form.appendChild(send);
  box.appendChild(form);
  wrap.appendChild(box);
  root.appendChild(wrap);

  async function sendMsg(text) {
    const q = (text || '').trim();
    if (!q) return;
    tutorHistory.push({ role: 'user', content: q });
    paintFeed();
    send.disabled = true;

    /* Пока ждём ответ, показываем, что помощник работает:
       иначе на медленном соединении чат выглядит «мёртвым». */
    const thinking = el('div', 't-msg t-bot');
    thinking.appendChild(el('div', 't-bubble t-thinking', 'Сяо Мин думает<span class="t-dots"><i></i><i></i><i></i></span>'));
    feed.appendChild(thinking);
    feed.scrollTop = feed.scrollHeight;

    /* Сначала спрашиваем встроенный движок: он понимает вопрос целиком
       («сколько учить», «как заказать столик»). Если он уверен — его ответ
       и показываем, а сервер нужен только за ссылками на источники.
       Раньше сервер шёл первым, и найденное слово 中文 перебивало готовый
       ответ на вопрос — ученик видел «中文 — китайский язык» вместо ответа. */
    const localReply = tutorReplyLocal(q);
    const localSure = !/не уверен, что понял|^\s*$/i.test(
      String(localReply.html || '').replace(/<[^>]+>/g, ' ').trim());

    let replyObj = null;
    if (window.Auth && Auth.online) {
      try {
        const res = await fetch('/api/tutor/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: q,
            history: tutorHistory.slice(-8).map(x => ({ role: x.role, content: x.content || '' })),
            context: tutorServerContext(),
            /* Слово для поиска в словарях: иероглифы из вопроса сервер
               поймёт сам, но так он ищет точнее и не тратит сеть зря. */
            word: (q.match(/[\u3400-\u9fff]{1,8}/) || [''])[0]
          })
        });
        const d = await res.json();
        if (d && d.mode === 'ai' && d.reply) {
          const text = esc(d.reply).replace(/\n/g, '<br>');
          replyObj = {
            html: text.replace(/([\u3400-\u9fff]+)/g, (m) => ruby(m)) + tutorSourceLinks(d.sources),
            speak: (d.reply.match(/[\u3400-\u9fff]{2,}/) || [''])[0]
          };
        } else if (d && d.mode === 'sources') {
          if (localSure) {
            /* Движок ответил по существу — не заслоняем его словарём,
               но добавляем ссылки: ученик видит, где проверить. */
            replyObj = { ...localReply, html: localReply.html + tutorSourceLinks(d.sources) };
          } else {
            /* Ответить по существу нечем, а словари слово знают —
               показываем их, а не «извините, я не знаю». */
            replyObj = tutorSourcesReply(d, q);
          }
        }
      } catch (e) { }
    }
    if (!replyObj) replyObj = localReply;
    /* В историю для серверного ИИ кладём чистый текст ответа,
       а не HTML и не вопрос ученика (раньше модель видела кашу). */
    const plainReply = String(replyObj.html || replyObj.content || '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    tutorHistory.push({ role: 'assistant', content: plainReply, ...replyObj });
    send.disabled = false;
    paintFeed();
    /* Разговор сохраняем: перезагрузка страницы (новая сборка, вход)
       не должна стирать то, что ученик только что спросил. */
    try {
      localStorage.setItem('tutorChat', JSON.stringify(
        tutorHistory.slice(-40).map(m => ({ role: m.role, content: m.content || '', html: m.html || '', speak: m.speak || '' }))));
    } catch (e) { }
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    const val = inp.value;
    inp.value = '';
    sendMsg(val);
  };
  paintFeed();
}

/* ============================================================
   ЗАПУСК
   ============================================================ */
function initNav() {
  const nav = $('#nav');
  const mnav = $('#mnav');
  const items = [
    ['home', '🏠', 'Главная'],
    ['plan', '📚', 'Уроки'],
    ['diag', '🎯', 'Уровень'],
    ['cards', '🗂️', 'Карточки'],
    ['videos', '🎬', 'Видео'],
    ['tutor', '🤖', 'ИИ-агент'],
    ['tones', '🎵', 'Тоны'],
    ['write', '✍️', 'Пропись'],
    ['read', '📄', 'Чтение'],
    ['phrases', '💬', 'Фразы'],
    ['dict', '🔎', 'Словарь'],
    ['homework', '🏠', 'Домашки'],
    ['stats', '📊', 'Статистика'],
    ['class', '👨‍🏫', 'Класс'],
    ['account', '👤', 'Профиль']
  ];
  /* нижнее мобильное меню — только ключевые разделы, остальное с главной */
  const mItems = [
    ['home', '🏠', 'Главная'],
    ['plan', '📚', 'Уроки'],
    ['cards', '🗂️', 'Карточки'],
    ['homework', '🏠', 'Домашки'],
    ['videos', '🎬', 'Видео'],
    ['tutor', '🤖', 'ИИ'],
    ['class', '👨‍🏫', 'Класс'],
    ['account', '👤', 'Профиль']
  ];
  items.forEach(([r, ic, t]) => {
    const a = el('a', '', `<span class="ni">${ic}</span><span class="nt">${t}</span>` +
      (r === 'homework' ? '<span class="ni-badge" id="hwBadge"></span>' : ''));
    a.href = `#/${r}`;
    a.dataset.route = r;
    if (r === 'class') a.classList.add('teacher-only');
    nav.appendChild(a);
  });
  mItems.forEach(([r, ic, t]) => {
    const m = el('a', '', `<span class="ni">${ic}</span><span class="nt">${t}</span>`);
    m.href = `#/${r}`;
    m.dataset.route = r;
    if (r === 'class') m.classList.add('teacher-only');
    mnav.appendChild(m);
  });
  const foot = el('div', 'nav-foot');
  foot.id = 'navFoot';
  nav.appendChild(foot);
  paintAccountFoot();
  updateNavRoles();
  refreshHomeworkBadge();

  if (!$('#tutorFab')) {
    const fab = el('a', 'tutor-fab', '🤖');
    fab.id = 'tutorFab';
    fab.href = '#/tutor';
    fab.title = 'ИИ-репетитор Сяо Мин';
    document.body.appendChild(fab);
  }
}
/* Бейдж «домашки ждут проверки» на пункте меню. Счётчик тянем после
   входа и после каждой отправки — тихо, без спиннеров. */
function refreshHomeworkBadge() {
  if (typeof window.hwRefresh !== 'function') return;
  window.hwRefresh().catch(() => {});
}
function updateNavRoles() {
  const can = !!(Auth.user && (Auth.user.role === 'owner' || Auth.user.role === 'teacher'));
  $$('.teacher-only').forEach(a => { a.style.display = can ? 'flex' : 'none'; });
}
function paintAccountFoot() {
  const foot = $('#navFoot');
  if (!foot) return;
  const u = Auth.user;
  foot.innerHTML = '';
  const quick = el('div', 'nav-quick');
  const spd = el('button', 'btn btn-sm btn-ghost', PREFS.slow ? '🐢 0.7×' : '🐇 1.0×');
  spd.title = 'Скорость озвучки';
  spd.onclick = () => { PREFS.slow = !PREFS.slow; toast(PREFS.slow ? 'Медленная озвучка (0.7×)' : 'Обычная озвучка (1.0×)'); paintAccountFoot(); };
  const thm = el('button', 'btn btn-sm btn-ghost', PREFS.theme === 'light' ? '🌙' : '☀️');
  thm.setAttribute('aria-label', PREFS.theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему');
  thm.title = thm.getAttribute('aria-label');
  thm.title = 'Переключить тему';
  thm.onclick = () => { PREFS.theme = PREFS.theme === 'light' ? 'dark' : 'light'; paintAccountFoot(); };
  quick.appendChild(spd); quick.appendChild(thm);

  if (!u) {
    const info = el('div', '', `${Auth.online ? (Auth.hasUsers ? 'Вы не вошли в аккаунт' : '👑 Первый запуск') : 'Локальный режим'}<br><b>${Auth.online ? 'сервер подключён ✓' : 'нет связи с сервером'}</b>`);
    foot.appendChild(info);
    if (Auth.online) {
      const b = el('button', 'btn btn-sm btn-primary', Auth.hasUsers ? '🔑 Войти' : '👑 Стать владельцем');
      b.style.marginTop = '8px';
      b.style.width = '100%';
      b.onclick = () => window.__showAuth();
      foot.appendChild(b);
    }
    foot.appendChild(quick);
    return;
  }
  const ubox = el('div', '', `<div class="nav-user">
      <b>${esc(u.display_name)}</b>
      <span>${esc(Auth.ROLE_RU[u.role] || u.role)} · @${esc(u.username)}</span>
    </div>
    <a class="btn btn-sm btn-ghost" href="#/account">Профиль и синхронизация</a>
    <button class="btn btn-sm btn-ghost" id="logoutBtn" style="margin-top:6px">Выйти</button>`);
  foot.appendChild(ubox);
  foot.appendChild(quick);
  const lo = $('#logoutBtn');
  if (lo) lo.onclick = async () => { await Auth.logout(); window.__guest = false; paintAccountFoot(); updateNavRoles(); location.hash = '#/home'; route(); };
}

/* ---------- Профиль ---------- */
function renderAccount(root) {
  const wrap = el('div');
  const u = Auth.user;
  wrap.appendChild(el('h1', 'page-title', '👤 Профиль'));
  const p = el('div', 'panel');
  if (u) {
    p.appendChild(el('div', 'profile-head', `
      <div class="avatar">${esc(u.display_name.slice(0, 1).toUpperCase())}</div>
      <div>
        <h3 style="margin:0">${esc(u.display_name)}</h3>
        <div class="profile-role">${esc(Auth.ROLE_RU[u.role] || u.role)} · логин <b>@${esc(u.username)}</b></div>
      </div>`));
    const rows = el('div', 'profile-rows');
    rows.appendChild(el('div', 'pr-row', `<span>Статус сервера</span><b class="ok">${Auth.online ? 'подключено ✓' : 'нет соединения'}</b>`));
    rows.appendChild(el('div', 'pr-row', `<span>Прогресс на сервере</span><b>${Auth.user ? 'синхронизируется автоматически' : '—'}</b>`));
    rows.appendChild(el('div', 'pr-row', `<span>Режим</span><b>${window.__guest ? 'локальный (без аккаунта)' : 'аккаунт подключён'}</b>`));
    const bId = (window.Auth && Auth.build) ? Auth.build() : '';
    rows.appendChild(el('div', 'pr-row', `<span>Версия программы</span><b>${esc(bId || '—')}</b>`));
    if (bId && Auth.serverBuild && Auth.serverBuild() && Auth.serverBuild() !== bId) {
      const upd = el('button', 'btn btn-sm btn-primary', '🔄 Есть новая версия — обновить');
      upd.onclick = () => Auth.hardReload();
      rows.appendChild(upd);
    }
    p.appendChild(rows);
    const btnRow = el('div', 'btn-row');
    const sync = el('button', 'btn btn-primary', '⇅ Синхронизировать сейчас');
    sync.onclick = () => { Auth.persist(true); toast('Отправлено на сервер'); };
    const out = el('button', 'btn btn-ghost', '🚪 Выйти из аккаунта');
    out.onclick = async () => { await Auth.logout(); window.__guest = false; paintAccountFoot(); updateNavRoles(); location.hash = '#/home'; route(); };
    btnRow.appendChild(sync); btnRow.appendChild(out);
    p.appendChild(btnRow);
  } else {
    const isFilePreview = (location.protocol !== 'http:' && location.protocol !== 'https:');
    p.appendChild(el('div', 'empty', isFilePreview
      ? 'Открыт автономный просмотр файла (без сервера). Чтобы войти в аккаунт или управлять классом, откройте Live Preview на порту 8080.'
      : 'Вы не вошли в аккаунт. Прогресс хранится только в этом браузере.'));
    const btn = el('button', 'btn btn-primary', '🔑 Войти или зарегистрироваться');
    btn.onclick = () => { window.__showAuth(); };
    p.appendChild(btn);
  }
  wrap.appendChild(p);

  /* Смена пароля. Без неё забытый пароль означал бы потерю аккаунта:
     ученик не мог бы войти, а учитель — помочь. */
  if (u) {
    const pw = el('div', 'panel');
    pw.appendChild(el('h3', '', '🔑 Пароль'));
    pw.appendChild(el('p', 'pw-note', 'Минимум 8 символов. После смены остальные устройства выйдут из аккаунта.'));
    const pform = el('div', 'pw-form');
    const curInp = el('input', 'gap-input');
    const newInp = el('input', 'gap-input');
    const repInp = el('input', 'gap-input');
    [[curInp, 'Текущий пароль', 'current-password'],
     [newInp, 'Новый пароль (мин. 8)', 'new-password'],
     [repInp, 'Повторите новый', 'new-password']].forEach(([inp, ph, ac]) => {
      inp.type = 'password'; inp.placeholder = ph; inp.autocomplete = ac;
      inp.setAttribute('aria-label', ph);
    });
    const go = el('button', 'btn btn-primary', 'Сменить');
    go.onclick = async () => {
      if (newInp.value.length < 8) return toast('Новый пароль — минимум 8 символов');
      if (newInp.value !== repInp.value) return toast('Новые пароли не совпадают');
      if (!curInp.value) return toast('Введите текущий пароль');
      go.disabled = true;
      const label = go.textContent;
      go.textContent = 'Меняем…';
      try {
        await Auth.changePassword(curInp.value, newInp.value);
        curInp.value = newInp.value = repInp.value = '';
        toast('Пароль изменён ✓');
      } catch (e) {
        toast(e.message === 'bad_password' ? 'Текущий пароль указан неверно'
          : e.message === 'weak_password' ? 'Пароль короче 8 символов'
          : 'Не удалось сменить пароль');
      } finally {
        go.disabled = false;
        go.textContent = label;
      }
    };
    pform.append(curInp, newInp, repInp, go);
    pw.appendChild(pform);
    wrap.appendChild(pw);
  }

  if (u && Auth.grade && (Auth.grade.grade || Auth.grade.comment)) {
    const gp = el('div', 'panel grade-panel');
    gp.appendChild(el('h3', '', '🎓 Оценка и отзыв учителя'));
    gp.appendChild(el('div', 'grade-box', `
      ${Auth.grade.grade ? `<div class="grade-num">${esc(Auth.grade.grade)}</div>` : ''}
      <div>${Auth.grade.comment ? esc(Auth.grade.comment) : 'Комментарий пока не добавлен'}</div>`));
    wrap.appendChild(gp);
  }

  /* настройки обучения (работают и на телефоне, и на компьютере) */
  const prefsPanel = el('div', 'panel');
  prefsPanel.appendChild(el('h3', '', '⚙️ Настройки обучения'));
  const pr = el('div', 'btn-row');
  const bSpd = el('button', 'btn btn-ghost', PREFS.slow ? '🐢 Озвучка: медленно (0.7×)' : '🐇 Озвучка: обычно (1.0×)');
  bSpd.onclick = () => { PREFS.slow = !PREFS.slow; paintAccountFoot(); route(); };
  const bThm = el('button', 'btn btn-ghost', PREFS.theme === 'light' ? '🌙 Тема: светлая' : '☀️ Тема: тёмная');
  bThm.onclick = () => { PREFS.theme = PREFS.theme === 'light' ? 'dark' : 'light'; paintAccountFoot(); route(); };
  const bSfx = el('button', 'btn btn-ghost', PREFS.sfx ? '🔔 Звуки эффектов: вкл' : '🔇 Звуки эффектов: выкл');
  bSfx.onclick = () => { PREFS.sfx = !PREFS.sfx; route(); };
  pr.appendChild(bSpd); pr.appendChild(bThm); pr.appendChild(bSfx);
  prefsPanel.appendChild(pr);
  wrap.appendChild(prefsPanel);

  if (Auth.user && (Auth.user.role === 'owner' || Auth.user.role === 'teacher')) {
    const c = el('div', 'panel');
    c.appendChild(el('h3', '', '👨‍🏫 Учительские инструменты'));
    c.appendChild(el('p', 'page-sub', 'Панель класса: сводка по ученикам, выставление оценок, коды-приглашения, экспорт в CSV.'));
    const b = el('a', 'btn btn-primary', 'Открыть панель класса →');
    b.href = '#/class';
    c.appendChild(b);
    wrap.appendChild(c);
  }
  root.appendChild(wrap);
}

/* Сессия истекла: показываем это явно и уводим на экран входа,
   вместо прежнего «тихого» отказа сохранений. */
window.addEventListener('auth:expired', () => {
  window.__guest = false;
  toast('Сессия истекла — войдите снова. Прогресс в браузере сохранён.');
  paintAccountFoot();
  updateNavRoles();
  route();
});

document.addEventListener('DOMContentLoaded', boot);
async function boot() {
  initNav();
  touchDay();

  /* Страховка от «вечного» экрана загрузки: если сеть или сервер отвечают
     слишком долго, показываем приложение в локальном режиме, а не пустоту.
     Данные всё равно подтянутся позже — Auth.boot не отменяется. */
  let booted = false;
  const fallback = setTimeout(() => {
    if (booted || !document.querySelector('#view') || $('#view').innerHTML.trim()) return;
    window.__guest = false;
    showOfflineNotice();
    paintAccountFoot();
    route();
  }, 4000);

  if (window.Auth) {
    try {
      await Promise.race([
        Auth.boot(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12000))
      ]);
    } catch (e) { /* сервер недоступен — работаем локально */ }
  }
  booted = true;
  clearTimeout(fallback);
  if (window.Auth && Auth.online === false) showOfflineNotice();
  maybeFrameBanner();
  paintAccountFoot();
  updateNavRoles();
  route();
  setInterval(touchDay, 60000);
  /* Вернулись на вкладку или в сеть — проверяем, не вышла ли новая сборка. */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.Auth && Auth.checkBuild) Auth.checkBuild();
  });
  window.addEventListener('online', () => {
    if (window.Auth && Auth.checkBuild) Auth.checkBuild();
  });
}

/* Сервер недоступен: честно говорим об этом, а не делаем вид, что всё
   сохранилось. Прогресс при этом остаётся в браузере и уйдёт на сервер,
   когда связь вернётся. */
function showOfflineNotice() {
  if (document.getElementById('offlineBar')) return;
  const bar = el('div', 'frame-banner offline-bar');
  bar.id = 'offlineBar';
  bar.innerHTML = '<span>📴 <b>Нет связи с сервером.</b> Учиться можно — прогресс сохраняется в браузере и отправится на сервер, когда связь вернётся.</span>';
  const x = el('button', 'fb-x', '✕');
  x.setAttribute('aria-label', 'Закрыть уведомление');
  x.onclick = () => bar.remove();
  bar.appendChild(x);
  document.body.prepend(bar);

  window.addEventListener('online', () => {
    const b = document.getElementById('offlineBar');
    if (b) b.remove();
    toast('Связь восстановлена — синхронизируем прогресс');
    if (window.Auth && Auth.boot) Auth.boot().then(() => route()).catch(() => { });
  }, { once: true });
}

/* Если открыт просмотр файла без сервера или iframe с заблокированным localStorage —
   подсказываем пользователю, как войти и сохранить прогресс. */
function maybeFrameBanner() {
  const isFilePreview = (location.protocol !== 'http:' && location.protocol !== 'https:');
  if (isFilePreview) {
    const b = el('div', 'frame-banner');
    b.innerHTML = `<span>📌 Вы открыли просмотр файла <b>index.html</b> (без сети). Чтобы войти в аккаунт и открыть панель класса, переключитесь на панель <b>Live Preview («Chinese Learning App»)</b>.</span>`;
    const close = el('button', 'fb-x', '✕');
    close.setAttribute('aria-label', 'Закрыть подсказку');
    close.onclick = () => b.remove();
    b.appendChild(close);
    document.body.prepend(b);
    return;
  }
  if (!Store.persistent && !(window.Auth && Auth.user)) {
    const b = el('div', 'frame-banner');
    b.innerHTML = `<span>📌 Войдите в аккаунт, чтобы ваш прогресс сохранялся на сервере между сеансами.</span>`;
    const btn = el('button', 'btn btn-sm btn-primary', 'Войти / Регистрация');
    btn.onclick = () => { if (window.__showAuth) window.__showAuth(); b.remove(); };
    b.appendChild(btn);
    const close = el('button', 'fb-x', '✕');
    close.setAttribute('aria-label', 'Закрыть подсказку');
    close.onclick = () => b.remove();
    b.appendChild(close);
    document.body.prepend(b);
  }
}
