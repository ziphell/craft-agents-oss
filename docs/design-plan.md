# Design 设计方案 — 原型 / 活的产物 / Deck / Motion（开发文档）

> **定位**：本文写「为什么是一个入口、四种产物」「pages 已经有了哪两种」「deck 与 motion 要建成什么样」「代码放在哪」。它**不写实现细节**，也不重复 [项目分层](project-layers.md) 与 [术语与文案规范](vocabulary.md) 已经定下的底座。
>
> **一句话**：**Design 是一个入口、四种产物**——**原型**（web / desktop / mobile）、**活的产物与看板**、**deck**、**motion**（HTML → MP4）。前两种 `pages` 已经做了（沙箱 iframe、数据仓、grants、定时刷新、分享）；**缺的是 deck 与 motion**，而这两样正是这个入口现在缺的独立对象。
>
> **读法**：§1 是判断（为什么是这四种、为什么偏偏缺 deck 与 motion）；§3 / §4 是要建的 deck 与 motion；§7 是命名（`pages` 退场）。

---

## 1. 判断

### 1.1 入口的尺子（四条）

侧边栏的每一项都是**工作区一级的一族东西**（会话、来源、技能、项目、tweaks、自动化）。四条全过才配：

1. **有独立的对象**——不是某个已有对象的字段。
2. **家在盘上，拷走可读**——产物是文件，app 删掉不丢。
3. **是一族，要浏览与复访**——有列表、有详情，是长期在做的活。
4. **有只属于它的操作面**——有别的入口做不了的事。

外加一条命名判据（[术语与文案规范](vocabulary.md) §3）：**通用任务会不会用到它？** 会用到的，就不能用某个功能自己的名字。

### 1.2 pages 已经过了这把尺子——它就是前两种模式

对照 OpenDesign（源码在本地 `C:\Users\Ryan\code\open-design`，**Apache-2.0**）。它的 New Project 面板有**六个创建页**（Prototype / Live Artifact / Deck / Template / Media / Other），而 `SKILL.md` 另有一套**七个 registry mode**（`prototype` / `deck` / `template` / `design-system` / `image` / `video` / `audio`）——两套**不是一一对应**，是刻意的（`docs/modes.md`）。与我们相关的四样：

| OpenDesign 的产物 | 我们这边 | 状态 |
|---|---|---|
| **Prototype**（web / desktop / mobile）：单页 HTML，读设计系统，沙箱 iframe 里渲染 | pages 的 `static` / `interactive`（沙箱 iframe、内联一切、opaque origin） | **已有** |
| **Live Artifact**：`kind: prototype` + `intent: live-artifact`——同一套元数据下的一个 UI 工作流，高保真、带数据 / 连接器 | pages 的 `live` + 数据仓（kv / series）+ grants（api / mcp / script）+ 定时刷新 | **已有** |
| **Deck**：`kind: deck`，多页 + 演示；主产物 `index.html`，**次产物 `slides.json`**（给 PPTX 导出） | —— | **缺** |
| **Media ▸ Video**：模型 / 比例 / 时长；其中 **`hyperframes-html` 这个"模型"就是把 HyperFrames skill 钉住** | —— | **缺，但引擎已有一半（§4）** |

（OpenDesign 另有 Image / Audio 与 Template / Other——我们**不做**，理由见 §6。）

**逐条对 §1.1 的尺子，pages 全过**：

- **独立对象**：一页 = 一个自包含 HTML 小应用（`page.json` + `index.html` + `data/`），不是任何东西的字段。
- **家在盘上**：`{workspace}/pages/{slug}/`，拷走仍可读。
- **是一族**：`PagesHome` 的列表，可以回来复访。
- **自己的操作面**：看、Share、Approved actions（grants）、定时刷新。

> **更正**：早先说「pages 只到一份 HTML、撑不起入口」是不成立的——它不止一份 HTML，它有数据仓、动作授权、定时刷新与分享。**问题从来不在这个入口要不要，而在入口里还差什么产物。**

