# 飞书（Lark）通道：回复不回帖的排查与修复

> 状态：**已修复**。`messaging-gateway` 240 项测试、`server-core` sessions 117 项测试全绿；`server-core` typecheck 通过。
> 范围：飞书/飞书国际版（Lark）自建应用通道的**出站回帖**可靠性，外加排查过程中暴露的 4 处静默缺陷。核心改动落在 `server-core`（会话轮次结束）与 `messaging-gateway`（网关/渲染器/飞书适配器）。
> 读法：§1 现象与根因（为什么"没回而且没日志"）；§2 三种 `responseMode` 的语义；§3 改动清单；§4 日志口径；§5 验证；§6 边界与刻意不做。
> 配套：[术语与文案规范](vocabulary.md)。

---

## 1. 现象与根因

### 1.1 现象

配置好飞书自建应用并绑定单聊后：

- **入站正常**：用户消息能被 Agent 收到并执行（长连接模式，无需公网 webhook）。
- **出站不稳定**：Agent 的回复**大部分时候不回到飞书聊天**，且 `logs/messaging-gateway.log` 里**没有 error / warn**。

同一问题在三种 `responseMode` 下表现不同：

| 模式 | 表现 |
|---|---|
| `progress`（默认） | "💭 thinking…" 气泡**永远停住**，不变成正文 |
| `final_only` | **完全静默**，什么都不发 |
| `streaming` | 能到，但一条回复**碎成多条**（工具轮次多时尤甚） |

复现：`/new` 建立绑定 → 发一条消息 → **趁这一轮还在跑再发一条**（或等飞书约 19 秒后的自动重投）→ 第 1 轮的回复不出现；日志里只有 `message_routed`，之后无任何出站记录。

### 1.2 根因（主）：`complete` 事件被消息队列抑制

会话结束时（`SessionManager.onProcessingStopped`）**只在"消息队列为空"的分支里发 `complete`**：

```js
if (managed.messageQueue.length > 0) {
  this.processNextQueuedMessage(sessionId);
} else {
  this.sendEvent({ type: "complete", sessionId, ... });   // ← 唯一的发射点
  this.emitSessionComplete({ ... });
}
```

而消息网关的**最终回复只认 `complete`**（`progress` 靠它改写气泡、`final_only` 靠它发送、`streaming` 靠它 flush）。飞书长连接会在轮次尚未结束时**重投同一条消息**（约 19 秒后），使队列在轮次结束时几乎总是非空 → 本轮 `complete` 不发 → **本轮回复不发**。

> 精确表述：不是字面意义上的"永不发出"，而是**每个"结束时队列非空"的轮次都不发**——只有队列排空的最后一轮才发一次。配合下一条（重投无去重），队列被反复填满，观感就是"永不发出"。

### 1.3 放大因素

- **重投无去重**：`Router.route` 不按 `messageId` 去重，平台重投会把同一句话再次投进会话（同一轮里被处理的同一个 `messageId` 也能反复入队）。
- **网关并发处理事件**：`MessagingGateway.onSessionEvent` 里 `renderer.handle(...)` 是 **fire-and-forget**（`.catch()` 但**不 await**）。因此修复时**只能发一次 `complete`**——两个分支都发会让每条回复**重复两遍**。

### 1.4 为什么完全查不到（三层静默）

1. 网关 Renderer **无出站日志**；`tryEditMessage` 吞掉所有非 429 异常；`ensureProgressBubble` 是空 `catch {}`。
2. 飞书适配器 `sendText` 只读 `result.data.message_id`——飞书 Node SDK 对**业务错误不抛异常**（HTTP 200 返回 `{ code, msg }`），于是被拒的发送被当成成功，无声消失。
3. **文本发送成功也不打日志**（只有卡片有 `lark_send_card_ok`）→"日志干净"导致长期误判。

---

## 2. 三种 `responseMode` 的语义

渲染器把同一串会话事件翻译成聊天消息，模式决定翻译方式（`packages/messaging-gateway/src/renderer.ts`）。三者**都依赖 `complete`**：

| 模式 | 行为 | 对 `complete` 的依赖 |
|---|---|---|
| `progress`（默认） | 首个活动起一条演进气泡：先是 "💭 thinking…"，`tool_start` 时改 "🔧 …"，`complete` 时整条替换为正文；中间文本丢弃 | 改写气泡为最终正文 |
| `final_only` | 全程静默，`complete` 时发一条累积正文；无正文则不发 | 发送 |
| `streaming`（legacy） | 边到边编辑；中间 `text_complete` 折叠进同一气泡，非中间完成收尾 | flush 未落地的缓冲 |

---

## 3. 改动清单

### 3.1 主修复：每轮无条件发一次 `complete`

`packages/server-core/src/sessions/SessionManager.ts`（`onProcessingStopped`）：

- 把 `sendEvent({ type: 'complete', ... })` **移出** `else` 分支，在**判断队列之前**、**无条件且只发一次**。
- `emitSessionComplete`（Tasks Conductor 的"真正完成"信号）**保留**在队列为空分支。

