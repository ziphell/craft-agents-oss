# Craft Agents Android

系统 WebView 壳：把同一份 WebUI 当原生应用使用。支持保存多台服务器、HTTP/HTTPS + WS/WSS 直连、以及 WebUI 消息通知。

## 功能

- **多服务器**：添加、编辑、删除，打开即记住最近使用；地址只允许 origin（`http(s)://host[:port]`）。
  - Cookie 由 WebView 按**域名**隔离、不区分端口：同一台主机上不同端口的两个服务器会共用 `craft_session`，互相顶掉登录。需要同时登录时，给其中一个用不同主机名/域名（本地代理方案见下文）。
- **系统 WebView 加载完整 WebUI**：登录页、会话、流式回复、上传/下载、外链与 OAuth 弹窗按白名单处理。
- **无原生标题栏**：进入服务器后 WebUI 直接铺满状态栏以下，不再占用 48dp 的 App 标题栏。
- **返回与预测式返回**：页内还有历史时，系统返回退 WebUI 自己的路由历史；没有历史时返回手势用预测式动画把当前页推出、露出服务器列表。WebUI 的 logo 菜单里也有「服务器列表」，通过 bridge 调用原生退出。
- **原生通知**：WebUI 的 `notification:show` 通过 JS bridge 转成 Android 通知，点击回到对应工作区/会话。
- **前后台状态**：WebView 在后台时 DOM 仍保持 focus，壳通过 bridge 上报真实前后台，通知只在后台弹出。

## 构建

要求 JDK 17、Android SDK Platform 35、Build Tools 35.x。仓库本身不含 Android 工具链，构建前先在本机装好：

```powershell
# Android Studio（推荐）：打开 apps/android，等待 Gradle 同步后运行 app
# 或命令行（wrapper 已带，首次会下载 Gradle 8.9）
cd apps/android
./gradlew.bat :app:assembleDebug
```

产物：`apps/android/app/build/outputs/apk/debug/app-debug.apk`。

## 服务器准备

手机要能直连服务器，三件事缺一不可：

1. 设置 `CRAFT_SERVER_TOKEN`（没有 token 时 hub 不提供 WebUI）。
2. 监听局域网地址，而不是默认的回环地址：`CRAFT_RPC_HOST=0.0.0.0`。
3. 放行 `CRAFT_RPC_PORT`（默认 `9100`）的电脑防火墙入站规则。

WebUI 与 RPC WebSocket **共用同一个端口**，所以 App 里填 `http://192.168.1.10:9100` 就够了。

如果前面有 HTTPS 反向代理（域名 + 443），默认生成的 `wsUrl` 会带内网端口，需要显式覆盖：

```powershell
$env:CRAFT_WEBUI_WS_URL = "wss://craft.example.com"
$env:CRAFT_WEBUI_SECURE_COOKIE = "1"
```

PowerShell 下的完整启动方式：

```powershell
bun run webui:build
$env:CRAFT_WEBUI_DIR = "$PWD\apps\webui\dist"
$env:CRAFT_BUNDLED_ASSETS_ROOT = "$PWD\apps\electron"
$env:CRAFT_SERVER_TOKEN = "<你的 token>"
$env:CRAFT_RPC_HOST = "0.0.0.0"
bun run packages/server/src/index.ts
```

改过 `apps/webui` 的 native bridge 后需要重新构建页面，服务器才会带上通知适配：

```powershell
bun run webui:build
```

## 通知是怎么工作的

Android 系统 WebView **不实现** Web Notifications API（`Notification` 不存在，`Notification.permission` 也不会是 `granted`），所以 APK 不能靠网页自己弹通知。这里的链路是：

1. 壳在页面加载前用 `WebViewCompat.addWebMessageListener` 注入 `window.craftBridge`，**只对该服务器的 origin 生效**。
2. `apps/webui/src/adapter/native-bridge.ts` 检测到 bridge 后：
   - 把 `notification:*` 通道视为可用（这些通道在桌面端是 LOCAL_ONLY，hub 不注册）；
   - `showNotification` 转发给壳；壳经 `NotificationManager` 弹出高优先级通知；
   - 上报前后台，替代浏览器 `focus/blur`；
   - 接收通知点击产生的 `notificationNavigate`，复用 `onNavigateToSession` 跳转。
3. 通知点击时，如果页面还活着就通过 bridge 导航；如果进程被杀后重新启动，则用 `/?workspace=<id>&sessionId=<id>` 直接进入会话。

限制：

- **只在进程存活期间有通知**。Activity 退到后台/最近任务时 WebView 和 WebSocket 仍在，能收到；进程被系统回收后不会再有通知（没有 FCM，也没有常驻前台服务）。
- Android 13+ 首次启动会申请 `POST_NOTIFICATIONS`，拒绝后只能在系统设置里再开。
- 老设备的系统 WebView 不支持 `WEB_MESSAGE_LISTENER` 时会提示，通知与前后台状态不可用。
- 摄像头/麦克风权限未接入；需要语音或拍照的页面功能不可用。

