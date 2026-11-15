# 画布视频剪辑 / 合成：BeefTV、Toonflow、MiniMax Design 的可移植性

> **2026-11-07 状态更新**：本文是可移植性评估，不是最终方案。craft 已决定**自研时间线**：
> 剪辑是项目里的 `reels/<slug>.reel`（`@craft-agent/shared/reel/document`），由 `EditSurface`
> 读写、`reel_tool` 供 agent 修改；随包的 OpenReel 制品（`resources/openreel`、iframe 宿主、
> `/openreel/` 路由）已移除。下面关于 OpenReel 的建议仅作背景阅读。

> 评估日期 2026-11-06，**第二版（修正第一版把 MiniMax 判成「自己不渲染」的错误）**。
> 本机副本：`~/code/BeefTV`、`~/code/Toonflow-app`、`%LOCALAPPDATA%\Programs\MiniMax Design`（Electron，已解包到 `/c/tmp/mmd-asar`）。

---

## 0. 结论

| | 它是什么 | 能不能拿 | 对 craft 的价值 |
|---|---|---|---|
| **MiniMax Design** | 画布（hilo canvas-v3）+ **完整 Web 剪辑器**（多轨/转场/效果/蒙版/关键帧/字幕/多机位）+ **渲染进程内用 WebCodecs 自渲成片** | 协议可照抄；**编辑器本体来自 OpenReel Video（MIT）**，可直接用 | ★★★ 这就是 craft 要的形态 |
| **BeefTV** | 画布 + 装配式时间轴 + **服务端 Go ffmpeg** 渲染，agent 可用 op 改时间轴 | 设计可学，代码不可搬（Source Available） | ★★ 长片/批量/无 GPU 的服务端兜底 |
| **Toonflow** | 节点图（无时间轴）+ **MIT 的 ffmpeg 运行层** + 三维舞台录制 | ffmpeg 层可直接搬（932 行 MIT） | ★★ 「一次性媒体变换」的底座 |

三句话：

1. **MiniMax 的剪辑器可以移植，而且不用求人**——它随包带了一份 `LICENSE.openreel.txt`（MIT，Copyright 2024–2026 Augustus Otu），功能集与 **OpenReel Video**（GitHub 5.6k★，MIT，浏览器版 CapCut）一一对应。也就是说：craft 可以直接用 OpenReel 的开源本体，不必逆向那 2.9 MB minified bundle。
2. **成片不需要 ffmpeg**。MiniMax 的导出走 `VideoEncoder`/`AudioEncoder` + MediaBunny 封装，带 GPU 探测、码率估算、OffscreenCanvas 基准测试，`h264/h265/vp9/av1` 分级——它甚至会用「渲染 40% / 编码 55% / 封装 5%」给用户报时间。craft 现在那条 `MediaRecorder` 路线（无音频、要事后改 `mvhd`）不该继续当主力。
3. **BeefTV 的架构价值仍在，但降级为「服务端兜底」**：长片、批量、无 GPU 机器、需要 libass/ProRes 的边角。

---

## 1. 先纠正：MiniMax 确实有剪辑，而且自己出片

第一版只看到 `clip-studio-export/python/export-to-jianying.py`，就判成「导出草稿、成片交给剪映」。错在只看了导出目录，没看编辑器本体。

事实（均可在解包产物里复核）：

| 事实 | 证据 |
|---|---|
| 剪辑器是应用内一个全屏编辑器，可从画布进入并返回 | `tb.app_title = Video Editor`、`tb.back_to_canvas`、`tb.exit_editing`、`tb.export`、`tb.export_recovery_hint`（导出中断可续） |
| 它自己渲染成片 | `EditorInterface-*.js` 里 `VideoEncoder` 7 次、`disable` 无 `MediaRecorder`；`index-CB46_c12.js`（432 KB）是导出管线：`VideoEncoder` 14 / `AudioEncoder` 12 / `muxer` 205 / `AAC` 7；`detectGpu()` 读 `WEBGL_debug_renderer_info`，`estimateExportTime()` 分 rendering/encoding/muxing，`OffscreenCanvas` 跑 60 帧基准 |
| agent 的导出要求「应用保持打开」 | `project.export` 描述：*Keep the app open while rendering; on unknown/TIMEOUT use command.get with the original commandId* |
| 剪辑器是 OpenReel 的派生 | `clip-studio-export/LICENSE.openreel.txt` = MIT "Copyright (c) 2024-2026 Augustus Otu and Contributors"；功能集（多机位、track matte、节拍对齐、模板云端/本地、自动字幕+翻译、自动重构图、高光、抠像、对话清理）与 OpenReel README 对应 |
| 剪映草稿只是**额外**出口 | 导出菜单有 `jianying / srt / fcpxml` 三项（手动），另有应用内 `project.export`（mp4/wav） |

