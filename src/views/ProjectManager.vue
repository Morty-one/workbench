<script setup>
/**
 * 项目管理弹窗
 * 增 / 改 / 删 / 排序项目；完成度支持自动统计或手动指定。
 * 删除项目会**级联删除它的整棵子树**（含所有层级的子项目及其任务），删除前提示共几个项目 / 几个任务。
 */
import { ref, computed, watch, onMounted, reactive } from 'vue'
import { db } from '../db'
import { shiftKeyOf } from '../shift'
// 第 44 轮：原生 confirm 换成应用内对话框
import { appConfirm } from '../utils/appDialog.js'

const props = defineProps({
  tasks: { type: Array, default: () => [] }
})
const emit = defineEmits(['close', 'changed'])

const list = ref([])
const editing = ref(null) // null 或 project 对象副本
const err = ref('')

const PRESET_COLORS = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899', '#64748b']

async function load() {
  list.value = (await db.projects.toArray()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
onMounted(load)

// 整棵子树（含子项目、孙项目）的项目 id 集合 —— **展示 / 统计用**。
// ⚠️ 递归时排除已归档的子项目 —— 与总览 ProjectStack.calcCard 的 subtreeIds 保持完全一致，
//    否则同一棵项目树在两个页面会算出不同的任务数。
function subtreeIds(id, out = new Set()) {
  if (id == null || out.has(id)) return out
  out.add(id)
  list.value
    .filter((x) => !x.archived && (x.parentId || null) === id)
    .forEach((x) => subtreeIds(x.id, out))
  return out
}
// 整棵子树 id 集合 —— **删除专用，必须含归档项目**。
// ⚠️ 不能复用上面那个（它排除归档）：归档的子项目同样要跟着父项目一起删，
//    否则它的 parentId 会指向一个已删项目，变成界面里再也看不见的孤儿。
function subtreeIdsForDelete(id, out = new Set()) {
  if (id == null || out.has(id)) return out
  out.add(id)
  list.value
    .filter((x) => (x.parentId || null) === id)
    .forEach((x) => subtreeIdsForDelete(x.id, out))
  return out
}
// 整棵子树的任务数 —— **列表展示用它**。
// 口径与总览项目卡片一致：项目常被当「文件夹」，任务都挂在最底层子项目上，
// 只算直接任务的话父项目永远显示 0/0 任务（用户 2026-09-13 反馈「0 不合理」）。
function taskCount(id) {
  const ids = subtreeIds(id)
  const all = props.tasks.filter((t) => ids.has(t.projectId))
  return { total: all.length, done: all.filter((t) => t.status === '已完成').length }
}
// 直接子项目数（不递归，用于「含 N 个子项目」提示；同样排除归档，与总览一致）
function childCount(id) {
  return list.value.filter((x) => !x.archived && (x.parentId || null) === id).length
}

function toDateInput(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function startNew() {
  err.value = ''
  editing.value = {
    id: null,
    name: '',
    color: PRESET_COLORS[list.value.length % PRESET_COLORS.length],
    progressMode: 'auto',
    manualProgress: 0,
    desc: '',
    startDate: toDateInput(Date.now()),
    endDate: '',
    archived: 0,
    autoChildren: 0
  }
}
function startEdit(p) {
  err.value = ''
  editing.value = {
    id: p.id,
    name: p.name,
    color: p.color || PRESET_COLORS[0],
    progressMode: p.progressMode || 'auto',
    manualProgress: Number(p.manualProgress) || 0,
    desc: p.desc || '',
    startDate: toDateInput(p.startAt),
    endDate: toDateInput(p.endAt),
    archived: p.archived ? 1 : 0,
    autoChildren: p.autoChildren ? 1 : 0
  }
}

async function save() {
  const e = editing.value
  if (!e) return
  const name = (e.name || '').trim()
  if (!name) {
    err.value = '项目名称不能为空'
    return
  }
  const dup = list.value.find((p) => p.name === name && p.id !== e.id)
  if (dup) {
    err.value = '已存在同名项目'
    return
  }
  const payload = {
    name,
    color: e.color,
    progressMode: e.progressMode,
    manualProgress: Math.min(100, Math.max(0, Number(e.manualProgress) || 0)),
    desc: (e.desc || '').trim(),
    startAt: e.startDate ? new Date(`${e.startDate}T00:00:00`).getTime() : null,
    endAt: e.endDate ? new Date(`${e.endDate}T23:59:59`).getTime() : null,
    archived: e.archived ? 1 : 0,
    autoChildren: e.autoChildren ? 1 : 0
}
if (e.id) {
    await db.projects.update(e.id, payload)
  } else {
    payload.order = list.value.length
    payload.createdAt = Date.now()
    await db.projects.add(payload)
  }
  // 纯懒加载：开启「自动子项目」后不预建结构，月/周容器在任务生成时按需创建
  editing.value = null
  await load()
  emit('changed')
}

async function remove(p) {
  // 级联删除整棵子树（用户 2026-09-13 定案 A）。含归档子项目，避免留下孤儿。
  const ids = subtreeIdsForDelete(p.id)
  const childN = ids.size - 1
  const taskN = props.tasks.filter((t) => ids.has(t.projectId)).length
  const remain = list.value.filter((x) => !ids.has(x.id)).length
  if (remain <= 0) {
    alert('不能删除全部项目，至少要保留一个。')
    return
  }
  const detail = []
  if (childN > 0) detail.push(`含 ${childN} 个子项目（共 ${childN + 1} 个项目）`)
  if (taskN > 0) detail.push(`${taskN} 个任务`)
  const ok = await appConfirm({
    title: `删除项目「${p.name}」`,
    message: detail.length
      ? `将被一并删除：${detail.join('、')}。`
      : '该项目下暂无子项目和任务。',
    warn: '此操作不可恢复。',
    danger: true,
    okText: '删除项目'
  })
  if (!ok) return
  await db.transaction('rw', db.projects, db.tasks, async () => {
    await db.tasks.where('projectId').anyOf([...ids]).delete()
    await db.projects.bulkDelete([...ids])
  })
  await load()
  emit('changed')
}

async function move(p, dir) {
  const idx = list.value.findIndex((x) => x.id === p.id)
  const target = idx + dir
  if (target < 0 || target >= list.value.length) return
  const other = list.value[target]
  // 交换 order，避免整表重排
  await db.projects.update(p.id, { order: other.order ?? target })
  await db.projects.update(other.id, { order: p.order ?? idx })
  await load()
  emit('changed')
}

/* ---------- 按日程添加项目 ----------
 * 班次判定统一走 shift.js 的 shiftKeyOf(shift, dateStr)（带日期 → 周末白班按「非工作日」判定）。
 * 不再在本文件内重复维护一份不传日期、不做归一化的本地版本（2026-09-02 用户确认三处统一）。
 */
function ymd(y, m, d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${y}-${p(m + 1)}-${p(d)}`
}
const dutyPersons = ref([])
const allDuty = ref([])
const showDuty = ref(false)
const dutyNameEdited = ref(false)
const dutyForm = reactive({ person: '', mode: 'duty', start: '', end: '', name: '', parentId: null })
async function openDuty() {
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
  showDuty.value = true
}
const dutyDateList = computed(() => {
  const { person, mode, start, end } = dutyForm
  if (!person || !start || !end) return []
  const recs = allDuty.value.filter((r) => r.date >= start && r.date <= end)
  const attDays = new Set(recs.map((r) => r.date))
  const personDays = new Set(recs.filter((r) => r.person === person).map((r) => r.date))
  if (mode === 'duty') {
    return [...new Set(recs.filter((r) => r.person === person && shiftKeyOf(r.shift, r.date) !== '休班').map((r) => r.date))].sort()
  }
  const fromBlank = [...attDays].filter((d) => !personDays.has(d))
  const explicit = recs.filter((r) => r.person === person && shiftKeyOf(r.shift, r.date) === '休班').map((r) => r.date)
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
    order: list.value.length,
    archived: 0,
    startAt: startTs,
    endAt: endTs,
    dutyDates: dates,
    createdAt: Date.now()
  })
  showDuty.value = false
  await load()
  emit('changed')
  alert(`已创建项目「${name}」，覆盖 ${dates.length} 个${dutyForm.mode === 'duty' ? '值班' : '休班'}日`)
}
</script>

<template>
  <div class="modal-mask">
    <div class="modal pm">
      <div class="modal-head">
        <strong>{{ showDuty ? '按日程添加项目' : '项目管理' }}</strong>
        <button class="ghost sm" @click="showDuty ? (showDuty = false) : emit('close')">关闭</button>
      </div>

      <!-- 按日程添加 -->
      <div v-if="showDuty" class="pm-body">
        <div class="fld">
          <label>人员</label>
          <select v-model="dutyForm.person" class="duty-sel">
            <option v-for="p in dutyPersons" :key="p" :value="p">{{ p }}</option>
            <option v-if="!dutyPersons.length" value="" disabled>无排班人员</option>
          </select>
        </div>
        <div class="fld">
          <label>类型</label>
          <div class="mode-row">
            <label class="radio"><input type="radio" value="duty" v-model="dutyForm.mode" /> 值班</label>
            <label class="radio"><input type="radio" value="rest" v-model="dutyForm.mode" /> 休班</label>
          </div>
        </div>
        <div class="grid2">
          <div class="fld">
            <label>开始日期</label>
            <input type="date" v-model="dutyForm.start" />
          </div>
          <div class="fld">
            <label>结束日期</label>
            <input type="date" v-model="dutyForm.end" />
          </div>
        </div>
        <div class="fld">
          <label>归属项目（可选父项目）</label>
          <select v-model="dutyForm.parentId" class="duty-sel">
            <option :value="null">（顶层项目）</option>
            <option v-for="p in list" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
        <div class="fld">
          <label>项目名称</label>
          <div class="voice-field">
            <input v-model="dutyForm.name" placeholder="自动生成，可修改" />
            <VoiceInput v-model="dutyForm.name" />
          </div>
        </div>
        <div class="muted duty-preview">将生成 1 个项目，覆盖 {{ dutyDateList.length }} 个{{ dutyForm.mode === 'duty' ? '值班' : '休班' }}日</div>
        <div class="pm-actions">
          <button class="ghost" @click="showDuty = false">取消</button>
          <button class="primary" @click="createProjectFromDuty">创建项目</button>
        </div>
      </div>

      <!-- 列表 / 编辑 -->
      <template v-else>
        <!-- 列表 -->
        <div v-if="!editing" class="pm-body">
          <div class="pm-toolbar">
            <span class="muted">{{ list.length }} 个项目</span>
            <div class="pm-toolbar-right">
              <button class="ghost sm" @click="openDuty">按日程添加</button>
              <button class="primary sm" @click="startNew">+ 新建项目</button>
            </div>
          </div>
          <ul class="pm-list">
            <li v-for="(p, i) in list" :key="p.id" class="pm-item" :class="{ archived: p.archived }">
              <span class="pm-color" :style="{ background: p.color }"></span>
              <div class="pm-main">
                <div class="pm-name">
                  {{ p.name }}
                  <span v-if="p.archived" class="pm-tag">已归档</span>
                </div>
                <div class="muted pm-sub">
                  <!-- ⚠️ 这里的 done/total 是**整棵子树的合计**（子项目里的任务也计入），
                       与总览的项目卡片口径一致；父项目只当文件夹、自己没任务时也能显示真实进度。
                       末尾补「含 N 个子项目」让这个合计数字自解释，不然会以为数错了。 -->
                  {{ p.progressMode === 'manual' ? `手动 ${p.manualProgress}%` : '自动统计' }}
                  · {{ taskCount(p.id).done }}/{{ taskCount(p.id).total }} 任务
                  <template v-if="childCount(p.id)">· 含 {{ childCount(p.id) }} 个子项目（已合计）</template>
                </div>
              </div>
              <div class="pm-ops">
                <button class="ghost sm" :disabled="i === 0" @click="move(p, -1)" title="上移">↑</button>
                <button class="ghost sm" :disabled="i === list.length - 1" @click="move(p, 1)" title="下移">↓</button>
                <button class="ghost sm" @click="startEdit(p)">编辑</button>
                <button class="ghost sm danger" @click="remove(p)">删</button>
              </div>
            </li>
          </ul>
        </div>

        <!-- 编辑表单 -->
        <div v-else class="pm-body">
          <div class="fld">
            <label>项目名称</label>
            <div class="voice-field">
              <input v-model="editing.name" placeholder="如：工作台改版" @keyup.enter="save" />
              <VoiceInput v-model="editing.name" />
            </div>
          </div>
          <div class="fld">
            <label>描述（可选）</label>
            <div class="voice-field">
              <input v-model="editing.desc" placeholder="一句话说明这个项目" />
              <VoiceInput v-model="editing.desc" />
            </div>
          </div>
          <div class="fld">
            <label>颜色</label>
            <div class="swatches">
              <button
                v-for="c in PRESET_COLORS"
                :key="c"
                class="swatch"
                :class="{ on: editing.color === c }"
                :style="{ background: c }"
                @click="editing.color = c"
              />
            </div>
          </div>
          <div class="grid2">
            <div class="fld">
              <label>开始日期</label>
              <input type="date" v-model="editing.startDate" />
            </div>
            <div class="fld">
              <label>结束日期</label>
              <input type="date" v-model="editing.endDate" />
            </div>
          </div>
          <div class="fld">
            <label>完成度</label>
            <div class="mode-row">
              <label class="radio">
                <input type="radio" value="auto" v-model="editing.progressMode" /> 自动（按任务完成比例）
              </label>
              <label class="radio">
                <input type="radio" value="manual" v-model="editing.progressMode" /> 手动
              </label>
            </div>
            <div v-if="editing.progressMode === 'manual'" class="manual-row">
              <input type="range" min="0" max="100" v-model.number="editing.manualProgress" class="rng" />
              <input type="number" min="0" max="100" v-model.number="editing.manualProgress" class="num" />
              <span class="muted">%</span>
            </div>
          </div>
          <label class="radio">
            <input type="checkbox" :checked="!!editing.archived" @change="editing.archived = $event.target.checked ? 1 : 0" />
            归档（不在总览的项目堆叠中显示）
          </label>
          <label class="radio auto-children-toggle">
            <input type="checkbox" :checked="!!editing.autoChildren" @change="editing.autoChildren = $event.target.checked ? 1 : 0" />
            自动生成 年/月/周 子项目（开启后按日期自动派生「YYYY年M月」与「M月D日-M月D日」子项目，承载预设任务）
          </label>

          <div v-if="err" class="err">{{ err }}</div>
          <div class="pm-actions">
            <button class="ghost" @click="editing = null">取消</button>
            <button class="primary" @click="save">保存</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pm {
  width: 100%;
}
.pm-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 62vh;
  overflow-y: auto;
}
.pm-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.pm-toolbar-right {
  display: flex;
  gap: 8px;
}
.duty-sel {
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--panel-solid);
  color: var(--text);
  font-size: 13px;
}
.duty-preview {
  font-size: 12px;
  padding: 8px 10px;
  background: var(--panel-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
.pm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pm-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  border: 1px solid var(--border);
}
.pm-item.archived {
  opacity: 0.55;
}
.pm-color {
  width: 10px;
  height: 34px;
  border-radius: 4px;
  flex: none;
}
.pm-main {
  flex: 1;
  min-width: 0;
}
.pm-name {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pm-tag {
  font-size: 10px;
  background: var(--panel-solid);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 6px;
  color: var(--muted);
  font-weight: 400;
}
.pm-sub {
  font-size: 11px;
  margin-top: 2px;
}
.pm-ops {
  display: flex;
  gap: 3px;
  flex: none;
}
.pm-ops button {
  padding: 3px 7px;
  font-size: 12px;
}
.pm-ops button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.pm-ops .danger {
  color: var(--danger);
}

.fld label {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
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
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.swatches {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}
.swatch {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: 2px solid transparent;
  padding: 0;
}
.swatch.on {
  border-color: var(--text);
  transform: scale(1.12);
}
.mode-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.radio {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  margin: 0;
}
.radio input {
  width: auto;
}
.manual-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.rng {
  flex: 1;
  padding: 0;
}
.num {
  width: 72px;
}
.err {
  color: var(--danger);
  font-size: 12px;
}
.pm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

@media (max-width: 640px) {
  .pm-item {
    flex-wrap: wrap;
  }
  .pm-ops {
    width: 100%;
    justify-content: flex-end;
  }
  .grid2 {
    grid-template-columns: 1fr;
  }
}
</style>
