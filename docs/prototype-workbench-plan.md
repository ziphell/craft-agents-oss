# 产品经理需求生产工作台 — 实施方案

> 状态：阶段 1–6 全部完成；阶段 7 完成两项（无中生有入口、改写真实后端返回），放开面经决策**确定不开**，跨域 iframe 读取与响应头就地改写未做。UI 闭环已完成：创建入口（侧边栏「原型」+ 面板「+」+ 空态按钮）→ 详情页 Open / Apply / Capture base / Export，以及产物文件就地编辑（base.html 与 patches/*）。**会话绑定已完成（§11）**：会话绑定原型后，agent 的 system prompt 里带 `<prototype_context>`，且 `prototype-*` 的 slug 变为可选。下一步：端到端试用（见 §10）；仍未进 UI 的是「选择元素」按钮（agent 侧 `browser_tool pick` 已可用）。
> 范围：MVP（个人使用，先增量模式）
> 前置结论：本方案基于对现有代码的实测核对，所有引用均带文件路径与行号。

---

## 1. 定位与范围

**一句话定位**：一个真实浏览器引擎 + 一层 UI patch + **一层服务契约** + 一组导出器，由**现有 Tasks DAG 作为控制面**编排多 lane 并线，两个入口（真实网页 / 生成的空页）。

**与 Pencil 的关系**：不是"替代画布"，而是补上 Pencil 覆盖不到的生态位——Pencil 在空白画布上"无中生有"并生成代码；本工作台在**真实产品**上做增量，并把增量变成开发能用的东西。核心差异是**渲染载体**：Pencil 用矢量画布（矢量 → 代码，有翻译损耗），本方案用真实浏览器引擎（只有一种表示，所见即代码）。

**脱离纯前端视角**：mock 不是"拦截浏览器请求的技巧"，而是**服务契约层**。mock 是服务契约的一种运行时物化，同一个契约同时面向前端与后端交付。

**平面分离**：数据面 / 控制面 / 业务逻辑 / 渲染四者相互分离。这不是为了整齐，而是**多 agent 并线能成立的前提**（见 §3）。

### MVP 范围内的（按优先级）

| 编号 | 能力 |
|---|---|
| 阶段 1 | 接线层：产物目录 + 文件读写通路 + 目录监听 |
| 阶段 2 | P0 拾取器：选中 DOM → 高亮 → 稳定 selector |
| 阶段 3 | 持久注入：patch 落盘、reload 后按顺序重放 |
| 阶段 4 | 导出器：base + patch → 自包含 HTML + 变更说明 |
| 阶段 5 | 服务契约层：契约真源 → mock 物化 → 后端交付 |
| 阶段 6 | 平面分离与并线接线：所有权矩阵 → 派生索引 → 挂接 Tasks DAG |

### 明确不做的（非目标）

- 多租户、协作、权限、账号体系（个人使用）
- 矢量画布 / 拖拽设计器（Pencil 的护城河，不抢）
- 云端存储（产物就是本地文件）
- 阶段 7 之前不碰 `webSecurity` 放开、跨域、无中生有
- MVP 不做状态化 mock（见 D9）
- MVP 不实现 Tasks 的非 `session` 节点种类（`parallel`/`map`/`verify`/`aggregate` 用 `session` 节点模拟）

---

## 2. 已确认的架构决策

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | 渲染载体 | 真实浏览器引擎（BrowserView + CDP） | 所见即代码，零翻译损耗 |
| D2 | 持久化模型 | Hybrid：编辑时 live overlay，交付时 snapshot | 线上页面改版不毁产物 |
| D3 | 产物位置 | `{workspaceRootPath}/prototypes/{projectSlug}/` | 跨会话长期存活，契合"同一项目多交付" |
| D4 | 写通道 | 混合：确定性改动走新增 `file:write` 直写；语义改动走 agent `Write`/`Edit` | 实时性与可审计性兼顾，最终同一真源 |
| D5 | 权限模型 | 真实产品面锁死；原型面独立 partition 才允许 `webSecurity:false`；`nodeIntegration` 永远 `false` | 注入与跨域都不需要 node 能力 |
| D6 | 起手形态 | 本地 dev server | DOM 可控、无登录态，验证链路 |
| D7 | 服务契约格式 | **OpenAPI 3.1** | REST 生态最成熟，Prism / MSW / 后端都能直接吃 |
| D8 | mock 运行时 | ~~复用 MSW + Prism~~ → **改用 CDP `Fetch` 拦截**（阶段 5 修订） | 原方案要引两个新依赖，且页面级 mock 覆盖不到 axios 用的 XHR；CDP 在网络层兑现响应，fetch/XHR/任意资源全覆盖、无需改应用、零新依赖 |
| D9 | mock 状态 | **MVP 无状态 fixtures**（flows 后置） | 覆盖"跑假数据"；状态化留待需要演多步流程时 |
| D10 | mock 与服务的关系 | **mock = `baseUrl` 指向本地的 Source** | mock ↔ 真服务切换只改 `baseUrl`，复用现有 Source 基建 |
| D11 | 并线的控制面 | **复用 Tasks DAG + TaskRunner** | 已并行（`max_parallel` 默认 4）、已持久化、已支持依赖图 |
| D12 | 单文件争用 | **`manifest.json` 改为派生索引** | 彻底消除最大争用点，转而由控制面扫描生成 |
| D13 | lane 划分 | **按平面切**（UI / 契约 / 数据 / 验证） | 每个 lane 写不同文件类型，所有权最干净 |
| D14 | lane 通信 | **只读通信**，lane 间不共享写 | 共享写是并线的唯一致命伤 |
| D15 | 渲染面角色 | **只读**；拾取器是**传感器**不是写者 | 渲染一旦写文件就破坏所有权模型（修正 D4 的执行者） |
| D16 | 会话与原型的关系 | **绑定**（session.prototypeSlug），复用 session↔project 的既有范式 | 让 agent 不必每轮被告知操作对象；`prototype-*` 的 slug 因此可选（见 §11） |

---

## 3. 平面分离与多 agent 并线

### 3.1 四平面

| 平面 | 职责 | 写入者 |
|---|---|---|
| **数据面** | `base.html` / `patches/` / `services/` / fixtures | 各 lane 独占其文件；控制面负责合成派生索引 |
| **控制面** | 编排、依赖、并发、权限、**单文件资源仲裁** | **唯一写者：控制面自身** |
| **业务逻辑** | `patches/*.js`、`services/*/paths/*.yaml` | lane A / lane B 独占；**强制不与 fixtures 混写** |
| **渲染** | BrowserView、预览面 | **只读**。拾取器只发事件 |

### 3.2 并线的瓶颈是写冲突，不是调度

实测结论（重要）：

- **调度已解决**：`ActiveRun.scheduleReady()` 已并行派发，`max_parallel` 默认 4（`TaskRunner.ts:315-328`、`:110`）；依赖图物化与就绪判定见 `validate.ts:204-222`、`TaskRunner.ts:330-336`。
- **全仓没有任何锁**：不存在进程级/跨进程文件锁、互斥锁、信号量或租约（全文检索无实现）。
- **原子写本身也会争用**：`atomicWriteFileSync` 使用固定 `<path>.tmp`（`packages/shared/src/utils/files.ts:36-46`），两个 lane 并发写同一路径时**连临时文件都在争用**。
- 现有保护只覆盖会话 header 的元数据（自写识别 + 5s 写保护窗口，`SessionManager.ts:181`、`:2028-2032`），**不覆盖任意产物文件**。

**因此：并发安全只能靠"所有权"，不能靠"锁"。** 这就是平面分离的真实收益。

### 3.3 五条硬约束

1. **lane 之间只读通信**。上游 lane 产出 → 下游 lane 只读消费，不共享写。
2. **单文件是敌人**。`manifest.json` → 派生索引（D12）；`openapi.yaml` → 按端点拆 fragment + 控制面合成（OpenAPI `$ref` 天然支持）。
3. **patch append-only + 唯一命名**。`{laneId}-{nnn}-*.css|js`，各 lane 写自己的文件，零争用。这正是此前"每个 patch 独立文件"决策在并线场景下的额外回报。
4. **渲染面只读**。拾取器是传感器：只发事件，由控制面决定写哪个文件。这条**修正 D4 的执行者**——"直写"仍保留，但执行者是控制面，不是 renderer。
5. **结构化输出必需**。v1 的 `NodeOutput` 只有自由文本 `text`，`param`/`artifact` 仅解析未实现（`refs.ts:40-43`、`schema.ts:90-96`）。下游 lane 要可靠消费上游产物，必须让结构化输出落地。

### 3.4 lane 划分与 DAG 映射（D13）

```
lane A  UI/交互    → patches/A-*.css, patches/A-*.js
lane B  服务契约   → services/{svc}/paths/*.yaml
lane C  数据       → services/{svc}/fixtures/*.json
lane D  验证       → 只读全部产物 → 产出 verdict（不写）
```

映射方式：**一个工作台任务 = 一个 Task；一个 lane = 一个 node**；用 `depends_on` 表达依赖（如 lane D 依赖 A/B/C）；`max_parallel` 控并发。

注意：v1 **只执行 `kind: 'session'` 节点**，`parallel`/`verify`/`aggregate` 等只解析不执行（`schema.ts:9-14`）。阶段 6 先用 `kind: 'session'` 模拟，不依赖 P4。

### 3.5 所有权矩阵（文件 → lane）

| 路径 | Owner | 其他 lane |
|---|---|---|
| `base.html` | 控制面（首次生成后冻结） | 只读 |
| `patches/A-*.{css,js}` | lane A | 只读 |
| `services/{svc}/paths/*.yaml` | lane B | 只读 |
| `services/{svc}/fixtures/*.json` | lane C | 只读 |
| `services/{svc}/openapi.yaml` | 控制面合成 | 只读 |
| `manifest.json` | 控制面派生 | 只读 |
| `dist/**` | 控制面（导出时） | 只读 |

这张表是**并线正确性的契约**：控制面据此检测越界写（lane 写了不属于它的文件 → 告警）。

---

## 4. 目录与数据模型

```
{workspaceRootPath}/prototypes/{projectSlug}/
  ├─ manifest.json          【阶段 3 起不再需要】索引由 scanPrototypePatches() 按需从磁盘派生
  ├─ base.html              初始页：抓取的快照 或 agent 生成的起始页
  ├─ patches/               每 patch 一个文件，append-only + 唯一命名
  │    ├─ A-001-btn-radius.css
  │    └─ A-002-flow-guard.js
  ├─ services/              ✅ 阶段 5：服务契约（mock 的真源）
  │    └─ {serviceSlug}/
  │         ├─ config.json          baseUrl / authType / title
  │         ├─ paths/               按端点拆的契约 fragment（lane B 独占）
  │         │    ├─ list-orders.yaml
  │         │    └─ create-order.yaml
  │         ├─ openapi.yaml         【合成】控制面由 paths/ 生成，勿手改
  │         └─ fixtures/            lane C 独占
  │              └─ list-orders-200.json
  ├─ flows/                 （后置）多步骤场景描述
  └─ dist/                  导出的交付物（按角色分化）
       ├─ prototype.html        ✅ 阶段 4：前端——自包含、可独立运行
       ├─ dev-spec.md           ✅ 阶段 4：前端/测试——改了什么
       ├─ openapi.yaml          ✅ 阶段 5：后端——契约
       ├─ contract.md           ✅ 阶段 5：后端——交接文档（含"未声明项"清单）
       ├─ fixtures/             ✅ 阶段 5：后端/CI——响应样例
       ├─ mock-server/          ⏳ 阶段 5.2：前端/CI——可跑 mock（改为 CDP Fetch 拦截后可能不需要）
       └─ msw-handlers/         ⏳ 阶段 5.2：前端/CI——同上，取决于 mock 物化方式
```

**没有 `manifest.json`**（阶段 3 起）：索引是**内存中按需派生**的，不落盘。`scanPrototypePatches()` 每次扫描 `patches/` 目录，返回：

```ts
{ file: 'A-001-btn-radius.css', kind: 'css', lane: 'A', order: 1, source: '…', key: 'prototype:checkout-flow:A-001-btn-radius.css' }
```

派生规则：kind 由扩展名决定，lane/order 由文件名 `{lane}-{nnn}-…` 解析，排序 = lane → order → 文件名。不符合命名的文件直接忽略。

设计要点：

- **patch 与契约 fragment 都是普通文件**，可 git diff、可被 agent 的 `Read`/`Edit` 直接改、可被外部工具处理。这是"最大化本地文件系统优势"的落点。
- **派生索引消除争用**：没有任何共享索引文件需要手写或合并，因此没有 lane 会争它（D12）。这也是阶段 6.2 已被提前满足的原因。
- **契约是唯一真源**（阶段 5），`openapi.yaml` 是从 fragment 合成的产物；mock 只是契约的运行时物化。

---

## 5. 现有可复用资产（已核对）

### 浏览器与文件通路

| 能力 | 位置 | 状态 |
|---|---|---|
| 浏览器面板（BrowserView + CDP） | `apps/electron/src/main/browser-pane-manager.ts` | 已有 |
| CDP 封装 `BrowserCDP` | `apps/electron/src/main/browser-cdp.ts` | 已有 |
| 任意 JS 执行 `evaluate` | `browser-pane-manager.ts:1643-1646` | 已有，可直接注入 |
| 元素高亮 overlay 注入 | `browser-cdp.ts:475-562`（`renderTemporaryOverlay`） | 已有，但临时，用完即清 |
| 元素标识 `@eN` ref | `browser-cdp.ts:167`（`allocateRef`） | 已有 |
| selector 定位 | `browser-cdp.ts:393`（`getElementGeometryBySelector`） | 已有 |
| 浏览器工具入口 | `packages/shared/src/agent/browser-tools.ts:233-280` | 已有，加命令即可 |
| 产物目录读白名单 | `packages/server-core/src/handlers/utils.ts:55-66` | **已覆盖**（返回 `workspace.rootPath`） |
| UI 读文件 | `PlatformContext.onReadFile`（`packages/ui/src/context/PlatformContext.tsx:83`） | 已有 |
| 文件 RPC | `packages/server-core/src/handlers/rpc/files.ts` | 只有 read 系列，**无 write** |
| 目录监听 | `packages/server-core/src/handlers/rpc/sessions.ts:470-494` | 已有，但只盯 session 目录 |

### 服务契约层

| 能力 | 位置 | 为什么能直接复用 |
|---|---|---|
| `Source` 抽象 | `packages/shared/src/sources/types.ts:16`（`'mcp' \| 'api' \| 'local'`） | **一个 API 服务 = baseUrl + auth + headers**，正是 mock 服务的形状 |
| API Source 配置 | `types.ts:370-399`（`ApiSourceConfig`） | `baseUrl` / `authType` / `defaultHeaders` / `testEndpoint` 开箱即用 |
| Source 落盘约定 | `types.ts:7-11`（`sources/{slug}/config.json` + `guide.md`） | mock 服务直接就是一个 source 目录 |
| 动态 API 工具 | `packages/shared/src/sources/api-tools.ts` + `types.ts:548-566`（`ApiConfig`） | agent 能用**同一套工具**调 mock 与调真服务 |
| MCP server 构建 | `packages/shared/src/sources/server-builder.ts` | 从 source config 起服务，mock 同构 |
| OpenAPI 已是认可载体 | `README.md:45` | 契约格式无需新发明 |
| 已有依赖 | 仓库当前**无** msw / prism | 两者均需新增（见 §7 风险） |

### 并线控制面（现成）

| 能力 | 位置 | 说明 |
|---|---|---|
| DAG 规格 | `packages/shared/src/tasks/schema.ts:135-168` | `nodes` / `depends_on` / `inputs` / `outputs` / `prompt` / `model` / `permissionMode` |
| **并行调度** | `packages/server-core/src/tasks/TaskRunner.ts:315-328` | 已是并行，非串行；`max_parallel` 默认 4（`:110`） |
| 依赖图与就绪判定 | `validate.ts:204-222`、`TaskRunner.ts:330-336` | 无依赖或依赖已完成的节点并发派发 |
| 节点输出落盘 | `tasks/storage.ts:190-214` | `tasks/{slug}/runs/{runId}/nodes/{id}.json`，`atomicWriteFileSync` |
| 输出插值 | `refs.ts:86-107` | `${nodes.<id>.output[.<field>]}` / `${params.<name>}` |
| 派生会话 | `SessionManager.ts:4224-4279` | `spawn_session`，`parentSessionId` 级联，fire-and-forget |
| 多实例并发 | `factory.ts:132-146` | 每次 `new`，无单例 → 多会话 = 多 backend 实例 |
| 结构化输出 | `schema.ts:46`、`:90-96`；`refs.ts:40-43` | **仅解析未实现**（`param`/`artifact`） → 阶段 6 需落地 |

---

## 6. 实施阶段

### 阶段 1：接线层（文件通路，无 UI）

目标：把"产物目录"变成 agent 与 App 都能读写的普通目录。

#### 1.1 产物路径工具
- 在 `packages/shared/src/workspaces/storage.ts` 新增 `getWorkspacePrototypesPath(rootPath)`、`getPrototypePath(rootPath, slug)`，与现有 `getWorkspaceSessionsPath`（`:79-89`）并列。
- **无需改读白名单**：`getWorkspaceAllowedDirs` 已返回 `workspace.rootPath`（`utils.ts:55-66`），`prototypes/` 天然在允许范围内。

#### 1.2 agent 写放行（必须改）
- 现状：Explore 模式下 `Write`/`Edit` 仅放行 `plansFolderPath`、`dataFolderPath` 和 `allowedWritePaths`（`packages/shared/src/agent/mode-manager.ts:1934-1961`）。
- 做法：照 `dataFolderPath` 的模式新增 `options.prototypesFolderPath` 例外；在注入 `dataFolderPath` 的同处一并注入（实施时定位注入点：`packages/server-core/src/sessions/SessionManager.ts` 与 session context `packages/session-tools-core/src/context.ts`）。
- 验证：Explore 模式下 agent 能 `Write` 到 `prototypes/{slug}/patches/x.css` 与 `services/.../paths/*.yaml`，且仍无法写到目录外。

#### 1.3 新增 `file:write` RPC
- `packages/shared/src/protocol/channels.ts`：新增 `file.WRITE = 'file:write'`（与 `:96-108` 的 file/fs 系列并列）。
- `packages/server-core/src/handlers/rpc/files.ts`：新增 handler，沿用 `validateFilePath(path, getWorkspaceAllowedDirs(workspaceId))`（同 `:34-37` 的写法），**并额外约束在 prototypes 目录内**。
- `apps/electron/src/transport/channel-map.ts`：新增 `writeFile: invoke(RPC_CHANNELS.file.WRITE)`（`buildClientApi` 会据此自动暴露到 `window.electronAPI`）。
- `packages/ui/src/context/PlatformContext.tsx`：新增 `onWriteFile?: (path: string, content: string) => Promise<void>`（紧邻 `:83` 的 `onReadFile`）。
- 验证：renderer 能落盘；写 `prototypes/` 之外被拒。

#### 1.4 产物目录监听
- 现状：`sessions:watchFiles` 只 watch session 目录，`fs.watch({recursive:true})` + 100ms 防抖 → 推送 `sessions:filesChanged`（`sessions.ts:470-494`；channel 定义 `channels.ts:42-44`）。
- 做法：把监听目标泛化为"白名单内任意目录"，或新增 `prototypes:watch` / `prototypes:changed` 通道，复用同一套防抖与推送逻辑。
- 注意：现有实现会忽略隐藏文件与 `session.jsonl`（`sessions.ts:480`），产物目录需保留该过滤或调整。
- 验证：外部改动 `patches/*.css` 或 `paths/*.yaml` 都能收到变更事件。

**阶段 1 完成标志**：能用 `file:read` / `file:write` 读写产物目录，且改动会推送变更事件。全程不涉及 UI 与浏览器。

---

### 阶段 2：P0 拾取器（已完成）

目标：在页面里点选元素 → 高亮 → 得到一个稳定 selector。

#### 2.1 `BrowserCDP` 新增拾取能力
- `apps/electron/src/main/browser-cdp.ts`：`pickElement(options?)` + `cancelPicker()`。
  - **实际实现与初稿的偏差**：不做 `startPicker()`/`stopPicker()` 两个方法，而是单一 `pickElement()`（注入 → 轮询 → 清理）。原因：初稿打算用"返回一个用户点击时才 resolve 的 Promise"，但那会让一次 `Runtime.evaluate` 长时间挂起，`CDP_IDLE_DETACH_MS = 5s` 的空闲 detach 会在中途触发并打断它。改成**注入一次 + 短轮询**（默认 200ms）后每次调用都很短，detach 计时器自然被重置，无需改动既有 detach 逻辑。
  - 注入脚本把结果写进 `window.__craft_agent_picker_state__`（`pending` / `picked` / `cancelled`），轮询读取；`Escape`、超时、`cancelPicker()` 三条取消路径统一走 `cancelled`。
  - 高亮复用 `renderTemporaryOverlay` 已跑通的"注入 fixed 覆盖层"模式（`pointer-events:none`），改成可交互版本。
  - `buildStableSelector(el)`：`data-testid` → `id` → 否则 `:nth-of-type` 路径（最多 6 层），与现有 `@eN` ref 体系互补。
- 说明：走 CDP 注入，`sandbox:true` + `contextIsolation:true` 下即可运行，**不改任何权限**，也不受页面 CSP 影响。
- **约束（D15）**：拾取器只回传事件，**不写文件**。

#### 2.2 贯通到工具命令
- 结果类型 `PickedElement` 定义在 `packages/shared/src/protocol/dto.ts`（**单一真源**，避免在 picker / 能力协议 / 工具命令三处漂移）。
- `browser-pane-manager-interface.ts` 的 `IBrowserPaneManager`、`browser-capability.ts` 的 `BrowserCapabilityMethod`（`pickElement`）、`RemoteBrowserPaneManager`、`NullBrowserPaneManager`、electron 的 `BrowserPaneManager.pickElement` + `dispatchCapability` 全部补齐（远程路径沿用 `getAllowRemoteEvaluate` 开关，错误码 `BROWSER_REMOTE_PICK_BLOCKED`）。
- `browser-tools.ts` 的 `BrowserPaneFns` 加 `pick`；`browser-tool-runtime.ts` 加 `pick [--timeout <ms>]` 命令分支与 `--help` 条目；`BROWSER_TOOL_DESCRIPTION` 补示例。
- `SessionManager` 把 `pick` 接到 `bpm.pickElement(instanceId, options)`。
- 文档与发布说明同步：`docs/browser-tools.md`、`release-notes/next.md`。

**阶段 2 完成标志**：`browser_tool pick` 能在页面上点选到元素并返回稳定 selector。（真实页面的往返验证需在运行中的 Electron 里做；本阶段已用单测覆盖注入脚本语法 + 轮询/取消协议 + 命令路由。）

---

### 阶段 3：持久注入与 patch（已完成）

目标：改动能叠加到真实页面、**reload 后仍保留**，并以文件形式落盘。

#### 3.1 持久注入原语
- `apps/electron/src/main/browser-cdp.ts`：`addInitScript(key, source)` / `removeInitScript(key)` / `listInitScriptKeys()`，底层是 CDP `Page.addScriptToEvaluateOnNewDocument`。
- **实际实现与初稿的偏差**：初稿打算 css 走 `injectStyle`、js 走 `addInitScript`，两条路径。改成**两者统一走 init script**（css patch 由脚本自己创建/更新 `<style>`），因为注入的 `<style>` 元素**不随 reload 保留**，而 init script 会。统一后"reload 重放"只有一条机制，live 与 reload 也不会分叉。因此没有 `injectStyle`。
- **发现并修掉一个真问题**：CDP 的 init script 注册**随 debugger 分离而失效**，而现有代码 `CDP_IDLE_DETACH_MS = 5s` 空闲即分离——不改的话"reload 保留"会在 5 秒后静默失效。现在 `resetIdleDetachTimer()` 在 `initScriptIds` 非空时直接返回（持有连接），最后一个脚本移除后恢复计时；`detach()` 同步清空键表，因为 CDP 那边也一起没了。
- `key` 由调用方指定，重复注册同一 key 会**先移除旧的**（替换语义），所以重放是幂等的。

#### 3.2 patch 索引与重放
- **不落盘 manifest**：`packages/shared/src/prototypes/storage.ts` 的 `scanPrototypePatches()` 每次从 `patches/` 目录重算索引（派生索引 D12 从第一天生效，阶段 6.2 因此已提前满足）。
- 命名约定 `{lane}-{nnn}-{slug}.{css|js}`；**不符合命名的文件被忽略**（README、编辑器备份、`.DS_Store`），不会误当 patch 执行。排序 = lane → order → 文件名，完全确定，不依赖目录列举顺序。
- `packages/shared/src/prototypes/patch-script.ts` 的 `buildPatchInitScript()` 做 patch → init script 的纯变换：css 生成"创建/更新 `<style>`"的脚本（document-start 时 `head` 可能不存在，回退到 `DOMContentLoaded`）；js 包进 IIFE + `try/catch`，一个坏 patch 不会中断其余。
- 重放流程（`SessionManager` 的 `applyPrototype`）：扫描 → 先按前缀清掉磁盘上已删除的 patch 的 key → 逐个 `addInitScript`（面向未来文档）+ `evaluate`（立即作用于当前文档，**复用同一份变换**，所以 live 与 reload 行为一致）。不需要新的 reload 能力。

#### 3.3 两条写入路径（D4 + D15）
- **确定性改动**：renderer → `onWriteFile` → `file:write`（阶段 1 已通）直写 `patches/`。实时、无需 LLM。
- **语义改动**：交给 agent 的 `Write`/`Edit`（依赖 1.2 放行）写出新 patch。
- 两条路径产出同构文件，均由 3.2 重放。**两者都不由 renderer 直接写**（D15）。
- 说明：本阶段只交付了机制与通道；**尚无 UI 触发 `file:write`**，直写路径待阶段 4/6 的交互层接上。

**阶段 3 完成标志**：手动改一个 patch 文件 → 重放即生效；reload 后改动仍在。
（真实浏览器里的往返验证需运行中的 Electron；本阶段用单测覆盖了索引扫描/排序/过滤、patch→脚本变换的语法正确性与注释结尾陷阱、以及 init script 的注册/替换/移除/detach 失效语义。）

---

### 阶段 4：导出器（已完成）

目标：`dist/` 下产出按角色分化的交付物。

#### 4.1 自包含 HTML + 变更说明
- `packages/shared/src/prototypes/export.ts`：`buildSelfContainedHtml()`（纯变换）、`buildDevSpec()`（纯变换）、`exportPrototype()`（落盘）。
- patch 内联：
  - **css** 直接内联成 `<head>` 里的一段 `<style>`。纯文本 patch 没有可"执行"的东西，内联文本与 live 注入器做的事完全等价，而且 JS 关掉也照样生效。
  - **js** 走 `buildPatchInitScript()`——**和 live 重放同一份变换**，所以"工作台内"与"导出文件"行为不会分叉。
- 注入位置：css 插在最后一个 `</head>` 前（无则退 `</body>`，再无则追加）；js 插在最后一个 `</body>` 前。顺序沿用派生索引顺序。
- `dist/dev-spec.md`：列出每个 patch 的序号/lane/kind/字符数表格 + 逐条完整内容（代码围栏长度按内容里的反引号最长连续串计算，避免被内容撑破）。
- **未做（诚实说明）**：初稿写的"target selector + 前后差异"需要 patch 侧的元数据（target、base 快照），**目前没有任何东西写这类元数据**，所以 dev-spec 只列出真实已知的信息，没有编造。要补的话得先定 patch 元数据格式（属于后续阶段）。
- `exportPrototype()` 在缺少 `base.html` 时**明确报错**而不是导出一个无意义的文件。

#### 4.2 预览通道：**结论改了——不需要新开 BrowserView**
- 初稿判断"必须单开一条受控渲染通道"，因为现有 HTML 预览 iframe 禁脚本（`MarkdownHtmlBlock.tsx:218-219`、`HTMLPreviewOverlay.tsx:204-205`）。
- 但实测发现：**现有浏览器面板本身就能打开导出产物**。[browser-pane-manager.ts](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/main/browser-pane-manager.ts#L735-L745) 的 `navigate` 对 `file://` 是放行的（scheme 正则匹配后原样 `loadURL`），而它本来就是真实引擎、能跑 JS、已沙箱隔离。
- 所以预览通道 = `browser_tool navigate <file://…/dist/prototype.html>`。这比自己搭一个 BrowserView 更好：零新增 UI、渲染环境与工作台一致（同架构同引擎），且**不改动现有预览块的安全策略**。
- `prototype-export` 因此直接返回可直接使用的 `file://` URL（用 `pathToFileURL` 生成，空格等已正确编码）。
- 遗留说明：浏览器会话是 `persist:browser-pane`（带真实登录态）。导出产物是自包含的本地文件，`file://` 是 opaque origin，读不到 https 站点的 cookie；若将来需要更强隔离，放到阶段 7 的原型分区。

**阶段 4 完成标志**：`dist/prototype.html` 自包含、可独立打开；`dist/dev-spec.md` 能让人看懂改了什么。
（单测覆盖了内联位置/顺序、无 head/body 的回退、注释结尾仍可执行、围栏不被内容撑破、导出落盘与缺 base 时报错。）

---

### 阶段 5：服务契约层（mock 就是服务）— 已完成

目标：把 mock 从"拦截技巧"升级为契约层，同一份契约同时服务前端原型与后端交付。

#### 5.1 契约真源与合成（已完成）
- 真源 = `services/{svc}/paths/*.yaml`（fragment，agent 写）+ `services/{svc}/fixtures/*.json`（数据）+ `config.json`（`baseUrl` / `authType` / `title`）。
- `packages/shared/src/prototypes/contract.ts`：
  - `parseContractFragment()` **同时接受两种写法**：显式 `paths:` 块，或直接以 `/…` 作顶层键（人们实际会写的简写）。另支持 `components.schemas` 与 `x-contract` 备注块。
  - `composeContract()` 合并 fragment → 单个 OpenAPI 3.1 文档。`$ref` 在合并后仍成立，所以 fragment 之间可以互相引用 schema。
  - **重复路径不静默丢弃**：后写的 fragment 生效，同时把该路径记入 `conflicts` 并报到命令输出里。
  - `x-mock.fixture` 引用不存在的 fixture 时记入 `missingFixtures`。
- 解析用 `yaml`（`packages/shared` 的**既有依赖**），**没有引入任何新依赖**。这一点顺带推翻了 D8——见下。
- `resolveContractServiceSlug()`：显式 `--service` > 唯一服务；多个服务时不猜，**报错并列出候选**（猜错比报错更糟）。

#### 5.2 mock 物化（已完成，实现方式已改）
初稿写"复用 MSW + Prism"（D8）。推进时比较了三条路：

1. **页面级 monkey-patch（fetch/XHR）**：不用新依赖，但 axios 走 XHR，要同时可靠地 mock XHR 相当脆弱。
2. **独立 Node mock server + 注册成 Source（原 D10）**：任何客户端都能用，且天然拿到"改 `baseUrl` 切真服务"的收益；代价是应用必须指向该端口，而"改线上真实产品"场景里请求常是同源相对路径，未必能改。
3. **CDP `Fetch` 拦截（采用）**：在浏览器网络层用 `Fetch.enable` + `Fetch.fulfillRequest` 直接兑现响应。fetch / XHR / 任何资源类型**全都覆盖**，**不需要改应用**，也不往页面里塞 monkey-patch。复用已有的 CDP 基建，且**零新依赖**。

→ 结论：**D8 改为"不引入 MSW / Prism，mock 用 CDP Fetch 拦截在浏览器网络层实现"**；D10（mock = `baseUrl` 指向本地的 Source）保留为"需要 agent 也能调 mock"时的补充手段，不作为 MVP 前置。

实现要点：
- `BrowserCDP.setFetchMockRoutes(routes)` / `clearFetchMock()`：开启 `Fetch.enable`（`requestStage: 'Request'`），在 `Fetch.requestPaused` 事件里决定 `fulfillRequest` 还是 `continueRequest`。
- **匹配只按 pathname**（`pathname === route.path`，或 `endsWith(route.path)`），所以绝对 URL、带 `baseUrl` 前缀的 URL、同源相对路径三种写法都能命中；路径前的 `/` 让 `endsWith` 天然有边界（`/reorders` 不会命中 `/orders`）。
- 兑现的响应**带 `access-control-allow-origin: *`**：否则跨域接口即使由我们应答，仍会被浏览器按 CORS 拦掉。
- **异常兜底再 `continueRequest`**：一个永远挂着未决断的请求会让页面直接卡死，这条比"mock 失败"严重得多。
- `Fetch.enable` 同样是 CDP 会话状态 → 纳入阶段 3 那个 `holdsSessionState()` 判据（有 init script 或开着 mock 就持有连接，避免空闲 detach 把它悄悄关掉）。
- `buildMockRoutes(service)`（纯函数）：`x-mock.fixture` 指向不存在的 fixture 时**跳过该路由并上报**，而不是返回空 body——静默的空响应比"请求打到真后端"难查得多。
- 命令：`prototype-mock-apply <slug> [--service <svc>]`、`prototype-mock-clear`。

#### 5.4 后端交付导出（已完成）
- `exportContractDeliverable()` 写 `dist/openapi.yaml`（合成结果）+ `dist/contract.md` + `dist/fixtures/*.json`。
- **"契约 ⊃ mock" 的落地方式**：`contract.md` 除了列出端点与已声明的错误响应，还**显式点名"没声明的东西"**——错误语义（没有任何非 2xx）、鉴权（`config.json` 无 `authType`）、契约备注（没有 fragment 带 `x-contract`，即分页/排序/幂等/并发均未记录）。这比编造字段诚实，也正好是后端接手前必须补齐的清单。
- 命令：`prototype-contract-compose <slug> [--service <svc>]`、`prototype-contract-export <slug> [--service <svc>]`。

**阶段 5 完成标志（已达成）**：契约能从 fragment 合成 `openapi.yaml`；产出后端可用的 `dist/openapi.yaml` + `contract.md` + fixtures；mock 能在原型里跑通（fetch 与 XHR 都覆盖，应用无需改指向）。
（单测覆盖：两种 fragment 写法的解析、非法 YAML 报错、服务发现与歧义拒绝、合并与 `$ref` 兼容、重复路径与缺失 fixture 的检出、`contract.md` 对"未声明项"的点名、导出落盘、mock 路由构建，以及 Fetch 拦截的开启/命中/放行/失败兜底/关闭/detach 失效。）

---

### 阶段 6：平面分离与并线接线 — 6.1 已完成，6.4 明确推迟

目标：让多个 lane 能安全并行写产物，用**所有权**而非锁保证正确性。

#### 6.1 所有权矩阵落地（已完成）
- `packages/shared/src/prototypes/ownership.ts`：把 §3.5 的矩阵写成**可执行判据**，而不是文档里的一张表。
  - `classifyPrototypePath(rel)` → `{ owner: {kind:'lane'|'control-plane'} }` 或 `{ violation }`。
  - **patch 的 owner 由文件名里的 lane 决定**（不是固定规则）——这正是"任何 lane 都能追加自己的 patch、零争用"的前提。
  - `canLaneWrite(rel, lane)` → 越界写返回 `{ ok:false, reason }`（"owned by lane B" / "owned by the control plane"）。
  - `resolvePrototypeOwnership()` 遍历项目，跳过隐藏文件，产出违例清单。
- **取证到的真实价值**：它会抓出三类此前静默存在的问题——lane 前缀未声明的 patch（`patches/Z-…`）、命名不合规的 patch（`patches/oops.css`）、以及没人拥有的路径（`README.md`、`services/*/random.txt`）。这类文件以前会被 patch 扫描**静默忽略**，现在会被点名。
- `prototype-status <slug>`：控制面视角的只读报告 —— `base.html` 是否存在、patch 总数与按 lane 分布、每个服务的端点/mock 覆盖/fragment/fixture 数、`dist/` 内容、以及所有权违例。纯文件检查，不解析浏览器实例。

#### 6.2 派生索引（阶段 3 已提前完成）
- 结论是**比原方案更进一步**：不落盘 manifest，索引每次从 `patches/` 重算（`scanPrototypePatches`），所以不存在"索引与磁盘不一致"这个状态，也就没有重建时机的问题。

#### 6.3 契约 fragment 化 + 合成（阶段 5 已提前完成）
- `services/{svc}/paths/*.yaml`（lane B 独占写）+ 控制面合成 `openapi.yaml`（`writeComposedContract`）。合成是控制面的独占写，无需锁。

#### 6.4 挂接 Tasks DAG（明确推迟，非遗漏）
原计划把"工作台任务 = 一个 TaskSpec、lane = 一个 node"接起来。**现在不做，理由是它当前不产生价值、只增加表面积**：
- 并线要解决的是**写冲突**，而写冲突的解法已经落地了——派生索引（无共享文件）、按 lane 命名的 append-only patch、fragment 化契约、所有权矩阵。真正会互相覆盖的路径已经不存在了。
- `TaskRunner` 的并行调度解决的是**多个 agent 同时干活**。当前是单用户 + 单 agent 的工作台，接上 DAG 只会多一层生命周期（Conductor、父子 session、verdict 回路）而没有并发的收益。
- 而且 v1 的结构化输出（`param`/`artifact`）尚未实现 —— 原计划里 lane 之间靠 `${nodes.X.output.field}` 传产物路径，缺少这一环的话接上去也只能传自由文本，等于白接。

→ **触发条件**：当确实要同时跑多个 agent（例如 lane A 改 UI、lane B 同时补契约），再按 §3.4 的映射接 DAG，并把 `NodeOutput.params` 落地。届时 `canLaneWrite()` 就是每个 node 的写前守卫。

#### 6.5 拾取器是传感器（D15，设计上已满足）
- 拾取器只回传事件（`pick` 返回 selector/矩形，不写文件）；写盘一律由控制面（`file:write` RPC）或 agent 的 `Write`/`Edit` 执行。
- 因此 renderer 侧不存在写文件调用 —— 这是 D15 要求的实际形态。

**阶段 6 完成标志（已达成部分）**：所有权矩阵可执行且能抓出越界/命名/无主路径；`prototype-status` 能给出项目全貌；patch 与契约的写入天然无争用（派生索引 + append-only + fragment 化）。**"两个 lane 并发跑"未做**，理由与触发条件见 6.4。

---

### 阶段 7（后置）：放开面 / overlay 改写 / 无中生有 — 两项已完成，两项待决策

**明确区分两类不同需求**：

| | 需求 | 机制 | 状态 |
|---|---|---|---|
| (a) | 模拟**尚不存在**的接口 | 契约 + mock runtime | ✅ 阶段 5 |
| (b) | 改写**已存在**的真实后端返回 | CDP Fetch 拦截 | ✅ **阶段 7，靠阶段 5 的机制自然获得** |

#### 已完成：无中生有入口（`prototype-open <slug>`）
- 初稿把"无中生有"列为阶段 7 的独立能力，其实它**不需要新机制**：agent 在阶段 1.2 起就能写 `prototypes/{slug}/base.html`（Explore 白名单已覆盖），而 `navigate` 一直能打开 `file://`。
- 补的是入口体验：`resolvePrototypeEntry()` 决定"该打开哪个文件"——**优先导出产物**（那才是要交付的东西），否则回退 `base.html`；两者都没有时**明确报错并给出两条出路**，而不是让浏览器里报一个含糊的失败。
- 命令 `prototype-open <slug>` 复用了既有的 `navigate`，没有新增导航能力。

#### 已完成：overlay 改写真实后端（无需新机制）
- 初稿认为 (b) 需要扩展 `ses.webRequest.onBeforeRequest` + 新增 `onHeadersReceived`。
- 实测发现：阶段 5 的 mock **匹配只按 pathname、与 host 无关**，所以一条 `/api/orders` 的路由会同样拦截 `https://api.production.example.com/api/orders`。**(b) 就是 (a) 的同一个机制**，只是路由来源不同。
- 已加测试固定这个行为（对生产域名发起的请求被本机路由兑现）。
- 因此**不需要**为响应体重写去改 `webRequest`。真正仍需新机制的是"**只改响应头/状态码但保留真实 body**"（需要在 `Response` 阶段拦截），这一条没做。

#### 已决策：放开面 partition（`webSecurity:false`）—— 决定**不开**
- 原计划：新增 `PROTOTYPE_PARTITION = 'persist:prototype-lab'`，仅该 partition 允许 `webSecurity:false`；`persist:browser-pane` 保持锁死；原型面禁 `file://` 导航。
- **推进到这一步时发现两件事**，因此改变结论：
  1. `webSecurity:false` 买到的能力（页面 JS 跨域读 iframe DOM、免 CORS 发跨域请求）**都能从外部用 CDP 达到**（`Target.setAutoAttach` 读任意 frame；`Fetch` 兑现响应）。四个诉求里三个已交付，剩下一个用 CDP 也能做。
  2. 代价是**真实的、不可回退的安全弱化**——同源策略一关，该 renderer 里任何页面脚本都能读任意跨域响应；若 `file://` 导航没堵住还能读本地文件。收益只是"省掉一层 CDP 封装"。
- **结论（用户已确认）：不开。** 全部能力改走 CDP。因此 `persist:browser-pane` 的姿态从头到尾没有变：`sandbox:true` / `contextIsolation:true` / `nodeIntegration:false` / `webSecurity` 默认开。
- 若将来真撞到"CDP 做不了、必须页面 JS 自己跨域"的具体场景，再回到本节的隔离设计（独立 partition + 无凭据 + 禁 `file://` + 风险提示）。

#### 未做：跨域 iframe 读取（`Target.setAutoAttach`）
- 需要 `BrowserCDP` 处理 `Target.attachedToTarget`、拿到 OOPIF 子会话、在目标 frame 上 `Runtime.evaluate`。
- 不改任何安全姿态，但**必须在真实浏览器里验证**（frame 拓扑与 OOPIF 行为无法靠单测断言），所以没有在无法运行 Electron 的情况下盲写。等实际遇到需要读跨域 iframe 的场景再做。

#### 已知未做
- 响应头/状态码的**就地改写**（保留真实 body）——需要在 `Fetch` 的 `Response` 阶段拦截。
- 原型面 partition 参数化与导航白名单（`webSecurity` 已决定不开，这一项只在回退到"开"时才需要）。

**阶段 7 完成标志（已达成部分）**：无中生有有了一等入口；改写真实后端返回可用且有测试固定；安全姿态未改动。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Explore 模式拦截写 | agent 写不进 `prototypes/` | 阶段 1.2 新增 `prototypesFolderPath` 例外（**必做，否则阶段 3 / 5 / 6 阻塞**） |
| 现有 HTML 预览禁 JS | 原型跑不起来 | **已解决**：预览走浏览器面板的 `file://`（阶段 4.2），不动现有预览块安全策略 |
| `file://` + `webSecurity:false` | 本地文件可被读取 | **已作废**：`webSecurity` 决定不开，该组合不存在 |
| 线上页面改版 / 登录态 | 抓取的 base 失效 | D2 Hybrid：编辑走 overlay，交付走 snapshot |
| `webSecurity:false` 的杀伤面 | 页面可读跨域响应 | **已作废**：决定不开；能力改由 CDP 提供 |
| 注入被页面 CSP 拦截 | 注入失效 | `Page.addScriptToEvaluateOnNewDocument` 走 CDP，高于页面 CSP |
| 契约 ⊃ mock | 后端交付不完整 | 阶段 5.4 显式补齐分页/错误/幂等/鉴权等契约内容 |
| 契约漂移 | 真后端实现后与契约不一致 | 用同一份契约做对照回归（`x-mock` 按 pathname 匹配，切真后端无需改代码） |
| OpenAPI 只适配 REST | 非 REST 产品套不上 | 若产品是 GraphQL/RPC 需另定格式（当前假设 REST） |
| ~~MSW / Prism 是新依赖~~ | ~~引入体积与维护面~~ | **已作废**：D8 修订后改用 CDP Fetch，零新依赖 |
| PM 不写 YAML | 契约无人维护 | 契约由 agent 生成维护（D4 语义写通道） |
| **Fetch 拦截拖慢页面** | 所有请求都过主进程一轮 | 未在真实环境量过；若明显变慢，可把 `Fetch.enable` 的 pattern 收窄到目标接口域（目前是 `*`） |
| **无锁导致静默丢数据** | 并发写同文件 last-writer-wins | 用所有权代替锁（§3.3）；单文件资源只由控制面写 |
| **`atomicWriteFileSync` 固定 `.tmp`** | 并发写同路径争用临时文件 | 产物写路径经控制面串行化；或为每个写者用唯一 `.tmp` 名 |
| **派生索引一致性** | 索引与磁盘不一致 | 索引可随时从磁盘重建（阶段 6.2）；导出前强制重建 |
| **lane 边界被越写** | 所有权模型失效 | 阶段 6.1 写前校验 owner，越界拒绝并告警 |
| **Tasks 结构化输出未实现** | 下游 lane 无法可靠消费上游产物 | 阶段 6.4 落地 `NodeOutput.params` |
| **Tasks 只执行 session 节点** | 无法用 `verify`/`aggregate` 表达编排 | 阶段 6 用 session 节点模拟，不依赖 P4 |
| **`tsconfig.base.json` 缺失（既有问题）** | `typecheck:all` 在 session-tools-core 处中断，`validate:dev` 不可用 | 仓库既有缺陷：`session-tools-core` / `pi-agent-server` / `session-mcp-server` 的 tsconfig 引用了一个不存在的根 `tsconfig.base.json`。本次改动改为按包逐个 typecheck，全部通过 |
| **mode-manager 既有测试失败** | 干扰回归判断 | 与本次改动无关：已用 `git stash push -- packages/shared/src/agent/mode-manager.ts` 定向回退验证，失败集合完全一致。属环境相关既有失败 |
| **加 handler 会打破注册表测试（本次踩到）** | 新增 `registerXxxHandlers` 会让注册表断言失败 | `registration.test.ts` / `registration-profiles.test.ts` 用各 handler 模块的 `HANDLED_CHANNELS` 拼期望集合。新增 handler 必须同步把 `...prototypes.HANDLED_CHANNELS` 加进去（已在阶段 3 修好） |
| **既有失败清单（改代码前请先基线）** | 容易被误判为本次引入 | 全量扫 `apps/electron/src/main` + `packages/shared/src/agent/__tests__` + `prototypes` 共 1013 个测试，13 个既有失败：`BrowserPaneManager` 8 个（已 stash 验证）、`mode-manager-path-boundary` 2 个（该文件缺 `setPowerShellValidatorRoot()`）、`spawn-session-tilde-expansion` 1 个（Windows 上期望 POSIX 路径）、`buildCallLlmRequest` 1 个（测试留下 `__tmp_build_call_llm__` 临时目录）、`ensureDefaultPermissions` 1 个。**改动前先跑一遍基线，别把这些算到新改动头上** |

---

## 8. 验收标准（MVP）

### UI 与文件通路

1. 在本地 dev server 页面上能点选任意元素，拿到稳定 selector，重复点选结果一致。
2. 选中后做出的改动**立即反映在页面上**，并把 patch 落成 `patches/` 下的文件。
3. 手动编辑该 patch 文件，页面随之更新（`fs.watch` 通路有效）。
4. 刷新 / 重开页面，改动**依然存在**（patch 重放有效）。
5. `dist/prototype.html` 可独立打开并保留全部改动；`dist/dev-spec.md` 可读地说明改了什么。

### 服务契约层

6. 能合成一份 `openapi.yaml`，并被 Prism 直接起成可用的 mock server。
7. 由同一份契约生成的 MSW handler 能让原型在浏览器内跑通（不起服务）。
8. 把某个 source 的 `baseUrl` 从 mock 端口改成真后端地址后，原型无需其他改动即可对接（**同构验证**）。
9. `dist/openapi.yaml` 除了端点与 schema，还包含分页/错误/幂等/鉴权约定。

### 平面分离与并线

10. 两个 lane 并发写各自的产物文件，**互不覆盖**（人工构造并发写验证）。
11. `manifest.json` 删除后能从磁盘**重建且内容一致**。
12. lane 试图写不属于它的文件时被拒绝并有告警。
13. 拾取器路径上不存在任何直接文件写（renderer 只发事件）。
14. 一个工作台任务能被表达为一个 Task（lane = node），且 `depends_on` 生效。

### 安全底线

15. 全流程不降低现有安全姿态：真实产品面仍是 `sandbox:true` / `contextIsolation:true` / `nodeIntegration:false`。

---

## 9. 实施顺序与依赖

```
阶段1.1 路径工具 ──┬─→ 阶段1.3 file:write ──→ 阶段3.3 直写落盘
                  ├─→ 阶段1.2 Explore 放行 ─┬→ 阶段3.3 agent 写入
                  │                        └→ 阶段5.1 契约维护
                  └─→ 阶段1.4 目录监听 ──┬─→ 阶段3.2 patch 重放
                                          └─→ 阶段6.2 派生索引重建
阶段2 拾取器（只依赖现有 CDP，可与阶段1并行）
                              ↓
                     阶段3 持久注入与 patch
                              ↓
                     阶段4 导出器
                              ↓
                     阶段5 服务契约层（5.1 依赖 1.2）
                              ↓
                     阶段6 平面分离与并线（6.2/6.3 已由阶段 3/5 提前完成；6.4 按触发条件推迟）
                              ↓
                     阶段7 无中生有入口 + 改写真实后端（放开面：决定不做）
```

- **硬阻塞**：阶段 1.2（Explore 放行）同时卡住阶段 3、5、6。已完成。
- **可并行**：阶段 2 不依赖阶段 1。
- **并线不新增调度器**：写冲突已由"派生索引 + append-only patch + fragment 化契约 + 所有权矩阵"消除；多 agent 调度按 §6.4 的触发条件再接 TaskRunner。

---

## 10. 试用手册（端到端）

跑起 Electron 后，按下面的顺序走一遍，就能覆盖全部已交付能力。**前 5 步是核心闭环**，也是唯一没能在单测里验证的环节。

> ⚠️ **端口**：`bun run electron:dev` 会占用 **5173**（renderer 的 vite）。所以你的产品 dev server 必须跑在**别的端口**（示例用 3000）。另外 `electron-dev.ts` 启动时会**无条件 kill 掉占用 5173 的进程**，别让产品 dev server 占这个口。

> **关于 slug**：A–E 保留了显式 slug 的写法（便于照抄，也验证显式路径）。若会话已绑定该原型（§11 / 步骤 F），这些命令的 slug 都可以省略。

### A. 在真实页面上改（核心闭环）

1. `browser_tool navigate http://localhost:3000/checkout`（你的产品 dev server，**不是** 5173）
2. `browser_tool pick` → 光标高亮跟随，点一个元素 → 拿到稳定 selector
3. 让 agent 写一个 patch：`prototypes/checkout-flow/patches/A-001-btn.css`
4. `browser_tool prototype-apply checkout-flow` → 页面**立刻**变化
5. **手动 reload 页面** → 改动**仍在**（这是"持久注入"的验收点；也是阶段 3 修掉那个 detach 坑要保证的行为）

> 第 5 步是整条链路里最值得盯的一步：它依赖"CDP 注册不随空闲 detach 失效"这个改动。

> 产物落在 `~/.craft-agent/workspaces/<当前 workspace>/prototypes/`。当前会话属于哪个 workspace，`prototype-status` 里的 `dir` 会直接告诉你。

### B. 从零做一个原型

6. 让 agent 直接写 `prototypes/quotes-flow/base.html`（不需要任何特殊命令）
7. `browser_tool prototype-open quotes-flow` → 在浏览器面板里打开；再按 A 的 3–5 加 patch

### C. mock 就是服务（契约 → 前端 → 后端）

8. 让 agent 写：
   - `prototypes/checkout-flow/services/checkout-api/paths/list-orders.yaml`（含 `x-mock.fixture`）
   - `prototypes/checkout-flow/services/checkout-api/fixtures/list-orders-200.json`
9. `browser_tool prototype-mock-apply checkout-flow` → 原型有数据了（**fetch 和 axios 都覆盖**，应用不用改指向）
10. `browser_tool prototype-contract-export checkout-flow` → `dist/openapi.yaml` + `dist/contract.md` + `dist/fixtures/`，把 `dist/` 交给后端
11. `browser_tool prototype-mock-clear` → 请求打回真实后端。**代码一行不用改** —— 这就是"mock 与真服务同构"

> 想看 `contract.md` 有什么价值：故意只声明 200 响应、不写 `authType`、不写 `x-contract`，它会**点名这三处缺失**，正好是后端接手前必须补的清单。

### D. 交付与验收

12. `browser_tool prototype-export checkout-flow` → `dist/prototype.html` 自包含，命令会打印 `file://` URL
13. `browser_tool prototype-open checkout-flow` → 优先打开的就是这个交付物，验证它**脱离工作台也能跑**
14. `browser_tool prototype-status checkout-flow` → 全貌 + 所有权检查

### E. 故意制造一个所有权违例

15. 写一个 `prototypes/checkout-flow/patches/oops.css`（不符合 `{lane}-{nnn}-{name}.css`）
16. `browser_tool prototype-status checkout-flow` → 应该点名它"misnamed patch"

这条验证的是：**以前会被静默忽略的文件，现在会被抓出来**。

### 试用时重点观察两件事

| 观察点 | 为什么 | 若不对怎么调 |
|---|---|---|
| reload 后 patch 还在吗 | 依赖"持有连接以免 detach"的改动 | 看主进程日志有没有 `idle detach` |
| 开着 mock 时页面是否明显变慢 | `Fetch.enable` 目前用 `*` 匹配**所有**请求，每个都过主进程一轮 | 把 pattern 收窄到目标接口域（`browser-cdp.ts` 的 `setFetchMockRoutes`） |

### F. 对话入口与绑定（§11 的验收）

17. 在原型详情页点 **Open conversation** → 进入一个已绑定该原型的会话（已有绑定会话时直接跳过去，不新建）
18. 在这个会话里说「应用补丁」——**不用提原型名**，agent 会执行 `prototype-apply` 并落到该原型
19. 对 agent 说「列一下有哪些原型」→ `prototype-list`，输出里当前绑定的那个标 **BOUND**
20. 点会话标题右侧的**烧瓶图标** → 切换/解绑原型；切换后 badge 立即变化（靠 `prototype_slug_changed` 事件，不是本地状态）
21. 在**新会话**里对 agent 说「给我建个 checkout 原型」→ `prototype-create checkout`，它会**建完自动绑定**，随后 `prototype-apply` 无需 slug

> 第 18 步是本节的验收点：它验证的是 prompt 注入（agent 知道当前原型）+ slug 回退（命令缺省取绑定）**两条链路都通**。若 agent 仍要求你提供 slug，看主进程日志里 system prompt 是否含 `<prototype_context>`。

---

## 11. 会话 ↔ 原型绑定（对话入口）

**问题**：`prototype-*` 命令原本每条都必须显式传 slug，而 agent 无从知道"当前在哪个原型"——一个 workspace 可以有多个原型。于是每次对话都要人肉报名。

**结论**：复用仓库里**已有**的 session ↔ project 绑定范式，不发明新机制。该范式五层俱全，照抄即可。

### 11.1 五层链路

| 层 | 位置 | 说明 |
|---|---|---|
| L1 字段 | `SESSION_PERSISTENT_FIELDS` + `SessionConfig.prototypeSlug` | 加入白名单数组即自动获得 JSONL 读写（`pickSessionFields` 驱动） |
| L2 设置 | `SessionManager.setSessionPrototypeSlug()` | 镜像 `setSessionProjectId`：写字段 → 推事件 → 持久化 → 通知 watcher |
| L3 通道 | `sessionCommand { type: 'setPrototypeSlug' }` + `prototype_slug_changed` 事件 | 渲染层 → 主进程；事件回流刷新 badge |
| L4 注入 | `buildPrototypePromptContext()` → `<prototype_context>` | 与 `<project_context>` 并列注入 system prompt |
| L5 工具 | `resolvePrototypeSlug()`：显式 slug → 会话绑定 → 报错 | 缺省取绑定，这才是"不用报名"的兑现点 |

### 11.2 三个设计判断

**① prompt 块是快照，不是实时视图。**
`ClaudeAgent` 在首次 chat 时 pin 住（与 `pinnedProjectContext` 一致），因为 SDK resume 与 prompt caching 都要求 system prompt 稳定。代价是 agent 看不到本轮新增的 patch —— 所以块内**明确写了这一点**并指示它用 `prototype-status` 复查。稳定性换来的收益大于实时性。

**② 绑定不校验 slug 是否存在。**
`setSessionPrototypeSlug` 故意不检查磁盘。理由：`prototype-create` 需要"建完即绑"，若先要求存在就死锁；且原型可被删除重建而会话不该因此报错。校验放在**命令**侧（`prototype-bind` 会拒绝未知 slug 并列出可选项），因为那里有 `listPrototypes` 可用。

**③ `prototype-create` 顺带绑定。**
创建的目的是用它；分开两步会强制用户走一遍正是绑定要消除的 slug 流程。这是**唯一**带隐含副作用的命令，输出里明说了"已绑定"。

### 11.3 新增的三个命令

| 命令 | 作用 |
|---|---|
| `prototype-list` | 列出工作区所有原型 + 标注当前绑定（`BOUND`）。**没有它，未绑定会话里的 agent 无法发现任何原型** |
| `prototype-create <name>` | 创建 + 自动绑定 |
| `prototype-bind <slug\|--clear>` | 绑定已有原型 / 解绑；拒绝不存在的 slug 并列出可选项 |

### 11.4 两处 UI 入口

- **正向（面板 → 会话）**：原型详情页的 **Open conversation**。已存在绑定会话则跳过去，否则新建。理由是原型长期存在且会被反复回来，"每次都新建"既堆积会话又丢掉之前的讨论。
- **反向（会话 → 面板）**：会话标题栏的烧瓶图标（`PrototypeBindingMenu`）。显示当前绑定（有绑定则高亮），可切换、解绑、跳回面板。原型列表在**打开菜单时**读取，避免用页面加载时的陈旧快照。

### 11.5 与 project 绑定的差异（有意为之）

| 维度 | project | prototype |
|---|---|---|
| 创建时绑定 | 继承项目 `workingDirectory` | 继承父会话绑定（子任务同属一个原型） |
| prompt 块 | 名称 / 描述 / assets / MEMORY.md | slug / base 状态 / patch 清单 / 契约覆盖 / 所有权违规 |
| 命令回退 | 无（project 不驱动工具） | **有**：9 个 `prototype-*` 命令缺省取绑定 |
| 缺失处理 | 项目被删 → 解析为 null，退化为未绑定 | 同左（`existsSync` 判目录，因为 `buildPrototypeStatus` 对不存在的项目返回"空项目"而非报错） |

