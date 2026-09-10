/**
 * profile 插件清单（纯文件，崩溃态可用）与禁用/启用编排。
 * 数据源：`profiles/web/package.json`（dependencies + dsh.profile.bundles）
 * + 各包 node_modules 清单 + 用户补丁层状态（patch.ts）。
 */

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  bundlePatchInsertedIds, disableRow, enableRow, isProtectedModule, readUserPatchState,
} from './patch.js'

/**
 * dsh 官方 in-box bundle（随船模板包，恢复页不提供卸载/更新救火）。
 * 与上游 PROFILE_TEMPLATES 对齐（acp/web/headless/sdk/sdk-minimal + 公共底座）。
 */
const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-acp-app', '@deepseek-ai/dsh-sdk-app', '@deepseek-ai/dsh-sdk-minimal',
])

/** 壳注入的桌面集成插件（profiles/node_modules 扁平目录，系统组件不可操作）。 */
export const DESKTOP_SYSTEM_COMPONENT = 'dsh-desktop-integration'

/**
 * 官方 Electron 独占的 profile（上游 `rejectElectronProfile`：CLI 拒绝
 * `--profile desktop`，0.1.5-alpha.1 起）。壳写死只用 `web`，此名单是纵深
 * 防御：profileDir 的 basename 若落入此名单，清单/开关一律拒绝，绝不触碰。
 */
export const RESERVED_PROFILES = ['desktop'] as const

/**
 * 是否为官方独占 profile（大小写不敏感，与上游 `rejectElectronProfile` 同语义）。
 * 刻意不 trim/归一化：与上游精确相等保持 parity；profileDir 非 IPC 可控，
 * 生产调用方恒传 `basename`（string），非 string 输入一律返回 false。
 */
export function isReservedProfile(name: string): boolean {
  if (typeof name !== 'string') return false
  return (RESERVED_PROFILES as readonly string[]).includes(name.toLowerCase())
}

export interface PluginInfo {
  name: string
  /** manifest 依赖规格（npm range / link:…）。 */
  spec: string
  version: string | null
  /** 是否在 dsh.profile.bundles（生效层）。 */
  inBundles: boolean
  /** 用户补丁层是否禁用该包全部行。 */
  disabled: boolean
  /** 用户补丁层是否有强启用行（disabled: false）。 */
  forced: boolean
  /** 宿主基础设施模块（保护名单，拒绝禁用）。 */
  protected: boolean
  /** dsh 官方 in-box bundle。 */
  official: boolean
  /** 壳系统组件（dsh-desktop-integration）。 */
  system: boolean
  /** 该包关联的行 id（patch 写目标）。 */
  rowIds: string[]
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return null }
}

export function listPlugins(profileDir: string): PluginInfo[] {
  // 纵深防御：绝不触碰官方桌面独占 profile（正常路径 profileDir 恒为 web）。
  if (isReservedProfile(basename(profileDir))) return []
  const manifest = readJson<{
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: unknown } }
  }>(join(profileDir, 'package.json'))
  const deps = manifest?.dependencies ?? {}
  const bundlesRaw = manifest?.dsh?.profile?.bundles
  const bundles = new Set(Array.isArray(bundlesRaw) ? bundlesRaw.filter((n): n is string => typeof n === 'string') : [])
  const state = readUserPatchState(join(profileDir, 'cordis.patch.yml'))
  return Object.entries(deps).map(([name, spec]) => {
    const pkgManifest = readJson<{ version?: string }>(join(profileDir, 'node_modules', name, 'package.json'))
    const rowIds = bundlePatchInsertedIds(join(profileDir, 'node_modules', name))
    const disabled = rowIds.length > 0 && rowIds.every((id) => state.disables.includes(id))
    return {
      name, spec,
      version: pkgManifest?.version ?? null,
      inBundles: bundles.has(name),
      disabled,
      forced: rowIds.length > 0 && rowIds.some((id) => state.forced.includes(id)),
      protected: isProtectedModule(name),
      official: INBOX_BUNDLES.has(name),
      system: name === DESKTOP_SYSTEM_COMPONENT,
      rowIds,
    }
  })
}

