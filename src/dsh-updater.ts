/**
 * 后端（@deepseek-ai/dsh）版本检测与一键更新。
 * 与 updater.ts（桌壳自身 electron-updater）正交。
 *
 * 更新机制：spawn 内置 node 跑内联 ESM，用 npm view/install 到临时目录，
 * 成功后原子替换 resources/dsh，再交给 main 注入的 restart 处理器
 * （停旧 dsh → 重启 → 窗口重载）。失败不伤旧版。
 */

import { app } from 'electron'
import { readFileSync, rmSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { resourcesDir, nodeExecutable } from './paths.js'
import { log } from './log.js'

export type UpdateStage = 'idle' | 'checking' | 'updating' | 'done' | 'error'

export interface BackendUpdateStatus {
  current: string
  latest: string | null
  stage: UpdateStage
  error?: string
}

let status: BackendUpdateStatus = { current: 'unknown', latest: null, stage: 'idle' }
const listeners: Array<(s: BackendUpdateStatus) => void> = []

function publish(): void {
  for (const cb of listeners) cb({ ...status })
}

export function onBackendUpdateStatus(cb: (s: BackendUpdateStatus) => void): void {
  listeners.push(cb)
}

export function isDevBackend(): boolean {
  return !app.isPackaged
}

/** 当前内置 dsh 版本（resources/dsh/.dsh-version）。 */
function readCurrentVersion(): string {
  try {
    const v = readFileSync(join(resourcesDir(), 'dsh', '.dsh-version'), 'utf8').trim()
    return v === '' ? 'unknown' : v
  } catch {
    return isDevBackend() ? 'dev' : 'unknown'
  }
}

/** 版本范围：package.json devDependencies 的 @deepseek-ai/dsh。 */
function readVersionRange(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    devDependencies?: Record<string, string>
  }
  const range: unknown = pkg.devDependencies?.['@deepseek-ai/dsh']
  if (typeof range !== 'string' || range === '') throw new Error('package.json 缺少 @deepseek-ai/dsh 版本范围')
  return range
}

/** 判定某版本是否在范围内（可更新目标）。纯函数，便于测试。 */
export function isInRange(version: string, range: string): boolean {
  // 简易比较：仅支持 ^x.y.z 形式（当前场景）；同 minor 内任何 patch/prerelease 可更新。
  const m = /^\^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(range)
  if (m === null) return version === range.replace(/^\^/, '')
  const [, maj, min] = m
  const v = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version)
  if (v === null) return false
  return v[1] === maj && v[2] === min
}

/**
 * 更新脚本正文（内联 ESM，spawn 内置 node 执行）。
 * argv: [tmpDir, range, --registry <url>]；npm 从系统 PATH 取（内置 Node 自带）。
 */
const UPDATE_SCRIPT = `
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const [tmpDir, range] = process.argv.slice(2)
const registryIdx = process.argv.indexOf('--registry')
const registry = registryIdx >= 0 ? process.argv[registryIdx + 1] : 'https://registry.npmjs.org'
function report(o) { console.log('UPDATE_STATUS ' + JSON.stringify(o)) }

// 1) 检测范围内最新版
report({ stage: 'checking', message: '查询最新版本…' })
let latest = ''
try {
  const r = spawnSync('npm', ['view', '@deepseek-ai/dsh@' + range, 'version', '--json', '--registry', registry], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').slice(0, 500))
  const parsed = JSON.parse(r.stdout)
  latest = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed
} catch (e) {
  report({ stage: 'error', message: String(e) })
  process.exit(1)
}
report({ stage: 'checking', message: '最新版本 ' + latest })

// 2) 安装到临时目录
report({ stage: 'installing', message: '下载安装 ' + latest + '…' })
mkdirSync(tmpDir, { recursive: true })
writeFileSync(join(tmpDir, 'package.json'),
  JSON.stringify({ name: 'dsh-update-tmp', private: true, dependencies: { '@deepseek-ai/dsh': latest } }, null, 2))
const inst = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--registry', registry], {
  cwd: tmpDir, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
})
if (inst.status !== 0) {
  report({ stage: 'error', message: (inst.stderr || inst.stdout || '').slice(-2000) })
  process.exit(1)
}
report({ stage: 'installing', message: '安装完成' })
`

