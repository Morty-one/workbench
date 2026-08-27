<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import { db } from '../db'
import * as XLSX from 'xlsx-js-style'
import { marked } from 'marked'
import { openExternal } from '../utils/localOpen.js'
import { docState, requestDocOutput } from '../docoutput.js'

const props = defineProps({
  search: { type: String, default: '' },
  // 来自总览「3D 项目卡片」下钻筛选；null 表示不筛选（默认行为，保持老功能不变）
  projectId: { type: Number, default: null }
})
const emit = defineEmits(['changed', 'clearProject'])

const QUAD = {
  'urgent-important': '重要紧急',
  'noturgent-important': '重要不紧急',
  'urgent-notimportant': '不重要紧急',
  'noturgent-notimportant': '不重要不紧急'
}
const QUAD_LAYOUT = ['urgent-important', 'noturgent-important', 'urgent-notimportant', 'noturgent-notimportant']
const STATUS = ['待办', '跟进中', '已完成']

const tasks = ref([])
const projects = ref([])
const colors = reactive({})
// 书签式项目筛选（本地状态，与来自总览下钻的 projectId 同步）
// 同时持久化到 localStorage，切标签页重建后自动恢复上次选中的项目
const LS_KEY = 'wb_tasks_selectedProject'
// 项目 id 在库中是数字，localStorage 会存成字符串，恢复时需转回数字才能匹配
const savedPid = localStorage.getItem(LS_KEY)
const selectedProjectId = ref(
  props.projectId ?? (savedPid != null ? Number(savedPid) : null)
)
watch(
  () => props.projectId,
  (v) => {
    selectedProjectId.value = v
  }
)
function selectProject(id) {
  selectedProjectId.value = id
  if (id == null) {
    localStorage.removeItem(LS_KEY)
    emit('clearProject') // 选「全部」时通知父级清除下钻态
  } else {
    localStorage.setItem(LS_KEY, String(id))
  }
}
const presets = ref([30, 60, 120, 240, 480])
const now = ref(Date.now())
let timer = null
const showForm = ref(false)
const editingId = ref(null)
const focused = ref(null)
const showMore = ref(false)
const localSearch = ref('')
const showProjectManage = ref(false)
// 按排班创建项目
const showDutyProj = ref(false)
const dutyPersons = ref([])
const allDuty = ref([])
const dutyForm = reactive({ person: '', mode: 'duty', start: '', end: '', name: '', parentId: null })
// 用户是否手动编辑过项目名称（编辑过则不再自动同步）
const dutyNameEdited = ref(false)
// 项目标签拖拽排序
const dragPid = ref(null)
function onProjDragStart(p, e) {
  dragPid.value = p.id
  e.dataTransfer.effectAllowed = 'move'
  if (e.dataTransfer.setData) e.dataTransfer.setData('text/plain', String(p.id))
}
function onProjDragOver(p, e) {
  if (dragPid.value == null || dragPid.value === p.id) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
}
async function onProjDrop(targetP, e) {
  e.preventDefault()
  if (dragPid.value == null || dragPid.value === targetP.id) {
    dragPid.value = null
    return
  }
  const roots = projectRoots.value.slice()
  const fromIdx = roots.findIndex((p) => p.id === dragPid.value)
  const toIdx = roots.findIndex((p) => p.id === targetP.id)
  dragPid.value = null
  if (fromIdx < 0 || toIdx < 0) return
  const [moved] = roots.splice(fromIdx, 1)
  roots.splice(toIdx, 0, moved)
  const now = Date.now()
  for (let i = 0; i < roots.length; i++) {
    await db.projects.update(roots[i].id, { order: i, updatedAt: now })
  }
  await loadProjects()
}

const form = reactive({
  title: '',
  projectId: null,
  quadrant: 'noturgent-important',
  dueTime: '',
  remindTime: '',
  remark: '',
  links: [],
  subtasks: []
})

const projectForm = reactive({ id: null, name: '', color: '#4f46e5' })
// 新建/编辑项目时选择的父项目（null = 顶层项目）
const projectParentId = ref(null)

