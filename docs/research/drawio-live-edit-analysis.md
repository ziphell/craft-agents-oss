# drawio 编辑器能否「人和 agent 同时编辑」——实测分析（2026-10-30）

结论：**能接，而且不用改 drawio 源码**。这份 bundle 里 drawio 自带 `embed` 的 **diff-sync 协议**
（`patch` / `getDiff` / `resetDiff` / `merge`），它就是为"多个编辑器同步同一份文件"做的，
还有 `model.prefix = guid + '-'` 这种专门给多客户端防 id 碰撞的代码。缺的只是我们这一侧的接线。

探针：`C:/temp/drawio-probe`（独立 Electron + 静态服务 + 往 index.html 追加一段 bridge 脚本），
跑的是仓库里真实的 `apps/electron/resources/drawio`。下面所有数字都是它打印出来的。

## 一、现在这一侧是什么状态（读代码）

| 环节 | 现状 | 位置 |
|---|---|---|
| 编辑器拿到文档 | **只拿一次**：`initialXml` 被 `useRef` 钉住，`src` 也只算一次 | `packages/ui/src/components/drawio/frame.tsx` → `DrawioEditorFrame` |
| 人改 → 文件 | `autosave` 事件给**整篇 XML**（`{action:'load',xml,autosave:1}`，没有 `diffSync`）→ `report()` → 1.2s 防抖 → 读盘比对 → 写 | `types.ts:buildDrawioLoadMessage`、`useFileWriter.ts`（`SAVE_DEBOUNCE_MS=1200`） |
| 文件变 → 编辑器 | 看 `generationRef`：**没动过**就 `reloadToken+1` → 帧**整体重挂**（编辑器重启，视图/选中/撤销全没）；**动过**就弹冲突（保留我的 / 用磁盘的） | `useFileWriter.ts:checkForExternalChange` |
| 谁在写 | 编辑器防抖写 + agent 直接写，两条路靠"写前先读、不一致就拒绝"避免覆盖 | 同上 `save()` |

也就是说：今天 agent 一改动，人是「编辑器重启」或「被问一句」，不存在并发。
好消息是**已经不会互相静默覆盖**（写前读 + 冲突提示），缺的是"就地推送"。

## 二、编辑器里已经有的能力（源码在包里，未压缩）

`apps/electron/resources/drawio/js/diagramly/*.js` 是**可读的 drawio 源码**（不是 min），v31.5.2。

- `EditorUi.js:26749` `action:'load'` —— 接受 `diffSync:true`（或 `{patchOnly:true}`）、`autosave`。
- `EditorUi.js:27295~27355` 人改动时：`getData()` + `diffPages(embedShadowPages, currentPages)`，
  发出的 `autosave` 里带 **`patch`（单元格级 diff）+ `checksum`**，`patchOnly` 时才不带 `xml`。
- `EditorUi.js:27157` `action:'patch'` —— 把宿主算出的 patch **就地打进当前模型**，回报 `{event:'patch',checksum,checksumMismatch?}`；
  `ignoreChange` 期间不回声（不会形成回环），`lastData=getData()` 后 shadow 自动前移。
- `EditorUi.js:27200` `action:'getDiff'` —— 要编辑器自己"欠"的那部分 diff（shadow→当前），没有就回整篇 `xml`。
- `EditorUi.js:27219` `action:'resetDiff'` —— 重设基线。
- `EditorUi.js:27128` `action:'merge'` —— `file.mergeFile(...)`：整篇合并，`DrawioFile.LAST_WRITE_WINS=true`（`DrawioFile.js:50`）⇒ **本地改动赢**。
- `EditorUi.js:27306` `this.editor.graph.model.prefix = Editor.guid() + '-'` —— 注释原话：给每个 embed 编辑器的
  新单元格加唯一前缀，否则两个编辑器的 `2,3,…` 会被 diff 当成同一格。**这条代码就是为多客户端写的。**
- `DrawioFile.js:1116` `patch(patches, resolver, undoable, sendChanges)` —— 远端 patch **不进撤销栈**，
  且保存/修复历史（`undoMgr.history = history`），即人按撤销不会撤掉 agent 的改动。
- `EmbedFile.js` 末尾注释：*"This class need to be implemented by integrations if some file features like real-time collaboration is needed"*。
- `P2PCollab.js` 是 drawio 自己的实时协作，但要走**它的 WebSocket 信令服务器**（`useSocket`）⇒ 离线用不了。
  不要指望"打开 drawio 协作模式"，自己接线更实际。

## 三、实测（同一份 bundle，真实协议）

```
PROBE bridge hooked
<- init                1330ms
load(diffSync:true) -> <- load   1470ms  checksum=317611708  xml=491
人工插入一个单元格      2088ms
<- autosave            2092ms  patch 206 字符 / xml 758 字符   checksum=678968032
宿主 diffPages + {action:'patch', checksum:'故意的错值'}
<- patch               2510ms  checksumMismatch=true
   应用后：AG1=true  H1(人画的)=true  A(原图)=true      ← 不重叠的并发改动天然合并
<- getDiff             2513ms  patch=[]  checksum=1028080346 ← 宿主 patch 之后基线前移，下一发 patch 起点正确
（patch 之后没有任何回声 autosave ⇒ 不成环）
```

重叠冲突（人和 agent 改**同一个格子的同一个属性**，agent 基于旧基线）：

```
人: A=A-human → autosave(patch) → agent 用 baseline 算 patch 推上去
patch ack → {A:"A-agent", B:"B-agent"}      ← A-human 被静默覆盖
```

