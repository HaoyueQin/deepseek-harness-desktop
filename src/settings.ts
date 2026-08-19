/**
 * 壳自有设置（userData/settings.json）。开机自启状态不入此文件——
 * 由 autostart.ts 底层（注册表/LaunchServices/XDG 文件）自持。
 */
import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

interface ShellSettings { launchMinimized?: boolean }

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function read(): ShellSettings {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8')) as ShellSettings
  } catch {
    return {}
  }
}

function write(next: ShellSettings): void {
  try {
    const target = settingsPath()
    // 原子写：先写同目录临时文件再 rename 覆盖。避免进程被强杀/断电时
    // 留下截断的 settings.json（下次 JSON.parse 失败丢全部设置）。
    // userData 目录由 Electron 保证存在，无需额外 mkdir。
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, target)
  } catch {
    /* 设置写失败不阻断主流程 */
  }
}

export function getLaunchMinimized(): boolean {
  return read().launchMinimized === true
}

export function setLaunchMinimized(v: boolean): void {
  write({ ...read(), launchMinimized: v })
}
