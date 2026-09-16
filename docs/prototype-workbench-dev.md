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
| `config.ts` | `config.json`（页表 `pages` + `references`）的读写与规范化；旧形状（顶层 `kind` / `targetUrl`）**读时提升**成行（`legacyPageRows`）；读不干净的条目丢弃进 `pageIssues`，该字段永不写回 |
| `storage.ts` | 路径工具（含 `getPrototypeAnchorsPath`）+ `scanPrototypePatches()`（**派生索引**，不落盘；补丁的页域就是目录——根 = 每页都重放、`patches/<页名>/` = 只那一页；顺序 = **`Z` 按规则排最后**，再按 lane → 序号 → 文件名）+ `scanPrototypePatchesForPage()` / `listPrototypePatchPages()` |
| `pages.ts` | 页的判定与页表合并（`isPrototypePagePath` / `describePrototypePages` / `listPrototypePages` / `findEntryPage` / `matchPrototypePage`）与页表增删改（`updatePrototypePages`：add / remove / rename / entry） |
| `page-document.ts` | 生成的**页索引**（`buildPrototypeIndexDocument`：`/` 没有入口时的落点，也是导出包的 options 页）与**共享外壳**（`applyPrototypeLayout`：`_layout.html` 的单插槽，纯文本替换第一次出现） |
| `patch-script.ts` | `buildPatchInitScript()`：patch → init script 的纯变换（live 注入与导出共用，见 §3.4）；外加**每个补丁的自我报告**——css 报 `@target` 命中了几个元素、js 报有没有抛错，写进 `window.__craft_patch_state__`，由 `buildPatchStateProbeScript()` 读回；宿主页的 css 是纯文本内联、没有脚本可报，所以另有一个批量记录脚本（`buildPatchMatchRecorderScript`，只对声明了 `@target` 的补丁生成） |
| `patch-header.ts` | 标记解析（`@requirement` / `@target`），**零依赖**：`storage.ts`（补丁记录）与 `requirements.ts`（需求线）都要用它，而后者已经依赖 storage |
| `anchors.ts` | **虚拟 base**（§21.2）：`anchors/<页名\|shared>.json` 的读/合并写、漂移与孤儿判定、`dropPrototypeAnchors`，以及两个页面探针（`buildAnchorProbeScript` 取 fingerprint / `buildAnchorCandidateScript` 取候选选择器） |
| `commit.ts` | **收敛**（§21.3）：`commitPrototype()` 把差量层折进它该在的地方——scratch 页 → `assets/<页名>/committed.*` + 文档里的引用；overlay 页 → `patches/<页名>/Z-00x-upper.*`。含 provenance 标记、拒绝（文档不在）与"没人检查过"的报告 |
| `export.ts` | `buildSelfContainedHtml()`（渲染与导出共用的那一个变换，补丁按页取）、`buildDevSpec()`（**按页分节**）、`resolvePrototypeEntry()`（入口页或生成的页索引）、`exportPrototype()`（一个扩展覆盖整条流程） |
| `extension.ts` | 交付物打包：manifest / README / 匹配模式 / 版本号 / 页面变换（内联脚本与 `on<event>` 提取）/ mock 编译 / **按页分文件**（每页自己的 css·js 列表与 `assets/<页名>/`；options 页 = 页索引，工具栏图标开入口页） |
| `status.ts` | 只读全貌（`buildPrototypeStatus` / `listPrototypeStatuses`）：页表 + `entryPage` + `pageIssues` + `pageAvailable` + 按页/共享补丁计数 + **每条补丁的标记**（页 / `@target`）+ **锚点记录**与它的孤儿点名 |
| `prompt.ts` | `<prototype_context>` 的构造与渲染：页列表（名字 / 类型 / 地址或文件 / 是否入口）、每条补丁的页域与它的 `@target`、写补丁的规矩（含"标出你对着什么"）、以及 commit 折什么／为什么不可逆 |
| `ownership.ts` | 所有权矩阵的可执行判据（`classifyPrototypePath` / `canLaneWrite`）：lane 仍由补丁**文件名里的前缀**决定，页目录只决定"改哪一页"；页文档与 `config.json` 属控制面；`Z` 是**收敛车道**（由 commit 写），所以它是一条普通 lane，特殊之处只在重放顺序 |
| `contract.ts` | 契约 fragment 解析与合成、`buildMockRoutes()` |
| `url.ts` | `prototypeOriginUrl` / `prototypeDocumentUrl` / `setPrototypeBaseUrlResolver` |
| `target.ts` | `requireTargetUrl` / `pickOverlayPage` / `setPrototypePageUrl`（改**某一页** overlay 的地址） |
| `create.ts` / `duplicate.ts` / `delete.ts` / `references.ts` | 创建（只建目录与 `patches/`，不写 `config.json`、不预置页）、写页文档（`writePrototypePage`）、读页文档与 `_layout.html`、复制、删除、参考关系 |
| `index.ts` | barrel。**渲染层只能对它 `import type`**，见 §3.6 |

### agent 侧

