# Linux 服务端构建与打包指南

> 目标：在构建机上产出一个**不依赖 Docker** 的 tar 包，解压后即可在另一台 Linux（glibc x86_64）上运行。目标机不需要安装 Bun、Node、Chromium 或 Office 组件。
>
> 开发环境本身（依赖模型、各子组件构建方式、Electron dev）见 [dev-environment.md](./dev-environment.md)。
>
> 目标机安装、systemd、TLS、反向代理、升级与排障见 **[Linux 服务端部署指南](deployment.md)**。

## 1. 产物

```
dist/craft-server-<version>-linux-x64.tar.gz          # 约 660 MB
dist/craft-server-<version>-linux-x64.tar.gz.sha256   # 校验和
dist/server/                                          # 解压后约 2.1 GB
```

tar 内只有一个版本化顶层目录 `craft-server-<version>/`（和安装包一样，解压不会把 `bin/ resources/ node_modules/` 撒到当前目录）；部署时用 `--strip-components=1` 解到目标目录。

包内自带：

| 组件 | 位置 | 版本 |
|---|---|---|
| Bun | `vendor/bun/bun` | 1.3.14 |
| Node | `vendor/node/bin/node` | 22.x |
| Web UI | `webui/` | 构建时的 `apps/webui/dist` |
| Chromium（PDF / drawio 渲染） | `resources/playwright/` | 与 `playwright-core` 对应（当前 revision 1248） |
| Office 编辑器 / 引擎 / CLI / sidecar | `resources/office*`、`resources/cli` | GenOffice 固定版本 |
| drawio | `resources/drawio/` | v31.5.2 |
| 命令工具 + 模型 | `resources/cli-tools`、`resources/models` | 含 OCR / VAD |
| 生产依赖 | `node_modules/` | 只含生产依赖 + 本平台制品 |

## 2. 构建机要求

- Linux x86_64
- **Bun 1.3.14，必须是 Linux 版**（WSL 里若 `which bun` 指向 `/mnt/c/...` 的 Windows shim，会失败）
- Node 22
- `git`、`unzip`（`server:build` 下载 Bun 时解压用）、`ar`、`tar`
- 首次构建需要网络：GitHub（Bun/uv/GenOffice release）、npm registry；drawio 的目录列表走 GitHub API，匿名 60 次/小时，超限需 `GITHUB_TOKEN`
- Bun 与 uv 会缓存在 `apps/electron/vendor/bun/`、`apps/electron/resources/bin/<platform>-<arch>/`，之后重复打包直接复用（只校验平台/架构），不会重新下载；删掉缓存可强制更新

## 3. 一条命令构建

```bash
bun run server:dist:linux
```

实现：`scripts/build-server-dist.ts`（`package.json` 中的 `server:dist:linux`）。

关键行为：**已有产物直接复用**，只构建缺失的部分。因此首次构建慢，之后改代码重新打包很快。

## 4. 脚本做了什么

1. **预检**：`linux-x64`；`node` 必须是 ELF（防 Windows shim）；检查 `unzip`/`ar`/`tar`。
2. **资源（缺才建）**
   - `apps/webui/dist`
   - `resources/cli-tools/dist` + OCR 模型 + ASR VAD 模型
   - `resources/drawio`
   - Office：`vendor/genoffice` 源码 → `npm install` → docs/pdf/slides 一次构建 + sheets 单独构建 → CLI → `build-office-engine.ts` → `build-office-assets.ts`
   - `xlsx-sidecar`：缺失时自动从 GenOffice 官方 deb（`v0.13.18`）下载并提取
   - `packages/render-host/dist`（打印宿主 bundle）
   - Playwright `chromium-headless-shell`（按 `playwright-core/browsers.json` 的 revision 校验）
3. **骨架**：`scripts/build-server.ts --platform=linux --arch=x64` → `dist/server`
4. **补齐 `dist/server`**
   - 复制 `office-host` workspace 包并重建全部 `@craft-agent/*` 链接（`server:build` 的列表里没有它）
   - 合并根 `dependencies`，去掉所有 `devDependencies`；把版本**钉到仓库已安装版本**；补回运行期需要的 `tar`、`playwright-core`
   - `bun install --production`（hoisted linker，等价仓库布局）
   - 复制 Web UI、render-host、Chromium、Node
   - 删除 16 项非 linux-x64 制品（见第 6 节）
   - 向 `bin/craft-server` 注入运行期环境变量（幂等）
5. **打包**：`tar.gz` → `dist/`

注入 `bin/craft-server` 的内容：

