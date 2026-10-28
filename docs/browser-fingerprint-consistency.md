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

### 1.2 权限：从"八项全 granted"到两层策略

| | |
|---|---|
| 改前 | `setPermissionCheckHandler(() => true)` + 请求处理器 `callback(true)` → 8 类全 `granted` |
| 改后 | **自己的 origin → 全放行**；**其他页面 → 地理位置、剪贴板读写**；摄像头与麦克风都是 `denied` |
| 实测 | 改前 `notifications/geolocation/camera/microphone/clipboard-read/clipboard-write/midi/persistent-storage` 全部 `granted`；真实 Chrome 多为 `prompt` |
| 代码 | `browser-pane-manager.ts` `setupSessionPermissions` / `ownsOrigin` / `ownOrigins` / `ownsUrl` |

**"自己的 origin"** = `file:` / `app:` / `localhost`·`127.0.0.1`·`::1` / `serverConfig.port` /
`serverConfig.publicWsUrl` / `clientConfig.connections[].url`（`ws(s)://` 先映射成 `http(s)://`）。
这份清单有 5 秒缓存：`navigator.permissions.query` 可以放在定时器里循环调用，而两个配置读取器都要读盘。

三条来自实测的取舍：

1. **`media`（摄像头 + 麦克风）留给第三方页面的是"未授予"** —— 而在 Electron 里那就是 `denied`。
   Chromium 的第三态（"还没回答过"）**从这个 API 出不来**：实测三组（Electron 39.2.7）——

   | handler | camera / microphone / geolocation / notifications | `Notification.permission` |
   |---|---|---|
   | 一个都不装 | **全部 `granted`** | `granted` |
   | check 返回 `false` | 全部 `denied` | `denied` |
   | check 返回 `true` | 全部 `granted` | `granted` |

   `prompt` 一次都没出现；而且**不装 handler 时默认是 `granted`**（不是 `denied`）——这解释了"全放行"
   为什么看起来像默认行为。所以"未决"只能落成 `denied`，代价是第三方页面据此藏起语音入口、
   `getUserMedia` 回 `NotAllowedError`；自己的 origin 不受影响（全放行）。
2. **`display-capture` 不给**——它**不 gate** `getDisplayMedia`。实测三组：权限 denied + 有
   `setDisplayMediaRequestHandler` → 仍然拿到 1 条视频轨；权限 granted + 没有 handler → `NotSupportedError`。
   决定能不能录的是 handler，而 handler 只会把**提问页自己的标签页**给出去，桌面永不出让。
   给它 `granted` 只多一个状态可读，代价是"先 query 再决定要不要显示录制按钮"的站点会自断功能。
3. **`geolocation` 有意放行**：本地搜索结果/门店定位是正常诉求，而"众多 denied 里的一个 granted"正是真实画像。

**第三方页面的语音输入：暂时放弃（2026-10-28 决定）**，将来作为用户设置提供。
现状是 `denied`，代价是这类页面藏起语音入口、`getUserMedia` 回 `NotAllowedError`——接受这个代价，
换的是"未授予"这个更保守的状态。要做成开关时，接法已经清楚：

- 一个偏好项（例如 `browser.allowThirdPartyMedia`，默认 `false`），放在 `packages/shared/src/config/preferences.ts`；
- 权限回调里**读实时值**，不要在建会话时读一次——session 是长期存在的，改了设置要立刻生效；
  `loadPreferences()` 已经很便宜，可以复用上面 `ownOrigins` 那种几秒缓存；
- 打开时把 `media` 加进第三方集合即可（摄像头/麦克风分开的需求到时再看：`mediaTypes` 能分，但
  `permissions.query` 只有 granted/denied 两个值，分开授权会让 `camera` 与 `microphone` 读作不同状态）；
- 设置页放浏览器那一栏，和 profile 之类的放一起即可。

### 这一层里，"状态"与"暴露"的界线

`granted` 本身不是暴露：真实用户允许过某个站点的麦克风或定位，页面读到的就是这个字符串，
所以第三方页看到 `microphone: granted` / `geolocation: granted` **无法**据此判断对面是不是人。
真正不可能的画像是一次性把通知、摄像头、麦克风、定位、MIDI、剪贴板、持久存储**全都**答成 `granted`——
那一组已经拆掉了。

还剩一个弱信号，性质不同：**`granted` + 从未来过**。

- Electron 的权限决定**不持久化**：装了 handler 之后，任何 origin 第一次问就得到 `granted`；
- 于是一个全新 partition（`document.cookie` 空、`localStorage` 空、`storage.estimate()` 用量 0）上的站点，
  第一次访问就报 `microphone: granted`；
- 真实用户走到 `granted` 必须先被问过一次，而"被问过"通常留下痕迹。

页面理论上能把这两件事对起来看。**有意不修**，因为三条可选做法都更差：

