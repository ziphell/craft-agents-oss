# 远程连接（Remote Connections）— 设计文档

> **定位**：把「另一台机器上的 Craft Agent 服务器」当作一等运行目标，用窗口去连它；窗口里的工作区、会话、文件和 agent 都真在那台机器上。
>
> **一句话**：**窗口 = (服务器, 工作区)**。服务器是应用级保存的连接，工作区是那台服务器上的目录对象；本地窗口和远程窗口可以在同一个进程里并存。
>
> **对照物**：VS Code Remote-SSH 的 remote host + workspace 两级结构——但这里连的是 Craft Agent hub（WS + token），不是 SSH。

---

## 1. 模型

### 1.1 为什么没有「远程工作区」

旧形态里工作区可以挂一个 `remoteServer`，于是「工作区」同时表达「本地目录」和「另一台机器上的目录」，一个窗口到底在读哪台机器的文件无法从窗口本身回答。现在：

- **服务器**是应用级对象：保存一次，任何窗口都能连；托盘、工作区菜单、Connect 对话框都能打开它。
- **工作区**属于服务器：它出现在哪台服务器的列表里，就住在哪台机器上。
- **窗口**在创建时绑定到一台服务器（`RemoteWindowTarget`），之后只在这台服务器内部换工作区。

由此得到的不变量：

| 不变量 | 理由 |
|---|---|
| 窗口的服务器不变，只有工作区会变 | 传输、token、TLS 信任都是按窗口建立的；换服务器等于换窗口 |
| 远程窗口里新建/删除工作区落在**那台**服务器 | `workspaces:CREATE` / `server:REMOVE_WORKSPACE` 是 REMOTE_ELIGIBLE |
| 本地窗口与远程窗口并存 | 每窗口一条 hub 连接；本地主进程始终有一个嵌入式 server |
| 同名工作区不互相串 | 浏览器状态按 `hub:<connectionId>:<workspaceId>` 归档；设备文件根按 `<hub device id>/<workspaceId>` |

### 1.2 两类「连接」

| 连接 | 数量 | 承载 | 生命周期 |
|---|---|---|---|
| **窗口连接** | 每个窗口一条（远程窗口连 hub，本地窗口连本机 server） | REMOTE_ELIGIBLE 的全部 RPC 与事件 | 跟随窗口；换工作区只改服务端登记的作用域（`updateClientWorkspace`），不断连 |
| **本机连接** | 每个窗口一条 | LOCAL_ONLY：窗口控制、原生对话框、主题、本机草稿路径 | 跟随窗口；本地窗口里它就是窗口连接 |
| **应用级链路** | 每个已保存服务器一条（有 url + token 的） | 设备能力：`client:device:exec` / `client:device:fs` / `client:browser:invoke` | 跟随配置：保存即建、删除即断、地址或 token 变更即重建 |

应用级链路的意义：hub 可以在**没有任何窗口**的时候驱动这台机器（shell / 文件 / 浏览器），并且不会打到一个正在关闭的窗口上。窗口只声明它自己能回答的能力：打开外链、打开路径、在文件管理器中显示、原生确认框、打开/保存文件对话框。

---

## 2. 保存的服务器

```ts
interface RemoteConnection {
  id: string            // 稳定标识，改名/换 token 不变
  name: string          // 徽标、工作区菜单、窗口标题里显示的名字
  url: string           // ws:// 或 wss://
  token: string         // 握手 token
  lastWorkspaceId?: string  // 下次打开这台服务器时的默认工作区
}
```

- 列表存在本机 config 的 `clientConfig`（`packages/shared/src/config/client-config.ts`、`storage.ts`）。
- URL 相同即同一台服务器：`saveRemoteConnection` 复用已有 id，不会因为「添加一次」出现两条。
- **编辑的语义**：只带要改的字段；`id` 决定「更新哪一条」，`lastWorkspaceId` 在调用方没给时保留——改名、换地址、轮换 token 都不丢「上次在哪」。
- 旧数据迁移：workspace 级的 `remoteServer` 折叠进连接列表（每个 URL 一条），并从本地工作区列表移除，标记 `workspace-level-remote-removed`（只跑一次）。

### 2.1 编辑后正在运行的窗口

窗口的 hub socket 是在 preload 加载时按 target 建好的。地址或 token 改变后：

