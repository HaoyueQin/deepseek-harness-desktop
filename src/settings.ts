/**
 * 壳自有设置（userData/settings.json）。开机自启状态不入此文件——
 * 由 autostart.ts 底层（注册表/LaunchServices/XDG 文件）自持。
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
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
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
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
