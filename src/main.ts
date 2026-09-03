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
import { dshHomeDir, iconPath, preloadPath, recoveryPagePath, resourcesDir } from './paths.js'
import {
  getLaunchMinimized, setLaunchMinimized, getPortPolicy, setPortPolicy,
  getBackendSource, setBackendSource, getSourceDir, setSourceDir,
  getNetworkProxy, setNetworkProxy, networkProxyEnv,
  type PortPolicy, type BackendSource,
} from './settings.js'
import { isAutostartEnabled, setAutostart } from './autostart.js'
import {
  initUpdater, checkForUpdates as runUpdateCheck, onUpdateStatus,
  downloadUpdate, installUpdate, setRunInstaller,
} from './updater.js'
import {
  checkBackendUpdate, initBackendUpdater,
  onBackendUpdateStatus, setBackendRestartHandler, updateBackend,
} from './dsh-updater.js'
import {
  checkSourceUpdate, initSourceUpdater, isSourceUpdating, onSourceUpdateStatus,
  setSourceLogSink, setSourceUpdateHooks, updateSource,
} from './dsh-source-updater.js'
import { locateDsh, type LocatedDsh } from './dsh-locator.js'
import { locateSourceDsh, validateSourceDir, OFFICIAL_REPO_URL } from './dsh-source.js'
import { enterRecovery, getRecoveryContext, clearRecoveryContext } from './recovery/state.js'
import { parseFailure, sanitizeLog } from './recovery/parse-failure.js'
// electron-updater 的 update-downloaded 事件带 downloadedFile（本地完整路径），
// UpdateInfo.path 只是 latest.yml 里的相对文件名，spawn 会 ENOENT。
import type { UpdateDownloadedEvent } from 'electron-updater'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { desktopPluginDir } from './paths.js'
import { log } from './log.js'
import { INJECT_TITLEBAR } from './titlebar.js'

let win: BrowserWindow | null = null
let dsh: DshControl | null = null
let quitting = false
/** 生效后端（npm 全局或 git 源码目录；纯壳架构：壳不内置运行时）。 */
let locatedDsh: LocatedDsh | null = null
/**
 * 后端来源回退提示（生效来源 ≠ 用户偏好来源时的原因说明）。经
 * dsh-app:get-info 拉取 + dsh-backend:notice 推送到达设置页提示条。
 */
let backendNotice: string | null = null
/** 本次会话实际监听端口（固定或随机，从 URL 行解析）；null = 尚未启动。 */
let dshPortActual: number | null = null
/** 本次是否因配置的固定端口被占而降级随机（页面 localStorage 侧设置本次不保留）。 */
let dshPortDegraded = false

/**
 * 组装恢复上下文：快照脱敏 + 解析诊断（handover §7.3 数据流）。
 * rawOutput 调用方保证来自 dsh.recentOutput()（或错误串）。
 */
function buildRecoveryContext(
  kind: 'crashed' | 'boot-failed' | 'maintenance',
  code: number | null,
  signal: string | null,
  rawOutput: string,
): void {
  const outputTail = sanitizeLog(rawOutput)
  enterRecovery({
    kind, code, signal, outputTail,
    diagnosis: parseFailure(outputTail),
    dshVersion: readDshVersion(),
    dshSource: locatedDsh?.source ?? null,
  })
}

/** 切到恢复页并确保窗口可见（可能正隐藏在托盘）。 */
async function showRecoveryPage(): Promise<void> {
  showWindow()
  await win?.loadFile(recoveryPagePath())
}

/**
 * 用户 dsh 版本（locateDsh 检测结果）。未检测到返回 'unknown'。
 */
function readDshVersion(): string {
  return locatedDsh?.version ?? 'unknown'
}

/** 推送回退提示到设置页提示条（插件也可经 get-info 拉取）。 */
function pushBackendNotice(): void {
  if (!quitting) win?.webContents.send('dsh-backend:notice', backendNotice)
}

/**
 * 解析生效后端：auto = npm 优先、源码兜底；显式选择优先，所选源失效时
 * 自动回退另一可用来源并生成原因（backendNotice）。两者皆不可用返回 null。
 * 校验只做纯 fs 检查（checkPnpm:false），不付 spawn 开销。
 */
