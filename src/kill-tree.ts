/**
 * 子进程树终止：超时/异常路径只杀直接子进程不够——Windows 下 ComSpec cmd
 * 会让 npm.cmd/node/pnpm 孙进程存活，与用户随后的重试操作并发（pnpm/npm
 * 同时写同一目录）。Windows 用 taskkill /T /F 树杀；taskkill 2s 内未收尾
 * 或不可用时退回单进程 SIGKILL。POSIX 保留单进程 SIGKILL（npm 直接
 * spawn 无 cmd 中间层，孙进程残留风险低；组杀需 spawn detached 改动，
 * 出现真实 POSIX 孤儿问题再引入 detached+进程组）。
 */
import { spawn, type ChildProcess } from 'node:child_process'

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'win32') {
    try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    return
  }
  const fallback = (): void => {
    try { child.kill('SIGKILL') } catch { /* 已退出 */ }
  }
  const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  })
  const timer = setTimeout(fallback, 2_000)
  killer.on('exit', () => clearTimeout(timer))
  killer.on('error', () => { clearTimeout(timer); fallback() })
}
