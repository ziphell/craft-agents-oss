# Python 文档工具 vs GenOffice：还要不要留 python

2026-10-29。探针全部只读：`~/code/craft-agents-oss`（工作区有未提交改动）。行号指该 checkout。

## 0. 一句话

**能解除，而且大多不需要 GenOffice 帮忙** —— 8 个 python CLI 里只有 3 个（docx/xlsx/pptx-tool）
是被 GenOffice 直接顶掉的；`ical-tool`、`doc-diff`、`img-tool` 跟 GenOffice 无关，替代品早就装在仓库里了；
`markitdown` 和 `pdf-tool` 是真正需要逐个命令对账的两个。
但**触发点不是文档工具**：只要 `transform_data` / `script_sandbox` / automations
还留着 `python3` 这个选项，那 62MB 的 uv 就一天都不能拆。

## 0.1 复核（2026-10-29 20:00，`office_tool` 更新后）

工具在 2 小时内换了一版：`docx_tool` → **`office_tool`**（`packages/shared/src/agent/office-{commands,tools}.ts`）+ 新增
`apps/electron/src/main/office-guard.ts` 与 `packages/shared/src/office/disk.ts`。**实跑验证**（用仓库里已构建的
`resources/cli/genoffice.cjs`，夹具在 `sessions/261029-quiet-raven/data/`）：

**变强的三件事**

1. **`apply` 现在按扩展名分派 docs / sheet / slides**（`office-commands.ts:220-233`）——不再是只会改 docx。
   
   实测通过：`create --type xlsx --from t.csv --out w.xlsx --header` → `sheet apply` 一次批次三条 op
   （`set_cell` / `format_range` 加粗+填充 / `add_sheet`）→ `3 of 3 ops applied`，`sheet read` 读回 `999` 与新表。
   `guide sheets` 的 op 表是 openpyxl 那套的**超集**（set_range/copy_range/move_range/sort_range/convert_to_values/
   conditional format/data validation/col width/insert_rows/add|rename|delete_sheet…）。
2. **`read` 统一走 `info`**，工作簿返回 sheet 名/used range/冻结窗格/筛选/条件格式计数，deck 返回 slide 与文本元素。
3. **并发保存守卫（新，且是我们最需要的那块）**：`office-guard.ts` 在 `file:readBinary` 时记下 mtime+size+SHA-256，
   保存时用 `saveVerdict()` 比对；不一致就**拒绝写入并报路径**。注释点明动机就是这个工具本身：
   “the case that made this necessary — the agent … a person's save after an agent edit used to replace the agent's work”。
   也就是说，把 python 写入器退休的前提（“agent 与编辑器同时改一个文件不能互相静默覆盖”）**已经补上了**。

**同时暴露/仍然存在的洞口（都实测过）**

| 洞口 | 证据 |
| --- | --- |
| **`create --type xlsx/pptx` 的文档承诺不成立** | 指南与工具描述都写 `create table.md ... --type xlsx` / `create outline.md ... --type pptx`；实测：xlsx 要 `--from .csv|.json`（`createXlsx` 明确 `xlsx needs --from <data.csv|table.json>`，传 md → “not valid JSON”），pptx 要 `--ops/--spec`（传 md → “missing --ops”）。**md→工作簿/幻灯片没有路径**（`convert` 的 md 路由只有 docx/html/pdf） |
| **指南里 `guide sheet` 是错的** | CLI 要 `guide sheets`（复数）；`office_tool` 的帮助文本仍写 `guide [docs|sheet|slides]` |
| **convert 丢掉 `--sheet` / `--force` / `--password`** | CLI 的 convert 声明了 `--sheet`（实测 `--sheet 汇总` 生效），但 `office-commands.ts` 只转发 file/--to/--out → 用户写的 `--sheet` 被静默忽略，导出了活动表 |
| **打包后 office_tool 找不到 xlsx sidecar** | `office-commands.ts:90` 只从 `process.cwd()` 找 `resources/office-native/xlsx-sidecar.exe`，**没有 `process.resourcesPath` 候选**（同文件 `pdfiumWasmPath()` 有）。agent 子进程的 cwd 是会话目录 ⇒ 正式包里 `read/apply` 工作簿预计报 “xlsx engine (xlsx-sidecar) not found”。本机验证：只有设了 `XLSX_SIDECAR_PATH` 才通 |
| **hub 上仍无 office** | `Dockerfile.server` 仍未拷 `resources/{office,office-engine,office-native,cli}` ⇒ `office_tool` 只说 “engine is not installed”；`--to pdf` 按名字拒绝（这条是设计）；且 **hub 没有保存守卫**（`server-core` 里 `checkDocument/saveVerdict` 无命中） |
| **两套并存没动** | `system.ts:951` 照旧列八个 python CLI，`office_tool` 另开一段 |

