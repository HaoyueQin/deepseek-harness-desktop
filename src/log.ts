/**
 * 主进程日志：dev 打印到 stdout；prod 追加到 <userData>/logs/main.log。
 */

import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** main.log 单文件上限：超限把当前文件轮转为 main.log.1（保留最近一份）。 */
const MAX_LOG_BYTES = 5 * 1024 * 1024

/**
 * stdout 管道可能断开（dev 下父进程被杀/重定向关闭）：EPIPE 未捕获会让
 * Electron 主进程弹「JavaScript error」崩溃窗——静默吞掉，杜绝一次性。
 */
process.stdout.on('error', () => { /* stdout 不可写：静默 */ })

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  if (!app.isPackaged) {
    try {
      console.log(line.trimEnd())
    } catch {
      /* stdout 不可写：静默 */
    }
    return
  }
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'main.log')
    // 托盘常驻长期运行，防止 main.log 无限增长（轮转失败继续写当前文件）
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      try {
        renameSync(file, `${file}.1`)
      } catch {
        /* 轮转失败不阻断 */
      }
    }
    appendFileSync(file, line)
  } catch {
    /* 日志失败不阻断主流程 */
  }
}
