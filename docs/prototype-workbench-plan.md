# 产品经理需求生产工作台 — 实施方案

> 状态：**核心闭环已交付**——创建（侧边栏「原型」+ 面板「+」+ 空态按钮）→ 详情页三个动作（预览 / 在对话里改 / 导出给开发）→ 面板工具栏「选中元素 / 应用补丁」→ 交付物 `dist/extension/`。**两种原型类型（§13）**：`overlay` / `scratch`，创建时确定、不可改，落在 `config.json` 并被详情页、system prompt、agent 命令共读；overlay 的地址创建时必填、之后可改（§13.2.1）。**会话 ↔ 原型绑定（§11）**：system prompt 带 `<prototype_context>`，`prototype-*` 的 slug 可选。**编辑只走对话（§12.4）**：选中元素只回答"哪一个元素"，补丁只有一个来源（agent 写）。**参考关系（§14）**：参考是独立原型 + 一条 `references`，规矩是"翻译不要搬运"；起点靠列表的「复制」另起一个新原型（§13.1.1）。**scratch 的载体（§16）**：Electron 直接应答 `http`（`protocol.handle`，不是监听一个端口），一个原型一个 host、目录即 origin 根，根路径是该原型的**首页**。**交付物（§17）**：一个原型一个可加载的 Chrome 扩展（Load unpacked，不进商店），mock 默认一起交付；agent 的契约不变，内联脚本与 `onclick` 由生成器吸收。**多页（§18 → §19）**：页是原型的一部分，导出时**每个真实 URL 各一个 match pattern**、scratch 的每一页也都在包里。**页层模型（§19，已实现）**：`kind` 从原型**下沉到页**——一个原型是一张有顺序的页表，每页各自是 scratch 或 overlay；补丁按 `patches/<页名>/` 分页（根 = 共享）；`/` 打开入口页，没标入口时是宿主生成的**页索引**（`/_index` 恒可达）；导出覆盖整条流程，options 页 = 页索引。旧原型零迁移（旧 config 按页表读）。落点见 [开发文档](prototype-workbench-dev.md) §1／§2。阶段 6.4（Tasks DAG 并线）与阶段 7 的放开面按各自结论**不做/推迟**，响应头就地改写未做。
>
> **读旧章节时的一个约定**：本文 §1–§18 是逐阶段写下的，其中"`base.html` 是入口页/裸底稿""`kind` 与 `targetUrl` 属于原型"这两类说法在 §19 之后不再成立（各自章节开头已标注）。**冲突时以 §19 为准**；与 §19 无关的部分照旧有效。
>
> 实现细节、踩过的坑、以及已经删掉的机制见 [开发文档](prototype-workbench-dev.md)；本文只写设计与决策。
> 范围：MVP（个人使用，先增量模式）
> 前置结论：本方案基于对现有代码的实测核对，所有引用均带文件路径与行号。

---

## 1. 定位与范围

**一句话定位**：一个真实浏览器引擎 + 一层 UI patch + **一层服务契约** + 一组导出器，由**现有 Tasks DAG 作为控制面**编排多 lane 并线，两个入口（真实网页 / 生成的空页）。

**与 Pencil 的关系**：不是"替代画布"，而是补上 Pencil 覆盖不到的生态位——Pencil 在空白画布上"无中生有"并生成代码；本工作台在**真实产品**上做增量，并把增量变成开发能用的东西。核心差异是**渲染载体**：Pencil 用矢量画布（矢量 → 代码，有翻译损耗），本方案用真实浏览器引擎（只有一种表示，所见即代码）。

**脱离纯前端视角**：mock 不是"拦截浏览器请求的技巧"，而是**服务契约层**。mock 是服务契约的一种运行时物化，同一个契约同时面向前端与后端交付。

**平面分离**：数据面 / 控制面 / 业务逻辑 / 渲染四者相互分离。这不是为了整齐，而是**多 agent 并线能成立的前提**（见 §3）。

**决定一切的分野是产物性质，不是运行环境**。一个原型有两种起点，产出的东西性质完全不同：

| | 源页面 | 我们改的是 | 产物 | 能回流源码吗 |
|---|---|---|---|---|
| **外部页（overlay）** | 别人的（产品 dev server / 测试环境 / 线上，**都算这一类**） | 我们注入的 patch 覆盖层，打在**那个在线页面本身**上 | patch + `dev-spec.md`（含 `Applies to: <地址>`） | **不能**。它是给开发的**可执行规格**，由人翻译进源码 |
| **自建页（scratch）** | 我们的 `base.html` | 我们自己的 HTML | 完整页面（自包含 HTML + spec） | 不适用，它本来就是源码 |

两者之间**没有桥**：overlay 的补丁打在活页面上，不需要一份 `base.html`；`base.html` 只属于 scratch。于是"三态"（纯覆盖 → 快照 → 纯自有）收敛成两态。（曾经设计过"把在线页冻成 `base.html`"这条路，删掉的理由见 [开发文档](prototype-workbench-dev.md) §4。）

由此得出两条推论：

1. **「产品 dev server vs 线上 URL」不是设计维度。** 无论哪一个，patch 都是覆盖层，都不回流源码；dev server 的「DOM 可控、无登录态」只降低**排错**成本，不改变**产出**。
2. **在线场景更多，且不需要为登录做任何事。** 目标站点要登录时，**用户在窗口里自己登** —— 这里没有自动化登录，所以「已登录」只是页面的一种普通状态，和处理它无关。三条机制保证这一点成立：注入按 document 生效（`Page.addScriptToEvaluateOnNewDocument`），登录跳转后自动重新执行；准备阶段那个 `browser_tool` 窗口与原型窗口共用 `persist:browser-pane` partition，所以登录一次、原型窗口打开同一地址就带着它；空闲 detach 后 `send()` 会 `ensureAttached()` 自动重连，且一旦应用过 patch（`holdsSessionState()`）就不再 detach。

这张表不是**分析结论**，而是**产品结构**：它落成了两个原型类型（`overlay` / `scratch`），在创建时确定、不可改，见 §13。第三个诉求（逆向第三方再搭自己的，§14）**不新增类型**——它只新增一条关系（`references`）和一条护栏。

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
| D3 | 产物位置 | `{workspaceRootPath}/prototypes/{slug}/` | 跨会话长期存活，契合"同一项目多交付" |
| D4 | 写通道 | 混合：确定性改动走新增 `file:write` 直写；语义改动走 agent `Write`/`Edit` | 实时性与可审计性兼顾，最终同一真源 |
| D5 | 权限模型 | 所有浏览器窗口同一个 lock-down 姿态：`sandbox:true` / `contextIsolation:true` / `nodeIntegration:false` / `webSecurity` 默认开 | 注入与跨域都由 CDP 提供，不需要页面脚本自己跨域（放开面已决定不做，见阶段 7） |
| D7 | 服务契约格式 | **OpenAPI 3.1** | REST 生态最成熟，后端与工具链都能直接吃 |
| D8 | mock 运行时 | **CDP `Fetch` 拦截**（网络层 `fulfillRequest`） | fetch / XHR / 任意资源全覆盖，**应用一行不改**，零新依赖，复用已有 CDP 基建 |
| D9 | mock 状态 | **MVP 无状态 fixtures**（状态化后置） | 覆盖"跑假数据"；需要演多步流程时再说 |
| D10 | mock 与服务的关系 | **补充手段**：需要 agent 也能调 mock 时，把 mock 做成 `baseUrl` 指向本地的 Source | mock ↔ 真服务切换只改 `baseUrl`；MVP 的 mock 走 CDP 拦截，不依赖它 |
| D11 | 并线的控制面 | **复用 Tasks DAG + TaskRunner** | 已并行（`max_parallel` 默认 4）、已持久化、已支持依赖图 |
| D12 | 单文件争用 | **不落盘索引，按需派生** | 彻底消除最大争用点：索引由控制面从磁盘扫描得出 |
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
{workspaceRootPath}/prototypes/{slug}/
  ├─ config.json            【§13/§14/§19】页表（每页 name / kind / url? / entry?）、参考列表；控制面独占
  ├─ _layout.html           【可选】scratch 页的共享外壳，一个插槽（§19.2）
  ├─ cart.html              顶层每个 *.html 都是这个原型的一页（scratch，文件名即页名）；**创建时不预置**，首稿由 agent 写，或由列表「复制」而来
  ├─ patches/               每 patch 一个文件，append-only + 唯一命名
  │    ├─ A-001-btn-radius.css       根 = 每一页都重放（共享）
  │    └─ cart/B-002-flow-guard.js   子目录 = 只在这一页重放（§19.4）
  ├─ services/              服务契约（mock 的真源，阶段 5）
  │    └─ {serviceSlug}/
  │         ├─ config.json          baseUrl / authType / title
  │         ├─ paths/               按端点拆的契约 fragment（lane B 独占）
  │         ├─ openapi.yaml         【合成】控制面由 paths/ 生成，勿手改
  │         └─ fixtures/            lane C 独占
  └─ dist/                  交付物（按角色分化）
       ├─ extension/           【§17】一个可加载的扩展：manifest / README / 补丁产物 / 脚本；scratch 另含每一页与它被提取出来的产物
       ├─ dev-spec.md          给实现的人——改了什么
       ├─ openapi.yaml         后端——契约
       ├─ contract.md          后端——交接文档（含"未声明项"清单）
       └─ fixtures/            后端/CI——响应样例
```

**没有落盘的索引**：索引是**内存中按需派生**的，不落盘。`scanPrototypePatches()` 每次扫描 `patches/` 目录，返回：

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
| 文件 RPC | `packages/server-core/src/handlers/rpc/files.ts` | 阶段 1 起有 `file:write`（另见阶段 1.3） |
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
| 已有依赖 | mock **不需要新依赖** | 拦截由既有 CDP 封装提供（阶段 5） |

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
  - **实现形态**：单一 `pickElement()`（注入 → 短轮询 → 清理），不做一对 start/stop 方法——一次 `Runtime.evaluate` 不能长时间挂起，否则会被 CDP 的空闲 detach 打断。
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
- **实现形态**：css 与 js **都走 init script**（css 补丁由脚本自己创建/更新 `<style>`），没有 `injectStyle`——注入的 `<style>` 元素不随 reload 保留，init script 会，统一后"reload 重放"只有一条机制。
- **一处必须的配套**：CDP 的 init script 注册**随 debugger 分离而失效**，所以有注册时不能空闲 detach（`holdsSessionState()` 判据，`detach()` 同步清空键表）。踩坑记录见 [开发文档](prototype-workbench-dev.md) §3.1。
- `key` 由调用方指定，重复注册同一 key 会**先移除旧的**（替换语义），所以重放是幂等的。

#### 3.2 patch 索引与重放
- **不落盘索引**：`packages/shared/src/prototypes/storage.ts` 的 `scanPrototypePatches()` 每次从 `patches/` 目录重算索引（派生索引 D12 从第一天生效，阶段 6.2 因此已提前满足）。
- 命名约定 `{lane}-{nnn}-{slug}.{css|js}`；**不符合命名的文件被忽略**（README、编辑器备份、`.DS_Store`），不会误当 patch 执行。排序 = lane → order → 文件名，完全确定，不依赖目录列举顺序。
- `packages/shared/src/prototypes/patch-script.ts` 的 `buildPatchInitScript()` 做 patch → init script 的纯变换：css 生成"创建/更新 `<style>`"的脚本（document-start 时 `head` 可能不存在，回退到 `DOMContentLoaded`）；js 包进 IIFE + `try/catch`，一个坏 patch 不会中断其余。
- 重放流程（`SessionManager` 的 `applyPrototype`）：扫描 → 先按前缀清掉磁盘上已删除的 patch 的 key → 逐个 `addInitScript`（面向未来文档）+ `evaluate`（立即作用于当前文档，**复用同一份变换**，所以 live 与 reload 行为一致）。不需要新的 reload 能力。

#### 3.3 两条写入路径（D4 + D15）
- **确定性改动**：renderer → `onWriteFile` → `file:write`（阶段 1 已通）直写 `patches/`。实时、无需 LLM。
- **语义改动**：交给 agent 的 `Write`/`Edit`（依赖 1.2 放行）写出新 patch。
- 两条路径产出同构文件，均由 3.2 重放。**两者都不由 renderer 直接写**（D15）。
- 说明：本阶段只交付了机制与通道；**尚无 UI 触发 `file:write`**，直写路径待阶段 4/6 的交互层接上。

**阶段 3 完成标志**：手动改一个 patch 文件 → 重放即生效；reload 后改动仍在。

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
- **未做**：dev-spec 只列**真实已知**的信息（每条 patch 的序号 / lane / kind / 字符数 / 全文），不编造"target selector + 前后差异"那类需要 patch 元数据的东西。要补得先定 patch 元数据格式。
- `exportPrototype()` 在缺少 `base.html` 时**明确报错**而不是导出一个无意义的文件。

#### 4.2 预览通道：复用浏览器面板
- 现有 HTML 预览 iframe 禁脚本（`MarkdownHtmlBlock.tsx:218-219`、`HTMLPreviewOverlay.tsx:204-205`），所以原型不能走它。
- 但**浏览器面板本身就是真实引擎、能跑 JS、已沙箱隔离**，直接打开产物即可，不必新搭一条渲染通道：零新增 UI、渲染环境与工作台一致，且不改动现有预览块的安全策略。
- `prototype-export` 因此返回可直接使用的 URL；那个地址的 origin 由 Electron 应答的 `http` 提供（§16）。

**阶段 4 完成标志**：`dist/extension/`（§17 起交付物是扩展包；其内每一页都已构建好、可独立打开）；`dist/dev-spec.md` 能让人看懂改了什么。

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
- 解析用 `yaml`（`packages/shared` 的**既有依赖**），**没有引入任何新依赖**。
- `resolveContractServiceSlug()`：显式 `--service` > 唯一服务；多个服务时不猜，**报错并列出候选**（猜错比报错更糟）。

#### 5.2 mock 物化（已完成）
用 CDP `Fetch` 在**网络层**兑现响应（D8）：`Fetch.enable` + `Fetch.fulfillRequest`——fetch / XHR / 任意资源类型全都覆盖，**应用一行不改**，也不往页面里塞 monkey-patch。（另外两条路——页面级 monkey-patch、独立 Node mock server——及其否决理由见 [开发文档](prototype-workbench-dev.md) §4。）

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

### 阶段 7：放开面 / overlay 改写 / 无中生有 — 两项已完成，放开面决定不做

**明确区分两类不同需求**：

| | 需求 | 机制 | 状态 |
|---|---|---|---|
| (a) | 模拟**尚不存在**的接口 | 契约 + mock runtime | ✅ 阶段 5 |
| (b) | 改写**已存在**的真实后端返回 | CDP Fetch 拦截 | ✅ **阶段 7，靠阶段 5 的机制自然获得** |

#### 已完成：无中生有入口（`prototype-open <slug>`）
- "无中生有"**不需要新机制**：agent 从阶段 1.2 起就能写 `prototypes/{slug}/base.html`，浏览器面板一直能打开它。缺的是入口体验——`resolvePrototypeEntry()` 决定"这个原型的页面在哪"，**答案只有一个：它的 origin**（服务器把 `base.html` + `patches/` 渲染出来；overlay 则是它自己的在线地址）。没有页面时**明确报错并点名该怎么拿到一页**，绝不拿交付物顶替（§16.3）。
- 命令 `prototype-open <slug>` 复用既有的 `navigate`，没有新增导航能力。**「能不能打开」由 `PrototypeStatus.pageAvailable` 驱动**（overlay 看 `targetUrl`、scratch 看 `base.html`），详情页据此禁用「预览」，并有测试逐组合断言它与 `resolvePrototypeEntry` 不漂移。
- 这些 RPC 的错误文案是**写给 agent 的**（点名缺什么、附绝对路径）；页面下方那条 kind-aware 的告警才是给人的引导。
- **详情页只有三个动作**：看（预览）、改（在对话里改）、交（导出给开发）。唯一的例外长在数据上——overlay 的「目标页面」那一行可编辑（§13.2.1），因为那是**数据本身可编辑**，不是又一个动作入口。
- 这条收敛的理由值得记住：**被删掉的入口回答的都是"机器需要什么"，不是"用户想要什么"**；登录、看 DOM、开一个窗口这类准备与排错交给 agent 的 browser 工具（它与原型窗口共用 `persist:browser-pane`，所以准备阶段登录一次即可）。
- 打开动作曾报过一次 `about:blank` 加载失败（错报在回退上，不是那次导航）——踩坑记录见 [开发文档](prototype-workbench-dev.md) §3.3。
- **空状态不再指向按钮名**：没有页面时，告警卡说的是"说一句你要做什么"，而不是"按某个按钮"。这条告警**只会出现在 scratch 上**：overlay 的地址在创建时就是必填（§13.2），所以它不会缺页面

#### 已完成：准备工作下放给 agent

按钮删掉之后，"参考一个页面"这条路改由 agent 与列表承担：**参考**是一条 `references` 关系（§14），**起点**是列表的「复制」（§13.1.1）——两者都不再需要"往当前原型里搬材料"这种命令。

**base 按类型分**（§13.1）：

| | 页面是什么 | 补丁打在哪 | 交付什么 |
|---|---|---|---|
| **overlay** | **那个在线 URL 本身**（有 JS、有登录、有真数据） | 活页面，`apply` 注入进去 | patches + dev-spec（写明改的是哪个地址） |
| **scratch** | 我们自己写的 `base.html` | 我们自己的文档，服务器渲染时内联 | 扩展自带这一页 + dev-spec |

于是在线 URL 的用途收敛成两件事：**竞品调研**，以及**分析要 patch 哪个 DOM**（browser 工具的 `snapshot` / `evaluate` 就够）——它**不必变成文件**。"准备好之后进原型窗口还是登录着的"靠的是所有 browser 窗口共用同一个 partition（`persist:browser-pane`）：准备阶段在那个窗口里登录一次，原型窗口打开同一地址就带着。

措辞也要跟着清（prompt、命令帮助、`prototype-create` 的提示）：只要留一句"让用户按某个按钮"，agent 就会去教用户按一个不存在的按钮。

#### 已完成：overlay 改写真实后端（无需新机制）
- 阶段 5 的 mock **匹配只按 pathname、与 host 无关**，所以一条 `/api/orders` 的路由会同样拦截 `https://api.production.example.com/api/orders`——"改写已存在的真实后端返回"与"模拟尚不存在的接口"是**同一个机制**，只是路由来源不同（有测试固定）。
- 因此**不需要**为响应体重写去碰 `webRequest`。真正仍需新机制的是"**只改响应头/状态码但保留真实 body**"（要在 `Fetch` 的 `Response` 阶段拦截），**未做**。