| 做法 | 问题 |
|---|---|
| 首次也 `granted`（现状） | 上述二阶矛盾，很弱 |
| 首次 `denied`，用户显式允许后才 `granted` | 语音输入首次不可用；产品没有权限提示 UI |
| 首次 query 答 `prompt`、真请求时放行 | **制造新矛盾**：查到 `prompt` 却一调 `getUserMedia` 就成功、没有 prompt 事件——比现状更像自动化 |

也就是说：这一层剩下的不是"消除暴露"，而是"不让状态彼此打架"，而现状是三种里唯一不制造矛盾的那个。

### 1.3 页面里的 `CRAFT` 全局名

| 位置 | 改前 | 改后 |
|---|---|---|
| 主题观察器 | `window.__CRAFT_THEME_OBSERVER_CLEANUP__`（document 生命周期常驻） | `window[Symbol.for('themeObserverCleanup')]` |
| 主题色回传通道 | `console.info('__craft_theme_color__:<token>:<color>')` —— **每个标签页都装**，站点 hook `console` 就能读到 | `console.info('~tcs~:<token>:<color>')` —— 通道仍可被观测（它就是 console），但不再自报是哪个工具；负载就一个颜色 |
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

### 1.5 `__electronLog` 不再进第三方页面

| | |
|---|---|
| 现象 | 任意站点页面的**主世界**里都有可枚举的 `window.__electronLog`（对象，8 个方法：`sendToMain` / `log` / `error` / `warn` / `info` / `verbose` / `debug` / `silly`） |
| 成因 | `log.initialize()` 的 `includeFutureSession` 默认 `true` → 每一个新 session 都被注册 electron-log 的 preload（`session.registerPreloadScript({type:'frame'})`）；浏览器窗格每个 profile 一个 partition（`browserPanePartition`），于是 preload 落到了第三方页面。该 preload 末尾是 `contextBridge.exposeInMainWorld('__electronLog', …)` → 名字进了主世界 |
| 改后 | `log.initialize({ includeFutureSession: false, includeFutureSessions: false })` —— 只覆盖默认会话（app 自己的窗口），浏览器 partition 不再被注册 |
| 为什么不掉日志 | 只有 `renderer/lib/logger.ts` 与 `renderer/lib/perf.ts` import `electron-log/renderer`，且二者只被 `App.tsx` 侧引用（默认会话）。工具栏 `browser-toolbar.tsx` 不碰它 |
| 代码 | `src/main/index.ts`（`log.initialize` 处） |
| 坑 | electron-log 5.4.3 的**实现**解构 `includeFutureSession`（单数），而**类型声明**写的是 `includeFutureSessions`（复数）。只传复数名能过类型检查但不生效；所以两个名字都传，并 `as unknown as Parameters<typeof log.initialize>[0]` |
| 页面视图本身没有 preload | `tabView` 的 `webPreferences` 只有 `session` / `contextIsolation` / `sandbox`，没有 `preload` —— 所以之前页面上那个全局 100% 来自 session 级注入 |

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
| **某个全局到底对站点可见吗** | 不能只在自己的求值环境里看 —— 它与页面主世界是两个 realm。用内联 `<script>`（一定在主世界执行）把结果写进 DOM 属性，再从求值侧读回来。反例：`browserToolbar` / `electronAPI` 在求值侧是 `undefined`（contextBridge 没暴露），但隔离世界里确有 electron-log 的东西 |
| 页面上多了哪些注入物（而非"名字里带 craft"） | 主窗口与**同源空白 iframe** 的 `window` 各取一次 `Object.getOwnPropertyNames` 做差集；注意 iframe 也会被 `type:'frame'` 的 preload 命中，做基线时先确认它干净 |
| `fill` / `type` 的事件形状 | `apps/electron/spike/parking-input-passthrough.cjs` 的探针写法；重点是 `isTrusted` 与 `code` |
| 权限取值 | `navigator.permissions.query({name})` 逐项 + `Notification.permission` |
| brands 生命周期 | 会话期脚本 `brands-spike.cjs`（attach/detach/导航三态） |
| `outer == inner` 为何不改 | 会话期脚本 `viewoffset-spike.cjs` |

---

## 4. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-10-28 | 首版：`fill` / 权限 / craft 全局 / `type` 已修；`outer==inner` 与 `brands` 判定不改并记录依据 |
| 2026-10-28 | 补 1.5：`__electronLog` 经 electron-log 的 future-session preload 注入到浏览器窗格的第三方页面；改为只覆盖默认会话。复核手法补"主世界 vs 求值世界"与"同源 iframe 差集"两条 |
| 2026-10-28 | 主题色回传前缀 `__craft_theme_color__:` → `~tcs~:`（同一理由：常驻每个页面，名字不该报出工具；已同步 `browser-pane-manager.test.ts` 的 6 处字面量） |
