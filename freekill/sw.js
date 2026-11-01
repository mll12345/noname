// 新月杀 Web 的 Service Worker
//
// 作用有两个：
//   1. 让这个子目录脱离父级（无名杀）的 Service Worker 管辖，避免被它的假后端截胡
//   2. 首次访问后离线可玩（Lua 内核、wasm、美术资源全都缓存下来）
//
// 缓存策略：
//   - 页面外壳（html/js/css/json）走 network-first，保证更新能生效
//   - 图片 / wasm 走 cache-first，它们不会变
//   - lua_bundle.js 很大但每次构建都变，也走 network-first

const VERSION = "fk-v1";
const CORE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./loader.js",
  "./assets_index.js",
  "./lua_bundle.js",
  "./pwa-manifest.json",
  "./wasmoon/index.js",
  "./wasmoon/glue.wasm",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(CORE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const NETWORK_FIRST = /\.(html|js|css|json|wasm)$/i;
const IMMUTABLE = /\.(png|jpg|jpeg|webp|gif|woff2?|ttf)$/i;

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 外壳和脚本：先联网，失败再用缓存
  if (NETWORK_FIRST.test(url.pathname) || req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // 图片：缓存优先
  if (IMMUTABLE.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          })
      )
    );
  }
});
