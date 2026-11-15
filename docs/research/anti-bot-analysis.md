# 百度 / 贴吧 / 抖音 / 小红书 的自动化检测与 Craft 浏览器评估

实测时间：2026-10-28 18:0x–18:3x（GMT+8），Craft 内嵌浏览器（Chromium 142.0.7444.235 / Electron，RTX 4090 / ANGLE-D3D11）。
证据目录：`sessions/261028-true-frost/data/`（`js/` 原始与反混淆脚本、`probe*.js` 探针、`html/` 首页）。

---

## 0. 一句话结论

四家在**匿名浏览路径**上都没有拦我们（实测无验证码，且拿到了各家完整的风控 token）；
它们的自动化检测重心不是"无头/自动化标志"，而是**注入篡改 + 环境自洽性**。
Craft 因为跑的是真 Chromium、真 GPU、未开自动化开关，天然躲过了前者；
但**窗口几何、权限态、`window.chrome`、UA-CH brands** 四项是硬破绽，一旦进入登录态高频操作就会暴露。

---

## 1. 百度 hector（`hectorstatic.baidu.com/cd37ed75a9387c5b.js`，118 KB）

### 形态
不是普通 SDK，而是 **自研 JS 解释器 + 字节码**：文件里 `Interpreter` 出现 4 次，尾部是大段字节码，
字符串以字符码数组存放，例如 `[99,111,108,108,101,99,116,68,97,116,97]` = `collectData`。
静态 grep 明文一个都搜不到 —— 这是**防逆向级别的保护**。

### 还原出的字符串表（399 条可读串，`python3` 解字符码数组得到）
关键采集/检测项：

**① 自动化与注入黑名单（逐变量 in window 探测）**
```
webdriver  _selenium  __selenium_evaluate  __selenium_unwrapped  _Selenium_IDE_Recorder  callSelenium
__nightmare   _phantom   callPhantom
cdc_adoQpoasnfa76pfcZLmcfl_Array / _Promise / _Symbol      ← ChromeDriver 的经典 $cdc_ 变量
____rtc_onicecandidate   __fnrthen_dd_                    ← 特定逆向脚本的残留
fnStr  notNative  [native code]                           ← 函数 toString 是否被改
via_gm            ← 油猴脚本
xjsObj  wb_js_object  mx_browser_obj  doc_obj  ydsq  yujianobj  hide_baidubaozhang  ad-info
OutSdk  WebSdk  WebView  AgentWeb  CefSharp  QCefWidget  OKDSO  HwDevice  FHJS  swan-mibrowser  baiduboxapp
```
后一组是**浏览器壳/套壳识别**（CefSharp、QCefWidget 这类 Electron/CEF 壳全在名单里）。

**② 引擎版本指纹（判 UA 是否谎报）**
几十条 `return !!xxx` 能力探针 + 语法探针：
`Intl.Segmenter / supportedValuesOf / ListFormat / Locale / DisplayNames`、`AbortSignal.abort|timeout|throwIfAborted`、
`WeakRef`、`structuredClone`、`self.reportError`、`scheduler.postTask`、`ReadableByteStreamController`、
`window.CropTarget`、`XRFrame`、`ElementInternals.shadowRoot`、`document.fragmentDirective`、
`navigator.bluetooth.getAvailability`、`navigator.permissions`、`navigator.mediaCapabilities.encodingInfo`、
`RegExp("x*","d")`、`[].at`、`[].findLast`、`String.prototype.matchAll`、`requestVideoFrameCallback`、
`<body>.inert`、`matchMedia("(prefers-contrast: less)")`、`class U_in { #x=0; a(o){ return #x in o } }`、
`??=`、`1_000` 数字分隔符、`?.`、`Path2D.addPath`、`new Proxy({},{})`、`onauxclick`、
`toLocaleString("en-US",{style:"unit",unit:"meter-per-second"})`、`toLocaleDateString("zh-CN")`。
→ 用一组特性的"存在/缺失组合"反推真实引擎版本，和 UA 声明的版本比对。

