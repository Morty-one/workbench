<script setup>
/**
 * 3D 项目卡片堆叠 —— 参考图1 "项目文档" 文件夹风格
 * - 纯 CSS transform 实现层叠透视，无任何外部库
 * - 数据来自 projects 表；完成度支持 auto（按任务完成比例）/ manual（手动百分比）
 * - 点击卡片切到该项目；双击（或点「查看任务」）冒泡给父级下钻
 */
import { computed, ref } from 'vue'

const props = defineProps({
  projects: { type: Array, default: () => [] },
  tasks: { type: Array, default: () => [] },
  maxVisible: { type: Number, default: 5 }
})
const emit = defineEmits(['open', 'manage', 'select'])

const activeIdx = ref(0)

// 颜色工具：解析 hex + 混色（向白 / 向黑）
function toRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
  }
}
function mix(hex, target, t) {
  // t=0 取 hex，t=1 取 target
  const a = toRgb(hex)
  const b = toRgb(target)
  const r = Math.round(a.r + (b.r - a.r) * t)
  const g = Math.round(a.g + (b.g - a.g) * t)
  const bch = Math.round(a.b + (b.b - a.b) * t)
  return `rgb(${r}, ${g}, ${bch})`
}
function alpha(hex, a) {
  const { r, g, b } = toRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}
function darken(hex, pct) {
  return mix(hex, '#000000', pct / 100)
}

// 深色主题：项目色直接做高饱和渐变 + 辉光（保持原样，不改动）
function cardGrad(color) {
  const c = color || '#10b981'
  return `linear-gradient(145deg, ${c} 0%, ${darken(c, 18)} 100%)`
}
// 浅色主题：参考图「白底 + 极淡彩色晕染」水彩玻璃
function cardGradLight(color) {
  const c = color || '#10b981'
  // 顶部 15% 区域做极淡项目色晕染，其余接近纯白
  return `linear-gradient(180deg, ${mix(c, '#ffffff', 0.88)} 0%, ${mix(c, '#ffffff', 0.96)} 22%, #ffffff 48%, #ffffff 100%)`
}
// 浅色卡文字：不用项目色相，统一柔和深灰，避免颜色突出
function cardInk() {
  return 'var(--text)'
}
// 浅色进度条：极淡项目色，几乎像水彩笔触
function cardBar(color) {
  const c = color || '#10b981'
  return mix(c, '#ffffff', 0.18)
}
function cardGlow(color) {
  const c = color || '#10b981'
  return `0 10px 30px ${alpha(c, 0.25)}, 0 4px 12px ${alpha(c, 0.15)}`
}
function subStackStyle(p) {
  return {
    '--accent': p.color || '#10b981',
    '--grad': cardGrad(p.color),
    '--grad-light': cardGradLight(p.color),
    '--ink': cardInk(p.color),
    '--bar': cardBar(p.color),
    '--glow': cardGlow(p.color),
    zIndex: 1
  }
}

// 计算每个项目的完成度 + 任务数（含子项目，统一用此函数）
function calcCard(p) {
  const own = props.tasks.filter((t) => t.projectId === p.id)
  const done = own.filter((t) => t.status === '已完成').length
  const total = own.length
  const auto = total ? Math.round((done / total) * 100) : 0
  const progress = p.progressMode === 'manual' ? Number(p.manualProgress) || 0 : auto
  return { ...p, done, total, progress }
}
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0)
// 顶层父项目卡片（只展示父，子项目在父下展示）
const cards = computed(() =>
  props.projects
    .filter((p) => !p.archived && (p.parentId || null) === null)
    .slice()
    .sort(byOrder)
    .map((p) => ({ ...calcCard(p), childCount: childrenOf(p.id).length }))
)
// 某父项目下的子项目（带进度）
function childrenOf(pid) {
  return props.projects
    .filter((p) => !p.archived && (p.parentId || null) === pid)
    .slice()
    .sort(byOrder)
    .map(calcCard)
}

const visible = computed(() => cards.value)
const overflow = computed(() => 0)
const active = computed(() => visible.value[activeIdx.value] || null)

