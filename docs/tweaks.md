# Tweaks — 开发文档

> **定位**：本文写「代码在哪、哪些不能碰、怎么验证」。用户在界面上看到的东西、给 agent 看的指南见 `apps/electron/resources/docs/tweaks.md`；用词口径（那个窗口叫什么、tab / 地址 / page）见 [术语与文案规范](vocabulary.md)。
>
> **一句话**：**tweak 是针对"不属于你的页面"的常驻修改** —— 一个文件夹装着"面向哪些页面"和"做什么"（`tweak.css` / `tweak.js`），每次那些页面加载时应用一次。它有两种 carrier：本 app 自己的浏览器窗口（唯一看得见、能用 `browser_tool` 检查的那个）和由同一批文件构建出的可加载扩展（唯一能让它进入别人真正在用的浏览器的那个）。
>
> **核心模型（本文件的一半在这上面）**：tweak 是**规则集**，不是页面。规则一变就**安装**（下一次加载生效）；安装只写注册（CDP init script），**永不对已经存在的文档求值**。文档出生时拿一份规则，此后一生不变 —— 因为 tweak 只能被加上去，不能被干净地撤掉（CSS 撤得掉，JS 撤不掉，而两个文件是一个 tweak）。

---

## 1. 模块地图

### 共享层 `packages/shared/src/tweaks/`

| 文件 | 负责 |
|---|---|
| `types.ts` | `TweakConfig` / `LoadedTweak` 与四个文件名常量（`tweak.json` / `tweak.css` / `tweak.js` / `hits.json`）。头上说明了为什么**只有两个事实住在 json 里**（`matches`、`enabled` —— 其余都能由"文件在不在"表达）以及**为什么 patterns 是 Chrome 的**（另一个 carrier 的 `content_scripts` 就是这套语法） |
| `storage.ts` | 路径构造、`loadTweak` / `loadWorkspaceTweaks` / `readTweakSources`、`createTweak` / `updateTweak` / `deleteTweak`、`tweaksForUrl`、`whyTweakConfigIsInvalid`、`TWEAK_SLUG_REGEX`（`^[a-z0-9-]+$`）。**`createTweak` 不写代码文件** —— 那是作者的事，见 `tool-callbacks.ts` |
| `match.ts` | 主机侧的语法：`parseMatchPattern` / `matchPatternMatches` / `anyMatchPatternMatches` / `whyMatchPatternIsInvalid` |
| `inject.ts` | **载荷**（app 内 carrier 发给页面的那段脚本）：`buildTweaksInitScript` / `buildTweaksMatcherSource` / `buildTweaksProbeScript` / `buildSelectorMatchScript`。头上是模型本身（`One pass per document, and no way back`）；脚本里 `insertStyle` 在 DOM 之前插样式，`whenReady` 按 `@run-at` 放 JS |
| `targets.ts` | `@target` 标记的解析与 `hits.json` 的读/合并/写（`recordTweakHits` 合并而从不从空开始 —— 旧时间正是"停止匹配"可见的唯一依据） |
| `run-at.ts` | `@run-at` 的读取。三个值就是浏览器自己的 `content_scripts.run_at`（`document_start` / `document_end` / `document_idle`），**缺省 `document_end`** —— 平台的缺省是 `idle`，那是为了不拖慢页面，而 tweak 存在的意义是改页面。先读 `tweak.js` 再读 `tweak.css`；读不出三个值之一就当没声明 |
| `summary.ts` | 展示形状：`TweakSummary` / `TweakDetails` / `toTweakSummary` / `toTweakDetails` / `toTweakTargets`（**agent 的工具与 app 的页面共读这一份**） |
| `extension.ts` | 第二个 carrier：`buildTweaksExtension` / `exportTweaksExtension` / `TWEAKS_EXTENSION_DIRNAME`（`craft-tweaks`）。只构建**开着的** tweak，产物是静态字节（`tweaks/{slug}.css|js`），拒绝覆盖已存在的目录 |
| `index.ts` | barrel |

### agent 面

