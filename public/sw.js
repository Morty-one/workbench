// 个人轻量工作台 · 极简 Service Worker
// 作用：首次加载后缓存静态资源，支持离线 / 安装到桌面。
// 策略：导航请求「网络优先 + Navigation Preload」（始终拉最新 index.html，避免旧 hash JS 导致白屏）；
//       其余同源资源缓存优先。跨域请求（GitHub API 等）一律直连不缓存。
// v5：① precache 改为非原子（单资源失败不再拖垮安装）② 开启 Navigation Preload（iOS 冷启动更稳）
//     ③ 导航网络优先、后台刷新缓存，旧缓存仅作断网兜底 ④ 版本号 v5 清空 v1~v4 全部旧缓存
const CACHE = 'wb-shell-v5'
const PRECACHE = [
  './',
  './index.html',
  './icon.svg',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
]

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE)
      // 非原子预缓存：单个资源 404 / 异常不影响整体安装，避免「装不上 → 旧 SW 长期兜白屏」
      await Promise.allSettled(PRECACHE.map((u) => c.add(u).catch(() => {})))
      await self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      // 1) 清掉所有旧版本缓存（v1/v2/v3/v4 …），杜绝残留旧 index.html
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      // 2) 开启 Navigation Preload：iOS 冷启动（含 standalone 首次启动）导航抓取更可靠
      try {
        await self.registration.navigationPreload.enable()
      } catch (_) {
        /* 不支持则忽略 */
      }
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // 跨域请求（api.github.com 等）直连，不进缓存 —— 云端同步必须拿到最新快照
  if (url.origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    e.respondWith(
      (async () => {
        // 优先用 Navigation Preload 已预取的响应（iOS standalone 冷启动最稳）
        try {
          const preload = await e.preloadResponse
          if (preload) return preload
        } catch (_) {}
        try {
          const net = await fetch(req)
          const c = await caches.open(CACHE)
          c.put(req, net.clone()) // 按实际 URL 缓存最新外壳
          return net
        } catch (_) {
          // 断网兜底：回退任何已缓存的外壳
          const cached =
            (await caches.match(req)) ||
            (await caches.match('./index.html')) ||
            (await caches.match('./'))
          return cached || Response.error()
        }
      })()
    )
    return
  }

  // 同源静态资源：缓存优先，缺失再网络并补缓存
  e.respondWith(
    (async () => {
      const hit = await caches.match(req)
      if (hit) return hit
      try {
        const net = await fetch(req)
        const c = await caches.open(CACHE)
        c.put(req, net.clone())
        return net
      } catch (_) {
        return hit || Response.error()
      }
    })()
  )
})
