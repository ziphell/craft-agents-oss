# Windows 窗口状态验证（交接）

给**在 Windows 上开的那个新任务**：`docs/macos-capture-verification.md` 是 macOS 那一半，已经跑完（截图四态 × 三条路径、以及"隐藏/最小化时 view 留在窗口里还能不能做别的事"）。这份是它的 Windows 对照 —— **截图那半 Windows 早有基线**（那张表在 macOS 文档里），所以这里只量**第二轮留下的、Windows 还是空白的三个问题**，其中一个直接决定代码要不要再改。

## 为什么是这三件事

`tabHome` 决定一个 tab 的 view 住人那扇窗口还是停车窗；第二轮在 macOS 上量出两件事，Windows 侧都没量过：

1. **窗口不在屏幕上时，留在里面的 view 还可用吗** —— macOS 实测 hidden/minimized 的 view 几何、`resize` 事件、rAF 绘制、`executeJavaScript`、CDP 输入、截图**全都正常**，只有 `never-shown` 不行（不绘制、不发 `resize` 事件、截图为 0×0）。所以 macOS 上"hidden/minimized 留在窗口里"站得住，不需要为了自动化去 park。**Windows 上这是空白。**
2. **`windowHasSize` 把"最小化"和"没有尺寸"当成同一件事** —— 已改成只问"窗口报出的尺寸"（`getContentSize()`）。这条在 macOS 上修好了 `viewport-resize` 最小化期间**静默失效 + 谎报**的 bug（页面停在旧尺寸，返回的却是请求的尺寸）。Windows 上预期是 **no-op**（最小化报 0×0，仍然被拒），但要实测确认。
3. **`minimize()` 会不会发 `hide`** —— `tabHome` 用的不是 `isVisible()`，而是靠 `show`/`hide` 维护的字段 `instance.isVisible`。macOS 实测：`minimize()` 会**接着发 `hide`**（几 ms 后），所以最小化后该字段是 false。Windows 未知，而这条决定最小化时 tab 走 `tabHome` 哪一支 —— 也就决定 `viewport-resize` 能不能生效。

## 怎么跑

```bash
cd <repo>                                  # craft-agents-oss
node_modules/electron/dist/electron.exe apps/electron/spike/hidden-window-usability.cjs
```

（`capture-methods.cjs` 的 Windows 命令同款；Electron 依赖没装过先 `bun install`。）

注意：

- 脚本把结果**自己写**到 `apps/electron/spike/hidden-window-usability.log`（逐行 flush，卡住会停在最后一行），同时打印 stdout。**跑前先把 macOS 那份留档**（`git stash`/另存都行，本文件里的基线数字就取自它），别让两次结果互相覆盖。
- 它会短暂弹出几个窗口（`showInactive` + `skipTaskbar`），跑完自己退出；有 120 秒看门狗。
- 三节依次是：`usable`（每状态一行视图可用性）、`resize`（每状态两行：`today` 与 `reported-size`）、`window events`。

## macOS 基线（2026-10-16，macOS 15.6.1 / Electron 39.2.7，对比用）

一个 view **留在窗口里**（未 park）：

| 状态 | 页面 visibility | rAF/700ms | `view.setBounds` → innerWidth | 触发 resize 事件 | CDP 点击 | capturePage |
|---|---|---|---|---|---|---|
| visible | visible | 43 | 1400 | 1 | ✓ | 2800×1800 |
| minimized | visible | 42 | 1400 | 1 | ✓ | 2800×1800 |
| hidden-after-show | visible | 43 | 1400 | 1 | ✓ | 2800×1800 |
| never-shown | hidden | **0** | 1400 | **0** | ✓ | **0×0** |
| parked（屏外已显示） | visible | 42 | 1400 | 1 | ✓ | 2800×1800 |

`viewport-resize` 的窗口那一支（`setContentSize` + `layoutAllViews`）：

| 状态 | `today`（`windowHasSize` 对 minimized 直接 false） | `reported-size`（只问报出的尺寸） |
|---|---|---|
| visible | laidOut ✓，页面 1400×900，答 1400×722 | 同左 |
| minimized | **laidOut ✗，页面停在 900×620，却答 1400×900** | laidOut ✓，页面 1400×900，答 1400×900 |
| hidden-after-show | laidOut ✓，页面 1400×900，答 1400×900 | 同左 |

窗口事件：

- `minimize()` → `minimize`（`flag.isVisible` 还是 true）→ 6ms 后 `hide`（转 false）：**最小化会到达那个字段**。
- `restore()` → `restore` → `show`，字段回到 true。
- 我们自己对一个**已最小化**的窗口调 `hide()`：**不再发 `hide`**，且 `isMinimized()` 仍是 true。

