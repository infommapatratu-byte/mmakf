const CACHE = 'mmakf-v3';
const PRECACHE = ['/', '/manifest.webmanifest', '/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;

  // Network-first for navigations, cache-first for assets
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return r;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/')))
    );
  } else {
    e.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return r;
        }).catch(() => cached)
      )
    );
  }
});

// ─── Push ───────────────────────────────────────────────────────────────────
//
// This worker handled caching and nothing else, which is why src/lib/push.ts —
// a complete RFC 8291 / RFC 8292 implementation — could deliver to nobody. A
// browser will not keep a subscription alive for a worker that never shows a
// notification, so without these two handlers the whole transport was inert
// even once VAPID keys were set.
//
// WHAT ARRIVES. buildPushRequest() encrypts a JSON object of exactly four
// fields: { title, body, url, topic }. The browser decrypts it before this
// handler sees it. It carries a POINTER AND NEVER THE SUBSTANCE OF A DECISION —
// "Your grading result" and a link, not the result — because a push notification
// is rendered on a lock screen in front of whoever is holding the phone, and it
// travels through a push service the federation does not control. Nothing here
// should ever try to render more than it was given.

/** The fallback, used when a push arrives with no readable payload. */
const PUSH_FALLBACK = {
  title: 'MMAKF',
  body: 'There is something new in your notifications.',
  url: '/my/notifications',
  topic: 'UNKNOWN',
};

self.addEventListener('push', (e) => {
  // A SUBSCRIPTION IS userVisibleOnly, so a push event that shows no
  // notification is a broken promise the browser answers for us — Chrome
  // displays "This site has been updated in the background", which reads as a
  // bug and teaches the member to revoke permission. So every branch here ends
  // in showNotification(), including the ones where the payload is unusable.
  let data = PUSH_FALLBACK;
  try {
    if (e.data) {
      const parsed = e.data.json();
      data = {
        title: typeof parsed.title === 'string' && parsed.title ? parsed.title : PUSH_FALLBACK.title,
        body: typeof parsed.body === 'string' && parsed.body ? parsed.body : PUSH_FALLBACK.body,
        // Same-origin paths only. A push service is not trusted to hand this
        // worker a URL it will later open: anything that is not a root-relative
        // path is discarded rather than sanitised, because a rule that tries to
        // repair a hostile value is a rule with a bypass in it.
        url: typeof parsed.url === 'string' && /^\/[^/\\]/.test(parsed.url) ? parsed.url : PUSH_FALLBACK.url,
        topic: typeof parsed.topic === 'string' ? parsed.topic : PUSH_FALLBACK.topic,
      };
    }
  } catch {
    data = PUSH_FALLBACK;
  }

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/favicon-32.png',
      badge: '/favicon-32.png',
      // COLLAPSE BY TOPIC. Three membership reminders should replace one
      // another rather than stack three deep on a lock screen. Distinct topics
      // never collapse into each other, which is the part that matters: a
      // grading result must not silently replace a certificate withdrawal.
      tag: `mmakf:${data.topic}`,
      renotify: true,
      data: { url: data.url, topic: data.topic },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/my/notifications';

  e.waitUntil(
    (async () => {
      const url = new URL(target, self.location.origin);
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      // FOCUS AN OPEN TAB RATHER THAN OPENING A SECOND ONE. A member who
      // already has the site open and taps a notification should be taken to
      // it, not handed a duplicate window they then have to close.
      for (const client of clients) {
        if (new URL(client.url).origin !== url.origin) continue;
        if ('focus' in client) {
          await client.focus();
          // navigate() is not implemented everywhere and throws where it is
          // not. A focused tab on the wrong page beats an unhandled rejection
          // that loses the click entirely.
          if ('navigate' in client && client.url !== url.href) {
            try { await client.navigate(url.href); } catch { /* focused, not navigated */ }
          }
          return;
        }
      }
      await self.clients.openWindow(url.href);
    })()
  );
});

// A push service may retire an endpoint and hand the browser a new one. Without
// this the member's device goes quiet with nothing anywhere recording why: the
// row in push_devices still says `active` and every send fails against an
// endpoint nobody is listening to.
//
// It re-registers with the SAME code path a fresh subscription uses, so there is
// one way a device is recorded. `subscribe()` upserts on the endpoint, so the
// new row lands cleanly; the old one is left for deliverQueuedPush() to mark
// expired when it next fails, which is the honest record of what happened.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(
    (async () => {
      try {
        const next = e.newSubscription ?? (await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: e.oldSubscription?.options?.applicationServerKey,
        }));
        if (!next) return;
        const json = next.toJSON();
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            endpoint: next.endpoint,
            p256dh: json.keys && json.keys.p256dh,
            auth: json.keys && json.keys.auth,
          }),
        });
      } catch {
        // Nothing useful to do here and nobody to tell: there is no page open
        // to show an error to. The device stops receiving until the member next
        // opens /my/devices, which re-registers.
      }
    })()
  );
});
