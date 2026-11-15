#!/usr/bin/env bun
/**
 * Did the editor's change actually reach the artifact the app loads?
 *
 * The app opens `apps/electron/dist/renderer/index.html` — a *built* bundle — while every change is
 * made in `packages/ui` source and checked on the dev server. Those are two different artifacts, and
 * that gap is where "it works on my screen" came from: a fix verified in the dev playground and
 * never rebuilt is a fix the person never saw.
 *
 * This asserts the other half of the story, mechanically: run it after
 * `bun run electron:build:renderer`, and it looks for one marker per behaviour inside the built
 * bundle. A missing marker means either the change did not land, or the build predates it.
 *
 * It cannot say whether the behaviour is *correct* — only that the code implementing it is in the
 * file the app will load. The behavioural half is `scripts/md-editor-selfcheck.js`, run through the
 * browser against the dev server.
 *
 *   bun scripts/md-editor-buildcheck.ts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RENDERER = 'apps/electron/dist/renderer'

interface Marker {
  /** What behaviour this is the fingerprint of. */
  what: string
  /** Which file it must appear in. */
  where: 'js' | 'css'
  /** Text the bundle must contain. */
  needle: string
}

const MARKERS: Marker[] = [
  { what: 'list bullets are drawn as a glyph', where: 'js', needle: 'cm-md-bullet' },
  { what: 'a drawn block has a "source" chip', where: 'js', needle: 'cm-drawn-block-edit' },
  { what: 'a drawn block is laid out as a document (no `pre` leak)', where: 'js', needle: 'whiteSpace:"normal"' },
  { what: 'callouts are drawn', where: 'js', needle: 'cm-md-callout' },
  { what: 'a read-only office preview says the file changed', where: 'js', needle: 'preview.fileChanged' },
  { what: 'Enter in an empty list item takes its indentation', where: 'js', needle: '\\d+[.)]' },
  { what: 'the code face is bundled, not fetched', where: 'css', needle: 'jetbrains-mono' },
  { what: 'CJK faces are named in the mono stack', where: 'css', needle: 'Sarasa Mono SC' },
]

function assets(): string[] {
  const dir = join(RENDERER, 'assets')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
}

function readAll(kind: 'js' | 'css'): string {
  return assets()
    .filter((name) => name.endsWith(`.${kind}`))
    .map((name) => {
      try {
        return readFileSync(join(RENDERER, 'assets', name), 'utf8')
      } catch {
        return ''
      }
    })
    .join('\n')
}

/** The page the window loads, and the bundle it names — a build that wrote neither is no build. */
function checkEntryPage(): string[] {
  const problems: string[] = []
  const page = join(RENDERER, 'index.html')
  if (!existsSync(page)) return [`${page} does not exist — run bun run electron:build:renderer`]

  const html = readFileSync(page, 'utf8')
  const named = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((match) => match[1])
  if (named.length === 0) problems.push('index.html names no built asset')
  for (const asset of named) {
    if (!existsSync(join(RENDERER, asset))) problems.push(`index.html names ${asset}, which is not on disk`)
  }
  return problems
}

const problems = checkEntryPage()
const bundles = { js: readAll('js'), css: readAll('css') }

console.log(`\nmd editor — built artifact check (${RENDERER})\n`)
if (!assets().some((name) => name.endsWith('.js'))) {
  problems.push('no built js at all — run bun run electron:build:renderer')
}

for (const marker of MARKERS) {
  const found = bundles[marker.where].includes(marker.needle)
  console.log(`  ${found ? 'PASS' : 'FAIL'}  ${marker.what}`)
  if (!found) problems.push(`${marker.what} — "${marker.needle}" not found in built ${marker.where}`)
}

const woff2 = assets().some((name) => /jetbrains-mono-.*\.woff2$/.test(name))
console.log(`  ${woff2 ? 'PASS' : 'FAIL'}  the JetBrains Mono files are in the build`)
if (!woff2) problems.push('no jetbrains-mono-*.woff2 in dist/renderer/assets')

if (problems.length > 0) {
  console.log('\nProblems:')
  for (const problem of problems) console.log(`  - ${problem}`)
  process.exit(1)
}

console.log('\nAll markers present.\n')