> **现状（已核对 git，修正过一次）**：pages **不是 v0.14.0 的新东西**——它在 **v0.13.5 / v0.13.6 就已经有了**（63 个文件；`packages/shared/src/pages/` 24 个），是**本分支自己删的**：`53ad9d5ac "merge 13.3"` 删了 13 个，其余在 v0.13.5 / v0.13.6 合并时按「取 ours」丢弃。用的是**同一套底座**——`@craft-agent/core` 还在，只顺手删了 `packages/core/src/types/page.ts`。所以「带回来」= **回滚这次删除**，而不是合上游：`git checkout v0.13.6 -- <pages 路径>` 取回约 45 个纯新增文件，再手工接回约 10 个被 dev 改过的接缝（`tool-defs.ts` / `channels.ts` / `credentials/types.ts` / `SessionManager.ts` / `handlers/rpc/index.ts` / `core/types/index.ts` / 路由与 i18n / `AppShell` 一项）。
>
> OpenDesign 的源码在本地 `C:\Users\Ryan\code\open-design`（**Apache-2.0**，但**是部分检出**——`design-systems/` 与 `design-templates/` 只有说明文件，151 个设计系统与 deck 模板的本体不在里面；`apps/web/src`、`packages/` 也多为空壳）。
>
> 所以「实现 Design」是三步：**① 回滚（pages 回来、跑绿）→ ② 改名（pages 退场，§7）→ ③ 加 deck 与 motion**。一步一提交，别把回滚和改名混在一个 diff 里。
>
> **进度**：**① ✅** 回滚 48 个文件 + 接回约 10 处被 dev 拆掉的接缝（`typecheck:all` 绿，pages 测试 494 pass）。**② ✅** 改名「全改」（用户定）：模块路径（`packages/*/src/designs/`）、TS 类型名（`PageConfig` → `DesignConfig` 等）、线格式（`pages:*` → `designs:*`）、工具名（`create_design` / `write_design_data` …）、磁盘契约（`designs/{slug}/` + `design.json` + `CRAFT_DESIGN_*` + `craft-designs/v1`）、路由与导航（`designs/design/:slug`）、i18n（7 locale × 101 键，键与 en/zh-Hans 的值都换）、文档（`designs.md`）——**只留 `capturePage` 与 tweaks/browser/drawio 自己的「page」词汇**；`typecheck:all` 绿、全量 6361 pass / 0 fail（1 个 TTL 计时 flaky 单独跑通过）。**老数据不迁移**（用户定）。
>
> **③ 进行中 —— deck 第一片已落地（§3.1 / §3.3）**：`design.json` 的 `deck` 段（`aspect` / `theme`，**有它才是 deck**，页数不入盘）+ 校验 + 工具入参（非法比例在边界拒绝）+ `tool-callbacks` 映射；桥加 `deck` 消息（有界：≤1000 页、`current` 在范围内，**无 nonce**——它只是显示状态）；查看器加「按比例信箱化 + `当前/总数` 计数 + View Fullscreen（复用 `common.viewFullscreen`，不新造未翻译的键）」；`designs.md` 加 `## Decks` 授权契约（幻灯片标记 / 导航归模板 / 自报页数 / 打印一页一屏）；4 条桥解析用例。`typecheck:all` 绿、全量 **6365 pass / 0 fail**。
>
> **③ 还差**：**PPTX 与 motion 的端到端验证**（见下——本机没装 Electron 二进制）；deck 模板目录（第三方模板要带许可，先只给了文档内起始 deck，与已有的活看板起始片段同形）。**Markdown 导出考虑过、不做**（§3.4）。
>
> **③ 已落地（除上述）**：
> - **deck 查看器**（§3.2 / §3.3）：`design.json` 的 `deck` 段（有它才是 deck，页数不入盘）+ 校验 + 工具入参边界校验 + 桥的 `deck` 消息（有界、无 nonce）+ 按比例信箱化 / `当前/总数` / View Fullscreen。
> - **指南出门禁**（§5.2-7）：`prerequisite-manager` 加 designs 规则（`create_design` / `update_design`，`strict: true`，指向 `CONFIG_DIR/docs/designs.md`）——此前 `designs.md` 只靠工具描述里一句「写之前先读」，没有机制兜底；现在与 browser / drawio 同路，「已安装 + 先读后放行」都是事实。工具描述里的写法也统一成 `docs/designs.md`（不再写死 `~/.craft-agent/…`）。**更正上一轮我的一个错误结论**：`initializeDocs()` 会自动把 `resources/docs/` 全量同步到 `CONFIG_DIR/docs/`（无硬编码清单），文件本就在位，不需要另加装机清单。
> - **导出**（§3.4 前五种）：**PDF**（隐藏窗口 `printToPDF`，deck 按 `aspect` 定纸张）、**PNG（每页一张，仅 deck）**、**HTML**（原样单文件）、**ZIP**（整个 design 目录，内置 `zlib` 手写，零新依赖）、**PPTX**（见下）。走新通道 `designs:export`；隐藏窗口沿用缩略图器/导出器那套（`data:text/html` + 60s 超时 + 串行化）。
> - **PPTX**（§3.4 的默认路）：引擎 **`dom-to-pptx` 2.1.2（MIT）**，以**官方浏览器 bundle vendor** 进 `apps/electron/resources/vendor/dom-to-pptx/`（保留 LICENSE，README 记版本/来源/sha256，并有完整性测试钉住 sha256）——**不 npm install**（它依赖 puppeteer ^25，我们只要浏览器那条路，也就不必像 OpenDesign 那样剥 puppeteer）。转换在**已有的隐藏窗口**里跑：注入 bundle → 先把所有 `.slide` 同时布局（deck 靠加 `.active` 恢复 `display:grid`）→ 再按 `deckPageSizeInches(aspect)` 出片；deck 一页一屏、普通设计一页。字节以 base64 经 `executeJavaScript` 回主进程落盘，窗口内不碰 `fs`。**输出是可编辑的原生形状/文本**（这才是选它的理由）；代价是**绝对定位还原**（改字可能溢框）、无原生对应的效果（混合模式/背光模糊/WebGL）会被近似或丢弃——文档已按此口径写明并指向 PDF/PNG 求像素精确。
> - **Motion**（§4）：`motion` 段（`fps` / `durationMs` / `aspect`）+ 校验 + 工具入参 + `assertMotionSpec`；取帧用 **CDP `Page.startScreencast`**（仓库已有实测脚本证明隐藏窗口能出帧），编码复用 `openRecordingEncoder`（给它加了可选 `fps`），落盘 mp4；Export… 菜单加 Video（仅 motion 设计可见）；`designs.md` 加 `## Motion`（含 **realtime 非逐帧**的 caveat）。**纯函数（校验 / 帧预算 / 命名 / 设置解析）有单测；抓帧+编码那一跳无法在本机验证——本仓库没装 Electron 二进制**，需在装了的机器上手动跑一次（已知风险：`sandbox:true` 窗口上 CDP attach）。
>
> **本轮顺手修掉的一处我自己的 bug**：deck 的 `useState/useRef/useCallback` 原先写在组件的早退 `return` **之后** → 违反 Hooks 规则（hook 顺序随 `design` 是否为空变化）。已挪到顶部与其他 hook 同处，`DesignView.tsx` 的 VS Code 诊断归零。
>
> **我自己改名留下的一处不对称已修**：pass 1 改了代码里的 `deletePage` → `deleteDesign`（它在 ElectronAPI 方法表里），但 locale 键只做了前缀替换 → `t('designs.deleteDesign')` 对不上键 `designs.deletePage`。`lint:i18n:coverage` 抓出来了，7 个 locale 的键已改名。**另有一个既有缺键 `browser.safetyHint`（`packages/ui`，与本次无关：`git diff HEAD -- packages/ui` 为空）。**
>
> **留一个译者活**：`de / es / hu / ja / pl` 五个 locale 里 `designs.*` 的**值**仍是旧措辞（键已改）——不猜译文，等译者过一遍。

### 1.3 缺的两种：deck 与 motion

**deck 是独立对象**，四条尺子过得比前两种还干脆：

- **独立对象**：一件 deck 是**一叠页**（不是「一个 HTML 文档」）——有版式、主题、页序，是讲一遍要按顺序走完的东西。
- **家在盘上**：deck 就是 HTML（+ 模板 / 主题），拷走仍可读。
- **是一族、可复访**：pitch、周报、评审汇报——一个人反复做、反复讲。
- **自己的操作面**：**翻页 / 按比例铺满 / 演示 / 导出**——这四件前两种产物一件都不需要，deck 每件都要。

**motion（HyperFrames 那条线）也是独立对象**，但它和前三样有一条根本区别：**HTML 不是交付物，MP4 才是**——HTML 是源（时间轴、帧、动画），片子才是给人看的那份。它自己的操作面是**渲染 / 预览 / 重渲一版**，与前三样都不同。

**一句话**：前两种是「看一屏」，deck 是「讲一叠」，motion 是「放一段」。**补上这两种之后，这个入口装的才是一族完整的产物。**

### 1.4 名字：`pages` 退场，叫 Design

入口现在装四种产物，不再只是「网页」。`pages` 这个词在本库已经换过三次所指（原型当年的 `pages/<name>.html`、曾叫 Pages 的网站功能、被压成一词的 `isPageUrl`），见 [术语与文案规范](vocabulary.md) §2——**一个换过三次所指的词，不该有第四次**。入口叫 **Design**，一处改名、四处齐：侧边栏、目录、文档、文案。

---

## 2. Design 是什么

### 2.1 一个入口，四种产物

| 产物 | 是什么 | 已有的件 |
|---|---|---|
| **原型**（web / desktop / mobile） | 单页 HTML，读设计系统，沙箱 iframe 里渲染 | pages `static` / `interactive` |
| **活的产物与看板** | 单页 HTML + 数据（kv / series），按钮触发动作（grants），可按 5 分钟起的节奏刷新 | pages `live` + 数据仓 + grants + refresh |
| **deck** | 一叠 HTML 页，版式 + 主题，能翻页 / 演示 / 导出 | **要建（§3）** |
| **motion** | HTML + CSS + 时间轴，渲染成 MP4 | **要建（§4）** |

四者**共用一个设计系统**、**共用一个家**、**共用同一条渲染与导出链**——加一种产物不需要加第二套机制。

### 2.2 设计系统 `DESIGN.md`

四种产物都读它：品牌色与语义色、字体与字阶、语气、间距、组件基调。OpenDesign 的说法是「one design system brings your brand to every creation」——这一条要有。

