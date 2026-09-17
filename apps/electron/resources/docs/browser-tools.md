# Browser Tools

Use `browser_tool` to control built-in browser windows (Chromium) inside Craft Agents.

> **Quick start:** Run `browser_tool --help` to see all available commands and usage examples.

## Browser usage paths

1. **Primary and only in-session tool surface:** `browser_tool`
2. **Secondary helper CLI:** `bun run browser-tool --help` for command discovery/templates, and `bun run browser-tool parse-url <url>` for safe URL diagnostics outside agent turns

---

## Browser as an Alternative to Source Setup

Use browser workflows when creating a source would add unnecessary overhead for the current task.

**Good fit for browser-first:**
- One-off tasks that don’t need reusable integration
- UI-only workflows where API/MCP coverage is poor
- Fragile source setup/auth cases where user needs results now

**Still prefer sources when:**
- Work is repeatable and automation/reporting is needed
- Team-wide reuse and stable tooling matter

---

## Core workflow

There is one browser window per workspace, so there is no window to choose: `open` resolves it.

Recommended flow:
1. `open` — ensure browser window exists (background by default)
2. `navigate <url>` — load a URL
3. `snapshot` — inspect accessible elements and get refs (`@e1`, `@e2`, ...)
4. `find <query>` — quickly narrow to matching refs by keyword
5. `click` / `fill` / `select` — interact using refs
6. `screenshot --annotated` (or `screenshot-region`) — visual verification when needed

---

## `browser_tool` command examples

```text
browser_tool({ command: "--help" })
browser_tool({ command: "open" })
browser_tool({ command: "open --foreground" })
browser_tool({ command: "navigate https://example.com" })
browser_tool({ command: "snapshot" })
browser_tool({ command: "find login button" })
browser_tool({ command: "click @e12" })
browser_tool({ command: "click-at 350 200" })
browser_tool({ command: "drag 100 200 300 400" })
browser_tool({ command: "fill @e5 user@example.com" })
browser_tool({ command: "type Hello World" })
browser_tool({ command: "select @e3 optionValue" })
browser_tool({ command: "select @e75 CNAME --assert-text Target --timeout 3000" })
browser_tool({ command: "upload @e3 /absolute/path/to/file.pdf" })
browser_tool({ command: "set-clipboard Name\tAge\nAlice\t30" })
browser_tool({ command: "get-clipboard" })
browser_tool({ command: "paste Name\tAge\nAlice\t30" })
browser_tool({ command: "scroll down 800" })
browser_tool({ command: "reload" })
browser_tool({ command: "evaluate document.title" })
browser_tool({ command: "evaluate --file prototypes/cart/patches/ui-002-total.js" })
browser_tool({ command: "console 50 warn" })
browser_tool({ command: "screenshot" })
browser_tool({ command: "screenshot --annotated" })
browser_tool({ command: "screenshot-region --ref @e12 --padding 8" })
browser_tool({ command: "window-resize 1280 720" })
browser_tool({ command: "network 50 failed" })
browser_tool({ command: "wait network-idle 8000" })
browser_tool({ command: "key Enter" })
browser_tool({ command: "downloads wait 15000" })
browser_tool({ command: "focus" })
browser_tool({ command: "tabs" })
browser_tool({ command: "snapshot --tab tab-2" })
browser_tool({ command: "tab-new https://example.com" })
browser_tool({ command: "tab-close tab-2" })
browser_tool({ command: "release" })
browser_tool({ command: "hide" })
browser_tool({ command: "close" })
```

The wrapper validates commands and returns actionable errors when arguments are missing or invalid.

It also returns rich execution feedback for most commands, including before/after state where available (scroll positions, active element, URL/title transitions, resize clamping, request/error summaries, and window state/visibility details).

You can batch commands with semicolons, for example:
`fill @e1 user@example.com; fill @e2 password123; click @e3`

Batches run left-to-right and stop automatically after navigation commands (`navigate`, `click`, `back`, `forward`) so refs don’t go stale silently.

### Quoting and escaping

`browser_tool` supports quoted arguments:
- Double quotes: `fill @e5 "Hello world"`
- Single quotes: `wait text 'welcome back' 5000`

Semicolons inside quotes are treated as literal text (not batch separators):
- `fill @e1 "a;b;c"; click @e2`
- `screenshot-region --selector "div[data-x='a;b']" --padding 8`

Use backslash escaping when needed:
- `\;` for a literal semicolon outside quotes
- `\"` for a literal `"` inside double-quoted text

