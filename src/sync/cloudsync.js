// 云端同步编排：整快照 LWW（pull-before-push + updatedAt 时间戳判定）
// - 远端真相源：GitHub 私有库中的 workbench-data-encrypted.json（AES-GCM 加密快照）
// - 本地工作副本：IndexedDB 各表（Dexie）
// - 冲突策略：单用户两设备，最后写入覆盖（少数覆盖丢失可接受，见方案 4.8）
// 与 db.js 存在循环引用（db 中间件 → autosync → 本模块 → db），全部运行时调用，安全。
import { db } from '../db'
import { encryptData, decryptData } from '../crypto'
import { createGitHubBackend } from './GitHubBackend'

const SYNC_TABLES = ['tasks', 'folders', 'notes', 'shortcuts', 'duty', 'settings', 'projects']
// 可勾选的同步模块（设置中心以“类”为单位勾选，内部展开为具体表）
export const SYNC_MODULES = [
  { key: 'tasks', label: '任务', tables: ['tasks'] },
  { key: 'projects', label: '项目', tables: ['projects'] },
  { key: 'notes', label: '笔记与文件夹', tables: ['notes', 'folders'] },
  { key: 'duty', label: '日程值班', tables: ['duty'] },
  { key: 'shortcuts', label: '快捷方式', tables: ['shortcuts'] },
  { key: 'settings', label: '设置', tables: ['settings'] }
]
// 把勾选的模块键展开为具体表名；空/未传 → 全部表（向后兼容）
export function expandModules(keys) {
  const set = new Set()
  const list = (Array.isArray(keys) && keys.length) ? keys : SYNC_MODULES.map(m => m.key)
  for (const m of SYNC_MODULES) if (list.includes(m.key)) m.tables.forEach(t => set.add(t))
  return [...set]
}
// 本机专属配置：还原远端快照时保留本端这些 settings 键（凭据 / 本机目录开关不跨端覆盖）
const LOCAL_ONLY_SETTINGS = [
  'cloudRepo', 'cloudPat', 'cloudPw', 'cloudAutoPush',
  'cloudModules', 'cloudScheduleOn', 'cloudScheduleTime',
  'syncPassword', 'autoSyncDir', 'autoSyncEncryption'
]
const LS_SYNCED_AT = 'wb_cloud_syncedAt' // 本端已确认过的远端快照时间戳（localStorage，避免写 settings 触发同步循环）
const LS_DIRTY_AT = 'wb_cloud_dirtyAt' // 本端最后一次本地修改时间

// ---- 模块状态 ----
let cfg = { repo: '', pat: '', pw: '', autoPush: true, modules: null }
let ready = false // 初始拉取完成前禁止自动推送（防种子数据覆盖远端）
let pulledInSession = false // 本次会话是否成功完成过一轮 pull 判定
let syncing = false
let restoring = false
let pushTimer = null
const state = { lastSyncAt: 0, lastResult: '', lastError: '' }
const listeners = new Set()

function emit() {
  for (const fn of listeners) { try { fn({ ...state }) } catch (_) { /* ignore */ } }
}
export function onCloudState(fn) { listeners.add(fn); return () => listeners.delete(fn) }
export function getCloudState() { return { ...state, ready, configured: cloudConfigured() } }
export function isRestoring() { return restoring }
export function cloudConfigured() { return !!(cfg.repo && cfg.pat && cfg.pw) }

export function configureCloud(opts = {}) {
  if (typeof opts.repo === 'string') cfg.repo = opts.repo
  if (typeof opts.pat === 'string') cfg.pat = opts.pat
  if (typeof opts.pw === 'string') cfg.pw = opts.pw
  if (typeof opts.autoPush === 'boolean') cfg.autoPush = opts.autoPush
  if (Array.isArray(opts.modules)) cfg.modules = opts.modules
}

export function deviceType() {
  const ua = navigator.userAgent
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ? 'mobile' : 'pc'
}

function backend() { return createGitHubBackend(cfg.repo, cfg.pat) }
function getSyncedAt() { return Number(localStorage.getItem(LS_SYNCED_AT) || 0) }
function setSyncedAt(v) { try { localStorage.setItem(LS_SYNCED_AT, String(v)) } catch (_) { /* ignore */ } }
function getDirtyAt() { return Number(localStorage.getItem(LS_DIRTY_AT) || 0) }
export function markLocalDirty() {
  try { localStorage.setItem(LS_DIRTY_AT, String(Date.now())) } catch (_) { /* ignore */ }
}

