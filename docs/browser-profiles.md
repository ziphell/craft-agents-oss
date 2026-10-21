# 浏览器多 profile — 设计文档

> **定位**：本文记录浏览器 profile 的完整机制：它是什么、profile 怎么解析、窗口与 tab 怎么归属、界面与 agent 命令面怎么表达。tab 的路由（cursor / active / 持有）见 [浏览器 tab 路由模型](browser-tab-routing.md)；窗口表面见 [浏览器窗口的材质与圆角](browser-window-chrome.md)。
>
> **一句话**：**一个 workspace 的每个 profile 各有一个窗口**；窗口身份是 `(workspaceId, profileId)`，tab 活在窗口里；对话的 profile 按 **自己的选择 → 项目默认 → 工作区默认 → Default** 解析，单条命令可以用 `--profile` 改写到另一个 profile。
>
> **状态**：已实现。

---

## 1. profile 是什么

- 一个**命名的 Chromium 持久化分区**：自己的 cookies、`localStorage`、缓存与登录态。两个 profile 就是两套账号，互不可见。
- 内置 **Default** 映射旧的 `persist:browser-pane`，所以升级后已有的登录都还在；其它 profile 使用 `persist:browser-pane-<id>`（`browserPanePartition`）。
- 注册表存在配置里（`getBrowserProfiles` / `saveBrowserProfiles`），`Default` 永远存在、排第一，且不能改名或删除。
- id 是不透明的稳定标识（如 `bp-…`），**改名只改显示名**，不改变 id、分区或窗口。
- profile 不是安全边界：同一 workspace 里，会话和人都能操作该 workspace 任意 profile 的窗口；真正的边界仍然是 workspace。

---

## 2. 为什么 profile = 窗口

一个 Chromium 分区不能在活页面下热切换——cookie jar 换不掉。于是"换 profile"不是换一个字段，而是**换一个窗口**：

- 一个 workspace 对每个 profile 最多一个浏览器窗口，身份是 `(workspaceId, profileId)`（`findWindow` / `createForSession`）。
- 同一 profile 的窗口被该 workspace 里所有工作在这个 profile 的会话、以及人共用。
- 每个窗口的 tab 独立计数，所以两个 profile 都可以有 `tab-1`；tab id 只在窗口内唯一。
- 关掉最后一个 tab 会关掉该窗口；窗口的 `terminate` 也只影响这一个 profile 的窗口。

---

## 3. profile 解析链

| 层级 | 存在哪 | 清除方式 |
|---|---|---|
| 会话自己的选择 | `Session.browserProfile` | 对话框选择"继承的那一项"时清空 |
| 项目默认 | `ProjectConfig.browserProfile` | 项目设置里留空（保存为 `''`，落盘时删除字段） |
| 工作区默认 | workspace settings 的 `defaults.browserProfile` | 留空 |
| 内置 | `Default` | 不可删除 |

`resolveConversationBrowserProfileId(session, project, workspace)` 按上表顺序取值。它是**每次读取**，不是建会话时的快照：改项目或工作区默认后，已存在对话的下一条命令、下一次 UI 解析就会用新值。

规则：

- **会话自己的选择优先，即使它指向的 profile 已被删除**。这是一个显式的「失效引用」：对话框会标出来，顶栏仍能操作那个窗口，但**不能发送消息**，必须先切到一个仍存在的 profile。
- 空字符串等于"没设置"，继续往下。
- **项目默认、工作区默认**是继承值，不是这个对话自己选的：它们指向已删除的 profile 时会被当作"没设置"，继续往下，最终回落到 Default。
- 项目设置在项目页的 Settings → 工作目录下方；留空即跟随工作区默认。
- 新会话、子会话都不需要复制一份 profile 值：它们沿用同一条解析链。子会话还会在创建时继承父会话的显式选择，作用与继承工作目录相同。

---

## 4. 窗口、tab 与共享

