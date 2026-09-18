/**
 * 桌面集成插件注入契约单测（纯文件，不需要 dsh / Electron）。
 *
 * 回归背景：dsh 0.1.6-alpha.2 把 profile 模块解析默认模式从 link 改为 runtime，
 * 裸包名只认 profile 本地 node_modules；插件放哪里都可能被 pnpm prune。壳改用
 * 「--patch 的相对路径 name」——dsh 解析补丁时把它锚定为 file: URL（app-boot 的
 * anchorInsertedPluginNames，0.1.5-rc.1 起全版本一致），与解析模式、pnpm 都无关。
 *
 * 本测试挡住两类回退：
 *   1. name 被改回裸包名（alpha.2 上直接启动失败）；
 *   2. 补丁指向的文件/dsh.client 声明被移动或删掉（浏览器 half 静默消失）。
 *
 * 用法：node scripts/desktop-patch.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { load } from 'js-yaml'

const ROOT = join(import.meta.dirname, '..')
const PATCH_PATH = join(ROOT, 'resources', 'desktop-patch.yml')
const PLUGIN_ID = 'dsh-desktop-integration'

/** 补丁里插入的行（顶层数组的每个 patch 的 insert 子块展平）。 */
const patch = load(readFileSync(PATCH_PATH, 'utf8'))
assert.ok(Array.isArray(patch), 'desktop-patch.yml 必须是顶层 YAML 数组')
const inserted = patch.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
const row = inserted.find((entry) => entry?.id === PLUGIN_ID)
assert.ok(row, `补丁必须插入 id=${PLUGIN_ID} 的行`)

// --- name 必须是相对路径（不是裸包名）：决定 dsh 走 file: URL 锚定 ---
assert.equal(typeof row.name, 'string', 'name 必须是字符串')
assert.ok(
  row.name.startsWith('./') || row.name.startsWith('../'),
  `name 必须是相对本文件的路径（当前 ${JSON.stringify(row.name)}）；`
  + '裸包名在 dsh 0.1.6-alpha.2 的 runtime 解析模式下无法从壳的 resources 目录解析',
)

// --- 锚定后的目标文件必须存在 ---
const entryFile = resolve(dirname(PATCH_PATH), row.name)
assert.ok(existsSync(entryFile), `补丁锚定的宿主 half 入口不存在：${entryFile}`)

// --- 向上找最近的 package.json，校验 dsh client 插件契约 ---
let packageDir = dirname(entryFile)
while (!existsSync(join(packageDir, 'package.json'))) {
  const parent = dirname(packageDir)
  assert.notEqual(parent, packageDir, `从 ${entryFile} 向上找不到 package.json`)
  packageDir = parent
}
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
assert.equal(manifest.name, PLUGIN_ID, '插件包名必须与补丁行 id 一致（浏览器模块 id 取包名）')
assert.equal(manifest.type, 'module', '宿主 half 以 ESM 被 import，package.json 必须声明 type: module')
assert.equal(manifest.dsh?.client?.platform, 'web', '必须声明 dsh.client.platform = web，否则 client-modules 不扫描')
const clientExport = manifest.exports?.['./client']
assert.equal(typeof clientExport, 'string', '必须导出 ./client（client-modules 缺它会硬报错）')
assert.ok(existsSync(join(packageDir, clientExport)), `./client 导出文件不存在：${clientExport}`)

console.log('desktop-patch OK: 相对路径 name + 宿主/浏览器 half 契约校验通过')
