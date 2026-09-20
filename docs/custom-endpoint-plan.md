# 自定义模型连接 — 现状核对与整改方案

> 状态：**阶段 1–5 已落地**（§6；阶段 4 除"原始 JSON 兜底视图"）。本文既是设计记录，也是实施依据。
> 范围：`providerType: 'pi_compat'` 的连接（用户自接的任意 OpenAI / Anthropic 兼容端点）。
> 所有引用均带仓库相对路径与符号名，逐条核对过源码；涉及 SDK 的部分核对的是**已安装的 dist**，不是 `docs/`（两者有出入，见 §2.3）。
> §4 是**刻意不做**的项，后人别当 bug 修。

---

## 1. 定位

自定义连接的唯一权威判定是 `packages/shared/src/config/llm-connections.ts:isCompatProvider`（`providerType === 'pi_compat'`）。它承载的用户场景：Ollama、vLLM、DashScope、LiteLLM、自建网关、第三方聚合站。

与内置连接的决定性差别：**内置连接的模型目录由 provider 拥有，`pi_compat` 的模型由用户拥有**，`connection.models[]` 是唯一真源。两条推论：

1. 模型列表不自动拉取（§4），模型得用户写。
2. 模型级能力只能来自用户写下的东西——而今天能写的只有 `id` / `contextWindow` / `supportsImages`。

所以"弱"不体现在入口数量上，体现在**用户写下的东西有多少能起作用、能活多久**。

### 1.1 已确认的决策

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | 参数面 | **模型 id 与参数的真源是配置文件**；界面是这份配置的**视图**（一对一），不是另一套字段 | 简单直接。UI 与文件编辑同一份数据，因此不存在"UI 支持哪些参数"这个问题——UI 认识的字段可编辑，不认识的字段至少能看见、且不会被擦掉 |
| D2 | 保存语义 | 合并：缺省的键不动，显式 `null` 删除该键 | 界面与手改配置是同一份数据的两个写者，冲突时以用户刚输入的部分为准、其余原样保留 |
| D3 | 模型列表发现 | 不自动拉取，沿用现状 | 端点任意，模型由用户拥有（代码里已有同样理由，见 §4） |
| D4 | 校验 | 只测默认模型 | 同上；逐个探测是另一个功能 |
| D5 | UI 形态 | 结构化字段给控件，长尾字段（`headers`/`compat`/`thinkingLevelMap`）给原样文本，另有一个连接级"原始 JSON"兜底视图 | 见 §6 阶段 4。"对应就是配置"要求：任何字段都不会因为 UI 不认识而无法编辑；字段声明只存在一份 |
| D6 | 思考能力的参数名 | 用户侧只写 **`supportsThinking`**；SDK 的 `reasoning` 只在 `buildCustomEndpointModelDef` 里出现一次（翻译点） | 一个概念只给用户一个名字。`supportsThinking` 本来就是 picker 读的那个（`CompactModelSelector.tsx` 用它置灰思考开关），沿用它可以省掉"写两遍才生效" |
| D7 | 连接级的模型能力默认 | **取消**。`customEndpoint` 只留属于端点/账号的东西（`api`、`headers`），`supportsImages` 这类模型能力一律逐模型写 | 一个端点下模型能力各异，**一个连接级的值必然对其中一些模型是错的**，而它会被"没写这一项"的模型静默继承。判据是"属于端点还是属于模型"。**不做迁移**：旧配置里手写的 `customEndpoint.supportsImages` 成为未知键被忽略（明确决定，不兼容） |
| D8 | 能力位的取值规则 | **模型层显式值永远优先**：写了 `true` 或 `false` 都以它为准，**与连接类型无关**；两层都没写才取 **true**（permissive）。判据只有一处实现（`modelSupportsImages` / `modelSupportsThinking`），SDK 侧同规则（`buildCustomEndpointModelDef` 兜底 true），发送前拦截（`filterAttachmentsForModelInput`）与 composer 的警告条都读它 | 一个概念一个判据。曾经有过"非 compat 直接 return true"的短路（等于让连接类型盖过模型层），已去掉——否则用户写下的 `false` 会无声失效，正是这轮在治的那类毛病。代价：显式 `false` 成为唯一的关闭方式，纯文本端点收到图片、非推理端点收到推理参数都可能被 400 |

D1 是本文的分水岭：**参数面与 UI 是同一份配置的两个视图**。所以"改代码"的产出是"让文件里写的参数能被原样接受、活得住、且看得见"——顺序一旦反过来（先铺 UI、后修语义），铺得越多丢得越快。

