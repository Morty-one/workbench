/* 云端同步「执行记录」
 *
 * ⚠️ 存储位置必须是 localStorage，不能进 Dexie。
 *    原因：写库会触发 autosync.js 的同步链路（requestSync → markLocalDirty → requestCloudSync），
 *    如果把同步记录写进 IndexedDB，就存在 写记录 → 触发推送 → 再写一条记录 → 再触发推送 … 的循环风险。
 *
 * 记录内容对齐 DocOutput.vue 的「执行记录」范式（共 N 次 · 成功 X · 失败 Y + 导出 xlsx + 清空 + 分页 6/页）。
 */

const KEY = 'wb_synclog_v1'
const CAP = 200

// 触发方式：与 cloudsync.js 里 runSync(reason) 的 reason 取值一一对应
// ⚠️ auto（编辑后自动推送）已被 AUTO_SYNC_FEATURES.autoPush=false 关闭；
//    boot（打开时自动拉取）自 2026-09-20 晚起已由 bootPull=true 重新启用。
//    因此实际会记到 test / manual / scheduled / boot 四类；auto 的映射保留，供后续恢复时直接可用。
export const SYNC_TRIGGERS = {
  test: '测试连接',
  manual: '手动同步',
  scheduled: '定时同步',
  auto: '自动推送',
  boot: '打开时同步'
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
export function addSyncLog(reason, info = {}) {
  const trigger = SYNC_TRIGGERS[reason] ? reason : 'manual'
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    at: info.startedAt || Date.now(),
    endedAt: Date.now(),
    trigger,
    triggerLabel: SYNC_TRIGGERS[trigger],
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

// 供导出 xlsx 用的表头（列顺序与 Data.vue 的导出保持一致）
export const SYNC_LOG_HEAD = ['时间', '结束时间', '触发方式', '结果', '说明']
