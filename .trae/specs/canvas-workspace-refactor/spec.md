# Craft Agents 画布整体重构 — Product Requirements Document

## Overview
- **Summary**: 将 `CanvasWorkspace.tsx`（5789 行、40+ useState）拆分为职责单一的模块层，并修复交互层已识别的坐标/缩放/连线/composer 跟随等 P0/P1 问题。
- **Purpose**: 解决单文件超大组件带来的性能黑洞、状态散列、交互不一致问题；对齐 Toonflow / BeefTV 的工业级画布范式。
- **Target Users**: 画布编辑器开发者、最终用户（Electron 桌面 app）。

## Goals
- 消除 `toCanvasPoint` 中 `getComputedStyle + DOMMatrixReadOnly` 的每帧重排重绘开销。
- 让 composer 跟随拖拽中的节点（gap 期间不留在原地）。
- 为连线拖拽增加候选输入占位（target 高亮、终点吸附）。
- 选中节点自动打开 composer（对齐 Toonflow `bottomVisible = node.selected`）。
- 连线渲染改用 `vector-effect="non-scaling-stroke"` 并按路径 memo 化。
- 将散列的 surface 状态（composerId / textEditorId / previewId）统一为可互斥管理的单轴状态。
- 保持所有现存用户可见行为等价（除明确列在 Non-Goals 的）。

## Non-Goals
- 不替换底层画布框架（继续使用手写 `translate + scale` 的 world layer）。
- 不替换 TipTap 编辑器或 `TiptapMarkdownEditor` 组件。
- 不改变 `CanvasNode` / `CanvasEdge` / `CanvasDoc` 持久化数据模型。
- 不引入 `@xyflow/react` 或 `@vue-flow/core` 等第三方画布库。
- 不实现 BeefTV 的 Leafer 图形层或 `subscribeCanvasViewportPreview` 事件总线（超出本仓库复杂度）。
- 不实现 BeefTV 的节点 3D tilting 或 comet 动画（纯视觉增强）。

## Background & Context
- **当前实现**: `CanvasWorkspace.tsx` 集 doc 加载、viewport 控制、gesture 状态机、composer、text editor modal、context menu、lightbox、minimap、文件拖放、节点渲染、连线渲染、键盘事件于一体，所有状态散落在 40+ useState 里。
- **已识别 P0 问题**:
  1. `toCanvasPoint` 每次调用 `getComputedStyle + DOMMatrixReadOnly`，连线拖拽每帧强制重排重绘。
  2. composer 位置只在 React render 时重算，拖拽中 composer 留在原地。
  3. 连线拖拽无候选输入占位反馈（无 target 高亮、无终点吸附）。
- **已识别 P1 问题**:
  4. 选中节点不自动打开 composer（需额外 click）。
  5. Edges strokeWidth 手动 `/viewport.scale`，未用 `vector-effect="non-scaling-stroke"`。
  6. Edges 无 memo，每次 render 重算 path d。
  7. composer 在 board 底部时不会 flip-up fallback。
  8. composerId / textEditorId / previewId 三态互斥逻辑散列，可能出现双面板。
- **竞品参考**:
  - BeefTV 用 `viewportRef` + `canvas-live-viewport.ts` 做 DOM 层零开销坐标换算，用 `subscribeCanvasGraphicsViewportPreview` 驱动浮层实时跟随，用 `CanvasNodePanelOverlay` + `dragPreview` 做 composer 跟随。
  - Toonflow 用 vueFlow 内置 handle snap + `bottomVisible = node.selected` 实现选中即显示 prompt panel。

## Functional Requirements

### FR-1: 统一坐标换算
- 必须通过 `viewportRef`（镜像 viewport state）直接做数学换算，不再查询 DOM。
- 提供纯函数 `screenToWorld(clientX, clientY, boardRect)` 和 `worldToScreen(x, y)`，所有事件入口复用。

### FR-2: 统一 surface 管理
- 新增单一状态 `surface: { kind: 'composer' | 'textEditor' | 'preview', nodeId: string } | null`。
- 打开任一 surface 时，另外两个自动关闭。入口（click 节点、Enter、双击、右键菜单、agent 异步写）全部走统一 open helper。

### FR-3: 选中即 composer
- 当选中单个节点且 `opensComposer(node)` 为 true 时，自动打开 composer（text/image/video/audio generator 均可）。
- 多选时不自动打开，由用户手动触发。