- 窗口属于 workspace + profile，**不属于某个会话**。会话在窗口里拥有的是 tab（`belongsTo`、`cursorOf`、`lockedBy`）。
- 因此父子会话、同 workspace 的多个对话可以在同一 profile 的窗口里各用一张 tab 并行工作。
- 跨 workspace 不可见：会话永远看不到另一个 workspace 的窗口，profile 相同也不行。
- 记住/恢复的窗口与 tab 按 `(workspaceId, profileId)` 存（`browser-tabs-state`）。
- 多窗口时，OS 任务栏 / Alt-Tab 里的窗口名就是 profile 名，不加前缀；只有一个窗口时仍是 `Craft Browser`（`syncWindowTitles`）。

---

## 5. 界面

### 5.1 设置 → 浏览器

- 新建、改名、删除 profile；`Default` 内置，不可改名/删除。
- 删除只移除注册表条目；分区与 cookies 留在磁盘上，重新用同一个 id 建 profile 还能接上。
- **会话自己的选择会被保留为「失效引用」**：对话框显示"已删除的 profile"（红色），那个窗口如果还开着，仍可从顶栏查看/操作它的 tab；但**发送被禁用**，必须先切到一个有效 profile。
- **项目/工作区的默认值**不是这个对话自己选的：指向已删除的 profile 时当作"没设置"，继续沿链往下，最终 Default。
- 顶栏把它当作一个可操作的遗留窗口，标签写作"已删除的 profile"；不会把它当成当前会话的有效 profile 来新开窗口。

### 5.2 工作区设置

- 「浏览器 profile」决定该 workspace 的默认 profile（`defaults.browserProfile`），可清空。

### 5.3 项目设置

- 项目详情 → Settings → **工作目录下方**的「浏览器 Profile」。
- 可留空；留空时该项目里的对话跟随工作区默认。
- 只影响"没有自己选择"的对话；对话在对话框里仍可覆盖。

### 5.4 对话框

- profile 选择器显示**当前生效的 profile**（会话 → 项目 → 工作区 → Default），菜单列出全部 profile。
- 选中"继承的那一项"（项目默认，没有则工作区默认，再没有则 Default）会清空会话自己的选择，继续跟随；选其他项则固定。
- tooltip 面向用户：`Agent 默认使用这个浏览器 profile。`

### 5.5 顶栏

- 只有一个浏览器控件，**跟随对话**，不跟随"人最后点过的窗口"；注意力不是 profile 选择。
- 有窗口时显示该 profile 窗口的徽标：favicon + 网页标题 + 标签数；徽标上**不重复显示 profile 名**。
- 该 profile 没有窗口时只显示地球图标（tooltip：打开浏览器），不再显示 profile 名；只有内置 `Default` 一个 profile 时，点地球**直接打开**，不出只有一项的下拉。
- 对话选中的 profile 被删除后，顶栏仍指向该 profile 的旧窗口（如果还开着），标签显示"已删除的 profile"；它不会自动切到别的窗口，但该对话的发送会被禁用。
- 下拉菜单：
  - 使用该 profile 的浏览器窗口平铺展示（profile 标题行 + 该窗口的 tab + 窗口操作）；
  - 其它窗口收进二级菜单，条目上带 profile 标识；
  - 还没有窗口的 profile 平铺列出，点击即打开该 profile 的窗口。

### 5.6 浏览器窗口内部

- tab 栏顶部的 band 里、rail 折叠按钮右侧显示该窗口的 profile 名（多 profile 时）。
- 窗口内的 tab 属于同一个 profile；profile 切换不在这里发生，而是换一个窗口。

---

## 6. agent 命令面

`browser_tool` 的每条命令都可以带 `--profile <name-or-id>`：

