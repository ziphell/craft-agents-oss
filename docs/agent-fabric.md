# Craft Agent Fabric — 统一 Agent 运行时设计方案

> 状态：草案 v0.1（设计评审用，未实现）
> 范围：传输、schema、授权、转发、运行时对象、DAG 编排、客户端形态、边缘协议
> 相关：[remote-connections.md](./remote-connections.md)、[cli.md](./cli.md)、[project-layers.md](./project-layers.md)

---

## 0. 结论

**把 Craft Agent 从「一个应用」变成「一套可寻址、可授权、可组合的 agent 运行时」。**

窗口、WebUI、CLI、hub、设备、agent 都是同一张 RPC 图上的节点：

- **channel** 是系统调用；
- **schema** 是系统调用表；
- **capability grant** 是文件描述符/权限；
- **forwarding** 是路由；
- **session** 是进程；
- **Agent** 是用户态程序；
- **hub / TaskRunner** 是调度器；
- **MCP / A2A / ACP / HTTP** 是外设驱动或边缘适配。

这套东西的上限不在功能数量，而在**扩展不需要换底座**：新增客户端、设备、agent、工作流、第三方，都只是往同一张图上加节点。

四个基石，按顺序钉：

1. **Schema**：每个 channel 的输入/输出/事件/locality/permission/forwardable/tool 都有机器可读定义。
2. **Capability**：默认拒绝，授权是 scope + TTL + 可撤销的 grant，而不是「连接即全权」。
3. **Event model**：事件是一等公民，长动作可订阅、可取消、可恢复。
4. **Forwarding + tracing**：任何节点都能转发，但每一跳都带 request id / delegation chain / 审计。

---

## 1. 背景

### 1.1 现状

今天所有客户端本质上都是 **WS RPC client**：

```
Electron window ──WS──► embedded server (127.0.0.1:<port>)
WebUI tab       ──WS──► server (cookie auth)
craft-cli       ──WS──► server (token auth)
remote window   ──WS──► hub
device link     ──WS──► hub (capabilities: exec / fs / browser)
```

代码事实：

- 渲染端通过 `WsRpcClient` 连本地 embedded server，见 `apps/electron/src/preload/bootstrap.ts`。
- WebUI 复用同一套 `WsRpcClient + buildClientApi + CHANNEL_MAP`，见 `apps/webui/src/adapter/web-api.ts`。
- CLI 的 `CliRpcClient` 是一个精简 WS client（无重连、无 capabilities），见 `apps/cli/src/client.ts`。
- 通道集合、参数和返回值是 TypeScript 约定：`packages/shared/src/protocol/`、`apps/electron/src/transport/channel-map.ts`。
- 路由分类已经是显式的：`LOCAL_ONLY_CHANNELS` / `REMOTE_ELIGIBLE_CHANNELS`，见 `packages/shared/src/protocol/routing.ts`。
- HTTP 端点目前只有 auth / config / exports / static，真正操作都在 WS，见 `packages/server-core/src/webui/http-server.ts`。
- 设备能力是 `client:device:exec` / `client:device:fs` / `client:browser:invoke`，由 app-level link advertise，见 `apps/electron/src/main/hub-connection.ts`。
- DAG 已经有 in-process Conductor：每个 node = 一个 child session，见 `packages/server-core/src/tasks/TaskRunner.ts`。

### 1.2 问题

| # | 问题 | 表现 |
|---|---|---|
| P1 | 契约是「TypeScript 约定」 | 无运行时校验、无机器可读 schema、CLI/工具/SDK 无法生成 |
| P2 | 信任是「连接即全权」 | 保存 server = 全权 token；没有 scope、TTL、逐 action 授权 |
| P3 | 远程模式混在一起 | device（沙箱）、operator（等于人）、agent（委派）三种语义纠缠 |
| P4 | 配置分散 | session / workspace / project / task / automation 各带一份 model/permission/source |
| P5 | 没有 Agent 实体 | 没有可复用的身份、memory、工具策略；每开一个入口复制一套配置 |
| P6 | 长任务/事件语义不统一 | 有 session 事件，但没有通用 operation、idempotency、cancel、resume |
| P7 | 拓扑写死在功能里 | 窗口、WebUI、CLI、device、hub 各有一套连接与转发逻辑 |
| P8 | 跨跳可观测性弱 | 没有统一的 request id / delegation chain / audit |

### 1.3 目标

