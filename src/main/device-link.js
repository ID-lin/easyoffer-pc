/**
 * PC 客户端与网页面试房间之间的 WebSocket 连接（主进程）。
 *
 * 流程见 easyoffer/docs/DEVICE_PROTOCOL.md：
 * 网页端生成 6 位配对码 -> 客户端连接 /ws/device 并发送 pair -> 服务端回 device.ready。
 * 连接建立在主进程，浏览器端（渲染进程）只通过 IPC 接收状态：
 * - 网页 -> 客户端 的控制消息通过 device:message 转发；
 * - 后续的键盘 / 音频上报也在这里接入。
 */

import { app } from 'electron'

/**
 * 打包给用户安装时默认连接生产服务器；开发模式（npm run dev）默认连本机后端，
 * 避免本地网页生成的配对码在开发时误发到生产服务器。
 * 仍可用 EASYOFFER_WS_URL 覆盖，例如连局域网里的另一台后端。
 * 以后绑定域名并启用 HTTPS 后，生产地址应改成 wss://域名/ws/device。
 */
const DEFAULT_WS_URL = app.isPackaged
  ? 'ws://182.92.231.51/ws/device'
  : 'ws://127.0.0.1:8080/ws/device'
const PAIR_TIMEOUT_MS = 10_000
const PING_INTERVAL_MS = 25_000
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000]

const CLOSE_MESSAGES = {
  1006: '无法连接服务器，请确认后端已启动',
  1009: '消息超过大小限制',
  4000: '网页端已退出面试房间，请重新连接设备',
  4001: '设备已被新的客户端接管',
  4008: '连接超时，请重新输入配对码',
  4401: '登录状态已失效，请在网页端重新生成配对码',
  4404: '配对码无效或已过期，请在网页端重新生成',
  4429: '配对尝试次数过多，请稍后再试'
}

/** 网页端退出房间时服务端使用的关闭码：属于正常释放，不能自动重连 */
const ROOM_EXIT_CLOSE_CODE = 4000

/**
 * 这些关闭码表示配对已终结（被接管 / 码过期 / 登录失效），
 * 自动重连只会让两个客户端互相顶号、无限循环，必须停下来等用户重新配对。
 */
const NO_RECONNECT_CODES = new Set([1009, 4001, 4008, 4401, 4404, 4429])

/** 当前电脑的系统名称，用于连接成功后的展示 */
export function platformLabel() {
  if (process.platform === 'win32') return 'Windows 10/11'
  if (process.platform === 'darwin') return 'macOS'
  return 'Linux'
}

export function resolveWsUrl() {
  const configured = (process.env.EASYOFFER_WS_URL || '').trim()
  return configured || DEFAULT_WS_URL
}