#### 已决策：放开面 partition（`webSecurity:false`）—— 决定**不开**
- 它买到的是"**页面脚本自己**跨域"的能力（免 CORS 发请求、读跨域资源），而**同样的能力从外部用 CDP 也能达到**（`Fetch` 兑现响应、`Runtime.evaluate` 在指定 frame 上执行）——四个诉求里三个已交付，剩下一个也用 CDP 能做。
- 代价却是**真实的、不可回退的安全弱化**：同源策略一关，该 renderer 里任何页面脚本都能读任意跨域响应；收益只是"省掉一层 CDP 封装"。
- **结论（用户已确认）：不开。** 全部能力改走 CDP，浏览器窗口的姿态从头到尾没变（§2 的 D5）。
- 若将来真撞到"CDP 做不了、必须页面 JS 自己跨域"的具体场景，再回到隔离设计（独立 partition + 无凭据 + 禁 `file://` + 风险提示）。

**阶段 7 完成标志（已达成部分）**：无中生有有了一等入口；改写真实后端返回可用且有测试固定；安全姿态未改动。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Explore 模式拦截写 | agent 写不进 `prototypes/` | `prototypesFolderPath` 例外（阶段 1.2，已落地） |
| 现有 HTML 预览禁 JS | 原型跑不起来 | 预览走浏览器面板（阶段 4.2）；origin 由 Electron 自己应答（§16） |
| 线上页面改版 / 登录态 | 页面变了而补丁还指着旧 DOM | D2：编辑走 overlay、交付走快照；`prototype-target` 改地址时把代价说出来（§13.2.1） |
| 注入被页面 CSP 拦截 | 注入失效 | 工作台内走 CDP（高于页面 CSP）；交付侧走内容脚本（页面策略管不到） |
| 契约 ⊃ mock | 后端交付不完整 | 阶段 5.4 显式补齐分页/错误/幂等/鉴权等内容，并**点名未声明项** |
| 契约漂移 | 真后端实现后与契约不一致 | 用同一份契约做对照回归（`x-mock` 按 pathname 匹配，切真后端无需改代码） |
| OpenAPI 只适配 REST | 非 REST 产品套不上 | 若产品是 GraphQL/RPC 需另定格式（当前假设 REST） |
| PM 不写 YAML | 契约无人维护 | 契约由 agent 生成维护（D4 语义写通道） |
| **Fetch 拦截拖慢页面** | 所有请求都过主进程一轮 | 未在真实环境量过；若明显变慢，把 `Fetch.enable` 的 pattern 收窄到目标接口域（目前是 `*`） |
| **无锁导致静默丢数据** | 并发写同文件 last-writer-wins | 用所有权代替锁（§3.3）；单文件资源只由控制面写。真要做并发写之前先看开发文档 §3.8 |
| **lane 边界被越写** | 所有权模型失效 | `canLaneWrite` 写前校验 owner，越界拒绝并告警（阶段 6.1） |
| **Tasks 结构化输出未实现** | 下游 lane 无法可靠消费上游产物 | 接 DAG 之前先落地 `NodeOutput.params`（阶段 6.4） |
| **patch 不回流源码** | 用户可能误以为改完就能应用回源码 | 这是**设计事实**而非缺陷：patch 是给开发的可执行规格，由人翻译；导出物承担"说清楚要改什么"的职责 |

实现层面的坑（CDP detach、渲染层导入边界、缺上游脚本、既有测试失败基线等）见 [开发文档](prototype-workbench-dev.md)。

---

## 8. 验收标准（MVP）

### UI 与文件通路

1. 在**任意真实页面**上（产品 dev server / 测试环境 / 线上均可，见 §1）能点选任意元素，拿到稳定 selector，重复点选结果一致。
2. 选中后做出的改动**立即反映在页面上**，并把 patch 落成 `patches/` 下的文件。
3. 手动编辑该 patch 文件，页面随之更新（`fs.watch` 通路有效）。
4. 刷新 / 重开页面，改动**依然存在**（patch 重放有效）。
5. `dist/extension/` 里的页面（§17）可独立打开并保留全部改动（scratch 的每一页都在包里）；`dist/dev-spec.md` 可读地说明改了什么。

### 服务契约层

6. 能合成一份 `openapi.yaml`，并让原型在浏览器内跑通（mock 由 CDP 在网络层兑现，**不起服务**）。
7. fetch 与 XHR（axios）两条路径都被 mock 答上，**应用代码一行不改**。
8. 把 mock 关掉后，原型无需其他改动即对接真后端（**同构验证**）。
9. `dist/openapi.yaml` 除了端点与 schema，还包含分页/错误/幂等/鉴权约定；未声明的部分在 `contract.md` 里被点名。

### 平面分离与并线

10. 两个 lane 并发写各自的产物文件，**互不覆盖**（人工构造并发写验证；靠 append-only 与所有权，不靠锁）。
11. **索引不落盘**：任何本地缓存被删都不改变"有哪些补丁"，它每次从磁盘重算。
12. lane 试图写不属于它的文件时被拒绝并有告警。
13. 拾取器路径上不存在任何直接文件写（renderer 只发事件）。
14. 一个工作台任务能被表达为一个 Task（lane = node），且 `depends_on` 生效。**（推迟，触发条件见 §6.4）**

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

> **关于页面地址**：示例用 `http://localhost:3000/...` 只是占位。换成任何真实产品地址——dev server、测试环境、线上——步骤完全一样（依据见 §1：patch 对任何源页面都是覆盖层，dev server 没有特殊性）。

> ⚠️ **端口**：`bun run electron:dev` 会占用 **5173**（renderer 的 vite）。若你确实用本地 dev server，它要跑在**别的端口**（示例用 3000）；`electron-dev.ts` 启动时会**无条件 kill 掉占用 5173 的进程**。

> **关于 slug**：A–E 保留了显式 slug 的写法（便于照抄，也验证显式路径）。若会话已绑定该原型（§11 / 步骤 F），这些命令的 slug 都可以省略。

### A. 在真实页面上改（核心闭环）

> **前置**：先建一个 **overlay** 原型：创建对话框选「在已有页面上改」并填目标页，或 `browser_tool prototype-create Checkout flow --url <你的产品页面 URL>`。目标页就是**要打开的页面本身**（详情页「预览」直接开它、并把补丁注入进去），不改变 patch 的行为——patch 对任何源页面都是覆盖层。

1. `browser_tool navigate <你的产品页面 URL>`（示例 `http://localhost:3000/checkout`；线上地址同样成立）
2. `browser_tool pick` → 光标高亮跟随，点一个元素 → 拿到稳定 selector
3. 让 agent 写一个 patch：`prototypes/checkout-flow/patches/A-001-btn.css`
4. `browser_tool prototype-apply checkout-flow` → 页面**立刻**变化
5. **手动 reload 页面** → 改动**仍在**（这是"持久注入"的验收点）

> 第 5 步是整条链路里最值得盯的一步：它依赖"CDP 注册不随空闲 detach 失效"，机制见 [开发文档](prototype-workbench-dev.md) §3.1。

> 产物落在 `~/.craft-agent/workspaces/<当前 workspace>/prototypes/`。当前会话属于哪个 workspace，`prototype-status` 里的 `dir` 会直接告诉你。

### B. 从零做一个原型（scratch 类型）

6. 创建时选 **scratch**（两个入口都行）：UI 里它就是**默认选中**的那个；对话里 `browser_tool prototype-create Quotes flow`（不带 flag 就是它）
7. 让 agent 直接写 `prototypes/quotes-flow/base.html`（scratch 的 `base.html` 就是我们自己的文档，不需要任何特殊命令）
8. `browser_tool prototype-open quotes-flow` → 在浏览器面板里打开；再按 A 的 3–5 加 patch

### C. mock 就是服务（契约 → 前端 → 后端）

9. 让 agent 写：
   - `prototypes/checkout-flow/services/checkout-api/paths/list-orders.yaml`（含 `x-mock.fixture`）
   - `prototypes/checkout-flow/services/checkout-api/fixtures/list-orders-200.json`
10. `browser_tool prototype-mock-apply checkout-flow` → 原型有数据了（**fetch 和 axios 都覆盖**，应用不用改指向）
11. `browser_tool prototype-contract-export checkout-flow` → `dist/openapi.yaml` + `dist/contract.md` + `dist/fixtures/`，把 `dist/` 交给后端
12. `browser_tool prototype-mock-clear` → 请求打回真实后端。**代码一行不用改** —— 这就是"mock 与真服务同构"

> 想看 `contract.md` 有什么价值：故意只声明 200 响应、不写 `authType`、不写 `x-contract`，它会**点名这三处缺失**，正好是后端接手前必须补的清单。

### D. 交付与验收

13. `browser_tool prototype-export checkout-flow` → 交付物落在 `dist/extension/`（§17），命令会打印它的路径与 **`http://checkout-flow-<hash>.localhost/dist/extension/base.html`** 地址（不再是 `file://`，见 §16）
14. `browser_tool prototype-open checkout-flow` → 打开的是它的 **origin 根**：`base.html` + 全部 patch 现算出来的页面（与交付物里那一页同一份补丁、同一顺序，只差扩展要求的改写），而不是某个文件
15. `browser_tool prototype-status checkout-flow` → 全貌 + 所有权检查

### E. 故意制造一个所有权违例

16. 写一个 `prototypes/checkout-flow/patches/oops.css`（不符合 `{lane}-{nnn}-{name}.css`）
17. `browser_tool prototype-status checkout-flow` → 应该点名它"misnamed patch"

这条验证的是：**以前会被静默忽略的文件，现在会被抓出来**。

### 试用时重点观察

**开着 mock 时页面是否明显变慢**：`Fetch.enable` 目前用 `*` 匹配**所有**请求，每个都过主进程一轮。若明显变慢，把 pattern 收窄到目标接口域（`browser-cdp.ts` 的 `setFetchMockRoutes`）。

### F. 对话入口与绑定（§11 的验收）

17. 在原型详情页点 **Open conversation** → 进入一个已绑定该原型的会话（已有绑定会话时直接跳过去，不新建）
18. 在这个会话里说「应用补丁」——**不用提原型名**，agent 会执行 `prototype-apply` 并落到该原型
19. 对 agent 说「列一下有哪些原型」→ `prototype-list`，输出里当前绑定的那个标 **BOUND**
20. 点会话标题右侧的**烧瓶图标** → 切换/解绑原型；切换后 badge 立即变化（靠 `prototype_slug_changed` 事件，不是本地状态）
21. 在**新会话**里对 agent 说「给我建个 checkout 原型」→ `prototype-create checkout`，它会**建完自动绑定**，随后 `prototype-apply` 无需 slug

> 第 18 步是本节的验收点：它验证的是 prompt 注入（agent 知道当前原型）+ slug 回退（命令缺省取绑定）**两条链路都通**。若 agent 仍要求你提供 slug，看主进程日志里 system prompt 是否含 `<prototype_context>`。

### G. 在预览面板上选中元素（§12 的验收）

前提：该面板窗口的会话已绑定原型（否则工具栏会提示「未绑定原型」）。

22. 点面板工具栏的**准星图标** → 按钮高亮 + 出现「点击页面上的元素」提示 → 点击页面任意元素
23. **关键验证**：此刻点击**不应触发**页面自身的按钮/链接行为（编辑态已拦截 capture 阶段）
24. 主窗口**直接切到那个会话**，输入框里已经预填了 `把页面里的 <selector> 元素（当前文字为「…」）改成：`，光标等着你补完这句话
25. 补一句「改成『立即下单』」→ 发送 → agent 写补丁并重放 → **面板里立刻生效**，同时详情页产物区多出一个文件
26. 再选一个元素 → 同样直接跳回会话（没有中间卡片、不需要点第二次）
27. 点工具栏**闪电图标** → 把当前原型的所有补丁重放进这个面板
28. 按 Esc 或再点准星图标 → 退出编辑态，页面恢复正常点击行为

> 第 24 步是本轮改动的验收点：**"选中"只回答"哪一个元素"，"改成什么"一律在对话里说**（§12.4）。

### H. 两种原型类型（§13 的验收）

29. 在创建对话框里看两个类型卡片：**默认选中「从零开始」**；选「在已有页面上改」→ 出现目标页输入框，**标着「必填」**，为空时「创建」是灰的；选回「从零开始」→ 输入框消失（切回再切一次，确认不会残留上一个类型的输入）
30. 建一个 overlay 并填目标页 → 详情页标题下是 overlay 的引导语，元数据里有「目标页面」行（但**没有**"打开它"的按钮——想看就在对话里说一句，agent 自己导航）
31. 建一个 scratch → 详情页**没有**「目标页面」行、**没有**「打开目标页面」按钮，引导语说的是「这是你自己的文档」
32. `base.html` 缺席的告警**只会出现在 scratch 上**（说要做啥、或指一个可参考的页面，**不指向按钮**）：overlay 的地址在创建时就是必填，所以它不会缺页面；对话框里不填地址时被挡下的是**创建按钮**，不是创建后的预览
33. 目录里 `prototypes/<slug>/config.json` 是 `{ "kind": "overlay", "targetUrl": "…" }` / `{ "kind": "scratch" }` 两种形态——scratch **不存** targetUrl，overlay **一定有** targetUrl
34. `browser_tool prototype-status <slug>` 与 agent 的 system prompt 里都能看到类型；对话里 `prototype-create Landing page`（不带 flag，默认就是 scratch）同一条链路建出 scratch 并自动绑定；`prototype-create Rival --url https://…` 建出 overlay，而 `--url` 缺值或同时给 `--scratch` 都会被拒

> 第 33 步验证的是「数据层分离」这个选择本身：类型不是 UI 状态、不是标签，而是**落盘的一个字段**，所以详情页、prompt、agent 命令、导出三条路读的是同一个真源。

### I. 混合场景：逆向第三方再搭自己的（§14 的验收）

**B 参考面**

