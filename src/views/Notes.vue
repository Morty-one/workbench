<script setup>
import { ref, computed, provide, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { marked } from 'marked'
import * as XLSX from 'xlsx'
import { embedImages, dataURIToBytes, extractImageDataURIs } from '../utils/xlsxImages'
import { db } from '../db'
import FolderTree from './FolderTree.vue'

const props = defineProps({
  search: { type: String, default: '' },
  openNoteId: { type: [String, Number], default: null }
})

const noteTypes = ref([])
const folderDefaultTypes = ref({}) // 文件夹默认笔记类型 { folderId: typeKey }
function typeLabel(key) {
  return noteTypes.value.find((t) => t.key === key)?.label || key || '未分类'
}
// 默认笔记类型兜底，防止设置未加载前为空
const defaultTypes = [
  { key: 'flash', label: '知识速记' },
  { key: 'note', label: '完整笔记' },
  { key: 'meeting', label: '会议记录' }
]

const foldersFlat = ref([])
const selectedFolder = ref(null)
// 当前选中文件夹的直接子文件夹：父文件夹「无笔记但有子文件夹」时，引导下钻
const currentFolderSubfolders = computed(() =>
  selectedFolder.value != null
    ? foldersFlat.value.filter((f) => f.parentId === selectedFolder.value)
    : []
)
const localSearch = ref('')
const notes = ref([])
/* 知识库列表按标签筛选（"设为任务"按钮旁）：'' = 全部 */
const listTagFilter = ref('')
const noteTagOptions = computed(() => [...new Set(notes.value.flatMap((n) => n.tags || []))].sort())
const displayNotes = computed(() =>
  listTagFilter.value ? notes.value.filter((n) => (n.tags || []).includes(listTagFilter.value)) : notes.value
)
// 分页：默认每页 6 条，可切换 20 / 50 / 100
const pageSize = ref(6)
const currentPage = ref(1)
const pageSizeOpen = ref(false) // 每页条数下拉（向上弹出）
const totalPages = computed(() => Math.max(1, Math.ceil(displayNotes.value.length / pageSize.value)))
const pagedNotes = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return displayNotes.value.slice(start, start + pageSize.value)
})
function setPageSize(s) {
  pageSize.value = s
  currentPage.value = 1
}
watch(listTagFilter, () => { currentPage.value = 1 })
const showEditor = ref(false)
const editingId = ref(null)
const preview = ref(false)
const managing = ref(false)
const expandedMap = ref({})
const creating = ref(false) // 总开关：是否正在新建目录（控制输入行显隐）
const creatingParent = ref(null) // null = 根级；number = 在该 folder.id 下
const newFolderName = ref('')
const batchDeleting = ref(false) // 批量删除模式
const selectedBatchIds = ref([]) // 选中要删除的 folder id 列表
const noteSelecting = ref(false) // 笔记勾选删除模式
const selectedNoteIds = ref([]) // 选中要删除的笔记 id 列表
const taskSelecting = ref(false) // 笔记勾选设为任务模式
const taskSelectedIds = ref([]) // 选中要设为任务的笔记 id 列表

provide('folderExpanded', expandedMap)
async function persistExpand(obj) {
  // 必须转成纯对象再写入：expandedMap.value 是 Vue reactive 代理，
  // 直接交给 IndexedDB 结构化克隆会失败（写入被静默丢弃，导致展开状态无法持久化）。
  const plain = JSON.parse(JSON.stringify(obj || {}))
  await db.settings.put({ key: 'folderExpand', value: plain })
}
provide('persistExpand', persistExpand)

const form = ref({
  title: '',
  type: 'note',
  folderId: null,
  content: '',
  meetingTime: '',
  attendees: ''
})

// 设置中心预设的笔记标签
const noteTagPresets = ref([])
const selectedTags = ref([])
const tagDraft = ref('')
const tagDropdownOpen = ref(false)
const tagComboboxRef = ref(null)
const tagInputRef = ref(null)

const availablePresets = computed(() =>
  noteTagPresets.value.filter((t) => !selectedTags.value.includes(t))
)

function commitDraft() {
  const raw = (tagDraft.value || '').trim()
  if (!raw) return
  const parts = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  if (parts.length) {
    selectedTags.value = [...new Set([...selectedTags.value, ...parts])]
  }
  tagDraft.value = ''
}

function onTagInputKey(e) {
  if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
    e.preventDefault()
    commitDraft()
  } else if (e.key === 'Backspace' && !tagDraft.value && selectedTags.value.length) {
    selectedTags.value = selectedTags.value.slice(0, -1)
  }
}

function addPresetTag(t) {
  if (!selectedTags.value.includes(t)) {
    selectedTags.value = [...selectedTags.value, t]
  }
  tagDraft.value = ''
  tagInputRef.value?.focus()
}

function removeTag(t) {
  selectedTags.value = selectedTags.value.filter((x) => x !== t)
}

function closeTagDropdownOnDocClick(e) {
  if (tagComboboxRef.value && !tagComboboxRef.value.contains(e.target)) {
    tagDropdownOpen.value = false
  }
}

const tree = computed(() => buildTree(foldersFlat.value))
const previewHtml = computed(() => marked.parse(form.value.content || '', { breaks: true }))
const folderName = (id) => foldersFlat.value.find((f) => f.id === id)?.name || '未归档'

const effectiveSearch = computed(() => (localSearch.value || props.search || '').trim())
const effectiveSearchLower = computed(() => effectiveSearch.value.toLowerCase())

// 当前选中文件夹是否有子文件夹（用于提示"浏览只看本层 / 搜索才递归"）
const selectedHasChildren = computed(() => {
  if (selectedFolder.value == null) return false
  return foldersFlat.value.some((f) => f.parentId === selectedFolder.value)
})
const scopeHint = computed(() => {
  if (selectedFolder.value == null) return ''
  const nm = folderName(selectedFolder.value)
  if (effectiveSearch.value) return `搜索范围：「${nm}」及其全部子文件夹`
  if (selectedHasChildren.value) return `仅显示「${nm}」本层笔记 · 输入关键词可搜索子文件夹`
  return ''
})

function buildTree(list) {
  const map = {}
  list.forEach((f) => (map[f.id] = { ...f, children: [] }))
  const roots = []
  list.forEach((f) => {
    if (f.parentId && map[f.parentId]) map[f.parentId].children.push(map[f.id])
    else roots.push(map[f.id])
  })
  // 按 order 排序（缺失时退回 id）；保证 UI 顺序与持久化顺序一致
  const sortFn = (a, b) => (a.order ?? a.id) - (b.order ?? b.id)
  roots.sort(sortFn)
  Object.values(map).forEach((n) => n.children.sort(sortFn))
  return roots
}

