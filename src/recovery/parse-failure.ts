/**
 * dsh 崩溃 stderr 解析与脱敏（纯函数）。解析锚点来自 dsh fail-loud
 * 链路的实际输出（handover §5.3）：`plugin(s) failed to load: <names>;`
 * 点名失败插件，EADDRINUSE 为端口占用；其余一律 unknown——解析不出
 * 就不下结论，这个克制写死在这里（handover §7.3）。
 */

export type FailureDiagnosis =
  | { kind: 'plugin-load-failure'; plugins: string[] }
  | { kind: 'port-conflict' }
  | { kind: 'unknown' }

const PLUGIN_LINE = /plugin\(s\) failed to load:\s*([^;\r\n]+);/

/** 从崩溃输出提取失败原因；识别不出返回 unknown。 */
export function parseFailure(text: string): FailureDiagnosis {
  const m = PLUGIN_LINE.exec(text)
  if (m !== null) {
    const plugins = m[1].split(',').map((s) => s.trim()).filter((s) => s !== '')
    if (plugins.length > 0) return { kind: 'plugin-load-failure', plugins }
  }
  if (/EADDRINUSE|address already in use/i.test(text)) return { kind: 'port-conflict' }
  return { kind: 'unknown' }
}

/** URL 查询串里的 token 值打码（dsh 就绪行带 ?token=，进页面/日志前必须脱敏；] 后缀兼容 LAN 行的右括号）。 */
export function sanitizeLog(text: string): string {
  return text.replace(/([?&]token=)[^&\s"')]+/gi, '$1***')
}
