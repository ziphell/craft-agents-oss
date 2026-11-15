# Craft Agent Fabric — 远程调度设备上的 Agent

> 状态：草案 v0.10（设计评审用，未实现）
> 核心场景：**hub 把一段工作交给一台设备上一个 workspace 的 agent；agent 在它自己的
> workspace 里执行，把最终文本和 artifact 交回来。**
> 不在本文：窗口 / WebUI / CLI 与 hub 之间的全量 RPC（见 [remote-connections.md](./remote-connections.md)）；
> device 原语（exec / fs / browser）沿用现有链路，只作为兜底。

---

## 0. 结论

```text
Hub（编排） ──delegate:invoke(agent)──► 设备 App（执行）
  DAG / 审计                         Agent = workspace 的 worker 身份
                                     instructions: AGENTS.md
                                     defaults: workspace config
        ◄──── 最终文本 + artifacts ────
```

四条规则：

1. **hub 只编排，设备上的 app 执行。** 模型、凭据、工具、完整历史都在设备侧。
2. **agent 不能持有 delegate 工具。** delegate 只出现在 orchestrator 的工具目录里；worker agent
   的工具目录在 session 创建时生成，并在启动时断言不含任何 delegate 类工具。这条同时消除自指
   和死循环，不依赖运行时的链检查。
3. **一个 workspace 一个 agent。** `agentId = deviceId/workspaceId`；本地同 device 可以简写为
   `workspaceId`。agent 不是独立存储：它就是 workspace 的 worker 身份。
4. **契约只有 5 个通道。** 没有 budget、limits、outputs、interaction、memory、scope、
   per-agent 配置、per-delegate workingDirectory。

明确删掉的东西：

| 删掉 | 原因 |
|---|---|
| 独立的 agent 配置 / `agents/` 目录 | 一个 workspace 一个 agent，配置就是 workspace 的配置 |
| 多 agent / agent scope / project 绑定 | 维护成本高；要不同行为就再建一个 workspace |
| budget / limits | 设备侧自己限流，忙就返回 `UNAVAILABLE` |
| outputs 白名单 | 只回最终文本 + artifact |
| interaction / unattended | 审批只看 hub；没有设备侧交互 |
| delegation chain / depth | 不做多跳 |
| agent memory | instructions 来自 `AGENTS.md` |
| per-delegate workingDirectory / 授权目录 | cwd 来自连接层或 workspace 配置；本次连接层不做 |
| 设备侧审批 / approval-request | 审批只看 hub；设备侧不弹审批 |
| AgentSummary 里的 models / requires | 执行侧自己决定，hub 不需要按模型/条件选 |

**代价**：同一个 workspace 不能有两个不同人格的 agent。需要 reviewer / fixer 两种行为，
就建两个 workspace；这是有意换来的简单。

---

## 1. 背景与范围

今天 hub 能碰到设备，但碰不到设备上的 worker：

```text
Window ──view link──► Hub     全量 RPC
App    ──device link─► Hub     client:device:exec / fs / browser（原语）
```

设备上已经具备一个 worker 所需的全部材料：

- workspace 的 `config.defaults`（model / permissionMode / browserProfile / thinkingLevel）；
- workspace 目录里的 sources / skills；
- 工作区的 `AGENTS.md` / `CLAUDE.md`（system prompt 自动注入）；
- 项目文件夹里的 goal / spec / plan 与 `MEMORY.md`；
- 凭据、工具、历史。

缺的只是一个**可命名、可授权、可调用的 worker 身份**，以及一条“把任务交给它并拿回结果”的通道。
本文只覆盖这条通道。

---

## 2. 原则

1. **Two planes.** hub 编排，设备 app 执行。
2. **No delegation in workers.** worker 的工具目录不含 delegate；只有 orchestrator 有。
3. **One workspace, one agent.** agent 是 workspace 的 worker 身份，不是独立实体。
4. **Approval stays on the caller.** 审批不跨设备；hub 在委派前按自己的策略决定。设备侧不弹审批，
   受限工具直接拒绝（`PERMISSION_DENIED`）。
