# drawio「真·并发」（计划 B）值得做吗 —— 实测

结论：**能做，但 B 的三条通道里只有一条真提升体验**。建议不做 B 整体，做它的两个子集
（可撤销 + 读活文档 + 重叠保护，约 2–3 天），把 `observe` 的推送流和 `presence` 押后。

探针：`C:/temp/drawio-probe4`（真 bundle + 真 bridge）。

---

## 一、B1：agent 的改动变成人能 ⌘Z 撤掉的一步 —— **已落地**

A 方案走的是 drawio 自己的 `{action:'patch'}`，实测**不进撤销栈**（`DrawioFile.patch` 里
`changeListenerEnabled = undoable`，embed 传的是假）。但同一个函数接受第三参数：

```js
ui.getCurrentFile().patch([patch], null, /* undoable */ true)
```

探针输出（同一份真实编辑器，先让人画一格，再让 agent 加一格）：

```
after the person draws        cells 0,1,A,H1     undoDepth 1
after the undoable apply      cells 0,1,A,AG1    undoDepth 2
after ONE undo                cells 0,1,A,H1     agentGone true   humanKept true
after TWO undos               cells 0,1,A        humanGone true
```

**这正是想要的语义**：一笔 agent 改动 = 一步撤销，撤完人的工作还在；再撤才是人自己那笔。
顺序天然正确（后发生的先撤）。

代价（实测，不是推测）：

- **回声 autosave**：`undoable` 让 `changeListenerEnabled` 变真，改动于是被当成正常编辑，
  探针里一次 apply + 两次 undo 产生 **3 条 autosave**（各带整篇 xml）。对我们的写入链意味着
  每次 agent 编辑都会触发一次整篇写盘（1.2s 防抖会合并），并且**必须补一条 `resetDiff`**，
  否则人下一次改动会把我们的改动当 diff 再发回来。
- `resetDiff`（不带 xml）就是"把基线前移到现在"，实测 ack 的 checksum 与目标文档一致。
- 接线比 A 更短：帧内自己算 diff + 自己 `file.patch(...)`，父页只需要 `{action:'resetDiff'}`。

**值不值**：值是真实的、用户可见的 —— 现在人被 agent 改了一笔只能"用磁盘的"或"保留我的"，
做完之后就是按一下 ⌘Z。

已按此实现（`edit-bridge.ts` 的 `undoable` + `frame.tsx` 的 `resetDiff`），并在真 bundle 上复测通过：
桥回 `{craft:'applied'} → undoDepth 1→2 → 一次 undo 只撤 agent 的`。命中不了 `applied` 时退回
不能撤销的四跳路径。

---

## 二、B2：`observe`（agent 看见人正在画）—— **收益很小，不建议**

- 数据早就在：drawio 在**每次改动后 4ms** 就发出 autosave，带 cell 级 patch（实测）。
- 我们这一侧 `useFileWriter` 的写盘防抖是 **1200ms**，所以 agent 读文件最多旧 1.2 秒。
- 也就是说"agent 看得见人在画什么"这件事，**现在就有，误差 1.2 秒**；B2 能买到的是
  亚秒级、以及"还没落盘的中间态"。

付的代价却不小：patches 是一个持续的流，要塞进 agent 的上下文就必须节流 + 合并 + 判断
"哪条值得说"，这是新的状态机和一类新的噪声。**推给会话不如让人自己问**：帧里已经有
`{craft:'read'}`（返回编辑器当前文档），把它暴露成一条工具命令即可（约半天），
"我改之前先看一眼现在是什么样"就成立了，而且不占一点常驻上下文。

---

## 三、B3：`presence` —— **现在做没有意义**

presence 的真实作用不是"看得见"，是**避免两边改同一个属性**。而 agent 的一次编辑是
一个 200ms 内的短爆发，界面上标个"agent 正在改这格"来不及被看见，只会多一层装饰。

真正要解决的是那个静默覆盖（A 方案的遗留）：人和 agent 改**同一格的同一属性**时 agent 赢，
没有任何提示。这个用 presence 解决不了，用**重叠检查**能解决，很便宜：

- 帧内已经同时握着"正在算的 patch"和"最近一次人改动带来的 patch"，两者都是 id + 属性级；
- 相交时回 `conflict`，调用方按老路走（问人 / 放弃），不相交照常合并。
- 约 30 行，纯判定，好测。

---

## 四、建议

| 项 | 做不做 | 为什么 | 量级 |
|---|---|---|---|
| **可撤销**（`file.patch(..., true)` + `resetDiff`） | **做** | 唯一用户直接感知的提升 | ~1 天 |
| **读活文档**（`craft:'read'` 变成工具命令） | **做** | 消掉 1.2s 陈旧与"基于旧版本做决定" | ~0.5 天 |
| **重叠检查**（patch × 人的 patch 相交） | **做** | 堵住唯一会静默丢东西的口子 | ~0.5 天 |
| `observe` 推送流 | 不做 | 磁盘已经 1.2s 新鲜；代价是上下文噪声 | — |
| `presence` | 不做（押后） | 短爆发看不见；真实诉求由重叠检查覆盖 | — |

合计 2–3 天，而不是 B 的 1–2 周。做完之后的状态是：**agent 的每一笔可撤、agent 读到的是
屏幕上那一份、撞车时会说而不是默默赢** —— 这三件事比"看见对方正在画"更接近"同时编辑"。

## 五、如果真要做全（记录风险）

- 撤销语义两难：`undoable=true` 会带回声 autosave（每次编辑一次整篇写盘 + 一次 resetDiff）；
  `undoable=false` 干净但没有 ⌘Z。**两者不可兼得**，别想"既进撤销栈又不回声"。
- 整篇重写的 patch 仍然是 id 级的：agent 若换掉全部 id（重画一份），patch 会退化成
  "全删全加"，人正在打字的那格会消失。`drawio_tool` 的文档规则里要写明**保留既有 id**。
- 页级操作（增/删页）在 undoable 路径上会重选页面：人的当前页被删时会跳页。
- 大图性能：autosave 本来就每次改动整篇序列化，`diffPages` 再走一遍；小图 4ms，
  大图（数千格）拖拽时的成本没有量过，要做 B 之前应该先量。
