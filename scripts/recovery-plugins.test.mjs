/**
 * 插件清单纯函数单测：listPlugins（deps/bundles/版本/禁用态/保护/系统组件过滤）。
 * 用法：npm run build && node scripts/recovery-plugins.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  disablePlugin, enablePlugin, isReservedProfile, isValidPluginName,
  listPlugins, parseOutdatedJson, pluginCliArgs, readPatchReload,
} from '../dist/recovery/plugins.js'

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

// --- parseOutdatedJson：真实 pnpm 输出形态（dependencies 取 latest，devDeps 过滤）---
{
  const sample = JSON.stringify({
    'deepseek-harness-background': { current: '0.5.0', latest: '0.5.3', wanted: '0.5.0', isDeprecated: false, dependencyType: 'dependencies' },
    electron: { current: '43.4.0', latest: '44.1.1', wanted: '43.4.0', isDeprecated: false, dependencyType: 'devDependencies' },
  })
  assert.deepEqual(parseOutdatedJson(sample), { 'deepseek-harness-background': '0.5.3' })
}
// 无过期 / 非法 / 非对象输出 → 空表（pnpm 有过期时 exit 1，解析不依赖 exit code）
assert.deepEqual(parseOutdatedJson('{}'), {})
assert.deepEqual(parseOutdatedJson(''), {})
assert.deepEqual(parseOutdatedJson('not json'), {})
assert.deepEqual(parseOutdatedJson('[]'), {})
assert.deepEqual(parseOutdatedJson(JSON.stringify({ x: { latest: '1.0.0', dependencyType: 'dependencies' } })), { x: '1.0.0' })

// --- 官方桌面独占 profile 隔离（0.1.5-alpha.1 起上游 rejectElectronProfile）：大小写不敏感 ---
// desktop 同形 fixture：含 dependencies + node_modules 可禁用行。没有它，空目录
// 本来就返回 []，断言无法区分守卫与空目录（删守卫仍绿）；seed 后唯有守卫能致空。
const desktop = join(tmp, 'profiles', 'desktop')
const dnm = join(desktop, 'node_modules')
mkdirSync(join(dnm, 'demo-plugin'), { recursive: true })
writeFileSync(join(desktop, 'package.json'), JSON.stringify({
  dependencies: { 'demo-plugin': '^1.0.0' },
  dsh: { profile: { bundles: ['demo-plugin'] } },
}), 'utf8')
writeFileSync(join(dnm, 'demo-plugin', 'package.json'), JSON.stringify({
  version: '1.2.3', dsh: { bundle: { patch: './bundle.yml' } },
}), 'utf8')
writeFileSync(join(dnm, 'demo-plugin', 'bundle.yml'), '- insert:\n    - id: demo-main\n      name: demo-plugin\n', 'utf8')

assert.equal(isReservedProfile('desktop'), true)
assert.equal(isReservedProfile('Desktop'), true)
assert.equal(isReservedProfile('DESKTOP'), true)
assert.equal(isReservedProfile('web'), false)
assert.equal(isReservedProfile(''), false)
assert.equal(isReservedProfile('desktop.txt'), false)
assert.equal(isReservedProfile('mydesktop'), false)
assert.equal(isReservedProfile(' desktop'), false) // 不 trim，与上游精确相等保持 parity
assert.equal(isReservedProfile(undefined), false)
assert.equal(isReservedProfile(null), false)
// seeded desktop 仍空表：唯守卫可致（删 plugins.ts:60 早退则此处为 1 项）。
assert.deepEqual(listPlugins(desktop), [])
// 尾斜杠经 basename 归一，同样隔离（注：Windows 文件系统大小写不敏感，
// 不另建 'Desktop' 目录，用同目录尾斜杠覆盖路径层）。
assert.deepEqual(listPlugins(desktop + '/'), [])
// 开关拒绝：ok:false + patch 未被创建（删 applyToggle 首行则此处 ok:true）。
{
  const r1 = await disablePlugin(desktop, 'demo-plugin')
  assert.equal(r1.ok, false)
  assert.deepEqual(r1.applied, [])
  assert.equal(r1.disabledCount, 0)
  assert.match(r1.reason ?? '', /独占/)
  const r2 = await enablePlugin(desktop, 'demo-plugin')
  assert.equal(r2.ok, false)
  assert.deepEqual(r2.applied, [])
  assert.match(r2.reason ?? '', /独占/)
  assert.equal(existsSync(join(desktop, 'cordis.patch.yml')), false)
}

// --- readPatchReload：补丁层重载策略（live = 写入即热生效 / startup = 仅启动时）---
// web fixture 的 dsh.profile 无 patchReload 字段 → 与上游默认一致取 live
assert.equal(readPatchReload(web), 'live')
// 未初始化的 profile 目录（无 manifest）同样按上游默认 live
assert.equal(readPatchReload(join(tmp, 'profiles', 'missing')), 'live')
{
  const mk = (name, manifest) => {
    const dir = join(tmp, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), manifest, 'utf8')
    return dir
  }
  assert.equal(readPatchReload(mk('startup-prof', JSON.stringify({ dsh: { profile: { bundles: [], patchReload: 'startup' } } }))), 'startup')
  assert.equal(readPatchReload(mk('live-prof', JSON.stringify({ dsh: { profile: { bundles: [], patchReload: 'live' } } }))), 'live')
  // 非法值：上游 fail-loud 拒绝启动，壳保守按 startup（不承诺热生效）
  assert.equal(readPatchReload(mk('bogus-prof', JSON.stringify({ dsh: { profile: { patchReload: 'sometimes' } } }))), 'startup')
  // manifest 损坏 → 读不到字段，回落到默认 live（与 dsh 的 readJson 失败语义无关：
  // 此时 dsh 也起不来，live 只影响提示文案，不影响写入行为）
  assert.equal(readPatchReload(mk('corrupt-prof', '{ not json')), 'live')
}

// --- pluginCliArgs 写死 web：永不构造 desktop（改 'web' 为 'desktop' 即红）---
assert.deepEqual(pluginCliArgs('remove', 'x'), ['plugin', '--profile', 'web', 'remove', 'x'])
assert.deepEqual(pluginCliArgs('update', '@scope/name'), ['plugin', '--profile', 'web', 'update', '@scope/name'])

// --- isValidPluginName 白名单：旗标/穿越/分隔符注入全挡 ---
for (const good of ['demo-plugin', '@scope/name', 'a', 'x.y_z-w']) assert.equal(isValidPluginName(good), true)
for (const bad of ['', '--profile', '-rf', '../evil', 'a;b', 'a/b', '@/x', 'a:b', 'a\\b', '--upload-pack=x']) {
  assert.equal(isValidPluginName(bad), false)
}

rmSync(tmp, { recursive: true, force: true })
console.log('recovery-plugins OK')
