# 全局助理（Global Assistant）— 设计文档

> 状态：设计（未完整实现）。`BotPage` 等部分代码已落地，但功能**暂不上线**。
> 对照物：Trae CN 的「TRAE 宝」（本机 `1.107.1`，实现见 §1 证据列）。
> 一句话：给 Craft 一个**不属于任何工作区的会话身份**——它读得到各处结论，能把活**显式**派到某个工作区去跑，并把跨工作区的经验写成**一份人可以打开改的文件**。
> 不在本文：**hub 与 hub 之间**的委派（两跳以上）、以及远程窗口（[remote-connections.md](../requirements/remote-connections.md)）。单跳的跨设备在 §3.7（A2A），它与 [agent-fabric-design.md](../design/agent-fabric-design.md) 共用 request 形状，但不是那套 agent 目录。

---

## 0. 结论

1. **Trae 宝的可迁移内核不是「两层助理」这个说法，而是三个具体机制**：① 一个「没有工作区路径」的特殊项目承载助理会话；② 一个任务对象，把活派成**独立子会话**（可并行、可回看原会话）；③ 两层记忆（跨项目的画像/笔记 + 命中式核心记忆）。
2. **Craft 已经具备 80% 的底座**：单进程的 `SessionManager` 本来就管着**全部**工作区（`createSession(workspaceId)`），会话/任务/派生/项目记忆/内容索引/外部通道全都在。缺的是三样：**无工作区的会话身份**、**带显式目标的跨工作区工具**、**一份全局记忆**。
3. **不要用 `craft-cli` 当应用内的主动脉**。它要求先开 server mode、拿 token、多一个进程，且只能把结果换成 stdout 文本。应用内直接走 `SessionManager`（同进程、结构化、可事件）；CLI 留给「人/自动化在终端里」，跨**设备**走 A2A（§3.7）。
4. **记忆不要做云端画像，也不要做隐式数据库。** 做成 `ASSISTANT/MEMORY.md` 一份文件 + 各工作区已有的 `MEMORY.md`，助理按需读、写到人看得见的地方。这条是本文与 Trae 分歧最大的地方，理由在 §3.3。
5. **「两层助理」不必照抄。** Trae 需要一个「项目助理」是因为它的项目会话本身没有调度能力；Craft 的每个会话 + task 图已经是执行侧。真正缺的只有「跨工作区的那一个入口」。
6. **跨设备不是「hub 派给某个工作区的 agent」，而是「助理派给助理」**（§3.7）。设备在现有拓扑里是**以 client 身份连到 hub** 的（`hub-connection.ts` 只宣告能力清单），所以 A2A 的形状是**星形**：hub 的助理按 deviceId 指名某台设备的助理，接收方在**自己的**工作区里落地。发送方只说意图，**目标工作区由接收方解析**——这是 A2A 与「fabric 的 workspace 级 delegate」最本质的区别。

---

## 1. Trae 宝是怎么做的（本机取证）

> 证据来源：`~/.trae-cn/`（技能/记忆）、`%APPDATA%\Trae CN\ModularData\ai-agent\database.db`（**加密，未解**，schema 从二进制内嵌 SQL 还原）、`resources/app/modules/ai-agent/*.dll`（Rust 侧字符串与日志锚点）。

| 机制 | 证据 | 它解决了什么 |
|---|---|---|
| **全局助理 = 一个特殊项目** | `project_kind = 'global_assistant'`；另有 `default` / `empty`；`workspace_type ∈ {single_root, multi_root, im_group, ide_remote}`；错误串 `GlobalAssistant has no workspace path`、`Target GlobalAssistant Projects use inconsistent workspace paths` | 复用「项目—会话—任务」整套存储，**不新开一套 runtime**。代价是到处要 `if kind == global_assistant` |
| **会话与项目是 N:M** | `session_project(project_id, session_id)`；会话 `context.last_real_project_id`；项目 `transient_fallback_project_id`；`find_by_transient_fallback_project_id` | 一个没有目录的助理会话，仍能**指向**真实项目；项目被删/搬迁时会话有兜底落点 |
| **任务是派活的单位** | 工具 `task_create/get/list/update`；`spawn_create_task_subchat_loop`；`assistant_task_id`、`parent_session_id`、`child_agent_run_id`；`message_origin=assistant_sub_chat` | 一个任务 = 一个**独立子会话**（自己的模型/上下文），可并行、可「打开原会话」回看 |
| **记忆分两层** | ① 文件层：`user_profile.md`（云）、`project_memory.md`（按项目）、`YYYYMMDD/topics.md`（每日会话摘要）；写它的是 LLM 作业 `extract_topics_and_update_memory`，输出只有 `no_update` 或 `new_memory{...}`，另有 `summarize_message`<br>② `core_memory` 表：`title/keywords/scope/hit_count/last_used_at`，衰减策略 `lru / lfu / linear_decay / exponential_decay / hybrid_half_life`；`try_hit_core_memories` 命中后注入，并按 `plan_item_core_memory_snapshot` 记录「这一轮注入了哪几条」 | 文件层给「接手背景」，核心记忆给「长期偏好」，都按需注入，不塞满上下文 |
| **大脑在云侧** | `[Hub Bridge][orchestrate_chat] resolved local_project_id=`；`ChatMemoryItem` 带 `is_remote_req`、`lark_contact_ref`；记忆开关 `local_read_enabled=false`（**本地读默认关**） | 跨设备一致、画像可云端汇总。代价：离线即残废、记忆不可编辑 |
| **入口不止桌面** | `ResolveAssistantImSessionRequest`；`im_group` 作为一种工作区；飞书/微信绑定 | 手机/群里下任务，群里的人都能补信息 |
| **浮窗 = 无项目的住处** | `RegisterWindow` 的窗口类型含 `floating`；校验串「Agent and floating window bindings must not select a project」 | 浮窗不是装饰，是「这个助理没有工作区可挂」的补救（见 §9） |
| **它会自己开工** | `scheduled_tasks`、`toolcall_schedule`（cron/绝对/相对/时区）、`message_origin=proactive_chat` | 不等你开口 |

**它没做/做不了**（也是我们不该抄的）：

