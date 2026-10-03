# 浏览器录制与视频理解 — 重整方案

> 状态：**设计，未实现**。本文既是设计记录，也是实施依据。
> 范围：浏览器 tab 的**录制**（生产端）与 `video_tool`（消费端）。不含音频。人的录影机**交互不动**（按钮、落 downloads 照旧），但它读的那份状态要跟着换成列表（§5.5）。
> 读法：§2 是外部依据，§4 是拍过的板，§5 / §6 是落点，§7 是**刻意不做**的项——后人别当 bug 修。
> 所有引用带仓库相对路径与符号名，逐条核对过源码。
> 配套：[术语与文案规范](vocabulary.md)、[价值论断](value-thesis.md)

---

## 1. 定位

今天这条线上有一个不对称：

| | 能做的 | 在哪 |
|---|---|---|
| 人 | 按按钮录**一个** tab，落 downloads | `apps/electron/src/main/tab-recorder.ts:TabRecorder`，工具栏 `TOOLBAR_CHANNELS.RECORD` |
| agent | 只能**消费**一段已有的录像：抽成帧看 | `packages/shared/src/agent/video-commands.ts`（`sample`）+ `apps/electron/src/main/video-frames.ts` |

所以缺的不是"理解"——录像 → 帧 → 模型这条消费链路其实已经通了。缺的是**生产**：agent 不能自己录。

本次一起改两件事：

1. **录制端**：agent 可自主录，多路，按 `(owner, tab)` 分开。
2. **消费端**：`video_tool` 从"把录像变成帧给你"升级成**内置多模态模型调用的视频理解工具**。

---

## 2. 原理：模型从不看"视频"

依据：火山引擎 AI MediaKit 的两份开发指南——
《视频理解智能策略》<https://docs.volcengine.com/docs/Intelligentprocessing/video-understanding-intelligent-strategy?lang=zh>、
《视频理解拓展工具》<https://docs.volcengine.com/docs/Intelligentprocessing/VideoUnderstandingExtensionTool?lang=zh>。
（外部依据要能回溯，所以 URL 记在这里。）

**核心一条**：其媒体流水线是 拉取 → 抽帧 → 序列转换（"时间戳 + 图片"结构化序列）→ 模型推理。也就是说，**视频在被送进模型之前，一定先被转成 `(时间戳, 图片)` 序列**；视频只是盘上的压缩形态，模型侧永远是帧序列。

其余可抄的工程事实：

| # | 事实 | 对本方案的意义 |
|---|---|---|
| P1 | 抽帧是**策略**：均匀抽帧（`fps`）与**智能抽帧**（图文相似度自适应关键帧选择） | 我们只有均匀 + 变化检测，见 §7 |
| P2 | 成本/质量是**显式路由**：`level` × 视频时长分类 × prompt 关键词 → 抽帧策略与模型 | §6.2 照抄这张表 |
| P3 | 三个旋钮：`fps`(0.01–5) / `max_pixels`(空间粒度) / `max_frames`(成本熔断) | §6.1 的参数面 |
| P4 | 时序感知来自**时间戳**，不是模型自己会看时间 | `video-frames.ts:SampledVideoFrame.offsetMs` 就是它 |
| P5 | 长任务异步：提交 → `task_id` → 轮询/回调 | §7 暂不做 |

---

## 3. 关键结论：影片是存储，帧序列是视图

**影片是正品（压缩的存储形态）；帧序列是按策略算出来的视图。**

由此三条推论，它们决定了整个设计：

1. 录制端的产物是**一个影片文件**，不是内存里的帧缓冲。
2. 消费端每次分析是**从影片按策略再抽一次**——同一份文件支持多种策略（这正是"录成视频"的价值：压缩率高，且可反复取用）。
3. **"什么时候停"从正确性问题降级为存储问题**：停早了少一段，停多了多占盘。

第 3 条很重要：早前讨论过的那一整条"实时阈值找候选点 → 语义层对照意图定切点"的线，**整条不做**（理由见 §7）。当时成立的前提是"必须一次录出正确的段落"，而这个前提被第 1 条取消了。

---

## 4. 决策表

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | 录制的身份 | `(owner, tab)`；`owner` ∈ {人, 会话}，agent 侧 `owner = sessionId` | 人和 agent 可能同时录**同一个 tab**，键里必须带"谁" |
| D2 | 同一 key | 唯一——一个 owner 对一个 tab 最多一路 | 同一个东西录两遍没有意义 |
| D3 | 并发上限 | **不设** | 约定 > 配置。多了是**报告**出来的事实（路数 / MB / CPU），不是代码里的拒绝 |
| D4 | agent 的采集机制 | CDP `Page.startScreencast`，per tab | 与人的 `getDisplayMedia` 不共享管线，多路天然成立 |
| D5 | 人的采集机制 | **不变**（`getDisplayMedia`，一次一路） | "交互单路"是交互要的，机制不用动 |
| D6 | 产物 | 影片文件：会话的落该会话的 `records/`，人的落**应用自己的** `records/`（`~/.craft-agent/records/`） | 影片是可反复取用的源。**人的那一路改动过**：录制现在也记页面上打了什么，而 downloads 是文件被递来递去的地方——理由见[剧本方案](playbooks-plan.md) §5 |
| D7 | 工具形态 | **`browser_tool` 的子命令**：`record-start --tab --ttl [--wait]` / `record-stop --tab`（两头都点名，无缺省）；查询复用 `list_background_tasks` | 录制是对一个 tab 做的事；异步形态就是一条后台任务，不再另开查询口。见 §5.3 |
| D8 | 停止**不绑** tab 的使用 | 既不跟随 `heldBy`，也**不跟随 `cursorOf`** | 并行录制是常规用法：tab1 录着、去 tab2 再录一路，tab1 必须继续。这两个标记都是"谁在用这张 tab"，不是"这段录制该不该活着" |
| D9 | 真正的停止 | `record-stop` / `--ttl` 到点 / tab 关 / 窗口销毁 / 该会话被删 / 应用退出 / 采集管线断开 | "绝不能有人开始没人停"，且"永远在录"没有入口；场景表见 §5.4 |
| D10 | 状态面 | 底层是**列表**；工具栏只渲染 `owner = 人` 那一条 | 底层多路、交互单路 |
| D11 | 停下的通知 | 后台事件推一条（文件 + tab + 时长） | 停的那一刻 agent 多半不在场 |
| D12 | `video_tool` 命令面 | `understand`（主）/ `sample`（底层原语）/ `probe` | 见 §6.1 |
| D13 | 模型调用 | 复用 backend 的 `queryLlm`，给 `LLMQueryRequest` 加图片通道 | 见 §6.3 |
| D14 | 视觉能力判定 | 复用 `modelSupportsImages` / `ModelDefinition.supportsImages` | 这个能力位已经存在，不新造 |

---

## 5. 录制端

### 5.1 身份与所有权

一条录制 = `(owner, tab)`。`owner` 是人，或一个会话（`sessionId`）。两个录制可以共享同一个 `source`（同一个 tab 的 `webContents`）——这正是 D1 换来的性质，也是"人和 agent 录同一个 tab 互不影响"的表达方式。

注意这不是 tab 分组，比 tab 分组多一维：**同一个 tab 上可以同时存在两条录制**。

但要当心 agent 侧的机制。**人 + agent 同 tab 没有冲突**（两条路不同）；**agent + agent 同 tab 会撞**——`webContents.debugger` 每个 webContents 只有一条会话，而 `Page.startScreencast` 是按会话的，第二条会顶掉第一条的帧流。

