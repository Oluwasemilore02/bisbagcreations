/* Bisbag Admin service worker.
   - Makes the admin installable and quick to open on slow networks.
   - Never touches Firestore / Auth / Google requests: live data always comes straight from Firebase.
   - Bump VERSION whenever you change the SHELL list. */
const VERSION = 'bb-admin-v1';
const SHELL = ['admin.html', 'bb-data.js', 'firebase-config.js', 'products.js', 'images/admin.webmanifest', 'images/apple-touch-icon.png', 'images/icon-192.png', 'images/icon-512.png', 'images/icon-maskable-512.png'];
const SDK = [
  'https://www.gstatic.com/firebasejs/11.10.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth-compat.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await Promise.all(SDK.map((u) => fetch(u).then((r) => (r.ok ? c.put(u, r) : null)).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Try the network first (so deployments show up), but give up after 3.5s and use the saved copy.
async function networkFirst(req) {
  const c = await caches.open(VERSION);
  try {
    const r = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3500))]);
    if (r && r.ok) c.put(req, r.clone());
    return r;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: true });
    return hit || fetch(req);
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Firebase SDK files are versioned and never change: serve the saved copy instantly.
  if (url.hostname === 'www.gstatic.com' && url.pathname.indexOf('/firebasejs/') === 0) {
    e.respondWith(caches.match(req.url).then((hit) => hit || fetch(req)));
    return;
  }
  // Our own files.
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(req)); }
  // Everything else (Firestore, Auth, Google Fonts, analytics) goes straight to the network.
});
