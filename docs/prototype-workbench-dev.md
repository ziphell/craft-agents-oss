# 产品经理需求生产工作台 — 开发文档

> **定位**：[实施方案](prototype-workbench-plan.md) 写「是什么、为什么这样做」（产品结构、决策、验收）；本文写「实际怎么落地的」——模块地图、实现与初稿的偏差、踩过的坑、删过的机制、以及验证基线。
>
> 读法：改代码前先看 §1（代码在哪）与 §5（怎么验证）；想知道「某个概念为什么现在没有了」看 §4。

---

## 1. 模块地图

### 共享层 `packages/shared/src/prototypes/`

| 文件 | 负责 |
|---|---|
| `types.ts` | **零依赖**的类型与常量（`PageKind`、`DEFAULT_PAGE_KIND`、提升用的页名 `LEGACY_BASE_PAGE_NAME` / `LEGACY_ENTRY_PAGE_NAME`、`_layout.html` 与它的插槽、带 `page` 的 `PrototypePatch` 与 `PrototypeWindowDescriptor`）。**这里的"零依赖"是硬约束**，见 §3.6 |
| `config.ts` | `config.json`（页表 `pages`）的读写与规范化；旧形状（顶层 `kind` / `targetUrl`）**读时提升**成行（`legacyPageRows`）；读不干净的条目丢弃进 `pageIssues`，该字段永不写回。页行的 `useLayout: false` = 共享布局不套这一页（§19.2）；`true` 是默认、从不落盘，写在 overlay 行上是没有读者可兑现的声明（报进 `pageIssues`） |
| `storage.ts` | 路径工具（含 `getPrototypeAnchorsPath`）+ `scanPrototypePatches()`（**派生索引**，不落盘；补丁的页域就是目录——根 = 每页都重放、`patches/<页名>/` = 只那一页；顺序 = **`Z` 按规则排最后**，再按序号 → 路径——写入者前缀是身份，不是排序键）+ `scanPrototypePatchesForPage()` / `listPrototypePatchPages()` + `listPrototypeFiles()`（原型自己目录里**有哪些文件**，入口单独挑出来；**不按任何条件过滤**——不按扩展名、也不按所有权，见 §20.1） |
| `pages.ts` | 页的判定与页表合并（`isPrototypePagePath` / `describePrototypePages` / `listPrototypePages` / `findEntryPage` / `matchPrototypePage`；解析出的页带 `useLayout` —— 共享布局是否套这一页，overlay 恒为 false，因为它不是我们的文档）与页表增删改（`updatePrototypePages`：add / remove / rename / entry / layout，命令面是 `pages --add` / `--remove` / `--rename` / `--change` / `--layout` / `--no-layout` 与 `entry`；行上的 `useLayout` 在每次改写中原样带走） |
| `page-document.ts` | 生成的**页索引**（`buildPrototypeIndexDocument`：`/` 没有入口时的落点，也是导出包的 options 页）与**共享布局**（`applyPrototypeLayout`：`_layout.html` 的单插槽，纯文本替换第一次出现） |
| `patch-script.ts` | `buildPatchInitScript()`：patch → init script 的纯变换（live 注入与导出共用，见 §3.4）；外加**每个补丁的自我报告**——css 报 `@target` 命中了几个元素、js 报有没有抛错，写进 `window.__craft_patch_state__`，由 `buildPatchStateProbeScript()` 读回；宿主页的 css 是纯文本内联、没有脚本可报，所以另有一个批量记录脚本（`buildPatchMatchRecorderScript`，只对声明了 `@target` 的补丁生成） |
| `patch-header.ts` | 标记解析（`@requirement` / `@target`），**零依赖**：`storage.ts`（补丁记录）与 `requirements.ts`（需求线）都要用它，而后者已经依赖 storage |
| `anchors.ts` | **虚拟 base**（§21.2）：`anchors/<页名\|shared>.json` 的读/合并写、漂移与孤儿判定、`dropPrototypeAnchors`，以及两个页面探针（`buildAnchorProbeScript` 取 fingerprint / `buildAnchorCandidateScript` 取候选选择器） |
| `fold.ts` | **折叠**（§21.3）：`foldPrototype()` 把差量层折进它该在的地方——scratch 页 → `assets/<页名>/committed.*` + 文档里的引用；overlay 页 → `patches/<页名>/Z-00x-upper.*`。含 provenance 标记、拒绝（文档不在）与"没人检查过"的报告。**唯一调用者是 `duplicate.ts`**：折叠发生在复制出的副本上（`{ fold: true }`），命令面与导出都不折 |
| `edit-patch.ts` | **一次保存 → 一条差量**（§21.6）：`writePrototypeEdits()` 把窗口里攒下的那批编辑写成 `patches/[<页名>/]ui-<nnn>-<name>.{css\|js}`——写者身份固定为 `ui`（`Z` 是折叠层保留的），序号取**全原型已有最大序号 + 1**（排序只认序号、写者不是排序键，所以一次要盖在已有补丁之上的编辑必须排在它们后面），`@target` 逐条去重写进头部，样式**按编辑顺序**逐条落规则（后写的赢，和会话里看到的一致）；样式 + 文字同时有就是**同号两个文件**（css 先于 js）。**不 apply**：文件才是让改动生效的东西，watcher 会把它重放进每个在显示这个原型的窗口 |
| `export.ts` | `buildSelfContainedHtml()`（渲染与导出共用的那一个变换，补丁按页取）、`buildDevSpec()`（**按页分节**）、`resolvePrototypeEntry()`（入口页或生成的页索引）、`exportPrototype()`（**四份产物**：`dist/extension/` 一个扩展覆盖整条流程 ＋ `dist/static/` 每页一份自包含文件（§17.8）＋ `dist/bookmarklet.html` live 页的书签（§17.9）＋ `dist/handoff.md` **交付索引**（§20.8），由 `buildHandoff()` **最后**写：表只从写盘时刻的 `dist/` 列表（`listDistNames()`）生成，末节抄 `buildPrototypeStatus().settleBlockers`）。静态那一半的纯变换是 `buildStaticPage()`（补丁按页取 → `buildSelfContainedHtml`，mock 内联在 `<head>` 开头）＋ `inlineLocalReferences()` / `buildStaticAssetResolver()`（本原型目录内的引用 → base64 data URL；**页面文档除外**，它是同目录的兄弟文件）；解析不到的引用点名进 `staticWarnings`，与扩展侧的 `warnings` 分开。`assets/` 走 `collectAssetFiles()` 按字节整份进扩展包。一次导出共用一个 `builtAt` 与一次 `collectMockRoutes()` |
| `extension.ts` | 交付物打包：manifest / README / 匹配模式 / 版本号 / 页面变换（内联脚本与 `on<event>` 提取）/ mock 编译 / **按页分文件**（每页自己的 css·js 列表与 `assets/<页名>/`；options 页 = 页索引，工具栏图标开入口页）。`ExtensionFile.content` 是 `string \| Uint8Array`：这个文件生成的产物都是文本，原型自己的资源按字节进包（`export.ts:collectAssetFiles`，不做 utf-8 往返）。`patchesForPage()` 是"这一页带哪些补丁"（§19.4）的**唯一**表述，三个读者：扩展的 css 链接、扩展的 js bundle、书签 |
| `bookmarklet.ts` | **第三种载体**（§17.9）：`buildBookmarkletScript()` = mock 层 + `buildPatchBundle()`（与扩展同一份 bundle，含 css——扩展把 css 交给 Chrome 当样式表，书签没有这一步）；`buildBookmarkletDocument()` 生成 `dist/bookmarklet.html`：**一页一条可拖拽链接**（书签没有被地址作用域的能力，所以按页命名、地址印在旁边，而不是一条通吃后按 URL 挑）＋同一份代码供控制台粘贴（页面策略拒绝书签时的那条路），并在页面里写明这个载体做不到什么 |
| `status.ts` | 只读全貌（`buildPrototypeStatus` / `listPrototypeStatuses`）：页表 + `entryPage` + `pageIssues` + `pageAvailable` + **需求线**（`requirements` 的引用关系 + `entryDocument` 是哪个文件 / `files` 是旁边的哪些文件，都是**路径**）+ 按页/共享补丁计数 + **每条补丁的标记**（页 / `@target` / 指纹）+ **锚点记录**与它的孤儿点名 + `reviews`（按状态计数与仍站着的那些）+ `acceptance`（上一轮）+ `unresolved`（三类未决）。另有闸门函数 `whyPrototypeIsNotSettled`——一处规则、三个读者（status 输出 / export 点名 / export `--strict` 拒绝） |
| `notices.ts` | 报告里"哪里不对"的一条：`code` + `params`（渲染侧按 `prototypeNotice.<code>` 翻译）+ `text`（**与 agent 输出逐字相同的那句英文**，由同一份模板从同一组 params 生成）。只有"人能行动、且是结论"的条目编了码（门禁五条 / 页表两条 / 需求两条 / 锚点一条）；文件级诊断（一行配置读不出来、review 没有 `claim:`）走 `rawNotice` 保留原文。`status.ts` 的 `pageIssues` / `briefIssues` / `settleBlockers` 与 `anchors.issues` 都是它的数组，agent 侧与 `dist/handoff.md` 读 `text` |
| `reviews.ts` | **争论**（§3.7）：`reviews/*.md` 的解析与读取——一条异议一文件，`# D-001 …` 头 + `about:` / `on:` / `status:` / `claim:` / `evidence:`。状态与盘对账：`open` 而补丁已变 → `stale`，`fixed` 而补丁没变 → 同样 `stale`；判据是 `on:`（补丁指纹，`storage.ts:patchFingerprint`）。`about:` 的四种写法由 `parseReviewTarget` 认，其余不猜 |
| `acceptance.ts` | **跨轮验收**（§3.7）：`acceptance/state.json` 的读写（`tooling`，只有 `verify` 写）+ `compareAcceptance`（一轮 vs 上一轮 → `newRed / stillRed / fixed / notRun / gone`）+ `summarizeAcceptance`。轮次由"真的跑过一次"产生，不是版本号 |
| `prompt.ts` | `<prototype_context slug writer>` 的构造与渲染：**这个会话以谁的身份写**、页列表（名字 / 类型 / 地址或文件 / 是否入口）、每条补丁的页域 / `@target` / 指纹（异议的 `on:` 就抄它）、写补丁的规矩（前缀 = 你的身份）、**`reviews/` 的写法与仍在站着的异议**、**上一轮验收与它的红**、以及"复制时可以折叠改动"这件事（折的是副本，原件不动、继续照常写补丁） |
| `ownership.ts` | 所有权是 **路径 → 拥有者** 的函数，但**只登记有规矩的路径**（§3.5）：`patches/`（writer 在文件名里）、`services/`（路径规则）、`anchors/**` 与 `acceptance/**`（工具的记录），**其余一律默认控制面**——原型目录首先是作者自己的文件夹，枚举它的形状等于维护一份必然过期的副本。四个函数：`classifyPrototypePath`（谁拥有）+ `canWriterWrite`（严格原语）+ `whyWriterMayNotWrite`（**执行的那条**：他人的产物、工具记录、服务目录里的杂文件拒；控制面放行）+ `resolvePrototypeArtifactPath`（绝对路径 → `prototypes/<slug>/…`）。`Z` 是保留 token（只有折叠会写），见 §3.6 |
| `contract.ts` | 契约 fragment 解析与合成、`buildMockRoutes()`；`services/{svc}/state.json` 的读取（`readState`，坏了要**上报**而不是当成"没有"）与 `x-mock-collection` 的解析（集合挂在**路径项**上，一个方法一个 op） |
| `mock-engine.ts` | **mock 的状态机**（§5.3）：`describeMockOperation`（方法 → op，表达不了就报 problem）、`matchMockRoute`（pathname 匹配 + 尾部回退，**两个载体共用的唯一匹配规则**）、`readMockPath` / `writeMockPath`（点路径读写 store）、`applyMockRequest`（五条 op 的全部语义，**答案必须是快照**）、`parseMockRequestBody`（JSON / 表单 / 读不出）、`mergeMockStores`（多服务的 store 合并与冲突）。**类型 `MockRoute` / `MockProgram` 也住在这里**，`contract.ts` 只 re-export —— 语义与它读的形状放在一起，避免 contract ↔ engine 的运行时环 |
| `url.ts` | `prototypeOriginUrl` / `prototypeDocumentUrl` / `setPrototypeBaseUrlResolver` |
| `target.ts` | `requireTargetUrl` / `pickOverlayPage` / `setPrototypePageUrl`（改**某一页** overlay 的地址） |
| `project-link.ts` | **项目在哪些原型上工作**（`ProjectConfig.prototypeSlugs`，§15.1.3）：`getProjectPrototypes` / `setProjectPrototypes`（**集合**读写；不存在的原型被**过滤掉而不是报错**，读取端对同一种情况也回答"没有"，两端一致；**不**校验归属，因为原型不属于任何项目）。它是**背景信息**：只进 `<project_prototypes>` 那一列，**不产生任何解析**、不注入任何原型的上下文、不进默认 slug。原型侧**没有** `projectSlug` 了（那条边与"成员资格"在 §15.1.4 撤回），所以这个文件里既没有成员列表，也没有"替会话挑一个"的代码 |
| `requirements.ts` | **需求**（§20.1）：`PROTOTYPE_PRD_FILENAME` = `PRD.md`、`getPrototypePrdPath`、`parsePrototypePrd`、`readPrototypeRequirements`。解析**只读这一个文件**：`## R-001 …` 条目与 `check:` 行（`selector` / `endpoint`，其余 kind 在解析期就报错）；token 与 finding / 异议共用宽容写法。只认大写 `PRD.md`——手写的 `prd.md` 只是文件夹里的一份材料，不是第二个入口。"这个目录里有哪些文件"由 `storage.ts:listPrototypeFiles` 回答，这个文件不管 |
| `coverage.ts` | **需求线**：`resolveRequirementCoverage()` 把 PRD 与页 / 补丁 / findings / 折入文件对上，产出 `unmet` / 悬空引用 / 每条需求的 `disputes`。`status` 与 `dist/dev-spec.md` 读的是同一份结果 |
| `research.ts` | `research/*.md` 的 finding（`# F-001` + `claim:` / `source:` / `captured:` / `evidence:` / `requirements:`）与其 `evidence:` 的存在性检查 |
| `frames.ts` | 帧采集的记录与读回：`research/frames/<session>/frames.json` + 编号 JPEG、`research/videos/` 的来源副本、`listFrameCaptures` |
| `create.ts` / `duplicate.ts` / `delete.ts` | 创建（只建目录与 `patches/`，不写 `config.json`、不预置页、**不预置布局**）、写页文档（`writePrototypePage`）、读页文档与 `_layout.html`、复制（`config.json` 按源的页表重写；`{ fold: true }` 时连副本一起折）、删除（目录整份删掉，**不**去改别的原型） |
| `index.ts` | barrel。**渲染层只能对它 `import type`**，见 §3.6 |

### agent 侧

