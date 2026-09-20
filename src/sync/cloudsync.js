// 云端同步编排：整快照 LWW（pull-before-push + updatedAt 时间戳判定）
// - 远端真相源：GitHub 私有库中的 workbench-data-encrypted.json（AES-GCM 加密快照）
// - 本地工作副本：IndexedDB 各表（Dexie）
// - 冲突策略：单用户两设备，最后写入覆盖（少数覆盖丢失可接受，见方案 4.8）
// 与 db.js 存在循环引用（db 中间件 → autosync → 本模块 → db），全部运行时调用，安全。
import { db } from '../db'
import { encryptData, decryptData } from '../crypto'
import { createGitHubBackend } from './GitHubBackend'
import { addSyncLog, markBootMergePending } from './synclog'

// ---- 自动同步方式开关（2026-09-20 定案，当晚二次修订）----------------------------
//   autoPush:false → 本地改动后不再防抖（3 秒）自动推送；手动「立即同步」与每日定时同步不受影响
//   bootPull:true  → 启动（打开工作台）时自动拉取远端。用户 2026-09-20 晚改判：
//                    要「PC 端推完，手机一打开就是最新」，故重新打开本项。
// ⚠️ 代码路径完整保留，**改行为只改这里两个布尔值即可**（不要删下面的逻辑分支）。
// ⚠️ bootPull 的时序很关键：App.vue 里 bootCloudSync() 先于 seedIfEmpty() 执行，
//    所以「配置已存在」的设备启动时 dirtyAt 仍为 0 ⇒ localAhead 不成立 ⇒ 一定采用远端。
//    「配置尚不存在」的新容器（先 seed、后手填配置）由 syncOnce() 里第 38 轮新增的
//    `firstSync = syncedAt <= 0` 守卫兜住 —— 首次同步一律以云端为准。
// ⚠️ 第 39 轮（2026-09-20 晚）：boot 拉取还原后会 location.reload()，刷新后 boot 会**再跑一遍**。
//    那一趟原本会走 push 分支，把刚拉下来的整库（约 1.2MB）原样回推，并把云端快照 updatedAt
//    改写成还原前的旧 dirtyAt（实测回退 5 天）。现已由两处改动治掉：
//      ① restoreSnapshot() 还原后把 dirtyAt 对齐到快照时间戳 ⇒ 第二趟不再误判「本端较新」；
//      ② syncOnce() 新增「无需推送」判定：远端 == 本端已确认版本且本端无未推送改动时，直接跳过 push。
//    ⇒ 打开工作台只拉不推；本端确有未推送改动（localAhead）时仍会推送（第 39 轮当时的设计）。
// ⚠️ 第 40 轮（2026-09-20 晚，用户定案）：「打开永远只拉，改动一律手动推」。
//    新增 bootPush:false ⇒ **boot 这一趟不做任何上传**，连 localAhead、以及「云端还没有快照（首次 seed）」
//    都不推；boot 只剩「拉取 / 还原」两个动作。要上传只有两条路：
//      ① 设置中心「立即同步」（manual）② 每日定时同步（scheduled，需应用当时开着）。
//    代价（已与用户确认）：云端为空时打开不会 seed，须手动点一次「立即同步」；
//    本端改完既没点手动、又错过 17:30（或那时没开机）⇒ 改动只在本地，云端不更新。
//    实现位置：syncOnce() 里「3.5) boot 禁推」判定，插在 push 之前 ⇒ 全模块仅有的两处 PUT
//    （主推送 + 409 重试）在 boot 下都够不到，**无需另外去堵 409 分支**。
// ⚠️ 第 41 轮（2026-09-20 深夜，用户定案）：记录分家 + 修掉 boot「双记」。
//    ① 记录分家：boot 记到「拉取记录」（wb_synclog_boot_v1），test/manual/scheduled/auto 记到
//       「同步记录」（wb_synclog_v1）；各 200 条、各自导出/清空/分页 —— 见 synclog.js 顶部注释。
//    ② 双记：attemptBoot() 在 reload 前调 markBootMergePending()，刷新后那趟 boot 的 addSyncLog
//       命中合并分支 ⇒ 不新增第二条，并把结果并回上一条（「已从云端还原并刷新页面 ✓」）。
export const AUTO_SYNC_FEATURES = { autoPush: false, bootPull: true, bootPush: false }

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
let cfg = { repo: '', pat: '', pw: '', autoPush: AUTO_SYNC_FEATURES.autoPush, modules: null }
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
  // 总开关 AUTO_SYNC_FEATURES.autoPush 为 false 时，外部（设置中心）传什么都保持关闭
  if (typeof opts.autoPush === 'boolean') cfg.autoPush = AUTO_SYNC_FEATURES.autoPush && opts.autoPush
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
    // ⚠️ 第 39 轮：整库还原后，本端内容已经 == 云端快照，之前那个「本地脏时间戳」随还原失效。
    //    必须把它对齐到快照时间戳，否则下一轮同步仍会认为「本端有更新的改动」（localAhead 成立），
    //    于是把刚拉下来的整库原样回推一次（约 1.2MB），并把云端快照的 updatedAt 改写成这个旧值。
    //    实测（第 39 轮基线，场景 A）：云端时间戳被从 9/20 20:26 写成 9/15 20:27，回退 5 天。
    const restoredAt = Number(snap && snap.updatedAt) || 0
    if (restoredAt > 0) { try { localStorage.setItem(LS_DIRTY_AT, String(restoredAt)) } catch (_) { /* ignore */ } }
    // 通知 autosync 把还原后的数据落一份到本地目录（PC）
    try { window.dispatchEvent(new CustomEvent('wb:cloud-restored')) } catch (_) { /* ignore */ }
  } finally {
    restoring = false
  }
}

