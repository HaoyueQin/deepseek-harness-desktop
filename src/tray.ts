/**
 * 系统托盘：打开主窗口 / 开机自启开关 / 退出。窗口关闭只隐藏（托盘常驻），
 * 托盘“退出”才真正停止 dsh 并结束进程。
 */

import { Menu, Tray, nativeImage } from 'electron'
import { isAutostartEnabled, setAutostart } from './autostart.js'

export interface TrayHandlers {
  show: () => void
  quit: () => void
}

export function createTray(iconPath: string, handlers: TrayHandlers): Tray {
  let image = nativeImage.createFromPath(iconPath)
  // Windows 托盘需要小尺寸；mac 会用模板适配，linux 16-22px
  if (process.platform === 'win32') image = image.resize({ width: 16, height: 16 })
  const tray = new Tray(image)
  tray.setToolTip('DeepSeek Harness Desktop')

  const menu = Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: handlers.show },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: isAutostartEnabled(),
      click: (item) => setAutostart(item.checked),
    },
    { type: 'separator' },
    { label: '退出', click: handlers.quit },
  ])
  tray.setContextMenu(menu)
  // Windows/Linux 单击托盘显示主窗；mac 单击默认弹菜单，click 不触发，无副作用
  tray.on('click', handlers.show)
  return tray
}
