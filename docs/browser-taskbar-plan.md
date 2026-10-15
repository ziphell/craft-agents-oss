# 浏览器窗口的独立任务栏按钮与「禁止固定」— 开发文档

> **定位**：本文只写**独立浏览器窗口**（`browser-pane-manager` 创建的那个无边框窗口）在 Windows 任务栏上的两件事：①它有**自己的任务栏按钮**（不与应用窗口合并）；②这个按钮**不提供「固定到任务栏」**。不重复 [设计方案](design-plan.md) 的窗口模型，也不碰托盘（见 [托盘文档](tray-plan.md)）。
>
> **一句话**：窗口有自己的 AUMID → 独立按钮，这件事纯 Electron 能做；要让系统**不给这个按钮「固定」入口**，得绕过 Electron 直接设一个 Windows 窗口属性。
>
> **状态**：已实现。Windows 专属；非 Windows 平台是空实现。
>
> **读法**：§1 现状与目标；§2 为什么必须绕过 Electron；§3 方案（含关键顺序与属性键）；§4 代码位置与改动清单；§5 打包；§6 取舍与风险。

---

## 1. 现状与目标

`BrowserPaneManager.createInstance()` 创建的是一个 `frame: false` 的独立窗口，**每个工作区一个**。任务栏行为分两步落地：

| 目标 | 手段 | 是否已实现 |
|---|---|---|
| 名称固定为 `Craft Browser`（任务栏 / 窗口切换器可见） | `BrowserWindow` 的 `title` | 是 |
| 自己的窗口图标（蓝色 Craft 字形，区别于应用的紫色） | `BrowserWindow` 的 `icon` + 资源 `browser-icon.ico/.png` | 是 |
| **独立任务栏按钮**（不与应用窗口合并） | `win.setAppDetails({ appId })` | 是 |
| **按钮不提供「固定到任务栏」** | 见 §2、§3 | 是（本文重点） |

背景：Windows 任务栏按 **AppUserModelID（AUMID）** 分组。同进程的所有窗口默认共用一个 AUMID，于是浏览器窗口被折进应用窗口的那一个按钮里。给窗口设一个**不同的 AUMID** 就能把它抬成独立分组——这就是 `setAppDetails` 的作用。

---

## 2. 为什么必须绕过 Electron

`setAppDetails` 的选项在本仓库安装的 Electron（39.2.7）里只有五项（`node_modules/electron/electron.d.ts` 的 `AppDetailsOptions`）：

```
appId / appIconPath / appIconIndex / relaunchCommand / relaunchDisplayName
```

**没有** Windows 用来屏蔽固定的那个开关：`System.AppUserModel.PreventPinning`（一个窗口属性，设在窗口的 `IPropertyStore` 上）。全局也搜不到任何 `PreventPinning`。

两个曾被考虑的误区：

- **去掉 `relaunchCommand/relaunchDisplayName`**：只是让「固定」时没有我们提供的重启目标，条目**仍然存在**（Windows 会退回用进程 exe）。开发模式下 exe 是 `electron.exe`，一样可被固定。所以这条路走不通。
- **`node-ffi-napi`**：自 2021 起停止维护，无法在 Electron 39 / Node 22 上加载，弃用。

结论：要**同时**满足「独立按钮」和「没有固定项」，只能在设 `appId` 之外，调到 Win32 的 `SHGetPropertyStoreForWindow` → `IPropertyStore::SetValue(PKEY_AppUserModel_PreventPinning, TRUE)`。

---

## 3. 方案：koffi + Win32

用 **koffi**（N-API FFI，自带各平台预编译二进制，**无需本机编译 / 无需 electron-rebuild**）在运行时调用 Win32。

### 3.1 步骤

1. `koffi.load('shell32.dll')`，声明 `SHGetPropertyStoreForWindow(HWND, REFIID, void **ppv)`。
2. 取窗口 HWND：`win.getNativeWindowHandle()`（Windows x64 上是 8 字节 Buffer，小端存放 HWND）。
3. 传入 `IID_IPropertyStore`，拿到 `IPropertyStore*`（`pps`）。
4. 通过 COM vtable 调用（koffi 用 BigInt 表示指针，`koffi.call(ptr, proto, ...)` 调函数指针）：
   - `SetValue(PKEY_AppUserModel_PreventPinning, PROPVARIANT{ VT_BOOL, VARIANT_TRUE })`
   - `Commit()`
   - `Release()`
5. **再**调用 `win.setAppDetails({ appId })`。

### 3.2 关键顺序

**先设 `PreventPinning`，再设 `appId`。** 反过来时该属性会被忽略——这是本方案唯一必须遵守的顺序约束。

### 3.3 用到的常量

| 名称 | 值 |
|---|---|
| `IID_IPropertyStore` | `{886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}` |
| `PKEY_AppUserModel_PreventPinning` | `fmtid {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}`，`pid 9` |
| `VT_BOOL` / `VARIANT_TRUE` | `11` / `0xFFFF` |
| vtable 索引 | `IUnknown`: 0 QueryInterface / 1 AddRef / 2 Release；`IPropertyStore`: 3 GetCount / 4 GetAt / 5 GetValue / **6 SetValue** / **7 Commit** |