async function loadFolders() {
  foldersFlat.value = await db.folders.toArray()
  // 历史数据兜底：缺 order 字段的用 id 占位（不影响显示，重排时才会被改写）
  foldersFlat.value.forEach((f) => {
    if (f.order == null) f.order = f.id
  })
  const saved = await db.settings.get('folderExpand')
  if (saved && saved.value) Object.assign(expandedMap.value, saved.value)
}
async function loadFolderDefaultTypes() {
  // 优先读取新结构 folderConfigs；不存在时兼容旧 folderDefaultTypes
  const map = {}
  const cfg = await db.settings.get('folderConfigs')
  if (cfg && typeof cfg.value === 'object') {
    for (const [id, v] of Object.entries(cfg.value)) {
      if (v && typeof v === 'object') {
        map[id] = { type: v.type || '', tag: v.tag || v.notify || '' }
      } else {
        map[id] = { type: v || '', tag: '' }
      }
    }
  } else {
    const fd = await db.settings.get('folderDefaultTypes')
    const loaded = fd && typeof fd.value === 'object' ? fd.value : {}
    for (const [id, type] of Object.entries(loaded)) {
      map[id] = { type: type || '', tag: '' }
    }
  }
  folderDefaultTypes.value = map
}
function folderDefaultType(folderId) {
  const list = noteTypes.value.length ? noteTypes.value : defaultTypes
  let current = foldersFlat.value.find((f) => f.id === folderId)
  while (current) {
    const key = folderDefaultTypes.value[current.id]?.type
    if (list.some((t) => t.key === key)) return key
    current = foldersFlat.value.find((f) => f.id === current.parentId)
  }
  return null
}
function folderDefaultTag(folderId) {
  let current = foldersFlat.value.find((f) => f.id === folderId)
  while (current) {
    const tag = folderDefaultTypes.value[current.id]?.tag
    if (tag) return tag
    current = foldersFlat.value.find((f) => f.id === current.parentId)
  }
  return null
}
async function loadNotes() {
  let all = await db.notes.toArray()
  const q = effectiveSearchLower.value
  // 两种模式：
  //  · 浏览（无搜索词）→ 只显示该文件夹「自身」的笔记，不含子文件夹
  //  · 搜索（有搜索词）→ 递归该文件夹及其所有子文件夹
  if (selectedFolder.value != null) {
    const scopeIds = q
      ? new Set([selectedFolder.value, ...collectDescendantIds(selectedFolder.value)])
      : new Set([selectedFolder.value])
    all = all.filter((n) => scopeIds.has(n.folderId))
  }
  if (q) {
    all = all.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        (n.content || '').toLowerCase().includes(q) ||
        (n.tags || []).some((t) => t.toLowerCase().includes(q))
    )
  }
  notes.value = all.sort((a, b) => b.updatedAt - a.updatedAt)
}

// 当前日期（YYYY-MM-DD），作为新建目录的默认名
function todayStr() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 输入行里展示的"创建目标"文案
const targetLabel = computed(() => {
  if (!creating.value) return ''
  if (creatingParent.value === null) return '根目录'
  return folderName(creatingParent.value)
})

// 侧边栏的 + 按钮：根据当前选中目录决定父级
// "全部笔记"（selectedFolder=null）→ 根级；其他视图 → 当前选中目录
function startAddFolderAtCurrent() {
  const parentId = selectedFolder.value
  creatingParent.value = parentId
  creating.value = true
  newFolderName.value = todayStr()
  if (parentId != null) {
    expandedMap.value[parentId] = true
    persistExpand(expandedMap.value)
  }
}

// 管理模式下的子节点 + 按钮（行为不变：传什么 parentId 就在哪里建）
function startAddFolder(parentId) {
  creatingParent.value = parentId ?? null
  creating.value = true
  newFolderName.value = todayStr()
  if (parentId != null) {
    expandedMap.value[parentId] = true
    persistExpand(expandedMap.value)
  }
}

async function commitCreateFolder(name) {
  // 先快照父级，再清状态（避免清完后再读 creatingParent 拿到 null 的旧 bug）
  const parentId = creatingParent.value
  const trimmed = (name || '').trim()
  creating.value = false
  creatingParent.value = null
  newFolderName.value = ''
  if (!trimmed) return // 空名 = 取消
  const id = await db.folders.add({
    name: trimmed,
    parentId: parentId === null ? null : parentId
  })
  await loadFolders()
  selectedFolder.value = id
  await loadNotes()
}

function cancelCreateFolder() {
  creating.value = false
  creatingParent.value = null
  newFolderName.value = ''
}

// 切换视图时若正在创建，自动取消（避免父级上下文突变）
watch(selectedFolder, () => {
  if (creating.value) cancelCreateFolder()
  syncTreeToSelection()
})

/* 选中子文件夹时，展开其所有祖先目录并滚动目录树跟随显示（#5） */
function collectAncestorIds(id) {
  const out = []
  let cur = foldersFlat.value.find((f) => f.id === id)
  while (cur && cur.parentId != null) {
    out.push(cur.parentId)
    cur = foldersFlat.value.find((f) => f.id === cur.parentId)
  }
  return out
}
function syncTreeToSelection() {
  if (selectedFolder.value == null) return
  const anc = collectAncestorIds(selectedFolder.value)
  let changed = false
  for (const aid of anc) {
    if (expandedMap.value[aid] !== true) {
      expandedMap.value[aid] = true
      changed = true
    }
  }
  if (changed) persistExpand(expandedMap.value)
  nextTick(() => {
    // 祖先目录展开后，嵌套 FolderTree 异步渲染，稍等再滚动到选中节点
    setTimeout(() => {
      const el = document.querySelector('.side .node.active') || document.querySelector('.node.active')
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 80)
  })
}

/* ---------- 目录排序 / 层级调整 / 拖拽 ---------- */
function siblingsOf(folder) {
  const parentKey = folder.parentId ?? null
  return foldersFlat.value
    .filter((f) => (f.parentId ?? null) === parentKey)
    .sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id))
}
function collectDescendantIds(rootId) {
  const out = []
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()
    const kids = foldersFlat.value.filter((f) => f.parentId === id)
    for (const k of kids) {
      out.push(k.id)
      stack.push(k.id)
    }
  }
  return out
}
async function moveUpFolder(id) {
  const folder = foldersFlat.value.find((f) => f.id === id)
  if (!folder) return
  const sibs = siblingsOf(folder)
  const idx = sibs.findIndex((s) => s.id === id)
  if (idx <= 0) return
  const prev = sibs[idx - 1]
  const aOrder = folder.order ?? folder.id
  const bOrder = prev.order ?? prev.id
  await db.folders.update(folder.id, { order: bOrder })
  await db.folders.update(prev.id, { order: aOrder })
  await loadFolders()
}
async function moveDownFolder(id) {
  const folder = foldersFlat.value.find((f) => f.id === id)
  if (!folder) return
  const sibs = siblingsOf(folder)
  const idx = sibs.findIndex((s) => s.id === id)
  if (idx < 0 || idx >= sibs.length - 1) return
  const next = sibs[idx + 1]
  const aOrder = folder.order ?? folder.id
  const bOrder = next.order ?? next.id
  await db.folders.update(folder.id, { order: bOrder })
  await db.folders.update(next.id, { order: aOrder })
  await loadFolders()
}
// 升级：成为父级的同级（即和当前父级同层）
async function promoteFolder(id) {
  const folder = foldersFlat.value.find((f) => f.id === id)
  if (!folder || folder.parentId == null) return // 已在根级
  const parent = foldersFlat.value.find((f) => f.id === folder.parentId)
  if (!parent) return
  await db.folders.update(id, { parentId: parent.parentId ?? null })
  await loadFolders()
}
// 降级：成为同级前一项的子项
async function demoteFolder(id) {
  const folder = foldersFlat.value.find((f) => f.id === id)
  if (!folder) return
  const sibs = siblingsOf(folder)
  const idx = sibs.findIndex((s) => s.id === id)
  if (idx <= 0) return // 没有前一项可作为新父级
  const newParent = sibs[idx - 1]
  await db.folders.update(id, { parentId: newParent.id })
  expandedMap.value[newParent.id] = true
  persistExpand(expandedMap.value)
  await loadFolders()
}
// 拖拽：将 id 放到 newParentId 下（newParentId 为 null 表示根级）
async function moveFolderTo(id, newParentId) {
  if (id === newParentId) return
  const folder = foldersFlat.value.find((f) => f.id === id)
  if (!folder) return
  if (newParentId != null) {
    const descendantIds = collectDescendantIds(id)
    if (descendantIds.includes(newParentId)) return // 禁止拖到自己的后代里
  }
  await db.folders.update(id, { parentId: newParentId ?? null })
  if (newParentId != null) {
    expandedMap.value[newParentId] = true
    persistExpand(expandedMap.value)
  }
  await loadFolders()
}
// 重命名（⋮ 菜单触发）
async function renameFolder(id) {
  const folder = foldersFlat.value.find((f) => f.id === id)
  if (!folder) return
  const next = prompt('重命名文件夹', folder.name)
  if (next == null) return // 取消
  const trimmed = next.trim()
  if (!trimmed || trimmed === folder.name) return
  await db.folders.update(id, { name: trimmed })
  await loadFolders()
}
async function removeFolder(id) {
  const children = foldersFlat.value.filter((f) => f.parentId === id)
  const descendantIds = [id, ...collectIds(children)]
  const total = await db.notes.where('folderId').anyOf(descendantIds).count()
  const msg = total > 0
    ? `该目录含 ${total} 条笔记（含子目录），删除后这些笔记将变为"未归档"，确认删除？`
    : '确认删除该文件夹及其子文件夹？'
  if (!confirm(msg)) return
  await deleteRecursive(id)
  if (selectedFolder.value && descendantIds.includes(selectedFolder.value)) {
    selectedFolder.value = null
  }
  await loadFolders()
  await loadNotes()
}
function collectIds(list) {
  let ids = []
  for (const f of list) {
    ids.push(f.id)
    const kids = foldersFlat.value.filter((c) => c.parentId === f.id)
    ids = ids.concat(collectIds(kids))
  }
  return ids
}
async function deleteRecursive(id) {
  const children = foldersFlat.value.filter((f) => f.parentId === id)
  await db.notes.where('folderId').equals(id).modify({ folderId: null })
  await db.folders.delete(id)
  for (const c of children) await deleteRecursive(c.id)
}

