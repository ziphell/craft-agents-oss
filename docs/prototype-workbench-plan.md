# 产品经理需求生产工作台 — 实施方案

> 状态：**核心闭环已交付**——创建（侧边栏「原型」+ 面板「+」+ 空态按钮）→ 详情页三个动作（预览 / 在对话里改 / 导出给开发）→ 面板工具栏「选中元素 / 应用补丁」→ 交付物 `dist/extension/`。**两种页类型（§13 → §19）**：`overlay` / `scratch`，**类型在页上**、新建页时确定、不可改，落在 `config.json` 的页表里并被详情页、system prompt、agent 命令共读；overlay 页的地址新建时必填、之后可改（§13.2.1）。**会话 ↔ 原型绑定（§11）**：system prompt 带 `<prototype_context>`，`prototype_tool` 命令的 slug 可选。**编辑只走对话（§12.4）**：选中元素只回答"哪一个元素"，补丁只有一个来源（agent 写）。**参考关系（§14）**：参考是独立原型 + 一条 `references`，规矩是"翻译不要搬运"；起点靠列表的「复制」另起一个新原型（§13.1.1）。**scratch 的载体（§16）**：Electron 直接应答 `http`（`protocol.handle`，不是监听一个端口），一个原型一个 host、目录即 origin 根，根路径是该原型的**首页**。**交付物（§17）**：一个原型一个可加载的 Chrome 扩展（Load unpacked，不进商店），mock 默认一起交付；另有两份各覆盖自己能覆盖的那一半——`dist/static/` 每页一份自包含 HTML（§17.8）、`dist/bookmarklet.html` 把 live 页的改动做成书签（§17.9）。agent 的契约不变，内联脚本与 `onclick` 由生成器吸收。**多页（§18 → §19）**：页是原型的一部分，导出时**每个真实 URL 各一个 match pattern**、scratch 的每一页也都在包里。**页层模型（§19，已实现）**：`kind` 从原型**下沉到页**——一个原型是一张有顺序的页表，每页各自是 scratch 或 overlay；补丁按 `patches/<页名>/` 分页（根 = 共享）；`/` 打开入口页，没标入口时是宿主生成的**页索引**（`/_index` 恒可达）；导出覆盖整条流程，options 页 = 页索引。旧原型零迁移（旧 config 按页表读）。落点见 [开发文档](prototype-workbench-dev.md) §1／§2。**状态化 mock（§5.3，D9 的后置部分）**：路径项声明它属于哪个集合（`x-mock-collection`）、起始状态写在 `services/{svc}/state.json`，**语义由 HTTP 方法推导**（GET 读 / POST 追加 / PATCH 并入 / PUT 替换 / DELETE 删元素），所以"演多步流程"不需要作者学一门迁移语言；store 只在内存里、从不回写，再 apply 一次就是重放。阶段 6.4（Tasks DAG 并线）**已落地**，阶段 7 的放开面**决定不做**，响应头就地改写未做。
>
> **读旧章节时的一个约定**：本文 §1–§18 是逐阶段写下的，其中"`base.html` 是入口页/裸底稿""`kind` 与 `targetUrl` 属于原型"这两类说法在 §19 之后不再成立（各自章节开头已标注）。**冲突时以 §19 为准**；与 §19 无关的部分照旧有效。
>
> 实现细节、踩过的坑、以及已经删掉的机制见 [开发文档](prototype-workbench-dev.md)；本文只写设计与决策。
> 范围：MVP（个人使用，先增量模式）
> 前置结论：本方案基于对现有代码的实测核对，所有引用均带文件路径与符号名。

---

## 1. 定位与范围

**一句话定位**：一个真实浏览器引擎 + 一层 UI patch + **一层服务契约** + 一组导出器，由**现有 Tasks DAG 作为控制面**编排多写者并线，两个入口（真实网页 / 生成的空页）。

**与 Pencil 的关系**：不是"替代画布"，而是补上 Pencil 覆盖不到的生态位——Pencil 在空白画布上"无中生有"并生成代码；本工作台在**真实产品**上做增量，并把增量变成开发能用的东西。核心差异是**渲染载体**：Pencil 用矢量画布（矢量 → 代码，有翻译损耗），本方案用真实浏览器引擎（只有一种表示，所见即代码）。

**脱离纯前端视角**：mock 不是"拦截浏览器请求的技巧"，而是**服务契约层**。mock 是服务契约的一种运行时物化，同一个契约同时面向前端与后端交付。

**平面分离**：数据面 / 控制面 / 业务逻辑 / 渲染四者相互分离。这不是为了整齐，而是**多 agent 并线能成立的前提**（见 §3）。

**决定一切的分野是产物性质，不是运行环境**。一个原型有两种起点，产出的东西性质完全不同：

| | 源页面 | 我们改的是 | 产物 | 能回流源码吗 |
|---|---|---|---|---|
| **外部页（overlay）** | 别人的（产品 dev server / 测试环境 / 线上，**都算这一类**） | 我们注入的 patch 覆盖层，打在**那个在线页面本身**上 | patch + `dev-spec.md`（含 `Applies to: <地址>`） | **不能**。它是给开发的**可执行规格**，由人翻译进源码 |
| **自建页（scratch）** | 我们自己的文档（`<页名>.html`） | 我们自己的 HTML | 完整页面（自包含 HTML + spec） | 不适用，它本来就是源码 |

两者之间**没有桥**：live 页的补丁打在活页面上，不需要一份我们自己的文档；文档只属于 scratch 页。于是"三态"（纯覆盖 → 快照 → 纯自有）收敛成两态。（曾经设计过"把在线页冻成一份文档"这条路，删掉的理由见 [开发文档](prototype-workbench-dev.md) §4。）

由此得出两条推论：

1. **「产品 dev server vs 线上 URL」不是设计维度。** 无论哪一个，patch 都是覆盖层，都不回流源码；dev server 的「DOM 可控、无登录态」只降低**排错**成本，不改变**产出**。
2. **在线场景更多，且不需要为登录做任何事。** 目标站点要登录时，**用户在窗口里自己登** —— 这里没有自动化登录，所以「已登录」只是页面的一种普通状态，和处理它无关。三条机制保证这一点成立：注入按 document 生效（`Page.addScriptToEvaluateOnNewDocument`），登录跳转后自动重新执行；准备阶段那个 `browser_tool` 窗口与原型窗口共用 `persist:browser-pane` partition，所以登录一次、原型窗口打开同一地址就带着它；空闲 detach 后 `send()` 会 `ensureAttached()` 自动重连，且一旦应用过 patch（`holdsSessionState()`）就不再 detach。

这张表不是**分析结论**，而是**产品结构**：它落成了两个原型类型（`overlay` / `scratch`），在创建时确定、不可改，见 §13。第三个诉求（逆向第三方再搭自己的，§14）**不新增类型**——"在看什么"是 `PRD.md` 旁边的一份材料，而"把别人的吸收成我自己的"是列表的「复制」（§13.1.1）。

### MVP 范围内的（按优先级）

| 编号 | 能力 |
|---|---|
| 阶段 1 | 接线层：产物目录 + 文件读写通路 + 目录监听 |
| 阶段 2 | P0 拾取器：选中 DOM → 高亮 → 稳定 selector |
| 阶段 3 | 持久注入：patch 落盘、reload 后按顺序重放 |
| 阶段 4 | 导出器：页 + patch → 扩展包 / 静态单文件 / 书签 + 变更说明 |
| 阶段 5 | 服务契约层：契约真源 → mock 物化 → 后端交付 |
| 阶段 6 | 平面分离与并线接线：所有权矩阵 → 派生索引 → 挂接 Tasks DAG |
| 阶段 7 | 无中生有入口 + 改写真实后端返回（放开面：决定不做） |

### 明确不做的（非目标）

- 多租户、协作、权限、账号体系（个人使用）
- 矢量画布 / 拖拽设计器（Pencil 的护城河，不抢）
- 云端存储（产物就是本地文件）
- 放开面（`webSecurity:false`）与"跨域由页面脚本自己做"：**已决定不做**（阶段 7），能力改走 CDP
- MVP 不实现 Tasks 的非 `session` 节点种类（`parallel`/`map`/`verify`/`aggregate` 用 `session` 节点模拟）

---

## 2. 已确认的架构决策

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | 渲染载体 | 真实浏览器引擎（BrowserView + CDP） | 所见即代码，零翻译损耗 |
| D2 | 持久化模型 | Hybrid：编辑时 live overlay，交付时 snapshot | 线上页面改版不毁产物 |
| D3 | 产物位置 | `{workspaceRootPath}/prototypes/{slug}/` | 跨会话长期存活，契合"同一项目多交付" |
| D4 | 写通道 | 混合：确定性改动走新增 `file:write` 直写；语义改动走 agent `Write`/`Edit` | 实时性与可审计性兼顾，最终同一真源。**实际只用了后半条**：`file:write` 通道在（控制面自己用它），但"编辑只走对话"（§12.4）定下之后，界面上没有任何入口去直写产物，补丁的唯一来源是 agent |
| D5 | 权限模型 | 所有浏览器窗口同一个 lock-down 姿态：`sandbox:true` / `contextIsolation:true` / `nodeIntegration:false` / `webSecurity` 默认开 | 注入与跨域都由 CDP 提供，不需要页面脚本自己跨域（放开面已决定不做，见阶段 7） |
| D7 | 服务契约格式 | **OpenAPI 3.1** | REST 生态最成熟，后端与工具链都能直接吃 |
| D8 | mock 运行时 | **CDP `Fetch` 拦截**（网络层 `fulfillRequest`） | fetch / XHR / 任意资源全覆盖，**应用一行不改**，零新依赖，复用已有 CDP 基建 |
| D9 | mock 状态 | **状态化**（`x-mock-collection` + `state.json`，见 §5.3） | "演多步流程"需要 mock 记住上一屏做了什么；语义由 HTTP 方法推导，因此不必为此造一门迁移语言 |
| D10 | mock 与服务的关系 | **补充手段**：需要 agent 也能调 mock 时，把 mock 做成 `baseUrl` 指向本地的 Source | mock ↔ 真服务切换只改 `baseUrl`；MVP 的 mock 走 CDP 拦截，不依赖它 |
| D11 | 并线的控制面 | **复用 Tasks DAG + TaskRunner** | 已并行（`max_parallel` 默认 4）、已持久化、已支持依赖图 |
| D12 | 单文件争用 | **不落盘索引，按需派生** | 彻底消除最大争用点：索引由控制面从磁盘扫描得出 |
| D13 | 工作切分 | **按平面切**（UI / 契约 / 数据 / 验证） | 每个平面写不同文件类型，所有权最干净。**注意：平面字母不是调度键、也不是 DAG 的绑定键**（§3.4 校正、§3.6）；代码里这个实体叫**写入身份**（`writer`） |
| D14 | 写者之间 | **只读通信**，互相不共享写 | 共享写是并线的唯一致命伤 |
| D15 | 渲染面角色 | **只读**；拾取器是**传感器**不是写者 | 渲染一旦写文件就破坏所有权模型（修正 D4 的执行者） |
| D16 | 会话与原型的关系 | **绑定**（session.prototypeSlug），复用 session↔project 的既有范式 | 让 agent 不必每轮被告知操作对象；`prototype_tool` 命令的 slug 因此可选（见 §11） |

---

## 3. 平面分离与多 agent 并线

### 3.1 四平面

| 平面 | 职责 | 写入者 |
|---|---|---|
| **数据面** | 各页文档 / `patches/` / `services/` / fixtures | 各写者独占其文件；控制面负责合成派生索引 |
| **控制面** | 编排、依赖、并发、权限、**单文件资源仲裁** | **唯一写者：控制面自身** |
| **业务逻辑** | `patches/*.js`、`services/*/paths/*.yaml` | `contract` / `data` 独占（路径规则，见 `ownership.ts` 的 `PROTOTYPE_PATH_WRITERS`）；**强制不与 fixtures 混写** |
| **渲染** | BrowserView、预览面 | **只读**。拾取器只发事件 |

### 3.2 并线的瓶颈是写冲突，不是调度

实测结论（重要）：

- **调度已解决**：`ActiveRun.scheduleReady()` 已并行派发，`max_parallel` 默认 4（`TaskRunner.ts`）；依赖图物化与就绪判定见 `validate.ts`、`TaskRunner.ts`。
- **全仓没有任何锁**：不存在进程级/跨进程文件锁、互斥锁、信号量或租约（全文检索无实现）。
- **原子写本身也会争用**：`atomicWriteFileSync` 使用固定 `<path>.tmp`（`packages/shared/src/utils/files.ts`），两个写者并发写同一路径时**连临时文件都在争用**。
- 现有保护只覆盖会话 header 的元数据（自写识别 + 5s 写保护窗口，`SessionManager.ts`），**不覆盖任意产物文件**。

**因此：并发安全只能靠"所有权"，不能靠"锁"。** 这就是平面分离的真实收益。

### 3.3 五条硬约束

1. **写者之间只读通信**。上游产出 → 下游只读消费，不共享写。
2. **单文件是敌人**。`manifest.json` → 派生索引（D12）；`openapi.yaml` → 按端点拆 fragment + 控制面合成（OpenAPI `$ref` 天然支持）。
3. **patch append-only + 唯一命名**。`{writer}-{nnn}-*.css|js`，各写者写自己的文件，零争用。这正是此前"每个 patch 独立文件"决策在并线场景下的额外回报。
4. **渲染面只读**。拾取器是传感器：只发事件，由控制面决定写哪个文件。这条**修正 D4 的执行者**——"直写"仍保留，但执行者是控制面，不是 renderer。
5. **结构化输出必需**。v1 的 `NodeOutput` 只有自由文本 `text` —— 下游写者要可靠消费上游产物，必须让结构化输出落地。**已落地**：节点在 `outputs:` 里声明字段，派发时带上契约，完成时归档为 `params`（`outputs.ts`）；`when:` 分支即建立在此之上（`conditions.ts`）。

### 3.4 工作切分与 DAG 映射（D13，已按第一性原理校正）

```
前缀   平面        产物                                        归属怎么定
A      UI/交互     patches/A-*.css, patches/A-*.js             前缀 = 写入身份
B      服务契约     services/{svc}/paths/*.yaml                 路径规则 → contract
C      数据        services/{svc}/fixtures/*.json              路径规则 → data
D      验证        只读全部产物 → 产出 verdict（不写）           没有产物，所以不是 owner
```

**这条切分（产物里体现为写入身份）不是调度单位，那个前缀也不是"平面标签"。** 逐条校正：

- **调度单元是 node，不是这条切分。** 并行由 `depends_on` 扇出 + `max_parallel` 提供；把"某个平面"与 node 做恒等的话，node id 活在**一次运行的 spec 快照**里、patch 活在**产物**里——图重排一次，历史补丁的 owner 就成了不存在的节点名。DAG 要绑的键因此是**写入身份**（§3.6），不是字母。
- **前缀的作用是"命名空间租约"，不是"平面标签"。** `patches/` 是唯一一个多个平面写进同一目录的地方，所以它需要一个写者前缀；而 `services/{svc}/paths/` 与 `fixtures/` 的归属**本来就由目录决定**（`ownership.ts` 只对补丁从文件名推 owner）——B/C 的字母不参与任何判断，它们只是给已有路径规则起的别名。
- **`D` 不是 owner。** `classifyPrototypePath` 只回三种 owner——`{kind:'writer'}` / `{kind:'control-plane'}` / `{kind:'tooling'}`：只读意味着它不拥有任何路径。它是**角色**，不在 owner 词表里。
- **排序不该读前缀。** `byReplayOrder` 今天以前缀为主键，但代码注释自己写着字母序无语义（"by rule, not by the alphabet"、"a patch's meaning may not depend on which writers the others happen to use"）。改成 `折叠层最后（按规则）→ 序号 → 路径`，前缀从此只表示归属；语义上唯一必需的顺序约束是"折入的补丁最后重放"（`Z`，`fold.ts` 写的是固定名 `Z-00n-upper.css` / `Z-00n-upper.js`）。
- **词表 → 规则。** 闭合词表退休，只留一个保留 token（折叠层）。`{writer}-{nnn}` 的定界不再依赖"恰好一个字母"，而是锚在序号上（`PROTOTYPE_PATCH_NAME_RE = /^(.+?)-(\d+)-(.+?)\.(css|js)$/`，见 `types.ts`），既有文件零迁移。**代价要认**：以前"前缀不在词表里"这类违规在构造上消失，只有配上"声明的写入身份集合"才补得回来（§3.6 第 3、5 条）。

**根因**：文件名里只有一个 token 的位置，而它放的是 **kind**（工作的种类），不是 **writer**（写者身份）。单用户 + 单 agent 顺序执行时 kind ≡ writer，所以这个混淆不可见；一旦真并发，它就变成静默失效。**唯一在跑的消费点盘点**（`PrototypePatch.writer` 的全部读者）：`fold.ts` 按折叠层过滤（幂等）、`ownership.ts`（谁拥有哪个路径）、`storage.ts`（排序：折叠层最后 → 序号 → 路径），以及四处**展示字符串**（dev-spec / 扩展包说明 / agent 的补丁清单 / status 计数）。写前守卫是 `whyWriterMayNotWrite`（§3.6 已接上），`resolvePrototypeOwnership` 供 `status` 做事后报告——两者一个在写前拦、一个在事后点名。

注意：v1 **执行的节点类型是 `session`（子会话干活）与 `approval`（停下等人点同意）**；节点 `outputs:` 的声明式结构化输出（`outputs.ts`）与 `when:` 分支（假则跳过，跳过会传染下游，`conditions.ts`）均已落地。`parallel`/`verify`/`aggregate`/`loop` 等其余 kind 仍只解析不执行（`schema.ts`）——并且**非 session/approval 的 kind 现在会被当成普通 session 派发**。阶段 6 先用 `kind: 'session'` 模拟，不依赖 P4。

### 3.5 所有权：只登记有规矩的路径

表只回答一个问题：**两个写者会不会互相覆盖**（§3.3）。所以只登记会的地方——`patches/` 从文件名推 writer、`services/` 从目录推 writer、`anchors/` 与 `acceptance/` 是工具的记录。

| 路径 | Owner | 其他 writer |
|---|---|---|
| `patches/{writer}-{nnn}-{name}.{css,js}` | 文件名里的 writer | 拒写 |
| `patches/<页名>/…` | 同上（目录只决定**改哪一页**） | 拒写 |
| `services/{svc}/paths/*.yaml`、`config.json` | `contract`（路径规则声明） | 拒写 |
| `services/{svc}/fixtures/*.json`、`state.json` | `data`（路径规则声明） | 拒写 |
| `services/{svc}/openapi.yaml` | 控制面合成 | 拒写 |
| `services/{svc}/` 下的其它文件 | —— | 拒写（服务目录只放上面几样） |
| `anchors/**` | **工具**（`apply` 按实际命中写） | 拒写 |
| `acceptance/**` | **工具**（`verify` 按实际结果写） | 拒写 |

**其余一切默认归控制面**，表里不列：`PRD.md` 与它旁边的材料、页面文档与页表、`config.json`、`assets/**`、`research/**`、`dist/**`，以及作者随手加的任何文件。原型目录首先是**作者自己的文件夹**（§20.1）——一个有材料要落地的作者往里面加一个 `screenshots/` 或 `notes.xlsx`，不是违规，是这件事本来的样子。

这条边界决定了判据的形状：**白名单 + 兜底**，而不是对文件夹形状的第二份描述（[ownership.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/prototypes/ownership.ts) 的 `classifyPrototypePath`）。第二份描述从写下的一刻就开始过期。

**三类 owner，只对"拒写"的两类判违规**（§3.6 落地时定的边界）：writer 拥有的路径，跨 writer 写 = 撞车 → 拒；控制面 = **agent 自己**，它盖原型时正当要写 → 放行；**工具**拥有的路径 = 记录（`anchors/**`、`acceptance/**`）→ 拒，理由是"你自己写的记录不是任何东西的记录"。

> **修正（2026-09-17，两次）**：这张表第一版枚举了整个文件夹，对未列出的路径回 `unowned path`——于是漏列一个形状就报一片假违例（`prd.md` 那一次：**任何写过 PRD 的原型都在报违规**），而报告说的唯一一件事就是"这个原型哪里不对"。第一次修法是"把表补全"，那是错的：等于承诺永远同步第二份描述。正解是**不再描述文件夹**——只留上面这几条真有规矩的路径，其余默认放行。回归测试见 `ownership.test.ts` 的 "treats the author's own folder as theirs, at every level"。

### 3.6 写入身份与 agent 的接口契约（已落地）

**为什么需要它**：所有权要能被判定，写者就得先知道自己以谁的身份写——而落地前它不知道。三条接口里没有一条带身份（下表是落地前的样子）：

| 接口 | 载体 | 带身份吗 |
|---|---|---|
| **读**（它知道什么） | `<prototype_context>`，`buildPrototypePromptContext(workspaceRootPath, slug)` | **不带**：入参只有根路径与 slug，内容全是原型状态（页 / 补丁含 `writer` / 服务 / 需求 / findings / 违例） |
| **做**（它被允许什么） | 命令面 + Write 工具 | 不带授权：命名规矩只活在 `prompt.ts` 的一段文字里 |
| **交**（它产出什么） | 任务节点侧的 `outputs` 契约（runner 追加进 prompt） | 只对任务侧有效，**与原型侧不接头** |

**三处不对齐**（都有证据）：

- **同一份词表教两遍**：`prompt.ts` 与 `apps/electron/resources/docs/browser-tools.md` 各印一份"前缀 = 哪个平面"的词表。改一处必忘另一处。
- **有词表、没身份**：prompt 说"不要改写别人拥有的补丁文件"，而 agent 无从知道"我"是谁；判定函数需要的那个身份在生产代码里**没有来源**（零调用）——§3.4 说的"还不是守卫"，在 agent 侧就是这个样子。
- **节点侧与原型侧脱节**：一个正在做原型工作的 DAG 节点**同时**收到原型上下文（补丁怎么命名）与任务契约（`outputs` 怎么交），两边互不知情。

**目标形态：一个字段，穿一条已经存在的路。** 盖章机制今天就在跑——Conductor 已把 `taskSlug` / `taskRunId` / `taskNodeId` 盖到子会话（`SessionManager` 的会话元数据），而 agent 手里就有 `config.session`：

```
node 声明 writes: checkout-ui      ← spec，与 outputs 同层的声明式字段（同一 run 内唯一）
  → child session.taskWrites       ← 派发时盖章（复用 taskNodeId 那条路，无新机制）
  → <prototype_context writer="checkout-ui">   ← agent 读到的第一行就是"我以谁的身份写"
  → whyWriterMayNotWrite(path, writer)  ← 写前守卫（PreToolUse 第 5d 步）：拒绝时**返回原因**（照 tab-access 的 whyTabIsOutOfReach：agent 读得到为什么，才改得动）
```

**对齐清单**（第 1–4 条是"agent 知道自己是"；第 5 条是"越界真的被拦"；第 6 条是"不再教两遍"）：

1. ✅ `PrototypePromptContext.writer`，渲染进 `<prototype_context slug="…" writer="…">` 的开放标签。
2. ✅ `buildPrototypePromptContext(rootPath, slug, writer)` 三参；两个调用点（`claude-agent.ts`、`pi-agent.ts`）同改，身份取自 `resolvePrototypeWriter(config.session)`。
3. ✅ spec 增加节点声明 `writes:`，校验同一 run 内唯一（重复、保留 token `Z`、以及会与文件名解析歧义的 `-<digits>` 结尾一律拒绝）。
4. ✅ 派发时盖章到子会话（`taskWrites` 走 `SESSION_PERSISTENT_FIELDS`，与 `taskNodeId` 同一条路）。
5. ✅ `runPreToolUseChecks` 第 5d 步接 `whyWriterMayNotWrite`：写工具指向 `prototypes/<slug>/…` 时拒绝并说明理由。
6. ✅ `prompt.ts` 与 `browser-tools.md` 的**词表 → 规则**（前缀 = 你被授予的写入身份）；`D` 随词表一起退休；生成器 prompt 补了 `writes` 一行。

**验收（"对齐了"的样子）**：节点在 `<prototype_context>` 里读到自己的写入身份（`prompt.test.ts` 有断言）；写 `patches/<自己的身份>-002-….css` 通过，写别人的前缀被拒绝且**拿得到理由**（`ownership.test.ts` 的 `whyWriterMayNotWrite` 与 `pre-tool-use-checks.isolated.ts` 的流水线用例）；两份文档关于命名的说法**逐字一致**（同一句话只写一处，`browser-tools.md` 从规则出发）。

**已定（记录时发现的洞）**：`writes:` 是**节点**声明的，而绝大多数原型工作发生在**非 DAG 的手工会话**里（人在对话里让 agent 改页）——那里没有节点、没有声明。取**选项 ①**：缺声明时身份**由会话派生**，`resolvePrototypeWriter()` 返回 `main`，读作"这个原型只有一个写者"。身份因此**总是存在**，声明只在多写者时才需要写出来，手工会话不必多一步。

**落地时定下的两条边界**（不在原清单里，但不定就会做错）：

- **守卫拦的是"撞车"，不是"控制面"。** `canWriterWrite` 是严格原语（控制面路径对任何写者也返回 false），但**控制面就是 agent 自己**：页文档、`config.json`、`PRD.md` 与它旁边的材料、`dist/` 是它盖原型时正当要写的文件，照严格语义拦会把最常见的情况拦掉。所以执行的是 `whyWriterMayNotWrite`：别人的产物、以及**破坏了自己那条规矩的文件**（拼错的补丁——注入器静默忽略它；服务目录里的杂文件——契约读不到）→ 拒；其余 → 放行（§3.5：没有规矩的路径一律默认控制面）。
- **排序不再读写入者名。** 前缀是身份，不是顺序键：重放顺序 = 折叠层垫底 → 序号 → 路径（`storage.ts:byReplayOrder`）。代价认了：`A-002-x.css` 不再因为前缀字母而排在 `B-001-y.css` 前面。

**状态**：六条全部落地，`tsc` 与 `src/prototypes`、`src/tasks`、`core/__tests__` 全绿。

### 3.7 争论与验收：DAG 与详情页之间那条线（已落地）

3.6 让 agent 知道"我以谁的身份写"。这一节补的是另外三样——**它写得对不对，别人认不认，以及上一轮是什么情况**。三者都不是新能力，是把盘上已有的东西接成一条线：

| 产物 | 形状 | 谁写 | 派生在哪 |
|---|---|---|---|
| `reviews/*.md` | 一条异议一个文件，头标记与 findings 同构：`# D-001 …` + `about:` / `on:` / `status:` / `claim:` / `evidence:` | **agent**（控制面）——critic 节点直接写它，人也能写 | `resolveRequirementCoverage`（唯一一处）→ `status.reviews` / 每条需求行的 `disputes` |
| `acceptance/state.json` | 每轮每 check 的答案 + 轮次 | **只有 `verify`**（`tooling`，手写被守卫拒） | `summarizeAcceptance` / `compareAcceptance` |
| `dist/acceptance.md` | 这一轮 + **与上一轮的差** | 同上 | 交付物快照 |

**三条设计判断，都是"派生优先于声明"的同一件事**：

1. **异议的状态要与盘对账。** `status: open` 而它争的那个补丁已经变过 → 报 `stale`；`status: fixed` 而那个补丁**没**变 → 同样报 `stale`。判据是记录里的 `on:`（补丁内容指纹，8 位）——照 `anchors/` 的做法，"这条异议还在说当前这个文件"与"它在说一个已经不存在的版本"必须分得开。`on:` 只对补丁要求，因为只有补丁是"一文件一对象"；页/端点/需求跨多个文件，没有单一指纹，硬要就是造一个新的会漂移的来源。
2. **异议挂在需求那一行，但需求不重述。** `about: patch X` 的异议通过 X 的 `@requirement` 标记落到需求行上；`about: requirement R-003` 直接落。review 文件里**没有**"我这条是关于哪条需求"的字段——那会是这条线的第二份拷贝。
3. **轮次是"真的跑过一次"，不是版本号。** 每跑一次 `verify` 就 +1，`newRed / stillRed / fixed / notRun / gone` 五类差是它买来的东西。手维护的版本号没人能对上任何一次改动。

**闸门**（`whyPrototypeIsNotSettled`，一处规则、四个读者）：`status` 打印它、`export` 默认点名它、`export --strict` 用它拒绝、生成器 prompt 让 critic 节点照它产出 verdict，工作台详情页的「交付」区块把它列成第一屏的结论。三类各自是不同动作，因此**不合成一个数字**：需求没人实现 / 异议没人回应 / 上一轮 check 红。另加两条：PRD 声明了 check 却从没跑过，也算未决——"没红"与"没看过"必须分得开；服务声明了假响应而盘上没有，也算未决——那条路由被跳过，收到的人拿到的是一个打向他没有的后端的请求（§21.5）。措辞只有一份：闸门与页面问题都以 `code + params + text` 走（`notices.ts`），面板按 `code` 翻译、把 `text` 作为"与 agent 同一句"的记录留在旁边，所以界面说的是读者的话，而 agent 引用的仍是同一句英文。

**DAG 侧**：`producer → critic → when: verdict === 'fail'` 回到 producer。用到的全是 3.4/3.6 已落地的机制（`outputs:` 契约、`when:` 分支、`writes:` 身份、repair 回路），**没有新机制**——这一节只是给那条回路补上它要读的产物。

**没做的、以及为什么**：`frames` 里的图仍不进包（刻意的，不是欠账）；盘上没有"谁写了哪个补丁"的运行记录（第 6 条）——写前守卫本来就看得到每一次写，顺手记账即可，等前面这几样稳了再说；`dist/**` 仍是控制面（写它的是一族工具，`tooling.by` 放不下这个名字）。

**已知边界（本节发现、未修）**：`coverage` 的"实现了哪条需求"只认 pages / patches / findings 三个来源，**契约 fragment 不是来源**——一条只由契约满足的需求（`check: endpoint …` 全绿、但没有页也没有补丁指向它）会被读成"没人实现"，从而挡住 `--strict`。要修就得让 `services/*/paths/*` 也能带 `@requirement` 标记；这属于 coverage 的来源扩展，不在本节范围内。

**状态**：全部落地（`reviews.ts` / `acceptance.ts` / coverage 归并 / prompt 读接口 / verify 跨轮 / 状态与导出的闸门 / 生成器 prompt）。

---

## 4. 目录与数据模型

```
{workspaceRootPath}/prototypes/{slug}/
  ├─ config.json            【§13/§19】页表（每页 name / kind / url? / entry?）；控制面独占
  ├─ _layout.html           【可选】scratch 页的共享布局，一个插槽（§19.2）
  ├─ cart.html              顶层每个 *.html 都是这个原型的一页（scratch，文件名即页名）；**创建时不预置**，首稿由 agent 写，或由列表「复制」而来
  ├─ patches/               每 patch 一个文件，append-only + 唯一命名
  │    ├─ A-001-btn-radius.css       根 = 每一页都重放（共享）
  │    └─ cart/B-002-flow-guard.js   子目录 = 只在这一页重放（§19.4）
  ├─ services/              服务契约（mock 的真源，阶段 5）
  │    └─ {serviceSlug}/
  │         ├─ config.json          baseUrl / authType / title
  │         ├─ paths/               按端点拆的契约 fragment（`contract` 写）
  │         ├─ openapi.yaml         【合成】控制面由 paths/ 生成，勿手改
  │         └─ fixtures/            `data` 写
  └─ dist/                  交付物（按角色分化）
       ├─ extension/           【§17】一个可加载的扩展：manifest / README / 补丁产物 / 脚本；scratch 另含每一页与它被提取出来的产物
       ├─ static/              【§17.8】每页一份自包含 HTML（只有 scratch 页有；打开即看，什么都不用装）
       ├─ bookmarklet.html     【§17.9】live 页的改动做成可拖拽书签（只有 overlay 页有；不能装扩展时的那条路）
       ├─ dev-spec.md          给实现的人——改了什么
       ├─ openapi.yaml         后端——契约
       ├─ contract.md          后端——交接文档（含"未声明项"清单）
       └─ fixtures/            后端/CI——响应样例
```

**没有落盘的索引**：索引是**内存中按需派生**的，不落盘。`scanPrototypePatches()` 每次扫描 `patches/` 目录，返回：

```ts
{ file: 'A-001-btn-radius.css', kind: 'css', writer: 'A', order: 1, page: null, source: '…', targets: ['.pay-btn'], key: 'prototype:checkout-flow:A-001-btn-radius.css' }
```

派生规则：kind 由扩展名决定，writer / order 由文件名 `{writer}-{nnn}-…` 解析，`page` 由目录决定（`patches/cart/…` → `cart`，根 → `null` 即共享），排序 = 折叠层最后 → 序号 → 路径。不符合命名的文件直接忽略。

设计要点：

- **patch 与契约 fragment 都是普通文件**，可 git diff、可被 agent 的 `Read`/`Edit` 直接改、可被外部工具处理。这是"最大化本地文件系统优势"的落点。
- **派生索引消除争用**：没有任何共享索引文件需要手写或合并，因此没有写者会争它（D12）。这也是阶段 6.2 已被提前满足的原因。
- **契约是唯一真源**（阶段 5），`openapi.yaml` 是从 fragment 合成的产物；mock 只是契约的运行时物化。

---

## 5. 现有可复用资产（已核对）

### 浏览器与文件通路

| 能力 | 位置 | 状态 |
|---|---|---|
| 浏览器面板（BrowserView + CDP） | `apps/electron/src/main/browser-pane-manager.ts` | 已有 |
| CDP 封装 `BrowserCDP` | `apps/electron/src/main/browser-cdp.ts` | 已有 |
| 任意 JS 执行 `evaluate` | `browser-pane-manager.ts` 的 `evaluate` | 已有，可直接注入 |
| 元素高亮 overlay 注入 | `browser-cdp.ts` 的 `renderTemporaryOverlay` | 已有，但临时，用完即清 |
| 元素标识 `@eN` ref | `browser-cdp.ts` 的 `allocateRef` | 已有 |
| selector 定位 | `browser-cdp.ts` 的 `getElementGeometryBySelector` | 已有 |
| 浏览器工具入口 | `packages/shared/src/agent/browser-tools.ts` | 已有，加命令即可 |
| 产物目录读白名单 | `packages/server-core/src/handlers/utils.ts` 的 `getWorkspaceAllowedDirs` | **已覆盖**（返回 `workspace.rootPath`） |
| UI 读文件 | `PlatformContext.onReadFile`（`packages/ui/src/context/PlatformContext.tsx`） | 已有 |
| 文件 RPC | `packages/server-core/src/handlers/rpc/files.ts` | 阶段 1 起有 `file:write`（另见阶段 1.3） |
| 目录监听 | `packages/server-core/src/handlers/rpc/sessions.ts` 的 `sessions:watchFiles` | 已有，但只盯 session 目录 |

### 服务契约层

| 能力 | 位置 | 为什么能直接复用 |
|---|---|---|
| `Source` 抽象 | `packages/shared/src/sources/types.ts` 的 `SourceType`（`'mcp' \| 'api' \| 'local'`） | **一个 API 服务 = baseUrl + auth + headers**，正是 mock 服务的形状 |
| API Source 配置 | `sources/types.ts` 的 `ApiSourceConfig` | `baseUrl` / `authType` / `defaultHeaders` / `testEndpoint` 开箱即用 |
| Source 落盘约定 | `sources/types.ts`（`sources/{slug}/config.json` + `guide.md`） | mock 服务直接就是一个 source 目录 |
| 动态 API 工具 | `packages/shared/src/sources/api-tools.ts` + `sources/types.ts` 的 `ApiConfig` | agent 能用**同一套工具**调 mock 与调真服务 |
| MCP server 构建 | `packages/shared/src/sources/server-builder.ts` | 从 source config 起服务，mock 同构 |
| OpenAPI 已是认可载体 | `README.md`（已经在讲"贴一份 OpenAPI spec 进来"） | 契约格式无需新发明 |
| 已有依赖 | mock **不需要新依赖** | 拦截由既有 CDP 封装提供（阶段 5） |

### 并线控制面（现成）

| 能力 | 位置 | 说明 |
|---|---|---|
| DAG 规格 | `packages/shared/src/tasks/schema.ts` | `nodes` / `depends_on` / `inputs` / `outputs` / `prompt` / `model` / `permissionMode` |
| **并行调度** | `packages/server-core/src/tasks/TaskRunner.ts` | 已是并行，非串行；`max_parallel` 默认 4 |
| 依赖图与就绪判定 | `validate.ts`、`TaskRunner.ts` | 无依赖或依赖已完成的节点并发派发 |
| 节点输出落盘 | `tasks/storage.ts` | `tasks/{slug}/runs/{runId}/nodes/{id}.json`，`atomicWriteFileSync` |
| 输出插值 | `refs.ts` | `${nodes.<id>.output[.<field>]}` / `${params.<name>}` |
| 派生会话 | `SessionManager.ts` 的 `spawn_session` | `parentSessionId` 级联，fire-and-forget |
| 多实例并发 | `factory.ts` | 每次 `new`，无单例 → 多会话 = 多 backend 实例 |
| 结构化输出 | `outputs.ts`（生产者）、`schema.ts`（`outputs:` 声明）、`refs.ts`（消费） | **已落地**：节点声明 `outputs:` → 派发时带契约 → 完成时归档 `params`；`.field` 引用必须有对应声明（校验层拦） |

---

## 6. 实施阶段

### 阶段 1：接线层（文件通路，无 UI）

目标：把"产物目录"变成 agent 与 App 都能读写的普通目录。

#### 1.1 产物路径工具
- 在 `packages/shared/src/workspaces/storage.ts` 新增 `getWorkspacePrototypesPath(rootPath)`、`getPrototypePath(rootPath, slug)`，与现有 `getWorkspaceSessionsPath` 并列。
- **无需改读白名单**：`getWorkspaceAllowedDirs` 已返回 `workspace.rootPath`（`utils.ts`），`prototypes/` 天然在允许范围内。

#### 1.2 agent 写放行（必须改）
- 现状：Explore 模式下 `Write`/`Edit` 仅放行 `plansFolderPath`、`dataFolderPath`、`prototypesFolderPath` 和 `allowedWritePaths`（`packages/shared/src/agent/mode-manager.ts`；其中 `prototypesFolderPath` 就是这一步加的那条例外）。
- 做法：照 `dataFolderPath` 的模式新增 `options.prototypesFolderPath` 例外；在注入 `dataFolderPath` 的同处一并注入（实施时定位注入点：`packages/server-core/src/sessions/SessionManager.ts` 与 session context `packages/session-tools-core/src/context.ts`）。
- 验证：Explore 模式下 agent 能 `Write` 到 `prototypes/{slug}/patches/x.css` 与 `services/.../paths/*.yaml`，且仍无法写到目录外。

#### 1.3 新增 `file:write` RPC
- `packages/shared/src/protocol/channels.ts`：新增 `file.WRITE = 'file:write'`（与既有 file/fs 系列并列）。
- `packages/server-core/src/handlers/rpc/files.ts`：新增 handler，沿用 `validateFilePath(path, getWorkspaceAllowedDirs(workspaceId))` 的既有写法，**并额外约束在 prototypes 目录内**。
- `apps/electron/src/transport/channel-map.ts`：新增 `writeFile: invoke(RPC_CHANNELS.file.WRITE)`（`buildClientApi` 会据此自动暴露到 `window.electronAPI`）。
- `packages/ui/src/context/PlatformContext.tsx`：新增 `onWriteFile?: (path: string, content: string) => Promise<void>`（与 `onReadFile` 并列）。
- 验证：renderer 能落盘；写 `prototypes/` 之外被拒。

#### 1.4 产物目录监听
- 现状：`sessions:watchFiles` 只 watch session 目录，`fs.watch({recursive:true})` + 100ms 防抖 → 推送 `sessions:filesChanged`（`sessions.ts`；通道定义在全仓协议 `protocol/channels.ts`）。
- 做法：把监听目标泛化为"白名单内任意目录"，或新增 `prototypes:watch` / `prototypes:changed` 通道，复用同一套防抖与推送逻辑。
- 注意：现有实现会忽略隐藏文件与 `session.jsonl`（`sessions.ts`），产物目录需保留该过滤或调整。
- 验证：外部改动 `patches/*.css` 或 `paths/*.yaml` 都能收到变更事件。

**阶段 1 完成标志**：能用 `file:read` / `file:write` 读写产物目录，且改动会推送变更事件。全程不涉及 UI 与浏览器。

---

### 阶段 2：P0 拾取器（已完成）

目标：在页面里点选元素 → 高亮 → 得到一个稳定 selector。

#### 2.1 `BrowserCDP` 新增拾取能力
- `apps/electron/src/main/browser-cdp.ts`：`pickElement(options?)` + `cancelPicker()`。
  - **实现形态**：单一 `pickElement()`（注入 → 短轮询 → 清理），不做一对 start/stop 方法——一次 `Runtime.evaluate` 不能长时间挂起，否则会被 CDP 的空闲 detach 打断。
  - **后来加的常驻模式**（§12.7 第五轮）：工具栏要的是"开着就一直在"，于是拆成 `armPicker()`（注入并留在那里）＋ `drainPicker()`（读走并清空），`pickElement()` 退化成两者之上的循环；agent 的 `browser_tool pick` 仍然一次一个。
  - 注入脚本把结果写进 `window.__craft_agent_picker_state__`（`pending` / `picked` / `cancelled`），轮询读取；`Escape`、超时、`cancelPicker()` 三条取消路径统一走 `cancelled`。
  - 高亮复用 `renderTemporaryOverlay` 已跑通的"注入 fixed 覆盖层"模式（`pointer-events:none`），改成可交互版本。
  - `buildStableSelector(el)`：`data-testid` → `id` → 否则 `:nth-of-type` 路径（最多 6 层），与现有 `@eN` ref 体系互补。
- 说明：走 CDP 注入，`sandbox:true` + `contextIsolation:true` 下即可运行，**不改任何权限**，也不受页面 CSP 影响。
- **约束（D15）**：拾取器只回传事件，**不写文件**。

#### 2.2 贯通到工具命令
- 结果类型 `PickedElement` 定义在 `packages/shared/src/protocol/dto.ts`（**单一真源**，避免在 picker / 能力协议 / 工具命令三处漂移）。
- `browser-pane-manager-interface.ts` 的 `IBrowserPaneManager`、`browser-capability.ts` 的 `BrowserCapabilityMethod`（`pickElement`）、`RemoteBrowserPaneManager`、`NullBrowserPaneManager`、electron 的 `BrowserPaneManager.pickElement` + `dispatchCapability` 全部补齐（远程路径沿用 `getAllowRemoteEvaluate` 开关，错误码 `BROWSER_REMOTE_PICK_BLOCKED`）。
- `browser-pane.ts` 的 `BrowserPaneFns` 加 `pick`；`browser-commands.ts` 加 `pick [--timeout <ms>]` 命令分支与 `browser-tools.ts` 的 `--help` / 描述条目（当时三者还都在 `browser-tools.ts` / `browser-tool-runtime.ts` 里）。
- `SessionManager` 把 `pick` 接到 `bpm.pickElement(instanceId, options)`。
- 文档与发布说明同步：`docs/browser-tools.md`、`release-notes/next.md`。

**阶段 2 完成标志**：`browser_tool pick` 能在页面上点选到元素并返回稳定 selector。（真实页面的往返验证需在运行中的 Electron 里做；本阶段已用单测覆盖注入脚本语法 + 轮询/取消协议 + 命令路由。）

---

### 阶段 3：持久注入与 patch（已完成）

目标：改动能叠加到真实页面、**reload 后仍保留**，并以文件形式落盘。

#### 3.1 持久注入原语
- `apps/electron/src/main/browser-cdp.ts`：`addInitScript(key, source)` / `removeInitScript(key)` / `listInitScriptKeys()`，底层是 CDP `Page.addScriptToEvaluateOnNewDocument`。
- **实现形态**：css 与 js **都走 init script**（css 补丁由脚本自己创建/更新 `<style>`），没有 `injectStyle`——注入的 `<style>` 元素不随 reload 保留，init script 会，统一后"reload 重放"只有一条机制。
- **两处必须的配套**（都是会话级状态，缺一条"reload 保留"就静默失效）：① CDP 的 init script 注册**随 debugger 分离而失效**，所以有注册时不能空闲 detach（`holdsSessionState()` 判据，`detach()` 同步清空键表）；② 注册前要**开 Page 域**（`Page.enable`，`enablePageDomain()`）——域关着时 `Page.addScriptToEvaluateOnNewDocument` 照样返回 identifier，但注册是惰性的，新文档里一次都不跑。踩坑记录见 [开发文档](prototype-workbench-dev.md) §3.1。
- `key` 由调用方指定，重复注册同一 key 会**先移除旧的**（替换语义），所以重放是幂等的。

#### 3.2 patch 索引与重放
- **不落盘索引**：`packages/shared/src/prototypes/storage.ts` 的 `scanPrototypePatches()` 每次从 `patches/` 目录重算索引（派生索引 D12 从第一天生效，阶段 6.2 因此已提前满足）。
- 命名约定 `{writer}-{nnn}-{name}.{css|js}`，可位于 `patches/` 根（共享）或 `patches/<页名>/`（只那一页，§19.4）；**不符合命名的文件被忽略**（README、编辑器备份、`.DS_Store`），不会误当 patch 执行。排序 = 折叠层最后 → 序号 → 路径，完全确定，不依赖目录列举顺序。
- `packages/shared/src/prototypes/patch-script.ts` 的 `buildPatchInitScript()` 做 patch → init script 的纯变换：css 生成"创建/更新 `<style>`"的脚本（document-start 时 `head` 可能不存在，回退到 `DOMContentLoaded`）；js 包进 IIFE + `try/catch`，一个坏 patch 不会中断其余。
- 重放流程（`SessionManager` 的 `applyPrototype`）：扫描 → 先按前缀清掉磁盘上已删除的 patch 的 key → 逐个 `addInitScript`（面向未来文档）+ `evaluate`（立即作用于当前文档，**复用同一份变换**，所以 live 与 reload 行为一致）。不需要新的 reload 能力。

#### 3.3 两条写入路径（D4 + D15）
- **确定性改动**：renderer → `onWriteFile` → `file:write`（阶段 1 已通）直写 `patches/`。实时、无需 LLM。
- **语义改动**：交给 agent 的 `Write`/`Edit`（依赖 1.2 放行）写出新 patch。
- 两条路径产出同构文件，均由 3.2 重放。**两者都不由 renderer 直接写**（D15）。
- 说明：本阶段只交付了机制与通道。**至今没有任何 UI 触发 `file:write`**——第五轮起"编辑只走对话"（§12.4）成了明确约束，补丁只有一个来源（agent 写），所以直写路径不是"待接上"，而是**有意不用**；通道留着给控制面自己的确定性写入。

**阶段 3 完成标志**：手动改一个 patch 文件 → 重放即生效；reload 后改动仍在。

---

### 阶段 4：导出器（已完成）

目标：`dist/` 下产出按角色分化的交付物。

#### 4.1 自包含 HTML + 变更说明
- `packages/shared/src/prototypes/export.ts`：`buildSelfContainedHtml()`（纯变换）、`buildDevSpec()`（纯变换）、`exportPrototype()`（落盘）。
- patch 内联：
  - **css** 直接内联成 `<head>` 里的一段 `<style>`。纯文本 patch 没有可"执行"的东西，内联文本与 live 注入器做的事完全等价，而且 JS 关掉也照样生效。
  - **js** 走 `buildPatchInitScript()`——**和 live 重放同一份变换**，所以"工作台内"与"导出文件"行为不会分叉。
- 注入位置：css 插在最后一个 `</head>` 前（无则退 `</body>`，再无则追加）；js 插在最后一个 `</body>` 前。顺序沿用派生索引顺序。
- `dist/dev-spec.md`：列出每个 patch 的序号/writer/kind/字符数表格 + 逐条完整内容（代码围栏长度按内容里的反引号最长连续串计算，避免被内容撑破）。
- **未做**：dev-spec 只列**真实已知**的信息（每条 patch 的序号 / writer / kind / 字符数 / 全文），不编造"target selector + 前后差异"那类需要 patch 元数据的东西。要补得先定 patch 元数据格式。
- `exportPrototype()` 在**没有任何可导出的一页**（页文档不在、也没法渲染）时**明确报错**，而不是导出一个无意义的文件。

#### 4.2 预览通道：复用浏览器面板
- 现有 HTML 预览 iframe 禁脚本（`MarkdownHtmlBlock.tsx`、`HTMLPreviewOverlay.tsx`），所以原型不能走它。
- 但**浏览器面板本身就是真实引擎、能跑 JS、已沙箱隔离**，直接打开产物即可，不必新搭一条渲染通道：零新增 UI、渲染环境与工作台一致，且不改动现有预览块的安全策略。
- `export` 因此返回可直接使用的 URL；那个地址的 origin 由 Electron 应答的 `http` 提供（§16）。

**阶段 4 完成标志**：`dist/extension/`（§17 起交付物是扩展包；其内每一页都已构建好、可独立打开）；`dist/dev-spec.md` 能让人看懂改了什么。

---

### 阶段 5：服务契约层（mock 就是服务）— 已完成

目标：把 mock 从"拦截技巧"升级为契约层，同一份契约同时服务前端原型与后端交付。

#### 5.1 契约真源与合成（已完成）
- 真源 = `services/{svc}/paths/*.yaml`（fragment，agent 写）+ `services/{svc}/fixtures/*.json`（数据）+ `config.json`（`baseUrl` / `authType` / `title`）。
- `packages/shared/src/prototypes/contract.ts`：
  - `parseContractFragment()` **同时接受两种写法**：显式 `paths:` 块，或直接以 `/…` 作顶层键（人们实际会写的简写）。另支持 `components.schemas` 与 `x-contract` 备注块。
  - `composeContract()` 合并 fragment → 单个 OpenAPI 3.1 文档。`$ref` 在合并后仍成立，所以 fragment 之间可以互相引用 schema。
  - **重复路径不静默丢弃**：后写的 fragment 生效，同时把该路径记入 `conflicts` 并报到命令输出里。
  - `x-mock.fixture` 引用不存在的 fixture 时记入 `missingFixtures`。
- 解析用 `yaml`（`packages/shared` 的**既有依赖**），**没有引入任何新依赖**。
- `resolveContractServiceSlug()`：显式 `--service` > 唯一服务；多个服务时不猜，**报错并列出候选**（猜错比报错更糟）。

#### 5.2 mock 物化（已完成）
用 CDP `Fetch` 在**网络层**兑现响应（D8）：`Fetch.enable` + `Fetch.fulfillRequest`——fetch / XHR / 任意资源类型全都覆盖，**应用一行不改**，也不往页面里塞 monkey-patch。（另外两条路——页面级 monkey-patch、独立 Node mock server——及其否决理由见 [开发文档](prototype-workbench-dev.md) §4。）

实现要点：
- `BrowserCDP.setFetchMockRoutes(program)` / `clearFetchMock()`：开启 `Fetch.enable`（`requestStage: 'Request'`），在 `Fetch.requestPaused` 事件里决定 `fulfillRequest` 还是 `continueRequest`。传的是 **program**（路由 + store），不是一张路由表——状态化那半见 §5.3。
- **匹配只按 pathname**，而且规则只有一处（`mock-engine.ts` 的 `matchMockRoute`）：整段匹配，不中再按路由自身的段数匹配尾部——绝对 URL、带 `baseUrl` 前缀的 URL、同源相对路径三种写法都能命中，而段数是上界（`/reorders` 不会命中 `/orders`，`/api/cart/items/{id}` 也不会吞掉更长的路径）。见 §5.3。
- 兑现的响应**带 `access-control-allow-origin: *`**：否则跨域接口即使由我们应答，仍会被浏览器按 CORS 拦掉。
- **异常兜底再 `continueRequest`**：一个永远挂着未决断的请求会让页面直接卡死，这条比"mock 失败"严重得多。
- `Fetch.enable` 同样是 CDP 会话状态 → 纳入阶段 3 那个 `holdsSessionState()` 判据（有 init script 或开着 mock 就持有连接，避免空闲 detach 把它悄悄关掉）。
- `buildMockRoutes(service)`（纯函数）：`x-mock.fixture` 指向不存在的 fixture 时**跳过该路由并上报**，而不是返回空 body——静默的空响应比"请求打到真后端"难查得多。
- 命令：`mock-apply <slug> [--service <svc>]`、`mock-clear`。

#### 5.3 mock 状态化（已完成 — D9 的后置部分）

目标：演**多步流程**（加购 → 结算 → 下单），而不是每一屏都从同一份 fixture 重新开始。

**格式决定：语义由 HTTP 方法推导，不造迁移语言。** 路径项声明它属于哪个集合（`x-mock-collection: cart.items`），起始状态写在 `services/{svc}/state.json`。于是"加购"不需要作者学任何新语法：

| 方法 | 作用 |
|---|---|
| `GET` | 读 —— 路径是集合就是集合，带尾部 `{param}` 就是那个元素 |
| `POST` | 把请求体追加进集合 |
| `PATCH` | 把请求体并入集合或元素 |
| `PUT` | 用请求体替换 |
| `DELETE` | 按尾部 `{param}` 删掉那个元素（只有元素路径有） |

五条规则（写给人看的那份在 `apps/electron/resources/docs/prototypes.md` § Faking a flow，它是 agent 读的指南）：

1. **表达不了的操作用读契约时就报错**（集合上的 `DELETE`、元素上的 `POST`、中间带 `{param}` 的路径）——与"不支持的 check kind 在解析期报错"同一条规矩，**不给它造一条看起来合理的路由**。
2. **读答所寻址者，改答集合的当前值**：刚加购 / 删掉的那个屏幕，下一步要画的是列表。
3. **元素不在 = 404**；**操作与 store 形状矛盾 = 500 并说明**——那是 mock 自己的 bug，不能长得像应用的 bug。
4. **`x-mock.fixture` 仍然优先**：要答别的东西（回执、错误形状）照旧写 fixture。
5. **store 只在内存里，`state.json` 从不回写**：一次 apply 一次运行，再 apply 就是重放；这也是让演示可复现的那条。

**代价要认（一份规则两处实现）**：工作台在网络层用 TypeScript 兑现（`mock-engine.ts`），交付载体只能在页面里兑现（`extension.ts` 的 `buildMockEngineScript()`，扩展的 `mocks.js`、静态单文件与书签共用同一份）。防漂移的办法不是"小心一点"，而是 `__tests__/mock-engine.test.ts` 把**同一张流程表跑过两边**再逐条比对答案。

**匹配规则顺手统一了**：此前工作台是 `endsWith(path)`、页面里是 `=== path`——同一份契约两种行为。现在两边都走共享引擎：整段匹配，不中则按路由自身的段数匹配尾部（`baseUrl` 前缀照旧命中），而且段数是上界，`/api/cart/items/{id}` 不会吞掉 `/api/cart/items/i-1/extra`。

**踩到并修掉的一个陷阱**：状态化路由的响应体**必须是快照**。第一版把 store 里的对象直接交出去，于是"已经发出的响应"会被紧接着的请求改写——测试里表现为第一次 GET 的答案在断言时已经变成第三次 GET 的答案。

#### 5.4 后端交付导出（已完成）
- `exportContractDeliverable()` 写 `dist/openapi.yaml`（合成结果）+ `dist/contract.md` + `dist/fixtures/*.json`。
- **"契约 ⊃ mock" 的落地方式**：`contract.md` 除了列出端点与已声明的错误响应，还**显式点名"没声明的东西"**——错误语义（没有任何非 2xx）、鉴权（`config.json` 无 `authType`）、契约备注（没有 fragment 带 `x-contract`，即分页/排序/幂等/并发均未记录）。这比编造字段诚实，也正好是后端接手前必须补齐的清单。
- 命令：`contract-compose <slug> [--service <svc>]`、`contract-export <slug> [--service <svc>]`。

**阶段 5 完成标志（已达成）**：契约能从 fragment 合成 `openapi.yaml`；产出后端可用的 `dist/openapi.yaml` + `contract.md` + fixtures；mock 能在原型里跑通（fetch 与 XHR 都覆盖，应用无需改指向）。

---

### 阶段 6：平面分离与并线接线 — 6.1 与 6.4 均已落地，6.2/6.3 由前序阶段提前完成

目标：让多个写者能安全并行写产物，用**所有权**而非锁保证正确性。

#### 6.1 所有权判据落地（已完成）
- `packages/shared/src/prototypes/ownership.ts`：把 §3.5 的边界写成**可执行判据**，而不是文档里的一张表。
  - `classifyPrototypePath(rel)` → `{ owner: { kind: 'writer' | 'control-plane' | 'tooling' } }` 或 `{ violation }`；**只登记有规矩的路径**，其余兜底控制面。
  - **patch 的 owner 由文件名里的 writer 决定**（不是固定规则）——这正是"任何 writer 都能追加自己的 patch、零争用"的前提。
  - `canWriterWrite(rel, writer)` → 严格原语；**执行的那条是 `whyWriterMayNotWrite(rel, writer)`**（拒绝时给出理由，控制面路径放行）。
  - `resolvePrototypeOwnership()` 遍历目录，跳过隐藏文件，产出违例清单。
- **取证到的真实价值**：它会抓出三类此前静默存在的问题——writer 前缀未声明的 patch（`patches/Z-…`）、命名不合规的 patch（`patches/oops.css`）、服务目录里的杂文件（`services/*/random.txt`）。这类文件以前会被 patch 扫描或契约读取**静默忽略**，现在会被点名。
- `status <slug>`：控制面视角的只读报告 —— 页表与 `pageIssues`、每条补丁的页 / `@target` / 指纹、每个服务的端点/mock 覆盖/fragment/fixture 数、需求线与 `briefIssues`、`dist/` 的交付物清单、以及所有权违例。纯文件检查，不解析浏览器实例。

#### 6.2 派生索引（阶段 3 已提前完成）
- 结论是**比原方案更进一步**：不落盘 manifest，索引每次从 `patches/` 重算（`scanPrototypePatches`），所以不存在"索引与磁盘不一致"这个状态，也就没有重建时机的问题。

#### 6.3 契约 fragment 化 + 合成（阶段 5 已提前完成）
- `services/{svc}/paths/*.yaml`（`contract` 独占写）+ 控制面合成 `openapi.yaml`（`writeComposedContract`）。合成是控制面的独占写，无需锁。

#### 6.4 挂接 Tasks DAG（已落地：身份是绑定键，写前守卫按身份判）

原计划把"工作台任务 = 一个 TaskSpec、一个平面 = 一个 node"接起来，随后**按触发条件推迟**（写冲突已由派生索引 / append-only 补丁 / fragment 化契约 / 所有权矩阵消掉；单用户单 agent 时接 DAG 只多一层生命周期）。触发条件到齐之后（结构化输出已落地、Conductor 已上线、浏览器侧标签级归属已对齐），这一节**已按它当初写的形状落地**：

```
node 声明 writes: checkout-ui      ← spec 字段，与 outputs 同层；校验同一 run 内唯一
  → child session.taskWrites       ← 派发时盖章（TaskRunner.dispatch，复用 taskNodeId 那条路）
  → <prototype_context writer="checkout-ui">   ← agent 读到的第一行就是"我以谁的身份写"
  → whyWriterMayNotWrite(path, writer)         ← 写前守卫（PreToolUse 第 5d 步），拒绝时给出理由
```

**为什么绑定键是写入身份、而不是平面字母**（§3.4 的校正）：node id 活在**一次运行的 spec 快照**里，而补丁活在**产物**里——把两者做恒等，图重排一次，历史补丁的 owner 就成了一个不存在的节点名。前缀因此只是**命名空间租约**（"这正是我写的"），不是顺序键。

**这一轮补的是它缺的那点东西——证据**（机制早就在跑，但没有任何测试证明它跑得对）：

- `schema.test.ts`：`writes:` 的三条拒绝——不可用的 id（`ui-2` 会让补丁名解析回歧义）、保留 token `Z`（只有折叠时写）、**同一 run 内重复**（大小写不敏感）；以及两个不同身份被接受。
- `TaskRunner.test.ts`：**盖章那一步**（节点声明 `writes:` → 子会话 `taskWrites`；不声明就什么都不盖——"缺省即单写者"是 `resolvePrototypeWriter` 的判断，不该在这里替它写 `main`）。
- `TaskRunner.test.ts`：**两个写者同时在飞，各自带自己的身份**——两个节点都在对方完成之前派发（那是并发，不是排队），两个子会话拿到的 `taskWrites` 互不相同，运行在两个都完成时才结束。补丁文件的隔离由这一对保证：**每个写者一个前缀**（撞车在 validate 就被拒）+ **写前守卫拒绝声称别人前缀的名字**（§3.6）。

**边界要说清（并发安全的范围就是这么大）**：守卫拦的是**产物撞车**——别人的补丁、别人的契约 fragment / fixture / state，以及无人拥有的路径（拼错的补丁，注入器会静默忽略它）。**控制面文件是放行的**（页文档、`config.json`、`PRD.md` 与同层的其它 `.md`、`dist/`），因为控制面就是 agent 自己，拦掉它会把"盖一个原型"这个最常见的情况一起拦掉。于是并行运行有一条必须遵守的规矩：**共享文件只由一条线写**——要么把页文档 / 配置 / PRD / dist 收给一个节点，要么每节点各有自己的页。两个节点同时改同一页是**没有任何守卫的**竞态，这一点写进了生成器 prompt（它现在会据此避免生成这种图），也写在这里。

**仍然不做**：`parallel` / `map` / `verify` / `aggregate` 等非 `session` 节点种类只解析不执行（用 `session` 节点模拟，§3.4）；Conductor 不替节点开标签页、也不替它分配标签页（理由见上一轮与本文件 §22 末尾——最硬的一条是预开标签页会把每次 DAG 运行绑在"这台机器有浏览器"上）。

> **（触发它到齐的那一轮，记录在此）**：DAG 落地之后，并行 agent 有了**共享同一个工作区浏览器窗口**的实际需求——而这套窗口模型是**顺序驾驶**长出来的（窗口级租约 + 单槽 overlay），并发下会互相顶掉。浏览器侧的对齐见 §22 的「标签页是并行的工作单位」一轮：标签级占用（`heldBy`）、`tab-assign`、子会话不动人的视线。文件侧的并发（写冲突）仍按上面三条，不受影响。

> **标签页由谁给节点开？——不做自动开标签页**（用户定："先放着"，2026-09-16）：Conductor **不**替节点开标签页、也**不**替它分配标签页；节点要浏览器就自己 `tab-new`，隔离由 §22 的归属保证（一个标签页一个主，重跑可达同节点那个标签页）。三条理由，按严重度：① **最硬的一条**——预开标签页会把每一次 DAG 运行绑在"有浏览器"上：无头服务端或桌面客户端未连接时 `createTab` 抛 `BROWSER_NO_CAPABLE_CLIENT`，而 `TaskRunner.dispatch` 的 catch 会把它变成 `failNode('dispatch failed: …')`，于是一个只改文件的节点会因为**这台机器上没有浏览器**而失败；要兜住就得吞掉异常，而"试了但没关系"是坏信号。② `ConductorSessionHost` 今天**没有任何 browser 面**（只有 session / message / kanban / cancel），自动分页要在这个有意的抽象上开洞。③ 预开 `about:blank` 没有价值，预开真实地址要么让 runner 解析节点 prompt（脆），要么在 spec 里给节点加字段——那是新设计，不是"顺手接线"。`run` 结束时**自动关标签页同样不做**：那些标签页可能正是人跑完要看的产物。触发条件见 §22 那一轮末尾。

#### 6.5 拾取器是传感器（D15，设计上已满足）
- 拾取器只回传事件（`pick` 返回 selector/矩形，不写文件）；写盘一律由控制面（`file:write` RPC）或 agent 的 `Write`/`Edit` 执行。
- 因此 renderer 侧不存在写文件调用 —— 这是 D15 要求的实际形态。

**阶段 6 完成标志（已达成）**：所有权判据可执行且能抓出越界与命名违规；`status` 能给出项目全貌；patch 与契约的写入天然无争用（派生索引 + append-only + fragment 化）；**两个写者并发跑**——节点以它声明的写入身份写产物（§3.6），派发时盖章（`TaskRunner.test.ts`），两个身份撞车在 validate 就被拒、写别人的前缀在写前被拒（`schema.test.ts` / `ownership.test.ts`）。守卫的范围（产物撞车，不含默认归控制面的文件）见 6.4。

---

### 阶段 7：放开面 / overlay 改写 / 无中生有 — 两项已完成，放开面决定不做

**明确区分两类不同需求**：

| | 需求 | 机制 | 状态 |
|---|---|---|---|
| (a) | 模拟**尚不存在**的接口 | 契约 + mock runtime | ✅ 阶段 5 |
| (b) | 改写**已存在**的真实后端返回 | CDP Fetch 拦截 | ✅ **阶段 7，靠阶段 5 的机制自然获得** |

#### 已完成：无中生有入口（`open <slug>`）
- "无中生有"**不需要新机制**：agent 从阶段 1.2 起就能写 `prototypes/{slug}/cart.html`，浏览器面板一直能打开它。缺的是入口体验——`resolvePrototypeEntry()` 决定"这个原型的页面在哪"，**答案只有一个：它的 origin**（宿主把我们自己的页 + 该页生效的 `patches/` 渲染出来；overlay 页则是它自己的在线地址）。没有页面时**明确报错并点名该怎么拿到一页**，绝不拿交付物顶替（§16.3）。
- 命令 `open <slug>` 复用既有的 `navigate`，没有新增导航能力。**「能不能打开」由 `PrototypeStatus.pageAvailable` 驱动**（入口页是 overlay → 它自己有地址；是我们自己的页 → 有宿主且那份文档在，§19.3），详情页据此禁用「预览」，并有测试逐组合断言它与 `resolvePrototypeEntry` 不漂移。
- 这些 RPC 的错误文案是**写给 agent 的**（点名缺什么、附绝对路径）；页面下方那条 kind-aware 的告警才是给人的引导。
- **详情页只有三个动作**：看（预览）、改（在对话里改）、交（导出给开发）。唯一的例外长在数据上——**Pages 区块**里 overlay 页的地址可就地改（页行右侧的 Globe 按钮，§13.2.1），因为那是**数据本身可编辑**，不是又一个动作入口。
- 这条收敛的理由值得记住：**被删掉的入口回答的都是"机器需要什么"，不是"用户想要什么"**；登录、看 DOM、开一个窗口这类准备与排错交给 agent 的 browser 工具（它与原型窗口共用 `persist:browser-pane`，所以准备阶段登录一次即可）。
- 打开动作曾报过一次 `about:blank` 加载失败（错报在回退上，不是那次导航）——踩坑记录见 [开发文档](prototype-workbench-dev.md) §3.3。
- **空状态不再指向按钮名**：没有页面时，告警卡说的是"说一句你要做什么"，而不是"按某个按钮"。这条告警**只会出现在 scratch 上**：overlay 的地址在创建时就是必填（§13.2），所以它不会缺页面

#### 已完成：准备工作下放给 agent

按钮删掉之后，"参考一个页面"这条路改由 agent 承担：**在看什么**是 `PRD.md` 旁边的一份材料（§14 的修订），**起点**是列表的「复制」（§13.1.1）——两者都不再需要"往当前原型里搬材料"这种命令。

**base 按类型分**（§13.1）：

| | 页面是什么 | 补丁打在哪 | 交付什么 |
|---|---|---|---|
| **overlay** | **那个在线 URL 本身**（有 JS、有登录、有真数据） | 活页面，`apply` 注入进去 | patches + dev-spec（写明改的是哪个地址） |
| **scratch** | 我们自己写的那份文档（`<页名>.html`） | 我们自己的文档，宿主渲染时内联 | 扩展自带这一页 + dev-spec |

于是在线 URL 的用途收敛成两件事：**竞品调研**，以及**分析要 patch 哪个 DOM**（browser 工具的 `snapshot` / `evaluate` 就够）——它**不必变成文件**。"准备好之后进原型窗口还是登录着的"靠的是所有 browser 窗口共用同一个 partition（`persist:browser-pane`）：准备阶段在那个窗口里登录一次，原型窗口打开同一地址就带着。

措辞也要跟着清（prompt、命令帮助、`create` 的提示）：只要留一句"让用户按某个按钮"，agent 就会去教用户按一个不存在的按钮。

#### 已完成：overlay 改写真实后端（无需新机制）
- 阶段 5 的 mock **匹配只按 pathname、与 host 无关**，所以一条 `/api/orders` 的路由会同样拦截 `https://api.production.example.com/api/orders`——"改写已存在的真实后端返回"与"模拟尚不存在的接口"是**同一个机制**，只是路由来源不同（有测试固定）。
- 因此**不需要**为响应体重写去碰 `webRequest`。真正仍需新机制的是"**只改响应头/状态码但保留真实 body**"（要在 `Fetch` 的 `Response` 阶段拦截），**未做**。

#### 已决策：放开面 partition（`webSecurity:false`）—— 决定**不开**
- 它买到的是"**页面脚本自己**跨域"的能力（免 CORS 发请求、读跨域资源），而**同样的能力从外部用 CDP 也能达到**（`Fetch` 兑现响应、`Runtime.evaluate` 在指定 frame 上执行）——四个诉求里三个已交付，剩下一个也用 CDP 能做。
- 代价却是**真实的、不可回退的安全弱化**：同源策略一关，该 renderer 里任何页面脚本都能读任意跨域响应；收益只是"省掉一层 CDP 封装"。
- **结论（用户已确认）：不开。** 全部能力改走 CDP，浏览器窗口的姿态从头到尾没变（§2 的 D5）。
- 若将来真撞到"CDP 做不了、必须页面 JS 自己跨域"的具体场景，再回到隔离设计（独立 partition + 无凭据 + 禁 `file://` + 风险提示）。

**阶段 7 完成标志（已达成部分）**：无中生有有了一等入口；改写真实后端返回可用且有测试固定；安全姿态未改动。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Explore 模式拦截写 | agent 写不进 `prototypes/` | `prototypesFolderPath` 例外（阶段 1.2，已落地） |
| 现有 HTML 预览禁 JS | 原型跑不起来 | 预览走浏览器面板（阶段 4.2）；origin 由 Electron 自己应答（§16） |
| 线上页面改版 / 登录态 | 页面变了而补丁还指着旧 DOM | D2：编辑走 overlay、交付走快照；`pages --change` 改地址时把代价说出来（§13.2.1） |
| 注入被页面 CSP 拦截 | 注入失效 | 工作台内走 CDP（高于页面 CSP）；交付侧走内容脚本（页面策略管不到） |
| 契约 ⊃ mock | 后端交付不完整 | 阶段 5.4 显式补齐分页/错误/幂等/鉴权等内容，并**点名未声明项** |
| 契约漂移 | 真后端实现后与契约不一致 | 用同一份契约做对照回归（`x-mock` 按 pathname 匹配，切真后端无需改代码） |
| OpenAPI 只适配 REST | 非 REST 产品套不上 | 若产品是 GraphQL/RPC 需另定格式（当前假设 REST） |
| PM 不写 YAML | 契约无人维护 | 契约由 agent 生成维护（D4 语义写通道） |
| **Fetch 拦截拖慢页面** | 所有请求都过主进程一轮 | 未在真实环境量过；若明显变慢，把 `Fetch.enable` 的 pattern 收窄到目标接口域（目前是 `*`） |
| **无锁导致静默丢数据** | 并发写同文件 last-writer-wins | 用所有权代替锁（§3.3）；单文件资源只由控制面写。真要做并发写之前先看开发文档 §3.8 |
| **写者边界被越写** | 所有权模型失效 | `whyWriterMayNotWrite` 写前校验 owner，越界拒绝并给出理由（阶段 6.1 / §3.6） |
| ~~Tasks 结构化输出未实现~~ **已落地** | 下游节点无法可靠消费上游产物 | `NodeOutput.params` 已实现：节点在 `outputs:` 里声明字段，派发时带上契约，完成时归档为 `params`；`when:` 分支条件即建立在此之上。原"接 DAG 之前先落地"的前置条件解除 |
| **patch 不回流源码** | 用户可能误以为改完就能应用回源码 | 这是**设计事实**而非缺陷：patch 是给开发的可执行规格，由人翻译；导出物承担"说清楚要改什么"的职责 |

实现层面的坑（CDP detach、渲染层导入边界、缺上游脚本、既有测试失败基线等）见 [开发文档](prototype-workbench-dev.md)。

---

## 8. 验收标准（MVP）

### UI 与文件通路

1. 在**任意真实页面**上（产品 dev server / 测试环境 / 线上均可，见 §1）能点选任意元素，拿到稳定 selector，重复点选结果一致。
2. 选中后做出的改动**立即反映在页面上**，并把 patch 落成 `patches/` 下的文件。
3. 手动编辑该 patch 文件，页面随之更新（`fs.watch` 通路有效）。
4. 刷新 / 重开页面，改动**依然存在**（patch 重放有效）。
5. `dist/extension/` 里的页面（§17）可独立打开并保留全部改动（scratch 的每一页都在包里）；`dist/dev-spec.md` 可读地说明改了什么。

### 服务契约层

6. 能合成一份 `openapi.yaml`，并让原型在浏览器内跑通（mock 由 CDP 在网络层兑现，**不起服务**）。
7. fetch 与 XHR（axios）两条路径都被 mock 答上，**应用代码一行不改**。
8. 把 mock 关掉后，原型无需其他改动即对接真后端（**同构验证**）。
9. `dist/openapi.yaml` 除了端点与 schema，还包含分页/错误/幂等/鉴权约定；未声明的部分在 `contract.md` 里被点名。

### 平面分离与并线

10. 两个写者并发写各自的产物文件，**互不覆盖**（人工构造并发写验证；靠 append-only 与所有权，不靠锁）。
11. **索引不落盘**：任何本地缓存被删都不改变"有哪些补丁"，它每次从磁盘重算。
12. 写者试图写不属于它的文件时被拒绝并有告警。**（已落地：§3.6 第 5 条把 `whyWriterMayNotWrite` 接进写路径，拒绝时给出理由——`pre-tool-use-checks.isolated.ts` 覆盖流水线；`status` 另有一条事后报告。拦的是产物撞车，控制面共享文件按 §6.4 的边界放行）**
13. 拾取器路径上不存在任何直接文件写（renderer 只发事件）。
14. 一个工作台任务能被表达为一个 Task，且 `depends_on` 生效；**节点以它声明的写入身份写产物**（§3.6 的六条），两个写者可以同时在跑而各自只写自己的前缀（§6.4，测试见 `TaskRunner.test.ts` 与 `schema.test.ts`）。

### 安全底线

15. 全流程不降低现有安全姿态：真实产品面仍是 `sandbox:true` / `contextIsolation:true` / `nodeIntegration:false`。

---

## 9. 实施顺序与依赖

```
阶段1.1 路径工具 ──┬─→ 阶段1.3 file:write ──→ 阶段3.3 直写落盘
                  ├─→ 阶段1.2 Explore 放行 ─┬→ 阶段3.3 agent 写入
                  │                        └→ 阶段5.1 契约维护
                  └─→ 阶段1.4 目录监听 ──┬─→ 阶段3.2 patch 重放
                                          └─→ 阶段6.2 派生索引重建
阶段2 拾取器（只依赖现有 CDP，可与阶段1并行）
                              ↓
                     阶段3 持久注入与 patch
                              ↓
                     阶段4 导出器
                              ↓
                     阶段5 服务契约层（5.1 依赖 1.2）
                              ↓
                     阶段6 平面分离与并线（6.1 已落地；6.2/6.3 由阶段 3/5 提前完成；6.4 触发条件到齐后已落地）
                              ↓
                     阶段7 无中生有入口 + 改写真实后端（放开面：决定不做）
```

- **硬阻塞**：阶段 1.2（Explore 放行）同时卡住阶段 3、5、6。已完成。
- **可并行**：阶段 2 不依赖阶段 1。
- **并线不新增调度器**：写冲突已由"派生索引 + append-only patch + fragment 化契约 + 所有权矩阵"消除；多 agent 调度复用 TaskRunner，身份与写前守卫见 §6.4。

---

## 10. 试用手册（端到端）

跑起 Electron 后，按下面的顺序走一遍，就能覆盖全部已交付能力。**前 5 步是核心闭环**，也是唯一没能在单测里验证的环节。

> **关于页面地址**：示例用 `http://localhost:3000/...` 只是占位。换成任何真实产品地址——dev server、测试环境、线上——步骤完全一样（依据见 §1：patch 对任何源页面都是覆盖层，dev server 没有特殊性）。

> ⚠️ **端口**：`bun run electron:dev` 会占用 **5173**（renderer 的 vite）。若你确实用本地 dev server，它要跑在**别的端口**（示例用 3000）；`electron-dev.ts` 启动时会**无条件 kill 掉占用 5173 的进程**。

> **关于 slug**：A–E 保留了显式 slug 的写法（便于照抄，也验证显式路径）。若会话已绑定该原型（§11 / 步骤 F），这些命令的 slug 都可以省略。

### A. 在真实页面上改（核心闭环）

> **前置**：先建一个原型，再给它加一个 **overlay 页**：`prototype_tool create Checkout flow`，然后 `prototype_tool pages --add checkout=<你的产品页面 URL>`（界面上是「新建页」→ 选「在已有页面上改」并填地址）。目标页就是**要打开的页面本身**（详情页「预览」直接开它、并把补丁注入进去），不改变 patch 的行为——patch 对任何源页面都是覆盖层。

1. `browser_tool navigate <你的产品页面 URL>`（示例 `http://localhost:3000/checkout`；线上地址同样成立）
2. `browser_tool pick` → 光标高亮跟随，点一个元素 → 拿到稳定 selector
3. 让 agent 写一个 patch：`prototypes/checkout-flow/patches/A-001-btn.css`
4. `prototype_tool apply checkout-flow` → 页面**立刻**变化
5. **手动 reload 页面** → 改动**仍在**（这是"持久注入"的验收点）

> 第 5 步是整条链路里最值得盯的一步：它依赖"CDP 注册不随空闲 detach 失效"，机制见 [开发文档](prototype-workbench-dev.md) §3.1。

> 产物落在 `~/.craft-agent/workspaces/<当前 workspace>/prototypes/`。当前会话属于哪个 workspace，`status` 里的 `dir` 会直接告诉你。

### B. 从零做一个原型（scratch 类型）

6. 建容器：对话里 `prototype_tool create Quotes flow`（或界面上新建一个原型）——它建出来的原型**没有页**，这是"还没有页"这句真话
7. 让 agent 直接写 `prototypes/quotes-flow/quote.html`：**顶层每个 `*.html` 就是这个原型的一页**（scratch，文件名即页名），不需要任何特殊命令
8. 想让根地址落在这一页上就 `prototype_tool entry quote`（不配的话根地址给的是生成的页索引），再 `prototype_tool open quotes-flow` 在浏览器面板里打开；之后按 A 的 3–5 加 patch

### C. mock 就是服务（契约 → 前端 → 后端）

9. 让 agent 写：
   - `prototypes/checkout-flow/services/checkout-api/paths/list-orders.yaml`（含 `x-mock.fixture`）
   - `prototypes/checkout-flow/services/checkout-api/fixtures/list-orders-200.json`
10. `prototype_tool mock-apply checkout-flow` → 原型有数据了（**fetch 和 axios 都覆盖**，应用不用改指向）
11. `prototype_tool contract-export checkout-flow` → `dist/openapi.yaml` + `dist/contract.md` + `dist/fixtures/`，把 `dist/` 交给后端
12. `prototype_tool mock-clear` → 请求打回真实后端。**代码一行不用改** —— 这就是"mock 与真服务同构"

> 想看 `contract.md` 有什么价值：故意只声明 200 响应、不写 `authType`、不写 `x-contract`，它会**点名这三处缺失**，正好是后端接手前必须补的清单。

### D. 交付与验收

13. `prototype_tool export checkout-flow` → 交付物落在 `dist/extension/`（§17），命令会打印它的路径与 **`http://checkout-flow-<hash>.localhost/dist/extension/<入口页>.html`** 地址（不再是 `file://`，见 §16）；有我们自己写的页时还会另写 `dist/static/`（§17.8），有 live 页时另写 `dist/bookmarklet.html`（§17.9）
14. `prototype_tool open checkout-flow` → 打开的是它的 **origin 根**：入口页（没配入口时是生成的页索引）加上这一页生效的补丁现算出来的页面，而不是某个文件
15. `prototype_tool status checkout-flow` → 全貌 + 所有权检查

### E. 故意制造一个所有权违例

16. 写一个 `prototypes/checkout-flow/patches/oops.css`（不符合 `{writer}-{nnn}-{name}.css`），再跑 `prototype_tool status checkout-flow` → 应该点名它"misnamed patch"

这条验证的是：**以前会被静默忽略的文件，现在会被抓出来**。

### 试用时重点观察

**开着 mock 时页面是否明显变慢**：`Fetch.enable` 目前用 `*` 匹配**所有**请求，每个都过主进程一轮。若明显变慢，把 pattern 收窄到目标接口域（`browser-cdp.ts` 的 `setFetchMockRoutes`）。

### F. 对话入口与绑定（§11 的验收）

17. 在原型详情页点 **Open conversation** → 进入一个已绑定该原型的会话（已有绑定会话时直接跳过去，不新建）
18. 在这个会话里说「应用补丁」——**不用提原型名**，agent 会执行 `apply` 并落到该原型
19. 对 agent 说「列一下有哪些原型」→ `list`，输出里当前绑定的那个标 **BOUND**
20. 点会话标题右侧的**烧瓶图标** → 切换/解绑原型；切换后 badge 立即变化（靠 `prototype_slug_changed` 事件，不是本地状态）
21. 在**新会话**里对 agent 说「给我建个 checkout 原型」→ `create checkout`，它会**建完自动绑定**，随后 `apply` 无需 slug

> 第 18 步是本节的验收点：它验证的是 prompt 注入（agent 知道当前原型）+ slug 回退（命令缺省取绑定）**两条链路都通**。若 agent 仍要求你提供 slug，看主进程日志里 system prompt 是否含 `<prototype_context>`。

### G. 在预览面板上选中元素（§12 的验收）

前提：该面板窗口的会话已绑定原型（否则工具栏会提示「未绑定原型」）。

22. 点面板工具栏的**准星图标** → 按钮高亮 + 出现「点击页面上的元素」提示 → 点击页面任意元素
23. **关键验证**：此刻点击**不应触发**页面自身的按钮/链接行为（编辑态已拦截 capture 阶段）
24. 主窗口**直接切到那个会话**，输入框里已经预填了 `把页面里的 <selector> 元素（当前文字为「…」）改成：`，光标等着你补完这句话
25. 补一句「改成『立即下单』」→ 发送 → agent 写补丁并重放 → **面板里立刻生效**，同时详情页产物区多出一个文件
26. 再选一个元素 → 同样直接跳回会话（没有中间卡片、不需要点第二次）
27. 点工具栏**闪电图标** → 把当前原型的所有补丁重放进这个面板
28. 按 Esc 或再点准星图标 → 退出编辑态，页面恢复正常点击行为

> 第 24 步是本轮改动的验收点：**"选中"只回答"哪一个元素"，"改成什么"一律在对话里说**（§12.4）。

### H. 两种页类型（§13 → §19 的验收）

29. 「新建页」对话框里看两个类型卡片：**默认选中「我们自己的一页」（scratch）**；选「一个真实页面」（overlay）→ 出现地址输入框，**标着「必填」**，为空时「新建」是灰的；切回另一个类型 → 输入框消失（切回再切一次，确认不会残留上一个类型的输入）
30. 加一个 overlay 页并填地址 → 详情页 **Pages 区块**里那一行显示它记录的地址（右侧一个 Globe 按钮可就地改，§13.2.1）；「预览」打开的是**那个在线地址本身**，补丁注入进去
31. 加一个 scratch 页 → 先让 agent 写 `<页名>.html`；Pages 区块里那一行显示的是它自己的**文档路径**（没有地址，也没有 Globe 按钮）
32. 「没有可打开的页」的告警说清下一步（写一份文档、或加一个 live 页），**不指向任何按钮**；overlay 页在新建时地址就是必填，所以它不可能缺地址
33. 目录里 `prototypes/<slug>/config.json` 是一张页表：`{ "pages": [ { "name": "cart", "kind": "scratch", "entry": true }, { "name": "pay", "kind": "overlay", "url": "https://…" } ] }`——scratch 页**不写** `file`（名字即文件名）、overlay 页**一定**有 `url`（§19.1）
34. `prototype_tool status <slug>` 与 agent 的 system prompt 里都能看到**每一页的**类型；`pages --add pay=https://…` 加一个 live 页、`--add cart`（文档已存在）把一页放进流程顺序；`entry <name|none>` 决定根地址开哪一页

> 第 33 步验证的是「数据层分离」这个选择本身：类型不是 UI 状态、不是标签，而是**落盘的一个字段**，所以详情页、prompt、agent 命令、导出三条路读的是同一个真源。

### I. 混合场景：逆向第三方再搭自己的（§14 的验收）

**B 在看什么**（参考这一档已撤：没有命令、没有关系，"在看的东西"是 `PRD.md` 旁边的一份材料，见 §14 的修订）

35. 建一个原型并写一页（scratch）→ 让 agent 把"这个原型在看什么"**写在 `PRD.md` 旁边**：一份文件（`references.md` 之类）里列出另一个原型的 slug、一个网址（`https://…`）、一个路径（截图 / 设计稿 / 文件夹）。三种目标写在同一种东西里
36. 详情页「需求」段列出这个目录里的文件，点开就用系统程序打开；页面上**没有**添加或删除入口
37. **验证这不再是关系**：另建一个 scratch 当参考对象，把它的 slug 写进第 35 步那份文档 → `list` 只列原型与它们的页，**不显示任何"谁在看谁"**；被看的那个原型的 `config.json` 里也没有任何痕迹
38. 在参考原型自己的详情页里打 patch —— live 页的直接打在活页面上，我们自己页的写进它自己的文档；这些 patch 属于**它自己**
39. 回到交付原型 → `prototype_tool apply` → 注入的是**交付原型**的 patch，参考原型的 patch 一条都不在里面（第 42 步会再确认一次）

**A 起点**

40. 在交付原型（scratch）上：让 agent 用 Write 工具写 `cart.html` 当底稿 → 手改几处
41. **护栏**：页文档是**无条件覆盖**的写入口，agent 要覆盖一份已有内容的 scratch 文档时，必须先问一句；overlay 页上没有可覆盖的文档——它的页面永远是那个地址本身

**护栏**

42. 导出交付原型（`export`）→ 检查 `dist/extension/<入口页>.html`：里面**不应**出现任何参考原型的 patch 内容。这是第 38 步那批 patch 最危险的去处
43. 问 agent「这个原型在看什么」→ 它读第 35 步那份文档答得出来；`status` 的输出里**没有** `references:` / `referenced by:` 两行（这一档已撤）
44. 对话里（会话已绑定交付原型）说「把另一个也加进来看」→ agent 写进那份文档；若它需要先建一个原型来研究，应当带 `--no-bind`，**且绑定不能被换掉**（`list` 里 BOUND 仍是交付原型）
45. 让 agent 把其中一条从文档里删掉 → 再问一次就不再出现（它是一段文字，不是一条要去解除的关系）。再往文档里写一个盘上不存在的路径 → 它照实列在那里，不报错也不丢弃

**agent 的读取面**

46. 对话里说「列一下原型」→ `list` 的每一行都带 `(overlay)` / `(scratch)`，有目标页的带 `target:`；**没有** `references:` / `referenced by:` 这类行
47. 对自己**不是**绑定对象的那个原型说「看一下它的状态」→ agent 应执行 `status <slug>`，输出里能看出它是什么类型、有哪些页；关于"在看什么"它读的是 `PRD.md` 旁边的材料，不在状态报告里

> 第 46 步修的是一个「状态撒谎」：在此之前 `list` 只列 slug 和 patch 数，overlay 和 scratch 在列表里长得一模一样。

> 第 44 步是本节最容易出事的一步：`create` 默认会绑定会话，如果 agent 为研究而建原型时没带 `--no-bind`，之后每条省 slug 的命令都会打到被研究的页面上，而**画面上看不出来**。

### J. 交付物的 origin（§16 的验收）

48. 打开 `http://<slug>-<hash>.localhost/`（**不带路径**）→ 应看到**入口页**（没配入口时是生成的**页索引**）加上这一页生效的补丁；对照 `/_index` 与 `/dist/extension/…`（导出时冻结的那一份）。**在没导出过的情况下也要能看到补丁生效**——这是这一节的核心（§19 起 `base.html` 不再特殊，"裸底稿"那个调试地址已取消，§19.3）
49. 让 agent 建一个原型、写一页（我们自己的一页），文档里放 `<script type="module">` + `fetch('/api/anything')`，写一条对应 path 的契约 fragment 与 fixture，然后 `mock-apply` → **相对 fetch 应被 mock 答上**。这是 §16 的收益点：`file://` 时代这个请求根本发不出去，mock 再对也没用
50. 在页面里 `document.cookie = 'a=1'` 再读回 → 有值；`localStorage` 同理。两者在 `file://` 下都是空/不可用
51. 重启应用后重开同一原型 → cookie 与 localStorage **还在**（origin 不再随端口变）
52. **SPA**：在某一页的文档里放一个 `history.pushState(null,'','/orders/42')` 的按钮 + `<link href="/assets/app.css">`，并在原型目录里放 `assets/app.css` → 点按钮后**刷新**，页面应仍然起来（回退到原型页面），且样式表命中（根绝对路径）

### K. 页面从哪来，两种类型各走各的（§13.1 / §13.1.1 的验收）

前提：这些**都没有界面入口了**——是对着对话说，不是找按钮。

53. 新建一个原型（容器）→ `prototypes/<slug>/` 里**没有**任何 `.html`（连 `config.json` 都不写：没有东西可声明），详情页的「预览 / 导出」是灰的，告警卡写的是"在对话里说一声"，**不指向任何按钮**
54. 在对话里说「写一个登录页首稿」→ agent 用 Write 工具写 `login.html`，那一页就此存在 → 「预览」变可用。**全程界面上没有出现过"写底稿"这类按钮**
55. 给原型加一个 live 页并填了地址 → 「预览」直接打开**那个在线地址**并注入补丁：地址栏是真实站点，页面带自己的 JS、自己的登录态、自己的数据。`prototypes/<slug>/` 里**没有、也不需要**那个页的文档——这是 overlay 页的核心判据
56. **地址在新建那一页时就必填**：对话框里只填页名、选「一个真实页面」而不填地址 → 「新建」是灰的；对话里 `pages --add pay=`（缺 url）→ 明确报错。所以 live 页建出来**一定**有地址，「预览」对它永远可用——这也是 §13.5 那条"最粗糙的一处"消失的原因
57. 详情页上确认动作区**只有**「预览 / 在对话里改 / 导出」三个，没有别的入口
58. 对另一个 scratch 说「以 <另一个原型> 为起点」→ agent 会告诉你做不到，改用**列表右键 →「复制」**：新原型的 slug 是 `<源 slug>-copy`，页面与补丁**成对**过来，页表也跟过来（是同一件事的另一份），从那一刻起两边互不影响；再复制一次得到 `-copy-2`（这一步见 O 组）

### L. 打开 = 打开当前的页面（§16.3 / §16.4.1 的验收）

59. 打开一个有补丁的原型 → 地址是 `http://<slug>-<hash>.localhost/`，**不是** `/dist/extension/<入口页>.html`；页面已经带该页生效的补丁效果。**在交付物存在的情况下也必须如此**（这条就是本节的判据）。live 页则打开它记录的在线地址，地址栏不变——两者的区别本身就是本节要确认的东西
60. 在那个页面上继续改：面板工具栏选元素 → 跳回会话、补完那句话发送 → agent 写补丁并重放 → 新效果**原地出现**，页面不重载、不闪。用一个会 `appendChild` 的 JS 补丁试：在**面板工具栏**重复点「应用补丁」应当**只出现一次**（跑两遍就是这里要防的那个静默错误）
61. 只改某个已有补丁的**内容**（不改文件名）→ 面板工具栏的「应用补丁」不会重复注入它（按文件名算"已内联"）→ **刷新**页面后看到新内容
62. 把某个我们自己页的文档删掉 → 详情页「预览」变灰、告警说"说一句你要做什么"；直接导航到它的 origin 得到 404；`/dist/extension/<那一页>.html`（上次导出的那一份）仍可按名字访问（交付物没被藏起来，只是不再是入口）。同一个原型导出时**应当报错**（那一页没有文档可交）

### M. 交付物：一个原型一个扩展（§17 的验收）

63. 在一个只有 live 页的原型上 `export` → `dist/extension/` 里出现 `manifest.json` / `README.md` / `patches/*.css` / JS 脚本，`dist/dev-spec.md` 照旧；按 README 的三步在 `chrome://extensions` 里 **Load unpacked**，然后打开目标页 → **补丁已经在**，没有任何要点的东西
64. **刷新页面** → 补丁仍在（是浏览器注入，不是一次性动作）；在同一站点内点一个站内链接换页 → 补丁也在（每条 content script 按 `matches` 生效）。
65. 让 agent 加一条会 `appendChild` 的 JS 补丁（比如插一个徽章）→ 重新导出 → 在 `chrome://extensions` 点 **Reload** 并刷新页面 → 徽章**只有一个**（§17.3 的"可重跑"规矩）；在同一页里切换 SPA 视图 → 补丁自动重放到新视图
66. 打开扩展的 README：写明**装法**、**作用范围**（`matches` 列表）、**改了哪些补丁**、**构建时间与版本**、以及"改一条补丁要重新导出 + Reload"；`chrome://extensions` 上显示的版本号与 README 一致——这条是"我看到的和你说的不一样"的唯一答案
67. 找一个下发严格 CSP 的站点（GitHub 之类）→ 补丁**照旧生效**（内容脚本由浏览器注入，页面策略管不到它）
68. 有我们自己页的原型导出 → 包里每一页都在（**文件名不变**，所以页间链接照旧）、每页各自一份构建产物；Load unpacked 后打开扩展的 **options** → 是生成的**页索引**（点一页就过去），工具栏图标打开**入口页**（没配入口则开索引），打开的那一页带着该页生效的补丁
69. 在某一页的文档里写一段内联 `<script>` 和一处 `onclick="…"` → 导出后打开那一页：内联脚本被提取成文件后**照旧运行**，`onclick` 也照旧生效（agent 不需要知道扩展存在，§17.1）；再把 `onclick` 换成运行期拼出来的字符串试一次 → 仍然生效
70. 给某个原型加一条契约 fragment + fixture 并 `mock-apply` → 导出后的扩展里那条请求**被包里伪造的数据答上**，README 列出了这条路由是假的；换成"真实产品是 PWA"的情形（请求由它自己的 service worker 发出）→ 那条 mock 不生效（README 已写明这条边界）。
    另外确认一个曾经静默失败的点（两条以上 js 补丁只有第一条执行，见 [开发文档](prototype-workbench-dev.md) §3.4）：在一个**只有一条 js 补丁**和**有两条以上 js 补丁**的原型上分别导出，每条补丁都生效

### N. 换环境：地址可以改（§13.2.1 的验收）

71. 在一个绑定好的、有 live 页的原型上说「这个我们测试环境也有一份」→ agent 跑 `pages --change <页名>=https://staging.example.com/checkout` → 输出是 `from:` / `to:` 两行，加上四条后果（新地址生效、旧窗口要重开、选择器可能不再匹配、类型仍不可改）；`config.json` 里**只有那一页的 `url` 变了**（页表其余行不动）；Pages 区块里那一行的地址跟着变，而「预览」一直可用
72. 同一件事在界面上做一遍：**Pages 区块**里那一页的地址**完整显示**，右边一个 **Globe 图标**（tooltip：改这一页的地址）→ 点开是一个输入框 + 一段风险说明（正是第 71 步那两条静默失效），地址与当前值相同时「保存」是灰的 → 改成第三个环境、保存 → 对话框关闭、行上立刻是新地址
73. 三种拒绝路径都要试：对**我们自己那一页**说「把它指到某个地址」→ 拒绝（"它的页面就是它自己的文档"）；地址写成 `app.example.com/x`（缺 scheme）→ 拒绝并提示补上 scheme（**对话框里也走同一条规则**，错误就地显示在弹窗里）；在**没有原型在视野里**的会话里跑命令（页不属于任何原型，会话也没有绑定）→ 拒绝并提示"点名 slug，或先 `open <slug>`"（这条命令唯一的位参数是地址，所以它不认位置上的 slug）
74. 改完再 `export` → `dev-spec.md` 第一行与扩展 README 里的地址都换成新的（`matches` 也跟着换）；**旧窗口里的页面不会自己变**——`open` 一下才挪过去（这条正是命令里那句话的验收）

### O. 列表的复制与删除（§13.1.1 的验收）

75. 在原型列表的一行上**右键**（或悬停看那个 `…`）→ 菜单两项：「复制」「删除」。先确认菜单里**没有**别的条目
76. 点「复制」→ toast 报出新 slug（`<源 slug>-copy`），面板**直接跳到那份副本**；进 `prototypes/<slug>-copy/` 看：各页文档与 `patches/` 都在，`config.json` 是新的（页表跟过来），**没有 `dist/`**；再复制一次 → `-copy-2`
77. 改副本里的一个补丁 → **源原型不受影响**；反过来也成立。这是"复制的是原型，不是材料"的验收
78. 对一个别的原型在文档里提到过（"在看什么"那份 `.md` 里写了它的 slug）的原型点「删除」→ 先弹确认（写明删的是什么）→ 确认后行消失、目录也没了；**没有任何"还有谁在用它"的提示**——那是一段文字，不是一条要去清理的关系。打开写下那句话的原型 → 文档原样，那句话读起来就是"一个不在盘上的原型"
79. 删掉当前正打开着的原型 → 详情页回到原型列表，而不是停在一个已经不存在的 slug 上
80. 让 agent 去删一个原型 → 它没有这个命令；`create` 的输出也**不再提**"可以导入另一个原型的页面"

### P. 窗口的地址栏（§12.6 的验收）

81. 在一个**已经有对话**的原型上点「预览」→ 窗口的地址栏写的是 `http://<slug>-<hash>.localhost/`，而不是它正在显示的第三方站点地址（overlay 尤其明显）；工具栏的「选中元素 / 应用补丁」是亮的，在 overlay 上点「应用补丁」→ 补丁落在那个真实页面上
82. 在一个**还没有对话**的原型上点「预览」→ 窗口照常打开，但地址栏是它实际所在的地址、两个按钮是灰的（点了不会有任何提示，因为点不动）；回详情页点「在对话里改」建出对话，再让 agent `open` → **同一个窗口**被复用并绑定，地址栏变成原型域名、按钮变亮
83. 在 scratch 原型的窗口里访问 `/dist/extension/base.html` → 地址栏显示这个带路径的地址（原型内部的路径不做替换），两个按钮仍然可用
84. 在地址栏里敲**这个原型的根地址** → 它不去取那个 URL，而是按页打这个原型：我们自己那一页落在渲染页上，live 页落在它自己的地址并重放补丁（**不是 404**）；敲 `/dist/extension/<那一页>.html` 这类**原型内部的路径**则是普通导航
85. 让 agent 在原型窗口里跑 `snapshot` 与 `tabs` → 输出里同时有**真实页面 URL**（live 页就是站点自己的地址）与 `<slug> — page "<页名>" (<kind>), its own address …`；live 页还多一句"这是站点自己的页面，只能打补丁、不能就地编辑"。把同一个窗口换成普通网页 → 这些原型行**一行都不出现**

### Q. 多页面原型（§18 的验收）

> **§19 起这批用例的地址与名字要按页层模型读**（`86` 里的"入口页 `base.html`"、`88` 里的 `page "entry"`、`89`–`93` 的 overlay 页表都成了页表里的一行）。行为不变，编号保留作为回归；新增的页层用例是 R 组（§19.10 的 94–100）。

86. 在一个 scratch 原型目录里放第二张页 `orders.html`（从入口页 `<a href="/orders.html">` 链过去），再写一条补丁 → 进第二页时**补丁也生效**；导出（§17）→ 包里**两张页都在**（`base.html` 与 `orders.html`，名字不变所以链接照旧），两页都带补丁，入口写在 manifest 的 options 里，README 的 `Pages` 列出它们；对照 `/base.html`（裸底稿，无 patch）与子目录里的 html（同样是裸的）
87. `status` 里能看到 `pages:` 列出 `entry (base.html)` 与 `orders (orders.html)` 及各自地址；`open <slug> --page orders` 打开第二页；`--page nope` 报错并**把可选页列出来**
88. 在第二页上让 agent `snapshot` → `Prototype:` 行带 `page "orders"`；回入口页再 `snapshot` → `page "entry"`；把窗口导航到站外 → `page` 不再出现（而 `URL:` 行如实显示站外地址）

**overlay 的页表（§18 ⑤／⑥）**

89. 给一个 overlay 加第二、三页（`pages --add payment=https://app.example.com/checkout/payment`）→ `status` 的 `pages:` 按**入口 + 声明序**列出三页及各自地址（不是字母序）；`open checkout-flow --page payment` 打开那一页并重放补丁
90. `export` → `manifest.json` 的 `content_scripts[0].matches` 里**每一页各一个 pattern**；README 的 "Where it applies" 逐页一行。少一页都算失败
91. 在第二页的窗口里 `snapshot` → `Prototype:` 行带 `page "payment"`——页表让这个反推对**整条流程**成立，而不只是入口页
92. 往 `pages` 里写一个 `ftp://` 或空地址、写一个重复 `name`、写一个与入口那一行地址相同的条目 → 导出报错并**点名那一页**；重复项被丢弃并报告，其余照常工作（不静默、也不整份拒绝）
93. `pages` 无参数 → 列出入口与其余页；`--remove` 掉一页 → 状态与导出立刻不再包含它，入口那一行不受影响

### S. 补丁的标记、锚点与收敛（§21 的验收）

> 101–108 是"补丁能不能被检查"（§21.1／§21.2），109–115 是"改动会不会收敛"（§21.3），107 顺带验 §21.4 的合并。

101. 给一条补丁加头注释 `/* @target .pay-btn */` → `status` 的补丁清单与详情页都显示这个 selector；没写的显示 `—`（不是猜一个）
102. 让 `apply` 遇到一个页面上不存在的 selector（`@target .typo`）→ 输出**点名** `matched nothing`，面板的 toast 同一句；改对再 apply → 不再点名
103. apply 一次真正命中的补丁 → `prototypes/<slug>/anchors/shared.json`（页级补丁是 `anchors/<页名>.json`）出现，带 selector、fingerprint（tag / text / attrs / path）、首次与最近命中时间；详情页「锚点」区块按 scope 列出它
104. 让一个曾经命中的 selector 不再匹配（改页面上的元素，或把 overlay 指到同页的另一个环境）→ 输出说 **the page moved** 并给出页面上现在的候选 selector；记录里那条**仍在**，`lastMatchedAt` 保持旧时间
105. 删掉一条曾经命中的补丁 → 锚点问题里点名"记录还在，但没有补丁再声明它"
106. 用外部编辑器保存一条补丁 → overlay 窗口 1 秒内**自己**重放；scratch 页窗口自动刷新
107. 连续保存三个文件（`patches/`、`assets/`、页文档各一个）→ 窗口只重放**一次**；两次重放之间，JS 补丁的副作用不叠加
108. 一条补丁没写 `@target` → apply 输出点名"no @target，无法检查"，而不是当作干净通过
109. 复制一个只有 overlay 页的原型，用「复制并折叠改动」→ **副本**里该页补丁折成 `patches/<页名>/Z-001-upper.css` 与 `Z-002-upper.js`，被折的补丁文件**被删**；`status` 里补丁变成这两条，且 `@target` 与 `@requirement` 标记都还在（锚点与需求线因此不断）；**原件里那些补丁文件一个都没少**
110. 打开副本里那个 overlay 页 → 效果与折入前**一致**（Z 排最后，覆盖它折入的那些）
111. 复制一个 scratch 页的原型并折叠 → **副本**里 CSS 进 `assets/<页名>/committed.css`、JS 升格进 `assets/<页名>/committed.js`，页文档里被插入 `<link>` 与 `<script src>` **各一次**，补丁文件被删；打开页面效果不变；**原件的页文档没有被改过**（这是"折副本"的可观测判据）
112. 对一个已经收敛的副本再折一次 → 报"没有可收敛的补丁"，一个字节都不写（`fold.test.ts` 的单测覆盖这一条）
113. 把一个 scratch 页的文档删掉（页表里仍声明它）再复制并折叠 → 折叠报 **the page document is missing**，并且**不删**那条补丁（副本里留着，可见）
114. 折叠一个 scratch 页的补丁之后 → 该页的锚点记录被清掉（元素已在我们自己的文件里，没有"页面漂移"可言）；同一个原型里 overlay 页的锚点记录**保留**

---

## 11. 会话 ↔ 原型绑定（对话入口）

**问题**：`prototype_tool` 命令原本每条都必须显式传 slug，而 agent 无从知道"当前在哪个原型"——一个 workspace 可以有多个原型。于是每次对话都要人肉报名。

**结论**：复用仓库里**已有**的 session ↔ project 绑定范式，不发明新机制。该范式五层俱全，照抄即可。

### 11.1 五层链路

| 层 | 位置 | 说明 |
|---|---|---|
| L1 字段 | `SESSION_PERSISTENT_FIELDS` 里的 `prototypeSlug`——**只有它** | 加入白名单数组即自动获得 JSONL 读写（`pickSessionFields` 驱动）。**页不入库**：页表之外没有任何持久字段，agent 侧的 `prototypePage` 是每次从窗口真实 URL 反推的（§19.6） |
| L2 设置 | `SessionManager.setSessionPrototypeSlug()` | 镜像 `setSessionProjectId`：写字段 → 推事件 → 持久化 → 通知 watcher |
| L3 通道 | `sessionCommand { type: 'setPrototypeSlug' }` + `prototype_slug_changed` 事件 | 渲染层 → 主进程；事件回流刷新 badge |
| L4 注入 | `buildPrototypePromptContext()` → `<prototype_context>` | 与 `<project_context>` 并列注入 system prompt |
| L5 工具 | `resolvePrototypeSlug()`：显式 slug → **当前页的原型** → 会话绑定 → 报错 | 缺省先取"你正在工作的那一页属于哪个原型"，取不到才退到会话绑定（页优先是 §22 的有意设计），两者都没有才要求点名。这才是"不用报名"的兑现点 |

### 11.2 三个设计判断

**① prompt 块是快照，不是实时视图。**
`ClaudeAgent` 在首次 chat 时 pin 住（与 `pinnedProjectContext` 一致），因为 SDK resume 与 prompt caching 都要求 system prompt 稳定。代价是 agent 看不到本轮新增的 patch —— 所以块内**明确写了这一点**并指示它用 `status` 复查。稳定性换来的收益大于实时性。

**② 绑定不校验 slug 是否存在。**
`setSessionPrototypeSlug` 故意不检查磁盘。理由：`create` 需要"建完即绑"，若先要求存在就死锁；且原型可被删除重建而会话不该因此报错。校验曾放在**命令**侧（`bind` 拒绝未知 slug 并列出可选项，因为那里有 `listPrototypes` 可用）；`bind` 删掉之后这一处也没有了——一个拼错的 slug 会由**用到它的那条命令**自己报（它本来就要读那个原型的状态）。

**③ `create` 顺带绑定。**
创建的目的是用它；分开两步会强制用户走一遍正是绑定要消除的 slug 流程。这是**唯一**带隐含副作用的命令，输出里明说了"已绑定"。

### 11.3 新增的命令

| 命令 | 作用 |
|---|---|
| `list` | 列出工作区所有原型 + 标注当前绑定（`BOUND`）。**没有它，未绑定会话里的 agent 无法发现任何原型** |
| `create <name>` | 创建 + 自动绑定 |
| ~~`bind <slug\|--clear>`~~ | **已删**。绑定是人的事——面板的 Open conversation、会话头的 `PrototypeBindingMenu`（§11.4）——agent 要别的原型就按名点名（每条命令都收 slug）。`create` 仍顺带绑定，所以写绑定的路还在代码里，只是不再是一条命令。随它消失的还有一处校验（原来只有它会在绑定前核对磁盘），未知 slug 现在由用到它的那条命令自己报 |

### 11.4 两处 UI 入口

- **正向（面板 → 会话）**：原型详情页的 **Open conversation**。已存在绑定会话则跳过去，否则新建。理由是原型长期存在且会被反复回来，"每次都新建"既堆积会话又丢掉之前的讨论。
- **反向（会话 → 面板）**：会话标题栏的烧瓶图标（`PrototypeBindingMenu`）。显示当前绑定（有绑定则高亮），可切换、解绑、跳回面板。原型列表在**打开菜单时**读取，避免用页面加载时的陈旧快照。

### 11.5 与 project 绑定的差异（有意为之）

| 维度 | project | prototype |
|---|---|---|
| 创建时绑定 | 继承项目 `workingDirectory` | 继承父会话绑定（子任务同属一个原型） |
| prompt 块 | 名称 / 描述 / assets / MEMORY.md | slug / base 状态 / patch 清单 / 契约覆盖 / 所有权违规 |
| 命令回退 | 无（project 不驱动工具） | **有**：命令缺省取"**页 → 会话绑定**"（§22 第十二轮；位参数不是 slug 的几条见 §13.2.1 / §14.4，其中 `sample-video` 用 `--slug`） |
| 缺失处理 | 项目被删 → 解析为 null，退化为未绑定 | 同左（`existsSync` 判目录，因为 `buildPrototypeStatus` 对不存在的项目返回"空项目"而非报错） |

---

## 12. 预览面板上的编辑入口

**问题**：§11 把「应用补丁」放在了原型详情页。用户看的是**预览面板**里正在开发的产品页面，却要切到另一个页面去点应用。更根本的是：原始痛点「对注入的 HTML 实时编辑**或选中**」在预览面板上**一个入口都没有**。

### 12.1 先纠正一个认知：预览面板不是 React 面板

它是一个**独立的无边框原生窗口**，内部叠着（§22 第四～六轮改过形态：标签栏是左侧一整列、标签页可以有多个）：

```
railView          左侧 200px  独立渲染进程（标签栏：每个标签页一条，`+` 在这里）
toolbarView       48px        独立渲染进程（地址栏；整列在标签栏右边）
tabView（网页）    页面面板      产品页面：`WebContentsView`，一个标签页一个；**角由它自己的 view 切**
nativeOverlayView 页面周围与下方  **窗口**的遮罩层（不是每个标签页一份）：留白表面 + 面板细线（`#frame`）；被持有时换成画在页面边缘上的 `#lock`（accent 框 + 光晕 + 胶囊 + `#shield`）。在第一个页面视图之前就建好并加载 —— 它是页面下面那层"地面"
```

**页面是主聊天面板那样的面板**（与 `components/app-shell/panel-constants.ts` 同一套数：圆角、边距、细线，见 `shared/panel-geometry.ts`）：它**紧贴它所挨着的 chrome** —— 左边贴标签栏、上边贴地址栏，各留 **1px**（细线画在页面**外侧**，紧贴的话这两条线会被 chrome 那两层视图挡在后面 —— 应用自己的面板没这个问题，因为它的 chrome 和面板在同一个文档里）；离窗口右边和下边各 6px（`PANEL_EDGE_INSET`，那边没有可贴的东西）。四角圆角 10px，外面一圈 1px **实色**细线：**前景色 5%**，与地址栏那个输入框的边（`border-foreground/5`）同一个分量（用户定的：面板和它旁边的输入框要一样），用**真正的 `border`** 画（真 border 的圆弧由浏览器抗锯齿，比 mask 抠出来的 1px 环干净）。**圆角由网页自己的 view 切出来**（`WebContentsView.setBorderRadius`，`applyPageCornerRadius`），因此对任何网页都成立；四角切掉后透出来的是它**下面**那层 overlay：`#mask` 是一个**方**的盒子（`box-shadow: 0 0 0 9999px <surface>`），只把页面矩形**之外**那一圈留白填成窗口表面色，页面矩形**里面**一点不画 —— 所以四个角的缺口透出来的是窗口自己的底色（同一个色值），角的形状因此只有页面裁剪这一份（§22 第十三轮修正）。`#frame`（画那条线的元素）比页面矩形**外扩 1px**、半径也 **+1px**，这样线落在页面外那一圈、且内缘正好贴合页面的圆角。

**这层 overlay 的上下位置就是"这个标签页有没有被锁"**：平时它在页面**下面**（只看得见页面外那圈细线），人照常点页面、打字；agent 持有这个标签页时它被抬到页面**上面**，并换成 `#lock` 那个框 —— 与细线同盒子但 2.5px 宽：外面 1px 填满留白（accent 一直贴到 chrome），里面 1.5px 压住页面边缘，**连页面自己那个硬切的圆角也一并盖住**，再加内侧光晕与一层变暗。这一条不是审美取舍而是必需：视图**永远按矩形吃输入**（Electron 给 `setBorderRadius` 的注解就是这么写的：切掉的区域照样吃点击），所以任何盖住页面的墨都会把页面的点击一起吃掉 —— 也就是那个"网页不能点"的 bug。

> **为什么页面是 `WebContentsView` 而别的还是 `BrowserView`**：只有前者能 `setBorderRadius`（Electron 39 的 `BrowserView` 上根本没有这个方法），而两种 API 共用**同一棵** view 树（`setTopBrowserView` 与 `contentView.addChildView` 能互相排序），所以只换页面这一层，chrome 与 overlay 不动。代价是页面那一层没有 `setAutoResize`（`layoutAllViews` 本来就在每次 resize 时重排，不依赖它）。

含义：renderer 里的 `components/browser/` 只是主窗口 TopBar 的徽章条，**不是面板本体**。面板工具栏的可用 API 只有导航类（`window.browserToolbar`），它**拿不到 workspace、会话、绑定原型**。

所以「在那里加个按钮」不是加个按钮，而是要新开一条链路。

### 12.2 链路：面板 → 主进程 → 主窗口

```
面板工具栏（无上下文）
  │ ipcRenderer.invoke('browser-toolbar:pick-element' | ':apply-prototype')
  ▼
BrowserPaneManager（主进程，只有 instanceId）
  │ 广播 RPC_CHANNELS.browserPane.TOOLBAR_ACTION = { kind, instanceId, ... }
  ▼
主窗口 renderer（有 sessionMetaMap + 原型列表）
  │ 解析 instance.boundSessionId → session.prototypeSlug
  ▼
调既有 RPC：prototypes:apply / file:write
```

**关键设计**：面板只上报「用户做了什么」（`BrowserToolbarAction`），**不判断它的含义**。含义依赖绑定，而绑定在主窗口。这样「应用补丁」按钮与原型详情页的 Apply **走同一个 RPC**，两个入口不可能行为分叉。

广播用 `{ to: 'all' }` 而非定向：面板不知道自己由哪个 client 打开，不拥有该 instance 的 renderer 会忽略。

### 12.3 编辑态必须显式进入（这是用户的明确约束）

用户原话：「要先点击可视化编辑按钮再进入编辑态，否则会被 html 本身的点击行为干扰」。

现有 picker 已满足这个约束（`browser-cdp.ts`）：

- 它在 `click` 的 **capture 阶段**注册（`addEventListener('click', onClick, true)`）
- 处理函数里 `e.preventDefault()` + `e.stopPropagation()` —— 页面自身的行为被拦住
- 它**只在注入后存在**；注入即进入编辑态，`cleanup()` 即退出

所以工具栏的按钮就是「注入/取消注入」的开关，UI 上还额外给了一个文字提示（`browser.pickHint`），避免用户在不知情的情况下点进页面。

### 12.4 选中之后：只有一个出口，而且是对话

选中元素 → **把 `selector` + 该元素当前文字预填进这个会话的输入框并跳过去**。中间没有卡片、没有第二个决定。

补丁只有一个来源：**agent 写**。点击式生成（`textContent` 替换那种）被否决，三条理由：

- **它让补丁数量由点击次数决定**，而不是由"要交付几件事"决定。改 30 处文案就是 30 个文件，可它们本该是同一句需求。
- **它把判断权交给了点击者**：点一下只能做 `textContent` 替换，而这一处到底该改文案、该改结构、还是该连着改三处，需要看得见全局的人来判断。
- **它让"编辑"变成一个不需要描述的动作**，于是没有任何地方留下"为什么改"——而这个工作台的产物之一就是那份理由。

面板的编辑态只负责回答"哪一个元素"，那正是人比模型快的地方；而"改成什么"回到对话里说。

> 同一条规矩当初也适用于那个**详情页的源码编辑器**（已删除，见 [开发文档](prototype-workbench-dev.md) §4）：产物区只**列出**原型由哪些文件组成，不提供"点开就能改"的入口——直接编辑产物文件是工程侧的界面，不是这里的。

### 12.5 未做的（明确记录）

- **样式可视化编辑**（颜色/间距编辑器）—— 不做：一切改动都走对话
- **面板内编辑条** —— 不做：选中即跳对话，面板工具栏只保留「选中元素 / 应用补丁」
- 面板工具栏的按钮**没有 tooltip**（BrowserView 边界会裁掉浮层），只有 `aria-label`

### 12.6 窗口的地址栏就是它的原型

面板窗口的地址栏此前如实显示 `tabView` 的地址：scratch 原型上是 `http://<slug>-<hash>.localhost/`，**overlay 原型上却是它正在改的那个第三方地址**。于是同一个原型有两副面孔——这也是"未绑定原型"那句提示最刺人的地方：用户手里明明是从原型面板打开的窗口，看起来却像一个普通浏览器。

**规则**：窗口在做哪个原型，地址栏就写哪个原型的域名。

- **overlay 也如此**，尽管它的 `tabView` 仍在真实地址上（这正是 overlay：页面带着自己的 JS、登录态与自己的源，patch 注入进去）。地址栏是**显示层**的事实，不是导航层的事实——真去用本地服务器代请求第三方页面，会丢掉登录态、CORS 与源，等于把 overlay 毁掉。
- **scratch 不用改**：它本来就在原型域名上；而且当地址已经落在原型 host 上时保留真实 URL，所以 `/dist/extension/base.html`、SPA 路由这些**原型内部的路径**照样看得见。

**"看地址栏就知道绑没绑"之所以成立**，是因为地址栏那个值本身就来自这条查表：页自己的 `boundPrototype`（开这一页时定的身份）→ `prototypeOriginUrl`；而窗口级的 owner / `boundSessionId` 那一整套"谁拥有这个窗口"的词汇在收口时**整体删掉了**（§22）——一个窗口不再属于哪个会话，页上那个身份才是真的。同一个值顺带决定那两个动作是否可用——**没有原型就没有那两个按钮**（置灰），而不是点完再弹一句"未绑定"：这是「入口的失败在点之前说，不在点之后答」（§6 阶段 7）在工具栏上的兑现。

**为什么必须有"窗口被打开时声明的那个原型"这一条**：overlay 的视图落在第三方地址上，一旦加载完，URL 里**没有任何东西**记得这是在给哪个原型打补丁——所以身份只能在打开的那一刻说定（`PrototypeEntry.origin` → `browserPane.create` 的 `prototype`）。只留会话链时，"刚创建、还没有对话"这个最常见的首次体验恰好不成立：地址栏写着真实地址、两个按钮灰着，窗口不认为自己是这个原型的窗口。

**地址栏里的原型地址是能用的，不是摆设。** 敲它 = 打开这个原型的某一页：

- **根地址代表原型本身**（`pathname === '/'`）：敲它 = 「打开这个原型」——发一条 `open-prototype` 工具栏动作（不带页名）给主窗口，由它 `getPrototypeEntry` 解析入口页 / 页索引，活页面再 `applyPrototype` 重放补丁。与面板「预览」是同一条路，两处不会漂移。
- **`/<页名>` 代表原型里的某一页**（§19.3）：主进程查页表认出这是哪一页，动作里带上页名，主窗口 `getPrototypeEntry(slug, page)` 解析出**那一页自己的地址**再加载——活页面直接加载它的真实地址，自有页加载宿主渲染它的地址。判定不需要新东西：一个路径段，且这一页真的在流程里（不在就是普通导航，交给宿主的目录）。
- **其余路径是文件或应用自己的路由**（`/dist/extension/index.html`、`/assets/app.css`、SPA 路由）：不是页名，照旧按路径导航（§16.3）。
- **这顺带消掉了 overlay 的一个坑**：overlay 在根地址上本来没有页面（404 `Nothing to serve`），敲回车吃 404 看着合理，其实是把"我要看这个原型"当成了"我要取这个 URL"。

**地址栏显示与视图加载是两件事**（与 §12.1 的分工同源）：bar 写的是"哪个原型的哪一页"——根之外再带页名（`http://<slug>-<hash>.localhost/pay`），而视图加载的始终是那一页**自己**的地址。所以窗口停在 overlay 页上时 bar 不跟着变成第三方地址，敲它回去的是**同一页**，而不是入口页；推不出当前页时只写原型域名。

**敲别的地址是"对这个标签页说的话"，所以它改的是身份，不只是地址。** 视图去那里，标签页也就不再是这个原型的了：地址栏如实写目标地址，标签栏那一行不再标原型与页名，那两个动作随绑定一起消失（`tab.prototypeReleased`）。粘性：Back 回来也不算它的了，要回去就再敲一次原型地址（§22，为它新开一页）。

这一条必须与"点链接 / 登录跳转 / 站点自己的路由"分开：那些是**发生**在标签页上的事，不是谁的表态，而 overlay 本来就长在别人的地址上——若按"地址不再属于原型就解绑"来判，overlay 在真实站点里点两下就会把身份和动作弄丢。判据因此是"敲的这个地址还在不在原型的地界上"：原型自己域名上的路径（文件、SPA 路由，§16.3）与某一页的真实地址都还算它的，敲它们只是普通导航，标签页照旧。**只有手敲地址栏**才走这条（面板与 agent 的导航不算表态：打开预览时加载的就是 live 页的真实地址）。

链路全在已有的 `STATE_UPDATE` 上，**没有新通道**：`BrowserPaneManager.pushToolbarState` 每次推送时算一次地址与 `prototypeSlug`（`prototypeBindingFor`：窗口被打开时声明的原型优先，否则走会话链），其中窗口那条来自打开时（`PrototypeEntry.origin` 一起带过来；页的身份改为"创建时定"之后由 `createTab({ prototype })` 给，见 §22），会话那条的 (slug, workspaceRootPath) 由 `SessionManager.getSessionPrototypeBinding` 给出，origin 由 `prototypeOriginUrl` 现算（`main/index.ts` 注入，晚绑定——窗口可能先于它存在）。地址→原型这条反方向的查表（`setPrototypeAddressResolver`）也由那里注入，用于用户敲进地址栏的地址；认出是某个原型的地址时（根或某一页）**为它新开一页、并把那一页绑到该原型**（§22：打开一律开新页，不再改绑当前页），并把页名一起交给主窗口（否则视图加载真实页面后，地址栏又会退回真实地址/丢掉当前页）。工具栏那侧只做两件事：显示 `url`，按 `prototypeSlug` 决定两个按钮是否可用。

> 与 §12.2 的分工：**动作**走"面板 → 主进程 → 主窗口"（主窗口才知道往哪个会话送元素），**地址栏与可用性**走"主进程 → 面板"（主进程持有窗口）。两条链路对同一个绑定给出同一个答案，因为查的是同一张表。

**agent 侧拿到的是同一份身份，而且更全。** `snapshot` 与 `windows` 的输出里，每个原型窗口多一行 `Prototype: <slug> (<kind>) — its own address <origin>`，而 `URL:` 仍是这个窗口**当前真实页面**的地址（overlay 就是站点自己的地址）。两行并列是刻意的：它们是两个不同的事实，而且 **kind 决定下一步**——scratch 的文档是我们的，改法是编辑文件；overlay 的页面是真实站点的，只能打补丁。只给 URL，等于让 agent 对着一个地址猜自己能不能改它。

取值在 server 层（`packages/server-core/src/domain/prototype-page.ts` 的 `describePrototypeAtPage`）：**标签页上的身份优先**（开这个标签页时记下的），会话绑定只在标签页说不出话时兜底，再配上页表里的类型与 `prototypeOriginUrl()`；只挂在 `snapshot` / `listWindows` 两次调用上，不进任何热路径；不是原型页时**一行都不出现**（普通网页保持安静）。

---

### 12.7 高亮框下方的"添加到对话"（通用能力，与原型无关）

元素选择器原本是原型工作台的能力，但它真正的前提是**有一个对话**，不是有一个原型：用户看到页面上的某个东西想聊它，这件事与它是不是原型页无关。所以：

- **进入选择模式的条件从"有原型"改成"有对话"**——到**第五轮**更进一步：条件是**没有条件**。窗口的标签可以是任何网页，选择器就常驻在窗口上；选中的元素**落到用户当前看的那个对话**，该工作区里没有这个对话就**新建一个**带给它（不再有"没有会话所以不让选"这一档，`hasSession` 字段随之删除）。
- **高亮框下方多一条工具条**：注入脚本里新增 `bar` 与一个按钮。按钮**总是**构建——既然没有对话时会新建一个，就总有地方可去，而做不了事的按钮比没有按钮更糟（这条判断没变，变的是"总有地方可去"现在为真；第六轮起它只跟着**选中**出现）。
- **添加走既有出口**（第六轮起，触发是那条工具条的按钮，不再是点击元素）：`PickedElement.intent = 'add-to-conversation'` 随元素回到主进程 → 广播 `{ kind: 'add-to-conversation', element, origin }` → 主窗口把它写进那个对话的输入框（`onInputChange` + `craft:restore-input` 两步，与原型那条完全同源）。

三个实现要点：

- **意图挂在元素上**（`intent` 字段），而不是新开一条结果通道：选择器的返回类型、能力协议、agent 的 `pick` 命令三处都不用改签名。
- **按钮文案由调用方给**：工具栏是渲染层（有 i18n），注入脚本在主进程（没有），所以 label 随 IPC 传进来。
- **捕获阶段的点击监听会吞掉工具条的点击**，所以 `onClick` 里必须先判定 `bar.contains(e.target)` 并放行——注入式 UI 的必然代价。

**第五轮：常驻**（用户原话：「选择器可以常驻在窗口上了，开启后任意一个标签的网页元素都能选择、添加到对话，只是带上的元信息不同」）。四条：

1. **模式属于窗口，不属于某一次点击**。`BrowserInstance.picking` / `pickLabel` / `pickTabId` / `pickerGeneration` 四个字段。开关一次（`PICK_ELEMENT` 处理器 arm 后立刻返回，不再 await 一次 pick），此后**每一次点击都是一次命中**（第六轮起：点击先选中，添加由工具条的按钮报出），直到用户说停：在页面里按 Esc（页面报 `cancelled`），或再点一次工具栏按钮（`CANCEL_PICK` → disarm）。
2. **页面侧从"一次一个结果"改成"队列 + 状态"**。注入脚本的 `window.__craft_agent_picker_state__` 变成 `{ status, picks[] }`：常驻时命中只 push 不清理，`cancelPicker` 仍走 `finish('cancelled')`。CDP 侧多出 `armPicker`（注入并留在那里）与 `drainPicker`（**读走并清空**，一个表达式里做完，所以两次读不会读到同一个 pick，也不会漏掉两次读之间的那个）。一次性的 `pickElement`（agent 的 `browser_tool pick`）改成在 arm + drain 之上循环，行为不变。
3. **标签页跟着走**：切标签页（`activateTab`）、关活动标签页（`closeTab` 里邻居接位）、新开标签页都重新武装到新标签页，并把上一个标签页的 overlay 撤掉（`pickTabId` 就是为此存在的：要 disarm 的是 overlay 所在的那一页，而那时活动标签页可能已经换人）。**页面自己导航**（刷新、SPA 换文档）则由 `status: 'missing'` 兜住——drain 报"这个文档里没有选择器"，循环重新注入，而不是让模式悄悄失效。`pickerGeneration` 是这条的护栏：被接管的那一轮回来后发现自己已不是当前那一轮，就什么都不报，不会把"自己被拆掉"误读成"用户放弃了"。
4. **元信息随标签页不同**：每个 pick 带一个 `PickedElementOrigin`（`url` / `title` / `prototype` / `prototypePage`），由 `describeTabLocation(instance, tab)` 产出——它与 `toTabSummary` 是**同一个函数**，所以标签条说的"这是哪个标签页"和元素带来的"它来自哪个标签页"不可能不一致。它一路进到 chip（见 12.7.1）与 agent 读到的引用里。

**工具栏的 picking 是状态，不是本地判断**：`pushToolbarState` 里加了 `picking`，渲染器读它而不再自己记（Esc 在页面里结束模式这件事，只有主进程知道）。

**第六轮：点击是选中，添加是那条按钮上的一次点击**（用户原话：「浏览器窗口元素选择，应该由选中状态，选中后才能添加到对话」）。前五轮里一次点击就是一次添加，而"高亮框下方那条工具条"从第一轮起就在做同一件事——于是它既多余，也让人没法先看清选中的是哪一个再决定要不要加。这一轮把动作拆成两步：

- **点击 = 选中**。页面上因此有两种框：光标下的是**预览**（细虚线框 + 主题色的淡填充），点过的是**选中**（粗实线框，不上色），选中一直留到点了另一个元素（元素被页面重新渲染掉时随之消失）。它是这次交互的**状态**：回答"我正要加的是哪一个"，也是这一轮要的那个词。
- **配色跟着主题**：注入进页面的东西看不见应用里的 CSS 变量，所以 accent 由主进程解析成**具体颜色**再传下去（`getResolvedAccentColor()`，与 agent 操作遮罩同一个来源）——两个框的边框、hover 的填充、名字条与那颗按钮的底色都是它，窗口自身的配色和画在页面上的东西因此不会有两套。
- **只有那条按钮在添加**。工具条就是**那颗按钮本身**（后面没有一条黑色底板），挂在**选中**上（不再跟着光标跑），没有选中就不出现；报的仍是同一个 `intent: 'add-to-conversation'`，走的是同一条出口（`drainPicker` → 广播 → chip），协议与能力一个字节没改。**一次性的 `browser_tool pick` 不在这一步里**：那是 agent 在问"点一下"，一次点击就是答案。
- **光标落在 overlay 自己的东西上时不参与拾取**：工具条就在同一个 overlay 里，否则按钮会变成"被选中的元素"。
- **Esc 仍然结束整个模式**，不是只清掉选中——模式是窗口的状态，工具栏那句 `picking` 也要跟着变。

#### 12.7.1 元素以 chip 进输入框，且是追加

输入框的真值是**纯字符串**（`rich-text-input` 是原生 contenteditable，chip 只是这个字符串的渲染投影），所以一个"token"要活过一次字符串往返，就只能**是**字符串：元素以 `[element:<selector>|<text>|<url>|<prototype>|<page>]` 落进文本，各段都做 percent-encoding（选择器里本来就有 `[]`，而标记的正则读到第一个 `]` 为止）。

- **后三段是"来自哪一页"**（12.7 第 4 条），**没有就不写**：agent 自己的 `browser_tool pick` 只认得页面不认得原型，产出的就是短标记；两段的旧标记也照样读得回来。放哪：`renderer/lib/element-mention.ts` —— 编码 / 解析 / 查找 / 展开四个纯函数，带单测（含"带来源"、"没有来源"、"旧格式"各一条）。`findMentionMatches` 认得这个标记，但 `ComposerMentionType` 显式把 `element` 排在 `MentionItemType` **之外**：`@` 菜单永远产不出它，把它塞进菜单那个联合类型会误导读者。`rich-text-input` 的 badge 机制原样复用——同一套 `data-mention` 原子节点、同一套光标与选中处理——只多一个图标和解码后的标签。
- **谁看得见什么**：chip 标签取元素自己的文字，没有文字（图标、空容器）才退回选择器；hover 给选择器**加上**来源（`elementOriginText`，`demo / cart (https://…)`）——两个元素文字相同时，光有选择器还不够分辨。
- **出去时展开**：标记**不进消息**。`FreeFormInput` 在 `submitMessage` 与草稿快照两处把它换成 `browserEdit.elementReference`（没有来源）/ `browserEdit.elementReferenceFrom`（有来源，多一句 "— picked on …"）——模型该读到句子，不是 payload。来源进句子是因为**agent 没有别的办法知道是哪一页**：同一个元素可以在两页上被选中。
- **追加，不覆盖**：两条元素路径都改成非破坏式。"添加到对话"把 chip **追加**在草稿之后（元素是对正在写的问题的补充，所以问题必须活下来）；改动模式那条 prompt 以冒号结尾、等用户把话说完，所以**前插**在草稿之前（用户的草稿顺着读就是答案）。两条都走 `appendRestoredInput`，只是实参顺序不同；写完仍是 `onInputChange` + `craft:restore-input` 的"两步都写"，但两步带的是**同一个完整文本**，所以第二步不可能吃掉第一步。
- **落点 = 用户正在看的那个对话**（`focusedSessionId ?? session.selected`），不是窗口上的租约：窗口是共享的，`boundSessionId` 记的是"agent 刚才在动谁"，不是"人现在看着谁"。没有选中对话（或窗口是独立的一份）时就**新建**一个，chip 只在会话确实存在之后才写，所以创建失败不会留下半截草稿。

**已知取舍**：合并用的底稿取自 `getDraft`，而草稿有 300ms 防抖，所以在最后 300ms 内完成"打字 → 选择元素"会丢掉那几个字。实际路径要先移鼠标到面板、进选择模式、再点元素，这个窗口极小，因此没有为它新增一套"在活输入框里原地插入"的机制（那需要新事件 + 面板侧处理 + 未挂载时的兜底）。

**已知取舍（与 agent 的 `pick` 同时发生）**：两者要的是同一页上的注入，后开的会顶掉前一个。此时用户那一次点击仍然进对话（常驻循环先读到并 drain 走），而 agent 的 `pick` 一直等到超时。没有为此加互斥：两个入口都是"请人点一下"，为此让 agent 的选择请求在用户开着模式时直接失败，代价大于收益。

**未做**：从选择器直接截图。

#### 12.7.2 整个标签页也能进对话（同一套 chip，另一个标记）

> 用户定的：标签页本身也要能作为引用进对话——徽章下拉里那一行**右键**"添加到对话"，或者输入框里 `@` 选一个。
> 用户定的（用词）：这个东西就叫 **tab / 标签页**，不要另造 page/页 这套词——窗口里已经有 `tabs` / `BrowserTabSummary` / `tabAction` / `tab-show` 一整套。

- **两个标记，不是给元素标记加一种 kind**：标签页走 `[tab:<url>|<title>|<prototype>|<prototypePage>]`，与元素同一套编码/解析/查找/展开四个纯函数，放在 `renderer/lib/tab-mention.ts`（带单测）。`[element:…]` 说的是"这页上的这个东西"，`[tab:…]` 说的是"这一个标签页"——两件不同的事，混成一个标记会让"它到底指什么"变成要看字段才能回答的问题。末两段是**原型的那一页**（`prototypePage`），与"标签页"不是一个概念，名字照旧。
- **`@` 菜单**：`MentionItemType` 多一个 `tab`，一节 "Tabs"（排在 skills/sources/files 之后：标签页不是工作区自己的材料），标签取标题、副行取"它是哪个原型/哪一页"、没有原型才用地址——两个同名、甚至同为空白标签页的条目靠副行分辨。选中插入的是 `buildTabMention(tab)`：其它类型插的是 `[kind:id]`，而标签页不是能被查回来的 id（窗口的 `tab-N` id 是窗口的内部事），标记自带字段。标签页清单由 composer 自己从 `browserInstancesAtom` + 工作区过滤算出（和输入框里的浏览器状态条同一读法），不穿过四层 props——`useInlineMention` 只收 `tabs`，与 skills/sources/files 一样是**传进来的**。
- **标签页列表右键**：徽章下拉里每行一个 context menu，只有"添加到对话"一项。行本身是**显示那个标签页**（切标签页 + 把窗口带到前面，见 §22 那条修正），所以右键这件事与它天然不冲突：一个动窗口，一个完全不动窗口。落点是**用户正在看的那个对话**（`focusedSessionId ?? session.selected`），与元素共用 `appendChipToConversation`（追加、两步写、把光标送回输入框），所以"没有对话就新建一个"这条语义两处完全一致。
- **出去时展开**：`browserEdit.tabReference` / `browserEdit.tabReferenceFrom`（属于某原型时多一句"…的一页"）。**地址一律在句子里**：标题本身说不出是哪个标签页，而地址是它的全部身份。

## 13. 原型类型：overlay / scratch

> **§19 起这条分野下沉到页**：类型仍然"创建时定、不可改"，只是粒度从**原型**改成**页**——一个原型是同一条流程里若干页的集合，每页各自是 overlay 或 scratch。本节保留，因为它讲清了类型决定了哪四件事，以及为什么"让一个能悄悄产生废物的开关存在，比不让它存在更糟"——这两条与粒度无关，读的时候把"原型"换成"页"即可。唯一实质例外是"创建时必填地址"：创建原型不再问类型，那两张卡片搬到**新建页**对话框（§19.8）。

**问题**：§1 已经把分野定在**产物性质**上，但产品结构里没有它。创建时只问名字，于是「从无到有」和「patch 第三方」是同一个东西的两种**用法**——引导文案说不到点上，`targetUrl` 无处可存（导致详情页无法把那个页面重新打开，因为没人记得地址）。

**结论**：把分野提升为**原型类型**，在创建时确定、不可改。

### 13.1 为什么不是「一个标签」

类型决定四件事，全都是实质的：

| 决定 | overlay | scratch |
|---|---|---|
| **页面是什么** | **那个在线 URL 本身**（自带 JS、登录态与真实数据） | 我们自己写的那份文档 |
| **补丁打在哪** | 活页面，`apply` 注入进去 | 我们自己的文档，宿主渲染时内联 |
| **有没有外部页** | 有，而且是它的**全部**（行上的 `url` **必需**） | 没有（存 URL 是撒谎） |
| **交付物** | patches + dev-spec（写明改的是哪个地址）+ **可加载的扩展**（§17）+ **书签**（§17.9） | patches + dev-spec + **可加载的扩展**（自带这一页，§17）+ **静态单文件**（§17.8） |

第一行是这条改动最实际的收益：**"打开"的含义不再含糊**。以前两者都只能说"还没有 base 页面"；现在 overlay 打开的是它的活页面（并被注入补丁），scratch 打开的是服务器渲染出来的、它自己的文档。最后一行在 §17 展开：交付物面向两种人——dev-spec 给**实现的人**，扩展给**看的人**（他没有、也不该有工作台）；两种类型的差别只在于扩展是"注入别人的页面"还是"自带我们的页面"。

**创建时不预置任何页**：容器建出来**没有页**（连 `config.json` 都不写——没有东西可声明），缺席是一句**真话**（"这个原型还没有页"）；而 live 页本来就不需要一份文档——它的页面是一个地址。预置一份空白会断言一个不存在的状态：页表里凭空多出一行，"怎么拿到第一页"的引导被自己藏起来，导出还会照着一份空文档写一份空的交付物。

> 一句值得记住的判断：**"一开局所有动作都是灰的"该由入口解决，不该由假文件解决**——空文档只是把死胡同伪装成了一条路。首稿"写一份"与"复制一份"两条来路都在创建之后，这就是入口。（历史上有过别的解法，见 [开发文档](prototype-workbench-dev.md) §4。）

**我们自己那一页的首稿从哪来**（创建只负责建容器）：

| 来路 | 谁做 | 产物归谁 |
|---|---|---|
| **写** | agent 用文件工具写 `<页名>.html`（顶层每个 `*.html` 就是一页） | 我们 |
| **复制** | 列表右键「复制」：把一个原型整份拷成**新原型** | 那个新原型（见下） |

> live 页没有这一步：它的页面是一个地址，不需要被"准备"出来。"写"曾是界面按钮，现在不是了（§6 阶段 7）——界面上能看到的只有「预览 / 在对话里改 / 导出」。而"复制"相反，它是**列表上的动作**：复制走的是**一个原型**，不是一份材料。

### 13.1.1 复制与删除：原型列表的右键菜单

**问题**：搬材料式的做法有两个毛病。一是它回答的是"我要材料"，而人真正想干的是"我想要一份能接着改的副本"；二是它把**材料**与**身份**混在一个动作里——搬完之后目标原型的页表 / references 原封不动，只有页面和补丁换了，这在界面上完全看不出来。

**结论**：这件事是"另起一个"，并交回给人——**原型列表每行一个菜单（右键，或悬停出现的 `…`），两项：复制、删除**，实现是 `duplicatePrototype` / `deletePrototype` 两个只由控制面调用的能力。

三条边界，每条都有理由：

- **复制的是原型，不是材料。** 新原型有自己的 slug（默认 `<slug>-copy`，再复制一次就是 `-copy-2`）、自己的目录、自己的 `config.json`；页表跟着过来（每一页连类型与地址，它们是"同一件事的另一份"这个事实），从此两者**再无关系**：改任意一边都到不了另一边。这正是它与**参考**的分野（§14.2）——参考是"读它"，复制是"拿走它"。
- **不搬 `dist/`。** 交付物是派生的（`exportPrototype` 会照页面与补丁重建），搬过来只是第二份会过期的事实。`services/`（契约 fragment 与 fixture）属于原型本身，跟着走。
- **页面与补丁作为一对走。** 补丁的选择器绑在它被写时的那份文档上；整目录复制天然保持这一对，只搬一半必然留下对不上的东西。

**删除连目录一起删**——页面、补丁、契约、fixture、交付物全在内，不可撤销。所以这是工作台唯一一处**先问一句**的动作（`window.confirm`，写明删的是什么）。两条附带规定：

- **agent 没有删除命令，也不会有。** 删掉一个原型是"哪些原型存在"的决定，属于人：agent 可以重写原型里的任何东西，但不决定原型是否还在。
- **别的原型在文档里提到它时，谁也不会去改。** "在看什么"是一段文字（§14 的修订），不是一条存在某处的边：删掉一个原型，别的原型里那句话原样留着（它读起来就是"一个不在盘上的原型"），`status` 也不报它。替别人改写散文，比留一句已经不准的话更糟。

### 13.2 为什么创建时定、之后不可改

切换类型不是改个字段：overlay 的页面是别人的活地址，scratch 的是我们自己的文档——把前者改成后者，那些 patch 仍然指向一个不再被重放的页面，而画面上看不出来。**让一个能悄悄产生废物的开关存在，比不让它存在更糟。** 要换类型就新建一个，这是诚实的代价。

**"类型定死"顺带决定了地址必须必填。** overlay 页的页面就是这个地址；类型换不回来，所以一个**没有地址**的 overlay 页连"它是什么"都答不上来——没有能打开的东西（`pageAvailable` 为 false）、没有可写的导出物、`dev-spec.md` 里也没有地址可写。新建那一页是唯一"用户手里就正对着那个页面"的时刻，所以 `pages --add <name>=<url>` 缺 url 就拒绝，对话框在同一条件下禁用「新建」按钮。两处是同一个不变式，不是两份规则：入口不同（UI / 命令 / agent），规矩一条。

> 顺带把**默认类型**倒过来：默认是 `scratch`。理由不是"从零更常见"，而是**只有它不可能残废**——它拥有自己的文档，所以任何状态下都有下一步（写一份，或复制一份）；overlay 缺地址则一步都没有。没有任何出路的东西必须被**要求**，不能被**假设**。`DEFAULT_PAGE_KIND` 同时是"读不到页表里的 `kind` 时的假设"，于是坏配置的原型也落在同一条有出路的路上（§13.3）。

### 13.2.1 但地址**可以改**：环境切换

上面那句"创建时定"管的是**类型**，不管**地址**。地址不是一条规则，而是"那个页面在哪"这个事实——同一个页面存在好几套环境（本地 dev server、测试、线上），而同一批 patch 就是要在每一套里被看见。地址不可变会把"在测试环境看一眼"变成"再建一个原型、把东西全复制过去"，这是把一条事实当成了规则。

所以：`pages --change <页名>=<url>` 把**那个 overlay** 指到另一个地址（页名是必需的——页表就是名单），详情页的 **Pages 区块**里那一页也可以就地改（页行右侧的 Globe 按钮）。它只强制类型自身的规矩（scratch 拒绝、地址必须是浏览器能打开的 http/https），其余一概不拦。

> 两处入口共用同一层实现（`setPrototypePageUrl`）与同一句代价说明：命令把它打进输出，对话框把它写在输入框下面

> **后来的调整**：这条命令并进了 `pages --change <页名>=<url>`——`pages` 已经在管同一张表，而 `--add` 本来就带 `<name>=<url>`，改地址是同一份数据上的第四次编辑。原来那条"不按 `resolvePrototypeSlug` 解析"的取舍随之消失：页名进了 flag，位置参数仍旧留给 slug，所以它比原来多了一条路（`pages checkout-flow --change pay=…`）。

**改的时候要把代价说出来**（不是拦住，是说清），因为有两件事会**静默**过期：

| 会过期的 | 为什么它不会报错 |
|---|---|
| 已经打开的窗口 | 注入按 document 生效（§16.4），窗口停在旧地址上，直到它自己导航；`open` 一下才挪过去 |
| 选择器 | 它们是对着**当时那份 DOM** 写的。换环境可能换构建，同一个环境上线一次也会变；匹配不到的 patch 和"没生效的 patch"长得一模一样 |

这两条也正是"地址不动、站点自己变了"时会发生的事——所以它们是**提醒**，不是拒绝的理由。真正被拒的只有一种：往我们自己那一页上写地址（它的页面是自己的文档，存下来的地址是一句没人兑现的声明，§13.4）。

### 13.3 为什么落在数据层（而不是 UI 状态）

类型写在 `prototypes/{slug}/config.json` 的**页表**里，因为它有**四个读者**：详情页（引导文案/元数据/按钮）、agent 的 system prompt（`<prototype_context>`）、agent 命令（`pages --add <name>=<url>` 决定这一页是 overlay），以及导出器的分叉。放在 React 状态里这些读者就拿不到。

> 这与「索引不落盘、一切按需派生」不冲突：那条约束针对 `patches/`（多写者并发写，共享索引必然争用），而 `config.json` 是**控制面独占、单一写者、无派生数据**，正是控制面文件该有的样子。所有权矩阵里它已登记为 `control-plane`（§3.5），所以误改会被 `status` 点名。

读取**永不抛错**：缺文件、坏 JSON、未知 `kind` 一律回退 `DEFAULT_PAGE_KIND`。理由有二——配置不可读不该让原型不可用；该文件可被手工或外部工具编辑，畸形是**预期**而非异常。默认值是 `scratch`：坏配置的页于是落在"自己有文档"的那一支，下一步永远存在（写一份，或复制一份）；若回退到 `overlay`，它会缺一个换不回来的地址，直接把不可读变成不可用（见 §13.2）。

### 13.4 一处刻意的收窄

`normalizePrototypePages` 会**丢掉** scratch 页上的 `url`（那一行还在，被丢的是那句无法兑现的声明）。不是校验，而是不愿意落一条无法兑现的声明：scratch 页没有外部页面，存下那个地址只会让后来人以为某个地方会用到它。

### 13.5 未做的（明确记录）

- **类型不可改**（同上，有意）—— 无「转换类型」UI
- **overlay 页的地址：新建时必填，之后可改** —— 两件事不矛盾，管的是不同的东西：**必填**是因为新建那一页时你正对着那个页面，不填则这一页连"它是什么"都答不上来（§13.2）；**可改**是因为同一个页面存在于多套环境，那是事实不是规则（§13.2.1）。两条入口：**详情页 Pages 区块里那一行直接显示地址，旁边一个 Globe 按钮**（对话框里当场写清代价），以及 agent 侧的 `pages --change <页名>=<url>`。这不是新加的第 4 个动作——它长在**那份数据上**，而不是长在动作区（§6 阶段 7）
- **页的归属** —— 曾被列为未做（补丁不对应某一页，每一页重放**全部**补丁）；§19.4 给出了答案：`patches/<页名>/` 是页域、`patches/*` 是共享，根目录的语义不变
- **引导文案的图示** —— 两个类型卡片目前是图标 + 一句描述，没有"页面上叠一层 vs 白纸"的示意图
- **复制没有"合并"语义** —— 它是整个目录的拷贝，两个原型从此各走各的；要在复制上做取舍（合并补丁、挑着搬）不是能顺手决定的事，现在也不做

---

## 14. 混合场景：逆向第三方，然后搭自己的

**诉求原文**：「逆向第三方网站，然后搭建出自己的原型。可以选中、patch 第三方，然后作为 scratch 的参考资料。」

这句话里其实是**两种场景**，必须分开——否则会重蹈 D6 的覆辙（把两件事塞进一个维度）。

| | 那个第三方页最后变成什么 | 读法 |
|---|---|---|
| **A 起点** | 被吸收：写一份我们自己的文档（或用列表的「复制」另起一个），此后归我 | 「抄完就变成我的」 |
| **B 参考面** | 一直是旁证：躺在旁边，我另起一份自己的 | 「照着做，但不是它」 |

两者都做，且**都不需要第三种原型类型**。

> **修订（本轮：参考这一档撤掉）**：这一节描述的**参考关系**（`PrototypeConfig.references`）已**整条删除**——`prototype-reference` 命令与它的 help/示例、`linkPrototypeReference` / `unlinkPrototypeReference`（含 `BrowserPaneFns` 与 SessionManager 的接线）、`config.json` 里的 `references` 与 `normalizePrototypeReferences`、`status.references`、详情页那一整段、`list` 的 `references:` / `referenced by:`、`deletePrototype` 的 `referencedBy`，以及 `references.ts` 与 `references.test.ts`，全部不在代码里了。
>
> **为什么撤**：判据是这一档**没有任何东西指向它**。需求之所以立得住，是因为补丁与 finding 指着它，于是能说出"这条没人实现"；参考资料只有"盘上在不在"这一个失败态，本质是一次拼写检查。而它记的那件事——"我在看什么"——finding 的 `source:` / `evidence:` 已经记了，还多记了结果；唯一不可替代的是"从页面点进另一个原型"，而侧栏本来就有那个入口。（另一个诱因是它住在 `config.json` 里，让那份文件同时是"页表"和"关系表"两件事。）
>
> **改成了什么**：需求现在是**以 `PRD.md` 为入口的扁平文档集**（§20.1），"这个原型在看什么"就是集合里的一份普通文档（`references.md` 之类）；页面按集合文档渲染，里面的网址与文件路径可点。**那条最值钱的护栏没有丢**，只是换了位置：prompt 与研究块里写死"另一个原型的补丁**永远不许**抄进 `patches/`"（它们的选择器是照另一份 document 写的，不会在这里匹配，却会不打一声招呼进交付物），而 §14.3 的结构性一半（每份补丁只住在自己原型的 `patches/` 里）本来就不依赖这条关系。
>
> 下面各节**保留原样**，作为"做过、又撤了"的记录——§14.3 的护栏分析仍然成立，只是连接两端的途径从一条关系变成了一段文字；验收 B 组（§10 的 35–47）已按新形态改写。

### 14.1 读法 A 撞上了 §13.2，但解法不是放开类型

A 的路径天然跨类型：开始时在别人的页上打 patch（overlay），结束时拥有一份自己的文档（scratch）。而 §13.2 规定类型创建时定、不可改。

**正确的解法是让 scratch 页的首稿有来路**，而不是允许改类型：

- 新建一页时就选「我们自己的一页」，然后由 agent 写它，或把整个原型**复制**成一个新原型（§13.1.1）。`writePrototypePage` 本来就只依赖"目录在"，A 在机制上早已可用；要注意的只是措辞不能反过来禁止掉主流程。
- 探索竞品的过程发生在**另一个**原型里（就是 B 的参考）。于是 A 与 B 收敛到同一套结构，规则不用松。

`scratch` 的记录随之精确为：**那一页的文档归我们**——手写的、或是整份复制出来的都算；关键在于从那刻起它没有"要同步的对端"。

> **这一条走过一次弯路（已回正）**：曾经有过"把在线页冻成 `base.html`"这条来路。它回应的是一个**不存在的需求**——overlay 的页面就是那个地址本身，补丁打在上面，不需要一份 `base.html`；而冻出来的副本跑不了自己的 JS、也带不来会话。删掉的理由见 [开发文档](prototype-workbench-dev.md) §4。

**无条件覆盖的风险只剩一个入口**：页文档的写入（`writePrototypePage`）是无条件覆盖的，而真正会丢东西的情形只有一种——agent 手写覆盖一份**已有内容**的 scratch 文档。所以这件事是**对话约定**而不是命令层护栏：写之前先问一句；prompt 里相应的话是"do not overwrite a page of ours whose edits you would lose without warning"的等价措辞。

### 14.2 读法 B 不是第三种类型

用 §13.1 的自检（类型要决定哪四件事）：

| 类型决定的事 | 混合场景里的实际取值 | 和谁一样 |
|---|---|---|
| 页的文档从哪来 | 我们自己写的 | **scratch** |
| 交付物是什么 | 完整页面（本来就是源码） | **scratch** |
| 页的文档缺席意味着 | 还没写 | **scratch** |
| 有没有外部页 | 有，但是**旁证**而非交付对象 | 与 live 页的 `url` 语义不同 |

四行里三行与 scratch 相同。**加第三种类型等于把 scratch 的语义复制一份**，然后在对话框、prompt、status、ownership、导出里各加一个分支，只换来一个多出来的字段。

真正新增的只有两样：

1. **一条关系**（`references`）。而且**角色在边上，不在节点上**——同一个竞品页可以是 A 原型的参考，同时是 B 原型的交付对象。放进类型里就表达不了这个。关系是**单向**的：参考不知道自己在被参考，因为"两边看它"的人理由可以完全相反，而理由不是那个页面的属性。
2. **一条护栏**（见下）。

**这条关系与类型无关。** 我们自己页的引用另一个我们自己页的，和引用一个 live 页，是**同构**的：引用者与被引用者各自独立、各持自己的 `patches/`，就够了；两边各是什么类型，不参与判断。所以：

- 数据层不按 kind 分叉：`references` 对两种类型都读、都写
- 校验层不看 kind
- prompt 里的规则**只写一遍**——patch 不能搬运，与两边类型无关（live 页的页面是别人的活地址，我们自己页的页面是另一份我们的文档，但"选择器绑在另一份 document 上"这件事是一样的）
- UI 的参考列表对两种类型显示同一套动作，第二行说的是"打开它会落到它的哪一页"（`entry: <页名>`，没有页则是 `no pages yet`）——参考是什么由它的流程决定，报页比报一个缺失的地址有用

> **修订（参考不再限于原型）**：`references` 现在指向**材料**，不限于本工作区的原型——本工作区的原型 slug / `http(s)` 网址 / 文件或文件夹的路径（绝对、`~/…`、或相对工作区根）。**类型从目标推导、不落盘**（`describePrototypeReference`），所以没有新字段，也没有"这条参考是什么类型"的声明；写入**不再校验目标是否存在**——"我在研究的东西现在不在这儿"是正常答复，而悬空本来就容忍（§14.5）。于是上面几条要改读法：校验层不看 kind **也不看存在性**；UI 的参考列表**只读**（增删都归 agent 的 `prototype-reference`，一个写入者），第二行按类型说"打开会落到哪一页 / 是个网址 / 路径在哪、不在盘上则标红"。**§14.3 的护栏一个字没改，但它只对原型参考有意义**：网址与路径没有变更层，没有东西会被卷进交付物。

### 14.3 护栏：为什么参考必须独立成一个原型

`packages/shared/src/prototypes/export.ts` 的 `exportPrototype` 内联的是该原型 `patches/` 下**属于这一页**的文件（`patchesForPage` / `scanPrototypePatchesForPage`）。所以只要参考的 patch 和我的 patch 共用一个 `patches/`，导出时它们会被**打进我的交付物**：选择器指向竞品的 DOM，在我自己的页面上一条都不生效，而且**不报任何错**。

这正是这个项目一路在防的那类静默失效。于是：

- **结构性护栏**：参考**如果是一个原型**，它就是一个**独立的原型**（哪种类型都行），各自持有自己的 `patches/`；`linkPrototypeReference` 是连接两者的**唯一**途径——不是"建议这么用"，而是没有别的路可走。（参考是网址或路径时这条护栏不需要满足：它们没有变更层。）
- **语义护栏**：prompt 里写明参考是 `evidence, not material`，且**禁止**把参考的 patch 复制进交付物的 `patches/`（"它们的选择器是照另一份 document 写的，不会在这里匹配，却会不打一声招呼地进入交付物"）。结构性护栏挡得住机械错误，挡不住 agent 主动搬运，所以两条都要。

换来的是参考获得了**独立生命周期**：竞品会改版，参考会烂，所以它要能被重新打开、重新对照（overlay 参考打开的就是那个活页面，永远是最新版）；而一个交付原型可能参考三个竞品。

### 14.4 为什么落在数据层，以及命令面

`references` 写在 `prototypes/{slug}/config.json`，与 §13.3 同一个理由——它有多个读者：详情页（参考列表 / 打开）、agent 的 system prompt（每个参考带上它是什么、在哪，agent 不必去读对方的 config）、以及 agent 命令。

**写入收敛到 agent 一处**（本轮修订）：详情页原来是第二个写入者（关联已有原型、或新建一个原型当参考、逐条解除），现在**只读**。理由与"导入录屏改工具"同一条：一件事两个入口，就有一个会漂；而参考的增删本来就是 agent 在对话里做的事（「把这个也加进来参考」）。没有命令，agent 就会去手改 `control-plane` 独占的 `config.json`——正是上面那类损坏。所以命令面是两条：

| 命令 | 作用 |
|---|---|
| `prototype-reference <target> [--remove]` | 把 `<target>` 记为**会话所绑定原型**的参考（原型 slug / 网址 / 路径），并回报它被认成了什么 |
| `create … --no-bind` | 创建但**不抢绑定** |

第二条不是锦上添花，是必需：`create` 默认建完就绑定（§11 的设计），于是「先建一个参考原型」会把整个会话的默认目标悄悄换成被研究的那个页面——之后每条省 slug 的命令都打错地方。`--no-bind` 就是为了堵这个。

`prototype-reference` 的读者**只能是绑定原型**（不接受位置参数指定）：它的位置参数已经是参考本身，两个 slug 并列无法消歧。未绑定时报错并点名 `bind`，而不是猜。

### 14.5 未做的（明确记录）

- **非绑定原型的参考** —— 写入只剩 agent 一处，而 `prototype-reference` 只作用于**绑定原型**（它的位置参数已经是目标本身，两个 slug 并列无法消歧）。给一个不相关的原型加参考，办法是让一个会话绑定它。代价是真实的：原来 UI 侧不受限，现在这条限制成了唯一的写入路径的属性（§14.4）
- **悬空参考** —— 手工删掉参考原型的目录后，`references` 仍留着那个 slug。读取不做存在性过滤（不引入静默忽略），`describePrototypeReference` 会把它读成"一个不在盘上的路径"，prompt 与 `status` 都照实说；`--remove` 宽容这一点，所以清理有路可走
- **参考的 patch 对交付物的可追溯性** —— 「这条改动是从参考的哪一处翻译来的」没有落成数据，只在对话里

**一处有意为之**：不禁止**互看**（A 引用 B 且 B 引用 A）。关系是"看"而不是"属于"，两边互相参考没有矛盾，也不构成循环——prompt 只列直接参考，不会展开。唯一被丢弃的是**自引用**（`normalizePrototypeReferences` 在读取时丢掉自己），因为那在语义上是自相矛盾的。

### 14.6 agent 怎么看见这张图

关系存在数据里是**单向**的（角色在边上），但"感知一张图"要求**两端都可见**。所以 agent 的读取面分成三层，各自回答不同的问题：

| 读取面 | 作用域 | 回答什么 |
|---|---|---|
| system prompt · `<prototype_context>` | 绑定的那个 | **我绑定的这个有哪些页、它在参考谁**（每个参考都带类型与地址，agent 不必去读对方的 config） |
| `list` | 全工作区 | **这片工作区里有什么**：每个原型的页与类型、`references:` 与 `referenced by:` |
| `status [slug]` | 单个（可显式传 slug） | **这一个的全貌**：页表（每页的名字 / 类型 / 地址或文件 / 是否入口）、解析后的 references（含对方是什么）、以及 `referenced by:` |

三点设计判断：

1. **页的类型出现在每一层，而且不是脚注。** 之前 `list` 只列 slug 和 patch 数——一个 live 页和一个我们自己页在列表里**长得一模一样**，而它们的行为毫无相似之处（活地址 vs 我们的文档、地址 vs 文件）。这属于「状态撒谎」，不是缺个字段。列表里"缺什么"也按页说：一页都没有时说 `no pages yet`；某页缺地址还是缺文档，由 `status` 的 `pages:` 逐行说——对 live 页而言"没有一份文档"是常态，写出来只会训练读者忽略它。
2. **反向关系是派生的，不入库。** `referenced by` 由列表现算，不写进 `config.json`：写进去就有两个真源，而它们一定会漂移。代价是 `status` 要多读一次列表——值得，因为 `references: rival-checkout` 在你知道对方是什么之前**不可行动**。
3. **prompt 里不铺开整个工作区。** 工作区可以有十个原型，全列进 prompt 对多数会话是噪音；它还是会话开始时的快照，中途新建就过期。工作区级查询是**命令**的职责（工具描述里已写明 `list` 给出 kind 与双向关系），prompt 只负责绑定原型自己的事实。

悬空参考（原型目录被手工删掉）在这里**被点名**而不是静默消失：`status` 打印 `MISSING — no prototype with that slug`。这与读取时不做过存在性过滤是同一条原则——不让状态说谎。

---

## 15. 原型与项目：没有关系，而且不该叫同一个词

**问题**：这个工作区里有**两个不同的东西都叫 "project"**：

| | 项目（Project） | 原型（Prototype） |
|---|---|---|
| 在磁盘上 | `{workspace}/projects/{slug}/` | `{workspace}/prototypes/{slug}/` |
| 里面有什么 | `config.json` · `assets/` · `MEMORY.md` | `config.json`（页表）· 各页的 `*.html` · `_layout.html` · `patches/` · `services/` · `dist/` |
| 是什么 | **组织过程**：归组会话、任务（`TaskSpec.project`）、工作目录、共享资产、看板列 | **就是产物**：交付物本身 |
| 生命周期 | 可归档、**可删除**（删除时解绑会话） | 交付物，应当活过单个会话 |

**它们今天没有任何关系**，这不是疏漏：[workspaces/storage.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/workspaces/storage.ts) 的注释写明了原型放在工作区级是为了「让交付物活过单个会话」。原型侧的 `PrototypeConfig` 里没有 `projectSlug`（§15.1.4 撤回了那条边），`handlers/rpc/prototypes.ts` 与 `handlers/rpc/projects.ts` 互不调用，没有任何 join。

**唯一的实际交汇在会话上**：一个会话可以同时持有 `projectId` 与 `prototypeSlug`，于是两个 context 被并列注入 system prompt（`claude-agent.ts` 的 `pinnedProjectContext` 与 `pinnedPrototypeContext`）。所以 agent 确实知道「我在项目 P 下做原型 X」——但**这个关系不被任何一侧当作归属记录**：原型不记自己属于谁。它是会话上的两个点，不是一个连接。

> 上面这段是当时的实况，保留下来做对照。那条"原型属于项目"的连接后来建过（§15.1 的 `PrototypeConfig.projectSlug?`），又在 §15.1.4 撤回；留下的是项目侧那条**背景记录**（`ProjectConfig.prototypeSlugs`，§15.1.3）——项目可以说自己的工作在哪些原型上（一个集合），但不替会话绑定。

### 15.1 归属关系：先判死后又建立（本节记录这次反转）

**原文（当时的判断，保留）**：

> 判据还是那个：**什么变了？**
>
> 1. **目录嵌套（`projects/{p}/prototypes/{x}/`）不该做**：项目可删可归档，而原型是交付物——把交付物的路径挂在会被删除的容器下面是数据丢失隐患。
> 2. 若将来要连，正确形态是**一条关系**（`PrototypeConfig.projectSlug?`）：关系落在 config，删除时表现为悬空关系（点名，不静默丢弃）。这条留在纸上，随时可低成本实现。
> 3. 但**它唯一的读者是「按项目分组 / 项目详情页列出它的原型」**。原型还是个位数时这个字段没有消费者——按本方案的规矩（D12、派生索引），**没有读者的字段就是死字段**。等原型多到需要分组时再加。

**实际发生的是第 2 条，而且第 3 条等到的读者也来了**：项目详情页要回答"这个项目有哪些原型"，`projectSlug` 于是有了消费者，关系就按当时写在纸上的那个形态落地——一条边，不是嵌套。第 1 条仍然成立，一个字都没改：原型不在项目目录里，项目删了只是让边悬空，而悬空会被点名（`status.ts` 的 `briefIssues`）。

> **这条边后来被 §15.1.4 撤回了**：原型会被多个对话绑定，而那些对话可以属于不同项目，所以"这个原型属于项目 A"不是事实，"这个项目有哪些原型"也不是该问的问题。第 1 条仍然成立。

#### 15.1.1 这条边还能反着读：项目里的对话不用逐个绑定（"恰好一个"后来被 §15.1.2 整条撤回）

用户真正会问的第二个问题是"**这个项目里的对话该用哪个原型**"。答案**不另记一份**——项目配置里再存一个 `prototypeSlug` 就会和原型侧的 `projectSlug` 记同一件事，两边能互相打脸（原型说属于 A，A 说自己是 B）。这个仓库对这种事的态度是固定的：一个事实只留一个写入者（patch 索引不留 manifest 也是同一理由）。所以它是**派生**的：

```
resolveProjectPrototype(root, projectSlug)
  = listPrototypesForProject(...).length === 1 ? that one : null
```

| 项目下指向它的原型 | 结果 |
|---|---|
| 0 个 | 没有可继承的 |
| **恰好 1 个** | 该项目的会话**自动使用它** |
| ≥2 个 | 不作答——项目并没有指名一个，取第一个会让答案取决于目录顺序；"静默用错原型"比"没有原型"更糟 |

派生之外还有两条判断：

- **实时，不是创建时复制**（与 `workingDirectory` 的"新建会话时才抄一次"不同）：换项目原型时，项目里所有对话跟着换，早于这条边存在的对话也不用回填。
- **会话自己的绑定就是缺省**：`effectivePrototypeSlug` 只读会话的绑定（项目那一档已在 §15.1.4 撤掉）。覆盖手段是每条命令点名的 slug——原来的 `bind <slug>` 已删，绑定由人在界面里设（§11.4）。

读点只有三处，改这三处就全线一致（**窗口**的地址栏与两个原型动作、agent 的 `prototype_tool` 命令默认 slug、系统提示词里的 `<prototype_context>`）：`SessionManager.effectivePrototypeSlug` 一处，`getSessionPrototypeBinding` / agent 配置装配 / `getBoundPrototypeSlug` 三处调用它。渲染层不需要第二套逻辑——它手里的窗口信息（`toInfo().prototypeSlug`）本来就是主进程用同一个解析算出来的。

**但系统提示词是钉住的，不是实时的**：`claude-agent` 在会话第一次发言时把 preferences / project / prototype 三段一起钉住（`pinnedPrototypeContext`），理由是 SDK 的 resume 要求会话内 system prompt 稳定。所以"换了原型"这件事会出现一个缝：窗口和命令已经是新的，提示词里那段散文还是旧的。

处理方式与 preferences 漂移**同一套**，而不是偷偷改提示词：agent 通过 `getPrototypeSlug`（宿主给的活回调，不是那份创建时的快照）现算当前原型，与钉住的不同就发一条 `info`——提示这个会话的原型变了、提示词里仍是旧的、要新建会话才会重建。三个后端行为因此是：

| 后端 | 提示词里的原型 |
|---|---|
| `claude-agent` | 首次发言钉住；变化时发一次 `info` |
| `pi-agent` | 每轮重建，因此每轮现算（本来就该如此；这一步顺带把"每轮"从"每轮读旧快照"修正成"每轮读当前值"） |

`getPrototypeSlug` 只此一个用途，所以两边都不会在提示词里说谎：宿主只说当前值是多少，要不要重建由 agent 按自己的约定决定。

**写入路径**：原型详情页与项目详情页都通过 `prototypes:setProject`（与 agent 的 `prototype-project` 是同一个 `setPrototypeProject`）。一个原型只能属于一个项目，所以"把 X 归到本项目"如果 X 已有归属，是**移动**——菜单在点击前就这么写。**（§15.1.4 把这条写入路径与它的两个界面入口一并删掉了。）**

> **后来整条撤了**（§15.1.2）："恰好一个才作答"与它的继任者"项目声明一个"都被删掉。上面这段保留原文，正是要留下"当时为什么只能这么做"——那时想把"项目有哪些原型"告诉会话，只有替它挑一条路；现在有了第二句可说（**有哪些**），就不必挑了。

#### 15.1.2 项目不替会话挑原型：把"有哪些"作为背景告诉它（本节记录 15.1.1 的撤回）

> **本节的前提已被 §15.1.4 撤回**：它建立在"原型侧记一条边、据此反查这个项目有哪些原型"之上，而那条边没有了——原型不属于任何项目。下面的原文保留做对照。

**问题**：§15.1.1 把"项目里的对话该用哪个原型"做成一条派生规则（**恰好一个**才作答）。它假设一个项目同一时间只推进一个原型；而一个产品线同时跑几个需求是常态，于是多原型项目得到的答案是**"什么都没有"**——提示词里没有、`list` 不标。边本身从来没禁止多个原型指向同一个项目，卡住的只是"哪一个"。

**试过一版"项目声明一个"，撤了**：项目配置里存 `defaultPrototypeSlug`，项目页"设为当前"、对话侧菜单再加一组、agent 侧配一条 `prototype-default`。它能工作，但回答的是"**项目替会话挑一个**"——而挑就是猜，为这一个答案要多付：一个配置字段、一个受校验的写入者、一条 RPC 通道、一条 agent 命令，外加"声明的那个后来被移走了"的悬空故事。同一个理由也适用于 §15.1.1 的"恰好一个"：它同样是项目替会话挑，只是依据从"人说"换成"只有一个"。

**现在：项目只提供信息，不提供选择。**

| 谁 | 说什么 |
|---|---|
| 原型 | `config.projectSlug` —— 我属于哪个项目（§15.1 的边，唯一事实） |
| 项目 | **不存任何"哪一个"**；成员由那条边反查（`listPrototypesForProject`） |
| 会话 | 按名调用（每条命令点名的 slug）；绑定由人在界面里设（§11.4），agent 没有绑定命令 |

列表随 `<project_context>` 进系统提示词（`ProjectPromptContext.prototypes` → `<project_prototypes>`），并带上那句必须说的话：**这里一个都没绑定给你**——要用哪个就点名，`list` 看当前有什么。多原型项目因此不再"什么都不给"，同时没有任何一处替会话做决定。

**会话只有两种状态：绑了某个，或没绑。** "恰好一个就自动继承"随声明版一起退掉：它会造成更糟的状态——一个原型时自动生效、三个时完全不生效，而"没有依据可挑"这件事恰恰被"告诉它会有什么"解决了。

**代价（明写）**：单原型项目里的对话不再开箱即用某原型，`apply` 不带 slug 会要求点名或绑定。换来的是没有任何一处静默选了原型，而 agent 知道它存在（提示词里就写着），一句话就能用上。

**也没做的**：把会话可达的原型扩成 `会话绑定 ∪ 项目成员`（并集）。页层面的可达性规则已经覆盖了大部分（不属于任何原型的页谁都能用、自己开的页归自己，§22 的"多绑收口"早已说过这不需要新字段），而 ∪ 会把"我在几个原型上工作"变成会话层的第二个隐性状态。要在对话里动另一个成员的原型页面：**从菜单切过去**（一步、显式）。

**边界**：注入的是**列表**，不是每个原型的详情（§22 的"集合只需被点名，细节现查"）；块是会话开始时的快照，所以那句话里写明 `list` 看当前有什么。

**随之删掉的**（代码里已不存在）：`ProjectConfig.defaultPrototypeSlug`、`setProjectDefaultPrototype`、`resolveProjectPrototype`、`projects:setDefaultPrototype`、agent 的 `prototype-default`、渲染层的第二份规则（`pickDefaultPrototype` 及其子路径导出）、对话侧菜单的项目组与"设为当前"的全部界面。开发文档的墓园里有这一条。

#### 15.1.3 项目可以说自己"在哪个原型上"：背景信息，不是替对话点名（本节记录 15.1.2 的一条放松）

> **本节的一半已被 §15.1.4 撤回**：项目侧那条记录保留，但"成员资格"——原型侧的 `projectSlug`、成员列表、"原型必须属于该项目"的校验——随那条边一起删掉了。下面保留原文做对照。
>
> **记录本身的形状后来又改了一次**：不是一个"当前原型"，而是一个**集合**（`ProjectConfig.prototypeSlugs: string[]`，提示词里是 `<project_prototypes>` 的一列）。项目同时在几个原型上工作是常态，没有哪一个在前；界面是复选框多选，全不勾就是清空。下面正文里的 `prototypeSlug` / "在哪个原型上" / `<project_prototype>` 都按这个读。

**问题**：§15.1.2 把"项目不说哪一个"立成规矩，代价当场写明——单原型项目里的对话不再开箱即用，`apply` 不带 slug 就要求点名或绑定。实际用起来，这一步落在用户身上：一个项目正在推进哪个原型，是**项目的事实**，不是每个新对话各自要重新声明的东西。

**因此加回一个项目级记录，但它不是 15.1.1 那条派生规则，也不是一个"当前原型"的指定。** `ProjectConfig.prototypeSlug`：项目记下自己在哪个原型上。成员资格仍然是另一条边，仍然只回答"有哪些"。

| 谁 | 说什么 |
|---|---|
| 原型 | `config.projectSlug` —— 我属于哪个项目（§15.1 的边，从没变过） |
| 项目 | `config.prototypeSlug` —— 我在哪个原型上（§15.1.3 新增，显式写） |
| 会话 | 自己绑，或按名调用 —— **没有变** |

**它是背景信息，像接了一个数据源**：会话从 `<project_context>` 里的 `<project_prototype>` 读到"这个项目在哪个原型上"，仅此而已。**由它产生的自动行为是零**：不注入那个原型的 `<prototype_context>`、不注入指南、不进 `prototype_tool` 命令的默认 slug（`effectivePrototypeSlug` 仍是一行，只认会话自己的绑定）。指南全文只在**会话自己绑定**时注入（`prompt.ts` 的块与 `system.ts` 的 `worksOnPrototype` 都只认绑定）。一句话：项目可以**说**它在哪，不能**替对话点名**。

**也仍然没做的**：把会话可达的原型扩成"会话绑定 ∪ 项目成员"。记录不是可达性：它只进提示词里的一段背景，不进任何默认值，也不会让一个原型变成"这个会话正在做的"。

**写入校验两端**（`setProjectPrototypes`，`prototypes/project-link.ts`）：项目要存在；不在的原型**过滤掉而不是报错**——背景信息不值得一个失败提示，读取端（`getProjectPrototypes`）对同一种情况也回答"没有"，两端一致。入口：项目页 Prototypes 标签的复选框（写的是一整个集合，全部取消就是清空）。**（§15.1.4 后：成员校验随边一起消失，只校验原型存在；入口只剩项目页的勾选，命令删掉了。）**

**代价（明写）**：它不能替任何人省掉第一次点名——新对话仍然要自己绑或按名调用。换来的是"项目在做什么"这件事有了一个可读的地方，而没有引入第二个"默认原型"。

#### 15.1.4 原型不属于任何项目：那条边与"成员资格"一并撤回（本节记录 §15.1.1–§15.1.3 里关于边的部分的撤回）

**问题**：§15.1 建立的那条边（`PrototypeConfig.projectSlug`：这个原型是为哪个项目做的）隐含一个判断——**归属**。它不成立：一个原型会被**多个对话**绑定，而那些对话**可以属于不同项目**。同一个原型同时服务两条产品线是常态，所以"它属于项目 A"既不是事实、也不需要；真正的事实是"某个对话此刻在哪个原型上"，那已经由会话自己的绑定回答了。

**原型不记自己属于谁。** 于是删掉的是一整条链：

| 删掉 | 原来在哪 |
|---|---|
| `PrototypeConfig.projectSlug`（原型 → 项目的那条边） | `prototypes/config.ts`（读写与 normalize）、`project-link.ts` |
| `getPrototypeProject` / `setPrototypeProject` / `listPrototypesForProject` | `prototypes/project-link.ts` + barrel |
| `PrototypeStatus.projectSlug` 与"项目已删除"的悬空点名 | `prototypes/status.ts` |
| `<project_prototypes>`（"这个项目有哪些原型"）与 `ProjectPromptContext.prototypes` | `prompts/system.ts` 的 `<project_context>` |
| `<prototype_context>` 里"这个原型属于项目 X"那段（连同"哪边放新文件"） | `prototypes/prompt.ts` |
| `prototypes:setProject` 通道、`setPrototypeProject` 预加载 API、原型详情页那一行、项目页的成员列表（加入 / 移出 / "当前在 X 项目"） | 协议 + 渲染层 |
| agent 的 `prototype-project` 命令与它的三个 `BrowserPaneFns` 回调 | `prototype-commands.ts` / `browser-pane.ts` / `SessionManager`（当时是 `browser-tool-runtime.ts` / `browser-tools.ts`） |

**留下的是 §15.1.3 的那条记录，而且它变简单了**：`ProjectConfig.prototypeSlug`——项目在哪个原型上，由用户在项目页手动勾选，只作为**背景信息**告诉它自己的对话（`<project_prototype>`）。不绑定任何对话、不注入任何原型的上下文或指南、不进任何默认值；也不需要再校验"原型属于该项目"（那个概念没有了）。**不存在的原型一律过滤，不报错**：写入时记不进（等价于清掉），读取与注入时按"没有"回答——两端一致，所以勾到一个刚被删掉的原型只会什么都没记下，不会报错。

**代价（明写）**：项目页不再能列出"这个项目的原型"——那个列表本来就在回答一个不成立的问题；要找原型用 `list` 或搜索。`<prototype_context>` 里"哪边放新文件"那段也随边消失，两段上下文各自说清自己的目录。项目侧那条记录仍是钉住的（与 details / memory 一样），所以会话中途改它不会进这一轮提示词。

**一句话**：项目可以**记**自己在哪个原型上（背景），原型**不记**自己属于谁。

### 15.2 同时：把命名分开

"prototype project" 这个说法让两个概念在代码里长得像一回事。已改为一律说 **directory**：

| 改前 | 改后 |
|---|---|
| `getPrototypeProjectPath()` | `getPrototypeDirPath()`（与 `status.dir` 同名语义） |
| `createPrototype as createPrototypeProject` | `createPrototype as createNewPrototype` |
| 注释/JSDoc 里的 "prototype project"、"Absolute project directory" | "prototype"、"the prototype's directory" |
| 局部变量 `projectDir` | `prototypeDir` |
| **给模型的文本**："Prototypes — **one project per requirement**…" | 改为显式排除混淆：**"A prototype is NOT a project: projects are separate containers…"** |

最后一行是这次改名的**主要理由**，不是顺带：这段文本进的是 `browser_tool` 的工具描述，**永远在上下文里**；而模型同时还看得到真实的 `<project_context>`。两个"project"同时出现时，模型没有任何线索能分清。

### 15.3 未做的（明确记录）

- ~~**原型按项目分组/过滤**~~ —— 已做，但形态变了：项目详情页的"原型"标签页现在只回答"**这个项目的工作在哪些原型上**"（勾选出来的一个集合，`ProjectConfig.prototypeSlugs`，§15.1.3／§15.1.4）。会话**不继承**任何原型（§15.1.1 建立过继承，§15.1.2 撤回，§15.1.4 把"成员资格"也删了）
- ~~**`browser-tools.md` 缺原型基础命令的章节**~~ —— 已做：原型有一份自己的指南 `apps/electron/resources/docs/prototypes.md`（`list` / `create` / `pages` / `entry` / `open` / `apply` / `clear` / `record` / `sample-video` / `verify` / `contract-*` / `mock-*` / `export` / `status` 全在里面），`browser-tools.md` 的 `prototype_tool` 一节指向它

---

## 16. scratch 文档的载体：Electron 直接应答 http

> **适用范围**：这一节只讲 **scratch**。overlay 的页面是它自己的在线地址（§13.1），真实站点本来就有 origin、cookie 域和能跑的相对 fetch，不需要这里任何东西。这一节解决的是"我们**自己写**的那份 HTML 拿什么当 origin"——答案是 `http://<label>.localhost`，由 Electron 在浏览器 session 上自己应答。

**问题**：scratch 的文档要的不是"一个能打开的地址"，而是一个**真的 origin**。opaque origin（`file://` 那类）缺的东西，正好是这条链路依赖的：

| 缺什么 | 后果 |
|---|---|
| 没有 cookie 域 | 无法模拟登录态；`document.cookie` 写不进去 |
| **相对 `fetch`/XHR 发不出去** | Blink 直接拦掉 file→file。**mock 层因此永远看不到请求** |
| ES module 被 CORS 拦 | `<script type="module">` 不执行 |

第二条是决定性的：§5 的整条「契约 → mock → 前端」闭环，在这种文档上完全不可用——不是 mock 写错了，是请求压根没发出来（`browser-cdp.ts` 靠 `Fetch.enable` + pathname 匹配，它只能看见 renderer 真正发出的请求）。

**影响范围只有一笔**：我们自己的原型文档。overlay 主路径在真实页面上是**真 http**，patch 注入按 document 生效与 scheme 无关，截图/DOM/pick 都不受影响。

### 16.1 为什么是拦截 http，而不是本地监听器

两个方案都能给出"一个真的 origin"，差别在**地址稳定性**与**失败面**：

| | 本地监听器（弃用） | 拦截 `http`（采用） |
|---|---|---|
| origin | `http://<label>.localhost:<port>`，**端口每次启动都变** | `http://<label>.localhost`，**稳定**；cookie 与 localStorage 因此跨重启 |
| 谁在真实浏览的路径上 | 没有人（独立 socket） | **我们**：handler 按 scheme 注册在浏览器 session 上，该 session 里每个 http 请求都先经过它 |
| 非我们 host 的请求 | 与本方案无关 | `net.fetch(request, { bypassCustomProtocolHandlers: true })` 原样交回 Chromium |

采用拦截，是因为**地址稳定是功能**（登录态、`localStorage`、一个能贴进对话的地址），而"别人页面的请求经过我们这一层"是可以接受的代价——前提是把代价钉死：**只拦 `http`**（原型 host 就是 `http://…localhost`，`https` 一个字不碰）、**不属于我们的 host 一律原样交回**、**handler 永不抛异常**。细节与理由都在 `prototype-host.ts` 的模块说明里。

**自定义 scheme（如 `craft-proto://`）不采用**：注册成 standard 后 Electron 确实会打开 localStorage / sessionStorage / indexedDB 甚至 cookies，所以"没有存储"不是理由；真正的理由是它把请求换成了非 http scheme，而 mock 层靠 CDP `Fetch.enable` 在网络层按 pathname 兑现响应——这条链路对自定义 scheme 是否生效必须实测，否则正好废掉 §16 存在的两个理由（cookie 与 mock）。

### 16.2 地址形状的前提已验证

`*.localhost` 在 Chromium 里解析到回环，所以不需要 DNS 或 hosts 条目；一次性 Electron 探针在这样一个地址上确认了 origin / cookie / 相对 fetch / `type="module"` 四条全部正常（探针与结论见 [开发文档](prototype-workbench-dev.md) §2）。这四条是主机名的性质、与端口无关，所以现在地址里没有端口也一样成立。

**还没实测的一条**：pass-through 是否无损（分块上传、流式响应、下载、HTTP 缓存）。它属于"真实窗口里点一遍"的清单，见 [开发文档](prototype-workbench-dev.md) §5.4。

### 16.3 地址形状：一个原型一个 host，目录即 origin 根

```
http://<slug>-<目录hash>.localhost/                 ← 原型的首页（见下）
http://<slug>-<目录hash>.localhost/<原型内文件路径>   ← 原型里的任意文件
```

**根路径是原型的"首页"，两种类型各有确切含义**（就像一个扩展的 home page：一个地址代表它自己，而不是一个没人应答的地址）：

- **首页是页索引，或者你指定的那一页**（§19.3）：默认渲染宿主生成的列表页；某页标了 `entry` 就落到它——scratch 页是**该文档 + 它生效的全部 patch**、按请求现算，overlay 页是 **302 到它的真实地址**。scratch 这一侧带的是**此刻**的补丁，所以"我在看的东西"就是"我会交付的那批改动"（交付物包里的那一页是同一份文档，另加扩展要求的改写——内联脚本提成文件、补丁改成文件引用，见 §17.1：同一批补丁、同一顺序、行为相同，字节不同）。这条替换掉了原先那种二选一——**裸文档**（一条 patch 都没有）与**上次导出的文件**（冻结在导出时刻）都不是这个原型。
- **overlay 页的首页指向自己的真实地址**：页面本身仍在它自己的地址上（cookie、登录态、源都必须是真的），host 只负责指过去。于是 `/` 在这些原型上不再可能是一个 404 的地址——"打开这个原型"与"取这个 URL"第一次不是同一件事。
- **每一页都有稳定地址**：overlay 的页按名字挂在根下，`/<页名>` → 302 到该页真实地址；页名一层深（`/orders`，不含 `/orders/42`——更深的路径属于应用自己，在它自己的 origin 上）。**文件优先于页名**：目录里真有一个 `orders`，就发那个文件。
  > 这个 302 是给**别的加载器**的（扩展、直接取这个地址的调用方）：窗口自己不用它——工具栏敲 `/<页名>` 时主进程直接解析出那一页的地址让视图加载（§12.6），少一跳，也不受"注册即边界"（§16.6）影响。

单个文件仍然可以按名字取用，各种地址含义如下：

| 地址 | 是什么 |
|---|---|
| `/` | 首页（§19.3）：默认是**页索引**；某页标了 `entry` 时 = 那一页（scratch → 渲染结果，overlay → 302 到它的真实地址） |
| `/_index` | **页索引**本身，永远可达——配了入口之后，要看有哪些页就走这里 |
| `/<页名>` | overlay 的那些页（302 到该页真实地址）；scratch 页没有页名——它的页就是文件（`/cart.html`） |
| `/cart.html` | **这个原型的一页**：同一套规则（该文档 + 生效补丁，现算）。顶层每个 `*.html` 都是一页（§19.2） |
| `/base.html` | 只是名字叫 `base` 的一页。§19 起 `base.html` 不再特殊——"裸底稿"这个调试地址随之取消 |
| `/dist/extension/` | **交付物包**（§17）：manifest、补丁脚本、README，scratch 页各自一份产物 |
| `/dist/extension/cart.html` | 包里那一页：**同名构建产物**（带补丁、内联脚本已提成文件）。名字不变是为了让页间链接零改写；`export` 打印的是入口那一份（旧数据提升后它叫 `base.html`）。旧路径 `/dist/prototype.html` 不再有人写 |
| `/assets/app.css` 等 | 目录内的静态资源 |

**原型目录就是那个 host 的根**，而不是挂在某个路径前缀下。理由不是美观：页面的 `src="/assets/app.css"`、`fetch('/api/orders')`、路由器的 `/orders` 都指向 **origin 根**，而页面并不知道也不该知道自己被放在子目录里。带前缀（`/prototypes/<slug>/…`）会让"假设自己拥有 origin"的页面全部坏掉——那是绝大多数页面。

host 里两半各答一个问题：**目录 hash** 保证唯一（两个 workspace 可以都有 `checkout-flow`，把其中一个的页面喂给另一个是静默换文件），**slug** 让它在日志和对话里可读。

**没有任何东西可以顶替它**。交付物包里的那一页（`/dist/extension/base.html`）仍然可以按名字取用（想看交付物就看），但它是**旧状态的快照**、也不是一个能继续编辑的页面，所以它永远不是"这个原型的页面"。因此 `base.html` 不在时：**scratch** 的根 404（`Nothing to serve`），`resolvePrototypeEntry` 抛错并点名三条来路——而不是拿别的东西冒充；**overlay** 的根不依赖 `base.html`（它指向入口页），没有 `targetUrl` 时同样明确报错。

**overlay 的窗口地址栏也读作原型域名**（§12.6）：它的 `tabView` 停在第三方地址上（必须如此），而窗口的身份是这个原型。它的 `/` 因此不是"渲染结果"而是**指向入口页**——两件事在同一个地址上并存：面板里敲它 = 打开这个原型（§7），别的东西取它（agent 的 `navigate`、任何直接请求）= 302 到那一页。

**这同时修掉了一个说不清的入口**：早先的规则在有 base 时才给 origin、否则退到交付物，于是"打开"这个词在不同原型上指向**两种不同的东西**（一份活文档 / 一份冻结制品）。现在它只有一个意思：**打开 = 打开这个原型当前渲染出来的样子**，可以在上面继续改、继续打补丁。

### 16.3.1 SPA

| 场景 | 处理 |
|---|---|
| 打开 `/`（scratch） | 返回渲染后的原型页面 |
| 打开 `/`（overlay） | 302 到入口页——根永远有指代，从不 404 |
| 打开 `/<页名>`（overlay） | 302 到那一页；没有同名文件时才这么做（文件优先） |
| history 路由刷新（`/orders/42`，scratch） | 无对应文件时回退到**同一个渲染页面**——这是 SPA 的路径，服务端不认识 |
| **标了扩展名的路径**（`/missing.js`） | **不回退**，老老实实 404。用 HTML 回答缺失的脚本，会把"文件没了"变成"解析错误" |
| 根绝对路径资源（`/assets/app.css`） | 按目录内路径查找并**正常命中**——这条是"目录即根"的直接收益 |

这也让**从零写的 SPA 文档**第一次真正可用：它的 `pushState` 路由刷新能拿到文档，它的客户端路由能起来。

### 16.4 代码上的接法

**一处注入**：主进程启动时用 `prototype-host.ts` 的 `registerPrototypeProtocolHandler(session.fromPartition(BROWSER_PANE_SESSION_PARTITION), req => net.fetch(req, { bypassCustomProtocolHandlers: true }))` 把 `http` 接下来，再由 `installPrototypeBaseUrlResolver()` 让共享层能问出地址。共享层两个出口：`prototypeOriginUrl()` 给"原型页面"，`prototypeDocumentUrl()` 给"某个具体文件"。`resolvePrototypeEntry()` 与 `exportPrototype()` 都走这里，所以 `open`、RPC `prototypes:entry`、详情页 Open 按钮三处入口**一行都不用改**。

**没装上 handler 时 resolver 返回 null**，入口**明确报错**——那时没有能显示补丁的地址，端出一个"看起来像原型、其实一条 patch 都没应用"的页面只会更糟。

**渲染用的是导出器那一个函数**：`buildSelfContainedHtml(baseHtml, scanPrototypePatches(...))`。导出 = 把它写进交付包，预览 = 把它当响应体返回。同一份变换，所以"看到的"和"导出的"不可能分叉。

### 16.4.1 已经内联的补丁不会被重复应用

"打开的就是打了补丁的预览效果"与"打开后还能继续应用编辑"是同一个问题的两面：页面到手时补丁**已经在文档里**了，此时再注入一遍会让 JS patch 跑第二遍——**页面看起来一模一样，改动却是错的**，没有任何东西会报出来。

**做法是让文档自己说明它带了什么**：`buildSelfContainedHtml` 在有补丁可内联时，额外写一个标记元素

```html
<script type="application/json" id="__craft_prototype_inlined__">["A-001-btn.css","B-002-total.js"]</script>
```

注入前先读它（`buildInlinedPatchProbeScript()`），**跳过列出来的那些，其余照常注册并立即执行**。读不到、读不成 JSON、不是字符串数组，一律当作"这份文档什么都没有"——这是唯一安全的方向：反过来（默认已应用）会让该做的活被静默跳过。

两条设计要点：

- **判断读的是文档本身，不是地址。** 标记随文档走，所以另存出去的渲染页、上一次会话留下的副本，同样认得出。
- **注册集合与"页面上缺什么"严格对齐**：每次 apply 都是「清掉本原型的全部注册 → 只注册缺的那些」。init script 是 window 级的，注册一次会在之后**每个** document 上执行，若已内联过的也注册，重新加载出来的渲染页就会跑第二遍；顺带这也保住了"删掉 patch 文件就真的不生效"。

### 16.5 边界（五条，各自有测试）

1. **只有注册过的 label 由我们应答**：注册发生在"某个原型被打开/导出"时，我们从不遍历文件系统去找东西服务。没注册过的 host——包括 `a.b.localhost` 这种多标签名——一律**交回 Chromium**：`*.localhost` 上跑着真实 dev server 是常态，把这种地址当成"没人发放过的名字"去 404，等于把别人的页面弄坏了。
2. **只拦 `http`**：原型 host 就是 `http://…localhost`，所以 `https` 流量完全不经过我们。
3. **路径围栏**（`resolveServedPath`，独立导出单独测）：解码后拒绝 NUL 与反斜杠（Windows 上反斜杠是分隔符，放过一个就能绕过前缀检查），`resolve` 折叠 `..` 后必须落在目录内，前缀比较用 `${root}${sep}` 以免同名兄弟目录（`checkout-flow-secrets`）蒙混。
4. **`Cache-Control: no-store`**：文档与补丁在被反复编辑，缓存住的页面会显示上一次的结果而没有任何提示。
5. **handler 不抛异常**：我们这一侧的失败答 500 并记日志，不让别人的页面吃到一个来路不明的网络错误。

### 16.6 未做 / 已知限制

- **我们站在真实浏览的路径上**（http 那一半）：别人的请求由 `net.fetch` 交回网络栈，但"交得是否无损"要在真实环境点一遍——分块上传、流式响应、下载、HTTP 缓存。这是换到拦截的代价，不是待修项；清单见 [开发文档](prototype-workbench-dev.md) §5.4。
- **注册即边界**：地址跨重启不变，但可达性不跨会话——上次那个地址在重新打开该原型之前答 404（注册发生在"被打开/导出"时）。
- **这套应答只管 scratch 页**：overlay 页的文档是它自己那个在线地址，从头到尾不经过这里（只有 scratch 页会被渲染）。所以"相对资源打到我们这里"这类问题只可能出现在 scratch 页上，而它们的资源本来就在自己的目录里。
- **`/` 的含义是"这个原型的首页"**：默认页索引，或页表里标了入口的那一页（§19.3）。索引是**按请求生成**的，没有落盘的 index 要同步。
- **改了已有补丁的*内容*，页面不会自己变**：页面是在渲染那一刻内联的，`apply` 只补"页面上还没有的"（按文件名判断，见 §16.4.1），所以新增的那条立刻生效、改过内容的那条要**刷新**才看得到。没做内容指纹是刻意的：按内容只能判断出"页面上的版本旧了"，而正确处理只有重新渲染一条路——那和刷新是同一件事，多一层判断只多一处能错。
- **判别只认文件名，不认版本**：把一个补丁文件删掉再写一个同名的，同样会被算作"已内联"。这是上面那条的另一面，不是独立缺陷。
- **没动的东西**：`webSecurity` 仍未开（D5），没有新增 partition；真实页面浏览路径除了"每个 http 请求多一次 host 判断"之外零改动。

---

## 17. 交付物：一个原型一个扩展

**问题**：§13.1 把 overlay 的交付物定成「patches + dev-spec」，可这两样都是给**实现的人**的，不是给**看的人**的。真实场景是「让设计/老板/同事看见效果」，而对方没有这个工作台——他不该为了看一眼而装 Electron，我们也不该要求他这么做。scratch 那一侧同理：自包含 HTML 能"打开就看"，但它进不了真实产品的上下文。

**结论**：交付物是**一个可加载的 Chrome 扩展**——**一个原型一个扩展**，生成到 `dist/extension/`，在 `chrome://extensions` 里 Load unpacked。不进商店、不发布、卸载即消失；**Chrome 只是运行载体**。

| | overlay | scratch |
|---|---|---|
| 扩展做什么 | 把补丁注入**真实页面** | **自带那一页** |
| 怎么打开 | 打开目标页即可，没有要点的东西 | 扩展的 **options 页 = 这个原型的页索引**（§19.5）：点一页过去；工具栏图标打开首页入口 |
| content script | 有：`matches` = 这个原型的所有页；CSS 在绘制前注入、JS 在 `document_idle`；每个匹配文档自动注入，SPA 换视图由 bundle 重放 | 没有（没有别人的页面可注入） |
| mock | 带（§17.2） | 带 |

**落盘形状**：`dist/extension/` 里有 `manifest.json`、`README.md`（装法 / 作用范围 / 每一页 / 改了哪些补丁 / 版本与构建时间 / 已知边界）、补丁与 mock 产物（共享，在包根各一份），scratch 另有**每一页**（文件名不变，页间链接零改写）与每页自己的提取产物（`assets/<页名>/`）；`dist/dev-spec.md` 留在原型层，不进扩展包——它是给实现的人的，不是给运行载体用的。

**交付物是"载体"而不是"页面"**：overlay 的页面是别人的活页面，我们永远交不出那个页面，只能交出叠加在上面的改动。载体用**内容脚本**而不是注入进页面的脚本，于是三条一起成立：页面 CSP 管不到它、一次注入对该文档持续有效（刷新与翻页都不必再点）、内容不必塞进一个 URL（体积预算因此不存在）。删掉的那些载体的账见 [开发文档](prototype-workbench-dev.md) §4；扩展与书签这两条**现役**路的对比见 §17.9。

**为什么不是别的**（都算过账）：

| 备选 | 为什么不行 |
|---|---|
| `service worker` | 管的是扩展自己的生命周期与消息，**改写不了别的页面的响应** |
| `declarativeNetRequest` | 只能重定向/改头，**不能合成响应体**；GET 靠重定向到包内文件还能糊，POST 直接歇 |
| `webRequest` 阻塞模式 | MV3 **已对普通扩展移除**，只剩企业策略安装的扩展能用 |
| `chrome.debugger` | 能拿到完整 CDP（等价于工作台内那套），但要 `debugger` 权限，评审人打开页面会看到"正在调试此浏览器"横幅，且 **DevTools 被占住** |
| sandbox 页 | 无视扩展 CSP，内联代码全都照跑；代价是 origin 变成 opaque：没有 `localStorage`、ES module 与相对 fetch 不可靠——**而内联代码不必走到那一步**（§17.1） |

### 17.1 agent 的契约不变

**第一原则**：agent 只写「一份完整 HTML 文档」，它**不需要知道**扩展、CSP、manifest 或 options 页的存在。扩展带来的约束全部由**生成器**吸收；吸收不了的**报给用户**，而不是回头要求 agent 改写法——要求 agent 记住一条扩展规矩，等于把实现细节漏进它的心智，而心智负担正是这一轮要压掉的东西。

| agent 会写 | 扩展里会发生什么 | 谁吸收 |
|---|---|---|
| 内联 `<script>…</script>` | 扩展页不允许内联脚本 | **生成器**：提取成文件、改引用（机械，只改引用不改行为） |
| 内联 `on<event>="…"` | 同上 | **生成器**：代码提成生成函数 + `data-` 标记，配一个 MutationObserver 运行时按标记绑定（**不需要 eval**，运行期插入的 HTML 也命中） |
| `<script type="module">` | 内联的被拦 | **生成器**：提取成文件（属性保留） |
| 内联 `<style>` | 照常 | MV3 对扩展页没有 `style-src` 策略 |
| `localStorage`、包内相对 fetch | 照常 | 扩展页有完整 origin |
| `eval` / `new Function` | **过不去**（MV3 硬禁） | 不吸收：原型页用不到，不进设计 |

这就是"交付物与工作台所见**行为一致**"的兑现方式：唯一不同的一步是"内联脚本变成文件"，而它只改引用、不改行为。

### 17.2 mock 一起交付（默认带）

工作台里「契约 → mock → 前端」是一条正经路径（阶段 5）。交付物里若没有 mock 层，按这条路径写的原型**交付出去就是坏的**，而 agent 不会知道——所以默认带。

- **怎么拦**：`world: "MAIN"` 的内容脚本包装页面自己的 `fetch` / `XHR`，命中路由直接返回包里的 fixture。它是 app 内那套（CDP `Fetch.fulfillRequest`）的等价物，只是拦截点从网络层挪到页面里；**响应头由我们控制**，可以照着真实 API 的 CORS 形状伪造。
- **为什么不用 `chrome.debugger`**：它能拿到完全一样的 CDP 能力，但会挂调试横幅并占住 DevTools（见上表）。
- **说清哪部分是假的**：README 里列出被伪造的路由。"这一行数据是造的"不是实现细节，正是评审的人该知道的事。
- **边界**（写进 README，不藏）：只盖 `fetch` / `XHR`；`<img>` / `<script>` / WebSocket / `sendBeacon` 盖不住（本来也不该 mock）；**真实产品若是 PWA，由它自己的 service worker 发起的请求盖不住**。

### 17.3 这给 patch 改的作者规矩

| 规矩 | 为什么 |
|---|---|
| **可重跑** | 每个匹配文档都会注入一次，SPA 换视图会重放，Reload 扩展也会 |
| **不假设 document-start** | 它是**编译选项**而不是约束：CSS 走 content script 的 `css`（绘制前），JS 走 `js`（`document_idle`） |
| **没有死补丁** | 质量要求（不是硬约束）：交付物里的一切都要有人读 |

### 17.4 快照语义与版本号

交付物是**某一刻的快照**：改一条补丁要重新导出，并在 `chrome://extensions` 点 Reload（已打开的页面还要刷新）。静态扩展没有"实时"，所以包里带 **version + 构建时间**（version 由导出时刻推出、README 写明），让"我看到的和你说的不一样"有一个能回答的问法。

### 17.5 组织方式：一变更一文件，产物才是单一的

**否决了「让 agent 永远只编辑一个 js」**，代价是具体的：

- **一个文件 = 一个写者**，直接杀掉写入身份的所有权（文件名里的 writer 前缀就是为它存在的）；两个 agent 同时改一个文件就是静默丢更新。
- **丢掉「删文件 = 撤销一条改动」**，这是现在最便宜的 revert。
- **交付物变差**：dev-spec 按 patch 列全文，一个不断膨胀的 js 会让"这个流程到底改了什么"不可读。

需要单一的是**产物**（扩展里的那一个脚本 / 那份 manifest），不是**源码**。也要说清反面：一个原型只有一条 patch 是**允许**的，小流程本来就该长这样。规矩是"一个变更意图一个文件"。

### 17.6 不引入 git

- **变体**已有更便宜的答案：再建一个原型，并把它写进 `PRD.md` 旁边那句"在看什么"（§14 的修订）。每个变体可独立打开、独立导出，不需要 checkout。
- **合并**在模型里是违规而不是工作流：`whyWriterMayNotWrite` 直接拒绝并报出来。
- **历史**：dev-spec 每次导出就是一份可 diff 的全量记录；原型是纯文件，workspace 若在用户自己的 git 仓库里，天然被版本化——**不需要我们写一行代码**。
- 值得偷的 git 思想已经有了：append-only 文件 + 派生索引 ⇒ 删文件即撤销；复制原型即分支。
- 真正的缺口不是 git，而是**两个人同时改一个原型**——那才需要合并，等遇到再说。

### 17.7 未做 / 已知限制

- **扩展的签名与分发**：没有图标资源、没有 zip 打包、没有企业策略分发。`Load unpacked` 对内部评审够用；要发给外部的人，得手动传目录或压缩包。**不做商店上架**（这是产品决定，不是待办）。
- **patch 之间没有冲突检查**：两条补丁改同一个元素时，谁赢由重放顺序决定（折叠层最后 → 序号 → 路径），没有检测也没有提示。这与 §3 的所有权模型一致（同一路径只有一个写者），但**不同文件改同一处**仍可能互相覆盖。
- **内容指纹**：交付物里的补丁不参与"是否已应用"的判断（靠的是 `window` 上的安装标记，不是内容）。改了一条补丁的内容，评审的人要重新导出并 Reload——这是必然的，交付物是**快照**，与 §16.4.1 的"按文件名算已内联"是同一类妥协。
- **生成器吸收不了就会说**：内联事件的处理、模块脚本的提取都是文本变换，遇到它没把握的写法时**报出来**给用户看，而不是猜。这是这条路上唯一会让人"手动改一改"的地方。
- **桌面限定**：Chrome / Edge 这类 Chromium 系可加载 unpacked；Safari / Firefox 不做。

（落点——改了哪些文件、每处改什么——见 [开发文档](prototype-workbench-dev.md) §1／§2；验收见 §10 的 M 组（63–70）与 Q 组。）

### 17.8 第二种交付物：静态单文件（`dist/static/`）

**问题**：§17 的扩展是**载体**，它承载的是**交不出去的那一半**——overlay 的页面是别人的活页面，只能在它自己的地址上改，除此之外没有第二条路。可 scratch 那一半本来就是**我们自己的文档**：为看它一眼要求对方 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序，是一个对面没有收益的成本；而"打开就看"这件事在 §4.1 被 §17 取代之后就没有出口了（那条路上写的 `dist/prototype.html` 已无人再写）。

**结论**：交付物是**两份**，各覆盖自己能覆盖的那一半。

| | `dist/extension/` | `dist/static/` |
|---|---|---|
| 是什么 | 可加载的扩展（载体） | 每页一份自包含 HTML |
| 覆盖谁 | **全部页**：overlay 靠注入，scratch 靠自带文档 | **只有 scratch 页** |
| 怎么用 | 装扩展 → 选项页（页索引）或工具栏图标 | 双击那一份文件，或直接发给别人 |
| 依赖 | Chrome，且装着这个扩展 | 无：无宿主、无服务、无扩展 |
| 没有的情况 | —— | 全是 overlay 页时**没有这一半**（`staticPath` 为 null），不写空目录 |

**为什么 overlay 没有**：把在线页面冻成一份 HTML，跑不了它自己的 JS、也没有它的会话，只会"看着像"——§16.3 的 `resolvePrototypeEntry` 已经因为同一个理由拒绝过它。所以这条边界不是省略，是事实。

**两份产物都带得动图片，差别只在"怎么带"**：扩展包把原型自己的 `assets/` **整份按字节原样拷进去**（`/assets/logo.png` 在扩展页里解析到包根，文件在那儿就显示得出来）；静态那一份把它 base64 内联进 HTML（单文件没有可解析的目录）。整份拷而不是按扩展名筛，是因为"哪些文件被页面用到"从标记里答不出来——脚本会拼 URL、样式表会引字体——而按 utf-8 往返一次正是把 png 弄坏的写法。

**变换用的是预览的那一个**：`buildSelfContainedHtml()`（§4.1／§19.2）——同一份补丁（按页取）、同一份顺序、同一份内联方式，所以"打开的那份文件"与"作者预览到的页"不可能分叉。预览由宿主提供的两样东西，在这一份文件里必须自带：

- **mock 层**：`buildMockScript()` 内联成 `<head>` 开头的一段脚本——要早于页面自己的代码抓到 `fetch`；扩展里这条是 `document_start` + `world: "MAIN"`，同一个理由。
- **一个能解析的目录**：页面写的 `/assets/app.css` 在扩展页里解析到**包根**，在 `file://` 下解析到**磁盘根**——所以引用要内联。规则是"**解析到本原型目录内的文件就内联**"：文本与二进制一律 base64 data URL（`#fragment` 保留，`?query` 丢弃）；**页面文档除外**——那是同目录的兄弟文件（`<a href="orders.html">`），内联它等于把一次导航换成一份副本；写成根绝对的 `/orders.html` 则改成相对名（同一个理由：`file://` 下它指向磁盘根）。页面文件名不变，所以页间链接零改写，与扩展包同一条规矩。

**说不了谎**：解析不到的本地引用**点名报出来**（`staticWarnings`，与扩展侧的 `warnings` 分开——两份交付物的改写理由不同，一个标题盖不住两者），而不是留一条打开即断的链接。已知代价写在模块注释里：内联脚本的调用栈里是 data URL，且文件比各部分之和大约三分之一。

（落点见 [开发文档](prototype-workbench-dev.md) §1；`dist/static/` 出现在 `status` 的 `dist:` 列表里，`export` 的输出会打印它的路径与先打开哪一份文件。）

### 17.9 第三种载体：书签（bookmarklet）

**问题**：扩展是 §17 定的载体，也是更好的那个，但它有一个前提——**这台机器允许加载未打包扩展**。真实场景里不总是：托管的企业浏览器、对方锁死的笔记本、只是想看一眼的人。而 overlay 那一半要做的事是**把代码送进别人的活页面**，而送进去的路不止一条。

**结论**：多给一条路，但不假装它等价。原型有 live 页、且该页有东西可打时，`export` 额外写 `dist/bookmarklet.html`：**一页一条可拖拽链接**，外加同一份代码供控制台粘贴。代码与扩展是**同一份**（`buildPatchBundle()` + `buildMockScript()`），所以两者不可能行为分叉——不同的只是"代码怎么进页面"。

| | 扩展 | 书签 |
|---|---|---|
| 页面的 CSP | 管不到（浏览器注入） | **管得到**——书签是页面里的内联脚本，`script-src 'self'`（GitHub、Gmail、多数银行）直接拒绝，什么都不会发生 |
| 每个文档 | 自动，刷新也在 | **每次都要点**，而且每页都要点 |
| 体积 | 文件，没有预算 | **URL 预算** |
| 前提 | 能加载未打包扩展 | 无（能往书签栏拖一条链接即可） |

**一页一条链接，而不是一条通吃**：content script 由 Chrome 按地址划作用域，书签没有这个能力——它作用于你点它的那一页。要做"一条通吃"，就得把每一页的补丁都塞进去、在点击时按地址挑一份，而挑错的形态正是这套东西一直拒绝的那种：**静默地把另一屏的改动打上去**。所以链接按页命名、地址印在旁边，把"作用域"变成读者的选择，而且看得见。

**它自己说明它做不到什么**：页面里写清三件事——页面策略可能拒绝（那就粘控制台，同一份代码）、每次刷新都要重点、mock 层在点击时才装（之前发出的请求不会被伪造）。不写清楚，这三件都会变成"这个原型坏了"。

**没有 live 页就没有这一份**：书签的作用就是把改动打进别人的活页面，全是自己的页时它无事可做；而一个点了什么也不发生的书签比没有书签更糟——它看起来像成功了。所以那时不写文件，并把上一次导出留下的删掉。

---

## 18. 多页面原型：页是原型的一部分

> **§19 起本节被页层模型取代**：页的判定、地址、页与补丁的归属、交付物按页打包，一律以 §19 为准。本节保留的是它提出的问题和两条仍然成立的结论——**页是原型的一部分（不新增一层身份）**，以及 **overlay 的页表按声明序而不是字母序**。三处已被推翻："scratch 的页表决定不做"（现在有顺序与入口要管，`config.pages` 是两个类型共用的表）、"补丁按页切分要等元数据"（目录即归属，§19.4）、"`base.html` 是入口页"（入口是页表里的一行标记，§19.1）。

**问题**：一个原型是一条**流程**（购物车 → 地址 → 支付），而"一个原型 = 一个文档"这条假设写在三个地方，于是多页只能靠"一页一原型"或"假装成 SPA"绕过去：

| 位置 | 原状 | 后果 |
|---|---|---|
| 原型文档的应答（当时的 `prototype-server.ts`） | 只有**根路径**渲染（base + 全部 patch），其它 `.html` 按文件裸发 | 目录里放第二张 `orders.html`，补丁一条都不进去——多页 scratch 是**残的** |
| `config.json` | overlay 只有**一个** `targetUrl` | 跨页流程在真实站点上是多个 URL，原型无处声明"我包含哪几页" |
| 面板 / `PrototypeStatus` / prompt / 导出 | 全是单文档视角 | 讲不清"这几页各改了哪些东西"，交付物也只能一页一份 |

**结论**：页是原型的一部分，**不新增一层身份**——不是"一页一原型"，也不是新的 kind。

**① 页的判定规则**（`pages.ts`，服务端与状态报告读同一条规则、同一份事实）：

- **scratch**：目录里**顶层**的每个 `*.html` 都是这个原型的一页；本节当时把 `base.html` 当**入口页**（§19.3 改成"入口是行上的 `entry` 标记，没标时给生成的页索引"）。页就是文件，加一页 = 写一个文件 + 从别处链过去，不需要声明、也不会漂移。
- **overlay**：页是真实站点上的 URL。站点不是我们能遍历的，所以页来自配置 —— `config.json` 的 `pages`（见 ⑤）。
- **不是页的两种文件**：下划线开头的（`_layout.html` 与宿主保留地址 `/_index`）与子目录里的文档（资源，§19.2）。本节当时还额外把 `base.html` 排除在页外（"作者编辑的裸底稿"），那个特例随 §19 一起取消了；`dist/**` 同样不是页（导出时冻结的交付物——把今天的补丁灌进昨天的快照是对两者的双重谎报）。

**② 注入泛化到每一页**（`filePayload` → `buildPrototypePage`）：任何一页都按根路径同样的方式服务——该文档 + **该页生效的**补丁（共享 + 该页自己的，§19.4），按请求现算。这是多页 scratch 能用的**前提**：否则第二页没有补丁，而"没有补丁"和"补丁没匹配上"长得一模一样。

**③ `PrototypeStatus.pages`**：入口在前，其余按**流程顺序**（表里的声明序；没人声明的文档按名字接在后面），每页带 `name / kind / file / url / entry`。命令和输出共用这一份列表：`status` 列出 `pages:`，`open --page <name>` 打开其中一页，名字不存在时**把可选项列出来**（而不是只说不行）。读不干净的 `pages` 条目会被丢弃并进 `pageIssues`，由同一份报告点名。

**④ agent 知道"现在是哪一页"**：`snapshot` 的 `Prototype` 行带上 `page "<name>"`，由 `matchPrototypePage` 从窗口的**真实 URL** 反推。我们自己页上未列出的路径算入口页（宿主正是用入口文档服务 history 路由）；**live 页不这样兜底**——`/login?next=…` 不是原型描述的那一屏，说它是，就把那个值得注意的重定向藏起来了。

**⑤ 页表（`config.pages`，本节当时是 overlay 专有；§19.1 起两个类型共用）**

> 形状以 §19.1 为准：每行带自己的 `kind`，入口是行上的 `entry` 标记，没有顶层 `kind` / `targetUrl` 了。下面是本节当时的形状，保留作对照：

```jsonc
{
  "kind": "overlay",
  "targetUrl": "https://app.example.com/cart",   // 当时：入口页，唯一表示
  "pages": [                                      // 其余页，按流程顺序
    { "name": "address", "url": "https://app.example.com/checkout/address" },
    { "name": "payment", "url": "https://app.example.com/checkout/payment" }
  ]
}
```

- **入口只写一次**，表里不许重复它（写了就丢弃并报告）。流程顺序 = 声明序。少了这条，入口就有两份表示，必然漂移。
- `name` 是命令与输出用的短名（`open --page address`），必须唯一且非空；空/重复的条目丢弃并报告，而不是替调用方猜一个。
- 每个地址都要过得了 `matchPatternForUrl`（http/https）；过不了的那一页在**导出与状态报告里点名**，绝不静默少注入一页。
- 它同时是三个既有出口的数据源，而不是新机制：`status` 的 `pages:`、`open --page <name>`、`snapshot` 的 `page "<name>"`（`matchPrototypePage` 本来就是通用比较，此前只认得一页纯粹是因为页表只有入口）。
- 命令：`pages`（无参数列出；`--add name=url`、`--remove name`、`--rename old=new`、`--change name=url`）；改入口是 `entry <name|none>`。

**⑥ 载体投影**

- **live 页**：页表摊平成 match pattern 集合交给扩展——每个真实页都在注入范围内，而"哪一页"由 Chrome 按 `matches` 强制。§19.4 落地后补丁也按页取了，所以每页带的就是它自己那批。
- **我们自己页**：页集合由"顶层 `*.html`"（加页表里的声明）给出，交付物按**同一个集合**打包：每个有效页一份（文件名不变，所以页间相对链接零改写）、入口那一份就是"地址根打开的东西"（`entry` 那一页，否则 `options_ui.page` = 页索引）、工具栏图标开入口页，README 的 `Pages` 按同一份列表列出。每页自己的产物（提出来的内联脚本、事件处理运行时）落在 `assets/<页名>/` 下——否则两个页的 `inline-1.js` 会互相覆盖；补丁与 mock 是**共享产物**，在包根放一份（mock 是原型的属性而不是某一页的属性）。

**落点**（改了哪些文件、每处改什么）见 [开发文档](prototype-workbench-dev.md) §1／§2；验收见 §10 的 Q 组（86–93）。

**页与补丁的归属（当时是"下一步"，§19.4 已给出答案）**：不引入共享清单（那会推翻 append-only / 无共享文件这条根基）。当时的结论是"注入仍然全量重放，归属只为了 dev-spec 能说清这一页改了什么"，并且以为它需要**补丁元数据**；§19.4 的做法更省——**目录即归属**（`patches/<页名>/` 管这一页，根管共享），既不用清单也不用元数据，而且顺带让注入也按页取。

**未做（当时）→ 后来各自有了结论**：

- **scratch 的页表**：当时决定不做，§19 起两个类型**共用一张页表**（`config.pages`），因为顺序与入口这两个收益确实有了消费者。
- **补丁的页归属 / 按页切分**：§19.4 用目录做归属，不再需要元数据。
- **面板的页列表**：已完成——详情页的**页索引**就是页的落点（事实、动作、新建页都在那里）；侧栏只列原型，两级下钻已撤销（§19.9）。

---

## 19. 页层模型：页有类型，原型是一张页表

> 已实现。落点（改了哪些文件、每处改什么）见 [开发文档](prototype-workbench-dev.md) §1／§2；验收见 §19.10 的 94–100。两处与本节的偏差记在最后：一级行的点击、以及索引页只带共享补丁。

**问题**：§13 把类型放在**原型**上，§18 把"页"提升为原型的一部分——两条各自成立，合起来错在同一处：**类型描述的是"一份文档"的性质，不是"一个容器"的性质**。三个证据都是"用户想做的事在模型里没有地方放"：

| 想做的 | 今天的模型 |
|---|---|
| 一条流程里三张自己写的屏 + 一张真实站点的支付页 | kind 只能选一个：要么整条流程都是 overlay（那三张屏无处落），要么整条都是 scratch（那张真实页无处落）。§14 只给了**参考**（读它），没给"同一流程里的异质页" |
| 换掉首页入口 | 入口 = `base.html` 这个**文件名**（§18 ①）。换入口就要改文件名，而文件名同时是导出路径与页间链接的锚 |
| 说清"这一页改了什么" | 补丁没有页域，全量重放（§18 未做）。dev-spec 只能一整段列补丁 |

**结论**：`kind` 从原型**下沉到页**；原型是**一张有顺序的页表**，表里每一页各自是 scratch（我们自己的文档）或 overlay（某个真实地址）。

### 19.1 数据形状

`config.json`（仍是控制面独占、单一写者）：

```jsonc
{
  "pages": [
    { "name": "cart",   "kind": "scratch", "entry": true },   // file 不写：名字就是文件名 → cart.html
    { "name": "orders", "kind": "scratch" },
    { "name": "pay",    "kind": "overlay", "url": "https://app.example.com/pay" }
  ]
}
```

三条不变式：

- **scratch 页不写 `file`**：名字即文件名（`cart` → `cart.html`）。写下来就是第二份表示，必然漂移。overlay 页**必须**写 `url`——那是它的全部。
- **表序即流程顺序**：§18 ⑤ 那条规矩（"流程顺序是它被写下来的顺序，不是字母序"）从 overlay 的页表扩到整张表。
- **入口是行上的一个标记**（`"entry": true`），不是文件名、也不是一个指向别处的名字：它只能是某一行，所以"入口指向一个不存在的页"这种坏状态不存在。多行都标了 → 取表序第一个并报告。

### 19.2 文件与表：文件是存在性的事实，表是顺序与入口的事实

```
prototypes/<slug>/
  config.json                 页表 + references；控制面独占
  _layout.html                可选：scratch 页的共享布局（单一插槽）；下划线开头 = 不是页
  cart.html  orders.html …    scratch 页：顶层文件，文件名即页名 → 导出与页间链接零改写
  patches/cart/*.css|js       只在这一页上重放的补丁
  patches/*.css|js            每一页都重放的补丁   ← 根 = 共享，与旧数据语义完全一致
  services/…  dist/…          原型级（契约、mock、交付物）
```

- **不在表里的顶层 `*.html` 自动成为一页**（scratch，名字 = 词干），排在声明页之后、按名字排序。§18 那条"写个文件就生效，没有清单要维护"是这套模型最值钱的性子，不能为了顺序与入口把它丢掉：**表管顺序与入口，文件管存在**。
- **表里声明、文件却不在**的 scratch 页 → 进 `pageIssues` 并**照旧列出**（`file: null`）。一个页文件被删掉是值得知道的事，不是应当消失的事。（这只可能来自手改配置——见 19.8 的 `--add` 规矩。）
- **不是页的两种文件**（§18 的规则不变，换了理由）：下划线开头的是**布局与宿主保留地址**，子目录里的文档是**资源**。
- **布局只有一个插槽**：`_layout.html` 里写 `<slot name="page"></slot>`——**HTML 自己的写法，不是我们造的语法**（agent 不必学新东西，将来布局真要做成 Web Component 也不用改写）；请求时宿主把页文档替换进去，纯文本替换、只认第一次出现。旧拼写 `<!-- @page -->` 仍然读：否则旧布局会被当成"没有插槽"，而那条兜底是"整篇当布局"，页就被静默丢掉了。注意布局里任何地方都不能再出现插槽字面（注释也不行），否则第一次匹配会落在注释里。**不引模板引擎**——作者面必须仍然是最终产物（一份完整 HTML 文档），否则 agent 要学一套我们自己的语法，而导出还得反过来把它还原。组件复用停在"页共享一个布局 + 页自己的资源引用"。

**实施时的两处修订**（落地后与上面那段的差别，两条都改了默认值与作用域，机制没变）：① **创建不再预置布局**——新建原型只建目录与 `patches/`，`_layout.html` 在"两页要重复同一段标记"时才写。prompt 里原本就是这条约定（两页会重复同一段标记就写 `_layout.html`），与它相反的只是默认值。② **"按页选布局不做"收窄为一个布尔 opt-out**：页行 `"useLayout": false` 表示共享布局不套这一页，该页按原样送出（宿主与导出走同一条判断）。判据是：**不同页可以是完全不同的设计**（一封邮件、一个落地页、别人产品的一屏），布局套上去就是替它做决定；而"这一页要不要布局"是**页自己的事实**，写在页表里只有一个写入者，读盘上的形状解释不出来（完整文档今天一律吃布局）。于是"完整 html 被套进 slot"这件事只发生在**选择共享这个框**的页上，不选择它的页完全不进 slot。多插槽、按页命名布局文件、继承链仍然不做——那一步走出去，"作者面 = 最终产物"就不再成立。

### 19.3 `/`：默认页索引，入口可配置

| 页表 | `/` 是什么 |
|---|---|
| 没有任何行标 `entry`（默认） | **页索引**：宿主生成的列表页——每页一行（名字 / 类型 / 地址或文件） |
| 某一行标了 `entry` | 302 到那一页：scratch → 渲染结果（文档 + 全部生效补丁），overlay → 它的真实地址 |

- **索引永远可达**，地址固定 `/_index`（下划线开头 = 不是页，与布局同一条规矩）。所以"配了入口"只是换掉 `/` 的默认落点，索引谁也没有被顶掉。目录里真有一个 `_index` 文件时**文件优先**（§16.3 的规矩一贯）。
- **默认给索引而不是给入口**，是因为**一张表里没有哪一页天然是第一页**——§18 靠 `base.html` 这个文件名假装有。宿主生成索引就是"还没有做出的那个决定"，而把某一页设成入口随时可以做（`entry`）。
- **入口页的文件不在时不静默退回索引**：报错并点出是哪一个页名。§16.3 那句"没有任何东西可以顶替它"在这里同样成立——退回索引会把"你的入口页不见了"变成"你的入口配置没生效"。
- 已经配了入口、又要拿索引（面板、扩展 options、只想知道有哪些页的调用方）→ 走 `/_index`。
- **索引页不带补丁**（实现时的收窄）：它是宿主生成的文档，不是作者的页，所以只带共享补丁的范围概念对它不成立——零补丁。旧行为会给它全部补丁，那是"全量重放"时代的残留。

### 19.4 补丁的页域：目录即归属

- `patches/<页名>/*` 只在该页重放；`patches/*`（根）在**每一页**重放。**根 = 共享**，所以旧数据**零迁移**：今天所有补丁都在根，语义一模一样。
- 归属只影响 dev-spec 与状态报告的**分组**，不影响注入正确性（补丁本来就必须防御式书写，不匹配即静默无害，§18）。所以它是一条**组织约定**而不是新机制：没有清单、没有索引、没有争用——`patches/cart/` 与 `patches/orders/` 是不同目录，§3.5 的写入身份所有权照旧一行生效。
- **`patches/<页名>/` 里的页名必须对得上一个页**；对不上（`patches/nope/`）就报出来：补丁落在没人看的页上，是这个模型最贵的那种静默失败。判据只有一条——目录名与页名同名。

### 19.5 交付物与扩展（对 §17 的修订）

| | 页是 scratch | 页是 overlay |
|---|---|---|
| 扩展做什么 | **自带那一页** | 把补丁注入那一页的**真实地址** |
| content script | 没有 | 有，`matches` 覆盖该页 url（`world: "MAIN"` 的 mock 照旧） |

- **仍然一个原型一个扩展**（§17 的结论不变），变的是包内**按页分文件**：每页一份产物，每页自己的提取产物落 `assets/<页名>/`；补丁与 mock 是**共享产物**，包根一份。
- **options 页 = 页索引**：装扩展的人打开选项页，看到的是"这个原型有哪些页"，点一页就过去——overlay 页跳它自己的地址，scratch 页开包内文件。**工具栏图标打开首页入口**（有 `entry` 就开那一页，否则开 options 页）。这替换掉 §17 那句"options 页就是原型页"：表里可能有多页、也可能混着别人的页面，一个"页面"已经不足以代表它。
- 包内文件名**不变**（`cart.html` 还是 `cart.html`），页间链接零改写；`dist/extension/base.html` 这个名字只有在"入口恰好是 `base`"时成立——旧数据提升后正是如此（19.7）。

### 19.6 对话绑"原型 + 当前页"

- §11 的绑定**只在页这一层**多一维：会话仍然只存 `prototypeSlug`（`SESSION_PERSISTENT_FIELDS` 里**没有**页字段），而"这是哪一页"是**读的时候**由 `matchPrototypePage` 从窗口真实 URL 反推的（§18 ④）——不落盘、不占会话字段。**写入路径一行不改**。
- **命令的默认落点**：`open` 不带 `--page` 时打开**当前页**，没有当前页就落到入口、再落到索引。多页之后"打开这个原型"不再有唯一指代，而"接着我刚才在看的那一页"才是人和 agent 都想要的那一个。
- `status` 把当前页标出来（`current`），agent 因此不必自己比对地址。

### 19.7 旧数据：读时提升，不写迁移脚本

读取侧把旧形状**提升**成页表（`readPrototypeConfig` 一层），落盘保持旧形状，直到下一次控制面写入：

| 旧形状 | 提升为 |
|---|---|
| `kind: "scratch"` + `base.html` | 页 `base`（file `base.html`，`entry: true`） |
| `kind: "overlay"` + `targetUrl` | 页 `entry`（kind overlay，url = targetUrl，`entry: true`） |
| `kind: "overlay"` + `pages: [...]` | 上面的入口页 + 其余页按声明序（kind overlay） |
| 读不到 `kind`（坏配置） | 同 scratch 那一支——坏配置落在"自己有文档"的路上（§13.3 不变） |

- 提升发生在**读**这一侧，于是：旧原型不需要任何动作就能用；新写的数据里没有"旧字段"这回事；旧版工作台打开新数据会看到 kind 缺失 → 兜底 scratch（可接受：工作台内不承诺双向兼容）。
- `base` / `entry` 这两个名字是**提升的产物**，不是新规矩——它们只是普通页名。改名一页要三处一起动（scratch 的**文件**、它的**补丁目录**、以及指向它的 **`entry` 标记**），由控制面一次做完，不留下悬空引用。

### 19.8 命令面

| 命令 | 变化 |
|---|---|
| `status` | `pages:` 每行带 `name / kind / url\|file / entry? / current?`；`pageIssues` 点名不干净的条目 |
| `pages` | `--add name=url` 仍是 overlay 页；**不带 url 只在该页文件已存在时接受**（声明是为了顺序，不是为了造页——scratch 页要有文档才算存在，写文档是 agent 的文件工具，§13.2 的"不预置空白"不变）；`--remove` 删的是**表里的一行**；`--layout <页名>` / `--no-layout <页名>` 决定共享布局是否套这一页（§19.2 实施时的修订），文档没人声明时顺手声明它——标记住在行上 |
| `entry` | 新增：`entry <name>` 把某一页设为首页入口；`entry none` 回到索引 |
| `open` | `--page <name>` 不变；不传 = 当前页 → 入口 → 索引 |
| `export` | 按表按页产出；dev-spec **按页分节**（每页：类型、地址或文件、在它上面生效的补丁） |

**创建原型不再问类型，也不再要求地址**：它只问名字，建出来的原型没有页——"还没有页"是一句真话（§13.2）。类型搬到**页**上之后，§13 那两张卡片的收益（引导文案说到点上）跟着搬到**新建页**对话框：overlay 要地址、scratch 要一张文档（一张最小文档；已有布局的原型另有一句提示，见 §19.2 实施时的修订——布局不再由创建预置）。粒度改了，分野没改。

### 19.9 侧栏一级：页不下钻（原「两级下钻」已撤销）

**侧栏只承载作用域。** 一个原型是一条流程、一个交付单位（config / patches / services / dist 都在它下面，身份与对话都绑它），所以侧栏要回答的只有一句"我在哪个原型上"。

撤销二级的理由是**页的载体不是侧栏**：

- 页是地址或文档，"看这一页"发生在**工作区浏览器窗口**里；工作时切页的地方是窗口自己的标签页与地址栏（`/<页名>`，§12.6／§16.3），那也是唯一能显示"页本身 + 已应用补丁"的导航器。侧栏里再放一份，是同一能力的第三份实现，而且是唯一显示不了活状态的一份。
- 页的**事实与动作**有一个家：详情页的**页索引**。两处并存必然漂移——此前"设为首页入口 / 改名 / 删除"在侧栏叶子与详情页的「页面」区块各有一份，就是这个形状。

- **一级行**：原型名 + 状态点 + 页数；点击 = 打开详情页（原判断不变：一次点击就开一个浏览器窗口是过重的副作用）；右键或悬停 `…` = 复制、删除（"哪个原型存在"的决定）。
- **页索引（详情页的「页面」区块）**：一行一页、表序即流程序，带类型、入口、改动数与已失效的选择器；行内展开是这一页的改动（`patches/<页名>/`，每个 `@target` 现在的命中情况就在它旁边）与全部页级动作（打开、设为入口、改地址、改名、移除）。**「新建页」也在这里**——加一页是"加进这条流程"的决定，所以它跟着流程走，不再挂在列表行上。
- **展开状态是 UI 状态**（不落盘）：它说的是"我在看哪儿"，这一条与层级无关，不变。

> 存档（已撤销的写法）：一级 = 原型 + 展开箭头；二级 = 页，点击 = 打开这一页，右键 = 打开 / 设为首页入口 / 改名 / 删除。撤销它的原因不是"点不开"，而是树承诺了一个并不存在的落点：叶子点下去是浏览器窗口，而同一页的事实散在四处（侧栏叶子、详情页的页面表、`patches/` 分组、`anchors/` 分组），要在两段之间来回对。

### 19.10 验收（§10 的续，R 组）

94. 建一个混合原型（两张 scratch 页 + 一张 overlay 页）→ `status` 的 `pages:` 三行、kind 各自正确、表序 = 流程序
95. 不标 `entry` → 打开原型得到**页索引**，三页都在、点第三页进得去；`entry orders` 之后 `/` 直接到 `orders`，而 `/_index` 仍然给出索引
96. `patches/orders/*.css` 只在 `orders` 页生效，`patches/*.css` 三页都生效；导出后扩展包按页分文件、dev-spec 按页分节
97. 装扩展 → options 页是页索引；工具栏图标打开入口那一页
98. 旧原型（`kind: "overlay"` + `targetUrl` + `pages`）**一个字节不改** → 页表与旧行为逐页一致（入口 = targetUrl）；此后任何一次控制面写入把形状落成新的
99. 窗口停在第二页 → `snapshot` 的 `Prototype:` 行带 `page "<name>"`，会话绑定记下该页；`open`（不带 `--page`）打开的就是它
100. `patches/nope/` → 状态报告点名；页名对得上时不报

**未做**：

- **不引模板引擎 / 组件系统**：组件复用停在 `_layout.html` 单插槽 + 页自己的资源引用。多插槽、**按页选布局**、继承链都不做——那一步走出去，"作者面 = 最终产物"就不再成立。（"按页选布局"后来收窄成一个布尔 opt-out：页行 `"useLayout": false` = 共享布局不套这一页，见 §19.2 实施时的修订。多插槽与继承链仍然不做。）
- **页不嵌套**：页是 host 根下的**一层**，页内层级属于应用自己的路由（§16.3.1）。
- **跨原型的流程**：真的横跨两个原型的流程不合并；"在看什么"是一段文字（§14 的修订），不是拼。
- **页级 mock / services**：mock 是原型的属性，不按页切——同一个路由不会在不同页上有不同响应。
- **裸底稿这个调试地址**：§18 的 `/base.html`（无补丁）随 `base.html` 的特例一起消失。要看"补丁之前的样子"就得在渲染之外再留一条路径——那正是这一层要删掉的东西；真需要时再加一个显式开关，不做隐式特例。

## 20. 需求锚点与研究沉淀

前面各节回答的是"原型里有什么"；这一节回答"这个原型是**为了什么**"。缺了这一层，交付物是一份改动清单（§17 的 dev-spec），而不是一份可以被判断的需求——收件人只能照抄，无法取舍。它是"原型工具"与"需求生产工作台"的分界。

### 20.1 需求锚点：`PRD.md` 是唯一入口

- **需求只在 `PRD.md` 一个文件里**（原型根目录下，由 agent 写）：形状固定——`## R-001 <一句话>` + 其下正文（为谁、今天怎样、什么必须成立）。一份需求文档装不下的材料（人物、现状流程、术语表、截图）就**放在它旁边**，什么格式都行；**除了入口，没有任何文件被解析**，因此不存在"第二个需求来源"——否则"哪条需求没人实现"要跨文件回答。只认大写 `PRD.md`：手写的 `prd.md` 只是文件夹里的一份材料，不是第二个入口。
- **id 是全部机制**：补丁头写 `@requirement R-001`，页文档里写注释。两者共用一个提取器，因为"这个改动服务哪条需求"是同一个问题，不分文件类型。书写宽容（`r-1` / `R-1` / `R-001` 同一），`TBD` 之类一律忽略——不猜 id。
- **线程派生，且只在一处派生**（[coverage.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/prototypes/coverage.ts)）：`status` 与 `dist/dev-spec.md` 读同一份解析结果，因此不可能给出不同答案。
- **两个失败就是这套机制的意义**，且都看不出来（单文件阅读看不出）：
  1. 需求在 PRD 里、**没有任何页或补丁**引用它 → `R-003 is in PRD.md but no page or patch refers to it`。finding **不算实现**（它是证据）："争论过、没人做"必须读起来不像做完了。
  2. 标记写了 PRD 未定义的 id → 点名到具体文件。
  两条都进 `briefIssues`（与 `pageIssues` 并列；后者是页表的问题）。
- **详情页渲染入口本身**，而不是把需求改写成一份列表（§19.9）：PRD 是写给人读的散文，id 清单不是它的论证。文档**说不出**的那件事才需要页面上另有一行——每条需求被谁引用（没人引用的那条标红）；入口旁边那个文件夹是作者的，页面上只按名字列出，点开交给应用内预览或系统默认程序。`status.entryDocument` / `status.files` 因此带的是**路径**而不是正文：一份状态报告不该替每个原型背着它的散文。
- **dev-spec 按需求分组**：`## Requirements` 表排在 `## Pages` 之前，列为"id / 需求 / 被谁引用"，并单列**没有声明任何需求的补丁**（`unclaimed`）——顺手修一个坏布局有时是对的，但必须让人看见。
- **表格只镜像 PRD**：悬空 id 不占行——一行没有标题的"需求"会被读成需求，而不是一个坏引用（它在 `briefIssues` 里被点名）。

### 20.2 研究沉淀：一条 finding 一个文件

- **`research/`**（原型目录下）：`# F-001 <你发现了什么>` + 标签行 `claim:` / `source:` / `captured:` / `evidence:` / `requirements:`，其后是正文。没有 `# F-xxx` 标题的 md 是普通笔记，忽略而不报错。
- **三样东西让它成为工作台而不是笔记文件夹**：
  - `source` —— 在哪看到的；无法复核的断言是传闻；
  - `evidence` —— 指向 `research/` 内的文件，**存在性会被检查**（坏引用正是 finding 变得不可证伪的方式）；
  - `requirements` —— 它支持哪条需求：这是"证据 → 决策"的那条边，也是 `research/` 值得单独存在的理由。
- **不进交付包**：`assets/` 是页运行时资源（进包），`research/` 是作者抵达需求的过程（不进包）。这条边界与 §19.5 的扩展打包规则一致。
- **进 prompt**：绑定原型的会话在 `<prototype_context>` 里拿到需求清单（含"无人引用"标注）与已记录 finding 的摘要，于是"上次看到的"是可用的，而不是每次重看。

### 20.3 帧采集：不做录屏，做抽帧

**不做视频文件**：消费这些证据的是多模态模型，给它一个视频，它还得自己解码抽帧——而"哪一帧值得看"恰恰只有我们这一侧知道（画面什么时候变的，动作什么时候发生的）。所以一次采集写出**带编号的 JPEG + 索引**，`research/frames/<session>/`。

**两个采样器，因为画面变化有两个来源**：

- **变化检测**（定时比较像素，`--interval` 默认 400ms，`--threshold` 默认 0.5%）——抓"自己动"的：流式回答逐字输出、列表填充、动画。像素比较按每 16 像素抽样一次（1280×800 一帧是 4MB BGRA，问题只是"画面动了吗"）。
- **动作检测**（`click` / `type` / `key` / `navigate`）——抓"有人做了"的：动作**强制落帧**（不看像素差），并在 350ms 后再补一帧看结果。"点了一下但什么都没变"也是一次点击，本身就是一个发现。

动作信息从 **CDP 单一入口**读（`browser-cdp.ts` 的 `send()`）：所有作用于页面的方式都走 `Input.*` 或 `Page.navigate`，一处挂钩覆盖点击、输入、选择、拖拽、导航，不需要每个动作自己记得上报。

**每帧必须带坐标**：地址、所属页（用与宿主相同的页匹配规则从地址反查）、时刻、原因。没有坐标的一堆图无法被引用。

**不进交付包**（与 §20.2 同一条边界：`assets/` 进包，`research/` 不进）。上限默认 60 帧，触顶后**说明是抽样**，而不是悄悄丢差异。

> **修订（详情页撤出「帧」，导入也只留工具）**：这一节的产出**不再列在详情页上**。帧是**给模型的材料**——一次采集出了几张、是不是抽样，是 agent 读 `research/frames/*` 的事，不是人在这里要核对的状态。「把别处录的一段带进来」这件事本身也不是人在这页上的动作：它走 `sample-video <path>`（§20.5），是 agent 的动作。所以详情页 `…` 菜单里那个导入项也撤了，渲染侧的 `prototypes:importVideo` 通道一并删除；`importPrototypeVideo` 的 domain 实现保留，它现在的**唯一调用者**是会话里的 prototype 工具（`SessionManager` 接线，`prototype-commands.ts` 的 `sample-video`）。

> **修订（实时采集整条撤掉，只剩 `sample-video`；人自己录的那半回到窗口上）**：`record <for>` 曾做成"看着这个标签页一段时间、留下画面变了的那几帧"的一次调用（更早是 `record start` / `record stop` 两步），**后来整条删掉**。理由不是实现难，而是**人和 agent 配合不起来**：它唯一不可替代的用法是"你操作、我看着"——录制期间页面要被人或 agent 驱动——而一次工具调用里没人能对另一头说"就现在，点它"；agent 自己驱动则等于在 recorder 里再实现一套输入原语。**这一半后来在窗口上做回来了**：浏览器窗口的工具栏多了一个录制按钮（`apps/electron/src/main/tab-recorder.ts` + 工具栏的 `browser-toolbar:record`），人按一下开录、再按一下停，录的是**按下时屏上那个标签页**，产物是 **mp4（H.264）默认、webm 回退**（实测这个构建都能录、也都能回放；mp4 优先是因为它到处能打开，而且一加载就知道自己多长——见 §20.5 的修订），落在**系统下载目录**（与这个窗口里下载的文件同一个地方）；**既不按会话分、也不放进工作区**：窗口是一个工作区一个，而标签页的归属只说明"谁开的"，不说明这段录制是给谁的——在 A 会话开的标签页里录的 demo，十有八九是给 B 会话用的，写进 A 的目录是在读一个不存在的事实。它就是**人自己的一个文件**，"哪个会话用它"由人事后决定（把路径告诉它，或让它 `sample-video`）；录制期间画面由 `session.setDisplayMediaRequestHandler` 提供，**只有一次被 arm 的录制能给出来源**，所以页面永远拿不到屏幕。它与 §20.3 的帧采集**不是一回事**：产物是视频不是帧，也不写 finding 的 `evidence:`；要看帧就走 `sample-video <那个文件>`（§20.5），要看"某次操作改了什么"就用 `screenshot`。随命令删掉的那批（`BrowserPaneFns` 的两个方法、`domain/record-prototype-frames.ts`、面板的 `startFrameCapture` / `stopFrameCapture`、内存帧与变化检测、`browser-cdp.ts` 的 `onAction` 动作钩子、能力白名单两条）**不随之恢复**。
>
> **修订（帧同时回对话）**：这次改动里留下的一件事，是帧（现在是 `sample-video` 的帧）**同时作为图片回到对话**。这一节的前提写的是"消费这些证据的是多模态模型"，而只写盘的话它一张都看不到——人和 agent 都得到盘上翻文件，模型更是拿不到像素。所以回复里带抽样（首帧、末帧在内，上限 6 张，`previewFrames`），并说明"这是全部 N 张里的哪几张"；盘上仍是全部，finding 的 `evidence:` 引用的也仍是盘上那份。门两侧走法不同、原因一致：Claude 侧把图作为 image block 给模型（与 `screenshot` 同一条路），PiAgent 侧的 `content` 只能是字符串，于是按 `image-preview` 块引盘上的文件（与该侧 `screenshot` 同一条路）——两处都是各自已有的机制，没有新通道。

**已知缺口（随实时采集一并作废）**：用户**手动**操作（不用 agent 工具）产生的变化会被变化检测抓到（有帧），但没有动作标签——标签只来自我们发出的 CDP 动作。要补齐需要在页面里注入监听器并回传，是独立一项。实时采集删掉以后，这条缺口不存在了：导入的帧本来就只记"视频里的第几秒"。

### 20.4 渲染层

> **修订（详情页四层重构之后）**：**Reviews 与 Acceptance 两段已从详情页撤掉。** 两者都是"某一轮的过程"，而且**只在对话里被解决**——异议要有人回应，验收要 agent 跑一次；页面给不出动作，只能给一个跳进空房间的按钮。信息没有丢：未解决的异议与红掉的检查本来就在门禁（`settleBlockers`）里逐条点名，所以页面上再列一份就是第二份表示（§19.9／§23.5 一直在防的形状）。门禁里这两类的去向也从"跳到该段"改成 **「交给对话」**：把 agent 那句原文预填进草稿、不自动发送（`usePrototypeAskAgent`，同一个规则原型面板也会用，§23.4）。**Requirements / Research 保留**——它们不是"某一轮的过程"，是沉淀与依据。**Frames 也撤了**：材料是给模型的（§20.3 的修订），而且人在这页上**一件事都不用做**——导入一段录制同样是 agent 的动作（§20.5 的修订）。
>
> **再一步（本轮的顺序调整）**：**「交付」不再是一个区块，而是页头的一个按钮**——点开是交付卡（门禁逐条带去向 + 产物清单 + 服务那一行 + 「导出」），页头那枚徽章仍是"能不能交"的一句话答案。正文的顺序固定为 **页面 → 页面问题 → 需求 → 研究 → 参考资料**：证据（需求、研究）排在一起，参考资料收尾。判据与这一系列调整同一条——交付是**结论与动作**，不是要先读的一段；而这几段是"这份活是什么、为什么这样做"。`Info_Section` 的 `id="delivery"` 随之消失（门禁条目本来只跳 pages / requirements 两段）。
>
> **再一步（需求的形态，§20.1）**：**需求区不再是 id / 标题 / 引用清单，而是渲染 `PRD.md` 的原文**——`PRD.md` 是唯一被读的需求文件，它本身就是写给人读的；页面上另给的两块是文档**说不出**的事：每条需求被谁引用（没人引用标红），以及它旁边那个文件夹里有哪些文件（点开就用系统程序打开）。`status.entryDocument` / `status.files` 带的是路径，正文由渲染层用 `file:read` 读回、交给 `Info_Markdown`（可全屏），所以"看 PRD"和"看文件"是同一份东西。

详情页在 Pages 与补丁之后新增几个区块 —— **Requirements**（id / 标题 / 被谁引用，"还没有任何引用"直接标出）、**Reviews**（每条异议的 claim / `about:` / 状态，与盘对不上的标 stale）、**Acceptance**（上一轮：跑过几次、通过/失败/跳过，以及"从没跑过"）、**Research**（finding 的 claim、来源，以及它论证哪条需求）、**Frames**（采集会话、帧数、是否抽样、来自哪个录制），外加一条 `briefIssues` 告警，把三个静默失败摆到人眼前：需求无人实现、标记指向 PRD.md 未定义的 id、finding 缺少 claim 或证据不在盘上。

这几块排在 Pages **之前**：先说要做什么，再说怎么做的。告警用与「Page issues」**同样的形状**——它们是同一类事实（静默失败），不该长得不一样。

Frames 的数据来自 `listFrameCaptures`，它**从盘上读回** `research/frames/*/frames.json`：图片旁边那份索引就是记录，所以面板列出的与 finding 能引用的不可能漂移（与补丁扫描同一个理由）。

### 20.5 导入外部录制的视频：同样是帧，来源不同

用户可能用别的方式录好了（手机、Loom、QuickTime）。两条技术判断：

- **不引 ffmpeg**：解码交给 **Chromium**（隐藏窗口 + `<video>` + canvas 取帧）。代价必须说清——**支持哪些编码就是 Chromium 支持哪些**：HEVC/H.265、ProRes、部分 `.mov` 读不了，会**明确报错**而不是产出"只有第一帧"的假采集。
- **产物与实时采集同构**：还是 `research/frames/<session>/`（`frames.json` + `index.md` + 编号 JPEG），所以 finding 的 `evidence:` 引用方式**一个字都不用改**。新增的只有两样：`reason: 'imported'` 与 `offsetMs`（视频内位置，"0:12.4" 才是读者能用的坐标；`at` 只说明什么时候抽的）。

**采样两种模式**：`--every <n>` 按时间线均匀采样（默认 2s），`--changes` 只留画面真的变了的。逐点 seek 不是免费的，所以采样步长会按 `--max` 放大（工作量有上界），触顶后 `truncated` 说明是抽样。

> **修订（时长要先量出来，不能想当然）**：采样步长是按**录制的时长**算的，而"文件写的时候就知道自己多长"并不成立：`MediaRecorder` 现场写出的 webm/mkv 头里没有长度，`<video>.duration` 一直报 **`Infinity`**（同批实测：mp4 报 1.43s，webm 报 `Infinity`，见 `apps/electron/spike/recorder-formats.cjs`）。而 `Infinity` 当步长不是"抽得粗"，是**另一段程序**：`stride = Infinity` 会让 `for (t = 0; t <= durationMs; t += stride)` 永远成立，每次 seek 到 `Infinity`（规范上是抛错），表现就是"抽帧卡住/报无关的错/给一堆重复帧"。所以现在**先量时长**：`duration` 不是有限值就用"seek 到 1e101"把文件读完（实测能把 `Infinity` 解成 1.40s），仍然量不出来就明确报"这段录制没说它多长"，而不是猜。这也是窗口按钮**默认录 mp4** 的一半理由：mp4 一加载就知道自己的长度。

**原视频复制进工作区**（`research/videos/`，重名加后缀）：抽帧的来源一旦被清理就再也抽不了，可重抽正是"留着来源"的意义。复制发生在**解码成功之后**——读不了的视频不该在工作区留下一个永远没人用的副本。

**不进交付包**：与 finding、实时帧同一条边界（`research/` 是过程，`assets/` 才是运行时资源）。

**入口一处**：命令 `sample-video <path>`——路径是它自己的一个参数（`--every` / `--changes` / `--max` 同 §20.5 的采样模式），要分析哪一段由人在对话里说清楚，或 agent 自己找。**它不挂在 `record` 下面**：`record` 看的是一个标签页（现场抽帧），这条读的是一个已经存在的文件，两件事分开成两条命令，省掉一个中间词。详情页 `…` 菜单里的按钮、以及渲染侧的 `prototypes:importVideo` 通道都已撤掉：抽帧是给模型的材料，不是人在这页上要点的操作，所以它不该有第二处入口。

### 20.7 验收挂钩：PRD 的验收标准是可执行的

在需求条目下写 `check:` 行（可多条），两类，都必须是**机械可判**的：

- `check: selector [data-cart-total]` —— 对**当前窗口所在页**断言
- `check: endpoint GET /api/cart` —— 对**契约**断言

`verify [slug]` 逐条跑，写 `dist/acceptance.md`（交付物之一，与 dev-spec 并列——它们的读者是同一个人、同一时刻）。

三条刻意的取舍：

- **不支持的 kind 在解析期就报错**，不是静默跳过：`check: expression …` 若不报，看起来就像一条"已经在被校验的检查"，而其实没有任何东西在看它（见 `requirements.ts`）。
- **没有窗口 → `skip`，不是 `fail`**："没看成"与"不在"是两件事；混为一谈，会让"跑第二次"这件事失去意义。
- **只写报告，不改原型**：失败该怎么办是读者的判断，不是执行器的。

与 S4 的分工：**验收挂钩管"行为对不对"（读 PRD 的断言），S4 管"选择器还命中吗"（读补丁的存活）**。两者互补，都需要。

**未做**：`text` / `expression` 两类断言（后者等于让 PRD 跑任意 JS，权限边界要单独想清楚）。**已补**：验收结果曾以「上一轮验收」一栏出现在详情页——**已撤**（§20.4 的修订：只在门禁里出现，"红检查 / 从没跑过"两条的入口是「交给对话」）；执行器有单测（`packages/server-core/src/domain/__tests__/verify-prototype.test.ts`）——`endpoint` 断言（方法大小写折叠、路径不折叠）、轮次记录与"与上一轮的差"（新红 / 仍红 / 不再被看 / 已修 / 不再声明）、`skip` 不算红、页面名回填与"没看成"的三种来路都在里面；只有 `selector` 的真页面那一半仍需要真窗口（测试用桩 `evaluate` 走遍它的分支）。顺带修掉一处：PRD 把最后一条 `check:` 删掉时，报告过去退回"No checks yet"，把"不再声明"这件事一起吞了。

### 20.8 S4–S5

| 段 | 目标 | 状态 |
| --- | --- | --- |
| S4 回归可见 | patch 命中报告（css 按选择器统计命中、js 关键断言、DOM 稳定后读回） | **已完成**（§21.1／§21.2）：css 按 `@target` 统计命中、DOM 稳定后读回、命中与否都点名；js 侧只报"是否抛错"，**关键断言不做**（`verify` 才是断言的地方，§20.7） |
| S5 交付索引 | `dist/handoff.md`（谁看哪个产物） | **已完成**：`export` **最后**写它——表从**写盘时刻的 `dist/` 列表**（`listDistNames`）生成，所以只会点名箱子里真有的产物；开头写构建时间 / 版本 / 入口页，末节「What this delivery does not settle」抄的是 `--strict` 拒绝的那份清单（`buildPrototypeStatus().settleBlockers`，即 `whyPrototypeIsNotSettled` 那一处规则的原话）。结果里是 `handoffPath`，命令输出与详情页都点名；验收在 `packages/shared/src/prototypes/__tests__/export.test.ts`。**二进制资产进包同级已完成**：`assets/` 整份按字节原样进扩展包（§17.8），另一份交付物 `dist/static/` 把它 base64 内联（§17.8） |

S4 是迭代类需求的保险：线上改版后补丁**静默失配**，是这套东西最贵的失败模式。S5 是收件人的**第一个问题**——"包里这几样，我先看哪个"：`dev-spec.md` 说得清改了什么，说不清从哪看起，而包里的产物不止一样、读者也不止一个。

---

## 21. 补丁的标记、锚点与收敛

> 已实现。落点（改了哪些文件、每处改什么）见 [开发文档](prototype-workbench-dev.md) §1／§2；验收见 §10 的 S 组（101–115）。

**问题**：三条各自成立、合起来却漏掉同一件事的病。

| 病 | 今天的表现 |
|---|---|
| 补丁**不可检查** | 一条 css 补丁的选择器匹配不到任何元素时，注入照样成功、状态里看不出、页面也没有变化——"补丁没生效"和"补丁没匹配"长得一模一样。§20.8 把它记成了 S4，是这套东西最贵的失败模式 |
| 选择器**没有参照物** | 补丁写的是"当时那份 DOM"，而那份 DOM 不归我们。站点一改版，补丁**静默腐烂**；即便人发现了，也无从判断"是选择器写错了"还是"页面变了" |
| 差量层**只会变长** | 页文档在首次生成后冻结（§3.5），补丁 append-only 永不合流。没有任何机制让一个原型收敛：人看到的永远不是"一份文档"，而是"文档 + 一串差量"，还得在链条中间改东西 |

**结论**：三件事一起解决，而且它们是同一件事的三个面——**给补丁一个锚、给锚一个参照物、给层一个收敛点**。

### 21.1 补丁头：两个标记

补丁的**文件名**说得清它在哪一页、属于哪个写入身份，说不清它**对着什么**、**为谁而做**。这两件事过去只活在对话里，而对话正是下一个读者看不到的地方。所以它们写进文件，作为标记解析：

```css
/* @requirement R-001
   @target .pay-btn */
.pay-btn { border-radius: 8px }
```

- **`@requirement` 早就有**（§20.1 的 `coverage.ts`），这里只是把解析收进 `patch-header.ts`（它**零依赖**，因为 `storage.ts` 也要用，而 `requirements.ts` 已经依赖 storage）。
- **`@target` 是新增的那一条边**：它把补丁接到页面上的元素。有了它，一次 apply 就能**数**这条补丁匹配到了什么，"没匹配"于是有了声音。
- **是列表，不是一个**：折叠会把多条补丁折进一个文件，并把每个来源的标记写进 provenance 注释里——只读第一个标记的话，其余锚点会在折入的**那一刻**变成"没有补丁声明的记录"。
- 容错与 `@requirement` 一致：空、`TBD`、写成词的（`not-a-@target-marker`）都算"没声明"，**不猜**。

### 21.2 虚拟 base：`anchors/` 里的记录

overlay 的页面是别人的活地址，它不会、也不该变成我们的文件。但"我们在改谁"这件事必须有个参照物，否则选择器永远无法被判断。参照物不是页面的副本——那是**已经删掉**的"把在线页冻成 `base.html`"（§14.1）：副本跑不了它自己的 JS、带不来会话。

所以参照物是一份**记录**，不是一份文档：

```jsonc
// prototypes/<slug>/anchors/<页名|shared>.json —— 控制面独占，可从补丁 + 一次 apply 重建
{ "page": "cart", "url": "https://shop.example.com/cart", "updatedAt": "…",
  "anchors": [
    { "target": ".pay-btn",
      "fingerprint": { "tag": "button", "text": "Pay now", "path": "form > button", "attrs": ["#pay"] },
      "patches": ["cart/A-001-pay.css"], "firstSeenAt": "…", "lastMatchedAt": "…", "matched": 1 } ] }
```

三条设计判断：

1. **记录发生在"第一次命中"的那一刻**，由控制面在 apply 时顺手写下（活页面的 DOM 我们本来够得着）。不引爬虫、不设采集步骤——需要单独维护的记录一定会烂，而这份是使用的副产品。
2. **不匹配时不更新 fingerprint，只把 `matched` 置 0**。这正是一条记录存在的理由：保留了"它曾经长什么样"，下一次就能说 **the page moved**，而不是笼统地说"没匹配"。**只报不记**的锚点（从没命中过）进 `unmatched`，不进记录——一条没有日期可言的锚点读起来像证据，而它不是。
3. **落到 `anchors/` 而不是 `patches/`**：它不重放、不渲染、不进交付包，是**关于页面的证据**（与 `research/` 同一条边界）。

由此得到三个以前拿不到的事实：

| 事实 | 判据 |
|---|---|
| **命中** | 这次 apply 数出来的命中数（写进记录与输出） |
| **漂移** | 有记录、且记录里 `lastMatchedAt` 非空，这次却 0 命中 → 页面变了 |
| **重锚** | fingerprint（tag / 文案 / 属性 / 结构路径）足以在页面上提出候选选择器——只提**唯一命中**的候选，宁可不说，也不给一个会被接受然后改错地方的 selector |

**没有新增命令**：修好选择器后下一次命中自动重记。记录由使用过程持续刷新，而不是一次快照——这比 qcow2 还多一步：qcow2 的 backing 变了自己不会说，改了就是烂。

### 21.3 收敛：折叠是复制的一个选项

> **修订（折叠不再是命令，也不在导出里）**：这一节描述的操作本身没变（差量层塌陷成一份），但它**在哪里发生**变了两次，最终落在**复制**上：`duplicatePrototype(root, slug, { fold: true })` 折叠的是**副本**（`fold.ts` 的 `foldPrototype`），原件一个字节都不动。因此：
>
> - **没有 `prototype-commit` 命令**（绑定原型那条通路已删），也没有 `prototypes:commit` 这个 RPC：agent 侧没有折叠动作，面板侧的那个按钮也撤了；`--page`（只折一页）随之消失——折叠一次覆盖整份。
> - **导出不折叠**：`export` 把差量层按作者留下的样子打进包（这一条先被改成"导出先折"，随后回退，理由见下）。
> - 为什么是复制：折叠**不可逆**（它删掉被折的补丁文件，并改写 scratch 页的文档），所以它必须落在一个"反正你要的是新东西"的对象上——副本。原件继续长差量，副本从一份文档开始。这也是**唯一**一处删补丁文件的地方。
> - 需要折叠的判据从"工作停下来了（人来判断）"变成"你要一份收敛的副本"——前者需要一个信念，后者是一个请求。
>
> 下面这张表与那几条规则仍然成立（`Z` 保留身份、标记跟着走、js 升格、折不了就报出来），只有"谁在什么时候触发"变了。验收清单 109–115 已按这个流程改写。

差量层需要一个**塌陷点**。qcow2 的 `commit` 把 overlay 合进 backing——这里能不能合，取决于 **base 归谁**，而这正好是两类页的分野：

| | base | 折进哪里 |
|---|---|---|
| **scratch 页** | 我们自己的文档 | CSS → `assets/<页名>/committed.css`（并在页文档里插 `<link>`）；JS **升格** → `assets/<页名>/committed.js` + `<script src>` |
| **overlay 页** | 别人的活地址（不可重写） | CSS 与 JS → `patches/<页名>/Z-001-upper.css` / `Z-002-upper.js` |

- **JS 不是"折入"，是"升格"**：它是运行时行为，硬折进静态文档等于"执行后序列化 DOM"——就是 §14.1 删掉的那个方案。移进我们自己的资源文件是同一种收敛（它不再是一条差量，而是源码），而且文档仍然可读。
- **`Z` 是一个保留的写入身份**，`byReplayOrder` 里**按规则**排最后（并明确写出来，不靠字母序的巧合）：折进去的东西必须重放于它所折的一切之后，一条补丁的语义不该取决于别的写入身份恰好被叫什么名字。
- **标记跟着走**：provenance 注释里带 `@requirement` 与每个 `@target`（每个标记各占一行，因为解析器把标记之后到行尾都当作它的值）。锚点与需求线因此穿过一次折入仍然成立。
- **共享补丁折进共享层**（`patches/Z-001-upper.css`），页级补丁折进页层——折入**不改变作用域**。
- **折入之后删掉原补丁文件**：删除本就是最便宜的撤销（§17.5），现在它同时是最便宜的收敛。
- **折不了的报出来，不猜**：scratch 页的文档不在（折入的落点是文档）则**拒绝并保留补丁**；没有 `@target` 的 css 折入但**点名"没人检查过它"**。
- **不做撤销，也不在原件上发生**：它是不可逆的合并（用户自己的 git 才是"前后"的地方），而它落在副本上，所以"撤销"这个问题不用回答；第二次折叠（副本已经收敛）会说"没有可收敛的补丁"，而不是写一个空文件。

一个副作用是刻意的：**scratch 页折入后，它那一份锚点记录被清掉**——元素已经在我们自己的文件里，没有"页面漂移"可言；overlay 页的记录**保留**，因为页面仍然是别人的，那才是漂移检查值钱的地方。

### 21.4 改完即见：文件变更是自动重放的触发器

`patches/`、`assets/`、页文档一被保存（外部编辑器也算），该原型**已打开的窗口**自动跟上：

- **一个原型里两类页，两种含义**，而且是从**文档本身**读出来的（`buildInlinedPatchProbeScript`），不是从地址猜的：我们自己的页由宿主按请求现渲染，所以**刷新**就够（再注册一遍注入会在下一次渲染里重复执行 JS）；别人的活页面**重新 apply**（重建注册 + 立即求值）。
- **故意不是"apply 再刷新"**：对已经内联的补丁求值会跑第二遍 JS，而那正是内联标记存在的意义。
- 300ms 合并（多文件保存是一次意图）、**默认开**。曾经可以在详情页页头的 `…` 菜单里关掉（偏好存在 `~/.craft-agent/preferences.json` 里，是"这个应用怎么盯文件"，不是原型的事实）；**这个开关后来撤了，重放变成常开**，窗口工具栏上那个手动「应用原型的改动」按钮也一起撤了——两者都是同一个动作的第二个入口，理由见 dev 文档「21.4 手动应用与开关」一行。代价仍在，留着看清楚：重放一个**活页面**会刷新它，把窗口里正在填的东西丢掉。
- 只对"页面由什么构成"的改动重放（`patches/`、`assets/`、顶层 `.html`）；`dist/`、`research/`、`anchors/` 的变化不重放——因为导出或记录而刷新窗口是错误动作的副作用。

### 21.5 渲染层与命令面

- **详情页**：补丁区块一条一行（文件名 + 页 + `@target` 标记，没有标记显示 `—`），加「改动自动重放」开关与「收敛成一份」按钮（先问一句，写明代价）；新增**锚点**区块按 scope 列出每条锚点与它的命中状态（命中 N 处 / 现在找不到、上次命中哪天），外加"记录还在但没有补丁声明它"的点名。
- **命令面**：`apply` 的输出增加三类点名（matched nothing / the page moved + 候选 / no @target，无法检查）；`<prototype_context>` 多一条规矩（每条补丁写 `@target`）与一个说明（折叠折什么、落在哪、以及它只发生在副本上）。

> **修订（详情页"细节"组撤掉）**：上面这几块**都不再显示在详情页上**——补丁清单、锚点记录、服务契约覆盖、文件归属一起撤了。判据是"页面上的每一段都要回答**一个人会问的问题**"；这四段回答的是"这份活是怎么做出来的、机制健不健康"——文件名、`@target`、命中数、假造的端点、写违规——那是 **agent 的问题**，它从 `status` 读。人在这页上遇到的是同一批事实的**可行动版本**：选择器失效 = 页索引里那一行的红字；缺响应 = 「交付」里服务那一行（它同时是门禁的一条，§3.7）；能不能交 = 页头那个「交付」按钮。两处配套搬家：**「改动自动重放」**（人的偏好，不是机制明细）挪到页头 `…` 菜单（那一项后来也撤了，见 §21.4）；**「整理成一份」最后整条撤掉**——折叠收敛成了复制的一个选项（§21.3），交付卡里只剩一个安全的动作（导出）。归属违规因此完全退出人的界面——它是多 agent 编排的故障，人无动作可做。
>
> 那个缺口（**服务缺覆盖不在门禁里**）已经补上：`status.services` 的 `missingFixtures` 现在是 `whyPrototypeIsNotSettled` 的一条（`gate.serviceUncovered`，一个服务一行、点名缺哪几个），于是 `--strict` 会拒绝、handoff 会点名、详情页「交付」卡里会列出它。页面上它还有第二种表示——**「交付」卡里每个服务一行结论**：全部假响应（不依赖后端）/ N 个请求打真后端 / 契约里还没接口，缺响应时那一行标红。服务因此**不再有自己的区块**：它是交付的事实，位置就在交付卡里，与产物、门禁同一处、同一句（§3.7 的一处规则多个读者）；fragments / fixtures / stateful 这些计数仍旧只属于 agent 的报告。

**未做**：

| 项 | 为什么 |
| --- | --- |
| js 的关键断言（S4 的后半句） | 断言属于 `verify` 的 `check:` 行（§20.7）；补丁这边只报"有没有抛错"，再多就是第二套校验语言 |
| 折入时的语义等价校验 | 折入是文本操作，无法证明"语义没变"；当前的回答是**明说**（`unverified`）加上折入前后 apply 一次对照（S 组 110／111） |
| 锚点的清理命令 | 悬空记录在状态里被点名（不是静默），`--remove` 级别的清理等真有人嫌吵再说 |
| `dist/` 变更后的重放 | 交付物不是页面在跑的东西；导出后要看效果，重新打开那一页即可 |
| 把 `anchors/` 当页面快照用 | 那会把它变回"冻一份页面"，§14.1 已经否掉；要全貌另有 §20.3 的帧采集 |

---

## 22. 窗口、标签与"谁在驱动"

> **状态**：模型、标签 API、**打开与目标**、**元信息两分**、**UI（标签栏 + 面板按窗口分组）**、**一个工作区一个浏览器窗口（+ 多标签）**、**元素选择器常驻（窗口级模式，跨标签页可用）**、**标签级占用与接管**、**开窗通道收敛（一切开窗都成标签页）**、**标签锁回到标签页上**、**游标归驱动者（人在看哪个标签页不决定命令打哪个标签页）**、**归属是一份"活"（`TabBelongsTo` + `tab-assign`）**、**几何永远真实 + 按需前台**、**后台执行（命令作用于自己的标签页，窗口不动；`windows` 命令已删）**、**键盘跟着屏幕走（焦点归屏幕上那个标签页，切回来回到原处，且绝不抢窗口前台）**、**后台标签页住在离屏停车窗（视口是自己的，窗口 resize 只碰屏幕上那个；人的窗口里永远没有不在屏幕上的页面）**都已落地。**面板按会话分组**仍留待下一轮（标签栏与徽章已经按"谁的活"分段）。这一节记的是方向与规则——它们必须先定，因为它们决定状态放哪。

> **名词**：本节（以及全部关于浏览器窗口的文字）里，窗口中的一条一律叫 **标签页（tab）**——`tabs` / `tab-new` / `tab-show` / `tab-assign` / `tab-close` / `--tab`、`BrowserTabSummary`、`tabView` / `tabAreaBounds` / `TabRail` / `tab-groups.ts` 都是这个词。**page 只留两义**：①原型流程里的一屏（`prototypePage` / `--page <name>` / `patches/<page>/` / "a page of ours" / "entry page"）；②第三方网站自己的页面与 DOM（CDP `Page.*`、"reload the page"）。三者永不混用（用户定的）。

**问题**：一个窗口 = 一个标签页 = 一个原型，于是"同时经营几个原型"这件事没有任何落点；而窗口又**挂在会话上**（`boundSessionId` / `ownerType` / `ownerSessionId`，轮次结束才解绑），于是

| 病 | 今天的表现 |
|---|---|
| 窗口**看不见** | 窗口列表只在浏览器面板里；换一个对话就看不到另一个对话开着什么 |
| 窗口**不可跨对话使用** | agent 的内容命令走 `getBoundForSession`，只认"本会话的窗口"；别的会话开着的窗口要么对它是隐形的，要么被它**夺过来**（而"借用"没有这一档） |
| 归属是**历史** | `ownerSessionId` 记的是"曾经属于谁"（为了轮次结束后还能复用），不是"它在做什么" |
| 一个原型**只能生效一个** | 因为一个会话只驱动一个窗口，而一个窗口只装一个标签页 |

**结论：窗口是应用级的，标签是对象，驱动是租约。**

- **身份下沉到标签**：`boundPrototype` / 地址 / 页名 / 控制台 / 主题色 / 抽帧的当前画面，都是**标签页**的属性。窗口降级为容器，只保留窗口级的事（大小、置顶、工具栏、菜单、遮罩、关闭）。这样"一个窗口里两个标签 = 两个原型同时在场"，各自带着自己的地址栏与 apply 目标。
- **"归属"换成"占用"**：窗口带的是"它在做什么"（原型 + 标签页），"谁在用它"是运行时的**租约**，不再有 `ownerSessionId` 那种历史字段。
- **三条规则**（没有它们就不要开多标签）：

| 规则 | 为什么 |
|---|---|
| **目标显式** | 驱动某个标签前必须指名它（原型+页，或"当前活动标签"）。今天 `focus` / `close` / `hide` 已经能带 `windowId`，内容命令不能——这条先补齐 |
| **占用可见** | 谁在驱动哪个标签要看得见；两个对话同时驱动同一标签时，要么排队要么**显式接管**。今天靠"一个会话一个窗口"天然回避了并发 |
| **边界不松** | 工作区仍然隔离（跨工作区共享意味着 A 的窗口被 B 的 agent 操作）；agent 只能 `release`（放开遮罩），**不能关掉用户的东西** |

**开窗一律开成标签**，含 `target="_blank"` 与 `window.open` 的 popup——"应用级单窗口"之后，裸窗口会变成模型里的第二个窗口身份。代价要说准：popup 若由我们拒掉并在标签里加载，页面拿到的是 **`window.opener === null`**，于是"popup + `postMessage` 回传"式登录（Google GIS 一类）会卡住；整页跳转式的登录不受影响。因此把 `disposition` 记进标签的**观测元信息**，真撞上时"这个标签是被 popup 请求打开的"是可查的，不必靠猜。

**标签元信息分两类**，因为这决定"能不能信"：**观测**（url / title / favicon / 加载态 / 是哪个原型哪一页 / disposition）由视图产出，单一来源，agent 不能改；**声明**（谁开的、用来做什么、承载哪个原型）是人的意图。混在一起，agent 会把昵称当事实。查询按需（`windows` 长成 `tabs`），**提示词不背细节**——集合只需被点名，细节现查（`status <slug>` 已经是现成的）。这也消掉了"多绑 = 提示词背上 N 份 flow 上下文"这个顾虑。

**已落地**（`browser-pane-manager.ts`）：

- `BrowserTab`：标签页自己的 view、CDP 会话、地址、标题、favicon、加载态、前进后退、**boundPrototype**、主题色、控制台/网络/下载。
- `BrowserInstance`：只剩窗口级字段 + `tabs` / `activeTabId`。全文件 150 处"窗口级"读写改道为 `activeTab(instance).x`；`title` / `currentUrl` 保留为**只读**窗口级视图（服务端 `BrowserInstanceSnapshot` 与工具栏状态是按窗口问的），写错地方会编译失败而不是写进没人读的地方。
- **接线按标签页拆**：`setupWindowListeners`（窗口 + 工具栏，一窗一次）与 `attachTab(instance, tab)`（一个标签页一整套：UA、背景、视图入窗、遮罩文档、CDP 动作钩子、以及全部 `pageWc.on(...)`）。**每个回调写 `tab` 而不是活动标签**——后台标签页在后台加载时，事实必须落在它自己身上；这一条不是洁癖，是这一步真正要修的东西。主题色的四个助手（`extractThemeColor` / `applyThemeColor` / `installThemeObserver` / `scheduleEarlyThemeExtraction`）随之接上标签页参数。
- **标签 API**：`createTab` / `activateTab` / `closeTab` / `listTabs`，`buildTab` 是两条入口共用的构造函数（`createInstance` 与 `createTab` 都走它，标签页不可能半成品）。布局只给活动标签页 bounds，其余**零尺寸停放**（webContents 继续跑，这正是标签的意义）；遮罩只覆盖活动标签页。`destroyInstance` 清理**每个标签页**的在途跟踪，不只是当前那个标签页。关掉最后一个标签 = 关掉窗口。
- 测试：4 条新用例（加标签页并置顶、**后台标签页的导航不串到前台**、切换后窗口读数跟着走、关标签页与关窗口）。

**行为变化**：一个窗口现在能装多个标签页；单标签时的行为与之前一致（既有的 8 条失败与改动前逐个相同）。

**第二轮（打开 = 开新标签，目标显式）**：

- **协议层打通**：`IBrowserPaneManager` / `BrowserCapabilityMethod` / `RemoteBrowserPaneManager` / `NullBrowserPaneManager` / electron 的 `dispatchCapability` 全部补齐 `createTab`（含 `createTabAsync`）/ `activateTab` / `closeTab` / `listTabs`（含 `listTabsAsync`）。同步/异步成对是这份文件的既有惯例：远程桥需要真实返回值时只能异步。
- **"空白标签页复用"是打开一条**：新建窗口自带一个标签页 `about:blank`，那是窗口的构造而不是谁放的标签页。所以 `createTab` 在**整窗只有这一个标签页**时**开在它里面**，不再旁边加一个标签页——否则"在新窗口里打开一个原型"会得到两个标签页，其中一个没人创建过、也没法被指名。判定是"整窗只有一个标签页"，不是"活动标签页是空白"。
  > **第六轮修正（用户报告）**：复用要求请求问的是"**给我一个标签页**"而不是"**再给我一个标签页**"——所以判据不只是"带着内容"（`url` / `prototype`），还要一个显式说法 `reuseUntouchedWindow` 给"没有 url 也没有身份、只是要一个标签页"的调用方（应用菜单的 "New tab"，它会把没开的窗口开起来）。两条用户报告正好是这条线的两端：
  > - 「**+ 没反应**」：空手要一个标签页被复用吞掉，窗口还是那个标签页。标签栏的 `+`、`tab-new` 不带地址、面板的 New tab 都是"再开一个"，一律真加一个（空白标签页窗口点 `+` 得到第二个标签页）。原因是空白标签页的 URL 被 `normalizeTabState` 归一成 `about:blank`，正好落在复用的判据上。
  > - 「**新建窗口出现两个标签页**」：AppShell 的 `create` + `tabAction('new')` 两步走，窗口本来是新建的（自带一个标签页）却又加了一个。改成**一次请求**：`create({ newTab: true })`，由主进程判断（`reuseUntouchedWindow`）——没开过就用它自己那个标签页，已在用就真加一个。顺带修掉 `close` 那条同源隐患：它先补的那个新标签页原本也可能被复用成**正在被关的那个标签页**，于是关完整个窗口都没了。
  > **修正（用户报告）**：这条规则原先把"已在用"近似成"整窗只有一个标签页且那个标签页还是空白"，于是**已经开着、正显示那一张空白标签页**的窗口被当成"没开过"——`New tab` 被复用吞掉，而那个标签页又没有内容可加载，点下去**什么都不发生**。现在"是否已经开着"由**请求发出之前**窗口是否存在来回答（`handlers/browser.ts` 的 CREATE：`windowWasOpen`，按 `workspaceId` 或指名的 `id` 问，且必须在解析窗口**之前**问）；两个应用侧入口（顶栏的 "New tab" 与徽章下拉里的 `+ New tab`）都改成**真的加一个标签页，并把窗口带到那个标签页前面**（渲染层加 `focus`，host 侧 `activateTab` 照旧）。徽章下拉那份标签页列表的改动见第三轮「面板按窗口分组」下的修正。
- **打开 = 开新标签**：`open`、面板预览（`browserPane.create({ prototype })`）与**地址栏敲原型地址**都改成 `createTab({ prototype, activate: true })`；`open` 的输出添一行说这是哪一页、窗口共几个标签页（标签条出现之前，这是唯一能看见的地方）。
- **`bindPrototype` 删除**：它是"事后改这个标签页的身份"，在"标签页的身份在创建时定"之后没有调用者了。留下的语义只有一条——**标签页的身份只由创建它的入口给**。
- **`--tab <id>` 是全局的**：在命令自己解析参数**之前**被摘掉（`extractTabTarget`），因为它是"在哪"而不是"做什么"，每个命令都共享它、也都不该知道它。带 `--tab` 而没给 id 直接报错——回落到"当前那个标签页"正是指名要防的那件事。
- **语义是"把那个标签页调到前面，然后命令对窗口执行"**：窗口只显示活动标签页，所以"对某个标签页操作"和"切到它再操作"在用户可见层面是一回事，而且**看得见正在动谁**。真正的"不切换就操作后台标签页"属于第 5 项（占用与接管）。
- **命令面**：`tabs`（列表，`*` 标活动标签页）、`tab-new [url]`、`tab-close <id>`（关掉最后一个标签页即关掉窗口，输出照实说）。`SessionManager` 侧：建标签页走 `resolveSessionBrowserInstance`（可能开窗），而**读/切/关不建窗**——命名一个标签页要求窗口存在，为空窗造一个只用来报告"它没有标签页"的窗口，是工具在编造自己被问到的状态。
- 测试：runtime 侧 7 条（列表、无窗、`--tab` 选中且不污染命令本身、`--tab` 缺 id、`tab-new`、`tab-close` 两种结局、`open` 开自己的标签页并带上身份），窗口侧 2 条（原本的"加标签页"改成窗口已被使用的场景，新增"开进未用过的窗口的那个标签页"），地址栏那条补了"新开一个标签页且原来的标签页还在"。

**第三轮（元信息两分 + UI 标签条）**：

- **`BrowserTabSummary` 是唯一形状**（放进 `protocol/dto.ts`，服务端接口、工具栏、面板、agent 共用一份）：`id` + 观测（`url` / `title` / `favicon` / `isLoading` / `active` / `prototype{slug,origin}` / `prototypePage`）+ 声明（`openedBy`）。`toTabSummary(instance, tab)` 是**标签页变成 wire 形状的唯一地方**，三条消费路径不可能对同一个标签页说不同的话。
- **页名不是视图产出**，是原型页表查出来的：`tabPrototypeBinding` 从 `prototypeBindingFor` 拆出来（同样的两步，只是按标签页问），`prototypePageResolver` 只在这个标签页确实属于某原型时才问。查不到就说"不是这个原型的任何一页"，而不是给最近的页名（overlay 的 URL 根本答不了这个问题）。
- **声明只有一个字段：`openedBy: 'user' | 'agent'`**。由开它的入口写一次，之后没人改；默认 `'user'`（不可错的那个方向）。agent 侧在 `SessionManager.createTab` 一处盖章，而不是各调用点自己写——漏盖会让 agent 自己的标签页看起来像用户的，而"别动用户的东西"正是读这个字段做的判断。
- **`disposition`（typed/link/popup）与 `purpose` 明确推迟**：前者要等"开窗一律开标签"（第 4 项）才有产出者——现在每一个标签页都是某次显式"打开"造的，字段会是个常量；后者现在的内容（哪个原型/哪一页）已经能从 `prototype`/`prototypePage` 推出来，而推得出来的东西再声明一遍就是第二个来源。**不造没有产出者的字段**，等第 4/5 项。
- **`tabs` 命令输出两分**：每个标签页先列观测（`url` / `prototype` / `page`），再列 `opened by`，并在末尾说明哪一半是标签页报的、哪一半是开它的人说的。
- **UI 标签条**：`TOOLBAR_TABS_HEIGHT = 36`，`toolbarChromeHeight(instance)` = `TOOLBAR_HEIGHT + (tabs.length > 1 ? 36 : 0)`，五处布局（工具栏 bounds、内容区域 bounds、遮罩内缩、`window-resize` 的加减）全部改用它。**只在多于一个标签页时出现**：一个标签页就是窗口本身，一行只装一个标签页的 chrome 什么也没说；这也是 `+` 出现的地方。渲染器**不自己判断**是否显示——主进程把 `showTabStrip` 和 `tabs` 一起推过去，同一个布尔值决定留出多少空间和画不画。
  - > **第六轮修正（用户指出）**：条**常驻**了。它是用户自己那个 `+` 所在，而"窗口只有一个标签页"**正是**要开第二个标签页的时候——藏在两个标签页之后等于把唯一的入口藏起来（用户原话："浏览器窗口缺少标签栏啊，用户也可以自己新建标签"）。于是 `showTabStrip` 恒为 `true`、`toolbarChromeHeight()` 恒为 84，条与 `+` 一直可见；"同一个布尔值决定空间与绘制"这条约束保留（只是它现在恒真）。
  - > **第六轮再修正（用户指出）**：横条本身不成立，它成了**左侧竖向标签栏**。横条在跟地址栏抢宽度：第二个标签页就把地址栏挤开、后面的标签页滚出视野，"几乎没法正常使用"（用户原话）。标签页是会长长的**列表**，而窗口缺的是**高度**而不是宽度——所以标签栏取窗口左边一列（`TAB_RAIL_WIDTH = 200`）。chrome 因此是两块：`toolbarView`（地址栏）与 `railView`（标签栏），因为它们各是一个矩形；同一份 `browser-toolbar.html` 用 `?view=bar|rail` 说自己是哪一面。`TOOLBAR_TABS_HEIGHT` 删除、`toolbarChromeHeight()` 恒为 48（只剩地址栏），内容区域由 `tabAreaBounds` 一处给出（x 让 200、y 让 48），`window-resize` 加回的是 `+200 / +48`。**`showTabStrip` 这个字段随之删除**：竖栏是窗口的一列，不是需要两处商量的状态。
  - > **第六轮三次修正（用户指出）**：标签栏**被盖住**过，而且地址栏不该压在它上面。于是列的归属定死：**`railView` 是整列（y 从 0 到窗口底）且永远是窗口里最上层的 view**（`raiseChromeViews` 最后抬 rail），**地址栏那一行从 x=200 开始**——返回、地址、动作全部在标签栏**右边**，"地址栏保持原几何"这条因此让位于"标签栏是一列不能被打断"（用户原话："标签栏层级提到最高，返回按钮、地址栏都是在右边"）。菜单展开时地址栏仍然向下压住**内容区域**，但不再经过标签栏；两者的顶行都是 48，横看是一条带子。
  - > **第六轮四次修正（用户指出）**：chrome 的颜色**不再跟随网页**（用户原话："怎么标签栏、地址栏色颜色会被网页背景影响？"，并选了"都不跟随，一律用应用底色"）。之前是 Safari 式的取色跟随（`theme-color` meta → 吸顶栏 → `body` 背景），跟随的那一半删掉：通道、preload API、工具栏状态字段一起消失，**取色本身留着**——顶栏的窗口徽章与输入框状态条还用它对用户说"这个窗口在显示什么"。判据是：chrome 是应用的面，页面不拥有它。
- **工具栏渲染器**：`TabRail` 组件（标签页：标题、加载态、活动态、"agent 开的"标记、关闭按钮；自己的那一行里放 `+`）。**chrome 用应用自己的底色，不跟随网页取色**（第六轮四次修正，用户决定）：`browser-toolbar:*:theme-color` 通道、preload 的 `onThemeColor`、工具栏状态里的 `themeColor` 全部删除；取色本身（`extractThemeColor` / 页内 observer / `tab.themeColor`）保留，因为顶栏徽章与输入框状态条仍用它说"这个窗口在显示什么"。渲染器读 `?view=` 决定自己是哪一面。
- **面板按窗口分组**：顶部徽章下拉里，窗口的标签页列在它的动作之上（活动标签页打勾，agent 开的带标记），点击 = 切到那个标签页并前置窗口；`+ New tab` 也在那里。**关闭故意不放在这里**：它留在窗口自己的标签栏上，正在关的那个标签页就在眼前。
  > **修正（用户报告）**：这份标签页列表**恒常显示**，只有一个也显示那一个（用户原话："只有一个标签页也要显示标签页列表"）——这里正是看"窗口里开着什么"的地方，只有一个就藏起来等于什么都没说；分组标题仍只在多于一组时出现。行上的两件事分开：**点击 = 显示那个标签页**（切标签页仍是窗口自己的状态，但窗口会跟着**被带到前面**——看不见的窗口里切标签页只是半个动作，这也是"后面那个窗口怎么叫到前面来"的答案，用户原话："打开浏览器窗口并切换到该标签"）；**右键 = 把这个标签页作为 chip 交给对话**（§12.7.2，与"窗口在显示什么"无关，所以完全不动窗口）。"`+ New tab` 也在那里"随之修正：它从列表里**搬出来**常驻动作区（只有一个标签页的窗口正是要点它的时候），并且**会真的加一个、把窗口带到新的那个前面**。
- **通道**：工具栏 `browser-toolbar:tabs`、面板 `browser-pane:tab-action`，两者都是**一个通道三个动作**（activate/close/new）——三个按钮挨在一起、指向同一个窗口，分成三个通道只会多三份样板。
- 测试：窗口侧 5 条（标签条空间随标签页数伸缩、`listTabs` 两半、按页问原型页名、标签条 IPC 三动作、动作没指名时不做事），面板 2 条（三动作路由、没指名不做事），runtime 侧 `tabs` 两分 + "不是这个原型的页"。

**第四轮（一个工作区一个浏览器窗口 + 多标签）**：

> **粒度是用户定的**：「按 workspace 拆分窗口，不同 workspace 一个窗口 + 多标签」。也就是说**窗口 = 工作区**，不是"全应用一块"。跨工作区仍然隔离——那是既有的安全边界（不同工作区可能信任级别不同），而且它是**唯一**还需要保留的隔离维度：会话之间、会话与用户之间都不再隔离。
>
> **别叫它"画布"**（这一条是用户纠正的）：这是**工作区的浏览器窗口**，不是原型工作台的画布。同一个工作区里还有跟原型毫无关系的通用任务（查资料、填表、看后台），它们用的是同一个窗口。窗口的身份是**作用域**（工作区 vs 会话），不是用途。

- **窗口的身份是 `workspaceId`，不是"谁的窗口"**（原先还配了一个 `isWorkspaceWindow` 旗标，收口时删掉了：窗口只有一种，旗标没有第二个值可区分）。`createForSession(sessionId, {workspaceId})` 的语义从"建我的窗口"变成"取这个工作区的窗口，并且**我现在是它的驱动者**"；`sessionId` 可以为 `null`（手动开窗：同一个窗口，没人开车）。所以：
  - 同一工作区的**所有会话**拿到**同一个** instanceId；
  - **用户手动开的标签页也在同一个窗口里**（`browser-pane:create` 无 `id` 时走它；TopBar 的「New Browser Window」因此变成「New tab」，菜单项改文案、`browser.newWindow` 键删除，与标签条的 `+` 共用 `browser.newTab`）；
  - 显式传 `id` 仍能拿到一个具名窗口，但那只剩**内部机制与测试**在用，它与其他窗口没有种类差别（收口后 `createInstance` 的 `isWorkspaceWindow` 选项消失）。
- **`boundSessionId` 从"归属"改成"租约"**（字段名没改，含义与文档改了，改名留待后续）：每条命令都经 `createForSession` 解析窗口，所以"谁在驱动"自己就刷新了；`unbindAllForSession` 只放租约、不放窗口；**手动开标签页不刷新租约**（人点几下 ≠ 某个对话停了）。
- **生命周期**：`destroyForSession` **不销毁这个窗口**（只放租约）——它还可能装着别人和用户的标签页；收口后没有第二种窗口可销毁，所以它一律只放租约；`unbindAllForSession` 也不会把它降级成别的什么（它不是谁的）。
- **远程路径**：边界就是**工作区**——`requireInstanceInWorkspace` / `listInstancesForWorkspace` 与 `sessionWindows()` 是同一个判断。原先在远程桥上给会话身份加的命名空间（owner-key `remote:<ws>:<sid>`）收口时整体删掉了：一个窗口只被**它自己工作区**的会话碰，而这些会话来自同一台服务器，本来就是同一个 id 空间；会话身份因此不再需要在实例字段与 wire 之间来回翻译。原来"远程 agent 一律给新窗口，免得碰用户窗口"的理由随之消失（agent 和用户看的就是同一个），**但工作区边界没松**。
- **手动开窗不再是"第二个窗口"**：`sessionWindows()` 成为"这个会话能动哪些窗口"的唯一定义（按工作区过滤），`resolveLifecycleWindowTarget` / `focusWindow` / `listWindows` / `verifyPrototype` 全部改用它。
- **`close` 的语义跟着规则 3 收紧**：窗口**不可被某个对话关掉**，它关的是**这次任务开的那些标签页**（一条也没有时说明替代方案：`tab-close <id>`、`release` 撤遮罩）——收口后没有"独立窗口仍可被关"这一档。`windows` 输出里 `lockState` 换成 `driver:`（`the workspace's window, driven by X` / `driven by X` / `nobody driving`），`summarizeWindows` 的 `locked=` 改成 `driving=`——"锁"这个词在共享窗口上已经不成立。
- **多绑收口**：`describeWindowPrototype(sessionId, url)` 删除，换成 [`describePrototypeAtPage`](domain/prototype-page.ts)——**标签页决定优先**（`tab.prototype`，开标签页时记的，overlay 载入第三方地址后唯一还成立的答案），会话绑定只在标签页说不出话时兜底。`snapshot` 与 `listWindows` 都改用它；`getBoundPrototypeSlug` 同样先问活动标签页（同步读本地面板；远程桥答不了就回落会话绑定，正是它原来的答案）。**这一条就是"一个对话同时经营多个原型"的全部**——不需要新字段，因为标签页上早就有身份了。
- 顺带修掉两个多标签留下的洞：`findInstanceByTabWebContentsId` 原来只看活动标签页（后台标签页发起 empty-state launch 会找不到窗口）；`browserHostBySession` 这个字段名（按 sessionId 存）保持不动，只是把"canvas 式的命名"从这一层彻底清掉。

> **收口（单窗口落地之后）**：窗口只有一种，于是"谁拥有这个窗口"这一整套词汇一起删掉——`ownerType` / `ownerSessionId`、`bindSession` / `unbindSession`、`isWorkspaceWindow`，以及远程桥用来给会话身份加命名空间的 owner-key（`remote:<ws>:<sid>`）。留下的三件事，每件只有一个答案：
> - **窗口的身份** = `workspaceId`（`findWindowForWorkspace` 按它找）；
> - **谁在驱动** = 租约：标签页上是 `cursorOf` / `driverSessionId`，标签锁 `lockedBy` 就是**驱动它那个会话自己的 id**，而它只由 `setSessionTab` 写下——所以 agent 读回来的串与它自己的 id 必定相等（原先远程桥上这两处是两个不同的串，标签锁因此静默失效）；窗口上不再有任何会话字段（`boundSessionId` 在下一轮删掉）；
> - **边界** = 工作区：`requireInstanceInWorkspace` / `listInstancesForWorkspace` 与 `sessionWindows()` 是同一个判断，`close` / `focus` / 生命周期不再有"锁定到会话 X"这一档，`windows` 里也不再有 `ownerType` / `ownerSessionId`。
>
> 会话身份**不再翻译**：远程桥上 `setSessionTab` / `createTab` 的会话身份由请求身份派生，不读调用方在参数里拼的那个。

**一轮（标签页是并行的工作单位；Conductor 落地之后）**：

> 起因是**共享了但用不了**：Conductor 的并行子会话技术上共用同一个工作区窗口，但这套模型是**顺序驾驶**长出来的——窗口级租约 + 单槽 overlay——两个子会话一开工就互相顶掉（第二个会话的 `tool_start` 把第一个的标签锁**静默抹掉**；`boundSessionId` 每命令一抢；`clearVisualsForSession` 还要求"我先得是驱动者"）。解法不是给窗口加锁，而是把**窗口级单槽全部拆到标签页上**，并把"谁在这个标签页上"变成可写的资源。

- **标签锁是每个标签页一个**（`BrowserTab.heldBy`，对外 `lockedBy`）：原先 `agentControl` 是窗口级单值（`sessionId` + `tabId`），第二个会话开工即整对象覆盖、`heldBy` 变 `null`；现在每个会话各持自己的标签页，互不干扰。窗口级只留"这里有人在干活"的指示（DTO 的 `agentControlActive` = `controlBy.size > 0`），chip 的文字取**持有屏幕的那个标签页**的会话，它没持有时取最近开始的那个。
- **窗口级租约 `boundSessionId` 删除**：并发下它必然抖动（每条命令都 `createForSession` 抢一次），而它剩下的用途各自有更精确的归属——遮罩的定位/撤销按 `heldBy` 与 `controlBy`、渲染层读当前标签页的 `lockedBy`/`cursorOf`/`openedBySessionId`、下载目录与原型兜底按**标签页**的会话来问。删掉之后"谁在这扇窗里"只剩标签页的回答。
- **reach 改"一个标签页一个主"**：`whyTabIsOutOfReach` 去掉 prototype 分支——同原型不再放行。一个标签页要么是本会话的任务（自己开的、被分配的、从自己标签页派生的），要么**还没人认领**（`openedBySessionId === null && cursorOf === null`：人开的标签页、新标签页——这才是"你先开、agent 接着用"）。兄弟会话不再互相踩标签页。
- **`tab-assign <tab-id> <session-id>`**：分配是显式动词，不是 `createTab` 的副作用。父会话把标签页交给子会话——标签页的任务改为接收方，并**成为它 work from 的标签页**（否则"给你一个标签页"给到的是一个它够不着的标签页）；只允许交出**自己的标签页或无人认领的标签页**，接收方必须是**同工作区的会话**（这条在 SessionManager 判，因为只有它知道会话）。
- **子会话不动人的视线**（`parentSessionId` 非空）：不允许"接屏"（没有自己的标签页时拒绝并指路 `tab-new` / `tab-assign`，而不是接管屏幕上那个标签页）；`tab-show` 只改自己的游标、不移动可见标签页，并在输出里如实说明；`open --foreground` / `focus` / `hide` 一律拒绝。它的活儿在背后干，要给人看由父会话来 bring up。
- 验收：`browser-pane-manager.test.ts` 的「lets two conversations work in it at once, each on its own page」（两个会话各自的标签页与锁同时成立，一个收尾只放自己的那个标签页）与 `tab-assign` 用例（交出去之后谁够得着、谁够不着）。

**一轮（归属：标签页属于一份"活"；Conductor 之后）**：

> 起因是用户点名的**"归属要搞清楚"**。上一轮把并行做成了"每个标签页一个会话的锁"，但标签页的**归属**仍写着会话 id（`openedBySessionId`）——而会话是**执行者**，不是活。DAG 一眼就撞上：一个节点跑 FAIL 之后 `repairForVerdict` 重跑它，走的是同一个 `dispatch`，于是**新建一个子会话**；旧标签页挂着一个已经停止的会话，新会话够不着（reach 拒绝）、编排者也收不掉（`close` 只关自己开的标签页）——**修一轮多一批孤儿标签页，谁也不认**。

- **归属的主体是"活"（`TabBelongsTo`），两档**：`{ kind: 'session', sessionId }`（一份对话的活）与 `{ kind: 'task', taskSlug, runId, nodeId, sessionId }`（Tasks 的一份活：`nodeId: null` = 任务本身，即编排者的标签页；否则 = 一个节点）。字段 `openedBySessionId` → `belongsTo`；任务档里的 `sessionId` 只是**谁开的**（给标签栏念名字），**不参与身份**。生产点唯一：`workOfSession(managed)`（`dto.ts`），所以"会话变成谁的标签页"只有一处答案。
- **两个判据，宽窄不同**（`sameWork` / `sameTask`，纯函数、在 `dto.ts` 与类型同处）：reach 用 `sameWork`（同会话，或同任务 + 同 run + 同节点）——**同一任务的不同节点不放行**，第十一轮的"一个标签页一个主"原地保持；close 用 `sameTask`（同 `taskSlug`，不看 run 也不看节点）——**整个任务都能收自己的标签页**，编排者因此第一次有了回收权（它从没"开"过节点的标签页，而开标签页的节点早已停止）。可达要精确、清扫要宽松，这一条是这次把两件事分开的收益。**注意 reach 给的是"可达"，不是"自动接管"**：重跑的那个会话可以接着用旧标签页，但它得先看一眼 `tabs`（见末尾那条推迟项）。
- **`createTab` 的盖章从"会话"换成"活"**：`openedBySessionId?: string` → `belongsTo?: TabBelongsTo | null`（整块 work），派生标签页**继承整块 work**（第十一轮的规则不变，只是继承的东西从 id 变成活）；`assignTab(instanceId, tabId, to, by)` 的 `to` 是**接收方的活**，只有 `SessionManager` 解析得出来（browser 侧查不到会话的任务身份），`by` 是交出者的活。
- **远端桥把"活"当身份**：`BrowserCapabilityRequest` 新增 `work`，与 `sessionId` / `workspaceId` 并列（都是"谁在问"，不是"做什么"），dispatcher 用它盖章 `belongsTo`，**绝不从 `args` 读**——与当年 `openedBySessionId` 同一条理由：不能替别人写声明。`RemoteBrowserPaneManagerDeps.getWork` **每次调用现问**，因为会话可以在创建之后才被绑上任务（`bindExistingSessionToTask`）。
- **不动的东西**：`cursorOf` / `driverSessionId` / `heldBy` 仍是会话级。"**这是谁的活**"与"**现在谁在干**"是两件事，这次的全部意义就是把它们分开——租约的换手、标签锁的排他、游标的粘性一个字没改。
- **视图**：`tab-groups` 由 `groupTabsByOpener` → `groupTabsByWork`，**一个任务一段**（同一 DAG 的节点标签页不拆段，段头写任务 slug——slug 就是它的名字，所以任务这一档不需要新的 label 通道；会话段仍读 `sessionLabels`）。
- **徽章菜单里那句 "Open Session Which Used this Window" 删掉**（用户点出）：窗口是工作区的、多会话共用，"用过这扇窗的会话"不是一个存在的事实——代码本来就偷偷读的是**标签页**。按钮留着（"从浏览器跳回对话/任务"是有用的动线），但目标**按屏幕那个标签页**解析：谁在动这个标签页（`lockedBy`）/谁从这个标签页干活（`cursorOf`）→ 那个会话；否则看归属——会话的标签页 → 那个会话，**任务的标签页 → 任务本身（编排者会话）**，不再回落到 `belongsTo.sessionId`（那是**开这个标签页的那个会话**，provenance；节点重跑之后它已停止，点进去是一条死对话）。文案随目标走（`browser.openTabConversation` / `browser.openTabTask`，7 个 locale 同批加）。
- 验收：`tab-access.test.ts`（重跑节点接管旧标签页 / 兄弟节点不放行 / 跨 run 不放行 / 编排者可关本任务标签页）、`browser-pane-manager.test.ts` 的「stamps a node's work on the page, so a re-run of that node inherits it」、`tab-groups.test.ts` 的「keeps a task's nodes in one section, under the task」、`utils.test.ts` 的 `openTargetOfActiveTab`（任务标签页 → 任务的会话，只有被 spawn 的节点会话时**不退回**；草稿编排者不算；人开的标签页与没在屏幕上的标签页都没有目标）。
- **不做自动开标签页**（用户定："先放着"）：Conductor 不替节点**开**标签页，也不替它**收**标签页。节点要浏览器就自己 `tab-new`（归属保证它拿到的是自己节点的标签页，兄弟节点够不着），任务标签页由编排者用 `close` 收——族判据已经放行。三条理由与"run 结束不自动关标签页"写在 §6.4。
- **一个已知且无害的残留（推迟）**：重跑时节点若**再次** `tab-new`，会多留一个标签页。它归**同一个节点**（重跑者可达）、归在标签栏的**任务那一段**、任务可 `close` 收掉——所以它不是孤儿，只是多一行。最小修法不是自动分配，而是让 `tab-new` 对"任务节点的活"**幂等**（已有同节点标签页就复用并设为游标）；**推迟**，等真实 repair 出现堆积现象再做。在那之前，节点侧的正确习惯是**先 `tabs`**：`belongs to:` 写着你这个任务和节点的标签页就是你的，用 `--tab <id>` 接着干，比再开一个标签页好。
- **如果将来真要做，形状是按节点 opt-in**：spec 里给节点 `browser`（可选带 URL），runner 只对声明了的节点预开，且预开失败只降级（"你自己 `tab-new`"）**绝不判节点失败**。触发条件：出现实测证据——节点因为拿不到标签页而失败、或节点之间互相踩标签页。

**第五轮（元素选择器常驻：模式属于窗口，元信息属于标签页）**：

> 规则来自第四轮的窗口：一个窗口装着好几个标签页，那么"选择器"就不该是某个标签页上的一次性动作，而该是**这个窗口的一个模式**。规格在 §12.7，这里记的是它与窗口/标签的关系。

- **模式在窗口上，命中在标签页上**：`picking` / `pickLabel` / `pickTabId` / `pickerGeneration` 是窗口级字段；而"这次命中来自哪个标签页"由 `describeTabLocation(instance, tab)` 现算，并作为 `PickedElementOrigin` 挂在 action 上。**标签页决定优先**这条规则在第五轮换了个位置再次成立：不需要给窗口记"当前元素来自哪个原型"，因为标签页已经说出了自己是谁。
- **一个地方产出"这是哪个标签页"**：`describeTabLocation` 与 `toTabSummary` 是同一个函数的两个投影（前者是后者减去视图瞬时态），所以标签条上的页名与元素带来的页名不会各说各话。这是第三轮"`toTabSummary` 是唯一 wire 形状"这条约束的延续。
- **重新武装的三个时机**（`activateTab` / `closeTab` 的邻居接位 / 页面自己导航报 `missing`）与 `pickerGeneration` 的作用见 §12.7；要点是**撤 overlay 的是它实际所在的那个标签页**（`pickTabId`），因为接管发生时活动标签页可能已经换人。
- **共享窗口让"落点"这条旧推理失效**：原来"有会话才能选"读的是窗口的绑定，而这个绑定是**租约**——"agent 刚才在动谁"。人点元素要去的地方是**人正在看的那个对话**，不是那个租约；没有就新建一个。于是工具栏状态里的 `hasSession` 删除，按钮不再会被禁用。

**第六轮（标签级占用与接管；一切开窗都成标签页）**：

> 两条用户点名的下一项，合在一起是因为它们回答同一个问题：**这个标签页是谁的、谁在动**。前者的答案是声明与租约，后者是让"新开的标签页"也有这两样东西。

**标签级占用**：

- **标签级声明 `openedBySessionId`，不是 `openedBy: 'user' | 'agent'`**。粗的那个答不了"是不是*我*的标签页"：两个对话共用一个窗口时，"agent 开的"可能是另一个对话的，而"别动别人的东西"正是读它做的判断。`'user' | 'agent'` 退化成**渲染**（agent 的 `tabs` 输出里写成 `opened by: agent (<session>)` / `a person`），不再是第二个存储的来源。
- **标签级租约 `driverSessionId`**：窗口的租约说"谁有这块窗口"，标签页的说"在动哪个标签页"。刷新点在 `setWindowDriver`——每条命令都经 `createForSession` 解析窗口（`--tab` 已在命令体之前把那个标签页调到前面），所以"驱动者"自动落在**屏幕上那个标签页**；轮次结束由 `unbindAllForSession` → `clearTabLeases` 清掉。**它在所有窗口上扫一遍**，因为一个对话可能驱动过某个标签页、之后窗口租约被另一个对话接走：它的轮次结束时仍要放开**它自己**的标签页。
- **两条规则，不是一个布尔**（落在 [`domain/tab-access.ts`](domain/tab-access.ts)，纯函数 + 单测，因为它俩是这条边界被评判的地方）：
  - **够不够得着**（能不能动）：标签页不属于任何原型（普通网页，谁都能用——这正是"用户先打开、agent 接管"对通用任务成立的原因）、标签页属于本会话所绑原型、标签页是本会话自己开的（`open` 一个没绑定的原型，仍然要能读自己刚开的那个标签页）。其余一律拒绝，并且**说清是哪个原型的**、怎么改。
  - **是不是我该关的**：只有**本会话开的标签页**。用户的标签页、另一个对话的标签页，都不因为"够得着"就能关——那是别人的活。
- **`close` 因此有了真正的语义**（用户选了"关完只剩空白页"）：工作区窗口**永不被某个对话关掉**，但 `close` 变成"关掉我开的那些标签页"；若这些标签页就是全部，先补一个空白标签页再关，于是窗口回到"刚开窗的样子"而不是空。什么都没开过时说清楚，并给出 `release`。
- **租约换手，不做互斥**（用户定的）：谁的命令落到这个标签页，谁就是它的驱动者；被别的对话驱动不构成拒绝理由——拒绝只因为**这个标签页不属于你的原型**。可见性够了，排队是另一层机器。
- **可见性**：agent 的 `tabs` 每个标签页多两行（`opened by:` / `driven by:`，后者标 `(you)`），窗口左侧标签栏给"正被驱动"的标签页一个点（i18n `browser.tabInUse`）。

**开窗通道收敛**（用户定的：都不开新窗口，同窗口新建标签页，在原来那个标签页**右边**）：

- `setWindowOpenHandler` 里**所有** http(s) 请求都 `deny` + 开一个标签页：`target="_blank"`、`window.open`、popup、原型自己文档上的链接。真·第二窗口那条路整段删掉（`registerPopupWindow` / `unregisterPopupWindow` / `closePopupsForParent` / `did-create-window` / 两张 popup 表），因为再没有它的生产者。
- **`createTab` 新增 `afterTabId`**：新页插在"要它的那一页"右边（用户的话）。`unwritten` 复用也因此收窄：只在命令加标签页时生效——**开窗请求要的那个标签页按定义是在用的**，复用它等于把用户点的那个标签页拿走。
- **`disposition` 落地**（这是第 4 项一直缺的产出者）：`'link'`（`foreground-tab`/`background-tab`，以及其余非 `new-window` 的说法）与 `'popup'`（`new-window`，即带 features 的脚本 `window.open`）；`null` = 不是浏览器要的（地址栏、`tab-new`、`open`、面板）。`background-tab` 的请求不进前台。
- **代价说清**：这样开的标签页**没有 `window.opener`**，所以等 `postMessage` 回传的 popup（Google 登录是典型）会一直等。`disposition` 就是为此留的——撞上时能查，而不是靠猜。另外 `<a download>` 这类"要窗口其实是要存盘"的请求在 Electron 的类型里根本不会走到这个 handler（`disposition` 的联合类型里没有 `save-to-disk`），所以没有特殊分支。
- **`disposition` 归观测**：不是谁声明的，是浏览器报的（与标题同类），所以放在 `BrowserTabSummary` 的观测半边；agent 的 `tabs` 在非 null 时多一行 `opened as:`。

**这一轮留下的两个后果**（写下来而不是留着猜）：这样开的标签页**不可能自己关掉自己**——Chromium 只允许脚本关掉"由脚本打开的窗口"，而这个标签页不是（它没有 opener），所以 OAuth 之后 `window.close()` 的 popup 会**留在标签栏上**，等人或 agent 关；以及窗口自己**导航**（`window.location = …`）仍发生在同一个标签页里，那是"一个标签页去了别处"，不是新标签页。

**第七轮（不锁：窗口是所有人的，遮罩只是标签）**：

> 用户定的：窗口现在承载用户的和其他会话的操作，"锁"没有位置了（用户原话："去除 agent 对窗口的锁定…我认为不锁问题也不大，agent 和用户同时操作"）。

- **删掉的三件事**：① `applyAgentControlLock` / `lockState`（agent 工作时把窗口 `setResizable(false)`，撤了再恢复原值）；② 三处 `before-input-event` 的 `preventDefault`（地址栏、标签栏、内容区域——上锁时键盘输入被吞）；③ 遮罩的点击屏蔽（`#shield` 在 agent 模式下 `pointer-events: auto` + `cursor: not-allowed`）。`AgentControlLockState` 类型、`getWindowResizable` / `setWindowResizable`、`reapplyAgentControlVisual`（它唯一的额外工作就是那把锁）一并删除。
- **遮罩只剩信息**：边框 + chip（哪个窗口在被操作、在做什么）。它不再吃任何输入；输入屏蔽保留**唯一**一个理由——菜单展开时点页面 = 关菜单，所以 `#shield` 的 `pointer-events` 现在只由 `menuActive` 决定。
- **同一个标签页上的交错是接受的代价**：两个 actor（用户 / 另一个会话）可以先后落在同一个标签页，甚至交错。模型给的答案不是拦住谁，而是**说清谁在动**——`driven by` 逐个标签页刷新（租约换手），agent 侧读到的是"你已经不是驱动者"或页面已被换掉，而不是"禁止"。这也让第四轮那句"`boundSessionId` 是租约不是锁"第一次**同时**对用户成立。
- **"标签组"不引入**（用户提问：让 agent 的 session 与标签组对应）：见下。

**关于标签组（用户提出，分析结论）**：

- **现状**：窗口 = 工作区，标签页是单位，而标签页上已经有"谁的"（`openedBySessionId`）和"谁在动"（`driverSessionId`）。"某个会话的标签页"这个问题**已经被回答**，缺的只是 UI 上成组显示。
- 组有两种可能的语义，必须分开看：
  - **视图的组**（标签栏/面板按 opener 会话分段，段头写会话名）：成本低（一个纯函数 + 渲染），不引入新概念、不改变任何权限，解决的是"哪些标签页是我的/别人的"看不看得见。这正是"下一轮：面板按会话分组"那条。
  - **归属/排他的组**（一个组同一时刻只允许一个会话驱动，别人排队或拒绝）：这等于把刚删掉的锁**降一级搬到组上**。它要新字段（组 id、组级租约）和新拒绝路径，收益只有"防止同一个标签页交错"——而那件事由可见性 + `--tab <id>` 已经够用；代价是把"标签页是单位"打散（一个标签页属于哪个组？两个会话各开一个标签页、第三个会话借其中一个标签页时组怎么算？）。
- **结论**：先做视图的组（与"下一轮"合并），不做归属的组。等真出现"两个会话抢同一个标签页并因交错造成实际损失"的证据，再考虑**可见的**组级排他，而不是隐藏的锁。

**第八轮（视图的组：标签栏与徽章按"谁开的"分段）**：

> 第七轮的分析结论落地：只做**视图的组**，不做归属的组。

- **规则**（`components/browser/tab-groups.ts`，纯函数 + 单测）：按 `openedBySessionId` 分段；**段落在它第一个标签页的位置**，标签页在段内保持原相对顺序——列表仍然读作"标签页被打开的顺序"（与 `tabs` 一致），排序成"我的在前"会是这里新造的第二套顺序，而说谎的位置比分组更糟。**只有一个组时不画段头**：一行"这些都是你开的"盖住全部，没有信息量还占一行。
  > **第十四轮改了两处**：人的那一段固定在最前（"段落在它第一个标签页的位置"对这一段不再成立，其余段照旧），以及段头改成"只有'你'那一组不画"。理由见第十四轮 —— 第八轮担心的"说谎的位置"，在"哪一段是人的"这件事上换了个判据：人的标签页不是列表里的一段，而是窗口的默认读法，它不该跟着别人开的顺序往下沉。
- **两处渲染同一个函数**：窗口内的标签栏（`browser-toolbar.tsx`）与顶栏徽章里的标签页列表（`BrowserTabStrip.tsx`）都调 `groupTabsByOpener` / `shouldShowGroupHeaders`，所以两张列表不可能对"哪些标签页是谁的"各说各话。
- **段头写名字，不写 id**：`openedBySessionId` 是 id，人读不了。标签栏是**独立文档**（自己的 preload，没有会话列表），所以主进程把 `sessionLabels: Record<sessionId, string>` 和 `tabs` 一起推过去；徽章在应用外壳里，直接用 `sessionMetaMapAtom`。两边都只取**名字**——"谁的标签页"仍然是标签页自己的字段，分组只读它，从不写。
- **resolver 与其它几个同形**：`setSessionLabelResolver`，在 `main/index.ts` 里接到 `SessionManager.getSessionName`，晚绑定。无名（还没生成标题）或已删的会话不进 map，chrome 退回 i18n 通用称呼（`browser.openedByConversation`；人开的那组是 `browser.openedByYou`）。
- **行上的 Bot 图标只在没有段头时出现**：段头已经说了"这是一个对话的标签页"，每行再画一个 bot 是重复；"正在被驱动"那个点照旧常显——那是另一件事（现在 vs. 谁开的）。
  > **第十四轮删掉了这个图标**（连同它的条件）：段头换成对话图标之后，行上再画一个"谁开的"是同一件事说两遍；而且按第十四轮的段头规则，它的条件已经不可能成立——没有段头 ⇔ 只有"你"一组 ⇔ 那一组里的标签页都不是别人的。两处（rail 与徽章列表）一起删。
- **不是归属的组**：没有组 id、没有组级租约、没有任何新的拒绝路径。分组是读 `openedBySessionId` 得出的视图，权限规则（reach / close / 驱动租约）一个字没动。徽章那一列"这个窗口现在谁在驱动"仍然没说，那是另一件事。

**第九轮（锁回到标签页上：窗口是所有人的，正在被操作的那个标签页不是）**：

> 用户定的：把锁加回来，但**锁标签页不锁窗口**（用户原话："能否把锁加上，但锁的是页面不是窗口"）。第七轮删掉的那把锁，粒度降一级回来。

- **锁是推导出来的，不是存的**：`BrowserTabSummary.lockedBy` = 窗口有 overlay（`agentControl.active`，表示那个会话这一轮在跑命令）**且**这个标签页是它命令的落点（`driverSessionId === agentControl.sessionId`）。推导在 `toTabSummary` 一处，所以它不可能和那两个事实漂移——只有 overlay 没落点 = 只戴标签不占标签页；只有租约没 overlay = 有人动过、但不是正在动。**类型上它不属于三分（观测/声明/租约）里的任何一半**：它是"租约落地之后的样子"，这一点在 `dto.ts` 里写清了。
- **锁挡谁**：① 人——活动标签页的遮罩 `#shield` 重新吃输入（`pointer-events: auto` + `cursor: not-allowed`），内容区域视图的 `before-input-event` 在**这个标签页被锁时**吞键盘（两者都**实时**读这个标签页的持有者 `tab.heldBy`，所以锁跟着租约走：轮次一结束、overlay 一撤，页面立刻恢复可交互）；② 别的会话——`whyTabIsLocked` 落在与 reach 同一道闸门（命令入口的活动标签页、`--tab` 指名的那个标签页），另外**关标签页也过这道闸**（`assertTabUnlocked`：我自己开的标签页被别的会话接管时，不能在它脚下关掉）。
- **锁不挡谁**：标签栏、地址栏、窗口缩放、以及**其他每个标签页**——对人和对其他会话都一样。这正是与窗口锁的区别：窗口是整个工作区的，锁窗口就等于连用户自己的浏览和别人的标签页一起锁上。
- **锁的可见性**：标签栏把"被驱动"的点换成**锁图标**（被锁时；只是被驱动还是点），`tabs` 被锁的标签页多一行 `locked: <session> is working on it, so it is held until that turn ends`；拒绝文案明说是**暂时的**（"until that turn ends"），并给出出路（换一个标签页 / 等）。
- **口径更新**：`release` 的说明从"撤一个标签"改成"撤 overlay，同时释放它占着的标签页"；第七轮那句"遮罩只是标签"由这一轮取代。

> **第九轮修正（用户报告）**：锁**必须拴在指定的 tab id 上**，不能从"租约落在哪个标签页"推。用户原话："应该锁指定的 tabid，现在会锁了回退的页面，导致对话框一直被锁住。" 推导式的锁会把**命令回退到的那个标签页**（通常正是用户正在看的那个标签页）锁住，于是用户被自己那个标签页挡住，一挡就是一整个轮次。改成：`AgentControlState.tabId`——"这个会话**攥着**哪一个标签页"，由命令解析出目标标签页时写入（见第十轮），因此它是**指名**而不是推断。三条配套：① 同一会话再次激活 overlay 时**保留** tabId（否则每个工具之间会松手一次）；② **锁定的标签页被关掉 → 自动解锁**（`closeTab` → `releaseHeldTab`，锁绝不比它锁的东西活得久）；③ **用户可手动解锁**——标签栏上那把锁是个按钮，点它 = 撤掉 overlay（overlay 就是锁的载体，所以"解锁"和 agent 自己的 `release` 是同一个动作，只是从另一边发出）。这是逃生口而不是开关：agent 下一次动手可能重新拿住那个标签页，这一点在 i18n 文案与文档里都写明了。

**第十轮（游标归驱动者：人在看哪个标签页，不决定命令作用于哪个标签页）**：

> 用户指出的真问题："每会话一窗，用户也可能在操作这个窗口的别的标签，因为已经改成多标签了，不能用为用户切走了标签，任务就跑到新标签去了。" 也就是说：换窗口模型治不了这个病——**任何多标签窗口都有它**。病根是 `activeTabId` 一个字段被当成两件事用：**人在看哪个标签页**（显示）与**命令作用于哪个标签页**（目标）。

- **一个会话一张标签页：`tab.cursorOf`**（"这个会话**从这一个标签页**干活"）。它不是租约（`driverSessionId` 只说明"这个标签页最后一次是谁在动"），而是一个**粘性**的说法：跨轮次保留，只有这个会话自己的命令（或它开的标签页）会移动它，**人切标签页不动它**。
- **目标判定顺序**（落在 `pickCommandTarget`，纯函数 + 单测）：**`--tab` 指名** → 否则**本会话的游标标签页** → 都没有时才是**屏幕上那个标签页**。最后这条不是妥协，它就是**接管**那一幕（"你先打开、agent 接着用"）：新会话还没有自己的标签页，就在你面前那个标签页上开工，并且**从那一刻起那个标签页成为它的标签页**（游标写下来），于是你随后的点击不会把它的活儿拽走。
- **`activateTab(instanceId, tabId, { cursorForSessionId })` 一处写两个事实**：会话"从现在起从这个标签页干活"（游标）＋ 如果它正持有这个窗口的 overlay，"攥着这个标签页"（锁）。这个标签页已经在前台时**也要写**——游标是关于会话的事实，不是关于显示的事实；而人切标签页调用 `activateTab` 时**不带** `cursorForSessionId`，所以动不了任何人的目标。
- **目标不在屏幕上 → 顶到前面**（本轮取这个，第二小步才是"后台执行"）：窗口只有一个标签页可见，所以"操作一个标签页谁都看不见"既说不清也拦不住；顶到前面的且**是这个会话自己的标签页**，不是人刚才切到的那个标签页——语义因此可解释。
- **可见性**：`tabs` 给自己那个游标标签页多一行 `your tab:  yes — a command that names no tab acts here`；页脚解释"它跨轮次、且人切标签页不会移动它"。`BrowserTabSummary` 新增 `cursorOf`（"工作起点"自成一节，不算观测/声明/租约里的任何一半）。
- **标签租约跟着目标走**（这一步的连带修正）：`setWindowDriver` 原来把标签租约写在**屏幕上那个标签页**（"窗口解析出来时，屏幕上那个标签页就是命令要动的那个标签页"），目标与显示解绑后这条前提就假了。现在标签租约写在 `setSessionTab`（和游标同一处、同一个时刻），窗口租约仍留在 `setWindowDriver`——**窗口的那一半"谁有这块窗口"，标签页的那一半"这个标签页最后是谁在动"**，各自只有一个生产者。副作用说清：把游标移到另一个标签页后，旧标签页仍记着"上一次被谁动过"，这符合它的定义（不是"正在"），且轮次结束会清掉它（`clearTabLeases`）；游标**不**随之清掉。

**第十一轮（归属：标签页属于一个任务组，派生继承）**：

> 用户定的："完整归属"——agent 建的标签页归这个会话，**用户从这一个标签页派生的新标签页也归这个会话**；像任务组，用于浏览器窗口视图的逻辑分组。

- **规则只有一条**：派生标签页（`target="_blank"`、popup、原型文档上的链接）**继承父标签页的归属**（`openedBySessionId`）。不问"谁点的"——那个问题本来就答不了（agent 点和人点从进程里看一样），而且**不该答**：链接来自哪个任务的标签页，新标签页就属于哪个任务。
- **不是"只为分组"，是完整归属**（用户选的）：`reach` 与 `close`/`tab-close` 用的都是"**我任务里的标签页**"（我开的 + 从它们派生的）。代价已确认：你为了阅读而点开的标签页会落进那个任务的组，agent 清理任务时会一并关掉。
- **派生 ≠ 游标，也 ≠ 租约**：派生标签页**只继承归属**——不继承游标（人点开一个链接不该改变那个会话下一枪打哪个标签页；`afterTabId` 就是"这是派生的"的判据）、不继承租约（"谁在动"是关于动作的事实，不是关于来源的）、不继承锁。写在 `createTab` 的那个分支上。
- **三样各就各位**：`openedBySessionId`（**谁的**：写一次或继承）、`cursorOf`（**从哪个标签页干活**：粘性，只由该会话自己的动作移动）、`driverSessionId` + `lockedBy`（**此刻谁在动 / 谁攥着**）。视图分组读第一个，命令路由读第二个，排他读第三个。
- **可见性**：`tabs` 的标签由 `opened by:` 改成 **`belongs to:`**（派生标签页说"opened by"是假话）；拒绝文案、help、browser-tools.md 同口径。标签栏的段本来就按这个字段分，所以分组立刻变成"任务组"（这正是用户要的"视图的逻辑分组"）。
- **不动 `boundSessionId`**（那是窗口租约，另一个东西）：见答复——它仍承载 overlay 定位、生命周期定位、下载目录、`windows` 的 `driver:`、渲染层的"打开使用它的会话"。要删是**单独一步**，且删掉后那几处访问控制会简化（"锁定到会话 X"的拒绝本来就和"租约不是锁"矛盾）。
  - > **后来真的删了**（见 §22「标签页是并行的工作单位」一轮）：Conductor 的并行子会话把这一步从"整洁性"变成"必须"——窗口级租约在并发下必然抖动，而它列出的那几处用途各自都有标签级的答案（overlay 定位按 `heldBy`/`controlBy`，下载目录与原型兜底按标签页的会话，渲染层读当前标签页）。

**第十二轮（A：几何永远真实，前台性按需模拟）**：

> 先做实验（`apps/electron/spike` 七种情形并列；`apps/electron/spike/memory` 内存对照），再按数据改。两条结论：坏掉的从来不是"共享窗口"这个形态，而是 **0×0 停放**；而"让页面自认前台"**按需做**比全局做划算。

- **可见性数据**（2.5s 观测窗）：活动标签页 `visible` / 85 帧 / 定时器 1168ms / 截图正确；被覆盖的标签页 view（默认节流）**`hidden` / 2 帧**，但**截图仍然正确**；被覆盖 + 不节流 **`visible` / 88 帧**；**0×0 停放 `hidden` / 0 帧 / 视口 0×0 / 截图空白**；独立窗口三种做法（离屏 `showInactive`、`opacity 0`、从未 `show`）都 `visible` + 满帧 + 截图正确。
- **内存数据**（4 个相同标签页，各占一个 loopback 站点；**两种方案的进程数都是 7** = browser + GPU + utility + 4 个 renderer——确实是一个标签页一个渲染进程）：**停 0×0 = 613MB / 全尺寸节流 = 613MB / 全尺寸不节流 = 614MB / 一个标签页一原生窗口 = 624MB**。所以：**0×0 停放不省内存**；"不节流"的内存代价 ≈ 噪音；"一个标签页一窗"比单窗贵约 11MB（≈3MB/标签页，窗口本身很便宜，每个标签页那 ~78MB 的 renderer 两边一样）。这一条**修正了上一轮汇报里"61MB → 733MB ≈ 96MB/页"**：那是"从零到开 7 个标签页"的增长，绝大部分是每个标签页各自的 renderer，不是单窗/多窗的差别。
- **改法（几何 + 按需前台）**：每个标签页都给内容区域的 bounds（不再 0×0），**活动标签页在最上层**（`raiseActiveTab`：标签页 view → 它的遮罩 → chrome 三层）；**前台性跟着游标走**（`syncTabThrottling`：某个标签页是某个会话的游标 → `setBackgroundThrottling(false)`，其余交回 Chromium）。于是切标签页 = 一次抬栈；"有人在用的标签页"与真前台无差别；没人用的标签页保持廉价（内存一样，CPU 省下来）。
- **代价**：内存 ≈ 0（上表）；CPU 只在"有人正在用的标签页"上不节流——这正是要的。**实验脚本留档**：`apps/electron/spike/`（可见性）与 `apps/electron/spike/memory/`（内存），`node_modules\electron\dist\electron.exe apps\electron\spike[\\memory]`，不进打包。还差的一项 `hidden-after-show` 后来补量了（用户报告"截图卡住、必须显示浏览器切过去才截得到"，脚本留档在 `apps/electron/spike/capture-methods.cjs` 与 `screenshot-e2e.ts`（各带 `.log`），不进打包），量出**两件事**：
  - **窗口在屏幕上时**，被覆盖的标签页只要能取就 10–68ms 取回自己的像素（`CalculateNativeWinOcclusion` 已在 `index.ts` 关掉）；**窗口一藏**，`capturePage` 三种隐藏状态、三条路径全部不再应答——不是返回空图，是那个 promise 永远不 settle。所以"截图救援"（`showInactive` → 取图 → `hide`）不是兜底而是隐藏窗口唯一的路径，而它此前根本轮不到：重试循环卡在第一个 `capturePage` 上。
  - **一个从没到过前面的标签页，压根没有 surface**——窗口开着也一样。这正好是 agent 自己的标签页（`activate: false` 开在人的标签页后面），所以"必须切过去"是真的：切过去就是让它第一次被合成。`setVisible` / `invalidate` / `setBounds` / 不节流 / 窗口可见，全都无效；唯一有效的是让它去一个**会被合成的地方**——到前面一帧，或者（下面取的这条）交给一个离屏窗口一帧；之后它就一直有 surface 了。
  - **改法**：`captureWithinBound`（每次截图有上限，超时按"没图"算）＋ `captureWhileParked`（**按需把那个 view 拉出去**——用户定的方向："按需拉后台 view 不是更好吗"。交给一个停在所有显示器之外、**并被显示**的窗口，在那儿取图，然后把 view 交回原窗口、恢复 bounds 与层序、销毁那个窗口；app 自己的窗口全程不显示、不移动、不碰任务栏）。实测（`screenshot-e2e.ts`）：**四种组合 80–130ms**（此前"把整窗弄到屏幕上"是 355ms / 1444ms），且四条的 `shown` 全是 `not shown`；三条前提各自量过：停在**从未显示**的窗口里取不到（24ms 报 no surface）→ 停车窗**必须显示**；停在**屏幕外已显示**的窗口里取到自己的像素（38–89ms）；**交回隐藏窗口之后**又取不到（37ms）→ 截图必须在停车期间做。等一帧 **16ms 够**（0ms 不够），人的窗口 bounds 与层序不变，无焦点事件、应用焦点窗口不变。这一版把上一版的 `parkOffScreen`（挪窗口 + `setSkipTaskbar` + 位置还原 + `showInactive` 显示人的窗口）整段删掉了——那些都是为"显示整个窗口"服务的。**任务栏**：随之不再是问题（app 的窗口根本不显示）；停车窗在**创建时**就带 `skipTaskbar: true`（Electron 文档里的做法，一次可靠的对照读到 0 个按钮）；那个 UIA 探针后来不可靠（连明明显示在屏幕上的窗口都列不出条目，而别的应用条目在），所以这条以文档 API ＋ 那次读数 ＋ 焦点实测为据。**平台**：Windows 上隐藏窗口的"原地取图"完全不应答（量过：三种隐藏状态、三条路径全灭，连屏幕上那个标签页也一样），所以那一步直接跳过、直接停车；macOS 上 Electron 对隐藏窗口**是**能应答的（Electron 自己的行为，本机量不到），所以那边保留"先试一次"，停车只作兜底——见 `canCaptureHiddenWindows`。
- **作废：前台性不再"按需模拟"（用户报告"窗口从大变小 webcontent 能跟，从小变大就不跟"）**：本轮的数据里已经量到"被覆盖的标签页（默认节流）`hidden`"，但当时只核对了**截图**，没核对**几何**——而 `hidden` 的页面还有一个后果：**它不再遵守给它的 bounds**。窗口**变大**时视口停在旧尺寸，**变小仍然生效**，所以看上去像"只跟一个方向"。量法：`apps/electron/spike/resize-follow.cjs`（两次 40 步 ×8px 的 burst，模拟拖拽而不是跳变）——窗口 780 → 1420，被覆盖 + 节流的 page 停在 `innerWidth` 573 → **901**（期望 1213），整个放大过程收不到一个 `resize` 事件；同样被覆盖、**不节流**的两个方向都对（573 → 1213）。而"被盖住"正是除前台那一页之外**每一页的常态**，所以本轮"改法"里的 `syncTabThrottling` **删除**（第十三轮那条"`setSessionTab` = 游标 + 标签租约 + 锁 + 节流"里的节流一并去掉），`buildTab` 的标签页 view 一律 `backgroundThrottling: false`。代价回到本条开头那笔：后台标签页的 CPU 不再省（内存不变，见上表）。

**第十三轮（后台执行：命令作用于自己的标签页，窗口不动）**：

> 用户定的："能后台的尽可能后台，不要把用户当前正在用的标签页顶掉。"

- **第十二轮留下的那一小步做完**，但它比"去掉一次 `activateTab`"大：**"命令作用于哪个标签页"必须由调用方说出来**。原来窗口解析完只回一个 `instanceId`，动作层只能去读 `activeTabId`——那是**人在看的那个标签页**。现在 `resolveCommandTarget` 回 `{ instanceId, tabId }`，`IBrowserPaneManager` 每个标签级方法收尾参数 `tabId`，动作层**只认这个标签页**（`tabOf`：没给才是屏幕上那个标签页；给了一个不存在的标签页**报错**，不滑回别人的标签页）。
- **两条路都要传**：桌面端 `SessionManager` 直接持有**进程内**的真 manager（`index.ts` 的 `setBrowserPaneManager`），所以"在 `dispatchCapability` 里按 session 查游标"只覆盖远程桥。改法因此是统一的——**调用方指名标签页**：本地直接传参；远程把标签页放进 `BrowserCapabilityRequest.tabId`（与 `sessionId`/`workspaceId` 同族的**路由上下文**，不进 `args`），dispatcher 一行读出来。`commandTabIdFor` 那种"由 dispatcher 猜"的写法删掉：一个决定，一个地方。
- **`activateTab` 与新 `setSessionTab` 拆开**：前者只做"把它放到前面"（人切标签页、`tab-show`），后者只做"这个会话从这个标签页干活"（游标 + 标签租约 + 锁 + 节流）。第十轮把两件事塞进一个调用，是因为它们**总**同时发生；现在不总同时发生了。`--tab` 走后者（**不**动窗口），新增 `tab-show <id>` 走前者——这是唯一会移动人视图的命令，因为它就是这么说的。
- **`tab-new` / `open` 也开在后台**（`activate: false`）：开一个标签页给 agent 干活，不是把人从正在读的标签页上挪走的理由。标签栏照样列出来，`tab-show` 是"打开给人看"的说法。
- **连带修掉"按窗口读、其实是关于标签页"的一簇**（不做就会把补丁打错标签页）：
  - `apply-prototype` / `replay` / `verify-prototype` 原来读 `getInstanceAsync().currentUrl`——那是**屏幕上那个标签页**；现在由调用方传 `{ id, url }`（`resolveCommandTarget` 顺带取，或 RPC 侧取活动标签页），`resolveReplayPage` 变成纯函数。
  - **文件变化后的自动重放按标签页做**：窗口级 `prototypeSlug` 是"前台那个标签页的原型"，agent 在后台时它指错；REPLAY 现在逐窗口 `listTabsAsync` 找 `tab.prototype.slug === slug` 的**每个标签页**分别重放（顺带修掉"一个窗口两个标签页同一原型只重放一个"）。
  - **控制台/网络/下载按标签页归属**：`console-message` 曾写进 `activeTab().consoleLogs`（后台标签页的日志记到别人头上），网络与下载的 `getInstanceByWebContentsId` 只认活动标签页（后台标签页的请求直接丢）；现在都按**标签页**找（`findTabByWebContentsId`），下载更新句柄也绑在发起它的那个标签页上。
  - `snapshot` 的原型行、`currentPagePrototypeSlug` 读的都是"这个标签页"而不是"前台那个标签页"。
- **锁与遮罩的语义不变，含义更准**：锁仍拴在一个 tabId 上，而那个标签页现在是**agent 的标签页**（多半在后台），所以人自己的标签页**没有遮罩、没有盾**，可以继续用——"agent 和用户同时操作"由此成为默认行为而不是妥协。
- **`windows` 命令删掉**（用户定的："共窗 不需要 listWindows"）：一工作区一窗之后，"哪个窗口"不再是问题，agent 侧没有可列的窗口；标签级问题由 `tabs` 回答，窗口清单在顶栏。fns 的 `listWindows` **留着**但改性质——它不再是"给 agent 看的清单"，而是应用侧流程要读的**窗口状态**（`open` 等前台窗口变可见、`close`/`hide`/`focus` 报告前后差异），`windowIsAvailableTo` 随之删除。`focus`／`close`／`hide`／`release` 仍收可选的窗口 id（不给就是本工作区的窗口）。
- **未做/待量**：`hidden-after-show` 已量（见上一轮末尾：隐藏窗口的 `capturePage` 不应答，截图因此加了时间上限）；"agent 在后台干活时前台那个标签页仍显示 agent 外框+胶囊"是否合适——**下一轮定了，见下**。

**第十三轮修正（遮罩跟着被持有的标签页走；页面成为一块面板）**：

> 用户报告（用户原话："我切换到其他标签页，还在显示遮罩"）——上一轮记的那个待决项，答案取"干脆标到 agent 的标签页上"那一支。随后用户又提了两条外观要求（"网页区域改成4个圆角""底部、右边都留点边距……就是主聊天面板的圆角、边距风格。细线把网页框起来"），于是这一层多了一件事：它不再只是 agent 的标记，它是**页面这块面板的框**。

- **判据只有一个：`activeTab(instance).heldBy !== null`**，而它现在只决定**agent 的那部分**：accent 外框 + 光晕 + 胶囊 + `#shield`。此前这些是**窗口级指示**：只要这个窗口里有会话在跑，**前台那个标签页**就被画上外框、内发光和胶囊；于是人从 agent 的标签页切走之后，看到的是"我这一页正在被操作"，而胶囊报的还是**另一个标签页**正在做的事。
- **面板由页面自己画，锁由 overlay 画**（用户报告过一次回归："怎么网页内容都不能点击了？"）：第一版把 overlay 常驻在页面上方，于是页面**整块**被盖住 —— 视图按矩形吃输入（Electron 给 `setBorderRadius` 的注解：切掉的区域照样吃点击），盖住 = 点击与键盘都进不去。第二版按要求把页面换成 `WebContentsView` 并让它**自己切角**（`applyPageCornerRadius`），overlay 则常驻在页面**下面**：它只负责页面**周围**那一圈（留白表面 + 细线），页面上一分墨都没有，人照常点、照常打字。
- **agent 的那个框：外扩 1px + 压住页面边缘 1.5px**（用户："agent控制时的紫色边框 怎么变细了？圆角都没有完全挡住"，随后"能否同时外扩1px"）：锁定态原先和平时共用同一个元素、同一条 1px 位置（页面外侧 1px），于是既变细了、也盖不到页面自己的圆角边缘。现在分开：`#frame` = 平时的线（页面外侧 1px、1px 宽、颜色同地址栏输入框），`#lock` = agent 的框（**与 `#frame` 同一个盒子**：页面外侧 1px、半径 +1 因此圆弧与页面同心；边框 **2.5px** —— 外面 1px 填满那圈留白、让 accent 一直贴到 chrome，里面 1.5px 压住页面边缘），配 accent 实色 + 内侧光晕 + 那层变暗，两个按状态互斥显示。之所以能"压住页面边缘"：那一刻 overlay 本来就在页面**上方**（锁就是它），所以页面那个被 view 硬切出来的角能被盖掉（平时在外侧的细线盖不到）。
- **overlay 的上下位置 = 锁**：`locked || menuActive` 时抬到页面**上面**（那时才有 agent 的框、光晕、胶囊和吃输入的 `#shield`），其余时候在页面**下面**（页面把它的内部盖住，只露出那圈细线）。"这个窗口在被用"由窗口自己的 chrome 说：标签栏那把锁就在被持有的那一行上。
- **四角一律 10px**：`WebContentsView.setBorderRadius` 只有一个数，所以页面四角同半径，细线（`PAGE_PANEL_RING`）的外扩盒子也跟着它；应用自己的面板让最靠窗口的那个角紧一点（8/14px），而这块面板离每条窗口边都还有 6px，没有"窗口自己的角"可言。
- **角的形状只由页面那一份决定；overlay 不画角**（用户报告："在深色模式能看到比较明显的白边""四周的线有时候会残缺"，并给出触发条件"首次加载是好的，一旦跨屏幕拖动，就会有问题"；用户的判断"为了让网页能响应，圆角应该网页 webcontentview 来画吧"）：这个形状本来有**两份**——页面 view 的原生裁剪（按设上去那一刻所在显示器的度量建）和 overlay 里那条弧（CSS 像素、按常量算：此前是 `#mask` 的圆角缺口）。跨屏（缩放比不同）后两者错开，而错开**没有任何东西能补救**：页面在 overlay 上方，页面的像素谁也盖不住 —— 于是网页自己的白在角上显出来（深色下就是那圈白边），线的圆弧被它啃掉一块（"残缺"）。据此把 `#mask` 改成**方的**（只填页面矩形**之外**的表面，不带缺口），角于是只有页面那一份，颜色问题也随之消失（缺口那圈的颜色本来由窗口自己的背景兜着，同一个色值）。另加 `reassertPageCornerRadii`：半径**不是一次性的设置**，`moved`（拖完）与每次重新布局（含 `resize`）都重说一遍，因为原生裁剪不会跟着窗口换显示器重算。
- **页面那一层换成 `WebContentsView`，其余不动**：理由见 §12.1；`window-resize` 的承诺、`#shield`/菜单、截图都不受影响（截图取的是 `tabView.webContents` 自己的像素）。
- **贴着 chrome 的那两条边各留 1px**（用户报告："边框只有左右，上下看不到了"；随后定："左侧改为紧贴标签栏（留1px）"）：细线画在页面外侧 1px，而标签栏与地址栏都是压在上面的视图 —— 页面紧贴它们时，这两条线正好画在它们背后；现在页面左、上各留 1px 给线（`pagePanelInsets().left/top = 1`），右边与下边仍是 6px（那边没有 chrome 可贴）。**开窗位置不要动**（用户定）：中途曾按 `workArea` 夹尺寸并居中，判断依据是"窗口压在任务栏下"，事后用户确认底边其实一直在（只是太淡）—— 那不是病因，而且自己算位置会在小屏上把窗口顶部顶出屏幕，所以改回交给 Electron。
- **细线 = 地址栏输入框那条边**（用户："边框颜色太深了，和地址栏输入边框保持一致"）：地址栏那个输入框是 `border-foreground/5`（`BrowserControls.tsx`），所以页面的线也是**前景色 5% 的 1px 实色**（`PAGE_PANEL_RING`），面板与它旁边那个输入框同一个分量。走过的弯路记一下：6% 的 `shadow-middle` 环（太淡）→ 聚焦面板的 10%→30% 渐变（用户不要渐变）→ 实色 20%（太深）→ 现在 5%；并且全程用**真正的 CSS `border`**（真 border 的圆弧由浏览器抗锯齿，`::before` + `mask` 抠出来的 1px 圆环是锯齿的常见来源）。`#frame` 外扩 1px、半径 +1，让线的内缘正好贴着页面的圆角。
- **截图不再为遮罩挂起**：截图取的是 `tabView.webContents` 自己的像素，overlay 从来不在画面里（`suspendOverlayForCapture` / `restoreOverlayAfterCapture` 已删）；何况现在把它挂起会让人眼前的面板闪一下。
- **`window-resize` 的承诺跟着算上边距**：它承诺的是**页面**的视口，所以加窗口尺寸时把 6px 边距一起加进去，返回时再一起减掉（与 rail / bar 同一套算法）。
- **表面色只有一个来源**（用户报告："圆角外部边缘漏出了灰色底色，和垂直标签页、地址栏颜色不一致"）：遮罩填的那块表面 = 窗口/标签页底色 = `BACKGROUND_HEX`，而它现在**就是 renderer `index.css` 的 `--background`**（`:root` `#f7f8fa` / `.dark` `#080a10`，即 `DEFAULT_THEME` 的 oklch）。此前那两个 hex（`#faf9fb` / `#302f33`）来自 `themes/default.json` 一带的旧值，比窗口自己的 chrome 亮得多 —— 于是面板圆角外沿与留白在标签栏旁边显出一圈灰。同一组旧灰还抄在空状态文档与 chrome 加载失败的兜底页里，一并改到同一来源；细线的两个颜色（`PAGE_PANEL_RING`）也改成 renderer 的 `--foreground-rgb`（暗色是 237,236,240，不是 UI 包默认的 227,226,229）。
- **地面是窗口的，不是每个标签页一份的**（用户报告："每次新建标签页 边框都会消失一下"，并给出做法："webcontentview 实例化之前，应该要有个背景兜住"）：细线画在 overlay 的**文档**里，而 view 要有像素就得先**加载**文档 —— 此前这份文档是**每个标签页一份**：`buildTab` 里新建、`attachTab` 里 `void loadNativeOverlayPage(...)` 异步加载，而 `updateNativeOverlayState` 在 `nativeOverlayReady` 为假时把整块 overlay 设成 0×0（这个门是对的，不能拆：没加载完的 overlay 会白占标签区域、吃点击）。于是从"这个标签页成为前台"到"它的文档加载完 + 再跑一次 `executeJavaScript` 把颜色推给它"之间，线不存在 —— 露出来的是窗口自己的底色（同色），人看到的就是线闪一下。窗口自己的第一个标签页也走同一条路，只是那时窗口还没 `ready-to-show`，看不见。据此把 overlay 收成**窗口一份**：`createInstance` 里建（在任何页面视图之前）、加载一次（`loadNativeOverlay`，那条 `before-input-event` 监听也随之从每页一份变成一处）、页面视图照旧叠在它上面（`attachTab`），标签页关闭只带走页面（`detachTab`），`updateNativeOverlayState` 只摆它、不再遍历各页的 overlay 去清零。之后新标签页从出现的第一帧起线就在 —— 因为它不再依赖这个标签页加载任何东西。
- 验收：`browser-pane-manager.test.ts` 的「rounds the page itself, so any page is a rounded panel the person can click」（页面自己的角 + overlay 在它下面）、「draws the panel without a lock while no tab is held」「arms the tab shield only while the tab on screen is the one being worked on」、两条 viewport 用例（493x445 那条同时钉住四边边距）、关标签页那两条（页面走 `contentView` 出去、overlay 留在窗口里）；`shared/__tests__/browser-live-fx.test.ts` 钉住四个角的半径与细线的两个颜色。

**第十四轮（标签栏的分组怎么读：段落顺序、段内缩进、段头的 `+`）**：

> 用户看窗口提的一串读法问题（起于"浏览器窗口标签栏太粗糙了，UI交互细节优化下"，随后依次："分组效果不是很明显，组内应该缩进"、"组名右侧增加 +号……新建标签页添加到组内最后一个，归属agent。方便用户帮agent提前操作页面"、"如果是agent创建的标签页，只有一个要显示分组"、"分组不要用机器人icon，换成对话消息的icon"、"行内的去掉"、"用户创建的固定排在agent分组的前面"、"关闭标签页的接替优先组内接替"）。这一轮**只改"分组怎么读"，加一个交接口径**：视图的组仍然是视图的组——第八轮那句"不是归属的组"（没有组 id、没有组级租约、没有新的拒绝路径）一个字没动，权限、锁、租约也没动。

- **人的那一段固定在最前**（取代第八轮"段落在它第一个标签页的位置"，只对这一段）：窗口先读作"我在看什么"，再读作"别人在里面干什么"，这两者的先后不该由标签页被打开的顺序决定。其余段仍在它们第一个标签页的位置，段内相对顺序不变——所以"位置说谎"这件事只发生在被钉住的那一段上，而它说的正是"这是你的窗口"。
- **段头只对"你"那一组不画**（取代第八轮"只有一个组时不画段头"）：段头有两个用处——说明这些标签页是谁的、放那一组的 `+`——它们在"只有一份**活**的段"上全都成立（那一份活的名字行上根本没有），而在"只有你自己的标签页"上两个都不成立。`shouldShowGroupHeaders`：多段为真；单段时看那段有没有 `work`。
- **段内缩进 + 一条竖引导线**：段名在 14px，段内标签页退到 26px，中间 10px 处一条 1px 的线从段头下沿贯到本段末尾。换个灰度的组名不足以读成"从属"（要已经知道才读得出来），缩进和线是不用读的两个提示。段头也因此统一成 32px（有没有 `+` 都一样）——只在有按钮的那段长高，会读成两类段。段头粘顶不变；线画在段头之前，所以粘顶时被段头的不透明底盖住。
- **段头右侧的 `+`：为「这一份活」新建标签页**（用户："方便用户帮agent提前操作页面"）。走工具栏自己的标签通道（`tabAction('new', undefined, work)`，通道多带一个 work），主进程 `createTab({ belongsTo: work, openedByPerson: true })`：
  - **落在该段的最后一行**：标签页照旧追加在窗口列表末尾，而分段把属于同一份活的标签页收拢到"它第一个标签页的位置"，所以追加的这一个自然成了本段最后一个；
  - **归属该段**（`belongsTo` 原样带上，对话或任务都行），并成为该对话的**游标**——"我把页面摆好了，你接着干"就是这条；
  - **不拿租约**：`driverSessionId` 是"最后被谁动过"，而这次动它的是人；照搬 `createTab` 原来的口气（"谁开的谁就在干"）会让 rail 立刻在一个 agent 从没碰过的标签页上点亮"有 agent 正在使用"那个点。`assignTab`（把标签页交给一个对话）本来就是这个口径：belongsTo + 游标，不碰租约。所以 `createTab` 多一个 `openedByPerson`，租约与游标的写入也在那里分成了两半（`pointConversationAt` 只写游标）。
  - 文案两条：`browser.newTabForConversation` / `browser.newTabForTask`——对话段与任务段各叫各的名字，比"在这个分组新建标签页"像人话。
- **段头图标换成 `MessageSquare`，行上的 Bot 图标删掉**：段是一条**对话**的活，"机器人"标的是实现而不是读法（用户："分组不要用机器人icon"）。行上那个（第八轮加的、条件为"没有段头"）在这条规则下已经不可能出现，连条件一起删。两处一起改（rail 与徽章里的标签页列表），因为它们画的是同一个段头。
- **关闭标签页时，接替优先在本段内**（`successorOf`）：先找"位置在它之后、同段"的那个，再找"在它之前、同段"的那个，本段空了才退回按位置取邻居（也就是窗口原来的行为）。判据是"它在屏幕上的位置"——人关掉一个为某对话摆好的页面，想看的是那个对话的下一页，不是窗口列表里挨着它的、可能属于别人的那一个。原来那句注释写"接替的是前一个（浏览器也是这么做的）"和代码实际行为（后一个优先）相反，一并改成描述真实行为。
- **"哪一段"提到 protocol，只有一处定义**（`tabSectionOf(work)`：`person` / `session:<id>` / `task:<slug>`）：rail 与徽章画段读它，主进程决定接替也读它。不这么放，主进程就得再写一遍"按会话/任务分段"，而"画出来的段"与"交接用的段"一旦不一致，表现是"接替跳到了别的分组"这种很难查的错。**它比 `sameWork` 粗**（同一个任务的不同节点、不同 run 算同一段），所以**不是权限判据**：reach 仍然只认 `sameWork`——这一点写在 `dto.ts` 的注释里，谁把它当 reach 用，就是把一个节点的标签页交给了另一个。
- 验收：`tab-groups.test.ts`（人的段钉在最前、其余段按首次出现、"只有一份活的段也画段头"、任务节点不拆段）；`browser-pane-manager.test.ts` 的「hands over inside the closed tab's own section, not across sections」「hands a section over to the tab before it when nothing of that work is left after」。

**第十五轮（一个被否掉的约束：一页一实例，以及取而代之的两条小规矩）**：

> 起于三个追问："是否保证同一个原型页面同一时间只存在一个实例、禁止多实例，作为底层约束"、"用户真在地址栏输入，或 agent 调用 browser tool 打开怎么兜住"、"agent 误以为开了同一页结果是不同页，是否不可接受"。**这一轮走完了算账，结论是：不采纳这条约束，改做两条小规矩。** 过程与理由留在下面，免得它被后来人当既定设计再捡起来。

**为什么不采纳**——四条动机逐条重审：

- **"当前页歧义"不成立**：同一页的两个视图说的还是同一页；§23 的摆放是同一个实例换父容器，更不产生歧义。
- **锚点记录被多写 → 假失效，成立，但那是"多个写入者"的问题**：`observed` 的唯一写入点在 `apply-prototype.ts`，而 `matched` 是"**在那个视图的 DOM 里**匹配到几处"；按页遍历的自动重放会对每个展示着这一页的视图各写一次，被操作过的那份（SPA 内跳转、关掉弹窗、填了表单）报 `matched: 0`，把正确记录覆盖掉。这是 §21.2 抓页面漂移的信号，假阳性会让人去改本来没坏的补丁。**收口成单写入者就能解决，不需要禁止多实例。**
- **两份活状态漂移，成立，但后果是困惑，不是损坏。**
- **而"复用已有视图"会新引入一类更严重的错**：复用 = 放弃重新加载，于是请求方拿到的可能是**过期的环境**（页地址改过之后）、**在 SPA 内部已经漂到 `cart/confirm` 的同一格**、甚至**已被导航到别处的一格**。这与下面那条回执是同一条线的两端。

**"agent 误以为开了同一页、结果却是不同页"确实不可接受**——它污染的是判断本身（拾取的元素、`@target`、改对没改对的结论，全都建立在"我在 X 上"这个前提上）。**但它今天已经在被正确处理，而且药方与实例数无关**：`open` 的回执在请求地址与实际落地地址不一致时报 `landed on: <实际地址>`，注释写明"读窗口现在到底在哪，而不是把请求当成结果——活页的地址来自文档本身，永远不来自原型的 config"。开新格也会遇到重定向与 SPA 漂移，所以这条规矩对"开新"与"复用"同样必要；而**复用会放大它**。

**取而代之的两条小规矩**（各自独立生效，成本都只在一处）：

1. **记录单写入者**：`anchors/<页名>.json` 的 `observed` 只由**该页的工作视图**写（会话游标指着的那个），其余活着的视图不写。→ 假失效消失。
2. **回执一律以实际地址为准**：所有"我打开了这一页／我现在在这一页"的说法都取自文档本身。`open` 已经如此；把它写成规则，扩到 `browser_tool` 的打开与导航、以及"当前页"（§19.6）的判定。

**去重降级为可选优化，且带前置条件**：只有确实想省掉"长会话攒同页标签"时才做，且命中格的**当前地址**必须等于该页**当前解析出的地址**才允许复用，否则照旧新开——不满足前提就复用，正是上面那类误解。收益是少几格标签、少几份内存与登录态；不做不影响正确性。

**复活条件**：出现"同页多份活状态被人反复困惑"或"同页多视图造成的错误被实际观测到"的证据时，再把硬约束捡起来。配套的观察点：把"同一个页有几个活视图、分别属于谁"记成可观测的事实（状态报告一行或日志），让那个证据有地方来。

**§23 的摆放与这条约束无关**：面板里的预览是**搬**（同一实例换父容器），因此它天然不产生第二份活页——它不需要"禁止多实例"这条约束。

- 验收（实现时钉在 `apply-prototype.test.ts` 与 `browser-tools.test.ts`）：重放时只有工作视图写 `observed`（另开一份、被操作过、报 `matched: 0`，不影响记录）；`open` 在重定向／SPA 漂移时的回执报 `landed on:`（已有用例，保留并作为规则）。

**第十六轮（键盘跟着屏幕走：焦点归给屏幕上的标签页，且绝不抢窗口前台）**：

> 起于三问："焦点应该在前台标签页上，最新挂上 widget 持有焦点是 electron 行为吗？量一下最新创建后台页面不给焦点是否可行，有什么影响"；"为什么没有给用户激活的 tab 设焦点？怎么解决？切换 tab 再切回来，应该聚焦原来的地方，这是浏览器标准行为"；"先解释：用户来回切换 tab，能否交还焦点"。**全程先量后答**，读数在 `spike/screenshot-e2e.ts` 的 phase 8 / 10。

**成因（量出来的，不是推的）**：

- **不是"挂载即聚焦"**：裸 `WebContentsView` 创建时、挂进窗口后、把那个窗口 `focus()` 成前台再挂第二支——三处 `isFocused()` 全是 `false`。
- **是页面 commit 时给的**：同一个窗口里，第一支 view **加载完**就有焦点；第二支挂上时焦点还在第一支；第二支**加载完**焦点才过去。所以"最新挂上的 view 持有焦点"的准确说法是"最新**导航**的那个 view 持有它"，而 agent 的标签页恰好永远是最新的那个（`activate: false` 拦不住）。
- **窗口不在前台时谁也不给**：窗口被另一个窗口压住时新建标签页，新的、屏幕上那个、之前的，三个 view **全是 `false`**。

**修复前**（光标放在屏幕上那个标签页的输入框里）：agent 在后台开一个标签页 → 屏幕上那个标签页 `document.hasFocus() === false`、**输入框收到 `blur`**（页面自报 "the cursor left the field"）；切到 agent 的标签页再**切回来** → 依旧是 `false`，键盘留在已经不在屏幕上的那个标签页上；**关掉屏幕上那个标签页** → 没有任何交接。原因是全库没有一处向标签页要过焦点：`activateTab` 只改 `activeTabId`、重排 view、推状态。

**改法（一处机制，三个调用点）**：新增 `focusTheTabOnScreen(instance, tab)`，把键盘交给指定标签页，两条守门：

- **只在人正在用的那个窗口里**：`webContents.focus()` 会把窗口**拉到前台**（量过：另一个窗口在前时，调用后 `getFocusedWindow()` 从 `OTHER-WINDOW` 变成 `Electron`），所以窗口不聚焦就直接返回——agent 在后台干活绝不能把窗口翻到人面前。三个调用点都过这道门：`activateTab`（放在"已经是当前标签页"那个提前返回**之前**，所以人再点一次自己那个标签页也能把键盘要回来）、标签页的 `did-navigate`（页面 commit 正是 Chromium 移焦点的时刻）、`closeTab`（`activeTabId` 全库只有两处直接赋值，这是另一处"显示动了、键盘没跟"）。
- **只从"另一个标签页"手里拿回**（`did-navigate` 那处）：地址栏与 rail 是人在打字的地方，后台页面 commit 不该把它们抢走。

**实测（修复后，同一场景）**：

| 动作 | 屏幕上 / 用户的标签页 | 另一个标签页 |
| --- | --- | --- |
| agent 在后台开标签页 | `hasFocus`/`isFocused` 都 `true`，光标仍在输入框里（**连 blur 都没发生**） | 都 `false` |
| 切到 agent 的标签页 | `false`（走的时候正常 blur） | 都 `true` |
| **切回来** | **都 `true`，`activeElement` 仍是那个输入框，页面自报光标回到框里** | `false` |
| **关掉屏幕上那个标签页** | — | **接手的标签页都 `true`** |

全程 `getFocusedWindow()` 始终是 `Electron`（没有把窗口带到前台）。

**为什么切回来能回到原处**：每个标签页的文档一直记着自己聚焦的元素（修复前的读数里 `activeElement` 始终是那个输入框，只是文档不是聚焦态），缺的只是"向屏幕上这个标签页要键盘"这一步；一给，Chromium 就把光标还给那个元素，页面的 `blur`/`focus` 也就和真浏览器一样成对。

**未量到**：键盘的实际路由。`before-input-event` 探针两次都是 0 命中（窗口自身 / toolbar / rail / 两个标签页全为 0），所以"持有或丢掉这个焦点，打字究竟去哪儿"仍是空白——上面写的都只是 `document.hasFocus()` / `document.activeElement` / `webContents.isFocused()` 三个读数。

**修正（第十七轮之后由用户实测发现）**：交给键盘这一句**必须排在把 view 搬进窗口之后**。标签页上屏要把它的 view 从停车窗搬回 app 窗口（第十七轮），而**搬动本身会丢掉键盘**——A/B 实测（`background-viewport.ts` F 段）：先把键盘给那支 view、再把它搬进窗口 → 两个 view 都 `hasFocus: false`（谁都没有）；先搬、再给 → `hasFocus: true`。原写法把 `focusTheTabOnScreen` 放在 `layoutAllViews` **之前**，用户的现象正是"从标签栏切回来，焦点没还给网页"。现在 `activateTab`（两条路径）与 `closeTab` 的接替分支都在布局之后才交给键盘；spike 的 phase 10 把"后台开标签页不抢键盘"与"切回来必须还回来"从报告改成**断言**，防止再退化。

- 验收：`browser-pane-manager.test.ts` 的「keeps the keyboard on the tab on screen when a page loads in a tab behind it」「leaves the address bar alone when a page loads in a tab behind the person」「gives the keyboard to the tab that comes forward, and never moves the window for it」「hands the keyboard to the tab that takes over when the tab on screen closes」；同一场景的真 Electron 读数在 `spike/screenshot-e2e.ts` phase 8 / 10，那里原有的四种截图组合仍然是 `SPIKE_OK`。

**第十七轮（后台标签页住在离屏停车窗：窗口 resize 只碰屏幕上那个）**：

> 起于一问："后台标签不改变大小（住在窗口不可见区域），到前台才改变大小，避免后台自动化被改变大小样式变化，是否合理"。**先量后改**（探针 `apps/electron/spike/background-viewport.ts`，离屏与真屏各跑一遍，读数一致），中途走过两条弯路，都由读数否掉，一并记下。

**量出来的**：

- **原语**：窗口 900×620 → 1400×900，只给屏幕上那支 `setBounds` —— 屏幕上那支 `innerWidth` 900→1400、1 次 resize（8ms 后到）；**被留在原处那支 `innerWidth` 不变、`resizes: 0`**。所以"不调 `setBounds`"本身就是冻结，不需要 CDP override。
- **坐标**：冻结页（视口 900×620）放在 1400×900 的窗口里，按**页面自己报的**坐标发 CDP 点击**命中**；视口之外 `elementFromPoint` 为 `null`、点了没有反应。CDP 用的是页面坐标系。
- **切回前台**：`setBounds` 之后立刻读，`innerWidth` 已经是新尺寸（页面还没跑 resize 事件），事件 8–9ms（真屏）／27ms（离屏）后到。"人会不会看到一帧旧尺寸"**没量到**（要逐帧证据）。
- **弯路一：把 view 移到窗口外（负坐标／"窗口不可见区域"）不行**。一个**出生就在窗口外**的 view：`innerWidth` **0**、`hidden`、0 帧、截图回来 `0×0`、CDP 点击**落空** —— Chromium 的视口是"view 与窗口的可见交集"，窗口外就是空，等于第十二轮否掉的 0×0 停放。注意这与"**先在窗口内被合成过、再移出去**"是**两个状态**：后者仍有 surface、`innerWidth` 不变、还能原地截图（这一条我先测错了状态，被用户纠正）。
- **弯路二：窗口缩到比冻结视口还小时，"被盖住"也不成立**。屏幕上那个 700×500，后台那个 1200×900 —— **右边探出 500px、下边 400px**，人能看见别人的页面。

**改法**（规则一句话：**标签页的视口 = 它最后一次在前台时的视口；不在屏幕上的标签页根本不在那扇窗口里**）：

- `parkingWindowFor`：每个浏览器窗口一扇**常驻停车窗** —— 所有显示器之外、`showInactive()`（**必须被显示**：没被显示的窗口里的 view 没有视口，就是弯路一）、`skipTaskbar: true`、随 app 窗口一起销毁；不够大时 `setContentSize` 长（窗口会裁剪子 view）。
- `attachTab`：不在屏幕上的标签页**出生就在停车窗**里，尺寸取当时的 page area（"首次就在后台创建时，就在停车窗创建"）；屏幕上那个进 app 窗口。
- `layoutTabView`：只给屏幕上那个 `setBounds`；其余 `parkTab`（停车窗里 `(0,0)` + 自己的尺寸；只重述同样的数字，不重排）。
- `captureWhileParked` 交回：屏幕上那个回 app 窗口，其余回停车窗。
- `detachTab` 从两扇窗都摘；`finalizeDestroyedInstance` 销毁停车窗。

**实测（真 Electron，`screenshot-e2e.ts` phase 11）**：停车窗 `isVisible: true`、`isFocused: false`、在所有显示器之外、持有那个后台标签页，而**人的窗口不持有**它；人的窗口 993→1200 时后台那个仍是 993×845、**0 次 resize**；它的截图 **993×845**、像素是它自己的、**原地取到**（`parked: false`，90ms）；**切到前台才** 1200×900、1 次 resize；再把人窗口缩到 700×500，后台那个**仍是 1200×900、0 变化**，且仍在停车窗里（露不出来）。

**修正（用户实测）**："你的停车窗太靠近屏幕了，用户切换双屏幕/调整 dpi 就露出来了。" 原来那个点只是"所有显示器的右边缘 + **400** DIPs"，一个拖动的窗口的距离——第二块屏一插就在它上面。两条改动：

1. **放得远**：`OFFSCREEN_PARK_MARGIN = 20_000`（原 400）。但**桌面会钳**：要 20 000 / 100 000 / 1 000 000，实测都回到 **16 383**（DIPs）；而那么远处的 view 视口照旧（`innerWidth: 900`）、截图照旧（`background-viewport.ts` section G）。所以这只是一个**请求**。
2. **关系要有人守着**（真正的保证）："不在任何显示器上"是**关系**——显示器会变，桌面还会"好心"把判定成够不着的窗口搬回屏幕。`keepOffEveryDisplay` 因此在三种时刻核对窗口**实际** bounds（创建之后、窗口的 `move`/`resize`、以及 `screen` 的 `display-added`/`display-removed`/`display-metrics-changed`），一旦与任一显示器相交就挪回去；挪不动的记进 `parkingStuck` 不再反复试（否则每个 `move` 事件来回弹）。实测（phase 11）：停车窗落在 **(16383,0)**；把它按桌面的方式挪到 (0,0) 之后，**600ms 内自己回到 (16383,0)**、`backOffEveryDisplay: true`、里面那个标签页的视口仍是 993、内容仍在。
3. 单测：测试替身里的 `screen` 现在**真的派发**显示器事件——"插一块把停车点盖住的屏"→ 它挪开；"把窗口挪到 (0,0)"→ 它挪回去；`destroyAll()` 退订。

**一个连带的好处**：停车窗是显示着的，后台标签页因此**有 surface**，截图不必再挪一次 —— phase 1 的 "behind it" 那行从 `parked: true` 变成 `parked: false`（69ms）。`captureWhileParked` 仍是隐藏窗口与"从没被合成过的 view"的路径（phase 1c 三行照旧：未被显示的窗口没有 surface、显示过的有、交回未显示窗口后又没有）。

**修正第十二轮的一处旧读数**：那句"被覆盖的标签页 = `hidden` / 0 帧"既不是这条规则的依据、也靠不住 —— 窗口一变大，被盖住的 view 就会变成 `visible`/约 24 帧每 500ms（离屏与真屏一致）。现在后台标签页在停车窗里**就是被合成、跑帧、`document.hidden === false`** 的，这是明摆着的代价。

**代价（说清的）**：每个浏览器窗口多一扇离屏窗口（第十二轮量过"一个标签页一原生窗口"约 +3MB/标签页，窗口本身很便宜）；后台标签页会被合成、跑帧（CPU 不再省）；切回前台必然重排一次（浏览器同样如此）；**后台标签页的截图是它自己的视口尺寸**，而 `window-resize` 的数字只描述屏幕上那个标签页。

**没采用**：`Emulation.setDeviceMetricsOverride`（量到 override 期间窗口 resize 不产生 `innerWidth` 变化）—— 几何自身就是开关，不必再加一层页面级状态。

- 验收：`browser-pane-manager.test.ts` 的「keeps a tab that is not on screen out of the window, at the size it was opened at」（停车窗持有、人的窗口不持有、resize 不碰它、切到前台才给窗口尺寸）、「keeps a background tab's navigation on itself」、「shoots a tab that has never been composited…」（交回停车窗）；真 Electron 读数在 `spike/screenshot-e2e.ts` phase 11 与 `spike/background-viewport.ts`（E1/E2 两个状态分开量）。

**下一轮**：**面板按会话分组**：徽章那一列现在按窗口分组，但没有说"哪个会话在用这个窗口"。

---

## 23. 原型面板：这一份活随手可见

> **状态**：**设计已定，尚未实现**。本节只定形状与规矩；落点（改了哪些文件、每处改什么）在实现时写进 [开发文档](prototype-workbench-dev.md) §1／§2。
>
> **落点改过一次**：本节原本要把内容挂在**对话右侧栏**（`RightSidebarPanel` 那条槽位）上。用户分析后指出——**"原型与对话并排"是既有能力**（`newPanel`），不必新造侧栏去影响布局。于是保留全部内容规格，只换承载面：**一份轻量面板（route）**。右侧栏方案记在 §23.6。

> **名词**：本节说的**原型面板**，是和对话**并排的第二个面板**（`navigate(route, { newPanel: true })`）。它与 §19.9 说的"侧栏"（左侧导航栏，原型列表）不是同一个东西——两者回答的是两句话，见 §23.2。

**问题**（用户原话："作为 agent 产品需求工作台，对话面板与原型的联动太弱了，应该能快速查看原型的页面、文档等。右侧是否可以推出面板？"）：

从对话够到原型今天只有一条路：标题栏的烧瓶菜单（`PrototypeBindingMenu`）。它做两件事——显示／切换绑定，以及「打开面板」，而后者是 `navigate(routes.view.prototypes(slug))`：**把对话本身换掉**（`NavigationContext` 的非 `newPanel` 分支落到 `updateFocusedPanelRouteAtom`）。于是"继续对话"与"看原型"在同一段时间里互斥，而这一份活的事实——有哪些页、每页改了哪些、锚点有没有失配、交付物齐没齐——在对话里一个都看不到。

**结论：可以，而且不是新机制——并排面板的骨架早就在仓库里。** 它同时是两件事的落点：**在对话旁边读得到这一份活**，以及**把这一条交给对话**（预填输入框，不跳转）。

### 23.1 骨架早就在仓库里

| 层 | 现状 |
|---|---|
| 面板栈 | `sessionMenu.openInNewPanel`（"在新面板中打开"）与 `handleNewChat(true)` 都走 `navigate(route, { newPanel: true, targetLaneId: 'main' })`（`AppShell`）；`PanelStackContainer` 的 `visiblePanels` **宽窗口并排**，窄窗口自动退化成下钻（既有行为，就是 §23.4 说的那次退化） |
| 路由 | 任何 view route 都能进面板 → 需要的是一个**轻量面板 route**（内容见 §23.2／§23.5，它是详情页的一个子集，不是详情页本身） |
| 状态 | 面板栈在导航状态与 URL 里 → 刷新、前进后退都能还原（比栏那条"它不是本机偏好"的解释更自然） |
| 内容件 | 三段组件放 `components/prototypes/`，页索引那一行与详情页**共用**（§23.5） |

要补的有三件：一个轻量面板 route、一个面板组件、对话头的一个入口（"在并排面板里打开这个原型"）。**预览的摆放**（`placement` + bounds 同步，§23.3）是可选第二步，且与承载面无关。

### 23.2 面板里是什么：索引、预览与入口，不是第二个详情页（与 §19.9 的关系）

§19.9 撤掉了"左侧栏里页的两级下钻"，理由是**页的载体不是侧栏**：同一页的事实一旦两处并存必然漂移，而侧栏是唯一显示不了活状态的那一份。那条决定**没有被推翻**，本节要说清它为什么不适用于并排的原型面板：

- **回答的问题不同。** 左侧导航栏回答"我在哪个原型上"——它是工作区的原型清单，与任何一个对话无关；原型面板回答"这一份活现在是什么样"，它只在**一份活旁边**出现。没有它，人只能在"继续对话"与"看原型"之间二选一，而这正是今天烧瓶菜单的形态。
- **面板里只读、只索引、只做出口与入口。** 页表序、入口、改名、删页、设入口仍然只有详情页「页面」区块那一份；面板不提供任何页级动作，因此不产生第二个写者。"入口"指把一条提醒放进对话的输入框（§23.4），不是写原型。
- **面板读的是同一份报告。** 每一项都派生自 `listPrototypes` 的那份 `PrototypeStatus`（`prototypesAtom`），不是第二份存储、也不是第二次扫描。
- **面板能显示活状态，但那只是"同一页的另一种摆放"。** 页面本体是主窗口内嵌的一个 `WebContentsView`（§23.3 的 `placement`），面板里点一页就是把那个 view 指向那一页——它不自己渲染页面，所以 §19.9 说的"承诺一个并不存在的落点"在这里不成立：落点存在，只是换了父容器。§19.9 那条仍然管用的是它的推论——**任何页面视图只能有一套实现**。
- **共用的是实现，不是位置。** §19.9 反对的不是"同一份读出现在两处"，而是"两处各自实现"——漂移从第二份实现开始，不从第二个位置开始。所以面板里凡是详情页也画的东西，必须**共用同一个渲染件**（典型是页索引那一行）；凡是不该有第二份清单的东西（补丁清单、锚点全集），面板就不画清单，只回答"欠什么"。这条是 §23.5 的总规矩。
- **不是"把详情页放进并排面板"**（`navigate(routes.view.prototypes(slug), { newPanel: true })` 今天就能做到）：那是**内容**问题，不是布局问题——详情页是"读报告 + 改流程"的整页，压到半屏会让页索引横向滚动、门禁条目折成三行。所以面板要的是**为并排设计的一个子集**：三段、可扫完、下面这些出口。

由此得到面板的定位：**索引 + 出口 + 入口 + 提醒**（预览是可选第二步）。它在对话旁边回答"这一份活有什么、改到哪了、欠什么"；要动手改，**把这一条放进输入框**（不跳转、不自动发送）；要看具体那一屏，出口是工作区浏览器窗口（§23.3）。

### 23.3 装得了什么、装不了什么

**装得了活页面——但只有一种装法：给它换父容器，不是另造一套页面视图。**

主窗口本来就是 `BrowserWindow`，而 pane manager 已经在用同一句 `contentView.addChildView(tabView)`——所以"页面嵌进主窗口"是通的。做法是给 pane instance 加一个 `placement`：

| placement | tabView 的父容器 | chrome | 什么时候用 |
|---|---|---|---|
| `window`（今天） | 那个实例自己的窗口 | 窗口里的标签栏与工具栏 | 多页对照、全屏看、把页面挪到另一块屏 |
| `panel`（本节新增） | 主窗口 | **不建**——面板自己的 DOM 就是它的 chrome | 在对话旁边随手看/改当前页 |

两种摆放是**同一个实例、同一套身份与注入**：补丁、元素拾取、"当前页"标记都挂在 instance 上，不挂在窗口上。所以面板里显示某页是**搬**，不是复制——它不产生第二份活页，靠的是"搬"这个动作本身（§22 第十五轮否掉"一页一实例"那条硬约束之后，这一侧正好不需要它）。"关掉面板"因此是一个纯摆放问题：view 归还给独立窗口（或按需要销毁），不留孤儿 view。

**它比右侧栏更难当宿主**（这决定了预览的先后）：右侧栏是固定宽度的一栏，面板却可以被拖动、被改变宽度、被新面板挤走——**bounds 的触发点更多**。所以先把三段（纯 DOM）做出来，预览留作第二步。

**三条不做，理由各不相同**（免得以后按"应该能做到吧"去试）：

- **不用 `<iframe>`**：它显示的是**未打补丁的原页面**。补丁是主进程用 CDP 挂在窗口那个 webContents 上的（`browser-cdp.ts`），iframe 里的第三方帧注入不进去；真实站点还多半发 `X-Frame-Options`/CSP 拒嵌。唯一能让 iframe 显示补丁的走法是 host 反向代理 + 服务端注入——丢登录态、要重写绝对 URL，那是另一个产品。
- **不用 `<webview>`**：要打开主窗口的 `webviewTag`（现在是 `false`，注释本来就写着"用 WebContentsView 不用 webview"），注入还得另开一条 `webContents.fromId` 的路；Electron 官方也不推荐它。
- **不用截图当终点**：能看不能点，而这一层的核心动作是"选元素 + 说话"；它还要新增一条 renderer 侧截图 RPC（现在的 `SNAPSHOT`/`SCREENSHOT` 是 agent 侧的）。当"内嵌之前的过渡"可以，记在 §23.6。

**内嵌的代价写在前面**（真正的成本不在那几句 `addChildView`）：

1. **原生 view 浮在 DOM 之上**：预览那块矩形上方不能有弹出层——菜单、popover、toast 都会被它盖住。所以面板里"交给它"这类交互要避开预览矩形，且不能指望用浮层盖在预览上。
2. **bounds 要跟布局同步**：面板宽、面板栈、窗口缩放、compact 切换，都要在渲染侧量出矩形回传主进程重设。
3. **pane manager 里凡以 `instance.window` 为前提的地方都要按 placement 分叉**：chrome 的定位与显隐、拾取用的 overlay、聚焦/交互信号、标签段与徽章的摆放。这是本次改动的大头——也是"placement 只加一个维度，不复制一套流程"的原因。

**装得了的索引**（一屏三段，全部来自已有的状态报告，数据侧**零新 IPC**；每段非空才出现）：

| 段 | 内容与事实来源（`PrototypeStatus`） |
|---|---|
| 页 | `pages`（表序即流程序）、`entryPage`，并把**预览/窗口正停着的那一页**标出来（`browserInstancesAtom` 里该实例的 `tab.prototypePage`——按会话所属工作区过滤，`filterInstancesForWorkspace`；§22 的徽章与接替读的是同一处）；`pageIssues`（声明了但文档没了、`patches/<页名>/` 没对上）。点一行 = 预览切到那一页（第二步之后），行上的「在窗口里打开」是出口 |
| 欠什么 | `unresolved`（没人实现的需求、仍站着的异议、上一轮的红）——与详情页「交付」按钮点开的那张卡**同一份 notices**（`code + params + text`）：面板显示读者的话，交给对话时给 `text`；再加上失配的选择器（锚点记录 `matched` 为 0 的那些）。点一条 = 交给对话（§23.4） |
| 交付物 | `distFiles`；PRD 文档本身用已有的 `onOpenFile` 在应用内打开 |

**不做 tab**：tab 每次切都要藏起三分之二的事实，而这一段面板的全部价值是"不用点"。事实多到一屏放不下时，先加成段（可折叠）——tab 回答的是"我要找某一类"，这里要的是"一眼扫完"。真要 tab 化，tab 上必须带计数（`页 3 · 欠 2`），否则"有东西在等我"看不见。

**本会话产物不在这里**：它不是原型的事实，而且已经有家（`SessionFilesSection` 由会话信息 popover 用着）——搬进来就是第二个家。

### 23.4 接法

- **路由**：新增一个轻量 route（`prototypes/prototype/<slug>/panel`，名字实现时可调）——它是**详情页的子集**，不是详情页的别名（§23.2 最后一条）。打开走现成的并排：`navigate(route, { newPanel: true, targetLaneId: 'main' })`。
- **面板体**：新组件放 `components/prototypes/`，三段 + 入口；**不要**套用详情页的整页排版（它要能在一半宽度里读完）。
- **入口**：对话标题栏烧瓶菜单（`PrototypeBindingMenu`）里加一项「在并排面板里打开这个原型」；**菜单的图标上带状态点**（还差 N 件 = 琥珀点带数字，可以交 = 绿点，判据与详情页页头、左侧栏状态点同一套）——"欠着什么"不该需要打开面板才知道。
- **提醒交给谁**（面板不像栏那样天生知道"我是谁的栏"）：优先**相邻的对话面板**（面板栈里挨着的那个会话 route）；没有，就用 `sessionMetaMap` 里绑定了这个原型的那个对话；都没有 → 不显示「交给它」。预填规则不变：**追加**进草稿、不覆盖已经写好的字、不自动发送；交给 agent 的是 notice 的 `text`（与 `status` 打印的同一句），面板里显示的是翻译（`notices.ts` 的两面）。
- **不跟随焦点**：面板固定在一个原型上，切焦点不改变它的内容。这正是它与"右侧栏"的关键差别——面板是"我摆在那儿的固定参照"，栏是"跟着你跑的"；§23.1 里那句"跟随焦点会话"因此整条取消。
- **关闭与降级**：关闭用现成的面板关闭动作（面板自己就是开关，不需要额外的 toggle）；窄窗口（`isAutoCompact`）自动退化成下钻（既有行为）——那时它就是"把对话换掉"，可接受，**不为此加特例**。
- **状态要各说各的**：这个原型在 `prototypesAtom` 里已经找不到（被删了）→ 面板说"这个原型不在了"，给关闭与解绑的出口，而不是空态。
- **不做本机偏好**：打开与否就是面板栈的状态（在导航状态与 URL 里），刷新、前进后退都能还原——比栏那条"它不是本机偏好"的解释更自然。
- **预览（第二步）**：view 由 pane manager 创建，`placement: 'panel'` 决定它挂在主窗口（§23.3）；**渲染层不许另造第二套页面视图**（iframe／`<webview>` 都不行）。bounds 由渲染侧量出后回传主进程（`ResizeObserver` → `setBounds`）——面板可拖动、可改宽，触发点比固定宽度的栏多。面板里的浮层不得压在预览矩形上（原生 view 在 DOM 之上）。关面板时 view 归还给独立窗口（或按需要销毁），不留孤儿 view。

### 23.5 一处必须共用，否则就是 §19.9 说过的那个形状

规矩写成一句（§23.2 最后一条）：**一份实现，可以多处显示；两处实现，必然漂移。** 面板有三处落在这条规矩上：

1. **"打开某一页"**：今天是**内联在详情页里的**（`PrototypeInfoPage` 的 `openInBrowserPane`：`browserPane.create` → `navigate` → 需要时 `applyPrototype` → `focus`）。抽成共享函数、三处都用（详情页、面板、对话头）；面板里打开时带当前 `sessionId` 作 `bindToSessionId`，窗口就顺带认这个对话。
2. **页索引那一行**（名字 / 类型 / 入口 / 改动数 / 失配标记 / 打开）：面板不是它的第二个实现，是它的第二个位置——共用详情页的渲染件。不共用的话，行里加一个字段就要写两遍，而两遍里先忘了的那一遍没人会发现。
3. **补丁清单不共用，因为面板里根本不该有**：`patches.entries` 的清单属于详情页「改动」段（共享补丁、写者计数、自动重放开关也在那里）；面板只从它派生"这一页有几处、有几处失配"。同理锚点全集的孤儿清单留在「锚点」段。

### 23.6 未做（明确记录）

- **不做右侧栏**（本节原本的落点）：`RightSidebarPanel`、`parseRightSidebarParam` 那一套骨架是现成的，但它要改面板栈的布局、还要一条自己的开关与"跟随焦点"。并排面板是既有能力，够用——**除非**将来要的是"每一个对话旁边都自动带一条、跟着焦点跑"的栏。
- **不把详情页整页放进面板**：内容问题（§23.2 最后一条）——面板是详情页的子集，不是它的半屏版。
- **不在面板里放页级动作**（改名／移除／设为入口／新建页）：它们是"这条流程怎么走"的决定，留在详情页「页面」区块（§19.9 的一级行与页索引不变）。
- **不做 iframe／`<webview>` 两种内嵌**：前者显示的是未打补丁的原页面，后者要打开 `webviewTag` 并另开一条注入路径（§23.3）——内嵌只走 placement。
- **不做截图当终点**（可以当过渡）：不能点、不能选元素，而核心动作是"选元素 + 说话"；还要新增一条 renderer 侧截图 RPC。
- **不做 tab 化的面板**：先加段（可折叠），tab 是"我要找某一类"，这里要的是"一眼扫完"（§23.3）。
- **不为窄窗口加特例**：compact 下并排自动退化成下钻（既有行为），那时面板就是"把对话换掉"。
- **面板读数据不新增 IPC、不改原型数据形状**：它读的还是那份状态报告；但**预览的摆放要新开一条**（placement 的创建/移动 + bounds 同步，§23.3）。
- **不把本会话产物搬进面板**：它在会话信息 popover 里已经有家（§23.3）。

### 23.7 验收（§10 的续，T 组）

116. 已绑定原型的对话 → 烧瓶菜单里多一项「在并排面板里打开这个原型」；点它 → **对话还在左边**，原型面板出现在旁边（不是把对话换掉）
117. 面板内页索引与详情页「页面」区块**同序同内容**（表序即流程序，两处是同一个渲染件）；行上的「在窗口里打开」把那一页交给工作区浏览器窗口，且窗口绑定这个对话
118. 用外部编辑器改一条补丁 → 面板里的改动数与失配提醒**自己变**，不需要刷新页面，且与 `status` 一致
119. 跑一次 `export` → 页头「交付」卡里的 `dist/` 清单出现产物；PRD 里有需求而没有任何实现时，面板与详情页说**同一句**（点名那条需求）
120. 未绑定原型的对话 → 菜单里那一项不出现（没有原型可开）；面板 route 被直接打开时是空态并指向烧瓶菜单
121. 面板固定在一个原型上：切焦点到别的对话，面板内容**不变**（面板是固定参照，不跟着焦点跑）
122. 开着面板刷新应用 → 面板还在（面板栈在导航状态/URL 里）；后退回到"没有它"的状态
123. 烧瓶菜单的图标带状态：还差 2 件时是琥珀点带 `2`，全部结清后变绿点，全程不打开面板
124. 预览停在 `orders` → 面板里 `orders` 那行带"当前"标记；切到 `cart`（在预览里或窗口里都算）→ 标记自己变，不需要刷新面板
125. 输入框里已经写了一半 → 点面板里的一条提醒，原来那段文字**还在**，提醒接在它后面（预填不覆盖、不自动发送）；旁边没有对话面板时，交给该原型绑定的那个对话
126. 原型被删掉 → 面板说"这个原型不在了"并给关闭/解绑的出口，而不是空态
127. 窄窗口（compact）→ 面板自动退化成下钻（既有行为），不为它加特例
128. 预览里选元素 → 拾取照旧回到对话；改一条补丁 → 预览与窗口看到同一份结果（不是两套渲染）——**第二步的验收**
129. 关掉面板 → view 归还给独立窗口（或按需要销毁），不留孤儿 view；再打开 → 回到同一页——**第二步的验收**
130. 从面板里打开一个**已经在窗口里活着**的页 → 是**搬摆放**（同一个实例），面板与窗口里不会同时出现两份活页（§22 第十五轮：这一条靠"搬"，不靠"禁止多实例"）



