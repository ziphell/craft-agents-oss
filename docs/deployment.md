# Linux 服务端部署指南

> 面向 `dist/craft-server-<version>-linux-x64.tar.gz`：把它装到一台 Ubuntu/Debian 上并常驻运行。
>
> 如何构建这个包（构建机要求、脚本步骤、手工命令、体积裁剪）见 [build-server-linux.md](./build-server-linux.md)。

## 1. 部署前确认

- **平台**：linux-x64 + glibc（Ubuntu / Debian；Alpine 的 musl 不行，arm64 需另建）
- **资源**：建议 2 核 / 2 GB 内存 / 5 GB 空闲磁盘（解压约 2.1 GB）
- **运行用户**：非 root 专用用户（下文用 `craft`），HOME 可写——默认数据目录是 `~/.craft-agent`
- **端口**：默认 `9100`，HTTP、`/api/*`、WebSocket 共用这一个端口
- **目标机不需要**安装 Bun、Node、Chromium、Office；这些都在包里（`vendor/`、`resources/`）
- 需要 PDF 导出 / drawio 渲染时，额外装系统库与 CJK 字体，见第 6 节

## 2. 安装

把 tar 与同名的 `.sha256` 一起上传到目标机（两个文件放在同一目录），先校验再解压：

```bash
sudo mkdir -p /opt/craft
sha256sum -c craft-server-<ver>-linux-x64.tar.gz.sha256
sudo tar xzf craft-server-<ver>-linux-x64.tar.gz -C /opt/craft --strip-components=1
sudo chown -R craft:craft /opt/craft

cd /opt/craft
sudo -u craft ./install.sh        # 生成 .env（含 CRAFT_SERVER_TOKEN），打印启动命令
```

tar 内只有一个版本化顶层目录 `craft-server-<ver>/`，所以必须用 `--strip-components=1`，否则会得到 `/opt/craft/craft-server-<ver>/...`。

`install.sh` 不启动服务；它只：

1. 给 `bin/craft-server`、`start.sh`、`vendor/bun/bun`、`resources/bin/*` 加执行位；
2. 若未提供 `CRAFT_SERVER_TOKEN`，生成 32 字节 hex 写入 `/opt/craft/.env`；同时生成并写入 `CRAFT_WEBUI_PASSWORD`（如果环境里已有就用环境值），避免每次重启换密码；
3. 若带 `--systemd`，额外安装 systemd 单元。

`/opt/craft` 里同时放着一份 `start.sh`、`.env` 和 `bin/`，升级时替换整个目录即可（见第 8 节）。

## 3. 运行

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

改了 `.env` 或 drop-in 之后都要 `systemctl restart craft-server` 才生效。

启动横幅（`journalctl` 或前台输出）会给出：

```
CRAFT_SERVER_URL=ws://<ip>:9100
CRAFT_SERVER_TOKEN=...
CRAFT_WEBUI_URL=http://0.0.0.0:9100
CRAFT_WEBUI_PASSWORD=...
```

### 3.1 监听配置的来源与优先级

纯 server 模式的监听配置**只来自环境变量**，不读取也不写入本地 `config.json` 里的 `serverConfig`（那是桌面端 Server Mode 的存储）：

| 配置 | 来源 | 未设置时 |
|---|---|---|
| 监听地址 | `CRAFT_RPC_HOST` | `127.0.0.1` |
| 端口 | `CRAFT_RPC_PORT` | `9100` |
| TLS | `CRAFT_RPC_TLS_CERT` + `CRAFT_RPC_TLS_KEY` | 不启用（`ws://`） |
| 外网地址 | `CRAFT_WEBUI_WS_URL` | 按请求地址推导 |
| 服务器令牌 | `CRAFT_SERVER_TOKEN` | 必填，缺失拒绝启动 |
| 浏览器访问令牌 | `CRAFT_WEBUI_PASSWORD` | 每次启动随机生成（不落盘） |

- 优先级只有两层：**环境变量 > 内置默认值**。桌面端之前存在本地配置里的 Server Mode 端口，在 headless 下既不会被读取，也不会覆盖环境变量。
- Web UI 的 **Settings → Server** 页在 headless 下是**只读**的：保存会返回 `Server settings are provided by the host environment ...`；端口、TLS、外网地址、浏览器令牌都改了不生效，必须改环境变量并重启服务。
- 服务端没有 `server:restart` 通道，Web UI 无法帮你重启，改完配置要自己 `systemctl restart craft-server`。
- `CRAFT_WEBUI_PASSWORD` 不设置时生成的密码**不写入磁盘**，重启后旧密码失效、所有浏览器会话退出。`install.sh` 首次写入 `.env` 时会一并生成；手工部署或升级时记得保留 `.env` 里的这一行。

