/**
 * Workbench local bridge
 * Provides a tiny localhost-only API for the browser to open local files/apps
 * and to drive the "Doc Output" RPA orchestration.
 *
 * Security note: binds 127.0.0.1 only, so it is unreachable from any remote
 * host. We echo back a loopback/null origin as the CORS allow-list.
 */
const http = require('http')
const { exec, spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

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
  // 同 OPTIONS 块：跨域响应统一 ACAO=*（bridge 仅 bind 127.0.0.1，host 即安全边界）
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Vary', 'Origin')
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

// 路径清洗：只挡「不可控字符」—— 换行/回车/NUL 会让 cmd 的命令行解析错位。
// ⚠️ 绝不再删除 `| & ; $ < >`：这些字符在 Windows 文件名里**完全合法**（例如「报表A&B.xlsx」），
//    旧实现（第 43 轮前）会把它们悄悄吞掉 ⇒ 拼出一个不存在的路径 ⇒ 用户看到「打开了但没反应」。
//    反正路径最终一律用双引号包裹（见 quoteCmdArg），`&`、`|` 在引号内不再被 cmd 当控制符。
function sanitizePath(p) {
  return String(p || '').replace(/[\r\n\0]/g, '').trim()
}

// cmd 参数引用：双引号包裹。Windows 文件名不允许出现 `"`，所以无需转义内部引号。
// ⚠️ 不要用 JSON.stringify 来引用路径：它会把 `\` 双写成 `\\`（cmd 不认反斜杠转义，
//    于是路径里真出现了双反斜杠 —— 这正是用户截图里看到的现象），也不处理 `%`。
function quoteCmdArg(s) {
  return '"' + String(s || '') + '"'
}

// 解析/校验「设置中心里手工配置的浏览器 exe 路径」。
// 返回空串 = 不可用（调用方退回系统默认打开，并把 fallback 回显给前端）。
function resolveBrowser(exe) {
  const s = String(exe || '').trim().replace(/^["']+|["']+$/g, '')
  if (!s) return ''
  const p = normalizeTarget(s)
  if (!/\.exe$/i.test(p)) return ''
  try { return fs.existsSync(p) ? p : '' } catch (e) { return '' }
}

/* ---------- 第 45 轮：从工作台点开的链接也要遵守「窗口模式」 ---------- */
// 为什么不能只给启动命令加 --start-maximized：浏览器**已经在运行**时，新窗口/标签是由
// 已有进程创建的，命令行开关不会作用到它。2026-09-25 实测：
// `chrome.exe --start-maximized <url>`（浏览器已运行）连新窗口都没建，也没最大化。
// 所以必须走 Win32 ShowWindow —— 见 scripts/win-max.ps1。
function winMaxScriptPath() { return path.join(__dirname, 'scripts', 'win-max.ps1') }
function winMaxExePath() { return path.join(__dirname, 'scripts', 'win-max.exe') }
function winMaxSrcPath() { return path.join(__dirname, 'scripts', 'win-max-src.cs') }
function winMaxSidecarPath() { return path.join(__dirname, 'scripts', 'win-max.exe.sha1') }
function winMaxBuildScriptPath() { return path.join(__dirname, 'scripts', 'build-win-max.ps1') }
function winMaxLogPath() { return path.join(__dirname, 'win-max.log') }

/* ---------- 第 46c 轮：监视器改用**原生 exe**（ps1 降级为兜底） ----------
 * 背景：监视器必须在打开链接**之前**起来（顺序反了就分不清"本来就有的窗口"和"这次新开的"），
 * 所以它的启动开销直接压在用户的那一次点击上。2026-09-25 同一台机、同一条命令行实测：
 *     powershell.exe -NoProfile -ExecutionPolicy Bypass -File win-max.ps1 ...  = 1733 ms
 *     win-max.exe --mode list ...                                               =   95 ms
 * 差 1.6 秒，而 PowerShell 那 1.6 秒跟"最大化"逻辑半点关系都没有，纯粹是它自己启动。
 * exe 与 ps1 的日志契约**逐字一致**（见 scripts/win-max-src.cs 顶部注释），所以桥、测试、
 * 取证脚本都不用改口径；ps1 仍然保留：没有 csc / exe 被杀软删掉的机器照样能最大化，只是慢。
 */
function winMaxImpl() {
  try { return fs.existsSync(winMaxExePath()) ? 'exe' : 'ps1' } catch (e) { return 'ps1' }
}

// 源码改了才重编（哈希放 sidecar 文件）。**哈希比较放在 node 里做** —— 别为了"检查是否最新"
// 去起 PowerShell：实测那个检查走 PS 要 1383 ms，而 node 读文件算 sha1 是 1 ms 级。
// 失败一律静默降级到 ps1，绝不因为它影响"打开链接"。
let exeBuildBusy = false
function ensureWinMaxExe() {
  if (exeBuildBusy) return
  // 仅供自动化测试：验证「exe 缺失 ⇒ 回落 ps1」时必须关掉自愈重编，否则测到一半 exe 就被修好了
  if (process.env.WB_NO_WINMAX_BUILD === '1') { log('WINMAX_EXE_BUILD_SKIPPED', 'WB_NO_WINMAX_BUILD=1'); return }
  let want = ''
  try { want = crypto.createHash('sha1').update(fs.readFileSync(winMaxSrcPath())).digest('hex') } catch (e) { return }
  let have = ''
  try { have = String(fs.readFileSync(winMaxSidecarPath(), 'utf8')).trim() } catch (e) {}
  try { if (have === want && fs.existsSync(winMaxExePath())) return } catch (e) { return }
  if (!fs.existsSync(winMaxBuildScriptPath())) { log('WINMAX_EXE_NO_BUILDER', winMaxBuildScriptPath()); return }
  exeBuildBusy = true
  log('WINMAX_EXE_BUILD_START', 'want=' + want.slice(0, 12) + ' have=' + (have ? have.slice(0, 12) : '(none)'))
  try {
    // 不 detached（第 45 轮实测：detached + windowsHide 下 powershell.exe 会静默起不来）。
    // stdio:'ignore' + unref() 已经够"不挡启动"，编译这几秒本身也在后台。
    const c = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winMaxBuildScriptPath()],
      { windowsHide: true, stdio: 'ignore' })
    c.on('exit', (code) => { log('WINMAX_EXE_BUILD_DONE', 'exit=' + code + ' impl=' + winMaxImpl()) })
    c.on('error', (e) => { log('WINMAX_EXE_BUILD_FAIL', e.message) })
    c.unref()
  } catch (e) {
    log('WINMAX_EXE_BUILD_FAIL', e.message)
  }
}

// 先把 watch 起来（并等它写完窗口快照），调用方随后才启动浏览器。顺序反了就分不清
// 「本来就有的窗口」和「这次新开的窗口」。watch 只负责最大化，**不负责启动**。
function spawnWindowWatch(exe) {
  const ps1 = winMaxScriptPath()
  const impl = winMaxImpl()
  const implPath = impl === 'exe' ? winMaxExePath() : ps1
  if (!fs.existsSync(implPath)) { log('WINMAX_MISSING', implPath); return null }
  const procName = path.basename(String(exe || '')).replace(/\.exe$/i, '').toLowerCase()
  if (!procName) { log('WINMAX_NO_PROC', String(exe || '')); return null }
  const tag = Date.now() + '-' + Math.floor(Math.random() * 1000000)
  const lf = winMaxLogPath()
  log('WINMAX_SPAWN', 'tag=' + tag + ' proc=' + procName + ' impl=' + impl)
  try {
    // ⚠️ 绝不能加 detached:true —— 2026-09-25 实测（四种组合对照）：
    // detached+windowsHide 下 powershell.exe 静默起不来（不写任何日志、stdout/stderr 全空），
    // 只有「不 detached」才是活的。stdio:'ignore' 已经够了（watch 最多活 8 秒）。
    const child = impl === 'exe'
      ? spawn(implPath, ['--mode', 'watch', '--proc', procName, '--tag', tag, '--logfile', lf],
        { windowsHide: true, stdio: 'ignore' })
      : spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        '-Mode', 'watch', '-Proc', procName, '-Tag', tag, '-LogFile', lf],
        { windowsHide: true, stdio: 'ignore' })
    // exe 起不来（被杀软删了、被占用了）时**再给 ps1 一次机会**：这里只降级、不报错。
    child.on('error', (e) => {
      log('WINMAX_SPAWN_FAIL', 'impl=' + impl + ' ' + e.message)
      if (impl === 'exe' && fs.existsSync(ps1)) {
        try {
          const alt = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
            '-Mode', 'watch', '-Proc', procName, '-Tag', tag, '-LogFile', lf], { windowsHide: true, stdio: 'ignore' })
          log('WINMAX_SPAWN_RETRY', 'fallback=ps1 tag=' + tag)
          alt.unref()
        } catch (e2) { log('WINMAX_SPAWN_RETRY_FAIL', e2.message) }
      }
    })
    child.unref()
  } catch (e) { log('WINMAX_SPAWN_FAIL', 'impl=' + impl + ' ' + e.message); return null }
  return { tag, lf }
}