5. **Execution side owns model, credentials, history.** 设备侧不把 key 或完整历史交给 hub。
6. **Explicit target.** 没有默认 target；本地用 workspaceId，远端用 deviceId/workspaceId。
7. **Default deny.** 没有 grant 就没有远端调用。
8. **Events first-class.** 长任务可观察、可取消、可恢复。
9. **Small contract.** 五个通道，一个任务，一个结果。
10. **Product hides the fabric.** 用户看到的是「我的设备 / 我的 workspace」，不是通道和字段。

---

## 3. 概念

| 概念 | 定义 | 例子 |
|---|---|---|
| **Device** | 一个运行 Craft Agent app 的机器；`deviceId` 是稳定标识 | `macbook-ryan` |
| **Hub** | 编排侧；它本身也是一个 device，但只暴露编排身份 | 办公室 Mac mini |
| **Workspace** | 文件、sources、skills、权限、默认配置的边界 | `mobile-app` |
| **Project** | workspace 内的一段工作与项目记忆 | `Q4 release` |
| **Agent** | workspace 的 worker 身份；一个 workspace 一个 | `mobile-app` |
| **AgentId** | `deviceId/workspaceId`；本地同 device 可简写 `workspaceId` | `macbook-ryan/ws-mobile` |
| **Conversation** | 设备侧的一段连续上下文；`conversationId` | `conv-1` |
| **Task** | 一次 `DelegateRequest`；conversation 的一个 turn | `task-1` |
| **Session** | conversation 的设备侧实现；一个 conversation 一个 session | 一个 chat |
| **Grant** | 后台授权：某 hub 可以调用某 workspace 的 agent | 见 §5 |

```text
Hub ──delegate:invoke(agentId, prompt, cwd?)──► Agent = Workspace
                                                   │
                                                   ├── Session ──► 最终文本 + artifacts
                                                   │
                                                   └── events ──► Hub
```

规则：

- **agent 就是 workspace**：指令来自 `AGENTS.md`，默认配置来自 `WorkspaceConfig.defaults`，
  能力来自 workspace 的 sources / skills。
- **session 只有一个父对象**：agent。
- **Parent / Child**：hub 是 parent；设备侧的 conversation / session 是 child。parent 只记
  `conversationId` + `taskId` + 最终结果，不复制 child 的历史。
- **agent 不能有 delegate 工具**：worker 的工具目录在 session 创建时生成并断言。

---

## 4. 契约

### 4.1 通道

| 通道 | 方向 | 语义 |
|---|---|---|
| `delegate:list` | hub → device | 返回这个 hub 可以调用的 workspace agent 列表 |
| `delegate:invoke` | hub → device | 提交一个任务，返回 `{ taskId, state }` |
| `delegate:get` | hub → device | 查任务状态与结果 |
| `delegate:cancel` | hub → device | 取消任务 |
| `delegate:event` | device → hub | progress / artifact / terminal |

本地 in-process 调用不走这些通道；它复用同一个 `DelegateRequest`，由 `LocalAgentExecutor` 执行。
远端只是这份 request 的线上绑定（`delegate:invoke`）。

### 4.2 Envelope

```ts
type Envelope =
  | { id: string; type: 'request'; channel: string; args: unknown[]; meta: Meta }
  | { id: string; type: 'response'; ok: true; result: unknown; meta: Meta }
  | { id: string; type: 'response'; ok: false; error: RpcError; meta: Meta }
  | { id: string; type: 'event'; channel: 'delegate:event'; seq: number; payload: AppEvent; meta: Meta }

interface Meta {
  requestId: string        // 幂等键
  principalId: string      // hub 的 deviceId
}
```

握手：

```ts
{
  protocolVersion: '1.0',
  deviceInfo: { deviceId, name, platform, version },
  capabilities: ['agent:delegate'],
  contractVersion: '1.0'
}
```

### 4.3 AgentDirectory（`delegate:list`）

```ts
interface AgentDirectory {
  deviceId: string
  name: string
  platform: string
  version: string
  agents: AgentSummary[]       // 只列有 grant 的 worker；orchestrator 不出现
}

interface AgentSummary {
  agentId: string              // deviceId/workspaceId
  name: string                 // workspace 名
}
```

规则：

