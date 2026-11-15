# TipTap 3.20 → 3.32.2: what it buys, what it breaks, and the order to do it in

> **What this is.** The plan for moving every `@tiptap/*` package in the repository from `3.20.0` to
> `3.32.2`, written after running our own editor tests against 3.32.2 in an isolated copy (§2) rather than
> reading changelogs. It records the measurements, the one behavioural change that needs code of ours first,
> and the steps with an acceptance criterion each — so a failure is a step number, not "the editor broke".
>
> **Verdict:** worth doing. The API is additive only, 130 of our 133 engine tests pass unchanged, and the
> upgrade retires the parts of `TableAlignment` that upstream now owns: its custom table renderer, the `align`
> attribute and the pipe escaping (the file is 298 lines today, half of them commentary; what survives is
> `inlineWithBreaks` and two helpers the reading face uses). It does **not** retire `<br>` in a cell or the
> `says()` gate — 3.32 measured worse than us on both (§1). **One prerequisite fix** (§5) has to land first, and
> it is worth landing on 3.20 anyway.
>
> **See also:** [`editor-ui-checks.md`](editor-ui-checks.md) — what "verified" has to mean for steps 6–7, which
> are the two this plan has not run. [`markdown-file-model.md`](markdown-file-model.md) — the rules the upgrade has to
> keep (one block per node, untouched bytes, the word-level trust test), and what each of them is held by.
>
> **Budget:** ~0.5h to bump and install, ~2h for the connected code, ~0.5h for the real-machine pass.

## 0. Status

| Item | State |
| --- | --- |
| API surface compared (8 packages) | ✅ done — no removals (§3) |
| Our engine tests run on 3.32.2 (sandbox) | ✅ done — 130 pass, 3 fail (§3) |
| Our extensions type-checked against 3.32.2 types | ✅ done — clean (§3) |
| React layer (editor component, node views, bubble menus) run on 3.32.2 | ❌ **not done — step 6** |
| Real application, real document pass | ❌ **not done — step 7** |
| Ships in this working tree | ❌ not yet |

## 1. Why: what 3.32 already does, that we hand-built

Everything below was read out of the shipped `dist` of 3.32.2 and, for the parts that matter, executed (§2).

| Ours today | Upstream | Measured on 3.32.2 |
| --- | --- | --- |
| `TableAlignment`: `align` on cells, `token.align` on parse, colons in the delimiter row | **3.21** | ✅ replaces ours (`| :---: |`) |
| `escapeCellPipes()`: `\|` inside a cell | **3.32** | ✅ replaces ours (`a \| b`) |
| cell with several blocks joined, every newline → `<br>` | 3.32 | ✅ replaces ours (`上<br>下`) |
| empty block inside a cell → an empty line | — | ✅ upstream already does it (`上<br><br>下`): on 3.32 an empty paragraph renders to `''`, where 3.20 wrote `&nbsp;` |
| table's own extent (where a table token ends) | 3.21 | ✅ replaces `marked`'s greedier tokenizer |
| `inlineWithBreaks()`: `<br>` in a cell → `hardBreak` | — | ❌ **upstream drops the break**: `\| a<br>b \|` parses to the text `ab` |
| `says()` gate for raw/inline HTML | — | ❌ **upstream still loses the words**: `按 <kbd>Ctrl</kbd> 保存` → `按  保存`, `<div>x</div>` → an empty paragraph |

The last two rows are the reason this is a bump, not a deletion: 3.32's `parseHTMLToken` does parse inline HTML
through the schema's `parseDOM`, but our schema has nowhere to put `<kbd>`'s content and nothing keeps the break,
so **both of those stay ours** (and `says()` stays the thing that notices).

## 2. How this was measured (reproducible)

The repository's `node_modules` was **not** touched. The editor layer was copied into a scratch project with
its own dependency tree:

```bash
mkdir -p /tmp/t32test/src/components/{editors,markdown/extensions} /tmp/t32test/src/shared/markdown
# package.json: @tiptap/{core,pm,starter-kit,markdown,react,extension-*} at 3.32.2, plus linkedom,
#               unified, remark-{parse,gfm,frontmatter}, unist-util-visit, @types/mdast
bun install

cp packages/ui/src/components/editors/*.ts        /tmp/t32test/src/components/editors/
cp -r packages/ui/src/components/editors/__tests__ /tmp/t32test/src/components/editors/
cp packages/ui/src/components/markdown/{callouts,remarkCallouts,document-path}.ts /tmp/t32test/src/components/markdown/
cp packages/ui/src/components/markdown/extensions/{CalloutBlockquote,DocumentImage,TableAlignment,AgentPresence}.ts \
                                                  /tmp/t32test/src/components/markdown/extensions/
cp packages/shared/src/markdown/*.ts              /tmp/t32test/src/shared/markdown/
# the two re-export shells point at the workspace package; in the sandbox they point at the copy:
#   editors/markdown-blocks.ts   -> export * from '../../shared/markdown/blocks'
#   editors/markdown-envelope.ts -> export * from '../../shared/markdown/envelope'

cd /tmp/t32test && bun test src/components/editors/__tests__     # 130 pass, 3 fail
bunx tsc --noEmit                                                # our extensions: clean
```

