/**
 * dsh home 解析最小验证：未设 / 显式设置 / ~ 展开 / 空白视为未设。
 * 用法：npm run build && node scripts/home-resolution.test.mjs
 */

import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { dshHomeDir, resolveDshHomeDir, DSH_HOME_ENV } from '../dist/dsh-home.js'

// 未设 → ~/.dsh
assert.equal(resolveDshHomeDir({}), join(homedir(), '.dsh'), '未设 DSH_HOME 应回退 ~/.dsh')

// 显式设置 → 原样（规范化）
assert.equal(resolveDshHomeDir({ [DSH_HOME_ENV]: 'D:/custom/dsh' }), resolve('D:/custom/dsh'))

// ~ 前缀展开（正斜杠）
assert.equal(resolveDshHomeDir({ [DSH_HOME_ENV]: '~/dsh-test' }), join(homedir(), 'dsh-test'))

// ~ 前缀展开（反斜杠，Windows 风格）
assert.equal(resolveDshHomeDir({ [DSH_HOME_ENV]: '~\\dsh-win' }), join(homedir(), 'dsh-win'))

// 纯 "~" → home
assert.equal(resolveDshHomeDir({ [DSH_HOME_ENV]: '~' }), homedir())

// 相对路径按 process.cwd() 解析（对齐官方 resolve 语义）
assert.equal(resolveDshHomeDir({ [DSH_HOME_ENV]: 'dsh-relative' }), resolve('dsh-relative'))

// 空白视为未设
assert.equal(resolveDshHomeDir({ [DSH_HOME_ENV]: '   ' }), join(homedir(), '.dsh'))

// 运行期别名一致
assert.equal(dshHomeDir(), resolveDshHomeDir())

console.log('home-resolution OK: dsh home = ' + dshHomeDir())