// ---- 完整同步：pull-before-push（LWW）----
// 规则：
//   unseen = 远端 updatedAt > 本端已确认时间戳（说明远端有本端没见过的版本）
//   localAhead = 本地有真实改动且严格晚于远端（远端是旧快照）→ 禁止还原，直接推送本地
//   满足 unseen 且非 localAhead 且（本次会话没拉取过 或 远端比本端最后修改更新）→ 用远端还原本地
//   远端已是本端确认版本（!unseen）且本端无未推送改动（!localAhead）→ 无事可做，**不推送**（第 39 轮）
//   否则 → 把本端快照加密推送（带 sha，409 自动重试一次）
async function syncOnce(reason, tablesArg) {
  const be = backend()
  // 1) pull
  const got = await be.get()
  let remoteSnap = null
  let sha = null
  if (got) {
    sha = got.sha
    // 解析与解密必须分开报错：以前两者共用一个 catch，会把「内容为空 / 文件过大」也
    // 伪装成「密码不一致」，排查成本极高。（2026-09 实测：快照 >1MB 时 Contents API
    // 返回空 content，就走到了这条路上，其实是密码完全正确）
    let payload
    try {
      payload = JSON.parse(b64ToUtf8(got.content))
    } catch (_) {
      throw new Error('远端快照解析失败：内容为空或不是合法的加密快照（文件是否已超过 1MB？）')
    }
    try {
      remoteSnap = await decryptData(payload, cfg.pw)
    } catch (_) {
      throw new Error('解密失败：本端密码解不开云端快照（两边加密密码不一致，或云端快照是别的密码推上去的）')
    }
  }
  const syncedAt = getSyncedAt()
  const localSnap = await collectSnapshot(tablesArg)
  const unseen = remoteSnap && remoteSnap.updatedAt > syncedAt
  // 保护性判定（2026-09 新增）：本地已有真实改动（dirtyAt > 0）且严格晚于远端快照
  // ⇒ 远端是旧快照，绝不能拿它覆盖本地。否则当本端「已确认时间戳」缺失/为 0 时，
  // 下面 LWW 判定里的 `!havePulledBeforeCheck()` 分支会在启动瞬间静默吃掉本地新数据。
  //
  // ⚠️ 2026-09-20 晚（第 38 轮）新增前提 `syncedAt > 0`：
  //    「本端从未确认过任何一次同步」时，不许主张本地更新。原因：空容器 / 新设备走完
  //    seedIfEmpty() 之后 dirtyAt≈now，会被判成「本地更新」，于是把**种子数据**推上云端，
  //    覆盖掉真数据（CLOUD-SYNC.md §0.1、§0.2 记的真实事故风险）。
  //    ⇒ 规则收敛成一句话：**每台设备的第一次同步一律以云端为准**，从第二次起才按时间戳比较。
  //    代价（如实记录，勿当 bug）：从未同步成功过、却真持有更新数据的设备，首次同步会采用远端；
  //    已同步过的设备（syncedAt > 0）行为完全不变（回归见 test_bootpull_on 场景 B）。
  const dirtyAt = getDirtyAt()
  const firstSync = syncedAt <= 0
  const localAhead = !!remoteSnap && !firstSync && dirtyAt > 0 && localSnap.updatedAt > remoteSnap.updatedAt
  if (firstSync && remoteSnap) {
    console.warn('[cloudsync] 本端从未确认过同步（syncedAt=0）⇒ 首次同步一律以云端为准，不主张本地更新')
  }
  if (localAhead) {
    console.warn('[cloudsync] 云端快照较旧（远端 ' + new Date(remoteSnap.updatedAt).toLocaleString() +
      ' < 本地 ' + new Date(localSnap.updatedAt).toLocaleString() + '），跳过还原，改为推送本地')
  }
  // 2) LWW 判定（只针对本次勾选的表做还原，未勾选模块保持本端不变）
  if (unseen && !localAhead && (!havePulledBeforeCheck() || remoteSnap.updatedAt > localSnap.updatedAt)) {
    await restoreSnapshot(remoteSnap, tablesArg)
    setSyncedAt(remoteSnap.updatedAt)
    state.lastSyncAt = Date.now()
    state.lastResult = '已从云端还原（远端较新）'
    state.lastError = ''
    emit()
    return { restored: true }
  }
  // 3) 无需推送判定（第 39 轮新增，治「白推整库 + 云端时间戳回退」）
  //    远端已经就是本端确认过的那一版（!unseen），且本端没有未推送的新改动（!localAhead）
  //    ⇒ 没有任何东西需要写回云端。此时若照旧推送，就只是把云端内容原样再 PUT 一次：
  //      ① boot 整库还原 → reload → 第二轮会白推整库（约 1.2MB）；
  //      ② 每次打开工作台（哪怕一个字没改）也会白推一次；
  //      ③ 更糟的是推送载荷的 updatedAt 取的是本端 dirtyAt，会把云端快照时间戳改写成旧值。
  //    保留必须推送的两条路径：远端为 null（云端还没有快照，要 seed）／localAhead（本端有更新的真实改动）。
  if (remoteSnap && !unseen && !localAhead) {
    state.lastSyncAt = Date.now()
    state.lastResult = '已是最新（云端与本端一致，无需推送）'
    state.lastError = ''
    emit()
    return { restored: false, skipped: true }
  }
  // 3.5) boot 禁推（第 40 轮·用户 2026-09-20 定案）：「打开工作台永远只拉，改动一律手动推」
  //      打开时的自动同步不再承担任何上传动作 —— **包括**上面 localAhead（本端有未推送改动）
  //      与「云端还没有快照（首次 seed）」这两种情况。走到这里说明「确实有东西可以推」，但 boot 不推。
  //      ⚠️ 因此第 4 步那次 PUT、以及它 409 重试分支里的第二次 PUT，在 boot 下一律够不到
  //         （全模块只有这两处 PUT，都在本判定之后）。将来若改动位置，务必重新确认这一点。
  if (reason === 'boot' && !AUTO_SYNC_FEATURES.bootPush) {
    state.lastSyncAt = Date.now()
    state.lastResult = remoteSnap
      ? (localAhead
        ? '本端有未上传的改动；打开时只拉取不上传，请点「立即同步」上传'
        : '已是最新（打开只拉取，不上传）')
      : '云端还没有快照；打开时不上传，本端数据请点「立即同步」上传'
    state.lastError = ''
    emit()
    return { restored: false, skipped: true }
  }
  // 4) push（仅推送本次勾选的表）
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
        let againPayload
        try {
          againPayload = JSON.parse(b64ToUtf8(again.content))
        } catch (_) {
          throw new Error('远端快照解析失败：内容为空或不是合法的加密快照（文件是否已超过 1MB？）')
        }
        try { againSnap = await decryptData(againPayload, cfg.pw) } catch (_) { throw new Error('解密失败：本端密码解不开云端快照（两边加密密码不一致，或云端快照是别的密码推上去的）') }
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
  state.lastResult = localAhead ? '本地较新（云端是旧快照），已推送本地 ✓' : '已推送到云端 ✓'
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
  const startedAt = Date.now()
  const tables = expandModules((opts && opts.modules && opts.modules.length) ? opts.modules : cfg.modules)
  // 第 40 轮：执行记录里带上触发设备（PC / 手机）—— 多端共用云端快照，日志必须能分辨是谁做的
  const dev = deviceType()
  try {
    const r = await syncOnce(reason, tables)
    pulledInSession = true
    ready = true
    // 执行记录：一次同步只记一条，结果文案直接用状态里的 lastResult（推送/拉取都由它描述）
    addSyncLog(reason, { ok: true, result: state.lastResult || '已同步 ✓', startedAt, device: dev })
    return r
  } catch (e) {
    addSyncLog(reason, { ok: false, error: e && e.message ? e.message : String(e), startedAt, device: dev })
    throw e
  } finally {
    syncing = false
  }
}