```sh
export CRAFT_WEBUI_DIR="$ROOT/webui"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/resources/playwright"
export CRAFT_MESSAGING_WA_WORKER="$ROOT/packages/messaging-whatsapp-worker/dist/worker.cjs"
export CRAFT_MESSAGING_NODE_BIN="$ROOT/vendor/node/bin/node"
export PATH="$ROOT/vendor/node/bin:$ROOT/resources/bin:$ROOT/vendor/bun:$PATH"
```

**运行期哪些走 Node**：主服务本身由包内 Bun 执行；打印宿主（launcher 是 `exec node ...`）、WhatsApp worker、以及文档转换（`resources/cli/genoffice.cjs`，`hostRuntime()` 默认返回 `node`，可用 `CRAFT_OFFICE_RUNTIME` 覆盖）都跑在包内 Node 上。drawio 渲染与 PDF 打印都经由同一个打印宿主，因此也是 Node。

## 5. 手工等价步骤（排查用）

### 5.1 资源

```bash
bun install --frozen-lockfile

bun run build:cli-tools
bun run fetch:ocr-models
bun run fetch:sherpa-vad
GITHUB_TOKEN=xxx bun run electron:fetch:drawio

# Office
bun run scripts/fetch-genoffice-source.ts
(cd vendor/genoffice && npm install)
(cd vendor/genoffice && npm run build -w @genoffice/docs -w @genoffice/pdf -w @genoffice/slides)
(cd vendor/genoffice/apps/sheets && npx electron-vite build)   # electron-vite 5 去掉了 -w
(cd vendor/genoffice && npm run build -w @genoffice/cli)
bun run scripts/build-office-engine.ts
bun run scripts/build-office-assets.ts

# xlsx sidecar（无 Rust 时取官方 deb 里的预编译）
curl -LO https://github.com/genspark-ai/genoffice/releases/download/v0.13.18/genoffice_0.13.18_amd64.deb
ar x genoffice_0.13.18_amd64.deb && tar xf data.tar.xz
bun run scripts/build-office-native.ts --from opt/GenOffice

# 打印宿主
bun run --cwd packages/render-host build:cli
node node_modules/playwright-core/cli.js install chromium-headless-shell
```

### 5.2 骨架

```bash
# 不带 --compress：`server:build:linux-x64`（带 --compress）会产出与最终包同名的骨架 tar。
# 出过 full 包后不要再跑它，否则会覆盖成不可部署的骨架。
bun run server:build --platform=linux --arch=x64
```

`server:build` 产出的目录**不完整**：没有 Web UI、打印宿主、Node，`packages/` 缺 `office-host`，`node_modules` 缺运行期依赖（根 `dependencies`、`tar` 这类 devDependency、`fast-uri` 这类传递依赖）。在仓库内启动 `dist/server` 时 Bun 会向上解析到仓库根 `node_modules`，所以“看起来能跑”；换台机器就报 `Cannot find module`。

### 5.3 补齐 `dist/server`

```bash
cd dist/server

# 1) office-host
mkdir -p packages/office-host
cp ../../packages/office-host/package.json packages/office-host/
cp -a ../../packages/office-host/src packages/office-host/
ln -sfn ../../packages/office-host node_modules/@craft-agent/office-host

# 2) 只装生产依赖
cp ../../bunfig.toml .
node -e '
const fs=require("fs");
for (const f of ["package.json", ...fs.readdirSync("packages").map(p=>`packages/${p}/package.json`)]) {
  if (!fs.existsSync(f)) continue;
  const j=JSON.parse(fs.readFileSync(f,"utf8")); delete j.devDependencies;
  fs.writeFileSync(f, JSON.stringify(j,null,2)+"\n");
}'
node -e '
const fs=require("fs"),path=require("path");
const j=JSON.parse(fs.readFileSync("package.json","utf8"));
for (const n of Object.keys(j.dependencies)) {
  try { j.dependencies[n]=require(path.resolve("../../node_modules",n,"package.json")).version } catch {}
}
j.dependencies.tar="7.5.2";
j.dependencies["playwright-core"]="1.64.1";   # 必须匹配已下载的 Chromium revision
fs.writeFileSync("package.json", JSON.stringify(j,null,2)+"\n");
'
rm -rf node_modules packages/*/node_modules bun.lock
env -u CI bun install --production
# 安装后重建 workspace 链接（bun 不一定会建）
mkdir -p node_modules/@craft-agent
for p in packages/*; do
  name=$(node -p "require('./$p/package.json').name" 2>/dev/null)
  case "$name" in @craft-agent/*) ln -sfn "../../$p" "node_modules/@craft-agent/${name#@craft-agent/}" ;; esac
done

# 3) Web UI / 打印宿主 / Chromium / Node
mkdir -p webui resources/render-host resources/playwright vendor/node/bin
cp -a ../../apps/webui/dist/. webui/
cp -a ../../packages/render-host/dist/cli.mjs ../../packages/render-host/dist/craft-headless-export resources/render-host/
chmod +x resources/render-host/craft-headless-export
cp -a ~/.cache/ms-playwright/. resources/playwright/
cp -a "$(readlink -f "$(which node)")" vendor/node/bin/node
```

