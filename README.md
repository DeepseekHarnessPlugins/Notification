# dsh-task-notify

**DeepSeek Harness 任务完成通知插件** —— 当 DSH 完成一轮任务（agent 转入空闲 / 出错 / 阻塞）时，向你的设备推送系统通知。文案纯文本无 emoji，图形场景使用 SVG/PNG 图标。

- macOS：系统通知中心（osascript，零依赖）
- Windows：Toast 通知（PowerShell + WinRT，含 PNG 图标）
- 手机：[Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865)(iOS) / [ntfy](https://ntfy.sh)(Android·iOS) / Server酱 / 任意 Webhook

基于 DSH 内置的 Cordis 插件体系，纯 ESM `.mjs`、无构建步骤。

## 安装

```bash
# 装进 web profile（其他 profile 同理）
dsh plugin --profile web add file:/path/to/dsh-task-notify
```

安装后 `dsh.profile.bundles` 会自动追加本包并生效（下次 boot 时加载）。

> 若 pnpm 报 `minimumReleaseAge` 供应链策略拦截（v11 内置默认），在命令末尾
> 追加 `--config.minimum-release-age=0` 按次放行。

## 配置

编辑 `~/.dsh/settings.yaml`，添加 `task-notify:` 段：

```yaml
task-notify:
  enabled: true
  notifyOn: [idle, error, blocked]   # 可选事件：idle error blocked goal-completed
  agents: root                        # root=只通知顶层代理 | all
  coalesceWindowMs: 2000              # 同会话窗口内合并重复通知
  desktop:
    enabled: auto                     # auto | on | off（auto 按平台探测）
    sound: true                       # macOS 播放 Glass 提示音；Windows 静音开关
    backend: auto                     # auto | osascript | terminal-notifier（仅 macOS）
    clickUrl: ""                      # 点击通知时打开的 URL（仅 terminal-notifier 后端生效）
    notifierPath: ""                  # 显式指定 terminal-notifier 路径（非标准安装时用）
  format:
    time: short                       # hidden | short | full —— 正文尾部时间样式
    showDuration: true                # 负载携带 durationMs 时追加「用时 X」
  icons:
    enabled: true                     # 图形图标总开关
    urlTemplate: ""                   # 远程图标模板，如 https://host/icons/{event}.svg
  bark:                               # iOS：App Store 安装 Bark 后复制 deviceKey
    enabled: false
    server: https://api.day.app
    deviceKey: "你的deviceKey"
    sound: ""                         # 可选铃声名
  ntfy:                               # Android/iOS：ntfy App 订阅 topic
    enabled: false
    server: https://ntfy.sh
    topic: "只有你知道的随机topic"
    token: ""                         # 私有服务器时可选
  serverchan:                         # 微信推送：sct.ftqq.com 获取 SendKey
    enabled: false
    sendKey: ""
  webhook:                            # 通用 JSON POST
    enabled: false
    url: ""
    headers: {}
```

优先级：patch 显式配置 > `settings.yaml` > 环境变量（如
`DSH_TASK_NOTIFY_BARK_DEVICE_KEY`、`DSH_TASK_NOTIFY_ICONS_URL_TEMPLATE`）>
内置默认值。

### macOS 后端与点击跳转

macOS 有两个后端，`desktop.backend` 控制选择：

| backend | 预览图 | 点击跳转 | 依赖 |
|---|---|---|---|
| `osascript` | 不支持 | 不支持（点通知激活 Script Editor） | 零（系统自带） |
| `terminal-notifier`（3.x） | `-contentImage <png>` | `-open <url>` | `brew install terminal-notifier` + 系统设置授权 |
| `auto`（默认） | 有则用 notifier | 有则用 notifier | 探测到就升级，没有就静默回退 osascript |

**为什么默认 `auto`**：`display notification` 这个 AppleScript API 既没有图片参数也没有 URL 参数。
所以 osascript 后端下，`config.icons` 和 `clickUrl` 都会被忽略，点击通知只能激活**发布通知的进程**。
`osascript` 本身不是 GUI 应用，macOS 通知中心把它解析到 **Script Editor**——这就是「点通知弹出脚本
编辑器」的原因，不是 bug 而是 API 天花板。

**`terminal-notifier` 3.x 的限制**：移除了 `-icon` / `-appIcon`（macOS 无 API 可改逐通知图标，
图标永远来自 app bundle 自身的图标）。逐事件预览图通过 `-contentImage <png>` 附上，按 event
解析 `assets/icons/<event>.png`（缺失→`notify.png`→不带图）。

`terminal-notifier` 补上点击跳转：`-open <url>` 让点击打开浏览器。探测顺序：
`desktop.notifierPath`（显式）→ `/opt/homebrew/bin/` → `/usr/local/bin/` → `/usr/bin/terminal-notifier`。
`backend: terminal-notifier` 但没找到二进制时回退 osascript 并 warn 一次。

**安装与授权**（两步都要）：

```bash
brew install terminal-notifier
```

然后**必须**在系统设置里给 `terminal-notifier` 开通知权限——命令行无法绕过：

1. 系统设置 → 通知
2. 找到 **terminal-notifier**（不在列表里就点「+」添加）
3. 打开「允许通知」

授权后配置 `clickUrl` 指向 DSH 的 Web GUI：

```yaml
desktop:
  backend: auto
  clickUrl: http://127.0.0.1:3080
```

授权生效前，`terminal-notifier` 会报 "Notifications are turned off"，
自动回退 osascript。授权后自动切换。

### 通知排版

通知正文由 `composeBody` 统一组装为：`内容摘要 · 时间 · 用时 X`。

- `format.time` 控制时间样式：`short`=HH:mm（默认）、`full`=YYYY-MM-DD HH:mm:ss、
  `hidden`=不显示；对应环境变量 `DSH_TASK_NOTIFY_FORMAT_TIME`
- `format.showDuration`：负载带 `durationMs` 时追加「用时 X」（42秒 / 3分05秒 / 1小时02分）
- 时间与用时后缀**不参与截断**——`maxBodyLength` 只作用于内容摘要，
  任何配置下时间都完整可见；对应环境变量 `DSH_TASK_NOTIFY_FORMAT_SHOW_DURATION`

### 文案与图标

| 事件 | 标题 | 内置图标 |
|---|---|---|
| idle | 任务完成 | 绿底白对勾 |
| error | 任务出错 | 红底白叉 |
| blocked | 需要确认 | 琥珀底白色暂停 |
| goal-completed | 目标达成 | 蓝底白靶心 |
| 其他回退 | 任务通知 | 灰底白点 |

标题一律纯文本（无 emoji）。图标资产在包内 `assets/icons/`
（SVG 矢量源 + 64×64 PNG，`node scripts/build-icons.mjs` 可再生成）。
各通道使用方式：

- **Windows Toast**：PNG 以 `appLogoOverride` 嵌入通知
- **Bark / ntfy**：配置 `icons.urlTemplate` 后自动附加 `icon` 参数 /
  `X-Icon` 头（需公网可访问的图片地址）
- **通用 Webhook**：JSON 载荷附带 `icon` 与内联 `iconSvg` 字段
- **macOS**：系统不提供自定义通知图（平台限制），仅纯文本 + 提示音

## 自测

```bash
node self-test.mjs                # 向全部启用通道发一条样例通知
node self-test.mjs --channel desktop # 只测桌面通道
```

## 安装路径冒烟

打包后用真实 npm install 把插件装进一个干净项目，再跑一次完整的
apply() 事件接线与 composeBody 渲染（assert body 含 `· HH:mm`）：

```bash
npm run smoke
```

脚本会建临时目录、用本地 npm 缓存装刚打的 tarball、执行
`scripts/install-smoke.mjs` 对已安装模块做 import 校验、注册监听、派发
gent/status、断言 capture 到 body 后缀。非零退出表示发版前就得修。

## 菜单设置

不想手编 yaml，可以跑交互菜单（编辑 `~/.dsh/settings.yaml` 的 `task-notify:`
段；保存前自动备份为 `settings.yaml.bak-<时间戳>`，注意原文件注释不会保留）：

```bash
npm run menu
```

菜单能力：总开关、通知事件逐项开关、root/all、桌面模式与声音、时间样式
（hidden/short/full）、用时后缀、正文长度与合并窗口；五个通道逐一启用并填写
关键字段（Bark deviceKey、ntfy topic、Server酱 SendKey、Webhook URL），每个
通道可当场发送测试通知验证链路。

## 工作原理

订阅 Cordis 事件总线上的 `agent/status`：当顶层代理转入 `idle`（本轮任务
完成）、`error` 或 `blocked` 时构造统一通知负载，经合并去重后分发到所有
启用通道。任何通道失败只记录警告，绝不影响宿主运行；dispose 时清理全部
定时器与在途请求。

## 开发

```bash
npm run check   # node --check 全部源文件
npm test        # node --test 单元测试（不发真实通知）
npm run icons   # 重新生成 assets/icons/*.png
```

架构与契约详见 [SPEC.md](./SPEC.md)。