### 3.4 为什么是 koffi 而不是自写原生 addon

| | koffi | 自写 N-API addon |
|---|---|---|
| 本机编译 | 不需要 | 需要 node-gyp + MSVC + electron-rebuild |
| 对本仓库的影响 | 只在 `win32` 分支懒加载，其余平台零影响 | 每台机器 / 每条 CI 都要装工具链 |

本仓库目前**没有任何原生模块基建**，为「纯外观」功能引入编译步骤性价比低。koffi 把风险收敛到一处、且可替换。

---

## 4. 代码位置与改动清单

- **新增** `apps/electron/src/main/windows-prevent-pinning.ts`：
  - `preventTaskbarPinning(win: BrowserWindow): void`
  - 入口即判 `process.platform !== 'win32'` → 直接返回（**懒加载** koffi，非 Windows 永不 require）。
  - 全程 `try/catch`，**best-effort**：失败只记日志，绝不影响窗口创建。
- **改动** `apps/electron/src/main/browser-pane-manager.ts`：在 `createInstance()` 里，`setAppDetails(...)` **之前**调用 `preventTaskbarPinning(window)`。
- **改动** `apps/electron/package.json`：`koffi` 加入依赖；`build:main` 与 `build:main:win` 的 esbuild 加 `--external:koffi`（原生模块不可被打包）。
- **改动** `apps/electron/electron-builder.yml`：`win.extraResources` 加一条，把 koffi 放进 `app/node_modules/koffi`（见 §5）。

---

## 5. 打包

本仓库 `electron-builder.yml` 设了 **`asar: false`**，且 `files` 里有 `!node_modules/**/*`——原生依赖一律走 `extraResources`（SDK、ripgrep、bun 都是这么发的）。

koffi 要发的是**两个包**：`koffi` 只是 JS 壳，预编译二进制在按平台拆分的 `@koromix/koffi-*` 包里。koffi **2.x** 曾把它放在 `koffi/build/koffi/<triplet>/`，**3.x 已移出**——这是本方案第一版踩过的坑。koffi 的加载器按这个顺序找（`node_modules/koffi/src/koffi/index.cjs` 的 `loadDynamic`）：

```
${__dirname}/../../../@koromix/koffi-${platform}-${arch}   →  app/node_modules/@koromix/…
<koffi>/../../build/koffi/<triplet>/koffi.node             →  3.x 下该目录不存在
```

于是 Windows 目标加**两条**：

```yaml
win:
  extraResources:
    - from: ../../node_modules/koffi
      to: app/node_modules/koffi
    - from: ../../node_modules/@koromix/koffi-win32-x64
      to: app/node_modules/@koromix/koffi-win32-x64
```

运行时 `dist/main.cjs` 里 `require('koffi')` 会向上解析到 `app/node_modules/koffi`（与 SDK 的落位一致），再从上面第 1 条路径取二进制。**只拷壳会静默失效**：加载器抛 `Cannot find the native Koffi module; did you bundle it correctly?`，被 `preventTaskbarPinning` 的 `try/catch` 吞掉。dev 下根 `node_modules/@koromix/` 在，解析得到，所以症状是「开发环境生效、打包版不生效」。mac/linux 目标**不加**这两条——那边根本不加载 koffi。

---

## 6. 取舍与风险

- **非 Windows 是空实现**：macOS / Linux 没有该概念，且 macOS 会忽略 `BrowserWindow` 的 icon；本方案只在 Windows 生效。
- **无法在本机验证**：FFI 的 vtable 调用、`PROPVARIANT` 布局属底层细节，需在真实 Windows 会话里实测；失败是**优雅降级**——窗口仍有独立按钮与图标，只是「固定」入口还在。
- **第三方二进制**：koffi 的二进制是按平台拆分的可选依赖包，只会随包发出 Windows x64 那一份（`@koromix/koffi-win32-x64/win32_x64/koffi.node`，约 1 MB），无需再裁剪。
- **打包版静默失效**：失败只走 `mainLog.warn`，而打包版默认关掉了 file / console transport（见 `logger.ts` 的 debug 判定），产物里不留痕迹。排查时用 `--debug` 启动，warn 会写进 electron-log 的 `main.log`。
- **与 `setAppDetails` 的关系**：先 `PreventPinning` 再 `appId`，顺序不可调换（§3.2）。
- **开发模式**：dev 下 exe 是 `electron.exe`，本就「可固定」；本方案对 dev 与打包版一视同仁地设 PreventPinning。

---

## 7. 开放问题

1. 若某天 Electron 原生暴露 `PreventPinning`（或 `AppDetailsOptions` 增加该字段），应删掉本模块、直接走官方 API。
2. 是否需要给其它「辅助窗口」（如 design 独立窗口）套用同一处理——目前只做浏览器窗口。
