# 纳米 Work × GenOffice 集成分析

> 实测对象：`C:\Users\Ryan\namiwork`（Namiwork 3.32.0，Electron 打包，2026-10-26 构建）
> 与 `C:\Users\Ryan\code\genoffice`（genspark-ai/genoffice，Apache-2.0，HEAD = 2026-10-28）
> 分析日期：2026-10-29

## 0. 结论先行

1. **GenOffice 已经在纳米 Work 里了** —— `resources/office-preview/` 就是它的模块快照（来源标注为 `360office/apps/*`，2026-10-03 源码），只是被裁成"预览/编辑引擎"：AI 关、项目关、HTML 编辑器关。
2. **"按 drawio 的方式集成"要分两种定义**：
   - 若指 *内嵌一个自洽的 Web 应用 + 少量 postMessage 桥* —— **GenOffice 做不到**。它的渲染层不自治：docs/sheets/slides/pdf/markdown/html 的 preload 分别有 135/106/232/88/90/80 处 `ipcRenderer` 调用，打开、保存、导出、OCR、字体全在 main 进程模块里。drawio 能这么干是因为它的"保存"退化成回传一段 XML。
   - 若指 *以文件为中心 + headless 工具/导出器* —— **完全可以，而且 GenOffice 就是照这个设计做的**：`genoffice` CLI 单文件 + JSON 契约 + `render` 出 PNG 让 agent 自检，等价于 drawio 的 export CLI。
3. **推荐 A + B 组合**：保留现有内嵌编辑器（体验路径），把 GenOffice CLI/MCP 引入为 agent 的"生产 + 自检"工具链（能力路径）；C（外挂整应用）只做 `open` 深链兜底。

## 1. 纳米 Work 的技术方案（实测）

### 1.1 安装包构成

| 目录 | 体积 | 内容 |
| --- | --- | --- |
| `Namiwork.exe` | 232 MB | Electron 主程序（Chromium 打包） |
| `resources/app.asar` | 4.1 MB | 自有主进程：`main.js` 156 KB + `src/` **346 个模块** |
| `resources/bundled-nmcore` | 394 MB | Agent 内核（win32-x64）+ `builtin_agents/skills/claude_plugins` 三个 zip |
| `resources/office-preview` | 107 MB | **GenOffice 模块快照**：modules 87 MB + runtime 13 MB + native 8.4 MB（xlsx-sidecar.exe） |
| `resources/claw_nbot` | 19 MB | 另一套 agent/nbot 运行时 |
| `resources/image-viewer-installer`、`file-drop-native`、`windows-share`、`computer-use-notices` | ~3 MB | 原生小组件 |

主进程模块划分（`app.asar/src/`，节选）：`office-preview`（文档视图宿主）、`editor-service`（给 AI 用的本机 MCP）、`document-open`（打开/关联）、`local-preview`（本地文件 http 预览）、`embedded-browser`（内嵌浏览器 + CDP）、`floating-ball`/`desktop-voice`/`desktop-pets`（桌面入口）、`computer-use-*`（CUA 驱动，依赖 `@trycua/cua-driver`）、`app-update`/`core/binary-update-manager`（自更新）、`file-drop`/`file-attach`/`share-open`/`system-share`（拖拽/微信/系统分享）、`window/*`（窗口几何、崩溃恢复、白屏探针）。

特点：**一切围绕"桌面壳 + 本机能力"**，Web 端只是被 `seed-gateway-url` 指过去的一个远端页面（`channel-policies.json`、`offline-cache`、`local-core-websocket` 说明还有一条本机 core 的 WS 通路）。

### 1.2 文档能力：两条完全不同的路

**路 A（改用户正开着的文件）** — `src/editor-service/`