- 只有本地任务能跑（云/mobile 待迭代）；模型不可选；灰度放开。
- 记忆是云端资产：本地只有 `project_memory.md` / `topics.md` 的投影，用户改不动画像。
- 「跨项目」停在**读历史**这一个动作上，没有显式授权模型——它默认能看到所有项目。

---

## 2. Craft 现状（差距表）

| 能力 | 现在在哪 | 差什么 |
|---|---|---|
| 会话 | 一个 `SessionManager` 管所有工作区；`createSession(workspaceId, ...)` | 没有「不属于任何工作区」的会话 |
| 派生 | `spawn_session`（同工作区、`parentSessionId`） | 没有 `workspace` 参数：**只能在自己的工作区开新会话** |
| 会话间通信 | `send_agent_message`（按 ID 发，实现里**没有**同工作区校验） | 缺「能列举别的会话」的读面；agent 拿不到别的区的 ID |
| 任务 | `create_task` → `task.yaml` + orchestrator + DAG 节点 | 会话/节点都在一个工作区里 |
| 事件 | `sendEvent` → `{ to: 'workspace', workspaceId }` | 助理窗口收不到它派到别处的工作的实时事件 |
| 记忆 | 项目 `MEMORY.md` 注入 `<project_memory>`；`preferences.json` 全局；`creations` 索引（**每工作区一份**） | 没有全局记忆文件；没有跨区索引 |
| 外部通道 | `messaging-gateway`（飞书 / WhatsApp）+ `automations` | 未绑定到「助理」这个身份上 |
| 外部 CLI | `craft-cli`（`workspaces` / `sessions` / `send`）+ 桌面端的 **server mode**（`ws://` + token） | 要开开关、发 token、多一个进程；返回是 stdout 文本 |
| 跨设备 | 设备链路已有：`DEVICE_CAPABILITIES`（exec / fs / browser / computer），设备**以 client 身份**接到 hub（`hub-connection.ts`），hub 可按 `deviceId` 指名 | 没有 `assistant:delegate`；`agent-fabric-design.md` 的 `delegate:invoke` 仍是草案 |

**一句话**：跨工作区在**进程内**是天然的（一个 manager、一个 `getWorkspaces()`），只是所有工具面都被写成了工作区作用域；CLI 那条路是给外部用的，不该成为应用内助理的主动脉。

---

## 3. 设计

### 3.1 身份：助理是一种**会话角色**（**已改正**）

> 早先这一节写的是「助理是一个有空文件夹的工作区」（`kind: 'assistant'`）。**已废除**，理由见 §3.1.1。

```ts
Session.role?: 'bot'   // 缺省 = 普通会话
```

- **一个工作区一个 bot**：`bot:session` 在当前窗口的**所在工作区**里复用/新建一个 `role: 'bot'` 的会话。
- **它不在你的任务列表里**：创建时 `hidden: true`（与 mini 会话同一个开关，只影响呈现）。会话列表、状态计数、看板、搜索、
  未读徽标都尊重这个标记，所以**面板是它唯一的入口**；转录、目录、记忆和 id 都原地不动。Trae 也是把助理对话和任务分开的——
  列表是你的工作，助理不是其中一件。
- 它继承这个工作区的一切：模型、连接、sources、skills、权限模式、项目记忆、工作目录。**没有第二份配置。**
- 它的工具目录就是该工作区的工具目录：`spawn_session`（在本区并行）、`create_task`（在本区立 DAG）、`send_agent_message`。**没有**跨区工具（见 §3.2）。
- 侧栏里仍是顶部一条「Craft Bot」，但它属于**这个工作区**：换个窗口就是换一个 bot。

#### 3.1.1 为什么不是「另一个工作区」（2026-11-03 的教训）

第一版把它做成了一个独立工作区，然后在真 app 里挂了。三个症候、同一个病：

| 现象 | 真因 |
|---|---|
| 派活完全不通 | 新工作区的默认权限是 `safe`，而 `spawn_session` 在 Explore 下不提供；`MEMORY.md` 也写不了 |
| 看着「模型没连上」 | 面板不显示模型/连接；它其实用了 app 默认（`pi-api-key-3 / deepseek-flash`），但无从得知 |
| 首次打开两个会话 | `bot:session` 没有单飞，两个并发查询都判「还没有」 |

根本问题不是这三个 bug，而是**多了一个工作区就多了一整套要配的东西**（模型/连接/权限/sources/skills/记忆），而它们与真正的那个工作区里的是**同一批值**。每多一份就多一个静默出错的地方。改成角色后，这一整类问题不存在：值只有一份，继承是默认行为。

**代价（明确的）**：一个工作区一个 bot，因此**没有跨工作区的单一对话与单一记忆**。跨区能力已经整条拆掉（§3.2.1）；以后若真需要，A2A（§3.7）是它的位置。

**与 Trae 的对照仍成立**：他们用「无路径项目」复用 project 表；我们第一版用「另一种工作区」复用 workspace 表。两边都是在给助理找**住处**。真正的答案是它不需要住处——它是一种**行为**，住在你已经在的那个工作区里。

### 3.2 派活：用已有的 `spawn_session`，只在本工作区（**范围已收敛**）

> **2026-11-03 收敛**：跨工作区派活（`delegate_task` + 授权 + A2A）**整条线已拆除**。当前只做「同工作区」，
> 移除原因见 §3.2.1。下面的 A2A（§3.7）与授权（§3.6）都标为**未实现/暂停**。

助理派活**不加新工具**，就用现有的 `spawn_session`：

- 它在本工作区创建子会话，带 `parentSessionId`（所以工作台能列出来、能「打开」、能汇报）；
- 它继承本区的模型/连接/sources/权限/项目，没有第二份配置；
- 它在 Explore 模式下不可用（`safeMode: 'block'`），这与「助理是个会动手的角色」一致，面板会说明。

要「分步、并行、有依赖、要汇总」就用 `create_task`（DAG，上板可见）。两者分工不是「跨不跨区」，而是
**一次性的活 vs 一张有依赖的图**；这与 Trae 的差别是：他们把「任务」做成唯一入口，我们两个入口各自服务不同的形状。

#### 3.2.1 为什么拆掉跨工作区那一层

