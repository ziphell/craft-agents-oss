# GenOffice 四模块实测报告（docx / pdf / xlsx / pptx）

> 日期：2026-10-29
> 宿主：`C:\Users\Ryan\code\craft-agents-oss` 自带的 **Electron 39.2.7**
> 模块：`C:\Users\Ryan\code\genoffice`（HEAD `b239d2e5`，`npm install --ignore-scripts`）
> 脚本与截图：`sessions/261029-rapid-hill/data/spike/`（`cdp-drive.mjs`、`host/main.js`、`out-*/`）

## 0. 结论（先看这张表）

| 格式 | 构建 | Electron 39 下独立运行 | 渲染真实文件 | 应用内编辑 + 保存 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **docx** | ✅ 10.7s / 33MB | ✅ | ✅ 4 页 1203 字，版式、标题层级正确 | ✅ **实测**：改一段 + Ctrl+S，8 个 zip 条目中**只有 `word/document.xml` 变**，其余 7 个字节不变 | 已验证宿主进程内嵌（见 §3） |
| **pdf** | ✅ 3.8s / 13MB | ✅ | ✅ 真实 PDF（`sow-live-data.pdf`），缩略图栏 + 文本层 + 批注/编辑文字 ribbon | 未做自动回归（界面具备） | 需把内部 `registerPdfIpc` 导出 |
| **pptx** | ✅ 6.0s / 22MB | ✅ | ✅ 5 页，缩略图、标题/副标题、演讲者备注栏 | 未做自动回归（界面具备） | 字体回退正常（Calibri→替代） |
| **xlsx** | ⚠️ 需 Rust（`cargo build` 编译 sidecar）；只跳过 native 也能构建 42MB | ✅ UI 起来 | ✅ **sidecar 解析成功**：`sheets:[{name:"Sales",rowCount:5,columnCount:4,...}]`、样式、`readOnly:false` | 未验证 | 用纳米 Work 的预编译 `xlsx-sidecar.exe`(8.8MB) 即可跑；网格显示需宿主调 `queueWorkbookForView` |

**一句话：四种格式在 Electron 39 上都能构建、都能渲染真实文件；docx 的"编辑→保存→只有改动块被重写"已经字节级验证通过；四种模块都能被外部 Electron 主进程当成 `WebContentsView` 内嵌。**

## 1. 构建（不需要 Rust，sheets 除外）

```bash
npm install --ignore-scripts          # 跳过 electron 下载与 install-electron postinstall
npm run build -w @genoffice/docs      # 10.7s → out/ 33MB
npm run build -w @genoffice/pdf       #  3.8s → out/ 13MB
npm run build -w @genoffice/slides    #  6.0s → out/ 22MB
npx electron-vite build               # apps/sheets 里跳过 native:build → out/ 42MB
```

`apps/sheets` 的 `build` 脚本是 `npm run native:build && electron-vite build`，前者要 `cargo`（Rust）。**只影响 sidecar 二进制，不影响 renderer/main 编译。**

合计 **110MB**（docs 33 + sheets 42 + slides 22 + pdf 13），比我按纳米 Work 产物估的 70MB 大——因为这份构建带全部语言包与 AI 资源。

## 2. 独立运行（Electron 39.2.7）

用 `cdp-drive.mjs` 拉起并截图（`data/spike/out-*/*.png`）：

- **docx**：`electron apps/docs` + 把路径经 `second-instance` 转发进去 → 4 页文档正常渲染。
- **pdf**：`electron apps/pdf <file.pdf>`（argv 直读）→ 1 页 PDF + 缩略图 + 文本层。
- **pptx**：`electron apps/slides <file.pptx>`（argv 直读）→ 5 页幻灯片 + 缩略图。
- **xlsx**：`electron apps/sheets` 不读 argv（它没有"按路径打开"的入口），改用渲染进程 API `desktopApi.reopenWorkbook(path)` → **主进程 sidecar 解析成功**（返回 `sheets:[{name:"Sales",rowCount:5,columnCount:4}]`、样式、`readOnly:false`），但网格仍是空白页——因为正确入口是宿主的 `queueWorkbookForView()`（见 §3）。

### 编辑 + 保存（docx，字节级）

```
复制 fixture → 打开 → 点击正文 → Input.insertText(" SPIKE-EDIT-TEXT ") → Ctrl+S
before 2476 B → after 2499 B
entries: before=8 after=8  unchanged=7  changed=1  added=0  removed=0
changed: ['word/document.xml']
```

**"只重写改动块、其它条目字节不变"这条承诺，实测成立。**

## 3. 宿主内嵌（这才是 Craft 要走的形态）——已验证

用 40 行 harness（`data/spike/host/main.js`，一个 `BaseWindow` + 一个 `WebContentsView`）在**外部 Electron 主进程**里加载 docs 模块，成功渲染真实 docx（`out-host/host-docs3.png`：4 页、1204 字、标题/正文齐全）。

实测得出的**宿主启动顺序**（少一步就不出内容，症状已记录）：

```js
// 1) app ready 之前 —— 注册特权 scheme（否则 genoffice-app:// 无法解析）
docs.registerDocsScheme()

// 2) app ready 之后 —— 给 scheme 挂真正的协议处理（少了它=白屏，did-finish-load 都不触发）
docs.installDocsProtocol()

// 3) 注册模块自己的 IPC（少了它=渲染进程报 "No handler registered for 'docs:recent'"）
docs.registerDocsHostIpc()

// 4) 创建视图并挂到宿主的窗口上
const view = docs.createDocsView()          // 注意：传 path 在内嵌模式下不会自动打开
win.contentView.addChildView(view)
view.setBounds({ x: 0, y: 0, width: 1360, height: 900 })

// 5) 打开文件（这是实测唯一可靠的入口）
docs.openExternalDocx('C:/…/host-test.docx')
```

**实测踩到的三个坑**：

1. **`out/main/index.js` 是"独立应用"，不是库**。它只 `startDocsStandalone()`，不导出任何工厂。
   → 必须给每个 app 加一个 host 入口（我改了 `apps/docs/src/main/index.ts`，**23 行**，见 `scripts/patches/genoffice-docs-host-entry.patch`）。
2. **只 `registerRendererScheme()` 不 `installRendererProtocol()` = 白屏**：页面 target 存在但 `document.readyState` 永远不完成，`did-finish-load` 不触发，`capturePage` 超时。
3. **`createDocsView(path)` 在内嵌模式下不打开文件**（渲染进程不消费这个 pending 队列）；用 `openExternalDocx(path)` 才生效。

### 四模块的宿主入口（已核对源码）

| 模块 | 视图工厂 | 必须由宿主调用的注册 | 打开文件 |
| --- | --- | --- | --- |
| docs | `createDocsView()` | `registerDocsIpc()` | `openExternalDocx(path)` |
| pdf | `createPdfView(path)` | `registerPdfIpc()` —— **目前是内部函数，要导出** | 工厂参数 |
| slides | `createSlidesView(path)` | `registerSlidesIpc()` | 工厂参数 |
| sheets | `createSheetsView({openingWorkbook:true})` | 自己内部已调 `registerSheetsIpc()` | `queueWorkbookForView(wc, path)` |

## 4. 缺失的 shell 通道（无害但会刷日志）

内嵌后渲染进程会去找一批**属于 shell（而非模块）**的通道，实测报错清单：

`app:get-theme`、`app:get-document-theme`、`app:get-ai-panel-prefs`、`app:get-author-name`、`app:get-auto-save-default`、`kb:list`、`ai:get-settings`、`ai:gsk-status`、`project:resolveChat`、`home:open-path`。

- 这些都是"宿主或 shell 提供"的能力：主题、作者名、自动保存默认值、知识库、AI 设置、项目会话解析、首页打开。
- **不实现也不崩**：模块用默认值继续跑（AI 面板显示但不可用）。
- 要"关掉 AI"最省事的做法就是**不注册 `ai:*`**（`registerAiIpc` 不调用），再裁剪 preload 里的 AI 入口。

