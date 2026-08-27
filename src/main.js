import { createApp } from 'vue'
import App from './App.vue'
import VoiceInput from './components/VoiceInput.vue'
import './style.css'

createApp(App).component('VoiceInput', VoiceInput).mount('#app')

// 仅在构建产物中注册 Service Worker，使应用可“安装到桌面”并离线使用
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  })
  // 新版 SW 接管（clients.claim）后强制刷新一次，吃掉 standalone 旧白屏实例
  let swRefreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshing) return
    swRefreshing = true
    location.reload()
  })
}
