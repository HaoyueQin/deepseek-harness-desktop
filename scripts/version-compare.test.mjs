/**
 * compareVersions / resolveUpdateTarget 单测：semver 比较（含 prerelease 数值段）
 * 与 npm dist-tags → 后端更新目标选择。
 * 用法：npm run build && node --test scripts/version-compare.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareVersions } from '../dist/dsh-locator.js'
import { resolveUpdateTarget } from '../dist/dsh-update-target.js'

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

test('dist-tags：预发布高于当前时选中并标记 prerelease', () => {
  assert.deepEqual(
    resolveUpdateTarget({ latest: '0.1.1-rc.2', next: '0.1.1-rc.2', alpha: '0.1.2-alpha.2' }, '0.1.1-rc.2'),
    { version: '0.1.2-alpha.2', prerelease: true },
  )
})

test('dist-tags：稳定版为最高目标时非 prerelease', () => {
  assert.deepEqual(
    resolveUpdateTarget({ latest: '0.1.1-rc.2' }, '0.1.1-rc.1'),
    { version: '0.1.1-rc.2', prerelease: false },
  )
})

test('dist-tags：当前已是最高（含预发布）时无更新', () => {
  assert.equal(resolveUpdateTarget({ latest: '0.1.1-rc.2', alpha: '0.1.2-alpha.2' }, '0.1.2-alpha.2'), null)
})

test('dist-tags：装了预发布版后不提示降级到 latest 稳定版（回归）', () => {
  assert.equal(resolveUpdateTarget({ latest: '0.1.1-rc.2', next: '0.1.1-rc.2' }, '0.1.2-alpha.2'), null)
})

test('dist-tags：非法值与非 semver dist-tag 被过滤', () => {
  assert.deepEqual(
    resolveUpdateTarget({ latest: 'not-a-version', alpha: '0.1.2-alpha.2', old: '0.1.0-rc.8' }, '0.1.0-rc.8'),
    { version: '0.1.2-alpha.2', prerelease: true },
  )
})

test('dist-tags：无 latest 稳定 tag 时按预发布标记；空对象无更新', () => {
  assert.deepEqual(resolveUpdateTarget({ alpha: '0.1.2-alpha.2' }, '0.1.1-rc.2'), { version: '0.1.2-alpha.2', prerelease: true })
  assert.equal(resolveUpdateTarget({}, '0.1.1-rc.2'), null)
})