- 一套 schema，多客户端：窗口、WebUI、CLI、hub、agent、第三方。
- 一个转发原语：device / operator / hub / browser 只是不同 edge。
- 默认拒绝的授权模型：per-hub、per-workspace、per-action。
- DAG 节点可以指定执行位置与 agent，而不复制配置。
- A2A / ACP / MCP 作为边缘适配，不进入核心。

### 1.4 非目标

- 不替换 Claude Agent SDK / Pi 后端。
- 不做通用分布式操作系统；只服务 Craft Agent 的资源与工作流。
- 不把整个管理 API 暴露给模型。
- 不要求 P0 就统一 Electron renderer 与 WebUI renderer。
- 不要求 P0 就实现 HTTP 对外 API；HTTP 是后续生成的 facade。

---

## 2. 设计原则

1. **One contract, many clients.** UI、CLI、hub、agent 都只是客户端。
2. **Every resource addressable, every action typed.** 资源有 id，动作有 schema。
3. **Default deny.** 没有 grant 就没有调用；capability 不是「登录后自动拥有」。
4. **Events first-class.** 每个长动作都可订阅、可取消、可恢复。
5. **Forwarding is a primitive.** 拓扑不写进功能；任何节点都能成为 bridge。
6. **Execution side owns authority, model, and history.** 发起方只能请求，不能代替批准；执行方用自己的凭据与模型；完整历史留在执行方。
7. **Small core, edge adapters.** MCP / A2A / ACP / HTTP 在边缘做翻译。
8. **Observability by default.** 每个请求都带 id、workspace、principal、delegation chain。
9. **Product hides the fabric.** 用户看到的是「我的设备 / 我的 agent」，不是 RPC 通道和拓扑。

---

## 3. 概念模型

| 概念 | 定义 | 例子 |
|---|---|---|
| **Principal** | 发起动作的主体 | 人、窗口、CLI、agent、device、hub |
| **Node** | 说这套协议的进程 | desktop、headless server、CLI、hub、device daemon |
| **Resource** | 可寻址对象 | workspace、session、agent、device、browser、task |
| **Channel** | 一个有类型的动作 | `sessions:create`、`sessions:sendMessage` |
| **Capability** | 对「某资源上的某动作」的授权 | `hub X may forward sessions:* in workspace W` |
| **Grant** | capability 的实例：scope + TTL + 可撤销 | 见 §7 |
| **Agent** | 持久定义：身份/指令/能力/记忆/限制 | `reviewer`、`ios-release` |
| **Workspace** | 文件、sources、skills、权限的边界 | `mobile-app` |
| **Project** | 一组工作的分组 + 项目记忆 | `Q4 mobile release` |
| **Session** | Agent 的一次运行/对话 | 一个 chat |
| **Task / Run / Node** | 编排单元 | DAG 的 run 与节点 |
| **Channel Binding** | 对外暴露（聊天、HTTP、A2A） | Telegram topic → session |

关系：

```
Principal ──grant──► Node ──invoke──► Channel ──acts on──► Resource
                                              │
                                              └── events ──► Subscriber
```

---

## 4. 分层架构

```
L6 Edge adapters   MCP | A2A | ACP | HTTP facade | messaging
L5 Exposure        Window | WebUI | CLI | Channel binding
L4 Orchestration   TaskRunner/DAG | automations | delegation
L3 Runtime         SessionManager | Agent | tools | memory
L2 Capability      grants | scopes | audit
L1 Schema          channels | DTO | events | codegen
L0 Transport       WS | outbound links | forwarding | local server
```

原则：**上层可以依赖下层，下层不知道上层。** 例如 `SessionManager` 不知道调用它的是窗口、CLI 还是 hub；它只看到 principal 和 grant。

---

## 5. 统一 RPC 模型

### 5.1 Envelope

```ts
type Envelope =
  | { id: string; type: 'request';  channel: string; workspaceId?: string; args: unknown[]; meta?: Meta }
  | { id: string; type: 'response'; ok: true; result: unknown; meta?: Meta }
  | { id: string; type: 'response'; ok: false; error: RpcError; meta?: Meta }
  | { id: string; type: 'event';   channel: string; seq: number; payload: unknown; meta?: Meta }

interface Meta {
  requestId: string
  principalId: string
  grantId?: string
  delegation?: { chain: string[]; depth: number; parentTaskId?: string }
}
```

握手增加：

```ts
{
  protocolVersion: '1.0',
  clientInfo: { deviceId, name, platform, workspaceId? },
  capabilities: string[],
  schemaVersion: string
}
```

