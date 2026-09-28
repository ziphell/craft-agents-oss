# 产品经理需求生产工作台 — 开发文档

> **定位**：[实施方案](prototype-workbench-plan.md) 写「是什么、为什么」。本文写「代码在哪、哪些不能碰、怎么验证」。
> 读法：改代码前看 §1（模块地图）与 §2（不变量）；想知道「某个概念为什么现在没有了」看 §4（墓园）。
> 用词与文案的口径（tab / 地址 / page、那个窗口的名字、给用户看的文案）见 [术语与文案规范](vocabulary.md)。
>
> **一句话**：把**需求**和**实现它的文件**绑在同一个文件夹里的规格工作台。人写规格（markdown 里 `## R-001 <标题>`，一个文件或几个），agent 用普通文件工具在同一文件夹里实现，工具只回答两句话：**哪个需求没人实现**、**哪个引用指向不存在的需求**。
>
> **一个原型 = 一个文件夹，只有四类内容**：规格（一个 markdown 文件或几个）、旁边的材料（任何格式）、`research/`（findings）、`reviews/`（disputes）。**唯一机制**是 `@requirement R-00x`——写在任何文件里即"这个文件服务于那条需求"；需求↔实现不存第二份，读时现算。实现、findings、disputes 全由 agent 用 Write/Edit 写，`create` 只建文件夹与起步 `PRD.md`。

---

## 1. 模块地图

### 共享层 `packages/shared/src/prototypes/`（16 个模块 / 2572 行）

| 文件 | 行 | 负责 |
|---|---|---|
| `types.ts` | 40 | `PROTOTYPE_RESEARCH_DIRNAME` / `PROTOTYPE_REVIEWS_DIRNAME` 与共享类型。**零依赖**（§2③） |
| `wiki-links.ts` | 124 | `[[…]]` 的解析与改写（`extractLinkTargets` / `rewriteWikiLinks`），跳过代码段与 fence。**零依赖叶子**，渲染层从这里取运行时值（§2③、§2⑫） |
| `storage.ts` | 132 | 目录内路径（目录 / `research` / `reviews`）、`listPrototypeFiles()`（**递归**列出目录内文件，任何格式、不做任何过滤、名字是原型相对路径；跳过 `research/`、`reviews/` 与隐藏项）、`isMarkdownFile()`、`contentFingerprint()` |
| `requirements.ts` | 250 | 需求解析：`## R-00x` 是唯一机制，读**每个** `.md`/`.mdx`（`parseRequirementDocument` / `readPrototypeRequirements`），每条需求带上**定义它的文件**；跨文件重号被点名。`extractRequirementIds`（`@requirement` 标记）、`requirementFingerprint`。`PROTOTYPE_PRD_FILENAME` = `PRD.md` 只是 `create` 的起步文件名 |
| `links.ts` | 174 | 文档间的 `[[…]]`：`readPrototypeLinks()`——只扫 markdown，按「本文档目录 → 原型根 → 唯一文件名」解析（`../` 归一化，`[[name]]` 可省 `.md`）；链不到或重名 → issues。**不动"实现"判定**（§2⑫） |
| `research.ts` | 206 | `research/*.md` 的 finding（`# F-001` + `claim:` / `source:` / `captured:` / `evidence:` / `requirements:`）解析，以及 `evidence:` 的存在性检查 |
| `reviews.ts` | 332 | `reviews/*.md` 的 dispute 解析（`status` / `about:` / `on:` / `claim:`）、与盘对账判 `stale`（`judgeAgainstDisk`）、`isUnresolved` |
| `coverage.ts` | 249 | 需求 × 依据（文件 / findings / reviews）→ 每条需求的引用关系、未实现、悬空引用；`research/`、`reviews/` 与**定义需求的文件**都不算实现 |
| `status.ts` | 308 | 报告（`buildPrototypeStatus` / `listPrototypeStatuses`）+ 门禁 `whyPrototypeIsNotSettled`（两条：有需求没人实现、有 dispute 还立着）。报告把 `specificationFiles`（定义需求的文件）与 `files`（其余材料）分开，并带上 `links`；断链进 `briefIssues` |
| `notices.ts` | 99 | 可翻译的 notice：`code` + `params` + 由同一组 params 生成的**英文句**（agent 输出与详情页共读） |
| `prompt.ts` | 243 | 绑定会话的 `<prototype_context>` 块（`buildPrototypePromptContext` / `formatPrototypeContextForPrompt`） |
| `project-link.ts` | 84 | 项目侧「碰过哪些原型」（`ProjectConfig.prototypeSlugs`，背景记录，不绑定不解析） |
| `create.ts` | 106 | 建文件夹 + 起步 `PRD.md`（`createPrototype` / `prototypeSlugFromName`） |
| `duplicate.ts` | 93 | 整份复制成一个新原型（`duplicatePrototype`，**只有界面用**） |
| `delete.ts` | 43 | 删除整个目录（`deletePrototype`，**只有界面用**） |
| `index.ts` | 89 | barrel。**渲染层只能对它 `import type`** |

### agent 面

- `packages/shared/src/agent/prototype-commands.ts`（259 行）：命令体 —— `executePrototypeToolCommand` / `runPrototypeCommand`（`list` / `create` / `status`）/ `getPrototypeToolHelp`。解析不出就回 `null`。
- `packages/shared/src/agent/prototype-tools.ts`（112 行）：`createPrototypeTools` + `PROTOTYPE_TOOL_DESCRIPTION`（工具描述的另一份在 `session-tools-core`，见 §2①）。
- `packages/shared/src/markers.ts`：`markerIndex`（标记不是词的一部分）/ `cleanMarkerValue`。`@requirement` 的识别靠它。
- `packages/shared/src/agent/command-cli.ts`：两门共用的 CLI（分词、`--` 选项、结果形状、`createCommandRunner`）。它不知道任何一扇门。
- `packages/shared/src/prompts/system.ts`：`prototypeContext` 块的位置，以及**原型指南**——`getPrototypeGuideSection()` 把整份 `prototypes.md` 注入系统提示。
- **两个 backend 各建一次 prompt 上下文**：`packages/shared/src/agent/claude-agent.ts`（首轮 pin `pinnedPrototypeContext`，之后漂移只提示）与 `packages/shared/src/agent/pi-agent.ts`（每轮 `resolvePrototypeContext`；同文件底部的 `PANE_TOOL_EXECUTORS` 是命令分派表）。
- 工具注册与显示：`packages/session-tools-core/src/tool-defs.ts`（`PrototypeToolSchema` + 描述 + 注册行）、`packages/shared/src/agent/session-scoped-tools.ts`（`CLAUDE_BACKEND_SESSION_TOOL_NAMES`）、`packages/shared/src/agent/mode-manager.ts`（always-allowed 清单 + 写原型目录的放行）、`packages/ui/src/lib/tool-parsers.ts`（命令预览）、`packages/server-core/src/sessions/SessionManager.ts`（显示名 `"Prototype"`，以及 `listPrototypes` / `createPrototype` / `getBoundPrototypeSlug` 的装配）。
- agent 指南：`apps/electron/resources/docs/prototypes.md`（工具描述与 `--help` 都指向它）。

### RPC 与渲染层

