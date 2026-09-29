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

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { extensionVersion } from '../extension-version.ts'
import { loadWorkspaceTweaks, readTweakSources } from './storage.ts'
import { tweakRunAt, type TweakRunAt } from './run-at.ts'
import type { LoadedTweak } from './types.ts'

/** The folder an export lands in, inside whichever folder the person picked. */
export const TWEAKS_EXTENSION_DIRNAME = 'craft-tweaks'

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
    name: 'Craft tweaks',
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

export interface TweaksExportResult {
  dir: string
  files: number
  tweaks: number
  skipped: TweaksExtensionBuild['skipped']
}

/**
 * Write the extension into the folder the person picked.
 *
 * Landing in its own folder, like a website export, because the destination is usually a
 * place with other things in it — and refusing an existing one rather than merging, since
 * a half-overwritten extension is a build nobody has.
 */
export function exportTweaksExtension(
  workspaceRootPath: string,
  destParent: string,
  builtAt: Date = new Date(),
): TweaksExportResult {
  const tweaks = loadWorkspaceTweaks(workspaceRootPath)
  const build = buildTweaksExtension(tweaks, builtAt)

  const dest = join(resolve(destParent), TWEAKS_EXTENSION_DIRNAME)
  if (existsSync(dest)) {
    throw new Error(`"${dest}" already exists. Choose another folder, or remove it first.`)
  }

  for (const file of build.files) {
    const target = join(dest, ...file.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content, 'utf-8')
  }

  return { dir: dest, files: build.files.length, tweaks: build.included.length, skipped: build.skipped }
}
