# Prototypes

A prototype is a proposal you can read: a **folder** holding a specification — one markdown file or several — plus any material and any files the work is made of. It is not a running app and nothing renders it *for you* — what the workbench produces is a **specification** (the markdown files, each requirement a `## R-00x` heading) and the thread from each requirement to the files that implement it. An HTML file in the folder can still be opened in a browser: the person does it with the **open in browser** button on the preview its row shows, and you do it with `browser_tool navigate file:///…/cart.html` — it runs as a tab in the workspace's browser window, which is the surface your browser tools can then work on.

Every command belongs to `prototype_tool` and carries no prefix. It acts on the prototype's **files** and drives no browser. Frames out of a recording — one the person made elsewhere, or one this window's own record button wrote to their downloads — are `video_tool sample <path>`'s: Chromium decodes it in a hidden window of its own. The browser surface itself (windows, tabs, refs, snapshots, input, console, network) is `browser_tool`'s and is documented in `~/.craft-agent/docs/browser-tools.md`.

> **Quick start:** `list` shows what exists, `create <name>` makes a folder with a starter `PRD.md`, then write the requirements into its markdown (`## R-001 <what the requirement is>`) and the work's files beside it.

**Read this before your first `prototype_tool` command.** It is the whole guide: what a prototype is, how its files are laid out, and the full command reference.

---

## What a prototype is

- **One folder, and the specification is the markdown in it.** The specification is one file or several — `prototypes/{slug}/PRD.md` is the conventional entry, and any other markdown file is read the same way, so a subject that outgrows the first file gets its own (`docs/features.md`). Everything else in the folder is the author's: the documents that make up the work, and material in any format (personas, a glossary, a screenshot, a spreadsheet). There is no rule about what may sit there and nothing enumerates or filters it.
- **The thread is markers, not a stored index.** A requirement is a heading in a markdown file whose id starts with `R-`; any file in the folder declares what it serves with `@requirement R-001` in a comment, and a finding declares what it argues for with `requirements:`. That is the whole mechanism, and it is what lets the report answer the two questions nobody can answer by reading files one at a time: **which requirement nothing implements**, and **which marker names an id no document defines**. A file that states requirements is a specification, not an implementation of them: a `@requirement` line inside one is not read as building what it specifies. Documents also point at each other with ordinary markdown links — navigation, and where an index pointing at several documents comes from (see "Linking documents").
- **Not a project.** Projects are separate containers that group sessions, tasks and shared assets; a prototype is never nested inside one. A prototype also **belongs to no project**: the same prototype can be worked on from conversations of different projects. A project may only note which prototypes its work touches — background information, never a binding.
- **A bound session is told about its prototype up front.** When a conversation is bound to a prototype, a `<prototype_context>` block is injected into its system prompt describing that prototype's requirements, findings and disputes before the user says anything. This guide is the general model; the block is the specific state. **Binding is the person's and there is no command for it**: the prototype panel sets it, `create` binds what it made, and `--no-bind` declines to. A command without a slug uses this session's binding.

---

## Where it lives

```
prototypes/{slug}/
├── PRD.md                     the brief — one markdown file or several, a "## R-00x" heading per requirement
├── docs/features.md           a subject that outgrew the first document — read the same way
├── cart.html                  the work's own files — any format, any number of them
├── cart.drawio                a diagram's source — a process file, not the brief's picture
├── cart.drawio.svg            the diagram itself, drawn from it — see "Diagrams in the brief"
├── personas.md                material beside the brief, in any format
├── research/                  what you learned: findings (F-001-….md)
└── reviews/                   the argument against the work, one dispute per file
```

**The filesystem says what exists.** There is no table, no index and nothing to declare: a file is a file, the requirements are the `## R-00x` headings in the folder's markdown — in one document or several, flat or in a subfolder — and what each file serves it says itself with `@requirement R-001`. Directories above are conventions the tooling reads — `research/`, `reviews/` — and everything else is yours.

---

## Linking documents

One document points at another with an ordinary markdown link, which is how a specification stays readable as it grows: the entry document states a requirement in a line and hands the detail to its own file.

```md
## R-003 Checkout, in detail

The flow, the states and the error cases are in [the checkout document](docs/checkout.md).
```

**Ordinary markdown, deliberately.** The link is the same link in every reader — a colleague's editor, GitHub, this app — because it *is* markdown. A syntax of this app's own would be a pair of stray brackets everywhere else, which is the same argument that made a diagram's picture plain `![]()` rather than a fence only this app draws.