/**
 * 主进程触发检测。dev 模式仅读当前版本，不查 registry。
 */
export async function checkBackendUpdate(): Promise<BackendUpdateStatus> {
  status.current = readCurrentVersion()
  if (isDevBackend()) {
    status.latest = null
    status.stage = 'idle'
    publish()
    return { ...status }
  }
  status.stage = 'checking'
  publish()
  try {
    const latest = await runNpmView(readVersionRange())
    status.latest = latest
    status.stage = 'idle'
  } catch (err) {
    status.stage = 'error'
    status.error = String(err)
  }
  publish()
  return { ...status }
}

function runNpmView(range: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable(), ['--input-type=module', '--eval', UPDATE_SCRIPT, '--', 'unused', range, '--registry', 'https://registry.npmjs.org'], {
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { err += d.toString() })
    child.on('error', reject)
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('UPDATE_STATUS '))
      if (line === undefined || code !== 0) {
        reject(new Error(`npm view 失败 (${String(code)}) ${err || out}`.slice(0, 500)))
        return
      }
      try {
        const o = JSON.parse(line.slice('UPDATE_STATUS '.length)) as { stage: string; message: string }
        if (o.stage === 'error') { reject(new Error(o.message)); return }
        resolve(o.message.replace(/^最新版本 /, ''))
      } catch {
        reject(new Error('npm view 输出解析失败'))
      }
    })
  })
}

/** 一键更新：装临时目录 → 原子替换 → 交给 restart 处理器。 */
let restartHandler: (() => Promise<void>) | null = null
export function setBackendRestartHandler(fn: () => Promise<void>): void {
  restartHandler = fn
}

export async function updateBackend(): Promise<BackendUpdateStatus> {
  status.current = readCurrentVersion()
  if (isDevBackend()) {
    status.stage = 'error'
    status.error = '开发模式请用 npm install 或重新 build:runtime'
    publish()
    return { ...status }
  }
  if (status.latest === null || status.latest === status.current) {
    status.stage = 'idle'
    publish()
    return { ...status }
  }
  status.stage = 'updating'
  publish()

  const dshDir = join(resourcesDir(), 'dsh')
  const tmpDir = join(resourcesDir(), '.dsh-update-tmp')
  try {
    await runInstall(tmpDir, status.latest, 'https://registry.npmjs.org')
    // 原子替换：先删旧再改名（同卷 rename 原子），失败时旧版不动
    rmSync(dshDir, { recursive: true, force: true })
    renameSync(tmpDir, dshDir)
    writeFileSync(join(dshDir, '.dsh-version'), status.latest)
    log(`dsh-updater: 已替换为 ${status.latest}`)
    status.stage = 'done'
    publish()
    if (restartHandler !== null) await restartHandler()
    return { ...status }
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true })
    status.stage = 'error'
    status.error = String(err)
    publish()
    log(`dsh-updater: 更新失败 ${String(err)}`)
    return { ...status }
  }
}

function runInstall(tmpDir: string, version: string, registry: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable(), ['--input-type=module', '--eval', UPDATE_SCRIPT, '--', tmpDir, version, '--registry', registry], {
      windowsHide: true,
    })
    let out = ''
    child.stdout?.on('data', (d) => {
      const text = d.toString()
      out += text
      const line = text.split('\n').find((l: string) => l.startsWith('UPDATE_STATUS '))
      if (line !== undefined) {
        try {
          status.stage = (JSON.parse(line.slice('UPDATE_STATUS '.length)) as { stage: UpdateStage }).stage
          publish()
        } catch { /* 忽略 */ }
      }
    })
    child.stderr?.on('data', () => { /* npm 日志走 stderr，不展示 */ })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else {
        const errLine = out.split('\n').find((l: string) => l.startsWith('UPDATE_STATUS ') && l.includes('"error"'))
        reject(new Error(errLine !== undefined
          ? (JSON.parse(errLine.slice('UPDATE_STATUS '.length)) as { message: string }).message
          : `npm install 失败 (code=${String(code)})`))
      }
    })
  })
}

/** 供 main.ts 启动时初始化。 */
export function initBackendUpdater(): void {
  status.current = readCurrentVersion()
}
