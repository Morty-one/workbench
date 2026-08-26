// 自动同步：把整个工作台数据写到用户选定的本地目录
// - 明文模式：workbench-data.json
// - 加密模式：workbench-data-encrypted.json（AES-GCM，密码本地保存）
// 两者互斥，切换时自动清理另一种文件，避免明文密文并存。
// 2026-08-22 起：任何数据变更除写本地目录外，同时防抖推送到 GitHub 私有库（云端同步）。
// 与 db.js 互相引用，但只在运行时调用 db，不在模块求值期使用，循环引用安全。
import { db } from './db'
import { encryptData } from './crypto'
import { requestCloudSync, isRestoring, markLocalDirty } from './sync/cloudsync'

let dirHandle = null
let enabled = false
let encEnabled = false
let pw = ''
let scheduled = false
const PLAIN = 'workbench-data.json'
const ENC = 'workbench-data-encrypted.json'

// 由 Data.vue 在目录 / 开关 / 加密模式变化时调用
export function configureSync(handle, isEnabled, opts = {}) {
  dirHandle = handle || null
  enabled = !!isEnabled
  encEnabled = !!opts.encryption
  if (typeof opts.password === 'string') pw = opts.password
  if (enabled && dirHandle) forceSync()
}

async function collect() {
  const [tasks, folders, notes, shortcuts, duty, settings, projects] = await Promise.all([
    db.tasks.toArray(),
    db.folders.toArray(),
    db.notes.toArray(),
    db.shortcuts.toArray(),
    db.duty.toArray(),
    db.settings.toArray(),
    db.projects.toArray()
  ])
  return {
    tasks,
    folders,
    notes,
    shortcuts,
    duty,
    settings,
    projects,
    exportedAt: new Date().toISOString()
  }
}

async function writeFile(name, content) {
  const fh = await dirHandle.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(content)
  await w.close()
}

async function removeFile(name) {
  try {
    await dirHandle.removeEntry(name)
  } catch (_) {
    /* 文件不存在则忽略 */
  }
}

async function doWrite() {
  const data = await collect()
  if (encEnabled && pw) {
    const enc = await encryptData(data, pw)
    await writeFile(ENC, JSON.stringify(enc, null, 2))
    await removeFile(PLAIN)
  } else {
    await writeFile(PLAIN, JSON.stringify(data, null, 2))
    await removeFile(ENC)
  }
}

async function writeSnapshot() {
  if (!dirHandle) return
  try {
    await doWrite()
  } catch (e) {
    // 权限可能被回收，重新申请一次再试
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      try {
        if ((await dirHandle.requestPermission({ mode: 'readwrite' })) === 'granted') {
          await doWrite()
        }
      } catch (_) {
        /* 用户拒绝，静默 */
      }
    } else {
      throw e
    }
  }
}

// 防抖：多次写操作合并成一次落盘；同时记录本地脏时间戳并防抖推送云端
export function requestSync() {
  if (isRestoring()) return // 云端还原过程中的写库不触发同步（避免半成品快照落盘）
  markLocalDirty()
  requestCloudSync()
  if (!enabled || !dirHandle || scheduled) return
  scheduled = true
  setTimeout(() => {
    scheduled = false
    writeSnapshot().catch((e) => console.warn('[autosync] write failed:', e))
  }, 600)
}

// 立即同步一次（忽略防抖，用于开关刚打开时让文件立刻出现）
export function forceSync() {
  if (isRestoring()) return
  if (enabled && dirHandle) {
    scheduled = false
    writeSnapshot().catch((e) => console.warn('[autosync] write failed:', e))
  }
}

// 云端还原完成后：把还原后的数据立刻落一份到本地目录（PC 双写）
if (typeof window !== 'undefined') {
  window.addEventListener('wb:cloud-restored', () => {
    if (enabled && dirHandle) {
      writeSnapshot().catch((e) => console.warn('[autosync] write-after-restore failed:', e))
    }
  })
}