- **两个工具各自一份文件**（§2 的 3.6 行）：`browser-pane.ts`（`BrowserPaneFns` 能力接口 + `BrowserPaneToolOptions` + 两个工厂都要的 `requireBrowserPaneFns`）、`browser-tools.ts`（`createBrowserTools` + `BROWSER_TOOL_DESCRIPTION`）、`prototype-tools.ts`（`createPrototypeTools` + `PROTOTYPE_TOOL_DESCRIPTION`）。**一份描述对一个工具**：浏览器那份只讲窗口自己的能力，原型那份讲它怎么用**文件**，窗口只留一句指向 `browser_tool`——窗口与标签页那段一度两份里各写一遍（常驻上下文，重复是双倍代价），已收敛：讲全只留浏览器那份，撞名的澄清也只留浏览器描述与原型 help 各一次。
- `packages/shared/src/agent/command-cli.ts`：**两门共用的 CLI，不知道任何一扇门**。里面是分词与引号转义、`--tab` 定位、选项解析、`--file` 路径解析、结果形状（`BrowserCommandResult` / `getPageMetrics`）、命令上下文，以及 `createCommandRunner({ help, run, unknownCommand })`——"跑一条命令"的骨架只写一份，门把它自己的三件事（help / 命令表 / 不认领时的措辞）传进来。入口 `executeBrowserToolCommand` / `executePrototypeToolCommand` 都在**各自的门文件里**（批量与"一条一调"的分野也在那里）。依赖因此是单向的：`browser-commands.ts`、`prototype-commands.ts` → `command-cli.ts`，反向没有 import（早先两边互相 import，靠都在函数体内引用才没炸）。**门自己的 runtime 也不在这里**——批量（`splitBatchCommands` / `executeBatchCommands` / 导航后停）、`evaluate --file` 的读取与大小上限、`open` 等的 settle 时长，都归 `browser-commands.ts`（只有这门有）；解析器的报错也不点名某个工具（共享层曾写死 `browser_tool`，原型命令的引号打错会被告知是浏览器的语法错）。
- `packages/shared/src/agent/browser-commands.ts` / `prototype-commands.ts`：两条门的**命令体**——`runBrowserCommand(ctx)` / `runPrototypeCommand(ctx)`，各自不认领就回 `null`。输出文案（页表命令 `pages`（`--add` / `--rename` / `--remove` / `--change`）/ `entry`、`open` 的落点选择、`apply` 报出"这是哪一页的补丁"）都在各自那份里。**新增命令要同时改对应的命令体 + 那份 help 列表**。
- `packages/shared/src/prompts/system.ts`：`<project_context>` 的渲染，含 **`<project_prototypes>`**——项目记下的"在哪些原型上工作"（§15.1.3），是**背景**：由它产生的自动行为是零（不注入原型的 `<prototype_context>`、不注入指南、不进默认 slug）。**是一列，不是"当前原型"**：项目同时在几个原型上工作是常态，没有哪一个在前。新块名要加进 `PROJECT_BLOCK_TAGS`，否则 slug 里的字面闭合标签会提前终止这个块。
- `packages/shared/src/agent/core/pre-tool-use.ts`：写前守卫（第 5d 步）——写工具落在 `prototypes/<slug>/…` 时（`resolvePrototypeArtifactPath`）按会话的写入身份判 `whyWriterMayNotWrite`，越界即拒并**给出理由**。身份由两个 backend 各自从 `resolvePrototypeWriter(config.session)` 传进来（`claude-agent.ts` / `pi-agent.ts`），与 `<prototype_context writer>` 同源，见 §3.6。

### 服务端 / 主进程