- `packages/shared/src/agent/browser-tools.ts`：`BrowserPaneFns`（能力接口）、`BROWSER_TOOL_DESCRIPTION`、`getBrowserToolHelp()`。
- `packages/shared/src/agent/browser-tool-runtime.ts`：所有命令分支与输出文案（页表命令 `prototype-pages` / `prototype-entry` / `prototype-target --page`、`prototype-open` 的落点选择、`prototype-apply` 报出"这是哪一页的补丁"都在这里）。**新增命令要同时改这两处 + help 列表**。

### 服务端 / 主进程

- `packages/server-core/src/sessions/SessionManager.ts`：把 `BrowserPaneFns` 装配到真实实现；`describeWindowPrototype` 给 `snapshot`／`windows` 补原型行（slug、页的类型与页名、原型自己的地址）。
- `packages/server-core/src/domain/apply-prototype.ts`：把补丁注入浏览器——只注入**窗口所在页**的补丁（`matchPrototypePage` → 入口页 → 只有共享补丁，并把这个页名报回去）；先读"已内联"标记再决定注册什么；注入后读回每个补丁的自我报告，算出**命中 / 未命中 / 漂移**并写锚点记录。`replayPrototypeInBrowser()` 是文件变更后的那条路：我们自己的页 → 刷新，别人的页 → 重新 apply（**故意不是"apply 再刷新"**，见 §3.12）。
- `packages/server-core/src/handlers/rpc/prototypes.ts`：给渲染层用的 RPC（列表 / 导出 / 页表 `SET_PAGES` / 改某一页地址 / 入口解析 / **`prototypes:replay`**（按 slug 找所有在显示它的窗口并重放）/ **`prototypes:commit`**（纯文件，不碰浏览器）等）。
- `apps/electron/src/main/prototype-host.ts`：原型文档的应答——`/` = 入口页（是 overlay 就 302）或生成的页索引、`/_index` 恒可达、`/<页名>` 对 overlay 是 302、**文件优先**、SPA 路由回退到入口文档（`handlePrototypeRequest` 路由、`registerPrototypeProtocolHandler` 在浏览器 session 上拦 `http`、`installPrototypeBaseUrlResolver` 发地址）。
- `apps/electron/src/main/browser-cdp.ts`：`pickElement`、init script 注册、`setFetchMockRoutes`。
- `apps/electron/src/main/browser-pane-manager.ts`：无边框窗口 / 3 个 BrowserView / 工具栏状态推送 / 地址→原型的反查；`reload(id)` 现在也在 `IBrowserPaneManager` 上（自动重放要用，远程桥照旧 fire-and-forget）。

### 渲染层

- `apps/electron/src/renderer/pages/PrototypeInfoPage.tsx`：原型详情页（Pages 区块 = 页表 + 每页的入口 / 地址 / 改名 / 删除；动作只有三个 + 数据行上的铅笔）；补丁区块逐条列出文件名 / 页 / `@target`，带「改动自动重放」开关与「收敛成一份」按钮；锚点区块列出记录与命中状态。
- `apps/electron/src/renderer/hooks/usePrototypes.ts`：原型的读取与 watcher；**自动重放**也在这里（它是对 watcher 的唯一持有者），`prototypeSlugForChangedFile()` 决定哪些变更值得重放（`patches/`、`assets/`、顶层 `.html`）。
- `apps/electron/src/renderer/atoms/prototypes.ts`：列表 atom + 「自动重放」这个偏好（在 `~/.craft-agent/preferences.json` 里，经 `lib/prototypeAutoReplayPreference.ts` 读写；**默认开**，因为它就是"保存了却没反应"的解药）。
- `apps/electron/src/renderer/components/app-shell/PrototypesListPanel.tsx`：两级下钻列表（原型 → 它的页）与菜单（新建页 / 设为入口 / 改名 / 删除，以及复制 / 删除原型）。
- `apps/electron/src/renderer/components/prototypes/CreatePrototypeDialog.tsx` / `CreatePageDialog.tsx`：只问名字的创建对话框，与按页问类型的"新建页"对话框（类型搬到这里才被问到——它的收益，如引导文案，也一起搬过来）。
- `apps/electron/src/renderer/hooks/useBrowserToolbarActions.ts`：面板工具栏动作 → 主窗口的实际调用。
- `apps/electron/src/renderer/browser-toolbar.tsx`：面板工具栏本体（**独立渲染进程，没有 workspace / 会话上下文**）。

---

## 2. 阶段实现要点与初稿的偏差

初稿写在实施方案里，落地时改掉的地方都在这里；**结论已回写实施方案**，本文只留"当时为什么改"。

