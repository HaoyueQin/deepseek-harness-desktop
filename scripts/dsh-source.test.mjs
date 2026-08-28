/**
 * dsh-source 单测：validateSourceDir 用临时目录构造各缺失场景；
 * pickLatestTag / tagVersion 纯函数。
 * 用法：npm run build && node --test scripts/dsh-source.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickLatestTag, sourceEntryArgs, tagVersion, validateSourceDir } from '../dist/dsh-source.js'

/** 造一个"完整可启动"的最小源码目录骨架，测试按需删件。 */
function makeSourceDir(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-src-test-'))
  mkdirSync(join(dir, 'apps', 'cli'), { recursive: true })
  writeFileSync(join(dir, 'apps', 'cli', 'package.json'), JSON.stringify({ version: '0.1.2-alpha.1' }))
  mkdirSync(join(dir, 'node_modules', 'tsx'), { recursive: true })
  mkdirSync(join(dir, 'apps', 'web', 'dist'), { recursive: true })
  writeFileSync(join(dir, 'apps', 'web', 'dist', 'index.html'), '<html></html>')
  mutate?.(dir)
  return dir
}

test('完整目录（含官方 remote）：ok，版本正确，无缺失无警告', () => {
  const dir = makeSourceDir((d) => writeGitConfig(d, 'https://github.com/deepseek-ai/deepseek-harness.git'))
  const v = validateSourceDir(dir)
  assert.equal(v.ok, true)
  assert.equal(v.version, '0.1.2-alpha.1')
  assert.deepEqual(v.missing, [])
  assert.deepEqual(v.warnings, [])
})

test('无 .git：仍可启动，但有在线更新警告', () => {
  const v = validateSourceDir(makeSourceDir())
  assert.equal(v.ok, true)
  assert.equal(v.warnings.length, 1)
  assert.match(v.warnings[0], /git 仓库/)
})

test('空目录：ok=false，三项缺失并列出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-src-test-'))
  const v = validateSourceDir(dir)
  assert.equal(v.ok, false)
  assert.equal(v.version, '')
  assert.equal(v.missing.length, 3)
})

test('缺前端 dist：missing 指向 pnpm build', () => {
  const dir = makeSourceDir((d) => rmrf(join(d, 'apps', 'web', 'dist')))
  const v = validateSourceDir(dir)
  assert.equal(v.ok, false)
  assert.equal(v.missing.length, 1)
  assert.match(v.missing[0], /pnpm build/)
})

test('缺 tsx：missing 指向 pnpm install', () => {
  const dir = makeSourceDir((d) => rmrf(join(d, 'node_modules')))
  const v = validateSourceDir(dir)
  assert.equal(v.ok, false)
  assert.equal(v.missing.length, 1)
  assert.match(v.missing[0], /pnpm install/)
})

test('官方 remote：无 remote 警告；非官方 remote：有警告', () => {
  const official = makeSourceDir((d) => writeGitConfig(d, 'https://github.com/deepseek-ai/deepseek-harness.git'))
  assert.deepEqual(validateSourceDir(official).warnings, [])

  const forked = makeSourceDir((d) => writeGitConfig(d, 'https://github.com/someone/deepseek-harness.git'))
  const vf = validateSourceDir(forked)
  assert.equal(vf.ok, true)
  assert.equal(vf.warnings.length, 1)
  assert.match(vf.warnings[0], /deepseek-ai\/deepseek-harness/)
})

test('checkPnpm=false 不产生 pnpm 警告；注入 probe=true 模拟 pnpm 缺失', () => {
  const dir = makeSourceDir((d) => writeGitConfig(d, 'https://github.com/deepseek-ai/deepseek-harness.git'))
  assert.deepEqual(validateSourceDir(dir).warnings, [])
  const v = validateSourceDir(dir, { checkPnpm: true, pnpmProbe: () => false })
  assert.equal(v.ok, true)
  assert.equal(v.warnings.length, 1)
  assert.match(v.warnings[0], /pnpm/)
})

test('pickLatestTag / tagVersion：dsh-v 前缀剥离 + semver 取最大', () => {
  assert.equal(pickLatestTag(['dsh-v0.1.1-rc.2', 'dsh-v0.1.2-alpha.1', 'dsh-v0.1.0-rc.8']), 'dsh-v0.1.2-alpha.1')
  assert.equal(pickLatestTag(['dsh-v0.1.1', 'dsh-v0.1.1-rc.2']), 'dsh-v0.1.1')
  assert.equal(pickLatestTag(['not-a-tag', 'random']), null)
  assert.equal(pickLatestTag([]), null)
  assert.equal(tagVersion('dsh-v0.1.2-alpha.1'), '0.1.2-alpha.1')
  assert.equal(tagVersion('dsh-v0.1.2'), '0.1.2')
  assert.equal(tagVersion('v0.1.2'), null)
})

test('sourceEntryArgs：tsx 前缀 + 仓库内入口绝对路径', () => {
  const dir = makeSourceDir()
  const args = sourceEntryArgs(dir)
  assert.equal(args[0], '--import')
  assert.equal(args[1], 'tsx/esm')
  assert.match(args[2], /apps[\\/]cli[\\/]src[\\/]bin\.ts$/)
})

function rmrf(p) {
  rmSync(p, { recursive: true, force: true })
}

function writeGitConfig(dir, url) {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
}