**对上一版结论的影响**：

- “P0 撤 docx/xlsx/pptx 三个 CLI”要**改写**：`docx-tool` 可以立刻撤（md→docx ✅ 实测）；`xlsx-tool` 的读/单格写/加表/导出
  都已被覆盖，只差“**md 表 → 工作簿**”这一个入口；`pptx-tool` 的 `create`（markdown 分页）**仍无等价**，ops JSON 是更高门槛的
  替代（`--spec` 那套设计工作流 `office_tool` 还够不到）。
- 好消息里最值钱的是**守卫**，不是命令数：它把“python 写入器与编辑器抢文件”这个真实事故源先关掉了。
- 上一版把 `read --json` 当已成事实是对的（全局 `--json` 存在，实测输出 JSON）。

## 0.2 命令面完整性（对照 GenOffice 官方 CLI 与 MCP，2026-10-29 20:0x）

对照两份一手材料：`genoffice help`（**19 个命令**）与 `packages/cli/src/mcp/tools.ts`(28) + `mcp/deck.ts`(4)
（**32 个 MCP 工具**，这份是 GenOffice 自己认为的 agent 面）。夹具在
`sessions/261029-quiet-raven/data/`，下列带 ✅ 的都是实跑。

### office_tool 现在只有 5 条

| 命令 | 映射到 | 丢掉的东西 |
| --- | --- | --- |
| `create` | `create --type X --from <path> --out` | `--header`/`--decimal`；`--ops`/`--spec`/`--outline`（⇒ **pptx 根本进不去**）；`--render`/`--audit`；`--type pdf` |
| `read` | `info <file> [--json]` | **用错了命令**（见下）；`--range/--full/--max-chars`（docs）· `--stats/--formats/--where/--cols/--sheet`（sheet）· `--layouts/--units/--slide`（slides）· `--comments/--revisions/--styles/--fields/--notes/--sections/--header-footer/--properties`（docs） |
| `apply` | `<domain> apply --ops [--dry-run]` | `--track`/`--author`（**修订模式**）、`--out`/`--force`、`--best-effort`/`--stop-on-error`、`--isolation`、`sheet --cells` |
| `convert` | `convert --to [--out]` | `--sheet`/`--force`/`--password` |
| `guide` | `guide <arg>` | 帮助文本写 `sheet`，CLI 要 `sheets` |

### 缺的命令（按对 agent 的价值排序，均已实测可用）

1. **`read` 应该分域，而不是 `info`**（最严重）。`info t.docx --json` 只给 `blocks:4 / block_types / headings`；
   `docs read t.docx --json` 才给 `items:[{index:0,type:'heading',text:'Q3'}, {index:1,type:'table'}, …]` —— 
   **apply 的 blockIndexes 只能从后者得到**。指南却写“索引从这里来”，结果是模型拿不到索引、只能猜。
   sheet 同理：`info` 给“2 sheets / 3 rows”，`sheet read` 才给 `rows`/`formulas`/冻结/筛选/条件格式。
2. **`merge <tpl.docx|pptx|xlsx> --data <json> --out [--strict]`** ✅ —— `{{key}}` 占位符填充，实测 `2 placeholders filled, 0 unresolved`，
   嵌套对象展平成 `a.b`，结果带 `used_keys/unused_keys/unresolved_placeholders`。这是 python `docx-tool template` 的唯一直系替代（而且 pptx/xlsx 也吃）。
3. **`docs compare <a> <b> --out <redline.docx>`** ✅ —— 产出带 revisions 的**红线 Word**（实测 `2 insertions, 3 deletions`），
   支持 `--granularity word|char`、`--ignore formatting,case,whitespace`。python `doc-diff` 只出文本 diff，这里是严格升级。
   注：连官方 MCP 都没暴露它（只 CLI 有）。
4. **`pdf read <file> [--page|--range] [--password] [--full|--max-chars]`** ✅ —— pdfium 读文本层、**不要 app 进程**；
   实测加密文件会正确地答 `the PDF is encrypted` + `pass --password`。它就是 python `pdf-tool extract/info` 的直系替代。
   代价为零：`cliEnv()` 已经设了 `GENOFFICE_PDFIUM_WASM`。
