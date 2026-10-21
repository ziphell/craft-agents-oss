# 对话排队与中断 — 开发文档

> **定位**：本文写**一轮回复进行中**时，用户再次发送消息的完整交互与数据模型：它如何进入队列、在待发送区里能做什么、轮到时如何变成下一轮、以及 Stop 如何收尾。不写 agent 层的 `redirect` / 注入机制（那是一条独立的、当前不接入队列的能力），也不写会话状态机的其余部分。
>
> **一句话**：**队列里的用户消息不是轮次，只是待发送的条目；轮到时删掉它、新建一条轮次消息追加到末尾——既有消息永远不被移动，时间戳也永远不被改写。**
>
> **状态**：已实现。
>
> **读法**：§1 术语；§2 交互；§3 数据模型与不变量；§4 生命周期与事件；§5 边界与竞态；§6 代码位置；§7 取舍。

---

## 1. 术语

| 说的是 | 用 | 说明 |
|---|---|---|
| 一次用户输入到助手停下 | **轮次（turn）** | 一轮以 `complete` / 中断结束，下一轮才开始 |
| 回复中发送、尚未轮到的消息 | **排队条目**（队列条目） | 持久化在 `managed.messages` 里，带 `isQueued: true`；只出现在待发送区 |
| 轮到某个条目、开始它自己的一轮 | **出队 / 重放** | 出队后它变成一条**新的**轮次消息 |
| 结束当前轮、让某个条目成为下一轮 | **立即发送**（⚡ / Send now） | 等价于 Stop + Send，但静默，不插「Response interrupted」 |
| 用户点击停止 | **Stop** | 结束当前轮，清空队列，把文本按顺序放回输入框 |
| agent 层的 `redirect` / 注入 | **steer** | **不是**队列动作，见 §7 |

**不要**用 steer 描述这个功能。界面文案、注释和文档里，队列的行为只有「排队 / 立即发送 / Stop」三种。

---

## 2. 交互

### 2.1 回复中发送 = 排队

`managed.isProcessing` 为真时，`sendMessage` **一律入队**，不判断连接或 provider：

- 消息立刻以 `user_message status: 'queued'` 广播，并出现在待发送区。
- 当前轮不会被打断；排队的条目可以继续编辑、删除、拖动或立即发送。
- 是否「立即发送」是**每条消息上的显式动作**，不是连接的属性。

这一条是刻意的：交互行为不能因为换了 provider 就变成另一种。

### 2.2 待发送区

输入框上方的独立面板，一行一个条目，顺序就是发送顺序（FIFO）：

| 元素 | 行为 |
|---|---|
| 行首序号 `1 / 2 / 3` | **拖拽手柄**；拖动时显示插入线，松手后按新顺序发送 |
| `✎` 编辑 | 从队列移除，并把**文本**回填输入框、聚焦；附件随条目一起丢弃，不回到输入框 |
| `🗑` 删除 | 只从队列移除，**不动输入框** |
| `⚡` 立即发送 | 结束当前轮，把这条提到队首，作为下一轮发出（§2.3） |
| 标题行右侧 `⌃ / ⌄` | 收起 / 展开；收起后只占一行「已排队 · N」 |
| 标题行右侧「等到本轮结束」 | 仅展开且回复中显示，说明为什么还没发 |

补充规则：

- **拖拽按 id 追踪，不按行号**。队列会在拖动过程中继续出队，行号会整体位移；落点用「排除被拖项后的实时列表 + 目标行的 id + 指针上下半区」重新计算。
- 被拖的条目如果在拖动中正好轮到自己，行会消失、拖拽状态自动清理；松手时提示「这条消息已经开始发送」，而不是移动错行。
- 队列清空后组件卸载；下一次出现队列时默认展开。
- 只有多于一条时才能拖拽。

### 2.3 立即发送（⚡）

后端 `sendQueuedMessageNow`：

1. 若当前没有在回复 → 拒绝（`not-processing`）。
2. 若手动压缩正在进行 → 拒绝（`compacting`），条目留在队列。
3. 找到条目（规范 id 或乐观 id），从原位置取出、插到队首。
4. 广播一次队列状态，让所有窗口的待发送区先显示新顺序。
5. `interruptTurn({ silent: true })`：结束当前轮，但**不**插入「Response interrupted」气泡。

当前轮结束后，队首条目照常走 §4.2 的出队流程。排在其后的条目保持原来顺序。

**为什么不是 steer**：steer 的投递时机取决于 provider（Claude 要等下一个工具边界，没有工具调用就投递不了；Pi 是 SDK 原生边界），用户无法预知它何时生效，而且只能带文本。立即发送是确定性的：结束这一轮、下一轮就是它，附件也照常走正常发送路径。

### 2.4 Stop

Stop 是「不要再继续」，与「插队」相反：

