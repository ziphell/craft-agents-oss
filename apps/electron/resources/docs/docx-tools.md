# Word: `docx_tool`, and the `.docx` file

**Read this before your first `docx_tool` command.** It is the whole guide for Word documents: what
the file is, what each command does to it, and the failures that do not announce themselves.

**You never write a `.docx`'s bytes.** It is a zip of XML parts — document, styles, relationships,
content types — that must agree with each other. A file that half-agrees opens in one program and not
the next, and the failure surfaces days later on someone else's machine. So the engine makes and
changes it; `docx_tool` is the door.

## Making one

Write the Markdown first (`Write` it as a file of your own work), then make the document from it.
Markdown is where the thinking is readable and diffable; the `.docx` is the deliverable. Headings,
lists, tables, code blocks and links carry over; Chinese and mixed-language text is fine.

```bash
docx_tool create brief.md --out brief.docx
```

An existing `--out` is **refused** — that is the tool protecting a file that may be someone's work.
`--force` replaces it, and only when you mean to.

## Read before you change

```bash
docx_tool read brief.docx            # blocks, numbered from 0
docx_tool read brief.docx --json     # the same, machine-readable
```

What it prints is what `apply` addresses: **block indexes**, in document order. A guessed index lands
in the wrong paragraph and says nothing, so read first — it is one call and it is the difference
between an edit and a surprise. `--range`, `--revisions`, `--comments`, `--styles` narrow the answer.

## Changing it in place

```bash
docx_tool apply brief.docx --ops ops.json
docx_tool apply contract.docx --ops edits.json --track --author "Ryan"
docx_tool apply brief.docx --ops risky.json --dry-run
```

Ops are structured, not text search: `findReplace`, `setFont`, `setParagraphFormat`,
`setHeadingLevel`, `deleteBlocks`, `moveBlocks`, `insert_*`, `set_properties`, `insertToc`, and the
table ops. `guide docs` prints the list; `guide docs <op>` prints one op's fields.

- **`--track` is the right call on a document someone else owns.** The edits arrive as revisions with
  an author, so a person accepts or rejects them in Word. Use it for a contract, a review, anything
  you did not write.
- **Only what you change is rewritten.** Comments, tracked changes, footnotes, charts and everything
  else survive byte for byte, and the diff a person sees is the one you meant.
- **`--dry-run`** validates and reports without touching the file. Use it when an op is the least bit
  uncertain.
- **`--out`** writes to a new file instead of changing this one.

## Changing one span, inside the open editor

```bash
docx_tool edit-selection brief.docx --from 120 --to 180 --expect "old words" --text "new words"
```

When the person has the file **open**, the change can land in their editor: one step of their undo,
their caret stays where it was, and nothing reaches the disk until they save. `--expect` is the
fingerprint — a span that no longer says that is refused rather than replaced, so read the span again
and retry. With no editor showing the document (or unsaved changes in one), the command says so and
you edit the file instead.

## Templates and redlines

```bash
# values.json: {"party":"山西焦煤","amount":12800,"terms":{"days":30}}
docx_tool merge contract.docx --data values.json --out filled.docx
docx_tool compare v1.docx v2.docx --out redline.docx
```

`merge` fills `{{key}}` placeholders — nested keys read as `terms.days` — and answers `used_keys`,
`unused_keys` and `unresolved_placeholders`, which is how you find out a template and its data
disagree. `compare` writes the difference as **tracked revisions**, which is what a person reviews.

## Checking your own work

```bash
docx_tool check brief.docx      # stale TOC, broken refs, leftover placeholders, pending revisions
docx_tool render brief.docx     # page 1 as a picture
```

`check` changes nothing and is the cheapest way to catch a document that will look wrong to someone
else: a table of contents nobody refreshed, a `{{name}}` nobody filled, a reference pointing at a
bookmark that is gone.

`render` is the only way to see a layout that does not fit — text that runs off the page, a table
wider than its column. It needs a renderer (the app on a desktop, a headless Chromium on a hub); with
none, the command says so and `check` still works.

## What fails, and what to do about it

- **`apply` refuses an op addressed to something that is not there.** The answer names the op and the
  index; re-read and retry rather than guessing a nearby id.
- **`--track` on a document with pending revisions** can refuse: accepting or rejecting them first is
  the person's call, not the tool's.
- **A `.xlsx` or `.pptx` handed to this tool** is refused by name — `xlsx_tool` / `pptx_tool` is the
  door for it, and their ops are different ops.
- **Converting** a `.docx` to `md`, `html`, `pdf` or anything else is `convert_tool`'s job.
