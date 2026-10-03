# Layers

This folder is where a project is thought through. Its **goal**, its **specifications** and its **plans** are files here, and what follows is the detail behind the rules the work block states.

Each layer is one kind of file — one `goal.md` for the project, one file per piece of work for a spec and a plan. They are **stages** — a conversation works in one at a time — and the work block names the one it is in.

Nothing claims that a specification is implemented: the folder *is* the work, and what is in it is read for what it is. Which folder a given piece of work lives in is named where the work starts (a conversation working in a mode is told its folder), so nothing here names a second place to look and nothing here is remembered: a report is read off the disk, every time.

What follows is what is *not* said anywhere else — the three layers, how the documents point at each other, how a diagram takes part in one, and how each layer is written.

---

## The three layers

| Mode | One file per | Name | Must not |
|---|---|---|---|
| `goal` | project | `goal.md`, at the folder's root | say how anything is done, or the detail of any one piece |
| `spec` | piece of work | `*.spec.md` | say how it is built (tech stack, APIs, code structure) |
| `plan` | piece of work | `*.plan.md` | change what the spec asks for |

- **`goal` — why the project exists.** One `goal.md` at the folder's root: a fixed name, one per project. Say what it is for and what it is not; leave "how" and the detail of any single piece to the layers below. Read the project's name, its description and its details before writing.
- **`spec` — what is needed, in the words of the people it is for.** One `*.spec.md` per piece of work, at the folder's root or in a subfolder. Say what is needed, not how it is built — no tech stack, no APIs, no code structure; that belongs in a plan. Write it for the people who asked, not the people who will build. Where something is not settled, say so; never guess. Read the `*.spec.md` files already here, and `goal.md` if there is one, before writing.
- **`plan` — how one piece gets built.** One `*.plan.md` per piece of work, sharing the spec's stem. Write the steps, not the requirements: do not change what the specification asks for; if the intent itself needs to change, go back and change the `*.spec.md` it is written in. Read the same-stem `*.spec.md` — required, a plan is written for one piece of the specification and must not drift from it — and `goal.md` if there is one, before writing.

**A plan is where the thinking ends.** Once its steps are settled, the `*.plan.md` file itself is handed to the task generator, which reads it and turns the steps it states into nodes rather than re-inventing a decomposition; this family adds no `*.tasks.md` file.

**The stem is the grouping key.** `cart.spec.md` and `cart.plan.md` are the two layers of one piece of work — and that is the whole of the grouping: nothing else records which plan belongs to which spec, because the name already says it. No feature directory, no pointer file.

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
- **A link may leave the folder.** A spec shared with another project is read by following the path to it: write the path, and it resolves against the disk like any other.

---

## Diagrams in the folder

A diagram is a picture **in the folder**, and the picture is an **editable SVG exported from a `.drawio` file**:

```
drawio_tool export cart.drawio --to cart.drawio.svg --editable
```

```md
# The cart is priced at checkout

![The cart](cart.drawio.svg)
```

- **A document shows it with ordinary markdown image syntax, never a preview block.** A `drawio-preview` fence is this app's own construct — a JSON spec the app knows how to draw — so a document carrying one is a document only this app can read: everywhere else (a colleague, GitHub, an editor) the diagram is a block of JSON where the picture should be. `![…](…)` is the same picture in every reader, and it resolves against the document's own folder, so the file beside it is the whole of what the picture needs.
- **A diagram declares no spec.** Nothing in the folder claims anything about the work — not a picture, not a script — so what a diagram is about is said by **where it sits in that document**, and nowhere else. The `.drawio` and its exported `.drawio.svg` therefore need no annotation of ours in them: what they are is a drawing, read where the document shows it.
- **`.drawio.svg` is the one name here that means something** — a name you give, not a rule anything enforces. `.svg` is what makes a reader draw it as a picture; `drawio` in front is what tells a render that can be regenerated from a picture somebody drew by hand.
- **`--editable` rather than a plain `svg`, because that export still carries its own document.** The picture alone opens in draw.io and can be edited, which is what is otherwise lost when the `.drawio` it came from is not what gets handed over.
- **The `.drawio` is a process file.** It is what you edit — the app's diagram editor, or draw.io itself — and the document does not name it. It stays in the folder, because nothing here hides a file; it is simply not the artifact the document is read from.
- **The SVG is a render, so editing the `.drawio` does not change it.** Export again after an edit: a document showing yesterday's picture is the one way this pair goes wrong.
- **And the pair is checked for you.** The exported picture carries its own copy of the document it was drawn from, so the report compares the two and names the picture when it no longer shows the `.drawio` beside it — that silent failure is the one thing this will not leave silent. One change escapes that reading: a page *added* to the `.drawio` looks the same as an export made with `--page`, so adding a page is a reason to export again even when nothing is reported. A picture with no `.drawio` of that name beside it is passed over in silence — where a picture came from is not something this can know. (Reading it is also why `svg --editable` rather than a plain `svg` is the export the document wants: an export without its copy is a picture with nothing to compare.)

---

## Writing the specification

**The specification** is prose you write, not a form you fill in — one file per spec, named `<name>.spec.md`, whose **first heading** is the title and the rest of which is the prose:

```md
# A cart holds its line until stock runs out

Given a line is in the cart, when another shopper takes the last unit…
```

- The file's **name** is the entire mechanism: it is the spec's identity — short, stable when you rewrite the prose inside it, and travelling with the folder. There is no id to keep in sync, and no two documents can collide over one.
- Think from first principles about the value — what the person cannot do today, and what actually changes for them. A spec that restates a screen, a competitor's feature or the user's own phrasing has not been thought about, and nothing here can check that for you: the report can say what a spec is about, never that it was worth writing.
- Material that outgrows the entry (personas, a glossary, the flow as it stands today) becomes its own document **in the folder** rather than one file nobody can skim, and the entry points at it. A document is a spec only if its name ends in `.spec.md`; the entry `spec.md` is the index, `goal.md` and the plans are their own layers, and any other markdown here is material.
- **Write the specs before building the work they describe.** Something nobody can read a spec out of is a picture, not a proposal. The work's own files are written with the `Write` tool, beside the specification: nothing in the folder declares what it serves, and nothing has to.