35. 建一个 scratch 原型 → 详情页「参考资料」区点**「添加参考」**。表单里上半部分是**已有原型**（点一下就关联，不新建）；下半部分填名称 + URL 会**新建**一个 overlay 原型再关联（表单下方有字说明这个副作用；两个字段都必填——新建的是 overlay，那个地址就是它的页面）
36. **关联已有原型**：先另建一个 scratch，然后回到第一个原型，点候选里的它 → 应立即关联。**这就验证了「关系与类型无关」**：引用者是 scratch，被引用者也是 scratch
37. 参考行点**「打开」**：overlay 参考落在它记录的真实地址（活页面，带它自己的登录态）；scratch 参考打开它自己渲染出来的页面（origin，不是导出物），且第二行显示「它自己的页面」而不是「未记录目标页面」
38. 点参考行的 slug → 跳到那个参考原型自己的详情页。在那里打 patch —— overlay 的直接打在活页面上，scratch 的写在它自己的 `base.html` 里；这些 patch 属于**它自己**
39. 回到交付原型 → `browser_tool prototype-apply` → 注入的是**交付原型**的 patch，参考的 patch 一条都不在里面（第 42 步会再确认一次）

**A 起点**

40. 在交付原型（scratch）上：让 agent 用 Write 工具写 `base.html` 当底稿 → 手改几处
41. **护栏**：`base.html` 是**无条件覆盖**的写入口，agent 要覆盖一份已有内容的 scratch 文档时，必须先问一句；overlay 上没有可覆盖的文档——它的页面永远是那个地址本身

**护栏**

42. 导出交付原型（`prototype-export`）→ 检查 `dist/extension/base.html`：里面**不应**出现任何参考原型的 patch 内容。这是第 38 步那批 patch 最危险的去处
43. 目录里 `prototypes/<交付原型>/config.json` 应有 `"references": ["rival-checkout"]`，而 `prototypes/rival-checkout/config.json` **不应**有 `references`（关系是单向的）
44. 对话里（会话已绑定交付原型）说「把另一个也加进来参考」→ agent 应执行 `prototype-reference <slug>`；若它需要先建一个，应当带 `--no-bind`，**且绑定不能被换掉**（`prototype-list` 里 BOUND 仍是交付原型）
45. 参考行点解除（↔ 图标）→ 该行消失，`config.json` 里的 `references` 一并消失

**agent 的读取面**

46. 对话里说「列一下原型」→ `prototype-list` 的每一行都带 `(overlay)` / `(scratch)`，有目标页的带 `target:`，有关系的带 `references:` / `referenced by:`
47. 对自己**不是**绑定对象的那个原型说「看一下它的状态」→ agent 应执行 `prototype-status <slug>`，输出里能看出它是什么类型、它在参考谁（**括注了对方是什么**）、以及谁在参考它

> 第 46 步修的是一个「状态撒谎」：在此之前 `prototype-list` 只列 slug 和 patch 数，overlay 和 scratch 在列表里长得一模一样。

> 第 44 步是本节最容易出事的一步：`prototype-create` 默认会绑定会话，如果 agent 建参考时没带 `--no-bind`，之后每条省 slug 的命令都会打到竞品页面上，而**画面上看不出来**。

### J. 交付物的 origin（§16 的验收）

48. 打开 `http://<slug>-<hash>.localhost/`（**不带路径**）→ 应看到 base 页**加上全部 patch**；对照 `/base.html`（裸底稿，无 patch）与 `/dist/extension/base.html`（导出时冻结的那一页）。**在没导出过的情况下也要能看到 patch 生效**——这是这一节的核心
49. 让 agent 建一个 scratch 原型，`base.html` 里放 `<script type="module">` + `fetch('/api/anything')`，写一条对应 path 的契约 fragment 与 fixture，然后 `prototype-mock-apply` → **相对 fetch 应被 mock 答上**。这是 §16 的收益点：`file://` 时代这个请求根本发不出去，mock 再对也没用
50. 在页面里 `document.cookie = 'a=1'` 再读回 → 有值；`localStorage` 同理。两者在 `file://` 下都是空/不可用
51. 重启应用后重开同一原型 → cookie 与 localStorage **还在**（origin 不再随端口变）
52. **SPA**：让 `base.html` 里放一个 `history.pushState(null,'','/orders/42')` 的按钮 + `<link href="/assets/app.css">`，并在原型目录里放 `assets/app.css` → 点按钮后**刷新**，页面应仍然起来（回退到原型页面），且样式表命中（根绝对路径）

### K. 页面从哪来，两种类型各走各的（§13.1 / §13.1.1 的验收）

前提：这些**都没有界面入口了**——是对着对话说，不是找按钮。

53. 新建一个 scratch → `prototypes/<slug>/` 里**没有** `base.html`（只有 `config.json` 与空的 `patches/`），详情页的「预览 / 导出」是灰的，告警卡写的是"在对话里说一声"，**不指向任何按钮**
54. 在对话里说「写一个登录页首稿」→ agent 用 Write 工具写 `base.html` → 「预览」变可用。**全程界面上没有出现过"写底稿"这类按钮**
55. 新建一个 overlay 并在创建时填了目标页 → 「预览」直接打开**那个在线地址**并注入补丁：地址栏是真实站点，页面带自己的 JS、自己的登录态、自己的数据。`prototypes/<slug>/` 里**没有、也不需要** `base.html`——这是 overlay 的核心判据
56. **地址在创建时就必填**：对话框里只填名字、选「在已有页面上改」而不填地址 → 「创建」是灰的；对话里 `prototype-create Rival --url`（缺值）或 `--scratch --url …`（两个都给了）→ 明确报错。所以 overlay 建出来**一定**有地址，「预览」对它永远可用——这也是 §13.5 那条"最粗糙的一处"消失的原因
57. 详情页上确认动作区**只有**「预览 / 在对话里改 / 导出」三个，没有别的入口
58. 对另一个 scratch 说「以 <另一个原型> 为起点」→ agent 会告诉你做不到，改用**列表右键 →「复制」**：新原型的 slug 是 `<源 slug>-copy`，页面与补丁**成对**过来，kind / targetUrl / references 也跟过来（是同一件事的另一份），从那一刻起两边互不影响；再复制一次得到 `-copy-2`（这一步见 O 组）

### L. 打开 = 打开当前的页面（§16.3 / §16.4.1 的验收）

59. 打开一个有补丁的 scratch 原型 → 地址是 `http://<slug>-<hash>.localhost/`，**不是** `/dist/extension/base.html`；页面已经带全部补丁效果。**在交付物存在的情况下也必须如此**（这条就是本节的判据）。overlay 则打开它记录的在线地址，地址栏不变——两者的区别本身就是本节要确认的东西
60. 在那个页面上继续改：面板工具栏选元素 → 跳回会话、补完那句话发送 → agent 写补丁并重放 → 新效果**原地出现**，页面不重载、不闪。用一个会 `appendChild` 的 JS 补丁试：在**面板工具栏**重复点「应用补丁」应当**只出现一次**（跑两遍就是这里要防的那个静默错误）
61. 只改某个已有补丁的**内容**（不改文件名）→ 面板工具栏的「应用补丁」不会重复注入它（按文件名算"已内联"）→ **刷新**页面后看到新内容
62. 把某 scratch 原型的 `base.html` 删掉 → 详情页「预览」变灰、告警说"说一句你要做什么"；直接导航到它的 origin 得到 404；`/dist/extension/base.html`（上次导出的那一页）仍可按名字访问（交付物没被藏起来，只是不再是入口）。同一个原型导出时**应当报错**（没有文档可交）；overlay 导出写 `dist/extension/` + `dev-spec.md`

### M. 交付物：一个原型一个扩展（§17 的验收）

63. 在一个 overlay 原型上 `prototype-export` → `dist/extension/` 里出现 `manifest.json` / `README.md` / `patches/*.css` / JS 脚本，`dist/dev-spec.md` 照旧；按 README 的三步在 `chrome://extensions` 里 **Load unpacked**，然后打开目标页 → **补丁已经在**，没有任何要点的东西
64. **刷新页面** → 补丁仍在（是浏览器注入，不是一次性动作）；在同一站点内点一个站内链接换页 → 补丁也在（每条 content script 按 `matches` 生效）。
65. 让 agent 加一条会 `appendChild` 的 JS 补丁（比如插一个徽章）→ 重新导出 → 在 `chrome://extensions` 点 **Reload** 并刷新页面 → 徽章**只有一个**（§17.3 的"可重跑"规矩）；在同一页里切换 SPA 视图 → 补丁自动重放到新视图
66. 打开扩展的 README：写明**装法**、**作用范围**（`matches` 列表）、**改了哪些补丁**、**构建时间与版本**、以及"改一条补丁要重新导出 + Reload"；`chrome://extensions` 上显示的版本号与 README 一致——这条是"我看到的和你说的不一样"的唯一答案
67. 找一个下发严格 CSP 的站点（GitHub 之类）→ 补丁**照旧生效**（内容脚本由浏览器注入，页面策略管不到它）
68. scratch 原型导出 → `dist/extension/base.html` 是入口页（**每一页都在包里、文件名不变**，所以页间链接照旧）；Load unpacked 后点扩展的 **options**（或工具栏图标）→ 打开的就是它，带全部补丁
69. 在 scratch 的 `base.html` 里写一段内联 `<script>` 和一处 `onclick="…"` → 导出后打开 options 页：内联脚本被提取成文件后**照旧运行**，`onclick` 也照旧生效（agent 不需要知道扩展存在，§17.1）；再把 `onclick` 换成运行期拼出来的字符串试一次 → 仍然生效
70. 给某个原型加一条契约 fragment + fixture 并 `prototype-mock-apply` → 导出后的扩展里那条请求**被包里伪造的数据答上**，README 列出了这条路由是假的；换成"真实产品是 PWA"的情形（请求由它自己的 service worker 发出）→ 那条 mock 不生效（README 已写明这条边界）。
    另外确认一个曾经静默失败的点（两条以上 js 补丁只有第一条执行，见 [开发文档](prototype-workbench-dev.md) §3.4）：在一个**只有一条 js 补丁**和**有两条以上 js 补丁**的原型上分别导出，每条补丁都生效

### N. 换环境：地址可以改（§13.2.1 的验收）

71. 在一个绑定好的 overlay 上说「这个我们测试环境也有一份」→ agent 跑 `prototype-target https://staging.example.com/checkout` → 输出是 `from:` / `to:` 两行，加上四条后果（新地址生效、旧窗口要重开、选择器可能不再匹配、类型仍不可改）；`config.json` 里**只有 `targetUrl` 变了**（kind 与 references 不动）；详情页的「目标页面」行跟着变，而「预览」一直可用
72. 同一件事在界面上做一遍：详情页元数据里「目标页面」那一行**完整显示地址**，地址右边一支铅笔 → 点开是一个输入框 + 一段风险说明（正是第 71 步那两条静默失效），地址与当前值相同时「保存」是灰的 → 改成第三个环境、保存 → 对话框关闭、行上立刻是新地址
73. 三种拒绝路径都要试：对 **scratch** 说「把它指到某个地址」→ 拒绝（"its page is its own base.html"）；地址写成 `app.example.com/x`（缺 scheme）→ 拒绝并提示补上 scheme（**对话框里也走同一条规则**，错误就地显示在弹窗里）；在**没绑定**的会话里跑命令 → 拒绝并提示 `prototype-bind`（这条命令唯一的位参数是地址，所以它不认位置上的 slug）
74. 改完再 `prototype-export` → `dev-spec.md` 第一行与扩展 README 里的地址都换成新的（`matches` 也跟着换）；**旧窗口里的页面不会自己变**——`prototype-open` 一下才挪过去（这条正是命令里那句话的验收）

### O. 列表的复制与删除（§13.1.1 的验收）

75. 在原型列表的一行上**右键**（或悬停看那个 `…`）→ 菜单两项：「复制」「删除」。先确认菜单里**没有**别的条目
76. 点「复制」→ toast 报出新 slug（`<源 slug>-copy`），面板**直接跳到那份副本**；进 `prototypes/<slug>-copy/` 看：`base.html` 与 `patches/` 都在，`config.json` 是新的（kind / targetUrl / references 跟过来），**没有 `dist/`**；再复制一次 → `-copy-2`
77. 改副本里的一个补丁 → **源原型不受影响**；反过来也成立。这是"复制的是原型，不是材料"的验收
78. 对一个被别的原型（`references` 指向它）的原型点「删除」→ 先弹确认（写明删的是什么）→ 确认后行消失、目录也没了，toast 里点出**还有哪个原型在引用它**；打开那个引用方 → 它的 `config.json` 里的 references **原样保留**（悬空），`prototype-status` 会告诉读者这个参考已经不在
79. 删掉当前正打开着的原型 → 详情页回到原型列表，而不是停在一个已经不存在的 slug 上
80. 让 agent 去删一个原型 → 它没有这个命令；`prototype-create` 的输出也**不再提**"可以导入另一个原型的页面"

### P. 窗口的地址栏（§12.6 的验收）

81. 在一个**已经有对话**的原型上点「预览」→ 窗口的地址栏写的是 `http://<slug>-<hash>.localhost/`，而不是它正在显示的第三方站点地址（overlay 尤其明显）；工具栏的「选中元素 / 应用补丁」是亮的，在 overlay 上点「应用补丁」→ 补丁落在那个真实页面上
82. 在一个**还没有对话**的原型上点「预览」→ 窗口照常打开，但地址栏是它实际所在的地址、两个按钮是灰的（点了不会有任何提示，因为点不动）；回详情页点「在对话里改」建出对话，再让 agent `prototype-open` → **同一个窗口**被复用并绑定，地址栏变成原型域名、按钮变亮
83. 在 scratch 原型的窗口里访问 `/dist/extension/base.html` → 地址栏显示这个带路径的地址（原型内部的路径不做替换），两个按钮仍然可用
84. 在地址栏里敲**这个原型的根地址** → 它不去取那个 URL，而是按类型打开这个原型：scratch 落在渲染页上，overlay 落在目标页面并重放补丁（**不是 404**）；敲 `/dist/extension/base.html` 这类**原型内部的路径**则是普通导航
85. 让 agent 在原型窗口里跑 `snapshot` 与 `windows` → 输出里同时有**真实页面 URL**（overlay 就是站点自己的地址）与 `Prototype: <slug> (<kind>) — its own address …`；overlay 还多一句"这是站点自己的页面，只能打补丁、不能就地编辑"。把同一个窗口换成普通浏览器窗口（非原型）→ 这些原型行**一行都不出现**

### Q. 多页面原型（§18 的验收）

> **§19 起这批用例的地址与名字要按页层模型读**（`86` 里的"入口页 `base.html`"、`88` 里的 `page "entry"`、`89`–`93` 的 overlay 页表都成了页表里的一行）。行为不变，编号保留作为回归；新增的页层用例是 R 组（§19.10 的 94–100）。

86. 在一个 scratch 原型目录里放第二张页 `orders.html`（从入口页 `<a href="/orders.html">` 链过去），再写一条补丁 → 进第二页时**补丁也生效**；导出（§17）→ 包里**两张页都在**（`base.html` 与 `orders.html`，名字不变所以链接照旧），两页都带补丁，入口写在 manifest 的 options 里，README 的 `Pages` 列出它们；对照 `/base.html`（裸底稿，无 patch）与子目录里的 html（同样是裸的）
87. `prototype-status` 里能看到 `pages:` 列出 `entry (base.html)` 与 `orders (orders.html)` 及各自地址；`prototype-open <slug> --page orders` 打开第二页；`--page nope` 报错并**把可选页列出来**
88. 在第二页上让 agent `snapshot` → `Prototype:` 行带 `page "orders"`；回入口页再 `snapshot` → `page "entry"`；把窗口导航到站外 → `page` 不再出现（而 `URL:` 行如实显示站外地址）

**overlay 的页表（§18 ⑤／⑥）**

89. 给一个 overlay 加第二、三页（`prototype-pages --add payment=https://app.example.com/checkout/payment`）→ `prototype-status` 的 `pages:` 按**入口 + 声明序**列出三页及各自地址（不是字母序）；`prototype-open checkout-flow --page payment` 打开那一页并重放补丁
90. `prototype-export` → `manifest.json` 的 `content_scripts[0].matches` 里**每一页各一个 pattern**；README 的 "Where it applies" 逐页一行。少一页都算失败
91. 在第二页的窗口里 `snapshot` → `Prototype:` 行带 `page "payment"`——页表让这个反推对**整条流程**成立，而不只是入口页
92. 往 `pages` 里写一个 `ftp://` 或空地址、写一个重复 `name`、写一个与 `targetUrl` 相同的条目 → 导出报错并**点名那一页**；重复项被丢弃并报告，其余照常工作（不静默、也不整份拒绝）
93. `prototype-pages` 无参数 → 列出入口与其余页；`--remove` 掉一页 → 状态与导出立刻不再包含它，`targetUrl` 的入口不受影响

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