---

## Key commands

### `open [--foreground|-f]`
Create or reuse the session browser window.
- Default: opens in background
- `--foreground` / `-f`: focuses in foreground

### `snapshot`
Returns an accessibility tree with refs and element metadata.

### `find <query>`
Performs keyword search over the snapshot accessibility nodes (`role`, `name`, `value`, `description`) and returns matching refs.

### `click <ref> [waitFor] [timeoutMs]`
Click an element ref from `snapshot`. Optional wait modes: `none`, `navigation`, `network-idle`.

### `click-at <x> <y>`
Click at raw pixel coordinates. Use this for **canvas-based UIs** (e.g., Google Sheets cells, map elements, chart data points) where `snapshot` can't produce element refs. Get coordinates from `screenshot` or `screenshot-region`.

### `drag <x1> <y1> <x2> <y2>`
Drag from pixel coordinates (x1, y1) to (x2, y2). Performs mousedown, interpolated mousemove events, and mouseup. Use this for:
- Moving charts or objects in canvas-based UIs (e.g., Google Sheets charts)
- Reordering items via drag-and-drop
- Resizing elements by dragging handles
- Drawing or selecting regions

Get coordinates from `screenshot` or `screenshot --annotated`.

### `fill <ref> <value>` / `select <ref> <value> [--assert-text <text>] [--assert-value <value>] [--timeout <ms>]`
Fill text inputs or select dropdown values. Requires an element ref from `snapshot`.

For modern React/portal combobox UIs, `select` now performs additional verification and may return a warning when interaction succeeds but form state does not appear to mutate.

Useful flags:
- `--assert-text <text>`: verify downstream UI mutation (for example field label changes to `Target`)
- `--assert-value <value>`: verify selected control reflects expected value
- `--timeout <ms>`: verification timeout (default 2000ms)

### `upload <ref> <path> [path2...]`
Attach local file(s) to a file input (`<input type="file">`) using a ref from `snapshot`.

Notes:
- Use absolute file paths.
- Multiple files are supported: `upload @e3 /path/a.pdf /path/b.jpg`
- Files must exist and pass safety validation (sensitive paths are blocked).

### `type <text>`
Type text character-by-character into the **currently focused element** without needing a ref. Use this when:
- The target is a canvas-based input (no DOM ref available)
- You've already focused an element via `click` or `click-at`
- The application uses a custom input mechanism

Difference from `fill`: `fill` focuses a ref and replaces its value. `type` sends keystrokes to whatever is currently focused.

### `set-clipboard <text>` / `get-clipboard`
Read or write the page clipboard programmatically.
- `set-clipboard` writes text and interprets common escape sequences:
  - `\t` → tab
  - `\n` → newline
  - `\r` → carriage return
  - `\\` → literal backslash
- Unknown escapes are preserved literally (example: `\\x` stays `\\x`)
- `get-clipboard` reads the current clipboard text content as raw text (tabs/newlines are returned as actual characters)

### `paste <text>`
Convenience command: writes text to clipboard then triggers Ctrl+V (or Cmd+V on Mac). Equivalent to `set-clipboard <text>` followed by `key v meta`/`key v control`. Escape handling is identical to `set-clipboard`, which makes TSV-style bulk data entry reliable.

### `screenshot` / `screenshot --annotated` / `screenshot-region ...`
Capture full-window or targeted screenshots. `--annotated` overlays `@eN` labels on interactive elements for easier ref debugging.

### `console`, `network`, `wait`, `downloads`
Debug runtime issues, requests, synchronization points, and download progress.

`downloads` output includes the resolved local `savePath` when available so you can reference the downloaded file directly.

### `pick [--timeout <ms>]`
Ask the user to click an element on the page. Blocks until they click, press `Escape`, or the timeout elapses (default 120s, min 1s).

Returns a **stable selector** resolved as `data-testid` → `id` → `:nth-of-type` path, plus the tag name, trimmed text, and viewport rect. Returns `Pick cancelled or timed out — no element was selected.` when nothing was chosen.

Use this instead of guessing a CSS selector when the target is easier to point at than to describe (browser-based design/prototyping work).

### `evaluate <expression>` / `evaluate --file <path>`
Run JavaScript in the page and return what it evaluated to: `evaluate document.title`.