---

## 2. 现状实测

> 本节与 §3 记录的是**改造前**的实测（写于阶段 1、2 落地之前）。P0 / P2 已按 §6 修掉，其余仍然成立。

### 2.1 连接级字段

| 字段 | 声明处 | 用户可设 | 界面入口 |
|---|---|---|---|
| `baseUrl` | `llm-connections.ts:LlmConnection` | 是 | 创建/编辑表单 |
| `customEndpoint.api` | `llm-connections.ts:CustomEndpointConfig` | 是 | 协议开关（OpenAI / Anthropic 二选一） |
| `customEndpoint.supportsImages` | 同上 | 是 | **无**（只能手写配置文件）→ **已按 D7 取消** |
| `models[]` | `LlmConnection.models` | 是 | 一个逗号分隔文本框，只能输 id |
| `defaultModel` | 同上 | 是 | 取文本框第 1 个 |
| `piAuthProvider` | 同上 | 派生 | 无（由协议推导） |
| `modelSelectionMode` | 同上 | — | 自定义端点流程不赋值 |
| `midStreamBehavior` | 同上 | 是 | 卡片下拉菜单 |
| `headers` / `compat` / `modelOverrides` | **不存在** | — | — |

落盘约束：`packages/shared/src/config/validators.ts:LlmConnectionSchema` 以 `.passthrough()` 结尾（注释举了 `codexPath`/`awsRegion`/`gcpProjectId`），`models[]` 条目是 `z.string() | z.object({ id }).passthrough()`。**即：schema 允许写任意字段并保留，但代码不认识它们**——这一点在 §3 P0 会变成陷阱。

### 2.2 `models[]` 的形状与约定

两种形状：`string`（裸 id）或 `ModelDefinition` 对象（`packages/shared/src/config/models.ts:ModelDefinition`：`id` / `name` / `shortName` / `description` / `descriptionKey` / `provider` / `contextWindow` / `supportsThinking` / `supportsImages`）。

**这个数组有序且带语义**：

- 第 1 个曾被当作默认模型（表单提交 `connectionDefaultModel: parsedModels[0]`）。**阶段 5 改了**：默认模型由用户在行上单选，存进 `connection.defaultModel`；第 1 行只是"没选过"时的兜底显示。
- 找小模型按名字猜（anthropic 找 `haiku`、pi 找 `mini` / `flash`、其余取最后一个，`llm-connections.ts:findSmallModel`）。**阶段 5 把它变成"看得见的默认值"，并且只对内置目录生效**：连接级 `fastModel` 有值就用它；没值则**内置目录猜、自定义端点直接跟随 `defaultModel`**（端点的模型目录是用户自己的，名字里带 `mini` 只是巧合）。编辑器下拉的默认选中项就是 `guessSmallModelId()` 的结果（自定义端点因此显示 `Follow the default model`）。

模型选择器读的是**连接上的 `models[]`**，不是静态注册表（`apps/electron/src/renderer/components/app-shell/input/CompactModelSelector.tsx:availableModels`）；对象条目会显示 `name` 与 `description`（同文件 `:350-364`）。

因此：**`{ "id": "qwen3-coder", "name": "Qwen3 Coder" }` 写进配置文件，picker 里显示的就是这个名字。** 显示名这条能力其实已经通了——问题在于它活不过一次界面保存（§3 P0）。

### 2.3 转发到 Pi SDK 的部分

SDK 实际接受的定义（`node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts:ProviderConfigInput`）：

- **provider 级**：`name` / `baseUrl` / `apiKey` / `api` / `streamSimple` / `headers` / `authHeader` / `oauth` / `models[]`
- **model 级**：`id` / `name` / `api` / `baseUrl` / `reasoning` / `thinkingLevelMap` / `input` / `cost` / `contextWindow` / `maxTokens` / `headers` / `compat`

我们实际传的：

- provider 级（`packages/pi-agent-server/src/index.ts:registerCustomEndpointModels`）：只有 `baseUrl` / `apiKey` / `api` / `authHeader` / `models`。
- model 级（`packages/pi-agent-server/src/custom-endpoint-models.ts:buildCustomEndpointModelDef`）：`id` / `name`（**恒等于 id**）/ `reasoning`（**恒 false**）/ `input` / `cost`（**恒全 0**）/ `contextWindow` / `maxTokens`。

