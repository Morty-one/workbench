import { reactive } from 'vue'

// 文档输出：跨视图共享状态 + 本地桥调用 + 执行日志
// 状态放在模块级，组件 unmount 也不会丢失（解决"切走再切回不知道是否在执行"）
const BRIDGE = 'http://127.0.0.1:4567'
const RUN_FLAG_KEY = 'wb_docoutput_run_v1'
const CFG_KEY = 'wb_docoutput_v1'
const LOG_KEY = 'wb_docoutput_log_v1'

export const docState = reactive({
  running: false,
  picking: false,
  result: null, // { ok, error, steps:[{step,name,ok,detail}] }
  aPath: '', // 本次执行的 A 文件路径
  msg: '',
  modal: { visible: false, title: '', message: '', steps: [], ok: true, diagnostics: '' }
})

let pollTimer = null
let msgTimer = null
let pollFailCount = 0

function flash(t) {
  docState.msg = t
  if (msgTimer) clearTimeout(msgTimer)
  msgTimer = setTimeout(() => { if (docState.msg === t) docState.msg = '' }, 4500)
}

async function callBridge(path, opts) {
  // 关键：GET 请求加 cache-busting 查询 + no-store，避免浏览器缓存 /ping 等响应
  // （之前没加，导致弹窗一直拿到旧桥的 mtime，误以为桥没更新）
  const sep = path.includes('?') ? '&' : '?'
  const url = BRIDGE + path + sep + '_=' + Date.now()
  const res = await fetch(url, { cache: 'no-store', ...(opts || {}) })
  if (!res.ok) {
    let d = {}
    try { d = await res.json() } catch {}
    throw new Error(d.error || ('HTTP ' + res.status))
  }
  return res.json()
}

export function normalizeAPath(p) {
  return String(p || '').trim().replace(/^["']|["']$/g, '')
}

export function loadDocConfig() {
  try {
    const s = localStorage.getItem(CFG_KEY)
    if (s) return JSON.parse(s)
  } catch (e) {}
  return {}
}

// 执行日志读写
export function loadDocLog() {
  try {
    const s = localStorage.getItem(LOG_KEY)
    if (s) return JSON.parse(s)
  } catch (e) {}
  return []
}

function saveDocLog(logs) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(logs.slice(0, 100))) } catch {}
}

export function addDocLog(record) {
  const logs = loadDocLog()
  logs.unshift(record)
  saveDocLog(logs)
}

export function clearDocLog() {
  try { localStorage.removeItem(LOG_KEY) } catch {}
}

function updateCurrentLog(patch) {
  const logs = loadDocLog()
  if (logs.length && !logs[0].endedAt) {
    Object.assign(logs[0], patch)
    saveDocLog(logs)
  }
}

// 弹窗
export function showDocModal({ title, message, steps = [], ok = true, diagnostics = '' }) {
  docState.modal = { visible: true, title, message, steps, ok, diagnostics }
}

export function closeDocModal() {
  docState.modal.visible = false
}

// 获取本地桥诊断信息（mtime / 路径），用于定位「旧桥残留」问题
export async function getBridgeInfo() {
  try {
    const d = await callBridge('/ping')
    return {
      ok: true,
      mtime: d && d.mtime,
      bridgePath: d && d.bridgePath,
      expectedPath: 'workbench-REPLICA/local-bridge.cjs'
    }
  } catch (e) {
    return { ok: false, error: e.message || '无法连接 127.0.0.1:4567' }
  }
}

function formatDiagnostics(d, raw, bridgeInfo) {
  const lines = []
  if (bridgeInfo) {
    if (bridgeInfo.ok) {
      lines.push('桥进程：' + (bridgeInfo.bridgePath || '未知路径'))
      lines.push('桥 mtime：' + (bridgeInfo.mtime || '未知'))
      if (!String(bridgeInfo.bridgePath || '').includes('workbench-REPLICA')) {
        lines.push('⚠️ 当前桥路径不是 REPLICA 目录，说明是旧版本桥进程在响应请求。')
      }
    } else {
      lines.push('桥连接失败：' + bridgeInfo.error)
    }
  }
  if (d && d.error) lines.push('后端错误：' + d.error)
  if (raw) {
    if (raw.code != null) lines.push('PowerShell exit code: ' + raw.code)
    if (raw.stderr) lines.push('stderr: ' + raw.stderr.slice(0, 300))
    if (raw.stdout) lines.push('stdout: ' + raw.stdout.slice(0, 300))
  }
  return lines.join('\n')
}