function resolveBackend(): { located: LocatedDsh; notice?: string } | null {
  const npm = locateDsh()
  const pref = getBackendSource()
  const dir = getSourceDir()
  const srcCheck = dir !== '' ? validateSourceDir(dir) : null
  const src = dir !== '' ? locateSourceDsh(dir) : null

  if (pref === 'npm') {
    if (npm !== null) return { located: npm }
    if (src !== null) {
      return { located: src, notice: `未检测到 npm 全局 dsh，已回退到源码目录 ${dir}` }
    }
    return null
  }
  if (pref === 'source') {
    if (src !== null) return { located: src }
    if (npm !== null) {
      const reason = dir === ''
        ? '未配置源码目录'
        : `源码目录校验失败（${srcCheck?.missing.join('；') ?? '未知原因'}）`
      return { located: npm, notice: `${reason}，已回退到 npm 全局版 ${npm.version}` }
    }
    return null
  }
  // auto：npm 优先（稳定渠道），静默回退源码（设计内行为，不提示）
  if (npm !== null) return { located: npm }
  if (src !== null) return { located: src }
  return null
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
    // 拒绝非法值（对齐 set-launch-minimized 的拒绝+日志风格）；磁盘上的
    // 历史脏数据仍由 normalizePortPolicy 在读取侧兜底归一。
    const valid = v === 'random'
      || (typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535)
    if (!valid) {
      log(`ipc: dsh-settings:set-port-policy 收到非法参数 ${typeof v}: ${String(v)}`)
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
    // 后端来源（null = 尚未成功定位）：'npm-global' | 'git-local'
    backendSource: locatedDsh?.source ?? null,
    sourceDir: getSourceDir() || null,
    notice: backendNotice,
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
  // 两段式更新：下载/安装由设置页按钮显式触发（updater 内部绝不自动下载安装）
  ipcMain.handle('dsh-update:download', () => downloadUpdate())
  ipcMain.handle('dsh-update:install', () => installUpdate())
  // 后端（用户已装的 dsh）版本检测与升级：按生效来源分发到 npm / 源码更新器
  ipcMain.handle('dsh-backend:check', () => locatedDsh?.source === 'git-local' ? checkSourceUpdate() : checkBackendUpdate())
  ipcMain.handle('dsh-backend:update', () => {
    if (locatedDsh?.source === 'git-local') {
      if (sourceBusy) {
        return Promise.resolve({ current: '', latest: null, stage: 'error', error: '克隆/准备环境进行中，请稍候' })
      }
      return updateSource()
    }
    return updateBackend()
  })
  // 后端来源配置：读取（含源码目录校验结果）/保存/选目录/重启生效
  ipcMain.handle('dsh-backend:get-config', () => {
    const dir = getSourceDir()
    return {
      mode: getBackendSource(),
      sourceDir: dir,
      networkProxy: getNetworkProxy(),
      validation: dir === '' ? null : validateSourceDir(dir, { checkPnpm: true }),
    }
  })
  ipcMain.handle('dsh-backend:set-config', (_event, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null) return { ok: false, error: 'invalid' }
    const p = patch as { mode?: unknown; sourceDir?: unknown; networkProxy?: unknown }
    if (p.mode !== undefined) setBackendSource(p.mode)
    if (p.sourceDir !== undefined) setSourceDir(p.sourceDir)
    if (p.networkProxy !== undefined) setNetworkProxy(p.networkProxy)
    return { ok: true }
  })
  ipcMain.handle('dsh-backend:pick-dir', async () => {
    if (win === null) return null
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: '选择 dsh 源码目录' })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })
  // 任意目录的即时校验（设置页输入未保存路径时预检）
  ipcMain.handle('dsh-backend:validate', (_event, dir: unknown) => {
    if (typeof dir !== 'string' || dir.trim() === '') return null
    return validateSourceDir(dir, { checkPnpm: true })
  })
  // 重启后端（来源/版本变更后生效）；restartEffective 内部自带 stop+resolve
  let restarting = false
  ipcMain.handle('dsh-backend:restart', async () => {
    if (restarting || locatedDsh === null) return { ok: false, busy: restarting }
    restarting = true
    try {
      await restartEffectiveBackend()
      return { ok: true }
    } catch (err) {
      log(`dsh-backend:restart 失败 ${String(err)}`)
      return { ok: false, error: String(err) }
    } finally {
      restarting = false
    }
  })
}

