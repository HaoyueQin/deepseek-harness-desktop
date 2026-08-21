/**
 * electron-updater 封装：Windows 引导模式（下载后让用户运行安装包）、
 * Linux AppImage 全自动（quitAndInstall 替换运行文件）。mac 不初始化。
 *
 * 无签名约束：Windows 的 NSIS 无法静默安装（UAC/SmartScreen），故下载完成后
 * 弹窗引导用户运行安装包；Linux AppImage 无需签名，直接替换。
 */

import { app, BrowserWindow, dialog } from 'electron'
// autoUpdater 是 CJS getter 导出，ESM named import 无法静态识别——default 导入后解构
import electronUpdater from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import { log } from './log.js'

const { autoUpdater } = electronUpdater

export interface UpdateStatus {
  current: string
  latest: string | null
  downloading: boolean
  downloaded: boolean
  /** macOS 不支持自动更新（需签名）：与「无更新」区分，避免 UI 误导为最新版。 */
  unsupported?: boolean
  /** dev（未打包）模式：electron-updater 无更新上下文，自更新不可用。 */
  devMode?: boolean
}

let current: UpdateStatus = { current: app.getVersion(), latest: null, downloading: false, downloaded: false }
const listeners: Array<(s: UpdateStatus) => void> = []

function publishStatus(): void {
  for (const cb of listeners) cb({ ...current })
}

export function onUpdateStatus(cb: (s: UpdateStatus) => void): void {
  listeners.push(cb)
}

/** 退出壳后运行安装包（Windows 引导）。返回 true 表示已安排退出。 */
let runInstaller: ((info: UpdateInfo) => Promise<void>) | null = null

/** main.ts 注入「停止 dsh 并退出后 spawn 安装包」的实现（quitApp 逻辑在主进程）。 */
export function setRunInstaller(fn: (info: UpdateInfo) => Promise<void>): void {
  runInstaller = fn
}

async function promptRunInstaller(info: UpdateInfo): Promise<void> {
  if (runInstaller === null) {
    log('updater: 无安装包运行实现，跳过')
    return
  }
  // 绑定焦点窗口：窗口可能处于隐藏（托盘）状态，无父窗口的弹窗在部分
  // Windows 版本上不置顶，用户可能一直看不到
  const parent = BrowserWindow.getFocusedWindow() ?? undefined
  const opts: Electron.MessageBoxOptions = {
    type: 'info',
    title: '发现新版本',
    message: `DeepSeek Harness Desktop v${info.version} 已就绪。`,
    detail: '退出并运行安装程序完成更新？',
    buttons: ['稍后', '现在更新'],
    defaultId: 1,
    cancelId: 0,
  }
  const { response } = parent === undefined
    ? await dialog.showMessageBox(opts)
    : await dialog.showMessageBox(parent, opts)
  if (response !== 1) return
  await runInstaller(info)
}

export function initUpdater(): void {
  if (process.platform !== 'win32' && process.platform !== 'linux') return
  autoUpdater.autoDownload = true
  // 关闭退出时自动安装：electron-updater 默认 autoInstallOnAppQuit=true，
  // 下载完成后用户点「稍后」，任何一次退出都会触发静默 /S 安装，与 Windows
  // 引导模式（promptRunInstaller 显式确认）语义矛盾。Linux 全自动走显式
  // quitAndInstall()，不受影响。
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => {
    current.downloading = false
    current.downloaded = false
    publishStatus()
  })
  autoUpdater.on('update-available', (info) => {
    current.downloading = true
    current.latest = info.version
    publishStatus()
    log(`updater: 发现新版本 ${info.version}，开始下载`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    current.downloading = false
    current.downloaded = true
    current.latest = info.version
    publishStatus()
    log(`updater: 已下载 ${info.version}`)
    if (process.platform === 'linux') {
      // AppImage 全自动：替换运行文件；失败回退引导提示
      try {
        autoUpdater.quitAndInstall()
      } catch (err) {
        log(`updater: quitAndInstall 失败 ${String(err)}，回退引导`)
        void promptRunInstaller(info)
      }
      return
    }
    void promptRunInstaller(info) // Windows 引导
  })
  autoUpdater.on('error', (err) => {
    log(`updater: ${String(err)}`)
  })
  void autoUpdater.checkForUpdates().catch((err) => {
    log(`updater: 检查失败 ${String(err)}`)
  })
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  // dev（未打包）无更新上下文：electron-updater 会直接跳过检查，提前返回避免误导
  if (!app.isPackaged) return { ...current, devMode: true }
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    // macOS 无签名证书不支持自动更新：显式标记 unsupported，
    // 与「无更新」区分，UI 显示提示而非误导为最新版
    return { ...current, unsupported: true }
  }
  // 已在后台下载完成的更新：手动再查直接返回现状，避免重复下载同一安装包
  // （Windows 引导模式下点击"现在更新"才真正运行安装器）。
  if (current.downloaded) return { ...current }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    log(`updater: 手动检查失败 ${String(err)}`)
  }
  return { ...current }
}
