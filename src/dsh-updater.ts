/**
 * 后端（用户已装的 dsh CLI）版本检测与一键升级（纯壳架构）。
 * 与 updater.ts（桌壳自身 electron-updater）正交。
 *
 * 检测：`npm view @deepseek-ai/dsh@latest version` 与当前版本比较；
 * 升级：`npm i -g @deepseek-ai/dsh@<版本>`，完成后经 main 注入的
 * restart 处理器重启后端并重载窗口。全程走系统 npm（能装 dsh 必有 npm）。
 */

import { spawn } from 'node:child_process'
import { log } from './log.js'
import { locateDsh } from './dsh-locator.js'

export type UpdateStage = 'idle' | 'checking' | 'updating' | 'done' | 'error'

export interface BackendUpdateStatus {
  /** 用户当前 dsh 版本。 */
  current: string
  /** npm 上最新版；与当前相同则为 null（无更新）。 */
  latest: string | null
  stage: UpdateStage
  error?: string
}

let currentVersion = 'unknown'
let status: BackendUpdateStatus = { current: 'unknown', latest: null, stage: 'idle' }
const listeners: Array<(s: BackendUpdateStatus) => void> = []

function publish(): void {
  for (const cb of listeners) cb({ ...status })
}

export function onBackendUpdateStatus(cb: (s: BackendUpdateStatus) => void): void {
  listeners.push(cb)
}

/** main 在定位到用户 dsh 后注入当前版本。 */
export function initBackendUpdater(current: string): void {
  currentVersion = current
  status.current = current
}

function runNpm(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // 参数均为固定字面量；shell:true 仅用于 Windows 解析 .cmd shim
    const child = spawn('npm', args, {
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(out.trim())
      else reject(new Error(`npm ${args[0]} 失败 (code=${String(code)}) ${(err || out).slice(-400)}`))
    })
  })
}

/** 检查 npm 上最新版；与当前一致时 latest 置 null（无更新）。 */
export async function checkBackendUpdate(): Promise<BackendUpdateStatus> {
  status.current = currentVersion
  status.stage = 'checking'
  status.error = undefined
  publish()
  try {
    const latest = await runNpm(['view', '@deepseek-ai/dsh@latest', 'version'])
    status.latest = latest === '' || latest === currentVersion ? null : latest
    status.stage = 'idle'
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

/** 一键升级：npm i -g 固定目标版本 → 重新定位 → 重启后端。 */
export async function updateBackend(): Promise<BackendUpdateStatus> {
  if (status.latest === null) {
    status.stage = 'idle'
    publish()
    return { ...status }
  }
  if (status.stage === 'updating') return { ...status }
  const target = status.latest
  status.stage = 'updating'
  status.error = undefined
  publish()
  try {
    await runNpm(['i', '-g', `@deepseek-ai/dsh@${target}`])
    const located = locateDsh()
    if (located === null) throw new Error('升级完成但未检测到 dsh，请重启桌面壳')
    currentVersion = located.version
    status.current = located.version
    status.latest = null
    status.stage = 'done'
    log(`dsh-updater: 已升级到 ${located.version}`)
    if (restartHandler !== null) await restartHandler()
  } catch (err) {
    status.stage = 'error'
    status.error = String(err)
    log(`dsh-updater: 升级失败 ${String(err)}`)
  }
  publish()
  return { ...status }
}