The same recipe is how to re-measure after any future version, and how to try `latest` before bumping.

## 3. Measurements

### API surface, 3.20 → 3.32.2 (exported names in `dist/index.d.ts`)

| package | 3.20 | 3.32.2 | removed |
| --- | --- | --- | --- |
| `@tiptap/core` | 205 | 324 | none |
| `@tiptap/markdown` | 11 | 13 | none |
| `@tiptap/react` | 27 | 48 | none |
| `@tiptap/extension-table` | 12 | 19 | none |
| `@tiptap/extension-mathematics` | 8 | 11 | none |
| `@tiptap/starter-kit` | 3 | 3 | none |
| `@tiptap/extension-image` | 4 | 5 | none |
| `@tiptap/extension-blockquote` | 4 | 4 | none |

Option names we configure still exist: `StarterKit{blockquote, codeBlock, heading, link, trailingNode}`,
`Mathematics{inlineOptions, katexOptions}`, `Link{openOnClick}`.

### Our tests on 3.32.2

```
src/components/editors/__tests__  133 tests: 130 pass, 3 fail
```

Passing unchanged: the block table, per-block save, outside writes landing, the trailing paragraph, tables
(alignment, `<br>`, `\|`, multi-block cells, empty line — the first three through *our* code, see §1), callouts,
document images, block-count changes (Enter / merge / paste). Failing:

1. `a block the engine cannot represent > survives the round trip character for character` — §4
2. `what the document looks like after opening, block by block > shows the markup as text …` — §4
3. `a document that ends with a table > saves the first paragraph of an empty file` — an empty document now
   holds one empty paragraph instead of none (assertion only; `appendixIndex` already treats it as the
   trailing paragraph, so behaviour is right).

## 4. The behaviour that changes: text is escaped on the way out

3.32's `@tiptap/markdown` renders a text node through:

```js
escapeMarkdownSyntax(encodeHtmlEntities(text))   // encodeTextForMarkdown, no option to turn it off
```

