# 浏览器窗口 rail 的交互 — 开发文档

> **定位**：本文只写**独立浏览器窗口**（`browser-pane-manager` 创建的那个无边框窗口）左侧 **rail** 的**交互**：一个 tab 行的「切」是什么、为什么在**按下**触发、键盘怎么兜底，以及 rail 上其余可点元素各自是什么。不重复 [材质与圆角](browser-window-chrome.md)（窗口表面），也不重复 [任务栏文档](browser-taskbar-plan.md)。
>
> **一句话**：**切 tab 是「按下」这件事，不是「松开」**——和浏览器自身的 tab 一样；键盘没有「按下」，所以它保留 click，但只认自己合成的那个（`detail === 0`）。
>
> **状态**：已实现。
>
> **读法**：§1 一个 tab 行是两个按钮；§2 按下即切（含键盘兜底）；§3 rail 上其余可点元素；§4 与顶栏 tab 列表的分工；§5 代码位置；§6 取舍与边界。

---

## 1. 一个 tab 行：它是几个并排的按钮，不是一整块

rail 的每一行（`TabRail`）是一个 `div`，里面并排若干**兄弟**元素：

| 元素 | 是什么 |
|---|---|
| 行主体 `<button>` | 切到这个 tab |
| 关闭 `<button>`（`×`） | 关掉这个 tab |
| 锁 `<button>`（仅被 agent 持有时） | 放开持有 |
| 驱动点 `<span>` | 只报状态，不可点 |

**兄弟而不是嵌套**是这一节的要点：行主体是 `<button>`，而按钮里不能再放按钮，所以关闭 / 锁只能是它的兄弟。这也顺带决定了 §2 的一条边界——点 `×` 不会顺带触发切 tab。

---

## 2. 「切」发生在按下，不在松开

行主体上挂两条处理：

```tsx
onMouseDown={(event) => { if (event.button === 0) onSelect(tab.id) }}
onClick={(event) => { if (event.detail === 0) onSelect(tab.id) }}
```

**为什么是按下。** 浏览器自己的 tab 就是按下即切：手指一落，tab 就换过来，松开在哪不影响这次选择。这也与 app 自己的行一致——会话行（`SessionItem`）、项目行（`ProjectsListPanel`）都走 `onMouseDown`。

**为什么判左键。** 只认 `button === 0`：右键留给它将来的语义（rail 目前不画自己的菜单，见 §6），而行的其余按钮是兄弟（§1），它们的按下不会冒泡到这里。

**键盘怎么兜底。** 键盘没有「按下」这个动作：Enter / Space 落在 `<button>` 上产生的是一个 **click**，其 `MouseEvent.detail === 0`。所以 `onClick` 保留，但**只认 `detail === 0`**——鼠标松开产生的 click（`detail >= 1`）是上面那次按下的收尾，认它就是把同一次切换做两遍。

由此得到一条不变量：**一次切换只有一个来源**——鼠标走 `onMouseDown`，键盘走 `onClick`，两者互斥。

---

## 3. rail 上其余可点元素

它们都是**离散按钮**，不是「这一行是哪个 tab」，所以仍旧 `onClick`（松开生效）：

| 元素 | 语义 | 落点 |
|---|---|---|
| 分组表头的 `+` | 为这一段工作新开一个 tab | `onNewFor(work)` → `tabAction('new', undefined, work)` |
| 顶栏左端的 `+` | 给自己新开一个 tab | `handleNewTab` → `tabAction('new')` |
| 顶栏左端的折叠开关 | 收起 / 展开 rail | `toggleRailCollapsed()` |
| 行的 `×` | 关这个 tab（关掉最后一个等于关窗） | `tabAction('close', tabId)` |
| 行的锁 | 放开 agent 的持有 | `tabAction('release', tabId)` |

rail 的**列本身**是 `titlebar-drag-region`（拖窗），上面这些可点元素各自带 `titlebar-no-drag`，所以「点」与「拖」互不误伤。

---

## 4. 与顶栏 tab 列表的分工

顶栏那枚窗口徽标展开的是**菜单**（`BrowserTabStrip`），条目保持菜单语义（松开生效），**故意**不跟 rail 一起改成按下：菜单里一次误按可能顺带选中一项，而 rail 的行是常驻列表，按下即切才是它该有的手感。

两处画的是同一份「窗口有哪些 tab」（`groupTabsByWork`），但**触发语义各自成立**：列表按下即切，菜单松开生效。

---

## 5. 代码位置

| 文件 | 符号 | 职责 |
|---|---|---|
| `apps/electron/src/renderer/browser-toolbar.tsx` | `TabRail` 的 tab 行 | `onMouseDown`（左键）/ `onClick`（`detail === 0`） |
| 同上 | `handleSelectTab` | `tabAction('activate', tabId)` |
| 同上 | `handleNewTab` / `handleNewTabForWork` / `handleCloseTab` / `handleReleaseLock` / `handleToggleRail` | 其余按钮各自的 `onClick` |
| `apps/electron/src/preload/browser-toolbar.ts` | `tabAction` / `toggleRailCollapsed` | 转 IPC |
| `apps/electron/src/main/browser-pane-manager.ts` | `TOOLBAR_CHANNELS.TABS` 的处理 | `activate` / `close` / `release` / `new` 分派 |
| 同上 | `activateTab()` | 已经在前面的 tab：只把键盘交给它（`focusShownTab`），其余不动 |
| 同上 | `closeTab()` | 关掉最后一个 tab 等于 `destroyInstance` |
| `apps/electron/src/renderer/index.css` | `titlebar-drag-region` / `titlebar-no-drag` | 拖窗与「看见的东西」的分界 |

---

## 6. 取舍与边界

- **`detail === 0` 是这套写法的支点。** 它区分「键盘合成的 click」与「鼠标松开的 click」，让一次切换只有一个来源（§2）。这也是本仓库唯一一处依赖 `detail === 0` 的地方——**换写法时先看这里**。
- **重复激活本身是安全的，但不靠它安全。** `activateTab()` 对已经在前面的 tab 只做 `focusShownTab` 并返回；即便如此，上面仍把「一次切换一个来源」当约束，而不是靠幂等兜住重复。
- **rail 目前没有自己的右键菜单。** 所以左键判定（`button === 0`）当下的作用是「别把将来的右键语义占掉」，而不是在挡一个已存在的菜单。
