/**
 * 恢复上下文状态单测：进入/读取/清除与覆盖语义。
 * 用法：npm run build && node scripts/recovery-state.test.mjs
 */
import assert from 'node:assert/strict'
import { enterRecovery, getRecoveryContext, clearRecoveryContext } from '../dist/recovery/state.js'

clearRecoveryContext()
assert.equal(getRecoveryContext(), null)

const first = enterRecovery({
  kind: 'crashed', code: 1, signal: null, outputTail: 'log',
  diagnosis: { kind: 'unknown' }, dshVersion: '0.1.2-rc.1', dshSource: 'npm-global',
})
assert.equal(getRecoveryContext()?.kind, 'crashed')
assert.ok(typeof first.enteredAt === 'string' && first.enteredAt !== '')

// 再进入覆盖旧上下文（最新为准）
enterRecovery({
  kind: 'boot-failed', code: null, signal: null, outputTail: '',
  diagnosis: { kind: 'unknown' }, dshVersion: '0.1.2-rc.1', dshSource: null,
})
assert.equal(getRecoveryContext()?.kind, 'boot-failed')

clearRecoveryContext()
assert.equal(getRecoveryContext(), null)

console.log('recovery-state OK')
