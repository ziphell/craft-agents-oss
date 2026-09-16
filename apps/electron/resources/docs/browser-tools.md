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
browser_tool({ command: "tabs" })
browser_tool({ command: "snapshot --tab tab-2" })
browser_tool({ command: "tab-new https://example.com" })
browser_tool({ command: "tab-close tab-2" })
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

### `prototype-create <name> [--no-bind]`
Create a prototype: a **container for pages**, and nothing else. Creation asks for a name and nothing more — no kind and no address, because both of those are facts about a *page* — and it creates no page at all: "this prototype has no pages yet" is a true statement, not a broken state. `--no-bind` leaves the session's current binding alone, which is what studying another prototype needs.

Pages arrive afterwards, one of two ways: write `<name>.html` for a page of ours (the agent's `Write` tool is allowed to), or add a live page with `prototype-pages --add <name>=<url>`.

### Writing a page of ours (the shape to copy)

A page of ours is an ordinary HTML document — no build step, no template language — and the prototype's
directory *is* the origin root. Every new prototype starts with a shell (`_layout.html`) that wraps each of
its pages, so a page carries only its own screen and reuses the shell's tokens:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cart</title>
</head>
<body>
  <div class="app">
    <h1>Cart</h1>
    <section class="card stack">
      <div class="row"><span>Delivery</span><span class="muted">Free</span></div>
      <button class="row">Checkout</button>
    </section>
  </div>
</body>
</html>
```

`var(--accent)`, `.card`, `.row`, `.stack` and `.muted` come from the shell, as do the scale tokens behind
them (`--size-2`, `--gray-8`, `--radius-2`). Prefer the meaning, reach for the scale when there is no word
for what you need. **Do not copy the frame** (header, nav, tokens) into a page — that is what `_layout.html`
is for, and two copies drift.

What bites later, in order of how often it does:

- **Reach for standard HTML before writing any JS**: `<details>` for disclosure, `<dialog>` for modals,
  `:has()` / `:checked` for state-driven styling, `required` / `pattern` / `minlength` on inputs for
  validation, `<template>` + `<slot>` for reuse. Most prototype interaction needs no script at all — and
  the standard version behaves identically in the preview and in the delivered package.
- **Assets use root-absolute paths** (`/assets/app.css`). No CDN and no external host: the prototype is
  opened offline and only its own directory answers. Files under `assets/` travel with the package (text
  files as they are; a binary such as an image is reported as not delivered yet, rather than arriving broken).
- **Check the page after writing it**: `prototype-open`, then `console 50 error`. Nothing else in the
  workbench validates a page, so a thrown error is invisible until someone looks.
- **No `eval` and no `new Function`** — the delivered extension forbids them and the export would fail.
  **No bundler**: plain `<script>`, `<style>`, and `<script type="module">` with relative imports are fine.
- **Reuse has two places, not a third**: shared structure goes in the shell, shared helpers go in
  `assets/lib/` (the JS shape below). There is no template engine, by design.
- **Data**: `fetch('/api/…')` (relative), answered by the contract's fixtures when mocked. State belongs in
  `localStorage` — the prototype's origin is stable, so it survives.
- **Add a screen by writing a page; change how an existing screen looks by writing a patch** under
  `patches/<page>/`. Rewriting a page document to restyle it is the one thing that is always wrong.

#### Vanilla JS that survives (the shape to copy)

One module per page, loaded by that page alone:
`<script type="module" defer src="/assets/pages/cart.js"></script>`. Relative imports stay inside the
package, so the same file runs in the preview and in the delivered extension.

```js
// assets/pages/cart.js
import { formatMoney } from '../lib/format.js'

const HOOK = { list: '[data-cart-list]', row: '[data-cart-row]', total: '[data-cart-total]' }

function init(root = document) {
  const list = root.querySelector(HOOK.list)
  if (!list || list.dataset.cartReady) return // idempotent: this may run again
  list.dataset.cartReady = 'true'

  // Delegation: rows added later are covered without rebinding.
  list.addEventListener('click', (event) => {
    const row = event.target.closest(HOOK.row)
    if (!row || !list.contains(row)) return
    render(root)
  })

  render(root)
}

async function render(root) {
  const total = root.querySelector(HOOK.total)
  if (!total) return
  try {
    const res = await fetch('/api/cart') // relative: the contract's mock answers this
    if (!res.ok) throw new Error(String(res.status))
    total.textContent = formatMoney((await res.json()).total)
  } catch {
    total.textContent = '—' // a missing fixture has to be visible, not a blank screen
  }
}

init()
```

| Do | Don't |
| --- | --- |
| `[data-…]` as JS hooks | classes as hooks — classes are the patches' territory |
| Idempotent `init` (a `dataset.xReady` guard) | assuming it runs once |
| Delegate to a container, then `closest(...)` | binding every row |
| `textContent` / `classList` / a `<template>` clone | building markup with `innerHTML` |
| URL and `localStorage` as the truth (the origin is stable) | state in memory only |
| `fetch('/api/…')` relative, with its error branch | absolute hosts and no mock behind them |
| One module per page, shared helpers in `assets/lib/` | a pile of globals per page |
| Making failure visible | a silent `catch {}` |

Four boundaries, and keeping them apart is what stops a prototype from rotting: **structure changes go in a
patch, behaviour goes in a page's module, shared structure goes in the shell, shared helpers go in
`assets/lib/`.**

### Where a requirement, a finding and a change go

Three kinds of file, three jobs, and **all of them are yours to write** — nothing
in the workbench generates them:

- **`prd.md`** — the requirements. One entry each, headed by a stable id:
  `## R-001 A cart holds its line until stock runs out`, then the prose under it
  (who it is for, what happens today, what has to be true). The id is what every
  other file refers to, so keep it stable when you rewrite the prose around it.
- **`research/`** — what you learned about other products, one finding per file:
  `# F-001 <what you found>`, then labelled lines `claim:`, `source:`, `captured:`,
  `evidence:`, `requirements:`. Evidence names files you keep in `research/`
  (screenshots go there). Deliberately **not** packaged: the reader receives the
  requirements, not your notes.
- **`patches/` and the page documents** — what changed, each one declaring what it
  serves: `@requirement R-001` in a patch header, or in a comment in the page
  document it changes. `prototype-status` turns those markers into the two answers
  nobody can get by reading files one at a time: a requirement nothing implements,
  and a marker naming an id the PRD does not define. `dist/dev-spec.md` carries the
  same table to whoever receives the delivery.

Both `prd.md` and `research/` are ordinary files — write them with the Write tool
like any other, and read them before re-studying something. They also appear in the
bound prototype's context block, so a session starts knowing what was already found.

### `prototype-record start` / `prototype-record stop [slug]`

Keep frames of this window, then write them under the bound prototype's `research/`.

A screen changes for two different reasons, and the capture keeps both:

- **it moved on its own** — the screen is compared every `--interval` ms (default 400) and a frame is kept
  when more than `--threshold` of it changed (default `0.005`). This is what catches a page that streams:
  a chat answering, a list filling in, an animation.
- **somebody did something** — every action taken on the page (a click, typing, a key, a navigation) is
  kept whatever the screen did, plus a second frame a moment later to catch what it produced. A click that
  changed nothing is still a click somebody made, and `index.md` says so.

`stop` writes them to `prototypes/<slug>/research/frames/<session>/` as `frame-0001.jpg` upward, with
`frames.json` (machine-readable) and `index.md` (the same table, for a person) beside them. Each frame
carries its address, the page it was on and why it is there — a wall of images with no coordinates is a
wall of images, nothing in it can be cited.

`--max <n>` caps a capture (default 60); a capture that hits the ceiling says so rather than quietly
dropping the difference. Frames are deliberately **not** in the delivered package: they are how the
requirements were reached, not part of what the reader receives.

Cite them from a finding's `evidence:` line — `evidence: frames/20260915-183012/frame-0004.jpg`.

**Importing a recording.** `prototype-record import <path>` samples a video you recorded elsewhere (a phone,
Loom, QuickTime). `--every 2s` sets the interval, `--changes` keeps only the moments that moved, `--max 40`
caps the frames. The recording is copied into `research/videos/` first — a capture whose source has been
cleaned up cannot be re-sampled, and re-sampling is most of what a source is for. Decoding is Chromium's, so
nothing needs ffmpeg: a codec it cannot read (HEVC/H.265, ProRes, some `.mov`) fails with a message saying so,
rather than producing a capture of one frame. Imported frames carry their position in the recording
(`imported [0:12.4]` in `index.md`), which is the coordinate a reader of a video can actually use.

The panel's Frames section has the same thing behind a button — the picker runs in the main process, so no
path ever passes through the page.

### `prototype-verify [slug]`

Run the acceptance checks the PRD puts under its requirements. Two kinds, both mechanical — an acceptance
criterion only a person can judge is one nobody runs:

- `check: selector [data-cart-total]` — asserted against the page this session's window is on
- `check: endpoint GET /api/cart` — asserted against the contract

An unsupported kind is refused when the PRD is parsed rather than silently skipped: `check: expression …`
would otherwise look like a criterion that is being verified when nothing is looking at it. With no page
open, page checks come back **skipped**, not failed — "could not look" is not "not there", and collapsing
the two would make a verification worth running only once.

The run writes `dist/acceptance.md`, a deliverable beside the change spec for the person who has to accept
the work. It changes nothing else: a failing check leaves the prototype exactly as it was.

### `prototype-apply <slug>` / `prototype-clear <slug>`
Replay (or remove) a prototype's patches in the current browser.

A prototype lives under `{workspace}/prototypes/{slug}/` and its patches are ordinary files named `{lane}-{nnn}-{slug}.{css|js}`:

```
prototypes/checkout-flow/patches/A-001-btn-radius.css          ← every page
prototypes/checkout-flow/patches/cart/A-002-flow-guard.js      ← the page `cart` only
```

- Files that do not follow the naming convention are ignored (READMEs, editor backups, dotfiles), so nothing unexpected gets executed.
- Replay order is `lane` → numeric order → file name.
- **Where a patch sits is which page it changes**: `patches/*` applies to every page of the flow, `patches/<page>/*` to that page alone. A directory that matches no page is reported by `prototype-status` rather than silently replayed.
- Which patches this command replays follows the **window**: the page it is on brings the shared patches plus its own, and a window on no page of the prototype gets the shared ones only — the command says which page it used, so "the patch did nothing" and "the patch belongs to another page" read differently.
- Patches are applied to the current page **and** registered for every future document, so they survive a reload. The index is recomputed from disk on every `prototype-apply`, so editing a patch file and re-running the command is all that is needed — deleting a patch file also un-applies it.
- A page the host rendered (a page of ours, served from the prototype's own address) arrives with its patches already inlined, so there is nothing to inject into it; that is reported as *nothing to inject*, not as a failure. Patches written since that render still land on it.
- **A patch may declare what it is aimed at**, with `@target <css selector>` in its header (next to `@requirement R-001`, which says what it is for). The command then **counts** what each declared selector matched and says so:
  - a selector that matched nothing and has never matched is named — the selector is wrong, or the page is not the one it was written against;
  - a selector that matched before and does not now means the page moved, and the command offers selectors that resolve to exactly one element on the page today (a **re-anchor**, not a rewrite);
  - a patch with no `@target` is named as unchecked rather than treated as a clean run.
  Every successful match is recorded under `prototypes/{slug}/anchors/` — that record (selector, what the element looked like, when it last matched) is what makes "it stopped matching" distinguishable from "it never worked". Nothing in `anchors/` is rendered, replayed or packaged: it is evidence *about* the page.
- `prototype-clear` unregisters a prototype's patches; the current document keeps their effects until you reload.
- Saving a file under `patches/` or `assets/`, or a page document, replays the prototype into every window that is showing it (a page of ours reloads, a live page is re-patched) — no apply needed. The switch for that is on the prototype's page in the app.

### `prototype-commit <slug> [--page <name>]`
**Fold the change layer into what owns it.** A prototype is a working set of patches on top of a page that is not ours; this is the operation that collapses that layer when the work has stopped moving, so the prototype converges instead of accumulating deltas forever.

Where the fold lands is decided by whose the page is:

| page | folded into |
|---|---|
| **ours** (`scratch`) | CSS → `assets/<page>/committed.css`, JS **promoted** → `assets/<page>/committed.js`; the page document gets a `<link>` and a `<script src>` (each added once) |
| **a live address** (`overlay`) | `patches/<page>/Z-001-upper.css` and `Z-002-upper.js` — a consolidated patch, which replays **after** every other patch by rule |

- **JS is promoted, not folded**: a script is behaviour, and folding behaviour into a static document would mean rendering the page and serializing the result — which loses the readable document (and is why "freeze the live page" was never a thing here). Moving it into a file of ours is the same collapse: it stops being a delta and becomes source.
- Each folded change leaves a **provenance header** naming the patch it came from, the date, and the markers it carried (`@requirement`, one `@target` per line) — so the anchors recorded for it and the requirement it serves survive the fold.
- **The folded patch files are deleted.** That is what makes this the one prototype action with no undo: use your own git if you need the before and after, and commit when you mean it rather than after every change.
- What it cannot do, it says: a page of ours whose document is missing is **refused** (nothing is deleted), and a folded CSS patch with no `@target` is listed as not checked. Running it twice reports "nothing to fold" instead of writing an empty file.
- `--page <name>` folds that page's own patches only; the shared ones (`patches/*`) and other pages are left alone. Without it, the shared patches fold into `patches/Z-001-upper.css` and every page's own fold into its own place.
- Folding a page of ours also drops that page's anchor records: the elements now live in a file we own, so there is nothing to drift against. A live page's records are kept — its address is still someone else's.

### `prototype-export <slug>`
Build the prototype's deliverable into `prototypes/{slug}/dist/`:

- `extension/` — **a loadable Chrome extension covering the whole flow**, and the only thing to hand over. Nothing is published to a store: the recipient opens `chrome://extensions`, turns on **Developer mode**, and clicks **Load unpacked** on this folder. One package, whatever the flow is made of:
  - **pages of ours ship in it** — each document under the name it has on disk (`cart.html`), so the links an author wrote between pages keep working; each carries only the patches that apply to it (the shared ones plus its own), and the layout shell is applied exactly as the host applies it.
  - **live pages are injected into** — one content script per live page, which Chrome itself scopes to that page's address. The patches are simply there when the page loads: nothing to click, and they survive a reload. `README.md` says where it applies. Nothing is copied or frozen, so the page keeps its own JavaScript, session and data.
  - The extension's **options** page is the generated **page index** (every page with a way into each: our documents are package files, live pages are their addresses), and the toolbar icon opens the entry page — the index when no page is marked as the entry.
  - The package carries the contract's `x-mock` routes when there are any: a script in the page's own world (`world: "MAIN"`, `document_start`) answers them by wrapping the page's `fetch`/`XHR`, and `README.md` lists exactly which requests are faked — and what that cannot cover (requests a PWA's own service worker makes never pass through the page).
  - The package carries a `version` and a build time, so "which build am I looking at?" has an answer. The package is a **snapshot**: after a re-export, press **Reload** on the extension in `chrome://extensions` (and refresh the page) to pick the change up.
  - An extension page cannot run inline script (MV3's CSP, and `eval` is out), so an inline `<script>` block is hoisted into a file and an inline `on<event>="…"` becomes a generated function a small runtime binds. Behaviour is unchanged, and every such change is reported back in the command's output, named per page.
  - It fails with a clear error when there is nothing to hand over: no pages at all, a page in the table whose document is gone (named), or a live page whose address cannot become a match pattern (also named).
- `dev-spec.md` — the change list, **grouped by page**: every patch in replay order with its lane, kind and full content. The shared patches (`patches/*`) are listed once, and each page says how many of them it also carries.

Keep the patch set small and delete patches that no longer change anything: all of them ship in the package, and everything in it is something a reviewer has to read. Patches are shipped unminified on purpose — the recipient runs this on their own page, and being able to read it is what makes that reasonable.

The command prints the package's path and, when there is a page of ours to open, a URL for it inside the package. Each prototype is served from its own origin — `http://<slug>-<hash>.localhost/…`, answered by Electron itself (no port, so the address is the same on every run), with the prototype's directory as that origin's root — rather than `file://`, which has an opaque origin: no cookie jar, no relative `fetch`/XHR (so the mock layer would never see a request) and no ES modules. Root-absolute paths (`/assets/app.css`) and SPA history routes therefore work. To look at the packaged page before handing it over:

```
navigate http://checkout-flow-9f3a2b1c.localhost/dist/extension/cart.html
```

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
  openable:   yes
  pages:      cart (scratch) [entry] — cart.html
              orders (scratch) — orders.html
              pay (overlay) — https://app.example.com/pay
  root:       opens "cart"
  page issues: 1
    • patches/nope/ belongs to no page of this prototype, so nothing there is replayed. Pages: cart, orders, pay
  patches:    3 (A: 2, B: 1) — 1 page-scoped, 2 shared
  service checkout-api: 4 endpoints, 3 mocked, 2 fragments, 2 fixtures
  dist:       extension/, dev-spec.md, openapi.yaml, contract.md
  ownership:  1 violation(s)
    • patches/oops.css — misnamed patch — expected {lane}-{nnn}-{name}.{css|js}, optionally under patches/<page>/
```

A prototype with no pages yet prints `pages: none yet` and `openable: no` — that is a starting state, not an error. `root:` says what the address root opens: a page name, or the generated page index. Entries of `pages` that could not be read, a declared page whose document is gone, and a `patches/<name>/` that matches no page are all listed as `page issues:` — a dropped page is a screen the flow no longer has, and a patch directory nothing reaches is a change that never lands, so neither is silent.

**Ownership** is how parallel work stays safe here: every artifact path belongs to exactly one writer, and lanes never write each other's files. The check flags three things that are otherwise silent:

- a patch whose lane prefix is not a declared lane (`patches/Z-…`) — it would never be replayed;
- a misnamed patch (`patches/oops.css`) — the patch scanner ignores it;
- a path no lane or the control plane owns (`README.md`, `services/*/random.txt`).

Declared lanes: `A` UI/interaction (patches), `B` service contract (`paths/`, `config.json`), `C` data (`fixtures/`), `D` verification (read-only). The page documents (any top-level `.html`, `_layout.html` included), `config.json`, `services/*/openapi.yaml` and everything under `dist/` are control-plane outputs. Which lane owns a patch is still the prefix in its file name — a `patches/<page>/` directory only says *which page* it changes.

### `prototype-open <slug>`
Open a prototype in the browser, and replay its patches into what opens.

A prototype is a **flow of pages**, and each page is one of two kinds — which is what decides where opening it goes:

- **a live page** (`overlay`) — the real address it records, with the patches injected into it. That page brings its own JavaScript, its own session and its own data; nothing is copied or frozen, because a copy could not run any of that and would only *look* like the page. Opening it and stopping there would show the target page rather than the prototype, so the replay is part of this command.
- **a page of ours** (`scratch`) — the prototype's **own address**, where the workbench renders it: `/` renders the entry page and `/<name>.html` renders that page, and either way the document is rendered with the patches it carries (the shared ones plus its own), computed per request, so it always shows the patches that exist now. A top-level `.html` is therefore never served raw, and the copy inside a previously exported package (`/dist/extension/cart.html`, a file in a subdirectory) is a document frozen at export time rather than the page.

With no `--page`, "open the prototype" means the page the bound browser window is already on, then the entry page, then the generated page index — so a flow with no entry page opens its index (a list of every page) rather than pretending one page is the first.

Opening **adds a page to the window** rather than replacing what it was showing, which is what lets two prototypes be worked on at once (see "Pages in a window" below). A window that has just been created is opened *into* instead: its own blank page is what a window is made of, so a freshly opened prototype is one page, not one page and a blank one.

Nothing stands in for a page that does not exist: a live page with no address, or a page of ours whose document is gone, fails with the remedy named rather than letting the browser show a confusing load error.

Starting from nothing needs no special command: write `prototypes/{slug}/cart.html` (the agent's `Write` tool is allowed to) — that alone makes it a page — or duplicate another prototype from the panel, then run `prototype-open`.

`--page <name>` opens that page instead; a name that does not exist is refused with the list of names that do.

### `prototype-pages [slug]`
The flow's pages, in order — which screens this prototype covers. One change at a time:

- `--add payment=https://app.example.com/pay` adds a **live page**: that address *is* the page, and it is patched in place.
- `--add orders` places an existing document (`orders.html`) in the flow order. It does not create a page: a page of ours **is** a file, so the file has to be there first — write it and it is already a page, declared or not.
- `--rename cart=basket` · `--remove payment`. Renaming a page of ours takes its document and its own patches along; removing one deletes its document (and those patches), while a live page is only taken out of the flow.

**The filesystem says what exists; the table says the order and the entry.** Every top-level `.html` in the prototype directory is a page of it (`cart.html` → page `cart`) and needs no declaration at all; declaring one only puts it in the flow order, and `prototype-entry` is what hands it the address root. Two things are deliberately not pages: `_`-prefixed files (`_layout.html`, the shared shell, and the generated `/_index`) and documents in subdirectories (assets).

A name has to be free and usable (a leading `_` belongs to the host's own files, and no two pages may share an address), and a live page needs an address a browser can open — a scheme-less value is refused here rather than becoming a page nothing covers. The same list feeds `prototype-status`, `prototype-open --page`, the `page` name in `snapshot`, and the extension's content scripts (one per live page), so re-export after a change: the delivered package is a snapshot and does not see it until then.

### `prototype-entry <name|none>`
Which page the address root (`/`) opens. `<name>` marks one page as the entry — that page is what `/` renders or redirects to; `none` clears it, and `/` shows the generated **page index** again, which is the default because no page of a flow is naturally the first one. The index stays reachable at `/_index` either way: configuring an entry changes what `/` opens, and never takes the list away. A configured entry whose document is gone is an error naming the page, not a quiet fall back to the index.

Re-export after changing it: the extension's toolbar icon opens the entry page (the index when there is none).

### `prototype-target <url> [--page <name>]`
Point one **live page** at the same page in another environment — a local dev server, staging, production. The address is a fact about where the page is, not part of its identity, so this is an ordinary edit. Without `--page` it moves the entry page when that one is live, otherwise the first live page. Two things go stale silently, and are said out loud when it changes: windows already open keep the old page until they navigate again, and the selectors were written against the old DOM (a patch that matches nothing looks exactly like a patch that did nothing). A page of ours is refused — it is our own document, so there is no external page for an address to mean.

### The window is shared: one per workspace
There is exactly **one browser window per workspace**, and every conversation in that workspace — and you — work in it, whatever the task is: a prototype flow, or ordinary browsing with no prototype behind it. What used to be "my window" is now a **page** in that window, which is why `tabs` exists and why nothing here is scoped to one conversation any more.

- **A window belongs to its workspace, not to a conversation.** `windows` reports who is *driving* a window at the moment (`driver: the workspace's window, driven by <session>`), which is a **lease**: every command a conversation runs through the window renews it, and a turn ending releases it. A lease is not a lock — another conversation taking its turn is normal, and nothing about the window is closed to it.
- **Workspaces stay apart.** Each has its own window; a session in one never sees or touches another's. That is the only boundary left, and it is the one that has to be.
- **Pages opened by other conversations are in here, and `tabs` says whose.** That is the point of sharing, and it is also the boundary: each page prints `opened by: agent (<session>)` or `opened by: a person`, and `driven by:` says who is working on it at the moment. Closing is limited to the pages you opened, and acting on another conversation's prototype is refused — so `--tab <id>` is a name, not a claim on somebody else's work.
- **The window itself is nobody's to close.** `close` on the workspace's window closes **the pages you opened** in it (and leaves a fresh page if they were all of them) rather than refusing everything — the window stays, because it is the whole workspace's. A window that is one session's own — an internal one — is still destroyed outright.

### Pages in a window: `tabs`, `tab-new`, `tab-close`, `--tab <id>`
A browser **window** is a container and a **page** is the thing in it, so several prototypes are looked at at once by being several pages of one window rather than by being several windows. A page carries its own address, title, console, theme colour and — for an overlay, whose document is a third-party address — **the prototype it is for**: that is the only place the identity can live, since nothing in the URL would say it after the view loads.

- `tabs` — this window's pages in the order they were opened, each with what it is, who opened it and who is driving it. This is also how page ids are discovered.
- `tab-new [url]` — add a page to the window. Opens into the window's own untouched page when the window has never been used.
- `tab-close <id>` — close one page **you opened**. Closing the last page closes the window, and the output says which of the two happened.
- `--tab <id>` on **any** command — name the page it acts on. Without one a command acts on the page on screen.

**What `tabs` prints is in three kinds, and the difference matters:**

- **what the page reports** — its real address (for an overlay, the live site's own, never the prototype's), its title, whether it is loading, which prototype it is for and which page of that prototype it is on. One producer: the page. Nothing here can disagree with the document it describes.
- **who asked for it** — `opened by: agent (session-…)` or `opened by: a person`. Written once, when the page was created. This is the only way to tell your own pages from everybody else's, and the reason it is printed separately: it is a statement of intent, not something measured.
- **who is driving it** — `driven by: <session>` or `nobody right now`. A **lease**: the conversation whose command reaches a page is driving it, the turn ending releases it. It says nothing about who the page belongs to.

**Two questions, two rules.** *May I work here?* A page is yours to work on when it belongs to no prototype (an ordinary page — anybody's to use, which is what "you open it, the agent takes over" means), when it is for the prototype this conversation works on, or when this conversation opened it (so `prototype-open` on a prototype you are not bound to still works). Another conversation's prototype is refused, and the refusal names it. *May I close it?* Only pages **this conversation opened**: the user's pages, and another conversation's, are not yours to close however convenient it would be.

**Which prototype a command means** is read off the page in front of you first (`page: <name>`, and the prototype the page is for), and only falls back to this conversation's binding when the page belongs to none. That is what lets one conversation work on several prototypes without binding any of them: `--tab` picks the page, and the page says whose it is.

A page whose address the prototype's own page table does not describe says so (`none of the prototype's pages`) rather than being given the nearest page name — a file, an SPA route, or a page that belongs to another flow entirely.

**A click that wants its own window opens a page.** `target="_blank"`, `window.open` and popups all become pages of the same window, inserted right after the page that asked, so nothing ever opens a bare Electron window with no toolbar and no patches. Two consequences worth knowing: such a page has no `window.opener` (a popup waiting for a `postMessage` from the page that opened it — Google's sign-in is the usual one — waits forever), and it cannot close itself (Chromium only lets scripts close windows that scripts opened), so it stays in the strip until you or the user closes it. `tabs` says which way a page was asked for (`opened as: …`) when it was the browser that asked.

`--tab` is read off the command before the command parses its own arguments, so it never becomes part of an argument: `evaluate document.title --tab tab-2` evaluates `document.title`. A `--tab` with no id is refused rather than falling back to the page on screen — running somewhere else is the one outcome a named target exists to prevent.

Naming a page brings it to the front and the command then runs against the window, which is the same thing the user sees: the window shows what is being worked on, so which prototype is in play is never implied. Reading, switching and closing pages do **not** open a window — a page lives in a window, so a workspace with none has no pages, and `tabs` says so instead of opening an empty one.

**In the app**, every window has a strip under its address bar: one chip per page (the one on screen is raised, a page the agent opened is marked, a page being worked on carries a dot), a close button on each, and a `+` for a new page. It is always there, including with a single page — the `+` is how a person opens something themselves, and a window with one page is exactly when they want a second one. The same pages appear in the window's badge in the app's top bar, grouped under that window, for when the window itself is not in front.

### `focus [windowId]` / `windows`
Manage and inspect browser windows and who is driving them. `windows` lists every window the workspace has, with `driver:` (who is using it right now — see "The window is shared" above), `availableToSession:`, and the prototype of the page each one is showing.

### Lifecycle commands
- `release` — dismiss agent overlay, keep window visible for user
- `hide` — hide window but preserve session state
- `close` — close and destroy a window of your own. On the workspace's window it closes **the pages you opened** instead (a fresh page takes their place if they were all of them), and says so; the window itself belongs to the workspace and is never closed by a conversation.

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