运行期仍会写这些文件（都在数据目录，默认 `~/.craft-agent`）：

| 文件 | 内容 |
|---|---|
| `config.json` | 仅当文件缺失时初始化 workspace 列表与活跃项 |
| `device-tokens.json` | 设备令牌槽（哈希、绑定设备、待连接槽的明文），权限 `600` |
| `.server.lock` | 单实例锁，记录占用者 PID |

## 4. 对外访问与 TLS

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

> `CRAFT_RPC_HOST`、`CRAFT_RPC_PORT`、TLS 证书路径和 `CRAFT_WEBUI_WS_URL` 只由环境变量决定。Web UI 的 **Settings → Server** 页会把它们**只读**展示出来；那一页上的保存操作会直接报错并提示改环境变量。
>
> 同一页也是分发凭据的地方：可以复制 **浏览器访问令牌**（给别人登录 Web UI），也可以 **Add device** 创建待连接的设备令牌（可限制为仅设备或同时允许远程控制），在设备连上之前一直可复制。

## 5. 客户端接入

- **浏览器**：打开 `https://craft.example.com/`（或 `http://<ip>:9100/`），用 `CRAFT_WEBUI_PASSWORD` 登录。它不是 `CRAFT_SERVER_TOKEN`。
- **桌面客户端**：菜单 → Connect to Server… → 填 `wss://craft.example.com`（或 `ws://<ip>:9100`）+ `CRAFT_SERVER_TOKEN`。连接成功后窗口的会话、工具、浏览器都跑在服务器上。
- **CLI**：

  ```bash
  CRAFT_SERVER_URL=ws://127.0.0.1:9100 CRAFT_SERVER_TOKEN=<token> \
    bun run apps/cli/src/index.ts ping
  ```

## 6. 目标机依赖（仅 PDF / 渲染需要）

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

## 7. 验收

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

RPC 可用 `craft-cli` 验证：`bun run apps/cli/src/index.ts --url ws://127.0.0.1:9100 --token <t> ping`。

## 8. 数据、备份、升级与回滚

