/**
 * 无 GUI 冒烟：spawn dsh web --port 0，断言
 *   1) stdout 出现官方 URL 行 "dsh web: http://127.0.0.1:<port>"
 *   2) 该地址 HTTP 200
 * 然后停止进程。这是端口发现链路的可复现验证。
 *
 * 用法：node scripts/smoke.mjs            # 用项目 node_modules 的 dsh + 系统 node
 *       node scripts/smoke.mjs --runtime  # 用 resources/ 的内嵌运行时（阶段2 后）
 */

import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const useRuntime = process.argv.includes('--runtime')

const nodePath = useRuntime
  ? join(root, 'resources', 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
  : 'node'
const dshBin = useRuntime
  ? join(root, 'resources', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  : join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const dshHome = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
// URL 行独占一行以 \n 收尾；锚定换行避免端口前几位时提前命中残缺地址
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)\r?\n/

const child = spawn(nodePath, [dshBin, 'web', '--port', '0'], {
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
    console.error(`SMOKE FAIL: 进程提前退出 code=${String(code)} signal=${String(signal)}。输出:\n${log}`)
    process.exit(1)
  }
})

async function main() {
  const deadline = Date.now() + 60_000
  while (!url && Date.now() < deadline) await new Promise(r => setTimeout(r, 250))
  if (!url) throw new Error('未捕获到 URL 行')
  console.log(`SMOKE OK: URL 行 = ${url}`)

  const deadlineHttp = Date.now() + 30_000
  let ok = false
  while (Date.now() < deadlineHttp && !ok) {
    try { ok = (await fetch(url)).ok } catch { /* 未就绪 */ }
    if (!ok) await new Promise(r => setTimeout(r, 250))
  }
  if (!ok) throw new Error(`HTTP 未 200: ${url}`)
  console.log(`SMOKE OK: HTTP 200 @ ${url}`)

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