### 5.4 压缩

```bash
cd /path/to/repo
# flags=rh：r 只改成员名（不改符号链接目标），h 同步改写硬链接目标。
# 缺 r 会把 @craft-agent/* -> craft-server-<ver>/../../packages/* 写坏；
# 缺 h 则硬链接指向未加前缀的成员，解压时找不到目标。
tar -czf dist/craft-server-<ver>-linux-x64.tar.gz \
  --transform 'flags=rh;s,^,craft-server-<ver>/,' \
  --sort=name --owner=0 --group=0 --numeric-owner \
  -C dist/server $(ls -A dist/server)
(cd dist && sha256sum craft-server-<ver>-linux-x64.tar.gz > craft-server-<ver>-linux-x64.tar.gz.sha256)
```

## 6. 体积与裁剪

只保留 linux-x64 制品（约省 530 MB）：

```bash
cd dist/server/node_modules
rm -rf @github/copilot-linuxmusl-x64 \
       @anthropic-ai/claude-agent-sdk-linux-x64-musl \
       @img/sharp-linuxmusl-x64 @img/sharp-libvips-linuxmusl-x64 \
       @earendil-works/pi-tui/native/darwin @earendil-works/pi-tui/native/win32 \
       @github/copilot/prebuilds/darwin-arm64 @github/copilot/prebuilds/darwin-x64 \
       @github/copilot/prebuilds/linux-arm64 @github/copilot/prebuilds/win32-arm64 \
       @github/copilot/prebuilds/win32-x64 \
       @github/copilot/ripgrep/bin/darwin-arm64 @github/copilot/ripgrep/bin/darwin-x64 \
       @github/copilot/ripgrep/bin/linux-arm64 @github/copilot/ripgrep/bin/win32-arm64 \
       @github/copilot/ripgrep/bin/win32-x64
```

保留 `@github/copilot` 本体（JS bundle + 自带 sharp wasm），它运行时按平台选 prebuilds，删掉本平台那份会坏。

当前包体构成：

| 部分 | 大小 |
|---|---:|
| `node_modules` | 1.2 GB（`@anthropic-ai` 237 MB、`@github` 196 MB + 其他） |
| `resources/playwright` | 278 MB |
| `resources/cli-tools` | 122 MB |
| `resources/office` + `cli` + `office-engine` + `office-native` | ~157 MB |
| `resources/drawio` | 82 MB |
| `vendor/bun` + `vendor/node` | 208 MB |

已排除：Electron 及其工具链（`electron`、`electron-log`、`electron-updater`、`electron-winstaller`、`app-builder-bin`）、`@trycua`/`cua-driver`（桌面端 Computer Use 专用），以及所有非 linux-x64 二进制。

> 因此该包只适用于 **linux-x64 + glibc**（Ubuntu/Debian）。Alpine（musl）或 arm64 需要另建。

## 7. 部署

打包只是第一步。目标机的安装、systemd、TLS、反向代理、升级、多实例与排障见 **[Linux 服务端部署指南](deployment.md)**。

## 8. 构建常见问题

1. **`bun: command not found: unzip`**：构建机缺 `unzip`，`server:build` 下载 Bun 时要用。
2. **drawio 403 rate limit**：GitHub 匿名 API 60 次/小时，设 `GITHUB_TOKEN` 后重跑。
3. **`playwright: Executable doesn't exist ... chromium_headless_shell-XXXX`**：`playwright-core` 版本与已下载浏览器不一致。脚本会按 `browsers.json` 校验；手工流程中要保证两者匹配（本仓库为 1.64.1 ↔ revision 1248）。
4. **Chromium 起不来：`libatspi.so.0: undefined symbol: g_once_init_leave_pointer`**：`LD_LIBRARY_PATH` 被 IDE 注入的旧 glib 覆盖。构建/运行前 `unset LD_LIBRARY_PATH`。
5. **`Cannot find module '@craft-agent/office-host'` / `fast-uri` / `gray-matter` / `tar`**：`dist/server` 没做第 4 步补齐，或依赖安装用了整棵 workspace。
6. **想换 Node / Bun 版本**：`vendor/node` 与 `vendor/bun` 是随包拷贝的；Dockerfile 里对应 `NODE_MAJOR` 与 `oven/bun:<ver>-slim` 也要同步，保持两边一致。

部署侧的运行期报错（token、端口、TLS、反代、字体）见 [deployment.md 的排障一节](deployment.md#10-日志与排障)。
