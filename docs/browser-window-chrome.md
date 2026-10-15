# 浏览器窗口的材质与圆角 — 开发文档

> **定位**：本文只写**独立浏览器窗口**（`browser-pane-manager` 创建的那个无边框窗口）的**表面**：①窗口背后的 OS 材质，以及画在材质上的那层半透明壳；②网页面板的圆角是怎么做出来的——页面自己的 view 裁角、overlay 补缺口、两条框线。不重复 [任务栏文档](browser-taskbar-plan.md) 的任务栏内容，也不重复 [设计方案](design-plan.md) 的窗口模型。
>
> **一句话**：**材质是窗口的属性，壳是同一个表达式被两个进程各画一次**；**圆角由页面自己的 view 裁，缺口由 overlay 的 `#mask` 补**。
>
> **状态**：已实现。
>
> **读法**：§1 材质（窗口 → 壳 → 回退）；§2 圆角的三层；§3 层序（它决定缺口补不补）；§4 代码位置；§5 踩过的坑；§6 取舍与开放问题。

---

## 1. 材质

### 1.1 材质是**窗口**的属性，不是文档的

`createInstance()` 建窗口时按平台给 `BrowserWindow` 要一个材质（`browser-pane-manager.ts`，`getWindowsBackgroundMaterial()` 起的那个块）：

| 平台 / 版本 | 给的选项 |
|---|---|
| Windows 11（build ≥ 22000） | `backgroundMaterial: 'mica'` |
| Windows 10 1809+（build ≥ 17763） | `backgroundMaterial: 'acrylic'` |
| 更老的 Windows、Linux | 没有材质 |
| macOS | `vibrancy: 'under-window'` + `visualEffectState: 'active'` |

版本判定只在 `src/main/window-material.ts` 的 `getWindowsBackgroundMaterial()` 一处，一个函数给**所有**想要半透明壳的窗口同一个答案（工作区的窗口也读它，见 `window-manager.ts`）——否则两个窗口会是差一个版本的两块灰。

**有材质时 `backgroundColor` 必须省略**：它是不透明的，会把材质整个盖掉。

```ts
// hasGlassBackdrop = darwin || Boolean(winMaterial)
...(hasGlassBackdrop ? {} : { backgroundColor: bgColor }),
```

浏览器窗口的两层 chrome view 自身是透明的（`chromeView.setBackgroundColor('#00000000')`、`nativeOverlayView.setBackgroundColor('#00000000')`），所以 chrome 没画东西的地方看到的就是材质本身。

### 1.2 壳：同一个表达式，两个进程各写一次

材质之上那层"半透明壳"就是 **50% 的 app 背景色**：

```css
color-mix(in srgb, <--background> 50%, transparent)
```

两处各写一次，必须给出同一个灰：

| 谁 | 在哪 | 写法 |
|---|---|---|
| chrome 文档（顶栏 + rail） | `renderer/index.css`：`html.browser-chrome .browser-chrome-surface` | `color-mix(in srgb, var(--background) 50%, transparent)` |
| overlay 文档（页面周围与下面的面） | `browser-pane-manager.ts`：`updateNativeOverlayState()` 里的 `surface` | `color-mix(in srgb, ${getBackgroundColor(...)} 50%, transparent)` |

两者相等不是巧合：`--background`（renderer）与 `BACKGROUND_HEX`（主进程）本来就是同一个值，`packages/shared/src/config/theme.ts` 里写明了这一条。

`browser-chrome-surface` 只挂在 chrome 的**面**上——顶栏那一条和 rail 那一列（`browser-toolbar.tsx`），而不再套第二层：两层半透明叠起来会变成第三种灰。

### 1.3 回退：没有材质时

老的 Windows 与 Linux 拿不到材质，窗口用不透明的 `backgroundColor`（`getBackgroundColor(nativeTheme.shouldUseDarkColors)`，跟主题走，避免开窗闪黑/白），壳照旧画。

**壳在没有材质时不变样子**：`C` 的 50% 叠在同一个不透明的 `C` 上，结果还是 `C`。这就是"回退成不透明底色"不改变外观的原因——变的只是窗口后面还有没有东西。

---

## 2. 圆角

### 2.1 数字在一个地方

`src/shared/panel-geometry.ts`：

| 常量 | 值 | 用在哪 |
|---|---|---|
| `PANEL_RADIUS_INNER` | `10` | 页面 view 的裁角半径；`#frame` / `#lock` 用 `+1` |
| `PANEL_EDGE_INSET` | `6` | 页面面板到窗口右 / 下边的距离 |
| `TAB_RAIL_WIDTH` | `200` | rail 的宽（两侧都读它） |
| `TOOLBAR_HEIGHT` | `48` | 顶栏的高（两侧都读它） |