- 通道：定义在 `packages/shared/src/protocol/channels.ts`，分类在 `packages/shared/src/protocol/routing.ts`；handler 在 `packages/server-core/src/handlers/rpc/prototypes.ts`（`list` / `create` / `duplicate` / `delete` / `watch` / `unwatch` / `changed`，watcher 100ms 去抖），注册进 `packages/server-core/src/handlers/rpc/index.ts`；渲染层经 `apps/electron/src/transport/channel-map.ts` 与 `apps/electron/src/shared/types.ts` 的 `window.electronAPI.*` 桥过去（见 §2④）。
- `apps/electron/src/renderer/pages/PrototypeInfoPage.tsx`：详情页——需求（`PRD.md` + 每条被谁引用）、研究、文件。**文件列表里的"材料"凡是 app 自己能显示的，点名字就是"看"；还有第二种动作（改）的那些，行内多一个铅笔**（详情页自己托管的三种由 `inAppKind()` 判定，**其余一律落回全局的 `classifyFile()`**；行内图标与点击读的是同一条判断，所以图片画的是图片图标、点开就是 app 内置的大图）：
  - `.drawio`：点名字 = 大弹窗看图（`DrawioOverlay initialMode="view"`；**开之前先在详情页里读文件**，因为查看器要的是文档本身，读不出来就走详情页自己的错误行而不是给一张白画布），行内铅笔 = 编辑器（`initialMode="edit"`，编辑器自己读文件，它还要知道"从哪一版开始改"）。**大窗头部的铅笔在两面之间切**（`headerActions` 里，编辑器那面显示眼睛；只在 `onWriteFile` 在时画），所以看图那条路也有编辑入口；切回看图时画的是**本次窗口里写过的最新文档**（`written ?? xml`），不是开窗时那份。看图期间 `status` 每次刷新会重读一次，agent 改完图会重画。
  - `.html`/`.htm`：点名字 = **大窗里画这份 HTML**（`HTMLPreviewOverlay`，与 `html-preview` 块同一个窗口；走的是 app 那条通用开路 `onOpenFile` → `useLinkInterceptor` → `classifyFile` 判成 `html` → 读文件 → 大窗）。**这一跳不由详情页自己决定**：这一行 HTML 和聊天里的一条 `.html` 链接走的是同一个判断，详情页只是又一次点击。**它是一个文档，不是一个浏览上下文**：frame 是 `srcDoc`，没有自己的地址，所以相对引用、脚本、`fetch` 都不成立（相对链接会解析到 app 自己的地址——这条路的已知粗糙边，见 `HTMLPreviewOverlay` 头上的说明）。**要让这份 HTML 真的在浏览器里跑起来，用大窗头部右上角的「在浏览器中打开」**（`preview.openInBrowser`）：它在工作区的浏览器窗口里以 `file://` 开这个文件，成为一个有自己地址的 tab——那里相对引用、脚本、链接全对，而且那是 agent 接得上的面（`browser_tool` 驱动的是窗口里的 tab，驱动不了渲染层里的 frame）。**那颗按钮走哪个浏览器由应用偏好决定**（`UserPreferences.openInAppBrowser`，缺省应用内；关掉即系统默认程序），与链接同一个开关，见下一条。行内铅笔 = 大窗直接开在 `initialMode="edit"`（`HtmlDesignEditor`，写回文件）；**点名字这一档是纯查看**（HTML 以 `__single__` 一项交给大窗，没有写回目标，所以头部那颗看 / 改开关不出现——"改"是行内铅笔的事）。**这一档没有"看源码"的面**：读 markup 是编辑器的事，一行之遥。读不出来时退回代码大窗报那行错误，跟 json / drawio 两个分支同一个做法。
  - `.md`/`.mdx`：点名字 = 大弹窗**读**这份文档（`MarkdownFileOverlay`，里面是 `MarkdownEditorPane` 的渲染面；`initialMode` 缺省就是 `'view'`）。**行内没有铅笔**：大窗头部自带"看 / 改"那个铅笔（`headerActions`），行内再来一个只是同一个开关的第二个位置（见 §7.4）。
  - **`html-preview` 块还是"消息里的画面"**：无脚本、无 `base` 的静态 HTML（`HTMLPreviewOverlay` + `srcDoc`）——但它的**大窗与上面那条是同一个窗口**，所以也有同一颗「在浏览器中打开」：块经 `PlatformContext.onOpenFileInBrowser` 把"屏幕上是哪一个"（`src`）交给宿主，宿主持着 `openFileInBrowser`，按偏好决定去内置窗口还是系统浏览器。**块自己（消息里那张卡片）只有入口**：页签、铅笔（开编辑器）、放大（开大窗）——那颗按钮是"对这份 HTML 做的事"，属于窗口，不属于卡片。
  - **一条 http/https 链接（对话里、md 里都是同一条）默认也进那个浏览器窗口**：`App.tsx` 的 `openUrl` 先问 `isBrowserUrl`（只有 http/https 是浏览器装得下的地址），再问用户偏好——是就 `browserPane.openUrl(url)`，否则交给 `shell:openUrl`（`mailto:` / `tel:` / 别人的 scheme / `craftagents:` 全走那条，deep link 也归它，那行"URL blocked"的报错也在那里）。**偏好管两处**：一条链接（点击时，`shouldOpenLinkInAppBrowser`）和 HTML 大窗里那颗「在浏览器中打开」（按下时，`shouldOpenFileInAppBrowser`）——同一个开关，因为"用哪个浏览器"是一个问题；两个函数都在 `apps/electron/src/renderer/lib/open-in-app-browser.ts`，答案存在 `preferences.json` 的 `UserPreferences.openInAppBrowser`（Settings → Links，缺省为开），**每次现读、不缓存**（点击不是热路径，而设置是人随时会改的）。它只管**人的点击与按钮**——agent 用 `browser_tool` 开什么都不受它影响。关掉时：链接交给 `shell:openUrl`，那颗按钮交给系统默认程序（`.html` 的默认程序就是浏览器）。两条通道在 main 侧各自把关，因为"渲染层已经判过"不是边界：`open-file` 过 `validateFilePath`（绝对路径，且在 home / tmp / workspace 根 / 工作目录之内，非敏感文件——`.ssh/`、`.env`、`*.pem` 这类在哪儿都拒；并且必须是**文件**而不是目录，顺带把 `..` 与软链解析掉），`open-url` 再问一次 `isBrowserUrl`（只有浏览器装得下的地址能进窗口）。两个 handler 共享一个 `openInWindow`（新 tab → 前置 → 加载）。
  - **详情页自己托管的三种是 `inAppKind()` 说的，聊天里的链接是全局的 `classifyFile()` 说的——这三种谁跟谁一样是逐个定的**：`.md` 两边都进同一个 `MarkdownFileOverlay`（聊天那条是 `FilePreviewRenderer` 的 markdown 分支）；`.drawio` 两边都进同一个 `DrawioOverlay`（看图那一支，路径要在开窗前先读出来，因为查看器画的是递给它的文档——图没有"源码"那一面可看，把 `<mxfile>` 摆出来不如把图画出来）；`.html` 两边都进同一个 `HTMLPreviewOverlay`（大窗）。链接认得出这些后缀，靠的是同一份扩展名表喂给 `linkify.ts`（`FILE_EXTENSIONS_PATTERN`）——`drawio` 是加进那张表之后才成链接的，在那之前这种路径根本不成链接，而是交给系统程序。**其余格式没有第二份判断**：`inAppKind()` 返回 `null`，页面就把路径交给同一个 `onOpenFile`（= `classifyFile()` 那条路），所以图片 / PDF / json / 代码在两边必然一致。
  - **两份判断现在没有对不上的地方**：html 曾经是唯一被点名的有意不一致（`classifyFile` 把 html/htm 归成 `code`，所以聊天里的 `.html` 链接看到的是**源码**——"聊天里给一个 html 链接时想要的通常是源码"），现在两边都进同一个 `HTMLPreviewOverlay`（大窗，看那一面）。"这份 HTML 要真在浏览器里跑"不在这次点击里决定：大窗头部那颗「在浏览器中打开」用应用偏好决定去内置窗口还是系统浏览器——判据是"**这个面 agent 接不接得上**"，而不是"聊天里想要什么"。源码要读就在编辑器里打开。图片曾被记成"方向相反"（聊天里开内置大图，文件夹里那一行交给系统程序）——**那条笔记是错的**：文件夹里那一行走的是同一个 `onOpenFile` → `classifyFile()`，点开一直是 app 内置的大图，两边同一条路。
  - **分类器说它不能预览的那些**（xlsx / docx / zip / 视频 / HEIC…，`canPreview: false`）才交给系统的默认程序。**门禁只在"还差着什么"时出现**，而且是两件东西：徽章（一句"还不能交出去（N）"）**加上紧接其下的逐条 notice**——每行是读者语言的句子 + agent 原句，右边**一个「交给对话」**。没有"交付"按钮：`交付`是结论的名字，不是动作的名字；把清单藏在按钮后面，等于"看欠了什么"要经过一次点击，而只留一个计数则等于知道欠两条却既看不到也处理不了（这两版都被用户否掉了）。notice 翻译走 `t('prototypeNotice.' + code, params)`；动作走 `usePrototypeAskAgent`（把 agent 原句放进草稿、不发送）。
- 行内菜单的**打开文件夹**走 `shell:openFile`（= Electron `shell.openPath`，**进入**这个目录），不是 `shell:showInFolder`（那个是在父目录里选中它）。
- `apps/electron/src/renderer/components/app-shell/PrototypesListPanel.tsx`：原型列表 + 行菜单（复制 / 删除）。状态点是"有话说才画"：没有"可以交出去"的绿点。
- `apps/electron/src/renderer/components/prototypes/CreatePrototypeDialog.tsx`：创建对话框，只问名字。复制 / 删除没有对话框——删除走 `window.confirm`，都在 `apps/electron/src/renderer/components/app-shell/AppShell.tsx` 的 handler 里。
- `apps/electron/src/renderer/hooks/usePrototypes.ts`（读取 + `prototypes:changed` watcher）、`apps/electron/src/renderer/atoms/prototypes.ts`（列表 atom）、`apps/electron/src/renderer/hooks/usePrototypeAskAgent.ts`（门禁行的「交给对话」：哪一次对话、追加而不是替换草稿、不代发，理由在那个文件的头上）。
- `apps/electron/src/renderer/components/app-shell/input/use-working-directory-state.ts`：**绑定选择器**——一个对话要么在一个文件夹里，要么在一个原型的目录里。

---

## 2. 不变量（改代码前先看）

只有「破了会静默出错」的那几条；每条都在代码里核实过。

1. **工具描述只有一处**：`packages/session-tools-core/src/tool-defs.ts` 的 `TOOL_DESCRIPTIONS` 是唯一真源，四个 pane 工具的工厂（`browser-tools.ts` / `prototype-tools.ts` / `video-tools.ts` / `drawio-tools.ts`）只写 `const X = TOOL_DESCRIPTIONS.<name>;`。两条路读的是同一份文本：Claude 走工厂，Pi 走 `getToolDefsAsJsonSchema()` → `def.description`。**这条不变量原本是反的，而且已经出过事**：描述以前在工厂和注册表各存一份，实测 `browser_tool` 那份**已经漂了**（注册表缺 `reload` / `pick` / `evaluate --file`），而 Pi 读的正是注册表那份——也就是说 Pi 那侧的 agent 不知道这几条命令存在，且没有任何东西会报错。收敛后 `TOOL_DESCRIPTIONS` 里四个键（`browser_tool` / `prototype_tool` / `video_tool` / `drawio_tool`）取的是原来工厂那份（准确的那份）。
2. **locale key 集合一致**：`packages/shared/src/i18n/locales/*.json` 共 7 份（`en` + `de` / `es` / `hu` / `ja` / `pl` / `zh-Hans`），parity 逐个非 en 对 `en` 比对。加过 key 必须跑 `bun run lint:i18n:parity` 与 `bun scripts/sort-locales.ts`（排序也被强制）。
3. **渲染层不能从共享包 barrel 取运行时值**（只能取类型）：值只能来自 `*/types` 这类零依赖模块或浏览器安全叶子模块，`@craft-agent/shared/prototypes` 这类 barrel 会把 workspace / config storage 拉进浏览器包并连带 node-only SDK。规矩与事故见 `docs/renderer-imports.md`；`packages/shared/src/prototypes/types.ts` 一个 import 都没有是刻意的，`wiki-links.ts` 是第二个这样的叶子（同样零 import），渲染层经子路径 `@craft-agent/shared/prototypes/wiki-links` 取 `rewriteWikiLinks`。
4. **新增 RPC 通道要同时改注册表与 routing**：注册表在 `packages/server-core/src/handlers/rpc/index.ts`（拼各 handler 的 `HANDLED_CHANNELS`），通道分类在 `packages/shared/src/protocol/routing.ts` 二选一（`LOCAL_ONLY_CHANNELS` / `REMOTE_ELIGIBLE_CHANNELS`）。只补一处，`routing.test.ts` 或 `ipc-channels.test.ts` 立刻红。
5. **需求来自任何 markdown 文件的 `## R-00x` 标题，不是某个文件名**：`readPrototypeRequirements` 递归读每个 `.md`/`.mdx`（子目录也算），文件名不决定是不是规格——`PRD.md` 只是 `create` 的起步名。**定义需求的文件不算实现**：`coverage.ts` 跳过所有 `definingFiles`，否则规格会把自己写下的需求标成"已实现"（起步 `PRD.md` 正文里的 `@requirement R-001` 正是靠这条才无害）。
6. **`@requirement` 必须是「标记」，不能是词的一部分**：`markers.ts` 的 `markerIndex` 认「前面不是 `[\w-]`」的标记（`not-a-@requirement` 是散文），`requirements.ts` 的 `extractRequirementIds` 取标记之后到行尾的所有 id。定义需求的文件自己不算实现（`coverage.ts` 跳过 `definingFiles`，见 §2⑤）。
7. **指纹只有一处定义**：`storage.ts` 的 `contentFingerprint`（sha256 前 8 位）→ `requirements.ts` 的 `requirementFingerprint`。status 打印的 `on:` 与 `reviews.ts` 判 stale 读的是同一个函数；写第二份实现会让「针对旧措辞的异议」看起来仍然成立。
8. **`research/` / `reviews/` 的目录名只有一处**：`types.ts` 的两个常量，`storage.ts` 的路径构造与 `research.ts` / `reviews.ts` 两个 reader 都用它。改名只改一处就会静默读空。
9. **原子写的临时文件名不能固定**：`packages/shared/src/utils/files.ts` 的 `atomicWriteFileSync` 用 `pid + random` 命名临时文件；同一个目标的两个并发写者连临时文件都不该争用（写项目配置 `prototypeSlugs` 经它）。
10. **原型目录不是 agent 的写权限豁免**：Explore（safe）模式下 agent 只能写 `plansFolderPath` 与 `dataFolderPath`（外加 `allowedWritePaths` 授权），**`prototypesFolderPath` 不在其中**——原型是用户的材料，不是模式自己的管道；要改就在 Ask/Auto 模式下改，或者由人在 app 里改。`prototypesFolderPath` 仍然传给 agent，但它只是**告知位置**（prompt 里那行），不构成许可。这条有两个地方会静默失守：`mode-manager.ts` 的 Write/Edit 分支与 **bash/PowerShell 重定向**分支（后者只有 `likelyWriteAttempt` 时才查），以及 `prompts/system.ts` 里那几句"允许写哪里"的话——改一处就会让 agent 以为可以写。
11. **人手动保存的边界 = 能把这个文件给你看的那条边界**：`file:write`（`onWriteFile` → `HtmlDesignEditor` / `DrawioEditorPane` / `MarkdownEditorPane`）走 `validateFilePath(path, getWorkspaceAllowedDirs(workspaceId))`，**和读同一句**——凡是读得出来给你看的文件，就存得回去。**故意不是** agent 的写策略（plans/data + 授权）：那条管工具，放宽这里不会放宽它。敏感路径（`.env`、`.key`、`credentials.json`…）读写两侧都拒，因为那条规则在 `validateFilePath` 里而不在调用方。写者**不预检**边界（`PlatformContext` 的注释），拒绝原样回给界面。**"何时写 / 谁赢"只有一份实现，而它现在只是一个钩子**：`useFileWriter`（`packages/ui/src/components/editors/useFileWriter.ts`）——**只有链路，没有界面**：去抖、写前重读并比对、外部改动"没改过就跟上、改过就停下问人"、卸载时把待写的补上——`DrawioEditorPane`、`MarkdownEditorPane`、`HtmlDesignEditor` 三个编辑器共用它。**界面各是各的，这是有意的**：占位、工具栏、`layout` 都归各自的编辑器画——页面编辑器的工具栏是 h-10 那一条，markdown 在对话块里根本不要它；**只有"文件和它怎么了"这一句是共用的**（`FileSaveStatus`：标题栏里一句纯文案 + 正中那个要人决定的胶囊，见 §7.4）。**曾经有过一个连行一起渲染的 `FileEditorPane` 组件**（drawio 与 markdown 用），因为"页面编辑器接不进来"而降到只留链路：它要求所有编辑器共用同一行，而那行正是三者差别最大的地方——共用一次飘出来的提示可以，共用一行不行。**新的文件编辑器接着用 `useFileWriter`，别再写第二份链路。**
12. **`[[…]]` 只负责导航，不参与"哪条需求实现了"**：`links.ts` 解析并解析到文件（只扫 markdown——代码里的 `[[i]]` 是数组，不是链接），`status` 只把「链到不存在的文件 / 名字被两个文件共用」放进 `briefIssues`；需求是否实现仍只看 `@requirement`（`coverage.ts`）。**解析与改写是一份实现**：语法在零依赖的 `wiki-links.ts`，`links.ts`（读）与渲染层（画）都从它取；两边各写一遍正则，会出现"报告说这里没链、页面却把它画成链接"。代码段 / fence 内的 `[[…]]` 一律是文本（与 §3.4 同一类坑，这里靠跳代码段兜住）。