// ---- base64（UTF-8 安全）----
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
function b64ToUtf8(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

// ---- 快照采集 / 还原 ----
// tablesArg：本次要同步的具体表（来自勾选模块的展开并交集）；缺省取 cfg.modules 展开（再缺省全部）
export async function collectSnapshot(tablesArg) {
  const names = (tablesArg && tablesArg.length) ? tablesArg : expandModules(cfg.modules)
  const tables = {}
  for (const name of names) tables[name] = await db.table(name).toArray()
  // updatedAt = 本端最后一次本地修改时间（而非采集时间），否则本端永远“最新”导致远端永远不还原
  const dirty = getDirtyAt()
  return { version: 1, device: deviceType(), updatedAt: dirty > 0 ? dirty : Date.now(), tables }
}

// 用远端快照覆盖本地「指定表」；保留本机专属配置键（写回在事务外，避免未勾选 settings 时事务缺表报错）
export async function restoreSnapshot(snap, tablesArg) {
  restoring = true
  const names = (tablesArg && tablesArg.length) ? tablesArg : expandModules(cfg.modules)
  try {
    // 先取出本机专属配置，还原后写回（远端 settings 不含/含旧值都不能覆盖本端凭据）
    const localKeep = {}
    for (const k of LOCAL_ONLY_SETTINGS) {
      const row = await db.settings.get(k)
      if (row) localKeep[k] = row
    }
    await db.transaction('rw', names, async () => {
      for (const name of names) {
        await db.table(name).clear()
        const rows = (snap.tables && snap.tables[name]) || []
        if (rows.length) await db.table(name).bulkAdd(rows)
      }
    })
    for (const k of Object.keys(localKeep)) await db.settings.put(localKeep[k])
    // 通知 autosync 把还原后的数据落一份到本地目录（PC）
    try { window.dispatchEvent(new CustomEvent('wb:cloud-restored')) } catch (_) { /* ignore */ }
  } finally {
    restoring = false
  }
}

// ---- 完整同步：pull-before-push（LWW）----
// 规则：
//   unseen = 远端 updatedAt > 本端已确认时间戳（说明远端有本端没见过的版本）
//   满足 unseen 且（本次会话没拉取过 或 远端比本端最后修改更新）→ 用远端还原本地
//   否则 → 把本端快照加密推送（带 sha，409 自动重试一次）
async function syncOnce(reason, tablesArg) {
  const be = backend()
  // 1) pull
  const got = await be.get()
  let remoteSnap = null
  let sha = null
  if (got) {
    sha = got.sha
    try {
      remoteSnap = await decryptData(JSON.parse(b64ToUtf8(got.content)), cfg.pw)
    } catch (_) {
      throw new Error('解密失败：云端加密密码与本端设置不一致')
    }
  }
  const syncedAt = getSyncedAt()
  const localSnap = await collectSnapshot(tablesArg)
  const unseen = remoteSnap && remoteSnap.updatedAt > syncedAt
  // 2) LWW 判定（只针对本次勾选的表做还原，未勾选模块保持本端不变）
  if (unseen && (!havePulledBeforeCheck() || remoteSnap.updatedAt > localSnap.updatedAt)) {
    await restoreSnapshot(remoteSnap, tablesArg)
    setSyncedAt(remoteSnap.updatedAt)
    state.lastSyncAt = Date.now()
    state.lastResult = '已从云端还原（远端较新）'
    state.lastError = ''
    emit()
    return { restored: true }
  }
  // 3) push（仅推送本次勾选的表）
  const enc = await encryptData(localSnap, cfg.pw)
  const b64 = utf8ToB64(JSON.stringify(enc))
  const msg = 'workbench sync · ' + localSnap.device + ' · ' + reason + ' · ' + new Date().toISOString()
  try {
    await be.put(b64, sha, msg)
  } catch (e) {
    if (e && e.code === 409) {
      // 期间远端又被更新：重新拉一次再比一次，最多重试一轮
      const again = await be.get()
      let againSnap = null
      if (again) {
        try { againSnap = await decryptData(JSON.parse(b64ToUtf8(again.content)), cfg.pw) } catch (_) { throw new Error('解密失败：云端加密密码与本端设置不一致') }
      }
      if (againSnap && againSnap.updatedAt > localSnap.updatedAt) {
        await restoreSnapshot(againSnap, tablesArg)
        setSyncedAt(againSnap.updatedAt)
        state.lastSyncAt = Date.now()
        state.lastResult = '远端并发更新，已采用远端较新版本'
        state.lastError = ''
        emit()
        return { restored: true }
      }
      await be.put(b64, again ? again.sha : null, msg)
    } else {
      throw e
    }
  }
  setSyncedAt(localSnap.updatedAt)
  state.lastSyncAt = Date.now()
  state.lastResult = '已推送到云端 ✓'
  state.lastError = ''
  emit()
  return { restored: false }
}

function havePulledBeforeCheck() {
  // 本次会话已经成功拉取过（boot 阶段拉过）→ 只按时间戳判定；
  // 会话内第一次拉取（含 boot）→ 只要远端有未见过的版本就还原（防止种子/陈旧数据反向覆盖远端）
  return pulledInSession
}

// 手动 / boot / auto 统一入口
// opts.modules：本次要同步的模块键数组（缺省取 cfg.modules）；最终展开为具体表
export async function runSync(reason = 'manual', opts = {}) {
  if (!cloudConfigured()) throw new Error('请先在设置中心填写云端仓库 / PAT / 加密密码')
  if (syncing) throw new Error('同步正在进行中，请稍候')
  syncing = true
  const tables = expandModules((opts && opts.modules && opts.modules.length) ? opts.modules : cfg.modules)
  try {
    const r = await syncOnce(reason, tables)
    pulledInSession = true
    ready = true
    return r
  } catch (e) {
    throw e
  } finally {
    syncing = false
  }
}

// ---- 自动推送（数据变更后防抖触发）----
export function requestCloudSync() {
  if (!cloudConfigured() || !cfg.autoPush || !ready || restoring) return
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    runSync('auto').catch((e) => {
      state.lastError = e.message || String(e)
      state.lastResult = ''
      emit()
      console.warn('[cloudsync] push failed:', e)
    })
  }, 3000)
}

