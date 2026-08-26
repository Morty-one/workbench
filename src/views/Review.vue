<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import { db } from '../db'

const props = defineProps({
  search: { type: String, default: '' }
})

const QUAD = {
  'urgent-important': '重要紧急',
  'noturgent-important': '重要不紧急',
  'urgent-notimportant': '不重要紧急',
  'noturgent-notimportant': '不重要不紧急'
}

const tasks = ref([])
const notes = ref([])
const projects = ref([])

const DAY = 86400000

/* ---------- 大模型配置（仅存本机浏览器，复盘页联网时调用） ---------- */
// 后端预设：切换后自动填充默认 API 地址与推荐模型
const LLM_BACKENDS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
    keyTip: '在 platform.openai.com 获取'
  },
  deepseek: {
    label: 'DeepSeek（推荐）',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyTip: '在 platform.deepseek.com 获取'
  },
  ollama: {
    label: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.1:8b'],
    keyTip: '本地运行无需 API Key，可留空'
  },
  custom: {
    label: '自定义 OpenAI 兼容',
    baseUrl: '',
    models: [],
    keyTip: '填入你的 API Key（如服务不校验可留空）'
  }
}
const llm = reactive({ backend: 'deepseek', baseUrl: '', apiKey: '', model: '' })
const backendMeta = computed(() => LLM_BACKENDS[llm.backend] || LLM_BACKENDS.custom)
const keyPlaceholder = computed(() => (llm.backend === 'ollama' ? '本地运行可留空' : 'sk-...'))
const showAiSettings = ref(false)
const aiResult = ref('')
const aiLoading = ref(false)
const aiError = ref('')
const llmTip = ref('')
function flashLlm(m) {
  llmTip.value = m
  setTimeout(() => {
    if (llmTip.value === m) llmTip.value = ''
  }, 2500)
}
// 切换后端：若当前地址为空或等于某个预设地址，则自动填入新后端默认地址；模型不在预设列表时重置为首个推荐模型
function onBackendChange() {
  const meta = LLM_BACKENDS[llm.backend]
  if (!meta) return
  const presetUrls = Object.values(LLM_BACKENDS).map((b) => b.baseUrl).filter(Boolean)
  const cur = llm.baseUrl.trim()
  if (!cur || presetUrls.includes(cur)) llm.baseUrl = meta.baseUrl
  if (meta.models.length && !meta.models.includes(llm.model)) llm.model = meta.models[0]
}
async function loadLlm() {
  const a = await db.settings.get('llmBaseUrl')
  if (a?.value) llm.baseUrl = a.value
  const k = await db.settings.get('llmApiKey')
  if (k?.value) llm.apiKey = k.value
  const m = await db.settings.get('llmModel')
  if (m?.value) llm.model = m.value
  const b = await db.settings.get('llmBackend')
  if (b?.value && LLM_BACKENDS[b.value]) {
    llm.backend = b.value
  } else {
    // 旧数据迁移：按已存 baseUrl 推断后端
    const u = (llm.baseUrl || '').toLowerCase()
    if (u.includes('deepseek')) llm.backend = 'deepseek'
    else if (u.includes('localhost') || u.includes('127.0.0.1')) llm.backend = 'ollama'
    else if (u) llm.backend = 'openai'
    else llm.backend = 'deepseek'
  }
  if (!llm.baseUrl.trim()) llm.baseUrl = LLM_BACKENDS[llm.backend].baseUrl
  if (!llm.model && LLM_BACKENDS[llm.backend].models.length) llm.model = LLM_BACKENDS[llm.backend].models[0]
}
async function saveLlm() {
  await db.settings.put({ key: 'llmBackend', value: llm.backend })
  await db.settings.put({ key: 'llmBaseUrl', value: llm.baseUrl.trim() })
  await db.settings.put({ key: 'llmApiKey', value: llm.apiKey.trim() })
  await db.settings.put({ key: 'llmModel', value: llm.model.trim() })
  flashLlm('AI 设置已保存（仅存本机）')
}
// 近 7 日每日完成数（喂给大模型做趋势复盘）
const trend7 = computed(() => {
  const arr = []
  for (let i = 6; i >= 0; i--) {
    const s = todayStart - i * DAY
    const e = s + DAY
    const c = tasks.value.filter((t) => t.status === '已完成' && (t.completedAt || 0) >= s && (t.completedAt || 0) < e).length
    arr.push({ label: `${new Date(s).getMonth() + 1}/${new Date(s).getDate()}`, value: c })
  }
  return arr
})
// 组装本地上下文（今日任务 + 笔记 + 近7天趋势）
function buildContext() {
  const fmt = (t) => `· ${t.title}（${QUAD[t.quadrant] || '未分级'}${t.status ? ' · ' + t.status : ''}）`
  const lines = []
  lines.push('【今日新建任务】')
  lines.push(todayCreated.value.length ? todayCreated.value.map(fmt).join('\n') : '（无）')
  lines.push('')
  lines.push('【今日完成任务】')
  lines.push(todayDone.value.length ? todayDone.value.map(fmt).join('\n') : '（无）')
  lines.push('')
  lines.push('【进行中任务】')
  lines.push(inProgress.value.length ? inProgress.value.map(fmt).join('\n') : '（无）')
  lines.push('')
  lines.push('【逾期待办】')
  lines.push(overdue.value.length ? overdue.value.map(fmt).join('\n') : '（无）')
  lines.push('')
  lines.push('【今日笔记】')
  lines.push(todayNotes.value.length ? todayNotes.value.map((n) => '· ' + n.title).join('\n') : '（无）')
  lines.push('')
  lines.push('【近 7 日每日完成数】')
  lines.push(trend7.value.map((d) => `${d.label}: ${d.value} 项`).join('，'))
  return lines.join('\n')
}
// 调用通用 OpenAI 兼容接口（/chat/completions）整理复盘
async function runAI() {
  aiError.value = ''
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    aiError.value = '当前离线，无法调用大模型。可手动在下方「每日梳理」填写。'
    return
  }
  const needKey = llm.backend !== 'ollama'
  if (!llm.baseUrl.trim() || (needKey && !llm.apiKey.trim())) {
    aiError.value = '请先在「⚙ 设置」中选择 AI 后端并填写 API Key（仅存本机浏览器）。'
    return
  }
  aiLoading.value = true
  try {
    const ctx = buildContext()
    const base = llm.baseUrl.trim().replace(/\/$/, '')
    const resp = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + llm.apiKey.trim()
      },
      body: JSON.stringify({
        model: llm.model.trim() || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              '你是个人每日复盘助手。请根据用户提供的当日任务、笔记与近7天趋势，用简洁中文分点整理：1）今日做了什么；2）值得注意的事项（风险 / 拖延 / 亮点）；3）给明日的一句话建议。不要编造未提供的内容。'
          },
          { role: 'user', content: ctx }
        ],
        temperature: 0.3
      })
    })
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      throw new Error('HTTP ' + resp.status + ' ' + txt.slice(0, 200))
    }
    const data = await resp.json()
    const content = data?.choices?.[0]?.message?.content || ''
    aiResult.value = content.trim()
  } catch (err) {
    aiError.value = '调用失败：' + (err?.message || err)
  } finally {
    aiLoading.value = false
  }
}
function applyAiToReflection() {
  if (!aiResult.value) return
  reflection.value = (reflection.value ? reflection.value + '\n\n' : '') + aiResult.value
}