export function createDeviceLink({ sendToRenderer, getVersion, onStatusChange }) {
  const state = {
    status: 'idle', // idle | connecting | connected | offline | error
    message: '',
    platformLabel: platformLabel(),
    interviewId: null,
    // 网页端点击「开始面试 / 继续面试」后才为 true；截图答题依赖这个状态
    interviewRunning: false,
    serverUrl: resolveWsUrl()
  }

  let socket = null
  let pairCode = ''
  let manual = false
  let disposed = false
  let hasConnected = false
  let retries = 0
  let reconnectTimer = null
  let pingTimer = null
  let pairTimer = null

  function snapshot() {
    return { ...state }
  }

  function update(patch) {
    Object.assign(state, patch)
    const next = snapshot()
    sendToRenderer('device:status', next)
    // 主进程据此注册 / 注销面试房间的全局快捷键
    onStatusChange?.(next)
  }

  function clearTimers() {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    clearTimeout(pairTimer)
    pairTimer = null
    clearInterval(pingTimer)
    pingTimer = null
  }

  function startPing(ws) {
    clearInterval(pingTimer)
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, PING_INTERVAL_MS)
  }

  function clientInfo() {
    return {
      name: 'EasyOffer 客户端',
      platform: process.platform,
      version: getVersion()
    }
  }

  function open() {
    if (disposed || manual) return

    clearTimeout(reconnectTimer)
    reconnectTimer = null

    if (typeof WebSocket === 'undefined') {
      fail('当前运行环境不支持 WebSocket')
      return
    }

    update({ status: 'connecting', message: retries ? '正在重新连接…' : '' })

    let ws
    try {
      ws = new WebSocket(resolveWsUrl())
    } catch (error) {
      fail(`连接服务器失败：${error.message}`)
      return
    }
    socket = ws

    // 配对码可能在等待期间过期，避免一直停在「连接中」
    pairTimer = setTimeout(() => {
      if (socket === ws && state.status !== 'connected') {
        fail('连接超时，请检查网络后重试')
      }
    }, PAIR_TIMEOUT_MS)

    ws.addEventListener('open', () => {
      if (socket !== ws) return
      ws.send(JSON.stringify({ type: 'pair', code: pairCode, client: clientInfo() }))
    })

    ws.addEventListener('message', (event) => {
      if (socket !== ws) return
      handleMessage(event.data)
    })

    ws.addEventListener('close', (event) => {
      if (socket !== ws) return
      socket = null
      handleClose(event)
    })

    // close 事件一定会在 error 之后触发，统一在 handleClose 处理
    ws.addEventListener('error', () => {})
  }

  function handleMessage(raw) {
    if (typeof raw !== 'string') {
      // 二进制消息（后续的音频回放等）
      sendToRenderer('device:binary', raw)
      return
    }

    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }

    switch (message.type) {
      case 'device.ready':
        clearTimeout(pairTimer)
        pairTimer = null
        retries = 0
        hasConnected = true
        update({
          status: 'connected',
          message: '',
          interviewId: message.data?.interviewId ?? null,
          interviewRunning: false
        })
        if (socket) startPing(socket)
        break
      case 'interview.start':
        // 网页端明确开始后，才允许截图答题
        update({ interviewRunning: true })
        sendToRenderer('device:message', message)
        break
      case 'interview.stop':
        update({ interviewRunning: false })
        sendToRenderer('device:message', message)
        break
      case 'error':
        fail(message.message || '连接失败')
        break
      case 'pong':
        break
      default:
        // 网页端下发的控制指令，如 { type: 'audio.test' }
        sendToRenderer('device:message', message)
    }
  }

  function handleClose(event) {
    clearInterval(pingTimer)
    pingTimer = null
    clearTimeout(pairTimer)
    pairTimer = null

    if (disposed || manual) return

    // 网页端退出房间：服务端主动释放设备，回到「未连接」，等用户重新配对
    if (event && event.code === ROOM_EXIT_CLOSE_CODE) {
      manual = true
      pairCode = ''
      hasConnected = false
      retries = 0
      clearTimers()
      update({
        status: 'idle',
        message: CLOSE_MESSAGES[ROOM_EXIT_CLOSE_CODE],
        interviewId: null,
        interviewRunning: false
      })
      return
    }

    const reason = closeMessage(event)
    const permanent = Boolean(event && NO_RECONNECT_CODES.has(event.code))
    if (hasConnected && !permanent) {
      update({
        status: 'offline',
        message: reason ? `${reason}，正在重连…` : '与网页端的连接已断开，正在重连…',
        interviewRunning: false
      })
      scheduleReconnect()
      return
    }
    fail(reason || '连接失败，请重试', false)
  }

  function closeMessage(event) {
    if (event && CLOSE_MESSAGES[event.code]) return CLOSE_MESSAGES[event.code]
    return (event && event.reason) || ''
  }

  function scheduleReconnect() {
    if (manual || disposed || !pairCode) return
    const delay = RECONNECT_DELAYS[Math.min(retries, RECONNECT_DELAYS.length - 1)]
    retries += 1
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      if (!manual && !disposed) open()
    }, delay)
  }

  function fail(text, closeNow = true) {
    manual = true
    pairCode = ''
    hasConnected = false
    clearTimers()
    const ws = socket
    socket = null
    if (closeNow && ws) {
      try {
        ws.close(1000, 'pair failed')
      } catch {
        // 已关闭
      }
    }
    update({ status: 'error', message: text, interviewId: null, interviewRunning: false })
  }

  function pair(code) {
    const trimmed = String(code || '').trim()
    if (!/^\d{6}$/.test(trimmed)) {
      return { ok: false, message: '请输入完整的 6 位配对码' }
    }
    if (state.status === 'connected') {
      return { ok: false, message: '设备已连接，无需重复配对' }
    }

    manual = false
    hasConnected = false
    retries = 0
    pairCode = trimmed

    const previous = socket
    socket = null
    if (previous) {
      try {
        previous.close(1000, 'repair')
      } catch {
        // 已关闭
      }
    }

    open()
    return { ok: true }
  }

  /** 向网页端发送业务消息（音频电平、键盘事件等），未连接时返回 false */
  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN || state.status !== 'connected') {
      return false
    }
    try {
      socket.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  /** 向服务端发送二进制音频帧（识别用），未连接时返回 false */
  function sendBinary(bytes) {
    if (!socket || socket.readyState !== WebSocket.OPEN || state.status !== 'connected') {
      return false
    }
    try {
      socket.send(bytes)
      return true
    } catch {
      return false
    }
  }

  function disconnect() {
    manual = true
    pairCode = ''
    hasConnected = false
    retries = 0
    clearTimers()

    const ws = socket
    socket = null
    if (ws) {
      try {
        ws.close(1000, 'client disconnect')
      } catch {
        // 已关闭
      }
    }
    update({ status: 'idle', message: '', interviewId: null, interviewRunning: false })
  }

  function dispose() {
    disposed = true
    manual = true
    clearTimers()
    const ws = socket
    socket = null
    if (ws) {
      try {
        ws.close(1000, 'app quit')
      } catch {
        // 已关闭
      }
    }
  }

  return {
    pair,
    send,
    sendBinary,
    disconnect,
    dispose,
    status: snapshot
  }
}
