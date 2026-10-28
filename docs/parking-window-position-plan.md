# 停车窗位置：改动方案（待 macOS 实测后一起评估）

> 状态：**B 与 C 都已实施**（2026-10-28）。C 是默认路径，B 退为回退（Linux 等 `setOpacity` 不生效的平台）；B 的三处改动都还在，见 §10、§12。
> 写于 2026-10-28。所有"实测"引用均来自该文档 §2（Windows 11 / Electron 39.2.7 / RDP / 单屏 1440×960 @2x）。
> 评估门槛：先跑完该文档 §6 的 **M1–M10**（以及 [parking-surface-macos-handoff.md](./parking-surface-macos-handoff.md) 的 Q1–Q5），再按本文 §7 的决策门选择 A / B / C。

---

## 1. 决策摘要

| 方案 | 一句话 | 当前状态 |
|---|---|---|
| **A** | 维持现状：离屏 + 边距 20000（实际落地 16383），不透明 | 现状 |
| **B** | **离屏 + 边距 48 + 换侧（下→上→左→右）+ 追上瞬间临时透明** | **倾向采用** |
| **C** | 屏内 `workArea` + `opacity: 0` + `alwaysOnTop` + `ignoreMouseEvents` | 备选，等 macOS 数据 |

选择 B 的理由：改动集中在三个点、不引入新 API 依赖、不动 macOS 已知行为，同时把页面读到的几何从"不可能的 16383"变成"可解释的 1008/1488"。C 只在"真机插屏闪烁不可接受"时才值得为它付代价。

---

## 2. 为什么现在不用 A、也不用 C

### 2.1 A（现状）的问题只有一个，但它是硬的

`OFFSCREEN_PARK_MARGIN = 20_000` 的**意图无法被表达**——Windows 把窗口坐标钳到 16 位，20000/100000/1000000 全部落地为 **16383**（代码注释里已记录）。于是页面读到：

```
window.screenX = 16383    screen.availWidth = 1440
event.screenX  = 16503    （= 16383 + clientX）
```

数字之间是**自洽**的（同源），但 `screenX` 比屏幕宽出 14943px —— 没有任何真实用户状态对应这个值，而 `16383` 恰好是 Windows 坐标上限的常数，任何做指纹的人看到它就知道"有程序在把窗口藏到屏幕外"。

### 2.2 C（屏内透明）的代价（都已实测，但代价是新的失败模式）

| 项 | 结论 | 来源 |
|---|---|---|
| `opacity: 0` 本身**不**穿透鼠标 | 不设 `setIgnoreMouseEvents` 时会吞点击/悬停 | §2.3 真实系统点击 |
| `ignoreMouseEvents` 有焦点时仍收键盘 | 必须同时 `focusable:false` + `showInactive()`，且 `show()` 后要重设 | `electron.d.ts` 原文 |
| Linux `setOpacity` 是 no-op | 必须 `getOpacity()` 读回校验并回退 | `electron.d.ts` 平台标注 |
| 窗口会出现在可见顶层窗口枚举里 | `WS_EX_TOOLWINDOW` 未置位、无 owner；屏幕共享选择器可能列出空条目 | §2.4 |
| macOS 行为全部未验证 | 见 [parking-window-position.md](./parking-window-position.md) §6 | — |

C 的数字更好（`screenX` 完全在屏内、无任何出界），但它换来的是四个平台/系统层面的新面。**只有在 B 的闪烁不可接受时才值得。**

---

## 3. 改动清单（B）

改动文件只有一个：`apps/electron/src/main/browser-pane-manager.ts`。

### 3.1 边距：`20000` → `48`

```ts
// 现状（约 :188）
const OFFSCREEN_PARK_MARGIN = 20_000

// 改为
/**
 * 停车窗越过最后一块显示器多远。
 *
 * 它同时是两个东西：一个**请求**（桌面会钳位，见下）和一个**页面上能读到的数**
 * （`window.screenX` / `event.screenX`）。曾经写 20_000 ——"远过任何桌面"——但坐标被钳到
 * 16 383，于是页面读到的位置比屏幕还宽 14943px，一个任何真实状态都不对应的数。
 *
 * 48 是"刚好把窗口整个放到屏外"的量级：边框 + 阴影 + DPI 取整都在它之下，而 1440+48=1488
 * 是一个真实存在的状态——"副屏被拔掉之后，窗口被留在了外面"。
 */
const OFFSCREEN_PARK_MARGIN = 48
```

