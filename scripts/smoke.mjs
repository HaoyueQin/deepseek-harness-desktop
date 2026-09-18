/**
 * 无 GUI 冒烟：spawn dsh web --patch <桌面补丁> --port 0，断言
 *   1) stdout 出现官方 URL 行 "dsh web: http://127.0.0.1:<port>[/…]"（alpha.1+ 带 /?token=）
 *   2) 该地址有 HTTP 响应（任意状态；tokened URL 对裸 fetch 是 303）
 *   3) 桌面集成插件（补丁用相对路径锚定到壳 resources，见 desktop-patch.yml）后
 *      仍能启动，且已进入客户端启动图 __DSH_BOOT__（覆盖宿主 + 浏览器 half）
 * 然后停止进程。这是端口发现链路与插件注入链路的可复现验证。
 *
 * 纯壳架构（v1.0.0 起）：用系统已装的 dsh（与桌面壳运行时同源）。
 * 前置：npm i -g @deepseek-ai/dsh + npm run build（版本比较复用 dist 产物）。
 *
 * 另断言已装 dsh 不低于支持下限（README / Release 声明的 dsh ≥ 0.1.5-rc.1）：
 * CI 与本地都必须真跑在支持范围内，否则渠道漂移会给出假绿。
 */

import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 项目根（scripts/ 的上一级）。 */
const ROOT = fileURLToPath(new URL('../', import.meta.url))

// 与 src/dsh-locator.ts 同逻辑：PATH 验证 + npm root -g 推导 bin.js
function locateDsh() {
  // Windows 下 .cmd shim 经 ComSpec /c 解析（shell:true+args 在 Node≥22 有 DEP0190 警告）
  const shim = (cmd) => process.platform === 'win32'
    ? { cmd: process.env.ComSpec ?? 'cmd', args: ['/d', '/s', '/c', cmd] }
    : { cmd: cmd.split(' ')[0], args: cmd.split(' ').slice(1) }
  const runShim = (cmd) => { const s = shim(cmd); return spawnSync(s.cmd, s.args, { encoding: 'utf8', windowsHide: true }) }
  const ver = runShim('dsh --version')
  if (ver.status !== 0 || !ver.stdout?.trim()) throw new Error('未检测到 dsh（先 npm i -g @deepseek-ai/dsh）')
  const rootDir = runShim('npm root -g')
  if (rootDir.status !== 0 || !rootDir.stdout?.trim()) throw new Error('未检测到 npm')
  const binJs = join(rootDir.stdout.trim(), '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(binJs)) throw new Error(`未找到 ${binJs}`)
  return { binJs, version: ver.stdout.trim() }
}

const nodePath = 'node'
const { binJs: dshBin, version: dshVersion } = locateDsh()

// 支持下限（README「dsh 版本支持」与 Release 正文声明）。版本比较复用壳的纯
// 函数（dist/dsh-locator.js），避免在冒烟脚本里复制一套 semver 语义。
const SUPPORT_FLOOR = '0.1.5-rc.1'
let compareVersions
try {
  ({ compareVersions } = await import('../dist/dsh-locator.js'))
} catch {
  throw new Error('缺少 dist/dsh-locator.js —— 先运行 npm run build 再跑冒烟')
}
if (compareVersions(dshVersion, SUPPORT_FLOOR) < 0) {
  throw new Error(`dsh ${dshVersion} 低于支持下限 ${SUPPORT_FLOOR}：本壳不再适配该版本（npm i -g @deepseek-ai/dsh 升级）`)
}
console.log(`SMOKE OK: dsh ${dshVersion} ≥ 支持下限 ${SUPPORT_FLOOR}`)

const dshHome = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))

// 桌面集成插件注入链路：补丁用相对路径锚定到壳 resources（见 desktop-patch.yml），
// 壳不向 $DSH_HOME 写任何插件文件。这里只校验补丁锚定的宿主 half 存在；真正的
// 解析由 dsh 在启动时完成，浏览器 half 由下面的启动图断言覆盖。
const patchFile = join(ROOT, 'resources', 'desktop-patch.yml')
if (!existsSync(patchFile)) throw new Error(`未找到桌面补丁 ${patchFile}`)
const pluginEntry = join(ROOT, 'resources', 'desktop-integration', 'lib', 'index.js')
if (!existsSync(pluginEntry)) throw new Error(`补丁锚定的插件入口不存在 ${pluginEntry}`)
console.log(`SMOKE OK: 桌面补丁就位 @ ${patchFile}`)