它曾经存在（`delegate_task`，显式目标 + 目标区授权 + 一跳）。拆除的理由是**收益不成立**：

- 真实使用里，要「把活交给另一个工作区」的场景远少于「在这个工作区里把它做完」；而前者要求用户先理解
  授权模型、再维护两套记忆边界。
- 每多一个模型可见的“开工”工具，就多一次选错的机会：`spawn_session` 与 `delegate_task` 在描述上必然互相指涉
  （「本区里的并行请用 X」），弱模型会挑错，而错法的代价是**活开在了错的地方**，然后对外宣称“已交给那边”。
- Trae 的结构也支持这个判断：面向模型的只有一个开工工具（`task_create`），子会话是内部实现。

**留下的东西**：`Session.role = 'bot'`、隐藏会话、工作台（子会话 + 产物）、回话闭环。**删掉的**：`delegate_task`、
`bot:delegate`、`bot:grant`、`acceptsDelegation`、`checkDelegation`。历史在设计文档的 git 里。

### 3.3 记忆：三份文件，不做画像数据库

| 文件 | 写者 | 读者 | 现有/新增 |
|---|---|---|---|
| 工作区/项目自己的 `MEMORY.md` | 那个工作区的会话（含 bot） | 同一处注入 | **已有** |
| `<workspace>/MEMORY.md`、`<workspace>/projects/<slug>/MEMORY.md` | 各区自己的会话 | 助理**按需读** | **已有** |
| `~/.craft-agent/preferences.json` | 人（界面里改） | 全局注入 | 已有 |

- **不做云端画像**：Trae 的 `user_profile.md` 在云上、本地读默认关。Craft 是本地优先，「助理记得你什么」必须是**你打开就能改的一行字**。
- **不做 `topics.md` 那种每日摘要作业**：这是本项目一贯的判据——**义务只加在产物上，不加在过程上**（见 [project-layers.md](../requirements/project-layers.md) §1）。每天自动写一份摘要，压力全在后台作业上，产出多半没人回头读。需要「上次在 X 做了什么」时，走 `creations` 索引（转录 + 快照，已有）**按需检索**，比预写摘要便宜。
- **不做 `core_memory` 那种带衰减的命中式记忆**（LRU/LFU/指数衰减）。那是「上下文装不下」的解法；Craft 的会话本来就有压缩（`/compact` 与轮次摘要，`base-agent.ts`），先加一层带衰减的记忆库没有收益，只有调参负担。
- **写入要有边界**：助理往自己的 `MEMORY.md` 写，是允许的；往**别人工作区**的记忆写，必须由那个区的会话自己写（助理只传「这条请你记一下」）。这条挡住了「一个跑偏的助理把假事实写进所有项目」。

### 3.4 任务：一次性的活 vs 一张图

两条路都在**同一个工作区**里：

| | `spawn_session` | task DAG（`create_task`） |
|---|---|---|
| 形状 | 一个子会话 | orchestrator + N 个节点 |
| 适合 | 「顺手把这件事办了」、并行几件互不相干的 | 有依赖、要审批门、要汇总、要上板跟踪 |
| 结果 | 那段对话的最后一段 + 产物 | 结构化 `outputs` / `verdict` |
| 可见面 | Bot 工作台（会话卡） | 那个区的看板 **+ Bot 工作台（图卡）** |

「谁开的」永远可查，但两条路的依据不同：子会话是 `parentSessionId`，图是 `task.yaml` 的 `created_by`
（见 §3.4.1——图不能挂 `parentSessionId`，那会把它从看板上抹掉）。

**不做跨区 DAG**：`TaskRunner` 写死 `deps.workspaceId`，一张图必须有一个拥有者（谁重试、哪个区的权限模式、
产物上哪张看板）。要让另一个区做事，那是 §3.7 的 A2A，不是把图劈开。

#### 3.4.1 图怎么进工作台：`created_by`，不是 `parentSessionId`（**已落地**）

助理建的图也要出现在工作台。**不能用父子关系表达**：给了 `parentSessionId` 的 orchestrator
会从看板上消失（`KanbanBoardContainer` 跳过它），并且被当成子会话 ⇒ 任务编辑器（铅笔）也没了。
所以关系写在 **`task.yaml` 的 `created_by`**（一个会话 id），由 `createTaskFromSpec(..., { createdBy })`
在写盘前写入；`bot:tasks` 于是是**两类卡的并集**：`kind: 'session'`（子会话）与 `kind: 'task'`（图）。

| 卡片 | 归属依据 | 打开 | 停止 |
|---|---|---|---|
| 会话 | `parentSessionId` | 那个会话 | `cancelProcessing`（取消一轮） |
| 图 | `task.yaml` 的 `created_by` | 它的 orchestrator 会话（看板上的那块砖） | `TaskRunner.stop(slug, runId)`（停整张图） |

两处容易做错的地方：① **`bot:cancel` 必须分叉**——停图不能只取消 orchestrator 的那一轮，否则图还在派节点；
② **两个 handler 必须共用一个 Conductor**（`tasks/runner-registry.ts`）：runner 把活动 run 存在内存里，
两个实例会各自以为自己是唯一的，第二次 `tasks:run` 就会把每个节点再派一遍。

**状态归谁（定过的）**：助理**读**状态、**建**图（落 `todo`，不跑）、被明确要求时**停**自己开的图；
**不写状态、不关任务**。状态的写者是看板/`TaskRunner`（run-log + orchestrator 的 `sessionStatus`）。
Trae 让助理 `task_update`，是因为它没有一个人按「运行」的看板；我们两样都有，再加一个写者只会多一个说谎的地方。

**汇报不共用子会话的触发点**：图没有 `parentSessionId`，所以 `complete/error` 那个钩子接不到它。
改由 `TaskRunner` 在终态通过 `ConductorSessionHost.onRunSettled` 交出去（`RunSettledInfo`），
`SessionManager` 只对有 `created_by` 且那个会话 `role: 'bot'` 的图发一条 hidden 消息；
**`stopped` 不报**——那是人自己按的，不是新闻。两类汇报走同一个定时器、发**同一条**消息，
所以三件事一起结束仍是一次打断；措辞在 `sessions/run-report.ts`（纯函数）。

