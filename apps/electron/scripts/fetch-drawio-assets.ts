/**
 * Fetch the drawio webapp this app serves at its own origin.
 *
 * drawio is not vendored in git: `src/main/webapp` is ~148 MB of application, images and
 * shape data. A pinned release is fetched here and pruned, and `resources/drawio/` is
 * gitignored — the same shape next-ai-draw-io uses for its Electron bundle, with a prune
 * step theirs does not have (they ship everything except WEB-INF/META-INF).
 *
 *   bun scripts/fetch-drawio-assets.ts [--ref v31.5.2] [--force] [--full-stencils]
 *
 * Three rules keep this honest:
 *
 * - **The keep set is an allow-list.** A directory nobody listed is not downloaded, so a
 *   file that grows to 20 MB cannot silently join the bundle.
 * - **Everything dropped is a claim about what an offline embed requests, and the claim has
 *   to be checkable.** Each exclusion below was checked against the bundle's own source
 *   rather than reasoned about, and says what was found.
 * - **What is requested on demand is still off by default, and the report says so.**
 *   `stencils/` is 41 MB of raw shape data, asked for only when a diagram uses a set outside
 *   the 204 that `js/stencils.min.js` registers — cutting it does not fail loudly, it draws
 *   those shapes as plain boxes. So it is not shipped by default, and every run that leaves
 *   it out says what that costs and how to get it back (`--full-stencils`).
 *
 * The printed size report is the point of the run: it says what the bundle costs and what
 * each exclusion saved, so the list above can be argued with.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULT_REF = 'v31.5.2'
const WEBAPP_PREFIX = 'src/main/webapp/'
const OUT_DIR = join(import.meta.dir, '..', 'resources', 'drawio')
const STAMP_FILE = join(OUT_DIR, '.drawio-assets.json')

/**
 * Ship the raw shape library too. Off by default: it is 41 MB, and the 204 sets inside
 * `js/stencils.min.js` cover everything this app's own diagrams use.
 */
const FULL_STENCILS = process.argv.includes('--full-stencils')

/** Root files the editor and viewer documents themselves need. */
const KEEP_ROOT_FILES = new Set(['index.html', 'favicon.ico', 'shortcuts.svg'])

/**
 * Directories that are part of rendering a diagram, kept whole.
 *
 * `stencils/` is here only with `--full-stencils`, and it is the one directory asked for
 * *on demand*: `js/stencils.min.js` registers 204 sets up front, and a set outside those is
 * fetched from this path — `mxStencilRegistry.getStencil()` resolves it as
 * `STENCIL_PATH + '/' + name + '.xml'` — the first time a diagram uses one. A missing set is
 * not an error: the shape is drawn as a plain box, with nothing said. So leaving it out is a
 * real trade, and every run says which side of it the bundle is on.
 */
const KEEP_DIRS = [
  'js/',
  'styles/',
  'images/',
  'img/',
  'shapes/',
  'resources/',
  'math4/',
  'mxgraph/',
  ...(FULL_STENCILS ? ['stencils/'] : []),
]

/** Never useful on disk: source maps and the PWA service worker. */
const DROP_ANYWHERE = [/\.map$/, /^service-worker\.js$/, /^workbox-/]

/**
 * Dropped from `js/`, each checked against **both** bundles for the one thing that matters:
 * whether anything loads it unconditionally. `app.min.js` has exactly one startup load —
 * `App.loadScripts(["js/shapes-14-6-5.min.js", "js/stencils.min.js", "js/extensions.min.js"], …)`
 * — and the keep list answers to that call, not to how often a name appears. Everything below
 * is absent from it and absent from the viewer: `integrate.min.js` (23 MB, the cloud-drive
 * integrations) is named nowhere in either; `orgchart.min.js` only inside the org-chart
 * wizard's own `mxscript` chain; `export.js` and `embed.dev.js` nowhere at all.
 *
 * `extensions.min.js` (3.9 MB) is deliberately *not* here. It was, once: dropped on the
 * strength of the viewer's importers alone — and the editor lost its startup to a 404,
 * because the viewer never asks for it and the editor always does. Read the startup load
 * before cutting anything out of `js/`.
 */