// 强制重置执行状态（用户手动清掉卡死）
export function resetDocRun() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  docState.running = false
  docState.picking = false
  docState.msg = '已重置执行状态，可重新操作'
  try { localStorage.removeItem(RUN_FLAG_KEY) } catch {}
  flash('已重置执行状态')
}

// 选 A 文件（带全局锁，防止重复弹窗）
export async function pickFile() {
  if (docState.picking) return null
  docState.picking = true
  flash('正在尝试打开文件选择框…')
  try {
    const d = await callBridge('/pick-file')
    if (d && d.ok && d.path) return normalizeAPath(d.path)
    if (d && d.ok === false) {
      let detail = d.error || '未知错误'
      const bridgeInfo = await getBridgeInfo()
      const isOldBridge = bridgeInfo.ok && !String(bridgeInfo.bridgePath || '').includes('workbench-REPLICA')
      if (isOldBridge) {
        // 只有真实命中「响应者不是 REPLICA 桥」时才报旧桥
        detail = '当前响应的是旧版本本地桥进程（路径：' + (bridgeInfo.bridgePath || '未知') + '），新代码未生效。' +
          '请打开任务管理器，结束所有 node.exe，然后重新双击 REPLICA 目录里的「打开工作台.vbs」。'
      } else {
        // 桥正常但 /pick-file 失败：展示真实错误，不再误报为旧桥
        if (detail === '未知错误') {
          detail = '本地桥连接正常，但文件选择框未能弹出或返回路径。请查看下方诊断信息；' +
            '也可直接在输入框粘贴 A 文件完整路径（如 D:\\导出\\日报.xlsx）。'
        } else {
          detail = '文件选择失败：' + detail + '。若窗口未弹出，可在输入框直接粘贴 A 文件路径。'
        }
      }
      const diagnostics = formatDiagnostics(d, d.raw, bridgeInfo)
      showDocModal({ title: '选择文件失败', message: detail, steps: [], ok: false, manual: true, diagnostics })
    }
    return null
  } catch (e) {
    const detail = e.message || '无法连接本地服务'
    const bridgeInfo = await getBridgeInfo()
    const diagnostics = formatDiagnostics(null, null, bridgeInfo)
    flash('选择文件失败：' + detail)
    showDocModal({
      title: '选择文件失败',
      message: detail + '。请确认已双击「打开工作台.vbs」启动本地服务。如果弹窗一直失败，可手动在下方输入框粘贴 A 文件路径。',
      steps: [],
      ok: false,
      manual: true,
      diagnostics
    })
    return null
  } finally {
    docState.picking = false
  }
}

function validateConfig(cfg) {
  if (!cfg.bPath) return '请先在「文档输出」配置页填写 B 文件固定路径'
  if (!cfg.sheets || !cfg.sheets.length) return '请配置至少一个 sheet 映射'
  for (const s of cfg.sheets) {
    if (!s.local || !s.online || !s.src || !s.dst) {
      return '请补全每个 sheet 的 本地名 / 线上名 / 源范围 / 目标范围'
    }
  }
  return ''
}

export async function startRun(aPath) {
  aPath = normalizeAPath(aPath)
  const cfg = loadDocConfig()
  const err = validateConfig(cfg)
  if (err) {
    showDocModal({ title: '无法执行', message: err, ok: false })
    return false
  }
  if (!aPath) {
    showDocModal({ title: '无法执行', message: '未选择 A 文件', ok: false, manual: true })
    return false
  }

  docState.running = true
  docState.aPath = aPath
  docState.result = null
  docState.msg = '已提交，本机 Excel/WPS 开始执行（宏② 文件框会自动填 A 路径）…'

  const startedAt = Date.now()
  addDocLog({
    id: startedAt,
    startedAt,
    aPath,
    bPath: cfg.bPath,
    ok: false,
    error: '',
    failedStep: ''
  })

  // 持久化 running，刷新页面也不丢
  try {
    localStorage.setItem(RUN_FLAG_KEY, JSON.stringify({ at: startedAt }))
  } catch {}

  try {
    await callBridge('/doc-output', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aPath, bPath: cfg.bPath, config: cfg })
    })
  } catch (e) {
    docState.running = false
    docState.msg = '提交失败：' + e.message
    updateCurrentLog({ endedAt: Date.now(), ok: false, error: e.message, failedStep: 'submit' })
    try { localStorage.removeItem(RUN_FLAG_KEY) } catch {}
    showDocModal({ title: '提交失败', message: e.message, ok: false })
    return false
  }
  pollFailCount = 0
  pollStatus()
  return true
}

