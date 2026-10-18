# 浏览器 tab 路由模型（设计）

本文记录"一个共享窗口、多个会话、一个人"这套浏览器模型里，**命令落到哪张 tab、谁有权移动人的视图**的最终设计，以及被否决的方案与理由。它是 `apps/electron/resources/docs/browser-tools.md`（面向 agent 的手册）背后的"为什么"。

---

## 1. 一句话

> 路由由**会话自己声明**（cursor），显示只由 `tab-show`（或页面自己开 tab 这一浏览器行为）改变；两者不互相推导。

---

## 2. 问题

一个 workspace 只有**一个**浏览器窗口，被其中每个会话以及人共用。窗口里有多张 tab。于是任何一条命令都要先回答两个问题：

1. 这条命令作用在**哪张** tab 上？
2. 这张 tab 是不是**人正在看**的那张？

如果答案是"看情况、看当前谁在前台"，就会得到两种事故：

- 人点一下 tab 栏，某个 agent 的后续命令**静默改向**到另一张 tab；
- agent 为了干活把人从正在读的页面**切走**。

这两种事故是同一个错误的两面：把"显示状态"当成了"路由状态"。

---

## 3. 两个正交的轴

| 事实 | 存在哪 | 粒度 | 含义 |
|---|---|---|---|
| **cursor** | `BrowserTab.cursorOf: string[]`（写在 tab 上） | 每个会话一条；一张 tab 可挂多个会话 | 这个会话**未指名**的命令去哪 |
| **active** | `BrowserInstance.activeTabId`（写在窗口上） | 窗口一个 | 窗口**正在显示**哪张 |

- cursor 是**路由**，不是 claim：它不决定谁能进哪张 tab（那是 `belongsTo` / `whyTabIsOutOfReach` 的事），也不决定此刻谁占着（那是 `lockedBy` / hold 的事）。
- active 是**人的事实**。它只由四件事改变：`tab-show`、人自己的动作（点 tab 栏 / 自己的 `+`）、页面自己开 tab（且它的来源 tab 没有被驱动，此时按浏览器的 `disposition`）、关掉在屏那张时的接替。
- 两者**永不互相推导**：没有 cursor 不读 active，cursor 变化不改 active。

---

## 4. 产生规则：谁写哪个事实

### cursor 只由"会话声明"或"具名的 work"产生

| 入口 | 行为 |
|---|---|
| `navigate <url>`（无自己的 tab） | 取一张自己的 tab，并把 cursor 写上去（见 §6） |
| `--tab <id>`（任何命令） | 先写 cursor，再执行该命令 |
| `tab-select <id>` | 只写 cursor |
| `tab-show <id>` | 写 cursor **并且**切显示（子会话只写 cursor） |
| `tab-new <url>` | 新 tab 属于该会话，同时成为 cursor |
| `tab-assign <id> <session>` | 把自己的 work 的 tab 连同 cursor 交给后代/同 task 的会话 |
| 人从 tab 栏某个 section 的 `+` 开 tab | 写**那个 section 对应会话**的 cursor（人不替它"工作"，只替它"备好一页"） |

除此之外没有别的来源。**关闭 tab 不移动任何人的 cursor**（见 §5）。

### active 只由四件事产生

| 入口 | 说明 |
|---|---|
| `tab-show <id>` | 唯一的"要求式"：切显示 + 写 cursor；**不拉起窗口**（窗口由人从顶栏自己打开） |
| 人自己的动作 | 点 tab 栏（`activate`）、自己的 `+`（`createTab({activate:true})`） |
| 页面自己开 tab | 来源 tab 正被驱动（hold / 命令输入）→ 落在后面；否则按 `disposition`：前台请求上屏，`background-tab` 不上 |
| 关掉在屏那张 | `successorOf` 接替显示（纯窗口行为） |

`createTab` 的 `activate` **默认 false**：想让新 tab 上屏必须明说。agent 没有任何路径靠默认蹭到前台。

---

## 5. tab 被关掉之后

