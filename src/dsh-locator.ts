/**
 * 定位用户已安装的 dsh CLI（纯壳架构：壳不再内置运行时）。
 *
 * 检测两步，任一失败视为未安装：
 * 1. PATH 里的 dsh 可执行且 `dsh --version` 有输出（验证可用 + 取版本）
 * 2. `npm root -g` 定位全局 node_modules，推导 bin.js 绝对路径
 *    （spawn 用系统 node 直接执行 bin.js，避免 Windows .cmd 需要 shell:true）
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface LocatedDsh {
  /** `dsh --version` 输出，如 "0.1.1-rc.1"。 */
  version: string
  /** 全局安装的 bin.js 绝对路径（供系统 node 直接执行）。 */
  binJs: string
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  // 参数均为固定字面量（无用户输入），shell:true 仅用于 Windows 解析 .cmd shim
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  })
  return { ok: r.status === 0, out: (r.stdout || '').trim() }
}

/** 检测用户已装的 dsh；未安装或不可用返回 null。 */
export function locateDsh(): LocatedDsh | null {
  const ver = run('dsh', ['--version'])
  if (!ver.ok || ver.out === '') return null
  const root = run('npm', ['root', '-g'])
  if (!root.ok || root.out === '') return null
  const binJs = join(root.out, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(binJs)) return null
  return { version: ver.out, binJs }
}
