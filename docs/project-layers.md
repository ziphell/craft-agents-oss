# 项目分层（Goal / Spec / Plan）— 开发文档

> **定位**：本文写「这是什么、边界在哪、代码在哪、为什么这样」。用户在界面上看到的、以及给 agent 看的指南见 `apps/electron/resources/docs/layers.md`（`DOC_REFS.layers`）；用词与文案口径见 [术语与文案规范](vocabulary.md)。**整版论断（含浏览器、drawio、tweaks 与场景）见 [价值论断](value-thesis.md)。**
>
> **一句话**：需求放在**它的家**——项目文件夹——里。这是一族**模式**（`goal` / `spec` / `plan`，一次一层）的产物：目标是一份 `goal.md`，一条需求是一份 `*.spec.md`，一条方案是一份 `*.plan.md`，家都是 `{workspace}/projects/{slug}/`；入口是**会话上的一个模式选择器**，报告是**项目详情页的一个 tab**，工具只报告盘上有什么。
>
> **读法**：想知道「某个概念为什么现在没有了」看 §4 墓园。本文的前身是 `prototype-workbench-plan.md` 与 `prototype-workbench-dev.md`（已删）：原型那套整体并进了项目，当年叫「原型」的东西现在叫「需求」。

---

## 1. 定位与原则

**一句话**：把**想清楚的东西**和**为它写的文件**放在同一个文件夹里——目标、需求、方案都写在这里，人写它们，agent 在同一处写实现，工具只报告盘上有什么。

三条具体含义：

- **人写这几层**：目标是项目根上一份 `goal.md`（固定名，一份），一条需求写一份 `*.spec.md` 文件，一条方案写一份 `*.plan.md` 文件（文件名即身份，子目录也算）；`spec.md` 只是惯例的起步**索引**（本身不含需求）；旁边放材料——截图、表格、竞品地址、词汇表、旧版流程，任何格式，没有规则。
- **agent 用普通文件工具在同一文件夹里写**：没有专属运行时，没有「应用 / 执行 / 部署」这个动作，没有需要先跑起来的容器。它写的就是文件（`Write` / `Edit`）。
- **交付物就是这个文件夹本身**：人、agent、后端都能直接打开读。

**与 Pencil 的关系**：不是「替代画布」，而是另一种活。Pencil 在空白画布上无中生有，产出设计或代码；这里不生成任何可运行物，它让**需求和它的实现长在同一处**，并且随时能问出「还差什么」。

仍然成立的几条判断（改这条线时先看）：

- **一切皆文件。** 数据面就是文件夹，控制面就是 agent 自己。曾经为多 agent 并线分出的四个平面（数据 / 控制 / 业务逻辑 / 渲染）没有对象了：渲染面与业务面根本不在这个工具里。
- **约定大于配置。** 没有配置文件、没有索引文件、没有状态文件、没有 `patches/`、没有页表。全部约定就是这几样：`goal.md` 是目标、`spec.md` 是索引、`*.spec.md` 是需求、`*.plan.md` 是方案、文档之间用普通 markdown 链接。
- **不记录「谁实现了谁」。** `@requirement` 标记、覆盖关系与那条「需求没人实现」的门禁已整份删除（§4）。理由是那条判据**是认领而不是校验**——一个空文件写下标记就能让需求算「已实现」，工具只能回答「有没有人认领」。文件夹里有什么就是什么，**读的时候现算**：这是这份需求能被 agent 和人**同时**读的原因——两边看的是同一批文件。
- **报告只数事实。** 只有两档，且都能被任何人核验：**链接指向不存在的文件**（`unresolved.brokenLinks`，由 `brokenLinkNotices` 说出口），以及**图与它旁边的 `.drawio` 对不上**（`briefIssues`）。没有「检查失败」这一档，因为没有任何东西在跑检查；**读不出来的一律不算欠款**——这个工具不猜、不评分。
- **模式是一次一个（阶段）。** 目标 / 需求 / 方案是同一件工作的三层，不是可以同时打开的开关：会话上选一个模式，就只注入这一层的规则，下一个阶段再换。**同一个词干聚成一件工作**——`cart.spec.md` 与 `cart.plan.md` 是同一件事的两层，**词干就是分组键**。所以不需要 spec-kit 那种 feature 目录加指针文件：文件名本身已经分了组，多一个目录只会多一份要维护的指针。**方案是想清楚的最后一层**：分几步、做出来，交给**现有 task 系统**（`task.yaml` + kanban）；这一族**不新增 `*.tasks.md`**。
- **义务只加在产物上，不加在过程上。** 模式可以规定一份文件**该怎么写**（`boundary` 那一栏），**不能规定「探索的时候每一步都要留下什么」**。曾经那套 `research/` 落盘就死在这里：每探一步都要多写一份文件，**压力全在 agent 身上**，而产出的多半是没人回头看的**过程残渣**。**有用的留存由人触发**——人说要留，才留。（同一个死法：`findings` / 洞察，见 §4 墓园。）
- **名字相同不算身份，相对路径才是。** 需求的身份是它相对项目文件夹的路径（`cart-total.spec.md`、`docs/checkout.spec.md`），不是文件名本身：同名文件放在两个子目录里是两条需求，链接指向的也是路径。
- **文案说人话。** 给用户看的界面文案不解释机制、不用实现动词（记录 / 绑定 / 解析 / 注入 / 落盘）——判据与例子见 [术语与文案规范](vocabulary.md)。