// 按钮统一入口：先选 A，再执行
export async function requestDocOutput(manualAPath) {
  if (docState.running) { flash('正在执行中，请稍候…'); return }
  if (docState.picking) return
  const a = manualAPath ? normalizeAPath(manualAPath) : await pickFile()
  if (!a) return
  await startRun(a)
}

function finishRun(d) {
  docState.result = d
  docState.running = false
  try { localStorage.removeItem(RUN_FLAG_KEY) } catch {}
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }

  const endedAt = Date.now()
  const failedStep = d && !d.ok && d.steps
    ? (d.steps.find(s => !s.ok)?.name || d.error || 'unknown')
    : ''
  updateCurrentLog({
    endedAt,
    ok: !!(d && d.ok),
    error: (d && d.error) || '',
    failedStep
  })

  if (d && d.ok) {
    docState.msg = '执行成功 ✓'
    showDocModal({
      title: '执行成功',
      message: '文档输出已完成，所有步骤均成功。',
      steps: (d.steps || []).map(s => ({ name: s.name, ok: true, detail: s.detail || '' })),
      ok: true
    })
  } else {
    const reason = (d && d.error) || '未知错误'
    docState.msg = '执行失败：' + reason
    showDocModal({
      title: '执行失败',
      message: reason,
      steps: (d.steps || []).map(s => ({ name: s.name, ok: s.ok, detail: s.detail || '' })),
      ok: false
    })
  }
}

function pollStatus() {
  if (pollTimer) clearInterval(pollTimer)
  pollFailCount = 0
  pollTimer = setInterval(async () => {
    try {
      const d = await callBridge('/doc-output-status')
      pollFailCount = 0
      if (d && d.running) return
      finishRun(d)
    } catch (e) {
      pollFailCount++
      // 连续 5 次（约 10 秒）拿不到状态，认为桥或脚本已异常退出，结束轮询
      if (pollFailCount >= 5) {
        docState.running = false
        try { localStorage.removeItem(RUN_FLAG_KEY) } catch {}
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        const reason = '与本地服务失去连接，执行状态未知。请检查 node.exe / PowerShell 是否仍在运行，或手动在任务管理器结束 Excel/WPS 后重试。'
        docState.msg = reason
        updateCurrentLog({ endedAt: Date.now(), ok: false, error: reason, failedStep: 'poll' })
        showDocModal({ title: '执行状态异常', message: reason, ok: false })
      }
    }
  }, 2000)
}

// 应用启动时调用：若上次执行未完成（刷新/切走），恢复轮询
export async function restoreDocRun() {
  try {
    const raw = localStorage.getItem(RUN_FLAG_KEY)
    if (!raw) return
    const { at } = JSON.parse(raw)
    // 超过 3 分钟视为过期（可能已关机等），清空
    if (Date.now() - at > 3 * 60 * 1000) {
      localStorage.removeItem(RUN_FLAG_KEY)
      return
    }
    // 先查后端真实状态，避免状态卡死
    try {
      const d = await callBridge('/doc-output-status')
      if (!d || !d.running) {
        finishRun(d || { ok: false, error: '上次执行未正常结束' })
        return
      }
    } catch {
      // 后端连不上：大概率桥没起或已崩，直接清掉旧状态
      localStorage.removeItem(RUN_FLAG_KEY)
      return
    }
    docState.running = true
    docState.msg = '正在执行文档输出（从之前的状态恢复）…'
    pollStatus()
  } catch {}
}

export { BRIDGE }