**③ Canvas / WebGL 指纹**
`toDataURL`、`canvasHex`、`getCanvasHex`、`getContext('experimental-webgl'|'moz-webgl'|'webgl'|'webgl2')`、
`WEBGL_debug_renderer_info`、`UNMASKED_VENDOR_WEBGL`、`UNMASKED_RENDERER_WEBGL`、`getVideoCard`、`videoCard`、
`fillText` + `font:"14px 'Arial'"` + `fillStyle:"rgba(102, 204, 0, 0.7)"` + `textBaseline:"alphabetic"` + `preserveDrawingBuffer`
（标准 canvas 指纹配方；还埋了一个伪装串 `Ilbc@gyfi,com <canvas} 1.0` 用于校验字形渲染）。

**④ 环境读数**
`hardwareConcurrency`、`maxTouchPoints`/`msMaxTouchPoints`、`ontouchstart`、`devicePixelRatio`、
**`outerWidth`/`outerHeight`**、**`screen.availWidth`/`availHeight`**、`languages`、`platform`、`product`、`productSub`、`oscpu`、`referrer`、`cookie`、`localStorage`、`permissions`。

**⑤ Cookie 完整性校验**
`BA_HECTOR` / `ba_hector_` / `getEncodedBaHector` / `setTime` / `getTimeSegment` / `getVersionSegment` /
`getParitySegment` / `getFeaSegment` / `numPerSegment` / `featureSegmentNum`
→ 分段（时间/版本/特征/奇偶校验）拼装，用来发现 cookie 伪造或跨设备搬运。

**⑥ 行为采集与按站调度**
`clickCount`、`clickTarget`、`exeSearchAndClick`、`onpointerrawupdate`、`focusout`、`onbeforeprint`、
`IntersectionObserver`、`ResizeObserver`、`globalObserver`；
`loadCollectDataJs` / `loadPcSearchResultCollectDataJs` / `loadBcpCollectDataJs` / `pcAiAssistantCollectDataJs` / `pcSearchResult`，
字节码里直接写着 `tieba` —— **贴吧用的是同一套 hector**。
打点：`https://hector.baidu.com/a.js`、`https://hector.baidu.com/static/h.gif`。

### 注意
字符串表里**没有** `userAgentData` / `brands` → 百度不查 UA-CH，`window.chrome` 也只作为壳识别的一项。
所以百度这条线上，我们最大的风险是**几何**（`outerWidth/Height`、`screen.avail*`、`devicePixelRatio`）。

### 实测
- 首页 `https://www.baidu.com/`：cookie 中已生成 **`BA_HECTOR`**（说明 hector 初始化并上报成功），
  另有 `BAIDUID`、`BAIDUID_BFESS`、`BIDUPSID`、`PSTM`、`ZFY`、`__bid_n`、`H_PS_PSSID`、`BD_UPN`、`BAIDU_WISE_UID`。
- **`PAD_BROWSER`** cookie 被置上 —— 我们的视口是 `321×845` 而屏幕报 `528×1030`、`dpr=1`、无触摸，
  百度据此把我们归到了平板/移动一类。这是几何异常**已经产生后果**的直接证据。
- `https://www.baidu.com/s?wd=棒球`：正常返回 3871 字结果，无验证页。

---

## 2. 百度贴吧 `tieba.baidu.com`

- 裸 `curl`（真 Chrome UA、无 cookie）→ **403 百度安全验证**（旋转 JS 挑战页）。说明 WAF 在 HTTP/TLS 层就做拦截。
- Craft 浏览器里 → 正常渲染真实内容（皇马吧、物理吧等），无验证页。
- 站点侧 JS 即 hector（`tieba` 在字节码里）+ 常规百度 passport。
- 结论：**贴吧的门槛在传输层 + hector，不在 JS 自动化检测**；我们过了。

---

## 3. 抖音（字节 bdms + acrawler）

