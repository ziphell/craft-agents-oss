# 浏览器画面流（Browser View Streaming）— 设计文档

> **定位**：让"运行在另一台机器上的浏览器标签页"能在当前客户端里**被看见并被操作**。本文定协议、定边界、定分期；不重复 [浏览器 profile](browser-profiles.md) 与 [tab 路由](browser-tab-routing.md) 已经定下的东西。
>
> **一句话**：一个标签页 = 一路 JPEG 帧 + 一条输入回灌通道，走现有 WebSocket；**不是**远程桌面、**不是** VNC、**不是** WebRTC。

---

## 1. 判断：缺的是"人看着并接手"

agent 对浏览器的控制一直有，走 RPC（click / fill / scroll / screenshot），**不需要任何窗口**。缺的是另一件事：

| 场景 | 今天 |
|---|---|
| **webui** | 用右下角的面板观看 hub 的浏览器（`apps/webui/src/BrowserViewer.tsx`）——窗口本身仍开在 hub |
| **远程窗口**（瘦客户端连 hub） | agent 驱动的是 **hub 的**浏览器；客户端在远程浏览器面板里看同一路帧流（Electron 与 webui 共用协议） |
| **瘦客户端本机被 hub 驱动** | 浏览器窗口在这台设备上以独立窗口出现，但**别的客户端**（webui、另一台机器）看不到它 |

三者是同一个洞：**浏览器画面没有离开它所在的机器**。

---

## 2. 是什么 / 不是什么

**是**：一个**标签页**的帧流 + 输入回灌，观看端画在一个 pane 里。

**不是**：

- **不是远程桌面**。只流一个标签页，桌面上的其他应用、通知、系统弹窗都不在画面里。
- **不是 VNC / noVNC**。见 §7 的对比。
- **不是 WebRTC**（阶段 1）。部署上只需一条已鉴权的 `wss://`；用途只需 8–15fps。

---

## 3. 数据路径

| 场景 | 路径 | 为什么 |
|---|---|---|
| 浏览器窗口就在你眼前（Electron 本机） | **不额外观看** | 那扇独立窗口本身就是视图；再做一个观看端只是同一页面的第二份拷贝 |
| hub 的浏览器 → webui | 帧走 hub 的 WS 直接到观看端 | 一跳；阶段 1 |
| 设备的浏览器 → 观看端 | 设备 → hub（中转）→ 观看端 | 两跳；hub 是权限与路由的权威；阶段 2 |

**帧是唯一的跨端观看方式**，不做"同机直挂 `WebContentsView`"：把一个标签页的 view 从停车窗搬进主窗口，等于给它换父窗、换 viewport——用户和 agent 会因此互相改页面尺寸（媒体查询、响应式布局、滚动位置全变），还要额外交接"它现在归谁"。一页只有一份 view，谁看都走帧，就没有这个问题。

一条 UI（pane + 工具栏），一种传输（frames）。

**"同机"不等于"绕网卡"**：`ws://127.0.0.1` 是内核回环，不出网卡，也不经过物理链路。`device_tool` 只点名**别的机器**——hub 自己的 shell/files/browser 就是 agent 的默认工具，在 hub 进程内直接执行，不经过任何 socket；远端 hub 驱动这台机器才走 `main/hub-connection.ts` 的应用级链路。跨进程（webui 标签页 ↔ hub）没有共享内存可用，回环 WS 就是最短的一条；观看端与源在同一台机器时，走的也正是这条回环。

---

## 4. 为什么现在可行

1. **后台标签页一直在画**。停车窗是故意保持 `showInactive()` 的（屏幕外、不进任务栏、从不激活，被最小化/隐藏还会拉回来），因为"不显示就不合成，不合成视图就丢 viewport"。`BrowserCDP.startScreencast` 的注释里记了实测：窗口在屏幕外、甚至被隐藏时，2 秒内仍能收到 120 帧。
2. **帧管线已经存在**。录制就是在用同一条 `Page.startScreencast`（`session-recordings.ts`），带 ack 与会话保持。
3. **每个标签页有自己的 CDP 会话**（`tab.cdp`），所以流是逐标签页的，不需要"切到前台才画"。