---

## 3. 踩坑记录（只留仍然适用的）

### 3.1 渲染层从共享包 barrel 取运行时值

- **症状**：`bun run electron:build` 在 `@anthropic-ai/claude-agent-sdk/sdk.mjs` 上解析失败（`__vitePreload` 被注入到 shebang 之前）。
- **根因**：一条真实链路被拖了进来——`prototypes/index.ts → storage.ts → workspaces/storage.ts → config/storage.ts →（惰性）agent/session-scoped-tools.ts → SDK`。`config/storage.ts` 那句动态 `import()` 是为破循环依赖，不是可选依赖；打包器照样跟着走。触发点是从 barrel 取了一个**运行时值**，而其余导入都是 `import type`（编译期擦除）。
- **为什么仍然适用**：规矩没变，只是现在把它按在了 `prototypes/types.ts`（零依赖）+ `@craft-agent/shared/prototypes/types` 导出子路径上。dev 看不出来，只有生产构建那条 rollup 路径会炸；规矩与自查命令见 `docs/renderer-imports.md`。

### 3.2 新增 handler 会打破注册表测试

- `packages/server-core/src/handlers/rpc` 的注册表测试用各 handler 模块的 `HANDLED_CHANNELS` 拼期望集合，新增 handler 必须同步加进去。
- **同一个新通道还要在 `packages/shared/src/protocol/routing.ts` 里二选一**：「注册表补齐了、routing 忘了」是**另一条**独立失败（`routing.test.ts` 要求每个通道恰好被分类一次）。参见 §2④。

### 3.3 原子写的固定临时文件名

- 曾经 `atomicWriteFileSync` 用的是固定的 `<path>.tmp`，同一目标的两个并发写者**连临时文件都在争用**（撕裂 / 空文件 / ENOENT）。
- 现在改成 `pid + random`（`packages/shared/src/utils/files.ts`），注释里写明了原因。规则是通用的：临时名不能是目标的确定函数。

### 3.4 生成的文本里出现标记**字面**，就会被当成标记

- 解析器按行扫，把标记之后到行尾都算它的值——**它分不清「标记」和「谈论标记」**。所以在任何会被 `coverage.ts` 扫到的文件里写 `@requirement` 字面（哪怕是在注释里解释它），都会多出一条声明。同一个坑的边界由 `markers.ts` 的 `markerIndex` 兜住一半：`x-@requirement` 不是标记。
- 受此约束的还有 `create.ts` 的起步 `PRD.md`：它正文里写了 `@requirement R-001`，之所以无害，正是因为 `coverage.ts` 跳过所有**定义需求的文件**（起步 `PRD.md` 定义了 `R-001`，于是整份被跳过）。
- **`[[…]]` 是同一类坑，但这里兜住了**：一份**解释**双链的文档会写出 `[[docs/checkout.md]]` 字面，若被当成真链接就会报假断链。`wiki-links.ts` 的解析先圈出代码段与 fence（与渲染面的 linkifier 同一读法），只认代码之外的 `[[…]]`——所以讲解写在反引号或 fence 里是安全的，写进正文就是真链接。

### 3.5 窗口与标签那批坑（相邻子系统，只给指针）

焦点交接、停车窗、`WebContentsView` 的销毁语义、真实窗口尺寸那批，都属于浏览器面板，不属于本工作台：见 `apps/electron/src/main/browser-pane-manager.ts` 与其测试 `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`，以及 `apps/electron/resources/docs/browser-tools.md`。

### 3.6 要等"节点出现"才做的事：节点存进 state，别拿 ref 读一次

- **症状**：mermaid 大窗预览里滚轮毫无反应，而缩放按钮一切正常（用户报了两次；第一次我按"effect 早退"改，改完仍然没反应）。
- **根因**：滚轮 effect 在 `isOpen` 变 true 时跑，但**那一刻容器还没进 DOM**——`PreviewOverlay` 的 children 由 Radix 的 Portal 挂着，Portal 按自己的 presence state 决定何时渲染，比 `isOpen` 晚一个 commit。于是 `containerRef.current` 还是 null，监听器从来没装上；之后也没有任何依赖再变化，effect 不会重跑。**把 `isOpen` 加进依赖救不了**——问题不是"没重跑"，而是"跑的时候节点还没有"。
- **实测证据**：playground 的 `RichBlockInteractionParity` fixture 里对容器派发一次 `wheel`，`defaultPrevented` 是 `false`（handler 第一句就是 `preventDefault()`）——监听器不在那个元素上。修好后同一次派发为 `true`，头部百分比 100% → 128%（`2^(120×0.003)`）。
- **规矩**：把节点存进 **state**（callback ref → `setContainer`），让 effect 依赖那个 state——节点什么时候到就什么时候跑，对"为什么晚到"不做假设。`useRichBlockInteractions` 与 `useDrawioView` 现在都是这个写法。同一个 hook 也供 image 大窗用，所以那个的滚轮以前一起坏着。

---

## 4. 墓园（已整份删除的机制）

这些概念**现在不存在**，别再按它们讨论设计；只回答「当初为什么删」。

| 机制 | 曾经为了什么 | 为什么删 | 现在怎么做 |
|---|---|---|---|
| **补丁层**（`patches/`、`@target`、锚点、折叠、回放、窗口里的编辑覆盖层） | 在不改源产品的前提下给页面叠一层差量改动 | 那是「在看真实产品时改它」的能力，属于浏览器工具；长在规格的文件夹里就要求一份索引、一套锚点与折叠，全是第二份描述 | 规格里只写文件；页面的事归 `browser_tool` |
| **页**（页表 `config.json`、`_layout.html`、overlay / scratch 类型、入口页、页索引、片段） | 把一条流程拆成多页并声明谁是谁 | 类型描述的是「一份文档的性质」，本工作台现在没有文档产物；类型/地址/入口是一次猜，而作者面必须仍是最终产物 | 一个原型一个文件夹，没有页表、没有布局、没有入口 |
| **原型宿主**（`http://<slug>-<hash>.localhost/`、Electron 应答 `http`） | 给原型文档一个稳定 origin，好让 mock 与 cookie 生效 | mock 删了，载体就没有存在理由；`protocol.handle('http')` 让每个 http 请求都先经我们一手，是要还的代价 | 不碰浏览器；文件直接打开 |
| **mock**（`x-mock` / fixtures / `state.json` / `buildMockRoutes` / CDP `Fetch` 拦截） | 让原型在没有后端时也能跑通请求 | 它服务的是「可运行物」，而交付物现在是规格本身；契约、fixtures、状态机是给机器和后端的 | 不做 mock |
| **契约**（`services/`、`paths/*.yaml`、openapi、`contract.md`） | 声明并兑现后端接口 | 回答的是「后端怎么实现」，不是「这条需求做完了没有」 | 需求写在 `PRD.md`，依据写在 `research/` |
| **验收**（`check:`、`verify`、`acceptance/`、轮次与 diff、`dist/`） | 跑 PRD 里的检查并对比上一轮 | 没有任何东西在跑检查；记不住历史的运行报告只会让人以为它记得 | `check:` 现在只是正文，解析器不认识它；不记历史 |
| **交付物**（扩展包 / 自包含 HTML / 书签 / `dev-spec` / `handoff`） | 把原型打包成能交给别人跑的东西 | 交付物**就是这份规格**，产物是给收件人看的、不是给浏览器装的 | 文件夹整份交出去 |
| **帧记录**（`research/frames`、`research/videos`） | 把录屏抽成帧写进原型，供 agent 读 | 「让 agent 看一眼录像」与原型无关，是独立能力 | 已提为顶级工具 `video_tool sample <path>`（`sample-video` 随之改名） |
| **写归属与写守卫**（`ownership.ts`、`resolvePrototypeWriter`、`PROTOTYPE_DEFAULT_WRITER`、会话的 `taskWrites`、task YAML 的 `writes:`、`pre-tool-use` 的写守卫分支） | 让多个写者并线不互相覆盖 | 它要防的冲突源（契约片段、状态文件、补丁索引、页表）全被删光了；剩下的「两个对话改同一个文件」是文件系统的问题，不该由这个工具发明机制 | 原型就是一个文件夹，谁都写 |
| **项目指定「当前原型」**（`ProjectConfig.defaultPrototypeSlug` + `projects:setDefaultPrototype` + agent 的 `prototype-default` + 会话继承「恰好一个」） | 多原型项目的对话开箱就用某一个 | 它回答的是「项目替会话挑一个」，而挑就是猜；为这一个答案要多一个配置字段、一个受校验的写入者、一条 RPC、一条命令，以及悬空故事 | 项目只**记**自己在哪些原型上工作（`prototypeSlugs` → `<project_prototypes>` 一列）：背景信息，不绑定、不继承、不解析。会话要么自己绑，要么按名调用 |
| **原型属于某个项目**（`PrototypeConfig.projectSlug` + `listPrototypesForProject` + `prototype-project` 命令 + `prototypes:setProject`） | 项目详情页列出「这个项目的原型」，`<prototype_context>` 说「新文件放哪边」 | 一个原型会被多个对话绑定，而那些对话可以属于不同项目——「它属于项目 A」不是事实，「这个项目有哪些原型」也不是该问的问题 | 原型**不记**自己属于谁；项目侧只留一条背景记录；要找原型用 `list` |

