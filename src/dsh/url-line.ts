/**
 * dsh readiness URL 行解析。dsh web 的 stdout 可能把 URL 行拆成多个 chunk，
 * 对单个 chunk 逐段正则会漏匹配（URL 行恰好被截断时永远匹配不到）。
 * 本模块累积缓冲：URL 行完整出现后立即匹配，一次命中即返回。
 */

/** dsh 官方 readiness 行，如 "dsh web: http://127.0.0.1:50871"。
 *  0.1.2-alpha.1 起 URL 带进程 token：…/:port/?token=…；各版本均可能跟
 *  " (LAN: http://…)" 后缀——地址段 \S* 到空白即止，LAN 段整体可选匹配。
 *  要求以换行收尾：URL 行必然独占一行以 \n 结束，这样缓冲只喂到行中途
 *  （如 "…:5"）或缺失末尾换行时不会提前命中，也不会把后续日志误并进来。 */
export const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)(?: \(LAN: [^)\n]*\))?\r?\n/

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
