// GitHub Contents API 后端：远端存储 = 私有库里的一个加密 JSON 快照文件
// 协议（见《手机端同步方案》第 4 节）：
//   GET  /repos/{owner}/{repo}/contents/{path} → { content(base64), sha }
//   PUT  同路径 body { message, content(base64), sha } → sha 防 409 并发覆盖
// 鉴权：Bearer <fine-grained PAT>（仅授权该库 contents 读写）
//
// ⚠️ 错误必须分类上报（2026-09-20 用户要求：「连不上就如实说连不上，不同原因写清楚」）：
//   ① 请求根本没发出去 / 没回来 —— DNS 失败、断网、代理或 VPN 拦截、防火墙
//      → fetch 自己抛错（TypeError / AbortError），**没有 HTTP 状态码**。以前这种
//        情况只冒出一句笼统的「同步失败：Failed to fetch」，用户无法判断是该修网络
//        还是该改配置，故这里统一抛 code='NET' 且文案写明「连不上 GitHub」。
//   ② 请求到了 GitHub 但被拒 —— 401 / 403 / 404 / 409 / 413 / 422 / 429 / 5xx
//      → 有状态码，按码分别给原因（见 statusError）。
//   两类绝不能混为一谈：前者改网络，后者改凭据/权限/体积。

const API = 'https://api.github.com'
// 单次请求超时：弱网或被代理拦时 fetch 默认永不超时，会让「测试中…」一直转下去
const TIMEOUT_MS = 20000