### 现场拿到的 token
| cookie | 值（节选） | 含义 |
|---|---|---|
| `__ac_nonce` | `06ae1ca1c00f64525c071` | acrawler JS 挑战下发的 nonce |
| `__ac_signature` | `_02B4Z6wo00f01OoOD6wAAIDBW-6xtYIxAIDqLgsAAFBn2c` | **挑战已解出**（说明我们过了） |
| `s_v_web_id` | `verify_mvryem8q_zVnlBMRV_L0im_47bM_BGNp_F398k4SE4GPP` | 设备指纹 id |
| `x-web-secsdk-uid` | `38d08bd1-6078-4644-8b08-e5d0bde499ca` | 安全 SDK 发的设备 uid |
| `fpk1` | `U2FsdGVkX1+...`（`Salted__` 前缀） | **CryptoJS AES 加密的指纹包** |
| `fpk2` | `25f0bd57ac496918077cdd538b72bb4c` | 指纹 md5 |
| `bit_env` | 长 base64url | 环境位图/加密环境包 |
| `device_web_cpu_core` / `device_web_memory_size` / `architecture` | `16` / `8` / `amd64` | 客户端自报硬件 |
| `bd_ticket_guard_*` | — | 请求签名用的票据与密钥对 |
| `strategyABtestKey` | `"1793182242.022"` | AB 分流 |
| `sdk_source_info` | 见下 | **明文检测结果 JSON（XOR 5 混淆）** |

`s_v_web_id` 结构：`verify_<base36 毫秒时间戳>_<8>-<4>-<4>-<4>-<12>`。
`mvryem8q` → base36 解码 = `1793182238234` → **2026-10-28T10:10:38.234Z**，正是我们打开页面的时刻。

### 硬证据：bdms 自己上报的自动化检测结果
`sdk_source_info` 每个字节 XOR 5 即得：

```json
{"automa_ele":"false","bit_helper":"false","chrome_extension_script":"[]",
 "console_lied":"false","global_variables":"[]","swt_alt":"false",
 "zn_cap":"false","hok_noti":"false","inj_zfb":"false",
 "t":"4373942813971","bit_protocol":"false"}
```

| 字段 | 语义 | 我们 |
|---|---|---|
| `automa_ele` | DOM 里的自动化特征元素 | false ✅ |
| `bit_helper` | 字节助手指令通道 | false ✅ |
| `chrome_extension_script` | 扩展注入脚本清单 | `[]` ✅ |
| **`console_lied`** | **console 函数是否被篡改**（toString 检测） | false ✅ |
| **`global_variables`** | **全局变量黑名单命中** | `[]` ✅ |
| `inj_zfb` / `hok_noti` / `swt_alt` / `zn_cap` | 各类注入/劫持 | 全 false ✅ |
| `bit_protocol` | 是否字节 App 内协议 | false ✅ |

→ 抖音明确在查 **console 篡改** 和 **全局变量名单**，而我们在两项上都干净。
`window.byted_acrawler`、`window.bdms` 均在页面运行。

### 实测
`https://www.douyin.com/` → 跳 `/jingxuan`，正文 3976 字、有 `<video>`，未被拦截；
`/passport/web/check_qrconnect/` 每 5 秒轮询（未登录扫码态），`fp=verify_...`、`webid/device_id=7701659043157345801` 已下发。

---

## 4. 小红书（xhs-pc-web + secsdk）

