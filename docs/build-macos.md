# macOS 安装包构建指南（Craft Agents）

> 结论：`bun electron:dist:mac` 现在会**先自动 stage 两个架构的 Claude SDK native binary**，再构建 + 打包。正式出包（签名/公证/上传）仍推荐 `apps/electron/scripts/build-dmg.sh`（见第 5 节）。
> 配套文档：[开发环境运行指南](dev-environment.md)、[Windows 安装包构建指南](build-windows.md)

## 1. 坑一：装完 DMG 一启动就崩，报找不到 SDK 模块

### 现象

安装 `Craft-Agents-arm64.dmg` 后启动，弹 Uncaught Exception：

```text
Error: Cannot find module '@anthropic-ai/claude-agent-sdk'
Require stack:
- /Applications/Craft Agents.app/Contents/Resources/app/dist/main.cjs
```

但 `bun electron:start` 本地跑一切正常。

### 根因

三点叠加：

1. `dist/main.cjs` 把 SDK 声明为 external（[apps/electron/package.json](../apps/electron/package.json) 的 `build:main` 有 `--external:@anthropic-ai/claude-agent-sdk`），**不进 bundle**，运行期从磁盘 `require` 加载。
2. electron-builder 的 `extraResources` 相对路径**以配置文件所在目录 `apps/electron/` 为基准**解析。原 mac 段写的是 `node_modules/@anthropic-ai/claude-agent-sdk`，即期望它在 `apps/electron/node_modules/` 下。
3. 但这是 monorepo，依赖**全部提升到仓库根 `node_modules`**，`apps/electron/node_modules/` 里没有 `@anthropic-ai`。而 `apps/electron/node_modules/` 也**不在 electron-builder 的额外收集范围**（`files` 段还显式 `!node_modules/**/*`）。

只有 `apps/electron/scripts/build-dmg.sh` 会在打包前把 SDK 从根拷贝到 `apps/electron/node_modules/`；而 `electron:dist:mac` 从不调用它 → `from` 路径不存在，electron-builder **静默跳过**（只打日志，不报错）→ 产出一个没有 SDK 的包。

`electron:start` 正常，是因为 dev 模式下仓库根 `node_modules` 可被 Node 正常解析。

## 2. 坑二：x64 包修好模块解析后，native binary 仍然缺失

`electron:dist:mac` 一次会打 **arm64 + x64 两个 DMG**（由 `electron-builder.yml` 的 `mac.target[].arch` 决定）。修好坑一后仍有第二个坑：

### 根因

自 SDK 0.2.113 起，SDK 拆成 **thin core**（`@anthropic-ai/claude-agent-sdk`，约 4 MB）＋ **per-arch native 包**（`@anthropic-ai/claude-agent-sdk-darwin-arm64` / `-darwin-x64`，各含约 210 MB 的 `claude` 二进制）。二者都是 SDK 的 `optionalDependencies`。

**bun / npm 只会安装与 host 架构匹配的 optionalDependency**（按包的 `os`/`cpu` 过滤）。所以在 arm64 机器上，根 `node_modules` 里**只有 `claude-agent-sdk-darwin-arm64`，没有 `-darwin-x64`**。

于是：

- arm64 包 → `extraResources` 命中 `claude-agent-sdk-darwin-arm64`，正常。
- x64 包 → `${arch}` 解析成 `claude-agent-sdk-darwin-x64`，该目录不存在 → 再次静默跳过 → **x64 包缺 native 二进制**，运行期由 [runtime-resolver.ts](../packages/shared/src/agent/backend/internal/runtime-resolver.ts) 报 "Claude Code native binary not found"。对应的报错**不再是**坑一的模块错误。

### 两个佐证

- 体积差：`Craft-Agents-arm64.dmg` ≈ 246 MB，`Craft-Agents-x64.dmg` ≈ 156 MB（差的 ~90 MB 压缩后正好是 native 二进制）。
- 解包后目录对比（`release/mac-arm64` vs `release/mac`）：

| 目标 | `.../Resources/app/node_modules/@anthropic-ai/` | native binary |
| --- | --- | --- |
| arm64 | `claude-agent-sdk` + `claude-agent-sdk-darwin-arm64` | 有（~208 MB） |
| x64 | 只有 `claude-agent-sdk` | **无** |

### 为什么不能靠 `package.json` 里加 optionalDependency 解决

试过：根 `package.json` 已列出 `@img/sharp-darwin-x64` 等全平台 optional deps，但本机 `node_modules/@img/` 里**只有 `sharp-darwin-arm64`**。即 bun 同样按 `os`/`cpu` 过滤，声明了也不会装。**跨架构只能靠 `npm pack` 显式拉取。**

## 3. 修复（2026-10-10）

三处改动：

