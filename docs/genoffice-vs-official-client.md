# 我们和 GenOffice 官方客户端：差在哪，谁欠谁

> 对象：`apps/electron` + `packages/office-host` 里嵌入的 GenOffice 编辑器（docx / xlsx / pptx / pdf）
> 状态：2026-10-31。姊妹文档：`genoffice-integration.md`（我们怎么搭的）。

---

## 0. 一句话

**他们的编辑器是"自己家的前端"，我们的编辑器是"别人家的前端装进我们的壳里"。**

同一个 bundle，两种命：

| | GenOffice 官方 | 我们 |
| --- | --- | --- |
| 编辑器跑在 | 他们的 Electron 应用里 | 我们的 `craft-local://office-<hash>` 来源，装在一个**不透明 iframe** 里 |
| 谁提供 `window.desktop` | 他们自己的 preload | **一个字符串脚本（shim）**，转发给宿主页或主进程 |
| 文档在谁手里 | 他们的主进程 | 我们的 `packages/office-host`（deck 引擎 / xlsx sidecar / pdfium / 字节） |
| 窗口 | 他们想开多少开多少（预览窗、母版窗、观众窗） | **我们只有一层覆盖层**（+ 导出用的隐藏窗口） |
| 对话框 | 他们的主进程直接 `dialog.showOpenDialog` | **客户端的**（桌面 = Electron；浏览器 = 无原生对话框） |
| 网页版 | 有（但他们自己的壳） | 有（hub，同一个 origin 路由，但**没有桌面能力**） |

所以差异不是"他们做得更多"，而是：**他们的前端有些功能默认自己的客户端形态在场** —— 一个能开窗口、有原生对话框、有系统剪贴板、有拼写服务、有账号和字体 CDN 的主进程。我们得逐条回答："这功能在我们这儿由谁来做？"

---

## 1. 四个档，只有一个是"我们欠的"

每条编辑器调用落到下面四档之一（账本见 `bun scripts/check-office-methods.ts`，四行 pending 全 0）：

| 档 | 意思 | 谁欠 |
| --- | --- | --- |
| **A. 等价，只是换了地方** | 这件事有人做，只是不是他们的主进程 | 不欠：已经能用 |
| **B. 绕路** | 目标一样，机制不同（有时更好，有时有代价） | 不欠，但要记住代价 |
| **C. 没有这个能力 / 这个部件** | 需要他们的服务，或需要一个我们没建的新部件 | **看情况**：产品差异 = 永不补；部件 = 想补就能补 |
| **D. 他们自己也没有** | preload 里有名字，main 里没有 handler | 不欠：死代码 |

---

## 2. A 档：等价，只是换了地方

**形状**：编辑器问"你能不能……"，我们的答案是"能，但问的人不是你以为的那个"。

| 功能 | 他们的做法 | 我们的做法 |
| --- | --- | --- |
| 打开 / 保存 / 另存 | 主进程 `fs` | 帧里的 `writeBytes` + 主进程的 guard（保存前查磁盘是否被改过） |
| 文件 / 目录选择 | `dialog.showOpenDialog` | **客户端能力**：`file:openDialog` / `file:saveDialog`（桌面 = Electron，浏览器 = 无原生对话框，落回同目录） |
| 打印到纸 | `webContents.print` | **没有打印机**：`listPrinters → []`，`print*` 具名拒绝，导 PDF 代替 |
| 导出 PDF/HTML/MD | 主进程打印 | 帧里点导出 → 客户端对话框 → 主进程隐藏窗口打印（见 B 档） |
| 设备密码 | 主进程 | 渲染进程问（我们不存密码） |
| 菜单 / 右键菜单 / 标签页 / 附件 / 粘贴图片 | 主进程 + 渲染进程 | **渲染进程自己的**（那是我们的 UI，不是他们的） |
| 最近文件 | 他们记 | 我们自己记（`recent` 拒绝） |
| 麦克风 / 屏幕采集 | `systemPreferences` / `desktopCapturer` | **客户端的**（权限属于人，不属于文档） |
| `newBlank` / `confirmCsvSave` / `armContextMenu` / `focusDocsTab` | 他们的壳 | 我们的壳自己处理（不是缺口） |

> 这一档的共同点：**"谁拥有这个人"变了**。他们的主进程拥有窗口，我们的客户端拥有窗口；他们的主进程拥有文件对话框，我们的客户端拥有它（因为 hub 的文件在服务器上，人看不到）。

---

## 3. B 档：绕路 —— 目标一样，机制不同

