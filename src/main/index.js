import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  session,
  desktopCapturer,
  screen,
  clipboard,
  ClipboardItem,
  globalShortcut,
  Tray,
  Menu,
  nativeImage
} from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createDeviceLink } from './device-link'
import { createAnswerShortcuts } from './answer-shortcuts'

const DEFAULT_SETTINGS = {
  clipboardMonitor: true,
  trayEnabled: true,
  screenshotShortcut: 'CommandOrControl+Shift+Space'
}

/** 截图答题：二进制帧首字节 2 + JPEG 图片 */
const SCREENSHOT_MARKER = 2
/** 需小于后端 WebSocket 1 MB 的二进制上限，留出帧头余量 */
const MAX_SCREENSHOT_BYTES = 850 * 1024
/** 截图答题时的最大宽度，足够 OCR 又不会过大 */
const SCREENSHOT_MAX_WIDTH = 1600

let mainWindow = null
let tray = null
let deviceLink = null
let answerShortcuts = null
let isQuitting = false
let clipboardTimer = null
let lastClipboardText = ''
let selectedDisplaySourceId = null
let settings = { ...DEFAULT_SETTINGS }

const settingsPath = () => join(app.getPath('userData'), 'settings.json')

function loadSettings() {
  try {
    if (existsSync(settingsPath())) {
      const saved = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
      settings = { ...DEFAULT_SETTINGS, ...saved }
    }
  } catch (error) {
    console.error('读取设置失败', error)
  }
}

function persistSettings() {
  try {
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
  } catch (error) {
    console.error('保存设置失败', error)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 610,
    height: 410,
    minWidth: 540,
    minHeight: 380,
    show: false,
    autoHideMenuBar: true,
    title: 'EasyOffer',
    backgroundColor: '#f2f3f5',
    // Windows / Linux 都设置窗口与任务栏图标；macOS 会忽略该选项
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 网页端可以随时触发测试音频，无需用户先在客户端点一下
      autoplayPolicy: 'no-user-gesture-required',
      // 窗口被网页遮挡或最小化时，音量上报与采集仍需保持正常频率
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => (mainWindow = null))

  // 开启托盘时，点关闭按钮只隐藏窗口，不退出应用
  mainWindow.on('close', (event) => {
    if (!isQuitting && settings.trayEnabled) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow() {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function toggleWindow() {
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide()
  } else {
    showWindow()
  }
}

/** 系统托盘 */
function applyTray() {
  if (settings.trayEnabled) {
    if (tray) return
    const image = nativeImage.createFromPath(icon)
    tray = new Tray(image.resize({ width: 16, height: 16 }))
    tray.setToolTip('EasyOffer')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: showWindow },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            isQuitting = true
            app.quit()
          }
        }
      ])
    )
    tray.on('click', toggleWindow)
  } else if (tray) {
    tray.destroy()
    tray = null
  }
}

/** 剪贴板监听 */
let clipboardReading = false

function startClipboardMonitor() {
  if (clipboardTimer) return
  clipboard
    .readText()
    .then((text) => (lastClipboardText = text))
    .catch(() => {})
  clipboardTimer = setInterval(async () => {
    if (clipboardReading) return
    clipboardReading = true
    try {
      const text = await clipboard.readText()
      if (text && text !== lastClipboardText) {
        lastClipboardText = text
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('clipboard-text', text)
        }
      }
    } catch (error) {
      console.error('读取剪贴板失败', error)
    } finally {
      clipboardReading = false
    }
  }, 700)
}

function stopClipboardMonitor() {
  if (clipboardTimer) {
    clearInterval(clipboardTimer)
    clipboardTimer = null
  }
}

function applyClipboardMonitor() {
  if (settings.clipboardMonitor) startClipboardMonitor()
  else stopClipboardMonitor()
}

/** 光标所在显示器，多屏时截用户正在操作的那一块 */
function currentDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

/** 截取显示器画面；maxWidth 用于限制截图答题时的分辨率 */
async function captureDisplaySource(maxWidth) {
  const display = currentDisplay()
  const scale = display.scaleFactor || 1
  const physicalWidth = Math.max(1, Math.round(display.size.width * scale))
  const physicalHeight = Math.max(1, Math.round(display.size.height * scale))
  const width = Math.min(maxWidth, physicalWidth)
  const height = Math.max(1, Math.round((width * physicalHeight) / physicalWidth))
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })
  return sources.find((s) => s.display_id === String(display.id)) || sources[0]
}

/** 只有网页端点击「开始面试 / 继续面试」后才允许截图答题 */
function isInterviewRunning() {
  const status = deviceLink?.status()
  return status?.status === 'connected' && status?.interviewRunning === true
}