1. **`apps/electron/electron-builder.yml`** mac 段 `extraResources` 改为引用**仓库根** `node_modules`，native 包用 `${arch}` 宏按目标架构选取：

   ```yaml
   - from: ../../node_modules/@anthropic-ai/claude-agent-sdk
     to: app/node_modules/@anthropic-ai/claude-agent-sdk
   - from: ../../node_modules/@anthropic-ai/claude-agent-sdk-darwin-${arch}
     to: app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-${arch}
   - from: ../../node_modules/@vscode/ripgrep
     to: app/node_modules/@vscode/ripgrep
   ```

   （ripgrep 之前写的也是错的相对路径，一并修掉。）

2. **新增 `scripts/stage-claude-sdk-binaries.ts`**：打包前确保目标架构的 native 包存在于根 `node_modules`；缺失则用 `npm pack` 跨架构拉取（逻辑对齐 `build-dmg.sh`）。用法：

   ```bash
   bun run scripts/stage-claude-sdk-binaries.ts darwin arm64 x64
   ```

   - 已存在则跳过；缺失才走网络。
   - 拉取后校验二进制大小（~210 MB，低于 50 MB 视为失败）。
   - 也支持 `win32` / `linux`：`bun run scripts/stage-claude-sdk-binaries.ts win32 x64`。

3. **`package.json`** 的 `electron:dist:mac` 前置该脚本：

   ```text
   bun run scripts/stage-claude-sdk-binaries.ts darwin arm64 x64
     && bun run webui:build && bun run electron:build
     && cd apps/electron && electron-builder --config electron-builder.yml --mac
   ```

> 注意：跨架构拉取来的包放在根 `node_modules`，**clean `bun install` 可能会清掉**，但每次 `electron:dist:mac` 会自动重新拉，无需手动干预。

## 4. 如何验证打包结果（不签名，快速 `--dir`）

```bash
cd apps/electron
# 只出解包目录，跳过 dmg/签名，验证 SDK 是否进包
npx electron-builder --config electron-builder.yml --mac --arm64 --dir
npx electron-builder --config electron-builder.yml --mac --x64   --dir

# arm64 解包在 release/mac-arm64，x64 解包在 release/mac
ls "release/mac-arm64/Craft Agents.app/Contents/Resources/app/node_modules/@anthropic-ai/"
ls "release/mac/Craft Agents.app/Contents/Resources/app/node_modules/@anthropic-ai/"
# 期望：各自能看到 claude-agent-sdk 与对应 arch 的 claude-agent-sdk-darwin-<arch>，且 claude 二进制 ~210 MB

# 复现运行期解析（用打包后的 main.cjs 作解析基准）
node -e 'const m=require("module");const r=m.createRequire(process.argv[1]);console.log(r.resolve("@anthropic-ai/claude-agent-sdk"))' "$PWD/release/mac-arm64/Craft Agents.app/Contents/Resources/app/dist/main.cjs"
```

对应 SDK 会从 `release/mac-arm64/.../Resources/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` 解析成功。

## 5. 与 `build-dmg.sh` 的关系

`apps/electron/scripts/build-dmg.sh` 是**正式出包**路径，额外做了：清目录、`bun install`、下载并校验固定版本 bun（`vendor/bun`）、stage SDK、签名 / 公证 / 上传 S3，并且**每次只出一个架构**（`build-dmg.sh arm64` / `build-dmg.sh x64`），跨架构缺失时自己 `npm pack`。

二者差异：

| | `bun electron:dist:mac` | `build-dmg.sh` |
| --- | --- | --- |
| 架构 | arm64 + x64 各一份 | 单架构（显式传参） |
| SDK/bun staging | 仅 stage SDK binary（新增脚本） | stage SDK + 下载 bun |
| 签名 / 公证 / 上传 | 无 | 有（`--upload`） |
| 适用 | 本地快速出包 / 验证 | 正式发布 |

## 6. 常见问题

- **`Cannot find module '@anthropic-ai/claude-agent-sdk'`**：core SDK 没进包。检查 `extraResources` 是否指向仓库根 `node_modules`，且打包前跑过 `bun install`。
- **`Claude Code native binary not found`**：per-arch native 包没进包。先跑 `bun run scripts/stage-claude-sdk-binaries.ts darwin <arch>`，确认根 `node_modules/@anthropic-ai/claude-agent-sdk-darwin-<arch>/claude` 存在（~210 MB）再打包。
- **只有 arm64 能跑、x64 不行**：即上面第二个坑，按第 2、3 节处理。
- **`electron:dist:win` / `:linux` / `:dist:dev:*`**：目前未接入该 staging 脚本（仍是 host 架构 / 需手动 stage）。若需要，可在对应脚本前加 `bun run scripts/stage-claude-sdk-binaries.ts win32 x64`（或 `linux x64`）。
