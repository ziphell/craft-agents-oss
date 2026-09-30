# Prototypes

A prototype is a proposal you can read: a **folder** holding a specification — one `*.spec.md` file per spec, plus an entry `spec.md` indexing them — plus any material and any files the work is made of. It is not a running app and nothing renders it *for you* — what the workbench produces is a **specification** (a `*.spec.md` file per spec) beside the files the work is made of, and a report of what the folder holds. An HTML file in the folder can still be opened in a browser: the person does it with the **open in browser** button on the preview its row shows, and you do it with `browser_tool navigate file:///…/cart.html` — it runs as a tab in the workspace's browser window, which is the surface your browser tools can then work on.

Every command belongs to `prototype_tool` and carries no prefix. It acts on the prototype's **files** and drives no browser. Frames out of a recording — one the person made elsewhere, or one this window's own record button wrote to their downloads — are `video_tool sample <path>`'s: Chromium decodes it in a hidden window of its own. The browser surface itself (windows, tabs, refs, snapshots, input, console, network) is `browser_tool`'s and is documented in `~/.craft-agent/docs/browser-tools.md`.

> **Quick start:** `list` shows what exists, `create <name>` makes a folder with a starter `spec.md` index, then give each spec its own `*.spec.md` file (`cart-line.spec.md`) and put the work's files beside it.

**Read this before your first `prototype_tool` command.** It is the whole guide: what a prototype is, how its files are laid out, and the full command reference.

---

## What a prototype is

- **One folder, and the specification is one file per spec.** A spec is its own file, named `<name>.spec.md` (`cart-line.spec.md`, `docs/checkout.spec.md`) — one file, one spec, and the file's name is the spec's identity. `prototypes/{slug}/spec.md` is the conventional entry: an **index** whose name does not end in `.spec.md`, so it states no spec itself. Everything else in the folder is the author's: material in any format (personas, a glossary, a screenshot, a spreadsheet), the work's own files, and any other markdown — a research note, a `README.md` — which is material too, because being markdown is not what makes a spec. There is no rule about what may sit there and nothing enumerates or filters it.
- **The file's name is the spec's stable name, and nothing claims an implementation.** A spec's identity is its path, so there is no id to keep in sync and no two documents can collide over one. Its **first heading** is the title (its name without `.spec.md` when it has none) and the rest of the file is the spec's prose. Nothing in the folder records what *implements* a spec: the files beside the specification are the work, and a report that claimed to know which of them builds which spec would be a second description of the work, going stale the moment a file changed. What the report answers is what the folder holds — the specs, the files beside them — and where a document was renamed out from under a link. Documents point at each other with ordinary markdown links — navigation, and where an index pointing at several documents comes from (see "Linking documents").
- **Not a project.** Projects are separate containers that group sessions, tasks and shared assets; a prototype is never nested inside one. A prototype also **belongs to no project**: the same prototype can be worked on from conversations of different projects. A project may only note which prototypes its work touches — background information, never a binding.
- **A bound session is told about its prototype up front.** When a conversation is bound to a prototype, a `<prototype_context>` block is injected into its system prompt describing that prototype's specs before the user says anything. This guide is the general model; the block is the specific state. **Binding is the person's and there is no command for it**: the prototype panel sets it, `create` binds what it made, and `--no-bind` declines to. A command without a slug uses this session's binding.

---

## Where it lives

```
prototypes/{slug}/
├── spec.md                    the entry — the index the specification is read from, not a spec
├── cart-line.spec.md          a spec — one file each, its name its identity
├── docs/checkout.spec.md      a spec in a subfolder — read the same way
├── cart.html                  the work's own files — any format, any number of them
├── cart.drawio                a diagram's source — a process file, not the brief's picture
├── cart.drawio.svg            the diagram itself, drawn from it — see "Diagrams in the brief"
└── personas.md                material beside the specification, in any format
```

