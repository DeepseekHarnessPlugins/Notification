# Changelog

## 0.3.1

- macOS 双后端：`desktop.backend` 取 `auto | osascript | terminal-notifier`。`auto`（默认）在磁盘上探测到 terminal-notifier 时走它，否则回退 osascript，永不硬失败。
- 修复「点击通知打开脚本编辑器」：`display notification` API 既无图片参数也无 URL 参数，所以 osascript 后端点击时只能激活**发布通知的那个进程**——`osascript` 不是 GUI 应用，macOS 就把它解析到 Script Editor。terminal-notifier 后端用 `-open <url>` 实现点击跳转。
- macOS 图标链路改走 `-contentImage`：`desktop.backend=auto/terminal-notifier` 且 `icons.enabled !== false` 时，按 event 解析 `assets/icons/<event>.png`（缺失→`notify.png`→不带图）作为通知预览图。`terminal-notifier` 3.x 已移除 `-icon`/`-appIcon`（macOS 无 API 可改逐通知图标）。之前 osascript 后端刻意忽略 `config.icons`，PNG 资产只服务于 Windows Toast 与 Webhook。
- 新增 `desktop.clickUrl`（点击跳转 URL）与 `desktop.notifierPath`（显式指定 terminal-notifier 路径，非标准安装时用）。
- 三个新环境变量：`DSH_TASK_NOTIFY_DESKTOP_BACKEND` / `_CLICK_URL` / `_NOTIFIER_PATH`。
- terminal-notifier 的 `-title` / `-message` 经 `NSString stringWithFormat` 处理，正文里的 `%` 统一转义为 `%%`，避免被当作格式说明符吞掉。
- 修复 v0.3.0 事件表不一致：`completed` 不在 `KNOWN_EVENTS` 白名单里却被加进默认 `notifyOn`，导致每次启动都报「未知事件」并回退默认；菜单事件表也含 `completed`。现已对齐为 `idle | error | blocked | goal-completed`。
- 新增 `e2e-verify.mjs`（不在包内）：直接 import 已安装的 `node_modules` 副本做真实链路验证，含 dry-run（捕获型通道断言 payload）与 live（零 overrides 走真实通道）。
- 20 个新单测（macOS 双后端 13 + desktop 配置 7），全量 173/173 绿。

## 0.3.0

- 通知排版：正文尾部追加本地时间和耗时后缀（format.time 取 hidden | short | full，format.showDuration 控制是否展示用时）。composeBody 保证时间后缀不被正文截断。
- 菜单控制：npm run menu 交互式编辑 ~/.dsh/settings.yaml 的 task-notify 段，覆盖总开关、事件、agents、桌面/远端五通道；启用通道后可当场发送测试通知。保存自动备份 settings.yaml.bak-<时间戳>，YAML 注释会丢失（已提示）。
- 配置新增 format 段，沿用三层合并（patch > settings > env > 默认），环境变量 DSH_TASK_NOTIFY_FORMAT_TIME / _SHOW_DURATION。
- 12 个新单测（排版）+ 8 个菜单核心单测，全量 153/153 绿。

## 0.2.0

- 多通道：macOS Notification Center、 Windows Toast、 Bark、 ntfy、 Server酱、 通用 Webhook。
- 图形图标：内置 SVG/PNG 资产、Windows Toast 嵌入 appLogoOverride、Bark/ntfy 走 urlTemplate 模板、Webhook JSON 携带 icon 与内联 iconSvg。
- paths.mjs 提取图标路径解析，包发布完整修复（之前打包后首次通知会因缺文件静默失效）。
- 单元测试覆盖通道、配置、合并去重、图标路径。

## 0.1.0

- 初版：基于 agent/status 事件触发 idle / error / blocked 通知；合并窗口内同会话只发最后一次。
