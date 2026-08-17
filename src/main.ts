/**
 * Electron 主进程入口：单实例锁 → 托盘 + 窗口 → spawn dsh web → 就绪后
 * 加载 localhost。关闭窗口隐藏到托盘；托盘退出才停止 dsh 并 quit。
 *
 * 安全边界：dsh 仅监听 127.0.0.1（--host 0.0.0.0 被 dsh 拒绝），URL 来自
 * 自家子进程 stdout 解析，无外部输入进入 webPreferences。
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { startDsh, type DshControl } from './dsh/spawn.js'
import { createTray, syncTrayAutostart, type TrayHandlers } from './tray.js'
import { dshBinScript, dshHomeDir, iconPath, nodeExecutable, preloadPath } from './paths.js'
import { getLaunchMinimized, setLaunchMinimized } from './settings.js'
import { isAutostartEnabled, setAutostart } from './autostart.js'
import { initUpdater, checkForUpdates as runUpdateCheck, setRunInstaller } from './updater.js'
import { join } from 'node:path'
import { copyFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { desktopPluginDir } from './paths.js'
import { log } from './log.js'
import { INJECT_TITLEBAR } from './titlebar.js'

let win: BrowserWindow | null = null
let dsh: DshControl | null = null
let quitting = false

// 网页级窗口控制（win/linux frameless 用）：preload 注入的控制条经 IPC 调用。
function registerWindowControls(): void {
  ipcMain.handle('dsh-window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.handle('dsh-window:maximize-toggle', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender)
    if (w === null) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.handle('dsh-window:close', (event) => {
    // 关闭 = 隐藏到托盘（与窗口 X 行为一致）；退出走托盘菜单
    BrowserWindow.fromWebContents(event.sender)?.hide()
  })
}

// 桌面集成 IPC（设置页「桌面」分区插件经 preload 桥调用）
function registerAppIpc(): void {
  ipcMain.handle('dsh-app:get-autostart', () => isAutostartEnabled())
  ipcMain.handle('dsh-app:set-autostart', (_event, enabled: boolean) => {
    setAutostart(enabled)
    syncTrayAutostart() // 托盘菜单勾选同步（设置页↔托盘双向一致）
  })
  ipcMain.handle('dsh-settings:get-launch-minimized', () => getLaunchMinimized())
  ipcMain.handle('dsh-settings:set-launch-minimized', (_event, enabled: boolean) => setLaunchMinimized(enabled))
  ipcMain.handle('dsh-app:get-info', () => ({
    appVersion: app.getVersion(),
    dshHome: dshHomeDir(),
    logDir: join(app.getPath('userData'), 'logs'),
  }))
  ipcMain.handle('dsh-app:open-path', async (_event, p: unknown) => {
    // 白名单：只允许打开 DSH_HOME 或日志目录
    const allowed = [dshHomeDir(), join(app.getPath('userData'), 'logs')]
    if (typeof p !== 'string' || !allowed.includes(p)) return { ok: false, error: 'forbidden' }
    const err = await shell.openPath(p)
    return err === '' ? { ok: true } : { ok: false, error: err }
  })
  // checkForUpdates 接 electron-updater 真实实现（win/linux；mac 返回 current）
  ipcMain.handle('dsh-update:check', () => runUpdateCheck())
}

const LOADING_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DeepSeek Harness</title>
<style>
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #1a1a1a; color: #e8e8e8; font: 14px/1.6 system-ui, sans-serif; }
  .box { text-align: center; }
  .spinner { width: 28px; height: 28px; margin: 0 auto 16px; border: 3px solid #333;
             border-top-color: #4d9fff; border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head>
<body><div class="box"><div class="spinner"></div>正在启动 DeepSeek Harness…</div></body></html>`

function showWindow(): void {
  if (win === null) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * 同步桌面集成插件到 dsh 的扁平回退目录（$DSH_HOME/profiles/node_modules/，
 * 由 healProfilesModuleFallback 维护），使 --patch 的 name 可被 profile 解析。
 * 幂等：每次 spawn 前同步，失败仅告警不阻断。
 */
function ensureDesktopPlugin(dshHome: string): void {
  const src = desktopPluginDir()
  const target = join(dshHome, 'profiles', 'node_modules', 'dsh-desktop-integration')
  try {
    mkdirSync(join(target, 'lib'), { recursive: true })
    copyFileSync(join(src, 'package.json'), join(target, 'package.json'))
    copyFileSync(join(src, 'lib', 'index.js'), join(target, 'lib', 'index.js'))
    copyFileSync(join(src, 'lib', 'client.js'), join(target, 'lib', 'client.js'))
    log('desktop-plugin: 已同步到 ' + target)
  } catch (err) {
    log(`desktop-plugin: 同步失败 ${String(err)}`)
  }
}

