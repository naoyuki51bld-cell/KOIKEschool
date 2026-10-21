// ホーム画面のアプリ用。画面のファイルは毎回ネットから取り、つながらないときだけ前回の分を使う。
// （先生が直した最新版がすぐ届くように、キャッシュを先には使わない）
// データ（Firestore）は別のサーバーなので、ここでは扱わない。
const CACHE = 'math-board-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (cached) return cached;
      throw err;
    }
  })());
});