- **一份，工作区级**：`{workspace}/DESIGN.md`（约定名）。
- **不解析成 tokens、不是 schema**：agent 与人直接读它；有工具要用值，就读这份 markdown。写一份机器格式的 tokens 就是**第二份描述**，必然漂移。
- **不播种**：建产物不写它；没有它时产物照做，只是没有品牌可依。

**与 OpenDesign 的分工要说清**（它是四条轴：`skills/` 功能、`design-templates/` 形状、`design-systems/` 品牌、`craft/` 通则，见 `craft/README.md`）：

| OpenDesign | 我们 |
|---|---|
| 设计系统是一个**产品面**，151 个包，每个是 `manifest.json` + `DESIGN.md` + `tokens.css`（旧包只有 `DESIGN.md` 也兼容） | **一个工作区一套品牌**：`DESIGN.md`（prose，必） + 可选 `tokens.css`（编译好的语义 token，有就用） |
| `manifest.json` 管的是**发现元数据 / 出处 / 声明路径** | **不要**——我们这里没有一份上百包的目录要发现，manifest 没有对象。这是**有意的分叉** |
| `craft/`：**无品牌的专业通则**（字距、重音上限、反 AI 味…，MIT，改编自 refero_skill），由 skill 用 `od.craft.requires` 按需注入 | **先不收**。分工（品牌 vs 通则）是对的，但那是另一个能力；真需要时按 OpenDesign 的形状收，别塞进 `DESIGN.md` |
| 装配顺序：`USAGE.md` → `DESIGN.md` → import 指引 → `tokens.css` → 组件索引 → 富文件索引 → craft → skill 正文；**品牌覆盖通则** | 若将来要拼，**照抄这个顺序与优先级** |

### 2.3 入口与列表

- 侧边栏一项 **Design**（`nav:designs`，计数 = 工作区里的产物数）。
- 列表现读盘（`{workspace}/designs/{slug}/`，`pages/` 改名而来）——没有登记表、没有索引。
- 路由 `routes.view.designs(slug?)`；导航状态 `DesignsNavigationState`（与 Projects 同构）。

### 2.4 「看」的分工

- **`html-preview` 是「看一份」**：一次对话的产物，跟着消息走。
- **Design 是「看一整套，回来还看得见」**：一个产物的所有形态在同一个面上，不依赖某次对话。
- 两者都在**沙箱 iframe** 里看，但**地址不同**（§2.6）：Design 的产物从 `craft-local://` 按地址加载，能取相对引用的样式 / 脚本 / 素材；chat 的 `html-preview` 吃的是任意绝对路径，仍走 srcDoc。
- **隔离级别与地址无关**：`sandbox` 不给 `allow-same-origin`，所以无论从哪儿加载都没有 cookie / localStorage / 父 DOM；`static` 那档连脚本都不给，`interactive` / `live` 开 `allow-scripts`。数据一律走 `craft-designs/v1` 桥——页面自己拿不到存储与网络，这是有意的。

### 2.5 「交出去」

导出**不新建渲染引擎**：渲染与截图都用自家 Electron（§3.4 / §4.2），编排则是已有能力的组合——Electron 打印（→ PDF）、`capturePage`（→ 图片）、vendor 的 `dom-to-pptx`（→ 可编辑 `.pptx`）、`pptx-tool` / `markitdown` / `img-tool`、普通归档（→ ZIP）。

### 2.6 载体与地址：iframe 保留，预览默认走 `craft-local://`

**载体（iframe）不变**：面板式单页应用，「嵌一块别的文档」就是 iframe 的活。

**地址：默认给 `craft-local://`，srcDoc 退为特例。**（这一节改过一版，第一版把预览面写成"必须 srcDoc"，写反了——理由在下面。）

先说清这一节的关键，它决定了整件事：**让 origin 变成 opaque 的是 `sandbox` 属性，不是 URL。** iframe 带 `sandbox="allow-scripts"` 而不带 `allow-same-origin` 时，**文档无论从哪个地址加载**，都被当成"一个永远过不了同源策略的特殊 origin"——没有 cookie / localStorage / 父 DOM。而**相对引用的解析用的是文档的 base URL**（不是 origin），所以子资源（`./styles.css`、`./assets/hero.png`、字体）照样能加载。

于是「**加载地址**」与「**隔离级别**」是两件可以分开的事：

| | srcDoc | `craft-local://` + `sandbox`（不带 `allow-same-origin`） |
|---|---|---|
| 不可信 HTML 的隔离 | 有（opaque origin） | **一样有**——opaque origin 是 sandbox 给的，与地址无关 |
| 相对引用 / 多文件产物 | **不行**（srcDoc 唯一真正的硬伤） | **行** |
| 数据桥 `craft-designs/v1` | 通 | **通**（postMessage 本来就跨 origin） |
| 体积 / 可缓存 | 整份 HTML 塞进 `srcDoc` 字符串，大 deck / 邮件很贵 | 按地址取，可缓存 |
| 地址 | 没有——不能重载、devtools 看不出、不能开新窗口 | 有 |

**所以：预览面默认走 `craft-local://`，srcDoc 退成两种情况**——(a) 还没落盘的草稿；(b) chat 的 `html-preview`（它吃的是**任意绝对路径**，而 `craft-local` 是**按目录 + 有围栏**的，服务任意路径等于把围栏作废）。

**这一改动顺手解放了一个我们没质疑过的约定**：pages 的「单文件、内联一切」**存在的原因就是 srcDoc 没有 base URL**。有了真地址，原型可以是**正常的多文件**（`index.html` + `styles.css` + `app.js` + `assets/`）——对 agent 和人都自然得多，也正是 OpenDesign 的形状（它默认**按 URL** 预览，srcDoc 只在需要宿主桥时用）。

**机制本身已经有了：`craft-local://`**（`packages/shared/src/local-origin.ts`）。正解**不是新造 `craft-design://`（除非下面第 3 点成立）**，而是把 design 目录挂成它的一个 host：

- `localHostLabel(slug, dir)` → `craft-local://<slug>-<8 位目录哈希>/`。label 带哈希是因为**slug 只在一个工作区内唯一**——两个同名目录拿到两个 label，谁也答不了谁的请求（顺带：每个产物天然一个 origin）。
- **围栏已经写好并有测试**：`resolveServedPath()` 拒 NUL 与反斜杠（Windows 上反斜杠是分隔符，放过去就能夹带 `..`）、`resolve` 折叠后按 `${root}${sep}` 判前缀（同前缀的兄弟目录进不来）。这是这条链的安全边界。
- **MIME 表现成**：`contentTypeFor()`（含 woff2 / ttf / wasm…）；响应带 `nosniff`，类型给错字体/文档会被直接丢掉。
- 历史回退只给「不指文件、且 `Accept: text/html`」的路径（`isDocumentRequest`），免得把 404 的脚本回成 HTML。
- 文件里那句 **"What a feature *serves* is its own business."** 正是这个意思：scheme、label、围栏、MIME 归这里，**功能只管自己服务什么**。

**随之必须定的三件**（都进 §9）：