## 5. 与 Craft 现有架构的对接点（已核对）

- `App.tsx` 的 `FilePreviewRenderer` 是按 type 分派的单一插口 → 加 `docx/xlsx/pptx` 分支即可。
- 独立文档窗口：照 `openDesignWindow`（`?designWindow=true`）复制一个 `?docWindow=true`，窗口里挂 `WebContentsView`（本次验证的方式）。
- 主窗口内嵌（二期）：Craft 主窗口目前**没有** `addChildView` 先例，只有 `browser-pane-manager.ts` 里的三明治可以照抄。

## 6. 待办 / 未验证

1. **pptx / pdf 的编辑→保存回归**没做（界面具备，逻辑同 docs：`requestXSave` 异步握手）。
2. **sheets 网格显示**没截到图（缺 `queueWorkbookForView` 的宿主接法），但解析链路已证明可用。
3. **Rust 缺失**只影响 sidecar 自编译；已知纳米 Work 的预编译 sidecar 与本源码**协议兼容**（本次即用它跑通解析）。
4. **`registerPdfIpc` 未导出**、slides 的注册分散在 `slides-main`/`ai-ipc`/`attachments-ipc`，都要在 host 入口里补。
5. 我**改动了你的 genoffice 检出**：`apps/docs/src/main/index.ts`（host 入口，23 行）。补丁已存 `scripts/patches/genoffice-docs-host-entry.patch`，需要还原就 `git checkout -- apps/docs/src/main/index.ts`。

## 7. `render` / `--to pdf` 能不能接过来（2026-10-29 实测）

三件事都被测过：

1. **`printToPDF` 本身可用**：隐藏 `BrowserWindow` 加载宿主页（parent + iframe），等编辑器排版好，
   `printToPDF({ printBackground: true, preferCSSPageSize: true })` → **205,675 字节的 PDF**，内容确实是那份文档（中文、表格都在）。
2. **但打印宿主页是死路**：iframe 在打印时是**一个不能被分页的盒子** —— 实测 1 页、只印出一部分，
   而且宿主自己的 chrome 也被印进去（我的调试条 "opened 4260 bytes" 出现在 PDF 底部）。
3. **编辑器自带 `@media print`**（`apps/docs/src/renderer/styles.css:11178`）：隐藏 `.ribbon`/`.status-bar`/`.ai-dock`/
   `.nav-pane`/`.ruler` 等。**只有把编辑器当顶层文档打印**，这套规则才生效 → 干净、可分页的 PDF。

### 结论：要接，就得实现"无 parent 打开"

导出路径必须让**编辑器成为顶层文档**，而 shim 平时依赖 parent 传字节。所以需要第二种传输：
宿主给一次性 token → shim 同源 `fetch('/__craft/office-file/<token>')` 拿字节 → `consumePendingOpenDocx` 返回它造出的 blob URL。
这正是 GenOffice 自己 `--headless-export` 的形状（隐藏窗口 + 预置文档）。

导出模块的形状（≈ `office-export.ts`）：token 分配 → 隐藏窗口 `craft-local://office-<label>/docs/?__craft_export=<token>`
→ 等 `.doc-page` → `printToPDF` → 撤销 token、销毁窗口。PNG 再走 `printToPDF → 光栅化`（pdfium/pdf.js）。

**未完成**：我那个 parent-less spike 里编辑器没挂载起来（`pages: 0`，763 字节空白 PDF）——是 boot 时序问题
（`consumePendingOpenDocx` 在 `editor` 就绪后才调用，见 `apps/docs/src/renderer/App.tsx:2176`），不是能力问题。
要做得对，需要单独验一次"无 parent 时编辑器能打开文档"。

## 8. 编辑器自带的 AI 面板怎么关（2026-10-29 实测）

**用它自己的开关，不要靠 CSS 硬遮。**

- `getAiPanelPrefs` 返回完整偏好 `{ side, fontSize, customFontSize, spellcheck, openInNewDocs, showAiSidebar }`；
  `showAiSidebar: false` 会把 dock 收成 0 宽并隐藏 rail（上游注释：像 Word 对待 Copilot 面板），
  `openInNewDocs: false` 让新文档不再自动打开。**只返回 `{open:false}` 无效** —— 我第一版就是这个，面板照旧显示。
- 面板的"门"（ribbon 里那组 Genspark AI）没有开关，用宿主注入的一条 CSS 去掉：
  `.ribbon-group:has(.ai-entry) { display: none !important }`（`prepareEditorDocument` 里，与 shim 一起注入）。
- `spellcheck: false`：宿主没有 `spell*` 服务，开着只会产生没人回答的调用。
- 实测截图：面板、rail、ribbon 入口全部消失，文档占满宽度（`data/spike/out-web/no-ai.png`）。

**为什么不把模型选择接到 Craft**：面板的模型是 "provider + apiKey + model id"，Craft 是 llm-connections + 每会话选择 + skills；
更关键的是面板自带一套工具协议（page-writer / brief-writer / edit-queue / search-skill），接过来等于在编辑器里再跑一个
没有工作区上下文的 agent，还要实现 `aiChat`/`aiStream` 的流式桥。**决定：编辑器不带 AI，AI 留在对话里**；
将来加"把选中段落交给对话"（对齐 HTML 编辑器已有的 `onSendToChat`）即可。

## 9. "选中段落 → 交给对话"（2026-10-29 落地）

链路（实测通）：

```
编辑器 selectionchange（节流 200ms，截断 4000 字）
  → shim 发 {protocol:'craft-office/1', type:'selection', text}
  → OfficeFrame 的 onSelectionChange
  → OfficePreviewOverlay 头部出现「把选中内容发给对话」按钮（空选区时没有按钮）
  → platform.onSendToChat({ path, text })
  → App.tsx 把引用追加进输入框：`<path>` + `> 选中的文字`
```

- 协议的 `selection` 是**帧推**不是主机拉：iframe 是另一个 document，主机读不到它的选区，
  跨源也收不到 selectionchange。按钮"点了才知道有没有选区"分不清"没选"和"不知道有这个功能"。
- `PlatformContext.onSendToChat` 的载荷从 `{path, html}` 扩成 `{path, html?, text?}`：
  网页交标记（HTML 代码块），文档交选中的散文（引用块），两者都带文件路径。
- 实测：在编辑器里选中一段（`事项`，表格单元格），主机侧 `window.__selection` 收到同一段文字。
- i18n：`preview.officeSendSelection` / `preview.officeSentToChat`（7 语言，parity OK）。ui 367 tests / host 9 tests 全过。

**为什么这是"编辑器里叫 AI"的正解**：不使用编辑器自带的 AI 面板，而是把它当成"选区来源"，
由当前会话的模型与 skills 去改——模型选择的问题因此不存在。

## 10. 导出落地：`office:exportPdf` / `office:exportPages`（2026-10-29）

代码：`apps/electron/src/main/office-export.ts`（打印/逐页截图）+ `office-host.ts` 的一次性 token 与
`/__craft/office-file/<token>` + `rpc/office.ts` 的两个 handler + `channel-map`/`ElectronAPI`。

**做法（三步，与 `office-export.ts` 同形）**：`registerExportFile(path, bytes)` 拿 token →
隐藏窗口加载 `<origin>/<app>/?__craftExport=<token>`（**同一路径、只加 query**，否则 `./assets` 404）→
轮询 `.doc-page` 出现 + 等 `document.fonts.ready` → `printToPDF({printBackground, preferCSSPageSize})`
或逐页 `capturePage(rect)` → 销毁窗口并释放 token。

**实测**：parent-less 页面能挂载（`pages:1`、ribbon 在、AI 组被隐藏），导出的 PDF **只有文档、没有 ribbon/AI 面板/状态栏**，
第 1 页内容正确（标题/项目符号/表格/日期）。

