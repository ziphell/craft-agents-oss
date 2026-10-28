# Desktop control (`computer`)

`computer_tool` drives **this machine's** desktop: read a window's accessibility tree, act on an
element by the token snapshot printed, and fall back to coordinates only where no tree exists.

It is its **own door**, beside `browser_tool` — not a nested tool of `device_tool`. The two answer
different questions and stay orthogonal:

| door | the question it answers |
| --- | --- |
| `device_tool` | *which machine* a call runs on (this one, or another connected to the hub) |
| `computer_tool` | *this machine's* GUI — the desktop in front of the person |

```json
{ "command": "snapshot" }
```

Another machine's desktop is reached the other way — through `device_tool`, where a **device** is
what names the machine:

```json
{ "device": "<device id>", "tool": "computer", "args": { "command": "snapshot" } }
```

That path is served by `RemoteComputerPaneManager` (the remote bridge): it ships each primitive over
`client:computer:invoke` to the device that answered, and the device drives **its own** desktop. It
never falls back to the local one — a device that does not offer a desktop is an error, not a
substitution.

So, in one line: **`computer_tool` drives this process's desktop; `device_tool {tool:"computer"}`
drives that device's.** The two are orthogonal, and neither is nested in the other.

### The wire, and who answers it

| end | what it does |
| --- | --- |
| hub — `RemoteComputerPaneManager` | packs one primitive call into `{ v: 1, method, args }` and sends it over `client:computer:invoke` |
| device — `attachDeviceCapabilities` | unpacks it with `dispatchComputerCapability` and runs it on **its own** desktop |

Both ends read the argument order from `packages/shared/src/agent/computer-bridge.ts`, so the two
cannot drift apart silently.

The device drives that desktop under a lease named after the **connection** (`remote:<connectionId>`),
not after the hub's session: two hubs cannot both move this pointer, and a hub that goes quiet loses
it after 90 s, exactly like a local conversation. The capability is advertised only when a driver
actually answered (`isComputerUseAdvertised`), so a build without one never promises it.

Verified with both ends in one process (`bun scripts/probe-computer-use-bridge.ts`): `status` came
back with `21 windows`, `windows` listed them, `snapshot` returned a snapshot id, and `stop` cleared
the lease.

## Commands

One command per call (`args.command` may be an array, run in order, stopping at the first failure).

| command | notes |
| --- | --- |
| `windows` | what the driver can see, with `w<id>` refs |
| `snapshot [--window <id>]` | the accessibility tree as `w<window>:<index>` refs, with `role`, label, value and advertised `actions` |
| `screenshot [--window <id>]` | an image of the window (or the active one) |
| `click <ref>` | prefer this: delivered through accessibility, pointer untouched |
| `invoke <ref> [action]` | one of the element's advertised actions |
| `set-value <ref> <text>` | replace a field's value |
| `click-at <x> <y>` | pixel rung — real input, pointer moves |
| `type <text>` / `key <combo>` / `scroll <dir> [n]` | real input |
| `launch <app>` | start or focus an application |
| `stop` | give the desktop back now |

A `snapshot` with `source=none` and no elements is a real answer: canvas, games and locked sessions
have no tree. Use `screenshot` plus `click-at` there, and say so in the reply.

## Trust model

1. **A separate grant.** `client:computer:invoke` is its own capability. Permission to run shell
   commands is *not* permission to move the pointer; the device-side switch that covers
   shell/files/browser does not cover this one.
2. **Fail-closed advertisement.** The capability is announced only after the driver has actually
   resolved (`isComputerUseAdvertised`). A build without the driver never lists `computer`.
3. **One desktop, one session.** The first session to ask holds a lease (90 s, renewed on every
   primitive). A second session gets `CUA_DESKTOP_BUSY`; an idle or crashed session loses the
   desktop on lease expiry rather than holding it forever.
4. **Explore mode cannot reach it.** The tool is `safeMode: 'block'`.
5. **Audit says what happened.** Actions report `role`, `label` and `delivered=background|foreground`
   — a log line a person can review, where coordinates cannot be.

## Enabling the driver

`@trycua/cua-driver` is an **optional** dependency (its native payload is ~25 MB per platform):

```bash
cd apps/electron && bun install
```