- 只列**有 grant 的 workspace agent**；未授权的不出现。
- 不暴露 instructions、模型、凭据。
- 本地 UI 直接用 workspace 列表；AgentDirectory 是给远端 hub 的视图。

### 4.4 Task（`delegate:invoke` / local delegate）

同一份 `DelegateRequest` 既用于本地 in-process，也用于远端 `delegate:invoke`。

```ts
interface DelegateRequest {
  /** 本地同 device：workspaceId；远端：deviceId/workspaceId */
  agentId: string
  prompt: string
  /** 省略 = 新 conversation；传入 = 续接同一个 conversation */
  conversationId?: string
}

interface DelegateResult {
  taskId: string
  conversationId: string
  state: TaskState
  /** 本次实际使用的目录；连接层/workspace 都没配置时为空 */
  workingDirectory?: string
}

type TaskState =
  | 'queued' | 'running'
  | 'completed' | 'failed' | 'canceled'
```

规则：

- **缺 `agentId` → `AGENT_REQUIRED`；不存在或未授权 → `AGENT_NOT_FOUND` / `CAPABILITY_DENIED`。**
- **本地**：`agentId` 是 `workspaceId`；跨 device 才需要完全限定。
- **远端**：必须 `deviceId/workspaceId`；裸 `workspaceId` → `AGENT_ID_NOT_QUALIFIED`。
- **本地不需要 grant**；远端按 `(principalId, agentId)` 找 grant。
- **conversation**：省略 `conversationId` = 新建 child session；传入 = 复用同一个 child session，
  **不新建**。conversation 绑定 `(principalId, agentId)`；未知/过期/别人的 →
  `CONVERSATION_NOT_FOUND`。
- **每个 task 是一个 turn**：有自己的 `prompt` 和 `requestId`；conversation 的历史连续累积。
- **同一 conversation 一次只有一个未结束的 turn**：并发 invoke → `TASK_CONFLICT`。
- **远端没有 projectId 参数**：project 只是 cwd 下的目录；如果 workspace 配置的 cwd 落在
  某个 project 目录，执行侧按路径注入 project memory。
- **远端同一 `Meta.requestId` 重复提交返回同一 `taskId`。**
- 没有 budget、outputs、interaction、workingDirectory。cwd 来自连接层或 workspace 配置；
  未配置就为空。hub 的节点超时是本地策略，通过 `delegate:cancel` 传播。

### 4.5 结果（`delegate:get` / terminal）

```ts
interface TaskView {
  taskId: string
  conversationId: string
  state: TaskState
  result?: { text: string; artifacts: ArtifactRef[] }
  error?: RpcError
}
```

- `completed` 时带 `result`；`failed` 时带 `error`。
- `artifacts` 是执行侧生成的引用；hub 按引用来取。
- transcript 不传（opaque execution）。

### 4.6 事件（`delegate:event`）

```ts
type AppEvent =
  | { type: 'progress'; taskId: string; message?: string }
  | { type: 'delta'; taskId: string; text: string }
  | { type: 'artifact'; taskId: string; name: string; ref: ArtifactRef }
  | { type: 'terminal'; taskId: string; state: 'completed' | 'failed' | 'canceled'; result?: { text: string; artifacts: ArtifactRef[] }; error?: RpcError }
```

- 带 `seq`；断线按 `lastSeq` 补发。
- **`delta` 只承载助手可见的最终回答**，不流 tool I/O，保持 opaque execution。
- `delta` 是 best-effort：可合并、可丢弃；`terminal.result.text` 才是权威全文。
- 断线补不齐 `delta` 时，等 `terminal` 或 `delegate:get` 取全文。
- 设备侧不弹审批；受限工具直接 `PERMISSION_DENIED`，由任务以 `failed` 结束。

### 4.7 状态机

| 状态 | DAG |
|---|---|
| `queued` / `running` | running |
| `completed` | done |
| `failed` | failed |
| `canceled` | cancelled |

### 4.8 错误

```ts
interface RpcError {
  code: string
  message: string
  retryable: boolean
}
```

