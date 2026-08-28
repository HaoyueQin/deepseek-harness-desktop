/**
 * 源码后端在线更新：git tag 检查 + 检出/安装/构建/重启管线。
 * 与 dsh-updater.ts（npm 全局来源）互斥使用——同一时刻只有一个生效后端，
 * main 按生效来源把 dsh-backend:check/update 分发到对应模块。
 *
 * 检查：git fetch --tags 后按 semver 取最大 dsh-v* tag 与当前版本比较；
 * 更新：工作区干净 → 检出 tag（detached HEAD）→ pnpm install → pnpm build
 * → 重启后端。git 代理经 -c 参数注入（不改全局配置）；pnpm 走环境变量。
 * 失败不回滚（与 npm 流一致）：tag 已检出时重启应用即继续用新检出，旧检出
 * 可 `git checkout master` 找回。
 */

import { spawn } from 'node:child_process'
import { log } from './log.js'
import { getNetworkProxy, getSourceDir } from './settings.js'
import { pickLatestTag, tagVersion, validateSourceDir } from './dsh-source.js'
import { compareVersions } from './dsh-locator.js'
import type { BackendUpdateStatus } from './dsh-updater.js'

let currentVersion = 'unknown'
let currentDir = ''
let status: BackendUpdateStatus = { current: 'unknown', latest: null, stage: 'idle', checked: false }
const listeners: Array<(s: BackendUpdateStatus) => void> = []

function publish(): void {
  for (const cb of listeners) cb({ ...status })
}

export function onSourceUpdateStatus(cb: (s: BackendUpdateStatus) => void): void {
  listeners.push(cb)
}

/** main 在定位到源码后端后注入当前版本与目录。 */
export function initSourceUpdater(version: string, dir: string): void {
  currentVersion = version
  currentDir = dir
  status.current = version
}

/** 实时日志出口：main 接到 webContents（设置页「下载更新」日志区）。 */
let logSink: ((line: string) => void) | null = null
export function setSourceLogSink(cb: ((line: string) => void) | null): void {
  logSink = cb
}

function emitLog(line: string): void {
  log(line)
  logSink?.(line)
}

export interface SourceUpdateHooks {
  restartBackend: () => Promise<void>
  stopBackend: () => Promise<void>
}

let hooks: SourceUpdateHooks | null = null
export function setSourceUpdateHooks(h: SourceUpdateHooks): void {
  hooks = h
}

/** 更新管线（fetch/检出/install/build）是否在跑；main 用它与克隆/准备互斥。 */
export function isSourceUpdating(): boolean {
  return status.stage === 'checking' || status.stage === 'updating'
}

function requireDir(): string {
  if (currentDir === '') throw new Error('未配置源码目录')
  return currentDir
}

/** git 代理：只经 -c 参数注入本次调用，不写全局 gitconfig。 */
function proxyArgs(): string[] {
  const p = getNetworkProxy()
  return p === '' ? [] : ['-c', `http.proxy=${p}`, '-c', `https.proxy=${p}`]
}

/** pnpm 代理：环境变量方式（NO_PROXY 放行本机回调）。 */
function proxyEnv(): NodeJS.ProcessEnv {
  const p = getNetworkProxy()
  return p === '' ? {} : { HTTP_PROXY: p, HTTPS_PROXY: p, NO_PROXY: '127.0.0.1,localhost' }
}

/**
 * 流式执行一个子进程：输出逐段 emitLog，exit 0 resolve 全量输出。
 * git 是 .exe 直接 spawn（args 数组原样传达，路径含空格安全）；pnpm 是
 * .cmd shim，经 ComSpec /c 解析（参数均为受控字面量，无空格敏感值）。
 */
function runStreamed(bin: string, args: string[], opts: { cwd: string; viaShell?: boolean; env?: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const isWin = process.platform === 'win32'
    const shell = opts.viaShell === true && isWin
    const child = shell
      ? spawn(process.env.ComSpec ?? 'cmd', ['/d', '/s', '/c', [bin, ...args].join(' ')], {
          cwd: opts.cwd, env: { ...process.env, ...opts.env }, windowsHide: true,
        })
      : spawn(bin, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, windowsHide: true })
    let out = ''
    const push = (d: Buffer): void => { const t = d.toString(); out += t; emitLog(t) }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    child.on('error', reject)
    child.on('exit', (code) => {
      const seconds = Math.round((Date.now() - started) / 1000)
      if (code === 0) resolve(out)
      else reject(new Error(`${bin} ${args[0]} 失败 (code=${String(code)}，耗时 ${seconds}s)`))
    })
  })
}