5. **`render <file> --out <dir> [--page] [--scale] [--grid]` / `slides render`** —— 每页 PNG，让 agent 自己看。
   实现上要 `office_tools.ts` 从“只返文本”改成“返路径（或图片）”；便宜做法是先回 `out/*.png` 的绝对路径。
6. **deck 创建的双通道**：短 deck = `create --type pptx --ops|--spec`，长 deck = MCP 的 `deck_start → deck_page → deck_build`
   （每页 spec 都对着 outline 与 style.md 校验，失败不落盘）。**现在两条都进不去**，所以 “pptx-tool.create 无等价” 的真正解法
   不是把 md 分页模拟一遍，而是把 `--ops`/`--spec` 透出去 + 加一个 deck_start/page/build 的门。
7. **体检类**：`docs check` / `sheet check`（未求值域、坏引用、过期 TOC、公式错误、数字溢出）；
   `slides audit`（溢出/越界/重叠/拉伸，附建议 `setTransform`）；`slides check`（outline 与 page spec 一致性）。
8. **非 office 的 7 个不要接**：`open`/`selection`（要 GUI，App 自己的 UI 已覆盖）、`search`/`image`/`media`（要 AI provider）、
   `capabilities`（低价值）、`install-cli`/`mcp`/`skill`（隷主自管）。

### 另三个实现口径问题（新发现）

- `apply` 的域判定只看 `.xlsx`/`.pptx`（`office-commands.ts:222`），其余一律当 `docs` ⇒ **`.ods`/`.xlsb`/`.xls`/`.ppt`/`.odp` 全错**，
  而这些格式 GenOffice 的 read/convert 是认的（`info.ts` 的 switch 列了 ods/xlsm/xls/xlsb）。
- `read --json` 的 `--json` 能通，是因为 CLI 的**全局** `--json`；但 `office_tool` 对 `apply`/`convert` 从不传它，
  所以模型拿到的是人读摘要而不是机器可读的 `detail`（如 `batch: 3 of 3`、`unresolved_placeholders` 的结构）。
- `help()` 是**手写的第二份真话**（已经写错 `guide sheet`）。以 CLI 的 `--help`/`genoffice help <cmd>` 生成字符串，
  漂移就只可能出现在一处。

### 建议的最终命令面（一个工具，10 条）

```
office_tool create  <src> --out <f> [--type docx|xlsx|pptx] [--force] [--ops <f>|--spec <f>] [--template <f>]
office_tool read    <f> [--json] [--range a-b] [--full] [--sheet <n>] [--slide <n>] [--revisions] [--comments] [--stats] [--formats]
office_tool apply   <f> --ops <f> [--dry-run] [--track] [--author <n>] [--out <p>] [--best-effort]
office_tool merge   <tpl> --data <json> --out <f> [--strict]
office_tool compare <a> <b> --out <redline.docx> [--granularity word|char]
office_tool convert <f> --to <t> [--out <p>] [--sheet <n>] [--password <pw>]
office_tool pdf     <f> [--page n|--range a-b] [--password <pw>] [--full]
office_tool render  <f> --out <dir> [--page n] [--scale n]
office_tool check   <f> [--audit]          # docs/sheet check；pptx 走 slides audit
office_tool guide   docs|sheets|slides[ spec|design]
```

成本（都是 argv 映射，不是新引擎）：read 分域开 | create 补 ops/spec +2 | merge、pdf、compare、check、render 各开一个 case
（每个 10-30 行）| `--track/--author/--out` 透传 +3。真正的工程只有两块：**md → 工作簿/幻灯片的分页转换**
（40–80 行）与 **deck_start/page/build 的状态流程**（可暂不做）。

## 0.3 重估（2026-10-29 21:50 · office_tool 扩容之后 + bun 实测）

`office_tool` 从 5 条命令长到 10 条（加四步 deck 流程），并且刚做了三组实验。结论比上一版**简单得多**：
不必把每个 python 工具迁到新工具上，**大部分可以直接删，剩下的换实现语言即可**。

### 实测：三个“硬替代品”在 bun 下都成立