**已知问题**：内容 1 页却导出 **2 页**（第 2 页空白）——`preferCSSPageSize` 与编辑器分页规则的交互，
需要对照它自己的打印路径（`docs:print`）再调一次。PNG 路径未跑（同一窗口，逐页 `capturePage`）。

**边界**：路径过 `validateFilePath`（与 `file:read` 同一条规则），字节由 handler 自己读；hub 无浏览器 → 依赖缺失时报错而不是假装导出。

## 11. 空白尾页的原因与 `docx_tool`（2026-10-29）

**空白页 = 纸型不对**：`preferCSSPageSize: true` 取的是 CSS `@page` 盒子，而文档按 sheet 自身的像素尺寸排版，
两者差一个取整，Chromium 就把溢出的一点内容放进第二页（实测内容 1 页 → 输出 2 页，且整份是 **Letter 612×792pt**）。
修法照 GenOffice 自己的 `docs:print`：**传显式 `pageSize`（英寸）+ `margins: 0`**，尺寸从渲染后的
`.doc-page` 读（793.7×1122.5 px ÷ 96 = A4 8.27×11.69 in）→ 输出 **1 页、595pt 宽**。已写进 `office-export.ts`。

**`docx_tool` 上线**（`packages/shared/src/agent/docx-commands.ts` + `docx-tools.ts` + `tool-defs.ts` +
`pi-agent.ts` + `session-scoped-tools.ts`），命令：`create / read / apply / convert / guide`，
agent 不写 OOXML 字节，全部由 GenOffice CLI 做（文件级，hub 也能跑）。

三个实测要点：
1. CLI 从 `resources/cli/genoffice.cjs` 解析（`GENOFFICE_CLI` 可覆盖，dev 回退到兄弟 checkout），
   用 `ELECTRON_RUN_AS_NODE` 跑 —— 与 GenOffice 自己的发行方式一致。
2. **打包时必须写一个 `name: "genoffice"` 的 package.json** 在 `resources/cli/` 旁：CLI 的 `repoRoot()`
   靠它解析自己的 `node_modules/jsdom`；名字不对就报 `jsdom not found`（实测）。
3. `BrowserCommandResult` 需要 `appendReleaseHint` 字段；`ToolCommandArgs` 的窄类型可直接赋给 `PANE_TOOL_EXECUTORS` 的签名。

实测：`create brief.md --out tool-made.docx`（4256 B / 10 blocks / 3 headings / 1 table）、
`read --json`、`convert --to md`（往返正确）。`bun test packages/shared/src/agent` → 1091 pass / 0 fail。

## 12. ppt 要能改：源码级 vendor + 引擎 bundle（2026-10-29 已验证）

**决定**：不 vendor 构建产物，而是把 genoffice **检出**放进 `vendor/genoffice`（pinned commit，gitignore），
源码级编译出引擎 bundle。理由：pptx 是**库**，不是自洽 webapp —— 光托管不够，要 import 进主进程。

**两个脚本**（形状照 `fetch-drawio-assets.ts`）：
- `scripts/fetch-genoffice-source.ts` —— `--from <checkout>` 复制（排除 node_modules/.git/out/dist/build）或
  `--ref <sha>` 浅克隆；写 `.genoffice-source.json` 记录 commit。默认 pin `b239d2e5`。
- `scripts/build-office-engine.ts` —— esbuild 打 `pptx-engine` + `pptx-ops` + **slides 的 `session-state.ts`**
  （`buildAllRenderSlides` 的投影）成 `resources/office-engine/pptx.cjs` + `pptx.d.ts` + stamp。

**三个必须的 esbuild 插件/设置**（每一个都是踩出来的）：
1. `raw-text`：`?raw` 的 op guide（markdown 当文本）。
2. `asset-path`：`?asset`（字体 ttf）解析成**文件路径**——`fonts.ts` 要的就是路径。
3. `electron-stub`：`session-state.ts` 会 value-level 用 `BrowserWindow.fromWebContents/getFocusedWindow`，
   在我们走的路径上从不调用，stub 返回 null 即可。
4. **`jszip` 必须 external 并随包带**（连同 lie/immediate/pako/readable-stream… 13 个包）：
   bundle 后 `nodestream is not supported`。其余（opentype.js/utif2/pngjs）打进 bundle。

**验证（纯 Node，无 Electron）**：
```
exports: buildAllRenderSlides,openPptx,runTxn,savePptxToFile
slides: 5
render tree: 5  keys: widthPx,heightPx,scale,background,nodes,partPath   ← 编辑器视图要的形状
txn applied: true → saved ok
```
体积：`pptx.cjs` 1.4MB + node_modules 3MB = 4.4MB。

**还差**（ppt 可编辑的最后一段）：`office-deck.ts`（宿主会话：open→tree / txn / save / dirty / close）、
shim 的 `window.slidesApi` + `window.desktop`(filesApi)、`OfficeFrame` 的 slides 方法表。

## 13. ppt 可编辑：宿主侧 deck（2026-10-29 落地）

**链路**：`OfficeFrame`（slides）→ `onOfficeDeck(method, [path, ...args])` → RPC `office:deck` →
`rpc/office.ts`（**先 validateFilePath**，再把 args 交给宿主）→ `office-deck.ts`（会话表 + 引擎）。

- `office-deck.ts`：按 **path** 一会话（同一文件两处打开=同一模型）；引擎 lazy require `resources/office-engine/pptx.cjs`；
  方法表 `consumePendingOpen/openPptx/openPptxPath/getRenderSlides/applyTxn/save/isDirty/close/getSlideSize`，
  其余（undo/redo/字体/导出/最近）**明确答 null**——"关掉的功能"要说出来。
- 引擎：`buildAllRenderSlides` 的投影来自 `apps/slides/src/main/session-state.ts`（electron 打桩），
  所以渲染树形状与编辑器视图一致（`widthPx/heightPx/scale/background/nodes/partPath`）。
- shim 现在同时定义 `window.desktop / slidesApi / desktopApi / pdfApi`（同一个 proxy）——三家里唯一用 `desktop` 的是 docs；
  只定义 `desktop` 就是另外三家白屏的原因。

**验证（纯 Node，走真实方法表）**：
```
open  → slides: 5, size {12191695, 6858000}, font Arial
apply → applied: true, tree: 5 ; dirty: true
save  → ok ; dirty: false ; close → null
zip: 46/48 不变，只 ppt/slides/slide1.xml 变（+13 条零长度目录条目），文字 DECK-HOST-OK 在档
```
`bun test packages/ui/src` 367 / `server-core` 410 / `shared/src/agent` 1091 → 全 0 fail；
`tsc`：server-core / ui / electron 0（shared 仅先存在那条）。

**未做**：undo/redo（上游是主进程里的快照栈）、字体、deck 导出；**xlsx 尚未开始**（要 sidecar 二进制）。

## 14. ppt 的三件补齐（2026-10-29）

**① undo / redo —— 真的接上了，不是重写**：`takeSnapshot / restoreSnapshot / pushHistory / settleStaleHistoryBatch`
本来就在 `apps/slides/src/main/session-state.ts` 里（exported），只要在 engine bundle 的导出列表里加名字。
`office-deck` 的会话因此持 `undoStack/redoStack`，调用顺序照 app：`settleStaleHistoryBatch → pushHistory → runTxn`；
undo/redo 就是"把快照推到另一栈 + restore + 重建渲染树"。

实测（纯 Node）：`apply(true) → undo(返回树) → redo(树 5) → save(ok)`，且 `ppt/slides/slide1.xml` 里
**HOST-ENGINE-OK 存在** —— 说明 undo 撤掉、redo 放回、保存写下的就是 redo 后的状态。

