/**
 * preload：contextBridge 暴露窗口控制 + 桌面集成 API 给注入脚本。
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
  autostart: {
    get: (): Promise<boolean> => ipcRenderer.invoke('dsh-app:get-autostart'),
    set: (enabled: boolean): Promise<void> => ipcRenderer.invoke('dsh-app:set-autostart', enabled),
  },
  launchMinimized: {
    get: (): Promise<boolean> => ipcRenderer.invoke('dsh-settings:get-launch-minimized'),
    set: (enabled: boolean): Promise<void> => ipcRenderer.invoke('dsh-settings:set-launch-minimized', enabled),
  },
  getInfo: (): Promise<{ appVersion: string; dshVersion: string; dshHome: string; logDir: string }> =>
    ipcRenderer.invoke('dsh-app:get-info'),
  openPath: (p: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dsh-app:open-path', p),
  checkForUpdates: (): Promise<{ current: string; latest: string | null; downloading: boolean; downloaded: boolean; unsupported?: boolean }> =>
    ipcRenderer.invoke('dsh-update:check'),
  backend: {
    check: (): Promise<unknown> => ipcRenderer.invoke('dsh-backend:check'),
    update: (): Promise<unknown> => ipcRenderer.invoke('dsh-backend:update'),
    onStatus: (cb: (s: unknown) => void): void => {
      ipcRenderer.on('dsh-backend:update-status', (_event, s: unknown) => cb(s))
    },
  },
  setup: {
    copyCommand: (): Promise<boolean> => ipcRenderer.invoke('dsh-setup:copy-command'),
    install: (): Promise<boolean> => ipcRenderer.invoke('dsh-setup:install'),
    onOutput: (cb: (t: string) => void): void => {
      ipcRenderer.on('dsh-setup:install-output', (_event, t: string) => cb(t))
    },
    onExit: (cb: (code: number | null) => void): void => {
      ipcRenderer.on('dsh-setup:install-exit', (_event, code: number | null) => cb(code))
    },
    recheck: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dsh-setup:recheck'),
  },
})