- **name 和 id 都支持**；匹配去空格、大小写不敏感；同名/歧义或不存在都会被拒绝，并列出可用 profile（`resolveBrowserProfileRef` / `resolveProfileIdOrThrow`）。
- `--profile` 只作用于这一条命令，所以**一个对话可以同时调度多个 profile**。
- **不传 `--profile`**：使用对话当前生效的 profile（§3 的链），按命令实时解析；不会按 cursor tab 所在的窗口推断，也不会在选中了其它 profile 时回落 Default。
- `tabs` 不带 `--profile` 时列出该 workspace 的所有窗口（供发现 tab id）；`tabs --profile Work` 只看那个 profile 的窗口。
- 多窗口时，`navigate` 的回执会带上本次落到的 profile 名（避免两个 profile 的 `tab-1` 混淆），`tabs` 也按窗口标注 profile。
- **改名**：id 稳定；显示名变化会在下一轮的 volatile 上下文里更新（`browserProfile` 行）。同一轮里继续用旧名字传 `--profile` 会报错并列出当前名字/id，而不是静默落到别的 profile。
- **子会话**：继承父会话的浏览器 profile（父会话有显式选择就继承它；没有则沿用同一项目/工作区链），与继承工作目录同构。
- **失效引用**：对话自己选的 profile 被删除后，发送会被拒绝（界面禁用发送，服务端也拒绝非隐藏消息），直到切到有效 profile；它的旧窗口仍可通过顶栏操作。

---

## 7. 前缀缓存

profile 信息只放在每轮重新生成的 **volatile 用户尾部**（`<session_state>`）：

```
browserProfile: <name>
browserProfileNote: browser work that names no profile lands in this account; ...
browserProfileChanged: the user switched ... (一次性)
```

- 系统提示前缀与历史消息不重新写入，所以切换 profile 不会使首轮前缀缓存失效。
- `browserProfileChanged` 是**一次性**的，只在该轮说明"用户换了 profile"；改名不会触发它。
- profile 值每次解析都从注册表读当前显示名，因此改名在下一轮可见。

---

## 8. 实现位置

| 事项 | 位置 |
|---|---|
| profile 类型、解析链、`--profile` 引用解析 | `packages/shared/src/config/browser-profiles.ts` |
| 注册表读写 | `packages/shared/src/config/storage.ts` |
| 项目字段 | `packages/shared/src/projects/types.ts`、`projects/storage.ts` |
| 会话 profile 解析、命令绑定、提示状态 | `packages/server-core/src/sessions/SessionManager.ts`（`getBrowserProfileForSession` / `buildBrowserPaneFns` / `setSessionBrowserProfile`） |
| 对话框/顶栏的解析 RPC | `packages/server-core/src/handlers/rpc/browser-profiles.ts` |
| 分区、窗口身份、窗口标题 | `apps/electron/src/main/browser-pane-manager.ts` |
| 桌面端窗口创建时的 profile 解析 | `apps/electron/src/main/index.ts`（`setProfileResolver`） |
| 对话框选择器 | `apps/electron/src/renderer/components/app-shell/input/CompactProfileSelector.tsx` |
| 顶栏控件与下拉 | `apps/electron/src/renderer/components/browser/BrowserTabStrip.tsx`、`BrowserTabBadge.tsx` |
| 项目设置项 | `apps/electron/src/renderer/pages/ProjectInfoPage.tsx` |
| 工作区/浏览器设置页 | `apps/electron/src/renderer/pages/settings/WorkspaceSettingsPage.tsx`、`BrowserSettingsPage.tsx` |
| agent 手册 | `apps/electron/resources/docs/browser-tools.md` |
| 命令行解析 | `packages/shared/src/agent/command-cli.ts`（`extractProfileTarget` / `withProfile`） |
| 提示注入 | `packages/shared/src/agent/browser-profile-prompt-state.ts`、`mode-manager.ts` 的 `formatSessionState` |

---

## 9. 被否决的方案

- **一个会话一个窗口**：窗口数量随对话增长，人无法在一个窗口里看到所有人在干什么。
- **一个窗口里放多个 profile / tab 级 profile**：cookie jar 属于 Chromium session，页面不可能逐 tab 切换账号。
- **未传 `--profile` 一律用 Default**：项目/工作区的默认 profile 就失去意义，agent 每次都得显式写出对话自己的 profile。
- **按 cursor tab 推断 profile**：agent 最近工作的 tab 与"这个对话设置的 profile"是两件事，混在一起会让切换 profile 后的落点不可预期。
- **切换 profile 时原地换 cookie jar**：活页面下不可行；只能换窗口，tab 留在原窗口。