---

## 5. 验证与基线

### 5.1 常用命令（数字为**实测日期 2026-09-25**）

```bash
# 类型检查：四个包全 0 错误
cd packages/shared            && bun run tsc --noEmit    # 或根目录 bun run typecheck:shared
cd packages/session-tools-core && bun run tsc --noEmit
cd packages/server-core       && bun run tsc --noEmit
cd apps/electron              && bun run typecheck

# 原型 + 相关接缝（1242 pass / 1 skip / 9 fail；9 条全是既有环境失败，见 §5.2）
bun test packages/shared/src/prototypes packages/shared/src/agent packages/shared/src/tasks \
         packages/server-core/src/domain packages/server-core/src/sessions packages/server-core/src/tasks
# 单跑：packages/shared 的 prototypes 91 pass；server-core 的 domain+sessions 145 pass

# 界面侧全量 + 构建 + i18n
cd apps/electron && bun test                     # 1109 pass / 0 fail
cd apps/electron && bun run build:renderer       # 成功（改到 renderer 或共享包导出时务必跑，见 §2③）
bun run lint:i18n:parity                         # i18n parity OK (6 locales, 1810 keys each)
bun scripts/sort-locales.ts                      # 加过 key 之后跑一次，排序是强制的
```

### 5.2 既有失败基线（**别算到新改动头上**）

上面那次全量跑的 9 条失败全是**既有环境失败**，与原型工作台无关：

- `build-call-llm-request` 附件（1）
- `permissions-config-migration`（1）
- `read-patterns` PowerShell validator（4）
- `mode-manager-path-boundary` Windows 路径（2）
- `spawn-session-tilde-expansion`（1）

另有一条与本工作台无关、但同样**别算到新改动头上**的既有失败：`bun test packages/shared/src/websites` → **50 pass / 7 fail**，7 条全部是 `website data write (spawned Bun one-shot)`。原因是本机环境：测试经 `resolveScriptRuntime('bun')` 直接 spawn（`data-write.ts:274`），而本机 PATH 上只有 `bun.exe`，于是 `uv_spawn 'C:\nvm4w\nodejs\bun' ENOENT`；真实运行走 `CRAFT_BUN` 全路径，不受影响。（要修就在测试里给 `CRAFT_BUN`，或让 `resolveScriptRuntime` 在 Windows 上补 `.exe`。）

### 5.3 测试落点

`packages/shared/src/prototypes/__tests__/`（10 个文件 / 1295 行）：

| 文件 | 行 | 管什么 |
|---|---|---|
| `coverage.test.ts` | 333 | 需求 id 与标记（含「写成词就不算」）、markdown 解析（多文件 / 子目录 / 跨文件重号）、findings、需求→实现的整条线 |
| `links.test.ts` | 144 | `[[…]]` 的提取与改写（跳过代码段 / fence、label 与 anchor）、路径/名字/`../` 解析、断链与重名的报告 |
| `reviews.test.ts` | 194 | dispute 解析、`about:` 的四种写法、`status` / `on:` 与盘对账 |
| `settlement.test.ts` | 198 | 门禁 `whyPrototypeIsNotSettled`、报告携带异议、规格/材料切分与文档间链接 |
| `prompt.test.ts` | 137 | `<prototype_context>` 的渲染与构造（含转义） |
| `project-link.test.ts` | 93 | 项目侧的原型集合（存在性过滤） |
| `prototypes.test.ts` | 103 | 路径、递归 `listPrototypeFiles`、`contentFingerprint` |
| `create.test.ts` | 76 | slug 派生、建文件夹与起步 `PRD.md` |
| `duplicate.test.ts` | 72 | 整份复制、命名与冲突 |
| `delete.test.ts` | 41 | 整目录删除、不存在时报错 |

agent 命令层：`packages/shared/src/agent/__tests__/tool-commands.test.ts`（两条门的分发、help、互不认领的措辞）。

### 5.4 只能在真实窗口里验的项

所有命令都是文件读写，测试里覆盖得到。跑起 Electron 之后才需要看的只剩界面：

| 项 | 不对时看哪 |
|---|---|
| 详情页渲染（需求 / 文件 / findings / reviews / 门禁徽章与逐条文案） | `PrototypeInfoPage.tsx`；文案是 `packages/shared/src/prototypes/notices.ts` 的 `code + params`，翻译 missing 时先看 locale |
| 原型列表（计数、选中、行菜单） | `PrototypesListPanel.tsx`、`atoms/prototypes.ts`、`usePrototypes.ts` |
| 创建对话框 | `CreatePrototypeDialog.tsx`（名字非法时错误就地渲染） |
| 复制 / 删除 | `AppShell.tsx` 的 `handleDuplicatePrototype` / `handleDeletePrototype`（删除是 `window.confirm`） |
| 绑定选择器 | `use-working-directory-state.ts`（文件夹与原型二选一） |

---

## 6. 调试入口

### 6.1 三个命令怎么读

| 命令 | 输出 |
|---|---|
| `list` | 每个原型一行：需求数、文件数（含规格文件）、本会话绑定的是哪个（若有） |
| `create <name> [--no-bind]` | 建文件夹 + 起步 `PRD.md`；默认顺手绑定本会话，`--no-bind` 不抢绑定 |
| `status [slug]` | 下面那几段；无 slug 时取会话绑定 |

### 6.2 `status` 各段的含义

| 段 | 含义 |
|---|---|
| `dir:` | 原型目录的绝对路径 |
| `spec:` | 定义需求的文件（一个或几个）+ 需求条数；没有时写 `not written yet` |
| `requirements:` | 每条需求一行：id + 标题 — **谁引用了它**（文件名、`F-00x (finding)`；都没有时 `nothing refers to it yet`）· `disputed by D-00x` · `on: <指纹>` |
| `files:` | 目录里**定义需求的文件之外的文件**（递归；不含定义需求的 markdown、`research/`、`reviews/`） |
| `findings:` | 有才出现：条数与路径 |
| `issues:` | 读不干净的地方（悬空引用、断链 / 重名链接、`evidence:` 不在盘上、缺字段、同一 id 被两个文档定义、未实现的需求），每条一句 |
| `reviews:` | `N standing of M filed`（standing = `open` 或 stale） |
| `unresolved:` | **最后一段、行动项**：空则 `nothing — every requirement is implemented and no dispute stands`，否则逐条列出（未实现的需求 / 还立着的异议） |

### 6.3 「为什么没生效」的排查路径

| 症状 | 看哪一段 / 哪个文件 |
|---|---|
| 目录不对（不在本 workspace 的 `prototypes/` 下） | `list` 只列当前 workspace；看 `status` 的 `dir:`。`status.ts:listPrototypeStatuses` 读 `getWorkspacePrototypesPath` |
| 需求写在了非 markdown 文件里（如 `.txt`）或位置不对 | 不被读为需求（`requirements.ts:isMarkdownFile` 只认 `.md`/`.mdx`），该文件出现在 `files:` 里当材料。真源 `requirements.ts` 的 `isMarkdownFile` 与 `listPrototypeFiles` 的递归 |
| 标记写成了词的一部分（`x-@requirement`）或值不合法（`@requirement TBD`） | `issues:` 为空、需求仍是 `nothing refers to it yet`。`requirements.ts:extractRequirementIds` + `markers.ts:markerIndex` |
| 引用了不存在的 id | `issues:` 的 `requirement.undefined`（`… refers to R-099, which no file in this prototype defines`）。`coverage.ts` |
| 链接链不到（`[[gone.md]]`）或名字被两个文件共用 | `issues:` 的一句原文（`PRD.md links to gone.md, which is not in this prototype` / `… matches more than one file (…)`）；详情页把它按原样显示，不画成链接。`links.ts:readPrototypeLinks` |
| finding 的 `evidence:` 不在盘上 | `issues:` 的一句原文（`evidence "…" is not in research/.`）。`research.ts:readPrototypeFindings` |
| dispute 的 `status:` 值不认识 | `issues:` 的一句原文（`no usable "status:" line — use one of open, fixed, rebutted, accepted`），且该 dispute 不计入 `reviews:`。`reviews.ts` |
| dispute 缺 `about:` / `claim:` / `on:` | `issues:` 里逐条点名（每条都告诉你要补哪一行）。`reviews.ts:readPrototypeReviews` |
| 需求被改写，`on:` 对不上 | `requirements[].disputes` / `reviews:` 里标 `stale` + `staleReason`（`R-00x in <定义它的文件> has changed since this was filed (旧 → 新)`），并且它仍在 `unresolved:`。`reviews.ts:judgeAgainstDisk` |

---

## 7. 相邻子系统（这一轮一起改的）

不属于本工作台，但这一轮一起动了。改动落点记在这里，免得下次从本工作台的文档里找不到它们。

### 7.1 网站：站点能读到自己的数据

- **规则只有一处**：`packages/shared/src/websites/host.ts` 的 `isWebsiteHostOwned(relativePath)`（"这个路径是站点自己的，还是 app 自己的"）。**服务**（`host.ts` 的应答）与**导出**（`export.ts` 的 `isWebsiteExportPath` 直接调它）读同一个函数——各写一遍就会漂，表现是"导出的副本缺了站点自己在用的文件"。
- **唯一跨进程数据契约**是 `websites/<slug>/data/snapshot.json`（类型在 `packages/core/src/types/website.ts`）：写入方是 `data-write.ts` 与定时 refresh 脚本（原子写，临时名不能固定），读取方是所有 host；`store.sqlite` 只有脚本碰。
- 文档与描述同步改了：`apps/electron/resources/docs/websites.md`（数据通道、404 语义、副本带走快照、starter 用 fetch、**没有 kind / 没有 live 推送 / 站点的数据靠 fetch**）、`packages/shared/src/prompts/system.ts` 的 Websites 段、`packages/session-tools-core/src/tool-defs.ts` 的 `create_website` / `write_website_data` 描述。**`kind`（`static`/`interactive`/`live`）已整份删除**——它的强制力全部来自那个被删掉的 iframe（`static` = 不给脚本、`live` = 父文档推快照）。
- 测试：`packages/shared/src/websites/{host,export,data-write,storage,data-store}.test.ts`（基线见 §5.2）。
- **只能在真机验的一项**：在站点自己的标签页里看 `fetch('/data/snapshot.json')` 的真实返回（没数据 → 404；写一次数据 → 200 且形状对）。
- **网站不再内嵌渲染**：站点以前用 `<iframe>` 显示在应用内容区里（`WebsiteFrame` + `craft-websites/v1` postMessage 桥 + `kind`（`static`/`interactive`/`live`）那套 sandbox 分级），现在**整份删掉了**。打开网站 = 在**浏览器窗口里开一个真实标签页**：`browserPane.create({ show: true, newTab: true })` → `browserPane.navigate(instanceId, origin)` → `browserPane.focus(instanceId)`（`origin` 来自 `websites:getOrigin`，它同时完成注册；这是当年原型"打开"用的同一条路）。于是也没有 `frame-src` 那条 CSP 规则了（`index.html` 已删回 `default-src 'self'`）——**`frame-src` 与 `img-src` 两条后来都为 drawio 装回来了（§7.3）**，站点数据只靠站点自己 `fetch('/data/snapshot.json')`——**没有任何东西会往打开的页面里推数据**。缩略图顺势简化：隐藏窗口**直接 `loadURL(origin)`**（先调 `websiteOriginUrl` 完成注册），不再套 `data:` 宿主 + iframe。

