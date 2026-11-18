/* ============================================================
   Авторизация, синхронизация прогресса и учительская панель
   ============================================================ */

const Auth = (() => {
  let user = null;          // {id, username, display_name, role}
  let online = false;       // доступен ли сервер
  let hasUsers = false;     // есть ли аккаунты на сервере
  let syncTimer = null;
  let pending = null;
  let lastSync = 0;

  const ROLE_RU = { owner: 'Владелец', teacher: 'Учитель', student: 'Ученик' };
  const TOKEN_KEY = 'zh_token';

  function getToken() {
    try { return (window.Store ? window.Store.get(TOKEN_KEY) : null) || null; } catch (e) { return null; }
  }
  function setToken(t) {
    try { if (window.Store) window.Store.set(TOKEN_KEY, t || ''); } catch (e) { }
  }

  /* ---------- сеть ----------
     credentials: 'omit' + заголовок Authorization — работает и из обычного
     браузера, и из iframe с непрозрачным origin (там cookies недоступны). */
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const t = getToken();
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch(path, {
      credentials: 'omit',
      ...opts,
      headers: { ...headers, ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      const err = new Error(data.error || res.status);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ---------- перехват ошибок браузера ---------- */
  let errCountWindow = 0;
  setInterval(() => { errCountWindow = 0; }, 60000);
  function reportClientError(message, detail) {
    if (!online || !message || errCountWindow >= 6) return;
    errCountWindow++;
    try {
      const headers = { 'Content-Type': 'application/json' };
      const t = getToken();
      if (t) headers.Authorization = 'Bearer ' + t;
      fetch('/api/system/client-error', {
        method: 'POST', credentials: 'omit', headers,
        body: JSON.stringify({ message: String(message).slice(0, 350), detail: String(detail || '').slice(0, 1500) })
      }).catch(() => { });
    } catch (e) { }
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('error', (ev) => {
      if (ev && ev.message) reportClientError(ev.message, `${ev.filename || ''}:${ev.lineno || ''}:${ev.colno || ''}`);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev && ev.reason;
      const msg = (r && (r.message || String(r))) || 'Unhandled rejection';
      reportClientError(msg, r && r.stack ? r.stack : '');
    });
  }

  /* ---------- запуск ---------- */
  async function boot() {
    try {
      const st = await api('/api/auth/status');
      online = true;
      hasUsers = !!st.has_users;
    } catch (e) {
      online = false;
      hasUsers = false;
    }
    if (online) {
      try {
        const me = await api('/api/auth/me');
        user = me.user;
        await pullProgress();
      } catch (e) { user = null; }
    }
    return { user, online, hasUsers };
  }

  function needsAuth() { return online && hasUsers && !user; }

  /* ---------- вход / регистрация ---------- */
  async function login(username, password) {
    const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    user = r.user;
    hasUsers = true;
    if (r.token) setToken(r.token);
    await pullProgress();
    return user;
  }

  async function register({ code, display_name, username, password }) {
    const r = await api('/api/auth/register', { method: 'POST', body: { code, display_name, username, password } });
    user = r.user;
    hasUsers = true;
    if (r.token) setToken(r.token);
    await pullProgress();
    return user;
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { }
    setToken('');
    user = null;
  }

  /* ---------- синхронизация прогресса ---------- */
  async function pullProgress() {
    if (!user) return;
    try {
      const r = await api('/api/progress');
      if (r.payload && Object.keys(r.payload).length) {
        const local = window.__state ? window.__state() : null;
        const serverHas = Object.keys(r.payload.lessons || {}).length > 0;
        const localHas = local && Object.keys(local.lessons || {}).length > 0;
        if (serverHas || !localHas) {
          window.__setState(Object.assign({}, local || {}, r.payload));
          if (local && localHas && !serverHas) persist(true);
        }
      }
    } catch (e) { /* останется локально */ }
  }

  function persist(immediate = false) {
    if (!user || !online) return;
    clearTimeout(syncTimer);
    const send = () => {
      const payload = window.__state ? window.__state() : null;
      if (!payload) return;
      pending = payload;
      api('/api/progress', { method: 'PUT', body: { payload } })
        .then(() => { lastSync = Date.now(); pending = null; })
        .catch(() => { });
    };
    if (immediate) send(); else syncTimer = setTimeout(send, 1200);
  }

  /* ============================================================
     ЭКРАН ВХОДА
     ============================================================ */
  function renderAuth(root) {
    const wrap = document.createElement('div');
    wrap.className = 'auth-wrap';

    let mode = hasUsers ? 'login' : 'register';

    const card = document.createElement('div');
    card.className = 'panel auth-card';
    wrap.appendChild(card);
    root.appendChild(wrap);

    function paint() {
      card.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'auth-head';
      head.innerHTML = `
        <div class="auth-logo">学</div>
        <h1>汉语学习</h1>
        <p>${hasUsers ? 'Войдите, чтобы прогресс сохранялся и учитель видел ваши результаты'
          : 'Вы первый пользователь — регистрация даст вам роль <b>владельца</b> (учителя)'}</p>`;
      card.appendChild(head);

      if (!online) {
        const isFilePreview = (location.protocol !== 'http:' && location.protocol !== 'https:');
        const warn = document.createElement('div');
        warn.className = 'auth-warn';
        warn.innerHTML = isFilePreview
          ? '⚠️ <b>Открыт просмотр файла без сети.</b> В этом окне нет связи с сервером — вход и панель класса работают только в <b>Live Preview</b> (адрес на порту <code>8080</code>). Вы можете нажать «Продолжить без аккаунта», чтобы заниматься локально.'
          : '⚠️ Сервер недоступен — работает <b>локальный режим</b>. Проверьте, запущен ли сервер, или нажмите «Продолжить без аккаунта».';
        card.appendChild(warn);
      }

      const tabs = document.createElement('div');
      tabs.className = 'tabs';
      if (hasUsers) {
        [['login', '🔑 Вход'], ['register', '📝 Регистрация по коду']].forEach(([id, t]) => {
          const b = document.createElement('button');
          b.className = 'tab' + (mode === id ? ' active' : '');
          b.textContent = t;
          b.onclick = () => { mode = id; paint(); };
          tabs.appendChild(b);
        });
        card.appendChild(tabs);
      }

      const form = document.createElement('form');
      form.className = 'auth-form';
      const err = document.createElement('div');
      err.className = 'auth-error';
      err.style.display = 'none';

      const field = (label, name, type = 'text', placeholder = '') => {
        const wrapf = document.createElement('label');
        wrapf.className = 'field';
        wrapf.innerHTML = `<span>${label}</span>`;
        const inp = document.createElement('input');
        inp.type = type; inp.name = name; inp.placeholder = placeholder; inp.autocomplete = type === 'password' ? 'current-password' : 'off';
        wrapf.appendChild(inp);
        return { wrap: wrapf, inp };
      };

      let fUser, fPass, fCode, fName;

      if (mode === 'login') {
        fUser = field('Логин или имя', 'username', 'text', 'например ali01 или Али');
        fPass = field('Пароль', 'password', 'password', '••••••');
        form.appendChild(fUser.wrap); form.appendChild(fPass.wrap);
      } else {
        fCode = hasUsers
          ? field('Код от учителя', 'code', 'text', 'ABC-123')
          : field('Код от учителя (не нужен — вы первый)', 'code', 'text', 'оставьте пустым');
        fName = field('Ваше имя', 'display_name', 'text', 'Али');
        fUser = field('Логин (необязательно)', 'username', 'text', 'придумайте или оставьте пустым');
        fPass = field('Пароль (мин. 4 символа)', 'password', 'password', '••••••');
        if (!hasUsers) {
          const tip = document.createElement('div');
          tip.className = 'auth-warn';
          tip.innerHTML = '👑 <b>Вы — первый пользователь.</b> Регистрация даст вам роль владельца: вы увидите весь класс, сможете создавать учеников и выставлять оценки.';
          form.appendChild(tip);
        }
        form.appendChild(fCode.wrap); form.appendChild(fName.wrap);
        form.appendChild(fUser.wrap); form.appendChild(fPass.wrap);
      }
      card.appendChild(err);
      card.appendChild(form);

      const btn = document.createElement('button');
      btn.className = 'btn btn-primary auth-submit';
      btn.textContent = mode === 'login' ? 'Войти →' : 'Создать аккаунт →';
      btn.type = 'submit';
      form.appendChild(btn);

      form.onsubmit = async (e) => {
        e.preventDefault();
        err.style.display = 'none';
        if (!online) {
          // попробуем ещё раз проверить сервер перед отказом
          try {
            const st = await api('/api/auth/status');
            online = true;
            hasUsers = !!st.has_users;
          } catch (_) {
            err.textContent = (location.protocol !== 'http:' && location.protocol !== 'https:')
              ? 'Нет связи с сервером: вы смотрите статический файл. Откройте приложение через Live Preview (порт 8080).'
              : 'Сервер недоступен. Обновите страницу или проверьте подключение.';
            err.style.display = 'block';
            return;
          }
        }
        btn.disabled = true;
        btn.textContent = 'Подождите…';
        try {
          if (mode === 'login') {
            await login(fUser.inp.value.trim(), fPass.inp.value);
          } else {
            await register({
              code: fCode.inp.value.trim(),
              display_name: fName.inp.value.trim(),
              username: fUser.inp.value.trim(),
              password: fPass.inp.value
            });
          }
          window.__afterAuth();
        } catch (ex) {
          const map = {
            bad_credentials: 'Неверный логин или пароль',
            bad_invite: 'Код не найден или уже использован',
            name_required: 'Введите имя (минимум 2 символа)',
            weak_password: 'Пароль слишком короткий (минимум 4 символа)',
            too_many: 'Слишком много попыток. Подождите 5 минут.',
            not_authenticated: 'Сессия истекла — войдите заново'
          };
          err.textContent = map[ex.message] || ('Ошибка: ' + ex.message);
          err.style.display = 'block';
          btn.disabled = false;
          btn.textContent = mode === 'login' ? 'Войти →' : 'Создать аккаунт →';
        }
      };

      const guest = document.createElement('button');
      guest.className = 'btn btn-ghost auth-guest';
      guest.textContent = 'Продолжить без аккаунта (локально)';
      guest.onclick = () => { window.__guestMode(); };
      card.appendChild(guest);
    }
    paint();
  }

  /* ============================================================
     УЧИТЕЛЬСКАЯ ПАНЕЛЬ
     ============================================================ */
  async function renderClass(root) {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<h1 class="page-title">👨‍🏫 Класс</h1><p class="page-sub">Загрузка…</p>';
    root.appendChild(wrap);

    let tab = 'class'; // 'class' | 'system'
    let data, invites = [], sys = null;
    async function loadData() {
      const reqs = [
        api('/api/class/overview'),
        api('/api/class/invites').catch(() => ({ invites: [] }))
      ];
      if (user?.role === 'owner') reqs.push(api('/api/system/status').catch(() => null));
      const [ov, iv, sy] = await Promise.all(reqs);
      data = ov;
      invites = (iv.invites || []).filter(i => !i.used_by);
      if (sy !== undefined) sys = sy;
    }
    try {
      await loadData();
    } catch (e) {
      wrap.innerHTML = '<h1 class="page-title">👨‍🏫 Класс</h1><div class="panel">Нет доступа или сервер недоступен.</div>';
      return;
    }

    async function reload() {
      try { await loadData(); paint(); } catch (e) { paint(); }
    }

    const paint = () => {
      wrap.innerHTML = '';
      wrap.appendChild(el2('h1', 'page-title', `👨‍🏫 Класс — ${ROLE_RU[user?.role] || 'Учитель'}`));
      wrap.appendChild(el2('p', 'page-sub',
        `Учеников: ${data.count} · средний балл класса: ${data.avg_score}% · средняя точность: ${data.avg_accuracy}% · активны сегодня: ${data.active_today}`));

      if (user?.role === 'owner') {
        const tabs = el2('div', 'tabs');
        const errN = sys?.counts?.errors || 0;
        [['class', '📋 Ученики и коды'], ['system', `🛠 Состояние системы${errN ? ` (${errN})` : ''}`]].forEach(([id, label]) => {
          const b = el2('button', 'tab' + (tab === id ? ' active' : ''), label);
          b.onclick = () => { tab = id; paint(); };
          tabs.appendChild(b);
        });
        wrap.appendChild(tabs);
      }

      if (tab === 'system' && user?.role === 'owner') {
        paintSystem();
        return;
      }

      /* --- приглашения --- */
      const inv = el2('div', 'panel');
      inv.appendChild(el2('h3', '', '🔑 Коды для учеников'));
      inv.appendChild(el2('p', 'page-sub', 'Создайте код, отправьте ученику. Он введёт код при регистрации, выберет имя и пароль.'));
      const btnRow = el2('div', 'btn-row');
      const mk = el2('button', 'btn btn-primary', '＋ Создать код');
      const csv = el2('button', 'btn btn-ghost', '⬇ Экспорт CSV');
      csv.onclick = async () => {
        try {
          const headers = {};
          const t = getToken();
          if (t) headers.Authorization = 'Bearer ' + t;
          const res = await fetch('/api/class/export.csv', { credentials: 'omit', headers });
          if (!res.ok) throw new Error(res.status);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'klass.csv';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) { toast('Ошибка экспорта'); }
      };
      btnRow.appendChild(mk); btnRow.appendChild(csv);
      inv.appendChild(btnRow);
      const codeBox = el2('div', 'code-list');
      const addCodeRow = (code, whenText) => {
        const c = el2('div', 'code-item');
        c.innerHTML = `<b>${esc(code)}</b><span>${esc(whenText)}</span>`;
        const copy = el2('button', 'btn btn-sm', '📋 Копировать');
        copy.onclick = () => { navigator.clipboard?.writeText(code); toast('Код скопирован'); };
        const rev = el2('button', 'btn btn-sm', 'Отозвать');
        rev.onclick = async () => { await api('/api/class/invites/revoke', { method: 'POST', body: { code } }); reload(); };
        c.appendChild(copy); c.appendChild(rev);
        codeBox.appendChild(c);
      };
      invites.forEach(i => addCodeRow(i.code, 'активен · ' + timeAgo(i.created_at)));
      inv.appendChild(codeBox);
      mk.onclick = async () => {
        try {
          const r = await api('/api/class/invite', { method: 'POST', body: {} });
          toast('Код создан: ' + r.code);
          await reload();
        } catch (e) { toast('Ошибка'); }
      };
      wrap.appendChild(inv);

      /* --- таблица учеников --- */
      const t = el2('div', 'panel');
      t.appendChild(el2('h3', '', `📋 Ученики (${data.count})`));
      if (!data.students.length) {
        t.appendChild(el2('div', 'empty', 'Пока нет учеников. Создайте код выше и отправьте его ученикам.'));
      } else {
        const table = el2('div', 'student-table');
        table.appendChild(el2('div', 'st-row st-head', `
          <span>Ученик</span><span>Уроки</span><span>Балл</span><span>Точность</span>
          <span>Карточки</span><span>Дней</span><span>Активность</span><span>Оценка</span><span></span>`));
        data.students.forEach(s => {
          const row = el2('div', 'st-row');
          row.innerHTML = `
            <span class="st-name"><b>${esc(s.display_name)}</b><i>@${esc(s.username)}</i></span>
            <span>${s.lessons_done}/${s.lessons_total}</span>
            <span class="${s.avg_score >= 80 ? 'ok' : s.avg_score >= 50 ? 'mid' : 'bad'}">${s.avg_score}%</span>
            <span>${s.accuracy}%</span>
            <span>${s.cards}</span>
            <span>${s.streak}</span>
            <span class="st-when">${s.active_today ? 'сегодня' : timeAgo(s.last_active)}</span>
            <span class="st-grade">${s.grade ? esc(s.grade) : '—'}</span>
            <span class="st-acts"></span>`;
          const acts = row.querySelector('.st-acts');
          const view = el2('button', 'btn btn-sm', '👁');
          view.onclick = () => openStudent(s.id, reload);
          const grade = el2('button', 'btn btn-sm', '✍️');
          grade.onclick = () => openStudent(s.id, reload, true);
          acts.appendChild(view); acts.appendChild(grade);
          table.appendChild(row);
        });
        t.appendChild(table);
      }
      wrap.appendChild(t);
    };

    function fmtDur(sec) {
      sec = Math.max(0, Number(sec || 0));
      if (sec < 60) return sec + ' сек';
      if (sec < 3600) return Math.floor(sec / 60) + ' мин';
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
      return h + ' ч ' + m + ' мин';
    }
    function fmtBytes(b) {
      b = Number(b || 0);
      if (b < 1024) return b + ' Б';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' КБ';
      return (b / (1024 * 1024)).toFixed(2) + ' МБ';
    }

    function paintSystem() {
      const sp = el2('div', 'panel');
      sp.appendChild(el2('h3', '', '🖥 Состояние сервера и базы данных'));
      if (!sys) {
        sp.appendChild(el2('div', 'empty', 'Не удалось получить статус сервера.'));
        wrap.appendChild(sp);
        return;
      }
      const c = sys.counts || {};
      const grid = el2('div', 'stat-grid');
      grid.innerHTML = `
        <div><b class="ok">Работает ✓</b><span>сервер (Python ${esc(sys.python_version)})</span></div>
        <div><b>${fmtDur(sys.uptime_sec)}</b><span>время работы</span></div>
        <div><b>${fmtBytes(sys.db_size_bytes)}</b><span>размер базы app.db</span></div>
        <div><b>${c.users || 0}</b><span>пользователей (${c.students || 0} уч.)</span></div>
        <div><b>${c.sessions_active || 0}</b><span>активных сессий</span></div>
        <div><b class="${(c.errors || 0) ? 'bad' : 'ok'}">${c.errors || 0}</b><span>ошибок в журнале</span></div>`;
      sp.appendChild(grid);

      const act = el2('div', 'btn-row');
      const bk = el2('button', 'btn btn-primary', '💾 Скачать резервную копию (app.db)');
      bk.onclick = async () => {
        try {
          const headers = {};
          const t = getToken();
          if (t) headers.Authorization = 'Bearer ' + t;
          const res = await fetch('/api/system/backup', { credentials: 'omit', headers });
          if (!res.ok) throw new Error(res.status);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'chinese-app-backup.db';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          toast('Резервная копия скачана');
        } catch (e) { toast('Ошибка скачивания копии'); }
      };
      const rf = el2('button', 'btn btn-ghost', '🔄 Обновить');
      rf.onclick = () => reload();
      const cp = el2('button', 'btn btn-ghost', '📋 Скопировать отчёт');
      cp.onclick = () => {
        const lines = [
          `汉语学习 — Отчёт системы (${new Date().toLocaleString('ru-RU')})`,
          `Python: ${sys.python_version} | Uptime: ${fmtDur(sys.uptime_sec)} | DB: ${fmtBytes(sys.db_size_bytes)}`,
          `Users: ${c.users} (students: ${c.students}) | Sessions: ${c.sessions_active} | Errors: ${c.errors}`,
          ...(sys.errors || []).slice(0, 20).map(e =>
            `[${new Date(e.created_at * 1000).toISOString()}] (${e.source}${e.username ? ' @' + e.username : ''}) ${e.message}${e.detail ? '\n  ' + e.detail.replace(/\n/g, ' | ') : ''}`)
        ].join('\n');
        navigator.clipboard?.writeText(lines);
        toast('Отчёт скопирован — можно вставить в чат');
      };
      const cl = el2('button', 'btn btn-ghost', '🧹 Очистить журнал');
      cl.onclick = async () => {
        await api('/api/system/errors/clear', { method: 'POST', body: {} });
        toast('Журнал очищен');
        reload();
      };
      act.appendChild(bk); act.appendChild(rf); act.appendChild(cp); act.appendChild(cl);
      sp.appendChild(act);
      wrap.appendChild(sp);

      const ep = el2('div', 'panel');
      ep.appendChild(el2('h3', '', `🪵 Журнал ошибок (${(sys.errors || []).length})`));
      if (!(sys.errors || []).length) {
        ep.appendChild(el2('div', 'empty', 'Ошибок нет ✓'));
      } else {
        const list = el2('div', 'sys-errors');
        (sys.errors || []).forEach(e => {
          const item = el2('div', 'sys-err');
          item.innerHTML = `
            <div class="se-head">
              <span class="se-badge ${e.source === 'server' ? 'se-srv' : 'se-cli'}">${e.source === 'server' ? 'Сервер' : 'Браузер'}</span>
              <b>${esc(e.message)}</b>
              <i>${e.username ? '@' + esc(e.username) + ' · ' : ''}${timeAgo(e.created_at)}</i>
            </div>
            ${e.detail ? `<pre class="se-det">${esc(e.detail)}</pre>` : ''}`;
          list.appendChild(item);
        });
        ep.appendChild(list);
      }
      wrap.appendChild(ep);
    }

    /* --- карточка ученика --- */
    async function openStudent(id, refresh, focusGrade = false) {
      let d;
      try { d = await api('/api/class/students/' + id); } catch (e) { toast('Не удалось загрузить'); return; }
      const ov = document.createElement('div');
      ov.className = 'overlay';
      const modal = document.createElement('div');
      modal.className = 'panel modal';
      const s = d.summary;
      modal.innerHTML = `
        <div class="modal-head"><h2>${esc(d.user.display_name)} <span class="lvl-chip">${ROLE_RU[d.user.role]}</span></h2>
        <button class="modal-x">✕</button></div>
        <div class="stat-grid">
          <div><b>${s.lessons_done}/${s.lessons_total}</b><span>уроков</span></div>
          <div><b>${s.avg_score}%</b><span>средний балл</span></div>
          <div><b>${s.accuracy}%</b><span>точность</span></div>
          <div><b>${s.cards}</b><span>карточек</span></div>
          <div><b>${s.streak}</b><span>дней подряд</span></div>
          <div><b>${s.answers}</b><span>ответов</span></div>
        </div>
        <h3>Баллы по урокам</h3>
        <div class="lesson-bars">${Object.entries(s.lesson_scores || {}).map(([k, v]) => {
          const L = window.__lessonTitle ? window.__lessonTitle(k) : k;
          return `<div class="lb"><span>${esc(L)}</span><div class="lb-bar"><i style="width:${v}%"></i></div><b>${v}%</b></div>`;
        }).join('') || '<span class="empty">Нет данных</span>'}</div>
        <h3>Оценка и комментарий</h3>
        <div class="grade-edit">
          <input class="g-input" placeholder="Оценка (напр. 85 или 5)" value="${esc(d.grade?.grade || '')}">
          <input class="g-input wide" placeholder="Комментарий учителя" value="${esc(d.grade?.comment || '')}">
          <button class="btn btn-primary g-save">Сохранить</button>
        </div>
        <h3>Активность</h3>
        <div class="events">${(d.events || []).slice(0, 12).map(e =>
          `<div class="ev"><span>${esc(e.kind)}</span><span>${esc(e.detail || '')}</span><i>${timeAgo(e.created_at)}</i></div>`).join('') || '<span class="empty">Пока пусто</span>'}</div>
        <div class="modal-foot">
          <button class="btn btn-ghost m-reset">Сбросить прогресс</button>
          <button class="btn btn-danger m-del">Удалить ученика</button>
          ${user?.role === 'owner' ? '<button class="btn btn-ghost m-role">Сделать учителем</button>' : ''}
        </div>`;
      ov.appendChild(modal);
      root.appendChild(ov);
      const close = () => ov.remove();
      modal.querySelector('.modal-x').onclick = close;
      ov.onclick = e => { if (e.target === ov) close(); };

      modal.querySelector('.g-save').onclick = async () => {
        const g = modal.querySelector('.g-input').value.trim();
        const c = modal.querySelector('.g-input.wide').value.trim();
        await api('/api/class/grade', { method: 'POST', body: { student_id: id, grade: g, comment: c } });
        toast('Оценка сохранена');
        close(); refresh();
      };
      modal.querySelector('.m-reset').onclick = async () => {
        if (!confirm('Сбросить весь прогресс ученика?')) return;
        await api('/api/class/reset', { method: 'POST', body: { student_id: id } });
        toast('Прогресс сброшен'); close(); refresh();
      };
      modal.querySelector('.m-del').onclick = async () => {
        if (!confirm('Удалить ученика без возможности восстановления?')) return;
        await api('/api/class/delete', { method: 'POST', body: { student_id: id } });
        toast('Ученик удалён'); close(); refresh();
      };
      const roleBtn = modal.querySelector('.m-role');
      if (roleBtn) roleBtn.onclick = async () => {
        await api('/api/class/role', { method: 'POST', body: { user_id: id, role: 'teacher' } });
        toast('Статус изменён'); close(); refresh();
      };
      if (focusGrade) setTimeout(() => modal.querySelector('.g-input').focus(), 60);
    }

    paint();
  }

  function timeAgo(ts) {
    if (!ts) return '—';
    const s = Math.floor((Date.now() - ts * 1000) / 1000);
    if (s < 60) return 'только что';
    if (s < 3600) return Math.floor(s / 60) + ' мин назад';
    if (s < 86400) return Math.floor(s / 3600) + ' ч назад';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' дн назад';
    return new Date(ts * 1000).toLocaleDateString('ru-RU');
  }

  function el2(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toast(msg) { if (window.toast) window.toast(msg); }

  return {
    boot, needsAuth, renderAuth, renderClass, persist,
    login, logout, register,
    get user() { return user; },
    get online() { return online; },
    get hasUsers() { return hasUsers; },
    ROLE_RU
  };
})();
// const не создаёт свойство window — выставляем явно
window.Auth = Auth;