### 5.2 Channel 生命周期

- **request/response**：短动作，秒级。
- **operation**：长动作返回 `{ operationId }`，通过 `operations:get` / `operations:cancel` / 事件推进。
- **event**：服务端推送，带 `seq` 与 `sessionId` 等过滤键；支持从 `seq` 恢复。
- **subscription**：客户端显式订阅某资源的事件；断线重连按 `seq` 补发。

### 5.3 Channel 元数据

每个 channel 必须有：

| 字段 | 取值 | 用途 |
|---|---|---|
| `params` / `result` | JSON Schema | 校验与代码生成 |
| `locality` | `local` / `workspace` / `server` / `device` | 决定谁能回答 |
| `permission` | `read` / `write` / `admin` | 授权分类 |
| `forwardable` | boolean | 是否允许 device/operator 转发 |
| `tool` | boolean | 是否暴露给模型 |
| `idempotent` | boolean | 重试安全 |
| `streams` | event channel + filter | 长任务/进度 |
| `scope` | `workspace` / `server` | 是否需要 workspaceId |

`LOCAL_ONLY_CHANNELS` / `REMOTE_ELIGIBLE_CHANNELS` 可以保留为 `locality` 的派生视图，避免一次性迁移。

### 5.4 错误模型

```ts
interface RpcError {
  code: string          // WORKSPACE_REQUIRED / CAPABILITY_DENIED / UNAVAILABLE / TIMEOUT ...
  message: string
  retryable: boolean
  details?: unknown
}
```

约定：

- 缺 workspace → `WORKSPACE_REQUIRED`，不回落默认 workspace。
- 没 grant → `CAPABILITY_DENIED`，不降级。
- 设备离线 → `UNAVAILABLE`，可重试。
- 版本不匹配 → `PROTOCOL_VERSION_UNSUPPORTED`。

### 5.5 版本

- `PROTOCOL_VERSION`：major/minor，握手校验。
- `schemaVersion`：channel 契约版本；服务端可拒绝未知 channel。
- 兼容策略：新增 optional 字段；不删字段；major 不兼容。
- CI 断言：每个已注册 channel 都有 schema entry；每个 entry 都有 locality/permission。

---

## 6. Schema

### 6.1 形态

建议用 JSON Schema 作为交换格式，内部用 Zod 校验并生成 TS 类型。

```jsonc
{
  "$schema": "https://craft-agent.dev/rpc-schema/v1",
  "version": "1.0.0",
  "channels": {
    "sessions:create": {
      "description": "Create a session in a workspace",
      "scope": "workspace",
      "locality": "workspace",
      "permission": "write",
      "forwardable": true,
      "tool": true,
      "idempotent": false,
      "params": [
        { "name": "workspaceId", "schema": { "type": "string" } },
        { "name": "options", "schema": { "$ref": "#/$defs/CreateSessionOptions" } }
      ],
      "result": { "$ref": "#/$defs/Session" }
    },
    "sessions:sendMessage": {
      "description": "Send a user message to a session",
      "scope": "workspace",
      "locality": "workspace",
      "permission": "write",
      "forwardable": true,
      "tool": true,
      "idempotent": false,
      "params": [
        { "name": "sessionId", "schema": { "type": "string" } },
        { "name": "message", "schema": { "type": "string" } }
      ],
      "result": { "type": "object", "properties": { "accepted": { "type": "boolean" } } },
      "streams": { "channel": "session:event", "filterBy": "sessionId" }
    },
    "session:event": {
      "direction": "server->client",
      "locality": "workspace",
      "event": true,
      "forwardable": true
    },
    "settings:setServerConfig": {
      "scope": "server",
      "locality": "server",
      "permission": "admin",
      "forwardable": false,
      "tool": false
    }
  }
}
```

### 6.2 生成物

- `CHANNEL_MAP` / `RPC_CHANNELS` 的校验或生成；
- TS 类型、客户端 SDK；
- CLI 命令；
- agent 工具目录（只取 `tool: true` 的子集）；
- 文档（每个 channel 一行）；
- E2E/契约测试的 fixture。

### 6.3 规则

- schema 是唯一事实来源；前端只是消费者。
- 新增 channel 不写 schema → CI 失败。
- `tool: true` 必须同时给出人类可读的 description 和参数说明，否则模型无法用。
- `forwardable: true` 必须同时声明 `permission` 与 `scope`；admin/write 默认不 forward。
- 破坏性变更走 major；弃用走 deprecation 字段与日志。

