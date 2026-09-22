<script setup>
/**
 * 总览首页
 * 聚合展示：今天要处理 / 3D 项目堆叠 / 本周趋势 / 值班今日 / 快捷方式
 * 所有数据来自 IndexedDB，无外部依赖；图表用内联 SVG 手写。
 */
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import { db } from '../db'
import { ensureDefaultProject } from '../seed'
import { resolveWeekProjectForDate } from '../autoProjects'
import { shiftKeyOf, weekdayOf, isWeekend, isWorkingDay, isSingleShiftDay, SHIFT_KEYS } from '../shift'
import { openExternal, localPathOf } from '../utils/localOpen.js'
// 第 43 轮：链接级 / 全局默认浏览器
import { browserForLink, loadBrowserPrefs, getBrowserList } from '../utils/browserPref.js'
import ProjectStack from './ProjectStack.vue'
import ProjectManager from './ProjectManager.vue'
import TaskFormModal from '../components/TaskFormModal.vue'

const emit = defineEmits(['goto'])

const tasks = ref([])
const projects = ref([])
const duty = ref([])
const notes = ref([])
const shortcuts = ref([])
// 单人班排除人名（与设置中心-自动化 tab 的 singleShiftExclude 一致；空 = 不排除）
const singleShiftExclude = ref('')
const quadColors = reactive({
  'urgent-important': '#ef4444',
  'urgent-notimportant': '#f59e0b',
  'noturgent-important': '#3b82f6',
  'noturgent-notimportant': '#9ca3af'
})
const showProjMgr = ref(false)
const selectedProjectId = ref(null)
const selectedProjectName = computed(() => {
  const p = projects.value.find((x) => x.id === selectedProjectId.value)
  return p ? p.name : ''
})

const now = ref(new Date())
let clockTimer = null

async function loadAll() {
  // 先保证至少有默认项目（不依赖 App 的挂载时序，避免子组件先读空数组）
  await ensureDefaultProject()
  const [t, p, d, n, s, qc] = await Promise.all([
    db.tasks.toArray(),
    db.projects.toArray(),
    db.duty.toArray(),
    db.notes.toArray(),
    db.shortcuts.toArray(),
    db.settings.get('quadrantColors')
  ])
  tasks.value = t
  projects.value = p
  duty.value = d
  notes.value = n
  shortcuts.value = s
  if (qc && qc.value) Object.assign(quadColors, qc.value)
  // 单人班排除人名：与设置中心-自动化 tab 的 singleShiftExclude 共享同一份设置
  const sse = await db.settings.get('singleShiftExclude')
  singleShiftExclude.value = (sse && sse.value ? String(sse.value) : '').trim()
}
/* ---------- 今天要处理：页内快捷新增任务（不跳转，复用 TaskFormModal 公共组件） ---------- */
const showQuickAdd = ref(false)
const formInitial = ref({})
function openQuickAdd() {
  // 若当前按项目筛选，默认落在被筛选的项目上
  formInitial.value = {
    title: '',
    projectId: selectedProjectId.value || projects.value[0]?.id || null,
    quadrant: 'noturgent-important',
    dueTime: '',
    remindTime: '',
    remark: '',
    links: [],
    subtasks: []
  }
  showQuickAdd.value = true
}
function closeQuickAdd() {
  showQuickAdd.value = false
}
// 链接落库前的统一归一（第 42 轮）：本地路径先剥壳，避免存成 `https://"C:\…"` 后点不开
// 第 43 轮：保留 browser（链接级浏览器 id）；空值删掉，别在库里堆 browser:'' 的脏字段
function normLinks(list) {
  return (list || [])
    .filter((l) => (l && (l.url || '').trim()))
    .map((l) => {
      const out = { url: localPathOf(l.url) || l.url.trim(), label: (l.label || '打开').trim() || '打开' }
      const b = (l.browser == null ? '' : String(l.browser)).trim()
      if (b) out.browser = b
      return out
    })
}
async function onQuickSubmit(data) {
  const title = (data.title || '').trim()
  if (!title) return
  const d = new Date()
  const dayBase = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  // 完成时间：填了按当天 HH:MM；没填（含 00:00 这种 0 值）则与任务管理表单同一规则，默认「当前 +60 分钟」。
  // 默认分支刻意用绝对时间戳而非 dayBase+分钟：跨午夜时基准日会自动顺延到次日，
  // 否则 23:50 新建会得到「今天 00:50」，一创建就已逾期。
  // 关键：必须用 dueMin>0 判断，不能只 if (data.dueTime) —— 「00:00」也是 truthy，会走 if 分支得到 followUpAt=0（命中原因同 Tasks.vue 已有的同款隐患）。
  let followUpAt = 0
  const dueMin = timeToMinutes(data.dueTime)
  if (data.dueTime && dueMin > 0) {
    followUpAt = dayBase + dueMin * 60000
  } else {
    followUpAt = Date.now() + 60 * 60000
  }
  const plainSubtasks = JSON.parse(JSON.stringify(data.subtasks || []))
    .filter((s) => (s.text || '').trim())
    .map((s) => ({
      id: s.id || String(Date.now()) + Math.random().toString(36).slice(2),
      text: s.text.trim(),
      done: !!s.done,
      dueTime: (s.dueTime || '').trim(),
      remindTime: (s.remindTime || '').trim(),
      links: normLinks(s.links)
    }))
  const plainLinks = normLinks(data.links)
  await db.tasks.add({
    title,
    projectId: data.projectId || projects.value[0]?.id || null,
    quadrant: data.quadrant,
    status: '待办',
    followUpAt,
    // 与 Tasks.vue 语义保持一致：未单独设提醒时间时，提醒时间 = 完成时间。
    // 不能写 0 —— 下游用的是 || 取值链，0 会被当空值穿透，但历史库里已写入的 0 无法回溯。
    nextRemindAt: followUpAt,
    dayKey: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    remark: data.remark || '',
    links: plainLinks,
    subtasks: plainSubtasks,
    createdAt: Date.now()
  })
  showQuickAdd.value = false
  await loadAll()
  // 通知其它视图（任务管理）同步刷新
  window.dispatchEvent(new Event('task-updated'))
}

function quadColor(key) {
  return quadColors[key] || quadColors['noturgent-notimportant']
}

function onTaskUpdated() {
  // 通知（App.vue）或在其它视图完成的任务，总览也要同步刷新
  loadAll()
}
onMounted(async () => {
  await loadAll()
  await ensurePeriodicTasks()
  clockTimer = setInterval(() => (now.value = new Date()), 30000)
  window.addEventListener('task-updated', onTaskUpdated)
})
onUnmounted(() => {
  clearInterval(clockTimer)
  if (genTimer) clearTimeout(genTimer)
  window.removeEventListener('task-updated', onTaskUpdated)
})

