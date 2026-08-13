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
		}
		const ghostBtn = {
			border: "1px solid var(--dsw-alias-color-border-default, #d0d5de)",
			borderRadius: "6px", padding: "6px 14px", background: "transparent",
			fontSize: "12px", cursor: "pointer",
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

		function DesktopSection() {
			const desktop = typeof window !== "undefined" ? window.dshDesktop : undefined
			const [autostart, setAutostart] = React.useState(false)
			const [launchMin, setLaunchMin] = React.useState(false)
			const [info, setInfo] = React.useState(null)
			const [update, setUpdate] = React.useState({ checking: false, latest: null })

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
				desktop.checkForUpdates().then((r) => setUpdate({ checking: false, latest: r.latest })).catch(() => setUpdate({ checking: false, latest: null }))
			}

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

				// 关于卡片
				React.createElement("div", { style: rowStyle },
					React.createElement("div", {},
						React.createElement("div", { style: labelStyle }, "关于"),
						React.createElement("div", { style: subStyle },
							`版本 ${info ? info.appVersion : "…"} · 数据 ${info ? info.dshHome : "…"}`,
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

				// 更新检查
				React.createElement("div", { style: rowStyle },
					React.createElement("div", {},
						React.createElement("div", { style: labelStyle }, "自动更新"),
						React.createElement("div", { style: subStyle },
							update.checking ? "检查中…"
								: update.latest ? `发现新版本 ${update.latest}（可在 Release 页下载）`
								: "已是最新版本",
						),
					),
					React.createElement("button", { style: btnStyle, onClick: check, disabled: update.checking },
						update.checking ? "检查中" : "检查更新",
					),
				),
			)
		}

		const zh = typeof navigator !== "undefined" && (navigator.language || "").toLowerCase().startsWith("zh")

		// 直接返回插件对象（不引用 module/exports——loader 环境不保证提供）
		return {
			inject: ["slots", "locale"],
			apply(ctx) {
				if (typeof window === "undefined" || window.dshDesktop === undefined) return
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
