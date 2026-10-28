# 内嵌浏览器的指纹一致性：改了什么、有意不改什么

> 写于 2026-10-28。每条都标了**实测依据**与**代码位置**，并说明"不做"的理由——免得下一轮重新推一遍同样的判断。
> Windows 11 / Electron 39.2.7（Chrome 142）/ RDP 会话 / 单屏 1440×960 @2x。数字都来自 `apps/electron/spike/` 下的脚本。
> 停车窗的位置问题不在本文范围，见 [parking-window-position.md](./parking-window-position.md)。

## 一句话

页面上"被自动化看出来"的东西分三层：**不可信事件** > **不可能的取值** > **可疑的取值**。这一轮修掉了前两层里能修的，第三层里有两条判定为"不该修"。

---

## 1. 已修（工作区，未提交）

### 1.1 `fill` 不再伪造 DOM 事件

| | |
|---|---|
| 改前 | `this.value = ''` + `dispatchEvent(new Event('input'/'change'))` → 页面收到 **`isTrusted: false`** |
| 改后 | `DOM.focus` → 真实 `Ctrl/Cmd+A`（`keyDown`+`keyUp`）→ `Input.insertText`；读回值不符时用页面内 `select()` 重试一次 |
| 实测 | 旧：`input:false`、`change:false`；新：`keydown:true`、`beforeinput:true/insertText`、`input:true`，contenteditable 同样被正确替换 |
| 代码 | `apps/electron/src/main/browser-cdp.ts` `fillElement` / `sendSelectAll` / `readFieldValue` / `selectFocusedContents` |
| 依据 | `apps/electron/spike/parking-input-passthrough.report.json` 同源手法；取值实测见会话期 `fill-spike.cjs` |

### 1.2 权限不再"八项全 granted"

| | |
|---|---|
| 改前 | `setPermissionCheckHandler(() => true)` + 请求处理器 `callback(true)` → 8 类全 `granted` |
| 改后 | 白名单：`clipboard-read` / `clipboard-sanitized-write` / `display-capture` / `geolocation`，其余拒绝 |
| 实测 | 改前 `notifications/geolocation/camera/microphone/clipboard-read/clipboard-write/midi/persistent-storage` 全部 `granted`；真实 Chrome 多为 `prompt` |
| 代码 | `browser-pane-manager.ts` `setupSessionPermissions` |
| 注意 | `geolocation` 是**有意放行**的（本地搜索结果/门店定位是正常诉求）；它成为"众多 denied 里的一个 granted"，这是真实用户会有的形状 |

### 1.3 页面里的 `CRAFT` 全局名

| 位置 | 改前 | 改后 |
|---|---|---|
| 主题观察器 | `window.__CRAFT_THEME_OBSERVER_CLEANUP__`（document 生命周期常驻） | `window[Symbol.for('themeObserverCleanup')]` |
| 按键送达探针 | `window.__craftKeySeen` / `__craftKeyProbe`（**每次按键**都短暂出现） | 安装表达式返回的**闭包句柄** + `Runtime.callFunctionOn` + `releaseObject`，页面上不留任何属性 |

代码：`browser-pane-manager.ts` `installThemeObserver`、`browser-cdp.ts` `pressKey`。

### 1.4 `type` 的按键事件与节律

| | |
|---|---|
| 改前 | 7 个汉字 **24ms** 打完（间隔 2.5–5.9ms）；每次 `keydown` 是 `key='前' code='' keyCode=0` —— 键盘和输入法都不会发出；按下与抬起相隔 0.6ms |
| 改后 | 按预算分配节奏 `pace = clamp(4000ms/长度, 14, 180)` ±30% 抖动；按住 8–60ms；ASCII 逐键（`code=KeyA` 等），换行/制表走 `Enter`/`Tab`，**没有物理键的字符合并成一次 `Input.insertText`** |
| 实测 | 新：ASCII 键间隔 **152ms**、按住 **47–58ms**；中文 **0 个 keydown**、只有 trusted `beforeinput`/`input` |
| 代码 | `browser-key-map.ts` `typeSteps`；`browser-cdp.ts` `sendChar` / `sendStroke` / `typeText` |
| 遗留 | 这**不是 IME 仿真**：真的中文输入是 `compositionstart/update/end` + `keyCode 229` + `inputType: insertCompositionText`。现在的中文是一次性插入（同粘贴管线），所以"未通过输入法输入中文"这条判据**仍然成立**，只是不再有不可能存在的事件 |