- `packages/session-tools-core/src/tool-defs.ts`：**五个**工具的 schema 与描述（`list_tweaks` / `get_tweak` / `create_tweak` / `update_tweak` / `delete_tweak`）。`create_tweak` 的描述指向 agent 指南。**导出不是工具**：它把扩展写进一个人选的文件夹，而"放哪儿"只有那个人知道、也由他定 —— agent 在那种工具里只是传话的。所以它只有 tweak 页面上一个动作（`tweaks:export` RPC + 目录选择器），和网站导出同一个形状。
- `packages/session-tools-core/src/handlers/tweaks.ts`：handler，只做参数拆分与调用。
- `packages/server-core/src/tweaks/tool-callbacks.ts`：**真正落盘的地方** —— `createTweak` 先建配置、**之后**才 `writeFileSync` 写 `tweak.css` / `tweak.js`；`updateTweak` 只改 `tweak.json`，从不碰代码。三者都 `await mutated(slug)`。
- `packages/server-core/src/sessions/SessionManager.ts`：装配上面的 callbacks；`onTweaksMutated` → `notifyConfigFileChange(rootPath, 'tweaks/{slug}/tweak.json')`（**它只是 poke 监听器**，不直接调安装器）。同一文件里 `setTweaksInstaller` / `installTweaks`。

### 主进程 carrier

- `apps/electron/src/main/tweaks-injector.ts`：`applyTweaksToInstance`（**只安装**：`clearInitScripts('tweak:')` + `addInitScript`，再无别的）、`requestTweaksForWorkspace`、`attachTweaksInjector`。它同时也是 `hits.json` 的唯一写入者（`recordTweakHitsForTab`，靠页面的探针回答）。
- attach 在 `apps/electron/src/main/handlers/browser.ts`：pane manager 只有**一个** `onStateChange` 回调，渲染层的地址栏已经占了它，所以注入器是被那个回调**调用**，而不是自己去注册（模块头上写了原因）。

### 通道与装配（一条链）

```
任何写入者（agent 工具 / 界面开关 / 编辑器手改）
   └─ 写文件 + poke 监听器（notifyConfigFileChange）
        └─ ConfigWatcher.onTweaksListChange
             ├─ broadcastTweaksChanged → tweaks:changed → 界面列表
             └─ installTweaks → requestTweaksForWorkspace → 重装注册
地址移动（handleStateChange）→ 同样重装注册
```

- `packages/shared/src/config/watcher.ts`：跟随 `tweak.json` **和** `tweak.css` / `tweak.js`（`hits.json` 明确不跟随）。`notifyFileChange` 是给"原子重命名在某些平台收不到 fs 事件"准备的手动 poke。
- `packages/server-core/src/handlers/rpc/tweaks.ts`：`tweaks:update`（开关）/ `tweaks:delete` / `GET` / `GET_ONE` / `EXPORT`。**不自己广播也不自己安装** —— 写 + poke，剩下的归监听器。
- `apps/electron/src/main/index.ts`：`sm.setTweaksInstaller(requestTweaksForWorkspace)`。

### 渲染层

- 形状和 MCP / 文件夹一样是**两栏**：`components/app-shell/TweaksListPanel.tsx`（中间导航栏的列表）+ `components/tweaks/TweakView.tsx`（详情）。侧边栏只有**一个条目** `nav:tweaks`（不再展开成子项）。
- 详情页**用 `Info_Page` 那套骨架**（`Info_Page.Header` + `.Content`，和 SkillInfoPage / AutomationInfoPage / ProjectInfoPage 一样）：hero → 分区。别在这里另起一套布局 —— 一个"名字 + 一个状态 + 几条事实"的东西不该有自己的页面形状。
- 页头三个动作：**让智能体来做 / 导出为扩展 / 删除**。第一个是改一个 tweak 的唯一入口 —— 代码由 agent 写（页面不属于这个应用，没有表单能产出它，也没有该放在这里的编辑器），所以它只做一件事：开一个对话，把「修改「{{name}}」这个 tweak：」填进输入框（`routes.action.newSession({ input })`，**不自动发送**，话还是人说）。没有这个按钮时，页面顶上那句"让智能体来更新这个 tweak"就是一句空话。
- **开关在 hero 行里，状态在同一行的名字下面用一句话说。** 这两者是同一个控件：`statusLine()` 三态（关闭 / 还没跑过 / 最近跑于何时），**永远一行**。切开关时页面上不能有任何东西移动 —— 之前那条「关闭」提示是插在开关上方的，一点开关整个页面往下跳一格，就是这条规则的反例。分区（Runs on / 它会改动什么）与告警都在开关下面，且都不因开关而增删。
- 列表**不用芯片报开/关**。每个 tweak 都有自己的开关，"开"是绝大多数行的常态，芯片只会占满每一行；关闭用**整行变淡**（`opacity-50`），和 `AutomationsListPanel` 一致。唯一该上芯片的是例外：没有代码（`tweaks.noCode`）。描述**只在详情**：它是 agent 给代码写的注记，属于展示代码的那一页；列表一行的职责是把几个 tweak 分开。
- 详情里「它会改动什么」按 **文件 → 时机** 说，不列 `@target` 表：能用的 tweak 的选择器必然都在（不在的正是上面那条告警），列出来只会是一张全绿的废表。每行是「`tweak.css` —— 在页面绘制之前应用」/「`tweak.js` —— 页面的 HTML 就绪之后执行」（文案由 `runAtMessageKey()` 按 `@run-at` 选）。只有**存在**的文件才出这一行 —— 报一个没人写过的文件等于说"它在"，这是文件列表最不能报错的地方。页面变了（`targets` 里有 `stale`）单独用一条 warning 点名那些选择器，提示"让 agent 来更新这个 tweak"。
- `atoms/tweaks.ts`（唯一状态）+ `hooks/useTweaks.ts`（订阅 `tweaks:changed`）；路由 `shared/routes.ts`（`tweaks` / `tweaks/tweak/{slug}`）+ `route-parser.ts`；`lib/nav-helpers.ts` 的 `isDetailNavState`（tweaks：**选中了某个才**算 detail，和 sources 一样）。

