/* 云端同步「执行记录」
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
 */

const KEY = 'wb_synclog_v1'
const CAP = 200

// 触发方式：与 cloudsync.js 里 runSync(reason) 的 reason 取值一一对应
// ⚠️ auto（编辑后自动推送）已被 AUTO_SYNC_FEATURES.autoPush=false 关闭；
//    boot（打开时自动同步）自 2026-09-20 晚起由 bootPull=true 重新启用，
//    且第 40 轮起 bootPush=false ⇒ boot 只拉取、不上传。
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

function readAll() {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch (_) {
    return []
  }
}

function writeAll(arr) {
  try {
    localStorage.setItem(KEY, JSON.stringify(arr))
  } catch (_) {
    /* 配额满：静默忽略，不影响同步本体 */
  }
}

// 记一条同步记录。最新在最前，超过 CAP 截断。
// info.device：'pc' / 'mobile'（由 cloudsync.js 传 deviceType() 的结果）。
// 取不到就留空 ⇒ 界面显示「未记录」，**不做猜测**（旧记录本就没有这个字段）。
export function addSyncLog(reason, info = {}) {
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
  const arr = readAll()
  arr.unshift(entry)
  writeAll(arr.slice(0, CAP))
  return entry
}

export function loadSyncLog() {
  return readAll()
}

export function clearSyncLog() {
  writeAll([])
}

// 单条记录展示用的设备名。旧记录没有该字段 ⇒ 「未记录」（不猜成 PC）。
export function deviceLabelOf(entry) {
  if (!entry) return '未记录'
  if (SYNC_DEVICES[entry.device]) return SYNC_DEVICES[entry.device]
  if (entry.deviceLabel) return entry.deviceLabel
  return '未记录'
}

// 供导出 xlsx 用的表头（列顺序与 Data.vue 的导出保持一致）
export const SYNC_LOG_HEAD = ['时间', '结束时间', '设备', '触发方式', '结果', '说明']