- **`--file <path>` runs a script kept in a file instead of one spelled out in the command.** A relative path is counted from the workspace root (`evaluate --file prototypes/cart/patches/ui-002-total.js`), `~/…` is expanded, and an absolute path is used as it is. Prefer it for anything longer than a one-line probe: the script is written once — with the Write tool, or as the patch that already exists — and the source never has to be produced a second time inside the command, nor re-escaped through the command string. The command says which file it ran and how many characters that was.
- **A probe, not persistence.** What `evaluate` runs is not registered for any future document, so a reload restores the page and the change is gone. A change that has to survive a reload — **any overlay's real change** — is a patch file (`patches/<page>/<writer>-{nnn}-{name}.js`), which `prototype-apply` injects *and* registers (see `prototype-apply` in `~/.craft-agent/docs/prototypes.md`). Use `evaluate --file` to answer a question about the page, not to leave something behind.
- Quotes and newlines survive in array mode (`["evaluate", "a(); b()"]`) and inside quotes; the result is rendered as JSON and truncated at 6000 characters, so return a summary rather than a whole document.

### `reload`
Reload the page this command acts on — your tab, or the one `--tab` names. The browser's own reload button, and the answer to *"that patch is already inlined here"*: a page of ours is rendered from the prototype's directory, so an edit to its document or to a patch it carries appears on the next render.

- **Nothing waits for the document to load.** The command returns as soon as the reload is asked for, so reading the page immediately after can answer with the old one. `wait network-idle 8000` (or `wait <selector|text|url> <value> <ms>`) before reading it, and `snapshot` again — every `@eN` ref from before is stale, which is also why a batch stops here.
- What it does to what was injected is the point of the two carriers: a live page keeps the patches `prototype-apply` registered (init scripts, which is what registering them buys) and drops anything `evaluate` ran, which was never registered.

### Prototypes — the `prototype-*` commands

Everything about prototypes has its own guide, because a prototype is a whole workflow rather than one command — what a prototype is (a flow of pages, each `scratch` or `overlay`), its files and directory layout, who owns which artifact, `prd.md` / `research/` / `reviews/`, the `patches/` layer, `prototype-commit`, verification, contracts and mocks, the deliverables, and the complete `prototype-*` command reference:

**`~/.craft-agent/docs/prototypes.md`** — read it before your first `prototype-*` command.

The short version: all prototype commands are subcommands of `browser_tool`, and a prototype is a folder under `{workspace}/prototypes/{slug}/`. `prototype-list` shows what exists, `prototype-create <name>` makes one (with no pages — write `cart.html` and that *is* the first page), `prototype-open` opens it, `prototype-apply` replays its patches, `prototype-status` reports what is there, and `prototype-export` builds the deliverable.

### The window is shared: one per workspace
There is exactly **one browser window per workspace**, and every conversation in that workspace — and you — work in it, whatever the task is: a prototype flow, or ordinary browsing with no prototype behind it. What used to be "my window" is now a **tab** in that window, which is why `tabs` exists and why nothing here is scoped to one conversation any more.

- **A window belongs to its workspace, not to a conversation.** Nothing on the window names a conversation: who is working where is a fact about its **tabs** — `driven by:` (the lease: the tab your command reached, released when your turn ends) and `locked:` (who holds it right now). That is what lets a parent and the child sessions it spawned work in one window at the same time, each in a tab of its own (see "Sessions that share a window" below).
- **Workspaces stay apart.** Each has its own window; a session in one never sees or touches another's. That is the only boundary left, and it is the one that has to be.
- **Tabs opened by other conversations are in here, and `tabs` says whose.** That is the point of sharing, and it is also the boundary: each tab prints `belongs to: agent (<session>)`, `belongs to: the task <slug>'s node <node>` or `belongs to: a person`, and `driven by:` says who is working on it at the moment. Closing is limited to the tabs of **your task** — the ones you opened, the ones handed to you, and the ones opened from them (see below) — and working on another conversation's tab is refused, prototype or not, so `--tab <id>` is a name, not a claim on somebody else's work.
- **A tab's task is inherited.** A tab a link or popup opened belongs to whatever the tab it came from belongs to — not to whoever clicked (an agent's click and a person's look the same from here, so that question has no answer). A link on your task's tab therefore lands *in your task*: it is listed under the same section, and cleaning up your tabs closes it too. A tab opened from a tab nobody owns stays nobody's.
- **A tab belongs to a piece of work, not to a conversation.** When you are part of a Task (a Conductor DAG node), your tabs say which task and which **node** they are for, not which session opened them — a tab has to outlive the session that made it. The reward is that a node **re-run** after a FAIL verdict (repair spawns a *new* child session for the *same* node) finds its predecessor's tab still in reach: `tabs` lists it (`belongs to:` names your task and your node), and `--tab <id>` carries on in it — nothing hands it to you automatically, so **read `tabs` before opening a tab**: `tab-new` always adds one. A sibling node, and the next run of the same task, are still refused: one tab, one node.
- **The window itself is nobody's to close.** `close` closes **the tabs of your task** — a DAG's node tabs included, because the orchestrator that ran the task is who tidies it up — and leaves a fresh tab if they were all of them, rather than refusing everything: the window stays, because it is the whole workspace's. There is no second kind of window for it to destroy instead.

