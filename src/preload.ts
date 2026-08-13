/**
 * preload：contextBridge 暴露窗口控制 API 给注入脚本。
 * 最小面——只透传 IPC 调用，不暴露任何 Node/Electron 能力。
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', {
  minimize: (): Promise<void> => ipcRenderer.invoke('dsh-window:minimize'),
  maximizeToggle: (): Promise<void> => ipcRenderer.invoke('dsh-window:maximize-toggle'),
  close: (): Promise<void> => ipcRenderer.invoke('dsh-window:close'),
  onMaximized: (cb: (maximized: boolean) => void): void => {
    ipcRenderer.on('dsh-window:maximized', (_event, maximized: boolean) => cb(maximized))
  },
})
