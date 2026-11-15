# Craft 媒体工作台：框架

> 2026-11-07，第三版。这一版先定框架，不展开字段、接口和排期。
> 补上此前漏看的两处：**MiniMax Code 有画布**（会话级，藏得深），**本机 Manus 也有画布**
> （Windows 包 `ManusAI.Manus_2.1.1.0`，会话侧边栏里的图片板）。它们和 craft 的项目画布不是
> 同一种东西，但把“画布也是 agent 的输入面”讲清楚了。
> 竞品结论来自本机可核查的安装包与源码：
> MiniMax Design（`%LOCALAPPDATA%\Programs\MiniMax Design\current\resources\app.asar`）、
> MiniMax Code（`...\MiniMax Code\resources\app.asar`）、
> Manus（`C:\Program Files\WindowsApps\ManusAI.Manus_2.1.1.0_x64__vajzd2mq3s8wj\resources\app.asar`）、
> Toonflow（`~/code/Toonflow-app`）、BeefTV（`~/code/BeefTV`）。

---

## 1. 一页框架

**一个 craft 项目 = 一个画布 + 一组 md 文档 + 一个资产库 + 多个剪辑。**

- **画布（唯一）**：项目的空间索引。节点只放三样东西：位置、指向哪个文件、可选的“配方”。
- **文档（md）**：文本的唯一真相。文本节点指向 md，不内嵌正文。
- **资产库（媒体）**：图片、视频、音频的唯一集合；每个文件旁边有 provenance。
- **剪辑（多份）**：每一份是一个时间线 JSON，独立表面，不塞进画布节点。
- **任务（后台）**：生成和渲染都是文件化任务，状态在产物旁边，不写进画布。

三条不变量：

1. **画布不存内容**，只存指针和配方。正文在 md，媒体在资产库，时间线在 `reels/`。
2. **产物只写一次**。重跑产生新文件，不覆盖旧文件；卡片改指向新文件，旧文件靠 provenance 留在线索里。
3. **空间、文本、媒体、时间各归其位**：画布管“在哪”，md 管“说什么”，资产库管“有什么”，剪辑管“先后”。

```
projects/<slug>/
├─ canvas.json          ← 唯一画布：位置 + 文件指针 + 可选配方
├─ docs/**.md           ← 文本：brief / 剧本 / 分镜 / 笔记 / 生成出来的文本
├─ assets/              ← 媒体：上传的、生成的；旁边有 .gen.json
├─ reels/*.reel    ← 多份剪辑；每份是独立时间线
├─ assets/.index.json   ← 资产的标签/备注（只存“意义”，不存文件清单）
├─ config.json
└─ MEMORY.md
```

---

## 2. 节点 = 文件 + 可选配方

这是整个框架的核心抽象，也是“人机同构”的落点。

**一个节点就是一张卡片，显示一个文件；如果这个文件可以由某次操作产生，卡片可以带一份配方。**

| 节点 | 指向的文件 | 配方 |
|---|---|---|
| 文本卡 | `docs/shot-01.md` | 可无（手写）；也可有 `text2text`、`image2txt`、`asr`（输入是别的卡片） |
| 图片卡 | `assets/x.png` | 可无（上传/入库）；也可有 `image-gen`、`upscale`、`extract-frame`（输入是视频） |
| 视频卡 | `assets/y.mp4` | 可无；也可有 `video-gen`（输入是文本/图片） |
| 音频卡 | `assets/z.mp3` | 可无；也可有 `audio-gen`、`extract-audio`（输入是视频） |

配方的形状是一样的，不管它产出的是一段文字还是一段视频：

```
recipe = {
  操作: text2text | image2txt | asr | image-gen | video-gen | audio-gen | upscale | ...
  输入: 有序的节点指针（图1/图2/图3、首帧/尾帧、源音频、源文本）
  参数: 模型、时长、分辨率、比例、数量……
}
```

三个推论：

1. **生成和“工具”不是两类东西。** text2text、image2txt、asr、生图、生视频、超分，都是“读一些文件，写一个文件”。节点按**产物的种类**命名（文本/图片/视频/音频），不按工具命名。
2. **人机同构。** 人点“生成”和 agent 调工具，读的是同一份配方、同一套输入顺序、同一个执行函数。UI 只是配方的表单。
3. **画布很小。** 它只存卡片和配方；正文、媒体字节、时间线都不在画布里。

---

## 3. 三条主流程

### 3.1 文本：md 是唯一的文本产物

```
手写 / text2text / image2txt / asr
        ↓
   docs/**.md（新文件或新版本）
        ↓
   文本卡指向它；也可以被任何生成卡当作提示词输入
```

- 文本卡不是一个“文本框”，而是**一个 md 文件的卡片**：预览、打开、替换指向。
- 生成文本的产物也是 md；它和手写的 md 没有区别，只是 provenance 里多一条“由哪个操作产生”。
- 文本卡可以被多个生成卡复用；也可以被剪辑当作字幕/文案来源。
- Agent 读写文本走普通文件工具；画布工具只给路径。长 brief 不进入工具参数，token 花在决策上。

### 3.2 媒体：资产库是唯一的媒体集合

