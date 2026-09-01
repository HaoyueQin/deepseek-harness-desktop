/**
 * npm dist-tags → 后端更新目标选择（纯函数，无 electron 依赖，可被 `node --test`
 * 直测 dist 产物）。dist-tags 形如 {"latest":"0.1.1-rc.2","alpha":"0.1.2-alpha.4"}。
 *
 * 语义：取全部 tag 值中高于 current 的最高版本（含 alpha/next 等预发布渠道）；
 * 无更高版本返回 null——当前已是最高时不提示「降级到 latest」，曾因缺这层
 * 比较，用户安装 alpha.2 后被提示一键「升级」回 rc.2 稳定版。
 */

import { compareVersions } from './dsh-locator.js'

/** npm 版本串白名单（semver：核心 3 段 + 可选预发布/构建元数据）；防注入命令行。 */
export const SEMVER_RE = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/

export interface UpdateTarget {
  /** 目标版本。 */
  version: string
  /** 目标高于 latest 稳定版（来自 alpha/next 等预发布 tag）。 */
  prerelease: boolean
}

export function resolveUpdateTarget(
  distTags: Record<string, string>,
  current: string,
): UpdateTarget | null {
  let best: string | null = null
  for (const v of new Set(Object.values(distTags))) {
    if (!SEMVER_RE.test(v) || compareVersions(v, current) <= 0) continue
    if (best === null || compareVersions(v, best) > 0) best = v
  }
  if (best === null) return null
  const stable = distTags.latest
  return { version: best, prerelease: stable === undefined || compareVersions(best, stable) > 0 }
}
