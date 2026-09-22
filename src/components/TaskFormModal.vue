<!--
  任务表单弹窗（公共组件）
  供 Tasks.vue（新建/编辑待办）和 Overview.vue（页内快捷新增）使用，保持两处字段一致。

  Props:
    show         - 是否显示
    projects     - 项目列表（用于 projectTree）
    editingId    - 编辑模式下的任务 id（null = 新建）
    initialData  - 初始表单数据（父组件在打开时设置；编辑模式下传入待编辑任务，新建模式下传空对象）

  Emits:
    update:show  - 关闭时通知父组件
    submit       - 提交时携带完整表单数据（深拷贝）
-->
<script setup>
import { reactive, computed, watch, ref } from 'vue'
import VoiceInput from './VoiceInput.vue'
// 第 42 轮：保存前剥壳，防止本地路径被存成 `https://"C:\…"`
import { localPathOf } from '../utils/localOpen.js'
// 第 43 轮：链接级「用哪个浏览器打开」（存浏览器 id，不存 exe 路径）
import { loadBrowserPrefs, getBrowserList } from '../utils/browserPref.js'

const props = defineProps({
  show: { type: Boolean, default: false },
  projects: { type: Array, default: () => [] },
  editingId: { type: Number, default: null },
  initialData: { type: Object, default: () => ({}) }
})
const emit = defineEmits(['update:show', 'submit'])

// 四象限选项（与 Tasks.vue 保持一致）
const QUAD = {
  'urgent-important': '重要紧急',
  'noturgent-important': '重要不紧急',
  'urgent-notimportant': '不重要紧急',
  'noturgent-notimportant': '不重要不紧急'
}
const QUAD_LAYOUT = ['urgent-important', 'noturgent-important', 'urgent-notimportant', 'noturgent-notimportant']

// 表单本地状态
const form = reactive({
  title: '',
  projectId: null,
  quadrant: 'noturgent-important',
  dueTime: '',
  remark: '',
  links: [],
  subtasks: []
})