### 7.2 浏览器与 `video_tool`

- **`video_tool` 的注册面就是"新增一个顶级工具要碰的地方"的清单**，漏一处会表现成"Explore 模式被拦"或界面显示原始名：

| 落点 | 文件 |
|---|---|
| 工具 schema + 描述 + 注册行 | `packages/session-tools-core/src/tool-defs.ts` |
| 工具定义 + **描述的第二份**（必须与上面逐字一致） | `packages/shared/src/agent/video-tools.ts` |
| 命令体（`sample`、`--help`、未知命令） | `packages/shared/src/agent/video-commands.ts` |
| 会话工具集 + Claude 后端的 backend 工具清单（有漂移守卫） | `packages/shared/src/agent/session-scoped-tools.ts` |
| 分派表（按工具名挑 executor） | `packages/shared/src/agent/pi-agent.ts` |
| 任意模式下放行 | `packages/shared/src/agent/mode-manager.ts`（`ALWAYS_ALLOWED_TOOLS`） |
| 界面显示名 | `packages/server-core/src/sessions/SessionManager.ts`（`'video_tool': 'Video'`） |
| 命令预览解析 | `packages/ui/src/lib/tool-parsers.ts` |
| 系统提示里的一句能力说明 | `packages/shared/src/prompts/system.ts` |

- **解码在 Chromium**：`apps/electron/src/main/video-frames.ts`（隐藏窗口 + `<video>` + canvas）；`IBrowserPaneManager.extractVideoFrames` 是底层能力，`BrowserPaneFns.sampleVideo` 是 agent 面，**按 `--out` 写盘的那一段在 server-core**（`SessionManager` 的实现里）。
- **录制是人的入口**：`apps/electron/src/renderer/browser-toolbar.tsx` → `preload/browser-toolbar.ts`（`startRecording` / `stopRecording`）→ 主进程 `TOOLBAR_CHANNELS.RECORD` → `apps/electron/src/main/tab-recorder.ts`。**没有 agent 侧命令**，这是有意的（理由见实施方案 §8.1）。
- **窗口 chrome 的 state 是"推"的，推早于订阅就丢**：地址栏与标签栏画的是主进程推来的 state（`TOOLBAR_CHANNELS.STATE_UPDATE`），而 `did-finish-load` 那一次 replay 可能早于这个文档的 React 挂载（`onStateUpdate` 是在 mount effect 里订阅的；dev 下模块图大，挂载比 load 慢得多）——表现是**刚开出来的窗口标签栏一个 tab 都没有**（rail 的规则是"没被告知有哪些 tab 就不画"，所以空推送与没推送看起来一样）。修在预加载层：`preload/browser-toolbar.ts` 缓存最后一次 state，`onStateUpdate` 订阅时立即补发（它在任何文档脚本之前就开始听，所以不会漏）。以后再加 chrome 面时照这个来，别只靠推。
- 浏览器工具的文档（`apps/electron/resources/docs/browser-tools.md`）现在**不提原型**；窗口与标签那批坑见 §3.5 的指针。

### 7.3 drawio：本工作台里第一个被宿主的 frame

原型文件夹里的 `.drawio` 由 app 自带的 drawio 渲染：一份**裁剪过的 drawio webapp**（`resources/drawio/`，由 `scripts/fetch-drawio-assets.ts` 按 tag 取、不入 git）在 `http://drawio-<hash>.localhost/` 上被服务（复用 `local-origin.ts` + `local-host.ts` 那条链，落点是 `drawio-host.ts`），前端用两个 iframe 接它：viewer 打 app 自己的壳页（`/__craft/viewer.html`），editor 打 drawio 自己的 embed mode。桥的协议在 `packages/shared/src/drawio/types.ts`（外层是我们的信封，内层是 drawio 的裸 JSON）。

**两个 iframe 的地位不一样，这是这一版的结构分界线。** 编辑器**就是**那个界面（人要在里面画图）；查看器只是一个**引擎**——drawio 的 viewer 脚本只能活在它自己的文档里，所以要有一个 frame 让它跑，但它跑完把画出来的 SVG 交回来，**显示这件事由 app 自己做**（`frame.tsx`：引擎 frame `visibility: hidden` 且在视口外，`svg.outerHTML` 通过 `postMessage` 回来，由 `DrawioDiagram` 用 `dangerouslySetInnerHTML` 放进我们自己的文档）。理由很简单：**SVG 本来就是浏览器能渲染的东西，不需要再套一层 HTML 壳**。早先让 frame 自己当显示面，等于把滚动条、尺寸、光标三件事交给一个跨 origin、量不到的盒子去决定；现在这三件都回到 app 手里。

以下几条**破了会静默出错**的事实，都是从 bundle 的源码里查出来的，不要重新推：

1. **CSP 在三处各咬一口，而且每一处都会静默失败**（前两处是渲染层那份 CSP 的两条指令）。
   - **渲染层的 `index.html` 必须留 `frame-src 'self' http://*.localhost`。** `frame-src` 一出现就**覆盖** `default-src`，所以漏掉 `'self'` 会把 `html-preview` 那些 `srcDoc` frame 一起挡掉。这条规则是网站不再内嵌时删掉的，为 drawio 又装回来——这是"不碰浏览器"的第一处、也是目前唯一一处例外。漏了它的表现是 `ERR_BLOCKED_BY_CSP`，而 CSP 报错只说"被挡住了"，不说"是哪条规则少了一个 origin"。
   - **同一份 CSP 的 `img-src` 也要带 `http://*.localhost`，因为图现在是内联在我们自己的文档里。** drawio 画出来的 SVG 里可能有 `<image>`（图标、clipart），它的 `href` 原本是相对路径、相对**壳页**解析；桥把它们绝对化成壳页 origin 的地址（`absolutizeImages`）——而那正是 `img-src` 要放行的地方（`'self'` 只等于渲染层自己的 origin）。**这是"显示面从 frame 挪到自己文档"的直接代价**：在 frame 里那些图由 frame 自己的文档策略管，搬出来就归我们管了。漏了这条的表现是**图缺图标但布局正常**——同样不报错。
   - **壳页自己的 `script-src 'self'` 不许内联脚本**，所以桥是**独立文件**（`/__craft/viewer.js`，由 `drawio-host.ts` 合成并服务），不是内联的。把它改回内联**不会报任何错**，只会让页面永远不说 `ready`：表现是卡片一直"加载中"、日志里什么都没有。这条现在有测试盯着（`drawio-host.test.ts` 的 "loads its bridge as a file, and never inline"）。
2. **`stencils/` 默认不装，代价是静默降级。** `STENCIL_PATH` 默认就是 `"stencils"`，`mxStencilRegistry.getStencil()` 对**未注册**的集合会 `loadStencilSet(STENCIL_PATH+'/'+name+'.xml')`；而 `js/stencils.min.js` 只内置 **204** 个集合。不在其中的（`azure2`、`android`、`network`、`rack`…）会去拉那个目录，404 之后**静默降级成灰方块**——不报错、不提示，正好打掉"app 把图显示出来"这条承诺。所以这是个**有意的取舍**：默认省掉 41 MB，要完整就跑 `bun scripts/fetch-drawio-assets.ts --force --full-stencils`；脚本每次运行都会把这条代价和取回它的办法打出来，`--full-stencils` 这个变体也记在 stamp 里（否则切开关不会重取）。
3. **压缩由文件自己的 `compressed` 属性决定，不是编辑器的偏好。** `isCompressed()` 先读属性，没有属性才看 `Editor.defaultCompressed`（默认 `false`）。所以 agent 写的明文文件不会被编辑器改成压缩；反过来，一个带 `compressed="true"` 的文件（drawio 自己保存过的）会一直是压缩的——**它的 `<diagram>` 正文不是文本，agent 与人（以及任何按文本读这个文件的工具）都读不出里面的内容**；`pages` 会报哪一页是压缩的，`export <file> --to <plain>.drawio --format drawio` 写出明文。这是目前唯一能让文件夹里出现"不可直接读"文件的路径。
4. **`viewer-static.min.js` 的资源路径默认指向 `viewer.diagrams.net`，所以要在它之前改掉。** `window.STENCIL_PATH` / `SHAPES_PATH` / `STYLE_PATH` / `IMAGE_PATH` / `GRAPH_IMAGE_PATH` / `mxBasePath` / `DRAW_MATH_URL` 全是 `window.X = window.X || "https://viewer.diagrams.net/…"`——因为静态 viewer 本来就是给"从别处嵌"用的。我们的壳页由自己的 origin 服务，所以这些要在**加载 viewer 之前**认领：**桥文件是壳页里的第一个 script**，`ready` 也改成等 `load` 事件（`announceReady`）。不改的表现是图缺样式、缺图标，而且"离线"只是被 CSP 挡住，不是事实。
5. **frame 不许离开。** viewer 自带会指向 `viewer.diagrams.net` 的链接，一点就导航出去——既离开 app 又出网。壳页里因此让 `window.open` 返回 null。**这不是防点击**（引擎 frame 隐形且 `pointer-events: none`，没人点得到它），而是防"不点也会发生"的那些路径：viewer 的脚本自己就能开窗口。没有可靠的 CSP 指令能拦 iframe 自身的导航（`navigate-to` Chromium 未实现），所以这是 JS 的活。

   **但图里的 `<a>`（作者给某个形状加的链接）现在是一条 app 里的链接，不是 frame 里的。** SVG 内联进渲染层之后，点它走的是 `window-manager.ts` 的 `will-navigate`：非 app 地址被 `preventDefault` 掉，再交给 OPEN_URL 那套安全分类器（也就是"在浏览器窗口里打开"）。这是**和 markdown 里的链接一致**的行为，所以不必另加拦截——只是别再以为"点图不出 app"是靠 CSP 保证的。