而这个场景**真会发生**：驱动被 `heldBy` 串行化（同一时刻只有一个会话能驱动那张 tab），但锁每轮就放，所以两个会话可以跨轮次交错驱动同一个 tab，两条录制在墙上时钟里重叠（`heldBy` 的寿命见 §5.4）。**做法是扇出**：一张 tab 一路 screencast，N 路录制各自写自己的文件——代价很小，因为驱动本来就已经被串行化了。

**同一件事的另一面：一个会话可以同时在两张 tab 上各录一路。** tab1 起一路、去 tab2 操作再起一路——两路并行活着，tab1 那一路不会因为会话去看 tab2 而停（录制不绑 route，§5.4）。**并行录制是常规用法，不是边角**，D1 那个键就是为它准备的。

### 5.2 两条采集路径

- **人**：`apps/electron/src/renderer/browser-toolbar.tsx`（`RECORDING_FORMATS`、`getDisplayMedia` + `MediaRecorder`）→ `apps/electron/src/main/browser-pane-manager.ts:setupDisplayMediaHandler`，后者用 `TabRecorder.armedSource()` 回一个 `WebFrameMain`。**这条一行不改。**
- **agent**：`apps/electron/src/main/browser-cdp.ts` 已经通过 `webContents.debugger.attach('1.3')` + `sendCommand` 走 CDP；screencast 挂在同一条 attach 上，**per tab**，帧在 main 侧拿到，编码后落盘。

**"基于 CDP"到底意味着什么。** agent 侧的采集挂在 `apps/electron/src/main/browser-cdp.ts:BrowserCDP` 上，而它是**每 tab 一条**、存在 tab 上的对象（`cdp: new BrowserCDP(tabView.webContents)`）——跟 tab 同命，**不跟会话、不跟轮次**。所以哪些事会打断采集，是可以逐条列出来的：

| 事件 | 会结束采集吗 |
|---|---|
| 会话换 tab / 开新 tab（`cursorOf` 挪走） | 不会——录制不绑 route，CDP 对象也不在会话上 |
| 一轮结束（`heldBy` 释放） | 不会——`BrowserCDP` 属于 tab，不属于那一轮 |
| **切 tab**（后台那张被挪进 parking window） | 不会——那是视图层面的移动（`parkTab`），不碰 cdp |
| **打开 / 关闭 DevTools** | 不会——**量过**（`apps/electron/spike/anti-bot-fingerprint.ts` round 5）：Electron 39 上打开 DevTools 不结束 CDP 会话 |
| **空闲 5 秒** | **会**——`CDP_IDLE_DETACH_MS = 5_000`，见下 |
| renderer 死 / tab 崩溃 | 会——`debugger.on('detach')` 触发，跟着 `forgetSessionState()` |
| tab 关 / 窗口销毁 | 会——`detachTab` 与实例 teardown 里显式 `cdp.detach()` |

**要紧的是第 5 行。** CDP screencast **只在重绘时出帧**，而空闲计时器是跟着**发出的** `sendCommand` 走的（收到的帧不算，只有我们回的 ack 才算）——所以**页面一静，没有帧、没有 ack、没有发出调用，5 秒后 debugger 就被 detach，录制当场断**。这不是"可能误伤"，是**静态页面必然发生**。修法见 §5.4。

**容器：只有一个，mp4。** 不是"mp4 优先、webm 兜底"——兜底的代价是下游要认识第二种形状。mp4 是别的软件都打得开的那个，而且它的 duration 加载即知（抽帧的采样步长就是从这个 duration 算的）；webm（mkv）现场录出来报 `duration: Infinity`，要读一遍文件才知道。两条理由都是**量过的**（`apps/electron/spike/recorder-formats.cjs`）。表里的第二行 `video/mp4` 不是第二个容器，是同一个容器把编解码交给 build 挑：会变的只有编解码，不是文件形状。录不了 mp4 的 build 拿到的是 `pickRecordingFormat()` 的 `null`——**明说录不了**，而不是悄悄写一个别的容器。Windows/macOS 的 mp4 由系统编码器保证；Linux 要平台编码器（VAAPI 之类），不总有——那正是 webm 兜底原本唯一覆盖的机器。**agent 侧用同一段探测，不另立一套。**

**帧怎么变成影片（U1 的答案）。** 用**一个隐藏窗口做编码器**——和 `video-frames.ts` 解码录像、`drawio-render.ts` 画图是同一个手法：app 自带的那颗浏览器干活，不引入 ffmpeg，也不新增依赖。链路：

1. main 的 screencast 收到 `Page.screencastFrame` → **立刻 ack**（这个 ack 同时是让空闲回收不误伤的那条，见 §5.4），把帧与它的偏移转发给该录制的编码窗口；
2. 编码窗口把帧画进 `<canvas>`，`canvas.captureStream(FPS)` → `MediaRecorder`；
3. chunk 交回 main，main 追加落盘——**和人那条路一模一样的写法**（`TOOLBAR_CHANNELS.RECORD_CHUNK` 那套）。

三个细节，写在这里免得到时候各写各的：

- **固定帧率，不用 `captureStream(0)` + `requestFrame()`。** 后者只在重绘时出一帧，录制器会把空档压掉——录 30 秒、中间静了 5 秒，片子就短 5 秒。固定帧率下 MediaRecorder 拿的是墙上时钟，**时长是真的**，静止段落如实记成静止。
- **容器在起录前协商。** 扩展名必须在建文件时就知道（`nextRecordingPath` 用 `wx` 抢名字），所以编码窗口先用那段 `MediaRecorder.isTypeSupported` 探测把扩展名报回 main，main 再建文件。那段探测要从 `apps/electron/src/renderer/browser-toolbar.tsx:RECORDING_FORMATS` / `pickRecordingFormat()` **提到一个共享模块**，工具栏与编码窗口同读一份——否则又是两份描述。
- **一个录制一个编码窗口**，停止时销毁（`video-frames.ts` 也是"一个作业一个窗口、`finally` 里销毁"）。多路就是多个窗口，正好接上 §5.1 的扇出。

顺带，CDP 的 `startScreencast` 自带 `maxWidth` / `maxHeight` / `quality` / `format`——**这正是"空间粒度"那一档**，在源头就把帧压小，比拿到之后再缩放省。

代价直说：每路录制多一个 renderer 进程，加 JPEG 解码 + 重绘 + 编码的 CPU。**这就是 §5.6 那个"账要看得见"的对象。**

两条路共享的只有落盘目录的约定、那段容器探测（`RECORDING_FORMATS`）和状态面，**不共享采集管线**。这是"互不影响"的结构性保证，而不是靠小心维护。

**✅ 已量：tab 被挪走 / 被隐藏之后，两种持续捕获都照常出帧。**

测量脚本 `apps/electron/spike/capture-hidden-frames.cjs`，输出同目录的 `.log`。每行是 2 秒；页面自己一直在重绘（`backgroundThrottling: false`，和 app 的 tab view 一样），所以"零帧"才说明捕获停了：

| 窗口状态 | 页面出帧 | `Page.startScreencast` | `getDisplayMedia` |
|---|---|---|---|
| visible | 121 | 120 | 60 |
| **offscreen**（挪到所有显示器之外，parking window 的做法） | 121 | 120 | 60 |
| **hidden**（`hide()`） | 120 | **120** | **60** |
| 回到 visible | 121 | 122 | 60 |

**这推翻了一个看似成立的推断，值得记下来。** `apps/electron/spike/capture-methods.cjs` 量到：hidden 的窗口上 `capturePage` 与 `Page.captureScreenshot` **全部超时**（`showInactive()` 之后立刻恢复，11ms / 115ms）。据此很容易推出"parked 的 tab 不出帧，所以录制会断"——**但那是错的**。区别在于：

- **一次性取图**要求合成器**按需产出一张新的 surface**，窗口不可见时它不产，于是超时；
- **一条正在跑的流**（screencast / display media）**本身就要求 Chromium 继续出帧**，所以它不受这个影响。

