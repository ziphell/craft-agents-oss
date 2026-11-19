# Linux 服务端构建与打包指南

> 目标：在构建机上产出一个**不依赖 Docker** 的 tar 包，解压后即可在另一台 Linux（glibc x86_64）上运行。目标机不需要安装 Bun、Node、Chromium 或 Office 组件。
>
> 开发环境本身（依赖模型、各子组件构建方式、Electron dev）见 [dev-environment.md](./dev-environment.md)。

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
tar -czf dist/craft-server-<ver>-linux-x64.tar.gz \
  --transform 's,^,craft-server-<ver>/,' \
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

## 7. 部署指南

下面以 Ubuntu 22.04/24.04、单个实例、`/opt/craft` 为例。其他发行版/目录同理替换。

### 7.1 前置条件

- **linux-x64 + glibc**（Ubuntu/Debian；Alpine 不行）
- 建议 2 核 / 2 GB 内存 / 5 GB 空闲磁盘（解压约 2.1 GB）
- 一个非 root 运行用户（下文用 `craft`），以及可写的 HOME（默认数据目录是 `~/.craft-agent`）
- 端口：默认 `9100`（HTTP 与 WebSocket 共用同一个端口）
- 需要 PDF / 画图渲染时，见第 8 节的系统库和 CJK 字体

```bash
sudo useradd --create-home --shell /bin/bash craft
```

### 7.2 安装

```bash
sudo mkdir -p /opt/craft
# 先校验，两个文件放在同一目录
sha256sum -c craft-server-<ver>-linux-x64.tar.gz.sha256
sudo tar xzf craft-server-<ver>-linux-x64.tar.gz -C /opt/craft --strip-components=1
sudo chown -R craft:craft /opt/craft

cd /opt/craft
sudo -u craft ./install.sh        # 生成 .env（含 CRAFT_SERVER_TOKEN），打印启动命令
```

`install.sh` 不启动服务；它只：

1. 给 `bin/craft-server`、`start.sh`、`vendor/bun/bun`、`resources/bin/*` 加执行位；
2. 若未提供 `CRAFT_SERVER_TOKEN`，生成 32 字节 hex 写入 `/opt/craft/.env`；
3. 若带 `--systemd`，额外安装 systemd 单元。

### 7.3 运行

**前台（调试）**

```bash
cd /opt/craft
set -a; . ./.env; set +a
CRAFT_RPC_HOST=0.0.0.0 ./start.sh
```

**systemd（推荐常驻）**

```bash
sudo CRAFT_USER=craft ./install.sh --systemd
sudo systemctl start craft-server
sudo systemctl status craft-server
sudo journalctl -u craft-server -f
```

生成的单元（`/etc/systemd/system/craft-server.service`）关键项：

```ini
[Service]
Type=simple
User=craft
WorkingDirectory=/opt/craft
EnvironmentFile=/opt/craft/.env
Environment=CRAFT_RPC_HOST=127.0.0.1
Environment=CRAFT_RPC_PORT=9100
ExecStart=/opt/craft/bin/craft-server
Restart=on-failure
RestartSec=5
```

需要监听所有网卡时不要改包里的文件，用 drop-in：

```bash
sudo systemctl edit craft-server
# 写入：
# [Service]
# Environment=CRAFT_RPC_HOST=0.0.0.0
sudo systemctl restart craft-server
```

启动横幅（`journalctl` 或前台输出）会给出：

```
CRAFT_SERVER_URL=ws://<ip>:9100
CRAFT_SERVER_TOKEN=...
CRAFT_WEBUI_URL=http://0.0.0.0:9100
CRAFT_WEBUI_PASSWORD=...
```

### 7.4 对外访问与 TLS

服务端没有独立的 HTTP/WS 端口，`9100` 一个口同时提供 Web UI、`/api/*` 和 WebSocket RPC。

**直接用内置 TLS**（`wss://`）：