**验收**：`window.screenX` 与 `screen.availWidth` 之差 ≤ 64（现状是 14943）。

### 3.2 换侧：候选顺序改为 下 → 上 → 左 → 右

```ts
// 现状（约 :4649）
const candidates = [
  { x: right + OFFSCREEN_PARK_MARGIN, y: top },
  { x: left - OFFSCREEN_PARK_MARGIN - size.width, y: top },
  { x: left, y: bottom + OFFSCREEN_PARK_MARGIN },
  { x: left, y: top - OFFSCREEN_PARK_MARGIN - size.height },
]

// 改为（把最容易被新显示器"包住"的左右放到最后）
const candidates = [
  { x: left, y: bottom + OFFSCREEN_PARK_MARGIN },                              // 下
  { x: left, y: top - OFFSCREEN_PARK_MARGIN - size.height },                   // 上
  { x: left - OFFSCREEN_PARK_MARGIN - size.width, y: top },                    // 左
  { x: right + OFFSCREEN_PARK_MARGIN, y: top },                                // 右
]
```

**理由**：边距缩到 48 之后，"新显示器把它包进来"从"几乎不可能"变成"可能"，而危险期只持续到 `display-added` 被处理完。用户接屏绝大多数发生在**左右两侧**，上下方向极少——把这个概率压下去，而不引入任何新机制。

**副作用**：`screenY` 出界而不是 `screenX`（例如 `screenY = 912+48 = 960`，`availHeight = 912`）。两者对指纹检查是等价的（都要判断"窗口原点是否落在任一 display 矩形内"），解释力也相当（都是"副屏被拔了"）。而 `screenX` 反而变成完全合法的值。

### 3.3 追上瞬间临时透明（只在"已经被看见"的那一瞬）

```ts
// keepOffEveryDisplay()（约 :4683）
private keepOffEveryDisplay(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const rect = window.getBounds()
  if (!this.overlapsADisplay(rect)) {
    this.parkingStuck.delete(window)
    return
  }
  if (this.parkingStuck.has(window)) return

  const spot = this.offscreenSpot({ width: rect.width, height: rect.height })

  // 它此刻就在某块屏上——用户可能正看着它（插屏那一刻，Windows 不会移动窗口，
  // 是新屏把它包了进来）。所以先让它看不见，再搬；搬完已经在屏外，恢复不会闪第二次。
  // 实测：opacity 0 不影响出帧与 capturePage（字节级一致），这几十毫秒里页面照画不误。
  // Linux 上 setOpacity 是 no-op，读回不是 0 就跳过——退化成今天的"闪一下"。
  const opacity = window.getOpacity()
  const dimmed = opacity !== 0
  if (dimmed) window.setOpacity(0)
  try {
    window.setPosition(spot.x, spot.y)
  } finally {
    if (dimmed && !window.isDestroyed()) window.setOpacity(opacity)
  }

  const landed = window.getBounds()
  const stillOnADisplay = this.overlapsADisplay(landed)
  if (stillOnADisplay) {
    this.parkingStuck.add(window)
    mainLog.warn(`[browser-pane] a window nobody may see could not be moved clear of the displays: it asked for ${spot.x},${spot.y} and is at ${landed.x},${landed.y}, which a display still covers`)
    return
  }
  mainLog.warn(`[browser-pane] a window nobody may see was on a display at ${rect.x},${rect.y}; moved it back off every display to ${landed.x},${landed.y}`)
}
```

**为什么这条路径足够安全**：`keepOffEveryDisplay` 先做一次 `overlapsADisplay` 比较就返回，所以"临时透明"只在**窗口确实落在某块屏上**时发生——正常运行时它一次都不会触发，`move`/`resize` 事件也不会误触。

---