结论：`name` / `reasoning` / `thinkingLevelMap` / `cost` / `headers` / `compat` 都是**没转发**，不是做不到。缺的是转发，不是能力。

⚠️ `modelOverrides` 只出现在 SDK 的 `docs/models.md` 与 CHANGELOG，**当前安装的 dist 代码里没有实现** → 不能依赖，别写进方案。

### 2.4 用户实际能配的面

今天只有 `id`、`contextWindow`、`supportsImages`（逐模型或连接级）。其余全部取我们给的常数（`contextWindow` 默认 `1_000_000`，`maxTokens` 默认 `393_216`，均硬编码在 `buildCustomEndpointModelDef`）。

目标态（D1 + D5）：`models[]` 的一条 = **一个 id + 一组可选参数**，SDK 支持的字段写什么就是什么；同一组参数在界面上也有一一对应的视图（§6 阶段 4），`buildCustomEndpointModelDef` 只负责给没写的项兜底。

---

## 3. 问题（按严重度）

### P0 · 三个"静默销毁"点：手写的能力面活不过一次界面操作 —— **已修（阶段 1）**

这是"弱"的根因。今天唯一充裕的能力入口是手写 `config.json`，但：

1. **`updateLlmConnection` 是逐字段重建**（`packages/shared/src/config/storage.ts:updateLlmConnection` 的白名单对象字面量）。任何只靠 `.passthrough()` 存活的字段——`headers`、`compat`、乃至未来新增的字段——在**任意一次保存后消失**。用户不会看到报错，只会看到配置"自己变回去了"。
2. **编辑连接会把 `models[]` 重建成 `string[]`**。表单是逗号文本框（`apps/electron/src/renderer/components/apisetup/ApiKeyInput.tsx:parseModelList`），提交 `models: string[]`，服务端覆盖式赋值（`packages/server-core/src/handlers/rpc/llm-connections.ts:114-116`）→ 逐模型的 `name` / `contextWindow` / `supportsImages` 一并丢失。回填只回填 id（`apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx:handleEditConnection`）。
3. ~~**连接级 `customEndpoint.supportsImages` 同样丢**~~：提交 payload 只有 `{ api }`（`apps/electron/src/renderer/components/apisetup/submit-helpers.ts:resolveCustomEndpointPayload`），服务端覆盖（`llm-connections.ts:121-125`）。阶段 1 的合并语义修掉了"覆盖"，D7 直接把这个字段取消了——能力逐模型写，没有第二处可丢。

第 2、3 条正是"手改配置能生效、但点一次保存就没了"的成因。

### P1 · 配了也看不见

- **上下文占用提示读不到自定义模型的窗口**：`apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx` 的占用徽标取 `contextStatus?.contextWindow || getModelContextWindow(currentModel)`，后者只查静态注册表（`models.ts:getModelContextWindow`），自定义模型恒为 `undefined`。**已修（阶段 3）**：改成模型层优先。
- **`reasoning` 恒 false**（`buildCustomEndpointModelDef`）：SDK 侧该位是模型能力声明，传 false 意味着 SDK 认为它不支持推理。`thinkingLevelMap` 也无从表达。**先按"能力位被写死"记，不按"思考功能坏了"记**。（阶段 2 后该位由用户写的 `supportsThinking` 驱动，见 D6；未写时两端一致取 true，见 D8。）

**两个不算缺陷的（避免误报）**：

- `cost` 恒全 0：当前代码里 `cost` 唯一消费方是 Pi 模型列表的排序（`packages/server-core/src/handlers/rpc/llm-connections.ts` 的 `GET_PROVIDER_MODELS`），成本展示已从应用移除（`validators.ts` 注释：`tokenDisplay` / `showCost` / `cumulativeUsage` removed）。所以它**没有用户可见影响**，不要当 bug 修。
- `maxTokens` 硬编码：`maxTokens` 是 SDK 的模型定义字段（作为 `max_tokens` / `max_completion_tokens` 发出），确实不可配——但因为当前默认值刚被改成 `393_216`，更该关心的是默认值本身是否合理（§7）。

### P2 · 接不进来（**连文件里写了也不生效**）—— **已修（阶段 2）**

这两条不是"缺 UI"，而是**连配置文件这个口子都没通**——按 D1 这才是要修的：