| 阶段 | 初稿 | 实际 | 原因 |
|---|---|---|---|
| 2 拾取器 | `startPicker()` / `stopPicker()` 两个方法，返回"用户点击时才 resolve 的 Promise" | 单一 `pickElement()`：注入一次 + 200ms 短轮询，结果写进 `window.__craft_agent_picker_state__`；**第五轮**起工具栏要的是常驻模式，于是拆成 `armPicker()`（注入并留在那里）+ `drainPicker()`（读走并清空，页内 `picks[]` 队列），一次性的 `pickElement()` 退化成两者之上的循环（agent 的 `pick` 仍然一次一个） | 长挂起的 `Runtime.evaluate` 会被 `CDP_IDLE_DETACH_MS = 5s` 的空闲 detach 打断；短轮询天然重置计时器，不必改既有 detach 逻辑。常驻之所以仍用"轮询 + 读走"而不是"长挂起 + 事件"，还是这条：一次调用不能等一整段时间，否则会被 detach 打断 |
| 3 注入 | css 走 `injectStyle`、js 走 init script（两条路径） | 两者统一走 init script（css 补丁由脚本自己创建/更新 `<style>`） | 注入的 `<style>` 元素**不随 reload 保留**，init script 会。统一后"reload 重放"只有一条机制，live 与 reload 也不会分叉。因此没有 `injectStyle` |
| 4 预览 | 新开一条受控渲染通道（现有 HTML 预览 iframe 禁脚本） | 复用浏览器面板打开产物 | 面板本来就是真实引擎、能跑 JS、已沙箱隔离；零新增 UI、渲染环境与工作台一致。产物地址后来由回环 HTTP 提供（§16） |
| 5 mock | 复用 MSW + Prism，或起一个 Node mock server 注册成 Source | CDP `Fetch` 拦截，在网络层 `fulfillRequest` | 前两条分别要引两个新依赖、且覆盖不到 axios 用的 XHR / 要应用改指向；CDP 版本零新依赖、覆盖 fetch+XHR+任意资源、应用一行不改 |
| 6.4 并线 | 工作台任务 = 一个 `TaskSpec`、lane = 一个 node | **推迟**（触发条件写进实施方案 §6.4） | 写冲突已由"派生索引 + append-only patch + fragment 契约 + 所有权矩阵"消除；单用户单 agent 下接 DAG 只多一层生命周期；且 v1 的结构化输出（`param`/`artifact`）尚未实现，接上也传不了产物 |
| 7 放开面 | 新增 `PROTOTYPE_PARTITION` 并只对它允许 `webSecurity:false` | **决定不做**（结论见实施方案 §6 阶段 7） | `webSecurity:false` 买到的是"页面脚本自己跨域"，而同一批能力用 CDP 也能做（`Fetch` 兑现、`Runtime.evaluate` 指定 frame）；代价是不可回退的真实安全弱化 |
| 16 载体 | 原型文档以 `file://` 打开 | 先做了一次回环服务器，**后来换成**在浏览器 session 上拦 `http`（`protocol.handle`），origin 无端口、跨重启稳定 | opaque origin 缺 cookie 域、相对 `fetch`/XHR 与 ES module——mock 层因此永远看不到请求（实施方案 §16）。换载体是因为回环的端口每次启动都变 ⇒ origin 变 ⇒ cookie 与 localStorage 不跨重启；代价（我们站在真实浏览的 http 路径上）与边界见 §3.11 |
| 19 kind 的位置 | `kind` 在**原型**上（§13）：一条流程要么整条 overlay、要么整条 scratch | **下沉到页**：`config.json` 的 `pages` 每行各自 `overlay` / `scratch`，一条流程可以混 | 类型描述的是**一份文档**的性质（我们自己写的 vs 别人的活页面），不是容器的性质；三个"想做却无处放"的证据见实施方案 §19 |
| 19 壳 | scratch 页各自是完整文档，共享部分靠复制 | 可选 `_layout.html`，单插槽 `<slot name="page"></slot>`（读时兼容旧拼写 `<!-- @page -->`），宿主渲染与导出都套（`applyPrototypeLayout`） | 复用停在"共享外壳 + 页自己的资源引用"。**不引模板引擎**：作者面必须仍是最终产物，否则 agent 要学一套我们自己的语法，导出还得反过来还原它。插槽用 HTML 自己的拼写，就是为了不再多造一个只有本工程懂的标记 |
| 19.4 补丁页域 | 补丁没有页域，整原型全量重放 | **目录即归属**：`patches/*` 每页重放、`patches/<页名>/*` 只那一页；`patches/<页名>/` 对不上任何页 → `status.pageIssues` 点名 | 只影响 dev-spec 与状态报告的**分组**，不影响注入正确性（补丁本来就要防御式书写，不匹配即静默无害）；旧数据全在根，语义一模一样 |
| 19.3 `/` | `/` 恒等于 `base.html`（§18），而文件名同时是导出路径与页间链接的锚 | `/` = **入口页**（行上的 `entry` 标记）；没有行标它时 = 宿主生成的**页索引** | 一张表里没有哪一页天然是第一页；换入口不该改文件名。"还没做出这个决定"应当看得见，而不是被一个文件名假装掉 |
| 19.3 `/_index` | 只有 `/` 一个地址 | `/_index` 恒可达（真文件优先，§16.3 的老规矩）；配入口只是换掉 `/` 的落点 | 索引谁也没有被顶掉：配入口是可逆的一步，不是把这个列表拿走 |
| 19.5 options 页 | options 页就是原型页（§17） | options 页 = 生成的**页索引**；工具栏图标开入口页（没有入口就开索引） | 表里可能有多页、也可能混着别人的页面，一个"页面"已经不足以代表它 |
| 19.7 旧数据 | 写迁移脚本 | **读时提升**（`legacyPageRows`）：`kind: "scratch"` → 页 `base`；`kind: "overlay"` + `targetUrl` → 页 `entry`；盘上一个字节不动 | 旧原型零动作可用，新写的数据里没有"旧字段"这回事。控制面下一次写入（只写页表）顺手把形状落成新的 |
| 19.8 声明页 | `prototype-pages --add <name>` 会造一个页 | 不带 url 的 `--add` 只把**已存在**的文档放进流程顺序（文件不在就报错）；overlay 页仍由 `--add <name>=<url>` 建 | **文件管存在、表管顺序与入口**："写个文件就生效"是这套模型最值钱的性子；预置一个空文档只是把死胡同伪装成一条路（§13.2 不变） |
| 19.8 创建 | 创建时问类型，overlay 还要问地址 | `prototype-create` 只要一个名字，建出来的原型**没有页**（连 `config.json` 都不写：没有东西可声明） | 类型与地址都是**页**的事实；"还没有页"是一句真话，不是错误状态 |
| 19.4 重放范围 | `prototype-apply` 整原型全量重放 | 按**窗口所在页**取补丁（`matchPrototypePage`），没有所在页就落到入口页，再落到"只有共享补丁"，并把这个页名报出来 | `patches/<页名>/…` 只落那一页，否则"补丁没生效"和"补丁属于另一页"从结果上分辨不出来 |
| 19.9 面板 | 一级列表 + 右键菜单（复制 / 删除） | 两级下钻（原型 → 页）；类型改由**新建页**对话框问；详情页有 Pages 区块 | 粒度现在真是项目的粒度：原型是一条流程、一个交付单位（config / patches / services / dist 都在它下面），页是文件与地址的粒度 |
| 21 标记 | `@requirement` 只在 `coverage.ts` 里解析；补丁没有 `@target` | 两个标记一起收进 `patch-header.ts`（**零依赖**），`@target` 解析成**列表** | `storage.ts` 要读 `@target`，而 `requirements.ts` 已经依赖 storage——放在 requirements 会成环。列表是因为 commit 会把多条补丁的标记写进一个文件（§21.1） |
| 21 锚点 | 无（S4 只写了"命中报告"） | `anchors/<scope>.json`：**只记命中过的**（加上已有记录的），不匹配时**保留**旧 fingerprint 并把 `matched` 置 0 | 一条没有 `lastMatchedAt` 的锚点读起来像证据，而它不是；而保留旧 fingerprint 才能说"页面变了"而不是"没匹配"（§21.2） |
| 21 收敛 | 无（差量层只会变长） | scratch → `assets/<页名>/committed.*` + 文档引用；overlay → `patches/<页名>/Z-00x-upper.*`；折完删原文件 | base 归谁决定能不能合：我们自己的文档能重写，别人的活地址不能（§21.3）。JS 是**升格**不是折入——折进去等于"执行后序列化 DOM"，那是 §14.1 删掉的方案 |
| 21 自动重放 | 无（只有显式 apply / 手动刷新） | 文件变更 → 宿主页**刷新**、活页面**重新 apply**；300ms 合并、可在详情页关掉 | 对已内联的补丁求值会跑第二遍 JS，而那正是内联标记存在的意义；重放活页面会丢掉窗口里正在填的东西，决定权在知道那窗口在干什么的人 |
| 21 状态与面板 | 补丁只报总数与 lane 分布 | 逐条列出文件名 / 页 / `@target`；新增锚点区块（命中数 / 上次命中）/  提交按钮 / 自动重放开关 | "这条对着什么、有没有人检查过"是读补丁清单时最先要回答的问题，而原来一个都答不上 |

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
| 迁移 | `buildPatchBundle` 搬进 `extension.ts`（它正是 content script 的 JS 体）；书签载体的 URL 生成与载体页代码**删除**（§4） |
| 改 | `export.ts`：两种类型都写 `dist/extension/`；结果类型由 `htmlPath/htmlUrl` 换成 `extensionDir`/`pagePath`/`pageUrl`/`version`/`warnings` |
| 改 | `config.ts` / `pages.ts` / `status.ts` / `prompt.ts`：页表（`pages`）读写、规范化与 `pageIssues` 上报；顺序 = 表序，没人声明的文档按名字接在后面 |
| 改 | `browser-tool-runtime.ts` + `browser-tools.ts` + `SessionManager`：`prototype-pages`（list／`--add`／`--remove`／`--rename`）与 `setPrototypePages`；`prototype-export` 的输出（扩展目录 + Load unpacked 三步 + 警告） |
| 改 | `apps/electron/src/main/prototype-host.ts`（原 `prototype-server.ts`）：回环监听器 → 浏览器 session 上的 `http` 处理器 + `net.fetch` pass-through；origin 去掉端口、地址稳定 |
| 改 | 窗口身份：`PrototypeEntry.origin`（共享层）+ `browserPane.create({ prototype })` + `prototypeBindingFor`（页绑定优先、会话链兜底）+ `BrowserInstanceInfo.prototypeSlug`。修的是"刚创建的原型点「打开」得到普通标签页"——见实施方案 §7。（当时还用了 `bindPrototype` 事后绑定；页的身份改为"创建时定"之后它已删除，见实施方案 §22） |
| 改 | `apps/electron/resources/docs/browser-tools.md`、`release-notes/next.md`、7 个语种的 `prototypeInfo.distEmpty` |
| 验收 | 实施方案 §10 的 M 组（63–70）与 Q 组（86–93） |