### 3.5 入口：Craft Bot 的四个门

**先看约束**：窗口是 `(服务器, 工作区)`，客户端的 `workspaceId` 在换工作区时**重建路由**（`switchLocalWorkspace` → `client-mode:switch-local` + `syncLocalWorkspace`）。所以「点一下 Bot，当前对话消失」是不能接受的。同时应用已经有**面板栈**（peer panel：每个面板有自己的路由，`mod+t` 就是新面板）。

**结论：Craft Bot 是面板栈里的一个固定身份，不是第三个窗口，也不是工作区列表里的一项。**

| 门 | 位置 | 做什么 | 为什么是它 |
|---|---|---|---|
| **常驻行** | 侧栏最上、工作区切换器**下方**，以一条细线分隔 | 点开 = 在当前窗口开/聚焦一个 Bot 面板 | 位置固定、不随工作区变；Trae 把入口放左上也是同一理由 |
| **快捷呼出** | `mod+j`（action registry 里的 `app.openBot`） | 任意时刻开/聚焦 Bot 面板，光标进输入框 | 派活是高频动作，不该先找按钮。**留给 `mod+k`**：以后做搜索/命令面板时要它 |
| **情境** | 会话菜单（⋯）与作品卡（右键/⋯）里的「交给 Craft Bot」——**已落地** | 带着当前上下文开一个请求（`brief` 预填，**不发送**） | 入口的重心是**从这里派出去**，不是「去 Bot 那里说」 |
| **系统** | 托盘项、菜单 `Window > Craft Bot`、通知点击、`craft://bot` | 结果回到你眼前 | 助理一半的价值在「你不在看它的时候」 |

#### 3.5.1 为什么是 panel

- **窗口的工作区不变**：你在 W1 干活，旁边一个 panel 是 Bot。这与 `mod+t`（新 panel）语义一致，也不破坏「窗口 = 工作区」。
- **Bot 有自己的 navigator**（`navigator: 'bot'`）：被聚焦时左侧导航区就是它的**任务列**（跨工作区的卡），主内容是 Bot 会话。不需要第二套侧栏。
- **重复打开只聚焦**：`app.openBot` 发现当前窗口已有 Bot panel 就聚焦，不新建；要第二个就明确按「在新面板打开」。
- **展开成窗口**（右上的「在新窗口中打开」）：复用 `createWindow({ workspaceId: 'assistant' })`，给多屏/长对话。这是**可选形态**，不是唯一形态。

#### 3.5.2 不进工作区列表

**没有要给切换器过滤的东西了**：bot 住在你已经打开的工作区里，所以工作区列表不需要藏任何一条。这是角色化顺带省掉的第二处特例。

> **交互规范见 [craft-bot-interaction.md](./craft-bot-interaction.md)**：形态、四个入口、工牌、工作台、状态边界、
> 键盘与「明确不做」都在那一份里；本节只留设计判断。

#### 3.5.3 Bot 面板里放什么（**按 Trae 宝的形态收敛**）

```text
┌ 聊天头：[工牌 Craft Bot · 3 在跑]                    [分享] [⋯]  │ 工作台（点工牌才出现）
│                                                              │  任务与结果
│  会话（ChatPage：流式、工具卡、markdown、排队、模型/权限）        │  ● 意图 · 目标区 · 最后一句
│                                                              │  [↗ 打开] [■ 停止]
└──────────────────────────────────────────────────────────────┴────────────
                                                          底：本区名 ·「N 个区可接活」
```

从 Trae 抄了什么、怎么落的：

| Trae 的交互 | 我们这里 | 差别 |
|---|---|---|
| 工牌（可改名的身份卡） | 聊天头里的一个胶囊：名字 +「3 在跑」 | 改名走的仍是会话重命名，没有独立的工牌编辑器 |
| 工作台（最近任务 + 产物） | 同一个胶囊点开 = 右侧工作台；卡片上是最后一句 + **产物列表**（点开用应用内阅读器） | 一致（产物是**读**作品索引，不是为 Bot 另记一份） |
| 任务 → 打开原会话 | 卡片上的 ↗：在**那个工作区**的窗口打开 | 一致 |
| 对话本身 | `ChatPage` | 一致（我们不需要另写一个聊天） |
| 回复某条消息 | — | **未做**：composer 还没有引用回复 |
| IM 绑定（飞书/微信） | — | M4，复用 messaging-gateway |

**位置的原则**：工牌在**聊天自己的头里**（给 `ChatPage` 加了 `headerAccessory` 插槽），不是另起一条 bar——一个对话有两个标题是错的。
**工作台默认关着**：没任务时它不存在；常驻的空栏看起来像没做完。

#### 3.5.3.1 「交给 Craft Bot」：brief 的三条规则（**已落地**）

情境入口只有两处（会话菜单 ⋯、作品卡右键/⋯），做的事只有一件：把**这个人正在看的东西**写成一段可编辑的
文本，填进 Bot 的输入框，**不发**。文本由 `lib/bot-handoff.ts` 一个纯函数生成，三条规则都是有意的：

| 规则 | 为什么 |
|---|---|
| **是上下文，不是命令** | 里面没有任何祈使句。brief 一旦以「请把……」开头，人一按回车就变成了一条他没写过的指令 |
| **写清来源（会话 id / 文件路径）** | 助理能据此回去读；人也看得出这段摘要是从哪来的。没有 id 的摘要是模型无法核对、人无法追溯的一句话 |
| **最多 600 字** | 助理自己会读全文；把转录塞进输入框，会把人要写的那一句挤到看不见的地方 |

落地方式用的是现成的两半（`onInputChange` 写草稿 + `dispatchRestoreInput`/`dispatchFocusInputEvent`），
**面板用「新面板」打开而不是替换当前视图**：你是从某个地方交出去的，交出去就把正在读的对话弄丢，是惩罚使用这个门。
Bot 面板已经开着就只聚焦它，不开第二个。

#### 3.5.4 首启两步（都能跳过，**按角色化后的形状收敛**）

1. **叫什么**：`Craft Bot`（可改，走会话重命名）。
2. **干多少**：权限模式，默认 `ask`——一个要派活给别的会话的角色不能启动在 Explore 里（那里 `spawn_session` 根本不出现）。