1. **CSP**：有了相对引用，`connect-src 'none'` 才有意义；而且既然不再要求内联，可以走 `script-src 'self'` + 独立文件，**比 `'unsafe-inline'` 强**。照 `drawio-host.ts` 的 `SHELL_CSP` 形状写，但按"不可信"来配。
2. **那两个特权要不要给不可信内容**：`craft-local` 注册成 `standard` + `secure` + **`supportFetchAPI` + `corsEnabled`**——这是我们自己代码（drawio）需要的面。agent 写的产物要不要同样的面？
3. **要不要为此单开一个 scheme**：**特权是按 scheme 注册的，而 `registerSchemesAsPrivileged` 全 app 只有一次**（必须在 `app.whenReady()` 之前）。如果「服务我们的 drawio」与「服务 agent 写的产物」需要**不同的特权**，就**只能**开第二个 scheme——**那时 `craft-design://` 就成立了**：不是因为它叫 design，而是因为它是"给不可信内容的那个 origin"。名字仍按**作用域 / 信任级别**取，不按功能（§2.6 的命名判据见 [术语与文案规范](vocabulary.md) §3 与上一节的理由）。

**要实测，不要推断**：opaque-origin 文档从 `craft-local://` 取相对子资源是否真的通、同 scheme 的 XHR 在 opaque origin 下会不会被 CORS 挡、`corsEnabled` 给不可信内容带来的可读面有多大。仓库的 spike 目录就是干这个的（上次那条 `http://*.localhost` 的教训就是量出来的，不是推出来的）。

**两条已被证否的路**（`local-origin.ts` 注释里，measured）：`http://<label>.localhost`——给 `http` 挂 handler 会**下到那个 session 的每一个 http 请求上，包括真页面的**，它当年就是这么把真页面弄坏的；`file://`——全盘同源、没有约束，且 `isBrowserUrl('file://…')` 已经是 `false`。**别抄 `thumbnail://`**：它只查「绝对路径 + 可预览扩展名」，**没有目录收口**。

**还剩一个决定**（§9）：**工作区浏览器窗口要不要收这个 scheme？** 它现在只认 http/https（`isBrowserUrl` 把 `craftagents://` / `file://` / `data:` 一律判否）。**v1 建议不收**——真交互在应用内的渲染面跑，"Open in browser" 保持 http/https。

### 2.7 独立窗口：把一件 design 开在自己的窗口里（待实现）

design 现在只在详情页里看（§2.4）。它应当还能**开在自己的窗口里**——一个精简的独立窗口，去掉应用的主界面，只剩这件 design 加最薄的一层操作。这是**预览面的一种形态**，不是第五种产物：产物仍是那四种，变的只是它在哪儿被呈现。机制上它也不新建容器——窗口里仍是 app renderer 跑同一条 design 路由、同一个 `DesignFrame` 宿主。

**它和"PWA"不是一回事，先把这条划清。** 真 PWA（浏览器里 Install、独立 origin + manifest + SW）在这里装不了：`craft-local` 是 Electron 自有 scheme，在 `thumbnail-protocol.ts:registerPrivilegedSchemes` 一次性注册，真浏览器认不得自定义 scheme；仓库现存的 manifest（`apps/webui/src/public/manifest.json`）是**整个应用**的远程壳，不是每一件 design 的。所以目标是"app 内的独立窗口"，不是"装到系统里的应用"。它与**发布副本**（Share 出去的远程链接，§Sharing）也不是一回事：那个在 app 之外、只读、actions 禁用；这个仍在 app 内、仍是活的。

**复用（不新造机制）**：

| 需要 | 已有 |
|---|---|
| 开一个窗口 | `windowManager.createWindow({ workspaceId, focused, initialDeepLink })`；`focused` 已经是 900×700 的小窗 |
| 隐藏主界面 | `focused` 写进 query，`AppShell` 读它隐藏侧边栏与导航栏 |
| 从链接开窗 | `deep-link.ts` 的 `?window=focused\|full` 已经走"新建窗口"那条路 |
| 落到这件 design | 路由 `designs/design/:slug`（`routes.ts`），渲染进 `MainContentPanel` → `DesignView` |
| 仍要是"活的" | 窗口里仍是 `DesignFrame` 作宿主，grants / 实时数据 / Present 照旧 |

**缺口只有三处**：

1. **深链不认识 design**：`deep-link.ts` 的 `COMPOUND_ROUTE_PREFIXES` 没有 `designs`，`craftagents://designs/design/<slug>` 现在解析不出来。
2. **没有入口**：`DesignView` 头部要加一个"在新窗口打开"的动作。
3. **窗口自己的呈现**：现成的 `focused` 只砍了侧边栏，`DesignView` 头部仍是详情页的样子——"返回 designs 列表"在独立窗里没有意义；标题会被 `refreshWindowTitles` 改成**工作区名**而不是 design 名；`window-state.json` 的 `SavedWindow.type` 只有 `'main'`，独立窗要决定存不存、怎么恢复。这三条才是"精简"真正的工作量。

**一条必须定的岔路**：

| | 保留宿主（**建议**） | 直接加载地址 |
|---|---|---|
| 做法 | 独立窗仍是 app renderer 跑 design 路由，只把 chrome 削到最薄 | 窗口直接 `loadURL('craft-local://…/index.html')` |
| grants / actions | 在 | **全废**（没有宿主可批准、可执行） |
| 实时数据 | 在（宿主推） | 只剩加载那刻的 snapshot（页面自己 fetch） |
| 壳 | 一层极薄的 renderer | 零壳，纯粹是那个 design |
| 它还是"小应用"吗 | 是 | 退化成一张会动的图 |

**建议保留宿主**：零壳那版丢掉的正是 grants 与刷新——那恰好是 design 之所以是"小应用"的部分；丢了它，独立窗与"Share 出来的只读副本"就只剩本地 / 远程之差。零壳那版更诚实的定位是"把设计导出成一张本地页面"，属于 §2.5「交出去」，不属于"开在哪里"。

**边界**：不新增 scheme、不新增服务、不新增容器；不追求 OS 级"可安装应用"，也不做绕开主窗口的桌面 / dock 入口——那是另一件事。

---

## 3. Deck（第三种产物）

### 3.1 一件 deck 是什么

**一份 HTML，按「一节一页」排**——`<section class="slide">` 一节即一页。**样式与脚本可以内联，也可以按相对路径取同目录的文件**（§2.6 之后不再强制内联）；**导出 HTML 时才内联成单文件**——那正是「HTML 导出」的定义，发布副本仍然 `connect-src 'none'`。属性放 `page.json` 已有的 manifest 里，**加一个 `deck` 段**（比例 `16:9`、主题名、页数），不新建对象：

```jsonc
// {workspace}/designs/<slug>/page.json
{ "slug": "fy26-board", "kind": "static", "deck": { "aspect": "16:9", "theme": "swiss" } }
```

**两个标杆版式**（对齐 OpenDesign 的做法）：

- **杂志版式（guizang-ppt 风格）**：编辑式版面、双页感、WebGL hero、P0/P1/P2 清单。
- **瑞士国际主义**：网格锚定、单色重音、主张多于装饰。

### 3.2 模板：一个文件夹 + `SKILL.md`

**照抄 OpenDesign 的形状，不发明新的**（`design-templates/AGENTS.md`、`docs/skills-protocol.md`）：一个模板就是一个文件夹，和功能 skill 同形——**就是 Claude Code 的 Agent Skills 格式**：

