# macOS 截图 / 可见性验证（交接）

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

## 结果（待填）

```
macOS 机型 / 版本：
Electron 版本（node_modules/electron/package.json）：
跑的命令：
```

| 状态 | `capturePage-hidden` | `capturePage-plain` | CDP | 备注 |
|---|---|---|---|---|
| visible |  |  |  |  |
| minimized |  |  |  |  |
| hidden-after-show |  |  |  |  |
| never-shown |  |  |  |  |

## 别做的事

- 不要为了让某一格"看起来对"而改判据：这条线的每个结论都必须来自日志里的表格（这个仓库的既有习惯就是"先量再改"）。
- 不要把 `capture-methods.log` 的 Windows 版本丢掉（跑之前先另存）。
- 不要顺手改 `canCaptureHiddenWindows` 的取值——它同时是 `capturePageImage` 那条路径的输入，改之前先看判定表。

## 附：open-webui 侧不需要这份验证

`C:\Users\Ryan\code\open-webui\desktop` 里对应的是另一套模型（没有每连接的窗口，当前 tab 常驻停车窗），它**没有** `canCaptureHiddenWindows` 这类平台假设：主窗口隐藏/最小化时走 `setBrowserHostVisible(false)` → 无条件把所有 tab 落回停车窗（`src/main/device/browser.ts` 的 `hostVisible` / `layoutPane`），截图不依赖"隐藏窗口能不能拍"。所以上面四件事只影响 craft。
