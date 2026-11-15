# 本地转写独立成 audio-tool（本期不做云端 ASR）

## Context

现在「转写」是 `media_tool` 的子命令，配置又挂在生成渠道（`media-channels.json` 的 `kind: 'transcribe'`）里。三个问题：

- 本地 sherpa 解码是同步 N-API，在 server/Electron 主进程里执行会卡住整条事件循环（实测 71 秒音频 4.04 秒，一小时会议约 3.5 分钟）。
- 转写不需要账号，却和「有账号才能生成」的门混在一起，`media_tool` 的说明和行为都变复杂。
- 转写的模型、语言没有自己的配置位置，只能塞进渠道的 endpoint。

本期目标（已确认）：`media_tool` 只保留生成；转写全部交给独立 CLI `audio-tool`，**只做本地 sherpa**；ASR 配置独立成 `~/.craft-agent/asr.json`（只有本地字段），UI 作为「语音转写」分区并入 AI 设置页。画布的录音转写改走 `asr:transcribe` RPC，内部 spawn 同一个 CLI，保证只有一条执行路径。

**本期不做**：云端 ASR（`api-transcribe.ts`、云端预设与密钥）、模型下载 UI、Qwen3-ASR。云端的现有实现随 `media_tool transcribe` 一起删除，以后要做时按 asr.json 的 `engine` 字段扩展并从 git 历史取回。

## 一、配置契约

新建 `packages/shared/src/media/asr-config.ts`（纯类型/默认值/规范化，可被 renderer import）：

```ts
export interface AsrConfig {
  version: 1
  local: {
    /** 空 = 在 ~/.craft-agent/models 自动发现 */
    modelDir?: string
    /** 空 = 取第一个可用模型 */
    modelId?: string
    /** 'auto'（SenseVoice 默认）或 zh/en/ja/ko/yue */
    language?: string
  }
}
```

- 导出 `DEFAULT_ASR_CONFIG`、`normalizeAsrConfig`、`asrConfigProblem`（模型目录里能否发现模型；没有就是一条可读的问题）。
- 预留性说明：以后加云端时在这里加 `engine` 与 `cloud`，不改文件路径。

新建 `packages/shared/src/media/asr.ts`（fs）：

- `asrConfigPath() = join(CONFIG_DIR, 'asr.json')`；`readAsrConfig()`（缺失返回默认值，损坏返回默认值 + `problem`，格式对齐 `object-storage.ts`）；`writeAsrConfig()` 写 `{ version: 1, ...normalize() }`。
- **一次性迁移**（仅当 `asr.json` 不存在）：读 `media-channels.json`，若有 `transcribeShape === 'sherpa-local'` 的端点，把它的 `localModelDir` 与首个模型写进 `asr.json` 的 `local`。不重写 `media-channels.json`，旧端点在下次保存生成渠道时自然消失。

## 二、移除 `media_tool transcribe`（含云端转写）

- `packages/shared/src/media/channels.ts`：`MediaChannelKind` 收窄回 `MediaKind`，删除 `MediaTranscribeShape`、`transcribePath/transcribeShape/localModelDir`（endpoint、legacy 字段、`ENDPOINT_KEYS`、`withPreset` 合并、读写校验）。读取时丢弃任何非 `image|video|audio` 的端点/空渠道。
- `packages/shared/src/media/presets.ts`：移除 4 个转写预设（`bailian-asr`、`volcengine-asr`、`openai-asr`、`local-sherpa`）。
- `packages/shared/src/media/model-catalog.ts`：删除 5 条 `kind: 'transcribe'` 条目（`bigmodel`、`gpt-4o-transcribe`、`gpt-4o-mini-transcribe`、`whisper-1`、`qwen3-asr-flash`）。
- 删除 `packages/shared/src/media/providers/api-transcribe.ts` 与 `__tests__/api-transcribe.test.ts`（云端实现，本期无调用方），并从 `media/index.ts` 去掉导出。
- `packages/shared/src/media/generate.ts`：删除 transcribe 特判（约 116、343-349）。
- `packages/shared/src/agent/media-commands.ts`：删除 `transcribe` 分发（约 456-547）、`sayTextProduct`、help 段落、unknown-command 列表里的 transcribe、生成类过滤里的 `!== 'transcribe'`。**media_tool 内部不留任何指路文案**：未知命令只列剩下的命令，不出现「改用 audio-tool」之类提示。
- `packages/shared/src/media/tool-brief.ts`：`MediaCapabilities` 去掉 `transcribe`，brief 只删不加，不提 audio-tool。
- `packages/session-tools-core/src/tool-defs.ts`：media_tool 描述删掉 transcribe 段，不加替代说明；browser 录制提示（829-830）与注册表注释里原有的 `media_tool transcribe` 改成 `audio-tool transcribe <file>`。
- 其余原有文案同步（这些是能力说明，不是 media_tool 的入口提示）：`packages/shared/src/agent/browser-commands.ts`（3 处）、`packages/server-core/src/sessions/SessionManager.ts`（4666）改为 `audio-tool transcribe`；`packages/shared/src/creations/extract.ts` 去掉 transcribe 动词。
- `packages/shared/src/prompts/system.ts`：在 `img-tool` 那组本地命令旁登记 `audio-tool transcribe|models|config`（与 img-tool 同一种登记方式）。
- `packages/server-core/src/handlers/rpc/media.ts`：删除 `TRANSCRIBE` 频道与处理器、kind 白名单里的 `transcribe`、任务里的特判。