function runGit(dir: string, args: string[]): Promise<string> {
  return runStreamed('git', ['-C', dir, ...proxyArgs(), ...args], { cwd: dir })
}

function runPnpm(dir: string, args: string[]): Promise<string> {
  return runStreamed('pnpm', args, { cwd: dir, viaShell: true, env: proxyEnv() })
}

/** 检查远端最新 tag；与当前一致时 latest 置 null（无更新）。 */
export async function checkSourceUpdate(): Promise<BackendUpdateStatus> {
  status.current = currentVersion
  status.stage = 'checking'
  status.error = undefined
  publish()
  try {
    const dir = requireDir()
    emitLog(`[shell] 正在从远端获取 tag（git fetch --tags）…`)
    await runGit(dir, ['fetch', '--tags', '--prune'])
    const out = await runGit(dir, ['tag', '--list', 'dsh-v*'])
    const latestTag = pickLatestTag(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
    if (latestTag === null) throw new Error('远端没有合法的 dsh-v* tag')
    const latestVer = tagVersion(latestTag)
    if (latestVer === null) throw new Error(`tag 无法解析版本：${latestTag}`)
    status.latest = compareVersions(latestVer, currentVersion) > 0 ? latestVer : null
    status.stage = 'idle'
    status.checked = true
    emitLog(`[shell] 检查完成：最新 ${latestTag}，当前 ${currentVersion}${status.latest === null ? '（已是最新）' : ''}`)
  } catch (err) {
    status.stage = 'error'
    status.error = String(err)
    emitLog(`[shell] ✗ 检查失败：${String(err)}`)
  }
  publish()
  return { ...status }
}

/** 下载更新：检出 tag → pnpm install → pnpm build → 重启后端。 */
export async function updateSource(): Promise<BackendUpdateStatus> {
  if (status.latest === null) {
    status.stage = 'idle'
    publish()
    return { ...status }
  }
  if (status.stage === 'updating') return { ...status } // 并发锁
  const target = status.latest
  const dir = requireDir()
  status.stage = 'updating'
  status.error = undefined
  publish()
  try {
    emitLog(`[shell] 开始更新到 dsh-v${target}`)
    const porcelain = await runGit(dir, ['status', '--porcelain'])
    if (porcelain.trim() !== '') throw new Error('工作区有未提交的修改，无法自动检出；请先在源码目录手动处理')
    emitLog(`[shell] 工作区干净，正在检出 dsh-v${target}（detached HEAD）`)
    try {
      await runGit(dir, ['checkout', '--detach', `dsh-v${target}`])
    } catch (err) {
      // Windows 下运行中的后端可能短暂持有旧文件句柄：先停后端再重试一次
      emitLog(`[shell] 检出失败（${String(err)}），停止后端后重试`)
      if (hooks === null) throw err
      await hooks.stopBackend()
      await runGit(dir, ['checkout', '--detach', `dsh-v${target}`])
    }
    emitLog('[shell] 正在安装依赖（pnpm install，可能需要数分钟）')
    await runPnpm(dir, ['install'])
    emitLog('[shell] 正在构建（pnpm build：全部包 lib + 前端 dist）')
    await runPnpm(dir, ['build'])
    const v = validateSourceDir(dir)
    if (!v.ok) throw new Error(`更新后校验失败：${v.missing.join('；')}`)
    currentVersion = v.version
    status.current = v.version
    status.latest = null
    status.checked = true
    status.stage = 'done'
    emitLog(`[shell] ✓ 已更新到 ${v.version}`)
    log(`dsh-source-updater: 已更新到 ${v.version}`)
  } catch (err) {
    status.stage = 'error'
    status.error = String(err)
    emitLog(`[shell] ✗ 更新失败：${String(err)}（重启应用即可继续用旧检出）`)
    log(`dsh-source-updater: 更新失败 ${String(err)}`)
    publish()
    return { ...status }
  }
  // 更新成功但重启失败不误报「更新失败」：版本已检出，仅提示重启
  if (hooks !== null) {
    try {
      await hooks.restartBackend()
    } catch (err) {
      status.error = `已更新到 ${currentVersion}，但重启后端失败：${String(err)}（重启应用即可生效）`
      log(`dsh-source-updater: ${status.error}`)
    }
  }
  publish()
  return { ...status }
}