// 等就绪标记（`TAG=<tag> SNAP`）；**超时也照样放行** —— 绝不允许「等最大化」把「打开链接」卡住。
function waitWindowWatchReady(w, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      let text = ''
      try { text = fs.readFileSync(w.lf, 'utf8') } catch (e) { text = '' }
      if (text.indexOf('TAG=' + w.tag + ' SNAP') >= 0) { log('WINMAX_READY', 'tag=' + w.tag); resolve(true); return }
      if (Date.now() >= deadline) { log('WINMAX_SNAP_TIMEOUT', 'tag=' + w.tag); resolve(false); return }
      setTimeout(tick, 60)
    }
    tick()
  })
}

// 用指定的浏览器 exe 打开目标（网页链接或本地文件都适用）
//
// ⚠️ 必须 spawn + stdio:'ignore' + 立刻回 200，**不能用 exec 等回调**：
// 2026-09-25 实测 exec 会挂 >10 秒才回调 —— 新起的浏览器进程继承了 cmd 的 stdout 管道，
// 管道不关 exec 就不回调（与 doc-output 那条链踩过的是同一个坑）。表现就是「点了链接
// 半天没反应，于是又点一次」：桥日志里同一个 kdocs 链接 5 秒内被点了两次，正是这个原因。
// 也不再经 cmd /c start：直接 spawn 目标 exe，URL 里的 & 等字符不经 shell 反而更安全。
function launchBrowser(exe, target, res, origin) {
  const doLaunch = (extra) => {
    log('LAUNCH_BROWSER', 'spawn ' + quoteCmdArg(exe) + ' ' + quoteCmdArg(target))
    try {
      const child = spawn(exe, [target], { windowsHide: true, stdio: 'ignore' })
      child.on('error', (e) => log('BROWSER_FAIL', e.message))
      child.unref()
    } catch (e) {
      log('BROWSER_FAIL', e.message)
      sendJson(res, 500, { ok: false, error: e.message }, origin)
      return
    }
    sendJson(res, 200, Object.assign({ ok: true, browser: exe }, extra || {}), origin)
  }
  // 只有「每次最大化」档才去找新窗口；「记住上次尺寸」档必须什么都不做。
  if (readWindowPref().mode !== 'maximized') { doLaunch(); return }
  const w = spawnWindowWatch(exe)
  if (!w) { doLaunch(); return }
  // 3500ms 而不是 2000ms：ps1 里的 Add-Type 是**运行期编译 C#**，冷启动实测要 ~2s，
  // 2000ms 会卡在边界上误判超时（2026-09-25 第 4 次回归就撞到：请求 2071ms 返回
  // maximized:false，可日志里 SNAP/MAXED 其实都写了）。超时本身仍然放行，只是不再误报。
  waitWindowWatchReady(w, 3500).then((ready) => doLaunch(ready ? { maximized: true } : { maximized: false }))
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
  const launchCmd = `cmd /c start "" ${quoteCmdArg(clean)}`
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
  // 关键：doc-output.ps1 是长时间运行的 Excel/WPS 自动化（可能跑数分钟，且会弹窗）。
  // 旧实现用 exec(..., cb) 启动，Node 会等子进程 stdio 关闭才回调发 200；而该 PowerShell
  // 继承 cmd 管道且本身长时间运行，导致回调永不触发 → HTTP 响应永不发出 → 浏览器 "Failed to fetch"。
  // 改用 spawn + detached + stdio:'ignore' + unref：子进程彻底脱离 Node 事件循环，
  // 立即回 200（"已提交，本机执行中"），执行进度由网页轮询 /doc-output-status 跟踪。
  //
  // 关键：必须加 -STA（STA 单线程单元）。WPS/Excel COM automation **严格要求 STA 线程模型**，
  // PowerShell 默认 MTA 模式下：Excel.Application 容错能跑通，但 WPS COM（KET/Excel/KWPS）
  // 在 MTA 下会抛 COMException → New-Object 被 try-catch 静默吞掉，导致 openWps 三个
  // ProgID 全部"看似失败"，报 "WPS/Excel COM not available"。选文件对话框那边
  //（149 行 pickFile）早就用 -STA 跑通了，主任务这边漏了。
  // ⚠️ 不要试图静默启动（2026-09-12 实测失败，已回退，勿再尝试）
  // 曾把它改成 `spawn('powershell.exe', args, { windowsHide: true })`（CREATE_NO_WINDOW，
  // 直接由 Node 拉起 powershell、不经 cmd）想消掉黑窗。结果整条执行链起不来：
  // 页面永远停在「已提交，本机 Excel/WPS 开始执行…」+「执行中…」，Excel/WPS 根本没启动，
  // 连宏②的文件框都不会弹。原因是这段编排（内部还会用 Playwright 拉 Chromium）需要一个
  // **真实控制台**；CREATE_NO_WINDOW 下拿不到，进程链一启动就死。
  // 结论：`cmd /c start ""` 分配出来的那个可见控制台是**功能必需**，不是可优化项。
  // 用户也已明确「可以接受有弹窗」—— 无论如何都要调用本地文件，不可能完全无感。
  const args = ['/c', 'start', '', 'powershell', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Job', job]
  log('DOCOPEN', 'cmd ' + args.join(' '))
  try {
    const child = spawn('cmd.exe', args, {
      windowsHide: false,   // 保留可见窗口：用户能看到 Excel/WPS 执行 + 宏文件框自动填路径
      detached: true,       // 脱离父进程组
      stdio: 'ignore'       // 不接管 stdio，避免 Node 等待管道 EOF
    })
    child.unref()           // 彻底解除对 Node 事件循环的引用，绝不阻塞 HTTP 响应
    sendJson(res, 200, { ok: true }, origin)
  } catch (e) {
    log('DOCOPEN_FAIL', e.message)
    sendJson(res, 500, { ok: false, error: e.message }, origin)
  }
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
    // DPI：powershell.exe 默认没有 DPI 感知声明（DPI-unaware），Windows 只能把整个对话框
    // 当位图按缩放比拉伸（用户 2560x1600 通常 150%/200%）=> 字看起来发虚。
    // 对话框本身是系统画的（WinForms OpenFileDialog 内部走 comdlg32 通用文件对话框），
    // 糊的原因只在宿主进程；资源管理器清晰是因为 explorer.exe 声明了 DPI 感知。
    // 必须在**创建任何窗口之前**声明。本机实测（2026-09-12，Win11 26100 + PS 5.1）：
    //   - [System.Windows.Forms.Application]::SetHighDpiMode  **不存在**（.NET Framework 未暴露），走不通；
    //   - SetProcessDpiAwarenessContext(-4) PER_MONITOR_AWARE_V2 → True，awareness 0 → 2 ✅ 首选
    //   - SetProcessDPIAware()                                   → True，awareness 0 → 1 ✅ 回退
    // 代价 = 框体不再被放大，比现在略小但清晰。
    'try {',
    '  Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    "  try { Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices; public static class WbDpi { [DllImport(\"user32.dll\")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }' -ErrorAction SilentlyContinue } catch {}",
    '  try { if (-not [WbDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) { [void][WbDpi]::SetProcessDPIAware() } } catch { try { [void][WbDpi]::SetProcessDPIAware() } catch {} }',
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
      // cancelled:true = 用户主动关掉文件框（不是失败）。前端据此走「已取消」轻量弹窗，
      // 不再落进「选择文件失败」分支（否则 B 的「浏览…」取消会被误报成 A 文件选择失败）。
      sendJson(res, 200, { ok: false, cancelled: true, error: '未选择文件（已取消）', path: '' }, origin)
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
  // 第 43 轮：支持「单条链接指定浏览器」。payload.browser = 设置中心里配置的浏览器 exe 路径。
  // 未指定 / 指定但已失效 ⇒ 一律退回系统默认打开，并在响应里回显 fallback，
  // 让前端能如实提示「指定浏览器不存在」而不是静默换掉用户的选择。
  const wantBrowser = String(payload.browser || '').trim()
  const browserExe = wantBrowser ? resolveBrowser(wantBrowser) : ''
  if (wantBrowser && !browserExe) log('BROWSER_INVALID', wantBrowser)
  const fallbackNote = (wantBrowser && !browserExe) ? '指定的浏览器不可用，已用系统默认打开' : ''

  const isWeb = /^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)
  if (isWeb) {
    if (browserExe) return launchBrowser(browserExe, raw, res, origin)
    exec(`cmd /c start "" ${quoteCmdArg(raw)}`, { windowsHide: true }, (err) => {
      if (err) sendJson(res, 500, { ok: false, error: err.message }, origin)
      else sendJson(res, 200, fallbackNote ? { ok: true, fallback: true, note: fallbackNote } : { ok: true }, origin)
    })
    return
  }
  const target = sanitizePath(normalizeTarget(raw))
  // 本地目标指定了浏览器 = 用那个浏览器打开该文件（例如把本地 .html 丢进特定浏览器）
  if (browserExe) return launchBrowser(browserExe, target, res, origin)
  launchLocal(target, res, origin)
}

