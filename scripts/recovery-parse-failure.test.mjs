/**
 * parseFailure / sanitizeLog 单测。样本形态取自 dsh fail-loud 链路
 * （packages/boot/app-boot/src/index.ts 的 assertEntriesLoaded/installFailLoud
 * 输出格式）与 smoke.mjs 的 URL 行。
 * 用法：npm run build && node scripts/recovery-parse-failure.test.mjs
 */
import assert from 'node:assert/strict'
import { parseFailure, sanitizeLog } from '../dist/recovery/parse-failure.js'

const PLUGIN_FAIL = [
  '[loader] plugin my-dsh-plugin failed: TypeError: Cannot read properties of undefined (reading "foo")',
  '    at Object.apply (some/plugin.js:12:34)',
  'dsh: plugin(s) failed to load: my-dsh-plugin, another-broken; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)',
  'dsh: fatal load failure: Error: dsh: plugin(s) failed to load: my-dsh-plugin, another-broken; ...',
].join('\n')

// 插件失败：点名插件列表
{
  const d = parseFailure(PLUGIN_FAIL)
  assert.equal(d.kind, 'plugin-load-failure')
  assert.deepEqual(d.plugins, ['my-dsh-plugin', 'another-broken'])
}

// dsh 0.1.2-rc.1 实测的 import 阶段形态（plugin tree 变体，点名单个插件）
{
  const REAL_IMPORT_FAIL = [
    'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry deepseek-harness-background (deepseek-harness-background): The requested module \'@deepseek-ai/dsh-settings\' does not provide an export named \'settingsNamespace\'',
    '    at #asyncInstantiate (node:internal/modules/esm/module_job:326:21)',
  ].join('\n')
  const d = parseFailure(REAL_IMPORT_FAIL)
  assert.equal(d.kind, 'plugin-load-failure')
  assert.deepEqual(d.plugins, ['deepseek-harness-background'])
}

// 端口冲突
{
  const d = parseFailure('Error: listen EADDRINUSE: address already in use 127.0.0.1:3080')
  assert.equal(d.kind, 'port-conflict')
}

// 未知：只给 unknown，不猜
{
  assert.deepEqual(parseFailure('some random output\nwith no known signature'), { kind: 'unknown' })
  assert.deepEqual(parseFailure(''), { kind: 'unknown' })
}

// 插件失败优先于端口特征（同文本两者都在时按更具体的插件失败判定）
{
  const d = parseFailure(PLUGIN_FAIL + '\nError: listen EADDRINUSE: address already in use')
  assert.equal(d.kind, 'plugin-load-failure')
}

// 脱敏：token 值打码，其余保留
assert.equal(
  sanitizeLog('dsh web: http://127.0.0.1:3080/?token=SECRET123'),
  'dsh web: http://127.0.0.1:3080/?token=***',
)
assert.equal(
  sanitizeLog('url: http://127.0.0.1:3080/?token=S1&port=2 (LAN: http://192.168.1.2:3080/?token=S2)'),
  'url: http://127.0.0.1:3080/?token=***&port=2 (LAN: http://192.168.1.2:3080/?token=***)',
)
// 无 token 的文本原样
assert.equal(sanitizeLog('plain log line\nanother'), 'plain log line\nanother')

console.log('recovery-parse-failure OK')