### FR-4: composer 跟随
- 拖拽打开了 composer 的节点时，composer 在 gap 期间平滑跟随（简单方案：drag start 关闭 composer，drag end 重开；理想方案：每帧用 `gestureRef.current.dx/dy` 重算位置）。

### FR-5: 连线候选输入占位
- 拖拽连线（`link !== null`）期间，AABB hit test 当前鼠标位置 → 找到 target node → 存 `linkTargetId`。
- 活跃连线路径终点吸附到 target node 的左侧中点（source→target 方向）。
- 被 hit 的 target node 显示候选输入占位视觉（border 变蓝 + 轻微 scale 脉冲，pointerdown 后清除）。

### FR-6: 连线渲染性能
- 所有 SVG path 改用 `vector-effect="non-scaling-stroke"`，移除手动 `/viewport.scale` 的 strokeWidth 计算。
- 每条 edge path 用 React memo 组件（`CanvasEdge`）包裹，依赖只有 `edge + fromBox + toBox + active + related`。

### FR-7: composer 定位
- 默认在节点下方（`top = nodeBottom * scale + viewport.y + 10`）。
- 当 `boardH - top < 320` 时，flip-up 到节点上方（`top = nodeTop * scale + viewport.y - height - 10`）。
- 宽度 clamp：`left = clamp(screenX - width/2, 12, boardW - width - 12)`。

### FR-8: gesture 状态机清晰化
- pointerdown → 根据 target 决定进入 drag / resize / pan / marquee / select。
- pointermove → 仅按当前 mode 更新，禁止 click 与 drag 事件抢占。
- pointerup → 统一退出 + 一次性提交历史。

## Non-Functional Requirements
- **NFR-1**: TypeScript 类型零退化（`bun run typecheck` 通过）。
- **NFR-2**: 现有单元测试 `bun test src/renderer/lib` 全部通过。
- **NFR-3**: 重构后 `CanvasWorkspace.tsx` 行数 ≤ 3000（从 5789 减到 ≤ 55%）。
- **NFR-4**: `toCanvasPoint` 无 DOM 查询（`getComputedStyle` / `DOMMatrixReadOnly` / `getBoundingClientRect` 只在 wheel handler 和 node render 初始化时出现，连线拖拽的 pointermove 内零 DOM 查询）。
- **NFR-5**: Edges 重绘帧率在 20 节点 + 10 连线时 ≥ 60fps（主观体感，不做自动化 benchmark）。

## Constraints
- **Technical**: 保持 `packages/shared` 下的 `CanvasNode` / `CanvasEdge` / `CanvasDoc` 类型不变（session 已沉淀的持久化协议）。
- **Technical**: Electron 主进程 RPC 接口不变（session 已沉淀的 agent 协议）。
- **Technical**: i18n locale 不新增或删除 key（除非修复之前的遗留）。
- **Dependencies**: 不引入新 npm 包。
- **Business**: 所有现存快捷键（Space=pan, Meta+Z/Y=undo/redo, Delete=删除, Enter=打开编辑器, Meta+1=zoom100%, Meta+0=fit）必须保留。

## Assumptions
- 画布当前实现不依赖 DPR 补偿（devicePixelRatio ≈ 1），暂不引入。
- 用户在本次 session 中确认过"composer 永远在节点下方，toolbar 在节点上方"，但本次重构为了修 bug 加入 flip-up fallback 时，用户应能接受"底部不够时翻上"的改善。
- `viewport.scale` 范围 0.05 - 4 保持不变。

## Acceptance Criteria

### AC-1: 坐标换算零 DOM 查询
- **Type**: `rule`
- **Given**: 画布已打开，viewport 处于任意缩放和平移状态
- **When**: 用户从节点 handle 开始拖拽连线并持续移动鼠标
- **Then**: pointermove 事件处理内不触发 `getComputedStyle` 或 `DOMMatrixReadOnly`（可用 Chrome Performance 面板验证：每帧的 Recalculate Style 为 0）
- **Pass Condition**: `toCanvasPoint` 函数内无 DOM 查询，仅使用 ref.current 值做数学换算
- **Evidence**: 源码审查 + Performance 面板录制

