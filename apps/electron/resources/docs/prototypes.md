# Prototypes

A prototype is a proposal you can look at: a folder of ordinary files describing a **flow of pages**, plus the tooling that renders it, patches it onto real pages, and packages it so somebody else can open it.

Every command belongs to `prototype_tool` and carries no prefix — `list`, `create`, `apply`, `status`, `export`. It works on two things: a prototype's **files**, and the workspace's browser window, which it drives through the same runtime as `browser_tool` — the browser surface itself (windows, tabs, refs, snapshots, input, console, network) is documented in `~/.craft-agent/docs/browser-tools.md`.

> **Quick start:** `list` shows what exists, `create <name>` makes one, then write `prototypes/<slug>/cart.html` — that file *is* the first page — and run `open`.

**Read this before your first `prototype_tool` command.** It is the whole guide: what a prototype is, how its files are laid out, who owns which artifact, and the full command reference.

---

## What a prototype is

- **A flow of pages**, and each page is one of two kinds:
  - **scratch** — a document of ours: `<name>.html` in the prototype's directory. We own it, so the change *is* an edit to that file, and the file *is* the page (writing it is what makes one; the page table only orders it).
  - **overlay** — someone else's live page at an address, patched in place. It is never copied or frozen: the page *is* that address, with its own JavaScript, its own session and its own data, so study it with the browser tool before writing selectors (the live DOM is the only thing that says what they will match), and use the same window to ask the user to sign in when the page needs it.

  One flow may mix both. A patch never flows back into a live page's source, so what leaves the workbench is a spec a developer translates onto it, plus a loadable Chrome extension that puts the change on the real page for whoever wants to see it.

