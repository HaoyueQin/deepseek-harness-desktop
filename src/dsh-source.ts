/**
 * Git 源码后端来源：目录校验、版本读取、spawn 参数构造。
 *
 * 源码启动是通用能力，不绑定任何特定版本：spawn 形态
 * `node --import tsx/esm apps/cli/src/bin.ts web …`（cwd=仓库根）已实证
 * 对 dsh-v0.1.0-rc.8 ～ dsh-v0.1.2-alpha.5 逐字一致（根 package.json 的
 * "dsh" script、tsx devDep、入口路径四 tag 相同）；一切版本差异（URL token、
 * --no-open）由调用方按 readSourceVersion 的版本号门控，与本模块无关。
 *
 * 启动硬前提（阻断项，缺一不可）：
 * 1. apps/cli/package.json 可读（取版本号）
 * 2. node_modules/tsx 存在（--import tsx/esm 从 cwd 解析，需先 pnpm install）
 * 3. apps/web/dist/index.html 存在（旧版缺 dist 启动即 throw、alpha.1+ 缺 dist
 *    白屏——统一前置拦截，要求先跑过一次 `pnpm build`）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions, type LocatedDsh } from './dsh-locator.js'

/** 上游官方仓库地址的判别片段（origin 或 upstream 指向它才支持在线更新）。 */
const OFFICIAL_REPO_FRAGMENT = 'deepseek-ai/deepseek-harness'

/** 官方仓库克隆地址（引导页「克隆仓库」用）。 */
export const OFFICIAL_REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

/** git tag 形如 dsh-v0.1.2-alpha.1；前缀剥离后才是 semver。 */
const TAG_RE = /^dsh-v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/

export interface SourceValidation {
  /** 三项阻断前提全部满足。 */
  ok: boolean
  /** apps/cli/package.json 的 version；不可读时为 ''。 */
  version: string
  /** 阻断项缺失清单（面向用户的中文描述）。 */
  missing: string[]
  /** 非阻断警告（.git/remote、pnpm 可用性——只影响在线更新功能）。 */
  warnings: string[]
}

/** 读取源码目录的 dsh 版本（apps/cli/package.json）；不可读返回 ''。 */
export function readSourceVersion(dir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'apps', 'cli', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch {
    return ''
  }
}

/**
 * 从 git tag 列表（原样 tag 名）取 semver 最新的一个；无合法 tag 返回 null。
 * 纯函数，源码更新器与单测共用。
 */
export function pickLatestTag(tags: string[]): string | null {
  let best: { tag: string; ver: string } | null = null
  for (const tag of tags) {
    const m = TAG_RE.exec(tag)
    if (m === null) continue
    if (best === null || compareVersions(m[1], best.ver) > 0) best = { tag, ver: m[1] }
  }
  return best?.tag ?? null
}

/** tag 名 → 版本号（不合法返回 null）。 */
export function tagVersion(tag: string): string | null {
  return TAG_RE.exec(tag)?.[1] ?? null
}

export function isOfficialRemoteUrl(url: string): boolean {
  return url.replace(/\.git$/i, '').toLowerCase().includes(OFFICIAL_REPO_FRAGMENT)
}

/**
 * 源码目录的 spawn argv 前缀（node 之后的参数）：经 tsx 直跑 TS 源码入口。
 * 调用方在其后追加 'web' 与透传参数，并以 dir 为 cwd。
 */
export function sourceEntryArgs(dir: string): string[] {
  return ['--import', 'tsx/esm', join(dir, 'apps', 'cli', 'src', 'bin.ts')]
}

/** 校验通过的源码目录 → LocatedDsh；校验失败返回 null。 */
export function locateSourceDsh(dir: string): LocatedDsh | null {
  const v = validateSourceDir(dir)
  if (!v.ok || v.version === '') return null
  const [importFlag, loader, entry] = sourceEntryArgs(dir)
  return { version: v.version, binJs: entry, source: 'git-local', nodeArgs: [importFlag, loader], cwd: dir }
}

/** .git/config 里全部 remote url（.git 是 worktree 指针文件等情况返回 []）。 */
function readRemoteUrls(dir: string): string[] {
  try {
    const config = readFileSync(join(dir, '.git', 'config'), 'utf8')
    return [...config.matchAll(/^\s*url\s*=\s*(.+)$/gm)].map((m) => m[1].trim())
  } catch {
    return []
  }
}

/** `pnpm --version` 是否可用（Windows 下 pnpm 是 .cmd shim，经 ComSpec 解析）。 */
export function pnpmAvailable(): boolean {
  const isWin = process.platform === 'win32'
  const r = spawnSync(isWin ? process.env.ComSpec ?? 'cmd' : 'pnpm',
    isWin ? ['/d', '/s', '/c', 'pnpm --version'] : ['--version'],
    { encoding: 'utf8', windowsHide: true })
  return r.status === 0 && (r.stdout ?? '').trim() !== ''
}

/**
 * 校验源码目录是否可启动。checkPnpm 默认 false（boot 解析路径不付 spawn 开销，
 * pnpm 只影响在线更新；设置页 UI 校验时传 true 以显示完整警告）。
 * pnpmProbe 仅供单测注入，生产用默认实现。
 */
export function validateSourceDir(
  dir: string,
  opts: { checkPnpm?: boolean; pnpmProbe?: () => boolean } = {},
): SourceValidation {
  const missing: string[] = []
  const version = readSourceVersion(dir)
  if (version === '') missing.push('不是 dsh 源码仓库（缺 apps/cli/package.json 或版本号不可读）')
  if (!existsSync(join(dir, 'node_modules', 'tsx'))) missing.push('依赖未安装（缺 node_modules/tsx，请在源码目录执行 pnpm install）')
  if (!existsSync(join(dir, 'apps', 'web', 'dist', 'index.html'))) missing.push('前端未构建（缺 apps/web/dist，请在源码目录执行 pnpm build）')

  const warnings: string[] = []
  if (!existsSync(join(dir, '.git'))) {
    warnings.push('不是 git 仓库（.git 不存在），无法使用在线检查更新/下载更新')
  } else {
    const urls = readRemoteUrls(dir)
    if (urls.length === 0) {
      warnings.push('无法读取 git remote（.git/config），在线更新不可用')
    } else if (!urls.some(isOfficialRemoteUrl)) {
      warnings.push('git remote 不指向 deepseek-ai/deepseek-harness，在线更新不可用')
    }
  }
  if (opts.checkPnpm === true && !(opts.pnpmProbe ?? pnpmAvailable)()) {
    warnings.push('未检测到 pnpm 命令，下载更新（pnpm install/build）不可用')
  }

  return { ok: missing.length === 0, version, missing, warnings }
}
