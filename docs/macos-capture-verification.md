# macOS 截图 / 可见性验证（交接）

> **已在 macOS 上跑完（2026-10-16，macOS 15.6.1 / Electron 39.2.7，见文末「结果」）。** 命中判定表第 1 行：`hidden-after-show` 能拍、`never-shown` 拍不到 —— **判据与代码都不用改**，只把 `canCaptureHiddenWindows` / `tabHome` / `hasBeenShown` / `isVisible` 的注释从“文档”升为实测。
>
> 本轮结束后又追加了一轮（文末「补充（第二轮）」）：`windowHasSize` 把"最小化"和"没有尺寸"混为一谈，已修（影响 `viewport-resize`）。
> **Windows 侧同样留了三件事没量** —— 见 [`windows-window-state-verification.md`](./windows-window-state-verification.md)，那份是本文的对照，跑同一个 spike（`apps/electron/spike/hidden-window-usability.cjs`）。

给**在 Mac 上开的那个新任务**：本仓库这一轮的工作已经完成并在 Windows 上全部实测过，macOS 上还剩**四件事只有 Electron 文档、没有实测**（其中两件直接决定代码要不要改）。把它们量出来，按下面的「判定表」回填并把注释里的 “documented” 换成实测。

## 为什么是这几件事

截图路径和"一个 tab 的家在哪"都由同一个问题决定：**这扇窗口现在能不能为一个 view 交出 surface**。这条判据落在两处代码里：

- [`tabHome()`](../apps/electron/src/main/browser-pane-manager.ts) —— 一个 tab 的 view 该住人那扇窗口还是停车窗（`window` iff `activeTabId === tab.id && 窗口能交出 surface`）；
- [`canCaptureHiddenWindows`](../apps/electron/src/main/browser-pane-manager.ts) —— 平台是否能在窗口隐藏时仍给出像素，现在是 `process.platform !== 'win32'`，其注释明确写着 **macOS 那一半是 Electron 的文档行为，不是实测**。

Windows 侧已经按 `capture-methods.cjs` 的实测收敛：窗口状态分四种（`visible` / `minimized` / `hidden-after-show` / `never-shown`），其中 `never-shown` 在任何平台都没有 surface，所以 agent 那扇"生下来就隐藏"的窗口，它的 tab 从出生起就住在停车窗（停车窗是 `showInactive()` + 屏外，因此被合成）。**macOS 上这四格是什么样，决定了上面那两处代码要不要改、以及注释能不能从“文档”升成“实测”。**

## Windows 实测基线（2026-10-16，`capture-methods.cjs`）

| 状态 | `capturePage-hidden`<br>`{stayHidden,stayAwake}` | `capturePage-plain` | `Page.captureScreenshot`（CDP） |
|---|---|---|---|
| visible | own-pixels 11 / 27ms | own-pixels 31 / 33ms | covered 超时 / on-top own-pixels 88ms |
| **minimized** | **own-pixels 14 / 18ms** | **own-pixels 18 / 38ms** | 超时（两个 tab 都是） |
| hidden-after-show | **超时 2.5s** | **超时** | **超时** |
| never-shown | **立刻 error 0ms**<br>“Current display surface not available for capture” | **立刻 error 0ms** | 超时 |

（每格两个数是 covered tab / on-top tab。`after reveal` 一列另见日志：`never-shown` 被贴屏一次后 `capturePage` 9ms own-pixels —— 这就是"首次必须上屏才有 surface"。）

三行结论：

1. 最小化窗口**能拍**（`capturePage` 直接给出自有像素，和 visible 同量级）→ 最小化**不需要** park，`isVisible` 在最小化时保持 true 是对的。
2. 隐藏（show 过又 hide）在 Windows 上**拍不到**（三条路径全超时）→ 这类窗口里的 tab 必须 park。
3. 从未上屏的窗口**在任何平台都没有 surface**（立刻报错，不是超时）→ 停车窗必须存在、且必须是"shown 的"。