---

## 7. Capability 与授权

### 7.1 Principal

| Principal | 例子 | 默认权限 |
|---|---|---|
| `human` | 桌面用户 | 本机全权 |
| `window` | 一个渲染窗口 | 当前 workspace 的 read/write |
| `cli` | craft-cli | token 指定的 scope |
| `agent` | 会话内的模型 | 工具目录 + workspace 授权 |
| `device` | 已保存的客户端 | 明确 grant 的 capability |
| `hub` | 远端 server | 明确 grant 的 operator/device scope |

### 7.2 Grant

```ts
interface Grant {
  id: string
  issuer: string          // 谁授权（本机用户）
  subject: string         // principal id（hub deviceId / cli token id / agent id）
  resource: string        // workspace / session / device / server
  actions: string[]       // channel 或通配：sessions:* / fs:read
  workspaceIds?: string[] // 限定作用域
  expiresAt?: number
  createdAt: number
  revokedAt?: number
  constraints?: {
    forwardOnly?: boolean // 只能转发，不能本地执行
    maxConcurrency?: number
    maxTokens?: number
  }
}
```

### 7.3 默认拒绝

- 没有 grant → `CAPABILITY_DENIED`。
- 「保存服务器」只建立连接，不授予 operator / agent / device 权限。
- 三类授权分开：
  - `device`：沙箱 shell/fs/browser；
  - `operator`：等于用户操作整个 app；
  - `agent`：把任务委派给端侧 agent。
- 每类都有 `off | ask | always`，默认 `off`。
- `ask` 需要明确的批准 UI；`always` 必须可见、可撤销、可审计。

### 7.4 审计

每条授权和每次调用记录：

```
when, principalId, grantId, channel, workspaceId, sessionId,
taskId/runId/nodeId, result, duration, bytes, errorCode
```

审计日志与 run log 分开：前者是安全事实，后者是编排事实。

---

## 8. 拓扑与转发

### 8.1 节点

| 节点 | 连接方向 | 提供 |
|---|---|---|
| desktop app | 出站到 hub；本地 embedded server | window RPC、device capabilities、operator（可选） |
| headless server | 监听 / 出站到 hub | 完整 server |
| CLI | 出站到 server | 一个 client |
| hub | 接受连接；出站到其他 hub（后续） | 调度、workspace、sessions |
| browser/WebUI | 出站到 server | UI client |

### 8.2 转发协议

```jsonc
// hub → device
{
  "v": 1,
  "type": "forward",
  "requestId": "r-1",
  "channel": "sessions:create",
  "workspaceId": "ws-1",
  "args": ["ws-1", { "name": "remote" }]
}

// device → hub
{ "requestId": "r-1", "ok": true, "result": { "id": "s-1" } }
```

规则：

- 只转发 schema 里 `forwardable: true` 且 grant 允许的 channel。
- 必须带 `workspaceId`；缺了即 `WORKSPACE_REQUIRED`。
- 长动作返回 `operationId`，事件走 `client:rpc:event`。
- `requestId` 作为幂等键；重复请求返回同一结果。
- 超时/取消要传播到本地 server。
- 不允许把请求转发回来源节点（`delegation.chain` 检查）。

### 8.3 事件回传

```
device 本地订阅 session:event
  → 过滤 sessionId / workspaceId
  → client:rpc:event { requestId, seq, payload }
  → hub 按 seq 去重、补发、投递给订阅者
```

事件通道需要：

- seq + 缓冲 + TTL；
- 断线重连从 `lastSeq` 恢复；
- 背压：慢消费者丢弃或合并，不阻塞 agent；
- 终止事件：`complete` / `error` / `interrupted`。

### 8.4 拓扑自由

同一个转发原语可以覆盖：

- hub → device（端侧 agent / operator）；
- hub → hub（联邦，后续）；
- CLI → server（普通客户端）；
- WebUI → server（浏览器）；
- 窗口 → embedded server（本地）。

**区别只在 edge，不在核心。**

---

## 9. 运行时对象模型

### 9.1 Agent（新增）

Agent 是持久定义，不是运行实例。

