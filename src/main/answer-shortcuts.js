/**
 * 面试房间的全局快捷键（主进程）。
 *
 * 只在设备与网页房间连接期间注册，避免在非面试场景抢占系统按键。
 * 按键通过 device:send 上报给服务端，由网页按房间状态处理：
 * - Ctrl + Shift + 回车：触发 AI 回答
 * - Ctrl + Shift + 左 / 右：切换上一条 / 下一条回答
 * - Ctrl + Shift + 上 / 下：滚动当前回答
 * - Ctrl + Shift + S：停止当前回答
 */

import { globalShortcut } from 'electron'

const SHORTCUTS = [
  ['CommandOrControl+Shift+Return', 'answer'],
  ['CommandOrControl+Shift+Left', 'answer-prev'],
  ['CommandOrControl+Shift+Right', 'answer-next'],
  ['CommandOrControl+Shift+Up', 'scroll-up'],
  ['CommandOrControl+Shift+Down', 'scroll-down'],
  ['CommandOrControl+Shift+S', 'stop']
]

export function createAnswerShortcuts({ send }) {
  const registered = new Set()
  let active = false

  function fire(action) {
    try {
      send(action)
    } catch (error) {
      console.warn(`[answer-shortcuts] 上报快捷键失败: ${action}`, error)
    }
  }

  function register(accelerator, action) {
    try {
      if (globalShortcut.register(accelerator, () => fire(action))) {
        registered.add(accelerator)
      } else {
        console.warn(`[answer-shortcuts] 快捷键注册失败，可能已被占用: ${accelerator}`)
      }
    } catch (error) {
      console.warn(`[answer-shortcuts] 快捷键注册异常: ${accelerator}`, error)
    }
  }

  function setActive(next) {
    const value = Boolean(next)
    if (value === active) return
    active = value

    if (active) {
      for (const [accelerator, action] of SHORTCUTS) {
        register(accelerator, action)
      }
      return
    }

    for (const accelerator of registered) {
      try {
        globalShortcut.unregister(accelerator)
      } catch {
        // 已随应用退出被统一注销
      }
    }
    registered.clear()
  }

  return {
    setActive,
    dispose: () => setActive(false)
  }
}
