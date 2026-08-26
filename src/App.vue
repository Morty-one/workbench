<script setup>
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import Overview from './views/Overview.vue'
import Tasks from './views/Tasks.vue'
import Notes from './views/Notes.vue'
import Duty from './views/Duty.vue'
import Data from './views/Data.vue'
import DocOutput from './views/DocOutput.vue'
import Review from './views/Review.vue'
import { db } from './db'
import { notify, requestNotifyPermission } from './notify'
import { seedIfEmpty, ensureDefaultProject } from './seed'
import { isMobileDevice } from './env'
import { bootCloudSync } from './sync/cloudsync'
import { docState, requestDocOutput, startRun, restoreDocRun, closeDocModal, resetDocRun, normalizeAPath } from './docoutput.js'

const manualPath = ref('')
const copiedDiagnostics = ref(false)

function submitManualPath() {
  const p = normalizeAPath(manualPath.value)
  if (!p) return
  closeDocModal()
  startRun(p)
}

let copiedTimer = null
async function copyDiagnostics() {
  const text = docState.modal.diagnostics || ''
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 降级方案
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copiedDiagnostics.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copiedDiagnostics.value = false), 1500)
}

function tDocStep(name) {
  if (!name) return ''
  if (name.startsWith('paste:')) return '粘贴 ' + name.slice(6)
  const m = {
    openA: '打开 A 文件',
    macro1: '执行宏①（处理 A）',
    openB: '打开 B 文件',
    macro2: '执行宏②（公式匹配）',
    copyRename: '复制并重命名 B',
    deleteSheet: '删除指定 sheet',
    openWps: '打开 WPS 线上表',
    submit: '提交执行请求'
  }
  return m[name] || name
}
function tDocDetail(d) {
  if (!d) return ''
  const map = [
    ['A file not found: ', 'A 文件不存在：'],
    ['B file not found: ', 'B 文件不存在：'],
    ['Macro1 run failed: ', '宏①运行失败：'],
    ['Macro2 run failed: ', '宏②运行失败：'],
    ['Copy/rename failed: ', '复制/重命名失败：'],
    ['Delete sheet failed: ', '删除 sheet 失败：'],
    ['Sheet to delete not found: ', '要删除的 sheet 不存在：'],
    ['WPS not available', '无法启动 WPS（ET/KWPS/KET 均不可用）'],
    ['WPS open link failed: ', '打开 WPS 线上表链接失败：'],
    ['Local sheet not found: ', '本地 sheet 不存在：'],
    ['Online sheet not found: ', '线上 sheet 不存在：'],
    ['Dimension mismatch: ', '源与目标范围尺寸不一致：'],
    ['skipped (not configured)', '已跳过（未配置）']
  ]
  for (const [en, zh] of map) {
    if (d.startsWith(en)) return zh + d.slice(en.length)
  }
  return d
}

/* ============= 主题 / 皮肤 ============= */
// 皮肤清单：每个皮肤映射到一个「结构主题」（驱动组件级 [data-theme] 覆盖）
const SKINS = [
  { key: 'light',    theme: 'light', label: '浅色',     dot: '#ffffff' },
  { key: 'glass',    theme: 'dark',  label: '暗色玻璃', dot: '#38bdf8' },
  { key: 'aurora',   theme: 'dark',  label: '极光',     dot: '#2dd4bf' },
  { key: 'clean',    theme: 'light', label: '极简浅色', dot: '#6366f1' }
]
// 单一数据源：skin（兼容旧 localStorage 键 wb_theme_v2；旧值 dark/espresso/warm 已下架，回退到 light）
const VALID_SKINS = SKINS.map((s) => s.key)
const storedSkin = localStorage.getItem('wb_theme_v2')
const skin = ref(VALID_SKINS.includes(storedSkin) ? storedSkin : 'light')
const skinOpen = ref(false)
const theme = computed(() => SKINS.find((s) => s.key === skin.value)?.theme || 'dark')

function applySkin() {
  const t = theme.value
  document.documentElement.dataset.theme = t
  // 默认皮肤不设 data-skin，保持原有行为完全一致；新皮肤用 data-skin 叠加调色板
  const sk = skin.value
  if (sk === 'dark' || sk === 'light') delete document.documentElement.dataset.skin
  else document.documentElement.dataset.skin = sk
  localStorage.setItem('wb_theme_v2', sk)
  // 强调色仅在浅色主题生效：暗色皮肤下不写入 data-accent，由皮肤自带配色驱动
  if (t === 'light') document.documentElement.dataset.accent = accent.value
  else delete document.documentElement.dataset.accent
}
watch(skin, applySkin)

// 换肤弹窗：点击外部或 Esc 关闭
function onDocMouseDown(e) {
  if (!skinOpen.value) return
  if (e.target.closest('.skin-pop') || e.target.closest('.skin-btn')) return
  skinOpen.value = false
}
function onSkinKey(e) {
  if (e.key === 'Escape' && skinOpen.value) skinOpen.value = false
}

/* ============= 侧边栏折叠 ============= */
// 默认折叠（无文字细条），用户主动展开后才显示宽列。localStorage 记忆状态。
const sidebarCollapsed = ref(localStorage.getItem('wb_sidebar_collapsed') !== '0')
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
}
watch(sidebarCollapsed, (v) => localStorage.setItem('wb_sidebar_collapsed', v ? '1' : '0'))

/* ============= 右侧指标栏折叠 ============= */
// 默认展开（240px 列），用户可折叠收起；localStorage 记忆状态。
const metricsCollapsed = ref(localStorage.getItem('wb_metrics_collapsed') === '1')
function toggleMetrics() {
  metricsCollapsed.value = !metricsCollapsed.value
}
watch(metricsCollapsed, (v) => localStorage.setItem('wb_metrics_collapsed', v ? '1' : '0'))
// 指标栏悬浮按钮的显隐：仅在「任务总览」（右侧栏）感应区内才显示，离开即隐藏（#2）
const metricsHover = ref(false)

/* ============= 强调色（仅浅色主题）============= */
// 浅色主题：默认蓝（ocean）。暗色皮肤下隐藏色板，accent 值仍保留以备切回浅色时复用。
const accent = ref(localStorage.getItem('wb_accent') || 'ocean')
const accentOptions = [
  { key: 'ocean', label: '海洋', dot: '#2aabe8' },
  { key: 'emerald', label: '翡翠', dot: '#23e2a0' },
  { key: 'iris', label: '鸢尾', dot: '#845ee7' },
  { key: 'amber', label: '琥珀', dot: '#e69d23' },
  { key: 'sakura', label: '樱粉', dot: '#e0527c' }
]
const isLightSkin = computed(() => theme.value === 'light')
function applyAccent() {
  if (!isLightSkin.value) return // 暗色皮肤下不写入 data-accent
  document.documentElement.dataset.accent = accent.value
  localStorage.setItem('wb_accent', accent.value)
}
watch(accent, applyAccent)

