/**
 * 系统托盘：打开主窗口 / 开机自启开关 / 退出。窗口关闭只隐藏（托盘常驻），
 * 托盘“退出”才真正停止 dsh 并结束进程。
 *
 * 「开机自启」勾选是创建时的快照：设置页开关（dsh-app:set-autostart）变更
 * 注册表后，经 syncTrayAutostart() 刷新本菜单项，保证两个入口双向同步。
 */

import { Menu, Tray, nativeImage, type MenuItem } from 'electron'
import { isAutostartEnabled, setAutostart } from './autostart.js'

export interface TrayHandlers {
  show: () => void
  quit: () => void
}

let autostartItem: MenuItem | null = null

export function createTray(iconPath: string, handlers: TrayHandlers): Tray {
  let image = nativeImage.createFromPath(iconPath)
  // Windows 托盘需要小尺寸；mac 用 template 适配深色菜单栏，linux 16-22px
  if (process.platform === 'darwin') {
    image = image.resize({ width: 18, height: 18 })
    image.setTemplateImage(true)
  } else if (process.platform === 'win32') {
    image = image.resize({ width: 16, height: 16 })
  }
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
  autostartItem = menu.items.find((item) => item.type === 'checkbox') ?? null
  tray.setContextMenu(menu)
  // Windows/Linux 单击托盘显示主窗；mac 单击默认弹菜单，click 不触发，无副作用
  tray.on('click', handlers.show)
  return tray
}

/** 设置页开关变更后同步托盘勾选（两个入口共用同一底层状态）。 */
export function syncTrayAutostart(): void {
  if (autostartItem === null) return
  const enabled = isAutostartEnabled()
  if (autostartItem.checked !== enabled) autostartItem.checked = enabled
}