## 三、audio-tool CLI（仅本地）

新建 `apps/electron/resources/cli-tools/audio-tool.ts`（单文件 ESM，沿用 `./args` 的 `parseArgs`/`emit`/`fail` 风格，import `@craft-agent/shared/media` 的 `asr` 与 `local-sherpa`）：

- `transcribe <file>`：`--model`、`--model-dir`、`--language`、`--out`、`--format text|json|srt`、`--json`。默认 stdout 纯文本；`--json` 输出 `{ ok, text, srt?, model, segments?, vad?, ms }`；`--out` 写文件后 stdout 报路径。退出码：0 成功、1 运行失败（模型缺失/sherpa 不可用/ffmpeg 失败）、2 用法错误。
- `models`：本地可用模型（id/dir/family）、VAD 是否可用、模型根。
- `config`：解析后的有效配置与 `asr.json` 路径。
- `--help` 打印用法。
- 模型查找：`CRAFT_SHERPA_MODEL_DIR` → `asr.local.modelDir` → `CONFIG_DIR/models`；内置 VAD 用 `import.meta.dir/models/silero_vad.onnx`（构建时从 `resources/models` 复制进 `cli-tools/dist/models`），存在且未设 `CRAFT_SHERPA_VAD_MODEL` 时以环境变量形式传入。

配套：

- `apps/electron/resources/bin/audio-tool`、`audio-tool.cmd`：照 img-tool 模板；`.cmd` 必须写死 `audio-tool`（现有 `.cmd` 的 `$t` 是坏的，不要复制）。
- `scripts/build-cli-tools.ts`：`TOOLS` 增加 audio-tool（external `sherpa-onnx-node`）；新增 `stageSherpa()` 把 `sherpa-onnx-node` 与 `sherpa-onnx-{darwin|win|linux}-${arch}` 复制到 `dist/node_modules`；新增把 `apps/electron/resources/models` 复制到 `dist/models`（缺失记 warning）；`--check` 一并校验。
- `apps/electron/scripts/lib/check-assets.ts`：加必需项 `cli-tools/audio-tool.mjs`（hint `bun run build:cli-tools`），VAD 仍为可选。
- `apps/electron/electron-builder.yml`：`files` 增加 `resources/bin/audio-tool` 与 `audio-tool.cmd`（`resources/cli-tools/**` 已覆盖 dist）。
- `apps/electron/resources/permissions/default.json`：放行 `^audio-tool\s+(models|config|transcribe)\b` 与裸调用。
- `scripts/build-server.ts`：确认 cli-tools 的 sherpa 包与服务端 `node_modules` 不重复（照 sharp 的处理）。
- `apps/electron/resources/release-notes/next.md`：加一条说明。

## 四、RPC 与服务端

- `packages/shared/src/protocol/channels.ts`：新增 `asr` 命名空间 —— `CONFIG: 'asr:config'`、`CONFIG_SAVE: 'asr:config:save'`、`MODELS: 'asr:models'`、`TRANSCRIBE: 'asr:transcribe'`；删除 `media.TRANSCRIBE`。
- 新建 `packages/server-core/src/handlers/rpc/asr.ts`，在 `handlers/rpc/index.ts` 注册：
  - `asr:config` → `{ config, path, problem? }`。
  - `asr:config:save` → `{ ok, message? }`；保存前 `asrConfigProblem` 只做「字段完整性」校验，模型缺失作为提示而不是拒绝（用户可能还没放模型）。
  - `asr:models` → `{ models, vad, root }`（`localSherpaModels()` + `localSherpaVadModel()`）。
  - `asr:transcribe` → `validateFilePath` 后 spawn `audio-tool transcribe <path> --json`，解析 stdout 返回 `{ ok, text?, srt?, model?, message? }`；超时杀子进程。不调用同步 N-API。