/* ============= 导航 ============= */
// 移动端隐藏 PC 专属入口（文档输出依赖本地桥 + WPS COM，手机不可用）
const navItems = [
  { key: 'overview', label: '总览', icon: 'overview' },
  { key: 'tasks', label: '任务管理', icon: 'tasks' },
  { key: 'review', label: '复盘', icon: 'review' },
  { key: 'notes', label: '知识库', icon: 'notes' },
  { key: 'duty', label: '日程管理', icon: 'duty' },
  { key: 'docoutput', label: '文档输出', icon: 'docout' },
  { key: 'data', label: '设置中心', icon: 'data' }
].filter((n) => !isMobileDevice || n.key !== 'docoutput')
const current = ref('overview')

/* 总览下钻：项目卡片 → 任务管理筛选；noteId 用于跳转到指定笔记的编辑态 */
const tasksProjectFilter = ref(null)
const openNoteId = ref(null)
function goto(key, opts = {}) {
  current.value = key
  tasksProjectFilter.value = opts && opts.projectId != null ? opts.projectId : null
  openNoteId.value = opts && opts.noteId != null ? opts.noteId : null
}
function clearProjectFilter() {
  tasksProjectFilter.value = null
}
/* 跨视图跳转（如：笔记一键转为任务后跳到任务管理） */
function onGotoEvent(e) {
  const detail = (e && e.detail) || {}
  if (detail.key) goto(detail.key, { projectId: detail.projectId != null ? detail.projectId : null, noteId: detail.noteId != null ? detail.noteId : null })
}

/* ============= 右侧指标卡 ============= */
const tasks = ref([])
async function loadMetrics() {
  tasks.value = await db.tasks.toArray()
}
const today0 = new Date()
today0.setHours(0, 0, 0, 0)
const todayStart = today0.getTime()
const todayEnd = todayStart + 24 * 3600 * 1000
const yesterdayStart = todayStart - 24 * 3600 * 1000

const metrics = computed(() => {
  const now = Date.now()
  const today = tasks.value.filter((t) => (t.createdAt || 0) >= todayStart && (t.createdAt || 0) < todayEnd)
  const yest = tasks.value.filter((t) => (t.createdAt || 0) >= yesterdayStart && (t.createdAt || 0) < todayStart)
  const inProgress = tasks.value.filter((t) => t.status === '跟进中')
  const completed = tasks.value.filter((t) => t.status === '已完成' && (t.completedAt || 0) >= todayStart && (t.completedAt || 0) < todayEnd)
  const completedYest = tasks.value.filter((t) => t.status === '已完成' && (t.completedAt || 0) >= yesterdayStart && (t.completedAt || 0) < todayStart)
  const overdue = tasks.value.filter(
    (t) => t.status !== '已完成' && (t.nextRemindAt ?? t.followUpAt ?? 0) > 0 && (t.nextRemindAt ?? t.followUpAt) < now
  )
  const overdueYest = tasks.value.filter(
    (t) => t.status !== '已完成' && (t.nextRemindAt ?? t.followUpAt ?? 0) > 0 && (t.nextRemindAt ?? t.followUpAt) < yesterdayStart
  )
  return [
    { key: 'todo', label: '今日待办', value: today.length, prev: yest.length, icon: 'inbox', accent: 'primary' },
    { key: 'doing', label: '进行中', value: inProgress.length, icon: 'progress', accent: 'primary' },
    { key: 'done', label: '已完成', value: completed.length, prev: completedYest.length, icon: 'check', accent: 'success' },
    { key: 'over', label: '逾期任务', value: overdue.length, prev: overdueYest.length, icon: 'warn', accent: 'danger' }
  ]
})

/* ============= 提醒 toast ============= */
const toasts = ref([])
const reminded = new Set()
let timer = null
let metricTimer = null

