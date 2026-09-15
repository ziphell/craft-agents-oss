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

If you're unsure which window to use, run:

```text
browser_tool({ command: "windows" })
```

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
browser_tool({ command: "evaluate document.title" })
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
browser_tool({ command: "windows" })
browser_tool({ command: "release" })
browser_tool({ command: "hide" })
browser_tool({ command: "close" })
```

The wrapper validates commands and returns actionable errors when arguments are missing or invalid.

It also returns rich execution feedback for most commands, including before/after state where available (scroll positions, active element, URL/title transitions, resize clamping, request/error summaries, and window ownership/visibility details).

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

### `prototype-apply <slug>` / `prototype-clear <slug>`
Replay (or remove) a prototype's patches in the current browser.

A prototype lives under `{workspace}/prototypes/{slug}/` and its patches are ordinary files named `{lane}-{nnn}-{slug}.{css|js}`:

```
prototypes/checkout-flow/patches/A-001-btn-radius.css
prototypes/checkout-flow/patches/A-002-flow-guard.js
```

- Files that do not follow the naming convention are ignored (READMEs, editor backups, dotfiles), so nothing unexpected gets executed.
- Replay order is `lane` → numeric order → file name.
- Patches are applied to the current page **and** registered for every future document, so they survive a reload. The index is recomputed from disk on every `prototype-apply`, so editing a patch file and re-running the command is all that is needed — deleting a patch file also un-applies it.
- `prototype-clear` unregisters a prototype's patches; the current document keeps their effects until you reload.

### `prototype-export <slug>`
Write the prototype's deliverables into `prototypes/{slug}/dist/`:

- `prototype.html` — one self-contained file (css inlined into `<head>`, js inlined before `</body>`), so it runs standalone with no network and no workbench.
- `dev-spec.md` — the change list: every patch in replay order, with its lane, kind and full content.

The command prints a URL for the HTML. Each prototype is served from its own loopback HTTP origin — `http://<slug>-<hash>.localhost:<port>/…`, with the prototype's directory as that origin's root — rather than `file://`, which has an opaque origin: no cookie jar, no relative `fetch`/XHR (so the mock layer would never see a request) and no ES modules. Root-absolute paths (`/assets/app.css`) and SPA history routes therefore work. Verify the deliverable the same way you view anything else:

```
navigate http://checkout-flow-9f3a2b1c.localhost:9793/dist/prototype.html
```

Exports fail with a clear error when the prototype has no `base.html` — there would be nothing to apply the patches to.

### `prototype-contract-compose <slug> [--service <svc>]`
Compose the API contract fragments into one spec.

A service lives under `prototypes/{slug}/services/{svc}/`:

```
services/checkout-api/config.json          baseUrl / authType / title
services/checkout-api/paths/list-orders.yaml   OpenAPI path items (a `paths:` block or bare `/…` keys)
services/checkout-api/fixtures/list-orders-200.json
```

`paths/*.yaml` are the source of truth; `openapi.yaml` is generated from them and should not be edited by hand. Each operation may declare what to serve while the backend does not exist yet:

```yaml
paths:
  /orders:
    get:
      summary: List orders
      x-mock:
        status: 200
        fixture: list-orders-200   # → fixtures/list-orders-200.json
      responses:
        '200': { description: OK }
        '500': { description: Boom }
```

The command reports duplicate paths (last fragment in file-name order wins) and `x-mock` fixture references that have no file. With more than one service present, pass `--service`.

### `prototype-contract-export <slug> [--service <svc>]`
Write the backend-facing deliverables into `dist/`:

- `openapi.yaml` — the composed contract.
- `contract.md` — endpoints table, declared error responses, auth, and any `x-contract` notes.
- `fixtures/*.json` — the response samples.

`contract.md` deliberately calls out what is **not** declared (no error responses, no `authType`, no `x-contract` notes covering pagination/idempotency/concurrency) so an incomplete handoff is visible rather than silent.

### `prototype-mock-apply <slug> [--service <svc>]` / `prototype-mock-clear`
Serve the contract's `x-mock` responses so the prototype runs before the backend exists.

Interception happens in the browser's **network layer** (CDP `Fetch`), which means:

- `fetch` **and** `XMLHttpRequest` (axios et al.) are both covered, along with every other resource type — nothing is monkey-patched into the page.
- The app does **not** need to point at a mock server: requests are matched by pathname, so absolute URLs, `baseUrl`-prefixed URLs and same-origin relative paths all hit.
- Fulfilled responses carry `access-control-allow-origin: *`, since cross-origin calls would otherwise be blocked by CORS even though we are the one answering.

The command reports endpoints that declare no `x-mock` (they pass through to the real backend) and `x-mock` fixtures that have no file — those routes are **skipped rather than served empty**, because a silently-empty response is far harder to debug than a 404.

`prototype-mock-clear` stops intercepting; requests fall through to the real network again.

While the mock is active the debugger stays attached — CDP drops interception on detach, so the client deliberately holds it.

### `prototype-status <slug>`
Read-only report on a prototype:

```
Prototype "checkout-flow"
  dir:        /…/prototypes/checkout-flow
  base.html:  present
  patches:    3 (A: 2, B: 1)
  service checkout-api: 4 endpoints, 3 mocked, 2 fragments, 2 fixtures
  dist:       prototype.html, dev-spec.md, openapi.yaml, contract.md
  ownership:  1 violation(s)
    • patches/oops.css — misnamed patch — expected {lane}-{nnn}-{name}.{css|js}
```

**Ownership** is how parallel work stays safe here: every artifact path belongs to exactly one writer, and lanes never write each other's files. The check flags three things that are otherwise silent:

- a patch whose lane prefix is not a declared lane (`patches/Z-…`) — it would never be replayed;
- a misnamed patch (`patches/oops.css`) — the patch scanner ignores it;
- a path no lane or the control plane owns (`README.md`, `services/*/random.txt`).

Declared lanes: `A` UI/interaction (patches), `B` service contract (`paths/`, `config.json`), `C` data (`fixtures/`), `D` verification (read-only). `base.html`, `services/*/openapi.yaml` and everything under `dist/` are control-plane outputs.

### `prototype-open <slug>`
Open a prototype in the browser.

Opens the prototype's **origin root**, which the workbench serves as `base.html` rendered with every patch applied — computed per request, so it is byte-identical to what `prototype-export` would write right now. That is why the address is not a file: pointing at `base.html` would show none of the patches, and pointing at a previously exported `dist/prototype.html` would show a document frozen at export time. Individual files stay openable by name (`/base.html`, `/dist/prototype.html`).

When there is no `base.html` to render (deleted after exporting), the address falls back to the frozen deliverable. With neither file the command fails with both remedies named, rather than letting the browser show a confusing load error.

Starting from nothing needs no special command: write `prototypes/{slug}/base.html` (the agent's `Write` tool is allowed to), then run `prototype-open`.

### `focus [windowId]` / `windows`
Manage and inspect browser window ownership and visibility.

### Lifecycle commands
- `release` — dismiss agent overlay, keep window visible for user
- `hide` — hide window but preserve session state
- `close` — close and destroy window

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
