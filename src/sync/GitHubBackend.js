// GitHub Contents API 后端：远端存储 = 私有库里的一个加密 JSON 快照文件
// 协议（见《手机端同步方案》第 4 节）：
//   GET  /repos/{owner}/{repo}/contents/{path} → { content(base64), sha }
//   PUT  同路径 body { message, content(base64), sha } → sha 防 409 并发覆盖
// 鉴权：Bearer <fine-grained PAT>（仅授权该库 contents 读写）

const API = 'https://api.github.com'

// 支持粘贴 "owner/repo"、完整 URL（带不带 .git、带 tree/blob 路径均可）
export function normalizeRepo(repo) {
  if (!repo) return ''
  let s = String(repo).trim()
  s = s.replace(/^https?:\/\/[^/]+\//i, '')
  s = s.replace(/\.git$/i, '')
  s = s.replace(/\/+$/, '')
  const m = s.match(/^([\w.-]+)\/([\w.-]+)(?:\/.*)?$/)
  return m ? m[1] + '/' + m[2] : ''
}

export function createGitHubBackend(repo, pat, path = 'workbench-data-encrypted.json') {
  const full = normalizeRepo(repo)
  if (!full) throw new Error('仓库格式不对：请填写 owner/repo（如 Morty-one/workbench-sync）')
  if (!pat) throw new Error('缺少 PAT 访问令牌')
  const headers = {
    Authorization: 'Bearer ' + pat,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }

  // 读取远端快照；返回 null 表示远端还没有文件（首次）
  async function get() {
    const r = await fetch(`${API}/repos/${full}/contents/${encodeURIComponent(path)}?t=${Date.now()}`, {
      headers,
      cache: 'no-store'
    })
    if (r.status === 404) return null
    if (r.status === 401) throw new Error('PAT 无效或已过期（401），请到 GitHub 重新生成')
    if (r.status === 403) throw new Error('无权限访问该仓库（403）：请确认 PAT 已授权该私有库且包含 Contents 读写')
    if (!r.ok) throw new Error('GitHub API 异常（' + r.status + '）')
    const j = await r.json()
    return { sha: j.sha, content: String(j.content || '').replace(/\s/g, '') }
  }

  // 写入远端快照（base64 + sha 防覆盖）；409 时抛 code=409 由调用方重试
  async function put(base64, sha, message) {
    const body = { message, content: base64 }
    if (sha) body.sha = sha
    const r = await fetch(`${API}/repos/${full}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (r.status === 401) throw new Error('PAT 无效或已过期（401），请到 GitHub 重新生成')
    if (r.status === 403) throw new Error('无权限写入（403）：PAT 需要该库 Contents 读写权限')
    if (r.status === 409) {
      const e = new Error('远端刚被其他设备更新（409），已自动重试')
      e.code = 409
      throw e
    }
    if (!r.ok) {
      let detail = ''
      try { const j = await r.json(); detail = (j.message || '') + '' } catch (_) { /* ignore */ }
      throw new Error('GitHub 写入失败（' + r.status + '）' + (detail ? '：' + detail : ''))
    }
    const j = await r.json()
    return { sha: (j.content && j.content.sha) || null }
  }

  // 连通性测试：只读仓库元信息，不碰数据
  async function verify() {
    const r = await fetch(`${API}/repos/${full}`, { headers, cache: 'no-store' })
    if (r.status === 401) throw new Error('PAT 无效或已过期（401），请到 GitHub 重新生成')
    if (r.status === 404) throw new Error('仓库不存在（404）：检查 owner/repo 拼写')
    if (r.status === 403) throw new Error('无权限访问（403）：PAT 未授权该仓库')
    if (!r.ok) throw new Error('GitHub API 异常（' + r.status + '）')
    return true
  }

  return { get, put, verify }
}