/* ---------- 工作台窗口模式（最大化 / 记住尺寸） ---------- */
// 为什么存在这里而不是 localStorage：launch-workbench.ps1 要在**启动浏览器之前**决定
// 用哪些参数，而脚本运行时网页还没起来 ⇒ 只能由网页把选择写给桥、桥落盘成 json，
// 下次重开 VBS 时脚本读取。所以这条设置天然是「下次启动生效」，UI 上必须写清楚。
//
// 测试隔离（第 46d 轮）：桥用环境变量 `WB_WINDOW_PREF` 覆盖这个文件路径。
// **测试必须把覆盖指向自己的临时文件**，否则会动到用户真实设置 —— 沙箱每轮删文件有配额，
// unlink 失败会被 try/catch 吞掉 ⇒ 测试能把真实设置**悄悄留在 remember 档**，
// 等于无声关掉「点开链接就最大化」（2026-09-25 真发生过一次）。
function windowPrefOverride() {
  const v = String(process.env.WB_WINDOW_PREF || '').trim()
  return v ? path.resolve(v) : ''
}
function windowPrefPath() { return windowPrefOverride() || path.join(__dirname, 'window-pref.json') }
const WINDOW_MODES = ['maximized', 'remember']

function readWindowPref() {
  try {
    const data = JSON.parse(fs.readFileSync(windowPrefPath(), 'utf8'))
    const mode = WINDOW_MODES.indexOf(String(data && data.mode)) >= 0 ? String(data.mode) : 'maximized'
    return { mode }
  } catch (e) {
    return { mode: 'maximized' }
  }
}