每条都附**为什么**和**代价**。

| 功能 | 他们的路 | 我们的路 | 代价 |
| --- | --- | --- | --- |
| **打印成 PDF** | 打印窗口（编辑器是顶层文档） | **问编辑器要 PDF**（三个 `exportPdf` 门：docs 打印自己 / sheets 交 HTML print job / slides 交每页 SVG） | 无（更准：幻灯片保留矢量）；但 `printWorkbook/printSlides/print` 这些"真打印"仍然没有 |
| **幻灯片跨窗口复制** | 系统剪贴板的**自定义 MIME**（`io.genoffice.slides.slide`） | **HTML 标记**：载荷 base64 塞进 `text/html` 的 `data-craft-deck` | 浏览器看不到自定义 MIME；HTML 每家的剪贴板都保留。代价：复制时一次 base64、粘到别的应用是隐形 div |
| **同进程跨窗口粘贴** | 主进程持有剪贴板 | 我们也持有（`deckClipboard`）——**这条本来就成立** | 无。OS 剪贴板只是为了"跨重启" |
| **Compare 两个 PDF** | 两侧都用 pdfium（他们主进程） | **我们自己接 pdfium**：`extractPageTexts`（`FPDFText_*`），78ms/2 页 | 无。反而避免"pdf.js 与 pdfium 断行不同"的假 diff |
| **图片导出到目录** | `dialog.showOpenDialog({properties:['openDirectory']})` | **同一个目录对话框**：`dialog:openFolder` 早就存在（工作目录选择器在用），帧里接 `onPickDirectory` | 无。只有「宿主没有原生对话框」（浏览器标签）时才退回「选个文件名、取它所在的目录」 |
| **母版视图** | `session.masterEdit`（他们自己的会话状态） | op 的地址换成 **`{ part: 路径 }`**，`runTxn` 收 `parts: Map`（就地改对象、写回部件） | 无：同一套 op 层 |
| **文档在导出窗口打开** | 他们不需要（总是自己开窗口） | 导出窗口没有宿主页，所以 shim 走 `/__craft/office-call/<token>`，主进程用**同一套宿主**答 | 每个导出窗口多一条 token 路由 |
| **xlsx sidecar** | 他们自带（Rust 二进制，含 `find_cells` / `read_row_outline`） | 同一个二进制，只转发**它真有的命令**；那两个没有的改成**从 `read_range` 投影**（它本来就带每格的 value/formula 与每行的 outlineLevel） | 查找每次要读一遍各表已用区域（他们的 Rust 版走分块索引）；小中型表无感 |
| **保存工作簿** | 主进程把编辑日志交给**同一个 gateway**（只重写碰过的部件） | 我们把编辑日志交给 **CLI**（`genoffice sheet apply`），跑的是**同一套 gateway** | 无差异；代价只是多一次进程调用 |
| **自动重命名** | 主进程按内容改名 | 拒绝（要客户端对话框） | 导出文件保留我们给的名字 |

---

## 4. C 档：没有这个能力 —— 分两种

### 4.1 产品差异（**不该补**，补了就是我们变成另一个产品）

| 拒绝的 | 为什么 |
| --- | --- |
| `aiStream` / `aiGenerateImage` / `analyzeMedia` / `localGeneratePage` / `pickModel` / `openAiModelSettings` / `landGeneratedPages` | AI 在这个产品里**关着**（`PREFS` + `getAiSettings`）。我们的 AI 在会话里，不在这四个编辑器里 |
| `aiGskLogin` / `aiGskStatus` / `gskStatus` | 没有 GenOffice 账号体系 |
| `aiLogRunFailure` | 没有他们的遥测管道 |
| `imageSearch` / `webSearch` | 没有他们的搜索服务（agent 有自己的） |
| `skillText` / `skillsList` / `openSkillsSettings` | 没有他们的技能库 |
| `listStyleTemplates` / `loadStyleTemplate` / `saveStyleTemplate` / `saveStyleSidecar` | 没有他们的样式模板库 |
| `fontCatalog` / `fontDownload` / `fontInstallLocal` | **他们的字体 CDN**。我们不运行这个服务 |
| `kbList` / `kbRead` / `kbSearch` | 知识库/vault —— 那是他们另一个应用的面 |
| `zoteroCommand` / `respondToZotero` | 没有 Zotero 桥 |
| `spell*`（七件套）/ `respellKick` | 拼写检查要 Electron `session` 的拼写服务 + 注入按键；我们的 `PREFS.spellcheck = false` |
| `signalMcpReady` / `reportMcpResult` / `createDocument` / `runCli` | 他们的桌面 MCP / 命令面；我们的 agent 走自己的通道 |
| `reportCloseCheck` | preload 有，main 没有（D 档，见下） |

