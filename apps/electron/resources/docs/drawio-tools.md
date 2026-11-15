# Diagrams: `drawio_tool`, and the `.drawio` file

**Read this before your first `drawio_tool` command.** It is the whole guide: the commands, the file
format and the rules that fail silently, and where the shapes come from.

A drawio diagram is a **file**, not a reply. Reach for one when the diagram has to outlive the
conversation: a flow a person will keep, open in draw.io, edit and hand to someone else.

`drawio_tool` turns one into the forms that travel — and never creates one: the file is yours to
write.

## The commands

```
pages <diagram-file>                                                    the pages it holds
export <diagram-file> --to <path> [--format svg|png|html|drawio] [--editable] [--page <name>] [--scale <n>] [--theme <t>]
render <diagram-file> [--page <name>] [--scale <n>] [--theme <t>]        the picture, in the reply
```

- **`pages`** lists the pages a file holds, in the order the document has them — a `.drawio` file, or an
  SVG that was exported with a copy of its document inside it (`--editable`): an editable SVG *is* a
  document, so its pages are the copy's and it lists the same way. Read it before naming a page with
  `--page`: the name is the document's own, and there is no way to guess it. It also says when a page
  is stored **compressed** — see "Writing the file".
- **`export`** draws a `.drawio` file into a file that travels. `--to` is required: an export with
  nowhere to go is a render, and a path that names no suffix of its own gets the format's. `--format` is
  `svg` (the default), `png`, `html` (one file, no folder), or `drawio` — which is not a drawing at all
  but the document itself, written out with every page uncompressed; that is also how the document comes
  **back out** of a file that is an exported SVG. `--editable` adds the drawing's document to an SVG (see
  below). `--scale 2` is a crisp PNG for a slide; `--page <name>` draws one page of a multi-page
  file — see "More than one page" below.
- **`--theme`** says what the drawing is **made for** — `auto` (the default), `light`, or `dark`. An
  SVG *states* it: `auto` has the file carry both of its colors and follow whoever shows it, while
  `light` or `dark` pins it, so it looks the same in a dark app and a light one. A PNG is *drawn* that
  way — a picture has no reader to follow, so there `auto` and `light` are the same picture. Only `svg`
  and `png` take the flag; `html` and `drawio` have no scheme to state.
- **`render`** draws the diagram as a picture and puts the picture in the reply, writing nothing.
  Reach for it to check what you drew: XML that is well-formed is not a diagram that reads well,
  and a wall of overlapping boxes can only be seen.

**The `.drawio` file itself is written by hand**, with `Write`/`Edit`, the way every other file of
the work is written — the format is in "Writing the file" below. No command creates one.

Neither command needs a window of yours: the drawing is the drawio webapp the app already ships, in
a hidden window of its own — nothing is installed, no network is reached, and a diagram never leaves
the machine. A relative path counts from the workspace root.

### `svg` or `svg --editable`?

Both write a `.svg`, and they differ in one thing: whether the drawing's **own document** is inside
the file as well as the picture of it.

| | What it is | Reach for it when |
|---|---|---|
| `svg` (default) | The drawing, and nothing to edit | You are showing someone: a README, a slide, a report, a picture in a ticket |
| `svg --editable` | The drawing **plus its document** | You are handing the diagram to someone who may have to **change** it |

`--editable` is drawio's *editable* SVG (`xmlsvg` in drawio's own vocabulary — this command line is
named for the file it writes, and that word is drawio's). Whoever receives it opens it in draw.io and
gets the real diagram back — its pages, its shapes, the actual labels — rather than a picture of one;
they edit it and hand it back. That is what the extra bytes buy, and they can be a lot of bytes: the
document travels inside the file, and any image the diagram uses appears twice, once in the drawing and
once in the document. So the rule of thumb is **`svg` to show, `svg --editable` to hand over for
editing**.

Of a multi-page file, what you see is the page drawn (the first, unless `--page` names one) while the
document inside is the **whole file** — every page travels, so whoever opens it can move between them.
`--page` changes that too: the file is cut down to that one page before it is drawn, so the picture and
the document inside are both that page.

An editable SVG is **read through, never written**. Every command reads a file through the wrapper
first, so such a file is a diagram like any other: `pages` lists the copy's pages, `render` draws it,
and `export <file>.svg --to <file>.drawio --format drawio` writes the document back out — as a file you
can then edit with `Write`/`Edit` and export again. So a diagram that reached you as an SVG is not a
dead end. The drawing half is still drawio's, though: only `export` makes one, and there is nothing
here to hand-edit.

## Rendering one in a conversation

A `drawio-preview` code block names a `.drawio` file on disk:

````
```drawio-preview
{
  "src": "/absolute/path/to/flows/checkout.drawio",
  "title": "Checkout flow"
}
````

| Field | Required | Notes |
|-------|----------|-------|
| `src` | yes | Absolute path to the `.drawio` file |
| `title` | no | Header text; defaults to the file's own name (the page's name when there is only one page) |
| `page` | no | The **name** of the page to open on — the document's own name for it, never a number; the first page when omitted |

One file per block, and the file's pages are the only axis it has: they are offered along the top of
the block, and there is no `items` to fill in — the pages are the document's own, and a spec does not
need to say a second time what the file already says. A page added in draw.io is there the next time
the block renders; one removed is gone.

The file is read at render time, so an edit on disk shows up the next time the block renders.

## More than one page

A `.drawio` file can hold several pages (`<diagram name="…">` elements), which is how one file carries
a diagram per step, or a version per page. **A page is the file's idea, and the file has no current
one**: nothing in it says which page is *the* page, so naming one is always a request.

Drawing is always **one** page at a time. `pages` lists what a file holds; `--page <name>` on a command
and `page` in a block say which one to draw; with neither it is the first page. A block also offers the
pages along its top so a person can flip through them without a command, and the full-screen window
shows that same row — a way of looking, not a state anything writes back. (Once a person has picked
one, that is what the block shows; `page` is where it *opens*.) The editor is drawio's own application,
with its own way to switch pages.

The name is the document's own, and it cannot be guessed — read it with `pages` first. A name no page
has — or one that two pages share — is refused rather than drawn: the block shows the sentence in place
of the picture and a command reports it, because quietly drawing the first page is how the wrong
diagram gets shipped.

An SVG exported with a copy of its document (`--editable`) holds pages the same way — the pages of the
copy inside it, which `pages` lists and `--page` can name. Exported without the copy it is a picture
and holds none: nothing to open, nothing to point at.

## Writing the file

Write it with `Write`/`Edit` like any other file, or let a person draw it in draw.io and hand you the
file. The file on disk is the whole state — nothing is kept anywhere else — so a diagram that is not
written down does not exist.

**Keep the XML uncompressed.** A `<diagram>` may hold either a plain `<mxGraphModel>` or a
deflate+base64 string, and only the plain form is readable by anything other than draw.io —
which is what a source file worth editing, reading and diffing as text needs to be.

A file that arrived compressed — someone saved it with drawio's *Compressed* option, or an older
drawio wrote it — is written out plain with `export <file> --to <plain>.drawio --format drawio`. `pages`
says which pages are compressed, so you do not have to guess.

Keep the `.drawio` suffix — and you do not have to: a `--to` path that names no suffix gets the
format's, which for `--format drawio` is `.drawio`. `.drawio` and `.xml` hold exactly the same
document, and nothing here reads a file differently for its name — `pages`, `--page`, the preview block
and the editor all go by the *content*. But the app opens a diagram by that suffix — a `.drawio` path in
a conversation gets the diagram window — so a diagram under a `.xml` name is only an XML file to it.

```xml
<mxfile>
  <diagram id="page-1" name="Checkout">
    <mxGraphModel dx="800" dy="600" grid="1" page="1" pageWidth="850" pageHeight="1100">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="2" value="Cart" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="140" height="60" as="geometry" />
        </mxCell>
        <mxCell id="3" value="Pay" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="260" y="40" width="140" height="60" as="geometry" />
        </mxCell>
        <mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;html=1;endArrow=classic;" edge="1" parent="1" source="2" target="3">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

The rules that matter:

- `id="0"` and `id="1"` are the two roots every file needs. Real cells start at `2` and name
  `parent="1"`.
- A shape is `vertex="1"` with a `style` and an `<mxGeometry>` giving `x`/`y`/`width`/`height`.
- A connector is `edge="1"` with `source` and `target` naming two cell ids, and
  `<mxGeometry relative="1" as="geometry" />`.
- **Never nest `mxCell` elements.** Containment is expressed by `parent`, never by nesting.
- A `style` is a `;`-separated key/value list: `rounded=1`, `shape=rhombus`, `fillColor=#dae8fc`,
  `strokeColor=#6c8ebf`, `whiteSpace=wrap`, `html=1`, `dashed=1`.
- Pin the attachment points with `exitX`/`exitY`/`entryX`/`entryY` when two edges would
  otherwise be routed along the same path.
- Give every page a `name` — that is the label a person reads in draw.io's page list.

Shape names, with the style syntax for each, are in `drawio-shapes.md` — the `flowchart`, `basic`,
`arrows2`, `bpmn`, `sitemap` and `infographic` libraries, which are the ones a product flow needs.
Prefer a named shape over a hand-built arrangement of rectangles:
`shape=mxgraph.flowchart.decision` is a decision, and drawing one out of a rotated square is a shape
nobody can edit later.

## Being edited by a person

The block is not read-only. Its header offers an edit button whenever the host can write
files at all, and a person can then draw in the diagram itself.

Whether a *particular* file is writable is not something the editor decides: saving goes by the
same boundary that let the host show you the file — what it could read out to you it can write
back — and a path outside it is refused with the refusal rather than quietly written somewhere
else.

Editing works on the file, not on a copy: every change is written back to the same path about
a second after typing stops. The file is also watched while it is on screen, in both
directions:

- **A diagram shown in a conversation follows the file.** Edit it as an agent and the picture
  is redrawn, rather than the conversation only carrying a description of what changed.
- **A write from outside is seen when it happens**, not at the next save. While someone has the
  editor open and nothing has been drawn yet, the editor simply follows the file; once
  something has been drawn the two versions really do disagree, and the person is asked which
  one wins.

Two consequences for you:

- **A person's edit and your `Edit` land in the same place.** Neither can see the other, so
  before writing, the editor re-reads the file, and the person is told as soon as your write
  arrives instead of finding out later.
- **So do not assume a write will stick** while a diagram is open in the editor — and do not
  assume yours will be the one that survives. If you need to change a diagram a person may be
  editing, say so instead of writing over them.

## What a drawio diagram does not do

- **An export is a rendering, not a build.** `drawio_tool export` produces the picture — SVG, PNG,
  an editable SVG, or one HTML file — and nothing else: no bundle, no manifest, no project. What is
  written holds the drawing and nothing about the app it came from, which is exactly what makes it
  something to hand to someone else.
- **Read-only means read-only.** The viewer is served from the app's own origin under a policy
  that allows that origin and nothing else, so an image referenced by a URL will not load
  there. The editor is drawio's own application and is not under that policy: it is *asked*
  to stay offline (drawio's `offline=1`, the same switch its desktop build uses), which is a
  request rather than a fence. Either way, draw the shape instead of linking to it.