/* ---------- 时间工具 ---------- */
const DAY = 86400000
function startOfDay(d = new Date()) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}
function ymd(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const todayStart = computed(() => startOfDay(now.value))
const todayKey = computed(() => ymd(todayStart.value))

const greeting = computed(() => {
  const h = now.value.getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
})
const dateText = computed(() => {
  const d = now.value
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${week}`
})

/* ---------- 今天要处理（铁律 5） ---------- */
// 注意：这里必须用 || 而不是 ?? —— nextRemindAt 会被显式写入 0（无提醒时间），
// 而 ?? 只穿透 null/undefined，不穿透 0，会导致到期时间恒为 0、时间显示为空。
const dueOf = (t) => t.nextRemindAt || t.followUpAt || 0
const todoToday = computed(() => {
  const nowTs = now.value.getTime()
  const end = todayStart.value + DAY
  return tasks.value
    .filter((t) => t.status !== '已完成')
    .map((t) => {
      const due = dueOf(t)
      let bucket = 'later'
      if (due && due < nowTs) bucket = 'overdue'
      else if (due && due < end) bucket = 'today'
      else if (t.dayKey === todayKey.value) bucket = 'today'
      return { ...t, due, bucket }
    })
    .filter((t) => t.bucket !== 'later')
    .filter((t) => selectedProjectId.value == null || t.projectId === selectedProjectId.value)
    .sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket === 'overdue' ? -1 : 1
      return (a.due || Infinity) - (b.due || Infinity)
    })
})
const overdueCount = computed(() => todoToday.value.filter((t) => t.bucket === 'overdue').length)

function fmtDue(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  const sameDay = startOfDay(d) === todayStart.value
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  if (sameDay) return `今天 ${hm}`
  const diffDay = Math.round((startOfDay(d) - todayStart.value) / DAY)
  if (diffDay === -1) return `昨天 ${hm}`
  if (diffDay === 1) return `明天 ${hm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

// 去掉自动任务系统加的前缀「自动生成 · {人} · {班次}」，只展示用户真实备注
function stripAutoGenPrefix(remark) {
  if (!remark) return ''
  // 第一行通常是「自动生成 · xxx · 主班生成」，去掉
  const lines = remark.split(/\r?\n/)
  const rest = lines.slice(1).join('\n').trim()
  return rest || lines[0].replace(/^自动生成 · .*? · .*?生成/, '').trim()
}

async function completeTask(id) {
  await db.tasks.update(id, { status: '已完成', completedAt: Date.now() })
  await loadAll()
}
async function snoozeTask(id, minutes = 60) {
  const next = Date.now() + minutes * 60000
  await db.tasks.update(id, { nextRemindAt: next, status: '跟进中' })
  await loadAll()
}

/* 兼容 legacy 单链接字段，统一返回链接数组 */
const QUAD_SHORT = {
  'urgent-important': '重要紧急',
  'noturgent-important': '重要不紧急',
  'urgent-notimportant': '不重要紧急',
  'noturgent-notimportant': '不重要不紧急'
}
/* 链接统一规范化成 { url, label, browser }，与任务管理口径一致 */
function normLinkItem(x) {
  if (typeof x === 'string') return { url: x, label: '打开' }
  if (x && typeof x === 'object') {
    const url = (x.url || '').trim()
    const label = (x.label || '打开').trim() || '打开'
    return { url, label, browser: (x.browser == null ? '' : String(x.browser)).trim() }
  }
  return { url: '', label: '打开' }
}
function allLinks(t) {
  let arr = []
  if (Array.isArray(t.links) && t.links.length) arr = t.links
  else if (t.link) arr = [t.link]
  else if (t.url) arr = [t.url]
  return arr.filter(Boolean).map(normLinkItem).filter((l) => l.url)
}
function allLinksOfSub(s) {
  let arr = []
  if (Array.isArray(s.links) && s.links.length) arr = s.links
  else if (s.url) arr = [s.url]
  else if (s.link) arr = [s.link]
  return arr.filter(Boolean).map(normLinkItem).filter((l) => l.url)
}
async function toggleSubDone(t, sub) {
  // 始终基于 DB 中的最新快照翻转：传入的 t/sub 来自 computed 或重渲染后的副本，
  // 引用可能已过期，直接用旧引用翻转会覆盖其它已勾选项。改为先 get 最新再翻转。
  const fresh = await db.tasks.get(t.id)
  if (!fresh) return
  const subs = (fresh.subtasks || []).map((s) => {
    const match = sub && sub.id != null ? s.id === sub.id : s === sub
    return match ? { ...s, done: !s.done } : { ...s }
  })
  const allDone = subs.length > 0 && subs.every((s) => s.done)
  const patch = { subtasks: subs }
  if (allDone) {
    patch.status = '已完成'
    patch.completedAt = Date.now()
  }
  try {
    await db.tasks.update(t.id, patch)
  } catch (e) {
    console.error('toggleSubDone failed', e)
    flash('更新子任务失败：' + (e.message || e))
    return
  }
  await loadAll()
}

/* 含子任务的任务集合辅助 */
function hasSubs(t) {
  return Array.isArray(t.subtasks) && t.subtasks.length > 0
}
function doneCount(t) {
  if (!hasSubs(t)) return 0
  return t.subtasks.filter((s) => s.done).length
}
function subOverdue(s, t) {
  // 集合整体逾期且子任务未完成 → 该子任务行显示逾期
  return t.bucket === 'overdue' && !s.done
}
async function completeCollection(t) {
  try {
    // 始终基于 DB 最新快照操作：模板传入的 t 可能是重渲染前的旧副本，
    // 直接拿旧引用更新会覆盖他人改动或踩到陈旧数据（圆形勾选框曾因此静默失效）。
    // 与圆角勾选框（toggleSubDone）一致的稳健写法：先 get 最新，再一次性原子更新。
    const fresh = await db.tasks.get(t.id)
    if (!fresh) return
    const patch = { status: '已完成', completedAt: Date.now() }
    if (Array.isArray(fresh.subtasks) && fresh.subtasks.length) {
      patch.subtasks = fresh.subtasks.map((s) => ({ ...s, done: true }))
    }
    await db.tasks.update(t.id, patch)
    await loadAll()
  } catch (e) {
    console.error('completeCollection failed', e)
  }
}

/* ---------- 值班周期任务自动生成 ----------
 * 触发条件为「星期 + 当日班次 + 人员」三重匹配，任一不满足就不生成。
 * 班次来自日程表（duty）导入的排班原文，映射规则见 src/shift.js。
 * 当天在排班表中查不到该人的任何记录 → 视为休班（与日程页的休班推导口径一致）。
 * 生成时机：每条规则可配置「生成钟点」genHour（默认 9）。当前钟点 < 该规则 genHour 时跳过该规则并挂定时器到点再补；
 * force=true（手动立即生成）跳过所有时间门槛。9 点不再是全局写死，改由各规则自行设定。
 */
const GEN_HOUR = 9
let genTimer = null
// 重入保护：ensurePeriodicTasks 是异步的，且在 onMounted 与 watch(duty) 两处都会被触发，
// 二者可能在 await 间隙并发执行（都读到「尚无自动任务」的快照 → 各插入一条 → 出现两条重复）。
// 用 genRunning 串行化：并发调用合并为一次，结束后若期间又有触发则补跑一次。
let genRunning = false
let genQueued = false

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
function dateInRange(dateStr, startStr, endStr) {
  if (!dateStr) return true
  if (startStr && dateStr < startStr) return false
  if (endStr && dateStr > endStr) return false
  return true
}
function migrateRuleForGen(r) {
  if (!r) return r
  const migrated = { weekdays: [], shifts: [], url: '', freq: 'weekly', monthDays: [], projectId: null, genHour: 9, ...r }
  // 频率：仅 'monthly' 走按月日期匹配，其余一律按星期（含旧规则无 freq 字段）
  if (migrated.freq !== 'monthly') migrated.freq = 'weekly'
  if (!Array.isArray(migrated.monthDays)) migrated.monthDays = []
  // 旧规则用单 shift 字符串，新规则用 shifts 多选数组（空 = 不限）
  // 关键：shifts 为空数组时也要回退到 r.shift —— 否则早期规则会被当作「不限」生成
  if (!Array.isArray(migrated.shifts) || migrated.shifts.length === 0) {
    migrated.shifts = migrated.shift && migrated.shift !== '不限' ? [migrated.shift] : (Array.isArray(migrated.shifts) ? [] : [])
  } else if (migrated.shifts.includes('不限')) {
    const others = migrated.shifts.filter((s) => s !== '不限')
    migrated.shifts = others.length ? others : []
  }
  if (!Array.isArray(migrated.persons)) {
    migrated.persons = migrated.person ? [migrated.person] : []
  }
  if (!migrated.dueTime && Number(r.followMinutes) > 0) {
    migrated.dueTime = minutesToTime(r.followMinutes)
  }
  if (!migrated.remindTime) migrated.remindTime = ''
  if (!migrated.dateRange) migrated.dateRange = { start: '', end: '' }
  if (Array.isArray(migrated.subtasks)) {
    migrated.subtasks = migrated.subtasks.map((s) => ({
      ...s,
      dueTime: s.dueTime || (Number(s.followMinutes) > 0 ? minutesToTime(s.followMinutes) : ''),
      remindTime: s.remindTime || (Number(s.remindMinutes) > 0 ? minutesToTime(s.remindMinutes) : ''),
      links: Array.isArray(s.links) ? s.links : s.url ? [{ url: s.url, label: '打开' }] : []
    }))
  }
  return migrated
}

// 班次多选匹配：wants 为规则勾选的班次列表（空 = 不限）
// 返回命中的显示标签（主班/副班/周末白班/单人班/…）；未命中返回 null
function matchShifts(wants, ctx) {
  // ctx: { today, shiftKey, person, onDuty, excludePerson, weekend }
  if (!wants.length) return ctx.shiftKey || '不限'
  // 「上班」判定按用户 2026-09-01 口径：班表里只要排了班，不管什么班次都算上班；
  // 只有休班不算（班表里留空 = 没排班 = 休班）。
  // 所以用黑名单（!== '休班'），不用 WORKING_SHIFTS 白名单——白名单会漏掉名单外的班次写法。
  const isOnDuty = ctx.shiftKey !== '休班'
  const hits = []
  for (const want of wants) {
    if (want === '所有上班的班次') {
      // 只看班表：不看周几、不看法定节假日。周末、国庆只要班表排了班就算上班。
      if (isOnDuty) hits.push(want)
    } else if (want === '工作日班') {
      // 两层都要满足：
      //   ① 今天是法定工作日（按国务院办公厅放假通知口径，含调休补班的周末）
      //   ② 班表里今天排了班
      if (isWorkingDay(ctx.today) && isOnDuty) hits.push(want)
    } else if (want === '单人班') {
      if (ctx.onDuty.includes(ctx.person) && isSingleShiftDay(ctx.today, ctx.onDuty, ctx.excludePerson)) hits.push(want)
    } else if (want === ctx.shiftKey) {
      hits.push(want)
    }
  }
  if (!hits.length) return null
  // 显示标签优先级：具体班次（主班/副班/…）> 单人班 > 组合选项（工作日班/所有上班的班次）
  const exact = hits.find((h) => SHIFT_KEYS.includes(h))
  if (exact) return exact
  if (hits.includes('单人班')) return '单人班'
  return hits[0]
}

// 判断「规则在 dayKey 当天按当前排班本应生成」——供孤儿自动任务清理对账用（2026-09-03 加）。
// 只校验频率维度（monthly 看 dom 是否命中 monthDays；weekly 看星期是否命中 weekdays，
// weekdays 为空 = 每天），不校验班次/是否在班：因为一条合法生成的任务的 dayKey 必然落在规则排班内，
// 只有「规则改过 / 历史某版频率判定有 bug 生成」的任务才会出现 dayKey 不在排班内的情况。
function shouldGenerateForDay(rule, dayKey) {
  if (!rule || !dayKey) return true
  if (rule.freq === 'monthly') {
    const md = rule.monthDays || []
    if (!md.length) return false // 配置异常：月频未选日期
    const d = new Date(`${dayKey}T00:00:00`)
    if (Number.isNaN(d.getTime())) return true
    const dom = d.getDate()
    const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    return md.some((x) => Math.min(Number(x) || 0, dim) === dom)
  }
  if (rule.freq === 'weekly') {
    const wds = Array.isArray(rule.weekdays) ? rule.weekdays : []
    if (!wds.length) return true // 每天
    return wds.includes(weekdayOf(dayKey))
  }
  return true
}

async function ensurePeriodicTasks(force = false) {
  if (genRunning) {
    genQueued = true
    return
  }
  genRunning = true
  try {
  // 生成审计日志（2026-09-05 加）：本轮每条规则×人的判定先入内存 buffer，结束后一次性写库，
  // 供事后回放「某条任务生成/未生成那一刻系统看到的完整上下文」，定位班次/频率不一致等异常。
  const auditBuffer = []
  const pushAudit = (entry) => auditBuffer.push({ ts: Date.now(), ...entry })
  const rawRules = (await db.settings.get('periodicDutyTasks'))?.value || []
  const rules = rawRules.map((r) => migrateRuleForGen(r))
  const active = rules.filter((r) => r.enabled && (r.title || '').trim())
  if (!active.length) return

  // 生成钟点门槛（2026-09-07 起按规则可配置：rule.genHour，默认 9）：
  // 某条规则「当前钟点 < 该规则 genHour」则本轮跳过该规则，并登记最早待触发时间，
  // 循环结束后为它挂一个到点定时器（下轮 ensurePeriodicTasks 重新判定并生成）。
  // force=true（手动「立即生成」）时跳过所有时间门槛，直接按当前规则生成。
  // 页面保持打开时定时器生效；关掉后下次打开也会按当前钟点重新判定。
  const nowDate = now.value
  const nowMs = nowDate.getTime()
  let pendingFireMs = Infinity

  const defaultId = await ensureDefaultProject()
  const today = todayKey.value
  const wd = weekdayOf(today)
  const me = ((await db.settings.get('currentPerson'))?.value || '').trim()
  const excludePerson = singleShiftExclude.value  // 已在 loadAll 中读取，避免重复 IO
  const todayRecords = duty.value.filter((d) => d.date === today)
  // 当天在班（非休班）人员名单，供「单人班」判定
  const onDuty = todayRecords
    .filter((d) => {
      // 留空 = 没排班 = 休班（与下方 rawShiftKey 口径保持一致）。
      // ⚠️ 必须显式判空：shiftKeyOf('') 返回的是「其他」而不是「休班」，
      //    不判空的话休班的人会被算进在班名单，导致「当天只有 1 人上班」永远判不出单人班。
      const k = String(d.shift || '').trim() ? shiftKeyOf(d.shift, today) : '休班'
      // 「其他」也要计入在班人数：系统认不出的班次写法，只要班表排了班就算在班
      // （用户 2026-09-02 确认口径）。否则这类写法会让单人班漏判。
      return k !== '休班' && (d.person || '').trim()
    })
    .map((d) => (d.person || '').trim())
  const existing = await db.tasks.toArray()
  // 本次调用内已生成的 (rule.id|person|today) 集合，防止同一人同一规则在一次循环里被多次插入
  const seen = new Set(existing.map((t) => `${t.autoRuleId}|${t.autoRulePerson}|${t.dayKey}`))
  const nowTs = Date.now()
  const nowMin = nowDate.getHours() * 60 + nowDate.getMinutes()
  let created = 0
  let skippedDueToPassedTrigger = false
  const reasons = new Set()

  // 当天基准时间戳（00:00:00）
  const todayBase = new Date(`${today}T00:00:00`).getTime()

  for (const rule of active) {
    // 生成钟点门槛（按规则）：未到该规则的 genHour 则跳过本轮，并登记最早待触发时间
    const gh = Number.isFinite(rule.genHour) ? rule.genHour : GEN_HOUR
    if (!force && nowDate.getHours() < gh) {
      const fireAt = new Date(nowDate)
      fireAt.setHours(gh, 0, 5, 0)
      const delta = fireAt.getTime() - nowMs
      if (delta > 0 && delta < pendingFireMs) pendingFireMs = delta
      reasons.add('未到生成钟点')
      pushAudit({ action: '跳过规则', ruleId: rule.id, ruleTitle: rule.title, dayKey: today, reason: `未到生成钟点(${gh}点)`, onDuty, excludePerson })
      continue
    }

    // ① 时间范围
    const dr = rule.dateRange || {}
    if (!dateInRange(today, dr.start, dr.end)) {
      reasons.add('不在日期范围')
      pushAudit({ action: '跳过规则', ruleId: rule.id, ruleTitle: rule.title, dayKey: today, reason: '不在日期范围', onDuty, excludePerson })
      continue
    }

    // ② 触发频率匹配
    if (rule.freq === 'monthly') {
      // 按月：匹配「日」维度。半月默认 15 号 + 月末；月末用 31 在 30 天月自动 clamp 到月末
      const td = new Date(`${today}T00:00:00`)
      const dom = td.getDate()
      const dim = new Date(td.getFullYear(), td.getMonth() + 1, 0).getDate()
      const hitMonth = (rule.monthDays || []).some((md) => {
        const target = Math.min(Number(md) || 0, dim)
        return dom === target
      })
      if (!hitMonth) {
        reasons.add('今天非指定日期')
        pushAudit({ action: '跳过规则', ruleId: rule.id, ruleTitle: rule.title, dayKey: today, reason: '今天非指定日期(monthly)', onDuty, excludePerson })
        continue
      }
    } else {
      // 按星期（不选 = 每天）
      const wds = Array.isArray(rule.weekdays) ? rule.weekdays : []
      if (wds.length && !wds.includes(wd)) {
        reasons.add('今天非指定星期')
        pushAudit({ action: '跳过规则', ruleId: rule.id, ruleTitle: rule.title, dayKey: today, reason: '今天非指定星期(weekly)', onDuty, excludePerson })
        continue
      }
    }

    // ②-b 目标项目：规则指定了 projectId 则优先使用；若该指定项目开启了自动子项目，
    // 则挂载到「今天」对应的周子项目下（需求 9+10）。否则回退默认项目。
    let targetProjectId = defaultId
    if (rule.projectId) {
      const proj = await db.projects.get(rule.projectId)
      if (proj && proj.autoChildren) {
        const wid = await resolveWeekProjectForDate(rule.projectId, today)
        if (wid) targetProjectId = wid
      } else if (proj) {
        targetProjectId = proj.id
      }
    }

    // ③ 人员：规则指定多人员，未指定则用「当前用户」
    const persons = Array.isArray(rule.persons) && rule.persons.length ? rule.persons : rule.person ? [rule.person] : me ? [me] : []
    if (!persons.length) {
      reasons.add('未指定人员且未设置当前用户')
      continue
    }

    // 兼容旧规则的单链接 url/urlLabel
    const ruleLinks = Array.isArray(rule.links)
      ? rule.links
      : rule.url
        ? [{ url: rule.url, label: rule.urlLabel || '打开' }]
        : []

    for (const who of persons) {
      const person = who.trim()
      if (!person) continue

      // ④ 班次：查当天排班；查不到记录 = 休班。
      // 先取原始班次，再用「今日是否单人班」校正为有效班次（单人班 > 原始 key），
      // 避免单人班日仍以「主班/副班」名义触发或生成。
      const rec = todayRecords.find((d) => (d.person || '').includes(person))
      // 有记录但班次留空 = 没排班 = 休班（用户班表里不写「休」字，留空即休班）。
      // 不能让 shiftKeyOf('') 落到「其他」，否则 matchShifts 的黑名单（!== '休班'）会把它误判成上班。
      const rawShiftKey = rec && String(rec.shift || '').trim() ? shiftKeyOf(rec.shift, today) : '休班'
      // 「其他」也参与单人班校正（同上：班表排了班就算在班，不该被排除）
      const isSingle = rawShiftKey !== '休班' && isSingleShiftDay(today, onDuty, excludePerson)
      const shiftKey = isSingle ? '单人班' : rawShiftKey
      const matchedShift = matchShifts(rule.shifts || [], {
        today,
        shiftKey,
        person,
        onDuty,
        excludePerson,
        weekend: isWeekend(today)
      })
      if (!matchedShift) {
        reasons.add(rec ? `班次未匹配(${shiftKey})` : '排班表未导入/当天无排班')
        pushAudit({ action: '跳过', ruleId: rule.id, ruleTitle: rule.title, person, dayKey: today, reason: rec ? `班次未匹配(${shiftKey})` : '排班表未导入/当天无排班', onDuty, excludePerson, rawShiftKey, isSingle, shiftKey, matched: null })
        continue
      }

      // 去重：同一规则 + 同一天 + 同一人员只生成一次（同时查已落盘 existing 与本次调用内已插入 seen）
      const dedupKey = `${rule.id}|${person}|${today}`
      const already =
        seen.has(dedupKey) ||
        existing.some(
          (t) =>
            t.dayKey === today &&
            t.autoRuleId === rule.id &&
            (t.autoRulePerson === person || (t.remark || '').includes(person))
        )
      if (already) {
        reasons.add('今日已生成')
        pushAudit({ action: '跳过', ruleId: rule.id, ruleTitle: rule.title, person, dayKey: today, reason: '今日已生成(去重)', onDuty, excludePerson, rawShiftKey, isSingle, shiftKey, matched: matchedShift })
        continue
      }

      // ⑥ 触发时间是否已过：规则里的提醒/完成时间已早于当前时间（按分钟）。
      // 修正：任务当天仍要生成（不能因为"提醒时间已过"就整条不生成）；
      // 仅当时间已过时不排未来提醒，避免无效提醒轰炸。
      const triggerMin = timeToMinutes(rule.remindTime) || timeToMinutes(rule.dueTime)
      let shouldRemind = true
      if (triggerMin > 0 && triggerMin < nowMin) {
        shouldRemind = false
        reasons.add('提醒/截止时间已过（仍生成任务）')
      }

      // ⑤ 完成时限 / 提醒时间：基于当天 00:00 的具体时间
      const dueMinutes = timeToMinutes(rule.dueTime)
      const remindMinutes = timeToMinutes(rule.remindTime) || dueMinutes
      const followUpAt = todayBase + dueMinutes * 60000
      const nextRemindAt = shouldRemind ? todayBase + remindMinutes * 60000 : 0

      await db.tasks.add({
        title: rule.title,
        projectId: targetProjectId,
        quadrant: rule.quadrant || 'noturgent-important',
        status: '待办',
        followUpAt,
        nextRemindAt,
        dayKey: today,
        remark: rule.remark
          ? `自动生成 · ${person} · ${matchedShift}生成\n${rule.remark}`
          : `自动生成 · ${person} · ${matchedShift}生成`,
        links: ruleLinks,
        autoRuleId: rule.id,
        autoRulePerson: person,
        autoRuleShift: matchedShift,
        docOutput: !!rule.docOutput,
        // 子任务条目：规则里配置的多条独立工作事项，含各自截止时间/提醒/链接，生成当天任务时一并带入（每天一份快照）
        subtasks: (rule.subtasks || [])
          .filter((s) => (s.text || '').trim())
          .map((s) => ({
            id: s.id || String(Date.now()) + Math.random().toString(36).slice(2),
            text: s.text.trim(),
            done: false,
            dueTime: s.dueTime || '',
            remindTime: s.remindTime || '',
            links: Array.isArray(s.links)
              ? s.links.filter(Boolean)
              : s.url
                ? [{ url: s.url, label: '打开' }]
                : []
          })),
        createdAt: nowTs
      })
      seen.add(dedupKey)
      created++
      pushAudit({ action: '生成', ruleId: rule.id, ruleTitle: rule.title, person, dayKey: today, reason: '正常生成', onDuty, excludePerson, rawShiftKey, isSingle, shiftKey, matched: matchedShift, followUpAt, nextRemindAt })
    }
  }
  // 为尚未到达生成钟点的规则挂一个最早到点定时器（下轮 ensurePeriodicTasks 重新判定并生成）
  if (pendingFireMs !== Infinity && !genTimer) {
    genTimer = setTimeout(() => {
      genTimer = null
      ensurePeriodicTasks()
    }, Math.max(1000, pendingFireMs))
  }

  // 清理历史遗留的重复自动任务：同一 (规则+人+天) 仅保留最早一条，避免「今天要处理」出现重复项
  const byKey = new Map()
  for (const t of existing) {
    if (!t.autoRuleId) continue
    const k = `${t.autoRuleId}|${t.autoRulePerson}|${t.dayKey}`
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(t)
  }
  let pruned = false
  for (const group of byKey.values()) {
    if (group.length > 1) {
      group.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      for (const dup of group.slice(1)) {
        pushAudit({ action: '清理重复', ruleId: dup.autoRuleId, ruleTitle: dup.title, person: dup.autoRulePerson, dayKey: dup.dayKey, reason: '同日同规则同人重复', taskId: dup.id })
        await db.tasks.delete(dup.id)
        pruned = true
      }
    }
  }

  // 清理孤儿自动任务：规则仍存在、但其 dayKey 当天按规则「当前排班」本不该生成的自动任务。
  // 根因（2026-09-03）：历史上某版 ensurePeriodicTasks 频率判定有 bug，把月任务 / 特定星期任务
  // 无视排班也生成了（如 9/2 出现了 [15,31]、[1,5,9]、周二规则的孤儿任务），或规则后来被改过；
  // 这些已落库任务从没被清理，且因 followUpAt 早已过期而永久显示「逾期」。
  // 这里对账清理，使自动任务与规则当前排班保持一致；规则已删除的任务保守不在此清理，避免误删历史。
  let cleanedOrphans = false
  for (const t of existing) {
    if (!t.autoRuleId) continue
    const r = rules.find((x) => x.id === t.autoRuleId)
    if (!r) continue // 规则已删：不在此清理
    if (shouldGenerateForDay(r, t.dayKey)) continue // 仍符合排班：保留
    console.warn('[ensurePeriodicTasks] 清理孤儿自动任务:', { id: t.id, title: t.title, dayKey: t.dayKey, rule: r.title })
    pushAudit({ action: '清理孤儿', ruleId: t.autoRuleId, ruleTitle: r.title, person: t.autoRulePerson, dayKey: t.dayKey, reason: '频率与当前排班不符', taskId: t.id })
    await db.tasks.delete(t.id)
    cleanedOrphans = true
  }

  // 本轮生成审计日志一次性落库（保留最近 200 条，超出丢最旧）
  if (auditBuffer.length) {
    try {
      const log = (await db.settings.get('genAuditLog'))?.value || []
      const merged = [...log, ...auditBuffer]
      if (merged.length > 200) merged.splice(0, merged.length - 200)
      await db.settings.put({ key: 'genAuditLog', value: merged })
    } catch (e) {
      console.warn('[genAudit] 日志写入失败', e)
    }
  }

  if (created || pruned || cleanedOrphans) await loadAll()

  // 若有因「触发时间已过」而跳过的规则，预约次日早 9 点重新生成；跨天后 todayKey 自然刷新，再执行生成
  if (skippedDueToPassedTrigger && !genTimer) {
    const next = new Date(nowDate)
    next.setDate(next.getDate() + 1)
    next.setHours(GEN_HOUR, 0, 5, 0)
    genTimer = setTimeout(() => {
      genTimer = null
      ensurePeriodicTasks()
    }, Math.max(1000, next.getTime() - nowDate.getTime()))
  }
  } finally {
    genRunning = false
    if (genQueued) {
      genQueued = false
      ensurePeriodicTasks(force)
    }
  }
}

/* ---------- 近 7 日完成趋势（内联 SVG 折线） ---------- */
const trendData = computed(() => {
  const arr = []
  for (let i = 6; i >= 0; i--) {
    const s = todayStart.value - i * DAY
    const e = s + DAY
    const c = tasks.value.filter(
      (t) => t.status === '已完成' && (t.completedAt || 0) >= s && (t.completedAt || 0) < e
    ).length
    arr.push({ label: `${new Date(s).getMonth() + 1}/${new Date(s).getDate()}`, value: c })
  }
  return arr
})
const trendMax = computed(() => Math.max(1, ...trendData.value.map((d) => d.value)))
// 折线路径：宽 280、高 60，左右各留 8px
const trendPath = computed(() => {
  const w = 280
  const h = 60
  const pad = 8
  const step = (w - pad * 2) / Math.max(1, trendData.value.length - 1)
  return trendData.value
    .map((d, i) => {
      const x = pad + i * step
      const y = h - 6 - (d.value / trendMax.value) * (h - 16)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})
const trendArea = computed(() => {
  if (!trendPath.value) return ''
  const w = 280
  const h = 60
  const pad = 8
  return `${trendPath.value} L${w - pad},${h} L${pad},${h} Z`
})

/* ---------- 今日值班 ---------- */
// dutyOffset：值班显示日期相对今日的偏移；0=今日，1=转天，-1=昨天，依此类推
const dutyOffset = ref(0)

// 拼接 ymd(N 天后)
function ymdOffset(offset) {
  const d = new Date(todayStart.value + offset * DAY)
  return ymd(d.getTime())
}

// 顶部值班显示用：移除括号时段和多余文字说明，仅保留「姓名+班次」。
// 排版为两排：每个值班人独占一行，整体更紧凑（只做显示层转换，不改排班规则）。
const dutyTopbar = computed(() => {
  const targetKey = ymdOffset(dutyOffset.value)
  const recs = duty.value
    .filter((d) => d.date === targetKey)
    .filter((d) => {
      // 留空 = 休班，不显示（与 onDuty 口径一致）。
      // ⚠️ 必须显式判空：shiftKeyOf('') 返回「其他」，不判空的话休班的人也会出现在值班条。
      const k = String(d.shift || '').trim() ? shiftKeyOf(d.shift, d.date) : '休班'
      // 「其他」也显示：班表排了班就该出现在顶部值班条
      return k !== '休班'
    })
  return recs.map((d) => {
    const key = shiftKeyOf(d.shift, d.date)
    const names = recs.map((r) => r.person)
    const single = isSingleShiftDay(d.date, names, singleShiftExclude.value)
    return {
      person: d.person,
      // 单人班时覆盖原班次名；否则只保留主班/副班/周末白班，不带括号时段
      label: single ? '单人班' : key
    }
  })
})

// 当前值班显示日期的短文本（如「今日 8/22」「转天 8/23」「8/24」）
const dutyHeaderText = computed(() => {
  const d = new Date(todayStart.value + dutyOffset.value * DAY)
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  if (dutyOffset.value === 0) return `今日 ${md}`
  if (dutyOffset.value === 1) return `转天 ${md}`
  if (dutyOffset.value === -1) return `昨天 ${md}`
  return md
})

// 「转天/今日」切换按钮的文案与切换动作
const nextDutyLabel = computed(() => (dutyOffset.value === 0 ? '转天' : '今日'))
function toggleDutyDay() {
  dutyOffset.value = dutyOffset.value === 0 ? 1 : 0
}
// 把值班显示拉回今日（用于跨日后自动复位）
watch(todayKey, () => {
  dutyOffset.value = 0
})
// 排班表（duty）导入/变更后，重新尝试自动生成：避免「排班未导入时打开→永远不生成」的死局
watch(duty, () => {
  ensurePeriodicTasks()
})

/* ---------- 最近笔记 ---------- */
const recentNotes = computed(() =>
  notes.value
    .slice()
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    .slice(0, 4)
)
// 点击某条最近笔记：跳转到该笔记的编辑态（而非仅跳知识库列表）
function openRecentNote(n) {
  emit('goto', 'notes', { noteId: n.id })
}

/* ---------- 快捷方式 ---------- */
const ICON_SVGS = {
  mail: 'M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6zm2 0l8 5 8-5H4zm0 2v10h16V8l-8 5-8-5z',
  board: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5zm4 10V7H5v8h2zm5-6H8v6h4V9zm5 3h-3v3h3v-3z'
}
function iconOf(s) {
  if (s.icon && s.icon.startsWith('data:image')) return { type: 'img', value: s.icon }
  if (s.icon && ICON_SVGS[s.icon]) return { type: 'svg', value: ICON_SVGS[s.icon] }
  if (s.icon) return { type: 'text', value: s.icon.slice(0, 2) }
  const m = /^https?:\/\/([^/]+)/i.exec(s.url || '')
  if (m) return { type: 'img', value: `https://www.google.com/s2/favicons?domain=${m[1]}&sz=64` }
  return { type: 'text', value: s.name ? s.name.slice(0, 1) : '·' }
}
function openShortcut(s) {
  if (s.url) openExternal(s.url, browserForLink(s))
}
// link 既可以是 { url, label, browser } 对象，也可以是裸字符串（老调用点）
function handleLinkClick(link, ev) {
  if (ev) ev.preventDefault()
  const l = (link && typeof link === 'object') ? link : { url: link }
  openExternal(l.url, browserForLink(l))
}

/* 快捷入口可配置：增删改 */
const editingShortcuts = ref(false)
const editingShortcutId = ref(null)
const newShortcut = reactive({ name: '', url: '', icon: '', browser: '' })
// 「用哪个浏览器打开」下拉可选（第 43 轮）：空 id = 跟随设置中心里的全局默认
const browserOptions = ref([])
async function refreshBrowserOptions() {
  try {
    await loadBrowserPrefs()
    browserOptions.value = getBrowserList()
  } catch (e) {
    browserOptions.value = []
  }
}
function resetShortcutForm() {
  newShortcut.name = ''
  newShortcut.url = ''
  newShortcut.icon = ''
  newShortcut.browser = ''
  editingShortcutId.value = null
}
function editShortcut(s) {
  if (!editingShortcuts.value) return
  editingShortcutId.value = s.id
  newShortcut.name = s.name || ''
  newShortcut.url = s.url || ''
  newShortcut.icon = s.icon || ''
  newShortcut.browser = s.browser || ''
}
async function saveShortcut() {
  const name = newShortcut.name.trim()
  // 第 42 轮：本地路径若被写成长 `https://"C:\…"` 会被当成网页，点击永远打不开 ⇒ 先剥壳
  const url = localPathOf(newShortcut.url) || newShortcut.url.trim()
  const icon = newShortcut.icon.trim()
  if (!name || !url) return
  const patch = { name, url, icon, browser: (newShortcut.browser || '').trim() }
  if (editingShortcutId.value != null) {
    await db.shortcuts.update(editingShortcutId.value, patch)
  } else {
    await db.shortcuts.add(patch)
  }
  resetShortcutForm()
  await loadAll()
}
async function removeShortcut(id) {
  await db.shortcuts.delete(id)
  if (editingShortcutId.value === id) resetShortcutForm()
  await loadAll()
}
function toggleEditShortcuts() {
  editingShortcuts.value = !editingShortcuts.value
  if (!editingShortcuts.value) resetShortcutForm()
  // 进入配置态时刷新浏览器下拉（可能刚在设置中心改过清单）
  else refreshBrowserOptions()
}

async function onProjectsChanged() {
  showProjMgr.value = false
  await loadAll()
  // 项目管理里可能删了项目（删除是级联的，会连整棵子树一起删）⇒ 若当前筛选的项目已不存在，
  // 必须清掉筛选；否则任务列表会按一个「已删项目的 id」过滤，整页显示成空的。
  if (
    selectedProjectId.value != null &&
    !projects.value.some((p) => p.id === selectedProjectId.value)
  ) {
    selectedProjectId.value = null
  }
}
</script>

<template>
  <div class="ov">
    <!-- 顶部问候条 -->
    <div class="hero panel">
      <div class="hero-left">
        <div class="hero-left-text">
          <div class="hero-greet">{{ greeting }}</div>
          <div class="hero-date muted">{{ dateText }}</div>
        </div>
        <div class="hero-duty" v-if="dutyTopbar.length">
          <!--
            单 grid 容器统一列宽：所有值班行参与列宽计算，
            「姓名」列按最宽那行对齐，「按钮」列垂直贴右一致。
            第 1 行（通常「主班」）：放「日程」按钮
            第 2 行（通常「副班/周末白班」，单人班时也显示）：放「转天/今日」按钮
          -->
          <div class="duty-rows">
            <div class="duty-names">
              <div
                v-for="(d, i) in dutyTopbar"
                :key="`${dutyOffset}-${i}`"
                class="duty-name"
              >{{ d.person }}（<span class="shift">{{ d.label }}</span>）</div>
            </div>
            <div class="duty-actions">
              <button
                class="ghost xs duty-btn"
                @click="emit('goto', 'duty')"
                title="查看历史 / 未来值班"
              >日程</button>
              <button
                class="ghost xs duty-btn"
                :class="{ 'is-offset': dutyOffset !== 0 }"
                @click="toggleDutyDay"
                :title="dutyOffset === 0 ? '查看明天值班' : '返回今日'"
              >{{ nextDutyLabel }}</button>
            </div>
          </div>
        </div>
        <div class="hero-notes" v-if="recentNotes.length">
          <div class="hn-list">
            <div v-for="n in recentNotes.slice(0, 2)" :key="n.id" class="hn-row">
              <span class="hn-item" @click="openRecentNote(n)" :title="n.title">{{ n.title }}</span>
            </div>
          </div>
          <button class="hn-kb-btn" @click="emit('goto', 'notes')" title="打开知识库">笔记</button>
        </div>
      </div>
      <div class="hero-right">
        <div class="hero-badge" :class="{ danger: overdueCount > 0 }">
          <span class="hb-num">{{ todoToday.length }}</span>
          <span class="hb-txt">{{ overdueCount > 0 ? `待处理（${overdueCount} 项逾期）` : '项待处理' }}</span>
        </div>
      </div>
    </div>

    <!-- 主体两栏 -->
    <div class="ov-grid">
      <!-- 左：今天要处理 -->
      <section class="panel ov-todo">
        <div class="sec-head">
          <div>
            <div class="sec-title">今天要处理</div>
            <div v-if="selectedProjectId" class="muted">已筛选：{{ selectedProjectName }}</div>
          </div>
          <div class="sec-actions">
            <button v-if="selectedProjectId" class="ghost sm filter-chip" @click="selectedProjectId = null">
              <span class="dot" :style="{ background: projects.find(p => p.id === selectedProjectId)?.color || 'var(--primary)' }"></span>
              {{ selectedProjectName }}
              <svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
            <button class="ghost sm quick-add-btn" title="在总览页直接新增任务" @click="openQuickAdd">
              <span>新增</span>
            </button>
            <button class="ghost sm" @click="emit('goto', 'tasks')">全部任务</button>
          </div>
        </div>

        <div class="todo-body">
          <div v-if="!todoToday.length" class="empty-box muted">
            今天没有待处理事项，休息一下 ☕
          </div>
          <ul v-else class="todo-list">
            <li v-for="t in todoToday" :key="t.id" class="todo-item" :class="t.bucket">
              <button class="tick" :title="hasSubs(t) ? '完成整个任务集合' : '标记完成'" @click.stop="completeCollection(t)">
                <svg viewBox="0 0 24 24" width="14" height="14">
                  <path d="M5 12l5 5 9-10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <div class="todo-main">
                <div class="todo-top">
                  <div class="todo-title-wrap">
                    <div class="todo-title" :title="t.title">{{ t.title }}</div>
                    <div v-if="t.remark" class="todo-remark" :title="t.remark">{{ stripAutoGenPrefix(t.remark) }}</div>
                    <div class="todo-meta">
                      <span :class="['due', t.bucket]">{{ fmtDue(t.due) }}</span>
                      <!-- 四象限分类挂在集合（父任务）这一行 -->
                      <span v-if="t.quadrant" class="sub-quad" :style="{ background: quadColor(t.quadrant) }">{{ QUAD_SHORT[t.quadrant] || '' }}</span>
                      <!-- 含子任务时逾期标下移到子任务行；无子任务才在主行显示 -->
                      <span v-if="!hasSubs(t) && t.bucket === 'overdue'" class="badge-over">逾期</span>
                      <span v-if="t.autoRuleId" class="badge-auto" :title="t.autoRuleShift ? `由自动化规则生成 · 匹配班次：${t.autoRuleShift}` : '由自动化规则生成'">{{ t.autoRuleShift ? t.autoRuleShift + '·自动' : '自动' }}</span>
                      <span v-if="hasSubs(t)" class="sub-progress">{{ doneCount(t) }}/{{ t.subtasks.length }}</span>
                    </div>
                  </div>
                  <!-- 主任务链接：仅无子任务时显示（含子任务时链接在子任务上） -->
                  <div v-if="allLinks(t).length && !hasSubs(t)" class="todo-links">
                    <a v-for="(u, ui) in allLinks(t)" :key="ui" class="ghost sm todo-link" :href="u.url" target="_blank" rel="noopener" :title="u.url" @click.prevent.stop="handleLinkClick(u, $event)">
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>
                      {{ u.label }}
                    </a>
                  </div>
                </div>
                <!-- 子任务层级：缩进展示，可独立勾选；每个子任务同行有逾期标 / 链接 / 推迟 -->
                <ul v-if="hasSubs(t)" class="todo-subs">
                  <li v-for="(s, si) in t.subtasks" :key="s.id || si" class="todo-sub" :class="{ done: s.done, overdue: subOverdue(s, t) }">
                    <label class="sub-check">
                      <input type="checkbox" :checked="!!s.done" @change="toggleSubDone(t, s)" />
                      <span>{{ s.text }}</span>
                    </label>
                    <span v-if="subOverdue(s, t)" class="badge-over sm">逾期</span>
                    <span class="sub-actions">
                      <span v-if="allLinksOfSub(s).length" class="sub-link-group">
                        <a v-for="(u, ui) in allLinksOfSub(s)" :key="ui" class="sub-link" :href="u.url" target="_blank" rel="noopener" :title="u.url" @click.prevent.stop="handleLinkClick(u, $event)">{{ u.label }}↗</a>
                      </span>
                      <button class="ghost sm" @click="snoozeTask(t.id, 60)" title="推迟此任务">推迟</button>
                    </span>
                  </li>
                </ul>
              </div>
            </li>
          </ul>
        </div>
      </section>

      <!-- 右：3D 项目堆叠 -->
      <section class="panel ov-proj">
        <ProjectStack
          :projects="projects"
          :tasks="tasks"
          @select="selectedProjectId = $event"
          @open="(id) => emit('goto', 'tasks', { projectId: id })"
          @manage="showProjMgr = true"
        />
      </section>
    </div>

    <!-- 次级三栏 -->
    <!-- 快捷方式 -->
    <section v-if="shortcuts.length || editingShortcuts" class="panel ov-shortcuts">
      <div class="sec-head">
        <div class="sec-title">快捷入口</div>
        <button class="ghost sm" @click="toggleEditShortcuts">
          {{ editingShortcuts ? '完成' : '配置' }}
        </button>
      </div>

      <div v-if="editingShortcuts" class="sc-edit-bar">
        <input v-model="newShortcut.name" class="sc-input" placeholder="名称" @keyup.enter="saveShortcut" />
        <VoiceInput v-model="newShortcut.name" />
        <input v-model="newShortcut.icon" class="sc-input" style="max-width: 140px" placeholder="图标（emoji / mail / board）" @keyup.enter="saveShortcut" />
        <input v-model="newShortcut.url" class="sc-input" placeholder="链接 URL 或本地路径（D:\xxx\a.exe）" @keyup.enter="saveShortcut" />
        <!-- 第 43 轮：单条快捷入口也能指定浏览器（默认 = 跟随设置中心里的全局默认） -->
        <select v-model="newShortcut.browser" class="sc-select" title="这条链接用哪个浏览器打开（默认 = 跟随设置中心「浏览器与打开方式」里的全局默认）">
          <option value="">默认浏览器</option>
          <option v-for="b in browserOptions" :key="b.id" :value="b.id">{{ b.name || b.exe }}</option>
        </select>
        <button class="primary sm" @click="saveShortcut">{{ editingShortcutId != null ? '保存修改' : '+ 添加' }}</button>
        <button v-if="editingShortcutId != null" class="ghost sm" @click="resetShortcutForm">取消</button>
      </div>

      <div class="sc-grid">
        <div v-for="s in shortcuts" :key="s.id" class="sc-cell" :class="{ active: editingShortcuts && editingShortcutId === s.id }">
          <button class="sc-item" @click="editingShortcuts ? editShortcut(s) : openShortcut(s)" :title="editingShortcuts ? '点击编辑 ' + s.name : s.url">
            <span class="sc-ico">
              <img v-if="iconOf(s).type === 'img'" :src="iconOf(s).value" alt="" />
              <svg v-else-if="iconOf(s).type === 'svg'" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <path :d="iconOf(s).value" />
              </svg>
              <span v-else>{{ iconOf(s).value }}</span>
            </span>
            <span class="sc-label">{{ s.name }}</span>
          </button>
          <button v-if="editingShortcuts" class="sc-del" :title="'删除 ' + s.name" @click.stop="removeShortcut(s.id)">
            <span class="sc-del-x">×</span>
          </button>
        </div>
      </div>

      <div v-if="!shortcuts.length && editingShortcuts" class="muted" style="font-size:12px;padding:8px 2px;">
        暂无快捷入口，在上方添加即可
      </div>
    </section>

    <!-- 总览页内快捷新增任务：不跳转，复用 TaskFormModal 公共组件（与任务管理字段一致） -->
    <TaskFormModal
      :show="showQuickAdd"
      :projects="projects"
      :editing-id="null"
      :initial-data="formInitial"
      @update:show="showQuickAdd = $event"
      @submit="onQuickSubmit"
    />

    <ProjectManager v-if="showProjMgr" :tasks="tasks" @close="showProjMgr = false" @changed="onProjectsChanged" />
  </div>
</template>

<style scoped>
/* 总览页快捷新增任务弹窗 */
.quick-add-modal { max-width: 460px; }
.qa-label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
.qa-input { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font-size: 14px; font-family: inherit; }
.qa-row { display: flex; gap: 10px; }
.qa-col { flex: 1; min-width: 0; }
.qa-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.ov {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden; /* 总览整体不出现上下滚动条，内容不足时面板内部自行滚动 */
}

/* ---------- Hero ---------- */
.hero {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  background: var(--panel);
}
.hero-greet {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--text);
}
.hero-date {
  margin-top: 4px;
  font-size: 13px;
  color: var(--muted);
}
.hero-left {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex: 1;
  min-width: 0;
}
.hero-left-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex-shrink: 0;
}
.hero-duty-btn {
  margin-top: 4px;
  padding: 4px 10px;
  font-size: 12px;
}
.hero-badge {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 18px;
  border-radius: var(--radius);
  background: var(--panel-2);
  color: var(--primary);
  white-space: nowrap;
  border: 1px solid var(--border);
  box-shadow: inset 0 1px rgba(255, 255, 255, .05), 0 4px 14px rgba(0, 0, 0, .1);
}
.hero-badge.danger {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: rgba(255, 108, 112, .25);
  box-shadow: 0 0 18px rgba(255, 108, 112, .15);
}
.hb-num {
  font-size: 28px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.hb-txt {
  font-size: 12px;
}
.hero-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.hero-duty {
  display: inline-flex;
  align-items: stretch;
  gap: 10px;
  padding: 10px 18px;
  border-radius: var(--radius);
  background: hsl(158 58% 43% / 0.10);
  color: var(--text);
  font-size: 14px;
  line-height: 1.55;
  border: 1px solid hsl(158 58% 43% / 0.22);
}
/* 顶部值班区：姓名列 + 操作列（日程 / 转天·今日），两列左对齐、操作列贴右 */
.hero-duty .duty-rows {
  display: flex;
  align-items: center;
  gap: 14px;
}
.hero-duty .duty-names {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hero-duty .duty-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
}
.hero-duty .duty-name {
  font-weight: 500;
}
.hero-duty .duty-name .shift {
  font-weight: 600;
}
.hero-duty .duty-btn {
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 999px;
}
.hero-duty .duty-btn.is-offset {
  background: hsl(158 58% 43% / 0.22);
  font-weight: 600;
  border-color: hsl(158 58% 43% / 0.45);
  color: var(--text);
}
/* hero 内「最近笔记」小卡：值班右侧。左侧=笔记标题列表(可跳编辑)，右侧=单一「笔记」按钮(跳知识库)，两个冗余按钮已合并为一个 */
.hero-notes {
  display: flex;
  flex-direction: row;
  align-items: center;
  align-self: stretch; /* 与左侧值班信息框等高（值班框为最高项，自身高度不变） */
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius);
  background: var(--panel-2);
  border: 1px solid var(--border);
  min-width: 200px;
  max-width: 280px;
}
.hero-notes .hn-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
}
.hero-notes .hn-row {
  display: flex;
  align-items: center;
}
.hero-notes .hn-item {
  flex: 1;
  min-width: 0;
  /* 与 .hero-duty .duty-name 同字号（继承 .hero 的 14px）与字重 500，对齐显示 */
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.hero-notes .hn-item:hover {
  color: var(--primary);
}
.hero-notes .hn-kb-btn {
  flex: none;
  align-self: center;
  font-size: 11px;
  line-height: 1;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel-solid);
  color: var(--muted);
  cursor: pointer;
  transition: color .15s, border-color .15s, background .15s;
  white-space: nowrap;
}
.hero-notes .hn-kb-btn:hover {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-soft);
}

/* ---------- 主体网格 ---------- */
.ov-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr); /* 单行撑满 .ov-grid 高度，使两栏向下填充至快捷入口 */
  gap: 14px;
  flex: 1 1 auto;
  min-height: 0;
}
.ov-grid3 {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}
.sec-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 12px;
  gap: 8px;
}
.sec-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel-2);
}
.filter-chip .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.sec-title {
  font-size: 15px;
  font-weight: 600;
}
/* 自动生成结果摘要：解释「为什么没生成预设」，避免用户以为功能失效 */
.gen-summary {
  font-size: 11px;
  margin-top: 3px;
  color: var(--primary);
}
.gen-summary.warn {
  color: #d97706;
}
.empty-box {
  padding: 22px 0;
  text-align: center;
  font-size: 13px;
}