1. 主进程更新每条受影响窗口的 `RemoteWindowTarget`，发送 `client-mode:target-changed`；
2. preload 用新凭据重建 socket（make-before-break：重新挂能力、重订阅监听、切换连接状态委托、销毁旧 socket，并触发一次 stale reconnect）。凭据换不到活 socket 上；**换服务器**同理，是另一处需要新 socket 的操作。换工作区不重建。
3. 渲染端通过 `onRemoteTargetChanged` 更新主机徽标和窗口标题。

只改名字不重建连接。

---

## 3. 窗口

- `RemoteWindowTarget { connectionId, url, token, workspaceId?, name? }` 由主进程在窗口创建前写入，preload 通过同步 IPC `__get-client-mode` 读取（必须早于首个渲染 tick）。
- 重启恢复：窗口状态只存 `{ connectionId, workspaceId }`，启动时若该连接已被删除，窗口不恢复；该工作区在服务器上已不存在时，窗口按"这台服务器、没有工作区"打开，落到工作区选择器。**每次换工作区、换服务器、回到本机都会立即写一次窗口状态**（`captureAndSaveWindowState('window-change')`），因此强制结束进程后重启，恢复的仍是当前模式与工作区，而不是上次正常退出时的。
- 标题：远程窗口的工作区不在本机 config 里，主进程查不到名字，因此由渲染端设置 `<工作区> — <服务器>`（`window:set-title`，主进程把它记为 `customTitle`，窗口增减时不被默认规则覆盖）。
- 远程身份：顶栏工作区胶囊旁有主机徽标（主机名 + 连接状态点）。点击进入 Settings → Server。
- 打开一个远程目标的入口：
  - Connect to Server…（新增 / 列表里 Open）
  - 托盘 → Remote servers → 某台服务器（打开它上次的工作区）
  - 工作区下拉 → Remote servers → 某台服务器的某个工作区：**就地换过去**（见 §4.2）——本地窗口借此建立 hub 连接，远程窗口借此换服务器；⌘/Ctrl 强制新开一个窗口
  - 工作区下拉 → Remote servers → **本机** → 某个工作区（只在窗口连的是另一台机器时出现）：释放 hub 连接，窗口回到本机
  - 新建/打开工作区时选择远程主机 → 在该服务器建好工作区后自动开窗

---

## 4. 传输与通道

### 4.1 分流

`packages/shared/src/protocol/routing.ts` 只有两个集合：

- **LOCAL_ONLY**：必须在本机回答的东西——窗口控制、原生文件/文件夹对话框、shell 打开、系统信息、主题的应用级部分、`workspaces:GET`（本机列表）、`file:readUserAttachment`（本机草稿路径）。
- **REMOTE_ELIGIBLE**：其余全部，交给窗口的 workspace 客户端——会话、文件读写、fs、项目、server 接口、**浏览器（与 shell 同一条规则：窗口属于哪台服务器，浏览器就在哪台）**、以及**跟随服务器的设置**（appearance / caching / rtk / decisions / tools）与 onboarding 判定。

注意工作区列表：渲染端拿列表走的是 `server:getWorkspaces`（REMOTE_ELIGIBLE，答案跟随窗口所在服务器）；`workspaces:GET` 只用于本机内部读取。因此远程窗口的下拉里放的是 hub 的工作区，本地窗口放的是本机的工作区。

`RoutedClient` 按集合选客户端；换工作区时 `switchToWorkspaceClient(next)` 重新订阅 REMOTE_ELIGIBLE 监听，UI 只感知为一次重连。

### 4.2 重连

