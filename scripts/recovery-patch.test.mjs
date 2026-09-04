/**
 * 补丁层读写单测：解析/行归属/disabled 追加与幂等/placeholder/拒绝路径。
 * 用法：npm run build && node scripts/recovery-patch.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parsePatchRows, bundlePatchInsertedIds, readUserPatchState,
  rowIdsForPackage, disableRow, enableRow, isProtectedModule,
} from '../dist/recovery/patch.js'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-patch-test-'))
const profileDir = join(tmp, 'profiles', 'web')
mkdirSync(join(profileDir, 'node_modules', 'demo-plugin'), { recursive: true })

// --- 解析：insert 子块 id 归属（#147 语义） ---
const rows = parsePatchRows([
  '- insert:', '    - id: demo-main', '      name: demo-plugin',
  '    - id: attachment-local', '      config: { maxBytes: 999 }',
  '- id: attachment-local', '  disabled: true',
].join('\n'))
assert.deepEqual(rows.insertedIds, ['demo-main', 'attachment-local'])
assert.deepEqual(rows.ids, ['demo-main', 'attachment-local', 'attachment-local'])

// --- bundlePatchInsertedIds：声明文件与包根 ---
writeFileSync(join(profileDir, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({
  version: '1.0.0', dsh: { bundle: { patch: './bundle.yml' } },
}), 'utf8')
writeFileSync(join(profileDir, 'node_modules', 'demo-plugin', 'bundle.yml'),
  '- insert:\n    - id: demo-main\n      name: demo-plugin\n')
assert.deepEqual(bundlePatchInsertedIds(join(profileDir, 'node_modules', 'demo-plugin')), ['demo-main'])

// --- rowIdsForPackage：声明 + 惯例路径合并去重 ---
writeFileSync(join(profileDir, 'node_modules', 'demo-plugin', 'cordis.patch.yml'),
  '- insert:\n    - id: demo-extra\n      name: demo-plugin\n')
assert.deepEqual(rowIdsForPackage(profileDir, 'demo-plugin'), ['demo-extra', 'demo-main'])

// --- readUserPatchState：disabled/forced/inserts 行扫描 ---
const patchPath = join(profileDir, 'cordis.patch.yml')
writeFileSync(patchPath, [
  '# header', '- insert:', '    - id: a', '      name: x',
  '- id: demo-main', '  disabled: true', '- id: demo-extra', '  disabled: false',
].join('\n'), 'utf8')
const state = readUserPatchState(patchPath)
assert.deepEqual(state.disables, ['demo-main'])
assert.deepEqual(state.forced, ['demo-extra'])
assert.deepEqual(state.inserts, ['a'])

// --- disableRow：追加、幂等 ---
{
  const p = join(profileDir, 'empty.yml')
  writeFileSync(p, '', 'utf8')
  const r1 = await disableRow(p, 'demo-main')
  assert.equal(r1.ok, true)
  assert.match(readFileSync(p, 'utf8'), /^- id: demo-main\n  disabled: true\n$/)
  const r2 = await disableRow(p, 'demo-main')
  assert.equal(r2.ok, true)
  assert.equal(readFileSync(p, 'utf8').match(/disabled: true/g)?.length, 1)
}
// --- disableRow：[] placeholder 注释化 + 追加 ---
{
  const p = join(profileDir, 'ph.yml')
  writeFileSync(p, '# Your patch layer...\n[]\n', 'utf8')
  const r = await disableRow(p, 'ph-id')
  assert.equal(r.ok, true)
  const text = readFileSync(p, 'utf8')
  assert.match(text, /^# \[\]\n/m)
  assert.match(text, /^- id: ph-id\n  disabled: true\n$/m)
}
// --- disableRow：顶层 flow 与非法列表拒绝且不改文件 ---
{
  const p = join(profileDir, 'flow.yml')
  writeFileSync(p, '[1, 2]\n', 'utf8')
  const before = readFileSync(p, 'utf8')
  const r = await disableRow(p, 'bad')
  assert.equal(r.ok, false)
  assert.equal(readFileSync(p, 'utf8'), before)
  const p2 = join(profileDir, 'broken.yml')
  writeFileSync(p2, 'not: [valid\n[[', 'utf8')
  const before2 = readFileSync(p2, 'utf8')
  const r2 = await disableRow(p2, 'bad')
  assert.equal(r2.ok, false)
  assert.equal(readFileSync(p2, 'utf8'), before2)
}
// --- enableRow：删除 disabled 块；无块时追加 disabled: false ---
{
  const p = join(profileDir, 'en.yml')
  writeFileSync(p, '# h\n- id: demo-main\n  disabled: true\n', 'utf8')
  const r = await enableRow(p, 'demo-main')
  assert.equal(r.ok, true)
  assert.equal(readFileSync(p, 'utf8').includes('disabled: true'), false)
  const p2 = join(profileDir, 'en2.yml')
  writeFileSync(p2, '# only comments\n', 'utf8')
  const r2 = await enableRow(p2, 'demo-main')
  assert.equal(r2.ok, true)
  assert.match(readFileSync(p2, 'utf8'), /^- id: demo-main\n  disabled: false\n$/m)
}
// --- 保护名单 ---
assert.equal(isProtectedModule('@deepseek-ai/dsh-settings-file'), true)
assert.equal(isProtectedModule('@deepseek-ai/dsh-session'), true)
assert.equal(isProtectedModule('dshmarket'), false)
assert.equal(isProtectedModule('@deepseek-ai/cordis-plugin-timer'), true)

rmSync(tmp, { recursive: true, force: true })
console.log('recovery-patch OK')
