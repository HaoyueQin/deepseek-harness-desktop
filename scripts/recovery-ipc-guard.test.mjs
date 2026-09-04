/**
 * 恢复模式 IPC 来源校验单测：ipcSenderKind（恢复页/dsh 页/拒绝三分）。
 * 用法：npm run build && node scripts/recovery-ipc-guard.test.mjs
 */
import assert from 'node:assert/strict'
import { ipcSenderKind } from '../dist/recovery/ipc-guard.js'

// 壳原生恢复页（file://）：开发路径、打包 asar 路径、带查询串
assert.equal(ipcSenderKind('file:///D:/Project/app/resources/recovery.html'), 'recovery')
assert.equal(ipcSenderKind('file:///C:/Users/x/AppData/Local/Programs/DeepSeek%20Harness%20Desktop/resources/recovery.html'), 'recovery')
assert.equal(ipcSenderKind('file:///D:/x/resources/recovery.html?v=1'), 'recovery')

// file:// 的其他页面不是恢复页
assert.equal(ipcSenderKind('file:///D:/x/index.html'), 'other')

// dsh 本地页面（设置页交接 open-update / 手动入口 open 的合法调用方）
assert.equal(ipcSenderKind('http://127.0.0.1:3080/'), 'dsh-page')
assert.equal(ipcSenderKind('http://localhost:5698/settings'), 'dsh-page')
assert.equal(ipcSenderKind('https://127.0.0.1:3080/'), 'dsh-page')

// 其余一律拒绝
assert.equal(ipcSenderKind('https://evil.example/'), 'other')
assert.equal(ipcSenderKind('http://192.168.1.2:3080/'), 'other') // LAN 地址不算 dsh 页
assert.equal(ipcSenderKind('data:text/html,<b>hi</b>'), 'other')
assert.equal(ipcSenderKind(''), 'other')
assert.equal(ipcSenderKind(null), 'other')
assert.equal(ipcSenderKind(undefined), 'other')
assert.equal(ipcSenderKind('not a url'), 'other')

console.log('recovery-ipc-guard OK')
