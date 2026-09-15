# 开发环境运行指南（Craft Agents）

> 覆盖：monorepo 结构、各子组件如何消费依赖、开发命令与执行目录、常见坑。
> 配套文档：[Windows 安装包构建指南](build-windows.md)

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
