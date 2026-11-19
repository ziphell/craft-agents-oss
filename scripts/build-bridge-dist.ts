#!/usr/bin/env bun
/**
 * Build the standalone device bridge: one executable, no Bun/Node on the target.
 *
 *   bun run bridge:dist:linux
 *
 * Output: dist/craft-bridge-<version>-linux-x64 + .sha256
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const DIST = join(ROOT, 'dist')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const OUT = join(DIST, `craft-bridge-${VERSION}-linux-x64`)

if (process.platform !== 'linux' || process.arch !== 'x64') {
  console.error(`This build targets linux-x64; the host is ${process.platform}-${process.arch}.`)
  process.exit(1)
}

mkdirSync(DIST, { recursive: true })
rmSync(OUT, { force: true })

console.log(`==> compiling craft-bridge ${VERSION} (linux-x64)`)
const build = Bun.spawn({
  cmd: [
    'env', '-u', 'LD_LIBRARY_PATH',
    'bun', 'build', 'apps/bridge/src/index.ts',
    '--compile',
    '--target=bun-linux-x64',
    '--outfile', OUT,
  ],
  cwd: ROOT,
  stdout: 'inherit',
  stderr: 'inherit',
})
if ((await build.exited) !== 0) {
  console.error('compile failed')
  process.exit(1)
}
chmodSync(OUT, 0o755)

const checksum = Bun.spawnSync({ cmd: ['sha256sum', OUT.split('/').pop()!], cwd: DIST })
if (checksum.exitCode !== 0) {
  console.error('sha256sum failed')
  process.exit(1)
}
writeFileSync(`${OUT}.sha256`, checksum.stdout.toString())

const size = Bun.spawnSync({ cmd: ['du', '-h', OUT] }).stdout.toString().split('\t')[0]
console.log('')
console.log(`✓ ${OUT}`)
console.log(`  ${size}  ·  sha256 ${checksum.stdout.toString().split(' ')[0]}`)
