/**
 * 恢复页主题偏好解析单测：parseThemePreference（settings.yaml YAML/JSON 两种形态）。
 * 用法：npm run build && node scripts/recovery-theme.test.mjs
 */
import assert from 'node:assert/strict'
import { parseThemePreference } from '../dist/recovery/theme.js'

// YAML block 形态：三值全取
assert.equal(parseThemePreference('ui-theme:\n  preference: dark\n  fontSize: 14\n'), 'dark')
assert.equal(parseThemePreference('ui-theme:\n  preference: light\n'), 'light')
assert.equal(parseThemePreference('ui-theme:\n  preference: system\n'), 'system')

// JSON 形态（settings.json / YAML JSON 子集）
assert.equal(parseThemePreference('{"ui-theme":{"preference":"dark","fontSize":14}}'), 'dark')

// YAML flow 单行兜底
assert.equal(parseThemePreference('ui-theme: {preference: light, fontSize: 14}'), 'light')

// ui-theme 段不在首行、前后有其他 namespace
assert.equal(
  parseThemePreference([
    '# harness settings',
    'other:\n  key: value',
    'ui-theme:\n  preference: dark',
    'agent:\n  model: x',
  ].join('\n')),
  'dark',
)

// 注释与引号
assert.equal(parseThemePreference('ui-theme:\n  # 用户主题偏好\n  preference: "system"  # 行尾注释\n'), 'system')

// 缺失/非法 → null（降级系统主题的入口）
assert.equal(parseThemePreference(''), null)
assert.equal(parseThemePreference('   '), null)
assert.equal(parseThemePreference('other-section:\n  preference: dark\n'), null) // 非 ui-theme 段不误取
assert.equal(parseThemePreference('ui-theme:\n  preference: blue\n'), null) // 非法值
assert.equal(parseThemePreference('ui-theme:\n  fontSize: 14\n'), null) // 段存在但无 preference
assert.equal(parseThemePreference('{"ui-theme":{"fontSize":14}}'), null) // JSON 段无 preference
assert.equal(parseThemePreference('ui-theme:\n  preference: Dark\n'), null) // 大小写敏感

console.log('recovery-theme OK')
