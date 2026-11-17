/* Vocab Quest 离线缓存
   策略：页面导航走「网络优先，断网回落缓存」；静态资源走「缓存优先，顺手更新」。
   发布新版只需把 VERSION 加一，旧缓存会在 activate 时清掉。 */
const VERSION = "vq-v5";
const ASSETS = [
  "./",
  "./index.html",
  "./words.html",
  "./game.html",
  "./engine.js",
  "./fsrs.js",
  "./grammar.js",
  "./tts.js",
  "./stats.js",
  "./vocab.js",
  "./vocab_c6.js",
  "./vocab_cz.js",
  "./vocab_gz.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon-180.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // 逐个加，单个 404 不至于让整次安装失败
      .then((c) => Promise.all(ASSETS.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外链一律不接管

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match("./index.html"))
        )
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
