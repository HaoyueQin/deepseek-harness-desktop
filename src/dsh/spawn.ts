/**
 * dsh web 子进程生命周期：spawn（内置 Node + --port 0）、stdout URL 行解析、
 * HTTP 就绪探测、优雅停止（kill → 超时强杀兜底）。
 *
 * 端口策略：--port 0 让 OS 分配，从 stdout 行 "dsh web: http://127.0.0.1:<port>"
 * 解析实际地址——这是 dsh 官方给 supervisor 的通道（源码注释：
 * "The URL line is a readiness signal: supervisors RPC as soon as they observe it"）。
 * 规避固定 3080 的端口冲突。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { waitForHttp } from './ready.js'
import { UrlLineMatcher } from './url-line.js'
import { desktopPatchPath } from '../paths.js'

export interface StartDshOptions {
  nodePath: string
  dshBin: string
  dshHome: string
  /** 日志回调（stdout/stderr 与生命周期事件）。 */
  onLog: (line: string) => void
  /** 从 spawn 到 HTTP ready 的总超时。首启 profile 初始化较慢，默认 60s。 */
  readyTimeoutMs?: number
}

export interface DshControl {
  /** dsh 进程退出的 Promise：expected=true 为正常/主动停止；false 为意外崩溃。 */
  exited: Promise<{ expected: boolean; code: number | null; signal: NodeJS.Signals | null }>
  /** HTTP 就绪后的实际地址（127.0.0.1 随机端口）。 */
  url: Promise<string>
  /** 停止 dsh：kill 后等待退出，超时强杀。 */
  stop: () => Promise<void>
}

export function startDsh(options: StartDshOptions): DshControl {
  const { nodePath, dshBin, dshHome, onLog, readyTimeoutMs = 60_000 } = options

  // 桌面集成插件 patch（存在则挂载设置页「桌面」分区）。
  // 顺序关键：--patch 是 launcher（web 子命令）的 option，必须位于透传参数
  // （--port 0）之前；放后面会被 commander 归入透传 args 导致 unknown option。
  const patchArgs: string[] = []
  const patchFile = desktopPatchPath()
  if (existsSync(patchFile)) patchArgs.push('--patch', patchFile)

  // --no-open（dsh 0.1.0-rc.8+ 的 web 透传 flag）：dsh web 默认会用系统
  // 浏览器打开就绪地址，桌面端自带窗口，必须关掉，否则每次启动都多弹
  // 一个浏览器标签。放透传区（--port 0 之后），不影响 stdout URL 就绪行。
  const child = spawn(nodePath, [dshBin, 'web', ...patchArgs, '--port', '0', '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let expectedStop = false
  let urlResolve!: (url: string) => void
  let urlReject!: (err: Error) => void
  const url = new Promise<string>((resolve, reject) => {
    urlResolve = resolve
    urlReject = reject
  })
  let settled = false
  const urlLine = new UrlLineMatcher()
  let urlFound = false // 已命中一次 URL 行后忽略后续 chunk，避免重复发起 HTTP 探测

  const onStdout = (chunk: Buffer): void => {
    const text = chunk.toString()
    onLog(text.trimEnd())
    if (settled || urlFound) return
    const found = urlLine.push(text)
    if (found === null) return
    urlFound = true
    // 双保险：URL 行出现后仍须 HTTP 2xx（dist 挂载完成）才视为就绪
    waitForHttp(found, 30_000).then(
      () => {
        settled = true
        urlResolve(found)
      },
      (err: Error) => {
        settled = true
        urlReject(err)
      },
    )
  }

  child.stdout?.on('data', onStdout)
  child.stderr?.on('data', (chunk: Buffer) => onLog(chunk.toString().trimEnd()))
  child.on('error', (err) => {
    settled = true
    urlReject(err)
  })

  const exited = new Promise<{ expected: boolean; code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('exit', (code, signal) => {
        if (!settled) {
          settled = true
          const reason = `dsh 进程提前退出（code=${String(code)} signal=${String(signal)}）`
          urlReject(new Error(reason))
          onLog(reason)
        }
        resolve({ expected: expectedStop, code, signal })
      })
    },
  )

  async function stop(): Promise<void> {
    expectedStop = true
    if (child.exitCode !== null || child.signalCode !== null) return
    onLog('dsh: 发送停止信号')
    // kill 返回 false = 进程未成功启动（如 spawn error），无子进程可等
    if (!child.kill()) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已退出 */
        }
        resolve()
      }, 8_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return { exited, url, stop }
}