- 缺 agent → `AGENT_REQUIRED`
- workspace / agent 不存在或未授权 → `AGENT_NOT_FOUND` / `CAPABILITY_DENIED`
- 远端传了裸 workspaceId → `AGENT_ID_NOT_QUALIFIED`
- conversation 未知 / 过期 / 不属于该 hub → `CONVERSATION_NOT_FOUND`
- 同一 conversation 已有 task 在跑 → `TASK_CONFLICT`
- 目录不存在 → `SCOPE_NOT_FOUND`
- 设备侧策略拒绝工具 → `PERMISSION_DENIED`
- device 离线 → `UNAVAILABLE`
- 任务已在执行 → `TASK_CONFLICT`
- 任务不存在 → `TASK_NOT_FOUND`
- 设备中途退出 → `EXECUTOR_LOST`
- 版本不匹配 → `CONTRACT_VERSION_UNSUPPORTED`

### 4.9 与 Responses API 的对应

| Responses API | Craft |
|---|---|
| `previous_response_id` | `conversationId` |
| response id | `taskId` |
| streaming events | `delta` / `artifact` / `terminal` |
| background | 异步 task |
| cancel | `delegate:cancel` |
| `store` | 设备侧拥有历史；没有 store 开关 |
| output items | 最终文本 + artifacts；不流 tool I/O |

借：续接、流式事件、异步任务、幂等。
不借：item 级 tool 输出、`store` 开关、复杂的 response 对象。

---

## 5. 授权

```ts
interface Grant {
  id: string
  issuer: string              // 设备用户
  subject: string             // hub 的 deviceId
  agentId: string             // deviceId/workspaceId
  enabled: boolean
  expiresAt?: number
  revokedAt?: number
}
```

规则：

- **grant 只约束远端 hub**；本地 in-process 调用不需要 grant。
- **`(subject, agentId)` 唯一**：一个 hub 对一个 workspace 只有一条有效 grant。
- **conversation 归属**：一个 conversation 绑定 `(subject, agentId)`；设备侧每次 invoke 都校验。
  别的 hub 拿到 id 也不能续接 → `CONVERSATION_NOT_FOUND`。本地调用按 workspace 归属，
  不按 view / principal 限制。
- **默认拒绝**：没有 enabled 且未撤销的 grant → `CAPABILITY_DENIED`。
- **审批不跨设备**：hub 在委派前按自己的策略决定；设备侧不弹审批，受限工具直接
  `PERMISSION_DENIED`。
- 撤销 / 禁用后 agent 从 AgentDirectory 消失，正在跑的任务标 `canceled`。

---

## 6. 执行侧（设备 app）

### 6.1 收到 `delegate:invoke` 之后

1. 远端：按 `(principalId, agentId)` 找 grant，没有 → `CAPABILITY_DENIED`；
   本地：调用方是 human / view / 本机 orchestrator，不需要 grant。
2. 解析 `agentId` 到 workspace；不存在 → `AGENT_NOT_FOUND`。
3. 解析 conversation：传了 `conversationId` → 载入并校验归属，**复用该 child session，不新建**
   （远端按 `principalId + agentId`，本地按 workspace；未知/过期/别人的 →
   `CONVERSATION_NOT_FOUND`）；没传 → 新建 child session，生成 `conversationId`。
4. 确定 cwd：连接层配置（本次不做）`??` `workspace.defaults.workingDirectory`；
   两者都没有就不设 cwd。
5. 在 child session 上创建本次 turn：`deviceId`、`agentId`、`workspaceId`、`workingDirectory?`、
   `role = worker`。同一 conversation 已有未结束的 turn → `TASK_CONFLICT`。
6. 注入 workspace 的 `AGENTS.md` / `CLAUDE.md`；按 `WorkspaceConfig.defaults` 和 sources / skills
   组工具目录。**启动时断言：工具目录不含任何 delegate 类工具。**
7. 运行；发 `progress` / `delta` / `artifact` / `terminal`。
8. 结束：返回最终文本 + artifacts。

### 6.2 Agent 就是 workspace

**不新增存储，也没有 `agent.json`。** agent 的每一个部分都来自 workspace：

| 组成 | 来源 |
|---|---|
| 身份 / 名字 | workspace `id` / `name` |
| 指令 | workspace 的 `AGENTS.md` / `CLAUDE.md`（现有 system prompt 机制） |
| 模型 / LLM 连接 / 思考级别 | `WorkspaceConfig.defaults` |
| 权限模式 | `WorkspaceConfig.defaults.permissionMode` |
| 浏览器 profile | `WorkspaceConfig.defaults.browserProfile` |
| sources / skills | workspace 目录 |
| 工具开关 / 策略 | app 级 settings |