/* ---------- 待办列表 ---------- */
.ov-todo,
.ov-proj {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: auto;
  overflow: hidden; /* 配合内部 .todo-body / .stack-wrap 的 overflow-y:auto，仅内部滚动 */
}
.ov-proj :deep(.stack-wrap) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
.todo-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
.todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.todo-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  border-left: 3px solid transparent;
}
.todo-item.overdue {
  border-left-color: var(--danger);
  background: var(--danger-soft);
}
.tick {
  width: 22px;
  height: 22px;
  min-width: 22px;
  border-radius: 50%;
  border: 1.5px solid var(--border-strong);
  background: var(--panel-solid);
  color: transparent;
  display: grid;
  place-items: center;
  padding: 0;
  flex: none;
}
.tick:hover {
  border-color: var(--success);
  color: var(--success);
  background: var(--success-soft);
}
.tick svg {
  pointer-events: none;
}
.todo-main {
  flex: 1;
  min-width: 0;
}
.badge-auto {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary);
  font-weight: 600;
}
.todo-link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  text-decoration: none;
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 4px 9px;
  font-size: 12px;
  color: var(--primary);
  background: var(--panel-solid);
}
.todo-link:hover {
  background: var(--primary-soft);
  border-color: var(--primary);
}
.todo-top {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
}
.todo-title-wrap {
  flex: 1;
  min-width: 0;
}
.todo-title {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.todo-remark {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
  word-break: break-word;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.todo-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  flex-wrap: wrap;
}
.due {
  font-size: 11px;
  color: var(--muted);
}
.due.overdue {
  color: var(--danger);
  font-weight: 600;
}
.badge-over {
  font-size: 10px;
  background: var(--danger);
  color: #fff;
  border-radius: 999px;
  padding: 1px 6px;
}
.badge-over.sm {
  font-size: 9px;
  padding: 0 5px;
  line-height: 16px;
}
.sub-progress {
  font-size: 10px;
  color: var(--muted);
  background: var(--panel-2);
  border-radius: 999px;
  padding: 1px 7px;
}
.sub-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
/* ---------- 今天要处理：子任务层级 + 多链接 ---------- */
.todo-subs {
  list-style: none;
  margin: 6px 0 0;
  padding: 6px 0 0;
  border-top: 1px dashed var(--border);
  display: grid;
  gap: 4px;
}
.todo-sub {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-left: 6px;
  font-size: 12.5px;
}
.todo-sub.done > .sub-check > span {
  color: var(--muted);
  text-decoration: line-through;
}
.todo-sub.overdue > .sub-check > span {
  color: var(--danger);
}
.sub-check {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  flex: 1;
  min-width: 0;
}
.sub-check input[type='checkbox'] {
  width: 14px;
  height: 14px;
  flex: none;
  accent-color: var(--primary);
}
.sub-quad {
  flex: none;
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  color: #fff;
  font-weight: 600;
}
.sub-link {
  flex: none;
  font-size: 11px;
  color: var(--primary);
  text-decoration: none;
  font-weight: 600;
}
.sub-link:hover { text-decoration: underline; }
.sub-link-group {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
}
.todo-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  flex: none;
  margin-top: 1px;
}

