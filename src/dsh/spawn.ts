/**
 * dsh web 子进程生命周期：spawn、stdout URL 行解析、HTTP 就绪探测、
 * 优雅停止（kill → 超时强杀兜底）、输出快照（stdout+stderr 合并进环形
 * 缓冲，200 行/32KB 上限，供启动失败与崩溃诊断；消费侧脱敏 token）。
 *
 * 端口：默认固定 3080（与 dsh web 默认一致，页面 origin 稳定，浏览器
 * localStorage 侧的设置跨重启保留），被占用时由调用方降级 --port 0。
 * 无论固定或随机，实际地址都从 stdout 行 "dsh web: http://127.0.0.1:<port>[…]"
 * 解析（支持的 dsh ≥0.1.2 均带 /?token=，需整串使用以完成 cookie 换取）——
 * 这是 dsh 官方给 supervisor 的通道（源码注释：
 * "The URL line is a readiness signal: supervisors RPC as soon as they observe it"）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { waitForHttp } from './ready.js'
import { UrlLineMatcher } from './url-line.js'
import { OutputRingBuffer } from '../recovery/ring-buffer.js'
import { desktopPatchPath } from '../paths.js'

/**
 * TCP 空闲探测：能建立连接 = 已被占用（ECONNREFUSED = 空闲）；
 * 连接超时按被占处理（保守降级随机，绝不因探测误判导致 bind 失败）。
 */
export function isTcpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(true))
    socket.setTimeout(1_000, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

export interface StartDshOptions {
  nodePath: string
  dshBin: string
  dshHome: string
  /** node 前置参数（源码来源为 ['--import', 'tsx/esm']；npm 来源省略）。 */
  nodeArgs?: string[]
  /** 子进程 cwd（源码来源 = 仓库根；npm 来源省略，继承壳的 cwd）。 */
  cwd?: string
  /** 日志回调（stdout/stderr 与生命周期事件）。 */
  onLog: (line: string) => void
  /** 从 spawn 到 HTTP ready 的总超时。首启 profile 初始化较慢，默认 60s。 */
  readyTimeoutMs?: number
  /**
   * 固定监听端口；缺省 0（OS 随机分配）。实际地址一律从 stdout URL 行
   * 解析，固定/随机对端口发现逻辑无差别。EADDRINUSE 会让 dsh 直接退出
   * （上游行为，不自动换端口），固定端口须由调用方先探测空闲。
   */
  port?: number
}

export interface DshControl {
  /** dsh 进程退出的 Promise：expected=true 为正常/主动停止；false 为意外崩溃。 */
  exited: Promise<{ expected: boolean; code: number | null; signal: NodeJS.Signals | null }>
  /** HTTP 就绪后的实际地址（127.0.0.1 随机端口）。 */
  url: Promise<string>
  /** 停止 dsh：kill 后等待退出，超时强杀。 */
  stop: () => Promise<void>
  /** 最近合并输出快照（stdout+stderr 原文，含 token——消费侧须脱敏）。 */
  recentOutput: () => string
}

export function startDsh(options: StartDshOptions): DshControl {
  const { nodePath, dshBin, dshHome, nodeArgs = [], cwd, onLog, readyTimeoutMs = 60_000, port = 0 } = options

  // 桌面集成插件 patch（存在则挂载设置页「桌面」分区）。
  // 顺序关键：--patch 是 web 子命令的 option（commander 拒绝它出现在 'web'
  // 之前），必须位于透传参数（--port）之前。
  const patchArgs: string[] = []
  const patchFile = desktopPatchPath()
  if (existsSync(patchFile)) patchArgs.push('--patch', patchFile)

  // --no-open（dsh ≥0.1.0-rc.8 的 web 透传 flag，支持版本恒满足）：dsh web
  // 默认会用系统浏览器打开就绪地址，桌面端自带窗口，必须关掉，否则每次
  // 启动都多弹一个浏览器标签。放透传区（--port 之后），不影响 stdout URL 就绪行。
  // stdout+stderr 合并滚动快照：异常退出时作为诊断材料（消费侧脱敏 token）
  const recent = new OutputRingBuffer()

  const child = spawn(nodePath, [...nodeArgs, dshBin, 'web', ...patchArgs, '--port', String(port), '--no-open'], {
    cwd,
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
    recent.push(text)
    onLog(text.trimEnd())
    if (settled || urlFound) return
    const found = urlLine.push(text)
    if (found === null) return
    urlFound = true
    // 双保险：URL 行出现后仍须 HTTP 2xx（dist 挂载完成）才视为就绪。
    // 超时用 readyTimeoutMs（调用方可配，缺省 60s）
    waitForHttp(found, readyTimeoutMs).then(
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
  child.stderr?.on('data', (chunk: Buffer) => {
    recent.push(chunk.toString())
    onLog(chunk.toString().trimEnd())
  })
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

  return { exited, url, stop, recentOutput: () => recent.text() }
}
