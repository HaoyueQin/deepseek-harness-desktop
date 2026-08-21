/**
 * 资源路径解析：dev（源码树）与 prod（打包后 extraResources）两种布局。
 *
 * 纯壳架构（v1.0.0 起）：dsh 运行时不再内置——spawn 用户已装的 dsh CLI
 * （见 dsh-locator.ts），resources/ 只承载图标与桌面集成插件。
 *
 * dev  布局：<项目根>/resources/（desktop-patch.yml、desktop-integration/、icon.png）
 * prod 布局：<resources>/resources/ 同构（electron-builder extraResources 原样带入）
 */

import { app } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** 编译产物 dist/ 的上一级 = 项目根（dev 场景）。 */
function devRoot(): string {
  return fileURLToPath(new URL('../', import.meta.url))
}

// dsh 数据目录：尊重 $DSH_HOME、缺省 ~/.dsh（与官方 resolveDshHome 一致），
// desktop 与 CLI 共享同一份用户数据——终端/界面安装的插件、设置、凭证互相可见。
// 实现见 dsh-home.ts（纯函数，不依赖 electron，可独立测试）。
export { dshHomeDir } from './dsh-home.js'

/** extraResources 根目录（prod 为 <resources>/resources）。 */
export function resourcesDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'resources')
  return join(devRoot(), 'resources')
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

/** 桌面集成插件 patch（dev 在项目根 resources/，prod 在 extraResources）。 */
export function desktopPatchPath(): string {
  return join(resourcesDir(), 'desktop-patch.yml')
}

/** 桌面集成插件包目录（dev 项目根 resources/，prod extraResources）。 */
export function desktopPluginDir(): string {
  return join(resourcesDir(), 'desktop-integration')
}
