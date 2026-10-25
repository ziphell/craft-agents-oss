# 停车窗 display surface 在 macOS 上的边界（交接）

> **一句话**：产品要求“任何浏览器窗口都不出现在显示器上”。但在 macOS 上，一扇**完全在所有显示器之外**的停车窗可能根本没有 display surface。这份文档要让 Mac 上的 agent 量清楚：完全屏外到底有没有；如果没有，**边界相接（0 像素）** 或 **只让 1×1 像素落进屏幕角** 够不够。

本文只负责“量”和“按表决定改什么”。业务代码在量完之前不要动。

## 为什么现在要问这件事

上传问题的现象：观看器创建的浏览器窗口是 `show: false` 出生的，它的标签页住在停车窗里；在 macOS 上第一帧拿到过 `Current display surface not available for capture`（原地与停车窗各一次），只有把这扇窗口显示到主屏幕一次之后才有画面。

已有的实测回答不了它：

| 已有结论 | 出处 | 为什么不够 |
|---|---|---|
| `never-shown`：`capturePage` 0ms 报 “no surface”；**CDP `Page.captureScreenshot` 98ms 出图**（macOS） | [`macos-capture-verification.md`](./macos-capture-verification.md) | 说的是“从未 show 过”，不是“show 了但完全在屏外” |
| `hidden-after-show`：macOS `capturePage` 3–12ms 能拍；Windows 三条路径全超时 | 同上 | 这扇窗上过屏 |
| `parked`（屏外已显示）：`capturePage` 2800×1800、rAF 42/700ms | 同上 + [`hidden-window-usability.cjs`](../apps/electron/spike/hidden-window-usability.cjs) | 那扇窗**没有** `enableLargerThanScreen`，macOS 的 `constrainFrameRect:toScreen:` 很可能把它拉回了某个显示器 —— 它测到的可能是“部分在屏上” |
| screencast 在 visible / offscreen / hidden 都 ~120 帧/2s | [`video-understanding-plan.md`](./video-understanding-plan.md) | 同样：`offscreen` 那行是先上屏、再移出去的 |

所以缺的那一格是：**带 `enableLargerThanScreen`、确实落在屏外时，`capturePage` / CDP / screencast 各自如何。**

## 要回答的问题

- **Q1** 完全屏外（产品现在的做法：`enableLargerThanScreen`，请求 20000 DIPs 外，实际落在桌面上限 16383）的停车窗，有没有 display surface？
- **Q2** 如果没有：窗口与主显示器**零重叠、但边界相接**（0 像素）时有吗？
- **Q3** 如果还没有：**只让 1×1 像素**落进显示器（四个角各一次）时有吗？
- **Q4** surface 是不是“曾被 map 过一次就保留”（`show` 之后 `hide()` 还能拍吗）？
- **Q5** 窗口有没有被 macOS 挪回显示器？（`requested` vs `landed`）

## 怎么量

脚本：[`apps/electron/spike/parking-surface.cjs`](../apps/electron/spike/parking-surface.cjs)（临时脚本，不属于应用）。

每个变体都是**独立的窗口 + 独立的 view**，避免“上过屏”污染下一个变体。每行都报：请求坐标、实际坐标、与显示器的重叠面积、`isVisible`、`capturePage`、CDP `Page.captureScreenshot`、CDP screencast 2 秒帧数、页面自身 rAF、以及 `hide()` 之后再拍一次。

| label | 位置 | 选项 | 回答 |
|---|---|---|---|
| `onscreen-control` | 主显示器内 (40,40) | — | 基线：确认脚本与机器正常 |
| `offscreen-product` | 所有显示器右侧 +20000 | `enableLargerThanScreen` | **Q1**（产品现状） |
| `offscreen-legacy` | 同上，但**不**设该标志 | — | 旧 `parked` 行是哪一种：看 `landed` 被拉回没有 |
| `edge-0px-tl/tr/bl/br` | 贴着主显示器四角、零共享像素 | `enableLargerThanScreen` | **Q2** |
| `corner-1px-tl/tr/bl/br` | 只有 1×1 像素落在显示器四角 | `enableLargerThanScreen` | **Q3** |
| 每行的 `capturePageAfterHide` | — | — | **Q4** |

