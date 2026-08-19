/**
 * dsh readiness URL 行解析。dsh web 的 stdout 可能把 URL 行拆成多个 chunk，
 * 对单个 chunk 逐段正则会漏匹配（URL 行恰好被截断时永远匹配不到）。
 * 本模块累积缓冲：URL 行完整出现后立即匹配，一次命中即返回。
 */

/** dsh 官方 readiness 行，如 "dsh web: http://127.0.0.1:50871"。
 *  要求以换行收尾（如 "dsh web: …50871\n"）：URL 行必然独占一行以 \n 结束，
 *  这样缓冲只喂到端口前几位（如 "…:5"）或缺失末尾换行时不会提前命中，
 *  也不会在后续日志紧跟同段内容时误判。 */
export const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)\r?\n/

/**
 * 防无限增长上限。URL 行最长 ~40 字符；保留尾部 8KB 足够——若 URL 行
 * 尚未出现，它必然位于最新输出（尾部），更早的内容不可能再包含它。
 */
const MAX_BUF = 8 * 1024

export class UrlLineMatcher {
  private buf = ''

  /** 喂入一段 stdout chunk；URL 行完整出现时返回地址，否则返回 null。 */
  push(chunk: string): string | null {
    this.buf += chunk
    const m = this.buf.match(URL_LINE)
    if (m !== null) return m[1]
    if (this.buf.length > MAX_BUF) this.buf = this.buf.slice(-MAX_BUF)
    return null
  }
}
