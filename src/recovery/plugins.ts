/**
 * profile 插件清单（纯文件，崩溃态可用）与禁用/启用编排。
 * 数据源：`profiles/web/package.json`（dependencies + dsh.profile.bundles）
 * + 各包 node_modules 清单 + 用户补丁层状态（patch.ts）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bundlePatchInsertedIds, disableRow, enableRow, isProtectedModule, readUserPatchState,
} from './patch.js'

/** dsh 官方 in-box bundle（模板自带，恢复页不提供救火）。 */
const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
])

/** 壳注入的桌面集成插件（profiles/node_modules 扁平目录，系统组件不可操作）。 */
export const DESKTOP_SYSTEM_COMPONENT = 'dsh-desktop-integration'

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

export interface ToggleResult {
  ok: boolean
  applied: string[]
  disabledCount: number
  reason: string | null
}

function applyToggle(profileDir: string, name: string, disable: boolean): Promise<ToggleResult> {
  return (async () => {
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

/** `dsh plugin --profile web ...` 的 argv（spawn 时拼在 binJs/nodeArgs 后）。 */
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