const today0 = new Date()
today0.setHours(0, 0, 0, 0)
const todayStart = today0.getTime()
const todayEnd = todayStart + 24 * 3600 * 1000
const yesterdayStart = todayStart - 24 * 3600 * 1000

async function load() {
  const [t, n, p] = await Promise.all([
    db.tasks.toArray(),
    db.notes.toArray(),
    db.projects.toArray()
  ])
  tasks.value = t
  notes.value = n
  projects.value = p
}
onMounted(async () => {
  await load()
  await loadLlm()
})
// 其他页面增删改任务/笔记后，回到复盘页也能看到最新数据
window.addEventListener('task-updated', load)
window.addEventListener('note-updated', load)
onUnmounted(() => {
  window.removeEventListener('task-updated', load)
  window.removeEventListener('note-updated', load)
})

const projName = (id) => {
  const p = projects.value.find((x) => x.id === id)
  return p ? p.name : '未关联'
}

const q = computed(() => (props.search || '').trim().toLowerCase())

// 今日新建 / 今日完成 / 进行中（未完成且未逾期于今日之前）
const todayCreated = computed(() =>
  tasks.value.filter((t) => (t.createdAt || 0) >= todayStart && (t.createdAt || 0) < todayEnd)
)
const todayDone = computed(() =>
  tasks.value.filter((t) => t.status === '已完成' && (t.completedAt || 0) >= todayStart && (t.completedAt || 0) < todayEnd)
)
const inProgress = computed(() => tasks.value.filter((t) => t.status === '跟进中'))
const overdue = computed(() => {
  const now = Date.now()
  return tasks.value.filter(
    (t) => t.status !== '已完成' && (t.nextRemindAt ?? t.followUpAt ?? 0) > 0 && (t.nextRemindAt ?? t.followUpAt) < now
  )
})
const todayNotes = computed(() =>
  notes.value.filter((n) => (n.createdAt || n.updatedAt || 0) >= todayStart)
)