// 项目树（带 depth，用于下拉缩进展示）
const projectTree = computed(() => {
  const list = props.projects || []
  const childrenOf = (pid) => list.filter((p) => (p.parentId || null) === pid)
  const out = []
  const walk = (pid, depth) => {
    for (const p of childrenOf(pid)) {
      out.push({ ...p, depth })
      walk(p.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
})

// 弹窗打开 / 初始数据变化时同步到表单
watch(
  () => [props.show, props.initialData],
  ([show, data]) => {
    if (!show) return
    const d = data || {}
    form.title = d.title || ''
    form.projectId = d.projectId ?? null
    form.quadrant = d.quadrant || 'noturgent-important'
    form.dueTime = d.dueTime || ''
    form.remark = d.remark || ''
    form.links = JSON.parse(JSON.stringify(Array.isArray(d.links) ? d.links : []))
    form.subtasks = JSON.parse(
      JSON.stringify(
        Array.isArray(d.subtasks)
          ? d.subtasks.map((s) => ({
              id: s.id || 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
              text: s.text || '',
              done: !!s.done,
              dueTime: s.dueTime || '',
              remindTime: s.remindTime || '',
              links: Array.isArray(s.links) ? s.links : []
            }))
          : []
      )
    )
  },
  { immediate: true, deep: true }
)

// 子任务 / 链接 辅助
// 「用哪个浏览器打开」下拉的可选项：空 id = 跟随全局默认（在设置中心配）
const browserOptions = ref([])
async function refreshBrowserOptions() {
  try {
    await loadBrowserPrefs()
    browserOptions.value = getBrowserList()
  } catch (e) {
    browserOptions.value = []
  }
}
watch(
  () => props.show,
  (v) => { if (v) refreshBrowserOptions() },
  { immediate: true }
)

function addFormSubtask() {
  form.subtasks.push({
    id: 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    text: '',
    done: false,
    dueTime: '',
    remindTime: '',
    links: []
  })
}
function removeFormSubtask(i) {
  form.subtasks.splice(i, 1)
}
function addFormSubLink(s) {
  if (!s.links) s.links = []
  s.links.push({ url: '', label: '打开', browser: '' })
}
function removeFormSubLink(s, i) {
  s.links.splice(i, 1)
}

// 保存前把「被误加协议的本地路径」剥回干净路径（幂等：正常网址原样返回）
function normalizeLinks(list) {
  if (!Array.isArray(list)) return list
  for (const l of list) {
    if (!l || typeof l !== 'object') continue
    const p = localPathOf(l.url)
    if (p) l.url = p
    // 第 43 轮：browser 统一成字符串 id；空值删掉，避免库里堆一堆 browser:'' 的脏字段
    l.browser = (l.browser == null ? '' : String(l.browser)).trim()
    if (!l.browser) delete l.browser
  }
  return list
}

function localSubmit() {
  if (!form.title.trim()) return
  normalizeLinks(form.links)
  for (const s of form.subtasks || []) normalizeLinks(s.links)
  // 深拷贝后抛给父组件，避免后续修改影响父组件已收到的数据
  emit('submit', JSON.parse(JSON.stringify(form)))
}
function close() {
  emit('update:show', false)
}
</script>

<template>
  <div v-if="show" class="modal-mask" @click.self="close">
    <div class="modal">
      <div class="modal-head">
        <strong>{{ editingId ? '编辑待办' : '新建待办' }}</strong>
        <button class="ghost sm" @click="close" aria-label="关闭">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="grid2">
        <div>
          <label>标题</label>
          <div class="voice-field">
            <input v-model="form.title" placeholder="要做的事…" @keyup.enter="localSubmit" />
            <VoiceInput v-model="form.title" />
          </div>
        </div>
        <div>
          <label>所属项目</label>
          <select v-model="form.projectId">
            <option v-for="p in projectTree" :key="p.id" :value="p.id">{{ '··'.repeat(p.depth) }}{{ p.name }}</option>
          </select>
        </div>
        <div>
          <label>四象限分级</label>
          <select v-model="form.quadrant">
            <option v-for="k in QUAD_LAYOUT" :key="k" :value="k">{{ QUAD[k] }}</option>
          </select>
        </div>
        <div v-if="!form.subtasks.length">
          <label>完成时间</label>
          <input type="time" v-model="form.dueTime" />
        </div>
        <div style="grid-column: 1 / -1">
          <label>备注</label>
          <div class="voice-field voice-field-multiline">
            <textarea v-model="form.remark" placeholder="补充说明（可选，Enter 换行）" rows="3" class="remark-input"></textarea>
            <VoiceInput v-model="form.remark" />
          </div>
        </div>
        <div style="grid-column: 1 / -1">
          <label>跳转链接（可多个，支持本地程序/文件路径）</label>
          <div class="link-edit">
            <div v-for="(lnk, li) in form.links" :key="li" class="link-row">
              <input v-model="form.links[li].url" placeholder="https://… 或本地路径 D:\xxx\a.exe（可留空）" />
              <input v-model="form.links[li].label" placeholder="名称（默认：打开）" class="link-label" />
              <select v-model="form.links[li].browser" class="link-browser" title="这条链接用哪个浏览器打开（默认 = 跟随设置中心「浏览器与打开方式」里的全局默认）">
                <option value="">默认浏览器</option>
                <option v-for="b in browserOptions" :key="b.id" :value="b.id">{{ b.name || b.exe }}</option>
              </select>
              <button class="ghost sm danger" type="button" @click="form.links.splice(li, 1)">删除</button>
            </div>
            <button class="ghost sm" type="button" @click="form.links.push({ url: '', label: '打开', browser: '' })">+ 添加链接</button>
          </div>
        </div>
        <div style="grid-column: 1 / -1">
          <label>子任务（可选）</label>
          <div class="form-subs">
            <div v-for="(s, si) in form.subtasks" :key="s.id" class="form-sub-card">
              <div class="form-sub-head">
                <span class="form-sub-idx">{{ si + 1 }}</span>
                <input v-model="s.text" class="form-sub-name" placeholder="子任务内容" />
                <VoiceInput v-model="s.text" />
                <label class="form-sub-f inline">
                  <span>完成时间</span>
                  <input type="time" v-model="s.dueTime" />
                </label>
                <button class="ghost sm danger" type="button" @click="removeFormSubtask(si)">删除</button>
              </div>
              <div class="form-sub-links">
                <span class="form-sub-links-label">跳转链接</span>
                <div class="form-sub-link-rows">
                  <div v-for="(u, ui) in s.links" :key="ui" class="form-sub-link-row">
                    <input v-model="s.links[ui].url" placeholder="https://… 或 D:\xxx\a.exe" />
                    <input v-model="s.links[ui].label" placeholder="名称" class="link-label" />
                    <select v-model="s.links[ui].browser" class="link-browser" title="这条链接用哪个浏览器打开（默认 = 跟随设置中心里的全局默认）">
                      <option value="">默认浏览器</option>
                      <option v-for="b in browserOptions" :key="b.id" :value="b.id">{{ b.name || b.exe }}</option>
                    </select>
                    <button class="ghost sm danger" type="button" @click="removeFormSubLink(s, ui)">删除</button>
                  </div>
                  <button class="ghost sm" type="button" @click="addFormSubLink(s)">+ 添加链接</button>
                </div>
              </div>
            </div>
            <button class="ghost sm" type="button" @click="addFormSubtask">+ 添加子任务</button>
          </div>
        </div>
      </div>
      <div class="row" style="justify-content: flex-end; margin-top: 14px">
        <button class="ghost" @click="close">取消</button>
        <button class="primary" @click="localSubmit">{{ editingId ? '保存' : '添加待办' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
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
.voice-field-multiline {
  align-items: flex-start;
}
.voice-field-multiline .remark-input {
  flex: 1;
  min-width: 0;
  min-height: 60px;
  max-height: 220px;
  resize: vertical;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.voice-field-multiline .remark-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
@media (max-width: 640px) {
  .grid2 {
    grid-template-columns: 1fr;
  }
}
/* 新建/编辑表单：多个链接输入行 */
.link-edit {
  display: grid;
  gap: 6px;
}
.link-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.link-row input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-solid);
  color: var(--text);
}
.link-row input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.link-row .link-label {
  flex: none;
  width: 130px;
}
/* 新建/编辑任务：子任务编辑器 */
.form-subs {
  display: grid;
  gap: 8px;
}
.form-sub-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  padding: 9px 11px;
  display: grid;
  gap: 8px;
}
.form-sub-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.form-sub-idx {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.form-sub-head input {
  flex: 1;
  min-width: 0;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 13px;
}
.form-sub-body {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.form-sub-f {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--muted);
}
.form-sub-f input,
.form-sub-f select {
  padding: 5px 7px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  width: 100%;
}
/* 子任务名称与完成时间同处一行：名称栏收窄，完成时间固定宽度 */
.form-sub-name {
  max-width: 220px;
}
.form-sub-f.inline {
  flex: 0 0 auto;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.form-sub-f.inline input {
  flex: 0 0 auto;
  width: 115px;
}
.form-sub-links {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 7px;
  border-top: 1px dashed var(--border);
}
.form-sub-links-label {
  font-size: 11px;
  color: var(--muted);
}
.form-sub-link-rows {
  display: grid;
  gap: 5px;
}
.form-sub-link-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.form-sub-link-row input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 12px;
}
.form-sub-link-row .link-label {
  flex: 0 0 96px;
}
/* 第 43 轮：「用哪个浏览器打开」下拉（任务链接行 / 子任务链接行共用 .link-browser） */
.link-row .link-browser,
.form-sub-link-row .link-browser {
  flex: none;
  width: 104px;
  padding: 5px 6px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel-solid);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.link-row .link-browser:focus,
.form-sub-link-row .link-browser:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
@media (max-width: 520px) {
  .form-sub-body {
    grid-template-columns: 1fr;
  }
}
</style>