**一次性取图的结论不能外推到流上。** 这正是先量再改的原因——按推断改，D5 就会被无谓地推翻，人的那条路会被换成 screencast，而它本来什么都不用动。

注意这和 DevTools 无关：本仓库的 DevTools **不跟随 tab**（`toggleTabDevTools` 开在当前屏上的 tab，切走即 `closeTabDevTools`，注释：*"they leave with the tab that is leaving"*）；录制必须一直录着那张 tab，而上面这张表说这件事两条路都做得到。

### 5.3 工具定义：`browser_tool` 的 `record-*` 命令

**为什么放在 `browser_tool` 里。** 录制是**对一个 tab** 做的事，而 tab 就是这道门管的——要找"录这个 tab"，第一眼就该看这里，不该再多开一道门。代价是 `browser_tool` 的描述本来就长，再加一段会更长；认这个代价。

| 命令 | 参数 | 作用 |
|---|---|---|
| `record-start` | `--tab <id> --ttl <dur> [--wait]` | 起一路。**两个都必填**：`--tab` 点名录哪张（id 从 `tabs` 拿），`--ttl` 声明录多久（有上限，§5.4）；`--wait` 见下表 |
| `record-stop` | `--tab <id>` | 提前收尾，**同样必须点名**。理由只有一条：**我要的那件事已经发生了**——不是"我停手了"（页面会继续动，那可能正是你要的） |

只有两条命令。**没有 `record-extend`**——为什么删见 §5.4。

**两头都必须点名，不给缺省。** 缺省只可能是"这个会话现在在用的 tab"，而那是**会变的**：在 tab1 上起录、会话随后去看 tab2，再 `record-stop` 就会停到一个不存在的对象上、或者停错那一张。**名字是这两个命令之间唯一的连接**，`--tab` 一缺省，连接就断了。

仓库里对"点名"的惯例也是这个方向：`targetTab` 的注释写着未知 id 直接抛错，理由正是"跑到别处去"是点名唯一要防的结果。

命名沿用这道门自己的 `<名词>-<动词>` 习惯（`tab-new` / `tab-show` / `tab-assign` / `viewport-resize`）。

**两种形态，一条命令。** 这是本节的重点：

| | 同步 | 异步（默认） |
|---|---|---|
| 怎么起 | `record-start --ttl 10s --wait` | `record-start --ttl 10s` |
| 这次调用 | **阻塞到录制结束**，回答里直接带上文件与状态 | 立即返回身份，录制在后台继续 |
| 结果怎么到 agent | **就在这次工具结果里**——下一轮直接有 | 结束时推一条后台通知；要主动看用 `list_background_tasks` |
| 什么时候用 | 你**接下来这段时间不干别的**，就想等出结果 | 你起完**接着干别的**（继续驱动这张 tab，或去干别的） |

区别只有一条：**这次调用等不等**。`--wait` 期间你被占住，什么都做不了；异步则起完就走。加不加 `--wait` 不改变录制本身。

**查询不新造。** 异步形态的进度与结果走现成的后台任务机制：`packages/session-tools-core/src/context.ts:BackgroundTaskInfo` 那张表就是跨轮次的真源，`list_background_tasks` 就是它的查询口，系统提示里也已经有那一节。**所以不要 `record-status`**——那是在一个已经存在的查询口旁边再开一个。

三条口径：

- **没有 `--out`。** 落哪是约定不是参数：会话的落该会话的 `records/`，文件名按开始时刻（沿用 `apps/electron/src/main/tab-recorder.ts:nextRecordingPath` 的命名）。
- **同 key 不新建。** 已经在自己录这个 tab 时再 `record-start`，不建第二条，回答现有的那条（D2）。
- **它不读录像。** 文件里是什么、要不要抽帧、要问什么问题，都是 `video_tool` 的事。先录、后决定问什么，是正常的顺序。

**能不能和批处理结合？能，但边界不是录制画的，是引用时效画的。**

这道门的批处理规则是"到一条可能改变页面的命令就停"（那之前收集的 ref 全失效了）。录制命令**不改变页面**，所以它们**不结束一批**。于是：

- **一段全由"不改变页面"的命令组成的操作，可以在一个批次里录完**：`["record-start --ttl 30s", "scroll down", "key Escape", "record-stop"]`——一次调用，一次 start…stop。
- **中间只要有一条改页面的命令，批次就在那里断开**：`["record-start --ttl 30s", "click @e1", "record-stop"]` 里的 `record-stop` **不会执行**，批次在 `click` 之后就结束了。这不是录制的限制，是 ref 时效的限制——任何多步交互本来就得分多次调用（每一步都要重新 `snapshot`）。

所以**"一段操作"的单位不是批次，是 `--ttl` 定的那个窗口**：起录给时长，然后照常驱动，时间到自然收尾，**不需要配对 `stop`**。这正是 `--ttl` 必填的含义——**录多久在开始时就声明，不由一对 start/stop 界定**。

顺带：想要"起录"和你手上的第一个动作同一次调用完成，把 `record-start` 放进那个批次就行（`["record-start --ttl 30s", "click @e1"]`），它不会把批次提前结束。

描述口径——加进 `packages/session-tools-core/src/tool-defs.ts:TOOL_DESCRIPTIONS.browser_tool`，以及 `getBrowserToolHelp()` 的命令表（一处源、两个门）：

```
recording a tab — the recording outlives the call that started it

  record-start --tab <id> --ttl <dur>            record a tab for at most <dur> (both required; take the id from `tabs`)
  record-start --tab <id> --ttl <dur> --wait     ...and hold until it ends, so the answer carries the file
  record-stop --tab <id>                         end it early

A recording is not part of a turn. It ends when its time runs out, when the tab or its window goes away, when
this conversation goes away, or when you stop it — never because a turn ended. Its length is settled when it
starts and nothing lengthens it afterwards, so a recording needs no matching stop. A recording that captured
nothing is deleted rather than kept. The file goes to this conversation's records/, named by when it started,
and you are told where it landed when it stops.

The tab is named on both ends and never inherited: the tab this conversation works from moves, and a stop that
guessed would land on the wrong recording (or on none).

Without --wait the call returns at once and the recording is a background task: you are told when it
finishes, and list_background_tasks answers "what is still recording". With --wait the call holds until
the recording ends and the answer above IS the result — use it for a short span, not for a long one.

What is inside the file is video_tool's business: understand asks a question about it, sample pulls
frames out. Recording first and working out what to ask afterwards is the normal order.
```

### 5.4 生命周期

三个状态：

| 状态 | 含义 |
|---|---|
| `recording` | 正在录，deadline 未到 |
| `stopped` | 已收尾，文件在盘上 |
| `discarded` | 一段都没录到，文件被删 |

**停的触发场景**（异步形态下，这就是"怎么停"的完整答案）：

| 场景 | 谁触发 | 结果 |
|---|---|---|
| `record-stop` | 会话 | 提前收尾——不是必须的：时长在起录时就声明了 |
| deadline 到点 | 定时器 | 到点自停——`--ttl` 声明的就是它；`record-stop` 不来，就在这里结束 |
| tab 关 | 系统 | 停，已录的留下。把现有的 `apps/electron/src/main/tab-recorder.ts:TabRecorder.stopIfSource(...webContentsIds)` 从"单条"泛化为**遍历 registry**（它的签名本来就收多个 id） |
| 窗口销毁 | 系统 | 停 |
| **该会话被删 / 归档** | 系统 | 先停，文件随会话的 `records/` 一起清（§5.6）——归属没了，它没有活着的理由 |
| **应用退出** | 系统 | 停 |
| **采集管线断开**（tab 崩溃、CDP detach、renderer 没了） | 系统 | 停——**不能只标记不停**：管线死了，这条录制就结束了 |
| 全程零字节 | 系统 | `discarded`，删文件。对应人的路径里已有的行为："空文件不是录像" |
| 写盘 / 编码失败 | 系统 | 停 + 报告，**不静默继续** |

