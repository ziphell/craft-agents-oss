# GenOffice 的 HTML 与 Markdown：能不能替换 Craft

> 上游 `C:\Users\Ryan\code\genoffice`（HEAD 2026-10-28）对照本机 `C:\Users\Ryan\code\craft-agents-oss`（Craft Agents 源码）
> 以及纳米 Work 已内嵌的 `resources/office-preview/modules/markdown`。分析日期 2026-10-29。

## 0. 结论

| 问题 | 答案 |
| --- | --- |
| 用 GenOffice 的 **html app 替换 Craft 的 `html-preview` 渲染** | ❌ **不能**。安全模型相反（Craft 预览**禁脚本**、无地址；GenOffice 预览**必须开脚本**并且要一个 `html-preview://` 地址），层级也不对（渲染组件 vs 4000 行主进程子应用）。 |
| 用 GenOffice 的 **html app 替换 Craft 的 `HtmlDesignEditor`** | ❌ **不划算**。两边是同一套架构（不透明 origin + postMessage + 源码 patch），Craft 已到同等完成度（852+657 行 vs 上游 1498 行）；换进来会让你绕过 `useFileWriter` 的写入链。 |
| Craft 缺的到底是什么 | ✅ **只有"源码视图"**。现在 `.html` 只能元素级改（文字/内联样式/删/排序），改不了 CSS 规则、结构、`<script>`。补一个源码 tab 即可，不必换引擎。 |
| 用 GenOffice 的 **md app 替换 Craft 的 markdown 编辑** | ❌ **不该**。Craft 的约束更严（"编辑就是改文本，不经过文档模型"）；GenOffice 是 Tiptap + **块级**无损拼接，默认保存仍整篇 re-serialize，整篇无损 round-trip 还是 experimental（`localStorage.mdapp.experimentalRoundTrip`，默认关）。 |
| 对纳米 Work 的意义 | GenOffice **html 是它唯一的空白**（`PRODUCT_FEATURES.editors.html=false`，`OFFICE_EXTENSIONS` 里也没有 `.html`）。要"AI 生成网页 → 用户当场改 → 导出 Word/单文件"，这是现成件。 |

## 1. GenOffice html app 解剖

```
apps/html/
├─ src/main/           3916 行
│   ├─ html-main.ts            2049  窗口/保存/脏标记/Save As/导出/打印/展示视图
│   ├─ asset-lifecycle.ts      1390  assets/ 目录、引用重写、孤儿清理
│   ├─ preview-document.ts      140  <base> 注入 + html-preview:// 文档
│   └─ single-file-html.ts      101  导出时把本地图片 inline 成 data URL
└─ src/renderer/preview/  1498 行
    ├─ inspector.js            1179  frame 内探针（选择/文字编辑/拖排序/样式预览）
    └─ inspector-protocol.ts    165  与宿主的分消息协议（gx:*）
```

- **两个自定义 scheme**（必须在 app ready 前注册）：`html-preview://view-<wc>/`（standard+secure+fetch+cors）与 `html-asset://local/<dir>/`（再加 `stream`）。相对资源靠 `<base href="html-asset://local/…">` 解析，**源文件不含这个 base**，只有预览副本有。
- **预览沙箱**：`sandbox="allow-scripts allow-forms allow-popups allow-modals"` —— 刻意**不**给 `allow-same-origin`（不透明 origin），"CDN 依赖的页面必须能渲染，但够不到应用本身"；重载走 `src` 属性，回话走 postMessage。
- **编辑器**：CodeMirror 6 源码为真相 + 右侧实时预览 + 双向定位（源码选区 ↔ 元素）。`inspect` / `browse` 两种模式（后者"当发布页看"）。
- **导出**：docx（走 `html2docx`）、pdf（打印管线）、单文件 HTML（图片内联）、`createHtmlPresentView`（演示模式）。
- **自带 AI**：`renderer/ai/` 15 个文件（AiPanel、edit-queue、page-writer、brief-writer、search-skill、redact-guard…）—— 嵌进来必须像其它模块一样按 `PRODUCT_FEATURES.ai` 关掉。
- **IPC 面**：preload 80 处 `ipcRenderer`（43 处 invoke），含原生 `dialog.showOpenDialog/showSaveDialog`。

## 2. GenOffice markdown app 解剖