- **Not a project.** Projects are separate containers that group sessions, tasks and shared assets; a prototype is never nested inside one. A prototype also **belongs to no project**: the same prototype can be worked on from conversations of different projects, so there is no membership. A project may only note which prototypes its work touches (see "A project's prototypes are not yours to act on" below) — background information, never a binding.
- **Its own origin.** Each prototype is served from `http://<slug>-<hash>.localhost/` (no port, so the address is the same on every run), answered by Electron itself, with the prototype's directory as that origin's root. Root-absolute paths (`/assets/app.css`), relative `fetch`, ES modules, cookies and `localStorage` all work, and the origin is stable across restarts.
- **Independent.** Each prototype keeps its own patches, and studying one while building another never merges or copies the two — there is no relation stored between prototypes. What a prototype is built with in view (a competitor's screen, a design file, another prototype) is written down in that prototype's own folder, beside `PRD.md`.
- **A bound session is told about its prototype up front.** When a conversation is bound to a prototype, a `<prototype_context>` block is injected into its system prompt describing that prototype's pages, patches, requirements, findings, disputes, services and deliverables before the user says anything. This guide is the general model; the block is the specific state. **Binding is the person's and there is no command for it**: opening a prototype into a conversation (the panel's *Open in conversation*, the prototype page's own button) sets it, the conversation's menu changes or clears it, and `create` binds what it made. The agent names a slug when it means a prototype other than the one in view.

---

## Where it lives

```
prototypes/{slug}/
├── _layout.html                 the shared layout for the pages of ours (optional)
├── cart.html                    a page of ours — every top-level .html is a page
├── PRD.md                       the brief — the one file requirements are read from
├── personas.md                  material beside it: any format, any number of files
├── research/                    what you learned — findings, frames/, videos/
├── reviews/                     the argument against the work, one dispute per file
├── patches/                     the change layer
│   ├── ui-001-btn-radius.css        every page
│   └── cart/ui-002-flow-guard.js    the page `cart` only
├── assets/                      a page's own css/js, images and fonts (packaged verbatim)
├── services/{svc}/              contract fragments (paths/*.yaml), fixtures/, openapi.yaml
├── anchors/                     written by `apply` — evidence about the page
├── acceptance/                  written by `verify` — the rounds
├── config.json                  the page table (order, entry, useLayout) and the prototype's own settings
└── dist/                        the deliverables
```

**The filesystem says what exists; the table says the order, the entry, and whether the shared layout wraps a page.** Every top-level `.html` is a page of the prototype (`cart.html` → page `cart`) and needs no declaration at all; declaring one only puts it in the flow order, hands it the address root (`entry`), or says that it stands on its own (`useLayout: false`). Two things are deliberately not pages: `_`-prefixed files (`_layout.html`, the shared layout, and the generated `/_index`) and documents in subdirectories (assets). The rest of what sits at that level is the author's material, in any format; `PRD.md` is the one file requirements are read from.

**A page's name is its identity on every surface**: `--page <name>` on the commands, `/<name>` on the address, `patches/<name>/` for its own changes, and the `page` a `snapshot` reports. It is a short name chosen when the page is added (`cart`, `pay`) — not a URL fragment.

A layout shared by the pages of ours lives in `_layout.html` (write one when two pages would repeat the same shared markup — a new prototype has none); its `<slot name="page"></slot>` is where a page renders. A page whose row carries `"useLayout": false` is not put in it: that page is served as written, with its own `<head>`. Patches scope the same way either way: `patches/*` applies to every page, `patches/<page>/*` to that one page, and a directory matching no page is reported, never replayed.

---

## The artifacts, and who writes them

Three kinds of file, three jobs, and the ones you write are **all yours** — nothing in the workbench generates them:

- **`PRD.md`, and whatever is written beside it** — the brief. One entry per requirement, headed by a stable id: `## R-001 A cart holds its line until stock runs out`, then the prose under it (who it is for, what happens today, what has to be true). The id is what every other file refers to, so keep it stable when you rewrite the prose around it. `PRD.md` is the **only** file read for requirements; material that makes an entry readable — personas, the flow as it stands today, a glossary, a screenshot of the old screen — goes beside it in whatever format suits, and the entry points at it. The name is exact: a lower-case `prd.md` is material, not a second brief. A document under `research/`, `reviews/` or `assets/` belongs to that directory, not to the brief.
- **`research/`** — what you learned about other products, one finding per file: `# F-001 <what you found>`, then labelled lines `claim:`, `source:`, `captured:`, `evidence:`, `requirements:`. Evidence names files you keep in `research/` (screenshots go there). Deliberately **not** packaged: the reader receives the requirements, not your notes.
- **`patches/` and the page documents** — what changed, each one declaring what it serves: `@requirement R-001` in a patch header, or in a comment in the page document it changes. `status` turns those markers into the two answers nobody can get by reading files one at a time: a requirement nothing implements, and a marker naming an id the PRD does not define. `dist/dev-spec.md` carries the same table to whoever receives the delivery.

Both `PRD.md` (with the material beside it) and `research/` are ordinary files — write them with the Write tool like any other, and read them before re-studying something. They also appear in the bound prototype's context block, so a session starts knowing what was already found.

**Ownership** is how parallel work stays safe here. It answers exactly one question — *would two writers overwrite each other?* — so it names only the paths where that can happen, and the rest of the folder is simply the author's.

- **a writer** — whatever the work declared; there is no fixed vocabulary. A patch's writer comes from its name (`{writer}-{nnn}-…`, so `ui-001-btn.css` belongs to `ui`), and service paths are declared by rule: `services/<svc>/paths/*` and `services/<svc>/config.json` belong to `contract`, `services/<svc>/fixtures/*` and `state.json` to `data`.
- **the control plane** — which is you, on the person's behalf: everything not named here, including the page documents (any top-level `.html`, `_layout.html` included), `config.json`, `PRD.md` and the material beside it, `assets/`, `research/`, `reviews/`, `services/<svc>/openapi.yaml`, and everything under `dist/`.
- **a tool** — `anchors/`, which `apply` writes from what actually matched, and `acceptance/`, which `verify` writes from what the checks answered. This is the one direction you may not write: a record you authored is not a record of anything, and hand-editing one is what would make "it stopped matching" indistinguishable from "it never matched", or "it was red" indistinguishable from "it was never looked at".

Writing outside your own artifacts is refused **before the write**, with the reason: a `patches/<page>/` directory only says *which page* a patch changes, never who may write it.

---

## The workflow

1. **Create** — `create <name>` makes a container for pages and nothing else; it asks for a name only, because "which kind" and "which address" are facts about a *page*. Write a requirement into `PRD.md` before building the next screen.
2. **Add pages** — write `<name>.html` with the Write tool for a page of ours, or `pages --add <name>=<url>` for a live page. `entry <name>` marks what the address root opens.
3. **Study what you need** — for a live page, use the browser tool on the real address (and `pick` when a selector is easier to point at than to describe). Record what you learn as findings under `research/`.
4. **Make the change** — a new screen is a page document; a change to how an existing screen looks is a patch under `patches/<page>/`. Never rewrite a page document to restyle it.
5. **See it** — `open` (or save and let the automatic replay fire), then read the console (`console 50 error`) before calling anything done: nothing else here checks a page, so a script error stays invisible until then.
6. **Answer the checks** — `verify` runs the `check:` lines the PRD declares and records each round.
7. **Argue with it** — file what you disagree with under `reviews/`; `status` reports what is still owed.
8. **Export** — `export` builds the deliverables into `dist/` for whoever receives the work. Exporting does not fold anything: the package carries the change layer as you left it.
9. **Converge a copy instead** — collapsing the change layer is an option of *copying* a prototype in the app's prototype list ("duplicate with the changes folded in"): the copy starts as one document rather than a chain of patches, and the prototype it came from is untouched. It is the one action here that deletes patch files, which is why it is never done to the prototype you are still working on.

---

## Command examples

```text
prototype_tool({ command: "list" })
prototype_tool({ command: "create Landing page" })
prototype_tool({ command: "pages --add cart" })
prototype_tool({ command: "pages --add pay=https://app.example.com/pay" })
prototype_tool({ command: "entry cart" })
prototype_tool({ command: "pages --change pay=https://staging.example.com/pay" })
prototype_tool({ command: "open" })
prototype_tool({ command: "open --page cart" })
prototype_tool({ command: "apply" })
prototype_tool({ command: "apply --file prototypes/cart/patches/ui-002-total.js" })
prototype_tool({ command: "clear" })
prototype_tool({ command: "verify" })
prototype_tool({ command: "sample-video ~/Desktop/demo.mp4" })
prototype_tool({ command: "status" })
prototype_tool({ command: "contract-compose" })
prototype_tool({ command: "contract-export" })
prototype_tool({ command: "mock-apply" })
prototype_tool({ command: "mock-clear" })
prototype_tool({ command: "export" })
prototype_tool({ command: "export --strict" })
```

**A slug is optional for almost every command.** Which prototype a command means is read from the **page this conversation is on**, when it is on one — your own page first, then the one in front of you — and only then from this conversation's binding. That is what lets one conversation drive several prototypes without binding any of them: `--tab <id>` picks the page, and the page says whose it is. Pass a slug explicitly (`apply checkout-flow`) to work on a different one; `list` and `create` are the exceptions that take no prototype at all (`create` binds what it made).

**Nothing here needs a window to run.** Only `open`, `apply`, `clear` and the mocks act on a tab; every other command — `list`, `create`, `pages`, `entry`, `contract-*`, `verify` (its page checks are reported as skipped when no page is open), `status`, `export`, `sample-video` — works on files alone, and resolves its prototype from the binding when no page is there.

---

## Creating and listing

### `list`
Every prototype in the workspace, with its pages. Start here when you do not know what exists.

### `create <name> [--no-bind]`
Create a prototype: a **container for pages**, and nothing else. Creation asks for a name and nothing more — no kind and no address, because both of those are facts about a *page* — and it creates no page at all: "this prototype has no pages yet" is a true statement, not a broken state. `--no-bind` leaves the session's current binding alone, which is what studying another prototype needs.

Pages arrive afterwards, one of two ways: write `<name>.html` for a page of ours (the agent's `Write` tool is allowed to), or add a live page with `pages --add <name>=<url>`.

### Studying something else

"How this is built" is not a relation between prototypes: **write it down beside the brief.** A file you keep next to `PRD.md` carries a competitor's address, the path to a screenshot or a design file, or another prototype's slug, and the entry points at it. The person reading the prototype then meets the same list you did, and it travels with nothing and to nowhere.

Two rules do not bend, because the deliverable depends on them:

- material is **evidence, not material to copy** — read it for intent, then translate what you took into this prototype's own markup, and say in the conversation what you took and from where;
- another prototype's patch files are **never copied into this prototype's `patches/`**. They were written against a different document, so their selectors would not match here, and every patch under `patches/` ships inside the deliverable — the mistake would be silent.

### A project's prototypes are not yours to act on

A project may note which prototypes its work touches, and a conversation inside it sees that as a `<project_prototypes>` list in its prompt.

It is **background information, like a connected source**, and nothing more:

- The list has no first entry in any meaningful sense: a project works on several prototypes at once, and none of them is "the" one. Read it as a set.
- No conversation is bound by it, no prototype context or guide is injected because of it, and it is not a default target for anything — a `prototype_tool` command still takes its slug from the page and this session's binding.
- It is recorded by the user in the app (the project's Prototypes tab), so there is no command for it. Work on one of them by naming its slug on a command; nothing else follows from the note.
- It says nothing about whether anyone is working on those prototypes, and nothing about which prototypes belong to the project — **no prototype belongs to a project**: one prototype is routinely worked on from conversations of several projects at once.

---

## Pages

### `pages [slug]`
The flow's pages, in order — which screens this prototype covers. One change at a time:

- `--add payment=https://app.example.com/pay` adds a **live page**: that address *is* the page, and it is patched in place.
- `--add orders` places an existing document (`orders.html`) in the flow order. It does not create a page: a page of ours **is** a file, so the file has to be there first — write it and it is already a page, declared or not.
- `--rename cart=basket` · `--remove payment`. Renaming a page of ours takes its document and its own patches along; removing one deletes its document (and those patches), while a live page is only taken out of the flow.
- `--change payment=https://staging.example.com/pay` re-points one **live page** at another environment — the same page in a dev server, staging or production (see below).
- `--no-layout landing` · `--layout landing` say whether the shared layout wraps one page of ours (see below).

A name has to be free and usable (a leading `_` belongs to the host's own files, and no two pages may share an address), and a live page needs an address a browser can open — a scheme-less value is refused here rather than becoming a page nothing covers. The same list feeds `status`, `open --page`, the `page` name in `snapshot`, and the extension's content scripts (one per live page), so re-export after a change: the delivered package is a snapshot and does not see it until then.

### `entry <name|none>`
Which page the address root (`/`) opens. `<name>` marks one page as the entry — that page is what `/` renders or redirects to; `none` clears it, and `/` shows the generated **page index** again, which is the default because no page of a flow is naturally the first one. The index stays reachable at `/_index` either way: configuring an entry changes what `/` opens, and never takes the list away. A configured entry whose document is gone is an error naming the page, not a quiet fall back to the index.

Re-export after changing it: the extension's toolbar icon opens the entry page (the index when there is none).

### `pages --change <name>=<url>`
Point one **live page** at the same page in another environment — a local dev server, staging, production. The address is a fact about where the page is, not part of its identity, so this is an ordinary edit to the table; it names its page, since the table `pages` prints is the list of names. Two things go stale silently, and are said out loud when it changes: windows already open keep the old page until they navigate again, and the selectors were written against the old DOM (a patch that matches nothing looks exactly like a patch that did nothing). A page of ours is refused — it is our own document, so there is no external page for an address to mean. A page's kind cannot change.

### `pages --layout <name>` · `pages --no-layout <name>`
Whether the shared layout (`_layout.html`) wraps that page. `--no-layout` is for a page that is a design of its own — an email, a landing page, a screen from another product: it is then served, and delivered, exactly as written, with its own head and its own styles, and `--layout` puts it back in the layout. It is a fact about the page, so it travels with it, and the page keeps its patches either way. Only a page of ours can carry it — a live page is someone else's document and the layout is ours, so the answer does not exist for one. Naming a document nobody declared declares it, because the flag lives on a row.

A flow whose screens do not share one look is what this is for: the layout is for pages that belong to the same design, not a funnel every page has to pass through.

### `open <slug>`
Open a prototype in the browser, and replay its patches into what opens.

A prototype is a **flow of pages**, and each page is one of two kinds — which is what decides where opening it goes:

- **a live page** (`overlay`) — the real address it records, with the patches injected into it. That page brings its own JavaScript, its own session and its own data; nothing is copied or frozen, because a copy could not run any of that and would only *look* like the page. Opening it and stopping there would show the target page rather than the prototype, so the replay is part of this command.
- **a page of ours** (`scratch`) — the prototype's **own address**, where the workbench renders it: `/` renders the entry page and `/<name>.html` renders that page, and either way the document is rendered with the patches it carries (the shared ones plus its own), computed per request, so it always shows the patches that exist now. A top-level `.html` is therefore never served raw, and the copy inside a previously exported package (`/dist/extension/cart.html`, a file in a subdirectory) is a document frozen at export time rather than the page.

With no `--page`, "open the prototype" means the page the bound browser window is already on, then the entry page, then the generated page index — so a flow with no entry page opens its index (a list of every page) rather than pretending one page is the first.

Opening **adds a page to the window** rather than replacing what it was showing, which is what lets two prototypes be worked on at once. A window that has just been created is opened *into* instead: its own blank page is what a window is made of, so a freshly opened prototype is one page, not one page and a blank one.

Nothing stands in for a page that does not exist: a live page with no address, or a page of ours whose document is gone, fails with the remedy named rather than letting the browser show a confusing load error.

Starting from nothing needs no special command: write `prototypes/{slug}/cart.html` (the agent's `Write` tool is allowed to) — that alone makes it a page — or duplicate another prototype from the panel, then run `open`.

`--page <name>` opens that page instead; a name that does not exist is refused with the list of names that do.

### Writing a page of ours (the shape to copy)

A page of ours is an ordinary HTML document — no build step, no template language — and the prototype's
directory *is* the origin root. What you write is what the browser loads:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cart</title>
<style>
  /* This screen's own styling. */
  .total { font-weight: 600 }
</style>
</head>
<body>
  <h1>Cart</h1>
  <section class="total">
    <div><span>Delivery</span> <span>Free</span></div>
    <button>Checkout</button>
  </section>
</body>
</html>
```

**A layout is something you add when it has earned its place.** A new prototype has no `_layout.html`: write
the pages first, and when two of them would repeat the same markup, write `_layout.html` — an ordinary
document whose `<slot name="page"></slot>` is where each of those pages renders. Put the shared markup and
the design tokens in it (a scale like `--gray-8`, a meaning like `--accent`, and the pieces every screen
needs such as `.card` / `.row`), and from then on a page that shares that design carries only its own screen
and reuses them. **Do not copy the layout into a page** (header, nav, tokens) — two copies drift, and the
layout is the one place a change to it belongs.

A page that is a design of its own — an email, a landing page, a screen from another product — is not put in
the layout at all: set `"useLayout": false` on its row in `config.json` and it is served (and delivered)
exactly as written, with its own head. That is the answer for a flow whose screens do not share one look, and
it is a fact about the page, so it travels with it. Every page keeps its own patches either way.

What bites later, in order of how often it does:

- **Reach for standard HTML before writing any JS**: `<details>` for disclosure, `<dialog>` for modals,
  `:has()` / `:checked` for state-driven styling, `required` / `pattern` / `minlength` on inputs for
  validation, `<template>` + `<slot>` for reuse. Most prototype interaction needs no script at all — and
  the standard version behaves identically in the preview and in the delivered package.
- **Assets use root-absolute paths** (`/assets/app.css`). No CDN and no external host: the prototype is
  opened offline and only its own directory answers. Everything under `assets/` travels with the package,
  copied verbatim, bytes and all.
- **Check the page after writing it**: `open`, then `console 50 error`. Nothing else in the
  workbench validates a page, so a thrown error is invisible until someone looks.
- **No `eval` and no `new Function`** — the delivered extension forbids them and the export would fail.
  **No bundler**: plain `<script>`, `<style>`, and `<script type="module">` with relative imports are fine.
- **Reuse has two places, not a third**: shared structure goes in the layout, shared helpers go in
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
patch, behaviour goes in a page's module, shared structure goes in the layout, shared helpers go in
`assets/lib/`.**

---

## The change layer: patches

### `apply [slug] [--file <path>]` / `clear [slug]`
Replay (or remove) a prototype's patches in the current browser.

A prototype lives under `{workspace}/prototypes/{slug}/` and its patches are ordinary files named `{writer}-{nnn}-{name}.{css|js}`, where `{writer}` is the identity of whoever wrote them:

```
prototypes/checkout-flow/patches/ui-001-btn-radius.css          ← every page
prototypes/checkout-flow/patches/cart/ui-002-flow-guard.js      ← the page `cart` only
```

- **The `{writer}` segment is your identity, not a code you pick from a list.** This conversation writes as the identity it was given (its `writes:` declaration, or `main`); its patches are named with that prefix, the `prototype_context` block at the top of the conversation says which, and a name claiming someone else's prefix is refused before the write and reported by `status`. It is what keeps concurrent writers from overwriting each other.
- **The browser window's own editor writes as `ui`.** What a person does in the window's edit mode — boxing elements and setting them bold or italic, double-clicking a line to retype it — is written down as a patch too, under the writer id `ui`. **One save is one patch** (`patches/<page>/ui-00N-….css|js`, the same number for both when the session did styles and text), numbered after everything already written so the change is not overridden by the patch it corrects; nothing exists on disk while they are still working, so a session that is thrown away leaves nothing behind. Those patches follow every rule the others do (marked with their `@target`, replayed in order, checked for drift, folded when the layer is folded): read them, build on them, and leave the prefix alone — it is not an identity you write under.
- Files that do not follow the naming convention are ignored (READMEs, editor backups, dotfiles), so nothing unexpected gets executed.
- Replay order is the declared numeric order → file name, with the consolidated patches a fold produces (`Z-…`) last by rule. The writer prefix is an identity, so it decides nothing about order.
- **Where a patch sits is which page it changes**: `patches/*` applies to every page of the flow, `patches/<page>/*` to that page alone. A directory that matches no page is reported by `status` rather than silently replayed.
- Which patches this command replays follows the **page the command acts on** (your tab, or the one `--tab` names — not whatever the person is reading): that page brings the shared patches plus its own, and a page on no part of the prototype gets the shared ones only — the command says which page it used, so "the patch did nothing" and "the patch belongs to another page" read differently.
- Patches are applied to the current page **and** registered for every future document, so they survive a reload. The index is recomputed from disk on every `apply`, so editing a patch file and re-running the command is all that is needed — deleting a patch file also un-applies it.
- **`--file <path>` applies one named patch instead of the whole set** — the file just written. A relative path counts from the workspace root, like every other `--file`. Nothing is un-registered in that case: the patches the page was already given stay given, and the one file is registered again under its own key, so re-running it after an edit is idempotent. This is the loop for a patch being iterated on — write it, `apply --file <path>`, read the target report — and it is what keeps a patch from having to be spelled out inside a command (`evaluate --file` runs one without registering it; this is the one that leaves it behind). The file has to be a patch of *this* prototype, under its `patches/`: a file that is not (a README, a misnamed patch, another prototype's file) is refused **by name**, because the injector ignores such files silently on a whole-set replay and "named explicitly and quietly ignored" is the one outcome nobody can debug. Its own page scope still decides where it belongs — naming a `patches/cart/…` file while the `orders` page is open injects it into the wrong DOM, and the command says so rather than leaving every target's "matched nothing" to be misread.
- A page the host rendered (a page of ours, served from the prototype's own address) arrives with its patches already inlined, so there is nothing to inject into it; that is reported as *nothing to inject*, not as a failure. Patches written since that render still land on it — and a patch whose **contents** changed since then shows up on a `reload`, which is what a render is.
- **A patch may declare what it is aimed at**, with `@target <css selector>` in its header (next to `@requirement R-001`, which says what it is for). The command then **counts** what each declared selector matched and says so:
  - a selector that matched nothing and has never matched is named — the selector is wrong, or the page is not the one it was written against;
  - a selector that matched before and does not now means the page moved, and the command offers selectors that resolve to exactly one element on the page today (a **re-anchor**, not a rewrite);
  - a patch with no `@target` is named as unchecked rather than treated as a clean run.
  Every successful match is recorded under `prototypes/{slug}/anchors/` — that record (selector, what the element looked like, when it last matched) is what makes "it stopped matching" distinguishable from "it never worked". Nothing in `anchors/` is rendered, replayed or packaged: it is evidence *about* the page.
- `clear` unregisters a prototype's patches; the current document keeps their effects until you reload.
- Saving a file under `patches/` or `assets/`, or a page document, replays the prototype into every window that is showing it (a page of ours reloads, a live page is re-patched). There is nothing to click and nothing to switch on: opening a page brings it up to date, an edit is followed by a replay, and a reload re-renders from disk.

### Folding the change layer — an option of copying

There is **no command** for this: a copy can be made with its change layer collapsed, from the prototype list in the app. That is deliberate — the fold is irreversible (it deletes the patches it takes), and the copy is the one prototype nobody minds collapsing.

Where the fold lands is decided by whose the page is:

| page | folded into |
|---|---|
| **ours** (`scratch`) | CSS → `assets/<page>/committed.css`, JS **promoted** → `assets/<page>/committed.js`; the page document gets a `<link>` and a `<script src>` (each added once) |
| **a live address** (`overlay`) | `patches/<page>/Z-001-upper.css` and `Z-002-upper.js` — a consolidated patch, which replays **after** every other patch by rule |

- **JS is promoted, not folded**: a script is behaviour, and folding behaviour into a static document would mean rendering the page and serializing the result — which loses the readable document (and is why "freeze the live page" was never a thing here). Moving it into a file of ours is the same collapse: it stops being a delta and becomes source.
- Each folded change leaves a **provenance header** naming the patch it came from, the date, and the markers it carried (`@requirement`, one `@target` per line) — so the anchors recorded for it and the requirement it serves survive the fold.
- **The folded patch files are deleted**, which is what makes a fold the one irreversible action in the workbench. Nothing of it touches the prototype it was copied from.
- What it cannot do, it says: a page of ours whose document is missing is **refused** (nothing is deleted), and a folded CSS patch with no `@target` is listed as not checked.
- Folding a page of ours also drops that page's anchor records: the elements now live in a file we own, so there is nothing to drift against. A live page's records are kept — its address is still someone else's.
- The consolidation is filed under the reserved writer `Z`, so **never name a patch `Z-…` yourself**.

---

## Verifying and arguing

### `verify [slug]`
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

**Each run is a round.** The record of what the checks answered lives under `prototypes/{slug}/acceptance/state.json` — not in `dist/` (that directory is the package, rewritten on every export) and not something you write by hand: it is what `apply` is to `anchors/`, a record of a run that actually happened, and the guard refuses a hand-written one. What it buys is the one thing a count cannot say: **`dist/acceptance.md` reports what moved since the round before** — newly red (it passed last time, so the change under review broke it), still red (nobody has acted on it), no longer looked at (it was red and this run could not check it), fixed, and checks the PRD no longer declares. Five red is an emergency if it was zero this morning and a shrug if it was five then.

The output also hands over the line to write for each failure — `about: requirement R-001` (or `about: page cart`), `about: endpoint GET /api/cart` — because a failure is a question, not an instruction: writing the objection down under `reviews/` (below) is what keeps the verdict readable after the conversation is gone.

### `reviews/` — the argument against the work

`research/` records what was learned **for** a requirement. `reviews/` records what is argued **against** the work: one dispute per file, shaped like a finding so the two read the same way and can be referred to from anywhere.

```md
# D-001 The total is not actually pinned while the list scrolls

about: patch ui-001-sticky-total.css
on: 3f9a1c2e
status: open
claim: The summary row is not on screen once the list is longer than the viewport.
evidence: verify — check: selector [data-cart-total] did not match

`position: sticky` needs a scroll container that is not the page…
```

- **`about:`** names one thing: `patch <file>`, `page <name>`, `endpoint <GET /path>` or `requirement <R-00x>`. A dispute that names nothing is an opinion, and `status` reports it as one. Where a dispute is about a patch or a page, it is **threaded onto the requirements that thing serves** — derived from the same `@requirement` markers as everything else, so a review never restates the thread. Work out which by asking what actually failed: a failed `check:` is usually the requirement or the page it looked at, and `verify` prints both for you.
- **`status:`** is `open` (it stands), `fixed` (the thing was changed), `rebutted` (you judged it unfounded, with the reason in the body) or `accepted` (valid, and the cost was taken deliberately). The status is checked against the disk, never trusted on its own: `open` on a patch that has **changed** since it was filed is reported **stale**, and `fixed` on a patch that has **not** changed is reported the same way — a record that disagrees with the files is exactly what this is for.
- **`on:`** is the fingerprint of the disputed patch when the review was filed (the 8 characters `status` prints beside each patch). It is required for a patch dispute, because that is the only target whose fingerprint is free and unambiguous; the other targets span several files, so there is nothing single to fingerprint.
- A dispute that still stands is what `export --strict` refuses on, and `dist/dev-spec.md` carries the outstanding ones to whoever receives the package. A spec that lists only what was built hands over a claim, not a position.

Nothing here is packaged on its own: the receiver gets the requirements, the change spec, and the disputes still standing at that moment.

### `status [slug]`
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
  dist:       extension/, dev-spec.md, handoff.md, openapi.yaml, contract.md
  ownership:  1 violation(s)
    • patches/oops.css — misnamed patch — expected {writer}-{nnn}-{name}.{css|js}, optionally under patches/<page>/
  reviews:    1 standing of 2 filed
  acceptance: round 3 — 2 passed, 1 failed, 1 skipped
  unresolved: 3
    • R-004 is in PRD.md but no page or patch refers to it, so nothing implements it.
    • reviews/D-001-total.md disputes patch patches/ui-001-total.css, and it still stands (open).
    • `selector: [data-cart-total]` failed in the last verification round.
```

`reviews:` and `acceptance:` are the state of the argument and the last verification; `unresolved:` is what is still **owed**, last because it is the thing to act on, and it is the same list `export --strict` refuses on — so a run cannot look finished here while the export would stop.

A prototype with no pages yet prints `pages: none yet` and `openable: no` — that is a starting state, not an error. `root:` says what the address root opens: a page name, or the generated page index. Entries of `pages` that could not be read, a declared page whose document is gone, and a `patches/<name>/` that matches no page are all listed as `page issues:` — a dropped page is a screen the flow no longer has, and a patch directory nothing reaches is a change that never lands, so neither is silent.

**Ownership** violations are reported here (see "The artifacts, and who writes them" above). The check flags the files that break a rule of their own — otherwise silent:

- a patch whose prefix claims the reserved consolidator (`patches/Z-…`) — only a fold writes those;
- a misnamed patch (`patches/oops.css`) — the patch scanner ignores it;
- a stray file inside a service directory (`services/*/random.txt`) — a service directory holds paths, fixtures, `state.json`, `openapi.yaml` and nothing else.

Nothing else in the prototype's directory is a violation. That folder is the author's: a `screenshots/` or a `notes.xlsx` beside the brief is material, not a breach.

`status` also lists what each patch is aimed at, and reports anchor records that outlived the patch that declared them — a record nothing refers to any more is named rather than left looking checked.

### `sample-video <path>`

Frames out of a recording you made elsewhere (a phone, Loom, QuickTime) — a machine, a demo, a session
someone screen-recorded: they are the one way pictures get under `research/` now (see the note at the end of
this section). A recording the person made from this window's own record button is **mp4**, the format that
needs nothing done to it here. `--every 2s` sets the interval, `--changes` keeps only the moments that moved,
`--max 40` caps the frames, and `--slug <slug>` aims it at a prototype other than the one in view (the path is
this command's only positional, which is why the prototype is a flag here). The recording is copied into
`research/videos/` first — a capture whose source has been cleaned up cannot be re-sampled, and re-sampling
is most of what a source is for. Decoding is Chromium's, so nothing needs ffmpeg: a codec it cannot read
(HEVC/H.265, ProRes, some `.mov`) fails with a message saying so, rather than producing a capture of one
frame. Sampled frames carry their position in the recording (`imported [0:12.4]` in `index.md`), which is the
coordinate a reader of a video can actually use.

Frames are written to `prototypes/<slug>/research/frames/<session>/` as `frame-0001.jpg` upward, with
`frames.json` (machine-readable) and `index.md` (the same table, for a person) beside them, and are cited
from a finding's `evidence:` line — `evidence: frames/20260915-183012/frame-0004.jpg`. They come back **in
the reply** too: what reads them is a model, and a directory of files is something it never sees. A long
sampling arrives as a sample — the first frame, the last, and what is between them, up to six — and the reply
says how many of the total it is showing; every frame is on disk either way. Frames are deliberately **not**
in the delivered package: they are how the requirements were reached, not part of what the reader receives.

The command is the whole entry: nothing in the app offers this behind a button, because sampling is only the
first half — what a recording is for is the finding that cites the frames it produced.

**There is no live capture from here.** `record <for>` — watching the window for a while and keeping the
frames where it changed — was built and then removed: its one irreplaceable use was recording *the two of you
at once* (somebody drives the page while it watches), and neither a person nor an agent can be told "now do
the thing" from inside a tool call. That use has a better home now: **the window's own record button**
records the tab on screen to an **mp4** (webm only where the build cannot record mp4) while the person drives
it, and files it in their **downloads folder** — where a download from that window already goes, because the
file is theirs and not a conversation's (whose tab it was says who opened it, not who the recording is for).
Tell them so if a demo is what you need — their recording is the one thing you cannot take yourself — and then
`sample-video <path-to-it>` turns it into frames here. A screen worth arguing about is a recording somebody
made, which is what `sample-video` is for; a change worth looking at is `browser_tool screenshot` right after
the action that caused it.

---

## Contracts and mocks

A service lives under `prototypes/{slug}/services/{svc}/`:

```
services/checkout-api/config.json          baseUrl / authType / title
services/checkout-api/paths/list-orders.yaml   OpenAPI path items (a `paths:` block or bare `/…` keys)
services/checkout-api/fixtures/list-orders-200.json
```

### `contract-compose [slug] [--service <svc>]`
Compose the API contract fragments into one spec.

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

### Faking a flow, not just a response

A fixture answers the same thing every time, which is enough for one screen and not enough for a flow: "add to cart, then the cart screen shows the item" needs the mock to remember. A path item can say which collection it is about, and then what each method does follows from HTTP itself:

```yaml
paths:
  /api/cart:
    x-mock-collection: cart        # what this path addresses
    get:
      x-mock: { status: 200 }      # the collection, as it is now
    patch:
      x-mock: { status: 200 }      # merge the request body into it
  /api/cart/items:
    x-mock-collection: cart.items
    get:
      x-mock: { status: 200 }
    post:
      x-mock: { status: 201 }      # append the request body
  /api/cart/items/{id}:
    x-mock-collection: cart.items
    get:
      x-mock: { status: 200 }      # the element whose `id` is the path's value
    put:
      x-mock: { status: 200 }      # replace it
    delete:
      x-mock: { status: 200 }      # remove it
```

`services/{svc}/state.json` is the store it starts from:

```json
{ "cart": { "currency": "CNY", "items": [] } }
```

The rules, in full:

- **GET reads, POST appends, PATCH merges, PUT replaces, DELETE removes.** An operation this vocabulary cannot express — `DELETE` on a collection, `POST` on one element, a `{param}` in the middle of a path — is **refused when the contract is read**, with the operation named, rather than mocked into something that looks plausible.
- **A trailing `{param}` selects one element**, by a field of that name: `/api/cart/items/{id}` addresses the item whose `id` matches. Without it, the path is the collection itself.
- **A read answers what the path addresses; a change answers the collection as it now stands.** The screen that just added, edited or removed something has to draw the list next, and a mock that answered the single element there would make every such screen guess. `x-mock.fixture` still decides the body when it is given, which is how an operation answers something else (an acknowledgement, an error shape).
- **A missing element is a 404.** An operation whose body contradicts the store (appending to an object, say) answers **500 with a note saying so**: that is a bug in the mock, and it has to look like one instead of like the app failing.
- **The store lives in memory while the mock is applied, and `state.json` is never written back.** A demo is therefore repeatable: applying the mock again starts the flow over, which is also how you get from a finished run back to the first screen. Only the structure is checked when the contract is read — the values are not substituted, so `state.json` is data, not a template.
- **The delivered carriers ship the same state machine and the same `state.json`**: the extension's `mocks.js`, a static page and a bookmarklet answer exactly as the workbench does, and a `POST` that ran in the page changes what the next screen sees there too. There the store lives in the document, so a **page reload starts the flow over** — in the workbench, applying the mock again is what does it.

Two edges worth knowing: the collection is named by a **dot path**, so a prototype with several services shares one store (and two services declaring the same top-level key is reported rather than resolved silently), and a route matches the end of a pathname, so an app calling `${baseUrl}/cart/items` is answered even though the contract writes `/cart/items`.

A service that declares collections is counted apart everywhere it is reported — `status` prints `N keep state` for it — because a service of fixed answers and one whose screens depend on each other are read differently by whoever is building against them.

### `contract-export [slug] [--service <svc>]`
Write the backend-facing deliverables into `dist/`:

- `openapi.yaml` — the composed contract.
- `contract.md` — endpoints table, declared error responses, auth, and any `x-contract` notes.
- `fixtures/*.json` — the response samples.

`contract.md` deliberately calls out what is **not** declared (no error responses, no `authType`, no `x-contract` notes covering pagination/idempotency/concurrency) so an incomplete handoff is visible rather than silent.

### `mock-apply [slug] [--service <svc>]` / `mock-clear`
Serve the contract's `x-mock` responses so the prototype runs before the backend exists.

**One program per tab.** Both commands act on the tab this session works from (`--tab <id>` names another), and `mock-apply` **replaces** what that tab was serving — a prototype with several services is one service at a time, which is why `--service` is required as soon as there is more than one. That is also why `mock-clear` names no service and takes no slug: there is one program to take off, and the tab already says which one.

Two things are named for two different reasons, and both are needed to mock two prototypes at once: the **slug** says whose contract the routes are read from, and the **tab** says where they land. Each prototype keeps its mock on its own tab (`mock-apply checkout-flow --tab tab-1`, then `mock-apply rival --tab tab-2`), which is the same rule as everywhere else — a command acts on the page you point it at.

Interception happens in the browser's **network layer** (CDP `Fetch`), which means:

- `fetch` **and** `XMLHttpRequest` (axios et al.) are both covered, along with every other resource type — nothing is monkey-patched into the page.
- The app does **not** need to point at a mock server: requests are matched by pathname, so absolute URLs, `baseUrl`-prefixed URLs and same-origin relative paths all hit.
- Fulfilled responses carry `access-control-allow-origin: *`, since cross-origin calls would otherwise be blocked by CORS even though we are the one answering.

The command reports endpoints that declare no `x-mock` (they pass through to the real backend) and `x-mock` fixtures that have no file — those routes are **skipped rather than served empty**, because a silently-empty response is far harder to debug than a 404.

When the service declares collections (`x-mock-collection`), the command also says how many routes remember state, where the store starts from, and any operation the vocabulary refused. **Every apply starts the store over**, so running it again is how a demo is reset — the mock holds its state in memory, writes nothing back, and stops with the program.

`mock-clear` takes that program off the tab — every route, and the store with it — and requests fall through to the real network again.

While the mock is active the debugger stays attached — CDP drops interception on detach, so the client deliberately holds it.

---

## Export

### `export [slug]`
Build the prototype's deliverables into `prototypes/{slug}/dist/`:

- `extension/` — **a loadable Chrome extension covering the whole flow**, the carrier for everything that cannot travel in a file. Nothing is published to a store: the recipient opens `chrome://extensions`, turns on **Developer mode**, and clicks **Load unpacked** on this folder. One package, whatever the flow is made of:
  - **pages of ours ship in it** — each document under the name it has on disk (`cart.html`), so the links an author wrote between pages keep working; each carries only the patches that apply to it (the shared ones plus its own), and the layout is applied exactly as the host applies it — so a page that stands on its own (`"useLayout": false`) ships as written. The prototype's own static files travel with the package too: the whole of `assets/` is copied **verbatim**, under `assets/…`, which is the path the pages already address it by — images, fonts and video included, copied as bytes so nothing is corrupted on the way, and the directory as a whole rather than a list of extensions, because whether a png is addressed is not answerable from the markup (a script builds the URL).
  - **live pages are injected into** — one content script per live page, which Chrome itself scopes to that page's address. The patches are simply there when the page loads: nothing to click, and they survive a reload. `README.md` says where it applies. Nothing is copied or frozen, so the page keeps its own JavaScript, session and data.
  - The extension's **options** page is the generated **page index** (every page with a way into each: our documents are package files, live pages are their addresses), and the toolbar icon opens the entry page — the index when no page is marked as the entry.
  - The package carries the contract's `x-mock` routes when there are any: a script in the page's own world (`world: "MAIN"`, `document_start`) answers them by wrapping the page's `fetch`/`XHR`, and `README.md` lists exactly which requests are faked — and what that cannot cover (requests a PWA's own service worker makes never pass through the page).
  - The package carries a `version` and a build time, so "which build am I looking at?" has an answer. The package is a **snapshot**: after a re-export, press **Reload** on the extension in `chrome://extensions` (and refresh the page) to pick the change up.
  - An extension page cannot run inline script (MV3's CSP, and `eval` is out), so an inline `<script>` block is hoisted into a file and an inline `on<event>="…"` becomes a generated function a small runtime binds. Behaviour is unchanged, and every such change is reported back in the command's output, named per page.
  - It fails with a clear error when there is nothing to hand over: no pages at all, a page in the table whose document is gone (named), or a live page whose address cannot become a match pattern (also named).
- `static/` — **every page of ours as one self-contained HTML file**, for the half of a flow that is ours and can therefore travel in a file: double-click it, send it on, no extension, no host and no server. It is the same page the preview shows — the same patches in the same order, inlined the same way — with the two things the preview gets from the workbench inlined as well: the mock layer (installed at the top of `<head>`, before the page's own code captures `fetch`) and every reference the page makes to a file of this prototype (`/assets/app.css`, an image, a font — carried inside the file as a base64 data URL, since a single file has no directory to resolve against). A reference to **another page** stays a link to the sibling file, which is why the page file names are kept — and a root-absolute one (`/orders.html`, which would resolve to the filesystem root here) is made relative. A reference that names no file of the prototype is **reported** rather than left as a link that breaks the moment the file is opened on its own; those are listed after the extension's own warnings, under their own heading. A prototype made only of live pages has **no** `static/` folder: a live page is somebody else's, so a copy of it would run none of its code and carry none of its session — only an extension can carry it.
- `bookmarklet.html` — the **live** pages' changes as bookmarks, for the browser where an unpacked extension cannot be loaded at all (a managed one, someone's locked-down laptop, one look). One draggable link **per live page** — each carrying the same bundle the extension ships, plus the mock layer — and the same code printed underneath for pasting into the console, because the two ways a bookmark fails are a long `javascript:` URL and the page's own CSP (`script-src 'self'` refuses an inline bookmark outright; the console is not subject to it). The page states both, and the third cost: a bookmark is not scoped to an address the way a content script is, so it takes a click per page, per reload. Written only when a live page has something to apply.
- `dev-spec.md` — the change list, **grouped by page**: every patch in replay order with its writer, kind and full content. The shared patches (`patches/*`) are listed once, and each page says how many of them it also carries. Each change also says what its `@target` was aimed at **and what the anchor record knows about that selector**: how many elements it matched and when, or that it was recorded and matches nothing now — the page moved, and the fingerprint's candidate selectors say where the element went. That second state is the one worth reading before translating anything into source. It also carries the **Reviews** section: the disputes that were still standing when the package was built, because a spec that lists only what was built hands over a claim rather than a position.
- `handoff.md` — **the delivery's index**, written last so it lists what the run actually produced: a table of artifact → who it is for → what to do with it (`dev-spec.md` first, then the extension or the static pages, the bookmarklet, `acceptance.md`, the backend's `contract.md`/`openapi.yaml`/`fixtures/`), which page the flow starts at, and a closing section on **what this delivery does not settle** — the same list `export --strict` refuses on, on the package's first page rather than at the end of a spec nobody read that far into.

**The export names what is still outstanding** — a requirement nothing implements, a dispute nobody answered, a check the last round failed, a response the contract declares that has no fixture file — instead of handing over a package that looks finished. `export --strict` goes further and **refuses to build at all** while anything is: that is the mode for a run nobody is watching, where the "by the way" lines are not being read by anyone.

Keep the patch set small and delete patches that no longer change anything: all of them ship in the package, and everything in it is something a reviewer has to read. Patches are shipped unminified on purpose — the recipient runs this on their own page, and being able to read it is what makes that reasonable.

The command prints each deliverable's path — the extension package, `dist/static/` when the flow has a page of ours, `dist/bookmarklet.html` when it has a live page with something to apply, the spec, and `handoff.md` — and, when there is a page of ours to open, a URL for it inside the package. Each prototype is served from its own origin — `http://<slug>-<hash>.localhost/…`, answered by Electron itself (no port, so the address is the same on every run), with the prototype's directory as that origin's root — rather than `file://`, which has an opaque origin: no cookie jar, no relative `fetch`/XHR (so the mock layer would never see a request) and no ES modules. Root-absolute paths (`/assets/app.css`) and SPA history routes therefore work. To look at the packaged page before handing it over:

```
navigate http://checkout-flow-9f3a2b1c.localhost/dist/extension/cart.html
```

---

## Prototype pages in the browser window

Prototype pages are **tabs of the workspace's single browser window**, the same window every other task browses in. That has a few consequences worth knowing when driving `prototype_tool` commands:

- `open` **adds a tab** to the window rather than replacing what it was showing, which is what lets two prototypes be worked on side by side.
- Commands act on **your** tab — the tab this conversation has been working from, marked `your tab` in `tabs` — or on the tab `--tab <id>` names, not on whatever the person happens to be reading.
- Which prototype a command means is read off the tab it acts on: your own tab first, then the one in front of you, and only then this conversation's binding. A page whose address the prototype's own page table does not describe says so (`none of the prototype's pages`) rather than being given the nearest page name.
- A page of ours is rendered from disk, so an edit to its document or to a patch it carries appears on the next render — `reload` is the browser's own reload button for that page, and `wait network-idle` before reading it, since nothing waits for the load.

The window and tab model itself — `tabs`, `tab-new`, `tab-show`, `tab-assign`, `tab-close`, `--tab`, holds, and how several conversations share one window — is documented in `~/.craft-agent/docs/browser-tools.md`.

---

## Common validation errors

- `create needs a name.` → pass one: `create Checkout flow`
- `<cmd> needs a prototype. Pass one — "<cmd> <slug>" — or open it in this window first ("open <slug>"), which is what makes the page say whose it is. "list" shows what exists.` → no slug was given, and neither the page this session works from nor its binding names one
- `pages --add needs a page name, and a url for a live page.` → `--add payment=https://app.example.com/pay` (live) or `--add orders` (a document that already exists)
- `pages --rename needs old=new.` · `pages --remove needs a page name.` · `pages --change needs <name>=<url>.` · `pages --layout/--no-layout needs a page name.`
- `entry needs a page name, or "none".` → `entry cart`
- `--tab needs a tab id.` → `tabs` lists them: `snapshot --tab tab-3`