```
design-templates/<name>/
├── SKILL.md        # frontmatter(name / description / triggers) + 正文（agent 的工作流）
├── example.html    # 烘好的样张，gallery / 预览直接喂
├── assets/         # 模板本体（agent 拷走再填）
└── references/     # 规划时读的知识文件（layouts.md / components.md …）
```

- **零配置兼容**：只有 `SKILL.md` 也能用；OpenDesign 另有一组可选的 `od:` frontmatter（`mode` / `surface` / `scenario` / `preview.type` / `design_system.requires` / `craft.requires` …）做筛选与装配。**我们先用最朴素的三个字段 + 正文**，`od:` 那套等真有多模板目录再说。
- **起步 = 拷一份 `assets/` 再填**（`template.html` 杂志版式 / `template-swiss.html` 瑞士），与 guizang 的做法一致。
- 模板是**盘上的文件**，人也能改；主题是模板旁边的一份 CSS 变量块。
- **`example.html` + `assets/` 的取用有两条路**（OpenDesign 的 `/api/skills/:id/example`、`/api/skills/:id/assets/*`）：预览走它，**agent 拿的是一份拷贝**（OpenDesign 每次运行前把激活的 skill / 模板连边文件**真拷**进项目的 `.od-skills/`，提示里给相对路径 + 绝对兜底）。我们照做：**提示里给模板目录的绝对路径，让 agent `cp` 一份**，不改原模板。
- **上游来源与许可**：OpenDesign 的 deck 模板库**不在本地这份 clone 里**（§1.2 现状），要取就得另取；逐个看许可（§3.5）。

### 3.3 deck 查看器（新，但薄）

**先把分工说清：翻页归模板，宿主不替它做。** OpenDesign 把这条写成硬约定（`design-templates/AGENTS.md`，`od.mode: deck` 的模板必须满足）：模板的 `example.html` 在**没有宿主**的情况下也要能翻页，宿主只读状态。照抄：

| 动作 | 约定 |
|---|---|
| **键盘** | `ArrowRight` / `ArrowDown` / `PageDown` / `Space` → 下一页；`ArrowLeft` / `ArrowUp` / `PageUp` → 上一页；`Home` / `End` → 首 / 尾。**输入框 / select / textarea / 可编辑区里的事件不接管** |
| **滚轮 / 触控板** | `deltaX + deltaY` 累计过一个小阈值 → **只走一页**，随后迅速复位（一次手势不越页） |
| **触摸** | 横向滑动 ≈ ≥50px 且大于纵向位移 → 上 / 下一页 |
| **页码点** | 每页一个按钮；四条导航路径都要更新激活点；带 `aria-current="true"` |
| **当前页状态** | 可见页带 `.slide.active`（`.is-active` 可作别名）——**宿主读的就是它**，必须与键盘 / 滚轮 / 触摸 / 点同步 |
| **iframe 安全** | 载入 / 指针交互时给 deck 焦点（否则键盘导航不生效）；**不要用 `scrollIntoView()`**（会滚父页）；无脚本与打印要能露出**每一页**；非激活页只在 runtime 启动后再隐藏 |

宿主这一层只做三件：

- **按比例铺满**：`16:9` letterbox，等比缩放。
- **演示**：全屏、隐藏应用 chrome。
- **页数与当前页**：这里有一处**必要分叉**——OpenDesign 的预览桥能读 iframe 里的 `.slide.active`，我们的 iframe 是 **opaque-origin**（读不到 DOM，也不该读），所以由**页面通过 `craft-designs/v1` 桥自报**（`{ type: 'deck', slides, current }`）；状态源仍是 `.slide.active`，只是传输换了。

### 3.4 导出（五种；OpenDesign 的做法可直接借）

先看 OpenDesign 桌面端实际怎么做（`apps/desktop/src/main/`）：**全部在一个隐藏的 Electron `BrowserWindow` 里渲染，不引入第二个渲染引擎**。这正好是我们已有的东西。

| 格式 | OpenDesign 怎么做 | 我们怎么做 |
|---|---|---|
| **HTML** | 主产物本来就是单文件 | 一样——pages 的产物内联一切 |
| **PDF** | Electron 打印；`pdf-export.ts` 管 `DECK_PAGE_SIZE` / `DECK_PRINT_CSS` / `inferPageSize` + `waitForPrintableContent` | 照抄：**deck-aware 打印分页**（模板里写 `@page` / `break-after`），Electron 出 PDF |
| **PPTX（默认）** | **vendor 一个 MIT 库 `dom-to-pptx`**（v2.0.1，浏览器 UMD，底层 PptxGenJS）注入渲染窗口；它**走每一页渲染好的 live DOM → 原生形状 / 文本 / 图片**，不是每页一张截图 | **直接借，并作为默认**：`dom-to-pptx` 是 MIT，可 vendor（保留 LICENSE）。**注意**：不要 `npm install`（它带 puppeteer，会下第二个 Chromium）——注入我们自己的 Electron，正是 OpenDesign 的做法 |
| **PPTX（兜底）** | deck 的**次产物 `slides.json`** 给大纲导出用 | `pptx-tool create --from-file` 走大纲：**只用于套别人的 `.pptx` 模板、或 HTML 源不可用时**；分工见下 |
| **图片** | 逐页 `capturePage` → PNG / JPEG | 照抄，并带上它的两个实战细节：**空白帧重试**（Chromium 有时在合成器出帧前返回全透明帧——`bgraBitmapHasPaint` + 重试 2 次）与**冻结动效**（`FROZEN_MOTION_CSS`）后再拍 |
| **Markdown** | —— | **不做**（考虑过）——HTML 是我们的源，Markdown 是它的降级副本，多一份描述就多一处漂移；真要文字，PDF / HTML 已经在 |
| **ZIP** | —— | 打包这个设计文件夹（普通归档，不新增机制） |

**字体那一处细节值得抄**：`dom-to-pptx` 对 **WOFF2 子集**不可靠，所以 OpenDesign 预取 Google Fonts 样式表时**故意用通用 UA** 换回完整 TTF 字体（`deck-capture.ts: fetchGoogleFontStylesheets`，只放行 `fonts.googleapis.com`）。我们若做 PPTX，这条要跟着做，否则中英混排会掉字形。

**PPTX 两条路的分工（默认走 `dom-to-pptx`）**

`pptx_tool.py` 的 `create` 已经读清楚：它把 markdown / JSON 的每页塞进 `slide_layouts[1/5/6]` 的占位符（没有占位符就加一个 `Inches(1, 1.5)`、`8×5` 的默认文本框），`--template` 只是「打开这份 `.pptx`，按它的版式索引往后加页」。**那是「大纲 → 文字页」，不是「设计 → 幻灯片」**——颜色、版式、背景、定位都不会跟着来。

