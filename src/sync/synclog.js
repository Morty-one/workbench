/* 云端同步「执行记录」（同步记录 + 拉取记录）
 *
 * ⚠️ 存储位置必须是 localStorage，不能进 Dexie。
 *    原因：写库会触发 autosync.js 的同步链路（requestSync → markLocalDirty → requestCloudSync），
 *    如果把同步记录写进 IndexedDB，就存在 写记录 → 触发推送 → 再写一条记录 → 再触发推送 … 的循环风险。
 *
 * 记录内容对齐 DocOutput.vue 的「执行记录」范式（共 N 次 · 成功 X · 失败 Y + 导出 xlsx + 清空 + 分页 6/页）。
 *
 * ⚠️ 第 40 轮（2026-09-20 晚，用户定案）：记录里增记「触发设备」（PC / 手机）。
 *    起因：同步记录原来只有成功/失败，多端共用云端快照时分不清「这一趟是哪台设备做的」
 *    （云端 commit message 里有 device，但界面看不到）。现在每条记录带 device + deviceLabel，
 *    列表与导出 xlsx 都有「设备」列，统计条另有 PC / 手机 次数拆分。
 *
 * ⚠️ 第 41 轮（2026-09-20 深夜，用户定案）：拆成两份**互相独立**的记录，各自上限 200 条。
 *    起因：打开工作台必跑 boot ⇒ 每次打开至少新增 1 条（还原后刷新还会再加 1 条），
 *          很快把 200 条队列占满，把「我手动推的」记录挤出去 ⇒ 看不清自己做过什么。
 *    分家：
 *      · wb_synclog_v1        → 「同步记录」：test / manual / scheduled / auto（本端主动发起的动作）
 *      · wb_synclog_boot_v1   → 「拉取记录」：boot（打开工作台时的自动拉取，只拉不上传）
 *    两块各自统计 / 导出 / 清空 / 分页，互不挤占。
 *    旧数据迁移：wb_synclog_v1 里 trigger==='boot' 的历史条目会被**惰性**搬到新键（天然幂等，
 *    搬完后 sync 键里不再有 boot 条目，重复执行即空转，因此不需要额外的「已迁移」标记）。
 *
 * ⚠️ 第 41 轮附带修复：还原后刷新导致的 boot「双记」。
 *    attemptBoot() 在 location.reload() 前会调 markBootMergePending()；刷新后那一趟 boot 命中
 *    合并分支 ⇒ **不新增第二条**，而是把结果并回上一条（标注「已从云端还原并刷新页面」）。
 *    标记带 60s 过期保护，且只要 addSyncLog 被调用就会消费掉，避免残留误伤后续记录。
 */

const KEY_SYNC = 'wb_synclog_v1'
const KEY_PULL = 'wb_synclog_boot_v1'
const CAP = 200

// boot 合并标记（sessionStorage，刷新后仍在）：值为打标记的时间戳
const KEY_BOOT_MERGE = 'wb_bootlog_merge'
const BOOT_MERGE_TTL = 60000

// 触发方式：与 cloudsync.js 里 runSync(reason) 的 reason 取值一一对应
// ⚠️ auto（编辑后自动推送）已被 AUTO_SYNC_FEATURES.autoPush=false 关闭；
//    boot（打开时自动同步）自 2026-09-20 晚起由 bootPull=true 重新启用，
//    且第 40 轮起 bootPush=false ⇒ boot 只拉取、不上传（第 41 轮起单独记在「拉取记录」）。
//    因此实际会记到 test / manual / scheduled / boot 四类；auto 的映射保留，供后续恢复时直接可用。
export const SYNC_TRIGGERS = {
  test: '测试连接',
  manual: '手动同步',
  scheduled: '定时同步',
  auto: '自动推送',
  boot: '打开时同步'
}

// 触发设备：与 cloudsync.js 的 deviceType() 返回值一一对应
export const SYNC_DEVICES = {
  pc: 'PC',
  mobile: '手机'
}

