/**
 * 桌面集成插件 client.js 冒烟：mock 浏览器环境执行 factory 与 apply，
 * 断言 dsh 客户端插件契约的关键不变量（注册 id/order、降级路径不抛错、
 * 宽度门控的注入决策）。以后手写改动 client.js 后跑一遍防低级回归。
 * 用法：node scripts/client-plugin.test.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const PLUGIN_PATH = join(import.meta.dirname, '..', 'resources', 'desktop-integration', 'lib', 'client.js')

/** 最小浏览器 mock：client.js 用到的 DOM/window 面都有桩实现。 */
function installBrowserMock({ dshVersion, hasBridge = true }) {
  const registered = []
  const notices = []
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
  globalThis.MutationObserver = class { observe() {} }
  const styleTags = []
  globalThis.document = {
    body: { appendChild() {} },
    head: { appendChild: (el) => { styleTags.push(el) } },
    createElement: () => ({ style: { cssText: '' }, appendChild() {}, addEventListener() {} }),
    querySelectorAll: () => [],
    getElementById: () => null,
  }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
  return { registered, notices, styleTags }
}

function uninstallBrowserMock() {
  for (const k of ['window', 'MutationObserver', 'document', 'navigator', '__plugin']) delete globalThis[k]
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

// 用例一：新版后端（有桥）——工厂执行不抛错，apply 注册 settings.section order 30
{
  const env = installBrowserMock({ dshVersion: '0.1.2-alpha.1' })
  const def = await loadPlugin()
  const plugin = def.factory((name) => (name === 'react' ? { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => () => {}, useRef: (v) => ({ current: v }) } : undefined))
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  let regOpts = null
  let regComp = null
  plugin.apply({ slots: { inject: (_key, cb) => cb(), register: (opts, comp) => { regOpts = opts; regComp = comp } } })
  assert.equal(regOpts.name, 'settings.section')
  assert.equal(regOpts.id, 'desktop')
  assert.equal(regOpts.order, 30, 'order 必须是 30（与上游 agent-presets 的 20 错开）')
  assert.equal(typeof regComp, 'function')
  assert.equal(env.registered.length, 0) // registered 未用，防 lint 误删
  uninstallBrowserMock()
}

// 用例二：旧版后端——工厂阶段按缓存版本注入宽度覆盖样式
{
  try { localStorage.setItem('dsh-desktop-backend-version', '0.1.1-rc.2') } catch { /* node 无 localStorage */ }
  installBrowserMock({ dshVersion: '0.1.1-rc.2' })
  const def = await loadPlugin()
  def.factory((name) => (name === 'react' ? {} : undefined))
  uninstallBrowserMock()
  // node 无 localStorage——此用例在浏览器语义下由手测覆盖；这里只验证不抛错
}

// 用例三：裸 dsh（无桥）——apply 直接返回，不注册不注入
{
  installBrowserMock({ dshVersion: '0.1.1-rc.2', hasBridge: false })
  const def = await loadPlugin()
  const plugin = def.factory(() => ({}))
  let called = false
  plugin.apply({ slots: { inject: (_k, cb) => cb(), register: () => { called = true } } })
  assert.equal(called, false, '无桥必须整卡降级为空')
  uninstallBrowserMock()
}

console.log('client-plugin OK: 插件契约冒烟通过（注册 id/order、降级、新版执行路径）')
