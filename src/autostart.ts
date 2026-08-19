/**
 * 开机自启：win/mac 走 Electron 原生 setLoginItemSettings；linux 写
 * XDG autostart .desktop 文件。dev 模式（exe 是 electron 开发二进制）下
 * 设置无实际意义，但接口保持一致，仅打包后用户会使用。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_NAME = 'deepseek-harness-desktop'

function linuxAutostartFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(configHome, 'autostart', `${APP_NAME}.desktop`)
}

function linuxDesktopContent(): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=DeepSeek Harness Desktop',
    // 引号包裹：Exec 首个字段（可执行文件路径）含空格时，须整体加引号
    `Exec="${process.execPath}"`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

export function isAutostartEnabled(): boolean {
  if (process.platform === 'linux') return existsSync(linuxAutostartFile())
  return app.getLoginItemSettings().openAtLogin
}

export function setAutostart(enabled: boolean): void {
  if (process.platform === 'linux') {
    const file = linuxAutostartFile()
    if (enabled) {
      mkdirSync(file.substring(0, file.lastIndexOf('/')), { recursive: true })
      writeFileSync(file, linuxDesktopContent(), { mode: 0o644 })
    } else {
      rmSync(file, { force: true })
    }
    return
  }
  app.setLoginItemSettings({ openAtLogin: enabled })
}
