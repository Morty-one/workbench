<template>
  <div class="voice-input-wrap" :class="{ recording }">
    <button
      type="button"
      class="voice-btn"
      :class="{ recording }"
      @click="toggle"
      :title="error || (recording ? '点击停止录音' : '点击开始语音输入')"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="2" width="6" height="12" rx="3"></rect>
        <path d="M5 10a7 7 0 0 0 14 0"></path>
        <line x1="12" y1="19" x2="12" y2="22"></line>
        <line x1="8" y1="22" x2="16" y2="22"></line>
      </svg>
    </button>
    <span v-if="recording && interim" class="voice-state">{{ interim }}</span>
    <span v-if="error" class="voice-error" :title="error">{{ error }}</span>
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

// 原版实现：浏览器原生 Web Speech API（SpeechRecognition / webkitSpeechRecognition）。
// 浏览器会把音频发到 Google 的服务做识别，所以国内使用时大概率报 network 错误。
const recording = ref(false)
const interim = ref('')
const error = ref('')

let recognition = null

function getSR() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null
}

function toggle() {
  recording.value ? stop() : start()
}

function start() {
  if (recording.value) return
  error.value = ''
  interim.value = ''
  const SR = getSR()
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
    let interimText = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      if (r.isFinal) finalText += r[0].transcript
      else interimText += r[0].transcript
    }
    interim.value = interimText
    if (finalText) {
      const base = String(props.modelValue || '')
      const needSep = base && !base.endsWith(' ') && !base.endsWith('\n')
      const next = props.append ? base + (needSep ? ' ' : '') + finalText : finalText
      emit('update:modelValue', next)
      emit('result', finalText)
    }
  }
  recognition.onerror = (e) => {
    const map = {
      'network': '语音识别网络错误（浏览器到 Google 的连接被阻断，国内常见）',
      'not-allowed': '麦克风权限被拒绝',
      'audio-capture': '未检测到麦克风设备',
      'no-speech': '未检测到语音',
      'aborted': '识别已中止',
      'language-not-supported': '当前语言不支持',
      'service-not-allowed': '浏览器禁止使用语音识别服务'
    }
    error.value = map[e.error] || ('语音识别出错：' + (e.error || ''))
  }
  recognition.onend = () => {
    recording.value = false
    interim.value = ''
  }

  try {
    recognition.start()
    recording.value = true
  } catch (e) {
    error.value = '启动语音识别失败：' + (e?.message || '')
    recording.value = false
  }
}

function stop() {
  if (recognition) {
    try { recognition.stop() } catch (e) {}
  }
  recording.value = false
}

onUnmounted(() => {
  if (recognition) {
    try { recognition.abort() } catch (e) {}
  }
})
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
.voice-state {
  font-size: 12px;
  color: var(--primary, #4f6ef2);
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
