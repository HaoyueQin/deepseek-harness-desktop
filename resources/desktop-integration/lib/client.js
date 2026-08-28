/**
 * 浏览器 half（手写 CJS bundle，遵循 dsh client 插件契约：
 * __ModuleLoader__.load banner + external 只依赖 platform words）。
 * 桌面设置「桌面」分区：后端来源 / dsh 版本 / 开机自启 / 启动最小化 / 端口 /
 * 会话区域宽度（仅无原生宽度功能的旧版后端显示）/ 关于 / 更新检查；回退提示条。
 * 桥 window.dshDesktop 由壳 preload contextBridge 注入；裸 dsh（无桥）降级为空。
 * UI 用原生元素 + --dsw-* CSS 变量（品牌蓝 #4176E6 兜底），契合 dsh 设计体系。
 * 一份 bundle 同时服务 npm 全局与 git 源码两种后端来源；版本差异（原生宽度）
 * 按 dsh 版本号门控，与来源无关。
 */
window.__ModuleLoader__.load({
	id: "dsh-desktop-integration",
	factory: (require) => {
		const React = require("react")

		const BRAND = "#4176E6" // --dsw-static-deepseek-500 兜底
		const OK_GREEN = "#16a34a" // 语义成功绿（dsh token 无专用 success 色，取通用值）

		/** 版本比较（与壳 src/dsh-locator.ts compareVersions 同语义的 JS 移植）。 */
		function compareVersions(a, b) {
			const parse = (v) => {
				const [core, pre] = String(v).split("-", 2)
				return {
					nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
					pre: pre === undefined ? null : pre.split("."),
				}
			}
			const pa = parse(a)
			const pb = parse(b)
			for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
				const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
				if (d !== 0) return d > 0 ? 1 : -1
			}
			if (pa.pre === null && pb.pre === null) return 0
			if (pa.pre === null) return 1
			if (pb.pre === null) return -1
			for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
				const x = pa.pre[i]
				const y = pb.pre[i]
				if (x === undefined) return -1
				if (y === undefined) return 1
				if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
					const d = Number(x) - Number(y)
					if (d !== 0) return d > 0 ? 1 : -1
				} else if (x !== y) {
					return x < y ? -1 : 1
				}
			}
			return 0
		}

		/** dsh 0.1.2-alpha.1 起自带转录区宽度拖拽手柄（写同一 CSS 变量）。 */
		const NATIVE_WIDTH_VERSION = "0.1.2-alpha.1"

		/** 后端是否自带原生宽度功能（版本未知按旧版处理：保守显示壳的卡片）。 */
		function backendSupportsNativeWidth(version) {
			if (!version || version === "unknown") return false
			return compareVersions(version, NATIVE_WIDTH_VERSION) >= 0
		}

		/** 路径末段（源码目录显示名）；空入参原样返回。 */
		function dirBasename(p) {
			if (!p) return ""
			return String(p).split(/[\\/]/).filter(Boolean).pop() || String(p)
		}

		const rowStyle = {
			display: "flex", alignItems: "center", justifyContent: "space-between",
			padding: "12px 14px", borderRadius: "8px",
			background: "var(--dsw-specific-bubble, #f5f7fb)",
			border: "1px solid var(--dsw-alias-border-l2, transparent)",
			gap: "12px",
		}
		const labelStyle = {
			fontSize: "13px", lineHeight: "1.5",
			color: "var(--dsw-alias-label-primary, #1f2329)",
		}
		const subStyle = {
			fontSize: "12px", color: "var(--dsw-alias-label-secondary, #8a919f)",
			marginTop: "2px",
		}
		const btnStyle = {
			border: "none", borderRadius: "6px", padding: "6px 14px",
			background: BRAND, color: "#fff", fontSize: "12px", cursor: "pointer",
			whiteSpace: "nowrap", flexShrink: 0,
		}
		const ghostBtn = {
			border: "1px solid var(--dsw-alias-border-l2, #d0d5de)",
			borderRadius: "6px", padding: "6px 14px", background: "transparent",
			fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
			color: "var(--dsw-alias-label-primary, #1f2329)",
		}
		const logPreStyle = {
			background: "var(--dsw-specific-bubble, #f5f7fb)",
			border: "1px solid var(--dsw-alias-border-l2, transparent)",
			borderRadius: "8px", padding: "10px", maxHeight: "160px", overflowY: "auto",
			whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "11px",
			color: "var(--dsw-alias-label-secondary, #8a919f)",
			marginTop: "8px", textAlign: "left", margin: "8px 0 0",
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

		// 后端版本缓存：宽度注入需要在 factory 早绘阶段决策，而后端版本要等
		// getInfo 才知道——用 localStorage 缓存上次会话的版本号，下次启动即可
		// 立即决策；首访（无缓存）不预注入，等版本确认后再应用，避免新版上
		// !important 短暂压过原生手柄。
		const BACKEND_VER_KEY = "dsh-desktop-backend-version"

		function getCachedBackendVersion() {
			try { return localStorage.getItem(BACKEND_VER_KEY) } catch { return null }
		}

		function cacheBackendVersion(version) {
			try { localStorage.setItem(BACKEND_VER_KEY, version || "") } catch { /* 存储不可用则每次等 getInfo */ }
		}

		/** 按后端版本决定宽度策略：新版清掉壳的覆盖与残留偏好（原生手柄接管）。 */
		function applyWidthForVersion(version) {
			if (backendSupportsNativeWidth(version)) {
				try { localStorage.removeItem(CONV_WIDTH_KEY) } catch { /* 同上 */ }
				const tag = document.getElementById(CONV_WIDTH_STYLE_ID)
				if (tag) tag.remove()
				return
			}
			applyConvWidth(getConvWidth())
		}

		if (typeof document !== "undefined") {
			const cached = getCachedBackendVersion()
			if (cached !== null && cached !== "") applyWidthForVersion(cached)
			else if (typeof window !== "undefined" && window.dshDesktop && window.dshDesktop.getInfo) {
				window.dshDesktop.getInfo().then((info) => {
					const v = info && info.dshVersion ? info.dshVersion : ""
					cacheBackendVersion(v)
					applyWidthForVersion(v)
				}).catch(() => { /* 桥不可用时保持上游默认 */ })
			}
		}

		const inputStyle = {
			flex: 1, minWidth: "120px", borderRadius: "6px",
			border: "1px solid var(--dsw-alias-border-l2, #d0d5de)",
			padding: "5px 8px", fontSize: "12px",
			background: "transparent", color: "var(--dsw-alias-label-primary, #1f2329)",
		}

		/**
		 * 后端来源卡片：自动 / npm 全局 / 源码目录三选；源码目录选择 + 即时校验
		 * + 克隆/准备环境；网络代理；保存后重启生效。旧壳桥无 backend.getConfig
		 * 时整卡不渲染（混合态防崩）。
		 */
		function BackendSourceCard() {
			const desktop = window.dshDesktop
			const backend = desktop && desktop.backend
			const setup = desktop && desktop.setup
			const [cfg, setCfg] = React.useState(null) // 已保存配置 {mode, sourceDir, networkProxy, validation}
			const [draft, setDraft] = React.useState(null) // 未保存编辑
			const [draftValidation, setDraftValidation] = React.useState(null) // 未保存目录的即时校验
			const [saved, setSaved] = React.useState(false)
			const [restarting, setRestarting] = React.useState(false)
			const [busy, setBusy] = React.useState(false) // 克隆/准备环境进行中
			const [log, setLog] = React.useState("")
			const draftRef = React.useRef(null)
			draftRef.current = draft

			React.useEffect(() => {
				if (!backend || !backend.getConfig) return
				backend.getConfig().then((c) => {
					setCfg(c)
					setDraft({ mode: c.mode, sourceDir: c.sourceDir || "", networkProxy: c.networkProxy || "" })
				}).catch(() => {})
			}, [])
			React.useEffect(() => {
				if (!setup || !setup.onSourceOutput) return
				return setup.onSourceOutput((t) => setLog((s) => (s + t).slice(-8000)))
			}, [])
			React.useEffect(() => {
				if (!setup || !setup.onSourceExit) return
				return setup.onSourceExit(() => {
					setBusy(false)
					const dir = draftRef.current ? draftRef.current.sourceDir : ""
					if (dir !== "" && backend && backend.validate) {
						backend.validate(dir).then(setDraftValidation).catch(() => {})
					}
					if (backend && backend.getConfig) backend.getConfig().then(setCfg).catch(() => {})
				})
			}, [])

			if (!backend || !backend.getConfig || draft === null) return null

			const validation = draftValidation !== null ? draftValidation : cfg ? cfg.validation : null
			const missing = validation && !validation.ok ? validation.missing : []
			const notRepo = missing.some((m) => String(m).indexOf("不是 dsh 源码仓库") === 0)

			const radio = (value, title, sub) => React.createElement("div", { key: value },
				React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: value === "auto" ? "12px" : "10px", cursor: "pointer" } },
					React.createElement("input", {
						type: "radio", name: "dsh-desktop-backend-source",
						checked: draft.mode === value,
						onChange: () => { setDraft({ ...draft, mode: value }); setSaved(false) },
						style: { accentColor: BRAND, width: "15px", height: "15px", cursor: "pointer", margin: 0, flexShrink: 0 },
					}),
					React.createElement("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-primary, #1f2329)" } }, title),
				),
				React.createElement("div", { style: { ...subStyle, paddingLeft: "23px" } }, sub),
			)

			const pickDir = () => {
				backend.pickDir().then((d) => {
					if (d === null || d === undefined) return
					setDraft({ ...draftRef.current, sourceDir: d })
					setSaved(false)
					setDraftValidation(null)
					backend.validate(d).then(setDraftValidation).catch(() => {})
				}).catch(() => {})
			}
			const save = () => {
				backend.setConfig({
					mode: draft.mode,
					sourceDir: draft.sourceDir,
					networkProxy: draft.networkProxy.trim(),
				}).then((r) => {
					if (r && r.ok) {
						setSaved(true)
						backend.getConfig().then(setCfg).catch(() => {})
					}
				}).catch(() => {})
			}
			const restart = () => {
				setRestarting(true)
				backend.restart().then(() => setRestarting(false)).catch(() => setRestarting(false))
			}
			const runSourceTask = (task) => {
				setBusy(true)
				setLog("")
				task(draftRef.current.sourceDir).then((r) => {
					if (!r.ok) {
						setBusy(false)
						window.alert(r.busy === true ? "已有源码任务在运行，请稍候" : r.error)
					}
				}).catch(() => setBusy(false))
			}

			return React.createElement("div", { style: rowStyle },
				React.createElement("div", { style: { minWidth: 0, width: "100%" } },
					React.createElement("div", { style: labelStyle }, "后端来源"),
					React.createElement("div", { style: subStyle },
						"选择桌面壳启动哪个 dsh：npm 全局安装（稳定渠道）或本地源码目录（可用任意已检出版本，含预发布）",
					),
					radio("auto", "自动（推荐）", "npm 优先；npm 不可用时自动改用源码目录"),
					radio("npm", "npm 全局安装", "使用 PATH 里的 dsh 命令行（npm i -g @deepseek-ai/dsh）"),
					radio("source", "本地源码目录", "以 node --import tsx/esm 直接运行源码；目录需完成 pnpm install 与 pnpm build"),

					draft.mode === "source" ? React.createElement("div", { style: { display: "flex", gap: "8px", marginTop: "10px", alignItems: "center" } },
						React.createElement("input", {
							value: draft.sourceDir, readOnly: true, placeholder: "选择 dsh 源码目录", style: inputStyle,
						}),
						React.createElement("button", { style: ghostBtn, onClick: pickDir }, "选择目录"),
						draft.sourceDir !== "" && validation !== null && !validation.ok && busy === false
							? React.createElement("button", {
								style: btnStyle,
								onClick: () => runSourceTask(notRepo ? setup.cloneSource : setup.prepareSource),
							}, notRepo ? "克隆仓库" : "准备环境")
							: null,
						busy ? React.createElement("span", { style: subStyle }, "进行中…") : null,
					) : null,

					draft.mode === "source" && draft.sourceDir !== "" && validation !== null
						? React.createElement("div", { style: { ...subStyle, paddingLeft: "23px", marginTop: "8px" } },
							validation.ok
								? React.createElement("span", { style: { color: OK_GREEN } }, `✓ 可启动：dsh ${validation.version}`)
								: React.createElement("span", { style: { color: "#d5491f" } }, `✗ 不可启动：${missing.join("；")}`),
							validation.warnings.length > 0
								? React.createElement("div", { style: { marginTop: "4px" } }, `注意：${validation.warnings.join("；")}`)
								: null,
						) : null,

					React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "12px" } },
						React.createElement("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-primary, #1f2329)", flexShrink: 0 } }, "网络代理"),
						React.createElement("input", {
							defaultValue: draft.networkProxy,
							placeholder: "留空直连，如 http://127.0.0.1:7890",
							onBlur: (e) => { const v = e.target.value.trim(); if (v !== draft.networkProxy) { setDraft({ ...draftRef.current, networkProxy: v }); setSaved(false) } },
							style: inputStyle,
						}),
					),
					React.createElement("div", { style: { ...subStyle, marginTop: "4px" } },
						"作用于源码目录的 git 克隆/拉取与 pnpm 安装构建；npm 渠道更新不走此代理",
					),

					saved ? React.createElement("div", { style: { display: "flex", gap: "10px", alignItems: "center", marginTop: "10px" } },
						React.createElement("span", { style: subStyle }, "已保存，重启后端后生效"),
						React.createElement("button", { style: btnStyle, onClick: restart, disabled: restarting },
							restarting ? "重启中…" : "重启后端"),
					) : null,

					log !== "" ? React.createElement("pre", { style: logPreStyle }, log) : null,

					(draft.mode !== (cfg ? cfg.mode : "") || draft.sourceDir !== (cfg ? cfg.sourceDir || "" : "") || draft.networkProxy !== (cfg ? cfg.networkProxy || "" : ""))
						&& saved === false && cfg !== null
						? React.createElement("div", { style: { ...subStyle, marginTop: "10px" } },
							React.createElement("button", { style: ghostBtn, onClick: save }, "保存"),
						) : null,
				),
			)
		}

		function DesktopSection() {
			const desktop = typeof window !== "undefined" ? window.dshDesktop : undefined
			const [autostart, setAutostart] = React.useState(false)
			const [launchMin, setLaunchMin] = React.useState(false)
			const [info, setInfo] = React.useState(null)
			// 后端是否自带原生宽度功能（决定宽度卡片是否渲染）
			const [nativeWidth, setNativeWidth] = React.useState(() => backendSupportsNativeWidth(getCachedBackendVersion()))
			const [update, setUpdate] = React.useState({
				checking: false, unsupported: false, devMode: false,
				latest: null, downloading: false, downloaded: false, checked: false,
			})
		// 监听端口策略：configured=配置值（重启生效）；actual/degraded=本次运行状态。
		// portDraft=本次会话内已修改待重启的配置（覆盖显示）。
		const [portInfo, setPortInfo] = React.useState(null)
		const [portDraft, setPortDraft] = React.useState(null)

			React.useEffect(() => {
				if (!desktop) return
				desktop.autostart.get().then(setAutostart).catch(() => {})
				desktop.launchMinimized.get().then(setLaunchMin).catch(() => {})
				desktop.getInfo().then((i) => {
					setInfo(i)
					const v = i && i.dshVersion ? i.dshVersion : ""
					cacheBackendVersion(v)
					applyWidthForVersion(v)
					setNativeWidth(backendSupportsNativeWidth(v))
				}).catch(() => {})
				if (desktop.portPolicy) desktop.portPolicy.get().then(setPortInfo).catch(() => {})
			}, [])

			const toggleAutostart = (v) => { setAutostart(v); desktop.autostart.set(v).catch(() => {}) }
			const toggleLaunch = (v) => { setLaunchMin(v); desktop.launchMinimized.set(v).catch(() => {}) }
			const openPath = (p) => { if (p) desktop.openPath(p).catch(() => {}) }
			const check = () => {
				if (!desktop || !desktop.update) return // 旧壳桥上无 update 组（混合态防崩）
				setUpdate((u) => ({ ...u, checking: true }))
				desktop.update.check()
					.then((r) => setUpdate((u) => ({ ...u, checking: false, ...r })))
					.catch(() => setUpdate((u) => ({ ...u, checking: false })))
			}
			const downloadUpdate = () => {
				if (!desktop || !desktop.update) return
				desktop.update.download().then((r) => setUpdate((u) => ({ ...u, ...r }))).catch(() => {})
			}
			const installUpdate = () => {
				if (!desktop || !desktop.update) return
				desktop.update.install().then((r) => setUpdate((u) => ({ ...u, ...r }))).catch(() => {})
			}

			// 后端（npm 全局或 git 源码目录）版本检测与更新
			const backend = desktop ? desktop.backend : undefined
			const [backendStatus, setBackendStatus] = React.useState({
				current: info ? info.dshVersion : "…", latest: null, stage: "idle", error: null,
			})
			// 源码更新管线（检出 tag → pnpm install → build）的实时日志
			const [backendLog, setBackendLog] = React.useState("")
			React.useEffect(() => {
				if (!desktop || !desktop.setup || !desktop.setup.onSourceOutput) return
				return desktop.setup.onSourceOutput((t) => setBackendLog((s) => (s + t).slice(-8000)))
			}, [desktop])
			const backendIsGit = info ? info.backendSource === "git-local" : false
			const sourceSuffix = !info || !info.backendSource ? ""
				: backendIsGit ? `（源码 ${dirBasename(info.sourceDir)}）`
				: "（npm 全局）"
			React.useEffect(() => {
				if (!backend) return
				// onStatus 返回 unsubscribe：设置页 SPA 内反复切换时防止 ipcRenderer 监听器累积
				return backend.onStatus((s) => setBackendStatus((prev) => ({ ...prev, ...s })))
			}, [backend])
			// 桌壳更新状态实时推送（后台 15s 自动检查/手动检查/下载进度均经此到达）
			React.useEffect(() => {
				if (!desktop || !desktop.update) return
				return desktop.update.onStatus((s) => setUpdate((prev) => ({ ...prev, ...s })))
			}, [desktop])
			// info 到达后初始化后端版本显示（不再停留「…」）
			React.useEffect(() => {
				if (!info || !info.dshVersion) return
				setBackendStatus((prev) =>
					prev.current === "…" ? { ...prev, current: info.dshVersion } : prev)
			}, [info])
			const checkBackend = () => {
				if (!backend) return
				setBackendStatus((s) => ({ ...s, stage: "checking", error: null }))
				backend.check().then((r) => setBackendStatus((prev) => ({ ...prev, ...r }))).catch(() => {})
			}
			const doBackendUpdate = () => {
				if (!backend || !backendStatus.latest) return
				const detail = backendIsGit
					? "将从源码仓库检出该版本并重新构建（pnpm install + build，可能需要数分钟），完成后重启后端。"
					: "更新需要重启后端。"
				if (!window.confirm(`检测到新版后端 ${backendStatus.latest}。${detail}确定更新？`)) return
				setBackendStatus((s) => ({ ...s, stage: "updating", error: null }))
				backend.update().then((r) => setBackendStatus((prev) => ({ ...prev, ...r }))).catch(() => {})
			}

			// 监听端口：固定端口 → 页面 origin 稳定，localStorage 侧的设置
			// （会话宽度等）跨重启保留；随机 → 每次启动 origin 都变，全部丢。
			const applyPortPolicy = (v) => {
				if (!desktop.portPolicy) return // 旧壳桥上无此方法（混合态防崩）
				desktop.portPolicy.set(v).catch(() => {})
				setPortDraft(v)
			}
			const portConfigured = portDraft !== null ? portDraft
				: portInfo ? portInfo.configured : null
			const portMode = portConfigured === null ? null
				: portConfigured === "random" ? "random"
				: portConfigured === 3080 ? "default"
				: "custom"
			// 自定义入口端口：已在自定义模式则保持现值，否则从 3180 起步
			const customPort = portMode === "custom" ? portConfigured : 3180

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
			// 分段按钮（预设选择通用件）：选中态品牌蓝描边
			const segBtn = (active, onClick, text) => React.createElement("button", {
				style: {
					border: "1px solid " + (active ? BRAND : "var(--dsw-alias-border-l2, #d0d5de)"),
					borderRadius: "6px", padding: "6px 14px", background: "transparent",
					fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
					color: active ? BRAND : "var(--dsw-alias-label-primary, #1f2329)",
				},
				onClick,
			}, text)

			// 裸 dsh 降级：无桥则渲染空。置于所有 hooks 之后——React 要求每次渲染
			// hooks 数量与顺序一致，条件 return 出现在 hooks 之前会破坏规则。
			if (!desktop) return null

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

				// 监听端口：radio 列表——每选项自带常显说明；自定义行输入框伸满行宽
				React.createElement("div", { style: rowStyle },
					React.createElement("div", { style: { minWidth: 0, width: "100%" } },
						React.createElement("div", { style: labelStyle }, "监听端口"),
						React.createElement("div", { style: subStyle },
							"dsh web 仅监听 127.0.0.1；固定端口让会话区域宽度等页面设置跨重启保留",
						),
						portInfo ? React.createElement("div", { style: subStyle },
							`本次监听：${portInfo.actual ?? "…"}`
							+ (portInfo.degraded ? "（配置端口被占用，已临时降级随机，页面设置本次不会保留）" : ""),
						) : null,

						// 选项一：默认 3080
						React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "12px", cursor: "pointer" } },
							React.createElement("input", {
								type: "radio", name: "dsh-desktop-port-policy",
								checked: portMode === "default",
								onChange: () => applyPortPolicy(3080),
								style: { accentColor: BRAND, width: "15px", height: "15px", cursor: "pointer", margin: 0, flexShrink: 0 },
							}),
							React.createElement("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-primary, #1f2329)" } }, "默认 3080"),
						),
						React.createElement("div", { style: { ...subStyle, paddingLeft: "23px" } },
							"与 dsh web 默认端口一致。注意：壳常驻后台（关闭窗口仅隐藏到托盘）期间会一直占用它，终端裸跑 dsh web（不带参数）会启动失败，需改用 dsh web --port <其他端口> 避让；从托盘退出后端口释放",
						),

						// 选项二：自定义端口 + 伸满行宽的输入框
						React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "10px", cursor: "pointer" } },
							React.createElement("input", {
								type: "radio", name: "dsh-desktop-port-policy",
								checked: portMode === "custom",
								onChange: () => applyPortPolicy(customPort),
								style: { accentColor: BRAND, width: "15px", height: "15px", cursor: "pointer", margin: 0, flexShrink: 0 },
							}),
							React.createElement("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-primary, #1f2329)", flexShrink: 0 } }, "自定义端口"),
							React.createElement("input", {
								key: String(portMode === "custom" ? portConfigured : customPort),
								type: "number", min: 1024, max: 65535,
								defaultValue: portMode === "custom" ? portConfigured : customPort,
								disabled: portMode !== "custom",
								onBlur: (e) => {
									if (portMode !== "custom") return
									const n = Number.parseInt(e.target.value, 10)
									if (Number.isInteger(n) && n >= 1024 && n <= 65535) applyPortPolicy(n)
									else e.target.value = String(portConfigured) // 非法输入还原
								},
								style: {
									flex: 1, minWidth: "80px", borderRadius: "6px",
									border: "1px solid var(--dsw-alias-border-l2, #d0d5de)",
									padding: "5px 8px", fontSize: "12px",
									background: "transparent", color: "var(--dsw-alias-label-primary, #1f2329)",
								},
							}),
						),
						React.createElement("div", { style: { ...subStyle, paddingLeft: "23px" } },
							"选择不与终端 dsh web（3080）冲突的端口可与它并存，页面设置同样跨重启保留",
						),

						// 选项三：随机端口（正在使用时展示实际端口号）
						React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "10px", cursor: "pointer" } },
							React.createElement("input", {
								type: "radio", name: "dsh-desktop-port-policy",
								checked: portMode === "random",
								onChange: () => applyPortPolicy("random"),
								style: { accentColor: BRAND, width: "15px", height: "15px", cursor: "pointer", margin: 0, flexShrink: 0 },
							}),
							React.createElement("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-primary, #1f2329)" } },
								"随机端口",
								portMode === "random" && portInfo && portInfo.actual
									? `（本次：${portInfo.actual}）` : "",
							),
						),
						React.createElement("div", { style: { ...subStyle, paddingLeft: "23px" } },
							"每次启动端口都变，会话区域宽度等页面侧设置在重启后不会保留；仅在需要规避端口冲突时使用",
						),

						portDraft !== null ? React.createElement("div", { style: { ...subStyle, marginTop: "10px" } },
							"已保存，重启应用后生效",
						) : null,
					),
				),

				// 会话区域宽度（仅旧版后端显示：0.1.2-alpha.1+ 自带拖拽手柄，
				// 且壳的 !important 会压过原生内联样式，必须停用避免冲突）
				nativeWidth ? null : React.createElement("div", { style: rowStyle },
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
						segBtn(convWidth === "standard", () => setConvWidthMode("standard"), "标准 (748px)"),
						segBtn(convWidth === "full", () => setConvWidthMode("full"), "全宽 (90%)"),
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

				// 后端来源（自动/npm 全局/源码目录 + 校验 + 代理），旧壳桥上整卡不渲染
				React.createElement(BackendSourceCard, null),

				// dsh 版本管理（纯壳架构：npm 全局或 git 源码目录，见「后端来源」卡片）
				React.createElement("div", { style: rowStyle },
					React.createElement("div", { style: { minWidth: 0, width: "100%" } },
						React.createElement("div", { style: labelStyle }, "dsh 版本"),
						React.createElement("div", { style: subStyle },
							backendIsGit
								? "在线核对官方仓库 tag，发现新版后检出并重新构建"
								: "管理 dsh 命令行工具的版本；桌面壳与终端共享同一份安装",
						),
						React.createElement("div", { style: subStyle },
							backendStatus.stage === "checking" ? "检查中…"
								: backendStatus.stage === "updating" ? (backendIsGit
									? "更新中（检出 tag → 安装依赖 → 构建，可能需要数分钟）…"
									: "更新中…")
								// error 优先于 done：重启后端失败时 stage 为 done + error（版本已升级），
								// 必须显示失败原因而非「更新完成，正在重启…」的永久假象
								: backendStatus.error ? `更新失败：${backendStatus.error}`
								: backendStatus.stage === "done" ? "更新完成，正在重启…"
								: backendStatus.latest
									? `当前 ${backendStatus.current}${sourceSuffix} → 发现新版 ${backendStatus.latest}`
									: backendStatus.checked
										? React.createElement("span", {},
											`当前 ${backendStatus.current}${sourceSuffix}`,
											React.createElement("span", { style: { color: OK_GREEN, marginLeft: "6px" } }, "已是最新版本"),
										)
										: `当前 ${backendStatus.current}${sourceSuffix}`,
						),
						backendLog !== "" ? React.createElement("pre", { style: logPreStyle }, backendLog) : null,
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
							}, backendIsGit ? "下载更新" : "一键更新")
							: null,
					),
				),

				// 桌壳自身更新（electron-updater）：两段式——检查只发现，
				// 下载/安装由按钮显式触发，绝不「检查完一条龙自动更新」
				React.createElement("div", { style: rowStyle },
					React.createElement("div", {},
						React.createElement("div", { style: labelStyle }, "自动更新"),
						React.createElement("div", { style: subStyle },
							"检测 DeepSeek Harness Desktop 新版本；下载与安装由你手动触发",
						),
						React.createElement("div", { style: subStyle },
							update.checking ? "检查中…"
								: update.devMode ? "开发模式不支持自更新（打包版可用）"
								: update.unsupported ? "macOS 暂不支持（需签名证书），请从 Release 页下载"
								: update.downloaded
									? `新版 ${update.latest} 已下载就绪`
									: update.latest
										? update.downloading
											? `当前 ${info ? info.appVersion : "…"} → 正在下载新版 ${update.latest}…`
											: `当前 ${info ? info.appVersion : "…"} → 发现新版 ${update.latest}`
										: React.createElement("span", {},
											`当前 ${info ? info.appVersion : "…"}`,
											update.checked
												? React.createElement("span", { style: { color: OK_GREEN, marginLeft: "6px" } }, "已是最新版本")
												: null,
										),
						),
					),
					React.createElement("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
						update.checking
							? React.createElement("button", { style: ghostBtn, disabled: true }, "检查中")
							: update.downloaded
								? React.createElement("button", { style: btnStyle, onClick: installUpdate }, "安装更新")
								: update.downloading
									? React.createElement("button", { style: ghostBtn, disabled: true }, "下载中…")
									: update.latest
										? React.createElement("button", { style: btnStyle, onClick: downloadUpdate }, "下载更新")
										: React.createElement("button", {
											style: ghostBtn, onClick: check,
											disabled: update.unsupported || update.devMode,
										}, "检查更新"),
					),
				),
			)
		}

		const zh = typeof navigator !== "undefined" && (navigator.language || "").toLowerCase().startsWith("zh")

		/**
		 * 后端来源回退提示条：生效来源 ≠ 用户偏好时由壳推送原因（如「源码目录
		 * 校验失败（缺依赖），已回退到 npm 全局版 x.y.z」）。固定在页面底部，
		 * 可关闭；仅在壳桥提供 backend.onNotice 时启用。getInfo 拉取初值——
		 * 提示可能早于订阅发生（后端就绪即推送，插件加载在后）。
		 */
		function installNoticeBar() {
			const desktop = window.dshDesktop
			if (!desktop || !desktop.backend || !desktop.backend.onNotice) return
			let el = null
			const render = (text) => {
				if (!text) {
					if (el !== null) { el.remove(); el = null }
					return
				}
				if (el === null) {
					el = document.createElement("div")
					const msg = document.createElement("span")
					msg.style.cssText = "flex:1;text-align:center;font-size:12px;line-height:1.5"
					const close = document.createElement("button")
					close.textContent = zh ? "知道了" : "Dismiss"
					close.style.cssText = "border:1px solid #ffd666;background:transparent;color:#ffd666;" +
						"border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px;flex-shrink:0"
					close.addEventListener("click", () => render(null))
					el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:2147483000;" +
						"display:flex;gap:12px;align-items:center;justify-content:center;padding:10px 16px;" +
						"background:#3d3200;color:#ffd666;font-family:system-ui,sans-serif;box-shadow:0 -2px 8px rgba(0,0,0,.25)"
					el.appendChild(msg)
					el.appendChild(close)
					document.body.appendChild(el)
				}
				el.firstChild.textContent = text
			}
			desktop.getInfo().then((info) => render(info && info.notice)).catch(() => {})
			desktop.backend.onNotice((n) => render(n))
		}

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
				installNoticeBar()
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "desktop",
					// order 30：上游 0.1.2-alpha.1 起自带 agent-presets 分区同为 20，
					// 错开避免「桌面」与它的并列顺序随注册时序漂移
					order: 30,
					label: () => (zh ? "桌面" : "Desktop"),
					locale: "desktop",
					children: { "settings.desktop.tab": { kind: "list", scope: "root" } },
				}, DesktopSection))
			},
		}
	}
})