/* ---------- 趋势图 ---------- */
.trend-svg {
  width: 100%;
  height: 70px;
  display: block;
}
.trend-axis {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
}
.ta-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}
.ta-item b {
  font-size: 12px;
  font-weight: 600;
}
.ta-item i {
  font-size: 10px;
  color: var(--muted);
  font-style: normal;
}

/* ---------- 值班 / 笔记 ---------- */
.duty-list,
.note-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.duty-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  font-size: 13px;
}
.duty-person {
  font-weight: 600;
}
.duty-shift {
  font-size: 12px;
  color: var(--muted);
}
.note-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
}
.note-item:hover {
  background: var(--panel-2);
}
.note-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary);
  flex: none;
}
.note-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 快捷方式 ---------- */
.sc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 108px));
  gap: 10px;
  justify-items: center;
}
.sc-item {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 12px 8px;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  border: 1px solid var(--border);
}
.sc-item:hover {
  border-color: var(--primary);
  background: var(--primary-soft);
}
.sc-ico {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  font-size: 20px;
}
.sc-ico img {
  width: 26px;
  height: 26px;
  object-fit: contain;
}
.sc-label {
  font-size: 12px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 配置态：单元格包一层，右上角删除 */
.sc-cell {
  position: relative;
  display: flex;
  justify-content: center;
  width: 100%;
}
.sc-cell.active .sc-item {
  border-color: var(--primary);
  background: var(--primary-soft);
}
.sc-del {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--panel-solid);
  color: var(--muted);
  cursor: pointer;
  z-index: 3;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.sc-del-x {
  font-size: 16px;
  line-height: 1;
  transform: translateY(-1px);
}
.sc-del:hover {
  color: #fff;
  background: var(--danger);
  border-color: var(--danger);
}
.sc-edit-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
  align-items: center;
}
.sc-input {
  flex: 1;
  min-width: 120px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--panel-solid);
  color: var(--text);
  font-size: 13px;
}
.sc-input:focus {
  outline: none;
  border-color: var(--primary);
}
/* 第 43 轮：快捷入口的「用哪个浏览器打开」下拉（不进 flex:1，固定宽度，别把 URL 输入挤没） */
.sc-select {
  flex: none;
  width: 116px;
  padding: 8px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--panel-solid);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}
