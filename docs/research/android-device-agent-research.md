# 让 Agent 操作安卓真机：方案调研与 Craft 安卓客户端改造评估

> 调研时间：2026-11-15　范围：Android 真机（不含 iOS/模拟器为主场景）

## 0. 结论先行

1. **市面上已有成熟方案，且几乎都收敛到三条路线**：
   - **宿主侧 ADB 驱动**：Agent 跑在电脑/服务器上，通过 ADB 读 UI 树、截图、点按。代表：Google ARTEMIS、mobile-mcp、Droidrun、Appium MCP、Android-MCP。
   - **端侧无障碍 / Shizuku**：Agent 或工具服务跑在手机 APK 里，用 AccessibilityService 读屏与派发手势，Shizuku 补 ADB 级能力。代表：zerotap agent、Operit AI、FoneClaw、AutoGLM For Android。
   - **云真机 / 云手机**：不碰实体设备，直接调云端 Android 实例。代表：阿里云无影云手机 Agentic Mobile、华为 KooPhone、Mobile Next Cloud、BrowserStack App Automate。
2. **连线（USB）与无线都能做**：USB 最稳；无线走 Android 11+ 的无线调试配对，Android 17 + platform-tools 37 起还有 ADB Wi-Fi 2.0（mDNS 自动重连）。跨网络用 Tailscale/ZeroTier 把手机拉进同一虚拟内网即可继续 `adb connect`。
3. **对 Craft 的最低成本验证路径是“零改造”**：Craft 的 MCP 源已支持 Streamable HTTP / SSE / stdio（见 [server-builder.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/sources/server-builder.ts)、[client.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/mcp/client.ts)），把 ARTEMIS / mobile-mcp / Droidrun 任一作为 stdio 源挂上去即可让 Craft Agent 操作真机。
4. **要做成产品能力，建议改造安卓客户端为“端侧 Device Agent”**：新增无障碍服务 + 前台服务 + 手机端 MCP HTTP 服务（带 Bearer Token），Craft 侧只需把手机当普通 MCP 源接入，**服务端零改动**。Shizuku 作为可选增强，用于无障碍派发失败或需要 shell 级操作的场景。
5. **必须先接受一条政策红线**：Google Play 自 2026-01-28 起明确禁止“用无障碍 API 让应用自主发起、规划、执行操作”的自动化，因此这类能力基本只能走 GitHub/企业内部分发（旁加载）。Android 的开发者验证新规也让旁加载变复杂，但 **ADB 安装被豁免**。

---

## 1. 市场方案盘点

### 1.1 宿主侧 ADB + MCP（Agent 在电脑/服务器，手机只当被控端）

| 方案 | 形态 | 连接 | 观测/动作 | 特点与适用 |
|---|---|---|---|---|
| **Google ARTEMIS** (Apache-2.0) | Python 工作站 + 原生 MCP Server + Web 控制台 | USB 调试为主（底层 adbutils，可 `adb connect`） | 无障碍 Helper APK 优先，UIAutomator2 兜底；元素索引优先、坐标/视觉兜底 | AndroidWorld 99%+；flash 档约 3–5 秒/步；可采 Logcat/截图；面向测试与 IDE 内驱动 |
| **mobile-next/mobile-mcp** | `npx @mobilenext/mobile-mcp` MCP Server | adb，真机需 USB 调试授权；云真机走 Mobile Next Cloud | 无障碍树优先，截图+坐标兜底；tap/swipe/输入/安装/启动/录屏/按键 | iOS+Android 一套工具；token 省；适合“给任意 MCP 客户端加手机手” |
| **Droidrun** (开源) | Python 框架 + **Portal APK** | USB 或同网无线调试 | Portal 内置 HTTP 服务（8080，经 ADB forward），暴露无障碍树、键盘输入、截图；动作可走 ADB 或 Portal | 端侧组件设计成熟，适合参考其“APK + 本地服务”架构 |
| **CursorTouch/Android-MCP** | 轻量 MCP Server | adb（USB/无线） | 无障碍/UIAutomator 树 + 截图 + 点按 | 上手快，工具面偏基础 |
| **android-mcp-adb** (PyPI) | MCP Server | **明确支持 WiFi ADB** | 截图/OCR/坐标交互，90fps 实时画面 | 强调“零 App 安装”，纯 ADB 派 |
| **android-a11y-mcp** | MCP Server | adb | 通过 Android Accessibility API 检查/交互 | 更偏“看 UI”而非完整任务循环 |
| **Appium + 官方 Appium MCP** | `npx appium-mcp@latest` + UiAutomator2 driver | USB 或无线 ADB | 选择器/元素查找/点击/输入/截图 | 测试级稳定性与生态最好；依赖重、启动慢；适合 QA 与回归 |

