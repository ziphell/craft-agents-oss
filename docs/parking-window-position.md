# 停车窗位置：页面能读到什么，以及怎么让它读起来正常

> 写于 2026-10-28，Windows 11 / Electron 39.2.7（Chrome 142）/ **RDP 会话** / 单屏 1440×960 @ scaleFactor 2。
> 目的：把这轮实测的结论、证据、脚本和一个 **macOS 待验证清单** 交给下一台机器。
> 到 Mac 后直接跳到 [§6 验证清单](#6-macos-待验证清单按顺序跑)。

**配套文档**

| 文档 | 管什么 |
|---|---|
| 本文 | 页面读到的**几何**（`screenX` / `event.screenX` / `avail*`），以及三种摆法的取舍 |
| [parking-window-position-plan.md](./parking-window-position-plan.md) | 待评估的**改动方案**（B 倾向 / C 备选）与验收标准 |
| [parking-surface-macos-handoff.md](./parking-surface-macos-handoff.md) | **屏外窗口在 macOS 上有没有 display surface**（Q1–Q5，含边缘相接、1×1 像素的实测清单） |
| [macos-capture-verification.md](./macos-capture-verification.md) | 更早的 macOS capture 路径实测 |

本文的 M2/M3 与 `parking-surface-macos-handoff.md` 的 Q1 是同一个问题的两个方向：那边问“**屏外**有没有 surface”，这边问“**屏内但 alpha=0** 有没有、会不会被判 occluded”。两个都量完，才能决定 macOS 上走哪条路。

---

## 1. 为什么动停车窗

内嵌浏览器的"停车窗"是 agent 在后台跑的标签页所住的窗口。它有三条硬约束：

| # | 约束 | 说明 |
|---|---|---|
| A | **不可见** | 视口变化、用户新增/拔掉显示器、改 DPI 缩放，都不能让它露在用户可见区域 |
| B | **出帧** | `webContents.capturePage`、CDP `Page.captureScreenshot`、screencast 都必须正常（后台上网的页面要能截图/直播） |
| C | **数字合理** | 页面能读到的窗口几何不该是"程序化"的样子 |

页面**不需要任何技巧**就能读到这些（都是标准 API）：

```js
window.screenX / window.screenLeft / window.screenY   // 窗口在虚拟桌面的位置
screen.availLeft / screen.availWidth / screen.availHeight
window.outerWidth / window.innerWidth
document.visibilityState / document.hasFocus()
// 以及每次鼠标事件自带的
event.screenX / event.screenY
```

`window.screenX` 与 `event.screenX` **同源**（都来自 widget 的屏幕矩形），这条关系是后面所有判断的基础。

### 当前实现（改动前）

- `OFFSCREEN_PARK_MARGIN = 20_000`（`browser-pane-manager.ts`），即请求 `workArea.right + 20_000`
- Windows 的窗口坐标上限是 16 位 → **被静默钳到 16383**
- 代码注释里已经记录了这件事（"20_000, 100_000 and 1_000_000 all came back as **16_383** DIPs"），但只当作"够远"的证明，没有考虑页面会读到这个数
- 停车窗在 `hideFromWindowLists()` 里 `setAlwaysOnTop(true,'floating')`，并在 `raiseParkedView()` 里 `moveTop()` → **它本来就在所有普通窗口之上**

---

## 2. Windows 实测数据

### 2.1 几何：三种摆放方式

| 摆放 | `window.screenX` | `event.screenX`（clientX=120/240） | `screen.avail` | 自洽 |
|---|---|---|---|---|
| 现状：`right + 20000`（被钳） | **16383** | 16503 / 16623 | 1440×912 | ✅ 自洽 |
| 负坐标 `left - w - 40` | **-1140** | -1020 | 1440×912 | ✅ 自洽 |
| 屏内 `(8,8)` + opacity 0 | **8** | 8+clientX | 1440×912 | ✅ 自洽 |
| CDP `Emulation.setDeviceMetricsOverride({positionX:137,positionY:41})` | **137** | **16623（不跟随）** | **1440×960（`avail==screen`）** | ❌ 矛盾 |

结论：
- **`window.screenX` 与 `event.screenX` 只能一起变**（移动窗口），**不能只改一个**（CDP override 只改前者），改一个就自相矛盾。
- `setDeviceMetricsOverride` 的副作用：`screen.availHeight` 变成等于 `screen.height`（露"没有任务栏的桌面"），`clearDeviceMetricsOverride` 后立刻回退到 16383。
- 负坐标**不会被钳**（Windows 只钳 0..16383 那侧），所以 `-1140` 能原样保留。

### 2.2 出帧与截图（关键）

同一窗口、同一视口，只在上面盖不透明窗口：

| 状态 | rAF / 400ms | `visibilityState` | `wc.capturePage()` 字节 |
|---|---|---|---|
| 未覆盖 | 13 | visible | 452657 |
| 被完全覆盖 | **14** | visible | **452657** |
| 再叠一层更大的 | **13** | visible | **452657** |
| 覆盖撤掉 | 13 | visible | 452657 |

- 上面是 `disable-features=CalculateNativeWinOcclusion` 打开时的结果；**关掉该开关（`--allow-occ`）结果完全一样**，所以在这台机器上遮挡计算没有影响出帧。
- `opacity` 0 与 1 的结果逐字节相同 → **透明不影响出帧/截图**。
- ⚠️ 这台是 RDP/软件合成，遮挡判定可能根本没跑。仓库里有相反的真实观测（`browser-pane-manager.ts:3205`）："shown but never ordered … before `moveTop()` the page is `hidden`, rAF is frozen and `capturePage` answers 0×0"。**好消息是那个问题已经被现成的 `moveTop()` + `setAlwaysOnTop` 解决**，停车窗在顶层，不可能被遮挡。
- `win.capturePage()`（窗口级）在所有情况下都是 0×0 —— 内容在子 `WebContentsView` 里，**这是既有行为，不是回归**。要用 `webContents.capturePage()`。

### 2.3 点击穿透（真实系统点击，不是 CDP 合成事件）

用 PowerShell `SetCursorPos` + `mouse_event`（先 `SetProcessDpiAwareness(2)` 校准：发物理 1120,1020 → Electron 读到 DIP 559,509）。两个窗口完全重叠，上面的透明、下面的可点。

| 设置 | 下面窗口收到 | 透明窗口收到 |
|---|---|---|
| 无可点窗口时的基线 | down 1 / up 1 ✅ | — |
| 透明窗 `opacity:0`，**不设** `setIgnoreMouseEvents` | 🚫 0 / 0 / move 0 | ⚠️ **down 1 / up 1 / move 17** |
| 透明窗 + `setIgnoreMouseEvents(true)` | ✅ **down 1 / up 1 / move 3** | 0 / 0 / 0 |
| 只移动，不设 ignore | 0 | ⚠️ move 2 |
| 只移动，设了 ignore | ✅ move 5 | 0 |

**结论：`opacity: 0` 不穿透，必须 `setIgnoreMouseEvents(true)`。**

文档补充（`electron.d.ts`）："All mouse events happened in this window will be passed to the window below this window, **but if this window has focus, it will still receive keyboard events**" → 必须配 `focusable: false` + `showInactive()`，并且 **`show()` 之后要重设** `setIgnoreMouseEvents(true)`。

### 2.4 窗口样式位（PowerShell `GetWindowLong`）

`opacity 0` + `focusable:false` + `skipTaskbar:true` + `alwaysOnTop floating` + `ignoreMouseEvents`：

```
WS_EX_TRANSPARENT = true   (0x20)      穿透
WS_EX_LAYERED     = true   (0x80000)   opacity 的代价
WS_EX_TOPMOST     = true   (0x08)      置顶
WS_EX_NOACTIVATE  = true   (0x8000000) 不抢焦点
WS_EX_TOOLWINDOW  = false            ← skipTaskbar 不会置这一位
hasOwner          = false
```

`EnumWindows` 枚举当前可见顶层窗口时，**停车窗在列表里**（`hwnd|WS_EX|title`，title 为空）。也就是说它可能出现在"屏幕共享 → 选择窗口"的列表里，以及 Alt-Tab/任务视图（`NOACTIVATE` 通常会被跳过，但**未验证**）。

> 这条不是"顶层方案"特有：离屏停车窗同样是一个可见顶层窗口，一样会被枚举到。

### 2.5 主屏 + 置顶 + 透明（最终候选）

窗口摆在 `workArea` 中心，压在一个"用户窗口"上面：

| 项 | 读数 |
|---|---|
| `screenX` | 270（workArea 内，完全合法） |
| 出帧 | rAF 13 / 400ms，`visibility: visible`，capture 48590 B |
| 抢焦点 | raise 之后用户窗口仍 `isFocused: true`，`getFocusedWindow: "USER-WINDOW"`，parking `isFocused: false` |
| 命中测试 | `WindowFromPoint(屏幕中心)` 返回的是**用户窗口的子窗口**，不是 parking |
| 真实点击 | 用户窗口 down 1 / up 1 / move 11；parking 0 / 0 / 0 |

---

## 3. 结论

1. **透明 ≠ 穿透**。要穿透必须 `setIgnoreMouseEvents(true)`；要它别抢键盘必须 `focusable:false` + `showInactive()`。
2. **透明 ≠ 停帧**。`opacity 0` 的 `capturePage`、`Page.captureScreenshot` 与不透明逐字节一致；遮挡在本机也不停帧；而且停车窗本来就在 `floating` 层，不会被遮挡。
3. **`16383` 是钳位产物，不是设计意图**。代码里写的 20000 根本表达不出来 —— 这个常数在"说谎"。
4. **`window.screenX` 与 `event.screenX` 同源**，所以：
   - 移动窗口 → 两者一起变，永远自洽；
   - CDP override → 只改前者，**制造矛盾**（16623 vs 137），不推荐；
   - JS 补丁 → 能补齐，但 `getter.toString()` 会暴露（Electron 里 `window.screenX` 本来就是 own property，形状能藏，toString 藏不住）。
5. **推荐方案：主屏 `workArea` 内 + `opacity: 0` + `alwaysOnTop('floating')` + `ignoreMouseEvents`**。
   - 数字完美（`screenX` 在屏内），不依赖任何几何假设；
   - 视口变化 / 新显示器 / DPI 变化都**不需要重算**（不可见与位置无关）；
   - `offscreenSpot()` / `keepOffEveryDisplay()` 可以退休，只留给 Linux 回退。
   - 备选（若不接受"窗口在屏内"）：小边距离屏（`right + 48` → `screenX = 1488`）+ 透明兜底。

---

## 4. 讨论过的其他选项（结论）

| 选项 | 结论 |
|---|---|
| 离屏 + 大边距（现状 16383） | 数字不可解释（比屏宽大 14943px）；且常数与实际不符 |
| 离屏 + 小边距（±48） | 数字可解释（像"被拖出边缘"）；但新显示器最容易正好占这个位置，追上时会露出不透明窗口，需要透明兜底 |
| 负坐标（-1140） | 自洽、不被钳；但仍是屏外，"没有一块在负侧的屏" |
| CDP `setDeviceMetricsOverride` | 改得到 `window.screenX`（137），改不到 `event.screenX`，且 `avail==screen` → 更假 |
| JS 补丁 `Window.prototype.screenX` | 描述符形状能藏（own property 补丁前后都是 true），但 `get.toString()` 暴露 |
| OSR（`offscreen: true`） | `screen` 变成 `[0,0]`，明显无头，弃 |
| `parent:` 换 Alt-Tab 隐藏 | ❌ owner 最小化会连坐隐藏子窗 → 后台标签页停帧 |

---

## 5. 代码位置与计划改动

**目前应用代码未改动**。只在 `apps/electron/spike/` 新增了一个 demo：

- `apps/electron/spike/topmost-transparent-window.cjs`
  - `--show`：用 0.55 不透明度亮出来 6 秒（人工确认它存在、且点得到下面的窗口）
  - `--keep`：常驻，Ctrl+C 结束
  - 默认：量完即退，读数写到 `topmost-transparent-window.report.<platform>.json`（`win32` / `darwin`，两台机器不再互相覆盖）

计划改动（**B 与 C 均已实施**，2026-10-28；C 是默认，B 是回退）—— 详见 **[parking-window-position-plan.md](./parking-window-position-plan.md)**：

- 方案 **C（现已默认）**：主屏 `workArea` + `opacity 0` + `alwaysOnTop` + `ignoreMouseEvents` + `focusable:false`；读回 `getOpacity() !== 0` 的平台走 B。
- 方案 **B（现为回退）**：边距 `20_000` → `48`、候选顺序改为 下→上→左→右、`keepOffEveryDisplay` 保持屏外。
- 方案 **A（旧现状）**：数字 `16383` 不可解释，不再使用。

决策门与验收标准都在计划文档 §6–§7。

---

## 6. macOS 待验证清单（按顺序跑）

> 全部命令在仓库根目录执行，Electron 用 `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`。
> 建议先把 demo 跑一遍：`.../Electron apps/electron/spike/topmost-transparent-window.cjs --show`，肉眼看一次再进清单。

| # | 要验证的 | 命令 / 做法 | 期望 | 失败意味着 |
|---|---|---|---|---|
| M1 | `setOpacity(0)` 是否生效（读回） | 默认跑 demo，看 `transparent.actual` | `0`，且 `opacityWorks: true` | 若不生效 → macOS 也要走离屏回退 |
| M2 | alpha=0 是否仍出帧 | 看 `state.rafTicksIn400ms` 与 `capture.size/bytes` | rAF ≥ 8/400ms，capture 非空（900×640@2x → 1800×1280） | 若 rAF=0 → 透明方案在 macOS 不成立 |
| M3 | 是否被判为 occluded | 再跑一次，外面盖一个全屏不透明窗口（Finder/终端全屏），看 `visibility` 与 rAF | `visible`，rAF 不停 | 若变 `hidden` → 必须保留 `disable-features` 或改用离屏 |
| M4 | 切到别的 Space / 全屏 App | `Ctrl+→` 切桌面后再读 | rAF 继续 | 若停帧 → 需要 `setVisibleOnAllWorkspaces` 或回退 |
| M5 | Mission Control 是否露出 | `Ctrl+↑` | 看不到它（`setHiddenInMissionControl(true)` 生效） | 若露出 → 该 API 未生效，需另找办法 |
| M6 | 点击是否穿透 | **需要真实点击**：`osascript -e 'tell application "System Events" to click at {x, y}'`（要授予"辅助功能"权限）；或装 `cliclick`；或人工点 | 下面窗口收到点击，demo 窗口收不到 | 若被吞 → `setIgnoreMouseEvents` 在 macOS 未生效 |
| M7 | 是否抢焦点 | 跑 `--show` 前先聚焦终端，跑完看焦点 | 焦点仍在终端 | `focusable:false`/`showInactive` 未生效 |
| M8 | Retina/多显示器下的几何 | 接上外接屏后看 `screenX/outer/inner/avail` | `screenX` 在 `availLeft..availLeft+availWidth` 内；`outer` 与 `inner` 都按 DIP | 若 `screenX` 为物理像素 → 我们的假设在 macOS 不成立 |
| M9 | Dock / 程序坞条目 | 看 Dock | 无图标 | — |
| M10 | `webContents.capturePage` 与 CDP 截图 | demo 里两个都有 | 都不为空 | — |

**记录方式**：每台机器跑完各写自己的 `apps/electron/spike/topmost-transparent-window.report.<platform>.json`，两份读数可以直接逐项对比。

### 已知的 macOS 差异（来自 `electron.d.ts` 39.2.7，未实测）

| API | 平台标注 |
|---|---|
| `setOpacity(n)` | `win32, darwin` — "On Linux, does nothing" |
| `setIgnoreMouseEvents(ignore, {forward})` | 无平台限制；`forward` 标注 `darwin, win32` |
| `setHiddenInMissionControl(hidden)` | `darwin` |
| `focusable` / `hasShadow` | macOS + Windows |

### 6.1 macOS 实测结果（2026-10-28）

> 机器：Apple M1 / macOS 15.6.1 (24G90) / Electron 39.2.7 / **单屏 1440×900 @2x**，`workArea` = `0,25,1440,802`。
> 脚本：`topmost-transparent-window.cjs`（demo 原样）＋ 新加的 `parking-onscreen-macos.cjs`（补 M3 / M6 与几组对照）。
> 读数：`topmost-transparent-window.report.darwin.json`、`parking-onscreen-macos.report.json`；`agent-first-shot.cjs` 也重跑了一次。

| # | 结果 | 读数 |
|---|---|---|
| M1 | ✅ | `getOpacity()` 读回 `0`，`opacityWorks: true` |
| M2 | ✅ | rAF **24–25 / 400ms**；`capturePage` **1800×1280 / 411677 B** |
| M3 | ✅ | 盖一扇 `screen-saver` 层级、铺满 `workArea` 的不透明窗：`visibility` 仍 `visible`，rAF 24–25，截图**逐字节相同** |
| M4 | ⬜ 未测 | 需要真的切 Space |
| M5 | ⬜ 未测 | 需要肉眼；注意**产品目前没有调 `setHiddenInMissionControl`**，只有 demo 调了 |
| M6 | ✅ | 真实人手点击，`top(down/up) = 0/0`、`bottom = 3/3`：点击**真的穿过去了**。做法与两条前提见下 |
| M7 | ✅ | `isFocused: false`，`BrowserWindow.getFocusedWindow()` 为 `null` |
| M8 | ✅ | `screenX/Y = 120/105`（DIP，= 窗口位置）、`inner = outer = 900×640`、`avail = 1440×802`、`dpr = 2` |
| M9 | ⬜ 未核对 | `skipTaskbar: true` 已设，Dock 里没看到图标（未逐项核对） |
| M10 | ✅ | `capturePage` 非空；screencast 见 `agent-first-shot`：**119 帧 / 2s** |

**M6 是怎么量的**（`parking-click-through-macos.cjs`，需要人点一次）：两扇窗完全重叠，下面一扇普通窗、
上面一扇与停车窗同配置（`opacity 0.55` + `alwaysOnTop floating` + `focusable:false` + `setIgnoreMouseEvents(true)`），
两边都数 `mousedown`。人点紫色区域，读数：上面 `down 0 / up 0`、下面 `down 3 / up 3` → 穿透。

两条前提，都是这轮踩出来的（**改的是测试，不是结论**）：

1. 这个 demo 应用必须是**活动应用**（`app.focus({steal:true})` + `bottom.focus()`）。否则普通层级的下面那扇窗排在终端后面，
   点击确实穿过了透明窗，但落进的是终端 —— 计数窗收不到，看起来像"没穿透"。第一轮 `down` 全是 0 就是这个原因。
2. 下面那扇窗要 `acceptFirstMouse: true`。macOS 默认把"点一扇没有焦点的窗"的第一次按下只用于**激活**它，不送进页面。

**注意一个 macOS 特有的细节**：`setIgnoreMouseEvents(true)` 只让**点击**过去，`mousemove` 仍然会送进那扇透明窗的页面
（这一轮上面那扇记到了 142 次 move，而 down/up 是 0）。对一个 `opacity: 0` 的停车窗没有视觉后果，但意味着页面能读到自己被悬停过 ——
如果以后要防"页面自己发现有人在上面动鼠标"，这条要单独量。

补充的三组（`parking-onscreen-macos.cjs`）：

| 场景 | 读数 | 说明 |
|---|---|---|
| B 普通层级窗口去盖它 | `visibility` 仍 `visible`，rAF 24，截图不变 | `floating` 压过 `normal`，**用户窗口根本盖不住它** |
| E 屏内透明窗**导航后不补 `moveTop`** | `visible`，rAF 24，截图变了（`414706 B`，说明确实是新文档） | 屏外方案在这种情况下会掉到 `hidden` / `0×0` |
| D 现状（屏外 `right + 20000` + `moveTop`） | `screenX = 21440`、`screenY = 0`、`outer = 900×640` | macOS **不钳位**，页面直接读到 21440 —— 比 Windows 的 16383 更"程序化"（没有任何真实桌面对应这个数）。按方案 B 改成 `bottom + 48` 之后是 `screenX = 0`、`screenY = 948`，同样出帧（见计划文档 §10） |

D 组还暴露了一条值得记住的次序：**屏外窗口光 `moveTop()` 不够**。同一扇窗，在 `moveTop()` 之前先做一次 CDP `attach` + `Runtime.evaluate`，页面才从 `hidden/0×0` 变成 `visible/1800×1280`；没有那一步时 `moveTop()` 之后仍是 `hidden`、`capturePage` 报 `Current display surface not available for capture`。
这和 `agent-first-shot.cjs` 的读法一致（它在那一步之前也 attach 了 debugger），也和产品 `capturePageWithRecovery` 先走 `getViewportMetrics` 的顺序一致 —— 但意味着"屏外有 surface"依赖的是一次**叫醒**，不是一次 `moveTop`。

**对方案 C 的判断（macOS）**：M1/M2/M3/M6/M7/M8/M10 全过，屏内透明窗在这台机器上是"完全正常的一扇窗"——被更高层级的窗口整块盖住也不停帧，
导航后不补 `moveTop` 也不掉合成，点击真的穿到下面的窗口，`screenX` 在 `workArea` 内、`inner == outer`。
C 在 macOS 上**没有挡路的技术问题**，剩下的都是"新的可见性代价"：M4/M5/M9（Space / Mission Control / Dock 里露不露）。
真实风险从"出不了图"换成了"用户在某个系统界面里看见一个空窗口"，以及产品现在**没有** `focusable:false` / `setIgnoreMouseEvents` / `setHiddenInMissionControl`，
这三个都要在 C 里新加。

---

## 7. 仍未确认的事（不要当成结论）

1. **Windows：Alt+Tab / 任务视图 / 屏幕共享选择器**里是否露出空白条目 —— `WS_EX_TOOLWINDOW` 未置位，`NOACTIVATE` 一般会被跳过，但**没验证**。需要人工按一次 Alt+Tab、开一次 Zoom/Teams 的"共享窗口"看一眼。
2. **Windows：真机（非 RDP）** 的遮挡行为是否与本文一致。本文的遮挡读数全部来自 RDP 会话。
3. **macOS：第 6 节全部**。
4. **`hasFocus`**：屏内停车窗在 Windows 上是 `false`（正常）；若产品需要页面认为自己"聚焦"，仍走 `Emulation.setFocusEmulationEnabled`（实测开了之后 `hasFocus` 变 `true`）。

---

## 8. 脚本与数据清单

全部在 `apps/electron/spike/`（都是临时脚本，不属于应用；`.report.json` 就是本文表格里的原始读数）：

| 脚本 | 报告 | 内容 |
|---|---|---|
| `parking-screenxy.cjs` | `parking-screenxy.report.json` | 三种摆法 + CDP override + 负坐标 + OSR + JS 补丁 |
| `parking-screenxy-override.cjs` | `parking-screenxy-override.report.json` | override 的变体与一致性（`event.screenX` 不跟随、`avail==screen`、清除即回退） |
| `parking-occlusion.cjs`（`--allow-occ` 为对照） | `parking-occlusion.report.json` / `parking-occlusion-allow.report.json` | 遮挡是否停帧 |
| `parking-input-passthrough.cjs` | `parking-input-passthrough.report.json` | 真实系统点击的穿透测试（含 DPI 校准） |
| `parking-topmost-onscreen.cjs` | `parking-topmost-onscreen.report.json` | 主屏 + 置顶 + 透明的聚焦 / 命中 / 窗口枚举 |
| `topmost-transparent-window.cjs` | `topmost-transparent-window.report.<platform>.json` | 本文的主 demo（`--show` / `--through` / `--keep`） |
| `parking-onscreen-macos.cjs` | `parking-onscreen-macos.report.json` | macOS 补充：更高层级遮挡 / 普通层级盖不住 / 真实点击穿透 / 屏外对照 / 导航后不补 `moveTop` |
| `parking-click-through-macos.cjs` | 控制台 `M6_RESULT` / `M6_PASS` | macOS 点击穿透的**数字**（两扇重叠窗各数 `mousedown`，人要点一次） |
| `anti-bot-fingerprint.ts` | `anti-bot-fingerprint.report.json` | 更早的指纹探针（`webdriver` / `brands` / 权限 / 焦点） |
| `parking-surface.cjs` | `parking-surface.log` | `parking-surface-macos-handoff.md` 用的 macOS 清单脚本 |

跑法一律是仓库根目录：

```bash
node_modules/electron/dist/electron.exe apps/electron/spike/parking-screenxy.cjs
# macOS:
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/electron/spike/parking-screenxy.cjs
```

---

## 9. 到 Mac 后的第一句话

> "跑 `docs/parking-window-position.md` 第 6 节的清单，从 M1 到 M10，报告文件另存为 `-macos-<场景>.json`；
> 顺带把 `docs/parking-surface-macos-handoff.md` 的 Q1–Q5 一起跑掉。"

**2026-10-28 已跑，结果见 [§6.1](#61-macos-实测结果2026-10-28)**：M1/M2/M3/M7/M8/M10 通过，M4/M5/M6/M9 仍需人工或辅助功能权限。

如果 M2 或 M3 失败（alpha=0 不出帧 / 被判 occluded），那么 macOS 上就退回 **离屏 + 小边距（48）**，Windows 侧仍可用透明方案 —— 两个平台分开决策，不要为了统一而选更差的那个。
