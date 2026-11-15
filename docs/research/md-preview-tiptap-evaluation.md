# 把 md 文件的预览换成 TipTap：可行性与代价

> **这是什么。** 对「阅读面（`Markdown` / react-markdown）是不是可以换成只读的 TipTap 文档」这件事的评估：
> 结论、实测证据、三种做法和推荐路线的验收标准。写于 2026-11-02，基于本机源码 HEAD `800b46b2d`。
>
> **方法。** 读代码 + 用真引擎跑探针：`linkedom` 顶一个 DOM，注册与 `TiptapMarkdownEditor` 同一套扩展
> （StarterKit + CalloutBlockquote + TaskList/TaskItem + AlignedTable 系列 + `@tiptap/markdown`），
> 对真实文件逐块跑 `blockToNode`（app 自己的 parse/serialize + `says()` 关卡），并计时。
> **探针是一次性的，已删除**；可复现的配方见 §2 末尾。
>
> **相关：** [`markdown-file-model.md`](../requirements/markdown-file-model.md)（文件模型与逐块保存的规则）、
> [`tiptap-upgrade-plan.md`](../design/tiptap-upgrade-plan.md)（3.20 → 3.32 的升级）。

## 0. 结论

| 问题 | 答案 |
| --- | --- |
| 技术上能不能换 | ✅ **能**。共用围栏表、`editable: false` 分支、排版对齐测试都已经在了，tiptap 也早已在渲染层包里 |
| 直接换（A） | ❌ **会有可见回归**：行内/块级 HTML、尖括号自动链接、脚注、裸 URL 链接全部失效 |
| 推荐的形状（B） | ✅ **已实施（2026-11-02）**：只读呈现模式 + 字面块回退。文件阅读面、作品海报、`markdown_tool shot` 三处同一个渲染器 |
| 只是为了「两面看着一样」 | ❌ 不值得。排版已由 `tiptap-typography.test.ts` 按住，补几条断言便宜两个数量级（C） |
| 性能 | 既不是理由也不是阻碍：10–60 KB 文档两面同阶（~15–50 ms），354 KB 极端文件 tiptap 慢一倍（577 vs 295 ms） |

## 1. 现状：一个文件，三个面，但不是三套渲染器

| 面 | 实现 | 位置 |
| --- | --- | --- |
| 读 `view` | `Markdown`：react-markdown + remark-gfm + **rehype-raw** + katex，围栏块走 `fence-components` | `MarkdownEditorPane.tsx:243`，`Markdown.tsx:560` |
| 改 `edit` | `TiptapMarkdownEditor`（官方 `@tiptap/markdown`），文档由 `blocksToDocument` **逐块**建 | `MarkdownEditorPane.tsx:188` |
| 源 `source` | `SourceText` + 就地画围栏块 | 同上 |

四条「其实已经具备」的事实，决定了这件事不是从零写起：

1. **围栏表是一份**：`fences.ts` / `fence-components.tsx`，阅读面的 `fenceBlock` 与编辑器的 `PreviewBlock` 都从它画；
   `PreviewBlock.tsx` 的头注释明说「不是副本」。mermaid、datatable、diff、json、latex、drawio/html/pdf/office/image-preview
   在编辑面里已经是同一批组件。
2. **编辑器已经有只读分支**：`editable: false` 时不挂 slash 菜单（`TiptapMarkdownEditor.tsx:348`）、
   不挂气泡菜单（`:665`），链接点击走「打开」而不是「放光标」（`:427`）。
3. **不多一个字节的包体**：`MarkdownDocBlock` → `MarkdownEditorPane` → `TiptapMarkdownEditor` 是静态 import，
   tiptap 已经在 `apps/electron/dist/renderer/assets/index-*.js`（5.5 MB）里。
4. **排版已经对齐过**：`__tests__/tiptap-typography.test.ts` 把 `tiptap-editor.css` 的数值按住阅读面的数值。

难的那部分（同一个围栏块、同一套排版）做完了。**没做完的是「引擎扛不住的块」在阅读面上长什么样**。

## 2. 直接切换会坏的地方（实测）

