/**
 * OutputRingBuffer 单测：跨 chunk 行拼接、行数/字节上限、尾行保留。
 * 用法：npm run build && node scripts/recovery-ring-buffer.test.mjs
 */
import assert from 'node:assert/strict'
import { OutputRingBuffer } from '../dist/recovery/ring-buffer.js'

// 基本拼接：未换行的尾行与下个 chunk 相接
{
  const b = new OutputRingBuffer()
  b.push('hello ')
  b.push('world\nsecond line\n')
  assert.equal(b.text(), 'hello world\nsecond line\n')
}

// 尾行保留：text() 含未以 \n 结尾的 pending
{
  const b = new OutputRingBuffer()
  b.push('a\nb')
  assert.equal(b.text(), 'a\nb')
}

// 行数上限：200 行后淘汰最旧（默认上限）
{
  const b = new OutputRingBuffer()
  for (let i = 1; i <= 250; i++) b.push(`line-${String(i).padStart(3, '0')}\n`)
  const text = b.text()
  assert.ok(!text.includes('line-050\n'), '第 50 行应已被淘汰')
  assert.ok(text.includes('line-051\n'), '第 51 行应保留（200 行窗口）')
  assert.ok(text.includes('line-250\n'))
  assert.equal(text.split('\n').filter((l) => l !== '').length, 200)
}

// 字节上限：超过 maxBytes 淘汰最旧行（先到为准，行数未超也淘汰）
{
  const b = new OutputRingBuffer(200, 200) // 200 字节上限
  for (let i = 1; i <= 10; i++) b.push(`x`.repeat(30) + `-${String(i).padStart(2, '0')}\n`) // 每行 33 字节
  const text = b.text()
  assert.ok(text.length <= 200 + 33, '总字节应收敛到上限附近（至少保留一行）')
  assert.ok(!text.includes('-01\n'), '最早行应被淘汰')
  assert.ok(text.includes('-10\n'), '最新行必须保留')
}

// 字节上限按真实 UTF-8 字节计（中文每字 3 字节）
{
  const b = new OutputRingBuffer(200, 30)
  b.push('中中中中中\n') // 15 UTF-8 字节
  b.push('x'.repeat(20) + '\n') // 20 字节 → 合计 35 > 30，中文行按字节淘汰
  const text = b.text()
  assert.ok(!text.includes('中中中中中'), '中文行应按 UTF-8 字节淘汰而非字符数')
  assert.ok(text.includes('xxxxx'), '最新行必须保留')
}

// 无换行洪流（\r 进度条）时 pending 截断保留尾部，不无界增长
{
  const b = new OutputRingBuffer(200, 100)
  b.push('a'.repeat(1000)) // 无换行
  const text = b.text()
  assert.ok(text.length <= 100, 'pending 应被截断到上限附近')
  assert.ok(text.endsWith('a'), '截断保留尾部')
}

// 单行超限也至少保留一行
{
  const b = new OutputRingBuffer(5, 10)
  b.push('this-single-line-is-way-longer-than-ten-bytes\n')
  assert.ok(b.text().includes('this-single-line'), '至少保留最新一行')
}

console.log('recovery-ring-buffer OK')
