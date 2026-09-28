# 渲染层的导入边界（Craft Agents）

> 覆盖：`apps/electron/src/renderer/**` 允许 import 什么、不允许 import 什么，为什么，以及怎么在提交前自查。
> 配套文档：[开发环境运行指南](dev-environment.md)（monorepo 结构、依赖模型、开发命令）

## 1. 规矩

**渲染层从 `@craft-agent/shared` 取「类型」不受限制（含 barrel）；取「值」只能从两类模块：`*/types`，或已确认浏览器安全的叶子模块。**

| 你要的 | 允许 | 说明 |
|---|---|---|
| **类型** | `import type { X } from '@craft-agent/shared/<任意路径>'` | 含 barrel。`import type` 在编译期整体擦除，不进包 |
| **值** | 只从 `*/types` 模块取 | 约定是**只允许出现 `import type`**，不允许任何值依赖。列入白名单的这几个目前连 type import 都没有：`config/types`、`projects/types`、`sources/types`、`prototypes/types`（与 `packages/shared/package.json` 的 `exports` 一一对应） |
| **值** | 只从浏览器安全的叶子模块取 | 现有：`@craft-agent/shared/agent/modes`（`mode-types.ts`，唯一依赖是 zod）、`@craft-agent/shared/agent/thinking-levels`（无 import） |
| **值** | **barrel（`index.ts`）一律不行** | `@craft-agent/shared`、`@craft-agent/shared/prototypes` 等 barrel 会把整个家族（含 workspace / config storage）拉进浏览器包，哪怕你只要一个字符串常量 |

## 2. 为什么：一次真实事故（2026-09-15）

`bun run electron:build` 死在渲染层打包上：

```
../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs (1:57): Expected ident
1: import { __vitePreload } from "vite/preload-helper.js";#!/usr/bin/env node
```

`__vitePreload` 被注入到 shebang **之前**，于是 rollup 在文件中间撞上 `#!` 直接解析失败。注入的前提是：这个文件在浏览器包里。实际链路（用 vite 自己的依赖扫描器确认，不是推测）：

```
renderer/components/prototypes/CreatePrototypeDialog.tsx
  → @craft-agent/shared/prototypes                    ← barrel，且取的是一个【运行时值】
  → packages/shared/src/prototypes/index.ts
  → packages/shared/src/prototypes/storage.ts
  → packages/shared/src/workspaces/storage.ts
  → packages/shared/src/config/storage.ts
  → import('../agent/session-scoped-tools.ts')        ← 惰性，但打包器照走
  → @anthropic-ai/claude-agent-sdk                    ← node-only，进不了浏览器包
```

三个放大因素，缺一个都不会这么难查：

1. `config/storage.ts` 里那句 `import('../agent/session-scoped-tools.ts')` 写成**动态**是为了**破循环依赖**，不是"可选依赖"。打包器对动态 import 一视同仁地解析，注释里的意图救不了它。
2. barrel 把整条链一次性带进来——同一个 import 语句里"只要一个常量"和"要整个家族"没有区别。
3. **dev 看不出来**：vite 的依赖优化器在 dev 下能把这个依赖预打包成功，只有生产构建那条 rollup 路径才会解析失败。`electron:dev` 一切正常 ≠ 能构建。

那次还顺带被拖进浏览器包的，有 `open`、`yaml`、`gray-matter`、`beautiful-mermaid`、`@modelcontextprotocol/sdk/*`、`zod-to-json-schema` 等一串 node-only 依赖——修掉这一条 import 之后，它们一起退出了渲染层依赖图（对比修前修后的依赖扫描结果即可看到）。

## 3. 怎么做

**渲染层需要一个共享包的新值时：**

1. 把那个值（连同它的类型）放进所属家族的 `types.ts`——**该文件只允许出现 `import type`，不允许任何值依赖**。`prototypes/types.ts` 干脆一个 import 都没有，它的模块注释写明了这一点是刻意的（见 [prototypes/types.ts](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/src/prototypes/types.ts)）。
2. 在 [packages/shared/package.json](file:///c:/Users/Ryan/code/craft-agents-oss/packages/shared/package.json) 的 `exports` 里加一条 `"./<family>/types": "./src/<family>/types.ts"`。
3. 服务端那侧照旧从原来的位置 import——`config.ts` 之类转发一层即可，调用方不用改。

**不要用这些绕法：**

- `/* @vite-ignore */`、给渲染层加 SDK 的 `external` / `alias`：node-only 代码仍然留在包里，只是错误被推迟到运行时。
- 在渲染层复制一份常量：两份真源必然漂移（这正是当初把默认类型放进共享包的原因）。
- 把 barrel 拆成"更细的 barrel"：问题不在层级，在于某个叶子模块往下能摸到 node-only 代码。要么是零依赖模块，要么就是不行。

## 4. 怎么自查

```powershell
# 1) 最快的信号，不需要构建：渲染层真正发现了哪些依赖
cd apps/electron; $env:DEBUG='vite:deps'; bunx vite optimize --force
#    不该出现 @anthropic-ai/claude-agent-sdk，以及随它进来的 open / yaml / gray-matter 等
#    （electron、electron-log 本来就在列表里，属于正常）

# 2) 真正的门（dev 通过不代表它能过）
bun run electron:build:renderer

# 3) 顺手看一眼：有 SDK 的预打包产物，说明有链子在拉它
dir apps/electron/node_modules/.vite/deps
```

## 5. 现状：没有自动守卫

目前**没有** lint 规则拦住"渲染层从 barrel 取值"，这份文档是约定唯一的载体。可行的补法是 eslint 的 `no-restricted-imports`：在 `apps/electron/src/renderer/**` 上禁掉对 `@craft-agent/shared` 及其 `index` 的**值**导入（`import type` 放行），白名单 `*/types` 与已知叶子模块。**未做**。