- **`headers`**（provider 级与模型级）：`CustomEndpointConfig` 与 `CustomEndpointModelOverrides` 都没有这个字段，`normalizeCustomEndpointModelEntry` 会丢掉它，`registerCustomEndpointModels` 也不往 `registerProvider` 传 → 在 `config.json` 里手写自定义鉴权头 / 路由头 / 网关 token 同样无效。需要这些头的端点接不进来。
- **`compat`**：同上。第三方端点最常见的兼容性坑（`maxTokensField`、`supportsDeveloperRole`、`supportsReasoningEffort`、`thinkingFormat` 等）无法覆盖，而这些恰恰是自接端点最容易踩的。

### P3 · 文案与表述

- 自定义端点的表单文案**硬编码英文且未走 i18n**（`ApiKeyInput.tsx` 的 `Default Model` / `Protocol` / `Comma-separated list. …` 等），而 `packages/shared/src/i18n/locales/en.json` 里 `apiSetup.format.openaiCompatible` / `anthropicCompatible` 是现成的 key，没人用。
- 提交失败的错误是开发者口吻英文、未翻译（`packages/server-core/src/domain/connection-setup-logic.ts:validateSetupTestInput` 等）。
- `models[]` 的**顺序语义**（第 1 个默认、最后 1 个用于摘要）曾只写在表单一行小字里。**阶段 4/5 已解决**：默认模型是行上的单选、辅助模型是独立字段的下拉，两者都不再依赖顺序。

### P4 · UI 只是"一个逗号串"

模型只能整串重输，不能逐条增删、不能改顺序、看不到每条带了哪些参数。连接卡片也不显示模型数 / 协议 / 参数全貌（`AiSettingsPage.tsx:ConnectionRow`）。这一条按 D5 修。

---

## 4. 刻意不做（非目标）

- **不自动拉模型列表**。`packages/shared/src/config/model-fetcher.ts:FetchableProvider` 明确 `Exclude<LlmProviderType, 'pi_compat'>`，`packages/server-core/src/model-fetchers/index.ts:_doRefresh` 见 compat 直接 return。理由写在代码注释里：compat 指向任意端点，模型由用户配置。
- **不逐个校验 `models[]`**：连通性测试只打默认那一个模型。
- **不在界面复述配置文件**：不因为配置文件里能写，就在 UI 里再开一组同义字段——那是第二份描述，必然过期。
- **不加连接级的模型能力默认**（D7）：一个端点下模型能力各异，"少写几遍"换来的是"没有这个能力的模型静默继承"。模型能力一律逐模型写。

---

## 5. 设计原则（决定 §6 的先后）

1. **盘上的形状是事实**。一个"界面一保存就没了"的能力面等于假能力面。所以**先修合并语义，再谈加字段**；顺序反了，加多少字段都留不住。
2. **只有两个写者会互相覆盖时才需要规范**。UI 与手改配置是同一份数据的两个写者：冲突时以"用户刚在界面输入的部分"为准，但**没被编辑的部分必须原样保留**。判据是"这是约定还是配置"——除写入冲突外一律放行。
3. **界面是配置的视图，不是配置的第二份描述（D1 / D5）**。判据三条：① UI 里的字段必须与配置文件里的字段一一对应，不引入只存在于 UI 或只存在于文件的字段；② UI 不认识的字段不能因为它不认识就丢掉（合并语义 + 原始 JSON 兜底视图）；③ 不为长尾 quirk 造专门控件——那是"每加一个 quirk 就要跟一次"的第二份描述。

---

## 6. 整改方案

### 阶段 1 · 守住数据（前提，收益最大，不动 UI）—— **已落地**

改动点：

- `packages/shared/src/config/storage.ts:updateLlmConnection`：白名单重建改为合并语义（`{ ...existing, ...updates }`）。契约按 D2 明确为：**未出现在 `updates` 里的键不动；显式给了值就写该值；显式 `null` 删除该键**。未知字段随之自然存活。
- 编辑表单保存时，对 `models[]` 做**按 id 的保留式合并**：已在连接里的对象条目原样保留（今天界面只编辑 id 列表，所以等价于"旧条目保对象、新 id 用字符串"）。落点：`ApiKeyInput.tsx` 提交处 / `packages/server-core/src/handlers/rpc/llm-connections.ts:114-116`。
- 连接级 `customEndpoint` 并入而非替换（保住 `supportsImages`）。

验证：构造一个带 `name` / `contextWindow` / `headers` 的连接，走一次 `updateLlmConnection` 与一次编辑表单保存，断言字段仍在；测试放 `packages/shared/src/config/__tests__/` 与 `packages/server-core/src/handlers/rpc` 附近。

