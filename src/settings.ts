/**
 * 壳自有设置（userData/settings.json）。开机自启状态不入此文件——
 * 由 autostart.ts 底层（注册表/LaunchServices/XDG 文件）自持。
 */
import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** 监听端口策略：固定端口号，或 'random'（每次启动随机分配）。 */
export type PortPolicy = number | 'random'

interface ShellSettings { launchMinimized?: boolean; portPolicy?: PortPolicy }

/**
 * 端口策略归一化：'random' 保留；1024–65535 整数视为固定端口；
 * 其余（含缺省）回落 3080（与 dsh web 默认一致）。低于 1024 的端口
 * bind 需要管理员权限，直接拒绝。
 */
export function normalizePortPolicy(v: unknown): PortPolicy {
  if (v === 'random') return 'random'
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number.parseInt(v, 10) : Number.NaN
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 3080
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** 内存缓存：避免每次读取都 JSON.parse 文件，也让 set 的读改写基于最新状态。 */
let cached: ShellSettings | null = null

function read(): ShellSettings {
  if (cached !== null) return cached
  try {
    cached = JSON.parse(readFileSync(settingsPath(), 'utf8')) as ShellSettings
  } catch {
    cached = {}
  }
  return cached
}

function write(next: ShellSettings): void {
  cached = next
  try {
    const target = settingsPath()
    // 原子写：先写同目录临时文件再 rename 覆盖。避免进程被强杀/断电时
    // 留下截断的 settings.json（下次 JSON.parse 失败丢全部设置）。
    // userData 目录由 Electron 保证存在，无需额外 mkdir。
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, target)
  } catch {
    /* 设置写失败不阻断主流程（缓存已更新，后续 set 会继续尝试落盘） */
  }
}

export function getLaunchMinimized(): boolean {
  return read().launchMinimized === true
}

export function setLaunchMinimized(v: boolean): void {
  write({ ...read(), launchMinimized: v })
}

export function getPortPolicy(): PortPolicy {
  return normalizePortPolicy(read().portPolicy)
}

export function setPortPolicy(v: unknown): void {
  write({ ...read(), portPolicy: normalizePortPolicy(v) })
}
