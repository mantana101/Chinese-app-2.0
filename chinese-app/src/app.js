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
window.__lessonTitle = (id) => (LESSONS[id] && LESSONS[id].title) || id;

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
  get theme() { return Store.get('zh_theme') === 'light' ? 'light' : 'dark'; },
  set theme(v) {
    Store.set('zh_theme', v === 'light' ? 'light' : 'dark');
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = v === 'light' ? 'light' : '';
  },
  get sfx() { return Store.get('zh_sfx') !== 'off'; },
  set sfx(v) { Store.set('zh_sfx', v ? 'on' : 'off'); }
};
if (typeof document !== 'undefined' && PREFS.theme === 'light') {
  document.documentElement.dataset.theme = 'light';
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
function toneBtn(text, cls = 'speak') {
  return `<button class="${cls}" data-speak="${esc(text)}" title="Прослушать">🔊</button>`;
}
document.addEventListener('click', e => {
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
    const colors = ['#e0b354', '#d0453a', '#5aa88f', '#6a9fd4', '#ffd9d3'];
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
let toastEl;
function toast(msg) {
  if (!toastEl) { toastEl = el('div', 'toast'); document.body.appendChild(toastEl); }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
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
  class: (root) => Auth.renderClass(root),
  account: renderAccount
};
function route() {
  if (typeof videoStop === 'function') videoStop();
  const view = $('#view');
  view.innerHTML = '';
  if (window.Auth && Auth.needsAuth() && !window.__guest) { renderAuthGate(); return; }
  const hash = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, ...rest] = hash.split('/');
  const fn = ROUTES[name] || renderHome;
  view.scrollTop = 0;
  fn(view, rest);
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
window.__afterAuth = () => { window.__guest = false; paintAccountFoot(); updateNavRoles(); route(); };
window.__guestMode = () => { window.__guest = true; route(); };
window.addEventListener('hashchange', route);

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
      <h1>Привет, 同学!</h1>
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

  const grid = el('div', 'card-grid');
  const tiles = [
    { r: 'plan', ic: '📚', t: 'План курса', s: '4 модуля · 15 уроков' },
    { r: 'diag', ic: '🎯', t: 'Определить уровень', s: 'Тест из 50 вопросов' },
    { r: 'cards', ic: '🗂️', t: 'Карточки', s: due ? `${due} к повторению` : 'Все повторены — красавчик!' },
    { r: 'videos', ic: '🎬', t: 'Видео-уроки', s: 'Мини-плеер + YouTube' },
    { r: 'tutor', ic: '🤖', t: 'ИИ-репетитор', s: 'Спросить Сяо Мина' },
    { r: 'tones', ic: '🎵', t: 'Тоны', s: 'Тренажёр 4-го тона' },
    { r: 'write', ic: '✍️', t: 'Пропись', s: 'Иероглифы кистью' },
    { r: 'read', ic: '📄', t: 'Чтение', s: '3 текста с пиньинь' },
    { r: 'phrases', ic: '💬', t: 'Фразы', s: 'Готовые реплики' },
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
function renderLesson(root, args) {
  const id = args[0];
  const l = LESSONS[id];
  if (!l) { root.appendChild(el('div', 'panel', 'Урок не найден')); return; }
  const mod = MODULES.find(m => m.lessons.includes(id));
  touchDay();

  root.appendChild(el('div', 'lesson-head', `
    <div class="lh-badge">${esc(mod.level)} · ${esc(mod.title.split('—')[0].trim())}</div>
    <h1>${esc(l.title)}</h1>
    <p class="lh-sub">${esc(l.subtitle)}</p>`));

  const goals = el('div', 'panel goals');
  goals.appendChild(el('h3', '', '🎯 Цели урока'));
  l.goals.forEach(g => goals.appendChild(el('div', 'goal', `• ${esc(g)}`)));
  root.appendChild(goals);

  /* --- Словарь --- */
  const v = el('div', 'panel');
  v.appendChild(el('div', 'panel-head', `<h3>📖 Новые слова (${l.vocab.length})</h3><button class="btn btn-sm" id="playAll">🔊 Прослушать все</button>`));
  const tbl = el('div', 'vocab');
  l.vocab.forEach(w => {
    const card = el('div', 'vcard', `
      <div class="vc-h">${esc(w.h)}</div>
      <div class="vc-p">${esc(w.p)}</div>
      <div class="vc-r">${esc(w.r)}</div>
      <div class="vc-tools">${toneBtn(w.h, 'speak sm')}<button class="speak sm add-card" data-w="${esc(w.h)}|${esc(w.p)}|${esc(w.r)}" title="В карточки">＋</button></div>`);
    tbl.appendChild(card);
  });
  v.appendChild(tbl);
  root.appendChild(v);

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

  /* --- Практика --- */
  quizState = { lesson: id, idx: 0, correct: 0, answers: [], done: false };
  const qz = el('div', 'panel quiz-panel');
  qz.id = 'quiz';
  qz.appendChild(el('h3', '', '✏️ Практика'));
  qz.appendChild(el('div', 'quiz-host'));
  root.appendChild(qz);
  renderQuestion($('#quiz .quiz-host'));

  /* --- Домашка --- */
  const hw = el('div', 'panel hw');
  hw.appendChild(el('h3', '', '🏠 Домашка'));
  l.hw.forEach(h => hw.appendChild(el('div', 'hw-item', `□ ${esc(h)}`)));
  hw.appendChild(el('div', 'hw-note', 'Отправьте домашку в чат — я проверю и дам разбор ошибок.'));
  root.appendChild(hw);

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
function renderQuestion(host) {
  const l = quizSource();
  const q = l.quiz[quizState.idx];
  host.innerHTML = '';
  if (!q) { finishQuiz(host); return; }

  const head = el('div', 'q-head', `
    <span>Вопрос ${quizState.idx + 1} из ${l.quiz.length}</span>
    <div class="q-bar"><div style="width:${quizState.idx / l.quiz.length * 100}%"></div></div>`);
  host.appendChild(head);

  const body = el('div', 'q-body');
  body.appendChild(el('div', 'q-text', esc(q.q)));
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
      const b = el('button', 'opt', `<span class="opt-k">${'ABCD'[i]}</span><span>${esc(o)}</span>`);
      b.onclick = () => {
        const ok = i === q.a;
        $$('.opt', opts).forEach((x, xi) => {
          x.disabled = true;
          if (xi === q.a) x.classList.add('right');
          if (xi === i && !ok) x.classList.add('wrong');
        });
        check(ok, ok ? '' : `Правильный ответ: <b>${esc(q.o[q.a])}</b>`);
      };
      opts.appendChild(b);
    });
    body.appendChild(opts);
    if (q.k === 'listen') {
      const pb = el('div', 'listen-row', `${toneBtn(q.o[q.a], 'speak big')} <span>нажмите, чтобы услышать</span>`);
      body.appendChild(pb);
    }
  } else if (q.k === 'gap') {
    const inp = el('input', 'gap-input');
    inp.placeholder = 'введите ответ по-китайски';
    inp.onkeydown = e => { if (e.key === 'Enter') submit(); };
    const sub = el('button', 'btn btn-primary', 'Проверить');
    const norm = s => String(s).trim().replace(/[。．.，,？?！!、\s]/g, '').toLowerCase();
    function submit() {
      const val = norm(inp.value);
      if (!val) return;
      const ok = q.a.some(a => norm(a) === val);
      inp.disabled = true; sub.disabled = true;
      inp.classList.add(ok ? 'right' : 'wrong');
      check(ok, ok ? '' : `Правильно: <b>${esc(q.a[0])}</b>${q.h ? ' — ' + esc(q.h) : ''}`);
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
      const b = el('button', 'ow', esc(w));
      b.dataset.i = i;
      b.onclick = () => {
        if (b.classList.contains('used')) return;
        b.classList.add('used');
        picked.push({ w, i });
        line.appendChild(el('button', 'ow used-inline', esc(w)));
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
      check(ok, ok ? '' : `Правильно: <b>${esc(q.a.map(i => q.o[i]).join(''))}</b>`);
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
  save();
  if (score >= 0.6) { playSfx('win'); launchConfetti(); }
  host.innerHTML = `<div class="quiz-done">
      <div class="qd-emoji">${score >= 0.8 ? '🎉' : score >= 0.5 ? '👍' : '💪'}</div>
      <h3>Результат: ${quizState.correct} из ${l.quiz.length} (${Math.round(score * 100)}%)</h3>
      <p>${score >= 0.8 ? 'Отличная работа! Этот урок засчитан.'
        : score >= 0.5 ? 'Хорошо, но есть что подтянуть. Посмотрите ошибки выше и повторите урок.'
        : 'Пройдите урок ещё раз после повторения грамматики — и держите темп!'}</p>
      <div class="qd-actions">
        <a class="btn btn-ghost" href="#/lesson/${quizState.lesson}">↻ Повторить</a>
        <a class="btn btn-primary" href="#/plan">К плану →</a>
      </div>
    </div>`;
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
  wrap.appendChild(el('p', 'page-sub', '50 вопросов на пиньинь, словарь, грамматику, иероглифы и перевод. Где не знаете — выберите любой ответ или оставьте поле пустым: это честнее и полезнее для разбора.'));
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
      <div class="qd-emoji">${score >= 0.8 ? '🎉' : score >= 0.5 ? '👍' : '💪'}</div>
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
  if (!pool.length) { p.appendChild(el('div', 'empty', 'Пока пусто. Нажмите «＋» рядом со словом в уроке или добавьте весь словарь.')); return p; }
  const list = el('div', 'card-list');
  pool.forEach(c => {
    const st = state.cards[c.h] || { box: 0 };
    const box = Math.max(0, Math.min(5, Number(st.box || 0)));
    const row = el('div', 'cl-row', `
      <span class="cl-h">${esc(c.h)}</span>
      <span class="cl-p">${esc(c.p)}</span>
      <span class="cl-r">${esc(c.r || '—')}</span>
      <span class="cl-box" title="Коробка Лейтнера">${'▮'.repeat(box + 1)}<i>${'▯'.repeat(5 - box)}</i></span>
      <button class="cl-del" data-del="${esc(c.h)}" title="Удалить">✕</button>`);
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
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return [cx * (size / r.width), cy * (size / r.height)];
  };
  const start = e => { if (!ctx) return; clearInterval(demoTimer); e.preventDefault(); drawing = true; const [x, y] = pos(e); ctx.strokeStyle = '#1c1c1c'; ctx.lineWidth = 9; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y + 0.1); ctx.stroke(); };
  const move = e => { if (!drawing || !ctx) return; e.preventDefault(); const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); };
  const end = () => { drawing = false; };
  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

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
let readState = { idx: 0, showPinyin: true };
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
      <button class="btn btn-sm" id="readAloud">🔊 Всё вслух</button>
    </div>`));
  const body = el('div', 'text-body');
  t.lines.forEach(ln => {
    const line = el('div', 'text-line');
    buildLine(ln.h, ln.p).forEach(part => {
      if (part.punct) { line.appendChild(el('span', 'punct', esc(part.ch))); return; }
      line.appendChild(el('span', 'w', `<span class="w-h">${esc(part.ch)}</span><span class="w-p">${esc(part.py)}</span>`));
    });
    line.onclick = () => speak(ln.h);
    body.appendChild(line);
  });
  p.appendChild(body);
  p.appendChild(el('div', 'note', 'Перевод: ' + esc(t.ru)));
  const gl = el('div', 'gloss');
  t.glossary.forEach(g => gl.appendChild(el('div', 'gl-row', `<b>${esc(g.h)}</b><span class="gl-p">${esc(g.p)}</span><span>${esc(g.r)}</span>`)));
  p.appendChild(el('h3', '', 'Словарь к тексту'));
  p.appendChild(gl);
  host.appendChild(p);

  $('#togglePy').onclick = () => { readState.showPinyin = !readState.showPinyin; renderText(host); };
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
        <span class="ph-h">${esc(it.h)}</span>
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
        <span class="d-h">${esc(w.h)}</span>
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
   ВИДЕО-УРОКИ (встроенный интерактивный плеер + YouTube)
   ============================================================ */
let vidTimer = null;
let vidState = { lessonIdx: 0, sceneIdx: 0, playing: false, subs: true };
function videoStop() {
  clearTimeout(vidTimer);
  vidState.playing = false;
}

function renderVideos(root) {
  const wrap = el('div');
  wrap.appendChild(el('h1', 'page-title', '🎬 Обучающие видео'));
  wrap.appendChild(el('p', 'page-sub', 'Встроенные анимированные видео-уроки со звуком и субтитрами (работают даже без VPN и YouTube) + проверенные уроки на YouTube.'));

  const lessons = (typeof VIDEO_LESSONS !== 'undefined' && VIDEO_LESSONS) || [];
  if (lessons.length) {
    const player = el('div', 'panel vid-player');
    const stage = el('div', 'vid-stage');
    const ctr = el('div', 'vid-ctr');
    const list = el('div', 'vid-list');
    player.appendChild(stage);
    player.appendChild(ctr);
    wrap.appendChild(player);
    wrap.appendChild(el('h3', 'vid-sec-t', 'Выберите видео-урок'));
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

      stage.innerHTML = `
        <div class="vid-top">
          <span class="vid-badge">${esc(L.level)}</span>
          <span class="vid-time">Сцена ${vidState.sceneIdx + 1} / ${L.scenes.length} · ${esc(L.duration)}</span>
        </div>
        <div class="vid-main">
          <div class="vid-hanzi">${esc(sc.hanzi)}</div>
          <div class="vid-pinyin">${esc(sc.pinyin)}</div>
          ${drawToneCurve(sc.tone)}
          <div class="vid-ru">${esc(sc.ru)}</div>
          ${vidState.subs ? `<div class="vid-sub">${esc(sc.sub)}</div>` : ''}
        </div>
        <div class="vid-bar"><i style="width:${pct}%"></i></div>`;

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
            <b>${esc(v.title)}</b>
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

  /* Внешние проверенные YouTube-видео */
  const ext = (typeof EXTERNAL_VIDEOS !== 'undefined' && EXTERNAL_VIDEOS) || [];
  if (ext.length) {
    const yp = el('div', 'panel');
    yp.appendChild(el('h3', '', '📺 Бесплатные уроки на YouTube'));
    yp.appendChild(el('p', 'page-sub', 'Открываются в новой вкладке YouTube.'));
    const yg = el('div', 'yt-grid');
    ext.forEach(v => {
      const a = el('a', 'yt-card', `
        <div class="yt-top"><span class="yt-badge">${esc(v.lang)}</span><span>${esc(v.channel)}</span></div>
        <b>${esc(v.title)}</b>
        <p>${esc(v.note)}</p>
        <span class="yt-go">Смотреть на YouTube ↗</span>`);
      a.href = v.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      yg.appendChild(a);
    });
    yp.appendChild(yg);
    wrap.appendChild(yp);
  }
  root.appendChild(wrap);
}

/* ============================================================
   ВНУТРЕННИЙ ИИ-АГЕНТ (Сяо Мин · 小明)
   ============================================================ */
let tutorHistory = [];
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
  return list;
}

function tutorReplyLocal(raw) {
  const q = (raw || '').trim();
  const low = q.toLowerCase();
  const vocab = tutorAllVocab();

  /* 1) Совет по личному прогрессу */
  if (/прогресс|повторить|совет|что учить|план|ошибк/.test(low)) {
    const done = doneCount(), total = allLessonIds().length;
    const due = dueCards().length;
    const nxt = LESSONS[nextLesson()];
    const hard = cardPool().filter(c => state.cards[c.h]?.wrong > 0).slice(0, 4);
    let txt = `Ваш прогресс: пройдено <b>${done} из ${total}</b> уроков, точность <b>${accuracy()}%</b>, серия <b>${state.streak}</b> дн.<br><br>`;
    if (due) txt += `🗂️ У вас <b>${due}</b> карточек ждут повторения — загляните в <a href="#/cards">Карточки</a>.<br>`;
    if (hard.length) txt += `🎯 Сложные слова: ${hard.map(c => `<b>${esc(c.h)}</b> (${esc(c.p)} — ${esc(c.r)})`).join(', ')}.<br>`;
    txt += `📚 Следующий рекомендуемый урок: <b>«${esc(nxt.title)}»</b> — <a href="#/lesson/${nextLesson()}">открыть урок →</a>`;
    return { html: txt };
  }

  /* 2) Мини-тест по китайскому прямо в чате */
  if (/тест|проверь|викторин|экзамен|задани/.test(low)) {
    const pool = vocab.filter(w => w.h && w.p && w.r);
    const target = pool[Math.floor(Math.random() * pool.length)];
    const decoys = shuffle(pool.filter(w => w.r !== target.r)).slice(0, 3);
    const opts = shuffle([target, ...decoys]);
    return {
      html: `Проверьте себя! Как переводится слово <b class="zh" style="font-size:22px">${esc(target.h)}</b> <span style="color:var(--gold)">(${esc(target.p)})</span>?`,
      speak: target.h,
      quiz: { target, opts }
    };
  }

  /* 3) Интерактивный мини-диалог */
  if (/диалог|поговор|практик|общен|привет/.test(low) && !/[\u4e00-\u9fff]/.test(q)) {
    tutorContext.mode = 'dialogue';
    tutorContext.step = 1;
    return {
      html: `Отлично, потренируем живой диалог! Я начинаю:<br>
        <b class="zh" style="font-size:20px">你好！你叫什么名字？</b><br>
        <span style="color:var(--gold)">Nǐ hǎo! Nǐ jiào shénme míngzi?</span> — Привет! Как тебя зовут?<br>
        <i>Ответьте по-китайски (например: <code>我叫Али</code> или <code>你好</code>)</i>`,
      speak: '你好！你叫什么名字？'
    };
  }
  if (tutorContext.mode === 'dialogue' && /[\u4e00-\u9fff]|nihao|wo|jiao|xie|hao/i.test(low)) {
    if (tutorContext.step === 1) {
      tutorContext.step = 2;
      return {
        html: `Супер ответ! 👍 Продолжаем:<br>
          <b class="zh" style="font-size:20px">很高兴认识你！你喜欢喝茶还是咖啡？</b><br>
          <span style="color:var(--gold)">Hěn gāoxìng rènshi nǐ! Nǐ xǐhuan hē chá háishi kāfēi?</span> — Рад познакомиться! Ты любишь чай или кофе?`,
        speak: '很高兴认识你！你喜欢喝茶还是咖啡？'
      };
    }
    tutorContext.mode = 'chat';
    return {
      html: `Отлично звучит! 👏 Вы уверенно держите диалог.<br>
        <b class="zh" style="font-size:20px">你中文说得很好！继续加油！</b><br>
        <span style="color:var(--gold)">Nǐ Zhōngwén shuō de hěn hǎo! Jìxù jiāyóu!</span> — Вы хорошо говорите по-китайски! Так держать!`,
      speak: '你中文说得很好！继续加油！'
    };
  }

  /* 4) Объяснение грамматики */
  const grammarKB = [
    { re: /吗|\bma\b|вопрос/, title: 'Вопросительная частица 吗 (ma)',
      body: 'Ставится в самом конце утверждения, чтобы получился вопрос «да/нет».<br>Пример: <b class="zh">你喝茶吗？</b> (Nǐ hē chá ma?) — Ты пьёшь чай?', speak: '你喝茶吗' },
    { re: /不|没|отрицан/, title: 'Отрицание 不 (bù) и 没 (méi)',
      body: '<b>不 (bù)</b> — отрицание в настоящем/будущем или привычке (<b class="zh">我不喝咖啡</b> — Я не пью кофе).<br><b>没 (méi)</b> — отрицание в прошлом или с глаголом 有 (<b class="zh">我没有时间</b> — У меня нет времени; <b class="zh">我昨天没去</b> — Вчера я не ходил).', speak: '我不喝咖啡' },
    { re: /了|\ble\b|прошед/, title: 'Частица 了 (le)',
      body: 'Показывает завершённое действие или новое состояние.<br>Пример: <b class="zh">我买了茶</b> (Wǒ mǎi le chá) — Я купил чай. / <b class="zh">下雨了</b> — Пошёл дождь.', speak: '我买了茶' },
    { re: /的|\bde\b|притяж/, title: 'Частица 的 (de)',
      body: 'Связывает определение или владельца с предметом: «чей» или «какой».<br>Пример: <b class="zh">我的书</b> (wǒ de shū) — моя книга; <b class="zh">好喝的茶</b> — вкусный чай.', speak: '我的书' },
    { re: /把|\bba\b/, title: 'Конструкция 把 (bǎ)',
      body: 'Выносит объект перед глаголом, когда с предметом что-то сделали или переместили его.<br>Схема: Подлежащее + 把 + Объект + Глагол + Результат.<br>Пример: <b class="zh">请把门关上</b> — Пожалуйста, закрой дверь.', speak: '请把门关上' },
    { re: /тон|пиньинь|сандх|произнош/, title: 'Тоны и сандхи (изменение тонов)',
      body: '1) Два 3-х тона подряд читаются как 2-й + 3-й: <b class="zh">你好</b> (nǐ hǎo → ní hǎo).<br>2) <b>不 (bù)</b> перед 4-м тоном становится <b>bú</b>: <b class="zh">不是</b> (bú shì).<br>Загляните также в раздел <a href="#/tones">Тоны</a> и <a href="#/videos">Видео-уроки</a>.', speak: '你好，不是' },
    { re: /счетн|счётн|个|本|杯|классификатор/, title: 'Счётные слова (个, 本, 杯)',
      body: 'Между числом и предметом в китайском всегда ставится счётное слово:<br>• <b>个 (gè)</b> — универсальное (一个人 — один человек)<br>• <b>本 (běn)</b> — для книг (一本书)<br>• <b>杯 (bēi)</b> — чашка/стакан (一杯茶)', speak: '一杯茶' }
  ];
  for (const g of grammarKB) {
    if (g.re.test(low)) {
      return { html: `<b>📖 ${g.title}</b><br><br>${g.body}`, speak: g.speak };
    }
  }

  /* 5) Разбор китайских иероглифов / перевод из словаря курса */
  const clean = q.replace(/[？?！!。.,，\s]/g, '');
  const exact = vocab.find(w => w.h === clean || w.r.toLowerCase() === low || w.p.toLowerCase() === low);
  if (exact) {
    return {
      html: `<b class="zh" style="font-size:26px">${esc(exact.h)}</b> <span style="color:var(--gold)">[${esc(exact.p)}]</span><br>
        Перевод: <b>${esc(exact.r)}</b><br>
        <span style="color:var(--txt3);font-size:12.5px">Раздел курса: ${esc(exact.lesson || '')}</span>`,
      speak: exact.h
    };
  }

  /* Частичное совпадение по русски или по иероглифам */
  const hasHanzi = /[\u4e00-\u9fff]/.test(q);
  if (hasHanzi) {
    const chars = [...q.match(/[\u4e00-\u9fff]+/g).join('')];
    const parts = [];
    let i = 0;
    while (i < chars.length) {
      let found = null;
      for (let len = Math.min(4, chars.length - i); len >= 1; len--) {
        const sub = chars.slice(i, i + len).join('');
        const hit = vocab.find(w => w.h === sub);
        if (hit) { found = hit; i += len; break; }
      }
      if (found) parts.push(found);
      else { parts.push({ h: chars[i], p: '?', r: 'нет в базовом словаре курса' }); i++; }
    }
    return {
      html: `<b>🔍 Разбор фразы:</b><br><br>` +
        parts.map(w => `• <b class="zh" style="font-size:18px">${esc(w.h)}</b> <span style="color:var(--gold)">${esc(w.p)}</span> — ${esc(w.r)}`).join('<br>'),
      speak: chars.join('')
    };
  }

  const hits = vocab.filter(w =>
    w.r.toLowerCase().includes(low) || w.p.toLowerCase().replace(/[^a-z]/g, '').includes(low.replace(/[^a-z]/g, ''))
  ).slice(0, 6);
  if (hits.length) {
    return {
      html: `Вот что нашлось по запросу «${esc(q)}»:<br><br>` +
        hits.map(w => `• <b class="zh" style="font-size:18px">${esc(w.h)}</b> <span style="color:var(--gold)">${esc(w.p)}</span> — ${esc(w.r)}`).join('<br>'),
      speak: hits[0].h
    };
  }

  return {
    html: `Я ваш внутренний ИИ-репетитор <b>Сяо Мин (小明)</b>! Могу помочь с:<br>
      • <b>Переводом и разбором</b>: напишите любое слово по-русски или иероглифами (например: <i>чай</i>, <i>спасибо</i> или <i>我想喝茶</i>)<br>
      • <b>Грамматикой</b>: спросите про <i>吗, 不/没, 了, 的, 把, тоны, счётные слова</i><br>
      • <b>Практикой</b>: напишите <i>«диалог»</i> или <i>«проверь меня»</i>!`
  };
}

function renderTutor(root) {
  const wrap = el('div', 'tutor-wrap');
  wrap.appendChild(el('h1', 'page-title', '🤖 ИИ-репетитор Сяо Мин (小明)'));
  wrap.appendChild(el('p', 'page-sub', 'Внутренний помощник по китайскому языку: перевод, разбор иероглифов, грамматика, диалоги и мини-тесты.'));

  const chips = el('div', 't-chips');
  [
    ['🔍 Как сказать «спасибо»?', 'спасибо'],
    ['📖 Что такое частица 了?', 'объясни частицу 了'],
    ['🎵 Как меняются тоны?', 'объясни тоны и сандхи'],
    ['💬 Потренируем диалог', 'давай поговорим в диалоге'],
    ['🎯 Что мне повторить?', 'что мне повторить сейчас'],
    ['🎲 Проверь меня', 'проверь меня тестом']
  ].forEach(([label, query]) => {
    const b = el('button', 'btn btn-sm btn-ghost', label);
    b.onclick = () => sendMsg(query);
    chips.appendChild(b);
  });
  wrap.appendChild(chips);

  const box = el('div', 'panel tutor-box');
  const feed = el('div', 'tutor-feed');
  box.appendChild(feed);

  if (!tutorHistory.length) {
    tutorHistory.push({
      role: 'assistant',
      html: '你好! Я <b>Сяо Мин (小明)</b> — ваш персональный ИИ-помощник по китайскому. Спросите перевод, грамматику или выберите подсказку выше!',
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
  inp.placeholder = 'Напишите вопрос, русское слово или иероглиф…';
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

    let replyObj = null;
    if (window.Auth && Auth.online) {
      try {
        const res = await fetch('/api/tutor/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: q,
            history: tutorHistory.slice(-6).map(x => ({ role: x.role, content: x.content || '' })),
            context: `Пройдено уроков: ${doneCount()}/15, точность: ${accuracy()}%`
          })
        });
        const d = await res.json();
        if (d && d.mode === 'ai' && d.reply) {
          replyObj = { html: esc(d.reply).replace(/\n/g, '<br>') };
        }
      } catch (e) { }
    }
    if (!replyObj) replyObj = tutorReplyLocal(q);
    tutorHistory.push({ role: 'assistant', content: q, ...replyObj });
    send.disabled = false;
    paintFeed();
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
    ['stats', '📊', 'Статистика'],
    ['class', '👨‍🏫', 'Класс'],
    ['account', '👤', 'Профиль']
  ];
  /* нижнее мобильное меню — только ключевые разделы, остальное с главной */
  const mItems = [
    ['home', '🏠', 'Главная'],
    ['plan', '📚', 'Уроки'],
    ['cards', '🗂️', 'Карточки'],
    ['videos', '🎬', 'Видео'],
    ['tutor', '🤖', 'ИИ'],
    ['class', '👨‍🏫', 'Класс'],
    ['account', '👤', 'Профиль']
  ];
  items.forEach(([r, ic, t]) => {
    const a = el('a', '', `<span class="ni">${ic}</span><span class="nt">${t}</span>`);
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

  if (!$('#tutorFab')) {
    const fab = el('a', 'tutor-fab', '🤖');
    fab.id = 'tutorFab';
    fab.href = '#/tutor';
    fab.title = 'ИИ-репетитор Сяо Мин';
    document.body.appendChild(fab);
  }
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
  const bThm = el('button', 'btn btn-ghost', PREFS.theme === 'light' ? '☀️ Тема: светлая (бумага)' : '🌙 Тема: тёмная');
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

document.addEventListener('DOMContentLoaded', boot);
async function boot() {
  initNav();
  touchDay();
  if (window.Auth) { try { await Auth.boot(); } catch (e) { } }
  maybeFrameBanner();
  paintAccountFoot();
  updateNavRoles();
  route();
  setInterval(touchDay, 60000);
}

/* Если открыт просмотр файла без сервера или iframe с заблокированным localStorage —
   подсказываем пользователю, как войти и сохранить прогресс. */
function maybeFrameBanner() {
  const isFilePreview = (location.protocol !== 'http:' && location.protocol !== 'https:');
  if (isFilePreview) {
    const b = el('div', 'frame-banner');
    b.innerHTML = `<span>📌 Вы открыли просмотр файла <b>index.html</b> (без сети). Чтобы войти в аккаунт и открыть панель класса, переключитесь на панель <b>Live Preview («Chinese Learning App»)</b>.</span>`;
    const close = el('button', 'fb-x', '✕');
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
    close.onclick = () => b.remove();
    b.appendChild(close);
    document.body.prepend(b);
  }
}