const DROP_JS = new Set(['integrate.min.js', 'orgchart.min.js', 'export.js', 'embed.dev.js'])

/** Root documents that belong to cloud sign-in and the export tool, not the embed. */
const DROP_ROOT_FILES = new Set([
  'clear.html',
  'teams.html',
  'onedrive3.html',
  'open.html',
  'export3.html',
  'gitlab.html',
  'dropbox.html',
  'github.html',
  'vsdxImporter.html',
  'export-fonts.css',
  'monday-app-association.json',
])

/**
 * Bump when `KEEP_DIRS` / `DROP_DIRS` / `DROP_JS` / `DROP_ANYWHERE` change.
 *
 * The stamp carries it so that editing the rules is not a no-op: without a version, a bundle
 * fetched under the old rules looks "already there" and keeps whatever the old rules left
 * out — which is how a restored file stays missing while the report says the bundle is fine.
 */
const PRUNE_RULES_VERSION = 2

/**
 * Dropped whole directories, with what was checked before each was dropped. Printed on
 * every run so the claimed saving and the claim can be read together.
 */
const DROP_DIRS: ReadonlyArray<{ dir: string; why: string }> = [
  ...(FULL_STENCILS
    ? []
    : [
        {
          dir: 'stencils/',
          why: 'off by default — sets outside the 204 bundled ones draw as plain boxes (--full-stencils ships them)',
        },
      ]),
  { dir: 'WEB-INF/', why: 'server-side descriptors; a static host has no servlet container' },
  { dir: 'META-INF/', why: 'server-side descriptors' },
  { dir: 'connect/', why: 'browser-extension bridge' },
  { dir: 'plugins/', why: 'plugin runtime for the hosted product' },
  {
    dir: 'templates/',
    why: 'the template browser — "templates/" occurs once in app.min.js, in an admin placeholder string',
  },
]

interface TreeEntry {
  path: string
  type: string
  size?: number
}

