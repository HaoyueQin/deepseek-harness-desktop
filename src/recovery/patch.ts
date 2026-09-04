/**
 * profile 用户补丁层（cordis.patch.yml）的解析与禁用/启用读写。
 * 机制参照 dshmarket `src/patch.ts`：dsh 把用户补丁层当 patch 列表应用——
 * `- id: X` + `disabled: true` 覆盖目标行（per-row last-write-wins），
 * `disabled: false` 强启用低层禁用行。壳是 host 外部进程（崩溃态无 loader），
 * 行归属只取包自身 patch 的 insert 子块（#147：reconfig 他人行的 id 绝不写）。
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { JSON_SCHEMA, defineScalarTag, load } from 'js-yaml'

/** 与 dshmarket check.ts 相同的 entry-list 方言（含 !!js 标量占位）。
 *  js-yaml v5 API：defineScalarTag 工厂 + Schema.withTags（v4 的 Type/extend 已移除）。 */
const jsExpr = defineScalarTag('tag:yaml.org,2002:js', {
  implicit: false,
  resolve: (source: string) => ({ __jsExpr: source }),
  identify: () => false,
})
const entrySchema = JSON_SCHEMA.withTags(jsExpr)

/** 解析 entry-list 文本；非顶层数组/不可读返回 null。 */
export function parsePatchText(text: string): unknown[] | null {
  try {
    const value = load(text, { schema: entrySchema })
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export function parsePatchFile(path: string): unknown[] | null {
  try {
    return parsePatchText(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 逐行读取 patch 文件的行结构（#147 语义：insert 子块内的 id 才是本包带来
 * 的行；顶层 `- id:` 行是补丁他人行的兄弟条目）。
 */
export function parsePatchRows(text: string): { names: string[]; ids: string[]; insertedIds: string[] } {
  const names: string[] = []
  const ids: string[] = []
  const insertedIds: string[] = []
  let insertIndent: number | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '')
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (/^\s*-?\s*insert:\s*$/.test(line)) { insertIndent = indent; continue }
    const name = /^\s*-?\s*name:\s*['"]?([^'"\s]+)/.exec(line)
    if (name !== null && !names.includes(name[1])) names.push(name[1])
    const id = /^\s*-?\s*id:\s*['"]?([^'"\s]+)/.exec(line)
    if (id !== null) {
      // ids 保留每次出现（insert 子块 id 与顶层 disable/enable 条目 id 是不同行实例）；
      // 只有 insertedIds 去重（本包插入的行集合）。
      ids.push(id[1])
      if (insertIndent !== null && indent > insertIndent) {
        if (!insertedIds.includes(id[1])) insertedIds.push(id[1])
      } else if (indent <= (insertIndent ?? -1)) {
        insertIndent = null
      }
    }
  }
  return { names, ids, insertedIds }
}

function readFileSafe(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

/** 一个包带来的行 id：包根 cordis.patch.yml + 声明的 dsh.bundle.patch 的 insert 子块
 *  （惯例路径在前，与测试规格一致；顺序对消费方 only every/some 无功能影响）。 */
export function bundlePatchInsertedIds(packageDir: string): string[] {
  const ids = new Set<string>()
  let manifest: { dsh?: { bundle?: { patch?: unknown } } } = {}
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as typeof manifest
  } catch { return [] }
  for (const id of parsePatchRows(readFileSafe(join(packageDir, 'cordis.patch.yml'))).insertedIds) ids.add(id)
  const declared = manifest.dsh?.bundle?.patch
  if (typeof declared === 'string' && declared !== '') {
    for (const id of parsePatchRows(readFileSafe(join(packageDir, declared))).insertedIds) ids.add(id)
  }
  return [...ids]
}

/** 用户补丁层现状（行扫描，同 dshmarket——YAML 全解析对结构要求过高）。 */
export function readUserPatchState(patchPath: string): { disables: string[]; forced: string[]; inserts: string[] } {
  const disables: string[] = []
  const forced: string[] = []
  const inserts: string[] = []
  const lines = readFileSafe(patchPath).split(/\r?\n/)
  let inInsert = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (/^- insert:\s*$/.test(line)) { inInsert = true; continue }
    if (/^- /.test(line)) inInsert = false
    if (inInsert) {
      const insertRow = /^ {4}- id: ([A-Za-z0-9_.-]+)/.exec(line)
      if (insertRow !== null) inserts.push(insertRow[1])
      continue
    }
    const disableRow = /^- id: ([A-Za-z0-9_.-]+)\s*$/.exec(line)
    if (disableRow === null) continue
    const next = lines[index + 1] ?? ''
    if (/^ {2}disabled: true\s*$/.test(next)) disables.push(disableRow[1])
    else if (/^ {2}disabled: false\s*$/.test(next)) forced.push(disableRow[1])
  }
  return { disables, forced, inserts }
}

/** 行 id 白名单：只允许普通无引号 YAML 标量。 */
const ROW_ID_RE = /^[A-Za-z0-9_.-]+$/

/** 宿主基础设施模块（禁禁用）：照搬 dshmarket PROTECTED_MODULE_PATTERNS。 */
const PROTECTED_MODULE_PATTERNS = [
  /^cordis:/, /^@deepseek-ai\/cordis-plugin-/, /^@deepseek-ai\/dsh-host-/,
  /^@deepseek-ai\/dsh-client-modules$/, /^@deepseek-ai\/dsh-client-connection$/,
  /^@deepseek-ai\/dsh-client-hmr$/, /^@deepseek-ai\/dsh-client-runtime$/,
  /^@deepseek-ai\/dsh-client-locale$/, /^@deepseek-ai\/dsh-client-web$/,
  /^@deepseek-ai\/dsh-web-frontend$/, /^@deepseek-ai\/dsh-web-app$/,
  /^@deepseek-ai\/dsh-settings/, /^@deepseek-ai\/dsh-credentials/,
  /^@deepseek-ai\/dsh-session$/, /^@deepseek-ai\/dsh-storage$/,
  /^@deepseek-ai\/dsh-typert$/, /^@deepseek-ai\/dsh-api-remotes$/,
  /^@deepseek-ai\/dsh-tools$/, /^@deepseek-ai\/dsh-system-prompt$/,
  /^@deepseek-ai\/dsh-agent/, /^@deepseek-ai\/dsh-llm/,
  /^@deepseek-ai\/dsh-persona$/, /^@deepseek-ai\/dsh-scope$/,
  /^@deepseek-ai\/dsh-launch-environment$/, /^@deepseek-ai\/dsh-shell$/,
  /^@deepseek-ai\/dsh-subprocess/, /^@deepseek-ai\/dsh-fs/,
  /^@deepseek-ai\/dsh-sandbox/, /^@deepseek-ai\/dsh-jobs$/,
  /^@deepseek-ai\/dsh-skill/, /^@deepseek-ai\/dsh-goal$/,
  /^@deepseek-ai\/dsh-workflow/, /^@deepseek-ai\/dsh-subagent/,
  /^@deepseek-ai\/dsh-web$/, /^@deepseek-ai\/dsh-workspace$/,
  /^@deepseek-ai\/dsh-user-approval$/, /^@deepseek-ai\/dsh-user-questions$/,
  /^@deepseek-ai\/dsh-commands$/, /^@deepseek-ai\/dsh-hook/,
  /^@deepseek-ai\/dsh-spill$/, /^@deepseek-ai\/dsh-guard$/,
  /^@deepseek-ai\/dsh-tool-call-timeout-policy$/, /^@deepseek-ai\/dsh-repeat-tool-reminder$/,
]

export function isProtectedModule(moduleName: string | undefined): boolean {
  return typeof moduleName === 'string' && PROTECTED_MODULE_PATTERNS.some((pattern) => pattern.test(moduleName))
}

/** 包关联的行 id（文件版，无 loader 来源——崩溃态无从查询）。 */
export function rowIdsForPackage(profileDir: string, packageName: string): string[] {
  return bundlePatchInsertedIds(join(profileDir, 'node_modules', packageName))
}

let writeQueue: Promise<unknown> = Promise.resolve()
function queuedWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}

function rowBlock(rowId: string, disabled: boolean): string {
  return '- id: ' + rowId + '\n  disabled: ' + (disabled ? 'true' : 'false') + '\n'
}

/** tmp+rename 原子写：写失败不动原文件。 */
function writeAtomic(path: string, content: string): void {
  const tmp = join(dirname(path), '.' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.tmp')
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

/**
 * 追加一个顶层补丁条目；任何非法情况拒绝且不动原文件。`[]` placeholder
 * 注释化；顶层 flow 结尾与非法 entry 列表都拒绝。
 */
function appendPatchEntry(patchPath: string, block: string): { ok: boolean; reason: string | null } {
  const text = readFileSafe(patchPath)
  const core = text.trim()
  if (core === '') {
    writeAtomic(patchPath, block)
    return { ok: true, reason: null }
  }
  const withoutComments = text.replace(/^[ \t]*#.*$/gmu, '').trim()
  if (withoutComments === '') {
    writeAtomic(patchPath, (text.endsWith('\n') ? text : text + '\n') + block)
    return { ok: true, reason: null }
  }
  if (withoutComments === '[]' || withoutComments === '[ ]') {
    const commented = text.replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '# []\n')
    writeAtomic(patchPath, (commented.endsWith('\n') ? commented : commented + '\n') + block)
    return { ok: true, reason: null }
  }
  const lastContentLine = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .pop() ?? ''
  if (/^[[{]/.test(lastContentLine)) {
    return { ok: false, reason: '补丁层以顶层流式结构结尾，不支持自动追加；请先整理为条目列表' }
  }
  if (parsePatchFile(patchPath) === null) {
    return { ok: false, reason: '补丁层不是合法的条目数组，已拒绝追加以免破坏；请先修正 YAML' }
  }
  writeAtomic(patchPath, (text.endsWith('\n') ? text : text + '\n') + block)
  return { ok: true, reason: null }
}

/** 禁用一行：追加 `- id: X` + `disabled: true`（幂等：已禁用直接 ok）。 */
export function disableRow(patchPath: string, rowId: string): Promise<{ ok: boolean; reason: string | null }> {
  return queuedWrite(async () => {
    if (!ROW_ID_RE.test(rowId)) {
      return { ok: false, reason: '行 id ' + rowId + ' 含特殊字符，不支持写入补丁层' }
    }
    const state = readUserPatchState(patchPath)
    if (state.disables.includes(rowId)) return { ok: true, reason: null }
    return appendPatchEntry(patchPath, rowBlock(rowId, true))
  })
}

/**
 * 启用一行：删除 `disabled: true` 块；无块且不在 forced 时追加
 * `disabled: false`（低层 bundle 禁用它时强启用）。
 */
export function enableRow(patchPath: string, rowId: string): Promise<{ ok: boolean; reason: string | null }> {
  return queuedWrite(async () => {
    if (!ROW_ID_RE.test(rowId)) {
      return { ok: false, reason: '行 id ' + rowId + ' 含特殊字符，不支持写入补丁层' }
    }
    const state = readUserPatchState(patchPath)
    const escaped = rowId.replace(/[.*+?]/g, '\\$&')
    const blockRe = new RegExp('^- id: [\'"]?' + escaped + '[\'"]?\r?\n  disabled: true\r?\n', 'mu')
    const text = readFileSafe(patchPath)
    if (blockRe.test(text)) {
      writeAtomic(patchPath, withPlaceholderRestored(text.replace(blockRe, '')))
      return { ok: true, reason: null }
    }
    if (state.forced.includes(rowId)) return { ok: true, reason: null }
    return appendPatchEntry(patchPath, rowBlock(rowId, false))
  })
}

/** 删光后把 `[]` placeholder 恢复（纯注释不是顶层数组，dsh 会拒绝启动）。 */
function withPlaceholderRestored(text: string): string {
  const stripped = text.replace(/^#[ \t]\[\][ \t]*(?:#.*)?\r?\n/gmu, '').trim()
  if (stripped === '') return '# Your patch layer for this dsh profile.\n[]\n'
  return text
}