跑法（仓库根目录）：

```bash
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/electron/spike/parking-surface.cjs
```

注意：

- 脚本自己写 `apps/electron/spike/parking-surface.log`（逐行 flush，卡住会停在最后一行），同时打印到 stdout。
- 有 180 秒看门狗；跑完自己退出，退出码 0 表示跑完。
- 全程 `showInactive()`，不抢焦点、不进任务栏；`onscreen-control` 会在屏幕上完整停留约 4 秒（唯一一扇会出现在桌面上的），其余都在屏外或只贴边。
- 一共 11 扇窗、每扇约 4 秒，串行。

## 判定表（结果 → 动作）

| 实测结果 | 动作 |
|---|---|
| **Q1 就有 surface**（`capturePage` 出图或 CDP 出图，且 screencast 有帧） | 「完全屏外没有 surface」不成立。回到产品日志查真实原因：停车窗那一刻是否被 `hide()`/`minimize()` 掉（看 `keepShowing` 的 warn）、是否首帧还没提交（等一帧再拍）、被观看的 view 是否被兄弟压住（`raiseParkedView`）。**代码不改** |
| **Q1 没有，Q2（0 像素贴边）有** | 最优解：停车窗贴着屏幕边界放。改三处：`offscreenSpot` 生成“边界相接”的坐标；`overlapsADisplay` 与 `keepOffEveryDisplay` 的判据从“有任何共享像素”改成“重叠**面积** > 0”；`parkingWindowFor` 的选项不变。数学上仍然没有像素上屏 |
| **Q1/Q2 都没有，Q3（1×1 像素）有** | 需要产品拍板：让停车窗的**一个像素**贴在屏幕角上。若接受 → `offscreenSpot` 改成“与最近显示器角 1×1 重叠”，`overlapsADisplay` 改成“重叠面积 > 1 px² 才算在屏上”，`keepOffEveryDisplay` 用新判据。若不接受 → 不动，走下一行 |
| **只有完整在屏内才有 surface** | 不做“上屏”。保留现状：首帧/CDP 取图 + 静帧泵（~1.4fps），并把这条结论回填到 [`browser-view-streaming.md`](./browser-view-streaming.md) §5.2.1 的代价一节 |
| **Q4 = 是**（`hide()` 之后仍能拍） | 若 Q1 无 surface 而 Q3 有，可以采用“**点亮一次**”：建停车窗时先放到 1×1 贴角处 `showInactive` → 等一帧 → 移回完全屏外，之后不再点亮。它只在建窗瞬间有 1 个像素可见，仍然需要产品拍板；实现落在 `parkingWindowFor`（建窗后的一次性步骤），`keepOffEveryDisplay` 保持“完全屏外” |
| **Q4 = 否** | surface 与“当前是否在显示器上”绑定。只能在 Q2/Q3 的位置常驻（若可用），否则维持 CDP + 静帧泵 |

两条硬约束，别在结论里放松：

1. **不允许把窗口放到用户桌面上**（哪怕一帧）——除非走“Q4 = 是 + 产品拍板”的那一条，并且只有 1 个像素、只一帧。
2. **不允许为了取图而阻塞**：`capturePage` 没有 surface 时**不 reject，而是永不 settle**（见 `captureWithinBound`）；CDP 在 Windows 的 hidden 上也会超时。所有取图都必须带时限。

## 交付物

1. 回填本文末的「结果」表（每行贴 `SPIKE_ROW` 的关键字段即可，不要求整段 JSON）。
2. 附上 `apps/electron/spike/parking-surface.log` 原文。
3. 按判定表写清 **Q1–Q5 的答案**，以及建议改哪几处（或“不改”）。
4. 不要改业务代码；也不要顺手改 `canCaptureHiddenWindows` / `tabHome` —— 先量，改什么由结果决定。