**结论：MiniMax 的剪辑 = OpenReel（MIT 内核）+ 自己的画布资源模型 + 自己的 agent 协议。**

---

## 2. OpenReel Video：可以直接用的那一半

`github.com/Augani/openreel-video`，MIT，5.6k★，React + TS + Zustand + **MediaBunny + WebCodecs + WebGPU + Web Audio + Three.js**。

```
apps/web       浏览器编辑器 / 桌面共用界面
apps/desktop   桌面壳（原生导出，支持 ProRes/alpha）
packages/core  时间轴、媒体、音频、渲染、导出引擎
packages/ui    界面组件
packages/agent AI 编辑工具与路由
```

对我们最要紧的三个事实：

1. **`packages/core` 已经是我们要写的那套东西**：`actions/`（ActionExecutor + ActionHistory）、`capabilities/manifest`（能力词表，含 `TRANSITION_TYPES`/`VIDEO_FILTER_TYPES`/`AUDIO_EFFECT_TYPES`/`SPEED_CURVE_PRESETS`/`TEXT_ANIMATION_PRESETS`/motion 的 mask、track matte、粒子、表达式、3D 光照…）、`wasm/`（FFT、WAV、**节拍检测**，AssemblyScript）、`video/speed-engine`、`graphics/shapes`。
2. **它本来就有「无头」这一层**：`packages/agent/src/headless-host.ts` —— *"A pure-Node EditingHost. Wraps the core ActionExecutor over an in-memory project so an agent can edit headlessly (cloud / CLI / tests). Rendering and GPU/export jobs are delegated to an injected JobRunner."* 带 `beginTransaction` / 快照回滚。**这正好是 craft `server-core` 里该放的东西**：agent 的一次编辑 = 一个事务，回滚是整体快照，不靠逆操作。
3. **导出靠 MediaBunny（`^1.25.3`，MPL-2.0）+ WebCodecs**，桌面版另有原生 FFmpeg 导出（`@ffmpeg/core 0.12.6` 也随 core 依赖，即 wasm 兜底也在）。

依赖代价（`@openreel/core` 的 dependencies）：`mediabunny`、`@ffmpeg/{ffmpeg,core,core-mt,util}`、`@mediapipe/tasks-vision`（抠像/手部）、`onnxruntime-web`（本地模型）、`three`、`gsap`、`idb-keyval`、`polygon-clipping`、`yaml`。**重**——按需拆包，不要整包进 renderer。

---

## 3. MiniMax 的 agent 协议：12 个方法（照抄这个形状）

内建能力 ID 是 `clip-studio`（`contractVersion: "3"`），通过 `design_execute` 的 `plugin` 字段调用：

```jsonc
{ "capabilityId": "clip-studio",
  "plugin": { "method": "project.edit",
              "contractVersion": "3",
              "target": { "canvasId" | "compositionId" | "nodeId" | "sourceResourceId": "…" },
              "args": { … },
              "baseVersionId": "…",          // 写前提：最新 project.get / 写回执的版本
              "expectedDraftRevision": 7 } } // 写前提：草稿修订号
}
```

| 组 | 方法 | 说明 |
|---|---|---|
| lifecycle | `document.list` | 列出画布上的剪辑项目（不打开编辑器）；返回 `nodeId / sourceResourceId / compositionId / versionId / draftRevision / empty / sources[]` |
| | `document.create` | 建一个**内部 Composition + `.clip` source + 绑定节点**；`sourceNodeIds`（≤20）把画布上的媒体节点接成输入 |
| | `editor.prepare` / `editor.reveal` | 打开全屏剪辑器并等就绪（其他 renderer 方法会自动 prepare） |
| | `command.get` | **幂等恢复**：按原 `commandId` 查 running/unknown/completed/committed/rejected，绝不用重发写来「确认」 |
| inspect | `project.get` | 读时间轴（写前提就来自这里） |
| | `project.diagnostics` | 只读体检。error：`timeline_gap` / `clip_overlap` / `media_missing`；warning：`caption_overlap` / `caption_out_of_video` / `tiny_clip` / `empty_track` |
| edit | `project.edit` | **一次批量、一个 undo 步**；`{description, operations[1..50], validateOnly}`；首错回滚；逐条返回 `results[]`；`nonUndoable[]` 单独报告 |
| | `project.history` | undo/redo（1–20 步）；一个 batch = 一步；历史在内存里 |
| preview | `project.view` | seek/play/pause（play 可带 `fromSec/toSec` 循环那段） |
| | `project.snapshot` | 渲 1–4 帧合成画面（含效果/转场/调色/字幕），`maxDim≤1024`，**是一次性证据，不落资产**，渲完恢复用户视图 |
| export | `project.export` | 保存并固定当前版本 → 用编辑器导出管线渲染 → **落成一个独立 Composition 放在 clip 节点旁边**，保留对源版本的精确依赖；`format: mp4|wav`；中断用 `command.get` 恢复同一次交付 |

