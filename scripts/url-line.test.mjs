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

console.log('url-line OK: 跨 chunk URL 行解析通过')
