# 开发环境运行指南（Craft Agents）

> 覆盖：monorepo 结构、各子组件如何消费依赖、开发命令与执行目录、常见坑。
> 配套文档：[Windows 安装包构建指南](build-windows.md)、[渲染层的导入边界](renderer-imports.md)

## 1. 仓库结构（bun workspaces monorepo）

根 `package.json` 声明 `workspaces: ["packages/*", "apps/*"]`，**依赖全部提升到根 `node_modules`（单副本 hoisting）**。

```
apps/
  electron/   桌面应用（main + preload + renderer），另有独立打包脚本
  webui/      浏览器版 Web UI（vite，dev 端口 5175）
  viewer/     会话分享查看器（vite，dev 端口 5174）
  cli/        命令行客户端（bun 直跑 TS）
packages/
  core/                 基础类型/存储/agent 逻辑（TS 源包）
  shared/               共享业务逻辑：agent/auth/config/credentials（TS 源包，被依赖最多）
  server-core/          headless server 基础设施（TS 源包）
  server/               headless Bun 服务入口（bun 直跑 TS）
  session-tools-core/   会话工具共享库（TS 源包）
  session-mcp-server/   Codex 会话 MCP server（独立构建 dist，node 运行）
  pi-agent-server/      Pi agent 子进程服务（独立构建 dist，bun 运行）
  messaging-gateway/    Telegram/WhatsApp 网关（TS 源包）
  messaging-whatsapp-worker/ WhatsApp worker（独立构建 dist/worker.cjs）
  ui/                   共享 React UI 组件（TS 源包）
```

## 2. 依赖处理的整体模型（关键）

