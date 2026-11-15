# Fabric Tools

Use `fabric_tool` to discover and drive other Craft Agent nodes: the local server, a headless server, a connected device, or a saved hub. Use `delegate_task` for task-level delegation, and `device_tool` for shell / file / browser work on a named device.

> **Status: design preview (v0.1).** The `fabric_tool` and `delegate_task` surface described here ships with the Fabric milestone. In builds without it, these commands return `UNSUPPORTED`; use `browser_tool` / `device_tool` / `craft-cli` as before.
>
> **Quick start:** `fabric_tool --help` lists every command. `fabric_tool nodes` is the first call in almost every workflow.

---

## The three doors

| Door | What it is for | Scope |
|---|---|---|
| `fabric_tool` | Discovery + direct RPC + session lifecycle on another node | Any node you have a grant for |
| `delegate_task` | Task-level delegation (start / status / cancel), returns final text + artifacts | One unit of work on one node |
| `device_tool` | Fine-grained shell / files / browser on a **named** device | Existing device capabilities |

Rules of thumb:

- **Need a task done somewhere else?** Start with `delegate_task`.
- **Need to inspect or steer a session?** Use `fabric_tool sessions …`.
- **Need one command / one file / one browser action?** Use `device_tool`.
- **Not sure what exists?** Run `fabric_tool nodes`.

---

## Nodes and workspaces

A **node** is a process that speaks the fabric protocol. `fabric_tool nodes` reports the ones you can reach and what each allows:

```text
local          this server                      workspaces: mobile-app, infra
macbook        operator (online)                workspaces: mobile-app, notes
gpu-box        server (online)                  agents: trainer
office-hub     hub (offline)
```

`fabric_tool describe <node>` returns the full manifest: roles, workspaces, agents, limits, approval mode, and the channels you may call.

**Workspace is always explicit.** Every session command takes `--workspace <id>`. A workspace is a logical id, not a path:

- `operator` nodes run in the real workspace on that machine;
- `server` / `device` nodes may map it to a local directory or a sandbox;
- if the node cannot resolve it, the call fails with `WORKSPACE_NOT_FOUND` or `WORKSPACE_UNMAPPED`.

Never guess a workspace id. Ask the user, or use `fabric_tool workspaces <node>`.

---

## Core workflow

```text
1. fabric_tool nodes
2. fabric_tool describe <node>
3. fabric_tool workspaces <node>
4. delegate_task { node, workspace, prompt }
5. read the result / artifacts
```

For fine control:

```text
1. fabric_tool sessions create <node> --workspace <id> [--agent <id>]
2. fabric_tool sessions send <node> <sessionId> "<message>"
3. fabric_tool sessions events <node> <sessionId>
4. fabric_tool sessions cancel <node> <sessionId>   # only if needed
```

---

## `fabric_tool` commands

```text
fabric_tool --help
fabric_tool nodes
fabric_tool describe <node>
fabric_tool workspaces <node>
fabric_tool agents <node>

fabric_tool sessions list <node> --workspace <id>
fabric_tool sessions create <node> --workspace <id> [--agent <id>] [--name "<name>"]
fabric_tool sessions send <node> <sessionId> "<message>"
fabric_tool sessions events <node> <sessionId> [--from <seq>]
fabric_tool sessions cancel <node> <sessionId>

fabric_tool invoke <node> <channel> [json-args...]
```

`invoke` is the escape hatch: it calls one allowlisted channel with typed arguments. Prefer the named commands; `invoke` is for channels without a shorthand, and it is still subject to the node's grant and schema.

---

## `delegate_task`

```text
delegate_task({ node: "macbook", workspace: "mobile-app", prompt: "Run the e2e suite and fix failures", waitMs: 120000 })
delegate_task({ action: "status", taskId: "t-..." })
delegate_task({ action: "cancel", taskId: "t-..." })
```

Result:

```json
{
  "taskId": "t-...",
  "state": "completed",
  "finalText": "...",
  "artifacts": [{ "name": "patch.diff", "mediaType": "text/x-diff" }],
  "usage": { "durationMs": 184000 }
}
```

Use `waitMs` to bound how long you block:

- the task completes within `waitMs` → you get the full result;
- it is still running → you get `{ state: "working", taskId }` and must poll with `action: "status"`;
- it needs a person → you get `{ state: "input-required" }` or `{ state: "auth-required" }`; surface it to the user.

Never treat a dropped connection as completion. Poll by `taskId`.

---

## Events and approvals

`fabric_tool sessions events` streams `session:event` until a terminal event:

| Event | Meaning |
|---|---|
| `text_delta` | assistant text |
| `tool_start` / `tool_result` | tool activity |
| `complete` | task finished |
| `interrupted` | cancelled or stopped |
| `error` | failed; see `error.code` |
| `input-required` | the executing side needs a person's answer |
| `auth-required` | the executing side needs a login/OAuth |

Rules:

- Events are ordered by `seq`; reconnect with `--from <lastSeq>`.
- `input-required` and `auth-required` are **not** failures. Ask the user; do not auto-approve.
- The executing side owns permissions. You cannot approve on its behalf.
- Cancellation is best effort; read the terminal event before assuming it stopped.

---

## Recipes

### Run a task on a user's own machine

```text
fabric_tool nodes
fabric_tool describe macbook
fabric_tool workspaces macbook
delegate_task { node: "macbook", workspace: "mobile-app", prompt: "Run the e2e suite" }
```

### Drive a session step by step

```text
fabric_tool sessions create macbook --workspace mobile-app --agent tester
fabric_tool sessions send macbook s-1 "List the failing tests"
fabric_tool sessions events macbook s-1
```

### Wait for approval

```text
fabric_tool sessions events macbook s-1
# event: input-required { question: "Allow network access?", options: [...] }
# ask the user, then:
fabric_tool sessions respond macbook s-1 <requestId> <optionId>
```

### Cancel a long task

```text
delegate_task { action: "cancel", taskId: "t-..." }
# then read the terminal event / status
```

### Run a fine-grained command on a device

```text
device_tool { device: "macbook", tool: "bash", args: { command: "npm test" } }
```

---

## Errors

| Code | What to do |
|---|---|
| `NODE_NOT_FOUND` | `fabric_tool nodes`; use the exact id/name |
| `NODE_OFFLINE` | Tell the user; retry later; do not queue blindly |
| `WORKSPACE_REQUIRED` | Pass `--workspace` |
| `WORKSPACE_NOT_FOUND` | `fabric_tool workspaces <node>` |
| `WORKSPACE_UNMAPPED` | The device has no mapping; ask the user to map it on the device |
| `CAPABILITY_DENIED` | The grant is missing; ask the user to grant it |
| `APPROVAL_REQUIRED` | The node cannot run unattended; ask the user or pick another node |
| `BUSY` / `UNAVAILABLE` | Back off and retry; or use another node |
| `SCHEMA_MISMATCH` | Client/server versions differ; ask the user to update |
| `UNSUPPORTED_LOCAL` | The node has no UI/browser; use `device_tool` or another node |
| `EVENT_GAP` | Resubscribe with `--from <lastSeq>` |

---

## Security rules

1. **Never put API keys, tokens, or credentials in a prompt.** The executing side uses its own credentials.
2. **Never auto-approve** `input-required` / `auth-required`. Ask the user.
3. **Never guess** a workspace id or a node name.
4. **Do not call admin channels** (`settings:*`, credential/auth, workspace delete) through `invoke`; they are not `tool`-exposed and will be refused.
5. **Do not assume a node is trusted.** Grants are per node; if it is not in `fabric_tool nodes`, you have no business there.
6. **Do not pass the user's secrets through chat or artifacts.**

---

## Behavior notes

- `fabric_tool` only shows nodes you have a grant for; an empty list is a permission answer, not a bug.
- `approval: "none"` in a node's manifest means it cannot run `ask` sessions; use `allow-all` only with explicit user consent, or pick a node with an approval channel.
- Headless nodes have no window, dialog, tray, or browser. `LOCAL_ONLY` channels return `UNSUPPORTED_LOCAL`.
- Concurrency is bounded per node; `BUSY` is normal. Back off.
- `delegate_task` is for one unit of work. For DAG-style fan-out, let the task runner orchestrate; do not spawn a swarm from a single turn.
- All calls are audited with `requestId`, `workspaceId`, `sessionId`, and the node id.

---

## Troubleshooting

**`fabric_tool` is missing**
The Fabric feature is not enabled in this build. Use `browser_tool`, `device_tool`, or `craft-cli`.

**A node is online but has no workspaces**
`fabric_tool describe <node>` shows why: operator nodes use real local workspaces; server/device nodes may need a mapping. Ask the user to map a workspace on that node.

**A task is stuck in `working`**
Check `delegate_task status`; if the node is offline, stop polling and tell the user. Do not resend the prompt blindly — use the existing `taskId`.

**`input-required` never resolves**
The executing side is waiting for its own user. Tell the user which machine needs attention; you cannot answer for them.

**Events stop without `complete`**
The connection dropped. Reconnect with `--from <lastSeq>`; if the task is still running, continue; if it is gone, report `UNKNOWN` rather than success.
