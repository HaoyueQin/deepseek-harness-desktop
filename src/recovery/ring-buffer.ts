/**
 * 环形输出缓冲：dsh stdout/stderr 的滚动快照，异常退出时作为诊断材料
 * 交给恢复页（handover §7.3）。只在内存，不新增磁盘格式（完整日志仍走
 * main.log）。行数上限与字节上限先到为准，均触发最旧行淘汰；未以换行
 * 结尾的尾行保留（pending），与下一个 chunk 拼接。
 */
import { Buffer } from 'node:buffer'

export class OutputRingBuffer {
  private readonly maxLines: number
  private readonly maxBytes: number
  private done: string[] = []
  private pending = ''
  private bytes = 0

  constructor(maxLines = 200, maxBytes = 32 * 1024) {
    this.maxLines = maxLines
    this.maxBytes = maxBytes
  }

  /** 追加一段输出（任意切分粒度，内部处理行边界）。 */
  push(chunk: string): void {
    this.pending += chunk
    const parts = this.pending.split('\n')
    this.pending = parts.pop() ?? ''
    for (const line of parts) this.append(line + '\n')
    // 无换行洪流（如 \r 进度条刷屏）会让 pending 无界增长：超限截断保留尾部
    //（按 code unit 近似上限，防失控即可；真实行进入 done 后按 UTF-8 字节计）。
    if (this.pending.length > this.maxBytes) {
      this.pending = this.pending.slice(-this.maxBytes)
    }
  }

  /** 当前保留的全部内容（含未完结尾行）。 */
  text(): string {
    return this.done.join('') + this.pending
  }

  private append(line: string): void {
    this.done.push(line)
    // 上限语义是字节：按真实 UTF-8 字节数计（中文等非 ASCII 每字 3 字节）
    this.bytes += Buffer.byteLength(line, 'utf8')
    // 至少保留一行（单行超限时不淘汰到空）
    while (this.done.length > 1 && (this.done.length > this.maxLines || this.bytes > this.maxBytes)) {
      this.bytes -= Buffer.byteLength(this.done[0]!, 'utf8')
      this.done.shift()
    }
  }
}