- `127.0.0.1:17790–17799/mcp`，JSON-RPC 2.0，无 token，靠"只听本机 + 拒绝带 Origin 的请求 + Host 白名单"防网页。
- 工具：`get_pool_status` `save_file` `text_read` `text_find` `text_replace` `sheet_read` `sheet_write` `slides_read` `slides_set_text` `list_edits` `undo_edit` `editor_capabilities` `editor_execute`。
- 实现方式：`record.webContents.executeJavaScript((fn)(input))` —— 把函数序列化进编辑器主世界执行，只碰页面里已有的编辑器对象（docx/md 用 `window.__aidocs.editor` 或 `.ProseMirror` 上的 tiptap；xlsx 走 `window.namiOfficeAgentSheets.nativeCommand`；pptx 走宿主侧 `namiSlidesAgent(webContents)`）。
- 写入一律带 SHA-256 指纹（`originalHash` / `documentHash`），内容变了就 `STALE_SELECTION` 拒绝，不猜位置；一次请求多处修改合成一个事务（一步撤销）。
- 配套 skill `namiwork-doc-editor`（官方段 + `scripts/nami_editor.py`，只用标准库，退出码 3 = 服务没找到）。

**路 B（从零产文件）** — 内置 `docx`/`xlsx`/`pptx`/`pdf` skill，走 python-docx / openpyxl / python-pptx。这条路**不经过任何编辑器**，也就是 GenOffice CLI 最直接的替代对象。

### 1.3 文档视图宿主（GenOffice 模块怎么被驱动）

```
namiwork main.js
  └─ src/office-preview/manager.js (1661 行宿主)
       ├─ resolveRuntimeLayout()  → resources/office-preview/{runtime,modules,native}
       ├─ runtimePaths()          → 每格式 {preload, renderer, [main], sidecar}
       ├─ require(runtime/index.js)（5.7 MB，含 docs+sheets+slides 三个 main 模块 + 宿主层）
       │    ├─ createOfficePreviewHost(win, paths, hooks)   ← namiwork 自有 API，上游没有
       │    ├─ createPdfHost       ← modules/pdf/main/index.js（1.2 MB）
       │    ├─ createMarkdownHost  ← modules/markdown/main/index.js
       │    ├─ registerPreviewShellIpc(getTheme)
       │    └─ namiSlidesAgent(webContents)
       └─ 每个打开的文件 → 一个 WebContentsView(renderer + preload, contextIsolation, sandbox)
```

**关键证据**：`modules/pdf/main/index.js` 里写死了

```js
const PRODUCT_FEATURES = Object.freeze({
  ai: false, cloudProjects: false, analytics: false, autoUpdate: false,
  editors: { docs: true, sheets: true, slides: true, pdf: true, markdown: true, html: false }
});
```

即：**引擎全在，AI/项目/分析/自动更新/HTML 全部裁掉**，`html` 编辑器根本没打进包。`modules/pdf/MIGRATION.md` 也记了同样的取向："preload 禁用项目/drop-open/AI/联网 OCR/跨应用转换；preview mode 禁止写入"。

对比上游同类模块：`__aidocs`（`window.__aidocs.editor/getNativeState/getNativeActions`）是上游 `apps/docs/src/renderer/App.tsx` 里就有的调试/原生接口 —— 也就是说 namiwork 的 `editor-service` **依赖的是上游未文档化的全局**，升级必须回归。而 `__genofficeControl`（CLI 控制通道）在快照里**不存在**，说明快照早于该特性或已被裁掉。

## 2. GenOffice 上游能提供什么

| 层 | 内容 | 对纳米 Work 的意义 |
| --- | --- | --- |
| engine packages | `docx-engine` `pptx-engine` `pptx-ops` `pptx-render` `xlsx-gateway` `pdf2docx` `html2docx` `odf2ooxml` `zip-gate` `font-metrics` `file-parse`、`agent-core`/`ai-provider`/`ai-search`、`project-store` | 纯 TS，可单独 npm 依赖，做服务端/CLI 能力时不必碰 UI |
| app modules | 每个 app 有 `configureXRuntime({preloadPath, rendererFile, sidecarPath, openGeneratedPath, createDocument})` + `createXView(path)`，`src/main/index.ts` 只是 `startXStandalone()` 的独立入口 | **namiwork 现在走的就是这一层**，`createOfficePreviewHost` 是它自己加的适配壳 |
| 整应用 | `apps/shell`：`tab-manager`(1110 行) `control-server` `control-handlers` `headless-export` `open-documents` 注册表 `updater` `file-index`(SQLite FTS) `mcp/*`，加上 `packages/cli` | 要么整套要（体积/生命周期冲突），要么拆件取（推荐） |