```ts
interface Agent {
  id: string
  name: string
  description?: string
  version: number
  instructions: string
  defaults: {
    model?: string
    llmConnection?: string
    thinkingLevel?: ThinkingLevel
    permissionMode?: PermissionMode
    workingDirectory?: string
    browserProfile?: string
  }
  capabilities: {
    skills?:  { always?: string[]; optional?: string[] }
    sources?: { required?: string[]; optional?: string[] }
    tools?:   { allow?: string[]; deny?: string[]; autoApprove?: string[] }
  }
  memory: { enabled: boolean; scope: 'agent' | 'workspace'; maxTokens?: number }
  limits?: { maxTokensPerRun?: number; maxDurationMs?: number; maxConcurrency?: number }
  exposure?: { messaging?: boolean; delegation?: 'allow' | 'deny' }
}
```

存储：

```
~/.craft-agent/agents/<slug>/
  agent.json
  INSTRUCTIONS.md
  MEMORY.md
  skills/            # 可选，agent 私有
```

### 9.2 Agent / Project / Workspace / Session

| 概念 | 回答 | 归属 |
|---|---|---|
| Agent | 谁来做、怎么做 | app 级，可跨 workspace |
| Workspace | 文件/sources/skills/权限边界 | 目录 |
| Project | 一组工作 + 项目记忆 | workspace 内 |
| Session | 这次运行 | workspace + agent |
| Task/DAG | 怎么编排 | workspace |

Project 已经是「proto-agent」：它有 name/details/MEMORY.md/workingDirectory/assets。但它回答的是「什么工作、在哪」，Agent 回答「谁来做」。**不要合并实体，复用形状。**

### 9.3 优先级

```
session override
  > agent（pinned version）
    > project binding / defaults
      > workspace defaults
        > global defaults
```

但更准确的表述是三层职责：

- **Availability** 在 workspace：有哪些 sources/skills/权限；
- **Selection** 在 agent：用其中哪些；
- **Override** 在 session：这一次临时改什么。

Agent 只能收窄 workspace 的权限，不能放大。

### 9.4 快照与版本

- Session 创建时解析并固定 `agentVersion` + 有效配置快照。
- 编辑 Agent 不改变运行中/历史 session；提供「reload with new version」。
- 复用现有 prompt-drift 机制提示「agent instructions/memory 已变化」。

### 9.5 Memory 分层

| 层 | 内容 | 位置 |
|---|---|---|
| Agent memory | 工作偏好、风格、稳定习惯 | `agents/<slug>/MEMORY.md` |
| Project memory | 仓库决策、坑、约定 | `projects/<slug>/MEMORY.md` |
| Session history | 这次对话 | `sessions/<id>/session.jsonl` |

规则：**「我怎么工作」进 agent memory，「这个项目怎么回事」进 project memory。**

---

## 10. 执行模式

### 10.1 四种 executor

| 模式 | 授权 | 执行位置 | 适合 |
|---|---|---|---|
| `local` | 本机用户 | hub 自己的 server | 内容在 hub、无需端侧环境 |
| `device` | per-hub `agent` grant | 客户端 sandbox 或映射 workspace | 受控任务、按任务批准 |
| `operator` | per-hub `operator` grant | 客户端完整 app | 自己的机器、真实 workspace |
| `webui` | operator 的降级 | 客户端浏览器 + WebUI | fallback / UI-only |

### 10.2 选择规则

- 内容在 hub → `local`。
- 内容在 device 的真实仓库 → `operator` 或 `device + workspace mapping`。
- 只需要端侧非文件资源（browser/VPN/硬件/用户在场）→ `device`，`workspace=sandbox` 合法。
- 只需要 UI-only 操作 → `webui`，标注 degraded。
- **没有任何端侧依赖 → 必须 `local`。** 空 sandbox + 无 `requires` 是无意义委派。

### 10.3 Node spec

```yaml
- id: e2e
  executor:
    kind: operator            # local | device | operator | webui
    client: macbook           # device/operator 目标
    requires: [workspace]     # device 模式必填：workspace/browser/network/hardware/user-presence/isolation
    workspace: mobile-app
  agent: ios-tester           # 可选；不填则用客户端默认
  prompt: "跑 e2e，失败就修"
  outputs:
    - { name: passed, type: boolean }
  timeout: 1800
```

### 10.4 状态机

借 A2A 的语义：

```
submitted → working → completed
                ├→ input-required
                ├→ auth-required
                ├→ failed
                ├→ canceled
                └→ rejected
```

映射到 DAG 的 `NodeRunState`：

| 执行状态 | DAG |
|---|---|
| submitted / working | running |
| input-required / auth-required | awaiting-approval（source=executor） |
| completed | done |
| failed / rejected | failed |
| canceled | cancelled |