## 4. 逐条风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| 插屏后 `display-added` 之前，停车窗被包进新屏 | 边距 48 后显著上升；左右最高 | §3.2 换侧把最常见的左右压到最低 + §3.3 临时透明 |
| `parkingStuck` 永久放弃（窗口留在屏上） | 低：只有"四个方向全被占满"才会 | 不动现有逻辑；`stuck` 在任一次成功移回屏外时被清掉 |
| `setPosition` 被桌面夹回（层叠/高 DPI 边界） | 低 | 现有 `landed` 复查 + warn 日志不变 |
| 临时透明打断一帧 | 极低：仅异常路径 | 实测 opacity 0 画面照常；若真丢一帧，也在"用户正在插屏"的毫秒里 |
| Linux 无 `setOpacity` | 确定（平台限制） | 读回 `getOpacity() !== 0` 即跳过；行为等同今天 |
| 单屏用户升级后首次摆放位置变化 | 100%（这是目的） | 无数据影响；仅日志里的坐标变化 |
| 多屏异形拼接（右/左/下都有屏） | 中 | `overlapsADisplay` 已过滤，自动退到还有空隙的一侧 |

---

## 5. 测试计划

### 5.1 单测（`apps/electron/src/main/__tests__/browser-pane-manager.test.ts`）

1. **边距不再被钳位**：mock 单屏 `{x:0,y:0,w:1440,h:960}`，断言 `offscreenSpot({w:900,h:640})` 的 `x` 或 `y` 距离最近屏边 ≤ 64。
2. **不与任何显示器相交**：同上，`overlapsADisplay(spot+size) === false`。
3. **候选顺序**：mock 一块屏在下方（`{y:960,...}`）时，选择退到"上/左/右"，而不是 `bottom + 48`。
4. **追上即透明并恢复**：stub 一个已在屏内的 bounds，断言 `setOpacity` 的调用序列是 `0 → 原值`，且 `setPosition` 夹在中间。
5. **正常路径不碰 opacity**：窗口在屏外时 `setOpacity` 零调用（防止 `move` 事件抖成手电筒）。

### 5.2 手动（Windows 真机，本机是 RDP 测不了）

| 步骤 | 期望 |
|---|---|
| 插一块屏到**右侧** | 停车窗不可见；日志出现 "was on a display … moved it back off every display"；无可见闪烁 |
| 插一块屏到**下方** | 同上（这是换侧之后最可能被包住的方向，重点看） |
| 拔掉所有副屏 | 无残留窗口；无卡死 |
| 100% ↔ 200% 缩放切换 | 坐标重算后仍不可见 |
| 拖主窗到副屏 | 停车窗不跟随、不露出 |
| 视口 resize（`viewport-resize` 到 2560×1440） | 仍不可见；截图正常 |

### 5.3 macOS

直接跑 [parking-window-position.md](./parking-window-position.md) §6 的 M1–M10。**B 方案本身不含平台分支**，所以 macOS 的 M1–M10 只用于决定"要不要叠加 C"，不影响 B 是否可以上。

---

## 6. 验收标准（可判定的）

- [ ] 页面读到的 `window.screenX` / `screenY` 中，**只有一个轴**出界，且出界量 ≤ 64
- [ ] 另一个轴严格落在 `[availLeft, availLeft+availWidth)` 内
- [ ] `event.screenX - clientX === window.screenX`（同源自洽未被破坏）
- [ ] `overlapsADisplay(parkingBounds) === false`（每个 display 事件之后）
- [ ] 显示器变化后一个事件循环内完成归位（日志时间戳差 < 100ms）
- [ ] 出帧不回退：`rafTicksIn400ms ≥ 8`、`wc.capturePage()` 非空
- [ ] `browser-pane-manager.test.ts` 全绿，且新增 5 条断言在列

---

## 7. 决策门（等 macOS 数据）

```
M1–M3 全过（alpha=0 出帧、不判 occluded）
├─ 是 → C 在 macOS 上成立的候选成立
│        └─ Windows 真机插屏闪烁是否明显？
│             ├─ 明显 → 采用 B + 叠加 C（C 是保险层，不替换 B）
│             └─ 不明显 → 停在 B
└─ 否 → 停在 B（C 不可用，闪烁靠 §3.3 的临时透明压小）
```

无论哪条分支，**B 都是要做的**（它修的是"16383"这个数），C 只是可选叠加。

---

## 8. 回滚

三处改动互相独立，可单独回退：