```bash
# 自签（测试用）
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /opt/craft/certs/key.pem -out /opt/craft/certs/cert.pem \
  -subj "/CN=craft.example.com"

systemctl edit craft-server
# [Service]
# Environment=CRAFT_RPC_HOST=0.0.0.0
# Environment=CRAFT_RPC_TLS_CERT=/opt/craft/certs/cert.pem
# Environment=CRAFT_RPC_TLS_KEY=/opt/craft/certs/key.pem
```

也可以用 `scripts/generate-dev-cert.sh` 生成开发证书（仓库内）。

**生产推荐**：保持服务只监听 `127.0.0.1`，由 nginx/Caddy 终止 TLS。

nginx：

```nginx
server {
    listen 443 ssl;
    server_name craft.example.com;

    ssl_certificate     /etc/letsencrypt/live/craft.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/craft.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;   # 长连接会话
    }
}
```

Caddy（自动证书 + WebSocket）：

```
craft.example.com {
    reverse_proxy 127.0.0.1:9100
}
```

反向代理场景下如果浏览器看到的地址与 `/api/config` 返回的不一致，显式指定：

```ini
Environment=CRAFT_WEBUI_WS_URL=wss://craft.example.com
Environment=CRAFT_WEBUI_SECURE_COOKIE=true
```

防火墙只开放代理端口：

```bash
sudo ufw allow 443/tcp
# 不要对公网开放 9100
```

### 7.5 客户端接入

- **浏览器**：打开 `https://craft.example.com/`（或 `http://<ip>:9100/`），用 `CRAFT_WEBUI_PASSWORD` 登录。它不是 `CRAFT_SERVER_TOKEN`。
- **桌面客户端**：菜单 → Connect to Server… → 填 `wss://craft.example.com`（或 `ws://<ip>:9100`）+ `CRAFT_SERVER_TOKEN`。连接成功后窗口的会话、工具、浏览器都跑在服务器上。
- **CLI**：

  ```bash
  CRAFT_SERVER_URL=ws://127.0.0.1:9100 CRAFT_SERVER_TOKEN=<token> \
    bun run apps/cli/src/index.ts ping
  ```

### 7.6 数据、备份、升级与回滚

