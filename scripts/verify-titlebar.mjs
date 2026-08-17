/**
 * 标题栏注入脚本验证（无 GUI，最小 DOM stub）：
 *  1) body padding-top + #root 高度补偿：页面主体完整下移标题栏高度，不溢出
 *  2) 标题栏挂到 body（继承 token，明暗跟随），整条 drag、按钮 no-drag
 *  3) 三个窗口按钮各自绑定正确 IPC 调用（minimize/maximizeToggle/close）
 *  4) 最大化状态推送切换 最大化/还原 图标
 *  5) 无 #root 时不注入（不破坏布局）；Mac 不注入
 *
 * 用法：node scripts/verify-titlebar.mjs
 */

import { INJECT_TITLEBAR } from '../dist/titlebar.js'
import assert from 'node:assert/strict'

function makeEl(tag) {
  return {
    tagName: tag,
    style: {},
    attrs: {},
    children: [],
    handlers: {},
    parent: null,
    setAttribute(k, v) { this.attrs[k] = v },
    addEventListener(evt, fn) { this.handlers[evt] = fn },
    appendChild(c) { c.parent = this; this.children.push(c); return c },
    replaceWith(n) {
      const i = this.parent.children.indexOf(this)
      if (i !== -1) {
        this.parent.children.splice(i, 1, n)
        n.parent = this.parent
      }
    },
  }
}

function makeEnv({ hasRoot = true, isMac = false } = {}) {
  const root = hasRoot ? makeEl('div') : null
  const doc = {
    body: makeEl('body'),
    head: makeEl('head'),
    documentElement: makeEl('html'),
    createElement(tag) { return makeEl(tag) },
    getElementById(id) { return id === 'root' ? root : null },
  }
  const calls = { minimize: 0, maximizeToggle: 0, close: 0 }
  const win = {
    dshDesktop: {
      minimize() { calls.minimize++ },
      maximizeToggle() { calls.maximizeToggle++ },
      close() { calls.close++ },
      onMaximized(cb) { win._maxCb = cb },
    },
  }
  const run = () => {
    const fn = new Function('window', 'document', 'navigator', `return (${INJECT_TITLEBAR})`)
    fn(win, doc, { userAgent: isMac ? 'Macintosh' : 'Windows' })
    return { doc, win, calls, root }
  }
  return { doc, win, calls, root, run }
}

// 1) 正常注入：主体下移 + 标题栏结构
{
  const { doc, run } = makeEnv()
  run()
  const injected = doc.head.children.find(c => c.tagName === 'style')
  assert.ok(injected !== undefined, '应注入补偿样式')
  assert.ok(injected.textContent.includes('body{padding-top:26px;box-sizing:border-box}'), 'body 应下移 26px')
  // #root 保持 dsh base.css 的 height:100% 即可（body border-box 内容框已自动
  // 缩小），多扣一次高度会在底部露出空白——断言不得注入 #root 规则
  assert.ok(!injected.textContent.includes('#root'), '不得再改 #root 高度')
  const bar = doc.body.children.at(-1)
  assert.ok(bar !== undefined && bar.style.cssText.includes('position:fixed'), '标题栏应为 fixed 元素')
  assert.ok(bar.style.cssText.includes('-webkit-app-region:drag'), '标题栏整条可拖拽')
  assert.equal(bar.children.length, 3, '应有 3 个窗口按钮')
  for (const b of bar.children) {
    assert.ok(b.style.cssText.includes('-webkit-app-region:no-drag'), '按钮应为 no-drag（点击优先）')
  }
  console.log('OK 1: 主体下移 + 标题栏 drag/按钮 no-drag')
}

// 2) 按钮绑定正确 IPC 调用
{
  const { run, calls, doc } = makeEnv()
  run()
  const bar = doc.body.children.at(-1)
  const [min, max, close] = bar.children
  min.handlers.click()
  max.handlers.click()
  close.handlers.click()
  assert.deepEqual(calls, { minimize: 1, maximizeToggle: 1, close: 1 }, '按钮应分别触发 minimize/maximizeToggle/close')
  console.log('OK 2: 按钮绑定正确 IPC 调用')
}

// 3) 最大化状态推送切换 最大化/还原 图标
{
  const { run, win, doc } = makeEnv()
  run()
  const bar = doc.body.children.at(-1)
  assert.ok(win._maxCb !== undefined, '应注册 onMaximized 监听')
  win._maxCb(true)
  assert.ok(bar.children.at(1).title === '还原', '最大化时应切换到还原按钮')
  win._maxCb(false)
  assert.ok(bar.children.at(1).title === '最大化', '还原时应切回最大化按钮')
  console.log('OK 3: 最大化状态图标切换')
}

// 4) 无 #root 时不注入（布局安全）
{
  const { run, doc } = makeEnv({ hasRoot: false })
  run()
  assert.equal(doc.head.children.length, 0, '无 #root 时不应注入补偿样式')
  assert.equal(doc.body.children.length, 0, '无 #root 时不应挂标题栏')
  console.log('OK 4: 无 #root 不注入')
}

// 5) Mac 不注入（保留原生红绿灯）
{
  const { run, doc } = makeEnv({ isMac: true })
  run()
  assert.equal(doc.head.children.length, 0, 'Mac 不应注入补偿样式')
  console.log('OK 5: Mac 不注入')
}

console.log('TITLEBAR VERIFY OK: 全部通过')