### 10.5 NodeExecutor

```ts
interface NodeExecutor {
  start(node: TaskNode, prompt: string, ctx: ExecContext): Promise<NodeHandle>
  status(handle: NodeHandle): Promise<NodeState>
  cancel(handle: NodeHandle): Promise<void>
  result(handle: NodeHandle): Promise<{ text: string; usage?: TokenUsage; artifacts?: ArtifactRef[] }>
  onComplete(handle: NodeHandle, cb: (result: NodeResult) => void): () => void
}
```

- local executor 内部仍用 `createSession` + `onSessionComplete`。
- device/operator executor 用转发协议 + 事件。
- 完成统一走 `handleNodeCompletion`，不再只依赖本地 session 事件。

### 10.6 镜像 session

看板是 session-backed 的（`taskNodeId` / `kanbanColumn`）。非本地节点需要一个**本地镜像 session**：

- 作为 tile 与 run/node 的锚点；
- 不跑本地 agent；
- 状态由 executor 驱动；
- 存 `remoteRef`，点击可看远端/端侧。

### 10.7 并发、预算、重试、取消

- `max_parallel` 全局 + per-target 并发（device/operator 各自上限）。
- `token_budget` 汇总远端/端侧 usage；缺失标 `unknown`，不当 0。
- 节点 `timeout` 必须传播 cancel。
- `retry` 创建新 task（A2A task immutability），`runId+nodeId+attempt` 做幂等键。
- run stop/cancel 广播到所有 executor。

### 10.8 数据流

| 类型 | 方案 |
|---|---|
| 文本/JSON | 现有 `${nodes.x.output}` + 末尾的 `params` JSON fence；远端返回 final text 即可 |
| 文件/artifact | artifact handle；hub 拉到 `tasks/<slug>/runs/<runId>/artifacts/`；下游用本地路径 |
| transcript | 不传；只传声明 outputs（opaque execution） |

---

## 11. 客户端形态

### 11.1 CLI

- 就是一个 WS client（`CliRpcClient`）。
- 命令由 schema 生成：

```bash
craft-cli sessions create --workspace ws-1
craft-cli sessions send <id> "..."
craft-cli sessions events <id>
craft-cli invoke sessions:get '"ws-1"'   # 逃生口
```

- 认证：bearer token；`--url` / `--token` / `--tls-ca`。
- 不回答 `LOCAL_ONLY` channel；返回 `UNSUPPORTED_LOCAL`。
- 不再承担「应用变体」的角色；需要 headless app 时另起 `craft-cli serve`。

### 11.2 WebUI

- 浏览器 WS client，cookie auth。
- 消费同一份 schema；不引入第二套契约。
- 可以作为「example client / conformance test」验证 API 完整性。

### 11.3 Desktop

- 当前：renderer/preload 用 `WsRpcClient` 连 embedded server。
- 可选演进：`IpcRpcClient` + 自定义协议加载 WebUI bundle，去掉本地端口。
- 自定义协议只负责静态资源；特权操作走 preload + IPC + channel 白名单。
- 不要把自定义协议变成远程可调用的 API；hub 仍然走出站 capability。

### 11.4 Headless

- `packages/server` + WS；可服务 WebUI、CLI、hub。
- 没有浏览器时，browser 类工具通过 device capability 获取。

### 11.5 HTTP facade（后续）

- 从同一份 schema 生成 `/v1` HTTP + SSE，面向第三方。
- 不是内部传输；内部仍是 WS。
- 端点需要 scope、CSRF、CORS、版本化。

---

## 12. 边缘适配

### 12.1 A2A

映射：

| A2A | Craft |
|---|---|
| AgentCard | Agent + device capability 描述 |
| Task | 一次委派/一个 DAG node |
| Message | session 消息 |
| Artifact | node output / 文件 |
| SendMessage | `sessions:create` + `sendMessage` |
| GetTask | `sessions:get` + task state |
| CancelTask | `sessions:cancel` |
| SubscribeToTask | SSE / `session:event` |
| contextId | 一个端侧 session / delegation context |

采用 A2A 的任务状态、context/task 分离、artifact、opaque execution；**不采用**其 HTTP/SSE/webhook 传输作为内部传输。

### 12.2 ACP

借：

