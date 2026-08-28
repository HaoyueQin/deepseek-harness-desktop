/**
 * url-line matcher 单测：URL 行在单 chunk、跨多次拆分、拆在 URL 中间、
 * 大段无关前置输出等场景下都能匹配。
 * 用法：npm run build && node scripts/url-line.test.mjs
 */
import assert from 'node:assert/strict'
import { UrlLineMatcher } from '../dist/dsh/url-line.js'

const URL = 'http://127.0.0.1:50871'

// 单 chunk 完整出现
{
  const m = new UrlLineMatcher()
  assert.equal(m.push(`dsh web: ${URL}\n`), URL)
}

// 一行拆成两个 chunk（URL 中间截断）
{
  const m = new UrlLineMatcher()
  assert.equal(m.push(`dsh web: ${URL.slice(0, 10)}`), null)
  assert.equal(m.push(`${URL.slice(10)}\n`), URL)
}

// URL 行每字符一个 chunk 逐步喂入
{
  const m = new UrlLineMatcher()
  const line = `dsh web: ${URL}\n`
  for (const ch of line.slice(0, -1)) assert.equal(m.push(ch), null) // 最后字符前仍未补全
  assert.equal(m.push(line.slice(-1)), URL)
}

// URL 行前有大量无关输出（超过保留上限）仍匹配
{
  const m = new UrlLineMatcher()
  m.push('x'.repeat(20_000)) // 远超 MAX_BUF，只保留尾部
  assert.equal(m.push(`dsh web: ${URL}\n`), URL)
}

// 无 URL 输出 → 一直返回 null
{
  const m = new UrlLineMatcher()
  for (let i = 0; i < 5; i++) assert.equal(m.push('starting up...\n'), null)
}

// 多个 URL 行（首次命中即返回第一个）
{
  const m = new UrlLineMatcher()
  assert.equal(m.push(`dsh web: ${URL}\nsome log\ndsh web: http://127.0.0.1:9999\n`), URL)
}

// alpha.1+：URL 带 /?token=（整串返回，供 loadURL 完成 cookie 换取）
{
  const tokened = 'http://127.0.0.1:14918/?token=fD8CmAYGK7Pb9UF3EgQaKByMbiHLjYJ7ye6qyaIp5Sw'
  const m = new UrlLineMatcher()
  assert.equal(m.push(`dsh web: ${tokened}\n`), tokened)
}

// (LAN: …) 后缀行：只取 127.0.0.1 地址，不带 LAN 部分
{
  const m = new UrlLineMatcher()
  assert.equal(m.push(`dsh web: ${URL} (LAN: http://192.168.1.5:50871)\n`), URL)
}

// tokened URL 拆在 token 中间（跨 chunk）
{
  const tokened = 'http://127.0.0.1:14918/?token=abcDEF123_-xyz'
  const m = new UrlLineMatcher()
  assert.equal(m.push(`dsh web: ${tokened.slice(0, 35)}`), null)
  assert.equal(m.push(`${tokened.slice(35)}\n`), tokened)
}

// tokened + LAN 后缀并存（极端组合）
{
  const tokened = 'http://127.0.0.1:14918/?token=abc'
  const m = new UrlLineMatcher()
  assert.equal(m.push(`dsh web: ${tokened} (LAN: http://192.168.1.5:14918/?token=abc)\n`), tokened)
}

console.log('url-line OK: 跨 chunk URL 行解析通过')