/** 控制 JPEG 体积：先降质量，仍然过大再缩小尺寸 */
function encodeScreenshot(image) {
  let quality = 75
  let buffer = image.toJPEG(quality)
  while (buffer.length > MAX_SCREENSHOT_BYTES && quality > 35) {
    quality -= 10
    buffer = image.toJPEG(quality)
  }
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    const { width } = image.getSize()
    const ratio = Math.sqrt(MAX_SCREENSHOT_BYTES / buffer.length)
    buffer = image.resize({ width: Math.max(640, Math.round(width * ratio)) }).toJPEG(45)
  }
  return buffer
}

/**
 * Ctrl+Shift+空格：
 * - 面试进行中（网页端已点击开始 / 继续）：静默截图并上传，由后端 OCR 后直接给出答案；
 * - 未开始或未连接：保持原来的行为，截图写入剪贴板，不触发答题。
 */
async function takeScreenshot() {
  try {
    const forAnswer = isInterviewRunning()
    const source = await captureDisplaySource(
      forAnswer ? SCREENSHOT_MAX_WIDTH : Number.MAX_SAFE_INTEGER
    )
    if (!source) return

    if (forAnswer) {
      const jpeg = encodeScreenshot(source.thumbnail)
      const frame = Buffer.concat([Buffer.from([SCREENSHOT_MARKER]), jpeg])
      if (deviceLink?.sendBinary(frame)) return
    }

    const blob = new Blob([source.thumbnail.toPNG()], { type: 'image/png' })
    await clipboard.write([new ClipboardItem({ 'image/png': blob })])
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('screenshot-taken')
    }
  } catch (error) {
    console.error('截屏失败', error)
  }
}

/** 全局快捷键 */
function registerScreenshotShortcut(accelerator) {
  try {
    return globalShortcut.register(accelerator, takeScreenshot)
  } catch {
    return false
  }
}

function applyScreenshotShortcut(nextAccelerator) {
  const previous = settings.screenshotShortcut
  if (nextAccelerator === previous) return true
  globalShortcut.unregister(previous)
  if (registerScreenshotShortcut(nextAccelerator)) return true
  // 注册失败则恢复旧快捷键
  registerScreenshotShortcut(previous)
  return false
}

// 渲染进程通过 getDisplayMedia 采集系统音频时，由主进程指定采集源并开启 loopback
function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    const source = sources.find((s) => s.id === selectedDisplaySourceId) || sources[0]
    if (!source) {
      callback({})
      return
    }
    // audio: 'loopback' 捕获系统播放的声音（Windows / macOS 13+）
    callback({ video: source, audio: 'loopback' })
  })
}

function setupPermissions() {
  const allowed = new Set(['media', 'display-capture', 'mediaKeySystem'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.easyoffer.desktop')

  loadSettings()
  setupPermissions()
  setupDisplayMediaHandler()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 可采集的屏幕列表（系统音频来源）
  ipcMain.handle('get-display-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    })
    return sources.map((s) => ({ id: s.id, name: s.name }))
  })

  ipcMain.on('set-display-source', (_event, id) => {
    selectedDisplaySourceId = id
  })

  ipcMain.handle('open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      return shell.openExternal(url)
    }
  })

  ipcMain.handle('settings:get', () => settings)

  ipcMain.handle('settings:set', (_event, patch = {}) => {
    const next = { ...settings, ...patch }

    if (
      typeof next.screenshotShortcut === 'string' &&
      next.screenshotShortcut !== settings.screenshotShortcut &&
      !applyScreenshotShortcut(next.screenshotShortcut)
    ) {
      return { ok: false, message: '快捷键注册失败，可能已被其他程序占用', settings }
    }

    settings = next
    persistSettings()
    applyTray()
    applyClipboardMonitor()
    return { ok: true, settings }
  })

  answerShortcuts = createAnswerShortcuts({
    send: (action) => {
      deviceLink?.send({
        type: 'key.event',
        data: { action, timestamp: Date.now() }
      })
    }
  })

  deviceLink = createDeviceLink({
    sendToRenderer: (channel, payload) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(channel, payload)
      }
    },
    getVersion: () => app.getVersion(),
    // 只在设备与网页房间连接期间注册面试快捷键
    onStatusChange: (state) => answerShortcuts?.setActive(state.status === 'connected')
  })

  ipcMain.handle('device:pair', (_event, code) => deviceLink.pair(code))
  ipcMain.handle('device:disconnect', () => {
    deviceLink.disconnect()
    return { ok: true }
  })
  ipcMain.handle('device:status', () => deviceLink.status())
  ipcMain.handle('device:send', (_event, payload) => deviceLink.send(payload))
  ipcMain.on('device:audio', (_event, bytes) => {
    if (bytes && bytes.byteLength) {
      deviceLink.sendBinary(bytes)
    }
  })

  createWindow()
  applyTray()
  applyClipboardMonitor()
  globalShortcut.register('CommandOrControl+Shift+T', toggleWindow)
  registerScreenshotShortcut(settings.screenshotShortcut)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  answerShortcuts?.dispose()
  deviceLink?.dispose()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
