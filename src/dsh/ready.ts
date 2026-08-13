/**
 * 就绪探测：HTTP GET 直到 2xx。与 stdout URL 行（dsh 官方 readiness signal）
 * 双保险——URL 行出现不代表 dist 已挂载完成，页面可访问才算 ready。
 */

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' })
      if (res.ok) return
      lastError = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastError = err
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`dsh web 就绪超时（${timeoutMs}ms）: ${url} 最后错误: ${String(lastError)}`)
}
