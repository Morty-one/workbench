<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import * as XLSX from 'xlsx-js-style'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { db } from '../db'

const records = ref([])
const selMonth = ref(ymd(new Date().getFullYear(), new Date().getMonth(), 1).slice(0, 7)) // 'YYYY-MM'，日历当前月
const viewYear = computed(() => Number(selMonth.value.slice(0, 4)))
const viewMonth = computed(() => Number(selMonth.value.slice(5, 7)) - 1) // 0-11
const showSet = ref(null) // null = 全部人员
const selectedDay = ref(null)
const todayStr = ymd(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())
// 统计 / 筛选状态
const filterMode = ref('all') // all | month | range
const rangeStart = ref('')
const rangeEnd = ref('')
const selShift = ref('all') // all | 主班 | 副班 | 周末白班
const markPast = ref(false) // 标记已过去日期（删除线/置灰，仍占位）
const showStats = ref(false) // 值班统计面板折叠状态（默认折叠，点「统计」按钮展开）
const showActions = ref(false) // 操作面板折叠
const calPeople = ref(3) // 日历模板人数：2 或 3（下载时可选）
const editMode = ref(false) // 编辑排班模式
const dayPanelDate = ref(null) // 编辑模式下点击日期格打开的当日排班面板
const addingRecord = ref(false) // 编辑面板内「添加排班」表单显隐
const newRecord = ref({ date: '', person: '', shift: '', remark: '', workContent: '' })
const showClearDialog = ref(false)
const clearMode = ref('all') // 'all' | 'person' | 'date'
const clearSelectedPersons = ref(new Set())
const clearDateStart = ref('')
const clearDateEnd = ref('')
const showEditDialog = ref(false)
const editingRecord = ref(null)

/* ---------- 筛选状态持久化：展示人员 / 班次筛选 / 标记已过去 ---------- */
const DUTY_STATE_KEYS = {
  showSet: 'wb_duty_showSet',
  selShift: 'wb_duty_selShift',
  markPast: 'wb_duty_markPast'
}
function saveDutyState() {
  try {
    localStorage.setItem(DUTY_STATE_KEYS.showSet, JSON.stringify(showSet.value ? [...showSet.value] : null))
    localStorage.setItem(DUTY_STATE_KEYS.selShift, selShift.value)
    localStorage.setItem(DUTY_STATE_KEYS.markPast, markPast.value ? '1' : '0')
  } catch { /* localStorage 不可用时忽略 */ }
}
function loadDutyState() {
  try {
    const s = JSON.parse(localStorage.getItem(DUTY_STATE_KEYS.showSet) || 'null')
    if (Array.isArray(s) && s.length) showSet.value = new Set(s)
    const sh = localStorage.getItem(DUTY_STATE_KEYS.selShift)
    if (sh) selShift.value = sh
    markPast.value = localStorage.getItem(DUTY_STATE_KEYS.markPast) === '1'
  } catch { /* 解析失败保持默认 */ }
}
watch([showSet, selShift, markPast], saveDutyState, { deep: true })

const HELP_TIP = '支持两种格式，任选其一：① 长表——含「日期 / 姓名 / 班次 / 备注 / 工作内容」列，多人同日可多行；② 日历矩阵——日期横排、每人「出勤√ + 班次时间」三行块（即你提供的考勤表样式）。数据仅存本地。'

const persons = computed(() => {
  const s = new Set(records.value.map((r) => r.person).filter(Boolean))
  return [...s]
})
function isShown(p) {
  return showSet.value === null || showSet.value.has(p)
}

/* ---------- 人员底色（localStorage 持久化，界面可调） ---------- */
const COLORS_KEY = 'wb_duty_colors'
// 精选固定配色（好看、彼此可区分，浅色/深色主题均适用）
const FIXED_PALETTE = [
  '#6366f1', // 靛蓝
  '#0ea5e9', // 天蓝
  '#10b981', // 翠绿
  '#14b8a6', // 青绿
  '#f59e0b', // 琥珀
  '#fb7185', // 玫瑰
  '#ec4899', // 粉
  '#a855f7', // 紫
  '#f97316', // 橙
  '#64748b' // 石板灰
]
const DEFAULT_COLORS = FIXED_PALETTE
const colorMap = ref({})
const editingColors = ref(false)
function loadColors() {
  try {
    colorMap.value = JSON.parse(localStorage.getItem(COLORS_KEY) || '{}')
  } catch {
    colorMap.value = {}
  }
}
function colorFor(p) {
  if (colorMap.value[p]) return colorMap.value[p]
  const i = Math.max(0, persons.value.indexOf(p))
  return DEFAULT_COLORS[i % DEFAULT_COLORS.length]
}
function setColor(p, hex) {
  colorMap.value = { ...colorMap.value, [p]: hex }
  localStorage.setItem(COLORS_KEY, JSON.stringify(colorMap.value))
}
function resetColors() {
  colorMap.value = {}
  localStorage.removeItem(COLORS_KEY)
}
// 依据底色亮度返回适配文字色（保证对比度）
function textOn(hex) {
  const c = (hex || '#000000').replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? '#1f2937' : '#ffffff'
}

/* ---------- 班次类型（固定类别，主班/副班/周末白班/休班） ---------- */
const SHIFT_TYPES = [
  { key: '主班', match: ['9:00-c9:00', '主班'] },
  { key: '副班', match: ['9:00-18:00', '副班'] },
  { key: '周末白班', match: ['9:00-20:30', '周末白班'] },
  { key: '休班', match: ['休', '休班', '休息', '休息日', '调休', '请假', 'X', 'x'] }
]
const SHIFT_COLOR = { 主班: '#6366f1', 副班: '#10b981', 周末白班: '#f59e0b', 休班: '#94a3b8', 其他: '#94a3b8' }
function shiftKeyOf(shift) {
  const s = (shift || '').trim()
  const t = SHIFT_TYPES.find((t) => t.match.includes(s))
  return t ? t.key : '其他'
}
function shiftColor(key) {
  return SHIFT_COLOR[key] || '#94a3b8'
}
function inTime(r) {
  if (filterMode.value === 'month') return r.date.startsWith(selMonth.value)
  if (filterMode.value === 'range') {
    if (rangeStart.value && r.date < rangeStart.value) return false
    if (rangeEnd.value && r.date > rangeEnd.value) return false
    return true
  }
  return true
}
function inShift(r) {
  if (selShift.value === 'all') return true
  return shiftKeyOf(r.shift) === selShift.value
}

async function load() {
  records.value = await db.duty.toArray()
}
/* ---------- 休班推导（虚拟记录，不落库） ----------
 * 考勤表里休息日通常是「空格子」，导入时被跳过，数据库中不存在休班记录。
 * 因此休班在视图层推导：按月划定考勤范围，某人在该月的某个考勤日没有任何
 * 排班记录 => 视为休班。这样已导入的数据无需重新导入即可生效。
 *   - 考勤日集合 = 该月出现过排班的所有日期（没数据的日期不瞎猜）
 *   - 参与人员   = 该月出现过排班的所有人（避免离职/未入职者被算休班）
 */
const restRecords = computed(() => {
  const byMonth = {}
  for (const r of records.value) {
    if (!r.date || !r.person) continue
    const mk = String(r.date).slice(0, 7)
    if (!byMonth[mk]) byMonth[mk] = { dates: new Set(), people: new Set(), has: new Set() }
    byMonth[mk].dates.add(r.date)
    byMonth[mk].people.add(r.person)
    byMonth[mk].has.add(r.date + '|' + r.person)
  }
  const out = []
  for (const mk in byMonth) {
    const { dates, people, has } = byMonth[mk]
    for (const d of [...dates].sort()) {
      for (const p of people) {
        if (has.has(d + '|' + p)) continue
        out.push({
          id: `rest:${d}:${p}`,
          date: d,
          person: p,
          shift: '休班',
          remark: '',
          workContent: '',
          _virtual: true
        })
      }
    }
  }
  return out
})
// 统计口径：真实记录 + 推导出的休班
const statRecords = computed(() => [...records.value, ...restRecords.value])

function byDate(dateStr) {
  const real = records.value.filter((r) => r.date === dateStr && isShown(r.person) && inShift(r))
  // 仅在「只看休班」时把推导记录混入日历，避免 all 模式下每格塞满休班
  if (selShift.value !== '休班') return real
  const virt = restRecords.value.filter((r) => r.date === dateStr && isShown(r.person))
  return [...real, ...virt]
}

/* 人员多选筛选：选中的人参与统计与日历展示；null = 全部 */
function inPerson(r) {
  if (showSet.value === null) return true
  return showSet.value.has(r.person)
}
// 班次类型固定排序权重：主班 → 副班 → 周末白班 → 其他(末尾)
function shiftOrder(key) {
  const i = SHIFT_TYPES.findIndex((t) => t.key === key)
  return i < 0 ? 999 : i
}

