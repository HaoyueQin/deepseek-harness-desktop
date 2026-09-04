/**
 * 版本清单纯函数单测：listNpmVersions（排序/渠道标注/当前与新旧标记）。
 * 用法：npm run build && node scripts/recovery-versions.test.mjs
 */
import assert from 'node:assert/strict'
import { listNpmVersions } from '../dist/dsh-versions.js'

const VERSIONS = [
  '0.1.0-rc.1', '0.1.0', '0.1.1-rc.1', '0.1.1', '0.1.2-alpha.1',
  '0.1.2-alpha.5', '0.1.2-rc.1', '0.1.2', 'not-a-version',
]
const DIST_TAGS = { latest: '0.1.2', alpha: '0.1.2-alpha.5', next: '0.1.2-rc.1' }

// 排序降序 + 非法版本过滤
const list = listNpmVersions(VERSIONS, DIST_TAGS, '0.1.1')
assert.equal(list.length, 8)
assert.equal(list[0].version, '0.1.2')
assert.equal(list[list.length - 1].version, '0.1.0-rc.1')

// 渠道标注：latest / alpha / next
const top = list[0]
assert.deepEqual(top.tags, ['latest'])
assert.ok(list.some(v => v.version === '0.1.2-alpha.5' && v.tags.includes('alpha')))
assert.ok(list.some(v => v.version === '0.1.2-rc.1' && v.tags.includes('next')))
assert.equal(list.find(v => v.version === '0.1.0').tags.length, 0) // 历史版本无 tag

// 当前与新旧标记
assert.equal(list.find(v => v.version === '0.1.1').isCurrent, true)
assert.equal(top.isCurrent, false)
assert.equal(top.isOlder, false)
assert.equal(list.find(v => v.version === '0.1.0').isOlder, true)
assert.equal(list.find(v => v.version === '0.1.2-rc.1').isOlder, false)

// 重复版本去重
const dup = listNpmVersions(['0.1.2', '0.1.2'], DIST_TAGS, '0.1.1')
assert.equal(dup.length, 1)

console.log('recovery-versions OK')
