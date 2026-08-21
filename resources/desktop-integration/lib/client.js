/**
 * 浏览器 half（手写 CJS bundle，遵循 dsh client 插件契约：
 * __ModuleLoader__.load banner + external 只依赖 platform words）。
 * 桌面设置「桌面」分区：开机自启 / 启动最小化 / 关于 / 更新检查。
 * 桥 window.dshDesktop 由壳 preload contextBridge 注入；裸 dsh（无桥）降级为空。
 * UI 用原生元素 + --dsw-* CSS 变量（品牌蓝 #4176E6 兜底），契合 dsh 设计体系。
 */
window.__ModuleLoader__.load({
	id: "dsh-desktop-integration",
	factory: (require) => {
		const React = require("react")

		const BRAND = "#4176E6" // --dsw-static-deepseek-500 兜底

		const rowStyle = {
			display: "flex", alignItems: "center", justifyContent: "space-between",
			padding: "12px 14px", borderRadius: "8px",
			background: "var(--dsw-specific-bubble, #f5f7fb)",
			border: "1px solid var(--dsw-alias-color-border-default, transparent)",
			gap: "12px",
		}
		const labelStyle = {
			fontSize: "13px", lineHeight: "1.5",
			color: "var(--dsw-alias-text-color-text-1, #1f2329)",
		}
		const subStyle = {
			fontSize: "12px", color: "var(--dsw-alias-text-color-text-2, #8a919f)",
			marginTop: "2px",
		}
		const btnStyle = {
			border: "none", borderRadius: "6px", padding: "6px 14px",
			background: BRAND, color: "#fff", fontSize: "12px", cursor: "pointer",
			whiteSpace: "nowrap", flexShrink: 0,
		}
		const ghostBtn = {
			border: "1px solid var(--dsw-alias-color-border-default, #d0d5de)",
			borderRadius: "6px", padding: "6px 14px", background: "transparent",
			fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
			color: "var(--dsw-alias-text-color-text-1, #1f2329)",
		}

		/** 自绘开关（原生 checkbox + 品牌蓝），不依赖未确认的组件 API。 */
		function Switch({ checked, onChange }) {
			return React.createElement("label", {
				style: { display: "inline-flex", alignItems: "center", cursor: "pointer", margin: 0 },
			},
				React.createElement("input", {
					type: "checkbox", checked,
					onChange: (e) => onChange(e.target.checked),
					style: { accentColor: BRAND, width: "16px", height: "16px", cursor: "pointer" },
				}),
			)
		}

		// ===== 会话区域宽度 =====
		// dsh 对话列全部锚定 CSS 变量 --dsh-chat-content-width（ConversationRoot
		// 默认 748px；输入框 = 宽度+32px、表格 breakout 等均引用同一变量）。
		// 注入一条 !important 规则覆盖即可全局生效；百分比相对父容器解析，
		// 侧边栏插件（如 better-sidebar）开合改变容器宽度时自动自适应。
		const CONV_WIDTH_KEY = "dsh-desktop-conv-width"
		const CONV_WIDTH_STYLE_ID = "dsh-desktop-conv-width"
		const CONV_WIDTH_SELECTOR = "div[data-phase]:has(> [data-conversation-scroll])"

		function normalizeConvWidth(value) {
			if (value === "standard" || value === "full") return value
			const n = Number.parseInt(value, 10)
			return Number.isFinite(n) && n >= 40 && n <= 95 ? String(n) : "standard"
		}

		function getConvWidth() {
			try { return normalizeConvWidth(localStorage.getItem(CONV_WIDTH_KEY)) } catch { return "standard" }
		}

		/** 应用宽度：standard 移除覆盖（恢复上游默认 748px），其余注入百分比。 */
		function applyConvWidth(value) {
			const v = normalizeConvWidth(value)
			try { localStorage.setItem(CONV_WIDTH_KEY, v) } catch { /* 存储不可用时仅本次生效 */ }
			let tag = document.getElementById(CONV_WIDTH_STYLE_ID)
			if (v === "standard") {
				if (tag) tag.remove()
				return v
			}
			const pct = v === "full" ? "90%" : v + "%"
			if (!tag) {
				tag = document.createElement("style")
				tag.id = CONV_WIDTH_STYLE_ID
				document.head.appendChild(tag)
			}
			// 子树 max-width 过渡：预设切换/滑块调节时平滑变化而非突变
			tag.textContent = `${CONV_WIDTH_SELECTOR}{--dsh-chat-content-width:${pct}!important}`
				+ `${CONV_WIDTH_SELECTOR} *{transition:max-width .22s ease-out}`
			return v
		}

		// factory 阶段立即应用（localStorage 早绘缓存）：style 标签先于首帧注入，
		// 之后任何 DOM 重建都持续命中该规则，无需 observer。
		if (typeof document !== "undefined") applyConvWidth(getConvWidth())

		function DesktopSection() {
			const desktop = typeof window !== "undefined" ? window.dshDesktop : undefined
			const [autostart, setAutostart] = React.useState(false)
			const [launchMin, setLaunchMin] = React.useState(false)
			const [info, setInfo] = React.useState(null)
			const [update, setUpdate] = React.useState({ checking: false, unsupported: false, latest: null })

			React.useEffect(() => {
				if (!desktop) return
				desktop.autostart.get().then(setAutostart).catch(() => {})
				desktop.launchMinimized.get().then(setLaunchMin).catch(() => {})
				desktop.getInfo().then(setInfo).catch(() => {})
			}, [])

			if (!desktop) return null // 裸 dsh 降级：无桥则渲染空

			const toggleAutostart = (v) => { setAutostart(v); desktop.autostart.set(v).catch(() => {}) }
			const toggleLaunch = (v) => { setLaunchMin(v); desktop.launchMinimized.set(v).catch(() => {}) }
			const openPath = (p) => { if (p) desktop.openPath(p).catch(() => {}) }
			const check = () => {
				setUpdate((u) => ({ ...u, checking: true }))
				desktop.checkForUpdates()
					.then((r) => setUpdate({ checking: false, unsupported: r.unsupported, latest: r.latest }))
					.catch(() => setUpdate({ checking: false, unsupported: false, latest: null }))
			}

			// 后端（内置 dsh 运行时）版本检测与一键更新
			const backend = desktop ? desktop.backend : undefined
			const [backendStatus, setBackendStatus] = React.useState({
				current: info ? info.dshVersion : "…", latest: null, stage: "idle", error: null,
			})
			React.useEffect(() => {
				if (!backend) return
				backend.onStatus((s) => setBackendStatus((prev) => ({ ...prev, ...s })))
			}, [backend])
			const checkBackend = () => {
				if (!backend) return
				setBackendStatus((s) => ({ ...s, stage: "checking", error: null }))
				backend.check().then((r) => setBackendStatus((prev) => ({ ...prev, ...r }))).catch(() => {})
			}
			const doBackendUpdate = () => {
				if (!backend || !backendStatus.latest) return
				if (!window.confirm(`检测到新版后端 ${backendStatus.latest}，更新需要重启后端，确定更新？`)) return
				setBackendStatus((s) => ({ ...s, stage: "updating", error: null }))
				backend.update().then((r) => setBackendStatus((prev) => ({ ...prev, ...r }))).catch(() => {})
			}

			// 会话区域宽度：standard=上游默认 748px（max-width 封顶，窄窗自动撑满，
			// 保持原有响应式策略）；full=90%；数字=自定义百分比
			const [convWidth, setConvWidth] = React.useState(() => getConvWidth())
			// 标准模式下 748px 的等效百分比（随窗口尺寸实时计算，仅用于滑块定位）
			const [stdPct, setStdPct] = React.useState(null)
			React.useEffect(() => {
				if (convWidth !== "standard") return
				const measure = () => {
					const el = document.querySelector("[data-conversation-scroll]")
					if (!el) return
					const cs = getComputedStyle(el)
					const content = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
					if (content > 0) setStdPct(Math.min(95, Math.max(40, Math.round((748 / content) * 100))))
				}
				measure()
				window.addEventListener("resize", measure)
				return () => window.removeEventListener("resize", measure)
			}, [convWidth])

			const setConvWidthMode = (v) => setConvWidth(applyConvWidth(v))
			const stdLabel = stdPct !== null ? `标准 (748px ≈ 当前宽度的 ${stdPct}%)` : "标准 (748px)"
			const convWidthLabel = convWidth === "standard" ? stdLabel
				: convWidth === "full" ? "全宽 (90%)"
				: `自定义 (${convWidth}%)`
			// 滑块位置：全宽=90、自定义=NN、标准=748px 的实时等效百分比
			const sliderValue = convWidth === "full" ? 90
				: convWidth === "standard" ? (stdPct ?? 46)
				: Number.parseInt(convWidth, 10)
			const presetBtn = (mode, text) => React.createElement("button", {
				style: {
					border: "1px solid " + (convWidth === mode ? BRAND : "var(--dsw-alias-color-border-default, #d0d5de)"),
					borderRadius: "6px", padding: "6px 14px", background: "transparent",
					fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
					color: convWidth === mode ? BRAND : "var(--dsw-alias-text-color-text-1, #1f2329)",
				},
				onClick: () => setConvWidthMode(mode),
			}, text)

			const rows = [
				{
					title: "开机自启", sub: "登录系统后自动启动",
					control: React.createElement(Switch, { checked: autostart, onChange: toggleAutostart }),
				},
				{
					title: "启动时最小化到托盘", sub: "启动后不显示主窗口",
					control: React.createElement(Switch, { checked: launchMin, onChange: toggleLaunch }),
				},
			]

			return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px" } },
				rows.map((r) =>
					React.createElement("div", { key: r.title, style: rowStyle },
						React.createElement("div", {},
							React.createElement("div", { style: labelStyle }, r.title),
							React.createElement("div", { style: subStyle }, r.sub),
						),
						r.control,
					),
				),

				// 会话区域宽度
				React.createElement("div", { style: rowStyle },
					React.createElement("div", { style: { minWidth: 0 } },
						React.createElement("div", { style: labelStyle }, "会话区域宽度"),
						React.createElement("div", { style: subStyle },
							"调节对话消息列宽度；与侧边栏插件兼容，边栏开合时自适应",
						),
						React.createElement("div", { style: subStyle },
							`当前：${convWidthLabel}`,
						),
						React.createElement("input", {
							type: "range", min: 40, max: 95, step: 1,
							value: sliderValue,
							onChange: (e) => setConvWidthMode(e.target.value),
							style: { width: "100%", marginTop: "8px", accentColor: BRAND, cursor: "pointer" },
						}),
						convWidth === "standard"
							? React.createElement("div", { style: subStyle },
								"标准保持原有策略：宽屏时固定 748px 居中，窗口变窄时自动撑满；拖动滑块切换为按百分比固定")
							: null,
					),
					React.createElement("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
						presetBtn("standard", "标准 (748px)"),
						presetBtn("full", "全宽 (90%)"),
					),
				),

				// 关于卡片
				React.createElement("div", { style: rowStyle },
					React.createElement("div", {},
						React.createElement("div", { style: labelStyle }, "关于"),
						React.createElement("div", { style: subStyle },
							`桌面 ${info ? info.appVersion : "…"} · dsh ${info ? info.dshVersion : "…"} · 数据 ${info ? info.dshHome : "…"}`,
						),
						React.createElement("div", { style: { display: "flex", gap: "8px", marginTop: "8px" } },
							React.createElement("button", {
								style: ghostBtn,
								onClick: () => openPath(info ? info.dshHome : ""),
							}, "打开数据目录"),
							React.createElement("button", {
								style: ghostBtn,
								onClick: () => openPath(info ? info.logDir : ""),
							}, "打开日志目录"),
						),
					),
				),

				// dsh CLI 版本管理（纯壳架构：壳复用用户已装的 dsh）
				React.createElement("div", { style: rowStyle },
					React.createElement("div", {},
						React.createElement("div", { style: labelStyle }, "dsh 版本"),
						React.createElement("div", { style: subStyle },
							"管理 dsh 命令行工具的版本；桌面壳与终端共享同一份安装",
						),
						React.createElement("div", { style: subStyle },
							backendStatus.stage === "checking" ? "检查中…"
								: backendStatus.stage === "updating" ? "更新中…"
								: backendStatus.stage === "done" ? "更新完成，正在重启…"
								: backendStatus.error ? `更新失败：${backendStatus.error}`
								: backendStatus.latest
									? `当前 ${backendStatus.current} → 发现新版 ${backendStatus.latest}`
									: `当前 ${backendStatus.current}`,
						),
					),
					React.createElement("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
						React.createElement("button", {
							style: ghostBtn, onClick: checkBackend,
							disabled: backendStatus.stage === "checking" || backendStatus.stage === "updating",
						},
							backendStatus.stage === "checking" ? "检查中" : "检查更新",
						),
						backendStatus.latest
							? React.createElement("button", {
								style: btnStyle, onClick: doBackendUpdate,
								disabled: backendStatus.stage === "updating" || backendStatus.stage === "done",
							}, "一键更新")
							: null,
					),
				),

				// 桌壳自身更新（electron-updater）
				React.createElement("div", { style: rowStyle },
					React.createElement("div", {},
						React.createElement("div", { style: labelStyle }, "自动更新"),
						React.createElement("div", { style: subStyle },
							"检测 DeepSeek Harness Desktop 新版本并自动下载安装包",
						),
						React.createElement("div", { style: subStyle },
							update.checking ? "检查中…"
								: update.unsupported ? "macOS 暂不支持（需签名证书），请从 Release 页下载"
								: update.latest ? `当前 ${info ? info.appVersion : "…"} → 发现新版 ${update.latest}`
								: `当前 ${info ? info.appVersion : "…"}`,
						),
					),
					React.createElement("button", { style: ghostBtn, onClick: check, disabled: update.checking || update.unsupported },
						update.checking ? "检查中" : "检查更新",
					),
				),
			)
		}

		const zh = typeof navigator !== "undefined" && (navigator.language || "").toLowerCase().startsWith("zh")

		// 直接返回插件对象（不引用 module/exports——loader 环境不保证提供）
		// 设置面板「桌面」分区导航图标：dsh shell（SettingsRoot navIcon）对未知
		// section id 一律 fallback 齿轮，与「通用设置」重复；settings.section
		// slot 契约无 icon 字段，插件无法自带图标。这里用 MutationObserver 把
		// 导航里 label 为「桌面/Desktop」按钮内的齿轮 SVG 替换为显示器 SVG。
		// data-desktop-icon 标记保证幂等（替换本身会再触发 observer）。
		const MONITOR_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
			'<rect x="1.5" y="2.5" width="13" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/>' +
			'<path d="M5.5 14h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
			'<path d="M8 11.5V14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

		function installDesktopNavIcon() {
			const apply = () => {
				document.querySelectorAll("nav button").forEach((btn) => {
					const span = btn.querySelector("span")
					if (!span) return
					const text = (span.textContent || "").trim()
					if (text !== "桌面" && text !== "Desktop") return
					const svg = btn.querySelector("svg")
					if (!svg || svg.getAttribute("data-desktop-icon") === "1") return
					const cls = svg.getAttribute("class")
					const marker = cls ? `data-desktop-icon="1" class="${cls}"` : 'data-desktop-icon="1"'
					svg.outerHTML = MONITOR_SVG.replace("<svg", `<svg ${marker}`)
				})
			}
			const mo = new MutationObserver(apply)
			mo.observe(document.body, { childList: true, subtree: true })
			apply()
		}

		return {
			inject: ["slots", "locale"],
			apply(ctx) {
				if (typeof window === "undefined" || window.dshDesktop === undefined) return
				installDesktopNavIcon()
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "desktop",
					order: 20,
					label: () => (zh ? "桌面" : "Desktop"),
					locale: "desktop",
					children: { "settings.desktop.tab": { kind: "list", scope: "root" } },
				}, DesktopSection))
			},
		}
	}
})