**共同点**：都需要在手机上打开开发者选项与调试授权；区别主要在“观测用无障碍树还是截图”“动作走 ADB 还是端侧”。

### 1.2 手机端 Agent / 自动化 App（无电脑，或电脑只做模型调用）

| 方案 | 端侧能力 | 连接 | 说明 |
|---|---|---|---|
| **zerotap agent** | AccessibilityService 设备控制 + **手机自带 MCP Server**（Streamable HTTP + Bearer Token，仅局域网） | 局域网 MCP | 因 Play 政策，主 App 在 Play、设备控制拆成 GitHub 分发的 companion APK；与 Craft 的接入方式最接近 |
| **Operit AI** | 端侧 AI Agent + **Shizuku** shell + 文件/终端 + MCP/Skills | 端侧直跑 | “手机上的 Agent 平台”，可执行 shell，适合重度自动化 |
| **FoneClaw** | 端侧 Agent，Full APK 用无障碍做跨 App 操作；Play Lite 不含设备控制 | 端侧直跑 | 典型“双版本”合规策略 |
| **AutoGLM For Android / Aries AI** | 端侧 App + Shizuku（免 Root）+ AutoGLM-Phone 模型 | Shizuku 激活一次 | 智谱 Open-AutoGLM 的端侧落地；也可用 ADB 连线由电脑驱动 |
| **“Phone for AI Agent”类样例** | 原生 APK 读 UI 树 + 派发真实手势，Node 服务经 WebSocket 下指令 | 局域网/本机 | 结构简单，适合当自研端侧桥的参考实现 |
| **Termux + adb loopback** | 手机上跑 Node/Python，连本机 `adb connect localhost:<port>` | 无线调试 + 本机回环 | 无需电脑，但部署门槛高、功耗与稳定性一般 |

### 1.3 云真机 / 云手机（不碰实体设备）

| 方案 | 能力 | 适用 |
|---|---|---|
| **阿里云无影云手机 Agentic Mobile（MobileUseAgent）** | 自然语言驱动云端 Android 容器做跨应用操作，云端沙箱 | 企业流程自动化、App 测试 |
| **华为云 KooPhone** | 云手机实例 + 异步 `adb shell` 任务 API + 端侧 SDK | 需要 ADB 级控制、批量实例 |
| **Mobile Next Cloud** | MCP/REST 按需分配真机（AWS Device Farm） | 无本地硬件、要规模化 |
| **BrowserStack App Automate MCP / LambdaTest(TestMu)** | 云真机 + MCP 工具，跑测试与截图 | QA、兼容性矩阵 |
| **自建 scrcpy + 虚拟内网** | 手机/盒子跑 adb，Tailscale 组网后 scrcpy 远控 | 低成本“云手机” |

---

## 2. 连线与无线：具体怎么做

### 2.1 USB 连线（最稳）

- 手机开启开发者选项 → USB 调试 → 授权指纹。
- 宿主 `adb devices` 可见后，上述 MCP 方案直接可用。
- 优点：延迟低、授权可控、不受 Wi-Fi 抖动影响；缺点：线材/供电/摆放限制，不适合“随身手机”。

### 2.2 无线 ADB

1. **Android 11+ 无线调试配对（推荐）**：开发者选项 → 无线调试 → 使用配对码；宿主 `adb pair <ip>:<port> <code>`，再 `adb connect <ip>:<port>`。配对一次后可自动重连。
2. **传统 `adb tcpip 5555`**：需先 USB 连一次，之后 `adb connect <ip>:5555`。端口固定、无配对码，安全性最差，**不要暴露到公网**。
3. **Android 17 + ADB Wi-Fi 2.0**（2026-09）：新 mDNS 栈，网络切换/关机后更可靠，自动连接成功率 +32%、连接速度 +66%（官方数据）；需 Android 17、platform-tools 37.0.0、Android Studio Quail 3+。
4. **跨网络**：手机与宿主都装 Tailscale/ZeroTier，用虚拟 IP 继续 `adb connect`；scrcpy 也可直接连 Tailscale IP。