- `encodeHtmlEntities` is new — `<` and `>` become `&lt;` / `&gt;` (3.20 left them alone);
- `escapeMarkdownSyntax` backslash-escapes `` \ ` * _ [ ] ~ `` (3.20 did not escape text at all).

Consequences, in the order they matter:

1. **A block the engine cannot carry** (a raw `<div>`, a `<kbd>`) is held in the document as its own text.
   On 3.20 that text serialized back byte-for-byte, so an edit wrote the markup back unchanged. On 3.32 the
   same edit writes `&lt;div …&gt;`. That is the one real regression, and §5 removes it: those blocks must be
   written from their node's `textContent`, never through the markdown serializer. (The *parse* side is
   unchanged — 3.32 still drops the words inside those tags, §1 — so the block is literal on both versions and
   `says()` is what put it there.)
2. **Ordinary text**: a paragraph containing `*`, `[`, `~`, `` ` `` or `\` gains backslashes **when it is
   edited**. The meaning and `says()` are unchanged (the escape parses back to the same character), and
   blocks nobody touches are still written from the file's own bytes — so this is churn in the spelling of
   edited blocks, not loss. Outline's `esc()` and genoffice escape the same characters for the same reason.
   Text inside code (a code block, or a code mark) is left alone by 3.32 as well.
3. Nothing else moved: tables still pad, frontmatter still splits into two nodes (which is why it lives in the
   envelope), the leading blank line before a table is still there.

## 5. Prerequisite: write "not live" blocks from their text

Do this **before** the bump, on 3.20. It is a bug of ours either way: a block the engine could not carry is
carried in the document as its own text, so the only correct write is that text — not the serializer's opinion
of it.

- **Where:** `packages/ui/src/components/editors/markdown-save.ts` — the per-block path fills `current[i]` from
  `blockMarkdown()`; for a row whose `baseline === null`, take the node's `textContent` instead.
- **Why it belongs here:** `blockToNode()` already put the block's bytes in a paragraph; `planSaveFromTable()`
  already writes an edited not-live row. The only thing missing is asking the node rather than the serializer.
- **Acceptance:** in `editors/__tests__/tiptap-roundtrip.test.ts`, editing a raw-HTML block writes the markup
  back **unencoded** (`<div style="color:red">…</div>`, not `&lt;div …&gt;`), on 3.20 today and on 3.32 after
  the bump. The two existing "engine cannot represent" tests then keep passing unchanged on both versions.

## 6. Steps

| # | Step | Acceptance |
| --- | --- | --- |
| 1 | §5: not-live blocks written from `textContent` | `bun test` in `packages/ui` green; the new test fails on the old code, passes on the new |
| 2 | Bump `@tiptap/*` in the **root** `package.json` to `3.32.2` (all 12 declarations; keep `@tiptap/extension-table` pinned exactly, as it is today) | `bun install` finishes; `bun.lock` has **one** `@tiptap/pm` and one `prosemirror-*` set (two of either = two ProseMirror states, and the editor silently misbehaves) |
| 3 | Run the editor tests | the same 133 pass, except the 3 named in §3. The empty-document one is an assertion to update. The other two assert a literal block round-trips byte-for-byte through `getMarkdown()` — on 3.32 it does not, and it should not: rewrite them to assert through the **save** path (`saveBlocks` on an edited literal block writes the markup unencoded, §5), and keep one test that records what `getMarkdown()` does to raw HTML, so the escaping is a documented fact rather than a surprise |
| 4 | Delete what 3.32 provides: `TableAlignment`'s `align` attribute, its `parseMarkdown`/`renderMarkdown` (the whole custom renderer) and `escapeCellPipes`; register `Table/TableHeader/TableCell` from the package again. **Keep `inlineWithBreaks`** (§1: upstream drops the break) and the two helpers the reading face reads alignment through. The empty-block rule can stay or go — measured identical on 3.32 | tables still: alignment parsed and written, `<br>` in a cell, `\|`, an empty block renders as an empty line (`<br><br>`) |
| 5 | Typechecks | `packages/ui`, `packages/shared`, `apps/electron` all clean |
| 6 | Run the **React** layer on 3.32 (not covered by the sandbox): open a `.md` with a table, a callout, a picture beside it, a code fence, a task list, math, and a mermaid fence | everything renders; slash menu and bubble menu still open; the code block still highlights (shiki decoration still fires); images still resolve relative to the document |
| 7 | Real application pass: edit each of those, save, and have the agent edit one block | the file changes only in the edited block; the untouched table keeps its `:--`; the callout keeps its marker; a picture's `src` is still the relative path |
| 8 | Update `extensions/TableAlignment.ts` (what is left of it) and its header note; update the "升级 tiptap" note wherever it survives | no comment claims a version that is no longer installed |

## 7. What stays, regardless of version

- `extensions/CalloutBlockquote.ts` — upstream has no callout node; `> [!NOTE]` is ours (the reading face's
  `remarkCallouts` is the other half).
- `extensions/DocumentImage.ts` — `baseDir` + `previewSrc`; upstream's `Image` has no notion of a picture
  beside the document.
- `block-parse.ts`'s `says()` gate — 3.32 still drops the words inside `<kbd>` and `<div>` (measured), and the
  write side additionally escapes them, so the word-level comparison is what keeps those blocks on the literal
  path.
- `TableAlignment`'s `inlineWithBreaks` — upstream loses a `<br>` inside a cell (measured: `a<br>b` → `ab`).
- The whole block layer (`block-table`, `markdown-save`, `markdown-land`, `text-edits`, the trailing-paragraph
  rule). The upgrade does not touch any of it; it is also where all the tests are.

## 8. Risks and rollback

| Risk | Answer |
| --- | --- |
| Something in the React layer breaks in a way the sandbox cannot see | the bump is `package.json` + `bun.lock` only. **Both files already carry other people's changes in this working tree**, so `git checkout` is not the way back: copy them aside before bumping, and restore by copy + `bun install` |
| Edited paragraphs gain backslashes | accepted (§4.2). Rejected alternative: our own text renderer, which would mean forking the engine's escaping |
| Two ProseMirror copies after install | check the lockfile (§6 step 2); `@tiptap/pm` is not declared in `package.json` today, so consider declaring it explicitly at `3.32.2` |
| The 3 test failures are misread as regressions | §3 says exactly which three, and why two of them are the old escaping |

## 9. Numbers to compare against (as of writing)

| | |
| --- | --- |
| `packages/ui`, all tests | 591 pass, **1 fail** — `chat/mention-icons` → `mentionIconKindFor > maps each reference kind to its own icon` (unrelated to the editor; `design` maps to `file`) |
| `packages/ui/src/components/editors` | 133 pass, 0 fail |
| `packages/ui`, `packages/shared`, `apps/electron` typecheck | clean |
| Installed TipTap today | `3.20.0` (`@tiptap/pm` resolves transitively at `3.20.0`) |
| Latest on npm | `3.32.2` |