let wheelLock = 0
function onWheel(e) {
  // 移动端走原生横向滑动，不拦截
  if (window.innerWidth <= 768) return
  e.preventDefault()
  const n = visible.value.length
  if (!n) return
  // 节流，避免一次物理滚动连跳多张
  const now = Date.now()
  if (now - wheelLock < 220) return
  wheelLock = now
  // 到边界即停，不循环回绕
  if (e.deltaY > 0) {
    if (activeIdx.value < n - 1) activeIdx.value++
  } else if (e.deltaY < 0) {
    if (activeIdx.value > 0) activeIdx.value--
  }
}
function fmtRange(p) {
  if (!p.startAt && !p.endAt) return '未设定周期'
  const f = (ts) => {
    if (!ts) return '—'
    const d = new Date(ts)
    return `${d.getMonth() + 1}月${d.getDate()}日`
  }
  return `${f(p.startAt)} - ${f(p.endAt)}`
}
function daysLeft(p) {
  if (!p.endAt) return null
  return Math.ceil((p.endAt - Date.now()) / 86400000)
}
const RING = 2 * Math.PI * 26
function dash(pct) {
  return `${(RING * pct) / 100} ${RING}`
}

// 子项目展示：点击父卡片进入详情视图（方案 3 定稿），子项目以完整卡片形式展示
const drillId = ref(null)
function enterDrill(id) {
  emit('select', id)
  drillId.value = id
}
function exitDrill() {
  drillId.value = null
  // 返回「全部」时同步通知父级清空选中项目，使今日要处理一并回到全部任务
  emit('select', null)
}
const drillProject = computed(() => {
  const raw = props.projects.find((p) => p.id === drillId.value)
  return raw ? calcCard(raw) : null
})
const drillChildren = computed(() => (drillId.value ? childrenOf(drillId.value) : []))
const drillChain = computed(() => {
  const byId = (id) => props.projects.find((p) => p.id === id)
  const chain = []
  let cur = byId(drillId.value)
  while (cur) {
    chain.unshift(calcCard(cur))
    cur = cur.parentId ? byId(cur.parentId) : null
  }
  return chain
})
</script>