/* ---------- 批量删除 ---------- */
function toggleBatchMode() {
  batchDeleting.value = !batchDeleting.value
  if (!batchDeleting.value) selectedBatchIds.value = []
}
function toggleBatchSelect(id) {
  const arr = selectedBatchIds.value.slice()
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
  selectedBatchIds.value = arr
}
function selectAllBatch() {
  selectedBatchIds.value = foldersFlat.value.map((f) => f.id)
}
function clearBatch() {
  selectedBatchIds.value = []
}
async function removeFoldersBatch() {
  if (!selectedBatchIds.value.length) return
  // 收集所有选中及其后代 id（删除父级会连带其子目录，但显式收集更稳妥）
  const allIds = new Set()
  for (const id of selectedBatchIds.value) {
    const children = foldersFlat.value.filter((f) => f.parentId === id)
    const descendantIds = [id, ...collectIds(children)]
    descendantIds.forEach((d) => allIds.add(d))
  }
  const totalNotes = await db.notes.where('folderId').anyOf([...allIds]).count()
  const msg = totalNotes > 0
    ? `将删除 ${allIds.size} 个文件夹（含子目录），其中 ${totalNotes} 条笔记将变为"未归档"，确认？`
    : `确认删除 ${allIds.size} 个文件夹（含子目录）？`
  if (!confirm(msg)) return
  for (const id of allIds) {
    await deleteRecursive(id)
  }
  // 若当前选中的目录被删，回退到"全部笔记"
  if (selectedFolder.value && allIds.has(selectedFolder.value)) {
    selectedFolder.value = null
  }
  selectedBatchIds.value = []
  batchDeleting.value = false
  await loadFolders()
  await loadNotes()
}

function newNote() {
  editingId.value = null
  form.value = {
    title: '',
    type: folderDefaultType(selectedFolder.value) || 'note',
    folderId: selectedFolder.value,
    content: '',
    meetingTime: '',
    attendees: ''
  }
  const defaultTag = folderDefaultTag(selectedFolder.value)
  selectedTags.value = defaultTag ? [defaultTag] : []
  tagDraft.value = ''
  showEditor.value = true
  preview.value = false
  nextTick(() => renderEditorFromForm())
}
function editNote(n) {
  editingId.value = n.id
  const defaultTag = folderDefaultTag(n.folderId)
  const existingTags = n.tags && n.tags.length ? n.tags : (defaultTag ? [defaultTag] : [])
  selectedTags.value = [...existingTags]
  tagDraft.value = ''
  form.value = {
    title: n.title,
    type: n.type || folderDefaultType(n.folderId) || 'note',
    folderId: n.folderId,
    content: n.content,
    meetingTime: n.meetingTime || '',
    attendees: n.attendees || ''
  }
  showEditor.value = true
  preview.value = false
  nextTick(() => renderEditorFromForm())
}
function togglePreview() {
  if (preview.value) {
    preview.value = false
    nextTick(() => renderEditorFromForm())
  } else {
    syncEditorToForm()
    preview.value = true
  }
}
async function saveNote() {
  if (!form.value.title.trim()) return
  syncEditorToForm()
  commitDraft()
  const tags = [...new Set(selectedTags.value.map((s) => s.trim()).filter(Boolean))]
  const now = Date.now()
  const payload = {
    title: form.value.title.trim(),
    type: form.value.type,
    folderId: form.value.folderId,
    tags,
    content: form.value.content,
    meetingTime: form.value.type === 'meeting' ? form.value.meetingTime : null,
    attendees: form.value.type === 'meeting' ? form.value.attendees : '',
    updatedAt: now
  }
  if (editingId.value) await db.notes.update(editingId.value, payload)
  else await db.notes.add({ ...payload, createdAt: now })
  showEditor.value = false
  await loadNotes()
}
async function removeNote(id) {
  if (!confirm('确认删除该笔记？')) return
  await db.notes.delete(id)
  await loadNotes()
}

/* ---------- 轻量提示 ---------- */
const toastMsg = ref('')
let toastTimer = null
function showToast(msg) {
  toastMsg.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, 2600)
}

/* ---------- 插入图片（base64 内嵌 Markdown，离线可用） ---------- */
const imgInput = ref(null)

// 富文本编辑器：contenteditable div，文本保留 Markdown 语法，图片以内联小图显示
const editorRef = ref(null)
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
const IMG_TOKEN_RE = /!\[([^\]]*)\]\((data:image\/[^)\s]+)\)/g
function makeImgChipHtml(alt, src) {
  return `<span class="img-chip" contenteditable="false" data-alt="${escapeHtml(alt)}" data-src="${escapeHtml(src)}"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" title="点击查看大图"><button class="img-chip-del" title="删除图片">×</button></span>`
}
function markdownToEditorHtml(md) {
  const parts = []
  let last = 0
  let m
  while ((m = IMG_TOKEN_RE.exec(md)) !== null) {
    parts.push(escapeHtml(md.slice(last, m.index)))
    parts.push(makeImgChipHtml(m[1], m[2]))
    last = m.index + m[0].length
  }
  parts.push(escapeHtml(md.slice(last)))
  return parts.join('').replace(/\n/g, '<br>')
}
function domToMarkdown(root) {
  let md = ''
  const children = root.childNodes
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (node.nodeType === Node.TEXT_NODE) {
      md += node.textContent
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node
      if (el.classList.contains('img-chip')) {
        const alt = el.getAttribute('data-alt') || ''
        const src = el.getAttribute('data-src') || ''
        md += `![${alt}](${src})`
      } else if (el.tagName === 'BR') {
        md += '\n'
      } else if (el.tagName === 'IMG') {
        md += `![${el.alt || ''}](${el.src || ''})`
      } else if (el.tagName === 'DIV' || el.tagName === 'P') {
        if (i > 0 && !md.endsWith('\n')) md += '\n'
        md += domToMarkdown(el)
        if (!md.endsWith('\n')) md += '\n'
      } else {
        md += domToMarkdown(el)
      }
    }
  }
  return md
}
function syncEditorToForm() {
  const el = editorRef.value
  if (!el) return
  form.value.content = domToMarkdown(el)
}
function renderEditorFromForm() {
  const el = editorRef.value
  if (!el) return
  el.innerHTML = markdownToEditorHtml(form.value.content || '')
  // 光标放到末尾
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}
function insertImageChip(alt, src) {
  const editor = editorRef.value
  if (!editor) return
  editor.focus()
  const wrapper = document.createElement('span')
  wrapper.innerHTML = makeImgChipHtml(alt, src)
  const chip = wrapper.firstChild
  // 绑定 chip 内事件
  const img = chip.querySelector('img')
  const delBtn = chip.querySelector('.img-chip-del')
  img.addEventListener('click', (e) => {
    e.stopPropagation()
    openLightbox(src, alt)
  })
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    chip.remove()
    syncEditorToForm()
  })
  const sel = window.getSelection()
  if (!sel.rangeCount || !editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    editor.appendChild(chip)
  } else {
    const range = sel.getRangeAt(0)
    range.deleteContents()
    range.insertNode(chip)
    range.setStartAfter(chip)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  syncEditorToForm()
}
function onEditorInput() {
  syncEditorToForm()
}
// 语音识别结果插入富文本编辑器（contenteditable 不支持 v-model）
function insertVoiceText(text) {
  const el = editorRef.value
  if (!el || !text) return
  el.focus()
  const sel = window.getSelection()
  if (!sel) return
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  document.execCommand('insertText', false, text)
  syncEditorToForm()
}
function onEditorKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault()
    const editor = editorRef.value
    const sel = window.getSelection()
    if (!sel.rangeCount) return
    const range = sel.getRangeAt(0)
    const text = document.createTextNode('\n')
    range.deleteContents()
    range.insertNode(text)
    range.setStartAfter(text)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
    syncEditorToForm()
  }
}
async function onEditorPaste(e) {
  const dt = e.clipboardData
  if (!dt) return
  const imgFiles = []
  for (const it of dt.items || []) {
    if (it && it.kind === 'file' && /^image\//.test(it.type || '')) {
      const f = it.getAsFile()
      if (f) imgFiles.push(f)
    }
  }
  if (!imgFiles.length) {
    // 非图片粘贴让浏览器处理，之后同步一次
    setTimeout(() => syncEditorToForm(), 0)
    return
  }
  e.preventDefault()
  let inserted = 0
  for (const f of imgFiles) {
    try {
      const dataUrl = await fileToCompressedDataURL(f)
      const name = (f.name || 'pasted').replace(/\.[^.]+$/, '') || 'pasted'
      insertImageChip(name, dataUrl)
      inserted++
    } catch (err) {
      /* 单张失败不影响其余 */
    }
  }
  if (inserted) showToast(`已粘贴 ${inserted} 张图片`)
}