### 4.2 缺一个部件（**想补就能补**，只是还没做）

| 拒绝的 | 需要什么新部件 |
| --- | --- |
| **多屏演播**（`presenterStart` 的 `{audience:true}` 分支、`audienceNav/Ready`、`presenterSync/Ink/Swap`） | 一个 `?mode=audience` 的**第二窗口/标签**（桌面找外接屏并全屏，浏览器 `window.open`）+ 同源 `BroadcastChannel` 中继。audience 只问 `getRenderSlides/getAnimations/getTransition/getShapeKeys/onDeckChanged` —— **这五个我们已经都答** |
| `readPivotDefinition` | 他们的 pivot 解析器（`parsePivotDefinition`），不在引擎 bundle 里 |
| `pagePreviewPng` | **做不了**：涂销矩形只在 `save` 那一刻离开编辑器，实时预览拿不到几何 |
| `exportCsv` | 保存对话框 + sidecar 的 `convertWorkbook`（工作簿里有，链路没接） |
| `writeWorkbookRecovery` | 他们的恢复副本记账；我们整本写，不需要 |
| `writeExportImage` / `takeExportPdf` / `saveMergedPdf` / `writeMergeOutput` | 都是他们导出流程里的临时文件握手（先要有他们自己的 picker） |
| `autoRename` / `autoRenameWorkbook` | 内容改名 —— 要客户端对话框 |

---

## 5. D 档：他们自己也没有

`reportCloseCheck`、`signalMcpReady`、`reportMcpResult`（docs），以及 **`saveWorkbookEdits`**（sheets）—— preload 里挂着名字，main 里 grep 是 **0**。写进拒绝表时的原因就是"他们的 main 也没有"。

> `saveWorkbookEdits` 尤其值得记：它听起来像"增量保存"，很容易被当成一条我们欠的账（"人家能只写改动，我们整本写"）。**实际他们的 main 里根本没有这个 handler** —— 增量保存是 `saveWorkbook` 内部的事，不是这个通道。

这条值得单独说：**不是所有"编辑器会调的方法"都真的实现了**。我们照 preload 对账时，会把这些误当成欠账。

---

## 6. 一张"要补时怎么补"的决策表

| 想补的 | 需要付出的 | 属于谁 |
| --- | --- | --- |
| 多屏演播 | 新 IPC（开窗/关窗）+ 主动开第二窗口 + shim 加一条 BroadcastChannel 通道（~10 行）+ 帧里 4 个方法改写 | **我们**（部件） |
| ~~目录选择器~~ | **已经有了**：`dialog:openFolder` → `requestClientOpenFileDialog({properties:['openDirectory','createDirectory']})`；帧里接 `onPickDirectory` 即可 | 已接 |
| 与 GenOffice 桌面互通剪贴板 | Electron `clipboard` + 自定义 MIME 通道 | **我们**（但用户已说不做） |
| ~~xlsx 查找 / 分组大纲~~ | **已解决**：`read_range` 本来就带 outlineLevel 与 value/formula，宿主直接投影（`workbookFindCells` / `workbookRowOutline`，通配符有单测） | 已接 |
| pivot 定义 | 从他们的包里导出解析器（同 `mapScriptOps` 的做法） | **引擎构建** |
| 字体目录 / 下载 | 他们的 CDN + 一份机器字体清单 | **不补**（产品差异） |
| AI 面板 | 我们的 AI，不是他们的 | **不补**（产品差异） |

---

## 7. 这份文档怎么不烂

1. **账本是机器生成的**：`bun scripts/check-office-methods.ts`，`--strict` 时任何"既没答、也没拒、也不在待办"的方法会让它失败。文档里的分档只是对同一份数据的解释。
2. **未接的调用会自己说话**：`[office] deck asked for X, which this host does not answer`（每进程每方法一次）。被拒的编辑也会说：`[office] deck refused an edit: <op 层人话>`。
3. **改一节就得改两个地方**：新增/删除一个可答方法时，同步改 `REFUSED`/`PENDING` 表和本文档第 2–4 节。忘了第一步，`--strict` 会告诉你；忘了第二步，只有人会发现 —— 所以第二步尽量少（表格按档分组，不是一方法一行）。