---

## 12. 预览面板上的编辑入口

**问题**：§11 把「应用补丁」放在了原型详情页。用户看的是**预览面板**里正在开发的产品页面，却要切到另一个页面去点应用。更根本的是：原始痛点「对注入的 HTML 实时编辑**或选中**」在预览面板上**一个入口都没有**。

### 12.1 先纠正一个认知：预览面板不是 React 面板

它是一个**独立的无边框原生窗口**，内部叠了 3 个 `BrowserView`（`browser-pane-manager.ts:496-499`）：

```
toolbarView   48px   独立渲染进程（browser-toolbar.html）
pageView      整块    产品页面
nativeOverlayView     仅 agent 操作时的遮罩（纯视觉，无按钮）
```

含义：renderer 里的 `components/browser/` 只是主窗口 TopBar 的徽章条，**不是面板本体**。面板工具栏的可用 API 只有导航类（`window.browserToolbar`），它**拿不到 workspace、会话、绑定原型**。

所以「在那里加个按钮」不是加个按钮，而是要新开一条链路。

### 12.2 链路：面板 → 主进程 → 主窗口

```
面板工具栏（无上下文）
  │ ipcRenderer.invoke('browser-toolbar:pick-element' | ':apply-prototype')
  ▼
BrowserPaneManager（主进程，只有 instanceId）
  │ 广播 RPC_CHANNELS.browserPane.TOOLBAR_ACTION = { kind, instanceId, ... }
  ▼
主窗口 renderer（有 sessionMetaMap + 原型列表）
  │ 解析 instance.boundSessionId → session.prototypeSlug
  ▼
调既有 RPC：prototypes:apply / file:write
```

**关键设计**：面板只上报「用户做了什么」（`BrowserToolbarAction`），**不判断它的含义**。含义依赖绑定，而绑定在主窗口。这样「应用补丁」按钮与原型详情页的 Apply **走同一个 RPC**，两个入口不可能行为分叉。

广播用 `{ to: 'all' }` 而非定向：面板不知道自己由哪个 client 打开，不拥有该 instance 的 renderer 会忽略。

### 12.3 编辑态必须显式进入（这是用户的明确约束）

用户原话：「要先点击可视化编辑按钮再进入编辑态，否则会被 html 本身的点击行为干扰」。

现有 picker 已满足这个约束（`browser-cdp.ts:120-227`）：

- 它在 `click` 的 **capture 阶段**注册（`addEventListener('click', onClick, true)`）
- 处理函数里 `e.preventDefault()` + `e.stopPropagation()` —— 页面自身的行为被拦住
- 它**只在注入后存在**；注入即进入编辑态，`cleanup()` 即退出

所以工具栏的按钮就是「注入/取消注入」的开关，UI 上还额外给了一个文字提示（`browser.pickHint`），避免用户在不知情的情况下点进页面。

### 12.4 选中之后：只有一个出口，而且是对话

选中元素 → **把 `selector` + 该元素当前文字预填进这个会话的输入框并跳过去**。中间没有卡片、没有第二个决定。

补丁只有一个来源：**agent 写**。点击式生成（`textContent` 替换那种）被否决，三条理由：

- **它让补丁数量由点击次数决定**，而不是由"要交付几件事"决定。改 30 处文案就是 30 个文件，可它们本该是同一句需求。
- **它把判断权交给了点击者**：点一下只能做 `textContent` 替换，而这一处到底该改文案、该改结构、还是该连着改三处，需要看得见全局的人来判断。
- **它让"编辑"变成一个不需要描述的动作**，于是没有任何地方留下"为什么改"——而这个工作台的产物之一就是那份理由。

面板的编辑态只负责回答"哪一个元素"，那正是人比模型快的地方；而"改成什么"回到对话里说。

> 同一条规矩也适用于**详情页的源码编辑器**：产物区只**列出**原型由哪些文件组成，不提供"点开就能改"的入口——直接编辑产物文件是工程侧的界面，不是这里的。

### 12.5 未做的（明确记录）

- **样式可视化编辑**（颜色/间距编辑器）—— 不做：一切改动都走对话
- **面板内编辑条** —— 不做：选中即跳对话，面板工具栏只保留「选中元素 / 应用补丁」
- 面板工具栏的按钮**没有 tooltip**（BrowserView 边界会裁掉浮层），只有 `aria-label`

### 12.6 窗口的地址栏就是它的原型

面板窗口的地址栏此前如实显示 `pageView` 的地址：scratch 原型上是 `http://<slug>-<hash>.localhost/`，**overlay 原型上却是它正在改的那个第三方地址**。于是同一个原型有两副面孔——这也是"未绑定原型"那句提示最刺人的地方：用户手里明明是从原型面板打开的窗口，看起来却像一个普通浏览器。

**规则**：窗口在做哪个原型，地址栏就写哪个原型的域名。

- **overlay 也如此**，尽管它的 `pageView` 仍在真实地址上（这正是 overlay：页面带着自己的 JS、登录态与自己的源，patch 注入进去）。地址栏是**显示层**的事实，不是导航层的事实——真去用本地服务器代请求第三方页面，会丢掉登录态、CORS 与源，等于把 overlay 毁掉。
- **scratch 不用改**：它本来就在原型域名上；而且当地址已经落在原型 host 上时保留真实 URL，所以 `/dist/extension/base.html`、SPA 路由这些**原型内部的路径**照样看得见。

**"看地址栏就知道绑没绑"之所以成立**，是因为地址栏那个值本身就来自这条查表：`instance.boundPrototype ?? (boundSessionId ?? ownerSessionId → 会话 → prototypeSlug)` → `prototypeOriginUrl`。同一个值顺带决定那两个动作是否可用——**没有原型就没有那两个按钮**（置灰），而不是点完再弹一句"未绑定"：这是「入口的失败在点之前说，不在点之后答」（§6 阶段 7）在工具栏上的兑现。

**为什么必须有"窗口被打开时声明的那个原型"这一条**：overlay 的视图落在第三方地址上，一旦加载完，URL 里**没有任何东西**记得这是在给哪个原型打补丁——所以身份只能在打开的那一刻说定（`PrototypeEntry.origin` → `browserPane.create` 的 `prototype`）。只留会话链时，"刚创建、还没有对话"这个最常见的首次体验恰好不成立：地址栏写着真实地址、两个按钮灰着，窗口不认为自己是这个原型的窗口。

**地址栏里的原型地址是能用的，不是摆设。** 敲它 = 打开这个原型的某一页：

- **根地址代表原型本身**（`pathname === '/'`）：敲它 = 「打开这个原型」——发一条 `open-prototype` 工具栏动作（不带页名）给主窗口，由它 `getPrototypeEntry` 解析入口页 / 页索引，活页面再 `applyPrototype` 重放补丁。与面板「预览」是同一条路，两处不会漂移。
- **`/<页名>` 代表原型里的某一页**（§19.3）：主进程查页表认出这是哪一页，动作里带上页名，主窗口 `getPrototypeEntry(slug, page)` 解析出**那一页自己的地址**再加载——活页面直接加载它的真实地址，自有页加载宿主渲染它的地址。判定不需要新东西：一个路径段，且这一页真的在流程里（不在就是普通导航，交给宿主的目录）。
- **其余路径是文件或应用自己的路由**（`/dist/extension/index.html`、`/assets/app.css`、SPA 路由）：不是页名，照旧按路径导航（§16.3）。
- **这顺带消掉了 overlay 的一个坑**：overlay 在根地址上本来没有页面（404 `Nothing to serve`），敲回车吃 404 看着合理，其实是把"我要看这个原型"当成了"我要取这个 URL"。

**地址栏显示与视图加载是两件事**（与 §12.1 的分工同源）：bar 写的是"哪个原型的哪一页"——根之外再带页名（`http://<slug>-<hash>.localhost/pay`），而视图加载的始终是那一页**自己**的地址。所以窗口停在 overlay 页上时 bar 不跟着变成第三方地址，敲它回去的是**同一页**，而不是入口页；推不出当前页时只写原型域名。

**敲别的地址**就是普通导航：视图去那里，而地址栏照旧写着原型 + 当前页（推不出当前页时只写原型域名）——这个窗口始终是这个原型的窗口，两个动作仍然可用（它们作用于**当前文档**）。

链路全在已有的 `STATE_UPDATE` 上，**没有新通道**：`BrowserPaneManager.pushToolbarState` 每次推送时算一次地址与 `prototypeSlug`（`prototypeBindingFor`：窗口被打开时声明的原型优先，否则走会话链），其中窗口那条来自打开时（`bindPrototype`，`PrototypeEntry.origin` 一起带过来），会话那条的 (slug, workspaceRootPath) 由 `SessionManager.getSessionPrototypeBinding` 给出，origin 由 `prototypeOriginUrl` 现算（`main/index.ts` 注入，晚绑定——窗口可能先于它存在）。地址→原型这条反方向的查表（`setPrototypeAddressResolver`）也由那里注入，用于用户敲进地址栏的地址；认出是某个原型的地址时（根或某一页）**同时把窗口绑到该原型**，并把页名一起交给主窗口（否则视图加载真实页面后，地址栏又会退回真实地址/丢掉当前页）。工具栏那侧只做两件事：显示 `url`，按 `prototypeSlug` 决定两个按钮是否可用。

> 与 §12.2 的分工：**动作**走"面板 → 主进程 → 主窗口"（主窗口才知道往哪个会话送元素），**地址栏与可用性**走"主进程 → 面板"（主进程持有窗口）。两条链路对同一个绑定给出同一个答案，因为查的是同一张表。

**agent 侧拿到的是同一份身份，而且更全。** `snapshot` 与 `windows` 的输出里，每个原型窗口多一行 `Prototype: <slug> (<kind>) — its own address <origin>`，而 `URL:` 仍是这个窗口**当前真实页面**的地址（overlay 就是站点自己的地址）。两行并列是刻意的：它们是两个不同的事实，而且 **kind 决定下一步**——scratch 的文档是我们的，改法是编辑文件；overlay 的页面是真实站点的，只能打补丁。只给 URL，等于让 agent 对着一个地址猜自己能不能改它。

取值在 server 层（`SessionManager.describeWindowPrototype`）：窗口所属会话 → `prototypeSlug` → `readPrototypeConfig().kind` + `prototypeOriginUrl()`，只挂在 `snapshot`／`windows` 两次调用上，不进任何热路径；不是原型窗口时**一行都不出现**（普通浏览器窗口保持安静）。

---

## 13. 原型类型：overlay / scratch

> **§19 起这条分野下沉到页**：类型仍然"创建时定、不可改"，只是粒度从**原型**改成**页**——一个原型是同一条流程里若干页的集合，每页各自是 overlay 或 scratch。本节保留，因为它讲清了类型决定了哪四件事，以及为什么"让一个能悄悄产生废物的开关存在，比不让它存在更糟"——这两条与粒度无关，读的时候把"原型"换成"页"即可。唯一实质例外是"创建时必填地址"：创建原型不再问类型，那两张卡片搬到**新建页**对话框（§19.8）。

**问题**：§1 已经把分野定在**产物性质**上，但产品结构里没有它。创建时只问名字，于是「从无到有」和「patch 第三方」是同一个东西的两种**用法**——引导文案说不到点上，`targetUrl` 无处可存（导致详情页无法把那个页面重新打开，因为没人记得地址）。

**结论**：把分野提升为**原型类型**，在创建时确定、不可改。

### 13.1 为什么不是「一个标签」

类型决定四件事，全都是实质的：

| 决定 | overlay | scratch |
|---|---|---|
| **页面是什么** | **那个在线 URL 本身**（自带 JS、登录态与真实数据） | 我们自己写的 `base.html` |
| **补丁打在哪** | 活页面，`apply` 注入进去 | 我们自己的文档，服务器渲染时内联 |
| **有没有外部页** | 有，而且是它的**全部**（`targetUrl` **必需**） | 没有（存 URL 是撒谎） |
| **交付物** | patches + dev-spec（写明改的是哪个地址）+ **可加载的扩展**（§17） | patches + dev-spec + **可加载的扩展**（自带这一页，§17） |

第一行是这条改动最实际的收益：**"打开"的含义不再含糊**。以前两者都只能说"还没有 base 页面"；现在 overlay 打开的是它的活页面（并被注入补丁），scratch 打开的是服务器渲染出来的、它自己的文档。最后一行在 §17 展开：交付物面向两种人——dev-spec 给**实现的人**，扩展给**看的人**（他没有、也不该有工作台）；两种类型的差别只在于扩展是"注入别人的页面"还是"自带我们的页面"。

**创建时不写 `base.html`**：对 scratch 来说，缺席是一句**真话**（"这个原型还没有页"）；对 overlay 来说，它本来就不需要那个文件——它的页面是一个地址。预置一份空白会断言一个不存在的状态：`baseHtmlPresent` 变成 true，于是"怎么拿到第一页"的引导被自己藏起来，导出还会照着空文档写一份空的交付物。

> 一句值得记住的判断：**"一开局所有动作都是灰的"该由入口解决，不该由假文件解决**——空文档只是把死胡同伪装成了一条路。首稿"写一份"与"复制一份"两条来路都在创建之后，这就是入口。（历史上有过别的解法，见 [开发文档](prototype-workbench-dev.md) §4。）

**scratch 的首稿从哪来**（创建只负责建容器）：

| 来路 | 谁做 | 产物归谁 |
|---|---|---|
| **写** | agent 用文件工具写 `base.html` | 我们 |
| **复制** | 列表右键「复制」：把一个原型整份拷成**新原型** | 那个新原型（见下） |

> overlay 没有这一步：它的页面是一个地址，不需要被"准备"出来。"写"曾是界面按钮，现在不是了（§6 阶段 7）——界面上能看到的只有「预览 / 在对话里改 / 导出」。而"复制"相反，它是**列表上的动作**：复制走的是**一个原型**，不是一份材料。

### 13.1.1 复制与删除：原型列表的右键菜单

**问题**：搬材料式的做法有两个毛病。一是它回答的是"我要材料"，而人真正想干的是"我想要一份能接着改的副本"；二是它把**材料**与**身份**混在一个动作里——搬完之后目标原型的 kind / targetUrl / references 原封不动，只有页面和补丁换了，这在界面上完全看不出来。

**结论**：这件事是"另起一个"，并交回给人——**原型列表每行一个菜单（右键，或悬停出现的 `…`），两项：复制、删除**，实现是 `duplicatePrototype` / `deletePrototype` 两个只由控制面调用的能力。

三条边界，每条都有理由：

- **复制的是原型，不是材料。** 新原型有自己的 slug（默认 `<slug>-copy`，再复制一次就是 `-copy-2`）、自己的目录、自己的 `config.json`；kind 与目标页跟着过来（它们是"同一件事的另一份"这个事实），从此两者**再无关系**：改任意一边都到不了另一边。这正是它与**参考**的分野（§14.2）——参考是"读它"，复制是"拿走它"。
- **不搬 `dist/`。** 交付物是派生的（`exportPrototype` 会照页面与补丁重建），搬过来只是第二份会过期的事实。`services/`（契约 fragment 与 fixture）属于原型本身，跟着走。
- **页面与补丁作为一对走。** 补丁的选择器绑在它被写时的那份文档上；整目录复制天然保持这一对，只搬一半必然留下对不上的东西。

**删除连目录一起删**——页面、补丁、契约、fixture、交付物全在内，不可撤销。所以这是工作台唯一一处**先问一句**的动作（`window.confirm`，写明删的是什么）。两条附带规定：

- **agent 没有删除命令，也不会有。** 删掉一个原型是"哪些原型存在"的决定，属于人：agent 可以重写原型里的任何东西，但不决定原型是否还在。
- **引用了它的原型不会被自动改写。** 引用写在**引用方**的 `config.json` 里，删掉一个原型别的原型就可能指向一个不存在的 slug。这里把读者**报出来**（"还有 N 个原型在引用它"）而不是替它们做决定——关系本来就可以悬空（`unlinkPrototypeReference` 是清理它的正规做法，`prototype-status` 也会告诉读者它的参考没了），而"该改读哪一个"只有写那句话的人知道。

### 13.2 为什么创建时定、之后不可改

切换类型不是改个字段：overlay 的页面是别人的活地址，scratch 的是我们自己的文档——把前者改成后者，那些 patch 仍然指向一个不再被重放的页面，而画面上看不出来。**让一个能悄悄产生废物的开关存在，比不让它存在更糟。** 要换类型就新建一个，这是诚实的代价。

