/**
 * 桌面集成插件 client.js 冒烟：mock 浏览器环境执行 factory 与 apply，
 * 断言 dsh 客户端插件契约的关键不变量（注册 id/order、无桥降级路径不抛错、
 * 壳不注入任何宽度实现）。
 * 以后手写改动 client.js 后跑一遍防低级回归。
 * 用法：node scripts/client-plugin.test.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const PLUGIN_PATH = join(import.meta.dirname, '..', 'resources', 'desktop-integration', 'lib', 'client.js')

/** 可交互的假会话根：记录 style/children，供挂载与发布断言。 */
function makeFakeRoot() {
  const children = []
  const styles = {}
  const root = {
    children,
    styles,
    style: {
      setProperty: (k, v) => { styles[k] = v },
      removeProperty: (k) => { delete styles[k] },
    },
    getBoundingClientRect: () => ({ width: 1000 }),
    querySelector: (sel) => children.find((c) => c.matches(sel)) ?? null,
    querySelectorAll: (sel) => children.filter((c) => c.matches(sel)),
    appendChild: (el) => children.push(el),
  }
  return root
}

function makeFakeHandle() {
  const attrs = {}
  const handle = {
    attrs,
    style: { setProperty: () => {} },
    setAttribute: (k, v) => { attrs[k] = v },
    removeAttribute: (k) => { delete attrs[k] },
    addEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ top: 0, width: 40 }),
    remove() { handle.removed = true },
    matches: () => false, // 通用 mock：不匹配任何真实选择器
  }
  return handle
}

/** 最小浏览器 mock：client.js 用到的 DOM/window 面都有桩实现。 */
function installBrowserMock({ dshVersion, hasBridge = true, storage = {} }) {
  const registered = []
  const notices = []
  const styleTags = []
  const fakeRoot = makeFakeRoot()
  const bridge = hasBridge ? {
    getInfo: () => Promise.resolve({ dshVersion, appVersion: 'test', dshHome: 'h', logDir: 'l', backendSource: 'npm-global', sourceDir: null, notice: null }),
    backend: {
      getConfig: () => Promise.resolve({ mode: 'auto', sourceDir: '', networkProxy: '', validation: null }),
      setConfig: () => Promise.resolve({ ok: true }),
      pickDir: () => Promise.resolve(null),
      validate: () => Promise.resolve(null),
      restart: () => Promise.resolve({ ok: true }),
      onNotice: (cb) => { notices.push(cb); return () => {} },
      check: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      onStatus: () => () => {},
    },
    update: { check: () => Promise.resolve({}), download: () => Promise.resolve({}), install: () => Promise.resolve({}), onStatus: () => () => {} },
    autostart: { get: () => Promise.resolve(false), set: () => Promise.resolve() },
    launchMinimized: { get: () => Promise.resolve(false), set: () => Promise.resolve() },
    portPolicy: { get: () => Promise.resolve({ configured: 3080, actual: 3080, degraded: false }), set: () => Promise.resolve() },
    openPath: () => Promise.resolve({ ok: true }),
    setup: {
      onSourceOutput: () => () => {},
      onSourceExit: () => () => {},
      cloneSource: () => Promise.resolve({ ok: true }),
      prepareSource: () => Promise.resolve({ ok: true }),
    },
  } : undefined

  globalThis.window = { __ModuleLoader__: { load: (def) => { globalThis.__plugin = def } }, dshDesktop: bridge }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.ResizeObserver = class { observe() {} disconnect() {} }
  globalThis.localStorage = {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = v },
    removeItem: (k) => { delete storage[k] },
  }
  globalThis.document = {
    body: { appendChild() {} },
    head: { appendChild: (el) => { styleTags.push(el) } },
    createElement: () => makeFakeHandle(),
    // 会话根选择器 → 假根；手柄清理选择器 → 假根当前手柄
    querySelectorAll: (sel) => (sel.includes("data-phase") ? [fakeRoot] : fakeRoot.querySelectorAll(sel)),
    getElementById: (id) => styleTags.find((t) => t.id === id) ?? null,
  }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
  return { registered, notices, styleTags, fakeRoot, storage }
}

function uninstallBrowserMock() {
  for (const k of ['window', 'MutationObserver', 'ResizeObserver', 'document', 'navigator', '__plugin', 'localStorage']) delete globalThis[k]
}

let cachedDef = null
async function loadPlugin() {
  // ESM 只执行一次：首次 import 触发 __ModuleLoader__.load，后续复用缓存的定义
  if (cachedDef === null) {
    await import(pathToFileURL(PLUGIN_PATH).href)
    cachedDef = globalThis.__plugin
  }
  const def = cachedDef
  assert.equal(def.id, 'dsh-desktop-integration')
  assert.equal(typeof def.factory, 'function')
  return def
}

const reactStub = {
  createElement: () => null,
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => () => {},
  useRef: (v) => ({ current: v }),
}

// 用例一：新版后端（有桥）——工厂执行不抛错，apply 注册 settings.section order 30
{
  const env = installBrowserMock({ dshVersion: '0.1.2-rc.1' })
  const def = await loadPlugin()
  const plugin = def.factory((name) => (name === 'react' ? reactStub : undefined))
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  let regOpts = null
  let regComp = null
  plugin.apply({ slots: { inject: (_key, cb) => cb(), register: (opts, comp) => { regOpts = opts; regComp = comp } } })
  assert.equal(regOpts.name, 'settings.section')
  assert.equal(regOpts.id, 'desktop')
  assert.equal(regOpts.order, 30, 'order 必须是 30（与上游 agent-presets 的 20 错开）')
  assert.equal(typeof regComp, 'function')
  await new Promise((r) => setImmediate(r)) // 刷 getInfo 微任务
  assert.equal(env.fakeRoot.children.length, 0, '受支持版本不得注入任何宽度实现')
  assert.equal(env.styleTags.length, 0, '受支持版本不得注入任何样式')
  uninstallBrowserMock()
}

// 用例三：裸 dsh（无桥）——apply 直接返回，不注册不注入
{
  installBrowserMock({ dshVersion: '0.1.2-rc.1', hasBridge: false })
  const def = await loadPlugin()
  const plugin = def.factory(() => ({}))
  let called = false
  plugin.apply({ slots: { inject: (_k, cb) => cb(), register: () => { called = true } } })
  assert.equal(called, false, '无桥必须整卡降级为空')
  uninstallBrowserMock()
}

console.log('client-plugin OK: 插件契约冒烟通过（注册 id/order、无桥降级、不注入任何宽度实现）')
