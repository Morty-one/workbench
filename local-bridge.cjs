/**
 * Workbench local bridge
 * Provides a tiny localhost-only API for the browser to open local files/apps
 * and to drive the "Doc Output" RPA orchestration.
 *
 * Security note: binds 127.0.0.1 only, so it is unreachable from any remote
 * host. We echo back a loopback/null origin as the CORS allow-list.
 */
const http = require('http')
const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const PORT = process.env.WB_BRIDGE_PORT || 4567
const LOG = process.env.WB_BRIDGE_LOG || path.join(__dirname, 'local-bridge.log')

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`
  try { fs.appendFileSync(LOG, line) } catch {}
}

function isLocalOrigin(origin) {
  if (!origin) return true
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)
}

function sendJson(res, status, data, origin) {
  // 禁止浏览器缓存，避免前端拿到过期的 /ping（旧桥 mtime）等响应
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  if (origin && isLocalOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function sanitizePath(p) {
  return String(p || '').replace(/[|&;$<>]/g, '').trim()
}

function normalizeTarget(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  s = s.replace(/^app:\/\//i, '')
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\//i, '')
    s = s.replace(/^\/+/, '')
  }
  try { s = decodeURIComponent(s) } catch {}
  if (process.platform === 'win32') s = s.replace(/\//g, '\\')
  return s
}

function launchLocal(clean, res, origin) {
  log('TARGET', clean)
  if (!clean) { sendJson(res, 400, { ok: false, error: 'invalid path' }, origin); return }
  const launchCmd = `cmd /c start "" ${JSON.stringify(clean)}`
  log('LAUNCH', launchCmd)
  exec(launchCmd, { windowsHide: true }, (err) => {
    if (!err) { sendJson(res, 200, { ok: true }, origin); return }
    log('START_FAIL', err.message)
    const vbs = path.join(__dirname, 'local-activate.vbs')
    const vbsCmd = `cscript.exe //NoLogo //E:vbscript "${vbs}" "${clean}"`
    log('FALLBACK', vbsCmd)
    exec(vbsCmd, { windowsHide: true }, (e2) => {
      if (e2) sendJson(res, 500, { ok: false, error: e2.message }, origin)
      else sendJson(res, 200, { ok: true }, origin)
    })
  })
}

function docOutDir() { return __dirname }
function jobPath() { return path.join(docOutDir(), 'doc-output-job.json') }
function psPath() { return path.join(docOutDir(), 'scripts', 'doc-output.ps1') }
function resultPath() { return path.join(docOutDir(), 'doc-output-result.json') }

function startOrchestrator(res, origin) {
  const ps = psPath()
  const job = jobPath()
  if (!fs.existsSync(ps)) { sendJson(res, 500, { ok: false, error: 'orchestrator script missing' }, origin); return }
  if (!fs.existsSync(job)) { sendJson(res, 400, { ok: false, error: 'no saved job' }, origin); return }
  try { fs.unlinkSync(resultPath()) } catch {}
  const cmd = `cmd /c start "" powershell -NoProfile -ExecutionPolicy Bypass -File "${ps}" -Job "${job}"`
  log('DOCOPEN', cmd)
  exec(cmd, { windowsHide: false }, (err) => {
    if (err) { log('DOCOPEN_FAIL', err.message); sendJson(res, 500, { ok: false, error: err.message }, origin) }
    else sendJson(res, 200, { ok: true }, origin)
  })
}

function submitDocOutput(payload, res, origin) {
  const job = jobPath()
  try { fs.writeFileSync(job, JSON.stringify(payload, null, 2)) } catch (e) {
    sendJson(res, 500, { ok: false, error: 'write job failed: ' + e.message }, origin); return
  }
  startOrchestrator(res, origin)
}