| 实验 | 结果 |
| --- | --- |
| `bun` + `markitdown-js` 转 docx | ✅ 出 md（但**表格散成一行一格**，质量不如 GenOffice 的 convert） |
| `bun` + `sharp` 缩图 | ✅ 1191×1684 → 320 px，2530 B |
| `bun` 跑整个 `genoffice.cjs`（含 `pdfium.wasm` 渲染 PDF） | ✅ 1 页 PNG，`via: pdfium` |

⇒ “把 CLI 的实现从 python 换成 bun、名字和包装器不动”是**已被证明的路径**，不是设想。
而且 hub 镜像本来就是 bun（`oven/bun:1.3-slim`），这些 CLI 换过去之后**在 hub 上也活了**（今天它们是桌面专属）。

### 覆盖矩阵（全部经今天实跑）

| python 命令 | 现在 | 差距 |
| --- | --- | --- |
| `docx-tool create/info/extract` | `office_tool create/read` | 无 |
| `docx-tool replace` | `apply findReplace` | 无 |
| `docx-tool template` | **`merge`**（同一件事：`{{key}}` 段落/表格/页眉页脚，`docx_tool.py:template`；merge 还报 unresolved、支持 pptx/xlsx） | 无 |
| `xlsx-tool read/info/export` | `sheet read` / `convert --to csv` | 无 |
| `xlsx-tool write/add-sheet` | `sheet apply`（实测 3/3 op） | 无 |
| `pptx-tool create`（md 分页） | **`deck_start/page/build`** 或 `create --ops` | 更好（逐页校验） |
| `pptx-tool info/extract` | `slides read --full` | 无 |
| `doc-diff`（任意两文档） | **`compare`**（docx 红线 Word） | 非 docx 的跨格式文本对比没了 |
| `markitdown`（27 后缀） | markitdown-js（已在生产）/ `convert --to md` / `read` | docx 表格质量（见上）；冷门格式只能靠 markitdown-js |
| `pdf-tool extract/info` | `pdf read` / `info` | 无 |
| `pdf-tool to-image` | `render` | 更好（`--grid`/`--el`） |
| `pdf-tool` 其余 16 条 | **agent 侧无等价物**（引擎有能力，但只暴露了 `savePdfToPath` + `loadPdfium`，见 `office-engine/pdf.d.ts`） | 真损失面：merge/split/reorder/rotate/watermark/header-footer/flatten/compress/redact/crop/resize/from-image/fill-form/encrypt/decrypt |
| `img-tool` (7) | 无入口 | sharp 可用，缺一个家 |
| `ical-tool` (3) | 无入口 | ical.js 可换 |

### 两个“移除”必须分开决策

- **移除工具**（8 个 CLI）：省 3580 行 python + 659 行测试 + 16 个包装器 + 8 条权限 + 2 行提示，
  另外顺带掉一个 Windows 弹窗 —— `checkVCRedistInstalled` 存在的唯一理由是 python markitdown 的
  magika/onnxruntime（`server-core/src/services/vcredist.ts`）。
- **移除运行时**（uv 62 MB/平台、首次联网、本机 cache 5.7 GB）：只有 `python3` 那 2 处
  （`tool-defs.ts:170,177`、`automations/schemas.ts:78`）也放弃才会发生。删 CLI 一个字节都不省。

### 四步

1. **删冗余的四个 CLI**：`docx-tool` / `xlsx-tool` / `pptx-tool` / `doc-diff`。
   纯删除（1129 行 python + 4 套 smoke + 4 条权限 pattern + 提示一句），1 小时，风险低。
   唯一代价：`doc-diff` 的跨格式对比（替代：两边 `convert --to md` 后自己比，或留在第 3 步一起换）。
2. **换语言，不换名字**：`markitdown` → bun + markitdown-js（已是依赖、已在生产）；
   `img-tool` → bun + sharp；`ical-tool` → bun + ical.js。包装器一行改 `$CRAFT_BUN run x.ts`。
   提示、权限、`--help`、agent 行为零变化；hub 顺带可用。1–2 天，机制性工作。
3. **pdf-tool 二分**：已覆盖的 6 条（extract/info/to-image/to-docx/to-pptx/xlsx/md）直接删；
   留下的编辑类命令用 bun + pdfium wasm 重写（今天已证明能跑），或逐条升格成 `office_tool pdf` 的子命令。
   **`encrypt` 是唯一真缺口**（pdfium 只读加密、pdf-lib 不写加密）—— 要么引 muhammara/qpdf，要么去掉这条命令。
