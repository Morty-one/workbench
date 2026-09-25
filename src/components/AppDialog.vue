<script setup>
/* 应用内对话框组件（第 44 轮）
 *
 * 由 App.vue 根部挂**一个**实例即可 —— 状态在 utils/appDialog.js 的全局单例里，
 * 各视图只需 `await appConfirm(...)` / `await appPrompt(...)`，不各自渲染。
 *
 * 视觉沿用既有的 `.modal-mask` / `.modal` / `.modal-head`（style.css:592-637），
 * 也就是本项目 6 个弹窗的「官方长相」—— 不引任何 UI 库、不另起一套视觉。
 *
 * ⚠️ z-index 必须**高于** `.modal-mask` 的 90：Duty.vue 的「清空选择」弹窗里会再弹二次确认，
 *    两层遮罩叠在一起时，新的这层必须在上面。
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { dialogState, dialogOk, dialogCancel } from '../utils/appDialog.js'

const inputEl = ref(null)
const okEl = ref(null)

const messageLines = computed(() =>
  String(dialogState.message || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
)

/* 焦点必须**锁进弹窗**：遮罩只挡鼠标、不挡键盘。
   prompt ⇒ 聚焦输入框（可预选原名）；confirm ⇒ 聚焦主按钮，
   否则 Tab/Enter 可能落到遮罩后面那些输入框上。 */
watch(
  () => dialogState.visible,
  async (v) => {
    if (!v) return
    await nextTick()
    if (dialogState.mode === 'prompt' && inputEl.value) {
      inputEl.value.focus()
      if (dialogState.selectOnFocus) inputEl.value.select()
    } else if (okEl.value) {
      okEl.value.focus()
    }
  }
)

/* Enter=确定、Esc=取消（与原生手感一致）。
   放在 window 上而不是遮罩上：遮罩本身不可聚焦，事件不一定能冒泡到它。 */
function onWinKey(e) {
  if (!dialogState.visible) return
  if (e.key === 'Escape') {
    e.preventDefault()
    dialogCancel()
  } else if (e.key === 'Enter') {
    // 必须 preventDefault：否则焦点在某个按钮上时，浏览器会自己再派发一次 click，
    // 与这里形成「确定 + 取消」两次结算（settle 里有幂等守卫，但提示会闪一下）
    e.preventDefault()
    dialogOk()
  }
}
onMounted(() => window.addEventListener('keydown', onWinKey))
onUnmounted(() => window.removeEventListener('keydown', onWinKey))
</script>

<template>
  <!-- ⚠️ 不做 @click.self 取消：本项目第 213 项已定案「弹窗点击遮罩层不关闭」，
       而且原生 confirm/prompt 也没有「点外面就取消」这个行为。保持一致，必须显式选一个。 -->
  <div v-if="dialogState.visible" class="modal-mask app-dlg-mask">
    <div
      class="modal app-dlg"
      :class="{ danger: dialogState.danger }"
      role="dialog"
      aria-modal="true"
      :aria-label="dialogState.title"
    >
      <div class="modal-head">
        <strong>{{ dialogState.title }}</strong>
      </div>

      <div v-if="messageLines.length || dialogState.warn" class="app-dlg-body">
        <p v-for="(line, i) in messageLines" :key="'m' + i" class="app-dlg-line">{{ line }}</p>
        <p v-if="dialogState.warn" class="app-dlg-line warn">{{ dialogState.warn }}</p>
      </div>

      <input
        v-if="dialogState.mode === 'prompt'"
        ref="inputEl"
        v-model="dialogState.input"
        class="app-dlg-input"
        :type="dialogState.inputType"
        :placeholder="dialogState.placeholder"
        autocomplete="off"
        spellcheck="false"
      />

      <div class="row app-dlg-foot">
        <button class="ghost" @click="dialogCancel">{{ dialogState.cancelText }}</button>
        <button
          ref="okEl"
          :class="dialogState.danger ? 'danger' : 'primary'"
          @click="dialogOk"
        >{{ dialogState.okText }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 必须压过 .modal-mask 的 z-index:90 —— 支持「弹窗里再弹窗」的嵌套场景 */
.app-dlg-mask {
  z-index: 200;
}

.app-dlg {
  max-width: 440px;
}

.app-dlg.danger {
  border-color: rgba(239, 68, 68, 0.35);
}

.app-dlg-body {
  margin-bottom: 2px;
}

.app-dlg-line {
  margin: 0 0 9px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text);
}

.app-dlg-line.warn {
  color: var(--danger);
}

/* 16px 是下限：小于它 iOS Safari 会自动放大整个页面 */
.app-dlg-input {
  width: 100%;
  font-size: 16px;
  margin-top: 4px;
}

.app-dlg-foot {
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}

/* 触屏加大点击区（铁律：按钮最小 44×44px） */
@media (max-width: 720px) {
  .app-dlg-foot button {
    min-height: 44px;
    padding-left: 18px;
    padding-right: 18px;
  }
}
</style>
