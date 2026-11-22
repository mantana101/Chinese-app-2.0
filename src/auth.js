/* ============================================================
   Авторизация, синхронизация прогресса и учительская панель
   ============================================================ */

const Auth = (() => {
  let user = null;          // {id, username, display_name, role}
  let myGrade = null;       // {grade, comment, updated_at}
  let online = false;       // доступен ли сервер
  let hasUsers = false;     // есть ли аккаунты на сервере
  let syncTimer = null;
  let pending = null;
  let lastSync = 0;
  let serverUpdated = 0;   // версия прогресса на сервере (для защиты от затирания)
  let conflictRetries = 0;

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
      if (res.status === 401) onSessionLost();
      throw err;
    }
    return data;
  }

  /* Сессия истекла или отозвана. Раньше это проходило незаметно: интерфейс
     продолжал показывать «вы вошли», а каждое сохранение тихо проваливалось.
     Локальный прогресс при этом не теряется — он остаётся в браузере. */
  function onSessionLost() {
    if (!getToken() && !user) return;
    setToken('');
    user = null;
    myGrade = null;
    serverUpdated = 0;
    conflictRetries = 0;
    try {
      if (typeof window !== 'undefined' && window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent('auth:expired'));
      }
    } catch (e) { }
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
  let serverBuild = '';

  /* Версия этой страницы — метка, которую вписал build.py при сборке. */
  function pageBuild() {
    try {
      const m = document.querySelector('meta[name="app-build"]');
      return (m && m.getAttribute('content')) || '';
    } catch (e) { return ''; }
  }

  /* Браузер мог открыть старую страницу из кэша. Если сервер отдаёт другую
     сборку — предупреждаем и даём кнопку «Обновить» (одна, чтобы не мешать). */
  function checkBuildFreshness() {
    const mine = pageBuild();
    if (!mine || !serverBuild || mine === serverBuild) return;
    /* Дети не читают баннеры: если увидели устаревшую копию — перезагружаемся
       сами, один раз за сессию (иначе гонка, если сервер отдаёт старое). */
    try {
      const key = 'zh_reloaded_' + serverBuild;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        hardReload();
        return;
      }
    } catch (e) { /* приватный режим — остаётся баннер */ }
    if (document.getElementById('buildOutdated')) return;
    const bar = document.createElement('div');
    bar.id = 'buildOutdated';
    bar.className = 'frame-banner build-outdated';
    bar.innerHTML = `<span>🔄 <b>Доступна новая версия программы.</b> Вы смотрите сохранённую копию (${mine}), на сервере уже ${serverBuild}.</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-primary';
    btn.textContent = 'Обновить';
    btn.onclick = () => {
      btn.disabled = true;
      btn.textContent = 'Обновляем…';
      hardReload();
    };
    bar.appendChild(btn);
    document.body.prepend(bar);
  }

  /* Полная перезагрузка в обход кэша браузера. */
  function hardReload() {
    try {
      const url = new URL(location.href);
      url.searchParams.set('v', (serverBuild || Date.now().toString(36)));
      location.replace(url.toString());
    } catch (e) {
      location.reload();
    }
  }

  /* Лёгкая проверка версии без полной перезагрузки состояния. */
  async function checkBuild() {
    if (!online) return;
    try {
      const st = await api('/api/auth/status');
      serverBuild = st.build || '';
      checkBuildFreshness();
    } catch (e) { }
  }

  async function boot() {
    try {
      const st = await api('/api/auth/status');
      online = true;
      hasUsers = !!st.has_users;
      serverBuild = st.build || '';
      checkBuildFreshness();
    } catch (e) {
      online = false;
      hasUsers = false;
    }
    if (online) {
      try {
        const me = await api('/api/auth/me');
        user = me.user;
        myGrade = me.grade || null;
        await pullProgress();
      } catch (e) { user = null; myGrade = null; }
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
    serverUpdated = 0; conflictRetries = 0;
    try { const me = await api('/api/auth/me'); myGrade = me.grade || null; } catch (e) { myGrade = null; }
    await pullProgress();
    return user;
  }

  async function register({ code, display_name, username, password }) {
    const r = await api('/api/auth/register', { method: 'POST', body: { code, display_name, username, password } });
    user = r.user;
    myGrade = null;
    hasUsers = true;
    if (r.token) setToken(r.token);
    serverUpdated = 0; conflictRetries = 0;
    await pullProgress();
    return user;
  }

  async function changePassword(current, next) {
    return api('/api/auth/password', { method: 'POST', body: { current, new: next } });
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { }
    setToken('');
    user = null;
    myGrade = null;
  }

  /* ---------- синхронизация прогресса ---------- */
  async function pullProgress() {
    if (!user) return;
    try {
      const r = await api('/api/progress');
      serverUpdated = Number(r.updated_at) || 0;
      const server = (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload))
        ? r.payload : {};
      const local = window.__state ? window.__state() : null;
      const serverHas = Object.keys(server.lessons || {}).length > 0;
      const localHas = !!local && Object.keys(local.lessons || {}).length > 0;

      if (!serverHas && localHas) {
        // Локально есть, на сервере пусто — отправляем локальное.
        persist(true);
      } else if (serverHas && !localHas) {
        window.__setState(Object.assign({}, local || {}, server));
      } else if (serverHas && localHas) {
        // Оба непустые: объединяем, а не перезаписываем — иначе занятия
        // на телефоне и компьютере стирали бы друг друга.
        const before = JSON.stringify(local);
        if (window.__mergeProgress) window.__mergeProgress(server);
        if (window.__state && JSON.stringify(window.__state()) !== before) persist(true);
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
      api('/api/progress', { method: 'PUT', body: { payload, base_updated: serverUpdated } })
        .then((r) => {
          lastSync = Date.now();
          pending = null;
          conflictRetries = 0;
          serverUpdated = Number(r && r.updated_at) || serverUpdated;
        })
        .catch((err) => {
          // 401 уже обработан в api().
          if (err && err.status === 401) return;
          if (err && err.status === 409 && err.data && err.data.payload) {
            // Другое устройство сохранило новее: объединяем и повторяем.
            if (window.__mergeProgress) window.__mergeProgress(err.data.payload);
            serverUpdated = Number(err.data.updated_at) || serverUpdated;
            if (++conflictRetries <= 3) {
              clearTimeout(syncTimer);
              syncTimer = setTimeout(send, 300);
            }
            return;
          }
          // Сеть или сервер: повторяем позже, чтобы прогресс не осел
          // только в браузере.
          clearTimeout(syncTimer);
          syncTimer = setTimeout(send, 5000);
        });
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
        fPass = field('Пароль (минимум 8 символов)', 'password', 'password', '••••••');
        fPass.inp.minLength = 8;
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
            if (fPass.inp.value.length < 8) {
              throw new Error('weak_password');
            }
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
            weak_password: 'Пароль слишком короткий (минимум 8 символов)',
            bad_password: 'Текущий пароль указан неверно',
            password_too_long: 'Пароль слишком длинный (максимум 256 символов)',
            cannot_touch_owner: 'Владельца аккаунта изменить нельзя',
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

      {
        const tabs = el2('div', 'tabs');
        const errN = sys?.counts?.errors || 0;
        const onN = data.online_count || 0;
        [['live', `🟢 Кто онлайн${onN ? ` (${onN})` : ''}`], ['class', '📋 Ученики и коды'], ['hw', '🏠 Домашки'], ['system', `🛠 Состояние системы${errN ? ` (${errN})` : ''}`]].forEach(([id, label]) => {
          const b = el2('button', 'tab' + (tab === id ? ' active' : ''), label);
          b.onclick = () => { tab = id; paint(); };
          tabs.appendChild(b);
        });
        wrap.appendChild(tabs);
      }

      if (tab === 'live') {
        paintLive();
        /* Пока вкладка открыта, обновляем список сам: «сейчас на сайте»
           устаревает за минуты, а нажимать «обновить» никто не будет. */
        if (!window.__liveTimer) {
          window.__liveTimer = setInterval(async () => {
            if (tab !== 'live' || !document.body.contains(wrap)) {
              clearInterval(window.__liveTimer); window.__liveTimer = null; return;
            }
            try { await loadData(); paint(); } catch (e) { }
          }, 30000);
        }
        return;
      }
      if (tab === 'hw') {
        paintHomework();
        return;
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

    /* --- домашки: проверка --- */
    let hwCache = null;
    async function paintHomework() {
      const panel = el2('div', 'panel');
      panel.appendChild(el2('h3', '', '🏠 Домашние задания учеников'));
      panel.appendChild(el2('p', 'page-sub',
        'Работы, которые ученики выполнили и отправили на сайте. Красным — ждут проверки.'));
      wrap.appendChild(panel);

      if (!hwCache) {
        try { hwCache = await api('/api/class/homework'); } catch (e) { hwCache = null; }
      }
      if (!hwCache) {
        panel.appendChild(el2('div', 'empty', 'Не удалось загрузить домашки.'));
        return;
      }
      const head = el2('div', 'btn-row');
      const info = el2('span', 'page-sub',
        `Всего работ: ${hwCache.total} · проверено: ${hwCache.graded}` +
        (hwCache.avg != null ? ` · средний балл: ${hwCache.avg}%` : ''));
      const refresh = el2('button', 'btn btn-sm btn-ghost', '↻ Обновить');
      refresh.onclick = async () => { hwCache = null; tab = 'hw'; paint(); };
      head.appendChild(refresh);
      head.appendChild(info);
      panel.appendChild(head);

      if (!hwCache.items.length) {
        panel.appendChild(el2('div', 'empty', 'Пока никто не отправил домашку.'));
        return;
      }

      const list = el2('div', 'hw-teach');
      hwCache.items.forEach(it => {
        const waiting = it.score == null;
        const row = el2('div', 'hw-teach-row' + (waiting ? ' waiting' : ''));
        const title = (window.LESSONS && window.LESSONS[it.lesson_id]?.title) || it.lesson_id;
        row.innerHTML = `
          <span><b>${esc(it.student)}</b><br><i>@${esc(it.username)}</i></span>
          <span>${esc(title)}<br><i>${Object.keys(it.answers || {}).length} ответов · ${timeAgo(it.updated_at)}</i></span>
          <span class="st-grade">${waiting ? '⏳ ждёт' : it.score + '%'}</span>
          <span><i>${it.feedback ? esc(it.feedback.slice(0, 40)) : '—'}</i></span>
          <span class="st-acts"></span>`;
        const acts = row.querySelector('.st-acts');
        const open = el2('button', 'btn btn-sm btn-primary', waiting ? 'Проверить' : 'Открыть');
        open.onclick = () => openHomework(it, async () => { hwCache = null; tab = 'hw'; paint(); });
        acts.appendChild(open);
        list.appendChild(row);
      });
      panel.appendChild(list);
    }

    /* Карточка работы: все ответы ученика и выставление оценки. */
    function openHomework(it, refresh) {
      const tasks = (window.homeworkFor ? window.homeworkFor(it.lesson_id) : []);
      const title = (window.LESSONS && window.LESSONS[it.lesson_id]?.title) || it.lesson_id;
      const ov = document.createElement('div');
      ov.className = 'overlay';
      const modal = document.createElement('div');
      modal.className = 'panel modal';
      const rows = tasks.map((task, i) => {
        const raw = it.answers['hw' + i];
        let shown = raw;
        if ((task.k === 'mcq' || task.k === 'read') && raw !== undefined) {
          const idx = Number(raw);
          const chosen = (task.o || [])[idx] || '—';
          const mark = idx === task.a ? '✅' : '❌';
          shown = `${mark} ${chosen}` + (idx === task.a ? '' : `   (верно: ${(task.o || [])[task.a] || '—'})`);
        }
        if (task.k === 'order' && raw) {
          const words = String(raw).split(',').filter(Boolean).map(x => (task.o || [])[Number(x)] || '').join(' ');
          shown = words;
        }
        return `<div class="hw-answer">
            <div class="aq">${i + 1}. ${esc(task.q)}</div>
            <div class="aa ${shown ? '' : 'empty-ans'}">${shown ? esc(shown) : 'нет ответа'}</div>
          </div>`;
      }).join('');

      modal.innerHTML = `
        <div class="modal-head"><h2>${esc(it.student)} · ${esc(title)}</h2>
        <button class="modal-x" aria-label="Закрыть">✕</button></div>
        <p class="page-sub">Отправлено ${timeAgo(it.updated_at)}${it.graded_at ? ' · проверено ' + timeAgo(it.graded_at) : ''}</p>
        <div class="hw-answers">${rows || '<div class="empty">Заданий не найдено</div>'}</div>
        <h3>Оценка работы</h3>
        <div class="hw-graded-box">
          <input class="g-input hw-score" type="number" min="0" max="100" placeholder="0–100"
                 value="${it.score == null ? '' : it.score}">
          <input class="g-input wide hw-fb" placeholder="Комментарий для ученика"
                 value="${esc(it.feedback || '')}">
          <button class="btn btn-primary hw-save">Сохранить оценку</button>
        </div>
        <div class="hw-note">Ученик увидит оценку и комментарий в разделе «Домашки» и на странице урока.</div>`;
      ov.appendChild(modal);
      root.appendChild(ov);
      const close = () => ov.remove();
      modal.querySelector('.modal-x').onclick = close;
      ov.onclick = e => { if (e.target === ov) close(); };
      modal.querySelector('.hw-save').onclick = async () => {
        const score = parseInt(modal.querySelector('.hw-score').value, 10);
        if (!(score >= 0 && score <= 100)) { toast('Оценка — число от 0 до 100'); return; }
        const feedback = modal.querySelector('.hw-fb').value.trim();
        try {
          await api('/api/class/homework/grade', {
            method: 'POST',
            body: { student_id: it.student_id, lesson_id: it.lesson_id, score, feedback }
          });
          toast('Оценка сохранена');
          close();
          refresh();
        } catch (e) { toast('Не удалось сохранить'); }
      };
    }

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

    /* --- Кто сейчас на сайте ---
       Учителю важно видеть не только оценки, но и кто реально заходит:
       «активен 2 минуты назад» или «не заходил неделю». Данные берём из
       отметок сессий на сервере (не чаще раза в минуту на человека). */
    function paintLive() {
      const on = data.online || [];
      const win = Math.round((data.online_window_sec || 300) / 60);

      const head = el2('div', 'panel');
      head.appendChild(el2('h3', '', '🟢 Кто сейчас на сайте'));
      head.appendChild(el2('p', 'page-sub',
        `Считается активным, если заходил за последние ${win} мин. Всего в классе: ${data.count}.`));

      const grid = el2('div', 'stat-grid');
      const activeToday = (data.students || []).filter(s => s.active_today).length;
      const gone = (data.students || []).filter(s => s.last_seen && (data.server_time - s.last_seen) > 86400 * 7).length;
      grid.innerHTML = `
        <div><b class="ok">${on.length}</b><span>сейчас на сайте</span></div>
        <div><b>${activeToday}</b><span>занимались сегодня</span></div>
        <div><b>${data.count}</b><span>учеников в классе</span></div>
        <div><b class="${gone ? 'bad' : 'ok'}">${gone}</b><span>не заходят 7+ дней</span></div>`;
      head.appendChild(grid);

      /* список тех, кто онлайн */
      const livePanel = el2('div', 'panel');
      livePanel.appendChild(el2('h3', '', 'Сейчас в приложении'));
      if (!on.length) {
        livePanel.appendChild(el2('div', 'empty', 'Сейчас никого нет. Загляните позже — список обновляется сам.'));
      } else {
        const ul = el2('div', 'live-list');
        on.forEach(p => {
          const row = el2('div', 'live-row');
          row.innerHTML = `<span class="live-dot"></span>
            <span class="live-name"><b>${esc(p.display_name)}</b>
              <i>${p.role === 'owner' ? 'владелец' : p.role === 'teacher' ? 'учитель' : 'ученик'}</i></span>
            <span class="live-when">${timeAgo(p.seen)}</span>`;
          ul.appendChild(row);
        });
        livePanel.appendChild(ul);
      }
      const rf = el2('button', 'btn btn-sm btn-ghost', '↻ Обновить');
      rf.onclick = () => reload();
      livePanel.appendChild(rf);
      wrap.appendChild(livePanel);

      /* занятия по дням: столбики за две недели */
      const days = data.days || [];
      if (days.length) {
        const chart = el2('div', 'panel');
        chart.appendChild(el2('h3', '', '📈 Заходы за две недели'));
        chart.appendChild(el2('p', 'page-sub', 'Сколько учеников заходило в приложение каждый день.'));
        const max = Math.max(1, ...days.map(d => d.users));
        const bars = el2('div', 'days-chart');
        days.forEach(d => {
          const col = el2('div', 'day-col');
          const h = Math.round((d.users / max) * 100);
          col.innerHTML = `<div class="day-bar${d.users ? '' : ' off'}" style="height:${Math.max(6, h)}%"
              title="${d.users} чел."></div>
            <span class="day-num">${d.users || ''}</span>
            <span class="day-lbl">${new Date(d.day * 1000).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}</span>`;
          bars.appendChild(col);
        });
        chart.appendChild(bars);
        wrap.appendChild(chart);
      }

      /* кто давно не заходил — сюда учитель смотрит в первую очередь */
      const absent = (data.students || [])
        .filter(s => !s.online)
        .sort((a, b) => (a.last_seen || 0) - (b.last_seen || 0))
        .slice(0, 8);
      const miss = el2('div', 'panel');
      miss.appendChild(el2('h3', '', '⏰ Давно не заходили'));
      if (!absent.length) {
        miss.appendChild(el2('div', 'empty', 'Все ученики на месте.'));
      } else {
        const table = el2('div', 'live-list');
        absent.forEach(s => {
          const row = el2('div', 'live-row');
          const late = s.last_seen && (data.server_time - s.last_seen) > 86400 * 3;
          row.innerHTML = `<span class="live-dot off"></span>
            <span class="live-name"><b>${esc(s.display_name)}</b><i>уроков: ${s.lessons_done}/${s.lessons_total}</i></span>
            <span class="live-when ${late ? 'bad' : ''}">${s.last_seen ? timeAgo(s.last_seen) : 'ещё не заходил'}</span>`;
          miss.appendChild(row);
        });
      }
      wrap.appendChild(miss);
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
        <div><b class="${(c.errors || 0) ? 'bad' : 'ok'}">${c.errors || 0}</b><span>ошибок в журнале</span></div>
        <div><b>${esc(sys.build || '—')}</b><span>версия сборки на сервере</span></div>
        <div><b>${esc(pageBuild() || '—')}</b><span>версия страницы в браузере</span></div>`;
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
    /* Временный пароль: без похожих символов (0/O, 1/l/I), чтобы его
       можно было продиктовать ученику без ошибок. */
    function genTempPassword(len = 10) {
      const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
      let out = '';
      const buf = new Uint32Array(len);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(buf);
      else for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 1e9);
      for (let i = 0; i < len; i++) out += abc[buf[i] % abc.length];
      return out;
    }

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
        <button class="modal-x" aria-label="Закрыть">✕</button></div>
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
        <h3>Домашние задания</h3>
        <div class="hw-answers">${(d.homework || []).map(h => {
          const t = window.LESSONS && window.LESSONS[h.lesson_id] ? window.LESSONS[h.lesson_id].title : h.lesson_id;
          const n = Object.keys(h.answers || {}).length;
          const mark = h.score == null ? '⏳ ждёт проверки' : '✓ ' + h.score + '%';
          return `<div class="hw-answer"><div class="aq">${esc(t)} · ${n} ответов · ${timeAgo(h.updated_at)}</div>
            <div class="aa">${esc(mark)}${h.feedback ? ' — ' + esc(h.feedback) : ''}</div></div>`;
        }).join('') || '<span class="empty">Домашек пока нет</span>'}</div>
        <h3>Активность</h3>
        <div class="events">${(d.events || []).slice(0, 12).map(e =>
          `<div class="ev"><span>${esc(e.kind)}</span><span>${esc(e.detail || '')}</span><i>${timeAgo(e.created_at)}</i></div>`).join('') || '<span class="empty">Пока пусто</span>'}</div>
        <div class="modal-foot">
          <button class="btn btn-ghost m-pass">🔑 Сбросить пароль</button>
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
      modal.querySelector('.m-pass').onclick = async () => {
        const temp = genTempPassword();
        if (!confirm(`Сбросить пароль ученика?\n\nНовый пароль: ${temp}\n\nПередайте его ученику — старый пароль и все его сессии перестанут работать.`)) return;
        try {
          await api('/api/class/password', { method: 'POST', body: { student_id: id, new_password: temp } });
          toast('Пароль сброшен: ' + temp);
        } catch (e) { toast('Не удалось сбросить пароль'); }
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
    build: pageBuild, serverBuild: () => serverBuild, hardReload, checkBuild,
    login, logout, register, changePassword,
    get user() { return user; },
    get grade() { return myGrade; },
    get online() { return online; },
    get hasUsers() { return hasUsers; },
    ROLE_RU
  };
})();
// const не создаёт свойство window — выставляем явно
window.Auth = Auth;
