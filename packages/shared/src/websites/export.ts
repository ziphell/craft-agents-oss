/**
 * Exporting a website: the directory **is** the artifact.
 *
 * A website is a directory served at an address of its own, so handing it to someone
 * else is copying it rather than compiling it — there is no build step and no bundle
 * format to keep in step with one. What the copy leaves behind is the app's own
 * bookkeeping about the site (`website.json`, `thumbnail.jpg`, and the SQLite store under
 * `data/` — the names its origin refuses to serve, one rule in `./host.ts`): they mean
 * nothing without the app, and the store is the site's private working file. What does
 * travel is the site's **published data**, `data/snapshot.json`, because the site's own
 * scripts read their data there (`WEBSITE_DATA_PATH`) and a copy without it would be a
 * site with nothing to show.
 *
 * Two things the copy needs that a file listing cannot say, and so are written beside
 * it: **it has to be served, not opened from disk** (the site's own paths are
 * root-absolute, and `file://` resolves `/assets/app.css` to the filesystem root), and
 * **where it came from**. That is the one file this module authors,
 * {@link EXPORT_README_FILENAME}.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { getWebsitePath, loadWebsiteConfig } from './storage.ts'
import { isWebsiteHostOwned } from './host.ts'

/** The one file written into an export that the website did not contain. */
export const EXPORT_README_FILENAME = 'README.md'

/**
 * Is this path (relative, `/`-separated) part of the website, as opposed to something
 * the app keeps about it?
 *
 * The same answer the site's origin gives a request for it, so a file served in the app
 * is a file in the copy and vice versa — there is no second list of what belongs.
 */
export function isWebsiteExportPath(relativePath: string): boolean {
  return relativePath !== '' && !isWebsiteHostOwned(relativePath)
}

/** Every file of a website, relative and `/`-separated, in a stable order. */
export function listWebsiteExportFiles(websiteDir: string): string[] {
  const found: string[] = []

  const walk = (dir: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // Every directory is walked rather than filtered, because a name the app keeps can
        // still hold the site's own: `data/` is the app's directory and the snapshot inside
        // it is what the site's scripts read. Only the file rule can tell the two apart, so
        // it is asked per file — which is also what makes the copy hold exactly what the
        // origin serves.
        walk(join(dir, entry.name), rel)
        continue
      }
      if (!isWebsiteExportPath(rel)) continue
      found.push(rel)
    }
  }

  walk(websiteDir, '')
  return found.sort()
}

/**
 * The note that goes beside an export.
 *
 * Written for whoever receives the copy, who has no app to explain it: what they are
 * holding, and the one thing that will otherwise look like a broken site.
 */
export function buildWebsiteExportReadme(input: { name: string }): string {
  return `# ${input.name}

This is a website: a plain folder of HTML, CSS and JavaScript files, exported from
Craft Agents.

\`index.html\` is what its address opens. **Serve the folder rather than opening the
file**: the site's own links are root-absolute (\`/assets/app.css\`), and opening
\`index.html\` from disk resolves those against your hard drive instead of the site.
Any static server does:

    python3 -m http.server 8000        # then open http://localhost:8000

An address that has no file behind it — \`/orders\` for a site that switches screens
with the History API — should fall back to \`index.html\`; most static servers and
hosts do this if you tell them it is a single-page app.

The site's data is \`data/snapshot.json\`, as it stood when this copy was made: that is
where its own scripts read it from (\`fetch('/data/snapshot.json')\`). Nothing here
updates it — a static server hands out the file, so the values are the ones exported.

Edit anything here freely: nothing in this copy refers back to the app it came from.
`
}

export interface WebsiteExportResult {
  /** Absolute path of the exported folder. */
  dir: string
  /** How many files were copied. */
  files: number
}

/**
 * Copy a website into `destParent` as its own `<slug>` folder, and return where it
 * landed.
 *
 * A folder rather than loose files, because the destination is usually a place with
 * other things in it. An existing `<slug>` folder is refused rather than merged: a
 * half-overwritten export is the one outcome where neither the old copy nor the new one
 * is what anybody has — pick another destination, or remove it first.
 */
export function exportWebsite(
  workspaceRootPath: string,
  slug: string,
  destParent: string,
): WebsiteExportResult {
  const config = loadWebsiteConfig(workspaceRootPath, slug)
  if (!config) throw new Error(`Website not found: ${slug}`)

  const source = getWebsitePath(workspaceRootPath, slug)
  const files = listWebsiteExportFiles(source)
  if (files.length === 0) {
    throw new Error(`Website "${slug}" has no files to export yet.`)
  }

  const dest = join(resolve(destParent), slug)
  if (existsSync(dest)) {
    throw new Error(`"${dest}" already exists. Choose another folder, or remove it first.`)
  }

  for (const rel of files) {
    const target = join(dest, ...rel.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(source, ...rel.split('/')), target)
  }

  writeFileSync(join(dest, EXPORT_README_FILENAME), buildWebsiteExportReadme({ name: config.name }), 'utf-8')

  return { dir: dest, files: files.length }
}