// 把 HH:MM 锚定到任务所在日 00:00 得到时间戳（无 dayKey 回退 createdAt 当天）
function hhmmToTs(t, hhmm) {
  if (!hhmm) return 0
  const parts = String(hhmm).split(':').map(Number)
  const h = parts[0]
  const m = parts[1]
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0
  let base
  if (t.dayKey) {
    base = new Date(`${t.dayKey}T00:00:00`).getTime()
  } else {
    const d = new Date(t.createdAt || Date.now())
    base = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  return base + (h * 60 + m) * 60000
}
// 完成时间锚点：仅用 dueTime 字段（未设则无完成确认）
function subDueAt(t, s) {
  return hhmmToTs(t, s && s.dueTime)
}
const toastUid = () => Date.now() + Math.random().toString(36).slice(2)
async function primeReminded() {
  // 完成确认(:d) / 文档输出(:doc) 不在此预置：
  // 逾期未完成的任务在加载后应主动询问是否完成
}
async function checkReminders() {
  const now = Date.now()
  // 工作台当前是否真正可见且处于前台：切到其它程序 / 标签页隐藏 → 走系统通知
  const active = document.visibilityState === 'visible' && document.hasFocus()
  const open = await db.tasks.where('status').notEqual('已完成').toArray()
  for (const t of open) {
    // 有子任务：仅按各子任务的「完成时间」分别触发「是否完成」
    const subs = (t.subtasks || []).filter((s) => !s.done && s.dueTime)
    if (subs.length) {
      for (const s of subs) {
        const key = `${t.id}:${s.id}:d`
        const dAt = subDueAt(t, s)
        if (dAt > 0 && dAt <= now && !reminded.has(key)) {
          reminded.add(key)
          if (active) pushDueToast(t, s)
          else {
            notify('待办完成确认', `${t.title} · ${s.text} 已到完成时间，是否已完成？`, focusWorkbench)
            scheduleReask(key, 30)
          }
        }
      }
    } else if (t.docOutput) {
      // 文档输出类任务：到完成时间提示手动执行（可见时应用内提示，隐藏时系统通知）
      const dAt = t.followUpAt ? t.followUpAt : (t.dueTime ? hhmmToTs(t, t.dueTime) : 0)
      const key = `${t.id}:doc`
      if (dAt > 0 && dAt <= now && !reminded.has(key)) {
        reminded.add(key)
        if (active) toasts.value.push({ uid: toastUid(), t, mode: 'docoutput', snooze: 30, custom: 30 })
        else {
          notify('文档输出提醒', `${t.title} 到执行时间，请点任务上的「执行文档输出」`, focusWorkbench)
          scheduleReask(key, 30)
        }
      }
    } else {
      // 普通任务：到完成时间询问是否完成
      const dAt = t.followUpAt ? t.followUpAt : (t.dueTime ? hhmmToTs(t, t.dueTime) : 0)
      const key = `${t.id}:d`
      if (dAt > 0 && dAt <= now && !reminded.has(key)) {
        reminded.add(key)
        if (active) pushDueToast(t)
        else {
          notify('待办完成确认', `${t.title} 已到完成时间，是否已完成？`, focusWorkbench)
          scheduleReask(key, 30)
        }
      }
    }
  }
}
const toastTimers = new Map()

// 把 uid 映射回 reminded 的 key，用于「未完成的提示」消失后 N 分钟再次询问
function toastKey(toast) {
  if (toast.mode === 'docoutput') return `${toast.t.id}:doc`
  if (toast.sub) return `${toast.t.id}:${toast.sub.id}:d`
  return `${toast.t.id}:d`
}
// N 分钟后清除 reminded key，使 checkReminders 能再次弹出提示
function scheduleReask(key, min = 30) {
  setTimeout(() => { reminded.delete(key) }, min * 60 * 1000)
}
// 点击系统通知时把工作台窗口提到前台
function focusWorkbench() {
  try { window.focus() } catch (e) {}
}
// 完成确认 toast：鼠标不在窗口上 5 秒后自动消失；在窗口上常显
function startToastTimer(toast) {
  clearToastTimer(toast)
  const uid = toast.uid
  toastTimers.set(uid, setTimeout(() => {
    const t = toasts.value.find((x) => x.uid === uid)
    if (t) closeToast(t)
  }, 5000))
}
function clearToastTimer(toast) {
  const id = toastTimers.get(toast.uid)
  if (id) { clearTimeout(id); toastTimers.delete(toast.uid) }
}
function pushDueToast(t, sub) {
  const toast = { uid: toastUid(), t, sub: sub || null, mode: 'due', snooze: 30, custom: 30 }
  toasts.value.push(toast)
  startToastTimer(toast)
}
// 窗口消失 = 未执行未完成 → 30 分钟后再问
function closeToast(toast) {
  const key = toastKey(toast)
  if (key) scheduleReask(key, 30)
  clearToastTimer(toast)
  toasts.value = toasts.value.filter((x) => x.uid !== toast.uid)
}
async function markDone(toast) {
  if (toast.sub) {
    const t = toast.t
    const subs = JSON.parse(JSON.stringify(t.subtasks || []))
    const target = subs.find((s) => s.id === toast.sub.id)
    if (target) target.done = true
    await db.tasks.update(t.id, { subtasks: subs })
  } else {
    await db.tasks.update(toast.t.id, { status: '已完成', completedAt: Date.now() })
  }
  clearToastTimer(toast)
  toasts.value = toasts.value.filter((x) => x.uid !== toast.uid)
  await loadMetrics()
  window.dispatchEvent(new CustomEvent('task-updated'))
}
async function snooze(toast) {
  const min = toast.snooze === 'custom' ? Math.max(1, Number(toast.custom) || 30) : Number(toast.snooze)
  const key = toastKey(toast)
  if (key) {
    clearToastTimer(toast)
    // N 分钟后再问一次（当前会话内有效）
    setTimeout(() => { reminded.delete(key) }, min * 60 * 1000)
  }
  toasts.value = toasts.value.filter((x) => x.uid !== toast.uid)
  await loadMetrics()
  window.dispatchEvent(new CustomEvent('task-updated'))
}
function dismiss(toast) {
  closeToast(toast)
}
// 鼠标移入：取消自动消失计时；移出：5 秒后自动消失（仅「是否完成」类）
function onToastEnter(toast) {
  clearToastTimer(toast)
}
function onToastLeave(toast) {
  if (toast.mode === 'due') startToastTimer(toast)
}
// 回到前台时立即检查（可见则补弹应用内提示）
function onVisibility() {
  if (document.visibilityState === 'visible') checkReminders()
}

/* ============= 顶栏搜索 ============= */
const globalSearch = ref('')

onMounted(async () => {
  applySkin()
  applyAccent()
  requestNotifyPermission()
  document.addEventListener('mousedown', onDocMouseDown)
  window.addEventListener('keydown', onSkinKey)
  // 云端同步（若已配置）：启动先拉取远端，远端较新则整库还原并刷新页面；
  // 必须先于 seedIfEmpty，否则新设备会用种子数据反向覆盖云端真实数据
  await bootCloudSync()
  await seedIfEmpty()
  await ensureDefaultProject() // 老用户 / 清空过数据的场景兜底
  await primeReminded()
  await loadMetrics()
  await restoreDocRun()
  timer = setInterval(checkReminders, 30000)
  metricTimer = setInterval(loadMetrics, 60000)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('wb:goto', onGotoEvent)
})
onUnmounted(() => {
  clearInterval(timer)
  clearInterval(metricTimer)
  window.removeEventListener('wb:goto', onGotoEvent)
  document.removeEventListener('visibilitychange', onVisibility)
  document.removeEventListener('mousedown', onDocMouseDown)
  window.removeEventListener('keydown', onSkinKey)
})

function trend(value, prev) {
  if (prev == null) return null
  if (prev === 0 && value === 0) return { text: '0%', dir: 'flat' }
  if (prev === 0) return { text: '↑ 新增', dir: 'up' }
  const diff = ((value - prev) / prev) * 100
  const sign = diff > 0 ? '↑' : diff < 0 ? '↓' : '·'
  return { text: `${sign} ${Math.abs(diff).toFixed(0)}%`, dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat' }
}
</script>

<template>
  <div class="layout" :class="{ dark: theme === 'dark', 'metrics-collapsed': metricsCollapsed }">
    <!-- 左侧导航 -->
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="brand">
        <div class="brand-mark">WB</div>
        <div class="brand-text">
          <div class="brand-name">WenXBuddy</div>
          <div class="brand-sub">个人工作台</div>
        </div>
      </div>
      <nav class="nav">
        <button
          v-for="n in navItems"
          :key="n.key"
          :class="['nav-item', { active: current === n.key, 'has-float': n.key === 'notes' }]"
          @click="current = n.key"
          :title="n.label"
        >
          <svg class="nav-ico" viewBox="0 0 24 24" width="20" height="20">
            <template v-if="n.icon === 'overview'">
              <rect x="3" y="3" width="7.5" height="7.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/>
              <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/>
              <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/>
              <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/>
            </template>
            <template v-else-if="n.icon === 'tasks'">
              <rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/>
              <path d="M7 9h10M7 13h7M7 17h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </template>
            <template v-else-if="n.icon === 'notes'">
              <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
              <path d="M16 4v3h3" fill="none" stroke="currentColor" stroke-width="1.6"/>
              <path d="M8 12h8M8 15h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            </template>
            <template v-else-if="n.icon === 'review'">
              <path d="M4 20V10M10 20V5M16 20v-7M22 20H2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="4" cy="10" r="1.7" fill="currentColor"/>
              <circle cx="10" cy="5" r="1.7" fill="currentColor"/>
              <circle cx="16" cy="13" r="1.7" fill="currentColor"/>
            </template>
            <template v-else-if="n.icon === 'duty'">
              <rect x="3" y="5" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/>
              <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </template>
            <template v-else-if="n.icon === 'docout'">
              <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
              <path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.6"/>
              <path d="M9 13h6M9 16h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </template>
            <template v-else-if="n.icon === 'data'">
              <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/>
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" stroke="currentColor" stroke-width="1.4" fill="none"/>
            </template>
          </svg>
          <span class="nav-label">{{ n.label }}</span>
          <span v-if="n.key === 'notes'" class="nav-float-btn" :title="sidebarCollapsed ? '展开侧栏' : '折叠侧栏'" @click.stop="toggleSidebar">
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path v-if="sidebarCollapsed" d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path v-else d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
        </button>
      </nav>
      <div class="sidebar-foot">
        <button class="skin-btn" @click="skinOpen = !skinOpen" :title="`当前皮肤：${(SKINS.find((s) => s.key === skin) || {}).label || ''}`">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path d="M12 3a9 9 0 1 0 0 18c1.7 0 2-1.3 2-2.5 0-1-.8-1.5-1.5-2-.7-.5-1-1.2-1-2 0-.8.7-1.5 1.5-1.5H17a4.5 4.5 0 0 0 4.5-4.5C21.5 6.3 17.2 3 12 3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
            <circle cx="7.5" cy="11" r="1.1" fill="currentColor"/>
            <circle cx="11" cy="7.5" r="1.1" fill="currentColor"/>
            <circle cx="16" cy="8.5" r="1.1" fill="currentColor"/>
          </svg>
          <span>换肤</span>
        </button>
        <div class="skin-pop" v-if="skinOpen" @click.stop>
          <div class="skin-pop-title">选择皮肤</div>
          <button v-for="s in SKINS" :key="s.key" class="skin-item" :class="{ active: skin === s.key }" @click="skin = s.key; skinOpen = false">
            <span class="skin-dot" :style="{ background: s.dot }"></span>
            <span class="skin-name">{{ s.label }}</span>
            <span v-if="skin === s.key" class="skin-check">✓</span>
          </button>
        </div>
        <div class="accent-row" v-if="isLightSkin">
          <span class="accent-label">强调色</span>
          <div class="accent-swatches">
            <button
              v-for="a in accentOptions"
              :key="a.key"
              class="accent-swatch"
              :class="{ active: accent === a.key }"
              :title="a.label"
              @click="accent = a.key"
              :style="{ '--swatch': a.dot }"
            >
              <i></i>
            </button>
          </div>
        </div>
      </div>
    </aside>

    <!-- 中部主内容 -->
    <main class="main">
      <header class="topbar" v-if="current !== 'duty' && current !== 'overview' && current !== 'notes' && current !== 'data' && current !== 'tasks' && current !== 'review' && current !== 'docoutput'">
        <div class="search">
          <svg viewBox="0 0 24 24" width="16" height="16" class="search-ico">
            <circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/>
            <path d="M16 16l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
          <input v-model="globalSearch" placeholder="搜索任务、笔记、文件…" />
        </div>
        <div class="topbar-right">
          <button class="bell" :title="`${toasts.length} 条提醒`">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path d="M6 16V10a6 6 0 1 1 12 0v6l1.5 2H4.5L6 16z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
              <path d="M10 20a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
            <span v-if="toasts.length" class="dot">{{ toasts.length }}</span>
          </button>
          <div class="avatar" title="个人工作台">BR</div>
        </div>
      </header>

      <section class="content">
        <Overview v-if="current === 'overview'" @goto="goto" />
        <Tasks v-else-if="current === 'tasks'" :search="globalSearch" :project-id="tasksProjectFilter" @changed="loadMetrics" @clear-project="clearProjectFilter" />
        <Review v-else-if="current === 'review'" :search="globalSearch" />
        <Notes v-else-if="current === 'notes'" :search="globalSearch" :open-note-id="openNoteId" />
        <Duty v-else-if="current === 'duty'" />
        <Data v-else-if="current === 'data'" />
        <DocOutput v-else-if="current === 'docoutput'" />
      </section>
    </main>

    <!-- 右侧指标卡 -->
    <aside class="metrics" @mouseenter="metricsHover = true" @mouseleave="metricsHover = false">
      <div class="metric-head">
        <div>
          <div class="metric-title">任务总览</div>
          <div class="metric-date muted">{{ new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }) }}</div>
        </div>
        <button class="metric-collapse-btn" :class="{ show: metricsHover }" title="折叠指标栏" @click="toggleMetrics">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div
        v-for="(m, idx) in metrics"
        :key="m.key"
        class="metric-card fluid-card"
        :class="`accent-${m.accent}`"
        :data-material="['cyan', 'original', 'rain', 'chrome'][idx % 4]"
      >
        <div class="metric-icon">
          <svg viewBox="0 0 24 24" width="22" height="22">
            <template v-if="m.icon === 'inbox'">
              <path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
              <path d="M3 13h5l1 2h6l1-2h5" fill="none" stroke="currentColor" stroke-width="1.6"/>
            </template>
            <template v-else-if="m.icon === 'progress'">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/>
              <path d="M12 7v5l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </template>
            <template v-else-if="m.icon === 'check'">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/>
              <path d="M8 12l3 3 5-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </template>
            <template v-else-if="m.icon === 'warn'">
              <path d="M12 3l10 17H2L12 3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
              <path d="M12 10v4M12 17v0.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </template>
          </svg>
        </div>
        <div class="metric-body">
          <div class="metric-label">{{ m.label }}</div>
          <div class="metric-value">{{ m.value }}</div>
        </div>
        <div v-if="trend(m.value, m.prev)" class="metric-trend" :class="trend(m.value, m.prev).dir">
          {{ trend(m.value, m.prev).text }}
        </div>
        <div class="metric-sub muted">较昨日</div>
      </div>
    </aside>

    <!-- 指标栏折叠时：右侧感应区与展开按钮同处一个 wrap，避免按钮（z:40）遮挡 .metrics-sense（z:39）触发 sense 的 mouseleave 把按钮隐藏、点击无响应（#2 修复） -->
    <div v-if="metricsCollapsed" class="metrics-edge-wrap" @mouseenter="metricsHover = true" @mouseleave="metricsHover = false">
      <button class="metrics-edge-btn" :class="{ show: metricsHover }" title="展开指标栏" @click="toggleMetrics">
        <svg viewBox="0 0 24 24" width="14" height="14"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>

    <!-- 紧凑提醒 toast -->
    <div class="toasts">
      <div v-for="toast in toasts" :key="toast.uid" class="toast" :class="toast.mode" @mouseenter="onToastEnter(toast)" @mouseleave="onToastLeave(toast)">
        <div class="toast-title">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <circle cx="12" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/>
            <path d="M12 9v4l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            <path d="M5 4l1.5 1.5M19 4l-1.5 1.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
          <template v-if="toast.mode === 'due'">是否已完成？</template>
          <template v-else-if="toast.mode === 'docoutput'">请执行文档输出</template>
          <template v-else>{{ toast.sub ? `${toast.t.title} · ${toast.sub.text}` : toast.t.title }}</template>
        </div>
        <div v-if="toast.mode === 'due'" class="toast-body muted">
          {{ toast.sub ? `${toast.t.title} · ${toast.sub.text}` : toast.t.title }} 已到完成时间
        </div>
        <div v-else-if="toast.mode === 'docoutput'" class="toast-body muted">
          {{ toast.t.title }} 已到执行时间，点「执行」选 A 文件并运行（用当前文档输出配置）
        </div>
        <div class="toast-actions">
          <template v-if="toast.mode === 'docoutput'">
            <button class="primary sm" :disabled="docState.running || docState.picking" @click="requestDocOutput()">
              {{ docState.picking ? '选 A…' : (docState.running ? '执行中…' : '执行') }}
            </button>
          </template>
          <template v-else-if="toast.snooze !== 'custom'">
            <select v-model="toast.snooze" class="snooze-sel">
              <option :value="15">稍后 15 分</option>
              <option :value="30">稍后 30 分</option>
              <option :value="60">稍后 1 时</option>
              <option :value="120">稍后 2 时</option>
              <option :value="'custom'">自定义…</option>
            </select>
            <button class="ghost sm" @click="snooze(toast)">{{ toast.mode === 'due' ? '稍后再问' : '稍后' }}</button>
          </template>
          <template v-else>
            <input type="number" min="1" v-model.number="toast.custom" class="snooze-num" />
            <span class="muted">分</span>
            <button class="ghost sm" @click="snooze(toast)">确定</button>
          </template>
          <button class="primary sm" v-if="toast.mode !== 'docoutput'" @click="markDone(toast)">{{ toast.mode === 'due' ? '已完成' : '完成' }}</button>
          <button class="ghost sm" @click="dismiss(toast)" aria-label="关闭">
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- 文档输出结果弹窗（全局，任何视图触发都可见） -->
    <div v-if="docState.modal.visible" class="do-modal-mask" @click="closeDocModal">
      <div class="do-modal" @click.stop>
        <div class="do-modal-head">
          <span :class="['do-modal-icon', docState.modal.ok ? 'ok' : 'fail']">
            <svg v-if="docState.modal.ok" viewBox="0 0 24 24" width="22" height="22">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>
              <path d="M8 12l3 3 5-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" width="22" height="22">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>
              <path d="M12 8v5M12 16v0.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
            </svg>
          </span>
          <h4>{{ docState.modal.title }}</h4>
          <button class="do-modal-close ghost sm" @click="closeDocModal" aria-label="关闭">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
        <div class="do-modal-body">
          <p v-if="docState.modal.message" class="do-modal-msg">{{ docState.modal.message }}</p>
          <div v-if="docState.modal.diagnostics" class="do-modal-diagnostics">
            <div class="do-diag-head">
              <span class="muted">诊断信息</span>
              <button class="ghost xs" :class="{ success: copiedDiagnostics }" @click="copyDiagnostics">{{ copiedDiagnostics ? '已复制' : '复制' }}</button>
            </div>
            <pre>{{ docState.modal.diagnostics }}</pre>
          </div>
          <div v-if="docState.modal.title === '选择文件失败' || docState.modal.manual" class="do-modal-manual">
            <p class="muted">如果文件选择框无法弹出，可手动粘贴 A 文件的完整路径：</p>
            <input v-model="manualPath" type="text" placeholder="例如：D:\导出\日报 2026-08-15.xlsx" @keyup.enter="submitManualPath" />
            <button class="primary sm" :disabled="!manualPath.trim()" @click="submitManualPath">用此路径执行</button>
          </div>
          <ul v-if="docState.modal.steps && docState.modal.steps.length" class="do-modal-steps">
            <li v-for="(s, i) in docState.modal.steps" :key="i" :class="s.ok ? 'ok' : 'fail'">
              <span class="do-step-no">{{ i + 1 }}.</span>
              <span class="do-step-name">{{ tDocStep(s.name) }}</span>
            <span v-if="!s.ok && s.detail" class="do-step-err">✗ {{ tDocDetail(s.detail) }}</span>
            <span v-else-if="s.ok && s.detail && s.detail !== 'skipped (not configured)'" class="do-step-ok">· {{ tDocDetail(s.detail) }}</span>
            </li>
          </ul>
        </div>
        <div class="do-modal-foot">
          <button v-if="docState.running || docState.modal.title === '执行状态异常'" class="danger sm" @click="resetDocRun(); closeDocModal()">强制结束 / 重置</button>
          <button class="primary" @click="closeDocModal">知道了</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: auto 1fr 240px;
  /* 应用外壳（app-shell）：layout 锁定为精确视口高度并裁掉溢出，body 永不出现窗口级滚动条。
     这是消除"所有模块都有的右侧滚动条"的关键：之前用 min-height:100vh（非固定高度），
     当侧栏内容高于视口时 layout 会超出视口 → 整页（而非 main 内部）出现滚动条，表现为"每个模块都有滚动条"。 */
  height: 100vh;             /* 固定为精确视口高度（替代 min-height），配合 overflow:hidden 让 body 永不滚动 */
  overflow: hidden;          /* 裁掉超出视口的溢出；侧栏/指标栏改用自身 overflow-y:auto 内部滚动，不被裁切 */
  grid-template-rows: minmax(0, 1fr); /* 单行占满内容区（100vh - padding），min 0 防止子项内容把行高撑爆；main 由此被精确约束 */
  gap: 16px;
  padding: 16px;
  max-width: 1600px;
  margin: 0 auto;
  /* 各列按自身内容高度对齐（sidebar / metrics 不被 main 拉伸） */
  align-items: start;          /* align-items:start → 各列按自身内容高对齐；若改 stretch 会让 sidebar/metrics 被 main 拉伸，影响侧栏与滚动行为 */
}
/* 指标栏折叠：240px 列收为 0，内容隐藏 */
.layout.metrics-collapsed {
  grid-template-columns: auto 1fr 0;
}
.layout.metrics-collapsed .metrics {
  display: none;
}
@media (max-width: 1100px) {
  .layout {
    grid-template-columns: auto 1fr;
  }
  .metrics {
    display: none;
  }
}
@media (max-width: 720px) {
  .layout {
    grid-template-columns: 1fr;
    padding: 8px;
    /* iPhone 刘海 / 状态栏与底部 Home 指示条安全区 */
    padding-top: calc(8px + env(safe-area-inset-top));
    padding-bottom: 0;
    /* 移动端恢复文档流滚动：覆盖桌面端 .layout { height:100vh; overflow:hidden; grid-template-rows:minmax(0,1fr) }，避免整页被裁切 */
    height: auto;
    min-height: 100vh;
    overflow: visible;
    grid-template-rows: auto;
  }
  /* 移动端：main 恢复内容高度，避免固定 100vh 与底部 Tab 冲突 */
  .main {
    height: auto;
    overflow-y: visible;
  }
  .sidebar {
    position: fixed;
    inset: auto 0 0 0;
    z-index: 50;
    flex-direction: row;
    height: auto;
    min-height: 60px;
    border-radius: 16px 16px 0 0;
    padding: 8px 8px calc(8px + env(safe-area-inset-bottom));
    /* 覆盖桌面端 .sidebar 的 max-height/overflow，移动端底部 Tab 不应被限高或内部滚动 */
    max-height: none;
    overflow: visible;
  }
  .brand {
    display: none;
  }
  .nav {
    flex-direction: row;
    flex: 1;
    justify-content: space-around;
  }
  .nav-item {
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    padding: 6px;
  }
  .nav-label {
    font-size: 11px;
  }
  .sidebar-foot {
    display: none;
  }
  .main {
    padding-bottom: calc(80px + env(safe-area-inset-bottom));
  }
}

