/**
 * 班次判定（与日程表 duty 导入数据关联）
 *
 * 口径（由使用方确认）：
 * 班次由「时段写法」唯一决定（用户 2026-09-02 纠正：不是由班次名决定）：
 *   主班     = 9:00 - 次日 9:00     （表格里写作 9:00-c9:00 或 9:00-次日9:00）
 *   副班     = 9:00 - 18:00
 *   周末白班 = 9:00 - 20:30，且仅在「非工作日」成立
 *              —— 非工作日 = 周六 / 周日，或法定节假日放假日（如国庆 10/1 周四）
 *              —— 工作日（含调休补班日，如 2026-10-10 周六）即使排 9:00-20:30
 *                 也不算周末白班，归为「其他」（用户 2026-09-02 确认）
 *   休班     = 休 / 休息 / 调休 / 请假，或该考勤日在排班表中留空 / 没有任何记录
 */

export const SHIFT_KEYS = ['主班', '副班', '周末白班', '休班']
// 规则可选的班次（含"不限"）。新增：所有上班的班次 / 工作日班 / 单人班
export const SHIFT_OPTIONS = ['不限', '主班', '副班', '周末白班', '休班', '所有上班的班次', '工作日班', '单人班']
// 常见的"上班"班次（非休班）清单，仅作数据文档 / 参考用。
//
// ⚠️ 不要用它做「是否上班」的判定！判定请用黑名单：shiftKey !== '休班'。
//    原因（用户 2026-09-01 口径）："班表里只要排了班，不管什么班都算我上班"。
//    用白名单会漏掉名单外的班次写法（如系统识别不出而落到「其他」的班次）。
//    历史 bug：2026-09-01 单人班日「每日填报工时 / 统计月报填报提醒」不生成，
//    就是因为这个白名单当初不含「单人班」。
export const WORKING_SHIFTS = ['主班', '副班', '周末白班', '单人班']

/**
 * 法定节假日 / 调休补班数据（按国务院办公厅放假通知口径）
 * 数据源：2026 = 国办发明电〔2025〕7 号《国务院办公厅关于2026年部分节假日安排的通知》
 *        https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 * 维护：每年 11 月左右国务院办公厅发布次年放假通知后由用户核对/追加，按年份分块追加。
 * 本份数据由 Duty.vue 日历节假日徽章 + 预设任务「工作日班」判定 共同消费，集中维护避免漂移。
 *
 * 数据结构：
 *   BUILTIN_HOLIDAYS_2026: 区间格式（每个法定节假日 1 条，含跨周末日期）
 *     { start, end, name } —— 区间内每一天都算「rest」
 *   BUILTIN_WORKDAYS_2026: 列表格式（调休补班的周末 / 工作日）
 *     { date, name } —— 单日标为「work」
 *   CUSTOM_HOLIDAYS（来自 db.settings 'holidays'，运行时由调用方传入 getHolidayMap）
 *
 * 优先级：custom > builtin（与 Duty.vue 原 holidayMap 行为一致）。
 */

/** 把 [start..end] 区间按天展开为 YYYY-MM-DD 数组（闭区间） */
function expandRangesToDates(ranges) {
  const out = []
  for (const r of ranges) {
    const [y, mo, da] = r.start.split('-').map(Number)
    const [y2, mo2, da2] = r.end.split('-').map(Number)
    const start = new Date(y, mo - 1, da)
    const end = new Date(y2, mo2 - 1, da2)
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      out.push(`${d.getFullYear()}-${mm}-${dd}`)
    }
  }
  return out
}

/** 取内置节假日名（dateStr 是否落在 BUILTIN_HOLIDAYS_2026 某个区间内） */
function builtinHolidayName(dateStr) {
  for (const r of BUILTIN_HOLIDAYS_2026) {
    if (dateStr >= r.start && dateStr <= r.end) return r.name
  }
  return ''
}