/* ---------- 时间 ---------- */
function ymd(y, m, d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${y}-${p(m + 1)}-${p(d)}`
}
function dayKeyOf(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return ymd(d.getFullYear(), d.getMonth(), d.getDate())
}
const todayStr = dayKeyOf(Date.now())
const yesterdayStr = dayKeyOf(Date.now() - 24 * 3600 * 1000)
// 时间筛选
const dayMode = ref('today') // today | yesterday | all | specific | range
const specificDay = ref(todayStr)
const rangeStart = ref('')
const rangeEnd = ref('')
// 视图侧 "当前激活 day 范围起止"
const activeRange = computed(() => {
  if (dayMode.value === 'today') return { start: todayStr, end: todayStr, label: '今天 · ' + todayStr, advance: false }
  if (dayMode.value === 'yesterday') return { start: yesterdayStr, end: yesterdayStr, label: '昨天 · ' + yesterdayStr, advance: false }
  if (dayMode.value === 'specific') {
    const d = specificDay.value || todayStr
    return { start: d, end: d, label: (d === todayStr ? '今天 · ' : d === yesterdayStr ? '昨天 · ' : '') + d, advance: true }
  }
  if (dayMode.value === 'range') {
    if (!rangeStart.value) return { start: '', end: '', label: '请选择日期范围', advance: false }
    return { start: rangeStart.value, end: rangeEnd.value || rangeStart.value, label: rangeStart.value + ' ~ ' + (rangeEnd.value || '…'), advance: false }
  }
  return { start: '', end: '', label: '全部时间', advance: false }
})
function stepActiveDay(delta) {
  // 进入特定日期模式并前后调整一天
  if (dayMode.value !== 'specific') dayMode.value = 'specific'
  const base = specificDay.value || todayStr
  const d = new Date(base)
  d.setDate(d.getDate() + delta)
  specificDay.value = ymd(d.getFullYear(), d.getMonth(), d.getDate())
}

/* ---------- 当前视图（含顺延副本） ---------- */
// 每项形如 { task, _carried, _fromDay }
// 直接任务：直接显示; 顺延副本：虚拟出现，并标注 _fromDay（即原始 dayKey）
const viewList = computed(() => {
  const list = tasks.value
  if (dayMode.value === 'all') {
    return list
      .map((t) => ({ task: t, _carried: false, _fromDay: t.dayKey || '' }))
      .sort((a, b) => (b.task.createdAt || 0) - (a.task.createdAt || 0))
  }
  const { start, end } = activeRange.value
  if (!start) return []
  const direct = []
  const carry = []
  for (const t of list) {
    const od = t.dayKey || ''
    if (od >= start && od <= end) direct.push({ task: t, _carried: false, _fromDay: od })
    else if (od && od < start && t.status !== '已完成') carry.push({ task: t, _carried: true, _fromDay: od })
  }
  // 先排直接任务（按创建时间倒序），再排顺延副本（按 fromDay 升序，先顺延早些的）
  direct.sort((a, b) => (b.task.createdAt || 0) - (a.task.createdAt || 0))
  carry.sort((a, b) => a._fromDay.localeCompare(b._fromDay))
  return [...direct, ...carry]
})
const filtered = computed(() => {
  let list = viewList.value
  // 选项目时只筛选当前项目；不选项目（全部）时时间筛选作用于全部任务
  if (selectedProjectId.value != null) list = list.filter(({ task }) => task.projectId === selectedProjectId.value)
  const q = (props.search || localSearch.value || '').trim().toLowerCase()
  if (!q) return list
  return list.filter(({ task }) =>
    task.title.toLowerCase().includes(q) || (task.remark || '').toLowerCase().includes(q)
  )
})
// 当前选中的项目（用于顶部提示条）
const activeProject = computed(() => projects.value.find((p) => p.id === selectedProjectId.value) || null)
const grouped = computed(() => {
  const g = {}
  QUAD_LAYOUT.forEach((k) => (g[k] = []))
  for (const item of filtered.value) {
    const t = item.task
    ;(g[t.quadrant] || (g[t.quadrant] = [])).push(item)
  }
  // 每个象限内：未完成（待办/跟进中）在上，已完成沉底；已完成内部按完成时间倒序
  for (const k of QUAD_LAYOUT) {
    g[k].sort((a, b) => {
      const aDone = a.task.status === '已完成'
      const bDone = b.task.status === '已完成'
      if (aDone !== bDone) return aDone ? 1 : -1
      if (aDone && bDone) return (b.task.completedAt || 0) - (a.task.completedAt || 0)
      return (b.task.createdAt || 0) - (a.task.createdAt || 0)
    })
  }
  return g
})
// 手机端四象限标签页：窄屏用 tab 切换，避免 2x2 挤成 2 行被裁切（问题4）
const isNarrow = ref(false)
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(max-width: 900px)')
  isNarrow.value = mq.matches
  mq.addEventListener('change', (e) => {
    isNarrow.value = e.matches
  })
}
const mobileQuadTab = ref(QUAD_LAYOUT[0])
// 默认选中第一个有任务的象限（无任务的折叠为 tab 态，有任务的默认展开）
watch(
  grouped,
  (g) => {
    if (!isNarrow.value) return
    const first = QUAD_LAYOUT.find((k) => (g[k] || []).length > 0)
    if (first) mobileQuadTab.value = first
  },
  { immediate: true }
)
// 全部 / 范围筛选时，任务卡片上显示创建日期 YYYY-MM-DD
const showCardDate = computed(() => dayMode.value === 'all' || dayMode.value === 'range')
const displayKeys = computed(() => (focused.value ? [focused.value] : QUAD_LAYOUT))
const carryCount = computed(() => filtered.value.filter((i) => i._carried).length)
const directCount = computed(() => filtered.value.length - carryCount.value)
const dateLabel = computed(() => {
  if (dayMode.value === 'today') return '今日'
  if (dayMode.value === 'yesterday') return '昨日'
  if (dayMode.value === 'specific') return '该日'
  if (dayMode.value === 'range') return '选中'
  return ''
})
function fmtCarryFrom(d) {
  // d = 'YYYY-MM-DD' → "8月3日"
  if (!d) return ''
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return d
  return `${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`
}

async function loadSettings() {
  const c = await db.settings.get('quadrantColors')
  if (c) Object.assign(colors, c.value)
  const p = await db.settings.get('followUpPresets')
  if (p && Array.isArray(p.value) && p.value.length) presets.value = p.value
}
async function loadProjects() {
  await repairProjectCycles()
  const all = await db.projects.toArray()
  projects.value = all.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
// 修复项目树中的环：若某节点 parentId 指向自身/后代，整条链会从根视图消失（数据仍在库里）。
// 把环的闭合点 parentId 置空，断开成正常树，不丢任何项目。
async function repairProjectCycles() {
  const all = await db.projects.toArray()
  const byId = new Map(all.map((p) => [p.id, { ...p }]))
  const writes = []
  for (const p of all) {
    const seen = new Set()
    let cur = byId.get(p.id)
    while (cur && cur.parentId != null) {
      if (seen.has(cur.id)) {
        writes.push({ id: cur.id, parentId: null })
        byId.get(cur.id).parentId = null
        break
      }
      seen.add(cur.id)
      cur = byId.get(cur.parentId)
    }
  }
  for (const w of writes) await db.projects.update(w.id, { parentId: w.parentId })
  return writes.length > 0
}
// 某个候选父项目是否非法（= 自身，或自身的后代）
function isInvalidParent(candidateId) {
  if (!projectForm.id || candidateId == null) return false
  if (candidateId === projectForm.id) return true
  return isProjectDescendant(candidateId, projectForm.id)
}
// 实时校验提示：选中非法父级时立刻告知，并禁用保存（不用等点保存才弹窗）
const parentError = computed(() => {
  const pid = projectParentId.value
  if (!projectForm.id) return ''
  if (pid == null) return '当前项目已是顶层项目。'
  if (pid === projectForm.id) return '不能把项目设为自身的子项目，请另选上级。'
  if (isProjectDescendant(pid, projectForm.id)) {
    const child = projects.value.find((p) => p.id === pid)
    return `不能将父项目「${projectForm.name || '当前项目'}」挪到它的子项目「${child?.name || ''}」下，会形成循环。`
  }
  return ''
})
// 判断 maybeChildId 是否为 ancestorId 的后代（用于防止移动成环）
function isProjectDescendant(maybeChildId, ancestorId) {
  const byId = new Map(projects.value.map((p) => [p.id, p]))
  let cur = byId.get(maybeChildId)
  while (cur) {
    if (cur.id === ancestorId) return true
    cur = cur.parentId != null ? byId.get(cur.parentId) : null
  }
  return false
}
// 项目树（平铺带 depth），用于书签与管理列表的层级缩进展示
const projectTree = computed(() => {
  const list = projects.value
  const childrenOf = (pid) => list.filter((p) => (p.parentId || null) === pid)
  const out = []
  const walk = (pid, depth) => {
    for (const p of childrenOf(pid)) {
      out.push({ ...p, depth })
      walk(p.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
})
// 可折叠树：仅展开到当前选中项目的路径，其余默认折叠
const expandedIds = ref(new Set())
const projectTreeRoots = computed(() => {
  const childrenOf = (pid) => projects.value.filter((p) => (p.parentId || null) === pid)
  const build = (pid) => childrenOf(pid).map((p) => ({ node: p, children: build(p.id) }))
  return build(null)
})
const visibleProjectNodes = computed(() => {
  const out = []
  const walk = (nodes, depth) => {
    for (const entry of nodes) {
      out.push({
        node: entry.node,
        depth,
        hasChildren: entry.children.length > 0,
        expanded: expandedIds.value.has(entry.node.id)
      })
      if (entry.children.length && expandedIds.value.has(entry.node.id)) walk(entry.children, depth + 1)
    }
  }
  walk(projectTreeRoots.value, 0)
  return out
})
function toggleProjectNode(id) {
  const s = new Set(expandedIds.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expandedIds.value = s
}
// 打开管理时，把展开状态同步到当前选中项目的路径（选中项目及其祖先都展开）
function syncExpandToSelection() {
  const ids = ancestorChain.value.map((p) => p.id)
  expandedIds.value = new Set(ids)
}
// 顶层父项目（顶部项目栏只显示这些，子项目不在顶部平铺）
const projectRoots = computed(() =>
  projects.value
    .filter((p) => p.parentId == null)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
)
function childrenOfId(pid) {
  return projects.value.filter((p) => (p.parentId || null) === pid)
}
// 当前选中项目（可能为 null）
const currentProject = computed(() => projects.value.find((p) => p.id === selectedProjectId.value) || null)
// 选中节点到根的路径（含自身），用于 C 面包屑
const ancestorChain = computed(() => {
  const byId = (id) => projects.value.find((p) => p.id === id)
  const chain = []
  const seen = new Set()
  let cur = currentProject.value
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift(cur)
    cur = cur.parentId ? byId(cur.parentId) : null
  }
  return chain
})
// 当前选中节点的子项目（C 模式卡片区）
const drillChildren = computed(() => (currentProject.value ? childrenOfId(currentProject.value.id) : []))
// 顶部高亮：某顶层项目是否应高亮（自身或后代被选中）
function isRootActive(rootId) {
  if (selectedProjectId.value == null) return false
  const chain = ancestorChain.value
  return chain.length > 0 && chain[0].id === rootId
}
/* ---------- 按排班创建项目 ---------- */
const SHIFT_TYPES = [
  { key: '主班', match: ['9:00-c9:00', '主班'] },
  { key: '副班', match: ['9:00-18:00', '副班'] },
  { key: '周末白班', match: ['9:00-20:30', '周末白班'] },
  { key: '休班', match: ['休', '休班', '休息', '休息日', '调休', '请假', 'X', 'x'] }
]
function shiftKeyOf(shift) {
  const s = (shift || '').trim()
  const t = SHIFT_TYPES.find((x) => x.match.includes(s))
  return t ? t.key : '其他'
}
async function openDutyProj() {
  dutyPersons.value = [...new Set((await db.duty.toArray()).map((r) => r.person).filter(Boolean))]
  allDuty.value = await db.duty.toArray()
  const y = new Date().getFullYear()
  const m = new Date().getMonth()
  const first = new Date(y, m, 1)
  const last = new Date(y, m + 1, 0)
  dutyForm.start = ymd(first.getFullYear(), first.getMonth(), first.getDate())
  dutyForm.end = ymd(last.getFullYear(), last.getMonth(), last.getDate())
  dutyForm.person = dutyPersons.value[0] || ''
  dutyForm.mode = 'duty'
  dutyForm.parentId = null
  dutyNameEdited.value = false
  dutyForm.name = dutyForm.person ? `${dutyForm.person} ${dutyForm.start}~${dutyForm.end} 值班计划` : ''
  showDutyProj.value = true
}
const dutyDateList = computed(() => {
  const { person, mode, start, end } = dutyForm
  if (!person || !start || !end) return []
  const recs = allDuty.value.filter((r) => r.date >= start && r.date <= end)
  const attDays = new Set(recs.map((r) => r.date)) // 考勤日集合
  const personDays = new Set(recs.filter((r) => r.person === person).map((r) => r.date))
  if (mode === 'duty') {
    return [...new Set(recs.filter((r) => r.person === person && shiftKeyOf(r.shift) !== '休班').map((r) => r.date))].sort()
  }
  // 休班：考勤日中该人无排班记录的部分 + 显式标注休班的日期
  const fromBlank = [...attDays].filter((d) => !personDays.has(d))
  const explicit = recs.filter((r) => r.person === person && shiftKeyOf(r.shift) === '休班').map((r) => r.date)
  return [...new Set([...fromBlank, ...explicit])].sort()
})
watch(
  () => [dutyForm.person, dutyForm.mode, dutyForm.start, dutyForm.end],
  () => {
    if (dutyNameEdited.value) return
    dutyForm.name = dutyForm.person
      ? `${dutyForm.person} ${dutyForm.start}~${dutyForm.end} ${dutyForm.mode === 'duty' ? '值班计划' : '休班计划'}`
      : ''
  }
)
async function createProjectFromDuty() {
  if (!dutyForm.person) return alert('请选择人员')
  const dates = dutyDateList.value
  if (!dates.length) return alert(`该时间段内未匹配到${dutyForm.mode === 'duty' ? '值班' : '休班'}日期`)
  const name = (dutyForm.name || `${dutyForm.person} ${dutyForm.start}~${dutyForm.end}`).trim()
  const sorted = [...dates].sort()
  const startTs = new Date(sorted[0]).getTime()
  const endTs = new Date(sorted[sorted.length - 1]).getTime()
  await db.projects.add({
    name,
    color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
    parentId: dutyForm.parentId || null,
    progressMode: 'auto',
    manualProgress: 0,
    order: projects.value.length,
    archived: 0,
    startAt: startTs,
    endAt: endTs,
    dutyDates: dates,
    createdAt: Date.now()
  })
  await loadProjects()
  showDutyProj.value = false
  alert(`已创建项目「${name}」，覆盖 ${dates.length} 个${dutyForm.mode === 'duty' ? '值班' : '休班'}日`)
}
function resetProjectForm() {
  projectForm.id = null
  projectForm.name = ''
  projectForm.color = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')
  projectParentId.value = null
}
function openProjectManage() {
  // 正在编辑项目时，点击管理不关闭，避免误触丢失编辑态
  if (showProjectManage.value && !projectForm.id) {
    showProjectManage.value = false
    return
  }
  // 如果不是在编辑某个项目，且当前已选中一个项目，则默认新建到该父项目下
  if (!projectForm.id && selectedProjectId.value) {
    projectParentId.value = selectedProjectId.value
  }
  syncExpandToSelection()
  showProjectManage.value = true
}
function startEditProject(p) {
  projectForm.id = p.id
  projectForm.name = p.name
  projectForm.color = p.color || '#4f46e5'
  projectParentId.value = p.parentId || null
}
async function saveProject() {
  const name = projectForm.name.trim()
  if (!name) return
  const newParent = projectParentId.value || null
  // 防止把项目移动到自身或自己的后代下，避免形成环导致整条链消失
  if (projectForm.id && newParent != null) {
    if (newParent === projectForm.id) {
      alert('保存失败：不能将项目作为自身的子项目。')
      return
    }
    if (isProjectDescendant(newParent, projectForm.id)) {
      alert('保存失败：不能将父项目移动到其子项目下，否则项目链会循环丢失。')
      return
    }
  }
  const payload = { name, color: projectForm.color || '#4f46e5', parentId: newParent }
  if (projectForm.id) {
    await db.projects.update(projectForm.id, payload)
  } else {
    const now = Date.now()
    await db.projects.add({
      ...payload,
      progressMode: 'auto',
      manualProgress: 0,
      order: projects.value.length,
      archived: 0,
      startAt: null,
      endAt: null,
      createdAt: now
    })
  }
  resetProjectForm()
  await loadProjects()
}
async function deleteProject(p) {
  if (!confirm(`确认删除项目「${p.name}」？其子项目将上提一级，任务保留在原项目。`)) return
  // 子项目上提一级（父级变为被删项目的父级）
  await db.projects.where('parentId').equals(p.id).modify({ parentId: p.parentId || null })
  await db.projects.delete(p.id)
  if (selectedProjectId.value === p.id) selectProject(null)
  await loadProjects()
  await load()
}
async function load() {
  const all = await db.tasks.orderBy('createdAt').reverse().toArray()
  // 迁移：补 dayKey 字段（已有任务从 createdAt 推断）
  let migrated = 0
  for (const t of all) {
    if (!t.dayKey) {
      const dk = dayKeyOf(t.createdAt)
      await db.tasks.update(t.id, { dayKey: dk })
      t.dayKey = dk
      migrated++
    }
  }
  tasks.value = all
  emit('changed')
  if (migrated) {
    // 仅控制台提示，不打扰用户
    console.info(`[tasks] 已为 ${migrated} 条历史任务补 dayKey 字段`)
  }
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
function defaultDueTime() {
  const d = new Date(Date.now() + 60 * 60000)
  return minutesToTime(d.getHours() * 60 + d.getMinutes())
}
function dayBaseOf(dayKey) {
  const dk = dayKey || dayKeyOf(Date.now())
  return new Date(`${dk}T00:00:00`).getTime()
}
function taskDueAt(t) {
  // 父任务若含子任务，提醒时间取子任务中最近的提醒时间（含逾期）
  const subs = (t.subtasks || []).filter((s) => (s.text || '').trim() && !s.done)
  if (subs.length) {
    const times = subs
      .map((s) => timeToMinutes(s.remindTime || s.dueTime))
      .filter((m) => m > 0)
      .sort((a, b) => a - b)
    if (times.length) return dayBaseOf(t.dayKey) + times[0] * 60000
  }
  return t.nextRemindAt ?? t.followUpAt ?? 0
}
function isOverdue(t) {
  if (t.status === '已完成') return false
  const at = taskDueAt(t)
  return at > 0 && at <= now.value
}
function remainText(t) {
  const at = taskDueAt(t)
  const diff = at - now.value
  if (t.status === '已完成') return '已完成'
  if (diff > 0) {
    const m = Math.floor(diff / 60000)
    const h = Math.floor(m / 60)
    return `剩余 ${h > 0 ? h + '时' : ''}${m % 60}分 后提醒`
  }
  const over = Math.floor(-diff / 60000)
  const d = Math.floor(over / 1440)
  const h = Math.floor((over % 1440) / 60)
  const m = over % 60
  if (d > 0) return `任务已逾期 ${d}天${h}时${m}分`
  if (h > 0) return `任务已逾期 ${h}时${m}分`
  return `任务已逾期 ${m}分`
}

/* ---------- 任务导出 ---------- */
const showExport = ref(false)
const exportFormat = ref('md') // md | txt | xlsx
const exportScope = ref('current') // current | current-and-children

function openExport() {
  showExport.value = true
}
function projName(id) {
  const p = projects.value.find((x) => x.id === id)
  return p ? p.name : '（未关联）'
}
// 收集某项目及其所有后代项目的 id
function getDescendantProjectIds(rootId) {
  const out = new Set([rootId])
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()
    const kids = projects.value.filter((p) => p.parentId === id)
    for (const k of kids) {
      out.add(k.id)
      stack.push(k.id)
    }
  }
  return out
}
// 导出范围描述：项目 + 范围 + 时间 + 搜索 + 象限
function scopeLabel() {
  const proj = currentProject.value ? currentProject.value.name : '全部项目'
  const scope = exportScope.value === 'current-and-children' ? '及子项目' : ''
  const time = activeRange.value.label
  const q = (props.search || localSearch.value || '').trim()
  const quad = focused.value ? QUAD[focused.value] : ''
  const parts = [`${proj}${scope}`, time]
  if (q) parts.push('搜索「' + q + '」')
  if (quad) parts.push('象限「' + quad + '」')
  return parts.join(' · ')
}
// 构建导出数据模型：按当前项目/时间/搜索/象限筛选；含子任务的任务按「任务集合」逐条展开
function buildExportModel() {
  const header = ['任务集合', '标题', '所属项目', '四象限', '状态', '创建日期', '跟进时间', '备注']
  const rows = []
  const merges = [] // xlsx 中「任务集合」列需合并的连续行（0 基，不含表头行）
  let list = viewList.value
  // 项目筛选（支持当前项目及子项目）
  if (selectedProjectId.value != null) {
    const scopeIds = exportScope.value === 'current-and-children'
      ? getDescendantProjectIds(selectedProjectId.value)
      : new Set([selectedProjectId.value])
    list = list.filter(({ task }) => scopeIds.has(task.projectId))
  }
  // 搜索筛选
  const q = (props.search || localSearch.value || '').trim().toLowerCase()
  if (q) {
    list = list.filter(({ task }) =>
      task.title.toLowerCase().includes(q) || (task.remark || '').toLowerCase().includes(q)
    )
  }
  // 象限筛选
  if (focused.value) {
    list = list.filter(({ task }) => task.quadrant === focused.value)
  }
  let rowIdx = 0
  for (const item of list) {
    const t = item.task
    const base = {
      所属项目: projName(t.projectId),
      四象限: QUAD[t.quadrant] || t.quadrant || '',
      状态: t.status || '',
      创建日期: t.dayKey || '',
      跟进时间: t.followUpAt ? new Date(t.followUpAt).toLocaleString('zh-CN') : '',
      备注: t.remark || ''
    }
    const subs = (t.subtasks || []).filter((s) => (s.text || '').trim())
    if (subs.length) {
      const mergeStart = rowIdx
      subs.forEach((s, si) => {
        rows.push({ 任务集合: si === 0 ? t.title || '' : '', 标题: s.text || '', ...base })
        rowIdx++
      })
      if (subs.length > 1) merges.push({ r1: mergeStart, r2: rowIdx - 1 })
    } else {
      rows.push({ 任务集合: '', 标题: t.title || '', ...base })
      rowIdx++
    }
  }
  return { header, rows, merges }
}
function saveBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
function escCell(s) {
  return String(s ?? '').replace(/\|/g, '／').replace(/\r?\n/g, ' ')
}
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
function toMarkdown(header, rows, merges) {
  const mergeSet = new Set()
  for (const m of merges) {
    for (let i = m.r1; i <= m.r2; i++) mergeSet.add(i)
  }
  const tableRows = []
  rows.forEach((r, i) => {
    const cells = []
    if (r['任务集合']) {
      const m = merges.find((m) => m.r1 === i)
      if (m) {
        cells.push(`<td rowspan="${m.r2 - m.r1 + 1}">${escHtml(r['任务集合'])}</td>`)
      } else {
        cells.push(`<td>${escHtml(r['任务集合'])}</td>`)
      }
    } else if (!mergeSet.has(i)) {
      cells.push('<td></td>')
    }
    cells.push(`<td>${escHtml(r['标题'])}</td>`)
    cells.push(`<td>${escHtml(r['所属项目'])}</td>`)
    cells.push(`<td>${escHtml(r['四象限'])}</td>`)
    cells.push(`<td>${escHtml(r['状态'])}</td>`)
    cells.push(`<td>${escHtml(r['创建日期'])}</td>`)
    cells.push(`<td>${escHtml(r['跟进时间'])}</td>`)
    cells.push(`<td>${escHtml(r['备注'])}</td>`)
    tableRows.push('<tr>' + cells.join('') + '</tr>')
  })
  const thead = '<tr>' + header.map((h) => `<th>${escHtml(h)}</th>`).join('') + '</tr>'
  const tableHtml = [
    '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;text-align:center">',
    '<thead>' + thead + '</thead>',
    '<tbody>' + tableRows.join('') + '</tbody>',
    '</table>'
  ].join('\n')
  const lines = [
    '# 任务导出',
    '',
    `- 范围：${scopeLabel()}`,
    `- 导出时间：${todayStr}`,
    `- 共 ${rows.length} 条`,
    '',
    tableHtml,
    ''
  ]
  return lines.join('\n')
}
function toText(header, rows) {
  const lines = [
    '任务导出',
    `范围：${scopeLabel()}`,
    `导出时间：${todayStr}`,
    `共 ${rows.length} 条`,
    '='.repeat(40)
  ]
  let lastColl = '__none__'
  rows.forEach((r) => {
    const coll = r['任务集合']
    if (coll && coll !== lastColl) {
      lines.push(`【${coll}】`)
      lastColl = coll
    } else if (!coll) {
      lastColl = '__none__'
    }
    lines.push(`- [${r['状态']}] ${r['标题']}`)
    lines.push(`   项目：${r['所属项目']} ｜ 四象限：${r['四象限']}`)
    lines.push(`   创建日期：${r['创建日期']} ｜ 跟进时间：${r['跟进时间']}`)
    if (r['备注']) lines.push(`   备注：${r['备注']}`)
  })
  return lines.join('\n')
}
function styleXlsx(ws) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1')
  const border = {
    top: { style: 'thin', color: { rgb: '000000' } },
    bottom: { style: 'thin', color: { rgb: '000000' } },
    left: { style: 'thin', color: { rgb: '000000' } },
    right: { style: 'thin', color: { rgb: '000000' } }
  }
  const headerFont = { name: '黑体', sz: 14, bold: true }
  const bodyFont = { name: '宋体', sz: 12 }
  for (let R = range.s.r; R <= range.e.r; ++R) {
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cellRef = XLSX.utils.encode_cell({ r: R, c: C })
      if (!ws[cellRef]) ws[cellRef] = { t: 's', v: '' }
      const isHeader = R === 0
      ws[cellRef].s = {
        border,
        font: isHeader ? headerFont : bodyFont,
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true }
      }
    }
  }
  // 默认列宽 20（wch 为字符宽度）
  const colCount = range.e.c - range.s.c + 1
  ws['!cols'] = Array(colCount).fill({ wch: 20 })
}
function doExport() {
  const { header, rows, merges } = buildExportModel()
  if (!rows.length) {
    alert('当前筛选下没有可导出的任务。')
    return
  }
  const name = `任务导出-${todayStr}`
  if (exportFormat.value === 'xlsx') {
    const aoa = [header.slice()]
    rows.forEach((r) => aoa.push(header.map((h) => r[h])))
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    if (merges.length) {
      ws['!merges'] = merges.map((m) => ({ s: { r: m.r1 + 1, c: 0 }, e: { r: m.r2 + 1, c: 0 } }))
    }
    styleXlsx(ws)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '任务')
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true })
    saveBlob(`${name}.xlsx`, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  } else if (exportFormat.value === 'md') {
    saveBlob(`${name}.md`, toMarkdown(header, rows, merges), 'text/markdown;charset=utf-8')
  } else {
    saveBlob(`${name}.txt`, toText(header, rows), 'text/plain;charset=utf-8')
  }
  showExport.value = false
}

function openNew() {
  editingId.value = null
  form.title = ''
  form.remark = ''
  // 默认象限跟随当前筛选；未筛选（全部象限）时默认 重要不紧急
  form.quadrant = focused.value || 'noturgent-important'
  const dt = defaultDueTime()
  // 完成时间默认留空：只有用户显式设置才弹「是否完成」确认
  form.dueTime = ''
  form.remindTime = dt
  form.links = []
  form.subtasks = []
  form.projectId = selectedProjectId.value ?? projects.value[0]?.id ?? null
  showForm.value = true
}
function edit(t) {
  editingId.value = t.id
  form.title = t.title
  form.projectId = t.projectId ?? projects.value[0]?.id ?? null
  form.quadrant = t.quadrant
  form.remark = t.remark || ''
  form.links = allLinksOf(t).slice()
  form.subtasks = (t.subtasks || []).map((s) => ({
    id: s.id || String(Date.now()) + Math.random().toString(36).slice(2),
    text: s.text || '',
    dueTime: s.dueTime || (Number(s.followMinutes) > 0 ? minutesToTime(s.followMinutes) : ''),
    remindTime: s.remindTime || (Number(s.remindMinutes) > 0 ? minutesToTime(s.remindMinutes) : ''),
    links: allLinksOf({ links: s.links, url: s.url, link: s.link })
  }))
  // 完成时间优先用显式存储的 dueTime（未设则为空，重新编辑时不再误判为已设）
  const base = dayBaseOf(t.dayKey || dayKeyOf(t.createdAt))
  const dueMin = Math.round((t.followUpAt - base) / 60000)
  const remindMin = t.nextRemindAt ? Math.round((t.nextRemindAt - base) / 60000) : dueMin
  form.dueTime = t.dueTime || ''
  form.remindTime = remindMin > 0 ? minutesToTime(remindMin) : (form.dueTime || defaultDueTime())
  showForm.value = true
}
async function submit() {
  if (!form.title.trim()) return
  const nowTs = Date.now()
  const dayKey = dayKeyOf(nowTs)
  const base = dayBaseOf(dayKey)
  const dueMin = timeToMinutes(form.dueTime) || timeToMinutes(defaultDueTime())
  const remindMin = timeToMinutes(form.remindTime) || dueMin
  const projectId = form.projectId ?? projects.value[0]?.id ?? null
  const plainSubtasks = JSON.parse(JSON.stringify(form.subtasks || []))
    .filter((s) => (s.text || '').trim())
    .map((s) => ({
      id: s.id || String(Date.now()) + Math.random().toString(36).slice(2),
      text: s.text.trim(),
      done: !!s.done,
      dueTime: (s.dueTime || '').trim(),
      remindTime: (s.remindTime || '').trim(),
      links: (s.links || [])
        .filter((l) => (l && (l.url || '')).trim())
        .map((l) => ({ url: (l.url || '').trim(), label: (l.label || '打开').trim() || '打开' }))
    }))
  // 有子任务时：父任务不单独设提醒，取子任务中最近的提醒时间
  const hasSubs = plainSubtasks.length > 0
  let followUpAt = base + dueMin * 60000
  let nextRemindAt = base + remindMin * 60000
  if (hasSubs) {
    const subTimes = plainSubtasks
      .map((s) => timeToMinutes(s.remindTime || s.dueTime) || dueMin)
      .sort((a, b) => a - b)
    if (subTimes.length) {
      nextRemindAt = base + subTimes[0] * 60000
      followUpAt = base + (subTimes[subTimes.length - 1]) * 60000
    }
  }
  if (editingId.value) {
    await db.tasks.update(editingId.value, {
      title: form.title.trim(),
      projectId,
      quadrant: form.quadrant,
      followUpAt,
      nextRemindAt,
      dueTime: (form.dueTime || '').trim(),
      remark: form.remark,
      links: form.links.filter((l) => (l.url || '').trim()).map((l) => ({ url: l.url.trim(), label: (l.label || '打开').trim() || '打开' })),
      subtasks: plainSubtasks
    })
  } else {
    await db.tasks.add({
      title: form.title.trim(),
      projectId,
      quadrant: form.quadrant,
      status: '待办',
      followUpAt,
      nextRemindAt,
      dueTime: (form.dueTime || '').trim(),
      createdAt: nowTs,
      dayKey,
      completedAt: null,
      remark: form.remark,
      links: form.links.filter((l) => (l.url || '').trim()).map((l) => ({ url: l.url.trim(), label: (l.label || '打开').trim() || '打开' })),
      subtasks: plainSubtasks
    })
  }
  showForm.value = false
  editingId.value = null
  await load()
}
function closeForm() {
  showForm.value = false
  editingId.value = null
}
async function setStatus(t, s) {
  const patch = { status: s }
  if (s === '已完成') patch.completedAt = Date.now()
  if (s === '跟进中' && t.status === '待办') patch.nextRemindAt = Date.now() + 30 * 60 * 1000
  await db.tasks.update(t.id, patch)
  await load()
}
async function remove(id) {
  await db.tasks.delete(id)
  if (editingId.value === id) {
    editingId.value = null
    showForm.value = false
  }
  await load()
}

/* ---------- 自动化任务的子任务条目（勾选清单） ---------- */
const expandedSub = ref({})
function toggleSub(taskId) {
  expandedSub.value[taskId] = !expandedSub.value[taskId]
}
function subDone(t) {
  return (t.subtasks || []).filter((s) => s.done).length
}
// 渲染任务正文（笔记转任务时带入的 Markdown，含 base64 图片）
function renderTaskContent(c) {
  if (!c) return ''
  try {
    return marked.parse(c)
  } catch (e) {
    return ''
  }
}
async function toggleSubtask(t, sub) {
  // 与 Overview.toggleSubDone 一致：先取 DB 最新快照再翻转，避免用陈旧引用覆盖其它已勾选项
  // （方形框此前因此静默失效：传入的 t/sub 来自渲染副本，引用可能已过期，直接翻转会写回旧数据）
  const fresh = await db.tasks.get(t.id)
  if (!fresh) return
  const subs = (fresh.subtasks || []).map((s) => {
    const match = sub && sub.id != null ? s.id === sub.id : s === sub
    return match ? { ...s, done: !s.done } : { ...s }
  })
  // 全部子任务完成 → 自动判定整个集合完成
  const patch = { subtasks: subs }
  if (subs.length && subs.every((s) => s.done)) {
    patch.status = '已完成'
    patch.completedAt = Date.now()
  }
  try {
    await db.tasks.update(t.id, patch)
  } catch (e) {
    console.error('toggleSubtask failed', e)
  }
  await load()
}

/* ---------- 表单内子任务编辑 ---------- */
function addFormSubtask() {
  form.subtasks.push({
    id: String(Date.now()) + Math.random().toString(36).slice(2),
    text: '',
    dueTime: '',
    remindTime: '',
    links: []
  })
}
function removeFormSubtask(i) {
  form.subtasks.splice(i, 1)
}
function addFormSubLink(s) {
  s.links = s.links || []
  s.links.push({ url: '', label: '打开' })
}
function removeFormSubLink(s, i) {
  s.links.splice(i, 1)
}

/* ---------- 把任务设为自动化预设 ---------- */
async function makePreset(t) {
  if (!confirm(`将任务「${t.title}」设为自动化预设？\n保存后可在「设置中心-预设-自动化」中查看和编辑。`)) return
  const rules = (await db.settings.get('periodicDutyTasks'))?.value || []
  // 把任务的 followUpAt 转成 HH:MM（基于创建当天 0 点）
  const created = t.createdAt || Date.now()
  const createdDay = new Date(created)
  createdDay.setHours(0, 0, 0, 0)
  const dueMinutes = Math.max(0, Math.round(((t.followUpAt || 0) - createdDay.getTime()) / 60000))
  const remindMinutes = Math.max(0, Math.round(((t.nextRemindAt || 0) - createdDay.getTime()) / 60000))
  const subtasks = (t.subtasks || []).map((s) => ({
    id: s.id || String(Date.now()) + Math.random().toString(36).slice(2),
    text: s.text || '',
    dueTime: s.dueTime || (Number(s.followMinutes) > 0 ? minutesToTime(s.followMinutes) : ''),
    remindTime: s.remindTime || (Number(s.remindMinutes) > 0 ? minutesToTime(s.remindMinutes) : ''),
    links: allLinksOf(s)
  }))
  rules.push({
    id: String(Date.now()) + Math.random().toString(36).slice(2),
    title: t.title,
    persons: [],
    weekdays: [],
    shifts: [],
    dateRange: { start: '', end: '' },
    dueTime: dueMinutes ? minutesToTime(dueMinutes) : '',
    remindTime: remindMinutes ? minutesToTime(remindMinutes) : '',
    quadrant: t.quadrant || 'noturgent-important',
    remark: (t.remark || '').replace(/^自动生成 · [^\n]+(\n|$)/, ''),
    links: allLinksOf(t),
    subtasks,
    enabled: true
  })
  await db.settings.put({ key: 'periodicDutyTasks', value: rules })
  alert('已设为自动化预设 ✓')
}
// 兼容 legacy 单链接字段 / 字符串链接，统一返回 { url, label } 数组
function normLink(x) {
  if (typeof x === 'string') return { url: x, label: '打开' }
  if (x && typeof x === 'object') return { url: x.url || '', label: x.label || '打开' }
  return { url: '', label: '打开' }
}
function handleLinkClick(url, ev) {
  if (ev) ev.preventDefault()
  openExternal(url)
}
function allLinksOf(t) {
  let arr = []
  if (Array.isArray(t.links) && t.links.length) arr = t.links
  else if (t.link) arr = [t.link]
  else if (t.url) arr = [t.url]
  return arr.filter(Boolean).map(normLink)
}

function onTaskUpdated() {
  load()
}
onMounted(async () => {
  await loadSettings()
  await loadProjects()
  await load()
  timer = setInterval(() => (now.value = Date.now()), 1000)
  window.addEventListener('task-updated', onTaskUpdated)
})
onUnmounted(() => {
  clearInterval(timer)
  window.removeEventListener('task-updated', onTaskUpdated)
})
</script>

<template>
  <div class="page">
    <!-- 项目筛选行：独占最上方 -->
    <div class="panel-flat filter-project-row" :class="{ drilling: currentProject }">
      <template v-if="currentProject">
        <div class="ctx-crumb">
          <button class="crumb-item" @click="selectProject(null)">全部</button>
          <template v-for="(node, i) in ancestorChain" :key="node.id">
            <span class="crumb-sep">/</span>
            <button
              class="crumb-item"
              :class="{ current: i === ancestorChain.length - 1 }"
              @click="selectProject(node.id)"
            >{{ node.name }}</button>
          </template>
        </div>
        <span class="muted sm-info ctx-count">共 {{ tasks.filter(t => t.projectId === currentProject.id).length }} 个任务</span>
        <button class="chip manage-btn" :class="{ active: showExport }" @click="openExport">
          导出
        </button>
        <button class="chip manage-btn" :class="{ active: showProjectManage }" @click="openProjectManage">
          管理
        </button>
        <div v-if="drillChildren.length" class="sub-rows">
          <button
            v-for="c in drillChildren"
            :key="c.id"
            class="sub-row-item"
            :class="{ active: selectedProjectId === c.id }"
            :style="{ '--sc': c.color || '#10b981' }"
            @click="selectProject(c.id)"
          >
            <span class="sr-dot" :style="{ background: c.color || '#10b981' }"></span>
            <span class="sr-name">{{ c.name }}</span>
            <span class="sr-count">{{ tasks.filter(t => t.projectId === c.id).length }} 个任务</span>
            <span class="sr-arrow">›</span>
          </button>
        </div>
      </template>

      <template v-else>
        <span class="muted group-label">项目</span>
        <div class="bm-scroll">
          <button class="bm bm-all" :class="{ active: selectedProjectId === null }" @click="selectProject(null)">
            <span class="bm-favicon all"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2l3.1 6.3L22 9.3l-5 4.9L17.8 21 12 17.8 6.2 21 7 14.2 2 9.3l6.9-1z"/></svg></span>全部
          </button>
          <button
            v-for="p in projectRoots"
            :key="p.id"
            class="bm bm-drag"
            :class="{ active: isRootActive(p.id), dragging: dragPid === p.id }"
            :title="p.name"
            draggable="true"
            @click="selectProject(p.id)"
            @dragstart="onProjDragStart(p, $event)"
            @dragover="onProjDragOver(p, $event)"
            @drop="onProjDrop(p, $event)"
          >
            <span class="bm-favicon" :style="{ background: p.color || '#10b981' }"></span>{{ p.name }}
          </button>
        </div>
        <button class="chip manage-btn" :class="{ active: showExport }" @click="openExport">
          导出
        </button>
        <button class="chip manage-btn" :class="{ active: showProjectManage }" @click="openProjectManage">
          管理
        </button>
      </template>
    </div>

    <!-- 项目管理面板 -->
    <div v-if="showProjectManage" class="modal-mask">
      <div class="modal project-manage-modal">
        <div class="modal-head">
          <strong>项目管理</strong>
          <button class="ghost sm" @click="showProjectManage = false" aria-label="关闭">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>

        <div class="pm-form">
          <input v-model="projectForm.name" placeholder="新项目名称" class="pm-name-input" @keyup.enter="saveProject" />
          <VoiceInput v-model="projectForm.name" />
          <select v-model="projectParentId" class="pm-parent-input" :class="{ invalid: !!parentError }" title="所属父项目">
            <option :value="null">（顶层项目）</option>
            <option
              v-for="p in projects"
              :key="p.id"
              :value="p.id"
              :disabled="isInvalidParent(p.id)"
            >{{ p.name }}{{ isInvalidParent(p.id) ? (p.id === projectForm.id ? '（不可选：当前项目）' : '（不可选：子项目）') : '' }}</option>
          </select>
          <input type="color" v-model="projectForm.color" class="pm-color-input" title="选择颜色" />
          <button class="ghost duty-proj-btn" @click="openDutyProj">按日程添加</button>
          <button class="primary" :disabled="!!parentError" :title="parentError || ''" @click="saveProject">{{ projectForm.id ? '保存' : '添加' }}</button>
          <button v-if="projectForm.id" class="ghost" @click="resetProjectForm">取消</button>
        </div>
        <p v-if="parentError" class="pm-error">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v5M12 17h.01"/><path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
          {{ parentError }}
        </p>
        <div class="pm-list">
          <div v-for="n in visibleProjectNodes" :key="n.node.id" class="pm-item" :style="{ paddingLeft: (8 + n.depth * 16) + 'px' }">
            <button
              v-if="n.hasChildren"
              class="pm-toggle"
              :title="n.expanded ? '折叠' : '展开'"
              @click="toggleProjectNode(n.node.id)"
            >{{ n.expanded ? '▼' : '▶' }}</button>
            <span v-else class="pm-toggle-placeholder"></span>
            <span class="bm-favicon" :style="{ background: n.node.color || '#10b981' }"></span>
            <span class="pm-name">{{ n.node.name }}</span>
            <button class="ghost sm" @click="startEditProject(n.node)">编辑</button>
            <button class="ghost sm danger" @click="deleteProject(n.node)">删除</button>
          </div>
          <p v-if="!visibleProjectNodes.length" class="muted sm-info" style="padding: 6px 2px">暂无项目，先在上方添加一个。</p>
        </div>
      </div>
    </div>

    <!-- 时间筛选 + 搜索 + 新建任务 -->
    <div class="panel-flat filter-main">
      <div class="filter-group time-group">
        <span class="muted group-label">时间</span>
        <button class="chip" :class="{ active: dayMode === 'today' }" @click="dayMode = 'today'">今天</button>
        <button class="chip" :class="{ active: dayMode === 'yesterday' }" @click="dayMode = 'yesterday'">昨天</button>
        <button class="chip more-toggle" :class="{ active: showMore }" @click="showMore = !showMore">
          {{ showMore ? '收起' : '更多' }}
        </button>
        <span class="range-label muted">{{ activeRange.label }}</span>
      </div>
      <div class="task-search">
        <input v-model="localSearch" placeholder="搜索任务…" />
      </div>
      <button class="primary new-btn" @click="openNew">
        <svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align: -2px; margin-right: 4px">
          <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        新建任务
      </button>
    </div>

    <!-- 更多：特定日期 / 自定义范围 / 全部 -->
    <div v-if="showMore" class="panel-flat filter-more">
      <div class="more-modes">
        <button class="chip" :class="{ active: dayMode === 'specific' }" @click="dayMode = 'specific'">特定日期</button>
        <button class="chip" :class="{ active: dayMode === 'range' }" @click="dayMode = 'range'">自定义范围</button>
        <button class="chip" :class="{ active: dayMode === 'all' }" @click="dayMode = 'all'">全部</button>
      </div>
      <template v-if="dayMode === 'specific'">
        <input class="date-in" type="date" v-model="specificDay" />
        <span class="day-nav">
          <button class="chip icon" @click="stepActiveDay(-1)" title="前一天">‹</button>
          <button class="chip icon" @click="stepActiveDay(1)" title="后一天">›</button>
        </span>
      </template>
      <template v-else-if="dayMode === 'range'">
        <input class="date-in" type="date" v-model="rangeStart" />
        <span class="muted">至</span>
        <input class="date-in" type="date" v-model="rangeEnd" />
      </template>
      <template v-else-if="dayMode === 'all'">
        <span class="muted">显示全部时间的任务</span>
      </template>
    </div>

    <!-- 四象限过滤 -->
    <div class="filter">
      <button :class="['chip', { active: !focused }]" @click="focused = null">全部象限</button>
      <button
        v-for="k in QUAD_LAYOUT"
        :key="k"
        :class="['chip', { active: focused === k }]"
        :style="focused === k ? { borderColor: colors[k] || 'var(--primary)', color: colors[k] || 'var(--primary)' } : {}"
        @click="focused = focused === k ? null : k"
      >
        {{ QUAD[k] }}
      </button>
      <span class="muted sm-info" style="margin-left: auto">
        <template v-if="dateLabel">
          <template v-if="carryCount">{{ directCount }} 个{{ dateLabel }}任务 + {{ carryCount }} 个顺延任务</template>
          <template v-else>{{ filtered.length }} 个{{ dateLabel }}任务</template>
        </template>
        <template v-else>{{ filtered.length }} 个任务</template>
      </span>
    </div>

    <!-- 手机端四象限标签（≤900px 显示，桌面隐藏，由 .filter 的 chip 负责） -->
    <div class="quad-tabs" v-show="isNarrow">
      <button
        v-for="k in QUAD_LAYOUT"
        :key="k"
        class="quad-tab"
        :class="{ active: mobileQuadTab === k }"
        :style="{ '--qc': colors[k] || 'var(--primary)' }"
        @click="mobileQuadTab = k"
      >
        <span>{{ QUAD[k] }}</span>
        <span class="qt-count">{{ grouped[k].length }}</span>
      </button>
    </div>

    <div class="quad-grid" :class="{ single: focused }">
      <div
        v-for="k in QUAD_LAYOUT"
        :key="k"
        v-show="isNarrow ? k === mobileQuadTab : displayKeys.includes(k)"
        class="quad panel-flat"
        :class="{ 'is-focused': focused === k }"
        :style="{ '--qc': colors[k] || 'var(--primary)' }"
      >
        <div class="quad-head">
          <span class="quad-label">{{ QUAD[k] }}</span>
          <span class="quad-count muted">{{ grouped[k].length }}</span>
        </div>
        <div class="quad-list">
          <div
            v-for="(item, idx) in grouped[k]"
            :key="item.task.id + ':' + (item._carried ? 'c' : 'd') + ':' + idx"
            class="task"
            :class="{ done: item.task.status === '已完成', carried: item._carried, overdue: isOverdue(item.task) }"
          >
            <div class="task-row">
              <span v-if="item._carried" class="carry-tag" :title="`原始创建于 ${item._fromDay}`">
                <svg viewBox="0 0 24 24" width="11" height="11"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                从 {{ fmtCarryFrom(item._fromDay) }}顺延
              </span>
              <span class="task-title">{{ item.task.title }}</span>
              <span v-if="showCardDate" class="card-date">{{ item.task.dayKey }}</span>
            </div>
            <div class="meta">
              <span class="remain" :class="{ overdue: isOverdue(item.task) }">
                {{ remainText(item.task) }}
              </span>
              <select :value="item.task.status" @change="setStatus(item.task, $event.target.value)">
                <option v-for="s in STATUS" :key="s" :value="s">{{ s }}</option>
              </select>
              <button class="ghost sm" @click="edit(item.task)">编辑</button>
              <button class="ghost sm" title="设为自动化预设" @click="makePreset(item.task)">设为预设</button>
              <button
                v-if="item.task.docOutput"
                class="docout-btn sm"
                :disabled="docState.running || docState.picking"
                :title="docState.running ? '正在执行中…' : '选 A 文件并执行文档输出（用当前文档输出配置）'"
                @click="requestDocOutput()"
              >{{ docState.running ? '执行中…' : (docState.picking ? '选 A…' : '执行文档输出') }}</button>
            </div>
            <div v-if="item.task.remark" class="remark">
              <svg viewBox="0 0 24 24" width="13" height="13" class="remark-ico"><path d="M4 4h16v12H8l-4 4V4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
              <span>{{ item.task.remark }}</span>
            </div>
            <div v-if="item.task.content" class="task-content" v-html="renderTaskContent(item.task.content)"></div>
            <div v-if="item.task.subtasks && item.task.subtasks.length" class="subtasks">
              <button class="sub-toggle" @click="toggleSub(item.task.id)">
                <span class="sub-bar">
                  <span class="sub-bar-fill" :style="{ width: (subDone(item.task) / item.task.subtasks.length * 100) + '%' }"></span>
                </span>
                <span class="sub-count">子任务 {{ subDone(item.task) }}/{{ item.task.subtasks.length }}</span>
                <svg class="sub-caret" viewBox="0 0 24 24" width="14" height="14" :class="{ open: expandedSub[item.task.id] }"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <ul v-if="expandedSub[item.task.id]" class="sub-list">
                <li v-for="(s, si) in item.task.subtasks" :key="s.id || si" class="sub-item">
                  <label class="sub-check">
                    <input type="checkbox" :checked="!!s.done" @change="toggleSubtask(item.task, s)" />
                    <span :class="{ done: s.done }">{{ s.text }}</span>
                  </label>
                  <div class="sub-meta">
                    <span v-if="s.dueTime" class="sub-time muted">完成 {{ s.dueTime }}</span>
                    <span v-if="allLinksOf(s).length" class="sub-link-group">
                      <a v-for="(u, ui) in allLinksOf(s)" :key="ui" class="sub-link" :href="u.url" target="_blank" rel="noopener" :title="u.url" @click.prevent.stop="handleLinkClick(u.url, $event)">{{ u.label }} ↗</a>
                    </span>
                  </div>
                </li>
              </ul>
            </div>
            <div v-if="allLinksOf(item.task).length" class="task-links">
              <a v-for="(u, ui) in allLinksOf(item.task)" :key="ui" class="task-link" :href="u.url" target="_blank" rel="noopener" :title="u.url" @click.prevent.stop="handleLinkClick(u.url, $event)">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>
                {{ u.label }} ↗
              </a>
            </div>
          </div>
          <div v-if="!grouped[k].length" class="empty muted">— 空 —</div>
        </div>
      </div>
    </div>

    <!-- 弹窗 -->
    <div v-if="showForm" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <strong>{{ editingId ? '编辑待办' : '新建待办' }}</strong>
          <button class="ghost sm" @click="closeForm" aria-label="关闭">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="grid2">
          <div>
            <label>标题</label>
            <div class="voice-field">
              <input v-model="form.title" placeholder="要做的事…" @keyup.enter="submit" />
              <VoiceInput v-model="form.title" />
            </div>
          </div>
          <div>
            <label>所属项目</label>
            <select v-model="form.projectId">
              <option v-for="p in projectTree" :key="p.id" :value="p.id">{{ '··'.repeat(p.depth) }}{{ p.name }}</option>
            </select>
          </div>
          <div>
            <label>四象限分级</label>
            <select v-model="form.quadrant">
              <option v-for="k in QUAD_LAYOUT" :key="k" :value="k">{{ QUAD[k] }}</option>
            </select>
          </div>
          <div v-if="!form.subtasks.length">
            <label>完成时间</label>
            <input type="time" v-model="form.dueTime" />
          </div>
          <div style="grid-column: 1 / -1">
            <label>备注</label>
            <div class="voice-field voice-field-multiline">
              <textarea v-model="form.remark" placeholder="补充说明（可选，Enter 换行）" rows="3" class="remark-input"></textarea>
              <VoiceInput v-model="form.remark" />
            </div>
          </div>
          <div style="grid-column: 1 / -1">
            <label>跳转链接（可多个）</label>
            <div class="link-edit">
              <div v-for="(lnk, li) in form.links" :key="li" class="link-row">
                <input v-model="form.links[li].url" placeholder="https://...（可留空）" />
                <input v-model="form.links[li].label" placeholder="名称（默认：打开）" class="link-label" />
                <button class="ghost sm danger" type="button" @click="form.links.splice(li, 1)">删除</button>
              </div>
              <button class="ghost sm" type="button" @click="form.links.push({ url: '', label: '打开' })">+ 添加链接</button>
            </div>
          </div>
          <div style="grid-column: 1 / -1">
            <label>子任务（可选）</label>
            <div class="form-subs">
              <div v-for="(s, si) in form.subtasks" :key="s.id" class="form-sub-card">
                <div class="form-sub-head">
                  <span class="form-sub-idx">{{ si + 1 }}</span>
                  <input v-model="s.text" class="form-sub-name" placeholder="子任务内容" />
                  <VoiceInput v-model="s.text" />
                  <label class="form-sub-f inline">
                    <span>完成时间</span>
                    <input type="time" v-model="s.dueTime" />
                  </label>
                  <button class="ghost sm danger" type="button" @click="removeFormSubtask(si)">删除</button>
                </div>
                <div class="form-sub-links">
                  <span class="form-sub-links-label">跳转链接</span>
                  <div class="form-sub-link-rows">
                    <div v-for="(u, ui) in s.links" :key="ui" class="form-sub-link-row">
                      <input v-model="s.links[ui].url" placeholder="https://..." />
                      <input v-model="s.links[ui].label" placeholder="名称" class="link-label" />
                      <button class="ghost sm danger" type="button" @click="removeFormSubLink(s, ui)">删除</button>
                    </div>
                    <button class="ghost sm" type="button" @click="addFormSubLink(s)">+ 添加链接</button>
                  </div>
                </div>
              </div>
              <button class="ghost sm" type="button" @click="addFormSubtask">+ 添加子任务</button>
            </div>
          </div>
        </div>
        <div class="row" style="justify-content: flex-end; margin-top: 14px">
          <button v-if="editingId" class="danger" @click="remove(editingId)">删除此待办</button>
          <button class="ghost" @click="closeForm">取消</button>
          <button class="primary" @click="submit">{{ editingId ? '保存' : '添加待办' }}</button>
        </div>
      </div>
    </div>

    <!-- 按日程添加项目 -->
    <div v-if="showDutyProj" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <strong>按日程添加项目</strong>
          <button class="ghost sm" @click="showDutyProj = false" aria-label="关闭">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="grid2">
          <div>
            <label>人员</label>
            <select v-model="dutyForm.person">
              <option v-for="p in dutyPersons" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
          <div>
            <label>类型</label>
            <select v-model="dutyForm.mode">
              <option value="duty">值班日期</option>
              <option value="rest">休班日期</option>
            </select>
          </div>
          <div>
            <label>起始日期</label>
            <input type="date" v-model="dutyForm.start" />
          </div>
          <div>
            <label>结束日期</label>
            <input type="date" v-model="dutyForm.end" />
          </div>
          <div style="grid-column: 1 / -1">
            <label>归属项目（可选，留空为顶层）</label>
            <select v-model="dutyForm.parentId">
              <option :value="null">（顶层项目）</option>
              <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </div>
          <div style="grid-column: 1 / -1">
            <label>项目名称</label>
            <div class="voice-field">
              <input v-model="dutyForm.name" placeholder="自动生成，可修改" @input="dutyNameEdited = true" />
              <VoiceInput v-model="dutyForm.name" @result="dutyNameEdited = true" />
            </div>
          </div>
        </div>
        <p class="muted" style="margin: 10px 0 0; font-size: 13px">
          将匹配 <b>{{ dutyDateList.length }}</b> 个{{ dutyForm.mode === 'duty' ? '值班' : '休班' }}日，作为项目周期。
        </p>
        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px">
          <button class="ghost" @click="showDutyProj = false">取消</button>
          <button class="primary" @click="createProjectFromDuty">创建项目</button>
        </div>
      </div>
    </div>

    <!-- 导出任务 -->
    <div v-if="showExport" class="modal-mask">
      <div class="modal">
        <div class="modal-head">
          <strong>导出任务</strong>
          <button class="ghost sm" @click="showExport = false" aria-label="关闭">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>

        <div class="exp-block">
          <label class="exp-label">导出内容</label>
          <p class="muted sm-info" style="margin: 2px 0 0">
            将导出当前筛选出的任务（已套用：项目、时间、搜索、象限条件），共 {{ buildExportModel().rows.length }} 条。含子任务的任务会按「任务集合」逐条展开，集合名称只显示一次。
          </p>
        </div>

        <div class="exp-block">
          <label class="exp-label">导出范围</label>
          <div class="exp-opts">
            <button class="chip" :class="{ active: exportScope === 'current' }" @click="exportScope = 'current'">当前项目</button>
            <button class="chip" :class="{ active: exportScope === 'current-and-children' }" @click="exportScope = 'current-and-children'">当前项目及子项目</button>
          </div>
        </div>

        <div class="exp-block">
          <label class="exp-label">文件格式</label>
          <div class="exp-opts">
            <button class="chip" :class="{ active: exportFormat === 'md' }" @click="exportFormat = 'md'">Markdown</button>
            <button class="chip" :class="{ active: exportFormat === 'txt' }" @click="exportFormat = 'txt'">纯文本</button>
            <button class="chip" :class="{ active: exportFormat === 'xlsx' }" @click="exportFormat = 'xlsx'">Excel</button>
          </div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px">
          <button class="ghost" @click="showExport = false">取消</button>
          <button class="primary" @click="doExport">导出</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
  min-height: 0;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 4px 0;
}
/* 项目筛选行（独占最上方） */
.filter-project-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}
.manage-btn {
  margin-left: auto;
  flex: none;
}
/* 项目管理面板 */
.project-manage-modal {
  width: min(560px, 94vw);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 16px;
}
.project-manage-modal .pm-form,
.project-manage-modal .pm-error {
  flex: none;
}
.project-manage-modal .pm-list {
  flex: 1 1 auto;
  overflow-y: auto;
  max-height: 46vh;
  align-content: start;
}
.pm-form {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pm-name-input {
  flex: 1 1 200px;
  min-width: 140px;
  padding: 6px 10px;
  font-size: 13px;
}
.pm-color-input {
  width: 34px;
  height: 34px;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--panel-solid);
  cursor: pointer;
  flex: none;
}
.pm-parent-input {
  flex: 0 1 170px;
  min-width: 120px;
  padding: 6px 10px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-2);
  color: var(--text);
}
.pm-parent-input.invalid {
  border-color: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-soft);
}
.pm-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: 9px;
  font-size: 13px;
  color: var(--danger);
  background: var(--danger-soft);
}
/* 导出弹窗 */
.exp-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.exp-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
}
.exp-opts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pm-list {
  display: grid;
  gap: 6px;
}
.pm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 9px;
  background: var(--panel-2);
}
.pm-toggle {
  flex: none;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.pm-toggle:hover {
  color: var(--text);
}
.pm-toggle-placeholder {
  flex: none;
  width: 18px;
  height: 18px;
  display: inline-block;
}
.pm-item .pm-name {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pm-item .bm-favicon {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  flex: none;
}
/* 时间 + 搜索 + 新建 主行 */
.filter-main {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  flex-wrap: wrap;
}
.filter-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.group-label {
  flex: none;
  font-size: 12px;
}
.time-group {
  flex: 0 1 auto;
  flex-wrap: wrap;
}
.range-label {
  font-size: 12px;
  margin-left: 2px;
}
/* 内联搜索框（由全局顶栏移入，已缩减、无图标） */
.task-search {
  flex: 1 1 220px;
  min-width: 160px;
}
.task-search input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 6px 11px;
  font-size: 13px;
  background: var(--panel-2);
  color: var(--text);
}
.task-search input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.duty-proj-btn {
  flex: none;
  white-space: nowrap;
}
.new-btn {
  margin-left: auto;
  flex: none;
  white-space: nowrap;
}
.more-toggle {
  color: var(--muted);
}
/* 更多面板：特定日期 / 自定义范围 / 全部 */
.filter-more {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 12px;
}
.more-modes {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.date-in {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 13px;
  background: var(--panel-solid);
  color: var(--text);
}
.date-in:focus {
  outline: none;
  border-color: var(--primary);
}
.day-nav {
  display: inline-flex;
  gap: 4px;
}
.chip.icon {
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
}
.carry-hint {
  color: var(--primary);
  font-weight: 700;
  margin-left: 4px;
}

.filter {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
/* 书签式项目筛选（浏览器收藏夹风格） */
.project-group .bm-scroll,
.filter-project-row .bm-scroll {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.filter-project-row .bm-scroll {
  flex: 1;
  min-width: 0;
}
.bm-scroll::-webkit-scrollbar {
  display: none;
}
.bm {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 180px;
  padding: 5px 11px 5px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel-solid);
  color: var(--text);
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.bm:hover {
  border-color: var(--primary);
  background: var(--primary-soft);
}
.bm.active {
  border-color: var(--primary);
  background: var(--primary-soft-strong);
  color: var(--primary);
  font-weight: 500;
}
.bm-favicon {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
}
.bm-favicon.all {
  background: var(--panel-2);
  color: var(--muted);
}
.bm-drag {
  cursor: grab;
}
.bm-drag:active {
  cursor: grabbing;
}
.bm-drag.dragging {
  opacity: 0.5;
}
/* 项目筛选行：下钻态时面包屑、任务数、管理按钮在同一行严格居中 */
.filter-project-row.drilling {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  row-gap: 10px;
}
.filter-project-row.drilling .ctx-crumb {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  flex: 1;
  min-width: 0;
  line-height: 1;
  height: 24px;
  overflow: hidden;
}
.filter-project-row.drilling .ctx-count {
  display: inline-flex;
  align-items: center;
  height: 24px;
  line-height: 1;
  flex: none;
  margin-left: auto;
}
.filter-project-row.drilling .manage-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  padding: 0 10px;
  margin-left: 10px;
  line-height: 1;
}
.filter-project-row.drilling .sub-rows {
  width: 100%;
}
.crumb-item {
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: 13px;
  line-height: 1;
  padding: 0 4px;
  border-radius: 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  height: 24px;
  vertical-align: middle;
}
.crumb-item:hover {
  background: var(--primary-soft);
}
.crumb-item.current {
  color: var(--text);
  font-weight: 600;
  cursor: default;
}
.crumb-item.current:hover {
  background: transparent;
}
.crumb-sep {
  color: var(--muted);
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  line-height: 1;
}
/* 子项目快速切换行（可点击整行，类似分组行） */
.sub-rows {
  display: grid;
  gap: 8px;
}
.sub-row-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--panel-solid);
  color: var(--text);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.sub-row-item:hover {
  border-color: var(--sc);
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.07);
}
.sub-row-item.active {
  border-color: var(--sc);
  background: var(--primary-soft-strong);
}
.sr-dot {
  width: 12px;
  height: 12px;
  border-radius: 4px;
  flex: none;
}
.sr-name {
  font-weight: 600;
  font-size: 14px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sr-count {
  font-size: 12px;
  color: var(--muted);
  flex: none;
  background: var(--panel-2);
  border-radius: 999px;
  padding: 2px 9px;
}
.sr-arrow {
  flex: none;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
}
/* 管理模式下的展开方式切换 */
.pm-mode {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
}
.seg button {
  border: none;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
}
.seg button.active {
  background: var(--primary);
  color: #fff;
}
.sm-info {
  font-size: 12px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.voice-field {
  display: flex;
  align-items: center;
  gap: 6px;
}
.voice-field input {
  flex: 1;
  min-width: 0;
}
.voice-field-multiline {
  align-items: flex-start;
}
.voice-field-multiline .remark-input {
  flex: 1;
  min-width: 0;
  min-height: 60px;
  max-height: 220px;
  resize: vertical;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.voice-field-multiline .remark-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
@media (max-width: 640px) {
  .grid2 {
    grid-template-columns: 1fr;
  }
}
.dur-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dur-row input {
  width: 80px;
  min-width: 0;
}
.dur-sep {
  color: var(--muted);
  font-size: 13px;
  flex: none;
}
.quad-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 14px;
  flex: 1;
  min-height: 0;
}
.quad-grid.single {
  grid-template-columns: 1fr;
  grid-template-rows: 1fr;
}
@media (max-width: 900px) {
  .quad-grid {
    grid-template-columns: 1fr;
  }
  /* 手机端：四象限改标签页，避免 2x2 挤成 2 行被裁切（问题4） */
  .filter {
    display: none !important; /* 窄屏用 .quad-tabs 切换，不再需要全部/单象限 chip */
  }
  .quad-tabs {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    margin-bottom: 12px;
    -webkit-overflow-scrolling: touch;
  }
  .quad-tab {
    flex: 1 1 0;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 9px 4px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel-2);
    color: var(--muted);
    font-size: 12.5px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .quad-tab.active {
    background: var(--primary-soft);
    color: var(--primary);
    border-color: var(--primary);
  }
  .quad-tab .qt-count {
    font-size: 11px;
    font-weight: 700;
    background: var(--panel-solid);
    border-radius: 999px;
    padding: 0 6px;
    color: var(--muted);
  }
  .quad-tab.active .qt-count {
    color: var(--primary);
  }
  .quad-grid {
    display: block; /* 取消网格，单象限文档流 */
  }
  .quad {
    display: flex !important;
    height: auto !important;
    max-height: none !important;
    min-height: 0 !important;
    overflow: visible !important;
  }
  .quad-list {
    overflow: visible !important;
    max-height: none !important;
  }
}
.quad {
  --qc: var(--primary);
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: none;
  height: 100%;
  overflow: hidden;
  /* 玻璃质感：柔和阴影 + 顶部高光 */
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--panel-solid);
  box-shadow: var(--shadow), inset 0 1px 0 var(--glass-hi);
  transition: box-shadow 0.2s ease, transform 0.2s ease;
}
.quad::before {
  /* 左上角细色条，替代原来的粗硬 borderTop */
  content: "";
  position: absolute;
  top: 14px;
  left: 14px;
  width: 26px;
  height: 4px;
  border-radius: 999px;
  background: var(--qc);
}
.quad.is-focused {
  box-shadow: var(--shadow-lg), inset 0 1px 0 var(--glass-hi);
  transform: translateY(-2px);
}
.quad-grid.single .quad {
  min-height: 0;
  height: 100%;
  max-height: none;
}
@media (max-width: 900px) {
  .quad-grid.single .quad {
    min-height: 520px;
    max-height: none;
  }
}
.quad-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
  padding: 2px 4px 0 48px; /* 给左上角色条留位 */
  flex: none;
}
.quad-label {
  font-weight: 600;
  font-size: 14px;
  color: var(--qc);
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.quad-label svg {
  opacity: 0.9;
}
.quad-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  background: var(--panel-2);
  padding: 2px 9px;
  border-radius: 999px;
}
.quad-list {
  display: grid;
  gap: 9px;
  overflow-y: auto;
  flex: 1;
  padding: 2px 4px 4px;
  /* 象限内滚动到边界后不再带动整个浏览器页面滚动 */
  overscroll-behavior: contain;
}
.quad-grid.single .quad-list {
  max-height: none;
}
.task {
  position: relative;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px 10px 14px;
  background: var(--panel-solid);
  /* 静息阴影更克制，对齐右侧任务总览 .fluid-card 的柔和质感，避免卡片糊成一片 */
  box-shadow: inset 0 1px rgba(255, 255, 255, .08), 0 8px 22px rgba(0, 0, 0, .18);
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}
[data-theme="light"] .task {
  box-shadow: inset 0 1px rgba(255, 255, 255, .7), 0 4px 14px rgba(15, 23, 42, .05);
}
.task::before {
  /* 左侧细色轨，呼应所属象限主色 */
  content: "";
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 999px;
  background: var(--qc, var(--primary));
  opacity: 0.55;
}
.task:hover {
  border-color: var(--qc, var(--primary));
  box-shadow: var(--shadow-lg);
  transform: translateY(-1px);
}
.task.done {
  opacity: 0.58;
}
/* 深色下已完成/逾期待办的文字与数字统一为白色，避免 opacity 把白字压成灰黑 */
[data-theme="dark"] .task.done,
[data-theme="dark"] .task.overdue {
  opacity: 1;
}
[data-theme="dark"] .task.done .task-title,
[data-theme="dark"] .task.overdue .task-title,
[data-theme="dark"] .task.done .card-date,
[data-theme="dark"] .task.overdue .card-date,
[data-theme="dark"] .task.done .sub-count,
[data-theme="dark"] .task.overdue .sub-count,
[data-theme="dark"] .task.done .remain,
[data-theme="dark"] .task.overdue .remain {
  color: #fff;
}
[data-theme="dark"] .task.done {
  background: var(--panel-2);
}
.task.carried {
  background: var(--panel-2);
}
.task.carried::before {
  background: var(--carried-color, #8b5cf6);
  opacity: 0.95;
}
.task-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}
.task-title {
  font-weight: 500;
  font-size: 14px;
}
.card-date {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 7px;
  margin-left: auto;
}
.task.done .task-title {
  text-decoration: line-through;
}
.carried-title {
  font-weight: 500;
  font-size: 14px;
  flex: 1;
}
.carry-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: var(--carried-soft, rgba(139, 92, 246, 0.14));
  color: var(--carried-color, #8b5cf6);
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.meta {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 7px;
}
.meta select {
  width: auto;
  padding: 4px 6px;
}
.remain {
  font-size: 12px;
  color: var(--primary);
  background: var(--primary-soft);
  border-radius: 999px;
  padding: 2px 8px;
}
.remain.overdue {
  color: #fff;
  background: var(--danger);
}
.remark {
  margin-top: 6px;
  color: var(--text);
  font-size: 13px;
  display: flex;
  gap: 6px;
  align-items: flex-start;
  line-height: 1.5;
}
.remark span {
  word-break: break-word;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.remark-ico {
  flex: none;
  margin-top: 2px;
  opacity: 0.85;
}
/* 任务正文（笔记转任务带入的 Markdown，含图片） */
.task-content {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-soft);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  word-break: break-word;
  overflow-wrap: anywhere;
}
.task-content p {
  margin: 0 0 6px;
}
.task-content p:last-child {
  margin-bottom: 0;
}
.task-content img {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
  display: block;
  margin: 4px 0;
}
.task-content pre {
  background: var(--bg);
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
}
.task-content code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.task-content a {
  color: var(--primary);
}
/* 自动化任务的子任务清单 */
.subtasks {
  margin-top: 8px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
.sub-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 2px 0;
  font-size: 12.5px;
}
.sub-bar {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--panel-2);
  overflow: hidden;
}
.sub-bar-fill {
  display: block;
  height: 100%;
  background: var(--primary);
  border-radius: 999px;
  transition: width 0.2s ease;
}
.sub-count {
  flex: none;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--text);
}
.sub-caret {
  flex: none;
  transition: transform 0.18s ease;
  color: var(--muted);
}
.sub-caret.open {
  transform: rotate(180deg);
}
.sub-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.sub-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sub-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
  width: 100%;
  padding: 4px 6px;
  border-radius: 8px;
}
.sub-check:hover {
  background: var(--panel-2);
}
.sub-check input[type='checkbox'] {
  width: 16px;
  height: 16px;
  flex: none;
  accent-color: var(--primary);
}
.sub-check span {
  word-break: break-word;
}
.sub-check span.done {
  color: var(--muted);
  text-decoration: line-through;
}
.sub-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: -2px 0 2px 24px;
  font-size: 11px;
}
.sub-quad {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  color: #fff;
  font-weight: 600;
}
.sub-quad.q-urgentimportant { background: #ef4444; }
.sub-quad.q-noturgentimportant { background: #2aabe8; }
.sub-quad.q-urgentnotimportant { background: #e69d23; }
.sub-quad.q-noturgentnotimportant { background: #845ee7; }
.sub-time {
  font-size: 11px;
}
.sub-link {
  flex: none;
  color: var(--primary);
  text-decoration: none;
  font-weight: 600;
}
.sub-link:hover {
  text-decoration: underline;
}
.sub-link-group {
  display: flex;
  align-items: center;
  gap: 5px;
}
/* 任务卡：多个跳转链接 */
.task-links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.task-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-decoration: none;
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 3px 9px;
  font-size: 12px;
  color: var(--primary);
  background: var(--panel-solid);
  white-space: nowrap;
}
.task-link:hover {
  background: var(--primary-soft);
  border-color: var(--primary);
}
/* 新建/编辑表单：多个链接输入行 */
.link-edit {
  display: grid;
  gap: 6px;
}
.link-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.link-row input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-solid);
  color: var(--text);
}
.link-row input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.link-row .link-label {
  flex: none;
  width: 130px;
}
.empty {
  text-align: center;
  font-size: 12px;
  padding: 10px 0;
}
/* 新建/编辑任务：子任务编辑器 */
.form-subs {
  display: grid;
  gap: 8px;
}
.form-sub-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  padding: 9px 11px;
  display: grid;
  gap: 8px;
}
.form-sub-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.form-sub-idx {
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
.form-sub-head input {
  flex: 1;
  min-width: 0;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 13px;
}
.form-sub-body {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.form-sub-f {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--muted);
}
.form-sub-f input,
.form-sub-f select {
  padding: 5px 7px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  width: 100%;
}
/* 子任务名称与完成时间同处一行：名称栏收窄，完成时间固定宽度 */
.form-sub-name {
  max-width: 220px;
}
.form-sub-f.inline {
  flex: 0 0 auto;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.form-sub-f.inline input {
  flex: 0 0 auto;
  width: 115px;
}
.form-sub-links {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 7px;
  border-top: 1px dashed var(--border);
}
.form-sub-links-label {
  font-size: 11px;
  color: var(--muted);
}
.form-sub-link-rows {
  display: grid;
  gap: 5px;
}
.form-sub-link-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.form-sub-link-row input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 12px;
}
.form-sub-link-row .link-label {
  flex: 0 0 96px;
}
@media (max-width: 520px) {
  .form-sub-body {
    grid-template-columns: 1fr;
  }
}
</style>
