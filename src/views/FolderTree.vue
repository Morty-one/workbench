<script setup>
import { inject, ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  selectedId: { type: [Number, null], default: null },
  managing: { type: Boolean, default: false },
  creatingParent: { type: [Number, null], default: null },
  defaultName: { type: String, default: '新建文件夹' },
  __selfId: { type: [Number, null], default: null },
  batch: { type: Boolean, default: false },
  batchSelected: { type: Array, default: () => [] }
})
const emit = defineEmits([
  'select',
  'remove',
  'commit-create',
  'cancel-create',
  'move-up',
  'move-down',
  'promote',
  'demote',
  'rename',
  'batch-toggle',
  'drop-on',
  'drop-root'
])

const expandedMap = inject('folderExpanded', { value: {} })
const persist = inject('persistExpand', async () => {})

// 默认折叠：普通浏览只显示顶层，需手动展开；展开状态持久化到 settings.folderExpand
function isOpen(id) {
  return expandedMap.value[id] === true
}
function toggle(id) {
  expandedMap.value[id] = !isOpen(id)
  persist(expandedMap.value)
}
function hasKids(n) {
  return !!(n.children && n.children.length)
}

/* ---------- ⋮ 菜单 ---------- */
const openMenuId = ref(null)
function toggleMenu(id) {
  openMenuId.value = openMenuId.value === id ? null : id
}
function closeMenu() {
  openMenuId.value = null
}
function selectAction(action, id) {
  openMenuId.value = null
  emit(action, id)
}
function onDocClick(e) {
  // 点击菜单外区域（不在 .ops 内）就关闭
  if (openMenuId.value != null && !e.target.closest('.ops')) {
    openMenuId.value = null
  }
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

/* ---------- 拖拽 ---------- */
const dragOverId = ref(null)
const rootDragOver = ref(false)

function onDragStart(e, id) {
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/folder-id', String(id))
  openMenuId.value = null // 开始拖拽时关闭菜单
  setTimeout(() => {
    dragOverId.value = null
  }, 0)
}
function onDragOver(e, id) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  if (dragOverId.value !== id) dragOverId.value = id
}
function onDragLeave(e, id) {
  if (dragOverId.value === id) dragOverId.value = null
}
function onDrop(e, targetId) {
  e.preventDefault()
  const sourceId = Number(e.dataTransfer.getData('text/folder-id'))
  dragOverId.value = null
  if (!sourceId || sourceId === targetId) return
  emit('drop-on', sourceId, targetId)
}
function onRootDragOver(e) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  rootDragOver.value = true
}
function onRootDragLeave() {
  rootDragOver.value = false
}
function onRootDrop(e) {
  e.preventDefault()
  const sourceId = Number(e.dataTransfer.getData('text/folder-id'))
  rootDragOver.value = false
  if (!sourceId) return
  emit('drop-root', sourceId)
}
</script>

<template>
  <div v-if="managing && __selfId == null" class="root-drop" :class="{ over: rootDragOver }"
       @dragover="onRootDragOver" @dragleave="onRootDragLeave" @drop="onRootDrop">
    <svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-3px;margin-right:4px"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
    拖到这里 = 移到根目录
  </div>
  <ul class="tree">
    <li v-for="n in nodes" :key="n.id">
      <div class="node" :class="{
        active: n.id === selectedId,
        'drop-target': dragOverId === n.id,
        'batch-on': batch
      }" :draggable="managing" @dragstart="onDragStart($event, n.id)"
           @dragover="onDragOver($event, n.id)" @dragleave="onDragLeave($event, n.id)" @drop="onDrop($event, n.id)">
        <input v-if="batch" type="checkbox" class="batch-cb" :checked="batchSelected.includes(n.id)" @click.stop="emit('batch-toggle', n.id)" />
        <span
          v-if="hasKids(n)"
          class="tw"
          :class="{ open: isOpen(n.id) }"
          :title="isOpen(n.id) ? '收起子文件夹' : '展开子文件夹'"
          @click.stop="toggle(n.id)"
        >{{ isOpen(n.id) ? '▾' : '▸' }}</span>
        <span v-else class="tw tw-leaf"></span>
        <span class="name" @click="batch ? toggle(n.id) : emit('select', n.id)">
          {{ n.name }}
          <span v-if="hasKids(n) && !isOpen(n.id)" class="kid-badge" :title="`含 ${n.children.length} 个子文件夹`">{{ n.children.length }}</span>
        </span>
        <span class="ops" v-if="managing">
          <button class="ghost adj" title="上移" @click.stop="emit('move-up', n.id)">↑</button>
          <button class="ghost adj" title="下移" @click.stop="emit('move-down', n.id)">↓</button>
          <button class="ghost adj menu-btn" :class="{ active: openMenuId === n.id }" title="更多操作" @click.stop="toggleMenu(n.id)">⋮</button>
          <div v-if="openMenuId === n.id" class="menu" @click.stop>
            <button @click="selectAction('promote', n.id)">↰ 升级（和父级同层）</button>
            <button @click="selectAction('demote', n.id)">↳ 降级（成为上一同级的子）</button>
            <button @click="selectAction('rename', n.id)">✎ 重命名</button>
            <button class="danger" @click="selectAction('remove', n.id)">× 删除</button>
          </div>
        </span>
      </div>
      <FolderTree
        v-if="isOpen(n.id) && hasKids(n)"
        :nodes="(n.children || []).slice()"
        :selected-id="selectedId"
        :managing="managing"
        :creating-parent="creatingParent"
        :default-name="defaultName"
        :__selfId="n.id"
        :batch="batch"
        :batch-selected="batchSelected"
        @select="(id) => emit('select', id)"
        @remove="(id) => emit('remove', id)"
        @commit-create="(name) => emit('commit-create', name)"
        @cancel-create="() => emit('cancel-create')"
        @move-up="(id) => emit('move-up', id)"
        @move-down="(id) => emit('move-down', id)"
        @promote="(id) => emit('promote', id)"
        @demote="(id) => emit('demote', id)"
        @rename="(id) => emit('rename', id)"
        @batch-toggle="(id) => emit('batch-toggle', id)"
        @drop-on="(s, t) => emit('drop-on', s, t)"
        @drop-root="(id) => emit('drop-root', id)"
      />
    </li>
  </ul>