---

## 3. 踩坑记录（症状 → 根因 → 修法）

### 3.1 reload 后补丁静默失效

- **症状**：打上补丁 → 页面刷新 → 什么都没了，没有报错。
- **根因**：CDP 的 init script 注册（`Page.addScriptToEvaluateOnNewDocument`）**随 debugger 分离而失效**，而 `CDP_IDLE_DETACH_MS = 5s` 空闲即分离——所以"reload 保留"会在 5 秒后静默失效。
- **修法**：`resetIdleDetachTimer()` 在 `initScriptIds` 非空时直接返回（持有连接），最后一个脚本移除后恢复计时；`detach()` 同步清空键表（CDP 那边也一起没了）。同样的判据后来扩到 `Fetch.enable`（开着 mock 也算持有连接）。

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

### 3.8 原子写的固定临时文件名

`atomicWriteFileSync` 用固定的 `<path>.tmp`（`packages/shared/src/utils/files.ts`），两个写者并发写同一路径时**连临时文件都在争用**。当前单写者模型下不会触发；真要做并发写（§6.4）就得改成每个写者唯一的 `.tmp` 名，或经控制面串行化。

### 3.9 `tsconfig.base.json` 缺失（既有问题）

`typecheck:all` 在 `session-tools-core` 处中断。文件确实存在于上游历史（`0e84b1cd`），但不在本分支的祖先链上，而四个包仍在引用它；按历史原文恢复后 `session-tools-core` 与 `pi-agent-server` 的 typecheck 归零。顺带暴露一处遗留：`session-mcp-server` 的 tsconfig 缺 `allowImportingTsExtensions`（对 `*.ts` 后缀导入报 85 个 TS5097），而该包**没有任何 typecheck 脚本**，所以从来没人跑到。