1. 收集队列里的文本（FIFO）。
2. **清空队列**，并从持久化消息里删除这些排队条目。
3. 结束当前轮，插入「Response interrupted」。
4. 把文本按顺序回填输入框。

输入框最终内容 = **原有草稿 → 本轮正在处理的提示词 → 排队的文本（按顺序）**，段间空行分隔。只回填文本：附件不回到输入框。

---

## 3. 数据模型与不变量

### 3.1 两层表示

| 层 | 内容 |
|---|---|
| 运行时队列 `managed.messageQueue` | FIFO 的发送载荷：`message`、`attachments`、`storedAttachments`、`options`、`messageId`、`optimisticMessageId` |
| 持久化消息 `managed.messages` | 排队条目的用户消息，带 `isQueued: true`；出队时被删除 |
| 渲染层 `session.messages` | 同一份消息；`groupMessagesByTurn` 过滤掉 `role === 'user' && isQueued` 的条目 |
| 待发送区 | `session.messages.filter(m => m.role === 'user' && m.isQueued)`，顺序由 `queued_messages_state` 校正 |

`queued_messages_state` 是队列顺序的**唯一权威**：`order` 里没有的条目就不再排队。渲染层只用它校正 `isQueued` 和顺序，不用它改时间戳。

### 3.2 不变量

1. **排队条目不参与对话排序**。它被 `turn-utils` 过滤，渲染在待发送区，不在 transcript 里。
2. **出队不移动既有消息**。只做两件事：删除排队条目、追加一条新的轮次消息。历史消息、第一条消息、已发送消息都不被改写。
3. **身份只认 id**。`messageId` 或 `optimisticMessageId`，绝不按文本内容匹配。相同文本可以合法地出现多次。
4. **队列状态以后端为准**。入队、出队、删除、重排、普通发送都会广播一次 `queued_messages_state`；渲染层据此对账，避免幽灵行。
5. **时间戳只增不减**。新轮次消息取 `max(monotonic, 所有现有消息的最大时间戳 + 1)`，快速回复也不会和上一轮撞在同一毫秒。

---

## 4. 生命周期与事件

### 4.1 入队

`sendMessage` 在 `isProcessing` 时：

1. 创建用户消息（`isQueued: true`），push 进 `managed.messages`。
2. 广播 `user_message status: 'queued'`（带乐观 id）。
3. push 载荷到 `messageQueue`，广播 `queued_messages_state`。
4. 持久化并 flush，然后 ack。

### 4.2 出队

`onProcessingStopped` → `processNextQueuedMessage`：

1. `shift()` 出队首载荷。
2. **删除**对应的排队条目（按 `messageId`）。
3. 新建一条轮次消息：新 id、`role: 'user'`、内容/附件/徽标/hidden 取自载荷、时间戳取 `max(monotonic, 最新时间戳 + 1)`，**push 到消息数组末尾**。
4. 持久化。
5. 广播 `queued_message_cancelled`：让所有窗口删掉待发送区里的那一行。
6. 广播 `user_message status: 'accepted'`：新轮次消息，**不带乐观 id**（旧条目已经不存在，渲染层必须追加）。
7. 广播 `queued_messages_state`：剩余队列。
8. `setImmediate` 调 `sendMessage(..., existingMessageId: 新消息 id, options 去掉 optimisticMessageId)`，开始这一轮。

**为什么先删再加，而不是复用**：复用时必须把旧条目的时间戳从「排队那一刻」改到「本轮之后」。只要 `processing` / 状态事件丢失、id 漂移或文本重复，就会改错对象——轻则两条用户消息挨在一起，重则把第一条消息挪走。新建一条消息没有这个自由度：它天然排在末尾。

### 4.3 事件

| 事件 | 作用 |
|---|---|
| `user_message` + `status: 'queued'` | 条目入队；渲染层标记 `isQueued` |
| `user_message` + `status: 'accepted'` | 新轮次消息；渲染层追加到末尾 |
| `queued_message_cancelled` | 删除待发送区的条目（删除、编辑、出队都复用） |
| `queued_messages_state` | 权威队列顺序；校正 `isQueued` 与顺序，不改时间戳 |
| `interrupted` + `queuedMessages` | Stop：渲染层移除排队气泡，把文本回填输入框 |

### 4.4 曾经失败的做法（不要再回去）

| 做法 | 结果 |
|---|---|
| 出队时原地重打时间戳，靠 `processing` 事件同步 | 事件一丢，时间戳停在上一轮中间；多条出队后挨在回复前面 |
| 收到队列状态时，把所有「排队 → 非排队」的消息统一重打时间戳 | 已经发送的乐观消息、甚至第一条消息被挪到末尾 |
| id 对不上时按「文本 + 时间戳接近」兜底 | 重复发送同一句话时匹配到旧消息，旧消息被改写、新消息不出现 |