## 要做的四件事（按重要性）

### 1）四种状态在 macOS 上的同一张表（核心）

跑 [`capture-methods.cjs`](../apps/electron/spike/capture-methods.cjs)，它已经把四种状态和三条捕获路径都排好了，**并且自己写日志**。

看什么：

- `visible` —— 基线，应当全绿（若这里就不对，先查环境）
- `hidden-after-show` —— `canCaptureHiddenWindows` 声称 macOS 能拍。**这一格是第一条要确认的**
- `never-shown` —— 应当拍不到（Windows 是"立刻 error"）。**这一格是 `tabHome` 把"从未上屏"排除在外的唯一依据**
- `minimized` —— Windows 上能拍；macOS 是否同样

### 2）隐藏窗口的像素是不是只有带 `stayHidden/stayAwake` 才拿得到

对照表里 `capturePage-hidden` 和 `capturePage-plain` 两列。它们若在 macOS 上一样，说明选项无关紧要；若只有前者 work，说明 `capturePageImage` 里 `useHiddenCaptureOptions` 必须按平台给（现在 in-place 分支恒定 `true`，见 `capturePageImage`）。

### 3）最小化窗口（`minimized` 行）在 macOS 上是否也 answer

决定 [`isVisible` 的文档](../apps/electron/src/main/browser-pane-manager.ts)（"最小化算 up"）在 macOS 上是否也成立。若不成立 → macOS 上最小化期间每张截图会先吃一次 refusal 再借停车窗（可恢复，但值得记一笔，或按平台处理）。

### 4）（次要）录制路径在隐藏/最小化窗口上是否照常出帧

跑 [`capture-hidden-frames.cjs`](../apps/electron/spike/capture-hidden-frames.cjs)：它量 `Page.startScreencast` 与 `getDisplayMedia` 在 `visible` / `offscreen` / `hidden` 三态下的出帧数（Windows 上三态都是 ~120 帧/2s）。这条支撑 `browser-cdp.ts` 的 `holdsSessionState()` 里 screencast 那一支，以及 `design-motion-capturer` 选 screencast 的理由。若有余力，`minimized` 也可加一个状态。

## 怎么跑（macOS）

```bash
cd <repo>                                  # craft-agents-oss
# 依赖没装过就先 bun install
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  apps/electron/spike/capture-methods.cjs
```

注意：

- 脚本会把结果**自己写**到 `apps/electron/spike/capture-methods.log`（逐行 flush，卡住会停在最后一行），同时打印到 stdout。
- 它会短暂弹出几个窗口（`showInactive` + `skipTaskbar`），跑完自己退出；有 90 秒看门狗。
- **先给 Windows 那份日志留档**：`git log --oneline -1` 记下它已在版本库里（同一文件被覆盖后仍可从 git 取回），建议先另存为 `capture-methods.windows.log` 再跑，避免两次结果互相覆盖。
- `capture-hidden-frames.cjs` 同样是 `console.log`，需要重定向或看 stdout。

## 判定表（结果 → 动作）

| macOS 的结果 | 要做的改动 |
|---|---|
| `hidden-after-show` **能拍**、`never-shown` **拍不到** | 判据与代码**都不用改**。把 `canCaptureHiddenWindows` 的注释从 "documented behaviour, not something this machine could measure" 换成 macOS 实测数字；`tabHome` / `hasBeenShown` 的文档同步。 |
| `hidden-after-show` **拍不到** | 把 `canCaptureHiddenWindows` 收窄（按实测，最省事就是 `false`）。于是 macOS 也走"隐藏即 park"，`tabHome` 的隐藏分支永远落 parking —— 少一次注定失败的尝试。 |
| `never-shown` **能拍** | 那么"从未上屏的窗口没有任何 surface"这条在 macOS 上不成立，`tabHome` 要按平台分开表述（Windows 仍必须 park）。open-webui 侧不受影响：它无条件 park，不改也仍然正确，只是 macOS 上少了一件非做不可的事。 |
| `minimized` **拍不到** | `isVisible` 的文档要按平台分开写；并决定是否让最小化也 park（`restore` 已有 `cameBack → layoutAllViews` 的钩子，接上即可）。 |
| 只有 `capturePage-hidden` 能拍、`plain` 不能 | `capturePageImage` 的 `useHiddenCaptureOptions` 需要按平台/状态给值，而不是恒定 true。 |

