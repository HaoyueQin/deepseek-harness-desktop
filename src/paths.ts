/**
 * 资源路径解析：dev（源码树）与 prod（打包后 extraResources）两种布局。
 *
 * dev  布局：<项目根>/node_modules/@deepseek-ai/dsh/…   + 系统 PATH 里的 node
 * prod 布局：<resources>/resources/dsh/node_modules/…    + <resources>/resources/runtime/node/node.exe
 *
 * resources/ 由 scripts/install-runtime.mjs 在打包前填充，经 electron-builder
 * extraResources 原样带入安装包。dev 时若 resources/ 尚未生成，回退到项目
 * node_modules（npm run dev 前已 npm install，@deepseek-ai/dsh 在 devDependencies）。
 */

import { app } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 编译产物 dist/ 的上一级 = 项目根（dev 场景）。 */
function devRoot(): string {
  return fileURLToPath(new URL('../', import.meta.url))
}

/** dsh 数据目录：隔离在 Electron userData 下，避免污染用户默认 ~/.dsh。 */
export function dshHomeDir(): string {
  return join(app.getPath('userData'), 'dsh')
}

/** extraResources 根目录（prod 为 <resources>/resources）。 */
export function resourcesDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'resources')
  return join(devRoot(), 'resources')
}

/** Node 可执行文件。dev 用系统 PATH 的 node；prod 用内置发行版。 */
export function nodeExecutable(): string {
  if (app.isPackaged) {
    const rel = process.platform === 'win32' ? 'node.exe' : 'bin/node'
    return join(resourcesDir(), 'runtime', 'node', rel)
  }
  return 'node'
}

/** dsh bin 脚本（ESM，node 可直接执行；type=module 已确认）。 */
export function dshBinScript(): string {
  const base = app.isPackaged
    ? join(resourcesDir(), 'dsh', 'node_modules')
    : join(devRoot(), 'node_modules')
  return join(base, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** 托盘图标（1024 png，运行时可 resize）。 */
export function iconPath(): string {
  if (app.isPackaged) return join(resourcesDir(), 'icon.png')
  return join(devRoot(), 'build', 'icon.png')
}

/** preload 脚本（注入窗口控制条；dev 为 tsc 产物，prod 打进 asar 的 dist）。.cjs 无歧义——根 package.json type:module 下 .js 会被当 ESM。 */
export function preloadPath(): string {
  return join(devRoot(), 'dist', 'preload.cjs')
}