6. **原始尺寸是读 viewer 自己写的那两个数，缩放与抓取拖动是我们自己做的，drawio 的查看器两样都没有。** `grab` 在 `viewer-static.min.js` 里出现 **0 次**，它只在 lightbox 模式下移动图。所以 `data-mxgraph` 里没有尺寸选项（唯一要传的那个不是尺寸，是"别按你的盒子缩"，见下第四条），也别指望 markup 里有尺寸——**viewer 交回来的 `<svg>` 既没有 `viewBox` 也没有 `width`/`height` 属性**，`style` 是 `width: 100%; height: 100%;` 加 **`min-width: 185px; min-height: 105px`**，而后者（图的边界 + 边距，**再乘以 viewer 作画时的 `view.scale`**）就是这张图的尺寸。四条实测（临时静态服务 + 宿主页把 `js/viewer-static.min.js` 单独跑起来，再把回传的 markup 塞进 app 那套结构里量）：
   - `viewBox.baseVal` 是 `{0,0}`；元素在 auto 宽度的父级里落到 **CSS 替换元素默认的 300×150**（`width: 100%` 对不定宽父级解不出来）——所以**不能拿元素自己的盒子当尺寸**；
   - `getBBox()` 是 **w=300 h=201，而原点是 `(-112,-112)`**——它把画布上不可见的那部分也算进去，**同样不能当尺寸**；
   - 按 `min-width`/`min-height` 钉住并 `scale(1.5)`：布局盒与 SVG 都是 278×158，四边与文字都在视口内、基本居中（左右留白 162/162，上下 122/122）。
   - **而那两个数未必等于"作者尺寸"：viewer 会先把装不下的图缩到它自己的容器宽。** `allowZoomOut` 默认 `true`，于是 `addSizeHandler` 里那条"宽出容器 → `fitGraph`"的分支会开火；而 `min-width`/`min-height` 是 `mxGraph.sizeDidChange` 写的 `bounds × view.scale`，**缩放比例也被算进去了**。引擎 frame 只有 1024×768，所以同一份文档（2218×1304）交回来是 **1030×611，画布 `g` 上带 `scale(0.46,0.46)`**——app 的"100%"实际是 46%，字看不清；同一个文件在官方 drawio 里正常，就是这个差别。**修法是 `data-mxgraph` 带 `'allow-zoom-out': false`**：它关掉的正好是那条 fit 分支（整个 bundle 里 `allowZoomOut` 只有这一处行为），于是 `view.scale` 留在 1，交回来是 2218×1304 / `scale(1,1)`。实测数据与测试都在（`drawio-host.test.ts` 的 "draws a diagram and hands back its SVG"）。

   这条决定了后面所有事：**没有 `viewBox` 的 SVG 不是分辨率无关的**，拉伸它的盒子只会露出"同一张图的更大窗口"，字和图都不会变大——所以曾在 SVG 上写 `width`/`height` 的那版**从来没生效过**（用户报的"点了数字、图不变"、以及"大窗里滚轮改了比例图不动"都是它）。桥那边原来还有个按 `viewBox` 设尺寸的 `sizeToAuthored`，它的守卫就是 `viewBox`，因此对这条路永远早退，已删除（`drawio-host.ts`）。`resize` 那个键是 drawio 导出 HTML 时用的（`getHtml2` 里 `resize:!0`，含义是"缩到给定宽度"），我们**不传**；`nav` 是折叠导航（不是平移）；**drawio 查看器自己的缩放按钮来自 `toolbar:"pages zoom layers lightbox"`，我们也不传**——我们不用它的，用的是 app 自己的 `ZoomControls`（同 mermaid / 图片预览那套），所以不要给 `data-mxgraph` 加 `toolbar`。**唯一传的是 `'allow-zoom-out': false`**，它管的是上一条第四条那件事（不是尺寸，是让 viewer 别按自己的盒子缩），删掉它大图会静默变回 46%。

   **一块图有两个面，两面各有各的机制，这不是重复而是两种看法**（用户定的口径）：

   - **对话里的图 = `InlineDiagram`**（`components/markdown/InlineDiagram.tsx`）：**原生滚动盒**，图按 mermaid 那套尺寸规则显示（装得下居中、只宽出不到 200px 就直接缩到容器宽、宽出自己的滚动、宽到缩了会读不清就不缩），**点击出大图**、拖动平移、有溢出时边缘有渐隐。**mermaid 块和 drawio 块走的是同一个组件**——这是"和 mermaid 一致"这句话的实现方式，不是把两套规则写得像。两侧都**没有缩放控件、也没有滚轮缩放**：对话里滚轮是页面的，缩放属于大窗（mermaid 块一直如此）。
   - **大窗 = `useDrawioView` + `DrawioDiagram`**（`view.tsx` / `frame.tsx`）：`zoom` + `translate` 两个状态，**平移是 transform、没有滚动条**，滚轮就是缩放（钉住指针），按钮 / 预设 / 快捷键钉住中心，"适应"顺带回到中心，`⌘0/⌘+/⌘−`。

   大窗那面的规则明细，以及"别改回去"的四条，见下。**引擎与显示是分开的**：`DrawioViewerShell`（`frame.tsx`）只负责 off-screen 引擎 + 握手 + 拿到 markup，**怎么显示由调用方给**——`DrawioViewer` 给大窗（transform），对话块给 `InlineDiagram`。`DrawioViewerShell` 的 `minHeight` 只在"还没图可显示"时生效，它是给等待期占位的，不是给图定尺寸的。

   - **大窗里 100% = 图自己的尺寸（作者尺寸），可读性优先，没有例外。** 比窗口大就拖动看，**不缩到容器宽**。曾经有过一条"只宽出不到 200px 就直接缩到容器宽"——那条的理由**是省掉一条滚动条**，而大窗已经没有滚动条可省，所以连同 `startZoom()` 一起删掉了（对话里的图仍然有这条规则，因为它真的有一条滚动条要省：见 `InlineDiagram`）。
   - **平移是 transform，不是滚动**（`translate`，单位是"离盒子中心多少像素"）。`translate: 0` 就是**居中**，也就是装得下的图的落点和 `reset` 的落点；图可以推到任何地方（一条边拉到对面、一个角拖出边框），没有滚动范围挡着、也没有滚动条告诉你"还有多少"。这就是 mermaid 大窗与图片预览的做法，**算式也是同一份**（`cursorAnchoredTranslate`）——**但那算式的前提是"图的圆心恒在盒子中心"**，所以"居中"这件事有讲究，见下面第三条"别改回去"。
   - **拖动平移常开**；**点击出大图**（`onActivate`）、**双击复位**（**只在大窗里**：块里的第一次点击已经被"开窗"用掉了，没有第二次可给）。手势判定——4px 阈值、点击与拖动的区分、"手势与有没有溢出无关"——都在 `lib/pan-gesture.ts`，两面共用；它只**报位移**，由调用方决定这个位移加到滚动偏移上（对话里的图）还是 transform 上（大窗）。
   - **大窗里滚轮就是缩放**：整个滚轮都是（同 mermaid 大窗）——窗口里它没有别的意思。**一手 pinch 一手 mouse notch**（`ctrlKey ? trackpadPinch : mouse`，跟 `useRichBlockInteractions` 同一条规则）：一手捏合的 deltaY 是小步流，鼠标一格是大步，拿 pinch 的灵敏度读鼠标一格等于每格把图砍一半。
   - **缩放时钉住一个点**：滚轮钉住指针下那一点（坐标按"离盒子中心"算，正是 `cursorAnchoredTranslate` 要的形式），按钮 / 预设 / 快捷键钉住盒子中心——把 translate 按比值缩放即可。所以任何一次缩放都读作"缩放"，而不是"图滑走了"。
   - **"适应"除了算比例还会回到中心**：transform 下"重新居中"就是 fit 的样子（`setTranslate({x:0,y:0})`）。阶梯用 app 现成的（`RICH_BLOCK_DEFAULTS`）：25%–400%、步进 1.25、预设 25/50/75/100/150/200/400、"适应" = 占满 90% 空间且不放大（`min(1, computeFitScale)`）、大窗里 `⌘0` / `⌘+` / `⌘−`（对话里**不拦**这三个键，它们是 app 自己的）。
   - **`interactive={false}` 用在编辑器里**：mermaid 的节点视图，以及 `PreviewBlock` 里的 `drawio-preview` 节点——那里鼠标归 ProseMirror，点击要放光标。对话里和大窗里都是 `true`。两条行为都被实测钉过（用户明确要求）：**装得下的图拖一下也算拖动、不会变成开窗**（fixture 791=791 不溢出，拖 40px 不开窗），**原地按一下出大图**（1 秒后窗口在）。

   实现上有四条别改回去（`frame.tsx` 的 `DrawioDiagram`）：
   - **尺寸从 markup 上读（`parseDrawioSvgSize`），只读一次、且和读它的那份 markup 绑在一起**（`measured.current = { svg, width, height }`）；元素自己的盒子只做兜底。**这条知识只有一份**，在 `packages/shared/src/drawio/types.ts` 里——大窗和对话里的图都调它，谁也不自己解析（曾经有三份：大窗 `getComputedStyle` 量 DOM、对话块正则解析字符串、协议注释里再写一遍）。读第二次读到的是**被缩放过**的盒子（transform 落在同一个元素上），等于每次缩放都把"原始尺寸"再乘一遍 zoom，图会自己滚雪球。
   - **居中用 `left/top: 50%` + `translate(-50%, -50%)`，绝不用 flex 居中。** 实测（临时页面，同一份 DOM 结构 + 同一份算式，只换居中方式）：flex（`justify-content: center`）在子元素比容器大时会钉住子元素的**起始边**，元素长大后圆心跟着移动，单步 1.25× 就漂 **100px**——用户报的"drawio 缩放时鼠标指的位置会跳变"就是它；`left/top: 50%` + `translate(-50%, -50%)` 同一步漂 **0.0**。再强调一次：`cursorAnchoredTranslate` 的前提正是"圆心恒在盒子中心"。
   - **缩放状态必须走更新器**（`setZoom(prev => …)` 里再 `setTranslate(current => …)`），不要用 ref 读上一次渲染的值：一手 pinch 是一串 wheel 事件，几个可能赶在一次 re-render 之前，用"上一次渲染的值"会让每一步都从同一个地方重来——手感是跳，不是缩放。`useRichBlockInteractions` 就是这么写的，这也是两条路能一致的原因。
   - **缩放与平移都是元素上的 CSS transform**：SVG 本身 `scale(zoom)`（`transform-origin: top left`）并被钉在原始尺寸上（`style.width/height` 覆盖 viewer 自带的 `width: 100%`），外面那层盒子的布局尺寸按 `图 × zoom` 给，平移 `translate(x, y)` 落在同一个盒子上（和居中那两个 translate 连写）。**注意别把 translate 写到 SVG 上**：SVG 上的 transform 已经被 scale 占着，写两次会互相覆盖。（曾用 `[&>svg]:w-full` 那种 CSS 子选择器拉尺寸，选择器不生效时 `zoom` 变了、画出来的却没变；后来改成写 SVG 的 `width`/`height` 属性——但如上，这条路对没有 `viewBox` 的 markup 本来就不可能生效。）

   这套算术里**自己写的部分薄到几乎没有**（"把 translate 按比值缩放"、"fit 后回到中心"），需要盯的三条共享算式都有测试：`cursorAnchoredTranslate`（钉住一个点缩放）、`computeFitScale`（90% 适配）、`clampScale`——都在 `packages/ui/src/components/overlay/__tests__/useRichBlockInteractions.test.ts`；点击与拖动的判定在 `src/lib/__tests__/pan-gesture.test.ts`。`drawio/__tests__/view.test.ts` 随滚动盒那套（`startZoom` / `roomAround` / `restScroll` / `anchoredScroll`）一起删了——它盯的规则已经不存在，不是把测过的规则改成没测。

   图里的每个形状都带 `data-cell-id`（drawio 的 `visitStatesRecursive` 补丁盖的，导出时移除），**"人在预览里点一个框 → 我们拿到它的 id"仍然可行**，那是后续让 agent 精确定位某个形状的路。

   **图自己不再产生任何滚动条**（平移是 transform，盒子 `overflow: hidden`），所以在 overlay 里只可能有一条滚动条：父层那个遮罩滚动区。要做到这点靠的是**盒子绝对定位铺满**（`absolute inset-0`），图再大也不撑高父层。**不要再把引擎 frame 的尺寸当布局用**：它 `visibility: hidden` 且在视口外，只负责出图。早先那版把 frame 当显示面，于是"高度写 `100%` 还是 `calc(100vh - …)`"变成一道必须猜对 overlay chrome 的算术题（公共 chrome 占掉 header 与 gutter，见 `FullscreenOverlayBase` 的 `HEADER_HEIGHT` 与 `CONTENT_GUTTER`：内容**紧贴标题栏**、四周 16px，那条 24px 的"空白行"和底部 24px 一起被用户否掉了），猜错哪一边都会在 overlay 上多出一条父窗口的滚动条——而鼠标能拖的只有 frame 内部那条。现在没有这个二义性了。

