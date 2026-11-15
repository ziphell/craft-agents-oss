# Office features on macOS: build it once, and tell us what broke

> **What this is.** The office integration (GenOffice editors + engine bundles + workbook sidecar) has
> been built and verified on Windows only. Everything macOS-specific is written but **not run**: the
> `.dmg` extraction path for the sidecar, the `git clone` branch of the source fetch, and the two-arch
> `electron:dist:mac`. This document is the run to do, in order, with what "correct" looks like at
> each step — so a failure is a step number and an error, not "it doesn't work".
>
> **Budget:** ~20 minutes of downloads (GenOffice deps ~1.4 GB, Electron ~200 MB), ~6 minutes of builds.

## 0. What has and has not been verified

| Step | Windows | macOS |
| --- | --- | --- |
| `fetch-genoffice-source.ts --from <checkout>` (copy + patch) | ✅ run | — |
| `fetch-genoffice-source.ts` (git clone at the pin) | ❌ not run | **verify** |
| patches applied to the fresh tree | ✅ run (`readMode`/`expectCount` present) | **verify** (same greps below) |
| `build-office-assets.ts` (copy editors + CLI) | ✅ run | **verify** |
| `build-office-engine.ts` | ✅ run | **verify** |
| sidecar: Windows (`GenOfficeSetup-…-x64.exe` → 7z) | ✅ run, protocol-checked | — |
| sidecar: Linux (`genoffice_…_amd64.deb` → ar) | ✅ run (ELF x64) | — |
| sidecar: macOS (`.dmg`) | ❌ cannot extract on Windows | **verify — step 6** |
| `validate-assets.ts --strict` | ✅ run | **verify** |
| `electron:dist:mac` (arm64 + x64) | n/a | **verify** |
| Runtime: open/edit/save docx, xlsx, pptx, pdf | partial | **verify — step 9** |
| Works-library poster (`nativeImage`, no sharp in the package) | ⚠️ not seen in a packaged build | **verify — step 9** |

## 1. Prerequisites

```bash
node --version      # GenOffice requires >= 22.12.0 (its .nvmrc has the exact pin)
npm --version       # >= 10
bun --version       # the repo builds with bun
git --version
xcode-select -p     # Command Line Tools; electron-builder wants them for signing/notarize
```

Disk: ~6 GB free (GenOffice source + deps + two Electron builds). Network: GitHub releases, npm.

`patch` must be on `PATH` (macOS ships `/usr/bin/patch`) — the patch step prefers it over `git apply`,
because `vendor/` sits inside this repository and `git apply` would resolve *this* repo instead of the
vendored one (see §11).

## 2. The checkout under test

```bash
git clone <this repo> craft-agents-oss && cd craft-agents-oss
bun install
git log --oneline -1
```

**Expect:** `bun install` finishes; no `markitdown-js` in the tree (`grep -c markitdown-js bun.lock` → 0).

## 3. GenOffice source + our patches

```bash
bun scripts/fetch-genoffice-source.ts
```

**Expect** (the important lines):

```
Cloning https://github.com/genspark-ai/genoffice.git at b239d2e5…
✓ /…/vendor/genoffice (b239d2e5)
GenOffice patches (vendor/genoffice):
  ✓ genoffice-docs-host-entry.patch — applied
  ✓ genoffice-editor-control.patch — applied
```

**Verify the patches actually landed** (this is the check that caught a silent no-op on Windows —
`git apply` reported success and changed nothing):

```bash
grep -c "readMode"      vendor/genoffice/apps/docs/src/renderer/control.ts     # expect >= 1  (4 on Windows)
grep -c "expectCount"   vendor/genoffice/apps/slides/src/renderer/control.ts   # expect >= 1  (4)
grep -c "cmd: 'edit'"   vendor/genoffice/apps/sheets/src/renderer/control.ts   # expect >= 1  (1)
```

If any is `0`, stop and report: the patch step lied, and everything downstream would build an editor
that cannot be edited in place.

## 4. Build the editors (GenOffice's own build)

