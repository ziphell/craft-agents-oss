# 在 Craft 里引入 GenOffice 的 docs / sheets / slides / pdf

> 目标：`preview + 应用内编辑`，第一期只做这四种格式。
> 对象：`C:\Users\Ryan\code\craft-agents-oss`（Electron 39.2.7）+ `C:\Users\Ryan\code\genoffice`（Electron 43.8.3）
> 日期：2026-10-29

## 0. 结论

**能做，而且这一步比在纳米 Work 里做更省力** —— Craft 主进程里已经躺着一套"把第三方 web 应用当文档面托管"的完整基建：

| 已有基建 | 位置 | 直接复用什么 |
| --- | --- | --- |
| 原生视图三明治（页面 + chrome + overlay） | `browser-pane-manager.ts`（19 处 `WebContentsView`） | 若要走"主窗口内嵌"，bounds/层级/停车窗口逻辑照抄 |
| 第三方 webapp 自建 origin 托管 | `drawio-host.ts`（436 行）+ `@craft-agent/shared/local-origin` | 服务的形状、CSP、离线保证 |
| 离屏宿主窗口 | `office-export-host.ts` / `drawio-render.ts` | 预加载 + ready 探针 + 截图/导出的时序 |
| 多窗口 + 每窗口 preload + 路由 | `window-manager.ts`（`openDesignWindow` → `?designWindow=true`） | 文档窗口 = 再来一个 `?docWindow=true` |
| 关闭守卫 | `window-close-guard.ts` | 脏文档保存提示接到这里 |
| 预览分派单一插口 | `App.tsx` 的 `FilePreviewRenderer`（按 type switch） | 加 `docx/xlsx/pptx` 四个 case |

真正要新写的只有四件：**构建/裁剪管线、IPC 命名空间、脏/存/关生命周期、Electron 39 兼容验证**。

## 1. 两种落地形态（必须先选）

| | A. 独立文档窗口（推荐先做） | B. 主窗口内嵌 overlay |
| --- | --- | --- |
| 形状 | `openDocumentWindow(path)` → `BrowserWindow` 全屏加载 GenOffice renderer（+ 它自己的 ribbon 或裁剪版） | 在 React overlay 之上叠一个 `WebContentsView`，bounds 跟随 overlay |
| 新 plumbing | 几乎为零：照 `openDesignWindow` 复制 | 需要新写"overlay ↔ 原生视图"布局层：bounds 跟随、z-order、overlay 关闭即销毁、缩放/滚动同步、窗口 resize |
| Craft 现状 | 已有 3 个窗口类型 | **主窗口目前没有任何 `addChildView` 先例**（只有 browser 窗口有） |
| 脏/存/关 | 与窗口生命周期天然对齐（close guard） | 要处理"overlay 关掉时文档还在编辑器里、窗口还开着"的错位 |
| 体验 | 和 Word 一样是"一个窗口一份文档"；可与会话并排 | 更"贴"，但在 Craft 现有布局里要抢位置 |

**建议：A 先上，B 作为二期。** A 的窗口里直接放 GenOffice renderer（`file://…/genoffice/docs/renderer/index.html`），preload/main 由 Craft 主进程提供 —— 也就是它自带的三件套，只是宿主换成了 Craft。

## 2. 构建与裁剪管线（一次性，但必须可重复）

```
genoffice@<pin>  ──patch──▶  build:docs/sheets/slides/pdf  ──▶  apps/electron/resources/genoffice/
                                                               ├─ docs/{main,preload,renderer}
                                                               ├─ sheets/…  + native/xlsx-sidecar.exe
                                                               ├─ slides/…
                                                               ├─ pdf/…
                                                               └─ CHANGES.md（pin + patch 清单）
```

- **构建**：`npm run build -w @genoffice/docs` 等四条；`@genoffice/i18n` 要打包进 renderer（上游注释已说明它是 TS 源）。
- **sidecar**：sheets 需要 Rust 编译的 `xlsx-sidecar.exe`（namiwork 那份 8.4MB，可直接对照），三平台矩阵。
- **必修 patch**（纳米 Work 已经踩过一遍，可直接借）：
  1. `PRODUCT_FEATURES = { ai:false, cloudProjects:false, analytics:false, autoUpdate:false }`
  2. preload 关掉：项目/drop-open/联网 OCR/跨应用转换/自动更新入口
  3. 各 `src/main/index.ts` 的 `startXStandalone()` 不要（宿主自建），改用 `configureXRuntime({...}) + createXView(path)`
  4. `app.getPath('userData')` 的落点：会写 `fonts/`、`slides-autosave/`、`slides-recent.json`、project store —— 要么接受落在 Craft 的 userData，要么 patch 成 `userData/genoffice/`
- **体积**：docs 21M + sheets 32M + slides 7.7M + pdf 7.7M(+main 1.2M) ≈ **70MB**，另有 sidecar 8.4MB。
- **许可**：Apache-2.0，保留 `NOTICE`/`LICENSES`；"GenOffice" 名称与图标不随代码授权。

## 3. 宿主要提供的四件事（GenOffice 的嵌入式契约）

上游的契约很窄，每个 app 就三件：`configureXRuntime(paths)` / `createXView(path)` / 一组 hooks。

```ts
// Craft 主进程（示意，与上游签名 1:1）
configureDocsRuntime({ preloadPath, rendererFile, openGeneratedPath })
const view = createDocsView(path)            // 返回 WebContentsView
mainWindow.contentView.addChildView(view)    // 形态 A 里是独立窗口：win.contentView.addChildView(view)

setDocsFileSavedHook((wc, path) => …)        // 通知 Craft：文件已变（session watch / artifact 索引刷新）
requestDocsSave(contents, mode)              // Craft 菜单 / 关闭守卫调用
docsIsDirty(contents)                        // 关闭前判断
```