---

## 2. 不变量（不要碰）

① **规则集模型：安装 ≠ 求值。** 安装只决定"下一个文档拿到什么"。这一条顶住了这一族里几乎所有设计：开关、编辑、删除、甚至地址移动，都不对已经存在的文档做任何事。**扩展 carrier 按构造就服从这条** —— 声明式 `content_scripts` 只在文档创建时触发，浏览器没有任何"送进已打开的 tab"的接口。所以"重新导出 + 在扩展卡片上按 Reload"之后，页面仍要各自 reload；这是同一条规则，不是扩展少做了什么。

② **文档出生时拿一份，此后一生不变。** `inject.ts` 里因此**没有** `window.__craftTweaksRun`、没有 digest、没有 `run.css`/`run.js` 判断、没有"复用已有 `<style>`"的查找 —— 那段脚本每个文档只跑一次，那些判据永远为真。谁要加回第二次求值，先读 `inject.ts` 的 `## One pass per document, and no way back`。

③ **不能回滚，所以两个文件同进退。** CSS 撤得掉（删掉 `<style>` 页面回到自己的层叠），JS 撤不掉（它做过什么是这里没有记录的历史）。只撤 CSS 会留下作者从没写过的状态 —— 所以不动，`load` 是唯一的重置。

④ **只有一条通道。** 写者一律"写文件 + poke 监听器"；`onTweaksListChange` 是这个通道的**唯一出口**，它做两件事（广播 + 重装）。不要给某个写者配一条直连安装器的捷径（曾经有，见 §4），也不要第二个广播者。

⑤ **`hits.json` 只由 app 的 carrier 写。** 内容脚本回不到这台机器的盘上，所以它的缺席**不等于**"从没跑过"，只等于"app 的窗口没看过它跑"。反向：applier 写 `hits.json`，所以 `hits.json` 必须**不**被 watcher 跟随（看它会自激）。

⑥ **语法实现两份**（`match.ts` 与 `inject.ts` 里生成的 js），靠 `__tests__/inject.test.ts` 那张共享用例表钉住。改一边必须改另一边；这张表也是 patterns 必须是 Chrome 语法的原因。

⑦ **开关是同意。** `createTweak` 缺省 off，扩展构建也排除 off 的 tweak —— "app 没跑它"和"它被需要"是两件事。

⑧ **删目录 = 删 tweak**（`hits.json` 跟着走）。

⑨ **CSS 恒早，JS 按声明。** 样式表永远在 DOM 之前插入，不看任何声明 —— 那是"页面不会闪过它要改的状态"的全部依据。JS 的时机是 tweak 自己的 `@run-at`（`run-at.ts`，缺省 `document_end`）。做的两处用同一套名字，因为扩展那边就是 Chrome 的 `content_scripts.run_at`：一个 tweak 出**两条**条目，css 走 `document_start`、js 走声明的那一档。

⑩ **同一个 JS 世界：页面自己的那个。** app 侧用 `apps/electron/src/main/browser-cdp.ts` 的 `Page.addScriptToEvaluateOnNewDocument({ source })` 注入 —— 不带 `worldName`，也就是**页面自己的 JS 上下文**（不是隔离世界）。所以导出的 js 条目必须写 `world: 'MAIN'`，否则会落到平台默认的 `ISOLATED`：共享 DOM、但摸不到页面的全局与原型链，**拦截型 tweak 会静默失效**。代价是没有隔离（页面看得见这段代码）—— 那只是承认 app 那边本来就没有。
  - **待确认：子 frame。** app 侧那条 CDP 调用没有 frame 参数（对页面的所有 frame 生效，匹配逐 frame 判），而扩展侧不写 `all_frames`，默认只主 frame。这一条没实测，但两边写在纸面上就不一样。