### 3.10 本 checkout 缺上游脚手架脚本

仓库里 28 个被引用的 `scripts/*` 有 15 个不存在（`build.ts`、`release.ts`、`fresh-start.ts`、`check-raw-sends.sh`、`check-i18n-coverage.ts`、`validate-assets.ts` 等），都属于上游的 CI/发布/本地脚手架，与本工作台无关。**注意 `electron:start` 走的根链（main → preload → renderer → resources → assets）不依赖它们**；缺的 `validate-assets.ts` 只在 `apps/electron` 自己的 `build` 脚本里。

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

- **症状**：文档已经写好（`cart.html` 在目录里，`describePrototypePages` 也把它当页），但 `prototype-pages --add cart` 报 `already has a page "cart"`——于是**没有办法把一页放进流程顺序**，而"文件管存在"这条性子也就落不了地。
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
- **根因**：`prototype-apply` 会跳过"文档已经内联的补丁"，所以"内容改过的那条补丁"在 apply 时是被**当作已应用**跳过的（这是 §3.5 那条不变式的代价）。于是两种天真的做法都错：**只 apply 不刷新** → 改过的补丁不会被重新执行；**apply 再刷新** → 对已经内联的那批补丁求值一次，JS 跑了两遍。
- **修法**：`replayPrototypeInBrowser()` 先读内联标记，**按结果二选一**——文档带标记（我们自己的页，宿主按请求现渲染）→ 只 `reload()`；没标记（别人的活页面）→ 走完整的 apply（重建注册 + 立即求值）。判据来自文档本身而不是地址或页类型，所以存到别处再打开的文档也一样成立。

### 3.17 生成的文本里出现标记**字面**，就会被当成标记

- **症状**：`prototype-commit` 折出来的文件，`scanPrototypePatches` 读到的 `@target` 除了真的选择器，还多了一条 `markers, which the workbench reads).`——`commit.test.ts` 当场抓到。
- **根因**：banner 里写了一句"每个来源都保留它自己的 provenance 头（以及它的 `@target` 标记…）"。解析器按行扫、把标记之后到行尾都当成它的值——**它没法区分"标记"和"谈论标记"**。
- **修法**：生成的文本里不写标记字面（那句改成"它携带的标记"，不点名字）。同一条规矩也约束 provenance 注释：**每个标记各占一行**，`@requirement` 在前、`@target` 在后，因为同一行上的第二个标记会被第一个吞掉。

### 3.18 测试桩不能靠"包含某个字符串"来认探针

- **症状**：加了"每个补丁自报命中"之后，`apply-prototype.test.ts` 里 4 个用例的 `evaluated` 突然变成空数组——补丁脚本压根没被执行到。
- **根因**：测试桩用 `expression.includes('__craft_patch_state__')` 认状态探针，而**每个补丁脚本现在也含这个 key**（它要往里写）——于是补丁脚本被当成探针"答完就走"。
- **修法**：按探针特有的一行来认（`const measured = (entry.matches`、`const entries =`、`out[target] = el ?`）。教训是通用的：**当被测代码开始包含某个 key，用 key 认它就不成立了**，要认形状。

---

## 4. 已删除的机制（墓园）

这些概念**现在不存在**，别再按它们讨论设计；列在这里只为回答"当初为什么删"。