4. **撤运行时**：8 个包装器、`resources/scripts/*.py`、`bin/<platform>/uv`、`electron-builder.yml:40-55`
   的 allowlist、`package.json:44` 的 `test:doc-tools`、`scripts/build-server.ts` 的 uv 下载、
   `resolve-script-runtime.ts` 的 python3 分支、`sandbox-env.ts` 的 uv cache 分支，
   以及 `transform_data`/`script_sandbox` 的默认语言（文档 6 处示例）。
   python3 枚举建议**不删**，改成“宿主有 python 才可用”，并在文档里写清。

### 一句话

先删（第 1 步），再换语言（第 2 步），最后才谈 uv（第 4 步）；PDF 的编辑类命令是唯一需要真工程的一块，
而其 16 条里 agent 日常会用的不到一半。

## 1. python 到底在哪儿

两处，都在 `apps/electron/resources/scripts/`（34 个 .py 全在这个目录树内，含 release 拷贝）：

### 1.1 八个 CLI（bash 工具，uv + PEP 723 内联依赖）

| 工具 | 行数 | 依赖 | 命令数 |
| --- | --- | --- | --- |
| `pdf-tool` | 1321 | pypdfium2, pypdf, img2pdf, Pillow, python-pptx, python-docx | **22** |
| `docx-tool` | 390 | python-docx | 5 |
| `xlsx-tool` | 375 | openpyxl | 5 |
| `ical-tool` | 372 | icalendar, python-dateutil | 3 |
| `img-tool` | 370 | Pillow | 7 |
| `pptx-tool` | 364 | python-pptx | 3 |
| `doc-diff` | 251 | markitdown, python-docx, diff-match-patch | 1 |
| `markitdown` | 137 | markitdown[pdf,pptx,docx,xlsx], python-docx | 1 |
| 合计 | **3580** + 659 行测试 | — | 47 |

包装器是 8 个 `bin/*`（`sh`）+ 8 个 `bin/*.cmd`，本体都是
`exec "$CRAFT_UV" run --python 3.12 "$CRAFT_SCRIPTS/<x>.py"`。

### 1.2 `python3` 作为脚本运行时（2 处 schema）

- `packages/session-tools-core/src/tool-defs.ts:170,177` —— `transform_data` / `script_sandbox`
- `packages/shared/src/automations/schemas.ts:78` + `automations/types.ts:103` —— automation 的 script 动作

运行时解析在 `packages/session-tools-core/src/runtime/resolve-script-runtime.ts:181`（env → 打包的 uv → PATH）。
`resources/docs/data-tables.md`、`html-preview.md` 的示例**都写成 `language: "python3"`**（各 3 处），
也就是说文档在教模型选 python。

## 2. 这笔账值多少钱

| 项 | 实测 |
| --- | --- |
| `bin/win32-x64/uv.exe` | **64,598,016 B ≈ 62 MB**（每个平台一份） |
| 首次调用 | `apps/electron/src/main/index.ts:180` 自己写着 “uv auto-downloads Python 3.12 on first use (~5s, then cached)” —— **打包应用第一次跑文档工具要联网** |
| 本机 uv cache | `/c/Users/Ryan/AppData/Local/uv` = **5.7 GB**，其中 `cache/archive-v0` 5.5 GB |
| 每次调用开销 | 实测：新环境 `uv run` **3.9 s**，同环境热调 **0.40 s**（`uv` 自身 ~0.05 s，其余是解释器+import） |
| hub | `Dockerfile.server` 是 `oven/bun:1.3-slim`，拷 resources 时**只拷 docs/themes/permissions/tool-icons/release-notes + drawio**，没有 uv、没有 python、也没有 office；而 `scripts/build-server.ts:211-249` 的服务器分发**会下载 uv 到 `resources/bin/uv`** → 两种分发对同一件事给出相反答案 |

第二件事比体积重要：**在 WebUI 会话里这 8 个 CLI 现在是不可用的**（server-core 不注入 `CRAFT_UV`／
`CRAFT_SCRIPTS`／PATH，grep 无命中；`resolveScriptRuntime('python3')` 在无 `CRAFT_UV` 时直接抛错）。
而新工具 `docx_tool` 的注释明确写着它 “works on a hub where no browser runs”
（`packages/shared/src/agent/docx-tools.ts`）—— 这已经不是"要不要留"的问题，是"它还活在哪儿"的问题。

## 3. 而且现在有两套