---

## 2. 有意不改

### 2.1 `outerWidth === innerWidth`（无浏览器 chrome）

**不改**，因为要让它不等，只能把 `WebContentsView` 在窗口里偏移；而偏移量会原样出现在**一个恒等关系**上：

| 实测（窗口 (200,200) 1000×800，view 偏移 (50,90) 900×700） | 值 |
|---|---|
| 页面 `screenX/screenY` | 200,200（窗口原点） |
| 页面 `outer / inner` | [1000,800] / [900,700] → 差值 [100,100]（chrome 的样子） |
| 事件 `screenX − clientX` | **250,290**（view 原点） |

也就是说：`window.screenX` 与 `event.screenX − event.clientX` 会差 50/90px。**任何真实浏览器这两个都恒等**，所以这是"硬证据"；而 `outer == inner` 在真实 Chrome 里本来就有（F11 全屏、安装式 PWA）。用一个恒等关系的破坏去换一个弱特征，不划算。

### 2.2 `navigator.userAgentData.brands` 缺 `Google Chrome`

**暂不修**（2026-10-28 决定）。量清的部分先记在这里，将来要动时不必重跑：

| 阶段 | `brands` |
|---|---|
| 基线 | `Not_A Brand/99 \| Chromium/142` |
| `session.setUserAgent(cleanUa)` | 不变（**只改字符串**，碰不到 brands） |
| `Emulation.setUserAgentOverride` + `userAgentMetadata` | `… \| Google Chrome/142` ✅ |
| **附着状态下导航** | 保留 ✅（不需要每次导航重发） |
| **detach（哪怕不导航）** | **立刻回退** ❌ |
| 重新 attach、不重发 | 回退 ❌ |

- `userAgentMetadata` 的每个字段都能填成**原生值**（这台机器：`architecture: x86`、`bitness: 64`、`platformVersion: 19.0.0`、`wow64: false`、`formFactors: ['Desktop']`），所以覆盖不会留空洞。
- 修法只能是**会话常驻**：`idle detach`（`CDP_IDLE_DETACH_MS = 5s`）与它互斥。`idle detach` 的动机是"没有东西挂在会话上时释放"（`holdsSessionState()`），不是反检测。
- 还需要 bootstrap：metadata 只能从页面里读，所以要在标签页首次导航前拿到 → 启动时用隐藏探针窗口读一次并缓存（OS 级常量，不随标签页变）。
- **为什么暂不修**：boss 自己的安全包（`zhipin-geek/security/121/geek/index.js`）读 `userAgentData.brands`，但只把它 map 成 `brand=version|...` **拼进 device 串上报**（`getBrandStr`），没有"必须含 Google Chrome"的硬判据。它是**指纹成分**，不是门槛。
- 另外两条更重的备选（定制构建 / 改用系统真 Chrome）见会话记录：fork Electron+Chromium 的补丁只有 5–10 行，但单次构建 8–12 小时、每 4 周跟 Chromium、签名与自动更新自建 —— 代价是长期安全跟进。

### 2.3 其它 `__craft*` 全局

`__craftRecordingObserver`（录制中）、`__craftTweaks`（tweaks 生效时）、`__craftDiagram`（drawio 页）——作用域窄，且都只在用户显式启用的场景里出现，**不动**。

---

## 3. 复核方式

| 想验什么 | 跑什么 |
|---|---|
| 页面上还能读到哪些 craft 痕迹 | 在任意页 `Object.getOwnPropertyNames(window).filter(k => /craft/i.test(k))` |
| `fill` / `type` 的事件形状 | `apps/electron/spike/parking-input-passthrough.cjs` 的探针写法；重点是 `isTrusted` 与 `code` |
| 权限取值 | `navigator.permissions.query({name})` 逐项 + `Notification.permission` |
| brands 生命周期 | 会话期脚本 `brands-spike.cjs`（attach/detach/导航三态） |
| `outer == inner` 为何不改 | 会话期脚本 `viewoffset-spike.cjs` |

---

## 4. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-10-28 | 首版：`fill` / 权限 / craft 全局 / `type` 已修；`outer==inner` 与 `brands` 判定不改并记录依据 |