7. **编辑器说的是 drawio 自己的 embed 协议，双向都是 JSON 字符串——发对象等于什么都没发。** `proto=json` 让编辑器对**收到的任何 data 跑 `JSON.parse`**：发一个结构化克隆的对象过去，`JSON.parse` 抛错，它把消息当成不可解析直接 `return`——表现是**编辑器界面完整、画布空白、任何日志里都没有一行**（它第一次上线就是这样：`buildDrawioLoadAction` 老老实实返回了对象）。反向也一样：它发出来的是 `JSON.stringify({event:'init'})`，所以 `parseDrawioEmbedEvent` 只吃字符串。两个方向各有测试盯着（`drawio-types.test.ts` 的 "speaks to the editor in strings, not objects"），别再"宽容"回对象——宽容它就等于两个方向各错一次。

   同一条链上还有两件**实测**出来的事（起一个临时静态服务把 bundle 单独跑起来，套一层宿主页验的）：
   - **编辑器只有在 iframe 里才装消息处理器**（`initializeEmbedMode` 的条件是 `(embedMessageSource || window.opener || window.parent) != window`）。顶层标签页直接打开同一个 URL，它刻意什么都不听——所以"单独开个页面测编辑器"这条路不通。
   - **启动加载链是 `PreConfig.js → app.min.js → PostConfig.js`**（域名不是 `*.draw.io` / `*.diagrams.net`、且非桌面模式时）。`mxIsElectron` 要求 UA 里**同时**有 `electron/` 和 `draw.io/`，所以我们在 Electron 里跑不会误进桌面分支（那条分支要 `mxElectron` IPC，我们没有）。顺带一条无害噪声：service worker 注册会失败（500），与画图无关。

   **编辑器有两个入口，都是同一份 `DrawioEditorPane`**（用户定的，都是开在编辑模式的那两个）：对话块的**铅笔把大弹窗直接开在编辑模式**——块本身永远是"图"，不把 10 MB 的编辑器塞进消息流（那是"块只读"这条决定的真实含义）；另一个是原型详情页的 `.drawio` 行（那是去改东西的地方）。聊天里点 `.drawio` 链接开出来的那个大窗走的是同一个窗口、只是开在看图那一面，头部的铅笔照样能切过去（那是这个窗口自己的开关，不是第三个入口）。块从弹窗拿回最新文档（`onSaved`），即便没有它，文件监视也会让它跟上。

裁掉是安全的那些，依据写在脚本自己的排除表里：`js/integrate.min.js`（22.7 MB）在两个 `.min.js` 里**零引用**；`js/orgchart.min.js` 只在向导自己的惰性链里；`export.js` / `embed.dev.js` 全文不存在；`templates/` 只有一处管理面板的 placeholder 文案；service worker 由 `Editor.enableServiceWorker` 决定，而它由 URL 参数决定（我们都不传 → 从不注册）。

**`js/extensions.min.js` 不在这张表里，这就是教训**：它出现在 `app.min.js` **唯一的启动加载**里——

```js
App.loadScripts(["js/shapes-14-6-5.min.js", "js/stencils.min.js", "js/extensions.min.js"], …)
```

我按"只在导入 Visio/GraphML/Gliffy 时按需 `mxscript`"裁掉了它（那条依据只来自 `viewer-static.min.js`），代价是**编辑器一打开就 404、起不来**。判据是"**启动加载点了谁的名**"，不是"这个名字出现过几次"，也不是"另一个文件里它怎么用"——**查看器从不需要它，编辑器一直需要它**。`PRUNE_RULES_VERSION` 记在 stamp 里，就是为了让"改了规则却没重取"不成立。

8. **语言只能从地址上给，两个 iframe 都要给，而且应用的语言码不是 drawio 的语言码。** 编辑器读 `urlParams['lang']`（drawio 自己的 embed 就是这么被嵌的），查看器则是在**脚本加载的那一刻**算 `window.mxLanguage = window.mxLanguage || f(urlParams.lang)`——所以语言必须写在 iframe 的 `src` 上（`drawioEditorUrl(origin, dark, appLanguage)` 与 `drawioViewerUrl(origin, appLanguage)`），事后发消息已经晚了；bundle 里那段"跟随浏览器语言"还只对 `*.diagrams.net` 这类 drawio 自己的域名生效，我们这个 origin 不在其中（所以它一直是英文）。**code 也不通用**：drawio 用小写裸子标签（`zh`、`zh-tw`、`pt-br`），app 用的是 `zh-Hans` 这种（`i18n/registry.ts` 的 7 种），所以 `drawioLanguage()` 取主子标签转小写——`zh-Hans → zh`，`en`/`ja`/`hu`/`de`/`es`/`pl` 原样。给一个 bundle 没有词典的码**不会报错**（`App.js` 里资源加载失败会回落英文），所以这个映射错了的表现是"语言不对"，不是"编辑器坏了"。**编辑器那份只在打开时取一次**（`frame.tsx` 用 ref 捕获地址，理由和 `dark` 一样：改 `src` 会重载那个 10 MB 的界面、丢掉正在画的东西）——所以换语言后**已经开着**的窗口还是旧语言，重开就是新语言。

9. **`drawio_tool` 的词汇与引擎的词汇是两层，中间只有一个翻译点。** agent 说的是 `--format svg|png|html|drawio`（外加 `--editable`）；引擎（drawio 的 embed 协议）说的是它自己那套 `svg`/`png`/`html`/`xmlsvg`/`xml`——`--editable` 就是 `xmlsvg`，`drawio` 就是 `xml`。翻译只在 `drawio-commands.ts` 的 `engineFormat()` 一处，`DrawioFormat`（`browser-pane.ts`）保留 drawio 的名字并在注释里点明。所以**别把 `xmlsvg`/`xml` 改成 agent 的词**（那会把翻译摊到引擎侧每一处），也**别把 `xml` 加回 `--format`**：这一版要消掉的概念正是"xml 也是一种格式"——它不是格式，是一份文档，一个不能画的东西不该出现在画图的选项里。`--editable` 只对 `svg` 有效，用在别处**拒绝而不是忽略**（理由同"按名字找不到页就拒绝"：让人以为拿到了一份能改的文件，比报错更糟）。后缀来自 `DRAWIO_EXTENSIONS` 一张表（命令层补名、electron 侧写文件、回执三者共用），`--to` 没写后缀时按格式补——`drawio` 尤其需要，因为 app 认图只看 `.drawio` 这个名字。

### 7.4 markdown：一个渲染面 + 一个源码面

`.md` 有三处入口，三处都是同一个 `MarkdownEditorPane`：对话里的 `markdown-preview` 块（`MarkdownDocBlock`，**只读**；块的标题栏 / 标签页 / 那个固定高度 / 角上那两个按钮是它自己的事）、链接打开的文档大预览（`FilePreviewRenderer` 的 markdown 分支 → `MarkdownFileOverlay`）、原型详情页文件列表里的 `.md` 行。

**两个面，两回事**（用户定的口径："不用 Tiptap 了，改为 markdown 渲染，编辑模式直接编辑源码文本"）：

1. **看是渲染**：文档交给 `Markdown`（消息那套渲染器，`mode="minimal"`、`hideFirstMermaidExpand={false}`），所以 `.md` 里写的 `drawio-preview` / `html-preview` / 表格 / diff 就是 app 自己那些块，不是副本。**嵌套守卫在这里**：`disablePreviewBlocks={new Set(['markdown-preview'])}` —— 一份文档可以指名另一份文档，把它画进来没有下限，所以那个围栏退回代码块。这套机制本来就是为渲染面写的（`MarkdownProps` 的注释直接点名 `MarkdownDocBlock`），Tiptap 那阵子没有调用方，现在回来了。
2. **改是源码**：文件正文直接进 `ShikiCodeEditor`（`packages/ui/src/components/code-viewer/`，textarea 叠 Shiki 高亮），**写回去的就是屏幕上那些字符** —— 中间没有文档模型，所以 app 不认识的写法不可能被解析器在保存时悄悄丢掉（这正是富编辑器"先解析再保存"每次都在冒的险）。主题走 app 自己的规矩：`useShikiTheme()` 优先、否则读 DOM 的 `dark`；底色字色是 CSS 变量，不用这里自己的明暗判断。这份组件是**从 electron 侧搬进来的**（那边当初就是为"markdown 源码编辑、替掉 Monaco"写的，写好之后一直没人用），搬来时按 `code-viewer/` 兄弟们的做法去掉了对 electron `useTheme` 的依赖。

**文档里的图片按文档自己的目录解析**（`packages/ui/src/components/markdown/image-path.ts` + `MarkdownImage.tsx`）：`![](shots/cart.png)` 这种相对目的地会被浏览器拿去相对**渲染层的 origin** 解析，永远到不了文件；`file:` 与绝对路径又会在 `url-transform.ts` 的 `markdownUrlTransform` 那层被清洗成空——所以本地图片在正文里原来**没有可用的写法**（唯一写法是 `image-preview` 块）。现在 `Markdown` 多一个 `baseDir`（渲染的是一份盘上的文档时由调用方给：`MarkdownEditorPane` 用 `documentDir(src)`，原型详情页的 `PRD.md` 用 `status.dir`；`Info_Markdown` / `DocumentFormattedMarkdownOverlay` 只透传；对话消息没有这个值，行为不变），`img` 交给 `MarkdownImage`：**只有相对目的地**被拼成绝对路径、经 `onReadFileDataUrl` 读回 data URL 才显示——因此图片始终是 `<img>` 的静态图模式（脚本不跑、外链不取）。**解析不绕过边界**：`validateFilePath` 仍是门，`../` 逃逸由它拒。**别改成内联 SVG 的 `dangerouslySetInnerHTML`**：那才是脚本会跑的地方，全库只有 drawio 引擎交回来的 markup 这么内联，且过桥的校验。

`MarkdownEditorPane` 自己只做这几件事：