`packages/shared/src/prompts/system.ts:951` 仍在介绍八个 CLI；同一份提示另有 `office_tool`
（`office-tools.ts` / `office-commands.ts`，走 `resources/cli/genoffice.cjs`，需先读 `office-tools.md`）。
两边能力重叠：

| 想要 | `office_tool`（GenOffice） | python CLI |
| --- | --- | --- |
| 造 docx/xlsx/pptx | `create <md> --out x --type` | `docx-tool create` / `xlsx-tool write` / `pptx-tool create` |
| 读内容 | `read <file> [--json]` | `*-tool info/extract` |
| 改内容 | `apply --ops` | `docx-tool replace` |
| 转格式 | `convert --to pdf/docx/xlsx/pptx/md/html/csv` | `markitdown` + `pdf-tool to-*` |

模型面前摆两条路，是漂移的源头，也是"重复维护两份 OOXML 写入器"的源头。**P0 该解决的正是这个，
不是 python。**

## 4. 逐工具对账：谁顶谁

替代品的现状（都已在本仓库里，不是"可以引入"的假设）：

- **markitdown-js** 已在生产：`packages/server-core/src/handlers/rpc/files.ts:447` 用它把 Office 附件转 md。
  它的传递依赖覆盖 mammoth(docx) / xlsx(sheetjs) / node-pptx-parser / pdf-parse / turndown(html) / msgreader。
- **sharp** 已在生产：`packages/server-core/src/runtime/platform-headless.ts:56-62`（metadata + resize + format）；
  `scripts/build-server.ts:433` 已按平台打 `@img/sharp-*`（win32-x64 约 19 MB，**已经是付过的账**）。
- **pdfium.wasm** 已在包里：`resources/office-engine/node_modules/@embedpdf/pdfium/dist/pdfium.wasm`，
  `build-office-assets.ts` 的 `--check` 明说没有它 “redaction and text surgery would silently refuse”。
- **GenOffice CLI 的 convert** 是纯 Node，不是渲染器：`genoffice/packages/cli/src/commands/convert.ts`
  里 `docx → md` 走 `openDocument → documentHtml → htmlToMarkdown`，`pdf → docx|xlsx|pptx|md` 走 pdfium，
  `md → docx|html` 走编辑器模型。只有 `md → pdf` 才需要 `--headless-export`（要真 app 进程）。

| python 工具 | 覆盖情况 | 替代 | 剩下的差距 |
| --- | --- | --- | --- |
| `docx-tool` (5) | 全部，已实测 | `office_tool create/read/apply`（md→docx ✅ 实测） | `template` 的占位符语义要补一个 ops；无实质缺口 → **可撤** |
| `xlsx-tool` (5) | 读/写/加表/导出全中 | `sheet read` + `sheet apply`（op 是超集，已实测 3/3） | **md 表 → 工作簿没有入口**（要 csv/json）；`read` 依赖 sidecar，而 office_tool 的 sidecar 路径在正式包里找不到 |
| `pptx-tool` (3) | 读/信息已中 | `office_tool read` + `slides apply`（op 是超集） | **`create`（markdown 按 `---` 分页）无等价**：`create --type pptx` 要 `--ops`/`--spec` |
| `ical-tool` (3) | — | **纯 JS**：ical.js / node-ical + date-fns（已是依赖） | 无（RRULE 只是原样透传字符串，`ical_tool.py:102`） |
| `img-tool` (7) | — | **sharp**（原生，已在跑） | 只需要把 resize/crop/rotate/convert/info/watermark/composite 逐条映射；字体水印要自带字体文件 |
| `doc-diff` (1) | — | diff-match-patch 的**官方实现就是 JS** + markitdown-js/GenOffice convert | 无 |
| `markitdown` (1) | 部分 | markitdown-js（已在生产）+ `docx_tool convert --to md` | 通用面：ipynb / rss / atom / zip / msg / eml / rtf / 音视频元数据 —— markitdown-js 覆盖 msg/zip/html，其余要自己写或砍；pdf 文本质量 pdf.js 系 < pdfminer |
| `pdf-tool` (22) | 大部分 | pdfium.wasm 已在包内；GenOffice `pdf.cjs` 已覆盖 annotation/form/page/text + `to-docx/xlsx/pptx/md` | **`encrypt` 写加密**（见 §5.1）；`redact` 现在是整页栅格化（`pdf_tool.py:1082-1125`），pdfium 可照做，保真同档不变差；`compress` 只是 `compress_content_streams`，pdf-lib/引擎本就会做 |

