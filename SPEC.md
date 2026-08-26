# SPEC — dsh-task-notify（DSH 任务完成系统通知插件）

> 本文档是唯一事实来源。所有实现必须遵守此处锁定的契约。
> 工作区根目录：`/Users/paimon/Rustrover/DeepseekHarness`
> 包目录：`/Users/paimon/Rustrover/DeepseekHarness/dsh-task-notify/`

## 1. 背景与已验证事实（勿重复研究，可按路径抽查）

DeepSeek Harness (DSH) 内置基于 **Cordis** 的插件体系：

- 全局安装位置：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/`
- Cordis 相关包：同目录 `node_modules/@deepseek-ai/cordis*`
- Profile（pnpm 工程）：`~/.dsh/profiles/web/package.json`，
  其中 `dsh.profile.bundles` 数组声明启用的插件包。
- 第三方插件真实范本（结构权威参考）：
  `~/.dsh/profiles/web/node_modules/@openviking/dsh-memory-plugin/`
  - 纯 ESM `.mjs` 文件、无构建步骤；`package.json` 里
    `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
  - 入口导出 `export const name`、`export const inject`（服务名字符串数组）、
    `export function apply(ctx, input)`。
  - `cordis.patch.yml` 形如：
    ```yaml
    - insert:
        - id: openviking-memory
          name: '@deepseek-ai/cordis-plugin-group'
          group: true
          isolate:
            openvikingMemory: true
          config:
            - id: openviking-memory-runtime
              name: '@openviking/dsh-memory-plugin'
    ```