上游对外三条协议面：

- **CLI**（`genoffice`，打包成单文件 `dist/genoffice.cjs` + 外部依赖只有 jsdom，用 `ELECTRON_RUN_AS_NODE` 跑）：`info/convert/create/render/open`、`docs read|apply|check|compare|merge`、`sheet read|apply|check`、`slides read|check|audit|render|apply|replace`、`pdf read`、`guide`、`search/image/media`（云）、`skill install`。统一 `--json`，退出码 0/1/2/3/**4=应用不可用**，被拒的 op 回到"guided error + 用法行"，写入原子。
- **MCP stdio**：`genoffice mcp`，一个命令一个工具，自带工作流说明 + `genoffice://guide/*` 资源。
- **MCP HTTP**：`genoffice mcp --http --host/--token`（跨机、文件走 `PUT /files`），以及**应用内** `127.0.0.1:3093/mcp`（`create_session/insert_content/replace_blocks/apply_ops/read_document/save_session`，驱动一个可见的 Word tab）。

`render` / `--to pdf` / `create_pdf` 需要"应用进程"：CLI 读 userData 里的 `control.json`（pid/endpoint/token）连 socket，或用 `GENOFFICE_APP_BIN` 指定二进制、以 `--headless-export` 跑隐藏窗口导出。

## 3. "按 drawio 的方式集成"到底成不成立

| drawio 的特征 | GenOffice 对应 | 结论 |
| --- | --- | --- |
| 文件是开放格式（XML/mxfile），agent 直接写文本 | OOXML/PDF 是二进制 zip，agent 写不了原始 XML | **必须走工具**（CLI/MCP/引擎包），不能像 `.drawio` 那样直接产出 |
| 一个自洽的 Web 应用，宿主只做壳 + 导出 | renderer 不自治，preload 6 个应用共 731 处 IPC | **单靠 renderer 嵌不进来**，得连 main 模块一起（namiwork 已这么做） |
| 隐藏窗口 + 一个 `export/render` 工具命令，输出 SVG/PNG | `genoffice render <file> --out shots/` + `--json` | **完全对等**，而且多了 audit/check 让 agent 自检 |
| 体积小、随宿主更新 | 5 个模块 87 MB + runtime 13 MB + sidecar 8.4 MB | 可接受；整 shell 另算 |

**一句话**：drawio 式"内嵌自治 webapp"不成立；drawio 式"文件 + headless 导出器"成立，而且 GenOffice 的作者就是按这个思路写的 CLI。

## 4. 三条路线

### A. 内嵌模块（延续现状，把快照升级到上游）

- 拿到：288 个上游提交（`git log --since=2026-10-03 | wc -l`）—— PDF 页级对比、烘焙 OCR 文本、波浪线/多边形批注、文档命名、大量修复；以及**可选的 html 编辑器**。
- 改动面：`checkout genoffice@X → patch → npm run build:all → 拷贝 modules/* + runtime + native`。
- 必做的 patch 重放（这是主要成本，因为都不在上游）：
  1. `PRODUCT_FEATURES`（ai/cloudProjects/analytics/autoUpdate/html=false）
  2. 各 app `preload` 的项目/drop-open/AI/OCR/跨应用转换禁用
  3. `createOfficePreviewHost` / `createPdfHost` / `createMarkdownHost` / `registerPreviewShellIpc` / `namiSlidesAgent` 这层宿主适配（现在被 esbuild 打进了 `runtime/index.js`，与上游代码混在一个 bundle 里，升级时无法 `git merge`，只能重放）
  4. `namiOfficeSelection` / `namiSelectionElectron` 等选区桥全局
- 回归项：`editor-service` 依赖的 `window.__aidocs.*`、`window.namiOfficeAgentSheets.nativeCommand`、`.ProseMirror` 编辑器实例、`--nami-pdf-mode` 启动参数、`PREVIEW_READY_SELECTORS`（`.doc-page/.pv-page`、`.stage-wrap canvas`、`.doc-editor`、`html[data-pdf-ready]`）。
- 建议：把宿主层从 bundle 里拆成独立源码目录（`vendor/office-preview-host/`），bundler 只负责把上游模块 compile 进来 —— 否则每次升级都要从产物里反推 diff。
- 风险：上游 API 漂移（`configureXRuntime` 参数、`createXView` 签名、IPC 频道名）；Windows/mac/Linux 三份 xlsx sidecar（Rust 构建）。

### B. 把 CLI + MCP 当"文件级工具"（真正的 drawio 式）

- 拿到：agent 直接产出**真** docx/xlsx/pptx/pdf，`render` 出 PNG 自检，`check/audit` 结构化找错；原子写 + guided error；替换掉现在 python-docx/openpyxl 那条产出路径。
- 打包做法（官方就是这么跑的）：
  - vendor `packages/cli/dist/genoffice.cjs` + `dist/node_modules`（只有 jsdom 树）；
  - 运行时 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`（用纳米 Work 自己的 Electron，不额外装 node）；
  - `XLSX_SIDECAR_PATH` 直接指向**现成的** `resources/office-preview/native/xlsx-sidecar.exe`（同一份 sidecar）；
  - `GENOFFICE_ALLOWED_ROOTS` 限制到用户文档目录。
- 需要补的那一块：`render` / `--to pdf` / `create_pdf` 要一个"应用进程"。两条实现：
  1. vendor `apps/shell/src/main/headless-export.ts` + `control-server.ts` + `@genoffice/electron-utils` 的 `HEADLESS_TARGETS`，在纳米 Work 的 `main.js` 入口加一个 `--headless-export` 分支，再把 `GENOFFICE_APP_BIN` 指向 `Namiwork.exe` —— 因为它已经内嵌全部模块，理论上 1:1 复用；
  2. 更省事的过渡：先不接 `render`，用现有内嵌编辑器截图/导出（pdf 模块自带导出、sheets 有 pdf-export）顶一阵。
- agent 侧：直接上 GenOffice 自带的 `skills/genoffice`（`npx skills add genspark-ai/genoffice` 的同一份），或走 `genoffice mcp --compact-schemas` 把工具塞进现有 MCP 装配。
- 体积代价：单文件 cjs + jsdom 树，量级个位数 MB，比再来一套编辑器便宜一个数量级。

### C. 整应用外挂（用户装 GenOffice）

- 做法：`genoffice mcp`（stdio）挂到纳米 Work 的 agent；或 `genoffice open` 深链；文件按路径交换。
- 收益：一周内可用，零 fork 维护，AI/搜索/项目/HTML 全拿。
- 代价：依赖用户安装、双进程双更新链、"改文档"发生在另一个窗口（体验割裂）；退出码 4 就是"没装/没起来"。
- 定位：**兜底**，不做主路径。

| | A 内嵌快照 | B CLI/MCP | C 外挂 |
| --- | --- | --- | --- |
| 用户能看到改动 | ✅ 实时在自家编辑器里 | ❌ 文件级，需自己预览 | ❌ 另一个窗口 |
| 产真 Office 文件 | 部分（要自己拼引擎调用） | ✅ 首选 | ✅ |
| 自检（render/audit） | ❌ | ✅ | ✅ |
| agent 可改"正开着的文档" | ✅（editor-service 已做） | ❌ | 仅 3093 那套可见 tab |
| 维护成本 | 高（patch 重放） | 低（vendor 单文件 + 环境变量） | 极低 |
| 体积 | 107 MB（已有） | 个位数 MB | 0 |
| 依赖用户额外安装 | 否 | 否（自带 CLI） | 是 |

## 5. 建议的落地顺序

1. **先做 B 的最小闭环**（不改任何现有编辑器）：vendor CLI → `ELECTRON_RUN_AS_NODE` 跑起来 → `info/convert/create/docs apply` 跑通 → 把 `docx/xlsx/pptx` 三个 python skill 的产出路径换成 `genoffice create/convert` → agent 用 `render` 自检。这一步就能让"AI 做的文档打开不再错版"。
2. **补 `--headless-export` 分支**：拿到 PDF 导出/转换，`GENOFFICE_APP_BIN=Namiwork.exe`。此时 B 已覆盖 GenOffice 90% 的对外能力。
3. **A 的升级单独排期**：建一条可重复 build（patch 目录 + `build:all` + 产物对比脚本），先把宿主层从 `runtime/index.js` 里拆出来；再按上游 288 commits 的 changelog 决定是否跟进 html 编辑器与 PDF 对比。
4. **C 只做 `open` 深链**：用户装了 GenOffice 就"用 GenOffice 打开"，不装不做提示。

## 6. 坑清单（按踩到的概率排序）

- **宿主层与上游混编**：`runtime/index.js` = 上游 main 模块 + 自家 `createOfficePreviewHost`，升级只能重放，无法 cherry-pick。先拆层。
- **未文档化全局**：`editor-service` 抓的是 `window.__aidocs.editor`、`window.namiOfficeAgentSheets`、`.ProseMirror` 实例 —— 上游任何一次重命名都会静默变成 `EDITOR_NOT_READY`。加一条冒烟：打开固定 fixture，断言 `get_pool_status` 的 `ready=true`。
- **sidecar 版本绑定**：CLI 的 `sheet apply` 与内嵌 sheets 模块共用 `xlsx-gateway` + sidecar；CLI 版本与模块版本必须同批构建，否则公式缓存行为漂移。
- **`ELECTRON_RUN_AS_NODE` 的 `require('electron')`**：CLI 打包时把 electron 外部化了，宿主必须给对 execPath，否则一启动就 `Cannot find module 'electron'`。
- **headless render 依赖显示**：Linux 下需要 `xvfb`；Windows/macOS 隐藏窗口可用，但别在无 GPU 的 RDP 会话里压缩渲染质量断言（`--scale` 会漂）。
- **安全**：`editor-service` 无 token，靠 Origin/Host 白名单（网页带 `Origin` 直接 403）；CLI HTTP MCP 有 `--token`，stdio 不出本机。若把 `--http` 开出去，务必带 token + `GENOFFICE_ALLOWED_ROOTS`。
- **许可/商标**：Apache-2.0，可商用可 fork，保留 `NOTICE`；"GenOffice" 名称与图标不随代码授权，产品里继续叫"文档"即可。

## 7. 证据索引

- 快照来源与裁剪说明：`C:\Users\Ryan\namiwork\resources\office-preview\modules\pdf\MIGRATION.md`
- 功能开关：`resources\office-preview\modules\pdf\main\index.js` → `PRODUCT_FEATURES`
- 宿主布局与路径契约：`app.asar/src/office-preview/manager.js` → `resolveRuntimeLayout` / `runtimePaths` / `createOfficePreviewHost` 调用点
- 宿主 API：`resources\office-preview\runtime\index.js` → `createOfficePreviewHost` / `registerPreviewShellIpc` / `namiSlidesAgent`
- 本机 MCP：`app.asar/src/editor-service/{server,tools,document-tools,native-tools,page-editors,native-editors}.js`
- agent 侧规约：`resources\bundled-nmcore\builtin_skills.zip` → `skills/namiwork-doc-editor/{SKILL.md,text.md,sheet.md,slides.md,native.md,scripts/nami_editor.py}`
- 上游嵌入契约：`genoffice/apps/shell/src/main/index.ts`（`configureXRuntime` 六个调用）、`tab-manager.ts`（`createXView`）、`control-server.ts`、`headless-export.ts`
- 上游 CLI：`genoffice/packages/cli/README.md`、`src/resources.ts`（`appLaunch` / `GENOFFICE_APP_BIN` / `XLSX_SIDECAR_PATH`）、`build.mjs` + `collect-deps.mjs`（单文件打包 + 仅 jsdom 外置）