- **没有 memory**：跨会话的项目知识进 `projects/<slug>/MEMORY.md`；workspace 级规则进 `AGENTS.md`。
- **没有 workingDirectory**：cwd 来自连接层或 workspace 配置；本次连接层不做，未配置则 session 无 cwd。
- **没有 delegate 工具**：配置里写了也拒绝保存/启动。
- 要不同的人格或配置，就再建一个 workspace；不在同一个 workspace 里做多 agent。

### 6.3 工作目录

- `cwd = 连接层配置（本次不做）?? workspace.defaults.workingDirectory`；两者都没有就**不设 cwd**，
  和当前 session 可以没有工作目录一致。
- 不由 delegate 传，也不做远端路径授权。
- **cwd 落在某个 project 的目录时**，执行侧按该 project 注入 project memory；
  否则只用 workspace 级上下文。
- 工作目录不是写权限边界；写权限仍由 permissions / `allowedWritePaths` 与项目文件夹规则决定。
- cwd 指向不存在的目录 → `SCOPE_NOT_FOUND`。

### 6.4 历史

- 完整 transcript、工具调用、历史只留在设备侧。
- conversation 的上下文只留在设备侧；hub 只持有 `conversationId`，不拿 transcript。
- 同一 conversation 的多轮 turn 共享 child session 的历史；不同 conversation 的历史隔离，
  但共享同一个 workspace 的能力与权限。
- `prompt` 是本次 turn 的任务契约，不是父 transcript 的复制；父侧要补充上下文就拼进 `prompt`。
- hub 只记 `conversationId` + `taskId` + 最终结果，不复制 child 的 tape / history。
- 设备侧不弹审批；受限工具直接 `PERMISSION_DENIED`，任务以 `failed` 结束。
- 设备侧可以主动 `failed` / `canceled`；hub 不能绕过。

---

## 7. 编排侧（hub）

### 7.1 Node target

```yaml
- id: e2e
  target:
    device: macbook-ryan
    agent: macbook-ryan/ws-mobile          # 远端：deviceId/workspaceId
  prompt: "跑 e2e，失败就修"
```

- 本地 agent 省略 `device`，`agent` 直接写 `workspaceId`。
- 没有 `executor.kind`，没有 budget / outputs / interaction。

### 7.2 选择规则

- 没有端侧依赖 → 本地 workspace 的 agent。
- 需要端侧条件（真实仓库、网络、硬件、浏览器、人在场）→ 远端 workspace 的 agent。
- 目标 agent 必须出现在 AgentDirectory 里；不在就失败，不静默换。
- 远端节点沿用 hub 的 DAG 审批：批准后才 `delegate:invoke`；dispatch 后设备侧不再弹审批。
- 没有可用 agent → 任务失败；device 原语只作为遗留兜底，不在本文契约里。

### 7.3 AgentExecutor

```ts
interface AgentExecutor {
  start(request: DelegateRequest, target: TargetRef): Promise<{ taskId: string }>
  get(taskId: string): Promise<TaskView>
  cancel(taskId: string): Promise<void>
  onEvent(taskId: string, cb: (event: AppEvent) => void): () => void
}
```

- `LocalAgentExecutor`：in-process，复用 `createSession`。
- `RemoteAgentExecutor`：`delegate:invoke` / `delegate:get` / `delegate:cancel` / `delegate:event`。
- 两条路径都走同一个 `handleNodeCompletion`。

### 7.4 Mirror session

- 远端任务在看板上有一个本地锚点：`role = 'mirror'`、`ownerDeviceId = 远端`、`remoteTaskId`。
- 不跑本地 agent，不拥有历史；点击打开远端视图。

### 7.5 失败与重试

- 超时 / `cancel` 传播到设备侧；设备侧确认后才算取消。
- `retry` 创建新 task；`requestId` 必须换新。
- 设备离线：任务标 `unknown`，不假装完成；重连后按 `taskId` 对账。
- 不做 token budget；设备侧自己限流，忙就 `UNAVAILABLE`。

