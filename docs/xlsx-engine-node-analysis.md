# xlsx 引擎能不能用 Node 实现

> 对象：`genoffice/apps/sheets/native/xlsx-engine`（Rust，产物 `xlsx-sidecar.exe`，8.8MB）
> 日期：2026-10-29

## 0. 结论

**能。但最省的办法不是"用 TS 重写"，而是把同一个 Rust 引擎编成 WASM 在 Node 里跑 —— 而且这份源码已经为这件事准备好了。**

三处硬证据（不是推测，是代码里的分支）：

```rust
// lib.rs:160 —— 明确写了 wasm32-wasip1 与"没有 cross-origin isolation 的浏览器"
pub const THREADS: bool = !cfg!(any(
    feature = "single-thread",
    all(target_family = "wasm", not(target_feature = "atomics"))
));

// lib.rs:174 —— std::env::temp_dir() 在 WASI 上 panic，这里专门绕开
fn temp_dir() -> PathBuf {
    if cfg!(target_os = "wasi") {
        std::env::var_os("TMPDIR").map_or_else(|| PathBuf::from("/tmp"), PathBuf::from)
    } else { std::env::temp_dir() }
}

// Cargo.toml:9 —— "Run indexing and recalc inline instead of on threads,
//                 as WebAssembly builds without threads must"
[features] single-thread = []
```

外加 `protocol.rs` 的一句注释：“such as a WebAssembly build driven from JavaScript.”

也就是说：**作者早就打算让这份引擎跑在 WASM 宿主里**，只是这个仓库里没有把 wasm 目标接进构建（没有 wasm-pack / 没有 .wasm 产物）。

## 1. 三条路线

| | 做法 | 保真度 | 工作量 | 平台矩阵 | 风险 |
| --- | --- | --- | --- | --- | --- |
| **A. 同一份 Rust → WASM** | `cargo build --target wasm32-wasip1 --features single-thread`，Node 用 `node:wasi` 驱动同一份 JSON 协议 | **100%** | 小（接线 + 验证） | **归零**（一份 .wasm 跨平台） | ironcalc/calamine/zip 在 wasi 下能否编过（待验） |
| **B. 用 TS 重写** | jszip + XML 层 + 公式引擎，复刻行为 | 需要长期追赶 | **≈18k 行生产代码** | 归零 | 详见 §2，这是重做产品，不是移植 |
| **C. 保持二进制 + child_process** | 现状：Node `spawn` 一个 stdin/stdout 的 sidecar | 100% | 0 | win/mac/linux × x64/arm64 | 已有（且已有崩溃恢复通道） |

Node 跑 C 是**现在就能做的**——我实测过：拿纳米 Work 里那份预编译 `xlsx-sidecar.exe` 直接喂协议，解析出了 `sheets:[{name:"Sales",rowCount:5,columnCount:4}]`。

## 2. 如果真要 TS 重写，钱花在哪（25,378 行的构成）

```
src/tests.rs          5063   测试（不计入移植）
src/visuals.rs        2236   ← OOXML 保真：图表/图片/形状/主题色
src/visuals/tests.rs  2195   测试
src/worksheet.rs      1641   ← 单元格/行/列/合并/条件格式的读写
src/visuals/drawing.rs 1168  ← DrawingML
src/recalc.rs         1135   ← 重算（真正干活的是 ironcalc）
src/visuals/charts.rs 1112   ← 图表
src/spreadsheetml.rs  1103   ← styles.xml / sharedStrings / 主题
src/protocol.rs        936   命令协议
src/types.rs           827   数据模型
src/table_styles.rs    819   ← 表格样式
src/workbook.rs        751   工作簿/定义名称/保护
src/find.rs            711   查找
src/archive.rs         699   ← zip 打包/写回（保未改条目）
src/convert.rs         538   格式转换
src/visuals/colors.rs  502   主题色
src/visuals/styles.rs  494   样式解析
src/shared_formulas.rs 424   共享公式
… odf / richdata / sparklines / refs / cell_images / xml_util …
```