// ---- 应用内定时同步 ----
// GitHub 无法唤醒本地 PC，故由前端在「应用开启」时到点触发；若到点时应用已关闭，则顺延到下一周期。
let scheduleOn = false
let scheduleTime = '17:30'
let scheduleTimer = null
let lastScheduledKey = '' // 含日期，防止同一分钟重复触发，也允许次日同时间点再次触发

export function configureSchedule(on, time) {
  scheduleOn = !!on
  if (typeof time === 'string' && time) scheduleTime = time
  if (scheduleOn && !scheduleTimer && cloudConfigured()) startScheduler()
  if (!scheduleOn && scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null }
}
function startScheduler() {
  if (scheduleTimer) return
  scheduleTimer = setInterval(() => {
    if (!scheduleOn || !cloudConfigured()) return
    const now = new Date()
    const hh = String(now.getHours()).padStart(2, '0')
    const mm = String(now.getMinutes()).padStart(2, '0')
    const hhmm = hh + ':' + mm
    const key = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate() + ' ' + hhmm
    if (hhmm === scheduleTime && key !== lastScheduledKey) {
      lastScheduledKey = key
      runSync('scheduled').catch((e) => {
        state.lastError = e.message || String(e)
        state.lastResult = ''
        emit()
        console.warn('[cloudsync] scheduled sync failed:', e)
      })
    }
  }, 20000)
}

// ---- 应用启动时调用：读配置 → 拉取远端（远端较新则还原并刷新页面）→ 就绪 ----
async function attemptBoot() {
  const r = await runSync('boot')
  pulledInSession = true
  if (r && r.restored) {
    // 整库已换血：刷新页面让所有视图重新加载
    setTimeout(() => location.reload(), 150)
  }
}
export async function bootCloudSync() {
  try {
    const [r, p, w, a, m, so, st] = await Promise.all(
      ['cloudRepo', 'cloudPat', 'cloudPw', 'cloudAutoPush', 'cloudModules', 'cloudScheduleOn', 'cloudScheduleTime']
        .map((k) => db.settings.get(k))
    )
    const modules = (m && Array.isArray(m.value) && m.value.length) ? m.value : SYNC_MODULES.map(x => x.key)
    configureCloud({
      repo: (r && r.value) || '',
      pat: (p && p.value) || '',
      pw: (w && w.value) || '',
      autoPush: !a || a.value !== false,
      modules
    })
    // 定时同步：默认开启、默认 17:30
    configureSchedule(!so || so.value !== false, (st && st.value) || '17:30')
  } catch (_) { /* 配置读取失败按未配置处理 */ }
  if (!cloudConfigured()) { ready = true; return }
  try {
    await attemptBoot()
  } catch (e) {
    state.lastError = e.message || String(e)
    state.lastResult = ''
    emit()
    console.warn('[cloudsync] boot pull failed, will retry in 30s:', e)
    // 弱网重试一次；失败期间保持未就绪（不自动推送），可用设置中心「立即同步」手动重试
    setTimeout(() => {
      attemptBoot().catch(() => {})
    }, 30000)
  }
}

// ---- 连通性测试（设置中心“测试连接”按钮）----
export async function testCloudConnection() {
  const be = backend()
  await be.verify()
  return true
}