/* ============= 左侧导航 ============= */
.sidebar {
  background: var(--panel);
  backdrop-filter: blur(18px) saturate(150%);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 14px;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow);
  height: fit-content;
  position: sticky;
  top: 16px;
  align-self: start;
  width: 220px;
  max-width: 220px;
  max-height: calc(100vh - 32px);   /* .layout 已 overflow:hidden；侧栏过高时改为自身内部滚动，避免被裁切 */
  overflow-y: auto;                 /* 侧栏内部滚动（仅在侧栏内容超过视口时出现） */
  overscroll-behavior: contain;     /* 侧栏滚到底不带动外部 */
  transition: width .22s ease, padding .22s ease;
}
/* 默认折叠态：细条状无文字 */
.sidebar.collapsed {
  width: 64px;
  max-width: 64px;
  padding: 18px 8px;
  /* 折叠态内容极少（品牌+6 nav+换肤），不需要内部滚动；解除 overflow 让 skin-pop 可向右 200px 越界到主区外侧
     （之前在 .sidebar 加 overflow-y:auto 后，sidebar.collapsed .skin-pop 会被父级 overflow 裁掉，看不到完整 200px 弹层） */
  overflow: visible;
  max-height: none;
}
.sidebar.collapsed .brand-text,
.sidebar.collapsed .nav-label,
.sidebar.collapsed .skin-btn span,
.sidebar.collapsed .accent-row {
  display: none;
}
.sidebar.collapsed .brand {
  justify-content: center;
  padding-bottom: 12px;
  margin-bottom: 10px;
}
.sidebar.collapsed .brand-mark {
  margin: 0 auto;
}
.sidebar.collapsed .nav-item {
  justify-content: center;
  padding: 10px 8px;
  gap: 0;
}
.sidebar.collapsed .skin-btn {
  justify-content: center;
  padding: 10px 8px;
}
/* 折叠态：换肤弹层从 64px 窄条里挤出来会错位，改为向右展开到主区外侧，正常宽度 */
.sidebar.collapsed .skin-pop {
  left: calc(100% + 8px);
  right: auto;
  width: 200px;
  bottom: 0;
  top: auto;
}
/* 左侧悬浮折叠/展开按钮：锚定在「知识库」导航项右侧，hover 显隐，不常显（#3 #7） */
.nav-item.has-float {
  position: relative;
}
.nav-float-btn {
  position: absolute;
  right: -14px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 48px;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 0;
  border: 1px solid var(--border);
  border-left: none;
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  z-index: 6;
  box-shadow: 4px 0 14px rgba(0, 0, 0, .08);
  transition: opacity .18s ease, color .15s ease, background .15s ease;
}
.sidebar:hover .nav-float-btn,
.nav-item.has-float:hover .nav-float-btn {
  opacity: 1;
}
.nav-float-btn:hover {
  color: var(--primary);
  background: var(--primary-soft);
}
[data-theme="dark"] .sidebar {
  background: linear-gradient(145deg, rgba(17, 24, 21, .97), rgba(8, 13, 11, .98));
  box-shadow: inset 0 1px rgba(255, 255, 255, .03), 0 24px 70px rgba(0, 0, 0, .35);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}