function filterOf(list) {
  if (!q.value) return list
  return list.filter((it) => {
    const hay = ((it.title || '') + ' ' + (it.remark || '') + ' ' + (it.content || '') + ' ' + projName(it.projectId)).toLowerCase()
    return hay.includes(q.value)
  })
}

const dayStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })

const reflection = ref('')
const REVIEW_KEY = 'wb_review_' + new Date().toISOString().slice(0, 10)
onMounted(() => {
  reflection.value = localStorage.getItem(REVIEW_KEY) || ''
})
watch(reflection, (v) => localStorage.setItem(REVIEW_KEY, v))

const stats = computed(() => [
  { label: '今日新建', value: todayCreated.value.length, accent: 'primary' },
  { label: '今日完成', value: todayDone.value.length, accent: 'success' },
  { label: '进行中', value: inProgress.value.length, accent: 'primary' },
  { label: '逾期待办', value: overdue.value.length, accent: 'danger' }
])

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}
</script>

<template>
  <div class="review">
    <div class="rev-head">
      <div>
        <h2 class="rev-title">每日复盘</h2>
        <p class="rev-date muted">{{ dayStr }}</p>
      </div>
    </div>

    <!-- 概览指标 -->
    <div class="rev-stats">
      <div v-for="s in stats" :key="s.label" class="stat-card" :class="`accent-${s.accent}`">
        <div class="stat-value">{{ s.value }}</div>
        <div class="stat-label">{{ s.label }}</div>
      </div>
    </div>

    <!-- AI 智能复盘 -->
    <section class="rev-panel ai-panel">
      <div class="panel-head">
        <span class="panel-title">AI 智能复盘</span>
        <div class="ai-head-right">
          <button class="ghost sm" @click="showAiSettings = !showAiSettings">⚙ 设置</button>
          <button class="primary sm" :disabled="aiLoading" @click="runAI">
            {{ aiLoading ? '整理中…' : 'AI 整理' }}
          </button>
        </div>
      </div>
      <p class="muted ai-tip">联网时调用你配置的大模型，整理今日任务 / 笔记 / 近 7 天趋势。离线或未配置则手动填写下方「每日梳理」。</p>

      <div v-if="showAiSettings" class="ai-settings">
        <label class="ai-field">
          <span>AI 后端</span>
          <select v-model="llm.backend" @change="onBackendChange">
            <option v-for="(b, k) in LLM_BACKENDS" :key="k" :value="k">{{ b.label }}</option>
          </select>
        </label>
        <label class="ai-field">
          <span>API Key</span>
          <input v-model="llm.apiKey" type="password" :placeholder="keyPlaceholder" />
          <span class="ai-hint">{{ backendMeta.keyTip }}</span>
        </label>
        <label class="ai-field">
          <span>模型</span>
          <select v-if="backendMeta.models.length" v-model="llm.model">
            <option v-for="mo in backendMeta.models" :key="mo" :value="mo">{{ mo }}</option>
            <option v-if="llm.model && !backendMeta.models.includes(llm.model)" :value="llm.model">{{ llm.model }}（当前）</option>
          </select>
          <input v-else v-model="llm.model" placeholder="模型名，如 qwen2.5-7b-instruct" />
        </label>
        <label class="ai-field">
          <span>API 地址（含 /v1，一般无需修改）</span>
          <input v-model="llm.baseUrl" :placeholder="backendMeta.baseUrl || 'https://your-server/v1'" />
        </label>
        <div class="ai-set-actions">
          <button class="ghost sm" @click="saveLlm">保存设置</button>
          <span v-if="llmTip" class="ok">{{ llmTip }}</span>
        </div>
      </div>

      <p v-if="aiError" class="ai-error">{{ aiError }}</p>

      <div v-if="aiResult" class="ai-result">
        <div class="ai-result-head">
          <span>大模型整理结果</span>
          <button class="ghost sm" @click="applyAiToReflection">＋ 填入每日梳理</button>
        </div>
        <pre class="ai-text">{{ aiResult }}</pre>
      </div>
    </section>

    <div class="rev-grid">
      <!-- 今日任务管理 -->
      <section class="rev-panel rev-tasks">
        <div class="panel-head">
          <span class="panel-title">今日任务</span>
          <span class="panel-sub muted">新建 {{ todayCreated.length }} · 完成 {{ todayDone.length }}</span>
        </div>

        <div class="panel-block">
          <div class="block-label">进行中（{{ inProgress.length }}）</div>
          <ul v-if="filterOf(inProgress).length" class="rev-list">
            <li v-for="t in filterOf(inProgress)" :key="t.id" class="rev-item">
              <span class="dot" :class="`q-${(t.quadrant || '').replace(/-/g, '')}`"></span>
              <div class="rev-main">
                <div class="rev-t">{{ t.title }}</div>
                <div class="rev-meta muted">{{ projName(t.projectId) }} ｜ {{ QUAD[t.quadrant] || '未分级' }}</div>
              </div>
            </li>
          </ul>
          <p v-else class="empty muted">暂无进行中的任务</p>
        </div>

        <div class="panel-block">
          <div class="block-label danger-text">逾期待办（{{ overdue.length }}）</div>
          <ul v-if="filterOf(overdue).length" class="rev-list">
            <li v-for="t in filterOf(overdue)" :key="t.id" class="rev-item">
              <span class="dot" :class="`q-${(t.quadrant || '').replace(/-/g, '')}`"></span>
              <div class="rev-main">
                <div class="rev-t">{{ t.title }}</div>
                <div class="rev-meta muted">{{ projName(t.projectId) }} ｜ 已逾期</div>
              </div>
            </li>
          </ul>
          <p v-else class="empty success-text">无逾期，状态良好</p>
        </div>
      </section>

      <!-- 今日笔记记录 -->
      <section class="rev-panel rev-notes">
        <div class="panel-head">
          <span class="panel-title">今日笔记</span>
          <span class="panel-sub muted">{{ todayNotes.length }} 篇</span>
        </div>
        <ul v-if="filterOf(todayNotes).length" class="rev-list">
          <li v-for="n in filterOf(todayNotes)" :key="n.id" class="rev-item">
            <span class="tag">{{ n.type === 'meeting' ? '纪要' : n.type === 'doc' ? '文档' : '笔记' }}</span>
            <div class="rev-main">
              <div class="rev-t">{{ n.title }}</div>
              <div class="rev-meta muted">{{ fmtTime(n.updatedAt || n.createdAt) }}</div>
            </div>
          </li>
        </ul>
        <p v-else class="empty muted">今天还没有记录笔记</p>
      </section>
    </div>

    <!-- 每日梳理 -->
    <section class="rev-panel reflect">
      <div class="panel-head">
        <span class="panel-title">每日梳理</span>
        <div class="row" style="align-items: center; gap: 8px">
          <VoiceInput v-model="reflection" />
          <span class="panel-sub muted">仅本机保存，每天一份</span>
        </div>
      </div>
      <textarea
        v-model="reflection"
        class="reflect-area"
        placeholder="今天完成了什么？卡在哪里？明天最重要的一件事是什么？把想法记下来，帮助沉淀。"
      ></textarea>
    </section>
  </div>