**② 字体**：`fonts.ts` 用 `?asset` 引 Carlito ×4 + harfbuzz.wasm。构建时**拷到 `resources/office-engine/fonts/`**，
插件把 import 编译成 `join(__dirname,'fonts',<name>)`（原来直接写 vendored 源码里的绝对路径，打包后必然不存在）。
注意 `@genoffice/ui/fonts/*` 是**工作区 specifier**，esbuild 自己的 resolve 管不到，要手动映射到 `packages/ui/src/fonts/`。

**③ 导出**：`exportPdf` 走"先 `deckSave`（把屏上的状态落盘）→ `writeOfficePdf`"，产物 `<deck>.pdf`；
`pickExportPdfPath` 直接返这个路径（宿主里没有原生保存对话框）。
**未验**：这条只在装了 bundle 的 app 里才会跑（我这次没启动 app）。

`tsc`：server-core / ui / electron 0（shared 1 = 先存在的测试）；`ui` 367、`agent` 1091 全 0 fail。

## 15. xlsx：读通了，写还没（2026-10-29）

**形状**：`.xlsx` 的文档活在 **JS 之外** —— 解析/写在 `xlsx-sidecar`（Rust，JSON over stdio）里。
所以宿主做两件事：**带二进制** + **管会话**。

- sidecar 二进制：`apps/electron/resources/office-native/xlsx-sidecar.exe`（8.8MB，取自纳米 Work 的预编译版，
  协议与源码兼容；gitignore）。
- 客户端：`apps/sheets/src/main/xlsx-sidecar-client.ts` 由 `build-office-engine.ts` 打成
  `resources/office-engine/xlsx.cjs`（只依赖 node:child_process/readline，无需 external）。
- 宿主：`office-workbook.ts` —— 按 path 一会话；`loadClient()` 首次使用时 `start()`，`before-quit` 里 `stopWorkbookHost()`；
  方法表 `reopenWorkbook / selectWorkbook / readWorkbookRange / readRowOutline / closeWorkbook`。
- 一个 RPC 门 `office:workbook`，与 deck 同一条边界（先 `validateFilePath`）。

**实测（纯 Node）**：`open → Sales 5x4`、`readRange → 10 cells`、`close`。
`saveWorkbook` **明确拒绝**并说明原因（"Saving a workbook is not hosted yet …"）—— 因为写回要
`@genoffice/xlsx-gateway` 把编辑日志变成 OOXML 片段，再交给 sidecar 的 `save_archive`；那是下一段。

`tsc`：server-core / ui / electron 0（shared 1 = 先存在）；ui 367 / server-core 410 全 0 fail。

## 16. xlsx 写回：走引擎自己的命令行（2026-10-29 实测通）

**不重新实现 gateway 的拼装**：`genoffice sheet apply` 跑的就是 app 保存时那条管线（同一 gateway + 同一 sidecar），
所以宿主的 `saveWorkbook` 把编辑日志转成它的 `--cells` 载荷，交给那一条命令 —— **一份实现，两处使用**。

- 映射：`{sheetId,row,column,value|formula}` → `{sheet, cell:"B2", value|formula}`（列号→字母是唯一的算术）；
  `sheetId → sheet 名` 用 `open` 时的 snapshot 翻。
- **拒绝只改格式的编辑**（`writeValue:false` / `style` / `styleReset`）并说明数量 —— 静默丢掉就是"保存把工作吃了"。
- 关键坑：**CLI 找不到 sidecar**（它按打包布局找）—— 必须传 `XLSX_SIDECAR_PATH` 指向 `resources/office-native/`。

**实测**：`save → ok, written: 2`；zip `4 不变 / 2 变`（`xl/workbook.xml` + `xl/worksheets/sheet1.xml`）；
`B2 = 9999` ✓、`D5` 公式 `SUM(B2:B4)` ✓。

**未做**：格式类编辑、结构类 op（增删表/图表/透视）、CSV 会话、自动重算结果的二次校验。

## 17. xlsx 的格式与结构也能存了（2026-10-29 实测）

- **格式**：`--cells` 的 `style` 就是渲染器那套 `WorkbookStyleEdit`（同一类型），直接透传；
  **没有 value/formula 的 cell 条目 = 只改样式**（`cellEditsFromInputs` 自己会置 `writeValue:false`）。
  唯一拒绝的是 `styleReset`（"先清回默认再套 delta"在 CLI 载荷里没有对应表达）。
  实测：B2 `{bold:true, fontColor:'#FF0000'}` → `xl/styles.xml` 变了，`<b/>` 与 `FF0000` 都在。
- **结构**：`sheetOps` 翻成 DSL（`sheet apply --ops`）：`rename_sheet / add_sheet / duplicate_sheet /
  delete_sheet / set_sheet_hidden / move_sheet`；`sheetOrder` → 逐个 `move_sheet`（1-based 位次）。
  **地址用 sheet 名**（渲染器的 sheetId 用 snapshot 翻）。实测：`rename-sheet → "Renamed"` 写进了 `xl/workbook.xml`。
- 顺序：**先 cells 再 structure**（结构操作会改名/新增 sheet，单元格地址要对着编辑器当时认识的名字落地）。
- 未翻译的 op（图表/透视/校验/标签色）**点名拒绝**，不静默丢。

## 18. 只读模式（2026-10-29）

**没有把编辑器的编辑面关掉**（那要改上游），而是在**宿主这一侧**保证：**写了也到不了文件**。

- `officeShimScript({ readOnly })` → 注入 `var READ_ONLY=true` + `WRITES` 白名单（saveDocx/saveDocxAs/New/To、
  applyTxn、saveWorkbook、save、addSlide、deleteElement、editText）；命中就**在帧内**返回拒绝——
  `applyTxn` 返回 `{applied:false, failures:[{error:'read-only preview…'}]}`，其余返回 `{ok:false, error}`。
- 开关走地址：`<origin>/<app>/?__craftReadOnly=1` → 宿主在服务文档时把 shim 的 `src` 改成 `?readonly=1`
  （同一个 `shimQuery` 机制顺带管 export 模式）。
- `OfficeFrame` 新增 `readOnly?: boolean`；**`MarkdownOfficeBlock` 默认只读**，overlay 保持可编辑。

**为什么只做"拒绝写入"而不是"禁止输入"**：docs 的编辑面是 `contenteditable`（可以 DOM 锁），
slides/sheets 是 canvas（锁 DOM 锁不住，它们靠指针事件改模型）。所有权级保证统一到"写不出去"，
比给三种编辑器各做一套输入锁更可靠，也不会让预览与真实文档长得不一样。

**未做**：docs 的 `readMode`（上游内部状态，无宿主通道）可以后续接，让预览连光标都不出现。

## 19. pdf 接进 office frame（2026-10-29）

**pdf 的分工与 ppt 不同**：渲染器自己读（pdf.js）、自己把编辑应用到源字节（pdf-lib），
宿主只给两样东西 —— **它打开的那条路径** 和 **写盘**。所以宿主模块很短。

- 引擎：`build-office-engine.ts` 追加 `pdf` 条目 → `resources/office-engine/pdf.cjs`（`savePdfToPath`），
  `pdf-lib` 外置并随包带（+ `@pdf-lib/standard-fonts`、`upng`、`tslib`）。
- **pdfium 相关两个邻居打桩**：`./redaction`（涂黑）与 `./text-edit`（原地文字手术）在 bundle 里被替成
  "抛一句说明" —— 没 pdfium 的宿主**不能假装擦掉了文字**。`image-edit.ts` 还 import 了 `FPDF_PAGEOBJ_TEXT`/
  `eraseTextRuns`，桩里一并给出名字（否则 esbuild 直接拒）。
- 宿主 `office-pdf.ts` 方法表：`consumePending`（返回路径）、`openSourcePath`、`readFile`（授权）、`getUsername`、
  `isUntitled`、`save`（→ `savePdfToPath`），其余（打印机/页图/字体/签名列表）返回空。
