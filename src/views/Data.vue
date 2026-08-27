<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import { db } from '../db'
import { encryptData, decryptData } from '../crypto'
import { configureSync, forceSync } from '../autosync'
import { isIOS } from '../env'
import { configureCloud, configureSchedule, runSync, onCloudState, testCloudConnection, SYNC_MODULES } from '../sync/cloudsync'
import { ensureDefaultProject } from '../seed'
import { SHIFT_OPTIONS, WEEKDAY_LABELS, weekdayText } from '../shift'

const status = ref('')
const settings = reactive({
  defaultFollowUp: 60,
  quadrantColors: {
    'urgent-important': '#ef4444',
    'urgent-notimportant': '#f59e0b',
    'noturgent-important': '#3b82f6',
    'noturgent-notimportant': '#9ca3af'
  }
})
const presets = ref([30, 60, 120, 240, 480])
const newPresetHour = ref(null)
const newPresetMinute = ref(null)
// 知识库笔记标签预设（笔记编辑时可速选，也可自定义）
const noteTags = ref([])
const newNoteTag = ref('')
// 知识库笔记类型（Notes.vue 类型下拉读取）
const noteTypes = ref([
  { key: 'flash', label: '知识速记' },
  { key: 'note', label: '完整笔记' },
  { key: 'meeting', label: '会议记录' }
])
const newNoteTypeKey = ref('')
const newNoteTypeLabel = ref('')
// 文件夹默认笔记类型 / 标签（新建/打开笔记时自动预选）
const noteFolders = ref([])
const folderConfigs = ref({}) // { folderId: { type, tag } }
const folderExpanded = ref({}) // 文件夹默认类型区块的折叠状态 { folderId: boolean }
const notifyOptions = [
  { key: '', label: '— 继承/系统默认 —' },
  { key: 'silent', label: '静默' },
  { key: 'toast', label: '应用内通知' },
  { key: 'wecom', label: '企业微信' }
]
const folderOptions = computed(() => {
  const map = {}
  noteFolders.value.forEach((f) => (map[f.id] = { ...f, children: [], hasChildren: false }))
  noteFolders.value.forEach((f) => {
    if (f.parentId && map[f.parentId]) {
      map[f.parentId].children.push(map[f.id])
      map[f.parentId].hasChildren = true
    }
  })
  const roots = []
  noteFolders.value.forEach((f) => {
    if (!f.parentId || !map[f.parentId]) roots.push(map[f.id])
  })
  roots.sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id))
  const out = []
  function walk(list, depth) {
    list.sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id))
    for (const f of list) {
      out.push({ ...f, indent: depth, parentId: f.parentId })
      walk(f.children, depth + 1)
    }
  }
  walk(roots, 0)
  return out
})
const noteFoldersMap = computed(() => {
  const map = {}
  noteFolders.value.forEach((f) => (map[f.id] = f))
  return map
})
function typeLabel(key) {
  return noteTypes.value.find((t) => t.key === key)?.label || key || ''
}
function tagLabel(key) {
  return key || ''
}
function folderCfg(id) {
  if (!folderConfigs.value[id]) folderConfigs.value[id] = { type: '', tag: '' }
  return folderConfigs.value[id]
}
function effectiveFolderType(folderId, visited = new Set()) {
  const cfg = folderCfg(folderId)
  if (cfg.type) return { key: cfg.type, label: typeLabel(cfg.type), inherited: false, from: folderId }
  let pid = noteFoldersMap.value[folderId]?.parentId
  while (pid && !visited.has(pid)) {
    visited.add(pid)
    const parentCfg = folderCfg(pid)
    if (parentCfg.type) return { key: parentCfg.type, label: typeLabel(parentCfg.type), inherited: true, from: pid }
    pid = noteFoldersMap.value[pid]?.parentId
  }
  const fallback = noteTypes.value[0]
  return { key: fallback?.key || '', label: fallback?.label || '系统默认', inherited: false, system: true }
}
function effectiveFolderTag(folderId, visited = new Set()) {
  const cfg = folderCfg(folderId)
  if (cfg.tag) return { key: cfg.tag, label: tagLabel(cfg.tag), inherited: false, from: folderId }
  let pid = noteFoldersMap.value[folderId]?.parentId
  while (pid && !visited.has(pid)) {
    visited.add(pid)
    const parentCfg = folderCfg(pid)
    if (parentCfg.tag) return { key: parentCfg.tag, label: tagLabel(parentCfg.tag), inherited: true, from: pid }
    pid = noteFoldersMap.value[pid]?.parentId
  }
  return { key: '', label: '无默认标签', inherited: false, system: true }
}
function isFolderVisible(f) {
  if (!f.indent) return true
  let pid = f.parentId
  while (pid) {
    if (!folderExpanded.value[pid]) return false
    pid = noteFoldersMap.value[pid]?.parentId
  }
  return true
}
async function toggleFolderExpand(id) {
  folderExpanded.value[id] = !folderExpanded.value[id]
  await db.settings.put({ key: 'folderDefaultExpanded', value: toPlain(folderExpanded.value) })
}
// 当前用户姓名：自动化规则留空人员时，按此人在日程表中的班次匹配
const currentPerson = ref('')
// 单人班·周末排除人：周六周日不计入在班人数（单人班判定用，可留空）
const singleShiftExclude = ref('')
// 值班周期任务：按「人员 + 星期 + 当日班次 + 时间范围」多重匹配自动生成待办
const periodicDutyTasks = ref([])
const newRuleTitle = ref('')
const newRulePersons = ref([]) // 多执行人员（来自日程表）
const newRuleWeekdays = ref([])
const newRuleShifts = ref([]) // 多选班次：空 = 不限（任意班次）
const newRuleDateRangeStart = ref('') // YYYY-MM-DD，留空=不限制开始
const newRuleDateRangeEnd = ref('') // YYYY-MM-DD，留空=不限制结束
const newRuleDueTime = ref('') // HH:MM，生成任务时作为当天截止时间
const newRuleRemindTime = ref('') // HH:MM，生成任务时作为当天提醒时间
const newRuleDocOutput = ref(false) // 是否关联「文档输出」：生成的任务到完成时间后提示手动执行文档输出
const newRuleQuadrant = ref('noturgent-important')
const newRuleRemark = ref('')
const newRuleLinks = ref([])
// 规则内的子任务条目（数量不定，可动态增删；生成任务时一并带入）
const newRuleSubtasks = ref([])
function addSubtask() {
  newRuleSubtasks.value.push({
    id: String(Date.now()) + Math.random().toString(36).slice(2),
    text: '',
    dueTime: '',
    remindTime: '',
    links: []
  })
}
function removeSubtask(i) {
  newRuleSubtasks.value.splice(i, 1)
}
// 日程表人员下拉
const dutyPersons = ref([])
const personDropdownOpen = ref(false)
const weekdayDropdownOpen = ref(false)
const shiftDropdownOpen = ref(false)
function weekdayLabelOf(v) {
  const w = WEEKDAY_LABELS.find((x) => x.v === v)
  return w ? '周' + w.label : ''
}
function loadDutyPersons() {
  db.duty.toArray().then((rows) => {
    const set = new Set()
    rows.forEach((r) => {
      if (r.person) set.add(r.person.trim())
    })
    const list = Array.from(set).sort()
    // 把「张达」置顶（业务约定）
    const topIdx = list.indexOf('张达')
    if (topIdx > 0) {
      list.splice(topIdx, 1)
      list.unshift('张达')
    }
    dutyPersons.value = list
  })
}
function togglePerson(p) {
  const arr = newRulePersons.value
  const i = arr.indexOf(p)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(p)
}
async function loadNoteFolders() {
  noteFolders.value = await db.folders.toArray()
  // 优先读取新结构 folderConfigs；不存在时兼容旧 folderDefaultTypes
  const map = {}
  const cfg = await db.settings.get('folderConfigs')
  if (cfg && typeof cfg.value === 'object') {
    for (const [id, v] of Object.entries(cfg.value)) {
      if (typeof v === 'string') {
        map[id] = { type: v, tag: '' }
      } else if (v && typeof v === 'object') {
        // 兼容旧 notify 字段，迁移为 tag
        const tag = v.tag || v.notify || ''
        map[id] = { type: v.type || '', tag: tag }
      }
    }
  } else {
    const fd = await db.settings.get('folderDefaultTypes')
    const loaded = fd && typeof fd.value === 'object' ? fd.value : {}
    for (const [id, type] of Object.entries(loaded)) {
      map[id] = { type: type || '', tag: '' }
    }
  }
  noteFolders.value.forEach((f) => {
    if (!map[f.id]) map[f.id] = { type: '', tag: '' }
  })
  folderConfigs.value = map
  const exp = await db.settings.get('folderDefaultExpanded')
  folderExpanded.value = exp && typeof exp.value === 'object' ? exp.value : {}
}
async function saveFolderConfigs() {
  const payload = {}
  for (const [id, cfg] of Object.entries(folderConfigs.value)) {
    if (cfg.type || cfg.tag) {
      payload[id] = { type: cfg.type, tag: cfg.tag }
    }
  }
  await db.settings.put({ key: 'folderConfigs', value: payload })
}
function timeToMinutes(t) {
  if (!t || typeof t !== 'string') return 0
  const [h, m] = t.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0
  return Math.max(0, h * 60 + m)
}
function minutesToTime(min) {
  const m = Math.max(0, Number(min) || 0)
  const h = Math.floor(m / 60) % 24
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// 正在编辑的规则 id（空 = 新增模式）
const editingRuleId = ref('')
const editingPresets = ref(false) // 预设删除❌默认隐藏，点「编辑」后才显示
const showRuleForm = ref(false) // 自动化设置表单默认隐藏，点按钮才展开

// 顶层 TAB：数据管理 / 预设
const topTab = ref('data')
const TOP_TABS = [
  { key: 'data', label: '数据管理' },
  { key: 'preset', label: '预设' }
]
// 预设下的子 TAB：任务 / 知识库 / 自动化 / 外观
const currentTab = ref('tasks')
const TABS = [
  { key: 'tasks', label: '任务预设' },
  { key: 'notes', label: '知识库预设' },
  { key: 'auto', label: '自动化' },
  { key: 'look', label: '外观' }
]

const QUAD_LABELS = {
  'urgent-important': '重要紧急',
  'urgent-notimportant': '不重要紧急',
  'noturgent-important': '重要不紧急',
  'noturgent-notimportant': '不重要不紧急'
}

// 本地目录（File System Access，仅 Chromium）
const hasFSA = typeof window !== 'undefined' && 'showDirectoryPicker' in window
const dirName = ref('（未设置，使用浏览器默认存储）')
let dirHandle = null
const autoSync = ref(false) // 实时同步到选定目录
const encryptMode = ref(false) // 同步文件是否加密（AES）
const syncPassword = ref('') // 加密密码（本地保存，与 IndexedDB 同源）

// 云端同步（GitHub 私有库）
const cloudRepo = ref('')
const cloudPat = ref('')
const cloudPw = ref('')
const cloudAutoPush = ref(true)
const cloudTesting = ref(false)
const cloudSyncing = ref(false)
const cloudLastAt = ref(0)
const cloudLastResult = ref('')
const cloudLastError = ref('')
// 可勾选的同步模块（null/空 = 全选）；每日定时同步开关与时刻
const cloudModules = ref(null)
const cloudScheduleOn = ref(true)
const cloudScheduleTime = ref('17:30')
const syncModules = SYNC_MODULES
let unsubCloudState = null

function applyCloudConfig() {
  configureCloud({
    repo: cloudRepo.value.trim(),
    pat: cloudPat.value.trim(),
    pw: cloudPw.value,
    autoPush: cloudAutoPush.value,
    modules: cloudModules.value
  })
  configureSchedule(cloudScheduleOn.value, cloudScheduleTime.value)
}
async function saveCloudConfig() {
  await db.settings.put({ key: 'cloudRepo', value: cloudRepo.value.trim() })
  await db.settings.put({ key: 'cloudPat', value: cloudPat.value.trim() })
  await db.settings.put({ key: 'cloudPw', value: cloudPw.value })
  await db.settings.put({ key: 'cloudAutoPush', value: cloudAutoPush.value })
  await db.settings.put({ key: 'cloudModules', value: cloudModules.value || [] })
  await db.settings.put({ key: 'cloudScheduleOn', value: cloudScheduleOn.value })
  await db.settings.put({ key: 'cloudScheduleTime', value: cloudScheduleTime.value })
  applyCloudConfig()
  showSaveTip('云端同步配置已保存 ✓')
}
async function testCloud() {
  if (!cloudRepo.value.trim() || !cloudPat.value.trim()) {
    showSaveTip('请先填写仓库与 PAT', false)
    return
  }
  cloudTesting.value = true
  cloudLastError.value = ''
  try {
    applyCloudConfig()
    await testCloudConnection()
    showSaveTip('连接成功 ✓ 仓库可访问')
  } catch (e) {
    showSaveTip('连接失败：' + (e.message || e), false)
  } finally {
    cloudTesting.value = false
  }
}
async function manualCloudSync() {
  if (cloudSyncing.value) return
  cloudSyncing.value = true
  cloudLastError.value = ''
  cloudLastResult.value = '同步中…'
  try {
    applyCloudConfig()
    const r = await runSync('manual')
    if (r && r.restored) {
      cloudLastResult.value = '远端较新，已整库还原，即将刷新页面…'
      setTimeout(() => location.reload(), 1200)
    } else {
      cloudLastResult.value = '已推送 ✓'
    }
  } catch (e) {
    cloudLastError.value = e.message || String(e)
    cloudLastResult.value = ''
  } finally {
    cloudSyncing.value = false
  }
}
// 同步模块勾选：cloudModules 为 null/空表示全选；勾选态 = 全选 或 包含该模块键
function isModuleOn(key) {
  return !cloudModules.value || cloudModules.value.length === 0 || cloudModules.value.includes(key)
}
function toggleModule(key, on) {
  const cur = (cloudModules.value && cloudModules.value.length) ? [...cloudModules.value] : syncModules.map(m => m.key)
  const i = cur.indexOf(key)
  if (on && i === -1) cur.push(key)
  if (!on && i !== -1) cur.splice(i, 1)
  // 全部勾选时归并为 null（语义：全选，避免冗余存储）
  cloudModules.value = (cur.length === syncModules.length) ? null : cur
}
function syncNow() {
  if (!dirHandle) return alert('请先选择数据目录。')
  forceSync()
  const fname = encryptMode.value && autoSync.value ? 'workbench-data-encrypted.json' : 'workbench-data.json'
  flash('已立即同步到目录：' + dirHandle.name + '/' + fname)
}
function toggleAutoSync() {
  db.settings.put({ key: 'autoSyncDir', value: autoSync.value })
  // 关闭实时同步时，加密模式无意义，一并关闭
  if (!autoSync.value) encryptMode.value = false
  db.settings.put({ key: 'autoSyncEncryption', value: encryptMode.value })
  configureSync(dirHandle, autoSync.value, { encryption: encryptMode.value, password: syncPassword.value })
  if (autoSync.value && dirHandle) flash(encryptMode.value ? '已开启加密实时同步 ✓' : '已开启实时同步 ✓')
}
function toggleEncrypt() {
  if (!autoSync.value) {
    encryptMode.value = false
    return
  }
  if (encryptMode.value) {
    const p = prompt('设置同步加密密码（从目录导入时需输入相同密码）：')
    if (!p) {
      encryptMode.value = false
      return
    }
    syncPassword.value = p
    db.settings.put({ key: 'syncPassword', value: p })
  }
  db.settings.put({ key: 'autoSyncEncryption', value: encryptMode.value })
  configureSync(dirHandle, autoSync.value, { encryption: encryptMode.value, password: syncPassword.value })
  if (encryptMode.value) flash('已开启加密实时同步 ✓')
}

const flash = (msg, ms = 2500) => {
  status.value = msg
  setTimeout(() => (status.value = ''), ms)
}

// 设置中心「保存设置」按钮附近的局部提示（成功/失败均可见）
const saveTip = ref('')
const saveTipOk = ref(true)
function showSaveTip(msg, ok = true, ms = 3500) {
  saveTip.value = msg
  saveTipOk.value = ok
  setTimeout(() => {
    if (saveTip.value === msg) saveTip.value = ''
  }, ms)
}

onMounted(() => {
  loadSettings()
  unsubCloudState = onCloudState((s) => {
    cloudLastAt.value = s.lastSyncAt
    cloudLastResult.value = s.lastResult
    cloudLastError.value = s.lastError
  })
  // 点击多选组件外的任意区域 -> 收起所有下拉(人员/班次/周几)
  document.addEventListener('mousedown', onDocMouseDown)
})
onUnmounted(() => {
  if (unsubCloudState) unsubCloudState()
  document.removeEventListener('mousedown', onDocMouseDown)
})
function onDocMouseDown(e) {
  if (e.target && e.target.closest && e.target.closest('.person-select')) return
  personDropdownOpen.value = false
  shiftDropdownOpen.value = false
  weekdayDropdownOpen.value = false
}
async function loadSettings() {
  const d = await db.settings.get('defaultFollowUp')
  if (d) settings.defaultFollowUp = d.value
  const c = await db.settings.get('quadrantColors')
  if (c) settings.quadrantColors = c.value
  const p = await db.settings.get('followUpPresets')
  if (p && Array.isArray(p.value) && p.value.length) presets.value = p.value
  const nt = await db.settings.get('noteTags')
  if (nt && Array.isArray(nt.value)) noteTags.value = nt.value
  const nts = await db.settings.get('noteTypes')
  if (nts && Array.isArray(nts.value) && nts.value.length) noteTypes.value = nts.value
  const pdt = await db.settings.get('periodicDutyTasks')
  if (pdt && Array.isArray(pdt.value)) {
    periodicDutyTasks.value = pdt.value.map((r) => migrateRule(r))
  }
  loadDutyPersons()
  loadNoteFolders()
  const cp = await db.settings.get('currentPerson')
  if (cp && cp.value) currentPerson.value = cp.value
  const sx = await db.settings.get('singleShiftExclude')
  if (sx && sx.value) singleShiftExclude.value = sx.value
  if (hasFSA) {
    const h = await db.handles.get(1)
    if (h?.handle) {
      dirHandle = h.handle
      dirName.value = h.handle.name
    }
    const a = await db.settings.get('autoSyncDir')
    if (a) autoSync.value = !!a.value
    const enc = await db.settings.get('autoSyncEncryption')
    if (enc) encryptMode.value = !!enc.value
    const sp = await db.settings.get('syncPassword')
    if (sp && sp.value) syncPassword.value = sp.value
    configureSync(dirHandle, autoSync.value, { encryption: encryptMode.value, password: syncPassword.value })
  }
  // 云端同步配置（PC / 手机共用，云端加密密码与本地目录加密密码相互独立）
  const cr = await db.settings.get('cloudRepo')
  if (cr && cr.value) cloudRepo.value = cr.value
  const cpat = await db.settings.get('cloudPat')
  if (cpat && cpat.value) cloudPat.value = cpat.value
  const cwp = await db.settings.get('cloudPw')
  if (cwp && cwp.value) cloudPw.value = cwp.value
  const cap = await db.settings.get('cloudAutoPush')
  if (cap) cloudAutoPush.value = cap.value !== false
  const cm = await db.settings.get('cloudModules')
  if (cm && Array.isArray(cm.value)) cloudModules.value = cm.value
  const cso = await db.settings.get('cloudScheduleOn')
  if (cso) cloudScheduleOn.value = cso.value !== false
  const cst = await db.settings.get('cloudScheduleTime')
  if (cst && cst.value) cloudScheduleTime.value = cst.value
  applyCloudConfig()
}

// 进入自动化 tab 时从库里重新拉取规则，确保与任务管理「设为预设」保持同步
watch(currentTab, async (t) => {
  if (t !== 'auto') return
  const pdt = await db.settings.get('periodicDutyTasks')
  if (pdt && Array.isArray(pdt.value)) {
    periodicDutyTasks.value = pdt.value.map((r) => migrateRule(r))
  }
  loadDutyPersons()
})

// 兼容旧规则：把单 person / followMinutes / url 等迁移为新模型
function migrateRule(r) {
  if (!r) return r
  const migrated = {
    weekdays: [],
    shifts: [],
    url: '',
    ...r
  }
  // 旧规则用单 shift 字符串，新规则用 shifts 多选数组（空 = 不限）
  if (!Array.isArray(migrated.shifts)) {
    migrated.shifts = migrated.shift && migrated.shift !== '不限' ? [migrated.shift] : []
  } else if (migrated.shifts.includes('不限')) {
    const others = migrated.shifts.filter((s) => s !== '不限')
    migrated.shifts = others.length ? others : []
  }
  // 旧规则用单 person 字符串，新规则用 persons 数组
  if (!Array.isArray(migrated.persons)) {
    migrated.persons = migrated.person ? [migrated.person] : []
  }
  // 旧规则用 followMinutes 数字，新规则用 dueTime HH:MM
  if (!migrated.dueTime && Number(r.followMinutes) > 0) {
    migrated.dueTime = minutesToTime(r.followMinutes)
  }
  if (!migrated.remindTime) migrated.remindTime = ''
  // 旧规则没有日期范围
  if (!migrated.dateRange) migrated.dateRange = { start: '', end: '' }
  // 子任务迁移 followMinutes/remindMinutes -> dueTime/remindTime
  if (Array.isArray(migrated.subtasks)) {
    migrated.subtasks = migrated.subtasks.map((s) => ({
      ...s,
      dueTime: s.dueTime || (Number(s.followMinutes) > 0 ? minutesToTime(s.followMinutes) : ''),
      remindTime: s.remindTime || (Number(s.remindMinutes) > 0 ? minutesToTime(s.remindMinutes) : ''),
      links: Array.isArray(s.links)
        ? s.links
        : s.url
          ? [{ url: s.url, label: '打开' }]
          : []
    }))
  }
  return migrated
}

function toPlain(v) {
  // 将 Vue reactive / ref proxy 深拷贝为普通 JS 对象/数组，避免 IndexedDB DataCloneError
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return v
  }
}
async function saveSettings() {
  try {
    await db.settings.put({ key: 'defaultFollowUp', value: Number(settings.defaultFollowUp) })
    await db.settings.put({ key: 'quadrantColors', value: toPlain(settings.quadrantColors) })
    await db.settings.put({ key: 'followUpPresets', value: toPlain(presets.value) })
    await db.settings.put({ key: 'noteTags', value: toPlain(noteTags.value) })
    await db.settings.put({ key: 'noteTypes', value: toPlain(noteTypes.value) })
    await db.settings.put({ key: 'folderConfigs', value: toPlain(folderConfigs.value) })
    await db.settings.put({ key: 'periodicDutyTasks', value: toPlain(periodicDutyTasks.value) })
    await db.settings.put({ key: 'currentPerson', value: (currentPerson.value || '').trim() })
    await db.settings.put({ key: 'singleShiftExclude', value: (singleShiftExclude.value || '').trim() })
    showSaveTip('设置已保存 ✓', true)
  } catch (err) {
    console.error('保存设置失败', err)
    showSaveTip('保存失败：' + (err?.message || err), false)
  }
}
async function savePresets() {
  try {
    await db.settings.put({ key: 'followUpPresets', value: toPlain(presets.value) })
  } catch (err) {
    console.error('保存预设失败', err)
    alert('保存预设失败：' + (err?.message || err))
  }
}
function formatMinutes(m) {
  if (m < 60) return m + '分'
  const h = Math.floor(m / 60)
  const min = m % 60
  if (min === 0) return h + '时'
  return h + '时' + min + '分'
}
async function addPreset() {
  const hour = Math.max(0, Number(newPresetHour.value) || 0)
  const minute = Math.max(0, Number(newPresetMinute.value) || 0)
  const v = hour * 60 + minute
  if (v < 1) {
    showSaveTip('预设时长至少 1 分钟', false)
    return
  }
  if (!presets.value.includes(v)) {
    presets.value.push(v)
    presets.value.sort((a, b) => a - b)
  }
  newPresetHour.value = null
  newPresetMinute.value = null
  await saveSettings()
  showSaveTip('已添加并保存预设', true)
}
async function delPreset(v) {
  presets.value = presets.value.filter((x) => x !== v)
  await saveSettings()
  showSaveTip('已删除预设', true)
}
async function addNoteTag() {
  const t = (newNoteTag.value || '').trim()
  if (!t) {
    showSaveTip('请输入标签名', false)
    return
  }
  if (!noteTags.value.includes(t)) noteTags.value.push(t)
  newNoteTag.value = ''
  await saveSettings()
  showSaveTip('已添加并保存标签', true)
}
async function delNoteTag(t) {
  noteTags.value = noteTags.value.filter((x) => x !== t)
  await saveSettings()
  showSaveTip('已删除标签', true)
}
async function addNoteType() {
  const key = (newNoteTypeKey.value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
  const label = (newNoteTypeLabel.value || '').trim()
  if (!key || !label) {
    showSaveTip('请输入类型标识和显示名', false)
    return
  }
  if (noteTypes.value.some((t) => t.key === key)) {
    showSaveTip('该类型标识已存在', false)
    return
  }
  noteTypes.value.push({ key, label })
  newNoteTypeKey.value = ''
  newNoteTypeLabel.value = ''
  await saveSettings()
  showSaveTip('已添加并保存笔记类型', true)
}
async function delNoteType(key) {
  noteTypes.value = noteTypes.value.filter((t) => t.key !== key)
  await saveSettings()
  showSaveTip('已删除笔记类型', true)
}
function toggleNewWeekday(v) {
  const i = newRuleWeekdays.value.indexOf(v)
  if (i >= 0) newRuleWeekdays.value.splice(i, 1)
  else newRuleWeekdays.value.push(v)
}
// 班次多选：「不限」与其余选项互斥；全不选 = 不限
function toggleNewShift(s) {
  const arr = newRuleShifts.value
  const i = arr.indexOf(s)
  if (i >= 0) {
    arr.splice(i, 1)
    return
  }
  if (s === '不限') {
    arr.splice(0, arr.length)
    return
  }
  const ui = arr.indexOf('不限')
  if (ui >= 0) arr.splice(ui, 1)
  arr.push(s)
}
// 规则的班次列表（兼容旧 shift 单值字段；空数组 = 不限）
function ruleShiftsOf(r) {
  let arr = Array.isArray(r.shifts) ? r.shifts.filter(Boolean) : []
  if (!arr.length && r.shift && r.shift !== '不限') arr = [r.shift]
  return arr.filter((s) => s !== '不限')
}
function ruleShiftText(r) {
  const arr = ruleShiftsOf(r)
  return arr.length ? arr.join(' / ') : '任意班次'
}
// 规则条件的人话描述，列表里直接看得懂
function ruleCondText(r) {
  const persons = Array.isArray(r.persons) && r.persons.length ? r.persons : r.person ? [r.person] : currentPerson.value ? [currentPerson.value] : ['当前用户']
  const who = persons.join('、')
  const shift = ruleShiftText(r)
  const dr = r.dateRange || {}
  const rangeText = dr.start || dr.end ? `${dr.start || '起'} ~ ${dr.end || '止'}` : ''
  return `${weekdayText(r.weekdays)} · ${shift} · ${who}${rangeText ? ' · ' + rangeText : ''}`
}
function previewText(r) {
  const who = Array.isArray(r.persons) && r.persons.length ? r.persons.join('、') : r.person || currentPerson.value || '当前用户'
  const shift = ruleShiftText(r)
  const wd = weekdayText(r.weekdays)
  const dr = r.dateRange || {}
  const range = dr.start || dr.end ? `${dr.start || '起'}至${dr.end || '止'}` : ''
  const due = r.dueTime || '当日'
  return `例：${shift} + ${wd}${range ? ' + ' + range : ''} → ${who} 在 ${due} 前完成「${r.title || '任务'}」。`
}
function normalizeUrl(u) {
  const s = (u || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (/^mailto:/i.test(s)) return s
  if (/^app:\/\//i.test(s)) return s
  if (/^file:\/\//i.test(s)) return s
  if (/^[a-zA-Z]:[\\/]/.test(s)) return s
  return 'https://' + s
}
async function addRule() {
  const title = (newRuleTitle.value || '').trim()
  if (!title) {
    showSaveTip('请输入任务标题', false)
    return
  }
  const isEdit = !!editingRuleId.value
  const payload = {
    title,
    persons: newRulePersons.value.slice(),
    weekdays: newRuleWeekdays.value.slice().sort((a, b) => a - b),
    shifts: newRuleShifts.value.filter((s) => s !== '不限').slice(),
    dateRange: {
      start: (newRuleDateRangeStart.value || '').trim(),
      end: (newRuleDateRangeEnd.value || '').trim()
    },
    dueTime: (newRuleDueTime.value || '').trim(),
    remindTime: (newRuleRemindTime.value || '').trim(),
    docOutput: !!newRuleDocOutput.value,
    quadrant: newRuleQuadrant.value,
    remark: (newRuleRemark.value || '').trim(),
    links: (newRuleLinks.value || [])
      .map((u) => (typeof u === 'string' ? { url: normalizeUrl(u), label: '打开' } : { url: normalizeUrl(u && u.url), label: (u && u.label) || '打开' }))
      .filter((l) => l.url),
    subtasks: newRuleSubtasks.value
      .map((s) => ({
        id: s.id,
        text: (s.text || '').trim(),
        dueTime: (s.dueTime || '').trim(),
        remindTime: (s.remindTime || '').trim(),
        links: (Array.isArray(s.links) ? s.links : [])
          .map((u) => (typeof u === 'string' ? { url: normalizeUrl(u), label: '打开' } : { url: normalizeUrl(u && u.url), label: (u && u.label) || '打开' }))
          .filter((l) => l.url)
      }))
      .filter((s) => s.text)
  }
  if (isEdit) {
    const idx = periodicDutyTasks.value.findIndex((r) => r.id === editingRuleId.value)
    if (idx >= 0) {
      const prev = periodicDutyTasks.value[idx]
      periodicDutyTasks.value[idx] = { ...prev, ...payload, enabled: prev.enabled !== false }
    }
  } else {
    periodicDutyTasks.value.push({
      id: String(Date.now()) + Math.random().toString(36).slice(2),
      ...payload,
      enabled: true
    })
  }
  // 重置表单与编辑态
  resetRuleForm()
  await saveSettings()
  showRuleForm.value = false
  showSaveTip(isEdit ? '已更新规则 ✓' : '已添加并保存规则 ✓', true)
}
function resetRuleForm() {
  editingRuleId.value = ''
  newRuleTitle.value = ''
  newRulePersons.value = []
  newRuleWeekdays.value = []
  newRuleShifts.value = []
  newRuleDateRangeStart.value = ''
  newRuleDateRangeEnd.value = ''
  newRuleDueTime.value = ''
  newRuleRemindTime.value = ''
  newRuleDocOutput.value = false
  newRuleQuadrant.value = 'noturgent-important'
  newRuleRemark.value = ''
  newRuleLinks.value = []
  newRuleSubtasks.value = []
  personDropdownOpen.value = false
}

// 进入编辑：把规则预填进表单
function startEditRule(raw) {
  const r = migrateRule(raw)
  showRuleForm.value = true
  editingRuleId.value = r.id
  newRuleTitle.value = r.title || ''
  newRulePersons.value = (r.persons || []).slice()
  newRuleWeekdays.value = (r.weekdays || []).slice().sort((a, b) => a - b)
  newRuleShifts.value = ruleShiftsOf(r).slice()
  const dr = r.dateRange || { start: '', end: '' }
  newRuleDateRangeStart.value = dr.start || ''
  newRuleDateRangeEnd.value = dr.end || ''
  newRuleDueTime.value = r.dueTime || ''
  newRuleRemindTime.value = r.remindTime || ''
  newRuleDocOutput.value = !!r.docOutput
  newRuleQuadrant.value = r.quadrant || 'noturgent-important'
  newRuleRemark.value = r.remark || ''
  // 兼容旧规则的单链接 url/urlLabel，自动迁移为多链接
  const legacyLink = r.url ? [{ url: r.url, label: r.urlLabel || '打开' }] : []
  newRuleLinks.value = Array.isArray(r.links)
    ? r.links.map((u) => (typeof u === 'string' ? { url: u, label: '打开' } : { url: (u && u.url) || '', label: (u && u.label) || '打开' })).filter((l) => l.url)
    : legacyLink
  newRuleSubtasks.value = (r.subtasks || []).map((s) => ({
    id: s.id || String(Date.now()) + Math.random().toString(36).slice(2),
    text: s.text || '',
    dueTime: s.dueTime || '',
    remindTime: s.remindTime || '',
    links: Array.isArray(s.links)
      ? s.links.map((u) => (typeof u === 'string' ? { url: u, label: '打开' } : { url: (u && u.url) || '', label: (u && u.label) || '打开' })).filter((l) => l.url)
      : s.url
        ? [{ url: s.url, label: '打开' }]
        : []
  }))
}
function cancelEditRule() {
  resetRuleForm()
  showRuleForm.value = false
}
function openNewRule() {
  resetRuleForm()
  showRuleForm.value = true
}
async function delRule(id) {
  periodicDutyTasks.value = periodicDutyTasks.value.filter((r) => r.id !== id)
  await saveSettings()
  showSaveTip('已删除规则', true)
}
async function saveNoteTags() {
  try {
    await db.settings.put({ key: 'noteTags', value: toPlain(noteTags.value) })
  } catch (err) {
    console.error('保存标签预设失败', err)
    alert('保存标签预设失败：' + (err?.message || err))
  }
}

/* ---------- 加密导入导出 ---------- */
async function collectAll() {
  return {
    tasks: await db.tasks.toArray(),
    folders: await db.folders.toArray(),
    notes: await db.notes.toArray(),
    shortcuts: await db.shortcuts.toArray(),
    duty: await db.duty.toArray(),
    settings: await db.settings.toArray(),
    projects: await db.projects.toArray()
  }
}
async function applyData(data) {
  await db.transaction(
    'rw',
    db.tasks,
    db.folders,
    db.notes,
    db.shortcuts,
    db.duty,
    db.settings,
    db.projects,
    async () => {
      await Promise.all([
        db.tasks.clear(),
        db.folders.clear(),
        db.notes.clear(),
        db.shortcuts.clear(),
        db.duty.clear(),
        db.settings.clear(),
        db.projects.clear()
      ])
      if (data.tasks?.length) await db.tasks.bulkAdd(data.tasks)
      if (data.folders?.length) await db.folders.bulkAdd(data.folders)
      if (data.notes?.length) await db.notes.bulkAdd(data.notes)
      if (data.shortcuts?.length) await db.shortcuts.bulkAdd(data.shortcuts)
      if (data.duty?.length) await db.duty.bulkAdd(data.duty)
      if (data.settings?.length) await db.settings.bulkAdd(data.settings)
      if (data.projects?.length) await db.projects.bulkAdd(data.projects)
    }
  )
}
async function exportEncrypted() {
  const pw = prompt('设置导出密码（导入时需输入相同密码）：')
  if (!pw) return
  const data = await collectAll()
  const enc = await encryptData(data, pw)
  const blob = new Blob([JSON.stringify(enc, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `workbench-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
  flash('已导出加密备份 ✓')
}
async function importEncrypted(e) {
  const file = e.target.files[0]
  if (!file) return
  const pw = prompt('输入导出时的密码：')
  if (!pw) return
  try {
    const payload = JSON.parse(await file.text())
    const data = await decryptData(payload, pw)
    await applyData(data)
    flash('导入成功，已覆盖本地数据 ✓')
  } catch (err) {
    alert('导入失败：密码错误或文件损坏。')
  } finally {
    e.target.value = ''
    setTimeout(() => (status.value = ''), 3000)
  }
}

/* ---------- 本地目录管理（FSA） ---------- */
async function chooseDir() {
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite' })
    if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return
    dirHandle = h
    dirName.value = h.name
    await db.handles.put({ id: 1, handle: h })
    configureSync(dirHandle, autoSync.value)
    flash('已设置数据目录：' + h.name)
  } catch (err) {
    if (err.name !== 'AbortError') alert('选择目录失败：' + err.message)
  }
}
async function exportToDir() {
  if (!dirHandle) return alert('请先选择数据目录。')
  const pw = prompt('设置导出密码：')
  if (!pw) return
  try {
    const data = await collectAll()
    const enc = await encryptData(data, pw)
    const fname = `workbench-backup-${new Date().toISOString().slice(0, 10)}.json`
    const fh = await dirHandle.getFileHandle(fname, { create: true })
    const w = await fh.createWritable()
    await w.write(JSON.stringify(enc, null, 2))
    await w.close()
    flash('已写入目录：' + dirHandle.name + '/' + fname)
  } catch (err) {
    alert('写入失败：' + err.message)
  }
}
async function importFromDir() {
  if (!dirHandle) return alert('请先选择数据目录。')
  try {
    const [fileHandle] = await window.showOpenFilePicker({
      startIn: dirHandle,
      types: [{ description: '备份', accept: { 'application/json': ['.json'] } }]
    })
    const file = await fileHandle.getFile()
    const text = await file.text()
    let data
    try {
      const parsed = JSON.parse(text)
      // 明文同步文件含业务字段；加密文件是 {alg, salt, iv, ct}
      if (parsed && (parsed.tasks || parsed.folders || parsed.notes || parsed.duty)) {
        data = parsed
      } else {
        throw new Error('not-plain')
      }
    } catch {
      const pw = prompt('该文件为加密备份，输入密码：')
      if (!pw) return
      data = await decryptData(JSON.parse(text), pw)
    }
    await applyData(data)
    flash('已从目录导入 ✓')
  } catch (err) {
    if (err.name !== 'AbortError') alert('导入失败：' + err.message)
  }
}
function copyDirName() {
  navigator.clipboard?.writeText(dirName.value).then(() => flash('已复制目录名'))
}

async function clearAll() {
  if (!confirm('将清空全部本地数据（待办/项目/笔记/快捷方式/值班/设置），且不可恢复！建议先导出备份。确认清空？'))
    return
  await db.transaction(
    'rw',
    db.tasks,
    db.folders,
    db.notes,
    db.shortcuts,
    db.duty,
    db.settings,
    db.projects,
    async () => {
      await Promise.all([
        db.tasks.clear(),
        db.folders.clear(),
        db.notes.clear(),
        db.shortcuts.clear(),
        db.duty.clear(),
        db.projects.clear()
      ])
    }
  )
  // 清空后立刻补回「默认项目」，避免新建任务时无项目可选
  await ensureDefaultProject()
  flash('已清空全部数据')
}
</script>

<template>
  <div class="page">
    <!-- 顶层分类：数据管理 / 预设 -->
    <div class="top-tabs">
      <button
        v-for="t in TOP_TABS"
        :key="t.key"
        class="top-tab"
        :class="{ active: topTab === t.key }"
        @click="topTab = t.key"
      >{{ t.label }}</button>
    </div>

    <div v-show="topTab === 'data'" class="panel-flat section">
      <div class="data-block">
        <h4 class="block-title">数据迁移（加密 JSON）</h4>
        <p class="muted">所有数据仅存于本机浏览器（IndexedDB）。导出为 AES 加密文件，换电脑时导入即可。</p>
        <div class="row">
          <button class="primary" @click="exportEncrypted">导出加密备份</button>
          <label class="import-btn ghost">
            导入备份
            <input type="file" accept="application/json,.json" @change="importEncrypted" hidden />
          </label>
        </div>
        <p v-if="status" class="ok">{{ status }}</p>
      </div>

      <div v-if="hasFSA" class="data-block">
        <h4 class="block-title">数据存放目录（本地文件夹）</h4>
        <p class="muted">
          选择一个本地文件夹作为备份存放处，导出/导入直接读写该文件夹（需 Chrome / Edge 等支持 File System Access 的浏览器）。
        </p>
        <div class="row" style="flex-wrap: wrap; gap: 8px">
          <button class="primary" @click="chooseDir">选择 / 更换目录</button>
          <button class="ghost" @click="exportToDir">导出到目录</button>
          <button class="ghost" @click="importFromDir">从目录导入</button>
          <button class="ghost" @click="copyDirName">复制目录名</button>
          <button class="ghost" @click="syncNow">立即同步</button>
        </div>
        <div class="sync-box">
          <label class="sync-item" :class="{ disabled: !autoSync }">
            <input type="checkbox" v-model="autoSync" @change="toggleAutoSync" />
            <span class="sync-label">
              <strong>实时同步到目录</strong>
              <small>每次增删改自动保存</small>
            </span>
            <span class="sync-state" :class="{ on: autoSync }">{{ autoSync ? '已开启' : '已关闭' }}</span>
          </label>
          <label class="sync-item" :class="{ disabled: !autoSync }">
            <input type="checkbox" v-model="encryptMode" :disabled="!autoSync" @change="toggleEncrypt" />
            <span class="sync-label">
              <strong>加密模式</strong>
              <small>AES · workbench-data-encrypted.json</small>
            </span>
            <span class="sync-state" :class="{ on: encryptMode }">{{ encryptMode ? '已开启' : '已关闭' }}</span>
          </label>
        </div>
        <p class="muted" style="margin-top: 8px">
          当前落盘：<code>{{ (autoSync && encryptMode) ? 'workbench-data-encrypted.json（加密）' : 'workbench-data.json（明文）' }}</code>
          <br />当前目录：<code>{{ dirName }}</code>
          <br />（网页无法自动弹出文件管理器，复制目录名后可在资源管理器中粘贴定位。）
        </p>
      </div>

      <div class="data-block cloud-block">
        <h4 class="block-title">云端同步（GitHub 私有库）</h4>
        <p class="muted">
          数据在 GitHub 私有库中以 <code>workbench-data-encrypted.json</code> 形式存储（本地 AES-GCM 加密后上传）。
          打开应用时自动拉取，本地任何改动 3 秒后自动推送。手机端用同一套设置即可双向同步。
        </p>
        <div class="cloud-form">
          <div class="set-row">
            <label>GitHub 仓库</label>
            <input v-model="cloudRepo" placeholder="owner / repo（如 Morty-one/workbench-sync）" />
          </div>
          <div class="set-row">
            <label>Personal Access Token</label>
            <input v-model="cloudPat" type="password" placeholder="fine-grained PAT · Contents 读写" />
          </div>
          <div class="set-row">
            <label>云端加密密码</label>
            <input v-model="cloudPw" type="password" placeholder="与本机目录加密密码相互独立" />
          </div>
          <div class="sync-box" style="margin-top: 4px">
            <label class="sync-item">
              <input type="checkbox" v-model="cloudAutoPush" @change="saveCloudConfig" />
              <span class="sync-label">
                <strong>编辑后自动推送</strong>
                <small>关闭后只在点击「立即同步」时上传</small>
              </span>
              <span class="sync-state" :class="{ on: cloudAutoPush }">{{ cloudAutoPush ? '已开启' : '已关闭' }}</span>
            </label>
          </div>

          <div class="sync-box" style="margin-top: 10px">
            <div class="sync-label" style="margin-bottom: 6px">
              <strong>同步范围</strong>
              <small>未勾选的模块不同步（不上传、也不被远端覆盖）</small>
            </div>
            <div class="module-grid">
              <label v-for="m in syncModules" :key="m.key" class="module-chip">
                <input type="checkbox" :checked="isModuleOn(m.key)" @change="toggleModule(m.key, $event.target.checked)" />
                <span>{{ m.label }}</span>
              </label>
            </div>
          </div>

          <div class="sync-box" style="margin-top: 10px">
            <label class="sync-item">
              <input type="checkbox" v-model="cloudScheduleOn" @change="saveCloudConfig" />
              <span class="sync-label">
                <strong>每日定时同步</strong>
                <small>应用开启时到点自动同步（GitHub 无法唤醒本地 PC，若到点已关机则顺延到下一周期）</small>
              </span>
              <span class="sync-state" :class="{ on: cloudScheduleOn }">{{ cloudScheduleOn ? '已开启' : '已关闭' }}</span>
            </label>
            <div v-if="cloudScheduleOn" class="schedule-time">
              <label>每日</label>
              <input type="time" v-model="cloudScheduleTime" @change="saveCloudConfig" />
              <span class="muted">自动同步一次</span>
            </div>
          </div>
        </div>
        <div class="row" style="flex-wrap: wrap; gap: 8px; margin-top: 12px">
          <button class="primary" @click="saveCloudConfig">保存配置</button>
          <button class="ghost" :disabled="cloudTesting" @click="testCloud">{{ cloudTesting ? '测试中…' : '测试连接' }}</button>
          <button class="ghost" :disabled="cloudSyncing" @click="manualCloudSync">{{ cloudSyncing ? '同步中…' : '立即同步' }}</button>
        </div>
        <p v-if="cloudLastResult" class="ok" style="margin-top: 8px">
          {{ cloudLastResult }}<span v-if="cloudLastAt"> · {{ new Date(cloudLastAt).toLocaleString() }}</span>
        </p>
        <p v-if="cloudLastError" class="err" style="margin-top: 8px">同步失败：{{ cloudLastError }}</p>

        <details v-if="isIOS" class="ios-guide">
          <summary>iPhone 安装到主屏幕（仅首次需要）</summary>
          <ol>
            <li>用 Safari 打开本页 URL</li>
            <li>点击底部分享按钮「<strong>↑</strong>」→ 选择「<strong>添加到主屏幕</strong>」</li>
            <li>名称默认为「工作台」，点右上角「添加」</li>
            <li>回到桌面点击「工作台」图标，全屏启动（无 Safari 地址栏）</li>
            <li>注意：<strong>只能从主屏图标打开</strong>，Safari 里打开会得到一份独立的 IndexedDB 数据</li>
          </ol>
        </details>
        <p class="muted" style="margin-top: 10px; font-size: 12px">
          凭据仅存在本机 IndexedDB 中，不会上传。PAT 建议只授权这一个私有库且只勾选 Contents 读写权限。
        </p>
      </div>

      <div class="data-block danger-block">
        <h4 class="block-title">危险区</h4>
        <p class="muted">清空后不可恢复，请先导出备份。</p>
        <button class="danger" @click="clearAll">清空全部本地数据</button>
      </div>
    </div>

    <div v-show="topTab === 'preset'" class="panel-flat section settings-section">
      <div class="tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="tab"
          :class="{ active: currentTab === t.key }"
          @click="currentTab = t.key"
        >{{ t.label }}</button>
      </div>

      <!-- 任务预设 -->
      <div v-show="currentTab === 'tasks'" class="tab-panel">
        <div class="setting-group">
          <div class="set-row">
            <label>默认跟进时间（分钟）</label>
            <input type="number" min="1" v-model.number="settings.defaultFollowUp" style="max-width: 140px" @change="saveSettings" />
          </div>
          <div class="set-row">
            <label>跟进时间预设（可增删，待办创建时可选）</label>
            <div class="preset-list">
              <span v-for="p in presets" :key="p" class="preset">
                {{ formatMinutes(p) }}
                <button v-if="editingPresets" class="x" @click="delPreset(p)">×</button>
              </span>
              <button class="ghost sm" @click="editingPresets = !editingPresets">{{ editingPresets ? '完成' : '编辑' }}</button>
            </div>
            <div class="row time-inputs" style="margin-top: 8px">
              <input type="number" min="0" v-model.number="newPresetHour" />
              <span>时</span>
              <input type="number" min="0" max="59" v-model.number="newPresetMinute" />
              <span>分</span>
              <button class="ghost" @click="addPreset">+ 添加预设</button>
            </div>
          </div>
        </div>
        <!-- 任务预设：增删即时保存，无需手动保存按钮 -->
      </div>

      <!-- 知识库预设 -->
      <div v-show="currentTab === 'notes'" class="tab-panel">
        <div class="setting-group">
          <div class="set-row">
            <label>笔记标签（笔记编辑时可速选，也可自定义）</label>
            <div class="preset-list">
              <span v-for="t in noteTags" :key="t" class="preset">
                {{ t }}
                <button v-if="editingPresets" class="x" @click="delNoteTag(t)">×</button>
              </span>
              <button class="ghost sm" @click="editingPresets = !editingPresets">{{ editingPresets ? '完成' : '编辑' }}</button>
            </div>
            <div class="row" style="margin-top: 8px">
              <input v-model="newNoteTag" placeholder="新增标签，如：方法论" style="max-width: 200px" @keyup.enter="addNoteTag" />
              <button class="ghost" @click="addNoteTag">+ 添加标签</button>
            </div>
          </div>
          <div class="set-row">
            <label>笔记类型（Notes.vue 编辑器类型下拉会读取此处配置）</label>
            <div class="preset-list">
              <span v-for="t in noteTypes" :key="t.key" class="preset">
                {{ t.label }}（{{ t.key }}）
                <button v-if="editingPresets" class="x" @click="delNoteType(t.key)">×</button>
              </span>
              <button class="ghost sm" @click="editingPresets = !editingPresets">{{ editingPresets ? '完成' : '编辑' }}</button>
            </div>
            <div class="row" style="margin-top: 8px; flex-wrap: wrap; gap: 8px">
              <input v-model="newNoteTypeKey" placeholder="标识，如：meeting" style="max-width: 140px" @keyup.enter="addNoteType" />
              <input v-model="newNoteTypeLabel" placeholder="显示名，如：会议记录" style="max-width: 160px" @keyup.enter="addNoteType" />
              <button class="ghost" @click="addNoteType">+ 添加类型</button>
            </div>
          </div>
          <div class="set-row">
            <label>文件夹默认笔记类型 / 通知方式</label>
            <p class="muted" style="font-size: 12px; margin: 0 0 8px">为指定文件夹设置默认类型与通知方式。子文件夹未设置时继承父文件夹，均未设置时使用系统默认。</p>
            <div class="folder-default-list">
              <div
                v-for="f in folderOptions"
                v-show="isFolderVisible(f)"
                :key="f.id"
                class="folder-default-row"
                :style="{ paddingLeft: f.indent * 18 + 'px' }"
              >
                <span
                  class="folder-toggle"
                  :class="{ expanded: folderExpanded[f.id], leaf: !f.hasChildren }"
                  @click.stop="toggleFolderExpand(f.id)"
                >
                  <svg v-if="f.hasChildren" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                </span>
                <span class="folder-default-name">{{ f.name }}</span>
                <span class="folder-effective" :class="{ inherited: effectiveFolderType(f.id).inherited, system: effectiveFolderType(f.id).system }">
                  {{ effectiveFolderType(f.id).inherited ? '继承：' : '' }}{{ effectiveFolderType(f.id).label }}
                </span>
                <select v-model="folderConfigs[f.id].type" class="folder-default-type" @change="saveFolderConfigs">
                  <option value="">— 继承/系统默认 —</option>
                  <option v-for="t in noteTypes" :key="t.key" :value="t.key">{{ t.label }}</option>
                </select>
                <span class="folder-effective" :class="{ inherited: effectiveFolderTag(f.id).inherited, system: effectiveFolderTag(f.id).system }">
                  {{ effectiveFolderTag(f.id).inherited ? '继承：' : '' }}{{ effectiveFolderTag(f.id).label }}
                </span>
                <select v-model="folderConfigs[f.id].tag" class="folder-default-type" @change="saveFolderConfigs">
                  <option value="">— 继承/系统默认 —</option>
                  <option v-for="t in noteTags" :key="t" :value="t">{{ t }}</option>
                </select>
              </div>
              <div v-if="!folderOptions.length" class="folder-default-empty">暂无文件夹，请先在知识库中创建。</div>
            </div>
          </div>
        </div>
        <!-- 知识库预设：标签/类型/文件夹默认类型增删即时保存，无需手动保存按钮 -->
      </div>

      <!-- 自动化 -->
      <div v-show="currentTab === 'auto'" class="tab-panel">
        <div class="setting-group">
          <div class="set-row">
            <label>当前用户姓名</label>
            <div class="row" style="align-items: center; gap: 8px">
              <input v-model="currentPerson" placeholder="与日程表中的姓名一致，如：张达" style="max-width: 200px" @change="saveSettings" />
              <span class="muted" style="font-size: 12px">规则不填人员时，按此人在日程表中的班次判断</span>
            </div>
          </div>
          <div class="set-row">
            <label>单人班 · 周末排除人</label>
            <div class="row" style="align-items: center; gap: 8px; flex-wrap: wrap">
              <input v-model="singleShiftExclude" placeholder="如：卢静华（周六周日不计入在班人数）" style="max-width: 320px" @change="saveSettings" />
              <span class="muted" style="font-size: 12px">单人班判定：周一~周五在班总人数=1；周六周日除该人外在班人数=1（可留空）。</span>
            </div>
          </div>
        </div>

        <div class="setting-group">
          <div class="set-row">
            <label>值班周期任务（星期 + 当日班次 双重匹配，每天早 9 点自动生成）</label>
            <p class="muted rule-help">
              每天早 9 点，按下方条件自动生成对应任务，生成结果会直接出现在
              <strong>总览「今天要处理」</strong>与<strong>任务管理</strong>列表里，无需手动建。
              班次取自日程表导入的排班：<code>9:00-c9:00</code> = 主班，<code>9:00-18:00</code> = 副班，
              <code>9:00-20:30</code> 且落在周六日 = 周末白班，无排班记录 = 休班。
            </p>

            <div class="rule-top">
              <button class="primary sm" @click="openNewRule">
                <span class="rt-plus">+</span> 添加预设任务
              </button>
              <span class="muted rt-desc">每天早 9 点按条件自动生成任务；若任务的完成时间已过当天时间，则顺延至次日生成</span>
            </div>
            <div v-if="!periodicDutyTasks.length" class="muted empty-rule">还没有自动化规则。</div>
            <div v-for="r in periodicDutyTasks" :key="r.id" class="rule-card">
              <div class="rc-head">
                <input type="checkbox" v-model="r.enabled" :title="r.enabled ? '已启用' : '已停用'" />
                <span class="rule-title" :class="{ off: !r.enabled }">{{ r.title }}</span>
                <button class="icon-btn" title="编辑规则" @click="startEditRule(r)">✎</button>
                <button class="x" title="删除规则" @click="delRule(r.id)">×</button>
              </div>
              <div class="rc-body">
                <span class="cond-chip cond-main">{{ ruleCondText(r) }}</span>
                <span v-if="r.dueTime" class="cond-chip">截止 {{ r.dueTime }}</span>
                <span class="cond-chip">{{ QUAD_LABELS[r.quadrant] }}</span>
                <span class="cond-chip">子任务 {{ (r.subtasks || []).length }} 条</span>
                <span class="cond-chip">链接 {{ (r.links || []).length }} 个</span>
              </div>
            </div>

            <div v-if="showRuleForm" class="modal-mask">
              <div class="modal rule-modal">
                <div class="modal-head">
                  <strong class="rule-modal-title">预设任务</strong>
                  <button class="x" title="关闭" @click="cancelEditRule">×</button>
                </div>
                <div class="rule-form sample-style">
                  <!-- 任务标题 -->
                  <div class="sample-section">
                    <label class="sample-label">任务标题</label>
                    <input v-model="newRuleTitle" placeholder="如：输出本周周报" class="sample-input" @keyup.enter="addRule" />
                  </div>

                  <!-- 执行人员 -->
                  <div class="sample-section">
                    <label class="sample-label">
                      执行人员
                      <span class="sample-required">*</span>
                      <span class="sample-hint">来自日程管理值班人员，可多选</span>
                    </label>
                    <div class="person-select">
                      <div class="person-trigger" @click="personDropdownOpen = !personDropdownOpen">
                        <span v-if="!newRulePersons.length" class="person-placeholder">点击选择值班人员...</span>
                        <span v-else class="person-tags">
                          <span v-for="p in newRulePersons" :key="p" class="person-tag">{{ p }}</span>
                        </span>
                        <span class="person-arrow">▼</span>
                      </div>
                      <div v-if="personDropdownOpen" class="person-dropdown">
                        <label v-for="p in dutyPersons" :key="p" class="person-option">
                          <input type="checkbox" :checked="newRulePersons.includes(p)" @change="togglePerson(p)" />
                          <span>{{ p }}</span>
                        </label>
                        <div v-if="!dutyPersons.length" class="person-empty">暂无值班人员，请先在日程表导入排班。</div>
                      </div>
                    </div>
                  </div>

                  <!-- 排班条件 -->
                  <div class="sample-section">
                    <label class="sample-label">排班条件</label>
                    <div class="sample-row schedule-row">
                      <div class="person-select shift-multi-select" @click.stop>
                        <div class="person-trigger" @click="shiftDropdownOpen = !shiftDropdownOpen">
                          <span v-if="!newRuleShifts.length" class="person-placeholder">班次：不限（可多选）</span>
                          <span v-else class="person-tags">
                            <span v-for="s in newRuleShifts" :key="s" class="person-tag">{{ s }}</span>
                          </span>
                          <span class="person-arrow">▼</span>
                        </div>
                        <div v-if="shiftDropdownOpen" class="person-dropdown">
                          <label v-for="s in SHIFT_OPTIONS" :key="s" class="person-option">
                            <input type="checkbox" :checked="newRuleShifts.includes(s)" @change="toggleNewShift(s)" />
                            <span>{{ s }}<span v-if="s === '不限'" class="muted opt-note">（清空多选）</span></span>
                          </label>
                        </div>
                      </div>
                      <div class="person-select weekday-select" @click.stop>
                        <div class="person-trigger" @click="weekdayDropdownOpen = !weekdayDropdownOpen">
                          <span v-if="!newRuleWeekdays.length" class="person-placeholder">选择周几...</span>
                          <span v-else class="person-tags">
                            <span v-for="w in newRuleWeekdays" :key="w" class="person-tag">{{ weekdayLabelOf(w) }}</span>
                          </span>
                          <span class="person-arrow">▼</span>
                        </div>
                        <div v-if="weekdayDropdownOpen" class="person-dropdown">
                          <label v-for="w in WEEKDAY_LABELS" :key="w.v" class="person-option">
                            <input type="checkbox" :checked="newRuleWeekdays.includes(w.v)" @change="toggleNewWeekday(w.v)" />
                            <span>{{ '周' + w.label }}</span>
                          </label>
                        </div>
                      </div>
                    </div>
                    <div class="sample-row schedule-row date-range-row">
                      <input v-model="newRuleDateRangeStart" type="date" class="sample-input date-input" placeholder="开始日期" />
                      <input v-model="newRuleDateRangeEnd" type="date" class="sample-input date-input" placeholder="结束日期" />
                    </div>
                    <p class="sample-tip">时间范围留空则默认全部时间，周几留空则不限定星期。</p>
                    <p class="sample-preview">{{ previewText({ title: newRuleTitle, persons: newRulePersons, shifts: newRuleShifts, weekdays: newRuleWeekdays, dateRange: { start: newRuleDateRangeStart, end: newRuleDateRangeEnd }, dueTime: newRuleDueTime }) }}</p>
                  </div>

                  <!-- 完成时限 / 四象限 -->
                  <div class="sample-section">
                    <label class="sample-label">完成时限 / 四象限</label>
                    <div class="sample-row">
                      <input v-model="newRuleDueTime" type="time" class="sample-input time-input" placeholder="完成时限" />
                      <select v-model="newRuleQuadrant" class="sample-select quad-narrow" style="flex: 0 0 auto; max-width: 150px;">
                        <option v-for="(label, key) in QUAD_LABELS" :key="key" :value="key">{{ label }}</option>
                      </select>
                    </div>
                  </div>

                  <!-- 关联文档输出 -->
                  <div class="sample-section do-output-link">
                    <label class="sample-check">
                      <input type="checkbox" v-model="newRuleDocOutput" />
                      <span class="sc-title">关联到「文档输出」</span>
                    </label>
                    <p class="sample-tip sc-desc">该规则生成的任务到完成时间后，会在任务卡片显示「执行文档输出」按钮，点击后先选 A 文件再执行。<br/>文档输出配置仍在「文档输出」页维护；这里只决定哪些预设任务会触发它。</p>
                  </div>

                  <!-- 备注 -->
                  <div class="sample-section">
                    <label class="sample-label">备注</label>
                    <input v-model="newRuleRemark" placeholder="补充说明（生成任务时写入备注）" class="sample-input" />
                  </div>

                  <!-- 快捷链接 -->
                  <div class="sample-section">
                    <label class="sample-label">
                      快捷链接
                      <span class="sample-hint">名称与链接同行，可添加多条</span>
                    </label>
                    <div class="inline-links">
                      <div v-for="(lnk, li) in newRuleLinks" :key="li" class="inline-link-row">
                        <input v-model="newRuleLinks[li].label" placeholder="名称（如：周报）" class="sample-input link-name" />
                        <input v-model="newRuleLinks[li].url" placeholder="链接 URL" class="sample-input link-url" />
                        <button class="inline-del" type="button" @click="newRuleLinks.splice(li, 1)">×</button>
                      </div>
                      <button class="ghost sm add-inline" type="button" @click="newRuleLinks.push({ url: '', label: '' })">+ 添加快捷链接</button>
                    </div>
                  </div>

                  <!-- 子任务 -->
                  <div class="sample-section">
                    <label class="sample-label">
                      子任务
                      <span class="sample-hint">不单独设象限，跟随父任务；可独立设置完成时限和快捷链接</span>
                    </label>
                    <div class="inline-subs">
                      <div v-for="(s, i) in newRuleSubtasks" :key="s.id" class="inline-sub-card">
                        <div class="inline-sub-row">
                          <input v-model="s.text" placeholder="子任务" class="sample-input sub-text" />
                          <input v-model="s.dueTime" type="time" class="sample-input sub-time" />
                          <button class="inline-del" type="button" @click="removeSubtask(i)">×</button>
                        </div>
                        <div v-for="(lnk, li) in s.links" :key="li" class="sub-link-row">
                          <input v-model="s.links[li].label" placeholder="链接名" class="sample-input sub-link-name" />
                          <input v-model="s.links[li].url" placeholder="URL" class="sample-input sub-link-url" />
                          <button class="inline-del" type="button" @click="s.links.splice(li, 1)">×</button>
                        </div>
                        <button class="ghost sm add-inline" type="button" @click="(s.links ||= []).push({ url: '', label: '' })">+ 添加链接</button>
                      </div>
                      <button class="ghost sm add-inline" @click="addSubtask">+ 添加子任务</button>
                    </div>
                  </div>

                  <div class="rf-actions">
                    <button class="ghost" @click="cancelEditRule">取消</button>
                    <button class="primary" @click="addRule">{{ editingRuleId ? '保存修改' : '添加预设任务' }}</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- 自动化：规则增删即时保存，无需手动保存按钮 -->
      </div>

      <!-- 外观 -->
      <div v-show="currentTab === 'look'" class="tab-panel">
        <div class="setting-group">
          <div class="set-row">
            <label>四象限颜色</label>
            <div class="colors">
              <div v-for="(c, key) in settings.quadrantColors" :key="key" class="color-item">
                <input type="color" v-model="settings.quadrantColors[key]" />
                <span>{{ QUAD_LABELS[key] }}</span>
              </div>
            </div>
          </div>
        </div>
        <button class="primary" @click="saveSettings">保存设置</button>
        <p v-if="saveTip && currentTab === 'look'" class="save-tip" :class="{ ok: saveTipOk, err: !saveTipOk }">{{ saveTip }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  gap: 14px;
  width: 100%;
  /* align-items:start 防止 grid item 在内容不足时被 stretch 拉成"空 panel"。
     默认 stretch 会让 .top-tabs（内容只占 ~45px）和下面的 .settings-section
     一起被均分到 216/451 行高，导致 tab 按钮被拉成 207px 的竖立高块（"白底叠 panel"）。
     改为 start 后，grid item 用自然高度，只剩"panel 底部留白"问题——下方仍是 flex 容器
     （.main > * 是 display:flex column），不会被这个 stretch 影响。
     align-content:start 进一步防止 grid 的 auto 行被默认 stretch 均分填满容器高度，
     否则"预设"标签行会被撑高、下方留下一大块空白（"预设下方空一块"）。 */
  align-items: start;
  align-content: start;
}
.section {
  display: grid;
  gap: 10px;
}
.section-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.data-block {
  padding: 14px;
  border-radius: 10px;
  background: var(--panel-2);
  border: 1px solid var(--border);
}
.data-block + .data-block {
  margin-top: 6px;
}
.block-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.danger-block {
  border-color: rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.04);
}
.import-btn {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 13px;
  cursor: pointer;
  background: var(--panel-solid);
}
.import-btn:hover {
  background: var(--panel-2);
}
.sync-box {
  display: grid;
  gap: 8px;
  margin-top: 10px;
  padding: 10px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.sync-item {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 8px;
}
.sync-item:hover {
  background: var(--panel-solid);
}
.sync-item.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.sync-item input[type='checkbox'] {
  width: 16px;
  height: 16px;
  flex: none;
}
.sync-label {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
  flex: 1;
  min-width: 0;
}
.sync-label strong {
  font-size: 13px;
  font-weight: 600;
}
.sync-label small {
  font-size: 11px;
  color: var(--muted);
}
.sync-state {
  font-size: 12px;
  color: var(--muted);
  flex: none;
}
.sync-state.on {
  color: var(--success);
  font-weight: 600;
}
.module-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.module-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-solid);
  cursor: pointer;
  font-size: 13px;
  user-select: none;
}
.module-chip:hover {
  border-color: var(--primary);
}
.module-chip input[type='checkbox'] {
  width: 15px;
  height: 15px;
}
.schedule-time {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-left: 8px;
  flex-wrap: nowrap;
}
.schedule-time label {
  font-size: 13px;
  color: var(--text-2);
  flex: none;
  white-space: nowrap;
}
.schedule-time input[type='time'] {
  background: var(--panel-solid);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 5px 8px;
  color: var(--text);
  font-size: 13px;
  /* 缩小时间选择栏：之前由浏览器默认宽度控制，时分 + 上下箭头 + 弹层按钮撑得很宽；
     限定到 110px，让「每日 + 17:30 + 自动同步一次」能在同一条横排显示。 */
  flex: none;
  width: 110px;
  max-width: 110px;
  min-width: 0;
}
.schedule-time span {
  flex: none;
  white-space: nowrap;
}
.ok {
  color: var(--success);
  margin-top: 10px;
  font-size: 13px;
}
.err {
  color: var(--danger);
  font-size: 13px;
}
.cloud-block {
  border-left: 3px solid var(--primary);
}
.cloud-block input[type='text'],
.cloud-block input[type='password'],
.cloud-block input:not([type]) {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.cloud-form {
  display: grid;
  gap: 6px;
  margin-top: 6px;
}
.ios-guide {
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 13px;
}
.ios-guide summary {
  cursor: pointer;
  font-weight: 600;
  user-select: none;
}
.ios-guide ol {
  margin: 10px 0 0;
  padding-left: 20px;
  line-height: 1.7;
  color: var(--text);
}
.settings-section {
  display: grid;
  gap: 10px;
}
.setting-group {
  padding: 14px;
  border-radius: 10px;
  background: var(--panel-2);
  border: 1px solid var(--border);
}
.group-title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.set-row {
  margin-bottom: 14px;
}
.set-row:last-child {
  margin-bottom: 0;
}
.preset-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.preset {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--primary-soft);
  color: var(--primary);
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 13px;
}
.preset .x {
  border: none;
  background: transparent;
  color: var(--danger);
  padding: 0 2px;
  font-size: 14px;
}
.folder-default-list {
  display: grid;
  gap: 6px;
  max-height: 360px;
  overflow: auto;
  padding: 8px;
  background: var(--panel-solid);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.folder-default-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 32px;
  flex-wrap: nowrap;
}
.folder-toggle {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--muted);
  flex-shrink: 0;
}
.folder-toggle.leaf {
  opacity: 0;
  pointer-events: none;
}
.folder-toggle svg {
  transition: transform 0.2s;
}
.folder-toggle.expanded svg {
  transform: rotate(90deg);
}
.folder-default-name {
  font-size: 13px;
  color: var(--text);
  flex: 1;
  min-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-effective {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--panel-soft);
  color: var(--muted);
  white-space: nowrap;
  width: 110px;
  min-width: 110px;
  max-width: 110px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
}
.folder-effective.inherited {
  color: var(--primary);
  background: rgba(var(--primary-rgb), 0.08);
}
.folder-effective.system {
  color: var(--muted);
  font-style: italic;
}
.folder-default-type {
  min-width: 120px;
  max-width: 150px;
  font-size: 13px;
}
.folder-default-empty {
  padding: 10px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
}
.time-inputs {
  align-items: center;
  gap: 8px;
}
.time-inputs input {
  width: 90px;
  max-width: 90px;
  text-align: center;
}
.time-inputs span {
  font-size: 13px;
  color: var(--muted);
}
/* ---------- 自动化规则 ---------- */
.rule-help {
  font-size: 12px;
  line-height: 1.7;
  margin: 4px 0 10px;
}
.rule-top {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 18px 0 14px;
  flex-wrap: wrap;
}
.rule-top .primary.sm {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  font-size: 13px;
}
.rt-plus {
  font-size: 15px;
  line-height: 1;
  font-weight: 500;
}
.rt-desc {
  font-size: 13px;
  line-height: 1.5;
}
.rule-card {
  background: var(--panel-solid);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 11px;
  margin-bottom: 8px;
}
.rc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rc-head input[type='checkbox'] {
  width: 16px;
  height: 16px;
  flex: none;
}
.rule-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rule-title.off {
  color: var(--muted);
  text-decoration: line-through;
}
.rc-head .x {
  border: none;
  background: transparent;
  color: var(--danger);
  font-size: 16px;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
}
.rc-head .icon-btn {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
  transition: color 0.12s;
}
.rc-head .icon-btn:hover {
  color: var(--primary);
}
.rc-body {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
  padding-left: 24px;
}
.cond-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--muted);
  border: 1px solid var(--border);
}
.cond-chip.cond-main {
  background: var(--primary-soft);
  color: var(--primary);
  border-color: transparent;
  font-weight: 600;
}
.cond-chip.link {
  text-decoration: none;
  color: var(--primary);
  border-color: var(--primary);
}
.cond-chip.link:hover {
  background: var(--primary-soft);
}
.rule-form {
  margin-top: 10px;
  padding: 10px 11px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  display: grid;
  gap: 8px;
  background: var(--panel-solid);
}
.rule-modal .rule-form {
  margin-top: 0;
  padding: 0;
  border: none;
  background: transparent;
}
.rule-modal {
  max-width: 760px;
}
.rule-modal .sample-section,
.rule-modal .sample-check {
  min-width: 0;
}
.rule-modal .do-output-link .sample-check {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  flex-wrap: nowrap;
  cursor: pointer;
}
.rule-modal .do-output-link .sample-check input[type="checkbox"] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--primary);
  cursor: pointer;
}
.rule-modal .do-output-link .sc-title {
  flex: 0 0 auto;
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  line-height: 1.4;
  white-space: nowrap;
}
.rule-modal .do-output-link .sc-desc {
  display: block;
  margin: 8px 0 0 24px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  word-break: break-word;
  white-space: normal;
  max-width: 100%;
}
.rf-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.modal-head .x {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 20px;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
}
.modal-head .x:hover {
  color: var(--danger);
}
.empty-rule {
  margin: 4px 0 8px;
}
.rf-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.rf-label {
  font-size: 12px;
  color: var(--muted);
  flex: none;
}
.rf-title {
  flex: 1;
  min-width: 180px;
}
.rf-person {
  width: 180px;
}
.rf-sel {
  min-width: 108px;
}
.rf-num {
  width: 78px;
  text-align: center;
}
.rf-remark {
  flex: 1;
  min-width: 200px;
}
/* 规则层多链接编辑器（与任务管理表单一致） */
.link-edit {
  display: grid;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.link-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.link-row input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel-2);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
}
.link-row input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
.link-label {
  max-width: 120px;
}
/* 规则内子任务条目编辑器 */
.rf-sub-block {
  display: grid;
  gap: 6px;
}
.sub-edit {
  display: grid;
  gap: 6px;
  padding: 10px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: var(--panel-2);
}
.sub-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-solid);
  padding: 8px 10px;
  display: grid;
  gap: 8px;
}
.sub-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sub-idx {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.sub-input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
}
.sub-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.sub-x {
  flex: none;
  border: none;
  background: transparent;
  color: var(--danger);
  font-size: 16px;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
}
.sub-card-body {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.sub-card-body.two-col {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.sub-f {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--muted);
  min-width: 0;
}
.sub-f input,
.sub-f select {
  padding: 5px 7px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel-2);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  min-width: 0;
  width: 100%;
}
.sub-f input:focus,
.sub-f select:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
.sub-card-links {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.sub-links-label {
  font-size: 11px;
  color: var(--muted);
}
.sub-link-rows {
  display: grid;
  gap: 6px;
}
.sub-link-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sub-link-row input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel-2);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
}
.sub-link-row input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
.wd-picker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.wd {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.wd:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.wd.on {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
  font-weight: 600;
}
.wd-hint {
  font-size: 11px;
  margin-left: 4px;
}
.colors {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.color-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.color-item input[type='color'] {
  width: 36px;
  height: 32px;
  padding: 2px;
  border-radius: 6px;
}
.danger-zone {
  border-color: var(--danger-soft);
}
code {
  background: var(--panel-2);
  padding: 1px 6px;
  border-radius: 4px;
}
.save-tip {
  margin-top: 10px;
  font-size: 13px;
  min-height: 20px;
}
.save-tip.ok {
  color: var(--success);
}
.save-tip.err {
  color: var(--danger);
}
/* 顶层分类 TAB：数据管理 / 预设 */
.top-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border-radius: 12px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  width: fit-content;
}
.top-tab {
  border: none;
  background: transparent;
  color: var(--muted);
  padding: 8px 22px;
  border-radius: 9px;
  font-size: 13.5px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}
.top-tab:hover {
  color: var(--text);
}
.top-tab.active {
  background: var(--panel-solid);
  color: var(--primary);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}
.tabs {
  display: flex;
  gap: 6px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
  margin-bottom: 6px;
}
.tab {
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.tab:hover {
  background: var(--panel-2);
  color: var(--text);
}
.tab.active {
  background: var(--primary-soft);
  color: var(--primary);
  border-color: var(--primary);
  font-weight: 600;
}
.tab-panel {
  display: grid;
  gap: 10px;
}

/* ---------- 对齐图2小样：添加预设任务弹窗 ---------- */
.rule-modal-title {
  font-size: 18px;
  color: var(--primary);
}
.sample-style {
  display: grid;
  gap: 14px;
}
.sample-section {
  display: grid;
  gap: 6px;
}
.sample-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
.sample-check input { margin-top: 3px; flex: none; accent-color: var(--primary); cursor: pointer; }
.sample-check .sc-text { display: flex; flex-direction: column; gap: 2px; }
.sample-check .sc-title { font-weight: 600; font-size: 13px; line-height: 1.4; }
.sample-check .sc-desc { font-size: 12px; color: var(--muted); line-height: 1.5; }
.do-output-link {
  background: var(--primary-soft);
  border: 1px solid var(--primary-300);
  border-radius: 10px;
  padding: 10px 12px;
}
.sample-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sample-required {
  color: var(--danger);
}
.sample-hint {
  font-size: 12px;
  color: var(--muted);
  font-weight: 400;
}
.sample-input,
.sample-select {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  min-width: 0;
}
.sample-input:focus,
.sample-select:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
.sample-select {
  appearance: auto;
  cursor: pointer;
}
.sample-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.sample-row .sample-select,
.sample-row .sample-input {
  flex: 1;
  min-width: 120px;
}
.sample-row .date-input {
  min-width: 130px;
}
.sample-row .time-input {
  min-width: 110px;
  max-width: 140px;
}
.sample-wd {
  flex: 1;
  min-width: 200px;
}
.schedule-row .shift-multi-select {
  flex: 1 1 0;
  min-width: 150px;
}
.shift-multi-select .opt-note {
  font-size: 11px;
  margin-left: 4px;
}
.schedule-row .weekday-select {
  flex: 1 1 0;
  min-width: 160px;
}
.date-range-row .date-input {
  flex: 1 1 0;
  min-width: 140px;
}
.sample-tip {
  font-size: 11px;
  color: var(--muted);
  margin: 0;
}
.sample-preview {
  margin: 4px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 12px;
  line-height: 1.5;
}

/* 人员多选 */
.person-select {
  position: relative;
}
.person-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-solid);
  cursor: pointer;
  min-height: 36px;
}
.person-trigger:hover {
  border-color: var(--primary);
}
.person-placeholder {
  color: var(--muted);
  font-size: 13px;
}
.person-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.person-tag {
  background: var(--primary-soft);
  color: var(--primary);
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
}
.person-arrow {
  font-size: 10px;
  color: var(--muted);
}
.person-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 10;
  background: var(--panel-solid);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px;
  display: grid;
  gap: 2px;
  max-height: 220px;
  overflow: auto;
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.12);
}
.person-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.person-option:hover {
  background: var(--panel-2);
}
.person-option input[type='checkbox'] {
  width: 14px;
  height: 14px;
  flex: none;
}
.person-empty {
  padding: 8px;
  font-size: 12px;
  color: var(--muted);
}

/* 同行链接 / 子任务 */
.inline-links,
.inline-subs {
  display: grid;
  gap: 8px;
}
.inline-link-row,
.inline-sub-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.inline-link-row .sample-input,
.inline-sub-row .sample-input {
  flex: 1;
  min-width: 80px;
}
.inline-link-row .link-name,
.inline-sub-row .sub-link-name {
  max-width: 120px;
}
.inline-link-row .link-url,
.inline-sub-row .sub-link-url {
  min-width: 140px;
}
.inline-sub-row .sub-text {
  min-width: 140px;
}
.inline-sub-row .sub-time {
  max-width: 100px;
}
/* 子任务卡片：主行与多链接分行 */
.inline-sub-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
  display: grid;
  gap: 8px;
}
.sub-link-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.sub-link-row .sample-input {
  flex: 1;
  min-width: 80px;
}
.sub-link-row .sub-link-name {
  max-width: 140px;
}
.sub-link-row .sub-link-url {
  min-width: 160px;
}
.inline-sub-card .add-inline {
  justify-self: start;
}
.inline-del {
  border: none;
  background: transparent;
  color: var(--danger);
  font-size: 18px;
  line-height: 1;
  padding: 0 6px;
  cursor: pointer;
}
.add-inline {
  justify-self: start;
  color: var(--primary);
  border-color: var(--primary);
}
/* 移动端（≤720px）：设置中心贴合手指操作 */
@media (max-width: 720px) {
  .page { gap: 10px; }
  .data-block { padding: 12px; }
  .top-tabs {
    display: flex;
    width: 100%;
    max-width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .top-tab { padding: 8px 14px; white-space: nowrap; flex: none; }
  .cloud-block input[type='text'],
  .cloud-block input[type='password'],
  .cloud-block input:not([type]) {
    font-size: 15px;
    padding: 11px 12px;
  }
  .set-row { margin-bottom: 16px; }
  .sync-item { padding: 10px 8px; }
  .module-chip { padding: 8px 14px; font-size: 14px; }
}
</style>