.brand-mark {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--primary-grad);
  color: #fff;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  box-shadow: 0 4px 12px var(--primary-glow);
}
.brand-text {
  line-height: 1.2;
}
.brand-name {
  font-weight: 600;
  font-size: 14px;
}
.brand-sub {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--muted);
  border-radius: 10px;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover {
  background: var(--panel-2);
  color: var(--text);
}
.nav-item.active {
  color: var(--accent-foreground);
  background: linear-gradient(90deg, rgba(255, 255, 255, .11), rgba(255, 255, 255, .055));
  border: 1px solid rgba(255, 255, 255, .09);
  box-shadow: 0 5px 18px rgba(0, 0, 0, .25), inset 0 1px rgba(255, 255, 255, .08);
}
/* 浅色：图标+文字同色，柔和紫底，无边框，匹配图片里"Do"高亮态 */
[data-theme="light"] .nav-item.active {
  color: var(--primary);
  background: var(--primary-soft-strong);
  border-color: transparent;
  box-shadow: 0 2px 8px var(--primary-glow);
}
.nav-ico {
  flex: none;
}
.nav-label {
  flex: 1;
}
.sidebar-foot {
  border-top: 1px solid var(--border);
  padding-top: 12px;
  margin-top: 12px;
  position: relative;
}
.accent-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.accent-label {
  font-size: 11px;
  color: var(--muted);
}
.accent-swatches {
  display: flex;
  gap: 6px;
}
.accent-swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, .25);
  background: transparent;
  padding: 0;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: transform .15s ease, box-shadow .15s ease;
}
.accent-swatch i {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--swatch);
  box-shadow: inset 0 1px rgba(255, 255, 255, .4), 0 3px 8px rgba(0, 0, 0, .2);
}
.accent-swatch.active {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
.accent-swatch:hover {
  transform: translateY(-1px);
}
.skin-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 10px;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  margin-bottom: 10px;
}
.skin-btn:hover {
  background: var(--panel-2);
  color: var(--text);
}
.skin-pop {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 0;
  right: 0;
  z-index: 70;
  background: var(--panel-solid);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  padding: 8px;
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.skin-pop-title {
  font-size: 11px;
  color: var(--muted);
  padding: 2px 6px 6px;
}
.skin-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: none;
  background: transparent;
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.skin-item:hover {
  background: var(--panel-2);
}
.skin-item.active {
  background: var(--primary-soft);
  color: var(--primary);
}
.skin-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  flex: none;
  border: 1px solid rgba(255, 255, 255, .25);
  box-shadow: inset 0 1px rgba(255, 255, 255, .35);
}
.skin-name {
  flex: 1;
}
.skin-check {
  color: var(--primary);
  font-weight: 700;
}
/* ============= 主内容 ============= */
/* 整条"右侧滚动条"链路（DOM 由外到内；字段名 → 作用 → 是否会造成可见滚动条）：

  1. html / body                —— 文档根；本项目没有 body { overflow-y: scroll }，且 .layout 现已 overflow:hidden，故文档级/窗口级滚动条永不被强制显示。
  2. #app                       —— 根容器；min-height: 100vh；在 .layout 锁定 height:100vh 后，#app 也恰好 100vh，body 永不滚动。
  3. .layout                    —— display:grid；height:100vh（固定，非 min-height）；grid-template-rows: minmax(0,1fr)；overflow:hidden。
       ★ 真正根因修复点：之前用 min-height:100vh（非固定高度），当侧栏/指标内容高于视口时，layout 实际高度会 > 视口 →
         整页（而非 main 内部）出现"窗口级右侧滚动条"，它独立于任何模块内容，所以"所有模块看起来都有一条滚动条"。
         改为 height:100vh + overflow:hidden 后，layout 永远恰好等于视口、body 永不滚动，窗口级假滚动条消失。
  4. .main（用户看到的"右侧滚动条"容器）
       - 不再使用独立的 height: calc(100vh - 32px)。那会在 125%/150% 等比缩放下与 .layout 内容区产生 ~1px 亚像素错位，
         overflow-y:auto 永远判定"溢出" → 常驻滚动条（即"所有模块都有的问题"）。
       - 现在 .main 高度由 .layout 的 grid 行高（= 100vh - 32px）精确约束，与 .layout 同源计算、无亚像素错位。
       - overflow-y: auto + min-height:0 + align-self:stretch → 仅当"模块内容真的超过行高"时才出现滚动条（这是被保留的"正当内容溢出条"）。
  5. .content                   —— flex:1; min-height:0；不设 overflow，子项是各 view 组件。
       • 自身永远不出滚动条；各 view 内部有自己的 overflow-y:auto 元素（.rev-pre / .folder-default-list / .todo-body / .stack-wrap 等）
         —— 这些是"模块内正当滚动条"，本修复不触碰。
  6. 各 view 根（.ov / .review / .docout / .page）—— 多数只有 padding + flex column，没有 overflow，由内容撑高。
*/
.main {
  display: flex;
  flex-direction: column;
  gap: 16px;                /* gap: 块间距，不影响滚动条（与高度计算无关） */
  min-width: 0;
  /* align-self: stretch 覆盖 .layout { align-items: start }，使 .main 占满 grid 行高（即 100vh - 32px） */
  align-self: stretch;
  /* min-height: 0 关键：允许 main 收缩到 ≤ 行高，从而 overflow-y:auto 才能正确在"内容真正溢出"时出滚动条；
     若省略，flex 子项默认 min-height:auto 会按内容撑开，把 grid 行高顶爆 → main 出现主体滚动条。 */
  min-height: 0;
  /* overflow-y: auto：仅当 main 子项总高 > grid 行高（100vh - 32px）时才显示纵向滚动条——即"正当内容溢出条"。
     这是被保留的、用户认可的滚动条；本修复只消除"所有模块都有的窗口级假滚动条"（见 .layout 注释）。 */
  overflow-y: auto;
  /* scrollbar-gutter 显式置 auto：不滚动时不预留右侧槽位，避免"看似每个模块都有滚动条"的观感（默认即 auto）。 */
  scrollbar-gutter: auto;
  /* 不再使用独立的 height: calc(100vh - 32px)：那会与 layout 内容区在 125%/150% 等比缩放下产生 ~1px 亚像素错位，
     导致 overflow-y:auto 永远判定"溢出"而常驻滚动条——正是"所有模块都有的问题"。现在 main 高度由 grid 行高精确约束。 */
}
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--panel);
  backdrop-filter: blur(18px) saturate(150%);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}