Windows 已有基线（截图，取自 macOS 文档）：`capturePage` 在 `minimized` 能拍（own-pixels 14–18ms），`hidden-after-show` 三条路径全超时，`never-shown` 立刻报 "no surface"。

## 要看的 & 判定表

看 `spike/hidden-window-usability.log` 里的三节，逐格按下表回填并动手：

| Windows 的结果 | 要做的改动 |
|---|---|
| `usable` 的 `minimized` 行：viewport 跟随、`resize` 事件、CDP 点击、capturePage 都 ✓（与 macOS 同） | 最小化继续算这个 tab 的"家"，`tabHome` 不动。 |
| `usable` 的 `minimized` 行有 ✗（例如不绘制、或不接受输入） | 最小化在 Windows 上不是可用的家 → 让 `tabHome` 按平台把最小化也 park（macOS 已实测可用，只在 Windows 收窄）。 |
| `resize` 的 `minimized (reported-size)` 仍是 `windowContentSize` 0×0 / `laidOut ✗`（**预期**） | 已合并的 `windowHasSize` 改动在 Windows 上是 no-op；"最小化期间 `viewport-resize` 不生效（但不再谎报，返回的是 tab 实际尺寸）"依旧。**若要让它在 Windows 上也生效**：二选一 —— 让最小化也 park（`tabHome`），或在窗口那一支里显式给 view `setBounds`（因为窗口给不出尺寸，只能按请求值直接给 view）。 |
| `resize` 的 `minimized (reported-size)` 变成 `laidOut ✓` | Windows 最小化其实报得出尺寸 → 那条改动顺带把 Windows 也修好了，无需再动。 |
| `window events`：`minimizeReachesTheFlag = true`（最小化会发 `hide`，同 macOS） | 最小化后 `isVisible` 为 false → `tabHome` 落 `hasBeenShown && canCaptureHiddenWindows`，而 Windows 上该 flag 是 false → **最小化即 park** → `viewport-resize` 走停车窗那一支，反而生效。此时上面两行关于 resize 的结论要按"最小化已经 park"重读。 |
| `window events`：`minimizeReachesTheFlag = false`（不发 `hide`） | `isVisible` 保持 true → `tabHome` = 'window' → 走"0×0 被拒"那条：最小化期间 resize 不生效但诚实。 |
| `ourOwnHideWhileMinimized` 的 `hidesFromOurOwnHide ≠ 0`，或事后 `isMinimized` 变 false | 说明"最小化不当 hide"在 Windows 上语义不同 —— 改 `tabHome`/加守卫之前必须先考虑这条。 |

## 结果（待填）

```
Windows 版本 / 机型：
Electron 版本（node_modules/electron/package.json）：
跑的命令：
```

| 状态 | usable：viewport 跟随 / resize 事件 / 帧 / 点击 / 截图 |
|---|---|
| visible |  |
| minimized |  |
| hidden-after-show |  |
| never-shown |  |
| parked |  |

| 状态 | `today` laidOut / 页面尺寸 / 答回尺寸 | `reported-size` 同上 |
|---|---|---|
| visible |  |  |
| minimized |  |  |
| hidden-after-show |  |  |

```
window events：minimize 是否发 hide =       afterRestore =
              自己 hide 已最小化窗口：发第二次 hide 吗 =      isMinimized 仍为 =
```

## 别做的事

- 不要为了让某一格"看起来和 macOS 一样"而改 `canCaptureHiddenWindows` / `tabHome` 的取值：每个结论都必须来自本机 `hidden-window-usability.log` 的表（这个仓库的既有习惯是"先量再改"）。
- 不要把 macOS 那份日志丢掉（跑之前先留档；本文件的基线数字取自它）。
- "Windows 最小化报 `getContentSize()` 0×0"是既有结论（`windowHasSize` 的注释）。若量到不一样，先怀疑量法（窗口真的处于 minimized？`isMinimized()` 是不是在动画结束前读的？），再怀疑结论。
- 顺带（有余力才做）：`capture-hidden-frames.cjs` 目前只有 `visible` / `offscreen` / `hidden` 三态，可以补一个 `minimized`，量录制路径在最小化时是否照常出帧（macOS 上 screencast ~120 帧/2s、display-media ~60 帧/2s，隐藏态都不掉帧）。

## 附：open-webui 侧同样不需要

`C:\Users\Ryan\code\open-webui\desktop` 是另一套模型（没有每连接的窗口，当前 tab 常驻停车窗），主窗口隐藏/最小化时无条件把所有 tab 落回停车窗（`src/main/device/browser.ts` 的 `hostVisible` / `layoutPane`），不依赖"隐藏窗口能不能拍/能不能布局"。所以上面这些只影响 craft。