/**
 * 源码来源 IPC：克隆官方仓库 / 准备环境（pnpm install + build）。
 * 实时输出走 dsh-source:log / dsh-source:exit（与源码更新器共用通道，
 * 由 setSourceLogSink 统一转发——两者不会同时运行，见 sourceBusy 互斥）。
 */
function registerSourceIpc(): void {
  ipcMain.handle('dsh-source:clone', (_event, dir: unknown) => {
    if (typeof dir !== 'string' || dir.trim() === '') return { ok: false, error: 'invalid' }
    if (sourceBusy || isSourceUpdating()) return { ok: false, busy: true }
    const target = dir.trim()
    if (existsSync(target) && readdirSync(target).length > 0) {
      return { ok: false, error: '目标目录非空，无法克隆到该位置' }
    }
    sourceBusy = true
    const proxy = getNetworkProxy()
    const globalArgs = proxy === '' ? [] : ['-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`]
    const push = (t: string): void => { if (!quitting) win?.webContents.send('dsh-source:log', t) }
    const child = spawn('git', ['clone', ...globalArgs, OFFICIAL_REPO_URL, target], { windowsHide: true })
    child.stdout?.on('data', (d: Buffer) => push(d.toString()))
    child.stderr?.on('data', (d: Buffer) => push(d.toString()))
    child.on('error', (err) => {
      sourceBusy = false
      push(`\r\n[shell] ✗ git 启动失败：${String(err)}（请确认已安装 git）\r\n`)
      if (!quitting) win?.webContents.send('dsh-source:exit', 1)
    })
    child.on('exit', (code) => {
      sourceBusy = false
      if (quitting) return
      if (code === 0) setSourceDir(target) // 克隆成功即记住目录，recheck 即可发现
      push(code === 0 ? '\r\n[shell] ✓ 克隆完成\r\n' : `\r\n[shell] ✗ 克隆失败（退出码 ${String(code)}）\r\n`)
      win?.webContents.send('dsh-source:exit', code)
    })
    return { ok: true }
  })
  ipcMain.handle('dsh-source:prepare', (_event, dir: unknown) => {
    if (typeof dir !== 'string' || dir.trim() === '') return { ok: false, error: 'invalid' }
    if (sourceBusy || isSourceUpdating()) return { ok: false, busy: true }
    const target = dir.trim()
    sourceBusy = true
    const push = (t: string): void => { if (!quitting) win?.webContents.send('dsh-source:log', t) }
    const env = { ...process.env, ...networkProxyEnv() }
    const isWin = process.platform === 'win32'
    // pnpm 是 .cmd shim，经 ComSpec /c 解析；参数为固定字面量
    const runPnpm = (args: string[]): ChildProcess => spawn(
      isWin ? process.env.ComSpec ?? 'cmd' : 'pnpm',
      isWin ? ['/d', '/s', '/c', ['pnpm', ...args].join(' ')] : args,
      { cwd: target, env, windowsHide: true },
    )
    const runStep = (args: string[], label: string, done: () => void): void => {
      push(`\r\n[shell] ${label}\r\n`)
      const child = runPnpm(args)
      child.stdout?.on('data', (d: Buffer) => push(d.toString()))
      child.stderr?.on('data', (d: Buffer) => push(d.toString()))
      child.on('error', (err: Error) => {
        sourceBusy = false
        push(`\r\n[shell] ✗ pnpm 启动失败：${String(err)}（请确认已安装 pnpm）\r\n`)
        if (!quitting) win?.webContents.send('dsh-source:exit', 1)
      })
      child.on('exit', (code: number | null) => {
        if (quitting) return
        if (code !== 0) {
          sourceBusy = false
          push(`\r\n[shell] ✗ ${label}失败（退出码 ${String(code)}）\r\n`)
          win?.webContents.send('dsh-source:exit', code)
          return
        }
        done()
      })
    }
    runStep(['install'], '正在安装依赖（pnpm install，可能需要数分钟）', () => {
      runStep(['build'], '正在构建（pnpm build：全部包 lib + 前端 dist）', () => {
        sourceBusy = false
        const v = validateSourceDir(target)
        if (!v.ok) {
          push(`\r\n[shell] ✗ 准备后校验仍失败：${v.missing.join('；')}\r\n`)
          win?.webContents.send('dsh-source:exit', 1)
          return
        }
        push(`\r\n[shell] ✓ 准备完成（dsh ${v.version}），点「重新检测」启动\r\n`)
        win?.webContents.send('dsh-source:exit', 0)
      })
    })
    return { ok: true }
  })
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
  hr { border: none; border-top: 1px solid #333; margin: 24px 0; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  .hint { font-size: 12px; color: #6b7686; }
  input { flex: 1; background: #111; border: 1px solid #333; border-radius: 6px;
          padding: 8px 10px; color: #e8e8e8; font-size: 13px; }
  .row { display: flex; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
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
  <hr>
  <h2>从源码运行（进阶）</h2>
  <p>不用 npm 全局安装，直接使用本地 dsh 源码仓库启动（需要 git 与 pnpm；克隆或构建可能需要代理，可在设置页配置）。</p>
  <div class="cmd"><input id="srcdir" placeholder="选择源码目录（将克隆/构建到这里）" readonly>
    <button class="ghost" onclick="pickDir()">选择目录</button></div>
  <div class="row">
    <button id="cloneBtn" onclick="cloneRepo()">克隆仓库</button>
    <button id="prepareBtn" class="ghost" onclick="prepareSrc()">准备环境</button>
    <button class="ghost" onclick="recheck()">重新检测</button>
  </div>
  <p class="hint">克隆仓库 = 从 GitHub 拉取 deepseek-harness 源码；准备环境 = pnpm install + pnpm build（可能需要数分钟）。已有源码目录可直接选择后点「准备环境」。</p>
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
  function srcDirValue() {
    const dir = document.getElementById('srcdir').value.trim()
    if (dir === '') { alert('请先选择源码目录'); return null }
    return dir
  }
  // 源码管线（克隆/准备环境）共享的日志与退出处理；返回 false = 已在跑
  let srcListening = false
  function srcBegin() {
    const log = document.getElementById('log'); log.style.display = 'block'
    document.getElementById('cloneBtn').disabled = true
    document.getElementById('prepareBtn').disabled = true
    if (!srcListening) {
      srcListening = true
      bridge().onSourceOutput((t) => { log.textContent += t; log.scrollTop = log.scrollHeight })
      bridge().onSourceExit((code) => {
        document.getElementById('cloneBtn').disabled = false
        document.getElementById('prepareBtn').disabled = false
        if (code !== 0) log.textContent += '\\n提示：可配置网络代理后重试，或手动完成对应步骤后点「重新检测」'
      })
    }
  }
  function pickDir() {
    window.dshDesktop.backend.pickDir().then((d) => {
      if (d !== null) document.getElementById('srcdir').value = d
    })
  }
  function cloneRepo() {
    const dir = srcDirValue(); if (dir === null) return
    srcBegin()
    bridge().cloneSource(dir).then((r) => {
      if (!r.ok) {
        alert(r.busy === true ? '已有源码任务在运行，请稍候' : r.error)
        document.getElementById('cloneBtn').disabled = false
        document.getElementById('prepareBtn').disabled = false
      }
    })
  }
  function prepareSrc() {
    const dir = srcDirValue(); if (dir === null) return
    srcBegin()
    bridge().prepareSource(dir).then((r) => {
      if (!r.ok) {
        alert(r.busy === true ? '已有源码任务在运行，请稍候' : r.error)
        document.getElementById('cloneBtn').disabled = false
        document.getElementById('prepareBtn').disabled = false
      }
    })
  }
  function recheck() {
    bridge().recheck().then((r) => {
      if (!r.ok) alert(r.busy === true ? '正在准备中，请等待完成后再检测' : '仍未检测到可用的 dsh。请确认安装成功后重试。')
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
/**
 * 单次 spawn 尝试。「意外退出」弹窗只在服务就绪后的崩溃时触发；启动期
 * 失败（dsh.url reject，如端口被抢注的 EADDRINUSE）交还调用方重试。
 */
function spawnDshAttempt(located: LocatedDsh, port: number | undefined): DshControl {
  dsh = startDsh({
    nodePath: 'node',
    dshBin: located.binJs,
    nodeArgs: located.nodeArgs,
    cwd: located.cwd,
    dshHome: dshHomeDir(),
    onLog: log,
    port,
  })
  let ready = false
  void dsh.url.then(() => { ready = true }, () => { /* 启动期失败由调用方处理 */ })
  dsh.exited.then(({ expected, code, signal }) => {
    log(`dsh 进程退出: expected=${expected} code=${String(code)} signal=${String(signal)}`)
    // 意外退出 → 恢复模式：不弹窗不退出，切壳原生恢复页（handover §7.2）
    if (!expected && !quitting && ready && dsh !== null) {
      buildRecoveryContext('crashed', code, signal, dsh.recentOutput())
      void showRecoveryPage()
    }
  })
  return dsh
}

async function startDshAndLoad(located: LocatedDsh): Promise<void> {
  const srcDesc = located.source === 'git-local' ? ` source-dir=${located.cwd}` : ''
  log(`spawn dsh: source=${located.source} node=node bin=${located.binJs}${srcDesc} version=${located.version} DSH_HOME=${dshHomeDir()}`)
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

  let attempt = spawnDshAttempt(located, port)
  let url: string
  try {
    url = await attempt.url
  } catch (err) {
    // 启动期失败：探测通过但 spawn 即退出（TOCTOU，端口恰在亚秒窗口内被抢注）
    // 或 HTTP 就绪探测超时。固定端口值得换随机重试一次；随机端口下重试同因
    // 无意义。重试前停掉可能仍存活的旧进程，防孤儿；再失败抛给调用方走
    // 「启动失败」路径。
    if (port === undefined || quitting) throw err
    log(`固定端口 ${port} 启动失败（${String(err)}），降级随机端口重试`)
    dshPortDegraded = true
    await attempt.stop()
    attempt = spawnDshAttempt(located, undefined)
    url = await attempt.url
  }
  log(`dsh 就绪: ${url}${dshPortDegraded ? '（降级随机）' : ''}`)
  const parsedPort = Number.parseInt(new URL(url).port, 10)
  dshPortActual = Number.isNaN(parsedPort) ? null : parsedPort
  if (!quitting) await win?.loadURL(url)
}

/**
 * 解析生效后端（npm 全局 / git 源码目录，按用户偏好与可用性）并启动。
 * @returns 'ok' 已启动；'not-found' 两个来源都不可用（调用方展示引导页）；'failed' 启动失败（已弹窗并退出）。
 */
async function bootWithLocatedDsh(): Promise<'ok' | 'not-found' | 'failed'> {
  const resolved = resolveBackend()
  locatedDsh = resolved?.located ?? null
  backendNotice = resolved?.notice ?? null
  if (locatedDsh === null) return 'not-found'
  // 两个更新器都按当前生效来源初始化；check/update 由 IPC 按来源分发
  initBackendUpdater(locatedDsh.version)
  if (locatedDsh.source === 'git-local' && locatedDsh.cwd !== undefined) {
    initSourceUpdater(locatedDsh.version, locatedDsh.cwd)
  }
  try {
    await startDshAndLoad(locatedDsh)
    pushBackendNotice() // 就绪后推送（提示条订阅可能晚于页面加载，get-info 亦可拉取）
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

/**
 * 停掉当前 dsh → 重新解析生效后端（版本/来源可能已变，如源码更新检出
 * 新 tag）→ 重启并重载窗口。npm 与源码两个更新器共用。
 */
async function restartEffectiveBackend(): Promise<void> {
  if (dsh !== null) { await dsh.stop(); dsh = null }
  if (quitting) return
  const resolved = resolveBackend()
  if (resolved === null) throw new Error('重启后无法定位可用的 dsh 后端')
  locatedDsh = resolved.located
  backendNotice = resolved.notice ?? null
  if (locatedDsh.source === 'git-local' && locatedDsh.cwd !== undefined) {
    initSourceUpdater(locatedDsh.version, locatedDsh.cwd)
  } else {
    initBackendUpdater(locatedDsh.version)
  }
  win?.webContents.send('dsh-backend:update-status', { stage: 'restarting', message: '正在重启后端…' })
  await startDshAndLoad(locatedDsh)
  pushBackendNotice()
}

/**
 * 恢复模式 IPC：get-state 供恢复页渲染；exit-restart 清上下文并走
 * 统一重启（restartEffectiveBackend 会 loadURL 回 dsh 页面）；重启失败
 * 重新进入 boot-failed 上下文，页面留在恢复页刷新状态。
 */
function registerRecoveryIpc(): void {
  let restarting = false
  ipcMain.handle('recovery:get-state', () => getRecoveryContext())
  ipcMain.handle('recovery:exit-restart', async () => {
    if (restarting) return { ok: false, busy: true }
    restarting = true
    clearRecoveryContext()
    try {
      await restartEffectiveBackend()
      return { ok: true }
    } catch (err) {
      log(`recovery:exit-restart 失败 ${String(err)}`)
      buildRecoveryContext('boot-failed', null, null, String(err))
      return { ok: false, error: String(err) }
    } finally {
      restarting = false
    }
  })
  ipcMain.handle('recovery:open-log-file', async () => {
    const err = await shell.openPath(join(app.getPath('userData'), 'logs'))
    return err === '' ? { ok: true } : { ok: false, error: err }
  })
  ipcMain.handle('recovery:copy-diagnosis', () => {
    const c = getRecoveryContext()
    if (c === null) return { ok: false, error: 'no context' }
    clipboard.writeText(JSON.stringify(c, null, 2))
    return { ok: true }
  })
}

/** 引导安装 IPC：复制命令 / 壳内一键安装 / 重新检测。 */
let setupInstalling = false // 安装进行中标志：挡住并发 install 与半安装态的 recheck
let sourceBusy = false // 克隆/准备/更新管线共享互斥：同一时间只允许一个在跑

function registerSetupIpc(): void {
  ipcMain.handle('dsh-setup:copy-command', () => {
    clipboard.writeText('npm i -g @deepseek-ai/dsh')
    return true
  })
  ipcMain.handle('dsh-setup:install', () => {
    if (setupInstalling) return true // 幂等：已在安装中
    setupInstalling = true
    // 参数全部固定字面量；Windows 经 ComSpec /c 解析 .cmd shim（shell:true+args 数组在 Node≥22 触发 DEP0190）
    // 代理经环境变量注入（与 pnpm/git 侧同一设置）
    const isWin = process.platform === 'win32'
    const child = spawn(isWin ? process.env.ComSpec ?? 'cmd' : 'npm',
      isWin ? ['/d', '/s', '/c', 'npm i -g @deepseek-ai/dsh'] : ['i', '-g', '@deepseek-ai/dsh'], {
        env: { ...process.env, ...networkProxyEnv() },
        windowsHide: true,
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
    // 安装/构建进行中产物可能半落盘，此时启动必然失败——拒绝并提示稍候
    if (setupInstalling || sourceBusy) return { ok: false, busy: true }
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
    registerSourceIpc()
    registerRecoveryIpc()
    const trayHandlers: TrayHandlers = { show: showWindow, quit: () => void quitApp() }
    createTray(iconPath(), trayHandlers)

    // 启动 15s 后静默检查更新（网络慢/失败静默，仅写日志）
    setTimeout(() => initUpdater(), 15_000)

    createWindow()
    await win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`)
    if (quitting) return

    // npm 与源码两个后端更新器的状态合流到同一推送通道（同一时刻只有一个
    // 生效来源在跑，不会互相覆盖）
    onBackendUpdateStatus((s) => { win?.webContents.send('dsh-backend:update-status', s) })
    onSourceUpdateStatus((s) => { win?.webContents.send('dsh-backend:update-status', s) })
    // 桌壳更新状态实时推给设置页（两段式 UI：发现新版/下载中/可安装；后台
    // 15s 自动检查发现的版本同样经此到达页面，但下载始终由用户按钮触发）
    onUpdateStatus((s) => { win?.webContents.send('dsh-update:status', s) })
    // 源码管线的实时日志（下载更新/克隆/准备环境共用）转发给设置页日志区
    setSourceLogSink((line) => { if (!quitting) win?.webContents.send('dsh-source:log', line) })
    setSourceUpdateHooks({
      restartBackend: restartEffectiveBackend,
      stopBackend: async () => { if (dsh !== null) { await dsh.stop(); dsh = null } },
    })
    // 统一重启：重新解析生效后端（npm 升级换版本 / 源码更新换检出后都适用）
    setBackendRestartHandler(restartEffectiveBackend)

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
