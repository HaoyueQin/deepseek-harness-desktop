/**
 * 标题栏注入脚本（executeJavaScript 执行于页面主世界，必须是纯 IIFE 字符串，
 * 不能有模块语法）。
 *
 * 布局策略（不修改 dsh 源码）：
 *  - 在页面顶部叠加一条独立 26px 标题栏（fixed），整条 -webkit-app-region:
 *    drag 可拖窗口；右上角自绘最小化/最大化/关闭，图标/文字颜色用
 *    var(--dsw-alias-label-secondary)（挂在 body 下继承 token，明暗主题自动
 *    跟随，无需手动监听 prefers-color-scheme）。
 *  - 页面主体用 body padding-top 整体下移 26px（box-sizing:border-box 使内容框
 *    自动缩小，dsh base.css 的 body/#root height:100% 保持可用，无需也不应
 *    再改 #root 高度——否则会被重复扣减、底部露出空白）。标题栏独占一条
 *    空间，不再悬浮遮挡 dsh 头部（Session log / 插件按钮均不受影响）。
 *    背景透明露出 body 背景（--dsw-alias-bg-base），与页面无缝衔接。
 *  - 无 #root 时不注入（避免破坏布局）；Mac 保留原生红绿灯不注入。
 */
export const INJECT_TITLEBAR = `(() => {
  if (window.dshDesktop === undefined || /Mac/i.test(navigator.userAgent)) return
  const HEIGHT = 26
  const BRAND = '#4176e6'
  if (document.getElementById('root') === null) return
  const style = document.createElement('style')
  style.textContent = 'body{padding-top:' + HEIGHT + 'px;box-sizing:border-box}'
  document.head.appendChild(style)
  const mk = (svg, title, fn) => {
    const b = document.createElement('button')
    b.type = 'button'; b.title = title; b.setAttribute('aria-label', title)
    b.style.cssText = 'width:46px;height:' + HEIGHT + 'px;border:0;margin:0;padding:0;' +
      'background:transparent;color:var(--dsw-alias-label-secondary);cursor:default;' +
      'display:flex;align-items:center;justify-content:center;outline:none;-webkit-app-region:no-drag'
    b.innerHTML = svg
    b.addEventListener('click', fn)
    b.addEventListener('mouseenter', () => { b.style.background = BRAND; b.style.color = '#fff' })
    b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; b.style.color = 'var(--dsw-alias-label-secondary)' })
    return b
  }
  const bar = document.createElement('div')
  // 整条可拖（含空白区）；按钮自身 no-drag 优先于父级 drag
  // z-index 用 9999（远高于内容层，但不取 MAX_VALUE）：页面主体已靠
  // body padding-top 下移 26px，标题栏与内容区不重叠；固定条只需悬于
  // 常规内容之上，MAX 值会不必要地压住 dsh 任何真实弹层/Toast。
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:' + HEIGHT + 'px;z-index:9999;' +
    'display:flex;align-items:stretch;justify-content:flex-end;-webkit-app-region:drag'
  // 刷新图标：Bootstrap Icons（MIT）官方 bi-arrow-clockwise 原版路径——
  // viewBox 0 0 16 16；实心小箭头在 14px 下仍可辨（10px 实测会糊，16px 显大）。
  // 显示 14px：原版无描边（线宽 0.94px，46x26 按钮内居中，与三键 1px 线框一致）。
  const RF = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">' +
    '<path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z"/>' +
    '<path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466"/></svg>'
  const M = '<svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" stroke-width="1"/></svg>'
  const R = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>'
  const T = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><line x1="2.5" y1="2.5" x2="2.5" y2="0.5" stroke="currentColor" stroke-width="1"/><line x1="2.5" y1="0.5" x2="9.5" y2="0.5" stroke="currentColor" stroke-width="1"/><line x1="9.5" y1="0.5" x2="9.5" y2="7.5" stroke="currentColor" stroke-width="1"/></svg>'
  const C = '<svg width="10" height="10" viewBox="0 0 10 10"><line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1"/><line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" stroke-width="1"/></svg>'
  const refresh = mk(RF, '刷新页面', () => window.location.reload())
  const min = mk(M, '最小化', () => window.dshDesktop.minimize())
  const max = mk(R, '最大化', () => window.dshDesktop.maximizeToggle())
  const restore = mk(T, '还原', () => window.dshDesktop.maximizeToggle())
  const close = mk(C, '关闭（隐藏到托盘）', () => window.dshDesktop.close())
  let maximized = false
  window.dshDesktop.onMaximized(s => { maximized = s; if (maximized) max.replaceWith(restore); else restore.replaceWith(max) })
  // 刷新按钮位于窗口控制按钮左侧（最小化左边），体验同浏览器 F5
  bar.appendChild(refresh); bar.appendChild(min); bar.appendChild(max); bar.appendChild(close)
  document.body.appendChild(bar)
})()`
