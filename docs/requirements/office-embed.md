# Office documents in the app: the frame, the hosts, and what is verified

> **Read this for the build steps and the acceptance checklist; read `genoffice-integration.md`
> (the next file in this directory) for how the thing is put together now.** What this
> document says about *capability* is older than the wiring: every method the editors call is now
> answered or refused by name, `bun scripts/check-office-methods.ts` is the list that says which is
> which, and the export/print route, the poster pipeline, the clipboard and the master view did not
> exist when this was written.

Four document formats — Word (`.docx`), Excel (`.xlsx`), PowerPoint (`.pptx`) and PDF — open inside
the app, are edited there, and are saved back to the same file. The editors are the **GenOffice**
bundles (Apache-2.0), served from this app's own origin and driven through a stand-in for the preload
they expect.

Read this before changing anything in `packages/shared/src/office`, `apps/electron/src/main/office-*`
or `packages/server-core/src/{handlers/rpc,webui}/office.ts`.

## 1. The shape, in one picture

```
 conversation / overlay / (future) window
        │
   OfficeFrame (packages/ui)                ← an <iframe>, nothing native
        │  iframe src = <office origin>/<app>/?…
        │
   shim (packages/shared/src/office/shim.ts) ← injected into the editor's HTML by the host
        │  defines window.desktop / slidesApi / desktopApi / pdfApi
        │  postMessage protocol `craft-office/1`
        ▼
   OfficeFrame answers the bridge          ← open / save / selection / per-app doors
        │  platform actions → RPC
        ▼
   office:getOrigin · office:deck · office:workbook · office:pdf · office:exportPdf…
        │
   apps/electron/src/main/office-{host,deck,workbook,pdf,export}.ts
        │
   resources/office-engine/{pptx,xlsx,pdf,html2docx}.cjs   ← built from a pinned GenOffice checkout
```

Two hosts serve the editor HTML: **Electron** at `craft-local://office-<hash>/<app>/`
(`office-host.ts`) and the **hub** at `/office/<app>/` (`server-core/src/webui/office.ts`). Both inject
the same shim and both stand behind the same session or cookie.

## 2. Why a frame, and why it is not a page like any other

The editor bundle is a **complete document**: its own `<html>`, its own global CSS, its own
`window.desktop`. Mounting it inside the app's React tree would mean two stylesheets, one CSP and one
keyboard model arguing with each other. A frame keeps the document's own DOM and gives the host exactly
one boundary — the messages.