### 明文检测函数（`index.a9f61821.js`，2.5 MB，未混淆）
```js
const tR = ["headless","phantom","webdriver","selenium","nightmare","sequentum"];
function isHeadless() {
  const e = navigator.userAgent.toLocaleLowerCase();
  return navigator.webdriver || tR.some(t => e.includes(t));
}
function unSupportBrowser() {                    // 只拦 IE/Trident 与 Chrome<49
  const e = navigator.userAgent.toLocaleLowerCase(), t = e.match(/Chrome\/(\d+)\./);
  const n = t ? Number.parseInt(t[1],10) : null;
  return e.includes("msie") || e.includes("trident") || !!(n && n < 49);
}
```
另有探测调度门：
```js
function canRunNow() {
  return document.visibilityState === "visible"
      && navigator.onLine !== false
      && !navigator.webdriver
      && !isBotUA(navigator.userAgent);
}
```
配套 `xhs_push_probe:*` 的 localStorage 采样桶（`getStableSampleBucket` / `markDailyProbe` / `isSampled`）
—— 只在被抽中的当天做可达性探测，降低打草惊蛇。

### 请求签名
- `window._webmsxyw` = function（VMP 化的签名器，产出请求头 `x-s` / `x-t`），实测在场。
- cookie：`websectiga`、`sec_poison_id`、`a1`、`webId`、`gid`、`abRequestId`、`xsecappid`、`loadts`、`ets`、`webBuild`、`unread`
  —— `websectiga` / `sec_poison_id` 是 **secsdk 的服务端风控态**，匿名访问也会下发。
- 页面全局还有 `__xhsPendingNotePoint25300ReportMap` 等一堆埋点缓存。

### 实测
`https://www.xiaohongshu.com/explore` → 正常出 958 字 feed（登录弹窗 + 推荐流），无验证页。

---

## 5. Craft 浏览器的实际画像（同一批 props 实测）

```
UA            Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.235 Safari/537.36
UA-CH brands  ["Not_A Brand/99","Chromium/142"]                ← 缺 Google Chrome
uaData.arch   x86/64/false, platformVersion 19.0.0
window.chrome {}  (csi/loadTimes/app/runtime 全 undefined)
webdriver     false
plugins 5 / mimeTypes 2 / pdfViewer true                        ← 与真 Chrome 一致
permissions   20 项全部 "granted"（0 个 prompt，0 个 denied）      ← 无人类会这样
Notification.permission = granted
WebGL         Google Inc. (NVIDIA) | ANGLE (NVIDIA, RTX 4090, D3D11)   ← 真实
geometry      screen 528×1030, avail 528×982, window 321×845,
              outer==inner==321×845, screenX=20528, dpr=1
iframe 一致性  chrome=object, webdriver=false, UA 相同, screenX=20528 相同
全局泄漏      __electronLog, __CRAFT_THEME_OBSERVER_CLEANUP__
console.toString() = function log() { [native code] }            ← 干净
CreepJS       0% headless / 25% like headless / 0% stealth / lies: 无
```

`screenX=20528` 是离屏停车窗（`20000 + screen.width` 的位置）—— 窗口在屏幕外 2 万像素处，
但页面读到 `visibilityState=visible`、`hasFocus=true`。再配合 `outer==inner` 与 `321×845`，
对任何读几何的风控都是**一眼假**。

---

## 6. 谁能看到哪一项（按实测证据归因）

| 破绽 | 百度 hector | 贴吧 | 抖音 bdms | 小红书 secsdk | 依据 |
|---|---|---|---|---|---|
| `webdriver` | ✅查 | ✅ | ✅ | ✅（明文） | hector 串表 / xhs `isHeadless` |
| `$cdc_`/`callPhantom`/`__nightmare`/`_selenium` | ✅逐项 in window | ✅ | 未知（vmp） | 未知 | hector 串表 |
| 全局变量名单 | 部分 | 部分 | ✅ `global_variables` | 未知 | bdms 上报 JSON |
| console 被改 | ✅`notNative`/`[native code]`/`fnStr` | ✅ | ✅ `console_lied` | 未知 | 同上 |
| canvas/webgl 指纹 | ✅`canvasHex`/`UNMASKED_*` | ✅ | ✅`fpk1` AES | 未知 | hector 串表 |
| **窗口几何** | ✅`outerWidth/Height`、`screen.avail*`、`devicePixelRatio` | ✅ | 间接（进 `bit_env`） | 未知 | hector 串表 + `PAD_BROWSER` |
| **UA-CH brands** | ❌不查 | ❌ | 推测查（UA-CH 是字节标配） | 未知 | hector 串表无 `userAgentData` |
| **权限态** | 有 `permissions` 符号 | — | 常见 | — | hector 串表 |
| **`window.chrome`** | 只作壳识别 | — | 常见 | — | hector 串表 `chrome` |

