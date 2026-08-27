// 个人轻量工作台 · 极简 Service Worker
// 作用：首次加载后缓存应用外壳，支持离线 / 安装到桌面。
// 策略：导航请求网络优先（始终拉最新 index.html，避免旧 hash JS 导致白屏），其余同源资源缓存优先。
// 注意：跨域请求（GitHub API 等）一律直连不缓存 —— 云端同步必须拿到最新快照。
// v4：activate 时强制刷新 index.html 为最新，彻底消除「standalone 启动白屏」（旧 index 引用已不存在的 JS）。
const CACHE = 'wb-shell-v4'
const SHELL = ['./', './index.html', './icon.svg', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      // 1) 清掉旧版本缓存（v1/v2/v3 等）
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      // 2) 强制刷新外壳 index.html 为最新，杜绝旧 index 引用不存在的 JS hash
      const c = await caches.open(CACHE)
      try {
        const fresh = await fetch('./index.html', { cache: 'no-store' })
        if (fresh && fresh.ok) await c.put('./index.html', fresh.clone())
      } catch (_) {
        /* 离线时保留已有缓存 */
      }
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // 跨域请求（api.github.com 等）直连，不进缓存
  if (url.origin !== self.location.origin) return
  if (req.mode === 'navigate') {
    // 导航：网络优先，并缓存最新 index.html；离线时回退最新缓存
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('./index.html', copy))
          return res
        })
        .catch(() => caches.match('./index.html'))
    )
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