### 1.1 为什么是这个形状（价值与代价）

改这条线时用来自查；这也是这次改造相对上一版的**净差**。

**工作流从代码搬进了约定。** 上一版每一项能力都要**实现**一次：原型有自己的根目录（`prototypes/`）、自己的工具（`prototype_tool` 的 list / create / status）、会话上的第二重绑定、自己的详情页与列表面板、自己的 RPC 组与 i18n 命名空间——想要「方案」就得再实现一套「方案」。现在只有**一个机制**（会话上的 `mode` + 一块 `<work mode="…">` 约定）和**一个基底**（项目文件夹 + 命名约定）：加一层的成本是**一个后缀常量 + 一条判据 + 一段措辞**。`goal` 与 `plan` 两层就是这么一次加上的。

**产物离开 app 仍然完整。** 没有专有格式、没有索引文件、没有指针文件、没有状态文件：`projects/<slug>/` 整个拷走仍然可读，纯 markdown + 普通链接，app 删掉也不丢东西。对照 spec-kit：它必须有 feature 目录加 `.specify/feature.json` 指针，**因为它的文件名是固定的**（`spec.md` / `plan.md` / `tasks.md` 三个都叫这个名字）；我们的后缀让**词干就是分组键**，所以指针、目录布局、注册表那一整层在这里不存在——这是「约定大于配置」相对它的省法。

**页面不会显示过期的事实。** 报告是打开时从盘上现算的（`buildWorkLayers`）：有哪些文件、哪条链接指向不存在。没有索引可以陈旧，没有「已实现」的声明会腐烂，报告里没有任何缓存字段。所以它是**一扇看着文件夹的窗**，不是**一个管着需求的库**——后者会骗人。

**边界由约定写死，产出才一致。** 三层各有硬边界（`mode-prompt.ts` 的 `boundary`）：spec 不许写怎么做、plan 不许改意图、goal 不许写细节。这是从 spec-kit 真正拿来的东西——**模板即约束**；而它的评分门（clarify / analyze / checklist 判「够不够好」）**没有拿**，理由见上面「报告只数事实」那条。**拿与不拿的完整清单见 §1.2。**

**少了一个概念。** 不用知道「原型」是什么、不用建、不用绑、不用判断自己的工作算不算「原型」；「这个项目在跟哪些原型打交道」这个问句消失了（§4）。**删掉的概念本身是收益。**

**便宜的那条活法没有被收税。** `mode` 关着则零注入、项目页不多一行、文件夹里不多一个文件：普通项目、随口一问和重流程共用同一个容器。

**代价**（都是有意的，不是没做完）：

- **不会判断「够不够好」。** 覆盖率、findings、「谁实现了谁」已整份删除——那条判据只能回答「有没有人认领」。所以链接都通时本工具**什么都不说**：「可以交出去」不是要声明的事。
- **不保证执行。** 从 `plan` 到 `task.yaml` 已有交接与来路：生成器读这份 plan 落成节点，任务也记下自己来自哪份 plan（`from`）。但它仍只保证「交接与来路」，不保证这些节点会被执行。
- **跨项目共用退化为一条链接**（`links.ts` 允许链接爬出项目文件夹），不再是 N:M 关系：够用，但语义弱了。
- **三层里缺哪一层不报警**：页面只表现为少一枚 chip，没有计数、没有「缺 plan」这类字样。
- **老数据不迁移**：盘上遗留的 `prototypes/<slug>/` 不再被读。

**三条可检验的判据**（改这条线之后自查）：

1. **加一层要改几处？** 应当只有：一个后缀常量与判据（`spec-names.ts`）、报告里的归位（`layers.ts`）、一段措辞（`mode-prompt.ts`）、页面上一枚 chip。若多出工具 / 通道 / 绑定 / 新页面，就是又走回上一版了。
2. **把 `projects/<slug>/` 整个拷到另一台机器，还能读懂吗？** 应当能。
3. **界面会不会说谎？** 绕开 app 直接改盘上的文件，重开页面即真相。