### Tabs in a window: `tabs`, `tab-new`, `tab-show`, `tab-assign`, `tab-close`, `--tab <id>`
A browser **window** is a container and a **tab** is the thing in it, so several prototypes are looked at at once by being several tabs of one window rather than by being several windows. A tab carries its own address, title, console, theme colour and — for an overlay, whose document is a third-party address — **the prototype it is for**: that is the only place the identity can live, since nothing in the URL would say it after the view loads.

- `tabs` — this window's tabs in the order they were opened, each with what it is, whose task it is in and who is working on it. This is also how tab ids are discovered.
- `tab-new [url]` — add a tab to the window, **behind whatever the person is reading**. Opens into the window's own untouched tab when the window has never been used.
- `tab-show <id>` — bring a tab up for the person to look at. This is the **only** command that changes which tab the window shows.
- `tab-assign <id> <session>` — hand one of **your** tabs to another conversation: it becomes that conversation's task and the tab it works from. This is how a parent gives each child session a tab of its own to work in (see "Sessions that share a window").
- `tab-close <id>` — close one tab **of your task**. Closing the last tab closes the window, and the output says which of the two happened.
- `--tab <id>` on **any** command — name the tab it acts on, without moving the window. Without one a command acts on the tab you have been working from (see "Where a command lands" below).

**What `tabs` prints is in three kinds, and the difference matters:**

- **what the tab reports** — its real address (for an overlay, the live site's own, never the prototype's), its title, whether it is loading, which prototype it is for and which page of that prototype it is on. One producer: the tab. Nothing here can disagree with the document it describes.
- **whose task it is in** — `belongs to: agent (session-…)` for a conversation's own tab, `belongs to: the task <slug>'s node <node> (opened by <session>)` for a Task's DAG tab, or `belongs to: a person`. Written when the tab is created, or **inherited** from the tab it was opened from. This is the only way to tell your own tabs from everybody else's, and the reason it is printed separately: it is a statement about the work, not something measured.
- **who is working on it** — `driven by: <session>` or `nobody right now`. A **lease**: the conversation whose command reaches a tab is driving it, the turn ending releases it. It says nothing about who the tab belongs to. `locked:` is the stronger state: the tab is held right now, so nobody else may touch it until that turn ends.

**Two questions, two rules.** *May I work here?* A tab is yours to work on when it is **the same piece of work** — your own conversation, or the same node of the same run of the same task (you opened it, it was handed to you with `tab-assign`, or it was opened from one of your tabs — so `prototype-open` on a prototype you are not bound to still works) — or when **nobody has claimed it yet**: a tab the person opened, or a fresh one, which you may take over. Everything else is another conversation's tab, or another node's, and is refused, prototype or not — two conversations working on the same prototype do not share its tabs, which is what keeps parallel sessions out of each other's way. *May I close it?* Anything **of your task**, whichever node of it opened it: the user's tabs, and another task's, are not yours to close however convenient it would be. The two answers are deliberately different widths — working in a tab is the precise question, and tidying up after a finished task is the loose one, because the nodes that opened those tabs have stopped by then.

**A tab can be held; the window cannot.** While a conversation is working on a tab — its overlay is up for that turn and that tab is the one it holds — **that tab is held**: a person cannot click or type into it, and another conversation's command that names it is refused with "it is held while session-… works on it, until that turn ends". Everything around it stays free, for the user and for other conversations alike: the tab rail, the address bar, the window's size, and every other tab — and **several conversations can hold their own tabs at the same time**, which is what makes parallel work possible. The hold names **one tab id** rather than being derived from wherever a command landed, which is what keeps it off the tab the person happens to be looking at; it is dropped when that tab is closed, and the person can drop it themselves — the lock mark in the rail is a button, and clicking it releases the overlay that holds the tab. So `release` is not the only way out, and a hold can end earlier than your turn: do not assume the tab is still yours between two commands.

That is deliberately narrower than locking the window, which is what this used to do: one window is shared by the whole workspace, so holding *the window* held the user's own browsing and everybody else's tabs with it. Holding the tab you are actually working on costs nobody anything but a wait — and a command that would rather not wait can name another tab with `--tab <id>`.

### Sessions that share a window: parents, children, and `tab-assign`
A session spawned by another one (a Task's DAG node, or a session an agent delegated to with `spawn-session`) shares its parent's browser window — there is one per workspace — and works in **a tab of its own**. Two rules make that work instead of interfering:

- **It does not take over the tab on screen.** A conversation with no tab of its own normally adopts the tab in front of the person; a child session is refused instead, and told how to get one: `tab-new` opens a tab, or the conversation that spawned it hands one over with `tab-assign <tab-id> <child-session>`. That is what a parent does before starting several nodes at once — one tab each, handed over before the node runs.
- **It does not move what the person sees.** `tab-show` on a child session makes the tab its own but leaves the window showing the person's tab, and the output says so. The window-level ways to take over someone's view — `open` in the foreground, `focus`, `hide` — are refused for a child as well. A child's work happens behind them; if the person should look at something, the parent brings it up.

`tab-assign` is a plain handover: the tab's **work** becomes the receiver's — its node, when the receiver is a DAG node's session — it becomes the tab the receiver works from, and the giver loses it — its cursor and its hold go with it, or the giver would keep working from a tab it just gave away. Only a tab that is **yours or nobody's** can be handed on: you cannot pass along another conversation's work, and a tab you already gave away is not yours to give again. Because the tab records the node rather than the session it was handed to, a node that gets re-run picks its tab back up (see "The window is shared").

**Which prototype a command means** is read off the tab it acts on: your own tab first (see below), and when you have none yet, the tab in front of you — and only then does it fall back to this conversation's binding for a tab that belongs to none. That is what lets one conversation work on several prototypes without binding any of them: `--tab` picks the tab, and the tab says whose it is.

A page whose address the prototype's own page table does not describe says so (`none of the prototype's pages`) rather than being given the nearest page name — a file, an SPA route, or a page that belongs to another flow entirely.