## 结果（macOS 实测，2026-10-16）

```
macOS 机型 / 版本：MacBook Air (M1, MacBookAir10,1) / macOS 15.6.1 (24G90)
Electron 版本（node_modules/electron/package.json）：39.2.7
跑的命令：
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/electron/spike/capture-methods.cjs
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/electron/spike/capture-hidden-frames.cjs
```

每格两个数是 covered tab（红）/ on-top tab（蓝）。原始逐行日志见 `apps/electron/spike/capture-methods.log`（已被本次 macOS 跑覆盖；Windows 那份在 `HEAD:apps/electron/spike/capture-methods.log` 里，跑前也另存到了 `/tmp/capture-methods.windows.log`）。

| 状态 | `capturePage-hidden` | `capturePage-plain` | CDP | 备注 |
|---|---|---|---|---|
| visible | own-pixels 38 / 16ms | own-pixels 3 / 17ms | own-pixels 50 / 59ms | 基线全绿 |
| minimized | own-pixels 5 / 18ms | own-pixels 12 / 16ms | own-pixels 73 / 52ms | 与 Windows 同：最小化能拍 |
| hidden-after-show | own-pixels 3 / 12ms | own-pixels 6 / 14ms | own-pixels 50 / 50ms | **能拍** —— `canCaptureHiddenWindows` 的 macOS 那一半成立 |
| never-shown | 立刻 error 0ms / ※ | 立刻 error 0ms / ※ | own-pixels 98ms / ※ | covered：两条 `capturePage` 立即报 “Current display surface not available for capture” |

两点必读（都会让脚本自己的判定看起来“不对”）：

1. **`covered` 那几格判的 `WRONG-colour` 其实是 own-pixels，是色彩空间问题。** 读到的像素是 `[35,51,234]`，正是 sRGB 纯红（`#ff0000`）在 **Display P3** 下的编码（P3 与 sRGB 共享蓝色原色，所以蓝 tab 仍读作 `[245,0,0]` 判 own-pixels）。也就是说拿到的是该 tab *自己的* 像素，不是上层蓝的 —— macOS 的 `capturePage`/CDP 对同窗口里被压住的 view 也返回它自己的画面。判“能不能拍”只看“有没有像素 / 是不是立刻报错”，不看这个颜色标签。
2. **`never-shown` 那一行的 on-top 一栏（※）是被污染的值，别用它。** 脚本在测 `never-shown · covered` 时会走一次 “reveal”（`showInactive`）再 `hide()`，此后该窗口已经“上过屏”了；同一窗口紧接着测的 on-top 行，测的其实是 `hidden-after-show`。从未上屏的干净读数只有 covered 行的主三列：`capturePage`（-hidden / -plain）**0ms 立刻报错**，CDP 反而在 macOS 上给了像素（98ms，仍是该 tab 自己的红）。

**结论：命中判定表第 1 行。** `hidden-after-show` 能拍（`capturePage` 两种形式 + CDP 都给像素，3–12ms）、`never-shown` 的 `capturePage` 拍不到（0ms 立刻报 “no surface”）⇒ 判据与代码都不用改；`canCaptureHiddenWindows` 仍是 `process.platform !== 'win32'`，只把它的注释、以及 `tabHome` / `hasBeenShown` / `isVisible` 的文档从“文档行为”升为实测。另：选项无关紧要 —— `capturePage-hidden`（带 `stayHidden/stayAwake`）与 `capturePage-plain` 在 macOS 上都是 3–6ms own-pixels，`useHiddenCaptureOptions` 恒定 `true` 无需按平台分支。

