/**
 * compareVersions 单测：semver 比较（含 prerelease 数值段）。
 * 用法：npm run build && node --test scripts/version-compare.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareVersions } from '../dist/dsh-locator.js'

test('核心版本号逐段比较', () => {
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1)
  assert.equal(compareVersions('0.1.9', '0.2.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
})

test('prerelease 低于正式版', () => {
  assert.equal(compareVersions('0.1.1-rc.1', '0.1.1') < 0, true)
  assert.equal(compareVersions('0.1.1', '0.1.1-rc.1') > 0, true)
})

test('prerelease 数字段按数值比较（rc.10 > rc.9）', () => {
  assert.equal(compareVersions('0.1.1-rc.10', '0.1.1-rc.9') > 0, true)
  assert.equal(compareVersions('0.1.1-rc.8', '0.1.1-rc.10') < 0, true)
})

test('跨 minor 的 prerelease 比较', () => {
  assert.equal(compareVersions('0.1.1-rc.1', '0.1.0-rc.8') > 0, true)
  assert.equal(compareVersions('0.1.0-rc.8', '0.1.1-rc.1') < 0, true)
})

test('git tag 语义（剥离 dsh-v 前缀后比较，源码更新器用）', () => {
  assert.equal(compareVersions('0.1.2-alpha.1', '0.1.1-rc.2') > 0, true)
  assert.equal(compareVersions('0.1.2-alpha.1', '0.1.2') < 0, true)
  assert.equal(compareVersions('0.1.2-alpha.1', '0.1.2-alpha.1'), 0)
  assert.equal(compareVersions('0.1.2-alpha.2', '0.1.2-alpha.1') > 0, true)
  assert.equal(compareVersions('0.1.1-alpha.1', '0.1.1-rc.1') < 0, true) // 字典序 alpha < rc，同 semver 惯例
})