- 新建 `packages/server-core/src/services/cli-tool.ts`：解析 `CRAFT_CLI_TOOLS` → `getBundledAssetsDir('cli-tools/dist')`，Bun 用 `CRAFT_BUN`（desktop 启动时已设）或 `process.execPath`（server 就是 bun），找不到时给出「运行 bun run build:cli-tools」的可读错误。
- `apps/electron/src/transport/channel-map.ts`：删 `mediaTranscribe`，加 4 个 asr invoke；`apps/electron/src/shared/types.ts` 同步替换（约 825-847 与 kind 联合类型）；之后跑 `bun scripts/refresh-channel-inventory.ts`。
- `apps/electron/src/renderer/components/canvas/CanvasWorkspace.tsx`（924-979）：转写按钮改调 `asrTranscribe`，注释同步。

## 五、UI（并入 AI 设置页）

新建 `apps/electron/src/renderer/components/settings/AsrSection.tsx`，在 `AiSettingsPage.tsx` 里 `<MediaChannelsSection />` 之后渲染，复用 `SettingsSection` / `SettingsCard` / `Input` / `Button` / `toast`：

- 模型目录输入（占位 `~/.craft-agent/models`）+「刷新」，模型下拉（`asr:models` 返回的 id/family），语言下拉（auto/zh/en/ja/ko/yue）。
- 一行状态：找到几个模型、VAD 是否可用；没有模型时给出放置目录的说明。
- 保存调 `asr:config:save`，成功后 toast 并回读。
- `MediaChannelsSection.tsx`：删除 `Kind` 里的 transcribe、`KIND_ORDER`/`KIND_LABEL` 的转写项、本地引擎特判（约 600-607、685、1196-1234）。
- i18n：7 个 `locales/*.json` 增加排序后的 `asr.*` 键（title/description/modelDir/models/language/vadReady/vadMissing/noModels/save/saved/…），删除 `mediaChannels.kindTranscribe` 与 `mediaChannels.localSherpaHint`。de/es/hu/ja/pl 现有的 `mediaChannels.*` 缺口属既有问题，本次不修，但新键必须 7 份齐全且排序正确。

## 六、测试

- 改写：`media-commands.test.ts`（删转写用例，断言 `transcribe` 现在是未知命令且提示里不提 audio-tool）、`tool-brief.test.ts`、`channels.test.ts`（读取丢弃 transcribe 端点）、`presets.test.ts`、`model-catalog.test.ts`、`creations.test.ts`、`record-commands.test.ts`（提示改为 audio-tool）、`tool-description-budget.test.ts`、`apps/electron/src/shared/__tests__/ipc-channels.test.ts`（重新生成）。
- 删除：`api-transcribe.test.ts`。
- 新增：`media/__tests__/asr-config.test.ts`（规范化/问题描述/迁移）。
- 保留并复用：`local-sherpa.test.ts`。

## 七、验证

1. `bun run fetch:sherpa-vad && bun run build:cli-tools`，再跑 `bun scripts/build-cli-tools.ts --check`。
2. 用 Memo 的 SenseVoice 模型（`%APPDATA%\Memo\models`）：
   - `resources\bin\audio-tool.cmd models --json`
   - `resources\bin\audio-tool.cmd transcribe <wav> --json` → `vad: true`、segments 时间正确
   - `... transcribe <wav> --out out.srt --format srt`
3. `bun test packages/shared/src/media packages/shared/src/agent`；`tsc --noEmit`（shared / server-core / apps/electron）；改动文件 eslint。
4. 运行应用：AI 设置页保存模型目录/语言 → 重启仍生效；画布录音卡转写生成文本节点，转写期间界面不卡；agent 调 `media_tool transcribe` 只得到未知命令，调 `audio-tool` 成功。
5. 打包检查：`cli-tools/dist/{audio-tool.mjs,node_modules/sherpa-onnx-*,models/silero_vad.onnx}` 存在。

## 风险

- **sherpa 原生包解析**：bundle external 后必须能从 `dist/node_modules/sherpa-onnx-<plat>-<arch>` 解析到 `.node`；平台包名 win/darwin/linux 与 arch 要对。`--check` 只保证文件在，需实跑一次。
- **一次迁移**：`asr.json` 一旦存在就不再回看 `media-channels.json`，迁移失败不能写 asr.json。
- **类型收窄**：`MediaChannelKind` 变窄会让所有转写分支编译失败（有意为之），按阶段 2 一次改完再跑 tsc。
- **CLI 冷启动**：每次 spawn 重新加载模型（秒级）；画布短音频可接受，长音频不再阻塞主进程。
- **删除云端实现**：`api-transcribe.ts` 及其测试本期删除，云端回归时从 git 历史恢复；如果希望保留，请在实施前说明。