### 第 3 件补充：`isVisible` 本身在 macOS 最小化时是什么（一次性探针实测）

上面那张表只回答了"最小化能不能拍"。代码里 `isVisible` 不是 `window.isVisible()`，而是靠 `show` / `hide` 事件维护的字段（[browser-pane-manager.ts](../apps/electron/src/main/browser-pane-manager.ts) 的 `instance.window.on('show'/'hide')`），所以还要量"事件层面"发生了什么。一次性探针（同一台机器 / Electron）结果：

- **macOS 上 `minimize()` 会发 `hide`**：`minimize` →（几 ms）→ `hide`，且 `hide` 触发时 `isMinimized()=true`、`isVisible()=false`。也就是说字段 `instance.isVisible` 在 macOS 最小化后变成 **false**，和"最小化算 up"的字面说法不符。
- **但它不改变 `tabHome`**：macOS 上 `canCaptureHiddenWindows=true` 且 `hasBeenShown=true`，所以活动 tab 走另一支仍返回 `window` —— 不用 park、不先吃 refusal。判定表第 3 行猜的"每张截图先吃一次 refusal"在 macOS 上**不成立**。
- **我们自己的 `hide()` 对已最小化窗口不发第二次 `hide`，且 `isMinimized()` 仍为 true**：所以"检测到最小化就不清 `isVisible`"的守卫会误伤我们自己的 hide 路径 —— 因此**没动行为**，只把注释改成实测口径。
- 唯一可见差异：最小化期间上报的 `instance.isVisible=false`，于是 UI 里 `ToolbarStatusSlot` 的 agent 状态条会收起 —— 这是"窗口此刻是否真的在屏幕上"的诚实答案（Windows 侧的事件行为本机没有复测，只量了 macOS）。行为保留现状。
- **后续改动（Windows 那轮之后）**：这条"最小化不 park"被统一掉了 —— 现在两个平台都是"最小化即回停车窗"，判据直接问 `window.isMinimized()`（详见 `windows-window-state-verification.md` 的结论第 1 条）。macOS 上多出的那次搬移按设计看不见，页面尺寸不变、也不重排。

### 补充（第二轮）：隐藏/最小化时 view 留在窗口里够不够用 —— `hidden-window-usability.cjs`

判定表只按"能不能截图"回答，于是 macOS 上 hidden 留在窗口里被判定为 OK。问题是 resize 等**其它**自动化是否也 OK —— 一个窗口不在屏幕上时，留在里面的 view 到底还可用吗。新 spike（`apps/electron/spike/hidden-window-usability.cjs`，`capture-methods.cjs` 同款：自写日志 + 90s 看门狗，Windows 也能跑）：

一个 view **留在窗口里**（未 park），macOS 15.6.1 / Electron 39.2.7：

| 状态 | 页面 visibility | rAF/700ms | `view.setBounds` → innerWidth | 触发 resize 事件 | CDP 点击 | capturePage |
|---|---|---|---|---|---|---|
| visible | visible | 43 | 1400 | 1 | ✓ | 2800×1800 |
| **minimized** | visible | 42 | 1400 | 1 | ✓ | 2800×1800 |
| **hidden-after-show** | visible | 43 | 1400 | 1 | ✓ | 2800×1800 |
| never-shown | hidden | **0** | 1400 | **0** | ✓ | **0×0** |
| parked（屏外已显示） | visible | 42 | 1400 | 1 | ✓ | 2800×1800 |

`viewport-resize` 走哪一支（窗口那一支 = `setContentSize` + `layoutAllViews`；判据是 `windowHasSize`）：