- `autoReconnect` + 指数退避；连接状态（idle / connecting / connected / reconnecting / disconnected / failed）驱动 UI 的横幅与徽标状态点。
- 服务端为每个客户端保留带 `seq` 的事件缓冲（TTL + 上限）；重连后补发，`__transport:reconnected(isStale)` 告知渲染端是否需要全量刷新。
- 换凭据产生的是**新 socket**，`RoutedClient` 会合成一次 `isStale = true` 的 reconnected，复用同一套恢复逻辑。
- 换工作区**不是**新 socket：服务端 `updateClientWorkspace` 改这条连接的登记，preload 随后合成一次 stale reconnected，让 UI 丢掉旧工作区的列表。
- **换服务器是"先连上、再换"**：`client-mode:resolve-switch` 只解析并校验目标（不动任何状态），preload 用新 url/token/workspace 建 socket 并**等握手成功**，之后 `client-mode:switch-server` 才落窗口记录，`RoutedClient` 才替换 workspace 客户端并销毁旧 socket。连不上时整个切换不发生——窗口、当前工作区、会话列表都不动，只多一条失败提示。旧服务器上的其它窗口、以及它的应用级设备链路都不受影响。
- **本地 → 远程**是同一条路径的起点：本地窗口没有 target，`switchRemoteServer` 建出第一条 hub socket 并等它握手成功，窗口才从此是远程窗口；main 的窗口记录补上 `remote`，下次启动按远程恢复。连不上则窗口仍是本地的。
- **远程 → 本地**是反向：`client-mode:switch-local` 先清掉 main 的 `remote` 记录与自命名标题，preload 再用 `RoutedClient.switchToLocalClient()` 把 workspace 客户端换回一直在线的本地 client（销毁 hub socket）。这条没有握手，所以 stale reconnect 由这次切换自己合成。
- 状态有两个问题、两个来源：**这扇窗口能不能工作**读它自己的 socket（横幅、顶栏徽标、Connect 对话框里本窗口那台服务器）；**这台机器能不能连上某台服务器**读应用级链路（列表里其它服务器的点，它们可能根本没有窗口）。

### 4.3 直连 IPC（不走窗口的 transport）

这几类必须能作用于「不是本窗口所在」的服务器，因此走 `ipcMain.handle`：

| IPC | 用途 |
|---|---|
| `client-mode:get` / `save-connection` / `remove-connection` | 本机保存的服务器列表 |
| `client-mode:connect` / `open-window` / `open-local` / `switch-workspace` / `switch-server` / `switch-local` / `test` | 开窗、换工作区、换服务器、回到本机、试连 |
| `client-mode:remote-list-directory` / `remote-home-dir` / `remote-check-slug` / `remote-create-workspace` | 新建工作区时对**选定主机**的浏览与创建 |
| `client-mode:remote-workspaces` / `remote-status` | 工作区下拉的二级菜单、服务器在线状态 |
| `window:set-title` | 远程窗口自命名 |

`remote-*` 系列跑在那台服务器自己的应用级链路上，不借用当前窗口的 socket。

---

## 5. 工作区：两级创建与快速打开

### 5.1 新建 / 打开（本地窗口）

1. **Host**：本机 + 每个已保存服务器（没有保存服务器时整行不显示）。
2. **Workspace**：
   - 打开已有文件夹：在该主机上浏览目录（本机走原生对话框；服务器走 `ServerDirectoryBrowser`）。
   - 新建：默认位置由**该服务器**的 `checkWorkspaceSlug` 回答；自定义位置在那台服务器上浏览。
3. **落地**：本机 → `workspaces:CREATE` + 当前窗口切换；服务器 → `client-mode:remote-create-workspace`（在 hub 上 `addWorkspace`，按 `rootPath` 去重，已存在的目录等同「打开已有工作区」）→ 打开绑定该服务器的远程窗口，并把它记为该服务器下次的默认工作区。

远程窗口里这行 Host 不出现：窗口本身就是那台主机。

### 5.2 远程窗口没有工作区

`WorkspacePicker`：列出该服务器的已有工作区；新建时可选服务器默认位置或该服务器上的任意目录（`workspaces:CREATE`），建好后在本窗口内切换。

两种情况会落到这里：
- 窗口状态里记住的工作区已经在服务器上被删除（启动恢复时先向该服务器的应用级链路核对，问不到就按原值打开）；
- 连接正常但工作区为空。

**切到一个已被删除的工作区会被拒绝，窗口留在原地**：下拉菜单是打开时的快照，同服务器切换由 preload 先向 hub 核对（`server:getWorkspaces`），换服务器由主进程向目标服务器的链路核对（`workspaceIdsOn`）。问不到列表（链路没起来、旧版服务器）时不拦，交给连接自身的失败去说明。

### 5.3 工作区下拉

窗口自己的工作区列表在上；`Remote servers` 分组里每台服务器是一个子菜单，点某个工作区就把**这个窗口**换过去（⌘/Ctrl 则新开一个窗口）。**本机**作为一个分组出现在连的是**另一台机器**的窗口里（点它回到本机）；窗口连的就是本机自己的服务器时（LAN 地址、隧道），本机不会重复出现——工作区 id 完全相同即判定为同一台机器。列表每次打开时拉取，某台服务器不可达只影响它自己的子菜单。