/** Everything under `src/main/webapp/` at `ref`, relative to that directory. */
async function listWebapp(ref: string): Promise<TreeEntry[]> {
  const token = process.env.GITHUB_TOKEN
  const url = `https://api.github.com/repos/jgraph/drawio/git/trees/${ref}?recursive=1`
  const response = await fetch(url, {
    headers: {
      'user-agent': 'craft-agent-fetch-drawio-assets',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) {
    throw new Error(
      `Listing ${ref} failed: ${response.status} ${response.statusText}` +
        (response.status === 403 ? ' (set GITHUB_TOKEN to lift the anonymous rate limit)' : ''),
    )
  }

  const body = (await response.json()) as { truncated?: boolean; tree: TreeEntry[] }
  // A truncated listing would silently drop files we meant to keep, which would look
  // like a drawio bug much later than here.
  if (body.truncated) throw new Error(`The tree listing for ${ref} was truncated; nothing was written.`)

  return body.tree
    .filter((entry) => entry.type === 'blob' && entry.path.startsWith(WEBAPP_PREFIX))
    .map((entry) => ({ ...entry, path: entry.path.slice(WEBAPP_PREFIX.length) }))
}

function droppedDir(relativePath: string): { dir: string; why: string } | undefined {
  return DROP_DIRS.find((entry) => relativePath.startsWith(entry.dir))
}

/** Should a webapp-relative path be downloaded? */
function keep(relativePath: string): boolean {
  if (droppedDir(relativePath)) return false
  if (DROP_ANYWHERE.some((pattern) => pattern.test(relativePath))) return false

  if (relativePath.includes('/')) {
    const top = relativePath.slice(0, relativePath.indexOf('/') + 1)
    if (!KEEP_DIRS.includes(top)) return false
    return !(top === 'js/' && DROP_JS.has(relativePath.slice(top.length)))
  }

  return KEEP_ROOT_FILES.has(relativePath) && !DROP_ROOT_FILES.has(relativePath)
}

/** Download one file, creating its directory. Errors name the file, not the batch. */
async function download(ref: string, relativePath: string): Promise<number> {
  const url = `https://raw.githubusercontent.com/jgraph/drawio/${ref}/${WEBAPP_PREFIX}${relativePath}`
  const response = await fetch(url, { headers: { 'user-agent': 'craft-agent-fetch-drawio-assets' } })
  if (!response.ok) throw new Error(`${relativePath}: ${response.status} ${response.statusText}`)

  const bytes = Buffer.from(await response.arrayBuffer())
  const target = join(OUT_DIR, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return bytes.byteLength
}

/** Run `worker` over `items` with a bounded number in flight. */
async function pooled<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      if (item !== undefined) await worker(item)
    }
  })
  await Promise.all(runners)
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** What is actually on disk under `dir`, excluding the stamp this script writes. */
function measure(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name === '.drawio-assets.json') continue
    files += 1
    bytes += statSync(join(entry.parentPath ?? dir, entry.name)).size
  }
  return { files, bytes }
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const ref = argValue('--ref') ?? DEFAULT_REF
  const force = process.argv.includes('--force')

  if (!force && existsSync(STAMP_FILE)) {
    // The stamp carries the variant and the rules version as well as the ref: a bundle
    // fetched with the full shape library, or under an older set of exclusions, is not the
    // bundle this run wants — skipping on the ref alone would leave one in place while
    // reporting the other.
    const stamp = JSON.parse(readFileSync(STAMP_FILE, 'utf-8')) as {
      ref?: string
      fullStencils?: boolean
      pruneRules?: number
    }
    if (
      stamp.ref === ref &&
      stamp.fullStencils === FULL_STENCILS &&
      stamp.pruneRules === PRUNE_RULES_VERSION
    ) {
      console.log(`✓ resources/drawio is already at ${ref} (pass --force to refetch)`)
      return
    }
  }

  console.log(`Fetching drawio ${ref} → resources/drawio …`)
  const entries = await listWebapp(ref)

  const kept = entries.filter((entry) => keep(entry.path))
  const dropped = entries.filter((entry) => !keep(entry.path))
  const keptBytes = kept.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
  const droppedBytes = dropped.reduce((sum, entry) => sum + (entry.size ?? 0), 0)

  if (force) rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  let done = 0
  await pooled(kept, 8, async (entry) => {
    await download(ref, entry.path)
    done += 1
    if (done % 50 === 0) console.log(`  … ${done}/${kept.length}`)
  })

  // Measured from disk rather than accumulated while downloading: the number this
  // reports is what the bundle costs, and only the directory can answer that.
  const { files, bytes: written } = measure(OUT_DIR)

  // Group what we dropped so each exclusion's saving is visible on its own line.
  const savedByDir = new Map<string, { bytes: number; why: string }>()
  for (const entry of dropped) {
    const reason = droppedDir(entry.path)
    if (!reason) continue
    const current = savedByDir.get(reason.dir) ?? { bytes: 0, why: reason.why }
    current.bytes += entry.size ?? 0
    savedByDir.set(reason.dir, current)
  }

  writeFileSync(
    STAMP_FILE,
    JSON.stringify(
      {
        ref,
        fullStencils: FULL_STENCILS,
        pruneRules: PRUNE_RULES_VERSION,
        files,
        bytes: written,
        fetchedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  )

  console.log(`\n✓ ${files} files, ${mb(written)}`)
  console.log(
    `  upstream ${mb(keptBytes + droppedBytes)}, dropped ${mb(droppedBytes)} (${kept.length}/${entries.length} files kept)`,
  )
  console.log('\n  dropped by directory:')
  for (const [dir, reason] of [...savedByDir].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`    ${dir.padEnd(12)} ${mb(reason.bytes).padStart(9)}  ${reason.why}`)
  }
  // The trade the bundle landed on, said out loud rather than left to be discovered when a
  // diagram renders wrong. This is the one exclusion whose cost is invisible at runtime.
  if (FULL_STENCILS) {
    console.log('\n  the whole shape library is included: every diagram draws as authored.')
  } else {
    console.log('\n  stencils/ is NOT included. A diagram using a shape set outside the 204 that')
    console.log('  js/stencils.min.js registers draws those shapes as plain boxes, with nothing')
    console.log('  said about it. Re-run with --full-stencils to ship the whole library.')
  }

  console.log('\n  every other exclusion was checked against the bundle source, not guessed.')
  console.log('  that drawio runs at all is the one thing this report cannot tell you.')
}

await main()