- 插件可用事件（从 `@deepseek-ai/dsh-goal`、`dsh-goal-round-driver`、
  `dsh-agent-loop` 的 lib/*.js 反查验证）：
  - `agent/status` → payload `{ agent, status }`；
    status 观测值：`"idle"`(10处) / `"completed"` / `"error"` / `"blocked"`
  - `goal/changed` → `{ change }`（goal 投影变更）
  - 其他：`agent/session-start`、`session/event`、`agent/pre-step`(瀑布)、
    `tools/pre-execute`
- ctx 能力（范本用法）：`ctx.on(event, handler)`、`ctx.provide(key, value)`、
  `ctx.effect(() => disposeFn, label)`、`ctx.logger`。
- 运行环境：Node ≥ 22（本机 v26.3.0），ESM only。

## 2. 产品目标

当 DSH 的「任务完成」时发系统通知：
- **macOS**：通知中心（osascript）
- **Windows**：Toast 通知（PowerShell + WinRT）
- **手机**：Bark(iOS) / ntfy(Android+iOS) / Server酱 / 通用 Webhook

## 3. 语言与风格决策（锁定）

- **纯 ESM `.mjs` + JSDoc 类型标注，零构建步骤** —— 与 DSH 插件生态完全一致
  （所有市场插件都是 .mjs 直发），保证 `file:` 协议直接安装可用。
  不使用需要编译的 TS 源码。
- 唯一运行时依赖：`js-yaml ^4.2.0`（读用户 settings.yaml）。
- 测试：`node --test`（文件放包根或就近，命名 `*.test.mjs`）。

## 4. 包布局与文件所有权（严格互斥，禁止越界写）

```
dsh-task-notify/
├── package.json          ← 主控已写死，禁止修改
├── cordis.patch.yml      ← 主控已写死，禁止修改
├── SPEC.md               ← 主控文档
├── index.mjs             ← Worker-B
├── config.mjs            ← Worker-B
├── dedupe.mjs            ← Worker-B
├── self-test.mjs         ← Worker-B
├── format.mjs            ← Worker-A
├── config.test.mjs / dedupe.test.mjs / index.test.mjs   ← Worker-B
├── format.test.mjs                                      ← Worker-A
├── channels/
│   ├── index.mjs         ← Worker-A（注册表 createChannels(cfgs,deps)）
│   ├── macos.mjs         ← Worker-A
│   ├── windows.mjs       ← Worker-A
│   ├── webhook.mjs       ← Worker-A（bark/ntfy/serverchan/generic）
│   └── channels.test.mjs ← Worker-A
└── README.md             ← 主控在集成阶段撰写
```

## 5. 核心契约

### 5.1 通知负载（内部统一格式）
```ts
interface NotificationPayload {
  event: 'idle' | 'error' | 'blocked' | 'goal-completed';
  title: string;          // 如「✅ 任务完成」/「❌ 任务出错」
  body: string;           // 会话标题或最后一条用户输入摘要（≤120字符）
  sessionId?: string;
  agentId?: string;
  ts: number;             // epoch ms
  durationMs?: number;    // 可选：本轮耗时
}
```

### 5.2 通道接口
```ts
// deps 全部注入以便测试，不真发通知：
interface Deps {
  run: (file: string, args: string[], opts?) => Promise<{ stdout: string; stderr: string }>;
  httpPost: (url: string, init: { headers?: object; body?: string }) => Promise<{ status: number; text: string }>;
  logger: { info(msg): void; warn(msg): void };
  now: () => number;
}
// 每个通道模块导出：
export function createChannel(config: object, deps: Deps): { name: string; send(p: NotificationPayload): Promise<void> }
```

### 5.3 配置 schema（config.mjs 导出 `resolveConfig(input, env)`）
优先级：patch 显式 input > `~/.dsh/settings.yaml` 的 `task-notify:` 键 >
env(`DSH_TASK_NOTIFY_*`) > 内置默认值。
```yaml
task-notify:
  enabled: true
  notifyOn: [idle, error, blocked]     # goal-completed 可选加入
  agents: root                          # root | all（只通知顶层代理）
  coalesceWindowMs: 2000                # 同一会话窗口内合并重复通知
  maxBodyLength: 120
  desktop:
    enabled: auto                       # auto | on | off（auto=按平台探测）
    sound: true
  bark:
    enabled: false
    server: https://api.day.app
    deviceKey: ""
    sound: ""                           # 可选铃声名
  ntfy:
    enabled: false
    server: https://ntfy.sh
    topic: ""
    token: ""                           # 可选
  serverchan:
    enabled: false
    sendKey: ""
  webhook:
    enabled: false
    url: ""
    headers: {}
```
解析规则：未知键忽略并 warn；enabled 非布尔容错；settings.yaml 用 js-yaml
读取失败时静默降级为默认值 + warn。

### 5.4 事件接线（index.mjs）
- `ctx.on("agent/status", ({ agent, status }, next?) => ...)`：
  status ∈ notifyOn 时构造 payload 并分发到全部启用通道。
  每个 channel.send 必须 try/catch，失败仅 `logger.warn`，绝不向宿主抛错。
- 顶层代理判定（`agents: root` 时）：优先用 agent 对象上能证明「无父」的
  字段（由 Worker-B 在 dsh-agent-loop/dsh-agent 源码中确认字段名，如
  `parent`/`parentId`）；无法确认时回退启发式并在代码注释注明。
- `ctx.effect(...)` 注册清理：清空 dedupe 定时器、进行中的发送 Promise。
- 不得阻塞主流程：分发为 fire-and-forget（Promise 链 catch 兜底）。

### 5.5 合并与去重（dedupe.mjs）
`createCoalescer(windowMs, now)`：同一 sessionId 在窗口内的多次触发只保留
最后一次并输出一次；`dispose()` 清空所有 pending 定时器。用 `setTimeout`
实现，测试用 `node:test` 的 mock timers。

### 5.6 文案模板（format.mjs）
`formatTitle(event)`：idle→「✅ 任务完成」、error→「❌ 任务出错」、
blocked→「⏸ 需要确认」、goal-completed→「🎯 目标达成」；
`formatBody(text, maxLen)`：压缩空白、截断加省略号。
各通道标题里的 emoji 由通道自行决定是否保留（webhook 保留，桌面可选）。

### 5.7 通道实现要点
- **macos.mjs**：`osascript -e display notification "BODY" with title "TITLE"`
  （sound 开启时追加 ` sound name "Glass"`）。参数经数组传参给 run，
  引号转义必须处理 `"` 和 `\`。
- **windows.mjs**：生成 PowerShell 脚本文本（WinRT ToastNotificationManager，
  AppId 用 PowerShell 的 AUMID 以免注册），单引号 doubling 转义；run 执行
  `powershell.exe -NoProfile -NonInteractive -Command <script>`。
  测试断言生成脚本包含标题/正文且转义正确。
- **webhook.mjs** 四种预设：
  - bark: `POST {server}/{deviceKey}` JSON `{title, body, sound?}`
  - ntfy: `POST {server}/{topic}`，headers `Title`(UTF-8→须 RFC2047 或明文,
    用明文即可)、body 为正文；token 时加 `Authorization: Bearer`
  - serverchan: `POST https://sctapi.ftqq.com/{sendKey}.send`
    form 编码 `title`/`desp`
  - generic: POST url，JSON `{event,title,body,sessionId,ts}` + 自定义 headers
- 所有网络调用 8s 超时（AbortController），失败 warn 不抛。

### 5.8 self-test.mjs
`node self-test.mjs [--channel desktop|bark|ntfy|serverchan|webhook]`：
加载真实配置 → 构造样例 payload → 只走指定通道（默认全部启用通道）→
逐通道打印成功/失败。退出码 0/1。

## 6. 验收标准

1. `for f in *.mjs channels/*.mjs; do node --check $f; done` 全过。
2. `node --test` 全绿（通道测试用假 run/httpPost，不发真实通知；
   dedupe 测试不依赖真实时钟）。
3. `resolveConfig` 三层优先级有测试覆盖。
4. index.mjs 的 apply() 不依赖未验证的服务 inject（inject 列表保持最小，
   默认 `[]`，除非 Worker-B 确认需要 sessions 服务取会话标题）。

## 7. v0.2 — 无 emoji 文案 + SVG/PNG 图形图标（锁定）

### 7.1 文案（全部无 emoji，字符串逐字锁定）
| event | title |
|---|---|
| idle | `任务完成` |
| error | `任务出错` |
| blocked | `需要确认` |
| goal-completed | `目标达成` |
| 其他/未知回退 | `任务通知` |

stripEmoji 保留作为防御性工具；formatTitle 直接返回无 emoji 文案。

### 7.2 图标资产（Worker-A2 负责）
- 目录 `assets/icons/<event>.svg` 与 `<event>.png`，
  event ∈ idle | error | blocked | goal-completed | notify（notify=回退）。
- 64×64、透明背景、圆形底 + 白色符号：idle=绿(#34C759)对勾、
  error=红(#FF3B30)叉、blocked=琥珀(#FF9500)双竖条、goal-completed=蓝(#007AFF)同心圆靶、
  notify=灰(#8E8E93)实心圆点。
- SVG 手写几何图形；PNG 由 `scripts/build-icons.mjs` 以**零依赖纯 Node**
  （zlib + 手写 PNG chunk 编码 + SDF 抗锯齿光栅化）程序化生成，
  输出字节确定性（同输入同输出）。
- 测试 `scripts/build-icons.test.mjs`：PNG 魔数/IHDR 尺寸/zlib 解压长度/
  四角透明/中心点颜色接近主色。
- 生成物 png 提交入库（安装包无需构建步骤）；SVG 为矢量源文件。

### 7.3 配置新增（Worker-B2 实现，遵守既有三层合并）
```yaml
task-notify:
  icons:
    enabled: true        # 总开关；false 时 payload.iconUrl="" 且桌面通道不嵌图
    urlTemplate: ""      # 如 https://host/icons/{event}.svg，{event} 占位符
```
env：`DSH_TASK_NOTIFY_ICONS_ENABLED`、`DSH_TASK_NOTIFY_ICONS_URL_TEMPLATE`。

### 7.4 载荷与通道接线（Worker-B2）
- NotificationPayload 新增 `iconUrl: string`（模板渲染结果，禁用/未配置为 ""）；
  另含既有 event 字段供通道本地选图。
- **windows**：icons.enabled 时按 event 选 `assets/icons/<event>.png`
  （缺失→notify.png），在 binding 内插入
  `<image placement="appLogoOverride" src="file:///<ABS>"/>`
  （单引号 doubling 路径）。macOS 通知中心不支持自定义图 → 不接，注释说明。
- **bark**：payload.iconUrl 非空时追加查询参数 `icon=<encodeURIComponent(url)>`。
- **ntfy**：payload.iconUrl 非空时加头 `X-Icon: <url>`。
- **serverchan**：无图标通道，不接。
- **generic**：JSON body 增加 `icon`（iconUrl 原值）与 `iconSvg`
  （对应 assets/icons/<event>.svg 的内联标记文本，读文件失败则省略字段）。
- 所有图标路径解析基于包目录（import.meta.url 推导），不依赖 cwd。
