# Craft Mobile 远程控制（对标 AirDroid）可行性评估

> 评估时间：2026-11-15　目标：安卓客户端作为**被控端**，桌面 WebUI / Electron 作为观看与控制端
>
> **场景假设（2026-11-15 更新）**：APK 为**个人测试使用、旁加载安装**，无障碍/悬浮窗/所有文件等权限由用户自行授予。因此 **Google Play 政策、隐私合规、多租户审计不作为约束**；剩下的硬限制只有：`MediaProjection` 每次会话需用户同意、`FLAG_SECURE` 黑屏、锁屏自动停止投屏、无障碍输入精度。若设备已 root，可进一步用 Shizuku/root 绕过其中一部分（见 §9.5）。
>
> 结论先行：**画面可以传，控制可以做，个人测试场景下可以做得比“合规产品”更彻底；但不能在非 root 设备上做到“无感常驻”的 AirDroid 全量替代。**

---

## 0. 结论（TL;DR）

| 能力 | 结论 | 说明 |
|---|---|---|
| **实时画面传输** | ✅ 可行 | `MediaProjection` 抓全屏，`VirtualDisplay + ImageReader/MediaCodec` 编码；复用现有 WS 帧流传输 |
| **触控/手势** | ✅ 基本可行 | `AccessibilityService.dispatchGesture()` + 连续手势，覆盖点按、滑动、拖拽、多指、返回/Home/最近任务 |
| **键盘/文本** | ⚠️ 部分可行 | `ACTION_SET_TEXT`/剪贴板可用；任意按键需要自定义输入法或 Shizuku/root |
| **悬浮在所有应用之上** | ✅ 可行，但非必需 | `SYSTEM_ALERT_WINDOW` 只用于“正在被控制”指示/停止按钮；敏感页面会隐藏悬浮窗 |
| **访问所有文件** | ⚠️ 有条件可行 | `MANAGE_EXTERNAL_STORAGE` 只能访问共享存储，不能访问其他 App 私有目录；个人旁加载可直接授权，Play 上架才受政策限制 |
| **常驻/开机自启** | ⚠️ 受限 | 前台服务可常驻；Android 15+ 不允许 `BOOT_COMPLETED` 启动 `mediaProjection` 前台服务；锁屏会自动停止投屏 |
| **跨网远程** | ✅ 可行 | 手机主动出站 WSS 到 hub，NAT 友好；不需要公网入站端口 |
| **游戏/银行/DRM** | ❌ 不建议 | `FLAG_SECURE` 黑屏、反作弊/无障碍检测、锁屏限制；root + LSPosed 可尝试去 flag，但会破坏 DRM/完整性，个人测试另说 |
| **Play 上架** | 不适用 | 个人测试/旁加载；不需要考虑 Play 审核。若以后要上架再回来收紧权限与声明 |

**最重要的判断：Craft 已经有“设备链路 + 远程桌面/文件能力 + WS 帧流观看端”的骨架，安卓端不需要另起一套 MCP 或私有协议，直接作为 device link 接入即可。** 详见 §2、§7。

---

## 1. 对标 AirDroid 的能力拆解

AirDroid 的非 Root 远程控制走 **Control Add-on（无障碍）** 或一次性 ADB 授权；Root 设备可直接获得完整输入权限。它的画面同样受 Android 投屏约束（每次会话需用户同意、`FLAG_SECURE` 黑屏、锁屏停止）。

| AirDroid 能力 | Craft 可行性 | 依赖 / 边界 |
|---|---|---|
| 实时屏幕镜像 | ✅ | `MediaProjection`；8–15fps JPEG 起步，H.264 可到 20–30fps |
| 鼠标/触控操作 | ✅ | 无障碍手势；拖拽/多指可用连续手势，精度不如 root |
| 远程键盘 | ⚠️ | 文本用 `ACTION_SET_TEXT`；任意按键需自定义 IME 或 Shizuku |
| 文件管理/传输 | ⚠️ | 全文件访问共享存储；大文件需要分块/二进制通道 |
| 剪贴板同步 | ✅ | Android 10+ 后台剪贴板受限，需前台服务/用户交互配合 |
| 通知/短信/联系人 | ⚠️ | 需要额外权限；Play 政策敏感，非首版 |
| 摄像头/麦克风 | ❌/⚠️ | 涉及隐私与系统限制，不建议首版 |
| 多设备管理 | ✅ | 现有 device link 已支持多设备；控制权需租约 |
| 开机自启/无人值守 | ⚠️ | Android 15+ 限制；投屏每次会话需用户同意 |
| 安全配对/撤销 | ✅ | 现有 device token 机制可复用；需补 E2E 与审计 |

---

## 2. Craft 现有基础（代码事实）

### 2.1 安卓客户端目前只是 WebView 壳

