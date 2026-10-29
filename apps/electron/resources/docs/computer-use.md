# Desktop control (`computer`)

`computer_tool` drives **this machine's** desktop: read a window's accessibility tree, act on an
element by the token snapshot printed, and fall back to coordinates only where no tree exists.

**Off by default.** Turn it on in **Settings → App → Tools → Desktop control**. While it is off the
tool is not offered to any session, the native driver is not loaded, and no OS permission prompt is
raised. Turning it on is opt-in to the capability; on macOS the first *actual use* is what asks for
Accessibility and Screen Recording (see below). Turning it off again releases any held desktop at
once.

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
it after 90 s, exactly like a local conversation. The capability is advertised only when the person
has turned desktop control on **and** a driver actually answered (`isComputerUseAdvertised`), so a
build without one — or a machine with the switch off — never promises it.

Verified with both ends in one process (`bun scripts/probe-computer-use-bridge.ts`, with Desktop
control turned on): `status` came back with `21 windows`, `windows` listed them, `snapshot` returned
a snapshot id, and `stop` cleared the lease.

## Commands

One command per call (`args.command` may be an array, run in order, stopping at the first failure).

| command | notes |
| --- | --- |
| `windows` | what the driver can see, with `w<id>` refs. On macOS, menu-bar strips and system overlays are filtered out. `--exclude-self` leaves this app's windows out |
| `snapshot [--window <id>]` | the accessibility tree as `w<window>:<index>` refs, with `role`, label, value and advertised `actions` (`press`, `show_menu`, … on macOS). `--exclude-self` affects the default-window choice |
| `screenshot [--window <id>] [--out <dir\|file>]` | an image of the window (or the active one). **macOS needs Screen Recording**. `--exclude-self` affects the default-window choice; `--out` also writes it to disk |
| `click <ref>` | prefer this: delivered through accessibility, pointer untouched |
| `invoke <ref> [action]` | one of the element's advertised actions |
| `set-value <ref> <text>` | replace a field's value |
| `click-at <x> <y>` | pixel rung — real input, pointer moves. Coordinates are window-local; `--exclude-self` picks a non-Craft window, and refuses when there is none |
| `type <text>` / `key <combo>` / `scroll <dir> [n]` | real input. On macOS write `key cmd+...`, `key option+...` |
| `launch <app>` | start or focus an application |
| `stop` | give the desktop back now |

A `snapshot` with `source=none` and no elements is a real answer: canvas, games and locked sessions
have no tree. Use `screenshot` plus `click-at` there, and say so in the reply.

Reads that name no window (`windows`, `snapshot`, `screenshot`, `click-at`) pick the frontmost one,
**including Craft's own windows** — asking the agent to operate the app itself is a legitimate
request. `--exclude-self` is the explicit opt-out: it leaves this application's windows out of that
choice, so a capture meant to show somebody else's screen cannot land on the conversation or the
pill. Self-capture is otherwise a non-issue: `screenshot` captures one target window, not the screen,
and the "desktop is being driven" pill is **content-protected** — visible to the person, excluded
from screenshots and recordings (`NSWindowSharingNone` / `WDA_EXCLUDEFROMCAPTURE`). No hide/restore
around a capture is needed, so there is no flicker and no race.

`--out` writes the capture to disk as well, the same way `read --save` and `video_tool --out` do. A
**directory** receives the next `screenshot-0001.png` (so repeated shots never overwrite each
other); a **file path** is written exactly there, with its extension corrected to the image's real
format. A relative path counts from the workspace root, `~/…` is expanded, and the absolute path is
reported as `Saved: …`. The image is still returned inline — `--out` adds a file, it does not replace
the reply. The file is written where the command runs (this app for `computer_tool`); for
`device_tool` with a remote device, the image bytes come back to this machine and are written here.

### Coordinates are logical window units

