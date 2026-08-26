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
  // 参数均为固定字面量（无用户输入）。Windows 下 .cmd shim 需经 ComSpec 解析：
  // shell:true+args 数组在 Node≥22 触发 DEP0190（参数不转义仅拼接，安全隐患），
  // 改为显式 cmd /c（调用方保证参数受控；含动态值的调用方须先过白名单校验）。
  const isWin = process.platform === 'win32'
  const r = spawnSync(isWin ? process.env.ComSpec ?? 'cmd' : cmd,
    isWin ? ['/d', '/s', '/c', [cmd, ...args].join(' ')] : args, {
      encoding: 'utf8',
      windowsHide: true,
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

/**
 * 比较 semver 版本（含 prerelease，如 "0.1.1-rc.1"）。
 * @returns a>b 为 1，a<b 为 -1，相等为 0。
 * 规则：逐段数字比较；无 prerelease 高于有 prerelease；prerelease 按 "."
 * 分段比较，纯数字段按数值、否则按字典序。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string[] | null } => {
    const [core, pre] = v.split('-', 2)
    return {
      nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: pre === undefined ? null : pre.split('.'),
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d > 0 ? 1 : -1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}