```
上传 / image-gen / video-gen / audio-gen / 超分 / 抽帧 / 抽音频
        ↓
   assets/ 里的一个新文件（write-once）
        ↓
   媒体卡指向它；剪辑引用它；素材库给它标签和备注
```

- 生成卡的配方里，输入是**有序的节点指针**。顺序就是 API 顺序；提示词里用 `{{ref 1}}` 这样的指代绑定到第 1 个输入。
- 状态不在画布里：产物旁边有任务文件（running / failed / succeeded），卡片显示它。
- 重跑 = 新文件 + 卡片改指向；旧的“尝试”仍在资产库里，provenance 记录它的来源。

### 3.3 剪辑：时间线是独立文档，不是节点

```
选中若干媒体卡 / 从资产库挑素材
        ↓
   reels/<slug>.reel（可多份）
        ↓
   时间线表面：预览、裁剪、音轨、文字、转场
        ↓
   渲染 → 新资产 → 回到资产库 / 画布
```

- 剪辑是**时间**，画布是**空间**；把时间线塞进画布节点，会让画布理解轨道、播放头和渲染，节点尺寸也不合适。
- 剪辑有自己的全屏表面；项目侧栏列出所有 `reels/`；画布不承载时间线，也不放剪辑入口。
- 渲染是异步任务；产物是一个新资产，带 provenance，可以再放回画布，成为下一次生成的输入。

---

## 4. 为什么“一个项目一个画布”

这是本框架最重要的取舍。

**支持一个画布的理由：**

1. **项目已经是边界。** 资产、文档、剪辑都按项目组织。再按“阶段/集数”拆画布，会引入“哪个画布”的歧义和跨画布引用问题。
2. **竞品的多画布，是在替代“文档”。** Toonflow 明确把资产总画布当正式设定的唯一来源，分集画布只放引用；它不能跨画布连线，只能靠“引用节点 + 路径”复制上下文。MiniMax 的 `workspace-canvases` / `activeCanvas` / `duplicate canvas` 说明它把画布组织在 workspace 层；craft 的边界是 project，阶段文档已经是 md，剪辑已经是 `reels/`，再拆画布是重复。
3. **Agent 永远知道目标。** 只有一个 `canvas.json`，工具不需要“选画布”参数，也不会在错误的画布上操作。
4. **版本和权限简单。** 一个画布文件，一条写链；不需要处理“两个画布谁引用谁”。

**代价与缓解：**

- 大项目会很大。用**组 / 区域 / 保存的视图**解决：节点分组、区域框、“第 1 集”“角色设定”这类视口书签；它们是画布上的组织方式，不是新文档。
- 一个画布同时承担“素材地图”和“生成工作台”。这是有意的：项目里的媒体本来就是一张图，资产库负责“正式版本”，画布负责“正在怎么用”。

---

## 5. 为什么文本节点指向 md

**Toonflow 已经验证了这条路**：文本节点 `node:setText` 写的是文件，节点上留 `data.textPath`；`node:setText` 的回执不返回路径，需要正文时再读 `data.textPath`。也就是说，文本节点是**文件句柄**，不是正文容器。

craft 采用同样的形状，理由更强：

1. **文本要能被 agent 直接读写**：`Read` / `Edit` / `Write` 就是文本工具；画布不必发明一套文本编辑协议。
2. **文本要被多个卡片复用**：同一份 brief 可以喂三张生成卡；同一份分镜可以被剪辑当字幕来源。内嵌正文会产生三份副本，改一处不同步。
3. **文本本身就是产物**：text2text / image2txt / asr 的输出都是 md；手写和生成同一种形态，provenance 只多一条记录。
4. **画布保持小**：画布只存 `docs/xxx.md` 这个指针；长文不进 JSON，不进工具参数。

**代价**：文件被移动/删除时，卡片要显示“缺失”；并发编辑要走和 markdown 编辑器同一条写链（防抖写回、写前重读、外部改动跟随）。这是已有机制，不是新问题。

---

## 6. 为什么剪辑不是节点

**BeefTV** 的做法是答案：时间线是画布上的一个 **dialog/surface**（`canvas-timeline-dialog.tsx`、`use-canvas-timeline-asset-insert.ts`），不是节点。
**MiniMax Design** 有 `canvas.clip` / `canvas.media-clip` / `canvas.addToClipNode`，但点开进入的是**全屏编辑器**（`EditorInterface`、`back_to_canvas`、`exit_editing`），节点只是入口/指针。

- 时间线需要播放头、轨道、缩放、吸附、帧级操作；这些不属于画布。
- 时间线是“先后”，画布是“并存”；强行放进节点，会把两种交互揉在一起，且节点尺寸不足以承载时间轴。
- craft 的形态：`reels/` 多份，侧栏列表 + 全屏编辑器；画布不放剪辑入口。剪辑从选中的素材 / 资产库进入，不占用空间。

---

## 7. 竞品深读（框架层）

### 7.1 MiniMax Design：资源工作台 + 多画布 + 独立剪辑器

从安装包可见的模块与字符串：

- **画布**：`CanvasAreaV3`、`workspace-canvases`、`hilo.workspace.activeCanvas.v1`、`project-canvas-workspace`、`duplicate canvas`、`/api/v3/canvas`。
  → 工作区/项目可以有多个画布，有一个 active canvas。