[data-theme="dark"] .topbar {
  background: linear-gradient(145deg, rgba(17, 24, 21, .97), rgba(8, 13, 11, .98));
}
.search {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 6px 12px;
  color: var(--muted);
}
.search:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.search input {
  border: none;
  background: transparent;
  padding: 0;
  flex: 1;
  color: var(--text);
}
.search input:focus {
  box-shadow: none;
}
.search-ico {
  flex: none;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bell {
  position: relative;
  padding: 8px;
  border-radius: 10px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  color: var(--muted);
}
.bell:hover {
  background: var(--primary-soft);
  color: var(--primary);
}
.bell .dot {
  position: absolute;
  top: 2px;
  right: 4px;
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  border-radius: 999px;
  padding: 0 5px;
  min-width: 16px;
  text-align: center;
  font-weight: 600;
  line-height: 16px;
}
.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--primary-grad);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 13px;
  box-shadow: 0 4px 12px var(--primary-glow);
}
.content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ============= 右侧指标 ============= */
.metrics {
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: sticky;
  top: 16px;
  align-self: start;
  max-height: calc(100vh - 32px);   /* .layout 已 overflow:hidden；指标栏过高时自身内部滚动，避免被裁切 */
  overflow-y: auto;
  overscroll-behavior: contain;
  /* 指标卡只有 4 张，正常不需要滚动；仅在极端矮屏时内部滚动 */
}
.metric-head {
  padding: 4px 4px 8px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.metric-title {
  font-weight: 600;
  font-size: 14px;
}
.metric-date {
  margin-top: 4px;
  font-size: 11px;
}
/* 指标栏折叠按钮：与收起时的展开按钮同位置（右侧边缘、垂直居中），始终可见 */
.metric-collapse-btn {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 40;
  width: 26px;
  height: 48px;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 10px 0 0 10px;
  border: 1px solid var(--border);
  border-right: none;
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  box-shadow: -4px 0 14px rgba(0, 0, 0, .1);
  transition: opacity .18s ease, color .15s ease, background .15s ease;
}
.metric-collapse-btn.show {
  opacity: 1;
}
.metric-collapse-btn:hover {
  color: var(--primary);
  background: var(--primary-soft);
}
/* 指标栏收起时：右侧感应+按钮同一 wrap 容器，共同处理 hover，避免按钮遮挡导致 sense 触发 mouseleave（#2 修复） */
.metrics-edge-wrap {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 26px;
  z-index: 39;
}
/* 指标栏收起时，右侧边缘悬浮的展开按钮（相对 .metrics-edge-wrap 定位） */
.metrics-edge-btn {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 40;
  width: 26px;
  height: 48px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-right: none;
  border-radius: 10px 0 0 10px;
  background: var(--panel);
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  box-shadow: -4px 0 14px rgba(0, 0, 0, .1);
  transition: opacity .18s ease, color .15s ease, background .15s ease;
}
.metrics-edge-btn.show {
  opacity: 1;
}
.metrics-edge-btn:hover {
  color: var(--primary);
  background: var(--primary-soft);
}
.metric-card {
  position: relative;
  border-radius: var(--radius-xl);
  padding: 16px;
  display: grid;
  grid-template-columns: 38px 1fr auto;
  grid-template-areas:
    'icon body trend'
    'icon body sub';
  gap: 4px 12px;
  overflow: hidden;
}
.metric-icon {
  grid-area: icon;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--primary-soft);
  color: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  z-index: 1;
}
.metric-card.accent-success .metric-icon {
  background: var(--success-soft);
  color: var(--success);
}
.metric-card.accent-danger .metric-icon {
  background: var(--danger-soft);
  color: var(--danger);
}
.metric-body {
  grid-area: body;
  position: relative;
  z-index: 1;
}
.metric-label {
  font-size: 12px;
  color: inherit;
  opacity: 0.72;
  margin-bottom: 2px;
}
.metric-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.5px;
  color: inherit;
}
.metric-trend {
  grid-area: trend;
  font-size: 11px;
  font-weight: 600;
  align-self: start;
  padding: 2px 6px;
  border-radius: 999px;
  position: relative;
  z-index: 1;
}
.metric-trend.up {
  background: var(--success-soft);
  color: var(--success);
}
.metric-trend.down {
  background: var(--danger-soft);
  color: var(--danger);
}
.metric-trend.flat {
  background: var(--panel-2);
  color: var(--muted);
}
.metric-sub {
  grid-area: sub;
  font-size: 10px;
  color: inherit;
  opacity: 0.7;
  position: relative;
  z-index: 1;
}