**录制的寿命不绑任何"谁在用这张 tab"的标记。** 那三个标记都在 `apps/electron/src/main/browser-pane-manager.ts:BrowserTab` 上，但它们回答的是"**现在谁在用**"，而录制要回答的是"**这段该不该活着**"——两回事：

| 标记 | 是什么 | 为什么不能当锚点 |
|---|---|---|
| `heldBy` | per-tab 锁 | **每轮结束**就释放（`clearVisualsForSession`）→ 录制随每轮停，作废不变量 3 |
| `drivenBy` | "最近被谁动过" | 会话一停止工作（队列空）就没了 |
| `cursorOf` | 该会话工作的 tab（route） | **会话换张 tab 就挪走**——而"tab1 录着、去 tab2 再录一路"正是常规用法，tab1 必须继续 |

第三条是决定性的：**并行录制是这套东西的常规用法，不是边角。** 会话去 tab2 操作并起第二路，tab1 那一路不能被顺手掐掉。

注意区分：`--tab` 只是**在起录时点名一次**，录起来之后就不再看那张 tab 的归属了——**点一次名 ≠ 跟着它**。也正因为它只是点名、不跟随，§5.3 才规定起和停都必须自己点名。

**所以停止只剩两类**：owner 说停（`record-stop`）或时长到（`--ttl`），以及资源 / 归属真没了（上表后六行）。

**一轮结束时，录制也不结束。** 它跨轮次活着，正是它存在的理由（一个要跑很久的页面过程；或一段一轮做不完的交互）。

**而且"没人再驱动它"不等于"没什么可录"**——网站自己会动：动画、轮播、实时面板、定时刷新、一个要跑很久的服务端过程。**跨轮录制正是为了这些**：你在这一轮起录，页面接下来的变化照样进片子，你人不用在场。

所以 `--ttl` 不是"录到没事为止"——**它就是你声明的这一段有多长**。

**"永远在录"绝对不允许，而且要落成结构，不是纪律。** 四个入口都得堵：

1. **不给 `--ttl`** → 不行，它是必填的。没有"不限"这个选项。
2. **`--ttl` 给得极大** → 有上限，超出即拒绝（必填只挡住"没写"，挡不住"写个天文数字"）。
3. **时间被反复延长** → **没有能延长它的命令**（见下）。
4. **应用重启后残留一条 `recording`** → 启动时把**没有活采集管线**的条目收成终态（`orphaned`）；否则"上次那条还在录"会永远显示下去。

**`record-extend` 删掉。** 上面那张场景表就是判据：停的路径已经完整，没有一条依赖它；它唯一独有的用途是"这一次要比我给的 `--ttl` 长"，而那用"起的时候给长一点"或"再起一路"表达更清楚——而它恰好是第 3 个入口，一个可以无限延长的时间写操作。删掉之后，deadline 在 `record-start` 就定死，**它本身就是那次录制的硬上限**。

**异常与资源清理。** 一次录制握着四样东西，每一样都要在**所有**退出路径上被放掉：

| 握着的东西 | 在哪里 | 怎么放 |
|---|---|---|
| CDP screencast 会话 | `apps/electron/src/main/browser-cdp.ts`（`webContents.debugger`） | `Page.stopScreencast`；**并先让它进入会话 hold**（见下）。**不要直接 `detach`**——那是共享的 attach，有自己的引用计数与空闲回收，交给它自己收 |
| 采集 / 编码管线 | 会话侧的 registry 条目 | 条目转终态并移除 |
| deadline 定时器 | main | `clearTimeout`；否则到点会打到一个已经结束的条目上 |
| 后台任务登记 | 主进程注册表 | 转终态；会话先死的记 `orphaned`（但**不能连带 turn 语义**，见 §5.5） |

上面第一行那个 hold 不是注意事项，是**必要条件**：`browser-cdp.ts:holdsSessionState()` 只在 `initScriptIds.size > 0 || focusEmulated` 时为真，否则 `resetIdleDetachTimer()` 会在 `CDP_IDLE_DETACH_MS`（**5 秒**）之后 `detach()`。**screencast 不在这个判定里**，而静态页面**必然**触发它（不出帧 → 没有发出的调用 → 计时器到点，§5.2 那张表第 5 行）。

仓库里已有同款做法：`setFocusEmulation` 设完状态再 `resetIdleDetachTimer()`，把"再来一条命令"变成"只要它开着就不回收"。**screencast 照做**——计入 `holdsSessionState()`，收尾时再摘掉。

**文件不需要"关"。** chunk 是到一条写一条（`TabRecorder.append` 用 `appendFileSync`，不持有句柄），所以任何时刻停下，盘上都是一个能播的文件——包括异常停。这也是为什么上面的清理清单里没有 `close` 这一步。

四条不变量——这一节真正要交代的东西：

1. **`record-start` 与"安排结束"是同一步。** 没有任何代码路径能建一个条目而不挂 deadline。所以"有人开始没人停"是**结构上**不可能，而不是靠自觉。
2. **每一次录制都有界。** `--ttl` 必填、deadline 在 `record-start` 就定死，没有任何命令能延长它，给得超过上限会被拒。所以"永远在录"没有入口。
3. **录制不绑"谁在用这张 tab"。** 一轮结束、会话换到别的 tab、会话去开新 tab——都不影响它。它只在 owner 说停、时长到、或资源 / 归属没了时结束（见上表）。
4. **一个 owner 只碰自己的。** 一个会话看不见、也动不了人的那一路（`owner = 人`），反过来也一样。这是 D1 那个键的直接推论，也是"同 tab 互不影响"在工具面上的样子。

同步形态不是另一套生命周期，只是**有人在这儿等它走完**：它照样按上面的场景结束，只是结束的那一刻，回答正好回到调用者手里。所以 `--wait` 不改变任何一条不变量。

### 5.5 状态面

现在 `pushToolbarState` 推的是单个 `recording: this.tabRecorder.state()`（`apps/electron/src/main/browser-pane-manager.ts`）。改成列表，每条至少带：`owner` / `tab` / `file` / `startedAt` / `bytes` / `deadlineAt` / `state`。

**异步形态下，一路录制要能被 `list_background_tasks` 看见——但不能按今天的写法直接登记。**

主进程那张表是 **turn 作用域**的：`packages/server-core/src/sessions/SessionManager.ts:RunningBackgroundTask.turnId` 的注释写明它 "used to orphan on that turn's completion"，而 `orphaned` 的语义是"随那个 turn 的子进程一起死了"（同文件 `BackgroundTaskStatus` 的注释）。照直登记，一个 turn 里起的录制会在该 turn 结束时被判 `orphaned`，再按 §5.4 的"采集管线断开"停掉——**恰好是不变量 3 要避免的那件事**。

**已落地（走的不是那张表）**。查清了两件事，二是这条路能通的原因：

- **`task_completed` 只从 agent 自己的事件流来**（`SessionManager.ts` 的 `case 'task_completed'` 在那个 switch 里）。叫醒 idle 会话的 nudge（同文件 8699-8725）确实存在、确实会发，**但触发是事件**——录制不是 agent，它的结束发生在 electron 主进程，进不去那条流。
- **反向没有通道**：搜遍 `apps/electron/src/main`，没有任何"客户端主动告诉会话"的口。所以不能"录完回调进 SessionManager"。

于是加了一个**原语**而不是通道：`waitForRecordingEnd(sessionId, tabId)`——它走的是已有的 server→client 那条路（形状同 `pick`，一次可能久悬的调用）。`SessionRecordings` 里收尾用的那个 `finished` promise 本来就是它的实现，所以 electron 侧只是转手。