- **A relative destination is resolved against the document it is written in, then the folder** — `docs/checkout.md` written in `PRD.md`, or `../PRD.md` written in `docs/checkout.md`. Write the file's own name, extension and all.
- **A link to a document names a file.** A destination the browser fetches on its own (`https:`, `mailto:`, `data:`), an absolute path, a `#section`, or a relative destination that names no file is not a document in this folder — it is left alone.
- **A link is navigation, never a claim.** It says where to read next; it does not say a requirement is done. Implementation is still `@requirement R-00x` and nothing else.
- **A link that points at nothing is reported** — a target that stopped existing is exactly the silent failure an index has. A link written inside a code span or a fenced block is an example, not a link.
- **The page reads them both ways**: under a document it lists what that document links to and what links back to it — the half a one-way pointer cannot give you.

---

## Diagrams in the brief

A diagram is a picture **in the brief**, and the picture is an **editable SVG exported from a `.drawio` file**:

```
drawio_tool export cart.drawio --to cart.drawio.svg --editable
```

```md
## R-002 The cart is priced at checkout

![The cart](cart.drawio.svg)
```

- **The brief shows it with ordinary markdown image syntax, never a preview block.** A `drawio-preview` fence is this app's own construct — a JSON spec the app knows how to draw — so a brief carrying one is a document only this app can read: everywhere else (a colleague, GitHub, an editor) the diagram is a block of JSON where the picture should be. `![…](…)` is the same picture in every reader, and it resolves against the brief's own folder, so the file beside the brief is the whole of what the picture needs.
- **A diagram declares no requirement.** A `@requirement` line inside the `.drawio`'s XML would be found by the same text scan every other file goes through, so the *drawing* would count as implementing the requirement — a picture standing in for work — and the copy of the document inside the exported `.drawio.svg` can carry the same line into a second file, a render claiming it too. Which requirement a diagram is about is said by **where it sits in the brief**, and nowhere else.
- **`.drawio.svg` is the one name here that means something** — a name you give, not a rule anything enforces. `.svg` is what makes a reader draw it as a picture; `drawio` in front is what tells a render that can be regenerated from a picture somebody drew by hand.
- **`--editable` rather than a plain `svg`, because that export still carries its own document.** The picture alone opens in draw.io and can be edited, which is what is otherwise lost when the `.drawio` it came from is not what gets handed over.
- **The `.drawio` is a process file.** It is what you edit — the app's diagram editor, or draw.io itself — and the brief does not name it. It stays in the folder, because nothing here hides a file; it is simply not the artifact the brief is read from.
- **The SVG is a render, so editing the `.drawio` does not change it.** Export again after an edit: a brief showing yesterday's picture is the one way this pair goes wrong.
- **And the pair is checked for you.** The exported picture carries its own copy of the document it was drawn from, so the workbench compares the two and names the picture when it no longer shows the `.drawio` beside it — that silent failure is the one thing this will not leave silent. One change escapes that reading: a page *added* to the `.drawio` looks the same as an export made with `--page`, so adding a page is a reason to export again even when nothing is reported. A picture with no `.drawio` of that name beside it is passed over in silence — where a picture came from is not something this can know. (Reading it is also why `svg --editable` rather than a plain `svg` is the export the brief wants: an export without its copy is a picture with nothing to compare.)

---

## Requirements, research and reviews

**The specification** is prose you write, not a form you fill in — one markdown file or several. One entry per requirement, headed by a stable id:

```md
## R-001 A cart holds its line until stock runs out

Given a line is in the cart, when another shopper takes the last unit…
```

- The id is the entire mechanism: short, stable when you rewrite the prose around it, and the thing every reference is written against.
- Think from first principles about the value — what the person cannot do today, and what actually changes for them. A requirement that restates a screen, a competitor's feature or the user's own phrasing has not been thought about, and nothing here can check that for you: the workbench can show a requirement is unimplemented, never that it was worth writing.
- A subject that outgrows the first document (personas, a glossary, the flow as it stands today) becomes its own markdown file **in the folder** rather than one document nobody can skim, and the entry points at it. Every markdown file is read for requirements the same way.

**`research/`** holds what you learned about other products. One finding per file, shaped like a `PRD.md` entry so the two read the same way:

```md
# F-001 The total stays pinned while the list scrolls

claim: The cart keeps the total visible at all times, so the decision is never off screen.
source: https://shop.example.com/cart
captured: 2026-09-15
evidence: shots/cart-top.png
requirements: R-003

The pinned bar is `position: sticky` on the summary row…
```