- `packages/server-core/src/sessions/SessionManager.ts`：把 `BrowserPaneFns` 装配到真实实现；`describePrototypeAtPage` 给 `snapshot` 补原型行（slug、页的类型与页名、原型自己的地址）。
- `packages/server-core/src/domain/verify-prototype.ts`：跑 PRD 的 `check:` 行——`endpoint` 对契约（**不需要浏览器**），`selector` 对"这次工作所在的那个标签页"，读不到页面时是 `skip` 而不是 `fail`（"没看成"与"不在"是两件事）。每跑一次写一轮 `acceptance/state.json` 与 `dist/acceptance.md`，报告里说**与上一轮的差**（新红 / 仍红 / 不再被看 / 已修 / 不再声明）。测试见 `__tests__/verify-prototype.test.ts`（页面那一半用桩 `evaluate`，不开窗口）。
- `packages/server-core/src/domain/apply-prototype.ts`：把补丁注入浏览器——只注入**调用方指名的那个标签页**的补丁（`matchPrototypePage` → 入口页 → 只有共享补丁，并把这个页名报回去；标签页由 `PrototypeTargetPage` 传进来，**不读窗口的当前 URL**，那读的是屏幕上前台那个标签页）；先读"已内联"标记再决定注册什么；注入后读回每个补丁的自我报告，算出**命中 / 未命中 / 漂移**并写锚点记录。`replayPrototypeInBrowser()` 是文件变更后的那条路：我们自己的页 → 刷新，别人的页 → 重新 apply（**故意不是"apply 再刷新"**，见 §3.12）。
- `packages/server-core/src/handlers/rpc/prototypes.ts`：给渲染层用的 RPC（列表 / 导出 / 页表 `SET_PAGES` / 改某一页地址 / 入口解析 / **`prototypes:replay`**（按 slug 找所有在显示它的**标签页**——逐窗口读标签列表，不再看窗口级 `prototypeSlug`）/**`prototypes:duplicate`**（带 `fold` 选项：折的是副本）等）。
- `apps/electron/src/main/prototype-host.ts`：原型文档的应答——`/` = 入口页（是 overlay 就 302）或生成的页索引、`/_index` 恒可达、`/<页名>` 对 overlay 是 302、**文件优先**、SPA 路由回退到入口文档（`handlePrototypeRequest` 路由、`registerPrototypeProtocolHandler` 在浏览器 session 上拦 `http`、`installPrototypeBaseUrlResolver` 发地址）。
- `apps/electron/src/main/browser-cdp.ts`：`pickElement`、init script 注册、`setFetchMockRoutes`。
- `packages/server-core/src/domain/prototype-page.ts`：`describePrototypeAtPage(tab, …, workspaceRootPath)`——`snapshot` / `listWindows` 里那行 `Prototype:` 的唯一来源。**标签页上的身份优先**（开标签页时记的），会话绑定只在标签页说不出话时兜底，再配上页表里的类型与 origin。
- `packages/server-core/src/domain/tab-access.ts`：标签页的两条边界规则（reach / close）与 `whyTabIsOutOfReach` / `whyTabIsLocked` 的纯函数，被命令入口与 `--tab` 指名处共用。
- `apps/electron/src/main/browser-pane-manager.ts`：无边框窗口 / 标签栏与地址栏两块 chrome（`railView` + `toolbarView`）/ 每个标签页一个 `BrowserView` / 工具栏状态推送 / 地址→原型的反查；`reload(id, tabId?)` 也在 `IBrowserPaneManager` 上（自动重放要用，远程桥照旧 fire-and-forget）；**每个标签级方法收尾参数 `tabId`**（"命令作用于哪个标签页"由调用方指名，`tabOf` 是唯一的读法），`activateTab`（只换前台）与 `setSessionTab`（只写游标）是两件事。

### 渲染层

- `apps/electron/src/renderer/pages/PrototypeInfoPage.tsx`：原型详情页。页头按钮：**交付**（`Popover`：门禁逐条带去向——跳段 / 交给对话，点完自动收起；每个服务一行结论；`dist/` 清单；导出）、打开、在对话里改 / 开始对话，外加 `…` 菜单（打开位置）。正文顺序：**页面**（页表 + 每页的入口 / 地址 / 改名 / 删除，行上带改动清单与失效选择器点名）→ **页面问题**（有才出现）→ **需求**（渲染 `PRD.md` 原文 + 每条需求的引用标注 + 集合里其它文档可展开阅读）→ **研究**；告警与门禁文案都是 shared 侧 `notices.ts` 的 `code + params`，渲染侧翻译。
- `apps/electron/src/renderer/pages/ProjectInfoPage.tsx`：项目详情页的"原型"标签页——从工作区里**勾选**"这个项目在做的原型"（复选框多选，写的是 `ProjectConfig.prototypeSlugs`，§15.1.3／§15.1.4），以及每行的"用这个原型开对话"（把它绑到**新会话**上）。页面不显示也不设置"当前原型"：那个概念已撤回（§15.1.2），项目只**记**一组背景信息，不替会话绑定。
- `apps/electron/src/renderer/hooks/usePrototypes.ts`：原型的读取与 watcher；**自动重放**也在这里（它是对 watcher 的唯一持有者），`prototypeSlugForChangedFile()` 决定哪些变更值得重放（`patches/`、`assets/`、顶层 `.html`）。
- `apps/electron/src/renderer/atoms/prototypes.ts`：当前工作区原型的列表 atom。自动重放**没有开关**（曾经有过，撤掉的理由见下表 21.4 一行）。
- `apps/electron/src/renderer/components/app-shell/PrototypesListPanel.tsx`：两级下钻列表（原型 → 它的页）与菜单（新建页 / 设为入口 / 改名 / 删除，以及复制 / **复制并折叠改动** / 删除原型）。
- `apps/electron/src/renderer/components/prototypes/CreatePrototypeDialog.tsx` / `CreatePageDialog.tsx`：只问名字的创建对话框，与**按页问类型**的"新建页"对话框（一张卡片是"我们自己的一页"，另一张是"一个真实页面"并要地址——类型搬到这里才被问到，它的收益，如引导文案，也一起搬过来）。
- `apps/electron/src/renderer/components/prototypes/PrototypeBindingMenu.tsx`：会话标题栏的烧瓶图标（切换 / 解绑 / 跳回原型）。
- `apps/electron/src/renderer/hooks/useBrowserToolbarActions.ts`：面板工具栏动作 → 主窗口的实际调用。
- `apps/electron/src/renderer/browser-toolbar.tsx`：面板 chrome 本体（**独立渲染进程，没有 workspace / 会话上下文**）；`?view=bar|rail` 决定自己画的是地址栏还是左侧标签栏，标签栏的分段读 `groupTabsByWork`。

---

## 2. 阶段实现要点与初稿的偏差

初稿写在实施方案里，落地时改掉的地方都在这里；**结论已回写实施方案**，本文只留"当时为什么改"。

| 阶段 | 初稿 | 实际 | 原因 |
|---|---|---|---|
| 2 拾取器 | `startPicker()` / `stopPicker()` 两个方法，返回"用户点击时才 resolve 的 Promise" | 单一 `pickElement()`：注入一次 + 200ms 短轮询，结果写进 `window.__craft_agent_picker_state__`；**第五轮**起工具栏要的是常驻模式，于是拆成 `armPicker()`（注入并留在那里）+ `drainPicker()`（读走并清空，页内 `picks[]` 队列），一次性的 `pickElement()` 退化成两者之上的循环（agent 的 `pick` 仍然一次一个） | 长挂起的 `Runtime.evaluate` 会被 `CDP_IDLE_DETACH_MS = 5s` 的空闲 detach 打断；短轮询天然重置计时器，不必改既有 detach 逻辑。常驻之所以仍用"轮询 + 读走"而不是"长挂起 + 事件"，还是这条：一次调用不能等一整段时间，否则会被 detach 打断 |
| 3 注入 | css 走 `injectStyle`、js 走 init script（两条路径） | 两者统一走 init script（css 补丁由脚本自己创建/更新 `<style>`） | 注入的 `<style>` 元素**不随 reload 保留**，init script 会。统一后"reload 重放"只有一条机制，live 与 reload 也不会分叉。因此没有 `injectStyle` |
| 4 预览 | 新开一条受控渲染通道（现有 HTML 预览 iframe 禁脚本） | 复用浏览器面板打开产物 | 面板本来就是真实引擎、能跑 JS、已沙箱隔离；零新增 UI、渲染环境与工作台一致。产物地址先由回环 HTTP 提供，后来换成 §16 的 `protocol.handle` |
| 5 mock | 复用 MSW + Prism，或起一个 Node mock server 注册成 Source | CDP `Fetch` 拦截，在网络层 `fulfillRequest` | 前两条分别要引两个新依赖、且覆盖不到 axios 用的 XHR / 要应用改指向；CDP 版本零新依赖、覆盖 fetch+XHR+任意资源、应用一行不改 |
| 6.4 并线 | 工作台任务 = 一个 `TaskSpec`、一个平面 = 一个 node | **先推迟，后按触发条件落地**（结论见实施方案 §6.4） | 推迟的理由：写冲突已由"派生索引 + append-only patch + fragment 契约 + 所有权矩阵"消除；单用户单 agent 下接 DAG 只多一层生命周期；且当时的结构化输出（`params`）尚未实现，接上也传不了产物。触发条件到齐（结构化输出、Conductor、浏览器侧标签级归属）后按原形状落地 |
| 7 放开面 | 新增 `PROTOTYPE_PARTITION` 并只对它允许 `webSecurity:false` | **决定不做**（结论见实施方案 §6 阶段 7） | `webSecurity:false` 买到的是"页面脚本自己跨域"，而同一批能力用 CDP 也能做（`Fetch` 兑现、`Runtime.evaluate` 指定 frame）；代价是不可回退的真实安全弱化 |
| 16 载体 | 原型文档以 `file://` 打开 | 先做了一次回环服务器，**后来换成**在浏览器 session 上拦 `http`（`protocol.handle`），origin 无端口、跨重启稳定 | opaque origin 缺 cookie 域、相对 `fetch`/XHR 与 ES module——mock 层因此永远看不到请求（实施方案 §16）。换载体是因为回环的端口每次启动都变 ⇒ origin 变 ⇒ cookie 与 localStorage 不跨重启；代价（我们站在真实浏览的 http 路径上）与边界见 §3.11 |
| 19 kind 的位置 | `kind` 在**原型**上（§13）：一条流程要么整条 overlay、要么整条 scratch | **下沉到页**：`config.json` 的 `pages` 每行各自 `overlay` / `scratch`，一条流程可以混 | 类型描述的是**一份文档**的性质（我们自己写的 vs 别人的活页面），不是容器的性质；三个"想做却无处放"的证据见实施方案 §19 |
| 19 布局 | scratch 页各自是完整文档，共享部分靠复制 | 可选 `_layout.html`，单插槽 `<slot name="page"></slot>`（读时兼容旧拼写 `<!-- @page -->`），宿主渲染与导出都套（`applyPrototypeLayout`） | 复用停在"共享布局 + 页自己的资源引用"。**不引模板引擎**：作者面必须仍是最终产物，否则 agent 要学一套我们自己的语法，导出还得反过来还原它。插槽用 HTML 自己的拼写，就是为了不再多造一个只有本工程懂的标记 |
| 19.2 布局的默认与作用域（实施时修订） | 创建时预置一个示例布局；布局存在就套住每一页 | 创建**不写布局**（两页要重复同一段标记时才写）；页行 `"useLayout": false` = 共享布局不套这一页，该页按原样送出，宿主与导出走同一条判断，命令面是 `pages --layout/--no-layout <页名>` | "共用一个布局"是**页之间**的事实，不是原型级的默认：不同页可以是完全不同的设计，套上就是替它做决定。示例布局随之删掉——它本来只是"给第一页抄的形状"，而布局现在只在真需要时出现。没有多插槽、没有按页命名布局文件、没有继承链，作者面仍是完整 HTML 文档 |
| 19.4 补丁页域 | 补丁没有页域，整原型全量重放 | **目录即归属**：`patches/*` 每页重放、`patches/<页名>/*` 只那一页；`patches/<页名>/` 对不上任何页 → `status.pageIssues` 点名 | 只影响 dev-spec 与状态报告的**分组**，不影响注入正确性（补丁本来就要防御式书写，不匹配即静默无害）；旧数据全在根，语义一模一样 |
| 19.3 `/` | `/` 恒等于 `base.html`（§18），而文件名同时是导出路径与页间链接的锚 | `/` = **入口页**（行上的 `entry` 标记）；没有行标它时 = 宿主生成的**页索引** | 一张表里没有哪一页天然是第一页；换入口不该改文件名。"还没做出这个决定"应当看得见，而不是被一个文件名假装掉 |
| 19.3 `/_index` | 只有 `/` 一个地址 | `/_index` 恒可达（真文件优先，§16.3 的老规矩）；配入口只是换掉 `/` 的落点 | 索引谁也没有被顶掉：配入口是可逆的一步，不是把这个列表拿走 |
| 19.5 options 页 | options 页就是原型页（§17） | options 页 = 生成的**页索引**；工具栏图标开入口页（没有入口就开索引） | 表里可能有多页、也可能混着别人的页面，一个"页面"已经不足以代表它 |
| 19.7 旧数据 | 写迁移脚本 | **读时提升**（`legacyPageRows`）：`kind: "scratch"` → 页 `base`；`kind: "overlay"` + `targetUrl` → 页 `entry`；盘上一个字节不动 | 旧原型零动作可用，新写的数据里没有"旧字段"这回事。控制面下一次写入（只写页表）顺手把形状落成新的 |
| 19.8 声明页 | `pages --add <name>` 会造一个页 | 不带 url 的 `--add` 只把**已存在**的文档放进流程顺序（文件不在就报错）；overlay 页仍由 `--add <name>=<url>` 建 | **文件管存在、表管顺序与入口**："写个文件就生效"是这套模型最值钱的性子；预置一个空文档只是把死胡同伪装成一条路（§13.2 不变） |
| 19.8 创建 | 创建时问类型，overlay 还要问地址 | `create` 只要一个名字，建出来的原型**没有页**（连 `config.json` 都不写：没有东西可声明） | 类型与地址都是**页**的事实；"还没有页"是一句真话，不是错误状态 |
| 19.4 重放范围 | `apply` 整原型全量重放 | 按**窗口所在页**取补丁（`matchPrototypePage`），没有所在页就落到入口页，再落到"只有共享补丁"，并把这个页名报出来 | `patches/<页名>/…` 只落那一页，否则"补丁没生效"和"补丁属于另一页"从结果上分辨不出来 |
| 19.9 面板 | 一级列表 + 右键菜单（复制 / 删除） | 两级下钻（原型 → 页）；类型改由**新建页**对话框问；详情页有 Pages 区块 | 粒度现在真是项目的粒度：原型是一条流程、一个交付单位（config / patches / services / dist 都在它下面），页是文件与地址的粒度 |
| 21 标记 | `@requirement` 只在 `coverage.ts` 里解析；补丁没有 `@target` | 两个标记一起收进 `patch-header.ts`（**零依赖**），`@target` 解析成**列表** | `storage.ts` 要读 `@target`，而 `requirements.ts` 已经依赖 storage——放在 requirements 会成环。列表是因为折叠会把多条补丁的标记写进一个文件（§21.1） |
| 21 锚点 | 无（S4 只写了"命中报告"） | `anchors/<scope>.json`：**只记命中过的**（加上已有记录的），不匹配时**保留**旧 fingerprint 并把 `matched` 置 0 | 一条没有 `lastMatchedAt` 的锚点读起来像证据，而它不是；而保留旧 fingerprint 才能说"页面变了"而不是"没匹配"（§21.2） |
| 21 收敛 | 无（差量层只会变长） | scratch → `assets/<页名>/committed.*` + 文档引用；overlay → `patches/<页名>/Z-00x-upper.*`；折完删原文件。**触发点是复制**：`{ fold: true }` 折副本，原件不动 | base 归谁决定能不能合：我们自己的文档能重写，别人的活地址不能（§21.3）。JS 是**升格**不是折入——折进去等于"执行后序列化 DOM"，那是 §14.1 删掉的方案 |
| 21 自动重放 | 无（只有显式 apply / 手动刷新） | 文件变更 → 宿主页**刷新**、活页面**重新 apply**；300ms 合并、**常开**（开关后来撤掉，见下表 21.4 一行） | 对已内联的补丁求值会跑第二遍 JS，而那正是内联标记存在的意义；重放活页面会丢掉窗口里正在填的东西，决定权在知道那窗口在干什么的人 |
| 21 状态与面板 | 补丁只报总数与按前缀分组 | 逐条列出文件名 / 页 / `@target`；新增锚点区块（命中数 / 上次命中）/ 提交按钮 / 自动重放开关（这批后来撤掉：锚点区块与细节组见下面「21.5 详情页的『细节』组」一行，提交按钮见「21.3 折叠的入口」一行，开关见「21.4 手动应用与开关」一行） | "这条对着什么、有没有人检查过"是读补丁清单时最先要回答的问题，而原来一个都答不上 |
| 19.9 详情页 与 报告措辞 | 十四个区块平铺，按数据来源排；门禁 / 页面问题 / 需求问题都是 shared 侧拼好的英文句子，原样贴在中文界面上 | 按**打开动机**分四层：页头状态 + **交付**（门禁条目带去向 + 产物 + 导出 / 整理成一份）+ **流程**（页索引 / 参考 / 页面问题）+ **证据**（需求 / 研究 / 帧，空态一行）+ **细节**（改动 / 锚点 / 服务 / 归属，默认收起——这一组后来整组撤掉，见最后一行）；报告改走 `notices.ts`，渲染侧翻译、原文留作记录。异议与验收后来也撤出详情页，见下一行 | 交出去之前"能不能交"必须在第一屏独立回答，而它原来靠"没有告警"表达；同一件事说了四遍（打开会到哪在 hero、按钮下、页索引里各一份）；空态比有内容时更占地方（5 张空卡片 + 4 段"还没有"）。措辞上，"与 agent 同一句话"这条不能丢，所以 `code + params` 与 `text` 一起走 |
| 19.9 新建页 | 侧栏一级行的 `…` 菜单 | 详情页的**页索引**标题右侧 | 加一页是"加进这条流程"的决定，流程显示在详情页；侧栏只承载"我在哪个原型上"，两级下钻已撤销（实施方案 §19.9） |
| 20.4 详情页的「异议」/「上一轮验收」 | 各成一个区块 | **两段撤掉**；门禁里 `gate.disputeStanding` / `gate.checkFailed` / `gate.checksNeverRun` 三类的去向从"跳到该段"改为 **「交给对话」**——`usePrototypeAskAgent`（预填草稿、追加不覆盖、不自动发送；优先焦点会话，其次该原型绑定的会话，都没有才新建） | 两者都是"某一轮的过程"，且**只在对话里被解决**：异议要人回应、验收要 agent 跑一次，页面上给不出动作。未解决的异议与红的检查本来就在门禁里逐条点名，页面上再列一份就是第二份表示（§19.9／§23.5）。Requirements / Research 保留——它们是沉淀与依据，不是某一轮的过程（Frames 后来也撤出，见下面第二行） |
| 21.5 详情页的「细节」组 | 改动 / 锚点 / 服务 / 归属四段（可折叠） | **整组撤掉**；「改动自动重放」挪进页头 `…` 菜单（该项后来也撤掉，见下表 21.4 一行）；`anchor.orphaned` 的门禁去向改为「交给对话」；页索引那一行仍带改动数与失效标记（交付层那个「整理成一份」后来也撤了——折叠成了复制的一个选项，见下面第二行） | 判据推进一步：**页面上的每一段都要回答一个人会问的问题**；回答"系统内部怎么样"的段落，位置是 agent 的报告（`status`）。同批事实的可行动版本已经在了（失效选择器 = 页索引红字、缺响应 = 「交付」里服务那一行 + 门禁、能不能交 = 交付层）。归属违规完全退出人的界面（人无动作可做） |
| 20.3 详情页的「帧采集」 | 一个区块列出每次采集（会话 / 帧数 / 是否抽样）+「导入录制视频」按钮 | **区块撤掉**；「导入录制视频」暂挪进页头 `…` 菜单 | 帧是**给模型的材料**：出了几张、是不是抽样，权威读者是 agent（`research/frames/*`）。人在这里唯一会做的是"把别处录的一段带进来"——一个动作，不值得一个区块。当时以为 `importPrototypeVideo` 只有渲染侧入口、没有 agent 通路，所以留在菜单里；**这个判断是错的**（见下一行） |
| 20.3／20.5 导入录制的入口 | 详情页页头 `…` 菜单的「导入录制视频」，经 `prototypes:importVideo` RPC 落到 domain 的 `importPrototypeVideo`，采样参数**写死**（`timeline` / 2000ms / 40 帧）；文件选择器是 browser pane 的一项能力（`pickVideoFile`：Electron 主进程弹窗、远程侧转发、能力白名单里的一条） | **菜单项撤掉**，`prototypes:importVideo` 通道整条删除（`channels.ts` / `routing.ts` / `channel-map.ts` / `shared/types.ts` / `server-core` handler / `ipc-channels.test.ts` 白名单），三条 i18n 键随之删除；**`pickVideoFile` 能力整条删除**（`video-frames.ts` 的弹窗、`browser-pane-manager` 的方法与能力分支、`browser-capability` 白名单、`RemoteBrowserPaneManager` 转发、空实现、接口声明）；domain 的 `importPrototypeVideo` **保留**，`path` 变必填、不再返回 `null`（"用户改主意"这个答案没有了），唯一调用者是会话的 browser 工具 | 那条 agent 通路一直都在：`record import <path>`（今天的 `sample-video <path>`，见 §2 的 20.5 行；当时在 `browser-tool-runtime.ts`），带 `--every` / `--changes` / `--max`——比菜单里写死的那个**更强**。所以正确的做法不是给它加一条命令，而是**撤掉第二处入口**：抽帧是给模型的材料（要抽多少、抽哪段、之后写进哪条 finding），整件事都在对话里发生，人在这页上点一下只完成了前半段。选择器随之成为没人调用的能力——它是为那条 RPC 存在的，留着就是一段"渲染层能拿到的文件路径"，与"面板永远看不到路径"的说法正好相反 |
| 21.5 服务的位置 | 详情页的 Services 区块（fragments / fixtures / endpoints / mocked / stateful / missing 六个计数），随「细节」组一起撤掉 | **不进独立区块**：详情页「交付」区块里每个服务一行结论（全部假响应 → 不依赖后端 / N 个请求打真后端 / 契约里还没接口，缺响应标红），并且 `missingFixtures` 升进 `whyPrototypeIsNotSettled`（`gate.serviceUncovered`，7 语言 + 测试） | 服务是**交付**的事实，不是机制明细：人在这屏上问的是"交出去以后跑得起来吗"——所以它与产物、门禁同一层，同一个事实两处表示（一红一列，不会对不上）。计数（fragments / fixtures / stateful / endpoints）仍旧只属于 agent 的报告；而"声明了假响应却没有那个文件"的后果落在收件人那边（那条路由被跳过，请求打向他没有的后端），所以它是"还不能交"的一种 |
| 21.3 折叠的入口 | 详情页交付区的「整理成一份」按钮 → 即时折叠**当前这个**原型（先 `window.confirm` 写明不可逆）；命令面有 `prototype-commit [slug] [--page <name>]`；RPC `prototypes:commit` | **两处都撤**：按钮、`handleCommit`、`prototype-commit` 命令与它的帮助/示例、`fns.commitPrototype`（agent 侧没有折叠动作）、`prototypes:commit` 通道（channels / routing / channel-map / types / handler / ipc 快照）、7 语言的 6 个 commit 文案。**折叠改为复制的一个选项**：`duplicatePrototype(root, slug, { fold: true })` → 折的是**副本**（`foldPrototype`，原 `commit.ts` → `fold.ts`，`--page` 去掉）；列表行菜单多一项「复制并折叠改动」 | 折叠是**不可逆**的（删被折的补丁文件、**改写 scratch 页的文档**），而"工作停下来了吗"是作者心里的判断——把它做成交付区一个随手可按的按钮，代价与收益不成比例。放到复制上以后这两点同时消掉：原件一个字节不动，需要收敛的人拿到的正是一份新东西。过程上还走过一步"导出时先折叠"，回退了：导出是**打包**，不该顺手改作者的产物；`export --strict` 本来就会先拒绝，折叠在它之后就更没意义 |
| 19.9／20.4 详情页的顺序 | 交付区是页面**第一段**（门禁逐条 + 产物 + 服务 + 导出）；正文顺序：交付 → 页面 → 页面问题 → 参考资料 → 需求 → 研究 | **交付上到页头按钮**：`Popover` 触发，卡里是门禁逐条（每条的去向：跳段 / 交给对话，点完自动收起）、服务那一行、`dist/` 清单、导出按钮；页头徽章仍是"能不能交"的一句话答案。正文改为 **页面 → 页面问题 → 需求 → 研究 → 参考资料**（参考资料块整段搬到末尾；这一档后来整条撤掉，见下面第二行） | 交付是**结论与动作**（"能不能交"一句话 + 一个导出），不是要先读的一段——它之前占着第一屏，把"这份活是什么"推到下面。顺序上把证据（需求 → 研究）排在一起、参考资料收尾：参考是"看谁"的清单，读它的时机是准备动手时，不是回顾成果时 |
| 14 参考：撤掉这一档 | `references` 是**原型 slug 的数组**（后放宽为 slug / 网址 / 路径），写入校验"那个原型必须存在"；详情页有一列「参考资料」（带"打开"），`list` 印 `references:` / `referenced by:`，prompt 里列一遍 | **整条删除**：`references.ts` 与它的测试、`config.json` 的 `references` 与 `normalizePrototypeReferences`、`status.references`、`prototype-reference` 命令（含 help / 示例）、`link/unlinkPrototypeReference`（`BrowserPaneFns` + SessionManager 接线）、`list` 与 `status` 的那几行、`deletePrototype` 的 `referencedBy`、详情页那一整段、7 语言的 7 个文案。**"在看什么"改由 agent 写进需求文件夹**（§20.1：`PRD.md` 旁边的一份材料），详情页只渲染 `PRD.md` 并列出同目录的文件 | 判据是这一档**没有任何东西指向它**：需求能被回答"这条没人实现"，是因为补丁与 finding 指着它；参考资料只有"盘上在不在"这一个失败态，本质是一次拼写检查。而它记的"我在看什么"，finding 的 `source:` / `evidence:` 已经记了、还多记了结果；唯一不可替代的是"从页面点进另一个原型"，而侧栏本来就有那个入口。另一个诱因是它住在 `config.json` 里，让那份文件同时是"页表"和"关系表"。**最值钱的护栏没丢**：prompt 与研究块里写死"另一个原型的补丁永远不许抄进 `patches/`"（§14.3 的结构性一半——每份补丁只住在自己原型的目录里——本来就不依赖这条关系） |
| 20.1 需求：一个文件 → 只认 `PRD.md` | `prd.md` 一个文件，形状固定；详情页把需求渲染成 id / 标题 / 覆盖字符串的列表 | 需求**只从 `PRD.md` 读**（大写，原型根目录下），它旁边那个文件夹是作者的材料、**什么格式都行**：页面上不解析、不过滤、不读第二份文本，只按名字列出、点开交给应用内预览或系统默认程序（`listPrototypeFiles` → `status.entryDocument` / `status.files`，都是路径）。覆盖标注退成文档下方的一行列表（没人引用标红）。旧的小写 `prd.md` 只是文件夹里的一份材料 | 一条需求往往要人物、现状流程、术语这些支撑文档，全塞进一个文件就没人读得下去；而页面把散文改写成 id 列表，读的人拿不到论证本身。**只解析入口**是硬要求——否则"哪条需求没人实现"要跨文件回答。中途走过一步"集合 = 根目录的 `.md`"，撤了：作者放进来的是截图、表格、设计稿的场合比散文多，按扩展名过滤是替作者猜他的材料该长什么样 |
| 3.5 所有权：不枚举文件夹 | 一张 文件 → owner 的矩阵，未列出的路径一律 `unowned path` 违规 | `classifyPrototypePath` **只登记有规矩的路径**（`patches/`、`services/`、`anchors/`、`acceptance/`），**其余默认控制面**；违规也只剩"破坏了自己那条规矩"（补丁名不合格、服务目录里的杂文件） | 矩阵是**对文件夹形状的第二份描述**，而文件夹本身才是事实——副本从写下的一刻就开始过期：漏列一个形状就让一整类正常原型都在报违规（`prd.md` 那次：**任何写过 PRD 的原型都在报违规**），而报告说的唯一一件事就是"这个原型哪里不对"。所有权真正的正当性只有一条：**两个写者不互相覆盖**（§3.3），那与"文件夹里有什么"无关 |
| 3.6 工具面：原型命令提升为 `prototype_tool` | 17 条 `prototype-*` 是 `browser_tool` 的子命令（一张命令表、一个工具描述、一份 help） | **同一张命令表、同一个 `fns`，两个入口**：`executePrototypeToolCommand` / `executeBrowserToolCommand`，各自不认领就回 `null`（未知命令的措辞点名另一个工具，因为两门都收**不带前缀**的命令名）；`--help`、未知命令措辞、工具描述都分两份；`createPrototypeTools` 与 `createBrowserTools` 并列注册（`session-scoped-tools.ts`、`session-tools-core` 的 `tool-defs`、Claude/Pi 两个 backend 的白名单、覆盖层判定、工具显示名同步） | 一个工具的名字该是它的**主题**：`browser_tool` 的主题是那扇窗口的页，原型命令的主题是**文件 + 流程**（17 条里只有 4 条真需要窗口：open / apply / record / mock-apply），而它一半命令根本不碰浏览器。混在一起的代价是具体的：描述里出现了**第二份原型散文**（旧 `browser-tools.ts` 里那段，且已经漂了一处——"`PRD.md` 和它旁边的 `.md` 集合"）；而"让 agent 先读指南"这件事挂不上——前一问的答案就是"browser tool 不必对原型特殊处理"，因为不再是它的子命令。代价认了：跨主题批量没了（`apply; snapshot` 变两次调用），工具清单多一项。**收尾**：两张命令表随后按门拆成 `browser-commands.ts` / `prototype-commands.ts`，工厂拆成 `browser-tools.ts` / `prototype-tools.ts`，能力接口留在 `browser-pane.ts`；命令名同时去掉了 `prototype-` 前缀（`prototype-apply` → `apply`）——两门靠"你调的是哪个工具"区分，撞名的（`open`）也一样，所以门禁不再按前缀判断，前缀判断也没有了。之后又分了两刀：门自己的 runtime（批量 / `evaluate --file` / settle 时长）从共享模块搬回 `browser-commands.ts`，共享的那份改名 `command-cli.ts` 并改成 `createCommandRunner` 注入门的三件事——两次都是为了让依赖单向，不再有两门互相 import |
| 21.4 手动应用与开关 | 面板工具栏有「应用原型的改动」按钮（`browser-toolbar:apply-prototype` → 工具栏动作 `apply-requested`），详情页 `…` 菜单里有「改动自动重放」开关（偏好存 `~/.craft-agent/preferences.json`） | **两处都撤**。按钮整条删除：preload 通道、`browser-pane-manager` 的 handler 与 `TOOLBAR_CHANNELS` 项、`BrowserToolbarAction` 的 `apply-requested` 分支、`useBrowserToolbarActions` 里那段 toast、`handleApplyPrototype` / `hasPrototype` / 渲染层 `ToolbarState` 里的 `prototypeSlug`（它只为这个按钮的可用性而读；主进程照旧推这个字段，窗口的绑定仍由它描述）、6 个文案（`browser.applyPrototype` + 5 个 `browserEdit.*`）。开关整条删除：两个 atom、`lib/prototypeAutoReplayPreference.ts`、`UserPreferences.prototypeAutoReplay`、1 个文案；重放**常开** | 手动 apply 是同一件事的**第二个入口**，而且在正常路径上永远无事可做：我们自己的一页从宿主拿到时就**内联**了补丁（`apply` 只会报 `skipped`，toast 是"Applied 0 patch(es)"），活页面在"打开"那一步就已经注入过（`entry.injectPatches`），改文件由 watcher 重放、刷新又让宿主从盘上重渲染——四条路都通向同一份页面，按钮只是把它们重说一遍。开关同理：它拦不住任何副作用（真正会丢输入的是重放本身，而关掉它只是让改动不再到达窗口），却把"保存了却没反应"——这条特性本来要消灭的失败——又请了回来 |
| 21.6 窗口里的直接编辑（新增） | 无。窗口只有两种手势：准星选中 → 交给对话；在地址栏输入 → 打开。改页面只能由 agent 写补丁 | **一个门、一个模式、一个脚本**。工具栏仍是那一个准星按钮，进去之后**点选一个元素，或拖出一个框选住几个**，条子出现，两块都钉在页面顶部：`B · I ｜ 添加到对话` 居中，`↶ · ↷ · ✓` 在左上角。页面侧一个 `buildOverlayScript`（`browser-cdp.ts`）同时服务两个人——窗口自己的模式（`resident` + `bar`）与 agent 的 `browser_tool pick`（一次性、无条子、答完即拆）。**点选**取光标下的元素（inline 也算，所以点段落里的链接就是链接），**框选**取矩形内最深的**非 inline** 块（所以框住一段就是那段，而不是里面的 span）。草稿在页面里：样式进我们自己的一层 `<style>`（由草稿**按顺序生成**，"撤销"= 少一条后重画，"重做"= 把刚撤掉的那条放回去，文字则要把元素的原文字写回），**保存前不写任何文件**。条子分成两块、**都钉在页面顶部**（不挡选区、也不随选区跑）：主体居中（`B · I ｜ 添加到对话`），**撤销/重做/保存单独一块钉在左上角**（`✓` 在 `↷` 右边）——撤销/重做是人常按、也走键盘的，分开之后主体可以随选区变而这块位置不动；保存放进这一块是因为它关于**整份草稿**而不是当前选区，而且它正是"要不要保存"这个问题的答案。配色用应用的**菜单色**（`popoverSolid / popover → background` + `foreground`，由主进程解析）：它是我们放在别人页面上的一张菜单，主题色留给应用画在页面上的记号（选区框与名字）。名字是**一个 chip、固定钉在页面左下角**（`left:8px;bottom:8px`），不挂在框上：跟着框走的名字会随页面滚动换地方，而且在人正盯着那个元素的那一刻压在它上面——chip 里显示的是"光标下是什么"（也就是点一下会拿到什么），没有悬停对象时显示选中的那些（多个用 `·` 连起来，各自有自己的框指认）。按钮是字形（说明走 `title`，随 `pickElement` 传入；`labels` 里因此有 `save` 一词；**没有放弃按钮**，丢弃 = 离开模式，而 `✓` 和撤销/重做一样在没东西可写时变暗），撤销/重做另有快捷键 `Ctrl/Cmd+Z`、`Ctrl/Cmd+Shift+Z`、`Ctrl/Cmd+Y`——正在改文字时让给浏览器（那段文字的撤销是它自己的）；没东西可撤销时也照样吞掉，因为模式持有页面期间，页面自己执行的撤销是应用看不见也记不下的改动。**页面在模式期间收不到鼠标**：`pointerdown` 之外，`mousedown` / `mouseup` / `click` / `dblclick` 按同一条规则吞掉（`browserOwnsIt`）——页面监听鼠标事件和监听指针事件一样常见，而它们是各自独立的事件，少这一层双击就会去选页面自己的文字、跟着链接走。例外只有两处：条子自己的控件，和**正在改文字的那个元素**（里面的光标与选词属于浏览器）；在它之外按一下就是那次编辑的结束，由我们自己提交（`endText(true)`），而不是让页面的 focus 把它 blur 掉。文字编辑：Enter 提交、Shift+Enter 归页面（换行）。离开是一次提问：有未保存时模式不结束（`confirming`），`drainOverlay` 因此报 `leavingWithEdits`，窗口那条 chip 改说"有未保存的改动，要先保存吗？"（主进程只在它变化时推一次状态），而且**回答在窗口那侧**：准星左边这时多出一个 `✓`（`SAVE_EDITS` → 页面里的 `__craft_agent_overlay_save__`，走的就是同一个 `save()`，所以存完模式也结束），准星**再按一次**就是"不"——直接拆除、草稿一起丢（Esc 在页面里说的是同一句话；主进程靠 `leavingWithEdits` 区分"问一次"与"拆"，chip 与 `✓` 也都是它画的）。因此出口有两条：`askOverlayToLeave`（工具栏按钮走的软请求，页面可以拒绝并继续持有模式）与 `teardownOverlay`（关标签页 / 换页重新 arm / 一次性 pick 收尾——那些场合没人可问）。保存 → 工具栏动作 `edit-requested`（一批编辑）→ 渲染层用**标签页的** `prototype` / `prototypePage` 解析出 slug 与页 → RPC `prototypes:edit` → `writePrototypeEdits()` 写**一条**差量；「添加到对话」→ `add-to-conversation`，与原来同一条路。条上的文案由工具栏渲染层随 `pickElement` 传入（页面没有 i18n） | 直接编辑的价值全在"它被记下来了"：不落盘则刷新即失、别的窗口看不见、交付里也没有——所以落点只能是补丁，而补丁一旦是落点，`@target`、锚点、漂移、折叠、`dist/` 全都自动接上（§21 那一整套本来就在等一个写入者）。**最初做成了第二个模式（准星旁边一个铅笔），被否掉**：两种手势都已经建立在同一个东西上——一个选区——却要人先猜"这次进哪个门"、进门才发现两边能做的事是一回事，而"框选本来就只能发生在模式里"是前提；于是两个 overlay、两个模式标志、两个轮询循环、两种互斥关系合成一个，地址栏也少一个按钮。写盘时机同理：**"一次编辑一条补丁"也做过，被否掉**——人一次会话要改好几处，粒度太碎会让撤销变成"删文件的历史"；而且**写盘就会触发重放**，重放会让 scratch 页重渲染，于是会话自己的状态（选区、草稿）每点一次就被冲掉，连改几个元素都做不到。所以写入推迟到"保存"这一个时刻：撤销在草稿里是免费的（重画那层样式 / 把元素文字放回去），会话期间页面不被打断。**代价是保存前页面显示的是草稿**——没有任何补丁声明过的值，正是这个仓库认定最坏的那种第二份描述；它由模式与条子明确承担：按钮的可用与变暗状态（`✓` 同上）、以及"离开即放弃"这一条出口——离开或拆除前未保存的一律还原（`cleanup()` 里也走同一条 `discard()`）。文字只做**整块替换**：段内富文本要把元素的标记存进补丁，那就是 §14.1 否掉的"执行后序列化 DOM" |

**"`*.localhost` 能不能当 origin"是一次探针实测，不是推断**（实施方案 §16.2 引用的就是它）：一个一次性 Electron 探针在 `http://probe.localhost:8420/` 上确认了四条，全部成立——

```
origin:  "http://probe.localhost:8420"            ← 真实 origin，不是 null
cookie:  "probe=1"                                 ← document.cookie 可读可写
fetch:   {"ok":true,"host":"probe.localhost:8420"} ← 相对路径 fetch 打到了服务器
storage: true        moduleRan: true               ← localStorage 与 <script type=module> 正常
```

`*.localhost` 在 Chromium 里解析到回环，所以不需要 DNS 或 hosts 条目。探针当时跑在回环服务器上，但这四条是**主机名**的性质、与端口无关，所以现在换成拦截、地址里没有端口，结论照旧成立。顺带一条给人踩过的坑：**HTTP 层的测试不能按字面拨号**，要覆盖 `Host` 头打到 `127.0.0.1`（Node 的解析器不认 `*.localhost`，Chromium 认）——现在的测试改成直接调 `handlePrototypeRequest`，连 socket 都不用起了。

### 2.1 交付物与多页的落点（改了哪些文件）

| 动作 | 落点 |
|---|---|
| 新增 | `packages/shared/src/prototypes/extension.ts`：manifest / README / 匹配模式（URL → pattern）/ 版本号 + **页面变换**（内联 `<script>` 提取、内联 `on<event>` 提成生成函数 + MutationObserver 运行时、`type="module"` 与内联脚本一起提取）+ mock 编译 + 多页打包（共享产物 vs 每页产物） |
| 迁移 | `buildPatchBundle` 搬进 `extension.ts`（它正是 content script 的 JS 体）；书签那一份产物由 `bookmarklet.ts` 生成（`dist/bookmarklet.html`：一页一条可拖拽链接 + 控制台那条路，§17.9） |
| 改 | `export.ts`：写四份产物——`dist/extension/`、`dist/static/`（§17.8）、`dist/bookmarklet.html`（§17.9）、`dist/handoff.md`（§20.8）；结果类型是 `extensionDir` / `pagePath` / `pageUrl` / `staticPath` / `staticWarnings` / `bookmarkletPath` / `specPath` / `handoffPath` / `version` / `warnings`（旧的 `htmlPath` / `htmlUrl` 不再有；两份交付物的改写理由不同，所以警告也分两栏） |
| 改 | `config.ts` / `pages.ts` / `status.ts` / `prompt.ts`：页表（`pages`）读写、规范化与 `pageIssues` 上报；顺序 = 表序，没人声明的文档按名字接在后面 |
| 改 | `prototype-commands.ts`（`runPrototypeCommand`）+ `browser-pane.ts` + `SessionManager`：`pages`（list／`--add`／`--remove`／`--rename`）与 `setPrototypePages`；`export` 的输出（每份产物的路径——extension / spec / handoff，有才印的 static / bookmarklet——+ Load unpacked 三步 + 未决项与警告） |
| 改 | `apps/electron/src/main/prototype-host.ts`（原 `prototype-server.ts`）：回环监听器 → 浏览器 session 上的 `http` 处理器 + `net.fetch` pass-through；origin 去掉端口、地址稳定 |
| 改 | 窗口身份：`PrototypeEntry.origin`（共享层）+ `browserPane.create({ prototype })` + `prototypeBindingFor`（标签页绑定优先、会话链兜底）+ `BrowserInstanceInfo.prototypeSlug`。修的是"刚创建的原型点「打开」得到普通标签页"——见实施方案 §7。（当时还用了 `bindPrototype` 事后绑定；标签页的身份改为"创建时定"之后它已删除，见实施方案 §22） |
| 改 | `apps/electron/resources/docs/browser-tools.md`、`release-notes/next.md`、7 个语种的 `prototypeInfo.distEmpty` |
| 验收 | 实施方案 §10 的 M 组（63–70）与 Q 组（86–93） |

---

## 3. 踩坑记录（症状 → 根因 → 修法）

### 3.1 reload 后补丁静默失效

- **症状**：打上补丁 → 页面刷新 → 什么都没了，没有报错。
- **根因**：CDP 的 init script 注册（`Page.addScriptToEvaluateOnNewDocument`）**随 debugger 分离而失效**，而 `CDP_IDLE_DETACH_MS = 5s` 空闲即分离——所以"reload 保留"会在 5 秒后静默失效。
- **修法**：`resetIdleDetachTimer()` 在 `initScriptIds` 非空时直接返回（持有连接），最后一个脚本移除后恢复计时；`detach()` 同步清空键表（CDP 那边也一起没了）。同样的判据后来扩到 `Fetch.enable`（开着 mock 也算持有连接）。
- **2026-09-21 真窗口实测补正**：上面那条只解释了"5 秒后失效"，**不是**这个症状的全部——真正让"刷新一下什么都没有"的是**Page 域没开**。`Page.addScriptToEvaluateOnNewDocument` 在域关着时**照样返回 identifier**，但那个注册是**惰性的**：新文档里一次都不跑（实测 Electron 39：注册 → reload → 脚本设的标记仍然不存在，debugger 全程 attached、`isAttached()` 为 true）。症状因此长成"**地址栏敲一遍地址能看见补丁**（那条路是显式 apply 的 `evaluate`，作用于当前文档）、**刷新就没了**（只走 init script）"。**修法**：`enablePageDomain()` 在第一次注册前发一次 `Page.enable`，每会话一次；它和注册一样是会话状态，所以 `detach()` 里跟 `initScriptIds` 一起清。补上之后 reload、后续导航、以及重复注册（替换语义）都实测生效。
- **这条只有真窗口能验**：单元测试用的是假 debugger，只记下调用，"注册返回了"和"脚本真跑了"不在同一个地方——判据是 §5.4 那一行（在真窗口里敲一遍刷新）。

### 3.2 拾取器被空闲 detach 打断

见 §2 阶段 2 那行。要点：不要把一次 `evaluate` 挂太久——**空闲 detach 是 5 秒级的**，任何"等用户操作"的注入都会踩到。

### 3.3 `ERR_FAILED (-2) loading 'about:blank'` 报错归错人

- **症状**：详情页点「预览」偶发报 `about:blank` 加载失败，但页面其实已经打开了。
- **根因**：详情页每个打开动作都是「先 `create`（它立刻发起空态页加载），紧接着 `navigate`」。后发的导航把空态加载 abort 掉——**这是正常且预期**；坏在空态加载的 `catch` 里**无条件**回退到 `about:blank`，于是又插进一条导航，失败被记在 `about:blank` 上、顺着 `navigate` 的 promise 弹回 UI（日志里 `did-navigate` 显示真实导航 50ms 前就成功了）。
- **修法**：给回退加前提——`ERR_ABORTED` 时直接放弃回退，只有空态因别的原因失败才加载 `about:blank`（`code` 与 message 两处都匹配，不依赖单一字段）。两个方向都有测试固定。
- **2026-09-15 实测补正**：真实日志里这次 abort **没有**走到空态的 `catch`，而是落到了 `navigate()` 的 promise 上（Electron 把 abort 交给"当前"那个 `loadURL` promise，而不是被顶掉的那个），字段是 `{"errno":-3,"code":"","url":"file:///…/browser-empty-state.html"}`——`code` 与 message **都是空的**，所以上面那两处匹配**从来没生效过**；终端于是每次都留一条 `navigate failed …` 的 ERROR，而 `did-navigate` 显示那次导航其实成功了。现在统一按 `abortedLoad()` 判定（认 `errno === -3`／`code === 'ERR_ABORTED'`／message），两处都用它：空态那侧不抢导航，`navigate()` 那侧只在「失败的 URL 不是我们要去的地址」时视为"被顶掉"（要去的地址自己被 abort 仍是真失败）。

### 3.4 两条以上 js 补丁只有第一条执行

- **症状**：一个原型里有两条 js 补丁，第二条从不执行，**没有任何报错**。scratch 的自包含 HTML 一直如此。
- **根因**：`buildPatchInitScript` 返回的是**表达式**（`…})()`）。两条补丁连排时（同一个 `<script>` 里、或同一个 bundle 里）被解析成"对第一个补丁返回值的调用链"：第一个跑完，其余全部静默不跑。
- **修法**：变换自己带 `;`（语句而不是表达式），并在两处测试钉住（变换层 `prototypes.test.ts`、HTML 层 `export.test.ts`）。

### 3.5 已内联的补丁被重复应用

- **症状**：渲染页到手时补丁**已经在文档里**，再注入一遍会让 JS 补丁跑第二遍——**页面看起来一模一样，改动却是错的**。
- **修法**：让文档自己说明它带了什么（`<script type="application/json" id="__craft_prototype_inlined__">`），注入前 `buildInlinedPatchProbeScript()` 读回来，**跳过列出来的那些**；init script 是 window 级的，所以每次 apply 都是「清掉本原型的全部注册 → 只注册缺的那些」，与页面上缺的东西严格对齐。读不到 / 不是 JSON / 不是字符串数组一律当作"这份文档什么都没有"——反过来（默认已应用）会让该做的活被静默跳过。
- **留下的一处妥协**：判别只认文件名、不认内容，所以改了已有补丁的**内容**要刷新页面才看得到（实施方案 §16.6 有说明）。

### 3.6 渲染层不能从共享包 barrel 取运行时值

- **症状**：`bun run electron:build` 在 `@anthropic-ai/claude-agent-sdk/sdk.mjs` 上解析失败（`__vitePreload` 被注入到 shebang 之前）。
- **根因**：一条真实链路被拖了进来——`prototypes/index.ts → prototypes/storage.ts → workspaces/storage.ts → config/storage.ts → (惰性) agent/session-scoped-tools.ts → SDK`。`config/storage.ts` 里那个 `import(...)` 是为了破循环依赖才写成动态的，但打包器照样跟着走。触发点是详情页从 barrel 里取了一个**运行时值**（当时的 `DEFAULT_PROTOTYPE_KIND`，现在叫 `DEFAULT_PAGE_KIND`）；其余导入都是 `import type`，编译期即被擦除。
- **修法**：类型与默认值下沉到零依赖的 `prototypes/types.ts`，并新增导出子路径 `@craft-agent/shared/prototypes/types`（与既有的 `./config/types`、`./projects/types`、`./sources/types` 同一约定）。
- **规矩已单独成文**：[渲染层的导入边界](renderer-imports.md)（渲染层要共享包的值只能从 `*/types` 这类零依赖模块取，barrel 只可用于 `import type`；含自查命令）。

### 3.7 新增 handler 会打破注册表测试

`registration.test.ts` / `registration-profiles.test.ts` 用各 handler 模块的 `HANDLED_CHANNELS` 拼期望集合，新增 handler 必须同步把 `...prototypes.HANDLED_CHANNELS` 加进去。

**同一个新通道还要在 `packages/shared/src/protocol/routing.ts` 里二选一**（`LOCAL_ONLY_CHANNELS` / `REMOTE_ELIGIBLE_CHANNELS`）：`routing.test.ts` 要求每个通道**恰好**被分类一次，"注册表补齐了、routing 忘了"是**另一条**独立的失败。曾经红着的几个通道（`prototypes:replay` / `setPages` 等）已经补进分类（§5.2；`prototypes:commit` 随折叠改到复制上整条删掉，`setProject` 随 §15.1.4 删掉了）。

### 3.8 原子写的固定临时文件名

`atomicWriteFileSync` 用固定的 `<path>.tmp`（`packages/shared/src/utils/files.ts`），两个写者并发写同一路径时**连临时文件都在争用**。当前单写者模型下不会触发；真要做并发写（§6.4）就得改成每个写者唯一的 `.tmp` 名，或经控制面串行化。

### 3.9 `tsconfig.base.json` 曾缺失（**已解决**，留档）

当时 `typecheck:all` 在 `session-tools-core` 处中断：四个包引用 `tsconfig.base.json`，而它不在本分支的祖先链上（只存在于上游历史 `0e84b1cd`）。按历史原文恢复后 `session-tools-core` 与 `pi-agent-server` 的 typecheck 归零，**文件现在在盘上**。顺带暴露一处遗留：`session-mcp-server` 的 tsconfig 缺 `allowImportingTsExtensions`（对 `*.ts` 后缀导入报一堆 TS5097），而该包**没有任何 typecheck 脚本**，所以从来没人跑到——与本工作台无关。

### 3.10 本 checkout 缺上游脚手架脚本

根 `package.json` 里引用的 `scripts/*` 有一部分不存在，都是上游的 CI / 发布 / 本地脚手架（`build.ts`、`release.ts`、`check-version.ts`、`fresh-start.ts`、`check-raw-sends.sh`、`check-task-tool-checks.sh`、`sync-secrets.sh`、`typecheck-staged.sh`、`electron-dev.sh` 等），与本工作台无关。`check-i18n-coverage.ts` **仍然缺**，所以 `lint:i18n:coverage` 在这个 checkout 跑不了（§5.1）；`apps/electron` 自己的 `build` 脚本引用的 `validate-assets.ts` 也缺。**注意 `electron:start` 走的根链（main → preload → renderer → resources → assets）不依赖它们**。

### 3.11 `protocol.handle('http')` 的范围与代价（换载体时记下的）

- **范围是 scheme + session，不是 host**：handler 注册在 `persist:browser-pane` 上，所以该 session 里**每一个** http 请求都先经过 `handlePrototypeRequest`；host 判断只决定"谁来答"，不决定"谁来经手"。
- **为什么还是换了**：回环监听器的端口是临时的 ⇒ origin 每次启动都变 ⇒ cookie 与 `localStorage` 不跨重启——而这个工作台正要"模拟登录态"，稳定 origin 是**功能**，范围是可接受的代价。
- **把代价钉死的三条约定**（都在 `prototype-host.ts` 的模块注释里）：① 只拦 `http`，`https` 一个字不碰；② 不属于我们的 label 一律 `net.fetch(req, { bypassCustomProtocolHandlers: true })` 原样交回——**这里不是 404**，`*.localhost` 上跑着真实 dev server，把人家的页面 404 掉是最糟的失败；③ handler 不抛异常，我们这一侧的失败答 500 并记日志。
- **待实测**（只有真实窗口里能看，清单见 §5.4）：pass-through 对分块上传 / 流式响应 / 下载 / HTTP 缓存是否无损；以及我们 host 上 `document.cookie` 写入后能否在后续请求里带回来。
- **别再走的一次弯路**：`interceptHttpProtocol` 那一族是**废弃 API**（`register*Protocol` / `intercept*Protocol` → `protocol.handle`），网上搜到的例子多半还是旧的。

### 3.12 旧配置靠读时提升，不靠迁移脚本

- **背景**：`kind` 从原型下沉到页之后，"已经存在的原型"在代码眼里就是"页表为空"——而状态、面板、命令全走**只读**路径，没有任何一处会替它写盘。
- **修法**：提升放在**读**这一侧（`readPrototypeConfig` 认顶层 `kind` → `legacyPageRows`）：`scratch` → 页 `base`（`base.html`，entry）；`overlay` + `targetUrl` → 页 `entry`（url = targetUrl，entry）；`overlay` + `pages` → 入口页 + 其余按声明序（旧原型只有一种 kind，所以都算 overlay）。读不到 `kind` 的坏配置同样落到 `scratch` 那一支（§13.3 不变）。
- **要点**：① 提升出来的行照走 `normalizePrototypePages`，重名 / 重地址规则与手写配置完全一样，所以不存在"旧数据规规矩矩、新数据才严格"的裂缝；② 盘上一个字节不动，直到下一次控制面写入——而 `writePrototypeConfig` 只写页表，所以**一次写入就把旧形状退休了**（没有顶层 `kind` 的配置只会按新形状读）；③ `base` / `entry` 是提升的**产物**，不是保留名（保留的是 `_` 开头），改名照普通页处理（文件 + 它的补丁目录 + `entry` 标记一起动，由控制面一次做完）。

### 3.13 "文件管存在、表管顺序与入口"这条不变式，第一版在名字检查上写反了

- **症状**：文档已经写好（`cart.html` 在目录里，`describePrototypePages` 也把它当页），但 `pages --add cart` 报 `already has a page "cart"`——于是**没有办法把一页放进流程顺序**，而"文件管存在"这条性子也就落不了地。
- **根因**：判重用了"合并后的页表"（未声明的文档自动算页），而 `--add` 要回答的是"这一行**声明过**没有"。同一条不变式在这里需要两个集合：页表（谁存在）与 `rows`（谁被声明过）。
- **修法**：不带 url 的 `add` 只对**已声明的行**判重（`rows.some(...)`），"文档在不在"交给文件系统（`existsSync(join(dir, pageFileName(name)))`，不在就报错并让人先写文件）。反过来，`entry` 那一支遇到"没人声明的文档"要**顺手补一行**：`entry` 是行上的标记，而只有行能带它。`pages.test.ts` 的两条用例钉的就是这一对（`refuses to declare a page of ours…` / `declares a document nobody listed, because only a row can carry the flag`）。

### 3.14 补丁的页名要在"相对 `patches/` 的路径"上取，不能在绝对路径上切

- **症状（会踩到的形态）**：`patches/cart/A-001.css` 的页归属在 Windows 上读不出来——页名成了整条绝对路径（或为空），于是它被当成共享补丁，页域等于没生效。
- **根因**：`status.patches.files` 给的是**绝对路径**，而"哪一页"只存在于"相对 `patches/` 的第一段"里。在绝对路径上做字符串手术（找最后一个分隔符、找 `/`）在 Windows 上必然错：`\` 不是 `/`，路径里还有盘符。
- **修法**：先归一成 `/` 分隔的**相对**路径，再取第一段——`prompt.ts` 里是 `relative(patchesDir, absolute).split(sep).join('/')`，页名 = 第一个 `/` 之前的部分，没有 `/` 就是共享。`storage.ts` 那一侧本来就在 `patches/` 相对路径上工作（`readPatch` 自己拼 `page/file`），两边同一条约定。**别用绝对路径去拼展示用的相对路径**，那是同一类坑的入口。

### 3.15 `pageAvailable` 与 `resolvePrototypeEntry` 必须是同一个判断

- **症状**：面板的「打开」亮着、点下去报错；或者反过来，明明有页可看却是灰的。差异都出在边界上：没有宿主（单测里没装 resolver）、入口是 overlay 但行里没有 url、声明的页文档被删了。
- **根因**：一个判断被写了两次——`status.ts` 要它来决定按钮的可用性，`export.ts` 要它来决定"到底能不能打开"——两次的条件一旦不完全一样，面板就会提供一个必然失败的按钮，或者藏起一个能用的。
- **修法**：`pageAvailable` 就是 `resolvePrototypeEntry` 的判据，逐支对齐：有页 **且**（入口是 overlay → 它自己有地址；否则 → 有宿主，且入口页的文档在）；没有入口时同样要求有宿主（`/` 要给出生成的页索引）。用例走遍 entry / 页 / 宿主 的组合（`ownership.test.ts` 的 `agrees with resolvePrototypeEntry about what can be opened`），两处的注释也互相指认。

### 3.16 自动重放：刷新还是注入，取决于**文档自己**

- **症状**（写之前就能预见，测试把它钉住了）：文件一变就"重放"，活页面上的 JS 补丁跑了两遍——而页面看起来完全正常。
- **根因**：`apply` 会跳过"文档已经内联的补丁"，所以"内容改过的那条补丁"在 apply 时是被**当作已应用**跳过的（这是 §3.5 那条不变式的代价）。于是两种天真的做法都错：**只 apply 不刷新** → 改过的补丁不会被重新执行；**apply 再刷新** → 对已经内联的那批补丁求值一次，JS 跑了两遍。
- **修法**：`replayPrototypeInBrowser()` 先读内联标记，**按结果二选一**——文档带标记（我们自己的页，宿主按请求现渲染）→ 只 `reload()`；没标记（别人的活页面）→ 走完整的 apply（重建注册 + 立即求值）。判据来自文档本身而不是地址或页类型，所以存到别处再打开的文档也一样成立。

### 3.17 生成的文本里出现标记**字面**，就会被当成标记

- **症状**：折叠折出来的文件，`scanPrototypePatches` 读到的 `@target` 除了真的选择器，还多了一条 `markers, which the workbench reads).`——`fold.test.ts` 当场抓到。
- **根因**：banner 里写了一句"每个来源都保留它自己的 provenance 头（以及它的 `@target` 标记…）"。解析器按行扫、把标记之后到行尾都当成它的值——**它没法区分"标记"和"谈论标记"**。
- **修法**：生成的文本里不写标记字面（那句改成"它携带的标记"，不点名字）。同一条规矩也约束 provenance 注释：**每个标记各占一行**，`@requirement` 在前、`@target` 在后，因为同一行上的第二个标记会被第一个吞掉。

### 3.18 测试桩不能靠"包含某个字符串"来认探针

- **症状**：加了"每个补丁自报命中"之后，`apply-prototype.test.ts` 里 4 个用例的 `evaluated` 突然变成空数组——补丁脚本压根没被执行到。
- **根因**：测试桩用 `expression.includes('__craft_patch_state__')` 认状态探针，而**每个补丁脚本现在也含这个 key**（它要往里写）——于是补丁脚本被当成探针"答完就走"。
- **修法**：按探针特有的一行来认（`const measured = (entry.matches`、`const entries =`、`out[target] = el ?`）。教训是通用的：**当被测代码开始包含某个 key，用 key 认它就不成立了**，要认形状。

### 3.19 收敛会把 scratch 页的需求线剪断（读的一端漏了写的一端）

- **症状**：给一个 scratch 页的补丁折叠之后，`status` 把它服务的需求列进 `unresolved.unmet`，交付闸门报 `R-001 is in PRD.md but no page or patch refers to it`，`dist/dev-spec.md` 的需求表把它印成 `**nothing**`——而那个改动**还在页面上**（真浏览器里对照过：折入前后计算样式逐字段一致）。
- **根因**：折入的落点与读者找的地方不一致。折叠按 §21.3 把 provenance 头（含 `@requirement` / `@target`）**有意**写进折入文件 `assets/<页名>/committed.*`，但 `resolveRequirementCoverage` 只扫 `patches/`（`scanPrototypePatches`）与页文档，**从不读 `assets/**`**。overlay 页不受影响——那里的折入落在 `patches/<页名>/Z-*`，扫得到。于是这是只在 scratch 上出现、且方向相反的偏差：工作台自己把"有实现"改成了"没人做"。
- **修法**：读的一端补上折入文件；`COMMITTED_CSS` / `COMMITTED_JS` 由 `fold.ts` 导出，**写者与读者对"折到哪去了"只有一个权威**，不再各写一个字面量。页文档不在时仍然什么都不声明，不让折入文件替一个打不开的页面说话。回归测试在 `__tests__/coverage.test.ts`（`follows a requirement into the file a page folded its own delta into`），把折入后的 `pages`、`unmet` 与 dev-spec 需求表一起钉住，并覆盖"文档被删则不认"这条边界。
- **教训**：写入者与读者之间的**路径**是一份隐含契约。凡"写去 A、只从 B 读"的配对，都要有一处共享的名字，并且要有一条端到端用例**跨过那次折叠**——否则每个单元测试都绿，合起来却是断的。

### 3.20 状态化 mock 的响应体交出了 store 的对象引用

- **症状**：`mock-engine.test.ts` 里第一次 `GET` 的断言失败，收到的却是**第三次** `GET` 的答案——而且是"当时的" currency 配"后来的" items 这种自相矛盾的值。
- **根因**：`answer` 里直接 `readMockPath(store, collection)`，把 store 里的**活对象**交了出去。workbench 的网络层和页面载体都在拿到它之后立刻 `JSON.stringify`，所以生产上一直看不出来；但"已经发出的响应"在语义上就是**快照**，而它却是个窗口——后一次请求一改，前面那条答案跟着变。（`PATCH` 的浅合并又让旧对象与新对象共享同一个 `items` 数组，于是出现了跨版本拼接的那种值。）
- **修法**：状态化路由的答案一律**复制**（`snapshot()`，TS 与页面版各一份），并在两边都写明"答案不是 store 的窗口"。测试不改——是它把这个陷阱抓出来的。
- **教训**：解释器/响应构造这类"返回**活对象**还是快照"的选择，只有在有人**持有**返回值时才暴露。**测试持有它**，所以这条只有在有断言的地方才会被发现。

### 3.21 一份规则两处实现：mock 的状态机

- **症状**：没有立刻看得见的症状——这正是它危险的地方。工作台在网络层用 TypeScript 兑现 mock，交付载体（扩展的 `mocks.js`、静态单文件、书签）只能在页面里兑现，于是同一份契约有两套代码。历史上两者连**匹配**都不一样（`endsWith(path)` vs `=== path`），而这个差异在文档里写着"两边不可能行为分叉"。
- **修法**（这次一起做掉）：匹配与状态机都只留一处描述——`mock-engine.ts` 是权威，`extension.ts` 的 `buildMockEngineScript()` 是它的页面镜像（名字、顺序刻意对齐，便于逐行对照），两者靠 `__tests__/mock-engine.test.ts` 里**同一张流程表**（13 步：读、追加、再读、并入、删、404、替换、fixture 路由、不匹配、`baseUrl` 前缀、超长路径）跑过两边再 `toEqual` 比对答案。`buildMockEngineScript` 保持**纯**（不碰 `window` / `document` / `location`），就是为了让测试能在没有页面的情况下跑它。
- **同时统一的行为**：尾部回退匹配（见实施方案 §5.3）——此前页面载体连 `baseUrl` 前缀都命中不了。
- **教训**：这个仓库里"两份实现"是有先例的（`onboarding.ts` 的两份 handler），所以规则不是"永不重复"，而是**重复必须有对照测试**。没有对照的那一份，等于没有实现。

### 3.22 画面切了，键盘没跟（焦点在错误的标签页上）

- **症状**：光标停在屏幕上那个标签页的输入框里（页面收到 `blur`），agent 在后台开一个标签页 → 光标没了；切到别的标签页再**切回来** → 还是不回来，键盘留在已经不在屏幕上的那个标签页上；关掉屏幕上那个标签页 → 也没有交接。`document.hasFocus()` 在两边的答案与肉眼所见相反。
- **根因**：**Chromium 在页面 commit 时把焦点给那个 webContents，且不问它是不是屏幕上那个**（量出来的：裸 `WebContentsView` 创建时、挂进窗口后都不给焦点，第一次**加载**才给；同一个窗口里第二支 view 加载完，焦点就从第一支转过去）。而 manager 这一侧**从没有一处向标签页要过焦点**：`activateTab` 只改 `activeTabId`、重排 view、推状态。于是一旦 agent 的标签页（它总是最新那个）加载完，键盘就归它，直到有别人再来要。
- **修法**：`focusTheTabOnScreen(instance, tab)` 一处，三个调用点——`activateTab`（放在"已经是当前标签页"的提前返回**之前**）、标签页的 `did-navigate`（页面 commit 就是移交时刻）、`closeTab` 的接替分支（`activeTabId` 全库只有两处直接赋值，这是另一处）。两条守门别丢：**只在 `window.isFocused()` 时**动（`webContents.focus()` 会把窗口拉到前台，后台干活的 agent 绝不能翻窗口），**只从"另一个标签页"手里拿回**（地址栏与 rail 是人打字的地方）。**顺序也是它的一部分**：这句话必须排在"把 view 搬进窗口"（`layoutAllViews` / `raiseActiveTab`）**之后**——搬动本身会丢掉键盘，先给后搬等于没给（A/B 实测：先给再搬 → 两个 view 都 `hasFocus: false`；先搬再给 → `true`；用户实测"从标签栏切回来焦点没还给网页"就是这一条，见实施方案 §22 第十六轮末尾的修正）。
- **教训**：这类"两个独立状态跟着一个动作走"的地方（这里是"显示"与"键盘"），要成对地找一遍：**直接写 `activeTabId` 的地方就是候选**（当时全库只有 `activateTab` 与 `closeTab` 两处）。每个标签页的文档自己记着聚焦的元素，所以只要把键盘交给正确的标签页，光标就回到原处——不需要自己存"上次焦点在哪"。
- **验收**：`browser-pane-manager.test.ts` 四条（后台加载交还 / 地址栏不动 / 激活交给上屏者 + 窗口不在人手里不动 / 关闭交接）；真 Electron 读数在 `apps/electron/spike/screenshot-e2e.ts` phase 8 / 10（实施方案 §22 第十六轮）。

### 3.23 探针里 `destroy()` 一扇窗，下一扇窗的 `loadURL` 会报 `ERR_FAILED (-2)`

- **症状**：一支 spike 顺序跑四段，每段自己建窗、跑完 `window.destroy()`；第二段的 `loadURL(data:…)` 抛 `ERR_FAILED (-2)`，而**第一段同样写法的加载完全正常**，且报错 URL 与它自己要去的地方一字不差。
- **根因**（同一族：报错归错人，机制与 §3.3 相同）：Teardown 的 abort 会被交给**随后**那个 `loadURL` 的 promise——这一点是 §3.3 实测出来的（Electron 把 abort 归给"当前"那个，不给被顶掉的那个）。本机只量到"中途销毁 → 下一段加载失败 / 不中途销毁 → 四段全正常"，没有单独复现机制本身。
- **修法**：spike 里**不要中途销毁**——把窗口收进一个数组，全部跑完再一起 `destroy()`。（报错归错人这件事在应用侧也一样：看到 `loadURL` 失败，先确认它是不是被别人的导航/销毁顶掉的。）
- **教训**：`ERR_FAILED (-2)` 与 URL 对不上上下文时，先怀疑"是谁在同时拆东西"，不要怀疑 URL。

### 3.24 兜底值会把"没有尺寸"伪装成一个尺寸（页面变成 193×93）

- **症状**：用着用着，浏览器窗口里的页面变成一个很小的方块 —— 具体是 **193×93**；**切换标签就恢复**。
- **根因**：`tabAreaBounds` 用 `Math.max(200, width - TAB_RAIL_WIDTH)`、`Math.max(100, height - TOOLBAR_HEIGHT)` 防负值；而**被最小化的窗口在 Windows 上 `getContentSize()` 报 0×0**（实测；**隐藏**的窗口照旧报真实尺寸，两者不能混）。于是这个兜底把 0×0 产成 200-7 × 100-7 = **193×93** —— 一个"看着像尺寸"的数字。最小化那一刻窗口的 `resize` 触发一次布局，把这个尺寸写进了页面的 view；而**恢复窗口不会再触发一次布局**，所以页面停在 193×93，直到下一次布局（用户能做的最近一件事就是切标签）。
- **修法**：`windowHasSize(instance)`（销毁 / 最小化 / 内容尺寸非正 → 没有几何可交付），挡住"从没有尺寸的窗口布局"——`layoutTabView`、`updateNativeOverlayState`，以及 `captureWhileParked` 交回屏幕上那个标签页时（改交回它自己的 viewport）；并给窗口的 `restore` / `maximize` / `unmaximize` 加一次 `layoutAllViews`（回来这件事必须自己布局）。
- **教训**：**clamp / max / min 这类兜底会把"输入不可信"变成"输出看着合理"**，比直接报错更难发现（0×0 一眼就知道坏了，193×93 不会）。凡是几何，先问一句"这个窗口现在有尺寸吗"。测量见实施方案 §22 第十八轮。
- **验收**：`browser-pane-manager.test.ts` 的「lays nothing out from a window that has no size, and lays out again when it comes back」；真机看 `SPIKE_STEP minimized window`（`apps/electron/spike/screenshot-e2e.ts`）。

### 3.25 停车窗的两条"关系"都要有人守：不在显示器上、并且一直"被显示"

- **症状（潜在）**：停车窗被挪到屏幕上（显示器一变就露出来，用户已遇到），或者停车窗自己**被最小化/隐藏**（shell 级的"最小化所有窗口"、或我们自己一次 `hide()`）——后者更隐蔽：里面的 view 会连**视口**一起丢掉（`innerWidth` 0、CDP 输入落空），截图与"冻结"随之失效。
- **根因**：把窗口放到屏幕外、`showInactive()` 各只有一次，是**动作**；而这两件事都是**关系**——显示器会变、桌面会把够不着的窗口搬回来、别的东西会最小化它。应用侧还实测到一条有用的边界：**最小化人自己的窗口不会波及停车窗**（两扇独立顶层窗、无 owner）。
- **修法**：`keepOffEveryDisplay`（创建后、`move`/`resize`、`display-added`/`display-removed`/`display-metrics-changed` 三种时刻核对实际 bounds；挪不动就记 `parkingStuck` 停止反复试）+ `keepShowing`（`minimize`/`hide` 时 `restore()` + `showInactive()` 再来一遍）。两者都只在真正需要时才动手。
- **教训**：凡是"某扇窗必须处于某个状态"（离屏、可见、置顶…），都要问一句**谁来维持它**；一次性设置必然会被环境改掉。
- **验收**：`browser-pane-manager.test.ts` 的「keeps a window nobody may see off every display, through screen changes and being moved onto one」（显示器变化 / 被挪到 (0,0) / 被最小化 / 被隐藏）；真机 `SPIKE_STEP minimized window` 与 `background-viewport.ts` section E。

### 3.26 terminate 窗口漏页面：销毁窗口**不会**关掉 `WebContentsView` 的 webContents

- **症状**：terminate 一个浏览器窗口后，窗口和它的停车窗都没了，但**标签页的页面还在跑**（前台那个、以及停在停车窗里的那个），进程/内存不回收；反复开关窗口越积越多。
- **根因**：**视图类型不同，销毁语义不同**。chrome 用的是 `BrowserView`（窗口自己拥有，随窗口一起关）；标签页用的是 `WebContentsView`，**销毁承载它的窗口并不会关掉它的 webContents**（实测：`destroyInstance` 后窗口数回基线、停车窗 `isDestroyed: true`、三个 chrome 面都关了，但两个页面 2.5s 后仍在 `webContents.getAllWebContents()` 里，且手动 `close()` 能关掉 —— 活渲染器，不是残影）。修前 vs 修后，同一串"建了又销毁"的实例，webContents 基线 **45 → 17**。
- **修法**：在 `finalizeDestroyedInstance` 里**逐页关闭**（`clearInPageThemeTimer` + `tab.tabView.webContents?.close()`），**再**销毁停车窗——停车窗的销毁是"它已经空了"的后果，不是手段；所有销毁路径（`destroyInstance`、窗口 `closed`、过期实例清理）都汇到这里。
- **教训**：①"销毁容器 = 销毁内容"要**按类型核对**，别假设；②`webContents.close()` 之后 `view.webContents` 是 **`undefined`**（不是 destroyed 的同一个对象），清理代码不能盲读；③验证"有没有泄漏"要**按 id 核对 `webContents.getAllWebContents()`**，不要读视图上的 flag（那条 flag 在页面已经消失后仍可能说 `false`）。
- **验收**：`browser-pane-manager.test.ts` 的「closes every tab's page when the window goes, the parked ones included」（钉的是顺序：屏幕上的页面 → 停车窗里的页面 → 停车窗）；真机 `SPIKE_STEP terminate`（`apps/electron/spike/screenshot-e2e.ts` phase 12）。

### 3.27 善后代码自己也会被抛错打断：实例必须无条件离开 `instances`

- **症状**：`still destroys instance when cleanup throws`（很早就写下的用例）一直红。它把 `updateNativeOverlayState` 换成会抛错的 mock，要求实例照样离场。
- **根因**：`destroyInstance` 给自己的清理步骤都套了 `runCleanup`，但 `finalizeDestroyedInstance` 里**又调了一次** `updateNativeOverlayState`，而且是裸调——异常直接穿出 `finally`，后面的"逐页关闭 → 销毁停车窗 → `instances.delete` → `removedCallback`"**全部被跳过**。表现是：窗口已经没了，实例还留在表里（调用方继续看到一个不存在的窗口），`removedCallback` 不响，页面与停车窗都留在原地。
- **修法**：`finalizeDestroyedInstance` 里放一个局部 `step(label, action)`（try/catch + warn 日志），**每个**可能失败的动作都走它（overlay、CDP detach、逐页 close、停车窗 destroy）；`instances.delete` 与 `removedCallback` 放在这些之后、**无条件**执行。
- **教训**：①"这一步已经包了 try/catch"要看**调用点有几个**——同一个动作从两处被调用、只有一处有兜，等于没兜；②最终化函数的硬承诺要写在**无条件路径**上（不在 `try` 里、也不在 `if` 里）；③"哪个依赖坏了会怎样"值得专门 mock 一条用例，但红着的用例要能说清它是**真 bug** 还是**测试过时**（§5.2、§3.28），否则真 bug 会一直在"已知失败"里躺着。
- **验收**：`browser-pane-manager.test.ts` 的「still destroys instance when cleanup throws」（不抛 + `window.destroy` 恰好一次 + `listInstances()` 为空）。

### 3.28 四条过时用例：契约搬走了，断言还停在旧事件上

- **症状**：`focus brings the instance window to front`、`dedupes repeated focus calls before ready-to-show`、`retries toolbar load and recovers`、`loads toolbar fallback page after retry exhaustion` 一直红，但四条都**不是**产品的错。
- **三处真变化**：① 窗口的显示时机从**窗口**的 `ready-to-show` 挪到**地址栏真的载入完**（`markToolbarReady`）——没有地址栏的窗口不值得先显示出来，于是那个事件已经什么都不驱动；② 地址栏与标签栏不再是窗口 webContents 里的文档，而是各自一个 `BrowserView`——`createdWindows[0].webContents` 永远看不到那些 `loadFile`/`loadURL`，只能数到 0；③ 测试的失败旋钮 `toolbarLoadFailuresRemaining` 本意只作用于地址栏，可**标签栏加载的是同一个 `browser-toolbar.html`**（`view=rail`），谁先调用谁吃掉失败，最后连期望的 3 / 5 到底该算哪一面都说不清。
- **修法**：用例走真契约——`finishLoadingTheBar(instance)`（把地址栏 `getURL` 指向 `browser-toolbar.html` 再 `_emit('did-finish-load')`）；计数改成数 `instance.toolbarView.webContents`；mock 按 `view=bar` / `opts.query.view === 'bar'` 认面，把旋钮钉在地址栏上。
- **教训**：①"测试红了"先问**契约是不是搬走了**，不要直接改断言去迁就现状（那会把真 bug 一起固化）；②mock 里的"全局开关"会**跨面泄漏**，开关必须钉在它真正针对的那一个东西上；③`cancels deferred focus when hide happens first` 原来也发 `ready-to-show`（空转，只是"恰好绿"），一并改到地址栏就绪后，它才真的在测"hide 取消待显示"。
- **验收**：`cd apps/electron && bun test src/main/__tests__/browser-pane-manager.test.ts` → **162 pass / 0 fail**。

---

## 4. 已删除的机制（墓园）

这些概念**现在不存在**，别再按它们讨论设计；列在这里只为回答"当初为什么删"。

| 机制 | 曾经为了什么 | 为什么删 | 现在怎么做 |
|---|---|---|---|
| **Capture**（`prototype-capture --url`，把在线页冻成 `base.html`） | "总得有个页面才能打补丁" | 它回应的是一个**不存在的需求**：overlay 的补丁打在活页面上，不需要 `base.html`；冻出来的副本跑不了自己的 JS、也带不来会话，只是**看起来像**那个页面 | overlay 的页面**就是**那个在线地址 |
| `prototype-import --from <slug>` | 从另一个原型拿一份起点 | 它把**材料**与**身份**混在一个动作里（搬完 kind/targetUrl 不变，界面上看不出来），而且人真正想要的是"一份能接着改的副本" | 列表右键**复制**：整份复制成一个**新原型**（`duplicatePrototype`） |
| MSW + Prism（D8 原方案）、`dist/mock-server/`、`dist/msw-handlers/` | 用现成 mock 工具跑契约 | 要引两个新依赖，且页面级 mock 覆盖不到 axios 用的 XHR | CDP `Fetch` 拦截（fetch/XHR/任意资源全覆盖，零新依赖） |
| `file://` 作为原型文档载体 | 最省事地打开本地 HTML | origin 是 opaque：没有 cookie 域、**相对 `fetch`/XHR 发不出去**（mock 层永远看不到请求）、ES module 被 CORS 拦 | Electron 应答的 `http`（`protocol.handle`）：一个原型一个 host、目录即 origin 根（实施方案 §16） |
| 放开面 partition（`webSecurity:false`） | 让页面脚本自己跨域 | 代价是不可回退的安全弱化，而收益只是"省掉一层 CDP 封装"；能力用 CDP 同样能拿到 | 安全姿态未变：`sandbox` / `contextIsolation` / `nodeIntegration:false` / `webSecurity` 默认开 |
| 落盘的 `manifest.json` 补丁索引 | 记录有哪些补丁 | 多个写者并发写一个共享索引是最大争用点 | 派生索引：每次从 `patches/` 重算（`scanPrototypePatches`） |
| 「起手形态：本地 dev server」（原 D6） | 区分 dev server 与线上 URL | 它不是一条决策：patch 对任何源页面都是覆盖层，两者在**产出**上没有区别 | 分野改按**产物性质**（overlay / scratch） |
| 创建时预置空 `base.html` | 避免"新原型每个动作都是灰的" | 灰按钮的成因是"没有页面就不能打开"，该由**入口**解决；空文档只是把死胡同伪装成一条路 | 不预置；首稿由 agent 写或复制而来 |
| 面板「保存为补丁」与详情页源码编辑器 | 点一下就能改文案 / 直接改产物文件 | 前者让补丁数量由**点击次数**决定，后者把工程侧界面摆到工作台正面 | 补丁只有一个来源：**agent 写**（实施方案 §12.4） |
| 详情页那四个入口（打开目标页面 / 打开浏览器窗口 / 捕获为底稿 / 导入其他原型） | 让用户手动准备环境 | 每一个回答的都是**机器需要什么**，不是用户想要什么；「打开浏览器窗口」尤其是实现约束漏到界面上的产物 | 由 agent 用 `browser_tool` 承担；详情页只有「预览 / 在对话里改 / 导出」 |
| **项目指定"当前原型"**（`ProjectConfig.defaultPrototypeSlug` + `projects:setDefaultPrototype` + agent 的 `prototype-default` + 会话继承"恰好一个"） | 多原型项目的对话开箱就用某一个：`会话绑定 ?? 项目当前原型 ?? 唯一成员` | 它回答的是"**项目替会话挑一个**"，而挑就是猜——为这一个答案要多一个配置字段、一个受校验的写入者、一条 RPC 通道、一条命令，以及"声明的那个被移走了怎么办"的悬空故事；而"恰好一个"也是同一个机制的另一副面孔 | 项目只**记**自己的工作在哪些原型上（`ProjectConfig.prototypeSlugs` → `<project_prototypes>` 的一列，§15.1.3）：背景信息，不绑定、不继承、不解析、不注入原型上下文，会话要么自己绑，要么按名调用。**是集合不是"当前原型"**：项目同时在几个原型上工作，挑一个就是猜 |
| **原型属于某个项目**（`PrototypeConfig.projectSlug` 那条边 + `listPrototypesForProject` 的成员列表 + `prototype-project` 命令 + `prototypes:setProject`） | 项目详情页列出"这个项目的原型"，会话的 `<prototype_context>` 说"哪边放新文件" | 一个原型会被**多个对话**绑定，而那些对话可以属于不同项目——"它属于项目 A"不是事实，"这个项目有哪些原型"也不是该问的问题（§15.1.4） | 原型**不记**自己属于谁；项目侧只留一条背景记录；要找原型用 `list` |

---

## 5. 验证与基线

### 5.1 常用命令

```bash
# 类型检查（逐包跑，便于定位是哪一层坏了）
# 前两条从仓库根跑；其余在各自包里
bun run typecheck:shared
bun run typecheck:electron
cd packages/server-core && bun run tsc --noEmit

# 测试（原型相关的四个；前两条合计 566 pass；把路径换成任意文件即可单跑一个）
cd packages/shared      && bun test src/prototypes                              # 376 pass
cd packages/shared      && bun test src/agent/__tests__/tool-commands.test.ts   # 190 pass
cd packages/server-core && bun test src/domain/__tests__/apply-prototype.test.ts  # 17 pass
cd apps/electron        && bun test src/main/__tests__/prototype-host.test.ts   # 38 pass

# 全量（失败基线见 §5.2）
cd packages/shared      && bun test

# i18n（改到 strings/locales 时）
bun run lint:i18n:parity                    # i18n parity OK (6 locales, 1879 keys each)
bun scripts/sort-locales.ts                 # 加过 key 之后跑一次，排序是 lint 强制的
# lint:i18n:coverage 在这个 checkout 跑不了：scripts/check-i18n-coverage.ts 不存在（§3.10）

# 渲染层构建（改到 renderer 或共享包导出时务必跑，见 §3.6）
cd apps/electron && bun run build:renderer
```

### 5.2 既有失败基线（**改代码前先跑一遍**）

这些失败**与原型工作台无关**，别算到新改动头上：

- `packages/shared` 全量：本机（Windows）有一批**环境相关**的既有失败（最近一次实跑约 38 个，数量随 checkout 变化，以实跑为准），集中在：plans 目录/PowerShell 写入判定、session 路径与路径穿越、`sdk-bridge` 环境变量、`buildCallLlmRequest` 附件、`ensureDefaultPermissions`、`uiLanguage` 幂等、`validateStdioMcpConnection` ENOENT、`sanitizeAssetFilename`、`serializeSession`、plan 执行持久化。都别算到新改动头上。
- **`routing.test.ts` 那两条已经绿了**（实测 `cd packages/shared && bun test src/protocol` 全过）：`prototypes:replay` / `setPages` 已经补进分类（§3.7；`prototypes:commit` 随折叠改到复制上整条删掉，`setProject` 随 §15.1.4 删掉了）。但**加通道时仍然要同时改注册表与 routing**，否则这两条会立刻红。
- **typecheck 这条线已经干净**：页的归属改名（`BrowserTabSummary.belongsTo: TabBelongsTo`、`BrowserCapabilityRequest.work`、`assignTab(instanceId, tabId, to, by)`）早已完成，`packages/shared/src/tasks/outputs.ts` 那处 `ParsedOutputs.problems` 也已修，实测 `bun run typecheck:shared` 无报错。（`outputs.ts` 仍是**未跟踪**文件——判断自己有没有引入类型错误时，按包单独跑 `bun run tsc --noEmit` 比 `typecheck:all` 更快定位。）
- **"哪一段"只有一处定义**：`tabSectionOf`（`packages/shared/src/protocol/dto.ts`——`person` / `session:<id>` / `task:<slug>`）。rail 与徽章画段读它，主进程决定"关掉一个标签页之后谁接替"也读它。**别在 rail 之外再写一遍"按会话/任务分段"**：画出来的段与交接用的段一旦不一致，表现是"接替跳到了别的分组"，从现象看不出是哪一边错。它是 `sameWork` 的粗版（任务的不同节点算同一段），所以**不能当权限判据用**，reach 只认 `sameWork`。
- `apps/electron` 的 `browser-pane-manager.test.ts`：源码树里**已 0 失败**（162 pass，2026-09-21 实测）。曾经挂着的 5 条窗口生命周期用例已清理：`focus brings the instance window to front`、`dedupes repeated focus calls before the bar has loaded`、`retries toolbar load and recovers`、`loads toolbar fallback page after retry exhaustion` 是**契约搬走了**（显示时机改到 `markToolbarReady`、地址栏/标签栏各是 `BrowserView`，§3.28）；`still destroys instance when cleanup throws` 是**真 bug**（`finalizeDestroyedInstance` 的清理步骤没有兜，§3.27）。（`destroys child popups…` 曾在这份名单里：它是 CDP mock 缺 overlay 方法导致的 `teardownOverlay is not a function`，补上 mock 后已绿；element picker 那批用例的失败来自旧桩名 `armPicker`/`cancelPicker`，同期改成 `armOverlay`/`teardownOverlay` 后也绿了。）
- 同一次全量跑里还有 **4 个路径相关**的失败：`use-working-directory-state.test.ts` 的 `deriveSortedRecent` 1 条与 `deriveSelectionFlags` 3 条（自定义目录 / `folderName` 回退）。它们在 renderer 的工作目录状态里，按 basename 判路径——**Windows 上本机既有**，与浏览器窗口无关（最近一次全量：1183 pass / 4 fail = 只剩这 4 条）。
- **测试路径会连带跑 `release/win-unpacked/resources/app/...` 下的旧副本**：`bun test <路径>` 会把打包目录里那份同名测试也收进来，于是失败数与通过数**翻倍**；而且那份旧拷贝会多出 2 个**源码树里已经通过**的失败（`replays toolbar state with theme color when window is shown`、`replays full toolbar state when toolbar renderer finishes loading`）。判断"是不是我引入的"时先排除这些重复项。

### 5.3 测试落点

| 模块 | 测试 |
|---|---|
| 补丁变换 | `packages/shared/src/prototypes/__tests__/prototypes.test.ts` |
| 标记解析（`@target` / `@requirement`，含"写成词就不算"与"一行一个"） | `__tests__/patch-header.test.ts` |
| 锚点记录（合并写、fingerprint 保留、漂移 / 孤儿判定、坏 JSON 容错、两个探针可编译） | `__tests__/anchors.test.ts` |
| 折叠（两类页各自的落点、provenance 标记存活、幂等、拒绝、锚点清理、Z 排最后；以及"折的是副本、原件一个字节不动"） | `__tests__/fold.test.ts`、`__tests__/duplicate.test.ts` |
| 索引扫描 / 命名过滤 / 补丁的页域（`scanPrototypePatchesForPage`、`listPrototypePatchPages`） | `__tests__/prototypes.test.ts` |
| 配置与页表规范化、旧配置的读时提升（`legacyPageRows`） | `__tests__/config.test.ts` |
| 页的判定与页表合并、页表增删改（add / remove / rename / entry） | `__tests__/pages.test.ts` |
| 渲染与导出（按页取补丁、dev-spec 按页分节、入口 / 页索引、提升后的旧配置逐页一致） | `__tests__/export.test.ts` |
| 扩展包（manifest / README / 页面变换 / mock / 按页分文件 / options 页 = 页索引） | `__tests__/extension.test.ts` |
| 所有权（有规矩的路径 + 作者自己的文件夹默认放行） | `__tests__/ownership.test.ts` |
| 契约合成与 mock 路由 | `__tests__/contract.test.ts` |
| **mock 状态机**（方法 → op 的推导与拒绝、`state.json` 的读与上报、多服务 store 的合并与冲突、13 步流程的答案、**同一张表跑过 TS 与页面两套实现**） | `__tests__/mock-engine.test.ts` |
| **网络层兑现**（匹配/前缀回退、请求体读取、store 跨请求可见、每次 apply 重置、body 读不出时 500） | `apps/electron/src/main/__tests__/browser-cdp-fetch-mock.test.ts` |
| prompt 块（页列表与每条补丁的页域） | `__tests__/prompt.test.ts` |
| 需求线（PRD → 页 / 补丁 / findings；折入 `assets/<页名>/committed.*` 后仍接得上、dev-spec 需求表、异议挂在需求行上） | `__tests__/coverage.test.ts` |
| 命令层（runtime，两条门的分发、help、互不认领的措辞） | `src/agent/__tests__/tool-commands.test.ts` |
| 注入时跳过已内联；命中 / 未命中 / 漂移的报告与锚点记录；`replayPrototypeInBrowser` 的两种含义 | `packages/server-core/src/domain/__tests__/apply-prototype.test.ts` |
| **验收执行器**（`endpoint` 断言的命中与不命中、无窗口时 `skip` 而非 `fail`、页面读不到时的 `skip`、轮次与 diff 的五类、`skip` 不算红、页面名回填、失败该怎么辩、"没有 check" 与"check 被删光"分开） | `packages/server-core/src/domain/__tests__/verify-prototype.test.ts` |
| 原型的应答（入口页 / `/_index` / 页名 302 / 文件优先 / 入口文档不在 / 越界 / pass-through / SPA 回退） | `apps/electron/src/main/__tests__/prototype-host.test.ts` |
| 窗口与地址栏 | `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`（含关闭标签页的接替：同段优先、段内没有才按位置，§22 第十四轮） |
| 标签页的归属与两条边界（reach / close、`tab-assign`、重跑节点接管旧标签页、兄弟节点不放行、锁在指名的那个标签页上） | `packages/server-core/src/domain/__tests__/tab-access.test.ts` |
| 标签栏 / 徽章的分段（按"谁的活"分段、**人的段钉在最前**、任务节点不拆段、**只有"你"一组时不画段头**、段内缩进与引导线、段头的 `+` 建出的标签页归属该段且落在段尾、从当前标签页找"跳回哪个对话/任务"） | `apps/electron/src/renderer/components/browser/__tests__/tab-groups.test.ts`、`.../utils.test.ts` |
| **并线的两张接缝**（`writes:` 的三条拒绝：不可用 / 保留 `Z` / 同 run 重复；派发时盖章到子会话 `taskWrites`，不声明就不盖；**两个写者同时在飞、各自带自己的身份**） | `packages/shared/src/tasks/schema.test.ts`、`packages/server-core/src/tasks/TaskRunner.test.ts` |

### 5.4 只能在真实窗口里验的项（跑起 Electron 之后）

| 项 | 怎么验 | 不对时看哪 |
|---|---|---|
| 改完即见 | 用外部编辑器改一条补丁 → 该原型**已打开的窗口** 1 秒内自己跟上（我们自己的页刷新、活页面重新打补丁）；连存三个文件只跟上一次 | `usePrototypes` 里的 `prototypeSlugForChangedFile`（路径是不是落在 `patches/`、`assets/`、顶层 `.html`）；`prototypes:replay` 有没有找到那些标签页（它逐窗口读标签列表，找 `tab.prototype.slug === slug` 的**每个标签页**——同一个窗口里两个标签页同一原型也要各重放一次，§22 第十三轮） |
| 收敛之后效果不变 | 复制一个原型并选「复制并折叠改动」→ 打开**副本**那一页，改动**还在**且和折入前一样；原件与它的补丁文件都还在 | 副本里折进去的文件（`patches/<页名>/Z-00x-upper.*` 或 `assets/<页名>/committed.*`）；Z 是不是真的排在最后（`status` 的补丁清单按重放序列出） |
| 原型页在无端口地址上打开 | 打开一个页是我们自己的原型 → 地址栏是 `http://<label>.localhost/`，页面带着**这一页**的补丁 | 主进程日志里有没有 `[prototype-host] answering prototypes at …`；handler 是不是装在了 `persist:browser-pane` 上 |
| **补丁在刷新后仍在（活页面）** | 打开一个 overlay 页的原型（视图停在真实站点）→ 页面带补丁 → **点刷新** → 补丁还在；再点一个站内链接 → 也在（持久注入不是一次性动作）。我们自己的页不走这条路：它每次请求都由宿主按盘重渲染（§16.6） | `addInitScript` 有没有开 Page 域（`enablePageDomain`）——域关着时注册照样返回 identifier 而新文档里不跑（§3.1）；日志里有没有 `[browser-cdp] idle detach`（那说明注册已经丢了） |
| 页名与入口在真窗口里对得上 | 开根地址 → 落在入口页；没配入口时落在**页索引**，点一页进得去；`snapshot` 的 `Prototype:` 行带 `page "<名字>"` | `status` 的 `pages:` / `root:` 两行；`matchPrototypePage` 认不认得出窗口的真实 URL（overlay 的跳转、SPA 路由都算） |
| 地址栏写着"哪一页"，而且敲得回去 | 在一个 overlay 页上（视图停在真实站点）→ 地址栏是 `http://<label>.localhost/<页名>`；把它敲一遍回车 → 回到**同一页**（不是入口页），地址栏照旧 | `main/index.ts` 注入的 `pageOfPrototypeUrl`（认地址）与 `pageResolver`（认窗口在哪一页）；页名对不上时只写原型域名 |
| 敲普通网址 = 交出这个标签页 | 从原型打开的窗口里敲 `https://example.com` 回车 → 地址栏写目标地址，标签栏那一行不再标原型/页名，「应用补丁」变灰；按 Back 回来仍然如此（粘性）。敲自己域名上的 `/dist/…` 或某一页的真实地址 → 标签页还是它的 | `browser-toolbar:navigate` 处理器里那一段（`prototypeReleased`）；`__tests__/browser-pane-manager.test.ts` 的「gives the tab up…」「keeps the tab…」 |
| **键盘跟着屏幕走** | 在屏幕上那个标签页的输入框里点一下（页面自报"光标在框里"）→ agent 在后台开一个标签页并等它加载完 → 那个输入框**不该**收到 `blur`；切到别的标签页再切回来 → 光标回到原处；关掉当前标签页 → 接手的标签页拿到键盘。全程 `BrowserWindow.getFocusedWindow()` 不变 | `focusTheTabOnScreen`（`browser-pane-manager.ts`）与它的三个调用点（`activateTab` / 标签页的 `did-navigate` / `closeTab` 的接替分支）；真 Electron 读数在 `apps/electron/spike/screenshot-e2e.ts` 的 phase 8 / 10，看 `afterTheAgentOpenedATabBehindIt`、`afterSwitchingBackToThePersonsTab`、`afterClosingTheTabOnScreen` 三处（§3.22、实施方案 §22 第十六轮） |
| **后台标签页不被人的 resize 打扰** | 在屏幕上那个标签页里把窗口拖大、再拖小：屏幕上那个的 `innerWidth` 跟着变，**后台那个的 `innerWidth` 与 `resize` 次数都不动**，而且它**不在人的窗口里**（在停车窗，所以再小的窗口也露不出它）；截后台那张图，图片尺寸是**它自己的视口**；切到它才跟着窗口变一次。另外看一眼停车窗**不在任何显示器上**（它是"关系"，不是一次摆放：把窗口坐标挪到 `0,0`，600ms 内应自己回到屏外） | `parkingWindowFor` / `parkTab`（`browser-pane-manager.ts`）：不在屏幕上的标签页出生就在离屏停车窗，`layoutTabView` 只给屏幕上那个 `setBounds`；`keepOffEveryDisplay` 负责"确实不在任何显示器上"（放远只是请求：桌面会钳到 16383，显示器变化与窗口被挪回屏幕都靠它兜）。**别把 view 移到窗口外或 0×0**：那样 Chromium 给它的视口是空的（`innerWidth` 0、CDP 输入落空、截图 0×0），测量见 `apps/electron/spike/screenshot-e2e.ts` phase 11 与 `background-viewport.ts`（§22 第十七轮） |
| **真实站点的 pass-through 无损** | 在同一个窗口打开一个真实站点：上传一张图（分块）、播一段视频（流式）、下载一个文件、来回导航看缓存 | `net.fetch` 那一行；必要时把 handler 临时换成只打日志的版本做二分（见 §3.11） |
| 我们的 host 上 cookie 能回写 | 在原型页里 `document.cookie='a=1'`，刷新后读回 | 同上；回环时代这条是通的 |
| 真实浏览没变慢 | 同一个站点，装/不装 handler 各开一次，比首屏与资源加载 | 那一跳 `net.fetch` |
| 重启后 origin 不变 | 重启应用 → 同一个原型的地址与上次一致，cookie / localStorage 还在 | 这正是换载体要拿到的结果 |

---

## 6. 调试入口

- **地址栏语法**：敲原型的**根地址** = 打开这个原型（主进程用 `resolveServedPrototype` 反查 label，并把窗口绑到这个原型上）；敲原型内部的路径（`/cart.html`、`/dist/extension/cart.html`、SPA 路由）= 普通导航。**不经面板的加载器**（agent 的 `navigate`、任何直接请求）取根地址 = **入口页**：是 overlay 就 `302` 到它自己的地址，是我们自己的页就渲染（文档 + **该页**的补丁 + `_layout.html` 共享布局；该页的行写了 `useLayout: false` 时不套布局，按文档原样送出，§19.2）；**没有行带 `entry` 时给的是生成的页索引**。`/_index` 恒给索引，`/<页名>` 对 overlay 是 `302`，而且**文件优先于页名**。
- **原型优先于对话**：原型可以先存在，`prototypes/<slug>` 目录建好就有地址与页面；对话是来访者——`handleOpenChat` 在没有对话时新建一个（`prototypeSlug` 落在会话头上），有对话时复用；同一个 `prototypeSlug` 可以挂在多个会话上，`prototype_tool` 命令按会话解析。窗口的身份则与对话无关（见上一条）。
- **面板工具栏为什么不亮**：工具栏在独立渲染进程里，拿不到 workspace / 会话——它只显示主进程推来的地址与 `prototypeSlug`；两个按钮的可用性完全由那个 slug 决定（没有原型就置灰）。slug 有两条来路，主进程按这个顺序答（`prototypeBindingFor`）：**窗口被打开时声明的原型** → **会话链**（窗口所属会话在做哪个原型）。只留后者时，"刚创建、还没有对话"的原型点「打开」会得到地址栏写着真实 URL、按钮全灰的普通窗口——这是 §3.3 同一族的身份缺失，已修。
- **"补丁没生效"还是"页面不是这一页"**：先看 `status` 的 `pages:`（每页带类型、地址或文件、`[entry]`）与 `root:` 两行，再看 `page issues:`——`patches/<页名>/` 对不上任何页、声明的页文档不在、行读不干净都在这里点名（§19.4 / §19.8）。`apply` 的输出也会说这次重放的是**哪一页**的补丁（没有页就是"只有共享补丁"），所以"改错了页"和"补丁没生效"分得开。
- **"这个文件为什么没人管"看哪一段**：解析不出名字的补丁文件（`patches/oops.css`）**不在** `page issues:` 里——它在 `ownership:` 那一段逐条点名（`status.ownership.violations`；这一档已不在详情页上——它对人是没有动作可做的）。`page issues:` 管的是页表本身与"对不上任何页的 `patches/<页名>/`"。查"某个文件没生效"时别只搜前者，**验证"某某会不会被点名"先确认它归哪一段**（本工作台把这两类事实分开放，是有意的：一个关于页表，一个关于所有权）。
- **"补丁没生效"还是"选择器不对"还是"页面变了"**（§21.1／§21.2）：`apply` 的输出把三种情形分开了——没写 `@target` → "nothing could check these"；写了但从来没命中过 → "matched nothing"（选择器错，或页不对）；写过且**记录过命中**、现在 0 命中 → "the page moved"，并给出页面上现在的候选选择器。第三种要靠 `anchors/<scope>.json` 里的旧 fingerprint 才判得出来，所以那个文件**别手删**（删了下次 apply 只能重新从零开始记）。
- **收敛之后效果变了**（§21.3）：折叠是文本折叠，它不知道"语义等价"。先按 §5.4 那两条在真窗口里对照一次；`status` 的补丁清单按重放序列出，`Z-*` 必须排在最后——不是最后就说明顺序规则被改坏了（`storage.ts` 的 `byReplayOrder`）。
- **交付物**：`dist/extension/` 在 `chrome://extensions` Load unpacked；**options 页是生成的页索引**（点一页就过去），工具栏图标开入口页；改完补丁要重新导出并在该页点 **Reload**（快照语义，见实施方案 §17.4）。`dist/dev-spec.md` 按页分节。另两份载体：`dist/static/` 每页一份自包含 HTML（双击即看，只覆盖我们自己写的页）、`dist/bookmarklet.html` 是 live 页的书签（页面策略拒绝时粘控制台，同一份代码）——三份的取舍见 §17.8／§17.9。
- **契约 mock 不生效**：先看路径是否只按 pathname 匹配、以及请求是否由页面自己发出（PWA 的 service worker 请求不经过页面）。
- **原型页打不开**：先看主进程日志有没有 `[prototype-host] answering prototypes at …`；地址形如 `http://<label>.localhost/`（无端口），而且**只有被打开/导出过的原型才注册过**——没注册过的地址答 404 是对的。根地址答 404 并点名一个页名时，是**入口页的文档不在**（不会退回索引，§19.3）。
- **真实站点行为异常**（上传、流式、下载、缓存）：先怀疑 pass-through，按 §3.11 的三条约定对一遍，必要时把 handler 换成只打日志的版本二分。