### 阶段 2 · 补齐转发（代码量小，收益直接）—— **已落地**

把"能落盘但没转发"的字段透传到 Pi：

- **先定类型**：`models[]` 的对象条目统一定义一次，放在 `packages/shared/src/config/llm-connections.ts`，由 `pi-agent-server` 引用（它已经用相对路径引 shared，如 `../../shared/src/config/models.ts`，所以放 shared 没有障碍）。今天同一个形状有三份拷贝——`custom-endpoint-models.ts` 里的 `CustomEndpointModelConfig` / `CustomEndpointModelOverrides` / `CustomEndpointModelEntry`——而 `LlmConnection.models` 用的又是 `ModelDefinition`，三方字段集不一致，这正是参数会在中途被丢掉的成因。**写者（配置文件）与读者（pi-agent-server）共享一个类型，是这一阶段的前提。**
- `custom-endpoint-models.ts:CustomEndpointModelOverrides` 扩到 `name` / `supportsThinking` / `contextWindow` / `maxTokens` / `headers` / `compat` / `thinkingLevelMap` / `supportsImages`，**一次做全**：字段声明只有一份（阶段 4），所以多支持一个字段不新增 UI 工作量，成本只剩转发本身。
- `custom-endpoint-models.ts:normalizeCustomEndpointModelEntry` 不再丢字段；`buildCustomEndpointModelDef` 改为"覆盖值优先，常数只兜底"。
- 透传链同步（缺一处就静默失效）：`packages/shared/src/agent/backend/internal/drivers/pi.ts`（`customModels` 映射）、`packages/server-core/src/sessions/SessionManager.ts`（同一映射）、`packages/pi-agent-server/src/index.ts`（`InitMessage` / `RuntimeConfigUpdateMessage` 的 `customModels` 类型与 `customModelOverrides`）、`packages/server-core/src/sessions/runtime-config.ts:buildBackendRuntimeSignature`（影响面变了要重算签名，否则改了配置不重连）。
- provider 级 `headers`：`CustomEndpointConfig` 加字段，`registerCustomEndpointModels` 里透传给 `registerProvider`。

注意：`registerCustomEndpointModels` 里的 `registerProvider` 是**整体替换**，新增字段必须一路带到 `customModelOverrides`，否则只有首个模型生效。

**落地结果**（与上面设计的三处偏差，都是收紧）：

- **类型统一比预想更彻底**：`LlmConnection.models` 的条目类型改为 `ConnectionModelEntry = ModelDefinition | CustomEndpointModelEntry | string`。盘上的条目本来就只有 `id` 必填，旧声明 `ModelDefinition | string` 是假的（`setModelSupportsImages` 早就写半拉对象再强转）。`CustomEndpointModelEntry` 另带 display-only 字段（`shortName` / `description` / `descriptionKey`）：存在盘上供 picker 读，不转发给 SDK。
- **思考能力按 D6 只留一个名字**：参数集里是 `supportsThinking`，`buildCustomEndpointModelDef` 里 `reasoning: overrides?.supportsThinking ?? false` 是 SDK 那个名字唯一出现的地方；`reasoning` 已从参数集与转发键表里去掉。
- **一个投影点**：`toCustomEndpointModels(connection.models)` 是唯一的"盘上形状 → IPC 形状"转换，Pi driver 与 SessionManager 都调它，`runtime-config.ts:normalizeCustomModels` 也改用它算签名。没有参数的条目仍塌成裸 id，IPC 载荷不变大。
- **一处合并实现**：`packages/shared/src/config/storage.ts:applyLlmConnectionUpdate`。setup 处理器用它算 pending connection——不能用展开，展开会把 `null` 留进要落盘的对象（schema 拒 `null`）；同时把那 4 处"显式 `undefined` 表示清空"改成了 `null`。
- provider 级 `headers` 一并落地：`CustomEndpointConfig.headers` + `validators.ts:CustomEndpointSchema` + `registerProvider` 透传。

### 阶段 3 · 可见性 —— **已落地**

- 占用徽标的读取顺序改为**模型层优先**：`modelContextWindow(connection, model)` ?? SDK 上报的 `contextStatus.contextWindow` ?? 静态注册表 `getModelContextWindow()`。模型层就是连接上模型条目写的 `contextWindow`（也是我们注册给 SDK 的那个值），所以自定义模型在 SDK 上报 usage **之前**就有占用百分比了。
- 模型显示名：阶段 1 到位后，写在配置文件里的 `name` 既能在 picker 显示、也能传到 SDK（无需额外改动）。