- 一条 RPC 门 `office:pdf`（与 deck/workbook 同一条 `validateFilePath` 边界）；`OfficeFrame` 的 `app === 'pdf'` 走它。

**实测（纯 Node）**：`consumePending → 路径`、`getUsername → ""`、
`save（空编辑）→ {ok:true, skips:{skippedTextEdits:[],…}}`，落盘 11381 字节的合法 PDF。

**未做**：涂黑/原地改字（要 pdfium wasm）、签名/证书（平台原生）、OCR。只读模式对 pdf 同样生效（shim 拒写）。

## 20. pdfium 带上了（2026-10-29）

`pdf` 的 bundle 现在**不桩** `./text-edit` 与 `./redaction` —— 涂黑与原地改字是真的了。

三件事必须一起做：
1. `@embedpdf/pdfium` **外置**（wasm 在运行时读，bundle 化会去包里找），连同 `dist/pdfium.wasm` 拷到
   `office-engine/node_modules/@embedpdf/pdfium/`；`copyJszipTree()` 重命名为通用走 `jszip / pdf-lib / @embedpdf/pdfium`。
2. **`import.meta.url` 必须补上**：`text-edit.ts` 用 `createRequire(import.meta.url)` 找 wasm，CJS bundle 里它是 undefined
   → 报 `The "paths[0]" property must be of type string, got undefined`。esbuild 的 `define` 只收字面量/标识符，
   所以：`define: { 'import.meta.url': '__craftBundleUrl' }` + `banner: { js: "const __craftBundleUrl = require('node:url').pathToFileURL(__filename).href;" }`。
3. 兜底路径 `process.resourcesPath/wasm/pdfium.wasm` 留给打包形态（上游自己的 electron-builder 也是这么放的）。

**实测**：`loadPdfium() → ok`；`savePdfToPath`（空编辑）仍 `{ok:true, skips:{…}}`，落盘 11381 字节。
体积：`office-engine` 现在 **39MB**（pdfium wasm + pdf-lib + jszip + 字体）。

## 21. OCR：不需要，而且本来就没进来（2026-10-29）

- `save-pdf.ts` **完全不引用 OCR**；`pdf.cjs` 里 `grep -ci ocr` = **0**（上游 `pdf-main` 的 `ocrPage` 处理器
  才 `await import('./ocr')`，那个处理器不在我们的 bundle 里）。
- 宿主方法表里 `ocrPage` 现在显式返回 `[]`（原先落到 default 的 `undefined`）：上游注释说明"`[]` = 这一页没认出字，
  `null` = 没有引擎会让调用方停止整轮扫描"，所以 `[]` 是诚实的答案。
- 影响范围：**只有扫描件**（无文本层的图片页）。读文本层 PDF（含 CLI 的 `pdf read`，走 pdfium）、批注、改字、保存都不经过它。
- 将来若要"扫描件可读"，两条更轻的路：① 把页渲染成 PNG 交给多模态模型（我们已有 `office:exportPages`）；
  ② 再装平台 OCR（`win-ocr.exe` / `vision-ocr`），且那是桌面专属，hub 上没有。

## 22. 格式转换：两个方向，一个已接按钮一个只有能力（2026-10-29）

| 方向 | 状态 | 入口 |
|---|---|---|
| 任何 → PDF（docx/xlsx/pptx/md/html） | ✅ | `office:exportPdf`（app 自己的打印管线：顶层编辑器 + 按 sheet 纸型） |
| PDF → docx / md（xlsx/pptx 同一命令） | ✅ 已验 | `docx_tool convert`（走 CLI） |
| pdf 编辑器界面里的「PDF 转换」按钮 | ❌ | 要 vendor `pdf2docx` + `convertOffice` handler |

**顺手修的一个真坑**：CLI 做 PDF 转换要求 `GENOFFICE_PDFIUM_WASM`，否则 `pdfium.wasm not found`
（尽管文件就在我们包里）。`docx-commands.ts` 的 `cliEnv()` 现在自动指向
`resources/office-engine/node_modules/@embedpdf/pdfium/dist/pdfium.wasm`，并给 `XLSX_SIDECAR_PATH` 兜底 ——
**工具不需要用户设任何环境变量**。

实测：`sow.pdf → docx` 8734B；`hotel.pdf`（20 页中文）`→ docx` 82741B；
`sow.pdf → md` 只有 1 字节 —— 那份 PDF 本身几乎无文本层（正是 OCR 的场景，我们已关）。

## 23. 转换矩阵 + pdf 的「PDF 转换」按钮（2026-10-29 实测）

**pdf 编辑器里的转换按钮接上了**：`convertOffice` → `genoffice convert`（与 `sheet apply` 同一个思路：
复用引擎的命令行，不把 pdf2docx 再打一份进宿主）。目标名派生自 pdf 名，**已存在就写 `-converted`**，绝不覆盖。

实测（用 20 页中文 PDF）：

| 方向 | 结果 |
|---|---|
| pdf → docx | ✅ `hotel-converted.docx` |
| pdf → xlsx | ✅ `hotel.xlsx` |
| pdf → pptx | ✅ `hotel.pptx` |
| pdf → md | ✅ `hotel-converted.md`（944B，有文本） |
| pdf → **html** | ❌ 这一条上游要起自己的渲染进程 —— 宿主把它翻成一句人话 |

**其他方向（同一批实测）**：

| 方向 | 结果 | 原因 |
|---|---|---|
| docx → md / md → docx / xlsx → csv | ✅ | 纯 TS 引擎 |
| **→ pdf**（docx/xlsx/pptx/md/html） | ✅ **但走我们自己的 `office:exportPdf`**（app 打印），不是 CLI | CLI 那条要 app 进程 |
| docx → html / html → docx / pptx → pdf | ❌ CLI 报 `starting GenOffice … exit 1` | 都是 `--headless-export`，即需要 app 渲染进程 |

**顺带看清一件事**：CLI 找不到 GenOffice 时会把**宿主自己的 Electron** 当成 app 去 spawn（日志里能看到
`…/craft-agents-oss/node_modules/electron/dist/electron.exe exit_code:1`）—— 所以"要用 app 的转换"在 Craft 里
应当走**我们自己的导出管线**，而不是给 CLI 一个 `GENOFFICE_APP_BIN` 假目标。

## 24. 对：Electron 就是那个 Chromium（2026-10-29 实测通过）

先前说"docx→html / html→docx / pptx→pdf 需要 app 进程"不够准确 —— 需要的是**一个浏览器**，而我们就在 Electron 里。
`packages/html2docx` 早就为此留了口子：`BrowserDriver` 有 **两个**实现（`drivers/electron.ts` / `drivers/playwright.ts`）。

**实测**：把 `convertHtmlToDocx` + `ElectronBrowserDriver` 打成 `office-engine/html2docx.cjs`（1.1MB，
`electron` 唯一 external、`docx` 打进包），在 **Craft 自己的 Electron** 里跑：

```
bundle exports: ElectronBrowserDriver, convertHtmlToDocx
driver created → converting → docx bytes: 9306
```

`note.html → note-h2d.docx`，没有 GenOffice app、没有 Playwright。

**两个必踩的点**：
1. `Viewport` 需要 `deviceScaleFactor`（只给 width/height → `Invalid parameters`，来自 `Emulation.setDeviceMetricsOverride`）。
2. `docx` 不能 external（试过：bundle 里留 `require('docx')`，在没有 node_modules 的宿主里直接抛）。

**所以分工修正为**：
| 需要什么 | 谁做 |
|---|---|
| 渲染面（html→docx、任何→pdf、pptx→pdf） | **我们自己的 Electron**（`ElectronBrowserDriver` / `printToPDF`） |
| 编辑器自己的序列化器（docx→html 走 Word 编辑器的 standalone 导出） | 要那个模块，不是 Chromium 的事 |

## 25. `--headless-export`：让 CLI 的转换全部落地（2026-10-29 实测）