`source` is where it was seen (a claim about someone else's product that cannot be re-checked is a rumour). `evidence` names files you keep under `research/`, **checked against the disk** — a citation that is not there is reported, because a broken citation is how a finding becomes unfalsifiable. `requirements:` names the requirements the finding argues for; a finding is **evidence, never implementation**, so it does not count as covering one. `research/` is yours to read, and it is not part of what is handed over.

**`reviews/`** holds the argument *against* the work — one dispute per file:

```md
# D-001 The total is not actually pinned while the list scrolls

about: requirement R-003
on: 3f9a1c2e
status: open
claim: The summary row is not on screen once the list is longer than the viewport.
evidence: shots/cart-scrolled.png

The requirement does not say what happens when the line is gone…
```

- **`about:`** names one thing: `requirement R-00x`. A dispute that names nothing is an opinion, and the report says so. A dispute is threaded onto the requirement it names, so a review never restates the thread and copies cannot drift.
- **`status:`** is `open` (it stands), `fixed` (the thing was changed), `rebutted` (you judged it unfounded, reason in the body) or `accepted` (valid, and the cost was taken deliberately).
- **`on:`** is the **fingerprint of the disputed requirement** as it was written when the review was filed — `status` prints it beside every requirement. It is required, and it is what makes the record checkable: a dispute is reported **stale** when the requirement no longer hashes to that value, so "argued about a wording that no longer exists" cannot pass for a live objection. `fixed` on a requirement that has *not* changed is stale in the same way.
- An objection that still stands is reported by `status` (and by the app's gate) and stays reported until somebody answers it. Nothing hides it: a specification that lists only what was built hands over a claim rather than a position.

---

## The workflow

1. **Create** — `create <name>` makes a folder with a starter `PRD.md` and nothing else. (`--no-bind` leaves the session's binding alone, which is what studying another prototype needs.)
2. **Write the requirements** — into one or more markdown files, before building the work they describe. A prototype nobody can read a requirement out of is a picture, not a proposal.
3. **Study what you need** — with the browser tool on the real product, and record what you learn as findings under `research/`. Say where you looked (`source`) and keep the evidence (`evidence`).
4. **Build** — write the work's files with the `Write` tool, and say which requirement each serves with `@requirement R-001` in a comment.
5. **Argue with it** — file what you disagree with under `reviews/`; `status` reports what is still owed.

---

## Command reference

### `list`

Every prototype in this workspace with its requirement and file counts, and which one this session is bound to. Start here when you do not know what exists.

### `create <name> [--no-bind]`

Create a prototype: a folder with a starter `PRD.md` and nothing else. It asks for a name only — there is no kind, no address and nothing else to decide, because everything in the folder is a file somebody writes into it afterwards. `--no-bind` creates it **without** stealing this session's binding, which is what you want when you only mean to study it.

### `status [slug]`

The report, read from disk. Each fact is recomputed, nothing is cached:

```
Prototype "checkout-flow"
  dir:        /…/prototypes/checkout-flow
  spec:       PRD.md — 3 requirements
  requirements:
      R-001 A cart holds its line — cart.html · on: 3f9a1c2e
      R-002 The cart is priced at checkout — nothing refers to it yet · on: 77aa11bb
      ("on:" is the fingerprint of a requirement — write it in a review about that requirement; it changes when the requirement is rewritten.)
  files:      cart.html, personas.md
  findings:   2 (research/F-001-sticky.md, research/F-002-copy.md)
  issues:     1
    • R-002 is in PRD.md but no file refers to it, so nothing in this prototype implements it.
  reviews:    1 standing of 2 filed
  unresolved: 2
    • R-002 is in PRD.md but no file refers to it, so nothing implements it.
    • reviews/D-001-total.md disputes requirement R-003, and it still stands (open).
```

- A row with `nothing refers to it yet` is a requirement nothing implements — the failure this report exists to name.
- `spec:` names the markdown files that state requirements — one or several; the message about a requirement always names the file it was written in.
- `issues:` are the silent failures: a reference to an id no document defines, a link that points at nothing, a finding whose `evidence:` is not on disk, a duplicate id.
- `unresolved:` is what is still **owed** — last, because it is the thing to act on. It is the same list the app's gate reads, so a report cannot look calmer here than the work is.
- `on:` beside each requirement is the value a review of it writes as `on:` (see `reviews/` above).

---

## Common validation errors

- `create needs a name. Example: create Checkout flow` → pass one
- `create does not take "<flag>". …` → `create` takes a name and `--no-bind`, nothing else
- `<cmd> needs a prototype. Pass one — "<cmd> <slug>" — or bind this conversation to one, which is what makes a slug-less command mean something. "list" shows what exists.` → no slug was given and this session is not bound
- `Missing command. Use "--help" to see the prototype_tool commands.` → pass a command
- `Unknown prototype_tool command "<cmd>". One command per call — "--help" lists them. Driving the window itself (navigate, snapshot, click, evaluate, tabs, …) is browser_tool's.` → the window's own commands are `browser_tool`'s