放同一个文件的原因写在文件头：chrome 是 renderer 用 CSS 像素画的，页面是主进程用一个 view 矩形摆的，两边必须对同一组数。同文件里的 `PANEL_RADIUS_EDGE` 是"角就是窗口自己的角"时用的半径，**只被 app shell（`panel-constants.ts`）读**，浏览器页面不用它。

### 2.2 圆角是三层拼出来的

**① 页面自己的 view 裁角**

`applyPageCornerRadius()`：`tabView.setBorderRadius(PANEL_RADIUS_INNER)`。

这是**原生**属性，而且那圈切口是**按窗口当前显示器的度量**建的：换显示器（或缩放比变了）之后角会退回直角，所以 `moved` 和每次重排都重说一遍（`reassertPageCornerRadii()`）。同一个 view 还带页面自己的底色（`tabBackdropFor()`）：真页面用浏览器画布白，新标签页用 app 的面色——那画的是我们自己的文档。

**② overlay 文档补上缺口**

`nativeOverlayView` 装的是一份 `data:text/html`（`loadNativeOverlayDocument()`），它画页面**周围**和**下面**的一切。四个元素：

| 元素 | 是什么 | 关键属性 |
|---|---|---|
| `#mask` | 与页面同一个矩形 | `box-shadow: 0 0 0 9999px <壳色>` 把矩形**外面**全铺成壳色；矩形**里面**在 overlay 位于页面**之下**时填成壳色（见 ③ 与 §3） |
| `#frame` | 静息态的细线 | 在矩形**外** 1px、`border-radius: PANEL_RADIUS_INNER + 1`，让它的弧与页面的角同心；颜色 `resolvePagePanelRing()`，阴影 `resolvePagePanelShadow()` |
| `#lock` | agent 持有该 tab 时的框 | 同一个盒子，`border: 2.5px`——外侧 1px 落在 gutter 里，内侧 1.5px 盖住页面自己的边（**含角**） |
| `#chip` / `#shield` | agent 的标签与输入屏蔽 | 不属于本文（见 `updateNativeOverlayState()`） |

`#mask` **故意是方的**，文档里写明了理由：圆角由页面自己的 view 裁，在这里再画一条弧就是同一形状的第二份实现（这边是 CSS 像素，那边是显示器的度量），两者不一致时反而会露出页面的白边。**"补缺口"用的是填色，不是画弧**——页面的角切在页面 view *之内*，那四个缺口既在页面 view 里、也在 `#mask` 这个矩形里，页面不画的地方由 mask 填上（填不填由 §3 决定）。

**③ gutter**

```ts
pagePanelInsets(railCollapsed) = {
  left: railCollapsed ? PANEL_EDGE_INSET : 1,
  top: 1,
  right: PANEL_EDGE_INSET,
  bottom: PANEL_EDGE_INSET,
}
```

页面贴着 rail 和顶栏，所以左边和上面是 **1px**——那不是留白，是给 `#frame` 那条线留的位置：线画在页面**外面** 1px，而 chrome 盖在页面这一侧，不留这 1px，线的上段和左段会被 chrome 盖掉、永远看不见。rail 收起后左边没东西可贴，改用 `PANEL_EDGE_INSET`。

---

## 3. 层序：它决定缺口补不补

三个视图在同一个 `contentView` 树里，顺序由 `restackViews()` **一处**决定（两个 `BrowserView` 用 `setTopBrowserView`，页面用 `addChildView`，从下往上逐个抬）：

| 状态 | 顺序（下 → 上） | 为什么 |
|---|---|---|
| 无菜单、无锁 | overlay < chrome < page | 页面是人自己的，点在页面上 |
| 有菜单 | overlay < page < chrome | 菜单挂在页面之上，chrome 必须在最上面 |
| 被持有 | chrome < page < overlay | agent 的框、chip、shield 要在页面之上 |

于是"**overlay 在页面之上**" ⟺ **被持有 且 没有菜单**，`updateNativeOverlayState()` 里就是这一条：

```ts
const overlayOverPage = locked && !(instance.toolbarMenuOpen || menuActive)
```

`#mask` 的**填色**跟着它走（`mask.style.background = overlayOverPage ? 'transparent' : 壳色`）：overlay 在页面**之上**时必须留空，否则会盖住页面；在页面**之下**时必须填，否则页面被切掉的四个角缺口会露出窗口材质。