- `session/request_permission` 的 `allow_once / allow_always / reject_once / reject_always`；
- `session/update` 的 tool_call/diff/terminal 分类；
- `terminal/*` 句柄模型（长进程优于一次性 exec）；
- `session/cancel` 通知语义；
- 双向方法归属 + `_meta`/`_` 扩展。

不借 stdio 传输。

### 12.3 MCP

sources/tools 继续走 MCP；不把 MCP 变成 agent 间协议。

### 12.4 Messaging

- `ChannelBinding` 是「人的面」的暴露通道，不是 agent 传输。
- 可用于通知、审批、观察、任务收件箱。
- 注意：bot-to-bot 默认被丢弃；没有结构化关联；消息长度/限流。
- 绑定 object 建议从 `sessionId` 扩展到 `agentId`（每个 chat/topic 自动开 session）。

---

## 13. 安全与隐私

### 13.1 威胁模型

| 威胁 | 后果 | 缓解 |
|---|---|---|
| raw forward 无白名单 | RCE as a service | `forwardable` + permission + grant |
| token 泄漏 | 全权访问 | scope、TTL、撤销、轮换 |
| prompt injection | 数据外泄/越权 | 执行侧批准、workspace 边界、预算 |
| 跨 workspace 混淆 | 写错项目 | 显式 `workspaceId`，fail-closed |
| 事件伪造 | 假结果 | 校验 principal/grant/task 归属 + seq |
| localhost/CSRF | 浏览器驱动本地 app | origin allowlist、CSRF、独立 profile |
| 审计缺失 | 无法追责 | request id + delegation chain + audit |
| 工具过载 | 模型调用危险端点 | `tool` 子集 + scope |

### 13.2 三条硬规则

1. **授权在执行侧**：发起方只能请求，不能代替批准。
2. **模型与凭据在执行侧**：不跨机传 key。
3. **完整历史在执行侧**：发起方只拿结果 + 引用。

### 13.3 不要做的事

- 不要把 `settings:*`、凭据、auth、workspace 删除标记为 `forwardable` / `tool`。
- 不要让「保存服务器」自动等于 operator / agent / device 授权。
- 不要把 WebUI 前端当契约。
- 不要让 hub 通过 UI 自动化绕过 capability 授权。

---

## 14. 可观测性

每条链路携带：

```
requestId, principalId, grantId,
workspaceId, sessionId,
taskId / runId / nodeId,
delegation { chain, depth },
executor { kind, target },
```

记录：

- **audit log**：安全事实（谁、在什么授权下、调了什么）。
- **run log**：编排事实（node 状态、重试、预算）。
- **trace**：跨节点 span；转发时透传。
- **metrics**：调用量、延迟、错误率、每 target 并发、token 使用。

reconcile：

- hub 重启后按 `requestId` / taskId 对账；
- 设备离线标 `unknown`，不要假装完成；
- 事件按 seq 补发。

---

## 15. 兼容与迁移

### 15.1 Schema 落地

1. 从现有 `CHANNEL_MAP` / `RPC_CHANNELS` 生成初始 schema。
2. 先只加元数据（locality/permission/forwardable/tool），不改运行时。
3. 在 server 边界加 Zod 校验（先 warn，后 reject）。
4. 生成 CLI/工具目录，替换手写映射。
5. CI：每个 channel 必须有 entry。

### 15.2 Agent 迁移

1. 内置 `general` Agent，行为等价于现状。
2. 现有 session 懒回填 `agentId:'general'`；原字段保留为 overrides。
3. Project 保留；提供「从 Project 创建 Agent」复制 details/workingDirectory。
4. Automations/Tasks/Messaging 逐步引用 `agentId`，保留 inline 字段兼容。
5. 不破坏现有数据。

### 15.3 协议版本

- `PROTOCOL_VERSION` major 不匹配 → 拒绝握手。
- schema 新增 optional 字段；不删除；弃用有日志与期限。
- CLI/客户端/SDK 从 schema 生成，避免漂移。

---

## 16. 分期路线

### P0 — Schema 与转发地基

- schema 初版 + 校验 + 生成 CLI 命令骨架。
- `client:rpc:forward` + allowlist（sessions/workspaces 读 + session 写）。
- 显式 `workspaceId`；缺了拒绝。
- 事件回传 + seq。
- 审计字段。
- 验收：CLI 与窗口用同一套 channel；hub 能通过 device 转发创建一个 session 并收到事件。

### P1 — Operator 与 DAG 集成