**"类型定死"顺带决定了地址必须必填。** overlay 的页面就是这个地址；类型换不回来，所以一个**没有任何页面**的 overlay 连"这是什么"都答不上来——没有能打开的东西（`pageAvailable` 为 false）、没有可写的导出物、`dev-spec.md` 里也没有地址可写。创建是唯一"用户手里就正对着那个页面"的时刻，所以 `createPrototype` 在 `kind === 'overlay' && !targetUrl` 时直接拒绝，对话框在同一条件下禁用「创建」按钮。两处是同一个不变式，不是两份规则：入口不同（UI / 命令 / agent），规矩一条。

> 顺带把**默认类型**倒过来：默认是 `scratch`。理由不是"从零更常见"，而是**只有它不可能残废**——它拥有自己的文档，所以任何状态下都有下一步（写 `base.html`，或导入一个）；overlay 缺地址则一步都没有。没有任何出路的东西必须被**要求**，不能被**假设**。`DEFAULT_PROTOTYPE_KIND` 同时是"读不到 `config.json` 时的假设"，于是坏配置的原型也落在同一条有出路的路上（§13.3）。

### 13.2.1 但地址**可以改**：环境切换

上面那句"创建时定"管的是**类型**，不管**地址**。地址不是一条规则，而是"那个页面在哪"这个事实——同一个页面存在好几套环境（本地 dev server、测试、线上），而同一批 patch 就是要在每一套里被看见。地址不可变会把"在测试环境看一眼"变成"再建一个原型、把东西全复制过去"，这是把一条事实当成了规则。

所以：`prototype-target <url>` 把**当前会话绑定的**那个 overlay 指到另一个地址，详情页的「目标页面」那一行也可以就地改（地址旁边一支铅笔）。它只强制类型自身的规矩（scratch 拒绝、地址必须是浏览器能打开的 http/https），其余一概不拦。

> 两处入口共用同一层实现（`setPrototypeTargetUrl`）与同一句代价说明：命令把它打进输出，对话框把它写在输入框下面

> 命令面的一个小取舍：`prototype-target` 是唯一**不按 `resolvePrototypeSlug` 解析**原型的命令——它唯一的位参数就是那个地址，让 slug 解析器去读只会把地址当成原型名。所以它认的是"当前绑定的原型"（`prototype-reference` 同款做法）：这也正是正在做这件事的会话的状态。

**改的时候要把代价说出来**（不是拦住，是说清），因为有两件事会**静默**过期：

| 会过期的 | 为什么它不会报错 |
|---|---|
| 已经打开的窗口 | 注入按 document 生效（§16.4），窗口停在旧地址上，直到它自己导航；`prototype-open` 一下才挪过去 |
| 选择器 | 它们是对着**当时那份 DOM** 写的。换环境可能换构建，同一个环境上线一次也会变；匹配不到的 patch 和"没生效的 patch"长得一模一样 |

这两条也正是"地址不动、站点自己变了"时会发生的事——所以它们是**提醒**，不是拒绝的理由。真正被拒的只有一种：往 scratch 上写地址（它的页面是自己的 `base.html`，存下来的地址是一句没人兑现的声明，§13.4）。

### 13.3 为什么落在数据层（而不是 UI 状态）

类型写在 `prototypes/{slug}/config.json`，因为它有**四个读者**：详情页（引导文案/元数据/按钮）、agent 的 system prompt（<prototype_context>）、agent 命令（`prototype-create`，地址给不给决定类型）、以及导出器的分叉。放在 React 状态里这些读者就拿不到。

> 这与「索引不落盘、一切按需派生」不冲突：那条约束针对 `patches/`（多 lane 并发写，共享索引必然争用），而 `config.json` 是**控制面独占、单一写者、无派生数据**，正是控制面文件该有的样子。所有权矩阵里它已登记为 `control-plane`（§3.5），所以误改会被 `prototype-status` 点名。

读取**永不抛错**：缺文件、坏 JSON、未知 `kind` 一律回退 `DEFAULT_PROTOTYPE_KIND`。理由有二——配置不可读不该让原型不可用；该文件可被手工或外部工具编辑，畸形是**预期**而非异常。默认值是 `scratch`：坏配置的原型于是落在"自己有文档"的那一支，下一步永远存在（写一份，或从别的原型复制一份）；若回退到 `overlay`，它会缺一个换不回来的地址，直接把不可读变成不可用（见 §13.2）。

### 13.4 一处刻意的收窄

`writePrototypeConfig` 会**丢掉** scratch 的 `targetUrl`。不是校验，而是不愿意落一条无法兑现的声明：scratch 没有外部页面，存下那个地址只会让后来人以为某个地方会用到它。

### 13.5 未做的（明确记录）

- **类型不可改**（同上，有意）—— 无「转换类型」UI
- **overlay 的 `targetUrl`：创建时必填，之后可改** —— 两件事不矛盾，管的是不同的东西：**必填**是因为创建时你正对着那个页面，不填则这个原型连"它是什么"都答不上来（§13.2）；**可改**是因为同一个页面存在于多套环境，那是事实不是规则（§13.2.1）。两条入口：**详情页元数据行的「目标页面」直接显示地址，旁边一个铅笔按钮**（对话框里当场写清代价），以及 agent 侧的 `prototype-target <url>`。这不是新加的第 4 个动作——它长在**那一行数据上**，而不是长在动作区（§6 阶段 7）
- **页的归属** —— 曾被列为未做（补丁不对应某一页，每一页重放**全部**补丁）；§19.4 给出了答案：`patches/<页名>/` 是页域、`patches/*` 是共享，根目录的语义不变
- **引导文案的图示** —— 两个类型卡片目前是图标 + 一句描述，没有"页面上叠一层 vs 白纸"的示意图
- **复制没有"合并"语义** —— 它是整个目录的拷贝，两个原型从此各走各的；要在复制上做取舍（合并补丁、挑着搬）不是能顺手决定的事，现在也不做

---

## 14. 混合场景：逆向第三方，然后搭自己的

**诉求原文**：「逆向第三方网站，然后搭建出自己的原型。可以选中、patch 第三方，然后作为 scratch 的参考资料。」

这句话里其实是**两种场景**，必须分开——否则会重蹈 D6 的覆辙（把两件事塞进一个维度）。

| | 那个第三方页最后变成什么 | 读法 |
|---|---|---|
| **A 起点** | 被吸收：写一份自己的 `base.html`（或从别的原型导入），此后归我 | 「抄完就变成我的」 |
| **B 参考面** | 一直是旁证：躺在旁边，我另起一份自己的 | 「照着做，但不是它」 |

两者都做，且**都不需要第三种原型类型**。

### 14.1 读法 A 撞上了 §13.2，但解法不是放开类型

A 的路径天然跨类型：开始时在别人的页上打 patch（overlay），结束时拥有一份自己的文档（scratch）。而 §13.2 规定类型创建时定、不可改。

**正确的解法是让 scratch 的首稿有来路**，而不是允许改类型：

- 创建时就声明「这会是我自己的页」，然后由 agent 写它，或把它**复制**成一个新原型（§13.1.1）。`writePrototypeBase` 本来就只依赖"项目存在"，A 在机制上早已可用；要注意的只是措辞不能反过来禁止掉主流程。
- 探索竞品的过程发生在**另一个**原型里（就是 B 的参考）。于是 A 与 B 收敛到同一套结构，规则不用松。

`scratch` 的记录随之精确为：**`base.html` 归我们**——手写的、或是从别的原型复制出来的都算；关键在于从那刻起它没有"要同步的对端"。

> **这一条走过一次弯路（已回正）**：曾经有过"把在线页冻成 `base.html`"这条来路。它回应的是一个**不存在的需求**——overlay 的页面就是那个地址本身，补丁打在上面，不需要一份 `base.html`；而冻出来的副本跑不了自己的 JS、也带不来会话。删掉的理由见 [开发文档](prototype-workbench-dev.md) §4。

**无条件覆盖的风险只剩一个入口**：`writePrototypeBase` 无条件覆盖 `base.html`，而真正会丢东西的情形只有一种——agent 手写覆盖一份**已有内容**的 scratch 文档。所以这件事是**对话约定**而不是命令层护栏：写之前先问一句；prompt 里相应的话是"do not overwrite a base.html whose edits you would lose without warning"的等价措辞。

### 14.2 读法 B 不是第三种类型

用 §13.1 的自检（类型要决定哪四件事）：

| 类型决定的事 | 混合场景里的实际取值 | 和谁一样 |
|---|---|---|
| `base.html` 从哪来 | 我们自己写的 | **scratch** |
| 交付物是什么 | 完整页面（本来就是源码） | **scratch** |
| `base.html` 缺席意味着 | 还没写 | **scratch** |
| 有没有外部页 | 有，但是**旁证**而非交付对象 | 与 overlay 的 `targetUrl` 语义不同 |

四行里三行与 scratch 相同。**加第三种类型等于把 scratch 的语义复制一份**，然后在对话框、prompt、status、ownership、导出里各加一个分支，只换来一个多出来的字段。

真正新增的只有两样：

1. **一条关系**（`references`）。而且**角色在边上，不在节点上**——同一个竞品页可以是 A 原型的参考，同时是 B 原型的交付对象。放进类型里就表达不了这个。关系是**单向**的：参考不知道自己在被参考，因为"两边看它"的人理由可以完全相反，而理由不是那个页面的属性。
2. **一条护栏**（见下）。

**这条关系与类型无关。** scratch 引用另一个 scratch，和引用一个 overlay，是**同构**的：引用者与被引用者各自独立、各持自己的 `patches/`，就够了；两边各是什么类型，不参与判断。所以：

- 数据层不按 kind 分叉：`references` 对两种类型都读、都写
- 校验层只看存在性，不看 kind
- prompt 里的规则**只写一遍**——patch 不能搬运，与两边类型无关（`overlay` 的 base 是别人页面的快照，`scratch` 的 base 是我们自己另一份文档，但"选择器绑在另一份 document 上"这件事是一样的）
- UI 的参考列表对两种类型显示同一套动作，只是 scratch 参考没有目标页——那不是缺陷，是有意为之，所以显示「它自己的页面」而不是「未记录目标页面」

### 14.3 护栏：为什么参考必须独立成项目

`packages/shared/src/prototypes/export.ts` 的 `exportPrototype` 内联的是该原型 `patches/` 下**全部**文件（`scanPrototypePatches(workspaceRootPath, slug)`）。所以只要参考的 patch 和我的 patch 共用一个 `patches/`，导出时它们会被**打进我的交付 HTML**：选择器指向竞品的 DOM，在我自己的页面上一条都不生效，而且**不报任何错**。

这正是这个项目一路在防的那类静默失效。于是：

- **结构性护栏**：参考是一个**独立的原型**（哪种类型都行），各自持有自己的 `patches/`。`linkPrototypeReference` 是连接两者的**唯一**途径——不是"建议这么用"，而是没有别的路可走。
- **语义护栏**：prompt 里写明参考是 `evidence, not material`，且**禁止**把参考的 patch 复制进交付物的 `patches/`（"它们的选择器是照另一份 document 写的，不会在这里匹配，却会不打一声招呼地进入交付物"）。结构性护栏挡得住机械错误，挡不住 agent 主动搬运，所以两条都要。

换来的是参考获得了**独立生命周期**：竞品会改版，参考会烂，所以它要能被重新打开、重新对照（overlay 参考打开的就是那个活页面，永远是最新版）；而一个交付原型可能参考三个竞品。

### 14.4 为什么落在数据层，以及命令面

`references` 写在 `prototypes/{slug}/config.json`，与 §13.3 同一个理由——它有多个读者：详情页（参考列表/打开/解除）、agent 的 system prompt（解析出每个参考的 kind 与 targetUrl，agent 无需去读对方的 config）、以及 agent 命令。

只做 UI 是不够的：agent 才是这个工作台的主要操作者，用户会在对话里说「把这个也加进来参考」。没有命令，agent 就会去手改 `control-plane` 独占的 `config.json`——正是上面那类损坏。所以补了两条：

| 命令 | 作用 |
|---|---|
| `prototype-reference <slug> [--remove]` | 把 `<slug>` 记为**会话所绑定原型**的参考 |
| `prototype-create … --no-bind` | 创建但**不抢绑定** |

第二条不是锦上添花，是必需：`prototype-create` 默认建完就绑定（§11 的设计），于是「先建一个参考原型」会把整个会话的默认目标悄悄换成被研究的那个页面——之后每条省 slug 的命令都打错地方。`--no-bind` 就是为了堵这个。

`prototype-reference` 的读者**只能是绑定原型**（不接受位置参数指定）：它的位置参数已经是参考本身，两个 slug 并列无法消歧。未绑定时报错并点名 `prototype-bind`，而不是猜。

### 14.5 未做的（明确记录）

- **非绑定原型的参考** —— agent 侧只能往绑定原型上加参考（UI 侧不受限）
- **悬空参考** —— 手工删掉参考原型的目录后，`references` 仍留着那个 slug。读取不做存在性过滤（不引入静默忽略），prompt 会把一个不存在的 slug 报给 agent，失败是可见的；`--remove` 宽容这一点，所以清理有路可走
- **参考的 patch 对交付物的可追溯性** —— 「这条改动是从参考的哪一处翻译来的」没有落成数据，只在对话里

**一处有意为之**：不禁止**互看**（A 引用 B 且 B 引用 A）。关系是"看"而不是"属于"，两边互相参考没有矛盾，也不构成循环——prompt 只列直接参考，不会展开。唯一被丢弃的是**自引用**（`normalizePrototypeReferences` 在读取时丢掉自己），因为那在语义上是自相矛盾的。

### 14.6 agent 怎么看见这张图

关系存在数据里是**单向**的（角色在边上），但"感知一张图"要求**两端都可见**。所以 agent 的读取面分成三层，各自回答不同的问题：

| 读取面 | 作用域 | 回答什么 |
|---|---|---|
| system prompt · `<prototype_context>` | 绑定的那个 | **我绑定的这个是哪种、它在参考谁**（每个参考都带 kind 与 targetUrl，agent 不必去读对方的 config） |
| `prototype-list` | 全工作区 | **这片工作区里有什么**：每个的 kind、target 页、`references:` 与 `referenced by:` |
| `prototype-status [slug]` | 单个（可显式传 slug） | **这一个的全貌**：kind（带一句它意味着什么）、target、解析后的 references（含对方是什么）、以及 `referenced by:` |

三点设计判断：

1. **kind 出现在每一层，而且不是脚注。** 之前 `prototype-list` 只列 slug 和 patch 数——一个 overlay 和一个 scratch 在列表里**长得一模一样**，而它们的行为毫无相似之处（活页面 vs 我们自己的文档、地址 vs 文件）。这属于「状态撒谎」，不是缺个字段。列表里"缺什么"也按类型说：overlay 说 `no target page`，scratch 才说 `no base.html`——对 overlay 而言"没有 base.html"是常态，写出来只会训练读者忽略它。
2. **反向关系是派生的，不入库。** `referenced by` 由列表现算，不写进 `config.json`：写进去就有两个真源，而它们一定会漂移。代价是 `prototype-status` 要多读一次列表——值得，因为 `references: rival-checkout` 在你知道对方是什么之前**不可行动**。
3. **prompt 里不铺开整个工作区。** 工作区可以有十个原型，全列进 prompt 对多数会话是噪音；它还是会话开始时的快照，中途新建就过期。工作区级查询是**命令**的职责（工具描述里已写明 `prototype-list` 给出 kind 与双向关系），prompt 只负责绑定原型自己的事实。

悬空参考（原型目录被手工删掉）在这里**被点名**而不是静默消失：`prototype-status` 打印 `MISSING — no prototype with that slug`。这与读取时不做过存在性过滤是同一条原则——不让状态说谎。

---

## 15. 原型与项目：没有关系，而且不该叫同一个词

**问题**：这个工作区里有**两个不同的东西都叫 "project"**：

| | 项目（Project） | 原型（Prototype） |
|---|---|---|
| 在磁盘上 | `{workspace}/projects/{slug}/` | `{workspace}/prototypes/{slug}/` |
| 里面有什么 | `config.json` · `assets/` · `MEMORY.md` | `config.json` · `base.html` · `patches/` · `services/` · `dist/` |
| 是什么 | **组织过程**：归组会话、任务（`TaskSpec.project`）、工作目录、共享资产、看板列 | **就是产物**：交付物本身 |
| 生命周期 | 可归档、**可删除**（删除时解绑会话） | 交付物，应当活过单个会话 |