**A click that wants its own window opens a tab.** `target="_blank"`, `window.open` and popups all become tabs of the same window, inserted right after the tab that asked, so nothing ever opens a bare Electron window with no toolbar and no patches. Two consequences worth knowing: such a tab has no `window.opener` (a popup waiting for a `postMessage` from the tab that opened it — Google's sign-in is the usual one — waits forever), and it cannot close itself (Chromium only lets scripts close windows that scripts opened), so it stays in the strip until you or the user closes it. `tabs` says which way a tab was asked for (`opened as: …`) when it was the browser that asked.

`--tab` is read off the command before the command parses its own arguments, so it never becomes part of an argument: `evaluate document.title --tab tab-2` evaluates `document.title`. A `--tab` with no id is refused rather than falling back to the tab on screen — running somewhere else is the one outcome a named target exists to prevent.

**Where a command lands is your tab, not the tab on screen.** A command that names no tab acts on the tab this conversation has been working from — its **cursor**, marked in `tabs` as `your tab: …`, and named in the summary as `cursorOf`. You get one by naming a tab (`--tab <id>`, which also makes it yours), by opening one (`tab-new`, `prototype-open`), or by being handed one (`tab-assign`); with none yet, a command adopts the tab the person is looking at, and that tab becomes yours from then on — except for a session spawned by another one, which is refused rather than adopting (see "Sessions that share a window"). The point of the order is that **the person switching tabs cannot retarget your work**: what they look at is theirs to move. The cursor survives your turn ending, so the next turn continues where this one worked; if the tab it points at is closed, the next command falls back to the tab on screen again.

**Your work happens in the background, and the person's view is not yours to move.** Naming a tab with `--tab`, opening one with `tab-new` or `prototype-open`, and every command that follows all leave the window showing whatever tab the person was on: a click, a screenshot, a patch and a console read land on *your* tab whether or not anybody is looking at it. The window is shared, so this is what makes it usable by both of you at once — the person reading another tab of it is not interrupted, and their tab-switching still cannot retarget you. The one exception is `tab-show <id>`, which is exactly the request to move their view: use it when the point of the command is that somebody looks at the tab — and note that for a child session even that does not move it (see "Sessions that share a window").

Reading, switching and closing tabs do **not** open a window — a tab lives in a window, so a workspace with none has no tabs, and `tabs` says so instead of opening an empty one.

**In the app**, every window has a **tab rail** down its left edge: one row per tab (the one on screen is raised, a tab the agent opened is marked, a tab being worked on carries a **lock** — which is also the button that takes it back), a close button on each, and a `+` for a new tab. It is always there, including with a single tab — the `+` is how a person opens something themselves, and a window with one tab is exactly when they want a second one. The same tabs appear in the window's badge in the app's top bar, grouped under that window, for when the window itself is not in front.

### `focus [windowId]`
Bring the browser window to the front without making a new one. There is **one window per workspace**, so there is nothing to list and no window to choose between: with no id this focuses the workspace's window, and the output says what it is showing. What each *tab* of it is, whose task it is in and who is working on it is `tabs`. A session spawned by another one is refused here: the window is the person's view (see "Sessions that share a window").

### Lifecycle commands
- `release` — dismiss the agent overlay, which also releases the tab hold it had. The hold is **on the tab**, not the window: the rail, the address bar, the window's size and every other tab were never blocked by it. Other conversations' holds are theirs, and are not touched.
- `hide` — hide window but preserve session state (refused for a child session: it is the person's view)
- `close` — close **the tabs in your task** (a fresh tab takes their place if they were all of them), and say so; the window itself belongs to the workspace and is never closed by a conversation.

---

## Common validation errors

- `Missing command...` → pass a command string (try `--help`)
- `Unknown browser_tool command ...` → typo/unsupported verb; check help
- `...requires ...` → required argument is missing for that command
- `...must be numbers` → numeric argument parse failed

---

## Secondary helper: `browser-tool parse-url`

Use this for safe URL debugging in Explore mode without running a generic interpreter snippet:

```bash
bun run browser-tool parse-url https://example.com/path?q=1#hash
bun run browser-tool parse-url file:///Users/me/Desktop/report.html
```

Output is deterministic JSON (`href`, `protocol`, `host`, `hostname`, `pathname`, `search`, `hash`, `origin`, plus `basename` for `file://` URLs).

---

## Behavior notes

- Browser tools are allowed in **Explore/Safe mode** by default.
- Before first browser tool usage, the agent must read this guide (`~/.craft-agent/docs/browser-tools.md`).
- Closing browser UI via OS controls may hide the window; use `browser_tool close` for explicit teardown.

---

## Recipe: Canvas-based UIs (Google Sheets, etc.)

Canvas-based web apps (Google Sheets, Google Docs, some map/chart UIs) render content as pixels on `<canvas>` — individual cells or elements are not DOM nodes and won't appear in `snapshot`. Use these patterns instead:

### Google Sheets workflow

```text
# 1. Navigate and wait for load
navigate https://docs.google.com/spreadsheets/d/{id}/edit
wait selector [aria-label="Name Box"] 10000

# 2. Navigate to a cell via Name Box (a DOM element — snapshot finds it)
snapshot
click @nameBoxRef
type A1
key Enter

# 3. Edit a cell
key F2
type Hello World
key Enter

# 4. Bulk write via TSV clipboard paste
snapshot
click @nameBoxRef
type A1
key Enter
paste Name\tAge\tCity\nAlice\t30\tNYC\nBob\t25\tLA

# 5. Read data via clipboard
key a meta           # Select all (Cmd+A)
key c meta           # Copy (Cmd+C)
get-clipboard        # Returns TSV string

# 6. Click a canvas cell by coordinates (from screenshot)
click-at 350 200

# 7. Move a chart by dragging (coordinates from screenshot)
drag 400 300 100 50

# 8. Read data via export URL (no editing needed)
navigate https://docs.google.com/spreadsheets/d/{id}/export?format=csv&gid=0
```

### Key principles for canvas UIs
- **Name Box and formula bar are DOM elements** — `snapshot` can find them
- **Cells are canvas pixels** — use `click-at` or keyboard navigation, not `click`
- **Charts and objects are moveable** — use `drag` to reposition elements on the canvas
- **Keyboard shortcuts are more reliable than clicking** — use `key` for navigation
- **Clipboard TSV is the fastest bulk data path** — `paste` with tab-separated values
- **Export URLs work with session cookies** — no API key needed for reads

---

## Troubleshooting

### "Browser window controls are not available"
The desktop browser manager isn’t wired for this runtime/session. Ensure you’re in the Electron desktop app and session is initialized.

### "Element @eX not found"
Refs are stale. Re-run `snapshot` and use fresh refs.

### Interaction feels flaky
Wait for page readiness and retry using:
`open` → `snapshot` → interaction