- **资源与资产**：`AssetCenterPage`、`promote-to-asset`、`assetId:versionId`、`Project assets`、`assetPicker.tab.canvas`。
  → 资产中心是独立表面；画布节点引用资源；资源有版本。
- **生成**：`CanvasV3GenerationPanel`、`canvas-v3-generation-task`、状态 `queued / submitting / running / waitingCost / paused / binding / retrying / detached`、`failure.reason.PROVIDER_REJECTED`、费用确认。
  → 生成是一等任务，带计费/确认/恢复；卡上显示状态。
- **文本**：`canvas.text`、`canvasV3.generation.referenceTextLoading`、`/api/v3/canvas/text/generate`、`/api/v3/canvas/text/models`。
  → 文本生成是画布能力的一部分；文本可以作为参考/提示词。
- **剪辑**：`canvas.clip`、`canvas.media-clip`、`canvas.addToClipNode`、`EditorInterface`、`tb.back_to_canvas`、`clip-studio-export`。
  → 剪辑是独立编辑器；画布节点是入口。
- **Agent**：`/api/v3/canvas/agent-compositions`、`/api/v3/canvas/agent-deliveries`、`agent-composition:${id}`。
  → agent 的产物以“交付”进入画布，而不是自己另存一份。

**框架判断**：MiniMax 的画布是“资源工作台”，不是“项目文档”。它需要多画布，因为它的边界是 workspace；craft 的边界是 project，且阶段文档已经是 md，所以一个画布足够。可借的是：资源即版本、生成即任务、剪辑是独立表面、agent 交付。

### 7.2 MiniMax Code：会话级“文件板”，藏得深

它不是只有 agent IDE。排除依赖后，`canvas` 在应用代码里确实存在，只是不在“媒体”命名下：

- **入口**：`tab: CANVAS`、`openCanvasFile` / `openCanvasFiles`、`openCanvasFile({sessionId, workspaceDir, target})`。
- **文档**：`readCanvas({sessionId})` 返回 `document.nodes`；节点有 `id`、`type`、`assetId` 或 `relativePath`、
  `layout {x,y,width,height,zIndex}`、`annotations[]`。
- **写入**：`applyCanvasOperation({sessionId, operation:{schemaVersion, operationId, mutations}})`；
  mutation 例如 `remove_annotation`；有 `operation_conflict` / `node_not_found` 的拒绝语义。
- **文件来源**：`target.kind = workspace | asset | session_deliverable`，即工作区文件、资产库、会话交付物。
- **批注**：`canvasNodeId + annotationId`、归一化矩形、`comment` / `erase`、截图证据；
  发送给 agent 时打包成 `mavis.annotation_bundle.v1`（`surface:"canvas"`、
  `action:"apply_annotations"`），上限 50 条。
- **界面文案**：`Create in chat. Edit on the canvas.`、`Add file` / `Add folder`、
  `Add selected`、`This file is already on the canvas`、`This node is no longer on the canvas`。
- **图像工具**：`removeCanvasImageBackground`、`enhanceCanvasImage`。

**框架判断**：这是**会话级画布**——画布属于一次任务/对话，不是项目文档。它的节点就是
工作区文件、资产、会话交付物；它的核心输入不是“提示词”，而是**选中 + 批注**。
它验证了两件事：① 画布可以只是“文件的视图”，不必自己存内容；② 批注是 agent 最自然的输入。

### 7.3 Manus：会话侧边栏里的图片板

Manus 的 Windows 包（`ManusAI.Manus_2.1.1.0`）里，画布是聊天侧边栏的一种模式：

- `chatSidebarController.openSidebar({type:"canvas", source:"chat"})`、`sidebarMode:"canvas"`。
- `selectOrInsertImageByUrl({openCanvas, fileName, url, artifactId, previewUrl, select})`：
  从对话或 artifact 把图片插入画布；一次最多 50 张。
- `camera.zoomToSelection()` / `zoomToFit()`、`interaction.setActiveTool("select" | "hand" | "mark" | "comment")`。
- `canvasPreviewUrl`、`deleteCanvasMark`：图片有预览、标记和批注。

**框架判断**：这是**会话级图片板**——从对话里拿图，放进一块可缩放的空间里看、标、改；
没有项目文档，也没有时间线。它和 MiniMax Code 是同一类：**画布是 agent 任务的视觉工作区，
输入是“我选了哪张图、圈了哪一块、写了什么”**。

### 7.4 两种画布，不要混为一谈

| | 项目画布（craft / BeefTV / Toonflow） | 会话画布（Manus / MiniMax Code） |
|---|---|---|
| 生命周期 | 项目在，画布在 | 任务/对话结束就散 |
| 内容 | 项目的文件地图：文档、资产、生成卡 | 本次任务的产物：图片、文件、交付物 |
| 主要输入 | 节点 + 配方 + 引用 | 选中 + 批注 + 截图 |
| 主要输出 | 生成、剪辑、资产入库 | 让 agent 改这次任务的产物 |
| 适合 | 长期创作、复用、版本 | 单次任务、快速迭代、审阅 |

craft 选项目画布，这是对的：craft 的边界是项目，资产/文档/剪辑都按项目组织。
但会话画布有一个能力值得吸收：**画布上的选中与批注，本身就是 agent 的输入**。
craft 不需要第二个画布；需要的是在项目画布的节点上，允许“圈一块 + 写一句 + 发给 agent”。

