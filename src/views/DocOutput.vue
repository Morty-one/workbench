<script setup>
import { reactive, ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { docState, pickFile, requestDocOutput, loadDocLog, clearDocLog, resetDocRun } from '../docoutput.js'
import { db } from '../db'

const KEY = 'wb_docoutput_v1'

function defaultCfg() {
  return {
    aPath: '',
    bPath: '',
    fixedName: '',
    outDir: '',
    deleteSheet: '放函数表格',
    wpsUrl: 'https://www.kdocs.cn/l/cktBPeBOyqtQ',
    txtDir: '',
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
const showAllLogs = ref(false)
const linkedRules = ref([])
const manualAPath = ref('')

async function pickA() {
  const p = await pickFile()
  if (p) manualAPath.value = p
}

async function loadLinkedRules() {
  try {
    const d = await db.settings.get('periodicDutyTasks')
    const rules = (d && d.value) || []
    linkedRules.value = rules.filter(r => r.docOutput)
  } catch (e) { linkedRules.value = [] }
}

function refreshLogs() {
  logs.value = loadDocLog()
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
const displayedLogs = computed(() => {
  return showAllLogs.value ? logs.value : logs.value.slice(0, 20)
})

function fmtFull(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function csvCell(v) {
  const s = (v === null || v === undefined) ? '' : String(v)
  return '"' + s.replace(/"/g, '""') + '"'
}
function exportDocLogCsv() {
  if (!logs.value.length) return
  const head = ['开始时间', '结束时间', '结果', 'A 文件', '失败步骤', '错误信息']
  const rows = logs.value.map(l => [
    fmtFull(l.startedAt),
    fmtFull(l.endedAt),
    l.ok ? '成功' : '失败',
    l.aPath || '',
    l.ok ? '' : (tStep(l.failedStep || '') || ''),
    l.ok ? '' : (l.error || '')
  ].map(csvCell).join(','))
  const csv = '\uFEFF' + head.map(csvCell).join(',') + '\r\n' + rows.join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  a.href = url
  a.download = `文档输出执行记录_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.csv`
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
async function pickB() {
  const p = await pickFile()
  if (p) cfg.bPath = p
}

function addSheet() {
  cfg.sheets.push({ local: '', online: '', src: '', dst: '' })
}
function removeSheet(i) {
  cfg.sheets.splice(i, 1)
}

// 步骤/错误 英文 -> 中文
function tStep(name) {
  if (name.startsWith('paste:')) return '粘贴 ' + name.slice(6)
  const m = {
    openA: '打开 A 文件',
    macro1: '执行宏①（处理 A）',
    openB: '打开 B 文件',
    macro2: '执行宏②（公式匹配）',
    copyRename: '复制并重命名 B',
    deleteSheet: '删除指定 sheet',
    openWps: '打开 WPS 线上表'
  }
  return m[name] || name
}
function tDetail(d) {
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
    ['skipped', '已跳过（未配置）']
  ]
  for (const [en, zh] of map) {
    if (d.startsWith(en)) return zh + d.slice(en.length)
  }
  return d
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

    <!-- 执行（提到上方，配置完无需拉到页面底部即可执行） -->
    <section class="panel do-run-sec">
      <div class="actions">
        <button class="primary" :disabled="docState.running || docState.picking" @click="requestDocOutput(manualAPath)">
          {{ docState.picking ? '已打开选择对话框…' : (docState.running ? '执行中…' : '执行文档输出') }}
        </button>
        <button v-if="docState.running" class="danger sm" @click="resetDocRun">强制结束 / 重置状态</button>
      </div>
      <p class="hint">优先使用下方 A 文件路径框；若为空，点「执行」会先尝试弹出文件框。执行中可点「强制结束」清掉卡死状态。</p>
    </section>

    <!-- 关联预设任务说明 -->
    <section class="panel do-linked">
      <h3>关联预设任务</h3>
      <p v-if="linkedRules.length === 0" class="muted">
        当前没有预设任务关联「文档输出」。请在 <strong>数据管理 → 自动化规则/值班预设</strong> 里添加/编辑规则，勾选「关联文档输出」；到完成时间后，生成的任务卡片会出现「执行文档输出」按钮。
      </p>
      <ul v-else class="linked-list">
        <li v-for="r in linkedRules" :key="r.id">
          <span class="linked-dot" />
          <span>{{ r.title || r.name || '(未命名规则)' }}</span>
          <span v-if="r.dueTime" class="muted">完成时限 {{ r.dueTime }}</span>
        </li>
      </ul>
    </section>

    <!-- 文件选择 -->
    <section class="panel do-files">
      <h3>① 文件</h3>
      <div class="field">
        <label>A 文件（导出文件，名称随日期变化）</label>
        <p class="hint">每次执行时填写最新导出文件路径即可；也可点「浏览…」尝试弹出系统文件框（若弹不出，直接粘贴路径）。</p>
        <div class="path-row">
          <input v-model="manualAPath" placeholder="如 G:\desk\数据看板模板\2026-08-15 08_38_24.xlsx" @keyup.enter="requestDocOutput(manualAPath)" />
          <button class="ghost sm" :disabled="docState.picking" @click="pickA">浏览…</button>
        </div>
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
          <label>TXT 中转目录（留空用系统临时目录）</label>
          <input v-model="cfg.txtDir" placeholder="如 D:\文档输出\tmp，用完即删" />
        </div>
        <div class="field">
          <label>宏① 名称（初步处理 A）</label>
          <input v-model="cfg.macro1" placeholder="如 数据看板初步处理" />
        </div>
        <div class="field">
          <label>宏① 所在加载项文件（.xlam，可填文件名或完整路径）</label>
          <input v-model="cfg.macro1AddIn" placeholder="如 数据看板处理.xlam 或 G:\\工具\\数据看板处理.xlam" />
        </div>
        <div class="field">
          <label>宏② 名称（公式匹配 B）</label>
          <input v-model="cfg.macro2" placeholder="如 数据看板函数匹配" />
        </div>
        <div class="field">
          <label>宏② 所在加载项文件（.xlam，可填文件名或完整路径）</label>
          <input v-model="cfg.macro2AddIn" placeholder="如 数据看板函数匹配.xlam 或 G:\\工具\\数据看板函数匹配.xlam" />
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
      <p class="hint">本地 sheet 名 ↔ 线上表 sheet 名 一一对应；源范围复制到 TXT，再按目标范围粘贴（粘贴前不清空，源/目标尺寸需一致）。</p>
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

    <!-- 状态 -->
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

    <!-- 执行记录 -->
    <section class="panel do-logs">
      <div class="panel-head">
        <h3>执行记录</h3>
        <div class="log-actions">
          <span class="log-stat">共 {{ logStats.total }} 次 · 成功 {{ logStats.success }} · 失败 {{ logStats.fail }}</span>
          <button v-if="logs.length" class="ghost sm" @click="exportDocLogCsv">导出记录</button>
          <button v-if="logs.length" class="ghost sm" @click="clearDocLog(); refreshLogs()">清空记录</button>
        </div>
      </div>
      <div v-if="!logs.length" class="muted">暂无执行记录</div>
      <div v-else class="log-list">
        <div v-for="l in displayedLogs" :key="l.id" class="log-row" :class="l.ok ? 'ok' : 'fail'">
          <span class="log-time">{{ fmtTime(l.startedAt) }}</span>
          <span class="log-file" :title="l.aPath">{{ fileName(l.aPath) }}</span>
          <span class="log-result">{{ l.ok ? '成功' : '失败' }}</span>
          <div class="log-info">
            <span v-if="!l.ok && l.failedStep" class="log-step">{{ tStep(l.failedStep) }}</span>
            <span v-if="!l.ok && l.error" class="log-err" :title="l.error">{{ tDetail(l.error) }}</span>
          </div>
        </div>
      </div>
      <button v-if="logs.length > 20" class="ghost sm" @click="showAllLogs = !showAllLogs">
        {{ showAllLogs ? '收起' : '显示全部 ' + logs.length + ' 条' }}
      </button>
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
.do-linked { background: var(--accent-soft, rgba(42,171,232,0.08)); border: 1px solid var(--accent-300, rgba(42,171,232,0.25)); }
.linked-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.linked-list li { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.linked-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent, #2aabe8); }
@media (max-width: 640px) {
  .log-row { grid-template-columns: 1fr; gap: 4px; }
  .grid2 { grid-template-columns: 1fr; }
  .tbl-row { grid-template-columns: 1fr 1fr; }
  .tbl-head { display: none; }
}

</style>