cursor 写在 tab 上，**随 tab 一起消失**。因此关掉"我的工作 tab"之后，会话回到"无 cursor"状态，下一条未指名命令**报错**，而不是回落到任何 tab：

```
No tab of this window is one you work from, so a command that names no tab has nowhere to go —
and the tab on screen is not chosen for you … "navigate <url>" takes a tab for you; … name one
("--tab <id>", "tab-select <id>") … or open one ("tab-new <url>").
```

（`whyThereIsNoWorkingTab`，子会话额外给 `tab-assign`。）

为什么不做"自动回落到下一张"：那会在**关闭那一刻**替会话写一个它没声明过的 cursor；回落到"在屏那张"更糟——那是在**下一条命令那一刻**让人的视图决定路由。两者都是 §2 的事故。

关掉 tab 时唯一被清理的是 **hold**（锁不能比它锁的东西活得久）。

---

## 6. 空窗口的认领规则

窗口诞生时自带一张 `tab-1`（`about:blank`）。这条规则决定"谁可以拿它"：

> **我的 tab 永远不是窗口里已有的那张；唯一例外是"本次调用刚创建窗口时的出生 tab"。**

三种"要一张 tab"的调用（`navigate` 的引导、`tab-new <url>`、顶栏 "New tab"）共用这一条：

| 窗口 | 行为 |
|---|---|
| **本次调用创建** | 窗口自带的那张 tab 就是这次动作的产物，拿它——否则一次动作会得到两张空白 tab |
| **已经存在**（哪怕只有一张空白 tab） | **一律新建**。那张可能是人的，"new / 给我一张"都不是"拿你的" |

- 判据只有一件，且只在**调用开始时**问一次：这个窗口此前存在吗（`existedBefore`）。它不回答"这个窗口当初是谁开的"——窗口活得比命令久（agent 的 tab 被关、人又开了几张），那件事事后不可知，也不该由一条命令去追溯。
- 窗口已存在时**不看它的 tab 是否空白、有几张**：空白不代表无主，可能是人开在那儿准备用的。所以这条规则下，agent **从不**碰一张已经存在的 tab；它拿的只有"本次调用里刚出生"的那张。

---

## 7. 页面自己开 tab（`target="_blank"` / `window.open` / popup）

**落点取决于"是谁在产生输入"，而这个事实不用推断**：

```
agentDriving = tab.heldBy !== null || tab.commandInput
activate = !agentDriving && disposition !== 'background-tab'
```

- **`heldBy`**：被驱动中的 tab 不接受人的输入——人要先在 tab 栏把它取回，而"取回"正是释放 hold 的动作。所以 hold 存在期间，从这张 tab 产生的一切都只能来自 agent。
- **`commandInput`**：命令自己那次点击/按键期间打的标记（`withCommandInput`），只活在那一次 dispatch 内。它补上 hold 覆盖不到的唯一时刻：一轮里的第一条命令可能先于它自己的 overlay 到达。
- 两者都不读归属、不读可见性。所以人接管 agent 的 tab 之后（先取回 → hold 消失），他点链接的行为和任何浏览器一致：`target="_blank"` 会切过去。

`window.open` 一并覆盖：脚本弹窗根本不吃修饰键，`disposition` 永远是 `foreground-tab` / `new-window`，但它仍然落在后面——决定它的是"这张 tab 正被驱动"，不是键。agent 的 `click` 不暴露修饰键；tab 的位置完全由驱动状态决定。

---

## 8. 并发

- 默认各用各的 tab：`navigate` / `tab-new` 都在人后面开，多个会话并行时互不相干。
- 一张 tab 允许被多个会话同时作为 cursor（route 不是 claim）：第二个人进来不清走第一个人的路由。
- 真正的冲突点是 **hold**（`lockedBy`）：一个会话在某张 tab 上工作时，那张 tab 不接受他人的点击/键入，他人的同名命令收到"等到这一轮结束"——**是等待，不是永久拒绝**。
- hold 每个 turn 结束释放；`drivenBy` 是"最后移动过它的会话"，在会话停止工作时清除；cursor 跨 turn 存活，只在会话消亡时清除。

