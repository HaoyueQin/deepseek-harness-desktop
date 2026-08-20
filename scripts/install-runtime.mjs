/**
 * 构建时：填充 resources/（生产运行时）——
 *   resources/runtime/node/   内置 Node 24 LTS 官方发行版（按当前平台）
 *   resources/dsh/            @deepseek-ai/dsh 完整依赖树（npm install --omit=dev）
 *   resources/icon.png        应用图标（1024px，来自 dsh 仓库 favicon.svg）
 *
 * 打包时经 electron-builder extraResources 原样带入安装包。install-runtime 在
 * 目标平台（或对应 CI runner）上执行，保证下载的 Node/dsh 与产物平台一致。
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('..', import.meta.url)))
const resources = join(root, 'resources')
// dsh 版本范围不写死：跟随根 package.json devDependencies 里的
// @deepseek-ai/dsh 声明（当前为 ^0.1.0-rc.8，自动取范围内最新 rc / 正式版）。
// 上游发新版后无需改本脚本——重跑 build:runtime 即装到当时最新；
// 若版本跳到不同 major.minor 需手动更新 package.json（大版本人工审查破坏性变更）。
// DSH_VERSION 环境变量可临时覆盖（CI 固定版本）。
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const DSH_VERSION = process.env.DSH_VERSION ?? pkg.devDependencies?.['@deepseek-ai/dsh']
if (typeof DSH_VERSION !== 'string' || DSH_VERSION === '') {
  throw new Error('package.json devDependencies 中缺少 @deepseek-ai/dsh 版本声明')
}
// npm install 走调用方 registry（本机镜像配置或 CI 默认），不写死
const REGISTRY = process.env.npm_config_registry ?? 'https://registry.npmjs.org'
// 目标平台架构：交叉构建时（CI 在 arm64 runner 上出 x64 包）npm 会注入
// npm_config_arch；原生构建时未设，回退 process.arch。Node 发行版、node-pty
// prebuilds 与 sharp 平台包都必须按目标架构选择——用 process.arch 会在交叉
// 构建时下载错 Node 发行版、删掉产物需要的原生运行时。
const targetArch = process.env.npm_config_arch ?? process.arch

/**
 * 检查外部工具是否可用。脚本依赖 curl/tar/powershell（Windows 自带 / *
 * macOS、Linux 现多自带），但 PATH 自定义或精简系统可能缺失——缺失时给出
 * 明确指导，避免裸 ENOENT 难以定位。
 * @returns 可用返回 true；不可用打印提示后返回 false（调用方可决定是否中止）。
 */
