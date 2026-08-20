/**
 * 后端更新版本范围判定单测。
 * 用法：npm run build && node --test scripts/backend-updater.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isInRange } from '../dist/dsh-updater-range.js'

test('同 minor 的 rc 版本在范围内', () => {
  assert.equal(isInRange('0.1.0-rc.9', '^0.1.0-rc.8'), true)
  assert.equal(isInRange('0.1.0-rc.8', '^0.1.0-rc.8'), true)
  assert.equal(isInRange('0.1.0', '^0.1.0-rc.8'), true)
})

test('跨 minor 不在范围内', () => {
  assert.equal(isInRange('0.2.0', '^0.1.0-rc.8'), false)
})

test('不同 major 不在范围内', () => {
  assert.equal(isInRange('1.0.0', '^0.1.0-rc.8'), false)
})