---

## 9. 可感知性

agent 通过一个状态面读环境：`tabs`。

每张 tab 输出：`id`、标题、`url`（逻辑地址，含 `(loading)`）、`*`（在屏）、`failed:`（失败 code / HTTP 状态）、`document:`（webContents 里实际提交的文档，仅在不同于地址时出现；内置错误页不上报）、`opened as:`（浏览器自开的）、`belongs to:`（谁的 work / 人）、`driven by:`（最后动它的会话 / 无人）、`locked:`（此刻占着它的会话）、`your tab: yes`（我的 cursor）。

现在两种**原本无声**的状态被显式说出：

1. **没有工作 tab**：`tabs` 打印"没有一张是你的"并给出三条出路（不再让"没有 `your tab` 行"与"这段输出与我无关"混淆）。
2. **我的 tab 没了**：下一条命令当场报同一句话，而不是悄悄落到别处。

每个写动作的回执只陈述它做了什么：`tab-show` 的 `movedView`、`tab-select` 的"窗口没动"、`tab-new` 的"开在人后面"、`navigate` 的幂等语义。

---

## 10. 命令面（最终）

| 动词 | 语义 |
|---|---|
| `navigate <url>` | 在**我的 tab** 上加载；没有就取一张（§6）。**幂等**，推荐作为第一条命令 |
| `tab-new <url>` | **再加一页**：新 tab 在人后面，成为我的。url 必填 |
| `tab-select <id>` | 只把我的工作 tab 换成它（不动显示、不做页面动作） |
| `tab-show <id> [--handover]` | 把 tab 设为窗口显示的那张 + 写 cursor。**不拉起窗口**（自动动作不抢人的屏幕/焦点，靠回复提示人；人从顶栏浏览器入口自己打开）。默认**不**撤 overlay/hold（人看，agent 继续用）；`--handover` 额外撤本窗口的 overlay/hold，明确"交给你用"。子会话只写 cursor |
| `tab-assign <id> <session>` | 把自己 work 的 tab 连同 cursor 交给后代/同 task；只能转自己的 work，被他人 hold 时拒绝，转移后只留 receiver 的 cursor |
| `tab-close <id>` | 关掉**我的 work 的** tab；最后一张关掉窗口（原 `close` 的职责） |
| `tabs` | 上述状态面 |

窗口级命令面（`focus` / `hide` / `release` / `close`）**已整体移除**：没有"把窗口提到前面"这个独立动作（`tab-show` 顺带做），没有"隐藏窗口"，也没有"关窗口"（`tab-close` 关的是 tab，最后一张带走窗口）。原 `release` 的职责并入 `tab-show --handover`：只有显式说"交给对方用"时才撤 overlay/hold，单纯展示不解锁。

`open` **已移除**：它的唯一独有职责（把窗口提到前面）如今属于 `tab-show`；"开一个没有 tab 的窗口"不是会话会要的状态，窗口由开 tab 顺带创建。

`--tab <id>` 仍然"指名即选中"（融合，不拆）：`resolveCommandTarget` 靠 cursor 定位，所以「先写 cursor 再执行」是同一件事的两种说法。拆开需要把 hold 改成跟随"本次命令的目标"而不是 cursor，代价大于收益。

---