---

## 5. 协议

### 5.1 通道

| 通道 | 方向 | 作用 |
|---|---|---|
| `browser-pane:stream-start` | invoke | `{ instanceId, tabId }` → 开始流，返回 `{ streamId, tabId, width, height }` |
| `browser-pane:stream-stop` | invoke | `streamId` → 停止 |
| `browser-pane:stream-input` | invoke | `streamId`, 一批输入事件 |
| `browser-pane:resize-viewport` | invoke | `instanceId`, `width`, `height`, 可选 `tabId` → 标签页重排到该尺寸，返回实际生效的尺寸 |
| `browser-pane:stream-frame` | event | 只推给**发起该流的那一个 client**，不广播 |

### 5.2 帧

```ts
interface BrowserStreamFrame {
  streamId: string
  tabId: string
  /** JPEG, base64. 与 `data:` URL 拼起来即可直接作为 <img> 的 src。 */
  data: string
  /** CSS 像素：坐标换算的基准，不是图片的像素尺寸。 */
  width: number
  height: number
  /** Chromium 拍下这一帧的时间（ms epoch）。 */
  atMs: number
}
```

- **只推给订阅者**（`{ to: 'client', clientId }`），不广播：帧是观看者的，不是全体的。
- 去重与限流在源头上做：静止页不产生新帧；连续帧按目标帧率丢弃（默认 15fps 上限，输入后 1.5s 内不额外降频）。
- **首帧种子**：screencast 只在页面重绘时说话，而新标签页 / `about:blank` / 错误页 / 静止页可以一直不重绘。所以 `stream-start` 之后，管理器额外抓一张静帧发给**还没有收到过任何画面的观看者**（`ViewStream.sentAny`）。它不占用 15fps 预算，也不会覆盖已经到达的实时帧（发之前再确认一次），因此这些页面和普通页面走同一条路：看到的就是浏览器里真实的那一页，而不是观看端自己画的一个「没有画面」占位。这张静帧走哪条取图路径按平台定，见 §5.2.1。

### 5.2.1 平台差异与兜底

静帧不是锦上添花：在下面这些状态里它是**唯一**的画面来源，而两个平台能答出静帧的路径并不相同。所有数字都来自实测（[macos-capture-verification.md](./macos-capture-verification.md)、[windows-window-state-verification.md](./windows-window-state-verification.md)、[video-understanding-plan.md](./video-understanding-plan.md)）。

| 窗口状态 | macOS | Windows |
|---|---|---|
| 在窗口里、可见 | `capturePage` 3–38ms ✅；CDP 50–88ms | `capturePage` 11–31ms ✅；CDP 被压住的 tab 超时 |
| 最小化 | `capturePage` ✅；CDP ✅ 73ms | `capturePage` ✅；CDP ❌ 超时 |
| show 过又 hide | `capturePage` ✅ 3–12ms；CDP ✅ | 两条路径都 ❌ 超时 |
| 从未上屏 | `capturePage` ❌ 0ms 报「Current display surface not available for capture」；**CDP ✅ 98ms** | `capturePage` ❌ 立刻报错；CDP ❌ 超时 |
| 屏外已显示的停车窗 | `capturePage` ✅（一帧之后）；CDP ✅ | `capturePage` ✅ |

两条规则由此得出：

1. **流本身不依赖 surface，静帧才依赖。** `Page.startScreencast` 在 visible / offscreen / hidden 三态都是 ~120 帧/2s，所以「窗口没上过屏」不该让流断；流断了只可能是页面不重绘（首帧种子覆盖）或整扇窗口没有合成器（下面的静帧泵）。
2. **静帧按平台问「谁先答」。** macOS 先 CDP 再 `capturePage`（含停车窗兜底），Windows 反过来。判据是 `canCaptureHiddenWindows`（`process.platform !== 'win32'`），这是实测结论而不是偏好：在 Windows 上先问 CDP 会白等一次超时，在 macOS 上先问 `capturePage` 会先吃一次 0ms 的拒绝。

