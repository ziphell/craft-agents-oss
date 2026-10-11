# 识图模型 — 文本主模型借用视觉模型看图（设计方案）

> 状态：**已实现**。`typecheck:all` 绿；触及的测试（`vision-model` / `runtime-config` / `video-commands` / `pi-video-understand`）已更新并通过。本文既是设计记录，也是实施依据。
> 范围：模型连接上的**识图模型**设置 + 两个"把图交给模型"的门（`call_llm` 即 LLM Tool、`video_tool understand`）的图片通道打通 + 送模型前对图片的处理与提示。
> 读法：§1 是判断（为什么不是"造一个新工具"）；§2 是现状与可直接复用的件；§3 是缺口；§4 是拍过的板；§5 是落点；§6 是**刻意不做**的项——后人别当 bug 修；§7 是已定的选择（原开放问题）。
> 所有引用带仓库相对路径与符号名，逐条核对过源码。
> 配套：[术语与文案规范](vocabulary.md)、[自定义模型连接方案](custom-endpoint-plan.md)、[浏览器录制与视频理解方案](video-understanding-plan.md)

---

## 1. 判断

**目标**：当主模型（会话选定的那个）不支持图片输入时，用户贴的图仍能被"看懂"——由一个**专用的识图模型**（多模态）回答，再把答案带回主模型继续干活。

**一句话**：这**不是**"新增一个图像理解工具"，而是**给已有的 `call_llm` 接上图片通道，并让它能选中一个可配置的识图模型**。

**总原则：纯增量（opt-in），不改既有行为。** 只有在**「主模型不支持图片」且「能解析到一个能看图的模型」**两条同时成立时，行为才与今天不同；其余一切情况**保持原有行为**：

| 情况 | 行为 |
|---|---|
| 主模型**支持**图片 | **不变**——图照旧直接进主模型；`visionModel` 配不配都一样 |
| 主模型**不支持**图片 · 链上能解析到能看图的模型（`visionModel` / 连接小模型 / 连接 `defaultModel` 任一，§5.2） | **新行为**——保留图片路径供 agent 路由；banner 改为信息条 |
| 主模型**不支持**图片 · 解析不到（以上都看不了图） | **不变**——沿用今天：图被移除 + 警告条；`call_llm` 照旧拒绝图片附件 |

换句话说：**解析不到能看图的模型时，这条线等于不存在**——不产生新的失败路径，也不改变任何既有输出。

（"能看图"由 `modelSupportsImages` 判定，见 §5.2 的 `resolveImageModel`；它把"`visionModel` 失效 / 不可用"这类情况自动退到下一个候选，全不可用才落到第三行。）

> **唯一一处不等同于"保持现状"**：`video_tool understand` 今天不校验、会把帧发给看不了图的模型并被 400——那是 bug，本方案改为**报错**（§5.7 / D11）。**增量加功能不等于保留 bug。**

**同一个设置也服务 `video_tool understand`**：它把录像抽帧后走的是**同一条 `queryLlm` 图片通道**（见 §5.7）。所以"谁能看图"这条候选链（`visionModel` → 小模型 → `defaultModel`，§5.2）是两个门共用的。

三条依据：