## 11. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 关 tab 时把 cursor 移给后继 | 在关闭那一刻替会话写它没声明过的 cursor；回落到"下一张"同样是替它决定 |
| 无 cursor 时回落到在屏那张（takeover） | 让人的点击决定路由，正是 cursor 要消除的耦合 |
| 按"窗口当初是谁开的"决定一张已存在的空白 tab 归谁 | 窗口比命令活得久（agent 的 tab 被关、人又开了几张），历史事后不可知；能确定的只有"本次调用是否创建了它" |
| 把 `--tab` 拆成"只作用一次" + `tab-select` 选 | 修不动 hold：hold 的判据就是 cursor，拆开后 agent 在被点名的那张 tab 上不持锁 |
| 用 Playwright 的单 `current` 指针 | 它只有一个消费者；我们有两个正交的轴，合成一个必然让人的点击影响 agent |
| 照搬 agent-browser 的 `open <url>` 入口 | 它的 session 拥有整个浏览器，启动出来的 tab 天然是它的；我们的窗口是共享的，`open <url>` 等于替 agent 认领一张它没声明过的 tab |
| 每个 agent 一个浏览器（agent-browser 的 session 模型） | 人必须能在一个窗口里看到所有人在干什么；`tab-show` / tab 栏就是为此存在 |
| `tab-close` 默认关"当前 tab" | 共享窗口里"当前"是人的；必须点名 |
| 空白 tab 一律不碰（连窗口的出生 tab 也不碰） | 每个首次使用的窗口都会永久多一张没人用的空 tab，而 agent 关不掉它（`tab-close` 只关自己 work 的） |

---

## 12. 与两个参照实现的差异

- **Playwright**：一个 browser context 一个 `current`。它的 `current` 更接近我们的 cursor，但它与"窗口显示什么"是解耦的（我们实测：普通点击 / Ctrl+点击 / 中键开新标签都不改变 `current`）。我们把它拆成两个事实，正是为了让人和 agent 各自拥有一个。
- **agent-browser（Vercel Labs）**：`--pin-tab` 的严格模式——绑定的 tab 被关就报 `tab_gone` 并给出恢复元信息——**验证了我们的选择**（不猜、报错、给出路）。它把严格做成 opt-in，因为它默认一个 agent 一个浏览器；我们默认多 agent 共享，所以严格必须是默认。

---

## 13. 不变量（review checklist）

1. **cursor 只由会话声明或具名 work 产生**；关闭 tab 不移动任何人的 cursor。
2. **active 只由 `tab-show` / 人的动作 / 页面自己开 tab（浏览器行为）/ 关掉在屏那张的接替**改变；`createTab` 默认不上屏。
3. **未指名命令只读 cursor**，永不读 `activeTabId`；无 cursor 时报错，不回落。
4. **只有 `navigate` 会为一条页面命令自取 tab**（`tab-new` 只在自己创建窗口时接住出生 tab），且幂等：第二次调用落在同一张。
5. **存在不代表授予**：光标存在 ≠ 可以进（reach 看 work），在屏 ≠ 可以动（hold 看 turn）。
6. **一次 write、三种速度**：cursor（路由，粘性）/ drivenBy（最后移动，会话停则清）/ heldBy（锁，turn 结束释放；DTO 里叫 `lockedBy`）。任何时刻三者可以由不同会话持有。
7. **页面自己开 tab 的落点由"谁在产生输入"决定**：来源 tab 被驱动（`heldBy` / `commandInput`）→ 落在后面；否则按 `disposition`（`foreground-tab` 上屏）。人取回 tab 后行为与普通浏览器一致。
8. **"我的 tab"永远不是窗口里已有的那张**；唯一例外是"本次调用创建窗口时的出生 tab"。
9. **凡是"移动人视图"的动作，必须是一个说出来的动词**（`tab-show`），并回报是否真的移动了（`movedView`）。
10. **读取只描述已停稳的文档，且永不读内置错误页**：读取前等 `did-stop-loading`（≤5s），超时在回复里标注；错误页是替身，读取直接报告地址、code 与 HTTP 状态（见 §15）。

---

## 14. 已验证