「允许派给谁」那一步随跨区派活一起删掉了（§3.2.1）：现在只有本工作区，没有要授权的第二个区。
**不要**把开关藏在设置里：第一次点开 Bot 就该看见它。

#### 3.5.5 作用域：`bot:*` 通道，不复用 `sessions:*`

M1 开六个：`bot:session`（主线会话，首次用时创建）、`bot:grant`（某个工作区是否接受派活）、`bot:tasks`（列）、`bot:delegate`（派）、`bot:result`（读）、`bot:cancel`。**不**给 Bot 面板读写其他工作区文件的通道——要读写就落到那个区的会话里做，这样「谁改了什么」永远有会话可查。

`bot:grant` 不放在设置页，也不另开一套偏好：授权是那个工作区 `config.json` 里的 `acceptsDelegation`，面板上每个工作区旁边一枚开关。默认关，且**没有任何「默认目标」可以绕过它**。

#### 3.5.6 结果回来了，它要说出来（**闭环的最后一环**）

卡片不是答案。任务在别的工作区跑完，右轨更新了——但助理一句话没说，那这条链就还差一步。

**做法**：子会话 `complete` / `error` 时，给助理会话发一条 **hidden 用户消息**（与「后台任务结束叫醒会话」同一个机制：进模型、不渲染成气泡），
让它用一两句话把结果讲给人听。三个边界都是有意的：

| 边界 | 为什么 |
|---|---|
| **1.5s 合批** | 三个任务同时结束是一次打断，不是三次；模型还能在一句话里对比 |
| **按任务自己的 `lastMessageAt` 去重** | 重试或重复的终态事件不许把同一条结果报两遍 |
| **助理正在跑时不丢弃，进队列** | 后台任务的结果有实时流兜着；**被派出去的活在别的区，没有第二条路**，丢掉就是永远不知道 |

措辞在 `sessions/delegation-report.ts` 里，是个纯函数——它决定模型是「讲」还是「念」。它带上任务名、工作区、会话 id 和最后一段话，
并明确禁止三件比沉默更糟的事：**全文复述引文**、**重派**、**从完成通知里开始新活**。

**顺带**：它的会话是隐藏的，所以未读本来没地方显示 —— 侧栏「Craft Bot」那行现在有一个**常显**的小点
（`LeftSidebar` 新增 `unread`，与悬停才出现的 `label` 不同：只在你看它时才亮的标记不算标记）。

#### 3.5.7 「谁说的」是一个字段，不是一段文本（**已落地**）

跨会话消息（`send_agent_message`）落到目标会话时，**就是一条普通的 `role: 'user'` 消息**——它和人在键盘上打的消息在存储上一模一样。
于是它进了**人的草稿托盘**（输入框上方那个「已排队」），那个托盘原本只放「你还没发出去的话」：

| 托盘给它的操作 | 真实后果 |
|---|---|
| 编辑 | 把别的会话说的话倒进你的输入框，回车就变成**你**说的 |
| 删除 | 替你丢掉另一方的答复，而对方以为送到了 |
| ⚡ 立刻发 | 打断当前轮去送一条你没写的东西 |

根因是**一个布尔兼职两职**：`hidden` 同时回答「画不画」和「是不是系统生成」。遇到「该画、但不该当用户消息」的
就没有字段可用。修法与 Trae 同一条（它的消息行带 `message_origin` / `message_source`，子会话发出时在
`assistant_session.spawn_create_task_subchat_loop` 处算出 `is_assistant_sub_chat`）：

- `Message.origin?: 'user' | 'agent' | 'system'`（缺省 = `user`，旧行天然正确）+ `fromSessionId` / `fromSessionName`；
- **来源是事实**，`hidden` 仍是渲染策略。两个任务不再抢一个值：
  `[child-task-finished]` / `[task-finished]` = `origin: 'system'` + `hidden`；
- 托盘只放 `origin !== 'agent'`；来信单独一行「等待中 · 来自 X」，**可看、可丢弃、不可编辑**；
- 气泡上方一句「来自 X」；**机器信封照旧存在 content 里**（模型要读它才知道向谁回），但渲染前剥掉
  （`withoutAgentEnvelope`，只对 `origin === 'agent'` 生效——人自己打的方括号文本一个字都不改）。

一句话：**别用一个渲染布尔去回答「这是谁说的」。**

#### 3.5.8 事件：跟随，不是广播

`sendEvent` 现在只发 `to:'workspace'`。最小改动不是全局广播，而是**跟随**：委派时把子会话 id 记在 Bot 的任务上，Bot 面板额外订阅这些会话（`to:'sessions', ids`）。它看得到自己派出去的活，看不到别人的全部对话。

### 3.6 授权（**暂停——只做同工作区后不再需要**）

| 开关 | 位置 | 默认 |
|---|---|---|
| 「允许助理派任务进来」 | 每个工作区 | **关** |
| 被派入会话的权限模式 | 每工作区默认（`defaults.permissionMode`）或每次委派指定 | `ask` |
| 助理自己能看的范围 | 「结论」：MEMORY.md、任务结果、产物 | 不给完整历史，要读需逐次列/开 |

**注入风险要写进文档**：助理会把别处的产物、网页、回忆当上下文——这些内容可以「指使」它去派活。对策三条：① 委派提示里带来源标记（`from: workspace/x, session/y`）；② 跨区**写**永远由目标区的会话执行（助理不直接写别人的盘）；③ 派入的会话不会因为「被派来」而降级审批。

### 3.7 跨设备：助理对助理（A2A，**未实现/暂停**）

**拓扑先看清**：今天设备是**连到 hub 的 client**（`DEVICE_CAPABILITIES` = exec / fs / browser / computer，宣告在 `apps/electron/src/main/hub-connection.ts`），hub 按 `clientId` / `deviceId` 指名一个 client 去做事（`CLIENT_BROWSER_INVOKE` 就是这条路的样板）。所以：

- A2A 是**星形**，不是网格：`hub 助理 ⇄ 设备助理`。两台设备之间要说话，走它们共同的 hub（两跳封顶，见下面的 depth）。
- 于是一台「设备」上的助理是**一个按 deviceId 可寻址的服务**，不是对等节点。这与 Trae 正好相反：他们靠云做中枢，我们靠**已经在用的设备链路**，不新增中枢。

