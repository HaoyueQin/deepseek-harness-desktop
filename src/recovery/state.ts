/**
 * 恢复上下文（模块级单例）：进入恢复页的原因与诊断材料（handover §7.2）。
 * 纯状态模块，不依赖 electron；脱敏后的快照由调用方（main.ts）组装进来。
 */
import type { FailureDiagnosis } from './parse-failure.js'

export type RecoveryContextKind = 'crashed' | 'boot-failed' | 'maintenance'

export interface RecoveryContext {
  kind: RecoveryContextKind
  code: number | null
  signal: string | null
  /** 已脱敏（sanitizeLog）的输出快照。 */
  outputTail: string
  diagnosis: FailureDiagnosis
  dshVersion: string
  dshSource: 'npm-global' | 'git-local' | null
  /** 进入目的：'update' = 版本更新交接（页面不渲染异常观感，聚焦更新进度）。 */
  purpose?: 'update'
  enteredAt: string
}

export type RecoveryInput = Omit<RecoveryContext, 'enteredAt'>

let current: RecoveryContext | null = null

/** 进入（或覆盖）恢复上下文。 */
export function enterRecovery(input: RecoveryInput): RecoveryContext {
  current = { ...input, enteredAt: new Date().toISOString() }
  return current
}

export function getRecoveryContext(): RecoveryContext | null {
  return current
}

/** 重启成功回 NORMAL 前清除。 */
export function clearRecoveryContext(): void {
  current = null
}