function readKey(key) {
  try {
    const raw = localStorage.getItem(key)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch (_) {
    return []
  }
}

function writeKey(key, arr) {
  try {
    localStorage.setItem(key, JSON.stringify(arr))
  } catch (_) {
    /* 配额满：静默忽略，不影响同步本体 */
  }
}

// 第 41 轮：把旧数据里混在「同步记录」中的 boot 条目惰性搬到「拉取记录」。
// 幂等：搬完后 sync 键里不再有 boot 条目 ⇒ 再执行就是空转。
let splitChecked = false
function ensureSplit() {
  if (splitChecked) return
  splitChecked = true
  try {
    const sync = readKey(KEY_SYNC)
    if (!sync.length) return
    const bootOld = sync.filter((e) => e && e.trigger === 'boot')
    if (!bootOld.length) return
    const rest = sync.filter((e) => !(e && e.trigger === 'boot'))
    const seen = {}
    const merged = []
    bootOld.concat(readKey(KEY_PULL)).forEach((e) => {
      if (!e || !e.id || seen[e.id]) return
      seen[e.id] = 1
      merged.push(e)
    })
    merged.sort((a, b) => (b.at || 0) - (a.at || 0))
    writeKey(KEY_PULL, merged.slice(0, CAP))
    writeKey(KEY_SYNC, rest)
  } catch (_) { /* 迁移失败不影响记录写入 */ }
}

function isPullTrigger(trigger) {
  return trigger === 'boot'
}

// 第 41 轮：还原后刷新那一趟 boot 的「并回上一条」处理。
// 命中则就地更新 arr[0]（刷新前刚写的那条 boot 记录），返回 true 表示已消费标记、不要再新增。
function mergeIntoLastBoot(arr, entry) {
  let raw = ''
  try { raw = sessionStorage.getItem(KEY_BOOT_MERGE) || '' } catch (_) { return false }
  if (!raw) return false
  try { sessionStorage.removeItem(KEY_BOOT_MERGE) } catch (_) { /* 忽略 */ }
  const ts = Number(raw)
  if (!ts || Date.now() - ts > BOOT_MERGE_TTL) return false // 过期标记：按新增处理，不做合并
  const last = arr[0]
  // 只在「最近一条确实是同一次同步的 boot 记录」时才并回；否则老实新增一条
  if (!last || last.trigger !== 'boot' || Date.now() - (last.at || 0) > BOOT_MERGE_TTL) return false
  last.endedAt = Date.now()
  last.ok = !!entry.ok
  last.result = entry.ok ? '已从云端还原并刷新页面 ✓' : ''
  last.error = entry.ok ? '' : entry.error
  if (entry.device) {
    last.device = entry.device
    last.deviceLabel = entry.deviceLabel
  }
  last.mergedCount = (last.mergedCount || 1) + 1 // 证据字段：本条并了几趟（正常为 2）
  return true
}

// 记一条记录。最新在最前，超过 CAP 截断。
// info.device：'pc' / 'mobile'（由 cloudsync.js 传 deviceType() 的结果）。
// 取不到就留空 ⇒ 界面显示「未记录」，**不做猜测**（旧记录本就没有这个字段）。
// reason==='boot' ⇒ 写「拉取记录」，其余 ⇒ 写「同步记录」。
export function addSyncLog(reason, info = {}) {
  ensureSplit()
  const trigger = SYNC_TRIGGERS[reason] ? reason : 'manual'
  const device = SYNC_DEVICES[info.device] ? info.device : ''
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    at: info.startedAt || Date.now(),
    endedAt: Date.now(),
    trigger,
    triggerLabel: SYNC_TRIGGERS[trigger],
    device,
    deviceLabel: device ? SYNC_DEVICES[device] : '',
    ok: !!info.ok,
    result: info.ok ? (info.result || '已同步 ✓') : '',
    error: info.ok ? '' : (info.error || '未知错误')
  }
  const pull = isPullTrigger(trigger)
  const key = pull ? KEY_PULL : KEY_SYNC
  const arr = readKey(key)
  if (pull && mergeIntoLastBoot(arr, entry)) {
    writeKey(key, arr.slice(0, CAP))
    return arr[0]
  }
  arr.unshift(entry)
  writeKey(key, arr.slice(0, CAP))
  return entry
}

// 第 41 轮：告诉下一次 boot 记录「并回上一条」，用于还原后刷新（同一趟同步只留一条）。
export function markBootMergePending() {
  try { sessionStorage.setItem(KEY_BOOT_MERGE, String(Date.now())) } catch (_) { /* 忽略 */ }
}

// 同步记录：test / manual / scheduled / auto
export function loadSyncLog() {
  ensureSplit()
  return readKey(KEY_SYNC)
}

// 拉取记录：boot（打开工作台时的自动拉取）
export function loadPullLog() {
  ensureSplit()
  return readKey(KEY_PULL)
}

export function clearSyncLog() {
  writeKey(KEY_SYNC, [])
}

export function clearPullLog() {
  writeKey(KEY_PULL, [])
}

// 单条记录展示用的设备名。旧记录没有该字段 ⇒ 「未记录」（不猜成 PC）。
export function deviceLabelOf(entry) {
  if (!entry) return '未记录'
  if (SYNC_DEVICES[entry.device]) return SYNC_DEVICES[entry.device]
  if (entry.deviceLabel) return entry.deviceLabel
  return '未记录'
}

// 供导出 xlsx 用的表头（列顺序与 Data.vue 的导出保持一致；同步记录与拉取记录共用同一套列）
export const SYNC_LOG_HEAD = ['时间', '结束时间', '设备', '触发方式', '结果', '说明']