### 7.5 Toonflow：把画布当“阶段文档”，文本当文件

- **多画布**：`addCanvas` / `switchCanvas` / `renameCanvas`；文档明确“资产总画布是正式设定及采用版本的唯一来源”，分集画布只建引用；“不能跨画布引用源节点来造边”。
- **文本即文件**：`node:setText` 写文件，`data.textPath` 指向正文；长文通过 `path` 分段读取，不把全文塞进画布。
- **引用顺序**：`{{ref N}}` + `data.referenceOrder`；连线的实际输入序列决定编号，未就绪项占位并阻止生成。
- **生成**：每个节点有 `node:generateImage` / `node:generateVideo` / `node:getGenerationStatus`；状态 `idle/running/succeeded/failed`，并提醒“重载后的 idle 不证明从未生成”。
- **Provider**：插件式 `generateImage/generateVideo/resumeTask` + 模型能力（mode / durationResolutionMap / 参考上限）。

**框架判断**：Toonflow 的多画布是“阶段文档”的替代品（资产总画布、分集画布、剧本画布）。craft 已经有 md 和 edits，不需要用画布承担阶段文档；但“文本即文件”“引用顺序”“生成状态”三条要直接吸收。

### 7.6 BeefTV：一个画布 + 时间线是表面 + 处理节点

- **一个画布**是主工作台：节点是图片/视频/文本/处理节点；画布版本记录保存“结构 + 媒体引用”，不复制视频文件。
- **剪辑是 dialog**：`canvas-timeline-dialog`，从画布进入；不是时间线节点。
- **处理节点**：AI 超分、宫格切分、多角度等，都是“输入 → 处理 → 新结果节点”；结果落在画布上，原素材保留。
- **智能引用**：`图1` / `图片1` / `image1` 可以自动匹配已连接素材并转成引用；编号是接口的一部分。
- **任务与成本**：任务中心、费用预估、确认后生成；重试不重发已受理任务。

**框架判断**：BeefTV 与 craft 的目标形态最接近：一个画布、时间线独立、处理即节点、资产有版本/引用。craft 的差异是“文件系统优先、md 是文本真相、剪辑自研 JSON”，这三点让框架更小。

### 7.7 一张表

| 维度 | MiniMax Design | MiniMax Code | Manus | Toonflow | BeefTV | **Craft（本框架）** |
|---|---|---|---|---|---|---|
| 画布范围 | workspace 多画布 | **会话级文件板** | **会话级图片板** | 项目多画布（阶段） | 项目一个画布 | **项目唯一画布** |
| 文本 | 节点内容/参考 + 文本生成 | 文件/交付物 | — | **文本节点 → 文件** | 文本节点/提示词 | **文本节点 → md** |
| 媒体 | Asset Center + 版本 | 资产/工作区文件 | 图片/artifact | 全局库 + 资产画布 | 资产库 + 画布引用 | **资产库 + provenance** |
| 生成 | 画布任务 + 计费/确认 | 文件工具 | 聊天产物 | 生成节点 + provider 插件 | 生成节点 + 任务中心 | **生成卡 + 任务文件** |
| 剪辑 | clip 节点 → 全屏编辑器 | — | — | 无时间轴（ffmpeg 变换） | 时间线 dialog | **多份 reels/ + 全屏** |
| Agent 输入 | deliveries / compositions | **选中 + 批注** | **选中 + 标记/批注** | nodeTools + 连线 | assistant + MCP | **路径/节点 + 批注** |

---

## 8. 人机同构

| 实体 | 人的动作 | agent 的动作 | 共享的东西 |
|---|---|---|---|
| 画布 | 拖、放、选引用、打开配方 | `canvas_tool` 的 add/move/update/ref | 同一套 ops、同一份 `canvas.json` |
| 文本 | 在 md 编辑器/文本卡里改 | `Read` / `Edit` / `Write`，或 text2text | 同一个 md 文件 |
| 媒体 | 上传、生成、入库 | `media_tool`（节点 id 或临时请求） | 同一个生成函数、同一个资产库 |
| 剪辑 | 时间线拖拽、裁剪、导出 | `reel_tool` 的 state/apply/snapshot/export | 同一份 `reels/*.reel`、同一套 ops |
| 素材 | 打标签、写备注、选版本 | —（由人在资产面板完成） | 同一个 `assets/.index.json` |

### 8.1 画布也是 agent 的输入面

会话画布（Manus / MiniMax Code）最值得吸收的不是“会话”这个范围，而是**输入方式**：

- 人选几个节点，圈一块区域，写一句话，发给 agent；
- agent 收到的是一份**选区 + 批注**：节点 id、文件路径、归一化矩形、批注文字、可选截图；
- agent 改的是那个文件/配方，产出新文件；不是“在画布里生成一段无法回写的对话”。

这不要求 craft 增加第二个画布。批注可以挂在项目画布的节点上，是节点的元数据，不是内容：
它是“给人指出要改哪里”的临时输入，发完就可以清掉。核心仍然是**节点 = 文件 + 可选配方**。

### 8.2 两条纪律

