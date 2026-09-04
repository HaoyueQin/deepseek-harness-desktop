/**
 * preload：contextBridge 暴露窗口控制 + 桌面集成 API 给注入脚本。
 * 最小面——只透传 IPC 调用，不暴露任何 Node/Electron 能力。
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshDesktop', {
  minimize: (): Promise<void> => ipcRenderer.invoke('dsh-window:minimize'),
  maximizeToggle: (): Promise<void> => ipcRenderer.invoke('dsh-window:maximize-toggle'),
  close: (): Promise<void> => ipcRenderer.invoke('dsh-window:close'),
  onMaximized: (cb: (maximized: boolean) => void): () => void => {
    const handler = (_event: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on('dsh-window:maximized', handler)
    return () => ipcRenderer.removeListener('dsh-window:maximized', handler)
  },
  autostart: {
    get: (): Promise<boolean> => ipcRenderer.invoke('dsh-app:get-autostart'),
    set: (enabled: boolean): Promise<void> => ipcRenderer.invoke('dsh-app:set-autostart', enabled),
  },
  launchMinimized: {
    get: (): Promise<boolean> => ipcRenderer.invoke('dsh-settings:get-launch-minimized'),
    set: (enabled: boolean): Promise<void> => ipcRenderer.invoke('dsh-settings:set-launch-minimized', enabled),
  },
  portPolicy: {
    get: (): Promise<{ configured: number | 'random'; actual: number | null; degraded: boolean }> =>
      ipcRenderer.invoke('dsh-settings:get-port-policy'),
    set: (v: number | 'random'): Promise<void> => ipcRenderer.invoke('dsh-settings:set-port-policy', v),
  },
  getInfo: (): Promise<{
    appVersion: string
    dshVersion: string
    dshHome: string
    logDir: string
    backendSource: 'npm-global' | 'git-local' | null
    sourceDir: string | null
    notice: string | null
  }> =>
    ipcRenderer.invoke('dsh-app:get-info'),
  openPath: (p: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dsh-app:open-path', p),
  // 两段式更新：检查→下载→安装，每步都由设置页显式触发（绝不一条龙）
  update: {
    check: (): Promise<unknown> => ipcRenderer.invoke('dsh-update:check'),
    download: (): Promise<unknown> => ipcRenderer.invoke('dsh-update:download'),
    install: (): Promise<unknown> => ipcRenderer.invoke('dsh-update:install'),
    onStatus: (cb: (s: unknown) => void): (() => void) => {
      const handler = (_event: unknown, s: unknown): void => cb(s)
      ipcRenderer.on('dsh-update:status', handler)
      return () => ipcRenderer.removeListener('dsh-update:status', handler)
    },
  },
  backend: {
    check: (): Promise<unknown> => ipcRenderer.invoke('dsh-backend:check'),
    update: (): Promise<unknown> => ipcRenderer.invoke('dsh-backend:update'),
    onStatus: (cb: (s: unknown) => void): () => void => {
      const handler = (_event: unknown, s: unknown): void => cb(s)
      ipcRenderer.on('dsh-backend:update-status', handler)
      return () => ipcRenderer.removeListener('dsh-backend:update-status', handler)
    },
    // 后端来源配置（npm 全局 / git 源码目录）与生效操作
    getConfig: (): Promise<unknown> => ipcRenderer.invoke('dsh-backend:get-config'),
    setConfig: (patch: { mode?: string; sourceDir?: string; networkProxy?: string }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('dsh-backend:set-config', patch),
    pickDir: (): Promise<string | null> => ipcRenderer.invoke('dsh-backend:pick-dir'),
    validate: (dir: string): Promise<unknown> => ipcRenderer.invoke('dsh-backend:validate', dir),
    restart: (): Promise<{ ok: boolean; busy?: boolean; error?: string }> =>
      ipcRenderer.invoke('dsh-backend:restart'),
    onNotice: (cb: (notice: string | null) => void): () => void => {
      const handler = (_event: unknown, n: string | null): void => cb(n)
      ipcRenderer.on('dsh-backend:notice', handler)
      return () => ipcRenderer.removeListener('dsh-backend:notice', handler)
    },
    // 版本清单 / 切换任意版本 / 实时日志（恢复页版本区）
    listVersions: (): Promise<unknown> => ipcRenderer.invoke('dsh-backend:versions'),
    installVersion: (target: string): Promise<{ ok: boolean; busy?: boolean; error?: string }> =>
      ipcRenderer.invoke('dsh-backend:install-version', target),
    onVersionLog: (cb: (t: string) => void): (() => void) => {
      const handler = (_event: unknown, t: string): void => cb(t)
      ipcRenderer.on('recovery:log', handler)
      return () => ipcRenderer.removeListener('recovery:log', handler)
    },
  },
  plugins: {
    list: (): Promise<unknown> => ipcRenderer.invoke('plugins:list'),
    disable: (name: string): Promise<{ ok: boolean; applied: string[]; disabledCount: number; reason?: string | null }> =>
      ipcRenderer.invoke('plugins:disable', name),
    enable: (name: string): Promise<{ ok: boolean; applied: string[]; disabledCount: number; reason?: string | null }> =>
      ipcRenderer.invoke('plugins:enable', name),
    remove: (name: string): Promise<{ ok: boolean; busy?: boolean; error?: string }> =>
      ipcRenderer.invoke('plugins:remove', name),
    update: (name: string): Promise<{ ok: boolean; busy?: boolean; error?: string }> =>
      ipcRenderer.invoke('plugins:update', name),
    outdated: (): Promise<Record<string, string>> => ipcRenderer.invoke('plugins:outdated'),
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
    recheck: (): Promise<{ ok: boolean; busy?: boolean }> => ipcRenderer.invoke('dsh-setup:recheck'),
    // 源码安装路径（引导页「从源码运行」）：选目录 / 克隆 / 准备环境
    pickSourceDir: (): Promise<string | null> => ipcRenderer.invoke('dsh-backend:pick-dir'),
    cloneSource: (dir: string): Promise<{ ok: boolean; busy?: boolean; error?: string }> =>
      ipcRenderer.invoke('dsh-source:clone', dir),
    prepareSource: (dir: string): Promise<{ ok: boolean; busy?: boolean; error?: string }> =>
      ipcRenderer.invoke('dsh-source:prepare', dir),
    onSourceOutput: (cb: (t: string) => void): () => void => {
      const handler = (_event: unknown, t: string): void => cb(t)
      ipcRenderer.on('dsh-source:log', handler)
      return () => ipcRenderer.removeListener('dsh-source:log', handler)
    },
    onSourceExit: (cb: (code: number | null) => void): void => {
      ipcRenderer.on('dsh-source:exit', (_event, code: number | null) => cb(code))
    },
  },
  recovery: {
    getState: (): Promise<unknown> => ipcRenderer.invoke('recovery:get-state'),
    getTheme: (): Promise<{ preference: 'light' | 'dark' | 'system' | null }> =>
      ipcRenderer.invoke('recovery:get-theme'),
    exitRestart: (): Promise<{ ok: boolean; busy?: boolean; error?: string }> =>
      ipcRenderer.invoke('recovery:exit-restart'),
    openLogFile: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('recovery:open-log-file'),
    copyDiagnosis: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('recovery:copy-diagnosis'),
    open: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('recovery:open'),
    openUpdate: (target: string): Promise<{ ok: boolean; busy?: boolean; error?: string }> =>
      ipcRenderer.invoke('recovery:open-update', target),
  },
})