> 安全提醒：5555 端口裸奔的安卓设备是僵尸网络常规目标；无线调试只应在可信网络开启，跨网必须走 VPN + 配对，且用完关闭。

### 2.3 端侧路径（不依赖 ADB 连线）

| 能力 | 实现 | 限制 |
|---|---|---|
| 读 UI 树 | AccessibilityService `getRootInActiveWindow()` / `onAccessibilityEvent` | 部分自绘/游戏/WebView 内容不完整 |
| 截图 | API 30+ `AccessibilityService.takeScreenshot()`；或 MediaProjection | 需在服务配置声明 `canTakeScreenshot`；FLAG_SECURE 窗口截不到；MediaProjection 每次要用户确认 |
| 点按/滑动/输入 | `dispatchGesture()` + `ACTION_SET_TEXT` | 系统安全窗口、部分输入框可能拒绝 |
| Shell 级动作 | **Shizuku**（借无线调试激活一次，免 Root） | 用户需手动激活；OEM 兼容性差异（MIUI/ColorOS 需额外开关） |
| 全屏/多指/后台 | 无障碍手势可全局派发；虚拟屏需 Shizuku/root | 游戏、直播类场景风险高 |

---

## 3. 关键约束与坑

1. **Google Play 政策（2026-01-28 生效）**：明确禁止“任何使应用能够自主发起、规划并执行操作或决策的无障碍 API 用法”，示例包括自动登录、自动导航点击、LLM Agent 代订/代发消息。后果：设备控制能力不能随主 App 上架 Play，只能旁加载/企业内部渠道（zerotap、FoneClaw 都采用“主 App + companion APK”或“Full/Lite 分版”）。
2. **Android 开发者验证 / 旁加载限制**：2026-09-30 起在巴西、印尼、新加坡、泰国对未验证开发者的应用安装/更新做限制，2027 年全球推进；**ADB 安装豁免**，另有“高级流程”（重启 + 24 小时等待）。企业内部分发需提前规划。
3. **OEM 后台杀进程**：MIUI/HyperOS、ColorOS、OriginOS 等会清理无障碍/前台服务，需要引导用户加白名单、关闭省电限制；HarmonyOS NEXT 不跑 APK，直接排除。
4. **观测精度与成本**：无障碍树 token 便宜、坐标稳定；截图视觉兜底贵且慢。建议“树优先 + 截图兜底 + 必要时 OCR”，而不是纯视觉。
5. **坐标与屏幕**：必须用真实 `DisplayMetrics`/旋转后的坐标系；多屏、折叠屏、分屏要单独处理。
6. **隐私与审计**：UI 树可能包含聊天、验证码、银行信息；需要 App 白名单、敏感操作二次确认、操作日志、屏幕锁定时自动停用。
7. **输入法**：端侧输入建议用 `ACTION_SET_TEXT` 而不是模拟按键；ADB 方案可用 `adb shell input text`（中文/emoji 支持差）。
8. **旁加载受限设置**：Android 13+ 对非商店安装的 App 默认不允许开启无障碍/通知监听，用户需在“应用信息 → 右上角 → 允许受限设置”里手动放行，这会显著增加上手成本。

### 3.5 会不会被目标 App 检测到正在自动化？

**会，而且对金融、社交、游戏类 App 基本是“确定性事件”。** 检测不是某一个开关，而是多层信号的组合：

| 层 | 检测点 | 谁能拿到 | 说明 |
|---|---|---|---|
| 系统枚举 | `AccessibilityManager.isEnabled()`、`getEnabledAccessibilityServiceList()`、`getInstalledAccessibilityServiceList()`、`AccessibilityServiceInfo.getId()/getCapabilities()` | 任意 App | 能直接看到“哪个包的无障碍服务开着”，以及是否同时具备“读屏 + 派发手势”的全控能力 |
| 注入标志 | `MotionEvent.FLAG_IS_ACCESSIBILITY_EVENT`（API 31+）、`FLAG_IS_GENERATED_GESTURE`、缺失 `pressure/size/toolType`、`SOURCE_UNKNOWN` | 任意 App | 无障碍手势会被打标；`INJECT_EVENTS`/`adb input` 也常缺压力、面积、工具类型 |
| 调试环境 | `Settings.Global.ADB_ENABLED`、`sys.usb.state` 含 `adb`、本机 5555 端口可连、`Debug.isDebuggerConnected()` | 任意 App（部分 ROM 限制反射） | 这是 ADB 路线最直接的暴露面 |
| 包名/完整性 | `queries` 已知自动化包名（uiautomator、Shizuku、AutoGLM、Appium 等）；Play Integrity `appAccessRiskVerdict` 的 `UNKNOWN_CAPTURING / UNKNOWN_CONTROLS / UNKNOWN_OVERLAYS` | 任意 App（Play Integrity 需接入） | Google 已把“别的应用能截屏/叠加/控制设备”做成标准风控信号 |
| 行为特征 | 操作速度、轨迹过于笔直、无加速度计/陀螺仪变化、输入法不出现、验证码/滑块 | 风控后端 | 单点不足以定性，但组合起来很准 |
| 账号/设备 | 云手机、模拟器、多开、设备指纹、IP、登录环境异常 | 风控后端 | 豆包手机一代就是“登录环境异常”被强制下线 |