// ---- 自动推送（数据变更后防抖触发）----
// ⚠️ 当前已由 AUTO_SYNC_FEATURES.autoPush = false 关闭（用户定案），写库不再触发同步。
export function requestCloudSync() {
  if (!AUTO_SYNC_FEATURES.autoPush) return // 「编辑后自动推送」已关闭
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
  if (!AUTO_SYNC_FEATURES.bootPull) return // 「开机拉取」已关闭
  const r = await runSync('boot')
  pulledInSession = true
  if (r && r.restored) {
    // 整库已换血：刷新页面让所有视图重新加载
    // ⚠️ 刷新后 boot 会再跑一趟。那一趟由三道判定兜住：
    //    ① 第 39 轮「无需推送」判定（远端 == 本端已确认版本、且还原已把 dirtyAt 对齐）；
    //    ② 第 40 轮「boot 禁推」判定（打开时一律不 PUT）—— 现在这层是主要保险；
    //    ③ 第 41 轮「记录合并」——刷新后那趟 boot **不再新增第二条记录**，而是并回这一条
    //       （markBootMergePending → addSyncLog 命中合并分支，标注「已从云端还原并刷新页面」）。
    markBootMergePending()
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
      // 存的偏好仍读出来，但受总开关压制（见 AUTO_SYNC_FEATURES）
      autoPush: AUTO_SYNC_FEATURES.autoPush && (!a || a.value !== false),
      modules
    })
    // 定时同步：默认开启、默认 17:30
    configureSchedule(!so || so.value !== false, (st && st.value) || '17:30')
  } catch (_) { /* 配置读取失败按未配置处理 */ }
  if (!cloudConfigured()) { ready = true; return }
  if (!AUTO_SYNC_FEATURES.bootPull) {
    // 「开机拉取」已关闭：启动不做任何自动同步，直接置就绪。
    // 之后仍可用设置中心「立即同步」手动拉取/推送，每日定时同步也照常工作。
    ready = true
    return
  }
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
  const startedAt = Date.now()
  const dev = deviceType()   // 第 40 轮：记录里标注是哪台设备点的「测试连接」
  try {
    await be.verify()
    addSyncLog('test', { ok: true, result: '连接正常：仓库可读、令牌有效', startedAt, device: dev })
    return true
  } catch (e) {
    addSyncLog('test', { ok: false, error: e && e.message ? e.message : String(e), startedAt, device: dev })
    throw e
  }
}