## 别做的事

- 不要为了让某一行“看起来对”而改脚本的判据（例如把 1px 变体挪进屏内、或给屏外变体去掉 `enableLargerThanScreen`）。
- 不要用 `show()` 代替 `showInactive()`。
- 不要覆盖或删除其它 spike 的 `.log`（它们是对照数据）。
- 不要把 `enableLargerThanScreen` 从产品代码里删掉——它是“窗口不被系统拉回显示器”的唯一依据，和本问题无关，只是让本问题可测。

## 结果（macOS 实测）

机器 / 版本：单显示器 1440×900 @2x（`id 1`，primary） / macOS 15.6.1（24G90）
Electron 版本（`node_modules/electron/package.json`）：39.2.7
跑的日期：2026-10-25，退出码 0，`SPIKE_DONE`

| label | landed | 重叠面积 | capturePage | CDP 截图 | screencast 帧/2s | rAF/700ms | hide 后能拍 |
|---|---|---|---|---|---|---|---|
| onscreen-control | 40,40（未动） | 558000（900×620） | answered 1800×1240 | 14062 B | 1 | 43 | 是 1800×1240 |
| offscreen-product | 21440,0（未动） | 0 | **refused: Current display surface not available for capture** | 14061 B | 1 | **0**（`frames` 停在 1） | 是 1800×1240 |
| offscreen-legacy | **1400,25（被系统拉回）** | 24800（40×620） | answered 1800×1240 | 14061 B | 1 | 42 | 是 1800×1240 |
| edge-0px-tl | -900,-620（未动） | 0 | **refused** | 14061 B | 1 | **0** | 是 1800×1240 |
| edge-0px-tr | 1440,-620（未动） | 0 | **refused** | 14061 B | 1 | **0** | 是 1800×1240 |
| edge-0px-bl | -900,900（未动） | 0 | **refused** | 14061 B | 1 | **0** | 是 1800×1240 |
| edge-0px-br | 1440,900（未动） | 0 | **refused** | 14061 B | 1 | **0** | 是 1800×1240 |
| corner-1px-tl | -899,-619（未动） | 1（1×1） | answered 1800×1240 | 14062 B | 1 | 42 | 是 1800×1240 |
| corner-1px-tr | 1439,-619（未动） | 1（1×1） | answered 1800×1240 | 14062 B | 1 | 42 | 是 1800×1240 |
| corner-1px-bl | -899,899（未动） | 1（1×1） | answered 1800×1240 | 14062 B | 1 | 42 | 是 1800×1240 |
| corner-1px-br | 1439,899（未动） | 1（1×1） | answered 1800×1240 | 14062 B | 1 | 43 | 是 1800×1240 |

`page.visibilityState` 与 rAF 完全同向：屏外 / 0 像素贴边的 5 行是 `hidden`、`frames` 停在 1；
屏内与所有 1×1 行是 `visible`、rAF 正常。

**Q1**：**没有。** 完全屏外（`enableLargerThanScreen`，landed 21440,0，重叠 0）`capturePage`
立刻 refuse `Current display surface not available for capture`，页面 `visibilityState=hidden`、
rAF 冻结（0 帧/700ms）。但 CDP `Page.captureScreenshot` 照样出图（14061 B）—— 两条是不同的 sink。

**Q2**：**没有。** 四个角的 0 像素贴边（`edge-0px-*`，重叠面积 0）与 Q1 表现完全一致：
全部 refuse + `hidden` + rAF 0。

**Q3**：**有。** 四个角各让 1×1 像素落进显示器（重叠面积 1），四行**全部** answered 1800×1240，
且页面 `visibilityState=visible`、rAF 42–43/700ms —— 不像"勉强能拍"，像完全正常的一扇窗。
判据是二值的：面积 0 → 无 surface，面积 1 → 有 surface。