### 1.2 与 spec-kit 的关系（拿什么、不拿什么）

出处：[How Spec Kit Develops Spec Kit: An Agentic SDLC](https://github.github.io/spec-kit/guides/agentic-sdlc.html)。这份案例有用，是因为它对自己的边界说得很坦白——于是能分清哪些做法是**它的信任模型**的产物，哪些是普适的。

**拿了三样：**

- **模板即约束**（§1.1）：三层各有硬边界，产出才一致。
- **convergence 是一个动作，不是一道门禁。** 它的 SDD 收尾时会回头对一遍意图（"checking implementation against intent rather than treating the first pass as complete"）并补上漏掉的一步。我们**删掉的是它的错误形态**（覆盖率——那是认领）；正确的形态已经落在 `plan` 块里（`mode-prompt.ts` 的 `whenAsked`）：**人问「还差什么」时**，这一层不只读文件夹，还要把同词干 `spec` 要的东西与手里的步对一遍，说出哪些没有对应的步。**只在被问到时发生**——不是"写完就自查"：同一次思考看不见自己的遗漏，而每轮自查要一直交税，还会稳定产出并不存在的遗漏。答案留在对话里，**不写下来、不成数字、不记录哪份 plan 实现了哪份 spec**。只有 plan 有它，因为只有"一份产物声称覆盖另一份"时才成立（`spec` 对 `goal` 不是这种关系）。
- **源流不是证据。** 原文："Disclosure provides provenance, not a lower evidence or review bar." 记下来路（`task.yaml` 的 `from`）不因此降低任何门槛——这条措辞直接用它。

**另外两条它说清楚、我们要照做的判断：**

- **阶段是地图，不是序列。** "Stages can overlap, repeat, or be skipped." 这正是 `mode` 的语义，也再次说明「缺一层不报警」是对的：**只有存在既定序列，「缺」才成立**。
- **披露放在容器，不放在产物。** 它的 AI 披露是仓库级政策（陌生贡献者 + 公开审计才需要）；我们的对应物是**会话**（谁开的、什么模式、哪个模型）。所以 `goal.md` / `*.spec.md` / `*.plan.md` **永远不写 front-matter**（不加 `author:` / `generated-by:`）——不是不做披露，是**披露只有一个地方**；多写一份，就是一份手改文件的人不会去改的过期描述。

**明确不拿三样：**

- **assess 阶段（`go` / `needs-clarification` / `kill`）。** 它对付的是「公开仓库收到陌生人的 issue，需要一个定级的进口」；我们的输入是人自己在对话里说的话，过滤这一步没有对象——`goal.md` 本身就在回答「为什么做」。
- **bundle / preset 那套可覆盖性。** 它的 preset 是「另一种塑造核心指引的方式」；翻译到这儿就是**项目级可覆盖 `mode` 的措辞**。那等于一份项目规则与一份内置规则同时要维护，必然漂移。**除非出现真实诉求，不做。**
- **它的门密度。** 它自己给了理由："A new issue is untrusted input, not permission to run an agent." 门密是**信任模型**的产物——陌生贡献者、公开可见、需要追责；我们同机、同人，写守卫已经圈住了能写的目录。照搬别人的合规成本，是把自己的场景错认成别人的。同一段它也给了许可："A closed project with a different trust model could automate more handoffs"——所以本工具在 `plan → task` 上自动化得更多是对的，不是越界。

**一句要一起守的诚实**：它的时间线结尾写着 "the timeline shows adoption rather than measured time savings"——采纳了，但**没有度量省了多少**。本文讲价值也只写**可验证的机制事实**（例如「加一层不再需要发版实现」），**不写提效数字**。

---

## 2. 现在的形状

### 2.1 一条需求是什么

一条需求 = 一份 **`*.spec.md`** 文件，它的**首个 `#` 标题**是标题（没有标题时标题即文件名），其余是正文。大小写不敏感、**子目录也算**（`docs/checkout.spec.md` 是一条需求）。`spec.md` 是入口**索引**，不是需求——它的名字不以 `.spec.md` 结尾，所以它自己不声明任何一条需求。

另外两层同理，只是产物名不同：目标是一份固定名的 `goal.md`（项目一份），一条方案是一份 `*.plan.md`——名字即身份，一份文件一层。

什么**不是**需求：其它一切都是材料。`research/report.md`、`notes.md`、`README.md`、截图、表格、脚本——**是不是 markdown 不再是判据**，名字才是。

**没有任何东西声明「这个文件实现了哪条需求」**：文件夹里有什么就是什么，读的时候现算。

### 2.2 入口与身份

- **入口**是根目录的 `spec.md`（`SPEC_ENTRY_FILENAME`）。它在报告里**恒有一行**（即便项目还没有任何需求），紧跟在 `goal` 那一行之后，因为它就是这份说明开始的地方；它也不进「其余文件」那一列——一个文件只归一处。
- **身份**是一条需求相对项目文件夹的**路径**。四层的名字与判据都在 `spec-names.ts`：`SPEC_ENTRY_FILENAME`（`spec.md`）/ `SPEC_SUFFIX`（`.spec.md`）/ `GOAL_FILENAME`（`goal.md`）/ `PLAN_SUFFIX`（`.plan.md`），对应 `isSpecEntryFile()` / `isSpecFile()` / `isGoalFile()` / `isPlanFile()`。没有 id，因此没有「同一个 id 被两个文档定义」这回事。

**没有任何东西播下 `spec.md`**：`createProject` 只建项目文件夹、`assets/` 与 `config.json`，不写入口。一个还没有入口的项目文件夹，只是还没有入口那一行——报告里三层皆空（`goal` / `entry` / `pieces` 都为空）时页面显示空态（`projectSpecs.empty`）。

### 2.3 入口是会话上的模式（`mode`）

**一个项目被工作，不等于它被用来把工作想清楚。** 所以「现在在做哪一层」是**会话自己的**一件事，而且**一次一个**（阶段，不是可同开的开关）：

- 会话上有一个 `mode`（`Session.mode` = `'goal' | 'spec' | 'plan'`，undefined = 关），composer 里的**模式选择器**（`chat.mode` / `chat.modeOff`，三层名是 `mode.goal` / `mode.spec` / `mode.plan`；`FreeFormInput.tsx` 的 `ModeSelectorBadge`）选它。
- **这个选择器只在会话属于某个项目时才出现**（`meta.projectId` 存在）：这些文件的家人是这个项目，一个不属于任何项目的对话选它没有东西可指。
- 切换走会话命令 `setMode`（`{ type: 'setMode', mode }`，`mode` 为 `null` 即关），服务端广播 `mode_changed`，渲染层折进会话的 atom——不走 props。
- **两个 backend 都在 `session.mode != null` 时才建这一层的上下文**（`claude-agent.ts` 与 `pi-agent.ts` 的 `buildModePromptContext`），且都要求「有模式 **且** 会话绑了项目」才传。Claude 侧**首轮 pin**（`pinnedModeContext`，之后漂移只提示），Pi 侧每轮现算。
- 类型 `SessionMode` 只有一个，定义在 `packages/shared/src/sessions/types.ts`（字段的家），经 `protocol` barrel 复用，全链路不再各写一遍联合字面量。

### 2.4 `<work>` 块

选了模式后，系统提示里注入**一段** `<work mode="…" folder="…">`（`formatModeContextForPrompt`，`mode-prompt.ts`）——**只注入当前模式那一个**，三种模式不同时注入。

- 块里带两样：**当前模式**与**项目的文件夹绝对路径**（`ModePromptContext`）。文件夹就是「这些文件住在哪」的全部答案——每一层都是文件，项目自己的文件夹就是那些文件所在。这里不指第二个地方，也不要求 agent 记住任何东西：它被要求给的「还差什么」是**每次现读盘**。
- 块的公共部分是：**这个文件夹是想清楚的地方**（不是工作目录）、一条一句话的**产物约定**（后缀 / 固定名）、**边界**（这一层不许写什么）、**「还差什么」要现读文件夹再答、不许凭记忆**、**不许搬动用户的文件**、长文在 `DOC_REFS.layers`。每个模式的差异就是产物名、边界、写之前读什么，加一句「这一层在管什么」。
- 块里的规则写成规则，而不是机制的解释——这段文本读它的是模型，不是用户。
- 指南的**长文**在 `apps/electron/resources/docs/layers.md`（`DOC_REFS.layers`），块在会话里指向它。
- 路径写进属性前会转义（`escapeAttr`）：workspace 文件夹名字可以是任何东西，一个提前闭合元素的引号会把路径的其余部分当成指令塞进提示。

### 2.5 报告：项目详情页的 Specs tab

`ProjectInfoPage` 的四个 tab 之一就是 **Specs**（`tab === 'specs'`，标题 `projectSpecs.title` = "Goal, Specs & Plans" / 「目标 · 需求 · 方案」）；它**读盘**，不是 watch。

- 数据通路：`projects:layers` RPC（`RPC_CHANNELS.projects.LAYERS`）→ handler `packages/server-core/src/handlers/rpc/projects.ts` → `buildProjectLayers(workspaceRootPath, projectSlug)`；渲染层走 `window.electronAPI.getProjectLayers(...)`（`channel-map.ts`）。
- `buildProjectLayers`（`specs.ts`）= `buildWorkLayers(项目文件夹, slug)`，再过滤掉 app 自己的东西：`config.json`、`MEMORY.md`、`assets/`（`APP_OWNED`）不是作者放进去给它读的，资产 tab 也已经列过它们，**没有任何东西列两遍**。
- 列表是**三层行**，打开的都是阅读器（和全库任何 `.md` 一样，`onOpenFile`）：`goal` 一行（`goal.md`，整行可点，念标题、等宽字体跟文件名）；`entry` 一行（根 `spec.md` 索引，整行可点，按文件名显示）；其后每个**词干**一行 piece——左边念标题（`spec.title` ?? `plan.title` ?? `stem`）、等宽字体跟词干，右边按这个 piece 持有的层给出 `mode.spec` / `mode.plan` 两个按钮，各开各的文件。
- **告警只报事实**：`brokenLinkNotices` 非空时，在列表下方以 `Info_Alert` warning 出现，每行是读者语言的一句（`projectSpecNotice.<code>`）+ agent 原句，右边一个「**交给对话**」（`projectSpecs.askAgent`，走 `useAskAgent`——放进草稿、不代发）。没有断链时**什么都不显示**——「可交付」不是要声明的事。
- 报告的完整形状（`layers.ts` 的 `WorkLayers`）：`slug` / `dir` / `goal`（`{ file, title }`，或 null）/ `entry`（`FolderFile`，或 null）/ `pieces[]`（**按词干分组**：每个 piece 一个 `stem` 加可选的 `spec` / `plan`，两者都是 `LayerDocument` = `{ file, title }`）/ `files[]`（`listFiles` 递归列的其余一切，任何格式）/ `links[]` / `unresolved.brokenLinks` / `brokenLinkNotices[]` / `briefIssues[]`。

**它不做什么**（都是有意的）：不写文件、不产出交付物、不执行检查、不记历史——**跑一次看一次**，没有「上一轮」可以对比。

### 2.6 跨项目共享 = 一条普通链接

文档之间互指用**普通 markdown 链接**：`[结算流程](docs/checkout.md)`，解析顺序是**本文档所在目录 → 项目文件夹根**（`../spec.md` 也可）。**链接可以爬出文件夹**（`../other/cart.spec.md`）：另一条需求由另一边的链接指到，按磁盘解析——目标在就是，不在就不是。

- **只认相对、带扩展名的目标**（`links.ts`）。外链（`https:` / `mailto:` / `data:`）、绝对路径、`#片段`、不带扩展名的相对目标一律不管；代码段与 fence 里的不算链接（那是例子）。
- **图片不算链接**（`![…](…)` 是画，不是指向另一份文档）。
- **链不到就报**：留在列表里作 `to: null`，由报告说出口（`gate.linkBroken`），不在 `links` 里再说一遍。
- 反链是读的另一半：一条链接同时是 `from` 的出口和 `to` 的入口，所以「指向谁 / 谁指来」不用读第二遍。
- **链接只负责导航**：它不声称任何东西存在，一个段落链了一份文档并不因此说了什么关于工作的事实。

### 2.7 写守卫放行项目文件夹

Explore / safe 模式下 `Write` / `Edit` 的边界是**计划夹、数据夹、以及会话所属项目的文件夹**（`mode-manager.ts`）：`projectFolderPath` 由 `resolveBoundProjectFolderPath(workspaceRootPath, session.projectId, …)` 解析（`base-agent.ts`），走的是**和 spec 提示块同一个加载器**——提示里说的文件夹和守卫放行的文件夹不可能有两个答案。

项目文件夹在豁免里，是因为**它正是需求被写的地方**：人已经把这件事打开了，Explore 模式不该横在 agent 和那个「就是需求本身」的文件之间。（这条与 allowedWritePaths 是两组判据，互不替代。）

---

## 3. 模块地图（代码在哪）

### 共享层 `packages/shared/src/projects/`

一层文件（目标 / 需求 / 方案）的读写全在这几个模块里；项目本身的存储（`config.json` / `MEMORY.md` / `assets/`）也在同一目录。

| 文件 | 负责 |
|---|---|
| `spec-names.ts` | `SPEC_ENTRY_FILENAME`（`spec.md`）、`SPEC_SUFFIX`（`.spec.md`）、`GOAL_FILENAME`（`goal.md`）、`PLAN_SUFFIX`（`.plan.md`）与 `isSpecEntryFile` / `isSpecFile` / `isGoalFile` / `isPlanFile` 四个判据。**零依赖**（一个 import 都没有，刻意的）——它是 spec 家族里**渲染层可以取值的**那一个模块，从这里取值不会把 barrel 拖进浏览器包；规矩见 [渲染层的导入边界](renderer-imports.md) |
| `files.ts` | `listFiles()`（**递归**列出文件夹内文件，任何格式、不做任何过滤、名字是文件夹相对路径；只跳过隐藏项）、`isMarkdownFile()` |
| `spec-docs.ts` | 解析：`readSpecDocuments()` 扫全部 `*.spec.md`；`parseSpecDocument()` 取首个 `#` 标题为标题、其余为正文；`specEntryPath()` |
| `links.ts` | `readSpecLinks()` / `extractLinkTargets()`——只读 markdown 里**相对、带扩展名**的链接目标（跳代码段 / fence、跳图片），按「本文档目录 → 文件夹根」解析（`..` 保留、可爬出文件夹）；链不到留在列表里作 `to: null`，**由报告去说** |
| `notices.ts` | `notice()` / `rawNotice()`——可翻译的 notice：`code` + `params` + 由同一组 params 生成的**英文句**（agent 输出与页面共读）。code 有 `gate.linkBroken`（断链）、`diagram.stale`（图与源对不上）、`raw` |
| `layers.ts` | 报告：`buildWorkLayers()` + `WorkLayers` / `LayerDocument`；把目标、入口、**按词干分组的层**、链接、文件拼成一份现算的报告，`unresolved.brokenLinks` 与 `briefIssues` 分开（一个文件/一条事实只说一次），`brokenLinkNotices` 在这里算好、随事实一起走 |
| `specs.ts` | 项目侧入口：`buildProjectLayers()`（= `buildWorkLayers` + 过滤 `config.json` / `MEMORY.md` / `assets/`），并把解析层与 `WorkLayers` / `LayerDocument` re-export 出去 |
| `mode-prompt.ts` | `formatModeContextForPrompt()`——`<work mode="…" folder="…">` 块，按模式参数化；`ModePromptContext`（`mode: SessionMode` + `folderPath`） |
| `storage.ts` / `types.ts` / `index.ts` | 项目本身：路径构造、`config.json` / `MEMORY.md` 读写、CRUD、资产；`types.ts` 是项目形状（同样零 import），`index.ts` 是 barrel |

### agent 面

- `packages/shared/src/prompts/system.ts`：`modeBlock` 的位置（`formatModeContextForPrompt(modeContext)`），以及它为什么和 `<project_context>` 分开——**项目被工作 ≠ 项目被用来把工作想清楚**。
- `packages/shared/src/agent/claude-agent.ts`（首轮 pin `pinnedModeContext`）、`packages/shared/src/agent/pi-agent.ts`（每轮 `buildModePromptContext`）：两个 backend 各自把 `session.mode != null` 变成一个 `ModePromptContext`（只在这两者都齐时传）。
- `packages/shared/src/agent/mode-manager.ts`：写守卫放行 `projectFolderPath`（§2.7）。
- 指南：`apps/electron/resources/docs/layers.md`（`DOC_REFS.layers`）。
- **没有 agent 工具**：写 spec 就是 `Write` / `Edit`，没有 `prototype_tool`，也没有替代它的门（§4）。

### RPC 与渲染层

- 通道：`packages/shared/src/protocol/channels.ts` 的 `projects.LAYERS`（`projects:layers`）；handler `packages/server-core/src/handlers/rpc/projects.ts`。
- 监听**项目树**：`packages/server-core/src/handlers/rpc/project-files.ts`（`projects:watchFiles` / `unwatchFiles` / `filesChanged`，递归 `fs.watch` + 100ms 去抖）；渲染层经 `packages/ui/src/hooks/useProjectFilesWatch.ts`（`useFileWriter`、`MarkdownDrawioBlock` 用它跟随外部改动）。
- 页面：`apps/electron/src/renderer/pages/ProjectInfoPage.tsx` 的 Specs tab；`projects:layers` 由 `window.electronAPI.getProjectLayers(...)` 桥过去（`apps/electron/src/transport/channel-map.ts`）。
- i18n：`projectSpecs.*`（tab 标题、hint、空态、`askAgent`）与 `projectSpecNotice.<code>`（notice 的读者语言句）；模式选择器是 `chat.mode` / `chat.modeTooltip` / `chat.modeOff`，三层名是 `mode.goal` / `mode.spec` / `mode.plan`。

---

## 4. 墓园（这次退场的，与当时的名字）

这些名字**现在都不在代码里**，别再按它们讨论设计；只回答「当初是什么、为什么删」。名字照原样保留——墓园记录的是当时真实的名字，改名等于写错历史。

| 机制（当时的名字） | 曾经是什么 | 为什么删 | 现在怎么做 |
|---|---|---|---|
| **`specMode` 布尔开关 + `setSpecMode` / `spec_mode_changed` + `<specs>` 块**（`Session.specMode`、`SpecModeBadge`、`formatSpecContextForPrompt` / `SpecPromptContext` / `spec-prompt.ts`） | 会话上一个「这个对话在谈需求」的开 / 关，打开就往系统提示注入一段 `<specs>` 规则块 | 把「把工作想清楚」压成了一个开关，只能表达「在谈需求 / 不在」；而这件事本是一族分层的**阶段**（目标 / 需求 / 方案），一层管一段、一次只该有一个——一个布尔装不下 | 会话上的 `mode`（`'goal' \| 'spec' \| 'plan'`，undefined = 关，见 §2.3）：命令 `setMode`、广播 `mode_changed`、块 `<work mode="…">`（§2.4）；`formatSpecContextForPrompt` / `SpecPromptContext` / `spec-prompt.ts` 一并改名 |
| **`prototype_tool`**（更早是 `browser_tool` 的 `prototype-*` 子命令） | 把原型命令装成的一扇门（`list` / `create` / `status` 等） | 原型这个对象并进项目后不存在了，也就没有它的命令；写文件本来就是 `Write` | **没有替代工具**：写 spec 就是 `Write` / `Edit` |
| **会话绑定 `prototypeSlug` + `<prototype_context>`**（`buildPrototypePromptContext` / `formatPrototypeContextForPrompt`） | 一个对话绑到一个原型，系统提示注入它的快照，命令因此不用背 slug | 「需求的家是谁」和「这个对话要不要谈需求」是两件事；绑定把它们压成一个，还要求先有「原型」这个对象——而同一个原型常被多个项目的对话使用 | 家 = 会话所属项目（`Session.projectId` → 项目文件夹）；现在做哪一层 = 会话自己的 `mode`（§2.3） |
| **`prototypeSlugs` / `<project_prototypes>`**（`ProjectConfig.prototypeSlugs`、`project-link.ts`） | 项目侧记「这个项目碰过哪些原型」，背景信息，不绑定 | 「这个项目有哪些原型」不是该问的问题；原型也不记自己属于谁 | 项目文件夹本身就是答案（报告读它） |
| **原型页面 / 面板 / 选择器 / 侧边栏项**（`PrototypeInfoPage`、`PrototypesListPanel`、`CreatePrototypeDialog`、`CompactPrototypeSelector`、侧边栏的原型列表与复制 / 删除对话框） | 原型的浏览与增删界面 | 没有独立对象需要一套页面：需求的家人是项目、入口是会话上的模式、报告是项目页的一个 tab | 项目详情页的 **Specs tab**（`ProjectInfoPage`） |
| **`prototypes:*` 原通道**（`list` / `create` / `duplicate` / `delete` / `watch` / `unwatch` / `changed`） | 界面驱动原型文件夹的读写与监听 | 与上面的界面一起退场；监听的对象从「原型目录」换成「项目树」 | `projects:layers`（读报告）、`projects:watchFiles` / `unwatchFiles` / `filesChanged`（监听） |
| **`usePrototypeFileWatch`** | 渲染层跟随原型目录的外部改动 | 监听对象换成项目树 | `useProjectFilesWatch`（`packages/ui/src/hooks/`） |
| **`@requirement` 标记 + `coverage.ts`**（`extractRequirementIds`、`status.unresolved.unmet`、`gate.requirementUnmet`） | 让工具能回答「哪条需求没人实现」——需求 ↔ 实现的线写在文件里（不存第二份） | **它是「认领」而不是「校验」**：一个空文件写下标记就能让需求算「已实现」，工具只能回答「有没有人认领」，回答不了「做得对不对」；而唯一能补偿它的 `reviews/`（下一行）也删了，于是只剩做这份工作的人自己盖章 | 不记录实现关系；报告盘上有什么：需求、它旁边的文件、断链 |
| **`reviews/` 异议**（`reviews.ts`、`D-00x` 文件、`about:` / `on:` 指纹、`status.reviews`、`requirements[].disputes`） | 让「有人不同意」不随窗口关掉而消失（异议是一条常驻记录） | **唯一的写者就是做这份工作的 agent**：指南把「argue with it」排在构建之后，于是作者提、作者答，是自问自答而非第二个声音；机制里最要紧的两件只有**别人**提异议时才成立 | 拿不准的回对话里说，或写进 spec 正文。任务图里的 **critic 节点保留**，但不再写文件——它读需求与报告，把异议作为节点自己的 `verdict` / `objections` 输出 |
| **findings / `research/`** | 曾经有专门的「调研结论」产物档（`findings`，以及 `research/` 里那类专门文件），好像调研要落在一种特定的记录里 | 材料就是文件，没有类别：是不是 markdown、叫什么名字、放在哪个子目录，都不构成一档；`@requirement` 那套认领删掉后，更没有谁需要「按类别读」。**还有一层理由**：它对**过程**设了义务——每探一步都要多留一份文件，压力全在 agent 身上，而留存真正有用的时候是**人**开口要的那一次（§1「义务只加在产物上」） | 就写普通文件（`research/report.md`、`notes.md` 之类）；报告按 `files` 原样列出来 |
| **旧门禁命名 `whyPrototypeIsNotSettled` / `settleBlockers`** | 公开的门禁函数与它的 blocker 列表（页面与列表读它） | 收敛成报告自带的一小段：只有「链接指向不存在的文件」这一个事实，且只在页面上说出口 | 私有 + 改名：`brokenLinkNotices`（`layers.ts`），页面上只画这一段 |
| **旧模块家族 `packages/shared/src/prototypes/`**（`types.ts` / `storage.ts` / `spec.ts` / `links.ts` / `status.ts` / `notices.ts` / `prompt.ts` / `project-link.ts` / `create.ts` / `duplicate.ts` / `delete.ts` / `index.ts`；`PROTOTYPE_ENTRY_FILENAME` / `PROTOTYPE_SPEC_SUFFIX` / `readPrototypeSpecs` / `listPrototypeFiles` / `buildPrototypeStatus` …） | 「原型」这个独立对象的整套模块与常量 | 整目录删除（`package.json` 的 `./prototypes` 导出子路径也删了）：需求的家是项目文件夹，读写、解析、报告、提示块都并进**项目**家族 | `packages/shared/src/projects/`：`spec-names.ts` / `files.ts` / `spec-docs.ts` / `links.ts` / `notices.ts` / `layers.ts` / `specs.ts` / `mode-prompt.ts`；常量改名 `SPEC_ENTRY_FILENAME` / `SPEC_SUFFIX`（三层定型后又加了 `GOAL_FILENAME` / `PLAN_SUFFIX`） |

> 更早的一批（补丁层、页、原型宿主、mock、契约、验收、交付物、写归属与写守卫、项目指定「当前原型」…）在上一轮就已删除，留在 git 历史里；它们和本轮退场无关，不在本文记录。

---

## 5. 迁移说明

老文件夹 `{workspace}/prototypes/<slug>/` **不迁移、不读取、忽略**——它不在 `projects/` 下，报告不看它，应用里也没有入口指向它。要保留的需求，把 `*.spec.md` 手动放进对应项目的文件夹（`{workspace}/projects/{slug}/`）即可：一条需求就是一份文件，放进去，它就在报告里了。

---

## 6. 验证

- `bun test packages/shared/src/projects`：列表与递归、`*.spec.md` 的解析（多文件 / 子目录 / 无标题）、链接目标的提取与路径解析（跳代码段与图片、可爬出文件夹）、报告与门禁（只收断链）、图与源对不上、`<work>` 块的渲染（三个模式各自的产物约定 / 边界 / 转义，`mode-prompt.test.ts`）。
- 端到端就一条闭环（跑一遍就够）：
  1. 打开一个**属于某个项目**的对话，在 composer 的**模式选择器**里选 **Spec**；
  2. 让 agent 把每条需求各写一份 `*.spec.md`（两条需求即两个文件）——写的是普通文件（`Write`）；
  3. 项目详情页的 **Specs** tab 应把它们各列成一件工作（标题 + 词干，右边一个「需求」按钮），点开按钮在阅读器里打开；
  4. 在 `spec.md` 里写一个指向不存在文档的链接 → 页面上点名它（`projectSpecNotice.gate.linkBroken`），旁边是「交给对话」。
- 边界也要对：需求 = 名字以 `.spec.md` 结尾的文件（一个或多个、含子目录，大小写不敏感）；根 `goal.md`、根 `spec.md` 与 `*.plan.md` 各自在 `goal` / `entry` / `pieces` 里，不在 `files`；其余任何文件（`research/report.md`、`notes.md`、截图、脚本…）都进 `files`。
