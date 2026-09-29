# 思维链渲染 — 开发计划

## 0. 背景与结论

目标：把模型的思维链（thinking / reasoning）显示到聊天界面上。

**先纠正一个前提**：思维链不是"渲染坏了"，而是 craft 侧从来没有这条数据通路。经核实：

- Pi SDK 自己完整支持 thinking（流式 `thinking_start / thinking_delta / thinking_end`，消息内容里是 `{ type: 'thinking', thinking, thinkingSignature }`），并且**已经把带 signature 的 thinking block 保存进自己的 session 文件、多轮原样回传**（Anthropic / Bedrock / Gemini 的签名回传 SDK 都已实现）。这部分**不属于本计划范围**。
- Pi 后端的子进程（`packages/pi-agent-server/src/index.ts`）**已经没有白名单地原样转发**这些事件到主进程。
- 丢弃发生在 `PiEventAdapter`：`message_update` 只认 `text_delta`（[event-adapter.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/backend/pi/event-adapter.ts#L482-L497)），`extractTextFromMessage` 也只取 `type === 'text'` 的 part（[同文件 L994-L1014](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/backend/pi/event-adapter.ts#L994-L1014)）。Claude 后端同理（[claude/event-adapter.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/backend/claude/event-adapter.ts#L324-L331)）。
- UI 侧 `ActivityType` 里那个 `'thinking'` 是**死类型**，全仓库没有任何生产者（`packages/ui/src/components/chat/TurnCard.tsx:220` 只有声明，`turn-utils.ts` 只产出 `tool / status / plan / intermediate`）。

所以本计划做的事是：**把 SDK 已有的 thinking 事件捞出来，走一条独立通道，落到会话文件，在活动列表里按序展示**。

### 影响面

| 端 | 是否受影响 |
|---|---|
| Electron 桌面 | 是（主战场） |
| WebUI | 是（直接复用 Electron renderer） |
| Viewer（只读分享页） | 是（复用 `SessionViewer` → `TurnCard`） |
| TurnRail（右侧回合导航） | 是（依赖 `getPreviewText`） |
| messaging-gateway（Lark / Telegram / WhatsApp） | **必须不受影响**（见 D3） |
| CLI | **必须不受影响** |

## 1. 非目标

- 不改 SDK 的 thinking 保存与回传；**不把思维链加进发给模型的消息**（回传由 SDK 负责，craft 的 `session.jsonl` 只用于展示与回放）。
- 不动 `.pi-sessions` / Claude SDK 的 session 文件。
- 不新增 RPC 频道（沿用 `sessions.EVENT`）。
- 阶段一只接 Pi 后端，Claude 放到阶段六。

## 2. 核心设计决策

### D1 独立事件类型，不复用 `text_delta`

新增 `thinking_delta` / `thinking_complete` 两条事件，而不是给 `text_delta` 加 `isThinking` 标记。

**理由（硬性）**：messaging-gateway 与 CLI 对事件的类型是宽松的（`type: string`，不认识的事件会被静默忽略），但它们的"最终文本"筛选只看 `isIntermediate`（`packages/messaging-gateway/src/renderer.ts:450-460`、`554-560`）。若复用 `text_delta`，思维链会被 IM 端当成正文发给用户。独立事件是隔离的必要条件。

事件形状（与 `text_delta` / `text_complete` 对称）：

```
{ type: 'thinking_delta';    text: string; turnId?: string; parentToolUseId?: string; blockId?: string }
{ type: 'thinking_complete'; text: string; turnId?: string; parentToolUseId?: string; blockId?: string; sdkMessageId?: string }
```

`blockId` 标识"一段思考"（Pi 用 `assistantMessageEvent.contentIndex` + `turnId` 组合，Claude 用 `content_block` 的 index）。同一段内的 delta 归到同一条消息。

### D2 粒度：一段思考 = 一条消息 = 一个活动，按时间序与工具调用交错

这是本轮讨论的核心问题——**每轮工具调用前可能都有一次思考**。处理方式：

- **不合并成一整段**。模型的思考天然发生在"某次工具调用之前/之间"，SDK 也是分段给的。我们按段处理：一次 `thinking_delta` 序列累积成一条 streaming 消息，`thinking_complete` 定稿。
- **顺序天然正确**。`groupMessagesByTurn` 是按 `session.messages` 的数组顺序把 activity 依次 push 的（[turn-utils.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/ui/src/components/chat/turn-utils.ts#L575-L619)），所以一段思考会正好落在它前后的工具调用之间，不需要额外排序字段。
- **一段的边界**用 `blockId`（`contentIndex`），不靠"类型切换"推断——Pi 文档明确 thinking 帧与 text / toolcall 帧**可能交错**，必须用 `contentIndex` 关联。
- 一轮里可能出现多次：`thinking → tool → thinking → tool → thinking → 最终正文`。落盘后就是同一 `turnId` 下的多条 `isThinking` 消息 + 工具消息，按序排列。

### D3 落盘：复用 `isIntermediate` 语义（关键）

落盘的 thinking 消息写成：

```ts
{ role: 'assistant', content, isIntermediate: true, isThinking: true, turnId, parentToolUseId }
```

**为什么借用 `isIntermediate`**：仓库里所有"这不是最终回答"的筛选都是 `!m.isIntermediate`——`SessionManager` 有 6 处（`3451 / 3463 / 3476 / 5549-5556 / 5734 / 6737 / 9236` 附近）、`jsonl.ts:210` 的 `extractLastFinalMessageId`、messaging-gateway 的最终文本筛选。让思维链带上 `isIntermediate: true`，这些逻辑**自动**把它排除在外，不会污染：IM 正文、CLI 输出、会话标题/预览、未读判定、摘要压缩。

`isThinking: true` 是新增字段，只用于 UI 与回放时区分"这段是推理"还是"这段是给用户看的中间评论"。

落盘路径无需新增机制：`messageToStored` 用 rest 展开会自动带上新字段（`packages/core/src/types/message-mapper.ts:10`），JSONL 直接透传；读回后 `storedToMessage` 还原。

### D4 呈现：每段一行、默认收起、点开看全文

- `turn-utils.ts` 在 intermediate 分支之前先判 `message.isThinking` → 产出 `type: 'thinking'` 的 `ActivityItem`（复用现有的 depth / parentId 计算）。
- `TurnCard` 的 `ActivityRow` 新增 `thinking` 分支：收起态显示一行摘要（图标 + "Thinking · 12s" 或首行文本），点击展开全文；长文本走现有 activity 详情通道（`extractOverlayData` 对无 `toolName` 的 activity 会兜底到 generic → markdown，Electron 与 Viewer 都已支持，无需新造 overlay）。
- 因为每段自成一行的可折叠块，多段思考不会把界面撑爆。

### D5 相位与指示器

`deriveTurnPhase` 目前只把 `tool && running` 判为 `tool_active`（[turn-utils.ts:142-171](file:///c:/Users/Ryan/code/craft-agents-oss/packages/ui/src/components/chat/turn-utils.ts#L142-L171)）。thinking 运行中会在活动列表里显示自己的行（自带 spinner），**不再额外触发全局 "Thinking…" 指示**，避免和工具 spinner 抢语义。

## 3. 改动清单（按数据流，阶段一）

### 阶段 1 — 类型与协议

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/core/src/types/message.ts` | `AgentEvent` L549-589 | 加 `thinking_delta` / `thinking_complete` |
| 同上 | `Message` L251-338 | 加 `isThinking?: boolean` |
| 同上 | `StoredMessage` L344-419 | 加 `isThinking?: boolean` |
| `packages/shared/src/protocol/dto.ts` | `SessionEvent` L385-437 | 加对应两条（带 `sessionId`） |
| `apps/electron/src/renderer/event-processor/types.ts` | L34-55、L530-577 | 加事件接口并入 `AgentEvent` |

### 阶段 2 — Pi 产出

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/shared/src/agent/backend/pi/event-adapter.ts` | `message_update` L482-497 | 加 `amEvent.type === 'thinking_delta'` 分支，yield `thinking_delta` |
| 同上 | L994-1014 旁 | 新增 `extractThinkingFromMessage`，用于 `thinking_end` / `message_end` 定稿（fallback 链与 text 一致） |
| 同上 | 重试路径 | 未定稿的 thinking 要能在 `text_discard` 时一起丢弃 |

### 阶段 3 — 服务端落盘 + 下发

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/server-core/src/sessions/SessionManager.ts` | `processEvent` L8194 | 加 case：构造 `Message`（D3 形状）→ `managed.messages.push` → `sendEvent` → `persistSession`（参照 `text_complete` 分支 L8223-8281） |
| 同上 | L9037 附近 | 若沿用 delta 批处理（`queueDelta`），为 thinking 加对应累积，避免高频刷屏 |

### 阶段 4 — 渲染进程

| 文件 | 位置 | 改动 |
|---|---|---|
| `apps/electron/src/renderer/event-processor/handlers/text.ts` | L37-162 | 新增 `handleThinkingDelta` / `handleThinkingComplete` |
| `apps/electron/src/renderer/event-processor/helpers.ts` | — | 加 `findThinkingMessage`（按 `turnId` + `blockId`） |
| `apps/electron/src/renderer/event-processor/processor.ts` | L16 / L66 / L239 | import + case（L239 是 `never` 穷尽检查，缺 case 会**编译失败**） |

### 阶段 5 — UI

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/ui/src/components/chat/turn-utils.ts` | L575-619 之前 | 先判 `isThinking` → `type: 'thinking'` |
| `packages/ui/src/components/chat/TurnCard.tsx` | L902-956 之前 | `ActivityRow` 新增 `thinking` 分支；清理 L990 的死回退 |
| 同上 | `hasNoMeaningfulWork` L2916-2930 | `thinking` 有内容即算有意义（否则"只有思考"的 turn 会被整段隐藏） |
| 同上 | `getPreviewText` L715-779 | 可选：折叠头预览显示最新一段思考 |
| `packages/shared/src/i18n/locales/*.json` | — | 新增文案键（"Thinking"、时长等），不要硬编码 |

### 阶段 6 — Claude 后端（后续）

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/shared/src/agent/backend/claude/event-adapter.ts` | L324 | `content_block_delta` 加 `delta.type === 'thinking_delta'` 分支 |
| 同上 | L331 | `content_block_start` 加 `content_block.type === 'thinking'` |
| 同上 | `adaptAssistant` L257-261 | 完整消息里加 `block.type === 'thinking'` 提取 |

## 4. 必须同步的镜像结构（漏改 = 编译失败或行为不一致）

1. **两套平行事件联合**：`packages/core` 的 `AgentEvent`（L549）与 `packages/shared/protocol` 的 `SessionEvent`（L385）——各自独立维护，必须同时加。
2. **两处 switch 镜像**：`SessionManager.processEvent`（L8194）与 renderer `processor.ts`（L66）。后者有 `never` 穷尽检查，漏 case **直接编译报错**。
3. **`Message` ↔ `StoredMessage`**（L251 / L344）+ `message-mapper.ts`。
4. **宽松类型的消费者（不会编译报错，必须人工确认）**：`packages/messaging-gateway/src/renderer.ts`、`apps/cli/src/index.ts`。确认思维链不会进 IM / CLI。
5. **多端复用**：Electron、WebUI、Viewer、TurnRail 都要回归。

## 5. 风险与坑

- **思维链泄漏到 IM / CLI / 标题 / 未读** —— 靠 D3 的 `isIntermediate: true` 复用 + 回归测试兜住。这是最大的一条。
- **redacted thinking**：Anthropic 某些模型只回 signature，`thinking` 为空。UI 要优雅处理（显示"思考内容不可见"或直接跳过），不能渲染成空行。
- **重试 / 中断**：未定稿的 thinking 要跟 `text_discard` 一起清掉，否则会留下半段。
- **子代理**：Task / subagent 内部的思考带 `parentToolUseId`，走现有嵌套深度逻辑。
- **交错**：thinking 帧与 text / toolcall 帧可能交错，必须用 `blockId`（`contentIndex`）关联，不要假设类型顺序。
- **会话文件变大 + 分享可见**：思考文本会落进 `session.jsonl`，Viewer 分享页也能看到（已确认接受）。

## 6. 验证方式

- 单测：`pi-event-adapter.test.ts`（事件映射）、`session-event-message-parity.test.ts`（主进程与渲染端建消息字段一致）、`turn-phase.test.ts` / `turn-lifecycle.test.ts`（相位与分组）。
- Playground：`apps/electron/src/renderer/playground/registry/turn-card.tsx` 加 thinking 活动样例，先验证 UI 再验证真实链路。
- 手动（Pi 后端，开思考档位，跑一个多工具任务）：
  1. 每段思考是否落在对应工具调用之前 / 之间；
  2. 运行中行有 spinner，完成后可展开看全文；
  3. 刷新 / 重开会话，思考仍在；
  4. Viewer 分享页能正常显示；
  5. **IM（Lark 等）与 CLI 输出里不出现思考文本**。

## 7. 待你拍板

- 折叠头摘要文案（"Thinking · 12s"？首行文本？）
- 是否显示 token 计数 / 思考时长
- 落盘的 thinking 是否要在"导出会话 / 分享"时提供一个开关（默认带出还是默认剥掉）
