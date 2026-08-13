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
import { waitForHttp } from './ready.js'

/** dsh 官方 readiness 行，如 "dsh web: http://127.0.0.1:50871" */
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/

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

  const child = spawn(nodePath, [dshBin, 'web', '--port', '0'], {
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

  const onStdout = (chunk: Buffer): void => {
    const text = chunk.toString()
    onLog(text.trimEnd())
    if (settled) return
    const match = text.match(URL_LINE)
    if (match === null) return
    const found = match[1]
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
    child.kill() // 默认 SIGTERM；Windows 下为 TerminateProcess，dsh 数据已文件落盘（storage-json），不丢
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