1. `OFFSCREEN_PARK_MARGIN` 改回 `20_000` → 数字回退到 16383，其他行为不变；
2. `candidates` 顺序改回 右→左→下→上 → 摆放位置回到右侧；
3. `keepOffEveryDisplay` 去掉 opacity 包裹 → 回到"直接 setPosition"。

无数据迁移、无配置项、无持久化影响。

---

## 9. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-10-28 | 首版：基于 parking-window-position.md §2 的 Windows 实测，确定 B + 两手补丁，C 列为备选 |
| 2026-10-28 | **B 落地**（§10）；macOS 上补测了 M1/M2/M3/M7/M8/M10（见 `parking-window-position.md` §6.1） |

---

## 10. 实施记录（B，2026-10-28）

只改了 [browser-pane-manager.ts](file:///Users/ryan/code/craft-agents-oss/apps/electron/src/main/browser-pane-manager.ts) 的三处，与 §3 一致：

1. `OFFSCREEN_PARK_MARGIN` = **48**（注释重写：这个常数同时是"请求"和"页面能读到的数"）；
2. `offscreenSpot` 的候选顺序 = **下 → 上 → 左 → 右**；
3. `keepOffEveryDisplay` 在**确实落在某块屏上**时先 `setOpacity(0)`、`setPosition`、再在 `finally` 里恢复读回的原值；Linux 上 `setOpacity` 是 no-op，读回仍是 1，行为退化成今天。

单测（[browser-pane-manager.test.ts](file:///Users/ryan/code/craft-agents-oss/apps/electron/src/main/__tests__/browser-pane-manager.test.ts)）新增 4 条、改了 1 条旧断言，全部 195 条通过：

- 边距不再被钳位：`offscreenSpot(900×640)` 在 1440×960 上 = `(0, 1008)`，`y - 960 ≤ 64`、`x = 0`、且不与任何 display 相交；
- 候选顺序：下方/侧方都有屏时落在**最下方**屏的下边之外；
- 被追上时：`setOpacity` 的调用序列是 `0 → 1`，`move` 事件里读到的 opacity 是 0（即"移动发生时是透明的"）；
- 正常路径：窗口已在屏外时 `setOpacity` 零调用。

macOS 实测（本机，见 `parking-onscreen-macos.cjs` 的 D2 行）：

| 项 | 读数 |
|---|---|
| 请求 / 落点 | `(0, 948)`，**没有被系统拉回** |
| 页面读到 | `screenX = 0`、`screenY = 948`（`availHeight` 802 / `screen.height` 900） |
| 出帧 | rAF 24/400ms，`capturePage` 1800×1280、411677 B（与屏内那次逐字节相同） |

即 §6 的验收：一个轴出界 48 ≤ 64，另一个轴严格在屏内。

**没做的事**：Windows 真机的人工项（§5.2：左右/下方插屏、拔屏、缩放切换、拖主窗、view resize）需要在有物理显示器的 Windows 上跑，本机是 macOS + 单屏，做不了。

---

## 11. 要不要再往前走到 C（2026-10-28 决策）

**结论：继续。M6 已于 2026-10-28 实测通过（§11.6），代码未动，等一句话就能按 §11.4 开工。**

> 更新（2026-10-28 傍晚）：§11.2–§11.3 写的是"M6 还没验"时的状态，保留作记录；
> 实际结果与两条测试前提见 **§11.6**。现在挡在 C 前面的只剩 M4 / M5 / M9 三个"会不会被看见"的人工项。

### 11.1 macOS 那轮数据改变了什么

三个原先只是"预期"的结论，现在有读数了（`parking-onscreen-macos.report.json`，M1/M2/M3/M7/M8/M10 全过）：

| 发现 | 对决策的影响 |
|---|---|
| `opacity 0` 出帧正常：rAF 24–25/400ms、`capturePage` 1800×1280 / **411677 B**，与不透明那次**逐字节相同**；连 `screen-saver` 层级整块盖住也不变 | "透明会不会掉帧"这条风险**关闭** |
| 场景 E：屏内透明窗**导航后不补 `moveTop`** 仍 `visible`、rAF 24、截图变化（414706 B，确是另一份文档） | **C 的最大隐收益**：删掉一个顺序敏感的"叫醒"依赖 |
| 场景 D：屏外窗口光 `moveTop()` 不够——要先 CDP attach + 一次 `Runtime.evaluate` 把它叫醒，否则停在 `hidden` / `capturePage` 报 `Current display surface not available` | 暴露 **B 的隐性脆弱点**：屏外出帧依赖"叫醒"的次序 |

第三条是关键：B 在运行时依赖一个"表面还在不在"的隐含状态，症状是截图超时而不是崩溃，很难查。C 把这整类状态删掉——窗口在屏内，导航、resize、切后台都不需要仪式。所以 C 不只是指纹更干净，**运行时也更简单**。

### 11.2 为什么还被 M6 挡着

`setIgnoreMouseEvents(true)` 是 C 的功能前提（Windows 已用真实 `SendInput` 验过：不设就吞点击与悬停，设了就穿透）。
macOS 那轮 `osascript` 报 `-25211 不允许辅助访问`，连基线窗口都没收到点击 —— 整组读数无效，**等于零证据**。

失败模式比指纹严重得多：**用户会得到一块看不见、却吃掉点击的窗口**。所以顺序只能是先验 M6，再上代码。

### 11.3 M6 的 10 秒验法（不需要辅助功能权限）

```bash
# macOS，仓库根目录
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  apps/electron/spike/topmost-transparent-window.cjs --show --through --keep
```

会出现一块 0.55 不透明度的窗（`topmost-transparent-window.cjs` 新加的 `--through`：亮着，但忽略鼠标）。
**在它上面点一下**：下面的 Finder / 终端应该收到这次点击。
- 收到 → M6 通过，C 可以动工；
- 收不到 → M6 失败，停在 B（已上线，§10 验收通过），把这条写进文档，别再试。

顺带用同一扇窗看三件事（都不影响功能，只影响"会不会被看见"）：M5 Mission Control（`Ctrl+↑`）、M9 Dock 有无图标、M4 切 Space 后 rAF 是否继续。

### 11.4 若 M6 通过，实施清单

1. `parkingWindowFor()`：`focusable: false`、`hasShadow: false`、`setTitle('')`、`setIgnoreMouseEvents(true)`（**每次 `show` 之后重设**）、`setHiddenInMissionControl(true)`（darwin）、`setOpacity(0)`，置顶仍用现在的 `setAlwaysOnTop(true,'floating')` + `moveTop()`；
2. `getOpacity() !== 0`（Linux）→ 回退到 B 的离屏 + 边距 48；
3. `offscreenSpot` / `keepOffEveryDisplay` 只留在回退分支上（B 的三处改动保留，不删）；
4. 断言：`show` 之后 `ignoreMouseEvents`/`alwaysOnTop` 仍成立；`setOpacity` 在读回不为 0 时不假装成功。

### 11.5 为什么不能"顺手"切

C 需要给停车窗新加三个 API（`focusable:false`、`setIgnoreMouseEvents`、`setHiddenInMissionControl`），产品现在一个都没有。它改的是每个浏览器窗口的停车窗行为，不是一处调用点；而 M6 未验时，最坏结果是"看不见的点击吞噬层"。所以：**M6 通过之前，代码不动。**

### 11.6 M6 结果：通过（2026-10-28）

用 `apps/electron/spike/parking-click-through-macos.cjs` 量的——两扇窗完全重叠，下面一扇普通窗、
上面一扇与停车窗同配置（`opacity 0.55` + `alwaysOnTop floating` + `focusable:false` + `setIgnoreMouseEvents(true)`），
两边都数 `mousedown`，由人点一次紫色区域：

```
M6_RESULT {"top":{"down":0,"up":0,"move":142},"bottom":{"down":3,"up":3,"move":156}}
M6_PASS
```

- 上面那扇 `down 0 / up 0`，下面那扇 `down 3 / up 3` → **点击确实穿过透明窗**，M6 通过。
- 量之前踩了两个坑，都改的是测试脚手架而不是结论：
  1. 这个 demo 应用必须是**活动应用**，否则普通层级的下面那扇排在终端后面，点击穿过透明窗后落进终端，
     计数窗当然是 0（第一轮就是这个假阴性）；
  2. 下面那扇要 `acceptFirstMouse: true`，否则第一次按下只用于激活窗口。
- 附带发现：`setIgnoreMouseEvents(true)` 只挡**点击**，`mousemove` 仍进那扇透明窗的页面（142 次 move / 0 次 down）。
  对 `opacity: 0` 没有视觉后果，但如果要防"页面自己发现被悬停"，得单独处理。

**所以 C 的功能前提已经齐了**：出帧（M2）、不被遮挡（M3）、不抢焦点（M7）、几何合法（M8）、点击穿透（M6）。
仍缺的三项都是"会不会被看见"：M5（Mission Control）、M9（Dock）、M4（切 Space 后是否继续出帧）。

---

## 12. C 实施记录（2026-10-28）

按 §11.4 落地，默认走 C，B 整套留作回退。改动仍然只在
[browser-pane-manager.ts](file:///Users/ryan/code/craft-agents-oss/apps/electron/src/main/browser-pane-manager.ts)：

| # | 做了什么 |
|---|---|
| 1 | `parkingWindowFor()` 造窗时：位置 = 主屏 `workArea` 左上角；`focusable:false`、`hasShadow:false`、`title:''`；造完立刻 `setOpacity(0)`，读回决定模式 |
| 2 | 读回 `getOpacity() !== 0`（Linux）→ 记进 `parkingOffDisplay`、搬到 `offscreenSpot()`；B 的边距/换侧/`keepOffEveryDisplay` 全保留 |
| 3 | `hideFromWindowLists()` 加 `setHiddenInMissionControl(true)`（darwin）——C 的窗口**在屏上**，这条现在是主线不是保险 |
| 4 | `setIgnoreMouseEvents(true)` 在造窗时设一次，`keepShowing()` 每次 `show` 之后再设（实测 `show` 会丢） |
| 5 | 新增 `keepParkingInWorkArea()`：C 的窗口被屏幕变化丢到所有显示器之外时，搬回 `workArea`；`keepParkingWhereItBelongs()` 按模式二选一，挂到 `move`/`resize`/显示变化上 |

**删掉的一处**（B 的第三处改动）：`keepOffEveryDisplay` 里"移动前临时透明、移完恢复"的包裹。
C 之后它是死的——会走到那里搬窗口的，只有 `setOpacity` 不生效的平台，而那条路径上同一个 API 也是 no-op。
B 的位置逻辑（边距 48、下→上→左→右、`parkingStuck` 重试保护）全部保留。

单测（`browser-pane-manager.test.ts`）改成按模式分的三条，并给 mock 补了 `getPrimaryDisplay`、
`setIgnoreMouseEvents`、`setHiddenInMissionControl` 和"`setOpacity` 不生效"的开关：

- C：窗口在 `workArea` 左上角、`opacity 0`、`focusable:false`、忽略鼠标、不进 Window 菜单/Mission Control；
  屏幕变化不搬它，但被丢到所有显示器之外时搬回原处；`minimize`/`hide` 之后仍关闭鼠标；透明只请求一次；
- B：`getOpacity()` 读回 1 时搬到屏外、贴着边缘（≤64），插屏/被拖回屏上都会被搬走；
- 两种模式共用：`destroyAll` 之后丢掉屏幕订阅。

真机验证（macOS，`/tmp` 里的一次性脚本，按 §11.4 的选项造窗、**不先 attach debugger**）：

```
C_SUMMARY {"opacity":0,"bounds":{"x":0,"y":25,"width":900,"height":640},
           "first":{"capture":{"size":{"width":1800,"height":1280},"bytes":380444},"vis":"visible","screenX":0,"screenY":25},
           "afterNavigate":{"width":1800,"height":1280,"bytes":380416},
           "afterResize":{"width":1800,"height":1280,"bytes":380416}}
```

- 冷启动第一张图就答得出来（屏外方案在这一步要"叫醒"才肯出图）；
- 导航之后、`setContentSize` 之后都还能截；
- 页面读到 `screenX 0 / screenY 25`（= `workArea` 原点）、`inner == outer`、`vis visible`、`hasFocus false`。

**仍未做**：这次改动只在本机跑过（macOS 单屏）。Windows 真机、以及插拔屏 / 缩放切换那些人工项，
仍然按 §5.2 的清单跑；M4/M5/M9 三个"会不会被看见"的人工项也还没看。