| 问题 | `dom-to-pptx` | `pptx-tool create` |
|---|---|---|
| 输入 | **渲染好的 deck（live DOM）** | 大纲（markdown / JSON） |
| 视觉 | 跟着 HTML 来（色 / 字 / 版面 / 图片） | 只有模板主题 + 占位符，**没有设计** |
| 源 | **同一份 HTML**，没有第二份描述 | agent 把 deck **再描述一遍**——必然漂移 |
| 编辑性 | 可编辑的**文本 / 形状**，但**绝对定位**：改字可能撑破版面 | 占位符能**自然回流**，加删页更"像 PPT" |
| 起点是别人的 `.pptx` 模板 | **不行** | **行**（`--template`） |
| 读 / 抽一份已有的 pptx | 不行 | `info` / `extract` |

**结论：deck 的 PPTX 默认走 `dom-to-pptx`**——它是唯一「设计什么样、出去什么样」的路，也符合我们「不做第二份描述」的口径。`pptx-tool` 保留三件它真正独有的：**套别人的 `.pptx` 模板**、**读 / 抽已有 pptx**、以及 HTML 源不可用时的**大纲兜底**。
（`slides.json` 那条次产物归大纲这条路，兼作演讲者备注的载体，**不再是 PPTX 的主路**。）

**诚实标注**：`dom-to-pptx` 是第三方 MIT 库、版本要钉（OpenDesign 钉 2.0.1）——它是**绝对定位**的还原，CSS 的透明度叠加 / 混合模式 / 滤镜 / WebGL 这类序列化不了；别承诺「HTML 什么样 PPTX 就什么样」，也别承诺导出后能像占位符那样随意重排。

### 3.5 许可证（要做的决定）

已经把要碰的东西逐个查过（本地源码 + 上游）：

| 东西 | 许可 | 能不能随我们发行 |
|---|---|---|
| **OpenDesign 本体** | **Apache-2.0** | **能**（只借形状 / 行为，保留 NOTICE） |
| **`dom-to-pptx`**（可编辑 PPTX 引擎） | **MIT** | **能**（vendor，保留 LICENSE，钉版本） |
| **`craft/`**（无品牌通则） | MIT（改编自 `refero_skill`） | 能（但见 §2.2：先不收） |
| 设计系统上游（`VoltAgent/awesome-design-md`、`tw93/kami`、`Tom-Opencart/tom-modern-html-style-rule`） | MIT | 能，逐包记出处 |
| **guizang-ppt-skill** | **AGPL-3.0** | **能**（保留原许可），但 **AGPL 的 copyleft 会咬闭源发行** |
| **GSAP（技能文本）** | MIT（`greensock/gsap-skills`） | 能 |
| **GSAP（库本身）** | GreenSock / Webflow 的 **Standard "No Charge"**（免费但有条款，**非 OSI 开源**） | 要单列进 `THIRD_PARTY_NOTICES`，别与 MIT / Apache 混 |

- **默认**：模板与主题库**只收 Apache-2.0 / MIT 的**；guizang 这类 AGPL 的，走「用户自己装 skill / 自己拷模板」，**不进发行包**。
- 一句话原则：**Apache-2.0 / MIT 可以 vendor，AGPL 只做「引用 + 用户自装」，GSAP 单独记账。**

---

## 4. Motion（HTML → MP4）

### 4.1 它是什么