| 机制 | 曾经为了什么 | 为什么删 | 现在怎么做 |
|---|---|---|---|
| **Capture**（`prototype-capture --url`，把在线页冻成 `base.html`） | "总得有个页面才能打补丁" | 它回应的是一个**不存在的需求**：overlay 的补丁打在活页面上，不需要 `base.html`；冻出来的副本跑不了自己的 JS、也带不来会话，只是**看起来像**那个页面 | overlay 的页面**就是**那个在线地址 |
| `prototype-import --from <slug>` | 从另一个原型拿一份起点 | 它把**材料**与**身份**混在一个动作里（搬完 kind/targetUrl 不变，界面上看不出来），而且人真正想要的是"一份能接着改的副本" | 列表右键**复制**：整份复制成一个**新原型**（`duplicatePrototype`） |
| 书签载体（`dist/overlay-preview.html` + `javascript:` 书签 + 控制台退路） | 让没有工作台的人也能在真实页面上看到改动 | 三个代价都是**载体的**性质：页面 CSP 会拒（内联脚本）、一次点击只对当前文档生效（刷新/翻页都要再点）、全部内容要塞进一个 URL（凭空多出 20KB 预算） | 可加载扩展的内容脚本：由**浏览器**注入，三条一起消失 |
| MSW + Prism（D8 原方案）、`dist/mock-server/`、`dist/msw-handlers/` | 用现成 mock 工具跑契约 | 要引两个新依赖，且页面级 mock 覆盖不到 axios 用的 XHR | CDP `Fetch` 拦截（fetch/XHR/任意资源全覆盖，零新依赖） |
| `file://` 作为原型文档载体 | 最省事地打开本地 HTML | origin 是 opaque：没有 cookie 域、**相对 `fetch`/XHR 发不出去**（mock 层永远看不到请求）、ES module 被 CORS 拦 | 回环 HTTP：一个原型一个 host、目录即 origin 根（实施方案 §16） |
| 放开面 partition（`webSecurity:false`） | 让页面脚本自己跨域 | 代价是不可回退的安全弱化，而收益只是"省掉一层 CDP 封装"；能力用 CDP 同样能拿到 | 安全姿态未变：`sandbox` / `contextIsolation` / `nodeIntegration:false` / `webSecurity` 默认开 |
| 落盘的 `manifest.json` 补丁索引 | 记录有哪些补丁 | 多 lane 并发写一个共享索引是最大争用点 | 派生索引：每次从 `patches/` 重算（`scanPrototypePatches`） |
| 「起手形态：本地 dev server」（原 D6） | 区分 dev server 与线上 URL | 它不是一条决策：patch 对任何源页面都是覆盖层，两者在**产出**上没有区别 | 分野改按**产物性质**（overlay / scratch） |
| 创建时预置空 `base.html` | 避免"新原型每个动作都是灰的" | 灰按钮的成因是"没有页面就不能打开"，该由**入口**解决；空文档只是把死胡同伪装成一条路 | 不预置；首稿由 agent 写或复制而来 |
| 面板「保存为补丁」与详情页源码编辑器 | 点一下就能改文案 / 直接改产物文件 | 前者让补丁数量由**点击次数**决定，后者把工程侧界面摆到工作台正面 | 补丁只有一个来源：**agent 写**（实施方案 §12.4） |
| 详情页那四个入口（打开目标页面 / 打开浏览器窗口 / 捕获为底稿 / 导入其他原型） | 让用户手动准备环境 | 每一个回答的都是**机器需要什么**，不是用户想要什么；「打开浏览器窗口」尤其是实现约束漏到界面上的产物 | 由 agent 用 `browser_tool` 承担；详情页只有「预览 / 在对话里改 / 导出」 |

---

## 5. 验证与基线

### 5.1 常用命令

```bash
# 类型检查（逐包，避免 typecheck:all 撞上 §3.9 类问题）
# 前两条从仓库根跑；其余在各自包里
bun run typecheck:shared
bun run typecheck:electron
cd packages/server-core && bun run tsc --noEmit

# 测试（原型相关的四个；前两条合计 468 pass；把路径换成任意文件即可单跑一个）
cd packages/shared      && bun test src/prototypes                              # 309 pass
cd packages/shared      && bun test src/agent/__tests__/browser-tools.test.ts   # 159 pass
cd packages/server-core && bun test src/domain/__tests__/apply-prototype.test.ts  # 14 pass
cd apps/electron        && bun test src/main/__tests__/prototype-host.test.ts   # 38 pass

# 全量（失败基线见 §5.2）
cd packages/shared      && bun test

# i18n（改到 strings/locales 时）
bun run lint:i18n:parity                    # i18n parity OK (6 locales, 1855 keys each)
bun scripts/sort-locales.ts                 # 加过 key 之后跑一次，排序是 lint 强制的
# lint:i18n:coverage 在这个 checkout 跑不了：scripts/check-i18n-coverage.ts 不存在（§3.10）

# 渲染层构建（改到 renderer 或共享包导出时务必跑，见 §3.6）
cd apps/electron && bun run build:renderer
```

### 5.2 既有失败基线（**改代码前先跑一遍**）

这些失败**与原型工作台无关**，别算到新改动头上：