结论写在 §3.2：**排队条目不是轮次**，不要试图给它排序；出队时新建轮次消息。

---

## 5. 边界与竞态

| 场景 | 行为 |
|---|---|
| 回复很快，出队紧贴 `complete` | 新消息时间戳被 clamp 到「已有最大值 + 1」，严格排在上一轮回复之后 |
| 连续发送相同文本 | 只按 id 匹配；每条都是独立消息，互不覆盖 |
| 多窗口 | 队列事件广播到所有窗口；顺序以 `queued_messages_state` 为准 |
| 拖动中条目被发送 | 行消失、拖拽状态清理；松手提示「已经开始发送」，不做重排 |
| 删除 / 编辑与出队同时发生 | 后端找不到队列条目时返回 `cancelled: false`，前端 toast；孤儿排队行会被真正删除 |
| 崩溃 / 重载 | 排队条目已持久化；加载时按 transcript 顺序重建队列，空闲则 `setImmediate` 出队；重放时新建轮次消息 |
| 手动压缩中 | ⚡ 拒绝，条目留在队列；压缩结束后照常 |
| 附件 | 出队时从载荷恢复到新轮次消息，附件不丢；编辑只回填文本，附件随条目删除 |
| Stop 恢复 | 只回填文本；附件不回到输入框 |
| 隐藏消息（系统 nudge） | 可以入队，但 `hidden` 让它不渲染气泡 |

---

## 6. 代码位置

| 位置 | 内容 |
|---|---|
| [SessionManager.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts#L6633-L6675) | `sendMessage` 的排队分支：建条目、广播、入队、持久化 |
| [SessionManager.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts#L7786-L7850) | `processNextQueuedMessage`：删条目、建新轮次消息、三个事件、重放 |
| [SessionManager.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts#L7441-L7472) | `sendQueuedMessageNow`：提到队首、静默中断 |
| [SessionManager.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts#L7195-L7224) | `cancelProcessing`：Stop 收集文本、清队列、删条目 |
| [SessionManager.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts#L7232-L7290) | `interruptTurn`：Stop 与立即发送共用 |
| [SessionManager.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts#L7300-L7376) | `cancelQueuedMessage`：删除 / 编辑的移除，含 stale 行 |
| [SessionManager.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts#L7385-L7429) | `reorderQueuedMessage`：运行时队列 + 持久化顺序一起改 |
| [SessionManager.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts#L9606-L9622) | `sendQueueState`：权威队列广播 |
| [SessionManager.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts#L2090-L2109) | 崩溃 / 重载后的队列恢复 |
| [dto.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/protocol/dto.ts#L455-L470) | `queued_message_cancelled` / `queued_messages_state` 协议 |
| [turn-utils.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/ui/src/components/chat/turn-utils.ts#L369) | 过滤排队条目，不让它进入 transcript |
| [session.ts](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/event-processor/handlers/session.ts#L568-L655) | `handleUserMessage`：queued / accepted，只按 id 匹配 |
| [session.ts](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/event-processor/handlers/session.ts#L660-L721) | `handleQueuedMessagesState`：顺序与标记对账 |
| [session.ts](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/event-processor/handlers/session.ts#L335-L390) | `handleInterrupted`：移除排队气泡、回填文本 |
| [QueuedMessagesTray.tsx](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/QueuedMessagesTray.tsx) | 待发送区：拖拽、收起、四个动作 |
| [ChatDisplay.tsx](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx#L1311-L1407) | Stop、删除、编辑、立即发送、重排的调用点 |
| [midstream-queue.test.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/midstream-queue.test.ts) | 后端：入队、立即发送、删除、重排、出队新建轮次 |
| [handle-user-message.test.ts](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/event-processor/handlers/__tests__/handle-user-message.test.ts) | 前端：相同文本不覆盖、出队排在上一轮之后、状态对账 |

---

## 7. 取舍

- **不做 steer 式插队**。agent 层的 `redirect` / `PendingSteers` / `steer_undelivered` 仍然存在，但队列不调用它。将来若要做「补充到当前回复」，应当是输入框上的独立动作，并明确标注「不打断」，不要和 ⚡ 共用一个按钮。
- **编辑回到末尾**。原位编辑需要服务端支持「改完仍保持队首」，交互和数据都要多一套；当前选择是编辑 = 出队 + 回填，重新发送后排在末尾，再用拖拽调回去。
- **出队换新 id**。排队条目的 id 不会延续到轮次消息；没有外部引用依赖这个 id。
- **Stop 丢弃本轮**。不保留半截回复的继续能力；下一轮会带「上一轮被中断」的上下文提示。
- **没有暂停队列**。只有「等本轮结束」「立即发送某条」「Stop 全部」三种选择。
