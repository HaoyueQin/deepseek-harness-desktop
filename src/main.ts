/**
 * Electron 主进程入口：单实例锁 → 托盘 + 窗口 → spawn dsh web → 就绪后
 * 加载 localhost。关闭窗口隐藏到托盘；托盘退出才停止 dsh 并 quit。
 *
 * 安全边界：dsh 仅监听 127.0.0.1（--host 0.0.0.0 被 dsh 拒绝），URL 来自
 * 自家子进程 stdout 解析，无外部输入进入 webPreferences。
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import { startDsh, isTcpPortFree, type DshControl } from './dsh/spawn.js'
import { createTray, syncTrayAutostart, type TrayHandlers } from './tray.js'
import { dshHomeDir, iconPath, preloadPath, resourcesDir } from './paths.js'
import {
  getLaunchMinimized, setLaunchMinimized, getPortPolicy, setPortPolicy,
  type PortPolicy,
} from './settings.js'
import { isAutostartEnabled, setAutostart } from './autostart.js'
import { initUpdater, checkForUpdates as runUpdateCheck, setRunInstaller } from './updater.js'
import {
  checkBackendUpdate, initBackendUpdater,
  onBackendUpdateStatus, setBackendRestartHandler, updateBackend,
} from './dsh-updater.js'
import { locateDsh, compareVersions, type LocatedDsh } from './dsh-locator.js'
// electron-updater 的 update-downloaded 事件带 downloadedFile（本地完整路径），
// UpdateInfo.path 只是 latest.yml 里的相对文件名，spawn 会 ENOENT。
import type { UpdateDownloadedEvent } from 'electron-updater'
import { join } from 'node:path'
import { copyFileSync, mkdirSync, renameSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { desktopPluginDir } from './paths.js'
import { log } from './log.js'
import { INJECT_TITLEBAR } from './titlebar.js'

let win: BrowserWindow | null = null
let dsh: DshControl | null = null
let quitting = false
/** 用户已装的 dsh（纯壳架构：壳不内置运行时，spawn 用户 PATH 里的 CLI）。 */
let locatedDsh: LocatedDsh | null = null
/** 本次会话实际监听端口（固定或随机，从 URL 行解析）；null = 尚未启动。 */
let dshPortActual: number | null = null
/** 本次是否因配置的固定端口被占而降级随机（页面 localStorage 侧设置本次不保留）。 */
let dshPortDegraded = false

/**
 * 用户 dsh 版本（locateDsh 检测结果）。未检测到返回 'unknown'。
 */