**不同方案的暴露面：**

| 方案 | 主要暴露点 | 被识别概率 |
|---|---|---|
| USB ADB | `ADB_ENABLED` + USB adb 状态 + 注入事件特征 | 高 |
| 无线 ADB | 上述 + 局域网/端口特征（随机端口仍可看 `ADB_ENABLED`） | 高 |
| 端侧无障碍 | 服务枚举 + capabilities + `FLAG_IS_ACCESSIBILITY_EVENT` | **最高**（最容易被“一刀切”拦截） |
| Shizuku | Shizuku 包/服务 + `ADB_ENABLED` + 注入特征 | 高 |
| 硬件 HID / 物理点击 | 无软件注入痕迹，呈现为真实输入设备 | 最低，但成本/速度/可靠性差，行为层仍可被分析 |
| 云手机/模拟器 | 设备指纹、传感器、GPU、IP、Play Integrity | 高 |

**能不能藏？**

- **无 root：不能可靠隐藏。** 无障碍服务按设计就是可枚举的，手势事件也带标志位；这是平台能力，不是实现瑕疵。
- **root + LSPosed/Xposed：理论上能 hook 掉枚举和标志位，但 root/Magisk/LSPosed 本身会被 Play Integrity、内存扫描、`/proc` 检查发现**，属于军备竞赛，且违反绝大多数 App 的 ToS，不建议作为产品方案。
- **厂商合作/官方 API/MCP/A2A：唯一可持续路线。** 让 App 主动开放能力，而不是替它点屏幕。

**现实案例（2026）**：豆包手机一代上线数天内，微信账号因“登录环境异常”被强制下线，淘宝、支付宝、拼多多、美团及多家银行触发风控；二代改用 SAEP 协议，仍有 155 款 App 明确拒绝被 GUI 自动化操作（微信、QQ、淘宝、支付宝、美团、快手、拼多多、小红书、WPS、多家银行与运营商），王者荣耀会直接踢出游戏。说明**即使有 OS 级整合，也过不了生态与风控这一关**。

### 3.6 root 后能否绕过检测？

**短答：能提高“骗过静态检查”的概率，但不能稳定绕过，而且代价很高。** root 只是给了你“安装 hook”的能力，不是“免检通行证”。

**（1）root 本身就会被检测**

- su 二进制、Magisk/KernelSU/APatch 的包与文件、Zygisk/LSPosed 注入痕迹；
- mount/overlay 异常、`/proc/self/maps` 里的 magisk 库、系统属性与 build 不一致；
- bootloader 解锁 / verified boot 失败；
- Play Integrity 与 TEE 硬件证明；
- 银行/游戏常用 **native（JNI）检查**（`stat/access/dlopen/popen`、内存扫描、ptrace 检测），Java 层 Xposed 根本看不到，需要 Dobby/Ptrace 级 hook。

**（2）root 能做什么**

- Magisk DenyList + Zygisk + Shamiko/HMA + Play Integrity Fix/TrickyStore/SUSFS 等组合，隐藏 root 文件、挂载和模块；
- LSPosed 按包 hook `AccessibilityManager`、`Settings.Secure`、`MotionEvent.getFlags()`、`PackageManager` 查询，让目标 App “看不见”无障碍服务和注入标志；
- 系统级 patch（自定义 ROM / system_server hook）才能**全局**移除无障碍服务枚举、剥掉事件 flag；
- 内核级虚拟 HID（把注入呈现为真实触摸设备）是软件方案里最接近“无痕”的，但仍可被设备指纹与行为分析识别。

**（3）root 不能做什么**

