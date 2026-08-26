// 个人轻量工作台 · 极简 Service Worker
// 作用：首次加载后缓存应用外壳，支持离线 / 安装到桌面。
// 策略：导航请求网络优先（失败回退缓存），其余同源资源缓存优先。
// 注意：跨域请求（GitHub API 等）一律直连不缓存 —— 云端同步必须拿到最新快照。
const CACHE = 'wb-shell-v3'
const SHELL = ['./', './index.html', './icon.svg', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // 跨域请求（api.github.com 等）直连，不进缓存
  if (url.origin !== self.location.origin) return
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')))
    return
  }
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req)
          .then((res) => {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
            return res
          })
          .catch(() => hit)
    )
  )
})