### 阶段 4 · UI：配置的视图（D5）—— **已落地（原始 JSON 兜底视图除外）**

前置：阶段 1（不擦数据）+ 阶段 2（参数能生效）。视图建立在配置之上——配置本身不通时，铺 UI 只会更快地丢东西。

**落地形态**（替换了连接编辑里的那个逗号串）：

| 区域 | 内容 | 控件 | 落点 |
|---|---|---|---|
| 模型列表 | 逐行一条模型，可增删、可上下移 | 行 = 带 `id` 标签的输入框 + 参数折叠区 | `apps/electron/src/renderer/components/apisetup/CustomModelListEditor.tsx` |
| 结构化参数 | `name` / `supportsImages` / `supportsThinking` / `contextWindow` / `maxTokens` | 文本框 / 开关 / 数字框（token 数带常用值按钮） | 同上（由参数描述表渲染） |
| 长尾参数 | `headers` | 键值对行（键、值各一格） | 同上 |
| 长尾参数 | `cost` / `compat` / `thinkingLevelMap` | 原样 JSON 文本框，写坏时当场标红且不落盘 | 同上 |
| 连接级 `headers` | `customEndpoint.headers` | 键值对行 | 同上（`ConnectionHeadersEditor`），插在协议开关之后 |
| 兜底 | 整个连接的原始 JSON | 可展开的文本视图 | **未做**（见 §7） |

**顺序语义在界面上表达**（阶段 5 已改为显式字段，见下）：阶段 4 是首行标 `default`、用 ↑/↓ 改顺序，小模型不标——`findSmallModel` 对 `pi_compat` 先按关键词找（`isPiProvider('pi_compat')` 为真，关键词 `mini` / `flash`，命中 id / name / shortName 里第一个匹配的），没命中才取最后一个，所以"最后一行 = 摘要模型"只是规则的一半，徽标表达不了；规则写进底部说明。

**列表的初值**：预设的推荐模型串（`COMPAT_*_DEFAULTS`）原先只写进那个逗号字段，而编辑器读的是行，于是新建自定义连接时列表恒为 0 行（"0 configured"，默认/辅助下拉也没得选）。现在预设会把推荐 id 播进行里（`ApiKeyInput.tsx:seedModelsFromPreset`，仅在列表为空时），任意端点（`custom`）不播——别的厂商的 id 摆在那里只会误导。逗号字段仍照旧写，供"URL 被清空、回落到逗号输入"的分支使用。

**数字参数的常用值**：参数表里给 `contextWindow` 与 `maxTokens` 各带一组 `presets`（128k / 256k / 1M，8k / 128k / 384k），渲染成输入框下面可点的小按钮；`Add model` 新建的行直接以 `CUSTOM_ENDPOINT_MODEL_DEFAULTS`（1M / 384k）开头。也就是说这两个数字从"隐含的兜底"变成"看得见、可改"，而 SDK 侧的 `buildCustomEndpointModelDef` 读同一个常量（原先写死在 `pi-agent-server/src/custom-endpoint-models.ts`，现提到 `llm-connections.ts`，两处不再各写一遍）。折叠行的摘要也按同一套单位显示（`131072 → 128k`、`1000000 → 1M`），否则会与按钮上的字不一致。

**预设不会被 URL 自动改写**：表单原先会在 URL 恰好等于某个已知端点时自动切到那个预设 —— 把 `https://api.deepseek.com` 粘进 Custom 就会变成内置 DeepSeek provider，自定义端点的模型表、协议、请求头全部作废。现在选中 `Custom` 之后改 URL 不再切预设（要换预设就从下拉里显式选），也不会把别的预设的推荐模型播进 Custom。Provider 之间（openai → deepseek 之类）照旧按 URL 跟随。

**重复 id 被拒（编辑器 + 提交两处拦）**：`models[]` 在每个消费方都是按 id 作键的（storage 保存时去重取第一个、pi-agent-server 用 Set 注册、覆盖参数用 Map 让后者赢），所以重复 id 会让"界面 / 盘 / 运行时"三处答案不同。`findDuplicateModelIds()` 是唯一判据：行上标红 + 底部点名，提交时直接拦下。storage 的去重保留作为兜底（也顺手清掉手写进配置的重复）。

**三条硬要求**：