- **Play Integrity STRONG 依赖硬件 key attestation**，解锁 bootloader 后无法诚实通过；用泄漏 keybox 伪造会被 Google 吊销，且法律风险高；
- 原生反作弊、银行 native 检测、内存扫描、完整性校验；
- 行为与后端风控：操作速度、轨迹、传感器、账号/IP/设备指纹、交易模式；
- **生态拒绝**：155 款 App 明确拒绝 GUI 自动化；绕过检测不等于获得授权，事后仍可封号；
- **误杀**：微信连视障辅助工具都会封，说明其策略是“宁可错杀”，不是“证据确凿才封”。

**结论**：root 是军备竞赛的入场券，不是稳定方案。对自有设备、自有 App、研究用途可以玩；作为产品能力不要依赖。真正可持续的仍是官方 API / MCP / A2A / 商务合作，或只操作自有 App。

**对 Craft 的设计含义：**

1. 不要把“绕过检测/反风控”当产品目标；它既不可靠，也会把 Craft 拖进合规与账号封禁风险。
2. 默认只操作**自有 App、用户明确授权的 App、或白名单 App**；金融、支付、社交、游戏默认禁用。
3. 做“可解释的自动化”：常驻通知/悬浮指示、随时停止、逐 App 授权、操作审计；遇到验证码/风控页/`FLAG_SECURE` 立即交还用户。
4. 自有 App 的 QA 用 Espresso/UiAutomator/测试后门，而不是 GUI Agent；自己的 App 可以把自动化包加入白名单，避免误判。
5. 要接第三方能力，优先官方 API / MCP / A2A / 商务合作；GUI 自动化只作为“用户自己的设备 + 低风险动作”的兜底。

---

## 4. Craft 现状（改造评估的事实基础）

### 4.1 安卓客户端