**Q4**：**是，但这格不能当作"点亮一次"的依据。** 所有 11 行的 `capturePageAfterHide` 都是
answered，包括 Q1/Q2 里 `hide()` 之前刚被 refuse 的 5 行。行内顺序是
`capturePage → cdpScreenshot → screencast → hide() → capturePageAfterHide`，所以更省事的解释是
**同一行的 CDP 截图 / screencast 先把 surface 造出来了**，而不是 `show()` 把 surface 保留下来。
要判定"曾上屏就永久保留"，需要一次没有任何 CDP 介入的对照（见下面「还缺一格」）。

**Q5**：**带 `enableLargerThanScreen` 的一律没被挪**（10 扇全部 `movedByTheDesktop: false`，
包括请求 21440 的 `offscreen-product` —— 本机上并没有出现注释里说的"被限到 16383"）。
**不带的 `offscreen-legacy` 被拉了回来**：请求 21440,0，landed 1400,25，与主屏重叠 40×620。
这直接给旧 `parked` 行（`capturePage` 2800×1800、rAF 42）判了死刑 —— 它测的是**右侧露出 40 DIP**
的一扇窗，不是"屏外"。

**结论 / 建议改动**：

命中判定表第 3 行（Q1 无、Q2 无、Q3 有）：**数学上的"完全不上屏"和"有 display surface"在 macOS
上不可兼得，唯一的分界线是 1 个像素。** 两条可选路径，都需要产品拍板，本次**没有改业务代码**：

