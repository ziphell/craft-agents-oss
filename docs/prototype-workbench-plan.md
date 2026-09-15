# 产品经理需求生产工作台 — 实施方案

> 状态：阶段 1–6 全部完成；阶段 7 完成两项（无中生有入口、改写真实后端返回），放开面经决策**确定不开**，响应头就地改写未做。UI 闭环已完成：创建入口（侧边栏「原型」+ 面板「+」+ 空态按钮）→ 详情页 Open / Apply / Capture base / Export，以及产物文件就地编辑（base.html 与 patches/*）。**会话绑定已完成（§11）**：会话绑定原型后，agent 的 system prompt 里带 `<prototype_context>`，且 `prototype-*` 的 slug 变为可选。**预览面板编辑入口已完成（§12）**：面板工具栏新增「选中元素」（显式进入编辑态，页面点击被拦截）与「应用补丁」，选中后可选「保存为补丁」或「在对话中改」。**原型类型分离已完成（§13）**：「从无到有」与「patch 第三方」不再是同一件事的两种用法，而是创建时确定、不可改的两种类型（`overlay` / `scratch`），落在 `config.json` 并被详情页、system prompt、agent 命令共读。**混合场景已完成（§14）**：逆向第三方再搭自己的，拆成「起点」（scratch 可被 Capture 播种，且覆盖前先确认）与「参考面」（参考是独立原型 + 一条 `references` 关系 + 「翻译不要搬运」的硬规矩）。**这条关系与类型无关**——scratch 引用 scratch 和引用 overlay 同构。新增 `prototype-reference` 与 `prototype-create --no-bind`。**agent 的读取面已补齐（§14.6）**：`prototype-list` 给出每个原型的 kind / 目标页 / 双向关系，`prototype-status` 解析出每个参考是什么、以及谁在参考它（反向关系派生、不入库）。**命名已与「项目」分开（§15）**：原型与 workspace 的 projects 无关，且不该共用一个词——`getPrototypeProjectPath` → `getPrototypeDirPath`，给模型的工具描述里显式写明「a prototype is NOT a project」。**原型文档载体已换（§16）**：不再走 `file://`（opaque origin ⇒ 无 cookie、相对 fetch 发不出去所以 mock 拿不到请求、ES module 跑不了），改为回环 HTTP：**一个原型一个 host、目录即 origin 根**（`http://<slug>-<目录hash>.localhost:<port>/…`），根路径是该原型的**渲染结果**（`base.html` + 全部 patch，按请求现算，与"此刻导出会写出的字节"相同），根绝对路径资源与 SPA history 路由都能用。一处注入、三处入口零改动、真实页面浏览路径零风险。**创建不再预置 `base.html`（§13.1）**：缺席是一句真话，首稿的三条来路（agent 写 / 捕获在线页 / 从其他原型导入）全都在创建之后，死胡同由入口解决而不是由假文件解决。**新增「导入其他原型」（§13.1.1）**：把另一个原型的页面与补丁**成对**搬过来当起点，仅限 scratch 目标，同名补丁一律不覆盖、不删除，只报出来。**「打开」的含义收敛为一个（§16.3）**：只打开原型当前**渲染出来的样子**（`base.html` + 全部 patch），导出物不再顶替它——制品是旧状态的快照，也不是能继续编辑的页面；`base.html` 缺失时明确报错而不是拿别的东西冒充。**重复注入已修（§16.4.1）**：渲染结果自带"已内联哪些补丁"的清单，apply 跳过它们、只补新增的，所以打开预览后能继续打补丁而不会把 JS 跑两遍。下一步：端到端试用（见 §10，新增步骤 H/I/J/K/L）。
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
| **外部页** | 别人的（产品 dev server / 测试环境 / 线上，**都算这一类**） | 我们注入的 patch 覆盖层 | patch + 导出物 | **不能**。它是给开发的**可执行规格**，由人翻译进源码 |
| **自建页** | 我们的 `base.html` | 我们自己的 HTML | 完整页面 | 不适用，它本来就是源码 |

`Capture base` 是两者之间的桥：捕获之后 `base.html` 是真实页面的**渲染快照**，从那一刻起它属于我们。所以实际是三态——**纯覆盖 → 快照 → 纯自有**。

由此得出两条推论，它们替代了原先的 D6：

1. **「产品 dev server vs 线上 URL」不是设计维度。** 无论哪一个，patch 都是覆盖层，都不回流源码；dev server 的「DOM 可控、无登录态」只降低**排错**成本，不改变**产出**。
2. **在线场景更多，且不需要为登录做任何事。** 目标站点要登录时，**用户在窗口里自己登** —— 这里没有自动化登录，所以「已登录」只是页面的一种普通状态，和处理它无关。三条机制保证这一点成立：注入按 document 生效（`Page.addScriptToEvaluateOnNewDocument`），登录跳转后自动重新执行；`Capture` 读的是当前渲染的 DOM，天然包含登录后的内容；空闲 detach 后 `send()` 会 `ensureAttached()` 自动重连，且一旦应用过 patch（`holdsSessionState()`）就不再 detach。

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
| D5 | 权限模型 | 真实产品面锁死；原型面独立 partition 才允许 `webSecurity:false`；`nodeIntegration` 永远 `false` | 注入与跨域都不需要 node 能力 |
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

> **原 D6「起手形态：本地 dev server」已删除。** 它不是一条决策：patch 对任何源页面都是覆盖层，dev server 与线上 URL 在**产出**上没有区别，所以这个维度不改变任何设计。正确的分野见 §1「决定一切的分野是产物性质」。

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
  ├─ config.json            【§13/§14】原型类型（overlay / scratch）、目标页、参考列表；控制面独占，创建时定
  ├─ manifest.json          【阶段 3 起不再需要】索引由 scanPrototypePatches() 按需从磁盘派生
  ├─ base.html              overlay：抓取的快照（**创建时不预置**）／scratch：我们自己的页（**创建时预置空文档**，之后手写或捕获播种）
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
- 所以预览通道 = 浏览器面板打开导出的产物。这比自己搭一个 BrowserView 更好：零新增 UI、渲染环境与工作台一致（同架构同引擎），且**不改动现有预览块的安全策略**。
- `prototype-export` 因此直接返回可直接使用的 URL。
- 遗留说明：浏览器会话是共享 partition（带真实登录态）。**这一条后来被 §16 修正**：`file://` 不只是"读不到 cookie"，它连相对 `fetch` 都发不出去（所以 mock 层拿不到请求）、ES module 也跑不了；现在改由回环 HTTP 提供 origin。

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
- 初稿把"无中生有"列为阶段 7 的独立能力，其实它**不需要新机制**：agent 在阶段 1.2 起就能写 `prototypes/{slug}/base.html`（Explore 白名单已覆盖），而浏览器面板一直能打开它。
- 补的是入口体验：`resolvePrototypeEntry()` 决定"这个原型的页面在哪"——**答案只有一个：它的 origin**，那个地址由服务器把 `base.html` + `patches/` 渲染出来（见 §16.3）。三条被淘汰的旧规则都会骗人：优先导出产物（冻结在导出时刻的文档）、否则 `base.html`（一条 patch 都没应用）、无服务器时退 `file://`（同上）。没有 base 页时**明确报错并点名三条来路**，而不是让浏览器里报一个含糊的失败，也不拿交付物顶替（§16.3）。
- 命令 `prototype-open <slug>` 复用了既有的 `navigate`，没有新增导航能力。
- **入口的失败由 UI 提前挡住，而不是把错误弹给人**：`PrototypeStatus.baseHtmlPresent` 是"这个原型到底有没有页面"（**唯一来源就是 `base.html`**，导出物不算——它是旧状态的快照），详情页据此禁用 Open（以及 Export——它读 `base.html`）。这些 RPC 的错误文案是**写给 agent 的**（点名三条来路、附绝对路径），弹给用户既看不懂也没法照做；页面下方那条 kind-aware 的告警才是给人的引导。
- **但同时必须留一个能往前走的入口**：Apply 与 Capture 都需要"有一个浏览器窗口"，而详情页原来只有「打开目标页面」能创建窗口——**而它要求已记录 `targetUrl`**。于是未记目标页的 overlay（或任何还没有页面的原型）在这页上无路可走。补了一个通用的「打开浏览器窗口」（不导航，用户自己走/登录），与「打开目标页面」二选一显示，避免出现两个都只是"开个窗口"的按钮。
- **那个入口报过 `ERR_FAILED (-2) loading 'about:blank'`（已修）**：详情页每个打开动作都是「先 `create`，紧接着 `navigate`」（`openInBrowserPane`），而 `create` 立刻发起空态页加载。后发的导航把空态加载 abort 掉——这是**正常且预期**的；问题在空态加载的 `catch` 里**无条件**回退到 `about:blank`，于是又插进一条导航，失败被记在 `about:blank` 上、顺着 `navigate` 的 promise 弹回 UI。日志里 `did-navigate` 明明显示真实导航已经成功（`did-fail-load code=-2 url=about:blank` 与 `did-navigate to=http://<slug>-<hash>.localhost:…` 相差 50ms），只有回给用户的那条路是坏的——**报的错误是回退自己的，不是那次导航的**。
- 修法是给回退加一个前提：**空态回退不得抢占调用方的导航**——`ERR_ABORTED` 时直接放弃回退，只有空态因别的原因失败才加载 `about:blank`（`code` 与 message 两处都匹配：这个 rejection 在日志里只观测到 message 这一条线索，不依赖单一字段）。两个方向都有测试固定（abort 时不抢占 / 真失败时仍回退）。

#### 已完成：overlay 改写真实后端（无需新机制）
- 初稿认为 (b) 需要扩展 `ses.webRequest.onBeforeRequest` + 新增 `onHeadersReceived`。
- 实测发现：阶段 5 的 mock **匹配只按 pathname、与 host 无关**，所以一条 `/api/orders` 的路由会同样拦截 `https://api.production.example.com/api/orders`。**(b) 就是 (a) 的同一个机制**，只是路由来源不同。
- 已加测试固定这个行为（对生产域名发起的请求被本机路由兑现）。
- 因此**不需要**为响应体重写去改 `webRequest`。真正仍需新机制的是"**只改响应头/状态码但保留真实 body**"（需要在 `Response` 阶段拦截），这一条没做。

#### 已决策：放开面 partition（`webSecurity:false`）—— 决定**不开**
- 原计划：新增 `PROTOTYPE_PARTITION = 'persist:prototype-lab'`，仅该 partition 允许 `webSecurity:false`；`persist:browser-pane` 保持锁死；原型面禁 `file://` 导航。
- **推进到这一步时发现两件事**，因此改变结论：
  1. `webSecurity:false` 买到的是"**页面脚本自己**跨域"的能力（免 CORS 发请求、读跨域资源）——而**从外部用 CDP 同样能达到**（`Fetch` 兑现响应、`Runtime.evaluate` 在指定 frame 上执行）。四个诉求里三个已交付，剩下一个用 CDP 也能做。
  2. 代价是**真实的、不可回退的安全弱化**——同源策略一关，该 renderer 里任何页面脚本都能读任意跨域响应；若 `file://` 导航没堵住还能读本地文件。收益只是"省掉一层 CDP 封装"。
- **结论（用户已确认）：不开。** 全部能力改走 CDP。因此 `persist:browser-pane` 的姿态从头到尾没有变：`sandbox:true` / `contextIsolation:true` / `nodeIntegration:false` / `webSecurity` 默认开。
- 若将来真撞到"CDP 做不了、必须页面 JS 自己跨域"的具体场景，再回到本节的隔离设计（独立 partition + 无凭据 + 禁 `file://` + 风险提示）。

#### 已知未做
- 响应头/状态码的**就地改写**（保留真实 body）——需要在 `Fetch` 的 `Response` 阶段拦截。
- 原型面 partition 参数化与导航白名单（`webSecurity` 已决定不开，这一项只在回退到"开"时才需要）。

**阶段 7 完成标志（已达成部分）**：无中生有有了一等入口；改写真实后端返回可用且有测试固定；安全姿态未改动。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Explore 模式拦截写 | agent 写不进 `prototypes/` | 阶段 1.2 新增 `prototypesFolderPath` 例外（**必做，否则阶段 3 / 5 / 6 阻塞**） |
| 现有 HTML 预览禁 JS | 原型跑不起来 | **已解决**：预览走浏览器面板（阶段 4.2）；载体后来从 `file://` 改为回环 HTTP（§16） |
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
| **patch 不回流源码** | 用户可能误以为改完就能应用回源码 | 这是**设计事实**而非缺陷：patch 是给开发的可执行规格，由人翻译。导出物（`dist/`）承担"说清楚要改什么"的职责 |
| **既有失败清单（改代码前请先基线）** | 容易被误判为本次引入 | 全量扫 `apps/electron/src/main` + `packages/shared/src/agent/__tests__` + `prototypes` 共 1013 个测试，13 个既有失败：`BrowserPaneManager` 8 个（已 stash 验证）、`mode-manager-path-boundary` 2 个（该文件缺 `setPowerShellValidatorRoot()`）、`spawn-session-tilde-expansion` 1 个（Windows 上期望 POSIX 路径）、`buildCallLlmRequest` 1 个（测试留下 `__tmp_build_call_llm__` 临时目录）、`ensureDefaultPermissions` 1 个。**改动前先跑一遍基线，别把这些算到新改动头上** |

---

## 8. 验收标准（MVP）

### UI 与文件通路

1. 在**任意真实页面**上（产品 dev server / 测试环境 / 线上均可，见 §1）能点选任意元素，拿到稳定 selector，重复点选结果一致。
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

> **关于页面地址**：示例用 `http://localhost:3000/...` 只是占位。换成任何真实产品地址——dev server、测试环境、线上——步骤完全一样（依据见 §1：patch 对任何源页面都是覆盖层，dev server 没有特殊性）。

> ⚠️ **端口**：`bun run electron:dev` 会占用 **5173**（renderer 的 vite）。若你确实用本地 dev server，它要跑在**别的端口**（示例用 3000）；`electron-dev.ts` 启动时会**无条件 kill 掉占用 5173 的进程**。

> **关于 slug**：A–E 保留了显式 slug 的写法（便于照抄，也验证显式路径）。若会话已绑定该原型（§11 / 步骤 F），这些命令的 slug 都可以省略。

### A. 在真实页面上改（核心闭环）

> **前置**：先建一个 **overlay** 原型：创建对话框选「在已有页面上改」并填目标页，或 `browser_tool prototype-create Checkout flow --url <你的产品页面 URL>`。目标页只影响**引导**（详情页的「打开目标页面」、Capture 时该往哪走），不改变 patch 的行为——patch 对任何源页面都是覆盖层。

1. `browser_tool navigate <你的产品页面 URL>`（示例 `http://localhost:3000/checkout`；线上地址同样成立）
2. `browser_tool pick` → 光标高亮跟随，点一个元素 → 拿到稳定 selector
3. 让 agent 写一个 patch：`prototypes/checkout-flow/patches/A-001-btn.css`
4. `browser_tool prototype-apply checkout-flow` → 页面**立刻**变化
5. **手动 reload 页面** → 改动**仍在**（这是"持久注入"的验收点；也是阶段 3 修掉那个 detach 坑要保证的行为）

> 第 5 步是整条链路里最值得盯的一步：它依赖"CDP 注册不随空闲 detach 失效"这个改动。

> 产物落在 `~/.craft-agent/workspaces/<当前 workspace>/prototypes/`。当前会话属于哪个 workspace，`prototype-status` 里的 `dir` 会直接告诉你。

### B. 从零做一个原型（scratch 类型）

6. 创建时选 **scratch**（两个入口都行）：UI 在创建对话框里点「从零开始」；对话里 `browser_tool prototype-create Quotes flow --scratch`
7. 让 agent 直接写 `prototypes/quotes-flow/base.html`（scratch 的 `base.html` 就是我们自己的文档，不需要任何特殊命令，也不需要 Capture）
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

13. `browser_tool prototype-export checkout-flow` → `dist/prototype.html` 自包含，命令会打印一个 **`http://checkout-flow-<hash>.localhost:<port>/dist/prototype.html`** 地址（不再是 `file://`，见 §16）
14. `browser_tool prototype-open checkout-flow` → 打开的是它的 **origin 根**：`base.html` + 全部 patch 现算出来的页面（与"此刻导出会写出的字节"相同），而不是某个文件
15. `browser_tool prototype-status checkout-flow` → 全貌 + 所有权检查

### E. 故意制造一个所有权违例

16. 写一个 `prototypes/checkout-flow/patches/oops.css`（不符合 `{lane}-{nnn}-{name}.css`）
17. `browser_tool prototype-status checkout-flow` → 应该点名它"misnamed patch"

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

### G. 在预览面板上直接改（§12 的验收）

前提：该面板窗口的会话已绑定原型（否则工具栏会提示「未绑定原型」）。

22. 点面板工具栏的**准星图标** → 按钮高亮 + 出现「点击页面上的元素」提示 → 点击页面任意元素
23. **关键验证**：此刻点击**不应触发**页面自身的按钮/链接行为（编辑态已拦截 capture 阶段）
24. 主窗口弹出编辑卡片，显示 selector 与当前文字 → 改文字 → **保存为补丁** → 面板里立刻生效，且落盘为 `patches/A-nnn-text-edit.js`
25. **刷新面板页面** → 改动仍在（它现在是 patch，不再是 DOM 临时状态）
26. 再选一个元素 → 点**在对话中改** → 跳回会话且输入框已预填该 selector
27. 点工具栏**闪电图标** → 把当前原型的所有补丁重放进这个面板（与详情页 Apply 同一条 RPC）
28. 按 Esc 或再点准星图标 → 退出编辑态，页面恢复正常点击行为

### H. 两种原型类型（§13 的验收）

29. 在创建对话框里看两个类型卡片：选「在已有页面上改」→ 出现**目标页输入框**；选「从零开始」→ 输入框消失（切回再切一次，确认不会残留上一个类型的输入）
30. 建一个 overlay 并填目标页 → 详情页标题下是 overlay 的引导语，元数据里有「目标页面」行，且有**「打开目标页面」按钮** → 点它应打开浏览器窗口并**直接落在该地址**
31. 建一个 scratch → 详情页**没有**「目标页面」行、**没有**「打开目标页面」按钮，引导语说的是「这是你自己的文档」
32. 两种类型在 `base.html` 缺席时的提示**不一样**（scratch 说三条来路：自己写 / 捕获 / 导入；overlay 说去 Capture）
33. 目录里 `prototypes/<slug>/config.json` 是 `{ "kind": "overlay", "targetUrl": "…" }` / `{ "kind": "scratch" }` 两种形态——scratch **不存** targetUrl
34. `browser_tool prototype-status <slug>` 与 agent 的 system prompt 里都能看到类型；对话里 `prototype-create Landing page --scratch` 同一条链路建出 scratch 并自动绑定

> 第 33 步验证的是「数据层分离」这个选择本身：类型不是 UI 状态、不是标签，而是**落盘的一个字段**，所以详情页、prompt、agent 命令、导出三条路读的是同一个真源。

### I. 混合场景：逆向第三方再搭自己的（§14 的验收）

**B 参考面**

35. 建一个 scratch 原型 → 详情页「参考资料」区点**「添加参考」**。表单里上半部分是**已有原型**（点一下就关联，不新建）；下半部分填名称 + URL 会**新建**一个 overlay 原型再关联（表单下方有字说明这个副作用）
36. **关联已有原型**：先另建一个 scratch，然后回到第一个原型，点候选里的它 → 应立即关联。**这就验证了「关系与类型无关」**：引用者是 scratch，被引用者也是 scratch
37. 参考行点**「打开」**：overlay 参考落在它记录的真实地址；scratch 参考打开它自己的页面（导出物或 base.html），且第二行显示「它自己的页面」而不是「未记录目标页面」
38. 点参考行的 slug → 跳到那个参考原型自己的详情页。在那里 Capture / 打 patch —— 这些 patch 属于**它自己**
39. 回到交付原型 → `browser_tool prototype-apply` → 注入的是**交付原型**的 patch，参考的 patch 一条都不在里面（第 42 步会再确认一次）

**A 起点**

40. 在交付原型（scratch）上：先把竞品页 Capture 进来当底稿 → 手改几处 → **再按一次 Capture base** → 应当**先弹确认**（"这会覆盖你自己的页面"），而不是直接覆盖
41. 取消 → `base.html` 未被改动；确认 → 被替换。overlay 原型上按 Capture 则**不该**弹这个确认（重新捕获是它的正规操作）

**护栏**

42. 导出交付原型（`prototype-export`）→ 检查 `dist/prototype.html`：里面**不应**出现任何参考原型的 patch 内容。这是第 38 步那批 patch 最危险的去处
43. 目录里 `prototypes/<交付原型>/config.json` 应有 `"references": ["rival-checkout"]`，而 `prototypes/rival-checkout/config.json` **不应**有 `references`（关系是单向的）
44. 对话里（会话已绑定交付原型）说「把另一个也加进来参考」→ agent 应执行 `prototype-reference <slug>`；若它需要先建一个，应当带 `--no-bind`，**且绑定不能被换掉**（`prototype-list` 里 BOUND 仍是交付原型）
45. 参考行点解除（↔ 图标）→ 该行消失，`config.json` 里的 `references` 一并消失

**agent 的读取面**

46. 对话里说「列一下原型」→ `prototype-list` 的每一行都带 `(overlay)` / `(scratch)`，有目标页的带 `target:`，有关系的带 `references:` / `referenced by:`
47. 对自己**不是**绑定对象的那个原型说「看一下它的状态」→ agent 应执行 `prototype-status <slug>`，输出里能看出它是什么类型、它在参考谁（**括注了对方是什么**）、以及谁在参考它

> 第 46 步修的是一个「状态撒谎」：在此之前 `prototype-list` 只列 slug 和 patch 数，overlay 和 scratch 在列表里长得一模一样。

> 第 44 步是本节最容易出事的一步：`prototype-create` 默认会绑定会话，如果 agent 建参考时没带 `--no-bind`，之后每条省 slug 的命令都会打到竞品页面上，而**画面上看不出来**。

### J. 交付物的 origin（§16 的验收）

48. 打开 `http://<slug>-<hash>.localhost:<port>/`（**不带路径**）→ 应看到 base 页**加上全部 patch**；对照 `/base.html`（裸底稿，无 patch）与 `/dist/prototype.html`（冻结的交付物）。**在没导出过的情况下也要能看到 patch 生效**——这是这一节的核心
49. 让 agent 建一个 scratch 原型，`base.html` 里放 `<script type="module">` + `fetch('/api/anything')`，写一条对应 path 的契约 fragment 与 fixture，然后 `prototype-mock-apply` → **相对 fetch 应被 mock 答上**。这是 §16 的收益点：`file://` 时代这个请求根本发不出去，mock 再对也没用
50. 在页面里 `document.cookie = 'a=1'` 再读回 → 有值；`localStorage` 同理。两者在 `file://` 下都是空/不可用
51. 重启应用后重开同一原型 → cookie 与 localStorage **会丢**（端口每次变 ⇒ origin 变）。这是已知限制，不是 bug
52. **SPA**：让 `base.html` 里放一个 `history.pushState(null,'','/orders/42')` 的按钮 + `<link href="/assets/app.css">`，并在原型目录里放 `assets/app.css` → 点按钮后**刷新**，页面应仍然起来（回退到原型页面），且样式表命中（根绝对路径）

### K. 首稿的三条来路（§13.1 / §13.1.1 的验收）

53. 新建一个 scratch → `prototypes/<slug>/` 里**没有** `base.html`（只有 `config.json` 与空的 `patches/`），详情页的 Open / Export 是灰的，但「打开浏览器窗口」可用 → 这是**入口**解法，不是死胡同
54. 在上一步的窗口里导航到任意在线页面 → 回详情页点「捕获为底稿」→ **不弹覆盖确认**（本来就没有东西可覆盖），`base.html` 出现，Open 随之可用
55. 另一个 scratch 上点**「导入其他原型」** → 弹出的候选只列**有 `base.html`** 的原型（导出物不算来源）→ 点一个：`base.html` 与其补丁一起出现，页面立刻能打开并已带效果
56. 对**已经写过内容**的 scratch 再导入一次 → 先弹确认；确认后 `base.html` 被替换，而**同名补丁保持原样**，结果提示里点出被保留的文件名（不静默吞掉）
57. 在 overlay 的详情页上确认**没有**「导入其他原型」（它对应的是「捕获为底稿」）；若绕过 UI 直接调用，报错应说明原因而不是照做
58. 导入后再看 `config.json` → 目标的 kind / targetUrl / references **都没变**：过来的是材料，不是身份

### L. 打开 = 打开当前渲染的样子（§16.3 / §16.4.1 的验收）

59. 打开一个有补丁的原型 → 地址是 `http://<slug>-<hash>.localhost:<port>/`，**不是** `/dist/prototype.html`；页面已经带全部补丁效果。**在 `dist/prototype.html` 存在的情况下也必须如此**（这条就是本节的判据）
60. 在那个页面上继续改：选中元素 →「保存为补丁」→ 新效果**原地出现**，页面不重载、不闪。用一个会 `appendChild` 的 JS 补丁试：重复点「应用补丁」应当**只出现一次**（跑两遍就是这里要防的那个静默错误）
61. 只改某个已有补丁的**内容**（不改文件名）→ 点「应用补丁」→ 提示"页面已经带着全部 N 个补丁" → **刷新**后看到新内容
62. 把某原型的 `base.html` 删掉 → 详情页「打开」变灰、告警给出三条来路；直接导航到它的 origin 得到 404；`/dist/prototype.html` 仍可按名字访问（交付物没被藏起来，只是不再是入口）

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

### 12.4 选中之后：两个出口

选中元素 → 主窗口弹出编辑卡片（`ElementEditorDialog`），提供两条路：

| 出口 | 行为 | 适用 |
|---|---|---|
| **保存为补丁** | 写 `patches/A-nnn-text-edit.js`（`textContent` 替换）+ 立即重放 | 文字/文案类确定性修改。**全程不经过模型** |
| **在对话中改** | 把 `selector` + 当前文字预填进该会话的输入框并跳过去 | 需要推理的改动（行为、结构） |

只做**文字替换**是刻意的：更丰富的可视化编辑会产出没人审过的补丁，那比不做更糟。

补丁序号取现有最大值 +1，且固定用 lane A —— 这是「不覆盖 agent 或其他 lane 写的补丁」的保证。

### 12.5 未做的（明确记录）

- **样式可视化编辑**（颜色/间距编辑器）—— 只做了文字。样式改动目前走「在对话中改」
- **面板内编辑条** —— 编辑 UI 在主窗口，不在面板里。面板工具栏是独立 BrowserView，`getToolbarEffectiveHeight()` 支持撑高做编辑条（菜单已用它），但那要改主进程布局 + 一套新 UI；先验证「选中 → 编辑」这条主线是否顺手
- 面板工具栏的按钮**没有 tooltip**（BrowserView 边界会裁掉浮层），只有 `aria-label`

---

## 13. 原型类型：overlay / scratch

**问题**：§1 已经把分野定在**产物性质**上，但产品结构里没有它。创建时只问名字，于是「从无到有」和「patch 第三方」是同一个东西的两种**用法**——引导文案说不到点上，`targetUrl` 无处可存（导致详情页既不能「打开目标页面」也不能重新 Capture，因为没人记得地址）。

**结论**：把分野提升为**原型类型**，在创建时确定、不可改。

### 13.1 为什么不是「一个标签」

类型决定四件事，全都是实质的：

| 决定 | overlay | scratch |
|---|---|---|
| `base.html` 从哪来 | Capture 一个真实页面的**渲染快照** | 我们自己写的文档 |
| 交付物是什么 | patch + 导出物，是给开发翻译的**可执行规格** | 完整页面，本来就是源码 |
| 有没有外部页 | 有（`targetUrl`，可重开、可重新捕获） | 没有（存 URL 是撒谎） |
| `base.html` 缺席意味着 | 还没 Capture —— 该去 Capture | 还没有首稿 —— 自己写，或捕获 / 导入一份 |

第四行是这条改动最实际的收益：**提示不再含糊**。以前两者都只能说"还没有 base 页面"，现在 overlay 说去 Capture、scratch 说三条来路。

**创建时不写 `base.html`，两种类型都一样**：缺席是一句**真话**（"这个原型还没有页"）。预置一份空白会断言一个不存在的状态——`baseHtmlPresent` 变成 true，于是"怎么拿到第一页"的引导被自己藏起来，导出还会照着空文档写一份空的交付物。

> 这里推翻过一次。最初的顾虑是"新原型一开局所有动作都是灰的，是个死胡同"，于是给 scratch 预置了一个空的合法文档。**顾虑是真的，解法错了**：灰按钮的成因是"没有页面就不能打开"，而这该由**入口**解决而不是由假文件解决——`pageAvailable` 挡住 Open，同时详情页的「打开浏览器窗口」**不需要任何页面**（§7），所以"去捕获一页"这条路永远走得通。空文档只是把死胡同伪装成了一条路。
>
> 顺带的收获：`kind === 'scratch' && baseHtmlPresent` 的覆盖确认（§14.1）从此只会在**真有自己文档**时触发。新建的 scratch 没有 `base.html`，"首次播种"不再经过一次语义上略保守的确认。

**首稿的三条来路**（都在创建之后，创建只负责建容器）：

| 来路 | 动作 | 产物归谁 |
|---|---|---|
| **agent 写** | 直接写 `base.html`（文件工具，或编辑器） | 我们 |
| **捕获** | 用户在浏览器窗口里打开任意地址，按「捕获为底稿」——存的是**渲染后**的 DOM | 我们（对 overlay 则是快照） |
| **导入** | 「导入其他原型」：把另一个原型的 `base.html` 连同它的补丁复制过来 | 我们（见下） |

### 13.1.1 导入：从另一个原型取一份首稿

**动机**：新流程常常和已有的某个原型同源（同一个产品的另一条流程）。对着空白页面重写一遍，是最没价值的那部分工作。

三条边界，每条都有理由：

- **目标是 scratch，来源任意。** 来源不看 kind——另一个 scratch 的文档、或某个 overlay 捕获下来的页面，机制上完全相同（都是"复制一份文档过来"），所以不按 kind 分叉（与 §14.2 的参考关系同一条原则）。但**目标必须是 scratch**：overlay 的 `base.html` 的定义就是"它自己那个目标页的渲染快照"，拿别的文档替换它会让 `targetUrl` 这句话变成假的。overlay 想做同一件事，对应的动作是**捕获**，就在「导入」左边。
- **页面与补丁作为一对搬过来，且只作为一对。** 补丁的选择器绑在它被写时的那份文档上；只搬页面会得到一堆打不中的补丁。这正是它与**参考**的分野：参考**必须**把补丁留在原地（§14.2），导入**必须**成对搬运。
- **不覆盖、不删除任何东西。** 目标已有同名补丁时保留原样并**报出来**（`skippedPatches`），因为静默替换掉用户自己写的补丁是唯一没人会发现的损失。`dist/` 不搬——它是派生的，搬过来只是第二份会过期的事实。

**带过来的是材料，不是身份**：目标保留自己的 kind、自己的 `targetUrl`、自己的 `references`，只有文档与补丁两个文件集移动。

覆盖自己的 `base.html` 与捕获同罪，所以**复用同一套确认**：目标已有页面时先问一句。

### 13.2 为什么创建时定、之后不可改

切换类型不是改个字段：overlay 的 `base.html` 是别人页面的快照，scratch 的是我们的原稿——把前者改成后者，那些 patch 仍然指向一个不再被重放的页面，而画面上看不出来。**让一个能悄悄产生废物的开关存在，比不让它存在更糟。** 要换类型就新建一个，这是诚实的代价。

### 13.3 为什么落在数据层（而不是 UI 状态）

类型写在 `prototypes/{slug}/config.json`，因为它有**四个读者**：详情页（引导文案/元数据/按钮）、agent 的 system prompt（<prototype_context>）、agent 命令（`prototype-create --scratch` / `--url`）、以及未来导出器的分叉。放在 React 状态里这些读者就拿不到。

> 这与「没有 `manifest.json`、一切按需派生」不冲突：那条约束针对 `patches/`（多 lane 并发写，共享索引必然争用），而 `config.json` 是**控制面独占、单一写者、无派生数据**，正是控制面文件该有的样子。所有权矩阵里它已登记为 `control-plane`（§3.5），所以误改会被 `prototype-status` 点名。

读取**永不抛错**：缺文件、坏 JSON、未知 `kind` 一律回退 `overlay`。理由有二——配置不可读不该让原型不可用；该文件可被手工或外部工具编辑，畸形是**预期**而非异常。默认值选 `overlay` 是因为**类型存在之前建的原型全部是围绕"捕获真实页面"的**。

### 13.4 一处刻意的收窄

`writePrototypeConfig` 会**丢掉** scratch 的 `targetUrl`。不是校验，而是不愿意落一条无法兑现的声明：scratch 没有外部页面，存下那个地址只会让后来人以为某个地方会用到它。

### 13.5 未做的（明确记录）

- **类型不可改**（同上，有意）—— 无「转换类型」UI
- **overlay 的 `targetUrl` 不可补填** —— 创建时省略就永远没有（§13.2 的"不可改"同样适用于目标页）。它**不挡任何流程**：Capture 与 Apply 都是从浏览器窗口取页面，详情页上的「打开浏览器窗口」就是给这种情况的入口；但"一键重开目标页"就没有了。要补就得放开 target 的可变性，那是与 §13.2 相反的一个判断，需单独决定
- **多目标页** —— overlay 只记一个 `targetUrl`。它只影响「默认打开去哪 / 默认捕获哪」；同一个窗口导航到别的页面时 patch 照样重放（注入按 document 生效），但没有地方登记"这个原型覆盖哪几页"
- **引导文案的图示** —— 两个类型卡片目前是图标 + 一句描述，没有"页面上叠一层 vs 白纸"的示意图
- **导入没有 agent 命令** —— 发起导入要人在详情页点。agent 读得到结果（`base.html` 与 `patches/` 就是它的读取面），但它不能自己发起一次"以某原型为模板"。真要加就是一条 `prototype-import <source>`，与 `prototype-reference` 并列；现在不加是因为没有对话里需要它的场景被观察到，而每多一条命令都要在帮助文本、解析器、测试里各留一处
- **导入不做补丁合并** —— 目标已有同名补丁时**保留原样并报出来**，不尝试三方合并、也不是"源的覆盖目标的"。合并语义（谁赢、内容怎么插）不是能顺手决定的事，而没有合并至少不会丢东西
- **创建时不捕获** —— "建原型时直接给个 URL，建完自动捕获"没做：捕获要求页面已经渲染完，那是浏览器的事，不是文件系统的事。所以它留在窗口里（「打开浏览器窗口」→ 导航 → 「捕获为底稿」），这三步都不依赖 `base.html` 存在

---

## 14. 混合场景：逆向第三方，然后搭自己的

**诉求原文**：「逆向第三方网站，然后搭建出自己的原型。可以选中、patch 第三方，然后作为 scratch 的参考资料。」

这句话里其实是**两种场景**，必须分开——否则会重蹈 D6 的覆辙（把两件事塞进一个维度）。

| | 那个第三方页最后变成什么 | 读法 |
|---|---|---|
| **A 起点** | 被吸收：Capture 成我的 `base.html`，此后归我 | 「抄完就变成我的」 |
| **B 参考面** | 一直是旁证：躺在旁边，我另起一份自己的 | 「照着做，但不是它」 |

两者都做，且**都不需要第三种原型类型**。

### 14.1 读法 A 撞上了 §13.2，但解法不是放开类型

A 的路径天然跨类型：开始时在别人的页上打 patch（overlay），结束时拥有一份自己的文档（scratch）。而 §13.2 规定类型创建时定、不可改。

**正确的解法是让 scratch 可被一次 Capture 播种**，而不是允许改类型：

- 创建时就声明「这会是我自己的页」，然后允许它从某个 URL 拿初稿。`writePrototypeBase` 本来就只依赖"项目存在"，A 在机制上已经可用；缺的只是**措辞**——旧文案说「没有外部页面，没有可捕获的东西」，那会**禁止掉主流程**。
- 探索竞品的过程发生在**另一个**原型里（就是 B 的参考）。于是 A 与 B 收敛到同一套结构，规则不用松。

`scratch` 的记录随之精确为：**`base.html` 归我们**——手写的、捕获来的、或从别的原型导入的都算；关键在于从那刻起它没有"要同步的对端"。

**A 引入了一个静默丢失风险，必须守。** `handleCapture` → `writePrototypeBase` 是**无条件覆盖** `base.html`。对 overlay 这是正规操作（`base.html` 是快照，重新捕获就是刷新它的方式）；但对已有自己文档的 scratch，按一下就是**无声抹掉它**。所以：`kind === 'scratch' && baseHtmlPresent` 时 Capture 先弹确认，其余情况不拦。这也写进了 prompt（"Never re-capture over an existing base.html"）。

> **与 §13.1 的交汇（已消解）**：这条确认曾经会在"首次捕获播种"时也弹一次（因为 scratch 一创建就带一份空的种子文档，`baseHtmlPresent` 为真）。现在创建**不写** `base.html`（§13.1），所以新 scratch 的首次捕获不再经过确认——确认只在真有内容会被覆盖时出现，语义正好落在它该在的地方。同样一句确认也覆盖**导入**（导入覆盖的是同一个文件）。

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

换来的是参考获得了**独立生命周期**：竞品会改版，参考会烂，所以它需要能重新捕获；而一个交付原型可能参考三个竞品。

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

1. **kind 出现在每一层，而且不是脚注。** 之前 `prototype-list` 只列 slug 和 patch 数——一个 overlay 和一个 scratch 在列表里**长得一模一样**，而它们的行为毫无相似之处（捕获 vs 手写、快照 vs 我们自己的文档）。这属于「状态撒谎」，不是缺个字段。
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
- **`apps/electron/resources/docs/browser-tools.md` 的同步** —— 已改掉措辞，但这份随应用发布的文档**整体滞后**：没有 `prototype-create` / `prototype-bind` / `prototype-reference`，没有 kinds，且 `prototype-apply <slug>` 等标题仍把 slug 写成必填（现在绑定后可选）。属于独立的一次文档同步，未在本轮做

---

## 16. 原型文档的载体：从 `file://` 改为回环 HTTP

**问题**：原型文档（`base.html` / `dist/prototype.html`）一直以 `file://` 打开（§4.2）。`file://` 的 origin 是 **opaque**，代价不止一条：

| 代价 | 后果 |
|---|---|
| 没有 cookie 域 | 无法模拟登录态；`document.cookie` 写不进去 |
| **相对 `fetch`/XHR 发不出去** | Blink 在 file→file 上直接拦掉。**mock 层因此永远看不到请求** |
| ES module 被 CORS 拦 | `<script type="module">` 不执行 |

第二条是决定性的：§5 的整条「契约 → mock → 前端」闭环，在**交付物上完全不可用**——不是 mock 写错了，是请求压根没发出来（`browser-cdp.ts` 靠 `Fetch.enable` + pathname 匹配，它只能看见 renderer 真正发出的请求）。

**影响范围只有一笔**：我们自己的原型文档。overlay 主路径在真实页面上是**真 http**，patch 注入按 document 生效与 scheme 无关，截图/DOM/pick 都不受影响。

### 16.1 为什么不拦截 http

"Electron 可以拦截 http 请求、从磁盘取文件"——语义是对的，机制有个坑：**所有浏览器实例共用一个 session partition**（`browser-pane-manager.ts` 中 window + 3 个 BrowserView 全用同一个 `SESSION_PARTITION`，注释写明 "preserving shared session/cookie partition"）。所以 `protocol.handle('http', …)` 会接管**所有** http 请求，包括正在被 patch 的真实产品页；我们要自己实现完整的 pass-through（流式、重定向、cookie、鉴权、下载、CSP），任一处偏差坏掉的是核心流程。

**回环服务器不需要"拦截"，因为它就是那个 handler**：同样的 origin 语义，零 pass-through 代码。这个应用本来就在 127.0.0.1 上监听（WS RPC server），再加一个回环静态监听不是新类别。

### 16.2 实测（不是推断）

用一个一次性 Electron 探针验证了四条前提，全部成立：

```
http://probe.localhost:8420/  -> loaded
origin:  "http://probe.localhost:8420"            ← 真实 origin，不是 null
cookie:  "probe=1"                                 ← document.cookie 可读可写
fetch:   {"ok":true,"host":"probe.localhost:8420"} ← 相对路径 fetch 打到了服务器
storage: true        moduleRan: true               ← localStorage 与 <script type=module> 正常
```

`*.localhost` 在 Chromium 里解析到回环，所以不需要 DNS 或 hosts 条目。

### 16.3 地址形状：一个原型一个 host，目录即 origin 根

```
http://<slug>-<目录hash>.localhost:<port>/                 ← 原型页面（渲染后）
http://<slug>-<目录hash>.localhost:<port>/<原型内文件路径>   ← 原型里的任意文件
```

**根路径是该原型的"渲染结果"**：`base.html` **加上全部 patch**，按请求现算。它与"现在执行一次导出会写出的字节"完全相同，所以"我在看的东西"和"我会交付的东西"是同一份文档。这条替换掉了原先那种二选一——**裸 base 页**（一条 patch 都没有）与**上次导出的文件**（冻结在导出时刻）都不是这个原型。

单个文件仍然可以按名字取用，四种地址各有明确含义：

| 地址 | 是什么 |
|---|---|
| `/` | 原型页面：base + 全部 patch，现算 |
| `/base.html` | 裸底稿（调试用；无 patch） |
| `/dist/prototype.html` | 冻结的交付物（`prototype-export` 打印的就是它） |
| `/assets/app.css` 等 | 目录内的静态资源 |

**原型目录就是那个 host 的根**，而不是挂在某个路径前缀下。理由不是美观：页面的 `src="/assets/app.css"`、`fetch('/api/orders')`、路由器的 `/orders` 都指向 **origin 根**，而页面并不知道也不该知道自己被放在子目录里。带前缀（`/prototypes/<slug>/…`）会让"假设自己拥有 origin"的页面全部坏掉——那是绝大多数页面。

host 里两半各答一个问题：**目录 hash** 保证唯一（两个 workspace 可以都有 `checkout-flow`，把其中一个的页面喂给另一个是静默换文件），**slug** 让它在日志和对话里可读。

**没有任何东西可以顶替它**。`/dist/prototype.html` 仍然可以按名字取用（想看交付物就看），但它是**旧状态的快照**、也不是一个能继续编辑的页面，所以它永远不是"这个原型的页面"。因此 `base.html` 不在时：服务器 404（`Nothing to serve`），`resolvePrototypeEntry` 抛错并点名三条来路——而不是拿别的东西冒充。

**这同时修掉了一个说不清的入口**：早先的规则在有 base 时才给 origin、否则退到交付物，于是"打开"这个词在不同原型上指向**两种不同的东西**（一份活文档 / 一份冻结制品）。现在它只有一个意思：**打开 = 打开这个原型当前渲染出来的样子**，可以在上面继续改、继续打补丁。

### 16.3.1 SPA

| 场景 | 处理 |
|---|---|
| 打开 `/` | 返回渲染后的原型页面 |
| history 路由刷新（`/orders/42`） | 无对应文件时回退到**同一个渲染页面**——这是 SPA 的路径，服务端不认识 |
| **标了扩展名的路径**（`/missing.js`） | **不回退**，老老实实 404。用 HTML 回答缺失的脚本，会把"文件没了"变成"解析错误" |
| 根绝对路径资源（`/assets/app.css`） | 按目录内路径查找并**正常命中**——这条是"目录即根"的直接收益 |

这也让**捕获来的 SPA 快照**第一次真正可用：它的 `pushState` 路由刷新能拿到文档，它的客户端路由能起来；`file://` 时代这种 URL 连重载都做不到。

### 16.4 代码上的接法

**一处注入**：`prototypes/url.ts` 提供 `setPrototypeBaseUrlResolver`，主进程启动时装上（`prototype-server.ts` 的 `installPrototypeBaseUrlResolver`）。共享层两个出口：`prototypeOriginUrl()` 给"原型页面"，`prototypeDocumentUrl()` 给"某个具体文件"。`resolvePrototypeEntry()` 与 `exportPrototype()` 都走这里，所以 `prototype-open`、RPC `prototypes:entry`、详情页 Open 按钮三处入口**一行都不用改**；没装 resolver 时（单测、无渲染服务的宿主）入口**明确报错**——那时没有能显示补丁的地址，给 `file://base.html` 只会端出一个"看起来像原型、其实一条 patch 都没应用"的页面。

**渲染用的是导出器那一个函数**：`buildSelfContainedHtml(baseHtml, scanPrototypePatches(...))`。导出 = 把它写到 `dist/`，预览 = 把它当响应体返回。同一份变换，所以"看到的"和"导出的"不可能分叉。

### 16.4.1 已经内联的补丁不会被重复应用

"打开的就是打了补丁的预览效果"与"打开后还能继续应用编辑"是同一个问题的两面：页面到手时补丁**已经在文档里**了，此时再注入一遍会让 JS patch 跑第二遍——**页面看起来一模一样，改动却是错的**，没有任何东西会报出来。

**做法是让文档自己说明它带了什么**：`buildSelfContainedHtml` 在有补丁可内联时，额外写一个标记元素

```html
<script type="application/json" id="__craft_prototype_inlined__">["A-001-btn.css","B-002-total.js"]</script>
```

注入前先读它（`buildInlinedPatchProbeScript()`），**跳过列出来的那些，其余照常注册并立即执行**。读不到、读不成 JSON、不是字符串数组，一律当作"这份文档什么都没有"——这是唯一安全的方向：反过来（默认已应用）会让该做的活被静默跳过。

三条细节，每条都是踩过才写下的：

- **判断读的是文档本身，不是地址。** 早先认为"注入方必须知道自己要打开的是哪个地址"才能做这件事，于是把它记为未做。其实标记随文档走：另存出去的渲染页、上一次会话留下的副本，同样认得出。
- **已内联的补丁不注册 init script。** init script 是 window 级的，注册一次就会在**之后每个** document 上执行——包括重新加载出来的渲染页，那里已经内联过同一份。所以每次 apply 都是「清掉本原型的全部注册 → 只注册缺的那些」，注册集合与页面上缺的东西严格对齐；顺带保住了原来那条"删掉 patch 文件就真的不生效"。
- **新补丁照常注入。** 这正是"打开后继续编辑"的实现：在打开的预览页上选中元素改文字 → 存成新补丁 → 全量 apply 里旧的那些被跳过、新的那条原地生效，不重载、不闪。

### 16.5 安全边界（四条，各自有测试）

1. **只绑 `127.0.0.1`**，端口 0 由系统分配——不可从网络访问，也不会与别的进程抢端口。
2. **只有注册过的 host 可达**：注册发生在"某个原型被打开/导出"时，服务器自己从不遍历文件系统。未知 host 一律 404；`a.b.localhost` 这种多标签名也 404（只认单标签，否则等于放行了没人发放过的名字）。
3. **路径围栏**（`resolveServedPath`，独立导出单独测）：解码后拒绝 NUL 与反斜杠（Windows 上反斜杠是分隔符，放过一个就能绕过前缀检查），`resolve` 折叠 `..` 后必须落在目录内，前缀比较用 `${root}${sep}` 以免同名兄弟目录（`checkout-flow-secrets`）蒙混。
4. **`Cache-Control: no-store`**：原型在被反复编辑与重新捕获，缓存住的 `base.html` 会显示上一次捕获的结果而没有任何提示。

HTTP 层的测试通过**覆盖 `Host` 头**打到 `127.0.0.1`：Chromium 把 `*.localhost` 解析到回环（已实测），但 Node 的解析器不会，所以测试不能按字面拨号。路由本来就认 Host，两条路走的是同一段代码。

HTTP 层那条越界测试只断言"任何拼法都到不了目录外的文件"——诚实说明：URL 解析器在请求发出前就把 `..` / `%2e%2e` 规范化掉了，所以服务端的拒绝由 `resolveServedPath` 的单测覆盖。

### 16.6 未做 / 已知限制

- **端口是临时的**，origin 每次启动都变，因此 cookie 与 `localStorage` **不跨重启**。原型流程不依赖这个；要持久就得绑一个稳定端口（并处理被占用的情况）。
- **`overlay` 的 `base.html` 是快照**：它的相对资源 URL（`/assets/x.js`）现在会打到回环服务器而不是原来那个站点，和 `file://` 时代一样取不到；绝对 URL 的资源正常。捕获快照本来就只保证"那一刻渲染出来的样子"。
- **`/` 的含义是"这个原型，当前状态"**，没有独立的 index 概念要同步。
- **改了已有补丁的*内容*，页面不会自己变**：页面是在渲染那一刻内联的，`prototype-apply` 只补"页面上还没有的"（按文件名判断，见 §16.4.1），所以新增的那条立刻生效、改过内容的那条要**刷新**才看得到。没做内容指纹是刻意的：按内容只能判断出"页面上的版本旧了"，而正确处理只有重新渲染一条路——那和刷新是同一件事，多一层判断只多一处能错。
- **判别只认文件名，不认版本**：把一个补丁文件删掉再写一个同名的，同样会被算作"已内联"。这是上面那条的另一面，不是独立缺陷。
- **没动的东西**：`webSecurity` 仍未开（D5），没有新增 partition，没有 http pass-through，真实页面浏览路径零改动。