/**
 * 标题栏注入：见 titlebar.ts（独立 26px 标题栏 + 页面主体下移，不遮挡
 * dsh 头部任何按钮；明暗主题跟随 dsh token）。
 */

function injectTitlebar(): void {
  win?.webContents.on('console-message', (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
    log(`[page:${details.level}] ${details.message}`)
  })
  win?.webContents.on('dom-ready', () => {
    win?.webContents.executeJavaScript(INJECT_TITLEBAR)
      .then(() => log('inject: 标题栏注入完成'))
      .catch((err: Error) => log(`inject: 注入失败 ${String(err)}`))
  })
}

function createWindow(): void {
  // 无原生标题栏：win 用纯 frameless（hidden），mac 用 hiddenInset（保留红绿灯），
  // linux frame:false。窗口控制条由 preload 注入为网页元素（透明背景、品牌蓝
  // hover、随明暗主题），与 dsh 界面完全融合；拖拽靠注入的顶部透明拖拽条。
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath(),
    },
  }
  if (process.platform === 'win32') {
    windowOptions.titleBarStyle = 'hidden'
  } else if (process.platform === 'darwin') {
    windowOptions.titleBarStyle = 'hiddenInset'
  } else {
    windowOptions.frame = false
  }
  win = new BrowserWindow(windowOptions)
  // 最大化状态推送给渲染进程（控制条切换 恢复/最大化 图标）
  const sendMaximized = (): void => { win?.webContents.send('dsh-window:maximized', win?.isMaximized()) }
  win.on('maximize', sendMaximized)
  win.on('unmaximize', sendMaximized)
  win.once('ready-to-show', () => { if (!getLaunchMinimized()) win?.show() })
  injectTitlebar()
  // 关闭 = 隐藏到托盘；quitting 时放行
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => { win = null })
}

async function quitApp(): Promise<void> {
  quitting = true
  if (dsh !== null) await dsh.stop()
  app.quit()
}

// updater 需要「退出后运行安装包」——复用 quitApp 的停止逻辑，quit 后 spawn 安装包
setRunInstaller(async (info) => {
  const installerPath = (info as { path?: string }).path
  if (installerPath === undefined || installerPath === '') {
    log(`updater: 安装包路径缺失（${info.version}），请手动从 Release 下载`)
    return
  }
  log(`updater: 退出并运行安装包 ${installerPath}`)
  await quitApp()
  spawn(installerPath, [], { detached: true, stdio: 'ignore' }).unref()
})

function main(): void {
  app.on('second-instance', () => showWindow())

  void app.whenReady().then(async () => {
    // 去掉 File/Edit/View/Window 菜单栏（mac 上连同编辑快捷键一起移除，V1 可接受）
    Menu.setApplicationMenu(null)
    registerWindowControls()
    registerAppIpc()
    const trayHandlers: TrayHandlers = { show: showWindow, quit: () => void quitApp() }
    createTray(iconPath(), trayHandlers)

    // 启动 15s 后静默检查更新（网络慢/失败静默，仅写日志）
    setTimeout(() => initUpdater(), 15_000)

    createWindow()
    await win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`)
    if (quitting) return

    log(`spawn dsh: node=${nodeExecutable()} bin=${dshBinScript()} DSH_HOME=${dshHomeDir()}`)
    ensureDesktopPlugin(dshHomeDir())
    dsh = startDsh({
      nodePath: nodeExecutable(),
      dshBin: dshBinScript(),
      dshHome: dshHomeDir(),
      onLog: log,
    })

    dsh.exited.then(({ expected, code, signal }) => {
      log(`dsh 进程退出: expected=${expected} code=${String(code)} signal=${String(signal)}`)
      if (!expected && !quitting) {
        void dialog.showMessageBox({
          type: 'error',
          title: 'DeepSeek Harness 意外退出',
          message: `后端进程意外退出（code=${String(code)}）。`,
          buttons: ['退出'],
        }).then(() => app.quit())
      }
    })

    try {
      const url = await dsh.url
      log(`dsh 就绪: ${url}`)
      if (!quitting) await win?.loadURL(url)
    } catch (err) {
      log(`dsh 启动失败: ${String(err)}`)
      if (!quitting) {
        await dialog.showErrorBox('DeepSeek Harness 启动失败', String(err))
        app.quit()
      }
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  main()
}