**静帧泵（没有合成器时的降级）**

`stream-start` 之后，如果这路 screencast **一帧都没出**（`ViewCapture.liveFrames === 0`），每 700ms 取一张静帧、按帧的同一格式发给该 capture 的所有观看者：约 1.4fps，够看清 agent 在做什么。

- 触发：有观看者、且 `liveFrames === 0`。
- 停止：出现第一帧实时画面（之后 screencast 就是画面）、最后一个观看者离开、capture 结束。
- 取图是异步往返，下一拍等这一拍结束（`taking`），不会叠加。

**不要做的三件事**（每条都有实测代价）

1. 不要为了要 surface 把窗口 `show()` 到显示器上：停车窗已经证明「已显示但屏外」就够合成，且不抢焦点、不进任务栏。
2. 不要为一次拍摄新建临时窗口：建窗不会更快，等的是那一帧。
3. 不要裸 `await capturePage`：没有 surface 时它不 reject 而是**永不 settle**，必须带时限（1s）；CDP 侧同理（1500ms）。

### 5.3 输入

坐标一律是**标签页 viewport 的 CSS 像素**（观看端按 `frame.width/height` 把自己的点击换算过去）。

```ts
type BrowserStreamInput =
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; code?: string; text?: string; modifiers?: number }
  | { type: 'text'; text: string }
```

落到设备侧：`Input.dispatchMouseEvent`（滚轮用它的 `type: 'mouseWheel'`，CDP 没有 `Input.dispatchMouseWheel`）/ `Input.dispatchKeyEvent`（与 `webContents.sendInputEvent` 相比，CDP 用的是 viewport 坐标，窗口停在屏幕外也成立）/ `Input.insertText`（`text`，走与粘贴相同的输入路径，只产生 `beforeinput`/`input`）。

**输入法**：观看端的按键目标是 pane 里一个不可见的 textarea，而不是 div——输入法只在可编辑元素上进入组合态。组合期间（`isComposing` / keyCode 229）的按键不转发，页面不会收到被拼出来的拼音；`compositionend` 时把提交的字符串作为一条 `text` 发回设备侧。普通按键仍逐键转发，行为不变。

**候选框位置**：光标属于服务端页面里的字段，观看端看不到，所以候选框默认只能停在最后点击处。`browser-pane:stream-caret` 让设备侧读一次光标（`Runtime.evaluate`：`document.activeElement` 为富文本时取 selection 的 rect，为 `input`/`textarea` 时把光标前的文本放进隐藏的镜像元素里量出坐标），观看端再按画面框把 tab CSS 像素映射回自己的坐标，把不可见 textarea 停到那里。读取按输入批次去抖（150ms 一次，纯鼠标移动不触发）；没有可编辑焦点（`null`）时保持上次的位置。组合进行中不移动，免得候选框在拼写途中跳动。

**焦点**：键盘默认属于页面——切 tab、前进/后退、刷新、地址栏回车之后都会回到页面（不可见 textarea），不留在刚点过的按钮或轨道上；只有新标签页 / `about:blank` 回到地址栏，与窗口的 `wantsAddressBarFocus` 是同一条规则。正在地址栏里打字时不抢焦点（Escape 离开地址栏则还给页面）。

### 5.4 一条 capture = 一个标签页，一条 stream = 一个观看者

Chromium 的 screencast 是**每个 CDP 会话一路**，且 `startScreencast` 会先停掉上一路。所以 screencast 由**标签页**持有、观看者共享（管理器里的 `viewCaptures` 扇出）：

- 同一标签页可以由**多个观看者**同时观看：一路 screencast、一次编码，按 stream id 分发；最后一个观看者离开才停止。
- 每个观看者仍有自己的 `streamId`，控制权与输入仍按 stream 隔离。
- 同一标签页**可以同时录制和观看**：会话录制在同一个 target 上再开一个**扁平子会话**（`Target.attachToTarget { flatten: true }`）并在那里跑自己的 screencast。两路互不影响；代价是同时运行时有两份编码（与 agent-browser 相同的取舍）。

