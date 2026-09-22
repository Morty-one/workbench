/* 浏览器偏好（第 43 轮）
 *
 * 分三层存放，各有各的理由：
 *  ① 浏览器清单 + 全局默认浏览器 → IndexedDB settings（browserList / defaultBrowserId）。
 *     链接级指定存的是**浏览器 id**（不是 exe 路径）—— 用户改了路径也只需改一处，链接不会失效。
 *  ② 窗口模式（最大化 / 记住上次尺寸）→ 必须经本地桥落盘 window-pref.json，因为启动脚本
 *     launch-workbench.ps1 在**网页加载之前**就要决定给浏览器传哪些参数，网页那时还不存在。
 *     ⇒ 这条设置天然是「下次重新打开工作台生效」。
 *  ③ 「检测本机常见浏览器」→ 由桥扫常见安装路径后回传（网页既读不到环境变量也读不到文件系统）。
 *
 * ⚠️ 为什么不进云端同步：exe 路径是**本机**属性，换电脑就失效；同步过去只会让另一台设备
 *    显示一堆找不到的路径。手机上本功能整体不生效（本地桥不存在），也不需要它生效。
 */
import { db } from '../db'

const BRIDGE = 'http://127.0.0.1:4567'

/** 「跟随系统默认浏览器」= 空 id（也就是现在的默认行为） */
export const FOLLOW_SYSTEM = ''

// 模块级缓存：点击链接那一刻要同步取到「该用哪个 exe」，不能等异步读库
let cacheList = []
let cacheDefaultId = FOLLOW_SYSTEM
let cacheLoaded = false

async function bridgeJson(path, opts) {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(BRIDGE + path + sep + '_=' + Date.now(), { cache: 'no-store', ...(opts || {}) })
  let data = {}
  try { data = await res.json() } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status))
  return data
}

function cleanList(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((b) => b && typeof b === 'object' && b.id)
    .map((b) => ({ id: String(b.id), name: String(b.name || ''), exe: String(b.exe || '') }))
}

/** 读一次库并填充缓存；force=true 时强制重读（保存后调用） */
export async function loadBrowserPrefs(force) {
  if (cacheLoaded && !force) return
  try {
    const l = await db.settings.get('browserList')
    const d = await db.settings.get('defaultBrowserId')
    cacheList = cleanList(l && l.value)
    cacheDefaultId = d && typeof d.value === 'string' ? d.value : FOLLOW_SYSTEM
    cacheLoaded = true
  } catch (e) {
    // 读不到就当作「没有配置」，一律退回系统默认，绝不让链接点击因此失败
    cacheList = []
    cacheDefaultId = FOLLOW_SYSTEM
    cacheLoaded = true
  }
}

export function getBrowserList() { return cacheList }
export function getDefaultBrowserId() { return cacheDefaultId }

/** 按 id 取 exe；找不到/没填路径 ⇒ 返回空串（调用方退回系统默认） */
export function browserExeById(id) {
  const key = String(id || '').trim()
  if (!key) return ''
  const b = cacheList.find((x) => x.id === key)
  return b && b.exe ? String(b.exe).trim() : ''
}

/** 全局默认浏览器的 exe（空串 = 跟随系统默认） */
export function defaultBrowserExe() { return browserExeById(cacheDefaultId) }

/**
 * 解析「这个链接该用哪个浏览器打开」。
 * link 可以是：
 *   - 链接对象 `{ url, label, browser }`（任务/子任务的跳转链接）
 *   - 快捷入口记录 `{ name, url, browser }`
 *   - 纯字符串（没有链接级设置的老代码路径）
 * 规则：链接级指定优先；指定了但那个浏览器已被删除/路径为空 ⇒ 退回全局默认；再没有 ⇒ 空串（系统默认）。
 */
export function browserForLink(link) {
  const own = (link && typeof link === 'object') ? String(link.browser || '').trim() : ''
  if (own) {
    const exe = browserExeById(own)
    if (exe) return exe
  }
  return defaultBrowserExe()
}

/* ---------- 窗口模式（经桥落盘，下次启动生效） ---------- */

export function getWindowMode() { return bridgeJson('/window-pref') }

export function setWindowMode(mode) {
  return bridgeJson('/window-pref', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  })
}

/* ---------- 探测本机浏览器 ---------- */

export async function detectBrowsers() {
  const d = await bridgeJson('/detect-browsers')
  // ⚠️ 不能走 cleanList：探测结果**没有 id**（id 是加入清单时才生成的），
  //    cleanList 要求 b.id 会把所有项过滤掉，表现为「一个都没扫到」。
  //    这里只按「有没有名字和路径」筛，形状统一成 {name, exe}。
  const raw = (d && d.browsers) || []
  if (!Array.isArray(raw)) return []
  return raw
    .filter((b) => b && typeof b === 'object' && b.exe)
    .map((b) => ({ name: String(b.name || ''), exe: String(b.exe) }))
    .filter((b) => b.exe)
}

/**
 * 调桥的系统文件选择框，用来挑一个浏览器 exe。
 * 返回值原样透出（ok / path / cancelled / error），由调用方决定提示文案
 * —— 不复用 docoutput.js 的 pickFile，那里的弹窗文案是「文档输出 A/B 文件」专用。
 */
export async function pickExePath() {
  const d = await bridgeJson('/pick-file')
  const p = String((d && d.path) || '').trim().replace(/^["']+|["']+$/g, '')
  return {
    ok: !!(d && d.ok && p),
    path: p,
    cancelled: !!(d && d.cancelled),
    error: (d && d.error) || ''
  }
}
