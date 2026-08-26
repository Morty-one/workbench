/**
 * 班次判定（与日程表 duty 导入数据关联）
 *
 * 口径（由使用方确认）：
 *   主班     = 9:00 - 次日 9:00     （表格里写作 9:00-c9:00）
 *   副班     = 9:00 - 18:00
 *   周末白班 = 9:00 - 20:30，且仅在「周六 / 周日」成立
 *              周一至周五即使排 9:00-20:30 也不算周末白班
 *   休班     = 休 / 休息 / 调休 / 请假，或该考勤日在排班表中没有任何记录
 */

export const SHIFT_KEYS = ['主班', '副班', '周末白班', '休班']
// 规则可选的班次（含"不限"）。新增：所有上班的班次 / 单人班
export const SHIFT_OPTIONS = ['不限', '主班', '副班', '周末白班', '休班', '所有上班的班次', '工作日班', '单人班']
// 所有"上班"的班次（即非休班）：用于「所有上班的班次」匹配
export const WORKING_SHIFTS = ['主班', '副班', '周末白班']

const SHIFT_TYPES = [
  { key: '主班', match: ['9:00-c9:00', '9:00-次日9:00', '主班'] },
  { key: '副班', match: ['9:00-18:00', '副班'] },
  { key: '周末白班', match: ['9:00-20:30', '周末白班'] },
  { key: '休班', match: ['休', '休班', '休息', '休息日', '调休', '请假', 'x'] }
]

/** 归一化：全角冒号/横杠 → 半角，去空格，转小写 */
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/：/g, ':')
    .replace(/[—–－]/g, '-')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** YYYY-MM-DD 是否为周六 / 周日 */
export function isWeekend(dateStr) {
  if (!dateStr) return false
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return false
  const w = d.getDay()
  return w === 0 || w === 6
}

/** 星期序号：周一=1 … 周日=7 */
export function weekdayOf(dateStr) {
  if (!dateStr) return 0
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return 0
  const w = d.getDay()
  return w === 0 ? 7 : w
}

/**
 * 把排班表里的班次原文映射为标准班次
 * @param {string} shift   排班表原文，如 "9:00-18:00"
 * @param {string} dateStr YYYY-MM-DD，用于判定周末白班
 */
export function shiftKeyOf(shift, dateStr) {
  const raw = norm(shift)
  if (!raw) return '其他'
  const hit = SHIFT_TYPES.find((t) => t.match.some((m) => norm(m) === raw))
  let key = hit ? hit.key : '其他'
  // 周末白班仅在周六周日成立，工作日的同时段归为副班以外的「其他」
  if (key === '周末白班' && dateStr && !isWeekend(dateStr)) key = '其他'
  return key
}

export const WEEKDAY_LABELS = [
  { v: 1, label: '一' },
  { v: 2, label: '二' },
  { v: 3, label: '三' },
  { v: 4, label: '四' },
  { v: 5, label: '五' },
  { v: 6, label: '六' },
  { v: 7, label: '日' }
]

/** 规则的星期条件描述 */
export function weekdayText(weekdays) {
  if (!weekdays || !weekdays.length || weekdays.length === 7) return '每天'
  return (
    '周' +
    weekdays
      .slice()
      .sort((a, b) => a - b)
      .map((v) => WEEKDAY_LABELS.find((w) => w.v === v)?.label || v)
      .join('/')
  )
}

/**
 * 是否「单人班」当天
 * @param {string} dateStr YYYY-MM-DD
 * @param {string[]} onDutyNames 当天在班（非休班）人员名单
 * @param {string} excludePerson 周末不计入在班人数的人（单人班配置项，可留空）
 *
 * 口径（由使用方确认）：
 *   周一 ~ 周五：在班总人数 = 1
 *   周六 / 周日：除 excludePerson 外在班人数 = 1
 * 即：周末若只有「excludePerson + 1 人」在班，剔除该人后仍只有 1 人 → 算单人班。
 */
export function isSingleShiftDay(dateStr, onDutyNames, excludePerson) {
  const names = (onDutyNames || [])
    .map((s) => (s || '').trim())
    .filter(Boolean)
  const reduced = excludePerson ? names.filter((n) => n !== excludePerson) : names
  if (isWeekend(dateStr)) return reduced.length === 1
  return names.length === 1
}