- `packages/shared` 全量：本机（Windows）**38 个失败**，集中在：plans 目录/PowerShell 写入判定、session 路径与路径穿越、`sdk-bridge` 环境变量、`buildCallLlmRequest` 附件、`ensureDefaultPermissions`、`uiLanguage` 幂等、`validateStdioMcpConnection` ENOENT、`sanitizeAssetFilename`、`serializeSession`、plan 执行持久化。均为环境相关既有失败。
- `apps/electron` 的 `browser-pane-manager.test.ts`：源码树里 **6 个**窗口生命周期用例失败（`destroys child popups…`、`focus brings the instance window to front`、`dedupes repeated focus calls before ready-to-show`、`still destroys instance when cleanup throws`、`retries toolbar load and recovers`、`loads toolbar fallback page after retry exhaustion`）。都是 `window.show()` 一类 mock 断言，与原型逻辑无关。
- **测试路径会连带跑 `release/win-unpacked/resources/app/...` 下的旧副本**：`bun test <路径>` 会把打包目录里那份同名测试也收进来，于是失败数与通过数**翻倍**；而且那份旧拷贝会多出 2 个**源码树里已经通过**的失败（`replays toolbar state with theme color when window is shown`、`replays full toolbar state when toolbar renderer finishes loading`）。判断"是不是我引入的"时先排除这些重复项。

### 5.3 测试落点

| 模块 | 测试 |
|---|---|
| 补丁变换 | `packages/shared/src/prototypes/__tests__/prototypes.test.ts` |
| 标记解析（`@target` / `@requirement`，含"写成词就不算"与"一行一个"） | `__tests__/patch-header.test.ts` |
| 锚点记录（合并写、fingerprint 保留、漂移 / 孤儿判定、坏 JSON 容错、两个探针可编译） | `__tests__/anchors.test.ts` |
| 收敛（两类页各自的落点、provenance 标记存活、幂等、拒绝、`--page` 作用域、锚点清理、Z 排最后） | `__tests__/commit.test.ts` |
| 索引扫描 / 命名过滤 / 补丁的页域（`scanPrototypePatchesForPage`、`listPrototypePatchPages`） | 同上 |
| 配置与页表规范化、旧配置的读时提升（`legacyPageRows`） | `__tests__/config.test.ts` |
| 页的判定与页表合并、页表增删改（add / remove / rename / entry） | `__tests__/pages.test.ts` |
| 渲染与导出（按页取补丁、dev-spec 按页分节、入口 / 页索引、提升后的旧配置逐页一致） | `__tests__/export.test.ts` |
| 扩展包（manifest / README / 页面变换 / mock / 按页分文件 / options 页 = 页索引） | `__tests__/extension.test.ts` |
| 所有权矩阵（含页文档与控制面） | `__tests__/ownership.test.ts` |
| 契约合成与 mock 路由 | `__tests__/contract.test.ts` |
| prompt 块（页列表与每条补丁的页域） | `__tests__/prompt.test.ts` |
| 命令层（runtime） | `src/agent/__tests__/browser-tools.test.ts` |
| 注入时跳过已内联；命中 / 未命中 / 漂移的报告与锚点记录；`replayPrototypeInBrowser` 的两种含义 | `packages/server-core/src/domain/__tests__/apply-prototype.test.ts` |
| 原型的应答（入口页 / `/_index` / 页名 302 / 文件优先 / 入口文档不在 / 越界 / pass-through / SPA 回退） | `apps/electron/src/main/__tests__/prototype-host.test.ts` |
| 窗口与地址栏 | `apps/electron/src/main/__tests__/browser-pane-manager.test.ts` |

### 5.4 只能在真实窗口里验的项（跑起 Electron 之后）

| 项 | 怎么验 | 不对时看哪 |
|---|---|---|
| 改完即见 | 用外部编辑器改一条补丁 → 该原型**已打开的窗口** 1 秒内自己跟上（我们自己的页刷新、活页面重新打补丁）；连存三个文件只跟上一次 | `usePrototypes` 里的 `prototypeSlugForChangedFile`（路径是不是落在 `patches/`、`assets/`、顶层 `.html`）；`prototypes:replay` 有没有找到那个窗口（它按 `BrowserInstanceInfo.prototypeSlug` 过滤） |
| 收敛之后效果不变 | 在一个原型上跑 `prototype-commit` → 回到那一页看，改动**还在**且和折入前一样 | 折进去的文件（`patches/<页名>/Z-00x-upper.*` 或 `assets/<页名>/committed.*`）；Z 是不是真的排在最后（`prototype-status` 的补丁清单按重放序列出） |
| 原型页在无端口地址上打开 | 打开一个页是我们自己的原型 → 地址栏是 `http://<label>.localhost/`，页面带着**这一页**的补丁 | 主进程日志里有没有 `[prototype-host] answering prototypes at …`；handler 是不是装在了 `persist:browser-pane` 上 |
| 页名与入口在真窗口里对得上 | 开根地址 → 落在入口页；没配入口时落在**页索引**，点一页进得去；`snapshot` 的 `Prototype:` 行带 `page "<名字>"` | `prototype-status` 的 `pages:` / `root:` 两行；`matchPrototypePage` 认不认得出窗口的真实 URL（overlay 的跳转、SPA 路由都算） |
| 地址栏写着"哪一页"，而且敲得回去 | 在一个 overlay 页上（视图停在真实站点）→ 地址栏是 `http://<label>.localhost/<页名>`；把它敲一遍回车 → 回到**同一页**（不是入口页），地址栏照旧 | `main/index.ts` 注入的 `pageOfPrototypeUrl`（认地址）与 `pageResolver`（认窗口在哪一页）；页名对不上时只写原型域名 |
| **真实站点的 pass-through 无损** | 在同一个窗口打开一个真实站点：上传一张图（分块）、播一段视频（流式）、下载一个文件、来回导航看缓存 | `net.fetch` 那一行；必要时把 handler 临时换成只打日志的版本做二分（见 §3.11） |
| 我们的 host 上 cookie 能回写 | 在原型页里 `document.cookie='a=1'`，刷新后读回 | 同上；回环时代这条是通的 |
| 真实浏览没变慢 | 同一个站点，装/不装 handler 各开一次，比首屏与资源加载 | 那一跳 `net.fetch` |
| 重启后 origin 不变 | 重启应用 → 同一个原型的地址与上次一致，cookie / localStorage 还在 | 这正是换载体要拿到的结果 |