function ensureTool(tool, hint) {
  try {
    spawnSync(tool, ['--version'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    console.error(`[install-runtime] 缺少外部工具 "${tool}"：${hint}`)
    return false
  }
}

/** 取 Node 24 LTS 当前最新 patch 版本（nodejs.org dist/index.json）。 */
async function latestNode24() {
  if (!ensureTool('curl', '下载 Node 发行版与版本清单需要 curl。请安装 curl 或将其加入 PATH。')) {
    throw new Error('缺少 curl，无法获取 Node 版本清单')
  }
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  const args = ['-s', 'https://nodejs.org/dist/index.json']
  if (proxy) args.push('--proxy', proxy)
  const out = execFileSync('curl', args, { encoding: 'utf8' })
  const list = JSON.parse(out)
  const v24 = list.find((e) => e.version.startsWith('v24.') && e.lts !== false)
  if (v24 === undefined) throw new Error('dist/index.json 中无 Node 24 LTS 版本')
  return v24.version // 形如 "v24.10.1"
}

function nodeDownloadInfo(version) {
  const base = `https://nodejs.org/dist/${version}`
  if (process.platform === 'win32') return { url: `${base}/node-${version}-win-${targetArch}.zip`, kind: 'zip' }
  if (process.platform === 'darwin') return { url: `${base}/node-${version}-darwin-${targetArch}.tar.gz`, kind: 'tgz' }
  return { url: `${base}/node-${version}-linux-${targetArch}.tar.gz`, kind: 'tgz' }
}

async function download(url, dest) {
  if (!ensureTool('curl', '下载大文件需要 curl。请安装 curl 或将其加入 PATH。')) {
    throw new Error(`缺少 curl，无法下载 ${url}`)
  }
  console.log(`[install-runtime] 下载 ${url}`)
  const args = ['-sL', '-o', dest, '--max-time', '600', '--retry', '3']
  // 环境变量设置了 HTTP(S)_PROXY 时走代理（Node 24 的 --use-env-proxy 可让
  // fetch 也走该代理，但 curl 直读更稳）；仅本脚本下载阶段生效。
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
  if (proxy) args.push('--proxy', proxy)
  args.push(url)
  execFileSync('curl', args, { stdio: 'inherit' })
}

async function installNode() {
  const target = join(resources, 'runtime', 'node')
  const marker = join(resources, 'runtime', '.node-installed')
  if (existsSync(marker) && existsSync(target)) {
    console.log(`[install-runtime] Node 已存在，跳过（删除 ${marker} 可强制重装）`)
    return
  }
  const version = await latestNode24()
  const info = nodeDownloadInfo(version)
  const archive = join(tmpdir(), info.kind === 'zip' ? 'node.zip' : 'node.tgz')
  await download(info.url, archive)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  if (info.kind === 'zip') {
    // Windows 无 unzip 保证，用 PowerShell Expand-Archive
    if (!ensureTool('powershell', 'Windows 下解压 Node zip 需要 PowerShell。')) {
      throw new Error('缺少 powershell，无法解压 Node')
    }
    const staging = join(resources, 'runtime', 'node-tmp')
    rmSync(staging, { recursive: true, force: true })
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${staging}' -Force`], { stdio: 'inherit' })
    const inner = join(staging, `node-${version}-win-x64`)
    renameSync(join(inner, 'node.exe'), join(target, 'node.exe'))
    renameSync(join(inner, 'LICENSE'), join(target, 'LICENSE'))
    // 保留 npm（设置页「一键更新后端」用）：官方 Node 发行版自带 npm，
    // 只挪 node_modules/npm 与 npm.cmd，其余（corepack 等）丢弃。
    renameSync(join(inner, 'node_modules', 'npm'), join(target, 'node_modules', 'npm'))
    renameSync(join(inner, 'npm.cmd'), join(target, 'npm.cmd'))
    rmSync(staging, { recursive: true, force: true })
  } else {
    if (!ensureTool('tar', 'macOS/Linux 下解压 Node tar.gz 需要 tar。')) {
      throw new Error('缺少 tar，无法解压 Node')
    }
    // strip-components=1 已把 node-<ver>-<plat>-<arch>/ 内全部解出；删除
    // corepack 省体积，保留 bin/npm 与 lib/node_modules/npm（一键更新用）。
    execFileSync('tar', ['-xzf', archive, '-C', target, '--strip-components=1'], { stdio: 'inherit' })
    rmSync(join(target, 'lib', 'node_modules', 'corepack'), { recursive: true, force: true })
  }
  rmSync(archive, { force: true })
  writeFileSync(marker, new Date().toISOString())
  console.log(`[install-runtime] Node ${version} 就绪 → ${target}`)
}

/** 平台清理：保留当前平台的 node-pty prebuild 与 sharp 二进制及其 libvips 运行时，删除其余（省 ~48M）。 */
function cleanNativePlatforms(dshDir) {
  const ptyDir = join(dshDir, 'node_modules', 'node-pty', 'prebuilds')
  const ptyKeep = { win32: `win32-${targetArch}`, darwin: `darwin-${targetArch}`, linux: `linux-${targetArch}` }[process.platform]
  for (const d of readdirSync(ptyDir)) {
    if (d !== ptyKeep) rmSync(join(ptyDir, d), { recursive: true, force: true })
  }
  const imgDir = join(dshDir, 'node_modules', '@img')
  // sharp 拆两个包：sharp-<plat>-<arch>（二进制 loader）+ sharp-libvips-<plat>-<arch>
  // （libvips 运行时库，mac/linux 必需，Windows 二进制自包含则无此包）。
  // 两者都必须保留；删除 wasm 与其余平台变体。
  const platformTag = `${process.platform}-${targetArch}` // win32-x64 / darwin-arm64 / linux-x64
  for (const d of readdirSync(imgDir)) {
    if (d === 'colour') continue // 纯 JS 依赖
    if (d === `sharp-${platformTag}`) continue
    if (d === `sharp-libvips-${platformTag}`) continue
    rmSync(join(imgDir, d), { recursive: true, force: true })
  }
  console.log(`[install-runtime] 平台清理完成（pty: ${ptyKeep}；sharp: ${platformTag}）`)
}

/**
 * 构建期冗余清理（幂等，每次 build:runtime 都执行，不依赖 npm install marker）：
 *   1) 删除运行时不需要的文件：sourcemap、.d.ts、README/CHANGELOG/LICENSE、测试文件
 *      （约 1.6 万文件 / 90M —— dsh 依赖树 3.3 万文件 → 1.5 万）。
 *   2) 只删 @mistralai/mistralai/src（exports.source 仅供打包器，Node 运行时走 esm/）。
 *   3) 只删嵌套的 @opentelemetry/resources（版本冲突导致的 4 份 2.9.0 副本），
 *      保留顶层 2.10.0 —— Node 解析会从嵌套包向上回退到顶层。
 * 清理同时消灭所有 >260 字符的超长路径：NSIS 3.0.4.1 卸载器 Rename 不支持长路径，
 * 超长文件导致升级时旧目录 Rename 失败 → 安装器循环弹"无法关闭"。
 */
function trimDshTree(dshDir) {
  const isNestedOtelResources = (p) =>
    /node_modules[\\/]@opentelemetry[\\/][^\\/]+[\\/]node_modules[\\/]@opentelemetry[\\/]resources$/.test(p)
  const isMistralaiSrc = (p) => p.includes(`${sep}@mistralai${sep}mistralai${sep}src`)
  const shouldRemoveFile = (name) => {
    const l = name.toLowerCase()
    return l.endsWith('.map') || l.endsWith('.d.ts')
      || l.startsWith('readme') || l.startsWith('changelog')
      || l.startsWith('license') || l.startsWith('licence')
      || l.includes('.test.') || l.includes('.spec.')
  }
  let removed = 0
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (isNestedOtelResources(full)) { rmSync(full, { recursive: true, force: true }); removed++; continue }
        if (name === 'src' && isMistralaiSrc(full)) { rmSync(full, { recursive: true, force: true }); removed++; continue }
        walk(full)
      } else if (st.isFile() && shouldRemoveFile(name)) {
        rmSync(full, { force: true }); removed++
      }
    }
  }
  walk(dshDir)
  // 顶层 @opentelemetry/resources 必须保留（运行时依赖）；误删则中止构建，防止打出坏包
  const top = join(dshDir, 'node_modules', '@opentelemetry', 'resources')
  if (!existsSync(join(top, 'package.json'))) {
    throw new Error('trimDshTree: 顶层 @opentelemetry/resources 缺失，清理中止（请勿手动删除该目录）')
  }
  console.log(`[install-runtime] 冗余清理完成：删除 ${removed} 项（map/d.ts/文档/测试/mistralai src/嵌套 otel resources）`)
}