结论：**47 个命令里 40 个有等价物，7 个需要真写一写（img 的水印/合成、markitdown 的冷门格式、pdf 的 encrypt/sanitize）**。

## 5. 三个硬点（别踩）

### 5.1 `pdf-tool encrypt` 是唯一没有等价物的一条

`pypdf` 的 `writer.encrypt(user_password=..., owner_password=...)`（`pdf_tool.py:983-995`）。
PDFium 只能**读**加密（打开时要密码），不能**写**；`pdf-lib` 根本不支持加密。
真要做只有三条：muhammara（原生 C++，Apache-2.0）、qpdf 的 wasm 构建、或者留着这一条原生。
**建议：这一条不阻塞整条迁移**，先把它标成"未替代"，其余 21 条先迁；为一条命令引一个原生模块是明显的价值倒挂。

### 5.2 `markitdown` 的"通用"不是 Office

它支持 27 个后缀（`markitdown_cli.py` 的 `SUPPORTED_EXTENSIONS`：docx/xlsx/pptx/pdf/html/ipynb/xml/
rss/atom/zip/msg/eml/csv/tsv/json/txt/md/rst/rtf/jpg/png/gif/bmp/tiff/wav/mp3）。
GenOffice 只管四件办公件；markitdown-js 覆盖的是同一个集合的一个子集。
所以"用 GenOffice 换掉 markitdown"是错的映射 —— 该换的是 **markitdown-js**，GenOffice 只在 docx/pdf→md 上做加强。
注意 `markitdown-js` 是 `0.0.14`（vendor 自一个第三方对 MS 库的 JS 复刻），已经在生产路径上，
但**不建议把它当成"删掉 python 版"的唯一保证**：两者并存一段时间，用同一批夹具对比输出再取舍。

### 5.3 `python3` 是用户脚本的契约，不是内部实现

automations 的 script 动作、`transform_data`/`script_sandbox` 都把它摆在枚举里，
用户可能已经写了几十个 `.py`。删枚举 = 静默报废别人的工作流。
正确做法是**二选一**：
- 保留枚举，但打包时不带 uv，运行到 python3 时给出**明确**的一句 "this build ships no Python runtime; use bun or node"（现在会抛 `Python runtime unavailable in packaged app: uv was not found…`，已经是句话，但枚举还在引导人去用）；
- 或把**默认**从 python3 改成 bun（文档 6 处示例一起改），python3 仅"宿主有 python 时才可用"。

## 6. 建议路线

### P0 · 去重（零风险，先做）

**先做三件互不依赖的小事，再做撤并**（它们决定“能不能撤”）：

1. **修 `create` 的承诺**：两种选择——① 在 `office-commands.ts` 里自己把首个 Markdown 表格转成 CSV 临时文件再调
   `create --from`（约 40 行，立刻兑现 `--type xlsx`）；md→pptx 则把 `---` 分页拆成 `addBlankSlide` + `addElement`
   的 ops（对照 python `pptx_tool.create` 的语义，约 60 行）。② 或**把文档改正**：`--type` 只对 docx 生效，
   xlsx 用 `--from .csv/.json`、pptx 用 `--ops/--spec`，并把 `office-tools.md` 里那两行会报错的示例换掉。
   ②是一小时的事，①才是把 `xlsx-tool`/`pptx-tool` 真正退休。
2. **修 `office_tool` 的 sidecar 解析**：给 `office-commands.ts:90` 加 `process.resourcesPath` 候选
   （照同文件 `pdfiumWasmPath()` 的写法），否则正式包里工作簿读写的“已覆盖”只是纸面。
3. **修 `convert` 的转发**：`--sheet` / `--force` / `--password` 原样透传（CLI 都支持），并把帮助里的
   `guide [docs|sheet|slides]` 改成 `sheets`。

然后才撤并：

- **`docx-tool` 立刻撤**（md→docx 实测可用，能力完全被 `office_tool` 覆盖）；
- `xlsx-tool` 在 ①② 之后撤（读/单格写/加表/导出已覆盖，只差 md 入口与 sidecar）；
- `pptx-tool` 在 `create` 的 md 分页路径补上之后撤，否则先只把 `info/extract` 撤掉、`create` 留着。