---

## 7. 能不能绕过？分层回答

**A. 匿名浏览 / 公开内容（今天的样子）——能，已实测**
四站全部正常出内容、无验证码，且拿到了 `BA_HECTOR`、`__ac_signature`、`s_v_web_id`、`websectiga` 这些
"通过风控"的凭证。原因是我们的 `webdriver=false`、console 原生、无 `cdc_`/`__nightmare` 类残留、
无扩展注入、GPU 是真的 —— 恰好对上了各家**最在意的那几项**。

**B. 登录态 / 高频 API（点赞、关注、搜索、发布）——会栽，且栽在指纹不是身份**
服务端会拿 `bit_env`、`fpk1`(AES 指纹包)、`websectiga`、`canvasHex` 做设备聚类。
我们的指纹有 4 个"人类不可能有"的特征（见 §5），一整批会话会聚成一簇陌生设备，
然后就是限流/滑块/封号，而不是"检测到 Puppeteer"。

**C. 修的顺序（性价比）**
1. **停车窗几何**（最值钱）。不要在那个 20528 的位置渲染页面；或渲染时让 `screenX/screenY`
   落在屏幕内的合理值。项目里已有方案 B（屏内透明置顶 + 边距 48 + `keepOffEveryDisplay` 兜底），
   同时能解掉 `outer==inner` 的一半观感问题与 `PAD_BROWSER` 式的误判。
2. **权限**。用 `session.setPermissionCheckHandler` 让非常用权限返回 `prompt`/`denied`，
   只留 clipboard（自动化需要）。20 项全 granted 是任何风控都不会放过的信号。
3. **`window.chrome`** 在 preload 里补 `csi()`/`loadTimes()`/空 `app`、`runtime`，并让 `toString` 走原生。
4. **去全局化** `__electronLog` 与 `__CRAFT_THEME_OBSERVER_CLEANUP__`
   （后者 MEMORY 里记录已改 `Symbol.for`，但**当前构建里仍是字符串全局** → 改动没进这个包）。
   字节的 `global_variables` 名单今天没收录它们，但名单是服务端下发的，随时能加。
5. **UA-CH brands** 只能两条路：常驻 `Emulation.setUserAgentOverride`（和 5s idle-detach 冲突），
   或 fork Chromium 改 branding。维持"暂不修"的结论不变 —— 百度不查它，抖音侧成本/收益不划算。
6. **不建议**做的：给 `outer` 造偏移。会破坏 `window.screenX == event.screenX - clientX` 的恒等关系
   （MEMORY 已实测差 50/90 px），反而新增矛盾。

---

## 8. 复现路径

```
data/js/baidu-hector.js              # 原始（解释器 + 字节码）
data/js/xhs-index.js                 # 小红书主包（含 isHeadless/unSupportBrowser 明文）
data/js/xhs-as-04b2948.deob.js       # obfuscator 还原（568 处字符串替换）
data/probe-env.js / probe2.js        # 指纹探针
data/sdk.js / dyck.js / fullck.js    # 各站 SDK 与 cookie 探测
data/page.js                         # 页面状态读取
```

hector 字符串表还原：
```python
import re
s = open('baidu-hector.js', encoding='utf-8', errors='replace').read()
for a in re.findall(r'\[(\d{1,3}(?:,\d{1,3}){3,})\]', s):
    nums = [int(x) for x in a.split(',')]
    if all(32 <= n < 127 for n in nums):
        print(''.join(chr(n) for n in nums))
```

抖音 `sdk_source_info` 解码：`bytes(x ^ 5 for x in bytes.fromhex(v))`。