`click-at <x> <y>` takes **pixels of the screenshot image**, with the origin at the window's
top-left. The manager captures window screenshots at the window's **logical size**, so on a Retina
display 1 image pixel is 1 point — not 2. That makes the number read off a screenshot the same
number used by `snapshot`'s `frame`s and `windows`' `bounds` (those are screen-absolute, so subtract
the window origin). The driver reverses the Retina backing scale itself; there is no 2× arithmetic
in a command.

A very large window (long edge above the driver's own image cap, 1568 px) is still downscaled. The
reply then says `image scale <n> px per window unit`; multiply a window-unit coordinate by that
scale before passing it to `click-at`.

### Multiple displays

Window enumeration, snapshots and screenshots cover **every display**. Each capture is per window
and at that window's logical size, so a Retina laptop screen and a 1× external monitor coexist: the
driver reverses each window's backing scale, and `image scale` reports the rare downscale. A window
on a display left of or above the primary has negative `bounds`, which changes nothing —
`click-at` is window-local.

Choosing the **default** window asks the OS which application is frontmost (`list_apps.active`) and
then takes that application's frontmost window. Raw `zIndex` is global to WindowServer and can point
at a window on another display that the person is not using, so it is only the fallback when the
driver cannot report an active app.

The "desktop is being driven" pill is placed on the display under the pointer when the lease starts
— the display the person is most likely looking at. It does not follow the agent to a second display
mid-session; the driver's own agent cursor is the in-context hint there. Desktop-wide capture
(`get_desktop_state`) is primary-display only in driver 0.28.1, but `screenshot` is per-window, so
that limitation does not affect it.

## Trust model

1. **A separate grant.** `client:computer:invoke` is its own capability. Permission to run shell
   commands is *not* permission to move the pointer; the device-side switch that covers
   shell/files/browser does not cover this one.
2. **Fail-closed advertisement.** The capability is announced only when Desktop control is on
   **and** the driver has actually resolved (`isComputerUseAdvertised`). A build without the driver,
   or a machine with the switch off, never lists `computer`; no OS permission is requested while it
   is off.
3. **One desktop, one session.** The first session to ask holds a lease (90 s, renewed on every
   primitive). A second session gets `CUA_DESKTOP_BUSY`; an idle or crashed session loses the
   desktop on lease expiry rather than holding it forever.
4. **Explore mode cannot reach it.** The tool is `safeMode: 'block'`.
5. **Audit says what happened.** Actions report `role`, `label` and `delivered=background|foreground`
   — a log line a person can review, where coordinates cannot be.

## Lock screen and the login window

Desktop control here is a **user-session, application-level** capability. It does not cross the
operating system's secure login surfaces, and the two platforms express that differently:

| | macOS | Windows |
| --- | --- | --- |
| what is on screen | `loginwindow` (lock screen / login window) | the Winlogon **secure desktop** |
| user-session capture | ScreenCaptureKit returns no usable frame | a user-session process cannot capture that desktop |
| user-session input | `CGEventPost` is ignored; the target apps' AX trees are not reachable | `SendInput` cannot reach the secure desktop |
| what would | a privileged LaunchDaemon + HID-level injection, or a virtual display | a SYSTEM service that switches to the input desktop and injects |

What the manager sees: `get_desktop_state` fails on a locked or disconnected Windows session, and on
macOS a locked screen yields no window tree and no screenshot. Injected keys can still report
success while landing nowhere — the failure the Windows/RDP round recorded below. The rule is
unchanged: **no `Edit`/`Document` element in the tree → do not type, do not press keys.**

Do not read macOS's `get_session_state().desktop_unlocked` as a lock-screen flag: the driver says it
reports desktop *capture authorization*, not whether the host is locked.

Remote-desktop products (UU远程, TeamViewer, AnyDesk, Apple Screen Sharing) can show and type into
the lock screen because they install a **privileged helper/service** and work at the remote-desktop
layer — capture and injection on the secure session, or a virtual display — not at the application
automation layer. `cua-driver` has no primitive for that session, and this release does not add one.
If lock-screen control ever becomes a requirement it is a separate component: a signed and notarized
privileged helper (a LaunchDaemon on macOS, a service on Windows), explicit user opt-in, and the
security review any remote-control product needs.

## Enabling the driver

`@trycua/cua-driver` is an **optional** dependency (its native payload is ~25 MB per platform):

```bash
cd apps/electron && bun install
```

The app starts fine without it; `computer` is simply not offered. `loadDefaultCuaDriver()` in
`apps/electron/src/main/computer-use-manager.ts` is the only place that resolves it for the manager
(the permissions module imports the same package for its TCC probes).

Packaged builds ship it as an `extraResource` at `app/node_modules/@trycua/cua-driver` together with
its platform payload and the `@ubjs` N-API bridge — `esbuild` keeps the package external so the
native `.node`/`.dylib` are loaded from a real directory, not from a bundle. A build machine without
the package skips the copy, and that artifact does not advertise `computer`.

Platform notes:

- **Windows** — UI Automation, with an MSAA fallback for legacy Win32 apps. No user consent dialog.
- **macOS** — needs **Accessibility** and **Screen Recording** (TCC). Both are per-app grants the
  person gives in System Settings; the driver reports `CUA_PERMISSIONS_REQUIRED` until then.
- **Linux** — no platform package is shipped by the driver; the capability stays unadvertised.

### macOS: the host asks, the driver never does

The driver runs **inside this process**, so the grants belong to this application. In embedded mode
it deliberately does not prompt:

> Embedded mode: status reflects the HOST app's TCC grant. If a permission is missing, the host must
> request it — the driver will not prompt.

`computer-use-permissions.ts` owns that request. It is lazy — triggered the first time a session
takes the desktop, never at app launch — and at most once per process, so a person who dismissed the
dialog does not meet it again every conversation. It follows the only order a person can complete:

1. **Accessibility** via `systemPreferences.isTrustedAccessibilityClient(true)`, then polls (bounded
   to two minutes) because the TCC API has no completion callback.
2. **Screen Recording** only after Accessibility settles. Asking both at once puts two system
   dialogs in front of a person who can only answer one.

Until the grants land, `status` still works and names what is missing:

```
❌ Screen Recording: NOT granted.
macOS: grant Screen Recording (System Settings › Privacy & Security › Screen Recording) to capture
windows. Element actions work without it.
```

**Element actions need only Accessibility.** Screen Recording is required for `screenshot` (and the
driver's window title, which comes from `CGWindowName`). That is why the guidance says element work
continues while capture does not.

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
| `apps/electron/src/main/computer-use-permissions.ts` | macOS TCC grants and the one place that asks for them |

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

## Verified against a live driver (macOS 15.6.1 arm64, 0.28.1 / contract 0.8.0)

Probed with `probe-computer-use-round.ts`, `probe-computer-use-status.ts`, `probe-computer-use-shot.ts`,
and a TextEdit round through `ComputerUseManager` (launch → snapshot → type → set-value → key).

| step | real answer |
| --- | --- |
| `CuaDriver.create({})` | `isAvailable() → true`, `metadata() → 0.28.1 / 0.8.0` |
| `listWindows({})` | 78 records on a busy desktop → **29 app windows** after filtering. `windowId`/`zIndex` are **BigInt**, `appName` is localized (`文本编辑`), `title` is **empty without Screen Recording**, `bounds` are screen points, plus `isOnScreen`, `onCurrentSpace` |
| `getWindowState({ pid, windowId: BigInt, includeAccessibilityTree: true })` | `{ snapshotId: "s00000001", elements: [{ elementToken: "s00000001:1", role: "AXTextArea", label, value, actions: ["AXShowMenu"], frame }] }` |
| `callTool('click', { …, element_token })` | ✅ `press` performs `AXPress`, `delivered=background`, `effect=unverifiable`. The token is **stale after the next snapshot** (`stale_element_token`) — re-read before every action |
| `callTool('type_text', { …, element_token, text })` | ✅ TextEdit's `AXTextArea.value` became `craftprobe123` |
| `callTool('set_value', { …, element_token, value })` | ✅ the same field became `setbycraft` |
| `callTool('press_key', { key: 'a', modifiers: ['cmd'] })` | ✅ accepted; a following focused insert replaced the selection (`abc` → `Z`) |
| `callTool('get_desktop_state', {})` | ✅ `2880×1800` pixels for a `1440×900` point screen (`scale_factor: 2.0`) — **desktop** capture works without Screen Recording |
| `getWindowState(…, includeScreenshot: true)` | ❌ without Screen Recording: `DriverError.Tool`, inner `No content produced (neither AX tree nor screenshot succeeded)`. The manager replaces that with the grant sentence |
| `set_agent_cursor_enabled` | ❌ `macOS agent cursor overlay is unavailable: this runtime owner has no certified AppKit main-thread host adapter …` → `status` says `agent cursor: unavailable` |
| `bring_to_front` | ✅ `Brought exact window … to the foreground`, `focused: true`, `frontmost_ordinary: true` |
| `launch_app` | ✅ launches **in the background**; `window_ready` may be `false` and the answer carries a `windows` array. The manager polls 10×150 ms, picks the real window (not the 1440×24 menu-bar strip) and fronts it |
| `start_session` / `end_session` | ✅ lease by label. Session state reports `desktop_unlocked: false` **even while AX actions and `press_key` work**, so it is not the injected-input gate on macOS |

What this means for the implementation:

- **`invoke` is spelled differently.** macOS advertises `AXPress` / `AXShowMenu` / `AXRaise`;
  `snapshot` normalizes these to `press` / `show_menu` / `raise`, and actions the driver cannot
  perform (`AXScrollToVisible`) are left out. `AXRaise` is served by `bring_to_front`.
- **Titles are a permission, not a property.** Without Screen Recording, every window is
  `(no title)`; identity comes from `appName` + `w<id>`. A snapshot still names the window from its
  `AXWindow` label.
- **Static text can be missing from `elements`.** Calculator renders its display in `treeMarkdown`
  but not in the structured array, so a screenshot (and therefore Screen Recording) is how an agent
  reads displayed values there.
- **`windows` is filtered.** Menu-bar strips (`1440×24`) and system surfaces
  (`CursorUIViewService`, 54×54) are not app windows; listing them buried the 29 real ones.
- **`key` uses macOS modifier names.** `cmd` / `option` are translated by the manager; `ctrl` stays
  `ctrl`. Named keys are lowercased (`Return` → `return`).

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

**On macOS the driver's cursor is not drawable from an embedded host** — it answers `macOS agent
cursor overlay is unavailable: this runtime owner has no certified AppKit main-thread host adapter`.
`status` therefore reports `agent cursor: unavailable`, not `on`; the state only moves to `on` after
the driver accepted the call. The app-level pill below is what a person sees there.

The app-level pill is built and verified in a running Electron window: a frameless, always-on-top
(`screen-saver` level) window at the top centre of the display the pointer is on when the lease
starts. What it draws is a compact **156×34** badge ("Craft 操作中") that expands on hover to
**384×56**, showing "Craft 正在操作这台电脑 / AI 正在控制鼠标与键盘" and a 停止 button that calls
`ComputerUseManager.release()`. The window is `172×50` collapsed and `400×72` expanded (8 px of
shadow room around the badge), it is **not click-through**, and the badge can be **dragged** anywhere
on screen — the window grows and shrinks with it instead of keeping a large invisible hit area. The
position is temporary: it is not saved, and the next lease starts at the top of the display under
the pointer. It is created on lease start and **destroyed** on lease end — never hidden, so a stale
pill cannot claim a desktop nobody is driving.

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
- **Lock screen / login window.** Out of scope by design: crossing it needs a privileged helper, not
  the user-session driver — see “Lock screen and the login window”.
- **Linux.** Unverified and unavailable: no platform package is published for 0.28.1.
- **macOS driver cursor.** The embedded host cannot draw it; the pill is the visible signal instead.
  A GUI private worker or standalone service would restore the in-context cursor.