`SessionManager.startRecording` 于是这么编排：`wait: false` 起录（**不阻塞轮次**，把"已在录"还给工具），同时挂一个 watch；它 resolve 时，若会话**不在轮次中**就注入隐藏消息 `[recording-finished] … video_tool understand <file>`，在轮次中就跳过（那一轮自己的工具结果已经看得到）。用的是既有的 `sendMessage(..., { hidden: true })`。

**没登记 `backgroundTaskRegistry`**：它的用途是 `list_background_tasks` 的可见性，而通知与它是两件事。这样也顺便**绕开了 turn 作用域的孤儿化**——那条规则根本不在这条路径上。代价：异步录制不出现在 `list_background_tasks` 里（要的话是独立的第二步）。

所以必须选一条，不能空着：

- **登记项不带 `turnId`**（或另加一个"归会话、不归 turn"的标记），让 orphan-on-turn-completion 这条规则不作用于它；或
- 录制**另有一张会话级注册表**，只把它的条目**合并**进 `list_background_tasks` 的输出。

两条都行，但不定的话 §5.5 与不变量 3 直接矛盾。

三态映射到它的词汇：`recording` → `running`、`stopped` → `completed`（被提前停则是 `stopped`）、`discarded` → `failed`。同步形态**不登记**——它没有跨轮次的生命，结果就在当次的回答里。

于是这份列表有两个读者：后台任务那一侧看的是**注册表**（跨轮次的真源），工具栏看的是 `owner = 人` 的那条——这就是 D10 "底层多路、交互单路"的落点。`TabRecordingState`（`file` / `startedAt` / `bytes`）的形状保留，向后加字段。

### 5.6 负载要可报告

D3 不设上限，代价是"一个会话开 5 个 tab 全录"就是 5 条编码管线。**这个账必须看得见**（几路、多少 MB、多少 CPU），否则"不设上限"等于"看不见的负载"。报告，不是拒绝。

**录完的文件跟会话走。** `records/` 不是只增不减：会话被归档 / 删除时，它名下的影片一并清掉（和 `ensureSessionDirectory` 建的那批子目录同一条生命周期）。这是"不设上限"能成立的前提——不设的是**并发**，不是**永存**。

---

## 6. 消费端：`video_tool` → 视频理解工具

`video_tool` 的定位本来就对——它是**"读录像"的那道门**，不是驱动窗口的（`packages/shared/src/agent/video-tools.ts` 开头即如此）。要改的是它**读到什么程度**。

### 6.1 命令面

**已实现（第一段）**：参数名沿用这道门原有的习惯（`--every` / `--changes` / `--max`）。

```
understand <path> --prompt <question> [--every <dur>] [--changes] [--max <n>] [--model <id>] [--out <dir>]
sample <path> [--out <dir>] [--every <dur>] [--changes] [--max <n>]     （原样保留，降级为底层原语）
```

- `understand` 是主命令，内部就是 §2 那条链路：**抽帧 → 时间戳 + 图片 → 多模态模型 → 答案**。回答里带着帧的偏移，所以结论可以被引用到时刻。
- `sample` 保留原行为：agent 想自己看帧时才用。
- 仍然是"一次一个命令，不支持批处理"（`video-commands.ts` 的既有约定）。
- 会话里没有模型时，`understand` 明确拒绝并指出 `sample` 仍可用——不是静默失败。

**还没做，各自卡在哪**：

- **`probe`**（时长 / 尺寸 / 编码）——查证后**它的前提不成立**：sampler 的 duration 也是把文件加载进来才知道的，所以"不解码就拿到时长"做不到。见 §10 U4。
- **`--from/--to`（窗口）与 `--max-edge`** ——都要 `BrowserPaneFns.sampleVideo` 先支持。见 §10 U5。
- **`--level`**（成本 / 质量路由）——等 §10 U7 的映射定下来。

### 6.2 策略路由（照抄 P2 的表）

| 视频时长 | level | 抽帧 | 模型 |
|---|---|---|---|
| < 1 min | 忽略 | `fps=1` 均匀 | 小模型 |
| ≥ 1 min | Economy | 变化检测，约 `1fps` 帧数的 30% | 小模型 |
| | Balanced | 约 60% | 大模型 |
| | Quality | `fps=1` 均匀 | 大模型 |

外加两个上限：抽帧总数封顶，以及 `--max-frames`（独立的成本熔断）。

**这个上限只属于抽帧 / 理解，与录制无关。** 录制侧没有"帧数"这个概念——那里只有一段影片。文档里的 1000 是**那个服务自己的**数字，而我们这里是**直接调模型**，所以张数受**上下文**约束、而不是受一条流水线约束。取多少是 §10 U3。

模型的候选池用 `modelSupportsImages` 过滤（D14）——选到没有视觉能力的模型要报错说明，而不是发出去被 400。

### 6.2b 对照火山「视频抽帧」补强（2026-10 参考其文档）

**抽帧模式**对应关系（它的 `snapshot_type` 四种：`TimeInterval` / `SpecifiedTime` / `SpecifiedFrames` / `SceneChange`）：

- `timeline` = `TimeInterval`（它的 `time_interval` 单位是**秒**、默认 1、须 `>0.001`；我们内部是 ms、最小 100ms）；
- `changes` = `SceneChange`。**这一档我们已经有、但阈值写死了**：`apps/electron/src/main/video-frames.ts:VIDEO_CHANGE_THRESHOLD = 0.01`（那里注释解释了为什么比实时捕获的阈值高——视频是重编码的，每帧都带压缩噪声）。
- **要补的正是它**：把阈值变成 `--threshold`，默认取现在的常量（行为不变）。量纲照它取 `(0,1)`、越小越敏感——**正好和我们的语义同向**（越小留的帧越多）。
- 它的 `SpecifiedFrames` 只支持 `0`（首帧）和 `-1`（尾帧），用途写的是"生成视频封面"。首/尾帧对我们有用（"最后停在哪一页"），但和 `--from/--to` 是同一条线，一起做。

**三条要一起穿**：`--threshold` / `--from --to` / `--max-edge` 都得从 `video-commands.ts` 一路穿到解码页面（`BrowserPaneFns.sampleVideo` → `SessionManager` → `IBrowserPaneManager.extractVideoFrames` → 解码页）。**一次穿完三条，别分三次**——同一个参数面来回改五遍是这类改动最容易出错的地方。

**它有而我们不该抄的两样**：

1. **返回里没有时间戳**，只有文件名隐含时间（`frame_10s.jpg`）。我们是在每张图前给模型 `[+2000ms]`——这一点比它强，别为了"对齐"退回去。
2. **雪碧图**（`enable_sprite`）—— **它压的是时间轴,但这一压不产生新信息,所以不做。**
   把 N 帧按 `rows × cols` 贴成一张,位置就是时间(行优先,左→右、上→下),布局确定则该图可反查。但拆开看,雪碧图 = `{帧集} × {一个缩放} × {一个拼贴}`:**缩放那一步是 `--max-edge` 早就有的**,拼贴是纯机械的——**信息增量为零**,它不是一条新轴。
   **"除非大小不同"也救不了它**:格子**比帧小**,做的正是 `--max-edge`(逐帧缩小),拼进去只是把同样的像素装进一个文件;格子**比帧大**,是放大——本工具只缩不放,而放大不添细节。两种情形都没开出新能力,只是把 `--max-edge` 干的事换了个说法。
   **它不是"省 token 的花活",这处要纠正**:图像计费≈面积,12 帧拼一张与 12 张散图**总面积相同**,账单不变。它唯一多出来的是**打包**(N 帧 → 1 文件 / 1 附件),受益人是想"一眼扫完"的**人**;对模型反而是降级(格子更小、要额外解释布局、面积照样计费)。而"概览"现在就有:`sample --out --max-edge <小>` 回来的就是概览,区别只在 N 个文件 vs 1 个文件。
   现状:**不做**。理由不是"现在没有消费端"(这个理由会过期),而是**信息冗余——只多一个打包件,不给新东西**。真要哪天人需要一个"整段贴进报告"的落地件,那是**打包**需求,届时以 `montage`(拼版)的名义加,**别叫理解**——名字叫错了,后面就会有人拿它去喂模型。

