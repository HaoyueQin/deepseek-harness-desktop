/**
 * dsh 后端版本清单（纯函数，无 electron 依赖，可 node --test 直测 dist）。
 * npm 来源：`npm view` 的 versions 数组与 dist-tags 合并，semver 降序、渠道标注。
 * git 来源列表（`listSourceVersions`）在 dsh-source-updater.ts，复用本文件接口。
 */

import { compareVersions } from './dsh-locator.js'
import { SEMVER_RE } from './dsh-update-target.js'

/** 一个可切换版本：版本号 + 渠道标注 + 与当前的关系。 */
export interface BackendVersion {
  /** 版本串（semver；git 来源为 tag 剥离前缀后）。 */
  version: string
  /** 指向该版本的 npm dist-tag 名（如 latest/alpha）；无渠道为空数组。 */
  tags: string[]
  /** 等于当前生效版本。 */
  isCurrent: boolean
  /** 低于当前生效版本（回退确认框判断）。 */
  isOlder: boolean
}

/**
 * npm versions + dist-tags → 降序版本清单。
 * 排序：semver 降序（compareVersions）；非法版本串被过滤；重复版本去重。
 */
export function listNpmVersions(
  versions: string[],
  distTags: Record<string, string>,
  current: string,
): BackendVersion[] {
  const tagByVer = new Map<string, string[]>()
  for (const [tag, ver] of Object.entries(distTags)) {
    const arr = tagByVer.get(ver) ?? []
    arr.push(tag)
    tagByVer.set(ver, arr)
  }
  const unique = [...new Set(versions)].filter((v) => SEMVER_RE.test(v))
  unique.sort((a, b) => compareVersions(b, a))
  return unique.map((v) => ({
    version: v,
    tags: tagByVer.get(v) ?? [],
    isCurrent: v === current,
    isOlder: compareVersions(v, current) < 0,
  }))
}
