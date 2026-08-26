// 设备能力探测：用于移动端隐藏 PC 专属功能（文档输出 / 本地目录同步等）
export const isMobileDevice =
  typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)

// iOS（含 iPadOS 桌面 UA 的 iPad）
export const isIOS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