- per-hub `operator: off|ask|always`。
- operator daemon（桌面主进程 / `craft-cli serve`）。
- `NodeExecutor` 抽象 + `OperatorExecutor`。
- 镜像 session + `handleNodeCompletion`。
- 审批/取消/超时/幂等。
- 验收：DAG node 在客户端真实 workspace 跑完，结果进入 run log / artifacts。

### P2 — Agent 实体

- Agent 存储/RPC/UI + 内置 `general`。
- `session.agentId` + 版本快照 + 优先级。
- Agent memory + tool policy + limits。
- Automations/Tasks/Messaging 引用 Agent。
- 验收：同一 workspace 多 Agent；跨 workspace 复用；memory 不串。

### P3 — Device agent 与边缘协议

- `requires` + device workspace mapping + per-task consent。
- A2A AgentCard/Task 映射；ACP permission/update 语义。
- HTTP facade（从 schema 生成）。
- 多跳 delegation + chain/depth。
- 验收：第三方 A2A client 能创建任务；device 任务可恢复/取消。

---

## 17. 风险与开放问题

| 问题 | 需要拍板 |
|---|---|
| Agent 作用域 | 全局定义 + workspace binding，还是 workspace-scoped？建议前者 |
| Project 与 Agent | 分离（推荐）还是合并？合并会锁死多 agent/跨项目 |
| operator 默认值 | 默认 `off` + `ask`；`always` 是否允许？ |
| raw forward 粒度 | 允许通配 `sessions:*` 还是逐 channel？建议逐 channel 起步 |
| 事件持久化 | 内存缓冲 + TTL，还是落盘可重放？ |
| token 模型 | 现有全权 token 是否升级为 scoped token？ |
| HTTP facade | 是否需要对外？如果需要，何时生成？ |
| WebUI 自动化 | 是否支持？建议只作为 fallback 且默认关闭 |
| 多跳 | 是否允许 hub→hub→device？建议先 depth=1 |
| Agent 命名 | `agentId` 已被 workflow/credentials 占用；内部用 `profileId`？ |

---

## 18. 附录

### A. Channel 示例

见 §6.1。

### B. Grant 示例

```jsonc
{
  "id": "g-1",
  "issuer": "local-user",
  "subject": "hub:office",
  "resource": "device:macbook",
  "actions": ["sessions:create", "sessions:sendMessage", "sessions:cancel", "session:event"],
  "workspaceIds": ["ws-mobile"],
  "expiresAt": 1760000000000,
  "constraints": { "maxConcurrency": 1, "maxTokens": 200000 }
}
```

### C. Forward 消息

见 §8.2 / §8.3。

### D. Node spec

见 §10.3。

### E. 代码地图

| 关注点 | 位置 |
|---|---|
| 通道常量 / DTO | `packages/shared/src/protocol/` |
| 路由分类 | `packages/shared/src/protocol/routing.ts` |
| WS server / capabilities | `packages/server-core/src/transport/server.ts` |
| 设备注册与解析 | `packages/server-core/src/sessions/SessionManager.ts` |
| app-level device link | `apps/electron/src/main/hub-connection.ts` |
| 设备能力实现 | `apps/electron/src/main/device-access.ts` |
| 窗口传输 | `apps/electron/src/preload/bootstrap.ts`、`apps/electron/src/transport/` |
| WebUI adapter | `apps/webui/src/adapter/web-api.ts` |
| CLI | `apps/cli/src/` |
| HTTP 端点 | `packages/server-core/src/webui/http-server.ts` |
| DAG Runner | `packages/server-core/src/tasks/TaskRunner.ts` |
| Task schema | `packages/shared/src/tasks/schema.ts` |
| Session / Workspace / Project 类型 | `packages/shared/src/sessions/types.ts`、`workspaces/types.ts`、`projects/types.ts` |
| Messaging binding | `packages/messaging-gateway/src/types.ts`、`router.ts`、`renderer.ts` |

### F. 术语

- **Fabric**：统一 RPC 总线 + schema + capability + forwarding。
- **Locality**：channel 由哪类节点回答（local/workspace/server/device）。
- **Forwardable**：是否允许通过 device/operator 转发。
- **Opaque execution**：发起方只拿结果与 artifact，不拿对方 transcript。
- **Operator**：以用户身份操作整个客户端 app 的授权模式。
- **Device agent**：在客户端沙箱/映射 workspace 中运行的受控 agent。
- **Mirror session**：DAG 中代表远端/端侧任务的本地 session 锚点。
