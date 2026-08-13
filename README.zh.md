<p align="center">
  <img src="./assets/wordmark.svg" alt="DeepSeek Harness Desktop" width="360" />
</p>

# DeepSeek Harness Desktop

[![Release](https://img.shields.io/github/v/release/HaoyueQin/deepseek-harness-desktop?style=flat-square&logo=github)](https://github.com/HaoyueQin/deepseek-harness-desktop/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/HaoyueQin/deepseek-harness-desktop/release.yml?style=flat-square&label=build)](https://github.com/HaoyueQin/deepseek-harness-desktop/actions)
[![Stars](https://img.shields.io/github/stars/HaoyueQin/deepseek-harness-desktop?style=flat-square)](https://github.com/HaoyueQin/deepseek-harness-desktop/stargazers)
[![License](https://img.shields.io/github/license/HaoyueQin/deepseek-harness-desktop?style=flat-square)](LICENSE)
[![Issues](https://img.shields.io/github/issues/HaoyueQin/deepseek-harness-desktop?style=flat-square)](https://github.com/HaoyueQin/deepseek-harness-desktop/issues)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4176e6?style=flat-square)]()

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek 开源的可插拔 AI Agent harness）打造的桌面应用壳，把官方 `dsh web` 界面包装成原生质感、常驻后台的桌面应用。

[English](README.md) | 简体中文

## 特性

- **零侵入包装** — 以子进程方式运行 `dsh web`（内置 Node 24 + `@deepseek-ai/dsh`），加载其 localhost 界面；harness 源码零改动，升级只需换版本号
- **无边框沉浸窗口** — 无原生标题栏；自绘窗口控制按钮（最小化/最大化/关闭）以 DeepSeek 品牌蓝 hover 融入页面，并随明暗主题切换
- **托盘常驻** — 关闭窗口隐藏到系统托盘而非退出，后端持续运行，随时秒开
- **开机自启** — 托盘菜单一键开关（Windows/macOS 原生实现；Linux 走 XDG autostart）
- **端口冲突免疫** — `--port 0` 让系统分配空闲端口，壳从 dsh 的 stdout 就绪行读取真实地址
- **数据隔离** — `DSH_HOME` 指向应用专属数据目录，不污染默认 `~/.dsh`
- **单实例** — 重复启动会聚焦已有窗口
- **插件自由不受限** — 动态插件（`cordis_define`/`cordis_run`）、`$DSH_HOME/cordis.patch.yml`、npm 插件生态均与 Web 版完全一致

## 界面预览

![DeepSeek Harness Desktop 主界面](./assets/screenshots/main-window.png)

## 安装

从 [Releases](https://github.com/HaoyueQin/deepseek-harness-desktop/releases) 下载对应平台的安装包：

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| Windows | `DeepSeek Harness Desktop Setup <ver>.exe` | NSIS 安装包，x64 |
| macOS | `.dmg`（Apple Silicon / Intel） | 未签名 — 首次运行需右键 → 打开 |
| Linux | `.AppImage` + `.deb` | x64 |

### 首次启动

1. 启动应用 — 内置的 `dsh web` 服务在后台启动，界面就绪后自动打开
2. 关闭「预览版」提示
3. 打开 **设置 → 模型** 配置你的 LLM 供应商（API Key、模型、Base URL），与 Web 版一致
4. 选择一个工作区，开始对话

### 日常使用

- **关闭窗口** → 应用隐藏到托盘（系统时钟附近出现 DeepSeek 鲸鱼图标），后端继续运行
- **托盘菜单**（右键点击图标）：重新打开窗口、开关开机自启、退出 — 只有「退出」才会真正停止后端
- **只能通过托盘退出**；关闭窗口永远不会退出应用

## 开发

```sh
npm install        # 安装 electron 43 及工具链
npm run dev        # dev 模式：系统 Node + 本地 node_modules 的 dsh
```

> **electron 二进制下载卡住？**（一直显示 `Downloading Electron binary...`）
> GitHub 托管的二进制在某些网络下很慢。可手动下载
> `https://npmmirror.com/mirrors/electron/<版本>/electron-v<版本>-win32-x64.zip` 放入
> `%LOCALAPPDATA%\electron\Cache\electron-v<版本>-win32-x64\`，然后：
> ```sh
> printf "electron.exe" > node_modules/electron/path.txt
> # 并把 zip 解压到 node_modules/electron/dist/
> ```

## 打包

```sh
npm run build:runtime     # 生成 resources/：内置 Node 24 LTS + dsh 依赖树 + 图标
                          # 网络不佳时：HTTPS_PROXY=http://127.0.0.1:7890 npm run build:runtime
npm run dist:win          # Windows NSIS 安装包 → release/
# npm run dist:mac        # macOS dmg（需 macOS 环境；CI 负责构建）
# npm run dist:linux      # Linux AppImage + deb
```

CI 工作流（`.github/workflows/release.yml`）在每个 `v*` tag 上构建全平台产物并自动发布到 GitHub Release。

## 数据与日志

- **数据**（`DSH_HOME`）：`<userData>/dsh` — profile、会话、存储
- **日志**：`<userData>/logs/main.log`
- **内置运行时**：`<安装目录>/resources/resources/` — Node（`runtime/node/`）+ dsh（`dsh/node_modules/`）

## 项目结构

```
src/
  main.ts          应用生命周期：单实例锁、窗口、托盘、dsh 编排
  paths.ts         dev/prod 资源路径解析（内置 dsh、Node、preload）
  dsh/spawn.ts     spawn dsh web --port 0，解析 stdout URL 行，优雅停止
  dsh/ready.ts     HTTP 就绪探测
  tray.ts          托盘菜单（打开 / 开机自启 / 退出）
  autostart.ts     开机自启（win/mac 原生 + linux XDG 文件）
  preload.ts       contextBridge 窗口控制 IPC（编译为 CJS）
scripts/
  install-runtime.mjs  构建时填充 resources/（Node 发行版 + dsh 依赖树 + 图标）
  smoke.mjs            无 GUI 冒烟：spawn dsh，断言 URL 行 + HTTP 200
assets/
  wordmark.svg         项目标识
```

## 已知限制（v1）

- 安装包约 150MB+（内置 Node + dsh 完整依赖树），体积裁剪在路线图上
- macOS 构建未签名 — Gatekeeper 首次运行需右键 → 打开
- dsh 处于 developer preview，迭代快速；壳锁定 `@deepseek-ai/dsh` 版本，升级需重新打包验证
- 暂不支持自动更新（electron-updater 在规划中）
- 设置页暂未提供桌面开关（开机自启在托盘菜单）；桌面集成插件在规划中

## 反馈

发现 Bug？有功能想法？**非常欢迎提交 issue** — 问题报告、使用疑问、功能建议都行。

- [新建 issue](https://github.com/HaoyueQin/deepseek-harness-desktop/issues)（中文或 English 均可）
- harness 本身的问题，可同步查阅上游 [deepseek-harness discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)

## 许可

[MIT](LICENSE)。DeepSeek Harness 本体为 [MIT](https://github.com/deepseek-ai/deepseek-harness) © DeepSeek AI。