---

## 3. 时序（踩过的坑）

- **注入器只在地址变了时动。** `observedByInstance` 的标记是 `tabId|url`，相同就 return —— 所以**同 URL 的 reload 不触发任何主机动作**。那次 reload 拿到的是**它出生之前装好的**注册。
- **导航触发的重装，对新文档来说晚一步。** 地址变化是 `did-navigate`（提交之后），此时新文档已经创建、init script 已经跑过。所以真正让"改完下一次加载就看到"成立的，是**规则一变就重装**那条路：注册在写入那一刻就是新的。没有它，工具写入和手改都要隔一次导航，而且纯 reload 永远不会生效。（这也是 `notifyConfigFileChange` 手动 poke 存在的原因之一。）
- **安装会写进被监听的目录 —— 所以监听器绝不能跟随那个文件，也不能跟随目录本身。** 每次安装都以 `recordTweakHitsForTab` 收尾，它把 `hits.json` 写进 tweak 自己的文件夹；而原子写在这个平台还会**额外报一次目录**（`tweaks/<slug>`）。两条都跟就是：事件 → 安装 → 写 `hits.json` → 事件 …… 每 100ms（debounce）一轮，日志刷屏、界面被反复广播。所以 tweaks 分支只认 `tweaks/<slug>/` 下那三个文件（`parts.length === 3`），一切目录级事件都不看 —— 文件夹没有那三个文件之外的消息：新建、删除、改名都会带上其中一个文件的事件，而我们自己的写者另外还会 poke `tweak.json`。`__tests__/watcher-tweaks-events.test.ts` 钉住这条。
- **注册成对操作。** 每次安装都 `clearInitScripts('tweak:')` 再 `addInitScript`。少一步清理，同一个文档就会跑两遍脚本。
- **后台 tab 不被前移就拿不到注册**；前移本身是一次 state change，所以"人在看的那一个"始终覆盖。
- **`.js` 的每个 body 各自 IIFE + try/catch，但整段脚本是一个 source** —— 一个 body 的**解析**错误会带走后面的（这是诚实的极限；用 `Function` 构造器可以逐条兜住，代价是 `eval`，页面 CSP 可能拒绝）。

---

## 4. 墓园（删掉的，与为什么）

- **活体求值（`evaluate`）。** 曾经做两件事：开关 on 到达**已打开**的页面；SPA 路由变化时对**同一个文档**重新求值。两件都删了。第二件是它最坏的一面：路由一变摘要就不匹配 → CSS 重插、**JS 重跑**（非幂等的 JS 会在同一文档上做两遍），而不匹配的 tweak 的样式又撤不掉。删掉之后 app 与扩展的行为也终于一致（扩展是 `run_at: document_start`，路由变化本来就不重跑）。
- **"只加不减"的中间形态**（脚本保留 run mark，活体 pass 只加）。它的表述已经并进 §2②③；留着它只会让"这个 pass 到底算什么"继续含糊。
- **`HandlerDeps.onTweaksChanged`。** 开关的"立即重装"，与 poke→watcher 那条**重复**（界面开关本来就 poke 了监听器）。两者唯一的差别是 100ms 去抖，而人要按 reload 才看得到效果 —— 那 100ms 观察不到。删掉之后安装入口只剩一个。
- **`rpc/tweaks.ts` 的 `broadcastChanged`。** 第二次广播 `tweaks:changed`（同频道、同 target）—— 监听器已经播了。
- **watcher 不跟随 `tweak.css` / `tweak.js` 的旧规矩**（理由写的是"它们不改变有哪些 tweak、开没开"）。在规则集模型里它们改的**正是规则**，所以那条理由不成立。
- **侧边栏把每个 tweak 列成子项。** 现在是中间导航栏的列表 + 右侧详情（MCP / 文件夹同一个形状）：`nav:tweaks` 不再 `expandable`，`navigatorWidth` 也不再为它收成 0。

---

## 5. 验证

- `bun test packages/shared/src/tweaks` —— 语法 parity 表、脚本跑在页面替身上（"每个文档都拿到，互相没有记忆"）、`@target` 与 `hits.json` 的合并。
- `bun test packages/server-core/src/tweaks` —— 工具的落盘语义（`create_tweak` 写代码、`update_tweak` 只改配置并 poke）。
- 手动的三条，对应 §2①②：
  1. 改 `tweak.css` → **同地址 reload 就应生效**（注册在写入时已换）。
  2. 改完**不** reload → 页面不变；`browser_tool reload` 才看到。
  3. 拨开关 on → 已打开的页面**不变**；reload 之后才有。