1. **字段声明只有一份**（已做到）：`llm-connections.ts:CUSTOM_ENDPOINT_MODEL_PARAM_SPECS` 是唯一的参数表；UI 由它渲染控件，`toCustomEndpointModels` 也按它取键，`customEndpointEntryHasParams` 判"这条到底写了参数没有"。加一个参数 = 改这张表 + 转发链，编辑器组件不动。
2. **UI 不认识的东西不能丢**（已做到，两条腿）：保存走阶段 1 的合并语义；编辑器持的是**盘上的条目对象**本身（`AiSettingsPage` 把 `connection.models` 原样回填，不再只传 id），所以未渲染的键原样写回。
3. **不拒绝，只报告**（已做到）：数字/JSON 写坏时只在字段上标红，不落盘也不拦提交。**例外是"这一行会被丢掉"的两类**——重复 id（三个消费方答案不同）、以及填了 display name 却没有 id（保存时会被过滤掉，用户刚输入的内容无声消失）；这两处行上给出提示（`duplicate` / `needs an id`）并拦下提交。

**`id` 要带标签**：行首那个输入框是模型的**身份**，不是又一个参数——参数区第一行恰好是 "Display name"，实测会被当成 id 填（于是行不计入 "N models"，保存时整行被丢掉）。所以它在行首带一个 `id` 标签，`Display name` 的提示语仍是 "defaults to the id"。

**保存路径**：编辑态仍走 `setupLlmConnection`，但 `models` 现在能带参数上行（`LlmConnectionSetup.models` / `ApiKeySubmitData.models` / useOnboarding 全链放宽到 `ConnectionModelEntry[]`），并且**只有 id 的行提交时塌回裸字符串**，所以 config.json 不会因为打开过界面而膨胀。连接级 `headers` 走 `customEndpoint` 的浅并入（阶段 1）。文档原先写的"读整段连接 → 整体写回"没有采纳：效果已验证等价（不擦数据靠合并语义，靠的不是保存入口的形态）。

**明确不做**：

- 为 `compat` 的每个 quirk 造专门控件（第二份描述，SDK 每加一个就跟一次）。
- 从端点拉取模型列表（D3）。
- 卡片上的参数摘要面板——卡片保持现状（名字 / 主机名 / 状态），参数进编辑页看。
- 模型级的"连接级默认值"继承链（D7 已把它取消，`supportsImages` 只有逐模型一种写法，见 §7）。

---

### 阶段 5 · 默认模型与辅助模型由用户指定 —— **已落地**

阶段 4 之后还剩一个"猜"：辅助模型（标题生成 / 摘要 / mini agent）由 `findSmallModel` 按名字找 `mini` / `flash` / `haiku`。它的问题不是"不该猜"，而是**猜的结果用户既看不见也改不了** —— 而自定义端点的模型名与"小"本来就没有关系。

| 项 | 结论 | 落点 |
|---|---|---|
| 默认模型 | 模型列表下方一个**下拉**（`Default model`），写进 `connection.defaultModel`。打开编辑按盘上的值回填；盘上没有（或指向已被删的行）才落到第一个有名字的行 | `CustomModelListEditor.tsx` / `ApiKeyInput.tsx` 提交处 |
| 辅助模型 | 连接级新字段 `connection.fastModel` + 同区域第二个下拉（`Fast model`）：列全部模型，外加一项 `Follow the default model` | `packages/shared/src/config/llm-connections.ts:LlmConnection.fastModel` |
| 解析顺序 | `fastModel`（用户选的）→ 猜 → `defaultModel` → 列表最后一个。**猜只对内置目录生效**（见下） | `llm-connections.ts:findSmallModel` |
| 猜只给内置目录 | `guessSmallModelId()`（anthropic 找 `haiku`、pi 找 `mini` / `flash`、其余三种都试，没命中取最后一个）在 `isCompatProvider` 时直接返回 `undefined` | `llm-connections.ts:guessSmallModelId` |
| 自定义端点 | **没有猜**：没设 `fastModel` 就用 `defaultModel`（用户自己的目录里，名字不含任何信号）。下拉因此默认显示 `Follow the default model`，选中它就是删掉这个键 | 同上 / `CustomModelListEditor.tsx` |
| 用不了的选取 | 指向已删的模型、或被 `isDeniedMiniModelId` 拒绝时，**当作没设**（回到上面的默认路径），不报错；编辑页仍把这个值列出来（标注 "not in the list"），用户能改回来 | 同上 |
| 链路 | `LlmConnectionSetup.fastModel`（缺省=不动 / `null`=删键 / id=选取）→ `updates.fastModel`；`pi` 连接按 `defaultModel` 的同一约定补 `pi/` 前缀 | `protocol/dto.ts` / `server-core/src/handlers/rpc/llm-connections.ts` |
| 回填 | 打开编辑时 `connectionDefaultModel` 传**单个 id**（原来传的是整串逗号列表——这正是"手写的 `defaultModel` 被第 1 行覆盖"的来源），`fastModel` 同路传 | `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx:handleEditConnection` |
| 3 档连接 | Pi 的 Best/Balanced/Fast 在提交时把 Fast 档写进 `fastModel`；启动迁移为已存在的 `userDefined3Tier` 连接补一次（取第 3 个） | `ApiKeyInput.tsx` / `storage.ts:backfillAllConnectionModels` |