</template>

<style scoped>
.review {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.rev-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}
.rev-title {
  font-size: 22px;
  font-weight: 700;
  margin: 0;
  letter-spacing: 0.5px;
}
.rev-date {
  margin: 4px 0 0;
  font-size: 13px;
}
.rev-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.stat-card {
  border-radius: var(--radius);
  padding: 16px;
  background: var(--panel-solid);
  border: 1px solid var(--border);
  box-shadow: inset 0 1px rgba(255, 255, 255, .08), 0 8px 22px rgba(0, 0, 0, .18);
}
[data-theme="light"] .stat-card {
  box-shadow: inset 0 1px rgba(255, 255, 255, .7), 0 4px 14px rgba(15, 23, 42, .05);
}
.stat-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
}
.stat-label {
  margin-top: 6px;
  font-size: 13px;
  color: var(--muted);
}
.accent-primary .stat-value { color: var(--primary); }
.accent-success .stat-value { color: var(--success, #23e2a0); }
.accent-danger .stat-value { color: var(--danger); }

.rev-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.rev-panel {
  border-radius: var(--radius);
  padding: 16px;
  background: var(--panel-solid);
  border: 1px solid var(--border);
  box-shadow: inset 0 1px rgba(255, 255, 255, .08), 0 8px 22px rgba(0, 0, 0, .18);
}
[data-theme="light"] .rev-panel {
  box-shadow: inset 0 1px rgba(255, 255, 255, .7), 0 4px 14px rgba(15, 23, 42, .05);
}
.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
.panel-title {
  font-size: 15px;
  font-weight: 600;
}
.panel-sub {
  font-size: 12px;
}
.panel-block { margin-bottom: 14px; }
.panel-block:last-child { margin-bottom: 0; }
.block-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--muted);
}
.danger-text { color: var(--danger); }
.success-text { color: var(--success, #23e2a0); }

.rev-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rev-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--panel-2);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex: none;
  background: var(--muted);
}
.q-urgentimportant { background: #ef4444; }
.q-noturgentimportant { background: #2aabe8; }
.q-urgentnotimportant { background: #e69d23; }
.q-noturgentnotimportant { background: #845ee7; }
.tag {
  flex: none;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary);
  font-weight: 600;
}
.rev-main { min-width: 0; }
.rev-t {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rev-meta { font-size: 12px; margin-top: 2px; }
.empty {
  font-size: 13px;
  padding: 10px 0;
  text-align: center;
}
.reflect .reflect-area {
  width: 100%;
  min-height: 140px;
  resize: vertical;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font-size: 14px;
  line-height: 1.6;
  font-family: inherit;
}
.reflect .reflect-area:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
/* ---------- AI 智能复盘 ---------- */
.ai-panel {
  border: 1px solid var(--primary-soft);
}
.ai-head-right {
  display: flex;
  gap: 8px;
}
.ai-tip {
  font-size: 12px;
  margin: -4px 0 10px;
}
.ai-settings {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  margin-bottom: 10px;
}
.ai-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}
.ai-field input,
.ai-field select {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel-solid);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
}
.ai-field input:focus,
.ai-field select:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.ai-hint {
  font-size: 11px;
  color: var(--muted);
}
.ai-set-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ai-set-actions .ok {
  color: var(--success);
  font-size: 13px;
}
.ai-error {
  font-size: 13px;
  color: var(--danger);
  background: var(--danger-soft);
  border-radius: 8px;
  padding: 8px 10px;
  margin: 4px 0 0;
}
.ai-result {
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.ai-result-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--panel-2);
  font-size: 13px;
  font-weight: 600;
}
.ai-text {
  margin: 0;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  color: var(--text);
  background: var(--panel-solid);
  max-height: 360px;
  overflow-y: auto;
}
@media (max-width: 768px) {
  .rev-stats { grid-template-columns: repeat(2, 1fr); }
  .rev-grid { grid-template-columns: 1fr; }
}

</style>