### 3.1 `project.edit` 的操作词表（30 条，直接当规格用）

`set_project_settings {width,height,frameRate}`（16–8192px、1–120fps）· `set_transform {clipIds|trackId, unit: normalized|px, position|offset, scale, rotation, opacity, fitMode, crop}` · `set_audio_fade {clipId, fadeInSec, fadeOutSec}` · `set_clip_range {clipId, sourceInSec, sourceOutSec, durationSec}` · `split_clip {clipId, atSec}` · `trim_clip {clipId, newStartSec, newEndSec}` · `remove_clip {clipId, ripple}` · `remove_range {fromSec, toSec, trackIds, ripple}` · `move_clip {clipId, toSec, trackId}` · `add_clip {mediaId, trackId, atSec, sourceInSec, sourceOutSec, durationSec}` · `import_media {resourceId, versionId, kind, addToTimeline, trackId, atSec}` · `duplicate_clip` · `close_gap` · `add_track {kind: video|audio|text}` · `set_track {trackId, muted, hidden, locked, solo, name}` · `remove_track` · `add_text {text, atSec, durationSec, trackId}` · `set_text` · `remove_text_clip` · **`cut_silences {clipId, thresholdDb, minSilenceSec, padSec}`**（默认 −40 dB / 0.5 s / 0.1 s，自动剪掉静音段） · **`import_srt {srtResourceId|srt, clipId, offsetSec, trackId, clipToRange, preset}`**（转写得到的是**源时间**，传 `clipId` 重定位到该片段） · `set_subtitle_style {preset: default|minimal|bold|centered|modern|elegant|casual, fontFamily, fontSizePx, color, backgroundColor, position}` · `set_clip {clipId, volume 0-2}` · `set_speed {clipId, speed 0.1-20, reverse, affectAudio}`（不改邻接） · `add_transition {clipAId, clipBId, kind: crossfade|dipToBlack|dipToWhite|wipe|slide|zoom|push, durationSec}` · `remove_transition` · `add_effect {clipId, effect, params}`（brightness/contrast/saturation/hue/blur/sharpen/vignette/grain/temperature/tint/tonal/chromaKey/shadow/glow/motion-blur/radial-blur/chromatic-aberration） · `remove_effect` · `set_color_grading {clipId, temperature, tint, reset}` · `add_marker` / `remove_marker`

明确「撤销不回来」的：字幕样式/删除、调色、标记、`set_speed`、`import_media`。

### 3.2 另外两层（很值得抄的产品判断）

- **媒体级能力**（不碰时间轴，直接产出新版本）：
  `edit_media:ffmpeg` —— 一条产出型 ffmpeg 命令：trim / crop / scale / overlay / 替换或混音 / 抽帧抽音频 / **烧字幕** / 转码；默认 `-c:v libx264 -crf 18`，输出容器由 `-c:a` 反推（aac→m4a、pcm→wav、flac/opus/vorbis/mp3）。
  `edit_media:merge_videos` —— 2–100 段首尾相接，`scaleMode: first|max|min|custom`；**这是产生拼接视频的唯一入口**，ffmpeg 那条明确禁止 concat。
  → 这是 BeefTV `editing` 包的等价物，但表达成「能力 + 输出即资源版本」，不是「工程文档」。
- **剪辑知识当域提示词注入**（`CLIP_EDITING_KNOWLEDGE`）：钩子在前 3 秒、镜头长度交替、旁白段别超过 ~7 秒没有切/推近/字幕……并且建议**整段委托**：`hub_plugin_agent_open_editor` 把「完整剪辑需求」交给一个编辑器会话，主 agent 不逐步点。

### 3.3 导演台（`3d-director-stage`）是同一协议的另一个编辑器