- **哪个面由调用方给**（`mode`，默认 `'view'`）：对话里的块永远只看；大窗用头部那个铅笔在两面间切（`MarkdownFileOverlay` 的 `initialMode` + 自己的 mode state + `headerActions` 里的铅笔/眼睛，照 `HTMLPreviewOverlay` 那套）。**`initialMode` 每次打开都按当次给的值重置**：overlay 关着时也还挂载着，一个记着上次的 mode 会答错这次的问题。
- **宿主不能写就不给编辑**：大窗头部那个铅笔只在 `onWriteFile` 在时画；源码面在不能写的宿主里 `readOnly`。
- **何时写 / 能不能写 / 文件被外部改了怎么办**全交给 `useFileWriter`（见 §2⑪）。
- **文件的事说两处：保存是标题栏里的一句文案，要人决定的那个在正中**（`FileSaveStatus`；文案由 `FileSaveStateWord` 画）：**"正在保存 / 已保存 / 写失败"在标题栏里、操作按钮的左边**——那是 chrome，压不到内容，也不会把内容推来推去（标题栏左右两侧都是 `flex-1`、徽章在中间，往右边加东西徽章不动）；"已保存"**3 秒后自己消失**，计时挂在"状态变成 saved 那一刻"、不被别的重渲染重置；**"文件被改了"仍在编辑面正中**（那是决定不是通知，只有它接点击，两个按钮就是它存在的理由）。**位置是量出来的，别改回"编辑面的角"**：三个面的右上角各自压着东西——源码的前几行、页面的右上角、drawio 自己的工具栏。走过的四步：一行（每次保存开始时把正文按下去）→ 左下角胶囊（和 HTML 自己的选中提示抢同一个角）→ 编辑面右上角纯文案（就是上面那个遮挡）→ 现在这样。**状态是"报上去"的**：`PreviewOverlay` 提供 `FileSaveSlotProvider`（它是唯一同时渲染标题栏与内容的地方），`FileSaveStatus` 用 `useReportFileSaveState` 往上报，`FileSaveStateWord` 在 headerActions 前面画——**没有 provider 的宿主（对话里的 `.md` 块）就什么都不说**，那句话属于显示文件名的 chrome。**另一头是页面自己的角落**：`HtmlDesignEditor` 里那枚左下角胶囊只说关于*页面*的话——选中的是哪个元素、点一下会怎样、以及编辑器自己的提示与加载——**它只属于页面编辑器**（`MarkdownEditorPane` / `DrawioEditorPane` 没有选中这回事）。`layout` 只管**加载占位的高度**（`'pane'` 400px / `'inline'` 80px），跟这些无关。

另外几条是用户定的口径，别再"修"回去：

- **块只读，而且没有展开功能**（曾经有过上下箭头把 `max-h-400px` 拉到 `max-h-80vh`，已移除）：它是固定高度、溢出自带滚动的"看一眼"，要改或者要看全都去大窗。底部那条渐隐已经去掉（用户："效果很差"），别再加回来——它画的是一条压在文字上的灰带，而滚动条本来就说清了"下面还有"。块头**两个按钮都是开大窗**：铅笔（`Pencil`）开**源码面**（光标已经在正文里），四角（`Maximize2`）开**渲染面**，与 drawio / html / mermaid 三类块同位置同含义；铅笔**只在该宿主能写时才画**。
- **链接还是由我们路由**：渲染面用 `Markdown` 现成的 `onUrlClick` / `onFileClick`，回调缺省时有意什么都不做（`FilePreviewRenderer` 传 app 自己的 `handleOpenFile` / `handleOpenUrl`）。源码面里链接就是文本，没有可点的东西——这是"改是源码"的直接代价。
- **源码面的 `value` 必须是屏幕上那一份，不是"文件最后一次被读到的样子"**（`MarkdownEditorPane` 的 `draft`）：`react-simple-code-editor` 的 textarea 是**受控**的（`lib/index.js` 的 render 里 `value: value` 直接来自 props，而它**没有任何**"把 props 同步进 DOM"的逻辑），所以每敲一个键 `report()` 让 pane 重渲染时，若喂回去的是 `useFileWriter` 的 `document`（那东西的语义就是"文件最后一次被读到的样子"，`report` **有意**不更新它），React 会把 textarea 改回旧正文——实测表现正是用户报的**打字进不去、光标跳到末尾**。修法是 pane 自己持有工作副本（`draft`，read 之后重新播种），两个面都读它。
- **上色必须同步：先把 highlighter 做出来，再画**（`ShikiCodeEditor` 的 `highlighterFor`）。**"异步上色"这条路走过，是错的**：`codeToHtml`（简写）给的是 Promise，于是每次按键都会画两遍——先无色、下一帧才上色。用户先后报了两次同一个东西（"重新上色有抖动感"、"打字会掉色"，判据是"市面上没有编辑器打字会掉色"），我先用去抖（收手才上色）绕，那是把闪烁换成"打字时没颜色"，同样不对。正解是 `createHighlighter({ themes, langs })` **建一次**（按主题名缓存），建好之后 `codeToHtml` 是**同步**的，一次按键一次绘制、颜色就在里面。实测：连打 16 个字符，高亮层每帧都有颜色（styled span 计数恒为 2、最小值为 2，从不掉到 0）。三条附带事实：① highlighter 在编辑器出现时就预建（几百毫秒，早于人开始打字），建成之前那一帧是**当前文本、无色**——**不能拿上一次的高亮结果顶上**，那会让透明 textarea 上面那层显示上一版文字，看着像"字没进去"（这个坑也踩过）；② 主题名要能被 Shiki 认识，用户预设可能给一个不在 bundle 里的名字（实测 `ShikiError: Theme ... not found`），所以失败时回落到 github-light/dark；③ 只有 `HIGHLIGHT_LANGS` 里那几个语言是加载过的，别的按 `text` 画。
- **窗口写完，块要自己重读**（`MarkdownDocBlock` 的 `wroteRef` + `revision` 当 `key`）：**块和大窗是同一个文件的两个读者**，大窗写的是磁盘，块这边没有任何人告诉它——`usePrototypeFileWatch` 挂的是 prototypes 那棵树的 watcher，所以原型目录以外的 `.md`（plans、项目文档）永远不会跟上。修法不是把文本搬过去，而是**关闭时重读**（`onSaved` 只记一个"写过"的标记，`key={src:revision}` 触发重新挂载 → 重新读盘）：盘本来就是权威，顺带还能带上别的写者的改动。**这也是"两个 `useFileWriter` 实例"的代价**，别再指望 watcher 兜住它。
- **"边看边跟"只对原型目录里的文件有效**：`usePrototypeFileWatch` 挂的是 prototypes 那棵树的 watcher，所以 plans 里的 `.md` 在编辑期间不会自动跟上别人的写。**保存始终是安全的**——写之前一定重读并与"我见过的那一版"比对，不一致就停下来问人（`useFileWriter`），这条不依赖 watcher。
- **⌘S / Ctrl+S 是"现在写"，不是"开始写"**（`useFileWriter` 里挂在 window 上的 keydown）：写本来就是**停手约 1.2 秒后自动发生**的（`SAVE_DEBOUNCE_MS`），这个键只是跳过那次停顿。三条都是决定：① **没变就不写，判断只有一处**：`save` 本来就要**写之前重读**，读回来和手里这份一样就**不写**、只说"已保存"（磁盘是权威，所以判据是**刚读到的内容**，不是我们的记忆）——打回原样、⌘S 在没欠着的时候按、写完又按，都走这一条。**上一版我把这个判断也抄进了 `report`**（不安排那次写），那是多余的：两处判断要互相保持一致，还砍掉了"停顿一次就重读一次盘"这条性质（那是树外文件发现外部改动的唯一途径），所以撤掉了。顺带的三件事也是它：**写失败后按 ⌘S 是重试**（盘上确实不是我们这份）、**冲突判断在它之前**（我们有改动 + 盘上被人改了，照样停下来问人）、**只读宿主**（没有 `onWriteFile`）在更前面早退。**补丁那一层同理**（`HtmlDesignEditor` 的 `commitPatch`）：产生的源码和手里那份一样就**不入撤销栈也不上报** —— 同一个样式点两下、或者按 ⌘S 时没人动过文字，撤销栈上不该多出"按了没变化"的一步；三条补丁路径（文字/样式/删除）现在都走这一个判断，不再各答一遍（那三句"pushUndo + draft + report"原来是抄了三份的）。② **无论有没有可写都 `preventDefault`**：一个文件开在窗口里的时候，这个键在这儿没有别的意思。③ **iframe 里的键只能自己转发**：frame 是**独立文档**，在它里面按的键不会冒泡到宿主文档（同源也一样，与进程无关），所以"绑在宿主 window 上"对里面天然无效。页面编辑器的探针因此自己转（`post('save')` → 编辑面调 `flush()`）：**两个入口，一个决定**（`flush` 是 `useFileWriter` 暴露出来的那一个）。**正在双击改文字时按 ⌘S**（用户问的正是这个）：探针把元素里**此刻的文字**先 `post('text-committed')` 上去（父页面补源码 + `report`，**不重建 frame**），再 `post('save')` —— **不失焦、编辑不中断**（保存不是把光标从正在打字的地方拿走的理由），而**不是**先 `commitEdit()`（那等于回车，会把光标赶走）。代价是 `cancelEdit` 必须学会这件事：那次中途上报之后源码里已经是这段文字了，所以**按 Escape 要把它一并恢复成编辑前的那份**（`editReported` 这个标记就是为它存在的）——少了这一步，Escape 会让页面显示原文、文件里留着半截文字。drawio 不是我们的文档，它自己应答 ⌘S 并上报文档（同一次写晚一拍）——那条**没实测过**。别把它改成"绑在编辑盒上"——那就只覆盖了 markdown；也别为此去主进程加 `before-input-event`，那会变成第二个快捷键系统（Windows/Linux 上这个 app 连原生菜单都删了，macOS 上菜单项还刻意 `registerAccelerator: false` 把键让给渲染进程）。
- **源码面的盒子必须是"确定高度"，而在这条链上只有绝对定位做得到**（`MarkdownEditorPane` 里 `relative` 的 keyed div + `<div className="absolute inset-0 flex flex-col">` 里装 `ShikiCodeEditor`）：overlay 那层 `min-h-full` 是**最小值不是一个尺寸**，所以挂在它下面的 flex 项会被它本该滚动的内容撑大——实测（3000px 源码、同一套类名、只看编辑器那一种尺寸写法）：`h-full` 与 `flex-1 min-h-0` **都是 3000px 的编辑器 + 页面出现滚动条**（内容按下去时正好滑过透明的标题栏，就是用户报的"顶部位置会移动、内容穿上去"），只有 `absolute inset-0` 得到 **232px 的编辑器 + 页面不滚、`scrollHeight` 3000**。同一个原语 `DrawioEditorFrame` 早就用了（它的注释里就是那次实测），这里只是补上。**别把它"简化"回 flex-1 / h-full**：判据不是"看起来等价"，是 `pageScrolls` 这个布尔值。渲染面（只读那个列）仍是 `flex-1 min-h-0 overflow-auto`，所以**长文档在只读面依然会滚整个窗口**（那是这套公共 chrome 的"纸滚动"模型），要不要一起改成固定盒是另一个决定。
- **Tiptap 那一套现在没有任何调用方**（`TiptapMarkdownEditor` 及其 `extensions/`、`TiptapBubbleMenus`、`TiptapSlashMenu`、`TiptapCodeBlockView`、`tiptap-editor.css`，以及只测它的 `official-markdown-math-foundation.test.ts`），是**有意先留着**的（用户定的"先只换面，Tiptap 文件留着"），`@tiptap/*`、`tiptap-markdown`、`katex` 依赖也没动。要点是：**代码里已经没有任何一条路会走到它**，别把它当成"另一条还在用的路"；要清就整块清。
