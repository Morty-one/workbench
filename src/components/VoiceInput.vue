<template>
  <div class="voice-input-wrap" :class="{ recording }">
    <button
      type="button"
      class="voice-btn"
      :class="{ recording }"
      @click="toggle"
      @mousedown.prevent
      :title="error || (recording ? '点击停止录音' : '点击开始语音输入')"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="2" width="6" height="12" rx="3"></rect>
        <path d="M5 10a7 7 0 0 0 14 0"></path>
        <line x1="12" y1="19" x2="12" y2="22"></line>
        <line x1="8" y1="22" x2="16" y2="22"></line>
      </svg>
    </button>
    <span v-if="interim" class="voice-interim">{{ interim }}</span>
    <span v-if="error" class="voice-error">{{ error }}</span>
  </div>
</template>

<script setup>
import { ref, onUnmounted } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  // true: 识别结果追加到现有文本末尾；false: 覆盖
  append: { type: Boolean, default: true },
  lang: { type: String, default: 'zh-CN' }
})
const emit = defineEmits(['update:modelValue', 'result'])

let recognition = null
const recording = ref(false)
const interim = ref('')
const error = ref('')

function toggle() {
  recording.value ? stop() : start()
}

function start() {
  if (recording.value) return
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) {
    error.value = '当前浏览器不支持语音识别，请使用 Edge 或 Chrome'
    return
  }
  try {
    recognition = new SR()
  } catch (e) {
    error.value = '语音识别初始化失败：' + (e?.message || '')
    return
  }
  recognition.lang = props.lang
  recognition.continuous = true
  recognition.interimResults = true
  recognition.onresult = (e) => {
    let finalText = ''
    let temp = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const tr = e.results[i]
      if (tr.isFinal) finalText += tr[0].transcript
      else temp += tr[0].transcript
    }
    interim.value = temp
    if (finalText) {
      const base = String(props.modelValue || '')
      const needSep = base && !base.endsWith(' ') && !base.endsWith('\n')
      const next = props.append ? base + (needSep ? ' ' : '') + finalText : finalText
      emit('update:modelValue', next)
      emit('result', finalText)
    }
  }
  recognition.onerror = (e) => {
    if (e?.error === 'no-speech') return // 无语音输入，静默
    if (e?.error === 'aborted') return
    error.value = '语音识别错误：' + (e?.error || '未知')
    stop()
  }
  recognition.onend = () => {
    recording.value = false
    interim.value = ''
  }
  try {
    recognition.start()
    recording.value = true
    error.value = ''
  } catch (e) {
    error.value = '无法启动语音识别：' + (e?.message || '')
    recognition = null
    recording.value = false
  }
}

function stop() {
  try { recognition?.stop() } catch (e) { /* ignore */ }
  recognition = null
  recording.value = false
  interim.value = ''
}

onUnmounted(stop)
</script>

<style scoped>
.voice-input-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-shrink: 0;
}
.voice-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius, 8px);
  border: 1px solid var(--border-strong, #d0d0d0);
  background: var(--panel-solid, #fff);
  color: var(--muted, #888);
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition: all 0.15s ease;
}
.voice-btn:hover {
  color: var(--primary, #4f6ef2);
  border-color: var(--primary, #4f6ef2);
}
.voice-btn.recording {
  color: var(--danger, #e5484d);
  border-color: var(--danger, #e5484d);
  background: var(--danger-soft, #fdecec);
  animation: voice-pulse 1.6s ease-in-out infinite;
}
@keyframes voice-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.35); }
  50% { box-shadow: 0 0 0 6px rgba(229, 72, 77, 0); }
}
.voice-interim {
  font-size: 12px;
  color: var(--muted, #999);
  font-style: italic;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.voice-error {
  font-size: 11px;
  color: var(--danger, #e5484d);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
