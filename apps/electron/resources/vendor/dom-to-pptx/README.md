# Vendored: dom-to-pptx (browser UMD bundle)

`dom-to-pptx.bundle.js.gz` is the checked-in gzip of the **browser UMD build** of
[`dom-to-pptx`](https://github.com/atharva9167j/dom-to-pptx) (**MIT**), pinned at
the version below. It is the engine behind **editable** PPTX export: it walks a
rendered slide's live DOM and emits native PowerPoint shapes/text/images (not a
flat screenshot) through its bundled PptxGenJS.

- **Version:** 2.1.2
- **Source file:** `dist/dom-to-pptx.bundle.js` from the npm package
  (`npm pack dom-to-pptx@2.1.2`)
- **sha256 (of the uncompressed bundle):**
  `df8fca27232864a4ad01d7ad8a5be1e867ab26b9562a3e5e66c8429b644256d4`
- **Global:** exposes `window.domToPptx.exportToPptx(elementOrSelector, options)`
- **License:** see `LICENSE` in this folder.

## Why vendor the compressed browser bundle instead of `npm install dom-to-pptx`?

The npm package declares `puppeteer` + `@puppeteer/browsers` as dependencies
(used only by its Node/CLI `./node` entry). We never use that path — we inject
this self-contained browser bundle into our **existing** Electron render window
(`apps/electron/src/main/design-exporter.ts`), which is the "no second rendering
engine / no second Chromium" rule from `docs/design-plan.md` §3.4.

Bun blocks lifecycle scripts for untrusted dependencies, so a plain
`bun install dom-to-pptx` would not download a Chromium anyway — but it would
still pull `puppeteer`, `pptxgenjs`, `html2canvas`, `opentype.js`,
`fonteditor-core` and more into `node_modules`, and electron-builder excludes
`node_modules` from the app bundle. Vendoring the single browser bundle keeps the
engine exactly as upstream built it, needs no build-script or `electron-builder`
changes (`resources/` is copied to `dist/resources/` by `scripts/copy-assets.ts`),
and ships one file.

## Updating

Re-copy `dist/dom-to-pptx.bundle.js` from the target npm version, regenerate the
`.gz` (gzip, level 9), update the version + sha256 above, and update
`EXPECTED_SHA256` in
`apps/electron/src/main/__tests__/design-pptx-engine.test.ts` (it guards this
pin). Do not edit the bundle by hand.
