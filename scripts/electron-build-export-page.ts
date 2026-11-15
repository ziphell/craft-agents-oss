/**
 * Bundles the pages a hidden window loads.
 *
 * They are browser bundles (MediaBunny, WebCodecs, canvas) — not part of the main process — so
 * they get their own build step: `dist/edit-export-page.js` and `dist/edit-snapshot-page.js`,
 * loaded by the HTML the host writes at run time.
 */
const PAGES = [
  { entrypoint: 'apps/electron/src/main/edit-export-page.ts', naming: 'edit-export-page.js' },
  { entrypoint: 'apps/electron/src/main/edit-snapshot-page.ts', naming: 'edit-snapshot-page.js' },
  { entrypoint: 'apps/electron/src/main/edit-audio-page.ts', naming: 'edit-audio-page.js' },
] as const

for (const page of PAGES) {
  const result = await Bun.build({
    entrypoints: [page.entrypoint],
    outdir: 'apps/electron/dist',
    naming: page.naming,
    target: 'browser',
    format: 'iife',
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  console.log(`${page.naming} built`)
}
