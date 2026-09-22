/* 链接打开：区分「网页链接」与「本地程序/文件/文件夹」
 *
 * 判定与路由（顺序很重要）：
 *   ① 先尝试剥壳：形如 `https://"C:\xxx\a.exe"` 的历史坏数据 —— 协议头是**误加**的，
 *      剥掉协议与首尾引号后是合法盘符路径 ⇒ 必须走本地桥。不先剥壳就会被 ② 当成网页，
 *      交给浏览器 ⇒ 本地程序永远打不开（第 42 轮定位到的真实原因）。
 *   ② 普通网页 / 邮件：未指定浏览器时交给 window.open（系统默认）；**指定了浏览器就必须走桥**
 *      （只有桥能在本机起一个具体的 exe）。
 *   ③ 其余（本地路径、app://）：交给本地桥 127.0.0.1:4567/open。
 *
 * ⚠️ 第 42 轮（2026-09-22，用户定案 A 三层全改）：本文件承担「点击侧容错」。
 *    配套：`Data.vue normalizeUrl()` / `TaskFormModal` / `Overview.saveShortcut` 承担「保存侧规范化」，
 *    以及 `utils/locallinkfix.js` 负责把库里已存的坏链接一次性订正。
 *
 * ⚠️ 第 43 轮（2026-09-22）新增第二个参数 browserExe：链接级 / 全局指定的浏览器 exe 路径。
 *    由 `utils/browserPref.js#browserForLink()` 解析后传入；不传 = 老行为（系统默认）。
 */

const BRIDGE_URL = 'http://127.0.0.1:4567/open'

const WEB_RE = /^https?:\/\//i
const MAILTO_RE = /^mailto:/i
const APP_RE = /^app:\/\//i
const FILE_RE = /^file:\/\//i
const WIN_PATH_RE = /^[a-zA-Z]:[\\/]/
const UNC_RE = /^\\\\/
// 允许出现在协议头之后（误加协议的坏数据）：引号 / 空白
const TRIM_Q = /^["'\s]+|["'\s]+$/g

export function isLocalOpenable(url) {
  const s = String(url || '').trim()
  return APP_RE.test(s) || FILE_RE.test(s) || WIN_PATH_RE.test(s)
}

// Strip the scheme/encode so the bridge receives a plain filesystem path.
export function toLocalPath(url) {
  let s = String(url || '').trim()
  s = s.replace(APP_RE, '').replace(FILE_RE, '')
  // file:///C:/foo -> strip leading slashes after scheme removal
  s = s.replace(/^\/+/, '')
  s = s.replace(TRIM_Q, '')
  try { s = decodeURIComponent(s) } catch {}
  return s
}

/**
 * 「剥壳」：把可能是「被误加了协议的本地路径」整理成干净的本地路径。
 * 命中返回干净路径（形如 `C:\xxx\a.exe` / `C:\xxx\a.docx`），**不命中返回空串**。
 *
 * 判据（严格，避免误伤正常网址）：
 *   - `mailto:` → 空串（邮件不是本地目标）
 *   - 剥掉 `https://` `http://` `app://` `file://` 前缀与首尾引号/空白
 *   - 剩下的**必须**以「盘符 + 斜杠」（`C:\` / `C:/`）或 `\\`（UNC）开头
 *   ⇒ `https://www.kdocs.cn/l/xxx` 的剩余是 `www.kdocs.cn/l/xxx`（字母后不是冒号）⇒ 不命中；
 *     `https://a:8080/x` 的剩余是 `a:8080/x`（冒号后不是斜杠）⇒ 不命中。
 */
export function localPathOf(raw) {
  let s = String(raw == null ? '' : raw).trim()
  if (!s) return ''
  if (MAILTO_RE.test(s)) return ''
  const m = /^(https?|app|file):\/\//i.exec(s)
  if (m) s = s.slice(m[0].length)
  s = s.replace(TRIM_Q, '')
  s = s.replace(/^\/+/, '')
  try { s = decodeURIComponent(s) } catch {}
  // 必须以「盘符 + 斜杠」或 UNC 开头，否则不算本地路径
  if (WIN_PATH_RE.test(s) || UNC_RE.test(s)) return s
  return ''
}

// 软提示：不是失败，但要如实告诉用户「本来想用 A，实际用了 B」（顶栏轻提示，App.vue 监听）
function notifyNote(msg) {
  try { window.dispatchEvent(new CustomEvent('wb:open-note', { detail: { msg: String(msg || '') } })) } catch {}
}

// 硬失败：本地目标根本没打开（顶栏红条，App.vue 监听）
function notifyFail(u, target, err) {
  try {
    window.dispatchEvent(new CustomEvent('wb:open-fail', {
      detail: { url: u, target, error: (err && err.message) || 'bridge unreachable' }
    }))
  } catch {}
}

async function postBridge(body) {
  const res = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  let data = {}
  try { data = await res.json() } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || ('bridge ' + res.status))
  return data
}

/**
 * 打开链接。
 * @param {string} url 链接或本地路径
 * @param {string} [browserExe] 指定用于打开的浏览器 exe（空 = 系统默认）
 */
export async function openExternal(url, browserExe) {
  const u = String(url || '').trim()
  if (!u) return
  const exe = String(browserExe || '').trim()

  // ① 先剥壳：历史坏数据 `https://"C:\…"` ⇒ `C:\…`，必须走本地桥（详见文件头注释）
  const localPath = localPathOf(u)

  // ② 标准 web/mail 链接
  if (!localPath && (WEB_RE.test(u) || MAILTO_RE.test(u))) {
    // 未指定浏览器：保持原行为，交给 window.open（系统默认 + 少一跳桥）
    if (!exe) {
      window.open(u, '_blank', 'noopener,noreferrer')
      return
    }
    // 指定了浏览器：只有本地桥能在本机起这个 exe
    try {
      const r = await postBridge({ url: u, browser: exe })
      if (r && r.fallback) notifyNote(r.note)
    } catch (err) {
      // 桥不可达：退回系统默认打开（比什么都不做强），并如实说明用的不是指定的那个
      notifyNote('本地桥未响应，已改用系统默认浏览器打开：' + u)
      window.open(u, '_blank', 'noopener,noreferrer')
    }
    return
  }

  // ③ 本地目标：规范化路径后请本地桥启动
  const target = localPath || toLocalPath(u)
  if (!target) {
    window.open(u, '_blank')
    return
  }

  try {
    const body = { url: target }
    if (exe) body.browser = exe // 本地文件也可以指定用某个浏览器打开（如本地 .html）
    const r = await postBridge(body)
    if (r && r.fallback) notifyNote(r.note)
  } catch (err) {
    console.warn('[localOpen] bridge failed, falling back to browser:', err.message)
    // Surface the failure to the user (App.vue listens and shows a top bar); the
    // previous silent window.open fallback made a dead bridge look like "nothing
    // happens when I click the link".
    notifyFail(u, target, err)
    // 最后兜底：只有「浏览器真有可能自己处理」的目标才交给它。
    // 本地路径（C:\… / app://）交给浏览器只会开出一个空白页，反而不如什么都不做
    // —— 失败原因已经由上面的 wb:open-fail 顶栏如实展示。
    if (!localPath && !isLocalOpenable(u)) window.open(u, '_blank')
  }
}