function writeWindowPref(payload, res, origin) {
  const mode = String((payload && payload.mode) || '')
  if (WINDOW_MODES.indexOf(mode) < 0) { sendJson(res, 400, { ok: false, error: 'invalid mode' }, origin); return }
  const file = windowPrefPath()
  try {
    // 覆盖档常指向尚不存在的临时目录（测试的 %TEMP%\…）⇒ 先造目录，
    // 否则 writeFileSync 抛 ENOENT，看起来像"写入功能坏了"，其实是路径没建。
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2))
    log('WINDOWPREF', 'mode=' + mode + ' file=' + file + ' src=' + (windowPrefOverride() ? 'env' : 'default'))
    sendJson(res, 200, { ok: true, mode }, origin)
  } catch (e) {
    log('WINDOWPREF_FAIL', e.message + ' file=' + file)
    sendJson(res, 500, { ok: false, error: e.message }, origin)
  }
}

/* ---------- 本地语音识别 (faster-whisper) ---------- */
// 选定可用的 Python：校验能 import faster_whisper；结果缓存避免重复探测。
let cachedPy = null
function findPython() {
  if (cachedPy) return cachedPy
  const cands = [
    process.env.WB_PYTHON,
    'python',
    'python3',
    'C:\\Users\\morty\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe'
  ].filter(Boolean)
  for (const c of cands) {
    try {
      execSync(`"${c}" -c "import faster_whisper"`, { stdio: 'ignore', timeout: 15000 })
      cachedPy = c
      return c
    } catch (e) {
      /* 试下一个 */
    }
  }
  return null
}

