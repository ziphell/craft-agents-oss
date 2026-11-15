# The office and creations documents, and which one to read

The documents accumulated while GenOffice's four editors and the works library were
integrated. They were written at different times and some are now history rather than description —
so this file says what each one is, newest understanding first.

## Read these first

| Document | What it is |
| --- | --- |
| `requirements/office-embed.md` | **Build steps and the acceptance checklist.** How the editors get into `resources/`, how the sidecar gets installed, what to click to know it works. |
| `office-macos-build.md` | **The run to do on a Mac, step by step**, with what "correct" looks like at each step and what to send back. Written because the macOS-only paths (dmg extraction, the clone branch of the fetch, the two-arch build) had never been executed. |
| `requirements/genoffice-integration.md` | **How it is put together now**: two transport paths (frame / no-host window), the four hosts, the op pipeline and its unit translations, the three `exportPdf` doors, pdfium rasterising, the poster pipeline, the works library, the clipboard, the master view. |
| `research/genoffice-vs-official-client.md` | **What we differ from GenOffice's own client on**, in four buckets: equivalent but moved, worked around, not possible (product difference vs missing part), and dead in their app too. |
| `apps/electron/resources/docs/office-tools.md` | The `office_tool` command surface — what the agent uses on these files. |

## Still useful, older

| Document | Written when | Why it is still here |
| --- | --- | --- |
| `requirements/craft-genoffice-embed.md` | before any code | the original plan; the shape it proposed is what got built |
| `records/genoffice-embed-verification.md` | first end-to-end run | the measurements and the things that broke, with what each cost |
| `research/namiwork-genoffice-analysis.md` | GenOffice's own notes | how *their* product embeds the editors — the reference we were compared against |
| `research/genoffice-html-md-evaluation.md` | before md/html editing was decided | why md is CodeMirror plus preview blocks and not their editor |
| `research/python-tools-vs-genoffice.md` | before the CLI tools were replaced | why `resources/cli-tools` replaced the Python wrappers |
| `research/xlsx-engine-node-analysis.md` | before the workbook sidecar | how the spreadsheet host was chosen |
| `research/drawio-live-edit-analysis.md`, `research/drawio-concurrency-feasibility.md` | the drawio work | how a person and the agent edit one diagram at once |
| `research/anti-bot-analysis.md` | the browser work | what a page does when it thinks it is being driven |

## Conventions

- **`requirements/genoffice-integration.md` wins** where it disagrees with anything older; it is the one kept
  current.
- `scripts/patches/` holds patches against the **GenOffice checkout**, not against this repository.
  There are two and a checkout needs both:
  - `genoffice-docs-host-entry.patch` — the `GENOFFICE_EMBED=1` host entry (`registerDocsScheme` /
    `installDocsProtocol` / `createDocsView`) the docs bundle is built from.
  - `genoffice-editor-control.patch` — the control commands the hosts drive: docs `readMode` and
    `edit` (`expectedText`), sheets `edit` (`expectEmpty` / `expected`) **and `readMode`** (Univer's
    own `viewer` permission plus the class that puts the ribbon away), slides `replaceText`
    (`expectCount`); plus the AI chip following `aiSidebarEnabled`. Each carries the fingerprint that
    refuses a stale write, which is why the hosts can edit a document without guessing.
    One file rather than a patch per command: they all rewrite the same `handleSheetsControl` /
    `handleDocsControl`, and two patches over the same lines cannot be told apart from a conflict
    when a checkout already has them applied.

  After `bun scripts/fetch-genoffice-source.ts`:
  `git -C vendor/genoffice apply ../../scripts/patches/*.patch`. Without them the editors build, but
  they cannot be edited in place.
- Which editor method is answered by whom is not in prose: it is
  `bun scripts/check-office-methods.ts`, which fails `--strict` when a method is neither answered nor
  refused by name.