<template>
  <div class="stack-wrap">
    <div class="stack-head">
      <div>
        <div class="stack-title">项目文档</div>
        <div class="muted">{{ cards.length }} 个进行中的项目</div>
      </div>
      <div class="stack-head-right">
        <button class="ghost sm" @click="emit('manage')">管理</button>
      </div>
    </div>

    <div v-if="!cards.length" class="stack-empty muted">
      还没有项目，点「管理」创建第一个。
    </div>

    <template v-else>
      <!-- 父项目详情视图（点击卡片或子卡片进入） -->
      <div v-if="drillProject" class="drill-view">
        <div class="drill-crumbs">
          <button class="crumb" @click="exitDrill">全部</button>
          <template v-for="(n, idx) in drillChain" :key="n.id">
            <span class="crumb-sep">/</span>
            <button class="crumb" :class="{ cur: idx === drillChain.length - 1 }" @click="enterDrill(n.id)">{{ n.name }}</button>
          </template>
        </div>

        <!-- 子项目区（在父项目卡片上方） -->
        <div v-if="drillChildren.length" class="sub-cards">
          <div class="sub-cards-title">子项目（{{ drillChildren.length }}）</div>
          <div class="sub-cards-grid">
            <button
              v-for="s in drillChildren"
              :key="s.id"
              class="sub-stack"
              :style="subStackStyle(s)"
              @click="enterDrill(s.id)"
            >
              <div class="sc-tab">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
                </svg>
                <span class="sc-name">{{ s.name }}</span>
              </div>
              <div class="sc-body">
                <div class="sc-pct">{{ s.progress }}<span class="pct-unit">%</span></div>
                <div class="sc-range">{{ fmtRange(s) }}</div>
              </div>
              <div class="sc-bar">
                <div class="sc-fill" :style="{ width: s.progress + '%' }"></div>
              </div>
              <div class="sc-foot">
                <span>{{ s.done }}/{{ s.total }} 任务</span>
                <span v-if="daysLeft(s) != null" :class="['sc-status', daysLeft(s) < 0 ? 'over' : 'ok']">
                  {{ daysLeft(s) < 0 ? `超期 ${-daysLeft(s)} 天` : `剩余 ${daysLeft(s)} 天` }}
                </span>
              </div>
            </button>
          </div>
        </div>
        <div v-else class="muted drill-empty">该项目下暂无子项目</div>

        <!-- 父项目自身摘要卡片（左环右文，与堆叠区下方 active 摘要同款） -->
        <div class="sub-cards current-project">
          <div class="sub-cards-title">当前项目</div>
          <button class="drill-summary" @click="emit('select', drillProject.id); emit('open', drillProject.id)">
            <svg class="ring" viewBox="0 0 64 64" width="56" height="56">
              <circle cx="32" cy="32" r="26" fill="none" stroke="var(--border-strong)" stroke-width="5" />
              <circle
                cx="32" cy="32" r="26" fill="none"
                :stroke="drillProject.color || '#10b981'"
                stroke-width="5" stroke-linecap="round"
                :stroke-dasharray="dash(drillProject.progress)"
                transform="rotate(-90 32 32)"
              />
              <text x="32" y="36" text-anchor="middle" class="ring-txt">{{ drillProject.progress }}%</text>
            </svg>
            <div class="detail-body">
              <div class="detail-name">{{ drillProject.name }}</div>
              <div class="muted detail-desc">{{ drillProject.desc || '暂无描述' }}</div>
              <div class="detail-meta">
                <span class="pill plain">{{ drillProject.progressMode === 'manual' ? '手动进度' : '自动统计' }}</span>
                <span v-if="drillProject.childCount" class="pill plain">含 {{ drillProject.childCount }} 个子项目</span>
                <span v-if="drillProject.total" class="pill plain">{{ drillProject.done }}/{{ drillProject.total }} 任务</span>
              </div>
            </div>
            <span class="muted arrow">查看任务 ›</span>
          </button>
        </div>
      </div>
      <template v-else>
      <!-- 3D 堆叠区 -->
      <div class="stack-stage" @wheel="onWheel">
        <div class="ambient-glow"></div>
        <div
          v-for="(c, i) in visible"
          :key="c.id"
          class="stack-card"
          :class="{ active: i === activeIdx }"
          :style="{
            ...subStackStyle(c),
            '--i': i - activeIdx,
            '--d': Math.abs(i - activeIdx),
            zIndex: 20 - Math.abs(i - activeIdx)
          }"
          @click="enterDrill(c.id)"
        >
          <!-- 文件夹标签页 -->
          <div class="sc-tab">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
            </svg>
            <span class="sc-name">{{ c.name }}</span>
          </div>

          <div class="sc-body">
            <div class="sc-pct">{{ c.progress }}<span class="pct-unit">%</span></div>
            <div class="sc-range">{{ fmtRange(c) }}</div>
          </div>

          <div class="sc-bar">
            <div class="sc-fill" :style="{ width: c.progress + '%' }"></div>
          </div>

          <div class="sc-foot">
            <span>{{ c.done }}/{{ c.total }} 任务</span>
            <span v-if="c.childCount" class="sc-badge">含 {{ c.childCount }} 个子项目 ›</span>
            <span v-if="daysLeft(c) != null" :class="['sc-status', daysLeft(c) < 0 ? 'over' : 'ok']">
              {{ daysLeft(c) < 0 ? `超期 ${-daysLeft(c)} 天` : `剩余 ${daysLeft(c)} 天` }}
            </span>
          </div>
        </div>

        <div v-if="overflow" class="stack-more" @click="emit('manage')">+{{ overflow }}</div>
      </div>

      <!-- 选中项目详情 -->
      <div v-if="active" class="stack-detail">
        <svg class="ring" viewBox="0 0 64 64" width="56" height="56">
          <circle cx="32" cy="32" r="26" fill="none" stroke="var(--border-strong)" stroke-width="5" />
          <circle
            cx="32"
            cy="32"
            r="26"
            fill="none"
            :stroke="active.color || '#10b981'"
            stroke-width="5"
            stroke-linecap="round"
            :stroke-dasharray="dash(active.progress)"
            transform="rotate(-90 32 32)"
          />
          <text x="32" y="36" text-anchor="middle" class="ring-txt">{{ active.progress }}%</text>
        </svg>
        <div class="detail-body">
          <div class="detail-name">{{ active.name }}</div>
          <div class="muted detail-desc">{{ active.desc || '暂无描述' }}</div>
          <div class="detail-meta">
            <span class="pill plain">{{ active.progressMode === 'manual' ? '手动进度' : '自动统计' }}</span>
          </div>
        </div>
        <button class="ghost sm" @click="emit('open', active.id)">查看任务</button>
      </div>

      </template>
    </template>
  </div>