分类：

- **保真写回（真成本）≈ 8k 行**：visuals + table_styles + spreadsheetml + worksheet + archive。这部分的每一行都对应“用 Excel 打开不报错、不丢图表/条件格式/数据透视”的实际事故。TS 能做到，但这正是 GenOffice 花最多时间的地方。
- **解析/查询 ≈ 4k 行**：workbook / find / convert / odf / richdata / shared_formulas。（其中解析今天靠 `calamine`；TS 侧要么自写，要么换 SheetJS —— 换就等于放弃保真。）
- **重算 1,135 行，但核心是第三方 crate `ironcalc`**（`use ironcalc::base::Model; use ironcalc::import::load_from_xlsx;`）。TS 重写时这一段没有对应物，只有替代品：
  - **Univer 的 formula engine**（Apache-2.0，sheets renderer 里已经在用）— 最合理
  - HyperFormula（**GPLv3**，商用要买授权）
  - formulajs（只有函数库，没有依赖图）

## 3. 走 WASM 的具体障碍（都可验证，不是想象）

1. **`ironcalc` 能不能在 wasi 下编**：它自己就发 WASM 包，大概率可以；`single-thread` feature 就是为这种环境准备的。
2. **`calamine` 与 `zip` 习惯读路径**：WASI 有 preopen 目录（Node 的 `node:wasi` 支持 `preopens`），把 workspace 目录映射进去即可；`temp_dir()` 已经按 `TMPDIR` 处理。
3. **`uuid v4` 需要随机源**：wasi 有 `random_get`，没问题。
4. **协议是路径式**：`Command::Open { path: PathBuf }`。Node/wasi 下没问题；但如果将来想在**浏览器**里直接算，需要给 `Open` 加一个 `bytes` 变体（这是唯一需要改协议的地方）。

## 4. 建议

1. **立刻可用**：保持 C（二进制 + spawn）。hub 只多一个 linux-x64 二进制。
2. **一次投入换掉平台矩阵**：做 A 的 1 天验证 —— 能否编出 `xlsx-sidecar.wasm`，以及 Node `node:wasi` 能否驱动同一份协议跑通 `open → readRange → saveArchive`。跑通就意味着「桌面端、服务器、以及未来的浏览器端」共用一份引擎。
3. **只在“绝不允许原生二进制”时才考虑 B**，并且提前接受两件事：保真要长期追赶；公式引擎必须换（Univer 或买 HyperFormula）。

## 5. 一句话

> xlsx 引擎用 Node **实现**是重做 18k 行；用 Node **运行**是一份 wasm。源码里那三处 `cfg!(target_os = "wasi")` 分支说明作者选的是后者。

## 6. 决定（2026-10-29）：不做 WASM，保留 sidecar

理由不是"WASM 不好"，是**"纯浏览器"这个目标已经被 PDF 否掉了**：

- PDF 的保存计算在 **main**（`save-pdf.ts` 用 pdf-lib 应用 markups / textEdits / imageEdits / redactions，涂黑是不可逆事务）；
- PDF 还依赖三样**平台原生**能力：`win-ocr.exe` / `vision-ocr`（OCR）、`forge-native`（PKCS#12 签名，原生 addon）、`powershell.exe`（Windows 系统证书）。

也就是说 "每个平台各自的二进制 + OS 集成" 这件事**已经存在**。再多一个 8.8MB 的 xlsx sidecar，边际成本≈0。

WASM 剩下的唯一好处是平台矩阵归零 —— 而这个痛点本来就被 PDF 继承了，不因 xlsx 而变。

**结论**：xlsx 保持 sidecar；只在需要时懒启动、空闲退出（便宜的优化）。跨端引擎（WASM）留给"离线单文件浏览器版"那种将来需求。
