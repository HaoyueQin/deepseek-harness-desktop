/**
 * 插件清单纯函数单测：listPlugins（deps/bundles/版本/禁用态/保护/系统组件过滤）。
 * 用法：npm run build && node scripts/recovery-plugins.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listPlugins } from '../dist/recovery/plugins.js'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-plugins-test-'))
const web = join(tmp, 'profiles', 'web')
const nm = join(web, 'node_modules')
for (const [pkg, version] of [
  ['demo-plugin', '1.2.3'], ['@deepseek-ai/dsh-base', '0.1.0'], ['dshmarket', '2.0.0'],
]) {
  mkdirSync(join(nm, pkg), { recursive: true })
  writeFileSync(join(nm, pkg, 'package.json'), JSON.stringify({ version }), 'utf8')
}
writeFileSync(join(web, 'package.json'), JSON.stringify({
  dependencies: {
    '@deepseek-ai/dsh-base': '0.1.0', 'demo-plugin': '^1.0.0', 'dshmarket': '^2.0.0',
    'dsh-desktop-integration': 'file:resources',
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-plugin'] } },
}), 'utf8')
writeFileSync(join(web, 'cordis.patch.yml'), [
  '- insert:', '    - id: demo-main', '      name: demo-plugin',
  '- id: demo-main', '  disabled: true',
].join('\n'), 'utf8')
writeFileSync(join(nm, 'demo-plugin', 'package.json'), JSON.stringify({
  version: '1.2.3', dsh: { bundle: { patch: './bundle.yml' } },
}), 'utf8')
writeFileSync(join(nm, 'demo-plugin', 'bundle.yml'), '- insert:\n    - id: demo-main\n      name: demo-plugin\n', 'utf8')

const list = listPlugins(web)
assert.equal(list.length, 4)
const byName = Object.fromEntries(list.map((p) => [p.name, p]))
assert.equal(byName['demo-plugin'].disabled, true)
assert.equal(byName['demo-plugin'].inBundles, true)
assert.equal(byName['demo-plugin'].version, '1.2.3')
assert.equal(byName['dshmarket'].inBundles, false)
assert.equal(byName['dshmarket'].protected, false)
assert.equal(byName['@deepseek-ai/dsh-base'].official, true)
assert.equal(byName['dsh-desktop-integration'].system, true)

rmSync(tmp, { recursive: true, force: true })
console.log('recovery-plugins OK')