GenOffice 的 CLI 把"需要渲染面"的转换交给"app"：
`<app> --headless-export <in> --to <fmt> --out <path> --json`，读 stdout 的 envelope + 检查文件存在
（`packages/cli/src/formats/app-export.ts`）。**Craft 就是那个 app**，所以 `headless-export.ts` 回答这个契约：

- `html/md → docx`：`html2docx.cjs` + `ElectronBrowserDriver`（自己的 Chromium）；
- `* → pdf`：`writeOfficePdf`（与编辑器导出同一条打印管线）；
- `docx → html`：**明确拒绝**（那是 Word 编辑器自己的序列化器，不是渲染活）。
- 分支放在 **single-instance lock 之前**，且用 **top-level await** 停住模块（main 是 ESM 构建）——
  否则转换会被转发给已开着的窗口，或者抢走 app 的锁。

**实测**：`electron.exe <hexp> --headless-export note.html --to docx --out note-cli.docx --json` →
`{"command":"export","status":"ok","summary":"html → docx"}` + 9306B 的 docx。

**接线**：`docx-commands.ts` 的 `cliEnv()` 在**打包构建**里把 `GENOFFICE_APP_BIN=process.execPath`
（dev 下 `process.execPath` 是裸 Electron、没有 app 路径，所以 dev 不设 —— 判断用 `process.defaultApp`）。

`bun test packages/shared/src/agent` 1097 pass / 0 fail；`tsc`：shared（先存在 1）、electron 0。

## 26. docx → html / md：走编辑器自己的 headless 模式（2026-10-29 接线完成）

**上游本来就支持**，机制在 docs renderer 里（`App.tsx:2843`）：
`consumeHeadlessExport()` → `runHeadlessDocumentExport(outPath, ready, exportHtml|exportMarkdown|exportPdf)`
→ `exportHtml(name, html, outPath)` → `headlessExportDone(report)`。

接了四处：
1. **shim**：`headless` 选项（format/outPath/writeUrl/doneUrl）；`consumeHeadlessExport` 返回目标；
   `exportHtml` / `exportMarkdown` 在 headless 下 `POST` 到 writeUrl（**没有 parent 可问**）；
   `headlessExportDone` POST 到 doneUrl。
2. **office-host**：`registerHeadlessTarget(path)` → token + Promise；`POST /__craft/office-write/<token>`（写盘）、
   `POST /__craft/office-done/<token>`（settle）。两条 POST **必须在 GET/HEAD 守卫之前**（TS 会把 `method` 收窄成
   `'GET'|'HEAD'`，`=== 'POST'` 直接报 "no overlap"）。文档 URL 加 `__craftHeadless=<fmt>&__craftOut=<token>`，
   宿主把 shim 的 src 改成 `?headless=…&format=…`。
3. **office-export**：`exportThroughEditor()` —— 隐藏窗口 → 等 done（带超时）→ 检查文件存在。
4. **headless-export**：`docx|doc → html|md` 路由到 `exportThroughEditor`。

**未端到端验证（诚实）**：我的裸 Electron harness 里没有注册 `craft-local://` 的特权 scheme 与
`registerLocalOriginHandler`，所以隐藏窗口加载 `craft-local://office-…` 直接 `ERR_FAILED (-2)`。
在真实 app 里这套是启动时注册的，所以这属于 harness 限制，不是代码路径问题 —— 要在运行中的应用里验
（编辑器里点「导出 HTML」，或打包构建里跑 `docx_tool convert`）。

`tsc`：server-core / ui / electron 0（shared 1 = 先存在）；office-host 9 用例、ui 367 全过。

## 27. 纳米 Work 那边也没开 OCR（2026-10-29 核对）

他们的 `modules/pdf/MIGRATION.md` 自己写着：

> - preload 禁用项目/drop-open/AI/**联网 OCR**/跨应用转换；preview mode 禁止写入。
> - "**Offline OCR is explicitly unsupported by this embedded preload**, so its background document pass is not started."

而且 `office-preview/native/` 里**只有 `xlsx-sidecar.exe`**，没有任何 OCR helper（`win-ocr.exe` / `vision-ocr`）。

他们的动机是**启动耗时**（同一份 326 页样例：首帧 1070ms vs 之前的 1844ms）——AI/OCR 的后台 pass 是实打实的税。

**两边的差别只在"在哪一层断"**：他们在 preload 层声明不支持（renderer 连尝试都不尝试）；我们在宿主方法表。
**顺手修正我们自己的一个答案**：`ocrPage` 从 `[]` 改成 **`null`** —— 上游契约里
`[]` = "这页没认出字，下一页继续"（会先把每页渲染成图再问！），`null` = "没有引擎，整轮停下"
（`ocr-layer.tsx` 的 `finish('noEngine')`）。我们没有引擎，所以 `null` 才是对的，也避免了"扫描件把每页都渲染一遍"。

## 28. `--check` 与开发说明（2026-10-29）

`bun scripts/build-office-assets.ts --check` 现在是一条**就绪检查**：编辑器 ×4 / CLI（含 jsdom 与
`package.json` 的 name 必须是 `genoffice`）/ xlsx sidecar / 四个引擎 bundle / pdfium.wasm / jszip ——
每行 ✗ 都带**它会导致什么**与**该跑哪条命令**，缺任一则退出码 1。

实现里的两个真实坑：
- `sizeOf()` 原来只接受目录，喂文件直接 `ENOTDIR` —— 补了文件分支。
- 名字检查用的 `readFileSync` **从来没 import**（被 `catch` 吞成 `(unreadable)`）——
  这就是"检查器自己也会静默失败"的典型，值得记。

实测：全装时 13 行全 ✓、exit 0；把 `pdf.cjs` 挪走 → `✗ office-engine/pdf.cjs missing — pdf cannot be written`
+ `bun scripts/build-office-engine.ts`，exit 1。

文档新增 **§3a Developing**：哪些改动走 HMR、哪些必须重启 main（shim 与 `document.ts` 编进 main）、
以及 dev 下**测不了的**两件事 —— `GENOFFICE_APP_BIN` 在 dev 不设（`process.defaultApp` 守卫，裸 Electron 没有 app 路径），
`craft-local://` 只在 app 里注册（裸 harness 会 `ERR_FAILED (-2)`）。外加一句：**陈旧 engine bundle 是最常见的自伤**。

## 29. 挂进索引（2026-10-29）

- **`README.md`** 的 Development 里新增 `### Office documents`（三步构建 + `--check` + 指向文档）。
- **`CONTRIBUTING.md`** 的 Key Areas 加一行，注明"构建产物不进 git，新 clone 需要先跑两条命令"。
- **`docx_tool` 现在有读取门**：`prerequisite-manager.ts` 里仿 drawio 的规则 —— 未读
  `~/.craft-agent/docs/docx-tools.md` 就调用 `docx_tool`（含 `mcp__session__` 前缀）会被挡住并给出文件路径。
  理由写得和 drawio 一样：OOXML 的失败是静默的（手写半对的文件"在 Word 能开、别处不能开"；
  `apply` 猜 block 索引会改错段落且不报错）。
- **`resources/docs/*.md` 是自动发现的**（`packages/shared/src/docs/index.ts` 的 "Auto-discover"，无硬编码清单），
  所以新增 `docx-tools.md` **不需要注册**就会同步到 `~/.craft-agent/docs/`。

`bun test packages/shared/src/agent/core` 89 pass；`tsc` shared 除先存在那条外 0。

## 30. `docx_tool` → `office_tool`（2026-10-29）

理由：工具表里应该是**能力域**，不是文件扩展名。`drawio_tool` 叫 drawio 是因为 drawio 就是那个域；
Word/Excel/PowerPoint 不是三个域，是一个（Office）。旧名有三个实际后果：agent 找 `xlsx_tool` 找不到
→ 很可能**手写字节**（正是读取门要防的）；门提示语说 "documents guide" 却匹配 `docx_tool`；
文档叫 `docx-tools.md`，想查 pptx 的人不会去翻它。