</template>

<style scoped>
.stack-wrap {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.stack-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.stack-title {
  font-size: 15px;
  font-weight: 600;
}
.stack-empty {
  padding: 24px 0;
  text-align: center;
}

/* ---------- 3D 舞台 ---------- */
.stack-stage {
  position: relative;
  height: 306px;
  perspective: 1280px;
  perspective-origin: 50% 28%;
  background:
    radial-gradient(ellipse at 54% 66%, rgb(var(--accent-rgb) / .06), transparent 30%),
    linear-gradient(180deg, rgba(17, 23, 20, .45), rgba(7, 11, 9, .62));
  border-radius: var(--radius);
  /* 滚轮用于切换 active 项目，舞台本身不滚动 */
  overflow: hidden;
}
.stack-stage::-webkit-scrollbar {
  width: 6px;
}
.stack-stage::-webkit-scrollbar-thumb {
  background: var(--border-strong);
  border-radius: 999px;
}
[data-theme="light"] .stack-stage::-webkit-scrollbar-thumb {
  background: rgba(15, 23, 42, 0.18);
}
/* 给最底部卡片与舞台边缘留点呼吸空间 */
.stack-stage::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 10px;
}
[data-theme="light"] .stack-stage {
  background:
    radial-gradient(ellipse at 54% 66%, rgb(var(--accent-rgb) / .04), transparent 32%),
    linear-gradient(180deg, rgba(255, 255, 255, .72), rgba(247, 249, 251, .88));
}
.stack-card {
  position: absolute;
  left: 50%;
  top: 8px;
  /* 卡片宽度：在 panel 内不再撑满，收紧到 max 440px、92% 取小，
     让卡片在窄面板（如右侧「项目文档」列）里也有合适比例；原 600px/94% 在窄容器被 94% 撑到接近全宽造成"宽而空"的观感。 */
  width: min(440px, 92%);
  min-height: 170px; /* 父项目卡片高度：原 156px → 170px（轻微加高）；文本改纵向 flex 分布，避免底部大片空白 */
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 6px;
  border-radius: var(--radius-xl);
  background-color: #10b981;
  background: var(--grad);
  border: 1px solid rgba(255, 255, 255, 0.32);
  color: #fff;
  cursor: pointer;
  transform-origin: 50% 100%;
  transform: translateX(-50%) translateY(calc(var(--i) * 36px)) translateZ(calc(var(--d) * -52px))
    rotateX(calc(var(--i) * -10deg)) scale(calc(1 - 0.06 * var(--d)));
  transition: transform 0.42s cubic-bezier(0.18, 0.77, 0.22, 1), box-shadow 0.42s, opacity 0.42s,
    filter 0.42s;
  opacity: calc(1 - 0.12 * var(--d));
  overflow: hidden;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  filter: saturate(calc(1 - 0.08 * var(--d))) brightness(calc(1 - 0.04 * var(--d)));
}
/* 顶部高光 */
.stack-card::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 42%;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.26), transparent);
  pointer-events: none;
}
.stack-card.active {
  opacity: 1;
  filter: saturate(1.08) brightness(1.04);
  /* 选中态用描边 + 极淡投影表达层次，不挂厚重外投影 */
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.18),
    0 0 0 1px rgba(255, 255, 255, 0.28),
    0 6px 18px rgba(0, 0, 0, 0.14);
}
.stack-card:hover {
  transform: translateX(-50%) translateY(calc(var(--i) * 36px - 6px)) translateZ(calc(var(--d) * -52px))
    rotateX(calc(var(--i) * -10deg)) scale(calc(1.02 - 0.06 * var(--d)));
  /* 交互阴影：鼠标挪动后才出现 */
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.18),
    0 16px 38px rgba(0, 0, 0, 0.30),
    0 0 26px rgb(var(--accent-rgb) / 0.14);
  z-index: 5;
}

