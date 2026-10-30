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

const DEFAULT_SETTINGS = {
  clipboardMonitor: true,
  trayEnabled: true,
  screenshotShortcut: 'CommandOrControl+Shift+Space'
}

let mainWindow = null
let tray = null
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
    title: 'OfferStar',
    backgroundColor: '#f2f3f5',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
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
    tray.setToolTip('OfferStar')
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

/** 截屏并写入剪贴板 */
async function takeScreenshot() {
  try {
    const display = screen.getPrimaryDisplay()
    const { width, height } = display.size
    const scale = display.scaleFactor || 1
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(width * scale),
        height: Math.round(height * scale)
      }
    })
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0]
    if (!source) return
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
  electronApp.setAppUserModelId('com.easyoffer.offerstar')

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
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