function pickFile(res, origin) {
  // 关键：
  // 1. -STA 让 OpenFileDialog 能在普通 PowerShell 控制台线程正常弹出
  // 2. 用临时 .ps1 + 临时 .txt 结果文件，避免 stdout 编码/缓冲问题
  // 3. 通过 cmd /c start /wait powershell 在独立可见窗口执行，
  //    即使桥进程本身是隐藏窗口也能正常显示文件选择框
  // 4. 捕获 stdout/stderr/exitCode 完整诊断信息，杜绝"未知错误"
  const base = path.join(os.tmpdir(), 'wb_pickfile_' + process.pid + '_' + Date.now())
  const ps1 = base + '.ps1'
  const outFile = base + '.txt'
  const script = [
    'param([string]$OutFile)',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'try {',
    '  Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '  [System.Windows.Forms.Application]::EnableVisualStyles()',
    '  $d = New-Object System.Windows.Forms.OpenFileDialog',
    "  $d.Title = 'Select File'",
    '  $d.AutoUpgradeEnabled = $true',
    '  $r = $d.ShowDialog()',
    '  if ($r -eq [System.Windows.Forms.DialogResult]::OK) {',
    '    Set-Content -Path $OutFile -Value ("OK\n" + $d.FileName) -Encoding UTF8 -NoNewline',
    '  } else {',
    '    Set-Content -Path $OutFile -Value ("CANCEL\n" + $r) -Encoding UTF8 -NoNewline',
    '  }',
    '} catch {',
    '  Set-Content -Path $OutFile -Value ("ERROR\n" + $_.Exception.Message) -Encoding UTF8 -NoNewline',
    '}',
    ''
  ].join('\r\n')
  try { fs.writeFileSync(ps1, script, 'ascii') } catch (e) {
    sendJson(res, 500, { ok: false, error: 'write picker script failed: ' + e.message }, origin)
    return
  }
  // 第一个 "" 是 start 命令的窗口标题占位，避免路径被当成标题
  const cmd = 'cmd /c start "" /wait powershell -NoProfile -STA -ExecutionPolicy Bypass -File "' + ps1 + '" -OutFile "' + outFile + '"'
  log('PICKFILE', cmd)
  exec(cmd, { windowsHide: false, encoding: 'utf8' }, (err, stdout, stderr) => {
    const code = err ? err.code : 0
    const signal = err ? err.signal : ''
    const errOut = (stderr || '').trim()
    log('PICKFILE_DONE', 'code=' + code, 'signal=' + signal, 'stderr=' + errOut.slice(0, 200))

    let out = ''
    try { if (fs.existsSync(outFile)) out = fs.readFileSync(outFile, 'utf8').trim() } catch (e) {}
    log('PICKFILE_READ', 'out=' + out.slice(0, 200))

    try { fs.unlinkSync(ps1) } catch {}
    try { fs.unlinkSync(outFile) } catch {}

    if (err) {
      const summary = (errOut || err.message || ('PowerShell exited with code ' + code))
      sendJson(res, 500, { ok: false, error: summary, raw: { stdout, stderr, code, signal } }, origin)
      return
    }
    const lines = out.split(/\r?\n/)
    const status = lines[0] || ''
    let payload = lines.slice(1).join('\n').trim()
    if (payload) payload = payload.replace(/^["']|["']$/g, '')
    if (status === 'ERROR') {
      sendJson(res, 500, { ok: false, error: 'PowerShell 脚本异常：' + (payload || '未知'), raw: { stdout, stderr, code, signal } }, origin)
      return
    }
    if (status === 'CANCEL') {
      sendJson(res, 200, { ok: false, error: '未选择文件（已取消）', path: '' }, origin)
      return
    }
    if (status === 'OK' && payload) {
      sendJson(res, 200, { ok: true, path: payload }, origin)
      return
    }
    // 既不是 OK/CANCEL/ERROR，说明结果文件没正常写入：对话框多半根本没弹出来
    const reason = out
      ? ('对话框返回了无法识别的内容：' + out.slice(0, 200))
      : '结果文件为空——对话框很可能没有弹出，或弹出后被立即关闭/被其他窗口遮挡。'
    sendJson(res, 500, { ok: false, error: reason, raw: { stdout, stderr, code, signal, out } }, origin)
  })
}

function docStatus(res, origin) {
  const rp = resultPath()
  if (fs.existsSync(rp)) {
    try { const data = JSON.parse(fs.readFileSync(rp, 'utf8')); sendJson(res, 200, data, origin); return } catch {}
  }
  // 若结果文件不存在但 job 文件存在且超过 3 分钟，认为脚本已异常退出，不再让前端空等
  const jp = jobPath()
  if (fs.existsSync(jp)) {
    try {
      const st = fs.statSync(jp)
      const ageMin = (Date.now() - st.mtimeMs) / 60000
      if (ageMin > 3) {
        log('DOCSTATUS_TIMEOUT', 'job file age=' + ageMin.toFixed(1) + 'min')
        sendJson(res, 200, { running: false, ok: false, error: '执行超时：脚本未在 3 分钟内返回结果，可能已异常退出。请检查 doc-output.log 和 Excel/WPS 窗口。', steps: [] }, origin)
        return
      }
    } catch {}
  }
  sendJson(res, 200, { running: true }, origin)
}

function scheduleDocOutput(payload, res, origin) {
  const taskName = 'WorkbenchDocOutput'
  const runPs = path.join(docOutDir(), 'scripts', 'schedule-run.ps1')
  if (payload && payload.action === 'delete') {
    exec(`schtasks /Delete /TN ${taskName} /F`, { windowsHide: false }, () => {
      sendJson(res, 200, { ok: true, deleted: true }, origin)
    })
    return
  }
  const time = (payload && payload.time) || '09:00'
  const cmd = `schtasks /Create /TN ${taskName} /SC DAILY /ST ${time} ` +
    `/TR "powershell -NoProfile -ExecutionPolicy Bypass -File \\"${runPs}\\"" /F`
  log('SCHTASKS', cmd)
  exec(cmd, { windowsHide: false }, (err) => {
    if (err) sendJson(res, 500, { ok: false, error: err.message }, origin)
    else sendJson(res, 200, { ok: true, created: true, time }, origin)
  })
}

function handleOpen(payload, res, origin) {
  const raw = String(payload.url || payload.path || '').trim()
  if (!raw) { sendJson(res, 400, { ok: false, error: 'missing url/path' }, origin); return }
  const isWeb = /^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)
  if (isWeb) {
    exec(`start "" ${JSON.stringify(raw)}`, { windowsHide: true }, (err) => {
      if (err) sendJson(res, 500, { ok: false, error: err.message }, origin)
      else sendJson(res, 200, { ok: true }, origin)
    })
    return
  }
  launchLocal(sanitizePath(normalizeTarget(raw)), res, origin)
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || ''
  log('REQ', req.method, req.url, 'origin=', origin)

  if (req.method === 'OPTIONS') { sendJson(res, 204, {}, origin); return }

  const url = (req.url || '').split('?')[0]

  if (req.method === 'GET') {
    if (url === '/ping') {
      const st = fs.statSync(__filename)
      return sendJson(res, 200, {
        ok: true,
        bridge: 'local-bridge.cjs',
        bridgePath: __filename,
        mtime: st.mtime.toISOString(),
        mtimeMs: st.mtimeMs
      }, origin)
    }
    if (url === '/pick-file') return pickFile(res, origin)
    if (url === '/doc-output-status') return docStatus(res, origin)
    if (url === '/doc-output-run') return startOrchestrator(res, origin)
    return sendJson(res, 405, { ok: false, error: 'method not allowed' }, origin)
  }

  if (req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body || '{}') } catch (e) { log('BAD_JSON', e.message) }
      if (url === '/doc-output') return submitDocOutput(payload, res, origin)
      if (url === '/doc-output-run') return startOrchestrator(res, origin)
      if (url === '/schedule-doc-output') return scheduleDocOutput(payload, res, origin)
      if (url === '/open') return handleOpen(payload, res, origin)
      sendJson(res, 404, { ok: false, error: 'not found' }, origin)
    })
    return
  }

  sendJson(res, 405, { ok: false, error: 'method not allowed' }, origin)
})

server.on('error', (e) => {
  log('SERVER_ERROR', e.message)
  console.error('local-bridge error:', e.message)
})

server.listen({ port: PORT, host: '127.0.0.1', exclusive: true }, () => {
  let mtime = 'unknown'
  try { mtime = fs.statSync(__filename).mtime.toISOString() } catch {}
  log('listening on 127.0.0.1:' + PORT, 'bridge-mtime=' + mtime)
  console.log(`local-bridge listening on 127.0.0.1:${PORT} (mtime ${mtime})`)
})