```bash
cd vendor/genoffice
npm install                     # ~1.4 GB of deps; postinstall downloads Electron (~200 MB)
npx electron-vite build -w @genoffice/docs
npx electron-vite build -w @genoffice/pdf
npx electron-vite build -w @genoffice/slides
npx electron-vite build -w @genoffice/sheets    # deliberately NOT `npm run build` — see below
cd ../..
```

Why `npx electron-vite build` for sheets: its `build` script runs `native:build` (cargo) first. We do
not need cargo on macOS — the sidecar comes prebuilt from the `.dmg` in step 6. If you would rather
build it from source, `npm run build -w @genoffice/sheets` works when Rust is installed.

**Expect:** each app produces `apps/<app>/out/renderer/index.html`.

```bash
for a in docs sheets slides pdf; do
  printf "%-8s " "$a"; test -f "vendor/genoffice/apps/$a/out/renderer/index.html" && echo ok || echo MISSING
done
```

## 5. Copy editors + CLI, then the engine bundles

```bash
bun scripts/build-office-assets.ts
```

**Expect** — sizes from the Windows run, macOS should be within a few MB:

```
✓ editors/docs      26.5 MB     ✓ editors/slides  10.1 MB
✓ editors/sheets    33.7 MB     ✓ editors/pdf      7.9 MB
✓ cli/genoffice.cjs 14.6 MB     ✓ cli/node_modules/jsdom present
✓ cli/package.json  name=genoffice
```

`cli/package.json` **must** be named `genoffice` — the CLI resolves its dependencies by walking up to
a package.json with that name.

```bash
bun scripts/build-office-engine.ts
```

**Expect** (`resources/office-engine/`):

```
pptx.cjs 2.3 MB   xlsx.cjs 0.03 MB   pdf.cjs 0.2 MB   html2docx.cjs 1.1 MB
node_modules/@embedpdf/pdfium/dist/pdfium.wasm 4.4 MB
node_modules/jszip present
```

If `fetch-genoffice-source.ts` had failed, this step says `No GenOffice source at …`.

## 6. The macOS workbook sidecar (the one path I could not run)

The binary is `resources/office-native/xlsx-sidecar` (no extension). Take it from the official
installer rather than compiling:

```bash
# Apple Silicon — or GenOffice-0.12.446.dmg for Intel
curl -LO https://github.com/genspark-ai/genoffice/releases/download/v0.12.446/GenOffice-0.12.446-arm64.dmg
hdiutil attach GenOffice-0.12.446-arm64.dmg          # mounts at /Volumes/GenOffice
bun scripts/build-office-native.ts --from /Volumes/GenOffice
hdiutil detach /Volumes/GenOffice
```

`--from` searches the mounted tree for a file named `xlsx-sidecar`; the installer keeps it under
`GenOffice.app/Contents/Resources/native/`.

**Expect:**

```
✓ resources/office-native/xlsx-sidecar (…) from prebuilt
```

**Verify it is really a macOS binary of the right CPU** (the build refuses a wrong one, but check
here so the failure lands on this step):

```bash
file resources/office-native/xlsx-sidecar          # expect: Mach-O 64-bit executable arm64
# Intel: Mach-O 64-bit executable x86_64
bun scripts/build-office-native.ts --check         # expect: in place ✓
```

If `--from` finds nothing, run `find /Volumes/GenOffice -name 'xlsx-sidecar*'` and report the paths —
the installer layout may differ from what the Windows `.exe` and Linux `.deb` had.

## 7. Asset gate

```bash
cd apps/electron && bun scripts/validate-assets.ts --strict && cd ../..
```

**Expect:** every line `✓`, ending `Assets OK.` Anything `✗` is required and names the command that
produces it; `--strict` also fails on a missing **optional** block (the office editors, the sidecar).
Run it here anyway — it takes a second and fails before a ten-minute build — but note it is also built
into packaging: `build-dmg.sh`, `build-win.ps1` and every `electron:dist*` script (through
`electron:validate-strict`) refuse to package without the editors.

## 8. Build and package

