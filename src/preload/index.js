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
  },
  pairDevice: (code) => ipcRenderer.invoke('device:pair', code),
  disconnectDevice: () => ipcRenderer.invoke('device:disconnect'),
  getDeviceStatus: () => ipcRenderer.invoke('device:status'),
  sendDeviceMessage: (payload) => ipcRenderer.invoke('device:send', payload),
  /** 发送一帧 PCM 音频（首字节为音源：0=系统音频，1=麦克风） */
  sendDeviceAudio: (bytes) => ipcRenderer.send('device:audio', bytes),
  onDeviceStatus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('device:status', listener)
    return () => ipcRenderer.removeListener('device:status', listener)
  },
  onDeviceMessage: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('device:message', listener)
    return () => ipcRenderer.removeListener('device:message', listener)
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
