# Windows 安装包构建指南（Craft Agents）

> 结论：**正式出包直接用 `build-win.ps1`**（一键完成所有 staging）；`electron:dist:win` 快捷指令只做"构建 + 打包"，**不会**准备前置文件，容易产出缺 bun / 缺 pi 服务的包。

## 1. 目录要求（重点）

electron-builder 的 `files` / `extraResources` 相对路径**都以配置文件所在目录 `apps/electron/` 为基准**解析（见 `apps/electron/electron-builder.yml`）。打包前必须满足：

| 路径（相对 `apps/electron/`） | 用途 | 谁准备 |
| --- | --- | --- |
| `dist/**/*` | main.cjs / preload / renderer | `electron:build` |
| `resources/pi-agent-server/index.js` | Pi 子进程（win 段 extraResources） | 只有 `build-win.ps1` |
| `resources/session-mcp-server/index.js` | Codex 子进程（win 段 extraResources） | 只有 `build-win.ps1` |
| `vendor/bun/bun.exe` | bun 运行时（extraResources，Pi 子进程依赖） | 只有 `build-win.ps1`（固定下载 bun-v1.3.9 baseline） |
| `packages/shared/src/unified-network-interceptor.ts` 等 4 个 ts | interceptor（`files` 段） | 只有 `build-win.ps1` |

另外：

- electron-builder 命令本身**必须在 `apps/electron/` 下执行**（两个 package.json 快捷指令已自动 `cd`）。
- 仓库根需要：`bun` 在 PATH、根 `node_modules` 含 SDK / ripgrep（monorepo hoisting）。
- `electron-builder.yml` win 段 extraResources 引用 `../../node_modules/@anthropic-ai/claude-agent-sdk-win32-x64`（仓库根）。

## 2. 方式 A：直接执行 `build-win.ps1`（推荐，完整出包）

脚本根据自身路径自动推导 `$ElectronDir`（`apps/electron`）和 `$RootDir`（仓库根），**在任意目录执行均可**；脚本头注释约定从 `apps/electron` 下运行。

```powershell
# 任选其一：
# 1) 从仓库根执行（推荐）
powershell -ExecutionPolicy Bypass -File apps\electron\scripts\build-win.ps1

# 2) 或先 cd 到 apps/electron，再按脚本头注释的方式执行
cd <repo-root>\apps\electron
powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
```

该脚本自动完成全流程（`apps/electron/scripts/build-win.ps1`）：

1. 杀掉 node / npm / electron / electron-builder 残留进程（Windows 文件锁）
2. 清理 `apps/electron\vendor`、`node_modules\@anthropic-ai`、`packages`、`release`
3. 在仓库根执行 `bun install`
4. 下载固定版本 bun（`bun-v1.3.9`，x64 baseline）→ `apps/electron\vendor\bun\bun.exe`，校验 SHA256
5. stage SDK：core + `claude-agent-sdk-win32-x64` → `apps/electron\node_modules\@anthropic-ai\`，并建 `claude-agent-sdk-binary` alias（缺包时自动 `npm pack` 跨架构拉取）
6. 拷贝 ripgrep、interceptor 4 个 ts → `apps/electron\packages\shared\src\`
7. 构建 subprocess servers（`bun run server:build:subprocess`）、main（esbuild）、preload、renderer（vite）、copy-assets
8. 拷贝 `pi-agent-server/index.js`、`session-mcp-server/index.js` → `apps/electron\resources\`
9. 在 `apps/electron` 下执行带 EBUSY 重试的 `electron-builder --win --x64`
10. 校验打包产物：SDK 原生 binary（~210MB）在 `release\win-unpacked` 中

产物：`apps/electron\release\Craft-Agents-x64.exe`

## 3. 方式 B：package.json 快捷指令（增量重打包）

快捷指令定义在仓库根 `package.json`：

```powershell
# 必须在【仓库根】执行（脚本内部使用根相对路径）
cd <repo-root>

bun run electron:dist:win        # 正式打包
bun run electron:dist:dev:win    # dev 运行时（CRAFT_DEV_RUNTIME=1，走本地 walk-up 路径解析）
```

实际等价于：

```text
bun run electron:build   # main + preload + renderer + resources + assets（构建到 apps/electron/dist/）
cd apps/electron && electron-builder --config electron-builder.yml --win
```

**前提**：方式 B **不会**执行方式 A 的第 2/4/5/6/8 步。以下文件必须已存在（通常是你成功跑过一次 `build-win.ps1` 之后才满足）：

- `apps\electron\vendor\bun\bun.exe`
- `apps\electron\node_modules\@anthropic-ai\claude-agent-sdk-binary\claude.exe`
- `apps\electron\resources\pi-agent-server\index.js`
- `apps\electron\resources\session-mcp-server\index.js`
- `apps\electron\packages\shared\src\unified-network-interceptor.ts`（及另外 3 个依赖 ts）

若缺 `vendor\bun` 或 `resources\pi-agent-server`，electron-builder 要么直接报路径错误，要么打出缺件的包 —— **运行时 Pi agent 无法启动**（见第 5 节）。

## 4. `electron-builder copy.yml`

- 是 `electron-builder.yml` 的**过期备份**：文件名带空格、无任何脚本引用、electron-builder 不会自动读取。
- win 段用的是旧的本地 SDK alias 布局（`node_modules/@anthropic-ai/claude-agent-sdk-binary`），与当前 `electron-builder.yml`（引用根 `../../node_modules/...`）不一致。
- 建议删除该文件，避免混淆。

## 5. 相关背景：Pi agent 的 bun 运行时

- `pi-agent-server` 的构建产物是 `bun build --target=bun` 生成的（`packages/pi-agent-server/dist/index.js`），**只能用 bun 运行**，Electron 内嵌的 Node 无法执行（会报 `TypeError: __require is not a function`）。
- 运行期由 `packages/shared/src/agent/backend/internal/runtime-resolver.ts` 解析 bun：优先 `CRAFT_BUN` → `resourcesPath`/`CRAFT_RESOURCES_BASE`/`appRootPath` 下的 `vendor/bun` →（非打包模式）按 PATH 解析 `where`/`which bun`。
- 因此打包产物里**必须**带上 `vendor\bun\bun.exe`（这就是方式 A 第 4 步存在的意义）。开发模式下 `bun electron:start` 跑 Pi agent 若失败，多半是 bun 解析不到真实可执行文件（Windows 上 `where bun` 会返回多行 shim，已修复为逐行解析并优先 `.exe` / `.cmd`）。

## 6. 常见问题

- **EBUSY / 文件被锁**：Windows Defender 或残留的 node/electron 进程会锁住 `bun.exe` 等文件。方式 A 已内置杀进程 + 重试；手动用方式 B 失败时，先关闭正在运行的 Electron / 终端里的 vite，再重试。
- **SDK 二进制缺失**：`apps\electron\node_modules\@anthropic-ai\claude-agent-sdk-binary\claude.exe` 不存在时，方式 B 会失败或产物无 Claude 能力 —— 回到方式 A。