- main 4246 行（`markdown-main.ts` 1473 + `asset-lifecycle` + `image-host` 313 + `wiki-index` 408 + `wiki-resolve` 270 + `wiki-create/notes/fragment`），preload 90 处 IPC。
- Tiptap 块编辑器（表格、图片、Mermaid、代码块、数学、脚注），另有**源码视图**（`renderer/source`）。
- **保存保真度**：`renderer/markdown/sourceSplice.ts`（429 行）"块级无损保存"—— 打开时用 marked 把源文切成顶层块，每块记住它变成的节点；保存时**未改动的块逐字节照抄**，只有改动的那段重新序列化。动机写得很直白：`getMarkdown()` 整篇重排会让一个词的改动变成满屏 diff，还会丢 link reference definitions、footnote definitions、raw HTML block。
- 但 `roundtripSerializer.ts` 的整篇无损仍是 **experimental，默认关**；默认路径还是"改了就整篇 serialize"。
- **Obsidian 那套**：`[[wiki link]]`、`![[embed]]`、补全、Backlinks、Graph —— 建立在 `project-store` 的 vault 语义上。

## 3. Craft 现状（对照）

| 能力 | 实现 | 关键约束（源码注释原话） |
| --- | --- | --- |
| `html-preview` 块 | `MarkdownHtmlBlock.tsx` → sandboxed iframe | **2026-11-02 起**：桌面直接把这页的 `file://` 地址交给 iframe（`html-preview-url.ts`），`sandbox="allow-scripts allow-forms allow-top-navigation-by-user-activation"`（**不给** `allow-same-origin`，opaque origin）⇒ 脚本能跑、相对引用按文件自己的目录解析、够不到 app；app 的 `frame-src 'self'` 就已放行（实测）。hub/远程窗口没有这个文件 ⇒ 回落 `srcDoc` + `allow-same-origin`、不跑脚本。**不要**为它再造协议宿主（走过一版 `craft-local://`，见 MEMORY） |
| `.html` 文件点击 | `file-classification.ts` → `FilePreviewRenderer` | 走 `HTMLPreviewOverlay`（与 `html-preview` 块同一个窗口、同一套 served/回落规则）；右上角"在浏览器打开"才交给浏览器窗口 |
| HTML 视觉编辑 | `HtmlDesignEditor.tsx` 657 + `lib/html-edit/{design-document.ts 635, source-edits.ts 217}` | 跨域 frame（`sandbox="allow-scripts allow-forms allow-popups allow-modals"` —— **和 GenOffice 一字不差**）+ postMessage + **只把改动 patch 回源码**；何时写/允不允许写/文件被别人改过怎么办，全交给 `useFileWriter` |
| Markdown | `MarkdownEditorPane.tsx` 176 | 读 = 应用自己的 `Markdown`（drawio/html 预览块照常工作）；**编辑 = 源码**（`ShikiCodeEditor`），明确"Nothing goes through a document model on the way out, so a construct the app has no node for cannot be silently dropped" |

**两边的 HTML 编辑器是同一个架构，独立发明了两遍**：不透明 frame 里跑探针 → postMessage → 宿主 patch 源码。规模也接近（Craft 852+657 ≈ 1509 行；GenOffice inspector 侧 1498 行）。差别只在**深度**：

- Craft：元素级原子操作（文字、内联样式、删除、排序、字号 ±、粗斜下划线/删除线/分隔线、撤销重做、AI 发送）；**没有源码视图**，改不了 CSS 规则块、结构、脚本。
- GenOffice：整页源码就是真相，元素定位只是"跳到源码那一段"；结构/CSS/JS 全能改；另有 docx/单文件/打印/演示四种出口。

## 4. 三点判断

### 4.1 替换 `html-preview` 渲染 —— 不该，安全模型相反

Craft 的预览是**给 agent 产物看的图**：无脚本、无地址、`allow-same-origin` 只为了让 CSS/图片能取。GenOffice 的预览是**给作者看的活页面**：必须开脚本（CDN 页面要渲染）、必须有 `html-preview://` 地址（相对资源要解析）、还要在同一个 frame 里跑 1179 行探针。

把后者塞进 `html-preview` 等于：agent 生成的一段 HTML 从此能执行任意脚本、能发请求、能读同源存储。这正好是 Craft 花力气（`sandbox.ts` 那一整段注释）挡住的事。**这不是性能或体积问题，是语义问题。**

### 4.2 替换 `HtmlDesignEditor` —— 不该，边界不对

- GenOffice html 是**文件编辑器**：自己的窗口、自己的脏标记、自己的 Save As、自己的原生 dialog、自己的 assets 目录生命周期。
- Craft 的编辑器是**overlay 里的一层**：文件归 `useFileWriter` 管（何时写、写被不被允许、文件被别人改了怎么办），它只负责"把 frame 里的动作变成源码 patch"。