/** dsh 依赖树（npm install 到 resources/dsh，前端 dist 随 @deepseek-ai/dsh-web-frontend 递归带入）。 */
async function installDsh() {
  const target = join(resources, 'dsh')
  const marker = join(target, '.dsh-installed')
  if (existsSync(marker)) {
    let installed = '未知'
    try { installed = JSON.parse(readFileSync(marker, 'utf8')).version ?? installed } catch { /* 旧版 marker 为纯日期 */ }
    console.log(`[install-runtime] dsh 已存在（version=${installed}），跳过（删除 ${marker} 可强制按 ${DSH_VERSION} 重装）`)
    return
  }
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'),
    JSON.stringify({ name: 'dsh-desktop-runtime', private: true, dependencies: { '@deepseek-ai/dsh': DSH_VERSION } }, null, 2))
  console.log(`[install-runtime] npm 安装 @deepseek-ai/dsh@${DSH_VERSION} (registry=${REGISTRY})`)
  await new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--registry', REGISTRY], {
      cwd: target, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32',
    })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm install 退出码 ${String(code)}`))))
  })
  // 记录实际解析到的版本：marker（跳过提示用）+ .dsh-version（运行时「关于」显示用）
  const resolved = JSON.parse(
    readFileSync(join(target, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
  ).version
  writeFileSync(marker, JSON.stringify({ installedAt: new Date().toISOString(), version: resolved }))
  writeFileSync(join(target, '.dsh-version'), resolved)
  console.log(`[install-runtime] dsh@${resolved} 依赖树就绪 → ${target}`)
}

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

await installNode()
await installDsh()
await installIcon()
// 平台清理（幂等，独立于 npm install marker——已装好的依赖树直接清理，无需重装）
if (existsSync(join(resources, 'dsh', 'node_modules'))) cleanNativePlatforms(join(resources, 'dsh'))
// 冗余清理（幂等，独立于 npm install marker）：每次 build:runtime 都会执行
if (existsSync(join(resources, 'dsh', 'node_modules'))) trimDshTree(join(resources, 'dsh'))
console.log('[install-runtime] 完成')