1. **面板打开时，agent 的改动进入编辑器的历史**；没人打开时直接写文件并说明。画布、md、剪辑、素材都是这条规则。
2. **agent 只拿路径和 id，不拿正文/字节**；需要内容时再读文件。这样长 brief、长剧本不占工具调用的 token。

---

## 9. 不做什么

- **不做多画布，也不做会话画布。** 项目唯一画布；任务级的视觉工作用“选区 + 批注”完成，不再开一块板。
- **不做时间线节点，也不在画布上放剪辑入口。** 剪辑只属于 `reels/` 列表和全屏编辑器。
- **不把正文/字节塞进画布。** 文本在 md，媒体在资产库，时间线在 edits。
- **不把批注当内容。** 批注是“指向某个文件的一块区域 + 一句话”，是输入，不是文档。
- **不覆盖旧产物。** 重跑写新文件；旧文件靠 provenance 留存。
- **不引入外部剪辑器/依赖。** 时间线是自研 JSON；外部项目只作设计参考。
- **不为每个 provider 写适配器。** 先数据驱动的能力表；特殊协议才加 adapter。
- **不做“生成即完成”的假象。** 状态、失败原因、采用/未采用，都要在卡片上说清。

---

## 10. 已定的框架选择

这三个已经拍板，后面的细节都按它们展开：

1. **旧的多画布**：每个项目选**最近编辑的一份**作为唯一画布；其余保留为普通文件，不进入默认 UI，不做自动合并。
2. **剪辑入口**：只在侧栏的 `reels/` 列表和全屏编辑器；画布上不做剪辑节点，也不做指针卡。
3. **画布引用**：**有序槽位 + 编号**。节点保存有序输入数组，提示词用 `{{ref N}}`；画布不画连线，只在卡片上显示 ①②③。

仍然留到最后再定、但**不影响框架**的三件小事：媒体物理目录是否合并（`assets/` 与 `generations/`）、
画布是否要“保存的视图”（建议用组 + 视口书签，不新增文档）、以及**批注层第一批做到哪**
（建议先做“选中节点 + 一句话”，区域圈选和截图后置）。

---

## 11. 实施顺序（框架级）

- **A. 地基**：项目唯一画布（最近一份迁移为 `canvas.json`，其余留作普通文件）；节点 = 文件 + 可选配方；文本卡指向 md；资产库是媒体唯一集合；剪辑列表支持多份。
- **B. 生成**：配方执行（人机同一函数）；有序引用 + `{{ref N}}`；任务状态；文本生成与 image2txt/asr 产出 md；资产写一次。
- **C. 剪辑**：多份时间线的独立表面；agent 读写；抽帧审阅；渲染产物回到资产库/画布。
- **D. 收口**：画布 ↔ 剪辑 ↔ 资产库的交接；**选中 / 批注作为 agent 的输入**；批量/候选、成本确认、体检。

细节（字段、接口、迁移脚本、任务表结构）放到框架确认之后，再单独展开。

---

## 12. A 阶段：地基的边界

这一节只定“谁拥有什么、迁移怎么走、验收看什么”，不写字段和接口。

### 12.1 一个画布文件

- 每个项目一个 `canvas.json`；没有“画布列表 / 新建 / 删除 / 切换”。
- 旧项目：把最近编辑的一份 `canvases/*.canvas.json` 迁移为 `canvas.json`；其余保留为普通文件，
  默认 UI 不列出，不自动合并。
- 所有权不变：面板打开时，agent 的改动送进面板的历史；没人打开时直接写文件并说明。
  写前提仍是 revision。

### 12.2 节点契约

- 节点只有四种产物：`text / image / video / audio`。
- 每个节点指向一个**项目相对文件**：文本 → `.md`，媒体 → 资产。
- 节点可带一份**可选配方**：操作 + 有序输入 + 参数；没有配方就是一个普通文件卡。
- 节点不存正文、不存字节、不存时间线；批注是节点元数据，不是内容。
- 不按工具增加节点类型：asr 的产物是文本卡，超分的产物是图片卡，生视频的产物是视频卡。

### 12.3 文本卡

- 卡上显示 md 的预览；打开进入 md 编辑器；编辑写回同一个文件。
- 生成文本（text2text / image2txt / asr）写一个新的 md；卡片改指向新文件，旧文件保留。
- 文件缺失时显示“缺失”，提供“重新指向 / 新建”；不退回内嵌正文。

### 12.4 资产

- 一个逻辑资产集合：画布、剪辑、素材库、agent 看到的是同一组文件。
- 物理目录可以是 `assets/` + `generations/`，也可以合并；差别不进入框架。
- 产物只写一次；卡片指向文件，provenance 在文件旁边。
- “上传”和“生成”只是 provenance 里的来源，不是两套读模型。

### 12.5 剪辑

- `reels/*.reel` 可以有多份；侧栏列出，独立全屏打开。
- 画布不出现剪辑节点，也不出现剪辑入口；剪辑从素材/资产库进入。

### 12.6 工具面

- `canvas_tool` 不再需要 `--canvas`：它操作“这个项目的画布”。
- 它可以加节点、改节点的文件指向、改配方、读画布；不生成媒体、不写 md 正文。
- 文本读写走普通文件工具；剪辑继续走 `reel_tool`；媒体生成在 B 阶段接同一个配方执行函数。
- 面板打开时，画布/剪辑的改动通过 bridge 进入编辑器历史；没人打开时写文件。