/** 用户补丁层的重载策略（profile manifest 的 `dsh.profile.patchReload`）。 */
export type PatchReload = 'live' | 'startup'

/**
 * profile 的补丁重载策略：'live' = dsh 监视补丁文件，写入后热重组生效（无需
 * 重启）；'startup' = 只在启动时应用。缺省按上游语义取 'live'
 * （dsh 的 DEFAULT_PROFILE_PATCH_RELOAD，既有 profile 省略该字段时同样按 live）；
 * 非法值按 'startup' 保守处理——上游对非法值 fail-loud 拒绝启动，此时壳不承诺热生效。
 */
export function readPatchReload(profileDir: string): PatchReload {
  const manifest = readJson<{ dsh?: { profile?: { patchReload?: unknown } } }>(join(profileDir, 'package.json'))
  const raw = manifest?.dsh?.profile?.patchReload
  if (raw === undefined) return 'live'
  return raw === 'live' ? 'live' : 'startup'
}

export interface ToggleResult {
  ok: boolean
  applied: string[]
  disabledCount: number
  reason: string | null
}

function applyToggle(profileDir: string, name: string, disable: boolean): Promise<ToggleResult> {
  return (async () => {
    if (isReservedProfile(basename(profileDir))) {
      return { ok: false, applied: [], disabledCount: 0, reason: '官方桌面独占 profile，壳不触碰' }
    }
    if (isProtectedModule(name)) {
      return { ok: false, applied: [], disabledCount: 0, reason: '宿主核心模块不允许禁用' }
    }
    const rowIds = bundlePatchInsertedIds(join(profileDir, 'node_modules', name))
    if (rowIds.length === 0) {
      return { ok: false, applied: [], disabledCount: 0, reason: '该插件未声明可禁用的 loader 行（可能是纯客户端组件）' }
    }
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const applied: string[] = []
    for (const id of rowIds) {
      const r = disable ? await disableRow(patchPath, id) : await enableRow(patchPath, id)
      if (!r.ok) return { ok: false, applied, disabledCount: applied.length, reason: r.reason ?? ('行 ' + id + ' 写入失败') }
      applied.push(id)
    }
    return { ok: true, applied, disabledCount: applied.length, reason: null }
  })()
}

export function disablePlugin(profileDir: string, name: string): Promise<ToggleResult> {
  return applyToggle(profileDir, name, true)
}

export function enablePlugin(profileDir: string, name: string): Promise<ToggleResult> {
  return applyToggle(profileDir, name, false)
}

/**
 * `dsh plugin --profile web ...` 的 argv（spawn 时拼在 binJs/nodeArgs 后）。
 * profile 写死为 `web`：绝不触碰官方 Electron 独占的 `desktop` profile
 *（上游 `rejectElectronProfile` 会直接拒绝，0.1.5-alpha.1 起）。
 */
export function pluginCliArgs(action: 'remove' | 'update', name: string): string[] {
  return ['plugin', '--profile', 'web', action, name]
}

/** 不可在恢复页卸载/更新的插件：保护名单 + 官方 in-box bundle + 壳系统组件。 */
export function isImmutablePlugin(name: string): boolean {
  return isProtectedModule(name) || INBOX_BUNDLES.has(name) || name === DESKTOP_SYSTEM_COMPONENT
}

/** npm 包名白名单：挡住 pnpm 旗标注入与相对路径穿越（IPC 边界校验）。 */
export function isValidPluginName(name: string): boolean {
  return /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)
}

/**
 * 解析 `pnpm outdated --json` 输出为 { 插件名: latest 版本 }。
 * 只取生产 dependencies（devDependencies 等不属于插件清单）；非法/空输出
 * 返回空表。pnpm 有过期条目时 exit 1、无条目时输出 {}——解析不依赖 exit code。
 */
export function parseOutdatedJson(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return result
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return result
  for (const [name, info] of Object.entries(data as Record<string, unknown>)) {
    if (typeof info !== 'object' || info === null) continue
    const entry = info as { latest?: unknown; dependencyType?: unknown }
    if (entry.dependencyType !== 'dependencies') continue
    if (typeof entry.latest === 'string' && entry.latest !== '') result[name] = entry.latest
  }
  return result
}