- 数据目录：默认运行用户 HOME 下的 `~/.craft-agent`（配置、会话、workspace、凭据）。`CRAFT_CONFIG_DIR` 可改，但部分路径仍按 HOME 解析（见 [dev-environment §6.3](./dev-environment.md#63-踩过的坑前两条已修附机制与测试)），所以**换目录不如换用户/换 HOME 干净**。
- 数据目录里的 `device-tokens.json` 保存设备令牌哈希与设备绑定，备份/恢复会保留已配对设备；反过来，这份备份等同于凭据，按密钥对待。`.env` 不在数据目录里，升级时单独拷贝。
- 备份（停机或低峰）：

  ```bash
  sudo systemctl stop craft-server
  sudo tar czf /backup/craft-data-$(date +%F).tar.gz -C /home/craft .craft-agent
  sudo systemctl start craft-server
  ```

- 升级（保留回滚点）：

  ```bash
  sudo tar xzf craft-server-<new>-linux-x64.tar.gz -C /opt/craft-<new> --strip-components=1
  sudo cp /opt/craft/.env /opt/craft-<new>/.env          # token 与浏览器密码沿用
  sudo chown -R craft:craft /opt/craft-<new>
  sudo ln -sfn /opt/craft-<new> /opt/craft               # 或改 systemd 的 WorkingDirectory
  sudo systemctl restart craft-server
  ```

  数据目录不随包移动；回滚只需把软链/`WorkingDirectory` 指回旧目录再重启。

- 版本检查：包根 `package.json` 的 `version`；CLI 的 `versions` 命令会显示服务端运行时版本。

## 9. 多实例

同一个包可以跑多个实例，互不干扰：

```bash
CRAFT_CONFIG_DIR=/home/craft/instances/a \
CRAFT_RPC_PORT=9200 \
CRAFT_SERVER_TOKEN=<token-a> \
/opt/craft/bin/craft-server
```

注意同一 `CRAFT_CONFIG_DIR` 只能跑一个实例（`.server.lock` 会报占用者 PID）。作为 systemd 服务时用模板单元或复制一份 service 文件。

## 10. 日志与排障

- `journalctl -u craft-server -f`；`CRAFT_DEBUG=true` 打开详细日志。
- 启动日志应有三行：

  ```
  [webui] drawio editor: .../resources/drawio
  [webui] office editors: .../resources/office
    Printing host: .../resources/render-host/craft-headless-export
  ```

  缺行说明对应资源没进包（重新构建，见 [build-server-linux.md](./build-server-linux.md)）。
- 健康检查：`curl -I http://127.0.0.1:9100/login` → 200。
- 运行时报错见第 12 节。

## 11. 安全检查清单

- [ ] 公网只暴露 TLS 端口（443），`9100` 只监听 `127.0.0.1`
- [ ] 安装包先 `sha256sum -c` 校验，再解压
- [ ] `CRAFT_SERVER_TOKEN` 为 32 字节随机 hex，且未写入 shell history / 仓库
- [ ] `.env` 权限 `600`，属主为运行用户
- [ ] 用专用非 root 用户运行，不要用 root
- [ ] 反向代理启用 TLS 时设置 `CRAFT_WEBUI_SECURE_COOKIE=true`
- [ ] 定期备份 `~/.craft-agent`

## 12. 常见问题

1. **服务拒绝启动：`Weak server token`**：`CRAFT_SERVER_TOKEN` 至少 16 字符，用 `openssl rand -hex 32`。
2. **`Cannot find module '@craft-agent/...'` / `fast-uri` / `tar`**：包不完整（没经过打包脚本补齐），不是部署问题；按 [build-server-linux.md](./build-server-linux.md) 重新打包。
3. **`libatspi.so.0: undefined symbol: g_once_init_leave_pointer` 或 `libxz ... XZ_5.4 not found`**：环境里被注入了旧的 `LD_LIBRARY_PATH`（常见于 IDE 终端）。启动前 `unset LD_LIBRARY_PATH`，或直接在 systemd 里跑（环境干净）。
4. **端口被占用 / 启动后不是 9100**：看启动横幅和日志里的 `bindError`；`ss -ltnp | grep 9100` 找到占用者，或改 `CRAFT_RPC_PORT`。
5. **反代后页面能开但一直转圈**：多半是 WebSocket 没转发。确认 `Upgrade`/`Connection` 头，长连接超时调到 1 小时；地址不一致时设 `CRAFT_WEBUI_WS_URL`。
6. **升级后浏览器登录失效**：Web UI 会话由 `CRAFT_SERVER_TOKEN` 与 `CRAFT_WEBUI_PASSWORD` 派生签名，换了任一值都会让已有会话失效，重新登录即可。
7. **PDF 里中文变成方框 / 排版错乱**：缺 CJK 字体，装 `fonts-noto-cjk` 后重试（第 6 节）。
8. **多实例启动报 lock 占用**：同一 `CRAFT_CONFIG_DIR` 只能一个实例，给每个实例分配独立目录（第 9 节）。

## 13. 附：不推荐在服务器上使用 Electron AppImage

桌面端也能打 Linux AppImage（[build-linux.sh](file:///home/ryan/code/craft-agents-oss/apps/electron/scripts/build-linux.sh)），配合 `CRAFT_HEADLESS=1` 可以不开窗口常驻。但这属于**桌面应用形态**，不适合当服务器发行版：

- 需要图形库和虚拟显示。即使不建窗口，Electron 进程仍要连 X/Wayland：
  ```bash
  sudo apt install -y xvfb libfuse2 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libgbm1 libxkbcommon0 libasound2t64 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxext6
  CRAFT_HEADLESS=1 xvfb-run -a ./Craft-Agents-x64.AppImage --no-sandbox
  ```
- `CRAFT_HEADLESS=1` 下**完全从环境变量读**监听配置与凭据，不读取也不写入 `config.json` 的 Server Mode：
  - 必填 `CRAFT_SERVER_TOKEN`、`CRAFT_WEBUI_PASSWORD`，缺失直接拒绝启动
  - `CRAFT_RPC_HOST`（默认 `127.0.0.1`）、`CRAFT_RPC_PORT`（默认 `9100`）
  - `CRAFT_RPC_TLS_CERT` + `CRAFT_RPC_TLS_KEY`（可选 `CRAFT_RPC_TLS_CA`，证书与私钥必须成对）
  - `CRAFT_WEBUI_WS_URL`（反向代理/端口映射时的外部地址）
  - Server Mode 视为始终开启，设置页整个 Server 区只读，保存会直接报错。
- 没有 systemd 单元或服务化安装（`scripts/install-app.sh` 面向桌面用户），升级要替换整个 AppImage。
- 体积和依赖远大于 tar 包。

适用场景只有：有桌面环境的机器上临时验证，或内部对照排查。**在 Ubuntu Server 上长期运行请使用本文的 tar 包。**