## HTTP / WS 与是否需要本地代理

**普通场景不需要本地代理，直连即可。**

- 页面、REST、WebSocket 同源同端口：`/api/config` 用请求的 `Host` 生成 `wsUrl`，手机用什么地址访问页面，返回的就是手机可达的 WS 地址。
- WebSocket 握手会自动带上 `craft_session` cookie（`SameSite=Strict` 的同源请求），不需要额外 token。
- 明文 `http://` + `ws://` 由 manifest 的 `usesCleartextTraffic="true"` 放行。

只有下面几种情况才需要代理，本版本未实现：

| 场景 | 原因 | 建议 |
|---|---|---|
| 自签 HTTPS + `wss://` | 页面证书错误可以按服务器勾选“信任自签名证书”后忽略；但 **WSS 握手的证书错误不经过 WebView 的 SSL 回调**，无法在 App 内忽略 | 换合法证书；或在 App 内做 127.0.0.1 本地 TLS 终结代理 |
| 只有明文 `http://局域网 IP`，但页面依赖 secure context | `navigator.clipboard`（复制按钮）、`crypto.subtle`、Service Worker 在非安全上下文不可用 | 本地 `127.0.0.1` 反向代理（localhost 属于安全上下文） |
| 服务器只监听 `127.0.0.1` | 手机本来就到不了；App 内代理也帮不上 | 服务端改 `CRAFT_RPC_HOST=0.0.0.0`，或电脑侧做端口转发/隧道 |

> 复制按钮当前在明文局域网下可能不可用；如果这个场景重要，下一步可以像通知一样加一个剪贴板 bridge，成本低于整套代理。

## 分辨率与折叠屏测试

运行时改分辨率（立即生效，重启模拟器后恢复）：

```powershell
adb shell wm size 1768x2208     # 展开内屏尺寸
adb shell wm density 420
adb shell wm size 1080x2092     # 模拟折叠外屏尺寸
adb shell wm size reset         # 恢复物理分辨率
adb shell wm density reset
```

创建折叠屏 AVD（设备配置 id 62，内屏 1768×2208）：

```powershell
avdmanager create avd -n craft_fold -k "system-images;android-35;default;x86_64" -d "7.6in Foldable"
emulator -avd craft_fold -port 5556 -gpu auto
```

折叠状态：

```powershell
adb -s emulator-5556 emu fold
adb -s emulator-5556 emu unfold
adb -s emulator-5556 shell cmd device_state state 1   # CLOSED
adb -s emulator-5556 shell cmd device_state state 2   # HALF_OPENED
adb -s emulator-5556 shell cmd device_state state 3   # OPENED
adb -s emulator-5556 shell dumpsys device_state | Select-String mCommittedState
```

注意：

- 通用 foldable AVD 的 `fold` 只改 posture，不会自动切到外屏尺寸；外屏请用 `wm size 1080x2092` 模拟。
- `emulator` 的 `resize-display 0/1/2` 在当前 AVD 返回 `KO: Failed to resize display`，实际以 `wm size` / `wm density` 为准，或直接新建对应设备配置的 AVD。
- App 的 `WebViewActivity` 声明了 `orientation|screenSize|screenLayout`，折叠/改分辨率不会重建页面。实测折叠前后 `window.__foldMarker` 仍存在、WebSocket 保持 `connected`。
- WebUI 会自适应：展开时 onboarding 显示描述文本，折叠后切为紧凑单行列表。

## 安全边界

- JS bridge 只注入配置的服务器 origin，原生侧还会再校验 `sourceOrigin` 与主框架。HTTP 局域网下页面本身可被中间人篡改，跨公网请使用 HTTPS。
- “信任自签名证书”按服务器主机名生效，只影响页面资源加载。
- 服务器列表存在本机 SharedPreferences；登录 cookie 由 WebView `CookieManager` 按 origin 管理（保存在应用私有存储），壳代码不读取 token。
- 外链、OAuth、自定义 scheme 一律交给系统浏览器/对应应用；同源新窗口留在当前 WebView。
- 下载走系统 `DownloadManager`，文件名来自 `Content-Disposition` 并做路径字符清洗。

## 目录

```
apps/android/
  app/src/main/java/com/craftagent/android/
    MainActivity.kt          # 服务器列表
    ServerEditActivity.kt    # 添加/编辑 + /health 连通性测试
    WebViewActivity.kt       # WebView、通知 bridge、下载、外链
    ServerStore.kt           # SharedPreferences 持久化 + URL 规范化
    NotificationHelper.kt    # 通知渠道与点击 PendingIntent
    ServerAdapter.kt         # 列表适配器
  app/src/main/res/          # Material 3 布局与图标
```

相关的 WebUI 改动：`apps/webui/src/adapter/native-bridge.ts`、`web-api.ts`。