| 输入 | 阅读面今天 | 只读 TipTap 文档 |
| --- | --- | --- |
| `> [!NOTE]`（GitHub 大写写法） | 正常 callout | ✅ callout（**2026-11-02 已修**，见下） |
| `> [!note]` / `> [!note]-` | callout | ✅ callout（含折叠标记） |
| `按 <kbd>Ctrl</kbd> 保存` | 正常渲染 | ❌ 整块原文 |
| `<div style="color:red">…</div>`、`<details>` | 渲染（rehype-raw） | ❌ 整块原文 |
| `依据：……<https://docs.volcengine.com/…>` | 链接 | ❌ **整段退化为原文**（`docs/design/video-understanding-design.md` 里真实出现） |
| 脚注 `[^1]` | 脚注 | ❌ 字面 `[^1]` |
| 裸 URL / 裸文件路径 | `preprocessLinks` 自动变链接（`Markdown.tsx:536`，493 行模块） | ❌ 纯文本 |
| `####`–`######` | h4–h6 | ✅ 同样是 h4–h6（`level` 属性正确，CSS 两边都只样式化 h1–h3） |
| `markdown-preview` 围栏 | 文件面本来就禁用（`NO_NESTED_DOCUMENTS`） | ✅ 一样不画（编辑器不认这个围栏）——**无回归** |

**结构上的根因**是 `block-parse.ts` 的取舍（`:50` / `:59` / `:87`）：一个块「引擎读成一个节点、且**词**没丢」才交给引擎，
否则**保留原文当一个段落**。对编辑器来说这是对的（否则保存会删内容），对阅读面就是源码露出来。

**大写 callout：已修（2026-11-02）。** 原来 `parseCalloutMarker` 把类型小写成 `note`、`CalloutBlockquote` 写回时也写
`> [!note]`，而 `says()` 区分大小写 ⇒ `NOTE` vs `note` ⇒ 判为「丢词」⇒ 整块落到字面路径（编辑面里 `> [!NOTE]` 直接
显示成源码）。现在 `CalloutMarker` 多一个 `spelling`（文件里的原始写法），节点把它存成 `calloutMarker` 并**按原样写回**；
`callout` 仍是小写、仍是标签与样式读的那个键。没有动 `says()` —— 改成大小写不敏感会连 `Abc` / `abc` 这类真改动一起放过。
测试：`callout-and-image.test.ts` 四条（大写、混合大小写 + 折叠、标签仍从小写键取、整篇逐块保存保留原写法），
`callouts.test.ts` 一条（`spelling`）。

### 怎么复现这些数字

`node_modules` 不用动，照 `tiptap-upgrade-plan.md §2` 的配方即可；关键是探针必须
**用 app 自己的 `blockToNode` / `bridgeOf`**，而不是 `@tiptap/markdown` 的整篇 parse —— 后者会把「逐块把关」这一层整个跳过，
量出来的不是 app 的行为。

## 3. 性能实测（逐块 parse + 建文档 vs remark→hast）

| 文件 | 块数 | 只读 TipTap | 阅读面（remark） |
| --- | --- | --- | --- |
| `docs/requirements/markdown-file-model.md`（11 KB） | 40 | 19 ms | ~50 ms |
| `docs/design/tiptap-upgrade-plan.md`（14 KB） | 37 | 17 ms | ~28 ms |
| `MEMORY.md`（354 KB，极端） | 655 | **577 ms** | 295 ms |

10–60 KB 这个量级两边同阶；大文件 TipTap 慢一倍左右，且多保一个 ProseMirror 文档（内存更高）。
**所以性能不能用来支持这次切换，也拦不住它。**

## 4. 三种做法

| | 内容 | 代价 | 结果 |
| --- | --- | --- | --- |
| **A 直接换** | `view` 面改成 `<TiptapMarkdownEditor editable={false}>` | ~1 天 | §2 的回归全部发生；换来「排版天然一致」和「切换面不丢光标」 |
| **B 只读呈现 + 原文块回退**（推荐） | A 之上加三件事：①`literal` 块用一个 node view 交回 `Markdown` 渲染；②`PreviewBlock` 的 `interactive: false`（`PreviewBlock.tsx:87`）变成可配置，只读面允许交互；③只读时先跑 `preprocessLinks` | ~3 天 | §2 的回归面归零，两个面真的是同一个文档 |
| **C 不换** | 继续两套 + 排版测试 | 0 | 排版靠测试守；切换面仍丢光标/滚动；空白行、字面块等已知差异留着 |