**其余参数对照**：`scale_long`/`scale_short`（等比、`[0,4096]`、**只缩不放**）↔ 我们的 `--max-edge`（未做，§10）；`snapshot_limit [1,1000]` ↔ `--max`（我们上限 400、默认 40，§10 U3——**1000 是它的流水线数字，不是我们的**）。输出格式无参数（默认 JPG）；**它也没有起止时间参数、没有质量/压缩参数**——我们缺的那两项它同样没有，说明不是"少做了"。

### 6.2c 场景 → 策略（提炼）

**抽帧策略不是参数问题,是"我在问什么"的问题。** 火山那四种模式的价值不在参数表,在于每个模式对应一种问法。按我们自己的问法重排:

| 场景(我在问什么) | 策略 | 参数 | 现状 |
|---|---|---|---|
| 我做的这一段操作里发生了什么、按什么次序 | `timeline` 均匀 | `--every` 决定分辨率,`--max` 兜顶 | ✅ 已有 |
| 这段页面**自己动**的时候变了什么、什么时候变的 | `changes`(= `SceneChange`) | `--threshold` | ⚠️ 有,阈值写死 |
| 它最后停在哪一页 / 一开始是什么样 | `--first` / `--last` | 与 `--every` **正交**:要的是"哪几帧",不是"隔多久看一眼" | ❌ 无 |
| 第 12 秒那一下是什么 | 指定时间点 | `--from/--to` | ❌ 无 |
| 长录像先扫一遍找异常 | 稀 `timeline` | `--every` 放大 + `--max-edge` 压 token | ⚠️ 有,缺缩放 |

**抽帧 (`sample`) 与理解 (`understand`) 都是独立工具,不依赖录制。** 它们吃一个路径:用户自己给的视频、别处下载的、录制得到的,一视同仁,和 `record-*` 没有任何耦合——录制只是产出一个文件,而这个工具只认文件。

**关键是场景在"起录"时就知道了;但录制只是这种信息的一个来源。**

抽帧策略该由"这条视频是什么"决定,而录制出来的是唯一能**事先知道**答案的一种:

- **agent 驱动的一轮操作** → 均匀抽帧。时序就是答案,变化检测会把"稳定的那几步"当成没发生而丢掉;
- **agent 起录后走开、页面自己动**(`--wait`,或起录后不再驱动这个 tab)→ 场景变化。只有变化点才是答案,均匀抽帧会把 5 秒的静止摊成几十张一样的图。

用户给的视频没有这份信息,**那就不猜**——默认均匀,由 flag 决定(这也是今天的行为)。

所以这不是"抽帧依赖录制",而是**录制顺手留一条线索,抽帧有就用、没有就按默认**。这条线索是**加分项,不是前置条件**:拿掉录制侧那一行,`sample`/`understand` 一行都不用改。

> **这条线索后来有了正式形态。** 录制器还可以在影片旁边写一个**侧车**（`<录名>.events.jsonl`,同一台时钟、按路径相邻）,把导航 / 网络 / 页面内的用户动作记成结构化事件。它是同一条"按路径可查的线索"的完整版——抽帧默认策略只是它的一个消费者,另一个消费者是**剧本**。归 [剧本方案](playbooks-plan.md) §5;本节与 `sample`/`understand` 的签名都不动。

### 6.2d 改造点(穿线**一次**做完)

**判据:每一条都要能写出一条 agent 真的会敲的命令。写不出来,这个参数就不成立。**

这不是提醒,是**检查手段**。`--first/--last` 那条最初被我写成"`--from 0 --to <duration>` 的语法糖"——跳过了这一步才错的:调用者不知道 duration(要等 metadata),而区间也不等于两帧。**把场景写成命令,两处错都会当场露出来**。所以下面每条都带命令。

| 改造点 | agent 敲什么 | 从哪穿到哪 |
|---|---|---|
| `--threshold <0..1>` | `sample demo.mp4 --changes --threshold 0.05` | `video-commands.ts` → `BrowserPaneFns.sampleVideo` → `SessionManager` → `IBrowserPaneManager.extractVideoFrames` → 解码页。把 `VIDEO_CHANGE_THRESHOLD` 抬出来,默认不变 |
| `--from [--to]` | `understand demo.mp4 --prompt "第 12 秒那一下发生了什么" --from 12s --to 13s`<br>`understand demo.mp4 --prompt "12 秒之后发生了什么" --from 12s` | 同上。解码页按区间 seek,并把区间夹进 `[0, duration]`(`SpecifiedTime`) |
| `--first` / `--last` | `sample demo.mp4 --last`<br>`sample demo.mp4 --first --last` | 同上。解码页取 `t=0` 与 `t≈durationMs`(`SpecifiedFrames [0,-1]`)。**与 `--every` 正交**:要的是"哪几帧",不是"隔多久看一眼" |
| `--max-edge <n>` | `understand demo.mp4 --prompt "…" --max-edge 720` | 同上。解码页等比缩到长边上限,**只缩不放**(`scale_long`/`scale_short`) |
| 录制侧记下**谁在动**（**可选,不改抽帧工具的任何签名**） | ——(不是命令面的事:它只让 `understand` 的**默认**策略有依据) | `TabRecorder` 条目 → 一条按路径可查的线索 → 默认策略。有就用,没有就按默认 |

**`--first` / `--last` 的语义:带上它就只出这几帧,不再按间隔扫。** 否则 `sample demo.mp4 --last` 在默认 `--every 2s` 下会给出 15 帧加一张尾帧——而它要的是一张。两者同时给就取两张。这条必须写下来,不然实现时"首尾帧要不要和区间叠加"会各猜一个答案。

**写命令时暴露出来的两处修正:**

1. **`--to` 省略 = 到末尾**,不需要 `end` 这类记号。"从 12 秒往后" 就是 `--from 12s`——duration 始终不出现在命令里。
2. **`--max-edge` 改名 `--max-edge`**:它做的是"长边上限、等比缩"(对应 `scale_long`),叫 pixels 会让 agent 以为是总像素,从而把 720 当成 720 个像素。

前四行是同一个参数面,**一次穿完**——分五次改同一批文件是最容易出错的地方。最后一行是唯一跨到录制侧的一条:它让"默认策略"有依据,而不是靠 agent 记住该加哪个 flag。

**记什么**:起录时 `--wait` 是个近似信号(有人当场在等 = 页面自己动),但不完美——异步形态下 agent 也可能起录后根本不去驱动它。更准的是记"起录之后,这个 tab 有没有被这个会话驱动过";先按 `--wait` 起,准了再细化。

### 6.2e 收集规则：`changes` 跟谁比

**比的是"上一张留下来的帧",不是"上一个采样"。** 这是这一档唯一的规则，`--threshold` 只是它的灵敏度。

区别不是措辞，是两种问法：**相邻比对量的是"速率"，基准比对量的是"变化"**。

- 一个每步只动一点、整段动了很多的页面（进度条、滚动面板、时钟）——每一步都低于阈值，所以相邻比对**一步都不会留**。它把一段变了很多的录像报成"没变"，而"页面自己动"正是这一档存在的理由。
- 对着留下来的那帧比，漂移会**累加**到越线为止。