### 12.7 迁移顺序

1. 每个项目选最近编辑的旧画布，迁移为 `canvas.json`；其余留作普通文件。
2. 内嵌文本节点：把 `text` 写成一个 md（例如 `docs/nodes/<node-id>.md`），节点改为指向它。
3. 媒体节点的 `src` 统一改名为“文件指针”；路径不变。
4. 没有配方的节点保持普通文件卡；不猜测、不自动生成配方。
5. `reels/` 不动；素材库索引不动；provenance 不动。

### 12.8 验收

- 打开任意项目，只有一个画布；旧画布不会以第二份画布出现。
- 文本卡显示 md；改 md，卡上跟着变；改卡，落回同一个 md。
- 媒体卡只显示资产；画布 JSON 里没有正文和字节。
- agent 不传画布 slug 也能读写画布；打开面板时改动可被人的 Ctrl+Z 撤销。
- 旧项目的节点不丢；内嵌文本迁移后仍可读。
- 剪辑列表仍能打开多份 cut，画布上没有剪辑入口。

### 12.9 风险与边界

- **画布会变大**：不把长文/字节放进去；组/区域/视口书签用来组织，不新增文档。
- **文件缺失**：卡片显示缺失，不静默隐藏；迁移不删除任何旧文件。
- **两个写者**：md 走已有的 markdown 写链；画布走 revision；不要出现第三条写链。
- **不要顺手做**：生成、批注、批量、成本确认都属于 B/C/D，不在 A 里加。

---

## 13. 已落地（2026-11-07，A 阶段第一批）

- 项目唯一画布：`<project>/canvas.json`；首次打开时取最近编辑的旧 `canvases/*.canvas.json` 迁移，其余旧文件原样保留。
- 文档 v2：`src` 是所有卡片的文件指针（文本 → md，媒体 → 资产）；新增 `audio` 节点与 `recipe`（只存储，不执行）；v1 仍可读。
- 文本卡接 md：新建文本卡时创建 `docs/nodes/<node-id>.md` 并打开编辑器；卡片预览读 md；双击/右键打开文档；内嵌文本迁移成 md。
- `canvas_tool` 去掉了 `--canvas`：读写“这个项目的画布”；帮助与节点形状更新为“文本卡指向 md、recipe 只存储”。
- 画布 JSON 不再出现在侧栏的普通文件列表里；它由“画布”入口打开。
- 测试：画布文档、文件/迁移、`canvas_tool` 共 37 项通过；shared / session-tools-core / server-core / electron 类型检查通过。

---

## 14. 已落地（2026-11-07，B 阶段第一批）

