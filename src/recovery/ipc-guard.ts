/**
 * 恢复模式 IPC 来源校验（纯函数，可 node --test 直测 dist）。
 * 主窗口双页面共用 preload 桥：壳原生恢复页（file://…/recovery.html）与
 * dsh 页面（http(s)://127.0.0.1|localhost）都可发起 invoke。恢复面通道
 * （诊断/插件救火/版本切换）只放行恢复页；dsh 页面交互通道（open-update
 * 设置页交接、open 手动入口）只放行 dsh 页。其余一律 other——崩溃兜底面
 * 不被正常页面误触/滥用（纵深防御，dsh 插件生态本身是信任根）。
 */
export type IpcSenderKind = 'recovery' | 'dsh-page' | 'other'

export function ipcSenderKind(url: string | null | undefined): IpcSenderKind {
  if (typeof url !== 'string' || url === '') return 'other'
  let u: URL
  try { u = new URL(url) } catch { return 'other' }
  if (u.protocol === 'file:') {
    return decodeURIComponent(u.pathname).endsWith('/recovery.html') ? 'recovery' : 'other'
  }
  if ((u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) {
    return 'dsh-page'
  }
  return 'other'
}
