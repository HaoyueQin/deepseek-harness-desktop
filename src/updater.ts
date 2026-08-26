/**
 * electron-updater 封装：检查发现（绝不自动下载）→ 用户手动「下载更新」→
 * 「安装更新」两段式。Windows 引导模式（退出后运行安装包）、Linux AppImage
 * 全自动替换运行文件。mac 不初始化。
 *
 * 检查与下载分离是刻意的：点「检查更新」只做发现；下载、安装的每个动作
 * 都由用户在设置页显式触发——不允许「检查完就一条龙自动更新」。
 */

import { app } from 'electron'
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
  /** 完成过一次检查（后台或手动）；false = 尚未检查，UI 不得显示「已是最新版本」。 */
  checked: boolean
  /** macOS 不支持自动更新（需签名）：与「无更新」区分，避免 UI 误导为最新版。 */
  unsupported?: boolean
  /** dev（未打包）模式：electron-updater 无更新上下文，自更新不可用。 */
  devMode?: boolean
}

let current: UpdateStatus = {
  current: app.getVersion(), latest: null, downloading: false, downloaded: false, checked: false,
}
const listeners: Array<(s: UpdateStatus) => void> = []
/** 最近一次下载完成时保留的安装信息（「安装更新」使用）。 */
let pendingInfo: UpdateInfo | null = null

function publishStatus(): void {
  for (const cb of listeners) cb({ ...current })
}

export function onUpdateStatus(cb: (s: UpdateStatus) => void): void {
  listeners.push(cb)
}

/** 退出壳后运行安装包（Windows 引导）。main.ts 注入「停止 dsh 并退出后 spawn 安装包」。 */
let runInstaller: ((info: UpdateInfo) => Promise<void>) | null = null

export function setRunInstaller(fn: (info: UpdateInfo) => Promise<void>): void {
  runInstaller = fn
}

export function initUpdater(): void {
  if (process.platform !== 'win32' && process.platform !== 'linux') return
  // dev（未打包）无更新上下文：不自启检查（避免无谓网络请求与错误日志噪音），
  // 手动检查仍走 checkForUpdates 的 devMode 分支返回提示。
  if (!app.isPackaged) return
  // 只发现不下载：下载由 downloadUpdate() 显式触发；autoInstallOnAppQuit 关闭
  // 与「用户点安装才生效」的语义一致（避免任何退出路径静默安装）。
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => {
    current.downloading = false
    current.downloaded = false
    publishStatus()
  })
  autoUpdater.on('update-available', (info) => {
    current.downloading = false
    current.downloaded = false
    current.latest = info.version
    current.checked = true
    publishStatus()
    log(`updater: 发现新版本 ${info.version}（等待用户下载）`)
  })
  autoUpdater.on('update-not-available', () => {
    current.checked = true
    publishStatus()
  })
  autoUpdater.on('update-downloaded', (info) => {
    pendingInfo = info
    current.downloading = false
    current.downloaded = true
    current.latest = info.version
    publishStatus()
    log(`updater: 已下载 ${info.version}（等待用户安装）`)
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
  if (!app.isPackaged) return { ...current, checked: true, devMode: true }
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    // macOS 无签名证书不支持自动更新：显式标记 unsupported，
    // 与「无更新」区分，UI 显示提示而非误导为最新版
    return { ...current, unsupported: true }
  }
  // 已下载完成/下载进行中：手动再查直接返回现状——下载中重查会让
  // checking-for-update 清掉 downloading，UI 回退成「下载更新」可重复触发
  if (current.downloaded || current.downloading) return { ...current }
  try {
    await autoUpdater.checkForUpdates()
    // 不设 checked 兜底：检查结果只信事件回调（available/not-available）——
    // 异常路径宁可显示「当前版本」也不误报「已是最新版本」
  } catch (err) {
    log(`updater: 手动检查失败 ${String(err)}`)
  }
  return { ...current }
}

/** 用户点击「下载更新」：开始下载已发现的新版本（幂等：下载中/已下载则直接返回）。 */
export async function downloadUpdate(): Promise<UpdateStatus> {
  if (current.latest === null || current.downloaded || current.downloading) return { ...current }
  current.downloading = true
  publishStatus()
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    current.downloading = false
    log(`updater: 下载失败 ${String(err)}`)
  }
  return { ...current }
}

/**
 * 用户点击「安装更新」：直接执行（无确认弹窗——用户已主动点击即明确意图）。
 * Windows：退出并运行安装包；Linux：quitAndInstall 替换运行文件。
 */
export async function installUpdate(): Promise<UpdateStatus> {
  if (!current.downloaded) return { ...current }
  if (process.platform === 'linux') {
    try {
      autoUpdater.quitAndInstall()
    } catch (err) {
      log(`updater: quitAndInstall 失败 ${String(err)}`)
      current.downloaded = false
      publishStatus()
    }
    return { ...current }
  }
  if (runInstaller !== null && pendingInfo !== null) {
    // quitApp 内含退出，进程即将结束
    await runInstaller(pendingInfo)
  }
  return { ...current }
}
