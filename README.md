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