The app starts fine without it; `computer` is simply not offered. `loadDefaultCuaDriver()` in
`apps/electron/src/main/computer-use-manager.ts` is the only place that resolves it.

Platform notes:

- **Windows** — UI Automation, with an MSAA fallback for legacy Win32 apps. No user consent dialog.
- **macOS** — needs **Accessibility** and **Screen Recording** (TCC). Both are per-app grants the
  person gives in System Settings; the driver reports `CUA_PERMISSIONS_REQUIRED` until then.
- **Linux** — no platform package is shipped by the driver; the capability stays unadvertised.

Structured as: the driver ships *accessibility first, coordinates last*. Prefer `click`/`invoke`
over `click-at`: the former does not take the pointer and cannot land on the wrong widget if the
layout shifts.

## Where the pieces are

| file | role |
| --- | --- |
| `packages/shared/src/agent/computer-pane.ts` | primitives a device must provide |
| `packages/shared/src/agent/computer-commands.ts` | the command language and its rendering |
| `packages/shared/src/agent/device-tools.ts` | the `computer` branch of `device_tool` |
| `packages/session-tools-core/src/tool-defs.ts` | schema (the model's view) |
| `packages/server-core/src/sessions/SessionManager.ts` | capability bits, session-scoped fns |
| `apps/electron/src/main/computer-use-manager.ts` | lease, driver resolution, normalization |

## Verified against a live driver (Windows, 0.28.1 / contract 0.8.0)

Probed with `bun scripts/probe-computer-use-round.ts`; these are the calls that actually work, and
what the manager uses:

| step | real answer |
| --- | --- |
| `CuaDriver.create({})` | `metadata() → { driverVersion: 0.28.1, contractVersion: 0.8.0, embedded: true }`, `isAvailable() → true` |
| `listWindows({})` | 22 windows: `{ windowId: "4197322", pid, appName, title, bounds, isOnScreen, minimized, zIndex }` |
| `getWindowState({ pid, windowId: BigInt, includeAccessibilityTree: true, maxElements })` | `{ snapshotId: "s00000001", elements: [{ elementToken: "s00000001:12", role, label, actions: ["invoke"], depth, frame }], degraded, truncationReason }` |
| `getWindowState(..., includeScreenshot: true)` | `images[0].dataBase64` + `screenshotWidth/Height/MimeType` |
| `callTool('click', { pid, window_id, element_token })` | ✅ verified: clicking Settings' nav item "系统" changed the tree 61 → 92 elements, `delivered=background`, then "主页" restored it |
| `callTool(name, argumentsJson)` | **two positional strings**, second is JSON — `{name, arguments}` is rejected with `InvalidArguments` |
| `callTool('set_value', { pid, window_id, element_token, value })` | ✅ verified: the field's `value` changes in the next snapshot |
| `callTool('type_text', { …, element_token, text })` | ✅ verified **with** `element_token`; without it the text goes to the focused control and goes nowhere here |
| `callTool('check_permissions', {})` | the machine's own words: integrity level, `UIA accessibility: available`, `PostMessage injection: available` |
| `callTool('get_desktop_state', {})` | **fails on a locked/remote desktop**: `Desktop screenshot failed: … (0x80070006)` — used as the injected-input probe |
| `callTool('press_key', …)` | reports `ok` and changes nothing in such a session — so it is **gated**, not trusted |
| `startSession({})` / `endSession({ session })` | lease; a second session is refused with `CUA_DESKTOP_BUSY` |

The second session refusal was observed: `CUA_DESKTOP_BUSY: Another session is driving this
desktop right now.`, and `release()` clears the lease.

### Foreground delivery needs a real foreground window

On the machine this was verified on (an RDP session) the driver answered:

```
foreground_unavailable: Windows did not confirm exact target HWND … (actual foreground HWND 0x0).
Windows refused the foreground change … no input was sent.
```

`HWND 0x0` plus `getSessionState().desktopUnlocked === false` means there is no interactive desktop
in front: **accessibility actions work, injected input does not.** The same machine should accept
foreground input from a normal console session.

Practical consequence for the agent: prefer `set-value` for fields and `type --element` for text
entry, because both are delivered through accessibility and never need the pointer.

**Measured the hard way, on this very machine: a window with no accessible tree is not safe to type
into.** Notepad++ shows no `Edit` element (Scintilla), so a `snapshot` finds nothing to aim at — but
`type --window <id>` still went through, and `press_key` with `ctrl+a` arrived as a literal `a`
rather than a selection. The result was 17 stray characters appended to a line of a real document,
and one `Ctrl+Z` did **not** undo it. The rule that follows is not "be careful": it is

> no `Edit`/`Document` element in the tree → do not type, do not press keys. Read the window with
> `screenshot`, say what you see, and ask.

Typing into a window you could not read is the one operation whose failure is silent, lands in
someone's file, and cannot be undone by the same mechanism that caused it.

Because `press_key` reported success while doing nothing, the manager **probes once per session**
(`get_desktop_state`) and gates the injected verbs on the answer:

| verb | when injected input is unavailable |
| --- | --- |
| `key` / `click-at` | refused with `This session cannot accept injected input …` |
| `type` without `--element` | refused with the same message |
| `click` / `invoke` / `set-value` / `type --element` | unaffected — accessibility only |

`status` reports the same flag, so an agent can plan instead of guessing:

```
driver 0.28.1 · contract 0.8.0
windows 22
desktop capture: unavailable: Desktop screenshot failed: 句柄无效。 (0x80070006)
injected input: unavailable (use element actions)
  UIA accessibility: available (no special permission needed)
  PostMessage injection: available
```

(A note for version 0.28.1: `metadata()` reports the package's `0.28.1 / contract 0.8.0`, while
`health_report` calls the same binary `cua-driver 0.37.0`. Treat `metadata()` as the contract you
coded against.)

## Showing that the desktop is being driven

The lease has a visible half: while a session holds the desktop, the driver's **own cursor** is drawn
on screen (`set_agent_cursor_enabled`). It goes away when the lease is released, expires, or the
session runs `stop` — so "nothing is touching my machine" and "no cursor on screen" are the same
statement.

```
=== while holding the desktop ===
injected input: unavailable (use element actions)
agent cursor: on
```

Measured: the enable/disable calls report `ok` and the flag tracks the lease. On a live desktop
`status` reports `desktop capture: available` and `injected input: available`, where a remote/locked
session reports both unavailable — so `status` alone tells you which kind of session you are in.

The app-level pill is built and verified in a running Electron window: a frameless, always-on-top
(`screen-saver` level) window at the top centre of the primary display, 392×64, click-through except
over its own button, showing "Craft 正在操作这台电脑 / AI 正在控制鼠标与键盘" and a 停止 button that
calls `ComputerUseManager.release()`. It is created on lease start and **destroyed** on lease end —
never hidden, so a stale pill cannot claim a desktop nobody is driving.

Still missing, in order of value:

- **An app-level indicator** (tray icon state, menu-bar item, or a small floating badge) for when the
  agent cursor is off-screen, on another monitor, or the window is covered. The driver's cursor is
  the *in-context* hint; it is not a substitute for a persistent one.
- **Per-action approval** — gated by mode and capability today, not by a per-click prompt.

## Not done yet

- **`scroll` / `drag` / `double_click` / `right_click` are wired but unverified.** Element click,
  set-value and element-targeted typing are proven; the remaining verbs need a surface whose change
  is observable.
- **`press_key` delivered nothing on an RDP session** (no foreground window). It is wired correctly —
  the driver refused, and said why — but a real console session is where it must be confirmed.
- **The enum module is carried on `globalThis`.** Records need `ActionTarget` / `ClickPosition` /
  `InputDeliveryMode` from the module namespace; `loadDefaultCuaDriver` parks the namespace on
  `globalThis.__craftCuaEnums`. Works, but passing it into the manager explicitly would be cleaner.
- **A preview window** (the “this desktop is being driven” surface) is not built. Until it is, the
  only signals are the lease and the reply text.
- **Remote devices.** Only the local device can serve `computer` today: `getComputerFns` requires the
  device to advertise the capability, and only the local link does. A `RemoteComputerPaneManager`
  mirroring `RemoteBrowserPaneManager` is the follow-up.
- **Per-action approval.** Gated by mode and capability, not by a per-click prompt.
- **macOS/Linux.** Unverified: this round ran on Windows. macOS needs TCC (Accessibility + Screen
  Recording); no Linux platform package is published for 0.28.1.