/* 文档输出结果弹窗 */
.do-modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.55);
  backdrop-filter: blur(2px);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.do-modal {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 16px;
  width: min(560px, 100%);
  max-height: min(80vh, 600px);
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 60px rgba(0,0,0,.35);
}
.do-modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.do-modal-head h4 { margin: 0; font-size: 16px; flex: 1; }
.do-modal-icon { display: flex; }
.do-modal-icon.ok { color: var(--success); }
.do-modal-icon.fail { color: var(--danger); }
.do-modal-close {
  border: none;
  background: transparent;
  color: var(--muted);
  padding: 4px;
  cursor: pointer;
}
.do-modal-body {
  padding: 14px 16px;
  overflow: auto;
}
.do-modal-msg {
  margin: 0 0 12px;
  line-height: 1.6;
  color: var(--text);
}
.do-modal-steps {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.do-modal-steps li {
  font-size: 13px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: baseline;
  padding: 6px 8px;
  border-radius: 8px;
}
.do-modal-steps li.ok { color: var(--text-2); }
.do-modal-steps li.fail { background: var(--danger-soft); color: var(--danger); }
.do-step-no { font-variant-numeric: tabular-nums; }
.do-step-name { font-weight: 600; }
.do-step-err { color: var(--danger); }
.do-step-ok { color: var(--text-2); }
.do-modal-foot {
  padding: 12px 16px 16px;
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--border);
}
.do-modal-manual {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: var(--panel-2);
  border-radius: 10px;
  margin-bottom: 12px;
}
.do-modal-manual input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
}
.do-modal-diagnostics {
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  overflow: hidden;
}
.do-diag-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.do-modal-diagnostics pre {
  margin: 0;
  padding: 10px;
  max-height: 180px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-2);
}