### 5.5 控制权

- **空闲标签页**：流建立后立即取得控制（`stream-control` 在 `stream-start` 之后发送），"看"与"操作"是同一件事。
- **被 agent 持有的标签页**：rail 上该标签页的标题走 accent 高光（`lockedBy`），并画一枚小锁。**点锁 = 收起人这一侧的锁**——紫色圆环、页面变暗和输入遮罩消失，agent 的 hold（`lockedBy`）不变；观看端随后 `stream-control` 取得输入权。
- **锁是两层**：`lockedBy` 是 agent 的 claim，仍在 `whyTabIsLocked` 里拒绝其它会话的命令；`overlayDismissed` 只关掉人看到的遮罩。所以人解锁不会破坏 agent 之间的互锁，agent 也不需要重新加锁。
- **高光跟着工作走**：解锁只关掉锁，不关掉高光。agent 继续在这页工作时高光仍在，`tabs` 里的 `lockedBy` 也仍在。
- **没有「交还」**：人的控制随流结束而结束；`overlayDismissed` 在 hold 变化时自动复位（turn 结束、agent 换 tab、handover）。
- **handover**：giver 的 hold 放下会经 `setHeldBy` 复位 dismissal，接手方的新 claim 从可见的遮罩开始。
- 服务端仍按 stream 记账：`stream-input` 只对已控制的 stream 生效；`heldBy` 存在且**未被 dismissal** 时拒绝输入，并把该 stream 的控制置回 false。
- **agent 不因人在操作而暂停**：两者都可以操作同一页；人想拿回输入权就点锁，点锁只收起人这一侧的遮罩与高亮锁标记，agent 的 claim 和 agent 之间的互锁都不受影响。
- **多观看者**：控制权按 stream 独立记账，允许多人同时操作同一标签页；管理器不在人之间做仲裁，所以输入会直接叠加（光标互抢、键盘交错、拖拽断裂）。需要独占时应在更上层加租约，当前不做。

### 5.6 权限

与现有 `browserPane.*` 一致：能调该工作区浏览器的客户端，才能看/接管它的标签页。帧里可能有登录态，所以**不新增匿名通道**，不加"分享链接"。

---

## 6. 分阶段

| 阶段 | 范围 | 状态 |
|---|---|---|
| **1** | **hub 的浏览器 → 观看端**：协议 + 服务端流 + 输入转发 + webui / Electron 远程窗口的观看 pane | webui 与 Electron 远程窗口都已接上；帧不进重连缓冲 |
| 2 | 设备的浏览器 → hub 中转 → 任意观看端；复用同一观看组件与协议 | 未开始 |

~~同机主窗口直挂 `WebContentsView`~~ **不做**——见 §3：搬 view 等于换 viewport，用户与 agent 会互相改页面尺寸，还要移交停车窗。本机会话的浏览器窗口本身就是视图。

---

## 7. 决定与代价

| 方案 | 结论 | 理由 |
|---|---|---|
| **WS + JPEG 帧** | **选它** | 复用已鉴权、可穿透反代的 `wss://`；JPEG 已是 Chrome 产物，不重复编码；观看端 `<img>`/`createImageBitmap` 即可 |
| WebRTC | 暂不 | 需要信令 + ICE/TURN（hub 多在 443 反代后，UDP 常不可用）；本用途 8–15fps 足够；要先把帧/输入协议定下来，将来只换传输层 |
| noVNC | 不用 | 流的是整块桌面（含不该暴露的内容）；OS 依赖（Xvfb/x11vnc、macOS 录屏权限、Windows 第三方服务）；桌面绝对坐标对屏幕外的停车窗不成立 |
| base64 over JSON | 阶段 1 接受 | 比二进制多约 33% 体积；换取不改 codec。帧率与质量先按"够用"设，实测不够再上二进制帧 |

**代价**：