/* 浅色主题：参考图「白底 + 极淡彩色晕染」水彩玻璃 */
[data-theme="light"] .stack-card {
  background-color: #ffffff;
  background: var(--grad-light);
  border-color: rgba(15, 23, 42, 0.05);
  color: var(--ink);
  text-shadow: none;
}
[data-theme="light"] .stack-card::after {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.7), transparent);
}
[data-theme="light"] .stack-card.active {
  filter: saturate(1.01) brightness(1);
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.8),
    0 0 0 1px rgba(15, 23, 42, 0.03),
    0 6px 18px rgba(15, 23, 42, 0.08);
}
[data-theme="light"] .stack-card:hover {
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.8),
    0 14px 34px rgba(15, 23, 42, 0.14),
    0 0 22px rgb(var(--accent-rgb) / 0.08);
}
[data-theme="light"] .sc-bar {
  background: rgba(15, 23, 42, 0.07);
}
[data-theme="light"] .sc-fill {
  background: var(--bar);
  box-shadow: none;
}
[data-theme="light"] .sc-status {
  background: rgba(15, 23, 42, 0.05);
  color: var(--ink);
}
[data-theme="light"] .sc-status.over {
  background: rgba(15, 23, 42, 0.08);
}

.sc-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  opacity: 0.95;
}
.sc-name {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-body {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.sc-pct {
  font-size: 32px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -1px;
}
.pct-unit {
  font-size: 16px;
  font-weight: 600;
  margin-left: 1px;
  opacity: 0.85;
}
.sc-range {
  font-size: 11px;
  opacity: 0.85;
  white-space: nowrap;
}
.sc-bar {
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.25);
  overflow: hidden;
  margin-bottom: 10px;
}
.sc-fill {
  height: 100%;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 0 8px rgba(255, 255, 255, 0.35);
  transition: width 0.4s ease;
}
.sc-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  opacity: 0.9;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.sc-badge {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--glow, rgba(255, 255, 255, 0.25));
  color: var(--ink, #fff);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.2px;
}
.sc-status {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
  font-size: 11px;
  font-weight: 600;
}
.sc-status.over {
  background: rgba(255, 255, 255, 0.35);
}
.stack-more {
  position: absolute;
  right: 6px;
  bottom: 6px;
  z-index: 30;
  background: var(--panel-solid);
  color: var(--primary);
  border-radius: 999px;
  padding: 5px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
}

/* ---------- 选中详情 ---------- */
.stack-detail,
.drill-summary {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--panel-solid);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
}
/* 当前项目信息框（默认视图卡片下方摘要）：放大并钉在「项目文档」面板底部，填掉下方空白 */
.stack-detail {
  margin-top: auto;
  padding: 18px 18px;
  min-height: 108px;
}
.drill-summary {
  width: 100%;
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.drill-summary:hover {
  border-color: var(--primary);
}
.drill-summary .arrow {
  flex: none;
  font-size: 13px;
}
.ring {
  flex: none;
}
.ring-txt {
  font-size: 14px;
  font-weight: 700;
  fill: var(--text);
}
.detail-body {
  flex: 1;
  min-width: 0;
}
.detail-name {
  font-weight: 600;
  font-size: 14px;
}
.detail-desc {
  font-size: 12px;
  margin: 2px 0 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.pill {
  font-size: 11px;
  border-radius: 999px;
  padding: 2px 9px;
}
.pill.plain {
  background: var(--panel-2);
  color: var(--muted);
  border: 1px solid var(--border);
}

/* ---------- 子项目展示（方式2/3） ---------- */
.stack-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.drill-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 撑满 .stack-wrap（其本身 flex:1; min-height:0; overflow-y:auto），
     使子项目区可在内部滚动，「当前项目」框钉在底部，不受子项目数量影响 */
  flex: 1;
  min-height: 0;
}
.drill-crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  font-size: 13px;
}
.crumb {
  background: none;
  border: none;
  color: var(--primary);
  cursor: pointer;
  padding: 2px 4px;
  font-size: 13px;
}
.crumb.cur {
  color: var(--text);
  font-weight: 600;
  cursor: default;
}
.crumb-sep {
  color: var(--muted);
}
.sub-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 子项目区：在 drill 视图内占据剩余空间并内部滚动，不把「当前项目」推到下方看不见 */
.drill-view > .sub-cards:not(.current-project) {
  flex: 1;
  min-height: 0;
}
.drill-view > .sub-cards:not(.current-project) .sub-cards-grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
.drill-view > .drill-empty {
  flex: 1;
  min-height: 0;
}
.sub-cards.current-project {
  margin-top: 8px;
  /* 钉在 drill 视图底部，不随子项目数量伸缩 */
  flex: none;
}
.sub-stack.current {
  border: 1px solid rgba(255, 255, 255, 0.45);
  box-shadow: var(--glow), 0 0 0 1px var(--primary) inset, 0 2px 6px rgba(0, 0, 0, 0.1);
}
.sub-cards-title {
  font-size: 12px;
  color: var(--muted);
}
.sub-cards-grid {
  /* 子项目卡片：与父项目卡片同尺寸 440×170。
     列宽下限 440px（窄屏时取 100% 收缩，等价于父卡 width:min(440px,92%) 的收缩行为），
     上限 1fr 铺满剩余空间；auto-fill 让一行尽量多排 440px 卡片。 */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(440px, 100%), 1fr));
  gap: 12px;
}
/* 子项目：与父项目堆叠卡片同款视觉，静态布局 */
.sub-stack {
  position: relative;
  left: auto;
  top: auto;
  width: 100%;
  min-height: 130px; /* 子项目卡片高度：试 130px（父卡 .stack-card 有 rotateX/scale 3D 变换会视觉压矮，故子卡需用更小 min-height 才能与父卡"看着"同高） */
  padding: 18px 22px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 6px;
  border-radius: var(--radius-xl);
  background-color: #10b981;
  background: var(--grad);
  border: 1px solid rgba(255, 255, 255, 0.32);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.08), 0 8px 22px rgba(0, 0, 0, 0.18);
  color: #fff;
  cursor: pointer;
  overflow: hidden;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  transform: none;
  opacity: 1;
  filter: none;
  transition: transform 0.2s ease, filter 0.2s ease, box-shadow 0.2s ease;
}
.sub-stack::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 42%;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.26), transparent);
  pointer-events: none;
}
.sub-stack:hover {
  transform: translateY(-3px);
  filter: saturate(1.08) brightness(1.04);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.18), 0 20px 46px rgba(0, 0, 0, 0.34);
}
[data-theme="light"] .sub-stack {
  background-color: #ffffff;
  background: var(--grad-light);
  border-color: rgba(15, 23, 42, 0.05);
  color: var(--ink);
  text-shadow: none;
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.7), 0 4px 14px rgba(15, 23, 42, 0.05);
}
[data-theme="light"] .sub-stack::after {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.7), transparent);
}
[data-theme="light"] .sub-stack:hover {
  filter: none;
  box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.03), 0 12px 26px rgba(15, 23, 42, 0.09);
}
.drill-empty {
  padding: 8px 0;
}

/* ---------- 移动端：横向滑动 ---------- */
@media (max-width: 768px) {
  .stack-stage {
    height: auto;
    perspective: none;
    display: flex;
    gap: 10px;
    overflow-x: auto;
    padding-bottom: 6px;
    scroll-snap-type: x mandatory;
  }
  .stack-card {
    position: relative;
    left: auto;
    top: auto;
    transform: none !important;
    opacity: 1 !important;
    width: 78%;
    flex: none;
    scroll-snap-align: start;
  }
  .stack-more {
    position: relative;
    right: auto;
    bottom: auto;
    align-self: center;
    flex: none;
  }
  .stack-detail {
    flex-wrap: wrap;
  }
}
</style>