// dsh 0.1.6-alpha.2 起插件解析失败会让整棵树 fail-loud；命中即说明注入链路断了。
const PLUGIN_MISSING = /Cannot find package 'dsh-desktop-integration'/
// URL 行独占一行以 \n 收尾；锚定换行避免行中途提前命中；地址段 \S* 兼容 /?token=，
// LAN 后缀段整体可选（与 src/dsh/url-line.ts 保持一致）
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)(?: \(LAN: [^)\n]*\))?\r?\n/

// --no-open：smoke 只验证端口发现链路，不弹系统浏览器（rc.8+ 默认会弹）
// --patch 与壳同序：launcher flag 在 profile 名之后、透传参数之前
const child = spawn(nodePath, [dshBin, 'web', '--patch', patchFile, '--port', '0', '--no-open'], {
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let url = ''
let log = ''
const timeout = setTimeout(() => {
  console.error(`SMOKE FAIL: 超时。捕获输出:\n${log}`)
  child.kill('SIGKILL')
  process.exit(1)
}, 90_000)

// 累积缓冲 + 单段正则：URL 行可能被拆成多个 chunk，逐段匹配会漏。
let buf = ''
child.stdout.on('data', (chunk) => {
  const text = chunk.toString()
  log += text
  buf += text
  if (buf.length > 8192) buf = buf.slice(-8192)
  const m = buf.match(URL_LINE)
  if (m && !url) url = m[1]
})
child.stderr.on('data', (chunk) => { log += chunk.toString() })
child.on('exit', (code, signal) => {
  if (!url) {
    const hint = PLUGIN_MISSING.test(log)
      ? '\n提示：桌面集成插件未被 dsh 解析——检查 resources/desktop-patch.yml 的 name 是否为相对路径。'
      : ''
    console.error(`SMOKE FAIL: 进程提前退出 code=${String(code)} signal=${String(signal)}${hint}。输出:\n${log}`)
    process.exit(1)
  }
})

/**
 * 取回带 token 的引导页 HTML。dsh 的鉴权是「根 URL 的 ?token= → 303 种签名
 * Cookie → 干净 / 才给 index」，而 Node 的 fetch 没有 cookie 罐，必须手工把
 * set-cookie 续到第二次请求上。
 * @param {string} authenticated - stdout 解析出的 http://127.0.0.1:<port>/?token=…
 * @returns {{ status: number, html: string | null }}
 */
async function fetchIndexWithAuth(authenticated) {
  const seed = await fetch(authenticated, { redirect: 'manual' })
  const setCookie = seed.headers.get('set-cookie')
  if (setCookie === null) return { status: seed.status, html: null }
  const page = await fetch(new URL('/', authenticated), { headers: { cookie: setCookie.split(';')[0] } })
  return { status: page.status, html: page.ok ? await page.text() : null }
}

async function main() {
  const deadline = Date.now() + 60_000
  while (!url && Date.now() < deadline) await new Promise(r => setTimeout(r, 250))
  if (!url) throw new Error('未捕获到 URL 行')
  // 防御未来 dsh 容忍单行插件失败继续启动：URL 行出现不等于注入链路健康
  if (PLUGIN_MISSING.test(log)) {
    throw new Error('桌面集成插件未被 dsh 解析（补丁 name 未按 resources 锚定）')
  }
  console.log(`SMOKE OK: URL 行 = ${url}`)

  const deadlineHttp = Date.now() + 30_000
  let ok = false
  while (Date.now() < deadlineHttp && !ok) {
    try { await fetch(url, { redirect: 'manual' }); ok = true } catch { /* 未就绪 */ }
    if (!ok) await new Promise(r => setTimeout(r, 250))
  }
  if (!ok) throw new Error(`HTTP 无响应: ${url}`)
  console.log(`SMOKE OK: HTTP 有响应 @ ${url}`)

  // 浏览器 half 验证：URL 行与宿主 half 都健康，也不代表客户端启动图里有插件
  // （宿主 half 是空 apply()，缺浏览器 half 不会报错，只会静默少一个「桌面」分区）。
  const index = await fetchIndexWithAuth(url)
  if (index.html === null || !index.html.includes('dsh-desktop-integration')) {
    throw new Error(`桌面集成插件未进入客户端启动图（HTTP ${String(index.status)}）——注入链路失效`)
  }
  console.log('SMOKE OK: 桌面集成插件已进入客户端启动图')

  clearTimeout(timeout)
  child.kill()
  await new Promise(resolve => child.once('exit', resolve))
  console.log('SMOKE OK: 进程已停止')
  process.exit(0)
}

main().catch((err) => {
  console.error(`SMOKE FAIL: ${String(err)}`)
  child.kill('SIGKILL')
  process.exit(1)
})
