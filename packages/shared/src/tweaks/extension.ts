/**
 * A set of tweaks, handed to a browser that does not have this app.
 *
 * The other carrier. A tweak in the app only reaches pages in the app's own browser
 * window; a tweak somebody actually wants on their admin console has to run in the browser
 * they work in, and that is what this builds: a loadable Chrome extension whose content
 * scripts carry exactly the match patterns the tweaks already declare.
 *
 * That is the reason the patterns are Chrome's grammar and not ours (`./match.ts`), the reason
 * when a tweak's JavaScript runs is the browser's own three moments rather than something of
 * ours (`./run-at.ts`), and the reason each entry names a `world`: the two carriers are built
 * from the same files, and a tweak that ran in the app but could not be expressed as a
 * `content_scripts` entry would be a tweak that behaves differently depending on how it was
 * delivered.
 *
 * Nothing here is published to a store: the package is static, self-contained and
 * disposable — load it unpacked, delete it when done. It is readable on purpose, and the
 * README it ships is written for whoever receives it, because being readable is the only
 * credential it has.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { extensionVersion } from '../extension-version.ts'
import { loadWorkspaceTweaks, readTweakSources } from './storage.ts'
import { tweakRunAt, type TweakRunAt } from './run-at.ts'
import type { LoadedTweak } from './types.ts'

/**
 * The manifest `name` every export carries.
 *
 * The export lands in whatever folder the person picks, so there is no folder name of ours to
 * recognise a build by — this is what marks a folder as one of ours, so a re-export refreshes
 * it in place instead of writing into (or over) somebody else's folder.
 */
export const TWEAKS_EXTENSION_NAME = 'Craft tweaks'

/** One file of the built extension, `/`-separated from its root. */
export interface TweaksExtensionFile {
  path: string
  content: string
}

export interface TweaksExtensionBuild {
  files: TweaksExtensionFile[]
  version: string
  /** The slugs that made it in, in the order they were written. */
  included: string[]
  /** Tweaks that were skipped because they have nothing to inject, or are off. */
  skipped: Array<{ slug: string; why: string }>
}

/** Where a tweak's own code lands inside the extension. */
export function tweakExtensionFilePath(slug: string, ext: 'css' | 'js'): string {
  return `tweaks/${slug}.${ext}`
}

/**
 * The content scripts one tweak becomes: its stylesheet before the DOM exists, its
 * javascript at the moment the tweak declares (`./run-at.ts`).
 *
 * Two entries rather than one, because `run_at` governs the **javascript**: a stylesheet
 * injected once the DOM is up is a page that flashes the state the tweak is there to change,
 * so the CSS keeps the earliest moment whatever the tweak says about its JavaScript.
 */
function contentScriptsFor(
  tweak: LoadedTweak,
  sources: { css: string | null; js: string | null },
  runAt: TweakRunAt,
): Record<string, unknown>[] {
  const matches = [...tweak.config.matches]
  const entries: Record<string, unknown>[] = []

  if (sources.css !== null) {
    entries.push({
      matches,
      run_at: 'document_start',
      css: [tweakExtensionFilePath(tweak.config.slug, 'css')],
    })
  }
  if (sources.js !== null) {
    entries.push({
      matches,
      run_at: runAt,
      // The page's own JavaScript world, **not** the platform's default. The app injects a
      // tweak's code into the page itself (its CDP call names no world), so a tweak that gets
      // in front of the page's own scripts and patches a global works there; `ISOLATED` would
      // deliver this same file to a separate context and silently lose that. The cost is the
      // isolation (the page can see this code), which the app's window never had either.
      world: 'MAIN',
      js: [tweakExtensionFilePath(tweak.config.slug, 'js')],
    })
  }

  return entries
}

/**
 * Build the extension for a set of loaded tweaks.
 *
 * Only **enabled** tweaks are built. A tweak nobody switched on must not quietly become a
 * content script in an extension somebody else installs — the app not running it is not
 * the same as it being wanted everywhere.
 */
export function buildTweaksExtension(tweaks: LoadedTweak[], builtAt: Date): TweaksExtensionBuild {
  const files: TweaksExtensionFile[] = []
  const skipped: TweaksExtensionBuild['skipped'] = []
  const contentScripts: Record<string, unknown>[] = []
  const included: string[] = []

  for (const tweak of tweaks) {
    if (!tweak.config.enabled) {
      skipped.push({ slug: tweak.config.slug, why: 'switched off' })
      continue
    }

    const sources = readTweakSources(tweak)
    const entries = contentScriptsFor(tweak, sources, tweakRunAt(sources))
    if (entries.length === 0) {
      skipped.push({ slug: tweak.config.slug, why: 'no tweak.css or tweak.js' })
      continue
    }

    if (sources.css !== null) {
      files.push({ path: tweakExtensionFilePath(tweak.config.slug, 'css'), content: sources.css })
    }
    if (sources.js !== null) {
      files.push({ path: tweakExtensionFilePath(tweak.config.slug, 'js'), content: sources.js })
    }
    contentScripts.push(...entries)
    included.push(tweak.config.slug)
  }

  const version = extensionVersion(builtAt)

  if (included.length === 0) {
    throw new Error(
      'No enabled tweak with code to inject, so there is nothing to build. ' +
        'Write tweak.css or tweak.js in a tweak, and switch that tweak on.',
    )
  }

  files.push({
    path: 'manifest.json',
    content: `${JSON.stringify(buildManifest({ contentScripts, version, builtAt, count: included.length }), null, 2)}\n`,
  })
  files.push({
    path: 'README.md',
    content: buildTweaksReadme({ version, builtAt, tweaks: tweaks.filter((tweak) => included.includes(tweak.config.slug)), skipped }),
  })

  return { files, version, included, skipped }
}