要点：
1. **patch 是属性级的**（`{"u":{"p1":{"cells":{"u":{"A":{"value":"…"}}}}}}`，`u/i/r` = update/insert/remove），
   所以"两个人在不同格子/不同属性上同时改"能自动合；**同一属性 = 后写者赢，没有提示**。
2. 一个改动 4ms 就送到宿主（**autosave 不防抖**，只有写盘防抖 1.2s）⇒ 宿主其实"实时"知道人在画什么。
3. 帧里那段 bridge 用**往 index.html 追加 `<script>`** 就行（探针里 `bridge hooked` 成立）——
   两个宿主都直接返回 index.html 字节，插一行即可：`apps/electron/src/main/drawio-host.ts`、
   `packages/server-core/src/webui/drawio.ts`。有 `EditorUi.prototype.init` 可包，拿到活着的 `ui` 实例
   （没有全局句柄）。

## 四、两种接法

### A. 热补丁 —— **已落地（2026-10-30 19:5x）**

落地结果与实测见 MEMORY.md 的「drawio：agent 的改动现在就地打进人开着的编辑器」一节。
四个关键补充（原计划里没写、实际踩到的）：

1. **`checksum` 要传目标文档的 hash**，不是改动前的 —— drawio 先应用再比对，传旧值永远 mismatch。
2. **`checksumMismatch` 不是拒绝**：那时合并已经发生，它是"人也在同时改"，应接受并把结果写回盘。
3. **必须用 MessagePort**：drawio 对不认识的 action 回 `unknownMessage` 并把整条消息（整篇文档）带回来。
4. **两种编码**：window 通道字符串、port 通道对象，两端都要兼容。

原计划的步骤（保留作记录）：
1. `buildDrawioLoadMessage` 加 `diffSync: 1`（对现有解析向后兼容，`xml` 仍会带）。
2. `DrawioEditorFrame` 暴露 `applyDocument(xml)`：
   - **推荐**：注入一小段 bridge，帧内自己算 `diffPages` 并 `currentFile.patch([patch], null, false, false)`
     —— diff 引擎用 drawio 自己的，不用移植、不用第二进程。
   - 备选：主进程的 headless engine（`drawio-render.ts` 那个隐藏窗口）算 diff，再把 patch postMessage 进来。
3. `useFileWriter`：外部变化且帧在屏上时**不再**重挂/弹冲突，改为推 patch；
   收到 `checksumMismatch` 或 patch 报错（或"整篇删了重加"这种大改）才退回今天的冲突 UI。
4. 结果：agent 改一个格子，人的界面里那个格子当场变，画布、选中、撤销都还在。

### B. 真·并发（1~2 周）
在 A 之上再加 bridge 的三条通道：
- `observe`：把模型的细粒度变更（节流 ~150ms）推给会话，agent 能"看见人在画什么"；
- `apply`：agent 用**单元格级操作**表达改动（insert/update/remove/换页，一次 `beginUpdate` 一组），
  可选 `undoable=true` 让 Cmd+Z 能撤掉 agent 这一笔；
- `presence`：agent 正在改哪个格子/页，界面上有个标记（也是"我要动这个格子"的宣告）。

## 五、四个必须解决的问题（不是接线细节，是规则）

1. **同一属性静默覆盖**（实测）。两条路：① 人要动的那格有未落盘改动就先不推，给一个"agent 想改 X"的确认条；
   ② 推送前把 agent 的 patch 与人的 patch 做交叉检查（patch 是 id+属性级，能判断重叠）。
2. **agent 的 id 必须稳定**。整篇重写若换了 id，diff 就变成"全删全加"，人正在编辑的格子会消失。
   `drawio_tool` 侧要规定"保留既有 id"；新格子用 agent 自己的前缀（编辑器那边已经是 `guid-`）。
3. **撤销语义**。实测：远端 patch **不进撤销栈**（`undoable` 为假）。要么接受"撤销只撤自己的"，
   要么把 agent 的改动以 `undoable=true` 打进去（一次一组）。别两样都想要。
4. **性能**。今天的 `autosave` 本来就是**每次 CHANGE 都 `getData()`**（整篇序列化）；开了 diffSync 还多一次
   `clonePages + diffPages`。小图无所谓（实测 3 格 206 字符/4ms），大图拖拽前要先量。
   真要上 B，`observe` 必须自己节流。

另外：`onDocumentOpenChange` 的「这个文件正在编辑器里」注册表**已经存在**（`packages/shared/src/office/open-documents.ts`，
office 的写路径已经在查它）。drawio 的 `useFileWriter` 也在登记，只是**没有人**在读它 ——
"编辑器开着 ⇒ 走 patch，没开 ⇒ 直接写文件"这条判断几乎是现成的。

## 六、要不要看 drawio 源码

要看，但**不用去 GitHub 拉**：`resources/drawio/js/diagramly/` 就是可读源码（`EditorUi.js` 924KB，
`DiffSync.js` 69KB，`DrawioFile.js`，`EmbedFile.js`）。真正要读的只有四段：

1. `EditorUi.js` 25900–27420（embed 消息协议，含 load/merge/patch/getDiff/autosave）；
2. `DiffSync.js`（patch 格式、`diffPages`/`patchPages`，以及冲突再基线的 `resolveCrossReferences`/`adoptTheirPages`）；
3. `DrawioFile.js` 391（mergeFile）/1116（patch）；
4. `EmbedFile.js`（"实时协作要集成方自己实现"那条注释）。

**不要改这些源文件**：bundle 是 `fetch-drawio-assets.ts` 拉下来的、会被重刷；要加的东西作为**独立脚本**
由两个宿主在返回 index.html 时追加（和 office 的 shim 一个套路）。