sheets 额外要 `sidecarPath`，pdf/slides 额外要 `openGeneratedPath`（AI 生成的文档用，AI 关掉后可空实现）。

**必须在 `app.ready` 之前**注册各自的 privileged scheme（docs/pdf 各有一套 media scheme；html 有 `html-preview://` + `html-asset://`，这一期虽然不引 html，但若以后引要一起注册）。

## 4. 三个必须处理的工程细节

### 4.1 IPC 通道（197 个）

上游四个 app 共 `ipcMain.handle` **197 个唯一通道**：`docs:*` `sheets:*` `ai:*`（14）`files:*` `app:get-language` `project:deleteChat/listChats` `win:focus/list/new` `zotero:*`。

Craft 用自己的 `area:name` 命名（`file:read` `projects:get` `window:*` `server:*`）。

- **精确撞名：没有**（`file:` vs `files:`、`project:` vs `projects:`、`win:` vs `window:` 都是近似而非相同）。
- **但近似名会咬人**：调试时看到 `files:pick` 分不清归谁。
- **建议**：patch 时给上游通道统一加前缀 `gx:`（或 `genoffice:`），在 `build` 后用脚本校验：**任何 `ipcMain.handle` 的名字必须带前缀**，否则构建失败。这一条比事后排查便宜十倍。
- **安全**：GenOffice 的写权限按 `webContents` 授权（`allowedByWc`/`saveAsTargetByWc`），但宿主还应额外校验"发起请求的 webContents 属于哪个文档窗口"，否则 Craft 主窗口的 renderer 也能调 `docs:save`。

### 4.2 脏 / 存 / 关

```
用户关窗口 → window-close-guard → docsIsDirty(wc)?
                                  └─ 是 → requestDocsSave(wc,'save') 或弹"保存/不保存/取消"
文件被外部修改 → 上游 external-change.ts 已有提示；Craft 侧只需监听 setDocsFileSavedHook 刷新 watcher/artifact 索引
Craft 菜单 Cmd+S → requestDocsSave(activeDocWc,'save')
```

namiwork 的经验：`requestDocsClose` / `saveAs` 都是**异步握手**（120s 超时），Craft 的 close guard 需要改成可等待的。

### 4.3 Electron 39 vs 43

Craft 跑 `electron@39.2.7`，GenOffice 开发基线是 `^43.8.3`。实测扫描：上游 main 模块**没有**用 `webContents.navigationHistory` / `BaseWindow` / `WebContentsView.setBorderRadius` 这类 41+ 才有的 API，风险集中在这几处，必须逐个冒烟：

- `WebContentsView` 构造选项（`webPreferences` 新字段被忽略不报错）
- `protocol.handle` 的 Response 语义 / `stream` 权限
- `session.setPermissionRequestHandler` 的分类型（media/display-capture）差异
- `webContents.printToPDF` 的选项（pdf/sheets 导出走它）

结论：**先做一次"用 Electron 39 加载 docs 模块"的 spike**，两天内能定性。

## 5. 最小验收清单（每一期都跑一遍）

- [ ] 打开 `.docx`：版式、字体、分页与 Word 一致；表格跨页正确
- [ ] 编辑一段文字 → Cmd+S → **字节级**校验：未改的 zip 条目不变（上游的"只重写改动块"承诺）
- [ ] 外部改同一文件 → 编辑器给冲突提示，不静默覆盖
- [ ] 未保存关窗 → 三选一提示；取消能留住内容
- [ ] `.xlsx`：公式重算走 sidecar；大表滚动不卡；CSV/TSV 打开正常
- [ ] `.pptx`：字体回退（本机无商业字体时的替代）、图片/媒体走 slide-media scheme
- [ ] `.pdf`：批注、表单、缩略图；保存后原 PDF 的其它对象不变
- [ ] 断网：全部可用（除 AI，已关）
- [ ] 远端/WebUI 模式：文档窗口**不出现**或明确置灰（照 `creation-thumbnailer` 的 no-op 约定）

## 6. 与"产物看板"的关系

这一步直接给看板送来第 3 节里最贵的两块：

- **P2 的"就地看/改"**直接到位（不再是缩略图占位）；
- 缩略图管线可以先用 `pdf` 模块的导出/打印拿第一页，不必再上 CLI。

所以顺序建议调整为：**先嵌 docs/pdf（体积小、验证快）→ 再 sheets（要 Rust）→ 最后 slides（字体/媒体最复杂）**，每上一个就在 `FilePreviewRenderer` 里多一个 case，看板那边只是多一种 `format`。

## 7. 风险清单

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| Electron 39 兼容 | 可能某模块直接崩 | 先 spike，出问题优先判"升级 Craft 的 Electron"（39→43 的破坏面比想象小，但要走一遍 browser-pane 回归） |
| 上游 40 天 288 commits 漂移 | 每次升级都要重放 patch | patch 目录化 + 构建脚本校验；不要手改 `resources/` 里的产物 |
| userData 污染 | `fonts/`、`slides-autosave/`、project store 落进 Craft 配置目录 | patch 成子目录，或接受并在文档里写明 |
| 体积 +70MB（+8.4MB sidecar） | 安装包变大、签名/增量更新变慢 | 可选做成"文档引擎"可选组件（首次打开时下载），但会引入联网与校验，先不做 |
| 双份 OOXML 能力 | Craft 手写 xlsx 导出与 GenOffice 的引擎并存 | 明确分工：**打开/编辑用 GenOffice 的**；导出以各自的产物为准（见 §导出） |
| 与远端会话模式冲突 | WebUI/远端下无主进程 | 约定：文档窗口只在本地 Electron 提供 |