| 状态 | 现在（`windowHasSize` 对 minimized 直接 false） | 只按"窗口报出的尺寸"判断 |
|---|---|---|
| visible | laidOut ✓，页面 1400×900，答 1400×722 | 同左 |
| **minimized** | **laidOut ✗，页面停在 900×620，却答 1400×900（静默失败 + 谎报）** | laidOut ✓，页面 1400×900，答 1400×900 |
| hidden-after-show | laidOut ✓，页面 1400×900，答 1400×900 | 同左 |

**结论：不需要把 activeTab 移进停车窗。** hidden 和 minimized 的 view 在窗口里几何、resize 事件、rAF 绘制、`executeJavaScript`、CDP 输入、截图**全都正常**（`document.visibilityState` 还是 visible，因为 `CalculateNativeWinOcclusion` 被关掉），所以"留在窗口里"对 hidden/minimized 都站得住；只有 never-shown 不是可用的家（不绘制、连 resize 事件都不发、截图为 0×0），停车窗对它是必须的 —— 代码已经这么做。

真正的缺陷在别处：`windowHasSize` 把"最小化"和"没有尺寸"当成同一件事。macOS 上最小化窗口**仍然报得出内容尺寸**（实测 `[1480, 980]`，而在屏幕上时同一请求被工作区高度夹到 802），于是 agent 的 `viewport-resize` 在窗口最小化期间**静默失效**，还把请求的尺寸当成结果答回去。已改成只问报出的尺寸（[`windowHasSize`](../apps/electron/src/main/browser-pane-manager.ts)）：macOS 修好（页面真的拿到 1400×900），Windows 行为不变 —— 0×0 仍然是拒绝的理由，只是换成由"报出的尺寸"而不是"是否 minimized"来说。

已知且保留的差异：Windows 上 hidden 的 tab 本来就 park，`viewport-resize` 在停车窗里改 view；macOS 上 hidden 的 tab 留在窗口里，`viewport-resize` 走窗口那一支（会改那个隐藏窗口的尺寸，页面尺寸照样生效且不谎报）。两者结果都正确，只是实现路径不同 —— 换成统一 park 会丢掉 macOS 实测的"原地可用"能力，得不偿失。

### 第 4 件（次要）录制路径：`capture-hidden-frames.cjs`（每态 2000ms）

| state | window | page-vis | paints | cdp-screencast | display-media |
|---|---|---|---|---|---|
| visible | true | visible | 120 | 121 | 66 |
| offscreen | true | visible | 121 | 120 | 60 |
| hidden | false | visible | 120 | 121 | 60 |
| visible-again | true | visible | 120 | 120 | 61 |

两条路径四态都照常出帧：`Page.startScreencast` ~120 帧/2s（≈60fps），`getDisplayMedia` ~60 帧/2s（≈30fps）；`offscreen` / `hidden` 都不掉帧，隐藏后也恢复。与 Windows 同向（Windows 三态都是 ~120 帧/2s），支撑 `browser-cdp.ts` 的 `holdsSessionState()` screencast 那一支与 `design-motion-capturer` 选 screencast 的理由。

## 别做的事

- 不要为了让某一格"看起来对"而改判据：这条线的每个结论都必须来自日志里的表格（这个仓库的既有习惯就是"先量再改"）。
- 不要把 `capture-methods.log` 的 Windows 版本丢掉（跑之前先另存）。
- 不要顺手改 `canCaptureHiddenWindows` 的取值——它同时是 `capturePageImage` 那条路径的输入，改之前先看判定表。

## 附：open-webui 侧不需要这份验证

`C:\Users\Ryan\code\open-webui\desktop` 里对应的是另一套模型（没有每连接的窗口，当前 tab 常驻停车窗），它**没有** `canCaptureHiddenWindows` 这类平台假设：主窗口隐藏/最小化时走 `setBrowserHostVisible(false)` → 无条件把所有 tab 落回停车窗（`src/main/device/browser.ts` 的 `hostVisible` / `layoutPane`），截图不依赖"隐藏窗口能不能拍"。所以上面四件事只影响 craft。
