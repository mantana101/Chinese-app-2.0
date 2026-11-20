/* ============================================================
   汉语学习 · ДОМАШНИЕ ЗАДАНИЯ
   ============================================================
   Раньше домашка была просто списком текста: «отправьте в чат».
   Теперь ученик выполняет её прямо на сайте и отправляет учителю —
   работа попадает в раздел «Класс», где её можно посмотреть и оценить.

   Модуль самостоятельный: свои запросы к API, свой рендер, свои стили
   (.hw-*). Общается с остальным приложением через три функции:
   window.renderHomework (маршрут), window.renderHomeworkPanel (блок
   в уроке) и window.hwPending (счётчик для меню).
   ============================================================ */
(function () {
  'use strict';

  const TOKEN_KEY = 'zh_token';

  const state = {
    items: {},        // lesson_id -> серверная запись (answers, score, feedback)
    loaded: false,
    loading: false,
    answers: {},      // lesson_id -> { hw0: '...', ... }
    drafts: {},       // lesson_id -> { hw0: 'черновик', ... } в localStorage
    dirty: {},        // lesson_id -> true (есть неотправленные изменения)
    selected: 'l1'
  };

  /* ---------- сеть ----------
     Повторяем поведение Auth.api: token в заголовке, credentials omit.
     Здесь не тянем Auth, чтобы модуль работал даже до входа. */
  function token() {
    try { return (window.Store ? window.Store.get(TOKEN_KEY) : null) || ''; } catch (e) { return ''; }
  }
  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch(path, Object.assign({ credentials: 'omit' }, opts, {
      headers: Object.assign(headers, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }));
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      const err = new Error(data.error || String(res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function loggedIn() {
    return !!(window.Auth && window.Auth.user);
  }
  function isTeacher() {
    const u = window.Auth && window.Auth.user;
    return !!(u && (u.role === 'owner' || u.role === 'teacher'));
  }

  /* ---------- локальные черновики ----------
     Черновик живёт в localStorage: если ученик закрыл вкладку на середине,
     текст не пропадёт. На сервер уходит только по кнопке «Отправить». */
  const DRAFT_KEY = 'zh_hw_drafts_v1';

  function loadDrafts() {
    try {
      const raw = window.Store ? window.Store.get(DRAFT_KEY) : null;
      state.drafts = raw ? JSON.parse(raw) || {} : {};
    } catch (e) { state.drafts = {}; }
  }
  function saveDrafts() {
    try { if (window.Store) window.Store.set(DRAFT_KEY, JSON.stringify(state.drafts)); } catch (e) { }
  }
  /* Ответы урока: серверная версия + черновик сверху. Черновик важнее —
     в нём могут быть правки, которые ещё не отправлены. */
  function draftOf(lessonId) {
    const server = (state.items[lessonId] && state.items[lessonId].answers) || {};
    const draft = state.drafts[lessonId] || {};
    if (!state.dirty[lessonId] && !Object.keys(draft).length) return server;
    return Object.assign({}, server, draft);
  }
  function setAnswer(lessonId, key, value) {
    if (!state.answers[lessonId]) {
      state.answers[lessonId] = Object.assign({}, draftOf(lessonId));
    }
    state.answers[lessonId][key] = value;
    state.drafts[lessonId] = state.answers[lessonId];
    state.dirty[lessonId] = true;
    saveDrafts();
  }

  /* ---------- серверные данные ---------- */
  async function load() {
    if (!loggedIn()) { state.loaded = true; return; }
    if (state.loading) return;
    state.loading = true;
    try {
      const r = await api('/api/homework');
      const items = {};
      (r.items || []).forEach(it => { items[it.lesson_id] = it; });
      state.items = items;
      state.loaded = true;
      // Серверная версия — база для правки; черновик важнее, если он новее.
      Object.keys(items).forEach(id => {
        if (!state.answers[id] || !state.dirty[id]) {
          state.answers[id] = Object.assign({}, items[id].answers || {});
        }
      });
    } catch (e) {
      state.loaded = true;
    } finally {
      state.loading = false;
    }
  }

  function submittedCount() {
    return Object.keys(state.items).length;
  }
  function pendingCount() {
    // Работы, которые ещё не сданы или ждут проверки — для бейджа в меню.
    return Object.keys(state.items).filter(id => state.items[id].score == null).length;
  }

  /* ---------- разметка ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }
  function ruby(text) {
    return typeof window.ruby === 'function' ? window.ruby(text) : esc(text);
  }
  function lessonIds() {
    return Object.keys(window.LESSONS || {});
  }
  function lessonTitle(id) {
    const l = window.LESSONS && window.LESSONS[id];
    return l ? l.title : id;
  }
  function tasksFor(id) {
    return typeof window.homeworkFor === 'function' ? window.homeworkFor(id) : [];
  }

  const KIND_RU = {
    mcq: 'Выбор ответа',
    read: 'Понимание фразы',
    order: 'Сборка фразы',
    text: 'Свободный ответ'
  };

  function statusOf(id) {
    const it = state.items[id];
    const has = !!(it && Object.keys(it.answers || {}).length);
    if (!has) {
      const draft = draftOf(id);
      const started = Object.keys(draft).length > 0;
      return { code: started ? 'draft' : 'empty', label: started ? 'Черновик' : 'Не начата', it };
    }
    if (it.score == null) return { code: 'waiting', label: 'На проверке', it };
    return { code: 'graded', label: 'Оценено · ' + it.score + '%', it };
  }

  /* ============================================================
     БЛОК В УРОКЕ
     ============================================================ */
  function renderLessonBlock(root, lessonId) {
    const panel = el('div', 'panel hw');
    panel.id = 'homework';
    const st = statusOf(lessonId);
    const badge = st.code === 'graded'
      ? `<span class="hw-badge ok">✓ ${esc(st.label)}</span>`
      : st.code === 'waiting'
        ? '<span class="hw-badge wait">⏳ на проверке</span>'
        : st.code === 'draft'
          ? '<span class="hw-badge draft">✎ черновик</span>'
          : '<span class="hw-badge">не начата</span>';
    panel.appendChild(el('div', 'panel-head',
      `<h3>🏠 Домашка</h3><div class="hw-head-right">${badge}</div>`));

    if (st.code === 'graded' && st.it.feedback) {
      panel.appendChild(el('div', 'hw-feedback', `💬 <b>Учитель:</b> ${esc(st.it.feedback)}`));
    }
    if (st.code === 'waiting') {
      panel.appendChild(el('div', 'hw-note',
        'Работа отправлена учителю. Можно доработать и отправить снова — проверка начнётся заново.'));
    }

    const list = el('div', 'hw-list');
    const tasks = tasksFor(lessonId);
    const answers = draftOf(lessonId);
    tasks.forEach((task, i) => {
      list.appendChild(taskRow(lessonId, task, 'hw' + i, answers['hw' + i], i));
    });
    panel.appendChild(list);

    const bar = el('div', 'hw-actions');
    const save = el('button', 'btn btn-ghost', '💾 Сохранить черновик');
    save.onclick = () => { saveDrafts(); toast('Черновик сохранён в браузере'); };
    const send = el('button', 'btn btn-primary', st.code === 'empty' ? '📤 Отправить учителю' : '📤 Отправить учителю');
    send.onclick = () => submit(panel, lessonId);
    bar.appendChild(send);
    bar.appendChild(save);
    const openAll = el('a', 'btn btn-ghost', 'Все домашки →');
    openAll.href = '#/homework/' + lessonId;
    bar.appendChild(openAll);
    panel.appendChild(bar);

    panel.appendChild(el('div', 'hw-note',
      'Работа уходит учителю и появляется в разделе «Класс». Набирать иероглифы не нужно: где надо, отвечайте пиньинем или по-русски.'));
    root.appendChild(panel);
  }

  /* Один вопрос домашки. Возвращает узел; ответ пишется через setAnswer. */
  function taskRow(lessonId, task, key, value, index) {
    const row = el('div', 'hw-task');
    const head = el('div', 'hw-task-head',
      `<span class="hw-num">${index + 1}</span>
       <span class="hw-kind">${esc(KIND_RU[task.k] || 'Задание')}</span>
       ${task.n ? `<span class="hw-need">не меньше ${task.n} слов</span>` : ''}`);
    row.appendChild(head);
    row.appendChild(el('div', 'hw-q', ruby(task.q)));
    if (task.h) row.appendChild(el('div', 'hw-hint', ruby(task.h)));

    if (task.k === 'mcq' || task.k === 'read') {
      const opts = el('div', 'hw-opts');
      (task.o || []).forEach((opt, i) => {
        const b = el('button', 'hw-opt' + (value === String(i) ? ' on' : ''), ruby(opt));
        b.onclick = () => {
          Array.from(opts.children).forEach(x => x.classList.remove('on'));
          b.classList.add('on');
          setAnswer(lessonId, key, String(i));
          markLive(row, task, String(i));
        };
        opts.appendChild(b);
      });
      row.appendChild(opts);
      if (value !== undefined && value !== '') markLive(row, task, value);
    } else if (task.k === 'order') {
      // Порядок задаётся номерами плиток через клики: без ввода текста.
      const seq = value ? value.split(',').filter(Boolean) : [];
      const picked = el('div', 'hw-line');
      const pool = el('div', 'hw-pool');
      const draw = () => {
        picked.innerHTML = '';
        pool.innerHTML = '';
        if (!seq.length) picked.appendChild(el('span', 'hw-placeholder', 'Нажимайте слова по порядку'));
        seq.forEach((idx, pos) => {
          const chip = el('button', 'hw-chip', ruby(task.o[Number(idx)]));
          chip.title = 'Убрать';
          chip.onclick = () => { seq.splice(pos, 1); commit(); };
          picked.appendChild(chip);
        });
        (task.o || []).forEach((word, i) => {
          if (seq.indexOf(String(i)) !== -1) return;
          const chip = el('button', 'hw-chip', ruby(word));
          chip.onclick = () => { seq.push(String(i)); commit(); };
          pool.appendChild(chip);
        });
        function commit() {
          draw();
          setAnswer(lessonId, key, seq.join(','));
          markLive(row, task, seq.join(','));
        }
      };
      draw();
      row.appendChild(picked);
      row.appendChild(pool);
      const reset = el('button', 'btn btn-sm', '↺ Сбросить');
      reset.onclick = () => { seq.length = 0; setAnswer(lessonId, key, ''); draw(); markLive(row, task, ''); };
      row.appendChild(el('div', 'hw-row', '')).appendChild(reset);
    } else {
      const ta = el('textarea', 'hw-input');
      ta.rows = task.n && task.n > 30 ? 6 : task.n && task.n > 16 ? 4 : 3;
      ta.placeholder = 'Напишите ответ: по-китайски, пиньинем или по-русски';
      ta.value = value || '';
      const counter = el('span', 'hw-count', '');
      const upd = () => {
        const words = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
        counter.textContent = `${words} сл.` + (task.n ? ` / нужно ≈${task.n}` : '');
        counter.className = 'hw-count' + (task.n && words >= task.n ? ' ok' : '');
      };
      ta.oninput = () => { setAnswer(lessonId, key, ta.value); upd(); };
      ta.onblur = () => saveDrafts();
      upd();
      row.appendChild(ta);
      row.appendChild(counter);
    }
    return row;
  }

  /* Живая проверка выбора на сайте: ученик сразу видит, верно ли.
     Свободный ответ и сборку проверяет учитель. */
  function markLive(row, task, value) {
    const old = row.querySelector('.hw-live');
    if (old) old.remove();
    if (task.k !== 'mcq' && task.k !== 'read') return;
    if (value === undefined || value === '') return;
    const ok = Number(value) === task.a;
    const box = el('div', 'hw-live ' + (ok ? 'ok' : 'bad'),
      ok ? '✅ Верно' : `❌ Правильно: ${ruby((task.o || [])[task.a] || '')}`);
    row.appendChild(box);
  }

  async function submit(panel, lessonId) {
    const tasks = tasksFor(lessonId);
    const answers = state.answers[lessonId] || {};
    const filled = {};
    let missing = 0;
    tasks.forEach((task, i) => {
      const v = answers['hw' + i];
      if (v === undefined || v === '') { missing++; return; }
      if (task.k === 'text' && !String(v).trim()) { missing++; return; }
      filled['hw' + i] = String(v);
    });

    if (!Object.keys(filled).length) {
      toast('Пока пусто: ответьте хотя бы на одно задание');
      return;
    }
    if (missing && !confirm(`Не заполнено заданий: ${missing}. Отправить то, что есть?`)) return;
    if (!loggedIn()) {
      toast('Домашку можно отправить после входа в аккаунт');
      return;
    }

    try {
      await api('/api/homework/submit', {
        method: 'POST',
        body: { lesson_id: lessonId, answers: filled }
      });
      state.dirty[lessonId] = false;
      delete state.drafts[lessonId];
      delete state.answers[lessonId];
      saveDrafts();
      await load();
      panel.replaceWith(freshBlock(lessonId));
      toast('Отправлено учителю ✓');
    } catch (e) {
      if (e.status === 401) {
        toast('Сессия истекла — войдите заново');
        if (window.Auth && window.Auth.boot) window.Auth.boot().then(() => route()).catch(() => {});
      } else {
        toast('Не удалось отправить, попробуйте ещё раз');
      }
    }
  }

  function freshBlock(lessonId) {
    const host = el('div');
    renderLessonBlock(host, lessonId);
    return host.firstChild;
  }

  /* ============================================================
     СТРАНИЦА «ДОМАШКИ»
     ============================================================ */
  async function renderPage(root, args) {
    loadDrafts();
    const wrap = el('div');
    root.appendChild(wrap);
    wrap.innerHTML = '<h1 class="page-title">🏠 Домашние задания</h1><p class="page-sub">Загрузка…</p>';

    await load();

    const ids = lessonIds();
    const sel = (args && args[0] && window.LESSONS[args[0]]) ? args[0] : (state.selected || ids[0]);
    state.selected = sel;

    wrap.innerHTML = '';
    wrap.appendChild(el('h1', 'page-title', '🏠 Домашние задания'));
    const done = submittedCount();
    wrap.appendChild(el('p', 'page-sub',
      `Выполняйте здесь и отправляйте учителю одной кнопкой. Сдано работ: ${done} из ${ids.length}.`));

    if (!loggedIn()) {
      wrap.appendChild(el('div', 'panel hw-login',
        'Чтобы отправить домашку учителю, войдите в свой аккаунт. Без входа ответы сохраняются только в этом браузере.' +
        '<div class="btn-row" style="margin-top:12px"><a class="btn btn-primary" href="#/account">Войти в аккаунт →</a></div>'));
    }

    const layout = el('div', 'hw-layout');
    const list = el('div', 'panel hw-side');
    list.appendChild(el('h3', '', 'Уроки'));
    ids.forEach(id => {
      const st = statusOf(id);
      const a = el('a', 'hw-side-row' + (id === sel ? ' active' : '') + ' hw-' + st.code);
      a.href = '#/homework/' + id;
      a.innerHTML = `<span class="hs-num">${id.replace('l', '')}</span>
        <span class="hs-body"><b>${esc(lessonTitle(id))}</b><i>${esc(st.label)}</i></span>
        <span class="hs-dot"></span>`;
      list.appendChild(a);
    });
    layout.appendChild(list);

    const main = el('div', 'hw-main');
    const st = statusOf(sel);
    const panel = el('div', 'panel');
    panel.appendChild(el('div', 'panel-head',
      `<h3>${esc(lessonTitle(sel))}</h3><span class="hw-pill hw-${st.code}">${esc(st.label)}</span>`));

    if (st.code === 'graded') {
      panel.appendChild(el('div', 'hw-score-card', `
        <div class="hw-score-value">${st.it.score}%</div>
        <div class="hw-score-body">
          <b>Работа проверена</b>
          <span>${esc(st.it.feedback || 'Учитель не оставил комментарий.')}</span>
        </div>`));
    }

    const tasks = tasksFor(sel);
    const answers = draftOf(sel);
    const listEl = el('div', 'hw-list');
    tasks.forEach((task, i) => {
      listEl.appendChild(taskRow(sel, task, 'hw' + i, answers['hw' + i], i));
    });
    panel.appendChild(listEl);

    const bar = el('div', 'hw-actions');
    const send = el('button', 'btn btn-primary',
      st.code === 'waiting' ? '📤 Отправить снова' : st.code === 'graded' ? '📤 Отправить заново' : '📤 Отправить учителю');
    send.onclick = () => submit(main.querySelector('.panel'), sel);
    bar.appendChild(send);
    const save = el('button', 'btn btn-ghost', '💾 Черновик');
    save.onclick = () => { saveDrafts(); toast('Черновик сохранён'); };
    bar.appendChild(save);
    panel.appendChild(bar);
    panel.appendChild(el('div', 'hw-note',
      'Задания с выбором проверяются сразу. Свободные ответы читает учитель: можно писать по-китайски, пиньинем или по-русски.'));
    main.appendChild(panel);
    layout.appendChild(main);
    wrap.appendChild(layout);

    // Внутри урока удобнее видеть ту же домашку рядом с материалом.
    wrap.appendChild(el('div', 'hw-note',
      'Домашка есть и в самом уроке — внизу страницы, сразу после практики.'));
  }

  /* ---------- счётчик для меню/главной ---------- */
  async function refreshBadge() {
    if (!loggedIn()) return;
    await load();
    const waiting = pendingCount();
    const badge = document.getElementById('hwBadge');
    if (badge) {
      badge.textContent = waiting ? String(waiting) : '';
      badge.style.display = waiting ? 'inline-grid' : 'none';
    }
  }

  function toast(msg) {
    if (window.toast) window.toast(msg);
  }

  window.renderHomework = renderPage;
  window.renderHomeworkPanel = renderLessonBlock;
  window.hwPending = pendingCount;
  window.hwRefresh = refreshBadge;
  window.hwStatus = statusOf;
})();