#### 3.7.1 身份

| 项 | 取值 |
|---|---|
| 助理 id | hub 侧：`serverId`（已有，握手里有）；设备侧：`<deviceId>#assistant` |
| 名字（工牌） | 可改，存在本机 config；随 `hello` 传播，不参与寻址 |
| 稳定标识 | 只在 config 里持久一份；改名不改 id |

#### 3.7.2 四个通道（比 fabric 更少）

| 通道 | 方向 | 语义 |
|---|---|---|
| `assistant:hello` | 双向（连上就发） | 名字、版本、能力、**它愿意接活的工作区 id 列表**（只报 id，不报路径）、当前负载 |
| `assistant:delegate` | 发送方 → 接收方 | 交一个任务，立刻返回 `{ taskId, state: 'accepted' }` |
| `assistant:status` | 发送方 → 接收方 | 查状态与结果（也可由 `assistant:event` 推） |
| `assistant:cancel` | 发送方 → 接收方 | 取消，幂等 |

结果另走 `assistant:event`（`progress` / `artifact` / `terminal`），回到发送方的那张远端任务卡。**不做**：budget、outputs 白名单、per-agent 配置、多跳、存储转发。

#### 3.7.3 `DelegationRequest`：本地与远端是同一份

```ts
interface DelegationRequest {
  requestId: string          // 幂等键，重投不改结果
  intent: string             // 一句话意图（卡片标题）
  prompt: string             // 要做的事
  workspaceHint?: string     // 只是提示；缺省由接收方决定
  projectHint?: string
  brief?: string             // 发送方打包的背景（结论、约束、路径若有）
  permissionModeCap?: PermissionMode  // 只能更严，不能更松
  reply: 'final' | 'events'
}

interface DelegationResult {
  state: 'completed' | 'failed' | 'cancelled'
  summary: string
  artifacts: Array<{ path: string; name: string; kind: string }>
  provenance: { deviceId: string; assistantId: string; sessions: string[] }
}
```

**本地跨工作区调用（§3.2）与远端 A2A 用同一个类型**，只是本地由 `LocalAssistantExecutor` 直接调 `SessionManager`，远端是这份 request 的线上绑定。这样「派给 B 区」与「派给办公室那台」在助理眼里是同一件事。

#### 3.7.4 三条不变量

1. **目标由接收方解析。** 发送方给 `workspaceHint`，不指定路径、不指定 project（除非 hint）。接收方只在自己「接受委派」的工作区里挑；都关就回 `NO_ACCEPTING_WORKSPACE`，**不许猜**。
2. **depth = 1。** 收到外派任务的会话，工具目录里没有 `assistant:delegate`（与 agent-fabric 原则 2 同一条规则）。hub 可以转给设备，设备不能再转给第三台。
3. **记忆不跨设备同步。** 只交换 `brief`（发送方打包）与 `result.provenance`（接收方可找回的 session id）。两份画像各自演化，比一份「合并后的画像」诚实——合并只会产生两边都不认的第三份。

#### 3.7.5 授权与失败

- **peer grant**：哪台设备可以给我派活（默认关，按 deviceId 列）；叠加本机每个工作区的「接受委派」。
- **离线不排队**：直接 `UNAVAILABLE`。存转发的代价是「它到底做没做」这个永远无法回答的问题。
- **超时不说模糊话**：`assistant:status` 有终态才算完；超时只报「还在跑，session 在这」并给出 id，**不报可能成功**。
- **凭据/审批仍在执行侧**：远端助理按自己的 workspace 默认配置跑，发送方的 `permissionModeCap` 只能收紧。

---

## 4. 分阶段

| 阶段 | 内容 | 可见结果 | 估 |
|---|---|---|---|
| **M1a（已落地，**已改成角色**）** | `Session.role: 'bot'` + 当前工作区里的一个 bot 会话 + `navigator: 'bot'` 面板 + 侧栏常驻行 + `mod+j` + `bot:*` 六个通道 + 授权开关（默认关） | 侧栏顶上一行；面板里选一个工作区、写一句活就派出去了；面板顶上写着「哪个区 · 哪个模型 · 什么权限」 | — |
| **M1b（已落地，后被 §3.2.1 收敛掉一半）** | 面板里能读/发助理对话；派活改回用 `spawn_session`（同工作区）。跨区的 `delegate_task` 与其规则**已删除** | 对话里说「把这件事办了」，它在本区开子会话；工作台列出来、产物可点开 | — |
| **M2 可管理** | 事件跟随（已落地：`bot:changed` 只送一个信号，不跨区广播转录）、助理目录去掉 `create_task`（已落地）、任务卡上的产物与「跳去那边的看板」 | 派出去的三件事在同一处看进度，谁的活点回谁那儿 | 2–3 天 |
| **M3 A2A** | `assistant:hello/delegate/status/cancel` + `CLIENT_ASSISTANT_DELEGATE` 能力 + 远端任务卡 + peer grant | 在笔记本上让「办公室那台」去跑，结果回到同一个对话里 | 3–4 天 |
| **M4 入口** | messaging-gateway 绑到助理（飞书/WhatsApp）、automations 触发助理、**有租约的胶囊**（§9，拖放入口） | 手机上下任务；定时让我「每天扫一遍各区的待办」；在浏览器里把文件拖到胶囊上就给 Bot | 3 天 |

M1 不做完不做 M2：**没有显式目标的派活工具，任务列表只是好看**。M3 不先做本地：**本地都派不明白就去跨设备，只会在两台机器上同时错**。

---

## 5. 代码地图（要改哪里）

