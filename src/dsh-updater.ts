/**
 * 后端（用户已装的 dsh CLI）版本检测与一键升级（纯壳架构）。
 * 与 updater.ts（桌壳自身 electron-updater）正交。
 *
 * 检测：`npm view @deepseek-ai/dsh dist-tags --json` 解析后取高于当前的最高
 * 版本（含 alpha/next 等预发布渠道，见 dsh-update-target）与当前版本比较；
 * 升级：`npm i -g @deepseek-ai/dsh@<版本>`，完成后经 main 注入的
 * restart 处理器重启后端并重载窗口。全程走系统 npm（能装 dsh 必有 npm），
 * 代理经环境变量注入（与 pnpm 一致，见 settings.networkProxyEnv）。
 */

import { spawn } from 'node:child_process'
import { log } from './log.js'
import { locateDsh } from './dsh-locator.js'
import { resolveUpdateTarget, SEMVER_RE } from './dsh-update-target.js'
import { networkProxyEnv } from './settings.js'
import { killTree } from './kill-tree.js'

export type UpdateStage = 'idle' | 'checking' | 'updating' | 'done' | 'error'

export interface BackendUpdateStatus {
  /** 用户当前 dsh 版本。 */
  current: string
  /** 目标更新版本（高于当前的最高版，含预发布渠道）；无则为 null。 */
  latest: string | null
  /** latest 是否高于 npm 稳定版（来自 alpha/next 等预发布 tag）。 */
  latestPrerelease?: boolean
  stage: UpdateStage
  error?: string
  /** 完成过一次检查（成功）；false = 尚未检查，UI 不得显示「已是最新版本」。 */
  checked?: boolean
}

let currentVersion = 'unknown'
let status: BackendUpdateStatus = { current: 'unknown', latest: null, stage: 'idle', checked: false }
const listeners: Array<(s: BackendUpdateStatus) => void> = []

function publish(): void {
  for (const cb of listeners) cb({ ...status })
}

/** 实时日志出口：main 接到 webContents（恢复页版本区与设置页共用）。 */
let logSink: ((line: string) => void) | null = null
export function setBackendLogSink(cb: ((line: string) => void) | null): void {
  logSink = cb
}

function emitLog(line: string): void {
  log(line)
  logSink?.(line)
}

export function onBackendUpdateStatus(cb: (s: BackendUpdateStatus) => void): void {
  listeners.push(cb)
}

/** main 在定位到用户 dsh 后注入当前版本。 */
export function initBackendUpdater(current: string): void {
  currentVersion = current
  status.current = current
}

function runNpm(args: string[], opts: { stream?: boolean; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // 参数为受控字面量（动态版本串来自 resolveUpdateTarget 的 SEMVER_RE 过滤）；
    // Windows 经 ComSpec /c 解析 .cmd shim（shell:true+args 数组在 Node≥22 有 DEP0190 警告）
    const cmdStr = ['npm', ...args].join(' ')
    const isWin = process.platform === 'win32'
    const child = spawn(isWin ? process.env.ComSpec ?? 'cmd' : 'npm',
      isWin ? ['/d', '/s', '/c', cmdStr] : args, {
        env: { ...process.env, ...networkProxyEnv() },
        windowsHide: true,
      })
    // 网络挂起时 npm 永不退出：超时强杀，防 versionBusy 永久占用恢复页
    const timeoutMs = opts.timeoutMs ?? 600_000
    const timer = setTimeout(() => {
      killTree(child) // 树杀:cmd 下面的 npm.cmd/node 孙进程一并带走
      reject(new Error(`npm ${args[0]} 超时（${Math.round(timeoutMs / 1000)}s），已终止`))
    }, timeoutMs)
    let out = ''
    let err = ''
    child.stdout?.on('data', (d: Buffer) => {
      const t = d.toString(); out += t
      if (opts.stream === true) emitLog(t)
    })
    child.stderr?.on('data', (d: Buffer) => {
      const t = d.toString(); err += t
      if (opts.stream === true) emitLog(t)
    })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(`npm ${args[0]} 失败 (code=${String(code)}) ${(err || out).slice(-400)}`))
    })
  })
}