由此还白得一件事：**留下来的帧就是各个状态**，相邻两张天然构成 before/after——回答"变了什么"。首个采样是开场状态（`baseline` 为空时必留）。

**实测**（`apps/electron/spike/sampler-window.cjs`，见 §9）：一段 11.67s、每 500ms 变化 2.5% 的录制，在阈值 0.05 下——

| 阈值 | 相邻（旧） | 基准（新） |
|---|---|---|
| 0.05 | 2 帧 `[0s,1s]`（开场 + 首帧转场，漂移一句没提） | 7 帧 `[0,1,3,5,7,9,11]s` |
| 0.1 | 2 帧 | 4 帧 `[0,1,5,9]s` |

**指标本身要知道的一件事**：`diff` 每 64 字节取一个采样，而 64 是 4 的倍数——采样永远落在同一个通道上。所以**大片纯色里它只有 0 和 1 两个值**，阈值无从谈起；真实页面纹理丰富，比值才是"多大面积变了"。这也说明这里的阈值是**面积**语义，不是亮度差。

### 6.3 集成点：模型调用通道

这是全套设计里**唯一实质新增的管线**，其余都是接线。

- 契约：`AgentBackend.queryLlm(request: LLMQueryRequest)`（`packages/shared/src/agent/base-agent.ts`），契约说明在 `packages/shared/CLAUDE.md` 的 "`queryLlm` backend contract" 一节。
- 现状缺口：`LLMQueryRequest`（`packages/shared/src/agent/llm-tool.ts`）**只有文本 `prompt`**；`createLLMTool` 还明确拒绝图片附件。
- 要加的是：`LLMQueryRequest` 上的图片通道，形如 `images?: Array<{ data: string; mimeType: string; timestampMs?: number }>`。`timestampMs` 是给 P4（时序感知）用的，不能省。
- 两处实现必须同步改：`packages/shared/src/agent/claude-agent.ts:queryLlm` 与 `packages/pi-agent-server/src/index.ts:queryLlm`。**改一处必须改两处**，否则只有一种 backend 能用。

### 6.4 复用与新增

- **复用**：`apps/electron/src/main/video-frames.ts:sampleVideoFrames`（Chromium 解码，无 ffmpeg，`offsetMs` 就是时间戳）与 `packages/shared/src/agent/browser-pane.ts:BrowserPaneFns.sampleVideo`。"(时间戳, 图片) 序列"这个结构**其实已经有了**，缺的只有最后一步模型调用。
- **新增**：抽帧策略层（窗口 + 档位 → 帧集）、时间戳序列 → 模型消息的组装、§6.3 的模型通道。

### 6.5 文案

`packages/session-tools-core/src/tool-defs.ts:TOOL_DESCRIPTIONS.video_tool` 整篇重写：从"怎么把录像变成帧"改成"理解一段录像：问它问题、拿带时间戳的答案；想自己看就抽帧"。一处源、两个门（Claude 与 Pi）——沿用 `video-tools.ts` 已有的做法。

字面口径按[术语与文案规范](vocabulary.md) §4：给正在用这个工具的人看，不是给读代码的人看。

---

## 7. 刻意不做 / 不声称

（每一条都是一次讨论换来的边界，改这条线之前先看这里。）

- **不做"实时阈值 + 语义切点"。** 前提被 §3 取消：影片是存储，停的精度不再是正确性问题。硬做只会把成本和复杂度抬起来，换不到正确性。
- **不做 `record-status`。** 异步形态的录制就是一条后台任务，`list_background_tasks` 已经是它的查询口（`packages/session-tools-core/src/context.ts:BackgroundTaskInfo`）；再加一个专用查询，等于在同一件事上开第二个口。
- **不做 `record-extend`。** 停的场景已经完整（§5.4），没有一条依赖它；而它是一个能无限延长的时间写操作，正是"永远在录"的入口。deadline 在 `record-start` 定死。
- **不给 agent 录制加可见指示。** 工具栏只渲染 `owner = 人` 那一条（D10），所以 agent 在后台录某个 tab 时，**人不会被告知**——这是明确决定的，不是漏的。代价直说：一次 agent 录制对人是不可见的。
- **不叫"智能抽帧"。** 文档里的智能抽帧是**图文相似度**驱动的关键帧选择；我们的 `--changes` 只是**帧间变化检测**（`apps/electron/src/main/video-frames.ts:VIDEO_CHANGE_THRESHOLD`）。两者不是一回事，v1 老实叫"变化检测 + 均匀抽帧"。
- **不做音频。** tab 捕获是 video only（`getDisplayMedia({ video: true, audio: false })`），文档里那套"音频关键词优先"在这里没有对象。
- **不设并发上限。** 见 D3 / §5.6。
- **`understand` 不做异步任务。** 一段 tab 录制是秒到分钟级，带超时的同步调用够用（参照 `packages/shared/src/agent/llm-tool.ts:LLM_QUERY_TIMEOUT_MS`）。真出现长录像再走 P5 那条路。（录制那一侧的异步是另一回事，见 §5.3。）
- **不做云端 headless。** 窗口在本机、你看得见——见[价值论断](value-thesis.md) §6。

---

## 8. 源码对照（现状 → 本方案）

| 位置 | 现状 | 本方案 |
|---|---|---|
| `apps/electron/src/main/tab-recorder.ts:TabRecorder` | 单例，单个 `recording`，`armedSource()` 单源 | ✅ **已改**：registry（`owner → tab → recording`），人的那一路不带 key、会话的那一路带 key；`stopIfSource` 返回全部命中的 |
| `apps/electron/src/main/browser-pane-manager.ts:setupDisplayMediaHandler` | 所有 `getDisplayMedia` 请求回同一个 armed tab | **不变**（人的路） |
| 同上 `TOOLBAR_CHANNELS.RECORD` handler | 人的按钮，落 downloads | **不变** |
| 同上 `pushToolbarState` 的 `recording` 字段 | 单个 | 列表；工具栏取 `owner = 人` |
| `apps/electron/src/renderer/browser-toolbar.tsx` | `getDisplayMedia` + `MediaRecorder` | **不变** |
| `apps/electron/src/main/browser-cdp.ts` | CDP `attach` / `sendCommand` 已就位 | ✅ **已加**：`startScreencast` / `stopScreencast`——每帧 ack（不 ack 只来一帧）、计入 `holdsSessionState()`（静态页没有帧也没有 ack，否则 5 秒空闲回收会把它 detach 掉）、会话断了回调 `onEnd` |
| 新：**录制编码窗口** | —— | ✅ **已建**：`recording-encoder.ts`（一录制一个窗口，起录前协商容器，收尾等尾块）+ `recording-encoder-page.ts`（canvas + `captureStream(FPS)` + `MediaRecorder`）+ `preload/recording-encoder.ts` |
| 新：**会话录制的接缝** | —— | ✅ **已建**：`session-recordings.ts`——把 screencast、编码窗口、`TabRecorder` 接起来；**一条会话录制的起与止都归它**，收尾只有一条路：停采集 → 等编码尾块 → 条目落定 |
| `apps/electron/src/renderer/browser-toolbar.tsx:RECORDING_FORMATS` / `pickRecordingFormat()` | 只在工具栏里 | ✅ **已提到** `apps/electron/src/shared/recording-formats.ts`（表也注入编码页面，两处同读一份） |
| `packages/shared/src/agent/video-commands.ts` | 只有 `sample` | `understand` / `sample`（`probe` 待定，见 §10 U4） |
| `apps/electron/src/main/video-frames.ts:sampleVideoFrames` | `timeline` / `changes`；`changes` 跟**相邻采样**比、阈值写死 | ✅ **已改**：`--threshold` / `--from --to` / `--first --last` / `--max-edge` 全部穿到底；`changes` 改为跟**上一张留下来的帧**比（§6.2e）；各档位端到端量过（`apps/electron/spike/sampler-window.cjs`） |
| `packages/shared/src/agent/browser-commands.ts:runBrowserCommand` / `getBrowserToolHelp` | 驱动窗口的那组命令 | ✅ **已加** `record-start --tab --ttl [--wait]` / `record-stop --tab`（`--tab` 必填、`--ttl` 由 `requiredDurationOption` 必填并沿用 10 分钟上限） |
| `packages/shared/src/agent/browser-pane.ts:BrowserPaneFns` | 窗口能力面（`screenshot` / `tabs` / `tab-new` …） | ✅ **已加** `startRecording` / `stopRecording`（**可选**：无头运行时录不了，命令按名字拒绝） |
| 主进程的后台任务注册表（`list_background_tasks` 的真源，类型见 `packages/session-tools-core/src/context.ts:BackgroundTaskInfo`） | 只跟踪派生的后台 agent / 任务 | 异步形态的录制也登记进去 |
| `packages/session-tools-core/src/tool-defs.ts:TOOL_DESCRIPTIONS.browser_tool` | 教"驱动窗口" | 加一段录制（§5.3） |
| `packages/shared/src/agent/llm-tool.ts:LLMQueryRequest` | 无图片通道，且拒绝图片附件 | 加带时间戳的 `images[]` |
| `packages/session-tools-core/src/tool-defs.ts:TOOL_DESCRIPTIONS.video_tool` | 教"把录像变成帧" | 教"理解一段录像" |

