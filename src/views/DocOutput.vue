<script setup>
import { reactive, ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { docState, pickFile, requestDocOutput, loadDocLog, clearDocLog, resetDocRun, getBridgeInfo } from '../docoutput.js'
import { db } from '../db'
import * as XLSX_NS from 'xlsx-js-style'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'

// xlsx-js-style 是 CJS/UMD 包，Vite 的 interop 结果视打包方式而定，
// 两种形态都兜住，避免 XLSX.utils 为 undefined。
const XLSX = XLSX_NS && XLSX_NS.utils ? XLSX_NS : (XLSX_NS.default || XLSX_NS)

const KEY = 'wb_docoutput_v1'

function defaultCfg() {
  return {
    aPath: '',
    bPath: '',
    fixedName: '',
    outDir: '',
    deleteSheet: '放函数表格',
    wpsUrl: 'https://www.kdocs.cn/l/cktBPeBOyqtQ',
    macro1: '',
    macro1AddIn: '数据看板处理.xlam',
    macro2: '',
    macro2AddIn: '数据看板函数匹配.xlam',
    macro2NeedsFilePick: true,
    sheets: [
      { local: '数据汇总统计', online: '数据汇总表', src: '', dst: '' },
      { local: '管道燃气', online: '管道燃气', src: '', dst: '' },
      { local: '瓶装燃气', online: '瓶装燃气', src: '', dst: '' },
      { local: '汽车加气', online: '汽车加气', src: '', dst: '' }
    ]
  }
}

const cfg = reactive(defaultCfg())
const logs = ref([])
// 执行记录分页：默认每页 6 条，可切 20/50/100（与知识库翻页一致）
const pageSize = ref(6)
const currentPage = ref(1)
const pageSizeOpen = ref(false)
const linkedRules = ref([])

async function loadLinkedRules() {
  try {
    const d = await db.settings.get('periodicDutyTasks')
    const rules = (d && d.value) || []
    linkedRules.value = rules.filter(r => r.docOutput)
  } catch (e) { linkedRules.value = [] }
}

function refreshLogs() {
  logs.value = loadDocLog()
  // 记录变少（清空/筛选）时把页码收回有效范围，避免停在空白页
  if (currentPage.value > totalPages.value) currentPage.value = totalPages.value
}
function fmtTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function fileName(p) {
  if (!p) return '-'
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(i + 1) : p
}
const logStats = computed(() => {
  const total = logs.value.length
  const success = logs.value.filter(l => l.ok).length
  const fail = total - success
  return { total, success, fail }
})
const totalPages = computed(() => Math.max(1, Math.ceil(logs.value.length / pageSize.value)))
const pagedLogs = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return logs.value.slice(start, start + pageSize.value)
})
function setPageSize(s) {
  pageSize.value = s
  currentPage.value = 1
  pageSizeOpen.value = false
}