.sc-select:focus {
  outline: none;
  border-color: var(--primary);
}

/* ---------- 响应式 ---------- */
@media (max-width: 1180px) {
  .ov-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 768px) {
  .hero {
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-start !important; /* 覆盖桌面 space-between，避免三块内容被推到面板两端留空白 */
    flex-wrap: wrap;
    gap: 12px;
  }
  /* hero-left 内部也列向化：greet/date + duty + notes 三个子项各占一行，
     避免在 ≤768 屏上被横排列压在 ≤200px 宽的窄条里互相"挡"（之前用户看到的"笔记卡挤右上"
     "hero 大空白"都是这一步没做引起的）。 */
  .hero-left {
    flex-direction: column !important;
    align-items: stretch !important;
    width: 100%;
    gap: 10px;
  }
  .hero-left-text,
  .hero-duty,
  .hero-notes {
    width: 100%;
    min-width: 0;
    max-width: none !important; /* 覆盖 .hero-notes 的 max-width:280px，让它在小屏上全宽 */
  }
  .hero-notes {
    /* 单列布局时不再固定竖直居中，改为内容自然撑高 */
    align-self: stretch;
    flex-wrap: wrap;
  }
  .hero-notes .hn-kb-btn {
    align-self: flex-start; /* 按钮回到顶部自然位置（sticky 居中已无意义） */
  }
  .hero-right {
    width: 100%;
    justify-content: flex-start;
  }
  .hero-greet {
    font-size: 19px;
  }
  .todo-item {
    padding: 11px;
  }
  .tick {
    width: 26px;
    height: 26px;
    min-width: 26px;
  }
  .sc-item {
    min-height: 76px;
  }
  /* 快捷入口：窄屏自适应列数，避免只显示 2 张且被裁切 */
  .sc-grid {
    grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
  }
  /* 手机端：总览主体改为自然文档流，避免两栏叠压裁切（问题1） */
  .ov {
    overflow: visible !important;
    height: auto !important;
    flex: none !important;
    min-height: 0 !important;
  }
  /* 单列后两区块各占一行自然撑高，不再被 minmax(0,1fr) 压扁 */
  .ov-grid {
    grid-template-rows: auto !important;
  }
  .ov-todo,
  .ov-proj {
    overflow: visible !important;
    height: auto !important;
    min-height: 0 !important;
  }
  .ov-todo .todo-body {
    overflow: visible !important;
    max-height: none !important;
  }
  /* 手机端不显示项目文档，只聚焦今日要处理（问题3 用户要求） */
  .ov-proj {
    display: none !important;
  }
  /* 手机端首屏要让「今天要处理」露头：hero 收紧内距、缩问候语字号 */
  .hero {
    padding: 12px;
    gap: 10px;
  }
  .hero-greet {
    font-size: 17px;
  }
  .hero-date {
    font-size: 12px;
  }
  /* hero 右下那颗「N 项待处理」与顶部数字条信息重复，手机端去掉，把纵向空间让给待办列表 */
  .hero-badge {
    display: none !important;
  }
  /* 区块间距一并收紧 */
  .ov {
    gap: 10px;
  }
  .ov-grid {
    gap: 10px;
  }
}

</style>
