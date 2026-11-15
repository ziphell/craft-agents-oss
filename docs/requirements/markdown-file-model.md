# The markdown editor's file model

> **What this is.** The rules a `.md` file is read and written by, in one place — each rule with the code it lives in
> and the test that holds it. They are decisions, not defaults: most of them were arrived at by measuring what the
> parser and serializer actually do, and several of them exist to keep a person's file from being rewritten by an
> editor that only meant to change one word.
>
> **Where the upgrade stands:** `docs/design/tiptap-upgrade-plan.md`. This page describes the model as it is today, on the TipTap
> version we run.
>
> **Should the *reading* face be TipTap too?** `docs/research/md-preview-tiptap-evaluation.md` — measured: raw HTML, angle-bracket
> autolinks and uppercase `> [!NOTE]` all fall to the literal path, so the answer is a read-only presentation mode with
> a per-block fallback, not a swap.

## 1. The shape of a file

`layoutMarkdown` (`packages/shared/src/markdown/blocks.ts`) cuts a file into **blocks and the bytes between them**:
mdast gives each top-level block an offset range, and everything else — blank lines, indentation, the newline style —
is a `gap` chunk. `blocks + gaps` is the file, byte for byte.

That single paragraph is the foundation of everything else:

| Rule | Where | Test |
| --- | --- | --- |
| One file block becomes one document node, always | `editors/block-parse.ts` (`blocksToDocument`) | `tiptap-roundtrip.test.ts` — "keeps block count equal to node count" |
| A save rewrites only the blocks that changed; every other byte is the file's own | `editors/markdown-save.ts` (`saveBlocks`) | `block-table.test.ts` — "writes only the edited block…" |
| Offsets after a save are **shifted**, not re-read (1–2 ms per keystroke instead of ~29 ms) | `editors/block-table.ts` (`retableByShift`) | `block-table.test.ts` — "retable without reading the file again" |
| A block is trusted to the engine only if its **words** survive the round trip | `editors/block-parse.ts` (`says`) | roundtrip — "still refuses a block that loses a word" |
| A block the engine cannot carry is kept as its own text, so it is visible and round-trips | same | roundtrip — "survives the round trip character for character" |

## 2. The parts of a file that are not the document

Frontmatter, line endings, the trailing newline and a BOM never enter the document
(`shared/src/markdown/envelope.ts`): the editor is handed the body alone, and what it writes back is dressed in the
envelope it arrived in. A `SKILL.md` therefore keeps its YAML, and a Windows file keeps its `\r\n` — measured:
a CRLF file edited in the document comes back with 7 CRLF and 0 lone `\n` (`line-endings.test.ts`).

A file with **both** kinds of newline is written back with one kind: the envelope records `\r\n` as soon as one
appears. That is a normalisation, not a loss, and it is asserted so it cannot be mistaken for a bug later.

**Taking the frontmatter off is a decision, and it can be taken back** (2026-11-03). The strip above the document
(`markdown/FrontmatterPanel.tsx`) used to end in a bare `✕` whose tooltip was the *properties hint* — "the document
editor never touches them". One click deleted the file's YAML, and the write followed on the usual 1.2 s debounce:
`示例文档.md` came back with its body byte-identical and its header gone, which is the signature of a change that
touched only the envelope. So the control is a trash icon whose tooltip says it writes to the file, it asks a second
time ("Remove the YAML header?" / Remove / Cancel), and the pane keeps the raw block it removed
(`MarkdownEditorPane`) so the strip's place shows **Frontmatter removed · Undo** until the file is read again. The
textarea can still empty the block by being emptied — that is typing, and it gets the same way back.

## 3. What a person can type, and where it lands

| In the editor | In the file |
| --- | --- |
| text in a paragraph | that block, rewritten from the serializer |
| Enter in the middle of a block | the block splits; both halves are written (`planSaveByDiff`) |
| Backspace joining two paragraphs | one block; the swallowed one is gone |
| an empty paragraph (a blank line) | **nothing** — see §6 |
| a table cell | padded columns; `:` alignment kept; `\|` escaped; `<br>` for a break |
| `> [!note]` | a blockquote with a callout attribute, written back as the marker |
| `![](pics/a.png)` | the picture is read for display, but `src` stays `pics/a.png` |

Two consequences worth knowing:

- **A block that is not live is never re-serialized.** Its bytes are the file's, until somebody types in it.
- **`retable` refuses to guess.** If a shift cannot be confirmed against the text it was given, the table is built
  from the file again — correctness over the 29 ms.

## 4. Outside writes come in as one transaction

`landMarkdown` (`editors/markdown-land.ts`) diffs the file's two versions and replaces only the blocks between the
common prefix and suffix, as one step of the editor's history — the caret is mapped through it, and the person's
unsaved work in other blocks survives.

What it refuses, on purpose: a document whose blocks no longer line up (something was inserted in the middle) is
**reloaded** instead of spliced, because a splice at offset blocks would land in the wrong place. Extra nodes at the
**end** are allowed — a paragraph typed below the last block is not a reason to reload the document under somebody
(measured in `tiptap-roundtrip.test.ts`, "landing while the person has written past the end").

## 5. The editor's own save is not an outside write (2026-11-02)

The pane owns the file and the editor is controlled: every save comes back down as the `content` prop. That makes one
question unavoidable at that boundary — **is this text mine, or did somebody else write it?** — and the editor got it
wrong: a paragraph bolded by hand came back washed, with the "Craft Agent" caret on it.

Measured, on a document whose file also holds a table:

| | |
| --- | --- |
| the document serializes to | `# 标题\n\n**甲段。**\n\n\n\| a   \| b   \|…` |
| the file's body says | `# 标题\n\n甲段。\n\n\| a \| b \|…` |