---

## 6. 文件、附件、浏览器

| 对象 | 位置 | 说明 |
|---|---|---|
| 工作区文件 | hub | 窗口的 `file:*` / `fs:*` 由 hub 回答，路径是 hub 的真实路径 |
| 会话附件 | hub（`<workspace>/sessions/<id>/attachments`） | `file:storeAttachment` 在 hub 执行；缩略图/Office→markdown 也在 hub |
| 浏览器窗口 | **hub（工作区所在服务器）** | 与 shell 同一条规则：本地窗口开本机浏览器，远程窗口开 hub 上的浏览器；客户端只画帧、送回输入（`RemoteBrowserPanel`，见 [browser-view-streaming.md](browser-view-streaming.md)）。hub 没有浏览器（headless / WebUI-only）时不注册 `browser_pane` 相关通道与 `browser_tool`，跨机器浏览器只能由 `device_tool` 点名 |
| 链接与预览 | 动作在服务器，渲染在客户端 | 应用内浏览器的链接/文件开在工作区服务器，`openUrl`/`openFile` 返回 `{instanceId, tabId}`，客户端据此打开观看面板；只有显式“在系统浏览器打开”（设置关闭，或用户选择）才回本机。Markdown/HTML/PDF 预览在客户端渲染、内容走 RPC；HTML 预览里 React 看不到的链接由主进程截获后交给渲染端走同一条 openUrl 路径 |
| drawio 编辑器 | **客户端资源** | 桌面窗口（含远程窗口）用本机 app 的 `craft-local://`（`drawio:getOrigin` 是 LOCAL_ONLY）；webui 由 hub 在 `/drawio/` 同源提供，走会话 cookie 鉴权，图表数据仍通过 postMessage |
| 设备工作目录 | 客户端 | hub 把本机当设备时，只服务 `<config>/.hub/<hub device id>/<workspace id>`，不暴露任意本地路径 |

附件有两种来源，形状一致（`FileAttachment`）：

- **本机文件**：renderer 读取字节 → base64 随 RPC 上传；
- **服务器上的文件**：`file:readBinary` 从 hub 读回字节；路径只在那台机器上有意义，命中敏感路径规则同样被拒绝。

草稿用 `DraftAttachmentRef.fromServer` 区分：远程窗口里从服务器挑的文件，重新打开会话时**从 hub 重读**，绝不按同名字符串去读本机磁盘。

本地专属动作在远程窗口里不装作可用：`openFile` / `showInFolder` 提示「这个文件在服务器上」，菜单项直接隐藏。

---

## 7. 设置与身份

- **跟随服务器的**：agent 行为、工具开关、onboarding 判定（`onboarding.GET_AUTH_STATE` / `VALIDATE_MCP` / `DEFER_SETUP`）、工作区增删。换窗口看同一工作区，设置一致。
- **留在客户端的**：窗口/主题外观、原生对话框、shell、系统信息、`file:readUserAttachment`（草稿里是本机路径）、MCP OAuth 的本地 loopback 回调。
- 客户端身份（`deviceId` / `name` / `platform` / `version`）随每次握手上报；hub 用它在设备列表和 `device_tool` 里点名这台机器。
- **版本协商只认两样东西**：protocol major（信封形状）+ 逐通道能力（`registeredChannels`、`clientCapabilities`，客户端用 `isChannelAvailable` 判断）。app 版本（`clientInfo.version` / `serverVersion`）只用于展示与诊断，**不是**连接门槛；major 不等时握手拒绝，错误里同时给出两端版本与“升级任一端”的指引。新增功能走通道与可选字段，不升 major。webui 标签页没有 app 版本，`version` 可为空。

---

## 8. 信任与安全

- token 存在本机 config、随握手发送；**保存一台服务器 = 允许它把本机当设备**（exec / 文件 / 浏览器）。删除即撤销；界面上的「在线状态点」读的就是这条链路的真实状态。
- TLS：保存的 origin 允许自签证书（`trustServerOrigin` + `tlsRejectUnauthorized: false`），等价于 SSH 的首次信任，但**没有指纹展示/固定**。
- `allowRemoteEvaluate`（默认开）可关闭「远程 agent 在本机浏览器上执行 evaluate」。
- 设备文件/命令请求必须带 hub + workspace 两个标识，缺一即拒绝：不存在「没有 hub 上下文就操作本机工作区」的回退。
- 敏感文件名（`.env`、密钥、`credentials.json` 等）在 hub 的读写边界内统一拦截。

