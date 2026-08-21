/**
 * 构建时填充 resources/（纯壳架构 v1.0.0 起）：
 *   resources/icon.png   应用图标（1024px，来自 dsh 仓库 favicon.svg）
 * 同时写 build/icon.png（electron-builder 源）。
 *
 * dsh 运行时不再内置——壳 spawn 用户已装的 dsh CLI（见 src/dsh-locator.ts），
 * 因此无需安装 Node 发行版与 dsh 依赖树。
 *
 * 在目标平台（或对应 CI runner）上执行，保证图标与产物平台无关。
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('..', import.meta.url)))
const resources = join(root, 'resources')

/** 图标：resources/icon.png（运行时/托盘）+ build/icon.png（electron-builder 源），同源 1024px。 */
async function installIcon() {
  const outRuntime = join(resources, 'icon.png')
  const outBuild = join(root, 'build', 'icon.png')
  if (existsSync(outRuntime) && statSync(outRuntime).size > 0) { console.log('[install-runtime] icon.png 已存在，跳过'); return }
  // CI 无本地 fork：用 DSH_ICON_SVG 指定 favicon.svg 路径；本机默认读隔壁 fork 仓库
  const svg = process.env.DSH_ICON_SVG ?? join(root, '..', 'deepseek-harness', 'apps', 'web', 'public', 'favicon.svg')
  if (!existsSync(svg)) { console.warn(`[install-runtime] 未找到 ${svg}，跳过图标`); return }
  const sharp = (await import('sharp')).default
  await sharp(svg, { density: 300 }).resize(1024, 1024).png().toFile(outRuntime)
  mkdirSync(join(root, 'build'), { recursive: true })
  await sharp(svg, { density: 300 }).resize(1024, 1024).png().toFile(outBuild)
  console.log(`[install-runtime] 图标就绪 → ${outRuntime} + ${outBuild}`)
}

await installIcon()
console.log('[install-runtime] 完成')