**The filesystem says what exists.** There is no table, no index and nothing to declare: a file is a file, and the specs are the `*.spec.md` files in the folder — flat or in a subfolder.

---

## Linking documents

One document points at another with an ordinary markdown link, which is how a specification stays readable as it grows: the entry document indexes the specs and hands each one's detail to its own file.

```md
# Checkout, in detail

The flow, the states and the error cases are in [the checkout document](docs/checkout.md).
```

**Ordinary markdown, deliberately.** The link is the same link in every reader — a colleague's editor, GitHub, this app — because it *is* markdown. A syntax of this app's own would be a pair of stray brackets everywhere else, which is the same argument that made a diagram's picture plain `![]()` rather than a fence only this app draws.

- **A relative destination is resolved against the document it is written in, then the folder** — `docs/checkout.md` written in `spec.md`, or `../spec.md` written in `docs/checkout.md`. Write the file's own name, extension and all.
- **A link to a document names a file.** A destination the browser fetches on its own (`https:`, `mailto:`, `data:`), an absolute path, a `#section`, or a relative destination that names no file is not a document in this folder — it is left alone.
- **A link is navigation, never a claim.** It says where to read next, and nothing about what the folder holds.
- **A link that points at nothing is reported** — a target that stopped existing is exactly the silent failure an index has. A link written inside a code span or a fenced block is an example, not a link.
- **The page reads them both ways**: under a document it lists what that document links to and what links back to it — the half a one-way pointer cannot give you.

---

## Diagrams in the brief

A diagram is a picture **in the brief**, and the picture is an **editable SVG exported from a `.drawio` file**:

```
drawio_tool export cart.drawio --to cart.drawio.svg --editable
```

```md
# The cart is priced at checkout

![The cart](cart.drawio.svg)
```

- **The brief shows it with ordinary markdown image syntax, never a preview block.** A `drawio-preview` fence is this app's own construct — a JSON spec the app knows how to draw — so a brief carrying one is a document only this app can read: everywhere else (a colleague, GitHub, an editor) the diagram is a block of JSON where the picture should be. `![…](…)` is the same picture in every reader, and it resolves against the brief's own folder, so the file beside the brief is the whole of what the picture needs.
- **A diagram declares no spec.** Nothing in the folder claims anything about the work — not a picture, not a script — so which spec a diagram is about is said by **where it sits in the brief**, and nowhere else. The `.drawio` and its exported `.drawio.svg` therefore need no annotation of ours in them: what they are is a drawing, read where the brief shows it.
- **`.drawio.svg` is the one name here that means something** — a name you give, not a rule anything enforces. `.svg` is what makes a reader draw it as a picture; `drawio` in front is what tells a render that can be regenerated from a picture somebody drew by hand.
- **`--editable` rather than a plain `svg`, because that export still carries its own document.** The picture alone opens in draw.io and can be edited, which is what is otherwise lost when the `.drawio` it came from is not what gets handed over.
- **The `.drawio` is a process file.** It is what you edit — the app's diagram editor, or draw.io itself — and the brief does not name it. It stays in the folder, because nothing here hides a file; it is simply not the artifact the brief is read from.
- **The SVG is a render, so editing the `.drawio` does not change it.** Export again after an edit: a brief showing yesterday's picture is the one way this pair goes wrong.
- **And the pair is checked for you.** The exported picture carries its own copy of the document it was drawn from, so the workbench compares the two and names the picture when it no longer shows the `.drawio` beside it — that silent failure is the one thing this will not leave silent. One change escapes that reading: a page *added* to the `.drawio` looks the same as an export made with `--page`, so adding a page is a reason to export again even when nothing is reported. A picture with no `.drawio` of that name beside it is passed over in silence — where a picture came from is not something this can know. (Reading it is also why `svg --editable` rather than a plain `svg` is the export the brief wants: an export without its copy is a picture with nothing to compare.)

---

## The specification

