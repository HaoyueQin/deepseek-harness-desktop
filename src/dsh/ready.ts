/**
 * 就绪探测：收到任意 HTTP 响应即视为服务器已应答。与 stdout URL 行（dsh 官方
 * readiness signal）双保险。不能只认 2xx：0.1.2-alpha.1 起 URL 带进程 token，
 * 探测请求（无 cookie 罐）得到的是 303→重定向后 401；旧版本返回 200。页面级
 * 鉴权由 Electron loadURL 的 cookie 流处理，探测只负责"端口在应答"。
 * redirect:'manual'：不跟随 303，收到响应即返回。
 */

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: 'GET', redirect: 'manual' })
      return
    } catch (err) {
      lastError = err
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`dsh web 就绪超时（${timeoutMs}ms）: ${url} 最后错误: ${String(lastError)}`)
}