**它们今天没有任何关系**，这不是疏漏：[workspaces/storage.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/workspaces/storage.ts) 的注释写明了原型放在工作区级是为了「让交付物活过单个会话」。`PrototypeConfig` 里没有 `projectId`，`handlers/rpc/prototypes.ts` 与 `handlers/rpc/projects.ts` 互不调用，没有任何 join。

**唯一的实际交汇在会话上**：一个会话可以同时持有 `projectId` 与 `prototypeSlug`，于是两个 context 被并列注入 system prompt（`claude-agent.ts` 的 `pinnedProjectContext` 与 `pinnedPrototypeContext`）。所以 agent 确实知道「我在项目 P 下做原型 X」——但**这个关系没有被记录在任何地方**：原型不知道它属于哪个项目。它是会话上的两个点，不是一个连接。

### 15.1 决定：不建立归属关系

判据还是那个：**什么变了？**

1. **目录嵌套（`projects/{p}/prototypes/{x}/`）不该做**：项目可删可归档，而原型是交付物——把交付物的路径挂在会被删除的容器下面是数据丢失隐患。
2. 若将来要连，正确形态是**一条关系**（`PrototypeConfig.projectSlug?`），与 `references` 同一套写法：关系落在 config、删除时表现为悬空关系（§14.5 已定好处理方式：点名，不静默丢弃）。这条留在纸上，随时可低成本实现。
3. 但**它唯一的读者是「按项目分组 / 项目详情页列出它的原型」**。原型还是个位数时这个字段没有消费者——按本方案的规矩（D12、派生索引），**没有读者的字段就是死字段**。等原型多到需要分组时再加。

### 15.2 同时：把命名分开

"prototype project" 这个说法让两个概念在代码里长得像一回事。已改为一律说 **directory**：

| 改前 | 改后 |
|---|---|
| `getPrototypeProjectPath()` | `getPrototypeDirPath()`（与 `status.dir` 同名语义） |
| `createPrototype as createPrototypeProject` | `createPrototype as createNewPrototype` |
| 注释/JSDoc 里的 "prototype project"、"Absolute project directory" | "prototype"、"the prototype's directory" |
| 局部变量 `projectDir` | `prototypeDir` |
| **给模型的文本**："Prototypes — **one project per requirement**…" | 改为显式排除混淆：**"A prototype is NOT a project: projects are separate containers…"** |

最后一行是这次改名的**主要理由**，不是顺带：这段文本进的是 `browser_tool` 的工具描述，**永远在上下文里**；而模型同时还看得到真实的 `<project_context>`。两个"project"同时出现时，模型没有任何线索能分清。

### 15.3 未做的（明确记录）

- **原型按项目分组/过滤** —— 同上，等有消费者
- **`apps/electron/resources/docs/browser-tools.md` 还缺原型基础命令的章节** —— `prototype-list` / `create` / `bind` / `reference` / `target` 这几条随应用发布的文档里没有（`apply` / `export` / `mock` / `status` / `open` / `pages` 有）。独立的文档同步，未做

---

## 16. scratch 文档的载体：Electron 直接应答 http

> **适用范围**：这一节只讲 **scratch**。overlay 的页面是它自己的在线地址（§13.1），真实站点本来就有 origin、cookie 域和能跑的相对 fetch，不需要这里任何东西。这一节解决的是"我们**自己写**的那份 HTML 拿什么当 origin"——答案是 `http://<label>.localhost`，由 Electron 在浏览器 session 上自己应答。

**问题**：scratch 的文档要的不是"一个能打开的地址"，而是一个**真的 origin**。opaque origin（`file://` 那类）缺的东西，正好是这条链路依赖的：

| 缺什么 | 后果 |
|---|---|
| 没有 cookie 域 | 无法模拟登录态；`document.cookie` 写不进去 |
| **相对 `fetch`/XHR 发不出去** | Blink 直接拦掉 file→file。**mock 层因此永远看不到请求** |
| ES module 被 CORS 拦 | `<script type="module">` 不执行 |

第二条是决定性的：§5 的整条「契约 → mock → 前端」闭环，在这种文档上完全不可用——不是 mock 写错了，是请求压根没发出来（`browser-cdp.ts` 靠 `Fetch.enable` + pathname 匹配，它只能看见 renderer 真正发出的请求）。

**影响范围只有一笔**：我们自己的原型文档。overlay 主路径在真实页面上是**真 http**，patch 注入按 document 生效与 scheme 无关，截图/DOM/pick 都不受影响。

### 16.1 为什么是拦截 http，而不是本地监听器

两个方案都能给出"一个真的 origin"，差别在**地址稳定性**与**失败面**：

| | 本地监听器（弃用） | 拦截 `http`（采用） |
|---|---|---|
| origin | `http://<label>.localhost:<port>`，**端口每次启动都变** | `http://<label>.localhost`，**稳定**；cookie 与 localStorage 因此跨重启 |
| 谁在真实浏览的路径上 | 没有人（独立 socket） | **我们**：handler 按 scheme 注册在浏览器 session 上，该 session 里每个 http 请求都先经过它 |
| 非我们 host 的请求 | 与本方案无关 | `net.fetch(request, { bypassCustomProtocolHandlers: true })` 原样交回 Chromium |

采用拦截，是因为**地址稳定是功能**（登录态、`localStorage`、一个能贴进对话的地址），而"别人页面的请求经过我们这一层"是可以接受的代价——前提是把代价钉死：**只拦 `http`**（原型 host 就是 `http://…localhost`，`https` 一个字不碰）、**不属于我们的 host 一律原样交回**、**handler 永不抛异常**。细节与理由都在 `prototype-host.ts` 的模块说明里。

**自定义 scheme（如 `craft-proto://`）不采用**：注册成 standard 后 Electron 确实会打开 localStorage / sessionStorage / indexedDB 甚至 cookies，所以"没有存储"不是理由；真正的理由是它把请求换成了非 http scheme，而 mock 层靠 CDP `Fetch.enable` 在网络层按 pathname 兑现响应——这条链路对自定义 scheme 是否生效必须实测，否则正好废掉 §16 存在的两个理由（cookie 与 mock）。

### 16.2 地址形状的前提已验证

`*.localhost` 在 Chromium 里解析到回环，所以不需要 DNS 或 hosts 条目；一次性 Electron 探针在这样一个地址上确认了 origin / cookie / 相对 fetch / `type="module"` 四条全部正常（探针与结论见 [开发文档](prototype-workbench-dev.md) §2）。这四条是主机名的性质、与端口无关，所以现在地址里没有端口也一样成立。

**还没实测的一条**：pass-through 是否无损（分块上传、流式响应、下载、HTTP 缓存）。它属于"真实窗口里点一遍"的清单，见 [开发文档](prototype-workbench-dev.md) §5.4。

### 16.3 地址形状：一个原型一个 host，目录即 origin 根

```
http://<slug>-<目录hash>.localhost/                 ← 原型的首页（见下）
http://<slug>-<目录hash>.localhost/<原型内文件路径>   ← 原型里的任意文件
```

**根路径是原型的"首页"，两种类型各有确切含义**（就像一个扩展的 home page：一个地址代表它自己，而不是一个没人应答的地址）：

- **首页是页索引，或者你指定的那一页**（§19.3）：默认渲染宿主生成的列表页；某页标了 `entry` 就落到它——scratch 页是**该文档 + 它生效的全部 patch**、按请求现算，overlay 页是 **302 到它的真实地址**。scratch 这一侧带的是**此刻**的补丁，所以"我在看的东西"就是"我会交付的那批改动"（交付物包里的那一页是同一份文档，另加扩展要求的改写——内联脚本提成文件、补丁改成文件引用，见 §17.1：同一批补丁、同一顺序、行为相同，字节不同）。这条替换掉了原先那种二选一——**裸文档**（一条 patch 都没有）与**上次导出的文件**（冻结在导出时刻）都不是这个原型。
- **overlay 页的首页指向自己的真实地址**：页面本身仍在它自己的地址上（cookie、登录态、源都必须是真的），host 只负责指过去。于是 `/` 在这些原型上不再可能是一个 404 的地址——"打开这个原型"与"取这个 URL"第一次不是同一件事。
- **每一页都有稳定地址**：overlay 的页按名字挂在根下，`/<页名>` → 302 到该页真实地址；页名一层深（`/orders`，不含 `/orders/42`——更深的路径属于应用自己，在它自己的 origin 上）。**文件优先于页名**：目录里真有一个 `orders`，就发那个文件。
  > 这个 302 是给**别的加载器**的（扩展、直接取这个地址的调用方）：窗口自己不用它——工具栏敲 `/<页名>` 时主进程直接解析出那一页的地址让视图加载（§12.6），少一跳，也不受"注册即边界"（§16.6）影响。

单个文件仍然可以按名字取用，各种地址含义如下：

| 地址 | 是什么 |
|---|---|
| `/` | 首页（§19.3）：默认是**页索引**；某页标了 `entry` 时 = 那一页（scratch → 渲染结果，overlay → 302 到它的真实地址） |
| `/_index` | **页索引**本身，永远可达——配了入口之后，要看有哪些页就走这里 |
| `/<页名>` | overlay 的那些页（302 到该页真实地址）；scratch 页没有页名——它的页就是文件（`/cart.html`） |
| `/cart.html` | **这个原型的一页**：同一套规则（该文档 + 生效补丁，现算）。顶层每个 `*.html` 都是一页（§19.2） |
| `/base.html` | 只是名字叫 `base` 的一页。§19 起 `base.html` 不再特殊——"裸底稿"这个调试地址随之取消 |
| `/dist/extension/` | **交付物包**（§17）：manifest、补丁脚本、README，scratch 页各自一份产物 |
| `/dist/extension/cart.html` | 包里那一页：**同名构建产物**（带补丁、内联脚本已提成文件）。名字不变是为了让页间链接零改写；`prototype-export` 打印的是入口那一份（旧数据提升后它叫 `base.html`）。旧路径 `/dist/prototype.html` 不再有人写 |
| `/assets/app.css` 等 | 目录内的静态资源 |

**原型目录就是那个 host 的根**，而不是挂在某个路径前缀下。理由不是美观：页面的 `src="/assets/app.css"`、`fetch('/api/orders')`、路由器的 `/orders` 都指向 **origin 根**，而页面并不知道也不该知道自己被放在子目录里。带前缀（`/prototypes/<slug>/…`）会让"假设自己拥有 origin"的页面全部坏掉——那是绝大多数页面。

host 里两半各答一个问题：**目录 hash** 保证唯一（两个 workspace 可以都有 `checkout-flow`，把其中一个的页面喂给另一个是静默换文件），**slug** 让它在日志和对话里可读。

**没有任何东西可以顶替它**。交付物包里的那一页（`/dist/extension/base.html`）仍然可以按名字取用（想看交付物就看），但它是**旧状态的快照**、也不是一个能继续编辑的页面，所以它永远不是"这个原型的页面"。因此 `base.html` 不在时：**scratch** 的根 404（`Nothing to serve`），`resolvePrototypeEntry` 抛错并点名三条来路——而不是拿别的东西冒充；**overlay** 的根不依赖 `base.html`（它指向入口页），没有 `targetUrl` 时同样明确报错。

**overlay 的窗口地址栏也读作原型域名**（§12.6）：它的 `pageView` 停在第三方地址上（必须如此），而窗口的身份是这个原型。它的 `/` 因此不是"渲染结果"而是**指向入口页**——两件事在同一个地址上并存：面板里敲它 = 打开这个原型（§7），别的东西取它（agent 的 `navigate`、任何直接请求）= 302 到那一页。

**这同时修掉了一个说不清的入口**：早先的规则在有 base 时才给 origin、否则退到交付物，于是"打开"这个词在不同原型上指向**两种不同的东西**（一份活文档 / 一份冻结制品）。现在它只有一个意思：**打开 = 打开这个原型当前渲染出来的样子**，可以在上面继续改、继续打补丁。

### 16.3.1 SPA

| 场景 | 处理 |
|---|---|
| 打开 `/`（scratch） | 返回渲染后的原型页面 |
| 打开 `/`（overlay） | 302 到入口页——根永远有指代，从不 404 |
| 打开 `/<页名>`（overlay） | 302 到那一页；没有同名文件时才这么做（文件优先） |
| history 路由刷新（`/orders/42`，scratch） | 无对应文件时回退到**同一个渲染页面**——这是 SPA 的路径，服务端不认识 |
| **标了扩展名的路径**（`/missing.js`） | **不回退**，老老实实 404。用 HTML 回答缺失的脚本，会把"文件没了"变成"解析错误" |
| 根绝对路径资源（`/assets/app.css`） | 按目录内路径查找并**正常命中**——这条是"目录即根"的直接收益 |

这也让**从零写的 SPA 文档**第一次真正可用：它的 `pushState` 路由刷新能拿到文档，它的客户端路由能起来。

### 16.4 代码上的接法

**一处注入**：主进程启动时用 `prototype-host.ts` 的 `registerPrototypeProtocolHandler(session.fromPartition(BROWSER_PANE_SESSION_PARTITION), req => net.fetch(req, { bypassCustomProtocolHandlers: true }))` 把 `http` 接下来，再由 `installPrototypeBaseUrlResolver()` 让共享层能问出地址。共享层两个出口：`prototypeOriginUrl()` 给"原型页面"，`prototypeDocumentUrl()` 给"某个具体文件"。`resolvePrototypeEntry()` 与 `exportPrototype()` 都走这里，所以 `prototype-open`、RPC `prototypes:entry`、详情页 Open 按钮三处入口**一行都不用改**。

**没装上 handler 时 resolver 返回 null**，入口**明确报错**——那时没有能显示补丁的地址，端出一个"看起来像原型、其实一条 patch 都没应用"的页面只会更糟。

**渲染用的是导出器那一个函数**：`buildSelfContainedHtml(baseHtml, scanPrototypePatches(...))`。导出 = 把它写进交付包，预览 = 把它当响应体返回。同一份变换，所以"看到的"和"导出的"不可能分叉。

### 16.4.1 已经内联的补丁不会被重复应用

"打开的就是打了补丁的预览效果"与"打开后还能继续应用编辑"是同一个问题的两面：页面到手时补丁**已经在文档里**了，此时再注入一遍会让 JS patch 跑第二遍——**页面看起来一模一样，改动却是错的**，没有任何东西会报出来。

**做法是让文档自己说明它带了什么**：`buildSelfContainedHtml` 在有补丁可内联时，额外写一个标记元素

```html
<script type="application/json" id="__craft_prototype_inlined__">["A-001-btn.css","B-002-total.js"]</script>
```

注入前先读它（`buildInlinedPatchProbeScript()`），**跳过列出来的那些，其余照常注册并立即执行**。读不到、读不成 JSON、不是字符串数组，一律当作"这份文档什么都没有"——这是唯一安全的方向：反过来（默认已应用）会让该做的活被静默跳过。

两条设计要点：

- **判断读的是文档本身，不是地址。** 标记随文档走，所以另存出去的渲染页、上一次会话留下的副本，同样认得出。
- **注册集合与"页面上缺什么"严格对齐**：每次 apply 都是「清掉本原型的全部注册 → 只注册缺的那些」。init script 是 window 级的，注册一次会在之后**每个** document 上执行，若已内联过的也注册，重新加载出来的渲染页就会跑第二遍；顺带这也保住了"删掉 patch 文件就真的不生效"。

### 16.5 边界（五条，各自有测试）

1. **只有注册过的 label 由我们应答**：注册发生在"某个原型被打开/导出"时，我们从不遍历文件系统去找东西服务。没注册过的 host——包括 `a.b.localhost` 这种多标签名——一律**交回 Chromium**：`*.localhost` 上跑着真实 dev server 是常态，把这种地址当成"没人发放过的名字"去 404，等于把别人的页面弄坏了。
2. **只拦 `http`**：原型 host 就是 `http://…localhost`，所以 `https` 流量完全不经过我们。
3. **路径围栏**（`resolveServedPath`，独立导出单独测）：解码后拒绝 NUL 与反斜杠（Windows 上反斜杠是分隔符，放过一个就能绕过前缀检查），`resolve` 折叠 `..` 后必须落在目录内，前缀比较用 `${root}${sep}` 以免同名兄弟目录（`checkout-flow-secrets`）蒙混。
4. **`Cache-Control: no-store`**：文档与补丁在被反复编辑，缓存住的页面会显示上一次的结果而没有任何提示。
5. **handler 不抛异常**：我们这一侧的失败答 500 并记日志，不让别人的页面吃到一个来路不明的网络错误。