**内部包 = 纯 TS 源码包，无 dist**。`@craft-agent/*` 的 `package.json` 里 `main`/`exports` 都直接指向 `src/index.ts`（如 [shared/package.json](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/package.json#L6-L8)、[core/package.json](file:///c:/Users/Ryan/code/craft-agents-oss/packages/core/package.json#L6-L8)）。消费方在**构建/运行时由 bun / esbuild / vite 直接打包 TS 源码**，改源码无需 rebuild 依赖包。

- `bun install` **必须在仓库根执行**（hoisting 到根 node_modules）。
- TS 类型检查靠各 tsconfig 的 `paths` 映射到源码（如 [apps/electron/tsconfig.json](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/tsconfig.json#L23-L28)、[packages/shared/tsconfig.json](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/tsconfig.json#L25-L30)）。
- **例外：需要预构建成 dist 的独立进程**（见第 3 节）：`pi-agent-server`、`session-mcp-server`、`messaging-whatsapp-worker` 以及 electron 的 `main.cjs` / `interceptor.cjs`。这些在启动前必须构建。
- 第三方依赖：ESM-only 或原生模块按需 external（见各子组件说明）。

## 3. 各子组件依赖处理明细

### 3.1 apps/electron（main / preload / renderer）

| 部分 | 构建方式 | 依赖处理 |
| --- | --- | --- |
| main | esbuild → `dist/main.cjs` | external：`electron`、`@anthropic-ai/claude-agent-sdk`（纯 ESM，运行期从根 node_modules 原生加载）；内部 `@craft-agent/*` 从源码打进 bundle；`node-fetch`/`abort-controller` 用 [shims](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/main/shims/node-fetch.cjs) alias |
| preload | esbuild → `dist/bootstrap-preload.cjs` | external：`electron` |
| renderer | vite → `dist/renderer/` | [vite.config.ts](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/vite.config.ts#L51-L61)：`@`→renderer、`@config`→`shared/src/config`；**react/react-dom 强制指向根 node_modules 并 dedupe**（避免 @craft-agent/ui 造成多份 React） |
| interceptor | esbuild → `dist/interceptor.cjs` | 打包 `shared/src/unified-network-interceptor.ts`；dev 下 Pi 子进程优先用 `.ts` 源码 |

### 3.2 packages/shared（核心依赖源）

- 被 electron main、server、session-mcp-server、**pi-agent-server** 引用。
- **pi-agent-server 用相对路径直接 import**（`../../shared/src/...`，见 [pi-agent-server/src/index.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/pi-agent-server/src/index.ts#L69-L80)），bun build 时打进它的 bundle —— 所以改 shared 后**必须重新构建 pi-agent-server** 才生效。

### 3.3 packages/pi-agent-server（特殊：bun 运行时产物）

- 构建：`bun build src/index.ts --outdir=dist --target=bun --format=esm --external koffi`（[package.json](file:///c:/Users/Ryan/code/craft-agents-oss/packages/pi-agent-server/package.json#L12)）。
- 产物 **只能用 bun 跑**（Electron 内嵌 Node 会报 `__require is not a function`）。
- `koffi` 外置：打包时拷到 `resources/pi-agent-server/node_modules/koffi`（`scripts/build/common.ts` 的 `copyPiAgentServer`）；dev 下靠根 node_modules 解析。
- 启动运行时由 [runtime-resolver.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/agent/backend/internal/runtime-resolver.ts) 解析：`CRAFT_BUN` → `vendor/bun` → PATH 上的 `bun`。
- 改它的源码后，重启 dev 前会重新构建（见第 4 节）。

### 3.4 packages/session-mcp-server（node 运行时产物）

- 构建：`bun build src/index.ts --outdir=dist --target=node --format=cjs`；dev 时也支持 esbuild `packages:external` 变体（见 [electron-dev.ts](file:///c:/Users/Ryan/code/craft-agents-oss/scripts/electron-dev.ts#L219-L255)）。
- 由 electron main / server 作为子进程 spawn，node 运行。

### 3.5 packages/messaging-whatsapp-worker

- 构建：esbuild → `dist/worker.cjs`，Baileys **打进 bundle**（`scripts/build-wa-worker.ts`）；由 WhatsAppAdapter 按需 spawn。

### 3.6 packages/server / server-core（headless Bun 服务）

- `server` 入口直接 `bun run src/index.ts`；`server-core` 是纯 TS 源包被 bundle。
- 产物形态：`server:build` 用 `scripts/build-server.ts` 产出自带 `vendor/bun` + `resources/bin` 的独立目录（服务器侧无 node）。

### 3.7 其余（apps/webui、viewer、cli、packages/ui、core、session-tools-core、messaging-gateway）

- 全部 TS 源包 / vite 应用，无预构建；按正常 vite/bun 方式消费。

## 4. 开发命令与执行目录

**所有命令默认在【仓库根】** `c:\Users\Ryan\code\craft-agents-oss` 执行（package.json 脚本内部用根相对路径）。

### 4.1 前置

```powershell
cd <repo-root>
bun install          # 必须，hoisting 到根 node_modules
bun run sync-secrets # 可选：从 1Password 同步 OAuth 密钥到 .env
```

### 4.2 桌面应用

```powershell
bun run electron:dev      # 推荐：热更新 dev。构建子进程 servers + main/preload + vite(5173)，自动拉起 electron
bun run electron:start    # 一次构建（electron:build）后启动
bun run electron:dev:terminal # dev + 终端内查看日志
```

`electron:dev` 每次启动都会自动构建 `pi-agent-server`、`session-mcp-server`、`wa-worker`（见 [electron-dev.ts](file:///c:/Users/Ryan/code/craft-agents-oss/scripts/electron-dev.ts#L218-L255)），还会在缺 uv 时自动下载，所以改这几个子组件源码后直接重启即可。

### 4.3 headless server（不依赖 Electron）

```powershell
bun run server:dev     # 构建子进程 servers 后，以 bun 跑 packages/server/src/index.ts
bun run server:start   # 不预构建，直接跑
bun run server:prod    # 构建 servers + webui，模拟生产（CRAFT_WEBUI_DIR / CRAFT_BUNDLED_ASSETS_ROOT）
```

跑 Web UI（浏览器客户端）、以及实例隔离与踩过的坑，见[第 6 节](#6-远程模式headless-server--web-ui)。

### 4.4 独立前端

```powershell
bun run webui:dev      # 端口 5175
bun run viewer:dev     # 端口 5174
bun run playground:dev # 端口 5173，electron renderer 的组件 playground
```

### 4.5 单包内命令

```powershell
cd packages/shared && bun test          # 共享逻辑单测
cd apps/electron && bun run typecheck   # electron 类型检查
bun run typecheck:all                    # 全仓类型检查（根执行）
bun run validate:dev                     # 全量校验：typecheck + shared 测试 + doc-tools 测试
```

## 5. 常见坑（依赖相关）

1. **改了 shared / core 等 TS 源包**：普通 bundle 方（electron main、server）重启即生效；但 **pi-agent-server / session-mcp-server** 有独立 dist，必须重新构建（`electron:dev` 会自动做；手动：`bun run server:build:subprocess`）。
2. **pi-agent-server 跑不起来**（`__require is not a function`）：产物是 bun target，被 Electron node 执行了。检查 bun 运行时解析：`CRAFT_BUN`（dev 下 `apps/electron/vendor/bun/bun.exe`）或 PATH 上的 bun。Windows 上 `where bun` 返回多行 shim 的问题已修复（逐行解析、优先 .exe/.cmd）。
3. **多份 React**：必须保留 vite 里 react/react-dom 指向根 node_modules 的 alias + dedupe。
4. **`.env`**：electron-dev / electron-build-main 会自动读取根 `.env`（不存在则跳过）；OAuth ID/Secret 通过 esbuild `--define` 注入构建。
5. **端口冲突**：5173/5174/5175 被占用时 dev 会失败，先停掉旧进程。
6. **渲染层从共享包 barrel 取「值」**：会把 node-only 依赖（Claude Agent SDK 等）顺链条拖进浏览器包——`electron:dev` 照跑不误，`electron:build` 才炸在 `sdk.mjs` 上。规矩、链路与自查命令见[渲染层的导入边界](renderer-imports.md)。

## 6. 远程模式（headless server + Web UI）

**一个进程两个面**：`ws://<host>:<端口>` 上的 RPC（`CRAFT_RPC_PORT`，默认 9100），与**同一个端口**上的 Web UI（`/` 是应用、`/login` 是登录页、`/api/*` 是 HTTP 面；入口只读 `CRAFT_RPC_PORT`）。客户端（桌面端 / webui / CLI）共用同一份 `WsRpcClient` + `CHANNEL_MAP`：webui 的 `window.electronAPI.*` **全部走 WebSocket**，认证靠 `/api/auth` 下的会话 cookie 在 WS upgrade 时带上（不带 bearer token）。

### 6.1 起一个可验证的实例

```powershell
bun run webui:build                                   # 改过 renderer 必须重建：server 直接发 dist
$env:CRAFT_CONFIG_DIR   = "$env:TEMP\craft-remote-cfg"  # 隔离/并行实例，见 6.3
$env:CRAFT_SERVER_TOKEN = 'e2e-remote-token'            # 必填
$env:CRAFT_WEBUI_PASSWORD = 'craft-demo'                # 可选：登录页用短口令（缺省回落到 token）
$env:CRAFT_WEBUI_DIR    = "$PWD\apps\webui\dist"
$env:CRAFT_BUNDLED_ASSETS_ROOT = "$PWD\apps\electron"
$env:CRAFT_DISABLE_MESSAGING = 'true'                   # 与正在跑的桌面端共用配置目录时必加，否则两边抢 Telegram/WhatsApp
bun run packages/server/src/index.ts
```

- 现成脚本 `server:dev:webui` 会构建子进程 + webui 并设好 env；上面是手工等价路线（Windows/PowerShell 下我用的就是它）。注意那个脚本设的 `CRAFT_WEBUI_PORT=3100` **没人读**——Web UI 实际服务在 `CRAFT_RPC_PORT` 上（入口只认后者）。
- **锁**：第二个实例会撞 `CONFIG_DIR/.server.lock`（`headless-start.ts`）并报出占用者 PID。不要删那个锁，改用 `CRAFT_CONFIG_DIR` 起并行实例（提示里也是这么写的）。
- 启动横幅给出 `CRAFT_SERVER_URL` / `CRAFT_SERVER_TOKEN` / `CRAFT_WEBUI_URL`。

### 6.2 验什么（不依赖 Electron）

| 面 | 怎么验 | 期望 |
| --- | --- | --- |
| 未认证门禁 | `curl -i http://127.0.0.1:9100/`、`/api/config` | `/` → `302 /login`；无 cookie 的 `/api/*` → `{"error":"Unauthorized"}` |
| 登录 | 浏览器开 `/`，先错口令再对口令 | 错：页面 `Invalid credentials`、日志 `[webui] Failed auth attempt`；对：跳 `/`、`[webui] Successful auth` |
| 会话保持 | 重访 `/` | 不回登录页；`/api/config` → `{"wsUrl":"ws://…"}` |
| WS RPC | `bun run apps/cli/src/index.ts --url ws://127.0.0.1:9100 --token <t> ping` | `Connected: clientId=… latency=…` |
| 通道分类 | `cd packages/shared && bun test src/protocol` | 每个通道**恰好**被分类一次 |
| **写路径** | 浏览器里建 workspace / 建会话，然后刷新 | 数据落在**服务端**（刷新后还在）、控制台无错 |

### 6.3 踩过的坑（前两条已修，附机制与测试）

1. **「稍后设置」在远程模式下不生效**：`onboarding:getAuthState` 由 **server-core** 的 handler 作答，而它调 `getSetupNeeds(authState)` **没带** `isSetupDeferred()`；桌面端的同名 handler（`apps/electron/src/main/onboarding.ts`）带了这个参数。标记被写进 `config.json` 却没有读者 → **没有配 provider 的服务器每次加载页面都回引导页**（cookie 与数据都在，只是门禁状态不生效）。测试：`packages/server-core/src/handlers/__tests__/onboarding-setup-deferred.test.ts`。
   - 同一个坑的第二副面孔：这两个 handler 是**逐字重复的两份**（只差 import 路径与这个参数），改一处必须改两处。是否合并成一份是独立决定，目前没做。
2. **「默认位置」建 workspace 绕过 `CRAFT_CONFIG_DIR`**：三处各算各的——`workspaces/storage.ts` 有自己的 `CONFIG_DIR = join(homedir(), '.craft-agent')`（无视 env）、server-core 的 `CHECK_SLUG` 手搓同一路径、**渲染层用 `getHomeDir()` 自己拼 `${homeDir}/.craft-agent/workspaces` 当创建参数**。于是设了 `CRAFT_CONFIG_DIR` 的实例仍把 workspace 数据写进真实 home——而 `checkSlug` 的返回值里本来就有服务端算好的路径（隔壁"连接远程服务器"那条流程一直在用它）。现在 CONFIG_DIR 统一取 `config/paths.ts` 那一份、`CHECK_SLUG` 用 `getDefaultWorkspacesDir()`（校验路径 = 创建路径）、UI 采用服务端返回的路径。测试：`packages/server-core/src/handlers/__tests__/workspace-default-location.test.ts`。
3. **`CRAFT_CONFIG_DIR` 目前只是"部分隔离"**：以下位置仍硬编码 `homedir()/.craft-agent`，设了 env 也不会跟着走——日志（`apps/electron/src/main/logger.ts`）、窗口状态（`main/window-state.ts`）、文档与更新日志目录（`shared/src/docs`、`shared/src/release-notes`）、凭据目录（`shared/src/credentials/backends/secure-storage.ts`）、`shared/src/interceptor-common.ts` 的 config/log 路径、`shared/src/agent/core/prerequisite-manager.ts` 的 browser-tools 文档路径、两个入口里按 workspace 拼的 messaging 目录、`session-tools-core` 的 config 校验、`shared/src/utils/logo.ts`。**workspace 数据这一条已经归位**；"换个 config dir 就彻底干净"还差这些。
