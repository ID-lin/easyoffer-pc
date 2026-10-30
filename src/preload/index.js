import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 暴露给渲染进程的最小 API
const api = {
  platform: process.platform,
  getDisplaySources: () => ipcRenderer.invoke('get-display-sources'),
  setDisplaySource: (id) => ipcRenderer.send('set-display-source', id),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onClipboardText: (callback) => {
    const listener = (_event, text) => callback(text)
    ipcRenderer.on('clipboard-text', listener)
    return () => ipcRenderer.removeListener('clipboard-text', listener)
  },
  onScreenshotTaken: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('screenshot-taken', listener)
    return () => ipcRenderer.removeListener('screenshot-taken', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