### 16.6 未做 / 已知限制

- **我们站在真实浏览的路径上**（http 那一半）：别人的请求由 `net.fetch` 交回网络栈，但"交得是否无损"要在真实环境点一遍——分块上传、流式响应、下载、HTTP 缓存。这是换到拦截的代价，不是待修项；清单见 [开发文档](prototype-workbench-dev.md) §5.4。
- **注册即边界**：地址跨重启不变，但可达性不跨会话——上次那个地址在重新打开该原型之前答 404（注册发生在"被打开/导出"时）。
- **这套应答只管 scratch 页**：overlay 页的文档是它自己那个在线地址，从头到尾不经过这里（只有 scratch 页会被渲染）。所以"相对资源打到我们这里"这类问题只可能出现在 scratch 页上，而它们的资源本来就在自己的目录里。
- **`/` 的含义是"这个原型的首页"**：默认页索引，或页表里标了入口的那一页（§19.3）。索引是**按请求生成**的，没有落盘的 index 要同步。
- **改了已有补丁的*内容*，页面不会自己变**：页面是在渲染那一刻内联的，`prototype-apply` 只补"页面上还没有的"（按文件名判断，见 §16.4.1），所以新增的那条立刻生效、改过内容的那条要**刷新**才看得到。没做内容指纹是刻意的：按内容只能判断出"页面上的版本旧了"，而正确处理只有重新渲染一条路——那和刷新是同一件事，多一层判断只多一处能错。
- **判别只认文件名，不认版本**：把一个补丁文件删掉再写一个同名的，同样会被算作"已内联"。这是上面那条的另一面，不是独立缺陷。
- **没动的东西**：`webSecurity` 仍未开（D5），没有新增 partition；真实页面浏览路径除了"每个 http 请求多一次 host 判断"之外零改动。

---

## 17. 交付物：一个原型一个扩展

**问题**：§13.1 把 overlay 的交付物定成「patches + dev-spec」，可这两样都是给**实现的人**的，不是给**看的人**的。真实场景是「让设计/老板/同事看见效果」，而对方没有这个工作台——他不该为了看一眼而装 Electron，我们也不该要求他这么做。scratch 那一侧同理：自包含 HTML 能"打开就看"，但它进不了真实产品的上下文。

**结论**：交付物是**一个可加载的 Chrome 扩展**——**一个原型一个扩展**，生成到 `dist/extension/`，在 `chrome://extensions` 里 Load unpacked。不进商店、不发布、卸载即消失；**Chrome 只是运行载体**。

| | overlay | scratch |
|---|---|---|
| 扩展做什么 | 把补丁注入**真实页面** | **自带那一页** |
| 怎么打开 | 打开目标页即可，没有要点的东西 | 扩展的 **options 页 = 这个原型的页索引**（§19.5）：点一页过去；工具栏图标打开首页入口 |
| content script | 有：`matches` = 这个原型的所有页；CSS 在绘制前注入、JS 在 `document_idle`；每个匹配文档自动注入，SPA 换视图由 bundle 重放 | 没有（没有别人的页面可注入） |
| mock | 带（§17.2） | 带 |

**落盘形状**：`dist/extension/` 里有 `manifest.json`、`README.md`（装法 / 作用范围 / 每一页 / 改了哪些补丁 / 版本与构建时间 / 已知边界）、补丁与 mock 产物（共享，在包根各一份），scratch 另有**每一页**（文件名不变，页间链接零改写）与每页自己的提取产物（`assets/<页名>/`）；`dist/dev-spec.md` 留在原型层，不进扩展包——它是给实现的人的，不是给运行载体用的。

**交付物是"载体"而不是"页面"**：overlay 的页面是别人的活页面，我们永远交不出那个页面，只能交出叠加在上面的改动。载体用**内容脚本**而不是注入进页面的脚本，于是三条一起成立：页面 CSP 管不到它、一次注入对该文档持续有效（刷新与翻页都不必再点）、内容不必塞进一个 URL（体积预算因此不存在）。其它载体的账见 [开发文档](prototype-workbench-dev.md) §4。

**为什么不是别的**（都算过账）：

| 备选 | 为什么不行 |
|---|---|
| `service worker` | 管的是扩展自己的生命周期与消息，**改写不了别的页面的响应** |
| `declarativeNetRequest` | 只能重定向/改头，**不能合成响应体**；GET 靠重定向到包内文件还能糊，POST 直接歇 |
| `webRequest` 阻塞模式 | MV3 **已对普通扩展移除**，只剩企业策略安装的扩展能用 |
| `chrome.debugger` | 能拿到完整 CDP（等价于工作台内那套），但要 `debugger` 权限，评审人打开页面会看到"正在调试此浏览器"横幅，且 **DevTools 被占住** |
| sandbox 页 | 无视扩展 CSP，内联代码全都照跑；代价是 origin 变成 opaque：没有 `localStorage`、ES module 与相对 fetch 不可靠——**而内联代码不必走到那一步**（§17.1） |

### 17.1 agent 的契约不变

**第一原则**：agent 只写「一份完整 HTML 文档」，它**不需要知道**扩展、CSP、manifest 或 options 页的存在。扩展带来的约束全部由**生成器**吸收；吸收不了的**报给用户**，而不是回头要求 agent 改写法——要求 agent 记住一条扩展规矩，等于把实现细节漏进它的心智，而心智负担正是这一轮要压掉的东西。

| agent 会写 | 扩展里会发生什么 | 谁吸收 |
|---|---|---|
| 内联 `<script>…</script>` | 扩展页不允许内联脚本 | **生成器**：提取成文件、改引用（机械，只改引用不改行为） |
| 内联 `on<event>="…"` | 同上 | **生成器**：代码提成生成函数 + `data-` 标记，配一个 MutationObserver 运行时按标记绑定（**不需要 eval**，运行期插入的 HTML 也命中） |
| `<script type="module">` | 内联的被拦 | **生成器**：提取成文件（属性保留） |
| 内联 `<style>` | 照常 | MV3 对扩展页没有 `style-src` 策略 |
| `localStorage`、包内相对 fetch | 照常 | 扩展页有完整 origin |
| `eval` / `new Function` | **过不去**（MV3 硬禁） | 不吸收：原型页用不到，不进设计 |

这就是"交付物与工作台所见**行为一致**"的兑现方式：唯一不同的一步是"内联脚本变成文件"，而它只改引用、不改行为。

### 17.2 mock 一起交付（默认带）

工作台里「契约 → mock → 前端」是一条正经路径（阶段 5）。交付物里若没有 mock 层，按这条路径写的原型**交付出去就是坏的**，而 agent 不会知道——所以默认带。

- **怎么拦**：`world: "MAIN"` 的内容脚本包装页面自己的 `fetch` / `XHR`，命中路由直接返回包里的 fixture。它是 app 内那套（CDP `Fetch.fulfillRequest`）的等价物，只是拦截点从网络层挪到页面里；**响应头由我们控制**，可以照着真实 API 的 CORS 形状伪造。
- **为什么不用 `chrome.debugger`**：它能拿到完全一样的 CDP 能力，但会挂调试横幅并占住 DevTools（见上表）。
- **说清哪部分是假的**：README 里列出被伪造的路由。"这一行数据是造的"不是实现细节，正是评审的人该知道的事。
- **边界**（写进 README，不藏）：只盖 `fetch` / `XHR`；`<img>` / `<script>` / WebSocket / `sendBeacon` 盖不住（本来也不该 mock）；**真实产品若是 PWA，由它自己的 service worker 发起的请求盖不住**。

### 17.3 这给 patch 改的作者规矩

| 规矩 | 为什么 |
|---|---|
| **可重跑** | 每个匹配文档都会注入一次，SPA 换视图会重放，Reload 扩展也会 |
| **不假设 document-start** | 它是**编译选项**而不是约束：CSS 走 content script 的 `css`（绘制前），JS 走 `js`（`document_idle`） |
| **没有死补丁** | 质量要求（不是硬约束）：交付物里的一切都要有人读 |

### 17.4 快照语义与版本号

交付物是**某一刻的快照**：改一条补丁要重新导出，并在 `chrome://extensions` 点 Reload（已打开的页面还要刷新）。静态扩展没有"实时"，所以包里带 **version + 构建时间**（version 由导出时刻推出、README 写明），让"我看到的和你说的不一样"有一个能回答的问法。

### 17.5 组织方式：一变更一文件，产物才是单一的

**否决了「让 agent 永远只编辑一个 js」**，代价是具体的：

- **一个文件 = 一个写者**，直接杀掉 lane 所有权（文件名里的 lane 前缀就是为它存在的）；两个 agent 同时改一个文件就是静默丢更新。
- **丢掉「删文件 = 撤销一条改动」**，这是现在最便宜的 revert。
- **交付物变差**：dev-spec 按 patch 列全文，一个不断膨胀的 js 会让"这个流程到底改了什么"不可读。

需要单一的是**产物**（扩展里的那一个脚本 / 那份 manifest），不是**源码**。也要说清反面：一个原型只有一条 patch 是**允许**的，小流程本来就该长这样。规矩是"一个变更意图一个文件"。

### 17.6 不引入 git

- **变体**已有更便宜的答案：再建一个原型 + `references`（§14）。每个变体可独立打开、独立导出，不需要 checkout。
- **合并**在模型里是违规而不是工作流：`canLaneWrite` 直接拒绝并报出来。
- **历史**：dev-spec 每次导出就是一份可 diff 的全量记录；原型是纯文件，workspace 若在用户自己的 git 仓库里，天然被版本化——**不需要我们写一行代码**。
- 值得偷的 git 思想已经有了：append-only 文件 + 派生索引 ⇒ 删文件即撤销；复制原型即分支。
- 真正的缺口不是 git，而是**两个人同时改一个原型**——那才需要合并，等遇到再说。

### 17.7 未做 / 已知限制

- **扩展的签名与分发**：没有图标资源、没有 zip 打包、没有企业策略分发。`Load unpacked` 对内部评审够用；要发给外部的人，得手动传目录或压缩包。**不做商店上架**（这是产品决定，不是待办）。
- **patch 之间没有冲突检查**：两条补丁改同一个元素时，谁赢由文件名顺序决定（`lane → 序号 → 名字`），没有检测也没有提示。这与 §3 的所有权模型一致（同一路径只有一个写者），但**不同文件改同一处**仍可能互相覆盖。
- **内容指纹**：交付物里的补丁不参与"是否已应用"的判断（靠的是 `window` 上的安装标记，不是内容）。改了一条补丁的内容，评审的人要重新导出并 Reload——这是必然的，交付物是**快照**，与 §16.4.1 的"按文件名算已内联"是同一类妥协。
- **生成器吸收不了就会说**：内联事件的处理、模块脚本的提取都是文本变换，遇到它没把握的写法时**报出来**给用户看，而不是猜。这是这条路上唯一会让人"手动改一改"的地方。
- **桌面限定**：Chrome / Edge 这类 Chromium 系可加载 unpacked；Safari / Firefox 不做。

（落点——改了哪些文件、每处改什么——见 [开发文档](prototype-workbench-dev.md) §1／§2；验收见 §10 的 M 组（63–70）与 Q 组。）

---

## 18. 多页面原型：页是原型的一部分

> **§19 起本节被页层模型取代**：页的判定、地址、页与补丁的归属、交付物按页打包，一律以 §19 为准。本节保留的是它提出的问题和两条仍然成立的结论——**页是原型的一部分（不新增一层身份）**，以及 **overlay 的页表按声明序而不是字母序**。三处已被推翻："scratch 的页表决定不做"（现在有顺序与入口要管，`config.pages` 是两个类型共用的表）、"补丁按页切分要等元数据"（目录即归属，§19.4）、"`base.html` 是入口页"（入口是页表里的一行标记，§19.1）。

**问题**：一个原型是一条**流程**（购物车 → 地址 → 支付），而"一个原型 = 一个文档"这条假设写在三个地方，于是多页只能靠"一页一原型"或"假装成 SPA"绕过去：

| 位置 | 原状 | 后果 |
|---|---|---|
| 原型文档的应答（当时的 `prototype-server.ts`） | 只有**根路径**渲染（base + 全部 patch），其它 `.html` 按文件裸发 | 目录里放第二张 `orders.html`，补丁一条都不进去——多页 scratch 是**残的** |
| `config.json` | overlay 只有**一个** `targetUrl` | 跨页流程在真实站点上是多个 URL，原型无处声明"我包含哪几页" |
| 面板 / `PrototypeStatus` / prompt / 导出 | 全是单文档视角 | 讲不清"这几页各改了哪些东西"，交付物也只能一页一份 |

**结论**：页是原型的一部分，**不新增一层身份**——不是"一页一原型"，也不是新的 kind。

**① 页的判定规则**（`pages.ts`，服务端与状态报告读同一条规则、同一份事实）：

- **scratch**：目录里**顶层**的每个 `*.html` 都是这个原型的一页；`base.html` 是**入口页**（地址根渲染的那一份）。页就是文件，加一页 = 写一个文件 + 从别处链过去，不需要声明、也不会漂移。
- **overlay**：页是真实站点上的 URL。站点不是我们能遍历的，所以页来自配置 —— `config.json` 的 `pages`（见 ⑤）。
- **两个文档不是页**：`base.html`（作者编辑的裸底稿——它按名字可达，正是为了看到未渲染的样子）与 `dist/**`（导出时冻结的交付物；把今天的补丁灌进昨天的快照是对两者的双重谎报）。子目录里的文档也不是页：页住在原型的根，子目录放的是资源。

**② 注入泛化到每一页**（`filePayload` → `buildPrototypePage`）：任何一页都按根路径同样的方式服务——该文档 + **全部**补丁，按请求现算。这是多页 scratch 能用的**前提**：否则第二页没有补丁，而"没有补丁"和"补丁没匹配上"长得一模一样。

**③ `PrototypeStatus.pages`**：入口在前，其余按**流程顺序**（overlay 是声明序；scratch 没有声明，按名字序），每页带 `name / file / url / entry`。命令和输出共用这一份列表：`prototype-status` 列出 `pages:`，`prototype-open --page <name>` 打开其中一页，名字不存在时**把可选项列出来**（而不是只说不行）。读不干净的 `pages` 条目会被丢弃并进 `pageIssues`，由同一份报告点名。

**④ agent 知道"现在是哪一页"**：`snapshot`／`windows` 的 `Prototype` 行带上 `page "<name>"`，由 `matchPrototypePage` 从窗口的**真实 URL** 反推。scratch 上未列出的路径算入口页（服务端正是用入口文档服务 history 路由）；**overlay 不这样兜底**——`/login?next=…` 不是原型描述的那一屏，说它是，就把那个值得注意的重定向藏起来了。

**⑤ overlay 的页表（`config.pages`，已实现）**

页来自配置，因为真实站点不能遍历。形状与不变式：

```jsonc
{
  "kind": "overlay",
  "targetUrl": "https://app.example.com/cart",   // 入口页：默认打开，唯一表示
  "pages": [                                      // 其余页，按流程顺序
    { "name": "address", "url": "https://app.example.com/checkout/address" },
    { "name": "payment", "url": "https://app.example.com/checkout/payment" }
  ]
}
```

- **入口只在 `targetUrl` 里写一次**，`pages` 里不许重复它（写了就丢弃并报告）。流程顺序 = 入口 + 声明序。少了这条，入口就有两份表示，必然漂移。
- `name` 是命令与输出用的短名（`prototype-open --page address`），必须唯一且非空；空/重复的条目丢弃并报告，而不是替调用方猜一个。
- 每个地址都要过得了 `matchPatternForUrl`（http/https）；过不了的那一页在**导出与状态报告里点名**，绝不静默少注入一页。
- 它同时是三个既有出口的数据源，而不是新机制：`prototype-status` 的 `pages:`、`prototype-open --page <name>`、`snapshot`／`windows` 的 `page "<name>"`（`matchPrototypePage` 本来就是通用比较，此前只认得一页纯粹是因为页表只有入口）。
- 命令：`prototype-pages`（无参数列出；`--add name=url`、`--remove name`、`--rename old=new`）；改入口仍是 `prototype-target <url>`。

**⑥ 载体投影**

