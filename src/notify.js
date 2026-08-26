// 桌面通知封装（Web Notifications API）
// 注意：纯网页通知只有在页面/标签页处于打开状态时才会弹出；
// 若需关闭浏览器也能提醒，需封装为 Electron/Tauri 桌面应用（见规格 Phase 3）。

export function requestNotifyPermission() {
  if (!('Notification' in window)) return
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
}

export function notify(title, body, onClick) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false
  try {
    const n = new Notification(title, { body, tag: 'workbench-reminder' })
    if (typeof onClick === 'function') {
      n.onclick = () => { try { onClick() } catch (e) {} }
    }
    return true
  } catch (e) {
    return false
  }
}