/* ---------- 值班统计（按时间 + 班次类型 + 人员多选筛选） ---------- */
// 仅保留「人员 × 班次 明细」一项；其它按需显示，无默认统计
const personShiftStats = computed(() => {
  const map = {}
  for (const r of statRecords.value) {
    if (!r.person || !inTime(r) || !inShift(r) || !inPerson(r)) continue
    const k = shiftKeyOf(r.shift)
    const id = `${r.person}·${k}`
    if (!map[id]) map[id] = { id, person: r.person, shiftKey: k, count: 0, hours: 0 }
    map[id].count++
    const m = String(r.remark || '').match(/工时\s*([\d.]+)\s*h/i)
    if (m) map[id].hours += parseFloat(m[1])
  }
  return Object.values(map)
    .map((s) => ({ ...s, hours: Math.round(s.hours * 10) / 10 }))
    .sort((a, b) => {
      const pi = persons.value.indexOf(a.person)
      const pj = persons.value.indexOf(b.person)
      if (pi !== pj) return pi - pj
      return shiftOrder(a.shiftKey) - shiftOrder(b.shiftKey)
    })
})
const maxPSCount = computed(() => Math.max(1, ...personShiftStats.value.map((s) => s.count)))
// 休班天数合计（受时间 / 人员多选筛选影响；刻意不受 selShift 影响，
// 否则筛「主班」时这里会归零，作为汇总指标反而无意义）
const restDays = computed(
  () =>
    statRecords.value.filter(
      (r) => r.person && shiftKeyOf(r.shift) === '休班' && inTime(r) && inPerson(r)
    ).length
)

const timeLabel = computed(() => {
  if (filterMode.value === 'month') return selMonth.value + ' 月'
  if (filterMode.value === 'range') return `${rangeStart.value || '…'} ~ ${rangeEnd.value || '…'}`
  return '全部时间'
})

