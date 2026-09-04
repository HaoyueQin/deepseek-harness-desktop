/**
 * 恢复页主题解析：从 dsh 的持久化设置读取明暗偏好（纯函数，无 electron 依赖）。
 *
 * dsh 的 ui-theme 插件把 preference（light|dark|system）存进
 * `$DSH_HOME/settings.yaml`（默认；JSON 形态亦可），namespace 键为 `ui-theme`
 * （事实来源：dsh 仓库 packages/client/ui-theme/src/theme-settings.ts 与
 * packages/settings/settings-file/src/index.ts，见交接文档 §3 2026-09-05 记录）。
 *
 * 恢复页在 dsh 崩溃/未启动时加载，无法向活体服务查询，只能直接读该文件；
 * 解析失败或字段缺失返回 null，由调用方降级为系统主题（Electron
 * nativeTheme / CSS prefers-color-scheme）。
 */

export type ThemePreference = 'light' | 'dark' | 'system'

const PREFERENCES = new Set(['light', 'dark', 'system'])

/** 从 YAML/JSON 形态的 settings 文本中取 `ui-theme.preference`；缺失/非法返回 null。 */
export function parseThemePreference(text: string): ThemePreference | null {
  const trimmed = text.trim()
  if (trimmed === '') return null

  // JSON 形态（settings.yaml 的 JSON 子集；默认 settings.yaml 是 block 形态，
  // JSON.parse 会失败 → 落入下方 YAML 扫描）。
  try {
    const doc = JSON.parse(trimmed) as Record<string, unknown>
    const section = doc['ui-theme']
    if (typeof section === 'object' && section !== null && !Array.isArray(section)) {
      const p = (section as Record<string, unknown>)['preference']
      return typeof p === 'string' && PREFERENCES.has(p) ? (p as ThemePreference) : null
    }
    return null
  } catch {
    // 不是 JSON，按 YAML block 形态扫描
  }

  // YAML 单行 flow 形态兜底：`ui-theme: {preference: dark, ...}`
  const flow = /ui-theme:\s*\{[^}]*\bpreference\s*:\s*['"]?(light|dark|system)['"]?/i.exec(trimmed)
  if (flow !== null) return flow[1] as ThemePreference

  // YAML block 形态：顶层 `ui-theme:` 段内的 `preference: <值>`（0 缩进 = 离开本段）。
  let inSection = false
  for (const line of trimmed.split(/\r?\n/)) {
    const indent = line.match(/^ */)?.[0].length ?? 0
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    if (!inSection) {
      if (indent === 0 && /^ui-theme\s*:(\s|$)/.test(t)) inSection = true
      continue
    }
    if (indent === 0) break
    const m = t.match(/^preference\s*:\s*(['"]?)(light|dark|system)\1\s*(?:#.*)?$/)
    if (m !== null) return m[2] as ThemePreference
  }
  return null
}