改名清单（31 处 / 9 文件，全机械）：
`packages/shared/src/agent/{docx-tools,docx-commands}.ts` → `{office-tools,office-commands}.ts`；
`resources/docs/docx-tools.md` → `office-tools.md`；`docx_tool`→`office_tool`；
`DocxToolSchema/DocxToolOptions/createDocxTools/executeDocxToolCommand/DOCX_TOOLS_DOC_PATH`
→ `Office*`。**只换复合标识符，单独的 `docx` 不动**（那是扩展名）。

结果：tsc shared 1（先存在的 browser-tab 那条）、session-tools-core/server-core/ui/electron 全 0；
`bun test packages/shared/src/agent` 1105 pass / 0 fail（第一次跑出现 1 fail，连跑两次 0 —— 抖动，
非本次改动）、server-core 410、ui 367 —— 全 0 fail。

## 31. 保存护栏（L1）已落地（2026-10-29）

**动机是数据正确性，不是体验**：文档打开时是**快照**，agent 通过 `office_tool`→CLI 改同一个文件时
编辑器不知道，人一按保存就把 agent 的改动**静默覆盖**。

两个文件，一个规则一半状态：
- `packages/shared/src/office/disk.ts`（纯逻辑，无 fs/无 Electron）：`saveVerdict(recorded, current, readHash)`
  —— 无记录/文件已删/时间戳相同 → 放行；时间戳不一致才读 hash；hash 也一致（touch）→ 放行。
  实测这四条分支 + `digestOf`（SHA-256，Web Crypto，renderer 也能跑）+ `isGuardedDocument` 12 个用例全过。
- `apps/electron/src/main/office-guard.ts`：`Map<path, DiskRecord>`，**读时记录**（`file:readBinary` 拿到字节就记，
  不额外读盘）、写时校验、写后重记、`acknowledgeDocument` 给"重载"用、`clearRecords()` 退出清。

四个写入口都接了：`file:writeBinary`（docx/pdf，带 `overwrite` 第四参）、`deckSave`、`saveWorkbook`（CLI 写前查）、
`office:pdf save`（查**目标**，因为另存为写的是没人开过的文件）。`officeDisk` 走 `handler-deps`，hub 没有就省略 =
与其它 office 依赖同形。

**故意不做 watcher**：轮询买到的只是"按下保存之前就有横幅"这一半，代价是每份打开文档每秒一次 `stat`；
防丢数据那一半只要每次保存一次 `stat`。横幅留给 L2，届时按 `@genoffice/electron-utils/disk-watch.ts`：
**`watchFile` 轮询而不是 `fs.watch`**（原子保存是 rename，`fs.watch` 三个平台都漏），**baseline 在 renderer
acknowledge 之前不前进**（否则期间的保存会被吸收而不是拒绝）。

漏网：同长度原地覆写且 `mtimeMs` 也相同的情况——只有每次保存都读 hash 才能抓到，那正是快路径要避免的成本，写在文档里。

测试：shared/office 12、office-guard 10（真实临时文件，含"别人的写拒绝且文件未动"、"overwrite 才写"）、
server-core 410、electron main 568、ui 367 —— 全 0 fail；tsc shared 1（先存在）、server-core/electron 0。

## 32. 冲突提示：不是新做一套，是接上已有的那套（2026-10-29）

按"参考 html 和 drawio"去看，答案是**仓库里早就有一整条链**，不该再发明：

- `packages/ui/src/components/editors/useFileWriter.ts` —— 文本编辑器的三答（何时写 / 允许吗 / 被改了怎么办），
  内含"**写之前先读**"、`conflict`、`keepMine`、`reloadFromDisk`、`reloadToken`（用作 React key）、
  以及 `useProjectFilesWatch`（app 级项目树 watcher：事件只说"去看看"，真正的判断是**重读自己的文件**）。
- `editors/FileSaveStatus.tsx` —— 决策就是**表面中央的一条 toast**：`preview.fileChangedOnDisk` +
  `preview.reloadFromDisk` + `preview.keepMyChanges`；保存状态则是**窗口标题栏里的一个词**
  （`FileSaveStateWord`，经 `FileSaveSlotProvider`）。注释里还写了两条"别再犯"：**别做文档上方的横条**
  （每次开始保存都把正文往下推），**别做角落里的字**（在源码/页面/drawio 工具栏上都挡东西）。
- 三个 key 在 **7 个语言包里都已有**，零新增 i18n。

于是 office 只是补一个**字节版**：`packages/ui/src/components/office/useOfficeDocument.ts`
（`OfficeDocument`：`bytes/saveState/conflict/keepMine/reloadFromDisk/reloadToken/save/read`），
`OfficePreviewOverlay` 里渲染同一个 `FileSaveStatus`，`OfficeFrame` 用 `reloadToken` 作 key ——
**"重载"= 用磁盘字节把编辑器重新建一次**（编辑器没法被要求丢弃自己的模型）。

两处与文本版**故意不同**：
1. **保存是事件不是流**：文本按每键去抖写，office 是 Ctrl+S 把字节交出来，所以没有去抖、也没有"没让写就不写"。
2. **"人改过没有"不可知** → 磁盘一变就**总是问**（文本版还有"没有风险就静默跟随"那一支，这里没有安全的版本）。

还有一个真实坑：`save()` 拒绝时**必须抛**，不能静默 resolve —— 否则编辑器认为保存成功、清掉脏标记，
人可以关窗以为已经落盘。抛出去后 `OfficeFrame` 回 `{ok:false,error}`，编辑器自己保持脏。

`onWriteFileBinary(path, bytes, overwrite?)` 一路打通：PlatformContext → App.tsx → `window.electronAPI.writeFileBinary`
→ channel-map → RPC → `office-guard`。

tsc：ui/electron/server-core 0，shared 1（先存在）；ui 367、electron main 568、server-core 410、shared/office 12 —— 全 0 fail。

## 33. 构建通过：`webui:build` → `electron:build`（2026-10-29）

顺序有讲究：`electron:build:assets` 里的 `copy-assets.ts` 会 **`apps/webui/dist → dist/resources/webui/`**，
所以 webui 必须先建，否则打进包里的还是上一版 WebUI。

```bash
bun run webui:build      # 33.7s → apps/webui/dist（20M）
bun run electron:build   # main + preload + renderer(35.7s) + resources + assets
```

dist/resources 里：office 80M / office-engine 40M / office-native 8.4M / cli 41M / webui 20M，
`apps/electron/resources/docs/office-tools.md` 也在。产物里确认到新代码：`fileChangedOnDisk` 在 renderer 与 webui 两个 bundle 里，
`changed on disk since it was opened` 在 `dist/main.cjs` 出现 2 次。

### 真实故障：顶层 await 打断主进程构建

`electron:build:main` 一开始直接失败：`Top-level await is currently not supported with the "cjs" output format`
（`index.ts` 的 `--headless-export` 分支）。这条错在 wrapper 里被吞成 exit 1，得直接跑 esbuild 才看得到。

改成不阻塞的形式后**还要补一个坑**：不阻塞就意味着下面的 `requestSingleInstanceLock()` 会执行 ——
而转换通常正是"应用已经开着"的时候，headless 进程抢锁失败 → `app.quit()` → 导出还没产出就死了。
所以加 `const headlessExport = process.argv.includes('--headless-export')`，
锁写成 `headlessExport ? false : app.requestSingleInstanceLock()`、`if (!gotTheLock) { if (!headlessExport) app.quit() }`。

教训：`--headless-export` 这类"同一个可执行文件兼两个角色"的入口，**CJS + 顶层 await + 单实例锁** 三者会互相咬，
必须显式用 flag 把两条路径分开。tsc 抓不到（TS 允许），只有打包才炸。

