/* Service worker: приложение должно открываться без интернета.
   Ученик часто едет в метро или сидит без сети — раньше в этот момент
   сайт не открывался вовсе, хотя весь курс и так лежит в одном файле. */
const CACHE = 'zh-app-v1';
// Словарь помощника тоже в оболочке: без сети он должен открыться.
const SHELL = ['./', './index.html', './lexicon.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  /* Запросы к API и страницу не кэшируем «навсегда»: данные должны быть
     свежими. Но если сети нет — отдаём последнюю сохранённую страницу,
     чтобы приложение всё-таки открылось. */
  if (url.pathname.startsWith('/api/')) return;

  const isPage = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html');
  if (isPage) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => hit))
  );
});