1. **工具已经存在，且就是那个"LLM Tool"。** `call_llm`（[llm-tool.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/llm-tool.ts) 的 `createLLMTool`）本就是"让主 agent 调一个次级 LLM 干专门活"的那道门；它已有 `model` 参数。
2. **图片通道已经存在。** [video-understanding-plan.md](file:///c:/Users/Ryan/code/craft-agents-oss/docs/video-understanding-plan.md) §6.3 给 `LLMQueryRequest` 加了 `images[]`，两个 backend 的 `queryLlm` 都已经能消费它。识图正好是同一个通道的第二个消费者。
3. **"Fast model" 已经示范了"连接级模型角色"该怎么配。** 我们照它加一个同形的 `visionModel` 即可，不必发明新机制。

**唯一的结构性约束**（它决定这条线能做到多远）：`call_llm` 的 `queryFn` 就是**主 agent 自己的 backend**（见 §2.2），因此**识图模型必须落在同一个连接内**——同一个自定义端点下的另一个模型可以，另一家 provider 的模型不行。这条来自现状，不是本文的限制；要打破它是另一个量级的改动（§6 / §7-U6）。

---

## 2. 现状与可复用的件

### 2.1 "Fast model" 是什么（要照着长的那个样板）

| 维度 | 现状 | 出处 |
|---|---|---|
| 字段 | `LlmConnection.fastModel?: string`（连接级，**未设** = 不指定） | [llm-connections.ts:391](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/config/llm-connections.ts#L385-L391) |
| UI | "Fast model" 下拉（第三个 `ModelPicker`，`emptyOption` = 跟随默认模型） | [CustomModelListEditor.tsx:328-338](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/components/apisetup/CustomModelListEditor.tsx#L328-L338) |
| 三档流程 | Best / Balanced / **Fast** 的 Fast 写进 `connectionFastModel` | [ApiKeyInput.tsx:448-459](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/components/apisetup/ApiKeyInput.tsx#L442-L460) |
| 解析 | `getMiniModel` / `getSummarizationModel` → `findSmallModel`：显式 `fastModel` 优先，否则**按名字猜**（内置目录）或跟随 `defaultModel`（自定义端点） | [llm-connections.ts:554-611](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/config/llm-connections.ts#L554-L611) |
| 用途 | 标题生成、摘要、mini agent —— 即"便宜" | [SessionManager.ts:3459](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts#L3455-L3464)、`:5911`、`:8275`、`:9430` |
| 校验 schema | `fastModel: z.string().optional()`（`LlmConnectionSchema` 以 `.passthrough()` 收尾） | [validators.ts:87-100](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/config/validators.ts#L87-L100) |
| 落盘合并 | `applyLlmConnectionUpdate` 逐字段合并（缺省不动 / 显式 `null` 删键） | [storage.ts:2806-2831](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/config/storage.ts#L2806-L2831) |
| 编辑回填 UI | `handleEditConnection` 带出 `fastModel` | [AiSettingsPage.tsx:872](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx#L872) |
| 提交 DTO | `LlmConnectionSetup.fastModel?: string \| null` | [dto.ts:619-637](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/protocol/dto.ts#L619-L637) |

**关键提醒**：`fastModel` 的语义是"**便宜**"（标题 / 摘要 / mini），**没有**"能看图"的含义。所以它**不能**兼任识图模型——把两件事压进一个字段，要么摘要用了个不便宜的视觉模型，要么识图选中了个看不见图的模型。

### 2.2 `call_llm` 已经是图像理解工具的骨架

| 已经有的 | 出处 |
|---|---|
| 工具本体 `createLLMTool('call_llm')` | [llm-tool.ts:592](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/llm-tool.ts#L592) |
| `model` 参数（按 id / shortName / name 解析） | [llm-tool.ts:614-615](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/llm-tool.ts#L614-L615)、校验在 L650-666 |
| **图片通道** `LLMQueryRequest.images?: LLMQueryImage[]` | [llm-tool.ts:41-74](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/llm-tool.ts#L41-L74) |
| `processAttachment` 已能把图片读成 `{ base64, mediaType }` | [llm-tool.ts:452-468](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/llm-tool.ts#L452-L468) |
| 工具注册（`getQueryFn` 取会话回调） | [session-scoped-tools.ts:279-290](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/session-scoped-tools.ts#L279-L290) |
| Claude backend 消费 `images`：按 `timestampMs` 交错成 image block | [claude-agent.ts:3196-3238](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/claude-agent.ts#L3196-L3238) |
| Pi backend 消费 `images`：`ephemeralSession.prompt(prompt, { images })` | [index.ts:1161-1168](file:///c:/Users/Ryan/code/craft-agents-oss/packages/pi-agent-server/src/index.ts#L1161-L1168) |
| **默认模型**（不传 `model`）——**不是主模型** | Claude 侧 `args.model \|\| getDefaultSummarizationModel()` → **静态 Haiku**（[llm-tool.ts:726](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/llm-tool.ts#L726)）；Pi 侧 `buildCallLlmRequest` 不传 model → backend 回退到**连接小模型**（[index.ts:1034](file:///c:/Users/Ryan/code/craft-agents-oss/packages/pi-agent-server/src/index.ts#L1034)） |

**`queryFn` 用的是哪个连接**：`createLLMTool({ getQueryFn })` 取的会话回调由 backend 注入——Claude 侧是 `queryFn: (request) => this.queryLlm(request)`（[claude-agent.ts:866](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/claude-agent.ts#L866)），即**主 agent 自己的连接**。`request.model` 只在**该连接内**选模型（Pi 侧还会做 provider 兼容兜底：不可用则回退，见 [index.ts:1046-1063](file:///c:/Users/Ryan/code/craft-agents-oss/packages/pi-agent-server/src/index.ts#L1046-L1063)）。→ 识图模型必须同连接。

### 2.3 送模型前的图片闸门（今天图是怎么"消失"的）

- **闸门**：`filterAttachmentsForModelInput` —— 主模型条目写 `supportsImages: false` 时，把图片附件**整段剔除**，只留文本附件；判定读 `modelSupportsImages`。出处 [runtime-config.ts:121-145](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/runtime-config.ts#L121-L145)。
- **调用点**：`SessionManager` 把**过滤后**的列表交给 `agent.chat()`，并推一条 warning 事件。出处 [SessionManager.ts:6800-6817](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/SessionManager.ts#L6800-L6817)。
- **能力位判据**：`modelSupportsImages(connection, modelId)` 单点实现，模型条目显式值优先，未写取 `true`。出处 [llm-connections.ts:848-859](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/config/llm-connections.ts#L848-L859)。
- **图片路径进模型的方式**：`buildSDKUserMessage` 对**任何带 `storedPath` 的附件**都加一条 `[Attached file: …]\n[Stored at: …]` 文本块；图片本身另以 base64 内联。出处 [claude-agent.ts:2509-2551](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/claude-agent.ts#L2509-L2551)；`storedPath` 字段见 [files.ts:53-65](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/utils/files.ts#L53-L65)。
- **预检提示（UI）**：贴了图而当前模型是文本模型时，输入框上方显示 `ImageSupportWarningBanner`，一键"启用图像支持"（改的是该模型的 `supportsImages`）。出处 [FreeFormInput.tsx:1550-1557](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx#L1550-L1557)、[ImageSupportWarningBanner.tsx](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/ImageSupportWarningBanner.tsx)；文案 `chat.imageWarning.title` / `.action`。

---

## 3. 缺口

### A · `call_llm` 现在明确拒绝图片附件（**唯一必须改的代码**）

- 主处理路径：`processAttachment` 返回 `type === 'image'` 时直接报错「Image attachments are not supported. Use text files only.」——[llm-tool.ts:697-701](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/llm-tool.ts#L697-L701)。
- Pi 的 PreToolUse 拦截路径：`buildCallLlmRequest` 同样的拒绝——[llm-tool.ts:228-232](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/llm-tool.ts#L228-L232)。

两处都是**图片通道建成之前**写的。**解析到模型时**把图片收集进 `images[]`、其余文本照旧进 `prompt`；解析不到就维持原样（D10）。

### B · 没有"识图模型"这个配置项，也没有 UI

全仓库搜 `visionModel` / `imageModel` 无命中。要照 `fastModel` 加一个同形字段 + 同形下拉。

### C · 图被闸门剥掉后，agent 连路径都拿不到

`filterAttachmentsForModelInput` 把图片**整个**从交给 agent 的列表里删掉，于是 §2.3 那条 `[Stored at: …]` 也不会生成——**agent 既看不到图，也不知道图在哪**，自然无法转给 `call_llm`。
→ 需要：**能解析到能看图的模型时**（`resolveImageModel`），文本模型下**不整段丢**，保留一条"路径壳"（图本身仍不内联），让 agent 能拿着路径去调 `call_llm`；**解析不到时维持今天的整段移除**（纯增量，§1）。

### D · agent 不知道"要路由"

即使 A 改了、C 补了，主 agent 也未必想到"我瞎，但可以派 `call_llm` 去看"。需要让它在**两处**知道这件事（且**仅在"图会被路由"时**——主模型看不了图 + 能解析到能看图的模型）：`call_llm` 工具描述、系统提示；预检 banner 彼时改为信息条。**否则三处均不动**。今天的 banner（§2.3）只提供"打开 supportsImages"，没有"用识图模型回答"这条路。

### E · 结构性约束与边界（非缺陷，需写明）

- **同连接**：识图模型必须与主模型在同一连接（§2.2）。跨连接 / 跨 provider 今天做不到。
- **PDF 不在覆盖内**：闸门只剔 `type === 'image'`（[isImageAttachment](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/runtime-config.ts#L108-L110)），PDF 会作为 document 块送出，文本模型收 PDF 同样可能被 400。本方案**不做**（§6、§7-U2）。

---

## 4. 决策

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | 工具形态 | **不给新工具**，用已有的 `call_llm`；本方案只做"接通图片 + 配一个模型" | 工具存在、通道存在；再造一个 `image_tool` 是同一个口子开第二遍（同 [video-understanding §6.3](file:///c:/Users/Ryan/code/craft-agents-oss/docs/video-understanding-plan.md) 的"接线不新造"口径） |
| D2 | 配置字段 | 新增连接级 `LlmConnection.visionModel?: string`，**与 `fastModel` 完全同形**（未设 = 不指定） | 一个"角色"一个字段；不复用 `fastModel`（D3） |
| D3 | 不复用 `fastModel` | 识图模型**单列**，不与 fast/summarization 混用 | `fastModel` = 便宜；识图 = 能看图。语义不同，合并必然有一头选错 |
| D4 | 路由方式 | **agent 驱动**：agent 察觉图看不了时，自己发 `call_llm`（带图），把结果并回对话 | 与 `call_llm` 已有的定位一致；不做"系统偷偷替一次模型调用"的隐式行为（§6） |
| D5 | 能力判定 | 复用 `modelSupportsImages` 判"识图模型是否**可用**"；不可用 = **当作未配**（走 D10），不因配错而报错 | 判据单点（同 [video-understanding D14](file:///c:/Users/Ryan/code/craft-agents-oss/docs/video-understanding-plan.md#L81)）。工具侧拿不到"连接"，无法可靠校验任意显式 model，所以判据只用在这一条上 |
| D6 | 同连接约束 | **接受**：v1 只支持同连接内的识图模型 | 打破它要给 `queryLlm` 加"第二连接"路由，是另一个量级（§6） |
| D7 | 存盘与保存语义 | 走 `fastModel` 同一条路：`LlmConnectionUpdate` 合并、`LlmConnectionSchema` 加可选字段、`LlmConnectionSetup` DTO 加字段 | 与既有字段同形，不引入第二套保存语义 |
| D8 | agent 怎么知道 | 两处提示，且**仅当图会被路由时生效**（主模型看不了图 + 能解析到能看图的模型）：`call_llm` 工具描述补图片用法、系统提示点名；预检 banner 彼时改为信息条（§5.6）。否则三处均不动 | 纯增量：不改变今天任何默认提示；工具描述一处源、两个门（Claude / Pi）已有做法 |
| D9 | 带图时选哪个模型 | **能力校验的候选链**：`args.model`（信任）→ `visionModel` → 连接小模型 → **会话当前模型**（=**主模型**；未覆盖时即 `connection.defaultModel`），取第一个 `modelSupportsImages` 为真的；全不可用才拒绝。无图时与今天一致 | **"主模型能看图就用它"因此成立**、零配置；`visionModel` 退为"主模型看不了时另指一个"。用 `modelSupportsImages` 校验，不是盲猜 |
| D10 | 候选全不可用时 | **不把图发出去**：staged 图照今天（被移除 + 警告条）；`call_llm` 照旧拒绝图片附件；`video_tool understand` **报错**（D11） | 绝不把图/帧发给看不了它的模型；各门按各自现状暴露（`call_llm` 本来就是拒绝），`video_tool` 的报错是**修 bug** |
| D11 | `video_tool` 用同一条链，链尾**报错** | `video_tool understand` 省略 `--model` 时取 `resolveImageModel`；**解析不到即报错**，不把帧发给看不了图的模型 | **修 bug**：今天 `understand` 不校验、会把帧发给小模型被 400（违背 [video-understanding D14](file:///c:/Users/Ryan/code/craft-agents-oss/docs/video-understanding-plan.md)）。链尾与 `call_llm` 统一——**增量不等于保留 bug** |
| D12 | 回退只走"能力校验"，不盲退 | 允许 `visionModel → 小模型 → defaultModel` 的候选链，但**每一步都过 `modelSupportsImages`**；不做"无视能力"的盲回退。识图仍以 `visionModel` 为**首选** | 盲回退（不看能力）会引入今天没有的 400；带校验的链不会——它只会挑到真能看图的模型，或拒绝。**这正是"能用主模型"与"不新增失败路径"能同时成立的机制** |

---

## 5. 落点（改动清单）

对齐"加一个角色应当只有：一个字段 + 一个解析器 + 一处接线 + 一段文案"。

### 5.1 字段与契约

1. `LlmConnection.visionModel?: string`（[llm-connections.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/config/llm-connections.ts#L385-L391) 附近，紧随 `fastModel`）。
2. `LlmConnectionSchema` 加 `visionModel: z.string().optional()`（[validators.ts:87-100](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/config/validators.ts#L87-L100)）。
3. `LlmConnectionSetup` 加 `visionModel?: string | null`（[dto.ts:619-637](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/protocol/dto.ts#L619-L637)）。
4. `SETUP_LLM_CONNECTION` handler 照 `fastModel` 分支写入（[llm-connections.ts:115-119](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/handlers/rpc/llm-connections.ts#L115-L122)）。
5. `applyLlmConnectionUpdate` 无需改（已是通用逐字段合并，`visionModel` 自动被接受、`null` 自动删键）——**但要在测试里钉住这一点**。

### 5.2 解析器

新增 `getVisionModel(connection): string | undefined`（同文件，紧随 `getMiniModel`）。语义——**只有"可用"才返回 id，其余一律 `undefined`**：

- 有 `visionModel`、该 id **在连接模型列表内**、且 `modelSupportsImages(connection, id)` 为真 → 返回它；
- 未设 / id 已不在列表 / 该模型被标 `supportsImages: false`（用户自相矛盾） → 一律 `undefined`。

三种情况合并成"没有可用识图模型"，由调用方按 D10 处理（不报错）。UI 另单独展示用户存下的原始值，并可就"选了不支持图片的模型"就地提示。（`getVisionModel` 只管 `visionModel` 这一个候选；"能不能看图"的完整判断见下面的 `resolveImageModel`。）

再往上包一层 **`resolveImageModel(connection, mainModel): string | undefined`**——**这就是"用主模型"的落点**：

- 依次取 `getVisionModel(connection)` → `getMiniModel(connection)` → **`mainModel`**（**会话当前实际用的模型**，由 `SessionManager` 的 `resolveBackendContext().resolvedModel` 给出）；取**第一个 `modelSupportsImages` 为真**的；都没有 → `undefined`。
- **`mainModel` 就是主模型**（会话没覆盖时即 `connection.defaultModel`）。所以**"主模型能看图、小模型看不了"时，链会穿过看不了图的小模型、落到主模型**——正是要让它能用的那种情况。这一层由 `SessionManager` 在连接侧算好，经 `getImageModelFn` 交给两门（§5.3 / §5.7）。

### 5.3 `call_llm` 接通图片（核心）

改 [llm-tool.ts:592-757](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/llm-tool.ts#L592-L757) 与 [buildCallLlmRequest L209-282](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/llm-tool.ts#L209-L282)：

**带图时选哪个模型（D9 / D10）**——按序取**第一个经 `modelSupportsImages` 判为"能看图"**的候选：

1. `args.model`（agent 显式指定；**按调用者信任**——工具侧拿不到连接，无法可靠校验任意 id）；
2. `visionModel`（连接的显式指定，§5.2）；
3. 连接的**小模型**（`getMiniModel(connection)`）——**它常常就落在"主模型"上**：自定义端点没有小模型时 `findSmallModel` 直接返回 `defaultModel`（§2.1）；
4. **会话当前模型**（`resolveBackendContext().resolvedModel`，= **主模型**；会话没覆盖时即 `connection.defaultModel`；小模型看不了图时退到这里）。

有一个可用 → 把图收进 `images: LLMQueryImage[]`（`data` / `mimeType` 直接就绪，`timestampMs` 不填）并 `queryFn({ …, images })`（两个 backend 已消费，§2.2）；**一个都没有 → 照旧拒绝**（今天那句「Image attachments are not supported. Use text files only.」，两处都不改）。

**于是"用主模型"自然成立**：主模型就是连接的 `defaultModel`（或小模型解析到它），在候选里；只要它能看图，`call_llm` 就用它，**不需要额外配 `visionModel`**。`visionModel` 的用途因此收窄成明确的一件：**"主模型看不了图时，另指一个能看的"**——正是 §1 的核心场景（它也是把图交给"便宜模型"省 token 的那个旋钮）。

**无图时**：模型解析与今天完全一致（Claude 侧 `args.model \|\| getDefaultSummarizationModel()`、Pi 侧交 backend 回退），**一行不改**。

**"省钱"是既有用法，不因本方案改变**：`call_llm` 的定位本就含 cost optimization。当图是 **agent 手上的文件**（截图、下载图、渲染件）时，它可以 `call_llm` 带路径去读，而不把图读进自己的上下文。**要更省就把一个便宜且能看图的模型设成 `visionModel`**（候选链会优先用它），或调用时显式传更便宜的 `model`。**不做的**是把"用户贴在输入框的图"从"能识图的主模型"转走（§1、§6）。

**`getImageModel` 回调怎么来**（与 `getQueryFn` 同形）：

- `LLMToolOptions` 增加 `getImageModel?: () => string | undefined`；`createLLMTool` 在**带图**时取 `args.model ?? options.getImageModel?.()`（得到 `undefined` 且无 `args.model` → 走 D10 拒绝）。
- 值由会话回调注册表携带（[session-scoped-tool-callback-registry.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/session-scoped-tool-callback-registry.ts) 的 `SessionScopedToolCallbacks`，新加 `getImageModelFn?`），由 `SessionManager` 经 `mergeSessionScopedToolCallbacks` 注入（与 `browserPaneFns` 同一手法），**调用时实时解析有效连接与当前模型**（会话可切换连接 / 换模型）：`() => resolveImageModel(connection, resolveBackendContext(...).resolvedModel)`——即候选 2–4 在连接侧算好（§5.2）。

**上限**：单图 5MB（已有，L454）、附件总数 20（已有，`MAX_ATTACHMENTS`）；**新增图片总字节熔断 `MAX_TOTAL_IMAGE_BYTES = 20_000_000`**（20MB，超出即拒绝并提示减图或压缩——张数与单图尺寸已有上限，这一条补"多图总量"）。

### 5.4 文本模型时保留图片路径（让 agent 接得住）

改 [runtime-config.ts `filterAttachmentsForModelInput`](file:///c:/Users/Ryan/code/craft-agents-oss/packages/server-core/src/sessions/runtime-config.ts#L121-L145)，**先看"能不能解析到能看图的模型"（`resolveImageModel(connection)`）**：

- **能**：图片**不整段丢，也不内联**，改为保留一条**"路径壳"**——保留 `type: 'image'` / `path` / `storedPath` / `name` / `mimeType` / `size`，**剥掉 `base64` 与 `thumbnailBase64`**，随 `agent.chat()` 交给 agent。
- **不能**：**维持今天的整段移除**（D10）。这条改动因此是纯增量的：解析不到能看图的模型时，输出与今天逐字节一致。

为什么"路径壳"最省：`buildSDKUserMessage` 的两个判定正好把它分开——**路径**看 `storedPath`（[claude-agent.ts:2511-2524](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/claude-agent.ts#L2511-L2524) 生成 `[Stored at: …]`），**内联**看 `base64`（[L2527-2538](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/claude-agent.ts#L2527-L2538) 只在内联分支加 image block）。剥掉 base64 后：agent 拿到路径（知道"这里有张图、在哪"），主模型既不收到图、也不会被 400。

于是 `call_llm({ attachments: [path] })` 成立：`processAttachment` 从盘上读回图片 → `images[]`（§2.2）。**验证点**：`hasBinaryAttachments`（[claude-agent.ts:1065](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/claude-agent.ts#L1065)）按 `type === 'image'` 判定、不看 `base64`，路径壳仍走 AsyncIterable 分支，需在测试里钉住它不因缺 base64 出错。

### 5.5 UI

- `CustomModelListEditor` 加第三个 `ModelPicker`（"Vision model" / 与 "Fast model" 同形：`emptyOption`、`optionNote`、`hint`）——[同 L317-338](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/components/apisetup/CustomModelListEditor.tsx#L317-L338)。
- 若选中的模型被标 `supportsImages: false`：就地提示"该模型不支持图片"（不让用户存下一个会被当作"未配"的值还蒙在鼓里，与 §5.2 一致）。
- 透传：`ApiKeyInput`（`onVisionModelChange`）、`AiSettingsPage.handleEditConnection` 回填、`submit-helpers` 提交。
- 文案键（i18n，7 locale）：照 `chat.imageWarning.*` 的形状加；en / zh-Hans 先写，其余按 [设计方案的译者约定] 留待译者。

### 5.6 让 agent 与用户知道（**仅当图会被路由给识图链时**）

三处都在"图确实会被路由"时生效——条件是**主模型看不了图** **且** `resolveImageModel(connection)` **能解析到能看图的模型**；**否则一律不动**（D8 / D10）。

1. **工具描述**：`createLLMTool` 的描述与 [`TOOL_DESCRIPTIONS`（session-tools-core）](file:///c:/Users/Ryan/code/craft-agents-oss/packages/session-tools-core/src/tool-defs.ts) 里 `call_llm` 那一段，补一句"可以带图片附件；带图且未指定模型时会用连接里能看图的模型（`visionModel` 优先）"。**不写成"要指定识图模型"**——模型由候选链自动解析（D9），agent 不该被要求知道 id。一处源、两个门。
2. **预检 banner**（`ImageSupportWarningBanner`）：
   - **图会被路由**：由父组件（`FreeFormInput`）把文案从警告改为信息条"图片将交给 <模型名> 理解"，**无动作按钮**。
   - **否则**：**完全维持现状**（今天的文案与"启用图像支持"动作一字不改）。
   - 组件本身保持 dumb，判定与两种形态由父组件给（同现状）。
3. **系统提示**：在 system prompt 里加一句"若本次图片被省略（主模型看不了图），用 `call_llm` 带上该图片路径来问"——把 D4（agent 驱动）从"希望它想到"变成"它会想到"的最小机制。**仅当图会被路由时才加**。

### 5.7 `video_tool understand` 的默认模型（同一候选链的第二消费者）

`understand` 与 `call_llm` 走**同一条 `queryLlm` 图片通道**（帧就是图片），所以"谁能看图"**只有一个定义**：`resolveImageModel`（§5.2）。两门的**候选链与链尾都相同**：

| | 显式 `model` / `--model` | 候选链 `resolveImageModel` | 链为空（谁也看不了图） |
|---|---|---|---|
| `call_llm` | 用它（信任） | 用它 | **报错 / 拒绝**（D10） |
| `video_tool understand` | 用它 | 用它 | **报错**（D11） |

`understand` 侧的链尾**由"沿用今天的小模型"改成"报错"**——这**不是**保持现状，而是**修一个 bug**：今天 `understand` 不校验模型能否看图，会把帧发给小模型、由 provider 400 回来。这与既有方案 [video-understanding-plan](file:///c:/Users/Ryan/code/craft-agents-oss/docs/video-understanding-plan.md) 的意图一致（它的 **D14：选到没有视觉能力的模型要报错说明，而不是发出去被 400**）——本方案把它落到实处。**增量加功能不等于保留 bug。**

改动（`understand` 侧）：

- **现状**：省略 `--model` 时用"会话的小模型"（帮助文本 [video-commands.ts:159](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/video-commands.ts#L159)、传 `model: undefined` 于 [L297-304](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/video-commands.ts#L297-L304)），由 backend 回退到 mini / summarization，**不校验能否看图**。
- **目标**：省略 `--model` 时取 `resolveImageModel(connection, mainModel)`；得到 id 就用它，**解析不到 → 报错**（说明要配 `visionModel`，或选一个能看图的模型），**不进 `queryLlm`**。
- **接线**：`createVideoTools` 已带 `getQueryFn`（[video-tools.ts:57-94](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/video-tools.ts#L57-L94)），按同形加一个 `getImageModel`，在 [video-commands.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/video-commands.ts) 组装 `queryLlm` 入参时 `model: model ?? imageModel`；`imageModel` 为空且未显式 `--model` → 直接返回错误。

**与既有方案的边界**：这**不触碰** [video-understanding-plan](file:///c:/Users/Ryan/code/craft-agents-oss/docs/video-understanding-plan.md) 的抽帧策略与 `--level` 路由（那里的 D14「候选池用 `modelSupportsImages` 过滤」、U7「level → 模型映射」各自独立）；这里把"省略 `--model` 时的默认值"从"小模型"改成"`resolveImageModel`，**解析不到即报错**"——正好把 D14 落到实处。`--model` 显式指定时**不变**。

---

## 6. 刻意不做

- **不做跨连接 / 跨 provider 的识图模型**：`call_llm` 走主 agent 自己的 backend / 连接（§2.2）。要让"文本模型在 A 连接、识图模型在 B 连接"成立，得给 `queryLlm` 加一条"第二连接"路由——那是另一个量级的改动，v1 明确不做。
- **不新增工具**（`image_tool` / `vision_tool`）：`call_llm` 就是那个工具（D1）。新工具等于把同一个口子开第二遍。
- **不做系统自动路由**：不"偷偷"在送模型前自动调用一次识图模型、把结果塞进上下文。路由权交给 agent（D4）——用户看得见每次 `call_llm`，也符合"会话里发生的事要可见"。
- **不做 OCR / 专用视觉流水线**：识图就是"把图交给一个多模态模型"，不引入额外的识别 / 结构化抽取管线。
- **不把 PDF / audio 纳入识图**（v1）：`call_llm` 的图片通道只认 `image/*`；PDF 是 `document` 块、audio 是另一条路，两者 Claude 与 Pi 的支持度不一致，单独再做（§7-U2）。已知的"文本模型收 PDF 可能被 400"这个同形漏洞不在本方案处理。
- **不改 `supportsImages` 的开关入口**：模型 picker 行上的图片图标（[CompactModelSelector.tsx:309](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/components/app-shell/input/CompactModelSelector.tsx#L309) 等）照旧。本方案只在**图会被路由时**把预检 banner 改成信息条（§5.6），否则 banner 一字不动；不新增第二个 `supportsImages` 开关。
- **不把 `fastModel` 拿来表示识图**（D3）。
- **不做"盲回退"链**（D12）：**允许** `visionModel → 小模型 → defaultModel` 的候选链，但每一步都过 `modelSupportsImages`；**不允许无视能力的自动回退**——那才会引入今天没有的 400。
- **不把用户贴的图从"能识图的主模型"转走**：主模型能看图时，staged 的图照旧直接进主模型（§1）。"省钱"只在"图是 agent 手上的文件"这类场景成立（§5.3），**不改 staged 路径**。

---

## 7. 已定的选择（原"开放问题"）

| 原开口 | 决定 | 理由 |
|---|---|---|
| U1 `visionModel` 未设 / 失效时 | **保持原有行为**（D10）：图照旧被移除 + 警告条、`call_llm` 照旧拒绝图片——"这条线等于不存在" | opt-in 原则（§1）：不新增失败路径；"猜一个"会引入今天没有的行为 |
| U2 PDF / audio | **v1 不纳入**，记作已知边界（§6） | 走的是与 `images` 不同的通道（document / audio），两端支持度不一致 |
| U3 图片上限 | 单图 **5MB**（沿用）、附件总数 **20**（沿用）、**总字节 20MB**（新增熔断） | 张数与单图已有上限，缺的是"多图总量"的安全熔断 |
| U4 路径引用怎么落 | **剥掉 `base64` / `thumbnailBase64` 的"路径壳"**，**且仅在能解析到能看图的模型时**才保留；否则整段移除（同今天） | 复用 `buildSDKUserMessage` 现成的两个判定（路径看 `storedPath`、内联看 `base64`），最小改动且纯增量 |
| U5 banner 形态 | **仅在能解析到能看图的模型时**改成信息条（无按钮）；否则**维持现状**一字不动 | 纯增量：不改今天任何默认界面 |
| U6 跨连接识图 | **不做**（§6） | 要动 `queryLlm` 路由，另一个量级 |
| U7 与 `fastModel` 联动 | **不联动**；同一 id 同时担任两者是允许的显式选择 | 两个下拉语义不同，强行关联只会替用户做决定 |
| U8 `video_tool` 是否用识图模型 | **是**（D11、§5.7）：省略 `--model` 时取 `resolveImageModel`；**解析不到则报错**（不再把帧发给看不了图的模型） | 修 bug（对齐 [video-understanding D14](file:///c:/Users/Ryan/code/craft-agents-oss/docs/video-understanding-plan.md)）；链尾与 `call_llm` 一致 |
| U9 回退 / 用主模型 / "能识图也走工具省钱" | **能力校验的候选链**（含主模型，D9/D12）：`visionModel → 小模型 → defaultModel`，每步过 `modelSupportsImages`；全不可用才拒绝。"省钱"作为 `call_llm` 既有用法保留：把便宜能看图的模型设为 `visionModel`，或显式 `model` | 主模型能看图就用它，自然且**零配置**；要避免的是**盲**回退。不改 staged 图路径 |

**实施前要核对的是事实、不是产品开口**（已在 §5.4 记）：文本模型下"路径壳"附件走 `hasBinaryAttachments` 分支时，不因缺 `base64` 出错——写测试钉住。

---

## 8. 验证

一条端到端闭环（用自定义端点里的"文本模型 + 视觉模型"最容易搭）：

1. 在连接里配 `defaultModel = <文本模型>`（`supportsImages: false`）、`visionModel = <视觉模型>`。
2. 会话里贴一张图，问"这张图里是什么"。
3. **主模型侧**：图被闸门省略、但 agent 拿得到它的路径；主模型不被 400。
4. **路由**：agent 调 `call_llm`，带该图路径（**不指定 `model`**）；`call_llm` 不再拒绝图片，并自动解析到识图模型。
5. **识图**：识图模型返回描述，主模型据此回答。
6. **不变性（纯增量，§1）**——以下每条都要与"改之前"逐字节一致，不出现任何新提示 / 新失败：
   - 主模型**支持**图片（无论 `visionModel` 配没配）→ 图直接进主模型，不经过识图模型；
   - 主模型不支持图片、**链上解析不到能看图的模型**（`visionModel` 未配 / 失效，且小模型与 `defaultModel` 都看不了图）→ 图被移除 + 今天的警告条；`call_llm` 传图仍返回今天的「Image attachments are not supported.」。
7. **`video_tool`**：`understand` 省略 `--model` 时用 `resolveImageModel`（§5.7）；**解析不到 → 报错**（不把帧发给看不了图的模型——修 bug，对齐 [video-understanding D14](file:///c:/Users/Ryan/code/craft-agents-oss/docs/video-understanding-plan.md)）；显式 `--model` 时不变。

---

## 9. 源码对照

| 位置 | 现状 | 本方案 |
|---|---|---|
| `packages/shared/src/config/llm-connections.ts:LlmConnection` | 有 `fastModel` | 加 `visionModel`（同形，紧随其后） |
| 同上 `getMiniModel` / `getSummarizationModel` / `findSmallModel` | 解析 fast/summarization 模型 | 加 `getVisionModel` 与 `resolveImageModel(connection, mainModel)`（候选链含**会话当前模型**；均可返回 `undefined`） |
| `packages/shared/src/config/validators.ts:LlmConnectionSchema` | 有 `fastModel` | 加 `visionModel: z.string().optional()` |
| `packages/shared/src/config/storage.ts:applyLlmConnectionUpdate` | 通用逐字段合并 | **不改**，用测试钉住 `visionModel` 的合并 / 删键 |
| `packages/shared/src/protocol/dto.ts:LlmConnectionSetup` | 有 `fastModel?` | 加 `visionModel?: string \| null` |
| `packages/server-core/src/handlers/rpc/llm-connections.ts` `SETUP_LLM_CONNECTION` | 写 `fastModel` | 照写 `visionModel` |
| `packages/shared/src/agent/llm-tool.ts:createLLMTool` | 图片附件**报错**（L697-701） | **解析到模型时**收集进 `images[]` 透传；解析不到**照旧报错** |
| 同上 `buildCallLlmRequest` | 图片附件**报错**（L228-232） | 同上（Pi 拦截路径） |
| `packages/shared/src/agent/video-tools.ts` | 只带 `getQueryFn` | 加 `getImageModel`（同形） |
| `packages/shared/src/agent/video-commands.ts` | 省略 `--model` → 交 backend 用会话小模型（**不校验能否看图**） | 省略时取 `model: model ?? imageModel`；`imageModel` 空且无 `--model` → **报错**（修 bug）；`--model` 指定时不变 |
| `packages/server-core/src/sessions/runtime-config.ts:filterAttachmentsForModelInput` | 图片整段移除 | **能解析到能看图的模型时**（`resolveImageModel`）保留"路径壳"（图仍不内联）；否则整段移除不变 |
| `packages/server-core/src/sessions/SessionManager.ts:chat(...)` 调用点 | 用过滤后的列表 + warning | 跟随 §5.4 的口径 |
| `packages/session-tools-core/src/tool-defs.ts` `call_llm` / `TOOL_DESCRIPTIONS` | 只讲文本 | 补图片用法（带图不指定模型即从候选链选能看图的模型）；**仅当图会被路由时** |
| `packages/shared/src/agent/session-scoped-tool-callback-registry.ts` | 有 `queryFn` | 加 `getImageModelFn?` |
| `packages/shared/src/agent/session-scoped-tools.ts` | 只传 `getQueryFn` | 加传 `getImageModel` |
| `packages/server-core/src/sessions/SessionManager.ts` | 合并 `browserPaneFns` 等回调 | 同处 `mergeSessionScopedToolCallbacks` 注入 `getImageModelFn`（实时解析有效连接） |
| `apps/electron/src/renderer/components/apisetup/CustomModelListEditor.tsx` | Default / Fast 两个 picker | 加 Vision picker |
| `apps/electron/src/renderer/components/app-shell/input/ImageSupportWarningBanner.tsx` | 只有"启用图像支持" | **图会被路由时**改为信息条；否则一字不动（§5.6） |
| `apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx` | 预检判定 `!modelSupportsImages` | 图会被路由时才改文案（§5.6） |
| i18n `chat.imageWarning.*`（7 locale） | title / action | 加识图信息条的键；未配时沿用现状键 |