// 图片 Lightbox
const lightboxOpen = ref(false)
const lightboxSrc = ref('')
const lightboxAlt = ref('')
const lightboxRef = ref(null)
function openLightbox(src, alt = '') {
  lightboxSrc.value = src
  lightboxAlt.value = alt
  lightboxOpen.value = true
  nextTick(() => lightboxRef.value?.focus())
}
function closeLightbox() {
  lightboxOpen.value = false
}
function onPreviewClick(e) {
  const img = e.target.closest('img')
  if (!img) return
  openLightbox(img.src, img.alt)
}

function pickImages() {
  if (imgInput.value) imgInput.value.click()
}
// 超过阈值才走 canvas 压缩，小图保留透明通道与原始清晰度直接用原图。
// 甜品区：最大边 1600px、质量 0.92 —— 大图放大查看基本不糊，单张体积通常 < 500KB；
// 原本就不大（≤1600px 且 ≤500KB）的图直接保留原图，零二次压缩、最清晰。
function fileToCompressedDataURL(file, maxDim = 1600, quality = 0.92) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取失败'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('图片解析失败'))
      img.onload = () => {
        const w0 = img.naturalWidth
        const h0 = img.naturalHeight
        if (w0 <= maxDim && h0 <= maxDim && file.size <= 500 * 1024) {
          resolve(reader.result)
          return
        }
        const scale = Math.min(1, maxDim / Math.max(w0, h0))
        const w = Math.max(1, Math.round(w0 * scale))
        const h = Math.max(1, Math.round(h0 * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}
function insertImageToken(token) {
  const m = token.match(/^!\[([^\]]*)\]\((data:image\/[^)\s]+)\)$/)
  if (m) {
    insertImageChip(m[1], m[2])
  } else {
    // 兜底：按纯文本追加（理论上不会走到这里）
    form.value.content += token
    renderEditorFromForm()
  }
}
async function onImagesPicked(e) {
  const files = Array.from(e.target.files || [])
  if (e.target) e.target.value = '' // 复位，允许重复选同一文件
  if (!files.length) return
  // 打开编辑器并切到编辑模式，确保 contenteditable 已渲染
  if (!showEditor.value) {
    showEditor.value = true
    preview.value = false
    await nextTick()
    renderEditorFromForm()
  } else if (preview.value) {
    preview.value = false
    await nextTick()
    renderEditorFromForm()
  }
  let inserted = 0
  for (const f of files) {
    if (!/^image\//.test(f.type || '')) continue
    try {
      const dataUrl = await fileToCompressedDataURL(f)
      const name = (f.name || 'image').replace(/\.[^.]+$/, '')
      insertImageChip(name, dataUrl)
      inserted++
    } catch (err) {
      /* 单张失败不影响其余 */
    }
  }
  if (inserted) showToast(`已插入 ${inserted} 张图片`)
}

/* ---------- 一键把笔记转为任务 ---------- */
async function addNoteAsTask(n, opts = {}) {
  if (!n) return
  const { silent = false, noJump = false } = opts
  const now = Date.now()
  const d = new Date(now)
  const p = (x) => String(x).padStart(2, '0')
  const dayKey = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  const projs = await db.projects.orderBy('order').toArray()
  let pid = projs.length ? projs[0].id : null
  if (pid == null) {
    // 极端兜底：没有任何项目时建一个默认项目，保证任务有归属
    pid = await db.projects.add({
      name: '默认项目',
      color: '#4f46e5',
      progressMode: 'auto',
      manualProgress: 0,
      order: 0,
      archived: 0,
      startAt: null,
      endAt: null,
      desc: '由笔记转任务时自动创建',
      createdAt: now
    })
  }
  await db.tasks.add({
    title: n.title || '未命名笔记',
    projectId: pid,
    quadrant: 'noturgent-important',
    status: '待办',
    followUpAt: 0,
    nextRemindAt: 0,
    createdAt: now,
    dayKey,
    completedAt: null,
    remark: `来源：知识库笔记《${n.title || '未命名'}》`,
    content: n.content || '',
    links: [],
    subtasks: []
  })
  if (!silent) showToast(`已添加为任务：${n.title || '未命名'}`)
  if (!noJump) {
    // 跳转到任务管理，立即看到新任务
    window.dispatchEvent(new CustomEvent('wb:goto', { detail: { key: 'tasks' } }))
  }
}

/* ---------- 笔记勾选批量设为任务 ---------- */
function toggleTaskSelect() {
  taskSelecting.value = !taskSelecting.value
  if (taskSelecting.value) noteSelecting.value = false
  if (!taskSelecting.value) taskSelectedIds.value = []
}
function toggleTaskSelectOne(id) {
  const arr = taskSelectedIds.value.slice()
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
  taskSelectedIds.value = arr
}
async function submitTaskBatch() {
  if (!taskSelectedIds.value.length) return
  const ids = taskSelectedIds.value.slice()
  const selected = notes.value.filter((n) => ids.includes(n.id))
  if (!selected.length) return
  for (const n of selected) {
    await addNoteAsTask(n, { silent: true, noJump: true })
  }
  showToast(`已将 ${selected.length} 条笔记添加为任务`)
  taskSelectedIds.value = []
  taskSelecting.value = false
  // 跳转到任务管理，立即看到新任务
  window.dispatchEvent(new CustomEvent('wb:goto', { detail: { key: 'tasks' } }))
}

/* ---------- 笔记勾选批量删除 ---------- */
function toggleNoteSelect() {
  noteSelecting.value = !noteSelecting.value
  if (noteSelecting.value) taskSelecting.value = false
  if (!noteSelecting.value) selectedNoteIds.value = []
}
function toggleNoteSelectOne(id) {
  const arr = selectedNoteIds.value.slice()
  const i = arr.indexOf(id)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(id)
  selectedNoteIds.value = arr
}
function onNoteCardCheck(id) {
  if (noteSelecting.value) toggleNoteSelectOne(id)
  else if (taskSelecting.value) toggleTaskSelectOne(id)
}
async function removeNotesBatch() {
  if (!selectedNoteIds.value.length) return
  if (!confirm(`确认删除选中的 ${selectedNoteIds.value.length} 条笔记？此操作不可恢复。`)) return
  for (const id of selectedNoteIds.value) await db.notes.delete(id)
  selectedNoteIds.value = []
  noteSelecting.value = false
  await loadNotes()
}

/* ---------- 导出 ---------- */
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
function noteToText(n, fmt) {
  const head =
    (fmt === 'md' ? `# ${n.title}\n\n` : `【${n.title}】\n`) +
    `类型：${typeLabel(n.type)}\n` +
    `文件夹：${folderName(n.folderId)}\n` +
    `标签：${(n.tags || []).join(', ') || '—'}\n` +
    (n.type === 'meeting'
      ? `会议时间：${n.meetingTime || '—'}\n参与人：${n.attendees || '—'}\n`
      : '') +
    (fmt === 'md' ? `\n---\n\n` : `\n============================\n`)
  return head + (n.content || '')
}
async function copyNoteText(n) {
  const text = n && n.content ? n.content : ''
  if (!text) {
    showToast('该笔记内容为空，无需复制')
    return
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    showToast('已复制完整文本到剪贴板')
  } catch (err) {
    showToast('复制失败，请手动复制')
  }
}
function exportNote(n, fmt) {
  const safe = (n.title || 'note').replace(/[\\/:*?"<>|]/g, '_')
  if (fmt === 'xlsx') {
    exportXlsx([n])
  } else {
    download(`${safe}.${fmt}`, noteToText(n, fmt), fmt === 'md' ? 'text/markdown' : 'text/plain')
  }
}
async function exportXlsx(list) {
  const rows = list.map((n) => ({
    文件夹: folderName(n.folderId),
    类型: typeLabel(n.type),
    标题: n.title,
    标签: (n.tags || []).join(', '),
    会议时间: n.meetingTime || '',
    参与人: n.attendees || '',
    内容: n.content || '',
    创建时间: n.createdAt ? new Date(n.createdAt).toLocaleString() : '',
    更新时间: n.updatedAt ? new Date(n.updatedAt).toLocaleString() : ''
  }))
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '笔记')
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  // 把每条笔记正文里的图片提取出来，按行内嵌进 Excel
  const placements = []
  for (let i = 0; i < list.length; i++) {
    const uris = extractImageDataURIs(list[i].content || '')
    if (!uris.length) continue
    const images = []
    for (const u of uris) {
      const d = dataURIToBytes(u)
      if (!d) continue
      const dim = await imageDims(u)
      images.push({ ...d, w: dim.w, h: dim.h })
    }
    if (images.length) placements.push({ sheetRow: i + 1, images }) // +1 跳过表头行
  }
  const finalBuf = placements.length ? embedImages(buf, placements) : buf
  const name = `notes-${new Date().toISOString().slice(0, 10)}.xlsx`
  const blob = new Blob([finalBuf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
// 解码图片原始宽高（用于按比例摆放 Excel 内嵌图）
function imageDims(dataURI) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth || 300, h: img.naturalHeight || 200 })
    img.onerror = () => resolve({ w: 300, h: 200 })
    img.src = dataURI
  })
}
function exportAll(fmt) {
  if (fmt === 'xlsx') exportXlsx(notes.value)
  else notes.value.forEach((n) => download(`${n.title}.${fmt}`, noteToText(n, fmt), fmt === 'md' ? 'text/markdown' : 'text/plain'))
}