- 数据目录：默认运行用户 HOME 下的 `~/.craft-agent`（配置、会话、workspace、凭据）。`CRAFT_CONFIG_DIR` 可改，但部分路径仍按 HOME 解析（见 [dev-environment §6.3](./dev-environment.md#63-踩过的坑前两条已修附机制与测试)），所以**换目录不如换用户/换 HOME 干净**。
- 备份（停机或低峰）：

  ```bash
  sudo systemctl stop craft-server
  sudo tar czf /backup/craft-data-$(date +%F).tar.gz -C /home/craft .craft-agent
  sudo systemctl start craft-server
  ```

- 升级（保留回滚点）：

  ```bash
  sudo tar xzf craft-server-<new>-linux-x64.tar.gz -C /opt/craft-<new> --strip-components=1
  sudo cp /opt/craft/.env /opt/craft-<new>/.env          # token 沿用
  sudo chown -R craft:craft /opt/craft-<new>
  sudo ln -sfn /opt/craft-<new> /opt/craft               # 或改 systemd 的 WorkingDirectory
  sudo systemctl restart craft-server
  ```

  数据目录不随包移动；回滚只需把软链/`WorkingDirectory` 指回旧目录再重启。

- 版本检查：包根 `package.json` 的 `version`；CLI 的 `versions` 命令会显示服务端运行时版本。

### 7.7 多实例

同一个包可以跑多个实例，互不干扰：

```bash
CRAFT_CONFIG_DIR=/home/craft/instances/a \
CRAFT_RPC_PORT=9200 \
CRAFT_SERVER_TOKEN=<token-a> \
/opt/craft/bin/craft-server
```

注意同一 `CRAFT_CONFIG_DIR` 只能跑一个实例（`.server.lock` 会报占用者 PID）。作为 systemd 服务时用模板单元或复制一份 service 文件。

### 7.8 日志与排障

- `journalctl -u craft-server -f`；`CRAFT_DEBUG=true` 打开详细日志。
- 启动日志应有三行：

  ```
  [webui] drawio editor: .../resources/drawio
  [webui] office editors: .../resources/office
    Printing host: .../resources/render-host/craft-headless-export
  ```

  缺行说明对应资源没进包（重新构建）。
- 健康检查：`curl -I http://127.0.0.1:9100/login` → 200。
- 常见报错见第 10 节。

### 7.9 安全检查清单

- [ ] 公网只暴露 TLS 端口（443），`9100` 只监听 `127.0.0.1`
- [ ] `CRAFT_SERVER_TOKEN` 为 32 字节随机 hex，且未写入 shell history / 仓库
- [ ] `.env` 权限 `600`，属主为运行用户
- [ ] 用专用非 root 用户运行，不要用 root
- [ ] 反向代理启用 TLS 时设置 `CRAFT_WEBUI_SECURE_COOKIE=true`
- [ ] 定期备份 `~/.craft-agent`


## 8. 目标机依赖（仅 PDF / 渲染需要）

启动和聊天不需要额外安装；PDF 导出、drawio 渲染需要 Chromium 的系统库与 CJK 字体：

```bash
# Ubuntu 24.04
sudo apt install -y fonts-noto-cjk fontconfig libnss3 libnspr4 libatk1.0-0 \
  libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libasound2t64 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 \
  libx11-6 libxcb1 libxext6
# Ubuntu 22.04 把 libasound2t64 换成 libasound2
```

少了 CJK 字体不会报错，只是 PDF 里中文会按替代字体重新排版。

## 9. 验收

```bash
# 启动日志应有三行
[webui] drawio editor: .../resources/drawio
[webui] office editors: .../resources/office
  Printing host: .../resources/render-host/craft-headless-export

curl -I http://127.0.0.1:9100/login          # 200
# 打印机自检（不经过 UI）
PATH="$PWD/vendor/node/bin:$PATH" \
PLAYWRIGHT_BROWSERS_PATH="$PWD/resources/playwright" \
  ./resources/render-host/craft-headless-export --probe --json   # {"status":"ok"}
```

RPC 可用 `craft-cli`（仓库内）验证：`bun run apps/cli/src/index.ts --url ws://127.0.0.1:9100 --token <t> ping`。

## 10. 常见问题

1. **`bun: command not found: unzip`**：构建机缺 `unzip`，`server:build` 下载 Bun 时要用。
2. **drawio 403 rate limit**：GitHub 匿名 API 60 次/小时，设 `GITHUB_TOKEN` 后重跑。
3. **`playwright: Executable doesn't exist ... chromium_headless_shell-XXXX`**：`playwright-core` 版本与已下载浏览器不一致。脚本会按 `browsers.json` 校验；手工流程中要保证两者匹配（本仓库为 1.64.1 ↔ revision 1248）。
4. **Chromium 起不来：`libatspi.so.0: undefined symbol: g_once_init_leave_pointer`**：`LD_LIBRARY_PATH` 被 IDE 注入的旧 glib 覆盖。构建/运行前 `unset LD_LIBRARY_PATH`。
5. **`Cannot find module '@craft-agent/office-host'` / `fast-uri` / `gray-matter` / `tar`**：`dist/server` 没做第 4 步补齐，或依赖安装用了整棵 workspace。
6. **服务拒绝启动：`Weak server token`**：`CRAFT_SERVER_TOKEN` 至少 16 字符，用 `openssl rand -hex 32`。
7. **想换 Node / Bun 版本**：`vendor/node` 与 `vendor/bun` 是随包拷贝的；Dockerfile 里对应 `NODE_MAJOR` 与 `oven/bun:<ver>-slim` 也要同步，保持两边一致。
