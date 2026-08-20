/**
 * 后端版本范围判定（纯函数，无 electron 依赖，可独立测试）。
 */

/** 判定某版本是否在范围内（可更新目标）。仅支持 ^x.y.z 形式；同 minor 内任何 patch/prerelease 可更新。 */
export function isInRange(version: string, range: string): boolean {
  const m = /^\^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(range)
  if (m === null) return version === range.replace(/^\^/, '')
  const [, maj, min] = m
  const v = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version)
  if (v === null) return false
  return v[1] === maj && v[2] === min
}