The old guard compared those two and concluded "outside write". It cannot work: the serializer pads tables, so **the
two are never equal once a table is in the file**, and every save of a document with a table landed the editor's own
edit back onto itself — a transaction marked `agentEdit`, which is what paints the wash and the caret.

So the decision is its own function, `syncVerdict` (`editors/markdown-sync.ts`), and it asks about **provenance**
before it asks about content:

| Input | Verdict |
| --- | --- |
| `content` did not move | `nothing` |
| `content` is the last text this editor emitted | `echo` — its own save, however its serialization compares |
| the document already says this body (a frontmatter or line-ending change) | `echo` |
| anything else | `land` |

`emitted` is the whole fix: `TiptapMarkdownEditor` remembers what it handed to `onUpdate` (all three ways out: the
per-block save, the whole-document fallback, and an addressed edit), and a `content` that equals it is this editor
coming home. Held by `editors/__tests__/markdown-sync.test.ts` (five cases, including "a landing even when this editor
saved something different a moment ago").

### The same question, at the disk boundary

`useFileWriter` asks it too, and always did: it reads before every write, treats a disk that already holds the text it
is about to write as *not a disagreement* ("our own write coming back to us through the watcher"), and **writes
nothing** when the disk already says what it would say. The missing copy was at the prop boundary — which is why the
bug looked like a mystery.

### How the two products we compared handle it

| | Their shape | The echo rule |
| --- | --- | --- |
| **genoffice** (`apps/markdown`) | the document **is** the file while open; saves only go out | a 1 s `fs.watchFile` poll in main (`packages/electron-utils/src/disk-watch.ts`) stamps `mtimeMs`+`size`; the baseline moves **only when the renderer acknowledges**, so a save landing in between is refused as a conflict. The renderer re-reads and returns early on `raw === diskTextRef.current` — the same check as `emitted`, on disk text. Dirty document + changed disk ⇒ **no reload**, a notice, and the user decides |
| **纳米Work** | the md editor is genoffice's module snapshot; its AI edits never touch the file — `editor-service` runs `executeJavaScript` **inside the live editor** | there is no down-flow to be confused by, so no echo rule is needed; staleness is guarded by SHA-256 fingerprints (`originalHash`/`documentHash`) |
| **us** | the pane owns the file, `content` flows down on every keystroke | `syncVerdict`'s `emitted`, above |

One deliberate difference is left: with a dirty document and a changed disk, they **park** the change and refuse to save
until it is acknowledged, while we **land** it as one transaction and keep a conflict banner (`keepMine` /
`reloadFromDisk`). That is the difference between a file editor and a collaborative one, and it is a product stance, not
an oversight.

## 6. Decision: extra blank lines are not written (2026-11-02)

**The question.** A person presses Enter three times to leave vertical space. Should that reach the file?

**What markdown says.** Consecutive blank lines carry no content: a blank line separates blocks, and two of them mean
the same as one. There is no syntax for "an empty paragraph". A file can express vertical space only through
workarounds — `<br>`, an `&nbsp;` sentinel, an empty HTML block — none of which is what the person typed.

**What we do today** (measured):

| Case | Result |
| --- | --- |
| A file that already has three blank lines, edited elsewhere | kept: `# 标题改\n\n\n\n甲段。\n` — gaps are bytes and are never touched |
| Two empty paragraphs typed in the editor | **not written**: the file is `# 标题\n\n甲段。\n`; the document keeps the nodes until it is rebuilt |

An empty paragraph is therefore **editor furniture**: a blank line, a place to put the caret — the same fact the
trailing paragraph states about the one at the end, generalised in `saveBlocks` and `liveTextOf`. That is why the text
an agent reads no longer contains the `&nbsp;` the engine writes for a paragraph with no content.

**If it is ever wanted**, the options and their costs:

| Option | Cost |
| --- | --- |
| **A.** Widen the file's gap by one newline per extra empty paragraph | gaps are currently read-only; this opens a "gap edits" channel into `saveBlocks`/`planSaveByDiff`. Every markdown tool reads it, and no character is invented. The reading face still collapses consecutive blank lines, so the space would show in the editor and the source face but not in the preview |
| **B.** Write the `&nbsp;` sentinel TipTap's `Paragraph` uses | a character nobody typed lands in the file, and the reading face renders it as a space — the exact `&nbsp;` this model removes |
| **C.** Leave it as it is (chosen) | a blank line typed in the editor is not persisted; vertical space in the file has to be added in the source face |

Chosen: **C**. It agrees with the standard, invents nothing, and needs no new machinery. The thing to watch is the
wording, not the code: "press Enter for a gap" is not a promise this editor makes.

## 7. Where the tests are

| File | What it holds |
| --- | --- |
| `editors/__tests__/tiptap-roundtrip.test.ts` | the real engine: block count, per-block save, split/merge/paste, landings, callouts, the trailing and blank paragraphs |
| `editors/__tests__/block-table.test.ts` | the table itself: liveness, the save plan, the region diff, `retable` without re-reading |
| `editors/__tests__/table-alignment.test.ts` | `:` alignment, a pipe inside a cell, `<br>` in a cell, an empty line in a cell |
| `editors/__tests__/callout-and-image.test.ts` | `> [!note]`, and a picture beside the document |
| `editors/__tests__/markdown-envelope.test.ts`, `line-endings.test.ts` | the envelope, and CRLF/LF/BOM/trailing-newline through the save path |
| `editors/__tests__/markdown-sync.test.ts` | what a new `content` prop means: nothing, our own save, or somebody else's write |
| `markdown/__tests__/tiptap-typography.test.ts` | the editing face's typography held to the reading face's values, and what a selection looks like |