- 生成卡开始持久化配方：`prompt / params / channelId / model / inputs` 写进 `node.recipe`；生成失败也保留表单，不丢刚输入的内容。
- **有序参考图槽位**：composer 里可以按顺序选画布上的图片卡，拖拽调整顺序，卡片上显示 ①②③；生成时按这个顺序发 `images` / `references`，提示词里用 `{{ref N}}` 指代第 N 张。
- **有序文本卡**：composer 里可以按顺序选文本卡，拖拽调整顺序，卡片上显示 T1/T2；文本卡的 md 内容按顺序拼在提示词前面，内联输入框放在最后。UI 与 agent 使用同一条拼接规则。
- **agent 按节点执行**：`media_tool generate --node <id>` 读这张卡的配方——文本卡按顺序拼成提示词、图片卡按顺序作为参考、渠道/模型/参数沿用——把结果写回卡片（面板打开时进撤销栈，没人打开时写文件）。`task --node` / `cancel --node` 查同一张卡的任务。
- 卡片读任务文件：`queued / running` 显示“生成中”，`failed / submission_unknown` 显示任务原因；任务落地后图片重新读取，视频海报重挂。
- **`{{ref N}}` 的厂商改写**：提示词里的位置标记由 `rewritePromptReferences` 统一改写为渠道的写法（默认 `图片{n}` / `视频{n}` / `音频{n}`，频道可用 `referenceLabels` 覆盖成 `Image {n}` 等）；UI 的 ✨ 与 `media_tool generate --node`、独立 `--input` 都走同一个纯函数。参考图 chip 上的编号可点击，把标记追加到提示词末尾；拖拽换序时标记跟着卡片走。配方里保存原始标记，卡片始终可重跑、可换序。
- **文本可以由工具产出**：`media_tool describe --image <path> --out <md>`（image2txt）与 `media_tool transcribe --in <path> --out <md>`（asr）把文字写成文本卡指向的 markdown；`--out` 必须是 `.md`。画布上图片/音频卡的右键菜单有“反推提示词 / 转写为文本”，走同一份 RPC，成功后直接在旁边生成一张文本卡。text2text 仍由 agent 的普通文件写入完成。
- **图片 / 视频 / 音频混排参考**：composer 的参考条是一列有序素材，可以混排图片、视频、音频卡；生成时按类型拆成 `images` / `videos` / `audios` 三个数组，`{{ref N}}` 指向整条顺序里的第 N 个，内部再映射到该类型的下标。异步 `content` 协议（MiniMax H3 / Toonflow / BeefTV 同形）按 `reference_image` / `reference_video` / `reference_audio` 发送；只收图片的渠道会明确拒绝，而不是悄悄丢掉参考。任务文件仍只存一条有序的 `references` 路径列表，恢复时按扩展名重新分组。
- **首帧 / 尾帧是角色**：视频卡的参考条上有“首帧 / 尾帧”两个槽位；指定的素材仍占据条带里的编号位置（`{{ref N}}` → `首帧` / `尾帧`），但不会同时作为普通参考发送。异步 `content` 协议按 `role: first_frame / last_frame` 发送；任务文件记录这两个角色路径，恢复时不会重复计为参考。CLI 对应 `--first-frame` / `--last-frame`。
- **剪辑已是自研时间线**：`reels/<slug>.reel` 由 `EditSurface` 直接读写，`reel_tool` 用同一份 JSON 供 agent 增删改片段；随包的 OpenReel 制品（`resources/openreel`、iframe 宿主、`/openreel/` 路由、bridge、IPC）已全部移除。
- **剪辑可以从零由 agent 创建**：`reel_tool create --name 预告 [--file …] [--width --height --fps]` 写一份空的时间线文档；侧栏“新建剪辑”写的是同一份文档（不再写旧的 OpenReel 包装）。顺带修好了 `state --json` 这类布尔标志被解析器丢掉的问题。
- **预览是合成的**：画面取“最上层视频轨在播放头下的片段”，图片用 `<img>`、视频用 `<video>`；每条音轨在播放头下的片段各有一个 `<audio>`，与画面一起 seek / 播放，空隙显示黑场。波形按轨绘制。
- **多轨时间线**：V/A 轨道分行显示，轨道头按种类编号；可以在工具栏加视频轨/音轨，也可以把素材拖到指定轨道；音频素材默认落到音轨。`reel_tool` 新增 `add_track` 与 `add_clip.trackId`，人机可编辑同一份结构。
- **导出按时间线而不是按拼接**：以 `max(start+duration)` 为片长，逐帧生成；图片保持整个片段时长并按比例留黑边；视频片段按 `start` 放到正确的时间点；重叠时上层轨覆盖下层。声音按 15 秒一段用 `OfflineAudioContext` 混好，并把所有音轨与视频自带音频按 `start/in/duration` 排进同一时间线，再编码为音频轨。编码器不写死：先 `getFirstEncodableVideoCodec` / `getFirstEncodableAudioCodec` 探测本机可用的 codec；AAC 的实际编码延迟会先测出来，并在 MP4 的 `moov` 里写入 edit list 修正。导出页通过 preload 读取源文件，不再依赖 `file://` fetch；写盘按 muxer 给的 offset 同步落盘，`moov` 修正和最后一个 chunk 不会与关闭文件竞争。
- **字幕 / 花字 / 画中画是同一种叠加层**：文档新增 `overlays`，一条 overlay 是 `{ id, kind: text|media, text?/src?, start, duration, in?, box?, preset?, style?, opacity?, z? }`。文本层用 `preset`（subtitle / title / neon / label）加样式覆盖；媒体层就是一个按比例定位的画中画盒子。叠加层也计入片长，所以字幕可以比画面更长。
- **人机同构**：`reel_tool` 新增 `add_overlay` / `update_overlay` / `remove_overlay`，`state` 会列出每条 overlay 的 id、类型、起止和文本/素材；面板里的“文字 / 图形”标签直接编辑同一个 `overlays` 数组，撤销栈也走同一套。
- **预览与导出同源**：预览把叠加层按 composition 像素布局后整体缩放，字幕字号/位置与成片一致；画中画视频在预览里随播放头 seek，音频默认静音。导出时按 z 序绘制：文字走 Canvas 2D（背景条、描边、发光、逐字换行），画中画按 `in + (t - start)` 取帧或绘制图片；画面与字幕在同一条逐帧循环里合成。
- **SRT 是字幕的交换格式**：`@craft-agent/shared/reel/srt` 提供 `parseSrt` / `formatSrt` / `normalizeCues` / `cuesFromOverlays` / `overlaysFromCues`。ASR 产出的 `.srt` 直接变成字幕叠加层（一条 cue 一条 overlay），导出的 SRT 只取 subtitle 类型的文本层，标题/花字不会混进对白。`reel_tool` 对应 `add_subtitles`（srt / path / cues）与 `subtitles [--out]` 两个入口，面板的“导入 SRT / 导出 SRT”写的是同一批 overlay。
- **时间线上的叠加轨道**：时间线在画面轨之上有 S（字幕）和 O（其他叠加：标题、花字、画中画）两行，块可以直接拖动改时间窗并吸附到片段/播放头边缘；选中块会打开对应的文字或图形检查器。数据上仍是一个有序 `overlays` 数组，轨道只是它在时间轴上的呈现。
- **每段素材的声音独立可控**：片段增加 `volume`（0..1）与 `muted`，预览按播放头把音量写回主画面 `<video>` 和各音轨 `<audio>`，导出时同样以增益节点进入混音；`reel_tool` 对应 `set_audio` 与 `add_clip.volume/muted`，面板在“媒体”标签给选中片段一条音量条 + 静音键。
- **音频分离**：视频片段可以“分离音频”——同一源窗新建一条音频片段（必要时自动建音轨），画面片段被静音，避免同一路声音听两遍；之后画面和声音可以各自移动、裁剪。`detach_audio` 与面板按钮同构，重复分离会被拒绝。
- **画中画的声音默认关闭**：PiP 只有显式 `muted: false` 才会出声（`resolveOverlayVolume`），检查器里可以开声并调音量；导出页把 PiP 的音频也按 `start/in/duration` 混进同一条时间线。顺带修好了导出页读取 PiP 源文件的问题：渲染页拿不到项目相对路径，现在 overlays 的 `src` 在交给导出页前会转成绝对路径。
- **仅音频导出**：导出任务支持 `audioOnly` —— 只建音轨、不建画面轨，帧循环长度直接为 0，所以不探测视频编码器、不画任何一帧；容器仍是 MP4（文件写 `.m4a`），混音、15 秒分块与 AAC priming 修正全部复用。面板顶栏的“仅音频”写 `generations/<name>-<ts>.m4a`，没有可解码声音时会明确报错而不是产出空文件。
- **对齐参考实现的音频模型**：OpenReel（`C:\Users\Ryan\code\openreel-video`）的模型是「轨道 `muted/solo/role` + 片段 `volume/fade/automation` + 按对齐关系识别分离出的音频片段」，音频分离实际走 `extractAudioWav` 产出独立文件；MiniMax Design 的片段菜单有「分离音频」，音频检查器有音量、淡入淡出、降噪预设和 ducking 面板，ducking 是把触发轨的电平分析结果**烘焙成音量关键帧**（阈值/降低量/attack/release/hold，附 subtle/moderate/aggressive/podcast 预设）。craft 已经复用其中的核心：`clipGainAt`（线性淡入淡出）、`trackAudible`（静音/独奏只影响声音）、`setClipFade` / `setTrackAudio`，面板与 `set_fade` / `set_track_audio` 同构。
- **Ducking（MiniMax 的“烘焙成关键帧”方案）**：片段检查器里选触发轨 + 预设（轻微 / 适中 / 强力 / 播客，阈值与降低量直接取 MiniMax 的数值），面板用已缓存的 50 桶/秒波形分析触发轨，`duckingEnvelope` 生成 attack / hold / release 包络并写入 `clip.automation`；`clip.ducking` 同时保留设置，`clear_ducking` 把两者一起清掉。预览逐帧走 `clipGainAt`，导出按关键帧打 ramp，所以“人声一出现 BGM 就退”在预览和成片里一致。agent 可用 `set_automation` 直接写同一组点。
- **还未接的参考项**：降噪预设（需要音频效果链）与静音检测/剪切。仍然不做自动归一化——响度关系由分轨电平、fade 与 ducking 决定。
- 音频素材在时间轴上的波形、按轨显示、每段音量/静音/淡入淡出、轨道静音/独奏、ducking 与混音都已接通；wipe/slide/zoom 转场、文本动画与音频效果仍是后续。
- **片段变换与画面调整（对齐 MiniMax 的 `tf.*`）**：`clip.transform = { x, y, scale, rotation, radius }` + `clip.opacity`；x/y 是画面宽高的比例，radius 是短边比例。预览用等价的 CSS transform（播放器盒与 composition 同比例，所以位移比例一致），导出在逐帧循环里 translate/rotate/scale + 圆角裁剪。面板“调整”标签提供位置 / 缩放 / 旋转 / 圆角 / 不透明度与重置，agent 对应 `set_transform`。
- **片段操作（对齐 `cm.*`）**：`duplicate_clip`（紧跟其后复制）、`ripple_delete`（删除并把同轨后续片段左移）、`close_gap`（贴到前一个片段）、`remove_gaps`（整轨压实）。面板“调整”标签暴露四个按钮，agent 同名 op。
- **转场（对齐 `tr.*` 的核心三种）**：转场归属后一个片段（`clip.transition = { kind, duration }`），窗口以剪切点为中心、前后各一半。已支持交叉淡化、淡入黑场、淡入白场；没有把手素材的一侧用边缘静帧顶住，所以画面不会跳。预览是“主画面 + 一个冻结层”合成，导出在重叠窗口里画两帧（crossfade 叠 alpha、dip 叠颜色），两边共用同一个进度。agent 对应 `set_transition` / `clear_transition`，要求前面有紧邻片段。
- **与 MiniMax 剪辑器的对照**：已对齐 = 多轨时间线 / 吸附 / 切分 / 裁剪 / 移动 / 复制 / 波纹删除 / 合并空隙、文字 / 花字 / 字幕（含 SRT）、画中画、变换 / 不透明度、音量 / 静音 / 淡入淡出 / 轨道静音独奏 / 音频分离 / ducking、交叉淡化 / 黑场 / 白场转场、成片与仅音频导出。待补 = 其余转场（wipe / slide / zoom / push）、文本动画（`ta.*`）、音频效果（`au.*`：EQ / 压缩 / 混响 / 延迟）、自动剪切与节拍对齐、FCPXML / 剪映导出、轨道重命名 / 排序 / 锁定。
- 异步生成中关闭面板再打开：卡片仍从 `<src>.task.json` 恢复状态，不再变成空白卡。