---

## 9. 与 VS Code Remote-SSH 的对照

| 能力 | 现状 |
|---|---|
| host 列表、host → workspace 两级、窗口绑定 host | 对齐 |
| 一台主机多窗口、窗口内换工作区 | 对齐 |
| 重启恢复远程窗口、断线自动重连 | 对齐（带 seq 补发与 stale 重载） |
| 远程文件夹 = 工作区、在本机建远程工作区 | 对齐（且 hub 端按路径去重） |
| 远程身份可见（标题/状态） | 已对齐（标题 + 顶栏徽标 + 状态点） |
| 主机编辑（名字/地址/token）与在线状态 | 已对齐（编辑保留 lastWorkspaceId；在线状态点） |
| 远端零安装 / 自动引导 | **无**：需先在主机运行 server 并复制 token（产品选择） |
| 主机发现（ssh config 式） | **无**：手动填写 `ws://` |
| 端口转发 / 隧道 | **无**：hub 上的 dev server 需自行建隧道 |
| 就地 `Reopen in Remote` / `Close Remote Connection` | **无**：窗口在创建时绑定 host，换 host 即换窗口 |
| host key 指纹固定 | **无**：按 origin 信任自签证书 |

被刻意保留的差异：这里可以让 **hub 反过来驱动本机**（设备能力），VS Code 只有「本地驱动远端」一个方向；因此「保存服务器」同时是一次设备授权，界面上要能撤销。

---

## 10. 代码地图

| 关注点 | 位置 |
|---|---|
| 连接的读写、迁移、lastWorkspaceId | `packages/shared/src/config/client-config.ts`、`config/storage.ts` |
| 通道分类 | `packages/shared/src/protocol/routing.ts` |
| 窗口 target、开窗 | `apps/electron/src/main/index.ts`（`remoteTarget`、`client-mode:*`） |
| 窗口状态与标题 | `apps/electron/src/main/window-manager.ts`、`window-state.ts` |
| 应用级设备链路与状态 | `apps/electron/src/main/hub-connection.ts` |
| 会话的浏览器宿主 | `packages/server-core/src/sessions/SessionManager.ts`（`getBrowserPaneManagerForSession` 只返回本机 BPM；没有本机浏览器就没有 `browser_tool`） |
| 远程窗口的浏览器观看端 | `apps/electron/src/renderer/components/browser/RemoteBrowserPanel.tsx`（顶栏 globe；帧流与 webui 同一套协议） |
| 设备能力（exec/fs/browser） | `apps/electron/src/main/device-access.ts`、`packages/server-core/src/transport/device-capability.ts`、`packages/server-core/src/transport/capabilities.ts` |
| 设备工作根 | `packages/shared/src/config/device.ts`（`HUB_ROOT_BASE`、`hubWorkspaceRoot`） |
| preload 路由与重建 | `apps/electron/src/preload/bootstrap.ts`、`apps/electron/src/transport/routed-client.ts` |
| 新建工作区（两级） | `apps/electron/src/renderer/components/workspace/AddWorkspace_HostPicker.tsx`、`AddWorkspaceStep_*.tsx`、`WorkspaceCreationScreen.tsx` |
| 无工作区的远程窗口 | `apps/electron/src/renderer/components/workspace/WorkspacePicker.tsx` |
| 工作区下拉的远程分组 | `apps/electron/src/renderer/hooks/useRemoteWorkspaceGroups.ts`、`components/app-shell/WorkspaceSwitcher.tsx`、`CompactWorkspaceSwitcher.tsx` |
| 远程身份 | `apps/electron/src/renderer/components/app-shell/RemoteHostBadge.tsx`、`renderer/App.tsx`（标题） |
| 主机管理 | `apps/electron/src/renderer/components/app-shell/ConnectServerDialog.tsx` |
| 远程目录浏览 | `apps/electron/src/renderer/components/ServerDirectoryBrowser.tsx`、`renderer/hooks/useDirectoryPicker.ts` |
| 服务器文件附件 | `apps/electron/src/renderer/lib/server-attachments.ts`、`lib/drafts.ts` |

---

## 11. 验证