**B 的关键一招是回退**：实测真实文档里字面块只有 0–1 个/篇（`tiptap-upgrade-plan.md` 0、`markdown-file-model.md` 0、
`video-understanding-design.md` 1）。把这一小撮交回今天这套阅读器，成本极小，却正好补掉「HTML 被当源码显示」这一类——
而且不用写第二份实现。

## 5. 走 B 的拆解与验收

| # | 改动 | 验收 |
| --- | --- | --- |
| 1 | 修大写 callout（原始标记存 attr、按原样写回） | ✅ **已完成**：`> [!NOTE]` 的 `blockToNode` 不再 `literal`，round-trip 逐字节相同 |
| 1b | 重新构建渲染层后看一次真 app（`build:win`） | 打开一份含 `> [!NOTE]` 的文档，编辑面显示成 callout 而不是源码 |
| 2 | `TiptapMarkdownEditor` 加 `presentation`（只读呈现）：不挂 Placeholder / FileHandler / SlashMenu / BubbleMenus / AgentPresence | ✅ 只读面 `contenteditable` 为 false、无气泡菜单 |
| 3 | `PreviewBlock` 的 `interactive` 跟随只读面（`editor.isEditable`）；被抑制的围栏**画成代码块**（外部读者视角），不是留白 | ✅ 海报里 `html-preview` 仍显示为代码块；阅读面点得开 mermaid |
| 4 | `blocksToDocument(..., { literalAs: 'literalBlock' })` + `LiteralBlock` 节点，node view 调宿主给的 `Markdown`（`fence-view-context.renderLiteral`） | ✅ `literal-blocks.test.ts` 四条：同一份文件两种建法，只有字面块不同 |
| 5 | 阅读面与海报的正文先跑 `preprocessLinks` | ✅ 海报探针里裸 `https://…` 是可点链接 |
| 6 | 阅读面的滚动容器仍是 `overflow-auto`，编辑器在其中自然增高 | ✅ playground 全屏阅读面可滚、无双滚动条 |
| 7 | 语料对拍 + 截图 | ⏳ 真 app 里过一遍（`build:win` 后重启） |

**已实施的位置**：`MarkdownEditorPane` 的 `view` 分支、`apps/electron/src/renderer/markdown-poster.tsx`（海报与
`markdown_tool shot` 共用这一处）。`Markdown` 仍留给消息、计划审阅、`markdown-preview` 块与海报里的字面块回退。

**不要一起动的地方：**

- **消息 / 计划审阅面**（`AnnotatableMarkdownDocument` → `DocumentFormattedMarkdownOverlay`）：批注的 `start/end` 是
  DOM 文本偏移，换渲染器会让已有批注错位。它和流式输出也共用 `Markdown`，必须留着。
- **海报的权限模型**：隐藏窗口 + 受限平台（只给 `readDataUrl`）与 `NOT_DRAWN` 的规则都没变 —— 换的只是渲染器，
  不是它能读什么。
- **围栏表**：加围栏仍然只改 `fences.ts` 一处。

## 6. 未验证 / 风险

| 项 | 状态 |
| --- | --- |
| 只读 TipTap 的真实观感（滚动、选中、复制、长文档性能） | ❌ 只有 headless 数据；要真 app 里跑一次 |
| 字面块回退里再出现围栏（HTML 块里含 ``` 之类） | 未测；回退是 `Markdown`，理论上会画围栏块 |
| `office-preview` / `pdf-preview` 围栏在只读文档里的交互与尺寸 | 未测（编辑面强制 `interactive: false`，从没验证过「可交互」那条分支） |
| 打印 / 导出 | 与渲染面无关（`convert_tool` 走服务端），预计不受影响 |
| 编辑器自身的既有 bug | `says()` 对行内 HTML 的已知拒绝（`tiptap-upgrade-plan.md §1`）；大写 callout 已修（§2） |

## 7. 建议

1. ~~先修大写 callout~~ —— **已修（2026-11-02）**，见 §2；要看到效果需重新构建渲染层。
2. 动机若是「读/改两面不对齐、切换丢光标」→ 走 **B**，先做第 2–4 步的 spike（1 天），拿
   `docs/design/video-understanding-design.md`（带 HTML 与自动链接）和一份长文档验收，再决定铺开。
3. 动机若只是「看着不一样」→ 走 **C**：给 `tiptap-typography.test.ts` 补 h4–h6 / `hr` / 任务列表 / callout 几条断言。