---

## 8. 拓扑与事件

| 链路 | 方向 | 承载 | 生命周期 |
|---|---|---|---|
| **view link** | 窗口 → hub | 全量 RPC | 跟随视图 |
| **agent link**（新增） | 设备 app → hub | `delegate:*` 五通道 | 跟随 grant，不跟随窗口 |
| **device link**（遗留） | 设备 app → hub | exec / fs / browser | 跟随保存的服务器 |

- 一条 agent link 可以承载多个 grant；连接复用，授权不复用。
- 只转发 `delegate:*` 五通道，不做 `sessions:*` 通配。
- 必须带 `agentId`；不做多跳。
- 每条 link 一套事件 `seq` 与缓冲；断线按 `lastSeq` 补发；`delta` 补不齐就等 `terminal` 或
  `delegate:get` 取全文。
- 慢消费者丢 `progress` / `delta`，不丢 `terminal` / `artifact`。

---

## 9. 安全

- **自指 / 死循环**：worker 的工具目录不含 delegate；启动时断言，配置里写了也拒绝。
  orchestrator 是唯一持有 delegate 的会话，且不出现在 AgentDirectory。
- **原始 RPC 不暴露**：只有五个通道；`sessions:*` / `file:*` / `settings:*` 不上线。
- **远端只接受完全限定 id**：裸 workspaceId 在 `delegate:invoke` 上返回 `AGENT_ID_NOT_QUALIFIED`。
- **授权**：grant；保存服务器 ≠ 授权 workspace。
- **conversation 隔离**：绑定 `(subject, agentId)`；跨 hub 续接一律 `CONVERSATION_NOT_FOUND`。
  同一 conversation 多轮连续；不同 conversation 不共享历史（但共享 workspace 能力）。
- **流式**：`delta` 只含助手可见回答，不含 tool 参数/结果。
- **审批**：不跨设备；hub 在委派前决定，设备侧不弹审批。
- **历史**：完整过程留在设备侧；hub 只拿最终文本 + artifacts。
- **cwd**：不由远端传；只来自连接层或 workspace 配置。

---

## 10. 可观测性与迁移

每条链路记录：

```text
requestId, principalId, taskId, conversationId,
deviceId, agentId, workspaceId,
workingDirectory?, state, errorCode
```

- **audit log**（设备侧）：谁在什么 grant 下、调用哪个 workspace、在哪个目录、做了什么。
- **run log**（hub 侧）：node 状态、重试、artifact 引用。
- 两端用 `taskId` 对齐。

迁移：

- **没有 agent 存储要迁移**：每个 workspace 天然就是一个 agent。
- 旧 session 不需要回填 agentId；需要时用 `deviceId/workspaceId` 表示。
- 现有 session / workspace / project 数据不改。
- device 原语链路保留，不进入本文契约。

---

## 11. 路线

### P0 — 目录与授权

- `delegate:list` + AgentDirectory（workspace 即 agent）。
- grant UI：per-workspace、`enabled`。
- **启动断言：worker 工具目录不含 delegate。**
- 验收：hub 能看到设备上被授权的 workspace，但还不能调用。

### P1 — 最小闭环

- `delegate:invoke / get / cancel / event`。
- `LocalAgentExecutor` + `RemoteAgentExecutor`。
- `conversationId` + `delta` 流式输出。
- mirror session。
- 验收：第二次 delegate 用 `conversationId` 续上；`delta` 可流式显示，最终文本一致。

### P2 — 对账与撤销

- 取消 / 超时 / 断线对账。
- 撤销 / 禁用 grant；正在跑的任务标 `canceled`。
- conversation 过期清理（TTL 由设备侧定）。
- 验收：撤销后 workspace 从 AgentDirectory 消失；断线后按 `taskId` 对账。

### P3 — 边缘

- A2A AgentCard / Task 映射；HTTP facade。
- 验收：第三方 A2A client 能提交任务。

---

## 12. 开放问题