onMounted(async () => {
  await loadFolders()
  await loadFolderDefaultTypes()
  const nt = await db.settings.get('noteTags')
  noteTagPresets.value = nt && Array.isArray(nt.value) ? nt.value : []
  const nts = await db.settings.get('noteTypes')
  noteTypes.value = nts && Array.isArray(nts.value) ? nts.value : defaultTypes
  await loadNotes()
  document.addEventListener('click', closeTagDropdownOnDocClick)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', closeTagDropdownOnDocClick)
})

watch(effectiveSearchLower, () => loadNotes())
// 跨视图跳转：从总览「最近笔记」点标题进入时，自动打开对应笔记的编辑态
watch(
  [() => props.openNoteId, notes],
  () => {
    const id = props.openNoteId
    if (id != null && notes.value.length && id !== editingId.value) {
      const n = notes.value.find((x) => x.id === id)
      if (n) editNote(n)
    }
  },
  { flush: 'post' }
)
</script>

<template>
  <div class="page">
    <div class="notes">
      <aside class="panel-flat side">
        <div class="side-head">
          <strong>笔记库</strong>
          <button class="ghost sm" @click="managing = !managing">{{ managing ? '完成' : '管理' }}</button>
        </div>
        <input v-model="localSearch" placeholder="搜索标题 / 内容 / 标签" class="side-search" />
        <div class="side-actions">
          <button class="chip" :class="{ active: selectedFolder === null }" @click="selectedFolder = null; loadNotes()">
            全部笔记
          </button>
          <button class="ghost sm icon-only" title="新建目录（默认日期，可在确认前修改）" @click="startAddFolderAtCurrent">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
              <path d="M12 10v6M9 13h6"/>
            </svg>
            <span>新建</span>
          </button>
          <button class="ghost sm icon-only danger" :class="{ active: batchDeleting }" :title="batchDeleting ? '退出批量删除' : '批量删除文件夹'" @click="toggleBatchMode">
            <svg v-if="!batchDeleting" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <path d="M6 6l12 12M18 6L6 18"/>
            </svg>
            <span>{{ batchDeleting ? '退出' : '批量' }}</span>
          </button>
        </div>
        <div v-if="creating" class="new-folder-row">
          <div class="target-line" :title="`新建到：${targetLabel}`">
            <svg viewBox="0 0 24 24" width="13" height="13" class="tl-ico"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
            新建到：{{ targetLabel }}
          </div>
          <div class="input-line">
            <input
              class="new-folder-input"
              v-model="newFolderName"
              :placeholder="todayStr()"
              @keyup.enter="commitCreateFolder(newFolderName)"
              @keyup.esc="cancelCreateFolder"
              @blur="commitCreateFolder(newFolderName)"
              autofocus
            />
            <VoiceInput v-model="newFolderName" />
            <button class="ghost sm" @mousedown.prevent="commitCreateFolder(newFolderName)">✓</button>
            <button class="ghost sm danger" @mousedown.prevent="cancelCreateFolder">✕</button>
          </div>
        </div>
        <FolderTree
          :nodes="tree"
          :selected-id="selectedFolder"
          :managing="managing"
          :creating-parent="creatingParent"
          :default-name="todayStr()"
          :batch="batchDeleting"
          :batch-selected="selectedBatchIds"
          @select="(id) => { selectedFolder = id; loadNotes() }"
          @remove="removeFolder"
          @commit-create="commitCreateFolder"
          @cancel-create="cancelCreateFolder"
          @move-up="moveUpFolder"
          @move-down="moveDownFolder"
          @promote="promoteFolder"
          @demote="demoteFolder"
          @rename="renameFolder"
          @batch-toggle="toggleBatchSelect"
          @drop-on="(sourceId, targetId) => moveFolderTo(sourceId, targetId)"
          @drop-root="(sourceId) => moveFolderTo(sourceId, null)"
        />
        <div v-if="batchDeleting" class="batch-bar">
          <div class="batch-info">已选 <strong>{{ selectedBatchIds.length }}</strong> 项</div>
          <div class="batch-actions">
            <button class="ghost sm" @click="selectAllBatch">全选</button>
            <button class="ghost sm" @click="clearBatch">清空</button>
            <button class="primary sm danger" :disabled="!selectedBatchIds.length" @click="removeFoldersBatch">删除选中</button>
          </div>
        </div>
      </aside>

      <section class="notes-main">
        <transition name="fade">
          <div v-if="toastMsg" class="note-toast">{{ toastMsg }}</div>
        </transition>
        <div v-if="!showEditor" class="note-list">
          <div class="export-bar">
            <div class="eb-left">
              <span class="muted">共 {{ displayNotes.length }} 条</span>
              <button class="primary new-note-btn" @click="newNote">
                <svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                <span>新建</span>
              </button>
              <select v-model="listTagFilter" class="tag-filter-select" title="按标签筛选笔记">
                <option value="">全部标签</option>
                <option v-for="t in noteTagOptions" :key="t" :value="t">{{ t }}</option>
              </select>
              <button class="ghost sm" :class="{ active: noteSelecting }" @click="toggleNoteSelect">{{ noteSelecting ? '取消选择' : '批量删除' }}</button>
              <button v-if="noteSelecting" class="primary sm danger" :disabled="!selectedNoteIds.length" @click="removeNotesBatch">删除选中 ({{ selectedNoteIds.length }})</button>
              <button class="ghost sm task-select-btn" :class="{ active: taskSelecting }" @click="toggleTaskSelect">{{ taskSelecting ? '取消选择' : '设为任务' }}</button>
              <button v-if="taskSelecting" class="primary sm" :disabled="!taskSelectedIds.length" @click="submitTaskBatch">提交 ({{ taskSelectedIds.length }})</button>
            </div>
            <div class="eb-right">
              <span class="muted">导出全部</span>
              <div class="exp-actions">
                <button class="icon-btn md-ico" title="导出 Markdown" @click="exportAll('md')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4z"/><path d="M14 2v4a1 1 0 0 0 1 1h4"/><text x="12" y="15" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor" stroke="none">M</text></svg></button>
                <button class="icon-btn txt-ico" title="导出 文本" @click="exportAll('txt')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4z"/><path d="M14 2v4a1 1 0 0 0 1 1h4"/><text x="12" y="15" text-anchor="middle" font-size="6" font-weight="700" fill="currentColor" stroke="none">Txt</text></svg></button>
                <button class="icon-btn xlsx-ico" title="导出 Excel" @click="exportAll('xlsx')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg></button>
              </div>
            </div>
          </div>
          <div v-for="n in pagedNotes" :key="n.id" class="note-card panel-flat" :class="{ selecting: noteSelecting || taskSelecting, selected: noteSelecting ? selectedNoteIds.includes(n.id) : taskSelectedIds.includes(n.id), 'task-selected': taskSelecting && taskSelectedIds.includes(n.id) }" @click="noteSelecting || taskSelecting ? onNoteCardCheck(n.id) : editNote(n)">
          <div class="nc-head">
            <span class="nc-left">
              <label v-if="noteSelecting || taskSelecting" class="nc-check" @click.stop>
                <input type="checkbox" :checked="noteSelecting ? selectedNoteIds.includes(n.id) : taskSelectedIds.includes(n.id)" @change="onNoteCardCheck(n.id)" @click.stop />
              </label>
              <span class="nc-title">
                {{ n.title }}
                <span class="nc-type">{{ typeLabel(n.type) }}</span>
                <button v-if="!noteSelecting && !taskSelecting" class="icon-btn copy-inline" title="复制完整文本" @click.stop="copyNoteText(n)">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                </button>
              </span>
            </span>
            <span v-if="!noteSelecting && !taskSelecting" class="exp-actions" @click.stop>
                <button class="icon-btn md-ico" title="导出 Markdown" @click.stop="exportNote(n, 'md')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4z"/><path d="M14 2v4a1 1 0 0 0 1 1h4"/><text x="12" y="15" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor" stroke="none">M</text></svg></button>
                <button class="icon-btn txt-ico" title="导出 文本" @click.stop="exportNote(n, 'txt')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4z"/><path d="M14 2v4a1 1 0 0 0 1 1h4"/><text x="12" y="15" text-anchor="middle" font-size="6" font-weight="700" fill="currentColor" stroke="none">Txt</text></svg></button>
                <button class="icon-btn xlsx-ico" title="导出 Excel" @click.stop="exportNote(n, 'xlsx')"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg></button>
              </span>
            </div>
            <div class="nc-tags">
              <span v-for="t in n.tags" :key="t" class="tag">{{ t }}</span>
            </div>
            <div class="muted nc-preview">{{ (n.content || '').slice(0, 80) }}</div>
          </div>
          <div v-if="displayNotes.length === 0" class="empty-wrap">
            <template v-if="effectiveSearch">
              <div class="muted empty">未找到包含「{{ effectiveSearch }}」的笔记。</div>
            </template>
            <template v-else-if="listTagFilter">
              <div class="muted empty">没有匹配「{{ listTagFilter }}」标签的笔记。</div>
            </template>
            <template v-else-if="selectedFolder != null && currentFolderSubfolders.length">
              <div class="subfolder-head">
                <span class="scope-hint">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>
                  <span class="sh-text">该文件夹暂无笔记，以下是子文件夹：</span>
                </span>
                <span class="muted sf-count">共 {{ currentFolderSubfolders.length }} 个子文件夹</span>
              </div>
              <div class="subfolder-grid">
                <button v-for="f in currentFolderSubfolders" :key="f.id" class="subfolder-card" @click="selectedFolder = f.id; loadNotes()">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
                  <span class="sf-name">{{ f.name }}</span>
                </button>
              </div>
            </template>
            <div v-else class="muted empty">暂无数据</div>
          </div>
          <div v-if="pageSizeOpen" class="pop-backdrop" @click="pageSizeOpen = false"></div>
        </div>
        <!-- 翻页行：移出可滚动列表，固定钉在笔记区底部，不随内容滚动 -->
        <!-- 仅当：当前未在编辑器模式 + 当前页有笔记时显示翻页行。
             取消原先的 v-if/v-else：避免"无笔记"或"子文件夹"等空态下仍默认拉出"新建笔记"内联编辑器。 -->
        <div v-if="!showEditor && pagedNotes.length > 0" class="note-pager">
          <span class="muted pager-info">第 {{ currentPage }} / {{ totalPages }} 页 · 共 {{ displayNotes.length }} 条</span>
          <div class="pager-controls">
            <button class="ghost sm" :disabled="currentPage <= 1" @click="currentPage--">上一页</button>
            <button class="ghost sm" :disabled="currentPage >= totalPages" @click="currentPage++">下一页</button>
            <span class="pager-sep"></span>
            <span class="muted">每页</span>
            <span class="pageSize-wrap">
              <button class="ghost sm pageSize-trigger" :class="{ active: pageSizeOpen }" @click.stop="pageSizeOpen = !pageSizeOpen">{{ pageSize }} 条 ▴</button>
              <div v-if="pageSizeOpen" class="pageSize-pop">
                <button v-for="s in [6, 20, 50, 100]" :key="s" class="ghost sm" :class="{ active: pageSize === s }" @click.stop="setPageSize(s); pageSizeOpen = false">{{ s }} 条</button>
              </div>
            </span>
          </div>
        </div>

        <!-- 编辑器：仅当显式点"新建/编辑"按钮打开时显示；空态不再默认拉出。 -->
        <div v-if="showEditor" class="panel-flat editor">
          <div class="editor-head">
            <strong>{{ editingId ? '编辑笔记' : '新建笔记' }}</strong>
            <button class="ghost sm" @click="showEditor = false">✕</button>
          </div>
          <div class="grid2">
            <div>
              <label>标题</label>
              <div class="voice-field">
                <input v-model="form.title" placeholder="笔记标题" />
                <VoiceInput v-model="form.title" />
              </div>
            </div>
            <div>
              <label>类型</label>
              <select v-model="form.type" class="type-select">
                <option v-for="t in (noteTypes.length ? noteTypes : defaultTypes)" :key="t.key" :value="t.key">{{ t.label }}</option>
              </select>
            </div>
            <div>
              <label>所属文件夹</label>
              <select v-model.number="form.folderId">
                <option :value="null">未归档</option>
                <option v-for="f in foldersFlat" :key="f.id" :value="f.id">{{ f.name }}</option>
              </select>
            </div>
            <div class="tag-cell">
              <label>标签（可输入自定义，也可从预设选择）</label>
              <div ref="tagComboboxRef" class="tag-combobox" :class="{ open: tagDropdownOpen }">
                <div class="tag-chips-input" @click="tagInputRef?.focus()">
                  <span v-for="t in selectedTags" :key="t" class="tag-chip">
                    {{ t }}
                    <button type="button" class="tag-remove" @click.stop="removeTag(t)">×</button>
                  </span>
                  <input
                    ref="tagInputRef"
                    v-model="tagDraft"
                    type="text"
                    placeholder="输入标签，回车或逗号添加"
                    @keydown="onTagInputKey"
                    @focus="tagDropdownOpen = true"
                  />
                </div>
                <button type="button" class="tag-dropdown-toggle" @click.stop="tagDropdownOpen = !tagDropdownOpen">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M6 9l6 6 6-6"/>
                  </svg>
                </button>
                <div v-if="tagDropdownOpen" class="tag-dropdown">
                  <div v-if="availablePresets.length" class="tag-preset-list">
                    <button
                      v-for="t in availablePresets"
                      :key="t"
                      type="button"
                      class="tag-preset-item"
                      @click.stop="addPresetTag(t)"
                    >{{ t }}</button>
                  </div>
                  <div v-else class="tag-dropdown-empty">暂无可用预设</div>
                </div>
              </div>
            </div>
            <template v-if="form.type === 'meeting'">
              <div>
                <label>会议时间</label>
                <input v-model="form.meetingTime" placeholder="2026-08-03 09:30" />
              </div>
              <div>
                <label>参与人</label>
                <div class="voice-field">
                  <input v-model="form.attendees" placeholder="张三, 李四" />
                  <VoiceInput v-model="form.attendees" />
                </div>
              </div>
            </template>
          </div>
          <div style="margin-top: 10px">
            <div class="row" style="justify-content: space-between">
              <label>内容（Markdown 支持）</label>
              <div class="row" style="gap: 6px">
                <VoiceInput @result="insertVoiceText" />
                <button class="ghost sm" :disabled="preview" title="插入图片（自动压缩后内嵌到正文）" @click="pickImages">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.6"/>
                    <path d="M21 15l-5-5L5 21"/>
                  </svg>
                  <span>插入图片</span>
                </button>
                <button class="ghost sm" @click="togglePreview">{{ preview ? '编辑' : '预览' }}</button>
              </div>
            </div>
            <div
              v-if="!preview"
              ref="editorRef"
              class="rich-editor"
              contenteditable="true"
              style="min-height: 220px"
              @input="onEditorInput"
              @keydown="onEditorKeydown"
              @paste="onEditorPaste"
            ></div>
            <div v-else class="preview" v-html="previewHtml" @click="onPreviewClick"></div>
            <input ref="imgInput" type="file" accept="image/*" multiple style="display:none" @change="onImagesPicked" />
          </div>
          <div class="row" style="justify-content: flex-end; margin-top: 10px">
            <button class="ghost" @click="showEditor = false">取消</button>
            <button class="primary" @click="saveNote">保存笔记</button>
          </div>
        </div>
      </section>
    </div>
  </div>

  <!-- 图片 Lightbox -->
  <div v-if="lightboxOpen" ref="lightboxRef" class="lightbox" tabindex="0" @keydown.esc="closeLightbox">
    <button class="lightbox-close" @click="closeLightbox">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
    <img :src="lightboxSrc" :alt="lightboxAlt" @click.stop />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  min-width: 0;
  flex: 1;
  min-height: 0;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 4px 0;
}
.notes {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  /* 单行 minmax(0,1fr) 撑满视口高度：右侧笔记区/编辑器填充整列并在自身内部滚动，
     内容短时不再在底部（目录右侧）留下整片空块 */
  grid-template-rows: minmax(0, 1fr);
  gap: 14px;
  min-height: 0;
  width: 100%;
  min-width: 0;
  align-items: stretch;
  flex: 1;
  height: 100%;
}
@media (max-width: 720px) {
  .notes {
    grid-template-columns: 1fr !important;
    grid-template-rows: auto !important;
    height: auto !important;
  }
  /* 移动端：目录侧栏改为整宽排在笔记列表上方（不再挤成竖排窄条）；
     限制自身高度并内部滚动，避免吃掉整屏 */
  .side {
    grid-row: auto !important;
    grid-column: 1 !important;
    width: 100% !important;
    align-self: auto !important;
    max-height: 42vh;
    overflow-y: auto !important;
  }
  .notes-main {
    grid-row: auto !important;
    grid-column: 1 !important;
    height: auto !important;
    overflow: visible !important;
  }
}
.side {
  grid-row: 1;
  grid-column: 1;
  align-self: stretch;
  /* 行高固定为视口高度后，长目录树在自身内部滚动，避免被裁剪 */
  overflow-y: auto;
  min-height: 0;
}
.notes-main {
  grid-row: 1;
  grid-column: 2;
  align-self: stretch;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0 12px 6px;
  overflow: hidden;
}
.side-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.side-search {
  margin-bottom: 10px;
}
.side-actions {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
  align-items: center;
  flex-wrap: nowrap; /* 三按钮始终同行 */
}
.side-actions .chip,
.side-actions .ghost.sm {
  flex: 1 1 0;
  min-width: 0;
  padding: 6px 4px;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.side-actions .chip.active {
  flex: 1 1 0;
}
/* 根级/子级新建目录：内联重命名输入行（Windows 风格）
   拆两行：第 1 行 目标位置说明；第 2 行 input + ✓ + ✕
   这样侧边栏无论多窄都不会让按钮溢出到第二/第三行 */
.new-folder-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  margin-bottom: 6px;
  background: var(--panel-2);
  border-radius: 6px;
  outline: 1px dashed var(--primary);
}
.new-folder-row .target-line {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
  display: flex;
  align-items: center;
  gap: 4px;
}
.tl-ico {
  flex: none;
}
.new-folder-row .input-line {
  display: flex;
  align-items: center;
  gap: 4px;
}
.new-folder-row .target-label { /* 兼容旧类名，保留无副作用 */
  display: none;
}
.new-folder-input {
  flex: 1;
  min-width: 0; /* 关键：让 flex 真正能压到 0，否则 input 会按 size 默认宽度撑开 */
  border: 1px solid var(--primary);
  border-radius: 5px;
  padding: 3px 7px;
  font-size: 13px;
  background: var(--panel-solid);
  color: var(--text);
  outline: none;
}
.new-folder-input:focus {
  box-shadow: 0 0 0 2px var(--primary-soft);
}
.danger.ghost {
  color: var(--danger);
}
.ghost.sm.danger.active {
  background: var(--danger);
  color: #fff;
  border-color: var(--danger);
}