`manifest.json` 里 `agent.editorSurface: true` + 10 个方法：`scene.get`（返回 `codeModels/characters/props/models/cameras/camPaths/**timeline**/customMotions/…`，timeline 片段是 `id/ref/start/duration/enabled`，单位毫秒）、`scene.edit`（原子批量、**一个 undo 步**）、`scene.history`、`scene.snapshot`（浏览器真实渲染的 JPEG，供视觉复核）、`scene.diagnostics`、`model.generate`（Three.js 程序化模型，`createModel(ctx)`，返回 `THREE.Group`）、`model.capture`、`model.compare`（调随包 Python 跑确定性图像比较）、`motion.read`（语义关节 DSL）、`campath.read`（运镜 DSL）。

也就是：**「3D 舞台 + 运镜/走位 + 时间轴 + 快照当证据」也是一个 editorSurface，用同一套 `method/contractVersion/target/args/expectedDraftRevision/baseVersionId` 驱动。** 这套抽象比 BeefTV 的「一个 canvas.timeline.update 换整份时间轴」更耐扩展。

---

## 4. BeefTV：仍然值得学的是那两三条纪律

（第一版的技术细节仍然成立，这里只留结论 + 修正）

- 数据模型 `TimelineProject v2`：`tracks[]`（video/audio/subtitle/text/image） + `clips[]`（`nodeId` 指回画布节点，或 `directMedia` 直连素材） + `output{width,height,fps,burnSubtitles}`；服务端校验「可见 video/image 不可重叠」。
- 渲染：`compile` 出**语义 Plan**（选哪些、顺序、间隙、裁剪、静音、增益、淡入淡出、字幕、输出规格），再由 **两条 lowering** 变成命令（Go 原生 `filter_complex` / 浏览器 ffmpeg.wasm 分步）。规矩写死在注释里：lowering 不许自己选内容、不许出现路径和裸参数。
- 完整性断言：`assertPlanPreservesRequestedContent` —— 要的视频段/独立音轨/字幕烧录少一样就失败，不给「半个成片」。
- libass 的两个坑：字体缺失时以 0 退出（要单独识别）、wasm 侧直接提示改用服务端。
- 预览不合成：一个 `<video>` + N 个 `<audio>`，按播放头换源。
- 规模：前端时间轴面 ≈ 4.3k 行，后端 ≈ 2.85k 行（非测试）。许可：Source Available 1.0，商用需授权（lucas@bf-labs.cn）。

**修正**：不要把它当主路径。它的模型是「装配式」——主轨顺序拼接 + 音轨叠加 + 字幕烧录，没有 PiP / 关键帧 / 转场；真要做这些，那套 `concat` 得整条重写。它的正确位置是 **服务端兜底渲染**（同一份 plan，换一个 lowering）。

---

## 5. Toonflow：留作「一次性媒体变换」的底座

`packages/ffmpeg`，8 文件 932 行，MIT：下载 15 个源 + sha256 + gzip 解包 + 原子替换（可回滚）；fluent 路径沙箱（realpath / 拒绝 `..` 与协议路径 / Windows 保留名）；`worker_threads` 可取消；浏览器只序列化「我调了哪些链式方法」，执行与文件留在宿主。

- 它没有时间轴；`videoNode` 只有 `trim / extractAudio / separate`（87 行）。
- `director3dNode` 用 `captureStream(30)` + `MediaRecorder` 出 mp4，且要求窗口可见——**不要抄这条**，实时录制在桌面端不可靠。

结论：**当 `edit_media` 那层的底座搬过去**，不要指望它给你剪辑。

---

## 6. 对 craft 的移植方案（重估）

### 6.1 现状（必须先认）

当前工作树里**没有画布**：`apps/electron/src/renderer/components/canvas/` 只剩 `SessionCanvasWorkspace.tsx`（会话 + 资产库分栏），`packages/shared/src/canvas/__tests__/` 为空。`packages/shared/src/media/`（1,937 行）只有生成渠道（image/video/audio/transcribe），没有 probe/remux/合成。**明确不捆 ffmpeg**（`recording-encoder.ts`、`video-frames.ts` 的注释），编码靠 `MediaRecorder`（视频-only，`mp4-duration.ts` 事后改 box）。

### 6.2 建议的四步