HyperFrames 的做法：**一份 HTML + CSS + 时间轴**，一个 CLI 把它渲染成**可复现**的 MP4——同一份输入，同一段片子。底下是 headless Chromium 逐帧录 + ffmpeg 编码（[heygen-com/hyperframes](https://github.com/heygen-com/hyperframes)，Apache-2.0）。

我们这边形状一样：**一份单文件 HTML 的 composition**，`page.json` 加一个 `motion` 段（`{ fps, durationMs, aspect }`）——它是 pages 的一种产物，不新建对象。**HTML 是源，MP4 才是交付物**。

### 4.2 引擎：OpenDesign 也是用 Electron 渲染的

关键事实（本地源码 `apps/desktop/src/main/frame-capture.ts`、`deck-capture.ts`、`artifact-export.ts`）：**OpenDesign 桌面端的渲染与截图，用的就是那个已经装在应用里的 Electron Chromium**——它明确写着「no second rendering engine / no install-time Chromium download」，连 vendored 的 `dom-to-pptx` 都特意剥掉它自带的 puppeteer。

它只在**一处**用 ffmpeg：**帧序列 → MP4 的混流**（daemon 依赖 `@ffmpeg-installer/ffmpeg`；`frame-capture.ts` 写出的帧故意用 `frame-%08d.png` 的补零命名，就是为了对上 ffmpeg 的 printf pattern）。

所以两边分工其实一样，只差最后一跳：

| 需要 | OpenDesign | 我们 |
|---|---|---|
| 渲染 HTML | 隐藏 Electron `BrowserWindow` | 一样（Electron） |
| 取帧 | CDP 逐帧截图（决定论，见 §4.3） | 已有 `video-frames.ts` 的取帧手法 |
| 帧 → MP4 | **ffmpeg**（`@ffmpeg-installer/ffmpeg`） | `recording-encoder`（`captureStream` + `MediaRecorder`，**不用 ffmpeg**） |

**所以我们的路径**：composition 载进那个编码窗口 → 跑 → 录 → 停，**复用 tab 录制已经建好的 `recording-encoder`**；**渲染器始终是我们自己的 Electron，既不装 HyperFrames 的浏览器，也不装第二个 Chromium。**

> 与官方口径的差别：HyperFrames 官方要 **Node ≥22 + FFmpeg**；我们两样都不要（见 §4.3 对混流那一跳的取舍）。

### 4.3 决定论：OpenDesign 的逐帧做法可以照抄

HyperFrames 的卖点是**帧号驱动、可复现**。上一版我把这里当成难处——**OpenDesign 已经证明它在 Electron 里可行**（`frame-capture.ts: renderDeterministicFrames`）：

- 隐藏窗口：`show: false`、`useContentSize: true`、**`enableLargerThanScreen: true`**、**`backgroundThrottling: false`**、`sandbox: true`；禁弹窗、禁导航。
- **时间轴语义归页面桥**；这个模块只管「隐藏的渲染面 + 每次全新的 CDP 截图」。
- 阶段固定：建输出目录 → 写 `composition.html` → 载入 → 等可打印内容 → 等帧渲染器 → attach debugger → 设视口 → **seek** → **等一次绘制落定** → **截图** → 写帧；**每阶段 30s、总 5min、setup 60s** 的超时。
- 帧命名 `frame-%08d.png`（对齐 ffmpeg 的 printf pattern）。
- **它也不在 Electron 里做音频**——注释直说「the bundled Electron frame renderer does not yet support HyperFrames audio mixing」。

于是我们的选择收敛成清楚的三步：

1. **渲染 / 逐帧取图**：照抄上面那套（Electron + CDP）。这是「可复现」的来源，**不是难点**。
2. **帧 → MP4**：两条路——
   - **(i) 收 `ffmpeg-static` 做混流**：与 OpenDesign 一致；要严格逐帧复现时用。**这不是第二个渲染器，只是一个混流器。**
   - **(ii) 用自己的 `recording-encoder`**：把逐帧 PNG 按固定帧率画进 canvas → `captureStream` → `MediaRecorder`。**内容仍是逐帧决定论的**（每帧就是那张图），但 **MediaRecorder 按墙上时钟打时间戳**——**时间轴不逐毫秒复现**。
3. **v1 建议**：先做 (ii) 把「能出片」打通（零新依赖），要 CI 级逐帧复现时再上 (i)。

> 一句话：**渲染那一半抄 OpenDesign（Electron），混流那一跳先用我们自己有的；要不要 ffmpeg 只是个可以后置的决定。**

### 4.4 授权与许可

- HyperFrames 本体是 **Apache-2.0**（HeyGen）：**只取约定**（HTML + 时间轴 + data 属性）或 **vendor 它的资源**都可以——两种都要**保留 NOTICE**。
- **GSAP 要分两层记，别混**：它的**技能文本**是 MIT（OpenDesign 的 `gsap-core` 来自 `greensock/gsap-skills`，frontmatter 写 `license: MIT`）；而 **GSAP 这个库本身**由 GreenSock / Webflow 以 **Standard "No Charge"** 分发（免费但有条款，**不是 OSI 开源**）。打包库本身就要进 `THIRD_PARTY_NOTICES`，与 Apache-2.0 / MIT 的条目分开。
- **不想背 GSAP 的条款**：HyperFrames 有 **frame adapter** 这套东西（OpenDesign 的 skill 里点名 `animejs` / `css-animations` / `lottie` / `three` / `waapi`）。**默认**：把「时间轴适配器」做成一个概念，第一版只做 **CSS 动画 / WAAPI**，**GSAP 作为可选项**——代价是失去 GSAP 那套 timeline / ease 的顺手。
- **不要 `npx skills add heygen-com/hyperframes`、也不要 `npx hyperframes`**：我们取的是**约定**，渲染用自家 Electron（§4.2）。

### 4.5 不做

- **v1 不引入 ffmpeg**：混流先用自家的 `recording-encoder`（§4.3 的 ii）；只有要做**严格逐帧复现**时才收 `ffmpeg-static`——那也只是个**混流器**，不是渲染器。
- **不做音频**：tab 捕获是 video only（`getDisplayMedia({ video: true, audio: false })`），配乐 / 旁白这一版没有对象。**OpenDesign 的 Electron 帧渲染器同样不混音**（`frame-capture.ts` 注释），所以这不是我们独有的欠账。
- **不做云渲染**：窗口在本机、你看得见（[价值论断](value-thesis.md) §6）。
- **不做第二个渲染引擎**：Remotion / Motion Canvas / Manim 那些 adapter 是 HyperFrames 自己的路线图；我们只认「HTML + 时间轴」这一种源，渲染器就是自家 Electron。
- **不用 HyperFrames 的 CLI / lint**：`npx hyperframes` / `npx skills add` 都不装（§4.4）。

---

## 5. 复用与新增

### 5.1 复用（不重写）

| 需要的能力 | 已有的 |
|---|---|
| 沙箱 iframe、数据仓、grants、定时刷新、分享 | pages 整套（`packages/shared/src/pages/`、`packages/server-core/src/pages/`、渲染层 `components/pages/`、`atoms/pages.ts`、`hooks/usePages.ts`） |
| 隐藏窗口渲染 / 取帧 / 编码 | `video-frames.ts`（Chromium 解码）、`drawio-render.ts`、`recording-encoder.ts`（canvas → `captureStream` → `MediaRecorder` → mp4）、`recording-formats.ts` |
| 读盘、列文件、断链通知 | `packages/shared/src/projects/` 的 `listFiles` / `links` / `notices` |
| 导出 | Electron 打印（PDF）、`capturePage`（图片）、`pptx-tool` / `markitdown` / `pdf-tool` / `img-tool`；可编辑 PPTX 用 vendor 的 `dom-to-pptx`（§3.4） |
| 开真渲染 | 工作区浏览器窗口（`Open in browser`） |
| 列表/详情/侧边栏形状 | Projects 那一整套 |

### 5.2 新增（薄）

对齐 [项目分层](project-layers.md) §1.1 那把尺子——**加一种产物应当只有「一个约定 + 一个字段 + 一个查看器 + 一段导出编排」**：

1. **改名**：`pages` → `designs`（目录、通道、i18n、文档、界面）。**agent 工具名**（`create_page` 等）是否跟着改，是一个单独决定——不改则名字与界面不一致，改则一次性成本；**倾向改齐**。
2. **`DESIGN.md`**：工作区级设计系统（约定名，一处，四种产物共读）；`tokens.css` 可选（§2.2）。
3. **模板目录**：`design-templates/<name>/`（`SKILL.md` + `example.html` + `assets/` + `references/`，§3.2）——随应用打包、同步到用户目录（同 `themes/` 的做法）；agent 起步是**拷一份**。
4. **`deck`**：`page.json` 加 `deck` 段 + deck 查看器（§3.3：宿主只做铺满 / 演示 / 页码，导航 runtime 归模板）+ **导出编排**（§3.4：Electron 打印出 PDF、`capturePage` 出图、**vendor `dom-to-pptx` 出可编辑 PPTX**）。
5. **`motion`**：`page.json` 加 `motion` 段 + **隐藏 Electron 渲染面 + 逐帧 CDP 截图**（§4.3）+ 帧交给 `recording-encoder` 出 MP4 + 时间轴适配器（§4.4）+ `THIRD_PARTY_NOTICES`。
6. **渲染面的地址**：把 design 目录挂成 **`craft-local://` 上的一个 host**（§2.6）——复用 `localHostLabel` / `resolveServedPath` / `contentTypeFor`，**不新增 scheme、不加第二处 `registerSchemesAsPrivileged`**。
7. **指南**：`apps/electron/resources/docs/designs.md`（含 deck 与 motion 两节），`DOC_REFS.designs`。**并且登记进门禁**——`prerequisite-manager` 加一条与 browser / drawio 同形的规则（`create_design` / `update_design`，`strict: true`，`resolveRequiredPath` 指向 `CONFIG_DIR/docs/designs.md`），让「写之前先读」从工具描述里的一句请求变成机制：`initializeDocs()` 已把 `resources/docs/` 全量装进 `CONFIG_DIR/docs/`（无硬编码清单），文件保证在位；工具描述里对它的写法与 browser / drawio 一致（`docs/designs.md`），不再写死 `~/.craft-agent/…`。

**没有 `design_tool`**：写文件本来就是 `Write` / `Edit`（pages 那套 `create_page` / `update_page` / `write_page_data` 是**既有**的，不在「新增」里）。

---

## 6. 不做什么

- **不重建 pages 已有的**：数据仓、grants、refresh、分享——**沿用**，不重做一遍。
- **不做第二个容器**：deck 与 motion 都是 pages 的一种产物（各多一个字段），不是第二套机制。
- **不做新的运行时**：刷新与脚本仍是 pages 那一条链；deck 不自带构建器。
- **不引入第二个渲染器 / 第二个 Chromium**：渲染都是自家 Electron（§4.2）；不装 HyperFrames 的浏览器，不装 `npx hyperframes`，不装 `dom-to-pptx` 的 puppeteer。
- **不做音频、不做云渲染**：motion 的另两条边界，见 §4.5。
- **不做 OpenDesign 的其他创建面**：Image / Audio、Template（用户存下来的模板）、Other——没有对象，也不做 provider-backed 的文生图 / 文生视频（fal / replicate / sora / imagen）。
- **不做设计系统目录**：不建 151 个包的 catalogue、不要 `manifest.json`、不做 import-from-GitHub/Figma（§2.2 的有意分叉）。
- **先不收 `craft/`**：分工对，但那是另一个能力（§2.2）。
- **不判断「够不够好」**：不评分、不提效、不报「缺哪种产物」。OpenDesign 的 artifact lint（反 AI 味的 P0 → P0/P1 徽标 + 系统提醒，`lint-artifact.ts`）**先不做**——它离「评分」只差一步，而且要养一套规则集；真要做得先想清楚它在我们的口径里算什么。
- **不打包 AGPL**（§3.5）；GSAP 的条款按 §4.4 处理。
- **不迁移老数据**：`{workspace}/pages/` 改名即可；老盘上的东西不读、不转。

---

## 7. 命名

- **入口叫 Design，不叫 Pages。** 四处一个词：侧边栏、目录（`designs/`）、文档、文案。
- **`page` 只保留浏览器那一个精确含义**（浏览器显示出来的那份东西），别处一律不用。
- 产物里**不许**出现「页面」指一个 `.html` 文件；「详情页 / 设置页」这类界面屏幕照旧。

---

## 8. 验证

- **前两种产物不回归**：pages 现有测试（storage / data-store / validation / action-bridge / share-bundle / mcp-executor / script-executor）全绿。
- **deck 端到端一条闭环**：
  1. 侧边栏 **Design** → 建一件 deck（拷一份模板）；
  2. 让 agent 读 `DESIGN.md` 填内容，写成「一节一页」的 HTML + `page.json` 的 `deck` 段；
  3. 查看器里翻页——**键盘 / 滚轮 / 触摸 / 页码点四条路都对**，按 `16:9` 铺满，进演示；
  4. 导出五样：HTML（原样）、PDF（Electron 打印，分页对）、**PPTX（`dom-to-pptx` 出可编辑；`pptx-tool` 走大纲）**、图片（`capturePage`）、ZIP。**Markdown 不做**（§3.4）。
- **motion 端到端一条闭环**：
  1. 建一件 motion（`page.json` 有 `motion` 段），让 agent 写一份带时间轴的 HTML；
  2. **渲染**：隐藏 Electron 渲染面逐帧截图（§4.3）→ 交给 `recording-encoder` 出 `.mp4`，确认容器是 mp4、时长与 `durationMs` 相符；
  3. **同一份输入跑两遍，画面内容应一致**（时间轴允许有偏差，见 §4.3）；
  4. 预览里能播；重渲一版覆盖旧文件。
- **边界也要对**：`designs/<slug>/` 拷到另一台机器仍可读；绕开 app 改盘上的文件，重开即真相。

---

## 9. 开放问题（先不决）

1. **`DESIGN.md` 放工作区级还是项目级？** 现在按工作区一份（一个工作区一套品牌）。要按项目就得多一层绑定——**先不做**。
2. **agent 工具名改不改**（`create_page` → `create_design`）？见 §5.2。
3. **deck 的导航契约必须成文**（§3.3）——`.slide.active` 与那四条导航路径是**模板与宿主之间的接口**，不成文就会各写各的。
4. ~~**PPTX 走哪条路当默认？**~~ **已定（§3.4）：deck 默认走 `dom-to-pptx`**（「设计什么样、出去什么样」，且不产生第二份描述）；`pptx-tool` 退为三件它独有的活——套别人的 `.pptx` 模板、读 / 抽已有 pptx、HTML 源不可用时的大纲兜底。
5. **motion 的混流**：v1 用 `recording-encoder`（§4.3 的 ii）；要不要收 `ffmpeg-static` 换严格逐帧复现（i），等真实诉求。
6. **时间轴默认用哪个 runtime？** 倾向 CSS / WAAPI（不背 GSAP 条款）；GSAP 作为可选项——见 §4.4。
7. **模板从哪来？** OpenDesign 的模板本体不在本地 clone 里。是**自己写**、**从它的仓库取**、还是**只做「用户自装」**？这决定 §3.2 打包多少、§3.5 记多少许可。
8. **要不要一个反 AI 味的 lint？** OpenDesign 有（§6）；倾向先不做，但没把话说死。
9. **工作区浏览器窗口要不要收 `craft-local://`？** 现在是插件的 http/https 白名单（`isBrowserUrl` 判否 `craftagents://` / `file://` / `data:`）。收了就能把产物按地址开进那个窗口（真渲染、真交互），代价是 `isBrowserUrl` 与词汇口径都要动。**v1 建议不收**（§2.6）。
10. **预览面的 CSP 与特权**（§2.6）：CSP 怎么配（`script-src 'self'` 还是 `'unsafe-inline'`）、`craft-local` 的 `supportFetchAPI` / `corsEnabled` 要不要给**不可信产物**。**先实测再定**——opaque-origin 从 `craft-local://` 取相对子资源是否真通、同 scheme 的 XHR 是否被 CORS 挡。
11. **要不要为不可信产物单开一个 scheme？** 只有当「服务自家 drawio」与「服务 agent 写的东西」需要**不同特权**时才需要；那时 `craft-design://` 才成立，且名字按**信任级别 / 作用域**取，不按功能。见 §2.6 第 3 点。

---

## 10. 源码对照（OpenDesign，Apache-2.0）

事实出处，在本地 `C:\Users\Ryan\code\open-design`。改这条线之前先读它们，别凭印象：

| 事实 | 文件 |
|---|---|
| 创建页 vs registry mode、Live Artifact = prototype + intent、Media ▸ Video 的 `hyperframes-html` 钉住 HyperFrames | `docs/modes.md` |
| `SKILL.md` 格式、`od:` 扩展、零配置兼容、运行前把模板拷进 `.od-skills/`、deck 的 `index.html` + `slides.json` | `docs/skills-protocol.md` |
| 设计系统包（`manifest.json` + `DESIGN.md` + `tokens.css`、151 包、旧包只有 `DESIGN.md`） | `design-systems/README.md` |
| craft 通则、装配优先级 | `craft/README.md`、`docs/skills-protocol.md` §5 |
| 模板 = 文件夹 + `SKILL.md` + `example.html`；**deck 导航契约** | `design-templates/AGENTS.md` |
| 隐藏 Electron 渲染面、逐帧 CDP 截图、阶段与超时、`frame-%08d.png`、不做音频 | `apps/desktop/src/main/frame-capture.ts` |
| 可编辑 PPTX（`dom-to-pptx`）、Google Fonts 通用 UA 预取、逐页 `capturePage` | `apps/desktop/src/main/deck-capture.ts` |
| PDF / 图片导出、`DECK_PAGE_SIZE` / `DECK_PRINT_CSS`、空白帧重试 | `apps/desktop/src/main/artifact-export.ts`、`pdf-export.ts`、`static-capture.ts` |
| `dom-to-pptx` 是 MIT、钉 2.0.1、不装它的 puppeteer | `apps/desktop/vendor/dom-to-pptx/README.md` |
| ffmpeg 只用于混流与视频封面 | `apps/daemon/package.json`（`@ffmpeg-installer/ffmpeg`）、`apps/daemon/src/chat-artifacts/video-cover.ts` |
| 运行时数据面（`app.sqlite` / `projects/<id>/` / `artifacts/`） | `.gitignore`、`docs/architecture.md` §3.5 |
