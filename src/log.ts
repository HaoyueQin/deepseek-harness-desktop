/**
 * 主进程日志：dev 打印到 stdout；prod 追加到 <userData>/logs/main.log。
 */

import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  if (!app.isPackaged) {
    console.log(line.trimEnd())
    return
  }
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'main.log'), line)
  } catch {
    /* 日志失败不阻断主流程 */
  }
}