| 位置 | 改什么 |
|---|---|
| `packages/shared/src/workspaces/types.ts` | `WorkspaceConfig.kind?: 'standard' \| 'assistant'`；`ASSISTANT_WORKSPACE_SLUG` |
| `packages/shared/src/agent/spawn-session-tool.ts` | 加 `workspace` 参数与说明（「explicit, no default」） |
| `packages/shared/src/agent/base-agent.ts` / `session-scoped-tools.ts` | 回调 `onSpawnSession` 透传 target workspace |
| `packages/server-core/src/sessions/SessionManager.ts` | `resolveTargetWorkspace`（存在 + grant + 非自身）；wire `workspace_sessions`；事件跟随 |
| `packages/server-core/src/transport/capabilities.ts` | 新增 `CLIENT_ASSISTANT_DELEGATE = 'client:assistant:delegate'`，加进 `DEVICE_CAPABILITIES`（与 `CLIENT_BROWSER_INVOKE` 同一层） |
| `apps/electron/src/main/hub-connection.ts` | 宣告上面这条能力；接收 hub 指名的委派并交给本机 `SessionManager` |
| `packages/shared/src/protocol/channels.ts` | `assistant:hello\|delegate\|status\|cancel\|event`；`DelegationRequest` / `DelegationResult`（本地与远端共用） |
| `packages/server-core/src/sessions/SessionManager.ts`（A2A） | 按 `deviceId` 找 client → 发 request；`requestId` 去重表；事件回收成远端任务卡 |
| `packages/shared/src/prompts/system.ts` | `<assistant>` 块（它是什么、能派活、记忆写哪）；全局记忆注入 |
| `packages/shared/src/tasks/*` | 节点可选 `workspace`；dispatch 按节点找 manager |
| `packages/ui` | 侧栏常驻行、Bot 面板（会话 + 任务列）、peer 列表与授权开关、远端任务卡（署名设备 + 助理名）、i18n |
| `apps/electron/src/shared/routes.ts` | `routes.view.bot()`（与 `creations` 同层） |
| `apps/electron/src/shared/types.ts` | `BotNavigationState { navigator: 'bot' }` + `isBotNavigation`，加进 `NavigationState` 联合 |
| `apps/electron/src/renderer/components/app-shell/AppShell.tsx` | 侧栏条目、键盘导航 `nav` 列表、`handleBotClick` |
| `apps/electron/src/renderer/actions/definitions.ts` | `app.openBot`（`defaultHotkey: 'mod+j'`）；「已开则聚焦」 |
| `WorkspaceSwitcher` / `CompactWorkspaceSwitcher` / 新建窗口菜单 | 过滤 `kind === 'assistant'` 的工作区（§3.5.2） |
| `packages/shared/src/protocol/channels.ts` | `bot:tasks\|delegate\|result\|cancel`；handler `packages/server-core/src/handlers/rpc/bot.ts` |
| `apps/electron/resources/docs/` | 给 agent 的短指南（与 `craft-cli.md`、`fabric-tools.md` 同一层） |

**不要动的**：工作区的存储布局（`<root>/sessions`）、`send_agent_message` 的语义（它已经能按 ID 跨区发，缺的只是「知道 ID」）、`creations` 索引的分区（先按需合并读，不做全局库）。

---

## 6. 验证（跑一遍就够的判据）

1. **零回归**：不带 `workspace` 的 `spawn_session` 仍然只在本区开；现有派生测试全绿。
2. **跨区**：对新工作区 B 调 `spawn_session { workspace: 'B', prompt }` → B 里出现一个 `parentSessionId = 助理会话` 的会话；B 的窗口看得到它，助理窗口看到结果。
3. **授权**：关掉 B 的「接受委派」后同一调用被拒，错误说清是哪个开关，而不是「workspace not found」。
4. **记忆是一份**：bot 不新开任何记忆文件；它读写的仍是这个工作区/项目的 `MEMORY.md`。重启后 bot 的身份（`role`）仍在，没有影子副本、没有数据库表。
5. **可追溯**：助理说「上次在 X 的结论是 Y」，Y 能在 X 的 `MEMORY.md` 或该区会话原文里找到。
6. **不越权**：助理的 `Write` 在 Explore/safe 下仍被限制在助理目录（守卫不需要新特例）。
7. **A2A 寻址**：hub 助理对 `deviceId` 派一个任务 → 那台设备上出现一个父链指向远端 `taskId` 的会话；hub 上出现一张署名「设备名 · 助理名」的任务卡。
8. **A2A 不猜**：那台设备的「接受委派」全关 → 回 `NO_ACCEPTING_WORKSPACE`，并且**没有**任何会话被创建。
9. **A2A 不递归**：被派入的会话调 `assistant:delegate` 必须不可用（工具不在目录里，不是运行时拒绝）。
10. **A2A 不排队**：设备离线时派活立刻 `UNAVAILABLE`；重放同一个 `requestId` 不产生第二个会话。
11. **记忆不合并**：两边 `MEMORY.md` 各自独立；hub 侧只有 `provenance` 里的 session id，没有对方记忆的副本。
12. **入口不动窗口**：在 W1 的窗口点侧栏 Craft Bot → 出现 Bot 面板，**窗口仍是 W1**（会话列表、工作区徽标都没变）；再点一次只聚焦，面板数不变。
13. **不进列表**：`WorkspaceSwitcher` / `CompactWorkspaceSwitcher` / 新建窗口菜单里都没有 `assistant`。
14. **任务卡能回去**：点任务卡的「打开」→ 目标工作区的窗口被打开/聚焦，而不是把当前窗口换区。
15. **首启不说谎**：所有工作区都关时，派活被拒且错误直指那个开关；打开一个后同一句话成功（同一句话、不重填参数）。
16. **胶囊有租约**（M4）：没有任务时它不存在；派一件活它出现；全部完成 6 秒后它**被销毁**（`BrowserWindow.getAllWindows()` 里消失，不是隐藏）。
17. **拖入不自动发**：拖一个文件上去，输入框里出现这个文件与一行待写的意图，回车前没有任何会话被创建。
18. **不进录屏**：带胶囊的桌面截图里没有胶囊（`setContentProtection` 生效）。

---

## 7. 明确不做（墓园预埋）

