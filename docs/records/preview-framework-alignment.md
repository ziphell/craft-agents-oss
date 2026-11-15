# 预览框架：按 MiniMax / OpenReel 的节点逐个复刻

> **状态：已实现。** 四个节点均已落地：`preview/master-clock.ts`、`audio-graph.ts`、`frame-source.ts`、`stage.tsx`；`canvas-compositor.ts` 已抽出并被预览与导出共用。本文是实施记录，不是待办计划。


## Context

先回答「现状是出于什么计划设计的」：**不是**照 OpenReel/MiniMax 的预览节点设计的。

- 文档模型、时间线语义、转场/字幕/音频效果、剪映草稿与 FCPXML 导出，是按 OpenReel 源码和 MiniMax `app.asar` 逆向对齐的。
- **预览运行时是自拟的**，出于最小改动逐步长出来：先要一个能 seek 的播放器 → 用可见 `<video>` + 隐藏 `<audio>` + RAF 播放头；后来要 EQ/压缩 → 在元素输出上插一条 WebAudio 滤波链。它从来没有按对方的引擎结构设计过。

这不是「对齐」，所以计划被驳回是对的。已验证 MiniMax 包内确实带着 OpenReel 的预览节点（`app.asar` 字符串计数）：`MasterTimelineClock`(3)、`RealtimeAudioGraph`(9)、`scheduleAheadTime`(4)、`trackNodes`(26)、`scheduleVolumeAutomationOnGain`(3)、`drawFrameWithTransform`(10)、`drawFrame`(44)、`OffscreenCanvas`(376)、`createBufferSource`(55)。

因此下面的计划不再是我自拟的分阶段重构，而是**按对方四个运行时节点 1:1 移植**，每个节点落地后才算完成。

## 对方节点 → 我们的对应物

| OpenReel / MiniMax 节点 | 职责（已核对源码） | 我们要新建的 |
|---|---|---|
| `MasterTimelineClock`（`packages/core/src/playback/master-timeline-clock.ts:42-208`） | 以 `AudioContext.currentTime` 为主时钟；play/pause/seek；RAF 通知订阅者 | `preview/master-clock.ts` |
| `RealtimeAudioGraph`（`audio/realtime-audio-graph.ts`） | 解码缓存 → `AudioBufferSourceNode`；提前 0.2s 排、每 100ms 补排；seek 停源重排；每轨 input→EQ/压缩/…→pan→gain→master；片段 gain 包络（音量/自动化/淡入淡出）+ 速度 | `preview/audio-graph.ts` |
| 预览 canvas（`apps/web/.../Preview.tsx:7713`，`drawFrameWithTransform`；`video-engine.ts:468-554` 隐藏 `<video>` 帧源） | 唯一显示层是 canvas；隐藏 `<video>` 只作帧源；每帧读主时钟 → `drawImage`；转场/文字/PiP 都在 canvas 上 | `preview/{frame-source.ts,stage.tsx}` |
| 共用绘制（`canvas-renderers.ts`、导出页同款） | 变换、圆角、转场、文字、叠加层 | `packages/shared/src/reel/canvas-compositor.ts`（从 `edit-export-page.ts` 抽出） |

## 实施顺序（按节点，不跳步）

### 1. `MasterTimelineClock`
- 新建 `preview/master-clock.ts`：持有唯一 `AudioContext`；`time` 取自 `currentTime - startedAt + offset`；`play/pause/seek`；`subscribe(fn)`。
- `EditSurface` 的 `playhead`/`playing` 改为订阅时钟，删除 RAF 累加时间的逻辑。
- 完成标志：暂停/播放/拖动时 UI 时间只来自时钟；无第二个时间源。

### 2. `RealtimeAudioGraph`（先删 `<audio>`）
- 新建 `preview/audio-graph.ts`：源解码缓存（`fetch(mediaUrl) → decodeAudioData`）、片段调度（`AudioBufferSourceNode` + `playbackRate=clipSpeed` + `clipSourceTime` 偏移）、0.2s 预排/100ms 补排、seek/pause 停源重排、每片段 gain（`clipGainAt`）+ `createAudioEffectChain`、每轨 mute/solo → master。
- 删除 `EditSurface` 中 `<audio>`、`audioRefs`、`createMediaElementSource`/`applyAudioTone`、媒体元素 volume/playbackRate、`sounding`/`soundingKey`。
- 完成标志：预览 DOM 无 `<audio>`；播放/暂停/拖动/改音量/改音色/改倍速与导出听感一致。

### 3. 预览 canvas + 隐藏帧源
- 先抽 `canvas-compositor.ts`（从导出页原样迁移 `drawPicture/drawTextOverlay/transitionFrameAt/drawClipFrame/主循环`），导出改为调用它，输出不变。
- 新建 `preview/frame-source.ts`（隐藏 `<video>`/`<img>` 池，seek 到 `clipSourceTime`）与 `preview/stage.tsx`（composition 尺寸 canvas，RAF 读时钟 → 合成器绘制）。
- 删除可见 `<video>`、`FrozenPicture` 分层、CSS 转场、DOM 字幕/花字/PiP 渲染；字幕/PiP 在 canvas 上画，选择先做矩形命中 + 检查器联动（不做 DOM 拖框）。
- 完成标志：同一时刻暂停，预览 canvas 与导出帧像素级一致（允许编码级差异）。

### 4. 清理与文档
- 删除遗留 refs/effects、`playerScale` 的 DOM 缩放逻辑；`media-url.ts`/`audio-effects-web.ts`/`edit-export-page.ts` 与导出页注释改为事实。
- 不新增功能。倒放/定格/音高校正/变速曲线仍不做（缺时间伸缩）。

## 关键文件

- 新增：`packages/shared/src/reel/canvas-compositor.ts`；`apps/electron/src/renderer/components/edit/preview/{master-clock.ts,audio-graph.ts,frame-source.ts,stage.tsx}`
- 改造：[EditSurface.tsx](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/renderer/components/edit/EditSurface.tsx)、[edit-export-page.ts](file:///c:/Users/Ryan/code/craft-agents-oss/apps/electron/src/main/edit-export-page.ts)
- 复用：`packages/shared/src/reel/{document,overlay,effects,audio-effects-web}.ts`、`apps/electron/src/renderer/lib/media-url.ts`

## 验证

1. 节点 1：暂停/播放/拖动，时间仅由时钟推进；连续 seek 10 次无漂移。
2. 节点 2：预览 DOM 无 `<audio>`；播放→暂停→拖动无残留声；音量/静音/淡入淡出/音色/倍速/轨道独奏即时正确。
3. 节点 3：同一时刻预览与导出抽 3 帧像素 diff；转场、字幕、花字、PiP、调色、倍速各走一遍。
4. 全量：`bun test packages/shared/src/reel packages/session-tools-core/src/handlers/__tests__/reel.test.ts`；`typecheck:shared`、session-tools、electron；`bun scripts/electron-build-export-page.ts`、主进程与渲染进程构建。

## 风险与边界

- seek 首次解码延迟：缓存 + 先画帧后出声。
- 每源整段解码的内存：先按源缓存，LRU 留待需要时。
- canvas 预览下字幕/PiP 失去 DOM 拖拽：先矩形命中，拖框交互后补（唯一体验回退，需接受）。
- 性能：1080p canvas 逐帧与导出同代价。