/** 检查 npm 上最新版；与当前一致时 latest 置 null（无更新）。切换/安装进行中直接返回现状。 */
export async function checkBackendUpdate(): Promise<BackendUpdateStatus> {
  if (status.stage === 'updating') return { ...status }
  status.current = currentVersion
  status.stage = 'checking'
  status.error = undefined
  publish()
  try {
    const distTags = JSON.parse(
      await runNpm(['view', '@deepseek-ai/dsh', 'dist-tags', '--json'], { timeoutMs: 60_000 }),
    ) as Record<string, string>
    const target = resolveUpdateTarget(distTags, currentVersion)
    status.latest = target?.version ?? null
    status.latestPrerelease = target?.prerelease ?? false
    status.stage = 'idle'
    status.checked = true // 检查成功（无论有无新版）才标记，UI 据此显示「已是最新版本」
  } catch (err) {
    status.stage = 'error'
    status.error = String(err)
  }
  publish()
  return { ...status }
}

let restartHandler: (() => Promise<void>) | null = null
export function setBackendRestartHandler(fn: () => Promise<void>): void {
  restartHandler = fn
}

/** 拉取 npm 发布版本清单与 dist-tags（恢复页版本区数据源；失败抛错由调用方处理）。 */
export async function fetchNpmVersions(): Promise<{ versions: string[]; distTags: Record<string, string> }> {
  const versions = JSON.parse(await runNpm(['view', '@deepseek-ai/dsh', 'versions', '--json'], { timeoutMs: 60_000 })) as string[]
  const distTags = JSON.parse(await runNpm(['view', '@deepseek-ai/dsh', 'dist-tags', '--json'], { timeoutMs: 60_000 })) as Record<string, string>
  return { versions, distTags }
}

/**
 * 切换到任意版本（升级/回退统一入口）：npm i -g 固定目标版本 → 重新定位 →
 * 重启后端。目标串必须先过 SEMVER_RE 白名单（安全边界，勿动）；「低于当前」
 * 的提醒由 UI 确认框负责（handover §7.6），本函数不拦截。
 */
export async function installBackendVersion(target: string): Promise<BackendUpdateStatus> {
  if (!SEMVER_RE.test(target)) {
    status.stage = 'error'
    status.error = `非法的版本号：${target}`
    publish()
    return { ...status }
  }
  if (status.stage === 'updating') return { ...status } // 并发锁
  status.stage = 'updating'
  status.error = undefined
  publish()
  try {
    emitLog(`[shell] npm 全局安装 @deepseek-ai/dsh@${target}…`)
    await runNpm(['i', '-g', `@deepseek-ai/dsh@${target}`], { stream: true })
    const located = locateDsh()
    if (located === null) throw new Error('切换完成但未检测到 dsh，请重启桌面壳')
    currentVersion = located.version
    status.current = located.version
    status.latest = null
    status.checked = true
    status.stage = 'done'
    emitLog(`[shell] ✓ 已切换到 dsh ${located.version}`)
    log(`dsh-updater: 已切换到 ${located.version}`)
  } catch (err) {
    status.stage = 'error'
    status.error = String(err)
    emitLog(`[shell] ✗ 版本切换失败：${String(err)}`)
    log(`dsh-updater: 版本切换失败 ${String(err)}`)
    publish()
    return { ...status }
  }
  // 安装成功但重启失败不误报「切换失败」：版本已就位，仅提示重启
  if (restartHandler !== null) {
    try {
      await restartHandler()
    } catch (err) {
      status.error = `已切换到 ${currentVersion}，但重启后端失败：${String(err)}（重启应用即可生效）`
      log(`dsh-updater: ${status.error}`)
    }
  }
  publish()
  return { ...status }
}

/** 「检查=提示升级」入口（薄封装）：无更高版本返回 idle；否则走 installBackendVersion。 */
export async function updateBackend(): Promise<BackendUpdateStatus> {
  if (status.latest === null) {
    status.stage = 'idle'
    publish()
    return { ...status }
  }
  return installBackendVersion(status.latest)
}
