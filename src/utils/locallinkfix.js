/* 存量坏链接订正（第 42 轮，2026-09-22，用户选定「顺手订正」）
 *
 * 背景：历史数据里存在形如 `https://"C:\Users\Public\Desktop\MotionPro.lnk"` 的链接
 * —— 协议头是误加的（输入框提示写着 https://，用户先敲了协议再粘上带引号的路径）。
 * 这类链接点击时被当成网页交给浏览器，本地程序/Office 文件永远打不开。
 *
 * 本模块把库里**已存**的这类链接一次性订正为干净的本地路径。
 *
 * 设计要点：
 *   - **幂等**：判据是「`localPathOf()` 能剥出合法盘符路径且与原值不同」⇒ 订正后再跑就是零改动，
 *     因此不需要「已迁移」标记键；每次启动跑一遍也是空操作，天然收敛。
 *   - **只写需要改的记录**（收集后 bulkPut），避免全表写一遍触发无谓的本地落盘 / 标脏。
 *   - **失败不阻断启动**：每个表各自 try/catch，坏一条不影响其余。
 *   - 覆盖面：tasks（含子任务 links）、shortcuts、settings['periodicDutyTasks']（预设任务 links）。
 *     —— 这三处就是「本地程序/办公文件」能出现的全部位置。
 */

import { db } from '../db'
import { localPathOf } from './localOpen.js'

// 把一个 url 归一成干净的本地路径；不是本地路径则返回空串（调用方据此跳过）
function fixedLocalUrl(u) {
  const p = localPathOf(u)
  return p || ''
}

// 处理 [{url,label}, …] 形态的链接数组，返回 { arr, changed }
function fixLinkArray(arr) {
  if (!Array.isArray(arr)) return { arr, changed: false }
  let changed = false
  const out = arr.map((l) => {
    if (!l || typeof l !== 'object') return l
    const f = fixedLocalUrl(l.url)
    if (f && f !== l.url) {
      changed = true
      return { ...l, url: f }
    }
    return l
  })
  return { arr: changed ? out : arr, changed }
}

/**
 * 扫描并订正所有「被误加协议的本地路径链接」。
 * @returns {Promise<{tasks:number,subtasks:number,shortcuts:number,rules:number,total:number}>}
 */
export async function fixLocalLinkUrls() {
  const report = { tasks: 0, subtasks: 0, shortcuts: 0, rules: 0, total: 0 }

  // ① 任务（含子任务里的链接）
  try {
    const tasks = await db.tasks.toArray()
    const dirty = []
    for (const t of tasks) {
      if (!t) continue
      let hit = false
      const L = fixLinkArray(t.links)
      if (L.changed) { t.links = L.arr; hit = true; report.tasks++ }
      if (Array.isArray(t.subtasks)) {
        for (const s of t.subtasks) {
          if (!s) continue
          const S = fixLinkArray(s.links)
          if (S.changed) { s.links = S.arr; hit = true; report.subtasks++ }
        }
      }
      if (hit) dirty.push(t)
    }
    if (dirty.length) await db.tasks.bulkPut(dirty)
  } catch (e) {
    console.warn('[fixLocalLinkUrls] tasks 订正失败：', (e && e.message) || e)
  }

  // ② 快捷入口
  try {
    const list = await db.shortcuts.toArray()
    const dirty = []
    for (const s of list) {
      if (!s) continue
      const f = fixedLocalUrl(s.url)
      if (f && f !== s.url) { s.url = f; dirty.push(s); report.shortcuts++ }
    }
    if (dirty.length) await db.shortcuts.bulkPut(dirty)
  } catch (e) {
    console.warn('[fixLocalLinkUrls] shortcuts 订正失败：', (e && e.message) || e)
  }

  // ③ 预设任务规则（settings: periodicDutyTasks）
  try {
    const row = await db.settings.get('periodicDutyTasks')
    const rules = row && Array.isArray(row.value) ? row.value : null
    if (rules) {
      let dirty = false
      for (const r of rules) {
        if (!r) continue
        const L = fixLinkArray(r.links)
        if (L.changed) { r.links = L.arr; dirty = true; report.rules++ }
      }
      if (dirty) await db.settings.put({ key: 'periodicDutyTasks', value: rules })
    }
  } catch (e) {
    console.warn('[fixLocalLinkUrls] 预设任务 订正失败：', (e && e.message) || e)
  }

  report.total = report.tasks + report.subtasks + report.shortcuts + report.rules
  if (report.total) console.info('[fixLocalLinkUrls] 已订正被误加协议的本地路径链接：', report)
  return report
}