| 步 | 做什么 | 依据 | 估时 |
|---|---|---|---|
| **S1 时间轴内核** | 把 `@openreel/core` 的 `Project`/`ActionExecutor`/`ActionHistory`/`capabilities` 拿进来，跑在 `server-core` 的 `HeadlessHost` 上；一份 `.clip`（JSON）落在项目文件夹，天然进 craft 的文件/版本/搜索 | OpenReel MIT | 1–1.5 周 |
| **S2 一个最小剪辑面** | 单面板：轨道 + 播放头 + 属性（transform/volume/speed/字幕），预览用 `<video>/<audio>` 换源（BeefTV 做法，最便宜）；不做 PiP/关键帧 | BeefTV 预览 + OpenReel ui 取舍 | 2–3 周 |
| **S3 导出** | 渲染走 craft 自己的纪律：**渲染进程里 WebCodecs + MediaBunny**（有 GPU 时）→ 产物写项目文件夹 + provenance；需要 libass/ProRes/长片时回落 ffmpeg（Toonflow 层或系统 ffmpeg） | MiniMax 的实测形状 + craft 的 hidden-window 纪律 | 1–1.5 周 |
| **S4 agent 协议** | 照 §3 的 12 个方法做一个 `timeline_tool`：`document.* / editor.* / command.get / project.get|diagnostics|edit|history|view|snapshot|export`；`project.edit` 用 §3.1 的词表；`baseVersionId` + `expectedDraftRevision` + `commandId` 幂等；`snapshot` 只当证据 | MiniMax 协议 | 1–1.5 周 |

可选：**S5 导演台**（3D previs）——three.js 舞台 + 语义关节/运镜 DSL + `scene.snapshot` 证据链，照 3d-director-stage 的 10 个方法做；2–3 周，且只有在「分镜预演」是刚需时才做。

### 6.3 三条必须定的产品判断

1. **成片交付形态**：落成「项目里的一条 mp4 + 生成记录」（craft 现有 provenance 模型），还是「一个新的资源版本 + 一堆可回溯的引用」？MiniMax 选了后者（导出即一个独立 Composition，保留源版本依赖）。craft 的 provenance 已经够用，**别引入 Composition 概念**——除非画布回来。
2. **剪辑器是「画布里的节点」还是「项目里的文件」**：MiniMax 是 `.clip` 资源 + 画布节点；craft 现在没有画布，**先做「项目里的一个文件 + 独立面板」**，画布回来再挂节点（数据结构一致，挂载点是 UI 层的事）。
3. **ffmpeg 要不要捆**：只在 S3 的兜底分支需要。可按需下载（Toonflow 那套），不做首装依赖。

---

## 7. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 依赖体量 | `@openreel/core` 连带 MediaBunny、ffmpeg.wasm、mediapipe、onnxruntime、three —— 全塞进 Electron renderer 会失控 | 只取 `timeline + actions + export`；AI/3D/抠像按需懒加载；导出可放独立窗口/worker |
| 许可 | OpenReel MIT（保留声明）；**MediaBunny 是 MPL-2.0**（文件级 copyleft：改它要开源那个文件，用它不用）；BeefTV Source Available（商用要授权）；MiniMax 闭源（只学协议） | 依赖清单 + NOTICE；不 fork MediaBunny |
| AAC 音频 | `AudioEncoder` 的 AAC 支持随平台/版本不同 | 探测 `isConfigSupported`；不可用则 mp4+opus 或回落 ffmpeg 封装 |
| 长片/4K | 渲染进程内存与 GPU 上限（MiniMax 也不敢在不预热的情况下承诺时间，会给估算 + 「保持应用打开」） | 明确上限（时长/分辨率）、分片渲染再拼接、进度与可取消 |
| 中文字幕 | 走 libass 才有字体问题；MiniMax 的做法是**字幕即 text clip，在合成里画**，根本没这个坑 | craft 沿用同样思路：字幕是文本图层，不进 libass |
| 预览与成片不一致 | 预览用元素拼、成片用合成管线 | 两边都从**同一份 Project** 派生；预览只做「大致对」的近似，并在 UI 上说清 |
| 剪映草稿漂移 | 草稿格式随剪映版本变，且关键帧/入退场会丢 | 只当「带出去再剪」的后门，失败只说失败，不猜原因 |

---

## 8. 结论（一页话）

- **拿 OpenReel Video 的内核（MIT）当骨头**：时间轴、动作/事务、能力词表、WebCodecs+MediaBunny 导出，都是现成的，且它自己就有 `HeadlessHost` 供 agent 无头编辑。
- **拿 MiniMax 的协议当关节**：12 个方法 + `project.edit` 的 30 条操作 + 版本前提 + `commandId` 幂等 + `snapshot` 当证据 + `export` 落成新产物。这套抽象同时承载「剪辑器」和「导演台」，比 BeefTV 的整份替换更强。
- **拿 BeefTV 的纪律当地基**：语义 plan 与 lowering 分离、请求内容不可丢、预览不合成、服务端兜底。
- **拿 Toonflow 的 ffmpeg 层当扳手**：只在需要「一条命令改一个媒体」时用，不参与成片主路径。
- **不要做**：把 `MediaRecorder` 当导出（无音频、时间戳不可靠）、实时录屏式合成、把剪映草稿当主交付。