---

## 9. 实施顺序

1. **消费端先行**（不依赖录制端）：`LLMQueryRequest` 加图片通道 + 两个 backend 同步；`video_tool understand`；`TOOL_DESCRIPTIONS` 重写。这一段能独立验证：拿一段已有录像直接问问题。
2. **录制端**（U1 已定，可以开工）：`TabRecorder` → registry（`(owner, tab)`）；`browser_tool` 加 `record-*` 子命令（§5.3）；CDP screencast 采集（含 `holdsSessionState()` 的 hold）+ 隐藏窗口编码（§5.2）；状态面列表 + 工具栏取人那条；后台事件。
3. **先跑通一路，再开放多路**：D3 说不设上限，但链路上第一次要让它**只跑一路**——把编码这条新管线验证过，再谈并发。
4. **补负载报告**（§5.6）。

顺序的判据是依赖方向：理解不需要录制就能测，录制不依赖理解。先做能独立验证的那一段。

**进度**：第 1 步、第 2 步的**主体都已落地并接线**——registry、screencast、编码窗口（端到端量过）、`session-recordings.ts` 接缝、门（`record-*`）、`IBrowserPaneManager` / `null` / `Remote` / `SessionManager` 四处转发、electron 的实现与三处收尾钩子（tab 关、窗口销毁、会话销毁）。**只剩后台事件**：异步形态结束后怎么让会话知道（§5.5 那处 turn 作用域的修正）。

抽帧这一侧的各档位也已经用**真录像**量过（`apps/electron/spike/sampler-window.cjs`：均匀 / 窗口 / 首尾 / 缩放 / 变化检测，以及对 `changes` 规则改动的前后对照，见 §6.2e）。量出来两件事：`changes` 的收集规则已按 §6.2e 修正；以及**录制的第一帧可能是编码窗口的空白底**（采集比编码晚一步），`--first` 会拿它——不是抽帧的毛病，记在这里免得下次当成都市传说。

接线时定的两件事：`records/` 目录由**门**算（`sessionId` + `workspaceRootPath` 都在 `ctx` 里，约定留在一处）；工具栏**不需要**推列表——它只画 `owner = 人` 那一条（D10），会话的录制不改变它画的东西。

---

## 10. 待定（审计留下的开口）

这一节是**审计的产物**：下面的问题文档现在答不了，实施前必须各自拍板。它们不是"以后再谈"，是"不定就会撞车或做错"。

| # | 开口 | 为什么不能拖 | 落点 |
|---|---|---|---|
| U1 | ~~**帧 → 影片的编码机制**~~ → **已定，见 §5.2** | 隐藏窗口做编码器：screencast 帧 → canvas → `captureStream(FPS)` → `MediaRecorder` → chunk 回 main 落盘。容器探测提到共享模块，固定帧率，一录制一窗口 | §5.2、§9 |
| U2 | **agent + agent 同 tab：扇出还是禁止** | D1 说允许，CDP 只有一条 screencast 会话。**建议扇出**：一张 tab 一路采集、N 路各自写文件——驱动已被 `heldBy` 串行化，扇出代价很小 | §5.1 |
| U3 | **`understand` 的抽帧上限取多少** | 只归抽帧 / 理解，**与录制无关**（§6.2）。文档的 1000 是那个服务自己的数字，不能直接搬：我们是直接调模型，张数受**上下文**约束 | §6.2 |
| U4 | **`probe` 的前提不成立** | 它本意是让 agent **不解码**就拿到时长；而 sampler 的 duration 也是把文件加载进来才知道的，所以做不到。要么改成"解码一帧换 metadata"（认这个代价），要么先不做 | §6.1 |
| U5 | **`--from/--to` 与 `--max-edge`** | 两者都要 `BrowserPaneFns.sampleVideo` 先支持（窗口、缩放）——那是 pane 侧的改动。`--every` 有现成的 `durationOption`，时间点没有 | §6.1 |
| U6 | **`understand --out` 写什么** | 是结论、是帧、还是两者 | §6.1 |
| U7 | **level → 模型的映射** | 表里写的是"小模型 / 大模型"，占位。要落到 `MODEL_REGISTRY` 的具体选取规则 | §6.2 |
| U8 | **`--wait` 能等多久** | 阻塞多久才安全，取决于工具调用 / 轮次自身的超时；两者要对齐，否则长 `--wait` 会被外层掐断 | §5.3 |
| U9 | **两条交互边界** | 没在录时 `record-stop` 怎么答；`--tab` 给未知 id（按仓库惯例应抛错，`targetTab` 的注释即如此） | §5.3 |
| U10 | **术语没定死** | 文中"录像"与"影片"混用，没定义关系。按[术语与文案规范](vocabulary.md) 该定死一个（建议：**录制**=动作、**影片**=文件，不用"录像"） | 全文 |
| U11 | **screencast 跨导航续不续流** | 录制中出现跳转是常态。CDP 会话本身在导航后还在，但 `Page.startScreencast` 的帧流是否继续、要不要重开，仓库里**没有证据**——实施时必须实测，别当已知 | §5.2 |

审计里问过的三件事已经定了：**人是否看得见**（不做可见指示，§7）、**文件谁回收**（跟会话生命周期，§5.6）、**同 tab 多路**（建议扇出，待确认）。

实现第一段时又定了两件：

- **时间戳怎么进模型**（原 U4）——**偏移写进 prompt 文本**（一份、按顺序，所以每个 backend 都能靠位置把图与时刻配上），`LLMQueryRequest.images[].timestampMs` 存同一件事的数据侧副本，Claude 另外按它交错成 `[+2000ms]` + 图片。Pi 的 SDK 只收扁平图片列表，交叉的是"多给了信息"，不是"换了说法"。
- **模型通道**（§6.3）——`LLMQueryRequest` 加了 `images[]`，Claude 与 Pi 两侧都接上了；两个 backend 本来就各自有把图片送进模型的原语（Claude 的 `buildSDKUserMessage` 内容块、Pi 的 `session.prompt(text, { images })`），所以这一步是接线，不是新造。

依赖上，**U1 挡在 §9 第 2 步前面**；第 1 步已经落地（`understand` 的帧数用的是这道门既有的 `--max`，默认 40、上限 400，所以 U3 在实现里已经按这个数走了）。其余可以并行拍板。
