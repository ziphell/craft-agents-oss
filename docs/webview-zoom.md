# WebView 缩放（CSS zoom）与它带来的约束

安卓壳（`apps/android`）的「网页缩放」把 `html { zoom: z }` 写到页面上，`z ∈ {0.75, 0.8, 0.85, 0.9, 0.95, 1}`
（`WebViewActivity.applyZoom()`，页面加载完成与 `onResume` 时各应用一次）。桌面端不缩放，`z = 1`，本文件的所有换算退化为恒等。

任何**指针交互**或**依赖视口尺寸的布局**都要按这里的两套坐标系来写，否则在手机缩小到 75% 时会错位 —— 这类 bug 只在
App 的安卓端出现，浏览器里复现不了。

## 两套坐标系

| 量 | 属于哪套 | 说明 |
|---|---|---|
| `event.clientX / clientY` | **视口 px** | 指针坐标；与滚动位置无关 |
| `window.innerWidth / innerHeight` | **视口 px** | |
| `visualViewport.*`（含 `scale`） | **视口 px** | 捏合缩放是另一回事，不要和 `zoom` 混用 |
| 媒体查询 `matchMedia` | **视口 px** | 所以 CSS zoom **改变不了断点** |
| `getBoundingClientRect()` | **子树 px** | 被 zoom 的子树里 1 子树 px = `z` 个视口 px |
| `offsetWidth/Height`、`getComputedStyle()` 的长度 | **子树 px** | |
| `scrollLeft/Top`、`getBoundingClientRect()` 派生的宽高 | **子树 px** | |

换算关系：

```
子树 px = 视口 px / z            （viewportPxToOwnPx）
视口 px = 子树 px × z            （boxInViewportPx）
```

## 规则

### 1. 事件的坐标不要直接和 rect 相减

```ts
// ✗ 0.75 缩放下，点在图中央会被算成 37.5%
const ratio = (event.clientX - box.left) / box.width

// ✓ 比例：先换算成一个坐标系
const ratio = (event.clientX - boxInViewportPx(canvas).left) / boxInViewportPx(canvas).width

// ✓ 位移：把视口 px 的增量换回子树 px，再和 rect 派生的量相加
const delta = viewportPxToOwnPx(event.clientX - startX)
```

两个助手都在 `apps/electron/src/renderer/lib/input-viewport.ts`，`z = 1` 时是恒等函数，桌面端零成本。

已经按此处理的位置（改动前都踩过）：`browser/BrowserStreamViewer`、`canvas/SessionCanvasWorkspace`、
`canvas/CanvasMinimap`、`canvas/CanvasLightbox`、`edit/EditSurface`、`app-shell/AppShell`、`app-shell/PanelResizeSash`。

### 2. 满屏高度用 `#root`，不要用 `100vh` / `h-screen`

`100vh` / `100dvh` 按**视觉视口**解析，随后又被 zoom 缩一次 —— 0.75 时只剩下窗口的 75% 高，内容看起来偏上。
`apps/webui/src/viewport.ts` 已经把 `#root` 的宽高按 zoom 补偿过（`--webui-viewport-width/height`），所以：

```tsx
// ✗ 0.75 下只填 3/4 屏
<div className="h-screen …" />
// ✓ 跟随已补偿的容器
<div className="h-full …" />
```

### 3. 壳必须继续用 CSS `zoom`，不要改成页面缩放（改写 viewport meta）

`viewport.ts` / `getRootCssZoom()` 读的是 `getComputedStyle(html).zoom` 并据此反推尺寸。
换成「改写 meta 的 `initial-scale`」后页面上没有 CSS zoom，而 **Chromium < 128 在未设置 zoom 时该属性返回
devicePixelRatio**（实测 2.75），WebUI 会把视口宽 1203 ÷ 2.75 = 437 当成页面宽度，`#root` 被压成 437×302。
（Open WebUI 那边没有这个契约，所以它的壳可以用 meta 方案 —— 两个壳在这点上**故意不同**。）

### 4. 前端特性要能跑在我们最老的内核上

MIUI 等 ROM 会把系统 WebView 钉在 **116**（实测机上 Chrome 已是 157）。以下写法在 116 上失效，需要
`@supports` 兜底或就别用：

| 特性 | 最低内核 | 失效后果 |
|---|---|---|
| 相对颜色语法 `oklch(from X l c h / a)` | 119 | 变量无效 → `border-color` 退回 `currentColor`，出现黑/白细线 |
| `subgrid` | 117 | 网格塌成普通 grid |
| `@starting-style` | 117 | 入场动画不播 |
| `text-wrap: pretty` | 117 | 退化为 `wrap` |
| `light-dark()` | 123 | 颜色无效 |
| `field-sizing: content` | 123 | 输入框不自动长高 |
| anchor positioning | 125 | 弹出层定位错 |

兜底写法见 `apps/electron/src/renderer/index.css` 末尾的 `@supports not (color: oklch(from …))` 块：
现代声明保持不动，用一层兜底把同样的颜色用 `color-mix()`（111+）再说一遍。

## 验收清单

改到上面任一处代码后，在手机上把「显示设置 → 网页缩放」调到 **75%** 再验：

- [ ] 点按/拖拽落点与眼睛看到的一致（尤其是容器右侧与下侧边缘）
- [ ] 满屏面板/loading 铺满，不出现底部黑带
- [ ] 分隔线、输入框边框是淡灰半透明，不是纯黑/纯白
- [ ] 旋转屏幕或开关软键盘后仍然成立（`viewport.ts` 会重算一次）
