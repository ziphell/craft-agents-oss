/**
 * Build `craft-headless-export` into something the GenOffice command line can spawn.
 *
 * Two files, because one is not enough: the engine runs `<GENOFFICE_APP_BIN> --headless-export …`
 * with `spawn()` and **no shell**, so the binary it names has to be executable by itself. `bun
 * build` drops a shebang line out of the bundle (measured: `--banner:js '#!/usr/bin/env node'`
 * lands nowhere), so the bundle stays a plain module and this writes the two-line launcher that
 * execs it — which is also the only place that decides *which* node runs it.
 *
 * `playwright-core` stays external on purpose: it is a real dependency of this package, resolved
 * from node_modules at runtime, not something to bake a second copy of into the bundle.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const outDir = join(import.meta.dir, '..', 'dist')
await mkdir(outDir, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, '..', 'src', 'cli.ts')],
  target: 'node',
  format: 'esm',
  external: ['playwright-core'],
  outdir: outDir,
  naming: 'cli.mjs',
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const launcher = join(outDir, 'craft-headless-export')
await writeFile(
  launcher,
  ['#!/bin/sh', '# Written by packages/render-host/scripts/build-cli.mjs — do not edit.', 'exec node "$(dirname "$0")/cli.mjs" "$@"', ''].join('\n'),
)
await chmod(launcher, 0o755)

console.log(`built ${join('dist', 'cli.mjs')} and the launcher beside it`)