- `apps/electron/src/main/__tests__/browser-pane-manager.test.ts`：cursor 与 drivenBy 分离、关闭 tab 不移动 cursor、空白 tab 可承载 cursor、出生 tab 的归属（本次调用 vs 已存在窗口）、弹窗落点、hold 随 tab 消亡、`createTab` 默认后台。
- `packages/server-core/src/domain/__tests__/tab-access.test.ts`：`pickCommandTarget` 只认 cursor；`whyThereIsNoWorkingTab` 的三条出路与子会话提示。
- `packages/shared/src/agent/__tests__/tool-commands.test.ts`：`tab-select`、`tab-new` 必带 url、`tabs` 的"没有工作 tab"提示、`--tab` 不提显示。
- agent 手册见 `apps/electron/resources/docs/browser-tools.md`；变更记录见 `apps/electron/resources/release-notes/next.md`。

---

## 15. 导航生命周期：地址、文档与替身页

一张 tab 同时可能涉及三个 URL，混用其中任意两个都会让"读到的内容"与"地址栏说的地址"对不上：

| 事实 | 存在哪 | 含义 |
|---|---|---|
| **逻辑地址** | `BrowserTab.currentUrl` / `BrowserTabSummary.url` | 地址栏说的地方，也就是人要求去的地方；失败后仍然是它 |
| **文档** | `webContents.getURL()` → `BrowserTabSummary.documentUrl` | webContents 真正提交的文档；只在不同于逻辑地址时上报 |
| **失败目标** | `loadError.url` | 这次失败针对的地址；`reload` 重试的是它 |

### 15.1 四个阶段

1. **发起**：`did-start-navigation` 立刻把逻辑地址改成目标，同时清掉标题/图标；文档仍是旧的。tab 继续显示旧文档，所以 Stop 是真取消——`did-stop-loading` 后逻辑地址回到仍在屏的文档。
2. **提交**：`did-navigate` 之后两者一致，`documentUrl` 消失。同文档导航（fragment）走 `did-navigate-in-page`，只改地址，不产生新的加载。
3. **失败**：`did-fail-load`（域名解析、连接拒绝、超时）或 main-frame 的 HTTP 5xx 记入 `loadError`（5xx 不会触发 `did-fail-load`，由 `webRequest` 的响应状态补记 `HTTP_ERROR (HTTP n)`）。逻辑地址保留，标题/图标清空——"去的地方"是新闻，旧页面的名字不是。
4. **替身**：失败后由 renderer 生成内置错误页，经 IPC 以 `data:` 文档载入 tab。`internalPage: 'error'` 表示 tab 正站在这份替身上；它**不是** `documentUrl`——没人要求读我们自己写的这段 HTML，`error` 才是要报告的事实。错误页文案（标题、说明、重试）由 renderer 提供，因为主进程没有 i18n。

### 15.2 读取的时机

读取命令（`snapshot` / `read` / `find` / `screenshot` / `screenshot-region`）描述的是**文档**，不是地址，所以：

- 读取前等 `did-stop-loading`，上限 5 秒。craft 用 `documentLoading`（错误页加载也计入，但工具栏不为它闪 spinner）；open-webui 直接用 `wc.isLoading()`。
- 超时后照读，并在回复里标注 `Status: still loading — this is the document that was on screen when …`。**不**等待 network-idle：文档 load 之后仍可能挂着长连接或埋点，那个等待没有上界。
- 发现 tab 在错误页（`error` 非空 / `internalPage === 'error'`）时，五个读取命令都**拒绝读替身页**，直接报告失败的地址、code 与 HTTP 状态；`reload` / `navigate` 是重试路径。
- `evaluate` 不参与这套等待：它的语义是"在当前文档执行 JS"，不是读取页面内容。

### 15.3 为什么这样拆

- 只有一个 `url` 字段时，"地址变了但内容还是旧的"无法表达；把逻辑地址、文档、失败目标分开，才能让地址栏、重试和读取各自拿到正确的那个。
- 让错误页成为一个 tab 的正式状态（而不是 DOM overlay），读取、截图、地址栏、重试面对的始终是"这个 tab 现在是什么"，两种宿主（craft / open-webui）的行为也因此一致。
- 读取要么等到停稳、要么明确说没停稳；把"读到旧文档"从隐式事实变成回复里的一行字，是这条生命周期能被 agent 正确使用的前提。