- 通道稳定性：`ipc-channels.test.ts`（RPC 通道集合）、`channel-map-parity.test.ts`（ElectronAPI ↔ CHANNEL_MAP，新增直连 IPC 必须显式登记）。
- 连接存储：`client-config-connections.test.ts`（旧形态折叠、编辑保留 id / lastWorkspaceId / 默认标记）。
- 隔离：`browser-pane` 的两个 hub 同名工作区测试；`hub-root.test.ts`（设备根路径与非法 id）。
- 路由：`routing.test.ts`（哪些通道跟随服务器）。
- 草稿：`drafts.test.ts`（`fromServer` 标记）、`server-attachments.test.ts`（服务器文件 -> `FileAttachment`）。

---

## 12. 演进：连接归应用（Protocol v2，尚未实现）

> §1–§11 描述的是**当前实现**。本节是目标形态与规格，代码尚未按此改造。
>
> 已落地的前置只有两条：编辑服务器后运行中的窗口热更新；原地切工作区 / 本窗换服务器。浏览器的宿主不再跨机器自动选择（见 §6）：`browser_tool` 只认 hub 自己的浏览器，其他机器必须点名。

### 12.1 目标形态

连接的单位是 **(客户端宿主, 服务器)**，既不是窗口，也不是工作区：

- **不是每窗口**：同一台机器上 N 扇窗口共享一条连接；关窗不影响连接，设备能力也不随窗口消失。
- **不是每工作区**：切工作区只是换请求作用域，零重连；用户没在用的工作区不占连接。
- **宿主** = Electron 主进程，或一个 webui 标签页（浏览器里没有主进程，标签页就是宿主）。

```
HubLink（每宿主 × 每服务器一条）
  ├─ 凭据 / TLS 信任 / 重连 / 事件缓冲 / 设备能力（exec、fs、browser invoke）
  ├─ 请求：workspace 作用域的 RPC 必须带 workspaceId；viewId 用于能力寻址
  ├─ 订阅：宿主显式声明关心的 workspace 集合（只影响事件投递）
  └─ View：窗口 / tab —— 订阅、对话框、帧流
```

归位原则：

| 维度 | 归属 |
|---|---|
| 设备（exec / fs / browser invoke） | 连接（机器） |
| 工作区 | 请求作用域 + 事件订阅 |
| 窗口 | 视图：能力寻址、UI 状态 |

### 12.2 作用域：只来自请求，没有默认值

这是本节的核心规则，也是当前实现最大的债。

- **连接不携带工作区。** v2 握手里删除 `workspaceId`。`PROTOCOL_VERSION` 升到 2.0；服务端已有 major 不一致即拒绝握手的机制（`transport/server.ts` 的握手校验），因此不存在需要兼容兜底的过渡期——留着兜底只会变成死代码和歧义。
- **通道在注册时声明作用域**，只有两种：
  - `workspace`（默认）：信封缺 `workspaceId` → `WORKSPACE_REQUIRED`，**不推断、不回落**；
  - `server`：本来就不针对单个工作区（如 `server:getWorkspaces`、settings 一类），显式声明。
- **类型分开，让编译器帮忙**：

  ```ts
  type WorkspaceCtx = { workspaceId: string; viewId: string; webContentsId: number | null }
  type ServerCtx    = { workspaceId?: never; viewId: string; webContentsId: number | null }
  ```

  handler 拿到哪一种由注册分类决定；忘了要作用域是编译/测试失败，而不是运行时静默。
- **服务端只解析，不推断。** 用请求里的 id 在服务器配置里解析 workspace，查不到即报错；不再从 `webContentsId` 反查窗口所在工作区。`getWorkspaceForWindow` 只保留给窗口管理（主进程内部），从 RPC 作用域解析中删除。
- **事件不推断。** `to: 'workspace'` 只投递给订阅集合包含该工作区的连接；没有“未钉工作区就收全部”的隐式行为。设备链路不订阅，因此天然收不到工作区事件。
- **必须拍板的语义**（不能靠默认值）：`sessions.GET` 今天在作用域缺失时返回全部会话。v2 要么要求作用域，要么单独开一个显式的跨工作区通道（`sessions.getAll` / `scope: all`）。审计时逐个列出、逐个定。

### 12.3 现存隐式回落清单（改造时全部删除）

`ctx.workspaceId ?? windowManager.getWorkspaceForWindow(ctx.webContentsId)` 共 12 处：