这条判断**必须从层序读出来，不能凭"有没有菜单"猜**——曾经就是这么写的（填色跟着 `shieldActive`），而菜单恰恰让 overlay 回到页面之下，两个判断对不上，于是菜单一开四个角就露底色（§5）。

---

## 4. 代码位置

| 文件 | 符号 | 职责 |
|---|---|---|
| `apps/electron/src/main/window-material.ts` | `getWindowsBackgroundMaterial()` | 平台 / 版本 → `mica` / `acrylic` / 无 |
| `apps/electron/src/main/browser-pane-manager.ts` | `createInstance()` | 窗口选项：`backgroundMaterial` / `vibrancy` / 省略 `backgroundColor` |
| 同上 | `updateNativeOverlayState()` | 壳色的表达式；`#mask` / `#frame` / `#lock` 的位置与填色；`overlayOverPage` |
| 同上 | `loadNativeOverlayDocument()` | overlay 文档本体：`#mask` 的方盒与 spread 阴影、两条框线 |
| 同上 | `applyPageCornerRadius()` / `reassertPageCornerRadii()` | 页面 view 的裁角，以及在 `moved` 与每次重排时重说 |
| 同上 | `restackViews()` | 三层视图的顺序 |
| 同上 | `tabAreaBounds()` / `pagePanelInsets()` / `pageAreaBounds()` | 页面与 gutter 的几何 |
| `apps/electron/src/renderer/index.css` | `html.browser-chrome .browser-chrome-surface` | chrome 侧的壳 |
| `apps/electron/src/renderer/browser-toolbar.tsx` | 顶栏与 rail | 壳挂在哪两个面上 |
| `apps/electron/src/shared/panel-geometry.ts` | 四个常量 | 两侧共读的数字 |
| `packages/shared/src/config/theme.ts` | `BACKGROUND_HEX` / `getBackgroundColor()` | CSS 与主进程共用的那个颜色 |

---

## 5. 踩过的坑

- **两个 chrome view 的接缝**：rail 和顶栏曾经是两个 `BrowserView`，半透明壳在两块里各画一次，边界上叠出一条看得出颜色的缝——"背景不是一个整体"。现在是一个文档、一个铺满窗口的 view。
- **顶栏被 rail 截断**：rail 曾经与顶栏同一行、只占左列，于是那条横向的面在最左边 200px 处被切断。现在顶栏横跨整窗，rail 在它**下方**；rail 自己的 `+` 移进顶栏（位置几乎不变），rail 不再留一条空的表头带。
- **macOS 的 86px 空档**：曾经给红绿灯避让留 86px——但浏览器窗口是 `frame: false`，**macOS 的无边框窗口没有红绿灯**（那是原生标题栏的一部分，工作区窗口靠 `titleBarStyle: 'hiddenInset'` 才有）。空档已去掉，两边都是 14px。
- **菜单打开时四个角露出材质**：`#mask` 的填色曾跟着"有没有菜单"关掉，而层序里菜单恰恰让 overlay 回到页面之下，两个判断对不上（§3）。
- **右下角"漏了一点"**：壳化之后，页面圆角的缺口露出的正是被去掉的不透明底色背后的材质。修法不是改圆角，而是让 `#mask` 在 overlay 位于页面之下时把矩形填成壳色（§2.2）——壳色的那层遮罩才是"面板坐在什么上"的答案。
- **新标签页闪一下**：新标签页是我们自己的文档，页面 view 的初始底色曾统一用浏览器画布白，深色主题下开一个 tab 会闪一下白。现在 `tabBackdropFor()` 按"是不是新标签页"给底色。

---

## 6. 取舍与开放问题

- **壳的表达式写了两遍**（CSS 变量 vs 主进程 hex）。两者的**值**由 `theme.ts` 保证一致，但字符串本身没有共享：改壳的比例（`50%`）要同时改两处，否则 gutter 与 chrome 会出现两种灰。
- **`#mask` 是方的**（§2.2）：刻意，但它成立的前提是"overlay 与页面用同一个矩形"——`pagePanelInsets` 一变，两边都要跟着变。
- **`setBorderRadius` 是原生属性**：切口按显示器度量构建，换屏后会失效，所以靠重说维持（`reassertPageCornerRadii()`）。一次调用换一次重算，目前没有更省的办法。
- **材质是整窗的**：`backgroundMaterial` 与 `vibrancy` 都作用在窗口上，不是某个 view 的，所以它在每个透明的地方都透出来——rail 与顶栏底下也一样，不是只有页面周围的 gutter。