## 34. `packages/office-host`：宿主搬到共享包，hub 侧接上（2026-10-29）

**为什么能搬**：`office-deck/workbook/pdf/guard` 四个文件**没有一个 electron import** —— 只有
`node:fs / node:path / node:child_process` + `getBundledAssetsDir`。唯一的 Electron 味是 `process.execPath`
当"JS 运行时"去 spawn CLI。

搬完的形态：
- `packages/office-host/src/{runtime,deck,workbook,pdf,guard,index}.ts`（1032 行原样 + 两类注入）
- **`setOfficeRuntime()`** —— 谁跑 `resources/cli/genoffice.cjs`：桌面 = `electronRuntime()`（自己 + `ELECTRON_RUN_AS_NODE=1`），
  hub = `hostRuntime()`（`CRAFT_OFFICE_RUNTIME` > bun 的 `process.execPath` > `bun`）。写成"值"而不是 spawn 里的分支。
- **`setOfficePrint()`** —— 打印 PDF 是唯一不可移植的能力（要 Chromium + 编辑器当顶层文档）。桌面注入 `writeOfficePdf`；
  hub 不注入 → 幻灯片"导出 PDF"回一句 `This host has no renderer to print with`，而不是以后莫名失败。
- `apps/electron/src/main/office-host.ts` → **`office-origin.ts`**（避免与包同名；它只管 `craft-local://` 托管与导出令牌）。

**hub 侧**（`packages/server/src/index.ts` 的 `createHandlerDeps`）：补 `officeDeck/officeWorkbook/officePdf/officeDisk`；
SIGINT/SIGTERM 时 `stopWorkbookHost()` + `clearRecords()`（sidecar 是子进程，不能活过 hub）。
**故意不提供** `officeExportPdf/Pages` —— 打印/导出留桌面。

> **2026-11-02 更正**：这句只对“当时没接”成立，不对“hub 没有这个能力”。`render-host` 落地后 hub 早就有打印
> （`GENOFFICE_APP_BIN` = `resources/render-host/craft-headless-export`，Playwright 的 `chromium-headless-shell`，
> `configureOfficePrint` 也装了），缺的只是把那个 launcher 接到 UI 调的这两个 RPC：现在
> `packages/server/src/office-export.ts` 用 `createCliPrint` + pdfium 答 `officeExportPdf/Pages`，
> 没装渲染器时两个依赖仍然缺席、由 handler 说清楚缺什么。见 `office-embed.md` §3b。

**实测（纯 bun，`electron present: undefined`）**：
```
bun probe.ts hotel.xlsx deck-host.pptx brief.docx
→ deck: slides 5 · deckTxn: applied · workbook: sheets ["Page 1"] · pdf.getUsername: ""
```
即 **pptx 引擎、xlsx sidecar、pdf 引擎在 hub 场景全部可用**，不需要 Electron。

其它：`tsconfig.json` 的 `lib` 要加 `DOM`（`crypto.subtle`）；`@craft-agent/shared/utils/paths` 不存在，要用 `@craft-agent/shared/utils`；
`process.resourcesPath` 是 Electron 加的字段，包内要显式声明为可选。
`typecheck:all` 已加入 `packages/office-host`。测试：office-host 10、ui 367、server-core 410 —— 全 0 fail；
`electron:build:main` 45.9MB 通过（证明 esbuild 能跟上 workspace 包）。

## 35. pdf 编辑器接上了，而且它之前不是"一处分支"（2026-10-29）

发现（用户提的）属实：`officeAppFor()` 里没有 pdf，`OFFICE_EXTENSIONS` 也没有，`.pdf` → `type:'pdf'` →
`PDFPreviewOverlay`（只读）。9MB 的 `resources/office/pdf` 与 `office:pdf` 通道都在，编辑器却无入口。

**但"一处分支"会做出一个白屏** —— 接线时发现 `pdf.ts` 的 `readFile` 返回的是 `true`（注释写着"渲染器用自己的协议取字节"），
而上游 pdf app 是 `const data = await window.pdfApi.readFile(path); new Uint8Array(data)` →
`true` 变成**一个字节的文档**，编辑器打开到空白且**不报错**。已改成真读文件字节，并加测试钉住形状
（`%PDF-` 开头、`instanceof Uint8Array`、缺失文件必须抛）。

**默认不给编辑器**：点一个 pdf 十次有九次是"读"，而编辑器是 9MB 应用 + 秒级启动；标注是更少的、刻意的动作。
所以 `PDFPreviewOverlay` 顶部加了一个"标注"按钮（`onAnnotate`，未给则该按钮不出现），点开才叠 `OfficePreviewOverlay(app:'pdf')`。
两个宿主入口都接：文件链接（`App.tsx` 的 `FilePreviewRenderer`，状态用 `annotatingPdf === state.filePath` 判，
不写 effect 也不会串到别的文件）与会话里的 `pdf-preview` 块（`MarkdownPdfBlock`）。

**能力边界（别夸大）**：pdf app 一共碰 61 个 `pdfApi.*`，我们只答了 consumePending / openSourcePath / readFile /
getUsername / isUntitled / ocrPage / save / convertOffice，其余 `undefined` = 功能关闭 ——
**表单、批注、保存是通的；拆分/合并/裁切/提取/换页/签名/文字编辑校验都关着**。文档的矩阵已按实测改写。

i18n：`preview.annotatePdf` 加进 7 个语言包（parity OK，6×2115 keys）。
构建：webui 32.9s + electron 全量通过；两个 bundle 里都能找到 `annotatePdf`。
测试：office-host 15（含 pdf door 4 条）、ui 367、server-core 410 —— 全 0 fail。

## 36. 导出 / 打印 / 拆分提取：一套"产出文件投递"（2026-10-29）

关键抽象只有一句：**门产生字节，宿主说它们落在哪**（`setOfficeDeliver`）。

| 宿主 | 投递 | 调用方拿到 |
|---|---|---|
| 桌面 | 写在**源文件旁边**，重名加 ` (1)`，第一个 `shell.showItemInFolder` | `savedPaths` |
| hub | 写进 export scratch（`createExportDir` + `storeExport`，与 design 导出同一套）→ `/api/exports/<id>` | `downloads` → frame 触发浏览器下载 |

- 没有投递器 → **按名字拒绝**（`cannot put a new file anywhere`），不静默写到一个没人看的目录。
- 多文件（导出页图）在 hub 上先打 zip（`fflate`）：浏览器会拦截连续下载，而且"9 页"本来就该是一个包。

**pdf 页操作**用引擎自己的实现，不是重写：`scripts/build-office-engine.ts` 的 pdf 入口新增导出
`splitPagesBytes / extractPagesBytes / cropPagesBytes`（都在上游 `save-pdf.ts`），重建后实测
`extract → 869B`、`split(2x1) → 208521B`、`crop → 207364B`。门方法：`splitPages` / `extractPages` / `cropPages` / `exportImages`
（页图由渲染器栅格化后传 base64，这一侧只负责落盘 —— 与上游一致）。

**打印不再经过宿主**：`OfficeFrame` 直接答 `print` → `frame.contentWindow.print()`，因为文档就是那个 frame、
编辑器自带 `@media print`；hub 没有 Chromium、桌面也不需要先造临时 PDF。`printers` 答 `[]`。

投递动作复用既有那条链：`PlatformContext.onSaveProducedFile`（桌面是保存对话框，
web 里就是 fetch `/api/exports/<id>` → `Content-Disposition` 下载）。

测试：office-host 19（新增"投递后命名正确"、"无投递器按名拒绝"、"printer 列表为空"），
fixture 改由**引擎自己的 pdf-lib 生成两页真 PDF**（假 header 读得出来但拆不了）。
tsc：ui/electron/server/office-host 全 0（shared 1 条先存在）。构建：webui 32.4s + electron 全量，产物里能找到
`cannot put a new file anywhere` 与 `onSaveProducedFile`。