- 结构很小：`MainActivity`（服务器列表）、`WebViewActivity`（加载服务器 WebUI）、`ServerStore`（SharedPreferences 存服务器地址）、`ServerEditActivity`、`NotificationHelper`、`DisplaySettings`、`Insets`、`CraftApp`。
- 本质是**薄壳 WebView**：见 [WebViewActivity.kt](file:///c:/Users/Ryan/code/craft-agents-oss/apps/android/app/src/main/java/com/craftagent/android/WebViewActivity.kt)；已有 JS ↔ Native bridge（`craftBridge`），但目前只处理 `ready / navigationState / openServerList / notification`。
- [AndroidManifest.xml](file:///c:/Users/Ryan/code/craft-agents-oss/apps/android/app/src/main/AndroidManifest.xml) 只有 INTERNET / NETWORK_STATE / POST_NOTIFICATIONS，**没有任何 Service、无障碍、悬浮窗、前台服务声明**。
- 依赖仅 AndroidX + Material（[app/build.gradle.kts](file:///c:/Users/Ryan/code/craft-agents-oss/apps/android/app/build.gradle.kts)），没有网络服务端库、没有 Shizuku。

结论：当前客户端**完全不具备**读屏、手势、截图、常驻后台、被 Agent 调用的能力；要让它成为“被操作端”，需要新增一个独立模块，而不是小改。

### 4.2 服务端 MCP 能力

- 源类型支持 `http | sse | stdio`（[types.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/sources/types.ts#L244-L303)）。
- HTTP 走 **Streamable HTTP Client**，支持自定义 headers（[client.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/mcp/client.ts#L110-L120)）。
- 服务端自身也能以 Streamable HTTP 暴露 MCP 工具池（[pool-server.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/mcp/pool-server.ts)）。

结论：**手机只要能提供一个 Streamable HTTP 的 MCP 端点，Craft 侧无需改代码**，按普通 MCP 源添加即可（URL + Bearer Token）。这是改造方案设计的最大便利。

---

## 5. 改造方案与对比

### 方案 A：零改造，直接挂现成 ADB MCP（最快验证）

```
手机 --USB/无线ADB--> 运行 Craft Server 的电脑 --stdio--> ARTEMIS / mobile-mcp / Droidrun / Appium MCP
                                                              ↑ Craft 作为 MCP 源接入
```

- 改动：0 行代码；只需在 Craft 里加一个 stdio MCP 源。
- 前提：Craft Server 所在机器能连到手机（同一局域网、USB、或 Tailscale）。
- 适合：内部验证、QA、开发调试；不适合“云服务器上的 Agent 控制我随身的手机”。

### 方案 B：端侧 Device Agent（推荐产品化方向）

在现有 Android 客户端内新增 `device-agent` 模块：

```
Craft Agent (server)
      │  MCP over Streamable HTTP (Bearer token)
      ▼
手机 App: 本地 MCP Server (Ktor/NanoHTTPD, 仅局域网/回环)
      ├── AccessibilityService：UI 树、点击、滑动、输入、返回/Home/最近任务、截图(API30+)
      ├── (可选) Shizuku：input/screencap/am/settings 等 shell 级动作
      └── Foreground Service：常驻、通知、电池白名单引导
```

建议工具面（首版）：

| 工具 | 作用 |
|---|---|
| `device_status` | 型号/系统/分辨率/旋转/前台 App/电量/网络 |
| `ui_tree` | 压缩后的可交互节点树（含坐标与可用动作） |
| `screenshot` | 按需截图（默认降采样/JPEG） |
| `tap` / `swipe` / `long_press` | 坐标或节点 ref 操作 |
| `input_text` | `ACTION_SET_TEXT`，避免模拟按键 |
| `press_key` | back/home/recents/enter |
| `open_app` / `list_apps` | 包名启动、已安装列表（可白名单） |
| `wait_for` | 等待节点/文本/前台包变化，减少轮询 |
| `shell`（可选，Shizuku） | 受限命令白名单 |

- Craft 侧改动：0（当 MCP 源接入）。
- 手机侧改动：新增无障碍服务、前台服务、本地 MCP 服务、授权/二维码 UI、白名单与审计。
- 网络：同一局域网直连；跨网用 Tailscale。若 Craft Server 在公网云上且无法组网，需方案 C。
- 合规：不能上 Play；走 GitHub/企业分发。

### 方案 C：出站 WebSocket 设备通道（云服务器场景）

- App 复用现有 `craft_session` 登录态，主动 WSS 连到 Craft Server，注册为“设备节点”。
- 服务端新增一个内置 MCP Server，把设备通道包装成 `android_*` 工具；WebUI 增加设备授权页。
- 优点：无需用户配置 IP/端口，能穿透 NAT，天然多设备管理。
- 代价：协议、鉴权、服务端工具、WebUI 都要改；是三个方案里工程量最大的。

### 方案 D：Shizuku 增强 / 云真机

- Shizuku：在方案 B 上加一层“权限升级”，解决 `dispatchGesture` 失效、需要 shell、需要装/卸载/改设置等场景；用户用无线调试激活一次，无需电脑。
- 云真机：阿里云无影云手机 / 华为 KooPhone / Mobile Next Cloud。适合“只要 Agent 能操作 Android”，可完全避开真机供电、锁屏、OEM 后台与合规问题；但不是“用户的真机”。

### 对比

| 维度 | A 现成 ADB MCP | B 端侧 Device Agent | C 出站设备通道 | D 云真机 |
|---|---|---|---|---|
| 安卓端改动 | 无 | 大 | 大 | 无 |
| 服务端改动 | 无 | 无 | 大 | 小（接 API） |
| 无线可用 | 是（无线 ADB/VPN） | 是（局域网/VPN） | 是（任意网络） | 是 |
| 远程云 Server | 难 | 需组网 | 原生支持 | 原生支持 |
| 稳定性 | 高（USB 最高） | 中（OEM 后台/无障碍） | 中 | 高 |
| 合规风险 | 低（ADB 豁免旁加载验证） | 高（Play 禁止无障碍自动化） | 高 | 低 |
| 观测成本 | 树/截图均可 | 树优先，最省 | 同 B | 视云厂商 |
| 适合 | 验证/QA | 产品化“操作我的手机” | 多设备/云端产品 | 规模化、无真机 |

---

## 6. 推荐路线

> **2026-11 补充**：如果目标是 AirDroid 式「远程控制 + 画面」，优先复用 Craft 现有的 device link / `computer` capability / WS 帧流，而不是单独做一个端侧 MCP。详细评估见 [android-remote-control-feasibility.md](./android-remote-control-feasibility.md)。端侧 MCP 仍适合“只给 Agent 用、不要实时画面”的轻量集成。

**阶段 0（验证，零代码）**
- 在 Craft Server 所在电脑装 platform-tools，手机 USB 授权。
- 挂 `@mobilenext/mobile-mcp` 或 Google ARTEMIS 为 stdio MCP 源，跑通“打开设置→查电量→截图”这类跨 App 任务。
- 再用无线调试（Android 11+ 配对）重复一遍，确认无线体验。

**阶段 1（产品 MVP，方案 B）**
- 安卓端新增：无障碍服务（树/手势/截图）、前台服务、本地 MCP Streamable HTTP + Bearer Token、启停与授权页、App 白名单。
- Craft 端：把手机作为 MCP 源接入（URL + Token）；先不做服务端改造。
- 先支持“同一局域网/Tailscale”，把工具面控制在 8–10 个。

**阶段 2（增强）**
- Shizuku 可选权限升级（shell 白名单、安装/设置类动作）。
- 若确认 Craft Server 部署在公网云且用户不愿组网，再做方案 C 的出站通道。
- 增加审计日志、敏感操作确认、锁屏自动停用、多设备路由。

---

## 7. 验收清单（建议）

- [ ] USB 与无线（配对码 / ADB Wi-Fi 2.0）两种连接都能发现设备并执行 tap/type/back。
- [ ] 无障碍树能覆盖主流 App（微信/支付宝/浏览器/系统设置）；WebView 页面有截图兜底。
- [ ] 截图在 API 30+ 走 `takeScreenshot`，FLAG_SECURE 页面有明确错误而不是黑图。
- [ ] App 被切后台/锁屏/重启后，前台服务与无障碍能自动恢复或明确提示。
- [ ] MIUI/HyperOS、ColorOS、OriginOS 各一台真机通过后台存活测试。
- [ ] Token 可轮换；MCP 端点默认只绑局域网/回环；错误日志不落 UI 文本与验证码。
- [ ] 敏感动作（支付、删除、发消息）有二次确认或直接禁用。
- [ ] 明确分发方式（GitHub/企业 MDM），不依赖 Google Play。

---

## 7.5 附：抖音 / 小红书 可行性速查

**结论：技术上能跑通，但合规与账号层面基本不可行；只有“官方开放平台 + 资质”或“人在回路的辅助创作”是可持续的。**

| 场景 | 抖音 | 小红书 |
|---|---|---|
| 浏览/搜索/采集 | 技术上可行；但《抖音用户服务协议》5.1 明确禁止“任何自动化程序、软件或类似工具接入抖音，收集或处理其中信息、内容” | 技术上可行；小红书反爬 + 风控，2026-03 公告明确治理“自动浏览”，并有 IP 封禁案例 |
| 自动发布内容 | 有官方 API：“代替用户发布内容到抖音（服务产品）”，但仅面向政务媒体/企业服务，要求企业主体、注册资本≥50 万、注册≥1 年、正式应用，且不得面向 C 端 | 开放平台面向商家/服务商（商品、订单、售后、ERP），**不面向个人开发者提供笔记/评论通用接口**；手机脚本/自动化 APP 自动发布被明令禁止 |
| 点赞/评论/关注/私信 | 无个人账号官方 API；互动管理能力面向企业号/服务商，部分已下线；自动化属违规 | 公告点名“手机脚本、按键精灵、自动化 APP”自动点赞、评论、私信，属治理范围 |
| 客服/电商运营 | 抖店/抖音电商开放平台、企业号互动管理能力（需资质） | 小红书千帆/开放平台商家 API（需店铺授权） |
| 矩阵/群控/养号 | 打击群控软件、云抖机、刷量水军；媒体报道 2026 新规对“一机多号”加强管控，频繁切换会触发人脸复核 | 2026-03-10 公告后已处置 AI 托管账号 42 万个；全自动账号直接封禁，半自动账号禁言/限流 |

**平台明令原文（要点）：**

- 抖音《用户服务协议》5.1：“您不得使用任何插件、外挂、系统或第三方工具对抖音的正常运行进行干扰、破坏、修改或施加其他影响，包括但不限于使用任何自动化程序、软件或类似工具接入抖音，收集或处理其中信息、内容。”
- 小红书 2026-03-10《关于打击 AI 托管运营账号的治理公告》：严禁利用技术手段模拟真人、进行非真实内容创作或虚假互动；治理范围明确包括“使用手机脚本、按键精灵、自动化 APP 等手机端托管工具代替真人操作，实现自动发布、自动浏览、自动点赞、自动评论、自动私信”。
- 小红书在豆包手机 SAEP 拒绝清单中；抖音未在清单中（同属字节生态），但这不等于第三方 Agent 可以自动化抖音——抖音仍受自身协议约束。

**对 Craft 的建议：**

1. 不要做“通用代操作抖音/小红书”的卖点；这既违反平台协议，也会把封号/法律风险转嫁给用户。
2. 如果要做内容场景，定位为“创作助手”：AI 生成选题/文案/封面/草稿，**由真人确认并发布**；或走官方开放平台/服务商资质做 B 端工具。
3. 如果只是内部研究/自有设备验证，技术上可以用无障碍/ADB + 视觉跑通，但不要规模化、不要多账号矩阵，并接受随时封号。

---

## 8. 参考链接

- Google ARTEMIS: https://github.com/google/artemis ；评测：https://hysenlabs.com/en/projects/google-artemis
- mobile-mcp: https://github.com/mobile-next/mobile-mcp ；文档：https://mobilenext.ai/docs/
- Droidrun: https://docs.droidrun.ai/quickstart ；Portal 架构：https://deepwiki.com/droidrun/droidrun-portal/1-overview
- Appium MCP: https://appium.io/docs/en/latest/ecosystem/tools/
- CursorTouch/Android-MCP: https://github.com/CursorTouch/Android-MCP
- android-mcp-adb: https://pypi.org/project/android-mcp-adb/
- android-a11y-mcp: https://lobehub.com/mcp/benoberkfell-android-a11y-mcp
- Open-AutoGLM: https://github.com/zai-org/Open-AutoGLM
- AutoGLM 论文: https://arxiv.org/pdf/2411.00820
- Operit AI: https://shizukuapps.com/apps/operit-ai/
- FoneClaw: https://www.foneclaw.ai/download
- zerotap agent: https://zerotap.app/agent ；MCP Server: https://zerotap.app/mcp-server-android
- Shizuku: https://shizuku.rikka.app/guide/setup/
- ADB Wi-Fi 2.0（Android 17）: https://developer.android.com/blog/posts/introducing-fast-and-reliable-wireless-debugging-with-android-debug-bridge-adb-wi-fi-2-0
- Android 无线调试文档: https://developer.android.com/tools/adb
- Google Play 无障碍 API 政策解读: https://myappmonitor.com/blog/google-play-accessibility-services-policy-update
- Android 开发者验证: https://developer.android.com/developer-verification/guides/faq
- 阿里云无影云手机 Agentic Mobile: https://help.aliyun.com/zh/ecp/shadowless-ai-cloud-mobile-phone/
- 华为云 KooPhone API: https://support.huaweicloud.com/api-koophone/kp_01_0002.html
- BrowserStack MCP: https://www.browserstack.com/docs/browserstack-mcp-server/tools/app-automate
- 阿里云《当 AI Agent 接管手机：移动端如何进行观测》（无障碍/注入/ADB 检测手法）: https://developer.aliyun.com/article/1721905
- Play Integrity 完整性判定（appAccessRiskVerdict）: https://developer.android.google.cn/google/play/integrity/verdicts?hl=zh-cn
- 155 款 App 拒绝豆包手机助手（SAEP）: https://36kr.com/p/4026632161251972
- 微信对无障碍辅助工具的误判/封号案例: http://m.toutiao.com/group/7655536538222084617/
- 抖音《用户服务协议》（5.1 禁止自动化程序接入）: https://lf3-cdn-tos.draftstatic.com/obj/ies-hotsoon-draft/douyin_agreement/26cc76ba-c2e5-4213-b59e-d0231b7ff602.html
- 抖音“代替用户发布内容到抖音（服务产品）”能力: https://developer.open-douyin.com/m/announcement/131
- 抖音发布能力使用规范（主体/注册资本要求）: https://developer.open-douyin.com/docs/resource/zh-CN/dop/operation-standard/platform-capabilities/useclue
- 小红书开放平台（商家/服务商定位）: https://open.xiaohongshu.com/home
- 小红书开放平台开发者角色说明: https://xiaohongshu.apifox.cn/doc-2811119
- 小红书打击 AI 托管运营账号（第一批“养虾人”被封）: https://finance.sina.com.cn/tech/roll/2026-03-11/doc-inhqqupq5635668.shtml
- 小红书已处置 AI 托管类违规账号 42 万: http://m.toutiao.com/group/7663445154874917382/
- 抖音治理网络水军/群控工具公告: http://m.toutiao.com/group/7413923173755781672/
- 豆包手机 SAEP 拒绝清单（含小红书）: https://o.doubao.com/developer