What the frame is *not* is a sandbox. It is served from the app's own origin, runs with the app's
privileges and is expected to reach the host (`drawio`'s editor makes the same trade). Never put
`html-preview` or a design in this mechanism: those are third-party documents and belong in
`sandbox="allow-scripts"` with an opaque origin.

## 3. Build from scratch

```bash
# 1. the editors and the command line (renderers + CLI; needs a GenOffice checkout)
bun scripts/build-office-assets.ts          # → resources/office/{docs,sheets,slides,pdf}, resources/cli

# 2. the engines (source-level; the checkout is fetched, not committed)
bun scripts/fetch-genoffice-source.ts       # → vendor/genoffice at the pinned commit
bun scripts/build-office-engine.ts          # → resources/office-engine/{pptx,xlsx,pdf,html2docx}.cjs

# 3. the xlsx sidecar — prebuilt first, and prebuilt is the cheap path
#    Every GenOffice release carries one (Linux AppImage/deb/rpm, both .dmg, both .exe). Extract the
#    installer for this platform, then take it from there; no Rust, no compile:
bun scripts/build-office-native.ts --from <extracted installer or app snapshot>

# 3b. or compile it from the vendored crate (needs cargo)
bun scripts/build-office-native.ts
```

The hub carries the same four trees: `scripts/build-server.ts` (`--assets-only` stages just these,
so a build host can check before spending the download and bundle steps) and `Dockerfile.server`
both copy `office/`, `office-engine/`, `cli/` and the target platform's `office-native/xlsx-sidecar`.
`.dockerignore` makes an exception for the two `node_modules` trees inside them — they are build
artifacts, and nothing in `bun install` provides jszip, pdf-lib or jsdom.

`build-office-assets.ts` can point at an existing checkout with `GENOFFICE_SOURCE=…` (otherwise it
expects `vendor/genoffice`, then a sibling `../genoffice`).

Nothing in `resources/office`, `resources/office-engine`, `resources/office-native`, `resources/cli`
or `vendor/genoffice` is committed — every one is a build/source artifact and is gitignored. Sizes on a
developer machine, for reference: office 80 MB, office-engine 40 MB, office-native 8.4 MB, cli 41 MB.

**Am I ready?** One command answers it, and says which step fixes each gap:

```bash
bun scripts/build-office-assets.ts --check
# ✓ editors/docs 26.5 MB   ✓ cli/genoffice.cjs 14.6 MB   ✗ native/xlsx-sidecar  missing — .xlsx cannot open without it
# Missing pieces — run the fix for each:
#   bun scripts/build-office-native.ts --from <extracted GenOffice installer>
```

It checks **contents**, not just presence: `cli/package.json` must be named `genoffice` (§6.11),
`pdfium.wasm` and `jszip` must be beside the bundles (§6.9), and each missing engine names the
failure it causes. Exit code is non-zero when anything is missing, so it belongs at the top of any
script that runs these tests.

## 3a. Developing

| Change | What picks it up |
| --- | --- |
| `OfficeFrame`, the block, the overlay (`packages/ui`) | renderer HMR — the frame reloads on save |
| the shim or `document.ts` (`packages/shared/src/office`) | **main process restart** — both are compiled into main and served from there |
| a host module (`office-*.ts`, `headless-export.ts`) | main process restart |
| `resources/office/**` (an editor rebuilt upstream) | nothing running: reload the frame (the document is served `no-store`) |
| `resources/office-engine/*.cjs` | main restart; the bundle is `require`d once and cached |

Two things development **cannot** test, and both have cost a debugging session:

- **`GENOFFICE_APP_BIN` is not set in dev.** `process.execPath` there is a bare Electron with no app
  path, so `office-commands.ts` only points the CLI at this app in a packaged build
  (`process.defaultApp` guards it). Conversions that need a renderer — `docx → html`, `→ pdf` —
  therefore work from the app's own buttons, but **not** through `office_tool` in a dev session.
- **`craft-local://` exists only in the app.** A hidden window that loads `craft-local://office-…`
  gets `ERR_FAILED (-2)` in a bare Electron harness, because the privileged scheme and the local-origin
  router are registered at app start. Any export/convert path that opens a hidden window has to be
  tested in the running app (that is why §8 lists it as unverified).

A stale engine bundle is the most common self-inflicted wound: it compiles, the app runs, and the
feature silently behaves like the previous build. When a document misbehaves after a pull, run
`bun scripts/build-office-engine.ts` before believing anything.

**Upgrading GenOffice** is: bump the pin in `fetch-genoffice-source.ts`, re-run the three commands,
then walk §7. The engine bundles exist precisely so that this is a build, not a merge.

## 3b. The hub runs the same hosts

`packages/office-host` exists because **the hosts are plain Node**, and a hub needs them too:

```
$ bun <repo>/probe.ts          # electron present: undefined
{ "deck": { "slides": 5 }, "deckTxn": "applied",
  "workbook": { "sheets": ["Page 1"] },          # sidecar, spawned from bun
  "pdf": { "username": "" } }
```

Two things are injected rather than imported, and they are the whole difference between the two
hosts:

- **`setOfficeRuntime`** — which binary runs `resources/cli/genoffice.cjs`. The app passes itself
  with `ELECTRON_RUN_AS_NODE=1`; a hub passes Node (`node` from PATH — the standalone package ships
  one at `vendor/node`; `CRAFT_OFFICE_RUNTIME` overrides, for a compiled single binary whose
  `process.execPath` cannot run a script).
- **`setOfficePrint`** — printing to PDF needs a Chromium and the editor as the top document, so it
  exists in the app (`office-export.ts`); a hub answers with the launcher in `resources/render-host`,
  which drives a headless Chromium over Playwright (`page.pdf()`) — spawned, not launched in the
  hub's own process. Unset only where no renderer was staged, and then a deck's Export as PDF says
  *"This host has no renderer to print with"* rather than failing later.

What the hub provides (`packages/server/src/index.ts`, in `createHandlerDeps`): `officeDeck`,
`officeWorkbook`, `officePdf`, `officeDisk` — plus `officeDir` on the web UI handler so `/office/`
is served same-origin behind the session cookie. When the image carries `resources/render-host` it
provides `officeExportPdf` and `officeExportPages` as well, built from that same launcher plus the
pdfium in `office-engine` (`packages/server/src/office-export.ts`).

> Before 2026-11-02 this paragraph said the two export doors were absent and printing was
> desktop-only. The print path had been there since `render-host` landed; what was missing was the
> wiring from that launcher to the two RPCs a UI calls. Where no renderer is staged the two
> dependencies stay absent, and the handler now names the missing piece.

### The editor half on a hub

An editor never fetches its document over HTTP. The frame talks to its **page** over `postMessage`
(`packages/shared/src/office/types.ts`), and the bytes travel in those messages — so `/office/` on a
hub only has to serve code and the shim, which it does.

The four `__craft/office-{file,call,write,done}` routes in `apps/electron/src/main/office-origin.ts`
are for the **headless export window**, which has no page to talk to; a hub needs none of them.

What a hub did need is the two RPC capabilities the server uses to reach an open editor:
`client:office:applyEdit` and `client:document:flush`. The desktop answers them in its preload; a
browser tab has none, and `apps/webui/src/adapter/web-api.ts` answered with no-ops — which was not
harmless. `invokeClientWithTimeout` refuses a capability the client did not advertise, so on a hub
"edit the document that is open" fell back to writing the file and "save what the editor holds,
first" failed with `CAPABILITY_UNAVAILABLE`.

Both are implemented there now. The web UI is the app's own `App.tsx` (`@/App`), so its page already
subscribes with `applyOfficeEdit` / `flushDocument`; the adapter declares the two capabilities in
`clientCapabilities` (the handshake), registers handlers, and relays to that page. A tab with no
editor open answers "no" instead of leaving the tool call waiting 30 s — the same choice the preload
makes when nothing subscribed.

## 4. Files

| Path | What it is |
| --- | --- |
| `packages/shared/src/office/types.ts` | the protocol (`craft-office/1`), the frame message shapes, `officeLanguage` |
| `packages/shared/src/office/shim.ts` | the script that stands in for a preload (109 methods, per-app globals) |
| `packages/shared/src/office/document.ts` | what the host does to the served HTML: drop its meta CSP, inject the shim |
| `packages/office-host/src/deck.ts` | `.pptx`: the document lives here (engine + undo stack) |
| `packages/office-host/src/workbook.ts` | `.xlsx`: sidecar sessions; saves through `sheet apply` |
| `packages/office-host/src/pdf.ts` | `.pdf`: paths, grants, `savePdfToPath`, conversions |
| `packages/office-host/src/guard.ts` | what each open document looked like, and the refusal when a save would overwrite |
| `packages/office-host/src/runtime.ts` | which binary runs the bundled CLI, and whether this host can print |
| `apps/electron/src/main/office-origin.ts` | `craft-local://office-<label>/…` + export/headless tokens |
| `apps/electron/src/main/office-export.ts` | `→ pdf` by printing; `docx → html/md` through the editor |
| `apps/electron/src/main/headless-export.ts` | the `--headless-export` contract the GenOffice CLI spawns |
| `packages/shared/src/office/disk.ts` | the save rule: is the file on disk still the one that was opened |
| `packages/server-core/src/handlers/rpc/office.ts` | the doors, each with `validateFilePath` in front |
| `packages/server-core/src/webui/office.ts` | the hub's `/office/…` route (same-origin, behind the session) |
| `packages/ui/src/components/office/OfficeFrame.tsx` | the iframe + the bridge |
| `packages/ui/src/components/office/OfficePreviewOverlay.tsx` | the same document at window size, editable |
| `packages/ui/src/components/office/useOfficeDocument.ts` | the bytes writer: read before save, the conflict question, reload-as-remount |
| `packages/ui/src/components/markdown/MarkdownOfficeBlock.tsx` | `office-preview`: a document in a message (read-only) |
| `packages/shared/src/agent/office-commands.ts` / `office-tools.ts` | `office_tool` for the agent |
| `resources/docs/office-tools.md` | the agent's own guide to `office_tool` |
| `scripts/{build-office-assets,build-office-engine,fetch-genoffice-source}.ts` | the three build steps |

Also touched: `file-classification.ts` (`'office'` type, `officeAppFor`), `useLinkInterceptor.ts`,
`App.tsx` (`FilePreviewRenderer` + platform actions), `channel-map.ts`, `shared/types.ts`,
`PlatformContext.tsx`, `protocol/channels.ts`, `tool-defs.ts`, `pi-agent.ts`, `session-scoped-tools.ts`,
`http-server.ts`, `packages/server/src/index.ts`, the seven locale files.

## 5. Capabilities, as they stand

| | docx | xlsx | pptx | pdf |
| --- | --- | --- | --- | --- |
| preview in a message | ✅ read-only | ✅ | ✅ | ✅ — the app's own reader |
| edit (overlay) | ✅ | ✅ values/formulas/**formatting**/**sheet ops** | ✅ text/elements | ✅ annotations and form fields |
| save | ✅ | ✅ | ✅ | ✅ |
| undo | renderer's own | renderer's own | ✅ host snapshot stack | renderer's own |
| export → PDF | ✅ | ✅ | ✅ | (already a PDF) |
| convert | → md/html (editor), → pdf | → csv | → pdf | → docx/xlsx/pptx/md (pdfium); html needs an app |
| new files (split / extract / crop / page images) | — | — | — | ✅ beside the document, or a download on a hub |
| print | ✅ the browser's own dialog | ✅ | ✅ | ✅ |
| needs a native binary | — | **xlsx-sidecar** | — | pdfium (wasm); onnxruntime for local OCR |

**A `.pdf` opens in the reader, and the editor is one button away.** Reading is what a click on a
pdf almost always means, and the vendored editor is 9 MB of application; annotating is the rarer,
deliberate act, so `PDFPreviewOverlay` carries an *Annotate* action that opens `OfficePreviewOverlay`
with `app: 'pdf'`. Both surfaces exist; neither is in the other's way.

Known gaps, deliberate:

- **OCR runs locally, one page at a time.** The vendored editor's own pass is automatic on open
  (pages with almost no text layer, 40 per pass, cancellable); `officePdfCall('ocrPage')` answers
  each request by writing the page PNG to a scratch file and running the bundled `img-tool text`,
  then normalizing the boxes into the editor's bottom-left 0–1 space. The models are the ones
  `fetch:ocr-models` stages; without them the host answers `null` (the contract's "no engine") and
  the pass stops instead of rendering every page for nothing. `pdf_tool pdf ocr --page n` is the
  explicit one-page door outside the editor.
- **Signatures / certificates** need the platform (Windows cert store, Keychain). The pdf editor's
  page operations (split / merge / crop / extract / replace / resize), its text-edit validation and
  its signing calls answer `undefined`, which the editor reads as switched off. Forms, annotations
  and saving are the parts that are wired.
- **xlsx structural ops** the DSL cannot express (charts, pivots, validations, tab colours) are refused
  **by name** rather than dropped.
- **docx → html** goes through the docs editor's own headless export; if that path is broken, print to
  PDF instead.

## 5a. One document, two writers: the save guard

An open document is a **snapshot**. The bytes arrive once, the person edits them, and nothing tells
the editor that someone else wrote the file meanwhile. Two writers do that in practice, and the
second one is the product: the **agent** writes documents through `office_tool`, which runs the CLI
the editor knows nothing about. So a save after an agent edit used to replace the agent's work with
no sign that it had happened. That is a correctness bug, not a missing feature.

What happens now, at every save:

| Door | How it is guarded |
| --- | --- |
| docx / pdf (`file:writeBinary`) | `deps.officeDisk.check` before `writeFile`; refused unless `overwrite` |
| pptx (`office:deck` → `save`) | `deckSave` checks before the engine writes |
| xlsx (`office:workbook` → `saveWorkbook`) | checked before the CLI touches the file |
| pdf (`office:pdf` → `save`) | checked on the **target** (a save-as writes a file nobody opened) |

And every read records. `file:readBinary` is the moment a document reaches an editor, so the digest
it stores is the digest that editor's copy corresponds to — there is no window in which "opened" and
"recorded" disagree.

The rule itself is `packages/shared/src/office/disk.ts`, four lines of policy worth knowing:

- **The fast path is one `stat`.** `mtimeMs` + `size` unchanged → save, no read.
- **A hash only settles a disagreement.** Different stamp, same content (a `touch`, a re-save of
  identical bytes) is still a save.
- **Not a conflict:** no record (a file this host never handed out), and a file that is gone (the
  write recreates it).
- **Nothing preserves `mtimeMs` *and* `size` unprejudiced** — an in-place write of the same length
  can slip through. Catching that would mean hashing on every save, which is the cost the fast path
  exists to avoid.

**Produced files go where the host can put them.** Splitting a pdf, extracting pages, cropping, or
exporting page images makes a *new* file, and "new file" is a decision about a filesystem, not about
the format. So the door produces bytes and the host says where they land (`setOfficeDeliver`):

| host | what happens | what the caller gets |
| --- | --- | --- |
| desktop | written **beside the document** with a unique name (`report (1).pdf`), first one revealed | `savedPaths` |
| hub | published to the export scratch and served at `/api/exports/<id>` | `downloads` — the frame turns them into a browser download |

A host with no deliverer refuses in words rather than writing somewhere nobody will look. Several
files (page images) are zipped first on a hub: a browser blocks a burst of downloads.

**Printing is the frame's**, in both hosts: the editor's print stylesheet is in the document, the
document is the frame, so `OfficeFrame` answers `print` with `window.print()` on its own content
window. A hub has no Chromium and a desktop does not need a temp PDF — one path for a window and for
a tab. `printers` answers `[]`, which is the honest list for a host that does not print.

**It is deliberately not a watcher of its own.** Detection while a document is open comes from the
same app-wide project-tree watcher the HTML editor and the diagram pane use
(`useProjectFilesWatch`): the event says *look*, and the caller re-reads its own file and compares.
That is `useOfficeDocument` (`packages/ui/src/components/office/`), the bytes sibling of
`editors/useFileWriter` — same three answers, same chrome:

- `FileSaveStatus` draws the decision over the middle of the surface
  (`preview.fileChangedOnDisk` · `preview.reloadFromDisk` · `preview.keepMyChanges`), and
  `FileSaveStateWord` draws the save in the window header. No new strings, no new component.
- **A change on disk always asks.** A text editor can compare what it holds with what it was given
  and follow silently when nothing is at stake; an office editor's buffer is its own model, and
  "did the person edit?" is not a question the host can answer. So the safe branch is the only one.
- **A refused save is thrown, not swallowed** — the frame keeps its dirty flag, so a save that wrote
  nothing cannot let someone close the window believing the work is on disk.
- `reloadFromDisk` bumps a `reloadToken` that is the frame's React key: an editor cannot be asked to
  discard its model, so reloading means building it again from the bytes on disk.

The person's answer to a refusal is `overwrite: true` on the write — a parameter rather than a
second function, so both halves of the decision stay in one place: `keepMine()` re-writes through
`office-guard.ts`, which still checks the file and is told, by that flag, to write over it.

## 6. The twelve things that bit, and why

Each of these cost a debugging session; they are the reasons the code looks the way it does.

1. **The editor's `<meta>` CSP forbids `blob:`.** A meta policy and a response header are both
   enforced; the vendored one allows `connect-src 'self' … genoffice-docx-media:` and no `blob:`, so
   the document never opened. The host **drops the meta tag** and sends its own header
   (`prepareEditorDocument`).
2. **The shim must run before the module script** — a classic script before a deferred module. Without
   it the editor mounts and throws on the first `window.desktop` it touches.
3. **Every editor looks at a different global.** `desktop` (docs), `slidesApi` (slides), `desktopApi`
   (sheets), `pdfApi` (pdf). Defining only `desktop` is a blank frame for three of four.
4. **Getters must return stable objects.** A fresh `{ open: false }` per call makes React re-render
   forever — the page "loads" and never settles.
5. **The language code is `zh`, not `zh-Hans`.** The editors key their label tables by `Lang`;
   `AI_QUEUE_LABELS['zh-Hans']` is undefined and the AI panel throws while mounting.
6. **`createDocsView(path)` does not open a file in a host** — `openExternalDocx(path)` does.
7. **Printing a host page is a dead end.** An iframe prints as one unpaginated box, chrome included.
   The editor must be the **top document** so its `@media print` hides the ribbon — and its sheet size
   must be passed as `pageSize` (a `preferCSSPageSize` mismatch produced a blank second page and a
   Letter-sized A4 document).
8. **The pdf engine's `import.meta.url` is undefined in a CJS bundle**, so `createRequire(…)` was
   handed `undefined` and pdfium "not found". Fixed with `define` + a `banner` (esbuild defines take
   identifiers, not expressions).
9. **jszip must not be bundled** — it decides its platform by requiring `readable-stream`, and a
   bundled copy says "nodestream is not supported" on the first save. It ships beside the bundle.
10. **`session-state.ts` imports `electron`** for window lookups the render tree never takes; the pptx
    bundle stubs it. Without the stub, the module cannot even be loaded outside Electron.
11. **The CLI resolves its own sidecar/pdfium from a packaged layout.** `XLSX_SIDECAR_PATH` and
    `GENOFFICE_PDFIUM_WASM` must be pointed at the files this app ships, or every workbook/pdf command
    fails while the file sits right there.
12. **`ocrPage` answering `[]` is not "no OCR"** — it means "this page had no text", and the caller
    moves on to render the next page. `null` is "no engine" and stops the pass.

## 7. Real-machine acceptance checklist

Run this on a **packaged or `bun run electron:dev` build**, once per upstream bump. Each line is a
thing that has broken before.

### Opening

- [ ] Clicking a `.docx` in a conversation opens the overlay and renders the real layout (headings,
      page breaks, a table).
- [ ] The same for `.xlsx` (grid, sheet tabs, a formula's value), `.pptx` (slides, thumbnails) and
      `.pdf` (pages, text selection).
- [ ] A `.pdf` opens in the **reader**, and its *Annotate* button opens the editor on the same file —
      which then draws the pages (a blank editor means `readFile` answered something that is not
      bytes) and saves a highlight back to the file.
- [ ] The editor shows **no** ribbon "Genspark AI" group and no AI dock (both are switched off).
- [ ] An `office-preview` block in a message renders the document **read-only**: typing changes the
      view, `Ctrl+S` is refused, the file's mtime does not move.
- [ ] The block's expand button opens the overlay, where editing works.

### Editing and saving

- [ ] `.docx`: change a paragraph, `Ctrl+S`, then unzip — **only** `word/document.xml` differs.
- [ ] `.xlsx`: type a value, a formula (`=SUM(...)`), **bold a cell** and **rename a sheet**; save;
      reopen — all four survived, other parts of the archive unchanged.
- [ ] `.pptx`: change a title, save, reopen — the change is there; `Ctrl+Z` / `Ctrl+Shift+Z` step back
      and forward.
- [ ] `.pdf`: add a highlight or a form value, save, reopen — the change is there and the page count
      did not change.
- [ ] Save on a document opened from a **read-only** location reports a refusal rather than losing the
      edit silently.
- [ ] **Two writers**: open a `.docx` in the overlay, change a paragraph without saving, then have the
      agent edit the same file (`office_tool apply`). Saving from the overlay must **refuse** and name
      the file — not overwrite the agent's work. Repeat for `.xlsx` and `.pptx`.
- [ ] The same test with the file changed by another program (a second editor, `touch` alone does not
      count — it must change the bytes).
- [ ] After the refusal, closing and reopening the document (or "save as") gets you a working save.

### Selection → conversation

- [ ] Select text in a `.docx` overlay: a "send selection to chat" action appears; clicking it puts the
      file path plus a quoted block into the composer.
- [ ] With nothing selected the action is absent (not a dead button).

### Export

- [ ] Overlay → export PDF: one file, the document only (no ribbon, no status bar, no AI dock), A4
      where the document is A4, **no blank trailing page**.
- [ ] A scanned PDF exported to PDF/PNG keeps its page count.
- [ ] `docx → html` and `docx → md` produce files (these go through the docs editor's headless export —
      the one path that needs the app's own `craft-local://` scheme registered, so it only works in a
      real app process, not in a bare Electron harness).

### Conversions (`office_tool` / the pdf editor's button)

- [ ] `md → docx`, `docx → md`, `xlsx → csv`, `pdf → docx|xlsx|pptx|md` all produce files.
- [ ] `pdf → html` refuses **with a sentence**, not with `starting GenOffice … exit 1`.
- [ ] A conversion never overwrites an existing file (it writes `<stem>-converted.<ext>`).

### Agent

- [ ] The agent can call `office_tool help`, `create`, `read --json`, `apply --ops`, `convert`,
      `merge`, `compare`, `pdf`.
- [ ] `read --json` on a **packaged** build answers block indexes for a `.docx` and cells for an
      `.xlsx` — the sidecar is found through `resourcesPath`, not only a checkout's `cwd`
      (`office-commands.ts`, `xlsxSidecarPath`).
- [ ] `apply … --track` leaves the edit as revisions with an author, and `read --revisions` lists it.
- [ ] `render brief.docx --out shots` writes one PNG per page **in a packaged build** (the app answers
      `--headless-export`); `render report.pdf` does it with no app at all.
- [ ] `check` answers for a document, a workbook and a deck, and names each finding.
- [ ] `render` returns the pages **as images** in the reply (the first eight), and every path is named.
- [ ] A staged deck runs start → page → page → build, and `deck_build` refuses while a page is missing.
- [ ] `merge` fills a `{{key}}` template; a `--data` value in a **string** command is refused with
      the quote explanation rather than passed on as mangled JSON.
- [ ] A created document opens in the overlay and looks like its Markdown source.
- [ ] `office_tool` works with **no** environment variables set by hand (pdfium and the sidecar are
      resolved by the tool).

### Web UI / hub

- [ ] On a hub, `/office/docs/` serves the editor behind the session cookie and it renders.
- [ ] The hub's version reports "office editors not installed" in the log when `resources/office` is
      missing, instead of serving an empty frame.

## 8. Untested

Stated plainly, so nobody assumes otherwise:

- **`docx → html/md` has not been run end to end.** It is wired (shim headless mode, host write/done
  endpoints, `exportThroughEditor`), and each piece is exercised elsewhere — but the hidden window
  needs `craft-local://` registered, which only a real app process has.
- **The selection → chat button** was verified at the protocol level (the frame reports the selection,
  the host receives it); the UI affordance has not been clicked.
- **Font metrics in the pptx engine** are shipped and load, but no deck has been compared against the
  same deck opened in PowerPoint.
- **The conflict banner** is wired through the editors' own chrome (`FileSaveStatus`), and the save
  word through `FileSaveStateWord`; neither has been exercised in the running app yet.
- **The hub's `/office/` route** is wired and unit-tested at the serving layer; no browser session has
  been taken through it.