### AC-2: composer 拖拽不原地停留
- **Type**: `rule`
- **Given**: 已打开 composer 的 text 节点（composerId === node.id）
- **When**: 用户开始拖拽该节点
- **Then**: composer 在拖拽开始时自动关闭，拖拽结束后恢复拖拽前的选中态（可选：自动重新打开 composer）
- **Pass Condition**: 拖拽过程中 composer 不挂在旧位置
- **Evidence**: 手动操作录屏

### AC-3: 连线候选输入占位
- **Type**: `rule`
- **Given**: 画布上有至少两个节点 A 和 B
- **When**: 用户从 A 的右侧 handle 拖拽连线经过 B 节点
- **Then**: B 节点视觉上高亮（border 颜色变化），活跃连线路径终点吸附到 B 的左侧中点
- **Pass Condition**: pointer 在 B 上方但不松手时，连线终点跟随 B 的左侧中点移动
- **Evidence**: 手动操作录屏

### AC-4: 选中即 composer
- **Type**: `rule`
- **Given**: 画布上有 generator 角色的 image/video/text/audio 节点
- **When**: 用户单击该节点（无其他节点选中）
- **Then**: composer 自动打开在节点下方
- **Pass Condition**: 单击选中 = composer 打开（一个动作完成两个事）
- **Evidence**: 手动操作录屏

### AC-5: surface 统一管理
- **Type**: `rule`
- **Given**: surface 系统已实现
- **When**: 打开任一 surface（composer / textEditor / preview）
- **Then**: 其余两个 surface 一定为 null；打开同一 surface 同一 node 时不重复触发 render
- **Pass Condition**: 源码审查 surface state 只有一处定义，所有入口走同一个 open helper
- **Evidence**: 源码审查

### AC-6: Edges 使用 vector-effect
- **Type**: `rule`
- **Given**: SVG 连线渲染
- **When**: viewport scale 在 0.05 - 4 范围内任意值
- **Then**: 连线 strokeWidth 在屏幕上保持常量（1.5/2.8），不随缩放变化且无闪烁
- **Pass Condition**: 所有 `<path>` 有 `vector-effect="non-scaling-stroke"` attribute
- **Evidence**: 源码审查 + 手动缩放观察

### AC-7: composer flip-up fallback
- **Type**: `rule`
- **Given**: 节点位于 board 底部（nodeBottom + 10 + 320 > boardH）
- **When**: 打开 composer
- **Then**: composer 自动翻到节点上方，不被 board 底部截断
- **Pass Condition**: board 底部 composer 完整可见
- **Evidence**: 手动操作录屏

### AC-8: TypeScript 和测试通过
- **Type**: `rule`
- **Given**: 重构完成
- **When**: 运行 `bun run typecheck` 和 `bun test src/renderer/lib`
- **Then**: 零错误，所有 143 条现有测试通过
- **Pass Condition**: 命令退出码为 0
- **Evidence**: 终端输出

### AC-9: CanvasWorkspace.tsx 行数 ≤ 3000
- **Type**: `rubric`
- **Dimension**: 文件大小控制（职责分离度）
- **Scale**: 1-5
- **Anchors**: 1 = 无拆分仍 ≥ 5700 行；3 = 拆到 4000-4500 行；5 = 拆到 ≤ 3000 行且各新文件职责清晰
- **Pass Threshold**: ≥ 4
- **Evidence**: `(Get-Content CanvasWorkspace.tsx).Count` + `lib/` 下新文件清单

### AC-10: 交互体感流畅度
- **Type**: `rubric`
- **Dimension**: 主观流畅度（0-2s 延迟感知）
- **Scale**: 1-5
- **Anchors**: 1 = 拖拽/连线有明显卡顿或掉帧；3 = 可接受但偶有微抖；5 = 平滑无感知延迟，与 BeefTV/Toonflow 体验对标
- **Pass Threshold**: ≥ 4
- **Evidence**: 手动操作 + Performance 面板录制（pointermove 每帧耗时 < 16ms）

## Open Questions
- [ ] **文本节点选中即 composer 的边界**: 已生成 text 节点（有正文）选中时，composer 里放什么？—— 当前行为是生成面板（prompt + reference），full editor 通过 Enter 或双击打开。保持不变。
- [ ] **audio 节点的 opensComposer 判定**: 有 src 但无 recipe 的 audio 节点是否允许 composer？—— 本轮重构中暂不改变现有行为，留作后续增量。