> 两个选择都是**连接级角色**，不是模型的属性，所以都放在列表之外的下拉里；列表本身只表达目录（有哪些模型、各带什么参数）与顺序（不再承载"谁是默认"）。

**下拉的层级坑（会复发）**：连接编辑页挂在 `FullscreenOverlayBase`（Radix Dialog，`z-fullscreen` = 350）里，而 `SelectContent` / `DropdownMenuContent` 默认是 `z-dropdown` = 100，portal 到 `body` 后会被遮罩盖住 —— 表现为"点开没反应"。这个表单里所有的浮动层都显式抬到 `z-floating-menu`（400），见 `ApiKeyInput.tsx` 的预设下拉与档位下拉；本编辑器两个下拉同样加 `className="z-floating-menu"`。同理，`SelectItem` 不接受空字符串 value，占位状态要用自己的哨兵值。

**为什么内置可以猜、自定义不能**：判据是"这个名字是不是上游给的"。内置目录（anthropic / pi）的 id 由 provider 定义，`haiku` / `mini` / `flash` 是有约定含义的；自定义端点的 `models[]` 是用户自己写的，`mini` 出现在某个名字里纯属巧合——猜它等于替用户做一个他无法预期的决定（而且他既看不见也改不了）。所以猜降级成"内置连接的默认值"，自定义端点直接跟随 `defaultModel`。

**为什么"没设"就够了，不需要一个额外的"跟随默认"取值**：对自定义端点，`fastModel` 的两种状态（有值 / 没值）已经完整表达了"我选了 X"与"我没选"。下拉里的 `Follow the default model` 因此就是**删掉这个键**（提交时发 `null`），而不是往配置里写一个空串——盘上不会出现 `"fastModel": ""` 这种需要额外解释的东西。

保留了猜之后，编辑器把 `guessSmallModelId()` 的返回作为下拉的默认选中项，所以**界面上显示的就是运行时真正在用的那个**（自定义端点的猜恒为 `undefined`，于是显示 `Follow the default model`，与运行时一致）。

---

## 7. 待解决

1. **"整个连接的原始 JSON"兜底视图**（阶段 4 唯一没做的部分）：它的作用是**看得见**（不丢已经由合并语义保证了）。现在连接级只剩 `api` + `headers`，两者都有控件了；真正会落在视图外的只有用户手写的新字段。做不做取决于是否真有"写了个界面不认识的字段、想确认它在不在"的场景。
2. **`contextWindow` / `maxTokens` 的默认值**：现在是 `1_000_000` / `393_216`（全局默认，对所有自定义端点生效，含 Ollama 这类小模型）。这两个值已经可以按模型覆盖（界面也能改），所以更合理的默认是收回 `131_072` / `8_192`，把大值交给配置——但这会改动现有行为，需要单独确认。
3. **模型能力类参数是否有别的第二来源**：D7 取消了连接级 `supportsImages`，剩下的能力参数（`contextWindow` / `maxTokens` / `supportsThinking`）本来就只有逐模型一处，维持现状——**不要**再给它们加连接级默认。
4. **写坏的参数怎么让人知道**：编辑页当场标红了（阶段 4 已做），但**手改配置文件**的人看不到——要不要进连接测试的结果里报一次？
5. **内置连接的"不要猜"**（阶段 5 的取舍）：自定义端点没有猜，跟随默认模型；内置目录（anthropic / pi）仍然猜 `haiku` / `mini` / `flash`，目前**没有办法让它改成"跟随默认"**（曾经用空串表达过，因为盘上会出现 `"fastModel": ""` 而收回）。真要的话，正解是给内置连接也加同样的下拉，而不是新增一个只在文件里存在的取值。