- `prompts/system.ts:951` 那句改成只列仍存在的 CLI，并把文档创建/修改指向 `office_tool`；
- `permissions/default.json:69-101` 删对应读权限 pattern；
- 删对应 `bin/*`、`.cmd`、`.py`、smoke；`electron-builder.yml:40-55` 的 allowlist 同步。

验收：`grep -r "docx-tool\|xlsx-tool\|pptx-tool"` 只剩 release-notes 里的历史条目；
且 `office_tool create x.md --type xlsx|pptx` 在打包构建里成功（不是只在 dev 里）。

### P1 · 换实现（低风险，逐个上）

1. `ical-tool` → 纯 JS（ical.js / node-ical + date-fns）。零原生、hub 可用。
2. `doc-diff` → diff-match-patch（JS 原版）+ markitdown-js / `office_tool convert --to md`。
3. `img-tool` → sharp。7 条命令逐一映射，`info` 用 `metadata()`（EXIF 已含）；顺手把
   `server-core/services/image-utils.ts` 与它合并，别留两套 resize 参数。
4. `markitdown` → markitdown-js 为默认，`office_tool convert --to md` 兜 docx/pdf；
   冷门格式（ipynb/rss/atom/eml/rtf/音视频）先保留 python 版，或明说"不支持"。

每步的验收都该是**同一批夹具的字节/文本对比**（现有 659 行 python smoke 就是现成夹具来源），
而不是"能跑通"。P1 结束时 python 只剩 `pdf-tool`。

### P2 · 收口 pdf-tool，然后拆 uv

- `pdf-tool` 的 22 条拆成两半：**进 `office_tool` 的 GenOffice 侧**
  （extract/info/merge/split/rotate/reorder/duplicate/watermark/header-footer/fill-form/flatten/crop/
  resize/compress/sanitize/redact/to-image/from-image/to-docx/to-pptx = 20 条，pdfium + pdf-lib 够用），
  **留原生**的只有 `encrypt`（21 条里唯一真缺口）与 `decrypt` 若实现不了密码打开。
- 到这里 uv 才能删：`bin/<platform>-<arch>/uv`、`resources/scripts/`、8 个包装器、`electron-builder`
  的 allowlist、`resolve-script-runtime.ts` 的 python3 分支（改成"不提供"的一句人话）。
- 顺带把 `scripts/build-server.ts:211-249` 的 uv 下载删掉，服务器分发与 Docker 镜像终于一致。

### P3 ·（可选）运行时

`transform_data` 的**默认**改成 bun（文档 6 处示例 + `data-tables.md` 表格），`script_sandbox` 同理。
python3 留成"宿主有就用"，枚举不删。这一步可以永远不做 —— 它跟文档工具完全解耦。

## 7. 反建议

- **不要为了 62MB 先动 `pdf-tool`**：它是唯一没有等价物的一棵大树，先动它会把整件事拖死。
- **不要长期保留两套**（`office_tool` 与 3 个 CLI 并存"过渡"）：模型的选择漂移比体积贵得多。
- **不要把“命令存在”当“能力覆盖”**：这次更新就是例证 —— `--type xlsx|pptx` 在帮助里写着，实测两条路都不通；
  任何“已替代”的结论都必须在打包构建里跑一次，而不是读文档。
  这一条是 P0 存在的全部理由。
- **不要试图把 python 搬上 hub**：`Dockerfile.server` 是 bun-slim，加 python 等于给镜像加最重的一层，
  而 `docx_tool` 已经证明了"纯 Node 能出 Office 文件"。
- **不要把"集成了 GenOffice"当成"文档转换已解决"**：真正干活的是 CLI 的 `convert`（纯 Node），
  编辑器是给人看的；两者混为一谈会在 `md → pdf` 这种必须渲染器的路径上翻车（那条要 `--headless-export` + 真 app 进程，至今未端到端验证）。

## 8. 净回答

> 集成了 GenOffice 之后，docx/xlsx/pptx 三个 python 工具是**纯冗余**（已有更好的 `docx_tool`）；
> ical/doc-diff/img 三个跟 GenOffice 无关但**替代品零成本**（纯 JS 或已在跑的 sharp）；
> markitdown 与 pdf-tool 需要逐个命令对账，其中只有 PDF 的 `encrypt` 是真缺口。
> 所以"解除 python 依赖"是可行的，**但它是一个四步工程，不是一次删除**；
> 而且最后能不能真的拆掉 62MB 的 uv，取决于脚本运行时那 2 处 `python3`，不取决于文档工具。