---

## 6. 调试入口

- **地址栏语法**：敲原型的**根地址** = 打开这个原型（主进程用 `resolveServedPrototype` 反查 label，并把窗口绑到这个原型上）；敲原型内部的路径（`/cart.html`、`/dist/extension/cart.html`、SPA 路由）= 普通导航。**不经面板的加载器**（agent 的 `navigate`、任何直接请求）取根地址 = **入口页**：是 overlay 就 `302` 到它自己的地址，是我们自己的页就渲染（文档 + **该页**的补丁 + `_layout.html` 外壳）；**没有行带 `entry` 时给的是生成的页索引**。`/_index` 恒给索引，`/<页名>` 对 overlay 是 `302`，而且**文件优先于页名**。
- **原型优先于对话**：原型可以先存在，`prototypes/<slug>` 目录建好就有地址与页面；对话是来访者——`handleOpenChat` 在没有对话时新建一个（`prototypeSlug` 落在会话头上），有对话时复用；同一个 `prototypeSlug` 可以挂在多个会话上，`prototype-*` 命令按会话解析。窗口的身份则与对话无关（见上一条）。
- **面板工具栏为什么不亮**：工具栏在独立渲染进程里，拿不到 workspace / 会话——它只显示主进程推来的地址与 `prototypeSlug`；两个按钮的可用性完全由那个 slug 决定（没有原型就置灰）。slug 有两条来路，主进程按这个顺序答（`prototypeBindingFor`）：**窗口被打开时声明的原型** → **会话链**（窗口所属会话在做哪个原型）。只留后者时，"刚创建、还没有对话"的原型点「打开」会得到地址栏写着真实 URL、按钮全灰的普通窗口——这是 §3.3 同一族的身份缺失，已修。
- **"补丁没生效"还是"页面不是这一页"**：先看 `prototype-status` 的 `pages:`（每页带类型、地址或文件、`[entry]`）与 `root:` 两行，再看 `page issues:`——`patches/<页名>/` 对不上任何页、声明的页文档不在、行读不干净都在这里点名（§19.4 / §19.8）。`prototype-apply` 的输出也会说这次重放的是**哪一页**的补丁（没有页就是"只有共享补丁"），所以"改错了页"和"补丁没生效"分得开。
- **"补丁没生效"还是"选择器不对"还是"页面变了"**（§21.1／§21.2）：`prototype-apply` 的输出把三种情形分开了——没写 `@target` → "nothing could check these"；写了但从来没命中过 → "matched nothing"（选择器错，或页不对）；写过且**记录过命中**、现在 0 命中 → "the page moved"，并给出页面上现在的候选选择器。第三种要靠 `anchors/<scope>.json` 里的旧 fingerprint 才判得出来，所以那个文件**别手删**（删了下次 apply 只能重新从零开始记）。
- **收敛之后效果变了**（§21.3）：`prototype-commit` 是文本折叠，它不知道"语义等价"。先按 §5.4 那两条在真窗口里对照一次；`prototype-status` 的补丁清单按重放序列出，`Z-*` 必须排在最后——不是最后就说明顺序规则被改坏了（`storage.ts` 的 `byReplayOrder`）。
- **扩展交付物**：`dist/extension/` 在 `chrome://extensions` Load unpacked；**options 页是生成的页索引**（点一页就过去），工具栏图标开入口页；改完补丁要重新导出并在该页点 **Reload**（快照语义，见实施方案 §17.4）。`dist/dev-spec.md` 按页分节。
- **契约 mock 不生效**：先看路径是否只按 pathname 匹配、以及请求是否由页面自己发出（PWA 的 service worker 请求不经过页面）。
- **原型页打不开**：先看主进程日志有没有 `[prototype-host] answering prototypes at …`；地址形如 `http://<label>.localhost/`（无端口），而且**只有被打开/导出过的原型才注册过**——没注册过的地址答 404 是对的。根地址答 404 并点名一个页名时，是**入口页的文档不在**（不会退回索引，§19.3）。
- **真实站点行为异常**（上传、流式、下载、缓存）：先怀疑 pass-through，按 §3.11 的三条约定对一遍，必要时把 handler 换成只打日志的版本二分。