function readDshVersion(): string {
  return locatedDsh?.version ?? 'unknown'
}

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
  ipcMain.handle('dsh-app:set-autostart', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      log(`ipc: dsh-app:set-autostart 收到非法参数 ${typeof enabled}`)
      return
    }
    setAutostart(enabled)
    syncTrayAutostart() // 托盘菜单勾选同步（设置页↔托盘双向一致）
  })
  ipcMain.handle('dsh-settings:get-launch-minimized', () => getLaunchMinimized())
  ipcMain.handle('dsh-settings:set-launch-minimized', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      log(`ipc: dsh-settings:set-launch-minimized 收到非法参数 ${typeof enabled}`)
      return
    }
    setLaunchMinimized(enabled)
  })
  // 端口策略：configured 为配置值（重启后生效），actual/degraded 为本次运行状态
  ipcMain.handle('dsh-settings:get-port-policy', (): { configured: PortPolicy; actual: number | null; degraded: boolean } => ({
    configured: getPortPolicy(),
    actual: dshPortActual,
    degraded: dshPortDegraded,
  }))
  ipcMain.handle('dsh-settings:set-port-policy', (_event, v: unknown) => {
    if (typeof v !== 'number' && typeof v !== 'string') {
      log(`ipc: dsh-settings:set-port-policy 收到非法参数 ${typeof v}`)
      return
    }
    setPortPolicy(v)
  })
  ipcMain.handle('dsh-app:get-info', () => ({
    // dev 下带 -dev 后缀，与打包版一眼区分
    appVersion: app.isPackaged ? app.getVersion() : app.getVersion() + '-dev',
    dshVersion: readDshVersion(),
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
  // 后端（用户已装的 dsh CLI）版本检测与一键升级
  ipcMain.handle('dsh-backend:check', () => checkBackendUpdate())
  ipcMain.handle('dsh-backend:update', () => updateBackend())
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

/** 引导安装页：未检测到用户 dsh 时展示（纯壳架构，壳复用用户已装的 CLI）。 */
const SETUP_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>需要安装 DeepSeek Harness CLI</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #1a1a1a; color: #e8e8e8; font: 14px/1.7 system-ui, sans-serif; }
  .box { max-width: 560px; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { color: #aab3c0; margin: 8px 0; }
  .cmd { display: flex; gap: 8px; align-items: center; background: #111;
         border: 1px solid #333; border-radius: 8px; padding: 10px 14px; margin: 16px 0; }
  code { color: #4d9fff; font-family: Consolas, monospace; flex: 1; }
  button { border: none; border-radius: 6px; padding: 8px 16px; cursor: pointer;
           font-size: 13px; background: #4176E6; color: #fff; }
  button.ghost { background: transparent; border: 1px solid #444; color: #e8e8e8; }
  button:disabled { opacity: .5; cursor: default; }
  pre { background: #111; border: 1px solid #333; border-radius: 8px; padding: 12px;
        max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
        font-size: 12px; color: #9aa4b2; display: none; text-align: left; }
</style></head>
<body><div class="box">
  <h1>未检测到 DeepSeek Harness CLI（dsh）</h1>
  <p>桌面壳直接复用你已安装的 dsh 命令行工具——插件、设置、会话与终端完全共享。</p>
  <p>请先安装 dsh（需要 Node.js ≥ 22）：</p>
  <div class="cmd"><code id="cmd">npm i -g @deepseek-ai/dsh</code>
    <button class="ghost" onclick="copyCmd(this)">复制</button></div>
  <button id="installBtn" onclick="install()">一键安装</button>
  <button class="ghost" onclick="recheck()">我已安装，重新检测</button>
  <pre id="log"></pre>
</div>
<script>
  function bridge() { return window.dshDesktop && window.dshDesktop.setup }
  function copyCmd(btn) {
    bridge().copyCommand().then(() => {
      btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制' }, 1500)
    })
  }
  function install() {
    document.getElementById('installBtn').disabled = true
    const log = document.getElementById('log'); log.style.display = 'block'
    bridge().onOutput((t) => { log.textContent += t; log.scrollTop = log.scrollHeight })
    bridge().onExit((code) => {
      if (code === 0) log.textContent += '\\n✓ 安装完成，正在启动…'
      else {
        log.textContent += '\\n✗ 安装失败（退出码 ' + code + '）。请检查网络后重试，或手动安装后点「重新检测」'
        document.getElementById('installBtn').disabled = false
      }
    })
    bridge().install()
  }
  function recheck() {
    bridge().recheck().then((r) => {
      if (!r.ok) alert('仍未检测到可用的 dsh。请确认安装成功后重试。')
    })
  }
</script></body></html>`

function showWindow(): void {
  if (win === null) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * spawn dsh 后端并等待就绪后加载到窗口。供启动、引导安装完成与后端
 * 一键升级后的重启共用。调用方负责 try/catch（失败时停掉 dsh 防孤儿进程）。
 */
async function startDshAndLoad(located: LocatedDsh): Promise<void> {
  // --no-open 仅 dsh ≥0.1.0-rc.8 认识；低版本省略（退化为可能弹一次浏览器）
  const noOpen = compareVersions(located.version, '0.1.0-rc.8') >= 0
  log(`spawn dsh: node=node bin=${located.binJs} version=${located.version} noOpen=${noOpen} DSH_HOME=${dshHomeDir()}`)
  // 端口策略：固定端口空闲则用（origin 稳定，localStorage 侧设置跨重启保留）；
  // 被占/策略为随机则 --port 0 降级，避免 dsh EADDRINUSE 硬失败退出。
  const policy = getPortPolicy()
  let port: number | undefined
  if (policy !== 'random' && await isTcpPortFree(policy)) port = policy
  dshPortDegraded = policy !== 'random' && port === undefined
  if (dshPortDegraded) {
    log(`端口 ${policy} 被占用，本次降级随机端口（页面侧设置本次不保留）`)
  }
  ensureDesktopPlugin(dshHomeDir())
  dsh = startDsh({
    nodePath: 'node',
    dshBin: located.binJs,
    dshHome: dshHomeDir(),
    onLog: log,
    noOpen,
    port,
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

  const url = await dsh.url
  log(`dsh 就绪: ${url}${dshPortDegraded ? '（降级随机）' : ''}`)
  const parsedPort = Number.parseInt(new URL(url).port, 10)
  dshPortActual = Number.isNaN(parsedPort) ? null : parsedPort
  if (!quitting) await win?.loadURL(url)
}

/**
 * 检测用户 dsh 并启动后端。
 * @returns 'ok' 已启动；'not-found' 未检测到 dsh（调用方展示引导页）；'failed' 启动失败（已弹窗并退出）。
 */
async function bootWithLocatedDsh(): Promise<'ok' | 'not-found' | 'failed'> {
  locatedDsh = locateDsh()
  if (locatedDsh === null) return 'not-found'
  initBackendUpdater(locatedDsh.version)
  try {
    await startDshAndLoad(locatedDsh)
    return 'ok'
  } catch (err) {
    log(`dsh 启动失败: ${String(err)}`)
    if (!quitting) {
      // 失败时 dsh 可能已监听端口（仅 HTTP 探测失败），先停掉再退出，
      // 防止 dsh 变孤儿进程常驻后台、占用 DSH_HOME 文件锁
      if (dsh !== null) await dsh.stop()
      await dialog.showErrorBox('DeepSeek Harness 启动失败', String(err))
      app.quit()
    }
    return 'failed'
  }
}

/** 引导安装 IPC：复制命令 / 壳内一键安装 / 重新检测。 */
let setupInstalling = false // 安装进行中标志：挡住并发 install 与半安装态的 recheck

function registerSetupIpc(): void {
  ipcMain.handle('dsh-setup:copy-command', () => {
    clipboard.writeText('npm i -g @deepseek-ai/dsh')
    return true
  })
  ipcMain.handle('dsh-setup:install', () => {
    if (setupInstalling) return true // 幂等：已在安装中
    setupInstalling = true
    const child = spawn('npm', ['i', '-g', '@deepseek-ai/dsh'], {
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    const push = (t: string): void => { if (!quitting) win?.webContents.send('dsh-setup:install-output', t) }
    child.stdout?.on('data', (d: Buffer) => push(d.toString()))
    child.stderr?.on('data', (d: Buffer) => push(d.toString()))
    child.on('exit', async (code) => {
      setupInstalling = false
      if (quitting) return
      win?.webContents.send('dsh-setup:install-exit', code)
      if (code === 0) {
        // 装完自动重新检测并进入；仍找不到时让用户手动「重新检测」排查
        const r = await bootWithLocatedDsh()
        if (r === 'not-found') {
          push('\r\n[shell] 安装已完成但未检测到 dsh，请点「我已安装，重新检测」重试\r\n')
        }
      }
    })
    return true
  })
  ipcMain.handle('dsh-setup:recheck', async () => {
    // 安装进行中 bin.js 可能已落盘但依赖树不完整，此时启动必然失败——拒绝并提示稍候
    if (setupInstalling) return { ok: false, busy: true }
    return { ok: await bootWithLocatedDsh() === 'ok' }
  })
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
    // 原子写：先落临时名再 rename，避免 dsh 恰好在写入中途读到半截
    // bundle（表现为页面端 React #130 渲染崩溃）。
    const files: Array<[string, string]> = [
      ['package.json', join('package.json')],
      ['lib/index.js', join('lib', 'index.js')],
      ['lib/client.js', join('lib', 'client.js')],
    ]
    for (const [rel, dest] of files) {
      const tmp = join(target, rel + '.tmp')
      copyFileSync(join(src, rel), tmp)
      renameSync(tmp, join(target, dest))
    }
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
    // 只记录 error：页面 console 可能包含请求内容/API 密钥，全量落盘是敏感数据风险
    if (details.level === 'error') log(`[page:${details.level}] ${details.message}`)
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
  // 用 downloadedFile（本地完整路径）而非 path（latest.yml 相对文件名）：
  // 相对文件名在任意 cwd 下 spawn 都会 ENOENT，安装器永远启动不了。
  const installerPath = (info as UpdateDownloadedEvent).downloadedFile
  if (installerPath === undefined || installerPath === '') {
    log(`updater: 安装包路径缺失（${info.version}），请手动从 Release 下载`)
    return
  }
  log(`updater: 退出并运行安装包 ${installerPath}`)
  await quitApp()
  try {
    spawn(installerPath, [], { detached: true, stdio: 'ignore' }).unref()
  } catch (err) {
    log(`updater: 启动安装包失败 ${String(err)}`)
  }
})

function main(): void {
  app.on('second-instance', () => showWindow())

  // Windows 任务栏/通知归属：缺省会退化到 electron.exe 图标分组（AppUserModelId
  // 须与 electron-builder 的 appId 一致，非 win32 为 no-op）
  if (process.platform === 'win32') {
    app.setAppUserModelId('io.github.haoyueqin.deepseek-harness-desktop')
  }

  // 全局限流（覆盖未来新建的任何 webContents）：
  //  - window.open 一律 deny（单一主窗模型），外部 http(s) 交给系统浏览器
  //  - 导航只允许留在当前 origin（dsh 页面路由），其余 http(s) 走系统浏览器
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const proto = new URL(url).protocol
        if (proto === 'http:' || proto === 'https:') void shell.openExternal(url)
      } catch {
        /* 非 URL，忽略 */
      }
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      try {
        const current = new URL(contents.getURL())
        if (new URL(url).origin === current.origin) return // 同源路由放行
      } catch {
        /* 解析失败按外部导航处理 */
      }
      event.preventDefault()
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    })
  })

  void app.whenReady().then(async () => {
    // 菜单栏：win/linux 移除；mac 保留最小菜单（File/Edit 全移除会连标准
    // 编辑快捷键 Cmd+C/V/X/A 一起失效）
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]))
    } else {
      Menu.setApplicationMenu(null)
    }
    registerWindowControls()
    registerAppIpc()
    registerSetupIpc()
    const trayHandlers: TrayHandlers = { show: showWindow, quit: () => void quitApp() }
    createTray(iconPath(), trayHandlers)

    // 启动 15s 后静默检查更新（网络慢/失败静默，仅写日志）
    setTimeout(() => initUpdater(), 15_000)

    createWindow()
    await win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`)
    if (quitting) return

    onBackendUpdateStatus((s) => { win?.webContents.send('dsh-backend:update-status', s) })
    setBackendRestartHandler(async () => {
      // 停旧 dsh → 重启 → 窗口重载
      if (dsh !== null) { await dsh.stop(); dsh = null }
      if (!quitting && locatedDsh !== null) {
        win?.webContents.send('dsh-backend:update-status', { stage: 'restarting', message: '正在重启后端…' })
        await startDshAndLoad(locatedDsh)
      }
    })

    const booted = await bootWithLocatedDsh()
    if (booted === 'not-found') {
      // 未装 dsh：展示引导安装页，后续由 setup IPC 驱动进入
      if (!quitting) {
        showWindow()
        await win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SETUP_HTML)}`)
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
