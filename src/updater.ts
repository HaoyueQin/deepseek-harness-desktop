/**
 * electron-updater 封装：Windows 引导模式（下载后让用户运行安装包）、
 * Linux AppImage 全自动（quitAndInstall 替换运行文件）。mac 不初始化。
 *
 * 无签名约束：Windows 的 NSIS 无法静默安装（UAC/SmartScreen），故下载完成后
 * 弹窗引导用户运行安装包；Linux AppImage 无需签名，直接替换。
 */

import { app, dialog } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { log } from './log.js'

export interface UpdateStatus {
  current: string
  latest: string | null
  downloading: boolean
  downloaded: boolean
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
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: '发现新版本',
    message: `DeepSeek Harness Desktop v${info.version} 已就绪。`,
    detail: '退出并运行安装程序完成更新？',
    buttons: ['稍后', '现在更新'],
    defaultId: 1,
    cancelId: 0,
  })
  if (response !== 1) return
  await runInstaller(info)
}

export function initUpdater(): void {
  if (process.platform !== 'win32' && process.platform !== 'linux') return
  autoUpdater.autoDownload = true
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
  if (process.platform !== 'win32' && process.platform !== 'linux') return current
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    log(`updater: 手动检查失败 ${String(err)}`)
  }
  return { ...current }
}