- **overlay**：页表摊平成 match pattern 集合交给扩展——每个真实页都在注入范围内，而"哪一页"由 Chrome 按 `matches` 强制。今天合成**一段** content script：补丁全量重放、无匹配即无害，所以"每页一段"与"合成一段"行为相同；等补丁按页归属落地时再拆开。
- **scratch**：不做页表（见"未做"），页集合继续由派生规则给出（顶层 `*.html`）。交付物按**同一个派生集合**打包：每个有效页一份（文件名不变，所以页间相对链接零改写）、入口沿用 `base.html` 位置上的那份**构建产物**、`options_ui.page` 指向它、工具栏图标也开它，README 的 `Pages` 按同一份列表列出。每页自己的产物（提出来的内联脚本、事件处理运行时）落在 `assets/<页名>/` 下——否则两个页的 `inline-1.js` 会互相覆盖；补丁与 mock 是**共享产物**，在包根放一份（同一批补丁要在每一页重放，mock 是原型的属性而不是某一页的属性）。

**落点**（改了哪些文件、每处改什么）见 [开发文档](prototype-workbench-dev.md) §1／§2；验收见 §10 的 Q 组（86–93）。

**页与补丁的归属（下一步）**：不引入共享清单（那会推翻 append-only / 无共享文件这条根基），注入仍然**全量重放**——补丁本来就必须防御式书写，不匹配即静默无害。所以归属不是为了注入正确性，而是为了**dev-spec 能说清"这一页改了什么"**：写在补丁自己身上（文件头注释，或名字里的可选段），由控制面读出来生成文档。

**未做**：

- **scratch 的页表：决定不做。** 它现在的性质是"写个文件就生效，没有清单要维护"，而页表的两个收益（排除杂物、自定义顺序）目前没有消费者——面板还没有页列表，README 按名字排序也读得懂。等真出现"这张 html 不该算页"的需求再加；那时它也只是 `config.pages` 的第二个使用者，不是新机制。
- **补丁的页归属 / 按页切分**：需要补丁元数据（文件头 `@pages` 或名字里的可选段），见上一条。收益不是注入正确性（全量重放已经安全），而是 dev-spec／README 能逐页说清改了什么。
- **面板的页列表**：详情页还没有"页面"这一块（点一页预览那一页）。

---

## 19. 页层模型：页有类型，原型是一张页表

> 已实现。落点（改了哪些文件、每处改什么）见 [开发文档](prototype-workbench-dev.md) §1／§2；验收见 §19.10 的 94–100。两处与本节的偏差记在最后：一级行的点击、以及索引页只带共享补丁。

**问题**：§13 把类型放在**原型**上，§18 把"页"提升为原型的一部分——两条各自成立，合起来错在同一处：**类型描述的是"一份文档"的性质，不是"一个容器"的性质**。三个证据都是"用户想做的事在模型里没有地方放"：

| 想做的 | 今天的模型 |
|---|---|
| 一条流程里三张自己写的屏 + 一张真实站点的支付页 | kind 只能选一个：要么整条流程都是 overlay（那三张屏无处落），要么整条都是 scratch（那张真实页无处落）。§14 只给了**参考**（读它），没给"同一流程里的异质页" |
| 换掉首页入口 | 入口 = `base.html` 这个**文件名**（§18 ①）。换入口就要改文件名，而文件名同时是导出路径与页间链接的锚 |
| 说清"这一页改了什么" | 补丁没有页域，全量重放（§18 未做）。dev-spec 只能一整段列补丁 |

**结论**：`kind` 从原型**下沉到页**；原型是**一张有顺序的页表**，表里每一页各自是 scratch（我们自己的文档）或 overlay（某个真实地址）。

### 19.1 数据形状

`config.json`（仍是控制面独占、单一写者）：

```jsonc
{
  "pages": [
    { "name": "cart",   "kind": "scratch", "entry": true },   // file 不写：名字就是文件名 → cart.html
    { "name": "orders", "kind": "scratch" },
    { "name": "pay",    "kind": "overlay", "url": "https://app.example.com/pay" }
  ],
  "references": [ … ]                                          // §14 不变
}
```

三条不变式：

- **scratch 页不写 `file`**：名字即文件名（`cart` → `cart.html`）。写下来就是第二份表示，必然漂移。overlay 页**必须**写 `url`——那是它的全部。
- **表序即流程顺序**：§18 ⑤ 那条规矩（"流程顺序是它被写下来的顺序，不是字母序"）从 overlay 的页表扩到整张表。
- **入口是行上的一个标记**（`"entry": true`），不是文件名、也不是一个指向别处的名字：它只能是某一行，所以"入口指向一个不存在的页"这种坏状态不存在。多行都标了 → 取表序第一个并报告。

### 19.2 文件与表：文件是存在性的事实，表是顺序与入口的事实

```
prototypes/<slug>/
  config.json                 页表 + references；控制面独占
  _layout.html                可选：scratch 页的共享外壳（单一插槽）；下划线开头 = 不是页
  cart.html  orders.html …    scratch 页：顶层文件，文件名即页名 → 导出与页间链接零改写
  patches/cart/*.css|js       只在这一页上重放的补丁
  patches/*.css|js            每一页都重放的补丁   ← 根 = 共享，与旧数据语义完全一致
  services/…  dist/…          原型级（契约、mock、交付物）
```

- **不在表里的顶层 `*.html` 自动成为一页**（scratch，名字 = 词干），排在声明页之后、按名字排序。§18 那条"写个文件就生效，没有清单要维护"是这套模型最值钱的性子，不能为了顺序与入口把它丢掉：**表管顺序与入口，文件管存在**。
- **表里声明、文件却不在**的 scratch 页 → 进 `pageIssues` 并**照旧列出**（`file: null`）。一个页文件被删掉是值得知道的事，不是应当消失的事。（这只可能来自手改配置——见 19.8 的 `--add` 规矩。）
- **不是页的两种文件**（§18 的规则不变，换了理由）：下划线开头的是**壳与宿主保留地址**，子目录里的文档是**资源**。
- **壳只有一个插槽**：`_layout.html` 里写 `<slot name="page"></slot>`——**HTML 自己的写法，不是我们造的语法**（agent 不必学新东西，将来壳真要做成 Web Component 也不用改写）；请求时宿主把页文档替换进去，纯文本替换、只认第一次出现。旧拼写 `<!-- @page -->` 仍然读：否则旧壳会被当成"没有插槽"，而那条兜底是"整篇当壳"，页就被静默丢掉了。注意壳里任何地方都不能再出现插槽字面（注释也不行），否则第一次匹配会落在注释里。**不引模板引擎**——作者面必须仍然是最终产物（一份完整 HTML 文档），否则 agent 要学一套我们自己的语法，而导出还得反过来把它还原。组件复用停在"页共享一个外壳 + 页自己的资源引用"。

### 19.3 `/`：默认页索引，入口可配置

| 页表 | `/` 是什么 |
|---|---|
| 没有任何行标 `entry`（默认） | **页索引**：宿主生成的列表页——每页一行（名字 / 类型 / 地址或文件） |
| 某一行标了 `entry` | 302 到那一页：scratch → 渲染结果（文档 + 全部生效补丁），overlay → 它的真实地址 |

- **索引永远可达**，地址固定 `/_index`（下划线开头 = 不是页，与壳同一条规矩）。所以"配了入口"只是换掉 `/` 的默认落点，索引谁也没有被顶掉。目录里真有一个 `_index` 文件时**文件优先**（§16.3 的规矩一贯）。
- **默认给索引而不是给入口**，是因为**一张表里没有哪一页天然是第一页**——§18 靠 `base.html` 这个文件名假装有。宿主生成索引就是"还没有做出的那个决定"，而把某一页设成入口随时可以做（`prototype-entry`）。
- **入口页的文件不在时不静默退回索引**：报错并点出是哪一个页名。§16.3 那句"没有任何东西可以顶替它"在这里同样成立——退回索引会把"你的入口页不见了"变成"你的入口配置没生效"。
- 已经配了入口、又要拿索引（面板、扩展 options、只想知道有哪些页的调用方）→ 走 `/_index`。
- **索引页不带补丁**（实现时的收窄）：它是宿主生成的文档，不是作者的页，所以只带共享补丁的范围概念对它不成立——零补丁。旧行为会给它全部补丁，那是"全量重放"时代的残留。

### 19.4 补丁的页域：目录即归属

- `patches/<页名>/*` 只在该页重放；`patches/*`（根）在**每一页**重放。**根 = 共享**，所以旧数据**零迁移**：今天所有补丁都在根，语义一模一样。
- 归属只影响 dev-spec 与状态报告的**分组**，不影响注入正确性（补丁本来就必须防御式书写，不匹配即静默无害，§18）。所以它是一条**组织约定**而不是新机制：没有清单、没有索引、没有争用——`patches/cart/` 与 `patches/orders/` 是不同目录，§3.5 的 lane 所有权照旧一行生效。
- **`patches/<页名>/` 里的页名必须对得上一个页**；对不上（`patches/nope/`）就报出来：补丁落在没人看的页上，是这个模型最贵的那种静默失败。判据只有一条——目录名与页名同名。

### 19.5 交付物与扩展（对 §17 的修订）

| | 页是 scratch | 页是 overlay |
|---|---|---|
| 扩展做什么 | **自带那一页** | 把补丁注入那一页的**真实地址** |
| content script | 没有 | 有，`matches` 覆盖该页 url（`world: "MAIN"` 的 mock 照旧） |

- **仍然一个原型一个扩展**（§17 的结论不变），变的是包内**按页分文件**：每页一份产物，每页自己的提取产物落 `assets/<页名>/`；补丁与 mock 是**共享产物**，包根一份。
- **options 页 = 页索引**：装扩展的人打开选项页，看到的是"这个原型有哪些页"，点一页就过去——overlay 页跳它自己的地址，scratch 页开包内文件。**工具栏图标打开首页入口**（有 `entry` 就开那一页，否则开 options 页）。这替换掉 §17 那句"options 页就是原型页"：表里可能有多页、也可能混着别人的页面，一个"页面"已经不足以代表它。
- 包内文件名**不变**（`cart.html` 还是 `cart.html`），页间链接零改写；`dist/extension/base.html` 这个名字只有在"入口恰好是 `base`"时成立——旧数据提升后正是如此（19.7）。

### 19.6 对话绑"原型 + 当前页"

- §11 的绑定多一维：`prototypeSlug` 之外记 `prototypePage`（可空）。**写入路径一行不改**——它仍是**原型域**的事实，页只是它的一个属性；取值用同一个 `matchPrototypePage` 从窗口真实 URL 反推（§18 ④）。
- **命令的默认落点**：`prototype-open` 不带 `--page` 时打开**当前页**，没有当前页就落到入口、再落到索引。多页之后"打开这个原型"不再有唯一指代，而"接着我刚才在看的那一页"才是人和 agent 都想要的那一个。
- `prototype-status` 把当前页标出来（`current`），agent 因此不必自己比对地址。

### 19.7 旧数据：读时提升，不写迁移脚本

读取侧把旧形状**提升**成页表（`readPrototypeConfig` 一层），落盘保持旧形状，直到下一次控制面写入：

| 旧形状 | 提升为 |
|---|---|
| `kind: "scratch"` + `base.html` | 页 `base`（file `base.html`，`entry: true`） |
| `kind: "overlay"` + `targetUrl` | 页 `entry`（kind overlay，url = targetUrl，`entry: true`） |
| `kind: "overlay"` + `pages: [...]` | 上面的入口页 + 其余页按声明序（kind overlay） |
| 读不到 `kind`（坏配置） | 同 scratch 那一支——坏配置落在"自己有文档"的路上（§13.3 不变） |

- 提升发生在**读**这一侧，于是：旧原型不需要任何动作就能用；新写的数据里没有"旧字段"这回事；旧版工作台打开新数据会看到 kind 缺失 → 兜底 scratch（可接受：工作台内不承诺双向兼容）。
- `base` / `entry` 这两个名字是**提升的产物**，不是新规矩——它们只是普通页名。改名一页要三处一起动（scratch 的**文件**、它的**补丁目录**、以及指向它的 **`entry` 标记**），由控制面一次做完，不留下悬空引用。

### 19.8 命令面

| 命令 | 变化 |
|---|---|
| `prototype-status` | `pages:` 每行带 `name / kind / url\|file / entry? / current?`；`pageIssues` 点名不干净的条目 |
| `prototype-pages` | `--add name=url` 仍是 overlay 页；**不带 url 只在该页文件已存在时接受**（声明是为了顺序，不是为了造页——scratch 页要有文档才算存在，写文档是 agent 的文件工具，§13.2 的"不预置空白"不变）；`--remove` 删的是**表里的一行** |
| `prototype-entry` | 新增：`prototype-entry <name>` 把某一页设为首页入口；`prototype-entry none` 回到索引 |
| `prototype-open` | `--page <name>` 不变；不传 = 当前页 → 入口 → 索引 |
| `prototype-export` | 按表按页产出；dev-spec **按页分节**（每页：类型、地址或文件、在它上面生效的补丁） |

**创建原型不再问类型，也不再要求地址**：它只问名字，建出来的原型没有页——"还没有页"是一句真话（§13.2）。类型搬到**页**上之后，§13 那两张卡片的收益（引导文案说到点上）跟着搬到**新建页**对话框：overlay 要地址、scratch 要一张文档（最小文档 + 引入 `_layout.html`）。粒度改了，分野没改。

### 19.9 侧边栏两级下钻（对齐 Projects）

一级是原型、二级是页——因为粒度现在真的是项目的粒度：原型是一条流程、一个交付单位（config / patches / services / dist 都在它下面，身份与对话都绑它），页是文件与地址的粒度。

- **一级行**：原型名 + 状态点 + 展开箭头；右键或悬停 `…` = 新建页、复制、删除（§13.1.1 的两项不变，新增"新建页"）。**点击一级行打开的是详情页，不是首页入口**（实现时的偏离）：详情页是元数据与每页控件的落点，一次点击就开一个浏览器窗口是过重的副作用；"打开这个原型"由二级页的点击与详情页的「打开」承担。
- **二级行（叶子）**：页名 + 类型徽标（scratch / overlay）+ 状态点；点击 = **打开这一页**；右键 = 打开、设为首页入口、改名、删除（scratch 页连文件一起删，overlay 页只从表里移除；两者都要先问一句）。
- **展开状态是 UI 状态**（不落盘）：它是"我在看哪儿"，不是原型的事实。一级行上的「打开」在详情页里，二级行点击就是打开那一页。

### 19.10 验收（§10 的续，R 组）

94. 建一个混合原型（两张 scratch 页 + 一张 overlay 页）→ `prototype-status` 的 `pages:` 三行、kind 各自正确、表序 = 流程序
95. 不标 `entry` → 打开原型得到**页索引**，三页都在、点第三页进得去；`prototype-entry orders` 之后 `/` 直接到 `orders`，而 `/_index` 仍然给出索引
96. `patches/orders/*.css` 只在 `orders` 页生效，`patches/*.css` 三页都生效；导出后扩展包按页分文件、dev-spec 按页分节
97. 装扩展 → options 页是页索引；工具栏图标打开入口那一页
98. 旧原型（`kind: "overlay"` + `targetUrl` + `pages`）**一个字节不改** → 页表与旧行为逐页一致（入口 = targetUrl）；此后任何一次控制面写入把形状落成新的
99. 窗口停在第二页 → `snapshot` 的 `Prototype:` 行带 `page "<name>"`，会话绑定记下该页；`prototype-open`（不带 `--page`）打开的就是它
100. `patches/nope/` → 状态报告点名；页名对得上时不报

**未做**：

- **不引模板引擎 / 组件系统**：组件复用停在 `_layout.html` 单插槽 + 页自己的资源引用。多插槽、按页选壳、继承链都不做——那一步走出去，"作者面 = 最终产物"就不再成立。
- **页不嵌套**：页是 host 根下的**一层**，页内层级属于应用自己的路由（§16.3.1）。
- **跨原型的流程**：真的横跨两个原型的流程不合并；`references`（§14）是**读**，不是拼。
- **页级 mock / services**：mock 是原型的属性，不按页切——同一个路由不会在不同页上有不同响应。
- **详情页的页列表**：面板的二级下钻（19.9）是入口，详情页里的"页面"区块与它同源但仍是下一步。
- **裸底稿这个调试地址**：§18 的 `/base.html`（无补丁）随 `base.html` 的特例一起消失。要看"补丁之前的样子"就得在渲染之外再留一条路径——那正是这一层要删掉的东西；真需要时再加一个显式开关，不做隐式特例。