/* ---------- 日历 ---------- */
const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] // 周一为每周首列
// 将可能越界的 (年, 月) 归一化（m 允许 -1 / 12）
function adjYM(y, m) {
  if (m < 0) return [y - 1, 11]
  if (m > 11) return [y + 1, 0]
  return [y, m]
}
const calendar = computed(() => {
  const y = viewYear.value
  const m = viewMonth.value
  const first = new Date(y, m, 1).getDay() // 0=周日 .. 6=周六
  const lead = (first + 6) % 7 // 周一为首列时的前置天数
  const days = new Date(y, m + 1, 0).getDate()
  const cells = []
  // 前置：上月末尾日期（真实日期，灰色显示）
  const [py, pm] = adjYM(y, m - 1)
  const prevDays = new Date(py, pm + 1, 0).getDate()
  for (let k = lead; k >= 1; k--) {
    const d = prevDays - k + 1
    cells.push({ d, other: true, dateStr: ymd(py, pm, d) })
  }
  // 本月日期
  for (let d = 1; d <= days; d++) cells.push({ d, other: false, dateStr: ymd(y, m, d) })
  // 后置：下月初日期补齐最后一整周（真实日期，灰色显示）
  const rem = cells.length % 7
  if (rem !== 0) {
    const need = 7 - rem
    const [ny, nm] = adjYM(y, m + 1)
    for (let k = 1; k <= need; k++) cells.push({ d: k, other: true, dateStr: ymd(ny, nm, k) })
  }
  return cells
})
// 当日若有备注，拼接成悬浮提示文本（用于角落小图标）
function dayRemark(dateStr) {
  return byDate(dateStr)
    .map((r) => r.remark)
    .filter(Boolean)
    .join('；')
}
function ymd(y, m, d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${y}-${p(m + 1)}-${p(d)}`
}
function stepMonth(delta) {
  const [y, m] = selMonth.value.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  selMonth.value = ymd(d.getFullYear(), d.getMonth(), 1).slice(0, 7)
  selectedDay.value = null
}
function prevMonth() {
  stepMonth(-1)
}
function nextMonth() {
  stepMonth(1)
}
function pickDay(c) {
  if (editMode.value) {
    dayPanelDate.value = dayPanelDate.value === c.dateStr ? null : c.dateStr
    return
  }
  selectedDay.value = selectedDay.value === c.dateStr ? null : c.dateStr
}
function isWeekend(idx) {
  // 周一为首列：周六=5，周日=6
  return idx % 7 === 5 || idx % 7 === 6
}

/* ---------- 节假日提示（2026 法定假日内置；可在设置中增删自定义） ---------- */
// 2026 年国务院办公厅放假安排（仅法定假日，不含调休补班日）
const BUILTIN_HOLIDAYS = [
  { start: '2026-01-01', end: '2026-01-03', name: '元旦' },
  { start: '2026-02-15', end: '2026-02-23', name: '春节' },
  { start: '2026-04-04', end: '2026-04-06', name: '清明节' },
  { start: '2026-05-01', end: '2026-05-05', name: '劳动节' },
  { start: '2026-06-19', end: '2026-06-21', name: '端午节' },
  { start: '2026-09-25', end: '2026-09-27', name: '中秋节' },
  { start: '2026-10-01', end: '2026-10-07', name: '国庆节' }
]
// 自定义节假日（用户增删，持久化到 db.settings 'holidays'）：[{ date, name }]
const customHolidays = ref([])
const holidayManageOpen = ref(false)
const newHolidayDate = ref('')
const newHolidayName = ref('')
async function loadHolidays() {
  const rec = await db.settings.get('holidays')
  customHolidays.value = rec && Array.isArray(rec.value) ? rec.value : []
}
// dateStr -> { name, custom }；内置法定假日 + 自定义
const holidayMap = computed(() => {
  const m = new Map()
  for (const h of BUILTIN_HOLIDAYS) {
    let d = h.start
    while (d <= h.end) {
      m.set(d, { name: h.name, custom: false })
      const [y, mo, da] = d.split('-').map(Number)
      const nx = new Date(y, mo - 1, da + 1)
      d = ymd(nx.getFullYear(), nx.getMonth(), nx.getDate())
    }
  }
  for (const c of customHolidays.value) {
    if (c && c.date) m.set(c.date, { name: c.name || '节假日', custom: true })
  }
  return m
})
function holidayName(dateStr) {
  const h = holidayMap.value.get(dateStr)
  return h ? h.name : ''
}
function isCustomHoliday(dateStr) {
  const h = holidayMap.value.get(dateStr)
  return !!(h && h.custom)
}
async function addCustomHoliday() {
  const date = (newHolidayDate.value || '').trim()
  const name = (newHolidayName.value || '').trim()
  if (!date) return
  const exists = customHolidays.value.some((c) => c.date === date)
  const next = exists
    ? customHolidays.value.map((c) => (c.date === date ? { date, name: name || c.name } : c))
    : [...customHolidays.value, { date, name }]
  customHolidays.value = next
  await db.settings.put({ key: 'holidays', value: next })
  newHolidayDate.value = ''
  newHolidayName.value = ''
}
async function removeCustomHoliday(dateStr) {
  const next = customHolidays.value.filter((c) => c.date !== dateStr)
  customHolidays.value = next
  await db.settings.put({ key: 'holidays', value: next })
}

/* ---------- Excel 导入（自动识别两种格式） ---------- */
function serialToDate(s) {
  const d = new Date((s - 25569) * 86400 * 1000)
  return ymd(d.getFullYear(), d.getMonth(), d.getDate())
}
function dateToSerial(y, m, d) {
  return Math.round(new Date(y, m, d).getTime() / 86400000) + 25569
}
function parseDate(v) {
  if (v == null || v === '') return ''
  if (typeof v === 'number' && v > 20000) return serialToDate(v)
  const d = new Date(v)
  if (!isNaN(d.getTime())) return ymd(d.getFullYear(), d.getMonth(), d.getDate())
  return String(v)
}
function pick(v, keys) {
  for (const k of keys) if (v[k] !== undefined && v[k] !== '') return String(v[k]).trim()
  return ''
}

// 找所有日期表头行：含 ≥3 个 Excel 日期序列号（>40000）的行（支持多块堆叠）
function findAllDateHeaders(grid) {
  const list = []
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i]
    if (!row) continue
    const map = {}
    let n = 0
    for (let j = 0; j < row.length; j++) {
      const v = row[j]
      if (typeof v === 'number' && v > 40000 && v < 70000) {
        map[j] = serialToDate(v)
        n++
      }
    }
    if (n >= 3) list.push({ rowIdx: i, map, cols: Object.keys(map).map(Number) })
  }
  return list
}

const NAME_BLACKLIST = ['入职日期', '部门', '员工考勤表', '年', '月', '姓名']
function isPersonName(s) {
  if (typeof s !== 'string' || !s.trim()) return false
  const t = s.trim()
  if (NAME_BLACKLIST.includes(t)) return false
  if (/^\d+$/.test(t)) return false
  return t.length <= 8
}

// 日历矩阵解析：日期横排 + 每人 3 行（出勤√ / 班次时间 / 工时），支持多个堆叠块
function parseCalendar(grid) {
  const headers = findAllDateHeaders(grid)
  if (!headers.length) return null
  const out = []
  for (let ri = 0; ri < grid.length; ri++) {
    const row = grid[ri]
    if (!row || !isPersonName(row[1])) continue
    // 找到该人员所属的最近日期表头块（其上方最近的表头行）
    let hdr = null
    for (const h of headers) {
      if (h.rowIdx < ri && (!hdr || h.rowIdx > hdr.rowIdx)) hdr = h
    }
    if (!hdr) continue
    const name = row[1].trim()
    let hasMark = false
    for (const c of hdr.cols) if (row[c] != null && String(row[c]).trim() !== '') hasMark = true
    if (!hasMark) continue
    for (const c of hdr.cols) {
      const mark = row[c]
      if (mark == null || String(mark).trim() === '') continue
      const shift = grid[ri + 1] ? grid[ri + 1][c] : ''
      const hours = grid[ri + 2] ? grid[ri + 2][c] : ''
      out.push({
        date: hdr.map[c],
        person: name,
        shift: shift != null ? String(shift).trim() : '',
        remark: hours != null && hours !== '' && !isNaN(Number(hours)) ? `工时 ${Number(hours)}h` : '',
        workContent: ''
      })
    }
  }
  return out
}

// 长表解析（退回方案）
function parseLong(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  return rows
    .map((r) => ({
      date: parseDate(pick(r, ['日期', 'date', 'Date'])),
      person: pick(r, ['姓名', '值班人', 'person', 'Name']),
      shift: pick(r, ['班次', 'shift', 'Shift']),
      remark: pick(r, ['备注', 'remark', 'Remark']),
      workContent: pick(r, ['工作内容', 'workContent', 'WorkContent'])
    }))
    .filter((r) => r.date && r.person)
}

async function importExcel(e) {
  const file = e.target.files[0]
  if (!file) return
  try {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null })
    const cal = parseCalendar(grid)
    const mapped = cal && cal.length ? cal : parseLong(sheet)
    if (!mapped.length)
      return alert(
        '未识别到有效数据。支持两种格式：\n① 长表：日期/姓名/班次/备注/工作内容\n② 日历矩阵：日期横排、每人出勤√+班次时间（即你的考勤表样式）'
      )
    // 跳过与本地已存在的完全相同记录，避免重复导入
    const existing = await db.duty.toArray()
    const seen = new Set(existing.map((r) => `${r.date}|${r.person}|${r.shift}|${r.remark}`))
    const fresh = mapped.filter((r) => !seen.has(`${r.date}|${r.person}|${r.shift}|${r.remark}`))
    if (!fresh.length) return alert('没有新增记录（数据可能已导入过相同内容）。')
    await db.duty.bulkAdd(fresh)
    await load()
    alert(`已导入 ${fresh.length} 条值班记录（已自动跳过 ${mapped.length - fresh.length} 条重复）。`)
  } catch (err) {
    alert('导入失败：' + err.message)
  } finally {
    e.target.value = ''
  }
}
async function clearAll() {
  if (!confirm('将清空全部值班记录，建议先导出备份。确认？')) return
  await db.duty.clear()
  await load()
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
function downloadTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['日期', '姓名', '班次', '备注', '工作内容'],
    ['2026-08-03', '张三', '早班', '负责晨会', '检查服务器状态'],
    ['2026-08-03', '李四', '晚班', '', '夜间巡检']
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '值班表')
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  saveBlob('值班表模板.xlsx', buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
}
// 日历矩阵模板（完全复刻你提供的考勤表结构：标题 / 部门 / 入职日期列 /
// 日期横排 / 每人「出勤√ / 班次时间 / 工时」三行 / 合计·病·事·伤 汇总列 / 跨月拆两块）
// 给整张表加黑色细边框 + 水平垂直居中；日期序列号列套日期格式
// 日历矩阵模板：完全复刻「天津热燃中心考勤统计表」的视觉格式
// 字体：微软雅黑（标题18粗 / 表头9粗 / 数据8常规）；入职日期值用宋体9
// 填充：表头区浅橙 FFFDE9D9，数据区金黄 FFFFC000，汇总数据白 FFFFFFFF
// 列宽 / 行高 / 合并均按原表；默认导出当前日程管理所在月份（切到哪月就导出哪月）
// 预填 3 个班次示例（主班 / 副班 / 周末白班），其余单元格为空
// people：日历模板人数（2 或 3），姓名/合并块/汇总公式均按人数动态生成
// people：日历模板人数（2 或 3）；dataRecords：导出时传入系统内实际排班（按当前月份筛选后的数组），
// 为空则生成空白模板（预填 3 个示例班次）。姓名来源：导出取系统实际人员，空白模板用固定三人。
function buildCalTemplateSheet(people = 3, dataRecords = null) {
  const y = viewYear.value
  const m = viewMonth.value
  const days = new Date(y, m + 1, 0).getDate()
  const FIXED_NAMES = ['张达', '孟帅', '卢敬华']
  let names
  if (dataRecords) {
    const seen = []
    for (const r of dataRecords) if (r.person && !seen.includes(r.person)) seen.push(r.person)
    const eff = Math.min(people, seen.length)   // 实际人员不足时如实缩减行数，不臆造空姓名行
    names = seen.slice(0, eff)
    people = eff
  } else {
    names = FIXED_NAMES.slice(0, people)
  }
  const blk2end = days - 17            // 0-indexed col of last block2 date (day=days -> col days-17)
  const sum0 = blk2end + 1             // 合计 紧跟最后一个日期列右侧
  const colCount = Math.max(26, sum0 + 5)
  const empty = () => new Array(colCount).fill('')
  const YH = '微软雅黑'
  const colLetter = (i) => { let s = ''; i += 1; while (i > 0) { const mm = (i - 1) % 26; s = String.fromCharCode(65 + mm) + s; i = Math.floor((i - 1) / 26) } return s }
  const wkOf = (d) => { const wd = new Date(y, m, d).getDay(); return ['日', '一', '二', '三', '四', '五', '六'][wd] }

  const B = () => ({ top: { style: 'thin', color: { rgb: 'FF000000' } }, left: { style: 'thin', color: { rgb: 'FF000000' } }, bottom: { style: 'thin', color: { rgb: 'FF000000' } }, right: { style: 'thin', color: { rgb: 'FF000000' } } })
  const NB = () => ({})
  const C = { horizontal: 'center', vertical: 'center' }
  const sTitle = { font: { name: YH, sz: 18, bold: true, color: { rgb: 'FF000000' } }, alignment: C }
  const sDept = { font: { name: YH, sz: 12, bold: true, color: { rgb: 'FF000000' } }, alignment: C }
  const sHeader = { font: { name: YH, sz: 9, bold: true, color: { rgb: 'FF000000' } }, fill: { fgColor: { rgb: 'FFFDE9D9' } }, alignment: C, border: B() }
  const sWeekday = { ...sHeader, numFmt: '[$-804]aaa;@' }
  const sDate = { ...sHeader, numFmt: 'm/d;@' }
  // 姓名/入职日期数据单元格：无框线（仅保留字体/对齐）
  const sName = { font: { name: YH, sz: 9, color: { rgb: 'FF000000' } }, alignment: C, border: B() }
  const sJoin = { font: { name: '宋体', sz: 9, color: { rgb: 'FF000000' } }, alignment: C, border: B() }
  const sData = { font: { name: YH, sz: 8, color: { rgb: 'FF000000' } }, alignment: C, border: B() }
  const sSumD = { font: { name: YH, sz: 9, color: { rgb: 'FF000000' } }, fill: { fgColor: { rgb: 'FFFFFFFF' } }, alignment: C, border: B() }

  const JOIN_DATE = '2023/11/6'
  const joinDateFor = (p) => p < 2 ? JOIN_DATE : ''

  const rows = []
  rows.push(empty())                                                  // R1 间隔
  const t = empty(); t[3] = '2026'; t[6] = '年'; t[7] = String(m + 1); t[9] = '月'; t[10] = '员工考勤表'; rows.push(t) // R2 标题
  const d3 = empty(); d3[1] = '部门：'; rows.push(d3)                   // R3 部门
  rows.push(empty())                                                  // R4 间隔
  const r5 = empty(); r5[1] = '姓名'; r5[2] = '入职日期'                // R5 第一块星期表头
  for (let d = 1; d <= 19; d++) r5[2 + d] = wkOf(d)
  rows.push(r5)
  const r6 = empty()                                                  // R6 第一块日期
  for (let d = 1; d <= 19; d++) r6[2 + d] = dateToSerial(y, m, d)
  rows.push(r6)
    // 第一块：各人三行（出勤√ / 值班时长 / 工时），示例分摊到各人
  const SAMPLES = [
    { p: 0, c: 3, shift: '9:00-c9:00', hours: 24 },   // 张达 day1
    { p: 1, c: 4, shift: '9:00-18:00', hours: 8 },    // 孟帅 day2
    { p: 2, c: 5, shift: '9:00-20:30', hours: 10.5 }  // 卢敬华 day3（10.5 触发橙色）
  ]
  const b1base = Array.from({ length: people }, (_, i) => 6 + i * 3)
  for (let p = 0; p < people; p++) {
    const at = empty(); at[1] = names[p]; at[2] = dataRecords ? '' : joinDateFor(p)
    const sh = empty(); const ho = empty()
    if (!dataRecords) {
      const s = SAMPLES.find(x => x.p === p)
      if (s) { at[s.c] = '√'; sh[s.c] = s.shift; ho[s.c] = s.hours }
    }
    rows.push(at); rows.push(sh); rows.push(ho)
  }
  rows.push(empty()); rows.push(empty())                             // R16,R17 两块之间间隔
  const r18 = empty(); r18[1] = '姓名'; r18[2] = '入职日期'; r18[sum0] = '合计' // R18 第二块星期表头
  for (let d = 20; d <= days; d++) r18[d - 17] = wkOf(d)
  rows.push(r18)
  const r19 = empty()                                                // R19 第二块日期
  for (let d = 20; d <= days; d++) r19[d - 17] = dateToSerial(y, m, d)
  r19[sum0] = '出勤'; r19[sum0 + 1] = '病'; r19[sum0 + 2] = '事'; r19[sum0 + 3] = '伤'
  rows.push(r19)
  const b2base = Array.from({ length: people }, (_, i) => 10 + 3 * people + 3 * i)
  // 随人数变化的行边界（0-indexed）：第一块底 / 第二块顶 / 第二块底
  const b1botR = 5 + 3 * people
  const b2topR = 8 + 3 * people
  const b2botR = 9 + 6 * people
  for (let p = 0; p < people; p++) {                                 // 第二块：按人数生成
    const at = empty(); at[1] = names[p]; at[2] = dataRecords ? '' : joinDateFor(p)
    rows.push(at); rows.push(empty()); rows.push(empty())
  }

  // 导出模式：把系统内实际排班写入对应单元格（出勤√ / 班次时间 / 工时）
  // 列映射与表头一致：第1~19日落在第一块（列号 = 日 + 2），第20日~月末落在第二块（列号 = 日 - 17）
  if (dataRecords) {
    const pIndex = {}
    names.forEach((nm, i) => { pIndex[nm] = i })
    for (const r of dataRecords) {
      const pi = pIndex[r.person]
      if (pi === undefined) continue        // 不在所选人数范围内的人员跳过
      const mm = String(r.date).match(/(\d{4})-(\d{2})-(\d{2})/)
      if (!mm) continue
      const d = Number(mm[3])
      if (d < 1 || d > days) continue
      const col = d <= 19 ? d + 2 : d - 17
      const atR = d <= 19 ? b1base[pi] : b2base[pi]
      const shR = atR + 1
      const hoR = atR + 2
      if (shiftKeyOf(r.shift) === '休班') continue   // 休班在考勤表即空格子，留空
      rows[atR][col] = '√'
      rows[shR][col] = r.shift || ''
      const mh = String(r.remark || '').match(/工时\s*([\d.]+)\s*h/i)
      rows[hoR][col] = mh ? Number(mh[1]) : ''
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  // SheetJS 写列宽会固定叠加 0.83203125，这里扣掉以精确匹配原表显示宽度
  const K = 0.83203125
  const W = (w) => ({ wch: w - K })
  const cols = []
  cols[0] = W(1.16); cols[1] = W(7.67); cols[2] = W(8.16)
  for (let c = 3; c <= blk2end; c++) cols[c] = W(8.0)     // D..月末日期列
  for (let c = sum0; c <= sum0 + 3; c++) cols[c] = W(9.0) // 合计/出勤/病/事/伤
  ws['!cols'] = cols
  ws['!rows'] = (() => {
    const rh = []
    rh[0] = { hpt: 5.25 }; rh[1] = { hpt: 29.05 }; rh[2] = { hpt: 20.25 }; rh[3] = { hpt: 3.75 }
    for (let r = 4; r <= b1botR; r++) rh[r] = { hpt: 24 }   // 第一块（含表头）整段 24
    for (let r = b2topR; r <= b2botR; r++) rh[r] = { hpt: 24 } // 第二块（含表头）整段 24
    return rh                                                  // 两块之间的间隔行留默认高度
  })()
  const M = (r1, c1, r2, c2) => ({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } })
  const merges = [
    M(1, 3, 1, 5), M(1, 7, 1, 8), M(1, 10, 1, 14),       // 标题
    M(2, 3, 2, 5),                                         // D3:F3
    M(4, 1, 5, 1), M(4, 2, 5, 2),                         // 第一块 姓名/入职日期 跨两行
    M(b2topR, 1, b2topR + 1, 1), M(b2topR, 2, b2topR + 1, 2), // 第二块 姓名/入职日期 跨两行
    M(b2topR, sum0, b2topR, sum0 + 3)                      // 合计 合并右侧 3 个单元格（共 4 列）
  ]
  for (const b of b1base) { merges.push(M(b, 1, b + 2, 1)); merges.push(M(b, 2, b + 2, 2)) }
  for (const b of b2base) {
    merges.push(M(b, 1, b + 2, 1)); merges.push(M(b, 2, b + 2, 2))
    for (let k = 0; k < 4; k++) merges.push(M(b, sum0 + k, b + 2, sum0 + k))
  }
  ws['!merges'] = merges

  // 橙色规则：工时=10.5 的当天三行（出勤/时长/工时）整列标金黄 FFFC000，其余无填充
  const personBlockRows = [...b1base, ...b2base]
  const dataFill = (r, c) => {
    let start = -1
    for (const s of personBlockRows) if (r >= s && r <= s + 2) { start = s; break }
    if (start < 0) return null
    const hv = rows[start + 2][c]
    if (typeof hv === 'number' && hv === 10.5) return { fgColor: { rgb: 'FFFFC000' } }
    return null
  }
  const styleAt = (r, c) => {
    if (r === 0 || r === 3) return null
    if (r === 1) return ([3, 6, 7, 9, 10].includes(c)) ? sTitle : null
    if (r === 2) return c === 1 ? sDept : null
    // 第一块表头：姓名/入职日期跨两行（r=4,5），日期/星期各占一行
    if (r === 4 || r === 5) {
      if (c === 1 || c === 2) return sHeader
      if (r === 4 && c >= 3 && c <= 21) return sWeekday
      if (r === 5 && c >= 3 && c <= 21) return sDate
      return null
    }
    // 第二块表头
    if (r === b2topR || r === b2topR + 1) {
      if (c === 1 || c === 2) return sHeader
      if (r === b2topR && c >= 3 && c <= blk2end) return sWeekday
      if (r === b2topR + 1 && c >= 3 && c <= blk2end) return sDate
      if (c >= sum0 && c <= sum0 + 3) return sHeader
      return null
    }
    // 姓名/入职日期数据列：每个合并块的三行都带边框（避免只有左上角有框）
    for (const s of personBlockRows) {
      if (r >= s && r <= s + 2) {
        if (c === 1) return sName
        if (c === 2) return sJoin
      }
    }
    // 第二块汇总列（出勤/病/事/伤）：每个合并块的三行都带边框
    for (const s of b2base) {
      if (r >= s && r <= s + 2 && c >= sum0 && c <= sum0 + 3) return sSumD
    }
    // 数据区
    if (r >= 6 && r <= b1botR && c >= 3 && c <= 21) {
      const st = { ...sData }; const f = dataFill(r, c); if (f) st.fill = f; return st
    }
    if (r >= b2topR + 2 && r <= b2botR && c >= 3 && c <= blk2end) {
      const st = { ...sData }; const f = dataFill(r, c); if (f) st.fill = f; return st
    }
    return null
  }
  const range = XLSX.utils.decode_range(ws['!ref'])
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const ref = XLSX.utils.encode_cell({ r, c })
      const st = styleAt(r, c)
      if (!st) continue
      if (!ws[ref]) ws[ref] = { t: 's', v: '' }
      ws[ref].s = st
    }
  }
  // 外框 Medium：仅两个长排的四边用 medium，内里单元格仍 thin（B 已为 thin）
  const blk2R = sum0 + 3
  const setMed = (r, c, side) => {
    const ref = XLSX.utils.encode_cell({ r, c })
    const cell = ws[ref]
    if (!cell || !cell.s || !cell.s.border) return
    cell.s = { ...cell.s, border: { ...cell.s.border, [side]: { style: 'medium', color: { rgb: 'FF000000' } } } }
  }
  // 第一长排 B5:V15（0-idx r[4..b1botR] c[1..21]）
  for (let r = 4; r <= b1botR; r++) { setMed(r, 1, 'left'); setMed(r, 21, 'right') }
  for (let c = 1; c <= 21; c++) { setMed(4, c, 'top'); setMed(b1botR, c, 'bottom') }
  // 第二长排 B18:S28（0-idx r[b2topR..b2botR] c[1..blk2R]，含合计列）
  for (let r = b2topR; r <= b2botR; r++) { setMed(r, 1, 'left'); setMed(r, blk2R, 'right') }
  for (let c = 1; c <= blk2R; c++) { setMed(b2topR, c, 'top'); setMed(b2botR, c, 'bottom') }
  // 合计列：出勤天数 COUNTA 公式（统计两块的出勤√行）
  const b2endL = colLetter(blk2end)
  for (let p = 0; p < people; p++) {
    const b1row = b1base[p], b2row = b2base[p]
    const f = `COUNTA(D${b1row + 1}:V${b1row + 1},D${b2row + 1}:${b2endL}${b2row + 1})`
    let cnt = 0
    for (let c = 3; c <= 21; c++) if (rows[b1row][c] != null && rows[b1row][c] !== '') cnt++
    for (let c = 3; c <= blk2end; c++) if (rows[b2row][c] != null && rows[b2row][c] !== '') cnt++
    const ref = XLSX.utils.encode_cell({ r: b2base[p], c: sum0 })
    ws[ref] = { t: 'n', f: f, F: ref, v: cnt, s: sSumD }
  }
  return ws
}

// xlsx-js-style 给空单元格写 t="str"><v></v></c>，会被 COUNTA 算作非空。
// 后处理：把这类空字符串单元格改成自闭合 <c ... s="N"/>，保留样式但让 COUNTA 忽略。
function stripEmptyStringCells(buf) {
  try {
    const zip = unzipSync(new Uint8Array(buf))
    const path = 'xl/worksheets/sheet1.xml'
    if (!zip[path]) return buf
    let xml = strFromU8(zip[path])
    xml = xml.replace(/<c r="([A-Z]+\d+)" s="(\d+)" t="str"><v><\/v><\/c>/g, '<c r="$1" s="$2"/>')
    zip[path] = strToU8(xml)
    return zipSync(zip)
  } catch (e) {
    console.error('清空字符串单元格后处理失败', e)
    return buf
  }
}

// 把 xlsx 工作表默认网格线颜色改为白色（ICV 1 = White），不改变其他内容
function applyWhiteGridlines(buf) {
  try {
    const zip = unzipSync(new Uint8Array(buf))
    const path = 'xl/worksheets/sheet1.xml'
    if (!zip[path]) return buf
    let xml = strFromU8(zip[path])
    xml = xml.replace(
      /<sheetView workbookViewId="0"\s*\/>/,
      '<sheetView workbookViewId="0" showGridLines="1" defaultGridColor="0" colorId="1"/>'
    )
    zip[path] = strToU8(xml)
    return zipSync(zip)
  } catch (e) {
    console.error('网格线颜色后处理失败', e)
    return buf
  }
}

function downloadCalTemplate() {
  const y = viewYear.value
  const m = viewMonth.value
  const n = Number(calPeople.value) || 3
  const ws = buildCalTemplateSheet(n)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, `实际出勤 (${n}人出勤)`)
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  const finalBuf = applyWhiteGridlines(stripEmptyStringCells(buf))
  saveBlob(`考勤表模板-${n}人-${y}-${String(m + 1).padStart(2, '0')}.xlsx`, finalBuf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
}
// 导出日历：把当前月份系统内实际排班填入日历模板（人数随 calPeople 选 2/3），休班留空、工时触发橙色
function exportCal() {
  const n = Number(calPeople.value) || 3
  const y = viewYear.value
  const m = viewMonth.value
  const prefix = `${y}-${String(m + 1).padStart(2, '0')}`
  const recs = records.value.filter((r) => r.date && String(r.date).startsWith(prefix))
  if (!recs.length) return alert(`当前 ${prefix} 月份暂无排班数据，无法导出日历。可先导入或添加排班后再导出。`)
  const ws = buildCalTemplateSheet(n, recs)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, `实际出勤 (${n}人出勤)`)
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  const finalBuf = applyWhiteGridlines(stripEmptyStringCells(buf))
  saveBlob(`考勤表-${n}人-${y}-${String(m + 1).padStart(2, '0')}.xlsx`, finalBuf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
}
function exportAll() {
  if (!records.value.length) return alert('暂无可导出的值班记录。')
  const rows = records.value.map((r) => ({
    日期: r.date,
    姓名: r.person,
    班次: r.shift || '',
    备注: r.remark || '',
    工作内容: r.workContent || ''
  }))
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '值班表')
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  saveBlob(`值班表-${new Date().toISOString().slice(0, 10)}.xlsx`, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
}

function togglePerson(p) {
  // 多选对比：点选加入，再次点选移除；清空后恢复「全部」
  if (showSet.value === null) {
    showSet.value = new Set([p])
    return
  }
  const next = new Set(showSet.value)
  if (next.has(p)) next.delete(p)
  else next.add(p)
  showSet.value = next.size ? next : null
}
function showAll() {
  showSet.value = null
}
// 日历头部「休班」快捷筛选：与统计面板的「班次类型」共用 selShift，两处状态实时同步
// 点亮 = 只看休班（日历 + 统计同时生效）；再点 = 恢复全部班次
function toggleRestOnly() {
  selShift.value = selShift.value === '休班' ? 'all' : '休班'
}
// 点击「统计」弹出 / 关闭值班统计弹窗（不再内联展开挤压日历）
function toggleStats() {
  showStats.value = !showStats.value
}

/* ---------- 编辑排班 ---------- */
function toggleEdit() {
  editMode.value = !editMode.value
  dayPanelDate.value = null
  selectedDay.value = null
}
function recordsOfDay(dateStr) {
  return records.value.filter((r) => r.date === dateStr)
}
function openAdd() {
  newRecord.value = {
    date: dayPanelDate.value || '',
    person: '',
    shift: '',
    remark: '',
    workContent: ''
  }
  addingRecord.value = true
}
async function saveNew() {
  const r = newRecord.value
  if (!r.date || !r.person.trim()) return alert('请填写日期和姓名')
  await db.duty.add({ date: r.date, person: r.person.trim(), shift: r.shift, remark: r.remark, workContent: r.workContent })
  addingRecord.value = false
  await load()
}
function openEdit(r) {
  if (r._virtual) return
  editingRecord.value = { ...r }
  showEditDialog.value = true
}
function closeEdit() {
  showEditDialog.value = false
  editingRecord.value = null
}
async function saveRecord() {
  if (!editingRecord.value) return
  const r = editingRecord.value
  if (!r.id || String(r.id).startsWith('rest:')) return
  await db.duty.update(r.id, {
    person: r.person,
    shift: r.shift,
    remark: r.remark,
    workContent: r.workContent
  })
  closeEdit()
  await load()
}
async function deleteRecord(id) {
  if (String(id).startsWith('rest:')) return
  if (!confirm('确认删除该条排班记录？')) return
  await db.duty.delete(id)
  await load()
}

/* ---------- 清空：全部 / 按人员 ---------- */
function openClearDialog() {
  showClearDialog.value = true
  clearMode.value = 'all'
  clearSelectedPersons.value = new Set()
  clearDateStart.value = ''
  clearDateEnd.value = ''
}
function closeClearDialog() {
  showClearDialog.value = false
}
function toggleClearPerson(p) {
  const next = new Set(clearSelectedPersons.value)
  if (next.has(p)) next.delete(p)
  else next.add(p)
  clearSelectedPersons.value = next
}
async function confirmClear() {
  if (clearMode.value === 'all') {
    if (!confirm('将清空全部值班记录，建议先导出备份。确认？')) return
    await db.duty.clear()
  } else if (clearMode.value === 'person') {
    const list = [...clearSelectedPersons.value]
    if (!list.length) return alert('请至少选择一位人员')
    if (!confirm(`将清空 ${list.join('、')} 的值班记录，建议先导出备份。确认？`)) return
    await db.duty.where('person').anyOf(list).delete()
  } else if (clearMode.value === 'date') {
    const s = clearDateStart.value
    const e = clearDateEnd.value
    if (!s || !e) return alert('请选择起始与结束日期')
    if (s > e) return alert('起始日期不能晚于结束日期')
    const hit = records.value.filter((r) => r.date >= s && r.date <= e)
    if (!hit.length) {
      alert('该时间段内没有值班记录')
      closeClearDialog()
      return
    }
    if (!confirm(`将清空 ${s} 至 ${e} 共 ${hit.length} 条值班记录，建议先导出备份。确认？`)) return
    await db.duty.bulkDelete(hit.map((r) => r.id))
  }
  closeClearDialog()
  await load()
}

onMounted(async () => {
  await load()
  loadColors()
  await loadHolidays()
  // 恢复上次筛选状态（展示人员 / 班次筛选 / 标记已过去）
  loadDutyState()
  // 修剪已不存在的人员，避免残留脏数据
  if (showSet.value) {
    const valid = new Set([...showSet.value].filter((p) => persons.value.includes(p)))
    showSet.value = valid.size ? valid : null
  }
})
</script>

<template>
  <div class="duty-page">
    <!-- 人员筛选 + 操作入口 + 统计入口 -->
    <div class="panel-flat person-bar">
      <div class="filter">
        <button class="chip action-toggle" :class="{ active: showActions }" @click="showActions = !showActions">
          <svg viewBox="0 0 24 24" width="14" height="14" class="ico">
            <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          操作
        </button>
        <button class="chip" :class="{ active: editMode }" @click="toggleEdit">
          {{ editMode ? '完成编辑' : '编辑排班' }}
        </button>
        <span class="muted">展示人员：</span>
        <button class="chip" :class="{ active: showSet === null }" @click="showAll">全部</button>
        <div v-for="p in persons" :key="p" class="pwrap">
          <button
            class="chip"
            :class="{ active: showSet !== null && showSet.has(p) }"
            @click="togglePerson(p)"
          >
            <span class="dot" :style="{ background: colorFor(p) }"></span>{{ p }}
          </button>
        </div>
        <button class="chip edit-colors" :class="{ active: editingColors }" @click="editingColors = !editingColors">编辑配色</button>
        <button class="chip stats-jump" :class="{ active: showStats }" @click="toggleStats" :title="showStats ? '关闭值班统计' : '展开值班统计'">
          <svg viewBox="0 0 24 24" width="14" height="14" class="ico">
            <path d="M5 19V9M12 19V5M19 19v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
          </svg>{{ showStats ? '关闭统计' : '统计' }}
        </button>
      </div>
    </div>

    <!-- 可折叠操作面板：模板 / 导入 / 导出 / 清空 / 帮助说明 -->
    <div v-if="showActions" class="panel-flat actions-panel">
      <div class="actions-grid">
        <button class="ghost" @click="downloadTemplate">下载长表模板</button>
        <button class="ghost" @click="downloadCalTemplate">下载日历模板</button>
        <button class="ghost" @click="exportCal">导出日历</button>
        <label class="import-btn ghost">
          导入 Excel
          <input type="file" accept=".xlsx,.xls" @change="importExcel" hidden />
        </label>
        <button class="ghost" @click="exportAll">导出长表</button>
        <button class="danger" @click="openClearDialog">清空</button>
        <span class="seg" role="group" aria-label="日历人数">
          <button type="button" :class="{ on: calPeople === 2 }" @click="calPeople = 2">2人</button>
          <button type="button" :class="{ on: calPeople === 3 }" @click="calPeople = 3">3人</button>
        </span>
      </div>
      <div class="actions-help">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M9.5 9.5a2.5 2.5 0 1 1 4.2 1.8c-.6.5-1.2 1.2-1.2 2.2h0"/>
          <circle cx="12" cy="17" r=".8" fill="currentColor" stroke="none"/>
        </svg>
        <span>{{ HELP_TIP }}</span>
      </div>
    </div>

    <div v-if="editingColors" class="panel-flat color-edit">
      <div class="stats-head">
        <strong>编辑人员配色</strong>
        <div class="row" style="gap: 6px">
          <button class="ghost sm" @click="resetColors">恢复默认</button>
          <button class="ghost sm primary" @click="editingColors = false">完成</button>
        </div>
      </div>
      <div v-for="p in persons" :key="p" class="color-edit-row">
        <span class="ce-name"><span class="dot" :style="{ background: colorFor(p) }"></span>{{ p }}</span>
        <div class="swatches">
          <button
            v-for="c in FIXED_PALETTE"
            :key="c"
            class="sw"
            :class="{ on: colorFor(p).toLowerCase() === c.toLowerCase() }"
            :style="{ background: c }"
            @click="setColor(p, c)"
            :title="c"
          ></button>
        </div>
      </div>
    </div>

    <!-- 值班统计改为弹窗，见文件末尾 modal-mask；此处不再内联展开以免挤压日历 -->

    <div class="panel-flat cal-wrap">
      <div class="cal-head">
        <button class="nav" @click="prevMonth">‹</button>
        <strong>{{ viewYear }} 年 {{ viewMonth + 1 }} 月</strong>
        <button class="nav" @click="nextMonth">›</button>
        <div class="cal-head-tools">
          <button class="chip sm" :class="{ active: markPast }" @click="markPast = !markPast" title="已过去的日期加删除线并置灰">标记已过去</button>
          <button
            class="chip sm rest-toggle"
            :class="{ active: selShift === '休班' }"
            @click="toggleRestOnly"
            :title="selShift === '休班' ? '取消休班筛选，恢复显示全部班次' : '只看休班（日历与统计同时生效）'"
          >
            <span class="rt-ico">☾</span>休班
          </button>
          <button class="chip sm" :class="{ active: holidayManageOpen }" @click="holidayManageOpen = !holidayManageOpen" title="查看/管理节假日（内置 2026 法定假日，可增删自定义）">节假日</button>
        </div>
      </div>
      <div v-if="holidayManageOpen" class="holiday-manage">
        <div class="hm-title">节假日管理</div>
        <div class="hm-add">
          <input type="date" v-model="newHolidayDate" class="hm-date" />
          <input type="text" v-model="newHolidayName" placeholder="名称（如 公司年假）" class="hm-name" @keyup.enter="addCustomHoliday" />
          <button class="primary sm" @click="addCustomHoliday">添加</button>
        </div>
        <div class="hm-list">
          <div v-for="c in customHolidays" :key="c.date" class="hm-item">
            <span>{{ c.date }} · {{ c.name }}</span>
            <button class="link-btn" @click="removeCustomHoliday(c.date)">删除</button>
          </div>
          <div v-if="!customHolidays.length" class="muted hm-empty">暂无自定义节假日（内置 2026 法定假日已自动在日历标注）</div>
        </div>
      </div>
      <div v-if="selShift !== 'all'" class="cal-filter-tip">
        当前仅显示「{{ selShift }}」记录<span v-if="selShift === '休班'" class="tip-note">（休班 = 该考勤日无排班，由排班表反推）</span>
        <button class="link-btn" @click="selShift = 'all'">显示全部</button>
      </div>
      <div class="cal-grid cal-week">
        <div v-for="(w, i) in WEEK" :key="w" class="cal-cell week" :class="{ we: isWeekend(i) }">{{ w }}</div>
      </div>
      <div class="cal-grid">
        <div
          v-for="(c, i) in calendar"
          :key="c.dateStr"
          class="cal-cell"
        :class="{ other: c.other, we: isWeekend(i), today: !c.other && c.dateStr === todayStr, sel: c.dateStr === selectedDay, past: markPast && !c.other && c.dateStr < todayStr, holiday: holidayName(c.dateStr) }"
        @click="pickDay(c)"
      >
        <span v-if="dayRemark(c.dateStr)" class="day-remark-ico" :title="dayRemark(c.dateStr)">
          <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
            <path d="M4 4h16v12l-3 3H4V4z" fill="currentColor" opacity="0.22"/>
            <path d="M7 8h10M7 11h10M7 14h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>
          </svg>
        </span>
        <span v-if="holidayName(c.dateStr)" class="holi-badge" :title="holidayName(c.dateStr) + '（法定节假日）'">{{ holidayName(c.dateStr) }}</span>
        <div class="day-num">{{ c.d }}</div>
          <div class="day-duty">
            <div
              v-for="r in byDate(c.dateStr)"
              :key="r.id"
              class="duty-chip"
              :class="{ rest: shiftKeyOf(r.shift) === '休班', editable: editMode && !r._virtual }"
              :style="shiftKeyOf(r.shift) === '休班' ? {} : { background: colorFor(r.person), color: textOn(colorFor(r.person)) }"
              :title="`${r.person} ${r.shift} ${r.remark || ''}`"
              @click.stop="editMode && !r._virtual ? openEdit(r) : null"
            >
              <span class="chip-text">{{ r.person }}<span v-if="r.shift">·{{ r.shift }}</span></span>
              <button
                v-if="editMode && !r._virtual"
                class="chip-del"
                @click.stop="deleteRecord(r.id)"
                title="删除"
              >×</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 编辑模式：点击日期格打开当日排班面板，可改 / 删 / 新增 -->
    <div v-if="editMode && dayPanelDate" class="panel-flat day-panel">
      <div class="dp-head">
        <strong>{{ dayPanelDate }} 排班</strong>
        <div class="row" style="gap: 6px">
          <button class="primary sm" @click="openAdd">+ 添加排班</button>
          <button class="ghost sm" @click="dayPanelDate = null">✕</button>
        </div>
      </div>
      <div v-if="addingRecord" class="add-form">
        <div class="grid2">
          <div>
            <label>日期</label>
            <input type="date" v-model="newRecord.date" />
          </div>
          <div>
            <label>人员</label>
            <input v-model="newRecord.person" list="personList" placeholder="姓名" />
            <datalist id="personList">
              <option v-for="p in persons" :key="p" :value="p"></option>
            </datalist>
          </div>
          <div>
            <label>班次</label>
            <input v-model="newRecord.shift" placeholder="如 9:00-18:00" />
          </div>
          <div style="grid-column: 1 / -1">
            <label>备注</label>
            <div class="voice-field">
              <input v-model="newRecord.remark" placeholder="工时、备注等" />
              <VoiceInput v-model="newRecord.remark" />
            </div>
          </div>
          <div style="grid-column: 1 / -1">
            <label>工作内容</label>
            <div class="voice-field">
              <input v-model="newRecord.workContent" placeholder="可选" />
              <VoiceInput v-model="newRecord.workContent" />
            </div>
          </div>
        </div>
        <div class="row" style="justify-content: flex-end; margin-top: 10px">
          <button class="ghost sm" @click="addingRecord = false">取消</button>
          <button class="primary sm" @click="saveNew">保存</button>
        </div>
      </div>
      <div v-if="recordsOfDay(dayPanelDate).length === 0" class="muted sm-text" style="padding: 6px 0">
        当天暂无排班，点上方「添加排班」。
      </div>
      <div
        v-for="r in recordsOfDay(dayPanelDate)"
        :key="r.id"
        class="detail"
        :class="{ editable: !r._virtual }"
        @click="!r._virtual ? openEdit(r) : null"
      >
        <div class="detail-main">
          <span class="dot" :style="{ background: colorFor(r.person) }"></span>
          <strong>{{ r.person }}</strong>
          <span class="muted">（{{ r.shift || '—' }}）</span>
          <div v-if="r.remark" class="muted">备注：{{ r.remark }}</div>
          <div v-if="r.workContent" class="muted">工作内容：{{ r.workContent }}</div>
        </div>
        <div v-if="!r._virtual" class="detail-actions" @click.stop>
          <button class="ghost sm" @click.stop="openEdit(r)">编辑</button>
          <button class="ghost sm danger" @click.stop="deleteRecord(r.id)">删除</button>
        </div>
      </div>
    </div>

    <!-- 普通模式：点日期格看当天展示人员值班（浮层，不挤压日历） -->
    <div v-else-if="selectedDay" class="panel-flat day-detail">
      <h3 style="margin: 0 0 8px; font-size: 14px">{{ selectedDay }} 值班详情</h3>
      <div v-if="byDate(selectedDay).length === 0" class="muted">当天无展示人员的值班。</div>
      <div
        v-for="r in byDate(selectedDay)"
        :key="r.id"
        class="detail"
      >
        <div class="detail-main">
          <span class="dot" :style="{ background: colorFor(r.person) }"></span>
          <strong>{{ r.person }}</strong>
          <span class="muted">（{{ r.shift || '—' }}）</span>
          <div v-if="r.remark" class="muted">备注：{{ r.remark }}</div>
          <div v-if="r.workContent" class="muted">工作内容：{{ r.workContent }}</div>
        </div>
      </div>
    </div>

    <!-- 清空选择弹窗 -->
    <div v-if="showClearDialog" class="modal-mask">
      <div class="modal" style="max-width: 420px">
        <div class="modal-head">
          <strong>清空值班记录</strong>
          <button class="ghost sm" @click="closeClearDialog">✕</button>
        </div>
        <div class="clear-options">
          <label class="radio-row">
            <input type="radio" v-model="clearMode" value="all" />
            <span>清空全部记录</span>
          </label>
          <label class="radio-row">
            <input type="radio" v-model="clearMode" value="person" />
            <span>按人员清空</span>
          </label>
          <label class="radio-row">
            <input type="radio" v-model="clearMode" value="date" />
            <span>按日期清空（可选时间段）</span>
          </label>
        </div>
        <div v-if="clearMode === 'person'" class="person-select">
          <button
            v-for="p in persons"
            :key="p"
            class="chip"
            :class="{ active: clearSelectedPersons.has(p) }"
            @click="toggleClearPerson(p)"
          >
            <span class="dot" :style="{ background: colorFor(p) }"></span>{{ p }}
          </button>
        </div>
        <div v-if="clearMode === 'date'" class="date-range-select">
          <label class="date-range-field">
            <span>起始日期</span>
            <input type="date" v-model="clearDateStart" />
          </label>
          <span class="date-range-sep muted">至</span>
          <label class="date-range-field">
            <span>结束日期</span>
            <input type="date" v-model="clearDateEnd" />
          </label>
        </div>
        <div class="row" style="justify-content: flex-end; margin-top: 16px">
          <button class="ghost" @click="closeClearDialog">取消</button>
          <button class="danger" @click="confirmClear">确认清空</button>
        </div>
      </div>
    </div>

    <!-- 编辑排班弹窗 -->
    <div v-if="showEditDialog" class="modal-mask">
      <div class="modal" style="max-width: 460px">
        <div class="modal-head">
          <strong>编辑排班</strong>
          <button class="ghost sm" @click="closeEdit">✕</button>
        </div>
        <div class="grid2">
          <div>
            <label>人员</label>
            <input v-model="editingRecord.person" placeholder="姓名" />
          </div>
          <div>
            <label>班次</label>
            <input v-model="editingRecord.shift" placeholder="如 9:00-18:00" />
          </div>
          <div style="grid-column: 1 / -1">
            <label>备注</label>
            <div class="voice-field">
              <input v-model="editingRecord.remark" placeholder="工时、备注等" />
              <VoiceInput v-model="editingRecord.remark" />
            </div>
          </div>
          <div style="grid-column: 1 / -1">
            <label>工作内容</label>
            <div class="voice-field">
              <input v-model="editingRecord.workContent" placeholder="工作内容（可选）" />
              <VoiceInput v-model="editingRecord.workContent" />
            </div>
          </div>
        </div>
        <div class="row" style="justify-content: flex-end; margin-top: 14px">
          <button class="danger" @click="deleteRecord(editingRecord.id); closeEdit()">删除此记录</button>
          <button class="ghost" @click="closeEdit">取消</button>
          <button class="primary" @click="saveRecord">保存</button>
        </div>
      </div>
    </div>

    <!-- 值班统计弹窗：点击「统计」弹出，不再内联展开挤压日历 -->
    <div v-if="showStats" class="modal-mask" @click.self="showStats = false">
      <div class="modal" style="max-width: 560px">
        <div class="modal-head">
          <div>
            <strong>值班统计</strong>
            <span class="muted" style="font-weight: 400; margin-left: 8px">{{ timeLabel }} · 共 {{ records.length }} 条</span>
          </div>
          <button class="ghost sm" @click="showStats = false">✕</button>
        </div>

        <!-- 时间筛选 -->
        <div class="filter-row">
          <span class="muted">时间：</span>
          <button class="chip sm" :class="{ active: filterMode === 'all' }" @click="filterMode = 'all'">全部</button>
          <button class="chip sm" :class="{ active: filterMode === 'month' }" @click="filterMode = 'month'">按月</button>
          <button class="chip sm" :class="{ active: filterMode === 'range' }" @click="filterMode = 'range'">自定义</button>
          <input v-if="filterMode === 'month'" type="month" class="date-in" v-model="selMonth" />
          <template v-if="filterMode === 'range'">
            <input type="date" class="date-in" v-model="rangeStart" placeholder="起始" />
            <span class="muted">至</span>
            <input type="date" class="date-in" v-model="rangeEnd" placeholder="结束" />
          </template>
        </div>

        <!-- 班次类型筛选 -->
        <div class="filter-row">
          <span class="muted">班次类型：</span>
          <button class="chip sm" :class="{ active: selShift === 'all' }" @click="selShift = 'all'">全部</button>
          <button
            v-for="t in SHIFT_TYPES"
            :key="t.key"
            class="chip sm"
            :class="{ active: selShift === t.key }"
            @click="selShift = t.key"
          >{{ t.key }}</button>
        </div>

        <!-- 休班汇总：醒目展示当前筛选范围内的休班天数合计 -->
        <div v-if="restDays > 0" class="rest-summary">
          <span class="rs-ico">☾</span>
          休班天数合计：<strong>{{ restDays }}</strong> 天
        </div>

        <!-- 人员 × 班次 明细 -->
        <div class="sub-title">人员班次明细{{ selShift !== 'all' ? ' · ' + selShift : '' }}</div>
        <div v-if="!personShiftStats.length" class="muted sm-text">当前筛选下暂无数据。</div>
        <div v-for="s in personShiftStats" :key="s.id" class="stat-row">
          <span class="stat-name">
            <span class="dot" :style="{ background: colorFor(s.person) }"></span>{{ s.person }}
            <span class="ps-shift" :style="{ color: shiftColor(s.shiftKey) }">{{ s.shiftKey }}</span>
          </span>
          <span class="stat-bar"><span class="stat-fill" :style="{ width: (s.count / maxPSCount * 100) + '%', background: shiftColor(s.shiftKey) }"></span></span>
          <span class="stat-num">{{ s.count }} 次 · {{ s.hours }}h</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.duty-page {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 由 .main > * { flex: 1 } 撑满 main 高度，.cal-wrap 内部 flex 撑满剩余空间 */
  min-height: 0;
  position: relative;
}
/* 日历 panel 撑满 .duty-page 剩余空间（消除 main 内部"分层"） */
.cal-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.cal-wrap .cal-grid:not(.cal-week) {
  flex: 1;
  min-height: 0;
  /* 每行 1fr 自动均分 grid 高度，cell stretch 撑满 */
  grid-auto-rows: minmax(0, 1fr);
}
.cal-cell {
  min-height: 0;
  overflow: hidden;
}
/* 选中某天的值班详情：回归日历下方的普通文档流（复原调整前的展示方式，不再浮层） */
.day-detail {
  flex: none;
  border-radius: var(--radius);
}
.flex-spacer {
  flex: 1;
}
.action-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.action-toggle .ico {
  flex: none;
}
.actions-panel {
  padding: 12px;
}
.actions-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.actions-grid .import-btn {
  flex: none;
}
.cal-dl {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--bd, #d0d7de);
  border-radius: 7px;
  overflow: hidden;
}
.seg button {
  border: none;
  background: transparent;
  color: var(--fg, #333);
  font-size: 13px;
  padding: 5px 10px;
  cursor: pointer;
  line-height: 1;
}
.seg button + button {
  border-left: 1px solid var(--bd, #d0d7de);
}
.seg button.on {
  background: #2563eb;
  color: #fff;
}
.actions-help {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.actions-help svg {
  flex: none;
  margin-top: 1px;
  color: var(--primary);
}
.person-bar {
  margin-bottom: 10px;
}
.person-bar .filter {
  margin-top: 0;
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
  color: var(--primary);
}
.import-btn:hover {
  background: var(--primary-soft);
}
.danger.ghost {
  color: var(--danger);
  border-color: var(--danger-soft);
}
.filter {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 10px;
}
.chip {
  border: 1px solid var(--border);
  background: var(--panel-solid);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
}
.chip.active {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  display: inline-block;
  vertical-align: middle;
  margin-right: 4px;
}
.chip .dot {
  margin-right: 5px;
}
.pwrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.edit-colors {
  margin-left: 4px;
}
.chip.stats-jump {
  color: var(--primary);
  border-color: color-mix(in srgb, var(--primary) 35%, var(--border));
  display: inline-flex;
  align-items: center;
}
.chip.stats-jump:hover {
  background: var(--primary-soft);
}
.chip.stats-jump.active {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}
.chip.stats-jump .ico {
  margin-right: 3px;
  vertical-align: middle;
}
.filter .stats-jump {
  margin-left: auto;
}
/* 配色编辑面板（默认隐藏，点「编辑配色」展开） */
.color-edit {
  padding: 14px;
}
.color-edit-row {
  display: grid;
  grid-template-columns: 96px 1fr;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.color-edit-row:first-of-type {
  border-top: none;
}
.ce-name {
  font-size: 13px;
  display: flex;
  align-items: center;
}
.swatches {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.sw {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
  transition: transform 0.12s ease;
}
.sw:hover {
  transform: scale(1.14);
}
.sw.on {
  box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--primary);
}
.ghost.sm {
  padding: 4px 10px;
  font-size: 12px;
}
.ghost.primary {
  color: var(--primary);
  border-color: var(--primary);
}
/* 统计 */
.stats-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 10px;
}
.stats-head strong {
  font-size: 14px;
}
.stat-row {
  display: grid;
  grid-template-columns: 1fr 90px auto;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}
.stat-name {
  font-size: 13px;
  display: flex;
  align-items: center;
}
.stat-bar {
  height: 10px;
  background: var(--border);
  border-radius: 999px;
  overflow: hidden;
}
.stat-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s ease;
}
.stat-num {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.ps-shift {
  margin-left: 5px;
  font-weight: 600;
  font-size: 11px;
}
/* 统计筛选控件 */
.filter-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 8px;
}
.chip.sm {
  padding: 3px 10px;
  font-size: 12px;
}
.date-in {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 12px;
  background: var(--panel-solid);
  color: var(--text);
}
.date-in:focus {
  outline: none;
  border-color: var(--primary);
}
.sub-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin: 14px 0 4px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.sm-text {
  font-size: 12px;
  padding: 4px 0;
}
/* 标记已过去：删除线 + 置灰，仍占位 */
.cal-cell.past {
  opacity: 0.6;
}
.cal-cell.past .day-num {
  text-decoration: line-through;
  text-decoration-thickness: 2px;
  text-decoration-color: var(--danger);
}
.cal-cell.past .duty-chip {
  filter: grayscale(1);
  opacity: 0.7;
}
/* calendar */
.cal-wrap {
  padding: 6px 14px 8px;
}
.cal-head {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
/* 日历头部工具组：标记已过去 + 休班筛选（成组靠在一起，与月份导航保持 16px 间距） */
.cal-head-tools {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
/* 休班快捷筛选：用中性灰色区分，避免与「标记已过去」的主色混淆 */
.chip.sm.rest-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  border-color: var(--border-strong);
}
.chip.sm.rest-toggle:hover {
  background: var(--panel-2);
}
.chip.sm.rest-toggle.active {
  background: var(--muted);
  color: #fff;
  border-color: var(--muted);
}
.rest-toggle .rt-ico {
  font-size: 12px;
  line-height: 1;
}
/* 班次筛选生效时的提示条：让用户知道日历不是「没数据」而是被筛掉了 */
.cal-filter-tip {
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  margin: -4px 0 10px;
}
.cal-filter-tip .tip-note {
  opacity: 0.75;
  font-size: 11px;
}
.cal-filter-tip .link-btn {
  border: none;
  background: none;
  color: var(--primary);
  font-size: 12px;
  cursor: pointer;
  padding: 0 2px;
  text-decoration: underline;
}
.nav {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--panel-solid);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
.nav:hover {
  background: var(--primary-soft);
}
.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
}
.cal-week {
  margin-bottom: 4px;
}
.cal-week .week {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  min-height: 36px;
  font-weight: 700;
  color: var(--muted);
  font-size: 13px;
  padding: 0;
  line-height: 1.1;
}
.cal-week .week.we {
  color: var(--danger);
}
.cal-cell {
  position: relative;
  border: 1px solid var(--border);
  border-radius: 10px;
  min-height: 72px;
  padding: 6px;
  background: var(--panel-solid);
  font-size: 12px;
  transition: border-color 0.15s, background 0.15s;
}
.cal-cell:not(.empty):hover {
  border-color: var(--primary);
  cursor: pointer;
}
.cal-cell.we {
  background: var(--panel-2);
}
/* 非本月日期（上月末 / 下月初补位）：灰色淡化，不与本月日期争夺视觉 */
.cal-cell.other {
  background: transparent;
  border-color: transparent;
  opacity: 0.5;
}
.cal-cell.other:hover {
  border-color: var(--border);
}
.cal-cell.other .day-num {
  color: var(--muted);
}
/* 角落备注小图标：悬浮显示当日备注（替代原顶部文本行） */
.day-remark-ico {
  position: absolute;
  top: 4px;
  right: 4px;
  display: inline-flex;
  color: var(--primary);
  opacity: 0.85;
  cursor: help;
}
.cal-cell.empty {
  background: transparent;
  border: none;
}
.cal-cell.today {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
.cal-cell.sel {
  background: var(--primary-soft);
}
/* 节假日：红色调明显标注 */
.cal-cell.holiday {
  background: rgba(225, 29, 72, 0.10);
  border-color: rgba(225, 29, 72, 0.45);
}
.cal-cell.holiday.we {
  background: rgba(225, 29, 72, 0.14);
}
.cal-cell.holiday.today {
  box-shadow: 0 0 0 2px rgba(225, 29, 72, 0.5);
}
.holi-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  background: #e11d48;
  color: #fff;
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 6px;
  font-weight: 700;
  pointer-events: none;
  z-index: 2;
}
/* 有节假日时备注小图标下移，避免与红标重叠 */
.cal-cell.holiday .day-remark-ico {
  top: 22px;
}
/* 节假日管理浮层 */
.holiday-manage {
  margin: 8px 0 4px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
}
.hm-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.hm-add {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.hm-date,
.hm-name {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 12px;
}
.hm-name {
  flex: 1;
  min-width: 140px;
}
.hm-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hm-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  padding: 3px 0;
}
.hm-empty {
  font-size: 12px;
}
.day-num {
  font-weight: 600;
}
.day-duty {
  margin-top: 3px;
  display: grid;
  gap: 3px;
}
.duty-chip {
  background: var(--primary-soft);
  color: var(--primary);
  border-radius: 5px;
  padding: 2px 5px;
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 4px;
}
.duty-chip.editable {
  cursor: pointer;
  padding-right: 2px;
}
.duty-chip.editable:hover {
  filter: brightness(1.1);
}
.chip-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip-del {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: none;
  background: rgba(0, 0, 0, .12);
  color: inherit;
  display: grid;
  place-items: center;
  font-size: 14px;
  line-height: 1;
  padding: 0;
  flex: none;
}
.chip-del:hover {
  background: rgba(0, 0, 0, .22);
}
/* 休班：灰色斜体，与值班的彩色 chip 区分 */
.duty-chip.rest {
  background: var(--panel-2);
  color: var(--muted);
  font-style: italic;
  border: 1px dashed var(--border-strong);
}
/* 休班天数汇总条 */
.rest-summary {
  margin: 10px 0 2px;
  padding: 8px 10px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
}
.rest-summary strong {
  color: var(--muted);
  font-size: 15px;
  margin: 0 2px;
}
.rest-summary .rs-ico {
  margin-right: 4px;
  color: var(--muted);
}
.day-panel {
  padding: 14px;
}
.dp-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.dp-head strong {
  font-size: 14px;
}
.add-form {
  padding: 12px;
  margin-bottom: 12px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.detail {
  border-top: 1px solid var(--border);
  padding: 8px 0;
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.detail:first-of-type {
  border-top: none;
}
.detail.editable {
  cursor: pointer;
}
.detail.editable:hover {
  background: var(--panel-2);
  border-radius: 6px;
  margin: 0 -6px;
  padding: 8px 6px;
}
.detail-main {
  flex: 1;
  min-width: 0;
}
.detail-actions {
  display: flex;
  gap: 6px;
  flex: none;
  margin-top: 2px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
@media (max-width: 640px) {
  .grid2 {
    grid-template-columns: 1fr;
  }
}
.clear-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 12px 0;
}
.radio-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.radio-row input {
  width: auto;
}
.person-select {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px;
  background: var(--panel-2);
  border-radius: 8px;
}
.date-range-select {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 10px;
  background: var(--panel-2);
  border-radius: 8px;
}
.date-range-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
  flex: 1;
}
.date-range-field input {
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel-solid);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
}
.date-range-field input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.date-range-sep {
  padding-bottom: 10px;
  font-size: 13px;
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
@media (max-width: 560px) {
  .cal-cell { min-height: 54px; padding: 4px; font-size: 11px; }
  .cal-head { gap: 8px; }
  .stat-row { grid-template-columns: 1fr 56px auto; }
  .import-btn, .danger { font-size: 12px; padding: 6px 10px; }
  .filter { gap: 4px; }
}
</style>