- 10fps、JPEG q60 的 1280×800 大约 0.5–1.5 MB/s，一条观看流。
- 画面是"够看"，不是"顺滑"；日常浏览仍应在本地窗口里做。
- 窗口如果从未产生过实时帧（从未上屏、没有合成器），只有静帧泵的 ~1.4fps，直到它第一次产生实时帧（§5.2.1）。
- 录制与观看同时进行时有两份编码（录制在扁平子会话上，§5.4）。

---

## 8. 代码位置

- **协议**：`packages/shared/src/protocol/channels.ts`（通道）、`routing.ts`（REMOTE_ELIGIBLE）、`events.ts`（`stream-frame` 的推送类型）、`dto.ts`（帧与输入类型）。
- **源**：`apps/electron/src/main/browser-pane-manager.ts`（`startViewStream` / `stopViewStream` / `dispatchStreamInput`，以及静帧的 `captureViewSeed` 与降级用的 `startViewStillPump`）、`browser-cdp.ts`（已有的 `startScreencast` + 新增 `dispatchInput`）。
- **入口**：`apps/electron/src/main/handlers/browser.ts`（三个 handler，帧只推给 `ctx.clientId`）。
- **观看端**：`apps/webui/src/BrowserViewer.tsx` 与 Electron 远程窗口的 `apps/electron/src/renderer/components/browser/RemoteBrowserPanel.tsx`。两者都用 `CHANNEL_MAP` 生成的 API；在 Electron 里 `browserPane.*` 跟随窗口所在服务器（REMOTE_ELIGIBLE），本地窗口连本机、远程窗口连 hub。

---

## 9. 不做

- 不做整桌面串流、不做远程控制其他应用。
- **不把标签页的 `WebContentsView` 搬进另一个窗口**（同机也一样）：换父窗就换 viewport，用户和 agent 会互相改页面布局，还要在停车窗与前台之间移交同一份 view（§3）。
- 不做"分享给未登录用户"的观看链接。
- 不在阶段 1 做二进制帧、不做 WebRTC（多观看者已由 §5.4 的扇出支持）。
- 不动窗口/连接模型（那是另一条线：窗口是视图，连接在应用级）。

---

## 10. 开放问题

1. ~~**多观看者**~~ **已做**：源侧一路 screencast，按 stream 扇出给 N 个 client。~~**录制与观看共存**~~ **已做**：录制走独立的扁平子会话，与观看互不阻塞；将来的合并方向仍是"一路采集、按消费者分发"，以省掉同时运行时的第二份编码。
2. **键盘映射**：`key`/`code`/`text` 到 `windowsVirtualKeyCode` 的映射表要覆盖常用键；阶段 1 先支持可打印字符 + Enter/Tab/Escape/方向键/退格。
3. **画质自适应**：按观看端上报的 RTT/丢帧调 quality 与帧率，还是固定档位由人切。
4. ~~**接管与 agent 的仲裁**~~ **已定**：不做仲裁。agent 不因人在操作而暂停；人被 agent 的锁挡住时，点锁解锁即接管；多观看者允许同时操作，不互斥。要独占需要另加租约，当前不做。
5. ~~**流的结束要告诉观看端**~~ **已补**：`browser-pane:stream-ended`（`streamId`, `reason`），只推给发起该流的 client；标签页关闭 / 窗口销毁 / CDP 会话丢失都会发。观看端收到后清掉画面并说明原因。
6. ~~**webui 面板按什么过滤窗口**~~ **已补**：webui 把它连接的工作区传给面板，面板只列该工作区的窗口（无工作区标记的实例仍然可见）。局限：在 webui 里切换工作区后，面板仍按页面连接时的工作区过滤，刷新后才更新。
7. ~~**输入覆盖面**~~ **已补**：单击、双击（`clickCount`）、右键/中键、拖拽选择（按下时的 `buttons` 位掩码）、滚轮、键盘（含修饰键）、输入法组合输入（不可见 textarea + `text` 事件，候选框按 `stream-caret` 停在光标处）。仍未覆盖：文件拖放、触摸/手写笔。
8. **多屏同时看**：`documentPictureInPicture`（Chrome）可以把面板搬进画中画窗口，仍是同一条流；比"新标签页"合适，但会多一条浏览器分支。