| 问题 | 建议 |
|---|---|
| 一个 workspace 一个人格 | 已定；需要不同行为就再建一个 workspace |
| workspace 名称作为 agent 名称 | 是；`agentId` 用 workspaceId，改名不影响 |
| 连接层工作目录 | 本次不做；cwd 取 workspace 配置，未设置则无 cwd |
| conversation 保留 | 设备侧 TTL；过期 → `CONVERSATION_NOT_FOUND` |
| 同一 conversation 并发 | 一次一个 task；第二个 → `TASK_CONFLICT`；UI 侧自己排队 |
| `delta` 是否可关 | 默认发；hub 可忽略，最终文本为准 |
| conversation 列表 | 不做；hub 自己存 `conversationId` |
| 父侧 pending 上下文 | 调用方拼进 `prompt`；不引入 pending message 队列 |
| 结构化 handoff | 先不做；最终文本 + artifacts |
| `requires` 是否要暴露 | 先不做；hub 按已知的 workspace 选 |
| 设备原语 | 保留现有 device link 作为兜底，不并入本契约 |
| 多跳 | 不做 |
| 模型 / 权限是否可见 | 不暴露给 hub；执行侧审计记录 |
| 审批 | 已定：只看 hub；设备侧不弹审批 |

---

## 13. 附录

### A. 调用示例

```jsonc
// hub → device
// conversationId 已存在：复用同一个 child session，这是它的下一个 turn
{
  "id": "r-1",
  "type": "request",
  "channel": "delegate:invoke",
  "args": [{
    "agentId": "macbook-ryan/ws-mobile",
    "prompt": "跑 e2e，失败就修",
    "conversationId": "conv-1"
  }],
  "meta": { "requestId": "r-1", "principalId": "office" }
}

// device → hub
{
  "id": "r-1",
  "type": "response",
  "ok": true,
  "result": { "taskId": "t-1", "conversationId": "conv-1", "state": "running" },
  "meta": { "requestId": "r-1" }
}

// device → hub（流式）
{
  "type": "event",
  "channel": "delegate:event",
  "seq": 3,
  "payload": { "type": "delta", "taskId": "t-1", "text": "e2e passed" },
  "meta": { "requestId": "r-1" }
}
```

本地 delegate 用同一份 request，只是 `agentId` 是 `workspaceId`，不走 envelope：

```jsonc
{ "agentId": "ws-mobile", "prompt": "修一下这个 bug" }
```

### B. Grant 示例

```jsonc
{
  "id": "g-1",
  "issuer": "macbook-ryan",
  "subject": "office",
  "agentId": "macbook-ryan/ws-mobile",
  "enabled": true,
  "expiresAt": 1760000000000
}
```

### C. 代码地图

| 关注点 | 位置 |
|---|---|
| 视图通道与路由 | `packages/shared/src/protocol/channels.ts`、`routing.ts` |
| 窗口传输 / preload | `apps/electron/src/preload/bootstrap.ts`、`apps/electron/src/transport/routed-client.ts` |
| app 级链路（agent link 的雏形） | `apps/electron/src/main/hub-connection.ts` |
| 设备能力实现 | `apps/electron/src/main/device-access.ts` |
| `invokeClient` / capability 过滤 | `packages/server-core/src/transport/capabilities.ts`、`server.ts` |
| 工作区配置 / 默认值 | `packages/shared/src/workspaces/types.ts`、`workspaces/storage.ts` |
| Project 存储 / 记忆 | `packages/shared/src/projects/` |
| 工作区指令 | `packages/shared/src/prompts/system.ts` |
| Session / Workspace / Project 类型 | `packages/shared/src/sessions/types.ts`、`workspaces/types.ts`、`projects/types.ts` |
| DAG Runner | `packages/server-core/src/tasks/TaskRunner.ts` |

### D. 术语

- **Agent**：workspace 的 worker 身份；一个 workspace 一个。
- **AgentId**：`deviceId/workspaceId`；本地可简写 `workspaceId`。
- **Delegation**：一次 `DelegateRequest`；本地 in-process / 远端 `delegate:invoke`。
- **Grant**：某 hub 可以调用某 workspace 的 agent 的后台授权。
- **Opaque execution**：hub 只拿最终文本 + artifacts，不拿 transcript。
- **Mirror session**：hub 看板上代表远端任务的本地锚点，不跑 agent、不拥有历史。
