/**
 * 临时诊断：rc.2 页面上 legacy 宽度手柄的真实 DOM 状态。
 * 干净 temp DSH_HOME + 同步插件 + spawn rc.2 web + 无头 Electron 读页面状态。
 * 用法：node scripts/diag-legacy-width.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RESOURCES = join(ROOT, 'resources')

function runShim(cmd) {
  const isWin = process.platform === 'win32'
  return spawnSync(isWin ? process.env.ComSpec ?? 'cmd' : cmd.split(' ')[0],
    isWin ? ['/d', '/s', '/c', cmd] : cmd.split(' ').slice(1),
    { encoding: 'utf8', windowsHide: true })
}

// 1. 定位 npm 全局 rc.2（与 smoke 同逻辑）
const ver = runShim('dsh --version')
if (ver.status !== 0) throw new Error('未检测到 dsh')
console.log('diag: npm dsh version =', ver.stdout.trim())
const rootDir = runShim('npm root -g')
const binJs = join(rootDir.stdout.trim(), '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(binJs)) throw new Error('未找到 ' + binJs)

// 2. 干净 temp DSH_HOME + 同步桌面插件（模拟 ensureDesktopPlugin）
const home = mkdtempSync(join(tmpdir(), 'dsh-diag-'))
const pluginDir = join(home, 'profiles', 'node_modules', 'dsh-desktop-integration')
mkdirSync(join(pluginDir, 'lib'), { recursive: true })
for (const rel of ['package.json', join('lib', 'index.js'), join('lib', 'client.js')]) {
  copyFileSync(join(RESOURCES, 'desktop-integration', rel), join(pluginDir, rel))
}

// 3. spawn rc.2 web
const child = spawn('node', [binJs, 'web', '--patch', join(RESOURCES, 'desktop-patch.yml'), '--port', '0', '--no-open'], {
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)(?: \(LAN: [^)\n]*\))?\r?\n/
let buf = ''
const url = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('URL 行超时')), 90_000)
  child.stdout.on('data', (c) => {
    buf += c.toString()
    if (buf.length > 8192) buf = buf.slice(-8192)
    const m = buf.match(URL_LINE)
    if (m) { clearTimeout(t); resolve(m[1]) }
  })
  child.on('exit', (code) => { clearTimeout(t); reject(new Error('dsh 提前退出 ' + code)) })
})
console.log('diag: dsh url =', url)

// 4. 无头 Electron 读页面状态
const DIAG_JS = `(() => {
  const root = document.querySelector("div[data-phase]:has(> [data-conversation-scroll])")
  const navTexts = [...document.querySelectorAll("nav button span")].map(s => s.textContent)
  const pluginRes = performance.getEntriesByType("resource").filter(r => r.name.includes("desktop-integration")).map(r => r.name.split("/").slice(-2).join("/"))
  return JSON.stringify({
    handles: document.querySelectorAll("[data-dsh-legacy-handle]").length,
    handleSides: [...document.querySelectorAll("[data-dsh-legacy-handle]")].map(h => h.getAttribute("data-side")),
    hasRoot: !!root,
    styleTag: !!document.getElementById("dsh-desktop-legacy-width"),
    inlineCol: root ? root.style.getPropertyValue("--dsh-conversation-column-width") : null,
    inlineUser: root ? root.style.getPropertyValue("--dsh-chat-user-width") : null,
    computedContentW: root ? getComputedStyle(root).getPropertyValue("--dsh-chat-content-width") : null,
    rootW: root ? root.getBoundingClientRect().width : null,
    chatViewMaxW: (() => { const el = document.querySelector("[class*=chatView] , [class*=ChatView]") || document.querySelector("[data-conversation-scroll] > *"); return el ? getComputedStyle(el).maxWidth : null })(),
    prefs: {
      native: localStorage.getItem("dsh.conversation.contentWidth"),
      legacyPct: localStorage.getItem("dsh-desktop-conv-width"),
      cachedVer: localStorage.getItem("dsh-desktop-backend-version"),
    },
    bridge: !!window.dshDesktop,
    loader: typeof window.__ModuleLoader__,
    navTexts,
    pluginRes,
    phase: root ? root.getAttribute("data-phase") : null,
  })
})()`

const mainCjs = join(home, 'diag-main.cjs')
const preloadPath = join(ROOT, 'dist', 'preload.cjs')
writeFileSync(mainCjs, `const { app, BrowserWindow, ipcMain } = require('electron')
ipcMain.handle('dsh-app:get-info', () => ({ appVersion: 'diag', dshVersion: '0.1.1-rc.2', dshHome: 'h', logDir: 'l', backendSource: 'npm-global', sourceDir: null, notice: null }))
ipcMain.handle('dsh-app:get-autostart', () => false)
ipcMain.handle('dsh-settings:get-launch-minimized', () => false)
ipcMain.handle('dsh-settings:get-port-policy', () => ({ configured: 3080, actual: null, degraded: false }))
ipcMain.handle('dsh-update:check', () => ({ devMode: true }))
ipcMain.handle('dsh-backend:get-config', () => ({ mode: 'auto', sourceDir: '', networkProxy: '', validation: null }))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: {
    preload: ${JSON.stringify(preloadPath)}, contextIsolation: true, nodeIntegration: false, sandbox: true,
  } })
  await win.loadURL(process.argv[2])
  setTimeout(async () => {
    try {
      const r = await win.webContents.executeJavaScript(${JSON.stringify(DIAG_JS)})
      console.log('DIAG:' + r)
    } catch (e) { console.log('DIAG-ERR:' + String(e)) }
    app.quit()
  }, 8000)
})`)

const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const diag = spawn(electronExe, [mainCjs, url],
  { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
diag.stdout.on('data', (d) => { out += d.toString() })
diag.stderr.on('data', (d) => { out += d.toString() })
const diagResult = await new Promise((resolve) => {
  const t = setTimeout(() => resolve('diag 超时'), 60_000)
  diag.on('exit', () => { clearTimeout(t); resolve(out) })
})
const m = diagResult.match(/DIAG:(.*)/s)
console.log(m ? JSON.stringify(JSON.parse(m[1].trim()), null, 2) : '未捕获 DIAG:\n' + diagResult.slice(-800))

child.kill()
await new Promise((r) => child.once('exit', r))
console.log('diag: 完成')
process.exit(0)