export function normalizeRepo(repo) {
  if (!repo) return ''
  let s = String(repo).trim()
  s = s.replace(/^https?:\/\/[^/]+\//i, '')
  s = s.replace(/\.git$/i, '')
  s = s.replace(/\/+$/, '')
  const m = s.match(/^([\w.-]+)\/([\w.-]+)(?:\/.*)?$/)
  return m ? m[1] + '/' + m[2] : ''
}

// 统一请求包装：把「连不上」和「连上了」明确分开
async function req(url, init, what) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError')
    const err = new Error(
      aborted
        ? '连不上 GitHub（' + what + '）：' + TIMEOUT_MS / 1000 + ' 秒内没有任何响应，网络可能被拦截或极慢'
        : '连不上 GitHub（' + what + '）：请求没发出去，浏览器访问不了 api.github.com。' +
          '请检查是否断网 / 需要代理或 VPN / 被防火墙拦截'
    )
    err.code = 'NET'
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// 有状态码的失败：按原因分别给文案（返回 null 表示未见过的状态码，由调用方兜底）
// 异步是因为 403 要读响应体来区分「限流」和「没权限」——见下面的注释。
// ⚠️ 读体一律用 r.clone()，否则会把 body 流消费掉，调用方后面就读不到 message 了。
async function statusError(r, what) {
  const s = r.status
  const tag = '（' + what + '）'
  if (s === 401) return new Error('认证失败 401' + tag + '：PAT 无效或已过期，请到 GitHub 重新生成')
  if (s === 403) {
    // GitHub 拿 403 表示两件完全不同的事（限流 / 没权限），报错必须分开，否则用户会去改错地方。
    // ⚠️ 不能只看 x-ratelimit-remaining：跨域请求下，非安全列表的响应头必须被
    // Access-Control-Expose-Headers 暴露，JS 才读得到；万一读不到，限流就会被误报成
    // 「无权限」，等于把原因说错。所以再加一道按 GitHub 自己 message 的判定
    // （限流时 message 形如 "API rate limit exceeded for ..." / secondary rate limit）。
    let msg = ''
    try { msg = String(((await r.clone().json()) || {}).message || '') } catch (_) { /* 非 JSON 体，忽略 */ }
    const remain = r.headers.get('x-ratelimit-remaining')
    if (remain === '0' || /rate limit/i.test(msg)) {
      const reset = Number(r.headers.get('x-ratelimit-reset') || 0)
      const when = reset ? new Date(reset * 1000).toLocaleTimeString() : ''
      return new Error('被 GitHub 限流 403' + tag + '：本机 IP 的 API 额度已用完' + (when ? '，约 ' + when + ' 恢复' : '，稍后重试'))
    }
    return new Error('无权限 403' + tag + '：这个 PAT 没有该私有库的 Contents 读写权限')
  }
  if (s === 404) return new Error('找不到 404' + tag + '：检查 owner/repo 拼写，或该 PAT 根本没被授权到这个库')
  if (s === 413) return new Error('内容过大 413' + tag + '：快照超过 GitHub Contents API 单文件上限，需要改用 Git Data API 分块写入')
  if (s === 422) return new Error('GitHub 拒绝写入 422' + tag + '：通常是内容过大，或上次记录的 sha 已失效')
  if (s === 429) return new Error('请求过于频繁 429' + tag + '：稍等一会儿再试')
  if (s >= 500) return new Error('GitHub 服务端出错 ' + s + tag + '：不是你这边的问题，稍后重试')
  return null
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
  const contentsUrl = `${API}/repos/${full}/contents/${encodeURIComponent(path)}`

  // 读取远端快照；返回 null 表示远端还没有文件（首次）
  // ⚠️ 坑（2026-09-13 实测）：Contents API 对 **大于 1MB** 的文件不再内联返回正文，
  // 而是给 { encoding: 'none', content: '' }。此时若直接用 content，会得到空串，
  // 上游 JSON.parse('') 抛错并被兜底文案误报成「加密密码不一致」（真凶其实是文件太大）。
  // 故 content 为空时，按 sha 改走 Git Data API 的 blobs 接口取全文 —— 该接口支持到 100MB，
  // 返回的同样是 base64 字符串，调用方契约保持不变。
  async function get() {
    const r = await req(`${contentsUrl}?t=${Date.now()}`, { headers, cache: 'no-store' }, '读取远端快照')
    if (r.status === 404) return null
    if (!r.ok) throw (await statusError(r, '读取远端快照')) || new Error('GitHub 读取异常（' + r.status + '，读取远端快照）')
    const j = await r.json()
    let content = String(j.content || '').replace(/\s/g, '')
    if (!content) {
      if (!j.sha) throw new Error('远端快照读取异常：响应里既没有 content 也没有 sha（文件可能为空）')
      const b = await req(`${API}/repos/${full}/git/blobs/${j.sha}`, { headers, cache: 'no-store' }, '下载大文件快照')
      if (!b.ok) throw (await statusError(b, '下载大文件快照')) || new Error('读取远端快照失败（' + b.status + '，文件超过 1MB 需走 blobs 接口）')
      const bj = await b.json()
      content = String(bj.content || '').replace(/\s/g, '')
      if (!content) throw new Error('远端快照内容为空，无法解析（blobs 接口也没返回正文）')
    }
    return { sha: j.sha, content }
  }

  // 写入远端快照（base64 + sha 防覆盖）；409 时抛 code=409 由调用方重试
  async function put(base64, sha, message) {
    const body = { message, content: base64 }
    if (sha) body.sha = sha
    const r = await req(contentsUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, '写入快照')
    if (r.status === 409) {
      const e = new Error('远端刚被其他设备更新 409（写入快照），已自动重试')
      e.code = 409
      throw e
    }
    if (!r.ok) {
      const mapped = await statusError(r, '写入快照')
      if (mapped) throw mapped
      let detail = ''
      try { const j = await r.json(); detail = (j.message || '') + '' } catch (_) { /* ignore */ }
      throw new Error('GitHub 写入失败（' + r.status + '）' + (detail ? '：' + detail : ''))
    }
    const j = await r.json()
    return { sha: (j.content && j.content.sha) || null }
  }

  // 连通性测试：只读仓库元信息，不碰数据
  async function verify() {
    const r = await req(`${API}/repos/${full}`, { headers, cache: 'no-store' }, '测试连接')
    if (!r.ok) throw (await statusError(r, '测试连接')) || new Error('GitHub 接口异常（' + r.status + '，测试连接）')
    return true
  }

  return { get, put, verify }
}
