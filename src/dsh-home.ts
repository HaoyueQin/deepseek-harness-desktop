/**
 * dsh 数据目录解析。语义与官方 dsh 的 resolveDshHome 一致：
 * 显式 $DSH_HOME（非空）优先，缺省回退 ~/.dsh。
 * desktop 与 CLI 共享同一份用户数据——终端或界面安装的插件、
 * 设置、凭证、会话互相可见。
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** dsh 默认 home 目录名（官方 DSH_HOME_DIR_NAME）。 */
export const DSH_HOME_DIR_NAME = '.dsh'

/** 覆盖默认 home 的环境变量名（官方 DSH_HOME_ENV）。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** 展开 ~ 前缀（官方 expandHomePath 同语义）。 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 解析 dsh 数据目录：$DSH_HOME（空白视为未设）优先，否则 ~/.dsh。
 * @param env 环境映射（默认 process.env），便于测试注入。
 */
export function resolveDshHomeDir(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected =
    fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME)
  return resolve(expandHomePath(selected))
}

/** 运行期 dsh 数据目录。 */
export function dshHomeDir(): string {
  return resolveDshHomeDir()
}