function buildManifest(input: {
  contentScripts: Record<string, unknown>[]
  version: string
  builtAt: Date
  count: number
}): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: TWEAKS_EXTENSION_NAME,
    version: input.version,
    description:
      `${input.count} tweak${input.count === 1 ? '' : 's'} for the pages they name · built ${input.builtAt.toISOString()}`,
    content_scripts: input.contentScripts,
  }
}

/**
 * The note that goes with the extension.
 *
 * Written for whoever receives it: they are being asked to run somebody else's code in
 * pages they are signed in to, so it has to say which pages, what the code does, and how
 * to get rid of it.
 */
function buildTweaksReadme(input: {
  version: string
  builtAt: Date
  tweaks: LoadedTweak[]
  skipped: TweaksExtensionBuild['skipped']
}): string {
  const list = input.tweaks
    .map((tweak) => {
      const sources = readTweakSources(tweak)
      const what = [sources.css === null ? null : 'css', sources.js === null ? null : 'js'].filter(Boolean).join(' + ')
      return `- **${tweak.config.name}** (${what}) — on ${tweak.config.matches.map((m) => `\`${m}\``).join(', ')}`
    })
    .join('\n')

  const skipped =
    input.skipped.length === 0
      ? ''
      : `\nLeft out of this build:\n${input.skipped.map((s) => `- \`${s.slug}\` — ${s.why}`).join('\n')}\n`

  return `# Craft tweaks

These are tweaks: for the pages they name, the CSS and JavaScript in this extension. They
were written in Craft Agents and built here so they can run in your own browser.

## Loading it

1. Open \`chrome://extensions\` (or \`edge://extensions\`).
2. Turn on **Developer mode**.
3. **Load unpacked**, and choose this folder.
4. Reload any page you already had open — an extension reaches a page when that page loads.

Nothing is published to a store and nothing updates itself: the copy you have is the copy
you have. Change a tweak in Craft Agents, export again, and press **Reload** on the
extension's card — then reload the pages you had open, for the same reason as step 4.

## What it changes

${list}

Read \`tweaks/*.css\` and \`tweaks/*.js\` — they are the tweaks themselves, not a build of
them. Being able to read this is how you decide whether to run it.
${skipped}
## Turning it off

Delete the extension from \`chrome://extensions\`, and reload the pages it was running on.
Nothing else on your machine is touched, and no tweak leaves anything behind on the pages
it runs on except what its own CSS and JavaScript do.

Built ${input.builtAt.toISOString()} (version ${input.version}).
`
}

/**
 * The folder an export creates, named after the tweak it was exported from.
 *
 * A folder name has to survive a filesystem, so the characters none of them want are replaced,
 * whitespace is collapsed, and Windows' dislike of a trailing dot or space is respected. Only a
 * name that was nothing but those characters comes out empty, and `tweaks` answers that.
 */
export function tweaksExtensionFolderName(tweakName: string): string {
  const cleaned = tweakName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return cleaned === '' ? 'tweaks' : cleaned
}

export interface TweaksExportRequest {
  workspaceRootPath: string
  /** The folder the extension folder is created inside. */
  destParent: string
  /** The extension folder's own name — the tweak's, never a fixed one of ours. */
  folderName: string
  /** Replace an existing export of the same name. Without it, one is reported instead. */
  overwrite?: boolean
  builtAt?: Date
}

export type TweaksExportResult =
  | { status: 'exported'; dir: string; files: number; tweaks: number; skipped: TweaksExtensionBuild['skipped'] }
  | { status: 'exists'; dir: string }

/**
 * Write the extension into a folder named after the tweak, inside the folder the person picked.
 *
 * The name is the tweak's (`tweaksExtensionFolderName`), so it is never a fixed one of ours and
 * nobody has to invent it; that folder **is** the extension, so `Load unpacked` points straight at
 * it. An existing export of the same name is **asked** about rather than written over — replacing
 * it means deleting somebody's folder, so the person answers and `overwrite` is their yes. A folder
 * that is neither empty nor one of our exports is refused: a build dropped among somebody's
 * documents is an extension nobody can load, and nothing here is ever merged.
 */
export function exportTweaksExtension(request: TweaksExportRequest): TweaksExportResult {
  const tweaks = loadWorkspaceTweaks(request.workspaceRootPath)
  const build = buildTweaksExtension(tweaks, request.builtAt ?? new Date())

  const dest = join(resolve(request.destParent), request.folderName)
  if (existsSync(dest)) {
    if (isExistingExport(dest)) {
      if (!request.overwrite) return { status: 'exists', dir: dest }
      // Their yes: the old build goes wholesale, so a removed tweak's script cannot linger.
      rmSync(dest, { recursive: true, force: true })
    } else if (!isEmptyDir(dest)) {
      throw new Error(`"${dest}" already exists and isn't a tweak export. Choose another folder.`)
    }
  }

  mkdirSync(dest, { recursive: true })
  for (const file of build.files) {
    const target = join(dest, ...file.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content, 'utf-8')
  }

  return { status: 'exported', dir: dest, files: build.files.length, tweaks: build.included.length, skipped: build.skipped }
}

/** True when `dir` holds an export we made — a `manifest.json` whose name is ours. */
function isExistingExport(dir: string): boolean {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { name?: unknown }
    return manifest.name === TWEAKS_EXTENSION_NAME
  } catch {
    return false
  }
}

/** True when `dir` exists and holds nothing. */
function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0
  } catch {
    return false
  }
}