/* 批量删除操作条 */
.batch-bar {
  margin-top: 8px;
  padding: 8px 10px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.batch-info {
  font-size: 12px;
  color: var(--text);
  margin-bottom: 6px;
}
.batch-info strong {
  color: var(--danger);
}
.batch-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.note-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
/* 编辑器与列表对称：撑满 notes-main 并在自身内部滚动，避免点击笔记后右侧空白 */
.editor {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  gap: 12px;
}
.export-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 14px 4px;
}
/* 分页栏：默认每页 6 条，可切 20/50/100，固定钉在笔记区底部 */
.note-pager {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 12px 2px;
  margin-top: 2px;
  flex: none;
  border-top: 1px solid var(--border);
}
.pager-info {
  font-size: 12px;
}
.pager-controls {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.pager-sep {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 4px;
}
/* 父文件夹无笔记时，展示子文件夹引导下钻 */
.empty-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.empty-wrap .empty {
  font-size: 13px;
}
/* 父文件夹无笔记：子文件夹引导区头部（说明文字改为悬浮提示，避免右侧空一块） */
.subfolder-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.subfolder-head .sf-count {
  font-size: 11px;
}
.subfolder-grid {
  display: grid;
  /* auto-fit 会折叠空轨道，避免父文件夹子文件夹少时在右侧留下大片空列（"目录右侧空一块"） */
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.subfolder-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  cursor: pointer;
  text-align: left;
  transition: border-color .15s, background .15s, transform .1s;
}
.subfolder-card:hover {
  border-color: var(--primary);
  background: var(--primary-soft);
  transform: translateY(-1px);
}
.subfolder-card .sf-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 每页条数：点击向上弹出拉框，从小到大排序 */
.pageSize-wrap {
  position: relative;
  display: inline-flex;
}
.pageSize-trigger {
  min-width: 66px;
}
.pageSize-pop {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel-solid);
  box-shadow: 0 10px 28px rgba(0, 0, 0, .18);
  z-index: 50;
  min-width: 88px;
}
.pageSize-pop .ghost.sm {
  width: 100%;
  text-align: center;
  justify-content: center;
}
.pop-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.eb-left,
.eb-right {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  white-space: nowrap;
}
/* 工具栏（新建按钮这一行）文字/按钮永不内部折行：长标签如「删除选中 (N)」也保持单行 */
.eb-left > *,
.eb-right > * {
  white-space: nowrap;
  flex-shrink: 0;
}
.eb-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 2px;
}
.scope-hint {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--muted);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 9px;
  cursor: help;
}
.scope-hint .sh-text {
  display: none;
}
.scope-hint:hover .sh-text,
.scope-hint:focus-within .sh-text {
  display: block;
  position: absolute;
  left: 0;
  top: calc(100% + 6px);
  z-index: 30;
  width: max-content;
  min-width: 220px;
  max-width: min(360px, 80vw);
  padding: 7px 11px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text);
  background: var(--panel-solid);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.2);
  white-space: normal;
}
.exp-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.md-ico { color: var(--primary); }
.txt-ico { color: var(--warning); }
.xlsx-ico { color: var(--success); }
.new-note-btn {
  margin-left: 4px;
  padding: 0 8px;
  font-size: 12px;
  height: 28px;
  line-height: 28px;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.new-note-btn svg {
  flex: none;
  display: block;
  width: 14px;
  height: 14px;
}
.new-note-btn span {
  display: block;
  line-height: 1;
}
.note-card {
  cursor: pointer;
  position: relative;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.1s;
  overflow: hidden;
  max-width: 100%;
}
.note-card:hover {
  border-color: var(--primary);
  box-shadow: 0 6px 18px var(--primary-soft-strong);
  transform: translateY(-1px);
}
.note-card.selecting {
  cursor: pointer;
}
.note-card.selected {
  border-color: var(--danger);
  box-shadow: 0 0 0 1px var(--danger) inset;
}
.note-card.task-selected {
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--primary) inset;
}
/* 批量选择时：勾选框与标题左对齐紧挨，避免被 space-between 撑开 */
.note-card.selecting .nc-head {
  justify-content: flex-start;
}
.note-card.selecting .exp-actions {
  display: none;
}
.note-card .nc-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex: none;
  z-index: 4;
}
.note-card .nc-check input {
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  display: block;
}
.note-card.selecting {
  padding-left: 12px;
}
.nc-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  min-height: 18px;
}
.nc-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.nc-title {
  font-weight: 500;
  font-size: 15px;
  line-height: 18px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.nc-title .nc-type {
  display: inline-flex;
  align-items: center;
  line-height: 1;
  flex: none;
}
.nc-type {
  font-size: 12px;
  color: var(--muted);
  margin-right: 4px;
}
.nc-title .copy-inline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  margin-left: 2px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  flex: none;
  opacity: 0.7;
  transition: opacity 0.15s, color 0.15s;
}
.nc-title .copy-inline:hover {
  opacity: 1;
  color: var(--primary);
}
.nc-tags {
  margin: 6px 0;
}
.nc-preview {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  display: block;
  word-break: break-all;
}
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
.tag-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.preset-select {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  background: var(--panel-solid);
  color: var(--text);
  cursor: pointer;
}
.preset-select:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}

