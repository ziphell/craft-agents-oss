# WebUI Runtime 解耦设计

## 1. 背景与问题

WebUI 的 HTTP handler（`createWebuiHandler`）位于共享包 `@craft-agent/server-core`，名义上同时服务 Electron（Node 运行时）与 headless server。但它内部直接调用了 **Bun 专有 API**：

| 位置 | API | 用途 |
|---|---|---|
| `webui/http-server.ts` L217/228/386/395 | `Bun.file(...)` | 读静态文件（`.exists()` + 作 `Response` body） |
| `webui/auth.ts` L102/111 | `Bun.password.hash/verify` | 登录口令的 argon2id 哈希 / 校验 |
| `webui/http-server.ts` L429 | `Bun.serve(...)` | standalone HTTP server（仅用于非 Electron 部署） |

headless server 的目标运行时就是 Bun（`Dockerfile.server` = `oven/bun`，`ENTRYPOINT ["bun", ...]`），所以这些调用在那边一直正常工作。但一旦要把这套 handler 搬进 Electron 主进程（Node），`Bun` 全局不存在，handler 首次读文件即抛错。

`nodeHttpAdapter` 只桥接了 `(IncomingMessage, ServerResponse) ⇄ (Request, Response)`，**并未解决 handler 内部对 Bun 的依赖**。

## 2. 目标与非目标

**目标**
- 让 `createWebuiHandler` 在 Bun 与 Node 两种运行时下都能工作。
- headless（Bun）行为**零变化**。
- 不引入隐式全局（不给 Electron 垫 `Bun`）。
- 依赖最小：不额外引入原生模块。

**非目标（后续阶段）**
- 把 WebUI 静态服务接进 Electron 的 `bootstrapServer`（`httpHandler` + `validateSessionCookie`）。
- 把 `apps/webui/dist` 打包进 Electron 分发包并解析 `webuiDir`。

## 3. 设计

### 3.1 新增运行时抽象

新增 `packages/server-core/src/webui/runtime.ts`，用一个接口收口全部运行时相关能力：

```ts
export interface WebuiRuntime {
  /** 打开构建产物为可流式 body；不存在返回 null。 */
  openAsset(absPath: string): Promise<ReadableStream<Uint8Array> | null>
  /** 生成口令哈希（自描述格式）。 */
  hashPassword(plaintext: string): Promise<string>
  /** 常量时间校验口令。 */
  verifyPassword(plaintext: string, hash: string): Promise<boolean>
}
```

**Bun 实现**（保持现状）：
- `openAsset` → `Bun.file(abs)` 的 `exists()` + `stream()`
- `hashPassword` / `verifyPassword` → `Bun.password`（argon2id）

**Node 实现**（Electron，零新依赖）：
- `openAsset` → `fs.stat`（ENOENT/非文件 → null）+ `Readable.toWeb(fs.createReadStream(abs))`
- `hashPassword` / `verifyPassword` → `crypto.scrypt` + `crypto.timingSafeEqual`，格式 `scrypt$<salt-b64>$<key-b64>`

**运行时选择**（与仓库既有写法一致，见 `bootstrap/headless-start.ts`）：

```ts
export function createDefaultWebuiRuntime(): WebuiRuntime {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
    ? createBunWebuiRuntime()
    : createNodeWebuiRuntime()
}
```

### 3.2 关于口令哈希跨运行时一致性

`hashedPassword` 是**进程内内存态**：启动时由口令算出、不落盘、不跨进程共享（`auth.ts`）。因此每次进程各算各的，**不存在跨运行时的哈希格式互通问题**——Node 侧用 `scrypt` 而非原生 argon2 是完全安全的，也避免了为此引入原生依赖。

### 3.3 注入点

`createWebuiHandler` 复用 `WebuiHandlerOptions`，新增可选字段：

```ts
runtime?: WebuiRuntime   // 省略时自动按运行时选择
```

- Bun server 调用方：**不改**（自动选中 Bun 实现）。
- Electron 调用方（后续阶段）：**不传**即可拿到 Node 实现。

`Bun.serve` 保留在 `startWebuiHttpServer`（standalone 分支），Electron 走嵌入式 `httpHandler` 路径，永不触碰。

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `webui/runtime.ts` | **新增**：接口 + Bun/Node 实现 + `createDefaultWebuiRuntime` |
| `webui/http-server.ts` | 4 处 `Bun.file` → `runtime.openAsset`；注入 `runtime`；登录流程改用 `runtime.hashPassword/verifyPassword`；保留 `Bun.serve` |
| `webui/auth.ts` | 删除模块级 `hashedPassword` / `initPasswordHash` / `verifyPassword`（即全部 `Bun` 引用）；JWT / cookie / RateLimiter 不动 |
| `webui/index.ts` | 导出 `WebuiRuntime` 及工厂函数 |
| `webui/__tests__/runtime.test.ts` | **新增**：Node 实现单测 |

## 5. 兼容性与行为保证

- headless 进程 `typeof globalThis.Bun` 为真 → 选中 Bun 实现 → `Bun.file` / `Bun.password` 语义与现状一致。
- 既有测试 `http-server.test.ts` / `oauth-callback.test.ts` 走 `startWebuiHttpServer`（Bun），不受影响。
- 登录限流、cookie、JWT、OAuth callback、`/api/config*` 全部不涉及运行时抽象，保持不变。

## 6. 测试与验证

- 新增 Node 实现单测：`openAsset` 命中 / 未命中；`hashPassword → verifyPassword` 往返；错误口令返回 `false`；非法存储格式返回 `false`。
- `bun run typecheck:all`（含 `server-core`）。
- 既有 webui 测试回归。

## 7. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| Node 侧流式 body 兼容 | `Readable.toWeb` 需 Node ≥ 18（Electron 39 满足） | 单测覆盖 |
| 移除 `auth.ts` 导出 | 仅 `http-server.ts` 引用，`index.ts` 未导出它们 | 改动前已核实引用点 |
| 非文件路径探测 | `openAsset` 对目录/不存在返回 null | `stat().isFile()` 判定 |

## 8. 范围边界

本方案只做"解耦"。接进 Electron（`httpHandler` + `validateSessionCookie` + `webuiDir` 打包）为后续独立阶段，届时 Electron 侧**无需传 `runtime`**即可复用同一套 handler。