</template>

<style scoped>
.tree {
  list-style: none;
  margin: 0;
  padding-left: 10px;
}
.tree > li {
  margin: 2px 0;
}
.node {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 6px;
  border-radius: 6px;
  gap: 4px;
  border: 1px solid transparent;
  transition: background 0.12s, border-color 0.12s;
  position: relative;
}
.node.active {
  background: var(--primary-soft);
}
.node.drop-target {
  background: var(--primary-soft);
  border-color: var(--primary);
  outline: 1px dashed var(--primary);
}
.tw {
  cursor: pointer;
  width: 16px;
  min-width: 16px;
  text-align: center;
  color: var(--muted);
  font-size: 11px;
  user-select: none;
  border-radius: 4px;
  line-height: 16px;
  transition: background 0.12s, color 0.12s;
}
.tw:hover {
  background: var(--primary-soft);
  color: var(--primary);
}
.tw.open {
  color: var(--primary);
}
.tw-leaf {
  cursor: default;
  color: transparent;
}
.tw-leaf:hover {
  background: transparent;
}
.kid-badge {
  display: inline-block;
  margin-left: 5px;
  padding: 0 5px;
  font-size: 10px;
  line-height: 15px;
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--muted);
  vertical-align: 1px;
}
.batch-cb {
  width: 15px;
  height: 15px;
  margin: 0 2px 0 0;
  cursor: pointer;
  flex-shrink: 0;
  accent-color: var(--primary);
}
.node.batch-on .name {
  cursor: pointer;
}
.name {
  cursor: pointer;
  font-size: 13px;
  flex: 1;
  user-select: none;
}
.ops {
  display: inline-flex;
  gap: 1px;
  align-items: center;
  position: relative;
}
.ops button.adj {
  padding: 0 5px;
  font-size: 12px;
  line-height: 18px;
  min-width: 22px;
  border-radius: 4px;
}
.ops button.adj:hover {
  background: var(--panel-2);
}
.ops button.menu-btn {
  font-weight: 700;
  letter-spacing: -1px;
}
.ops button.menu-btn.active {
  background: var(--primary-soft);
  color: var(--primary);
}

/* ⋮ 弹出菜单 */
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 2px);
  background: var(--panel-solid);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
  z-index: 100;
  min-width: 170px;
  padding: 4px 0;
}
.menu button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 12px;
  font-size: 12px;
  background: transparent;
  border: 0;
  cursor: pointer;
  color: var(--text);
  border-radius: 0;
  line-height: 1.5;
}
.menu button:hover {
  background: var(--panel-2);
}
.menu button.danger {
  color: var(--danger);
}
.menu button.danger:hover {
  background: rgba(239, 68, 68, 0.08);
}

/* 根级 drop zone */
.root-drop {
  font-size: 11px;
  color: var(--muted);
  padding: 4px 8px;
  margin-bottom: 4px;
  border-radius: 5px;
  border: 1px dashed transparent;
  text-align: center;
  user-select: none;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.root-drop.over {
  background: var(--primary-soft);
  border-color: var(--primary);
  color: var(--primary);
}
</style>
