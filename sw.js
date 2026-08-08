// ===== Zohir PWA Service Worker =====
const CACHE_NAME = 'zohir-v74-priced-import';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/favicon.ico',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;600;700;900&display=swap'
];

// ===== INSTALL: cache static assets =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache each asset individually so one failure doesn't block all
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('Failed to cache:', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ===== ACTIVATE: clean old caches =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// A cache miss makes caches.match() resolve to undefined, and passing
// undefined to respondWith() throws "Failed to convert value to 'Response'",
// which the browser surfaces as net::ERR_FAILED — the page then loads with no
// CSS and no JS. Every path below must therefore end in a real Response.
const OFFLINE_RESPONSE = () => new Response(
  '// offline: asset unavailable and not in cache',
  { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
);

// Cache lookups are query-sensitive, so "style.css?v=106" never matches a
// cached "style.css?v=105". Ignore the query when falling back.
function cacheLookup(request) {
  return caches.match(request).then(hit => hit || caches.match(request, { ignoreSearch: true }));
}

// ===== FETCH: Network first, fallback to cache =====
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and Firebase/Firestore requests (always need network)
  if (
    request.method !== 'GET' ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('securetoken.googleapis.com') ||
    url.hostname.includes('gstatic.com')
  ) {
    return; // let browser handle it
  }

  // For app shell (HTML, CSS, JS) — network first
  if (
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js') ||
    url.pathname === '/'
  ) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
          }
          return response;
        })
        .catch(() => cacheLookup(request).then(cached => {
          if (cached) return cached;
          // a navigation with nothing cached for it still needs the shell
          if (request.mode === 'navigate') {
            return caches.match('/index.html').then(shell => shell || caches.match('/'))
              .then(shell => shell || OFFLINE_RESPONSE());
          }
          return OFFLINE_RESPONSE();
        }))
    );
    return;
  }

  // For fonts and icons — cache first
  event.respondWith(
    cacheLookup(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
        }
        return response;
      }).catch(() => OFFLINE_RESPONSE());
    }).catch(() => OFFLINE_RESPONSE())
  );
});

// ===== PUSH NOTIFICATIONS (optional future use) =====
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'Zohir', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    dir: 'rtl',
    lang: 'ar'
  });
});