```bash
bun run electron:build          # main (minified, ~16 MB) + preload + renderer + resources
bun run electron:dist:mac       # drawio → webui → build → validate-strict → bun per arch → electron-builder ×2
```

`electron:dist:mac` runs `electron:validate-strict` between the build and packaging, so a missing
office editor stops it there instead of shipping a package that cannot open a `.docx`.

**Expect:** `apps/electron/release/Craft-Agents-arm64.dmg` and `-x64.dmg`, plus `.zip`s.

Sanity numbers to compare against (Windows build, same commit):

```bash
ls -l apps/electron/dist/main.cjs        # ~16.2 MB (minified; 46 MB before)
du -sh apps/electron/dist/resources       # ~285 MB
du -sh apps/electron/dist/resources/office  # ~80 MB
```

**Watch for:** `dist/renderer` is cleaned on every build now (`emptyOutDir: true`). If it grows past
~25 MB, that switch regressed and ~100 MB of stale chunks are being packaged again.

## 9. Runtime checks (packaged app, not dev)

Open the built app and verify, in this order — each item is something this round changed:

| # | Do this | Expect | Why it is on the list |
| --- | --- | --- | --- |
| 1 | Open a `.docx`, a `.xlsx`, a `.pptx`, a `.pdf` from the works library | Each opens in its editor, correct file name in the title | editors + engine + CLI all present in the package |
| 2 | Type in the docx, save, reopen | Text persists | save guard + host write path |
| 3 | In the xlsx: use the sheet's **find** and the **row outline** panel | Results appear (a match list; an outline or an empty outline, not an error) | the new official sidecar supports `find_cells` / `read_row_outline`; the previous binary did not |
| 4 | Works library: look at the cards | Cards show **posters** (page images), not just format badges | posters now go through `nativeImage`; the package has no sharp, and the old code silently fell back |
| 5 | Attach a `.docx` and a `.xlsx` to a message | The model receives text (markdown), tables stay tables | `office-to-markdown` replaced `markitdown-js` |
| 6 | Export a docx to PDF from the editor toolbar | A PDF is written | desktop-only path, uses the hidden print window |

Anything that fails: note the item number, the console/`main.log` line, and whether it also fails in
`bun run electron:dev` (that distinguishes packaging from logic).

## 10. What to send back

1. The output of §3 (fetch + patch lines) and the three `grep -c` counts.
2. `file resources/office-native/xlsx-sidecar` output, and whether `--from` found it on the first try.
3. `apps/electron/dist/main.cjs` size and `du -sh apps/electron/dist/resources`.
4. Which of the six runtime checks passed, with the failure text for those that did not.
5. If `electron:dist:mac` failed: the electron-builder error, and whether it was signing, notarizing,
   or file assembly.

## 11. Known failure modes (and what they mean)

| Symptom | Cause | Fix |
| --- | --- | --- |
| `GenOffice patches (…)` prints `Skipped patch` / `0 files changed` / exit 0 | plain `git apply` resolved *this* repo instead of `vendor/genoffice` (it sits inside the worktree, gitignored) | the scripts already prefer GNU `patch`; make sure `/usr/bin/patch` is on `PATH` |
| `the checkout at … has no built editors (apps/docs/out/renderer is missing)` | `build-office-assets.ts` ran before §4 | run the GenOffice builds first |
| `No reader is installed for .doc` at runtime | `.doc`/`.ppt` are pre-2007 binaries — no reader exists, and never did | not a bug; the message is the feature |
| `This host cannot open a workbook (the sidecar is not installed)` | sidecar missing or wrong platform (it is now refused at build time, so this means it slipped through) | redo step 6 |
| `office-native/xlsx-sidecar is elf/x64, but this build targets darwin/arm64. Not staged…` | the Linux binary was left in `resources/office-native/` | step 6 — the macOS one, from the `.dmg` |
| Renderer ~120 MB after a build | `emptyOutDir` regressed in `vite.config.ts` | restore `emptyOutDir: true` |
| `validate-assets.ts --strict` fails on `office/*` | the editors were never copied (§5) | run `build-office-assets.ts` after §4 |