换掉它，就得把这条写入链重接一遍；而拿到的增量只有"源码视图 + 导出"。

### 4.3 真正该补的：源码视图（≈ 一个组件）

Craft 已经有 `ShikiCodeEditor`（markdown 源码视图在用）。给 `.html` 加一个"源码 / 设计"切换：

- `.html` 从"丢给浏览器窗口"改成 in-app overlay，两个 tab：**源码**（ShikiCodeEditor + 写回走 `useFileWriter`）、**设计**（现有 `HtmlDesignEditor`）。
- `html-preview` 块保持不变（禁脚本是它的价值）。
- 收益：结构/CSS/JS 级修改、与设计视图互切；成本：一个组件 + 一处 `file-classification` 分支，不动沙箱语义。

## 5. 对纳米 Work 的意义

- 现状：`office-preview/modules` 只有 docs/sheets/slides/pdf/markdown；`PRODUCT_FEATURES.editors.html = false`；`OFFICE_EXTENSIONS`（manager.js）里也没有 `.html`，所以**打开 .html 完全走 `local-preview` 的静态服务**，既不能编辑，也没有"AI 生成网页"的落地处。
- 要补的话，GenOffice html 是唯一现成件，成本已量化：main 3916 行 + preload 80 IPC + 2 个 scheme + assets 生命周期 + `dialog` + 关掉它自带的那套 AI；收益是源码编辑 + docx 导出（`html2docx`）+ 单文件导出 + 演示模式。构建侧只需 `npm run build -w @genoffice/html`，比 sheets 轻（无 Rust、无 sidecar）。
- 顺手值得并行做的一件事：**把 GenOffice 的 `html2docx` 引擎单独接给 agent**（`genoffice convert page.html --to docx`）。Craft 和纳米 Work 都没有"网页 → Word"这条路。

## 6. 值得抄的具体机制（都在 `apps/html/src/main/`）

| 机制 | 为什么值得抄 | 对应 Craft 现状 |
| --- | --- | --- |
| **单文件导出**：`single-file-html.ts` 导出时把 `img src` 与 CSS `url()` 里的本地图 inline 成 data URL，工作文档不重写（"megabyte base64 lines make the source and AI edits fragile"） | 分享/归档一个自包含文件，源文不动 | 没有 |
| **自定义 secure scheme 承载预览**：`html-preview://` + `html-asset://`，而不是 `srcdoc`/base 正则 | 相对资源、fetch、worker 都能自然解析；源文不被修改 | Craft 走 `injectBaseTarget` 正则 |
| **`buildPreviewDocument` 的 `<base>` 注入器**（140 行真正的标签扫描：跳过注释、`script/style/textarea/title` 的 raw text、`template` 嵌套） | 正则注入在"`<head` 出现在 script 字符串里"时会插错位置，并把内容注入到 JS 里 | `MarkdownHtmlBlock` 里是 `/(<head[^>]*>)/i` 正则 |
| **`ComputedSnapshot`**：选中元素的有效样式快照（px 数值、`#rrggbb`、透明记 `''`）→ 一次 `set_style` op 提交 | 视觉编辑写回的样式来源与浏览器一致，不用猜 | `source-edits.ts` 已有类似能力，可对照补字段 |
| **`inspect` / `browse` 双模式** | "看内容"和"当发布页看"是两种意图，同一个 frame 两种行为 | 由 overlay 的编辑/预览两个沙箱各自承担，无需抄 |

**不建议抄**：`asset-lifecycle.ts` 那 1390 行（assets/ 目录 + 孤儿清理 + 引用重写）—— Craft 的文档模型是"文件 + 旁边 assets"，这套复杂度只有托管一整个编辑器时才划算；`wiki-*` 那套 vault 语义（Craft 没有 project-store，`[[ ]]` 是另一套解析）；它的 AI 面板（Craft 的 agent 比它强）。

## 7. 如果只做一件事

> 给 `.html` 加一个 in-app overlay，里面是 **源码 tab（ShikiCodeEditor + useFileWriter）** 和 **设计 tab（现有 HtmlDesignEditor）**，`html-preview` 块一个字都不改。

这一件事同时解决"改不了结构和 CSS"和"`.html` 现在只能丢给浏览器"两个问题，完全不碰沙箱语义，也不需要引入任何 Electron 子应用。