// 常驻 python 子进程，行协议：stdin 写 {"wav":"<b64>"}，stdout 回 {"ok":..,"text":..}
let asrProc = null
let asrCurrentResolve = null
let asrBuf = ''
let asrChain = Promise.resolve()

function onAsrData(data) {
  asrBuf += data.toString()
  let idx
  while ((idx = asrBuf.indexOf('\n')) >= 0) {
    const line = asrBuf.slice(0, idx).trim()
    asrBuf = asrBuf.slice(idx + 1)
    if (!line) continue
    // 非 JSON 的状态行（READY / ASR server starting / INIT_FAIL / MODEL_FAIL）忽略
    if (line === 'READY' || line.startsWith('ASR server starting') ||
        line.startsWith('INIT_FAIL') || line.startsWith('MODEL_FAIL')) continue
    if (asrCurrentResolve) {
      const r = asrCurrentResolve
      asrCurrentResolve = null
      r(line)
    }
  }
}

function spawnAsrChild() {
  const py = findPython()
  if (!py) {
    asrProc = null
    return null
  }
  const script = path.join(__dirname, 'scripts', 'asr_transcribe.py')
  if (!fs.existsSync(script)) {
    log('ASR_NOSCRIPT', script)
    return null
  }
  let child
  try {
    child = spawn(py, [script, '--server', '--model', 'medium', '--lang', 'zh'], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (e) {
    log('ASR_SPAWN_FAIL', e.message)
    return null
  }
  child.stdout.on('data', onAsrData)
  child.stderr.on('data', (d) => log('ASR_ERR', d.toString().slice(0, 300)))
  child.on('exit', (code) => {
    log('ASR_EXIT', 'code=' + code)
    asrProc = null
    if (asrCurrentResolve) {
      const r = asrCurrentResolve
      asrCurrentResolve = null
      r(JSON.stringify({ ok: false, error: '语音识别进程已退出' }))
    }
  })
  asrProc = child
  return child
}

// wavBuffer: Node Buffer（16k 单声道 PCM WAV）。返回 JSON 字符串。串行化避免并发错乱。
function asrTranscribe(wavBuffer) {
  asrChain = asrChain.then(
    () =>
      new Promise((resolve) => {
        if (!asrProc || asrProc.killed) {
          const c = spawnAsrChild()
          if (!c) {
            resolve(JSON.stringify({ ok: false, error: '未找到可用的 Python / faster-whisper，请确认已安装' }))
            return
          }
        }
        const b64 = wavBuffer.toString('base64')
        asrCurrentResolve = resolve
        try {
          asrProc.stdin.write(JSON.stringify({ wav: b64 }) + '\n')
        } catch (e) {
          asrCurrentResolve = null
          resolve(JSON.stringify({ ok: false, error: '发送音频失败：' + e.message }))
          return
        }
        // 安全超时：模型首次加载/转写可能耗时较长
        setTimeout(() => {
          if (asrCurrentResolve === resolve) {
            asrCurrentResolve = null
            resolve(JSON.stringify({ ok: false, error: '语音识别超时（模型加载或转写耗时过长，可重试）' }))
          }
        }, 180000)
      })
  )
  return asrChain
}

function asrHandler(buf, res, origin) {
  if (!buf || !buf.length) {
    sendJson(res, 400, { ok: false, error: '空音频数据' }, origin)
    return
  }
  asrTranscribe(buf).then((out) => {
    let parsed
    try {
      parsed = JSON.parse(out)
    } catch (e) {
      parsed = { ok: false, error: 'ASR 返回无法解析' }
    }
    sendJson(res, 200, parsed, origin)
  })
}

/* ---------- 浏览器探测（设置中心「检测本机常见浏览器」） ---------- */
// 网页里读不到环境变量、也读不到文件系统，所以「哪些浏览器装在本机」只能由桥来扫。
// 只回传真实存在（fs.existsSync）的项，前端拿到即可直接入库，用户不用自己去找 exe 路径。
function detectBrowsers(res, origin) {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const lad = process.env.LOCALAPPDATA || ''
  const cands = [
    { name: 'Edge', exe: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Edge', exe: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Chrome', exe: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Chrome', exe: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Chrome', exe: lad ? path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe') : '' },
    { name: 'Firefox', exe: path.join(pf, 'Mozilla Firefox', 'firefox.exe') },
    { name: 'Firefox', exe: path.join(pf86, 'Mozilla Firefox', 'firefox.exe') },
    { name: 'IE / 旧版', exe: path.join(pf86, 'Internet Explorer', 'iexplore.exe') },
    { name: '360 安全浏览器', exe: path.join(pf86, '360', '360se6', 'Application', '360se.exe') },
    { name: '360 极速浏览器', exe: path.join(pf86, '360Chrome', 'Chrome', 'Application', '360chrome.exe') },
    { name: 'QQ 浏览器', exe: path.join(pf, 'Tencent', 'QQBrowser', 'QQBrowser.exe') },
    { name: '搜狗高速浏览器', exe: path.join(pf86, 'SogouExplorer', 'SogouExplorer.exe') }
  ]
  const found = []
  for (const c of cands) {
    if (!c.exe) continue
    try { if (fs.existsSync(c.exe)) found.push({ name: c.name, exe: c.exe }) } catch (e) {}
  }
  log('DETECT_BROWSERS', 'found=' + found.length)
  sendJson(res, 200, { ok: true, browsers: found }, origin)
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || ''
  log('REQ', req.method, req.url, 'origin=', origin)

  if (req.method === 'OPTIONS') {
    // 204 响应严格禁止带 body（RFC 7230）。若用 sendJson 写 '{}'，Chrome 在跨域
    // 场景会判为 ERR_INVALID_HTTP_RESPONSE 并 reject 整个 fetch → "Failed to fetch"。
    // 因此 OPTIONS 预检必须单独走「204 + 无 body + 显式 CORS 头」。
    //
    // 关键修复：Chrome 128+ 在 PWA 独立窗口 / secure context 下，对 127.0.0.1 的 OPTIONS
    // 会把 Origin 头里的端口**剥掉**（例如发 `Origin: http://127.0.0.1`，但当前页面是
    // `http://127.0.0.1:4173`），导致 server echo 出来的 ACAO 与浏览器内部页面 origin 不匹配
    // → preflight 失败 → "Failed to fetch"。bridge 只 bind 127.0.0.1，安全边界在 host
    // 不在 origin，因此对 OPTIONS/真实响应**统一用 `Access-Control-Allow-Origin: *`**
    // （fetch 默认 credentials:'same-origin' 跨域时不发 cookie，符合 * 的使用条件）。
    const reqMethod = req.headers['access-control-request-method'] || ''
    const reqHeaders = req.headers['access-control-request-headers'] || ''
    const reqPna = req.headers['access-control-request-private-network'] || ''
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', reqMethod || 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', reqHeaders || 'Content-Type')
    if (reqPna) res.setHeader('Access-Control-Allow-Private-Network', 'true')
    res.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network, Access-Control-Request-Method, Access-Control-Request-Headers')
    // 把浏览器实际请求头 + bridge 实际响应关键头打到日志，下次再出"Failed to fetch"时，
    // 仅凭这一行就能定位是请求头缺失还是响应头缺失，不再让用户重开 VBS 反复测
    log('OPTIONS_RESP',
      'reqOrigin=' + (req.headers.origin || ''),
      'reqMethod=' + reqMethod, 'reqHeaders=' + reqHeaders, 'reqPna=' + reqPna,
      'respACAO=*', 'respPna=' + (reqPna ? 'true' : 'false'))
    res.writeHead(204)
    res.end()
    return
  }

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
    if (url === '/window-pref') return sendJson(res, 200, Object.assign({ ok: true }, readWindowPref()), origin)
    if (url === '/detect-browsers') return detectBrowsers(res, origin)
    if (url === '/doc-output-status') return docStatus(res, origin)
    if (url === '/doc-output-run') return startOrchestrator(res, origin)
    return sendJson(res, 405, { ok: false, error: 'method not allowed' }, origin)
  }

  if (req.method === 'POST') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      if (url === '/asr') return asrHandler(buf, res, origin)
      let payload = {}
      try { payload = JSON.parse(buf.toString('utf8')) } catch (e) { log('BAD_JSON', e.message) }
      if (url === '/doc-output') return submitDocOutput(payload, res, origin)
      if (url === '/doc-output-run') return startOrchestrator(res, origin)
      if (url === '/schedule-doc-output') return scheduleDocOutput(payload, res, origin)
      if (url === '/open') return handleOpen(payload, res, origin)
      if (url === '/window-pref') return writeWindowPref(payload, res, origin)
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
  // 第 46d 轮：把"这次到底读哪个窗口设置文件"写进日志。
  // 排查「窗口模式怎么不生效」先看这一行：src=env 说明当前是**测试覆盖档**，
  // 真实 window-pref.json 根本没被读写（测试隔离生效）。
  log('WINDOWPREF_PATH', 'file=' + windowPrefPath() + ' src=' + (windowPrefOverride() ? 'env' : 'default'))
  // 第 46c 轮：确保 scripts/win-max.exe 与源码同步（源码改了才重编，平时只是 node 里比一下 sha1）。
  // 放在 ASR 预加载**之前**，因为下面那个分支会 return，而测试环境（WB_NO_ASR=1）同样需要它。
  try { ensureWinMaxExe() } catch (e) { log('WINMAX_EXE_ENSURE_FAIL', e.message) }
  // 预加载语音识别模型：后台常驻 python 子进程，首次点击语音不再等待模型加载
  // WB_NO_ASR=1 仅供自动化测试使用（搭桥跑断言时没必要白加载几百 MB 的 whisper 模型）
  if (process.env.WB_NO_ASR === '1') { log('ASR_PRELOAD_SKIPPED', 'WB_NO_ASR=1'); return }
  try { spawnAsrChild() } catch (e) { log('ASR_PRELOAD_FAIL', e.message) }
})