/* ============= 皮肤：侧栏与主区表面跟随皮肤 ============= */
[data-skin="glass" i] .sidebar,
[data-skin="glass" i] .main,
[data-skin="aurora" i] .sidebar,
[data-skin="aurora" i] .main {
  background: var(--surface);
  border-color: var(--border);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  backdrop-filter: blur(18px) saturate(150%);
}
[data-skin="clean" i] .sidebar,
[data-skin="clean" i] .main {
  background: var(--surface);
  border-color: var(--border);
}

/* ============= 极简浅色（clean，参考图：白底极简）=============
 * 设计意图（桌面端 ≥721px）：
 *   - sidebar 为「悬浮条」：半透明玻璃 + 圆角 + 阴影，fixed 浮在主内容左侧，
 *     不占 grid 列 → main 全宽；
 *   - 展开态 220px 完整展示（品牌名/导航文字/换肤文字全部显示），
 *     收缩态 64px 纯图标列——由 sidebar-edge-btn 切换，文字显隐复用
 *     默认 .sidebar.collapsed 规则，无需重复定义；
 *   - main 全宽 + padding-left 跟随侧栏状态避让（展开 248 / 收缩 92）。
 *   - layout 自身成为大 panel 容器。
 * 移动端（<720px）完全走默认底部 Tab 布局。
 * 其它 3 皮肤（light/glass/aurora）完全不受影响。 */
@media (min-width: 721px) {
  [data-skin="clean" i] .layout {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 0;
    gap: 0;
    max-width: 100%;
    margin: 0;
    /* layout 撑满 viewport（与 light/glass/aurora 一致），让 main 内部 768px 的 view 不溢出滚动条；
       圆角+边框+阴影贴在 viewport 边是 clean 设计的"全幅 panel 容器"视觉，圆角被裁属预期 */
    min-height: 100vh;
    /* overflow 不再 hidden：main 需要内部滚动，layout 不能裁掉滚动条 */
    grid-template-columns: 1fr 240px; /* 侧栏悬浮不占列，main 全宽 */
  }
  /* clean 下 metrics 折叠同样收列（否则 clean 的 1fr 240px 会覆盖默认折叠规则，main 不扩展） */
  [data-skin="clean" i] .layout.metrics-collapsed {
    grid-template-columns: 1fr 0;
  }
  /* main 全宽 + 内边距跟随侧栏展开/收缩（悬浮条不占位，靠 padding-left 避让） */
  [data-skin="clean" i] .main {
    background: transparent !important;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    padding: 18px 24px;
    padding-left: 92px; /* 收缩态：64px 侧栏 + 28px 间距 */
    transition: padding-left .22s ease;
    /* clean 布局内边距为 0，main 由 .layout 的 grid 行高（=100vh）精确约束，无需独立 height */
  }
  [data-skin="clean" i] .sidebar:not(.collapsed) + .main {
    padding-left: 248px; /* 展开态：220px 侧栏 + 28px 间距 */
  }
  /* 悬浮侧栏条：磨砂玻璃浮在主内容左侧，主内容从后方透出（模糊） */
  [data-skin="clean" i] .sidebar {
    position: fixed;
    left: 16px;
    top: 16px;
    bottom: 16px;
    height: auto;
    z-index: 40;
    border-radius: 18px;
    border: 1px solid rgba(15,23,42,.08);
    background: rgba(255,255,255,.72);
    -webkit-backdrop-filter: blur(18px) saturate(150%);
    backdrop-filter: blur(18px) saturate(150%);
    box-shadow: 0 18px 48px rgba(15,23,42,.10), 0 4px 14px rgba(15,23,42,.06);
    padding: 18px 14px;
  }
}

/* ============= 玻璃 / 极光：折叠态全高悬浮条（同 clean）=============
 * 与 clean 一致：≥721px 时 sidebar 改为 fixed 全高悬浮，不占 grid 列，
 * main 全宽 + padding-left 避让（展开 248 / 收缩 92）。
 * 解决折叠态被模块内容压下、看不全的问题。
 * 与 clean 的差异：保留玻璃/极光自身的 --surface 与 backdrop-filter
 * （不改成白底），main 高度沿用基准 calc(100vh-32px)（layout 仍有 16px 内边距）。 */
@media (min-width: 721px) {
  [data-skin="glass" i] .layout,
  [data-skin="aurora" i] .layout {
    grid-template-columns: 1fr 240px;
  }
  [data-skin="glass" i] .layout.metrics-collapsed,
  [data-skin="aurora" i] .layout.metrics-collapsed {
    grid-template-columns: 1fr 0;
  }
  [data-skin="glass" i] .main,
  [data-skin="aurora" i] .main {
    /* 保留玻璃/极光自身的 surface + backdrop-filter，仅避让悬浮侧栏 */
    padding: 18px 24px;
    padding-left: 92px;
    transition: padding-left .22s ease;
  }
  [data-skin="glass" i] .sidebar:not(.collapsed) + .main,
  [data-skin="aurora" i] .sidebar:not(.collapsed) + .main {
    padding-left: 248px;
  }
  [data-skin="glass" i] .sidebar,
  [data-skin="aurora" i] .sidebar {
    position: fixed;
    left: 16px;
    top: 16px;
    bottom: 16px;
    height: auto;
    z-index: 40;
  }
}

/* ============= 浅色（默认）：折叠态全高悬浮条（同 clean / 玻璃 / 极光）=============
 * 浅色皮肤不设 data-skin，故用 [data-theme="light"]:not([data-skin]) 精确命中，不误伤 clean。
 * 与另三皮肤一致：≥721px 时 sidebar 改为 fixed 全高悬浮，不占 grid 列，
 * main 全宽 + padding-left 避让（展开 248 / 收缩 92），不被模块内容压下、看不全。 */
@media (min-width: 721px) {
  [data-theme="light"]:not([data-skin]) .layout {
    grid-template-columns: 1fr 240px;
  }
  [data-theme="light"]:not([data-skin]) .layout.metrics-collapsed {
    grid-template-columns: 1fr 0;
  }
  [data-theme="light"]:not([data-skin]) .main {
    /* 浅色自身 surface，仅避让悬浮侧栏；main 高度沿用基准 calc(100vh-32px) */
    padding: 18px 24px;
    padding-left: 92px;
    transition: padding-left .22s ease;
  }
  [data-theme="light"]:not([data-skin]) .sidebar:not(.collapsed) + .main {
    padding-left: 248px;
  }
  [data-theme="light"]:not([data-skin]) .sidebar {
    position: fixed;
    left: 16px;
    top: 16px;
    bottom: 16px;
    height: auto;
    z-index: 40;
  }
}
</style>