**The specification** is prose you write, not a form you fill in — one file per spec. A spec is a file named `<name>.spec.md`, whose **first heading** is the title and the rest of which is the prose:

```md
# A cart holds its line until stock runs out

Given a line is in the cart, when another shopper takes the last unit…
```

Written as `cart-line.spec.md` (a subfolder works too, e.g. `docs/checkout.spec.md`).

- The file's **name** is the entire mechanism: it is the spec's identity — short, stable when you rewrite the prose inside it, and travelling with the folder. There is no id to keep in sync, and no two documents can collide over one.
- Think from first principles about the value — what the person cannot do today, and what actually changes for them. A spec that restates a screen, a competitor's feature or the user's own phrasing has not been thought about, and nothing here can check that for you: the workbench can say what a spec is about, never that it was worth writing.
- Material that outgrows the entry (personas, a glossary, the flow as it stands today) becomes its own document **in the folder** rather than one file nobody can skim, and the entry points at it. A document is a spec only if its name ends in `.spec.md` — the entry `spec.md` and any other markdown are not.

---

## The workflow

1. **Create** — `create <name>` makes a folder with a starter `spec.md` index and nothing else. (`--no-bind` leaves the session's binding alone, which is what studying another prototype needs.)
2. **Write the specs** — each into its own `<name>.spec.md`, before building the work it describes. A prototype nobody can read a spec out of is a picture, not a proposal.
3. **Study what you need** — with the browser tool on the real product. What you learn shapes the specs you write.
4. **Build** — write the work's files with the `Write` tool, beside the specification. The folder is the work: nothing in it declares what it serves, and nothing has to.

---

## Command reference

### `list`

Every prototype in this workspace with its spec and file counts, and which one this session is bound to. Start here when you do not know what exists.

### `create <name> [--no-bind]`

Create a prototype: a folder with a starter `spec.md` and nothing else. It asks for a name only — there is no kind, no address and nothing else to decide, because everything in the folder is a file somebody writes into it afterwards. `--no-bind` creates it **without** stealing this session's binding, which is what you want when you only mean to study it.

### `status [slug]`

The report, read from disk. Each fact is recomputed, nothing is cached:

```
Prototype "checkout-flow"
  dir:        /…/prototypes/checkout-flow
  spec:       spec.md, cart-line.spec.md, pricing.spec.md
      A cart holds its line (cart-line.spec.md)
      The cart is priced at checkout (pricing.spec.md)
  files:      cart.html, personas.md
  issues:     1
    • cart.drawio.svg is not what cart.drawio draws any more — it was exported before the diagram changed.
  unresolved: 1
    • spec.md links to docs/pricing.md, which is not in this prototype.
```

- `spec:` names the specification's files — the entry `spec.md` first, then the spec files — and follows them with one row per `*.spec.md` file: the title its first heading states, with the file beside it. There is **no** row saying what implements a spec: nothing in the folder knows, so the report does not claim it.
- `issues:` are the things that could not be read as written: a picture that no longer matches the diagram beside it.
- `unresolved:` is what is still **owed as a fact** — last, because it is the thing to act on: a link that points at nothing. It is the list the app's gate reads, so a report cannot look calmer here than the work is. Nothing the gate says appears under `issues:` as well — one fact, one sentence.

---

## Common validation errors

- `create needs a name. Example: create Checkout flow` → pass one
- `create does not take "<flag>". …` → `create` takes a name and `--no-bind`, nothing else
- `<cmd> needs a prototype. Pass one — "<cmd> <slug>" — or bind this conversation to one, which is what makes a slug-less command mean something. "list" shows what exists.` → no slug was given and this session is not bound
- `Missing command. Use "--help" to see the prototype_tool commands.` → pass a command
- `Unknown prototype_tool command "<cmd>". One command per call — "--help" lists them. Driving the window itself (navigate, snapshot, click, evaluate, tabs, …) is browser_tool's.` → the window's own commands are `browser_tool`'s