1. **常驻 1×1 贴角**（产品若接受）。改三处，都在
   [browser-pane-manager.ts](file:///Users/ryan/code/craft-agents-oss/apps/electron/src/main/browser-pane-manager.ts)：
   - `offscreenSpot`（L4484）返回"与最近显示器角 1×1 重叠"的坐标，而不是 `right + 20000`；
   - `overlapsADisplay`（L4506）的判据从"有任何共享像素"改成"重叠面积 > 1 px²"，
     否则新坐标会被自己判成"在屏上"而被 `keepOffEveryDisplay` 反复挪走；
   - `keepOffEveryDisplay`（L4525）用新判据（它只经 `overlapsADisplay`，实际不用单独改，
     但注释 L4505 "shares any pixel" 要跟着改）。
   - `parkingWindowFor`（L6366）的选项不动。

2. **点亮一次**（产品若只接受"一帧"）。建窗时先放 1×1 贴角 `showInactive` → 等一帧 → 移回完全
   屏外，之后不再点亮。实现落在 `parkingWindowFor` 建窗后的一次性步骤，`keepOffEveryDisplay`
   保持"完全屏外"。**但这条路的关键前提本次没测到**，见下。

产品若不接受任何一种 → 按判定表下一行：不做"上屏"，保留 CDP 取图 + 静帧泵（~1.4fps），
并把"完全屏外没有 surface，且 CDP 截图在屏外仍可用"这条回填到
[`browser-view-streaming.md`](./browser-view-streaming.md) §5.2.1 的代价一节。

## 两个测量上的坑（读表前先看）

1. **`screencastFrames` 这一列完全不分档**：11 行全是 1，连屏内的 `onscreen-control` 也是 1。
   页面是一整块纯色，CDP screencast 只在有变化时发帧，所以这列测的是"页面有没有变化"而
   不是"有没有 surface"。**不要用这一列下结论。**
2. **`capturePageAfterHide` 被 CDP 污染**（见 Q4）。同理，`capturePage` 那一列的 refuse
   发生在任何 CDP 调用之前，是干净的；`AfterHide` 不是。

## 还缺一格（若要选"点亮一次"必须先补）

现有变体都是"建窗即在某位置，此后不动"。**"先在 1×1 角上 `showInactive`，再移回完全屏外"之后
还有没有 surface**，一次都没测 —— 而这正是"点亮一次"的全部内容。补它只需一个变体：

```
corner-1px-tl → showInactive → sleep 一帧 → win.setBounds(完全屏外) → capturePage（全程不碰 CDP）
```

- answered → "点亮一次"成立，只花一帧 1 个像素。
- refused / `hidden` → surface 与"当前是否在显示器上"绑定，Q4 的"是"是假象，只能走常驻 1×1。

## 附：`apps/electron/spike/parking-surface.log` 原文

```
SPIKE_DISPLAYS [{"id":1,"bounds":{"x":0,"y":0,"width":1440,"height":900},"workArea":{"x":0,"y":25,"width":1440,"height":802},"scaleFactor":2,"primary":true}]
SPIKE_STEP 11:32:45.781 variant onscreen-control requested=40,40
SPIKE_STEP 11:32:45.936 load onscreen-control
SPIKE_ROW {"label":"onscreen-control","requested":{"x":40,"y":40},"landed":{"x":40,"y":40,"width":900,"height":620},"movedByTheDesktop":false,"sizeChanged":false,"overlap":{"area":558000,"displayId":1,"size":{"width":900,"height":620}},"visible":true,"page":{"innerWidth":900,"innerHeight":620,"visibility":"visible","hidden":false,"frames":43},"framesOver700ms":43,"capturePage":"answered 1800x1240","cdpScreenshot":"answered 14062 bytes","screencastFrames":1,"capturePageAfterHide":"answered 1800x1240","capturePageAfterShowAgain":"answered 1800x1240"}
SPIKE_STEP 11:32:50.584 variant offscreen-product requested=21440,0
SPIKE_STEP 11:32:50.599 load offscreen-product
SPIKE_ROW {"label":"offscreen-product","requested":{"x":21440,"y":0},"landed":{"x":21440,"y":0,"width":900,"height":620},"movedByTheDesktop":false,"sizeChanged":false,"overlap":{"area":0,"displayId":null,"size":{"width":0,"height":0}},"visible":true,"page":{"innerWidth":900,"innerHeight":620,"visibility":"hidden","hidden":true,"frames":1},"framesOver700ms":0,"capturePage":"refused: Current display surface not available for capture","cdpScreenshot":"answered 14061 bytes","screencastFrames":1,"capturePageAfterHide":"answered 1800x1240","capturePageAfterShowAgain":"answered 1800x1240"}
SPIKE_STEP 11:32:55.149 variant offscreen-legacy requested=21440,0
SPIKE_STEP 11:32:55.158 load offscreen-legacy
SPIKE_ROW {"label":"offscreen-legacy","requested":{"x":21440,"y":0},"landed":{"x":1400,"y":25,"width":900,"height":620},"movedByTheDesktop":true,"sizeChanged":false,"overlap":{"area":24800,"displayId":1,"size":{"width":40,"height":620}},"visible":true,"page":{"innerWidth":900,"innerHeight":620,"visibility":"visible","hidden":false,"frames":43},"framesOver700ms":42,"capturePage":"answered 1800x1240","cdpScreenshot":"answered 14061 bytes","screencastFrames":1,"capturePageAfterHide":"answered 1800x1240","capturePageAfterShowAgain":"answered 1800x1240"}
SPIKE_STEP 11:32:59.726 variant edge-0px-tl requested=-900,-620
SPIKE_STEP 11:32:59.740 load edge-0px-tl
SPIKE_ROW {"label":"edge-0px-tl","requested":{"x":-900,"y":-620},"landed":{"x":-900,"y":-620,"width":900,"height":620},"movedByTheDesktop":false,"sizeChanged":false,"overlap":{"area":0,"displayId":null,"size":{"width":0,"height":0}},"visible":true,"page":{"innerWidth":900,"innerHeight":620,"visibility":"hidden","hidden":true,"frames":1},"framesOver700ms":0,"capturePage":"refused: Current display surface not available for capture","cdpScreenshot":"answered 14061 bytes","screencastFrames":1,"capturePageAfterHide":"answered 1800x1240","capturePageAfterShowAgain":"answered 1800x1240"}
SPIKE_STEP 11:33:04.281 variant edge-0px-tr requested=1440,-620
SPIKE_STEP 11:33:04.294 load edge-0px-tr
SPIKE_ROW {"label":"edge-0px-tr","requested":{"x":1440,"y":-620},"landed":{"x":1440,"y":-620,"width":900,"height":620},"movedByTheDesktop":false,"sizeChanged":false,"overlap":{"area":0,"displayId":null,"size":{"width":0,"height":0}},"visible":true,"page":{"innerWidth":900,"innerHeight":620,"visibility":"hidden","hidden":true,"frames":1},"framesOver700ms":0,"capturePage":"refused: Current display surface not available for capture","cdpScreenshot":"answered 14061 bytes","screencastFrames":1,"capturePageAfterHide":"answered 1800x1240","capturePageAfterShowAgain":"answered 1800x1240"}
SPIKE_STEP 11:33:08.869 variant edge-0px-bl requested=-900,900
SPIKE_STEP 11:33:08.882 load edge-0px-bl
SPIKE_ROW {"label":"edge-0px-bl","requested":{"x":-900,"y":900},"landed":{"x":-900,"y":900,"width":900,"height":620},"movedByTheDesktop":false,"sizeChanged":false,"overlap":{"area":0,"displayId":null,"size":{"width":0,"height":0}},"visible":true,"page":{"innerWidth":900,"innerHeight":620,"visibility":"hidden","hidden":true,"frames":1},"framesOver700ms":0,"capturePage":"refused: Current display surface not available for capture","cdpScreenshot":"answered 14061 bytes","screencastFrames":1,"capturePageAfterHide":"answered 1800x1240","capturePageAfterShowAgain":"answered 1800x1240"}
SPIKE_STEP 11:33:13.440 variant edge-0px-br requested=1440,900
SPIKE_STEP 11:33:13.453 load edge-0px-br
SPIKE_ROW {"label":"edge-0px-br","requested":{"x":1440,"y":900},"landed":{"x":1440,"y":900,"width":900,"height":620},"movedByTheDesktop":false,"sizeChanged":false,"overlap":{"area":0,"displayId":null,"size":{"width":0,"height":0}},"visible":true,"page":{"innerWidth":900,"innerHeight":620,"visibility":"hidden","hidden":true,"frames":1},"framesOver700ms":0,"capturePage":"refused: Current display surface not available for capture","cdpScreenshot":"answered 14061 bytes","screencastFrames":1,"capturePageAfterHide":"answered 1800x1240","capturePageAfterShowAgain":"answered 1800x1240"}
SPIKE_STEP 11:33:18.018 variant corner-1px-tl requested=-899,-619
SPIKE_STEP 11:33:18.027 load corner-1px-tl
SPIKE_ROW {"label":"corner-1px-tl","requested":{"x":-899,"y":-619},"landed":{"x":-899,"y":-619,"width":900,"height":620},"movedByTheDesktop":false,"sizeChanged":false,"overlap":{"area":1,"displayId":1,"size":{"width":1,"height":1}},"visible":true,"page":{"innerWidth":900,"innerHeight":620,"visibility":"visible","hidden":false,"frames":44},"framesOver700ms":42,"capturePage":"answered 1800x1240","cdpScreenshot":"answered 14062 bytes","screencastFrames":1,"capturePageAfterHide":"answered 1800x1240","capturePageAfterShowAgain":"answered 1800x1240"}
SPIKE_STEP 11:33:22.597 variant corner-1px-tr requested=1439,-619
SPIKE_STEP 11:33:22.605 load corner-1px-tr
SPIKE_ROW {"label":"corner-1px-tr","requested":{"x":1439,"y":-619},"landed":{"x":1439,"y":-619,"width":900,"height":620},"movedByTheDesktop":false,"sizeChanged":false,"overlap":{"area":1,"displayId":1,"size":{"width":1,"height":1}},"visible":true,"page":{"innerWidth":900,"innerHeight":620,"visibility":"visible","hidden":false,"frames":44},"framesOver700ms":42,"capturePage":"answered 1800x1240","cdpScreenshot":"answered 14062 bytes","screencastFrames":1,"capturePageAfterHide":"answered 1800x1240","capturePageAfterShowAgain":"answered 1800x1240"}
SPIKE_STEP 11:33:27.179 variant corner-1px-bl requested=-899,899
SPIKE_STEP 11:33:27.189 load corner-1px-bl
SPIKE_ROW {"label":"corner-1px-bl","requested":{"x":-899,"y":899},"landed":{"x":-899,"y":899,"width":900,"height":620},"movedByTheDesktop":false,"sizeChanged":false,"overlap":{"area":1,"displayId":1,"size":{"width":1,"height":1}},"visible":true,"page":{"innerWidth":900,"innerHeight":620,"visibility":"visible","hidden":false,"frames":43},"framesOver700ms":42,"capturePage":"answered 1800x1240","cdpScreenshot":"answered 14062 bytes","screencastFrames":1,"capturePageAfterHide":"answered 1800x1240","capturePageAfterShowAgain":"answered 1800x1240"}
SPIKE_STEP 11:33:31.748 variant corner-1px-br requested=1439,899
SPIKE_STEP 11:33:31.758 load corner-1px-br
SPIKE_ROW {"label":"corner-1px-br","requested":{"x":1439,"y":899},"landed":{"x":1439,"y":899,"width":900,"height":620},"movedByTheDesktop":false,"sizeChanged":false,"overlap":{"area":1,"displayId":1,"size":{"width":1,"height":1}},"visible":true,"page":{"innerWidth":900,"innerHeight":620,"visibility":"visible","hidden":false,"frames":43},"framesOver700ms":43,"capturePage":"answered 1800x1240","cdpScreenshot":"answered 14062 bytes","screencastFrames":1,"capturePageAfterHide":"answered 1800x1240","capturePageAfterShowAgain":"answered 1800x1240"}
SPIKE_DONE
```

## 第二轮：`moveTop()` 是那个开关（本文判定表的结论被推翻）

第一轮的量法缺了一个动作：**窗口被 `moveTop()` 过一次**。补上它之后，"完全屏外就没有 surface"不成立。

触发这次复查的是应用自己日志里一条真实截图：

```
[browser-pane] screenshot capture state instance=browser-1 tab=tab-1 mode=raw
  home=parking hasBeenShown=false isVisible=false windowVisible=false windowMinimized=false
[browser-pane] screenshot capture ok instance=browser-1 tab=tab-1 mode=raw arm=in-place attempt=1 size=1100x845
```

没上过屏、窗口不可见、住在停车窗里，第一次尝试就出图。隔离实验
（[`agent-first-shot.cjs`](../apps/electron/spike/agent-first-shot.cjs)）——同一扇窗、同一个 view，相隔 16ms，只差一个 `moveTop()`：

| 时刻 | 页面 | capturePage | screencast |
|---|---|---|---|
| `showInactive()` + view 移入，未 order | `hidden`，rAF 冻结（frames 1） | **0×0（空图）** | — |
| `parking.moveTop()` | **`visible`**，rAF 恢复 | **2200×1690** | **119 帧/2s** |

所以：

- **Q1 改判为「有」。** 完全屏外的停车窗有 display surface，前提是它被 order 到最前过一次；
  `showInactive()` 单独不够 —— 窗口"显示"了但从未 order front，Chromium 仍当它不可见。
- **Q3 的 1×1 贴角、判定表里的"点亮一次"都不需要。** 一个像素都不用上屏。
- **agent 截图一直没问题，是因为它本来就一直在做这件事**：`capturePageWithRecovery` 第一步就是
  `raiseParkedView`，里面除了 `addChildView` 还有 `parking.moveTop()`。
- **远程 viewer 黑屏，是因为它没做**：`startViewCapture` 直接 `Page.startScreencast`，
  窗口没被 order → 页面 `hidden` → rAF 冻结 → 最多一帧；静帧泵又被 `liveFrames > 0` 关掉。

另一条同效的"点亮"方式是 CDP `Page.captureScreenshot`（第一轮测到的就是它），它是另一种强制合成；
`moveTop()` 更便宜。两者都是 **per-view** 的：同一扇已点亮的窗里新加一个 view，它仍然要先被
`addChildView` + `moveTop` 一次。

已按这条结论改动（业务代码）：

- `startViewCapture`：在 `startScreencast` 之前，`tabHome === 'parking'` 时 `raiseParkedView`；
- `startRecordingForSession`：同样一处，会话录制的 screencast 之前；
- `pumpViewStill` → **`checkViewHealth`**：改成一个常驻的健康检查，而不是"停掉就再也没人看"的静帧泵。
  每 700ms 一拍：有帧 → 什么都不做；静默超过 1.5s 且页面已被合成 → 静态页面，也不做；
  静默且页面**未**被合成 → `raiseParkedView` + 一张 CDP 静帧。原来的实现里，一旦"合成过"就永久停泵，
  于是**导航把合成打掉之后没有任何东西会发现** —— 这正是"导航后没有画面、把 hub 的窗口放上屏就有了"
  的原因：`did-navigate` 那次 raise 发生在提交瞬间，新 renderer 可能还没建出来。
  现在即使 raise 无效，静帧本身也是 CDP 截图（另一种强制合成），下一拍页面就会变成 `visible`。

  实机验证（导航到 baidu 的那一次）：

  ```
  14:01:01.044  raised the parked view after a commit          ← 提交瞬间的 raise，单独没有用
  14:01:01.503  view health check reordered … quiet=9096ms     ← 0.46s 后健康检查接管
  14:01:01.568  view capture resumed … quiet=9161ms frames=2   ← 65ms 后帧回来
  ```

  `quiet=9096ms` 不是恢复耗时：那是一个静态页面自己 9 秒没有重绘（每次都因"静默但已合成"而放过），
  真正的恢复是从提交到 `resumed` 的 **0.52s**。之前的表现是"永远不回来，除非把 hub 的窗口放上屏"。
- `did-navigate`：每次主框架提交后，home 是停车窗的 tab 再 `raiseParkedView` 一次。
  **一次导航提交会丢合成** —— 实测同一扇窗，导航前后：`visible` / 2200×1690 / 120 帧每 2s →
  `hidden` / 0×0 / 无帧 → `moveTop` 后又是 `visible` / 2200×1690 / 120 帧。这解释了
  "地址栏回车后没有画面、新建标签页再切回来就有"：切 tab 走的正是 `raiseParkedView`。
  Windows 不需要这一步，因为它没有这个 ordering 状态。
- `parkTab`：`addChildView` 之后补 `parking.moveTop()`。让"被 park ⇒ 被合成"变成结构事实，
  而不是靠每个取图调用者记得先 raise。**停车窗不止一个**（每个浏览器窗口一个，`offscreenSpot`
  对同尺寸给出同一个点，所以它们完全重叠），"这个 view 在最上层"只有在它那扇窗是最上层窗口时
  才成立，这一步就是那个前提。
- `keepShowing`：停车窗被最小化/隐藏后回来时，`restore()` + `showInactive()` 之外再 `moveTop()`。
  回来 ≠ 重新被合成。只在真的回来过时才 order —— 每次显示变化都 order 会让它无谓地压住别的
  停车窗。
- `startRecordingForSession` → **`checkRecordingHealth`**：同一个健康检查也覆盖录制。录制也是一条
  screencast，导航后同样静默，而它没有 viewer 那条静帧兜底（输出是视频，没有"补一张静帧"这回事）。
  所以静默且未合成时：`raiseParkedView` + `page.invalidate()`（order 恢复合成，invalidate 逼一帧
  让录制重新有帧可写）。它随 `finished` 一起结束。

那个 `tabHome === 'parking'` 的判断不能省：`raiseParkedView` 会无条件 `addChildView`，
否则会把一扇正在人眼前窗口里的 tab 拽进停车窗。