| 文件 | 位置 | 数量 |
|---|---|---|
| `packages/server-core/src/handlers/rpc/files.ts` | L38, L68, L86, L118, L138, L168, L256 | 7 |
| `packages/server-core/src/handlers/rpc/sessions.ts` | L147–L151（含 `windowWorkspaceId` 中间变量与四字段日志）、L564、L589 | 3 |
| `packages/server-core/src/handlers/rpc/project-files.ts` | L57 | 1 |
| `packages/server-core/src/handlers/rpc/workspace.ts` | L74（`isLocalWindow` 分支） | 1 |

`window.GET_WORKSPACE`（同文件 L70–L83，附带 `setupConfigWatcher` 副作用）应退化为视图状态：工作区是窗口自己的属性，由宿主通过 IPC 提供，不再问服务端。`sessions.ts` 那段把 `ctxWorkspaceId / webContentsId / windowWorkspaceId / resolvedWorkspaceId` 四个来源都打进日志的代码，是这里被反复调试过的直接证据。

### 12.4 通道分类方法

- 默认归 `workspace`：读 `ctx.workspaceId`，或以单个工作区的根目录 / 会话 / 来源 / skill 为对象的通道。
- 只有确实没有工作区语义的才归 `server`。候选需逐个确认，不能按前缀批量归类；已知候选集中在 `server.*`、`workspaces.CREATE/CHECK_SLUG`、`onboarding.*`、`settings.*`、`appearance/caching/rtk/decisions/tools`、`window.*`。
- **fail-closed 校验**：启动时断言“每个已注册通道都有分类”，CI 遍历 `RPC_CHANNELS` 做同样断言。漏分类的通道会按 `workspace` 处理并因缺作用域报错，而不是静默落进某个默认工作区。

### 12.5 View 维度（第 1 步）

- 信封增加 `viewId`；握手的 `webContentsId` 降级为视图属性（由宿主登记），不再承担重连身份。
- 能力请求带 `viewId`。路由策略固定为：**聚焦视图** → 该会话最早的视图 → 拒绝（错误码），**绝不广播**。确认框同时出现在两扇窗口里，比报错更糟。
- 帧流维持现有三条性质：单播、每帧 ack 背压、一个 tab 同时只允许一个观看者；寻址从 `clientId` 换成 `viewId`。
- 重连/事件：一条连接一套 seq 与缓冲。新视图接入用“快照 + 起始 seq”（refetch 后用 seq 丢弃旧事件，或服务端支持从指定 seq 订阅），不允许“先订阅、后补快照”的空窗。

### 12.6 分阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0（已落地） | 浏览器工具只认 hub 本机（headless 不注册 `browser_tool`，跨机器走 `device_tool`）；服务器编辑热更新；**原地切工作区**（`window.SWITCH_WORKSPACE` → `updateClientWorkspace`，不重建 socket）；**本窗换服务器 / 回到本机**（`client-mode:switch-server` / `switch-local`，重建或释放 socket，渲染进程不动） | headless hub 上 `browser_tool` 不可用且不借客户端浏览器；改 token 后窗口就地重连；切工作区不握手、不清空连接；下拉里换服务器即换过去，本机↔远程可来回 |
| 1 | 协议增量：`workspaceId`/`viewId` 进信封、通道分类、`WORKSPACE_REQUIRED`、删除 12 处回落、`to:'workspace'` 按订阅 | 同工作区两窗口时确认框落在聚焦窗口；帧流只到观看视图；RPC 测试全部显式带作用域 |
| 2 | 远程窗口的连接宿主迁到主进程：`HubLink` + 订阅 + 视图；preload 用 `IpcRpcClient` 实现 `RpcClient`，`CHANNEL_MAP`/`buildClientApi` 不变 | 同一服务器多窗口只有一条连接；关窗/切工作区不断连；流式延迟与主进程 CPU 有改造前后的基线 |
| 3（可选） | 本地窗口收敛为进程内调用（去掉回环 WS） | 大文件读取不再经过 base64/JSON |
| 非目标 | 一条连接跨多工作区（已由作用域承接）；把设备能力搬回窗口 | — |

### 12.7 与 webui 的关系

webui 没有主进程，“标签页 = 宿主”：同样一条连接、同样按请求带作用域、同样用订阅过滤事件。`buildClientApi` / `CHANNEL_MAP` 只依赖 `RpcClient`，Electron 侧新增 `IpcRpcClient` 适配器即可，两端 API 表面保持一份。