/* 标签组合框：芯片 + 自定义输入 + 预设下拉 */
.tag-cell {
  position: relative;
}
.tag-combobox {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 6px 8px;
  background: var(--panel-solid);
}
.tag-combobox.open {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.tag-chips-input {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  cursor: text;
}
.tag-chips-input input {
  flex: 1;
  min-width: 120px;
  border: none;
  background: transparent;
  padding: 3px 2px;
  font-size: 13px;
  color: var(--text);
  outline: none;
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--primary-soft);
  color: var(--primary);
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.4;
}
.tag-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--primary);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.tag-remove:hover {
  background: var(--primary);
  color: #fff;
}
.tag-dropdown-toggle {
  flex: none;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.tag-dropdown-toggle:hover {
  background: var(--panel-2);
  color: var(--text);
}
.tag-combobox.open .tag-dropdown-toggle {
  color: var(--primary);
}
.tag-dropdown {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  z-index: 20;
  background: var(--panel-solid);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  max-height: 200px;
  overflow-y: auto;
  padding: 4px;
}
.tag-preset-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tag-preset-item {
  text-align: left;
  padding: 7px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}
.tag-preset-item:hover {
  background: var(--primary-soft);
  color: var(--primary);
}
.tag-dropdown-empty {
  padding: 10px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
}
@media (max-width: 640px) {
  .grid2 {
    grid-template-columns: 1fr;
  }
}
.editor-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.preview {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  min-height: 220px;
  line-height: 1.7;
  background: var(--panel-2);
}
.preview :deep(h1),
.preview :deep(h2),
.preview :deep(h3) {
  margin: 8px 0;
}
.preview :deep(code) {
  background: var(--panel-2);
  padding: 1px 5px;
  border-radius: 4px;
}
.preview :deep(ul),
.preview :deep(ol) {
  padding-left: 20px;
}
.preview :deep(img) {
  width: 72px;
  height: 42px;
  object-fit: cover;
  border-radius: 6px;
  cursor: zoom-in;
  border: 1px solid var(--border);
  background: var(--panel-2);
  display: block;
}

/* 富文本编辑器：保留 Markdown 文本，图片以内联 chip 显示 */
.rich-editor {
  font-family: inherit;
  font-size: 14px;
  line-height: 1.6;
  min-height: 220px;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--panel-solid);
  color: var(--text);
  width: 100%;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.rich-editor:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.rich-editor:empty::before {
  content: '在此输入 Markdown 内容…';
  color: var(--muted);
  pointer-events: none;
}
.img-chip {
  display: inline-block;
  vertical-align: middle;
  position: relative;
  margin: 2px 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel-2);
  line-height: 0;
}
.img-chip img {
  display: block;
  /* 编辑模式：中等缩略图，明显大于预览模式的 72x42，但远小于大图 */
  width: 200px;
  height: 130px;
  object-fit: cover;
  cursor: zoom-in;
}
.img-chip-del {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.img-chip:hover .img-chip-del {
  opacity: 1;
}
.img-chip-del:hover {
  background: rgba(220, 38, 38, 0.85);
}
@media (hover: none) {
  .img-chip-del {
    opacity: 1;
  }
}

/* 图片 Lightbox */
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.82);
  padding: 24px;
}
.lightbox img {
  max-width: 92vw;
  max-height: 88vh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}
.lightbox-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  cursor: pointer;
}
.lightbox-close:hover {
  background: rgba(255, 255, 255, 0.25);
}

.empty {
  text-align: center;
  padding: 16px 0;
}
/* 一键添加为任务按钮（区别于 导出 系列） */
.task-ico {
  color: #6d5ae6;
}
.task-ico:hover {
  color: #4b3ec4;
  background: rgba(109, 90, 230, 0.12);
}
/* 批量设为任务按钮激活态 */
.task-select-btn.active {
  color: var(--primary);
  background: var(--primary-soft);
  border-color: var(--primary);
}
/* 知识库列表按标签筛选下拉（"设为任务"按钮旁） */
.tag-filter-select {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 12px;
  background: var(--panel-solid);
  color: var(--text);
  max-width: 140px;
}
.tag-filter-select:focus {
  outline: none;
  border-color: var(--primary);
}
/* 轻量提示 toast（浮层，不占文档流，不影响下方布局） */
.note-toast {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  background: var(--primary);
  color: #fff;
  font-size: 13px;
  padding: 8px 14px;
  border-radius: 999px;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.25);
  pointer-events: none;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