function fmtFull(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
// 导出时附上「完整日志」的文件位置：本表只有摘要，排障必须看这些文件
// 目录来源：本地桥 /ping 返回的 bridgePath（…\workbench-REPLICA\local-bridge.cjs）去掉文件名
async function logFileHints() {
  let dir = ''
  try {
    const info = await getBridgeInfo()
    if (info && info.ok && info.bridgePath) {
      dir = String(info.bridgePath).replace(/[\\/][^\\/]+$/, '')
    }
  } catch (e) {}
  const at = (f) => (dir ? dir + '\\' + f : '<工作台目录>\\' + f)
  return [
    ['完整日志 · 步骤时间线（主证据）', at('doc-output.log')],
    ['完整日志 · 步骤结构（steps）', at('doc-output-result.json')],
    ['完整日志 · 本地桥请求记录', at('local-bridge.log')],
    ['完整日志 · 线上表格粘贴', at('_planB_node.log')],
    ['完整日志 · 弹窗自动点击', '%TEMP%\\docoutput_dlgwatch.log'],
    ['完整日志 · 窗口快照', '%TEMP%\\docoutput_windows.log'],
    ['完整日志 · 文件选择框', '%TEMP%\\docoutput_pick.log']
  ]
}
// ---- 导出 xlsx --------------------------------------------------------------
// 合并单元格 / 列宽 / 对齐 / 边框 CSV 一律做不到，所以这里直接产出 .xlsx。
// 列宽陷阱：SheetJS 会把 wch 再叠加 0.83203125 写进 <col width>，想得到目标
// 显示宽度（如 18）必须先扣掉该偏移，否则 Excel 里会宽出约 0.83。
const COL_K = 0.83203125
const colW = (n) => ({ wch: n - COL_K })
// 边框统一用黑色粗线（medium = Excel 的「粗框线」；thick 是特粗、thin 是细线）
const XL_EDGE = { style: 'medium', color: { rgb: 'FF000000' } }
const XL_BORDER = { top: XL_EDGE, bottom: XL_EDGE, left: XL_EDGE, right: XL_EDGE }

// xlsx-js-style 给空单元格写 <c ... t="str"><v></v></c>，会被 Excel 的 COUNTA
// 当成非空。这里把这类单元格改成自闭合 <c ... s="N"/>：**样式（边框）保留**，
// 但 COUNTA 会正确忽略它。与 Duty.vue 的导出后处理保持一致。
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

async function exportDocLogXlsx() {
  if (!logs.value.length) return
  const hints = await logFileHints()

  // 第 1 行 = A1:F1 合并单元格，放完整日志提示（标题 + 各日志文件位置，逐行换行）
  const titleLines = ['完整日志位置（本表只有摘要；排障请看以下文件）']
    .concat(hints.map((h) => h[0] + '：' + h[1]))
  const head = ['开始时间', '结束时间', '结果', 'A 文件路径', '失败步骤', '错误信息']
  const rows = logs.value.map((l) => [
    fmtFull(l.startedAt),
    fmtFull(l.endedAt),
    l.ok ? '成功' : '失败',
    l.aPath || '',
    l.ok ? '' : (tStep(l.failedStep || '') || ''),
    l.ok ? '' : (l.error || '')
  ])

  const aoa = [[titleLines.join('\n'), '', '', '', '', ''], head, ...rows]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const lastRow = aoa.length - 1

  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }]
  ws['!cols'] = [colW(18), colW(18), colW(8), colW(30), colW(36), colW(36)]
  // A1 行高按换行后的行数给足，否则多行文字会被压扁
  ws['!rows'] = [{ hpt: titleLines.length * 15 + 8 }]

  // 逐格样式（对齐规则）：
  //   A1:F1 合并块 —— 左对齐 + 自动换行
  //   A2:F2 表头行 —— 整行居中 + 自动换行
  //   数据行        —— A/B/C 居中；D/E/F（路径 / 失败步骤 / 错误信息）左对齐 + 自动换行
  // 没有值的格子也要补出来，否则带不上边框（表格会缺角）。
  for (let r = 0; r <= lastRow; r++) {
    for (let c = 0; c < 6; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      let cell = ws[addr]
      if (!cell) { cell = { t: 's', v: '' }; ws[addr] = cell }
      cell.s = {
        border: XL_BORDER,
        alignment: r === 0
          ? { horizontal: 'left', vertical: 'center', wrapText: true }
          : r === 1
            ? { horizontal: 'center', vertical: 'center', wrapText: true }
            : { horizontal: c <= 2 ? 'center' : 'left', vertical: 'center', wrapText: c >= 3 }
      }
    }
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: 5 } })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '执行记录')
  const buf = stripEmptyStringCells(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }))
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  a.href = url
  a.download = `文档输出执行记录_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function load() {
  try {
    const s = localStorage.getItem(KEY)
    if (s) Object.assign(cfg, JSON.parse(s))
  } catch (e) {}
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(cfg))
}
watch(cfg, save, { deep: true })
let logTimer = null
onMounted(() => { load(); refreshLogs(); loadLinkedRules(); logTimer = setInterval(refreshLogs, 2000) })

// 选 B（固定路径，配一次即可）；A 在点击执行时选择，不预存
// 传 'B' 让「已取消」弹窗用 B 自己的描述（不提 A 文件 / 数据看板输出）
async function pickB() {
  const p = await pickFile('B')
  if (p) cfg.bPath = p
}

function addSheet() {
  cfg.sheets.push({ local: '', online: '', src: '', dst: '' })
}
function removeSheet(i) {
  cfg.sheets.splice(i, 1)
}

// 步骤/错误 英文 -> 中文
// 防御性 String()：历史日志里的 failedStep / detail 可能是 number，统一转字符串
// 避免类似 `8.startsWith is not a function` 的渲染崩溃
function tStep(name) {
  const n = String(name == null ? '' : name)
  if (n.startsWith('paste:')) return '粘贴 ' + n.slice(6)
  const m = {
    openA: '打开 A 文件',
    macro1: '执行宏①（处理 A）',
    openB: '打开 B 文件',
    macro2: '执行宏②（公式匹配）',
    copyRename: '复制并重命名 B',
    deleteSheet: '删除指定 sheet',
    planB: '线上表格自动粘贴',
    openWps: '打开 WPS 线上表'
  }
  return m[n] || n
}
function tDetail(d) {
  const s = d == null ? '' : String(d)
  if (!s) return ''
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
    ['skipped', '已跳过（未配置）']
  ]
  for (const [en, zh] of map) {
    if (s.startsWith(en)) return zh + s.slice(en.length)
  }
  return s
}

onUnmounted(() => {
  // 状态在模块级，不在此清空；切走再切回仍可见
  if (logTimer) clearInterval(logTimer)
})
</script>

<template>
  <div class="docout">
    <header class="do-head">
      <div>
        <h2>文档输出</h2>
      </div>
      <span v-if="docState.running" class="tag do-run">执行中…</span>
    </header>

    <div v-if="docState.msg" class="do-msg">{{ docState.msg }}</div>

    <!-- 执行 + 关联预设任务：同一行左右两栏，避免右侧留大片空白 -->
    <section class="panel do-run-sec">
      <div class="run-grid">
        <div class="run-left">
          <div class="actions">
            <button class="primary" :disabled="docState.running || docState.picking" @click="requestDocOutput()">
              {{ docState.picking ? '已打开选择对话框…' : (docState.running ? '执行中…' : '数据看板输出') }}
            </button>
            <button v-if="docState.running" class="danger sm" @click="resetDocRun">强制结束 / 重置状态</button>
          </div>
          <p class="hint">优先使用下方 A 文件路径框；若为空，点「数据看板输出」会先尝试弹出文件框。执行中可点「强制结束 / 重置状态」清掉卡死状态。</p>
        </div>
        <div class="run-right">
          <h3>关联预设任务</h3>
          <p v-if="linkedRules.length === 0" class="muted">
            当前没有预设任务关联「文档输出」。请在 <strong>数据管理</strong> 里勾选「关联文档输出」；到完成时间后，任务卡片会出现「数据看板输出」按钮。
          </p>
          <ul v-else class="linked-list">
            <li v-for="r in linkedRules" :key="r.id">
              <span class="linked-dot" />
              <span>{{ r.title || r.name || '(未命名规则)' }}</span>
              <span v-if="r.dueTime" class="muted">完成时限 {{ r.dueTime }}</span>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- 执行状态：紧跟执行区，让用户点完立刻看到反馈 -->
    <section class="panel do-status" v-if="docState.result || docState.running || docState.aPath">
      <div class="panel-head">
        <h3>执行状态</h3>
        <button v-if="docState.running" class="danger sm" @click="resetDocRun">强制结束 / 重置状态</button>
      </div>
      <div v-if="docState.running" class="muted">本地执行中，请留意 Excel / WPS 窗口（宏② 的文件框会自动填路径）…</div>
      <div v-else-if="docState.result">
        <div :class="['status', docState.result.ok ? 'ok' : 'fail']">
          {{ docState.result.ok ? '✅ 执行成功' : '❌ 执行失败' }}
        </div>
        <p v-if="!docState.result.ok && docState.result.error" class="fail-detail">
          失败原因：{{ tDetail(docState.result.error) }}
        </p>
        <ul class="steps">
          <li v-for="(s, i) in (docState.result.steps || [])" :key="i" :class="s.ok ? 'ok' : 'fail'">
            <span class="step-no">{{ i + 1 }}.</span>
            <span class="step-name">{{ tStep(s.name) }}</span>
            <span v-if="!s.ok" class="step-err">✗ {{ tDetail(s.detail) }}</span>
            <span v-else-if="s.detail && s.detail !== 'skipped (not configured)'" class="step-ok">· {{ s.detail }}</span>
          </li>
        </ul>
        <p class="hint">本次 A：{{ docState.aPath }}</p>
        <p class="hint">详细日志见项目目录 <code>doc-output.log</code></p>
      </div>
    </section>

    <!-- 文件选择 -->
    <section class="panel do-files">
      <h3>① 文件</h3>
      <div class="field">
        <label>A 文件（导出文件，点「数据看板输出」会先弹出文件框让你选）</label>
      </div>
      <div class="field">
        <label>B 文件（待函数匹配表格，固定路径）</label>
        <div class="path-row">
          <input v-model="cfg.bPath" placeholder="请粘贴固定路径，或点右侧浏览" />
          <button class="ghost sm" :disabled="docState.picking" @click="pickB">浏览…</button>
        </div>
      </div>
    </section>

    <!-- 基础配置 -->
    <section class="panel do-config">
      <h3>② 基础配置</h3>
      <div class="grid2">
        <div class="field">
          <label>复制改名固定名（留空则用默认）</label>
          <input v-model="cfg.fixedName" placeholder="如 燃气数据汇总，最终为 名称_20260815.xlsx" />
        </div>
        <div class="field">
          <label>输出目录（改名后存放处）</label>
          <input v-model="cfg.outDir" placeholder="如 D:\文档输出，留空则用“文档”目录" />
        </div>
        <div class="field">
          <label>要删除的 sheet 名</label>
          <input v-model="cfg.deleteSheet" placeholder="如 放函数表格" />
        </div>
        <div class="field">
          <label>WPS 线上表链接</label>
          <input v-model="cfg.wpsUrl" placeholder="https://www.kdocs.cn/l/..." />
        </div>
        <div class="field">
          <label>宏① 所在加载项文件（.xlam，可填文件名或完整路径）</label>
          <input v-model="cfg.macro1AddIn" placeholder="如 数据看板处理.xlam 或 G:\\工具\\数据看板处理.xlam" />
        </div>
        <div class="field">
          <label>宏① 名称（初步处理 A）</label>
          <input v-model="cfg.macro1" placeholder="如 数据看板初步处理" />
        </div>
        <div class="field">
          <label>宏② 所在加载项文件（.xlam，可填文件名或完整路径）</label>
          <input v-model="cfg.macro2AddIn" placeholder="如 数据看板函数匹配.xlam 或 G:\\工具\\数据看板函数匹配.xlam" />
        </div>
        <div class="field">
          <label>宏② 名称（公式匹配 B）</label>
          <input v-model="cfg.macro2" placeholder="如 数据看板函数匹配" />
        </div>
        <div class="field check full">
          <label class="cb">
            <input type="checkbox" v-model="cfg.macro2NeedsFilePick" />
            <span>宏② 会弹“选处理过的 A'”文件框（脚本自动填路径）</span>
          </label>
        </div>
      </div>
    </section>

    <!-- Sheet 映射 -->
    <section class="panel do-maps">
      <div class="panel-head">
        <h3>③ Sheet 映射与范围</h3>
        <button class="ghost sm" @click="addSheet">+ 添加 sheet</button>
      </div>
      <p class="hint">本地 sheet 名 ↔ 线上表 sheet 名 一一对应；脚本会把源范围数据自动写入临时文件并粘贴到线上表的目标范围（粘贴前不清空，源/目标尺寸需一致）。</p>
      <div class="tbl">
        <div class="tbl-row tbl-head">
          <span>本地 sheet 名</span>
          <span>线上 sheet 名</span>
          <span>源范围</span>
          <span>目标范围</span>
          <span></span>
        </div>
        <div class="tbl-row" v-for="(s, i) in cfg.sheets" :key="i">
          <input v-model="s.local" placeholder="如 数据汇总统计" />
          <input v-model="s.online" placeholder="如 数据汇总表" />
          <input v-model="s.src" placeholder="如 A1:D100" />
          <input v-model="s.dst" placeholder="如 A2:D101" />
          <button class="danger sm" @click="removeSheet(i)">删</button>
        </div>
      </div>
    </section>

    <!-- 执行记录 -->
    <section class="panel do-logs">
      <div class="panel-head">
        <h3>执行记录</h3>
        <div class="log-actions">
          <span class="log-stat">共 {{ logStats.total }} 次 · 成功 {{ logStats.success }} · 失败 {{ logStats.fail }}</span>
          <button v-if="logs.length" class="ghost sm" @click="exportDocLogXlsx">导出记录</button>
          <button v-if="logs.length" class="ghost sm" @click="clearDocLog(); refreshLogs()">清空记录</button>
        </div>
      </div>
      <div v-if="!logs.length" class="muted">暂无执行记录</div>
      <template v-else>
        <div class="log-list">
          <div v-for="l in pagedLogs" :key="l.id" class="log-row" :class="l.ok ? 'ok' : 'fail'">
            <span class="log-time">{{ fmtTime(l.startedAt) }}</span>
            <span class="log-file" :title="l.aPath">{{ fileName(l.aPath) }}</span>
            <span class="log-result">{{ l.ok ? '成功' : '失败' }}</span>
            <div class="log-info">
              <span v-if="!l.ok && l.failedStep" class="log-step">{{ tStep(l.failedStep) }}</span>
              <span v-if="!l.ok && l.error" class="log-err" :title="l.error">{{ tDetail(l.error) }}</span>
            </div>
          </div>
        </div>
        <!-- 翻页行：与知识库「笔记库」翻页保持一致，默认每页 6 条 -->
        <div class="note-pager">
          <span class="muted pager-info">第 {{ currentPage }} / {{ totalPages }} 页 · 共 {{ logs.length }} 条</span>
          <div class="pager-controls">
            <button class="ghost sm" :disabled="currentPage <= 1" @click="currentPage--">上一页</button>
            <button class="ghost sm" :disabled="currentPage >= totalPages" @click="currentPage++">下一页</button>
            <span class="pager-sep"></span>
            <span class="muted">每页</span>
            <span class="pageSize-wrap">
              <button class="ghost sm pageSize-trigger" :class="{ active: pageSizeOpen }" @click.stop="pageSizeOpen = !pageSizeOpen">{{ pageSize }} 条 ▴</button>
              <div v-if="pageSizeOpen" class="pageSize-pop">
                <button v-for="s in [6, 20, 50, 100]" :key="s" class="ghost sm" :class="{ active: pageSize === s }" @click.stop="setPageSize(s)">{{ s }} 条</button>
              </div>
            </span>
          </div>
          <div v-if="pageSizeOpen" class="pop-backdrop" @click="pageSizeOpen = false"></div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.docout { padding: 8px 4px 40px; }
.do-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.do-head h2 { margin: 0 0 4px; font-size: 20px; }
.do-run { background: var(--accent-soft, #2aabe833); color: var(--accent, #2aabe8); }
.do-msg { background: var(--panel-2, #1c2430); border: 1px solid var(--line, #2a3340); padding: 10px 14px; border-radius: 10px; margin-bottom: 14px; font-size: 14px; }
.panel { background: var(--panel, #161c26); border: 1px solid var(--line, #2a3340); border-radius: 14px; padding: 16px 18px; margin-bottom: 14px; }
.panel h3 { margin: 0 0 12px; font-size: 15px; }
.panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.panel-head h3 { margin: 0; }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 13px; color: var(--text-2, #9aa7b4); margin-bottom: 6px; }
.field.check.full { grid-column: 1 / -1; margin-bottom: 0; }
.field.check label.cb {
  display: flex; align-items: center; gap: 10px; margin: 0;
  color: var(--text, #e6edf3); font-size: 13px; line-height: 1.5;
  background: var(--panel-2, #1c2430); border: 1px solid var(--line, #2a3340);
  border-radius: 8px; padding: 9px 12px; cursor: pointer;
  transition: border-color .15s;
}
.field.check label.cb:hover { border-color: var(--accent, #2aabe8); }
.field.check label.cb input[type="checkbox"] {
  width: 15px; height: 15px; margin: 0; flex: none;
  accent-color: var(--accent, #2aabe8); cursor: pointer;
}
.path-row { display: flex; gap: 8px; }
.path-row input { flex: 1; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 18px; }
.tbl { display: flex; flex-direction: column; gap: 8px; }
.tbl-row { display: grid; grid-template-columns: 1.2fr 1.2fr 1fr 1fr 40px; gap: 8px; align-items: center; }
.tbl-head { font-size: 12px; color: var(--text-2, #9aa7b4); }
.actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.hint { font-size: 12px; color: var(--text-2, #9aa7b4); margin: 6px 0 0; line-height: 1.6; }
.muted { color: var(--text-2, #9aa7b4); font-size: 13px; }
.status { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.status.ok { color: #23e2a0; }
.status.fail { color: #ef4444; }
.fail-detail { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #ff9a9a; padding: 8px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 10px; }
.steps { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.steps li { font-size: 13px; display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; }
.steps li.ok { color: var(--text-2, #9aa7b4); }
.steps li.fail { color: #ff9a9a; }
.step-no { font-variant-numeric: tabular-nums; }
.step-name { font-weight: 600; }
.step-err { color: #ff7a7a; }
.step-ok { color: var(--text-2, #9aa7b4); }
input, select { background: var(--panel-2, #1c2430); border: 1px solid var(--line, #2a3340); color: var(--text, #e6edf3); border-radius: 8px; padding: 8px 10px; font-size: 14px; width: 100%; box-sizing: border-box; }
button { cursor: pointer; border-radius: 8px; border: 1px solid var(--line, #2a3340); padding: 8px 14px; font-size: 14px; background: var(--panel-2, #1c2430); color: var(--text, #e6edf3); }
button.primary { background: var(--accent, #2aabe8); color: #fff; border-color: transparent; }
button.ghost { background: transparent; }
button.danger { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.4); color: #ff9a9a; }
button.sm { padding: 6px 10px; font-size: 13px; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
code { background: var(--panel-2, #1c2430); padding: 1px 6px; border-radius: 4px; }
.log-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.log-stat { font-size: 12px; color: var(--text-2, #9aa7b4); }
.log-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.log-row {
  display: grid;
  grid-template-columns: 110px 1fr 50px auto;
  gap: 10px;
  align-items: center;
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--panel-2, #1c2430);
}
.log-info { display: flex; flex-direction: column; gap: 2px; }
.log-err { color: #ff7a7a; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 360px; }
.log-row.ok { border-left: 3px solid var(--success, #23e2a0); }
.log-row.fail { border-left: 3px solid var(--danger, #ef4444); }
.log-time { color: var(--text-2, #9aa7b4); font-size: 12px; }
.log-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-result { font-weight: 600; }
.log-row.ok .log-result { color: var(--success, #23e2a0); }
.log-row.fail .log-result { color: var(--danger, #ef4444); }
.log-step { color: var(--danger, #ef4444); font-size: 12px; }
/* 执行区两栏：左＝操作，右＝关联预设任务（消掉右侧大片留白） */
.run-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
/* min-width:0 必加：否则 grid 子项被长文本撑开，会溢出撞到隔壁栏 */
.run-left { min-width: 0; }
.run-right { min-width: 0; border-left: 1px solid var(--line, #2a3340); padding-left: 18px; }
.run-right h3 { margin: 0 0 8px; font-size: 14px; }
.run-left .hint { overflow-wrap: anywhere; }
.linked-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.linked-list li { display: flex; align-items: center; gap: 10px; font-size: 13px; flex-wrap: wrap; }
.linked-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent, #2aabe8); flex: none; }

/* 执行记录翻页栏：与「笔记库」的翻页样式保持一致 */
.note-pager {
  display: flex; justify-content: space-between; align-items: center;
  flex-wrap: wrap; gap: 8px; padding: 6px 0 0; margin-top: 2px;
  border-top: 1px solid var(--line, #2a3340);
}
.pager-info { font-size: 12px; }
.pager-controls { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.pager-sep { width: 1px; height: 16px; background: var(--line, #2a3340); margin: 0 4px; }
/* 每页条数：点击向上弹出 */
.pageSize-wrap { position: relative; display: inline-flex; }
.pageSize-trigger { min-width: 66px; }
.pageSize-pop {
  position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; gap: 4px; padding: 6px;
  border-radius: 10px; border: 1px solid var(--line, #2a3340);
  background: var(--panel, #161c26); box-shadow: 0 10px 28px rgba(0, 0, 0, .18);
  z-index: 50; min-width: 88px;
}
.pageSize-pop .ghost.sm { width: 100%; text-align: center; justify-content: center; }
.pop-backdrop { position: fixed; inset: 0; z-index: 40; }
@media (max-width: 640px) {
  .run-grid { grid-template-columns: 1fr; }
  .run-right { border-left: none; padding-left: 0; border-top: 1px solid var(--line, #2a3340); padding-top: 12px; }
}
@media (max-width: 640px) {
  .log-row { grid-template-columns: 1fr; gap: 4px; }
  .grid2 { grid-template-columns: 1fr; }
  .tbl-row { grid-template-columns: 1fr 1fr; }
  .tbl-head { display: none; }
}

</style>
