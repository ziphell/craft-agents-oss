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

## 结果（macOS 实测，待填）

机器 / 版本：`________` / `________`（macOS 版本）
Electron 版本（`node_modules/electron/package.json`）：`________`
跑的日期：`________`

| label | landed | 重叠面积 | capturePage | CDP 截图 | screencast 帧/2s | rAF/700ms | hide 后能拍 |
|---|---|---|---|---|---|---|---|
| onscreen-control | | | | | | | |
| offscreen-product | | | | | | | |
| offscreen-legacy | | | | | | | |
| edge-0px-tl | | | | | | | |
| edge-0px-tr | | | | | | | |
| edge-0px-bl | | | | | | | |
| edge-0px-br | | | | | | | |
| corner-1px-tl | | | | | | | |
| corner-1px-tr | | | | | | | |
| corner-1px-bl | | | | | | | |
| corner-1px-br | | | | | | | |

**Q1**：`________`
**Q2**：`________`
**Q3**：`________`
**Q4**：`________`
**Q5**：`________`

**结论 / 建议改动**：`________`
