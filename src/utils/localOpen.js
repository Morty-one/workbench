const BRIDGE_URL = 'http://127.0.0.1:4567/open'

const WEB_RE = /^https?:\/\//i
const MAILTO_RE = /^mailto:/i
const APP_RE = /^app:\/\//i
const FILE_RE = /^file:\/\//i
const WIN_PATH_RE = /^[a-zA-Z]:[\\/]/

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
  try { s = decodeURIComponent(s) } catch {}
  return s
}

export async function openExternal(url) {
  const u = String(url || '').trim()
  if (!u) return

  // Standard web/mail links: let the browser handle them.
  if (WEB_RE.test(u) || MAILTO_RE.test(u)) {
    window.open(u, '_blank', 'noopener,noreferrer')
    return
  }

  // Local app/file: normalize the path and ask the local bridge to launch it.
  const target = toLocalPath(u)
  if (!target) {
    window.open(u, '_blank')
    return
  }

  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target })
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || ('bridge ' + res.status))
    }
  } catch (err) {
    console.warn('[localOpen] bridge failed, falling back to browser:', err.message)
    // Last-resort fallback: some browsers can handle a file:// or app link natively.
    window.open(u, '_blank')
  }
}