顺序为 `complete` → 判断队列 → `processNextQueuedMessage`，因此不会重复发；前端 `handleComplete` 把 `isProcessing` 置 false 后，紧随其后的 `user_message(status:'processing')` 会立即置回 true，桌面端不产生持久"空闲"闪烁。

### 3.2 附带修复（排查中暴露的静默缺陷）

| # | 问题 | 修复 | 位置 |
|---|---|---|---|
| F1 | 飞书适配器忽略 `im.message.create` / `update` / `patch` 的**业务错误码**，被拒的发送/编辑无声消失 | 新增 `larkBusinessError()` 校验非 0 `code`；`sendText` / `editMessage`（含 card patch）/`sendButtons` 命中即记日志并抛出 | `messaging-gateway/src/adapters/lark/index.ts` |
| F2 | `streaming` 模式每条 `text_complete` 都新建消息，一条回复碎成多条 | **中间** `text_complete`（`isIntermediate`，即工具轮次之间的过渡文本）折叠进同一气泡，仅编辑不新建；非中间完成仍收尾 | `messaging-gateway/src/renderer.ts`（`handleStreaming`） |
| F3 | `Router.route` 不按 `messageId` 去重，平台重投让同一句话进会话两次 | 网关入站按 `platform:channelId:threadId:messageId` 去重（有界 + TTL 5 分钟 / 上限 1000 条），在命令/路由前丢弃重投 | `messaging-gateway/src/gateway.ts`（`wireAdapter` / `isDuplicateInbound`） |
| F4 | 入站图片/附件下载报 `Cannot read properties of undefined (reading 'get')` | SDK 路径是 `im.messageResource.get`（单一命名空间），原代码写成了 `im.message.resource.get`（`undefined`） | `messaging-gateway/src/adapters/lark/index.ts`（`downloadResource`） |
| F5 | `progress` 模式最终编辑失败时无兜底，气泡永远停在 "thinking…" | `tryEditMessage` 返回布尔；`complete` 时最终编辑失败则回退「新发一条」；飞书 `editMessage` 遇业务错误/过期不再静默 return，而是抛出以触发兜底 | `messaging-gateway/src/renderer.ts`、`adapters/lark/index.ts`（`runEdit`） |

> F2 与既有注释（`streaming` 定义为 "each text_complete finalises its own message"）有取向差异：本次只**折叠中间轮次**、保留非中间完成的收尾语义。若要 `streaming` 完全维持 legacy（每条都新建），回退 F2 一处即可，其余四项不受影响。

---

## 4. 日志口径

排查此问题时新增/依赖的关键结构化日志（`event` 字段）。**文本发送成功也打日志**是修复第 3 条静默的关键：

| `event` | 级别 | 含义 |
|---|---|---|
| `lark_send_ok` | info | 飞书文本发送成功（`chatId` / `msgType` / `messageId` / `textLen`） |
| `lark_send_failed` | error | 飞书文本发送被业务错误拒绝（`larkCode` / `larkMsg`），随后抛出 |
| `lark_edit_failed` | warn | 飞书编辑被拒或抛错（`larkCode` / `larkMsg` / `expired`），随后抛出 |
| `lark_send_card_ok` / `lark_send_card_failed` | info / error | 卡片发送成功 / 失败（后者的 catch 内含文本兜底） |
| `message_duplicate_dropped` | info | 入站重投被去重丢弃（`messageId`） |
| `message_routed` | info | 入站消息已路由到会话（既有） |

---

## 5. 验证

- 回归测试（新增 6 例）：
  - `packages/messaging-gateway/src/__tests__/renderer.test.ts`：F2（中间完成折叠为单气泡）、F5（最终编辑失败回退新发）。
  - `packages/messaging-gateway/src/__tests__/lark-adapter.test.ts`：F1（业务错误码抛出并记日志、成功记 `lark_send_ok`）、F4（资源下载走 `im.messageResource.get`）。
  - `packages/messaging-gateway/src/__tests__/gateway-inbound-dedup.test.ts`：F3（相同 `messageId` 重投只路由一次；不同 id 各自路由）。
- 命令与结果：
  - `bun test packages/messaging-gateway/src` → **240 pass / 0 fail**
  - `bun test packages/server-core/src/sessions` → **117 pass / 0 fail**
  - `cd packages/server-core && bun run tsc --noEmit` → 通过
- 端到端（真机）应满足：连续多轮，每轮**恰好 1 条** `lark_send_ok`（`code=0`），且 `progress` 气泡最终变为正文、`final_only` 有且仅有一条正文。

---

## 6. 边界与刻意不做

- **不做内容级去重**：F3 只按平台 `messageId` 判定重投；用户真的发了两条内容相同的消息不会被吞。
- **不改 `responseMode` 默认值**（仍是 `progress`）。`streaming` 的 legacy 收尾语义按 §3.2 中 F2 的说明保留。
- **`streaming` + `showToolActivity` 仍会分条**：工具活动摘要本身是独立消息，这是有意可见性，不属本次收敛范围。
- **不改飞书适配器的重试/退避策略**：429 等错误现在会被记日志并上抛，交由渲染器的 `tryEditMessage` 现有退避逻辑处理，未新增策略。