| 不做 | 原因 |
|---|---|
| 云端用户画像 | 本地优先；「记得你什么」必须是人能打开改的文件 |
| 每日自动 `topics.md` 摘要 | 对过程设义务；产出多半没人读。需要时按需检索转录 |
| `core_memory` 式衰减记忆库 | 先有「上下文装不下」的证据再引入 |
| 第二套任务体系（`assistant_task`） | 已有 `task.yaml` + kanban + orchestrator |
| 助理持有 delegate 的转发权 | 多跳 = 不可审计、易死循环（agent-fabric 原则 2） |
| 用 `craft-cli` 当应用内通道 | 多一个进程、一份 token、一层文本解析 |
| 助理默认能看所有会话历史 | 默认只看结论；要读历史须逐次列出/打开 |
| A2A 做对等网格 | v1 只能星形（设备是 client，不是 server）；多一种拓扑 = 多一套寻址与鉴权 |
| 记忆跨设备同步 / 合并画像 | 两份各自演化比一份合并后的第三份诚实；合并还要解冲突 |
| 离线排队（store-and-forward） | 代价是「它到底做没做」永远答不了 |
| 远端直接点名某个 workspace `/ 路径` | 路径是那台机器的事；发送方只给 hint，接收方解析 |
| 接收方再转发（depth > 1） | 不可审计、易死循环；与 worker 不得持有 delegate 同一条规则 |
| 常驻悬浮球（无状态也一直在） | 第二个托盘；无事可做的圆点只是提醒；有状态时用租约胶囊（§9） |
| 胶囊自动发送拖入的内容 | 派活会开会话、跑工具，不可逆；落到输入框等人按回车 |

---

## 8. 与 Trae 的关键分歧（评审时最该吵的五处）

1. **身份**：他们用「无路径项目」，我们用「有目录的工作区」。他们的对齐单位是数据库行，我们的对齐单位是文件——照抄会打破我们所有的路径守卫。
2. **记忆**：他们云端画像 + 本地投影（读默认关），我们本地一份文件。他们跨设备强、可编辑性零；我们反过来。
3. **摘要作业**：他们每轮跑 `extract_topics_and_update_memory`；我们不做后台作业，按需检索。他们换来「开新会话零背景交代」，代价是持续的 token 与写盘。
4. **编排位置**：他们在云侧 `orchestrate_chat`（跨设备天然、离线残废、记忆读默认关）；我们在进程内（离线可用），跨设备交给 A2A。
5. **跨设备的对象**：他们是「云端助理下发到设备」，我们是「助理委托助理」（§3.7）。我们的接收方**自己选工作区**、自定模型/凭据，并且**不能再转发**；他们那边目标由云的 project 表决定。

---

## 9. 桌面驻留面：悬浮球要不要做

### 9.1 先看两边的现状

**Trae 确实有浮窗，而且它和「无项目」是一条规则的两面**：`RegisterWindow` 的窗口类型里有一个 `floating`，而校验写的是「Agent and floating window bindings must not select a project」——浮窗不绑项目，正是因为他们那个助理本来就没有工作区。**浮窗是他们给「没地方住的助理」找的住处**，不是额外的装饰。

**Craft 已经有三个驻留面**，各自有明确职责：

| 面 | 何时在 | 已有约束 |
|---|---|---|
| 托盘 | 一直在 | 关掉所有窗口后 app 还活着的样子（[tray.md](../requirements/tray.md)） |
| 桌面控制指示器 | **只在有人租着桌面时** | `focusable:false`、随内容长、可拖、租约结束**销毁**而不是隐藏、`setContentProtection(true)`（不进截屏） |
| 浏览器浮层 | 只在浏览器任务期间 | `setAlwaysOnTop(true,'floating')` |

### 9.2 判断：**不做常驻悬浮球；做「有租约的胶囊」**

常驻球不成立的四条理由：

1. **常驻面只允许一个。** 托盘已经在，它回答「app 现在长什么样、怎么回去」。再放一个永不消失的球，就是第二个托盘，两者会互相解释不清。
2. **点击语义不成立。** Bot 是**面板**（§3.5），球点下去最终还是「打开/聚焦某个窗口」。这跟点托盘、点通知是同一件事，球的增量只有「不用去菜单栏找」。
3. **它会出现在不该出现的场合**：共享屏幕、录屏、macOS 全屏空间。桌面指示器能用，是因为它**有租约**且被排除在截屏外；一个天天都在的球只能关掉或忍着。
4. **调性不对。** 一个永不消失、又不告诉你任何事的圆点，是提醒你在等一个 AI；而 Bot 应该在**有活干时**才出现。

### 9.3 做法：Craft Bot 胶囊（lease）

直接用现成的那一套，不新发明：

- **形状是胶囊，不是球**。球只能表一个「在」，而 Bot 要表达三件事：在跑几件 / 有没有等你 / 刚刚完了什么。圆点装不下，胶囊能写字（`Craft Bot · 3 在跑`、`1 件等你`）。
- **只在有状态时出生**：有任务在跑、或有事等你决定 → 出现；全完成 → 显示一句结论 6 秒 → **销毁**（不是隐藏）。没活时它不存在。
- **窗口参数照抄 `desktop-control-indicator.ts`**：`focusable:false`、`skipTaskbar`、`transparent`、尺寸跟内容、`setAlwaysOnTop(true,'screen-saver')`、`setVisibleOnAllWorkspaces(true,{ visibleOnFullScreen:true })`、`setContentProtection(true)`。位在指针所在屏，拖过就拖过，**不跨租约记住位置**（同一个原因：别让一个陈旧的位置声称它还在）。
- **拖放才是它的杀手场景**：把文件 / 截图 / 选中的一段文字 / 一个链接拖上去 = 给 Bot 一个 brief。这比「打开 app → 找 Bot → 说」短一个数量级，也是悬浮形态唯一真正多出来的能力。
- **拖上去不自动发**：落在输入框里并聚焦，人按回车才派。派活会开会话、跑工具，不是可撤销动作。
- **点它** = 已有 Bot 面板的窗口 → 聚焦；否则最近活跃窗口；都没有 → 开一个 `assistant` 工作区的窗口。`mod+j` 仍是 app **内**的呼出，二者分工清楚（一个管不在前台时，一个管在前台时）。

### 9.4 什么时候它才值得存在

M1 不做：那时候还没有任务在跑，胶囊无事可做，做了就是装饰。放在 **M4**（与 IM 同一批「入口」），因为那时才有「后台在跑、人不在看」这个状态可言。

**验收只看一条**：没有任务时，它在不在？不该在。