- [WebViewActivity.kt](file:///c:/Users/Ryan/code/craft-agents-oss/apps/android/app/src/main/java/com/craftagent/android/WebViewActivity.kt#L47-L66) 只负责加载服务器 WebUI、通知 bridge、下载/外链。
- [AndroidManifest.xml](file:///c:/Users/Ryan/code/craft-agents-oss/apps/android/app/src/main/AndroidManifest.xml#L1-L42) 只有网络/通知权限，**没有 Service、无障碍、悬浮窗、前台服务**。
- [android/README.md](file:///c:/Users/Ryan/code/craft-agents-oss/apps/android/README.md#L1-L13) 明确“没有 FCM、没有常驻前台服务”，进程被回收后通知就断。
- 依赖只有 AndroidX + Material（[build.gradle.kts](file:///c:/Users/Ryan/code/craft-agents-oss/apps/android/app/build.gradle.kts#L44-L52)），没有 WebSocket/编码器/Shizuku。

**含义**：远程控制不是“加个开关”，而是新增一个原生模块（前台服务 + 无障碍 + 编码 + 设备链路 + 权限引导）。

### 2.2 服务端已有 device link 与远程桌面能力

- 设备能力常量：[capabilities.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/transport/capabilities.ts#L61-L95) 已有 `client:device:exec`、`client:device:fs`、`client:browser:invoke`、`client:computer:invoke`。
- `device_tool` 已把“设备”作为参数，支持 `devices / bash / read / write / list / stat / glob / grep / browser / computer`（[device-tool.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/device-tool.ts#L13-L54)、[device-tools.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/device-tools.ts#L26-L38)）。
- `computer` 能力就是**远程桌面控制**：status / windows / snapshot（无障碍树）/ clickAt / typeText / sendKey / scroll / screenshot / launchApp / stop（[RemoteComputerPaneManager.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/RemoteComputerPaneManager.ts#L1-L100)、[computer-pane.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/computer-pane.ts#L20-L160)）。
- 设备 token 是一设备一份、首次握手绑定、可撤销（[remote-connections.md](file:///c:/Users/Ryan/code/craft-agents-oss/docs/remote-connections.md#L194-L210)）。

**含义**：安卓端如果实现 `client:computer:invoke` 和 `client:device:fs`，Agent 立刻就能用现有 `device_tool` 操作手机（读 UI 树、点按、输入、截图、文件读写），**不需要新造一套 Agent 协议**。

### 2.3 浏览器帧流已解决“看”和“输入回灌”

- 通道：`browser-pane:stream-start / stop / control / input / frame / ended`（[channels.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/protocol/channels.ts#L591-L612)）。
- 帧：JPEG base64 + `width/height/atMs`；输入：mouse/wheel/key/text（[dto.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/protocol/dto.ts#L1438-L1499)）。
- 帧是**单播到订阅的客户端**，且被列为 `EPHEMERAL_CHANNELS`，不进重连缓冲（[server.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/transport/server.ts#L43-L47)）。
- 观看端已有 canvas 绘制、letterbox 坐标映射、指针捕获、键盘 textarea/IME 组合输入（[BrowserStreamViewer.tsx](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/components/browser/BrowserStreamViewer.tsx#L1-L180)）；webui 通过路径别名复用 Electron renderer（[vite.config.ts](file:///c:/Users/Ryan/code/craft-agents-oss/apps/webui/vite.config.ts#L37-L45)）。

**含义**：传输、观看、输入回灌可以复用；但采集源必须新建 Android `MediaProjection` 管线——现有帧流是 Chromium 标签页，不是整机屏幕，文档也明确“不是远程桌面”（[browser-view-streaming.md](file:///c:/Users/Ryan/code/craft-agents-oss/docs/browser-view-streaming.md#L23-L33)）。

---

## 3. 建议架构

```
┌─────────────────────────── Android（被控端） ───────────────────────────┐
│  RemoteControlService（前台服务，mediaProjection）                       │
│   ├─ MediaProjection → VirtualDisplay → ImageReader/MediaCodec → 编码     │
│   ├─ AccessibilityService → 手势/全局动作/文本/UI 树                      │
│   ├─ (可选) Shizuku → 按键注入/shell/安装/设置                            │
│   ├─ FileBridge → 共享存储/SAF（可选全文件）                               │
│   └─ DeviceLink（出站 WSS，device token）→ hub                            │
└──────────────────────────────────────────────────────────────────────────┘
                                   │ 出站 WSS
                                   ▼
┌──────────────────────────── Craft Hub ────────────────────────────────────┐
│ DeviceRegistry（在线/能力/授权）                                           │
│ DeviceStreamManager（一路采集，按观看者扇出；帧不落盘）                     │
│ ControlLease（同一时间一个控制者；Agent 与人类互斥/可接管）                 │
│ 新通道：device:stream-* / device:input / device:frame / device:ended       │
└──────────────────────────────────────────────────────────────────────────┘
                                   │ 现有 WS
                                   ▼
┌──────────────────── 观看端（Electron / WebUI） ───────────────────────────┐
│ 复用 BrowserStreamViewer 的画布/坐标映射/键盘输入                          │
│ 新增：触摸手势、屏幕按钮（返回/Home/最近任务）、画质/帧率、控制权 UI        │
└──────────────────────────────────────────────────────────────────────────┘
```

**连接方向**：手机主动连 hub，而不是 hub 连手机。这样不需要公网入站端口，也不依赖同一局域网；与现有 device link 的方向一致。

**两种落地方式**：

| 方式 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A. 原生 DeviceLink（推荐）** | Kotlin 实现现有 WS RPC 握手/心跳/通道，声明 device capabilities | 独立于 WebView，后台稳定，能长期保持 | 需要移植协议；工作量大 |
| **B. WebView JS DeviceLink（先验证）** | WebUI 里新开一条 WS，声明 device role；画面/输入通过 native bridge 转发 | 复用现有 TS 协议与鉴权；PoC 快 | 依赖 WebView 存活；高频帧过 bridge；后台易被限 |

建议 **P0 用 B 验证画面/输入闭环，P1 迁到 A**。不要让 PoC 变成长期架构。

### 3.1 安卓端要不要起 server？要不要 QuickJS？

**要不要在安卓端起 server：推荐不要。**

| 方案 | 是否需要安卓 server | 说明 |
|---|---|---|
| **出站 device link（推荐）** | 不需要 | 手机作为客户端主动连 hub；hub 已有鉴权、设备注册、帧路由；NAT/跨网都能用；不监听端口 |
| **局域网直连** | 需要一个小型 HTTP/WS server | 观看端直接连手机；需要自己处理配对、TLS、发现、权限；只适合同一局域网/个人测试 |
| **把 Craft Server（Bun）跑在安卓** | 不现实 | Bun 没有 Android 运行环境；Termux + Node 能跑但不是产品方案，功耗/后台/兼容性都差 |

**要不要 QuickJS：不需要。**

- 远程控制的核心是 `MediaProjection` 采集、`MediaCodec` 编码、`AccessibilityService` 注入、WebSocket 传输，全部用 Kotlin/Java 原生做最稳。
- QuickJS 是 JS 引擎，没有 Android 的 MediaProjection/无障碍/编码器 API；用它反而要写大量 JNI/桥接。
- 如果你的意思是“复用 WebUI 的 TypeScript 逻辑”：复用**协议类型和 JSON schema**即可，不要把 JS 运行时搬到安卓。
- 如果只是想在设备端做脚本扩展，可以后续嵌 QuickJS，但那是另一个需求，与远程控制无关。

**结论**：**Kotlin 原生 device link + MediaProjection + AccessibilityService + Craft IME，不需要安卓 server，也不需要 QuickJS。** 手机只做客户端，服务端继续用现有 Craft hub。

### 3.2 整体交互链路（注册 → 连接 → 会话）

当前安卓端的“填 HTTP”只是 **WebUI 地址**：WebView 打开它、用户登录、拿 `craft_session` cookie。它和“这台手机作为设备被 hub 使用”是两条独立的链路。设备链路需要 device token，而这个 token **不应该让用户手填**——用已登录的 WebUI 自动换一个。

```
┌──────────────────────────── Android App ────────────────────────────┐
│ ServerStore(URL)                                                     │
│ WebView → WebUI（登录，cookie）                                      │
│ NativeBridge（已有 craftBridge）                                     │
│   ↕ deviceHello / deviceRegisterResult                               │
│ DeviceTokenStore（每个 server 一份，加密存储）                        │
│ DeviceLink（出站 WSS，role=device）                                  │
│ RemoteControlService / AccessibilityService / Craft IME              │
└─────────────────────────────────────────────────────────────────────┘
                 │ 出站 WSS（同一个 host:port）
                 ▼
┌──────────────────────────── Craft Hub ──────────────────────────────┐
│ WebUI HTTP + WS RPC（已有）                                          │
│ server:createDeviceToken（已有，见 server.ts L174-L202）              │
│ DeviceRegistry / token 绑定 / 能力协商                               │
│ DeviceStreamManager / ControlLease                                   │
└─────────────────────────────────────────────────────────────────────┘
                 │ 现有 WS
                 ▼
┌──────────────────── 观看端（Electron / WebUI） ─────────────────────┐
│ 设备列表 → 远程控制 → DeviceStreamViewer                              │
└─────────────────────────────────────────────────────────────────────┘
```

#### 步骤 1：添加服务器（不变）

- 用户仍然只填 `http(s)://host[:port]`；这是 WebUI 的 origin。
- 不需要另填“设备 token”；设备 token 由下一步自动生成。
- 如果以后要支持手动 token，放在“高级”里做兜底，不作为主流程。

#### 步骤 2：WebUI 登录（不变）

- WebView 走现有登录页，服务端写 `craft_session` cookie。
- 只有登录成功后，才允许注册设备。

#### 步骤 3：自动创建设备 token

1. WebUI 检测到 `window.craftBridge`（安卓壳）。
2. 原生通过 bridge 发 `deviceHello`：`{ serverId, deviceId, name, model, version, hasToken }`。
3. 如果 `hasToken=false`，WebUI 调用现有 RPC：
   - `server:createDeviceToken(label, 'device')`
   - label 例如 `Craft Android · Pixel 9`。
   - 返回 `{ token, entry }`（entry.id 是 tokenId）。
4. WebUI 通过 bridge 回 `deviceRegisterResult`：
   - `{ serverId, token, tokenId, wsUrl }`
   - `wsUrl` 用 `/api/config` 返回的地址（https → wss）。
5. 原生把 token 存到 `EncryptedSharedPreferences`（每个 server 一份），并记下 tokenId。
6. 如果 `hasToken=true`，跳过创建，直接用已存 token 连接；连接失败再提示“重新注册”。

> 这里复用的是现有设备槽机制：`server:createDeviceToken` 创建一个 pending slot，第一次握手把它绑定到 `deviceId`，之后只接受这台设备（[tokens.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/transport/tokens.ts#L1-L11)）。**P0 不需要新增服务端 HTTP 接口。**

#### 步骤 4：建立 device link

原生打开 `wsUrl`，发 handshake：

```json
{
  "type": "handshake",
  "protocolVersion": "…",
  "token": "<device token>",
  "clientCapabilities": [
    "client:computer:invoke",
    "client:device:fs",
    "client:device:screen",
    "client:device:input"
  ],
  "clientInfo": {
    "deviceId": "<stable uuid>",
    "name": "Pixel 9",
    "platform": "android",
    "version": "0.1.0",
    "role": "device",
    "allowedRoots": ["/storage/emulated/0"]
  }
}
```

- `role: 'device'` 让服务端知道这是“借出自己”的连接（[ClientInfo](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/protocol/types.ts#L77-L120)）。
- 首次握手绑定 pending slot；之后 token 只接受同一 `deviceId`。
- 设备连接是 **device scope**：只能应答 capability 调用，不能调用服务端 RPC（[server.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/transport/server.ts#L913-L924)）。所以帧不能由手机主动“调 RPC 推”，见步骤 6。

#### 步骤 5：能力开关

- 手机本地设置：屏幕、输入、文件、剪贴板分别开关。
- 只声明已开启的能力；**能力在 handshake 时固定**，改了要重连（与现有 `syncHubConnections` 一致）。
- hub 设备列表展示 `screen/input/fs/computer` 能力与在线状态。
- agent 用现有 `device_tool`：`computer`（快照/点击/输入/截图）、`fs`（文件）。
- 人用“远程控制”按钮：只有 `screen + input` 都在线才可点。

#### 步骤 6：远程控制会话

```
Viewer                Hub                         Android
  |  device:stream-start |                          |
  |-------------------->|  invoke screen.start      |
  |                     |------------------------->| 启动 FGS + 请求投屏同意
  |                     |<-------------------------| { streamId, width, height }
  |<-- device:stream-frame（单播）                  |
  |                     |  invoke screen.nextFrames |
  |                     |------------------------->| 返回 1–3 帧（JPEG/H.264）
  |  device:stream-input|                          |
  |-------------------->|  invoke input.input       |
  |                     |------------------------->| dispatchGesture / IME
```

**帧的两种实现**：

| 方式 | 做法 | 适用 |
|---|---|---|
| **P0：拉取** | hub 循环 `invokeClient(CLIENT_DEVICE_SCREEN, {method:'nextFrames', count:2, maxWaitMs:500})`，把帧推给 viewer | 不改 transport；8–15fps 够用；实现最快 |
| **P1：推送** | 允许 device 连接向白名单通道发 `event`（如 `client:device:screen:frame`），hub 转发 | 20–30fps、H.264；需要 transport 增加 device→server 的受限推送 |

> device scope 不能调用服务端 RPC，所以“手机主动推帧”不能直接用普通 RPC；P0 用拉取最稳，P1 再加受限推送通道。

**投屏同意**：`screen.start` 时如果手机在后台，不能静默弹系统弹窗；用前台服务通知“远程控制请求 → 点此允许投屏”，或让用户先在手机上点“开始远程控制”。PC 端显示“等待手机确认”。这是 Android 14+ 的硬限制。

#### 步骤 7：输入

- 观看端把鼠标/触摸/键盘转成 `DeviceStreamInput`，坐标归一化。
- hub 调 `CLIENT_DEVICE_INPUT`：
  - `tap/swipe/drag/多指` → `dispatchGesture`（连续手势）；
  - `text` → 优先 `ACTION_SET_TEXT`；中文走 Craft IME `commitText`；
  - `back/home/recents/notifications` → `performGlobalAction`；
  - `key`（Enter/Backspace/方向键）→ Craft IME `sendKeyEvent`；全局组合键需要 Shizuku/root。
- 输入批处理：move 合并到 16–33ms 一批；down/up 不丢。

#### 步骤 8：停止 / 撤销 / 重注册

- 观看端停止 → `device:stream-stop` → 手机停服务、释放 MediaProjection、清空帧。
- 手机通知栏停止 / 锁屏 / 状态栏投屏 chip → 手机主动结束；hub 推 `device:stream-ended`。
- hub 删除设备槽（`server:removeDeviceToken`）→ 断开 device link；原生清 token，显示“未注册”。
- 重装/换机：重新走步骤 3，创建新槽；旧槽在设备列表手动删除。
- 多服务器：每个 server 一份 token + 一条 device link；P0 可以只连当前打开的服务器。

#### 职责划分

| 层 | 要做的事 |
|---|---|
| **Android** | bridge 消息、token 加密存储、DeviceLink（Kotlin WS 协议）、MediaProjection/H.264/JPEG、AccessibilityService、Craft IME、能力开关、投屏同意 UI |
| **WebUI** | `deviceHello`/`deviceRegisterResult` 处理、调用 `server:createDeviceToken`、设备状态展示、远程控制入口、DeviceStreamViewer |
| **Hub** | `CLIENT_DEVICE_SCREEN/INPUT` 能力常量、DeviceStreamManager、ControlLease、`device:stream-*` 通道、EPHEMERAL_CHANNELS、设备列表展示 |
| **复用** | `server:createDeviceToken`、device token 绑定、`device_tool` 的 `computer/fs`、浏览器流的 canvas/坐标/键盘组件 |

**一句话链路**：**WebUI 登录 → 用已登录会话自动换 device token → 原生 device link 出站连接 → hub 通过 capability 调手机采集/输入 → viewer 看帧发输入。** 不需要安卓端 server，也不需要 QuickJS。

---

## 4. 画面传输：能传，方式要选对

### 4.1 采集管线

- `MediaProjectionManager.createScreenCaptureIntent()` → 用户同意 → `getMediaProjection()`。
- 前台服务类型必须是 `mediaProjection`：
  - `FOREGROUND_SERVICE`
  - `FOREGROUND_SERVICE_MEDIA_PROJECTION`
  - `<service android:foregroundServiceType="mediaProjection">`
  参考 [Android 媒体投影文档](https://developer.android.google.cn/media/grow/media-projection?hl=zh-cn#foreground_service_permission)。
- 每次 `createVirtualDisplay()` 会话都要重新征得用户同意；`MediaProjection` token 只能用于一次会话（Android 14+ 强制）。
- 用 `MediaProjectionConfig.createConfigForDefaultDisplay()` 明确请求整屏；否则 Android 14+ 用户可能只共享单个 App。
- `VirtualDisplay` 输出到 `ImageReader`（JPEG）或 `MediaCodec` 输入 Surface（H.264）。
- 处理旋转/折叠/分辨率变化：监听 `DisplayManager.DisplayListener` 与 `onConfigurationChanged`，重建 VirtualDisplay 并通知观看端新的 `width/height/rotation`。

### 4.2 编码与传输对比

| 方案 | 带宽（720p 估算） | 端到端延迟（经验值） | 复杂度 | 适用 |
|---|---|---|---|---|
| **JPEG + base64 over WS** | 10fps ≈ 4–8 Mbps（含 +33% base64） | 150–300ms | 低 | P0；复用现有帧协议 |
| **H.264 + WebCodecs over WS** | 2–4 Mbps | 80–150ms | 中 | P1；更省流量、更顺滑 |
| **WebRTC** | 自适应，1–4 Mbps | 50–100ms | 高（信令/ICE/TURN） | 游戏/高帧率；首版不做 |

现有浏览器帧流已经证明“JPEG base64 + WS + canvas”可行，且文档明确接受 8–15fps 的“够看”体验（[browser-view-streaming.md](file:///c:/Users/Ryan/code/craft-agents-oss/docs/browser-view-streaming.md#L181-L195)）。安卓屏幕更大，建议：

- 长边缩到 **720p/900p**，JPEG q45–q60，8–12fps 起步；
- 静止画面降帧、画面变化时升帧；
- 输入后 1–2 秒内不降画质（与浏览器流一致）；
- 首帧种子：`MediaProjection` 启动后先抓一张静帧，避免观看端空白；
- 帧只保留最新一帧，**丢帧不排队**；`EPHEMERAL_CHANNELS` 保证重连不补旧帧。

### 4.3 关键限制

1. **每次会话需用户同意**：不能静默开始；适合“用户点开远程协助”的产品形态，不适合“随时偷看”。
2. **`FLAG_SECURE` 窗口黑屏**：银行、支付、Netflix/DRM 等页面无法采集，平台强制，不能绕过。
3. **锁屏自动停止**：Android 15 QPR1+ 状态栏会显示投屏提示，锁屏会停止投屏；无法用普通应用解锁安全锁屏。
4. **状态栏提示**：Android 15 QPR1+ 强制显示投屏 chip，用户可随时停止；这是好事，不要试图隐藏。
5. **WebCodecs 需要安全上下文**：HTTPS 或 localhost；纯 HTTP 局域网只能走 JPEG/MSE。Android WebView 的 WebCodecs 支持还取决于 WebView 版本，需准备 JPEG 降级。
6. **带宽**：移动网络下 1080p JPEG 10fps 可能 10–20 Mbps；必须自适应分辨率和帧率。

---

## 5. 输入回灌：无障碍够用，但别承诺“游戏级”

### 5.1 无障碍能做什么

在 `AccessibilityService` 配置中声明 `android:canPerformGestures="true"`、`android:canRetrieveWindowContent="true"`：

| 操作 | 实现 | 可行性 |
|---|---|---|
| 点按 | `GestureDescription` 单点 Path | ✅ |
| 滑动/拖拽 | `dispatchGesture()`；长拖拽用 `StrokeDescription(willContinue=true)` + `continueStroke()` 串接 | ✅（有延迟） |
| 多指/缩放 | 一次 `GestureDescription` 放多个 `StrokeDescription` | ✅（复杂手势需调参） |
| 返回/Home/最近任务/通知栏 | `performGlobalAction(GLOBAL_ACTION_*)` | ✅ |
| 文本输入 | 找到焦点节点 `ACTION_SET_TEXT`；或剪贴板粘贴 | ✅（仅可编辑节点） |
| 任意按键 | 无障碍没有按键注入 API | ❌；需自定义 IME 或 Shizuku/root |
| 电源键/锁屏 | `GLOBAL_ACTION_LOCK_SCREEN`（API 28+）可锁，不能解锁 | ⚠️ |

官方支持连续手势（`willContinue` / `continueStroke`），所以“按住拖动”可以做，但每个分段都有一次系统往返，**不要期待 60fps 的指针跟随**。

### 5.2 键盘方案

| 方案 | 能力 | 代价 |
|---|---|---|
| `ACTION_SET_TEXT` | 整段文本写入焦点输入框 | 只对可编辑节点生效；终端/Canvas 可能无效 |
| 剪贴板 + 粘贴 | 兼容性最好 | 需要用户授权/前台；剪贴板读取受限 |
| 自定义输入法（Craft Keyboard） | 可发送任意文本/按键 | 用户要切换输入法；体验割裂 |
| Shizuku / root `input keyevent/text` | 真正按键注入 | 需要额外授权；`input` 每次调用慢，不适合连续输入 |
| Root + `InputManager.injectInputEvent` | 低延迟、真实多点触控 | 需 root；检测与合规风险高；不建议产品化 |

**建议**：首版文本用 `ACTION_SET_TEXT` + 剪贴板兜底；**中文输入建议 P1 直接做 Craft IME**（见下），不要依赖 `adb shell input text`（只适合 ASCII）。

#### 中文输入：三条路线

| 路线 | 原理 | 优点 | 缺点 |
|---|---|---|---|
| **控制器侧输入法 + 手机 Craft IME `commitText`**（AirDroid AirIME 同款） | 电脑上用自己的中文输入法完成组词，把最终 Unicode 文本发给手机 IME，IME `commitText` 到焦点输入框 | 中文稳定、跨大多数 App、无需同步手机候选窗 | 用户要启用/切换到 Craft IME；不能注入全局按键 |
| **模拟物理键盘（UHID / AOA）**（scrcpy 同款） | 手机把自己当外接键盘，手机上的搜狗/Gboard/微信输入法自己组词 | 最接近真机，支持所有字符/IME，游戏按键也正常 | UHID 有权限/兼容性要求；AOA 仅 USB；要配置键盘布局 |
| **`ACTION_SET_TEXT` / 剪贴板粘贴** | 直接写文本或粘贴 | 实现简单、无需 IME | 仅可编辑节点；可能不触发 TextWatcher/IME 事件；自定义控件可能失败 |

**AirDroid 的做法**：AirIME（AirDroid 远程输入法）本身就是 Android 输入法；远程控制连上后自动切换，电脑键盘输入的文字通过 IME 提交到手机。官方文档没有单独承诺“中文”，但它的机制是提交文本而不是发 ASCII keycode，所以中文在原理上可行；实际以你手机上的 AirDroid 版本为准。

**scrcpy 的做法**：默认 `--keyboard=sdk` 只适合 ASCII；中文要用 `--keyboard=uhid`（TCP/IP 也可）或 `--keyboard=aoa`（仅 USB），并让手机上的输入法支持物理键盘。实测兼容的输入法包括搜狗、QQ 输入法、Gboard、微信输入法；小米等机型常需要切到 UHID 模式。

**对 Craft 的推荐**：

1. **P0**：`ACTION_SET_TEXT` + 剪贴板粘贴，覆盖标准输入框。
2. **P1**：做 `Craft IME`（`InputMethodService`）：
   - 观看端放一个本地 textarea，用户在电脑上用自己的中文输入法组词；
   - `compositionend` 后把最终字符串通过 `device:text` 发到手机；
   - 手机 IME 用 `commitText` 写入焦点输入框，Enter/Backspace/方向键用 `sendKeyEvent` / `deleteSurroundingText`；
   - 用户只需在手机设置里启用一次 Craft 键盘；非 root 无法静默切换 IME，需引导或弹选择器。
3. **P2**：需要游戏按键/终端/完整物理键盘语义时，再评估 UHID（root/Shizuku 或设备支持）或 AOA（仅 USB）。

**不要做的**：`adb shell input text "中文"` 在多数设备上不可靠；不要把中文拆成 keycode 逐个注入。

### 5.3 延迟与批处理

- 观看端把 pointer move 合并成 16–33ms 一批发送；不要每个 `mousemove` 都发一条 RPC。
- 服务端只保留最新输入批次；输入队列满时丢弃旧 move，保留 down/up。
- 点击/滑动使用绝对坐标（归一化到 0–1），由手机按当前 `width/height` 换算，避免旋转/缩放错位。
- 多点触控用 `pointerId` 区分；取消手势用 `ACTION_CANCEL` 等价语义。

---

## 6. 权限、系统限制与“所有文件”的真实含义

### 6.1 权限矩阵

| 权限/能力 | 用途 | 用户路径 | 限制 |
|---|---|---|---|
| `MediaProjection` 同意 | 抓全屏 | 系统弹窗，每次会话 | Android 14+ 每次 `createVirtualDisplay` 都要；token 一次性 |
| `FOREGROUND_SERVICE_MEDIA_PROJECTION` + FGS | 后台投屏 | 应用内启动 | Android 14+ 必须声明类型；Android 15+ 不能从 `BOOT_COMPLETED` 启动 |
| `BIND_ACCESSIBILITY_SERVICE` | 手势/读屏 | 设置 → 无障碍 | Android 13+ 旁加载应用默认被“受限设置”拦住，需手动允许 |
| `SYSTEM_ALERT_WINDOW` | 悬浮指示/停止按钮 | 设置 → 显示在其他应用上层 | 敏感页面会隐藏；Android 12+ 应用可主动 `HIDE_OVERLAY_WINDOWS` |
| `MANAGE_EXTERNAL_STORAGE` | 共享存储全文件 | 设置 → 所有文件访问 | 不含其他 App 私有目录；Google Play 严格审核 |
| `READ_MEDIA_IMAGES/VIDEO/AUDIO` | 媒体文件 | 运行时授权 | Android 13+ 分类型；Android 14 有“选中的照片” |
| `POST_NOTIFICATIONS` | 前台服务通知 | 运行时授权 | Android 13+ |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | 防杀 | 设置 → 电池优化 | Play 政策受限；建议引导而非强制 |
| `RECEIVE_BOOT_COMPLETED` | 开机自启 | 无 | Android 15+ 不能由此启动 `mediaProjection` FGS |

### 6.2 版本行为要点

- **Android 13**：旁加载应用的“受限设置”会阻止无障碍/通知监听，需要用户到应用信息里允许。
- **Android 14**：每次 `MediaProjection` 会话都要用户同意；FGS 必须声明 `mediaProjection` 类型；支持“只共享单个 App”。
- **Android 15**：投屏有状态栏 chip；锁屏自动停止；`BOOT_COMPLETED` 不能启动 `mediaProjection` FGS。
- **Android 16**：前台服务/后台任务配额进一步收紧；兼容性变更需实测。
- **Android 17**：ADB Wi-Fi 2.0 等变化与本功能无直接冲突，但仍需按目标 SDK 验证。

### 6.3 “访问所有文件”不是“访问一切”

- `MANAGE_EXTERNAL_STORAGE` 覆盖 `/sdcard` 共享存储（Downloads、Documents、Pictures 等）。
- **不能**访问其他 App 的私有目录（`/data/data/<pkg>`）和 `/Android/data/<pkg>`（除非 root/Shizuku）。
- 对“文件管理/传输”足够；对“备份其他 App 数据”不够。
- 如果不想申请全文件权限：用 SAF 让用户选目录 + MediaStore 访问媒体，权限更可控，但体验不如 AirDroid。

### 6.4 悬浮窗不是“控制通道”

- 远程控制输入走无障碍，不靠悬浮窗。
- 悬浮窗只承担：正在被控制的明显提示、停止按钮、连接状态。
- 不要把整个远程画面画在手机悬浮窗上——那是另一个产品形态，且会遮挡/干扰输入。

---

## 7. 协议与复用：不要另造一套

### 7.1 复用 device link

在现有能力模型上增加两个能力（或一个组合能力）：

```ts
// packages/server-core/src/transport/capabilities.ts
export const CLIENT_DEVICE_SCREEN = 'client:device:screen'
export const CLIENT_DEVICE_INPUT = 'client:device:input'
```

- `client:computer:invoke`：给 **Agent** 用，复用 `device_tool {"tool":"computer"}` 的快照/点击/输入/截图/滚动。
- `client:device:fs`：给 **Agent/文件管理** 用，复用 `device_tool` 的 read/write/list/stat/glob/grep。
- `client:device:screen` + `client:device:input`：给 **人类远程控制** 用，新增流通道。
- 设备链接仍用现有 device token；握手时声明能力；手机侧提供独立的“允许远程控制”开关（不能只靠 token）。

### 7.2 新增流通道（建议命名）

```text
device:stream-start     { deviceId }            -> { streamId, width, height, rotation }
device:stream-stop      { streamId }
device:stream-input     { streamId, events: DeviceStreamInput[] }
device:stream-control   { streamId, controlled: boolean }
device:stream-frame     <- { streamId, seq, format, data, width, height, rotation, atMs }  // 单播
device:stream-ended     <- { streamId, reason }
```

- `device:stream-frame` 必须加入 `EPHEMERAL_CHANNELS`，否则重连会补一堆积压旧帧。
- 帧只发给 `{ to: 'client', clientId }` 的订阅者，不广播。
- 输入事件 schema：

```ts
type DeviceStreamInput =
  | { type: 'touch'; action: 'down'|'move'|'up'|'cancel'; pointerId: number; x: number; y: number; pressure?: number }
  | { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; action: 'down'|'up'; key: string; code?: string; text?: string; modifiers?: number }
  | { type: 'text'; text: string }
  | { type: 'global'; action: 'back'|'home'|'recents'|'notifications'|'lock' }
  | { type: 'clipboard'; action: 'get'|'set'; text?: string }
```

- 坐标建议用 **归一化 0–1**，而不是 CSS 像素；手机端按当前屏幕尺寸换算，旋转/折叠不需要改观看端逻辑。
- 帧格式字段 `format: 'jpeg' | 'h264'`；P0 只实现 JPEG，P1 加 H.264。
- 控制权：`device:stream-control` + 服务端 `ControlLease`；默认一个控制者。Agent 持有设备时，人类接管要先确认（复用浏览器流的 `lockedBy` / `overlayDismissed` 思路）。

### 7.3 观看端复用

- 从 `BrowserStreamViewer` 抽出通用 `StreamSurface`：
  - canvas 绘制 JPEG/VideoFrame；
  - letterbox 适配与坐标反算；
  - 指针捕获、滚轮、键盘 textarea/IME 组合输入；
  - 首帧超时、断流提示、重连。
- 新增 `DeviceStreamViewer`：
  - 触摸手势映射（鼠标按下→touch down，移动→move，抬起→up）；
  - 屏幕按钮（返回/Home/最近任务/通知栏）；
  - 画质/帧率/控制权/断开；
  - 移动端浏览器隐藏地址栏类控件。
- 不要直接把 `browser-pane:*` 通道改成设备通道：浏览器有 tab/地址栏/页面 viewport 语义，设备有屏幕/旋转/触摸语义，混用会让两边都难维护。

### 7.4 文件传输

- 现有 `DeviceFsArgs.content` 是字符串，适合读写小文本；不要用它传大文件。
- 大文件建议新增二进制/分块通道（或 HTTP 上传/下载，带同一 device token），限制单次大小、校验哈希、断点续传。
- 全文件权限只是“能不能读”，不是“怎么高效传”。

---

## 8. 安全与产品边界

远程控制是高风险能力。**个人测试场景可以跳过隐私合规、多租户审计、E2E 加密**，只保留“别被陌生人连上”的最低安全线：device token + WSS + 单控制者 + 前台通知。不要把控制端口裸奔到公网。

1. **配对**：沿用 device token（一设备一份、首次握手绑定、可撤销）。手机侧还要有“允许此 hub 远程控制”的独立开关。
2. **每次会话同意**：`MediaProjection` 系统弹窗不可绕过；不要做“记住同意”。
3. **可见指示**：前台服务通知 + MediaProjection 状态栏 chip + 可选悬浮指示；不要隐藏。
4. **单一控制者**：同一设备同一时间只允许一个控制者；观看可多人，控制要租约。
5. **锁屏/断网/权限撤销**：立即停止采集、断开流、清空画面；不要保留最后一帧。
6. **传输加密**：至少 WSS/TLS；如果 hub 可能不可信，增加应用层 E2E（配对密钥 AES-GCM），或未来 WebRTC DTLS-SRTP。
7. **不落盘**：帧、输入、剪贴板不写日志/不持久化；审计只记元数据（谁、何时、多久、哪些动作）。
8. **最小权限**：文件访问按需申请；不要首启就要“所有文件/无障碍/悬浮窗”三件套。
9. **合规**：只控制用户自己的设备或明确授权的设备；不做静默监控；遵守 Google Play 无障碍/全文件政策与当地法律。

---

## 9. 分阶段实施

### P0：验证闭环（最小可用）

- Android：`MediaProjection` 抓屏 → JPEG → 现有 WS 帧格式；`AccessibilityService` 点按/滑动/返回/Home/最近任务/`ACTION_SET_TEXT`。
- 服务端：新增 `device:stream-*` 通道 + 单观看者 + 单控制者；帧加入 `EPHEMERAL_CHANNELS`。
- 观看端：复用 canvas/坐标映射，新增触摸映射与屏幕按钮。
- 验收：
  - 桌面能看到手机全屏（8–10fps），点击/滑动落点准确；
  - 返回/Home/最近任务可用；
  - 旋转/折叠后画面与坐标正确；
  - 锁屏/停止投屏/断网时观看端明确结束；
  - `FLAG_SECURE` 页面显示黑屏且有提示，不崩溃。

### P1：可用性

- H.264 + WebCodecs（JPEG 自动降级）；自适应分辨率/帧率/码率。
- 连续手势/拖拽/多指；输入批处理与背压。
- 文件浏览/上传/下载（分块/二进制）；剪贴板。
- 控制权租约、Agent 与人类接管、审计。
- 验收：720p 下 15–20fps、输入到画面 <200ms（局域网）、移动网络可自动降级。

### P2：增强

- 自定义输入法/Shizuku 可选（按键/更精细输入）。
- 多设备、多观看者、音频回传、会话录制（需明确同意）。
- E2E 加密、设备指纹/风险策略、企业 MDM 分发。

### 明确不做（首版）

- 不做 WebRTC；不做 60fps 游戏串流；不做静默后台采集；不做匿名分享链接；不做“绕过 `FLAG_SECURE`”；不做远程解锁安全锁屏。

### 9.5 个人测试场景：最短验证路径（推荐）

既然 APK 只给自己用、权限自己开，可以跳过 Play/隐私/多租户设计，按下面顺序验证：

**第 0 步：手动授权清单**

1. **无障碍**：设置 → 无障碍 → 已下载的服务 → Craft → 开启；Android 13+ 先去“应用信息 → 右上角 → 允许受限设置”。
2. **悬浮窗**：设置 → 应用 → 特殊应用权限 → 显示在其他应用上层 → Craft。
3. **所有文件**：设置 → 应用 → 特殊应用权限 → 所有文件访问权限 → Craft。
4. **通知**：允许；前台服务必须有通知。
5. **电池**：电池优化 → 不优化；OEM 的“自启动/后台运行”也放开。
6. **投屏**：每次开始远程会话时点系统弹窗“立即开始”；可勾选“不再询问”仅在部分 OEM 上存在，Android 14+ 原生不保证。
7. **可选**：开发者选项 → 充电时保持唤醒；避免测试时锁屏中断。

**第 1 步：只验证画面（不碰 Craft 协议）**

- Android：`MediaProjection` → `VirtualDisplay` → `ImageReader` → JPEG → WebSocket 发到你电脑上的临时服务。
- 电脑：一个 `<img src="data:image/jpeg;base64,...">` 页面即可看到手机屏幕。
- 目标：720p、8–12fps、点击手机屏幕能看到画面变化；先不接 Craft。
- 这一步能直接回答“画面能不能传”：**能**。

**第 2 步：只验证输入（不接画面）**

- Android：`AccessibilityService` + `dispatchGesture`，在电脑上发 `tap(x,y)` / `swipe(x1,y1,x2,y2)` / `back` / `home` / `recents`。
- 目标：能操作设置、浏览器、微信等普通 App；记录延迟与落点误差。
- 这一步能回答“无障碍够不够用”：**普通 App 够用；游戏/精细拖拽不够**。

**第 3 步：接 Craft 的 device link**

- Android 实现 `client:computer:invoke`（快照/点击/输入/截图/滚动）+ `client:device:fs`（列表/读写）。
- 先不实现实时画面，直接用 `device_tool {"device":"phone","tool":"computer"}` 让 Agent 操作手机；文件用 `device_tool {"tool":"list"}`。
- 这一步验证“Agent 能不能用”，并且**服务端零改动**。

**第 4 步：加实时画面**

- 新增 `client:device:screen` / `client:device:input` 能力 + `device:stream-*` 通道；复用现有 viewer。
- 先 JPEG/WS；跑通后再考虑 H.264/WebCodecs。

**如果有 root / Shizuku，可以额外获得：**

| 需求 | 非 root | root/Shizuku |
|---|---|---|
| 实时画面 | MediaProjection（每次同意） | `screenrecord --output-format=h264 -` 或 `screencap` 循环，可绕过投屏同意；`screenrecord` 默认约 180 秒上限，需要循环重启 |
| 任意按键 | 自定义 IME/剪贴板 | `input keyevent` / `InputManager.injectInputEvent` |
| 低延迟拖拽/多指 | 无障碍连续手势，延迟较高 | 持久 shell + `injectInputEvent`，接近真实触控 |
| 开机自启 | 只能通知用户打开 App | root 服务/系统权限可自动启动 |
| `FLAG_SECURE` | 黑屏 | LSPosed 去 flag 可尝试，但会破坏 DRM/完整性，个人测试自担 |
| 全文件 | 共享存储 | root 可读其他 App 私有目录 |

**建议**：先用非 root 的无障碍 + MediaProjection 跑通 P0；只有当你确实需要“按键注入/低延迟/开机自启”时再上 Shizuku/root。不要一开始就把 root 作为前提。

### 9.6 不要求游戏时，能否接近 AirDroid？

**能，但要区分“接近”的定义。** 对于聊天、设置、浏览器、表单、办公、文件管理这类场景，可以做到接近 AirDroid；对于游戏、银行、DRM、无人值守，做不到也不应承诺。

| 体验项 | 接近 AirDroid 的要求 | Craft 方案 |
|---|---|---|
| 画面流畅度 | 720p/900p、20–30fps、自适应码率 | H.264 + WebCodecs（JPEG 10–15fps 作为降级） |
| 输入延迟 | 局域网 80–150ms，远程 150–300ms | 输入批处理 + 连续手势 + 帧丢弃，不排队 |
| 中文打字 | 电脑输入法组词，手机输入框正确落字 | **Craft IME + `commitText`**（关键） |
| 鼠标/触控 | 点按、滑动、拖拽、滚动、返回/Home/最近任务 | 无障碍手势 + 屏幕按钮 |
| 剪贴板 | 双向复制粘贴 | `device:clipboard` 通道 + 前台交互 |
| 文件传输 | 浏览、上传、下载、进度、断点 | HTTP/分块通道（不要用 base64 WS 传大文件） |
| 连接体验 | 自动重连、在线状态、画质指示 | device link 心跳 + 重连 + 状态页 |
| 屏幕适配 | 旋转、折叠、分屏、刘海 | 归一化坐标 + 旋转/尺寸变更事件 |
| 安全提示 | 正在被控制的可见指示、随时停止 | 前台通知 + MediaProjection chip + 悬浮指示 |

**“不要求游戏”可以省掉什么：**

- 不需要 60fps/高精度多指；
- 不需要 root + `injectInputEvent` 或虚拟 HID；
- 不需要为按键组合做完整键盘映射；
- 不需要低延迟到“云游戏”级别。

**仍然省不掉什么：**

- 第一次投屏的用户同意（每次会话）；
- 锁屏后投屏停止；
- `FLAG_SECURE` 页面黑屏；
- Android 13+ 旁加载应用的无障碍“受限设置”；
- OEM 后台清理；
- 中文输入必须走 IME（`ACTION_SET_TEXT` 只能兜底）。

**判断**：如果你要的是“远程聊微信/改设置/看文件/填表单/演示”，**可以做到接近 AirDroid**；如果你要的是“随时连、无人值守、游戏级手感”，**做不到**。按 P0（JPEG + 无障碍 + 文本兜底）→ P1（H.264 + Craft IME + 剪贴板 + 文件）推进即可。

---

## 10. 风险与不可行边界

| 风险 | 影响 | 处理 |
|---|---|---|
| `FLAG_SECURE` / DRM | 银行、支付、流媒体黑屏 | 显示“该页面禁止采集”，交还用户 |
| 锁屏自动停止 | 远程会话中断 | 提示用户解锁后重新开始；不要承诺无人值守 |
| 每次投屏同意 | 不能静默开始 | 产品定位为“用户主动发起远程协助” |
| Android 13 受限设置 | 旁加载应用无法开无障碍 | 首次引导“允许受限设置” |
| Android 15 BOOT 限制 | 重启后不能自动投屏 | 重启后需用户打开 App 并同意 |
| OEM 后台杀进程 | 服务被杀、连接断 | 电池白名单引导、前台服务、重连；接受不保证 |
| 无障碍输入延迟/精度 | 拖拽/游戏体验差 | 批处理、连续手势；游戏场景不支持 |
| 全文件权限 | 个人测试无 Play 审核；误删/误写风险 | 写操作加确认；重要目录先备份；测试机不要放唯一副本 |
| 安全事件 | 手机被陌生人连上 | device token + WSS + 单控制者；不要裸奔公网；不用时关服务 |
| 合规 | 个人测试仅自有设备 | 只控制自己的设备；不要用它操作他人手机或做代运营 |

---

## 11. 工作量拆解（按模块，不给时间）

**Android（新增原生模块）**
- 权限引导/设置页：无障碍、悬浮窗、全文件、通知、电池优化。
- `RemoteControlService`：前台服务、MediaProjection、VirtualDisplay、编码、生命周期。
- `AccessibilityBridge`：手势、全局动作、文本、UI 树、旋转/窗口变化。
- `DeviceLink`：WS 握手/心跳/通道、设备能力声明、断线重连、token 存储。
- `FileBridge`：共享存储/SAF、列表/读写/分块传输。
- `OverlayIndicator`：正在被控制提示/停止。
- 测试：多 OEM、多 Android 版本、锁屏/旋转/折叠/权限撤销/断网。

**服务端（复用为主）**
- 能力常量与 `DEVICE_CAPABILITIES` 扩展。
- `DeviceStreamManager`：一路采集、按观看者扇出、背压/丢帧、首帧种子。
- 新通道注册、`EPHEMERAL_CHANNELS`、路由/权限校验。
- `ControlLease`：单控制者、Agent/人类接管、审计。
- 设备列表展示 `screen/input` 能力与在线状态。

**WebUI/Electron（复用 + 新视图）**
- 抽取 `StreamSurface`（画布/坐标/键盘）。
- `DeviceStreamViewer`：触摸、屏幕按钮、画质/帧率、控制权。
- 设备详情页“远程控制”入口；权限/在线状态提示。
- 移动端浏览器适配（无地址栏、横屏、软键盘）。

**测试矩阵**
- Android 13/14/15/16/17；Pixel/小米/OPPO/vivo/荣耀/三星。
- `FLAG_SECURE` 银行 App、DRM 视频、游戏。
- 旋转/折叠/分屏/深浅色/刘海；Wi-Fi/5G 切换；弱网。
- 无障碍被关闭、投屏被状态栏停止、锁屏、进程被杀、权限撤销。
- 多观看者/控制权抢占/Agent 同时操作。

---

## 12. 最终建议

1. **先做 P0，不做“全家桶”**：屏幕 + 点按/滑动/返回/Home + 文本 + 单控制者。这已经覆盖“远程帮用户操作手机”的 70% 场景。
2. **复用现有 device link 与 computer capability**：Agent 侧的能力（快照/点击/输入/文件）已经有协议，不要另造 MCP。
3. **传输先用 JPEG/WS**：现有浏览器帧流已验证；等 P0 稳定后再上 H.264/WebCodecs，不要首版上 WebRTC。
4. **把“每次同意/可见指示/单控制者”做成产品特性**，而不是限制；这是远程控制类产品的信任基础。
5. **明确不支持**：游戏、银行、DRM、锁屏无人值守、静默采集。把这些写进产品说明，避免用户预期错位。
6. **如果目标只是 Agent 自动化**，甚至不需要实时画面：先实现 `client:computer:invoke` + `client:device:fs`，用现有 `device_tool` 就能完成大部分任务；实时画面是“人类接管”的能力，可以后做。

---

## 13. 参考

- Android MediaProjection（前台服务/每次同意/Android 14–15 行为）: https://developer.android.google.cn/media/grow/media-projection?hl=zh-cn
- Android 无障碍服务（dispatchGesture/连续手势）: https://developer.android.google.cn/guide/topics/ui/accessibility/service?hl=zh-cn
- Android 13 受限设置: https://www.esper.io/blog/android-13-sideloading-restriction-harder-malware-abuse-accessibility-apis
- 所有文件访问与 Play 政策: https://developer.android.google.cn/training/data-storage/manage-all-files?hl=zh-cn
- Android 15 前台服务/BOOT_COMPLETED 限制: https://developer.android.google.cn/about/versions/15/behavior-changes-15
- FLAG_SECURE 与 MediaProjection: https://ptkd.com/journal/mediaprojection-screen-recording-bypass-android-14
- WebCodecs 安全上下文: https://tangoadb.dev/2.0.0/scrcpy/video/web-codecs/
- AirDroid 非 Root 控制（Control Add-on / 无障碍）: https://www.airdroid.cn/news/5248.html
- AirDroid 远程控制帮助: https://help.airdroid.com/hc/en-us/articles/360004722573-How-to-remote-control-Android-device-from-another-Android-device-with-AirMirror-App
- 项目内：[browser-view-streaming.md](./browser-view-streaming.md)、[remote-connections.md](./remote-connections.md)、[android-device-agent-research.md](./android-device-agent-research.md)