// ───── 2026 年（国办发明电〔2025〕7 号） ─────
export const BUILTIN_HOLIDAYS_2026 = [
  { start: '2026-01-01', end: '2026-01-03', name: '元旦' },
  { start: '2026-02-15', end: '2026-02-23', name: '春节' },
  { start: '2026-04-04', end: '2026-04-06', name: '清明节' },
  { start: '2026-05-01', end: '2026-05-05', name: '劳动节' },
  { start: '2026-06-19', end: '2026-06-21', name: '端午节' },
  { start: '2026-09-25', end: '2026-09-27', name: '中秋节' },
  { start: '2026-10-01', end: '2026-10-07', name: '国庆节' }
]
// 调休补班的周末 / 工作日（按上班算）
export const BUILTIN_WORKDAYS_2026 = [
  { date: '2026-01-04', name: '元旦调休' }, // 元旦后周日调休上班
  { date: '2026-02-14', name: '春节调休' }, // 春节前周六调休上班
  { date: '2026-02-28', name: '春节调休' }, // 春节后周六调休上班
  { date: '2026-05-09', name: '劳动节调休' }, // 劳动节后周六调休上班
  { date: '2026-09-20', name: '国庆调休' }, // 国庆前周日调休上班
  { date: '2026-10-10', name: '国庆调休' } // 国庆后周六调休上班
]

// 程序化生成的覆盖表（用于 isWorkingDay 快速判定）：
//   'rest' = 放假 / 调休休息（按休算，不算工作日）
//   'work' = 调休补班（按上班算，算工作日）
//   未列出日期 = 按周几默认：周一~周五=工作日，周六周日=休息日
export const HOLIDAY_OVERRIDES = (() => {
  const m = {}
  for (const d of expandRangesToDates(BUILTIN_HOLIDAYS_2026)) m[d] = 'rest'
  for (const w of BUILTIN_WORKDAYS_2026) m[w.date] = 'work'
  return m
})()

/**
 * 合并内置法定节假日 + 用户自定义节假日，返回 Map<date, { name, custom }>
 * @param {Array<{date:string,name:string}>} customHolidays 用户自定义节假日（来自 db.settings 'holidays'）
 */
export function getHolidayMap(customHolidays = []) {
  const m = new Map()
  for (const d of expandRangesToDates(BUILTIN_HOLIDAYS_2026)) {
    const name = builtinHolidayName(d)
    if (name) m.set(d, { name, custom: false })
  }
  for (const c of customHolidays) {
    if (c && c.date) m.set(c.date, { name: c.name || '节假日', custom: true })
  }
  return m
}

/** dateStr -> 节日名（基于 getHolidayMap，无则返回空字符串）。便于模板中直接调用。 */
export function holidayName(dateStr, customHolidays = []) {
  const h = getHolidayMap(customHolidays).get(dateStr)
  return h ? h.name : ''
}

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

/**
 * YYYY-MM-DD 是否为「工作日」
 * 口径（用户 2026-09-01 确认）：
 *   - 法定节假日 / 调休休息日 = 休息（不算工作日）
 *   - 调休补班的周末 = 工作日（按上班算）
 *   - 未列出的日期：周一~周五 = 工作日，周六周日 = 休息日
 * 用于预设任务规则中「工作日班」匹配（与 Overview.matchShifts 配合）。
 */
export function isWorkingDay(dateStr) {
  if (!dateStr) return false
  const override = HOLIDAY_OVERRIDES[dateStr]
  if (override === 'rest') return false
  if (override === 'work') return true
  return !isWeekend(dateStr)
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
  // 周末白班仅在「非工作日」成立：周六/周日，或法定节假日放假日。
  // 工作日（含调休补班的周末，如 2026-10-10 国庆补班）排 9:00-20:30 归为「其他」。
  //
  // 历史 bug（2026-09-02 修）：原先判定用 !isWeekend(dateStr)，导致国庆 10/1（周四）
  // 排 9:00-20:30 被降级成「其他」；而「其他」在 Overview 里被排除出「在班人数」，
  // 结果是「国庆只有 1 人上班」识别不出单人班。改用 isWorkingDay 后：
  //   10/1 周四·国庆放假 -> isWorkingDay=false -> 周末白班（正确）
  //   10/10 周六·调休补班 -> isWorkingDay=true  -> 其他（用户确认口径）
  //   9/2 周三·普通工作日 -> isWorkingDay=true  -> 其他（不放开）
  if (key === '周末白班' && dateStr && isWorkingDay(dateStr)) key = '其他'
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
