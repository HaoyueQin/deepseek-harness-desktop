# DeepSeek Harness Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）包装成桌面应用的 Electron 壳。

壳与 dsh 本体是**纯运行时关系**：壳 spawn 一个内置 Node 进程跑 `dsh web`，在 BrowserWindow 里加载其 localhost 页面。零侵入，不 fork、不修改 dsh 源码。

## 架构

```
Electron 壳（本仓库）
   │  spawn（内置 Node 24 LTS → resources/dsh 里的 dsh web --port 0）
   ▼
dsh Node 进程（@deepseek-ai/dsh，自带前端 dist，随包携带完整依赖树）
   │  解析 stdout 行 "dsh web: http://127.0.0.1:<port>"（官方 readiness signal）
   ▼
BrowserWindow（frameless，融合窗口控制条，关闭隐藏到托盘）
```

- **端口**：`--port 0` 让 OS 分配，从 dsh 的 stdout URL 行读实际端口——官方钦定的 supervisor 通道，无端口冲突
- **数据隔离**：`DSH_HOME=<userData>/dsh`，不污染用户默认 `~/.dsh`
- **托盘常驻**：关窗口隐藏到托盘，托盘退出才停止 dsh；托盘菜单含开机自启开关
- **单实例**：`requestSingleInstanceLock`，第二实例唤起已有窗口
- **安全**：dsh 仅监听 127.0.0.1；渲染进程 `contextIsolation + sandbox`，无 nodeIntegration

## 开发

```sh
npm install          # 安装 electron 等（国内网络下 electron 二进制需镜像/代理，见下方）
npm run dev          # dev 模式：系统 node + 项目 node_modules 里的 dsh
```

> **electron 二进制下载失败？**（`Downloading Electron binary...` 卡住）
> 手动下载 `https://npmmirror.com/mirrors/electron/<版本>/electron-v<版本>-win32-x64.zip` 放入
> `%LOCALAPPDATA%\electron\Cache\electron-v<版本>-win32-x64\`，然后：
> ```sh
> printf "electron.exe" > node_modules/electron/path.txt
> # 手动解压 zip 到 node_modules/electron/dist/
> ```

## 打包

```sh
npm run build:runtime     # 生成 resources/（内置 Node 24 + dsh 依赖树 + 图标）
                          # 网络不佳时：HTTPS_PROXY=http://127.0.0.1:7890 npm run build:runtime
npm run dist:win          # Windows NSIS 安装包 → release/
# npm run dist:mac        # macOS dmg（需要 macOS 环境，CI 走 macos runner）
# npm run dist:linux      # Linux AppImage + deb
```

产物通过 GitHub Actions 三平台 matrix 自动发布（`.github/workflows/release.yml`）。

## 目录

```
src/
  main.ts          主进程：单实例、窗口、托盘、dsh 生命周期编排
  paths.ts         dev/prod 资源路径解析（resources/dsh、内置 node、preload）
  dsh/spawn.ts     spawn dsh web --port 0，stdout URL 行解析，优雅停止
  dsh/ready.ts     HTTP 就绪探测
  tray.ts          托盘（打开/开机自启/退出）
  autostart.ts     开机自启（win/mac 原生 + linux XDG autostart）
  preload.ts       contextBridge 暴露窗口控制 IPC（编译为 CJS）
scripts/
  install-runtime.mjs  构建时填充 resources/（Node 发行版 + dsh 依赖树 + 图标）
  smoke.mjs            无 GUI 冒烟：spawn dsh，断言 URL 行 + HTTP 200（--runtime 用内置运行时）
```

## 已知限制（V1）

- 安装包约 150MB+（内置 Node + dsh 完整依赖树），未做体积裁剪
- macOS 无签名公证，首次运行需右键"打开"
- dsh 处于 developer preview，兼容性破坏频繁；壳锁定 `@deepseek-ai/dsh` 版本，升级需重新打包验证
- 无自动更新（electron-updater），留作 V2
