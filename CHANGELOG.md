# Changelog

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
